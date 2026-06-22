// W3.13 flagship — Bubble Auto-Clean core unit tests.
//
// Synthetic page: a white bubble interior, a black ring outline, and black
// "text" glyphs inside the interior. After bubble-clean from a point INSIDE the
// bubble:
//   - the interior (incl. where the text was) is all white,
//   - the black ring stays intact (not bled past),
// and a point OUTSIDE the bubble does NOT flood the whole page.

import { describe, it, expect } from "vitest";
import {
	bubbleFillMask,
	sampleInteriorPaper,
	paintFillRegion,
} from "$lib/editor/tools/bubble-clean-tool.ts";
import { computeMaskBounds, makeImageData } from "$lib/editor/tools/raster.ts";

const W = 64;
const H = 64;
const CX = 32;
const CY = 32;
const R_OUTER = 22; // ring outer radius
const RING = 2; // ring thickness (px)

/**
 * Build a synthetic manga bubble: white page-ish dark border? No — keep the page
 * background mid/dark so a flood from OUTSIDE the bubble is bounded by the page
 * not being uniformly light. We use:
 *   - page background: dark grey (40) so it is "edge"/non-interior,
 *   - bubble interior: white (255),
 *   - bubble ring: black (0),
 *   - text glyphs inside: black (0).
 */
function makeBubble(): { data: Uint8ClampedArray } {
	const data = new Uint8ClampedArray(W * H * 4);
	const set = (x: number, y: number, v: number) => {
		const o = (y * W + x) * 4;
		data[o] = v;
		data[o + 1] = v;
		data[o + 2] = v;
		data[o + 3] = 255;
	};
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const d = Math.hypot(x - CX, y - CY);
			if (d <= R_OUTER - RING) {
				set(x, y, 255); // interior (white paper)
			} else if (d <= R_OUTER) {
				set(x, y, 0); // ring outline (black)
			} else {
				set(x, y, 40); // dark page background
			}
		}
	}
	// Paint two black "text" glyphs inside the interior (small filled squares).
	for (let y = 28; y < 33; y++) for (let x = 24; x < 29; x++) set(x, y, 0);
	for (let y = 30; y < 35; y++) for (let x = 36; x < 41; x++) set(x, y, 0);
	return { data };
}

const OPTS = { edgeThreshold: 140, grow: 0, maxAreaFraction: 0.6 };

function isWhite(data: Uint8ClampedArray, x: number, y: number): boolean {
	const o = (y * W + x) * 4;
	return data[o] === 255 && data[o + 1] === 255 && data[o + 2] === 255;
}

function isBlack(data: Uint8ClampedArray, x: number, y: number): boolean {
	const o = (y * W + x) * 4;
	return data[o] === 0 && data[o + 1] === 0 && data[o + 2] === 0;
}

