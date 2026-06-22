// Routes: Image upload + serve
// Path traversal protection, file type validation, size limits, ownership checks

import { Hono } from "hono";
import type { Context } from "hono";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import { getSharedBunSql } from "../services/sql-pool.js";
import { safePath, isValidProjectId, isValidImageId, sanitizeFilename } from "../utils/security.js";
import { resolveProjectState } from "../utils/project-state-file.js";
import { existsSync, mkdirSync } from "fs";
import { v4 as uuid } from "uuid";
import { optionalAuth, getAuthUser } from "../middleware/auth.middleware.js";
import { getTrustedClientIp } from "../utils/client-ip.js";
import {
	assertAssetTokenIssuanceAllowed,
	buildSignedAssetDeliveryUrls,
	extractAssetAccessToken,
	presignedR2DeliveryEnabled,
	readAssetAccessConfig,
	resolvePresignedR2Delivery,
	signAssetAccessToken,
	verifyAssetAccessToken,
	type AssetAccessPurpose,
	type PresignedR2Delivery,
} from "../services/asset-access.js";
import {
	ThumbnailSourceDecodeError,
	ThumbnailSourceNotFoundError,
	buildModerationDerivativePlan,
	executeModerationTilePlan,
	createSha256,
	ensureThumbnailDerivative,
	getAssetRecordAuthoritative,
	getAssetRecordsAuthoritativeBatch,
	getAssetWriteContextsAuthoritativeBatch,
	listAssetRecordPageAuthoritative,
	listAssetRecordsAuthoritative,
	recordUploadedAsset,
	removeAssetRecordAuthoritative,
	removeAssetRecordsAuthoritativeBatch,
	restoreAssetRecordAuthoritative,
	type AssetWriteContext,
	UploadedImageDecodeError,
	UploadedImageTooLargeError,
	getUploadImagePixelCeiling,
	getSplitSourcePixelCeiling,
	updateAssetModerationAuthoritative,
	validateUploadedImageBuffer,
	type ThumbnailFit,
	THUMBNAIL_COVER_MIN,
	THUMBNAIL_COVER_MAX_WIDTH,
	THUMBNAIL_COVER_MAX_HEIGHT,
	THUMBNAIL_INSIDE_MIN,
	THUMBNAIL_INSIDE_MAX_WIDTH,
	THUMBNAIL_INSIDE_MAX_HEIGHT,
} from "../services/assets.js";
import {
	type AssetEgressRecordInput,
	readEgressAbuseConfig,
	readEgressConfig,
	recordAssetEgress,
	summarizeProjectEgress,
} from "../services/egress-accounting.js";
import {
	assertEgressNotThrottledOrResponse,
	recordEgressWithAllowanceOrResponse,
	releaseEgressReservationBestEffort,
	reserveEgressForReadOrResponse,
} from "../services/egress-guard.js";
import { objectStorage } from "../services/storage.js";
import {
	StorageQuotaExceededError,
	listActiveProjectStorageQuotaReservations,
	releaseProjectStorageQuotaReservationBestEffort,
	reserveProjectStorageQuota,
	summarizeProjectStorageQuotaForProjectView,
	type StorageQuotaReservation,
} from "../services/storage-quota.js";
import { QuotaFrozenError, getSharedStorageCowService, type AssetAccountKind } from "../services/storage-cow.js";
import { isValidUploadAuditCursor, uploadAuditStore } from "../services/upload-audit.js";
import {
	UPLOAD_BATCH_IN_PROGRESS_CODE,
	UPLOAD_BATCH_IN_PROGRESS_RETRY_AFTER_SECONDS,
	isValidUploadBatchKey,
	startClaimHeartbeat,
	uploadBatchIdempotencyStore,
	waitForCachedUploadBatchResult,
} from "../services/upload-batch-idempotency.js";
import {
	UsageQuotaExceededError,
	assertUploadUsageAllowance,
	recordUploadUsage,
} from "../services/usage-ledger.js";
import { projectCatalogStore, isMutatingProjectPermission } from "../services/project-catalog.js";
import { isActiveChapterTeamMember } from "../services/chapter-team.js";
import { workspaceAccessStore } from "../services/workspace-access.js";
import {
	clampPerPage,
	clampSplitThreshold,
	groupForMerge,
	ImageTransformError,
	mergeImagesVertically,
	splitTallImage,
	DEFAULT_TALL_SPLIT_THRESHOLD_PX,
} from "../services/image-merge-split.js";
import { usageQuotaRejections } from "../middleware/metrics.js";
import { RequestBodyLimitError } from "../middleware/security-guards.js";
import { buildDenylistLookupFailClosedResult, buildKnownBlockedShaAssetResult, buildModerationImageDataUrl, imageModerationEnabled, lookupKnownBlockedSha256, mandatoryCsamScreenBuffer, moderateImage, toAssetModerationResult } from "../services/moderation.js";
import type { JWTPayload } from "../types/auth.js";
import { hasPermission } from "../types/auth.js";
import type { AssetActor, AssetModerationResult, AssetModerationStatus, AssetRecord, AssetStorageStatus, ProjectState } from "../types/index.js";
import type { WorkspaceScopeCheck } from "../services/workspace-access.js";

const images = new Hono();
// Optional authentication - works without token for prototype
images.use("*", optionalAuth);

type UploadUsageRecordResult = Awaited<ReturnType<typeof recordUploadUsage>>;
type ProjectOwnershipScopeCheck = WorkspaceScopeCheck & { imageId?: string };

export function storageCowActive(): boolean {
	return serverConfig.assetRegistryStore === "postgres" && Boolean(process.env.DATABASE_URL?.trim()) && process.env.STORAGE_COW_ENABLED !== "false";
}

function quotaFrozenResponse(c: Context, error: QuotaFrozenError): Response {
	return c.json({
		error: "Storage quota frozen",
		code: "quota_frozen",
		account_kind: error.accountKind,
		account_id: error.accountId,
		used_bytes: error.usedBytes,
		limit_bytes: error.limitBytes,
		top_5_largest_assets: error.top5LargestAssets,
		suggested_action: error.accountKind === "user" ? "promote" : "upgrade",
	}, 402);
}

export function resolveCowAccount(state: ProjectState, user: JWTPayload | undefined): { kind: AssetAccountKind; id: string; requesterUserId?: string } | null {
	// Original page uploads through this route are MASTER content for the
	// project, not an editor's personal working copy. A workspace project must
	// therefore charge the WORKSPACE storage account so workspace freeze/limit
	// accounting (and the reservation just checked) actually applies; otherwise
	// a workspace could import data on an individual editor's personal quota and
	// bypass the workspace ledger entirely (Codex P1: "Charge workspace uploads
	// to the workspace account"). User accounts are reserved for genuine editor
	// working copies, which flow through /api/assets/upload with asWorkingCopy.
	const workspaceId = state.workspaceId?.trim();
	if (workspaceId) {
		return { kind: "workspace", id: workspaceId };
	}
	// Personal (non-workspace) project: charge the OWNING user as a master
	// upload — `state.userId` is the project ledger, NOT the requester. A
	// collaborator/admin updating someone else's personal project must bill the
	// owner so the owner's quota/freeze tracks their own project growth instead
	// of an unrelated account (Codex P2: "Charge personal uploads to the project
	// owner"). requesterUserId stays undefined so the version is a master.
	const ownerUserId = state.userId?.trim();
	if (ownerUserId) return { kind: "user", id: ownerUserId };
	// Legacy ownerless personal project with an authenticated caller: fall back
	// to the requester so the bytes are still attributed to a real user account.
	if (user) return { kind: "user", id: user.userId };
	// Truly anonymous legacy project (no workspace, no owner, no caller): there
	// is no real billing entity. Previously this synthesized a `workspace`
	// account keyed by the project id, but quota rows are only created for
	// workspaces that actually exist, so incrementQuotaUsage() later threw
	// "Workspace billing account <projectId> was not created" and broke the
	// supported legacy upload path (Codex P2: "Do not bill anonymous projects as
	// nonexistent workspaces"). Skip CoW accounting for these uploads instead —
	// the asset row + object are still recorded; only the byte ledger is omitted,
	// which is correct since there is no account to charge.
	return null;
}

function resolveProjectImagePageIndex(
	state: Pick<ProjectState, "pages" | "aiReviewMarkers">,
	imageId: string,
): number | undefined {
	for (const [pageIndex, page] of (state.pages ?? []).entries()) {
		if (page.imageId === imageId || page.edits?.imageId === imageId) return pageIndex;
		if (page.imageLayers?.some((layer) => layer.imageId === imageId || layer.restoreImageId === imageId)) {
			return pageIndex;
		}
	}
	for (const marker of state.aiReviewMarkers ?? []) {
		if (marker.resultImageId === imageId) return marker.pageIndex;
	}
	return undefined;
}

// Mirrors routes/project.ts::chapterTeamPermissionGranted — the chapter-team
// fallback grants only the scoped read+work permissions (read/update/generate),
// never destructive/ownership-only ones (delete).
function chapterTeamPermissionGranted(permission: string | undefined): boolean {
	if (!permission) return true;
	return permission === "read:project"
		|| permission === "update:project"
		|| permission === "generate:ai";
}

// Helper to check project ownership
async function checkProjectOwnership(c: any, projectId: string, permission = "read:project", scopeCheck: ProjectOwnershipScopeCheck = {}): Promise<Response | null> {
	// Catalog-authoritative, tombstone-aware read: under Postgres the catalog row
	// wins; a permanently-deleted project must not re-enable any image operation even
	// if a stale state.json survived a partial delete.
	const state = await resolveProjectState(projectId);
	if (!state) {
		return c.json({ error: "Project not found" }, 404);
	}
	const user = getAuthUser(c) as JWTPayload | undefined;
	const { imageId, ...workspaceScopeCheck } = scopeCheck;
	if (workspaceScopeCheck.pageIndex === undefined && imageId) {
		workspaceScopeCheck.pageIndex = resolveProjectImagePageIndex(state, imageId);
	}

	// Wave 0 W0.1: backward-compat hatch closed by default — see
	// routes/project.ts::checkProjectOwnership for the full rationale.
	if (!user) {
		if (state.userId || state.workspaceId?.trim()) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		if (serverConfig.apiAuthRequired || !serverConfig.allowLegacyAnonymousProjects) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		console.warn(
			`[security] legacy anonymous project access via images route (projectId=${projectId}). `
			+ "ALLOW_LEGACY_ANONYMOUS_PROJECTS=true is enabled.",
		);
		return null;
	}

	if (state.workspaceId?.trim()) {
		if (projectCatalogStore && await projectCatalogStore.canAccessProject({
			projectId,
			userId: user.userId,
			permission,
			...workspaceScopeCheck,
		})) {
			return null;
		}
		// Chapter-team grant (workspace project): an ACTIVE chapter-team member gets the
		// same scoped read+work access as on a personal project, even if they are not a
		// workspace-level member. Pending invites and destructive permissions are excluded.
		// This mirrors routes/project.ts::checkProjectOwnership EXACTLY so the image
		// load/serve routes authorize invited members identically to the project routes —
		// without this, an active chapter-team member (not a workspace member) could open
		// the chapter but the editor showed no page images (P0).
		// FREEZE gate: the chapter-team fallback BYPASSES the catalog `canAccessProject`
		// path, so it must consult the same suspension truth — a frozen workspace blocks
		// the fallback's MUTATING grants (update:project / generate:ai) for everyone while
		// still allowing reads.
		if (chapterTeamPermissionGranted(permission) && isActiveChapterTeamMember(state, user.userId)) {
			// REVOCATION gate (mirror of routes/project.ts): workspace removal revokes
			// the chapter-team fallback; never-member externals keep their grant.
			if (
				workspaceAccessStore
				&& await workspaceAccessStore.isMembershipRevoked(state.workspaceId.trim(), user.userId)
			) {
				return c.json({ error: "Project not found" }, 404);
			}
			if (
				isMutatingProjectPermission(permission)
				&& workspaceAccessStore
				&& await workspaceAccessStore.isWorkspaceSuspended(state.workspaceId.trim())
			) {
				return c.json({ error: "Workspace is suspended (payment refund/chargeback). Pay to restore access.", code: "workspace_suspended" }, 403);
			}
			return null;
		}
		return c.json({ error: "Project not found" }, 404);
	}

	// If project has userId, check ownership
	if (state.userId && state.userId !== user.userId) {
		if (projectCatalogStore && await projectCatalogStore.canAccessProject({
			projectId,
			userId: user.userId,
			permission,
			...workspaceScopeCheck,
		})) {
			return null;
		}
		// Chapter-team grant: an ACTIVE chapter-team member of a PERSONAL project they
		// don't own gets scoped read+work access (read/update/generate). The chapter IS
		// the project for a personal-mode chapter, so an active member may load + save it.
		// Pending invites grant nothing; destructive/ownership-only permissions (delete)
		// stay owner-only. Mirrors routes/project.ts::checkProjectOwnership exactly.
		if (chapterTeamPermissionGranted(permission) && isActiveChapterTeamMember(state, user.userId)) {
			return null;
		}
		return c.json({ error: "Project not found" }, 404);
	}

	if (!hasPermission(user.role, permission)) {
		return c.json({ error: `Forbidden: Missing permission '${permission}'` }, 403);
	}

	return null;
}

// Ensure the local project images directory exists for an authorized upload.
//
// Catalog/dual-store correctness: under the Postgres catalog a project can be
// fully authoritative with NO local PROJECTS_DIR/<id> directory (the previous
// hard `existsSync(projectDir)` 404 wrongly rejected catalog-only projects from
// uploading even though checkProjectOwnership had already authorized them and
// the object-storage/CoW write path creates dirs as needed). In pure file mode
// the project's existence is enforced by checkProjectOwnership (resolveProjectState
// reads state.json), so creating the images dir here is safe and idempotent and
// never grants access on its own — it runs only AFTER ownership is verified.
export function ensureUploadProjectDir(projectId: string): void {
	const imgDir = safePath(PROJECTS_DIR, projectId, "images");
	if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });
}

const ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const MIME_MAP: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

interface UploadCandidate {
	file: File;
	ext: string;
	safeName: string;
	sizeBytes: number;
}

interface PreparedUploadCandidate extends UploadCandidate {
	imageBuffer: Buffer;
	/** Explicit MIME for synthetic (transformed) buffers that have no source File. */
	mimeType?: string;
}

/**
 * Canonical, SERVER-MEASURED byte size of an uploaded image (S3). The multipart
 * `file.size` is client-supplied and spoofable; the durable accounting (recorded
 * asset sizeBytes + the usage/storage gates) must use the length of the bytes the
 * server actually decoded and will write — matching the CoW ledger, which already
 * charges `input.buffer.byteLength`. This is the single source of truth for size.
 */
export function measureUploadedImageBytes(imageBuffer: Buffer): number {
	return imageBuffer.byteLength;
}

class UploadModerationBlockedError extends Error {
	constructor(
		readonly imageId: string,
		// Either a raw provider verdict (`ModerationResult`, may carry `csam_block`)
		// or a normalized `AssetModerationResult` from the mandatory CSAM screen /
		// known-sha denylist. Both expose `status`, which the response handler reads.
		readonly result: Awaited<ReturnType<typeof moderateImage>> | AssetModerationResult,
	) {
		super("Uploaded image blocked by moderation");
		this.name = "UploadModerationBlockedError";
	}
}

interface ChapterOriginalUsage {
	imageCount: number;
	originalBytes: number;
	persistedImageCount: number;
	persistedOriginalBytes: number;
	reservedImageCount: number;
	reservedOriginalBytes: number;
}

interface ChapterUploadLimitOptions {
	includeActiveReservations?: boolean;
	reservationAnchor?: Pick<StorageQuotaReservation, "createdAt" | "reservationId">;
}

const ASSET_ACCESS_PURPOSES = new Set<AssetAccessPurpose>(["original", "thumbnail", "editor_preview", "export", "ai_output"]);
const ASSET_STORAGE_STATUSES = new Set<AssetStorageStatus>(["quarantined", "released", "blocked"]);
const ASSET_MODERATION_STATUSES = new Set<AssetModerationStatus>(["pending", "passed", "blocked", "needs_review"]);
const ASSET_SOURCES = new Set<AssetActor["source"]>(["human", "ai_job", "system", "anonymous"]);

interface AssetAccessGuardResult {
	error: Response | null;
	purpose: AssetAccessPurpose;
	tokenRequired: boolean;
	tokenAccepted: boolean;
	tokenExpiresAt?: number;
}

function parseThumbnailDimension(value: string | undefined, fallback: number, min: number, max: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.round(parsed)));
}

function parseAssetAccessPurpose(value: string | undefined): AssetAccessPurpose | null {
	if (!value) return "editor_preview";
	return ASSET_ACCESS_PURPOSES.has(value as AssetAccessPurpose) ? value as AssetAccessPurpose : null;
}

function parseTtlSeconds(value: string | undefined): number | undefined | null {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseAuditLimit(value: string | undefined): number | null {
	return parsePositiveIntegerQuery(value, 100, 500);
}

function parseAssetListLimit(value: string | undefined): number | null {
	return parsePositiveIntegerQuery(value, 1000, 1000);
}

function parsePositiveIntegerQuery(value: string | undefined, fallback: number, max: number): number | null {
	if (!value) return fallback;
	if (!/^[1-9]\d*$/.test(value)) return null;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) return null;
	return Math.min(parsed, max);
}

// Parse a multipart/form-data upload body, returning a clean 400 instead of an
// unhandled 500 when the request has no body or a wrong/absent multipart
// Content-Type. Hono's `c.req.formData()` throws `ERR_FORMDATA_PARSE_ERROR`
// ("Can't decode form data from body because of incorrect MIME type/boundary")
// for a bodyless or non-multipart POST; left uncaught that surfaced as a 500
// "Internal server error" on the upload + upload-transform routes (a malformed
// client request should be a 400, and it should not log as a server fault).
//
// Only the multipart-decode failure is converted here. A RequestBodyLimitError
// (the streaming body-size guard tripping mid-parse) and any other error are
// re-thrown so the global handler still produces the correct 413
// `request_body_too_large` / 500 — narrowing the catch is what keeps the body-cap
// 413 from being masked as a generic 400.
function isFormDataParseError(error: unknown): boolean {
	if (error instanceof RequestBodyLimitError) return false;
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "ERR_FORMDATA_PARSE_ERROR") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /form data|multipart|boundary|MIME type/i.test(message);
}

