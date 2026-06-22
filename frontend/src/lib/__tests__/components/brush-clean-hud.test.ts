import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import BrushCleanHUD from "$lib/components/BrushCleanHUD.svelte";
import { editorStore, type BrushTargetState } from "$lib/stores/editor.svelte.ts";

const imageLayerTarget: BrushTargetState = {
	kind: "image-layer",
	label: "เลเยอร์รูปแก้ไข",
	labelCode: "imageLayer",
	title: "clean-layer.png",
	titleCode: null,
	detail: "ลบเฉพาะเลเยอร์",
	scope: "แก้เฉพาะเลเยอร์นี้",
	impact: "มีผลตอนบันทึก",
	eraseLabelCode: "layerErase",
	restoreLabelCode: "layerRestore",
	restoreHint: "กู้คืนจากต้นฉบับ",
	canBrush: true,
	canRestore: true,
	canClearMask: false,
	tone: "ready",
};

const unavailableTarget: BrushTargetState = {
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

beforeEach(() => {
	editorStore.brushSize = 30;
	editorStore.brushOpacity = 100;
	editorStore.brushMode = "erase";
	editorStore.brushTarget = unavailableTarget;
	window.innerWidth = 1280;
});

describe("BrushCleanHUD", () => {
	it("localizes the producer's stable codes into the th catalog labels", () => {
		editorStore.brushTarget = imageLayerTarget;

		render(BrushCleanHUD);

		// Own component strings (re-localized, byte-exact th).
		expect(screen.getByRole("region", { name: "แผงแปรงคลีน" })).toBeTruthy();
		expect(screen.getByText("เป้าหมายแปรง")).toBeTruthy();
		expect(screen.getByText("ขนาดแปรง")).toBeTruthy();
		expect(screen.getByText("ความทึบ")).toBeTruthy();
		// Dynamic display name rendered verbatim (titleCode === null).
		expect(screen.getByText("clean-layer.png")).toBeTruthy();
		// Producer label codes localized via $_("brushTarget.erase/restore.*").
		expect(screen.getByText("ลบจากเลเยอร์")).toBeTruthy();
		expect(screen.getByText("คืนรอยปัด")).toBeTruthy();
	});

	it("localizes a fixed titleCode instead of showing an empty title", () => {
		editorStore.brushTarget = { ...unavailableTarget, canBrush: true };

		render(BrushCleanHUD);

		// titleCode "pickTarget" -> the localized fixed label.
		expect(screen.getByText("เลือกเลเยอร์รูปหรือผล AI")).toBeTruthy();
	});

	it("shows the localized passive restore receipt when restore is unavailable", () => {
		editorStore.brushTarget = { ...imageLayerTarget, canRestore: false };

		render(BrushCleanHUD);

		expect(screen.getByText("ยังไม่มีรอยแปรงให้กู้คืน")).toBeTruthy();
		expect(screen.getByText("พร้อมใช้แปรงลบ")).toBeTruthy();
		expect(screen.queryByText("คืนรอยปัด")).toBeNull();
	});
});
