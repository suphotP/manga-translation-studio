// Wave 3 W3.10: server-side export pipeline routes.
//
//   POST /api/export             enqueue an export job for a project
//   GET  /api/export/:id         job status + a freshly-minted signed URL
//   GET  /api/export/presets     list built-in + workspace export presets
//   POST /api/export/presets     save a workspace export preset
//
// Authz model mirrors the rest of the app: a project that belongs to a workspace
// requires the caller to hold the workspace `export_project` permission (and the
// project must be in their scope); a personal/anonymous prototype project is
// gated on owner match. Jobs are read back scoped to the caller's workspace so a
// cross-tenant job id never resolves.

import { getSharedBunSql } from "../services/sql-pool.js";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "crypto";
import { inflateRawSync } from "zlib";
import { z } from "zod/v4";
import { serverConfig } from "../config.js";
import { getAuthUser, optionalAuth } from "../middleware/auth.middleware.js";
import {
	WorkspaceAccessError,
	workspaceAccessStore,
	workspaceScopeAllows,
	isFineGrainedScope,
	type WorkspaceMemberRecord,
} from "../services/workspace-access.js";
import {
	enqueueExportJob,
	EXPORT_PRESETS,
	exportJobStore,
	isExportPreset,
	listExportPresetConfigs,
	MissingLanguageOutputError,
	signExportUrl,
	type ExportJob,
} from "../services/export-pipeline.js";
import { objectStorage } from "../services/storage.js";
import { createZipBuffer, type ZipFileInput } from "../services/zip-writer.js";
import {
	assertEgressNotThrottledOrResponse,
	recordEgressWithAllowanceOrResponse,
	releaseEgressReservationBestEffort,
	reserveEgressForReadOrResponse,
} from "../services/egress-guard.js";
import {
	buildModerationDerivativePlan,
	createSha256,
	executeModerationTilePlan,
	isNeverGrandfatherImageId,
	listAssetRecordsAuthoritative,
	removeAssetRecordAuthoritative,
	UploadedImageDecodeError,
	UploadedImageTooLargeError,
	recordUploadedAsset,
	validateUploadedImageBuffer,
} from "../services/assets.js";
import { assertChapterUploadLimit, cleanupUncommittedUploadObjects, resolveCowAccount, storageCowActive } from "./images.js";
import { getSharedStorageCowService, QuotaFrozenError } from "../services/storage-cow.js";
import { isActiveChapterTeamMember } from "../services/chapter-team.js";
import { RequestBodyLimitError } from "../middleware/security-guards.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import {
	buildDenylistLookupFailClosedResult,
	buildKnownBlockedShaAssetResult,
	lookupKnownBlockedSha256,
	moderateImageBuffer,
} from "../services/moderation.js";
import {
	computeExportReadiness,
	type ExportReadinessInput,
} from "../services/export-readiness.js";
import {
	pageWorkSubjectId,
	workStateStore,
	type WorkStateValue,
} from "../services/work-states.js";
import type { JWTPayload } from "../types/auth.js";
import { hasPermission } from "../types/auth.js";
import type { AssetActor, AssetModerationResult, AssetModerationStatus, AssetRecord, ProjectState } from "../types/index.js";
import { getTrustedClientIp } from "../utils/client-ip.js";
import { isValidProjectId, sanitizeFilename } from "../utils/security.js";
import { resolveProjectState } from "../utils/project-state-file.js";
import { withProjectCrossReplicaLock, writeProjectState } from "./project.js";
import {
	reserveProjectStorageQuota,
	releaseProjectStorageQuotaReservationBestEffort,
	StorageQuotaExceededError,
} from "../services/storage-quota.js";
import { assertUploadUsageAllowance, recordUploadUsage, UsageQuotaExceededError } from "../services/usage-ledger.js";
import { publishPageSetChangedEvent } from "../services/realtime-bus.js";

const exportRoutes = new Hono();
exportRoutes.use("*", optionalAuth);
const cleanedImportRoutes = new Hono();
cleanedImportRoutes.use("*", optionalAuth);

// Only the recognized, bounded render-override fields are accepted from the
// client; anything else is stripped (`.strict()` on the params object). This is a
// DoS guard for the slice controls in particular: legacy `sliceHeights` is
// constrained to a bounded array, and the explicit `split.heightPerPiece` is a
// single bounded integer for the user-facing custom-height webtoon export path.
// `resolveEffectiveConfig` in the pipeline additionally clamps values into the
// safe runtime range — this schema is the first gate.
const EXPORT_MAX_SLICE_HEIGHTS = 16;
const exportSplitParamsSchema = z.object({
	mode: z.literal("height"),
	heightPerPiece: z.number().int().positive().max(20000),
}).strict();

const exportParamsSchema = z.object({
	maxWidth: z.number().int().positive().max(20000).optional(),
	quality: z.number().int().min(1).max(100).optional(),
	format: z.enum(["original", "jpeg", "webp", "avif"]).optional(),
	sliceHeights: z.array(z.number().int().positive().max(20000)).min(1).max(EXPORT_MAX_SLICE_HEIGHTS).optional(),
	split: exportSplitParamsSchema.optional(),
}).strict();

const enqueueSchema = z.object({
	projectId: z.string().trim().min(1).max(200),
	preset: z.enum(EXPORT_PRESETS as unknown as [string, ...string[]]),
	chapterId: z.string().trim().min(1).max(200).optional(),
	targetLang: z.string().trim().min(1).max(32).optional(),
	imageIds: z.array(z.string().trim().min(1).max(300)).min(1).max(500).optional(),
	params: exportParamsSchema.optional(),
});

const savePresetSchema = z.object({
	workspaceId: z.string().trim().min(1).max(200),
	name: z.string().trim().min(1).max(120),
	config: z.record(z.string(), z.unknown()),
});

/**
 * Mirror of the project route's anonymous-access posture: an ownerless legacy
 * project is only reachable without auth when auth is not globally required AND
 * the operator has explicitly opted back into the legacy-anonymous hatch.
 */
function allowsLegacyAnonymousProjectAccess(): boolean {
	return !serverConfig.apiAuthRequired && serverConfig.allowLegacyAnonymousProjects;
}

interface ProjectAccess {
	state: ProjectState;
	workspaceId?: string;
	member?: WorkspaceMemberRecord;
}

/**
 * Resolve + authorize access to a project for export. Workspace projects require
 * the `export_project` workspace permission; personal/anonymous projects are
 * gated on owner match. Returns a Response on any failure so callers can
 * short-circuit.
 */
async function authorizeProjectExport(c: Context, projectId: string, options: { blockWhenSuspended?: boolean } = {}): Promise<ProjectAccess | Response> {
	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format", code: "invalid_project_id" }, 400);
	}
	// Catalog-authoritative, tombstone-aware read: under Postgres the catalog row
	// wins (no stale file state); a permanently-deleted id must not re-enable export
	// even if a stale state.json survived a partial delete.
	const state = await resolveProjectState(projectId);
	if (!state) {
		return c.json({ error: "Project not found", code: "project_not_found" }, 404);
	}
	const user = getAuthUser(c) as JWTPayload | undefined;
	const workspaceId = state.workspaceId?.trim();

	if (workspaceId) {
		if (!user) {
			return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
		}
		if (!workspaceAccessStore) {
			return c.json({
				error: "Workspace export requires the Postgres workspace access store",
				code: "workspace_store_unavailable",
			}, 503);
		}
		try {
			// Scoped permission: the member must both hold export_project AND have the
			// project in their scope, so a scoped contributor can't export a project
			// they're not assigned to.
			const member = await workspaceAccessStore.requireScopedPermission(
				workspaceId,
				user.userId,
				"export_project",
				{ projectId, resourceKind: "asset" },
			);
			// FREEZE gate: export is a read-side permission, but the export pipeline
			// WRITES artifacts AND records billable usage, so a frozen workspace
			// (verified refund/chargeback or admin suspension) must block the enqueue
			// path for everyone. Pure reads (readiness probe) stay allowed.
			if (options.blockWhenSuspended && await workspaceAccessStore.isWorkspaceSuspended(workspaceId)) {
				return c.json({
					error: "Workspace is suspended (payment refund/chargeback). Pay to restore access.",
					code: "workspace_suspended",
				}, 403);
			}
			return { state, workspaceId, member };
		} catch (error) {
			if (error instanceof WorkspaceAccessError) {
				return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
			}
			throw error;
		}
	}

	// Personal / anonymous prototype project: only the owner may export. An
	// ownerless (legacy) project is reachable without auth ONLY when the
	// anonymous-hardening hatch is explicitly enabled, matching the project routes
	// — a hardened deployment must not let a guessed id enqueue exports.
	if (state.userId) {
		if (!user) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
		if (state.userId !== user.userId) {
			return c.json({ error: "Project not found", code: "project_not_found" }, 404);
		}
	} else if (!allowsLegacyAnonymousProjectAccess()) {
		// Ownerless project under a hardened posture: behave like project routes —
		// 401 without auth, 404 for a non-owner (here, any authenticated user, since
		// the project has no owner to match).
		if (!user) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
		return c.json({ error: "Project not found", code: "project_not_found" }, 404);
	}
	return { state };
}

/** Default source image ids = every page's source image, in page order. */
function defaultImageIds(state: ProjectState): string[] {
	return state.pages.map((page) => page.imageId).filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** The set of source image ids that actually belong to a page of this project. */
function projectPageImageIds(state: ProjectState): Set<string> {
	const ids = new Set<string>();
	for (const page of state.pages) {
		if (typeof page.imageId === "string" && page.imageId.length > 0) ids.add(page.imageId);
	}
	return ids;
}

/**
 * Map EVERY page-owned image id (the canonical `page.imageId` AND its EDITED/cleaned
 * background `page.edits?.imageId`) to the page's CANONICAL source id. The client
 * export planning uses `page.edits?.imageId || page.imageId` as a page's export id
 * (frontend `page-export.ts:308`), and storage/project routes already treat
 * `page.edits.imageId` as page-owned — so an export request that names an edited id
 * is legitimate. Normalizing it back to the canonical `page.imageId` keeps page scope
 * + `sourcePageCount` page-based (an edited id resolves to its page, counted once)
 * and lets `buildLanguageRenderPlans` resolve the background through its own
 * page-edit-aware chain.
 */
function pageIdNormalizationMap(state: ProjectState): Map<string, string> {
	const map = new Map<string, string>();
	for (const page of state.pages) {
		const canonical = typeof page.imageId === "string" && page.imageId.length > 0 ? page.imageId : undefined;
		if (!canonical) continue;
		map.set(canonical, canonical);
		const editedId = page.edits?.imageId;
		if (typeof editedId === "string" && editedId.length > 0) map.set(editedId, canonical);
	}
	return map;
}

/**
 * Normalize each requested image id to its CANONICAL page source id via
 * {@link pageIdNormalizationMap}, accepting BOTH `page.imageId` and a page's
 * `page.edits?.imageId`. Returns undefined if ANY requested id does not resolve to a
 * page of this project (so the caller rejects with `unknown_export_id`). Dedupes by
 * canonical id (an edited id and its source id collapse to one page) so a page is
 * exported + counted once regardless of which form was requested.
 */
function normalizeRequestedPageImageIds(state: ProjectState, imageIds: string[]): string[] | undefined {
	const map = pageIdNormalizationMap(state);
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const id of imageIds) {
		const canonical = map.get(id);
		if (!canonical) return undefined;
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		normalized.push(canonical);
	}
	return normalized;
}

/**
 * Whether every (already-canonicalized) requested image id resolves to a real
 * `state.pages[].imageId`. Kept as a thin guard for callers that pass canonical ids
 * directly; the POST route canonicalizes via {@link normalizeRequestedPageImageIds}
 * first, so this is a defense-in-depth re-check.
 */
function imageIdsAreProjectPages(state: ProjectState, imageIds: string[]): boolean {
	const pageImageIds = projectPageImageIds(state);
	return imageIds.every((id) => pageImageIds.has(id));
}

/**
 * Resolve each requested source image id to its page index in the project. An id
 * that does not correspond to a page maps to undefined so scope enforcement can
 * reject it (a scoped member may only export images that belong to a page they're
 * assigned). Filters the page-scope ids so a contributor limited to page 0 cannot
 * export pages/images outside their assignment.
 */