async function parseUploadFormData(c: Context): Promise<{ formData: FormData; error?: undefined } | { formData?: undefined; error: Response }> {
	try {
		return { formData: await c.req.formData() };
	} catch (error) {
		if (!isFormDataParseError(error)) throw error;
		console.warn("[images] rejected upload with unparseable multipart body", {
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			error: c.json({ error: "Invalid multipart form data", code: "invalid_multipart_body" }, 400),
		};
	}
}

async function cleanupUncommittedUploadObjects(projectId: string, imageIds: string[]): Promise<void> {
	if (imageIds.length === 0) return;
	// Batch the three asset_records round-trips that previously ran PER image
	// (SELECT record + SELECT write-context + DELETE) into ONE query each, so a
	// multi-file upload rollback no longer issues ~3N sequential queries.
	//
	// Capture record + durable context BEFORE deleting so a per-image rollback can
	// re-insert the durable row WITH its original workspace_id + reservation
	// metadata (those live on the row, not on AssetRecord — re-inserting without
	// them would null them and break workspace-scoped indexes/accounting).
	const assetRecords = await getAssetRecordsAuthoritativeBatch(projectId, imageIds);
	const assetWriteContexts = assetRecords.size > 0
		? await getAssetWriteContextsAuthoritativeBatch(projectId, imageIds)
		: new Map<string, AssetWriteContext>();
	// One batched DELETE. Returns the set actually removed, preserving the per-image
	// `assetRecordRemoved` signal the object delete and rollback guard depend on. The
	// invariant — an object is deleted ONLY after its authoritative record removal is
	// confirmed — must hold even when the batch DELETE throws. The earlier batch
	// version set `removedAssetIds` to EMPTY on failure yet still object-deleted every
	// image unconditionally, orphaning DB rows against deleted objects (worse than the
	// per-image predecessor). Instead, on batch failure we fall back to a per-image
	// authoritative record delete so `removedAssetIds` reflects exactly which rows
	// were really removed; only those images get their object deleted below. Cleanup
	// runs from an upload error path, so individual record-delete failures are
	// swallowed (logged) — they simply leave that image's object in place rather than
	// orphaning it.
	let removedAssetIds: Set<string>;
	try {
		removedAssetIds = await removeAssetRecordsAuthoritativeBatch(projectId, imageIds);
	} catch (removeError) {
		console.warn("[images] batch-delete of rolled back upload asset records failed; falling back to per-image deletes", {
			projectId,
			imageIds,
			error: removeError instanceof Error ? removeError.message : String(removeError),
		});
		removedAssetIds = new Set<string>();
		for (const imageId of imageIds) {
			try {
				if (await removeAssetRecordAuthoritative(projectId, imageId)) {
					removedAssetIds.add(imageId);
				}
			} catch (perImageError) {
				// Leave this image's object in place: deleting it without a confirmed
				// record removal is the data-integrity regression we are guarding against.
				console.warn("[images] failed to delete rolled back upload asset record (per-image fallback)", {
					projectId,
					imageId,
					error: perImageError instanceof Error ? perImageError.message : String(perImageError),
				});
			}
		}
	}

	// Object-storage + audit deletes run per image: they hit external storage (no DB
	// query to batch) and each can fail independently. The data-integrity invariant is
	// that no DB row may ever be left pointing at a deleted object. So we delete the
	// object UNLESS a record existed for this image but its authoritative removal was
	// NOT confirmed — that case (the batch DELETE threw and the per-image fallback also
	// failed) would orphan the surviving row, so we skip the object delete and leave
	// both the row and the object intact. When no record existed durably (the upload
	// failed after the object write but before the record was created — `imageId` is
	// pushed before recordUploadedAsset), the object is safe to delete: nothing points
	// at it, and skipping it would instead leak storage. On a per-image object delete
	// failure we restore the (confirmed-removed) row so the object is never orphaned
	// the other way. This matches the original per-image semantics: a record-delete
	// failure skips that single image's object delete without touching the others.
	for (const imageId of imageIds) {
		const assetRecord = assetRecords.get(imageId);
		const assetRecordRemoved = removedAssetIds.has(imageId);
		if (assetRecord && !assetRecordRemoved) {
			// A durable record exists but we could not confirm its removal. Deleting the
			// object now would orphan the surviving row, so skip the object (and audit)
			// delete entirely for this image.
			console.warn("[images] skipping upload object delete: asset record removal not confirmed", {
				projectId,
				imageId,
			});
			continue;
		}
		let objectDeleted = false;
		try {
			await objectStorage.deleteProjectImage({ projectId, imageId });
			objectDeleted = true;
			await uploadAuditStore.deleteProjectImageEvent(projectId, imageId);
		} catch (cleanupError) {
			if (assetRecord && assetRecordRemoved && !objectDeleted) {
				try {
					// Re-insert the durable row (and mirror) WITH its original
					// workspace/metadata context so the object is not left orphaned and
					// the restored row keeps its workspace_id + reservation metadata.
					await restoreAssetRecordAuthoritative(projectId, assetRecord, assetWriteContexts.get(imageId) ?? {});
				} catch (restoreError) {
					console.warn("[images] failed to restore rolled back upload asset record after cleanup failure", {
						projectId,
						imageId,
						error: restoreError instanceof Error ? restoreError.message : String(restoreError),
					});
				}
			}
			console.warn("[images] failed to clean up rolled back upload object", {
				projectId,
				imageId,
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
	}
}

function isValidAssetListCursor(value: string | undefined): boolean {
	if (!value) return true;
	if (value.length > 500) return false;
	try {
		const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
		return typeof decoded.createdAt === "string"
			&& typeof decoded.assetId === "string"
			&& !Number.isNaN(new Date(decoded.createdAt).getTime())
			&& decoded.assetId.trim().length > 0;
	} catch {
		return false;
	}
}

function serializeAssetSummary(asset: AssetRecord) {
	return {
		assetId: asset.assetId,
		imageId: asset.imageId,
		originalName: asset.originalName,
		mimeType: asset.mimeType,
		sizeBytes: asset.sizeBytes,
		sha256: asset.sha256,
		storageDriver: asset.storageDriver,
		storageKey: asset.storageKey,
		width: asset.width,
		height: asset.height,
		storageStatus: asset.storageStatus,
		moderationStatus: asset.moderation.status,
		derivativeCount: asset.derivatives.length,
		uploadedBy: asset.uploadedBy ?? { source: "anonymous" },
		uploadAuditId: asset.uploadAuditId,
		createdAt: asset.createdAt,
		updatedAt: asset.updatedAt,
	};
}

function getClientIp(c: Context): string | undefined {
	return getTrustedClientIp(c);
}

function buildUploadActor(user: JWTPayload | undefined) {
	if (!user) return { source: "anonymous" as const };
	return {
		source: "human" as const,
		userId: user.userId,
		email: user.email,
		role: user.role,
	};
}

type PageSetUploadChangeMode = "add" | "replace" | "none";

function resolvePageSetUploadChangeMode(assetKind: string | undefined): PageSetUploadChangeMode {
	if (!assetKind || assetKind === "page-image") return "add";
	if (assetKind === "page-replacement") return "replace";
	return "none";
}

async function buildModerationImageUrl(c: Context, storedObject: { key: string }, imageBuffer: Buffer, mimeType: string): Promise<string> {
	const publicBase = serverConfig.r2.publicBaseUrl.replace(/\/+$/, "");
	if (publicBase) return `${publicBase}/${storedObject.key.split("/").map(encodeURIComponent).join("/")}`;
	// Local development / private object storage have no provider-readable public
	// URL. The OpenAI moderation API accepts image_url data URLs, and tests mock
	// fetch. Use the BOUNDED moderation derivative (not the raw original) so large
	// but valid manga/webtoon uploads stay inside the provider request-size limit
	// instead of fail-closing as a moderation failure.
	void c;
	return buildModerationImageDataUrl(imageBuffer, mimeType);
}

// Aggregate the mandatory CSAM verdict with the soft policy verdict fail-closed:
// blocked > needs_review > passed. Keeps a fail-open soft `passed` from ever
// relaxing a mandatory `needs_review`/`blocked` on the upload path.
function worseUploadModeration(
	mandatory: ReturnType<typeof toAssetModerationResult>,
	soft: ReturnType<typeof toAssetModerationResult>,
): ReturnType<typeof toAssetModerationResult> {
	const rank = (status: string): number => {
		if (status === "blocked") return 3;
		if (status === "needs_review") return 2;
		if (status === "passed") return 1;
		return 0;
	};
	return rank(soft.status) > rank(mandatory.status) ? soft : mandatory;
}

function storageStatusForModeration(result: ReturnType<typeof toAssetModerationResult>): AssetStorageStatus {
	// Only HARD policy outcomes (block / csam_block → "blocked") quarantine the
	// object. A soft warning (`needs_review`, e.g. non-blocking shonen violence)
	// that PASSED the mandatory policy stays released-and-servable with a review
	// marker; it remains gated out of AI by `assertAssetReadyForAi` and out of
	// export by the readiness gate (which requires `passed`). A PROVIDER-FAILURE
	// fail-closed `needs_review` (mandatory CSAM screen could not run) is instead
	// QUARANTINED — withheld from serving AND export — until re-moderation.
	if (result.status === "blocked") return "blocked";
	if (result.failClosed) return "quarantined";
	return "released";
}

async function assertAssetServable(
	c: Context,
	projectId: string,
	imageId: string,
	// The resolved access purpose. The `export` purpose is held to the STRICTER
	// export bar (moderation must be `passed`), so a genuine borderline
	// `needs_review` asset that is fine for in-editor preview is NOT downloadable as
	// a single-page export. Other purposes keep the in-editor servable set
	// (passed + needs_review). Defaults to a non-export purpose.
	purpose: AssetAccessPurpose = "editor_preview",
	// Optional: the AUTHORITATIVE record for THIS exact (projectId, imageId), if the caller
	// already read it via getAssetRecordAuthoritative this request — lets the hot serve paths
	// skip a redundant authoritative read. The moderation gate below TRUSTS it, so it MUST be
	// getAssetRecordAuthoritative(projectId, imageId) for the SAME ids; pass undefined to read
	// fresh. On success the (gate-validated) record is RETURNED so the caller reuses the exact
	// record that passed the gate (no TOCTOU re-read).
	prefetchedAsset?: Awaited<ReturnType<typeof getAssetRecordAuthoritative>>,
): Promise<Response | NonNullable<Awaited<ReturnType<typeof getAssetRecordAuthoritative>>>> {
	// Consult the durable store (Postgres in DB mode) before deciding servability.
	// A missing JSON mirror after a restart/clean disk must not let a blocked or
	// quarantined asset (still present in asset_records) be treated as servable.
	const asset = prefetchedAsset ?? await getAssetRecordAuthoritative(projectId, imageId);
	if (!asset) {
		// FAIL-CLOSED (codex P0): an image id with NO authoritative asset record is an
		// un-registered / quarantined / pre-moderation object (the raw AI provider
		// checkpoint parked under a predictable `aijob_provider_<jobId>.png` id BEFORE
		// moderation, an orphaned blob, or a brand-new object an attacker parked and
		// then referenced from a crafted save). Serving raw bytes by id without a
		// record would bypass the moderation gate entirely, so we ALWAYS deny here.
		//
		// LEGACY (codex P0 round-3): genuine pre-registry user images — uploaded before
		// asset records existed and still referenced by live project state — are given a
		// `passed` record by the SERVER-SIDE, deploy-time BACKFILL
		// (`backfillStateReferencedAssets`, src/scripts/backfill-state-referenced-assets.ts),
		// NOT on this hot path. We deliberately removed the on-demand "grandfather on
		// first serve" step: it trusted CLIENT-WRITABLE project-state references, so an
		// attacker could park an unmoderated object, save a state that references its id,
		// and have the serve path register it `passed` (a NEW CSAM-laundering bypass).
		// After backfill, every legitimate legacy object has a record and every NEW
		// object always gets a record on the normal upload/AI/crop path — so a
		// missing-record object here is genuinely unregistered and must be denied. A
		// fresh client save that references a never-registered object can NEVER mint a
		// record from this path.
		return c.json({
			error: "Asset is not available",
			code: "asset_not_registered",
		}, 403);
	}
	// EXPORT and ORIGINAL purposes are server-authoritatively held to the STRICTER
	// export/download bar: moderation must be `passed`. A genuine borderline
	// `needs_review` (servable for in-editor PREVIEW with its review banner) must NOT
	// be downloadable as a single-page export NOR as the raw original. This is the
	// server-side gate behind `exportPage()`'s client-side export gate (codex P0/P1:
	// single-page export had no server moderation gate) AND the "non-downloadable
	// until passed" safety posture (codex P1: `original` previously used the laxer
	// preview bar, so a needs_review asset could mint an `original` token / download /
	// presign before review). In-editor PREVIEW (purpose `editor_preview`) deliberately
	// stays able to show needs_review with its review banner — only `export`/`original`
	// raw download/presign are passed-only. Storage status must still be `released` (a
	// quarantined/blocked asset is never servable on any purpose).
	if (purpose === "export" || purpose === "original") {
		if (asset.storageStatus === "released" && asset.moderation.status === "passed") return asset;
		return c.json({
			error: purpose === "export" ? "Asset is not available for export" : "Asset is not available for download",
			code: purpose === "export" ? "asset_not_exportable" : "asset_not_downloadable",
			storageStatus: asset.storageStatus,
			moderationStatus: asset.moderation.status,
		}, 403);
	}
	// Servable ONLY when the storage status is `released` (a provider-passed `passed`
	// or genuine borderline `needs_review`). A hard `blocked` OR a fail-closed
	// `quarantined` asset (provider-failure `needs_review`, denylist-lookup failure,
	// unscreened tile) is withheld from serving. The moderation-status check is
	// belt-and-suspenders on top of the storage status.
	const servableModeration = asset.moderation.status === "passed" || asset.moderation.status === "needs_review";
	if (asset.storageStatus === "released" && servableModeration) return asset;
	return c.json({
		error: "Asset is not available",
		code: "asset_not_released",
		storageStatus: asset.storageStatus,
		moderationStatus: asset.moderation.status,
	}, 403);
}

// Authorize a request that serves asset bytes (thumbnail / image / preview).
//
// A browser `<img src>` cannot attach an `Authorization: Bearer` header, so the
// JWT-only `checkProjectOwnership` path 401s for cover/thumbnail/preview tags.
// The signed asset token closes that gap: it is HMAC-signed, scoped to a single
// (projectId, imageId, purpose), short-lived, and is ONLY minted by the authed
// `/access-token` route AFTER `checkProjectOwnership` succeeds for the calling
// user. So a request that carries a valid, in-scope token is already proven to
// originate from a user who could access this asset — we treat the verified
// token as sufficient authorization and skip the (header-dependent) JWT
// ownership check. Requests WITHOUT a valid token fall back to JWT ownership,
// preserving the Bearer/editor-blob path (#138) and cross-user denial. A token
// for project A never authorizes project B because verification binds the
// payload's projectId/imageId/purpose to the requested route params.
async function authorizeAssetRequest(
	c: Context,
	projectId: string,
	imageId: string,
	access: AssetAccessGuardResult,
): Promise<Response | null> {
	if (access.tokenAccepted) {
		// Verified, in-scope signed token → authorized without a JWT.
		return null;
	}
	return checkProjectOwnership(c, projectId, "read:project", {
		imageId,
		assetPurpose: access.purpose,
		resourceKind: "asset",
	});
}

function requireSignedAssetAccess(c: Context, projectId: string, imageId: string, purposes: AssetAccessPurpose[], fallbackPurpose: AssetAccessPurpose): AssetAccessGuardResult {
	const token = extractAssetAccessToken(
		c.req.query("assetToken"),
		c.req.header("Authorization"),
		c.req.header("X-Asset-Token"),
	);
	const optionalVerification = token ? verifyAssetAccessToken({ token, projectId, imageId, purposes }) : null;
	if (!readAssetAccessConfig().enforced) {
		return {
			error: null,
			purpose: optionalVerification?.ok ? optionalVerification.payload!.purpose : fallbackPurpose,
			tokenRequired: false,
			tokenAccepted: optionalVerification?.ok ?? false,
			tokenExpiresAt: optionalVerification?.ok ? optionalVerification.payload!.exp : undefined,
		};
	}
	const verification = optionalVerification ?? verifyAssetAccessToken({ token, projectId, imageId, purposes });
	if (verification.ok) {
		return { error: null, purpose: verification.payload!.purpose, tokenRequired: true, tokenAccepted: true, tokenExpiresAt: verification.payload!.exp };
	}
	return {
		error: c.json({
			error: "Asset access token required",
			code: "asset_access_token_required",
			reason: verification.reason ?? "missing",
		}, 401),
		purpose: fallbackPurpose,
		tokenRequired: true,
		tokenAccepted: false,
	};
}

// Cap a throttle-eligible asset response's public cache lifetime when egress
// abuse enforcement is engaged, so a CDN cannot keep serving a throttled asset
// from cache and bypass the origin gate. See ABUSE_ENFORCED_MAX_PUBLIC_TTL_SECONDS
// and buildAssetCacheControl. Defensive: a config error is treated as "engaged"
// (fail-closed) so a misconfigured shutoff still tightens caching rather than
// emitting an immutable, day-long public TTL the CDN would honor indefinitely.
function abuseEnforcementEngaged(): boolean {
	try {
		const abuse = readEgressAbuseConfig();
		return abuse.enabled && abuse.mode === "enforce";
	} catch {
		return (process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES?.trim().length ?? 0) > 0;
	}
}

// When abuse enforcement is engaged, the most a public (CDN-cacheable) asset
// response may live before the edge must revalidate against the origin gate.
// Bounds how long a CDN can serve a now-throttled asset from cache. (Edge-side
// throttling / active purge — see the residual-limitation note below — would be
// the full fix; this only bounds origin-issued cache lifetime.)
const ABUSE_ENFORCED_MAX_PUBLIC_TTL_SECONDS = 60;

// Build a Cache-Control for an asset response.
//
// Residual limitation (Codex round-2 #4): the origin-side abuse gate runs only
// when a request actually reaches the origin. A CDN/edge cache that has already
// stored a response will keep serving it without re-hitting these counters or the
// 429 until that cached copy expires. We mitigate this origin-side by refusing to
// emit `immutable` / long public TTLs for throttle-eligible assets while abuse
// enforcement is engaged — capping cached lifetime to
// ABUSE_ENFORCED_MAX_PUBLIC_TTL_SECONDS so the edge must revalidate soon. A
// complete fix (instant edge enforcement / cache purge on throttle) requires
// edge-side support and is intentionally out of origin scope; this documented,
// bounded staleness is the accepted residual.
function buildAssetCacheControl(access: AssetAccessGuardResult, fallbackSeconds: number, immutable = false): string {
	// While abuse enforcement is engaged, never let a throttle-eligible asset be
	// cached as immutable or for a long public TTL — otherwise the CDN serves it
	// past the point the origin would 429.
	const enforcingAbuse = abuseEnforcementEngaged();
	const effectiveImmutable = immutable && !enforcingAbuse;
	const ttlCeiling = enforcingAbuse
		? Math.min(fallbackSeconds, ABUSE_ENFORCED_MAX_PUBLIC_TTL_SECONDS)
		: fallbackSeconds;
	if (!access.tokenRequired || !access.tokenAccepted || !access.tokenExpiresAt) {
		return `public, max-age=${ttlCeiling}${effectiveImmutable ? ", immutable" : ""}`;
	}
	const now = Math.floor(Date.now() / 1000);
	const secondsUntilTokenExpiry = Math.max(0, access.tokenExpiresAt - now);
	const maxAge = Math.min(ttlCeiling, secondsUntilTokenExpiry);
	if (maxAge <= 0) return "no-store";
	return `public, max-age=${maxAge}${effectiveImmutable ? ", immutable" : ""}`;
}

async function recordEgressOrResponse(c: Context, input: AssetEgressRecordInput): Promise<Response | null> {
	try {
		await recordAssetEgress(input);
		return null;
	} catch (error) {
		const config = readEgressConfig();
		console.error("[images] asset egress record failed", { projectId: input.projectId, imageId: input.imageId, error });
		if (config.enforced && config.limitBytes > 0) {
			return c.json({
				error: "Asset egress accounting unavailable",
				code: "asset_egress_accounting_unavailable",
			}, 503);
		}
		return null;
	}
}

// Look up an already-generated (cache HIT) thumbnail derivative from the asset
// index WITHOUT reading its bytes, so a cached thumbnail can be presigned for
// direct R2 delivery without the backend first downloading the full buffer
// (Codex finding #3 — that download defeated the point of direct delivery).
//
// ensureThumbnailDerivative builds the derivative id from the *requested*
// (clamped) width/height — `${imageId}.thumbnail.{w}x{h}.{version}.webp` — and
// the thumbnail route clamps to the SAME bounds (64..512 / 64..768), so the
// requested dimensions identify the cached record. We match the
// `.thumbnail.{w}x{h}.` infix (version-agnostic) on a ready derivative that has
// a known byte size. Returns undefined on any cache miss so the caller falls
// back to ensureThumbnailDerivative (which generates + persists the buffer).
async function findReadyThumbnailDerivative(
	projectId: string,
	imageId: string,
	width: number,
	height: number,
	fit: ThumbnailFit = "cover",
): Promise<{ derivativeId: string; sizeBytes: number } | undefined> {
	// Read derivative metadata authoritatively so a ready thumbnail persisted in
	// asset_records is honored even when the JSON mirror is stale/missing.
	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	if (!asset) return undefined;
	// Match the fit-aware derivative id: cover → `.thumbnail.WxH.v1`, inside →
	// `.thumbnail.WxH.inside.v1` (keep cover infix from matching an inside id).
	const dimsInfix = `.thumbnail.${width}x${height}.`;
	const fitInfix = fit === "inside" ? `${dimsInfix}inside.` : dimsInfix;
	const derivative = asset.derivatives.find(
		(item) =>
			item.purpose === "thumbnail"
			&& item.status === "ready"
			&& typeof item.sizeBytes === "number"
			&& item.sizeBytes > 0
			&& item.id.includes(fitInfix)
			// cover must NOT pick up an inside-tagged id sharing the WxH infix.
			&& (fit === "inside" || !item.id.includes(`${dimsInfix}inside.`)),
	);
	if (!derivative || typeof derivative.sizeBytes !== "number") return undefined;
	// The index can drift from object storage; only treat as a cache HIT when the
	// derivative object actually exists, otherwise the presigned URL would 404.
	const exists = await objectStorage.hasProjectDerivative({ projectId, derivativeId: derivative.id });
	if (!exists) return undefined;
	return { derivativeId: derivative.id, sizeBytes: derivative.sizeBytes };
}

// Attempt private-bucket direct delivery: hand the client a short-TTL presigned
// R2 URL (302) instead of streaming the object through the backend. Returns the
// redirect Response when presigned delivery is enabled and a URL was minted;
// otherwise null so the caller falls back to the through-backend path.
//
// CANVAS/CORS guard: editor_preview is the purpose the Fabric canvas loads with
// crossOrigin="anonymous". A 302 to a private R2 origin without a bucket CORS
// rule for the app origin makes the browser reject the image so the canvas
// can't render. We therefore NEVER redirect editor_preview requests — they stay
// through-backend even when presigned delivery is opted in. Other purposes
// (thumbnail, original, export, ai_output) can use presigned delivery.
//
// Egress/abuse parity (do not regress the egress work): the object's bytes WILL
// be served from R2, so we still reserve the asset's known byte size against the
// abuse window and record egress before redirecting — using the asset record's
// sizeBytes (or a derivative size) since the backend never buffers the payload.
// If accounting rejects the read we do NOT redirect (surface its response). The
// presign TTL bounds how long the URL is usable; the redirect itself is marked
// no-store so a CDN never caches the short-lived signed URL.
//
// Egress-accounting tradeoff: the presigned URL can be re-fetched from R2 until
// its TTL expires without hitting the backend, so the egress/abuse counters here
// record the object ONCE per redirect and become an approximation (not byte-exact)
// while presigned delivery is enabled. The short presign TTL bounds the drift.
async function tryPresignedR2Redirect(
	c: Context,
	options: {
		projectId: string;
		imageId: string;
		access: AssetAccessGuardResult;
		kind: "image" | "derivative";
		objectId: string;
		bytes: number;
		cacheHit?: boolean;
	},
): Promise<Response | null> {
	if (!presignedR2DeliveryEnabled()) return null;

	const { projectId, imageId, access, kind, objectId, bytes } = options;
	// Keep canvas/editor-preview delivery through-backend (CORS guard above).
	if (access.purpose === "editor_preview") return null;
	// TTL the presigned URL no longer than the asset token (when one bounds the
	// request) so direct delivery cannot outlive the authorization that issued it.
	const now = Math.floor(Date.now() / 1000);
	const tokenTtlRemaining = access.tokenRequired && access.tokenAccepted && access.tokenExpiresAt
		? Math.max(1, access.tokenExpiresAt - now)
		: undefined;

	let delivery: PresignedR2Delivery | undefined;
	try {
		delivery = resolvePresignedR2Delivery({
			ttlSeconds: tokenTtlRemaining,
			presign: (expiresInSeconds) => objectStorage.presignProjectObject({
				projectId,
				objectId,
				kind,
				expiresInSeconds,
			}),
		});
	} catch (error) {
		console.warn("[images] presigned R2 delivery resolution failed; falling back to through-backend", {
			projectId,
			imageId,
			kind,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
	if (!delivery) return null;

	// Reserve the bytes R2 is about to serve against the abuse window (same gate
	// as the streaming path) so concurrent presign redirects cannot collectively
	// overshoot the throttle threshold.
	const throttleError = await reserveEgressForReadOrResponse(c, projectId, bytes, "asset_read");
	if (throttleError) return throttleError;
	const recordError = await recordEgressWithAllowanceOrResponse(c, {
		projectId,
		imageId,
		purpose: access.purpose,
		bytes,
		statusCode: 302,
		cacheHit: options.cacheHit,
		tokenRequired: access.tokenRequired,
		tokenAccepted: access.tokenAccepted,
		skipAbuseReservation: true,
	});
	if (recordError) {
		// Not redirecting (cap rejected the read): roll back the abuse reservation.
		await releaseEgressReservationBestEffort(projectId, bytes);
		return recordError;
	}

	// 302 to the short-lived presigned URL. no-store so neither browser nor CDN
	// caches the signed URL itself (it expires); the redirect target carries the
	// object's own cache semantics from R2.
	return new Response(null, {
		status: 302,
		headers: {
			Location: delivery.url,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"X-Asset-Delivery-Mode": "presigned_r2",
			"X-Asset-Egress-Bytes": String(bytes),
		},
	});
}

function readPositiveIntegerMetadata(metadata: Record<string, unknown> | undefined, key: string): number | null {
	const value = metadata?.[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : null;
}

function shouldCountActiveReservation(
	reservation: StorageQuotaReservation,
	anchor: Pick<StorageQuotaReservation, "createdAt" | "reservationId"> | undefined,
): boolean {
	if (!anchor) return true;
	if (reservation.createdAt < anchor.createdAt) return true;
	if (reservation.createdAt > anchor.createdAt) return false;
	return reservation.reservationId <= anchor.reservationId;
}

function countReservedImages(reservation: StorageQuotaReservation): number {
	// Cleaned-import reservations REPLACE existing pages: their bytes count
	// against the chapter byte cap, but they add no new page images — counting
	// fileCount would project a 300-page chapter as 600 images (codex P2).
	if ((reservation.metadata as Record<string, unknown> | undefined)?.replacesExistingPages === true) return 0;
	return readPositiveIntegerMetadata(reservation.metadata, "fileCount") ?? 1;
}

function countReservedOriginalBytes(reservation: StorageQuotaReservation): number {
	return readPositiveIntegerMetadata(reservation.metadata, "chapterOriginalBytes") ?? reservation.bytes;
}

async function summarizeChapterOriginalUsage(projectId: string, options: ChapterUploadLimitOptions = {}): Promise<ChapterOriginalUsage> {
	const originalAssets = (await listAssetRecordsAuthoritative(projectId)).filter((asset) => asset.uploadedBy?.source !== "ai_job");
	// Cleaned-background imports REPLACE existing pages (codex P2): their bytes
	// count toward the chapter byte cap, but they must not inflate the page-image
	// COUNT — otherwise one roundtrip makes a 300-page chapter look like 600
	// images and blocks the next import/upload.
	const isReplacementBackground = (asset: (typeof originalAssets)[number]) =>
		(asset.metadata as Record<string, unknown> | undefined)?.assetKind === "cleaned-background";
	const imageIds = new Set(originalAssets.filter((asset) => !isReplacementBackground(asset)).map((asset) => asset.imageId));
	const state = await resolveProjectState(projectId);
	if (state) {
		for (const page of state.pages ?? []) {
			if (page.imageId && !page.imageId.startsWith("result_")) imageIds.add(page.imageId);
		}
	}
	let reservedImageCount = 0;
	let reservedOriginalBytes = 0;
	if (options.includeActiveReservations) {
		const activeReservations = (await listActiveProjectStorageQuotaReservations(projectId))
			.filter((reservation) => reservation.reason === "image_upload")
			.filter((reservation) => shouldCountActiveReservation(reservation, options.reservationAnchor));
		reservedImageCount = activeReservations.reduce((total, reservation) => total + countReservedImages(reservation), 0);
		reservedOriginalBytes = activeReservations.reduce((total, reservation) => total + countReservedOriginalBytes(reservation), 0);
	}
	const persistedImageCount = imageIds.size;
	const persistedOriginalBytes = originalAssets.reduce((total, asset) => total + asset.sizeBytes, 0);
	return {
		imageCount: persistedImageCount + reservedImageCount,
		originalBytes: persistedOriginalBytes + reservedOriginalBytes,
		persistedImageCount,
		persistedOriginalBytes,
		reservedImageCount,
		reservedOriginalBytes,
	};
}

export async function assertChapterUploadLimit(
	c: Context,
	projectId: string,
	pendingImages: number,
	pendingBytes: number,
	options: ChapterUploadLimitOptions = {},
): Promise<Response | null> {
	const usage = await summarizeChapterOriginalUsage(projectId, options);
	const attemptedImages = usage.imageCount + pendingImages;
	if (attemptedImages > serverConfig.maxImagesPerChapter) {
		return c.json({
			error: "Chapter image limit exceeded",
			code: "chapter_image_limit_exceeded",
			reason: "max_images_per_chapter",
			limitImages: serverConfig.maxImagesPerChapter,
			existingImages: usage.imageCount,
			attemptedImages: pendingImages,
			projectedImages: attemptedImages,
			persistedImages: usage.persistedImageCount,
			reservedImages: usage.reservedImageCount,
		}, 413);
	}

	const attemptedBytes = usage.originalBytes + pendingBytes;
	if (attemptedBytes > serverConfig.maxChapterOriginalBytes) {
		return c.json({
			error: "Chapter original image storage limit exceeded",
			code: "chapter_original_bytes_limit_exceeded",
			reason: "max_chapter_original_bytes",
			limitBytes: serverConfig.maxChapterOriginalBytes,
			existingBytes: usage.originalBytes,
			attemptedBytes: pendingBytes,
			projectedBytes: attemptedBytes,
			persistedBytes: usage.persistedOriginalBytes,
			reservedBytes: usage.reservedOriginalBytes,
		}, 413);
	}

	return null;
}

// Upload images to project
images.post("/:projectId/upload", async (c) => {
	const projectId = c.req.param("projectId");

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}

	// Check project ownership
	const ownershipError = await checkProjectOwnership(c, projectId, "update:project");
	if (ownershipError) return ownershipError;

	// Ownership above resolved the project catalog-authoritatively (resolveProjectState
	// honors the Postgres catalog), so a catalog-backed project with no local directory
	// is valid and must be allowed to upload through the object-storage/CoW write path.
	// File mode already 404s in checkProjectOwnership when state.json is absent, so a
	// stale-dir 404 here is unnecessary; just ensure the local images dir exists.
	ensureUploadProjectDir(projectId);

	const parsedForm = await parseUploadFormData(c);
	if (parsedForm.error) return parsedForm.error;
	const formData = parsedForm.formData;
	const files = formData.getAll("images") as File[];

	// Phase A/B non-destructive edits — a `metadata` form field may tag the upload's
	// asset kind (image-edit-mask / image-edit-patch). Those are TINY ROI assets (a
	// painted/healed/cloned region or an alpha mask), legitimately far below the page
	// min-dimension floor, so they must be EXEMPT from the 64×64 min-size guard. Parse
	// it best-effort; an unparseable/absent field falls back to the page-image path.
	let uploadAssetKind: string | undefined;
	let uploadPageImageId: string | undefined;
	let uploadEditLayerId: string | undefined;
	let uploadPageIndex: number | undefined;
	const rawMetadata = formData.get("metadata");
	if (typeof rawMetadata === "string" && rawMetadata.length > 0 && rawMetadata.length < 10_000) {
		try {
			const parsed = JSON.parse(rawMetadata) as Record<string, unknown>;
			if (typeof parsed.assetKind === "string") uploadAssetKind = parsed.assetKind;
			if (typeof parsed.pageImageId === "string") uploadPageImageId = parsed.pageImageId.trim();
			if (typeof parsed.editLayerId === "string") uploadEditLayerId = parsed.editLayerId.trim();
			if (typeof parsed.pageIndex === "number" && Number.isInteger(parsed.pageIndex) && parsed.pageIndex >= 0) {
				uploadPageIndex = parsed.pageIndex;
			}
		} catch {
			/* ignore malformed metadata — treat as a normal page-image upload */
		}
	}
	// codex #392 P2 — the min-size floor exemption must NOT be granted on client-controlled
	// `metadata.assetKind` alone (a normal page upload could forge it to smuggle a sub-64px
	// page image past the floor). Corroborate the client hint against the AUTHORITATIVE
	// project state: a real edit-layer asset always composites over an EXISTING page image,
	// so the upload must reference a `pageImageId` that resolves to a page in the server's
	// resolved state. A forged page upload with no/unknown pageImageId fails this check and
	// stays subject to the 64×64 floor. (The pixel CEILING/bytes/quota/moderation gates run
	// for every upload regardless, so this is the only client-trusted path being hardened.)
	let isEditLayerAsset = false;
	// Phase D — server-side edit-asset provenance persisted on the AssetRecord
	// (`metadata.assetKind` + `pageImageId` + `editLayerId` + `pageIndex`). Tagging the
	// row authoritatively (not just the transient min-size exemption) is what makes the
	// orphaned-edit-asset GC sweep (cron-scheduler) PRECISE — it can find candidate edit
	// assets by `metadata.assetKind` instead of scanning every asset. Only set when the
	// upload is a corroborated edit-layer asset, so a forged tag never lands on the record.
	let editAssetMetadata: Record<string, unknown> | undefined;
	if (
		(uploadAssetKind === "image-edit-mask" ||
			uploadAssetKind === "image-edit-patch" ||
			uploadAssetKind === "image-edit-cache") &&
		uploadPageImageId
	) {
		const editAssetState = await resolveProjectState(projectId);
		const resolvedPageIndex = editAssetState
			? resolveProjectImagePageIndex(editAssetState, uploadPageImageId)
			: undefined;
		if (resolvedPageIndex !== undefined) {
			// The min-size floor exemption only applies to the tiny ROI kinds; an
			// `image-edit-cache` (a flatten cache) is page-sized so it stays subject to
			// the floor, but it is still tagged for GC observability.
			isEditLayerAsset = uploadAssetKind === "image-edit-mask" || uploadAssetKind === "image-edit-patch";
			editAssetMetadata = {
				assetKind: uploadAssetKind,
				pageImageId: uploadPageImageId,
				pageIndex: uploadPageIndex ?? resolvedPageIndex,
				...(uploadEditLayerId ? { editLayerId: uploadEditLayerId } : {}),
			};
		}
	}

	if (files.length === 0) {
		return c.json({ error: "No images provided" }, 400);
	}

	if (files.length > serverConfig.maxImagesPerUpload) {
		return c.json({ error: `Too many images (max ${serverConfig.maxImagesPerUpload})` }, 400);
	}

	const maxSize = serverConfig.maxUploadSize * 1024 * 1024;
	const candidates: UploadCandidate[] = [];
	let pendingBytes = 0;

	for (const file of files) {
		const safeName = sanitizeFilename(file.name);
		if (file.size > maxSize) {
			return c.json({ error: `File ${safeName} exceeds ${serverConfig.maxUploadSize}MB limit` }, 413);
		}

		const ext = file.name.split(".").pop()?.toLowerCase() || "png";
		if (!ALLOWED_EXTENSIONS.has(ext)) {
			return c.json({ error: `File type .${ext} not allowed` }, 400);
		}

		candidates.push({ file, ext, safeName, sizeBytes: file.size });
		pendingBytes += file.size;
	}

	if (pendingBytes > serverConfig.maxUploadBatchSizeBytes) {
		return c.json({
			error: "Upload batch size limit exceeded",
			code: "upload_batch_size_exceeded",
			reason: "max_upload_batch_size",
			limitBytes: serverConfig.maxUploadBatchSizeBytes,
			attemptedBytes: pendingBytes,
		}, 413);
	}

	const chapterLimitError = await assertChapterUploadLimit(c, projectId, candidates.length, pendingBytes);
	if (chapterLimitError) return chapterLimitError;

	const preparedCandidates: PreparedUploadCandidate[] = [];
	let preparedPendingBytes = 0;
	for (const candidate of candidates) {
		const imageBuffer = Buffer.from(await candidate.file.arrayBuffer());
		// S3: the recorded/metered size MUST be the server-decoded buffer length, not
		// the client-supplied multipart `file.size` (which a client can spoof). The
		// `file.size` pre-check above is only a cheap fast-reject before buffering; now
		// that we hold the real bytes, re-validate the decoded length against the same
		// ceiling so a lying small `file.size` can't smuggle an oversize payload past.
		const measuredBytes = measureUploadedImageBytes(imageBuffer);
		if (measuredBytes > maxSize) {
			return c.json({ error: `File ${candidate.safeName} exceeds ${serverConfig.maxUploadSize}MB limit` }, 413);
		}
		let dimensions: { width: number; height: number };
		try {
			dimensions = await validateUploadedImageBuffer(imageBuffer, candidate.safeName);
		} catch (error) {
			if (error instanceof UploadedImageTooLargeError) {
				const ceiling = getUploadImagePixelCeiling();
				return c.json({
					error: "Uploaded image exceeds the maximum accepted dimensions",
					code: "image_dimensions_too_large",
					filename: candidate.safeName,
					width: error.width,
					height: error.height,
					maxWidth: ceiling.maxWidth,
					maxHeight: ceiling.maxHeight,
					maxMegapixels: Math.round(ceiling.maxPixels / 1_000_000),
				}, 413);
			}
			if (error instanceof UploadedImageDecodeError) {
				return c.json({
					error: "Uploaded image is not decodable",
					code: "image_not_decodable",
					filename: candidate.safeName,
				}, 422);
			}
			throw error;
		}
		// Non-destructive edit-layer ROI assets (mask/patch) are intentionally tiny — a
		// bubble interior, a healed spot, a clone footprint — so they are exempt from the
		// page-image min-dimension floor. The pixel CEILING (validateUploadedImageBuffer)
		// still applies, so a huge ROI can't slip through.
		if (!isEditLayerAsset && (dimensions.width < serverConfig.minUploadImageWidth || dimensions.height < serverConfig.minUploadImageHeight)) {
			return c.json({
				error: "Uploaded image is below the minimum accepted dimensions",
				code: "image_dimensions_too_small",
				filename: candidate.safeName,
				width: dimensions.width,
				height: dimensions.height,
				minWidth: serverConfig.minUploadImageWidth,
				minHeight: serverConfig.minUploadImageHeight,
			}, 422);
		}
		// Persist the server-measured byte length as the canonical sizeBytes (S3) so
		// recordUploadedAsset and the usage gate sum decoded bytes, matching the CoW
		// ledger which already charges input.buffer.byteLength.
		preparedCandidates.push({ ...candidate, imageBuffer, sizeBytes: measuredBytes });
		preparedPendingBytes += measuredBytes;
	}

	return commitPreparedUploadCandidates(
		c,
		projectId,
		preparedCandidates,
		preparedPendingBytes,
		editAssetMetadata,
		resolvePageSetUploadChangeMode(uploadAssetKind),
	);
});

// Shared commit phase for image uploads: usage allowance -> storage reservation
// -> chapter limit recheck -> object put + asset record + audit -> usage record.
// Both the raw /upload route and the /upload-transform (merge/split) route funnel
// through here so reservation/rollback/limit/quota behavior stays identical. The
// caller is responsible for any decode/dimension/transform validation and for
// computing pendingBytes from the final (post-transform) buffers.
async function commitPreparedUploadCandidates(
	c: Context,
	projectId: string,
	preparedCandidates: PreparedUploadCandidate[],
	pendingBytes: number,
	// Phase D — when the upload is a corroborated non-destructive edit-layer asset, its
	// provenance (assetKind / pageImageId / pageIndex / editLayerId) is persisted on EVERY
	// resulting AssetRecord so the orphaned-edit-asset GC sweep can find it by metadata.
	// Absent for ordinary page/transform uploads.
	editAssetMetadata?: Record<string, unknown>,
	pageSetChangeMode: PageSetUploadChangeMode = "add",
): Promise<Response> {
	const fileCount = preparedCandidates.length;
	const uploadUsageSubjectId = `upload:${uuid()}`;
	const cowVersionIds: string[] = [];
	try {
		await assertUploadUsageAllowance({
			projectId,
			subjectId: uploadUsageSubjectId,
			bytes: pendingBytes,
			metadata: { fileCount },
		});
	} catch (error) {
		if (error instanceof UsageQuotaExceededError) {
			usageQuotaRejections.inc({ reason: error.reason });
			return c.json({
				error: "Workspace usage quota exceeded",
				code: error.code,
				reason: error.reason,
				attempted: error.attempted,
				usage: error.summary,
			}, 402);
		}
		throw error;
	}

	const imageIds: string[] = [];
	const assets: AssetRecord[] = [];
	const user = getAuthUser(c) as JWTPayload | undefined;
	const uploadedBy = buildUploadActor(user);
	// Both callers (raw /upload and /upload-transform) have already verified the
	// project dir exists and resolved ownership; load the authoritative state here
	// so the CoW account / workspace binding is identical across both entry points.
	// Catalog-authoritative, tombstone-aware: under Postgres the catalog row wins;
	// refuse to commit an upload to a permanently-deleted project even if a stale
	// state.json survived a partial delete.
	const projectState = await resolveProjectState(projectId);
	if (!projectState) {
		return c.json({ error: "Project not found" }, 404);
	}
	const cowAccount = resolveCowAccount(projectState, user);
	// CoW is only engaged when there is a real account to charge. A truly
	// anonymous legacy project (cowAccount === null) records the asset/object but
	// skips the byte ledger, so the upload path below treats it like the
	// pre-CoW driver (writes projects/<id>/images/<id> directly).
	const cowService = cowAccount && storageCowActive() ? getSharedStorageCowService() : undefined;
	const workspaceId = projectState.workspaceId?.trim() || projectId;
	const requestMeta = {
		ip: getClientIp(c),
		userAgent: c.req.header("user-agent") ?? undefined,
	};

	let storageReservation: StorageQuotaReservation | undefined;
	try {
		const result = await reserveProjectStorageQuota({
			projectId,
			bytes: pendingBytes,
			reason: "image_upload",
			metadata: {
				fileCount,
				chapterOriginalBytes: pendingBytes,
				uploadUsageSubjectId,
			},
		});
		storageReservation = result.reservation;
	} catch (error) {
		if (error instanceof StorageQuotaExceededError) {
			return c.json({
				error: "Storage quota exceeded",
				code: "storage_quota_exceeded",
				reason: error.reason,
				attemptedBytes: error.attemptedBytes,
				quota: await summarizeProjectStorageQuotaForProjectView(projectId, error.attemptedBytes),
			}, 413);
		}
		throw error;
	}
	if (!storageReservation) {
		throw new Error("Storage quota reservation was not created");
	}

	const reservedChapterLimitError = await assertChapterUploadLimit(c, projectId, 0, 0, {
		includeActiveReservations: true,
		reservationAnchor: storageReservation,
	});
	if (reservedChapterLimitError) {
		await releaseProjectStorageQuotaReservationBestEffort(projectId, storageReservation.reservationId, {
			reason: "image_upload",
			phase: "chapter_limit_rejected",
		});
		return reservedChapterLimitError;
	}

	let uploadUsage: UploadUsageRecordResult;
	try {
		for (const candidate of preparedCandidates) {
			const { ext, safeName, sizeBytes, imageBuffer } = candidate;
			const imageId = `${uuid()}.${ext}`;
			const assetRecordId = uuid();
			const sha256 = createSha256(imageBuffer);
			const storedObject = cowService
				? {
					driver: objectStorage.driver,
					key: `content/${sha256}`,
				}
				: await objectStorage.putProjectImage({
					projectId,
					imageId,
					buffer: imageBuffer,
				});
			imageIds.push(imageId);
			// Honor an explicit MIME carried by synthetic/transformed candidates
			// (e.g. keep-mode bulk import preserving a source JPG/WebP) before
			// falling back to the imageId extension or the source File type.
			const mimeType = candidate.mimeType || MIME_MAP[ext] || candidate.file?.type || "application/octet-stream";
			// MANDATORY known-CSAM-hash denylist (TRI-STATE, fail-closed): a sha that
			// previously produced a mandatory block is hard-blocked on re-upload BEFORE
			// any provider / local-pass path, and BEFORE honoring the soft kill switch.
			// A lookup FAILURE (DB down) does NOT proceed as "not denylisted": an exact
			// known-bad re-upload must never depend on provider rediscovery, so it is
			// held for review (fail-closed) below.
			const denylist = await lookupKnownBlockedSha256(sha256);
			if (denylist === "blocked") {
				await objectStorage.deleteProjectImage({ projectId, imageId });
				throw new UploadModerationBlockedError(imageId, buildKnownBlockedShaAssetResult(sha256));
			}
			// MANDATORY CSAM screen runs in BOTH soft-on and soft-off modes, ignoring
			// OPENAI_MODERATION_FAIL_OPEN. When soft policy is OFF this is the ONLY
			// provider screen, but it still fails closed (no provider in production =>
			// needs_review). When soft policy is ON the soft provider verdict is layered
			// on top (worse-of), so a fail-open soft pass can never relax the mandatory
			// floor. A denylist lookup error holds the asset for review (fail-closed).
			const assetModeration = denylist === "lookup-error"
				? buildDenylistLookupFailClosedResult()
				: await (async () => {
					const mandatory = await mandatoryCsamScreenBuffer(imageBuffer, mimeType, workspaceId, {
						assetId: imageId,
						sha256,
						ipAddress: requestMeta.ip,
						userAgent: requestMeta.userAgent,
					});
					if (mandatory.status === "blocked") {
						await objectStorage.deleteProjectImage({ projectId, imageId });
						throw new UploadModerationBlockedError(imageId, mandatory);
					}
					if (!imageModerationEnabled()) return mandatory;
					// Soft policy ON: layer the soft provider verdict (which may apply
					// fail-open to SOFT categories only) and take the worse-of.
					const moderationUrl = await buildModerationImageUrl(c, storedObject, imageBuffer, mimeType);
					const soft = toAssetModerationResult(await moderateImage(moderationUrl, workspaceId, {
						assetId: imageId,
						sha256,
						ipAddress: requestMeta.ip,
						userAgent: requestMeta.userAgent,
					}));
					if (soft.status === "blocked") {
						await objectStorage.deleteProjectImage({ projectId, imageId });
						throw new UploadModerationBlockedError(imageId, soft);
					}
					return worseUploadModeration(mandatory, soft);
				})();
			// TILE MODERATION: a long webtoon page is screened as ONE downscaled
			// overview above, which can dilute a small unsafe region below threshold on
			// a very tall page. Execute the planned moderation tiles against the
			// full-resolution source and aggregate fail-closed (any blocked tile →
			// block; any needs_review tile → needs_review). This only fans out for tall
			// pages whose plan actually contains tiles; short pages return the overview
			// verdict unchanged. Runs in BOTH soft-on and soft-off modes: in soft-off
			// mode each tile is screened by the MANDATORY CSAM screen (moderateImageBuffer
			// routes every tile through it), so no tall webtoon region is left unscreened.
			// Skipped only when the asset is already hard-blocked or held by a denylist
			// lookup error.
			const tiledModeration = (assetModeration.status !== "blocked" && denylist !== "lookup-error")
				? await (async () => {
					// validateUploadedImageBuffer already proved this buffer decodes with a
					// bounded pixel count, so re-reading the header here is cheap and safe.
					const { width, height } = await validateUploadedImageBuffer(imageBuffer, safeName);
					const tilePlan = buildModerationDerivativePlan({ width, height });
					return executeModerationTilePlan(imageBuffer, mimeType, tilePlan, assetModeration, {
						workspaceId,
						assetId: imageId,
						ipAddress: requestMeta.ip,
						userAgent: requestMeta.userAgent,
					});
				})()
				: assetModeration;
			if (tiledModeration.status === "blocked") {
				await objectStorage.deleteProjectImage({ projectId, imageId });
				throw new UploadModerationBlockedError(imageId, tiledModeration);
			}
			// RECORD-BEFORE-BLOB (FK ordering — latent P1, proven on real PG):
			// asset_versions.asset_id is an IMMEDIATE FK to asset_records(id)
			// (cow-fk-ordering.real-pg.test.ts), so writeBlob's version insert
			// REQUIRES the record row to exist — the old blob-before-row order
			// 500'd every upload the moment Storage CoW was enabled. Order is now
			// record → version (same as the cleaned-import path), with full
			// compensation below: if writeBlob fails, the record's stray versions
			// are released through deleteVersion (refcount/quota accounting — a
			// bare record delete would CASCADE them away silently) and the record
			// is removed, so no servable row points at a blob that never landed.
			// This still runs only after moderation passed (a block throws above).
			const recordedAsset = await recordUploadedAsset({
				projectId,
				workspaceId,
				imageId,
				assetRecordId,
				originalName: safeName,
				imageBuffer,
				storedObject,
				mimeType,
				sizeBytes,
				uploadedBy,
				request: requestMeta,
				moderation: tiledModeration,
				// CoW: the row must exist before writeBlob (immediate FK) but must
				// not be SERVABLE until the blob landed — held quarantined here, then
				// released by the finalize below, which runs after writeBlob. A crash
				// in between leaves only a non-servable orphan row, never a released
				// record pointing at missing content (b14 r1).
				holdStorageStatus: Boolean(cowService && cowAccount),
				metadata: {
					storageReservationId: storageReservation.reservationId,
					...editAssetMetadata,
				},
			});
			if (cowService && cowAccount) {
				try {
					const cowWrite = await cowService.writeBlob({
						buffer: imageBuffer,
						mimeType,
						accountKind: cowAccount.kind,
						accountId: cowAccount.id,
						requesterUserId: cowAccount.requesterUserId,
						assetId: assetRecordId,
					});
					cowVersionIds.push(cowWrite.version_id);
				} catch (error) {
					// writeBlob can throw AFTER its ledger txn committed (post-commit
					// object write): version_id never reached us. Sweep the record's
					// versions through deleteVersion FIRST (accounting), then drop the
					// record (mirrors export.ts cleaned-import compensation).
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
								});
							}
						}
					} catch {
						// best-effort sweep; the upload still fails below
					}
					await removeAssetRecordAuthoritative(projectId, imageId).catch(() => undefined);
					throw error;
				}
			}
			const finalizedAsset = await updateAssetModerationAuthoritative(projectId, imageId, tiledModeration, storageStatusForModeration(tiledModeration));
			assets.push(finalizedAsset ?? recordedAsset);
		}

		uploadUsage = await recordUploadUsage({
			projectId,
			subjectId: uploadUsageSubjectId,
			bytes: pendingBytes,
			metadata: {
				imageIds,
				fileCount,
			},
		});
		} catch (error) {
			if (error instanceof QuotaFrozenError) {
				if (storageReservation) {
					await releaseProjectStorageQuotaReservationBestEffort(projectId, storageReservation.reservationId, {
						reason: "image_upload",
						phase: "cow_quota_rejected",
					});
				}
				if (cowService) {
					for (const versionId of cowVersionIds.reverse()) {
						await cowService.deleteVersion({ versionId, deleterUserId: user?.userId, skipAuthorizationForSystemCleanup: true });
					}
				}
				await cleanupUncommittedUploadObjects(projectId, imageIds);
				return quotaFrozenResponse(c, error);
			}
			if (storageReservation) {
				await releaseProjectStorageQuotaReservationBestEffort(projectId, storageReservation.reservationId, {
					reason: "image_upload",
					phase: "rollback",
				});
			}
			if (cowService) {
				for (const versionId of cowVersionIds.reverse()) {
					await cowService.deleteVersion({ versionId, deleterUserId: user?.userId, skipAuthorizationForSystemCleanup: true });
				}
			}
			await cleanupUncommittedUploadObjects(projectId, imageIds);
			if (error instanceof UploadModerationBlockedError) {
				return c.json({
					error: "Uploaded image blocked by moderation",
					code: error.result.status === "csam_block" ? "csam_block" : "moderation_blocked",
					imageId: error.imageId,
					moderation: error.result,
				}, 403);
			}
			throw error;
		}

	await releaseProjectStorageQuotaReservationBestEffort(projectId, storageReservation.reservationId, {
		reason: "image_upload",
		phase: "after_commit",
	});

	// Deliberately NO page_set_changed emit here (review #594 P2): asset upload
	// is only the FIRST half of a page add/replace — the page set commits when
	// the client persists ProjectState via /save, and THAT path emits after the
	// committed imageId sequence actually changed. Emitting here announced a
	// change collaborators could not yet see (and would lose if the save failed).
	// The cleaned-import route still emits itself: it commits state server-side.

	return c.json({
		imageIds,
		assets: assets.map(serializeAssetSummary),
		storageQuota: await summarizeProjectStorageQuotaForProjectView(projectId),
		storageReservation: {
			reservationId: storageReservation.reservationId,
			status: "captured",
			bytes: storageReservation.bytes,
			expiresAt: new Date(storageReservation.expiresAt).toISOString(),
		},
		usage: uploadUsage.summary,
	});
}

// Wave 3 W3.16: bulk import with server-side merge/split.
//
// Accepts a multipart form with `images` (the ordered source files) plus a
// `mode` of keep | merge | split. For merge the form may carry `perPage`
// (clamped 2..50); for split it may carry `splitThreshold` (px, floored 256).
// An optional `order` JSON array of source indices reorders the inputs before
// transform so the client's reorderable preview strip is authoritative.
//
// The transform runs entirely on buffers (see image-merge-split.ts), then the
// resulting page buffers are decoded/dimension-validated, SHA-deduped, and
// committed through the SAME pipeline as a raw upload (commitPreparedUploadCandidates),
// so storage quota / chapter limits / usage / audit behave identically.
const UPLOAD_TRANSFORM_MODES = new Set(["keep", "merge", "split"]);

function parseOptionalOrder(value: string | undefined, length: number): number[] | null {
	if (!value) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length !== length) return null;
	const seen = new Set<number>();
	for (const entry of parsed) {
		if (!Number.isInteger(entry) || entry < 0 || entry >= length || seen.has(entry)) return null;
		seen.add(entry);
	}
	return parsed as number[];
}

function stripExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

images.post("/:projectId/upload-transform", async (c) => {
	const projectId = c.req.param("projectId");

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}

	const ownershipError = await checkProjectOwnership(c, projectId, "update:project");
	if (ownershipError) return ownershipError;

	// Catalog-aware: a Postgres-authoritative project with no local dir is valid (see
	// the /upload route). ensureUploadProjectDir creates the local images dir; the
	// object-storage/CoW write path does not require a pre-existing project directory.
	ensureUploadProjectDir(projectId);

	const parsedForm = await parseUploadFormData(c);
	if (parsedForm.error) return parsedForm.error;
	const formData = parsedForm.formData;
	const files = formData.getAll("images") as File[];
	const mode = (formData.get("mode") as string | null)?.trim() || "keep";
	if (!UPLOAD_TRANSFORM_MODES.has(mode)) {
		return c.json({ error: "Invalid transform mode", code: "invalid_transform_mode" }, 400);
	}

	// KEEP-mode batch idempotency (codex P1, PR #439 R2): the client may RETRY a batch
	// whose commit already succeeded server-side but whose response was lost
	// (XHR onerror/ontimeout). It re-sends the SAME `Idempotency-Key`; replay the
	// original committed result so the retry creates NO duplicate assets and orphans
	// nothing. Only keep-mode is batched/retried this way; merge/split are whole-request
	// (reload-on-failure), so they intentionally ignore the key. An invalid/oversized key
	// is treated as "no key" (best-effort) rather than failing an otherwise-valid upload.
	const batchKeyHeader = c.req.header("Idempotency-Key")?.trim();
	const batchKey = mode === "keep" && isValidUploadBatchKey(batchKeyHeader) ? batchKeyHeader : undefined;
	if (batchKey) {
		const cached = await uploadBatchIdempotencyStore.get(projectId, batchKey);
		if (cached) {
			return c.json(cached.body as Record<string, unknown>, cached.status as 200);
		}
	}

	if (files.length === 0) {
		return c.json({ error: "No images provided" }, 400);
	}
	if (files.length > serverConfig.maxImagesPerUpload) {
		return c.json({ error: `Too many images (max ${serverConfig.maxImagesPerUpload})` }, 400);
	}

	const order = parseOptionalOrder(formData.get("order") as string | null ?? undefined, files.length);
	if ((formData.get("order") as string | null) && !order) {
		return c.json({ error: "Invalid reorder spec", code: "invalid_order" }, 400);
	}
	const orderedFiles = order ? order.map((index) => files[index]) : files;

	// Accumulate the declared sizes of the WHOLE batch before reading any bytes
	// into memory, mirroring the raw-upload path: a folder that is individually
	// allowed but collectively over the batch cap must 413 before we buffer and
	// decode (potentially hundreds of MB of) source images.
	const maxSize = serverConfig.maxUploadSize * 1024 * 1024;
	let sourceBytes = 0;
	for (const file of orderedFiles) {
		if (!file) {
			return c.json({ error: "Invalid reorder spec", code: "invalid_order" }, 400);
		}
		if (file.size > maxSize) {
			return c.json({ error: `File ${sanitizeFilename(file.name)} exceeds ${serverConfig.maxUploadSize}MB limit` }, 413);
		}
		sourceBytes += file.size;
	}
	if (sourceBytes > serverConfig.maxUploadBatchSizeBytes) {
		return c.json({
			error: "Upload batch size limit exceeded",
			code: "upload_batch_size_exceeded",
			reason: "max_upload_batch_size",
			limitBytes: serverConfig.maxUploadBatchSizeBytes,
			attemptedBytes: sourceBytes,
		}, 413);
	}

	// Decode + ext/size-validate every SOURCE file now that the batch cap has
	// passed (cheap reject before we allocate transform buffers).
	//
	// For mode=split the SOURCE is EXPECTED to be one very long webtoon strip that
	// will be sliced into per-page chunks, so it is admitted against the looser
	// SPLIT-SOURCE ceiling (taller height + higher MP, but still bomb-guarded by
	// the MP cap). Every produced chunk is re-validated below against the normal
	// per-page ceiling, so a tall source never yields oversized pages. merge/keep
	// sources are validated against the normal per-page ceiling.
	const sourceCeiling = mode === "split" ? getSplitSourcePixelCeiling() : getUploadImagePixelCeiling();
	const sources: Array<{ buffer: Buffer; safeName: string; ext: string }> = [];
	for (const file of orderedFiles) {
		const safeName = sanitizeFilename(file!.name);
		const ext = file!.name.split(".").pop()?.toLowerCase() || "png";
		if (!ALLOWED_EXTENSIONS.has(ext)) {
			return c.json({ error: `File type .${ext} not allowed` }, 400);
		}
		const buffer = Buffer.from(await file!.arrayBuffer());
		try {
			await validateUploadedImageBuffer(buffer, safeName, sourceCeiling);
		} catch (error) {
			if (error instanceof UploadedImageTooLargeError) {
				const ceiling = sourceCeiling;
				return c.json({
					error: "Uploaded image exceeds the maximum accepted dimensions",
					code: "image_dimensions_too_large",
					filename: safeName,
					width: error.width,
					height: error.height,
					maxWidth: ceiling.maxWidth,
					maxHeight: ceiling.maxHeight,
					maxMegapixels: Math.round(ceiling.maxPixels / 1_000_000),
				}, 413);
			}
			if (error instanceof UploadedImageDecodeError) {
				return c.json({
					error: "Uploaded image is not decodable",
					code: "image_not_decodable",
					filename: safeName,
				}, 422);
			}
			throw error;
		}
		sources.push({ buffer, safeName, ext });
	}

	// Produce the final page buffers per the chosen transform. Each output keeps a
	// trace of its source filename(s) in originalName for image_records.original_name.
	// merge/split products are always re-encoded to PNG; keep-mode outputs carry the
	// source bytes verbatim, so they preserve the original extension + MIME.
	const outputs: Array<{ buffer: Buffer; originalName: string; ext: string }> = [];
	try {
		if (mode === "merge") {
			const perPage = clampPerPage(Number(formData.get("perPage")));
			const groups = groupForMerge(sources, perPage);
			for (const group of groups) {
				const merged = await mergeImagesVertically(group.map((item) => item.buffer), {
					maxOutputPixels: serverConfig.maxMergeOutputPixels,
				});
				const trace = group.map((item) => stripExtension(item.safeName)).join("+");
				outputs.push({ buffer: merged.buffer, originalName: `${trace}.merged.png`, ext: "png" });
			}
		} else if (mode === "split") {
			const thresholdPx = clampSplitThreshold(
				formData.get("splitThreshold") != null ? Number(formData.get("splitThreshold")) : DEFAULT_TALL_SPLIT_THRESHOLD_PX,
			);
			// Bound the per-chunk decode to the normal PER-PAGE ceiling so a huge
			// client-supplied splitThreshold can't force sharp to decode/encode the
			// WHOLE (split-source-sized) strip in one buffer before per-page output
			// validation rejects it. splitTallImage clamps maxChunkHeight/threshold to
			// this ceiling BEFORE any decode, so the largest single chunk it ever
			// materializes is a per-page-sized image.
			const pageCeiling = getUploadImagePixelCeiling();
			for (const source of sources) {
				const chunks = await splitTallImage(source.buffer, {
					thresholdPx,
					maxChunkHeight: thresholdPx,
					minChunkHeight: serverConfig.minUploadImageHeight,
					pixelCeiling: { maxHeight: pageCeiling.maxHeight, maxPixels: pageCeiling.maxPixels },
				});
				const base = stripExtension(source.safeName);
				const [onlyChunk, ...moreChunks] = chunks;
				if (onlyChunk && moreChunks.length === 0) {
					// Untouched (not tall enough to split): keep source bytes + extension.
					outputs.push({ buffer: source.buffer, originalName: source.safeName, ext: source.ext });
				} else {
					for (const chunk of chunks) {
						outputs.push({
							buffer: chunk.buffer,
							originalName: `${base}.part${String(chunk.chunkIndex + 1).padStart(2, "0")}.png`,
							ext: "png",
						});
					}
				}
			}
		} else {
			// keep: pass sources through unchanged (still committed via the pipeline).
			for (const source of sources) {
				outputs.push({ buffer: source.buffer, originalName: source.safeName, ext: source.ext });
			}
		}
	} catch (error) {
		if (error instanceof ImageTransformError) {
			console.warn("[images] bulk import transform failed", { projectId, mode, error: error.message });
			return c.json({ error: error.message, code: "image_transform_failed", mode }, 422);
		}
		throw error;
	}

	// SHA-dedupe the produced pages ONLY for transform modes (e.g. identical split
	// chunks / repeated merges). keep-as-is promises 1 source = 1 page, so two
	// intentionally identical sources (blank pages, repeated credits, dup SFX) must
	// each yield their own page — never collapse them.
	const dedupe = mode !== "keep";
	const seenSha = new Set<string>();
	const preparedCandidates: PreparedUploadCandidate[] = [];
	let pendingBytes = 0;
	for (const output of outputs) {
		if (dedupe) {
			const sha = createSha256(output.buffer);
			if (seenSha.has(sha)) continue;
			seenSha.add(sha);
		}
		let dimensions: { width: number; height: number };
		try {
			dimensions = await validateUploadedImageBuffer(output.buffer, output.originalName);
		} catch (error) {
			if (error instanceof UploadedImageTooLargeError) {
				const ceiling = getUploadImagePixelCeiling();
				return c.json({
					error: "Transformed image exceeds the maximum accepted dimensions",
					code: "image_dimensions_too_large",
					filename: output.originalName,
					width: error.width,
					height: error.height,
					maxWidth: ceiling.maxWidth,
					maxHeight: ceiling.maxHeight,
					maxMegapixels: Math.round(ceiling.maxPixels / 1_000_000),
				}, 413);
			}
			if (error instanceof UploadedImageDecodeError) {
				return c.json({
					error: "Transformed image is not decodable",
					code: "image_not_decodable",
					filename: output.originalName,
				}, 422);
			}
			throw error;
		}
		if (dimensions.width < serverConfig.minUploadImageWidth || dimensions.height < serverConfig.minUploadImageHeight) {
			return c.json({
				error: "Transformed image is below the minimum accepted dimensions",
				code: "image_dimensions_too_small",
				filename: output.originalName,
				width: dimensions.width,
				height: dimensions.height,
				minWidth: serverConfig.minUploadImageWidth,
				minHeight: serverConfig.minUploadImageHeight,
			}, 422);
		}
		preparedCandidates.push({
			file: undefined as unknown as File,
			ext: output.ext,
			safeName: sanitizeFilename(output.originalName),
			sizeBytes: output.buffer.byteLength,
			imageBuffer: output.buffer,
			mimeType: MIME_MAP[output.ext] || "image/png",
		});
		pendingBytes += output.buffer.byteLength;
	}

	if (preparedCandidates.length === 0) {
		return c.json({ error: "Transform produced no pages", code: "transform_empty" }, 422);
	}
	if (preparedCandidates.length > serverConfig.maxImagesPerUpload) {
		return c.json({ error: `Too many pages produced (max ${serverConfig.maxImagesPerUpload})` }, 400);
	}

	const chapterLimitError = await assertChapterUploadLimit(c, projectId, preparedCandidates.length, pendingBytes);
	if (chapterLimitError) return chapterLimitError;

	// CONCURRENT-COMMIT GUARD (codex P3): the GET-at-top / SET-after-commit window has no
	// in-flight claim, so two requests with the SAME (projectId, batchKey) — a slow first
	// + a client retry, a double-submit, or two requests fanned to the two prod replicas —
	// both miss the cache, both commit, and (keep-mode disables SHA dedupe) DUPLICATE
	// billable assets. We take an atomic claim on (projectId, batchKey), then re-check the
	// durable cache UNDER the claim (a fast winner may have committed + settled since the
	// top-of-route GET). Only the winner commits; a loser polls the cache briefly for the
	// winner's result and replays
	// it (option a — returns a transparent 2xx the upload client already handles), or, if
	// the result hasn't landed in the bounded wait, returns a retryable in-progress signal
	// (option b — the keep client stashes the STABLE batchKey on any non-2xx and re-sends
	// it, replaying once the winner's result is cached → no duplicate/orphan).
	// The ownership TOKEN returned by tryClaim (codex P2): threaded through commit → cache →
	// release so the release is a COMPARE-AND-DELETE that can only free OUR claim, and so a
	// HEARTBEAT can renew it past the claim TTL for a commit slower than that TTL.
	let claimToken: string | null = null;
	if (batchKey) {
		claimToken = await uploadBatchIdempotencyStore.tryClaim(projectId, batchKey);
		if (!claimToken) {
			const replay = await waitForCachedUploadBatchResult(uploadBatchIdempotencyStore, projectId, batchKey);
			if (replay) {
				return c.json(replay.body as Record<string, unknown>, replay.status as 200);
			}
			return c.json(
				{
					error: "An upload for this batch is already in progress",
					code: UPLOAD_BATCH_IN_PROGRESS_CODE,
					retryAfter: UPLOAD_BATCH_IN_PROGRESS_RETRY_AFTER_SECONDS,
				},
				409,
				{ "Retry-After": String(UPLOAD_BATCH_IN_PROGRESS_RETRY_AFTER_SECONDS) },
			);
		}
		// Won the claim — but a PRIOR winner may have committed, cached AND released the
		// claim between the top-of-route GET and this point, so we'd re-claim a settled
		// batch. Re-check the durable result under the claim and replay it (releasing the
		// claim we just took) instead of re-committing → never a duplicate after settle.
		const settled = await uploadBatchIdempotencyStore.get(projectId, batchKey);
		if (settled) {
			await uploadBatchIdempotencyStore.releaseClaim(projectId, batchKey, claimToken).catch(() => {});
			return c.json(settled.body as Record<string, unknown>, settled.status as 200);
		}
	}

	// HEARTBEAT (codex P2): renew the claim at ~TTL/3 around the billable commit so a batch
	// slower than the claim TTL never lets the claim expire mid-commit (which would let a
	// retry win a NEW claim, miss the still-empty result cache, and RE-COMMIT). Started just
	// before the commit, cleared in `finally`. If the claim is LOST out from under us (an
	// external Redis flush — not a normal expiry the heartbeat outruns) the heartbeat logs
	// loudly and stops; the commit still runs to completion and its result-cache set below
	// still lands for a racing retry to replay. That narrow flush-only window is documented.
	const heartbeat =
		batchKey && claimToken
			? startClaimHeartbeat(uploadBatchIdempotencyStore, projectId, batchKey, claimToken)
			: undefined;

	let committed: Response;
	try {
		committed = await commitPreparedUploadCandidates(c, projectId, preparedCandidates, pendingBytes, undefined, "add");
		// Keep the claim heartbeat alive until the durable replay result is cached and the
		// claim is released. Stopping it right after commit leaves a narrow TTL window where
		// a retry can re-claim the same batch before `set()` lands and commit duplicate assets.
		if (batchKey && claimToken) {
			if (committed.status >= 200 && committed.status < 300) {
				try {
					const body = await committed.clone().json();
					await uploadBatchIdempotencyStore.set(projectId, batchKey, { body, status: committed.status });
				} catch (error) {
					console.warn("[images] failed to cache upload-transform idempotency result", {
						projectId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			// Release the in-flight claim on EVERY terminal outcome (compare-and-delete with our
			// token): a 2xx has just been cached (future retries HIT the durable result, never
			// re-commit), and a non-2xx commit is not durable, so the claim must be freed for an
			// immediate genuine retry. The token guard means a stale claim already re-taken by a
			// faster retry (only possible if the heartbeat failed AND the TTL lapsed) is untouched.
			await uploadBatchIdempotencyStore.releaseClaim(projectId, batchKey, claimToken).catch(() => {});
		}
	} catch (error) {
		// A thrown commit (storage/quota infra error) must release the claim so a genuine
		// retry is not locked out for the claim TTL; the TTL still covers a crashed process.
		// Compare-and-delete with our token so a stale claim re-taken by a retry is untouched.
		if (batchKey && claimToken) {
			await uploadBatchIdempotencyStore.releaseClaim(projectId, batchKey, claimToken).catch(() => {});
		}
		throw error;
	} finally {
		heartbeat?.stop();
	}
	return committed;
});

images.get("/:projectId/assets", async (c) => {
	const projectId = c.req.param("projectId");

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}

	const ownershipError = await checkProjectOwnership(c, projectId);
	if (ownershipError) return ownershipError;

	const limit = parseAssetListLimit(c.req.query("limit"));
	if (limit === null) {
		return c.json({ error: "Invalid limit", code: "invalid_limit" }, 400);
	}
	const cursor = c.req.query("cursor");
	if (!isValidAssetListCursor(cursor)) {
		return c.json({ error: "Invalid cursor", code: "invalid_cursor" }, 400);
	}
	const storageStatus = c.req.query("storageStatus");
	if (storageStatus && !ASSET_STORAGE_STATUSES.has(storageStatus as AssetStorageStatus)) {
		return c.json({ error: "Invalid storageStatus", code: "invalid_storage_status" }, 400);
	}
	const moderationStatus = c.req.query("moderationStatus");
	if (moderationStatus && !ASSET_MODERATION_STATUSES.has(moderationStatus as AssetModerationStatus)) {
		return c.json({ error: "Invalid moderationStatus", code: "invalid_moderation_status" }, 400);
	}
	const source = c.req.query("source");
	if (source && !ASSET_SOURCES.has(source as AssetActor["source"])) {
		return c.json({ error: "Invalid source", code: "invalid_source" }, 400);
	}
	// Listing is authoritative against Postgres in DB mode so a stale/empty JSON
	// mirror (second instance, restarted container, DB-restored project) can never
	// hide assets that exist in asset_records.
	const page = await listAssetRecordPageAuthoritative(projectId, {
		limit,
		cursor,
		storageStatus: storageStatus as AssetStorageStatus | undefined,
		moderationStatus: moderationStatus as AssetModerationStatus | undefined,
		source: source as AssetActor["source"] | undefined,
	});

	return c.json({
		assets: page.assets.map(serializeAssetSummary),
		nextCursor: page.nextCursor,
		storageQuota: await summarizeProjectStorageQuotaForProjectView(projectId),
	});
});

images.get("/:projectId/upload-audit", async (c) => {
	const projectId = c.req.param("projectId");

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}

	const limit = parseAuditLimit(c.req.query("limit"));
	if (limit === null) return c.json({ error: "Invalid audit limit", code: "invalid_limit" }, 400);
	const cursor = c.req.query("cursor");
	if (!isValidUploadAuditCursor(cursor)) {
		return c.json({ error: "Invalid cursor", code: "invalid_cursor" }, 400);
	}
	const source = c.req.query("source");
	if (source && !ASSET_SOURCES.has(source as AssetActor["source"])) {
		return c.json({ error: "Invalid source", code: "invalid_source" }, 400);
	}
	const actorUserId = c.req.query("actorUserId")?.trim();
	if (actorUserId !== undefined && actorUserId.length === 0) {
		return c.json({ error: "Invalid actorUserId", code: "invalid_actor_user_id" }, 400);
	}
	if (actorUserId && actorUserId.length > 200) {
		return c.json({ error: "Invalid actorUserId", code: "invalid_actor_user_id" }, 400);
	}
	const imageId = c.req.query("imageId");
	if (imageId && !isValidImageId(imageId)) {
		return c.json({ error: "Invalid imageId", code: "invalid_image_id" }, 400);
	}
	const ownershipError = await checkProjectOwnership(c, projectId, "read:project", {
		imageId,
		assetPurpose: "editor_preview",
		resourceKind: "asset",
	});
	if (ownershipError) return ownershipError;
	const page = await uploadAuditStore.listProjectEventPage(projectId, {
		limit,
		cursor,
		source: source as AssetActor["source"] | undefined,
		actorUserId,
		imageId,
	});

	return c.json({ events: page.events, nextCursor: page.nextCursor });
});

images.get("/:projectId/storage-usage", async (c) => {
	const projectId = c.req.param("projectId");

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}

	const ownershipError = await checkProjectOwnership(c, projectId);
	if (ownershipError) return ownershipError;

	return c.json({ storageQuota: await summarizeProjectStorageQuotaForProjectView(projectId) });
});

images.get("/:projectId/egress-usage", async (c) => {
	const projectId = c.req.param("projectId");

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}

	const ownershipError = await checkProjectOwnership(c, projectId);
	if (ownershipError) return ownershipError;

	try {
		return c.json({ egress: await summarizeProjectEgress(projectId) });
	} catch (error) {
		console.error("[images] asset egress summary failed", { projectId, error });
		return c.json({
			error: "Asset egress accounting unavailable",
			code: "asset_egress_accounting_unavailable",
		}, 503);
	}
});

