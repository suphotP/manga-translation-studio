// Continuous webtoon strip virtualization (editor vertical/long-strip mode).
//
// The editor renders vertical/webtoon chapters as ONE continuous vertical scroll
// of all pages (not one page at a time). A 1000-page chapter must not mount/decode
// every page image at once, so this module owns the pure, DOM-free windowing math:
// given the scroll position, viewport height, and a per-page height array, it returns
// which contiguous slice of pages to actually render (mount the <img> / Fabric canvas)
// plus the absolute Y offset of each page so the component can position pages in an
// absolutely-positioned track of a known total height (stable scrollbar geometry).
//
// Pages have variable heights (different aspect ratios), so unlike the uniform-row
// PageNavigator strip (see list-virtualization.ts) this uses a cumulative-offset
// approach. Until a page image decodes we don't know its real height, so callers pass
// an *estimate* (derived from column width × a typical webtoon aspect ratio) and
// replace it with the measured height once the page is in view; the offsets recompute
// and the scroll position is preserved by the component.

export interface StripWindowInput {
	/** Per-page rendered heights in display order, in px (estimate until measured). Each > 0. */
	pageHeights: readonly number[];
	/** Current scrollTop of the scroll container, in px. */
	scrollTop: number;
	/** Visible height of the scroll container (clientHeight), in px. */
	viewportHeight: number;
	/** Extra pages to render above and below the visible window. */
	overscan?: number;
	/** Gap between pages in px (added after every page except the last). */
	gap?: number;
}

export interface StripWindow {
	/** First page index to render (inclusive). -1/empty window when nothing to render. */
	startIndex: number;
	/** Last page index to render (inclusive). -1 when there is nothing to render. */
	endIndex: number;
	/** Absolute top offset (px) of each page index, length = pageHeights.length. */
	offsets: number[];
	/** Total scrollable height of the strip in px (sum of heights + gaps). */
	totalHeight: number;
	/** Number of rendered pages (endIndex - startIndex + 1, or 0 when empty). */
	renderCount: number;
}

// Overscan = extra pages mounted above + below the visible window. Each mounted
// page decodes a (now downscaled) preview image, so we keep this as LOW as gives a
// smooth look: 1 page of lookahead each side is enough to hide the swap during a
// normal flick, while reducing the number of simultaneously-decoded previews vs the
// old value of 2 (fewer concurrent decodes = less main-thread/GPU pressure on real
// heavy scans). Offscreen slots are also `content-visibility:auto` so they cost ~0.
export const DEFAULT_STRIP_OVERSCAN = 1;
export const DEFAULT_STRIP_GAP = 16;

/**
 * Default per-page height estimate for a page that has not been measured yet.
 * Webtoon pages are tall; we assume a 2:3-ish portrait at the given column width but
 * bias taller so estimates rarely *undershoot* (an undershoot makes the strip jump as
 * real, taller pages push content down). Callers refine this with measured heights.
 */
export function estimatePageHeight(columnWidth: number, aspectRatio = 1.6): number {
	const width = columnWidth > 0 ? columnWidth : 1;
	const ratio = aspectRatio > 0 ? aspectRatio : 1.6;
	return Math.round(width * ratio);
}

/** Cumulative top offset of each page given heights + inter-page gap. */
export function computeOffsets(pageHeights: readonly number[], gap: number): number[] {
	const offsets = new Array<number>(pageHeights.length);
	let acc = 0;
	for (let i = 0; i < pageHeights.length; i++) {
		offsets[i] = acc;
		const h = pageHeights[i] > 0 ? pageHeights[i] : 1;
		acc += h + gap;
	}
	return offsets;
}

function clampIndex(value: number, max: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > max) return max;
	return Math.floor(value);
}

/**
 * Binary-search the last page whose top offset is <= `y`. Returns 0 for an empty list
 * or a `y` before the first page. Offsets are monotonically increasing.
 */
function findPageAtOffset(offsets: readonly number[], y: number): number {
	if (offsets.length === 0) return 0;
	let lo = 0;
	let hi = offsets.length - 1;
	let result = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid] <= y) {
			result = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return result;
}

