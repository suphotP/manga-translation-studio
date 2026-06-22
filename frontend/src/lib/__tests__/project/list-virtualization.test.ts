import { describe, expect, it } from "vitest";
import {
	computeVirtualWindow,
	scrollOffsetForIndex,
	shouldVirtualize,
	DEFAULT_OVERSCAN,
	VIRTUALIZE_THRESHOLD,
} from "$lib/project/list-virtualization.ts";

const ROW = 108;

describe("computeVirtualWindow", () => {
	it("renders only the visible window plus overscan, not every row", () => {
		// 300-page chapter, 330px viewport (~3 rows), scrolled to the middle.
		const win = computeVirtualWindow({
			itemCount: 300,
			scrollTop: 100 * ROW,
			viewportHeight: 330,
			rowHeight: ROW,
			overscan: DEFAULT_OVERSCAN,
		});
		// Visible rows ~ ceil(330/108)+1 = 5, plus 6 overscan each side → ~17 rows.
		expect(win.renderCount).toBeLessThan(20);
		expect(win.renderCount).toBeGreaterThan(0);
		// Window is centered around the scrolled row, not at index 0.
		expect(win.startIndex).toBeGreaterThan(80);
		expect(win.endIndex).toBeLessThan(120);
	});

	it("keeps total spacer + rendered height equal to itemCount * rowHeight", () => {
		const itemCount = 250;
		const win = computeVirtualWindow({
			itemCount,
			scrollTop: 50 * ROW,
			viewportHeight: 400,
			rowHeight: ROW,
		});
		const renderedHeight = win.renderCount * ROW;
		expect(win.padStart + renderedHeight + win.padEnd).toBe(itemCount * ROW);
	});

	it("starts at index 0 with zero top spacer when scrolled to the top", () => {
		const win = computeVirtualWindow({
			itemCount: 200,
			scrollTop: 0,
			viewportHeight: 330,
			rowHeight: ROW,
		});
		expect(win.startIndex).toBe(0);
		expect(win.padStart).toBe(0);
	});

	it("clamps the window to the last index with zero bottom spacer at the end", () => {
		const itemCount = 120;
		const maxScroll = itemCount * ROW;
		const win = computeVirtualWindow({
			itemCount,
			scrollTop: maxScroll,
			viewportHeight: 330,
			rowHeight: ROW,
		});
		expect(win.endIndex).toBe(itemCount - 1);
		expect(win.padEnd).toBe(0);
	});

	it("returns an empty window for zero items", () => {
		const win = computeVirtualWindow({ itemCount: 0, scrollTop: 0, viewportHeight: 330, rowHeight: ROW });
		expect(win).toEqual({ startIndex: 0, endIndex: -1, padStart: 0, padEnd: 0, renderCount: 0 });
	});

	it("guards against non-positive row height and NaN inputs", () => {
		const win = computeVirtualWindow({
			itemCount: 10,
			scrollTop: Number.NaN,
			viewportHeight: Number.NaN,
			rowHeight: 0,
		});
		expect(win.startIndex).toBe(0);
		expect(win.endIndex).toBeGreaterThanOrEqual(0);
		expect(win.endIndex).toBeLessThan(10);
	});

	it("renders the full list (single window) when it fits the viewport", () => {
		const itemCount = 6;
		const win = computeVirtualWindow({
			itemCount,
			scrollTop: 0,
			viewportHeight: 2000,
			rowHeight: ROW,
		});
		expect(win.startIndex).toBe(0);
		expect(win.endIndex).toBe(itemCount - 1);
		expect(win.padStart).toBe(0);
		expect(win.padEnd).toBe(0);
	});

	it("is order-agnostic: same indexes map for RTL-reversed display arrays", () => {
		// Virtualization works on positional indexes of the already-ordered array, so an
		// RTL-reversed array yields the same window math — order is preserved upstream.
		const ascending = Array.from({ length: 200 }, (_, i) => i);
		const rtl = [...ascending].reverse();
		const opts = { itemCount: 200, scrollTop: 40 * ROW, viewportHeight: 330, rowHeight: ROW };
		const win = computeVirtualWindow(opts);
		const ascSlice = ascending.slice(win.startIndex, win.endIndex + 1);
		const rtlSlice = rtl.slice(win.startIndex, win.endIndex + 1);
		// Both slices are contiguous windows of the same length at the same positions.
		expect(ascSlice).toHaveLength(win.renderCount);
		expect(rtlSlice).toHaveLength(win.renderCount);
		// RTL slice is the reverse-order page numbers (e.g. starts high), proving order
		// flips with the input array, never inside the window math.
		expect(rtlSlice[0]).toBeGreaterThan(rtlSlice[rtlSlice.length - 1]);
		expect(ascSlice[0]).toBeLessThan(ascSlice[ascSlice.length - 1]);
	});
});

describe("shouldVirtualize", () => {
	it("is off for short chapters and on past the threshold", () => {
		expect(shouldVirtualize(10)).toBe(false);
		expect(shouldVirtualize(VIRTUALIZE_THRESHOLD)).toBe(false);
		expect(shouldVirtualize(VIRTUALIZE_THRESHOLD + 1)).toBe(true);
		expect(shouldVirtualize(300)).toBe(true);
	});
});

describe("scrollOffsetForIndex", () => {
	const base = { scrollTop: 50 * ROW, viewportHeight: 330, rowHeight: ROW, itemCount: 200 };

	it("returns null when the target row is already fully visible", () => {
		// Row 50 sits at the top of the current viewport.
		expect(scrollOffsetForIndex(50, base)).toBeNull();
	});

	it("scrolls up to reveal a row above the viewport", () => {
		const offset = scrollOffsetForIndex(10, base);
		expect(offset).not.toBeNull();
		expect(offset!).toBeLessThan(base.scrollTop);
		expect(offset!).toBeGreaterThanOrEqual(0);
	});

	it("scrolls down to reveal a row below the viewport", () => {
		const offset = scrollOffsetForIndex(120, base);
		expect(offset).not.toBeNull();
		expect(offset!).toBeGreaterThan(base.scrollTop);
	});

	it("never scrolls past the maximum scroll extent", () => {
		const offset = scrollOffsetForIndex(199, base);
		const maxScroll = base.itemCount * ROW - base.viewportHeight;
		expect(offset!).toBeLessThanOrEqual(maxScroll);
	});

	it("returns null for an empty list", () => {
		expect(scrollOffsetForIndex(0, { ...base, itemCount: 0 })).toBeNull();
	});
});