// Asset metadata and moderation status
images.get("/:projectId/:imageId/asset", async (c) => {
	const { projectId, imageId } = c.req.param();

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID" }, 400);
	}
	if (!isValidImageId(imageId)) {
		return c.json({ error: "Invalid image ID" }, 400);
	}

	const purpose = parseAssetAccessPurpose(c.req.query("purpose"));
	if (!purpose) {
		return c.json({ error: "Invalid asset access purpose" }, 400);
	}
	const ownershipError = await checkProjectOwnership(c, projectId, "read:project", {
		imageId,
		assetPurpose: purpose,
		resourceKind: "asset",
	});
	if (ownershipError) return ownershipError;

	const asset = await getAssetRecordAuthoritative(projectId, imageId);
	if (!asset) {
		return c.json({ error: "Asset metadata not found" }, 404);
	}

	return c.json(asset);
});

images.get("/:projectId/:imageId/access-token", async (c) => {
	const { projectId, imageId } = c.req.param();

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID" }, 400);
	}
	if (!isValidImageId(imageId)) {
		return c.json({ error: "Invalid image ID" }, 400);
	}

	const purpose = parseAssetAccessPurpose(c.req.query("purpose"));
	if (!purpose) {
		return c.json({ error: "Invalid asset access purpose" }, 400);
	}
	const ttlSeconds = parseTtlSeconds(c.req.query("ttlSeconds"));
	if (ttlSeconds === null) {
		return c.json({ error: "Invalid ttlSeconds" }, 400);
	}
	// Export/original tokens hand out the FULL-QUALITY artifact, so minting them
	// requires the export permission — a view-only member (workspace viewer) may
	// only mint the view purposes (editor_preview/thumbnail/ai_output). Without
	// this, the viewer no-export policy could be bypassed by minting export-purpose
	// tokens per image and pulling every original out one by one.
	const mintPermission = purpose === "export" || purpose === "original" ? "export:project" : "read:project";
	const ownershipError = await checkProjectOwnership(c, projectId, mintPermission, {
		imageId,
		assetPurpose: purpose,
		resourceKind: "asset",
	});
	if (ownershipError) return ownershipError;
	const sourceAsset = await getAssetRecordAuthoritative(projectId, imageId);
	const isCowContent = Boolean(sourceAsset?.storageKey?.startsWith("content/") && sourceAsset.sha256);
	const objectExists = isCowContent
		? await objectStorage.hasContentBlob({ sha256: sourceAsset!.sha256 })
		: await objectStorage.hasProjectImage({ projectId, imageId });
	if (!objectExists) {
		return c.json({ error: "Image not found" }, 404);
	}
	// Mint an export-purpose token ONLY for an export-ready (`passed`) asset, so a
	// minted export token can never later fetch a needs_review/quarantined asset.
	const servable = await assertAssetServable(c, projectId, imageId, purpose, sourceAsset);
	if (servable instanceof Response) return servable;
	const throttleError = await assertEgressNotThrottledOrResponse(c, projectId, "token_issuance");
	if (throttleError) return throttleError;

	const token = signAssetAccessToken({ projectId, imageId, purpose, ttlSeconds });
	const verification = verifyAssetAccessToken({ token, projectId, imageId, purposes: [purpose] });
	const payload = verification.payload;
	const path = purpose === "thumbnail"
		? `/api/images/${projectId}/${imageId}/thumbnail`
		: `/api/images/${projectId}/${imageId}`;
	const delivery = buildSignedAssetDeliveryUrls({
		origin: new URL(c.req.url).origin,
		path,
		token,
	});

	return c.json({
		token,
		purpose,
		expiresAt: payload ? new Date(payload.exp * 1000).toISOString() : undefined,
		signedPath: delivery.signedPath,
		signedUrl: delivery.signedUrl,
		signedCdnUrl: delivery.signedCdnUrl,
		delivery: {
			mode: delivery.deliveryMode,
			storageDriver: objectStorage.driver,
			cdnProxyConfigured: delivery.cdnProxyConfigured,
			// When presigned R2 delivery is enabled, the image/thumbnail routes 302
			// the client to a short-TTL presigned URL instead of streaming bytes.
			presignedR2Enabled: presignedR2DeliveryEnabled(),
		},
		enforced: readAssetAccessConfig().enforced,
	});
});

