import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ToolPalette, { type ToolPaletteTool } from "$lib/editor-ui/ToolPalette.svelte";

const iconSelect = "M4 4h16v16H4z";
const iconText = "M5 4h14M12 4v16";
const iconBrush = "M4 20c4-1 7-4 9-9l5-5";
const iconHand = "M7 11V5a2 2 0 0 1 4 0v6";

function tools(): ToolPaletteTool[] {
	return [
		{ id: "select", label: "เลือก", icon: iconSelect, kbd: "V", group: "หลัก" },
		{ id: "pan", label: "เลื่อนหน้า", icon: iconHand, kbd: "H", group: "หลัก" },
		{ id: "text", label: "ข้อความ", icon: iconText, kbd: "T", group: "วางเลเยอร์" },
		{ id: "brush", label: "แปรงคลีน", icon: iconBrush, kbd: "B", group: "แก้ภาพ" },
	];
}

describe("ToolPalette", () => {
	it("renders a vertical Thai-labeled toolbar with grouped separators, icons, tooltips, and active state", () => {
		render(ToolPalette, {
			props: {
				tools: tools(),
				activeId: "text",
				onPick: vi.fn(),
			},
		});

		const toolbar = screen.getByRole("toolbar", { name: "แถบเครื่องมือแก้หน้า" });
		expect(toolbar.getAttribute("aria-orientation")).toBe("vertical");
		expect(toolbar.classList.contains("tool-palette")).toBe(true);
		expect(screen.getAllByRole("separator")).toHaveLength(2);
		expect(screen.getByRole("group", { name: "กลุ่มเครื่องมือ หลัก" })).toBeTruthy();
		expect(screen.getByRole("group", { name: "กลุ่มเครื่องมือ วางเลเยอร์" })).toBeTruthy();

		const select = screen.getByRole("button", { name: "เลือก" });
		expect(select.getAttribute("title")).toBe("เลือก (V)");
		expect(select.getAttribute("aria-keyshortcuts")).toBe("V");
		expect(select.getAttribute("aria-pressed")).toBe("false");
		expect(select.querySelector("path")?.getAttribute("d")).toBe(iconSelect);

		const active = screen.getByRole("button", { name: "ข้อความ" });
		expect(active.getAttribute("title")).toBe("ข้อความ (T)");
		expect(active.getAttribute("aria-pressed")).toBe("true");
		expect(active.classList.contains("active")).toBe(true);
	});

	it("delegates picks for active and inactive tools without owning editor state", async () => {
		const onPick = vi.fn();
		render(ToolPalette, {
			props: {
				tools: tools(),
				activeId: "select",
				onPick,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "แปรงคลีน" }));
		await fireEvent.click(screen.getByRole("button", { name: "เลือก" }));

		expect(onPick).toHaveBeenNthCalledWith(1, "brush");
		expect(onPick).toHaveBeenNthCalledWith(2, "select");
	});

	it("updates pressed state when activeId changes from the parent", async () => {
		const { rerender } = render(ToolPalette, {
			props: {
				tools: tools(),
				activeId: "select",
				onPick: vi.fn(),
			},
		});

		expect(screen.getByRole("button", { name: "เลือก" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "ข้อความ" }).getAttribute("aria-pressed")).toBe("false");

		await rerender({ activeId: "brush" });

		expect(screen.getByRole("button", { name: "เลือก" }).getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByRole("button", { name: "แปรงคลีน" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("keeps no-shortcut and blank-group tools accessible without malformed tooltip copy", () => {
		const onPick = vi.fn();
		render(ToolPalette, {
			props: {
				tools: [
					{ id: "note", label: "โน้ต", icon: iconText, group: "" },
					{ id: "stamp", label: "สแตมป์", icon: iconBrush, kbd: "  ", group: "" },
				],
				activeId: null,
				onPick,
				ariaLabel: "เครื่องมือย่อย",
			},
		});

		expect(screen.getByRole("toolbar", { name: "เครื่องมือย่อย" })).toBeTruthy();
		expect(screen.getByRole("group", { name: "กลุ่มเครื่องมือทั่วไป" })).toBeTruthy();
		expect(screen.queryAllByRole("separator")).toHaveLength(0);

		const note = screen.getByRole("button", { name: "โน้ต" });
		const stamp = screen.getByRole("button", { name: "สแตมป์" });
		expect(note.getAttribute("title")).toBe("โน้ต");
		expect(stamp.getAttribute("title")).toBe("สแตมป์");
		expect(note.hasAttribute("aria-keyshortcuts")).toBe(false);
		expect(stamp.hasAttribute("aria-keyshortcuts")).toBe(false);
		expect(note.getAttribute("aria-pressed")).toBe("false");
		expect(stamp.getAttribute("aria-pressed")).toBe("false");
	});

	it("renders an accessible empty state instead of a dead toolbar", () => {
		render(ToolPalette, {
			props: {
				tools: [],
				activeId: "missing",
				onPick: vi.fn(),
			},
		});

		expect(screen.getByRole("toolbar", { name: "แถบเครื่องมือแก้หน้า" })).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("ไม่มีเครื่องมือในแถบนี้");
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(screen.queryAllByRole("separator")).toHaveLength(0);
	});
});
