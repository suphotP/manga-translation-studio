import { describe, expect, it } from "vitest";
import {
	centeredPageForScroll,
	computeOffsets,
	computeStripWindow,
	estimatePageHeight,
	focusedPageForScroll,
	stripScrollOffsetForIndex,
	DEFAULT_STRIP_OVERSCAN,
} from "$lib/project/strip-virtualization.ts";

describe("strip-virtualization", () => {
	describe("computeOffsets", () => {
		it("accumulates heights plus inter-page gaps", () => {
			expect(computeOffsets([100, 200, 50], 16)).toEqual([0, 116, 332]);
		});

		it("treats non-positive heights as 1px so offsets stay monotonic", () => {
			expect(computeOffsets([0, -5, 10], 0)).toEqual([0, 1, 2]);
		});

		it("returns an empty array for no pages", () => {
			expect(computeOffsets([], 16)).toEqual([]);
		});
	});

	describe("estimatePageHeight", () => {
		it("scales the column width by the aspect ratio", () => {
			expect(estimatePageHeight(800, 1.5)).toBe(1200);
		});

		it("falls back to a default ratio and guards bad input", () => {
			expect(estimatePageHeight(0)).toBeGreaterThan(0);
			expect(estimatePageHeight(-10, -1)).toBeGreaterThan(0);
		});
	});

	describe("computeStripWindow", () => {
		const heights = Array.from({ length: 1000 }, () => 1000); // 1000 tall pages

		it("renders only a small window near the viewport for a 1000-page chapter", () => {
			const w = computeStripWindow({
				pageHeights: heights,
				scrollTop: 0,
				viewportHeight: 800,
				overscan: 2,
				gap: 16,
			});
			// At top: page 0, maybe a sliver of page 1, + overscan. Nowhere near 1000.
			expect(w.startIndex).toBe(0);
			expect(w.renderCount).toBeLessThan(10);
			expect(w.endIndex).toBeLessThan(10);
			// Total height covers all 1000 pages + 999 gaps so the scrollbar is honest.
			expect(w.totalHeight).toBe(1000 * 1000 + 999 * 16);
			expect(w.offsets.length).toBe(1000);
		});

		it("windows around a deep scroll position (jump to page ~500)", () => {
			const rowStride = 1000 + 16;
			const w = computeStripWindow({
				pageHeights: heights,
				scrollTop: 500 * rowStride,
				viewportHeight: 800,
				overscan: 2,
				gap: 16,
			});
			expect(w.startIndex).toBeGreaterThanOrEqual(498);
			expect(w.startIndex).toBeLessThanOrEqual(500);
			expect(w.endIndex).toBeLessThanOrEqual(503);
			// Far-away pages 0 and 999 are NOT in the render window.
			expect(w.startIndex).toBeGreaterThan(0);
			expect(w.endIndex).toBeLessThan(999);
		});

		it("handles variable-height pages (binary search by cumulative offset)", () => {
			// page 0: 100, page 1: 500, page 2: 100, page 3: 900
			const vh = [100, 500, 100, 900];
			const w = computeStripWindow({
				pageHeights: vh,
				// scroll so the viewport sits inside page 3 (offset = 100+10+500+10+100+10 = 730)
				scrollTop: 740,
				viewportHeight: 200,
				overscan: 0,
				gap: 10,
			});
			expect(w.offsets).toEqual([0, 110, 620, 730]);
			expect(w.startIndex).toBe(3);
			expect(w.endIndex).toBe(3);
			expect(w.totalHeight).toBe(730 + 900);
		});

		it("returns an empty window for no pages", () => {
			const w = computeStripWindow({ pageHeights: [], scrollTop: 0, viewportHeight: 800 });
			expect(w.startIndex).toBe(0);
			expect(w.endIndex).toBe(-1);
			expect(w.renderCount).toBe(0);
			expect(w.totalHeight).toBe(0);
		});

		it("uses a perf-tuned default overscan of 1 (fewer concurrent image decodes)", () => {
			// The default overscan was lowered from 2 → 1 so the heavy-real-manga strip
			// keeps fewer previews decoded at once. Guard the value so it isn't silently
			// raised back (which re-introduces the scroll-jank this fix addressed).
			expect(DEFAULT_STRIP_OVERSCAN).toBe(1);
		});

		it("the default overscan mounts fewer pages than the old overscan of 2", () => {
			// Same scroll position, only overscan differs: the perf-tuned default (1)
			// must render a strictly NARROWER window than the old value (2), i.e. two
			// fewer pages (one fewer each side). This is the fix that keeps fewer heavy
			// previews decoded at once during a scroll.
			const heights = Array.from({ length: 20 }, () => 1000);
			const at = { pageHeights: heights, scrollTop: 6000, viewportHeight: 500, gap: 16 };
			const def = computeStripWindow({ ...at, overscan: DEFAULT_STRIP_OVERSCAN });
			const old = computeStripWindow({ ...at, overscan: 2 });
			expect(def.renderCount).toBeLessThan(old.renderCount);
			expect(old.renderCount - def.renderCount).toBe(2); // one fewer page each side
		});
	});

	describe("stripScrollOffsetForIndex", () => {
		const heights = Array.from({ length: 100 }, () => 500);
		const offsets = computeOffsets(heights, 16);
		const totalHeight = offsets[99] + 500;

		it("jumps to a page's top offset minus margin", () => {
			const target = stripScrollOffsetForIndex(17, { offsets, totalHeight, viewportHeight: 800, margin: 24 });
			expect(target).toBe(offsets[17] - 24);
		});

		it("clamps to the scrollable range", () => {
			const target = stripScrollOffsetForIndex(99, { offsets, totalHeight, viewportHeight: 800 });
			expect(target).toBeLessThanOrEqual(totalHeight - 800);
			expect(target).toBeGreaterThanOrEqual(0);
		});

		it("never returns a negative offset", () => {
			const target = stripScrollOffsetForIndex(0, { offsets, totalHeight, viewportHeight: 800, margin: 100 });
			expect(target).toBe(0);
		});
	});

	describe("focusedPageForScroll", () => {
		const heights = [400, 400, 400, 400];
		const offsets = computeOffsets(heights, 0); // [0, 400, 800, 1200]

		it("returns the page under the viewport center", () => {
			// viewport 0..800, center 400 → page 1 (offset 400)
			expect(focusedPageForScroll(offsets, heights, 0, 800)).toBe(1);
		});

		it("follows the center as the user scrolls down", () => {
			// scrollTop 800, viewport 400, center 1000 → page 2 (offset 800)
			expect(focusedPageForScroll(offsets, heights, 800, 400)).toBe(2);
		});

		it("returns 0 for an empty strip", () => {
			expect(focusedPageForScroll([], [], 0, 800)).toBe(0);
		});
	});

	describe("centeredPageForScroll", () => {
		const heights = [400, 400, 400, 400];
		const offsets = computeOffsets(heights, 0); // [0, 400, 800, 1200]

		it("returns the page whose slot center is nearest the viewport center", () => {
			// viewport 0..800, center 400 → page 1's center is 600, page 0's is 200;
			// |600-400|=200, |200-400|=200 tie → earlier page 0 wins on a tie.
			expect(centeredPageForScroll(offsets, heights, 0, 800)).toBe(0);
		});

		it("picks the page that visually dominates, not just the straddling one", () => {
			// scrollTop 300, viewport 400 → center 500. page1 center 600 (dist 100),
			// page0 center 200 (dist 300) → page 1.
			expect(centeredPageForScroll(offsets, heights, 300, 400)).toBe(1);
		});

		it("follows the center deep into the strip", () => {
			// scrollTop 900, viewport 400 → center 1100. page2 center 1000 (dist 100),
			// page3 center 1400 (dist 300) → page 2.
			expect(centeredPageForScroll(offsets, heights, 900, 400)).toBe(2);
		});

		it("handles unequal page heights (big page wins the center)", () => {
			const tall = [200, 1200, 200];
			const tallOffsets = computeOffsets(tall, 0); // [0, 200, 1400]
			// viewport 200..1000, center 600 → page1 center 800 (dist 200) beats
			// page0 center 100 (dist 500).
			expect(centeredPageForScroll(tallOffsets, tall, 200, 800)).toBe(1);
		});

		it("returns 0 for an empty strip", () => {
			expect(centeredPageForScroll([], [], 0, 800)).toBe(0);
		});
	});
});