// Serve a cached lightweight page thumbnail derivative.
images.get("/:projectId/:imageId/thumbnail", async (c) => {
	const { projectId, imageId } = c.req.param();

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID" }, 400);
	}
	if (!isValidImageId(imageId)) {
		return c.json({ error: "Invalid image ID" }, 400);
	}

	const access = requireSignedAssetAccess(c, projectId, imageId, ["thumbnail"], "thumbnail");
	if (access.error) return access.error;

	// A valid signed token authorizes the read on its own (browser <img> has no
	// Bearer header); otherwise fall back to JWT project ownership.
	const ownershipError = await authorizeAssetRequest(c, projectId, imageId, access);
	if (ownershipError) return ownershipError;

	const servable = await assertAssetServable(c, projectId, imageId);
	if (servable instanceof Response) return servable;

	// `fit=inside` requests the uncropped, column-width strip-preview variant
	// (webtoon continuous scroll): aspect preserved, larger clamps so it stays
	// crisp at retina column width. Default `cover` is the small fixed-aspect card.
	const fit: ThumbnailFit = c.req.query("fit") === "inside" ? "inside" : "cover";
	const maxWidth = fit === "inside" ? THUMBNAIL_INSIDE_MAX_WIDTH : THUMBNAIL_COVER_MAX_WIDTH;
	const maxHeight = fit === "inside" ? THUMBNAIL_INSIDE_MAX_HEIGHT : THUMBNAIL_COVER_MAX_HEIGHT;
	const minDim = fit === "inside" ? THUMBNAIL_INSIDE_MIN : THUMBNAIL_COVER_MIN;
	const width = parseThumbnailDimension(c.req.query("width"), 192, minDim, maxWidth);
	const height = parseThumbnailDimension(c.req.query("height"), 288, minDim, maxHeight);

	// Pre-check the abuse throttle BEFORE generating/fetching the derivative (Codex
	// round-2 #1). An already-over-threshold project is rejected here instead of
	// forcing a thumbnail decode/resize + buffer allocation just to return a 429.
	// Read-only probe; the exact-byte reservation that bounds concurrent overshoot
	// still happens below once the derivative size is known.
	const preThrottleError = await assertEgressNotThrottledOrResponse(c, projectId, "asset_read");
	if (preThrottleError) return preThrottleError;

	try {
		// Cache HIT fast path (Codex finding #3): when presigned delivery is enabled
		// and a ready thumbnail derivative already exists, presign directly from the
		// derivative record's id + size WITHOUT downloading the cached buffer. Only
		// fall through to ensureThumbnailDerivative (which reads/generates the buffer)
		// on a cache MISS. tryPresignedR2Redirect itself returns null when presign is
		// disabled, so this is a no-op outside opt-in R2 presigned delivery.
		if (presignedR2DeliveryEnabled()) {
			const cached = await findReadyThumbnailDerivative(projectId, imageId, width, height, fit);
			if (cached) {
				const cachedRedirect = await tryPresignedR2Redirect(c, {
					projectId,
					imageId,
					access,
					kind: "derivative",
					objectId: cached.derivativeId,
					bytes: cached.sizeBytes,
					cacheHit: true,
				});
				if (cachedRedirect) return cachedRedirect;
			}
		}

		const thumbnail = await ensureThumbnailDerivative(projectId, imageId, { width, height, fit });
		// Private-bucket direct delivery for the (now-persisted) thumbnail derivative.
		// On a cache MISS we just generated it (so it exists in R2 and its byte size
		// is known); a cache HIT here means presign was disabled/unavailable above.
		// Returns a presigned 302 when enabled, else falls through to streaming below.
		const presignedRedirect = await tryPresignedR2Redirect(c, {
			projectId,
			imageId,
			access,
			kind: "derivative",
			objectId: thumbnail.derivativeId,
			bytes: thumbnail.buffer.byteLength,
			cacheHit: thumbnail.cacheHit,
		});
		if (presignedRedirect) return presignedRedirect;
		// Atomically reserve the thumbnail bytes against the abuse window before
		// serving so concurrent reads cannot collectively overshoot the threshold.
		const throttleError = await reserveEgressForReadOrResponse(c, projectId, thumbnail.buffer.byteLength, "asset_read");
		if (throttleError) return throttleError;
		const recordError = await recordEgressWithAllowanceOrResponse(c, {
			projectId,
			imageId,
			purpose: access.purpose,
			bytes: thumbnail.buffer.byteLength,
			statusCode: 200,
			cacheHit: thumbnail.cacheHit,
			tokenRequired: access.tokenRequired,
			tokenAccepted: access.tokenAccepted,
			skipAbuseReservation: true,
		});
		if (recordError) {
			// Normal cap rejected this read (not served): roll back the abuse
			// reservation so undelivered bytes don't linger in the window (round-2 #3).
			await releaseEgressReservationBestEffort(projectId, thumbnail.buffer.byteLength);
			return recordError;
		}
		return new Response(thumbnail.buffer, {
			headers: {
				"Content-Type": thumbnail.mimeType,
				"Cache-Control": buildAssetCacheControl(access, 86400, true),
				"X-Content-Type-Options": "nosniff",
				"X-Thumbnail-Cache": thumbnail.cacheHit ? "hit" : "miss",
				"X-Thumbnail-Id": thumbnail.derivativeId,
				"X-Asset-Egress-Bytes": String(thumbnail.buffer.byteLength),
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Thumbnail could not be generated";
		if (error instanceof ThumbnailSourceNotFoundError || message.includes("not found")) {
			return c.json({ error: "Image not found.", code: "image_not_found" }, 404);
		}
		if (error instanceof ThumbnailSourceDecodeError) {
			const recordError = await recordEgressOrResponse(c, {
				projectId,
				imageId,
				purpose: access.purpose,
				bytes: 0,
				statusCode: 422,
				tokenRequired: access.tokenRequired,
				tokenAccepted: access.tokenAccepted,
			});
			if (recordError) return recordError;
			console.warn("[images] thumbnail source not decodable", {
				projectId,
				imageId,
				source: error.source,
				details: error.details,
			});
			return new Response(JSON.stringify({
				error: "Image thumbnail source is not decodable",
				code: "image_not_decodable",
				imageId,
			}), {
				status: 422,
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				},
			});
		}
		console.error("[images] thumbnail generation failed", { projectId, imageId, error });
		return c.json({ error: "Couldn't generate the preview. Try again.", code: "thumbnail_generation_failed" }, 500);
	}
});

// Serve image
images.get("/:projectId/:imageId", async (c) => {
	const { projectId, imageId } = c.req.param();

	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID" }, 400);
	}
	if (!isValidImageId(imageId)) {
		return c.json({ error: "Invalid image ID" }, 400);
	}

	const access = requireSignedAssetAccess(c, projectId, imageId, ["original", "editor_preview", "export", "ai_output"], "editor_preview");
	if (access.error) return access.error;

	// A valid signed token (scoped to the resolved purpose) authorizes the read on
	// its own — a browser <img src> preview cannot send a Bearer header. Without a
	// token, fall back to JWT project ownership (the editor blob path #138 and
	// cross-user denial are preserved).
	const ownershipError = await authorizeAssetRequest(c, projectId, imageId, access);
	if (ownershipError) return ownershipError;
	// Pass the resolved purpose so an `export`-purpose read is held to the stricter
	// export bar (moderation must be `passed`; a needs_review preview asset is not
	// exportable) — the server-authoritative gate behind single-page export.
	const servable = await assertAssetServable(c, projectId, imageId, access.purpose);
	if (servable instanceof Response) return servable;
	// Reuse the exact record the gate just validated (was a redundant authoritative re-read).
	const sourceAsset = servable;
	const isCowContent = Boolean(sourceAsset?.storageKey?.startsWith("content/") && sourceAsset.sha256);
	const objectExists = isCowContent
		? await objectStorage.hasContentBlob({ sha256: sourceAsset!.sha256 })
		: await objectStorage.hasProjectImage({ projectId, imageId });
	if (!objectExists) {
		return c.json({ error: "Image not found" }, 404);
	}

	// Pre-check the abuse throttle BEFORE downloading the object (Codex round-2 #1).
	// An already-over-threshold project is rejected here, so it can no longer force
	// a full backend/R2 read + buffer allocation just to receive a 429. This is a
	// read-only probe (no byte reservation) — the exact-byte reservation that bounds
	// concurrent overshoot still happens below once the payload size is known.
	const preThrottleError = await assertEgressNotThrottledOrResponse(c, projectId, "asset_read");
	if (preThrottleError) return preThrottleError;

	// Private-bucket direct delivery: when R2 presigned delivery is enabled, hand
	// the client a short-TTL presigned URL instead of streaming the object through
	// the backend. Uses the asset record's known size for egress/abuse accounting
	// since the backend never buffers the payload. Falls back to through-backend
	// below when presign is disabled/unavailable.
	// Authoritative read for the presigned-delivery size accounting: in DB mode the
	// asset_records row is the source of truth for sizeBytes used in egress/abuse
	// accounting when the backend never buffers the payload (#65 direct delivery).
	const presignAsset = isCowContent ? undefined : sourceAsset;
	if (presignAsset) {
		const presignedRedirect = await tryPresignedR2Redirect(c, {
			projectId,
			imageId,
			access,
			kind: "image",
			objectId: imageId,
			bytes: presignAsset.sizeBytes,
		});
		if (presignedRedirect) return presignedRedirect;
	}

	const ext = imageId.split(".").pop()?.toLowerCase() || "png";
	const mime = MIME_MAP[ext] || "image/png";

	const imageBuffer = isCowContent
		? await objectStorage.getContentBlob({ sha256: sourceAsset!.sha256 })
		: await objectStorage.getProjectImage({ projectId, imageId });
	if (!imageBuffer) {
		return c.json({ error: "Image not found" }, 404);
	}
	// Atomically reserve the bytes we are about to serve against the abuse window
	// before returning them, so concurrent reads cannot collectively overshoot
	// the threshold. Recording below skips the abuse increment to avoid double
	// counting these reserved bytes.
	const throttleError = await reserveEgressForReadOrResponse(c, projectId, imageBuffer.byteLength, "asset_read");
	if (throttleError) return throttleError;
	const recordError = await recordEgressWithAllowanceOrResponse(c, {
		projectId,
		imageId,
		purpose: access.purpose,
		bytes: imageBuffer.byteLength,
		statusCode: 200,
		tokenRequired: access.tokenRequired,
		tokenAccepted: access.tokenAccepted,
		skipAbuseReservation: true,
	});
	if (recordError) {
		// The normal egress cap rejected this read, so it is NOT served. Roll back
		// the abuse reservation made above so undelivered bytes don't linger in the
		// abuse window and trip/extend the throttle (Codex round-2 #3).
		await releaseEgressReservationBestEffort(projectId, imageBuffer.byteLength);
		return recordError;
	}

	return new Response(imageBuffer, {
		headers: {
			"Content-Type": mime,
			"Cache-Control": buildAssetCacheControl(access, 3600),
			"X-Content-Type-Options": "nosniff",
			"X-Asset-Egress-Bytes": String(imageBuffer.byteLength),
		},
	});
});

export { images };
/** Exported for tests: upload-rollback cleanup of uncommitted objects + records. */
export { cleanupUncommittedUploadObjects };
/**
 * Exported for tests: the image-routes ownership/authorization gate. Kept in
 * parity with routes/project.ts::checkProjectOwnership for the chapter-team grant
 * + workspace-suspension freeze so invited active members can load page images.
 */
export { checkProjectOwnership as checkImageProjectOwnership };
