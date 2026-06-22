// Review reader page model (PURE — no DOM, no store, no side effects).
//
// The QC review reader renders a chapter like an EXPORT preview: a read-only
// composited page render that must NOT lag on big real scans. To stay smooth it
// loads the lightweight downscaled `fit=inside` preview derivative (NOT the full
// editor_preview / original), and in long-scroll mode it VIRTUALIZES the strip so
// a 1000-page chapter never mounts every <img> at once. This module owns the pure
// per-page descriptor + the translated-text-overlay model the layer toggle drives.

import type { ImageLayer, Page, ProjectState, TextLayer } from "$lib/types.js";
import { activeTrack, trackTextLayers } from "$lib/project/language-tracks.js";

export type ReviewLayerView = "translated" | "original" | "both";

export interface ReviewReaderPage {
	pageIndex: number;
	imageId: string | null;
	imageName: string;
	/** Translated text layers (active track) — drawn as the toggleable overlay. */
	textLayers: TextLayer[];
	/** True when the page carries no text to QC (raw scan / textless). */
	textless: boolean;
	/**
	 * The page's source extent in the SAME coordinate space text-layer x/y/w/h use,
	 * resolved from the base image layer's `sourceW/sourceH` (or its placed `w/h`).
	 * Null when unknown — the overlay then falls back to the rendered image's natural
	 * size, which is correct for a baked/exported preview.
	 */
	sourceSize: { width: number; height: number } | null;
}

/**
 * Resolve the page's source image extent for positioning text overlays. The base
 * (lowest-index, non-overlay) image layer's `sourceW/sourceH` is authoritative;
 * we fall back to its placed `w/h`. Returns null when the page has no image layer
 * with usable dimensions (caller falls back to the rendered <img> natural size).
 */
export function resolvePageSourceSize(page: Page): { width: number; height: number } | null {
	const layers = (page.imageLayers ?? [])
		.filter((layer): layer is ImageLayer => Boolean(layer) && layer.role !== "overlay" && layer.role !== "credit")
		.slice()
		.sort((a, b) => a.index - b.index);
	for (const layer of layers) {
		const width = layer.sourceW && layer.sourceW > 0 ? layer.sourceW : (layer.w > 0 ? layer.w : 0);
		const height = layer.sourceH && layer.sourceH > 0 ? layer.sourceH : (layer.h > 0 ? layer.h : 0);
		if (width > 0 && height > 0) return { width, height };
	}
	return null;
}

/**
 * Build the reader's per-page descriptors for the project's ACTIVE language track.
 * `previewImageId(page)` resolves the served image id used for the downscaled
 * preview (callers pass the existing `getPagePreviewImageId` so local/synthetic
 * pages are handled identically to the rest of the app).
 */
export function buildReviewReaderPages(
	project: ProjectState | null,
	previewImageId: (page: Page) => string | null,
): ReviewReaderPage[] {
	if (!project) return [];
	const lang = activeTrack(project);
	return project.pages.map((page, pageIndex) => {
		const textLayers = trackTextLayers(page, lang).filter((layer) => layer.visible !== false);
		return {
			pageIndex,
			imageId: previewImageId(page),
			imageName: page.imageName ?? `page-${pageIndex + 1}`,
			textLayers,
			textless: textLayers.length === 0,
			sourceSize: resolvePageSourceSize(page),
		};
	});
}

/**
 * Whether the translated-text overlay should render for a given layer view.
 * `original` hides the translated text (reviewer sees the cleaned art only —
 * "ตีกลับ layer" comparison); `both`/`translated` show it.
 */
export function shouldShowTranslatedOverlay(view: ReviewLayerView): boolean {
	return view !== "original";
}

/**
 * Whether to dim the underlying art so the original (pre-typeset) read is
 * emphasised. Only the explicit `original` view dims nothing here — we simply
 * hide the overlay; this hook exists for the `both` compare view to keep both
 * legible. Returns the overlay opacity (0..1).
 */
export function overlayOpacityForView(view: ReviewLayerView): number {
	if (view === "original") return 0;
	if (view === "both") return 0.85;
	return 1;
}

/**
 * A per-page height ESTIMATE (px) for long-scroll virtualization, before the real
 * image has decoded. Uses the column width × a typical portrait manga aspect,
 * biased slightly tall so estimates rarely undershoot (an undershoot makes the
 * strip jump as taller real pages push content down). Mirrors the editor strip's
 * `estimatePageHeight` intent but kept local so the reader never imports editor code.
 */
export function estimateReaderPageHeight(columnWidth: number, aspectRatio = 1.45): number {
	const width = columnWidth > 0 ? columnWidth : 1;
	const ratio = aspectRatio > 0 ? aspectRatio : 1.45;
	return Math.round(width * ratio);
}

/**
 * The height/width aspect ratio to use for a page's INITIAL slot height — before its
 * <img> has decoded and reported a measured height. Uses the page's resolved source
 * size (`height/width`) so a portrait scan and a wide spread each get an honest slot,
 * keeping the long-scroll virtualization geometry correct from the first paint (a
 * wrong/uniform estimate is what collapses the window to ~1 page). Falls back to a
 * typical portrait manga ratio when the source size is unknown.
 */
export function readerPageAspectRatio(page: Pick<ReviewReaderPage, "sourceSize">, fallback = 1.45): number {
	const size = page.sourceSize;
	if (size && size.width > 0 && size.height > 0) {
		return size.height / size.width;
	}
	return fallback > 0 ? fallback : 1.45;
}

/**
 * The honest INITIAL slot height (px) for a reader page at a given column width,
 * derived from the page's own aspect (see `readerPageAspectRatio`). Used to seed the
 * virtualization height array before any <img> decodes so the scroll geometry — and
 * therefore the rendered window — spans the whole chapter immediately.
 */
export function initialReaderPageHeight(
	page: Pick<ReviewReaderPage, "sourceSize">,
	columnWidth: number,
	fallbackAspect = 1.45,
): number {
	return estimateReaderPageHeight(columnWidth, readerPageAspectRatio(page, fallbackAspect));
}