describe("bubbleFillMask (Bubble Auto-Clean core)", () => {
	it("fills the bubble interior INCLUDING the text glyphs, bounded by the ring", () => {
		const img = makeBubble();
		const mask = bubbleFillMask(img.data, W, H, CX, CY, OPTS);
		expect(mask).not.toBeNull();
		const m = mask!;
		// Interior centre is masked.
		expect(m[CY * W + CX]).toBe(255);
		// The text glyph pixels (black, inside the interior) are masked too — the
		// enclosed-hole fill swallowed them so they will be cleaned.
		expect(m[30 * W + 26]).toBe(255); // first glyph centre
		expect(m[32 * W + 38]).toBe(255); // second glyph centre
		// The ring (black outline) is NOT masked — the fill stopped at it.
		// Sample a ring pixel on the +x axis.
		const ringX = CX + (R_OUTER - 1);
		expect(m[CY * W + ringX]).toBe(0);
		// A dark page pixel well outside the bubble is NOT masked.
		expect(m[2 * W + 2]).toBe(0);
	});

	it("painting the masked region to white erases the text and keeps the ring", () => {
		const img = makeBubble();
		const mask = bubbleFillMask(img.data, W, H, CX, CY, OPTS)!;
		const region = computeMaskBounds(mask, W, H, 1)!;
		const base = makeImageData(new Uint8ClampedArray(img.data), W, H);
		const patch = paintFillRegion(base, mask, region, [255, 255, 255]);
		// Composite the region patch back into a full copy to assert on absolute coords.
		const out = new Uint8ClampedArray(img.data);
		for (let y = 0; y < region.height; y++) {
			for (let x = 0; x < region.width; x++) {
				const so = (y * region.width + x) * 4;
				const dest = ((region.y + y) * W + (region.x + x)) * 4;
				out[dest] = patch.data[so];
				out[dest + 1] = patch.data[so + 1];
				out[dest + 2] = patch.data[so + 2];
				out[dest + 3] = patch.data[so + 3];
			}
		}
		// Text glyph centres are now white (erased).
		expect(isWhite(out, 26, 30)).toBe(true);
		expect(isWhite(out, 38, 32)).toBe(true);
		// Interior is white.
		expect(isWhite(out, CX, CY)).toBe(true);
		// The ring is still black (outline intact, no bleed).
		expect(isBlack(out, CX + (R_OUTER - 1), CY)).toBe(true);
		// The dark page background outside the bubble is untouched (not white).
		expect(isWhite(out, 2, 2)).toBe(false);
	});

	it("a click OUTSIDE the bubble does not flood the whole page", () => {
		const img = makeBubble();
		// Click on the dark page background. It is below the edge threshold, so the
		// fill refuses to start (no interior region) → null, never a page-wide flood.
		const mask = bubbleFillMask(img.data, W, H, 2, 2, OPTS);
		expect(mask).toBeNull();
	});

	it("aborts (returns null) when the region would exceed the area cap (open outline)", () => {
		// An all-white page: a flood from anywhere would cover everything, which is
		// exactly the 'leaked past an open outline' case the cap guards against.
		const white = new Uint8ClampedArray(W * H * 4).fill(255);
		const mask = bubbleFillMask(white, W, H, CX, CY, { ...OPTS, maxAreaFraction: 0.2 });
		expect(mask).toBeNull();
	});

	it("returns null for a click on the outline / out of bounds", () => {
		const img = makeBubble();
		// On the black ring.
		expect(bubbleFillMask(img.data, W, H, CX + (R_OUTER - 1), CY, OPTS)).toBeNull();
		// Out of bounds.
		expect(bubbleFillMask(img.data, W, H, -1, 999, OPTS)).toBeNull();
	});

	it("grow expands the mask to hug the outline (kills the 1px halo)", () => {
		const img = makeBubble();
		const tight = bubbleFillMask(img.data, W, H, CX, CY, { ...OPTS, grow: 0 })!;
		const grown = bubbleFillMask(img.data, W, H, CX, CY, { ...OPTS, grow: 2 })!;
		const count = (m: Uint8ClampedArray) => m.reduce((n, v) => n + (v ? 1 : 0), 0);
		expect(count(grown)).toBeGreaterThan(count(tight));
	});
});

describe("sampleInteriorPaper", () => {
	it("samples white when the interior paper is white", () => {
		const img = makeBubble();
		const mask = bubbleFillMask(img.data, W, H, CX, CY, OPTS)!;
		const [r, g, b] = sampleInteriorPaper(img.data, mask, W, H, OPTS.edgeThreshold);
		expect(r).toBe(255);
		expect(g).toBe(255);
		expect(b).toBe(255);
	});

	it("samples the dominant light tone, ignoring the dark text pixels in the mask", () => {
		// Interior of a light cream (245); text stays black inside.
		const data = new Uint8ClampedArray(W * H * 4);
		const set = (x: number, y: number, v: [number, number, number]) => {
			const o = (y * W + x) * 4;
			data[o] = v[0];
			data[o + 1] = v[1];
			data[o + 2] = v[2];
			data[o + 3] = 255;
		};
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const d = Math.hypot(x - CX, y - CY);
				if (d <= R_OUTER - RING) set(x, y, [245, 240, 230]);
				else if (d <= R_OUTER) set(x, y, [0, 0, 0]);
				else set(x, y, [40, 40, 40]);
			}
		}
		for (let y = 28; y < 33; y++) for (let x = 24; x < 29; x++) set(x, y, [0, 0, 0]);
		const mask = bubbleFillMask(data, W, H, CX, CY, OPTS)!;
		const [r, g, b] = sampleInteriorPaper(data, mask, W, H, OPTS.edgeThreshold);
		// Close to the cream, not pulled toward black by the masked text.
		expect(r).toBeGreaterThan(235);
		expect(g).toBeGreaterThan(230);
		expect(b).toBeGreaterThan(220);
	});
});
