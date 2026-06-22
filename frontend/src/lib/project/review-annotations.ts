// Review-reader annotation helpers (PURE — no DOM, no store, no side effects).
//
// The QC "reading/review" reader lets a reviewer mark issues directly on a page —
// a circle, a freehand scribble, a rectangle, or a pin — without spawning a heavy
// task per mark. Each mark is persisted ON an existing project COMMENT via its
// optional `annotation` field (see `ReviewAnnotation` in types.ts), so a review
// mark is just an anchored comment.
//
// COORDINATE MODEL: annotation coordinates are NORMALIZED to the page image
// (0..1 of width/height). Storing normalized means a mark drawn on the downscaled
// `fit=inside` preview overlays perfectly on the full-res page (and at any zoom /
// column width) — we never persist device pixels. This module owns the conversion
// between pointer pixels (within the rendered preview box) and normalized space,
// the SVG geometry for rendering each shape, and the per-page annotation filter.

import type { ProjectComment, ReviewAnnotation, ReviewAnnotationShape } from "$lib/types.js";

/** Default stroke colours per shape (amber = attention, matches the ws palette). */
export const REVIEW_ANNOTATION_DEFAULT_COLOR = "#FBBF24";

export interface Vec2 {
	x: number;
	y: number;
}

/** Clamp a value into [0, 1]. */
export function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * Convert a pointer position (px, relative to the rendered preview box top-left)
 * into normalized image space (0..1). `boxWidth`/`boxHeight` are the rendered
 * preview box dimensions in px. Out-of-box pointers clamp to the edge.
 */
export function pointerToNormalized(
	pointerX: number,
	pointerY: number,
	boxWidth: number,
	boxHeight: number,
): Vec2 {
	const w = boxWidth > 0 ? boxWidth : 1;
	const h = boxHeight > 0 ? boxHeight : 1;
	return { x: clamp01(pointerX / w), y: clamp01(pointerY / h) };
}

/** Bounding box (normalized) of a set of points; empty list → zero box at origin. */
export function pointsBounds(points: readonly Vec2[]): { x: number; y: number; w: number; h: number } {
	if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const point of points) {
		if (point.x < minX) minX = point.x;
		if (point.y < minY) minY = point.y;
		if (point.x > maxX) maxX = point.x;
		if (point.y > maxY) maxY = point.y;
	}
	return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/**
 * Build a `ReviewAnnotation` from a drag in normalized space.
 *
 * - `pin` ignores the drag size and anchors at `start` with a zero box.
 * - `circle`/`rect` use the bounding box of `start`→`end`.
 * - `freehand` carries the full normalized point path plus its bounds.
 *
 * Returns `null` for a degenerate non-pin shape (no meaningful drag) so a stray
 * click doesn't create an empty mark.
 */
export function buildAnnotation(
	shape: ReviewAnnotationShape,
	start: Vec2,
	end: Vec2,
	options: { points?: readonly Vec2[]; color?: string; minSize?: number } = {},
): ReviewAnnotation | null {
	const color = options.color || REVIEW_ANNOTATION_DEFAULT_COLOR;
	const minSize = options.minSize ?? 0.005;
	if (shape === "pin") {
		return { shape, x: clamp01(start.x), y: clamp01(start.y), w: 0, h: 0, color };
	}
	if (shape === "freehand") {
		const points = (options.points ?? []).map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }));
		if (points.length < 2) return null;
		const bounds = pointsBounds(points);
		return { shape, ...bounds, points, color };
	}
	const x = clamp01(Math.min(start.x, end.x));
	const y = clamp01(Math.min(start.y, end.y));
	const w = clamp01(Math.abs(end.x - start.x));
	const h = clamp01(Math.abs(end.y - start.y));
	if (w < minSize && h < minSize) return null;
	return { shape, x, y, w, h, color };
}

/** SVG `points` attribute string for a freehand polyline, scaled to a px box. */
export function freehandPolylinePoints(
	annotation: ReviewAnnotation,
	boxWidth: number,
	boxHeight: number,
): string {
	if (!annotation.points || annotation.points.length === 0) return "";
	return annotation.points
		.map((point) => `${(point.x * boxWidth).toFixed(2)},${(point.y * boxHeight).toFixed(2)}`)
		.join(" ");
}

export interface AnnotationBoxPx {
	left: number;
	top: number;
	width: number;
	height: number;
	centerX: number;
	centerY: number;
}

/** Pixel-space box for an annotation given the rendered preview box dimensions. */
export function annotationBoxPx(
	annotation: ReviewAnnotation,
	boxWidth: number,
	boxHeight: number,
): AnnotationBoxPx {
	const left = annotation.x * boxWidth;
	const top = annotation.y * boxHeight;
	const width = annotation.w * boxWidth;
	const height = annotation.h * boxHeight;
	return { left, top, width, height, centerX: left + width / 2, centerY: top + height / 2 };
}

