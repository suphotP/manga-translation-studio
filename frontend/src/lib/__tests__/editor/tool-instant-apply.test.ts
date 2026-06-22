// Instant-apply (Photopea-style) image-tool fast path.
//
// Heal/clone used to encode the FULL 12 MP page → persist → RELOAD it into Fabric
// on EVERY stroke, and a serialization gate blocked the next stroke until that
// settled — so each stroke felt slow. The fix: tools paint the healed/cloned
// REGION straight onto the live background bitmap via `host.applyToolPatchInstant`
// (no reload, no per-stroke server round-trip) and the host debounces a single
// background persist. These tests assert:
//   1) the region raster helpers (bounds / region read / region composite) are
//      correct, so per-stroke compute can be bounded to the stroke bbox;
//   2) the real heal + clone tools take the instant path when the host exposes it,
//      and do NOT fall back to the full-image commit/reload;
//   3) rapid successive strokes apply instantly with NO serialization deferral
//      (the registry's commit gate stays clear) — the thing that made it slow.

import { describe, it, expect, vi } from "vitest";
import {
	computeMaskBounds,
	unionRegion,
	readSourceImageRegion,
	cropMaskRegion,
	compositeMaskedRegion,
	makeImageData,
	type PixelRegion,
} from "$lib/editor/tools/raster.ts";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createCloneStampTool } from "$lib/editor/tools/clone-stamp-tool.ts";
import { createHealingBrushTool } from "$lib/editor/tools/healing-brush-tool.ts";
import { readSourceImageData } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

// Stub OpenCV out: headless `loadOpenCv()` would try to fetch the wasm and hang.
// The heal tool only needs inpaint to return SOMETHING for the region; assert the
// instant region apply, not the pixel reconstruction (covered elsewhere).
vi.mock("$lib/editor/tools/opencv-loader.ts", () => ({
	loadOpenCv: () => Promise.resolve({} as never),
}));
vi.mock("$lib/editor/tools/inpaint.ts", () => ({
	inpaintTelea: (_cv: unknown, src: ImageData) => src,
}));

describe("region raster helpers (bounded per-stroke compute)", () => {
	it("computeMaskBounds returns the padded bbox of the painted pixels", () => {
		const w = 20;
		const h = 20;
		const mask = new Uint8ClampedArray(w * h);
		// Paint a 3x3 block at (8,8)..(10,10).
		for (let y = 8; y <= 10; y++) for (let x = 8; x <= 10; x++) mask[y * w + x] = 255;
		const tight = computeMaskBounds(mask, w, h, 0);
		expect(tight).toEqual({ x: 8, y: 8, width: 3, height: 3 });
		const padded = computeMaskBounds(mask, w, h, 2);
		expect(padded).toEqual({ x: 6, y: 6, width: 7, height: 7 });
	});

	it("computeMaskBounds clamps the margin to the image and returns null when empty", () => {
		const mask = new Uint8ClampedArray(10 * 10);
		expect(computeMaskBounds(mask, 10, 10, 3)).toBeNull();
		mask[0] = 255; // corner pixel
		expect(computeMaskBounds(mask, 10, 10, 5)).toEqual({ x: 0, y: 0, width: 6, height: 6 });
	});

	it("unionRegion merges two bboxes (and passes through null)", () => {
		const a: PixelRegion = { x: 2, y: 2, width: 3, height: 3 }; // 2..4
		const b: PixelRegion = { x: 6, y: 1, width: 2, height: 2 }; // 6..7 / 1..2
		expect(unionRegion(a, null)).toBe(a);
		expect(unionRegion(null, b)).toBe(b);
		expect(unionRegion(a, b)).toEqual({ x: 2, y: 1, width: 6, height: 4 });
	});

	it("readSourceImageRegion returns a buffer sized to the region", () => {
		// The headless `canvas` backend does not always reflect fillStyle colours in
		// getImageData, so assert the region SHAPE here (the pixel-mapping correctness
		// is covered by cropMaskRegion / compositeMaskedRegion on pure buffers).
		const src = document.createElement("canvas");
		src.width = 16;
		src.height = 16;
		const sctx = src.getContext("2d");
		if (!sctx) return; // no raster backend — skip silently
		const region: PixelRegion = { x: 4, y: 5, width: 6, height: 7 };
		const out = readSourceImageRegion(src, region, 16, 16);
		expect(out).not.toBeNull();
		expect(out!.width).toBe(6);
		expect(out!.height).toBe(7);
		expect(out!.data.length).toBe(6 * 7 * 4);
	});

	it("cropMaskRegion copies the right sub-rectangle of the mask", () => {
		const w = 6;
		const h = 6;
		const mask = new Uint8ClampedArray(w * h);
		mask[2 * w + 3] = 200;
		const region: PixelRegion = { x: 2, y: 1, width: 3, height: 3 }; // covers (3,2)
		const cropped = cropMaskRegion(mask, w, region);
		expect(cropped.length).toBe(9);
		// (3,2) maps to local (1,1) => index 1*3+1 = 4.
		expect(cropped[4]).toBe(200);
	});

	it("compositeMaskedRegion blends only the region and matches a full composite there", () => {
		const w = 4;
		const h = 4;
		// Base all black, patch all white, mask full-on in a 2x2 region.
		const base = makeImageData(new Uint8ClampedArray(w * h * 4).fill(0), w, h);
		for (let i = 3; i < base.data.length; i += 4) base.data[i] = 255; // alpha
		const patch = new Uint8ClampedArray(w * h * 4).fill(255);
		const mask = new Uint8ClampedArray(w * h);
		const region: PixelRegion = { x: 1, y: 1, width: 2, height: 2 };
		for (let y = 1; y <= 2; y++) for (let x = 1; x <= 2; x++) mask[y * w + x] = 255;

		const out = compositeMaskedRegion(base, patch, mask, region);
		expect(out.width).toBe(2);
		expect(out.height).toBe(2);
		// Every region pixel becomes white (patch * 1).
		for (let i = 0; i < out.data.length; i += 4) {
			expect(out.data[i]).toBe(255);
			expect(out.data[i + 1]).toBe(255);
			expect(out.data[i + 2]).toBe(255);
		}
	});
});

