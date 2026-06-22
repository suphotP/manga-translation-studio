import { getSharedBunSql } from "./sql-pool.js";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename } from "path";
import sharp from "sharp";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import { objectStorage, type StoredObject } from "./storage.js";
import { readJsonFile } from "../utils/json-file.js";
import { isProjectTombstonedIn, isValidProjectId, safePath } from "../utils/security.js";
import { readProjectStateFileGuarded, resolveProjectState } from "../utils/project-state-file.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { pushArrayLiteral } from "./pg-array.js";
import { moderateImageBuffer } from "./moderation.js";
import { uploadAuditStore } from "./upload-audit.js";
// Read-only project -> workspace lookup. Used to infer workspace_id for normal
// upload / AI-output writes (which only carry projectId) so the workspace-scoped
// column/index in asset_records is populated. We never write through this store.
import { projectCatalogStore, type ProjectCatalogStore } from "./project-catalog.js";
import type { AssetActor, AssetDerivative, AssetModerationResult, AssetModerationStatus, AssetRecord, AssetStorageStatus, ProjectState, StorageDriver } from "../types/index.js";

const ASSET_INDEX_FILE = "assets.json";

/**
 * Moderation statuses that are SAFE to release (display / download / export /
 * serve). Everything else — including any current or future hard-block status
 * such as `"blocked"` or a raw `"csam_block"` that ever leaks past normalization
 * — quarantines the object. This is an allow-list (fail-closed) by design: the
 * mandatory CSAM/extreme-content invariant must hold on EVERY code path, so a
 * status this code does not explicitly recognize as safe MUST NOT be served.
 *
 * `passed`  → released.
 * `needs_review` → released WITH a review marker (the soft warning passed the
 *                  mandatory policy; AI processing stays gated by
 *                  `assertAssetReadyForAi`).
 * anything else (blocked / csam_block / pending / unknown) → blocked.
 */
const RELEASABLE_MODERATION_STATUSES = new Set<string>(["passed", "needs_review"]);

/**
 * Minimum age (hours) before a tagged edit-layer asset becomes eligible for the orphan
 * GC reaper. Guards the upload→save window: the editor uploads a mask/patch asset FIRST
 * and commits the referencing `imageEditLayers` entry only on a later save, so a brand-new
 * asset would otherwise look unreferenced. 24h is far longer than any real gap.
 */
export const EDIT_ASSET_GC_GRACE_HOURS = 24;

/**
 * The single source of truth that maps a moderation status to a storage status.
 * A hard block (`block` / `csam_block`, normalized to `"blocked"`) — or any
 * status not on the release allow-list — quarantines the asset so it is never
 * displayable / downloadable / exportable / served.
 */
export function storageStatusForModerationStatus(status: string | undefined): AssetStorageStatus {
	return status && RELEASABLE_MODERATION_STATUSES.has(status) ? "released" : "blocked";
}

/**
 * Storage status for a full moderation RESULT. Identical to
 * {@link storageStatusForModerationStatus} EXCEPT it honors the `failClosed`
 * marker: a PROVIDER-FAILURE fail-closed `needs_review` (the mandatory CSAM/safety
 * check could not run) is QUARANTINED rather than `released`, so an unscreened
 * asset is never served or exported. A genuine provider-SUCCEEDED borderline
 * `needs_review` (failClosed unset) still releases (in-editor servable, but
 * export-gated to `passed`). Use this on every WRITE path that derives a storage
 * status from a fresh moderation verdict; the status-only overload remains for
 * admin re-moderation where the verdict is authored by a human, never fail-closed.
 */
export function storageStatusForModerationResult(moderation: AssetModerationResult | undefined): AssetStorageStatus {
	if (!moderation) return "blocked";
	if (moderation.failClosed) return "quarantined";
	return storageStatusForModerationStatus(moderation.status);
}

export interface UploadedAssetInput {
	/**
	 * Record as quarantined regardless of moderation outcome; the caller is
	 * responsible for releasing (updateAssetModerationAuthoritative) once its
	 * durable side effects (the CoW blob) have landed.
	 */
	holdStorageStatus?: boolean;
	projectId: string;
	/** Optional owning workspace; persisted to the DB record when the Postgres asset store is active. */
	workspaceId?: string;
	imageId: string;
	originalName: string;
	imageBuffer?: Buffer;
	storedObject?: StoredObject;
	filePath?: string;
	mimeType: string;
	sizeBytes: number;
	assetRecordId?: string;
	uploadedBy?: AssetActor;
	request?: {
		ip?: string;
		userAgent?: string;
	};
	metadata?: Record<string, unknown>;
	moderation?: AssetModerationResult;
}

export interface ModerationDerivativePlanOptions {
	width: number;
	height: number;
	targetWidth?: number;
	tileHeight?: number;
	overlapRatio?: number;
}

/**
 * Resize mode for a thumbnail/preview derivative:
 *  - "cover"  (default) crops to the requested box from the TOP — used by the
 *    fixed-aspect cover/grid thumbnails where a uniform card shape matters.
 *  - "inside" downscales to FIT inside the box WITHOUT cropping (aspect
 *    preserved) — used by the continuous webtoon strip, where a tall page must
 *    not be cut off and the downscale just needs to match the column width.
 */
export type ThumbnailFit = "cover" | "inside";

export interface ThumbnailDerivativeOptions {
	width?: number;
	height?: number;
	quality?: number;
	fit?: ThumbnailFit;
}

export interface ThumbnailDerivativeResult {
	buffer: Buffer;
	mimeType: "image/webp";
	derivativeId: string;
	width: number;
	height: number;
	sourceRect: { x: number; y: number; w: number; h: number };
	scale: number;
	cacheHit: boolean;
}

export interface AssetListOptions {
	limit?: number;
	cursor?: string;
	storageStatus?: AssetStorageStatus;
	moderationStatus?: AssetModerationStatus;
	source?: AssetActor["source"];
}

export interface AssetRecordPage {
	assets: AssetRecord[];
	nextCursor?: string;
}

/**
 * Aggregated storage usage for a single project, summed straight from the durable
 * store (`asset_records`) rather than by materializing every row and reducing in
 * JS. Mirrors exactly the fields the storage-quota JS reduce previously computed:
 * `originalBytes` = SUM(byte_size), `derivativeBytes` = SUM of every derivative's
 * positive `sizeBytes`, `assetCount` = row count, `derivativeCount` = total
 * derivative entries (regardless of size).
 */
export interface ProjectAssetUsage {
	originalBytes: number;
	derivativeBytes: number;
	assetCount: number;
	derivativeCount: number;
}

/** Per-project usage map keyed by project id. Projects with no rows are omitted. */
export type WorkspaceAssetUsage = Map<string, ProjectAssetUsage>;

export class ThumbnailSourceNotFoundError extends Error {
	readonly imageId: string;

	constructor(imageId: string) {
		super(`Image ${imageId} not found`);
		this.name = "ThumbnailSourceNotFoundError";
		this.imageId = imageId;
	}
}

export class ThumbnailSourceDecodeError extends Error {
	readonly imageId: string;
	readonly source: "source" | "cached_derivative";
	readonly details: string;

	constructor(imageId: string, source: "source" | "cached_derivative", error: unknown) {
		const details = error instanceof Error ? error.message : String(error);
		super(`Image ${imageId} thumbnail ${source} is not decodable`);
		this.name = "ThumbnailSourceDecodeError";
		this.imageId = imageId;
		this.source = source;
		this.details = details;
	}
}

export class UploadedImageDecodeError extends Error {
	readonly originalName: string;
	readonly details: string;

	constructor(originalName: string, error: unknown) {
		const details = error instanceof Error ? error.message : String(error);
		super(`Uploaded file ${basename(originalName)} is not a decodable image`);
		this.name = "UploadedImageDecodeError";
		this.originalName = originalName;
		this.details = details;
	}
}

/**
 * Thrown when an uploaded (or transform-produced) image declares dimensions that
 * exceed the configured per-image ceiling: a single side over the max width/height
 * OR a total megapixel count over the cap. The check reads the dimensions from the
 * image HEADER (sharp().metadata()) BEFORE any full decode, so a "decompression
 * bomb" (e.g. a 50000×50000 PNG that is tiny on disk but allocates gigabytes when
 * decoded by a later thumbnail/crop/export pass) is rejected up-front instead of
 * OOM-ing the server when something decodes the original.
 */
export class UploadedImageTooLargeError extends Error {
	readonly originalName: string;
	readonly width: number;
	readonly height: number;
	readonly megapixels: number;

	constructor(originalName: string, width: number, height: number) {
		const megapixels = (width * height) / 1_000_000;
		super(`Uploaded file ${basename(originalName)} exceeds the maximum accepted image dimensions`);
		this.name = "UploadedImageTooLargeError";
		this.originalName = originalName;
		this.width = width;
		this.height = height;
		this.megapixels = megapixels;
	}
}

// Per-image pixel ceiling for uploads / bulk-import transform products. Read from
// env at call time so an operator (or a test) can tune the limit without a code
// change; defaults are generous enough for real manga/webtoon scans (which are
// tall but bounded) while still rejecting decompression bombs whose later decode
// would OOM the backend.
//
//   MAX_UPLOAD_IMAGE_WIDTH   single-side width  cap (px), default 30000
//   MAX_UPLOAD_IMAGE_HEIGHT  single-side height cap (px), default 100000
//   MAX_UPLOAD_IMAGE_MEGAPIXELS  total megapixel cap,     default 60
//
// The MEGAPIXEL cap is the real decompression-bomb guard: a 50000×50000 PNG is
// 2500 MP and is rejected from its header before sharp ever allocates a full-
// resolution buffer, regardless of the per-dimension caps. The per-DIMENSION caps
// exist only to bound a single side (e.g. a degenerate 1×2_000_000 strip); they
// are kept GENEROUS so legitimate narrow-but-very-tall webtoon strips pass.
//
// Real webtoon strips are routinely 40000px+ tall (800×40000 = 32 MP is normal,
// well under the 60 MP cap), so the standalone HEIGHT cap defaults to 100000px —
// a value no real page reaches but that still bounds a degenerate sliver. The MP
// cap, not the height cap, is what catches genuine bombs.
const DEFAULT_MAX_UPLOAD_IMAGE_WIDTH = 30000;
const DEFAULT_MAX_UPLOAD_IMAGE_HEIGHT = 100000;
const DEFAULT_MAX_UPLOAD_IMAGE_MEGAPIXELS = 60;

// A SPLIT-source image (the input to /upload-transform mode=split) is EXPECTED to
// be one very long webtoon strip that will immediately be sliced into per-page
// chunks. It therefore gets a SEPARATE, taller height ceiling than a single page,
// and its megapixels cap is also raised — the strip is decoded once (header only
// here; slicing decodes region-by-region), and every produced CHUNK is re-checked
// against the normal per-page ceiling afterward. The MP cap still applies as the
// bomb guard, just at the larger split-source value.
//
//   MAX_UPLOAD_SPLIT_SOURCE_HEIGHT      single-side height cap (px), default 200000
//   MAX_UPLOAD_SPLIT_SOURCE_MEGAPIXELS  total megapixel cap,         default 200
//
// 200 MP ≈ 1000×200000 — an enormous-but-plausible stitched webtoon. A true bomb
// (50000×50000 = 2500 MP) is still rejected. The width cap is shared with the
// normal upload ceiling (a strip is narrow by definition).
const DEFAULT_MAX_SPLIT_SOURCE_HEIGHT = 200000;
const DEFAULT_MAX_SPLIT_SOURCE_MEGAPIXELS = 200;

function readPositiveNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface UploadImagePixelCeiling {
	maxWidth: number;
	maxHeight: number;
	maxPixels: number;
}

export function getUploadImagePixelCeiling(): UploadImagePixelCeiling {
	const maxWidth = readPositiveNumberEnv("MAX_UPLOAD_IMAGE_WIDTH", DEFAULT_MAX_UPLOAD_IMAGE_WIDTH);
	const maxHeight = readPositiveNumberEnv("MAX_UPLOAD_IMAGE_HEIGHT", DEFAULT_MAX_UPLOAD_IMAGE_HEIGHT);
	const maxMegapixels = readPositiveNumberEnv("MAX_UPLOAD_IMAGE_MEGAPIXELS", DEFAULT_MAX_UPLOAD_IMAGE_MEGAPIXELS);
	return { maxWidth, maxHeight, maxPixels: Math.round(maxMegapixels * 1_000_000) };
}

// Looser ceiling for the SOURCE strip fed to /upload-transform mode=split. Height
// and megapixels are raised (a split source is expected to be very tall); width is
// shared with the normal ceiling. Each produced chunk is still validated against
// the normal per-page ceiling, so this only relaxes the SOURCE admission, never
// the per-page product. The MP cap remains the real bomb guard.
export function getSplitSourcePixelCeiling(): UploadImagePixelCeiling {
	const base = getUploadImagePixelCeiling();
	const maxHeight = readPositiveNumberEnv("MAX_UPLOAD_SPLIT_SOURCE_HEIGHT", DEFAULT_MAX_SPLIT_SOURCE_HEIGHT);
	const maxMegapixels = readPositiveNumberEnv("MAX_UPLOAD_SPLIT_SOURCE_MEGAPIXELS", DEFAULT_MAX_SPLIT_SOURCE_MEGAPIXELS);
	return {
		maxWidth: base.maxWidth,
		// Never let the split-source height fall below the normal height cap.
		maxHeight: Math.max(maxHeight, base.maxHeight),
		maxPixels: Math.max(Math.round(maxMegapixels * 1_000_000), base.maxPixels),
	};
}

const THUMBNAIL_VERSION = "v1";
const DEFAULT_THUMBNAIL_WIDTH = 192;
const DEFAULT_THUMBNAIL_HEIGHT = 288;
const DEFAULT_THUMBNAIL_QUALITY = 74;

// Clamp bounds for the "cover" cards/grid thumbnails (small, fixed aspect).
export const THUMBNAIL_COVER_MIN = 64;
export const THUMBNAIL_COVER_MAX_WIDTH = 512;
export const THUMBNAIL_COVER_MAX_HEIGHT = 768;

// Clamp bounds for the "inside" (uncropped) webtoon STRIP PREVIEW variant. The
// strip column is up to ~900 CSS px and renders at devicePixelRatio (retina → 2),
// so the preview must be crisp up to ~1800px wide; we cap a little above that.
// Height is allowed to be tall because webtoon pages are long and "inside" never
// crops — but it is still bounded so a pathological source can't allocate forever.
// At width ~1600 a 12-megapixel scan becomes a ~150-250KB WebP (vs a 4.6MB full
// JPEG) and decodes a ~1600×2133 image (~3.4MP) instead of 12MP.
export const THUMBNAIL_INSIDE_MIN = 64;
export const THUMBNAIL_INSIDE_MAX_WIDTH = 2000;
export const THUMBNAIL_INSIDE_MAX_HEIGHT = 6000;