/**
 * Minimum normalized half-extent for a pin's tappable region, per the review UX
 * spec ("pin region should be a minimum tappable box, normalized w/h = 0.025").
 * Also used as a floor for degenerate circle/rect/freehand marks so the editor
 * always has a clickable region to anchor a dot on.
 */
export const ANNOTATION_PIN_REGION_SIZE = 0.025;

/** A region in normalized image space (0..1 of width/height). */
export interface NormalizedRegion {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Derive a normalized (0..1) bounding region from any annotation shape. Pins (and
 * degenerate marks) get a small centered tappable box so the editor can render a
 * dot/region for them. This is the bridge that lets a review mark show up in the
 * editor's {@link CommentRegionOverlay}: the overlay converts this normalized
 * region into image-pixel space via the live `imageBounds`/`imageWidth`.
 *
 * Shared by frontend rendering AND comment persistence so the same mark anchors
 * identically in the review reader and the editor.
 */
export function annotationToNormalizedRegion(annotation: ReviewAnnotation): NormalizedRegion {
	const half = ANNOTATION_PIN_REGION_SIZE;
	if (annotation.shape === "pin") {
		// Center the tappable box on the pin point, but clamp the ORIGIN to
		// [0, 1 - size] so the box never overflows normalized bounds at the
		// right/bottom edge (x + w <= 1, y + h <= 1). The true pin point is
		// preserved via {@link annotationPinLocalPoint} for rendering, so the
		// editor overlay and the review reader agree even at the edges.
		const size = half * 2;
		const clampOrigin = (c: number): number => Math.min(Math.max(c - half, 0), 1 - size);
		return { x: clampOrigin(annotation.x), y: clampOrigin(annotation.y), w: size, h: size };
	}
	const x = clamp01(annotation.x);
	const y = clamp01(annotation.y);
	const w = Math.max(annotation.w, half * 2);
	const h = Math.max(annotation.h, half * 2);
	return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

/**
 * The pin marker's position WITHIN its normalized region box, in local SVG
 * viewBox units (0..100). For an interior pin this is the box center (50, 50);
 * for an edge pin whose box origin was clamped, it shifts so the marker still
 * renders at the pin's TRUE point — matching where the review reader draws it.
 */
export function annotationPinLocalPoint(annotation: ReviewAnnotation): { cx: number; cy: number } {
	const region = annotationToNormalizedRegion(annotation);
	const local = (point: number, origin: number, span: number): number =>
		span > 0 ? Math.min(Math.max(((point - origin) / span) * 100, 0), 100) : 50;
	return {
		cx: local(clamp01(annotation.x), region.x, region.w),
		cy: local(clamp01(annotation.y), region.y, region.h),
	};
}

/**
 * Convert a normalized annotation region into image-PIXEL space (the coordinate
 * model the editor's text layers / regions use). Returns integer-ish pixel x/y/w/h
 * the editor's `imageRegionToWorkspaceBox` consumes. Floors w/h at 1px so the box
 * is always renderable.
 */
export function annotationToImageRegion(
	annotation: ReviewAnnotation,
	imageWidth: number,
	imageHeight: number,
): { x: number; y: number; w: number; h: number } {
	const region = annotationToNormalizedRegion(annotation);
	const w = imageWidth > 0 ? imageWidth : 1;
	const h = imageHeight > 0 ? imageHeight : 1;
	return {
		x: region.x * w,
		y: region.y * h,
		w: Math.max(1, region.w * w),
		h: Math.max(1, region.h * h),
	};
}

export interface ReviewAnnotationItem {
	comment: ProjectComment;
	annotation: ReviewAnnotation;
}

/**
 * The annotated comments for a given page, in stable display order (oldest first,
 * so mark numbering is consistent across renders). Resolved comments are kept by
 * default so a reviewer can still see what was addressed; pass `openOnly` to hide
 * resolved marks.
 */
export function pageAnnotations(
	comments: readonly ProjectComment[],
	pageIndex: number,
	options: { openOnly?: boolean } = {},
): ReviewAnnotationItem[] {
	return comments
		.filter((comment) => comment.pageIndex === pageIndex && comment.annotation)
		.filter((comment) => !options.openOnly || comment.status !== "resolved")
		.slice()
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.map((comment) => ({ comment, annotation: comment.annotation as ReviewAnnotation }));
}

/** Count of open (unresolved) on-page annotations for a page. */
export function openAnnotationCount(comments: readonly ProjectComment[], pageIndex: number): number {
	return pageAnnotations(comments, pageIndex, { openOnly: true }).length;
}
