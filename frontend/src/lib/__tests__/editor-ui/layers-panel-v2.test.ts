import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import LayersPanelV2, { type LayerPanelLayer } from "$lib/editor-ui/LayersPanelV2.svelte";

function layers(overrides: Partial<LayerPanelLayer>[] = []): LayerPanelLayer[] {
	const base: LayerPanelLayer[] = [
		{
			id: "edit-cleanup",
			name: "แก้ภาพสะอาด",
			kind: "edit",
			kindLabel: "แก้ภาพด้วยแปรง",
			visible: true,
			locked: false,
			opacity: 0.86,
		},
		{
			id: "text-th",
			name: "ข้อความไทย",
			kind: "text",
			visible: true,
			locked: false,
			opacity: 1,
		},
		{
			id: "ref-image",
			name: "รูปอ้างอิง SFX",
			kind: "image",
			visible: false,
			locked: true,
			opacity: 0.42,
			thumbnailUrl: "/thumbs/ref.webp",
		},
		{
			id: "base-page",
			name: "หน้าต้นฉบับ",
			kind: "base",
			visible: true,
			locked: true,
			opacity: 1,
		},
	];

	return base.map((layer, index) => ({ ...layer, ...overrides[index] }));
}

function callbacks() {
	return {
		onSelect: vi.fn(),
		onToggleVisible: vi.fn(),
		onToggleLock: vi.fn(),
		onReorder: vi.fn(),
		onOpacity: vi.fn(),
		onRename: vi.fn(),
		onDelete: vi.fn(),
		onRevert: vi.fn(),
	};
}

function renderPanel(
	overrides: Partial<{
		layers: LayerPanelLayer[];
		selectedIds: string[];
	}> = {},
) {
	const cb = callbacks();
	const result = render(LayersPanelV2, {
		props: {
			layers: overrides.layers ?? layers(),
			selectedIds: overrides.selectedIds ?? [],
			...cb,
		},
	});

	return { ...result, ...cb };
}

