// Wave 3 W3.16: bulk image import transforms (server-side stitch + split).
//
// Two pure, sharp-backed operations used by the bulk-import upload path:
//
//  - mergeImagesVertically(buffers, perPage): stitch N source images into one
//    tall page (webtoon convention). Images are scaled to the median source
//    width and stacked top-to-bottom, producing a single PNG buffer.
//  - splitTallImage(buffer, maxHeight): reverse op — slice a too-tall image into
//    page-sized chunks no taller than maxHeight, each a standalone PNG buffer.
//
// Both operate purely on buffers so they can be unit tested without storage,
// HTTP, or the asset pipeline. The route layer routes the resulting buffers
// through the normal asset pipeline (recordUploadedAsset) and SHA-dedupes them.

import sharp from "sharp";

export const DEFAULT_MERGE_PER_PAGE = 3;
export const MIN_MERGE_PER_PAGE = 2;
export const MAX_MERGE_PER_PAGE = 50;
// Tall images above this many pixels are eligible for auto-split. Webtoon strips
// frequently arrive as one enormous file; >5000px is the spec threshold.
export const DEFAULT_TALL_SPLIT_THRESHOLD_PX = 5000;
// A single output chunk's max height. Defaults to the threshold so a 12000px
// strip becomes ~3 chunks of <=5000px rather than many tiny slices.
export const DEFAULT_SPLIT_CHUNK_HEIGHT_PX = DEFAULT_TALL_SPLIT_THRESHOLD_PX;

export interface MergeResult {
	buffer: Buffer;
	width: number;
	height: number;
	sourceCount: number;
}

export interface SplitChunk {
	buffer: Buffer;
	width: number;
	height: number;
	/** 0-based index of this chunk within the source image. */
	chunkIndex: number;
	/** y-offset (in source pixels) where this chunk started. */
	sourceY: number;
}

export class ImageTransformError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ImageTransformError";
	}
}

/**
 * The per-page output ceiling a split chunk must never exceed. splitTallImage uses
 * this to clamp the effective chunk height (and to reject an un-splittable source)
 * BEFORE it decodes/encodes any single buffer, so the largest image sharp ever
 * materializes is bounded at a per-page-sized image even when the caller passes a
 * huge splitThreshold. The MEGAPIXEL term is the real bomb guard; maxHeight only
 * bounds a degenerate single side.
 */
export interface SplitPixelCeiling {
	maxHeight: number;
	maxPixels: number;
}

export function clampPerPage(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MERGE_PER_PAGE;
	const rounded = Math.round(value);
	return Math.max(MIN_MERGE_PER_PAGE, Math.min(MAX_MERGE_PER_PAGE, rounded));
}

export function clampSplitThreshold(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_TALL_SPLIT_THRESHOLD_PX;
	}
	// Never allow a threshold below 256px — that would shred ordinary pages.
	return Math.max(256, Math.round(value));
}

/**
 * Group an ordered list of items into chunks of `perPage` length. The final
 * group keeps whatever remains (so 7 images at perPage=3 -> [3,3,1]).
 */
export function groupForMerge<T>(items: readonly T[], perPage: number): T[][] {
	const size = clampPerPage(perPage);
	const groups: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		groups.push(items.slice(i, i + size));
	}
	return groups;
}

async function readImageMetadata(buffer: Buffer): Promise<{ width: number; height: number }> {
	let metadata: sharp.Metadata;
	try {
		metadata = await sharp(buffer, { sequentialRead: true }).metadata();
	} catch (error) {
		throw new ImageTransformError("Image is not decodable", { cause: error });
	}
	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;
	if (width <= 0 || height <= 0) {
		throw new ImageTransformError("Image has no usable dimensions");
	}
	return { width, height };
}

function medianWidth(widths: readonly number[]): number {
	// Callers always pass >=2 validated-positive widths, but guard explicitly:
	// an empty array would otherwise produce NaN (`?? 1` cannot catch NaN).
	if (widths.length === 0) return 1;
	const sorted = widths.slice().sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 1
		? sorted[middle]!
		: (sorted[middle - 1]! + sorted[middle]!) / 2;
	return Math.max(1, Math.round(median));
}

/**
 * Stitch the given source image buffers into a single tall page. Each source is
 * resized to the median source width preserving aspect ratio, then stacked
 * top-to-bottom in the order given. Returns a PNG buffer (lossless so repeated
 * import + merge does not visibly degrade text-heavy manga).
 */
