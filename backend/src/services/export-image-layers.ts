// Server-side image-layer compositing for the export pipeline.
//
// Export parity: the CLIENT export (frontend/src/lib/project/page-export.ts)
// composites every visible `page.imageLayers[]` (placed reference images,
// AI-result images, pasted/placed layers) over the background in z-order. The
// server export pipeline historically composited ONLY text, silently dropping
// every placed image layer so a pipeline export did not match what the user
// sees or what the client ZIP produces.
//
// This helper mirrors the client geometry exactly — sourceCrop sub-rectangle,
// target box (w x h), flipX/flipY, rotation about the layer centre, opacity, and
// blend mode — using Sharp instead of Fabric. Layer ASSET BYTES are resolved
// through the SAME authoritative read path the pipeline uses for the background
// (`storage.getProjectImage`); client-supplied bytes are never trusted.
//
// Stacking: background -> image layers (by z-order) -> text. Image layers paint
// BELOW the SVG text pass (the common case: reference art / AI results sit under
// dialogue), matching the client's image-before-text tie-break within a shared
// z-order while keeping the server text path a single composite on top.

import sharp from "sharp";

export type ImageLayerSourceCropRect = { x: number; y: number; w: number; h: number };

/**
 * Clamp a layer's source-crop sub-rectangle to the natural image so it can never
 * read off the source. Returns null when there is no usable crop (no crop,
 * non-finite, zero-area, or a crop that already covers the whole image — in which
 * case a plain full-image draw is equivalent).
 *
 * This is an inlined, dependency-clean copy of the frontend
 * `image-layer-source-crop.ts` `clampSourceCrop` (the backend cannot import the
 * frontend package). Both MUST stay pixel-identical so an AI result composites the
 * same on the client ZIP and the server pipeline export.
 */
function clampSourceCrop(
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

export type ExportImageLayerBlendMode =
	| "normal"
	| "multiply"
	| "screen"
	| "overlay"
	| "soft-light";

const BLEND_MODES: readonly ExportImageLayerBlendMode[] = [
	"normal",
	"multiply",
	"screen",
	"overlay",
	"soft-light",
];

/**
 * A single image layer to composite, resolved to the minimum geometry the server
 * needs. Mirrors the visible-layer subset of the frontend `ImageLayer` that
 * `createExportImageObject` reads (position, target box, sourceCrop, flips,
 * rotation, opacity, blend mode). Persisted in the export job's render plan at
 * enqueue time so the processor is self-contained.
 */
export interface ExportImageLayerPlan {
	/** Source asset to read via the authoritative storage path (never trusted bytes). */
	imageId: string;
	/** Top-left placement + target box, in page (image-space) pixels. */
	x: number;
	y: number;
	w: number;
	h: number;
	rotation?: number;
	opacity?: number;
	flipX?: boolean;
	flipY?: boolean;
	blendMode?: ExportImageLayerBlendMode;
	/** Optional sub-rectangle of the SOURCE image (source pixels) to draw. */
	sourceCrop?: ImageLayerSourceCropRect;
	/** Z-order key (already resolved by the plan builder; lower paints first). */
	zIndex: number;
	/** Stable identity for diagnostics (layer id). */
	id?: string;
}

/** A layer asset that could not be resolved/composited, for honest reporting. */
export interface SkippedImageLayer {
	id?: string;
	imageId: string;
	reason: string;
}

export interface CompositeImageLayersResult {
	buffer: Buffer;
	composited: number;
	skipped: SkippedImageLayer[];
}

/** Resolve raw asset bytes for a layer. Mirrors the pipeline's background read. */
export type ImageLayerAssetResolver = (imageId: string) => Promise<Buffer | undefined>;

/**
 * Defense-in-depth readiness assertion for ONE layer asset, run BEFORE its bytes
 * are read/decoded. Mirrors `assertAssetReadyForAiAuthoritative`: a registered
 * asset must be storage-released AND moderation-passed, or this MUST throw so the
 * export job FAILS (we never silently composite unmoderated content, and we never
 * silently drop content the user placed). A legacy/unregistered asset (no record)
 * is allowed through for prototype compatibility — exactly like the AI guard with
 * `requireRegistry:false`. Omitted => no extra registry check (test/legacy callers).
 */
export type ImageLayerReadinessAssert = (imageId: string) => Promise<void>;

/**
 * Raised when an export layer violates a resource bound (count / source pixels /
 * target pixels). Surfaced as the job's error so a malicious or pathological
 * project state fails the export instead of exhausting CPU/memory in Sharp.
 */
export class ExportImageLayerLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExportImageLayerLimitError";
	}
}

