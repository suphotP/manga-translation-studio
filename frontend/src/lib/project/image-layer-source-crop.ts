// Shared source-crop placement math for image layers.
//
// Dependency-clean (no Fabric, no DOM) so EVERY render/export path can apply
// the SAME sourceCrop logic and stay pixel-identical: the live canvas render
// (canvas/editor.ts createImageObject), the single-page export
// (canvas/editor.ts createExportImageObject) and the batch/zip export
// (project/page-export.ts createExportImageObject) all import from here.
//
// An AI result is stored as a FULL-PAGE composite but must paint back ONLY over
// its crop region; applying the crop + crop-aware scale here means no path can
// squeeze the whole page into the region box.

export type ImageLayerSourceCropRect = { x: number; y: number; w: number; h: number };

/**
 * Clamp a layer's source-crop sub-rectangle to the natural image so it can
 * never read off the source. Returns null when there is no usable crop (no
 * crop, non-finite, zero-area, or a crop that already covers the whole image —
 * in which case a plain full-image draw is equivalent and cheaper).
 */
export function clampSourceCrop(
	crop: ImageLayerSourceCropRect | null | undefined,
	naturalWidth: number,
	naturalHeight: number,
): ImageLayerSourceCropRect | null {
	if (!crop) return null;
	if (![crop.x, crop.y, crop.w, crop.h].every((value) => Number.isFinite(value))) return null;
	if (naturalWidth <= 0 || naturalHeight <= 0) return null;
	const x = Math.max(0, Math.min(Math.round(crop.x), naturalWidth - 1));
	const y = Math.max(0, Math.min(Math.round(crop.y), naturalHeight - 1));
	const w = Math.max(1, Math.min(Math.round(crop.w), naturalWidth - x));
	const h = Math.max(1, Math.min(Math.round(crop.h), naturalHeight - y));
	if (w <= 0 || h <= 0) return null;
	// Crop covers the whole image: equivalent to no crop.
	if (x === 0 && y === 0 && w >= naturalWidth && h >= naturalHeight) return null;
	return { x, y, w, h };
}

/**
 * Shared source-crop placement math for image layers, used by ALL of the live
 * render (`createImageObject`), the single-page export builder
 * (`createExportImageObject` in canvas/editor.ts) and the batch/zip export
 * builder (`createExportImageObject` in project/page-export.ts) so an AI result
 * composites identically on screen and on every export.
 *
 * Given the layer's stored `sourceCrop` and the result image's true natural
 * dimensions, it returns the fabric source-crop (cropX/cropY/width/height, in
 * source-image pixels) plus the scale factors that map the drawn sub-rectangle
 * onto the target box. When there is no usable crop, `crop` is null and the
 * scale maps the FULL natural image onto the target box (plain layer).
 */
export function resolveImageLayerSourceCrop(input: {
	sourceCrop: ImageLayerSourceCropRect | null | undefined;
	naturalWidth: number;
	naturalHeight: number;
	targetWidth: number;
	targetHeight: number;
}): {
	crop: ImageLayerSourceCropRect | null;
	drawWidth: number;
	drawHeight: number;
	scaleX: number;
	scaleY: number;
} {
	const naturalWidth = Math.max(1, input.naturalWidth);
	const naturalHeight = Math.max(1, input.naturalHeight);
	const crop = clampSourceCrop(input.sourceCrop, naturalWidth, naturalHeight);
	const drawWidth = crop ? crop.w : naturalWidth;
	const drawHeight = crop ? crop.h : naturalHeight;
	return {
		crop,
		drawWidth,
		drawHeight,
		scaleX: input.targetWidth / drawWidth,
		scaleY: input.targetHeight / drawHeight,
	};
}
