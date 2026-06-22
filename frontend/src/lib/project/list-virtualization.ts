// List virtualization (W3.5)
// Pure, DOM-free windowing math for the PageNavigator page strip so a chapter with
// 100-300 pages renders only the visible rows (+ a small overscan) instead of every
// row. The component owns the scroll container + observers; this module only computes
// which slice of the (already reading-direction-ordered) item array to render and how
// tall the top/bottom spacers must be to keep the scrollbar geometry honest.
//
// The math is intentionally index-based and order-agnostic: callers pass the count of
// items in *display* order (RTL already reversed upstream), so virtualization never
// touches logical page order or reading direction.

export interface VirtualWindowInput {
	/** Total number of rows in display order. */
	itemCount: number;
	/** Current scrollTop of the scroll container, in px. */
	scrollTop: number;
	/** Visible height of the scroll container (clientHeight), in px. */
	viewportHeight: number;
	/** Estimated per-row height in px (row box + inter-row gap). Must be > 0. */
	rowHeight: number;
	/** Extra rows to render above and below the visible window. */
	overscan?: number;
}

export interface VirtualWindow {
	/** First item index to render (inclusive). */
	startIndex: number;
	/** Last item index to render (inclusive). -1 when there is nothing to render. */
	endIndex: number;
	/** px spacer to render before the first rendered row (keeps scroll offset honest). */
	padStart: number;
	/** px spacer to render after the last rendered row. */
	padEnd: number;
	/** Number of rendered rows (endIndex - startIndex + 1, or 0 when empty). */
	renderCount: number;
}

export const DEFAULT_OVERSCAN = 6;
/** Below this item count, virtualization is pointless; render everything. */
export const VIRTUALIZE_THRESHOLD = 40;

function clampIndex(value: number, max: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > max) return max;
	return Math.floor(value);
}

/**
 * Compute the slice of rows to render plus the top/bottom spacer heights.
 *
 * Uses a uniform `rowHeight` estimate. Real rows are variable-height (min 104px), so
 * the estimate only needs to be close enough that overscan covers the slack; the
 * scrollbar stays usable because total height = padStart + rendered rows + padEnd
 * always equals itemCount * rowHeight.
 */
export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
	const overscan = Math.max(0, Math.floor(input.overscan ?? DEFAULT_OVERSCAN));
	const itemCount = Math.max(0, Math.floor(input.itemCount));
	const rowHeight = input.rowHeight > 0 ? input.rowHeight : 1;

	if (itemCount === 0) {
		return { startIndex: 0, endIndex: -1, padStart: 0, padEnd: 0, renderCount: 0 };
	}

	const scrollTop = Math.max(0, Number.isFinite(input.scrollTop) ? input.scrollTop : 0);
	const viewportHeight = Math.max(0, Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0);

	const lastIndex = itemCount - 1;
	const firstVisible = clampIndex(scrollTop / rowHeight, lastIndex);
	// +1 because a partially-scrolled viewport can show one extra row at the bottom.
	const visibleRows = Math.ceil(viewportHeight / rowHeight) + 1;
	const lastVisible = clampIndex(firstVisible + visibleRows - 1, lastIndex);

	const startIndex = clampIndex(firstVisible - overscan, lastIndex);
	const endIndex = clampIndex(lastVisible + overscan, lastIndex);

	const padStart = startIndex * rowHeight;
	const padEnd = (lastIndex - endIndex) * rowHeight;

	return {
		startIndex,
		endIndex,
		padStart,
		padEnd,
		renderCount: endIndex - startIndex + 1,
	};
}

/**
 * Whether virtualization should be active for the given item count. Small lists render
 * fully (no spacers, no scroll math) so short chapters keep identical DOM/behavior.
 */
export function shouldVirtualize(itemCount: number, threshold = VIRTUALIZE_THRESHOLD): boolean {
	return itemCount > threshold;
}

/**
 * scrollTop needed to bring `targetIndex` (a display-order index) into view, given the
 * current scroll position + viewport. Returns null when the row is already fully
 * visible (so the component can skip a redundant scroll). Aligns the row near the top
 * of the viewport with a small margin when it sits above, or just into view when below.
 */
export function scrollOffsetForIndex(
	targetIndex: number,
	opts: { scrollTop: number; viewportHeight: number; rowHeight: number; itemCount: number; margin?: number },
): number | null {
	const itemCount = Math.max(0, Math.floor(opts.itemCount));
	if (itemCount === 0) return null;
	const rowHeight = opts.rowHeight > 0 ? opts.rowHeight : 1;
	const index = clampIndex(targetIndex, itemCount - 1);
	const margin = Math.max(0, opts.margin ?? rowHeight);
	const scrollTop = Math.max(0, Number.isFinite(opts.scrollTop) ? opts.scrollTop : 0);
	const viewportHeight = Math.max(0, Number.isFinite(opts.viewportHeight) ? opts.viewportHeight : 0);
	const maxScroll = Math.max(0, itemCount * rowHeight - viewportHeight);

	const rowTop = index * rowHeight;
	const rowBottom = rowTop + rowHeight;

	if (rowTop < scrollTop) {
		// Row is above the viewport: scroll up so it sits a margin below the top edge.
		return Math.min(maxScroll, Math.max(0, rowTop - margin));
	}
	if (rowBottom > scrollTop + viewportHeight) {
		// Row is below the viewport: scroll down so its bottom rests at the viewport edge.
		return Math.min(maxScroll, rowBottom - viewportHeight + margin);
	}
	return null;
}