// Quality for the inside/strip preview. Slightly higher than the tiny-thumbnail
// default so the larger, on-canvas-sized preview stays clean at retina scale.
const DEFAULT_STRIP_PREVIEW_QUALITY = 80;

function nowIso(): string {
	return new Date().toISOString();
}

function assetIndexPath(projectId: string): string {
	return safePath(PROJECTS_DIR, projectId, ASSET_INDEX_FILE);
}

function readAssetIndex(projectId: string): Record<string, AssetRecord> {
	const indexPath = assetIndexPath(projectId);
	if (!existsSync(indexPath)) return {};
	return readJsonFile<Record<string, AssetRecord>>(indexPath);
}

function writeAssetIndex(projectId: string, index: Record<string, AssetRecord>): void {
	// The file-mode asset index is the AUTHORITATIVE store (FileAssetStore), and
	// readAssetIndex JSON.parses it with no corruption tolerance — a plain
	// writeFileSync truncates-then-streams, so a crash mid-write would leave a
	// partial file that loses EVERY asset record for the project. Route through the
	// crash-safe temp→fsync→rename helper so a reader only ever sees a complete file.
	writeFileAtomic(assetIndexPath(projectId), JSON.stringify(index, null, 2));
}

export function createSha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

export async function validateUploadedImageBuffer(
	imageBuffer: Buffer,
	originalName: string,
	// Optional override ceiling. Defaults to the normal per-page upload ceiling.
	// The /upload-transform SPLIT path passes the looser split-source ceiling for
	// the SOURCE strip only (each produced chunk is still validated with the
	// default per-page ceiling).
	ceiling: UploadImagePixelCeiling = getUploadImagePixelCeiling(),
): Promise<{ width: number; height: number }> {
	let metadata: sharp.Metadata;
	try {
		metadata = await sharp(imageBuffer).metadata();
	} catch (error) {
		throw new UploadedImageDecodeError(originalName, error);
	}

	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;
	if (width <= 0 || height <= 0) {
		throw new UploadedImageDecodeError(originalName, new Error("missing image dimensions"));
	}

	// DoS guard: reject an image whose declared dimensions exceed the per-image
	// pixel ceiling BEFORE anything decodes it at full resolution. metadata() above
	// only parsed the header (no full decode), so a decompression bomb is rejected
	// here cheaply instead of OOM-ing a later thumbnail/crop/export decode. The
	// MEGAPIXEL term is the real bomb guard; the per-dimension terms only bound a
	// degenerate single side.
	if (width > ceiling.maxWidth || height > ceiling.maxHeight || width * height > ceiling.maxPixels) {
		throw new UploadedImageTooLargeError(originalName, width, height);
	}

	return { width, height };
}

export function buildModerationDerivativePlan(options: ModerationDerivativePlanOptions): AssetDerivative[] {
	const targetWidth = options.targetWidth ?? 1024;
	const tileHeight = options.tileHeight ?? 1536;
	const overlapRatio = options.overlapRatio ?? 0.12;
	const moderationWidth = Math.min(options.width, targetWidth);
	const scale = moderationWidth / options.width;
	const scaledHeight = Math.max(1, Math.round(options.height * scale));
	const createdAt = nowIso();

	const derivatives: AssetDerivative[] = [{
		id: "moderation-overview",
		purpose: "moderation_overview",
		status: "planned",
		width: moderationWidth,
		height: scaledHeight,
		sourceRect: { x: 0, y: 0, w: options.width, h: options.height },
		scale,
		createdAt,
	}];

	if (scaledHeight <= Math.round(tileHeight * 1.5)) {
		return derivatives;
	}

	const overlapPx = Math.max(1, Math.round(tileHeight * overlapRatio));
	const step = Math.max(1, tileHeight - overlapPx);
	let tileIndex = 0;

	for (let scaledTop = 0; scaledTop < scaledHeight; scaledTop += step) {
		const scaledBottom = Math.min(scaledHeight, scaledTop + tileHeight);
		const originalY = Math.max(0, Math.floor(scaledTop / scale));
		const originalBottom = Math.min(options.height, Math.ceil(scaledBottom / scale));
		const originalHeight = Math.max(1, originalBottom - originalY);

		derivatives.push({
			id: `moderation-tile-${String(tileIndex).padStart(4, "0")}`,
			purpose: "moderation_tile",
			status: "planned",
			width: moderationWidth,
			height: scaledBottom - scaledTop,
			sourceRect: { x: 0, y: originalY, w: options.width, h: originalHeight },
			scale,
			overlapPx,
			createdAt,
		});

		tileIndex++;
		if (scaledBottom >= scaledHeight) break;
	}

	return derivatives;
}

/**
 * Execute the planned moderation derivative tiles and aggregate their verdicts
 * with the supplied whole-image (overview) verdict.
 *
 * A long webtoon page base64-encodes well past the provider's request-size limit,
 * so the upload path screens ONE downscaled overview. That can dilute a small
 * unsafe region on a very tall page below threshold. This walks the stored tile
 * plan, extracts each planned region from the FULL-resolution source, moderates
 * it, and aggregates fail-closed:
 *   - any tile (or the overview) `blocked`      → `blocked`   (hard block)
 *   - else any `needs_review`                   → `needs_review`
 *   - else                                      → `passed`
 *
 * The known-CSAM-sha denylist + mandatory CSAM screen run inside
 * `moderateImageBuffer` for every tile, so each region is screened exactly like a
 * standalone upload. A tile EXTRACTION failure is treated as `needs_review`
 * (fail-closed for that region) rather than silently skipped, so no region is ever
 * left unscreened. When the plan has no tiles (short page) the overview verdict is
 * returned unchanged.
 */
export async function executeModerationTilePlan(
	imageBuffer: Buffer,
	mimeType: string,
	plan: AssetDerivative[],
	overview: AssetModerationResult,
	options: {
		workspaceId?: string;
		assetId?: string;
		ipAddress?: string;
		userAgent?: string;
	} = {},
): Promise<AssetModerationResult> {
	// A hard block on the overview is already terminal — no need to screen tiles.
	if (overview.status === "blocked") return overview;
	const tiles = plan.filter((derivative) => derivative.purpose === "moderation_tile");
	if (tiles.length === 0) return overview;

	let worst: AssetModerationResult = overview;
	const rank = (status: AssetModerationStatus): number => {
		if (status === "blocked") return 3;
		if (status === "needs_review") return 2;
		if (status === "passed") return 1;
		return 0; // pending / unknown — fail-closed below worst-of-known
	};

	for (const tile of tiles) {
		let tileResult: AssetModerationResult;
		try {
			const region = await sharp(imageBuffer, { failOn: "none" })
				.extract({
					left: Math.max(0, Math.round(tile.sourceRect.x)),
					top: Math.max(0, Math.round(tile.sourceRect.y)),
					width: Math.max(1, Math.round(tile.sourceRect.w)),
					height: Math.max(1, Math.round(tile.sourceRect.h)),
				})
				.jpeg({ quality: 80 })
				.toBuffer();
			tileResult = await moderateImageBuffer(region, "image/jpeg", options.workspaceId ?? "", {
				assetId: options.assetId ? `${options.assetId}#${tile.id}` : undefined,
				// Do NOT pass the whole-asset sha for a tile: a tile sha differs and a
				// tile-level mandatory block should audit under the tile-derived id, not
				// poison the parent asset's hash on the denylist.
				ipAddress: options.ipAddress,
				userAgent: options.userAgent,
			});
		} catch (error) {
			// Extraction/decoding failure: do NOT leave the region unscreened. Mark the
			// asset for review so it is withheld from AI/export until resolved.
			console.warn(`[Moderation] tile ${tile.id} extraction failed; marking needs_review: ${error instanceof Error ? error.message : String(error)}`);
			tileResult = {
				status: "needs_review",
				provider: "local-development-rules",
				checkedAt: new Date().toISOString(),
				reason: `moderation tile ${tile.id} could not be screened`,
				categories: { moderationTileScreenFailed: 1 },
				// The region could not be screened at all — fail closed so the asset is
				// quarantined (not servable / not exportable), not a servable borderline.
				failClosed: true,
			};
		}
		if (rank(tileResult.status) > rank(worst.status)) {
			worst = {
				...tileResult,
				reason: tileResult.reason ? `tile ${tile.id}: ${tileResult.reason}` : worst.reason,
			};
		}
		// Short-circuit on the first hard block.
		if (worst.status === "blocked") break;
	}

	return worst;
}

function normalizeThumbnailDimension(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function buildThumbnailDerivativeId(imageId: string, width: number, height: number, fit: ThumbnailFit = "cover"): string {
	const safeImageId = imageId.replace(/[^a-z0-9._-]/gi, "_");
	// The fit suffix keeps "inside" (uncropped strip preview) and "cover" (cropped
	// card) derivatives at the SAME w×h from colliding in the derivative cache.
	// "cover" omits the suffix so existing cached cover derivatives stay valid.
	const fitSuffix = fit === "inside" ? "inside." : "";
	return `${safeImageId}.thumbnail.${width}x${height}.${fitSuffix}${THUMBNAIL_VERSION}.webp`;
}

function computeThumbnailGeometry(
	originalWidth: number,
	originalHeight: number,
	targetWidth: number,
	maxHeight: number,
	fit: ThumbnailFit = "cover",
): Pick<ThumbnailDerivativeResult, "width" | "height" | "sourceRect" | "scale"> {
	const outputWidth = Math.max(1, Math.min(targetWidth, originalWidth));
	const scale = outputWidth / originalWidth;
	const fullScaledHeight = Math.max(1, Math.round(originalHeight * scale));

	if (fit === "inside") {
		// No crop: keep the FULL page, just downscaled to the column width. maxHeight
		// is only a hard safety ceiling; tall webtoon pages keep their true aspect so
		// the strip preview matches the focused full-res page exactly (no letterbox).
		const outputHeight = Math.max(1, Math.min(maxHeight, fullScaledHeight));
		return {
			width: outputWidth,
			height: outputHeight,
			sourceRect: { x: 0, y: 0, w: originalWidth, h: originalHeight },
			scale,
		};
	}

	// "cover": crop to the box from the top (fixed-aspect cards/grid).
	const outputHeight = Math.max(1, Math.min(maxHeight, fullScaledHeight));
	const sourceHeight = Math.max(1, Math.min(originalHeight, Math.ceil(outputHeight / scale)));

	return {
		width: outputWidth,
		height: outputHeight,
		sourceRect: { x: 0, y: 0, w: originalWidth, h: sourceHeight },
		scale,
	};
}

function mergeDerivative(existing: AssetDerivative[], derivative: AssetDerivative): AssetDerivative[] {
	const next = [...existing];
	const existingIndex = next.findIndex((item) => item.id === derivative.id);
	if (existingIndex >= 0) {
		next[existingIndex] = derivative;
	} else {
		next.push(derivative);
	}
	return next;
}

/**
 * Persist a derivative (thumbnail) onto the asset record. In Postgres mode the
 * durable `asset_records` row is the source of truth: we read it authoritatively,
 * merge the derivative, and persist via the targeted `updateDerivatives` column
 * update — so ready thumbnail metadata + sizeBytes survive a clean disk / DB
 * restore / second instance (round-1 bug: only assets.json was mutated). The
 * on-disk mirror is also refreshed for the sync best-effort helpers. File mode
 * keeps the synchronous on-disk upsert.
 */
async function upsertAssetDerivative(projectId: string, imageId: string, derivative: AssetDerivative): Promise<void> {
	if (!postgresAssetStoreActive()) {
		fileAssetStore.updateDerivativesSync(projectId, imageId, mergeDerivative(
			fileAssetStore.getSync(projectId, imageId)?.derivatives ?? [],
			derivative,
		));
		return;
	}
	const asset = await assetStore.get(projectId, imageId);
	if (!asset) return;
	const merged = mergeDerivative(asset.derivatives, derivative);
	const updated = await assetStore.updateDerivatives(projectId, imageId, merged);
	// Mirror the persisted state so sync best-effort helpers stay consistent.
	if (updated) fileAssetStore.writeSync(updated);
}

async function upsertFailedThumbnailDerivative(projectId: string, imageId: string, derivativeId: string): Promise<void> {
	await upsertAssetDerivative(projectId, imageId, {
		id: derivativeId,
		purpose: "thumbnail",
		status: "failed",
		width: 0,
		height: 0,
		sourceRect: { x: 0, y: 0, w: 0, h: 0 },
		scale: 0,
		createdAt: nowIso(),
	});
}

/**
 * Maximum number of thumbnail GENERATIONS (full sharp decode→resize→encode) that
 * may run concurrently across the whole process. A cold-cache stampede — e.g. the
 * first Library / PageNavigator render right after a 500-page chapter upload fires
 * up to ~500 near-simultaneous cache-MISS GETs — would otherwise decode that many
 * full-resolution pages at once on the event loop and saturate CPU + memory. A
 * small bound makes a stampede QUEUE (work is still done, just serialized a few at
 * a time) instead of all decoding at once. The inflight-dedup below collapses
 * duplicate requests for the SAME derivative before they ever reach the semaphore.
 */
const THUMBNAIL_GENERATION_CONCURRENCY = 3;

/**
 * Minimal FIFO async semaphore. `acquire()` resolves immediately while permits are
 * available; otherwise the caller waits in line and is woken when a permit is
 * released. Used to bound concurrent thumbnail sharp jobs.
 */
class AsyncSemaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(permits: number) {
		this.available = permits;
	}

	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available -= 1;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) {
			// Hand the permit straight to the next waiter (count stays consumed).
			next();
			return;
		}
		this.available += 1;
	}
}

const thumbnailGenerationSemaphore = new AsyncSemaphore(THUMBNAIL_GENERATION_CONCURRENCY);

/**
 * In-flight de-dup map for thumbnail generation. Keyed by the FULLY-resolved
 * derivative identity (projectId + derivativeId, which already encodes imageId,
 * width, height, fit and version), so N concurrent cache-MISS requests for the
 * SAME derivative collapse onto ONE shared sharp job: the first installs the
 * promise, the rest await it. The entry is deleted when the shared promise
 * settles (success OR failure) so a failure never poisons the cache and a future
 * request retries cleanly.
 */