function imageIdsWithinScope(state: ProjectState, imageIds: string[], member: WorkspaceMemberRecord): boolean {
	const pageIndexById = new Map<string, number>();
	state.pages.forEach((page, index) => {
		if (typeof page.imageId === "string" && page.imageId.length > 0) {
			pageIndexById.set(page.imageId, index);
		}
	});
	return imageIds.every((imageId) => {
		const pageIndex = pageIndexById.get(imageId);
		// An id with no matching page can't be scope-validated → deny for a scoped
		// member rather than silently allowing an arbitrary id.
		if (pageIndex === undefined) return false;
		return workspaceScopeAllows(member.scope, { projectId: state.projectId, resourceKind: "asset", pageIndex });
	});
}

interface ExportOutputView {
	objectId: string;
	sourceImageId?: string;
	sliceIndex?: number;
	contentType?: string;
	sizeBytes?: number;
	/** Signed direct URL when the driver supports presigning (R2/S3). */
	signedUrl?: string;
	/** Always-present through-backend download path (works on local disk too). */
	downloadPath: string;
}

/**
 * Build a downloadable view for every produced object so a multi-output export
 * (multi-page / webtoon_split) is fully retrievable: each entry carries a signed
 * URL (when the driver can presign) AND a through-backend download path that the
 * client can always use. Returns [] for a non-done job.
 */
function buildOutputViews(job: ExportJob): ExportOutputView[] {
	if (job.status !== "done") return [];
	const outputs = Array.isArray(job.params?.outputs) ? (job.params.outputs as Array<Record<string, unknown>>) : [];
	const views: ExportOutputView[] = [];
	const toPath = (objectId: string) => `/api/export/${encodeURIComponent(job.id)}/objects/${objectId.split("/").map(encodeURIComponent).join("/")}`;
	const addView = (objectId: string, extra: Partial<ExportOutputView> = {}) => {
		views.push({
			objectId,
			signedUrl: signExportUrl(job.projectId, objectId),
			downloadPath: toPath(objectId),
			...extra,
		});
	};
	if (typeof job.params?.manifestObjectId === "string") {
		addView(job.params.manifestObjectId, { contentType: "application/json" });
	}
	for (const entry of outputs) {
		if (entry && typeof entry.objectId === "string") {
			addView(entry.objectId, {
				sourceImageId: typeof entry.sourceImageId === "string" ? entry.sourceImageId : undefined,
				sliceIndex: typeof entry.sliceIndex === "number" ? entry.sliceIndex : undefined,
				contentType: typeof entry.contentType === "string" ? entry.contentType : undefined,
				sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : undefined,
			});
		}
	}
	return views;
}

function serializeJob(job: ExportJob, signedUrl?: string): Record<string, unknown> {
	return {
		id: job.id,
		workspaceId: job.workspaceId,
		projectId: job.projectId,
		chapterId: job.chapterId,
		targetLang: job.targetLang,
		preset: job.preset,
		status: job.status,
		resultKey: job.resultKey,
		// Prefer a freshly minted URL (the stored one may have expired).
		resultSignedUrl: signedUrl ?? job.resultSignedUrl,
		// Every produced object with a download URL + through-backend fallback path.
		outputs: buildOutputViews(job),
		error: job.error,
		params: job.params,
		createdAt: job.createdAt,
		completedAt: job.completedAt,
	};
}

function resolveDefaultTargetLang(state: ProjectState): string | undefined {
	return typeof state.targetLang === "string" && state.targetLang.trim().length > 0 ? state.targetLang.trim() : undefined;
}

function resolveRequestTargetLang(state: ProjectState, requested: string | undefined): string | undefined {
	return requested?.trim() || resolveDefaultTargetLang(state);
}

interface OriginalsManifestPage {
	pageIndex: number;
	pageNumber: number;
	imageId: string;
	sourceName: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}

interface OriginalsArchive {
	buffer: Buffer;
	filename: string;
	manifest: {
		kind: "chapter-originals";
		chapterId: string;
		projectId: string;
		projectName: string;
		createdAt: string;
		pageCount: number;
		pages: OriginalsManifestPage[];
	};
}

function originalDownloadAssetBlocked(asset: AssetRecord): { code: string; storageStatus?: string; moderationStatus?: string } | null {
	const moderationStatus = asset.moderation?.status;
	if (asset.storageStatus === "released" && moderationStatus === "passed") return null;
	return {
		code: "asset_not_downloadable",
		storageStatus: asset.storageStatus,
		moderationStatus,
	};
}

// Bulk-original export bounds (codex P2): the route builds the ZIP in memory,
// so both dimensions must be capped BEFORE any storage read. Larger chapters
// must go through the async POST /api/export pipeline instead.
const ORIGINALS_EXPORT_LIMITS = {
	maxPages: 500,
	maxProjectedBytes: 512 * 1024 * 1024,
	// manifest.json + per-entry ZIP structures; added to the projected egress
	// reservation so the recorded archive size stays within the reserved amount.
	zipOverheadSlackBytes: 1024 * 1024,
} as const;

/**
 * RFC 6266/5987 Content-Disposition (codex P1): Bun's Headers reject non-Latin1
 * values outright, so a Thai chapter name must never reach the raw header.
 * ASCII fallback in `filename`, full UTF-8 name in `filename*`.
 */
