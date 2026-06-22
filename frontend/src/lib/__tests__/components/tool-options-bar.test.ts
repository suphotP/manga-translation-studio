import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ToolOptionsBar from "$lib/components/ToolOptionsBar.svelte";
import { MANGA_TEXT_STYLE_PRESETS, textLayerStyleFromMangaPreset } from "$lib/editor-tools/text-styles.js";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";

beforeEach(() => {
	editorStore.currentTool = "select";
	editorStore.activeImageTool = null;
	editorStore.selectedLayer = null;
	editorStore.selectedImageLayer = null;
	editorStore.historyEntries = [];
	editorStore.historyCurrentIndex = -1;
	editorStore.canUndo = false;
	editorStore.canRedo = false;
	editorStore.brushColor = "#FFFFFF";
	editorStore.imageToolFillColor = "#FFFFFF";
	editorStore.recentToolColors = ["#FFFFFF", "#111111"];
	editorStore.editor = {
		imageWidth: 800,
		imageHeight: 600,
		getZoom: () => 1,
		zoomAtViewportCenter: vi.fn(),
		getAllTextLayers: () => [],
	};
	editorUiStore.__resetForTesting();
});

function makeRect({ top, left, width = 120, height = 32 }: { top: number; left: number; width?: number; height?: number }): DOMRect {
	return {
		x: left,
		y: top,
		top,
		left,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

describe("ToolOptionsBar", () => {
	it("renders select options when select tool is active and no layer is selected", () => {
		editorStore.currentTool = "select";
		render(ToolOptionsBar);

		expect(screen.getByRole("button", { name: "ย้อนกลับการทำ" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "+ ข้อความ" })).toBeTruthy();
		// W3.1: the crop ratio picker is relocated to the crop context — the select
		// context no longer owns aspect-ratio selection.
		expect(screen.queryByText("สัดส่วนผืนงาน:")).toBeNull();
		expect(screen.queryByRole("radiogroup", { name: "สัดส่วนการครอป" })).toBeNull();
	});

	it("renders the crop ratio picker in the top context bar only when the Crop tool is active", () => {
		// Crop drives the existing aspect-ratio-constrained "cover" engine tool.
		editorStore.currentTool = "cover";
		editorUiStore.setActiveDockTool("crop");
		editorStore.selectedAspectRatio = "1:1 Square";

		render(ToolOptionsBar);

		expect(screen.getByText("⛶ เลือกพื้นที่")).toBeTruthy();
		const ratioGroup = screen.getByRole("radiogroup", { name: "สัดส่วนการครอป" });
		expect(ratioGroup).toBeTruthy();
		// The relocated ratio picker is absent from the AI-review ("cover") context.
		expect(screen.queryByText("✦ ผลลัพธ์ AI รอรีวิว")).toBeNull();
	});

	it("renders brush options when brush tool is active", () => {
		editorStore.currentTool = "brush";
		editorStore.brushSize = 40;
		editorStore.brushOpacity = 85;
		editorStore.brushMode = "erase";
		editorStore.brushTarget = {
			kind: "image-layer",
			label: "เลเยอร์รูป",
			labelCode: "imageLayer",
			title: "layer-1.png",
			titleCode: null,
			detail: "บรัชลบรูปเสริม",
			scope: "เลเยอร์",
			impact: "รูป",
			eraseLabelCode: "layerErase",
			restoreLabelCode: "layerRestore",
			restoreHint: "กู้คืน",
			canBrush: true,
			canRestore: true,
			canClearMask: false,
			tone: "ready",
		};

		render(ToolOptionsBar);

		expect(screen.getByText("◐ แปรงคลีน")).toBeTruthy();
		expect(screen.getByLabelText("ขนาดแปรง (px)")).toBeTruthy();
		expect(screen.getByLabelText("ความทึบแปรง (%)")).toBeTruthy();
		// eraseLabelCode/restoreLabelCode localize to the th catalog labels.
		expect(screen.getByRole("button", { name: "ลบจากเลเยอร์" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "คืนรอยปัด" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ลบภาพ" })).toBeNull();
	});

	it("blocks brush controls until an editable image or AI layer is selected", () => {
		editorStore.currentTool = "brush";
		editorStore.brushSize = 40;
		editorStore.brushOpacity = 85;
		editorStore.brushTarget = {
			kind: "unavailable",
			label: "ยังไม่เลือกเลเยอร์",
			labelCode: "pickTarget",
			title: "",
			titleCode: "pickTarget",
			detail: "เลือกเลเยอร์รูปหรือผล AI เพื่อใช้แปรง ภาพฐานจะไม่ถูกแก้",
			scope: "ภาพฐานล็อกไว้",
			impact: "ยังไม่แตะงานบนหน้า",
			eraseLabelCode: "layerErase",
			restoreLabelCode: "layerRestore",
			restoreHint: "เลือกเลเยอร์รูปที่มีต้นฉบับก่อนใช้โหมดกู้คืน",
			canBrush: false,
			canRestore: false,
			canClearMask: false,
			tone: "blocked",
		};

		render(ToolOptionsBar);

		expect(screen.getByRole("status", { name: "เลือกเป้าหมายแปรงก่อน" }).textContent).toContain("เลือกเลเยอร์รูปหรือผล AI ก่อนใช้แปรง");
		expect(screen.getByText("เลือกเลเยอร์รูปหรือผล AI")).toBeTruthy();
		expect(screen.queryByLabelText("ขนาดแปรง (px)")).toBeNull();
		expect(screen.queryByLabelText("ความทึบแปรง (%)")).toBeNull();
		expect(screen.queryByRole("button", { name: "ลบภาพ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "แสดงหน้าต่างลอย" })).toBeNull();
	});

	it("lets the Layers inspector own selected text formatting in the topbar", async () => {
		editorStore.selectedLayer = {
			id: "text-1",
			text: "สวัสดีชาวโลก",
			x: 10,
			y: 20,
			w: 200,
			h: 50,
			fontSize: 24,
			fontFamily: "Arial",
			alignment: "center",
			fill: "#000000",
			stroke: "#ffffff",
			strokeWidth: 2,
		} as any;

		render(ToolOptionsBar);

		expect(screen.getByText("เลือกเลเยอร์")).toBeTruthy();
		const ownerReceipt = screen.getByLabelText("แผงเลเยอร์กำลังแก้เลเยอร์ที่เลือก");
		expect(ownerReceipt.textContent).toContain("กล่องข้อความ");
		expect(ownerReceipt.textContent).toContain("สวัสดีชาวโลก");
		expect(ownerReceipt.textContent).not.toContain("แก้ค่าละเอียดในแผงขวา");
		expect(ownerReceipt.closest(".layer-owner-options")).toBeTruthy();
		expect(screen.getByRole("button", { name: "โฟกัสเลเยอร์ที่เลือกในแผงขวา" })).toBeTruthy();
		expect(screen.queryByText("T กล่องข้อความ")).toBeNull();
		expect(screen.queryByText("Arial")).toBeNull();
		expect(screen.queryByLabelText("จัดกึ่งกลาง")).toBeNull();
		expect(screen.queryByLabelText("สีตัวอักษรหลัก")).toBeNull();
		expect(screen.queryByTitle("แสดงการตั้งค่าสไตล์เส้นขอบและเอฟเฟกต์เพิ่มเติม")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "โฟกัสเลเยอร์ที่เลือกในแผงขวา" }));
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.textInspectorFocusLayerId).toBe("text-1");
	});

	it("offers Thai manga text presets in the selected text options", async () => {
		editorUiStore.setRightPanelMode("project");
		editorStore.selectedLayer = {
			id: "text-preset-1",
			text: "เสียงดังมาก",
			x: 10,
			y: 20,
			w: 200,
			h: 50,
			fontSize: 24,
			fontFamily: "Arial",
			alignment: "center",
			fill: "#000000",
			stroke: "#ffffff",
			strokeWidth: 2,
		} as any;
		const applyTextStylePreset = vi.spyOn(editorStore, "applyTextStylePreset").mockImplementation(() => {});

		render(ToolOptionsBar);

		expect(screen.getByLabelText("Thai manga typeset presets")).toBeTruthy();
		for (const preset of MANGA_TEXT_STYLE_PRESETS) {
			const button = screen.getByRole("button", { name: `Apply Thai manga preset ${preset.name}` });
			expect(button).toBeTruthy();
			expect(button.textContent).toContain(preset.name);
		}

		await fireEvent.click(screen.getByRole("button", { name: "Apply Thai manga preset SFX" }));

		expect(applyTextStylePreset).toHaveBeenCalledTimes(1);
		expect(applyTextStylePreset).toHaveBeenCalledWith(textLayerStyleFromMangaPreset("sfx"));
		expect(applyTextStylePreset.mock.calls[0]?.[0]).not.toBe(MANGA_TEXT_STYLE_PRESETS.find((preset) => preset.id === "sfx")?.layerStyle);
		applyTextStylePreset.mockRestore();
	});

	it("lets the Team Work panel own selected-layer context until the user switches to Layers", async () => {
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.setRightPanelMode("work");
		editorStore.selectedLayer = {
			id: "text-work-1",
			text: "ข้อความมาถึงแล้ว",
			x: 10,
			y: 20,
			w: 200,
			h: 50,
			fontSize: 30,
			fontFamily: "Arial",
			alignment: "center",
			fill: "#000000",
			stroke: "#ffffff",
			strokeWidth: 2,
		} as any;

		render(ToolOptionsBar);

		expect(screen.getByLabelText("แผงงานกำลังเป็นเจ้าของการตัดสินใจ").textContent).toContain("แผงงานกำลังนำทาง");
		expect(screen.getByLabelText("แผงงานกำลังเป็นเจ้าของการตัดสินใจ").textContent).toContain("กล่องข้อความ");
		expect(screen.getByRole("button", { name: "สลับไปแก้เลเยอร์ที่เลือก" })).toBeTruthy();
		expect(screen.queryByText("T กล่องข้อความ")).toBeNull();
		expect(screen.queryByText("Arial")).toBeNull();
		expect(screen.queryByLabelText("จัดกึ่งกลาง")).toBeNull();
		expect(screen.queryByTitle("แสดงการตั้งค่าสไตล์เส้นขอบและเอฟเฟกต์เพิ่มเติม")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "สลับไปแก้เลเยอร์ที่เลือก" }));
		expect(editorUiStore.rightPanelMode).toBe("layers");
	});

	it("lets the Layers inspector own selected image controls in the topbar", async () => {
		editorStore.selectedImageLayer = {
			id: "image-1",
			imageName: "layer-1.png",
			originalName: "layer-1.png",
			x: 0,
			y: 0,
			w: 200,
			h: 150,
			opacity: 1,
			role: "overlay",
		} as any;

		render(ToolOptionsBar);

		expect(screen.getByText("เลือกเลเยอร์")).toBeTruthy();
		expect(screen.getByLabelText("แผงเลเยอร์กำลังแก้เลเยอร์ที่เลือก").textContent).toContain("รูปเสริม");
		expect(screen.getByLabelText("แผงเลเยอร์กำลังแก้เลเยอร์ที่เลือก").textContent).toContain("layer-1.png");
		expect(screen.queryByText("🖼️ เลเยอร์รูปเสริม")).toBeNull();
		expect(screen.queryByLabelText("ความโปร่งใสรูปเสริม")).toBeNull();
		expect(screen.queryByRole("button", { name: "พอดีหน้า" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เต็มกว้าง" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "โฟกัสเลเยอร์ที่เลือกในแผงขวา" }));
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("image-1");
	});

	it("renders compact text credit owner controls without long visible commands", async () => {
		editorStore.selectedLayer = {
			id: "credit-1",
			text: "Translator\nQC",
			x: 10,
			y: 20,
			w: 200,
			h: 50,
			fontSize: 24,
			sourceCategory: "credit",
		} as any;

		render(ToolOptionsBar);

		expect(screen.getByText("เครดิต")).toBeTruthy();
		expect(screen.getByLabelText("เครดิตที่เลือก").textContent).toContain("เครดิตข้อความ");
		expect(screen.getByLabelText("เครดิตที่เลือก").textContent).toContain("เลือกบนหน้านี้");
		expect(screen.getByRole("button", { name: "เปิดเครื่องมือเครดิตข้อความที่เลือก" }).textContent).toContain("แก้ข้อความเครดิต");
		expect(screen.getByRole("button", { name: "ใช้ข้อความเครดิตนี้ซ้ำบนหน้าปัจจุบัน" }).textContent).toContain("ใช้ข้อความ");
		await fireEvent.click(screen.getByRole("button", { name: "เปิดเครื่องมือเครดิตข้อความที่เลือก" }));
		expect(editorUiStore.textInspectorFocusLayerId).toBe("credit-1");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(screen.queryByRole("button", { name: "ลบเครดิตในหน้าปัจจุบัน" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ลบเครดิตทั้งตอน" })).toBeNull();
		expect(screen.queryByRole("button", { name: /ลบหน้า|ลบตอน|ขอบเขต\/ลบ/ })).toBeNull();
		expect(screen.queryByText("วางตามขอบเขต")).toBeNull();
	});

	it("routes selected image credits to the selected-image inspector instead of reapplying a text preset", async () => {
		editorStore.selectedImageLayer = {
			id: "credit-image-1",
			imageName: "logo.png",
			originalName: "logo.png",
			x: 0,
			y: 0,
			w: 200,
			h: 80,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "credit",
		} as any;

		render(ToolOptionsBar);

		expect(screen.getByLabelText("เครดิตที่เลือก").textContent).toContain("รูปเครดิต");
		expect(screen.getByLabelText("เครดิตที่เลือก").textContent).toContain("เลือกบนหน้านี้");
		expect(screen.getByRole("button", { name: "เปิดเครื่องมือรูปเครดิตเพื่อกำหนดตำแหน่งและขอบเขต" }).textContent).toContain("ตั้งรูปเครดิต");
		await fireEvent.click(screen.getByRole("button", { name: "เปิดเครื่องมือรูปเครดิตเพื่อกำหนดตำแหน่งและขอบเขต" }));
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("credit-image-1");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(screen.getAllByRole("button")).toHaveLength(2);
		expect(screen.queryByRole("button", { name: "แก้เครดิต" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ใช้ข้อความเครดิตนี้กับขอบเขตที่เลือก" })).toBeNull();
	});

	it("labels selected AI result opacity as layer opacity, not confidence", () => {
		editorStore.selectedImageLayer = {
			id: "ai-result-1",
			imageName: "ai-result-1.png",
			originalName: "ผล AI หน้า 1",
			x: 0,
			y: 0,
			w: 200,
			h: 150,
			rotation: 0,
			opacity: 0.64,
			index: 0,
			role: "overlay",
		} as any;

		render(ToolOptionsBar);

		expect(screen.getByText("✦ ผลลัพธ์ AI รอรีวิว")).toBeTruthy();
		expect(screen.getByText("ความทึบเลเยอร์: 64%")).toBeTruthy();
		expect(screen.queryByText(/ความมั่นใจ/)).toBeNull();
	});

	it("shows and toggles floating Brush HUD from ToolOptionsBar", async () => {
		editorStore.currentTool = "brush";
		editorStore.brushTarget = { canBrush: true, canRestore: false } as any;

		render(ToolOptionsBar);

		const hudToggle = screen.getByRole("button", { name: "แสดงหน้าต่างลอย" });
		expect(hudToggle).toBeTruthy();
		expect(editorUiStore.showBrushHud).toBe(false);

		await fireEvent.click(hudToggle);
		expect(editorUiStore.showBrushHud).toBe(true);

		await fireEvent.click(hudToggle);
		expect(editorUiStore.showBrushHud).toBe(false);
	});

	it("labels the exact edited layer name when a valid brush target exists", () => {
		editorStore.currentTool = "brush";
		editorStore.brushTarget = {
			kind: "image-layer",
			title: "clean-target-page-104.png",
			canBrush: true,
			canRestore: false,
		} as any;

		render(ToolOptionsBar);

		expect(screen.getByText("กำลังแก้ไข: clean-target-page-104.png")).toBeTruthy();
	});

	it("labels selected AI result brush targets as AI results in the topbar", () => {
		editorStore.currentTool = "brush";
		editorStore.brushTarget = {
			kind: "image-layer",
			label: "ผล AI ที่วางแล้ว",
			labelCode: "aiResult",
			title: "ผล AI หน้า 1",
			titleCode: null,
			detail: "แปรงจะลบเฉพาะผล AI ที่วางเป็นเลเยอร์นี้ ภาพฐานและผล AI อื่นไม่ถูกแตะ.",
			scope: "แก้เฉพาะเลเยอร์นี้",
			impact: "มีผลตอนบันทึกและ Export",
			eraseLabelCode: "aiResultErase",
			restoreLabelCode: "aiResultRestore",
			restoreHint: "กู้คืนจากผล AI เดิมของเลเยอร์นี้ก่อนถูกแปรง",
			canBrush: true,
			canRestore: false,
			canClearMask: false,
			tone: "ready",
		};

		render(ToolOptionsBar);

		expect(screen.getByText("กำลังแก้ไขผล AI: ผล AI หน้า 1")).toBeTruthy();
		expect(screen.getByLabelText("ผล AI ที่วางแล้ว: ผล AI หน้า 1")).toBeTruthy();
		expect(screen.getByRole("button", { name: "ลบจากผล AI" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ลบภาพ" })).toBeNull();
		expect(screen.getAllByTitle(/ภาพฐานและผล AI อื่นไม่ถูกแตะ/).length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByRole("status", { name: "เลือกเป้าหมายแปรงก่อน" })).toBeNull();
	});

	it("opens the real editor history stack and delegates jumps to editorStore", async () => {
		editorStore.historyEntries = [
			{ id: "history-1", label: "เพิ่มข้อความ", at: Date.now() - 60_000 },
			{ id: "history-2", label: "แก้ภาพด้วยแปรง", at: Date.now() },
		];
		editorStore.historyCurrentIndex = 0;
		const jumpHistoryTo = vi.spyOn(editorStore, "jumpHistoryTo").mockResolvedValue(undefined);

		render(ToolOptionsBar);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดประวัติย้อนกลับ/ทำซ้ำ" }));

		expect(screen.getByRole("region", { name: "ประวัติการแก้ไข" })).toBeTruthy();
		expect(screen.getByText("2 รายการ")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ไปยังประวัติ 2: แก้ภาพด้วยแปรง" }));

		expect(jumpHistoryTo).toHaveBeenCalledWith(1);
		jumpHistoryTo.mockRestore();
	});

	it("closes the history popover from outside clicks and Escape without closing on inside clicks", async () => {
		editorStore.historyEntries = [
			{ id: "history-1", label: "เพิ่มข้อความ", at: Date.now() - 60_000 },
		];

		render(ToolOptionsBar);

		const historyTrigger = screen.getByRole("button", { name: "เปิดประวัติย้อนกลับ/ทำซ้ำ" });
		await fireEvent.click(historyTrigger);
		const panel = screen.getByRole("region", { name: "ประวัติการแก้ไข" });

		await fireEvent.pointerDown(panel);
		expect(screen.getByRole("region", { name: "ประวัติการแก้ไข" })).toBeTruthy();

		await fireEvent.pointerDown(document.body);
		expect(screen.queryByRole("region", { name: "ประวัติการแก้ไข" })).toBeNull();

		await fireEvent.click(historyTrigger);
		expect(screen.getByRole("region", { name: "ประวัติการแก้ไข" })).toBeTruthy();

		await fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("region", { name: "ประวัติการแก้ไข" })).toBeNull();
	});

	it("keeps only one floating tool popover open when switching between history and fill color", async () => {
		editorStore.historyEntries = [
			{ id: "history-1", label: "เพิ่มข้อความ", at: Date.now() - 60_000 },
		];
		editorStore.currentTool = "select";
		editorStore.activeImageTool = "bucket-fill";

		render(ToolOptionsBar);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดประวัติย้อนกลับ/ทำซ้ำ" }));
		expect(screen.getByRole("region", { name: "ประวัติการแก้ไข" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เลือกสีเติม #FFFFFF" }));
		expect(screen.getByRole("dialog", { name: "ตัวเลือกสีเติม" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "ประวัติการแก้ไข" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดประวัติย้อนกลับ/ทำซ้ำ" }));
		expect(screen.getByRole("region", { name: "ประวัติการแก้ไข" })).toBeTruthy();
		expect(screen.queryByRole("dialog", { name: "ตัวเลือกสีเติม" })).toBeNull();
	});

	it("repositions open history and color popovers on viewport reflow", async () => {
		editorStore.historyEntries = [
			{ id: "history-1", label: "เพิ่มข้อความ", at: Date.now() - 60_000 },
		];
		editorStore.currentTool = "select";
		editorStore.activeImageTool = "bucket-fill";

		render(ToolOptionsBar);

		const historyTrigger = screen.getByRole("button", { name: "เปิดประวัติย้อนกลับ/ทำซ้ำ" });
		let historyRect = makeRect({ top: 10, left: 24, width: 160, height: 30 });
		vi.spyOn(historyTrigger, "getBoundingClientRect").mockImplementation(() => historyRect);

		await fireEvent.click(historyTrigger);
		let historyPopover = document.querySelector(".history-panel-popover") as HTMLElement;
		expect(historyPopover.style.top).toBe("48px");
		expect(historyPopover.style.left).toBe("24px");

		historyRect = makeRect({ top: 90, left: 72, width: 160, height: 30 });
		window.dispatchEvent(new Event("resize"));

		await waitFor(() => {
			historyPopover = document.querySelector(".history-panel-popover") as HTMLElement;
			expect(historyPopover.style.top).toBe("128px");
			expect(historyPopover.style.left).toBe("72px");
		});

		const colorTrigger = screen.getByRole("button", { name: "เลือกสีเติม #FFFFFF" });
		let colorRect = makeRect({ top: 20, left: 40, width: 180, height: 30 });
		vi.spyOn(colorTrigger, "getBoundingClientRect").mockImplementation(() => colorRect);

		await fireEvent.click(colorTrigger);
		let colorPopover = document.querySelector(".tool-color-popover") as HTMLElement;
		expect(colorPopover.style.top).toBe("58px");
		expect(colorPopover.style.left).toBe("40px");

		colorRect = makeRect({ top: 70, left: 88, width: 180, height: 30 });
		window.dispatchEvent(new Event("scroll"));

		await waitFor(() => {
			colorPopover = document.querySelector(".tool-color-popover") as HTMLElement;
			expect(colorPopover.style.top).toBe("108px");
			expect(colorPopover.style.left).toBe("88px");
		});
	});

	it("does NOT offer a color picker for the brush (erase/restore engine — a color control would be inert)", async () => {
		editorStore.currentTool = "brush";
		editorStore.brushColor = "#112233";
		editorStore.recentToolColors = ["#445566"];
		editorStore.brushTarget = { canBrush: true, canRestore: false } as any;

		render(ToolOptionsBar);

		expect(screen.queryByRole("button", { name: /เลือกสีแปรง/ })).toBeNull();
	});

	it("uses ColorPickerPopover as the bucket-fill color option", async () => {
		editorStore.currentTool = "select";
		editorStore.activeImageTool = "bucket-fill";
		editorStore.imageToolFillColor = "#FFFFFF";
		editorStore.recentToolColors = ["#223344"];

		render(ToolOptionsBar);

		await fireEvent.click(screen.getByRole("button", { name: "เลือกสีเติม #FFFFFF" }));
		expect(screen.getByRole("dialog", { name: "ตัวเลือกสีเติม" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("option", { name: "เลือกสี #223344" }));

		expect(editorStore.imageToolFillColor).toBe("#223344");
		expect(editorStore.recentToolColors[0]).toBe("#223344");
	});

	it("uses ColorPickerPopover as the magic-clean color option", async () => {
		editorStore.currentTool = "select";
		editorStore.activeImageTool = "magic-clean";
		editorStore.imageToolFillColor = "#FFFFFF";
		editorStore.recentToolColors = ["#334455"];

		render(ToolOptionsBar);

		await fireEvent.click(screen.getByRole("button", { name: "เลือกสีเติม #FFFFFF" }));
		expect(screen.getByRole("dialog", { name: "ตัวเลือกสีเติม" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("option", { name: "เลือกสี #334455" }));

		expect(editorStore.imageToolFillColor).toBe("#334455");
		expect(editorStore.recentToolColors[0]).toBe("#334455");
	});
});