describe("LayersPanelV2", () => {
	it("renders a compact 36px layer stack with kind icons, thumbnail, and Thai state copy", () => {
		const { container } = renderPanel({ selectedIds: ["text-th"] });

		expect(screen.getByRole("region", { name: "เลเยอร์" })).toBeTruthy();
		expect(screen.getByRole("list", { name: "ลำดับเลเยอร์" })).toBeTruthy();
		expect(screen.getByText("4 ชั้น")).toBeTruthy();
		expect(screen.getByText("แก้ภาพสะอาด")).toBeTruthy();
		expect(screen.getByText("ข้อความไทย")).toBeTruthy();
		expect(screen.getByText("รูปอ้างอิง SFX")).toBeTruthy();
		expect(screen.getByText("หน้าต้นฉบับ")).toBeTruthy();
		expect(screen.getByText(/แก้ภาพด้วยแปรง/)).toBeTruthy();
		expect(screen.getByText("FX")).toBeTruthy();
		expect(screen.getByText("T")).toBeTruthy();
		expect(container.querySelector('img[src="/thumbs/ref.webp"]')).toBeTruthy();
		expect(container.querySelector('[data-testid="layer-row-text-th"]')?.className).toContain("selected");
	});

	it("delegates normal and shift multi-select with the clicked layer index", async () => {
		const { onSelect } = renderPanel();

		await fireEvent.click(screen.getByRole("button", { name: "เลือกเลเยอร์ ข้อความไทย" }));
		await fireEvent.click(screen.getByRole("button", { name: "เลือกเลเยอร์ รูปอ้างอิง SFX" }), {
			shiftKey: true,
		});

		expect(onSelect).toHaveBeenNthCalledWith(1, "text-th", { multi: false, index: 1 });
		expect(onSelect).toHaveBeenNthCalledWith(2, "ref-image", { multi: true, index: 2 });
	});

	it("delegates visibility and lock actions without selecting the row", async () => {
		const { onSelect, onToggleVisible, onToggleLock, onDelete } = renderPanel();
		const row = screen.getByTestId("layer-row-ref-image");

		await fireEvent.click(within(row).getByRole("button", { name: "แสดง รูปอ้างอิง SFX" }));
		await fireEvent.click(within(row).getByRole("button", { name: "ปลดล็อก รูปอ้างอิง SFX" }));
		await fireEvent.click(within(row).getByRole("button", { name: "ลบ รูปอ้างอิง SFX" }));

		expect(onToggleVisible).toHaveBeenCalledWith("ref-image");
		expect(onToggleLock).toHaveBeenCalledWith("ref-image");
		expect(onDelete).toHaveBeenCalledWith("ref-image");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("reports pointer reorder by source and target indexes", async () => {
		const { onReorder } = renderPanel();
		const source = screen.getByTestId("layer-row-text-th");
		const target = screen.getByTestId("layer-row-ref-image");

		await fireEvent.pointerDown(within(source).getByRole("button", { name: "ลากเรียง ข้อความไทย" }), {
			pointerId: 11,
		});
		await fireEvent.pointerEnter(target, { pointerId: 11 });
		await fireEvent.pointerUp(target, { pointerId: 11 });

		expect(onReorder).toHaveBeenCalledTimes(1);
		expect(onReorder).toHaveBeenCalledWith(1, 2);
	});

	it("ignores same-row drops and unsupported drag attempts", async () => {
		const { onReorder } = renderPanel();
		const textRow = screen.getByTestId("layer-row-text-th");
		const editRow = screen.getByTestId("layer-row-edit-cleanup");
		const baseRow = screen.getByTestId("layer-row-base-page");

		await fireEvent.pointerDown(within(textRow).getByRole("button", { name: "ลากเรียง ข้อความไทย" }), {
			pointerId: 12,
		});
		await fireEvent.pointerUp(textRow, { pointerId: 12 });
		await fireEvent.pointerDown(within(editRow).getByRole("button", { name: "ลากเรียง แก้ภาพสะอาด" }), {
			pointerId: 14,
		});
		await fireEvent.pointerDown(within(baseRow).getByRole("button", { name: "ลากเรียง หน้าต้นฉบับ" }), {
			pointerId: 13,
		});

		expect(onReorder).not.toHaveBeenCalled();
		expect(within(editRow).getByRole("button", { name: "ลากเรียง แก้ภาพสะอาด" })).toHaveProperty("disabled", true);
		expect(within(baseRow).getByRole("button", { name: "ลากเรียง หน้าต้นฉบับ" })).toHaveProperty("disabled", true);
		expect(within(baseRow).getByRole("button", { name: "ซ่อน หน้าต้นฉบับ" })).toHaveProperty("disabled", true);
		expect(within(baseRow).getByRole("button", { name: "ปลดล็อก หน้าต้นฉบับ" })).toHaveProperty("disabled", true);
		expect(within(baseRow).getByRole("button", { name: "ลบ หน้าต้นฉบับ" })).toHaveProperty("disabled", true);
	});

	it("shows opacity only for selected layers and emits normalized opacity values", async () => {
		const { onOpacity } = renderPanel({ selectedIds: ["text-th"] });

		expect(screen.queryByRole("slider", { name: "ความทึบของ แก้ภาพสะอาด" })).toBeNull();
		const slider = screen.getByRole("slider", { name: "ความทึบของ ข้อความไทย" });
		expect(slider).toHaveProperty("value", "100");

		await fireEvent.input(slider, { target: { value: "67" } });

		expect(onOpacity).toHaveBeenCalledWith("text-th", 0.67);
	});

	it("keeps edit rows limited to visibility, revert, delete, and rename-safe actions", async () => {
		const { onToggleVisible, onToggleLock, onOpacity, onRevert, onDelete } = renderPanel({ selectedIds: ["edit-cleanup"] });
		const row = screen.getByTestId("layer-row-edit-cleanup");

		expect(within(row).getByRole("button", { name: "ลากเรียง แก้ภาพสะอาด" })).toHaveProperty("disabled", true);
		expect(within(row).getByRole("button", { name: "ล็อก แก้ภาพสะอาด" })).toHaveProperty("disabled", true);
		expect(within(row).queryByRole("slider", { name: "ความทึบของ แก้ภาพสะอาด" })).toBeNull();

		await fireEvent.click(within(row).getByRole("button", { name: "ซ่อน แก้ภาพสะอาด" }));
		await fireEvent.click(within(row).getByRole("button", { name: "ย้อนกลับไปก่อนการแก้นี้" }));
		await fireEvent.click(within(row).getByRole("button", { name: "ลบ แก้ภาพสะอาด" }));

		expect(onToggleVisible).toHaveBeenCalledWith("edit-cleanup");
		expect(onRevert).toHaveBeenCalledWith("edit-cleanup");
		expect(onDelete).toHaveBeenCalledWith("edit-cleanup");
		expect(onToggleLock).not.toHaveBeenCalled();
		expect(onOpacity).not.toHaveBeenCalled();
	});

	it("keeps a LOCKED layer's opacity read-only (slider disabled, no emit) — codex P2", async () => {
		const { onOpacity } = renderPanel({ selectedIds: ["ref-image"] });

		const slider = screen.getByRole("slider", { name: "ความทึบของ รูปอ้างอิง SFX" });
		expect(slider).toHaveProperty("disabled", true);

		await fireEvent.input(slider, { target: { value: "67" } });

		expect(onOpacity).not.toHaveBeenCalled();
	});

	it("renames on double click, commits non-empty names, and ignores blank names", async () => {
		const { onRename } = renderPanel();
		const layerButton = screen.getByRole("button", { name: "เลือกเลเยอร์ ข้อความไทย" });

		await fireEvent.dblClick(layerButton);
		const input = screen.getByRole("textbox", { name: "เปลี่ยนชื่อเลเยอร์ ข้อความไทย" });
		await fireEvent.input(input, { target: { value: "ข้อความไทยหน้า 3" } });
		await fireEvent.keyDown(input, { key: "Enter" });

		expect(onRename).toHaveBeenCalledWith("text-th", "ข้อความไทยหน้า 3");

		// The rename swap recreates the row button, so re-query instead of using
		// the now-detached reference (renamed layers keep the OLD prop name here
		// because the parent mock doesn't apply onRename).
		await fireEvent.dblClick(screen.getByRole("button", { name: "เลือกเลเยอร์ ข้อความไทย" }));
		await fireEvent.input(screen.getByRole("textbox", { name: "เปลี่ยนชื่อเลเยอร์ ข้อความไทย" }), {
			target: { value: "   " },
		});
		await fireEvent.keyDown(screen.getByRole("textbox", { name: "เปลี่ยนชื่อเลเยอร์ ข้อความไทย" }), {
			key: "Enter",
		});

		expect(onRename).toHaveBeenCalledTimes(1);
	});

	it("renders a quiet empty state for pages with no editable layers", () => {
		renderPanel({ layers: [] });

		expect(screen.getByRole("status").textContent).toContain("ยังไม่มีเลเยอร์ในหน้านี้");
		expect(screen.queryByRole("list", { name: "ลำดับเลเยอร์" })).toBeNull();
	});
});