/**
 * P1 (codex audit) DATA-SAFETY — a VISIBLE image layer whose asset is
 * missing/unreadable/undecodable could not be composited. For a durable
 * (publish-grade) export this MUST fail the job rather than silently shipping an
 * artifact with the user-placed layer DROPPED: a reader/publisher would otherwise
 * receive an export missing reference art / an AI result / a pasted layer, marked
 * "done". The export pipeline (the billable, durable artifact) fails closed by
 * default; only an explicit best-effort/draft preview passes `failOnSkipped: false`
 * to record the skip + flag it instead. Mirrors `ExportEditLayerMissingError`.
 *
 * NOTE: a registered-but-blocked/pending/unreleased asset is handled separately by
 * the readiness assert (`assertReady`) which throws BEFORE any byte read — that
 * already fails the job (never composited, never skipped) regardless of
 * `failOnSkipped`, so unmoderated content never leaks even on a draft preview.
 */
export class ExportImageLayerMissingError extends Error {
	readonly imageId: string;
	readonly reason: string;
	constructor(layer: { id?: string; imageId: string }, reason: string) {
		super(
			`Export image layer ${layer.id ?? layer.imageId} could not be composited: ${reason}. ` +
				`Failing the export so it does not silently drop a user-placed layer.`,
		);
		this.name = "ExportImageLayerMissingError";
		this.imageId = layer.imageId;
		this.reason = reason;
	}
}

/**
 * Generous-but-safe export-time resource bounds. These bound the TOTAL work a
 * single page composite can request BEFORE any large Sharp allocation, so N
 * layers × huge-each cannot OOM the worker. Aligned with the project's geometry
 * caps (single-dimension coordinates/sizes are bounded around 1e6 px elsewhere),
 * but here we bound the product (pixels) and the layer COUNT as well.
 */
export const EXPORT_LAYER_LIMITS = {
	/** Max visible image layers composited onto a single page. */
	maxVisibleLayersPerPage: 200,
	/**
	 * Max decoded SOURCE pixels for one layer asset (width × height of the stored
	 * image). Checked from Sharp metadata BEFORE the full pixel buffer is decoded.
	 * 100 MP comfortably covers a large manga scan while rejecting a decompression
	 * bomb that claims billions of pixels.
	 */
	maxSourcePixelsPerLayer: 100_000_000,
	/**
	 * Max TARGET pixels for one layer after crop/resize (the box it is drawn into).
	 * Bounds the per-layer raster Sharp must allocate even if the source is small.
	 */
	maxTargetPixelsPerLayer: 100_000_000,
	/**
	 * Max TOTAL target pixels summed across every composited layer on a page, so a
	 * page cannot request 200 × 100 MP of layer raster. Bounds the whole composite.
	 */
	maxTotalTargetPixelsPerPage: 400_000_000,
} as const;

function normalizeBlendMode(value: ExportImageLayerBlendMode | undefined): ExportImageLayerBlendMode {
	return value && BLEND_MODES.includes(value) ? value : "normal";
}

