// Server-side NON-DESTRUCTIVE image-edit-layer compositing for the export pipeline
// (Phase A — bubble-clean).
//
// Export parity: the CLIENT export (frontend/src/lib/project/page-export.ts) and the
// live editor composite each `page.imageEditLayers[]` fill-mask over the ORIGINAL
// page background BEFORE image/text layers: a solid `fill` colour clipped by a tiny
// alpha-only mask asset, drawn at the layer's bbox. This helper mirrors that exactly
// with Sharp so a pipeline export matches the client ZIP + on-canvas render.
//
// Stacking: background -> EDIT LAYERS (bubble-clean cleans) -> image layers -> text.
// Edit layers paint FIRST (they are raster cleanup of the background itself), so a
// placed reference image / AI result / dialogue still sits above the cleaned area.
//
// Mask ASSET BYTES are resolved through the SAME authoritative read path the
// pipeline uses for the background (`storage.getProjectImage`); client-supplied bytes
// are never trusted.

import sharp from "sharp";

export interface ExportEditLayerFill {
	r: number;
	g: number;
	b: number;
	a: number;
}

/**
 * A single non-destructive fill-mask edit layer resolved to the minimum geometry the
 * server needs. Persisted in the export job's render plan at enqueue time so the
 * processor is self-contained.
 */
export interface ExportEditLayerPlan {
	/** Stable identity for diagnostics (edit layer id). */
	id?: string;
	/**
	 * Edit-layer kind. `fill-mask` (Phase A) composites a solid `fill` clipped by the
	 * `maskAssetId` alpha. Phase B `patch`/`healing`/`clone` composite a REALIZED RGBA
	 * ROI asset (`maskAssetId` holds the realized patch id) verbatim at bbox. Absent =
	 * `fill-mask` (legacy plans).
	 */
	kind?: "fill-mask" | "patch" | "healing" | "clone";
	/**
	 * For `fill-mask`: the alpha-only mask asset. For Phase B kinds: the realized RGBA
	 * patch asset. Read via the authoritative storage path (never trusted bytes).
	 */
	maskAssetId: string;
	/** Solid fill painted where the mask alpha is set (fill-mask only; ignored for Phase B). */
	fill: ExportEditLayerFill;
	/** Image-space bbox (native page pixels) the edit covers / the asset maps to. */
	bbox: { x: number; y: number; w: number; h: number };
	/** Layer opacity (0..1). */
	opacity?: number;
	/** Stack order key (lower paints first). */
	index: number;
}

/** Resolve raw mask asset bytes. Mirrors the pipeline's background read. */
export type EditLayerAssetResolver = (imageId: string) => Promise<Buffer | undefined>;

/** Readiness assertion for one mask asset, run BEFORE its bytes are read. */
export type EditLayerReadinessAssert = (imageId: string) => Promise<void>;

/** A mask asset that could not be resolved/composited, for honest reporting. */
export interface SkippedEditLayer {
	id?: string;
	maskAssetId: string;
	reason: string;
}

export interface CompositeEditLayersResult {
	buffer: Buffer;
	composited: number;
	skipped: SkippedEditLayer[];
}

export class ExportEditLayerLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExportEditLayerLimitError";
	}
}

/**
 * P1-c DATA-SAFETY — a VISIBLE edit layer whose mask asset is missing/unreadable
 * could not be composited. For a durable (publish-grade) export this MUST fail the
 * job rather than silently shipping the un-cleaned source: a reader would otherwise
 * receive an artifact with the dialogue NOT cleaned, marked "done". The export
 * pipeline (the billable, durable artifact) throws this; the only callers that pass
 * `failOnSkipped: false` are explicitly best-effort/draft previews that record the
 * skip + flag it instead.
 */
export class ExportEditLayerMissingError extends Error {
	readonly maskAssetId: string;
	readonly reason: string;
	constructor(layer: { id?: string; maskAssetId: string }, reason: string) {
		super(
			`Export edit layer ${layer.id ?? layer.maskAssetId} could not be composited: ${reason}. ` +
				`Failing the export so it does not silently ship the un-cleaned source.`,
		);
		this.name = "ExportEditLayerMissingError";
		this.maskAssetId = layer.maskAssetId;
		this.reason = reason;
	}
}