const inflightThumbnailGenerations = new Map<string, Promise<ThumbnailDerivativeResult>>();

/**
 * Test-only instrumentation. `decodeCount` counts every full sharp decode the
 * thumbnail path performs (metadata-on-legacy-hit fallback + source
 * metadata/resize), so a test can assert a cache HIT with persisted dims does NOT
 * decode. `peakConcurrentGenerations` tracks the high-water mark of generations
 * holding the semaphore so a test can assert a stampede never exceeds
 * {@link THUMBNAIL_GENERATION_CONCURRENCY}.
 */
const thumbnailInstrumentation = {
	decodeCount: 0,
	concurrentGenerations: 0,
	peakConcurrentGenerations: 0,
};

/** Wrap `sharp(buffer).metadata()` so every real decode is counted for tests. */
async function decodeImageMetadata(buffer: Buffer, options?: sharp.SharpOptions): Promise<sharp.Metadata> {
	thumbnailInstrumentation.decodeCount += 1;
	return options ? sharp(buffer, options).metadata() : sharp(buffer).metadata();
}

export const __thumbnailTestHooks = {
	get decodeCount(): number {
		return thumbnailInstrumentation.decodeCount;
	},
	get peakConcurrentGenerations(): number {
		return thumbnailInstrumentation.peakConcurrentGenerations;
	},
	get inflightSize(): number {
		return inflightThumbnailGenerations.size;
	},
	get concurrencyLimit(): number {
		return THUMBNAIL_GENERATION_CONCURRENCY;
	},
	reset(): void {
		thumbnailInstrumentation.decodeCount = 0;
		thumbnailInstrumentation.concurrentGenerations = 0;
		thumbnailInstrumentation.peakConcurrentGenerations = 0;
	},
};

/**
 * Look up the persisted dimensions of an already-rendered thumbnail derivative so
 * a cache HIT can return its width/height WITHOUT decoding the cached bytes on the
 * request thread. Returns `undefined` for a legacy record (no entry, or one
 * written before width/height/format were persisted) so the caller falls back to
 * a one-time decode + backfill.
 */
async function readReadyDerivativeDims(
	projectId: string,
	imageId: string,
	derivativeId: string,
): Promise<{ width: number; height: number } | undefined> {
	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	const derivative = asset?.derivatives.find((item) => item.id === derivativeId);
	if (
		derivative
		&& derivative.status === "ready"
		&& typeof derivative.width === "number"
		&& typeof derivative.height === "number"
		&& derivative.width > 0
		&& derivative.height > 0
	) {
		return { width: derivative.width, height: derivative.height };
	}
	return undefined;
}

async function readOriginalImageBuffer(projectId: string, imageId: string): Promise<Buffer | undefined> {
	const legacyProjectObject = await objectStorage.getProjectImage({ projectId, imageId });
	if (legacyProjectObject) return legacyProjectObject;
	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	if (!asset?.sha256 || !asset.storageKey.startsWith("content/")) return undefined;
	return objectStorage.getContentBlob({ sha256: asset.sha256 });
}

export async function ensureThumbnailDerivative(
	projectId: string,
	imageId: string,
	options: ThumbnailDerivativeOptions = {},
): Promise<ThumbnailDerivativeResult> {
	const fit: ThumbnailFit = options.fit === "inside" ? "inside" : "cover";
	// Each fit has its own clamp envelope: small fixed-aspect cards (cover) vs the
	// large uncropped column-width strip preview (inside).
	const maxWidth = fit === "inside" ? THUMBNAIL_INSIDE_MAX_WIDTH : THUMBNAIL_COVER_MAX_WIDTH;
	const maxHeight = fit === "inside" ? THUMBNAIL_INSIDE_MAX_HEIGHT : THUMBNAIL_COVER_MAX_HEIGHT;
	const minDim = fit === "inside" ? THUMBNAIL_INSIDE_MIN : THUMBNAIL_COVER_MIN;
	const defaultQuality = fit === "inside" ? DEFAULT_STRIP_PREVIEW_QUALITY : DEFAULT_THUMBNAIL_QUALITY;
	const requestedWidth = normalizeThumbnailDimension(options.width, DEFAULT_THUMBNAIL_WIDTH, minDim, maxWidth);
	const requestedHeight = normalizeThumbnailDimension(options.height, DEFAULT_THUMBNAIL_HEIGHT, minDim, maxHeight);
	const quality = normalizeThumbnailDimension(options.quality, defaultQuality, 40, 90);
	const derivativeId = buildThumbnailDerivativeId(imageId, requestedWidth, requestedHeight, fit);
	const cached = await objectStorage.getProjectDerivative({ projectId, derivativeId });

	if (cached) {
		// HIT FAST PATH: the WebP bytes are already rendered. The output dimensions
		// were known + persisted at generation time, so read them off the durable
		// derivative record and return WITHOUT a full sharp decode on the request
		// thread. A 100-500 page chapter fires that many thumbnail GETs per grid
		// render; decoding each cached buffer just to re-read w/h saturated the
		// event loop for no new information.
		const persistedDims = await readReadyDerivativeDims(projectId, imageId, derivativeId);
		if (persistedDims) {
			return {
				buffer: cached,
				mimeType: "image/webp",
				derivativeId,
				width: persistedDims.width,
				height: persistedDims.height,
				sourceRect: { x: 0, y: 0, w: 0, h: 0 },
				scale: 0,
				cacheHit: true,
			};
		}
		// LEGACY fallback: a cache entry that predates persisted dims (or whose record
		// lost them). Decode ONCE to recover the dimensions, return them, and backfill
		// the record so every subsequent hit is decode-free. A corrupt cache entry
		// (decode throws) falls through to re-derive from the original below.
		try {
			const metadata = await decodeImageMetadata(cached);
			const width = metadata.width ?? requestedWidth;
			const height = metadata.height ?? requestedHeight;
			// Best-effort backfill: persist the recovered dims (+ format) so later hits
			// skip the decode. A persistence failure must not break serving the bytes.
			void upsertAssetDerivative(projectId, imageId, {
				id: derivativeId,
				purpose: "thumbnail",
				status: "ready",
				width,
				height,
				sourceRect: { x: 0, y: 0, w: 0, h: 0 },
				scale: 0,
				sizeBytes: cached.byteLength,
				format: "webp",
				createdAt: nowIso(),
			}).catch((error) => {
				console.warn(`[Thumbnail] failed to backfill dims for ${projectId}/${derivativeId}:`, error);
			});
			return {
				buffer: cached,
				mimeType: "image/webp",
				derivativeId,
				width,
				height,
				sourceRect: { x: 0, y: 0, w: 0, h: 0 },
				scale: 0,
				cacheHit: true,
			};
		} catch {
			// A corrupt cache entry should not break browsing if the original can be re-derived.
		}
	}

	// Cache MISS: collapse concurrent requests for the SAME derivative onto ONE
	// shared generation, and bound TOTAL concurrent generations with a semaphore so
	// a cold-cache stampede queues instead of decoding hundreds of full-res pages at
	// once. The dedup key is (projectId, derivativeId) — derivativeId already encodes
	// imageId/width/height/fit/version. The entry is removed on settle (success OR
	// failure) so an error rejects every awaiter and never poisons the cache.
	const inflightKey = `${projectId} ${derivativeId}`;
	const existing = inflightThumbnailGenerations.get(inflightKey);
	if (existing) return existing;

	const generation = (async (): Promise<ThumbnailDerivativeResult> => {
		await thumbnailGenerationSemaphore.acquire();
		thumbnailInstrumentation.concurrentGenerations += 1;
		thumbnailInstrumentation.peakConcurrentGenerations = Math.max(
			thumbnailInstrumentation.peakConcurrentGenerations,
			thumbnailInstrumentation.concurrentGenerations,
		);
		try {
			return await generateThumbnailDerivative(
				projectId,
				imageId,
				derivativeId,
				requestedWidth,
				requestedHeight,
				quality,
				fit,
			);
		} finally {
			thumbnailInstrumentation.concurrentGenerations -= 1;
			thumbnailGenerationSemaphore.release();
		}
	})();
	inflightThumbnailGenerations.set(inflightKey, generation);
	try {
		return await generation;
	} finally {
		inflightThumbnailGenerations.delete(inflightKey);
	}
}

/**
 * The actual decode→resize→encode for a single thumbnail derivative, run under the
 * inflight-dedup + concurrency semaphore in {@link ensureThumbnailDerivative}. All
 * dimensions are already resolved/clamped by the caller. Persists the rendered
 * derivative (with output width/height + format) so future cache HITs are
 * decode-free.
 */
async function generateThumbnailDerivative(
	projectId: string,
	imageId: string,
	derivativeId: string,
	requestedWidth: number,
	requestedHeight: number,
	quality: number,
	fit: ThumbnailFit,
): Promise<ThumbnailDerivativeResult> {
	const originalBuffer = await readOriginalImageBuffer(projectId, imageId);
	if (!originalBuffer) {
		throw new ThumbnailSourceNotFoundError(imageId);
	}

	let metadata: sharp.Metadata;
	try {
		metadata = await decodeImageMetadata(originalBuffer);
	} catch (error) {
		await upsertFailedThumbnailDerivative(projectId, imageId, derivativeId);
		throw new ThumbnailSourceDecodeError(imageId, "source", error);
	}
	const originalWidth = metadata.width ?? 0;
	const originalHeight = metadata.height ?? 0;
	if (originalWidth <= 0 || originalHeight <= 0) {
		await upsertFailedThumbnailDerivative(projectId, imageId, derivativeId);
		throw new ThumbnailSourceDecodeError(imageId, "source", new Error("missing image dimensions"));
	}

	const geometry = computeThumbnailGeometry(originalWidth, originalHeight, requestedWidth, requestedHeight, fit);
	const resized = sharp(originalBuffer)
		.resize(
			fit === "inside"
				? {
					// Fit the whole page inside the WxH box without cropping (aspect
					// preserved). geometry.height carries the full-aspect height already
					// clamped to the inside max ceiling, so passing both bounds makes
					// sharp shrink-to-fit on the rare ultra-tall page instead of
					// overrunning the recorded derivative height.
					width: geometry.width,
					height: geometry.height,
					fit: "inside",
					withoutEnlargement: true,
				}
				: {
					width: geometry.width,
					height: geometry.height,
					fit: "cover",
					position: "top",
					withoutEnlargement: true,
				},
		)
		.webp({ quality });
	let buffer: Buffer;
	try {
		buffer = await resized.toBuffer();
	} catch (error) {
		await upsertFailedThumbnailDerivative(projectId, imageId, derivativeId);
		throw new ThumbnailSourceDecodeError(imageId, "source", error);
	}
	const storedObject = await objectStorage.putProjectDerivative({ projectId, derivativeId, buffer });
	const createdAt = nowIso();

	await upsertAssetDerivative(projectId, imageId, {
		id: derivativeId,
		purpose: "thumbnail",
		status: "ready",
		width: geometry.width,
		height: geometry.height,
		sourceRect: geometry.sourceRect,
		scale: geometry.scale,
		storageKey: storedObject.key,
		sizeBytes: buffer.byteLength,
		// Persist the output encoding alongside the dims so a future cache HIT can
		// return width/height without decoding the bytes (Bug1).
		format: "webp",
		createdAt,
	});

	return {
		buffer,
		mimeType: "image/webp",
		derivativeId,
		width: geometry.width,
		height: geometry.height,
		sourceRect: geometry.sourceRect,
		scale: geometry.scale,
		cacheHit: false,
	};
}