function contentDispositionForZip(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	if (ascii === filename) return `attachment; filename="${ascii}"`;
	const encoded = encodeURIComponent(filename);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function safeZipNamePart(value: string, fallback: string): string {
	const safe = sanitizeFilename(value).trim().replace(/^\.+$/, "");
	return safe || fallback;
}

function extensionFromName(name: string | undefined): string {
	const match = name?.match(/(\.[a-z0-9]{1,12})$/i);
	return match?.[1]?.toLowerCase() ?? "";
}

function baseNameWithoutExtension(name: string, extension: string): string {
	return extension && name.toLowerCase().endsWith(extension)
		? name.slice(0, -extension.length)
		: name;
}

function sourceNameForPage(page: ProjectState["pages"][number], asset: AssetRecord): string {
	return safeZipNamePart(page.originalName || asset.originalName || page.imageName || page.imageId, page.imageId);
}

function zipPathForOriginalPage(
	page: ProjectState["pages"][number],
	asset: AssetRecord,
	pageIndex: number,
	padWidth: number,
): string {
	const sourceName = sourceNameForPage(page, asset);
	const extension = extensionFromName(sourceName) || extensionFromName(asset.originalName) || extensionFromName(page.imageId) || ".bin";
	const base = safeZipNamePart(baseNameWithoutExtension(sourceName, extension), `page-${pageIndex + 1}`);
	return `pages/${String(pageIndex + 1).padStart(padWidth, "0")}-${base}${extension}`;
}

function originalsZipFilename(state: ProjectState): string {
	const base = safeZipNamePart(state.chapterLabel || state.chapterTitle || state.name || state.projectId, state.projectId);
	const withSuffix = base.toLowerCase().endsWith("-originals") ? base : `${base}-originals`;
	return `${withSuffix}.zip`;
}

async function readOriginalAssetBuffer(projectId: string, asset: AssetRecord): Promise<Buffer | undefined> {
	if (asset.storageKey.startsWith("content/") && asset.sha256) {
		return objectStorage.getContentBlob({ sha256: asset.sha256 });
	}
	return objectStorage.getProjectImage({ projectId, imageId: asset.imageId });
}

interface ValidatedOriginalsExport {
	entries: Array<{ page: ProjectState["pages"][number]; pageIndex: number; asset: AssetRecord }>;
	padWidth: number;
	projectedBytes: number;
}

/**
 * Phase 1 (codex P2): validate EVERY page and project the archive size from the
 * asset records WITHOUT touching storage, so the egress reservation can happen
 * before any byte is pulled from R2/disk.
 */
async function validateOriginalsExport(state: ProjectState): Promise<ValidatedOriginalsExport | Response> {
	const pageEntries = state.pages
		.map((page, pageIndex) => ({ page, pageIndex }))
		.filter(({ page }) => typeof page.imageId === "string" && page.imageId.length > 0);
	if (pageEntries.length === 0) {
		return Response.json({ error: "Project has no source images to export", code: "no_source_images" }, { status: 400 });
	}
	if (pageEntries.length > ORIGINALS_EXPORT_LIMITS.maxPages) {
		return Response.json({
			error: "Chapter has too many pages for a direct originals download; use the async export pipeline",
			code: "originals_too_many_pages",
			pageCount: pageEntries.length,
			maxPages: ORIGINALS_EXPORT_LIMITS.maxPages,
		}, { status: 413 });
	}

	const assetRecords = await listAssetRecordsAuthoritative(state.projectId);
	const assetByImageId = new Map(assetRecords.map((asset) => [asset.imageId, asset]));
	const entries: ValidatedOriginalsExport["entries"] = [];
	let projectedBytes = ORIGINALS_EXPORT_LIMITS.zipOverheadSlackBytes;

	for (const { page, pageIndex } of pageEntries) {
		// Defense-in-depth (codex P3): raw provider checkpoints are denied by
		// PREFIX regardless of registration state, mirroring the export pipeline —
		// a registry/backfill regression must not reopen the laundering path.
		if (isNeverGrandfatherImageId(page.imageId)) {
			return Response.json({
				error: "Source image is not available for original export",
				code: "asset_not_registered",
				pageIndex,
				pageNumber: pageIndex + 1,
				imageId: page.imageId,
			}, { status: 403 });
		}
		const asset = assetByImageId.get(page.imageId);
		if (!asset) {
			return Response.json({
				error: "Source image is not available for original export",
				code: "asset_not_registered",
				pageIndex,
				pageNumber: pageIndex + 1,
				imageId: page.imageId,
			}, { status: 403 });
		}
		const blocked = originalDownloadAssetBlocked(asset);
		if (blocked) {
			return Response.json({
				error: "Source image is not available for original export",
				code: blocked.code,
				pageIndex,
				pageNumber: pageIndex + 1,
				imageId: page.imageId,
				storageStatus: blocked.storageStatus,
				moderationStatus: blocked.moderationStatus,
			}, { status: 403 });
		}
		projectedBytes += Math.max(0, asset.sizeBytes || 0);
		entries.push({ page, pageIndex, asset });
	}

	if (projectedBytes > ORIGINALS_EXPORT_LIMITS.maxProjectedBytes) {
		return Response.json({
			error: "Chapter originals exceed the direct-download size limit; use the async export pipeline",
			code: "originals_too_large",
			projectedBytes,
			maxBytes: ORIGINALS_EXPORT_LIMITS.maxProjectedBytes,
		}, { status: 413 });
	}

	return { entries, padWidth: Math.max(3, String(pageEntries.length).length), projectedBytes };
}

/** Phase 2: pull bytes + build the archive. Caller has already reserved egress. */
async function buildOriginalsArchive(state: ProjectState, validated: ValidatedOriginalsExport): Promise<OriginalsArchive | Response> {
	const { entries, padWidth } = validated;
	const now = new Date().toISOString();
	const files: ZipFileInput[] = [];
	const manifestPages: OriginalsManifestPage[] = [];

	for (const { page, pageIndex, asset } of entries) {
		const buffer = await readOriginalAssetBuffer(state.projectId, asset);
		if (!buffer) {
			return Response.json({
				error: "Source image bytes not found",
				code: "source_image_not_found",
				pageIndex,
				pageNumber: pageIndex + 1,
				imageId: page.imageId,
			}, { status: 404 });
		}

		const filename = zipPathForOriginalPage(page, asset, pageIndex, padWidth);
		files.push({ path: filename, data: buffer, modifiedAt: new Date(asset.createdAt || state.createdAt || now) });
		manifestPages.push({
			pageIndex,
			pageNumber: pageIndex + 1,
			imageId: page.imageId,
			sourceName: sourceNameForPage(page, asset),
			filename,
			mimeType: asset.mimeType || "application/octet-stream",
			sizeBytes: buffer.byteLength,
		});
	}

	const manifest: OriginalsArchive["manifest"] = {
		kind: "chapter-originals",
		chapterId: state.projectId,
		projectId: state.projectId,
		projectName: state.name,
		createdAt: now,
		pageCount: manifestPages.length,
		pages: manifestPages,
	};
	const archive = createZipBuffer([
		{ path: "manifest.json", data: `${JSON.stringify(manifest, null, 2)}\n`, modifiedAt: new Date(now) },
		...files,
	]);
	return {
		buffer: archive,
		filename: originalsZipFilename(state),
		manifest,
	};
}

// ── GET /api/export/originals/:chapterId ────────────────────────────────────
// Minimal server-side bulk-original export. It intentionally exports the source
// page originals only (state.pages[].imageId), not edited backgrounds or final
// Fabric-rendered pages, so teams can round-trip/recover the raw chapter inputs.
exportRoutes.get("/originals/:chapterId", async (c) => {
	const chapterId = c.req.param("chapterId");
	if (!chapterId || chapterId.length > 200) {
		return c.json({ error: "Invalid chapter id", code: "invalid_chapter_id" }, 400);
	}

	// blockWhenSuspended (codex P3): bulk-original download records billable
	// egress, so a frozen (chargeback) workspace must not bulk-pull originals.
	const access = await authorizeProjectExport(c, chapterId, { blockWhenSuspended: true });
	if (access instanceof Response) return access;

	if (access.member) {
		const deniedPage = access.state.pages.findIndex((page, pageIndex) =>
			typeof page.imageId === "string"
			&& page.imageId.length > 0
			&& !workspaceScopeAllows(access.member!.scope, {
				projectId: access.state.projectId,
				resourceKind: "asset",
				pageIndex,
			}));
		if (deniedPage >= 0) {
			return c.json({
				error: "Some pages are outside your assigned scope",
				code: "page_scope_denied",
				pageIndex: deniedPage,
				pageNumber: deniedPage + 1,
			}, 403);
		}
	}

	const preThrottleError = await assertEgressNotThrottledOrResponse(c, access.state.projectId, "asset_read");
	if (preThrottleError) return preThrottleError;

	// Validate + project size from asset records, then RESERVE before any byte
	// leaves storage (codex P2): N parallel requests must not all fully download
	// the chapter past a stale pre-check.
	const validated = await validateOriginalsExport(access.state);
	if (validated instanceof Response) return validated;

	let reservedBytes = validated.projectedBytes;
	const reserveError = await reserveEgressForReadOrResponse(c, access.state.projectId, reservedBytes, "asset_read");
	if (reserveError) return reserveError;

	let archive: OriginalsArchive;
	try {
		const built = await buildOriginalsArchive(access.state, validated);
		if (built instanceof Response) {
			await releaseEgressReservationBestEffort(access.state.projectId, reservedBytes);
			return built;
		}
		archive = built;
	} catch (error) {
		await releaseEgressReservationBestEffort(access.state.projectId, reservedBytes);
		throw error;
	}

	// Reconcile the projection with the real archive size before recording.
	const actualBytes = archive.buffer.byteLength;
	if (actualBytes > reservedBytes) {
		const deltaError = await reserveEgressForReadOrResponse(c, access.state.projectId, actualBytes - reservedBytes, "asset_read");
		if (deltaError) {
			await releaseEgressReservationBestEffort(access.state.projectId, reservedBytes);
			return deltaError;
		}
	} else if (actualBytes < reservedBytes) {
		await releaseEgressReservationBestEffort(access.state.projectId, reservedBytes - actualBytes);
	}
	reservedBytes = Math.max(actualBytes, reservedBytes);

	// Headers are built BEFORE egress is recorded (codex P1): a header-construction
	// failure must not leave recorded-but-unserved bytes burning the egress cap.
	const headers = {
		"Content-Type": "application/zip",
		"Content-Length": String(actualBytes),
		"Content-Disposition": contentDispositionForZip(archive.filename),
		"Cache-Control": "private, max-age=0",
		"X-Content-Type-Options": "nosniff",
		"X-Asset-Egress-Bytes": String(actualBytes),
	};

	const recordError = await recordEgressWithAllowanceOrResponse(c, {
		projectId: access.state.projectId,
		imageId: "chapter-originals.zip",
		purpose: "export",
		bytes: actualBytes,
		statusCode: 200,
		skipAbuseReservation: true,
	});
	if (recordError) {
		await releaseEgressReservationBestEffort(access.state.projectId, reservedBytes);
		return recordError;
	}

	return new Response(archive.buffer, { headers });
});

// ── POST /api/import/cleaned/:chapterId ─────────────────────────────────────
// Import-back for the external-cleaner roundtrip. The endpoint accepts either:
//   - one ZIP that contains `manifest.json` plus cleaned `pages/NNN-*` images, or
//   - multipart images plus a `manifest` JSON field / `manifest.json` file.
//
// Safety model: validate the entire manifest, filename mapping, and dimensions
// before publishing anything; then publish new image assets and commit project
// state in one final write. Any failure after a new asset is created rolls those
// assets back through the same upload cleanup path used by normal image uploads.
const CLEANED_IMPORT_LIMITS = {
	maxPages: ORIGINALS_EXPORT_LIMITS.maxPages,
	maxProjectedBytes: ORIGINALS_EXPORT_LIMITS.maxProjectedBytes,
	nearDimensionRatio: 0.005,
	nearDimensionPixels: 2,
} as const;

const CLEANED_IMPORT_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const CLEANED_IMPORT_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

class CleanedImportRequestError extends Error {
	readonly status: ContentfulStatusCode;
	readonly code: string;
	readonly details: Record<string, unknown>;

	constructor(status: ContentfulStatusCode, code: string, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "CleanedImportRequestError";
		this.status = status;
		this.code = code;
		this.details = details;
	}

	toBody(): Record<string, unknown> {
		return { error: this.message, code: this.code, ...this.details };
	}
}

interface CleanedImportFile {
	path: string;
	originalName: string;
	buffer: Buffer;
	mimeType: string;
	source: "zip" | "multipart";
}

interface CleanedImportPayload {
	manifest: OriginalsArchive["manifest"];
	images: CleanedImportFile[];
	imageByPathKey: Map<string, CleanedImportFile>;
	imageByBaseKey: Map<string, CleanedImportFile>;
}

interface CleanedImportPlan {
	page: ProjectState["pages"][number];
	pageIndex: number;
	manifestFilename: string;
	file: CleanedImportFile;
	sourceAsset: AssetRecord;
	width: number;
	height: number;
}

interface CleanedImportCommitResult {
	imported: number;
	pages: Array<{
		pageIndex: number;
		pageNumber: number;
		sourceImageId: string;
		cleanedImageId: string;
		filename: string;
		width: number;
		height: number;
		moderationStatus: AssetModerationResult["status"];
		storageStatus: AssetRecord["storageStatus"];
	}>;
	assets: AssetRecord[];
}

async function authorizeProjectImport(c: Context, projectId: string): Promise<ProjectAccess | Response> {
	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format", code: "invalid_project_id" }, 400);
	}
	const state = await resolveProjectState(projectId);
	if (!state) {
		return c.json({ error: "Project not found", code: "project_not_found" }, 404);
	}
	const user = getAuthUser(c) as JWTPayload | undefined;
	const workspaceId = state.workspaceId?.trim();

	if (workspaceId) {
		if (!user) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
		// Workspace MEMBERSHIP authorizes the import (requireScopedPermission
		// below) — the global app role must not gate first, or an invited
		// workspace editor whose account role is viewer gets 403 before their
		// workspace permissions are even read (codex P2; matches the other
		// workspace project paths).
		if (!workspaceAccessStore) {
			return c.json({
				error: "Workspace import requires the Postgres workspace access store",
				code: "workspace_store_unavailable",
			}, 503);
		}
		try {
			const member = await workspaceAccessStore.requireScopedPermission(
				workspaceId,
				user.userId,
				"update_project",
				// Concrete clean scope (codex P1): a translate-only/thumbnail-only
				// member must NOT overwrite cleaned backgrounds — missing
				// taskType/assetPurpose reads as "allowed" in the scope check.
				// chapterId == projectId in this model (codex P1 r17): a member
				// scoped to OTHER chapters must not import into this one —
				// workspaceScopeAllows treats an absent chapterId as allowed.
				{ projectId, chapterId: projectId, resourceKind: "asset", taskType: "clean", assetPurpose: "page-image" },
			);
			return { state, workspaceId, member };
		} catch (error) {
			if (error instanceof WorkspaceAccessError) {
				// Chapter-team fallback (codex P2): an ACTIVE chapter-team member of
				// a workspace chapter holds update access on the project/images
				// routes even without workspace membership — the cleaned import is
				// the same access model. Scoped page checks don't apply (no member
				// scope object), matching the other routes' team-grant semantics.
				// FREEZE gate (codex P1 r9): the fallback bypasses the membership
				// path's own suspension check, so re-check it here — a suspended
				// (chargeback) workspace must not accept imports via team grants.
				// REVOCATION gate (review #590 P1, mirrors routes/project.ts +
				// images.ts): a workspace-REMOVED user's stale chapterTeam entry must
				// not keep this import/overwrite path open; never-member externals
				// (no membership row) pass.
				if (
					isActiveChapterTeamMember(state, user.userId)
					&& !(await workspaceAccessStore.isMembershipRevoked(workspaceId, user.userId))
					&& !(await workspaceAccessStore.isWorkspaceSuspended(workspaceId))
				) {
					return { state, workspaceId };
				}
				return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
			}
			throw error;
		}
	}

	if (state.userId) {
		if (!user) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
		if (state.userId !== user.userId) {
			// Catalog collaborators FIRST (codex P2 r12), then the chapter-team
			// grant — mirrors routes/images.ts::checkProjectOwnership: an invited
			// editor who can upload/save this personal project must also be able
			// to import its cleaned pages.
			const catalogGranted = Boolean(projectCatalogStore && await projectCatalogStore.canAccessProject({
				projectId,
				userId: user.userId,
				permission: "update:project",
			}));
			if (!catalogGranted && !isActiveChapterTeamMember(state, user.userId)) {
				return c.json({ error: "Project not found", code: "project_not_found" }, 404);
			}
		} else if (!hasPermission(user.role, "import:project")) {
			return c.json({ error: "Forbidden: Missing permission 'import:project'", code: "missing_permission" }, 403);
		}
	} else if (!allowsLegacyAnonymousProjectAccess()) {
		if (!user) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
		return c.json({ error: "Project not found", code: "project_not_found" }, 404);
	}
	return { state };
}

function assertScopedCleanedImport(access: ProjectAccess): Response | undefined {
	if (!access.member) return undefined;
	const deniedPage = access.state.pages.findIndex((page, pageIndex) =>
		typeof page.imageId === "string"
		&& page.imageId.length > 0
		&& !workspaceScopeAllows(access.member!.scope, {
			projectId: access.state.projectId,
			chapterId: access.state.projectId,
			resourceKind: "asset",
			pageIndex,
		}));
	if (deniedPage < 0) return undefined;
	return Response.json({
		error: "Some pages are outside your assigned scope",
		code: "page_scope_denied",
		pageIndex: deniedPage,
		pageNumber: deniedPage + 1,
	}, { status: 403 });
}

function extensionFromCleanedPath(path: string): string | undefined {
	const ext = extensionFromName(path).replace(/^\./, "").toLowerCase();
	return CLEANED_IMPORT_IMAGE_EXTENSIONS.has(ext) ? ext : undefined;
}

function mimeTypeForCleanedPath(path: string, fallback = ""): string | undefined {
	const ext = extensionFromCleanedPath(path);
	if (!ext) return undefined;
	// Extension decides the MIME (codex P2 r16): images are later SERVED with
	// the stored type + nosniff, so a client part claiming image/svg+xml or
	// image/avif for a .png must not be persisted. The client type is honored
	// only when it exactly matches the allowlisted MIME for that extension
	// (jpg/jpeg aliasing collapses through the table either way).
	const allowlisted = CLEANED_IMPORT_MIME_BY_EXT[ext];
	const normalizedFallback = fallback.trim().toLowerCase();
	if (allowlisted && normalizedFallback === allowlisted) return allowlisted;
	return allowlisted;
}

function stripJsonBom(value: string): string {
	return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function normalizeImportPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
	const segments = normalized.split("/");
	if (!normalized || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new CleanedImportRequestError(400, "invalid_import_path", "Cleaned import contains an invalid path", { path });
	}
	return normalized;
}

function pathKey(path: string): string {
	return normalizeImportPath(path).toLowerCase();
}

function baseNameForPath(path: string): string {
	const normalized = normalizeImportPath(path);
	return normalized.split("/").at(-1) ?? normalized;
}

function isIgnoredArchiveEntry(path: string): boolean {
	const lower = path.toLowerCase();
	return lower === ".ds_store" || lower.endsWith("/.ds_store") || lower.startsWith("__macosx/");
}