/**
 * Map an image-layer blend mode to a Sharp composite `blend` operator. Sharp uses
 * the same names as the canvas `globalCompositeOperation` the client renders with,
 * except "normal" -> "over". Anything unrecognized falls back to "over".
 */
function blendModeToSharpBlend(value: ExportImageLayerBlendMode | undefined): sharp.Blend {
	switch (normalizeBlendMode(value)) {
		case "multiply": return "multiply";
		case "screen": return "screen";
		case "overlay": return "overlay";
		case "soft-light": return "soft-light";
		case "normal":
		default:
			return "over";
	}
}

function clamp01(value: number | undefined, fallback = 1): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(1, value));
}

function roundPositive(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(1, Math.round(value));
}

/**
 * Prepare one image layer into a standalone RGBA Sharp buffer whose pixels are the
 * layer drawn at its target size (after crop, flips, opacity), plus the integer
 * top-left at which it should be composited onto the page. Rotation is applied
 * about the layer centre: Sharp's rotate expands the bounding box, so the returned
 * top-left is shifted to keep the layer's centre fixed (matching the client's
 * centre-origin Fabric placement).
 */
async function prepareLayerComposite(
	layer: ExportImageLayerPlan,
	sourceBuffer: Buffer,
): Promise<{ input: Buffer; left: number; top: number; blend: sharp.Blend } | null> {
	// Read dimensions FIRST (metadata only — does not decode the full pixel buffer)
	// so a decompression-bomb source is rejected before we allocate its raster.
	const meta = await sharp(sourceBuffer).metadata();
	const naturalWidth = Math.max(1, meta.width ?? 0);
	const naturalHeight = Math.max(1, meta.height ?? 0);
	if (naturalWidth <= 0 || naturalHeight <= 0) return null;

	const sourcePixels = naturalWidth * naturalHeight;
	if (sourcePixels > EXPORT_LAYER_LIMITS.maxSourcePixelsPerLayer) {
		throw new ExportImageLayerLimitError(
			`Export layer ${layer.id ?? layer.imageId} source is too large (${naturalWidth}x${naturalHeight} = ${sourcePixels} px exceeds ${EXPORT_LAYER_LIMITS.maxSourcePixelsPerLayer} px).`,
		);
	}

	const targetWidth = roundPositive(layer.w, 1);
	const targetHeight = roundPositive(layer.h, 1);

	const targetPixels = targetWidth * targetHeight;
	if (targetPixels > EXPORT_LAYER_LIMITS.maxTargetPixelsPerLayer) {
		throw new ExportImageLayerLimitError(
			`Export layer ${layer.id ?? layer.imageId} target box is too large (${targetWidth}x${targetHeight} = ${targetPixels} px exceeds ${EXPORT_LAYER_LIMITS.maxTargetPixelsPerLayer} px).`,
		);
	}

	let pipeline = sharp(sourceBuffer).ensureAlpha();

	// Source crop: draw ONLY the sub-rectangle (clamped to the natural image), so an
	// AI result stored as a full-page composite paints back only over its region —
	// the SAME clamp the client + live render use via clampSourceCrop.
	const crop = clampSourceCrop(layer.sourceCrop, naturalWidth, naturalHeight);
	if (crop) {
		pipeline = pipeline.extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h });
	}

	// Scale the (cropped) region onto the target box. fit:"fill" ignores aspect so
	// the box is filled exactly, matching the client's independent scaleX/scaleY.
	pipeline = pipeline.resize({ width: targetWidth, height: targetHeight, fit: "fill" });

	// Flips (client flipX/flipY). flop = horizontal mirror, flip = vertical.
	if (layer.flipX === true) pipeline = pipeline.flop();
	if (layer.flipY === true) pipeline = pipeline.flip();

	// Opacity: multiply the alpha channel by the layer opacity (0..1). Done on the
	// resized+flipped buffer (before rotation) so the transparent rotation padding
	// is unaffected.
	const opacity = clamp01(layer.opacity, 1);
	if (opacity < 1) {
		pipeline = sharp(await multiplyAlpha(pipeline, opacity)).ensureAlpha();
	}

	// Rotation about the centre. Sharp rotates around the centre and expands the
	// canvas to fit; recentre the expanded result on the layer's original centre.
	const rotation = typeof layer.rotation === "number" && Number.isFinite(layer.rotation) ? layer.rotation : 0;
	const normalizedRotation = ((rotation % 360) + 360) % 360;

	const centerX = layer.x + targetWidth / 2;
	const centerY = layer.y + targetHeight / 2;

	if (normalizedRotation !== 0) {
		pipeline = pipeline.rotate(normalizedRotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
	}

	const rendered = await pipeline.png().toBuffer({ resolveWithObject: true });
	const renderedWidth = rendered.info.width;
	const renderedHeight = rendered.info.height;

	const left = Math.round(centerX - renderedWidth / 2);
	const top = Math.round(centerY - renderedHeight / 2);

	return {
		input: rendered.data,
		left,
		top,
		blend: blendModeToSharpBlend(layer.blendMode),
	};
}

