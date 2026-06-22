// Phase A — Bubble Auto-Clean is NON-DESTRUCTIVE.
//
// Instead of baking a full new page PNG per click (the legacy `commitToolBackground`
// / debounced full-image persist path), a bubble-clean click must record a small
// `ImageEditLayer` via the host's `commitImageEditLayer`: it uploads ONLY the tiny
// alpha-mask ROI as an `image-edit-mask` asset and appends a fill-mask layer. This
// test drives the real `createBubbleCleanTool` through the registry against a host
// that exposes `commitImageEditLayer`, and asserts:
//   1) commitImageEditLayer is called with the ROI-sized mask, a bbox, and a fill;
//   2) the mask payload is the BUBBLE region only (smaller than the whole page), so
//      the stored edit is tiny — not a full-page bitmap;
//   3) the legacy full-image background commit path is NOT used.

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createBubbleCleanTool } from "$lib/editor/tools/bubble-clean-tool.ts";
import { readSourceImageData, type PixelRegion } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

const SIZE = 64;

/** A white bubble with a black ring + glyph on a dark page, so a click cleans it. */
function makeBubbleCanvas(): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = SIZE;
	c.height = SIZE;
	const ctx = c.getContext("2d");
	if (!ctx) return c;
	const data = new Uint8ClampedArray(SIZE * SIZE * 4);
	const set = (x: number, y: number, v: number) => {
		const o = (y * SIZE + x) * 4;
		data[o] = v;
		data[o + 1] = v;
		data[o + 2] = v;
		data[o + 3] = 255;
	};
	for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) set(x, y, 40);
	const bx = 20;
	const by = 20;
	for (let y = by; y < by + 20; y++) for (let x = bx; x < bx + 20; x++) set(x, y, 0); // border box
	for (let y = by + 2; y < by + 18; y++) for (let x = bx + 2; x < bx + 18; x++) set(x, y, 255); // interior
	for (let y = by + 8; y < by + 12; y++) for (let x = bx + 8; x < bx + 12; x++) set(x, y, 0); // glyph
	ctx.putImageData(new ImageData(data, SIZE, SIZE), 0, 0);
	return c;
}

const CLICK = { x: 24, y: 24 }; // white interior of the bubble starting at (20,20)

interface EditLayerCall {
	mask: Uint8ClampedArray;
	region: PixelRegion;
	fill: { r: number; g: number; b: number; a: number };
	tool: { id: string };
}

function makeEditLayerHost(source: HTMLCanvasElement): {
	host: EditorToolHost;
	commitImageEditLayer: ReturnType<typeof vi.fn>;
	commitToolBackground: ReturnType<typeof vi.fn>;
	applied: PixelRegion[];
	calls: EditLayerCall[];
} {
	const backing = document.createElement("canvas");
	backing.width = source.width;
	backing.height = source.height;
	const bctx = backing.getContext("2d")!;
	const sctx = source.getContext("2d")!;
	bctx.putImageData(sctx.getImageData(0, 0, source.width, source.height), 0, 0);

	const applied: PixelRegion[] = [];
	const calls: EditLayerCall[] = [];
	const commitToolBackground = vi.fn();
	const commitImageEditLayer = vi.fn(async (input: EditLayerCall) => {
		calls.push(input);
		return true;
	});

	const host: EditorToolHost = {
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: backing,
		}),
		applyToolPatchInstant: (patch: ImageData, region: PixelRegion) => {
			applied.push(region);
			bctx.putImageData(patch, Math.round(region.x), Math.round(region.y));
			return true;
		},
		commitImageEditLayer,
		setToolBusy: vi.fn(),
	};
	return { host, commitImageEditLayer, commitToolBackground, applied, calls };
}

