import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
// Register the locale dictionaries (addMessages + init) so EffectsPanel's $_(...) keys
// resolve to real strings instead of the raw key. test-setup.ts forces the active locale to th.
import "$lib/i18n";
import EffectsPanel from "$lib/components/EffectsPanel.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import type { TextLayer, TextLayerEffects } from "$lib/types.js";

const baseLayer = (): TextLayer => ({
	id: "text-1",
	text: "Hello",
	x: 10,
	y: 20,
	w: 200,
	h: 80,
	rotation: 0,
	fontSize: 32,
	fontFamily: "Tahoma",
	fill: "#111111",
	stroke: "#ffffff",
	strokeWidth: 2,
	alignment: "center",
	index: 0,
});

describe("EffectsPanel", () => {
	let applyEffects: ReturnType<typeof vi.fn>;
	let currentPresetId: string;

	async function applyPreset(id: string) {
		const presetOrder = ["readable", "dungeon", "curse", "haunt", "scream", "romance"];
		const cycleButton = screen.getByRole("button", { name: /เลือก preset เอฟเฟกต์ข้อความ/ });
		while (currentPresetId !== id) {
			await fireEvent.click(cycleButton);
			currentPresetId = presetOrder[(presetOrder.indexOf(currentPresetId) + 1) % presetOrder.length];
		}
		await fireEvent.click(screen.getByRole("button", { name: "ใช้ preset ที่เลือก" }));
	}

	beforeEach(() => {
		currentPresetId = "readable";
		const layer = baseLayer();
		applyEffects = vi.fn((effects: TextLayerEffects | null) => ({
			...editorStore.selectedLayer!,
			effects: effects ?? undefined,
			stroke: effects?.stroke?.enabled ? effects.stroke.color : editorStore.selectedLayer!.stroke,
			strokeWidth: effects?.stroke?.enabled ? effects.stroke.width : editorStore.selectedLayer!.strokeWidth,
		}));
		editorStore.selectedLayer = layer;
		editorStore.editor = {
			applyEffects,
			updateTextLayer: vi.fn((_id: string, updates: Partial<TextLayer>) => {
				editorStore.selectedLayer = { ...editorStore.selectedLayer!, ...updates };
				return editorStore.selectedLayer;
			}),
			getAllTextLayers: () => [editorStore.selectedLayer],
			canUndo: () => false,
			canRedo: () => false,
		};
	});

	it("applies text stroke effects through the editor store in real time", async () => {
		render(EffectsPanel);

		expect(screen.getByText("ยังไม่เปิดเอฟเฟกต์")).toBeTruthy();
		expect(screen.getByText("ภาพและ Export ใช้ขอบ + แสง + เงาในสแต็กเดียว")).toBeTruthy();
		expect(screen.getByText("ตัวอย่างสดบนภาพ / แสงเงาปัจจุบัน: ไม่มี")).toBeTruthy();
		expect(screen.getByText("เปิดเมื่อต้องจูนขอบ แสง เงา")).toBeTruthy();
		expect(screen.queryByText("ขอบ ปิด")).toBeNull();
		expect(screen.queryByRole("button", { name: "รีเซ็ตเอฟเฟกต์ทั้งหมด" })).toBeNull();
		const preview = screen.getByTitle("Hello");
		expect(preview.getAttribute("style")).toContain('font-family: "Tahoma"');
		expect(preview.getAttribute("style")).toContain("font-size: 32px");
		expect(preview.getAttribute("style")).toContain("letter-spacing: 0px");
		expect(preview.getAttribute("style")).toContain("transform: skew(0deg, 0deg)");

		await fireEvent.click(screen.getByText("ปรับละเอียด"));
		expect(screen.getByText("ทรงตัวอักษร")).toBeTruthy();
		const skewX = screen.getByLabelText("ค่าเอียงตัวอักษร X") as HTMLInputElement;
		await fireEvent.input(skewX, { target: { value: "-18" } });
		expect(editorStore.selectedLayer?.skewX).toBe(-18);
		expect(screen.getByTitle("Hello").getAttribute("style")).toContain("transform: skew(-18deg, 0deg)");
		await fireEvent.click(screen.getByRole("button", { name: "รีเซ็ตทรง" }));
		expect(editorStore.selectedLayer?.skewX).toBe(0);
		expect(editorStore.selectedLayer?.skewY).toBe(0);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดขอบตัวอักษร" }));
		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			stroke: expect.objectContaining({ enabled: true, color: "#ffffff", width: 2 }),
		}));
		expect(screen.getAllByText("1 เลเยอร์เปิดอยู่").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByRole("button", { name: "รีเซ็ตเอฟเฟกต์ทั้งหมด" })).toBeTruthy();

		const strokeWidth = document.querySelector("#effect-stroke-width") as HTMLInputElement;
		await fireEvent.input(strokeWidth, { target: { value: "9" } });

		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			stroke: expect.objectContaining({ enabled: true, width: 8 }),
		}));
		expect(editorStore.selectedLayer?.strokeWidth).toBe(8);
		expect(screen.getAllByText(/ขอบ 8px/).length).toBeGreaterThanOrEqual(1);

		const strokeNumber = screen.getByLabelText("ค่าความกว้างขอบ") as HTMLInputElement;
		await fireEvent.input(strokeNumber, { target: { value: "10" } });

		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			stroke: expect.objectContaining({ enabled: true, width: 8 }),
		}));
		expect(editorStore.selectedLayer?.strokeWidth).toBe(8);
	});

	it("clears text effects without leaving stale effect metadata", async () => {
		render(EffectsPanel);

		await fireEvent.click(screen.getByText("ปรับละเอียด"));
		await fireEvent.click(screen.getByRole("button", { name: "เงา" }));
		await fireEvent.click(screen.getByRole("button", { name: "รีเซ็ตเอฟเฟกต์ทั้งหมด" }));

		expect(applyEffects).toHaveBeenLastCalledWith(null);
		expect(editorStore.selectedLayer?.effects).toBeUndefined();
	});

	it("applies starter effect presets for faster text styling", async () => {
		render(EffectsPanel);

		await applyPreset("dungeon");

		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			stroke: expect.objectContaining({ enabled: true, color: "#020617", width: 7 }),
			outerGlow: expect.objectContaining({ enabled: true, color: "#22d3ee", blur: 46, opacity: 94 }),
			dropShadow: expect.objectContaining({ enabled: true, color: "#0f172a", offsetX: 5, offsetY: 6, blur: 0, opacity: 74 }),
			accentShadows: expect.arrayContaining([
				expect.objectContaining({ enabled: true, color: "#67e8f9" }),
			]),
			passes: expect.arrayContaining([
				expect.objectContaining({ enabled: true, fill: "#1e3a8a", stroke: "#020617" }),
			]),
		}));
		expect(screen.getAllByText("5 เลเยอร์เปิดอยู่").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("ขอบ 7px")).toBeTruthy();
		expect(screen.getByText("เลเยอร์หลัง 2")).toBeTruthy();
		expect(screen.getByText("แสงเสริม 2")).toBeTruthy();
		const previewMain = screen.getByTitle("Hello");
		expect(previewMain.classList.contains("effect-preview-main")).toBe(true);
		expect(previewMain.getAttribute("style")).toContain("0 0 46px");
		expect(previewMain.getAttribute("style")).toContain("rgba(103, 232, 249, 0.64)");
		const previewPasses = document.querySelectorAll(".effect-preview-pass");
		expect(previewPasses.length).toBe(2);
		expect(previewPasses[0]?.getAttribute("style")).toContain("translate(12px, 14px)");
		expect(previewPasses[0]?.getAttribute("style")).toContain("-webkit-text-stroke: 7px #020617");
		expect(editorStore.selectedLayer?.charSpacing).toBe(45);
		expect(editorStore.selectedLayer?.skewX).toBe(-8);

		await applyPreset("scream");
		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			stroke: expect.objectContaining({ enabled: true, color: "#450a0a", width: 8 }),
			outerGlow: expect.objectContaining({ enabled: true, color: "#fb7185", blur: 18, opacity: 78 }),
			dropShadow: expect.objectContaining({ enabled: true, color: "#991b1b", offsetX: 9, offsetY: 10, blur: 0, opacity: 92 }),
		}));
		expect(editorStore.selectedLayer?.charSpacing).toBe(-25);
		expect(editorStore.selectedLayer?.skewX).toBe(-14);
		await fireEvent.click(screen.getByText("ปรับละเอียด"));
		await fireEvent.input(screen.getByLabelText("ค่าเอียงตัวอักษร Y"), { target: { value: "12" } });
		expect(editorStore.selectedLayer?.skewY).toBe(12);
		expect(editorStore.selectedLayer?.effects?.dropShadow?.enabled).toBe(true);

		await applyPreset("haunt");
		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			stroke: expect.objectContaining({ enabled: true, color: "#3b0764", width: 5 }),
			outerGlow: expect.objectContaining({ enabled: true, color: "#c084fc", blur: 42, opacity: 86 }),
			dropShadow: expect.objectContaining({ enabled: false }),
		}));
		expect(editorStore.selectedLayer?.charSpacing).toBe(180);
		expect(editorStore.selectedLayer?.skewX).toBe(18);
		expect(editorStore.selectedLayer?.skewY).toBe(-6);
		expect(screen.getByRole("button", { name: "เลือก preset เอฟเฟกต์ข้อความ ตอนนี้ เสียงหลอนเลื้อย" })).toBeTruthy();
		expect(screen.getByText("เว้นยาว + แสงม่วง")).toBeTruthy();
	});

	it("uses the selected layer stroke as the effect starting point", async () => {
		editorStore.selectedLayer = {
			...baseLayer(),
			stroke: "#c1121f",
			strokeWidth: 6,
		};
		render(EffectsPanel);

		await fireEvent.click(screen.getByText("ปรับละเอียด"));
		await fireEvent.click(screen.getByRole("button", { name: "เปิดขอบตัวอักษร" }));

		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			stroke: expect.objectContaining({ enabled: true, color: "#c1121f", width: 6 }),
		}));
		expect(screen.getAllByText(/ขอบ 6px/).length).toBeGreaterThanOrEqual(1);
	});

	it("keeps glow and shadow stackable for export-grade SFX", async () => {
		render(EffectsPanel);

		await fireEvent.click(screen.getByText("ปรับละเอียด"));
		await fireEvent.click(screen.getByRole("button", { name: "เรืองแสง" }));
		expect(screen.getByText("ตัวอย่างสดบนภาพ / แสงเงาปัจจุบัน: แสง")).toBeTruthy();
		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			outerGlow: expect.objectContaining({ enabled: true }),
			dropShadow: expect.objectContaining({ enabled: false }),
		}));

		const glowBlur = screen.getByLabelText("ค่าเบลอแสง") as HTMLInputElement;
		await fireEvent.input(glowBlur, { target: { value: "44" } });
		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			outerGlow: expect.objectContaining({ enabled: true, blur: 44 }),
		}));

		await fireEvent.click(screen.getByRole("button", { name: "เงา" }));

		expect(screen.getByText("ตัวอย่างสดบนภาพ / แสงเงาปัจจุบัน: แสง + เงา")).toBeTruthy();
		expect(applyEffects).toHaveBeenLastCalledWith(expect.objectContaining({
			outerGlow: expect.objectContaining({ enabled: true }),
			dropShadow: expect.objectContaining({ enabled: true }),
		}));
		expect(screen.getByText("แสง 44px / 80%")).toBeTruthy();
	});

	it("refreshes the open controls when the same selected layer gets effects from another path", async () => {
		render(EffectsPanel);

		expect(screen.getByText("ยังไม่เปิดเอฟเฟกต์")).toBeTruthy();
		editorStore.selectedLayer = {
			...editorStore.selectedLayer!,
			stroke: "#111111",
			strokeWidth: 3,
			effects: {
				stroke: { enabled: true, color: "#111111", width: 3 },
				outerGlow: { enabled: true, color: "#ffcc00", blur: 18, opacity: 75 },
				dropShadow: { enabled: true, color: "#000000", offsetX: 3, offsetY: 3, blur: 5, opacity: 50 },
			},
		};
		await tick();

		expect(screen.getAllByText("3 เลเยอร์เปิดอยู่").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("ตัวอย่างสดบนภาพ / แสงเงาปัจจุบัน: แสง + เงา")).toBeTruthy();
		expect(screen.getByText("ขอบ 3px")).toBeTruthy();
	});
});
