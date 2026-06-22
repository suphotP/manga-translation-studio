// Geometry for placing an AI result back onto the page as a region-only layer.
//
// The backend composites the edited crop back onto the FULL original page, so a
// marker's `resultImageId` is a full-page image. Pasting it full-size would
// replace the whole page; pasting it scaled into the crop box would squash the
// page into the region. The fix: place a layer at the crop region's
// position+size, and carry a `sourceCrop` so the editor draws ONLY that
// sub-rectangle of the (full-page) result image. Region-sized legacy results
// fall back to a plain full-image layer (no sourceCrop).

export type RegionRect = { x: number; y: number; w: number; h: number };

export type AiResultLayerGeometry = {
	/** Layer position+size on the page, in page-image pixels. */
	x: number;
	y: number;
	w: number;
	h: number;
	/**
	 * Sub-rectangle of the result image to draw, in result-image pixels. Set
	 * only when the result is larger than the region (i.e. a full-page composite),
	 * so the layer paints back exactly over the crop. `null` => draw the whole
	 * image (region-sized / legacy results).
	 */
	sourceCrop: RegionRect | null;
};

/** Relative tolerance for matching a result image's natural size to the page. */
const FULL_PAGE_MATCH_TOLERANCE = 0.02;

/**
 * Whether a result image's true natural size matches the FULL PAGE (within a
 * small tolerance for re-encode rounding). Only a full-page result is a
 * composite that must paint back via sourceCrop; anything else (region-sized
 * legacy results, or a raw provider-fallback result that is larger than the
 * region but NOT the page) is a plain region layer.
 */
export function resultMatchesFullPage(
	resultWidth: number,
	resultHeight: number,
	pageWidth: number,
	pageHeight: number,
): boolean {
	const rw = Math.round(resultWidth);
	const rh = Math.round(resultHeight);
	const pw = Math.round(pageWidth);
	const ph = Math.round(pageHeight);
	if (rw <= 0 || rh <= 0 || pw <= 0 || ph <= 0) return false;
	const matches = (a: number, b: number) =>
		Math.abs(a - b) <= Math.max(1, Math.round(b * FULL_PAGE_MATCH_TOLERANCE));
	return matches(rw, pw) && matches(rh, ph);
}

/**
 * Compute placement + source-crop for an AI result layer.
 *
 * sourceCrop is emitted ONLY when the result's true natural dimensions match
 * the FULL PAGE (within tolerance) — i.e. it is a full-page composite that must
 * paint back over just its crop region. Region-sized legacy results, and any
 * non-full-page result (e.g. a raw provider-fallback that is larger than the
 * region but not the page), are placed as plain region layers (no crop), which
 * avoids the clampSourceCrop drop/shift on a misclassified result.
 *
 * IMPORTANT: pass the result's RELIABLE natural dimensions (decode/measure the
 * loaded result image). Do not pass page-dimension fallbacks — that would make
 * a region-sized result look full-page and apply a bogus crop.
 *
 * @param region       Crop region in page-image pixels (the marker region).
 * @param pageWidth    Page image width in pixels.
 * @param pageHeight   Page image height in pixels.
 * @param resultWidth  TRUE natural width of the loaded result image.
 * @param resultHeight TRUE natural height of the loaded result image.
 */
export function buildAiResultLayerGeometry(
	region: RegionRect,
	pageWidth: number,
	pageHeight: number,
	resultWidth: number,
	resultHeight: number,
): AiResultLayerGeometry {
	const imageWidth = Math.max(1, Math.round(pageWidth));
	const imageHeight = Math.max(1, Math.round(pageHeight));
	const w = Math.max(8, Math.min(Math.round(region.w), imageWidth));
	const h = Math.max(8, Math.min(Math.round(region.h), imageHeight));
	const x = Math.max(0, Math.min(Math.round(region.x), Math.max(0, imageWidth - w)));
	const y = Math.max(0, Math.min(Math.round(region.y), Math.max(0, imageHeight - h)));
	const safeResultWidth = Math.max(1, Math.round(resultWidth));
	const safeResultHeight = Math.max(1, Math.round(resultHeight));
	// Crop ONLY a true full-page composite. A result that is region-sized, or
	// merely larger-than-region-but-not-page (raw provider fallback), draws whole
	// at the region — applying a crop there would drop/shift pixels.
	const isFullPageComposite = resultMatchesFullPage(safeResultWidth, safeResultHeight, imageWidth, imageHeight)
		// Guard: a degenerate page == region case must not crop (whole == region).
		&& (safeResultWidth > w || safeResultHeight > h);
	const sourceCrop = isFullPageComposite
		? {
			x: Math.max(0, Math.min(x, safeResultWidth - 1)),
			y: Math.max(0, Math.min(y, safeResultHeight - 1)),
			w: Math.max(1, Math.min(w, safeResultWidth - Math.min(x, safeResultWidth - 1))),
			h: Math.max(1, Math.min(h, safeResultHeight - Math.min(y, safeResultHeight - 1))),
		}
		: null;
	return { x, y, w, h, sourceCrop };
}