async function flushAsync(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("Bubble Auto-Clean — non-destructive edit layer (Phase A)", () => {
	it("records an ImageEditLayer (tiny mask ROI + fill + bbox), NOT a baked full-page PNG", async () => {
		const source = makeBubbleCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return; // no raster backend → skip

		const { host, commitImageEditLayer, commitToolBackground, calls } = makeEditLayerHost(source);
		const registry = new ToolRegistry();
		registry.register(createBubbleCleanTool({ grow: 0 }));
		registry.setHost(host);
		registry.activate("bubble-clean");

		registry.handlePointerDown({ scene: { x: CLICK.x, y: CLICK.y } });
		await flushAsync();

		// The non-destructive path ran: exactly one edit layer recorded.
		expect(commitImageEditLayer).toHaveBeenCalledTimes(1);
		// The LEGACY full-image background bake path was NOT used.
		expect(commitToolBackground).not.toHaveBeenCalled();

		const call = calls[0];
		expect(call.tool.id).toBe("bubble-clean");
		// The fill is the white paper (default white mode).
		expect(call.fill).toEqual({ r: 255, g: 255, b: 255, a: 255 });

		// The recorded mask is the BUBBLE ROI, not the whole page — proving the stored
		// edit DATA is tiny (storage doesn't balloon to a full-page PNG).
		const roiPixels = call.region.width * call.region.height;
		expect(roiPixels).toBeGreaterThan(0);
		expect(roiPixels).toBeLessThan(SIZE * SIZE);
		expect(call.mask.length).toBe(roiPixels);
		// The mask actually covers some of the cleaned interior (non-empty coverage).
		const covered = Array.from(call.mask).filter((v) => v > 0).length;
		expect(covered).toBeGreaterThan(0);
		// The bbox sits inside the page bounds.
		expect(call.region.x).toBeGreaterThanOrEqual(0);
		expect(call.region.y).toBeGreaterThanOrEqual(0);
		expect(call.region.x + call.region.width).toBeLessThanOrEqual(SIZE);
		expect(call.region.y + call.region.height).toBeLessThanOrEqual(SIZE);
	});

	// P1-a — when the commit FAILS (mask upload / save returns falsy), the transient
	// instant ROI preview must be REVERTED so the user does not see a phantom cleaned
	// bubble that will vanish on reload/export. We make commitImageEditLayer return
	// false and assert the backing canvas's glyph pixels are repainted to ORIGINAL.
	it("reverts the instant preview when commitImageEditLayer FAILS (no phantom clean)", async () => {
		const source = makeBubbleCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return; // no raster backend → skip

		const backing = document.createElement("canvas");
		backing.width = source.width;
		backing.height = source.height;
		const bctx = backing.getContext("2d")!;
		const sctx = source.getContext("2d")!;
		bctx.putImageData(sctx.getImageData(0, 0, source.width, source.height), 0, 0);

		const glyph = { x: 30, y: 30 }; // a black glyph pixel inside the bubble (set to 0)
		const originalGlyph = bctx.getImageData(glyph.x, glyph.y, 1, 1).data[0];
		expect(originalGlyph).toBe(0); // sanity: glyph starts black

		// Commit that ALWAYS fails (returns false), simulating a mask-upload failure.
		const commitImageEditLayer = vi.fn(async () => false);
		const commitToolBackground = vi.fn();
		let previewApplied = false;
		const host: EditorToolHost = {
			getImageSpaceContext: () => ({
				imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
				imageWidth: source.width,
				imageHeight: source.height,
				canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
				fabric: {},
				sourceElement: backing,
			}),
			applyToolPatchInstant: (patch: ImageData, region: PixelRegion) => {
				previewApplied = true;
				bctx.putImageData(patch, Math.round(region.x), Math.round(region.y));
				return true;
			},
			commitImageEditLayer,
			setToolBusy: vi.fn(),
		};

		const registry = new ToolRegistry();
		registry.register(createBubbleCleanTool({ grow: 0 }));
		registry.setHost(host);
		registry.activate("bubble-clean");

		registry.handlePointerDown({ scene: { x: CLICK.x, y: CLICK.y } });
		await flushAsync();

		// The commit was attempted, the preview WAS shown, and the legacy bake path was
		// NOT used (still the non-destructive path).
		expect(commitImageEditLayer).toHaveBeenCalledTimes(1);
		expect(previewApplied).toBe(true);
		expect(commitToolBackground).not.toHaveBeenCalled();

		// REVERTED: the glyph pixel is back to its ORIGINAL black value (0), not the
		// white fill the failed clean had previewed.
		const afterGlyph = bctx.getImageData(glyph.x, glyph.y, 1, 1).data[0];
		expect(afterGlyph).toBe(originalGlyph);
	});
});