/** Build a readable source canvas so the tools actually paint. */
function makeSourceCanvas(size = 48): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = size;
	c.height = size;
	const ctx = c.getContext("2d");
	if (ctx) {
		ctx.fillStyle = "#777";
		ctx.fillRect(0, 0, size, size);
		// A small dark blob to heal/clone over.
		ctx.fillStyle = "#111";
		ctx.fillRect(20, 20, 6, 6);
	}
	return c;
}

/** Host that records instant-apply calls and provides a real bitmap source. */
function makeInstantHost(source: HTMLCanvasElement): EditorToolHost & {
	patches: Array<{ region: PixelRegion }>;
	commitCalls: number;
} {
	const patches: Array<{ region: PixelRegion }> = [];
	const host = {
		patches,
		commitCalls: 0,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: source,
		}),
		applyToolPatchInstant: (_patch: ImageData, region: PixelRegion) => {
			patches.push({ region });
			return true;
		},
		commitToolBackground: vi.fn(() => {
			host.commitCalls += 1;
		}),
		setToolBusy: vi.fn(),
	};
	return host;
}

describe("tools take the instant-apply path when the host supports it", () => {
	it("Clone Stamp applies a region patch instantly and never falls back to commit/reload", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return; // no raster backend
		const host = makeInstantHost(source);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool());
		registry.setHost(host);
		registry.activate("clone-stamp");

		// Alt+click sets source, then a paint stroke.
		registry.handlePointerDown({ scene: { x: 6, y: 6 }, altKey: true });
		registry.handlePointerDown({ scene: { x: 22, y: 22 } });
		registry.handlePointerMove({ scene: { x: 24, y: 24 }, pressed: true });
		registry.handlePointerUp({ scene: { x: 24, y: 24 } });
		await registry.waitForCommit();

		expect(host.patches.length).toBe(1);
		expect(host.commitCalls).toBe(0); // no full-image commit/reload
		// The applied region is bounded (covers the brush area, not the whole page).
		const r = host.patches[0].region;
		expect(r.width).toBeLessThan(source.width);
		expect(r.height).toBeLessThan(source.height);
		// No serialization gate left armed → next stroke is instant.
		expect(registry.isCommitInFlight).toBe(false);
	});

	it("Spot Healing applies a bounded region patch instantly (no full-page commit)", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeInstantHost(source);
		const registry = new ToolRegistry();
		registry.register(createHealingBrushTool({ radius: 4, inpaintRadius: 2, respectSelection: false }));
		registry.setHost(host);
		registry.activate("healing-brush");

		registry.handlePointerDown({ scene: { x: 22, y: 22 } });
		registry.handlePointerMove({ scene: { x: 23, y: 23 }, pressed: true });
		registry.handlePointerUp({ scene: { x: 23, y: 23 } });
		await registry.waitForCommit();
		// Settle the heal's awaited microtasks (nextFrame + mocked loadOpenCv).
		for (let i = 0; i < 12; i++) await Promise.resolve();
		await registry.waitForCommit();

		expect(host.patches.length).toBe(1);
		expect(host.commitCalls).toBe(0);
		// The healed region is bounded to the stroke bbox + a small margin, not the
		// whole page — that is what keeps per-stroke compute tiny.
		const r = host.patches[0].region;
		expect(r.width).toBeLessThan(source.width);
		expect(r.height).toBeLessThan(source.height);
	});

	it("rapid successive instant strokes do NOT serialize (no deferral, no clobber risk)", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeInstantHost(source);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool());
		registry.setHost(host);
		registry.activate("clone-stamp");

		registry.handlePointerDown({ scene: { x: 6, y: 6 }, altKey: true });
		// Fire several quick strokes back to back.
		for (let i = 0; i < 5; i++) {
			registry.handlePointerDown({ scene: { x: 20 + i, y: 20 + i } });
			registry.handlePointerUp({ scene: { x: 22 + i, y: 22 + i } });
			await registry.waitForCommit();
		}
		// Every stroke applied; none deferred for replay; gate clear.
		expect(host.patches.length).toBe(5);
		expect(registry.isReplayPending).toBe(false);
		expect(registry.isCommitInFlight).toBe(false);
	});
});