function parseStoredOrDeflatedZip(buffer: Buffer): CleanedImportFile[] {
	const eocdOffset = findZipEndOfCentralDirectory(buffer);
	if (eocdOffset < 0) {
		throw new CleanedImportRequestError(400, "invalid_zip", "Cleaned import ZIP is missing a central directory");
	}
	const entryCount = buffer.readUInt16LE(eocdOffset + 10);
	const centralSize = buffer.readUInt32LE(eocdOffset + 12);
	const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
	if (centralOffset + centralSize > buffer.length) {
		throw new CleanedImportRequestError(400, "invalid_zip", "Cleaned import ZIP central directory is out of bounds");
	}

	const files: CleanedImportFile[] = [];
	let projectedBytes = 0;
	let offset = centralOffset;
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
			throw new CleanedImportRequestError(400, "invalid_zip", "Cleaned import ZIP central directory is malformed");
		}
		const flags = buffer.readUInt16LE(offset + 8);
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const nameStart = offset + 46;
		const nameEnd = nameStart + nameLength;
		if (nameEnd > buffer.length) {
			throw new CleanedImportRequestError(400, "invalid_zip", "Cleaned import ZIP entry name is out of bounds");
		}
		const rawName = buffer.subarray(nameStart, nameEnd).toString("utf8");
		offset = nameEnd + extraLength + commentLength;

		if (!rawName || rawName.endsWith("/") || isIgnoredArchiveEntry(rawName)) continue;
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
			throw new CleanedImportRequestError(413, "zip64_not_supported", "Cleaned import ZIP64 entries are too large for direct import");
		}
		if ((flags & 0x0001) !== 0) {
			throw new CleanedImportRequestError(400, "encrypted_zip_not_supported", "Encrypted cleaned import ZIP entries are not supported");
		}
		projectedBytes += uncompressedSize;
		if (projectedBytes > CLEANED_IMPORT_LIMITS.maxProjectedBytes) {
			throw new CleanedImportRequestError(413, "cleaned_import_too_large", "Cleaned import ZIP is too large for direct import", {
				projectedBytes,
				maxBytes: CLEANED_IMPORT_LIMITS.maxProjectedBytes,
			});
		}
		const dataStart = zipEntryDataStart(buffer, localOffset);
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > buffer.length) {
			throw new CleanedImportRequestError(400, "invalid_zip", "Cleaned import ZIP entry data is out of bounds", { path: rawName });
		}
		const compressed = buffer.subarray(dataStart, dataEnd);
		// Bounded inflate (codex P1): a malicious ZIP can claim a tiny
		// uncompressedSize while the deflate stream expands to GBs — cap the
		// output at the CLAIMED size; overflow is a hard reject before the
		// post-hoc size check ever runs.
		let data: Buffer | undefined;
		if (method === 0) {
			data = Buffer.from(compressed);
		} else if (method === 8) {
			try {
				data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
			} catch {
				throw new CleanedImportRequestError(400, "invalid_zip", "Cleaned import ZIP entry inflates past its declared size", { path: rawName });
			}
		}
		if (!data) {
			throw new CleanedImportRequestError(415, "zip_method_not_supported", "Cleaned import ZIP uses an unsupported compression method", {
				path: rawName,
				method,
			});
		}
		if (data.byteLength !== uncompressedSize) {
			throw new CleanedImportRequestError(400, "invalid_zip", "Cleaned import ZIP entry size does not match the central directory", { path: rawName });
		}
		const mimeType = mimeTypeForCleanedPath(rawName) ?? (baseNameForPath(rawName) === "manifest.json" ? "application/json" : "application/octet-stream");
		files.push({
			path: normalizeImportPath(rawName),
			originalName: baseNameForPath(rawName),
			buffer: data,
			mimeType,
			source: "zip",
		});
	}
	return files;
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
	const minOffset = Math.max(0, buffer.length - 65557);
	for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
		if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
	}
	return -1;
}

function zipEntryDataStart(buffer: Buffer, localOffset: number): number {
	if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
		throw new CleanedImportRequestError(400, "invalid_zip", "Cleaned import ZIP local header is malformed");
	}
	const nameLength = buffer.readUInt16LE(localOffset + 26);
	const extraLength = buffer.readUInt16LE(localOffset + 28);
	return localOffset + 30 + nameLength + extraLength;
}

function parseCleanedImportManifest(buffer: Buffer): OriginalsArchive["manifest"] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonBom(buffer.toString("utf8")));
	} catch {
		throw new CleanedImportRequestError(400, "invalid_manifest", "Cleaned import manifest is not valid JSON");
	}
	if (!parsed || typeof parsed !== "object") {
		throw new CleanedImportRequestError(400, "invalid_manifest", "Cleaned import manifest must be an object");
	}
	const manifest = parsed as Partial<OriginalsArchive["manifest"]>;
	if (manifest.kind !== "chapter-originals" || !Array.isArray(manifest.pages)) {
		throw new CleanedImportRequestError(400, "invalid_manifest", "Cleaned import manifest must come from the chapter originals export");
	}
	return manifest as OriginalsArchive["manifest"];
}

function appendManifest(
	current: Buffer | undefined,
	next: Buffer,
	source: string,
): Buffer {
	if (current) {
		throw new CleanedImportRequestError(400, "multiple_manifests", "Cleaned import must contain exactly one manifest", { source });
	}
	return next;
}

function appendCleanedImage(
	payload: Omit<CleanedImportPayload, "manifest"> & { manifest?: OriginalsArchive["manifest"] },
	file: CleanedImportFile,
): void {
	const normalizedPath = normalizeImportPath(file.path);
	const ext = extensionFromCleanedPath(normalizedPath);
	if (!ext) {
		throw new CleanedImportRequestError(415, "unsupported_cleaned_image_type", "Cleaned import image type is not supported", {
			path: normalizedPath,
		});
	}
	const fullKey = pathKey(normalizedPath);
	const baseKey = baseNameForPath(normalizedPath).toLowerCase();
	if (payload.imageByPathKey.has(fullKey)) {
		throw new CleanedImportRequestError(400, "duplicate_cleaned_file", "Cleaned import contains duplicate file paths", { path: normalizedPath });
	}
	if (payload.imageByBaseKey.has(baseKey)) {
		throw new CleanedImportRequestError(400, "duplicate_cleaned_filename", "Cleaned import contains duplicate file names", {
			filename: baseNameForPath(normalizedPath),
		});
	}
	payload.images.push({ ...file, path: normalizedPath, mimeType: mimeTypeForCleanedPath(normalizedPath, file.mimeType) ?? file.mimeType });
	payload.imageByPathKey.set(fullKey, payload.images[payload.images.length - 1]!);
	payload.imageByBaseKey.set(baseKey, payload.images[payload.images.length - 1]!);
}

async function extractCleanedImportPayload(c: Context): Promise<CleanedImportPayload> {
	// Body cap BEFORE buffering (codex P1): formData() buffers the whole
	// multipart body; without this a huge request is fully resident before any
	// validation runs. Slack covers multipart boundaries/headers.
	const contentLength = Number(c.req.header("content-length") ?? "");
	const maxBodyBytes = CLEANED_IMPORT_LIMITS.maxProjectedBytes + 8 * 1024 * 1024;
	if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
		throw new CleanedImportRequestError(413, "cleaned_import_too_large", "Cleaned import body exceeds the direct-import size limit", {
			contentLength,
			maxBytes: maxBodyBytes,
		});
	}
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch (error) {
		// The streaming size guard's abort must surface as its 413 contract —
		// translating it to invalid_multipart_body hid request_body_too_large
		// for oversized chunked/lying-CL imports (codex P2).
		if (error instanceof RequestBodyLimitError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		console.warn("[import-cleaned] rejected unparseable multipart body", { error: message });
		throw new CleanedImportRequestError(400, "invalid_multipart_body", "Invalid multipart form data");
	}

	let manifestBuffer: Buffer | undefined;
	const payload: Omit<CleanedImportPayload, "manifest"> & { manifest?: OriginalsArchive["manifest"] } = {
		images: [],
		imageByPathKey: new Map(),
		imageByBaseKey: new Map(),
	};
	const entries = Array.from(formData.entries()) as Array<[string, string | File]>;
	for (const [fieldName, value] of entries) {
		const field = fieldName.toLowerCase();
		if (typeof value === "string") {
			if (field === "manifest" || field === "manifest_json" || field === "manifestjson") {
				manifestBuffer = appendManifest(manifestBuffer, Buffer.from(value, "utf8"), fieldName);
			}
			continue;
		}
		const fileName = value.name || fieldName;
		const buffer = Buffer.from(await value.arrayBuffer());
		const lowerName = fileName.toLowerCase();
		if (lowerName.endsWith(".zip")) {
			for (const entry of parseStoredOrDeflatedZip(buffer)) {
				const entryKey = pathKey(entry.path);
				if (entryKey === "manifest.json" || baseNameForPath(entry.path).toLowerCase() === "manifest.json") {
					manifestBuffer = appendManifest(manifestBuffer, entry.buffer, entry.path);
					continue;
				}
				if (!extensionFromCleanedPath(entry.path)) {
					if (isIgnoredArchiveEntry(entry.path)) continue;
					throw new CleanedImportRequestError(415, "unexpected_cleaned_zip_entry", "Cleaned import ZIP contains an unexpected file", {
						path: entry.path,
					});
				}
				appendCleanedImage(payload, entry);
			}
			continue;
		}
		if (field === "manifest" || lowerName === "manifest.json" || lowerName.endsWith("/manifest.json")) {
			manifestBuffer = appendManifest(manifestBuffer, buffer, fileName);
			continue;
		}
		appendCleanedImage(payload, {
			path: fileName,
			originalName: fileName,
			buffer,
			mimeType: value.type || mimeTypeForCleanedPath(fileName) || "application/octet-stream",
			source: "multipart",
		});
	}

	if (!manifestBuffer) {
		throw new CleanedImportRequestError(400, "missing_manifest", "Cleaned import requires the manifest.json from the originals export");
	}
	if (payload.images.length === 0) {
		throw new CleanedImportRequestError(400, "missing_cleaned_images", "Cleaned import requires at least one cleaned page image");
	}
	return {
		...payload,
		manifest: parseCleanedImportManifest(manifestBuffer),
	};
}

function manifestPageFilename(page: unknown): string {
	if (!page || typeof page !== "object") {
		throw new CleanedImportRequestError(400, "invalid_manifest_page", "Cleaned import manifest contains an invalid page entry");
	}
	const filename = (page as { filename?: unknown }).filename;
	if (typeof filename !== "string" || filename.trim().length === 0) {
		throw new CleanedImportRequestError(400, "invalid_manifest_page", "Cleaned import manifest page is missing a filename");
	}
	const normalized = normalizeImportPath(filename);
	if (!/^pages\/\d{3,}-[^/]+$/i.test(normalized)) {
		throw new CleanedImportRequestError(400, "invalid_manifest_filename", "Cleaned import manifest filename must use pages/NNN-*", {
			filename,
		});
	}
	return normalized;
}

function manifestPageIndex(page: unknown): number {
	const value = page && typeof page === "object" ? (page as { pageIndex?: unknown }).pageIndex : undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new CleanedImportRequestError(400, "invalid_manifest_page", "Cleaned import manifest page is missing a valid pageIndex");
	}
	return value;
}

function manifestImageId(page: unknown): string {
	const value = page && typeof page === "object" ? (page as { imageId?: unknown }).imageId : undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new CleanedImportRequestError(400, "invalid_manifest_page", "Cleaned import manifest page is missing imageId");
	}
	return value;
}

function findCleanedImageForManifestFilename(payload: CleanedImportPayload, filename: string): CleanedImportFile | undefined {
	const exact = payload.imageByPathKey.get(pathKey(filename))
		?? payload.imageByBaseKey.get(baseNameForPath(filename).toLowerCase());
	if (exact) return exact;
	// Prefix fallback (codex P2 r12): a cleaner commonly saves the exported
	// `pages/001-cover.png` as `001-cover-cleaned.png` — match by the manifest's
	// numeric page prefix when no exact name matches, same as the client
	// planner. Ambiguity (two files share the prefix) stays unmatched and
	// surfaces as cleaned_import_missing_page instead of guessing.
	const prefixMatch = baseNameForPath(filename).toLowerCase().match(/^(\d{3,})-/);
	if (!prefixMatch) return undefined;
	const prefix = `${prefixMatch[1]}-`;
	const candidates = payload.images.filter((file) => baseNameForPath(file.path).toLowerCase().startsWith(prefix));
	return candidates.length === 1 ? candidates[0] : undefined;
}