export async function recordUploadedAsset(input: UploadedAssetInput): Promise<AssetRecord> {
	const imageBuffer = input.imageBuffer ?? (input.filePath ? readFileSync(input.filePath) : undefined);
	if (!imageBuffer) {
		throw new Error("recordUploadedAsset requires imageBuffer or filePath");
	}
	const { width, height } = await validateUploadedImageBuffer(imageBuffer, input.originalName);

	const timestamp = nowIso();
	// Resolve the workspace BEFORE moderation. Callers that omit `workspaceId`
	// (notably the AI-output path in ai-router.ts) would otherwise moderate with an
	// empty workspace, skipping workspace-scoped behavior such as the Studio BYO
	// soft-policy bypass and losing the workspace id on CSAM audit rows. The same
	// resolved value is reused for the durable asset-store write below.
	const resolvedWorkspaceId = await resolveWorkspaceId(input);
	// When a precomputed moderation result is not supplied (e.g. the AI-output
	// path in ai-router.ts), moderate here and thread the full audit context so a
	// blocked/CSAM verdict writes a legal-hold row that is traceable back to the
	// generated asset/hash (and workspace) rather than null fields.
	const moderation = input.moderation ?? await moderateImageBuffer(imageBuffer, input.mimeType, resolvedWorkspaceId, {
		assetId: input.imageId,
		sha256: createSha256(imageBuffer),
		ipAddress: input.request?.ip,
		userAgent: input.request?.userAgent,
	});
	const storedObject = input.storedObject ?? {
		driver: objectStorage.driver,
		key: `projects/${input.projectId}/images/${input.imageId}`,
		localPath: input.filePath,
	};
	const record: AssetRecord = {
		assetId: input.imageId,
		projectId: input.projectId,
		imageId: input.imageId,
		originalName: input.originalName,
		mimeType: input.mimeType,
		sizeBytes: input.sizeBytes,
		sha256: createSha256(imageBuffer),
		storageDriver: storedObject.driver,
		storageKey: storedObject.key,
		width,
		height,
		// Hard blocks (block / csam_block → "blocked") quarantine the object; a soft
		// `needs_review` warning that PASSED the mandatory policy stays released (with
		// a review marker) so normal page display works. A PROVIDER-FAILURE fail-closed
		// `needs_review` (mandatory CSAM screen could not run) is QUARANTINED instead —
		// never served or exported — until re-moderation/admin review. AI processing of
		// warned assets is still gated by `assertAssetReadyForAi`. Defense-in-depth:
		// this is an allow-list (release ONLY a provider-passed `passed`/`needs_review`)
		// so ANY hard block — or a raw `csam_block` that ever reached here unnormalized —
		// fail-closes to "blocked" instead of leaking to "released".
		// CoW uploads HOLD the record as quarantined (non-servable) until the
		// content-addressed blob is durably written; the caller's finalize flips
		// it to the moderation-derived status afterwards. Without the hold, a
		// crash between the row insert and writeBlob leaves a released record
		// whose content/<sha> never landed — a permanent broken read (b14 r1).
		storageStatus: input.holdStorageStatus ? "quarantined" : storageStatusForModerationResult(moderation),
		moderation,
		derivatives: buildModerationDerivativePlan({ width, height }),
		uploadedBy: input.uploadedBy,
		// Carry provenance/discovery metadata on the record itself (not just the DB
		// `metadata` column / upload-audit row) so it survives in file mode and is
		// surfaced by the asset-library listing path in both stores. Omitted when no
		// metadata was supplied so plain uploads stay unchanged.
		metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	const audit = await uploadAuditStore.append({
		projectId: input.projectId,
		imageId: input.imageId,
		originalName: input.originalName,
		mimeType: input.mimeType,
		sizeBytes: input.sizeBytes,
		sha256: record.sha256,
		storageDriver: storedObject.driver,
		storageKey: storedObject.key,
		width,
		height,
		actor: input.uploadedBy ?? { source: "anonymous" },
		ip: input.request?.ip,
		userAgent: input.request?.userAgent,
		metadata: {
			...input.metadata,
			moderationStatus: moderation.status,
		},
	});
	record.uploadAuditId = audit.auditId;

	await assetStore.write(record, {
		assetRecordId: input.assetRecordId,
		workspaceId: resolvedWorkspaceId,
		metadata: input.metadata,
	});
	// In Postgres mode `asset_records` is the source of truth; the per-project
	// JSON index is only a best-effort local cache. We still refresh it so the
	// (legacy, file-mode) synchronous read helpers observe recent writes, but in
	// postgres mode no read/serve/AI decision relies on the mirror being current.
	// The mirror write is therefore best-effort (like cacheHydratedAssets): the
	// durable object + DB row are already committed, so a local-disk failure
	// (read-only / full / unavailable volume) must NOT fail an otherwise durable
	// upload — failing here would wrongly trigger upload cleanup and discard a
	// persisted asset.
	if (postgresAssetStoreActive()) {
		try {
			fileAssetStore.writeSync(record);
		} catch (error) {
			console.error(`Failed to mirror asset ${record.projectId}/${record.assetId} to local index (durable write succeeded):`, error);
		}
	}
	return record;
}

/**
 * True when the durable store is Postgres (i.e. `asset_records` is the source of
 * truth). All store-authoritative async helpers below branch on this; file mode
 * keeps its historical synchronous on-disk behavior unchanged.
 */
function postgresAssetStoreActive(): boolean {
	return assetStore !== fileAssetStore;
}

/**
 * Synchronous lookup against the JSON mirror only. Retained for file mode and a
 * handful of internal best-effort paths. In Postgres mode this can return stale
 * or missing data while a row exists in `asset_records`; serve / AI-readiness /
 * token-issuance decisions MUST use {@link getAssetRecordAuthoritative} instead
 * so a blocked or quarantined asset is never treated as servable.
 */
export function getAssetRecord(projectId: string, imageId: string): AssetRecord | undefined {
	return fileAssetStore.getSync(projectId, imageId);
}

/**
 * Authoritative single-asset lookup. In Postgres mode the durable store is
 * queried directly (await), so a missing/stale JSON mirror after a restart,
 * clean disk, second instance, or DB restore can never hide a row or cause a
 * blocked asset to be served. File mode reads the on-disk index synchronously.
 */
export async function getAssetRecordAuthoritative(projectId: string, imageId: string): Promise<AssetRecord | undefined> {
	if (!postgresAssetStoreActive()) {
		return fileAssetStore.getSync(projectId, imageId);
	}
	// Read straight from the durable store. We intentionally do NOT rewrite the
	// JSON mirror here: this is a hot path (image serve / token issuance) and the
	// mirror is non-authoritative, so a per-read full-index write would be
	// needless I/O and could clobber concurrent writes. The mirror is refreshed
	// by listing / hydration instead.
	return assetStore.get(projectId, imageId);
}

export async function updateAssetModerationAuthoritative(
	projectId: string,
	imageId: string,
	moderation: AssetModerationResult,
	storageStatus?: AssetStorageStatus,
): Promise<AssetRecord | undefined> {
	const updated = await assetStore.updateModeration(projectId, imageId, moderation, storageStatus);
	if (updated && postgresAssetStoreActive()) {
		try {
			fileAssetStore.writeSync(updated);
		} catch (error) {
			console.error(`Failed to mirror moderation update for ${projectId}/${imageId} to local index:`, error);
		}
	}
	return updated;
}

export function removeAssetRecord(projectId: string, imageId: string): boolean {
	const removed = fileAssetStore.removeSync(projectId, imageId);
	// In Postgres mode the JSON index is only a mirror; the durable row in
	// asset_records must also be deleted or it survives upload-cleanup and
	// AI-output rollback, corrupting the persistent listing. Some sync callers
	// remain (legacy paths); they fire a best-effort async delete. Prefer
	// removeAssetRecordAuthoritative from async callers so the DB delete is
	// awaited and surfaced.
	if (postgresAssetStoreActive()) {
		invalidateHydratedAssets(projectId);
		void assetStore.remove(projectId, imageId).catch((error) => {
			console.error(`Failed to delete asset_records row for ${projectId}/${imageId}:`, error);
		});
	}
	return removed;
}

/**
 * Authoritative delete. In Postgres mode the durable row is deleted with the
 * delete awaited (so callers in async contexts — upload cleanup, AI rollback —
 * surface failures and don't race the object delete). File mode deletes the
 * on-disk index entry synchronously.
 */
export async function removeAssetRecordAuthoritative(projectId: string, imageId: string): Promise<boolean> {
	return (await removeAssetRecordAuthoritativeDetailed(projectId, imageId)).removed;
}

/**
 * Like {@link removeAssetRecordAuthoritative} but reports whether the DURABLE
 * single-winner delete succeeded (`durableRemoved`) separately from whether the
 * best-effort JSON mirror entry was removed (folded into `removed`).
 *
 * A caller that performs an irreversible side effect gated on "did I win the
 * delete" — e.g. releasing CoW ref-count/quota for the asset's content blob —
 * MUST gate on `durableRemoved`, NOT on `removed`. In Postgres mode the JSON
 * mirror is a stale/local cache, so two concurrent deletes can BOTH find a mirror
 * entry and report `removedFromMirror === true`, while only ONE wins the durable
 * `DELETE ... RETURNING`. Gating a release on the mirror would let the loser
 * double-release the blob accounting (quota over-reclaim). `durableRemoved` is a
 * true single-winner in both modes: file mode's synchronous on-disk `removeSync`
 * cannot interleave within a process, and Postgres `DELETE ... RETURNING` is
 * row-atomic across instances.
 */
export async function removeAssetRecordAuthoritativeDetailed(
	projectId: string,
	imageId: string,
): Promise<{ removed: boolean; durableRemoved: boolean }> {
	const removedFromMirror = fileAssetStore.removeSync(projectId, imageId);
	if (!postgresAssetStoreActive()) {
		// File mode: the on-disk index IS the durable store, and the synchronous
		// removeSync is the single-winner (a concurrent remove of the same entry
		// runs after it completes and returns false).
		return { removed: removedFromMirror, durableRemoved: removedFromMirror };
	}
	invalidateHydratedAssets(projectId);
	const removedFromStore = await assetStore.remove(projectId, imageId);
	return { removed: removedFromMirror || removedFromStore, durableRemoved: removedFromStore };
}

export function restoreAssetRecord(projectId: string, record: AssetRecord): void {
	fileAssetStore.restoreSync(projectId, record);
}

/**
 * Authoritative restore. In Postgres mode the durable row is re-inserted (the
 * write upsert undeletes it) so a rollback after a failed object delete cannot
 * leave an orphaned object whose `asset_records` row was already dropped by the
 * async delete. File mode restores the on-disk index entry synchronously.
 */
export async function restoreAssetRecordAuthoritative(projectId: string, record: AssetRecord, context: AssetWriteContext = {}): Promise<void> {
	fileAssetStore.restoreSync(projectId, record);
	if (!postgresAssetStoreActive()) return;
	invalidateHydratedAssets(projectId);
	await assetStore.write(record, context);
}

/**
 * Capture the durable persistence context (workspace_id + metadata) for an asset
 * BEFORE it is deleted. In Postgres mode `workspace_id`/`metadata` live on the
 * row but are NOT carried on {@link AssetRecord}, so a rollback that re-inserts
 * only the record would null them (breaking workspace-scoped indexes/accounting
 * and reservation metadata). Callers in upload-cleanup read this first and pass
 * it back to {@link restoreAssetRecordAuthoritative}. Returns undefined when no
 * row exists; file mode returns an empty context (nothing extra to preserve).
 */
export async function getAssetWriteContextAuthoritative(projectId: string, imageId: string): Promise<AssetWriteContext | undefined> {
	return assetStore.getWriteContext(projectId, imageId);
}

/**
 * Batch authoritative read of many asset records in one project. In Postgres
 * mode this is ONE SELECT (vs. one per image); file mode resolves each id
 * against the on-disk index. Returns a Map keyed by imageId/assetId. Used by
 * upload-cleanup rollback to collapse a per-image query storm into one read.
 */
export async function getAssetRecordsAuthoritativeBatch(
	projectId: string,
	imageIds: string[],
): Promise<Map<string, AssetRecord>> {
	if (imageIds.length === 0) return new Map();
	return assetStore.getManyByProject(projectId, imageIds);
}

/**
 * Batch authoritative read of the durable persistence context (workspace_id +
 * metadata) for many assets in one project. Postgres mode = ONE SELECT; file
 * mode returns an empty context per existing row. Returns a Map keyed by
 * imageId/assetId.
 */
export async function getAssetWriteContextsAuthoritativeBatch(
	projectId: string,
	imageIds: string[],
): Promise<Map<string, AssetWriteContext>> {
	if (imageIds.length === 0) return new Map();
	return assetStore.getManyWriteContexts(projectId, imageIds);
}

/**
 * Batch authoritative delete of many asset records in one project. In Postgres
 * mode the durable rows are deleted in ONE statement (the delete is awaited so
 * failures surface before the object deletes); the JSON mirror is removed for
 * the same ids too. Returns the set of ids that were actually removed (from
 * either the durable store or the mirror), preserving the per-id semantics of
 * {@link removeAssetRecordAuthoritative}.
 */
export async function removeAssetRecordsAuthoritativeBatch(
	projectId: string,
	imageIds: string[],
): Promise<Set<string>> {
	const removed = new Set<string>();
	if (imageIds.length === 0) return removed;
	// Mirror delete first (synchronous, file-mode source of truth; in pg mode just
	// the cache). removeSync returns whether the id existed in the mirror.
	for (const imageId of imageIds) {
		if (fileAssetStore.removeSync(projectId, imageId)) removed.add(imageId);
	}
	if (!postgresAssetStoreActive()) return removed;
	invalidateHydratedAssets(projectId);
	const removedFromStore = await assetStore.removeManyByProject(projectId, imageIds);
	for (const id of removedFromStore) removed.add(id);
	return removed;
}

/**
 * Synchronous listing against the JSON mirror only. Retained for file mode and
 * legacy callers. In Postgres mode this can omit durable rows after a clean
 * disk / second instance; use {@link listAssetRecordsAuthoritative} for any
 * listing that must reflect `asset_records`.
 */
export function listAssetRecords(projectId: string): AssetRecord[] {
	return fileAssetStore.listSync(projectId);
}

/**
 * Authoritative project listing. In Postgres mode the durable store is queried
 * directly so a non-empty-but-stale or empty JSON mirror can never hide rows
 * that exist in `asset_records` (the round-1 bug: a non-empty mirror blocked
 * hydration on a second instance / restarted container / DB-restored project).
 */
export async function listAssetRecordsAuthoritative(projectId: string): Promise<AssetRecord[]> {
	if (!postgresAssetStoreActive()) {
		return fileAssetStore.listSync(projectId);
	}
	const records = await assetStore.listByProject(projectId);
	// Refresh the local cache so adjacent sync-only helpers stay consistent.
	cacheHydratedAssets(projectId, records);
	return records;
}

/**
 * Authoritative workspace-wide storage usage, aggregated in ONE pass. In Postgres
 * mode this issues a single grouped aggregate query over `asset_records` (backed
 * by `asset_records_workspace_idx`, migration 0021) instead of one list query per
 * project followed by a JS reduce — eliminating the N+1 on the hottest read/upload
 * path. File mode iterates the on-disk index per project (no DB to batch against)
 * but exposes the same per-project usage map so callers stay store-agnostic.
 *
 * The summed fields match the storage-quota JS reduce exactly (see
 * {@link ProjectAssetUsage}). Projects with no asset rows are omitted from the map;
 * callers treat a missing entry as zero usage.
 */
export async function summarizeAssetUsageByWorkspace(workspaceId: string, projectIds: string[]): Promise<WorkspaceAssetUsage> {
	const normalizedProjectIds = [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))];
	if (!postgresAssetStoreActive()) {
		// File mode has no durable aggregate to batch; sum each project's on-disk
		// index synchronously, mirroring the original per-project listing.
		const usage: WorkspaceAssetUsage = new Map();
		for (const projectId of normalizedProjectIds) {
			usage.set(projectId, computeProjectAssetUsage(fileAssetStore.listSync(projectId)));
		}
		return usage;
	}
	return assetStore.summarizeByWorkspace(workspaceId.trim(), normalizedProjectIds);
}

/** Reduce a list of asset records into the per-project usage totals (file mode / tests). */
export function computeProjectAssetUsage(records: AssetRecord[]): ProjectAssetUsage {
	let originalBytes = 0;
	let derivativeBytes = 0;
	let derivativeCount = 0;
	for (const record of records) {
		originalBytes += safeAssetByteCount(record.sizeBytes);
		for (const derivative of record.derivatives) {
			derivativeBytes += safeAssetByteCount(derivative.sizeBytes);
			derivativeCount += 1;
		}
	}
	return { originalBytes, derivativeBytes, assetCount: records.length, derivativeCount };
}

/**
 * Byte accounting must match storage-quota's `safeByteCount`: only positive finite
 * numbers count, rounded to an integer; everything else is zero. Kept local so the
 * file-mode reduce here and the SQL aggregate below agree on the exact semantics.
 */
function safeAssetByteCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function listAssetRecordPage(projectId: string, options: AssetListOptions = {}): AssetRecordPage {
	return paginateAssetRecords(listAssetRecords(projectId), options);
}

/**
 * Authoritative paginated listing. In Postgres mode the durable store performs
 * the pagination (cursor + filters pushed into SQL) so results reflect
 * `asset_records` regardless of mirror state. File mode paginates the on-disk
 * index in memory.
 */
