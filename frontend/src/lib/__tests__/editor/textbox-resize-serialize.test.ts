// Regression test for P1 data-fidelity bug: a text layer's box width must be
// serialized from the LIVE Fabric textbox after a handle resize, not from the stale
// cached `_textLayerBoxWidth`. See editor.ts `resolveTextBoxCanvasDimensions` /
// `serializeTextObject`.

import { describe, it, expect } from "vitest";
import { resolveTextBoxCanvasDimensions } from "$lib/canvas/editor.ts";

describe("resolveTextBoxCanvasDimensions", () => {
	it("uses the LIVE width after a Textbox side-handle resize (scaleX reset to 1)", () => {
		// Loaded at box width 200, cached seeded to 200. User drags the right handle:
		// Fabric Textbox writes the new extent into `width` (300) and resets scaleX to 1,
		// but the cached field stays at the stale 200.
		const { width } = resolveTextBoxCanvasDimensions({
			liveWidth: 300,
			scaleX: 1,
			scaleY: 1,
			cachedBoxWidth: 200, // stale
			cachedBoxHeight: 80,
			fallbackBoxWidth: 200,
			fallbackBoxHeight: 80,
		});
		// Must reflect the resize, NOT snap back to the cached 200.
		expect(width).toBe(300);
	});

	it("applies scaleX to the live width for a corner-handle scale resize", () => {
		const { width } = resolveTextBoxCanvasDimensions({
			liveWidth: 200,
			scaleX: 1.5,
			scaleY: 1.5,
			cachedBoxWidth: 200,
			cachedBoxHeight: 80,
			fallbackBoxWidth: 200,
			fallbackBoxHeight: 80,
		});
		expect(width).toBe(300);
	});

	it("scales the cached height by scaleY (height stays cached-first, not live)", () => {
		const { height } = resolveTextBoxCanvasDimensions({
			liveWidth: 200,
			scaleX: 1,
			scaleY: 2,
			cachedBoxWidth: 200,
			cachedBoxHeight: 80,
			// A Fabric Textbox auto-measures height; a drifted live height must be ignored.
			fallbackBoxWidth: 200,
			fallbackBoxHeight: 80,
		});
		expect(height).toBe(160);
	});

	it("falls back to cached width when live width is non-finite or <= 0", () => {
		for (const bad of [NaN, 0, -10, undefined, null, "x"]) {
			const { width } = resolveTextBoxCanvasDimensions({
				liveWidth: bad,
				scaleX: 1,
				scaleY: 1,
				cachedBoxWidth: 200,
				cachedBoxHeight: 80,
				fallbackBoxWidth: 999,
				fallbackBoxHeight: 80,
			});
			expect(width).toBe(200);
		}
	});

	it("falls back to the data-derived box when both live and cached are unusable", () => {
		const { width, height } = resolveTextBoxCanvasDimensions({
			liveWidth: NaN,
			scaleX: 1,
			scaleY: 1,
			cachedBoxWidth: 0,
			cachedBoxHeight: NaN,
			fallbackBoxWidth: 150,
			fallbackBoxHeight: 70,
		});
		expect(width).toBe(150);
		expect(height).toBe(70);
	});

	it("treats a non-finite / zero scale as 1", () => {
		const { width, height } = resolveTextBoxCanvasDimensions({
			liveWidth: 120,
			scaleX: NaN,
			scaleY: 0,
			cachedBoxWidth: 120,
			cachedBoxHeight: 60,
			fallbackBoxWidth: 120,
			fallbackBoxHeight: 60,
		});
		expect(width).toBe(120);
		expect(height).toBe(60);
	});
});

describe("textbox resize → save → reload round-trip", () => {
	// Mirrors editor.ts conversions: load seeds width = imageWToCanvasW(layer.w) with
	// scaleX=1 and caches it; serialize reads live width and converts back via
	// canvasWToImageW. With imageBounds == image size the canvas/image spaces coincide,
	// isolating the stale-cache bug.
	const imageW = 1000;
	const boundsW = 1000;
	const imageWToCanvasW = (w: number) => (w / imageW) * boundsW;
	const canvasWToImageW = (w: number) => Math.round((w * imageW) / boundsW);

	it("preserves an interactively resized box width across reload", () => {
		const savedW = 240;

		// --- load ---
		const cachedBoxWidth = imageWToCanvasW(savedW); // 240, scaleX reset to 1
		let liveWidth = cachedBoxWidth;
		let scaleX = 1;

		// --- user drags the side handle: Fabric updates live width, scaleX stays 1,
		//     cached stays stale ---
		liveWidth = 360;

		// --- serialize (the fix path) ---
		const { width: serializedCanvasW } = resolveTextBoxCanvasDimensions({
			liveWidth,
			scaleX,
			scaleY: 1,
			cachedBoxWidth, // stale 240
			cachedBoxHeight: 80,
			fallbackBoxWidth: imageWToCanvasW(savedW),
			fallbackBoxHeight: 80,
		});
		const reloadedW = canvasWToImageW(serializedCanvasW);

		// --- reload: positionTextObjectFromLayer sets width = imageWToCanvasW(reloadedW) ---
		const reloadedCanvasW = imageWToCanvasW(reloadedW);

		expect(reloadedW).toBe(360);
		expect(reloadedCanvasW).toBe(360);

		// Prove the OLD (buggy) behavior would have snapped back to the original 240.
		const buggyW = canvasWToImageW(cachedBoxWidth * scaleX);
		expect(buggyW).toBe(savedW);
		expect(buggyW).not.toBe(reloadedW);
	});

	it("does not regress a freshly-added, non-resized box width", () => {
		const savedW = 180;
		const cachedBoxWidth = imageWToCanvasW(savedW);
		const liveWidth = cachedBoxWidth; // no resize → live == cached

		const { width } = resolveTextBoxCanvasDimensions({
			liveWidth,
			scaleX: 1,
			scaleY: 1,
			cachedBoxWidth,
			cachedBoxHeight: 80,
			fallbackBoxWidth: cachedBoxWidth,
			fallbackBoxHeight: 80,
		});
		expect(canvasWToImageW(width)).toBe(savedW);
	});
});