function assertNearOriginalDimensions(input: {
	pageIndex: number;
	filename: string;
	expectedWidth: number;
	expectedHeight: number;
	actualWidth: number;
	actualHeight: number;
}): void {
	// EXACT match required (codex P1): text layers, image-layer boxes, and
	// edit ROIs are stored in absolute SOURCE pixels — even a 1px-off cleaned
	// replacement shifts every downstream coordinate. The cleaner must return
	// the canvas at original dimensions.
	if (input.actualWidth === input.expectedWidth && input.actualHeight === input.expectedHeight) return;
	throw new CleanedImportRequestError(422, "cleaned_import_dimension_mismatch", "Cleaned image dimensions must exactly match the original page", {
		pageIndex: input.pageIndex,
		pageNumber: input.pageIndex + 1,
		filename: input.filename,
		expected: { width: input.expectedWidth, height: input.expectedHeight },
		actual: { width: input.actualWidth, height: input.actualHeight },
	});
}

async function buildCleanedImportPlan(state: ProjectState, payload: CleanedImportPayload): Promise<CleanedImportPlan[]> {
	if (payload.manifest.projectId !== state.projectId || payload.manifest.chapterId !== state.projectId) {
		throw new CleanedImportRequestError(409, "cleaned_import_manifest_mismatch", "Cleaned import manifest does not belong to this chapter", {
			manifestProjectId: payload.manifest.projectId,
			manifestChapterId: payload.manifest.chapterId,
			chapterId: state.projectId,
		});
	}

	const sourcePages = state.pages
		.map((page, pageIndex) => ({ page, pageIndex }))
		.filter(({ page }) => typeof page.imageId === "string" && page.imageId.length > 0);
	if (sourcePages.length === 0) {
		throw new CleanedImportRequestError(400, "no_source_images", "Project has no source images to receive cleaned backgrounds");
	}
	if (sourcePages.length > CLEANED_IMPORT_LIMITS.maxPages) {
		throw new CleanedImportRequestError(413, "cleaned_import_too_many_pages", "Chapter has too many pages for direct cleaned import", {
			pageCount: sourcePages.length,
			maxPages: CLEANED_IMPORT_LIMITS.maxPages,
		});
	}
	if (payload.manifest.pages.length !== sourcePages.length) {
		throw new CleanedImportRequestError(400, "cleaned_import_page_count_mismatch", "Cleaned import must include every page from the originals manifest", {
			expectedPages: sourcePages.length,
			manifestPages: payload.manifest.pages.length,
		});
	}

	const assetRecords = await listAssetRecordsAuthoritative(state.projectId);
	const assetByImageId = new Map(assetRecords.map((asset) => [asset.imageId, asset]));
	const seenPageIndexes = new Set<number>();
	const seenFilenames = new Set<string>();
	const usedImages = new Set<CleanedImportFile>();
	const plans: CleanedImportPlan[] = [];
	for (const manifestPage of payload.manifest.pages) {
		const pageIndex = manifestPageIndex(manifestPage);
		const filename = manifestPageFilename(manifestPage);
		const filenameKey = pathKey(filename);
		const expectedImageId = manifestImageId(manifestPage);
		if (seenPageIndexes.has(pageIndex)) {
			throw new CleanedImportRequestError(400, "duplicate_manifest_page", "Cleaned import manifest contains duplicate page indexes", { pageIndex });
		}
		if (seenFilenames.has(filenameKey)) {
			throw new CleanedImportRequestError(400, "duplicate_manifest_filename", "Cleaned import manifest contains duplicate filenames", { filename });
		}
		seenPageIndexes.add(pageIndex);
		seenFilenames.add(filenameKey);

		const page = state.pages[pageIndex];
		if (!page || page.imageId !== expectedImageId) {
			throw new CleanedImportRequestError(409, "cleaned_import_manifest_stale", "Cleaned import manifest no longer matches the chapter page order", {
				pageIndex,
				pageNumber: pageIndex + 1,
				manifestImageId: expectedImageId,
				currentImageId: page?.imageId,
			});
		}
		const file = findCleanedImageForManifestFilename(payload, filename);
		if (!file) {
			throw new CleanedImportRequestError(400, "cleaned_import_missing_page", "Cleaned import is missing a cleaned image for a manifest page", {
				pageIndex,
				pageNumber: pageIndex + 1,
				filename,
			});
		}
		usedImages.add(file);
		const sourceAsset = assetByImageId.get(page.imageId);
		if (!sourceAsset || sourceAsset.width <= 0 || sourceAsset.height <= 0) {
			throw new CleanedImportRequestError(409, "source_asset_dimensions_missing", "Original page asset dimensions are unavailable", {
				pageIndex,
				pageNumber: pageIndex + 1,
				imageId: page.imageId,
			});
		}
		let dimensions: { width: number; height: number };
		try {
			dimensions = await validateUploadedImageBuffer(file.buffer, file.originalName);
		} catch (error) {
			// Same client-error mapping as the upload routes (codex P2): corrupt
			// or over-ceiling files are user input, not 500s.
			if (error instanceof UploadedImageTooLargeError) {
				throw new CleanedImportRequestError(413, "cleaned_image_too_large", "Cleaned image exceeds the per-page pixel ceiling", {
					pageIndex,
					pageNumber: pageIndex + 1,
					filename,
				});
			}
			if (error instanceof UploadedImageDecodeError) {
				throw new CleanedImportRequestError(422, "cleaned_image_not_decodable", "Cleaned image is not decodable", {
					pageIndex,
					pageNumber: pageIndex + 1,
					filename,
				});
			}
			throw error;
		}
		assertNearOriginalDimensions({
			pageIndex,
			filename,
			expectedWidth: sourceAsset.width,
			expectedHeight: sourceAsset.height,
			actualWidth: dimensions.width,
			actualHeight: dimensions.height,
		});
		plans.push({
			page,
			pageIndex,
			manifestFilename: filename,
			file,
			sourceAsset,
			width: dimensions.width,
			height: dimensions.height,
		});
	}

	for (const { pageIndex } of sourcePages) {
		if (!seenPageIndexes.has(pageIndex)) {
			throw new CleanedImportRequestError(400, "cleaned_import_missing_manifest_page", "Cleaned import manifest omits a chapter page", {
				pageIndex,
				pageNumber: pageIndex + 1,
			});
		}
	}
	const extra = payload.images.find((image) => !usedImages.has(image));
	if (extra) {
		throw new CleanedImportRequestError(400, "cleaned_import_unexpected_page", "Cleaned import contains an image that is not listed in the manifest", {
			path: extra.path,
		});
	}
	return plans.sort((a, b) => a.pageIndex - b.pageIndex);
}

function buildImportActor(user: JWTPayload | undefined): AssetActor {
	if (!user) return { source: "anonymous" };
	return {
		source: "human",
		userId: user.userId,
		email: user.email,
		role: user.role,
	};
}

async function moderateCleanedImportImage(input: {
	buffer: Buffer;
	mimeType: string;
	workspaceId: string;
	imageId: string;
	sha256: string;
	width: number;
	height: number;
	ipAddress?: string;
	userAgent?: string;
}): Promise<AssetModerationResult> {
	const denylist = await lookupKnownBlockedSha256(input.sha256);
	if (denylist === "blocked") return buildKnownBlockedShaAssetResult(input.sha256);
	const overview = denylist === "lookup-error"
		? buildDenylistLookupFailClosedResult()
		: await moderateImageBuffer(input.buffer, input.mimeType, input.workspaceId, {
			assetId: input.imageId,
			sha256: input.sha256,
			ipAddress: input.ipAddress,
			userAgent: input.userAgent,
		});
	if (overview.status === "blocked") return overview;
	const tilePlan = buildModerationDerivativePlan({ width: input.width, height: input.height });
	return executeModerationTilePlan(input.buffer, input.mimeType, tilePlan, overview, {
		workspaceId: input.workspaceId,
		assetId: input.imageId,
		ipAddress: input.ipAddress,
		userAgent: input.userAgent,
	});
}