export async function mergeImagesVertically(
	buffers: readonly Buffer[],
	options: { maxOutputPixels?: number } = {},
): Promise<MergeResult> {
	const maxOutputPixels =
		typeof options.maxOutputPixels === "number" && Number.isFinite(options.maxOutputPixels) && options.maxOutputPixels > 0
			? options.maxOutputPixels
			: Number.POSITIVE_INFINITY;
	const [first, ...rest] = buffers;
	if (!first) {
		throw new ImageTransformError("mergeImagesVertically requires at least one image");
	}
	if (rest.length === 0) {
		const meta = await readImageMetadata(first);
		if (meta.width * meta.height > maxOutputPixels) {
			throw new ImageTransformError(
				`Merged page is too large (${meta.width}×${meta.height}px exceeds the ${maxOutputPixels}px limit)`,
			);
		}
		// Single image: normalize to PNG so the merged-output pipeline is uniform.
		const buffer = await sharp(first, { sequentialRead: true }).png().toBuffer();
		return { buffer, width: meta.width, height: meta.height, sourceCount: 1 };
	}

	const sized = await Promise.all(buffers.map(async (buffer) => ({
		buffer,
		meta: await readImageMetadata(buffer),
	})));
	const targetWidth = medianWidth(sized.map((item) => item.meta.width));

	// Bound the composed canvas BEFORE we resize/composite: at the common width,
	// sum the scaled tile heights and reject the merge if the resulting canvas
	// would exceed the pixel ceiling, so sharp never allocates a runaway buffer.
	const projectedHeight = sized.reduce(
		(sum, { meta }) => sum + Math.max(1, Math.round((targetWidth / meta.width) * meta.height)),
		0,
	);
	if (targetWidth * projectedHeight > maxOutputPixels) {
		throw new ImageTransformError(
			`Merged page is too large (${targetWidth}×${projectedHeight}px exceeds the ${maxOutputPixels}px limit)`,
		);
	}

	const resized: Array<{ buffer: Buffer; width: number; height: number }> = [];
	let totalHeight = 0;
	let tileNumber = 0;
	for (const { buffer, meta } of sized) {
		tileNumber++;
		// Scale each tile up/down to the common width; keep aspect ratio.
		const scaledHeight = Math.max(1, Math.round((targetWidth / meta.width) * meta.height));
		let tileBuffer: Buffer;
		try {
			tileBuffer = await sharp(buffer, { sequentialRead: true })
				.resize({ width: targetWidth, height: scaledHeight, fit: "fill" })
				.png()
				.toBuffer();
		} catch (error) {
			throw new ImageTransformError(`Failed to resize image ${tileNumber} for merge`, { cause: error });
		}
		resized.push({ buffer: tileBuffer, width: targetWidth, height: scaledHeight });
		totalHeight += scaledHeight;
	}

	const composite = resized.reduce<{ inputs: sharp.OverlayOptions[]; top: number }>(
		(acc, tile) => {
			acc.inputs.push({ input: tile.buffer, left: 0, top: acc.top });
			acc.top += tile.height;
			return acc;
		},
		{ inputs: [], top: 0 },
	);

	let buffer: Buffer;
	try {
		buffer = await sharp({
			create: {
				width: targetWidth,
				height: totalHeight,
				channels: 4,
				background: { r: 255, g: 255, b: 255, alpha: 1 },
			},
		})
			.composite(composite.inputs)
			.png()
			.toBuffer();
	} catch (error) {
		throw new ImageTransformError("Failed to stitch merged page", { cause: error });
	}

	return { buffer, width: targetWidth, height: totalHeight, sourceCount: buffers.length };
}

/**
 * Slice a tall image into vertical chunks no taller than `maxChunkHeight`. The
 * last chunk keeps the remainder (so a 12000px image at 5000px -> 5000/5000/2000).
 * Images at or below the threshold are returned as a single normalized chunk.
 */
