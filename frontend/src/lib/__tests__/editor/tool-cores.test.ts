// W3.13 — pure tool-core unit tests: rasterise, magic wand flood-fill,
// colour range, morphology grow/contract/feather.

import { describe, it, expect } from "vitest";
import { rasterizeRect, rasterizePolygon, stampSoftBrush, compositeMasked } from "$lib/editor/tools/raster.ts";
import { floodFillSelection } from "$lib/editor/tools/magic-wand-tool.ts";
import { selectColorRange, rgbToHsl } from "$lib/editor/tools/color-range-tool.ts";
import { dilateMask, erodeMask, featherMask } from "$lib/editor/tools/morphology.ts";

function countNonZero(buf: Uint8ClampedArray): number {
	let n = 0;
	for (let i = 0; i < buf.length; i++) if (buf[i] > 0) n++;
	return n;
}

/** Build a solid-colour RGBA buffer, optionally painting a rectangle a 2nd colour. */
function makeImage(w: number, h: number, bg: [number, number, number], rect?: { x0: number; y0: number; x1: number; y1: number; color: [number, number, number] }) {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const o = i * 4;
		data[o] = bg[0];
		data[o + 1] = bg[1];
		data[o + 2] = bg[2];
		data[o + 3] = 255;
	}
	if (rect) {
		for (let y = rect.y0; y < rect.y1; y++) {
			for (let x = rect.x0; x < rect.x1; x++) {
				const o = (y * w + x) * 4;
				data[o] = rect.color[0];
				data[o + 1] = rect.color[1];
				data[o + 2] = rect.color[2];
			}
		}
	}
	return data;
}

describe("rasterizeRect (Marquee core)", () => {
	it("fills the integer rect and clips to image bounds", () => {
		const mask = rasterizeRect(2, 2, 4, 3, 10, 10);
		expect(countNonZero(mask)).toBe(4 * 3);
		expect(mask[2 * 10 + 2]).toBe(255);
		expect(mask[5 * 10 + 6]).toBe(0); // just outside
	});

	it("handles negative-direction drags (left/up)", () => {
		const a = rasterizeRect(6, 6, -4, -3, 10, 10);
		expect(countNonZero(a)).toBe(4 * 3);
		expect(a[3 * 10 + 2]).toBe(255);
	});

	it("clamps a rect that overruns the right/bottom edge", () => {
		const mask = rasterizeRect(8, 8, 5, 5, 10, 10);
		expect(countNonZero(mask)).toBe(2 * 2);
	});
});

describe("rasterizePolygon (Lasso / Polygon core)", () => {
	it("fills a triangle approximately by area", () => {
		// Right triangle covering ~half of a 20x20 region.
		const mask = rasterizePolygon([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }], 20, 20);
		const filled = countNonZero(mask);
		expect(filled).toBeGreaterThan(150); // ~200 = half of 400
		expect(filled).toBeLessThan(260);
		expect(mask[0]).toBe(255); // top-left corner inside
		expect(mask[19 * 20 + 19]).toBe(0); // bottom-right corner outside
	});

	it("returns empty for degenerate (<3 pts) input", () => {
		expect(countNonZero(rasterizePolygon([{ x: 0, y: 0 }], 8, 8))).toBe(0);
	});
});

describe("floodFillSelection (Magic Wand core)", () => {
	it("selects a uniform region and respects tolerance boundaries", () => {
		// White bg with a black square 4..12.
		const img = makeImage(16, 16, [255, 255, 255], { x0: 4, y0: 4, x1: 12, y1: 12, color: [0, 0, 0] });
		// Click inside the black square with tight tolerance => selects 8x8.
		const inside = floodFillSelection(img, 16, 16, 6, 6, 4);
		expect(countNonZero(inside)).toBe(8 * 8);
		expect(inside[6 * 16 + 6]).toBe(255);
		expect(inside[0]).toBe(0); // white bg not selected
	});

	it("selects the surrounding region when clicking the background", () => {
		const img = makeImage(16, 16, [255, 255, 255], { x0: 4, y0: 4, x1: 12, y1: 12, color: [0, 0, 0] });
		const outside = floodFillSelection(img, 16, 16, 0, 0, 8);
		// 256 total - 64 black square = 192 white pixels.
		expect(countNonZero(outside)).toBe(256 - 64);
	});

	it("returns empty for an out-of-bounds click", () => {
		const img = makeImage(8, 8, [0, 0, 0]);
		expect(countNonZero(floodFillSelection(img, 8, 8, -1, 99, 10))).toBe(0);
	});

	it("clamps threshold into 0..64", () => {
		const img = makeImage(8, 8, [128, 128, 128]);
		// Huge tolerance selects everything; uniform image => all pixels.
		expect(countNonZero(floodFillSelection(img, 8, 8, 0, 0, 9999))).toBe(64);
	});
});