async function commitCleanedImport(c: Context, access: ProjectAccess, plans: CleanedImportPlan[]): Promise<CleanedImportCommitResult> {
	const state = structuredClone(access.state) as ProjectState;
	// Storage quota goes through the SAME accounting as normal uploads
	// (codex P1): without a reservation a workspace at/over quota could import
	// a full cleaned chapter for free.
	const pendingBytes = plans.reduce((total, plan) => total + plan.file.buffer.byteLength, 0);
	// Usage PRE-flight (codex P2): an over-quota workspace must be rejected
	// before any moderation/storage work burns provider calls — mirrors the
	// upload path's assertUploadUsageAllowance-before-moderation ordering.
	try {
		await assertUploadUsageAllowance({
			projectId: access.state.projectId,
			subjectId: `import-cleaned:${access.state.projectId}`,
			bytes: pendingBytes,
			metadata: { source: "import_cleaned", fileCount: plans.length },
		});
	} catch (error) {
		if (error instanceof UsageQuotaExceededError) {
			throw new CleanedImportRequestError(402, "usage_quota_exceeded", "Upload usage quota exceeded for cleaned import", {
				pendingBytes,
			});
		}
		throw error;
	}
	// Same per-chapter caps as normal uploads (codex P2): repeated imports must
	// not exceed MAX_IMAGES_PER_CHAPTER / MAX_CHAPTER_ORIGINAL_MB just because
	// workspace storage quota still has headroom. Cleaned backgrounds replace
	// rather than add pages, but their bytes land in the same original pool.
	const chapterLimitError = await assertChapterUploadLimit(c, access.state.projectId, 0, pendingBytes);
	if (chapterLimitError) {
		throw new CleanedImportRequestError(413, "chapter_original_bytes_limit_exceeded", "Chapter original storage limit exceeded for cleaned import", {
			pendingBytes,
		});
	}
	let storageReservation: Awaited<ReturnType<typeof reserveProjectStorageQuota>>["reservation"] | undefined;
	try {
		const reserved = await reserveProjectStorageQuota({
			projectId: access.state.projectId,
			workspaceId: access.workspaceId,
			bytes: pendingBytes,
			reason: "image_upload",
			metadata: {
				source: "import_cleaned",
				fileCount: plans.length,
				// REPLACEMENT semantics: bytes count, page images don't (codex P2).
				replacesExistingPages: true,
				chapterOriginalBytes: pendingBytes,
			},
		});
		storageReservation = reserved.reservation;
	} catch (error) {
		if (error instanceof StorageQuotaExceededError) {
			throw new CleanedImportRequestError(413, "storage_quota_exceeded", "Workspace storage quota exceeded for cleaned import", {
				pendingBytes,
			});
		}
		throw error;
	}
	// Post-reservation recheck WITH active reservations (codex P2): two parallel
	// imports both pass the persisted-only pre-check; counting reservations here
	// makes the loser back off, matching the normal upload path.
	const reservedChapterLimitError = await assertChapterUploadLimit(c, access.state.projectId, 0, 0, {
		includeActiveReservations: true,
		reservationAnchor: storageReservation,
	});
	if (reservedChapterLimitError) {
		await releaseProjectStorageQuotaReservationBestEffort(access.state.projectId, storageReservation.reservationId, {
			reason: "import_cleaned",
			phase: "chapter_limit_rejected",
		});
		throw new CleanedImportRequestError(413, "chapter_original_bytes_limit_exceeded", "Chapter original storage limit exceeded for cleaned import", {
			pendingBytes,
		});
	}
	const createdImageIds: string[] = [];
	const cowVersionIds: string[] = [];
	let rollbackCowService: ReturnType<typeof getSharedStorageCowService> | undefined;
	let stateWriteStarted = false;
	const assets: AssetRecord[] = [];
	const pages: CleanedImportCommitResult["pages"] = [];
	const user = getAuthUser(c) as JWTPayload | undefined;
	const actor = buildImportActor(user);
	const requestMeta = {
		ip: getTrustedClientIp(c),
		userAgent: c.req.header("user-agent") ?? undefined,
	};
	const moderationWorkspaceId = access.workspaceId ?? access.state.workspaceId?.trim() ?? access.state.projectId;
	const importedAt = new Date().toISOString();

	try {
		let committedPageCount = access.state.pages.length;
		for (const plan of plans) {
			const ext = extensionFromCleanedPath(plan.file.originalName) ?? extensionFromCleanedPath(plan.manifestFilename) ?? "png";
			// asset_versions.asset_id is a UUID column — `<uuid>.<ext>` image ids
			// reject the CoW insert and 500 every import in catalog mode (codex P1).
			// Mint a separate record UUID like the normal upload path.
			const assetRecordId = randomUUID();
			const imageId = `${randomUUID()}.${ext}`;
			const mimeType = mimeTypeForCleanedPath(plan.file.originalName, plan.file.mimeType)
				?? mimeTypeForCleanedPath(plan.manifestFilename)
				?? "image/png";
			const sha256 = createSha256(plan.file.buffer);
			const moderation = await moderateCleanedImportImage({
				buffer: plan.file.buffer,
				mimeType,
				workspaceId: moderationWorkspaceId,
				imageId,
				sha256,
				width: plan.width,
				height: plan.height,
				ipAddress: requestMeta.ip,
				userAgent: requestMeta.userAgent,
			});
			if (moderation.status === "blocked") {
				throw new CleanedImportRequestError(403, "cleaned_import_moderation_blocked", "Cleaned image blocked by moderation", {
					pageIndex: plan.pageIndex,
					pageNumber: plan.pageIndex + 1,
					filename: plan.manifestFilename,
					moderation,
				});
			}
			// Quarantine = unservable (codex P2): a fail-closed moderation outage
			// stores the asset as quarantined and the image route refuses to serve
			// it — committing pages[].edits to it would break the page background
			// while reporting success. Reject the import instead.
			if (moderation.failClosed) {
				throw new CleanedImportRequestError(503, "cleaned_import_moderation_unavailable", "Image moderation is unavailable; cleaned import cannot be verified right now", {
					pageIndex: plan.pageIndex,
					pageNumber: plan.pageIndex + 1,
					filename: plan.manifestFilename,
				});
			}
			// CoW ledger parity (codex P1 r9/r14): asset_versions.asset_id is an
			// IMMEDIATE FK to asset_records(id) — verified live: inserting a fresh
			// UUID throws asset_versions_asset_id_fkey. The RECORD must therefore
			// exist before writeBlob; order = record → version, with the record
			// removed (compensation below) if the version write fails so no
			// servable row points at a blob that never landed. (The upload route
			// now carries the same record→version order — b14.)
			const cowAccount = resolveCowAccount(access.state, user);
			const cowService = cowAccount && storageCowActive() ? getSharedStorageCowService() : undefined;
			const storedObject = cowService
				? { driver: objectStorage.driver, key: `content/${sha256}` }
				: await objectStorage.putProjectImage({
					projectId: access.state.projectId,
					imageId,
					buffer: plan.file.buffer,
				});
			createdImageIds.push(imageId);
			const asset = await recordUploadedAsset({
				projectId: access.state.projectId,
				workspaceId: access.workspaceId,
				assetRecordId,
				imageId,
				originalName: `${baseNameWithoutExtension(baseNameForPath(plan.manifestFilename), extensionFromName(plan.manifestFilename))}-cleaned.${ext}`,
				imageBuffer: plan.file.buffer,
				storedObject,
				mimeType,
				sizeBytes: plan.file.buffer.byteLength,
				uploadedBy: actor,
				request: requestMeta,
				moderation,
				metadata: {
					assetKind: "cleaned-background",
					source: "import_cleaned",
					roundtrip: "external-cleaner",
					sourceImageId: plan.page.imageId,
					sourceAssetId: plan.sourceAsset.assetId,
					pageIndex: plan.pageIndex,
					pageNumber: plan.pageIndex + 1,
					manifestFilename: plan.manifestFilename,
					importedAt,
				},
			});
			if (cowService && cowAccount) {
				try {
					const cowWrite = await cowService.writeBlob({
						buffer: plan.file.buffer,
						mimeType,
						accountKind: cowAccount.kind,
						accountId: cowAccount.id,
						requesterUserId: cowAccount.requesterUserId,
						// the RECORD UUID — asset.assetId is the public `<uuid>.<ext>`
						// image id and fails the uuid cast/FK (codex P1 r15)
						assetId: assetRecordId,
					});
					// Rollback bookkeeping (codex P2): a later failure must delete
					// the charged version rows too, not just the project objects.
					cowVersionIds.push(cowWrite.version_id);
					rollbackCowService = cowService;
				} catch (error) {
					// Compensation (codex P2 r16): writeBlob can throw AFTER its
					// ledger txn committed (post-commit object write) — version_id
					// never reached us, and a bare record delete would CASCADE the
					// row away WITHOUT releasing refcount/quota. Sweep the record's
					// versions through deleteVersion (full accounting) first, then
					// drop the record.
					try {
						const sql = getSharedBunSql();
						if (sql) {
							const strays = await sql.unsafe<{ version_id: string }>(
								"SELECT version_id FROM asset_versions WHERE asset_id = $1::uuid",
								[assetRecordId],
							);
							for (const stray of strays) {
								await cowService.deleteVersion({
									versionId: stray.version_id,
									deleterUserId: user?.userId,
									skipAuthorizationForSystemCleanup: true,
								}).catch(() => undefined);
							}
						}
					} catch {
						// Sweep is best-effort; the record delete below still cascades.
					}
					await removeAssetRecordAuthoritative(access.state.projectId, imageId).catch(() => undefined);
					if (error instanceof QuotaFrozenError) {
						throw new CleanedImportRequestError(402, "quota_frozen", "Workspace storage account is frozen; cleaned import rejected", {
							pageIndex: plan.pageIndex,
							pageNumber: plan.pageIndex + 1,
						});
					}
					throw error;
				}
			}
			assets.push(asset);
			const targetPage = state.pages[plan.pageIndex];
			if (!targetPage || targetPage.imageId !== plan.page.imageId) {
				throw new CleanedImportRequestError(409, "cleaned_import_state_changed", "Chapter changed while importing cleaned pages", {
					pageIndex: plan.pageIndex,
					pageNumber: plan.pageIndex + 1,
				});
			}
			targetPage.edits = { imageId };
			pages.push({
				pageIndex: plan.pageIndex,
				pageNumber: plan.pageIndex + 1,
				sourceImageId: plan.page.imageId,
				cleanedImageId: imageId,
				filename: plan.manifestFilename,
				width: asset.width,
				height: asset.height,
				moderationStatus: asset.moderation.status,
				storageStatus: asset.storageStatus,
			});
		}

		// Final read+merge+write runs UNDER the same CROSS-REPLICA critical
		// section as /save commits (codex P1 r13/r15): the in-process mutex alone
		// doesn't serialize against a save on another replica — in Postgres mode
		// this wraps the DB advisory-lock txn. Only the imported pages' `edits`
		// pointer is merged; page identity drift is 409.
		await withProjectCrossReplicaLock(access.state.projectId, async () => {
			const latest = await resolveProjectState(access.state.projectId);
			if (!latest) {
				throw new CleanedImportRequestError(409, "cleaned_import_state_changed", "Chapter state disappeared while importing");
			}
			// Manifest coverage must still hold under the lock (codex P2 r15): the
			// planner required the manifest to cover EVERY source page, so a save
			// that appended/removed source pages mid-import invalidates the plan.
			const latestSourcePages = (latest.pages ?? []).filter(
				(page) => typeof page.imageId === "string" && page.imageId.length > 0,
			).length;
			if (latestSourcePages !== plans.length) {
				throw new CleanedImportRequestError(409, "cleaned_import_state_changed", "Chapter pages changed while importing cleaned pages", {
					expectedPages: plans.length,
					currentPages: latestSourcePages,
				});
			}
			for (const plan of plans) {
				const freshPage = latest.pages?.[plan.pageIndex];
				if (!freshPage || freshPage.imageId !== plan.page.imageId) {
					throw new CleanedImportRequestError(409, "cleaned_import_state_changed", "Chapter changed while importing cleaned pages", {
						pageIndex: plan.pageIndex,
						pageNumber: plan.pageIndex + 1,
					});
				}
				const committed = pages.find((page) => page.pageIndex === plan.pageIndex);
				if (committed) freshPage.edits = { imageId: committed.cleanedImageId };
			}
			// catalogSync "required": in catalog mode a swallowed catalog failure
			// would orphan the new assets behind a stale catalog row (codex P2).
			// state.json lands BEFORE the catalog sync inside writeProjectState —
			// once this starts, assets may already be referenced on disk, so the
			// outer catch must NOT delete them (codex P1).
			stateWriteStarted = true;
			await writeProjectState(access.state.projectId, latest, { catalogSync: "required" });
			committedPageCount = latest.pages.length;
			// Usage records ONLY after the durable commit (codex P2 r17 — a
			// write failure must not leave a rolled-back import billed). The
			// over-quota case was already rejected up front by
			// assertUploadUsageAllowance, so a post-commit ledger hiccup is a
			// reconciliation matter, not a reason to fail a committed import —
			// same best-effort posture as the export pipeline's usage metering.
			try {
				await recordUploadUsage({
					projectId: access.state.projectId,
					subjectId: `import-cleaned:${createdImageIds[0] ?? access.state.projectId}`,
					bytes: pendingBytes,
					metadata: { source: "import_cleaned", imageIds: createdImageIds, fileCount: plans.length },
				});
			} catch (usageError) {
				console.warn("[import-cleaned] usage metering failed after commit; needs reconciliation", {
					projectId: access.state.projectId,
					bytes: pendingBytes,
					error: String(usageError),
				});
			}
		});
		if (storageReservation) {
			await releaseProjectStorageQuotaReservationBestEffort(access.state.projectId, storageReservation.reservationId, {
				reason: "import_cleaned",
				phase: "after_commit",
			});
		}
		await publishPageSetChangedEvent(access.workspaceId ?? access.state.workspaceId, {
			projectId: access.state.projectId,
			changedBy: user?.userId?.trim() || "anonymous",
			pageCount: committedPageCount,
		});
		return { imported: pages.length, pages, assets };
	} catch (error) {
		// Rollback decision (codex P1 r4 + P2 r11): writeProjectState writes
		// state.json BEFORE its catalog sync, so a failure after the call began is
		// ambiguous — re-read the persisted state and roll back ONLY when none of
		// the new ids are actually referenced (pre-commit write failure). If any
		// page references them (catalog-only failure), deleting would dangle refs.
		let stateReferencesNewAssets = false;
		if (stateWriteStarted && createdImageIds.length > 0) {
			try {
				const persisted = await resolveProjectState(access.state.projectId);
				const created = new Set(createdImageIds);
				stateReferencesNewAssets = Boolean(persisted?.pages?.some(
					(page) => page.edits?.imageId && created.has(page.edits.imageId),
				));
			} catch {
				// Unreadable state: stay conservative — keep the assets.
				stateReferencesNewAssets = true;
			}
		}
		if (!stateWriteStarted || !stateReferencesNewAssets) {
			if (rollbackCowService) {
				for (const versionId of [...cowVersionIds].reverse()) {
					try {
						await rollbackCowService.deleteVersion({ versionId, deleterUserId: user?.userId, skipAuthorizationForSystemCleanup: true });
					} catch (cleanupError) {
						console.warn("[import-cleaned] CoW version rollback failed", { versionId, error: String(cleanupError) });
					}
				}
			}
			await cleanupUncommittedUploadObjects(access.state.projectId, createdImageIds);
		}
		if (storageReservation) {
			await releaseProjectStorageQuotaReservationBestEffort(access.state.projectId, storageReservation.reservationId, {
				reason: "import_cleaned",
				phase: "rollback",
			});
		}
		throw error;
	}
}

cleanedImportRoutes.post("/cleaned/:chapterId", async (c) => {
	try {
		const chapterId = c.req.param("chapterId");
		if (!chapterId || chapterId.length > 200) {
			return c.json({ error: "Invalid chapter id", code: "invalid_chapter_id" }, 400);
		}
		const access = await authorizeProjectImport(c, chapterId);
		if (access instanceof Response) return access;
		const scopeError = assertScopedCleanedImport(access);
		if (scopeError) return scopeError;

		const payload = await extractCleanedImportPayload(c);
		const plans = await buildCleanedImportPlan(access.state, payload);
		const result = await commitCleanedImport(c, access, plans);
		return c.json({
			chapterId: access.state.projectId,
			imported: result.imported,
			pages: result.pages,
			assets: result.assets.map((asset) => ({
				imageId: asset.imageId,
				assetId: asset.assetId,
				originalName: asset.originalName,
				mimeType: asset.mimeType,
				sizeBytes: asset.sizeBytes,
				width: asset.width,
				height: asset.height,
				storageStatus: asset.storageStatus,
				moderationStatus: asset.moderation.status,
			})),
		});
	} catch (error) {
		if (error instanceof CleanedImportRequestError) {
			return c.json(error.toBody(), error.status);
		}
		throw error;
	}
});