export async function splitTallImage(
	buffer: Buffer,
	options: {
		thresholdPx?: number;
		maxChunkHeight?: number;
		minChunkHeight?: number;
		/**
		 * Per-page output ceiling. When given, the effective chunk height is clamped
		 * so a single chunk's WIDTH×HEIGHT never exceeds the per-page MP/height cap —
		 * this prevents a client-supplied splitThreshold (e.g. 200000) from forcing a
		 * full-image decode/encode of an enormous split source before the route's
		 * per-page output validation can 413 it. The DoS guard is enforced BEFORE any
		 * sharp(...).toBuffer() runs.
		 */
		pixelCeiling?: SplitPixelCeiling;
	} = {},
): Promise<SplitChunk[]> {
	const requestedThreshold = clampSplitThreshold(options.thresholdPx);
	const requestedMaxChunkHeight = clampSplitThreshold(options.maxChunkHeight ?? requestedThreshold);
	const minChunkHeight =
		typeof options.minChunkHeight === "number" && Number.isFinite(options.minChunkHeight) && options.minChunkHeight > 0
			? Math.round(options.minChunkHeight)
			: 1;
	const { width, height } = await readImageMetadata(buffer);

	// Bound the effective chunk height to the per-page ceiling BEFORE we decode the
	// source. For a strip of this width, a chunk taller than floor(maxPixels / width)
	// would exceed the per-page megapixel cap; a chunk taller than maxHeight exceeds
	// the per-side cap. We take the tighter of the two and the caller's request, so
	// the no-split branch below can only fire for a source small enough to be a valid
	// single page, and every produced slice is per-page-bounded.
	let maxChunkHeight = requestedMaxChunkHeight;
	let threshold = requestedThreshold;
	if (options.pixelCeiling) {
		const { maxHeight, maxPixels } = options.pixelCeiling;
		const heightCapFromPixels = width > 0 ? Math.floor(maxPixels / width) : maxHeight;
		// The hard per-page-safe chunk height for this strip width. No produced chunk
		// (including one that absorbs a runt tail) may exceed it.
		const ceilingChunkHeight = Math.max(1, Math.min(maxHeight, heightCapFromPixels));
		// Reserve headroom equal to the largest runt that can be folded into a chunk
		// (minChunkHeight - 1), so the runt-absorbing fold below never pushes a chunk
		// past ceilingChunkHeight. Keep at least 1px so a degenerate tiny ceiling still
		// produces progress.
		const headroom = Math.max(0, minChunkHeight - 1);
		const safeChunkHeight = Math.max(1, ceilingChunkHeight - headroom);
		maxChunkHeight = Math.min(maxChunkHeight, safeChunkHeight);
		// The no-split threshold must not exceed the per-page-safe chunk height, or a
		// source between (ceiling, requestedThreshold] would skip chunking and be
		// decoded whole. Clamp it down to the effective chunk height.
		threshold = Math.min(threshold, maxChunkHeight);
	}

	if (height <= threshold) {
		// Not tall enough to split — return a single normalized PNG chunk. Because
		// threshold <= the per-page-safe chunk height (when a ceiling is supplied),
		// this single decode can never exceed the per-page output ceiling.
		const single = await sharp(buffer, { sequentialRead: true }).png().toBuffer();
		return [{ buffer: single, width, height, chunkIndex: 0, sourceY: 0 }];
	}

	// Pre-compute the slice boundaries [top, height) so we can fold a too-small
	// trailing remainder into the previous chunk. Otherwise a tall source whose
	// height % maxChunkHeight is below the upload pipeline's minimum (e.g. a 20px
	// tail) would produce a chunk the transform route immediately rejects with
	// image_dimensions_too_small, failing the whole import.
	const boundaries: Array<{ top: number; sliceHeight: number }> = [];
	for (let top = 0; top < height; top += maxChunkHeight) {
		const sliceHeight = Math.min(maxChunkHeight, height - top);
		if (sliceHeight <= 0) break;
		boundaries.push({ top, sliceHeight });
	}
	if (boundaries.length > 1) {
		const last = boundaries[boundaries.length - 1]!;
		if (last.sliceHeight < minChunkHeight) {
			// Absorb the runt tail into the prior chunk (which may then slightly
			// exceed maxChunkHeight — acceptable; it stays a single valid page).
			const prev = boundaries[boundaries.length - 2]!;
			prev.sliceHeight += last.sliceHeight;
			boundaries.pop();
		}
	}

	const chunks: SplitChunk[] = [];
	let chunkIndex = 0;
	for (const { top, sliceHeight } of boundaries) {
		let sliceBuffer: Buffer;
		try {
			sliceBuffer = await sharp(buffer, { sequentialRead: true })
				.extract({ left: 0, top, width, height: sliceHeight })
				.png()
				.toBuffer();
		} catch (error) {
			throw new ImageTransformError(`Failed to slice tall image at y=${top}`, { cause: error });
		}
		chunks.push({ buffer: sliceBuffer, width, height: sliceHeight, chunkIndex, sourceY: top });
		chunkIndex++;
	}

	return chunks;
}