export const EXPORT_EDIT_LAYER_LIMITS = {
	/** Max visible edit layers composited onto a single page. */
	maxEditLayersPerPage: 1_000,
	/** Max decoded mask pixels for one layer (width × height of its bbox). */
	maxMaskPixelsPerLayer: 100_000_000,
	/** Max TOTAL mask pixels summed across a page. */
	maxTotalMaskPixelsPerPage: 400_000_000,
} as const;

function clamp01(value: number | undefined, fallback = 1): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(1, value));
}

function clampByte(value: number | undefined, fallback = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(255, Math.round(value)));
}

function roundNonNegative(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.round(value);
}

function roundPositive(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.round(value);
}

/**
 * Build one fill-mask edit layer into a standalone RGBA Sharp overlay (the solid
 * fill colour clipped by the mask's alpha, resized to the bbox + opacity-scaled),
 * plus the integer top-left at which it composites onto the page. Returns null when
 * the mask is undecodable / the bbox is empty.
 */
async function prepareEditLayerComposite(
	layer: ExportEditLayerPlan,
	maskBuffer: Buffer,
): Promise<{ input: Buffer; left: number; top: number } | null> {
	const w = roundPositive(layer.bbox.w);
	const h = roundPositive(layer.bbox.h);
	if (w <= 0 || h <= 0) return null;

	const maskPixels = w * h;
	if (maskPixels > EXPORT_EDIT_LAYER_LIMITS.maxMaskPixelsPerLayer) {
		throw new ExportEditLayerLimitError(
			`Export edit layer ${layer.id ?? layer.maskAssetId} mask is too large (${w}x${h} = ${maskPixels} px exceeds ${EXPORT_EDIT_LAYER_LIMITS.maxMaskPixelsPerLayer} px).`,
		);
	}

	const opacityScale = clamp01(layer.opacity, 1);

	// Phase B — `patch` / `healing` / `clone` composite the REALIZED RGBA ROI asset
	// verbatim at bbox (its own RGBA carries the painted/healed/cloned pixels + the
	// brush-coverage alpha), matching the client's `drawImage(patch, x, y)`. The fill
	// colour is irrelevant here. Resize to the bbox (fit:fill) so a downscaled/cached
	// patch still aligns, and scale its alpha by the layer opacity.
	if (layer.kind === "patch" || layer.kind === "healing" || layer.kind === "clone") {
		const { data, info } = await sharp(maskBuffer)
			.ensureAlpha()
			.resize({ width: w, height: h, fit: "fill" })
			.raw()
			.toBuffer({ resolveWithObject: true });
		const channels = info.channels;
		if (channels < 4) return null;
		const out = Buffer.alloc(w * h * 4);
		for (let i = 0; i < w * h; i++) {
			const so = i * channels;
			const oo = i * 4;
			out[oo] = data[so] ?? 0;
			out[oo + 1] = data[so + 1] ?? 0;
			out[oo + 2] = data[so + 2] ?? 0;
			out[oo + 3] = Math.round((data[so + 3] ?? 0) * opacityScale);
		}
		const input = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
		return { input, left: roundNonNegative(layer.bbox.x), top: roundNonNegative(layer.bbox.y) };
	}

	// Decode the mask to raw RGBA at the bbox size and read its alpha as the coverage,
	// EXACTLY matching the client's "png-alpha" read (frontend page-export.ts).
	const { data, info } = await sharp(maskBuffer)
		.ensureAlpha()
		.resize({ width: w, height: h, fit: "fill" })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const channels = info.channels;
	if (channels < 4) return null;

	const r = clampByte(layer.fill.r);
	const g = clampByte(layer.fill.g);
	const b = clampByte(layer.fill.b);

	// Build an RGBA buffer: the solid fill where alpha = mask coverage * opacity.
	const out = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const so = i * channels;
		const oo = i * 4;
		const coverage = data[so + 3] ?? 0;
		out[oo] = r;
		out[oo + 1] = g;
		out[oo + 2] = b;
		out[oo + 3] = Math.round(coverage * opacityScale);
	}
	const input = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
	return { input, left: roundNonNegative(layer.bbox.x), top: roundNonNegative(layer.bbox.y) };
}