// ── POST /api/export ──────────────────────────────────────────────────────
exportRoutes.post("/", async (c) => {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	const parsed = enqueueSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	if (!isExportPreset(parsed.data.preset)) {
		return c.json({ error: "Unknown export preset", code: "unknown_preset" }, 400);
	}

	const access = await authorizeProjectExport(c, parsed.data.projectId, { blockWhenSuspended: true });
	if (access instanceof Response) return access;

	const requestedImageIds = parsed.data.imageIds && parsed.data.imageIds.length > 0
		? parsed.data.imageIds
		: defaultImageIds(access.state);
	if (requestedImageIds.length === 0) {
		return c.json({ error: "Project has no pages to export", code: "no_source_images" }, 400);
	}

	// Authz: every requested export id must resolve to a real page of THIS project,
	// accepting BOTH the canonical `page.imageId` AND a page's edited background id
	// `page.edits?.imageId` (the client uses the edited id as the page export id).
	// Rejects an attempt to export arbitrary project objects by id. Normalizing here
	// collapses an edited id back to its canonical source page so page scope +
	// sourcePageCount stay page-based (each page counted once). Enforced for ALL
	// callers; the scoped-member check below additionally enforces page-assignment.
	const imageIds = normalizeRequestedPageImageIds(access.state, requestedImageIds);
	// Defense-in-depth: every normalized id must be a real canonical page image id
	// (guards against any normalizer regression before we read/export by id).
	if (!imageIds || !imageIdsAreProjectPages(access.state, imageIds)) {
		return c.json({ error: "Some export ids do not resolve to a project page", code: "unknown_export_id" }, 400);
	}

	// Enforce per-page scope for a scoped workspace member: the requireScopedPermission
	// asset check above does not carry a pageIndex, so a member limited to specific
	// pages could otherwise default to all pages or pass arbitrary imageIds.
	if (access.member && !imageIdsWithinScope(access.state, imageIds, access.member)) {
		return c.json({ error: "Some pages are outside your assigned scope", code: "page_scope_denied" }, 403);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const requestedTargetLang = parsed.data.targetLang?.trim() || undefined;
	const targetLang = resolveRequestTargetLang(access.state, parsed.data.targetLang);

	// SERVER-AUTHORITATIVE EXPORT GATE (codex P0/P1). Run the full readiness
	// aggregate — which checks moderation (`passed` only) on the SOURCE image, the
	// EDITED background (`page.edits?.imageId`, the id the export actually renders),
	// every visible image layer, and every visible edit-layer mask/patch asset, plus
	// the other blockers — BEFORE the job is queued. The durable processor's per-asset
	// `assertReady` is a defense-in-depth backstop, but it (a) only fires once the job
	// is already running and (b) lets a legacy/UNREGISTERED asset slip (prototype
	// compat). The readiness gate treats a missing moderation row as held, so an
	// unregistered/quarantined/needs_review asset blocks the export here, up front,
	// rather than failing the job async. Scope the gate to the requested pages (and
	// the member's assignment), matching the imageIds we are about to enqueue.
	const requestedPageIndexes = new Set<number>();
	access.state.pages.forEach((page, index) => {
		if (typeof page.imageId === "string" && imageIds.includes(page.imageId)) {
			requestedPageIndexes.add(index);
		}
	});
	const includeForGate = (pageIndex: number): boolean => {
		if (!requestedPageIndexes.has(pageIndex)) return false;
		if (!access.member) return true;
		return workspaceScopeAllows(access.member.scope, {
			projectId: access.state.projectId,
			resourceKind: "asset",
			pageIndex,
		});
	};
	const readiness = await buildChapterReadiness(access.state, includeForGate, targetLang, requestedTargetLang);
	// The `missing_language_output` blocker is owned by enqueueExportJob's typed
	// MissingLanguageOutputError below, which returns a richer, contract-stable
	// payload (targetLang + the exact imageIds). Defer to it; gate here on any OTHER
	// unresolved blocker (moderation, untranslated text, QC, open comments, workflow,
	// no_pages). This keeps the safety-critical moderation gate server-authoritative
	// while preserving the existing missing-language error contract.
	const blockingTypes = readiness.blockers
		.map((blocker) => blocker.type)
		.filter((type) => type !== "missing_language_output");
	if (blockingTypes.length > 0) {
		return c.json({
			error: "Export is blocked by unresolved readiness issues",
			code: "export_not_ready",
			blockers: blockingTypes,
			readiness,
		}, 409);
	}

	let job: ExportJob;
	try {
		job = await enqueueExportJob({
			workspaceId: access.workspaceId,
			projectId: parsed.data.projectId,
			chapterId: parsed.data.chapterId,
			requestedBy: user?.userId,
			targetLang,
			// Pass the RAW requested track so the enqueue guard can tell an explicit
			// non-default language from the omitted/default case.
			requestedTargetLang,
			preset: parsed.data.preset,
			imageIds,
			state: access.state,
			params: parsed.data.params,
		});
	} catch (error) {
		if (error instanceof MissingLanguageOutputError) {
			// An explicit non-default language track is missing on some requested pages.
			// Refuse rather than silently export the source/legacy (wrong) language.
			return c.json({
				error: error.message,
				code: "missing_language_output",
				targetLang: error.targetLang,
				imageIds: error.imageIds,
			}, 409);
		}
		throw error;
	}

	return c.json({ job: serializeJob(job) }, 202);
});

// ── GET /api/export/presets ─────────────────────────────────────────────────
// Declared before /:id so "presets" is not captured as a job id.
exportRoutes.get("/presets", async (c) => {
	const workspaceId = c.req.query("workspaceId")?.trim();
	const builtIn = listExportPresetConfigs();

	if (!workspaceId) {
		return c.json({ presets: builtIn, workspacePresets: [] });
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
	if (!workspaceAccessStore || !exportPresetStore) {
		return c.json({ presets: builtIn, workspacePresets: [] });
	}
	try {
		await workspaceAccessStore.requirePermission(workspaceId, user.userId, "read_workspace");
	} catch (error) {
		if (error instanceof WorkspaceAccessError) {
			return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
		}
		throw error;
	}
	const workspacePresets = await exportPresetStore.listByWorkspace(workspaceId);
	return c.json({ presets: builtIn, workspacePresets });
});

// ── POST /api/export/presets ─────────────────────────────────────────────────
exportRoutes.post("/presets", async (c) => {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	const parsed = savePresetSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
	if (!workspaceAccessStore || !exportPresetStore) {
		return c.json({
			error: "Workspace export presets require the Postgres workspace stores",
			code: "workspace_store_unavailable",
		}, 503);
	}
	try {
		// Saving a workspace preset is a project-management action (it shapes how the
		// workspace exports), so require manage_projects rather than plain read.
		const member = await workspaceAccessStore.requirePermission(parsed.data.workspaceId, user.userId, "manage_projects");
		// A workspace export preset is WORKSPACE-WIDE config (every project/language
		// can apply it), so it requires TRULY workspace-wide authority. A member with
		// ANY fine-grained scope restriction (projectIds/chapterIds/pageIndexes/
		// languages/taskTypes/assetPurposes) is a scoped project manager, not a
		// workspace-wide admin: even if their scope lists happen to cover everything
		// today, they must not be able to write config that outlives/exceeds their
		// assignment. Reject them; an unscoped owner/admin passes unchanged.
		if (isFineGrainedScope(member.scope)) {
			return c.json({
				error: "Forbidden: workspace-wide export presets require unscoped workspace authority",
				code: "workspace_preset_scope_denied",
			}, 403);
		}
	} catch (error) {
		if (error instanceof WorkspaceAccessError) {
			return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
		}
		throw error;
	}

	const preset = await exportPresetStore.save({
		id: randomUUID(),
		workspaceId: parsed.data.workspaceId,
		name: parsed.data.name,
		config: parsed.data.config,
		createdBy: user.userId,
	});
	return c.json({ preset }, 201);
});

// ── GET /api/export/:chapter/readiness ────────────────────────────────────────
// Export-gate checklist: aggregate EVERY blocker across ALL pages of the chapter
// (chapter == project in this model) and report per-blocker-type counts, a
// per-page breakdown, and an overall canExport flag. Replaces the old sequential
// first-blocker UX. Declared before /:id so "readiness" isn't captured as a job
// object path; the two-segment shape (:chapter/readiness) is distinct from /:id.
exportRoutes.get("/:chapter/readiness", async (c) => {
	const chapterId = c.req.param("chapter");
	if (!chapterId || chapterId.length > 200) {
		return c.json({ error: "Invalid chapter id", code: "invalid_chapter_id" }, 400);
	}

	// Same authz posture as enqueue: workspace projects require the export_project
	// permission in scope; personal/anonymous projects gate on owner match.
	const access = await authorizeProjectExport(c, chapterId);
	if (access instanceof Response) return access;

	// Respect page scope: a member limited to specific pages must not receive
	// readiness blockers/imageIds for pages outside their assignment (matching the
	// enqueue path's imageIdsWithinScope filter). An unscoped member/owner sees all.
	const includePageIndex = access.member
		? (pageIndex: number) =>
			workspaceScopeAllows(access.member!.scope, {
				projectId: access.state.projectId,
				resourceKind: "asset",
				pageIndex,
			})
		: undefined;

	const requestedTargetLang = c.req.query("targetLang")?.trim() || c.req.query("lang")?.trim() || undefined;
	const targetLang = resolveRequestTargetLang(access.state, requestedTargetLang);
	const readiness = await buildChapterReadiness(access.state, includePageIndex, targetLang, requestedTargetLang);
	return c.json({ readiness });
});

/**
 * Gather the per-image moderation status + per-page/chapter workflow state for a
 * chapter in BULK (one asset listing, one work-state batch), then compute the
 * readiness aggregate. No per-page fan-out: the work-state store's
 * getWorkStatesForSubjects issues a single ANY($) query, and moderation comes
 * from one listAssetRecordsAuthoritative call.
 */
async function buildChapterReadiness(
	state: ProjectState,
	includePageIndex?: (pageIndex: number) => boolean,
	targetLang?: string,
	requestedTargetLang?: string,
): Promise<ReturnType<typeof computeExportReadiness>> {
	const projectId = state.projectId;

	// Moderation: one authoritative listing for the whole project.
	const moderationByImageId = new Map<string, AssetModerationStatus | undefined>();
	try {
		const assets = await listAssetRecordsAuthoritative(projectId);
		for (const asset of assets) {
			moderationByImageId.set(asset.imageId, asset.moderation?.status);
		}
	} catch (error) {
		console.warn(`[export-readiness] asset listing failed for ${projectId}`, error);
	}

	// Workflow: only when a store is configured (Postgres). A no-DB prototype has
	// no workflow store, so the workflow gate is skipped (workflowGateEnabled=false)
	// rather than holding every page forever.
	const store = exportReadinessWorkStateStore;
	const workflowGateEnabled = Boolean(store);
	const workStateByPageIndex = new Map<number, WorkStateValue | undefined>();
	let chapterWorkState: WorkStateValue | undefined;
	if (store) {
		try {
			const pageSubjectIds = state.pages.map((_, index) => pageWorkSubjectId(projectId, index));
			const subjectIdToIndex = new Map<string, number>();
			pageSubjectIds.forEach((id, index) => subjectIdToIndex.set(id, index));
			const [pageStates, chapterState] = await Promise.all([
				store.getWorkStatesForSubjects("page", pageSubjectIds),
				store.getWorkState("chapter", projectId),
			]);
			for (const record of pageStates) {
				const index = subjectIdToIndex.get(record.subjectId);
				if (index !== undefined) workStateByPageIndex.set(index, record.state);
			}
			chapterWorkState = chapterState?.state;
		} catch (error) {
			console.warn(`[export-readiness] work-state read failed for ${projectId}`, error);
		}
	}

	const input: ExportReadinessInput = {
		state,
		moderationByImageId,
		workStateByPageIndex,
		chapterWorkState,
		workflowGateEnabled,
		includePageIndex,
		targetLang,
		requestedTargetLang,
	};
	return computeExportReadiness(input);
}

/**
 * Locate + authorize a job by id for the caller, returning the job or a Response
 * to short-circuit. Posture: a non-member / unauthenticated caller always gets a
 * uniform 404 so neither workspace nor personal job existence is probeable, and
 * an orphaned personal job (its owning project state is missing/unreadable) is
 * rejected rather than served.
 */
async function authorizeJobAccess(c: Context, id: string): Promise<ExportJob | Response> {
	const user = getAuthUser(c) as JWTPayload | undefined;
	const job = await exportJobStore.get(id);
	if (!job) return c.json({ error: "Export job not found", code: "export_job_not_found" }, 404);

	if (job.workspaceId) {
		if (!workspaceAccessStore) {
			return c.json({ error: "Workspace export requires the Postgres workspace access store", code: "workspace_store_unavailable" }, 503);
		}
		// 404 (not 401) for an unauthenticated caller so an anonymous probe cannot
		// distinguish an existing workspace job from a nonexistent id.
		if (!user) return c.json({ error: "Export job not found", code: "export_job_not_found" }, 404);
		try {
			await workspaceAccessStore.requireScopedPermission(
				job.workspaceId,
				user.userId,
				"export_project",
				{ projectId: job.projectId, resourceKind: "asset" },
			);
		} catch (error) {
			if (error instanceof WorkspaceAccessError) {
				// 404 rather than 403 so a non-member can't probe job existence.
				return c.json({ error: "Export job not found", code: "export_job_not_found" }, 404);
			}
			throw error;
		}
		return job;
	}

	// Personal/anonymous job: gate on the owning project's owner. A missing/unreadable
	// state means the project can no longer be verified — reject the orphaned job so a
	// stale persisted row can't hand out a signed URL to anyone holding the id.
	const state = await resolveProjectState(job.projectId);
	if (!state) {
		return c.json({ error: "Export job not found", code: "export_job_not_found" }, 404);
	}
	if (state.userId) {
		if (!user || state.userId !== user.userId) {
			return c.json({ error: "Export job not found", code: "export_job_not_found" }, 404);
		}
	} else if (!allowsLegacyAnonymousProjectAccess()) {
		// Ownerless project under a hardened posture: do not serve to anonymous callers.
		return c.json({ error: "Export job not found", code: "export_job_not_found" }, 404);
	}
	return job;
}

// ── GET /api/export/:id ─────────────────────────────────────────────────────
exportRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	if (!id || id.length > 200) {
		return c.json({ error: "Invalid export job id", code: "invalid_export_id" }, 400);
	}

	const authorized = await authorizeJobAccess(c, id);
	if (authorized instanceof Response) return authorized;
	const job = authorized;

	// Mint a fresh signed URL on read for a completed job: the persisted URL may
	// have expired, and minting on read keeps the TTL short without a stored
	// long-lived credential. Returns undefined on a non-presigning (local disk)
	// driver — clients then use the through-backend download paths below.
	let signedUrl: string | undefined;
	if (job.status === "done") {
		const signObjectId = deriveSignObjectId(job);
		if (signObjectId) {
			signedUrl = signExportUrl(job.projectId, signObjectId);
		}
	}

	return c.json({ job: serializeJob(job, signedUrl) });
});