export async function listAssetRecordPageAuthoritative(projectId: string, options: AssetListOptions = {}): Promise<AssetRecordPage> {
	if (!postgresAssetStoreActive()) {
		return paginateAssetRecords(fileAssetStore.listSync(projectId), options);
	}
	return assetStore.listPageByProject(projectId, options);
}

function paginateAssetRecords(records: AssetRecord[], options: AssetListOptions = {}): AssetRecordPage {
	const limit = normalizeAssetListLimit(options.limit);
	const cursor = decodeAssetCursor(options.cursor);
	const sorted = [...records]
		.sort(compareAssetRecordOrder)
		.filter((asset) => !options.storageStatus || asset.storageStatus === options.storageStatus)
		.filter((asset) => !options.moderationStatus || asset.moderation.status === options.moderationStatus)
		.filter((asset) => !options.source || (asset.uploadedBy?.source ?? "anonymous") === options.source);
	const filtered = cursor ? sorted.filter((asset) => assetSortsAfterCursor(asset, cursor)) : sorted;
	const assets = filtered.slice(0, limit);
	const lastAsset = assets[assets.length - 1];
	return {
		assets,
		nextCursor: filtered.length > limit && lastAsset ? encodeAssetCursor(lastAsset) : undefined,
	};
}

/**
 * Best-effort local cache of the per-project JSON mirror, kept warm from the
 * durable Postgres store.
 *
 * In Postgres mode `asset_records` is authoritative: every read/serve/AI/token
 * decision goes through an async store-authoritative helper above. This cache
 * (and the on-disk `assets.json`) only exists so the remaining synchronous,
 * best-effort helpers (e.g. storage-quota's sync entry point) observe recent
 * rows. It is never consulted to decide whether an asset is missing or servable,
 * so a stale or empty mirror can no longer hide durable rows.
 */
const inFlightAssetHydrations = new Map<string, Promise<void>>();

function invalidateHydratedAssets(_projectId: string): void {
	// No durable invalidation needed: the on-disk mirror is non-authoritative in
	// Postgres mode. Retained as a hook so authoritative writes/deletes can signal
	// the cache; the next authoritative read overwrites it from the store.
}

/**
 * Refresh the on-disk JSON mirror from a freshly fetched authoritative list so
 * the synchronous best-effort helpers see the same rows. Replaces the prior
 * merge-over-existing behavior with a full rewrite of the durable rows, ensuring
 * a stale local entry cannot linger after a DB-side delete.
 */
function cacheHydratedAssets(projectId: string, records: AssetRecord[]): void {
	const index: Record<string, AssetRecord> = {};
	for (const record of records) {
		index[record.assetId] = record;
	}
	try {
		writeAssetIndex(projectId, index);
	} catch (error) {
		// The mirror is best-effort; a write failure must not break the read path.
		console.error(`Failed to refresh asset mirror for ${projectId}:`, error);
	}
}

function ensureAssetMirrorHydrated(projectId: string): Promise<void> {
	const existing = inFlightAssetHydrations.get(projectId);
	if (existing) return existing;
	const hydration = (async () => {
		try {
			const records = await assetStore.listByProject(projectId);
			cacheHydratedAssets(projectId, records);
		} catch (error) {
			console.error(`Failed to hydrate asset mirror for ${projectId} from durable store:`, error);
		} finally {
			inFlightAssetHydrations.delete(projectId);
		}
	})();
	inFlightAssetHydrations.set(projectId, hydration);
	return hydration;
}

/**
 * Awaitable mirror refresh. In Postgres mode this repopulates the on-disk
 * `assets.json` from the durable store so the synchronous best-effort helpers
 * observe persisted rows. Authoritative reads no longer depend on it (they query
 * the store directly), but it remains useful for warming the cache. No-op in
 * file mode.
 */
export async function hydrateAssetMirrorForProject(projectId: string): Promise<void> {
	if (!postgresAssetStoreActive()) return;
	await ensureAssetMirrorHydrated(projectId);
}

async function resolveWorkspaceId(input: UploadedAssetInput): Promise<string | undefined> {
	if (input.workspaceId?.trim()) return input.workspaceId.trim();
	const fromMetadata = input.metadata?.workspaceId;
	if (typeof fromMetadata === "string" && fromMetadata.trim()) return fromMetadata.trim();
	// Upload / AI-output callers pass only projectId, so infer the owning
	// workspace from project state/catalog. Without this, workspace_id stays NULL
	// and the workspace-scoped asset_records column/index is useless. Lookup is
	// read-only and best-effort: a failure simply leaves workspace_id unset.
	return resolveWorkspaceIdForProject(input.projectId);
}

/**
 * Read-only project -> workspace lookup used to populate `workspace_id` for
 * writes that only carry a project id. Prefers the Postgres project catalog
 * (production source of truth) and falls back to the on-disk `state.json`
 * (prototype/file mode). Returns undefined when no workspace can be determined.
 *
 * Uses the billing-INDEPENDENT storage-plan lookup (which coalesces the plan to
 * `free` and resolves the workspace from the projects->workspaces join) rather
 * than getProjectWorkspacePlan, which returns null unless the workspace has an
 * ACTIVE billing account. A free / no-billing project still belongs to a
 * workspace, so workspace_id must be populated regardless of billing status —
 * otherwise the workspace-scoped asset_records column/index stays NULL and
 * workspace storage accounting is wrong for every unbilled project.
 */
async function resolveWorkspaceIdForProject(projectId: string): Promise<string | undefined> {
	try {
		const plan = await workspaceLookupCatalogStore?.getProjectWorkspaceStoragePlan(projectId);
		const fromCatalog = plan?.workspaceId?.trim();
		if (fromCatalog) return fromCatalog;
	} catch {
		// Fall through to the on-disk state below.
	}
	return readProjectWorkspaceIdFromDisk(projectId);
}

/**
 * Catalog store used for billing-independent project -> workspace inference.
 * Defaults to the module-level {@link projectCatalogStore} (null in file mode);
 * the test seam below lets suites inject a stub so the postgres-catalog branch
 * of {@link resolveWorkspaceIdForProject} can be exercised without a live DB.
 */
let workspaceLookupCatalogStore: Pick<ProjectCatalogStore, "getProjectWorkspaceStoragePlan"> | null = projectCatalogStore;

/**
 * Test seam: swap the catalog store consulted for workspace inference. Returns a
 * restore function. Mirrors {@link setAssetStoreForTests}.
 */
export function setWorkspaceLookupCatalogStoreForTests(
	store: Pick<ProjectCatalogStore, "getProjectWorkspaceStoragePlan"> | null,
): () => void {
	const previous = workspaceLookupCatalogStore;
	workspaceLookupCatalogStore = store;
	return () => {
		workspaceLookupCatalogStore = previous;
	};
}

function readProjectWorkspaceIdFromDisk(projectId: string): string | undefined {
	// Tombstone-aware: a permanently-deleted project must not have its stale
	// state.json resurrected to infer a workspace id for asset accounting.
	const state = readProjectStateFileGuarded<Pick<ProjectState, "workspaceId">>(projectId);
	return state?.workspaceId?.trim() ? state.workspaceId.trim() : undefined;
}

function assertAssetReadyVerdict(asset: AssetRecord | undefined, imageId: string, options: { requireRegistry?: boolean }): void {
	// Legacy projects created before the asset registry are allowed for prototype compatibility.
	if (!asset) {
		if (options.requireRegistry) {
			throw new Error(`Asset ${imageId} is not registered for AI processing`);
		}
		return;
	}

	if (asset.storageStatus !== "released") {
		throw new Error(`Asset ${imageId} is not released for AI processing`);
	}

	if (asset.moderation.status !== "passed") {
		throw new Error(`Asset ${imageId} moderation status is ${asset.moderation.status}`);
	}
}

/**
 * Synchronous AI-readiness check against the JSON mirror only. Retained for file
 * mode and legacy sync callers. In Postgres mode a missing mirror would treat a
 * blocked asset as "unregistered" (servable when requireRegistry is off), so AI
 * paths must use {@link assertAssetReadyForAiAuthoritative}.
 */
export function assertAssetReadyForAi(projectId: string, imageId: string, options: { requireRegistry?: boolean } = {}): void {
	assertAssetReadyVerdict(getAssetRecord(projectId, imageId), imageId, options);
}

/**
 * Authoritative AI-readiness check. In Postgres mode the durable store is
 * queried (await) so a blocked/quarantined asset that exists in `asset_records`
 * is rejected even when the JSON mirror is missing (restart / clean disk / DB
 * restore). File mode reads the on-disk index synchronously.
 */
export async function assertAssetReadyForAiAuthoritative(projectId: string, imageId: string, options: { requireRegistry?: boolean } = {}): Promise<void> {
	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	assertAssetReadyVerdict(asset, imageId, options);
}

function addImageRef(set: Set<string>, value: unknown): void {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed) set.add(trimmed);
	}
}

/**
 * Collect EVERY image id REFERENCED by a project's AUTHORITATIVE state — the real
 * page backgrounds, baked edits, image layers (incl. per-language overrides),
 * non-destructive edit-layer mask/patch assets, the cover, and finalized AI result
 * images.
 *
 * Used by the deploy-time {@link backfillStateReferencedAssets} (codex P0 round-3)
 * to distinguish a LEGACY-LEGITIMATE object (uploaded before asset records existed,
 * but referenced by live state — must keep serving) from an UNMODERATED ORPHAN (a
 * raw AI provider checkpoint `aijob_provider_<jobId>.png`, or any unreferenced
 * object — must stay denied).
 *
 * CSAM-safety invariant: this walks ONLY the persisted ProjectState page/layer/
 * cover/output fields. The raw AI provider checkpoint id lives on the in-flight
 * AiJob CHECKPOINT (`AiJobCheckpoint.providerResultImageId`), which is NOT part of
 * ProjectState — so a pre-moderation checkpoint is NEVER state-referenced and can
 * never be grandfathered. Only the FINAL moderated `aiReviewMarkers[].resultImageId`
 * (which already got a passing record on output-store) is referenced.
 */
export function collectStateReferencedImageIds(state: ProjectState): Set<string> {
	const ids = new Set<string>();
	addImageRef(ids, state.coverImageId);
	for (const marker of state.aiReviewMarkers ?? []) {
		addImageRef(ids, marker.resultImageId);
	}
	for (const page of state.pages ?? []) {
		addImageRef(ids, page.imageId);
		addImageRef(ids, page.edits?.imageId);
		for (const layer of page.imageLayers ?? []) {
			addImageRef(ids, layer.imageId);
			addImageRef(ids, layer.restoreImageId);
		}
		// Per-language image-layer overrides (declared loosely on the language output).
		for (const output of Object.values(page.languageOutputs ?? {})) {
			const langLayers = (output as unknown as Record<string, unknown>).imageLayers;
			if (Array.isArray(langLayers)) {
				for (const layer of langLayers) {
					addImageRef(ids, (layer as Record<string, unknown>)?.imageId);
					addImageRef(ids, (layer as Record<string, unknown>)?.restoreImageId);
				}
			}
		}
		for (const editLayer of page.imageEditLayers ?? []) {
			addImageRef(ids, editLayer.sourceImageId);
			const payload = editLayer.payload as unknown as Record<string, unknown> | undefined;
			addImageRef(ids, payload?.maskAssetId);
			addImageRef(ids, payload?.patchAssetId);
			addImageRef(ids, payload?.realizedPatchAssetId);
			addImageRef(ids, payload?.sourceImageId);
		}
	}
	return ids;
}

/**
 * IMMUTABLE registry-cutoff timestamp (codex P0 round-4 — backfill laundering fix).
 *
 * The deploy-time grandfather backfill may ONLY grandfather objects whose STORAGE
 * creation/modification time is STRICTLY BEFORE this instant. The asset registry +
 * fail-closed serve gate were introduced around this date; anything written AFTER it
 * must have gone (or must go) through the normal upload → moderation → record path,
 * so it is never legitimately "pre-registry legacy".
 *
 * Why a fixed constant (not "now" or env): an attacker can freely write/touch an
 * object, but CANNOT backdate the filesystem/R2 server-set timestamp to before a
 * point already in the PAST. A `now`-relative window would slide forward on every
 * redeploy and re-open the laundering hole. A genuine legacy upload predates this
 * constant → grandfathered; any attacker-parked object is created today (after it) →
 * never grandfathered.
 *
 * 2026-06-01T00:00:00Z is comfortably before the registry/fail-closed rollout
 * (this PR, 2026-06) yet after the prototype's real legacy uploads.
 */
export const ASSET_REGISTRY_GRANDFATHER_CUTOFF_MS = Date.UTC(2026, 5, 1, 0, 0, 0); // 2026-06-01T00:00:00Z

/**
 * Internal / pre-moderation object id prefixes that must NEVER be grandfathered by
 * the backfill, regardless of cutoff or state-reference. `aijob_provider_` is the
 * RAW provider checkpoint written before any moderation runs — grandfathering it
 * would launder unmoderated (potential CSAM) bytes into a `passed` record.
 */
export const NEVER_GRANDFATHER_ID_PREFIXES = ["aijob_provider_"] as const;

/**
 * Whether an image id is an internal / pre-moderation object that must NEVER be
 * grandfathered or treated as a usable export asset (e.g. the raw
 * `aijob_provider_<jobId>.png` provider checkpoint). Exported so the export
 * pipeline can deny the SAME prefixes as the render background — laundering a raw
 * checkpoint id into a per-language `typesetImageId` must never composite
 * unmoderated bytes into an export artifact.
 */
export function isNeverGrandfatherImageId(imageId: string): boolean {
	const base = basename(imageId.trim());
	return NEVER_GRANDFATHER_ID_PREFIXES.some((prefix) => base.startsWith(prefix));
}

/**
 * Test seam: override the grandfather cutoff so tests can simulate "pre-cutoff legacy"
 * vs "post-cutoff fresh" objects without sleeping or back-touching real files across
 * the real (fixed) calendar date. Returns a restore fn.
 */
let grandfatherCutoffMsOverride: number | null = null;
export function setGrandfatherCutoffMsForTests(value: number | null): () => void {
	const previous = grandfatherCutoffMsOverride;
	grandfatherCutoffMsOverride = value;
	return () => {
		grandfatherCutoffMsOverride = previous;
	};
}
function effectiveGrandfatherCutoffMs(): number {
	return grandfatherCutoffMsOverride ?? ASSET_REGISTRY_GRANDFATHER_CUTOFF_MS;
}

