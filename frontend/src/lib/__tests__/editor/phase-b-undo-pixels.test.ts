// Phase B — codex #392 P1-1: undo of a non-destructive heal/clone must REVERT the
// visible backing-canvas pixels, not leave a phantom baked into the mutable background.
//
// The bug: the instant `preview:true` apply paints the healed/cloned ROI onto the
// mutable `backgroundEditCanvas`, AND `commitImageEditLayerPatch` records an overlay
// edit layer — so the edit was drawn TWICE. On undo, `ImageEditLayerCommand.undo()`
// only removes the overlay, leaving the baked pixels in the backing canvas (a phantom
// that desyncs from project state until reload). The fix un-bakes the preview ROI from
// the backing canvas after a successful commit (restoring the ORIGINAL pixels), so the
// edit renders ONLY via the overlay; undo→remove overlay→pristine pixels, redo→re-add.
//
// This test drives the REAL MangaEditor methods (applyToolPatchInstant +
// commitImageEditLayerPatch + the history command undo/redo) against a real backing
// canvas and asserts the backing-canvas ROI pixels revert to the original on undo and
// re-show the edit on redo. rebuildEditComposite/loadFabricImage (the overlay paint)
// are stubbed — this test is about the BACKING canvas (the source of the phantom).

import { describe, it, expect, vi } from "vitest";
import { MangaEditor, __test_HistoryManager as HistoryManager } from "$lib/canvas/editor.ts";
import type { ImageEditLayer } from "$lib/types.ts";

vi.mock("$lib/config.js", () => ({
	config: {
		defaultFontFamily: "Tahoma, sans-serif",
		defaultFontSize: 24,
		defaultText: "ข้อความ",
		canvas: { minZoom: 0.1, maxZoom: 5 },
	},
}));

const SIZE = 32;

function makeImageData(fill: [number, number, number], w = SIZE, h = SIZE): ImageData {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const o = i * 4;
		data[o] = fill[0];
		data[o + 1] = fill[1];
		data[o + 2] = fill[2];
		data[o + 3] = 255;
	}
	return new ImageData(data, w, h);
}

