import { describe, expect, it } from "vitest";
import {
	CANVAS_WORK_OVERLAY_KINDS,
	CANVAS_WORK_OVERLAY_META,
	DEFAULT_CANVAS_OVERLAY_VISIBILITY,
	getCanvasOverlayZIndex,
	isCanvasOverlayInteractive,
} from "$lib/editor/overlay-priority.js";

describe("overlay priority", () => {
	it("keeps selected work regions above unselected regions from other systems", () => {
		expect(getCanvasOverlayZIndex("ai-review", { selected: true }))
			.toBeGreaterThan(getCanvasOverlayZIndex("qc"));
		expect(getCanvasOverlayZIndex("comment", { selected: true }))
			.toBeGreaterThan(getCanvasOverlayZIndex("qc"));
		expect(getCanvasOverlayZIndex("qc", { selected: true }))
			.toBeGreaterThan(getCanvasOverlayZIndex("comment"));
	});

	it("keeps blocking overlays above review markers", () => {
		expect(getCanvasOverlayZIndex("overlay-controls")).toBeGreaterThan(getCanvasOverlayZIndex("qc", { selected: true }));
		expect(getCanvasOverlayZIndex("tool-hint")).toBeGreaterThan(getCanvasOverlayZIndex("qc", { selected: true }));
		expect(getCanvasOverlayZIndex("tool-hint")).toBeGreaterThan(getCanvasOverlayZIndex("overlay-controls"));
		expect(getCanvasOverlayZIndex("asset-error")).toBeGreaterThan(getCanvasOverlayZIndex("tool-hint"));
		expect(getCanvasOverlayZIndex("loading")).toBeGreaterThan(getCanvasOverlayZIndex("asset-error"));
	});

	it("only allows review overlays to intercept clicks while selecting", () => {
		expect(isCanvasOverlayInteractive("select")).toBe(true);
		expect(isCanvasOverlayInteractive("brush")).toBe(false);
		expect(isCanvasOverlayInteractive("text")).toBe(false);
	});

	it("defines the work-region overlays that can be filtered together", () => {
		expect(CANVAS_WORK_OVERLAY_KINDS).toEqual(["qc", "comment", "ai-review"]);
		expect(DEFAULT_CANVAS_OVERLAY_VISIBILITY).toEqual({
			qc: true,
			comment: true,
			"ai-review": true,
		});
		// The overlay KIND key is itself the stable code (consumers localize via
		// $_("canvasOverlay.kind.<id>")); display labels no longer live on the map.
		expect(CANVAS_WORK_OVERLAY_META.qc.id).toBe("qc");
		expect(CANVAS_WORK_OVERLAY_META.comment.id).toBe("comment");
		expect(CANVAS_WORK_OVERLAY_META["ai-review"].id).toBe("ai-review");
		// Swatches carry stable label CODES, not Thai display text.
		expect(CANVAS_WORK_OVERLAY_META.qc.swatches?.map((s) => s.labelCode)).toEqual([
			"qcWarning",
			"qcError",
		]);
		expect(CANVAS_WORK_OVERLAY_META.comment.swatches?.map((s) => s.labelCode)).toEqual([
			"commentMessage",
		]);
	});
});