/**
 * Register ONE legacy, state-referenced image object as a `passed` asset record
 * (codex P0 round-3 — backfill helper).
 *
 * This is the deploy-time, SERVER-CONTROLLED grandfather step. The caller
 * ({@link backfillStateReferencedAssets}) has already confirmed the id appears in
 * the project's AUTHORITATIVE state references; this function only persists the
 * record. It is NEVER reachable from the serve hot path, so a CLIENT-writable
 * state reference can never trigger registration: a fresh save that references a
 * never-registered object does NOT cause it to be served (the serve gate denies
 * missing-record outright) — only this backfill, run server-side at deploy over
 * the EXISTING corpus, mints records.
 *
 * Returns "registered" (record written), "exists" (a record already exists — skip),
 * or "skipped" (object missing / undecodable / write failed — caller leaves it
 * unregistered so the serve gate keeps denying it).
 */
async function registerLegacyReferencedAssetAsPassed(
	projectId: string,
	imageId: string,
	state: Pick<ProjectState, "workspaceId">,
): Promise<"registered" | "exists" | "skipped"> {
	const existing = await getAssetRecordAuthoritative(projectId, imageId);
	if (existing) return "exists";
	// DEFENSE 1 — prefix exclude: internal/pre-moderation checkpoints (esp. the raw
	// `aijob_provider_<jobId>` provider output) are NEVER grandfathered, even if a
	// crafted client state references them and they predate the cutoff. They are raw,
	// unmoderated bytes by construction.
	if (isNeverGrandfatherImageId(imageId)) return "skipped";
	// DEFENSE 2 — immutable time cutoff: only grandfather objects whose STORAGE-level
	// creation/modification time is STRICTLY BEFORE the registry cutoff. The timestamp
	// is set by the filesystem / R2 at write time and cannot be backdated by a client,
	// so an attacker-parked object (created today, after the cutoff) is rejected while
	// genuine pre-registry legacy uploads pass. Missing/unreadable timestamp → fail
	// closed (do NOT grandfather).
	const createdAtMs = await objectStorage.getProjectImageCreatedAtMs({ projectId, imageId });
	if (createdAtMs === undefined || createdAtMs >= effectiveGrandfatherCutoffMs()) return "skipped";
	// Read the already-live object bytes so the grandfathered record carries a real
	// sha/size/dimensions. Only legacy project-namespace objects are eligible.
	const buffer = await objectStorage.getProjectImage({ projectId, imageId });
	if (!buffer) return "skipped";
	let dimensions: { width: number; height: number };
	try {
		dimensions = await validateUploadedImageBuffer(buffer, imageId);
	} catch {
		// Not a decodable image (or over the pixel ceiling) → do not grandfather.
		return "skipped";
	}
	const timestamp = nowIso();
	const workspaceId = state.workspaceId?.trim() || (await resolveWorkspaceIdForProject(projectId));
	// Grandfather as `passed` (released): this object was already live + served
	// before the registry existed. We do NOT re-moderate here — re-moderation of the
	// legacy corpus is a separate, explicit operation; the goal is only to not 403 a
	// pre-existing, state-referenced image after the serve gate fails closed on
	// missing records.
	const moderation: AssetModerationResult = {
		status: "passed",
		provider: "legacy-grandfather",
		checkedAt: timestamp,
		reason: "legacy state-referenced asset grandfathered by deploy-time backfill (pre-registry upload)",
		categories: {},
	};
	const record: AssetRecord = {
		assetId: imageId,
		projectId,
		imageId,
		originalName: imageId,
		mimeType: "image/png",
		sizeBytes: buffer.byteLength,
		sha256: createSha256(buffer),
		storageDriver: objectStorage.driver,
		storageKey: `projects/${projectId}/images/${imageId}`,
		width: dimensions.width,
		height: dimensions.height,
		storageStatus: "released",
		moderation,
		derivatives: [],
		metadata: { grandfathered: true, grandfatheredAt: timestamp },
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	try {
		await assetStore.write(record, { workspaceId, metadata: record.metadata });
		if (postgresAssetStoreActive()) {
			try {
				fileAssetStore.writeSync(record);
			} catch {
				// Mirror is best-effort.
			}
		}
	} catch (error) {
		console.error(`Failed to backfill legacy referenced asset ${projectId}/${imageId}:`, error);
		return "skipped";
	}
	return "registered";
}

export interface BackfillStateReferencedAssetsResult {
	projectsScanned: number;
	referencesSeen: number;
	registered: number;
	alreadyRegistered: number;
	skipped: number;
}

/**
 * Enumerate every non-tombstoned project id from on-disk state (the authoritative
 * `state.json` is written in BOTH file mode and Postgres mode), so the backfill
 * covers the whole corpus without needing a per-driver object-storage listing API
 * (R2 exposes none in {@link ObjectStorage}).
 */
function listAllProjectIdsForBackfill(): string[] {
	if (!existsSync(PROJECTS_DIR)) return [];
	return readdirSync(PROJECTS_DIR).filter(
		(entry) => isValidProjectId(entry) && !isProjectTombstonedIn(PROJECTS_DIR, entry),
	);
}

/**
 * ONE-TIME, SERVER-SIDE BACKFILL (codex P0 round-3 — CSAM-laundering fix).
 *
 * The serve gate now FAILS CLOSED on a missing asset record (no on-demand
 * grandfather), because the old on-serve grandfather trusted CLIENT-writable
 * project-state references — an attacker could park an unmoderated object, save a
 * crafted state referencing its id, and have the serve path register it `passed`
 * (a NEW laundering bypass). To avoid 403-ing genuine PRE-REGISTRY user images
 * (uploaded before asset records existed, still referenced by live state), this
 * backfill runs at DEPLOY, server-side, over the EXISTING corpus: for every image
 * id referenced by a project's authoritative state that has NO record but whose
 * object is present + decodable, it registers a `passed` record.
 *
 * SAFE TO RE-RUN: ids that already carry a record are skipped (`exists`). After it
 * runs once, every legitimate legacy object has a record and every NEW object
 * always gets one via the normal upload/AI/crop path — so a missing-record object
 * at serve time is genuinely unregistered and is denied.
 *
 * CSAM invariant preserved (codex P0 round-4 — re-run laundering fix). docker-compose
 * wires this before EVERY API start, so it re-runs on every redeploy. Trusting the
 * MUTABLE current state alone is unsafe: an attacker could full-save state that
 * references an unregistered-but-existing object (e.g. a raw `aijob_provider_*`
 * checkpoint while a job is in-flight) and have a LATER redeploy grandfather it. So
 * {@link registerLegacyReferencedAssetAsPassed} grandfathers ONLY under THREE
 * defenses, each independently sufficient to deny:
 *   1. Immutable TIME CUTOFF — the object's STORAGE createdAt/mtime must be strictly
 *      before {@link ASSET_REGISTRY_GRANDFATHER_CUTOFF_MS}. The fs/R2 sets this at
 *      write time; an attacker cannot backdate it to before a past instant, so any
 *      object created AFTER the cutoff (i.e. parked today) is rejected. Genuine
 *      pre-registry uploads predate the cutoff. Missing/unreadable timestamp → deny.
 *   2. PREFIX EXCLUDE — `aijob_provider_*` (raw pre-moderation checkpoints) are never
 *      grandfathered regardless of cutoff/reference.
 *   3. CHECKPOINT CLEANUP — the AI router deletes the raw `aijob_provider_*` object on
 *      job success/terminal, so it does not linger as a launderable object at all.
 * New uploads always create records via the normal upload → moderation → record path.
 */
export async function backfillStateReferencedAssets(options: {
	projectIds?: string[];
	dryRun?: boolean;
} = {}): Promise<BackfillStateReferencedAssetsResult> {
	const projectIds = options.projectIds ?? listAllProjectIdsForBackfill();
	const result: BackfillStateReferencedAssetsResult = {
		projectsScanned: 0,
		referencesSeen: 0,
		registered: 0,
		alreadyRegistered: 0,
		skipped: 0,
	};
	for (const projectId of projectIds) {
		let state: ProjectState | null;
		try {
			state = await resolveProjectState(projectId);
		} catch (error) {
			console.warn(`[backfill] Could not resolve state for ${projectId}; skipping:`, error);
			continue;
		}
		if (!state) continue;
		result.projectsScanned += 1;
		const referenced = collectStateReferencedImageIds(state);
		for (const imageId of referenced) {
			result.referencesSeen += 1;
			if (options.dryRun) {
				const existing = await getAssetRecordAuthoritative(projectId, imageId);
				if (existing) {
					result.alreadyRegistered += 1;
				} else if (isNeverGrandfatherImageId(imageId)) {
					// Excluded prefix → the real path would skip it.
					result.skipped += 1;
				} else {
					const createdAtMs = await objectStorage.getProjectImageCreatedAtMs({ projectId, imageId });
					const buffer = createdAtMs !== undefined && createdAtMs < effectiveGrandfatherCutoffMs()
						? await objectStorage.getProjectImage({ projectId, imageId })
						: undefined;
					if (buffer) result.registered += 1;
					else result.skipped += 1;
				}
				continue;
			}
			const outcome = await registerLegacyReferencedAssetAsPassed(projectId, imageId, state);
			if (outcome === "registered") result.registered += 1;
			else if (outcome === "exists") result.alreadyRegistered += 1;
			else result.skipped += 1;
		}
	}
	return result;
}

interface AssetCursor {
	createdAt: string;
	assetId: string;
}

function normalizeAssetListLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return 100;
	return Math.max(1, Math.min(1000, Math.trunc(limit)));
}

function encodeAssetCursor(asset: AssetRecord): string {
	return Buffer.from(JSON.stringify({
		createdAt: asset.createdAt,
		assetId: asset.assetId,
	}), "utf8").toString("base64url");
}

function decodeAssetCursor(cursor: string | undefined): AssetCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<AssetCursor>;
		if (typeof decoded.createdAt !== "string" || typeof decoded.assetId !== "string") return null;
		if (Number.isNaN(new Date(decoded.createdAt).getTime()) || !decoded.assetId.trim()) return null;
		return {
			createdAt: decoded.createdAt,
			assetId: decoded.assetId,
		};
	} catch {
		return null;
	}
}

function assetSortsAfterCursor(asset: AssetRecord, cursor: AssetCursor): boolean {
	return compareAssetRecordOrder(asset, cursor) > 0;
}

function compareAssetRecordOrder(a: Pick<AssetRecord, "createdAt" | "assetId">, b: Pick<AssetRecord, "createdAt" | "assetId">): number {
	return b.createdAt.localeCompare(a.createdAt) || b.assetId.localeCompare(a.assetId);
}

/**
 * Extra persistence context that is captured by the DB-backed store but is not
 * part of the canonical {@link AssetRecord} shape (which callers already rely
 * on). `workspaceId` enables workspace-scoped storage queries in Postgres.
 */
export interface AssetWriteContext {
	assetRecordId?: string;
	workspaceId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Asset registry persistence contract. The JSON-file implementation is the
 * local/prototype default; the Postgres implementation is selected when
 * `ASSET_REGISTRY_STORE=postgres` and `DATABASE_URL` are set. Both expose the
 * same shape so the write path (`recordUploadedAsset`) is store-agnostic.
 */
export interface AssetStore {
	write(record: AssetRecord, context?: AssetWriteContext): Promise<AssetRecord>;
	get(projectId: string, assetId: string): Promise<AssetRecord | undefined>;
	listByProject(projectId: string): Promise<AssetRecord[]>;
	listPageByProject(projectId: string, options?: AssetListOptions): Promise<AssetRecordPage>;
	/**
	 * Aggregate storage usage across a workspace's projects in a single pass. The
	 * Postgres implementation issues ONE grouped aggregate query (no N+1, no wide
	 * row materialization); the file implementation iterates the on-disk index.
	 * Returns a per-project usage map; projects with no rows are omitted.
	 *
	 * When `projectIds` is provided the aggregate is scoped to those projects (the
	 * caller-resolved workspace membership); when omitted, every row for the
	 * workspace is aggregated.
	 */
	summarizeByWorkspace(workspaceId: string, projectIds?: string[]): Promise<WorkspaceAssetUsage>;
	remove(projectId: string, assetId: string): Promise<boolean>;
	/**
	 * Replace the asset's derivative list (and bump updated_at) without touching
	 * the rest of the record. Used by thumbnail generation so ready/failed
	 * derivative metadata + sizeBytes persist to the source of truth. Returns the
	 * updated record, or undefined when the asset does not exist. Crucially this
	 * must NOT clobber workspace_id / metadata, so it is a targeted column update
	 * rather than a full upsert via {@link write}.
	 */
	updateDerivatives(projectId: string, assetId: string, derivatives: AssetDerivative[]): Promise<AssetRecord | undefined>;
	/**
	 * Replace only moderation/storage safety columns. Used by upload finalization
	 * after the object has a provider-visible URL.
	 */
	updateModeration(projectId: string, assetId: string, moderation: AssetModerationResult, storageStatus?: AssetStorageStatus): Promise<AssetRecord | undefined>;
	/**
	 * Read the persistence context (workspace_id + metadata) that is stored
	 * alongside the row but is NOT carried on the canonical {@link AssetRecord}.
	 * Used by upload-cleanup rollback to recapture a row's workspace/reservation
	 * context before deleting it, so a restore after a failed object delete can
	 * re-insert the row WITH its original workspace_id/metadata rather than
	 * nulling them (which would break workspace-scoped indexes/accounting).
	 * Returns undefined when no row exists. No-op-ish in file mode (returns {}).
	 */
	getWriteContext(projectId: string, assetId: string): Promise<AssetWriteContext | undefined>;
	/**
	 * Batch read of multiple assets in one project. Returns a Map keyed by assetId
	 * (absent keys = no row). The Postgres implementation issues ONE SELECT with an
	 * `asset_id = ANY(ARRAY[...]::text[])` predicate instead of one SELECT per id;
	 * the file implementation reads the in-memory index per id (already O(1) each).
	 * Used by upload-cleanup rollback to avoid a per-image query storm.
	 */
	getManyByProject(projectId: string, assetIds: string[]): Promise<Map<string, AssetRecord>>;
	/**
	 * Batch read of the persistence context (workspace_id + metadata) for multiple
	 * assets in one project. Same batching guarantee as {@link getManyByProject}.
	 * Returns a Map keyed by assetId (absent keys = no row).
	 */
	getManyWriteContexts(projectId: string, assetIds: string[]): Promise<Map<string, AssetWriteContext>>;
	/**
	 * Batch delete of multiple assets in one project. Returns the set of assetIds
	 * that were actually deleted (existed). The Postgres implementation issues ONE
	 * DELETE with an `asset_id = ANY(ARRAY[...]::text[])` predicate; the file
	 * implementation deletes per id from the in-memory index.
	 */
	removeManyByProject(projectId: string, assetIds: string[]): Promise<Set<string>>;
	/**
	 * Phase D — every non-destructive edit-layer asset row across ALL projects,
	 * identified by its server-tagged `metadata.assetKind` (image-edit-mask /
	 * image-edit-patch / image-edit-cache). Used by the orphaned-edit-asset GC
	 * sweep so it can find candidates by metadata instead of scanning every asset
	 * of every project. Returns `{ projectId, imageId }` pairs grouped/ordered by
	 * project so the sweep can resolve each project's live + snapshot references
	 * once. `limit` bounds a single sweep pass. File mode returns [] (the prototype
	 * file store reclaims a project's whole tree on delete; no cross-project row
	 * accumulation to reap).
	 */
	listEditAssetCandidatesAcrossProjects(limit: number): Promise<Array<{ projectId: string; imageId: string }>>;
}

/**
 * JSON-file asset store. Wraps the historical per-project `assets.json` index so
 * the existing synchronous callers keep their exact behavior, while also
 * satisfying the async {@link AssetStore} contract for the shared write path.
 */
export class FileAssetStore implements AssetStore {
	getSync(projectId: string, assetId: string): AssetRecord | undefined {
		return readAssetIndex(projectId)[assetId];
	}

