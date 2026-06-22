import { describe, expect, it } from "vitest";
import {
	buildAiResultLayerGeometry,
	resultMatchesFullPage,
} from "$lib/project/ai-result-layer-geometry.ts";

describe("buildAiResultLayerGeometry (AI accept region-composite)", () => {
	it("places a full-page result back ONLY over its crop region", () => {
		// Page 800x1600. AI edited a 120x80 box at (10,20). The backend stored the
		// edit as a FULL-PAGE composite (800x1600). The placed layer must sit at
		// the region, sized to the region, and carry a sourceCrop = region so only
		// that sub-rect of the full-page result paints — never the whole page.
		const geo = buildAiResultLayerGeometry({ x: 10, y: 20, w: 120, h: 80 }, 800, 1600, 800, 1600);
		expect(geo).toEqual({
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			sourceCrop: { x: 10, y: 20, w: 120, h: 80 },
		});
	});

	it("does NOT replace the whole page: layer w/h is the region, not the page", () => {
		const geo = buildAiResultLayerGeometry({ x: 300, y: 500, w: 200, h: 150 }, 1000, 2000, 1000, 2000);
		expect(geo.w).toBe(200);
		expect(geo.h).toBe(150);
		expect(geo.x).toBe(300);
		expect(geo.y).toBe(500);
		expect(geo.sourceCrop).toEqual({ x: 300, y: 500, w: 200, h: 150 });
		// Sanity: the layer never spans the page.
		expect(geo.w).toBeLessThan(1000);
		expect(geo.h).toBeLessThan(2000);
	});

	it("omits sourceCrop for a region-sized (legacy) result so it draws whole", () => {
		// Legacy result image is exactly the crop size (120x80) — drawing the whole
		// image at the region is correct, so no crop is emitted.
		const geo = buildAiResultLayerGeometry({ x: 10, y: 20, w: 120, h: 80 }, 800, 1600, 120, 80);
		expect(geo.sourceCrop).toBeNull();
		expect(geo).toMatchObject({ x: 10, y: 20, w: 120, h: 80 });
	});

	it("clamps the placement+crop so a region near the edge stays on-page", () => {
		const geo = buildAiResultLayerGeometry({ x: 780, y: 1580, w: 100, h: 100 }, 800, 1600, 800, 1600);
		// region is clamped to fit: w/h kept, x/y pulled in so x+w<=page.
		expect(geo.x + geo.w).toBeLessThanOrEqual(800);
		expect(geo.y + geo.h).toBeLessThanOrEqual(1600);
		expect(geo.sourceCrop).not.toBeNull();
		expect(geo.sourceCrop!.x + geo.sourceCrop!.w).toBeLessThanOrEqual(800);
		expect(geo.sourceCrop!.y + geo.sourceCrop!.h).toBeLessThanOrEqual(1600);
	});

	it("does NOT crop a larger-than-region-but-NOT-full-page result (raw provider fallback)", () => {
		// Backend composite failed and stored the RAW provider output (e.g.
		// 1024x1024), which is bigger than the 120x80 region but is NOT the
		// 800x1600 page. Cropping it against page coords would drop/shift pixels —
		// so it must place as a plain region layer (draw whole, no crop).
		const geo = buildAiResultLayerGeometry({ x: 10, y: 20, w: 120, h: 80 }, 800, 1600, 1024, 1024);
		expect(geo.sourceCrop).toBeNull();
		expect(geo).toMatchObject({ x: 10, y: 20, w: 120, h: 80 });
	});

	it("crops a full-page result even when re-encode rounds the size slightly", () => {
		// PNG re-encode can shift dimensions by a pixel or two; tolerance keeps it
		// classified as a full-page composite (still crop).
		const geo = buildAiResultLayerGeometry({ x: 10, y: 20, w: 120, h: 80 }, 800, 1600, 801, 1599);
		expect(geo.sourceCrop).not.toBeNull();
		expect(geo.sourceCrop).toMatchObject({ x: 10, y: 20, w: 120, h: 80 });
	});

	it("treats unknown/region-sized dims as a plain layer (safe path)", () => {
		// When dims can't be measured, the caller passes region-sized dims so the
		// helper omits the crop — never squeezes a full page into the box.
		const geo = buildAiResultLayerGeometry({ x: 40, y: 60, w: 200, h: 140 }, 900, 1400, 200, 140);
		expect(geo.sourceCrop).toBeNull();
	});

	describe("resultMatchesFullPage", () => {
		it("matches exact page dims", () => {
			expect(resultMatchesFullPage(800, 1600, 800, 1600)).toBe(true);
		});
		it("matches within re-encode tolerance", () => {
			expect(resultMatchesFullPage(802, 1598, 800, 1600)).toBe(true);
		});
		it("rejects region-sized results", () => {
			expect(resultMatchesFullPage(120, 80, 800, 1600)).toBe(false);
		});
		it("rejects a non-page result that is larger than a region", () => {
			expect(resultMatchesFullPage(1024, 1024, 800, 1600)).toBe(false);
		});
		it("rejects non-positive dims", () => {
			expect(resultMatchesFullPage(0, 1600, 800, 1600)).toBe(false);
			expect(resultMatchesFullPage(800, 1600, 0, 1600)).toBe(false);
		});
	});
});