/**
 * Multiply a layer's alpha channel by `opacity` (0..1) and return a PNG buffer.
 * Reads the raw RGBA pixels and scales each alpha byte, which is an exact
 * `alpha *= opacity` (matching the client's per-object opacity) with no blend-mode
 * trickery. Premultiplied edge color is untouched (we only scale the alpha).
 */
async function multiplyAlpha(pipeline: sharp.Sharp, opacity: number): Promise<Buffer> {
	const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const channels = info.channels;
	if (channels >= 4) {
		for (let i = 3; i < data.length; i += channels) {
			data[i] = Math.round(data[i]! * opacity);
		}
	}
	return sharp(data, { raw: { width: info.width, height: info.height, channels } }).png().toBuffer();
}

/**
 * Composite the given visible image layers onto `backgroundBuffer` in z-order,
 * returning a PNG buffer. Layers are sorted ascending by `zIndex` (the plan
 * builder pre-resolves zIndex with an array-index fallback, image-before-text), so
 * the on-page stacking matches the client export. A layer whose asset bytes cannot
 * be resolved (missing/unreadable) is SKIPPED and recorded rather than aborting the
 * page — matching the client's per-layer honesty. When no layers composite, the
 * original background buffer is returned unchanged (byte-identical for text-only
 * pages).
 */