// ── GET /api/export/:id/objects/:objectId ────────────────────────────────────
// Through-backend download for a single produced export object. Authorizes the
// same way as the status route, then serves the bytes. This is the fallback when
// the storage driver cannot presign (local disk) and is the authorized way to
// fetch each page/slice of a multi-output export (the manifest only lists ids).
exportRoutes.get("/:id/objects/:objectId{.+}", async (c) => {
	const id = c.req.param("id");
	if (!id || id.length > 200) {
		return c.json({ error: "Invalid export job id", code: "invalid_export_id" }, 400);
	}
	const objectId = c.req.param("objectId");
	if (!objectId || objectId.length > 400) {
		return c.json({ error: "Invalid export object id", code: "invalid_export_object_id" }, 400);
	}

	const authorized = await authorizeJobAccess(c, id);
	if (authorized instanceof Response) return authorized;
	const job = authorized;

	// Only an object this job actually produced (or its manifest) is downloadable,
	// so the route can't be used to read arbitrary exports/ keys for the project.
	if (!jobProducedObject(job, objectId)) {
		return c.json({ error: "Export object not found", code: "export_object_not_found" }, 404);
	}

	// Pre-check the abuse throttle BEFORE touching the (potentially huge) object, so
	// an already-over-threshold project is rejected without forcing a backend/R2 read
	// (mirrors the image-serve path). The exact-byte reservation happens below once
	// the object size is known.
	const preThrottleError = await assertEgressNotThrottledOrResponse(c, job.projectId, "asset_read");
	if (preThrottleError) return preThrottleError;

	// Stream the object instead of buffering the ENTIRE export (a multi-hundred-MB
	// chapter ZIP) into one Buffer per download. The storage layer returns a web
	// ReadableStream plus the known byte size; we meter the size against the SAME
	// egress reservation/recording the image-serve path uses so export pulls are
	// throttled + accounted consistently, then pipe the bytes straight through.
	const exportStream = await objectStorage.getProjectExportStream({ projectId: job.projectId, exportId: objectId });
	if (!exportStream) {
		return c.json({ error: "Export object not found", code: "export_object_not_found" }, 404);
	}
	const { stream, sizeBytes } = exportStream;

	// Reserve the bytes against the abuse window before serving so concurrent pulls
	// cannot collectively overshoot the threshold; recording below skips the abuse
	// increment to avoid double-counting these reserved bytes.
	const reserveError = await reserveEgressForReadOrResponse(c, job.projectId, sizeBytes, "asset_read");
	if (reserveError) {
		await stream.cancel().catch(() => {});
		return reserveError;
	}
	const recordError = await recordEgressWithAllowanceOrResponse(c, {
		projectId: job.projectId,
		imageId: objectId,
		purpose: "export",
		bytes: sizeBytes,
		statusCode: 200,
		skipAbuseReservation: true,
	});
	if (recordError) {
		// Cap rejected this read: roll back the abuse reservation and drop the stream
		// so undelivered bytes don't linger in the abuse window.
		await releaseEgressReservationBestEffort(job.projectId, sizeBytes);
		await stream.cancel().catch(() => {});
		return recordError;
	}

	return new Response(stream, {
		headers: {
			"Content-Type": contentTypeForObject(job, objectId),
			"Content-Length": String(sizeBytes),
			"Content-Disposition": `attachment; filename="${objectId.split("/").pop() ?? "export"}"`,
			"Cache-Control": "private, max-age=0",
			"X-Content-Type-Options": "nosniff",
			"X-Asset-Egress-Bytes": String(sizeBytes),
		},
	});
});

/** True when `objectId` is the manifest or one of the job's recorded outputs. */
function jobProducedObject(job: ExportJob, objectId: string): boolean {
	if (typeof job.params?.manifestObjectId === "string" && job.params.manifestObjectId === objectId) return true;
	const outputs = job.params?.outputs;
	if (!Array.isArray(outputs)) return false;
	return outputs.some((entry) => entry && typeof entry === "object" && (entry as { objectId?: unknown }).objectId === objectId);
}

function contentTypeForObject(job: ExportJob, objectId: string): string {
	if (typeof job.params?.manifestObjectId === "string" && job.params.manifestObjectId === objectId) {
		return "application/json";
	}
	const outputs = job.params?.outputs;
	if (Array.isArray(outputs)) {
		const match = outputs.find((entry) => entry && typeof entry === "object" && (entry as { objectId?: unknown }).objectId === objectId) as
			{ contentType?: unknown } | undefined;
		if (match && typeof match.contentType === "string") return match.contentType;
	}
	return "application/octet-stream";
}

/**
 * Derive the objectId to sign for a completed job. A single-output export signs
 * the lone output directly; a multi-output export (webtoon_split / multi-page)
 * signs the manifest so the client can discover every object. Falls back to
 * undefined when no output metadata is present (older row), leaving the stored
 * URL in place.
 */
function deriveSignObjectId(job: ExportJob): string | undefined {
	const outputs = job.params?.outputs;
	if (Array.isArray(outputs) && outputs.length === 1) {
		const first = outputs[0] as { objectId?: unknown };
		if (typeof first.objectId === "string") return first.objectId;
	}
	if (typeof job.params?.manifestObjectId === "string") return job.params.manifestObjectId as string;
	return undefined;
}

export { cleanedImportRoutes, exportRoutes };

// ── Export readiness work-state store seam ───────────────────────────────────
// The readiness route reads work-states through this binding (defaults to the
// module-level store, which is null without DATABASE_URL). A test seam lets the
// route be exercised with an in-memory store without a live database.
type ReadinessWorkStateStore = Pick<
	NonNullable<typeof workStateStore>,
	"getWorkState" | "getWorkStatesForSubjects"
>;

let exportReadinessWorkStateStore: ReadinessWorkStateStore | null = workStateStore;

/** Test seam: swap the active work-state store the readiness route reads from. */
export function setExportReadinessWorkStateStoreForTests(store: ReadinessWorkStateStore | null): () => void {
	const previous = exportReadinessWorkStateStore;
	exportReadinessWorkStateStore = store;
	return () => {
		exportReadinessWorkStateStore = previous;
	};
}

// ── Export preset persistence ───────────────────────────────────────────────
// Kept here (route-local) because presets are a thin CRUD over export_presets and
// have no processing logic. Mirrors the file|postgres store seam used elsewhere.

export interface ExportPresetRecord {
	id: string;
	workspaceId: string;
	name: string;
	config: Record<string, unknown>;
	createdBy?: string;
	createdAt?: string;
}

export interface ExportPresetStoreSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

export interface ExportPresetStore {
	save(record: ExportPresetRecord): Promise<ExportPresetRecord>;
	listByWorkspace(workspaceId: string): Promise<ExportPresetRecord[]>;
}

export class PostgresExportPresetStore implements ExportPresetStore {
	private readonly client: ExportPresetStoreSqlClient;

	constructor(client?: ExportPresetStoreSqlClient, databaseUrl = process.env.DATABASE_URL) {
		if (client) {
			this.client = client;
			return;
		}
		if (!databaseUrl?.trim()) {
			throw new Error("PostgresExportPresetStore requires DATABASE_URL");
		}
		this.client = getSharedBunSql(databaseUrl) as unknown as ExportPresetStoreSqlClient;
	}

	async save(record: ExportPresetRecord): Promise<ExportPresetRecord> {
		const rows = await this.client.unsafe<{ id: string; created_at: Date | string }>(`
			INSERT INTO export_presets (id, workspace_id, name, config, created_by)
			VALUES ($1, $2, $3, $4::text::jsonb, $5)
			ON CONFLICT (workspace_id, name) DO UPDATE SET
				config = EXCLUDED.config,
				created_by = EXCLUDED.created_by
			RETURNING id, created_at
		`, [record.id, record.workspaceId, record.name, JSON.stringify(record.config ?? {}), record.createdBy ?? null]);
		const row = rows[0];
		return {
			...record,
			id: row?.id ?? record.id,
			createdAt: row?.created_at instanceof Date ? row.created_at.toISOString() : row?.created_at ? String(row.created_at) : undefined,
		};
	}

	async listByWorkspace(workspaceId: string): Promise<ExportPresetRecord[]> {
		const rows = await this.client.unsafe<{ id: string; workspace_id: string; name: string; config: unknown; created_by?: string | null; created_at: Date | string }>(`
			SELECT id, workspace_id, name, config, created_by, created_at
			FROM export_presets
			WHERE workspace_id = $1
			ORDER BY name ASC
		`, [workspaceId]);
		return rows.map((row) => ({
			id: row.id,
			workspaceId: row.workspace_id,
			name: row.name,
			config: typeof row.config === "string" ? safeParseConfig(row.config) : (row.config as Record<string, unknown>) ?? {},
			createdBy: row.created_by ?? undefined,
			createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
		}));
	}
}

function safeParseConfig(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function createExportPresetStore(): ExportPresetStore | null {
	if (process.env.ASSET_REGISTRY_STORE?.trim().toLowerCase() === "postgres" && process.env.DATABASE_URL?.trim()) {
		return new PostgresExportPresetStore();
	}
	return null;
}

export let exportPresetStore: ExportPresetStore | null = createExportPresetStore();

/** Test seam: swap the active preset store. */
export function setExportPresetStoreForTests(store: ExportPresetStore | null): () => void {
	const previous = exportPresetStore;
	exportPresetStore = store;
	return () => {
		exportPresetStore = previous;
	};
}