	removeSync(projectId: string, assetId: string): boolean {
		const index = readAssetIndex(projectId);
		if (!index[assetId]) return false;
		delete index[assetId];
		writeAssetIndex(projectId, index);
		return true;
	}

	restoreSync(projectId: string, record: AssetRecord): void {
		const index = readAssetIndex(projectId);
		index[record.assetId] = record;
		writeAssetIndex(projectId, index);
	}

	listSync(projectId: string): AssetRecord[] {
		return Object.values(readAssetIndex(projectId)).sort(compareAssetRecordOrder);
	}

	writeSync(record: AssetRecord): AssetRecord {
		const index = readAssetIndex(record.projectId);
		index[record.assetId] = record;
		writeAssetIndex(record.projectId, index);
		return record;
	}

	updateDerivativesSync(projectId: string, assetId: string, derivatives: AssetDerivative[]): AssetRecord | undefined {
		const index = readAssetIndex(projectId);
		const asset = index[assetId];
		if (!asset) return undefined;
		asset.derivatives = derivatives;
		asset.updatedAt = nowIso();
		index[assetId] = asset;
		writeAssetIndex(projectId, index);
		return asset;
	}

	updateModerationSync(projectId: string, assetId: string, moderation: AssetModerationResult, storageStatus?: AssetStorageStatus): AssetRecord | undefined {
		const index = readAssetIndex(projectId);
		const asset = index[assetId];
		if (!asset) return undefined;
		asset.moderation = moderation;
		if (storageStatus) asset.storageStatus = storageStatus;
		asset.updatedAt = nowIso();
		index[assetId] = asset;
		writeAssetIndex(projectId, index);
		return asset;
	}

	async write(record: AssetRecord): Promise<AssetRecord> {
		return this.writeSync(record);
	}

	async get(projectId: string, assetId: string): Promise<AssetRecord | undefined> {
		return this.getSync(projectId, assetId);
	}

	async listByProject(projectId: string): Promise<AssetRecord[]> {
		return this.listSync(projectId);
	}

	async listPageByProject(projectId: string, options: AssetListOptions = {}): Promise<AssetRecordPage> {
		return paginateAssetRecords(this.listSync(projectId), options);
	}

	async summarizeByWorkspace(_workspaceId: string, projectIds: string[] = []): Promise<WorkspaceAssetUsage> {
		// File mode has no workspace column to query, so the caller-resolved project
		// list drives the iteration. Each project is summed from its on-disk index.
		const usage: WorkspaceAssetUsage = new Map();
		for (const projectId of projectIds) {
			const normalized = projectId.trim();
			if (!normalized) continue;
			usage.set(normalized, computeProjectAssetUsage(this.listSync(normalized)));
		}
		return usage;
	}

	async remove(projectId: string, assetId: string): Promise<boolean> {
		return this.removeSync(projectId, assetId);
	}

	async updateDerivatives(projectId: string, assetId: string, derivatives: AssetDerivative[]): Promise<AssetRecord | undefined> {
		return this.updateDerivativesSync(projectId, assetId, derivatives);
	}

	async updateModeration(projectId: string, assetId: string, moderation: AssetModerationResult, storageStatus?: AssetStorageStatus): Promise<AssetRecord | undefined> {
		return this.updateModerationSync(projectId, assetId, moderation, storageStatus);
	}

	async getWriteContext(projectId: string, assetId: string): Promise<AssetWriteContext | undefined> {
		// File mode never persists a separate workspace_id/metadata context (the
		// JSON index stores only the AssetRecord), so there is nothing to recapture
		// — return an empty context when the row exists, undefined otherwise.
		return this.getSync(projectId, assetId) ? {} : undefined;
	}

	async getManyByProject(projectId: string, assetIds: string[]): Promise<Map<string, AssetRecord>> {
		// Read the index once, then resolve each requested id against it.
		const index = readAssetIndex(projectId);
		const out = new Map<string, AssetRecord>();
		for (const assetId of assetIds) {
			const record = index[assetId];
			if (record) out.set(assetId, record);
		}
		return out;
	}

	async getManyWriteContexts(projectId: string, assetIds: string[]): Promise<Map<string, AssetWriteContext>> {
		const index = readAssetIndex(projectId);
		const out = new Map<string, AssetWriteContext>();
		for (const assetId of assetIds) {
			if (index[assetId]) out.set(assetId, {});
		}
		return out;
	}

	async removeManyByProject(projectId: string, assetIds: string[]): Promise<Set<string>> {
		const index = readAssetIndex(projectId);
		const removed = new Set<string>();
		for (const assetId of assetIds) {
			if (index[assetId]) {
				delete index[assetId];
				removed.add(assetId);
			}
		}
		if (removed.size > 0) writeAssetIndex(projectId, index);
		return removed;
	}

	// File mode: no cross-project asset table to scan. The prototype file store
	// reclaims a project's entire tree on delete, so there is no long-lived
	// cross-project edit-asset accumulation for the GC sweep to reap.
	async listEditAssetCandidatesAcrossProjects(_limit: number): Promise<Array<{ projectId: string; imageId: string }>> {
		return [];
	}
}

export interface AssetStoreSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

interface AssetRow {
	asset_id: string;
	project_id: string;
	workspace_id?: string | null;
	image_id: string;
	original_name: string;
	mime_type: string;
	kind: string;
	sha256: string;
	byte_size: number | string;
	width?: number | string | null;
	height?: number | string | null;
	storage_driver: string;
	storage_key: string;
	storage_status: string;
	moderation_status: string;
	moderation_provider?: string | null;
	moderation_reason?: string | null;
	moderation_detail?: unknown;
	moderation_checked_at?: Date | string | null;
	moderation_ruleset_version?: string | null;
	derivatives?: unknown;
	uploaded_by?: unknown;
	upload_audit_id?: string | null;
	metadata?: unknown;
	created_at: Date | string;
	updated_at: Date | string;
}

/**
 * Postgres-backed asset store. Persists the full asset record — including the
 * moderation verdict (status/provider/reason/categories) which previously lived
 * only inside the JSON record — into `asset_records`. Accepts an injectable SQL
 * client so it can be unit-tested without a live database (mirrors the seam used
 * by the project catalog and usage ledger stores).
 */
export class PostgresAssetStore implements AssetStore {
	private readonly client: AssetStoreSqlClient;

	constructor(client?: AssetStoreSqlClient, databaseUrl = process.env.DATABASE_URL) {
		if (client) {
			this.client = client;
			return;
		}
		if (!databaseUrl?.trim()) {
			throw new Error("ASSET_REGISTRY_STORE=postgres requires DATABASE_URL");
		}
		this.client = getSharedBunSql(databaseUrl) as unknown as AssetStoreSqlClient;
	}

	async write(record: AssetRecord, context: AssetWriteContext = {}): Promise<AssetRecord> {
		await this.client.unsafe(`
			INSERT INTO asset_records (
				asset_id,
				id,
				project_id,
				workspace_id,
				image_id,
				original_name,
				mime_type,
				kind,
				sha256,
				byte_size,
				width,
				height,
				storage_driver,
				storage_key,
				storage_status,
				moderation_status,
				moderation_provider,
				moderation_reason,
				moderation_detail,
				moderation_checked_at,
				moderation_ruleset_version,
				derivatives,
				uploaded_by,
				upload_audit_id,
				metadata,
				created_at,
				updated_at
			)
			VALUES (
				$1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $8, $9, $10,
				$11, $12, $13, $14, $15, $16, $17, $18, $19::text::jsonb, $20, $21,
				$22::text::jsonb, $23::text::jsonb, $24, $25::text::jsonb, $26, $27
			)
			ON CONFLICT (project_id, asset_id) DO UPDATE SET
				id = COALESCE(asset_records.id, EXCLUDED.id),
				workspace_id = EXCLUDED.workspace_id,
				image_id = EXCLUDED.image_id,
				original_name = EXCLUDED.original_name,
				mime_type = EXCLUDED.mime_type,
				kind = EXCLUDED.kind,
				sha256 = EXCLUDED.sha256,
				byte_size = EXCLUDED.byte_size,
				width = EXCLUDED.width,
				height = EXCLUDED.height,
				storage_driver = EXCLUDED.storage_driver,
				storage_key = EXCLUDED.storage_key,
				storage_status = EXCLUDED.storage_status,
				moderation_status = EXCLUDED.moderation_status,
				moderation_provider = EXCLUDED.moderation_provider,
				moderation_reason = EXCLUDED.moderation_reason,
				moderation_detail = EXCLUDED.moderation_detail,
				moderation_checked_at = EXCLUDED.moderation_checked_at,
				moderation_ruleset_version = EXCLUDED.moderation_ruleset_version,
				derivatives = EXCLUDED.derivatives,
				uploaded_by = EXCLUDED.uploaded_by,
				upload_audit_id = EXCLUDED.upload_audit_id,
				metadata = EXCLUDED.metadata,
				updated_at = EXCLUDED.updated_at
		`, [
			record.assetId,
			context.assetRecordId ?? null,
			record.projectId,
			context.workspaceId ?? null,
			record.imageId,
			record.originalName,
			record.mimeType,
			record.uploadedBy?.source ?? "anonymous",
			record.sha256,
			record.sizeBytes,
			record.width,
			record.height,
			record.storageDriver,
			record.storageKey,
			record.storageStatus,
			record.moderation.status,
			record.moderation.provider ?? null,
			record.moderation.reason ?? null,
			JSON.stringify(record.moderation.categories ?? {}),
			record.moderation.checkedAt ?? null,
			record.moderation.rulesetVersion ?? null,
			JSON.stringify(record.derivatives ?? []),
			record.uploadedBy ? JSON.stringify(record.uploadedBy) : null,
			record.uploadAuditId ?? null,
			JSON.stringify(context.metadata ?? {}),
			record.createdAt,
			record.updatedAt,
		]);
		return record;
	}

	async get(projectId: string, assetId: string): Promise<AssetRecord | undefined> {
		const rows = await this.client.unsafe<AssetRow>(`
			SELECT ${ASSET_RECORD_COLUMNS}
			FROM asset_records
			WHERE project_id = $1 AND asset_id = $2
			LIMIT 1
		`, [projectId, assetId]);
		const row = rows[0];
		return row ? mapAssetRow(row) : undefined;
	}

	async listByProject(projectId: string): Promise<AssetRecord[]> {
		const rows = await this.client.unsafe<AssetRow>(`
			SELECT ${ASSET_RECORD_COLUMNS}
			FROM asset_records
			WHERE project_id = $1
			ORDER BY created_at DESC, asset_id DESC
		`, [projectId]);
		return rows.map(mapAssetRow);
	}

	async listPageByProject(projectId: string, options: AssetListOptions = {}): Promise<AssetRecordPage> {
		const limit = normalizeAssetListLimit(options.limit);
		const cursor = decodeAssetCursor(options.cursor);
		const conditions = ["project_id = $1"];
		const params: unknown[] = [projectId];
		let nextParam = 2;
		if (options.storageStatus) {
			conditions.push(`storage_status = $${nextParam}`);
			params.push(options.storageStatus);
			nextParam += 1;
		}
		if (options.moderationStatus) {
			conditions.push(`moderation_status = $${nextParam}`);
			params.push(options.moderationStatus);
			nextParam += 1;
		}
		if (options.source) {
			conditions.push(`kind = $${nextParam}`);
			params.push(options.source);
			nextParam += 1;
		}
		if (cursor) {
			conditions.push(`(created_at < $${nextParam}::timestamptz OR (created_at = $${nextParam}::timestamptz AND asset_id < $${nextParam + 1}))`);
			params.push(cursor.createdAt, cursor.assetId);
			nextParam += 2;
		}
		params.push(limit + 1);
		const rows = await this.client.unsafe<AssetRow>(`
			SELECT ${ASSET_RECORD_COLUMNS}
			FROM asset_records
			WHERE ${conditions.join(" AND ")}
			ORDER BY created_at DESC, asset_id DESC
			LIMIT $${nextParam}
		`, params);
		const assets = rows.slice(0, limit).map(mapAssetRow);
		const lastAsset = assets[assets.length - 1];
		return {
			assets,
			nextCursor: rows.length > limit && lastAsset ? encodeAssetCursor(lastAsset) : undefined,
		};
	}

