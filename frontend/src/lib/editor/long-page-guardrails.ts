// Long-page (webtoon) guardrails — W3.15.
//
// A long page is a single tall page image that may be composed of several
// stitched source pages. Editing tools (brush / clone / heal / draw) must not
// physically paint across a page boundary unless the editor is in multi-page
// mode, which is gated to Cleaner / Typesetter roles + lock ownership.
//
// This module is the pure geometry + policy core (no Fabric, no DOM) so it can
// be unit-tested in isolation. The MangaEditor wires these helpers to the
// Fabric canvas (red boundary overlay + active-page clipPath).
//
// Coordinate model (mirrors editor.ts):
//   imageBounds is the scene-space rectangle the page image occupies. A
//   boundary fraction f in [0,1] maps to scene-Y `imageBounds.top + f *
//   imageBounds.height`. Page 1 spans [0, f1), page 2 spans [f1, f2), … so
//   internal fractions are the *cuts* between stitched source pages.

import type { CanvasImageBounds } from "$lib/canvas/editor.ts";
import type { RoleCapabilityFlags } from "$lib/stores/auth.svelte.ts";

export interface PageBoundaryLine {
	/** 1-based page number that ends at this boundary (the page above the line). */
	pageNumber: number;
	/** Scene-space Y of the horizontal boundary line. */
	sceneY: number;
	/** Whether this is the bottom edge of the whole image (not an internal cut). */
	isImageEdge: boolean;
}

export interface PageSegmentBounds extends CanvasImageBounds {
	/** 1-based page number of this segment. */
	pageNumber: number;
}

/**
 * Normalise raw boundary fractions into strictly-increasing internal cuts in
 * the open interval (0, 1). Out-of-range, non-finite, and duplicate values are
 * dropped so a malformed segment list can never produce a zero-height or
 * overlapping clip region. The 0 and 1 edges are implicit and never included.
 */
export function normalizeBoundaryFractions(fractions: readonly number[] | null | undefined): number[] {
	if (!fractions || fractions.length === 0) return [];
	const cleaned = fractions
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1)
		.sort((a, b) => a - b);
	const result: number[] = [];
	for (const value of cleaned) {
		// Drop duplicates / near-duplicates that would create a zero-height page.
		if (result.length > 0 && value - result[result.length - 1] < 1e-6) continue;
		result.push(value);
	}
	return result;
}

/** Number of logical pages a long-page image is split into (segments + 1). */
export function pageSegmentCount(fractions: readonly number[] | null | undefined): number {
	return normalizeBoundaryFractions(fractions).length + 1;
}

/**
 * Horizontal boundary lines to draw on the canvas for a long page. Internal
 * cuts get a line; the very top of the image is not drawn (it coincides with
 * the canvas/page top), and the bottom edge is included so the last page's
 * extent is always marked. Returns [] when bounds are unusable.
 */
export function computePageBoundaryLines(
	imageBounds: CanvasImageBounds,
	fractions: readonly number[] | null | undefined,
): PageBoundaryLine[] {
	if (!isUsableBounds(imageBounds)) return [];
	const cuts = normalizeBoundaryFractions(fractions);
	const lines: PageBoundaryLine[] = [];
	cuts.forEach((fraction, index) => {
		lines.push({
			pageNumber: index + 1,
			sceneY: imageBounds.top + fraction * imageBounds.height,
			isImageEdge: false,
		});
	});
	// Bottom edge of the whole image = end of the last page.
	lines.push({
		pageNumber: cuts.length + 1,
		sceneY: imageBounds.top + imageBounds.height,
		isImageEdge: true,
	});
	return lines;
}

/**
 * Scene-space rect of a single page segment. `index` is 0-based. Falls back to
 * the full image bounds for index 0 with no cuts. Out-of-range indexes clamp to
 * the nearest valid segment so the clip is never empty.
 */
export function computeSegmentBounds(
	imageBounds: CanvasImageBounds,
	fractions: readonly number[] | null | undefined,
	index: number,
): PageSegmentBounds | null {
	if (!isUsableBounds(imageBounds)) return null;
	const cuts = normalizeBoundaryFractions(fractions);
	const segmentCount = cuts.length + 1;
	const safeIndex = clampInt(index, 0, segmentCount - 1);
	const topFraction = safeIndex === 0 ? 0 : cuts[safeIndex - 1];
	const bottomFraction = safeIndex === segmentCount - 1 ? 1 : cuts[safeIndex];
	const top = imageBounds.top + topFraction * imageBounds.height;
	const bottom = imageBounds.top + bottomFraction * imageBounds.height;
	return {
		pageNumber: safeIndex + 1,
		left: imageBounds.left,
		top,
		width: imageBounds.width,
		height: Math.max(0, bottom - top),
	};
}

/**
 * Which 0-based segment a scene-Y falls in. A point exactly on a cut belongs to
 * the page *below* it (consistent with [top, bottom) segment spans), except the
 * bottom image edge which stays in the last page.
 */
export function segmentIndexForSceneY(
	imageBounds: CanvasImageBounds,
	fractions: readonly number[] | null | undefined,
	sceneY: number,
): number {
	if (!isUsableBounds(imageBounds)) return 0;
	const cuts = normalizeBoundaryFractions(fractions);
	if (cuts.length === 0) return 0;
	const fraction = (sceneY - imageBounds.top) / imageBounds.height;
	for (let i = 0; i < cuts.length; i += 1) {
		if (fraction < cuts[i]) return i;
	}
	return cuts.length;
}