export async function compositeImageLayers(
	backgroundBuffer: Buffer,
	layers: ExportImageLayerPlan[] | undefined,
	resolveAsset: ImageLayerAssetResolver,
	options: {
		assertReady?: ImageLayerReadinessAssert;
		/**
		 * P1 (codex audit) — when true (the DEFAULT, used by the durable export
		 * pipeline / publish profiles), a visible image layer whose asset is
		 * missing/unreadable/undecodable throws {@link ExportImageLayerMissingError}
		 * so the job fails closed instead of silently dropping a user-placed layer.
		 * Best-effort/draft callers pass false to keep the per-layer skip+report
		 * behaviour (the skip is still flagged in the result, never silently lost).
		 * Either way, a blocked/pending/unreleased asset still throws via `assertReady`.
		 */
		failOnSkipped?: boolean;
	} = {},
): Promise<CompositeImageLayersResult> {
	const failOnSkipped = options.failOnSkipped !== false;
	const visible = (layers ?? []).filter((layer) => layer && layer.imageId);
	if (visible.length === 0) {
		return { buffer: backgroundBuffer, composited: 0, skipped: [] };
	}

	// DoS bound #1: reject an absurd layer count BEFORE any asset read/decode, so a
	// huge project state fails the job rather than fanning out into Sharp work.
	if (visible.length > EXPORT_LAYER_LIMITS.maxVisibleLayersPerPage) {
		throw new ExportImageLayerLimitError(
			`Export page has too many visible image layers (${visible.length} exceeds ${EXPORT_LAYER_LIMITS.maxVisibleLayersPerPage}).`,
		);
	}

	// DoS bound #2: reject an absurd TOTAL target raster across the page BEFORE any
	// decode (the per-layer caps still apply in prepareLayerComposite).
	let totalTargetPixels = 0;
	for (const layer of visible) {
		const targetWidth = roundPositive(layer.w, 1);
		const targetHeight = roundPositive(layer.h, 1);
		totalTargetPixels += targetWidth * targetHeight;
		if (totalTargetPixels > EXPORT_LAYER_LIMITS.maxTotalTargetPixelsPerPage) {
			throw new ExportImageLayerLimitError(
				`Export page target raster is too large (sum of layer boxes exceeds ${EXPORT_LAYER_LIMITS.maxTotalTargetPixelsPerPage} px).`,
			);
		}
	}

	const ordered = [...visible].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

	const skipped: SkippedImageLayer[] = [];
	const composites: sharp.OverlayOptions[] = [];

	// Cache resolved+decoded source bytes by imageId so a layer reused across the
	// page (e.g. a credit strip placed twice) is read/decoded once.
	const assetCache = new Map<string, Buffer | undefined>();
	// Cache the readiness verdict so a reused asset is asserted once. A passed
	// assert stores `null`; the assert THROWS for a blocked/pending asset and the
	// throw propagates (the job fails), so we never cache a failure.
	const readyCache = new Set<string>();

	for (const layer of ordered) {
		// Defense-in-depth readiness gate (PR #320's route gate may be bypassed on a
		// direct/reprocess enqueue). A blocked/pending/unreleased layer asset throws
		// here and FAILS the whole export — never silently skipped, never composited.
		if (options.assertReady && !readyCache.has(layer.imageId)) {
			await options.assertReady(layer.imageId);
			readyCache.add(layer.imageId);
		}
		try {
			let sourceBuffer = assetCache.get(layer.imageId);
			if (!assetCache.has(layer.imageId)) {
				sourceBuffer = await resolveAsset(layer.imageId);
				assetCache.set(layer.imageId, sourceBuffer);
			}
			if (!sourceBuffer) {
				if (failOnSkipped) throw new ExportImageLayerMissingError(layer, "asset not found");
				skipped.push({ id: layer.id, imageId: layer.imageId, reason: "asset not found" });
				continue;
			}
			const prepared = await prepareLayerComposite(layer, sourceBuffer);
			if (!prepared) {
				if (failOnSkipped) throw new ExportImageLayerMissingError(layer, "undecodable layer asset");
				skipped.push({ id: layer.id, imageId: layer.imageId, reason: "undecodable layer asset" });
				continue;
			}
			composites.push({ input: prepared.input, left: prepared.left, top: prepared.top, blend: prepared.blend });
		} catch (error) {
			// Resource-limit violations are NOT recoverable per-layer honesty cases —
			// they signal a pathological/malicious page and must FAIL the job, so
			// rethrow instead of recording a skip.
			if (error instanceof ExportImageLayerLimitError) throw error;
			// Fail-closed (publish): a missing/undecodable/unexpected read error must
			// FAIL the durable export rather than silently dropping the user-placed
			// layer. A readiness throw (blocked/pending asset) propagates here too and
			// must always fail the job. Draft/best-effort callers record + continue.
			if (error instanceof ExportImageLayerMissingError) throw error;
			if (failOnSkipped) throw new ExportImageLayerMissingError(layer, error instanceof Error ? error.message : String(error));
			skipped.push({
				id: layer.id,
				imageId: layer.imageId,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (composites.length === 0) {
		return { buffer: backgroundBuffer, composited: 0, skipped };
	}

	const buffer = await sharp(backgroundBuffer).composite(composites).png().toBuffer();
	return { buffer, composited: composites.length, skipped };
}