describe("selectColorRange (Color Range core)", () => {
	it("rgbToHsl converts primaries correctly", () => {
		expect(rgbToHsl(255, 0, 0).h).toBeCloseTo(0, 1);
		expect(Math.round(rgbToHsl(0, 255, 0).h)).toBe(120);
		expect(Math.round(rgbToHsl(0, 0, 255).h)).toBe(240);
		expect(rgbToHsl(255, 255, 255).l).toBeCloseTo(1, 2);
	});

	it("one click on a near-white bubble selects the whole near-white region", () => {
		// Near-white bubble interior (250) inside a dark page (20).
		const img = makeImage(20, 20, [20, 20, 20], { x0: 3, y0: 3, x1: 15, y1: 15, color: [250, 250, 250] });
		const sel = selectColorRange(img, 20, 20, 8, 8);
		expect(countNonZero(sel)).toBe(12 * 12);
		expect(sel[8 * 20 + 8]).toBe(255);
		expect(sel[0]).toBe(0); // dark page not selected
	});

	it("does not select strongly different colours", () => {
		const img = makeImage(8, 8, [255, 0, 0]); // pure red
		const sel = selectColorRange(img, 8, 8, 0, 0, { hue: 5, saturation: 0.05, lightness: 0.05 });
		expect(countNonZero(sel)).toBe(64); // uniform red all in range
		const img2 = makeImage(8, 8, [255, 0, 0], { x0: 0, y0: 0, x1: 4, y1: 8, color: [0, 0, 255] });
		const sel2 = selectColorRange(img2, 8, 8, 7, 0, { hue: 5, saturation: 0.05, lightness: 0.05 });
		expect(countNonZero(sel2)).toBe(4 * 8); // only the red half
	});
});

describe("morphology grow/contract/feather", () => {
	function centerDot(w: number, h: number, cx: number, cy: number) {
		const m = new Uint8ClampedArray(w * h);
		m[cy * w + cx] = 255;
		return m;
	}

	it("dilate (grow) expands a single pixel by radius", () => {
		const grown = dilateMask(centerDot(11, 11, 5, 5), 11, 11, 2);
		// 5x5 square (radius 2 chebyshev) => 25 pixels.
		expect(countNonZero(grown)).toBe(25);
		expect(grown[5 * 11 + 5]).toBe(255);
		expect(grown[3 * 11 + 3]).toBe(255);
		expect(grown[2 * 11 + 2]).toBe(0);
	});

	it("erode (contract) shrinks a filled region", () => {
		const w = 11;
		const filled = new Uint8ClampedArray(w * w);
		for (let y = 3; y < 8; y++) for (let x = 3; x < 8; x++) filled[y * w + x] = 255; // 5x5
		const shrunk = erodeMask(filled, w, w, 1);
		expect(countNonZero(shrunk)).toBe(3 * 3); // 5x5 eroded by 1 => 3x3
	});

	it("grow then contract round-trips a clean square back to itself", () => {
		const w = 13;
		const sq = new Uint8ClampedArray(w * w);
		for (let y = 4; y < 9; y++) for (let x = 4; x < 9; x++) sq[y * w + x] = 255;
		const grown = dilateMask(sq, w, w, 2);
		const back = erodeMask(grown, w, w, 2);
		expect(countNonZero(back)).toBe(countNonZero(sq));
	});

	it("feather softens edges to intermediate alpha", () => {
		const w = 9;
		const sq = new Uint8ClampedArray(w * w);
		for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) sq[y * w + x] = 255;
		const soft = featherMask(sq, w, w, 1);
		// Edge-adjacent pixel that was 0 should pick up partial alpha.
		const edge = soft[1 * w + 4];
		expect(edge).toBeGreaterThan(0);
		expect(edge).toBeLessThan(255);
	});
});

describe("compositeMasked + stampSoftBrush (paint cores)", () => {
	it("blends a patch into a base via mask alpha", () => {
		const base = new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]), 2, 1);
		const patch = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
		const mask = new Uint8ClampedArray([255, 0]);
		const out = compositeMasked(base, patch, mask);
		expect([...out.data.slice(0, 3)]).toEqual([255, 255, 255]); // fully replaced
		expect([...out.data.slice(4, 7)]).toEqual([0, 0, 0]); // untouched
	});

	it("soft brush stamps a falloff disc", () => {
		const mask = new Uint8ClampedArray(21 * 21);
		stampSoftBrush(mask, 21, 21, 10, 10, 5, 0.5, 255);
		expect(mask[10 * 21 + 10]).toBe(255); // center hard
		expect(mask[10 * 21 + 0]).toBe(0); // outside radius
		const edge = mask[10 * 21 + 14]; // ~4px from center, inside falloff
		expect(edge).toBeGreaterThan(0);
		expect(edge).toBeLessThan(255);
	});
});