export interface ClipResult {
	/** Point clamped to lie within the active segment bounds. */
	point: { x: number; y: number };
	/** True when clamping actually moved the point (the stroke hit the boundary). */
	clipped: boolean;
}

/**
 * Clamp a scene-space point into the active segment so a brush/clone/heal/draw
 * stroke physically cannot land outside the current page. The returned
 * `clipped` flag drives the "tool clipped at page N" toast.
 *
 * A point is only considered *clipped* (and thus the trigger for the toast)
 * when it crosses the horizontal page boundary on the Y axis — horizontal
 * clamping to the image edge is normal page-edge behaviour and is not a
 * cross-page event.
 */
export function clipPointToSegment(segment: CanvasImageBounds, point: { x: number; y: number }): ClipResult {
	const minX = segment.left;
	const maxX = segment.left + segment.width;
	const minY = segment.top;
	const maxY = segment.top + segment.height;
	const x = clamp(point.x, minX, maxX);
	const y = clamp(point.y, minY, maxY);
	const crossedPageBoundary = point.y < minY || point.y > maxY;
	return { point: { x, y }, clipped: crossedPageBoundary };
}

export interface BrushClampResult {
	/** Pointer centre clamped so the *whole brush footprint* stays in the segment. */
	point: { x: number; y: number };
	/** True when the brush footprint crossed a horizontal page boundary (drives the toast). */
	clipped: boolean;
	/**
	 * True when the pointer is a horizontal miss — its footprint lies entirely
	 * outside the segment's left/right edge. The caller must DROP the stroke
	 * (treat it as an off-page miss), never clamp X into an in-bounds paint.
	 */
	outsideHorizontally: boolean;
}

/**
 * Footprint-aware version of {@link clipPointToSegment} for the brush/eraser.
 *
 * The composited stroke paints a disc of `radius` around the pointer centre, so
 * clamping only the centre still lets the footprint bleed up to `radius` past a
 * page cut. Here the *centre* is clamped to `[top + radius, bottom - radius]`
 * (collapsing to the segment mid-line when the page is thinner than the brush)
 * so no painted pixel crosses a horizontal boundary.
 *
 * Horizontal behaviour is a hard gate, not a clamp: a pointer whose footprint is
 * wholly outside the left/right page edge is reported via `outsideHorizontally`
 * so the caller can ignore it as an off-page miss instead of snapping X inward
 * and erasing along the image edge.
 */
export function clampBrushPointerToSegment(
	segment: CanvasImageBounds,
	point: { x: number; y: number },
	radius: number,
): BrushClampResult {
	const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
	const minX = segment.left;
	const maxX = segment.left + segment.width;
	const minY = segment.top;
	const maxY = segment.top + segment.height;

	// Footprint entirely past the left/right page edge -> off-page miss.
	const outsideHorizontally = point.x + r < minX || point.x - r > maxX;

	// Radius-aware Y clamp: keep the whole disc inside the segment. If the page
	// is thinner than the brush footprint, pin the centre to the mid-line.
	let innerMinY = minY + r;
	let innerMaxY = maxY - r;
	if (innerMinY > innerMaxY) {
		const mid = (minY + maxY) / 2;
		innerMinY = mid;
		innerMaxY = mid;
	}
	const y = clamp(point.y, innerMinY, innerMaxY);

	// X is still clamped (the footprint may straddle the edge), but only when it
	// is not a full horizontal miss (handled above).
	const x = clamp(point.x, minX, maxX);

	// A boundary clip means the footprint would have crossed a horizontal cut.
	const crossedPageBoundary = point.y - r < minY || point.y + r > maxY;
	return { point: { x, y }, clipped: crossedPageBoundary, outsideHorizontally };
}

/** True when a scene-space point lies inside (or on the edge of) a segment. */
export function isPointInSegment(segment: CanvasImageBounds, point: { x: number; y: number }): boolean {
	return (
		point.x >= segment.left
		&& point.x <= segment.left + segment.width
		&& point.y >= segment.top
		&& point.y <= segment.top + segment.height
	);
}

/**
 * Role gate for the cross-page (multi-page) editing toggle. Only Cleaner and
 * Typesetter capabilities may disable the per-page clip — translators / QC /
 * viewers stay clipped. `canClean || canTypeset` matches the role profiles in
 * auth.svelte.ts (owner/admin/team_lead/editor have both and so also qualify).
 */
export function canUseMultiPageMode(capabilities: RoleCapabilityFlags | null | undefined): boolean {
	if (!capabilities) return false;
	return capabilities.canClean === true || capabilities.canTypeset === true;
}

/** Toast copy shown when a stroke is clipped at a page boundary. */
export function pageClipToastMessage(pageNumber: number): string {
	return `tool clipped at page ${pageNumber} — switch to multi-page mode to edit across pages`;
}

function isUsableBounds(bounds: CanvasImageBounds | null | undefined): bounds is CanvasImageBounds {
	return Boolean(
		bounds
		&& Number.isFinite(bounds.left)
		&& Number.isFinite(bounds.top)
		&& Number.isFinite(bounds.width)
		&& Number.isFinite(bounds.height)
		&& bounds.width > 0
		&& bounds.height > 0,
	);
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.round(value)));
}