/** Read the average RGB of an ROI on a canvas (so we don't depend on exact bytes). */
function avgRgb(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): [number, number, number] {
	const d = ctx.getImageData(x, y, w, h).data;
	let r = 0, g = 0, b = 0;
	const n = w * h;
	for (let i = 0; i < n; i++) {
		const o = i * 4;
		r += d[o];
		g += d[o + 1];
		b += d[o + 2];
	}
	return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Build a real MangaEditor instance with only the fields the instant-patch + edit-layer
 * commit + history path touch. The backing canvas is a real <canvas> seeded grey; the
 * overlay paint (rebuildEditComposite) is stubbed so the assertion isolates the BACKING
 * canvas, where the P1-1 phantom lived.
 */
function makeEditorWithBacking(commitResult = true) {
	const backing = document.createElement("canvas");
	backing.width = SIZE;
	backing.height = SIZE;
	const bctx = backing.getContext("2d", { willReadFrequently: true })!;
	// jsdom's canvas does not rasterize fillRect, but putImageData/getImageData round-trip
	// the raw buffer reliably — seed the ORIGINAL grey background via putImageData.
	bctx.putImageData(makeImageData([128, 128, 128]), 0, 0);

	const editor = Object.create(MangaEditor.prototype) as any;
	editor.imageWidth = SIZE;
	editor.imageHeight = SIZE;
	editor.imageEpoch = 0;
	editor.imageItem = { dirty: false };
	editor.canvas = { requestRenderAll: vi.fn() };
	editor.imageEditLayers = [];
	editor.history = new HistoryManager();
	editor.editLayersSourceImageId = "page-1";
	editor.previewRoiOriginal = null;
	editor.backgroundEditCanvas = backing;
	editor.backgroundEditCtx = bctx;
	// Make ensureBackgroundEditCanvas a no-op that returns the seeded backing ctx.
	editor.ensureBackgroundEditCanvas = () => bctx;
	// Stub the overlay paint — we assert on the BACKING canvas, not the overlay.
	editor.rebuildEditComposite = vi.fn(async () => {});
	editor.onHistoryChange = vi.fn();
	editor.onImageEditLayersChange = vi.fn();
	// Encode is async toBlob in jsdom; stub to a deterministic non-null blob.
	editor.encodeImageDataToPng = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
	editor.encodeMaskRoiToPng = vi.fn(async () => new Blob(["m"], { type: "image/png" }));
	// The store wiring: return a recorded layer (or null to simulate failure).
	editor.onCommitImageEditLayerPatch = vi.fn(async (input: any): Promise<ImageEditLayer | null> => {
		if (!commitResult) return null;
		return {
			id: "edit-heal-1",
			kind: input.kind,
			target: "page-background",
			visible: true,
			opacity: 1,
			sourceImageId: "page-1",
			bbox: { x: input.region.x, y: input.region.y, w: input.region.width, h: input.region.height },
			payload: { type: input.kind, realizedPatchAssetId: "heal-asset-1", maskAssetId: "mask-asset-1", patchEncoding: "png-rgba" },
			index: 0,
			tool: input.tool,
			createdAt: "2026-06-06T00:00:00.000Z",
		} as ImageEditLayer;
	});
	editor.resolveProjectImageUrl = (id: string) => `https://test.local/${id}`;
	return { editor, backing, bctx };
}

const REGION = { x: 8, y: 8, width: 12, height: 12 };

describe("Phase B P1-1 — undo reverts the backing-canvas pixels (no phantom)", () => {
	it("heal: preview bakes into backing, commit un-bakes, undo→pristine, redo→edit", async () => {
		const { editor, bctx } = makeEditorWithBacking(true);

		// ORIGINAL grey ROI.
		expect(avgRgb(bctx, REGION.x, REGION.y, REGION.width, REGION.height)).toEqual([128, 128, 128]);

		// 1) Tool paints the healed ROI as a transient PREVIEW (white) onto the backing canvas.
		const healed = makeImageData([255, 255, 255], REGION.width, REGION.height);
		const applied = editor.applyToolPatchInstant(healed, REGION, 0, { preview: true });
		expect(applied).toBe(true);
		// Preview is visible on the backing canvas now.
		expect(avgRgb(bctx, REGION.x, REGION.y, REGION.width, REGION.height)).toEqual([255, 255, 255]);

		// 2) Commit the edit LAYER. After success the backing ROI is un-baked to ORIGINAL
		//    (the edit now lives only in the overlay).
		const recorded = await editor.commitImageEditLayerPatch({
			kind: "healing",
			patch: healed,
			mask: new Uint8ClampedArray(SIZE * SIZE),
			region: REGION,
			tool: { id: "healing-brush" },
			algorithm: "telea",
			algorithmVersion: "telea-1",
		});
		expect(recorded).toBe(true);
		// CRITICAL: backing canvas is back to ORIGINAL grey (overlay holds the edit now).
		expect(avgRgb(bctx, REGION.x, REGION.y, REGION.width, REGION.height)).toEqual([128, 128, 128]);
		expect(editor.imageEditLayers).toHaveLength(1);

		// 3) UNDO — removes the overlay layer. Backing canvas must STAY pristine (no phantom).
		expect(editor.canUndo()).toBe(true);
		await editor.undo();
		expect(editor.imageEditLayers).toHaveLength(0);
		expect(avgRgb(bctx, REGION.x, REGION.y, REGION.width, REGION.height)).toEqual([128, 128, 128]);

		// 4) REDO — re-adds the overlay layer (edit reappears via overlay; backing stays clean).
		expect(editor.canRedo()).toBe(true);
		await editor.redo();
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["edit-heal-1"]);
		expect(avgRgb(bctx, REGION.x, REGION.y, REGION.width, REGION.height)).toEqual([128, 128, 128]);
	});

	it("commit FAILURE leaves no lingering snapshot and does not un-bake", async () => {
		const { editor, bctx } = makeEditorWithBacking(false);
		const healed = makeImageData([255, 255, 255], REGION.width, REGION.height);
		editor.applyToolPatchInstant(healed, REGION, 0, { preview: true });
		expect(avgRgb(bctx, REGION.x, REGION.y, REGION.width, REGION.height)).toEqual([255, 255, 255]);
		const recorded = await editor.commitImageEditLayerPatch({
			kind: "healing",
			patch: healed,
			mask: new Uint8ClampedArray(SIZE * SIZE),
			region: REGION,
			tool: { id: "healing-brush" },
		});
		expect(recorded).toBe(false);
		// No edit layer recorded; the tool (not the editor) handles the visual revert.
		expect(editor.imageEditLayers).toHaveLength(0);
		// The stale snapshot was dropped so the NEXT stroke captures a fresh original.
		expect(editor.previewRoiOriginal).toBeNull();
	});
});