/**
 * Compute the contiguous slice of pages to render for the current scroll position plus
 * each page's absolute top offset and the strip's total height. Pages outside the
 * window are NOT rendered (the component leaves their absolutely-positioned slot empty,
 * or renders a cheap skeleton, while the total-height track keeps the scrollbar honest).
 */
export function computeStripWindow(input: StripWindowInput): StripWindow {
	const gap = Math.max(0, input.gap ?? DEFAULT_STRIP_GAP);
	const overscan = Math.max(0, Math.floor(input.overscan ?? DEFAULT_STRIP_OVERSCAN));
	const heights = input.pageHeights;
	const count = heights.length;

	const offsets = computeOffsets(heights, gap);
	// Total height has no trailing gap after the last page.
	const lastHeight = count > 0 ? (heights[count - 1] > 0 ? heights[count - 1] : 1) : 0;
	const totalHeight = count > 0 ? offsets[count - 1] + lastHeight : 0;

	if (count === 0) {
		return { startIndex: 0, endIndex: -1, offsets, totalHeight: 0, renderCount: 0 };
	}

	const scrollTop = Math.max(0, Number.isFinite(input.scrollTop) ? input.scrollTop : 0);
	const viewportHeight = Math.max(0, Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0);
	const lastIndex = count - 1;

	const firstVisible = findPageAtOffset(offsets, scrollTop);
	const lastVisible = findPageAtOffset(offsets, scrollTop + viewportHeight);

	const startIndex = clampIndex(firstVisible - overscan, lastIndex);
	const endIndex = clampIndex(lastVisible + overscan, lastIndex);

	return {
		startIndex,
		endIndex,
		offsets,
		totalHeight,
		renderCount: endIndex - startIndex + 1,
	};
}

/**
 * scrollTop needed to bring `targetIndex` to the top of the viewport (with a small
 * margin). Used by "jump to page N". Returns a clamped, non-negative scroll offset.
 */
export function stripScrollOffsetForIndex(
	targetIndex: number,
	opts: { offsets: readonly number[]; totalHeight: number; viewportHeight: number; margin?: number },
): number {
	const count = opts.offsets.length;
	if (count === 0) return 0;
	const index = clampIndex(targetIndex, count - 1);
	const margin = Math.max(0, opts.margin ?? 0);
	const viewportHeight = Math.max(0, Number.isFinite(opts.viewportHeight) ? opts.viewportHeight : 0);
	const maxScroll = Math.max(0, opts.totalHeight - viewportHeight);
	return Math.min(maxScroll, Math.max(0, opts.offsets[index] - margin));
}

/**
 * The page whose slot currently dominates the viewport center — the page the editor
 * should treat as "focused" (host the Fabric canvas, drive the inspector). Picking the
 * page under the viewport's vertical center keeps focus stable while scrolling.
 */
export function focusedPageForScroll(
	offsets: readonly number[],
	pageHeights: readonly number[],
	scrollTop: number,
	viewportHeight: number,
): number {
	if (offsets.length === 0) return 0;
	const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
	const vh = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
	const center = top + vh / 2;
	return findPageAtOffset(offsets, center);
}

/**
 * The page index whose SLOT CENTER is closest to the viewport's vertical center.
 * Unlike `focusedPageForScroll` (which returns the page whose top precedes the
 * center), this compares each page's mid-point to the viewport mid-point, so the
 * page that visually dominates the screen wins — the page a reviewer means when they
 * click "open this in the editor". Ties resolve to the earlier page.
 */
export function centeredPageForScroll(
	offsets: readonly number[],
	pageHeights: readonly number[],
	scrollTop: number,
	viewportHeight: number,
): number {
	const count = offsets.length;
	if (count === 0) return 0;
	const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
	const vh = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
	const viewportCenter = top + vh / 2;
	// Start the search near the page under the center, then scan its neighbours — the
	// nearest-center page is always adjacent to the page that straddles the center.
	const anchor = findPageAtOffset(offsets, viewportCenter);
	let best = anchor;
	let bestDist = Infinity;
	const lo = Math.max(0, anchor - 1);
	const hi = Math.min(count - 1, anchor + 1);
	for (let i = lo; i <= hi; i++) {
		const h = pageHeights[i] > 0 ? pageHeights[i] : 1;
		const slotCenter = offsets[i] + h / 2;
		const dist = Math.abs(slotCenter - viewportCenter);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}