	async summarizeByWorkspace(workspaceId: string, projectIds?: string[]): Promise<WorkspaceAssetUsage> {
		// ONE grouped aggregate over asset_records, replacing the prior N+1 (one
		// list query per project) + JS reduce. Originals come straight from
		// SUM(byte_size) (a non-negative bigint, so it already matches storage-quota's
		// safeByteCount). Derivative bytes/counts are computed by unnesting the
		// derivatives JSONB array per row in a LATERAL subquery and summing each
		// derivative's positive numeric sizeBytes (mirroring safeAssetByteCount:
		// positive, finite, rounded — non-numeric / missing / non-positive contribute
		// 0).
		//
		// Scope: the prior per-project path summed strictly by project_id (a row's
		// possibly-NULL/stale workspace_id never affected which project it counted
		// under), so to preserve EXACT numbers this scopes by the caller-resolved
		// project list via project_id = ANY(...), served by
		// asset_records_project_created_id_idx. When no project list is supplied it
		// falls back to the workspace_id column (asset_records_workspace_idx,
		// migration 0021) for a true workspace-wide aggregate.
		const params: unknown[] = [];
		let predicate: string;
		if (projectIds && projectIds.length > 0) {
			// Scalar ARRAY[] binds: Bun.SQL cannot bind a JS array for $n::text[]
			// (it serializes ["a","b"] as the malformed literal "a,b").
			predicate = `ar.project_id = ANY(${pushArrayLiteral(params, projectIds, "text")})`;
		} else {
			params.push(workspaceId);
			predicate = `ar.workspace_id = $${params.length}`;
		}
		const rows = await this.client.unsafe<{
			project_id: string;
			original_bytes: number | string | null;
			asset_count: number | string | null;
			derivative_bytes: number | string | null;
			derivative_count: number | string | null;
		}>(`
			SELECT
				ar.project_id AS project_id,
				COALESCE(SUM(ar.byte_size), 0) AS original_bytes,
				COUNT(*) AS asset_count,
				COALESCE(SUM(d.derivative_bytes), 0) AS derivative_bytes,
				COALESCE(SUM(d.derivative_count), 0) AS derivative_count
			FROM asset_records ar
			LEFT JOIN LATERAL (
				SELECT
					COUNT(*) AS derivative_count,
					COALESCE(SUM(
						CASE
							WHEN jsonb_typeof(elem->'sizeBytes') = 'number' AND (elem->>'sizeBytes')::numeric > 0
							THEN round((elem->>'sizeBytes')::numeric)
							ELSE 0
						END
					), 0) AS derivative_bytes
				FROM jsonb_array_elements(
					CASE WHEN jsonb_typeof(ar.derivatives) = 'array' THEN ar.derivatives ELSE '[]'::jsonb END
				) AS elem
			) d ON true
			WHERE ${predicate}
			GROUP BY ar.project_id
		`, params);
		const usage: WorkspaceAssetUsage = new Map();
		for (const row of rows) {
			usage.set(String(row.project_id), {
				originalBytes: Number(row.original_bytes ?? 0),
				derivativeBytes: Number(row.derivative_bytes ?? 0),
				assetCount: Number(row.asset_count ?? 0),
				derivativeCount: Number(row.derivative_count ?? 0),
			});
		}
		return usage;
	}

	async remove(projectId: string, assetId: string): Promise<boolean> {
		const rows = await this.client.unsafe<{ asset_id: string }>(`
			DELETE FROM asset_records
			WHERE project_id = $1 AND asset_id = $2
			RETURNING asset_id
		`, [projectId, assetId]);
		return rows.length > 0;
	}

	async updateDerivatives(projectId: string, assetId: string, derivatives: AssetDerivative[]): Promise<AssetRecord | undefined> {
		// Targeted column update: only derivatives + updated_at change, so the
		// thumbnail pipeline never clobbers workspace_id / metadata (which the
		// full-record upsert in write() would overwrite from EXCLUDED). RETURNING
		// the row lets callers refresh the local mirror with the persisted state.
		const rows = await this.client.unsafe<AssetRow>(`
			UPDATE asset_records
			SET derivatives = $3::text::jsonb,
				updated_at = $4
			WHERE project_id = $1 AND asset_id = $2
			RETURNING ${ASSET_RECORD_COLUMNS}
		`, [projectId, assetId, JSON.stringify(derivatives ?? []), nowIso()]);
		const row = rows[0];
		return row ? mapAssetRow(row) : undefined;
	}

	async updateModeration(projectId: string, assetId: string, moderation: AssetModerationResult, storageStatus?: AssetStorageStatus): Promise<AssetRecord | undefined> {
		const rows = await this.client.unsafe<AssetRow>(`
			UPDATE asset_records
			SET storage_status = COALESCE($3, storage_status),
				moderation_status = $4,
				moderation_provider = $5,
				moderation_reason = $6,
				moderation_detail = $7::text::jsonb,
				moderation_checked_at = $8,
				moderation_ruleset_version = $9,
				updated_at = $10
			WHERE project_id = $1 AND asset_id = $2
			RETURNING ${ASSET_RECORD_COLUMNS}
		`, [
			projectId,
			assetId,
			storageStatus ?? null,
			moderation.status,
			moderation.provider ?? null,
			moderation.reason ?? null,
			JSON.stringify(moderation.categories ?? {}),
			moderation.checkedAt ?? null,
			moderation.rulesetVersion ?? null,
			nowIso(),
		]);
		const row = rows[0];
		return row ? mapAssetRow(row) : undefined;
	}

	async getWriteContext(projectId: string, assetId: string): Promise<AssetWriteContext | undefined> {
		// workspace_id + metadata live on the row but are NOT part of AssetRecord /
		// ASSET_RECORD_COLUMNS, so read them directly. Upload-cleanup rollback uses
		// this to recapture context BEFORE deleting, so a restore re-inserts the row
		// with its original workspace_id/metadata instead of nulling them.
		const rows = await this.client.unsafe<{ workspace_id?: string | null; metadata?: unknown }>(`
			SELECT workspace_id, metadata
			FROM asset_records
			WHERE project_id = $1 AND asset_id = $2
			LIMIT 1
		`, [projectId, assetId]);
		const row = rows[0];
		if (!row) return undefined;
		const workspaceId = row.workspace_id?.trim() ? row.workspace_id.trim() : undefined;
		const parsedMetadata = parseJsonColumn(row.metadata);
		const metadata = parsedMetadata && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)
			? (parsedMetadata as Record<string, unknown>)
			: undefined;
		return { workspaceId, metadata };
	}

	async getManyByProject(projectId: string, assetIds: string[]): Promise<Map<string, AssetRecord>> {
		const out = new Map<string, AssetRecord>();
		if (assetIds.length === 0) return out;
		// ONE SELECT for the whole batch, replacing the per-image SELECT in the
		// upload-cleanup loop. assetIds are bound as individual scalars inside an
		// ARRAY[...]::text[] literal — Bun.SQL.unsafe cannot bind a JS array directly
		// (it throws 'malformed array literal' on real Postgres), so we never pass an
		// array as a single param.
		const { placeholders, params } = anyTextArray([projectId], assetIds);
		const rows = await this.client.unsafe<AssetRow>(`
			SELECT ${ASSET_RECORD_COLUMNS}
			FROM asset_records
			WHERE project_id = $1 AND asset_id = ANY(ARRAY[${placeholders}]::text[])
		`, params);
		for (const row of rows) out.set(row.asset_id, mapAssetRow(row));
		return out;
	}

	async getManyWriteContexts(projectId: string, assetIds: string[]): Promise<Map<string, AssetWriteContext>> {
		const out = new Map<string, AssetWriteContext>();
		if (assetIds.length === 0) return out;
		const { placeholders, params } = anyTextArray([projectId], assetIds);
		const rows = await this.client.unsafe<{ asset_id: string; workspace_id?: string | null; metadata?: unknown }>(`
			SELECT asset_id, workspace_id, metadata
			FROM asset_records
			WHERE project_id = $1 AND asset_id = ANY(ARRAY[${placeholders}]::text[])
		`, params);
		for (const row of rows) {
			const workspaceId = row.workspace_id?.trim() ? row.workspace_id.trim() : undefined;
			const parsedMetadata = parseJsonColumn(row.metadata);
			const metadata = parsedMetadata && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)
				? (parsedMetadata as Record<string, unknown>)
				: undefined;
			out.set(row.asset_id, { workspaceId, metadata });
		}
		return out;
	}

	async removeManyByProject(projectId: string, assetIds: string[]): Promise<Set<string>> {
		const removed = new Set<string>();
		if (assetIds.length === 0) return removed;
		const { placeholders, params } = anyTextArray([projectId], assetIds);
		const rows = await this.client.unsafe<{ asset_id: string }>(`
			DELETE FROM asset_records
			WHERE project_id = $1 AND asset_id = ANY(ARRAY[${placeholders}]::text[])
			RETURNING asset_id
		`, params);
		for (const row of rows) removed.add(row.asset_id);
		return removed;
	}

	async listEditAssetCandidatesAcrossProjects(limit: number): Promise<Array<{ projectId: string; imageId: string }>> {
		// Targeted scan: only rows the upload path tagged as an edit-layer asset
		// (mask / patch / cache). Ordered by project so the sweep resolves each
		// project's live + snapshot references once per project. The metadata->>
		// extraction uses the JSONB column; an untagged legacy edit asset (written
		// before Phase D) is simply not a candidate — it is still protected by the
		// live/snapshot reference guards on the delete path, never auto-reaped.
		//
		// GRACE PERIOD (data-safety): the editor uploads a mask/patch asset FIRST and only
		// commits the referencing `imageEditLayers` entry on a later debounced save. A reaper
		// run inside that window would see no reference and delete a brand-new, about-to-be-
		// referenced asset. So a candidate must be older than EDIT_ASSET_GC_GRACE_HOURS — far
		// longer than any upload→save gap — before it is even eligible. Newer rows are skipped.
		const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, 5000));
		const rows = await this.client.unsafe<{ project_id: string; image_id: string }>(`
			SELECT project_id, image_id
			FROM asset_records
			WHERE metadata->>'assetKind' IN ('image-edit-mask', 'image-edit-patch', 'image-edit-cache')
			  AND created_at < now() - ($2 || ' hours')::interval
			ORDER BY project_id ASC, created_at ASC, asset_id ASC
			LIMIT $1
		`, [safeLimit, String(EDIT_ASSET_GC_GRACE_HOURS)]);
		return rows.map((row) => ({ projectId: row.project_id, imageId: row.image_id }));
	}
}

/**
 * Render `ARRAY[$n, $n+1, ...]::text[]` placeholders for a batch of values,
 * appended after `leading` params. Returns the comma-joined placeholder string
 * (to splice into the SQL between `ARRAY[` and `]::text[]`) and the full,
 * flattened param list. Each value is one scalar bind — NEVER a JS array — so
 * Bun.SQL.unsafe does not throw 'malformed array literal' on real Postgres.
 */
function anyTextArray(leading: unknown[], values: string[]): { placeholders: string; params: unknown[] } {
	const params = [...leading];
	const placeholders = values
		.map((value) => {
			params.push(value);
			return `$${params.length}`;
		})
		.join(", ");
	return { placeholders, params };
}

const ASSET_RECORD_COLUMNS = `
	asset_id,
	project_id,
	workspace_id,
	image_id,
	original_name,
	mime_type,
	kind,
	sha256,
	byte_size,
	width,
	height,
	storage_driver,
	storage_key,
	storage_status,
	moderation_status,
	moderation_provider,
	moderation_reason,
	moderation_detail,
	moderation_checked_at,
	moderation_ruleset_version,
	derivatives,
	uploaded_by,
	upload_audit_id,
	metadata,
	created_at,
	updated_at
`.trim();

function mapAssetRow(row: AssetRow): AssetRecord {
	const moderation: AssetModerationResult = {
		status: row.moderation_status as AssetModerationStatus,
		provider: row.moderation_provider ?? "unknown",
		// Prefer the dedicated moderation timestamp; fall back to updated_at only
		// for legacy rows written before moderation_checked_at existed (updated_at
		// advances for non-moderation writes, so it is not a faithful substitute).
		checkedAt: toIso(row.moderation_checked_at ?? row.updated_at),
		reason: row.moderation_reason ?? undefined,
		categories: normalizeCategories(row.moderation_detail),
		rulesetVersion: row.moderation_ruleset_version ?? undefined,
	};
	return {
		assetId: row.asset_id,
		projectId: row.project_id,
		imageId: row.image_id,
		originalName: row.original_name,
		mimeType: row.mime_type,
		sizeBytes: Number(row.byte_size ?? 0),
		sha256: row.sha256,
		storageDriver: row.storage_driver as StorageDriver,
		storageKey: row.storage_key,
		width: Number(row.width ?? 0),
		height: Number(row.height ?? 0),
		storageStatus: row.storage_status as AssetStorageStatus,
		moderation,
		derivatives: normalizeDerivatives(row.derivatives),
		uploadedBy: normalizeUploadedBy(row.uploaded_by, row.kind),
		uploadAuditId: row.upload_audit_id ?? undefined,
		metadata: normalizeMetadata(row.metadata),
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	};
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
	const parsed = parseJsonColumn(value);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const record = parsed as Record<string, unknown>;
		return Object.keys(record).length > 0 ? record : undefined;
	}
	return undefined;
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : String(value);
}

function parseJsonColumn(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value;
}

function normalizeCategories(value: unknown): Record<string, number> | undefined {
	const parsed = parseJsonColumn(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const entries = Object.entries(parsed as Record<string, unknown>)
		.filter(([, score]) => typeof score === "number" && Number.isFinite(score)) as Array<[string, number]>;
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeDerivatives(value: unknown): AssetDerivative[] {
	const parsed = parseJsonColumn(value);
	return Array.isArray(parsed) ? (parsed as AssetDerivative[]) : [];
}

function normalizeUploadedBy(value: unknown, kind: string): AssetActor | undefined {
	const parsed = parseJsonColumn(value);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const actor = parsed as Partial<AssetActor>;
		if (typeof actor.source === "string") return actor as AssetActor;
	}
	const source = kind as AssetActor["source"];
	return source && source !== "anonymous" ? { source } : undefined;
}

function createAssetStore(): AssetStore {
	if (serverConfig.assetRegistryStore === "postgres") {
		return new PostgresAssetStore();
	}
	return fileAssetStore;
}

/**
 * Synchronous file store backing the legacy sync helpers (`getAssetRecord`,
 * `removeAssetRecord`, `restoreAssetRecord`, `listAssetRecords`). These keep the
 * file path regardless of the toggle so existing callers stay synchronous.
 */
export const fileAssetStore = new FileAssetStore();

/**
 * Active store for the shared write path (`recordUploadedAsset`). Postgres when
 * the toggle + DATABASE_URL are set, otherwise the JSON-file store (default).
 */
export let assetStore: AssetStore = createAssetStore();

/**
 * Test seam mirroring `set*StoreForTests` in storage-quota: swap the active
 * durable store (e.g. an in-memory Postgres fake) and clear hydration caches so
 * the postgres-mode code paths can be exercised without a live database.
 * Returns a restore function.
 */
export function setAssetStoreForTests(store: AssetStore): () => void {
	const previous = assetStore;
	assetStore = store;
	inFlightAssetHydrations.clear();
	return () => {
		assetStore = previous;
		inFlightAssetHydrations.clear();
	};
}