/**
 * Composite the given fill-mask edit layers onto `backgroundBuffer` in index order,
 * returning a PNG buffer. A mask asset that cannot be resolved (missing/unreadable)
 * is SKIPPED and recorded rather than aborting the page — matching the client's
 * per-layer honesty. When no layers composite, the original background is returned
 * unchanged (byte-identical for pages with no edit layers).
 */
export async function compositeEditLayers(
	backgroundBuffer: Buffer,
	layers: ExportEditLayerPlan[] | undefined,
	resolveAsset: EditLayerAssetResolver,
	options: {
		assertReady?: EditLayerReadinessAssert;
		/**
		 * P1-c — when true (the DEFAULT, used by the durable export pipeline), a visible
		 * edit layer whose mask is missing/unreadable throws {@link ExportEditLayerMissingError}
		 * so the job fails closed instead of silently exporting the un-cleaned source.
		 * Best-effort/draft callers pass false to keep the per-layer skip+report behaviour.
		 */
		failOnSkipped?: boolean;
	} = {},
): Promise<CompositeEditLayersResult> {
	const failOnSkipped = options.failOnSkipped !== false;
	const visible = (layers ?? []).filter((layer) => layer && layer.maskAssetId);
	if (visible.length === 0) {
		return { buffer: backgroundBuffer, composited: 0, skipped: [] };
	}

	if (visible.length > EXPORT_EDIT_LAYER_LIMITS.maxEditLayersPerPage) {
		throw new ExportEditLayerLimitError(
			`Export page has too many edit layers (${visible.length} exceeds ${EXPORT_EDIT_LAYER_LIMITS.maxEditLayersPerPage}).`,
		);
	}
	let totalMaskPixels = 0;
	for (const layer of visible) {
		totalMaskPixels += roundPositive(layer.bbox.w) * roundPositive(layer.bbox.h);
		if (totalMaskPixels > EXPORT_EDIT_LAYER_LIMITS.maxTotalMaskPixelsPerPage) {
			throw new ExportEditLayerLimitError(
				`Export page edit-layer mask raster is too large (exceeds ${EXPORT_EDIT_LAYER_LIMITS.maxTotalMaskPixelsPerPage} px).`,
			);
		}
	}

	const ordered = [...visible].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	const skipped: SkippedEditLayer[] = [];
	const composites: sharp.OverlayOptions[] = [];
	const assetCache = new Map<string, Buffer | undefined>();
	const readyCache = new Set<string>();

	for (const layer of ordered) {
		if (options.assertReady && !readyCache.has(layer.maskAssetId)) {
			await options.assertReady(layer.maskAssetId);
			readyCache.add(layer.maskAssetId);
		}
		try {
			let maskBuffer = assetCache.get(layer.maskAssetId);
			if (!assetCache.has(layer.maskAssetId)) {
				maskBuffer = await resolveAsset(layer.maskAssetId);
				assetCache.set(layer.maskAssetId, maskBuffer);
			}
			if (!maskBuffer) {
				if (failOnSkipped) throw new ExportEditLayerMissingError(layer, "mask asset not found");
				skipped.push({ id: layer.id, maskAssetId: layer.maskAssetId, reason: "mask asset not found" });
				continue;
			}
			const prepared = await prepareEditLayerComposite(layer, maskBuffer);
			if (!prepared) {
				if (failOnSkipped) throw new ExportEditLayerMissingError(layer, "undecodable mask asset");
				skipped.push({ id: layer.id, maskAssetId: layer.maskAssetId, reason: "undecodable mask asset" });
				continue;
			}
			composites.push({ input: prepared.input, left: prepared.left, top: prepared.top, blend: "over" });
		} catch (error) {
			if (error instanceof ExportEditLayerLimitError) throw error;
			if (error instanceof ExportEditLayerMissingError) throw error;
			// A readiness assertion (blocked/pending mask) or any unexpected read error:
			// fail closed for the durable pipeline, otherwise record + continue.
			if (failOnSkipped) throw new ExportEditLayerMissingError(layer, error instanceof Error ? error.message : String(error));
			skipped.push({
				id: layer.id,
				maskAssetId: layer.maskAssetId,
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
