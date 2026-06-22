import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ToolOptionsBar from "$lib/editor-ui/ToolOptionsBar.svelte";

const tool = { id: "brush", label: "แปรง" };

describe("editor-ui ToolOptionsBar", () => {
	it("renders a compact active-tool receipt and all option labels", () => {
		const onChange = vi.fn();

		render(ToolOptionsBar, {
			props: {
				tool,
				onChange,
				options: [
					{ kind: "slider", id: "size", label: "ขนาด", value: 24, min: 1, max: 96 },
					{ kind: "toggle", id: "snap", label: "ดูดขอบ", value: true },
					{ kind: "select", id: "mode", label: "โหมด", value: "normal", choices: [{ label: "ปกติ", value: "normal" }, { label: "คูณสี", value: "multiply" }] },
					{ kind: "number", id: "opacity", label: "ทึบ", value: 80, min: 0, max: 100 },
					{ kind: "color", id: "fill", label: "สีเติม", value: "#FFFFFF", recent: ["#112233"] },
				],
			},
		});

		expect(screen.getByLabelText("เครื่องมือที่เลือก").textContent).toContain("แปรง");
		const toolbar = screen.getByRole("toolbar", { name: "ตั้งค่า แปรง" });
		expect(within(toolbar).getByText("ขนาด")).toBeTruthy();
		expect(within(toolbar).getByText("ดูดขอบ")).toBeTruthy();
		expect(within(toolbar).getByText("โหมด")).toBeTruthy();
		expect(within(toolbar).getByText("ทึบ")).toBeTruthy();
		expect(within(toolbar).getByRole("button", { name: "สีเติม #FFFFFF" })).toBeTruthy();
	});

	it("emits numeric changes from both the slider and its paired number input", async () => {
		const onChange = vi.fn();

		render(ToolOptionsBar, {
			props: {
				tool,
				onChange,
				options: [{ kind: "slider", id: "size", label: "ขนาด", value: 24, min: 1, max: 64 }],
			},
		});

		const range = screen.getByLabelText("ขนาด สไลเดอร์") as HTMLInputElement;
		const number = screen.getByLabelText("ขนาด ตัวเลข") as HTMLInputElement;

		expect(range.min).toBe("1");
		expect(range.max).toBe("64");
		expect(number.value).toBe("24");

		await fireEvent.input(range, { target: { value: "48" } });
		await fireEvent.input(number, { target: { value: "52" } });

		expect(onChange).toHaveBeenNthCalledWith(1, "size", 48);
		expect(onChange).toHaveBeenNthCalledWith(2, "size", 52);
	});

	it("clamps number input values to the declared bounds", async () => {
		const onChange = vi.fn();

		render(ToolOptionsBar, {
			props: {
				tool: { id: "text", label: "ข้อความ" },
				onChange,
				options: [{ kind: "number", id: "opacity", label: "ความทึบ", value: 80, min: 0, max: 100 }],
			},
		});

		const input = screen.getByLabelText("ความทึบ") as HTMLInputElement;

		await fireEvent.input(input, { target: { value: "150" } });
		await fireEvent.input(input, { target: { value: "-20" } });

		expect(onChange).toHaveBeenNthCalledWith(1, "opacity", 100);
		expect(onChange).toHaveBeenNthCalledWith(2, "opacity", 0);
	});

	it("ignores invalid numeric input instead of emitting NaN", async () => {
		const onChange = vi.fn();

		render(ToolOptionsBar, {
			props: {
				tool: { id: "text", label: "ข้อความ" },
				onChange,
				options: [{ kind: "number", id: "font-size", label: "ขนาดอักษร", value: 18, min: 8, max: 96 }],
			},
		});

		await fireEvent.input(screen.getByLabelText("ขนาดอักษร"), { target: { value: "" } });

		expect(onChange).not.toHaveBeenCalled();
	});

	it("emits boolean changes from toggle controls", async () => {
		const onChange = vi.fn();

		render(ToolOptionsBar, {
			props: {
				tool: { id: "select", label: "เลือก" },
				onChange,
				options: [{ kind: "toggle", id: "snap", label: "ดูดขอบ", value: false }],
			},
		});

		const toggle = screen.getByLabelText("ดูดขอบ") as HTMLInputElement;

		await fireEvent.click(toggle);

		expect(onChange).toHaveBeenCalledWith("snap", true);
	});

	it("emits string values from select choices and supports object choices", async () => {
		const onChange = vi.fn();

		render(ToolOptionsBar, {
			props: {
				tool: { id: "blend", label: "ผสมสี" },
				onChange,
				options: [
					{
						kind: "select",
						id: "blend-mode",
						label: "โหมดผสม",
						value: "normal",
						choices: [
							{ label: "ปกติ", value: "normal" },
							{ label: "คูณสี", value: "multiply" },
						],
					},
				],
			},
		});

		const select = screen.getByLabelText("โหมดผสม") as HTMLSelectElement;

		await fireEvent.change(select, { target: { value: "multiply" } });

		expect(select.options[1]?.textContent).toBe("คูณสี");
		expect(onChange).toHaveBeenCalledWith("blend-mode", "multiply");
	});

	it("opens ColorPickerPopover for color options and emits picked hex values", async () => {
		const onChange = vi.fn();

		render(ToolOptionsBar, {
			props: {
				tool: { id: "bucket-fill", label: "ถังสี" },
				onChange,
				options: [{ kind: "color", id: "fill", label: "สีเติม", value: "#FFFFFF", recent: ["#112233"] }],
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "สีเติม #FFFFFF" }));
		expect(screen.getByRole("dialog", { name: "ตัวเลือกสีเติม" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("option", { name: "เลือกสี #112233" }));

		expect(onChange).toHaveBeenCalledWith("fill", "#112233");
	});

	it("renders an empty state when the active tool has no options", () => {
		render(ToolOptionsBar, {
			props: {
				tool: { id: "hand", label: "เลื่อนผืนงาน" },
				onChange: vi.fn(),
				options: [],
			},
		});

		expect(screen.getByRole("status").textContent).toContain("ไม่มีตัวเลือกสำหรับเครื่องมือนี้");
		expect(screen.queryByRole("toolbar")).toBeNull();
	});

	it("fails closed for select options without choices", () => {
		const onChange = vi.fn();

		render(ToolOptionsBar, {
			props: {
				tool: { id: "effects", label: "เอฟเฟกต์" },
				onChange,
				options: [{ kind: "select", id: "preset", label: "พรีเซ็ต", value: "", choices: [] }],
			},
		});

		const select = screen.getByLabelText("พรีเซ็ต") as HTMLSelectElement;

		expect(select.disabled).toBe(true);
		expect(select.textContent).toContain("ไม่มีตัวเลือก");
		expect(onChange).not.toHaveBeenCalled();
	});
});
