// Project store — all project-related business logic
// Svelte 5 class-based store pattern for shared mutable state

import * as api from "$lib/api/client.ts";
import type {
	AiReviewMarkerCreateInput,
	AiReviewMarkerUpdateInput,
	ChapterTeamInviteInput,
	ProjectIdentityMetadata,
	ProjectImageAssetSummary,
	StorageQuotaSummary,
	ProjectSummary,
	ProjectVersion,
	ProjectVersionDetail,
	VersionComparison,
	VersionRestoreScope,
	TranslationImportPayload,
	TranslationImportResult,
	WorkspaceMemberRecord,
	WorkflowTaskBulkUpdate,
} from "$lib/api/client.ts";
import { config } from "$lib/config.js";
import {
	buildCreditLayerFromPreset,
	getCreditPresets,
	normalizeCreditPreset,
} from "$lib/project/credit-presets.js";
import { preserveRecentProjectOrder } from "$lib/project/recent-projects.js";
import { normalizeReadingDirection } from "$lib/project/reading-direction.js";
import { buildLayerImportResult, isLayerImportDocument } from "$lib/project/layer-import.js";
import { applyLocalTranslationImport } from "$lib/project/local-translation-import.js";
import {
	buildJsonImportMappingsPayload,
	buildJsonImportRemapPayload,
	shouldAskForJsonImportRemap,
	summarizeJsonImportSources,
} from "$lib/project/import-json-remap.js";
import { importRemapStore } from "$lib/stores/import-remap.svelte.ts";
import { editLeaseStore } from "$lib/stores/edit-lease.svelte.ts";
import { editSessionStore } from "$lib/stores/edit-session.svelte.ts";
import type { RealtimeEvent } from "$lib/stores/realtime.svelte.ts";
import {
	buildTextStyleFromLayer,
	getTextStylePresets,
	normalizeTextStylePreset,
} from "$lib/project/text-style-presets.js";
import {
	buildPageImageRelinkPlan,
	collectPageImageRelinkRefs,
	remapPageImageReferences,
	type PageImageRelinkPlan,
} from "$lib/project/page-relink.js";
import { buildProjectQcReport } from "$lib/project/qc-checks.js";
import {
	activeTrack,
	listTracks,
	seedTrackOutput,
	trackImageLayers,
	trackTextLayers,
	trackWritesFlat,
	writeTrackTextLayers,
	writeTrackScriptSlots,
	writeTrackTranslationHandoff,
	trackScriptSlots,
	pageOutput,
} from "$lib/project/language-tracks.js";
import { getAiMarkerReferenceIssue } from "$lib/project/ai-marker-reference.js";
import { aiReviewMarkerReferenceLabel, canPlaceAiResultAsEditableLayer } from "$lib/project/ai-review-marker-intent.js";
import { buildAiResultLayerGeometry } from "$lib/project/ai-result-layer-geometry.js";
import { buildWorkInbox } from "$lib/project/work-inbox.js";
import {
	filterProjectImageFiles,
	formatUnsupportedImageFileSummary,
	isSupportedImageFile,
	orderProjectImageFiles,
	SUPPORTED_IMAGE_ACCEPT,
} from "$lib/project/file-order.js";
import { ImageUploadBatchError, uploadImagesInBatches, type ImageUploadProgressState } from "$lib/project/upload-batches.js";
import {
	findPageAssetRecord,
	getPageAssetIntegrity as resolvePageAssetIntegrity,
	type PageAssetIntegrity,
	type PageAssetLoadIssue,
} from "$lib/project/page-assets.js";
import {
	createPageRevisionId,
	saveSyncStatusLabel,
	type SaveSyncStatus,
} from "$lib/project/page-revisions.js";
import { formatAssigneeHandle, normalizeAssigneeHandle } from "$lib/project/assignees.js";
import { planStageAdvance, type StageAdvancePlan } from "$lib/project/task-stage-advance.js";
import { createProjectStateFingerprint } from "$lib/project/project-state-fingerprint.js";
import {
	exportPagesToZip,
	MissingLanguageOutputError,
	PageExportError,
	resolveExportLang,
	type ExportSplitOptions,
	type PageExportProgress,
} from "$lib/project/page-export.js";
import { summarizePageWork } from "$lib/project/page-work-summary.js";
import { cleanExportFilename, planCleanedImport, readImageFileDimensions as readCleanedImageDimensions } from "$lib/project/clean-roundtrip.js";
import { createZipBlob, type ZipFileInput } from "$lib/project/zip-writer.js";
import {
	createExportRun,
	formatExportFailureDetail,
	getExportRunPageScope,
	isExportRunMeteringPending,
	normalizeExportRuns,
	type ExportRunInput,
} from "$lib/project/export-runs.js";
import {
	DRAFT_INTERNAL_EXPORT_PROFILE,
	exportCreditPolicyStatusMessage,
	exportProfileForCreditPolicy,
	requiredCreditMissingHoldReason,
	requiredCreditMissingMessage,
} from "$lib/project/export-profiles.js";
import {
	buildBatchExportGate,
	getPageTaskType,
	movePageItems,
	remapOptionalPageIndex,
	remapOptionalPageTaskId,
	remapPageIndex,
	remapPageTaskId,
	remapPageTaskIds,
	remapPageTaskMetadata,
	remapWorkflowTaskTitle,
	type BatchExportGate,
	type PageMovePlan,
} from "$lib/project/page-operations.js";
import type {
	ActivityEvent,
	AiReviewMarker,
	AiReviewMarkerStatus,
	CreditApplyScope,
	CreditPolicy,
	CreditPreset,
	CreditPlacement,
	ExportMeteringInput,
	ExportRun,
	ImageEditLayer,
	ImageEditLayerPatchCommitInput,
	ImageEditLayerPayload,
	ImageLayer,
	ProjectComment,
	ProjectState,
	Page,
	PageLanguageOutput,
	PageCleaningHandoffStatus,
	PageCleaningProofKind,
	PageQcHandoffStatus,
	PageReviewDecision,
	PageReviewDecisionStatus,
	ReviewAssignment,
	ReviewAssignmentStatus,
	RevisionRequest,
	RevisionRequestStatus,
	ProductionMode,
	ReadingDirection,
	ReviewAnnotation,
	PageTranslationHandoff,
	PageTranslationHandoffStatus,
	TextLayer,
	TextStylePreset,
	TranslationScriptSlot,
	TypesetCleanRecheckStatus,
	VersionReviewRequest,
	VersionReviewStatus,
	WorkflowTask,
	WorkflowTaskPriority,
	WorkflowTaskStatus,
	WorkspaceFeedItem,
	WorkspaceMessage,
} from "$lib/types.js";

// The active workspace id the user is browsing under. Read directly from the SAME
// localStorage key the workspaces store persists (`manga-editor.currentWorkspaceId`)
// rather than importing the store: the store transitively pulls in the auth store
// (which registers a refresh handler at module load), and importing that whole
// chain into the project store both widens coupling and breaks the project-store
// test mocks of `$lib/api/client.ts`. A plain key read is enough — the value is the
// dashboard's source of truth for "which workspace am I in" — and the backend
// re-verifies membership before stamping it.
const CURRENT_WORKSPACE_STORAGE_KEY = "manga-editor.currentWorkspaceId";

function readCurrentWorkspaceId(): string | undefined {
	if (typeof localStorage === "undefined") return undefined;
	try {
		return localStorage.getItem(CURRENT_WORKSPACE_STORAGE_KEY)?.trim() || undefined;
	} catch {
		return undefined;
	}
}

type PageAssetLoadError = PageAssetLoadIssue;
type PageAssetLoadErrorEntry = PageAssetLoadError | PageAssetLoadError[];
type BatchExportStatus = "idle" | "checking" | "exporting" | "done" | "error";
type SaveErrorKind = "conflict" | "generic" | "brush";
type CreditDeleteKind = "all" | "text" | "image";
type CreditDeleteMatch = {
	text?: string;
	imageId?: string;
};
type AiReviewMarkerUpdateOptions = {
	select?: boolean;
};
type AiReviewMarkerCreateOptions = {
	// The project this marker belongs to, captured by the caller BEFORE its first
	// await (the AI job submit/retry round-trip). The server write always targets
	// this id, and the local-state apply (markers/activity/selection) is gated on
	// `this.project?.projectId === forProjectId` AFTER the API resolves — so a
	// create whose owning project was switched away mid-await still PERSISTS the
	// marker for the owner (it was accepted+charged server-side and must stay
	// visible when the owner reopens) but never bleeds A's marker response into the
	// now-open project B. Omitted ⇒ defaults to the currently-open project (legacy
	// callers with no cross-project concern).
	forProjectId?: string;
	// Optional caller-side liveness gate, evaluated AFTER the API resolves, in
	// addition to the id match below. The id check alone is insufficient on sign-out:
	// cleanup() wipes the AI store's session state but NOT necessarily the project
	// store, so this.project may STILL hold the owner's id while the session that
	// issued the create is dead. The AI jobs store passes its captured-generation
	// check here (teardownGeneration === captured) so the local marker/activity apply
	// is skipped for a dead session — the CALLER's own generation guard would only run
	// after this method returns, too late to stop the apply. The SERVER write happens
	// regardless (the job was accepted+charged; server state must stay consistent).
	// Omitted ⇒ treated as always-current (legacy callers with no teardown concern).
	isContextCurrent?: () => boolean;
};
type PendingAiResultApplyMarker = {
	projectId: string;
	markerId: string;
	pageIndex: number;
};
type ProjectRemoteMutationSurface =
	| "activityLog"
	| "aiReviewMarkers"
	| "comments"
	| "exportRuns"
	| "reviewDecisions"
	| "reviewAssignments"
	| "revisionRequests"
	| "tasks"
	| "workspaceMessages";
interface CreditImagePlacementOptions {
	presetId: string;
	maxWidth: number;
	repeatEveryPx: number;
	allPages?: boolean;
	scope?: CreditApplyScope;
}
interface CreditTextPlacementOptions {
	presetId: string;
	text: string;
	offset: number;
	repeatEveryPx?: number;
	scope?: CreditApplyScope;
}
type ProjectSetupOptions = ProjectIdentityMetadata & {
	projectName?: string;
	targetLang?: string;
	coverFile?: File | null;
	unsupportedSummary?: string;
	/**
	 * Override the files-per-batch for the chapter page upload. Production leaves this
	 * unset (uses the responsive DEFAULT_IMAGE_UPLOAD_BATCH_SIZE); tests set a small
	 * value to exercise the multi-batch resume/cleanup paths deterministically without
	 * uploading dozens of files.
	 */
	uploadBatchSize?: number;
	// First-run guard: when the caller (e.g. the workspace dashboard CTA) requires the
	// new project to be workspace-scoped, set this so the create REFUSES to mint an
	// unscoped personal/orphan project if no workspace id can be resolved yet (the
	// workspace context can still be loading on first run). The caller threads the live
	// `workspacesStore.currentWorkspace.workspaceId` via `workspaceId`; if that — and
	// the persisted current-workspace fallback — are both empty, we abort with a clear
	// "setting up your workspace…" status instead of creating an orphan.
	requireScopedCreate?: boolean;
	// Chapter-level Team/Solo selection + invite-at-creation (threaded into the
	// create call). Absent ⇒ Solo / owner-only.
	productionMode?: ProductionMode;
	initialInvites?: ChapterTeamInviteInput[];
	/**
	 * Optional source-image transform applied AT CREATION: merge every `perPage`
	 * source files vertically into one page (webtoon strips — e.g. 300 slices at
	 * 10:1 → 30 pages). Server-side stitch via /upload-transform; the merged
	 * image IS the page's original from then on. Absent ⇒ 1 file = 1 page.
	 */
	pageTransform?: { mode: "merge"; perPage: number };
};

export interface LocalConflictRecoveryDraft {
	kind: "manga-editor-conflict-local-copy";
	id: string;
	exportedAt: string;
	reason: "project_save_conflict";
	message: string;
	projectId: string;
	projectName: string;
	pageIndex: number;
	pageCount: number;
	textLayerCount: number;
	imageLayerCount: number;
	project: ProjectState;
}
interface LocalConflictRecoveryDraftResult {
	draft: LocalConflictRecoveryDraft;
	persisted: boolean;
}

export interface PageSetChangedNotice {
	projectId: string;
	changedBy: string;
	pageCount: number;
	receivedAt: number;
}
const STORAGE_QUOTA_UPDATED_EVENT = "manga:storage-quota-updated";
const BACKEND_PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFLICT_RECOVERY_STORAGE_PREFIX = "manga-editor:conflict-recovery:";
const CONFLICT_RECOVERY_INDEX_KEY = "manga-editor:conflict-recovery:index";
/** Debounce window for autosave: persist after edits settle for this long. */
export const AUTOSAVE_DEBOUNCE_MS = 5000;
/** Max characters for a user-supplied version label (mirrors backend schema). */
export const MAX_VERSION_LABEL_LENGTH = 120;

export function canUseBackendProjectEndpoints(projectId: string): boolean {
	return BACKEND_PROJECT_ID_PATTERN.test(projectId);
}

/**
 * Turn an upload failure into a status message. Oversize (413/batch-cap) errors
 * get the shared actionable guidance; a per-batch failure additionally names the
 * exact page span that stalled so the user can fix/retry that range instead of a
 * silent generic error.
 */
/**
 * P1-1 — reassign contiguous 0..n-1 `index` values to an edit-layer stack in ARRAY ORDER
 * (the authoritative stack order). A prior delete/revert may have left gaps so that the
 * next appended edit (whose index is the layer COUNT) collides with a survivor's stored
 * index; normalizing first makes the stack positional and collision-free.
 */
function normalizeImageEditLayerIndices(layers: ImageEditLayer[]): ImageEditLayer[] {
	return layers.map((layer, i) => (layer.index === i ? layer : { ...layer, index: i }));
}

function uploadFailureStatus(error: unknown, fallback: string): string {
	if (api.isUploadTooLargeError(error)) return api.UPLOAD_TOO_LARGE_MESSAGE;
	if (error instanceof ImageUploadBatchError) {
		const span = error.fromPage === error.toPage
			? `หน้า ${error.fromPage}`
			: `หน้า ${error.fromPage}–${error.toPage}`;
		const reason = error.message?.trim();
		return reason
			? `อัปโหลด${span}ไม่สำเร็จ: ${reason}`
			: `อัปโหลด${span}ไม่สำเร็จ`;
	}
	return error instanceof Error ? error.message : fallback;
}

/**
 * Decide whether a retried image selection may RESUME against a stashed resume
 * record. Identity — NOT a serializable fingerprint — is the guard: a retry resumes
 * only when it is provably the SAME in-memory selection (the SAME `File` object
 * references, in the SAME order, for the committed leading prefix) as the attempt
 * that produced the stash.
 *
 * Why identity and not name+size+lastModified: that triple can COLLIDE across two
 * genuinely different selections (re-exported pages, equal-size webp, copied files).
 * A collision would let a fresh selection reuse a stale committed prefix → skip files
 * that were never uploaded for THIS selection (missing/wrong pages) or attach the
 * wrong committed ids. `File` object identity cannot collide: every `<input>`/drop
 * yields fresh `File` objects, so only a retry of the SAME dialog attempt (same
 * `File[]` still held in memory) matches. The stash is purely in-memory and never
 * survives a reload, so the retried `File` objects are always the original ones.
 *
 * Fail-safe: requires the stashed selection to be a leading prefix of the retried
 * selection AND every committed leading file to be the SAME object. ANY mismatch (or
 * any doubt) returns false → caller discards the stash and uploads from scratch,
 * never silently skipping or attaching wrong pages.
 */
function imageUploadSelectionResumes(
	stashedFiles: readonly File[],
	committedFiles: number,
	retriedFiles: readonly File[],
): boolean {
	// A resume only short-circuits the leading `committedFiles` files; identity must
	// hold for exactly that committed prefix (the rest are uploaded fresh anyway).
	if (committedFiles <= 0) return false;
	if (committedFiles > stashedFiles.length) return false;
	if (committedFiles > retriedFiles.length) return false;
	for (let i = 0; i < committedFiles; i += 1) {
		// Reference equality: the SAME File object, not a same-looking one.
		if (stashedFiles[i] !== retriedFiles[i]) return false;
	}
	return true;
}

/**
 * Keys-only resume guard for the canonical P1: a keep-mode batch (the SINGLE batch,
 * or the FIRST batch) whose commit SUCCEEDED server-side but whose response was LOST
 * (XHR onerror/ontimeout) THREW before any prior batch committed, so
 * `committedFiles === 0` — nothing to skip, but the failed batch's original
 * idempotency key MUST be reused on retry so the server replays the committed result
 * instead of duplicating it. {@link imageUploadSelectionResumes} deliberately rejects
 * a zero-committed prefix (no prefix to identity-check), which would drop the keys and
 * re-open the window. This guard instead requires the WHOLE retried selection to be
 * the SAME File objects in the SAME order as the stash, so reusing the planned
 * `batchKeys` is provably safe: identical files → identical batch plan → index-aligned
 * keys. Any length/identity mismatch returns false → keys are discarded and the upload
 * starts fresh (never reuses a stale key against a different selection).
 */
function imageUploadKeysResume(
	stashedFiles: readonly File[],
	retriedFiles: readonly File[],
): boolean {
	if (stashedFiles.length === 0) return false;
	if (stashedFiles.length !== retriedFiles.length) return false;
	for (let i = 0; i < stashedFiles.length; i += 1) {
		if (stashedFiles[i] !== retriedFiles[i]) return false;
	}
	return true;
}

function canLoadProjectWorkflowFromBackend(projectId: string): boolean {
	return canUseBackendProjectEndpoints(projectId);
}

function canLoadProjectVersionsFromBackend(projectId: string): boolean {
	return canUseBackendProjectEndpoints(projectId);
}

function canUseLocalDebugProjectFallback(projectId: string): boolean {
	return projectId === "flow208-project";
}

function normalizeTargetLanguage(lang: string | undefined | null, fallback = config.defaultLang): string {
	return lang?.trim().toLowerCase() || fallback;
}

function cloneProjectState(project: ProjectState): ProjectState {
	return JSON.parse(JSON.stringify(project)) as ProjectState;
}

function isLocalImageSourceUrl(imageUrl: string): boolean {
	return imageUrl.startsWith("data:") || imageUrl.startsWith("blob:");
}

/**
 * True when `imageId` names a real backend asset (eligible for backend storage GC),
 * not a file/local-mode synthetic placeholder. File-mode destructive-edit commits
 * mint `brush-page-*` / `brush-*` ids that never reach the asset store, so they must
 * never be sent to {@link api.deleteWorkspaceStorageAsset} (which would 404 forever).
 */
function isPersistableBackendImageId(imageId: string): boolean {
	if (!imageId) return false;
	if (imageId.startsWith("blob:") || imageId.startsWith("data:")) return false;
	// File-mode synthetic background/brush placeholders from the (now removed) legacy
	// full-page-bake clean path: still guarded for backward-compat with old saved
	// states that may carry a "brush-*" placeholder image id — never backed by an asset.
	if (imageId.startsWith("brush-page-") || imageId.startsWith("brush-")) return false;
	return true;
}

class BrushCommitNavigationError extends Error {
	readonly originalError: unknown;

	constructor(message: string, originalError: unknown) {
		super(message);
		this.name = "BrushCommitNavigationError";
		this.originalError = originalError;
	}
}

function isBrushCommitNavigationError(error: unknown): error is BrushCommitNavigationError {
	return error instanceof BrushCommitNavigationError;
}

async function imageSourceUrlToBlob(imageUrl: string): Promise<Blob> {
	const response = await fetch(imageUrl);
	if (!response.ok) throw new Error("อ่านภาพที่แก้แล้วไม่สำเร็จ");
	return response.blob();
}

function blobToFile(blob: Blob, filename: string): File {
	const mimeType = blob.type || "image/png";
	return new File([blob], filename, { type: mimeType });
}

async function imageSourceUrlToFile(imageUrl: string, filename: string): Promise<File> {
	return blobToFile(await imageSourceUrlToBlob(imageUrl), filename);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
	if (typeof FileReader === "undefined") return "";
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
		reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
		reader.readAsDataURL(blob);
	});
}

/**
 * Return a DURABLE version of a local image source URL for caching in
 * `localImageUrls`.
 *
 * The editor tools (heal / clone / brush-erase) now encode their committed
 * bitmap off the main thread to a revocable `blob:` URL and REVOKE it as soon as
 * the canvas reload + persistence have read it. If we cached that same `blob:`
 * URL as the durable `localImageUrls` entry, a later `getImageUrl()` (after
 * navigating away and back, or a reload) would hand out a REVOKED blob → the
 * edited page renders blank. So a `blob:` source must be copied into a stable
 * `data:` URL before it is cached. `data:` URLs (and any already-cached source)
 * pass through unchanged. The optional `blob` lets callers reuse a Blob they
 * already read from the URL so we don't fetch it twice.
 */
async function durableLocalImageUrl(imageUrl: string, blob?: Blob): Promise<string> {
	if (!imageUrl.startsWith("blob:")) return imageUrl;
	const data = await blobToDataUrl(blob ?? (await imageSourceUrlToBlob(imageUrl)));
	// If the data-URL copy failed (no FileReader, e.g. some headless envs) keep
	// the original URL rather than caching an empty string — the caller's load
	// still has a valid reference for the current session.
	return data || imageUrl;
}

async function readImageFileDimensions(file: File, fallbackWidth: number, fallbackHeight: number): Promise<{ width: number; height: number }> {
	const safeFallback = {
		width: Math.max(1, Math.round(fallbackWidth || 240)),
		height: Math.max(1, Math.round(fallbackHeight || 120)),
	};
	if (typeof createImageBitmap === "function") {
		try {
			const bitmap = await createImageBitmap(file);
			const dimensions = { width: Math.max(1, bitmap.width), height: Math.max(1, bitmap.height) };
			bitmap.close?.();
			return dimensions;
		} catch {
			// Fall through to HTMLImageElement decoding.
		}
	}
	if (typeof Image === "undefined" || typeof URL === "undefined") return safeFallback;
	const objectUrl = URL.createObjectURL(file);
	try {
		return await new Promise((resolve) => {
			const image = new Image();
			image.onload = () => {
				resolve({
					width: Math.max(1, image.naturalWidth || safeFallback.width),
					height: Math.max(1, image.naturalHeight || safeFallback.height),
				});
			};
			image.onerror = () => resolve(safeFallback);
			image.src = objectUrl;
		});
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

/**
 * Decode an image URL to its TRUE natural pixel dimensions. Returns null when
 * the image can't be measured (no DOM Image, decode error, or it never loads
 * within `timeoutMs`) so callers can take the SAFE path (no crop / recorded
 * asset dims) instead of trusting a fabricated page-dim fallback. The timeout
 * also keeps non-loading environments (jsdom/headless) from hanging.
 */
async function readImageUrlDimensions(
	url: string,
	timeoutMs = 1500,
): Promise<{ width: number; height: number } | null> {
	if (!url) return null;
	if (typeof Image === "undefined") return null;
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (value: { width: number; height: number } | null) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(value);
		};
		const timer = typeof setTimeout === "function" ? setTimeout(() => finish(null), timeoutMs) : undefined;
		const image = new Image();
		try {
			image.crossOrigin = "anonymous";
		} catch {
			// Some environments reject crossOrigin assignment; harmless to skip.
		}
		image.onload = () => {
			const width = Math.max(0, image.naturalWidth || image.width || 0);
			const height = Math.max(0, image.naturalHeight || image.height || 0);
			finish(width > 0 && height > 0 ? { width, height } : null);
		};
		image.onerror = () => finish(null);
		image.src = url;
	});
}

function projectSummaryFromLocalState(project: ProjectState): ProjectSummary {
	const pages = project.pages ?? [];
	const tasks = project.tasks ?? [];
	const comments = project.comments ?? [];
	const textLayerCount = pages.reduce((total, page) => total + page.textLayers.length, 0);
	const openTaskCount = tasks.filter((task) => task.status !== "done").length;
	const reviewTaskCount = tasks.filter((task) => task.status === "review").length;
	const openCommentCount = comments.filter((comment) => comment.status !== "resolved").length;
	return {
		projectId: project.projectId,
		name: project.name,
		createdAt: project.createdAt,
		updatedAt: project.createdAt,
		storyId: project.storyId,
		storyTitle: project.storyTitle,
		chapterNumber: project.chapterNumber,
		chapterTitle: project.chapterTitle,
		chapterLabel: project.chapterLabel,
		coverImageId: project.coverImageId,
		coverOriginalName: project.coverOriginalName,
		sourceLang: project.sourceLang ?? "ja",
		targetLang: project.targetLang,
		pageCount: pages.length,
		textLayerCount,
		taskCount: tasks.length,
		openTaskCount,
		reviewTaskCount,
		commentCount: comments.length,
		openCommentCount,
	};
}

function projectIdentityMetadataFromSetup(setup: ProjectSetupOptions): ProjectIdentityMetadata {
	return {
		storyId: setup.storyId?.trim() || undefined,
		storyTitle: setup.storyTitle?.trim() || undefined,
		chapterNumber: setup.chapterNumber?.trim() || undefined,
		chapterTitle: setup.chapterTitle?.trim() || undefined,
		chapterLabel: setup.chapterLabel?.trim() || undefined,
		sourceLang: setup.sourceLang?.trim().toLowerCase() || undefined,
		readingDirection: setup.readingDirection ? normalizeReadingDirection(setup.readingDirection) : undefined,
		// Stamp the new chapter with the active workspace so it shows up in that
		// workspace's dashboard (hero/pipeline/my-tasks). Without this every project
		// is created workspace-less and the workspace /home aggregate matches nothing
		// → the dashboard stays empty (the file-mode/self-host P1). An explicit
		// setup.workspaceId wins; otherwise fall back to the user's current workspace.
		// The backend re-verifies membership before stamping, so this is a hint, not
		// an authority — a non-member value is rejected server-side.
		workspaceId: setup.workspaceId?.trim() || readCurrentWorkspaceId(),
		// Chapter-level Team/Solo + invite-at-creation. Only send when meaningful so a
		// plain Solo create stays byte-identical to before (no productionMode/invites).
		...(setup.productionMode ? { productionMode: setup.productionMode } : {}),
		...(setup.initialInvites && setup.initialInvites.length > 0
			? { initialInvites: setup.initialInvites }
			: {}),
	};
}

function applyProjectIdentityMetadata(project: ProjectState, setup: ProjectSetupOptions): void {
	const metadata = projectIdentityMetadataFromSetup(setup);
	if (metadata.storyId) project.storyId = metadata.storyId;
	if (metadata.storyTitle) project.storyTitle = metadata.storyTitle;
	if (metadata.chapterNumber) project.chapterNumber = metadata.chapterNumber;
	if (metadata.chapterTitle !== undefined) project.chapterTitle = metadata.chapterTitle;
	if (metadata.chapterLabel) project.chapterLabel = metadata.chapterLabel;
	if (metadata.sourceLang) project.sourceLang = metadata.sourceLang;
	if (metadata.readingDirection) project.readingDirection = metadata.readingDirection;
}

function createLocalStoreId(prefix: string): string {
	return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function createLocalActivity(
	type: ActivityEvent["type"],
	message: string,
	options: { pageIndex?: number; taskId?: string; metadata?: Record<string, unknown> } = {},
): ActivityEvent {
	return {
		id: createLocalStoreId("activity"),
		type,
		message,
		actor: "local",
		createdAt: new Date().toISOString(),
		...options,
	};
}

function formatAiMarkerStatusMessage(status: AiReviewMarkerStatus): string {
	switch (status) {
		case "accepted":
			return "ยืนยันผล AI ผ่านแล้ว";
		case "applied":
			return "วางผล AI เป็นเลเยอร์แล้ว";
		case "failed":
			return "ผล AI รันไม่สำเร็จ";
		case "needs_review":
			return "ผล AI รอรีวิว";
		case "rejected":
			return "ไม่ใช้ผล AI นี้";
		case "retry_requested":
			return "ขอรันผล AI ใหม่แล้ว";
		default:
			return "อัปเดตผล AI แล้ว";
	}
}

function formatAiMarkerPageMessage(action: string, pageIndex: number): string {
	return `${action} หน้า ${pageIndex + 1} แล้ว`;
}

function formatWorkspaceNoteAddedMessage(pageIndex?: number): string {
	return pageIndex !== undefined
		? `เพิ่มโน้ตทีมหน้า ${pageIndex + 1} แล้ว`
		: "เพิ่มโน้ตทีมแล้ว";
}

function formatPageCommentAddedMessage(pageIndex: number): string {
	return `เพิ่มโน้ตหน้า ${pageIndex + 1} แล้ว`;
}

function formatPagePosition(pageIndex: number, pageCount: number): string {
	return `หน้า ${pageIndex + 1} / ${pageCount}`;
}

const supportedImageCopy = "PNG, JPG หรือ WebP";

function applyWorkflowTaskUpdate(task: WorkflowTask, update: WorkflowTaskBulkUpdate, updatedAt: string): WorkflowTask {
	const next: WorkflowTask = { ...task, updatedAt };
	if (update.status !== undefined) next.status = update.status;
	if (update.priority !== undefined) next.priority = update.priority;
	if (update.assignee !== undefined) next.assignee = update.assignee ?? undefined;
	if (update.dueAt !== undefined) next.dueAt = update.dueAt ?? undefined;
	return next;
}

function workflowTaskChanged(task: WorkflowTask, update: WorkflowTaskBulkUpdate): boolean {
	return (update.status !== undefined && task.status !== update.status)
		|| (update.priority !== undefined && task.priority !== update.priority)
		|| (update.assignee !== undefined && (task.assignee ?? null) !== (update.assignee ?? null))
		|| (update.dueAt !== undefined && (task.dueAt ?? null) !== (update.dueAt ?? null));
}

export function formatExportArtifactPersistenceError(artifactError: unknown): string {
	const detail = artifactError instanceof Error ? artifactError.message.trim() : "";
	return detail
		? `เก็บ ZIP ไม่สำเร็จ: ${detail}`
		: "เก็บ ZIP ไม่สำเร็จ";
}

export function formatExportArtifactPersistenceMessage(batchExportMessage: string, artifactError: unknown): string {
	const cleanBatchMessage = batchExportMessage.trim() || "Export สำเร็จ";
	const storedZipMessage = formatExportArtifactPersistenceError(artifactError);
	return `${cleanBatchMessage}. ${storedZipMessage} ดาวน์โหลดได้ในแท็บนี้; ลบ ZIP ที่เก็บไว้หรือสร้างใหม่หลังคืนพื้นที่`;
}

function formatExportPageLabel(pageIndex: number): string {
	return `หน้า ${pageIndex + 1}`;
}

function formatExportPageScope(pageIndexes: number[]): string {
	const pageNumbers = pageIndexes
		.filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0)
		.map((pageIndex) => pageIndex + 1);
	if (!pageNumbers.length) return "หน้าที่เลือก";
	if (pageNumbers.length === 1) return `หน้า ${pageNumbers[0]}`;

	const first = pageNumbers[0];
	const last = pageNumbers[pageNumbers.length - 1];
	if (pageNumbers.length === last - first + 1) return `หน้า ${first}-${last}`;

	const preview = pageNumbers.slice(0, 4).join(", ");
	const suffix = pageNumbers.length > 4 ? `, +${pageNumbers.length - 4}` : "";
	return `${pageNumbers.length} หน้า (${preview}${suffix})`;
}

function formatBatchExportFailureScope(pageIndexes: number[], progress: PageExportProgress | null): string {
	const scope = formatExportPageScope(pageIndexes);
	if (!progress) return scope;

	if (progress.completed >= progress.total) {
		return `${scope}; รวมภาพครบ ${progress.completed}/${progress.total} แต่บันทึกหรือดาวน์โหลดต่อไม่สำเร็จ`;
	}

	const failedPageIndex = Number.isInteger(pageIndexes[progress.completed])
		? pageIndexes[progress.completed]
		: progress.pageIndex;
	const failedPage = formatExportPageLabel(failedPageIndex);
	if (progress.completed > 0) {
		return `${failedPage}; ทำสำเร็จแล้ว ${progress.completed}/${progress.total} ในชุด ${scope}`;
	}
	return `${failedPage}; เริ่มชุด ${scope}`;
}

function formatSinglePageExportFailureMessage(pageIndex: number, detail: string): string {
	return `Export ${formatExportPageLabel(pageIndex)} ไม่สำเร็จ: ${detail}; งานเดิมยังอยู่ ตรวจหน้านี้หรือบันทึกงานแล้วลอง Export อีกครั้ง`;
}

function formatSinglePageExportFailureHistoryError(pageIndex: number, detail: string): string {
	return `${formatExportPageLabel(pageIndex)} - ${detail}; งานเดิมยังอยู่ ตรวจหน้านี้หรือบันทึกงานแล้วลอง Export อีกครั้ง`;
}

function formatBatchExportFailureMessage(
	pageIndexes: number[],
	progress: PageExportProgress | null,
	detail: string,
): string {
	const scope = formatBatchExportFailureScope(pageIndexes, progress);
	return `Export ไม่สำเร็จ: ${scope} - ${detail}; งานเดิมยังอยู่ ตรวจชุดหน้าที่ระบุหรือบันทึกงานแล้วลอง Export อีกครั้ง`;
}

function formatBatchExportFailureHistoryError(
	pageIndexes: number[],
	progress: PageExportProgress | null,
	detail: string,
): string {
	const scope = formatBatchExportFailureScope(pageIndexes, progress);
	return `${scope} - ${detail}; งานเดิมยังอยู่ ตรวจชุดหน้าที่ระบุหรือบันทึกงานแล้วลอง Export อีกครั้ง`;
}

interface LayerIdRepairResult {
	pageIndex: number;
	textLayerIds: number;
	imageLayerIds: number;
	total: number;
}

interface LoadRecentProjectsOptions {
	preserveExistingOrder?: boolean;
	background?: boolean;
	silentFailure?: boolean;
	// The workspace the Library is being loaded for. The UI caller (Library /
	// sidebar) threads the RESOLVED current-workspace id from `workspacesStore`
	// here so the listing is always scoped to the workspace the user is actually
	// viewing — not whatever happens to be in localStorage at fetch time (which is
	// empty on a first load before the workspaces store settles, and would
	// otherwise fall through to the legacy UNSCOPED, cross-workspace listing).
	//
	// - a concrete string → scope to that workspace.
	// - `null` → the caller KNOWS there is no resolvable workspace yet; fetch
	//   NOTHING (empty) rather than an unscoped cross-workspace list.
	// - omitted/`undefined` → no explicit scope from the caller; fall back to the
	//   persisted current-workspace id (and, only if that is ALSO absent, fetch
	//   nothing — never an unscoped list).
	workspaceId?: string | null;
}

export interface MatchingPageImageRelinkPreview {
	plan: PageImageRelinkPlan;
	supportedFileCount: number;
	unsupportedSummary: string;
	nameMatchedCount: number;
	orderMatchedCount: number;
	requiresOrderConfirmation: boolean;
}

interface ReplaceMatchingPageImagesOptions {
	allowOrderFallback?: boolean;
}

const DEFAULT_SOURCE_LANG = "ja";

// Projects loaded from the backend (or set in tests) may omit `sourceLang`. The
// store defaults it to "ja" on load, so any other read of the same project (e.g.
// the stale-save guard re-fetch) must apply the identical default before
// fingerprinting — otherwise a missing-vs-defaulted sourceLang looks like a remote
// conflict on the very next save.
function applySourceLangDefault<T extends { sourceLang?: string }>(project: T): T {
	if (!project.sourceLang) project.sourceLang = DEFAULT_SOURCE_LANG;
	return project;
}

class ProjectSaveConflictError extends Error {
	constructor() {
		super("งานนี้ถูกแก้จากแท็บหรือเครื่องอื่น โหลดใหม่ก่อนบันทึกเพื่อไม่ทับงานล่าสุด");
		this.name = "ProjectSaveConflictError";
	}
}

function apiErrorCode(error: unknown): string | undefined {
	if (!(error instanceof api.ApiError)) return undefined;
	const body = error.body;
	const code = typeof body === "object" && body !== null && "code" in body
		? (body as { code?: unknown }).code
		: undefined;
	return typeof code === "string" ? code : error.code;
}

/**
 * True when a page-bearing /save was rejected because it omitted the CAS baseline
 * fingerprint header and the prod `requireProjectBaselineHeaderEnabled` gate is ON
 * (backend project.ts → 428 `project_baseline_required`). This is NOT stale data —
 * it means the client forgot the header (a null `projectBaseFingerprint`), so the
 * caller can re-seed from authoritative server state only when it can prove the
 * remote still matches either the previous local baseline or the exact save
 * payload, then retry once before falling back to the conflict-recovery flow.
 */
function isBackendProjectBaselineRequired(error: unknown): boolean {
	return error instanceof api.ApiError
		&& error.status === 428
		&& apiErrorCode(error) === "project_baseline_required";
}

/**
 * True for a recoverable REMOTE-DRIFT save conflict: a generic 409
 * `project_save_conflict` or a takeover (C1: the backend rejects a displaced
 * holder's save). Both mean "the remote moved under you", so the SAME
 * recovery-draft / reload flow handles them — no silent clobber, work preserved.
 *
 * Deliberately 409-ONLY: the 428 `project_baseline_required` is NOT folded in
 * here. This classifier is consumed by REMOTE-REPLACING callers too
 * (`persistExportRunAfterConflict` loads the remote project and ASSIGNS
 * `this.project`). A 428 fires while local page edits are still unsaved — adopting
 * the remote there would DISCARD that unsaved work, the exact thing the 428 path
 * exists to preserve (codex P1, round 3). Save-UI / recovery-draft consumers that
 * legitimately want the 428 to be recoverable add
 * `|| isBackendProjectBaselineRequired(error)` EXPLICITLY at their own call site,
 * so the 428 reaches only the work-preserving sinks and never the merge.
 */
function isBackendProjectSaveConflict(error: unknown): boolean {
	if (!(error instanceof api.ApiError) || error.status !== 409) return false;
	const code = apiErrorCode(error);
	return code === "project_save_conflict" || code === "editing_taken_over";
}

/** True when the save was rejected specifically because another user took over (C1). */
function isBackendEditingTakenOver(error: unknown): boolean {
	if (!(error instanceof api.ApiError) || error.status !== 409) return false;
	const body = error.body;
	return typeof body === "object"
		&& body !== null
		&& "code" in body
		&& (body as { code?: unknown }).code === "editing_taken_over";
}

function formatRecentProjectsError(error: unknown): string {
	if (error instanceof TypeError || (error instanceof Error && /failed to fetch|network/i.test(error.message))) {
		return `ระบบยังไม่พร้อม - เช็กการเชื่อมต่อที่ ${config.apiBase}/health แล้วลองรีเฟรชอีกครั้ง`;
	}
	if (error instanceof api.ApiError) {
		return `โหลดตอนล่าสุดไม่ได้ (${error.status}) เช็ก ${config.apiBase}/readyz แล้วลองใหม่`;
	}
	return "โหลดตอนล่าสุดไม่ได้ - เช็กระบบเบื้องหลังแล้วลองรีเฟรชอีกครั้ง";
}

function createUniqueLayerId(seen: string[]): string {
	let id = crypto.randomUUID();
	while (seen.includes(id)) {
		id = crypto.randomUUID();
	}
	seen.push(id);
	return id;
}

function importApiErrorCopy(errorText: string): string {
	const normalized = errorText.trim().toLowerCase();
	if (!normalized) return "";
	if (
		normalized.includes("validation failed")
		|| normalized.includes("validation_failed")
		|| normalized.includes("invalid translation payload")
		|| normalized.includes("expected entries or items")
	) return "โครงสร้าง JSON ไม่ตรงรูปแบบที่รองรับ";
	if (normalized.includes("invalid json body")) return "ไฟล์ JSON อ่านไม่ได้";
	if (normalized.includes("target page not found")) return "หน้าเป้าหมายไม่มีในตอนนี้";
	if (normalized.includes("mapping source not found") || normalized.includes("expected source page or image identifier")) {
		return "ต้นทาง JSON ที่เลือกไม่มีในไฟล์นี้";
	}
	if (normalized.includes("duplicate target page mapping")) return "มีหน้าในตอนซ้ำในการจับคู่";
	if (normalized.includes("duplicate source mapping")) return "มีต้นทาง JSON ซ้ำในการจับคู่";
	if (normalized.includes("project not found")) return "ไม่พบตอนนี้แล้ว";
	return errorText.trim();
}

function repairDuplicateLayerIdsInList<T extends { id: string }>(layers: T[] | undefined): number {
	if (!layers?.length) return 0;
	const seen: string[] = [];
	let repaired = 0;
	for (const layer of layers) {
		if (!layer.id || seen.includes(layer.id)) {
			layer.id = createUniqueLayerId(seen);
			repaired += 1;
			continue;
		}
		seen.push(layer.id);
	}
	return repaired;
}

function keepLastLayerById<T extends { id: string }>(layers: T[] | undefined): T[] {
	if (!layers?.length) return [];
	const order: string[] = [];
	const byId = new Map<string, T>();
	for (const layer of layers) {
		if (!layer.id) continue;
		if (!byId.has(layer.id)) order.push(layer.id);
		byId.set(layer.id, layer);
	}
	return order.map((id) => byId.get(id)).filter((layer): layer is T => Boolean(layer));
}

export function formatTranslationImportStatus(result: TranslationImportResult): string {
	const skipped = result.skipped ?? 0;
	const pages = result.pages ?? [];
	const orderMapped = result.orderMapped ?? 0;
		const base = pages.length > 1
			? `Import ${result.imported} เลเยอร์ข้อความครบ ${pages.length} หน้า`
			: `Import ${result.imported} เลเยอร์ข้อความ`;
	const reasonLabels: Record<string, string> = {
		invalid_entry: "รายการไม่ถูกต้อง",
		page_not_found: "หน้าไม่ตรง",
			invalid_layer: "เลเยอร์ข้อความไม่ถูกต้อง",
	};
	const skippedReasons = Object.entries(result.skippedByReason ?? {})
		.filter(([, count]) => count > 0)
		.map(([reason, count]) => `${count} ${reasonLabels[reason] ?? reason.replace(/_/g, " ")}`);
	const skippedText = skipped
		? `, ข้าม ${skipped} รายการ${skippedReasons.length ? ` (${skippedReasons.join(", ")})` : ""}`
		: "";
	if (result.imported <= 0) {
		const recoveryText = skipped
			? `: ข้าม ${skipped} รายการ${skippedReasons.length ? ` (${skippedReasons.join(", ")})` : ""}`
			: result.sourceFiltered
				? `: ต้นทาง JSON ที่เลือกไม่ตรง ${result.sourceFiltered} รายการ`
				: "";
			return `Importไม่พบเลเยอร์ข้อความที่ใช้ได้${recoveryText}`;
	}
	const orderSamples = (result.orderMappedPaths ?? []).slice(0, 2);
	const orderText = orderMapped
		? `; จับคู่ชื่อไฟล์ไม่ตรง ${orderMapped} รายการตามลำดับหน้า${
			orderSamples.length
				? ` (${orderSamples.join(", ")}${(result.orderMappedPaths?.length ?? 0) > orderSamples.length ? ", ..." : ""})`
				: ""
		}`
		: "";
	const sourceMapped = result.sourceMapped;
	const sourceText = sourceMapped
		? `; จับคู่ ${sourceMapped.sourcePageNumber ? `หน้า JSON ${sourceMapped.sourcePageNumber}` : sourceMapped.sourceImage ? sourceMapped.sourceImage : "ต้นทาง JSON ที่เลือก"} ไปหน้า ${sourceMapped.targetPageIndex + 1}${sourceMapped.ignoredEntries ? `, ข้ามต้นทางอื่น ${sourceMapped.ignoredEntries} รายการ` : ""}`
		: "";
	const sourceMappings = result.sourceMappings ?? [];
	const sourceMappingsText = sourceMappings.length
		? `; จับคู่ต้นทาง JSON เอง ${sourceMappings.length} หน้า${
			sourceMappings.slice(0, 2).map((mapping) =>
				` ${mapping.sourcePageNumber ? `หน้า JSON ${mapping.sourcePageNumber}` : mapping.sourceImage ?? "ต้นทางที่เลือก"} -> หน้า ${mapping.targetPageIndex + 1}`,
			).join(",")
		}${sourceMappings.length > 2 ? ", ..." : ""}`
		: "";
	const pageText = pages.length
		? ` (${pages.slice(0, 3).map((page) => `${page.originalName || page.imageName}: ${page.imported}`).join(", ")}${pages.length > 3 ? ", ..." : ""})`
		: "";
	return `${base}${skippedText}${orderText}${sourceText}${sourceMappingsText}${pageText}`;
}

/**
 * STABLE status-message codes. `statusMsg` stays a rendered (Thai) string for
 * display, but a small set of statuses are ALSO matched by UI chrome to drive
 * layout decisions (the workspace save-recovery card, the empty-workspace copy,
 * the export-readiness override, the local-summary-only library gate). Those
 * consumers used to `.startsWith`/`.includes`/regex/`===` the rendered Thai —
 * fragile + i18n-hostile. They now compare on this stable code via
 * `projectStore.statusMsgCode` instead, so the rendered text can be localized
 * freely without breaking the match. Every plain `statusMsg = "…"` write resets
 * the code to null; the few code-bearing statuses are set together via
 * `setStatus(text, code)`.
 */
export type StatusMsgCode =
	// projectSwitchSaveFailureStatus(): old work retained, new project NOT opened
	// (matched by StatusBar + WorkspaceShell save-recovery card, was startsWith
	// "งานเดิมยังอยู่"/"ยังไม่เปิดงานใหม่").
	| "prev_work_present"
	// Idle/empty-workspace status (was the "เปิดโฟลเดอร์เพื่อเริ่มงาน" Set match).
	| "open_folder_to_start"
	// Export-readiness statuses (gate messages, debug "ตอนพร้อม Export แล้ว") —
	// was the StatusBar /พร้อม\s*Export/ | /Export พร้อม/ regex.
	| "export_readiness"
	// Chapter opened from a local summary only (set by WorkspaceShell, matched by
	// WorkspaceLibraryView — was `statusMsg === summaryOnlyStatus`).
	| "summary_only_loaded"
	// A save-failure status produced by saveState() (was the internal recordExportRun
	// startsWith "Save failed"/"บันทึกไม่สำเร็จ" guard).
	| "save_failed";

class ProjectStore {
	// ── Reactive State ───────────────────────────────────────
	project = $state<ProjectState | null>(null);
	// Backing state for `statusMsg`/`statusMsgCode`. `statusMsg` is the rendered
	// (Thai) string; `statusMsgCode` is the stable companion code for the handful
	// of statuses UI chrome matches on. A plain `statusMsg = "…"` assignment resets
	// the code (see the setter); code-bearing statuses set both via `setStatus()`.
	#statusMsg = $state("เปิดโฟลเดอร์เพื่อเริ่มงาน");
	#statusMsgCode = $state<StatusMsgCode | null>("open_folder_to_start");

	get statusMsg(): string {
		return this.#statusMsg;
	}

	// Plain assignment (`this.statusMsg = "…"`) is the free-form case: it clears the
	// companion code so a stale code can never outlive its message. Code-bearing
	// statuses MUST go through `setStatus(text, code)` instead.
	set statusMsg(value: string) {
		this.#statusMsg = value;
		this.#statusMsgCode = null;
	}

	/** Stable code for the current status (null for free-form messages). */
	get statusMsgCode(): StatusMsgCode | null {
		return this.#statusMsgCode;
	}

	/** Set the rendered status text together with its stable code. */
	setStatus(text: string, code: StatusMsgCode | null): void {
		this.#statusMsg = text;
		this.#statusMsgCode = code;
	}
	/**
	 * Active Language Track selection (per-language model, Shape B). This is the
	 * single source of truth for "which target language is being edited/previewed",
	 * and is kept as the BACK-COMPAT alias for the historical `targetLang` scalar:
	 * the ~30 existing consumers that read `projectStore.targetLang` keep working
	 * unchanged because this still resolves to the active track's language. For a
	 * single-language / legacy project (no `targetLangs` in state) it behaves exactly
	 * as before — there is one track and this equals `project.targetLang`.
	 *
	 * Read the richer accessors `targetLangs` / `activeTargetLang` below for the
	 * multi-track view. `setTargetLang()` switches the active track (clamped to an
	 * existing track) and keeps this alias in sync.
	 */
	targetLang = $state(config.defaultLang);
	versions = $state<ProjectVersion[]>([]);
	versionsLoading = $state(false);
	versionDetail = $state<ProjectVersionDetail | null>(null);
	versionDetailLoading = $state(false);
	versionReviewLoading = $state(false);
	// W3.9: visual version-diff comparison state.
	versionComparison = $state<VersionComparison | null>(null);
	versionComparisonLoading = $state(false);
	recentProjects = $state<ProjectSummary[]>([]);
	recentProjectsLoading = $state(false);
	recentProjectsError = $state<string | null>(null);
	tasks = $state<WorkflowTask[]>([]);
	activityLog = $state<ActivityEvent[]>([]);
	workflowLoading = $state(false);
	comments = $state<ProjectComment[]>([]);
	commentsLoading = $state(false);
	reviewDecisions = $state<PageReviewDecision[]>([]);
	reviewDecisionsLoading = $state(false);
	reviewAssignments = $state<ReviewAssignment[]>([]);
	reviewAssignmentsLoading = $state(false);
	revisionRequests = $state<RevisionRequest[]>([]);
	revisionRequestsLoading = $state(false);
	workspaceFeed = $state<WorkspaceFeedItem[]>([]);
	workspaceMessages = $state<WorkspaceMessage[]>([]);
	workspaceHubLoading = $state(false);
	currentWorkspaceMember = $state<WorkspaceMemberRecord | null>(null);
	currentWorkspaceMemberLoading = $state(false);
	// The signed-in viewer's SERIES-level duty roles on the open project's story
	// (story assignments — a member can hold SEVERAL, e.g. translator + typesetter).
	// The board/editor duty caps union these so a multi-duty member can actually
	// claim every duty they're assigned, matching the backend inbox resolver
	// (resolveViewerDutyTaskTypes). Empty when solo / no workspace / no story.
	viewerStoryDutyRoles = $state<string[]>([]);
	aiReviewMarkers = $state<AiReviewMarker[]>([]);
	aiReviewMarkersLoading = $state(false);
	// In-flight count of createAiReviewMarker server requests. Concurrent creates are real:
	// several AI jobs can finish around the same tick, each routing through
	// createMarkerForRunningJob → createAiReviewMarker. aiReviewMarkersLoading is a
	// REQUEST-scoped store flag (set true on entry), so it must clear when the LAST in-flight
	// create settles — not the first — and must clear UNCONDITIONALLY even if the open project
	// was replaced mid-create (same-id reload / draft-restore / switch). Gating that clear on
	// the captured project ref (the round-9 regression) wedged the AI panel in loading/readonly
	// whenever this.project was swapped before the request settled.
	private createAiReviewMarkerInFlight = 0;
	selectedAiReviewMarkerId = $state<string | null>(null);
	selectedProjectCommentId = $state<string | null>(null);
	selectedWorkflowTaskId = $state<string | null>(null);
	selectedQcIssueId = $state<string | null>(null);
	selectedReviewDecisionId = $state<string | null>(null);
	assetLoadErrors = $state<Record<number, PageAssetLoadErrorEntry>>({});
	saveSyncStatus = $state<SaveSyncStatus>("saved");
	saveErrorMessage = $state<string | null>(null);
	saveErrorKind = $state<SaveErrorKind | null>(null);
	/**
	 * C2/C3: true when ANOTHER user took over the page this tab was editing. The
	 * editor surfaces this as read-only ("you were taken over") so the displaced
	 * holder cannot keep editing + clobbering the new holder; their unsaved work is
	 * snapshotted into a recovery draft. Cleared when they leave / reopen the page.
	 */
	editingTakenOver = $state(false);
	lastSavedAt = $state<string | null>(null);
	savedPageRevisionId = $state<string | null>(null);
	batchExportStatus = $state<BatchExportStatus>("idle");
	batchExportProgress = $state<PageExportProgress | null>(null);
	batchExportMessage = $state("");
	/**
	 * Live progress for the chapter-setup upload (create-chapter / fill-empty).
	 * `null` when idle. `phase` distinguishes the cover upload from the page
	 * batches; `done`/`total` count uploaded page batches (or 1/1 for the cover)
	 * so the dialog can show a real determinate progress bar instead of a spinner.
	 */
	chapterUploadProgress = $state<{
		phase: "pages" | "cover";
		done: number;
		total: number;
		uploadedFiles: number;
		totalFiles: number;
	} | null>(null);
	// Live progress for the BULK-IMPORT dialog (folder/multi-file import with
	// keep/merge/split). Separate from chapterUploadProgress so the bulk-import
	// dialog renders its own determinate bar. `uploadedFiles` is a fractional
	// source-file estimate blended from per-batch byte progress (keep mode) or the
	// single request's byte fraction (merge/split); `phase: "processing"` flips on
	// once bytes are sent and the server is stitching/moderating.
	bulkImportProgress = $state<{
		phase: "uploading" | "processing";
		uploadedFiles: number;
		totalFiles: number;
	} | null>(null);
	// Resume state for an interrupted batched KEEP-mode bulk import (keyed by
	// projectId), mirroring pendingFillUploads. A mid-batch failure stashes the
	// already-committed prefix so a same-session retry of bulkImportPages resumes
	// from the failed batch instead of re-uploading (and re-metering) committed
	// pages — and the committed pages it DID upload are reconciled into local state
	// on failure so they are neither orphaned (billed but invisible) nor
	// double-imported on retry. merge/split are whole-request (no partial commit),
	// so they reconcile via a server asset reload instead of resuming.
	private pendingBulkImports = new Map<string, { files: readonly File[]; progress: ImageUploadProgressState }>();
	// Resume state for an interrupted batched fill-existing upload (keyed by
	// projectId). When a batch fails mid-way, the already-committed pages are stashed
	// here so a RETRY of `fillEmptyProjectWithPages` resumes from the failed batch
	// instead of re-uploading (and re-metering) the committed pages. NOT $state — it
	// is internal bookkeeping, never rendered. The create path uses orphan-delete
	// cleanup instead (a brand-new project is deleted wholesale on failure), so it
	// does not record here.
	//
	// The stash holds the ACTUAL in-memory `File[]` of the failed attempt (not a
	// serializable fingerprint). A retry resumes only when it presents the SAME `File`
	// object references for the committed prefix (see `imageUploadSelectionResumes`),
	// which is collision-proof: a fresh selection always yields new `File` objects, so
	// it can never reuse a stale committed prefix. This Map is purely in-memory and
	// never persisted, so the original `File` objects are still live on a same-session
	// retry; a reload clears the Map and the next fill uploads from scratch.
	private pendingFillUploads = new Map<string, { files: readonly File[]; progress: ImageUploadProgressState }>();
	imageAssets = $state<ProjectImageAssetSummary[]>([]);
	imageAssetsProjectId = $state<string | null>(null);
	imageAssetsLoading = $state(false);
	imageAssetsError = $state<string | null>(null);
	pageSetChangedNotice = $state<PageSetChangedNotice | null>(null);
	// Storage usage for the open project — the SAME source the usage dashboard
	// reads (listProjectImageAssets returns it) — so the in-editor asset library
	// can show a real space-used total and update it after a delete.
	imageAssetsStorageQuota = $state<StorageQuotaSummary | null>(null);
	// Per-asset delete in-flight marker (imageId) so the library can disable the
	// row + show progress without blocking the rest of the UI.
	deletingImageAssetId = $state<string | null>(null);
	exportDownloads = $state<Record<string, { blob: Blob; filename: string }>>({});
	conflictRecoveryDrafts = $state<LocalConflictRecoveryDraft[]>([]);
	localImageUrls = $state<Record<string, string>>({});

	// Destructive-edit blob GC queue (P1 storage-bloat fix). Each brush / heal /
	// clone / bubble-clean commit on a page background OR an image layer mints a
	// BRAND-NEW baked image id (full re-encoded PNG) and uploads it, superseding the
	// prior edit blob. The CoW ref-count on the superseded blob stays inflated until
	// its asset record is deleted, so without this the orphan-blob GC never reclaims
	// it and one page edited N times keeps ~N full baked images on disk forever.
	//
	// We CANNOT delete the superseded id at upload time: the new id only lands in the
	// SERVER's project state on the next /save, so a delete-now would race the server
	// state and (correctly) 409 as still-referenced. Instead we enqueue the superseded
	// id and reconcile it AFTER a successful saveProject(), when the durable server
	// state references the new ids — and we use a reference-SAFE (non-force) delete so
	// the backend's own page/layer/track/marker reference check is the final gate.
	private supersededEditImageIds = new Set<string>();
	private reconcilingSupersededEditImages = false;
	private pageSetChangedRealtimeUnsub: (() => void) | null = null;
	/** Stamped by THIS tab's own page-set mutations to suppress their echo event. */
	private lastOwnPageSetMutationAt = 0;

	// P1 UNDO-404 DATA-LOSS GUARD. A superseded edit blob may STILL be reachable via the
	// live editor undo/redo history: BrushBackgroundCommand.undo() reloads the PRIOR
	// background URL (the very blob this GC would reclaim), so deleting it 404s the undo
	// and silently loses the user's pre-stroke pixels. Saved project state does NOT
	// include live undo/redo history, so the backend's reference-check can't see this —
	// the editor registers a provider here that returns every durable image URL its live
	// history can still restore. We skip GC of any id whose URL is in that set. Once the
	// history is cleared/disposed (page switch, project close) or the command is evicted,
	// the id drops out of the set and becomes GC-eligible on the next save sweep.
	private liveHistoryImageRefsProvider: (() => string[]) | null = null;

	private dirtyVersion = 0;
	private saveStartedDirtyVersion = 0;
	private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
	private autosaveInFlight = false;
	private autosaveInFlightPromise: Promise<void> | null = null;
	// Single-flight gate for ALL saves (direct saveState() AND the autosave's internal
	// saveState()). While a save POST is running, this holds the in-flight promise so a
	// second saveState() AWAITS it and then RE-EVALUATES dirtiness against the
	// fingerprint the first save refreshed — instead of POSTing concurrently with the
	// same (now-stale) projectBaseFingerprint and self-inflicting a CAS 409. See
	// saveState() for the full contract.
	private saveInFlightPromise: Promise<void> | null = null;
	private isLoadingPage = false;
	private pageLoadInFlightKey: string | null = null;
	private pageLoadInFlightEditor: any = null;
	private pageLoadInFlightPromise: Promise<boolean> | null = null;
	private pageLoadGeneration = 0;
	private projectOpenGeneration = 0;
	// Hooks run inside openProject() AFTER the switch to a DIFFERENT projectId is
	// COMMITTED (the new project's state has been assigned and the open generation is
	// still current), never before — so a switch that fails at the save/lease gate
	// leaves the outgoing project (and its polls) fully intact. The AI jobs store
	// registers here to tear down the OUTGOING project's now-orphaned poll intervals
	// so they don't keep hitting the protected status endpoint after the switch. The
	// generation guard (captured per-poll, keyed on projectId) is the robust net that
	// stops any stale CLIENT-side write into the wrong open project; this hook is the
	// surgical "stop the timer too" so we don't keep polling a job whose UI context
	// is gone.
	private projectSwitchHooks = new Set<(previousProjectId: string | null, nextProjectId: string) => void>();
	// Hooks fired when the open project is RESTORED in place after an aborted switch
	// (the create-flow rollback). The AI jobs store registers resumePolling here to
	// re-arm poll intervals for the restored project's still-running rows: during the
	// deferred-hook create window `this.project` already pointed at the NEW id, so the
	// restored project's poll ticks self-cleared their own intervals (isProjectContext-
	// Current failed). Restoring the project leaves those rows processing/pending with
	// NO live interval; this seam re-arms them. Decoupled via a hook (not a static
	// import) for the same reason as projectSwitchHooks — to keep the AI store out of
	// the project store's static import graph (avoids a cycle + keeps store tests clean).
	private resumePollingHooks = new Set<(editor: any) => void>();
	// Hooks fired BEFORE a brand-new-project create flow ASSIGNS the new project id (so
	// `this.project` still points at the project being left). The AI jobs store registers
	// here to deep-copy the previous project's queue rows into an opaque snapshot. If the
	// create later FAILS and rolls back, the snapshot is handed to the resume seam so any
	// row that was DISCARDED during the create window (a submit continuation that resolved
	// while `this.project` had already flipped to the new id saw "switched away" and dropped
	// its queue row) can be re-inserted before resumePolling re-arms it. Without this, a
	// rollback could only re-arm SURVIVING rows, orphaning an accepted+charged job. The
	// snapshot is opaque (unknown[]) so the project store stays decoupled from BatchJob.
	// Decoupled via a hook (not a static import) for the same reason as the other two seams.
	private snapshotRowsHooks = new Set<(previousProjectId: string) => unknown[]>();
	// Hooks fired on the create-flow ROLLBACK path, BEFORE the resume seam, with the rows
	// captured by the snapshot seam. The AI jobs store re-inserts any snapshotted row whose
	// id is no longer present (discarded mid-create) WITHOUT re-arming intervals — the
	// resume seam that runs immediately after re-arms every restored + surviving row.
	private restoreRowsHooks = new Set<(rows: unknown[]) => void>();
	private projectBaseFingerprint: string | null = null;
	private projectBaseSnapshot: ProjectState | null = null;
	private pendingAiResultApplyMarkers = new Map<string, PendingAiResultApplyMarker>();
	private recentProjectsRequest: Promise<ProjectSummary[]> | null = null;
	// The workspace the in-flight (or last-issued) recent-projects request was
	// scoped to. A workspace switch must NOT reuse another workspace's in-flight
	// request (that would show the previous workspace's Library), so dedup keys on
	// this — a request for a different workspace starts a fresh fetch.
	private recentProjectsRequestWorkspaceId: string | undefined = undefined;
	private recentProjectsRequestPreserveOrder = false;
	// Monotonic token identifying the LATEST intended Library load. Bumped on every
	// `loadRecentProjects` call and on `clearRecentProjects` (a workspace switch
	// clears + reloads). After a fetch awaits, the resolving load compares the token
	// it captured at call time against this; if a newer load (or a clear) has since
	// run, the captured token is stale and the late response is DROPPED rather than
	// allowed to overwrite `recentProjects`. This is what stops a slow workspace-A
	// response, resolving AFTER the user switched to workspace B and B already
	// loaded, from cross-rendering A's projects under B. Only the latest load for
	// the current scope wins.
	private recentProjectsLoadToken = 0;

	// ── Derived ──────────────────────────────────────────────

	/**
	 * The project's active Language Tracks (per-language model). Backfilled from the
	 * loaded `ProjectState` via the pure `listTracks` helper, so a single-language /
	 * legacy project (no `targetLangs`) resolves to `[targetLang]` — exactly the
	 * pre-per-language behavior. With no project loaded, falls back to the alias.
	 */
	get targetLangs(): string[] {
		return this.project ? listTracks(this.project) : [this.targetLang];
	}

	/**
	 * The currently selected Language Track. This is the canonical name for what the
	 * `targetLang` alias holds; they are always equal. Kept as a getter so callers
	 * migrating off the alias (PR-8) read an intention-revealing name.
	 */
	/** Current page's translator script slots for the ACTIVE language track. */
	get currentPageTranslationScriptSlots() {
		const page = this.project?.pages[this.project.currentPage];
		return page ? trackScriptSlots(page, this.activeTargetLang) : [];
	}

	/** Current page's translation handoff for the ACTIVE language track. */
	get currentPageTranslationHandoff() {
		const page = this.project?.pages[this.project.currentPage];
		return page ? (pageOutput(page, this.activeTargetLang).translationHandoff ?? null) : null;
	}

	/** Route a script-slot write to the ACTIVE track (flat for default lang). */
	private writeActiveTrackScriptSlots(page: Page, slots: TranslationScriptSlot[]): void {
		const lang = this.activeTargetLang;
		if (!this.project || trackWritesFlat({ targetLang: this.project.targetLang }, lang)) {
			page.translationScriptSlots = slots;
			return;
		}
		page.languageOutputs = writeTrackScriptSlots(page, lang, slots);
	}

	/** Route a translation-handoff write to the ACTIVE track (flat for default lang). */
	private writeActiveTrackTranslationHandoff(page: Page, handoff: PageTranslationHandoff): void {
		const lang = this.activeTargetLang;
		if (!this.project || trackWritesFlat({ targetLang: this.project.targetLang }, lang)) {
			page.translationHandoff = handoff;
			return;
		}
		page.languageOutputs = writeTrackTranslationHandoff(page, lang, handoff);
	}

	get activeTargetLang(): string {
		return this.targetLang;
	}

	get canGoPrev(): boolean {
		return this.project !== null && !this.pageNavigationBusy && this.project.currentPage > 0;
	}

	get canGoNext(): boolean {
		return this.project !== null && !this.pageNavigationBusy && this.project.currentPage < this.project.pages.length - 1;
	}

	get pageNavigationBusy(): boolean {
		return this.isLoadingPage || this.saveSyncStatus === "saving";
	}

	get isBatchExporting(): boolean {
		return this.batchExportStatus === "checking" || this.batchExportStatus === "exporting";
	}

	get exportBlockedBySaveConflict(): boolean {
		return this.saveSyncStatus === "error" && this.saveErrorKind === "conflict";
	}

	get pageLabel(): string {
		if (!this.project) return "-";
		if (this.project.pages.length === 0) return "ยังไม่มีหน้า";
		return `${this.project.currentPage + 1}/${this.project.pages.length}`;
	}

	get readingDirection(): ReadingDirection {
		return normalizeReadingDirection(this.project?.readingDirection);
	}

	get projectName(): string {
		return this.project ? `งาน ${this.project.name}` : "";
	}

	get textStylePresets(): TextStylePreset[] {
		return getTextStylePresets(this.project?.textStylePresets);
	}

	get creditPresets(): CreditPreset[] {
		return getCreditPresets(this.project?.creditPresets);
	}

	get qcReport() {
		return buildProjectQcReport(this.project, this.tasks, this.comments, this.aiReviewMarkers, {
			assets: this.imageAssets,
			assetInventoryKnown: this.hasCurrentProjectPageAssetInventory(),
			localImageIds: Object.keys(this.localImageUrls),
		});
	}

	get workInbox() {
		return buildWorkInbox(this.project, this.tasks, this.comments, this.aiReviewMarkers, this.qcReport);
	}

	get currentPageAiReviewMarkers(): AiReviewMarker[] {
		if (!this.project) return [];
		return this.aiReviewMarkers.filter((marker) => marker.pageIndex === this.project!.currentPage);
	}

	get currentPageReviewDecisions(): PageReviewDecision[] {
		if (!this.project) return [];
		return this.reviewDecisions.filter((decision) => decision.pageIndex === this.project!.currentPage);
	}

	get currentPageWorkspaceFeed(): WorkspaceFeedItem[] {
		if (!this.project) return [];
		return this.workspaceFeed.filter((item) => item.pageIndex === undefined || item.pageIndex === this.project!.currentPage);
	}

	get exportRuns(): ExportRun[] {
		return normalizeExportRuns(this.project?.exportRuns);
	}

	canDownloadExportRun(runId: string): boolean {
		const run = this.exportRuns.find((item) => item.id === runId);
		return Boolean(this.exportDownloads[runId] || run?.artifact);
	}

	canDeleteExportArtifact(runId: string): boolean {
		const run = this.exportRuns.find((item) => item.id === runId);
		return Boolean(run?.artifact);
	}

	async downloadExportRun(runId: string): Promise<void> {
		const download = this.exportDownloads[runId];
		if (download) {
			this.downloadBlob(download.blob, download.filename);
			this.statusMsg = `ดาวน์โหลด ${download.filename} แล้ว`;
			return;
		}

		if (!this.project) return;
		const run = this.exportRuns.find((item) => item.id === runId);
		if (!run?.artifact) {
			this.statusMsg = "ไฟล์ Export อยู่เฉพาะแท็บนี้ สร้างใหม่เพื่อดาวน์โหลดอีกครั้ง";
			return;
		}

		try {
			this.statusMsg = `กำลังดาวน์โหลด ${run.artifact.filename || run.filename}...`;
			const result = await api.downloadExportArtifact(this.project.projectId, run.id);
			this.rememberExportDownload(run.id, result.blob, result.filename);
			this.downloadBlob(result.blob, result.filename);
			this.statusMsg = `ดาวน์โหลด ${result.filename} แล้ว`;
		} catch (error) {
			if (this.isMissingExportArtifactError(error)) {
				await this.markExportArtifactMissing(run);
				return;
			}
			console.error("[ProjectStore] downloadExportRun error:", error);
			this.statusMsg = `ดาวน์โหลด Export ไม่ได้: ${this.errorMessage(error, "สร้าง Export ใหม่อีกครั้ง")}`;
		}
	}

	private isMissingExportArtifactError(error: unknown): boolean {
		return error instanceof api.ApiError && error.status === 404;
	}

	private async markExportArtifactMissing(run: ExportRun): Promise<void> {
		const artifactError = "ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ: สร้าง Export ใหม่อีกครั้ง";
		let markerPersisted = true;
		this.forgetExportDownload(run.id);
		if (this.replaceExportRun({ ...run, artifact: undefined, artifactError })) {
			try {
				await this.saveState();
			} catch (saveError) {
				markerPersisted = false;
				console.warn("[ProjectStore] persist missing export artifact marker failed:", saveError);
			}
		}
		this.statusMsg = markerPersisted
			? `ดาวน์โหลด Export ไม่ได้: ${artifactError}`
			: `ดาวน์โหลด Export ไม่ได้: ${artifactError}; บันทึกสถานะไฟล์หายไม่สำเร็จ`;
	}

	async deleteExportArtifact(runId: string): Promise<void> {
		if (!this.project) return;
		const run = this.exportRuns.find((item) => item.id === runId);
		if (!run?.artifact) {
			this.statusMsg = "ไม่มีไฟล์ Export ที่เก็บไว้ให้ลบ";
			return;
		}

		try {
			this.statusMsg = `กำลังลบไฟล์ Export ${run.artifact.filename || run.filename}...`;
			const result = await api.deleteExportArtifact(this.project.projectId, run.id);
			this.forgetExportDownload(run.id);
			if (result.exportRun) {
				this.replaceExportRun(result.exportRun, { persisted: true });
			} else {
				if (this.replaceExportRun({ ...run, artifact: undefined })) {
					await this.saveState();
				}
			}
			if (result.storageQuota) {
				this.dispatchStorageQuotaUpdated(this.project.projectId, result.storageQuota);
			}
			this.statusMsg = `ลบไฟล์ Export ของ ${run.filename} แล้ว`;
		} catch (error) {
			console.error("[ProjectStore] deleteExportArtifact error:", error);
			this.statusMsg = `ลบไฟล์ Export ไม่สำเร็จ: ${this.errorMessage(error, "ลองอีกครั้ง")}`;
		}
	}

	get selectedAiReviewMarker(): AiReviewMarker | null {
		if (!this.selectedAiReviewMarkerId) return null;
		return this.aiReviewMarkers.find((marker) => marker.id === this.selectedAiReviewMarkerId) ?? null;
	}

	get selectedProjectComment(): ProjectComment | null {
		if (!this.selectedProjectCommentId) return null;
		return this.comments.find((comment) => comment.id === this.selectedProjectCommentId) ?? null;
	}

	get selectedWorkflowTask(): WorkflowTask | null {
		if (!this.selectedWorkflowTaskId) return null;
		return this.tasks.find((task) => task.id === this.selectedWorkflowTaskId) ?? null;
	}

	get selectedReviewDecision(): PageReviewDecision | null {
		if (!this.selectedReviewDecisionId) return null;
		return this.reviewDecisions.find((decision) => decision.id === this.selectedReviewDecisionId) ?? null;
	}

	get currentPageAssetError(): PageAssetLoadError | null {
		if (!this.project) return null;
		return this.getPageAssetLoadError(this.project.currentPage);
	}

	get currentPageAssetErrors(): PageAssetLoadError[] {
		if (!this.project) return [];
		return this.getPageAssetLoadIssues(this.project.currentPage);
	}

	get currentPageAssetIntegrity(): PageAssetIntegrity | null {
		if (!this.project) return null;
		return this.getPageAssetIntegrity(this.project.currentPage);
	}

	get currentPageRevisionId(): string | null {
		if (!this.project) return null;
		const page = this.project.pages[this.project.currentPage];
		return page ? createPageRevisionId(page, this.project.currentPage) : null;
	}

	get shortPageRevisionId(): string {
		return this.currentPageRevisionId?.split("-").at(-1)?.slice(0, 7) ?? "none";
	}

	get saveSyncLabel(): string {
		return saveSyncStatusLabel(this.saveSyncStatus);
	}

	get saveSyncDetail(): string {
		if (!this.project) return "ยังไม่ได้เปิดงาน";
			if (this.saveSyncStatus === "error") return this.saveErrorMessage ?? "บันทึกครั้งล่าสุดไม่สำเร็จ";
			if (this.saveSyncStatus === "saving") return "กำลังบันทึกสถานะงานล่าสุด";
			if (this.saveSyncStatus === "unsaved") return `ชุดแก้ไข ${this.shortPageRevisionId} มีงานแก้ในเครื่อง`;
			return this.lastSavedAt
				? `บันทึกชุดแก้ไข ${this.shortPageRevisionId} เวลา ${new Date(this.lastSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
				: `บันทึกชุดแก้ไข ${this.shortPageRevisionId}`;
	}

	// ── Actions ──────────────────────────────────────────────

	setStatusMsg(msg: string, code: StatusMsgCode | null = null) { this.setStatus(msg, code); }

	/**
	 * Trim a credit name/text for inclusion in a deleted-credit status line. Kept
	 * here (with the status producers, off the i18n ratchet) so the LayersModePanel
	 * consumer never builds the Thai status string itself — it just hands the raw
	 * value over and the store emits the (out-of-batch #492) Thai status text.
	 */
	#creditStatusName(value: string | undefined): string {
		const trimmed = value?.trim();
		if (!trimmed) return "เครดิตที่เลือก";
		return trimmed.length > 32 ? `${trimmed.slice(0, 32)}...` : trimmed;
	}

	/** Status line for "deleted the selected TEXT credit layer". */
	setDeletedTextCreditStatus(creditText: string | undefined): void {
		this.setStatusMsg(`ลบเครดิตข้อความที่เลือกแล้ว: ${this.#creditStatusName(creditText)}`);
	}

	/** Status line for "deleted the selected IMAGE credit layer". */
	setDeletedImageCreditStatus(creditName: string | undefined): void {
		this.setStatusMsg(`ลบรูปเครดิตที่เลือกแล้ว: ${this.#creditStatusName(creditName)}`);
	}
	/**
	 * Switch the active Language Track, keeping the `targetLang` alias in sync.
	 *
	 * Back-compat: a single-language / legacy project (no `targetLangs` declared) has
	 * no track set to clamp against, so this behaves EXACTLY as the historical scalar
	 * setter — the requested lang is accepted verbatim and nothing is written into the
	 * saved project state (autosave/fingerprint unchanged).
	 *
	 * Multi-track project: the requested lang is clamped to an EXISTING track (via the
	 * pure `activeTrack` helper) — this method never creates a track (creation is the
	 * PR-4 management API), so an unknown lang falls back to the default track. The
	 * resolved selection is persisted to `project.activeTargetLang` so a track switch
	 * round-trips through save/load.
	 */
	/**
	 * Resolver for the live canvas editor, registered by the editor store on create
	 * (project.svelte.ts must NOT import the editor store — that would be a circular
	 * import — so the editor store pushes a getter in instead). Lets `setTargetLang`
	 * flush + reload canvas text on a track switch without an editor argument.
	 */
	private activeEditorResolver: (() => any) | null = null;

	/** Editor store calls this on create so the store can reach the live editor. */
	registerActiveEditorResolver(resolver: (() => any) | null): void {
		this.activeEditorResolver = resolver;
	}

	setTargetLang(lang: string, editor?: any) {
		const resolvedEditor = editor ?? this.activeEditorResolver?.() ?? null;
		const tracks = this.project?.targetLangs;
		const isMultiTrack = Array.isArray(tracks) && tracks.length > 0;
		if (!isMultiTrack) {
			// No declared tracks → old permissive behavior, no state mutation.
			this.targetLang = lang;
			return;
		}
		// activeTrack() returns the requested lang when it is a real track, else clamps
		// to the project's default lang — so we never introduce a non-existent track.
		const next = activeTrack({
			targetLang: this.project!.targetLang,
			targetLangs: tracks,
			activeTargetLang: lang,
		});
		const activeTrackChanged = this.project!.activeTargetLang !== next;
		if (!activeTrackChanged) {
			// Re-selecting the active track: keep the alias in sync but do nothing else
			// (no flush/reload/dirty) so it stays a no-op.
			this.targetLang = next;
			this.project!.activeTargetLang = next;
			return;
		}

		// 1) FLUSH in-flight edits to the CURRENT track BEFORE switching, so they land
		//    in the track they were typed into (the active lang still points at it here).
		if (resolvedEditor && typeof resolvedEditor.getAllTextLayers === "function") {
			const page = this.project!.pages[this.project!.currentPage];
			if (page) this.writeActiveTrackTextLayers(page, resolvedEditor.getAllTextLayers());
		}

		// 2) SWITCH the active track + persist (autosave / project-switch durable).
		this.targetLang = next;
		this.project!.activeTargetLang = next;
		this.markCurrentPageUnsaved();

		// 3) RELOAD the canvas text to the new track's content (image stays put). On a
		//    track's FIRST visit this materializes a seeded copy of the source layout
		//    into languageOutputs[next] so the translator edits a starting point, not a
		//    blank page — and the seed persists.
		if (resolvedEditor && typeof resolvedEditor.setTextLayers === "function") {
			this.reloadActiveTrackTextLayers(resolvedEditor);
		}
	}

	/**
	 * Swap the canvas text layers to the ACTIVE Language Track and persist the
	 * resolved layers back into the page. For a non-default track that has not been
	 * materialized yet, `trackTextLayers` backfills from the source layout (seed),
	 * and re-writing it through `writeActiveTrackTextLayers` MATERIALIZES that seed
	 * into `languageOutputs[lang]` so it survives reload.
	 */
	private reloadActiveTrackTextLayers(editor: any): void {
		if (!this.project) return;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return;
		const layers = trackTextLayers(page, this.activeTargetLang);
		// Guard the editor->store write-back fired by setTextLayers; we persist the
		// resolved/seeded layers explicitly below for deterministic materialization.
		const wasLoading = this.isLoadingPage;
		this.isLoadingPage = true;
		try {
			editor.setTextLayers(layers);
		} finally {
			this.isLoadingPage = wasLoading;
		}
		// Materialize the seed (non-default track) / no-op for the default track.
		this.writeActiveTrackTextLayers(page, layers);
	}

	/**
	 * Seed the active Language Track alias from a freshly loaded/created project, and
	 * return the resolved lang. Uses the persisted `activeTargetLang` when present
	 * (multi-track projects reopen on the track they were left on), else falls back to
	 * the default `targetLang`. Never mutates the project — purely sets the store alias.
	 *
	 * Back-compat: a single-language / legacy project has no `targetLangs`, so this
	 * resolves to its `targetLang` after normalization — byte-identical to the old
	 * `this.targetLang = normalizeTargetLanguage(project.targetLang, this.targetLang)`.
	 */
	private syncActiveTrackFromProject(
		state: Pick<ProjectState, "targetLang" | "targetLangs" | "activeTargetLang">,
		fallback = this.targetLang,
	): string {
		// Normalize the default lang exactly as the legacy scalar load did, so the
		// no-track fallback path (and thus saved/loaded behavior) is unchanged.
		const normalizedDefault = normalizeTargetLanguage(state.targetLang, fallback);
		const resolved = activeTrack({
			targetLang: normalizedDefault,
			targetLangs: state.targetLangs,
			activeTargetLang: state.activeTargetLang,
		});
		this.targetLang = resolved;
		return resolved;
	}
	selectAiReviewMarker(markerId: string | null): void { this.selectedAiReviewMarkerId = markerId; }
	selectProjectComment(commentId: string | null): void { this.selectedProjectCommentId = commentId; }
	selectWorkflowTask(taskId: string | null): void { this.selectedWorkflowTaskId = taskId; }
	selectQcIssue(issueId: string | null): void { this.selectedQcIssueId = issueId; }
	selectReviewDecision(decisionId: string | null): void { this.selectedReviewDecisionId = decisionId; }
	clearAssetLoadError(pageIndex = this.project?.currentPage ?? -1): void { this.clearPageAssetLoadError(pageIndex); }

	getPageAssetLoadIssues(pageIndex: number): PageAssetLoadError[] {
		return this.getPageAssetLoadErrors(pageIndex).map((error) => ({ ...error }));
	}

	getImageUrl(imageId: string): string {
		if (!this.project) return imageId;
		return this.localImageUrls[imageId] ?? api.imageUrl(this.project.projectId, imageId);
	}

	/**
	 * P1-d (docs/specs/non-destructive-edit-layers.md) — the BASE background image id
	 * to load/render for a page. INTENTIONAL + DATA-SAFE precedence:
	 *   - baked `page.edits.imageId` when present = a LEGACY page whose pixels were
	 *     already destructively baked (those pixels are unrecoverable, so we can NOT
	 *     reconstruct "original + edit-stack" for it — the baked PNG IS the base);
	 *   - else `page.imageId` = a NEW non-destructive page (original source as base).
	 * The page's `imageEditLayers[]` stack then composites ON TOP of whichever base via
	 * `setImageEditLayers(..., page.imageId)` — identical to the client export
	 * (`page-export.ts`) + backend export (`export-pipeline.ts pageRenderImageId`).
	 */
	private getPageImageId(page: Page): string {
		return page.edits?.imageId || page.imageId;
	}

	registerLocalImageUrl(imageId: string, imageUrl: string): void {
		const previousUrl = this.localImageUrls[imageId];
		if (previousUrl?.startsWith("blob:") && typeof URL !== "undefined") URL.revokeObjectURL(previousUrl);
		this.localImageUrls = { ...this.localImageUrls, [imageId]: imageUrl };
	}

	/**
	 * Register the editor's live undo/redo history image-ref provider (P1 undo-404 GC
	 * guard, {@link liveHistoryImageRefsProvider}). The editor store wires this once on
	 * init so the storage GC can avoid reclaiming a blob a live undo/redo would reload.
	 * Pass `null` to clear (editor teardown).
	 */
	registerLiveHistoryImageRefsProvider(provider: (() => string[]) | null): void {
		this.liveHistoryImageRefsProvider = provider;
	}

	/**
	 * True when `imageId` is still reachable via the LIVE editor undo/redo history, i.e.
	 * a BrushBackgroundCommand on the stack can reload it. The history holds durable
	 * IMAGE URLs (server urls / data: copies); we resolve this id to its URL and check
	 * membership. Deleting such a blob would 404 the undo/redo restore (P1 data-loss), so
	 * it must NOT be GC'd while reachable. Safe when no provider/project is set.
	 */
	private isImageIdReferencedByLiveHistory(imageId: string): boolean {
		const provider = this.liveHistoryImageRefsProvider;
		if (!provider) return false;
		let refs: string[];
		try {
			refs = provider();
		} catch {
			// Provider must never break GC; treat a failure as "no live refs known" would
			// be unsafe (could delete a live blob), so conservatively treat as referenced.
			return true;
		}
		if (refs.length === 0) return false;
		// History URLs are durable image URLs; resolve the id to its URL both via the
		// local cache and the canonical backend url so either form matches.
		const idUrl = this.getImageUrl(imageId);
		const backendUrl = this.project ? api.imageUrl(this.project.projectId, imageId) : null;
		for (const ref of refs) {
			if (!ref) continue;
			if (ref === idUrl || (backendUrl !== null && ref === backendUrl)) return true;
			// Defensive: a server url may carry query/suffix variants — match the id path.
			if (ref.includes(`/${imageId}`)) return true;
		}
		return false;
	}

	/** True when `imageId` is still referenced by any page/layer in the project. */
	private isImageIdReferenced(imageId: string): boolean {
		const pages = this.project?.pages;
		if (!pages) return false;
		for (const page of pages) {
			if (page.imageId === imageId || page.edits?.imageId === imageId) return true;
			for (const layer of page.imageLayers ?? []) {
				if (layer.imageId === imageId || layer.restoreImageId === imageId) return true;
			}
			// P1-b DATA-SAFETY — a non-destructive edit layer's tiny mask asset (and any
			// realized/baked patch asset) IS a live reference. Without this, evicting a
			// "stale" local url or a GC pass could drop a mask still composited at
			// reload/export → the clean silently disappears. Count every edit-layer asset.
			for (const editLayer of page.imageEditLayers ?? []) {
				// The edit layer's base source image id is also a live reference (it is the
				// background the stack composites over for new non-destructive pages).
				if (editLayer?.sourceImageId === imageId) return true;
				const payload = editLayer?.payload as
					| { maskAssetId?: string; realizedPatchAssetId?: string; patchAssetId?: string }
					| undefined;
				if (
					payload?.maskAssetId === imageId ||
					payload?.realizedPatchAssetId === imageId ||
					payload?.patchAssetId === imageId
				) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Drop a stale `localImageUrls` entry (revoking a `blob:` source). Page/layer
	 * brush commits MINT A NEW image id every stroke, so without eviction each
	 * stroke would leave its predecessor's full-res `data:`/`blob:` URL pinned in
	 * memory forever (P1.B: tens of MB per stroke on a 3000×4000 page → OOM). We
	 * keep at most the CURRENT image per page/layer by evicting the prior id once a
	 * newer commit supersedes it.
	 *
	 * No-op when the id is unset, equals the one we are about to keep (so eviction
	 * can't drop the entry we just wrote), or is STILL referenced by another
	 * page/layer (a base asset shared across surfaces must keep its local source).
	 */
	private evictLocalImageUrl(imageId: string | null | undefined, keep?: string): void {
		if (!imageId || imageId === keep) return;
		const previousUrl = this.localImageUrls[imageId];
		if (previousUrl === undefined) return;
		if (this.isImageIdReferenced(imageId)) return;
		if (previousUrl.startsWith("blob:") && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
			URL.revokeObjectURL(previousUrl);
		}
		const { [imageId]: _evicted, ...rest } = this.localImageUrls;
		this.localImageUrls = rest;
	}

	/**
	 * Queue a superseded destructive-edit blob id for backend GC after the next
	 * successful save (P1 storage-bloat fix — {@link supersededEditImageIds}). A
	 * brush / heal / clone / bubble-clean commit replaces a page-background or
	 * image-layer edit blob with a freshly re-encoded one, so the predecessor's bytes
	 * are dead weight once the new id is durably referenced.
	 *
	 * Only enqueues a real superseded id (not the one we just wrote, not a
	 * file-mode synthetic `brush-page-*.png` placeholder, and not an id still
	 * referenced elsewhere in the LOCAL project — a base asset shared across pages /
	 * layers must never be GC'd). The backend non-force delete re-checks references
	 * (including per-language tracks + AI markers) so this is only a fast pre-filter.
	 */
	private queueSupersededEditImageId(supersededImageId: string | null | undefined, keep: string): void {
		if (!supersededImageId || supersededImageId === keep) return;
		// File-mode synthetic ids never hit the backend asset store, and a still-live
		// id (shared base asset, or the same id re-committed) must be preserved.
		if (!isPersistableBackendImageId(supersededImageId)) return;
		if (this.isImageIdReferenced(supersededImageId)) return;
		// Enqueue even if a live undo/redo command currently references it: the
		// reconcile sweep re-checks live history at delete time and SKIPS (re-queuing)
		// any id still reachable, so a brush→brush→save with undo pending never deletes
		// the pre-stroke blob. We keep it queued so that once the history is
		// cleared/evicted it becomes eligible on a later save (P1 undo-404 guard).
		this.supersededEditImageIds.add(supersededImageId);
	}

	/**
	 * Reclaim superseded destructive-edit blobs queued by
	 * {@link queueSupersededEditImageId}. Runs AFTER a successful saveProject() so the
	 * durable server state already references the replacement ids. Each delete is:
	 *   - reference-SAFE (non-force): the backend 409s `asset_referenced` if the id is
	 *     still used by ANY page/layer/track/marker — we then drop it from the queue
	 *     (it's legitimately live, not garbage), never force-deleting live bytes.
	 *   - best-effort: a transient/network failure leaves the id queued for the next
	 *     save's sweep; a 404 (already gone) is treated as done.
	 * Never throws — storage GC must not break the save flow.
	 */
	private async reconcileSupersededEditImages(): Promise<void> {
		if (this.reconcilingSupersededEditImages) return;
		if (this.supersededEditImageIds.size === 0) return;
		const project = this.project;
		if (!project || !canUseBackendProjectEndpoints(project.projectId)) return;
		const projectId = project.projectId;
		this.reconcilingSupersededEditImages = true;
		try {
			// Snapshot so concurrent edits enqueuing more ids don't mutate the set mid-sweep.
			const ids = [...this.supersededEditImageIds];
			for (const imageId of ids) {
				// A late edit may have re-referenced this id (e.g. undo restored the old
				// background) — skip + dequeue so we never delete a now-live blob.
				if (this.isImageIdReferenced(imageId)) {
					this.supersededEditImageIds.delete(imageId);
					continue;
				}
				// P1 UNDO-404 GUARD: the blob may still be reachable via the LIVE editor
				// undo/redo history (BrushBackgroundCommand reloads the prior background
				// url). Saved project state doesn't include live history, so this is the
				// only place we can see it. SKIP but KEEP QUEUED — do NOT dequeue — so the
				// id is reclaimed on a later save once the history is cleared/evicted (page
				// switch, project close, capacity overflow). Deleting here would 404 undo.
				if (this.isImageIdReferencedByLiveHistory(imageId)) {
					continue;
				}
				try {
					const result = await api.deleteWorkspaceStorageAsset(projectId, imageId);
					this.supersededEditImageIds.delete(imageId);
					if (result.storageQuota) {
						this.dispatchStorageQuotaUpdated(projectId, result.storageQuota);
					}
				} catch (error) {
					if (error instanceof api.ApiError) {
						// Still referenced somewhere the local check missed (e.g. a per-language
						// track output) → it's NOT garbage; drop it so we don't retry forever.
						// `asset_referenced_by_version_snapshot` is the hard-blocked snapshot pin
						// (P1-2): the asset is durably reachable by a restore point, not garbage,
						// so dequeue it too (it will be released only when its snapshot is deleted).
						if (
							error.status === 409 &&
							(error.code === "asset_referenced" || error.code === "asset_referenced_by_version_snapshot")
						) {
							this.supersededEditImageIds.delete(imageId);
							continue;
						}
						// Already gone → done.
						if (error.status === 404) {
							this.supersededEditImageIds.delete(imageId);
							continue;
						}
					}
					// Transient (network/5xx/auth-refresh): keep queued for the next save sweep.
					console.warn("[ProjectStore] superseded edit-blob GC deferred:", imageId, error);
				}
			}
		} finally {
			this.reconcilingSupersededEditImages = false;
		}
	}

	/**
	 * NON-DESTRUCTIVE edit (Phase A — bubble-clean). Upload ONLY the tiny alpha-mask
	 * ROI as a small `image-edit-mask` asset and append a fill-mask `ImageEditLayer`
	 * to the current page's `imageEditLayers` — instead of baking a full new page PNG
	 * (the legacy full-page-bake path, removed for #6). The original `page.imageId` stays intact
	 * (AI markers keep anchoring to it) and the edit is durable + reversible. The layer
	 * is saved as part of normal project state on the next `saveState()`.
	 *
	 * Reuses the SAME `uploadImages` path the brush/layer commits use, so it works in
	 * both backend and file modes. Returns the recorded layer (for the editor to
	 * repaint its edit-composite cache), or null on failure.
	 */
	async commitImageEditLayer(input: {
		maskPng: Blob;
		region: { x: number; y: number; width: number; height: number };
		fill: { r: number; g: number; b: number; a: number };
		sourceImageId: string;
		tool: { id: "bubble-clean"; params?: Record<string, unknown> };
	}): Promise<ImageEditLayer | null> {
		if (!this.project) return null;
		const pageIndex = this.project.currentPage;
		const page = this.project.pages[pageIndex];
		if (!page) return null;

		const { region, fill, sourceImageId, tool } = input;
		const safeName = (page.imageName || page.imageId || `page-${pageIndex + 1}`)
			.replace(/[^a-z0-9._-]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || `page-${pageIndex + 1}`;
		const maskFile = blobToFile(input.maskPng, `${safeName}-clean-mask-${Date.now().toString(36)}.png`);

		let maskAssetId: string;
		try {
			if (!canUseBackendProjectEndpoints(this.project.projectId)) {
				// File/local mode: no server asset registry — keep a durable data: URL for
				// the mask under a synthetic id so the editor can fetch it on reload.
				maskAssetId = `edit-mask-${pageIndex + 1}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`;
				const durableUrl = await durableLocalImageUrl(URL.createObjectURL(input.maskPng), input.maskPng);
				this.registerLocalImageUrl(maskAssetId, durableUrl);
			} else {
				const upload = await api.uploadImages(
					this.project.projectId,
					[maskFile],
					undefined,
					{ assetKind: "image-edit-mask", pageImageId: sourceImageId, pageIndex },
				);
				const persistedId = upload.imageIds[0];
				if (!persistedId) throw new Error("อัปโหลด mask เสร็จแต่ไม่ได้รับ image id");
				maskAssetId = persistedId;
				this.registerLocalImageUrl(persistedId, api.imageUrl(this.project.projectId, persistedId));
				this.mergeImageAssets(upload.assets);
				if (upload.storageQuota) this.dispatchStorageQuotaUpdated(this.project.projectId, upload.storageQuota);
			}
		} catch (error) {
			console.error("[ProjectStore] commitImageEditLayer mask upload failed:", error);
			this.statusMsg = "บันทึกการคลีนบอลลูนไม่สำเร็จ: อัปโหลด mask ไม่ผ่าน";
			// P1-a DATA-SAFETY — returning null tells the editor/tool the clean did NOT
			// persist (it then reverts the instant preview so no phantom bubble lingers).
			// Surface the failure through the SAME visible save-error banner the brush
			// commits use (not just a transient status line) so the user knows the clean
			// was dropped and can retry, rather than silently losing it on reload/export.
			this.failBrushSave(error);
			return null;
		}

		const now = new Date().toISOString();
		// P1-1 — POSITIONAL stack: renormalize the survivors to contiguous 0..n-1 in array
		// order before appending so the new layer's index (== count) cannot collide with a
		// stale index left by a prior delete/revert in persisted state.
		const existing = normalizeImageEditLayerIndices(
			Array.isArray(page.imageEditLayers) ? page.imageEditLayers : [],
		);
		const layer: ImageEditLayer = {
			id: `edit-${crypto.randomUUID()}`,
			kind: "bubble-clean",
			target: "page-background",
			visible: true,
			opacity: 1,
			sourceImageId,
			bbox: { x: region.x, y: region.y, w: region.width, h: region.height },
			payload: {
				type: "fill-mask",
				maskAssetId,
				maskEncoding: "png-alpha",
				fill: { r: fill.r, g: fill.g, b: fill.b, a: fill.a },
			},
			index: existing.length,
			tool,
			createdAt: now,
		};
		page.imageEditLayers = [...existing, layer];
		this.markCurrentPageUnsaved();
		this.statusMsg = "คลีนบอลลูนแล้ว (บันทึกแบบไม่ทำลายต้นฉบับ)";
		return layer;
	}

	/**
	 * Upload one small edit-layer asset (a realized RGBA patch PNG or an alpha-only mask
	 * PNG) and return its asset id. File/local mode keeps a durable data: URL under a
	 * synthetic id; backend mode uploads via the SAME `uploadImages` path the brush/clean
	 * commits use, tagging the asset kind so storage/moderation/GC can classify it.
	 */
	private async uploadEditLayerAsset(
		blob: Blob,
		assetKind: "image-edit-patch" | "image-edit-mask",
		sourceImageId: string,
		pageIndex: number,
		filename: string,
	): Promise<string> {
		if (!this.project) throw new Error("ไม่มีโปรเจกต์");
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const id = `${assetKind === "image-edit-patch" ? "edit-patch" : "edit-mask"}-${pageIndex + 1}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`;
			const durableUrl = await durableLocalImageUrl(URL.createObjectURL(blob), blob);
			this.registerLocalImageUrl(id, durableUrl);
			return id;
		}
		const upload = await api.uploadImages(
			this.project.projectId,
			[blobToFile(blob, filename)],
			undefined,
			{ assetKind, pageImageId: sourceImageId, pageIndex },
		);
		const persistedId = upload.imageIds[0];
		if (!persistedId) throw new Error("อัปโหลดเสร็จแต่ไม่ได้รับ image id");
		this.registerLocalImageUrl(persistedId, api.imageUrl(this.project.projectId, persistedId));
		this.mergeImageAssets(upload.assets);
		if (upload.storageQuota) this.dispatchStorageQuotaUpdated(this.project.projectId, upload.storageQuota);
		return persistedId;
	}

	/**
	 * NON-DESTRUCTIVE edit (Phase B — brush/healing/clone). Upload the REALIZED ROI as a
	 * small `image-edit-patch` asset (and, for healing/clone, the stroke mask as an
	 * `image-edit-mask` asset), build the typed `patch`/`healing`/`clone` payload, and
	 * append the edit layer to the current page's `imageEditLayers` — instead of baking
	 * a full new page PNG. The original `page.imageId` stays intact (AI markers keep
	 * anchoring to it). Returns the recorded layer for the editor to push its undo
	 * command + repaint, or null on a failed upload (the tool then reverts the preview).
	 */
	async commitImageEditLayerPatch(input: ImageEditLayerPatchCommitInput): Promise<ImageEditLayer | null> {
		if (!this.project) return null;
		const pageIndex = this.project.currentPage;
		const page = this.project.pages[pageIndex];
		if (!page) return null;
		// The edit composites over the ORIGINAL page background (kept intact for AI anchoring).
		const sourceImageId = page.imageId;

		const { region, tool, kind } = input;
		const safeName = (page.imageName || page.imageId || `page-${pageIndex + 1}`)
			.replace(/[^a-z0-9._-]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || `page-${pageIndex + 1}`;
		const stamp = Date.now().toString(36);

		let patchAssetId: string;
		let maskAssetId: string | undefined;
		try {
			patchAssetId = await this.uploadEditLayerAsset(
				input.patchPng,
				"image-edit-patch",
				sourceImageId,
				pageIndex,
				`${safeName}-${kind}-patch-${stamp}.png`,
			);
			if (input.maskPng && (kind === "healing" || kind === "clone")) {
				maskAssetId = await this.uploadEditLayerAsset(
					input.maskPng,
					"image-edit-mask",
					sourceImageId,
					pageIndex,
					`${safeName}-${kind}-mask-${stamp}.png`,
				);
			}
		} catch (error) {
			console.error("[ProjectStore] commitImageEditLayerPatch upload failed:", error);
			this.statusMsg = "บันทึกการแก้ไขแบบไม่ทำลายต้นฉบับไม่สำเร็จ: อัปโหลดไม่ผ่าน";
			// P1-a DATA-SAFETY — null tells the tool the edit did NOT persist so it reverts
			// the instant preview; surface the error through the same brush-save banner.
			this.failBrushSave(error);
			return null;
		}

		let payload: ImageEditLayerPayload;
		if (kind === "patch") {
			payload = { type: "patch", patchAssetId, patchEncoding: "png-rgba" };
		} else if (kind === "healing") {
			payload = {
				type: "healing",
				maskAssetId: maskAssetId ?? patchAssetId,
				realizedPatchAssetId: patchAssetId,
				patchEncoding: "png-rgba",
				algorithm: input.algorithm ?? "telea",
				algorithmVersion: input.algorithmVersion ?? "telea-1",
			};
		} else {
			payload = {
				type: "clone",
				maskAssetId: maskAssetId ?? patchAssetId,
				realizedPatchAssetId: patchAssetId,
				patchEncoding: "png-rgba",
				sourceImageId,
				sourceBbox: input.sourceBbox ?? { x: region.x, y: region.y, w: region.width, h: region.height },
				offset: input.offset ?? { dx: 0, dy: 0 },
			};
		}

		const now = new Date().toISOString();
		// P1-1 — POSITIONAL stack: renormalize survivors before appending (see commitImageEditLayer).
		const existing = normalizeImageEditLayerIndices(
			Array.isArray(page.imageEditLayers) ? page.imageEditLayers : [],
		);
		const layer: ImageEditLayer = {
			id: `edit-${crypto.randomUUID()}`,
			kind,
			target: "page-background",
			visible: true,
			opacity: 1,
			sourceImageId,
			bbox: { x: region.x, y: region.y, w: region.width, h: region.height },
			payload,
			index: existing.length,
			tool,
			createdAt: now,
		};
		page.imageEditLayers = [...existing, layer];
		this.markCurrentPageUnsaved();
		this.statusMsg = "บันทึกการแก้ไขแบบไม่ทำลายต้นฉบับแล้ว";
		return layer;
	}

	/**
	 * Phase B undo/redo — the editor mutated the current page's `imageEditLayers` stack
	 * (an edit-layer command added/removed a layer). Persist the new stack so the change
	 * survives save/reload, mirroring captureEditorImageLayers/captureEditorTextLayers.
	 */
	captureEditorImageEditLayers(layers: ImageEditLayer[]): void {
		if (!this.project) return;
		const pageIndex = this.project.currentPage;
		const page = this.project.pages[pageIndex];
		if (!page) return;
		page.imageEditLayers = layers.map((layer) => ({ ...layer }));
		this.markCurrentPageUnsaved();
	}

	private async waitForEditorBrushCommit(editor: any, forced = false): Promise<void> {
		if (typeof editor?.waitForPendingBrushCommit !== "function") return;
		const hasPending = typeof editor.hasPendingBrushCommit !== "function" || editor.hasPendingBrushCommit();
		const hasError = typeof editor.hasBrushCommitError === "function" && editor.hasBrushCommitError();
		if (!hasPending && !hasError) return;
		if (hasPending || hasError) {
			this.statusMsg = "กำลังบันทึกรอยแปรงก่อนทำงานต่อ...";
		}
		try {
			// `forced` is a teardown flush — the editor settles its persist gate even on
			// upload failure so this can't deadlock (#255 P1).
			await editor.waitForPendingBrushCommit(forced);
		} catch (error) {
			const message = this.errorMessage(error, "ปัดซ้ำบนเลเยอร์เดิมหรือกู้คืนรอยแปรงก่อนทำงานต่อ");
			throw new BrushCommitNavigationError(`รอยแปรงยังไม่ถูกบันทึก (${message})`, error);
		}
	}

	private shouldWaitForEditorBrushCommit(editor: any): boolean {
		if (typeof editor?.waitForPendingBrushCommit !== "function") return false;
		if (typeof editor.hasBrushCommitError === "function" && editor.hasBrushCommitError()) return true;
		if (typeof editor.hasPendingBrushCommit !== "function") return true;
		return editor.hasPendingBrushCommit();
	}

	/**
	 * #255 teardown-safety. Sign-out / leave-workspace / project-close unmount the
	 * shell → destroy the editor, which drops the instant-apply backing canvas and
	 * cancels BOTH debounces (the editor's ~800ms image persist AND this store's
	 * ~5s autosave). So an instant heal/clone stroke made just before teardown would
	 * be lost on reload. This flushes the full durable chain BEFORE teardown:
	 *   1) drain the editor's pending instant/brush persist (uploads the edited
	 *      bitmap + sets page.edits.imageId — the existing nav-safety drain), then
	 *   2) flush this store's pending autosave so page.edits is written to the
	 *      backend project (otherwise the edit's page association is lost on reload).
	 * Best-effort + non-throwing: a failed flush must never block sign-out.
	 */
	async flushPendingPersistAndSave(editor?: any): Promise<void> {
		try {
			if (editor && this.shouldWaitForEditorBrushCommit(editor)) {
				// forced=true: this is a teardown flush (sign-out / leave-workspace /
				// project-close). The editor settles its persist gate even on upload
				// failure so the drain can't hang; the outer Promise.race timeout in
				// editorStore.flushPendingEdits() is the final no-deadlock guard. #255 P1.
				await this.waitForEditorBrushCommit(editor, true);
			}
		} catch (error) {
			console.error("[ProjectStore] flushPendingPersistAndSave: brush drain failed:", error);
		}
		// Flush the debounced autosave NOW so page.edits durably lands. cancelAutosave
		// first so the timer can't fire a second redundant save after this one.
		this.cancelAutosave();
		if (this.project && canUseBackendProjectEndpoints(this.project.projectId) && this.hasLocalProjectChanges()) {
			try {
				await this.saveState();
			} catch (error) {
				console.error("[ProjectStore] flushPendingPersistAndSave: save failed:", error);
			}
		}
		// Concurrent-edit Phase 1: release the current page's soft lease on teardown
		// (sign-out / leave-workspace / project-close) so a colleague isn't blocked
		// until the TTL. Best-effort + non-throwing.
		void editLeaseStore.endPageEdit().catch(() => {});
	}

	/**
	 * Concurrent-edit Phase 1 — acquire (or steer on) the soft lease for the page
	 * at `pageIndex`. Fire-and-forget + fully self-contained: only runs against a
	 * real backend-eligible project (file-mode degrades to "edit anyway"), and any
	 * failure is swallowed by the lease store (status becomes "unavailable"). CAS
	 * on save is the durable guard, so this is purely steering.
	 */
	private acquirePageLease(pageIndex: number): void {
		const project = this.project;
		if (!project) return;
		if (!canUseBackendProjectEndpoints(project.projectId)) return;
		// Starting a fresh page edit clears any prior taken-over lockout.
		this.editingTakenOver = false;
		// C2/C3: react when THIS tab's lease is stolen. The lease store fires this on a
		// definitive heartbeat 404/409 (a reliable signal even if the SSE notify
		// dropped). We cancel the pending autosave (so a stale write can't fire),
		// snapshot a recovery draft (no work lost), and flip the editor read-only.
		editLeaseStore.onTakenOver(() => this.handleLeaseTakenOver());
		void editLeaseStore
			.beginPageEdit({
				projectId: project.projectId,
				pageIndex,
				workspaceId: project.workspaceId ?? undefined,
			})
			.catch(() => {});
	}

	/**
	 * C2/C3: this tab's page lease was taken over by another user. Defend the
	 * displaced holder's work: cancel any pending autosave so a stale write can never
	 * fire, snapshot the current edits into a local recovery draft, and flip the
	 * editor read-only. Idempotent + non-throwing (runs from a heartbeat timer).
	 */
	private handleLeaseTakenOver(): void {
		if (this.editingTakenOver) return;
		this.editingTakenOver = true;
		this.cancelAutosave();
		this.saveSyncStatus = "error";
		this.saveErrorKind = "conflict";
		this.saveErrorMessage = "มีคนอื่นเข้ามาแก้หน้านี้แทน งานที่ยังไม่บันทึกถูกเก็บเป็นสำเนากู้คืนไว้ในเครื่อง";
		this.statusMsg = this.saveErrorMessage;
		// Best-effort recovery snapshot — never throw out of the timer callback.
		void this.createLocalConflictRecoveryDraft().catch((error) => {
			console.warn("[ProjectStore] recovery snapshot after takeover failed:", error);
		});
	}

	async wirePageSetChangedRealtime(): Promise<void> {
		if (this.pageSetChangedRealtimeUnsub) return;
		// LAZY + FAIL-OPEN import: realtime.svelte.ts statically imports
		// auth.svelte.ts, whose module init calls api.setAuthRefreshHandler — a
		// static import would poison every suite that mocks $lib/api/client, and
		// even the lazy import REJECTS under minimal mocks (review #594 P1). The
		// subscription is an enhancement; failing to wire must never break boot.
		try {
			const { realtimeStore } = await import("$lib/stores/realtime.svelte.ts");
			if (this.pageSetChangedRealtimeUnsub) return;
			this.pageSetChangedRealtimeUnsub = realtimeStore.on("page_set_changed", (event) => this.handlePageSetChangedRealtime(event));
		} catch {
			// realtime unavailable (tests / early boot) — banner simply stays off.
		}
	}

	private async handlePageSetChangedRealtime(event: RealtimeEvent): Promise<void> {
		const data = event.data as Record<string, unknown> | undefined;
		const projectId = typeof data?.projectId === "string" ? data.projectId.trim() : "";
		if (!projectId || projectId !== this.project?.projectId) return;

		const changedBy = typeof data.changedBy === "string" ? data.changedBy.trim() : "";
		// LAZY auth import (same poison ai-jobs.svelte.ts documents): auth.svelte.ts
		// runs api.setAuthRefreshHandler at module init, so a STATIC import here
		// would drag that side effect into every test that mocks $lib/api/client —
		// 15 suites broke exactly that way. Resolve the user lazily instead.
		let selfUserId: string | undefined;
		try {
			const { authStore } = await import("$lib/stores/auth.svelte.ts");
			selfUserId = authStore.currentUser?.id;
		} catch {
			// auth store unavailable (minimal api mocks in tests / early boot):
			// treat the event as another user's — showing the banner to the actor
			//is harmless; suppressing a real collaborator's change is not.
			selfUserId = undefined;
		}
		// A user id is NOT an origin-tab id (review #594 P2): the same account in
		// another tab must still see the banner. Suppress self events only when
		// THIS tab performed a page-set mutation moments ago — its own echo.
		const recentOwnMutation = Date.now() - this.lastOwnPageSetMutationAt < 15_000;
		if (changedBy && selfUserId && changedBy === selfUserId && recentOwnMutation) return;

		const rawPageCount = data.pageCount;
		const pageCount = typeof rawPageCount === "number" && Number.isFinite(rawPageCount)
			? Math.max(0, Math.trunc(rawPageCount))
			: this.project.pages.length;
		this.pageSetChangedNotice = {
			projectId,
			changedBy,
			pageCount,
			receivedAt: event.emittedAt || Date.now(),
		};
	}

	clearPageSetChangedNotice(projectId?: string | null): void {
		if (!this.pageSetChangedNotice) return;
		if (projectId && this.pageSetChangedNotice.projectId !== projectId) return;
		this.pageSetChangedNotice = null;
	}

	private async registerLocalImageFile(imageId: string, file: File): Promise<string | null> {
		let imageUrl: string | null = null;
		if (typeof FileReader !== "undefined") {
			imageUrl = await new Promise((resolve) => {
				const reader = new FileReader();
				reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
				reader.onerror = () => resolve(null);
				reader.readAsDataURL(file);
			});
		}
		if (!imageUrl && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
			imageUrl = URL.createObjectURL(file);
		}
		if (!imageUrl) return null;
		this.registerLocalImageUrl(imageId, imageUrl);
		return imageUrl;
	}

	private async uploadSingleProjectImage(file: File, options: {
		prefix: string;
		fallbackWidth: number;
		fallbackHeight: number;
		metadata?: Record<string, unknown>;
	}): Promise<{ imageId: string; asset: ProjectImageAssetSummary; imageUrl: string | null }> {
		if (!this.project) throw new Error("ยังไม่ได้เปิดงาน");

		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const imageId = `${options.prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
			const dimensions = await readImageFileDimensions(file, options.fallbackWidth, options.fallbackHeight);
			const asset: ProjectImageAssetSummary = {
				assetId: imageId,
				imageId,
				originalName: file.name,
				mimeType: file.type,
				sizeBytes: file.size,
				sha256: `local-${imageId}`,
				storageDriver: "debug",
				storageKey: `local-object-url/${imageId}`,
				width: dimensions.width,
				height: dimensions.height,
				storageStatus: "released",
				moderationStatus: "passed",
				derivativeCount: 0,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			const imageUrl = await this.registerLocalImageFile(imageId, file);
			this.mergeImageAssets([asset]);
			return { imageId, asset, imageUrl };
		}

		const upload = await api.uploadImages(this.project.projectId, [file], undefined, options.metadata);
		const imageId = upload.imageIds[0];
		if (!imageId) throw new Error("อัปโหลดเสร็จแต่ไม่ได้รับ image id");
		const asset = upload.assets?.find((item) => item.imageId === imageId) ?? {
			assetId: imageId,
			imageId,
			originalName: file.name,
			mimeType: file.type,
			sizeBytes: file.size,
			sha256: "",
			storageDriver: "local",
			storageKey: "",
			width: Math.max(1, Math.round(options.fallbackWidth || 240)),
			height: Math.max(1, Math.round(options.fallbackHeight || 120)),
			storageStatus: "released" as const,
			moderationStatus: "passed" as const,
			derivativeCount: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		this.mergeImageAssets(upload.assets?.length ? upload.assets : [asset]);
		if (upload.storageQuota) {
			this.dispatchStorageQuotaUpdated(this.project.projectId, upload.storageQuota);
		}
		return { imageId, asset, imageUrl: null };
	}

	private clearLocalImageUrls(): void {
		if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
			for (const objectUrl of Object.values(this.localImageUrls)) {
				if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
			}
		}
		this.localImageUrls = {};
		// Drop any queued superseded-blob GC ids: they are scoped to the project being
		// torn down, so they must not leak into the next project's save-time sweep.
		this.supersededEditImageIds.clear();
	}

	private setImageAssets(assets: ProjectImageAssetSummary[], projectId = this.project?.projectId ?? null): void {
		this.imageAssetsProjectId = projectId;
		this.imageAssetsError = null;
		this.imageAssets = [...assets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	private mergeImageAssets(assets: ProjectImageAssetSummary[] | undefined): void {
		if (!assets?.length) return;
		const merged = [...this.imageAssets];
		for (const asset of assets) {
			const existingIndex = merged.findIndex((item) => item.assetId === asset.assetId);
			if (existingIndex >= 0) {
				merged[existingIndex] = asset;
			} else {
				merged.push(asset);
			}
		}
		this.setImageAssets(merged);
	}

	private clearImageAssets(): void {
		this.imageAssets = [];
		this.imageAssetsProjectId = null;
		this.imageAssetsError = null;
		this.imageAssetsStorageQuota = null;
		this.deletingImageAssetId = null;
	}

	/**
	 * Delete one image asset from the open project's storage (frees space).
	 * Reference-safe: the backend (DELETE /api/storage/projects/:p/assets/:img)
	 * refuses an asset still on a live page with 409 unless `force` is passed.
	 * Optimistic: the row is removed locally first and restored on failure. On
	 * success the returned storageQuota updates the space-used total; we also
	 * dispatch the quota event so other panels (usage dashboard) stay in sync.
	 *
	 * Returns `{ ok }` on success, or `{ referencedByPages }` when the asset is
	 * still in use (so the caller can confirm a forced delete), or
	 * `{ error }` for an honest failure message.
	 */
	async deleteImageAsset(
		imageId: string,
		options: { force?: boolean } = {},
	): Promise<{ ok: true; freedBytes: number } | { referencedByPages: number[] } | { error: string }> {
		const project = this.project;
		if (!project) return { error: "ยังไม่ได้เปิดโปรเจกต์" };
		const projectId = project.projectId;
		const target = this.imageAssets.find((asset) => asset.imageId === imageId);
		if (!target) return { error: "ไม่พบรูปนี้ในคลัง" };

		const previousImageAssets = [...this.imageAssets];
		this.deletingImageAssetId = imageId;
		// Optimistic removal so the library updates immediately.
		this.imageAssets = this.imageAssets.filter((asset) => asset.imageId !== imageId);
		try {
			const result = await api.deleteWorkspaceStorageAsset(projectId, imageId, { force: options.force });
			if (result.storageQuota) {
				this.imageAssetsStorageQuota = result.storageQuota;
				this.dispatchStorageQuotaUpdated(projectId, result.storageQuota);
			} else {
				// Backend didn't echo a quota — refresh it from the authoritative source.
				void this.refreshImageAssetsStorageQuota(projectId);
			}
			return { ok: true, freedBytes: result.freedBytes };
		} catch (error) {
			// Roll back the optimistic removal on any failure.
			this.imageAssets = previousImageAssets;
			if (error instanceof api.ApiError && error.status === 409) {
				const body = error.body as { referencedByPages?: number[] } | undefined;
				return { referencedByPages: body?.referencedByPages ?? [] };
			}
			return { error: this.errorMessage(error, "ลบรูปไม่สำเร็จ") };
		} finally {
			this.deletingImageAssetId = null;
		}
	}

	private async refreshImageAssetsStorageQuota(projectId: string): Promise<void> {
		try {
			const { storageQuota } = await api.getProjectStorageUsage(projectId);
			if (this.project?.projectId === projectId) {
				this.imageAssetsStorageQuota = storageQuota;
			}
			this.dispatchStorageQuotaUpdated(projectId, storageQuota);
		} catch (error) {
			console.warn("[ProjectStore] refreshImageAssetsStorageQuota failed", error);
		}
	}

	private hasCurrentProjectPageAssetInventory(): boolean {
		if (!this.project || this.imageAssetsProjectId !== this.project.projectId || !this.imageAssets.length) {
			return false;
		}
		return this.project.pages.some((page) => Boolean(findPageAssetRecord(page, this.imageAssets)));
	}

	async loadImageAssets(): Promise<void> {
		if (!this.project) {
			this.clearImageAssets();
			return;
		}

		this.imageAssetsLoading = true;
		try {
			const { assets, storageQuota } = await api.listProjectImageAssets(this.project.projectId);
			this.setImageAssets(assets);
			this.imageAssetsStorageQuota = storageQuota ?? this.imageAssetsStorageQuota;
		} catch (error) {
			console.error("[ProjectStore] loadImageAssets error:", error);
			this.imageAssets = [];
			this.imageAssetsProjectId = this.project.projectId;
			this.imageAssetsError = this.errorMessage(error, "ตรวจคลังรูปไม่สำเร็จ");
			this.statusMsg = "ตรวจคลังรูปไม่สำเร็จ";
		} finally {
			this.imageAssetsLoading = false;
		}
	}

	getPageAssetIntegrity(pageIndex: number): PageAssetIntegrity | null {
		if (!this.project || pageIndex < 0 || pageIndex >= this.project.pages.length) return null;
		const page = this.project.pages[pageIndex];
		const assetRecord = findPageAssetRecord(page, this.imageAssets);
		return resolvePageAssetIntegrity(
			page,
			pageIndex,
			this.getPageAssetLoadError(pageIndex),
			assetRecord,
			this.hasCurrentProjectPageAssetInventory(),
			this.imageAssetsProjectId === this.project.projectId ? this.imageAssetsError : null,
		);
	}

	private getPageAssetLoadError(pageIndex: number): PageAssetLoadError | null {
		return this.getPageAssetLoadErrors(pageIndex)[0] ?? null;
	}

	private getPageAssetLoadErrors(pageIndex: number): PageAssetLoadError[] {
		const entry = this.assetLoadErrors[pageIndex];
		if (!entry) return [];
		return Array.isArray(entry) ? entry : [entry];
	}

	private setPageAssetLoadError(error: PageAssetLoadError): void {
		const existing = this.getPageAssetLoadErrors(error.pageIndex);
		const nextErrors = error.kind === "page"
			? [error]
			: [
				...existing.filter((item) => {
					if (item.kind === "page") return false;
					if (error.layerId && item.layerId === error.layerId) return false;
					return item.imageId !== error.imageId;
				}),
				error,
			];
		this.assetLoadErrors = {
			...this.assetLoadErrors,
			[error.pageIndex]: nextErrors,
		};
	}

	private clearPageAssetLoadError(pageIndex: number): void {
		if (pageIndex < 0 || !(pageIndex in this.assetLoadErrors)) return;
		const next = { ...this.assetLoadErrors };
		delete next[pageIndex];
		this.assetLoadErrors = next;
	}

	private clearPageAssetLoadErrorIf(pageIndex: number, predicate: (error: PageAssetLoadError) => boolean): void {
		const errors = this.getPageAssetLoadErrors(pageIndex);
		if (!errors.length) return;
		const nextErrors = errors.filter((error) => !predicate(error));
		if (nextErrors.length === errors.length) return;
		if (!nextErrors.length) {
			this.clearPageAssetLoadError(pageIndex);
			return;
		}
		this.assetLoadErrors = {
			...this.assetLoadErrors,
			[pageIndex]: nextErrors,
		};
	}

	markCurrentPageUnsaved(): void {
		if (!this.project || this.isLoadingPage) return;
		this.dirtyVersion += 1;
		this.saveErrorMessage = null;
		this.saveErrorKind = null;
		if (this.saveSyncStatus !== "saving") {
			this.saveSyncStatus = "unsaved";
		}
		this.scheduleAutosave();
	}

	/**
	 * Debounced autosave: persist project state after edits settle for
	 * AUTOSAVE_DEBOUNCE_MS. Each new edit coalesces into a single pending save by
	 * resetting the timer. Only runs for backend-backed projects (local debug /
	 * non-UUID projects opt out, just like other backend endpoints).
	 */
	private scheduleAutosave(): void {
		if (typeof setTimeout === "undefined") return;
		if (!this.project || !canUseBackendProjectEndpoints(this.project.projectId)) return;
		this.cancelAutosave();
		this.autosaveTimer = setTimeout(() => {
			this.autosaveTimer = null;
			void this.runAutosave();
		}, AUTOSAVE_DEBOUNCE_MS);
	}

	/** Cancel any pending autosave timer (no leaked timers on unmount/switch). */
	cancelAutosave(): void {
		if (this.autosaveTimer !== null) {
			clearTimeout(this.autosaveTimer);
			this.autosaveTimer = null;
		}
	}

	private runAutosave(): Promise<void> {
		if (!this.project || !canUseBackendProjectEndpoints(this.project.projectId)) return Promise.resolve();
		// Skip if nothing to persist, a save is already running, or a previous
		// autosave is still in flight — beginSave/completeSave own the status, and
		// completeSave re-marks "unsaved" (re-arming this debounce) if the dirty
		// version advanced mid-save, so no edits are lost.
		if (this.autosaveInFlight) return this.autosaveInFlightPromise ?? Promise.resolve();
		if (this.saveSyncStatus === "saving") return Promise.resolve();
		if (!this.hasLocalProjectChanges()) return Promise.resolve();
		// Bind this autosave to the project + open generation it started on, so a
		// project switch mid-save cannot persist the wrong store state or re-arm a
		// timer / reload versions for a project that is no longer active.
		const projectId = this.project.projectId;
		const openGeneration = this.projectOpenGeneration;
		this.autosaveInFlight = true;
		const run = (async () => {
			try {
				await this.saveState();
				if (this.isActiveProjectOpen(openGeneration, projectId)) {
					await this.loadVersions();
				}
			} catch (error) {
				// failSave() already surfaced the error + status. We MUST re-arm the timer
				// here (see the finally below) — without it a transient failure (network
				// blip) wedges autosave permanently: status is "error", no further edit
				// arrives, and the user's dirty work is never retried → silent data loss.
				console.warn("[ProjectStore] autosave failed:", error);
			} finally {
				this.autosaveInFlight = false;
				this.autosaveInFlightPromise = null;
				// Re-arm the debounce whenever the save left the store dirty-but-not-clean
				// and the originating project is still active. This covers BOTH:
				//   - success-with-mid-save-edits → completeSave() left status "unsaved"
				//     (it did NOT re-arm the timer), and
				//   - FAILURE → failSave() left status "error" with the dirty edits stuck;
				//     the old code only re-armed on "unsaved", so an error wedged autosave
				//     forever (no new edit, no retry) → silent data loss. Re-arm on "error"
				//     too so the save retries.
				// NOTE: we gate on the STATUS, not hasLocalProjectChanges(): completeSave()
				// does not reset dirtyVersion on a clean save (only markCurrentPageClean
				// does), so dirtyVersion>0 persists after a successful "saved" — re-arming
				// on that would fire an endless no-op save loop. "saved"/"saving" are
				// therefore excluded; only "unsaved"/"error" re-arm.
				//
				// EXCEPT a CONFLICT (saveErrorKind === "conflict"): unlike a transient
				// network blip, a stale-baseline 409 will ALWAYS fail until the user
				// reloads (the baseline cannot self-heal), so re-arming here produced a
				// retry storm — an autosave fires every AUTOSAVE_DEBOUNCE_MS, GETs the
				// project, recomputes the same stale fingerprint, and 409s again,
				// indefinitely while the user is idle. That hammered the backend and
				// churned the console with no recovery benefit. A conflict is resolved
				// only through the explicit reload/recover flow (or the next genuine
				// edit, which re-arms via markCurrentPageUnsaved), so DON'T auto-retry it.
				if (
					this.isActiveProjectOpen(openGeneration, projectId)
					&& (this.saveSyncStatus === "unsaved"
						|| (this.saveSyncStatus === "error" && this.saveErrorKind !== "conflict"))
					&& this.hasLocalProjectChanges()
				) {
					this.scheduleAutosave();
				}
			}
		})();
		this.autosaveInFlightPromise = run;
		return run;
	}

	/** Await any in-flight debounced autosave so callers do not race a second save. */
	private async waitForAutosaveInFlight(): Promise<void> {
		if (this.autosaveInFlightPromise) {
			await this.autosaveInFlightPromise.catch(() => {});
		}
	}

	/**
	 * Drain the single-flight SAVE gate until no save POST is in flight.
	 *
	 * Mirrors the drain LOOP inside {@link saveState}: it keeps awaiting WHICHEVER
	 * promise currently occupies the gate slot (a chained follow-up installs a fresh
	 * one) until the slot is empty, so the store is fully quiescent on return. Errors
	 * are swallowed — the originating saveState() caller owns its own error; a drainer
	 * only needs the POST to have SETTLED so it can't interleave with what comes next.
	 *
	 * Used by openProject on a SAME-ID reload so a reopen can't race an in-flight save
	 * (the older POST's completeSave could otherwise install its stale committed
	 * snapshot over the freshly-loaded baseline). DEADLOCK-SAFE: this only awaits the
	 * save promise — it holds no lock performSave needs, and openProject calls it BEFORE
	 * touching `this.project`, so the in-flight save runs to completion unobstructed.
	 */
	private async drainSaveInFlight(): Promise<void> {
		let drained = 0;
		const SAVE_DRAIN_GUARD = 10; // sanity cap against pathological save churn.
		for (;;) {
			const inFlight = this.saveInFlightPromise;
			if (!inFlight) break; // slot empty → gate is quiescent.
			await inFlight.catch(() => {});
			drained += 1;
			if (drained >= SAVE_DRAIN_GUARD) {
				console.warn(
					`[ProjectStore] drainSaveInFlight drained ${drained} chained in-flight saves; `
						+ "proceeding without further waiting to avoid a livelock.",
				);
				break;
			}
		}
	}

	captureEditorTextLayers(layers: TextLayer[]): void {
		if (!this.project || this.isLoadingPage) return;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return;
		const beforeRevision = this.currentPageRevisionId;
		this.writeActiveTrackTextLayers(page, layers);
		if (this.currentPageRevisionId !== beforeRevision) {
			this.resetPageQcHandoffForUpstreamChange(page, "pending");
			this.markCurrentPageUnsaved();
		}
	}

	/**
	 * Route a text-layer write to the ACTIVE Language Track.
	 *
	 * - Default / legacy track → flat `page.textLayers` (back-compat: no
	 *   `languageOutputs` is ever created, so single-language projects stay
	 *   byte-identical).
	 * - Non-default track → materialize into `page.languageOutputs[lang]` (seeding
	 *   from the source layout on first write, via `writeTrackTextLayers`).
	 *
	 * The pure rules live in `language-tracks.ts`; this only assigns the next value
	 * onto the live page so `createPageRevisionId` / fingerprinting picks it up.
	 */
	private writeActiveTrackTextLayers(page: Page, layers: TextLayer[]): void {
		const lang = this.activeTargetLang;
		if (!this.project || trackWritesFlat({ targetLang: this.project.targetLang }, lang)) {
			page.textLayers = layers;
			return;
		}
		page.languageOutputs = writeTrackTextLayers(page, lang, layers);
	}

	/**
	 * Route an image-layer write to the ACTIVE Language Track — the IMAGE-layer twin
	 * of {@link writeActiveTrackTextLayers}.
	 *
	 * - Default / legacy track → flat `page.imageLayers` (back-compat: no
	 *   `languageOutputs` bucket is created, so single-language projects stay
	 *   byte-identical and shared-image fallback keeps working).
	 * - Non-default track → materialize into `page.languageOutputs[lang].imageLayers`
	 *   so the per-language image override NEVER overwrites the default/source image
	 *   stack. Mirrors the read accessor `trackImageLayers` and the backend export
	 *   pipeline's `resolveExportImageLayers` (which read the override off the raw
	 *   bucket, falling back to flat `page.imageLayers`).
	 *
	 * `imageLayers` is not declared on `PageLanguageOutput` (the read side reads it
	 * defensively off the raw bucket), so it is written defensively here too — without
	 * changing the track storage shape.
	 */
	private writeActiveTrackImageLayers(page: Page, layers: ImageLayer[]): void {
		const lang = this.activeTargetLang;
		if (!this.project || trackWritesFlat({ targetLang: this.project.targetLang }, lang)) {
			page.imageLayers = layers;
			return;
		}
		const existing = page.languageOutputs ?? {};
		const base = existing[lang] ?? seedTrackOutput(page);
		// `imageLayers` is read defensively off the raw bucket on the read side
		// (`trackImageLayers`), so write it the same defensive way without widening the
		// declared `PageLanguageOutput` shape.
		const nextBucket: PageLanguageOutput = { ...base };
		(nextBucket as { imageLayers?: ImageLayer[] }).imageLayers = layers;
		page.languageOutputs = {
			...existing,
			[lang]: nextBucket,
		};
	}

	captureEditorImageLayers(layers: ImageLayer[]): void {
		if (!this.project || this.isLoadingPage) return;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return;
		// NOTE: the page-revision fingerprint only hashes per-track TEXT layers (not
		// per-track imageLayers), so a non-default-track image edit would not move
		// `currentPageRevisionId`. Detect change directly off the ACTIVE track's image
		// layers (default → flat `page.imageLayers`; non-default → the override) so the
		// dirty / QC-reset path fires for BOTH tracks.
		const beforeImageLayers = JSON.stringify(trackImageLayers(page, this.activeTargetLang));
		this.writeActiveTrackImageLayers(page, layers);
		const changed = JSON.stringify(trackImageLayers(page, this.activeTargetLang)) !== beforeImageLayers;
		if (changed) {
			this.resetPageQcHandoffForUpstreamChange(page, "pending");
			this.markCurrentPageUnsaved();
		}
	}

	private resetPageQcHandoffForUpstreamChange(page: Page, status: PageQcHandoffStatus = "pending", now = new Date().toISOString(), actor = "local-user"): boolean {
		if (!page.qcHandoff && status === "pending") return false;
		if ((page.qcHandoff?.status ?? "pending") === status) return false;
		page.qcHandoff = {
			...page.qcHandoff,
			status,
			updatedAt: now,
			updatedBy: actor,
		};
		return true;
	}

	updateCurrentPageTranslationScriptSlot(slot: TranslationScriptSlot, actor = "local-user"): void {
		if (!this.project || this.isLoadingPage) return;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return;
		const existing = trackScriptSlots(page, this.activeTargetLang);
		const beforeSlotsJson = JSON.stringify(existing);
		const nextSlot: TranslationScriptSlot = {
			...slot,
			updatedAt: slot.updatedAt ?? new Date().toISOString(),
			updatedBy: slot.updatedBy ?? actor,
		};
		const matched = existing.some((item) => item.id === slot.id);
		const nextSlots = matched
			? existing.map((item) => item.id === slot.id ? { ...item, ...nextSlot } : item)
			: [...existing, nextSlot];
		this.writeActiveTrackScriptSlots(page, nextSlots);
		if (JSON.stringify(nextSlots) !== beforeSlotsJson) {
			const handoff = pageOutput(page, this.activeTargetLang).translationHandoff;
			if (handoff?.status === "translated") {
				this.writeActiveTrackTranslationHandoff(page, {
					...handoff,
					status: "draft",
					updatedAt: new Date().toISOString(),
					updatedBy: actor,
				});
			}
			this.resetPageQcHandoffForUpstreamChange(page, "pending", new Date().toISOString(), actor);
			this.markCurrentPageUnsaved();
			this.statusMsg = "บันทึกร่างสคริปต์แปลในหน้านี้แล้ว";
		}
	}

	deleteCurrentPageTranslationScriptSlot(slotId: string, actor = "local-user"): void {
		if (!this.project || this.isLoadingPage) return;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return;
		const existing = trackScriptSlots(page, this.activeTargetLang);
		if (!existing.length) return;
		const nextSlots = existing.filter((slot) => slot.id !== slotId);
		if (nextSlots.length === existing.length) return;
		this.writeActiveTrackScriptSlots(page, nextSlots);
		const handoff = pageOutput(page, this.activeTargetLang).translationHandoff;
		if (handoff?.status === "translated") {
			this.writeActiveTrackTranslationHandoff(page, {
				...handoff,
				status: "draft",
				updatedAt: new Date().toISOString(),
				updatedBy: actor,
			});
		}
		this.resetPageQcHandoffForUpstreamChange(page, "pending", new Date().toISOString(), actor);
		this.markCurrentPageUnsaved();
		this.statusMsg = "ลบช่องสคริปต์แปลจากหน้านี้แล้ว";
	}

	updateCurrentPageTranslationHandoff(status: PageTranslationHandoffStatus, actor = "local-user"): void {
		if (!this.project || this.isLoadingPage) return;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return;
		const currentHandoff = pageOutput(page, this.activeTargetLang).translationHandoff;
		const previousStatus = currentHandoff?.status ?? "draft";
		if (previousStatus === status) return;
		this.writeActiveTrackTranslationHandoff(page, {
			...currentHandoff,
			status,
			updatedAt: new Date().toISOString(),
			updatedBy: actor,
		});
		this.resetPageQcHandoffForUpstreamChange(page, "pending", new Date().toISOString(), actor);
		this.markCurrentPageUnsaved();
		this.statusMsg = status === "translated"
			? "ส่งสคริปต์แปลหน้านี้ให้ไทป์เซ็ตแล้ว"
			: status === "needs_translation"
				? "เปิดหน้านี้กลับไปแปลต่อแล้ว"
				: "กลับมาแก้ร่างสคริปต์แปลแล้ว";
	}

	updateCurrentPageCleaningHandoff(status: PageCleaningHandoffStatus, proofKind?: PageCleaningProofKind, actor = "local-user"): void {
		if (!this.project || this.isLoadingPage) return;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return;
		const previousStatus = page.cleaningHandoff?.status ?? "raw";
		const cleanProofLayer = page.imageLayers?.find((layer) => Boolean(layer.restoreImageId) && layer.role !== "credit");
		const nextProofKind = status === "clean_ready"
			? proofKind ?? (cleanProofLayer ? "brush-edited-layer" : "no-clean-needed")
			: undefined;
		const nextProofLayerId = nextProofKind === "brush-edited-layer" ? cleanProofLayer?.id : undefined;
		const nextProofLabel = nextProofKind === "brush-edited-layer"
			? cleanProofLayer?.name || cleanProofLayer?.originalName || cleanProofLayer?.imageName || "เลเยอร์รูปที่คลีนด้วยแปรง"
			: nextProofKind === "no-clean-needed"
				? "ยืนยันว่าไม่ต้องคลีนหน้านี้"
				: undefined;
		if (
			previousStatus === status
			&& page.cleaningHandoff?.proofKind === nextProofKind
			&& page.cleaningHandoff?.proofLayerId === nextProofLayerId
		) return;
		const hasTypesetSlotLayers = page.textLayers.some((layer) => layer.sourceProvider?.startsWith("translation-slot:"));
		const typesetRecheckStatus = status === "clean_ready" && hasTypesetSlotLayers
			? "pending"
			: status === "needs_clean"
				? "needs_adjustment"
				: page.cleaningHandoff?.typesetRecheckStatus;
		page.cleaningHandoff = {
			...page.cleaningHandoff,
			status,
			updatedAt: new Date().toISOString(),
			updatedBy: actor,
			proofKind: nextProofKind,
			proofLayerId: nextProofLayerId,
			proofLabel: nextProofLabel,
			typesetRecheckStatus,
			typesetRecheckUpdatedAt: typesetRecheckStatus === page.cleaningHandoff?.typesetRecheckStatus
				? page.cleaningHandoff?.typesetRecheckUpdatedAt
				: new Date().toISOString(),
			typesetRecheckUpdatedBy: typesetRecheckStatus === page.cleaningHandoff?.typesetRecheckStatus
				? page.cleaningHandoff?.typesetRecheckUpdatedBy
				: actor,
		};
		this.resetPageQcHandoffForUpstreamChange(page, status === "needs_clean" ? "needs_fix" : "pending", new Date().toISOString(), actor);
		this.markCurrentPageUnsaved();
		this.statusMsg = status === "clean_ready"
			? nextProofKind === "brush-edited-layer"
				? "ส่งงานคลีนพร้อมหลักฐานแปรงให้ทีมไทป์เซ็ตแล้ว"
				: "ส่งงานคลีนแบบไม่ต้องแก้ภาพให้ทีมไทป์เซ็ตแล้ว"
			: "เปิดหน้านี้กลับไปแก้คลีนแล้ว";
	}

	updatePageTypesetCleanRecheck(pageIndex: number, status: TypesetCleanRecheckStatus, actor = "local-user"): void {
		if (!this.project || this.isLoadingPage) return;
		const page = this.project.pages[pageIndex];
		if (!page) return;
		const now = new Date().toISOString();
		page.cleaningHandoff = {
			...(page.cleaningHandoff ?? {
				status: page.textLayers.some((layer) => layer.sourceProvider?.startsWith("translation-slot:")) ? "clean_ready" : "raw",
				updatedAt: now,
				updatedBy: actor,
			}),
			typesetRecheckStatus: status,
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: actor,
		};
		this.resetPageQcHandoffForUpstreamChange(page, status === "needs_adjustment" ? "needs_fix" : "pending", now, actor);
		this.markCurrentPageUnsaved();
		this.statusMsg = status === "verified"
			? `ยืนยันตรวจตำแหน่งกับภาพ clean หน้า ${pageIndex + 1} แล้ว`
			: status === "needs_adjustment"
				? `ส่งกลับแก้ตำแหน่งบนภาพ clean หน้า ${pageIndex + 1} แล้ว`
				: `ตั้งสถานะรอรีวิวตำแหน่งกับภาพ clean หน้า ${pageIndex + 1} แล้ว`;
	}

	createTextLayerFromCurrentPageTranslationScriptSlot(
		slotId: string,
		actor = "local-user",
		// E (2026-06-13): คนลงคำจิ้มตำแหน่งวางเองบนภาพ — override จุดวางเป็น % ของ
		// ภาพแทนตำแหน่งหมุดของคนแปล (หมุดคือ "กรอบอยู่ตรงไหน" จุดวางคือ "คำลงตรงไหน")
		placeAt?: { xPct: number; yPct: number },
	): TextLayer | null {
		if (!this.project || this.isLoadingPage) return null;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return null;
		const slot = trackScriptSlots(page, this.activeTargetLang).find((item) => item.id === slotId);
		if (!slot?.translatedText.trim()) return null;
		const sourceProvider = `translation-slot:${slot.id}`;
		const existing = page.textLayers.find((layer) => layer.sourceProvider === sourceProvider);
		if (existing) {
			this.statusMsg = "ช่องแปลนี้สร้างกล่องข้อความแล้ว";
			return existing;
		}
		const dimensions = this.getPageImageDimensions(page, 900, 1350);
		const width = Math.min(280, Math.max(180, Math.round(dimensions.width * 0.26)));
		const height = Math.max(72, Math.round(width * 0.42));
		const anchorXPct = placeAt?.xPct ?? slot.x;
		const anchorYPct = placeAt?.yPct ?? slot.y;
		const x = Math.round(Math.min(Math.max(0, dimensions.width - width), Math.max(0, (anchorXPct / 100) * dimensions.width - width / 2)));
		const y = Math.round(Math.min(Math.max(0, dimensions.height - height), Math.max(0, (anchorYPct / 100) * dimensions.height - height / 2)));
		const layer: TextLayer = {
			id: `typeset-${slot.id}`,
			name: slot.label,
			text: slot.translatedText,
			sourceText: slot.sourceText,
			sourceCategory: slot.category,
			sourceProvider,
			x,
			y,
			w: width,
			h: height,
			rotation: 0,
			fontSize: Math.max(24, Math.min(36, Math.round(width * 0.13))),
			alignment: "center",
			index: page.textLayers.length,
			zIndex: page.textLayers.length,
		};
		page.textLayers = [...page.textLayers, layer];
		if (page.cleaningHandoff?.status === "clean_ready") {
			const now = new Date().toISOString();
			page.cleaningHandoff = {
				...page.cleaningHandoff,
				typesetRecheckStatus: "pending",
				typesetRecheckUpdatedAt: now,
				typesetRecheckUpdatedBy: actor,
			};
		}
		this.resetPageQcHandoffForUpstreamChange(page, "pending", new Date().toISOString(), actor);
		this.markCurrentPageUnsaved();
		this.statusMsg = `สร้างกล่องข้อความจาก ${slot.label} แล้ว`;
		return layer;
	}

	updateTextLayerFromCurrentPageTranslationScriptSlot(slotId: string, actor = "local-user"): TextLayer | null {
		if (!this.project || this.isLoadingPage) return null;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return null;
		const slot = trackScriptSlots(page, this.activeTargetLang).find((item) => item.id === slotId);
		if (!slot?.translatedText.trim()) return null;
		const sourceProvider = `translation-slot:${slot.id}`;
		const existing = page.textLayers.find((layer) => layer.sourceProvider === sourceProvider);
		if (!existing) return null;
		if (existing.locked === true) {
			this.statusMsg = "กล่องข้อความนี้ล็อกอยู่ ปลดล็อกก่อนอัปเดตจากสคริปต์";
			return existing;
		}
		const nextLayer: TextLayer = {
			...existing,
			name: slot.label,
			text: slot.translatedText,
			sourceText: slot.sourceText,
			sourceCategory: slot.category,
			sourceProvider,
		};
		if (JSON.stringify(existing) === JSON.stringify(nextLayer)) {
			this.statusMsg = "กล่องข้อความตรงกับสคริปต์ล่าสุดแล้ว";
			return existing;
		}
		page.textLayers = page.textLayers.map((layer) => layer.id === existing.id ? nextLayer : layer);
		if (page.cleaningHandoff?.status === "clean_ready") {
			const now = new Date().toISOString();
			page.cleaningHandoff = {
				...page.cleaningHandoff,
				typesetRecheckStatus: "pending",
				typesetRecheckUpdatedAt: now,
				typesetRecheckUpdatedBy: actor,
			};
		}
		this.resetPageQcHandoffForUpstreamChange(page, "pending", new Date().toISOString(), actor);
		this.markCurrentPageUnsaved();
		this.statusMsg = `อัปเดตกล่องข้อความจาก ${slot.label} แล้ว`;
		return nextLayer;
	}

	unlinkCurrentPageTranslationTextLayer(layerId: string, actor = "local-user"): TextLayer | null {
		if (!this.project || this.isLoadingPage) return null;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return null;
		const existing = page.textLayers.find((layer) => layer.id === layerId);
		if (!existing?.sourceProvider?.startsWith("translation-slot:")) return existing ?? null;
		const nextLayer: TextLayer = {
			...existing,
			sourceProvider: undefined,
		};
		page.textLayers = page.textLayers.map((layer) => layer.id === existing.id ? nextLayer : layer);
		this.resetPageQcHandoffForUpstreamChange(page, "pending", new Date().toISOString(), actor);
		this.markCurrentPageUnsaved();
		this.statusMsg = "เก็บกล่องข้อความนี้เป็นงานอิสระแล้ว";
		return nextLayer;
	}

	updateCurrentPageQcHandoff(status: PageQcHandoffStatus, actor = "local-user"): void {
		if (!this.project || this.isLoadingPage) return;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return;
		const previousStatus = page.qcHandoff?.status ?? "pending";
		if (previousStatus === status) return;
		page.qcHandoff = {
			...page.qcHandoff,
			status,
			updatedAt: new Date().toISOString(),
			updatedBy: actor,
		};
		this.markCurrentPageUnsaved();
		this.statusMsg = status === "ready"
			? `ปิด QC หน้า ${this.project.currentPage + 1} แล้ว`
			: status === "needs_fix"
				? `เปิดหน้า ${this.project.currentPage + 1} กลับมาตรวจ QC แล้ว`
				: `ตั้งหน้า ${this.project.currentPage + 1} ให้รอปิด QC แล้ว`;
	}

	updateCreditPolicy(policy: CreditPolicy): void {
		if (!this.project || this.isLoadingPage) return;
		const previousPolicy = this.project.creditPolicy ?? "optional";
		if (previousPolicy === policy) return;
		this.project.creditPolicy = policy;
		this.markCurrentPageUnsaved();
		this.statusMsg = exportCreditPolicyStatusMessage(policy);
	}

	updateProductionMode(mode: ProductionMode): void {
		if (!this.project || this.isLoadingPage) return;
		const previousMode = this.project.productionMode ?? "solo";
		if (previousMode === mode) return;
		this.project.productionMode = mode;
		this.markCurrentPageUnsaved();
		this.statusMsg = mode === "team"
			? "ใช้ Team workflow: Export ต้องผ่านรีวิวหน้าและ QC ขั้นสุดท้าย"
			: "ใช้ Solo workflow: ลดขั้นส่งต่อทีมและใช้ gate เฉพาะงานที่ค้างจริง";
	}

	updateReadingDirection(direction: ReadingDirection): void {
		if (!this.project || this.isLoadingPage) return;
		const nextDirection = normalizeReadingDirection(direction);
		if (this.readingDirection === nextDirection) return;
		this.project.readingDirection = nextDirection;
		this.markCurrentPageUnsaved();
		this.statusMsg = nextDirection === "rtl"
			? "ตั้งทิศอ่านขวาไปซ้าย (มังงะ): หน้าเรียงกลับด้านและปุ่มเปลี่ยนหน้าสลับทิศ"
			: nextDirection === "vertical"
				? "ตั้งทิศอ่านแนวตั้ง (เว็บตูน): ต่อหน้าเป็นแถบเลื่อนลงต่อเนื่อง"
				: "ตั้งทิศอ่านซ้ายไปขวา (มันฮวา): หน้าเรียงปกติ";
	}

	private beginSave(): void {
		this.saveSyncStatus = "saving";
		this.saveErrorMessage = null;
		this.saveErrorKind = null;
		this.saveStartedDirtyVersion = this.dirtyVersion;
	}

	/**
	 * Finalize a successful save.
	 *
	 * `committedSnapshot` is the EXACT project state the server just stored — the
	 * snapshot {@link performSave} captured at POST time, BEFORE serializing the body.
	 * The baseline fingerprint MUST be derived from THAT state, not from `this.project`
	 * at completion time: if an edit landed while the POST was in flight, `this.project`
	 * now carries the mid-flight edit the server never saw. Fingerprinting the live
	 * project would set `projectBaseFingerprint` to a hash the server never stored, so
	 * the follow-up save's {@link assertNoStaleRemoteOverwrite} would see
	 * remote≠baseline AND remote≠local (local has the extra edit) → a FALSE
	 * `ProjectSaveConflictError`, dropping the mid-flight edit. Fingerprinting the
	 * committed snapshot makes the baseline match the server's persisted state, so the
	 * follow-up save adopts it cleanly and persists the mid-flight edit.
	 *
	 * The local-debug fallback (no POST) passes no snapshot → baseline tracks the live
	 * project, exactly as before (it "stored" the live state).
	 *
	 * REFERENCE GUARD (`postProject`): when the SAME
	 * project was reloaded/reopened WHILE this POST was in flight, openProject already
	 * re-seeded a FRESH baseline from the just-loaded remote state. Adopting this older
	 * POST's `committedSnapshot` would clobber that fresh baseline with the server's
	 * PRE-reload state, and the next edit would then save the reloaded local state over
	 * the freshly-committed server state WITHOUT a conflict. So we adopt the committed
	 * snapshot ONLY if the load generation AND the project object reference still match
	 * what they were at POST time. If either changed, a reload re-seeded the baseline —
	 * skip the snapshot adoption entirely (do NOT fall through to fingerprinting the
	 * live project either; the reload's baseline is the authority). The non-baseline
	 * bookkeeping (status, timestamps) still runs.
	 */
	private completeSave(
		committedSnapshot?: ProjectState | null,
		postProject?: ProjectState | null,
	): void {
		this.savedPageRevisionId = this.currentPageRevisionId;
		this.lastSavedAt = new Date().toISOString();
		// A reload/reopen of the SAME project landed while this POST was in flight:
		// `this.project` was reassigned to the freshly-loaded state, whose load
		// already seeded a fresh baseline — adopting this stale committed snapshot
		// would overwrite it. Staleness is judged by the project OBJECT REFERENCE
		// alone, deliberately NOT the open generation: a same-id reopen bumps the
		// generation BEFORE its reload succeeds, so a FAILED reload (generation
		// bumped, `this.project` unchanged) must still adopt the committed baseline
		// — otherwise the next edit sees remote=just-saved vs base=pre-save and
		// raises a false conflict (codex P2 round 4). A SUCCESSFUL reload always
		// replaces the object, so the reference test catches every real reload.
		const staleAfterReload = committedSnapshot != null
			&& postProject !== undefined
			&& this.project !== postProject;
		if (staleAfterReload) {
			console.debug(
				"[ProjectStore] completeSave: skipping committed-snapshot adoption — the project "
					+ "was reloaded/reopened while this save was in flight; the reload's fresh "
					+ "baseline is authoritative.",
			);
		} else {
			this.rememberProjectFingerprint(committedSnapshot);
		}
		this.saveErrorMessage = null;
		this.saveErrorKind = null;
		this.saveSyncStatus = this.dirtyVersion === this.saveStartedDirtyVersion ? "saved" : "unsaved";
		// Fully clean now → drop any pending autosave so it does not fire a no-op.
		if (this.saveSyncStatus === "saved") this.cancelAutosave();
	}

	private markCurrentPageClean(): void {
		this.cancelAutosave();
		this.dirtyVersion = 0;
		this.saveStartedDirtyVersion = 0;
		this.savedPageRevisionId = this.currentPageRevisionId;
		this.lastSavedAt = new Date().toISOString();
		this.rememberProjectFingerprint();
		this.saveErrorMessage = null;
		this.saveErrorKind = null;
		this.saveSyncStatus = "saved";
	}

	private failSave(error: unknown): void {
		// Work-preserving UI sink: a 428 baseline-required is recoverable HERE (it sets
		// saveErrorKind="conflict" + the reload-before-save message, no remote adopted),
		// so opt the 428 in explicitly — the classifier stays 409-only for the
		// remote-replacing export merge (codex P1, round 3).
		const isConflict = error instanceof ProjectSaveConflictError
			|| isBackendProjectSaveConflict(error)
			|| isBackendProjectBaselineRequired(error);
		const isBrush = isBrushCommitNavigationError(error);
		this.saveErrorMessage = isConflict
			? "งานถูกแก้จากที่อื่น โหลดใหม่ก่อนบันทึก"
			: isBrush
				? error.message
				: this.errorMessage(error, "บันทึกงานไม่สำเร็จ");
		this.saveErrorKind = isConflict ? "conflict" : (isBrush ? "brush" : "generic");
		this.saveSyncStatus = "error";
	}

	private failBrushSave(error: unknown): void {
		const message = this.errorMessage(error, "ปัดซ้ำบนเลเยอร์เดิมหรือกู้คืนรอยแปรงก่อนทำงานต่อ");
		this.failSave(new BrushCommitNavigationError(`รอยแปรงยังไม่ถูกบันทึก (${message})`, error));
	}

	private errorMessage(error: unknown, fallback: string): string {
		return error instanceof Error && error.message ? error.message : fallback;
	}

	private saveFailureStatus(error: unknown): string {
		if (isBrushCommitNavigationError(error)) return `บันทึกไม่สำเร็จ: ${error.message}`;
		// 428 baseline-required opts in here (status text only, no remote adoption).
		if (
			error instanceof ProjectSaveConflictError
			|| isBackendProjectSaveConflict(error)
			|| isBackendProjectBaselineRequired(error)
		) return "โหลดใหม่ก่อนบันทึก";
		return `บันทึกไม่สำเร็จ: ${this.errorMessage(error, "บันทึกงานไม่สำเร็จ")}`;
	}

	// Set the save-failure status text together with its stable code. A save
	// CONFLICT renders "โหลดใหม่ก่อนบันทึก" (NOT a "บันทึกไม่สำเร็จ" message), so it
	// carries NO `save_failed` code — preserving the old recordExportRun guard,
	// which only treated the "บันทึกไม่สำเร็จ"/"Save failed"-prefixed statuses as a
	// restorable save failure.
	private setSaveFailureStatus(error: unknown): void {
		// 428 baseline-required opts in here too: it renders the conflict status (so it
		// carries NO `save_failed` code), matching saveFailureStatus() above.
		const isConflict = error instanceof ProjectSaveConflictError
			|| isBackendProjectSaveConflict(error)
			|| isBackendProjectBaselineRequired(error);
		this.setStatus(this.saveFailureStatus(error), isConflict ? null : "save_failed");
	}

	private openProjectFailureStatus(projectId: string, previousProjectId: string | null, error: unknown): string {
		const detail = this.errorMessage(error, "เปิดงานไม่สำเร็จ");
		if (previousProjectId && previousProjectId !== projectId && this.project?.projectId === previousProjectId) {
			const retainedName = this.project.name?.trim() || previousProjectId;
			return `เปิดงานใหม่ไม่สำเร็จ: ${detail}. งานเดิมยังอยู่: ${retainedName}. เช็กการเชื่อมต่อแล้วลองเปิดงานใหม่อีกครั้ง`;
		}
		return `เปิดงานไม่สำเร็จ: ${detail}. เช็กการเชื่อมต่อแล้วลองเปิดอีกครั้ง`;
	}

	private importSaveFailureStatus(error: unknown): string {
		// 428 baseline-required opts in here (status copy only, no remote adoption).
		if (
			error instanceof ProjectSaveConflictError
			|| isBackendProjectSaveConflict(error)
			|| isBackendProjectBaselineRequired(error)
		) {
				return "ยกเลิกImport: ต้องโหลดงานใหม่ก่อนImport JSON";
			}
			return `ยกเลิกImport: บันทึกงานไม่สำเร็จ (${this.errorMessage(error, "บันทึกงานไม่สำเร็จ")})`;
	}

	private importApiFailureStatus(error: unknown): string {
		if (error instanceof api.ApiError) {
			const body = error.body;
			const bodyError = typeof body === "object" && body && "error" in body
				? (body as { error?: unknown }).error
				: undefined;
			const bodyMessage = typeof bodyError === "string" ? bodyError : "";
			const detail = importApiErrorCopy(bodyMessage || error.message);
				return `Importไม่สำเร็จ: ${detail || `เซิร์ฟเวอร์ตอบ ${error.status}`}`;
		}
		const message = this.errorMessage(error, "ตรวจไฟล์ JSON แล้วลองใหม่");
		return `Importไม่สำเร็จ: ${importApiErrorCopy(message) || message}`;
	}

	private importRefreshFailureStatus(error: unknown): string {
		if (error instanceof api.ApiError) {
			return `Import JSON แล้ว แต่เปิดตอนที่อัปเดตไม่สำเร็จ (${importApiErrorCopy(error.message) || error.status})`;
		}
		return `Import JSON แล้ว แต่เปิดตอนที่อัปเดตไม่สำเร็จ (${this.errorMessage(error, "ลองรีเฟรชอีกครั้ง")})`;
	}

	private pageSwitchFailureStatus(index: number, error: unknown): string {
		const pageLabel = `หน้า ${index + 1}`;
		if (isBrushCommitNavigationError(error)) {
			return `${pageLabel} ยังไม่เปิด: ${error.message} แก้รอยแปรงก่อนเปลี่ยนหน้า`;
		}
		// 428 baseline-required opts in here (status copy only, no remote adoption).
		if (
			error instanceof ProjectSaveConflictError
			|| isBackendProjectSaveConflict(error)
			|| isBackendProjectBaselineRequired(error)
		) {
			return `${pageLabel} ยังไม่เปิด: โหลดใหม่ก่อนเปลี่ยนหน้า`;
		}
		return `${pageLabel} ยังไม่เปิด: บันทึกไม่สำเร็จ (${this.errorMessage(error, "บันทึกงานไม่สำเร็จ")}) กดลองบันทึกอีกครั้งก่อน`;
	}

	private projectSwitchSaveFailureStatus(error: unknown): string {
		if (isBrushCommitNavigationError(error)) {
			return `งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะ${error.message} แก้รอยแปรงก่อนสลับงาน`;
		}
		// 428 baseline-required opts in here (status copy only, no remote adoption).
		if (
			error instanceof ProjectSaveConflictError
			|| isBackendProjectSaveConflict(error)
			|| isBackendProjectBaselineRequired(error)
		) {
			return "งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะต้องโหลดงานเดิมใหม่ก่อนสลับงาน";
		}
		return `งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะบันทึกงานเดิมไม่สำเร็จ (${this.errorMessage(error, "บันทึกงานไม่สำเร็จ")}) กดลองบันทึกอีกครั้งก่อน`;
	}

	private currentAssetRecoveryStatus(): string | null {
		const issue = this.currentPageAssetError;
		if (!issue) return null;
		return issue.kind === "image-layer"
			? `รูปเสริมหน้า ${issue.pageIndex + 1} หาย`
			: `รูปหน้า ${issue.pageIndex + 1} หาย`;
	}

	private async saveBeforeProjectSwitch(projectId: string, editor?: any): Promise<void> {
		if (!this.project || this.project.projectId === projectId) return;
		if (editor) {
			if (this.shouldWaitForEditorBrushCommit(editor)) await this.waitForEditorBrushCommit(editor);
			this.syncEditorLayers(editor);
		}
		if (!this.hasLocalProjectChanges() && !this.hasCurrentProjectPendingAiResultApply()) return;
		this.statusMsg = "กำลังบันทึกงานเดิมก่อนเปิดงานใหม่...";
		await this.saveState();
	}

	/**
	 * Refresh the conflict-guard baseline (`projectBaseSnapshot` + its fingerprint).
	 *
	 * Without an argument it snapshots the LIVE `this.project` (the default for restore /
	 * remote-adopt / fallback paths, which "stored" the current in-memory state).
	 *
	 * A save path that POSTed an OLDER payload (an edit landed mid-flight) passes the
	 * `committedSnapshot` it captured at POST time, so the baseline tracks what the
	 * server actually persisted rather than the now-edited live project. The snapshot is
	 * already a detached clone (taken via `cloneProjectState` in `performSave`), so it is
	 * adopted by reference — no second clone needed.
	 */
	private rememberProjectFingerprint(committedSnapshot?: ProjectState | null): void {
		if (committedSnapshot) {
			this.projectBaseSnapshot = committedSnapshot;
			this.projectBaseFingerprint = createProjectStateFingerprint(committedSnapshot);
			return;
		}
		this.projectBaseSnapshot = this.project ? cloneProjectState(this.project) : null;
		this.projectBaseFingerprint = this.projectBaseSnapshot ? createProjectStateFingerprint(this.projectBaseSnapshot) : null;
	}

	private adoptRemoteProjectMutation(surfaces: ProjectRemoteMutationSurface[]): void {
		if (!this.project) return;
		if (this.hasLocalProjectChanges()) {
			if (!this.projectBaseSnapshot) return;
			const base = this.projectBaseSnapshot as Record<ProjectRemoteMutationSurface, unknown>;
			const current = this.project as Record<ProjectRemoteMutationSurface, unknown>;
			for (const surface of surfaces) {
				base[surface] = JSON.parse(JSON.stringify(current[surface]));
			}
			this.projectBaseFingerprint = createProjectStateFingerprint(this.projectBaseSnapshot);
			return;
		}
		this.rememberProjectFingerprint();
		if (this.saveSyncStatus !== "saving") {
			this.saveSyncStatus = "saved";
			this.saveErrorMessage = null;
			this.saveErrorKind = null;
		}
	}

	private hasLocalProjectChanges(): boolean {
		return this.dirtyVersion > 0;
	}

	private pendingAiResultApplyKey(projectId: string, markerId: string): string {
		return `${projectId}::${markerId}`;
	}

	private rememberPendingAiResultApply(marker: AiReviewMarker): void {
		if (!this.project) return;
		this.pendingAiResultApplyMarkers.set(
			this.pendingAiResultApplyKey(this.project.projectId, marker.id),
			{
				projectId: this.project.projectId,
				markerId: marker.id,
				pageIndex: marker.pageIndex,
			},
		);
	}

	private forgetPendingAiResultApply(projectId: string, markerId: string): void {
		this.pendingAiResultApplyMarkers.delete(this.pendingAiResultApplyKey(projectId, markerId));
	}

	private getCurrentProjectPendingAiResultApplyMarkers(): PendingAiResultApplyMarker[] {
		if (!this.project) return [];
		const projectId = this.project.projectId;
		return [...this.pendingAiResultApplyMarkers.values()].filter((item) => item.projectId === projectId);
	}

	private hasCurrentProjectPendingAiResultApply(): boolean {
		return this.getCurrentProjectPendingAiResultApplyMarkers().length > 0;
	}

	private async assertNoStaleRemoteOverwrite(): Promise<void> {
		if (!this.project || !this.projectBaseFingerprint) return;

		const remoteProject = applySourceLangDefault(await api.loadProject(this.project.projectId));
		const remoteFingerprint = createProjectStateFingerprint(remoteProject);
		if (remoteFingerprint === this.projectBaseFingerprint) return;

		const localFingerprint = createProjectStateFingerprint(this.project);
		if (remoteFingerprint === localFingerprint) {
			this.projectBaseSnapshot = cloneProjectState(this.project);
			this.projectBaseFingerprint = remoteFingerprint;
			return;
		}

		throw new ProjectSaveConflictError();
	}

	private clearSelectedWorkItems(): void {
		this.selectedAiReviewMarkerId = null;
		this.selectedProjectCommentId = null;
		this.selectedWorkflowTaskId = null;
		this.selectedQcIssueId = null;
		this.selectedReviewDecisionId = null;
	}

	private cancelInFlightPageLoad(): void {
		this.pageLoadGeneration += 1;
		this.pageLoadInFlightKey = null;
		this.pageLoadInFlightEditor = null;
		this.pageLoadInFlightPromise = null;
		this.isLoadingPage = false;
	}

	private isActivePageLoad(projectRef: ProjectState, generation: number, pageIndex: number): boolean {
		return this.project === projectRef
			&& this.pageLoadGeneration === generation
			&& projectRef.currentPage === pageIndex;
	}

	private isActiveProjectOpen(generation: number, projectId: string): boolean {
		return this.projectOpenGeneration === generation
			&& (!this.project || this.project.projectId === projectId);
	}

	/**
	 * True when the given projectId is still the active open project. The AI poll
	 * guard calls this before EVERY client-side write (status message, marker
	 * update, canvas indicator) so a stale poll started under project A is
	 * discarded whenever a DIFFERENT project (or none) is open — never bleeding A's
	 * marker/status/indicator into B.
	 *
	 * Deliberately keyed on projectId ONLY, not the open-generation counter: a
	 * close-then-reopen of the SAME project (which still bumps projectOpenGeneration)
	 * must NOT neutralize that project's still-valid in-flight polls — the job is for
	 * the same project and its result still belongs there. Cross-project bleed is
	 * fully covered by the projectId check; the per-switch interval teardown
	 * (registerOnProjectSwitch → cancelPollsForProject) handles stopping the timers.
	 */
	isProjectContextCurrent(projectId: string): boolean {
		return this.project?.projectId === projectId;
	}

	/**
	 * Register a hook fired once a switch to a DIFFERENT projectId has been
	 * COMMITTED inside openProject() — after the save/lease gates pass and the new
	 * project's state is loaded, never on a failed switch (reopening the SAME
	 * project never fires it either, so fresh polls survive a benign rerender).
	 * Returns an unregister fn. Used by the AI jobs store to clear the outgoing
	 * project's poll intervals.
	 */
	registerOnProjectSwitch(hook: (previousProjectId: string | null, nextProjectId: string) => void): () => void {
		this.projectSwitchHooks.add(hook);
		return () => {
			this.projectSwitchHooks.delete(hook);
		};
	}

	private runProjectSwitchHooks(previousProjectId: string | null, nextProjectId: string): void {
		for (const hook of [...this.projectSwitchHooks]) {
			try {
				hook(previousProjectId, nextProjectId);
			} catch (error) {
				console.error("[ProjectStore] project-switch hook failed:", error);
			}
		}
	}

	/**
	 * Register a hook fired when the open project is RESTORED in place after an aborted
	 * switch (the create-flow rollback). The AI jobs store registers resumePolling here
	 * to re-arm poll intervals for the restored project's still-running rows. Returns an
	 * unregister fn. The hook receives the live editor so the re-armed polls can touch
	 * the freshly-mounted canvas (same editor handle the create flow was given).
	 */
	registerOnResumePolling(hook: (editor: any) => void): () => void {
		this.resumePollingHooks.add(hook);
		return () => {
			this.resumePollingHooks.delete(hook);
		};
	}

	private runResumePollingHooks(editor: any): void {
		for (const hook of [...this.resumePollingHooks]) {
			try {
				hook(editor);
			} catch (error) {
				console.error("[ProjectStore] resume-polling hook failed:", error);
			}
		}
	}

	/**
	 * Register a hook fired BEFORE the brand-new-project create flow assigns the new
	 * project id (while `this.project` still points at the project being left). The AI
	 * jobs store returns a deep-copy snapshot of that project's queue rows so a failed
	 * create can restore any row discarded during the create window. Returns an
	 * unregister fn. The returned arrays are concatenated (one entry per hook) into the
	 * opaque snapshot handed back to `runRestoreRowsHooks` on rollback.
	 */
	registerOnSnapshotRows(hook: (previousProjectId: string) => unknown[]): () => void {
		this.snapshotRowsHooks.add(hook);
		return () => {
			this.snapshotRowsHooks.delete(hook);
		};
	}

	private runSnapshotRowsHooks(previousProjectId: string): unknown[] {
		const snapshot: unknown[] = [];
		for (const hook of [...this.snapshotRowsHooks]) {
			try {
				snapshot.push(...hook(previousProjectId));
			} catch (error) {
				console.error("[ProjectStore] snapshot-rows hook failed:", error);
			}
		}
		return snapshot;
	}

	/**
	 * Register a hook fired on the create-flow ROLLBACK path (before the resume seam)
	 * with the rows captured by the snapshot seam. The AI jobs store re-inserts any
	 * snapshotted row whose id is gone (discarded mid-create) WITHOUT re-arming intervals
	 * — the resume seam that runs right after re-arms it. Returns an unregister fn.
	 */
	registerOnRestoreRows(hook: (rows: unknown[]) => void): () => void {
		this.restoreRowsHooks.add(hook);
		return () => {
			this.restoreRowsHooks.delete(hook);
		};
	}

	private runRestoreRowsHooks(rows: unknown[]): void {
		for (const hook of [...this.restoreRowsHooks]) {
			try {
				hook(rows);
			} catch (error) {
				console.error("[ProjectStore] restore-rows hook failed:", error);
			}
		}
	}

	/**
	 * Single seam for assigning `this.project` to a DIFFERENT project. Compares the
	 * outgoing projectId to the incoming one and fires the project-switch hooks
	 * (cancelPollsForProject → tear down the outgoing project's zombie AI poll intervals
	 * and drop its now-orphaned queue rows) ONLY on a real id change. Same-id reassigns
	 * (reload of the current project, in-place rollback, cover/export refresh) and the
	 * first open from a blank store (previousProjectId === null) do NOT fire the hooks —
	 * the projectId-keyed poll guard already keeps a same-project poll valid, and there is
	 * nothing to tear down on a first open.
	 *
	 * Every id-CHANGING assignment routes through here so the AI store learns about the
	 * switch no matter which flow caused it: loadFiles' brand-new project, a recovery-draft
	 * restore that lands a different project, and (via its own inline call) openProject.
	 * openProject keeps its bespoke call site because it must fire the hook at a precise
	 * seam (after the new state is irrevocably loaded + the generation re-checked, so a
	 * FAILED switch never tears down the still-open project); it therefore does NOT route
	 * through this helper. The assignment itself always happens; only the hook is gated.
	 *
	 * `fireHooks: false` does the id-changing ASSIGNMENT without running the switch hooks.
	 * A caller passes this when the switch is not yet COMMITTED — the assignment lands the
	 * new project into `this.project` (so subsequent steps build against it), but later
	 * throwing steps could still roll the switch back. Tearing down the OUTGOING project's
	 * polls/rows is irreversible (cancelPollsForProject drops them with nothing to restore),
	 * so the caller defers the hook until the flow commits (then calls runProjectSwitchHooks
	 * with the same prev→next ids itself). Mirrors the round-4 openProject lesson: fire the
	 * teardown only once the new state is irrevocable.
	 */
	private replaceOpenProject(next: ProjectState, options: { fireHooks?: boolean } = {}): void {
		const previousProjectId = this.project?.projectId ?? null;
		this.project = next;
		if (
			options.fireHooks !== false
			&& previousProjectId !== null
			&& previousProjectId !== next.projectId
		) {
			this.runProjectSwitchHooks(previousProjectId, next.projectId);
		}
	}

	private appendLocalActivity(event: ActivityEvent): void {
		this.activityLog = [event, ...this.activityLog];
		if (this.project) {
			this.project.activityLog = this.activityLog;
		}
	}

	private syncLocalWorkspaceFeed(): void {
		this.workspaceFeed = [
			...this.workspaceMessages.map((message): WorkspaceFeedItem => ({
				id: `message:${message.id}`,
				kind: "message",
				sourceId: message.id,
				pageIndex: message.pageIndex,
				title: message.body,
				detail: message.author,
				actor: message.author,
				createdAt: message.createdAt,
			})),
			...this.activityLog.map((event): WorkspaceFeedItem => ({
				id: `activity:${event.id}`,
				kind: "activity",
				sourceId: event.id,
				pageIndex: event.pageIndex,
				title: event.message,
				detail: event.actor,
				actor: event.actor,
				createdAt: event.createdAt,
			})),
		];
	}

	private updateLocalWorkflowTasks(
		update: WorkflowTaskBulkUpdate,
		successMessage: (changedCount: number) => string,
		emptyMessage: string,
	): number {
		const targetIds = new Set(update.taskIds);
		const updatedAt = new Date().toISOString();
		let changedCount = 0;
		this.tasks = this.tasks.map((task) => {
			if (!targetIds.has(task.id) || !workflowTaskChanged(task, update)) return task;
			changedCount += 1;
			return applyWorkflowTaskUpdate(task, update, updatedAt);
		});
		this.project!.tasks = this.tasks;
		if (changedCount > 0) {
			this.appendLocalActivity(createLocalActivity(
				"task_updated",
				successMessage(changedCount),
				{ taskId: update.taskIds[0] },
			));
		}
		this.statusMsg = changedCount > 0 ? successMessage(changedCount) : emptyMessage;
		return changedCount;
	}

	private remapPageLinkedState(plan: PageMovePlan): void {
		if (!this.project || !plan.moved) return;

		const tasks = this.tasks.length ? this.tasks : this.project.tasks ?? [];
		const activityLog = this.activityLog.length ? this.activityLog : this.project.activityLog ?? [];
		const comments = this.comments.length ? this.comments : this.project.comments ?? [];
		const aiReviewMarkers = this.aiReviewMarkers.length ? this.aiReviewMarkers : this.project.aiReviewMarkers ?? [];
		const reviewDecisions = this.reviewDecisions.length ? this.reviewDecisions : this.project.reviewDecisions ?? [];
		const workspaceMessages = this.workspaceMessages.length
			? this.workspaceMessages
			: this.project.workspaceMessages ?? [];

		this.tasks = tasks.map((task) => {
			const nextPageIndex = remapPageIndex(task.pageIndex, plan);
			return {
				...task,
				id: remapPageTaskId(task.id, plan),
				pageIndex: nextPageIndex,
				title: remapWorkflowTaskTitle(task.title, task.type, nextPageIndex),
			};
		});
		this.activityLog = activityLog.map((event) => ({
			...event,
			pageIndex: remapOptionalPageIndex(event.pageIndex, plan),
			taskId: remapOptionalPageTaskId(event.taskId, plan),
			metadata: remapPageTaskMetadata(event.metadata, plan),
		}));
		this.comments = comments.map((comment) => ({
			...comment,
			pageIndex: remapPageIndex(comment.pageIndex, plan),
		}));
		this.aiReviewMarkers = aiReviewMarkers.map((marker) => ({
			...marker,
			pageIndex: remapPageIndex(marker.pageIndex, plan),
			linkedTaskIds: remapPageTaskIds(marker.linkedTaskIds, plan),
		}));
		this.reviewDecisions = reviewDecisions.map((decision) => ({
			...decision,
			pageIndex: remapPageIndex(decision.pageIndex, plan),
		}));
		this.workspaceMessages = workspaceMessages.map((message) => ({
			...message,
			pageIndex: remapOptionalPageIndex(message.pageIndex, plan),
			linkedTaskId: remapOptionalPageTaskId(message.linkedTaskId, plan),
		}));
		this.workspaceFeed = this.workspaceFeed.map((item) => {
			const pageIndex = remapOptionalPageIndex(item.pageIndex, plan);
			if (item.kind !== "task") {
				return { ...item, pageIndex };
			}

			const sourceId = remapPageTaskId(item.sourceId, plan);
			const taskType = getPageTaskType(sourceId);
			return {
				...item,
				id: `task:${sourceId}`,
				sourceId,
				pageIndex,
				title: taskType && pageIndex !== undefined
					? remapWorkflowTaskTitle(item.title, taskType, pageIndex)
					: item.title,
			};
		});

		this.project.tasks = this.tasks;
		this.project.activityLog = this.activityLog;
		this.project.comments = this.comments;
		this.project.aiReviewMarkers = this.aiReviewMarkers;
		this.project.reviewDecisions = this.reviewDecisions;
		this.project.workspaceMessages = this.workspaceMessages;

		const remappedAssetErrors: Record<number, PageAssetLoadError[]> = {};
		for (const entry of Object.values(this.assetLoadErrors)) {
			const errors = Array.isArray(entry) ? entry : [entry];
			for (const error of errors) {
				const pageIndex = remapPageIndex(error.pageIndex, plan);
				remappedAssetErrors[pageIndex] = [
					...(remappedAssetErrors[pageIndex] ?? []),
					{ ...error, pageIndex },
				];
			}
		}
		this.assetLoadErrors = remappedAssetErrors;
		this.selectedWorkflowTaskId = remapOptionalPageTaskId(this.selectedWorkflowTaskId ?? undefined, plan) ?? null;
	}

	async loadVersions(): Promise<void> {
		if (!this.project) {
			this.versions = [];
			this.versionDetail = null;
			return;
		}
		if (!canLoadProjectVersionsFromBackend(this.project.projectId)) {
			this.versionsLoading = false;
			return;
		}
		this.versionsLoading = true;
		try {
			const { versions } = await api.getProjectVersions(this.project.projectId);
			this.versions = versions;
		} catch (error) {
			console.error("[ProjectStore] loadVersions error:", error);
			this.statusMsg = "โหลดประวัติเวอร์ชันไม่สำเร็จ";
		} finally {
			this.versionsLoading = false;
		}
	}

	/**
	 * Create a named version snapshot from the current persisted state. Flushes
	 * any unsaved local edits first so the snapshot captures the latest work,
	 * then asks the backend to record a labelled ("manual") version.
	 * Returns the created version, or null on failure.
	 */
	async saveNamedVersion(label: string): Promise<ProjectVersion | null> {
		if (!this.project) return null;
		const trimmed = label.trim().slice(0, MAX_VERSION_LABEL_LENGTH);
		if (!trimmed) {
			this.statusMsg = "ตั้งชื่อเวอร์ชันก่อนบันทึก";
			return null;
		}
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			this.statusMsg = "งานบนเครื่องนี้ยังบันทึกเวอร์ชันแบบตั้งชื่อไม่ได้";
			return null;
		}
		const projectId = this.project.projectId;
		this.versionsLoading = true;
		try {
			// Persist pending edits first so the named snapshot is current. Cancel the
			// pending debounce and wait for any autosave already in flight to settle,
			// otherwise our saveState() would race it and lose to a 409 conflict.
			this.cancelAutosave();
			await this.waitForAutosaveInFlight();
			if (this.hasLocalProjectChanges()) {
				await this.saveState();
			}
			const { version } = await api.createNamedProjectVersion(projectId, trimmed);
			await this.loadVersions();
			this.statusMsg = `บันทึกเวอร์ชัน "${trimmed}" แล้ว`;
			return version;
		} catch (error) {
			console.error("[ProjectStore] saveNamedVersion error:", error);
			this.statusMsg = `บันทึกเวอร์ชันไม่สำเร็จ: ${this.errorMessage(error, "ลองอีกครั้ง")}`;
			return null;
		} finally {
			this.versionsLoading = false;
		}
	}

	async loadVersionDetail(versionId: string): Promise<void> {
		if (!this.project || !versionId) {
			this.versionDetail = null;
			return;
		}
		if (!canLoadProjectVersionsFromBackend(this.project.projectId)) {
			if (this.versionDetail?.version.versionId !== versionId) {
				this.versionDetail = null;
			}
			this.versionDetailLoading = false;
			return;
		}
		this.versionDetailLoading = true;
		try {
			this.versionDetail = await api.getProjectVersionDetail(this.project.projectId, versionId);
		} catch (error) {
			console.error("[ProjectStore] loadVersionDetail error:", error);
			this.statusMsg = "โหลดรายละเอียดเวอร์ชันไม่สำเร็จ";
		} finally {
			this.versionDetailLoading = false;
		}
	}

	/**
	 * W3.9: compute a visual diff between two snapshots. Omit `baseVersionId`
	 * to compare the target against the live current project state.
	 */
	async compareVersions(targetVersionId: string, baseVersionId?: string): Promise<void> {
		if (!this.project || !targetVersionId) {
			this.versionComparison = null;
			return;
		}
		if (!canLoadProjectVersionsFromBackend(this.project.projectId)) {
			this.versionComparison = null;
			this.versionComparisonLoading = false;
			this.statusMsg = "งานบนเครื่องนี้ยังเทียบเวอร์ชันไม่ได้";
			return;
		}
		this.versionComparisonLoading = true;
		try {
			this.versionComparison = await api.compareProjectVersions(
				this.project.projectId,
				targetVersionId,
				baseVersionId,
			);
		} catch (error) {
			console.error("[ProjectStore] compareVersions error:", error);
			this.versionComparison = null;
			this.statusMsg = "เทียบเวอร์ชันไม่สำเร็จ";
		} finally {
			this.versionComparisonLoading = false;
		}
	}

	clearVersionComparison(): void {
		this.versionComparison = null;
	}

	private mergeVersionReviews(versionId: string, reviews: VersionReviewRequest[]): void {
		if (!this.project) return;
		const otherReviews = (this.project.versionReviewRequests ?? []).filter((review) => review.versionId !== versionId);
		this.project.versionReviewRequests = [...reviews, ...otherReviews];
		if (this.versionDetail?.version.versionId === versionId) {
			this.versionDetail = {
				...this.versionDetail,
				reviews,
			};
		}
	}

	async requestVersionReview(versionId: string, body: string): Promise<VersionReviewRequest | null> {
		if (!this.project || !versionId) return null;
		this.versionReviewLoading = true;
		try {
			const result = await api.createVersionReview(this.project.projectId, versionId, {
				body: body.trim() || undefined,
			});
			this.mergeVersionReviews(versionId, result.reviews);
			this.activityLog = result.activityLog;
			this.workspaceFeed = result.items;
			this.project.activityLog = result.activityLog;
			if (result.version) {
				await this.loadVersions();
			}
			this.statusMsg = "ขอรีวิวเวอร์ชันแล้ว";
			return result.review;
		} catch (error) {
			console.error("[ProjectStore] requestVersionReview error:", error);
			this.statusMsg = "ขอรีวิวเวอร์ชันไม่สำเร็จ";
			return null;
		} finally {
			this.versionReviewLoading = false;
		}
	}

	async updateVersionReview(
		versionId: string,
		reviewId: string,
		status: VersionReviewStatus,
		body: string,
	): Promise<VersionReviewRequest | null> {
		if (!this.project || !versionId || !reviewId) return null;
		this.versionReviewLoading = true;
		try {
			const result = await api.updateVersionReview(this.project.projectId, versionId, reviewId, {
				status,
				body: body.trim() || undefined,
			});
			this.mergeVersionReviews(versionId, result.reviews);
			this.activityLog = result.activityLog;
			this.workspaceFeed = result.items;
			this.project.activityLog = result.activityLog;
			if (result.version) {
				await this.loadVersions();
			}
			this.statusMsg = status === "approved" ? "อนุมัติเวอร์ชันแล้ว" : "อัปเดตผลรีวิวเวอร์ชันแล้ว";
			return result.review;
		} catch (error) {
			console.error("[ProjectStore] updateVersionReview error:", error);
			this.statusMsg = "อัปเดตผลรีวิวเวอร์ชันไม่สำเร็จ";
			return null;
		} finally {
			this.versionReviewLoading = false;
		}
	}

	/**
	 * Drop the currently-held Library listing and any in-flight/dedup state so a
	 * fresh, scoped fetch starts clean. Used on a workspace SWITCH: without this,
	 * the previous workspace's story shelves stay visible under the newly selected
	 * workspace (a cross-workspace leak) until something else happens to reload.
	 * Callers should follow this with a scoped `loadRecentProjects({ workspaceId })`.
	 */
	clearRecentProjects(): void {
		this.recentProjects = [];
		this.recentProjectsError = null;
		this.recentProjectsRequest = null;
		this.recentProjectsRequestWorkspaceId = undefined;
		this.recentProjectsRequestPreserveOrder = false;
		// Invalidate any in-flight load: bumping the token means a previous
		// workspace's still-awaiting `loadRecentProjects` will find its captured
		// token stale when it resolves and DROP its response instead of repopulating
		// the listing we just cleared.
		this.recentProjectsLoadToken += 1;
	}

	async loadRecentProjects(options: LoadRecentProjectsOptions = {}): Promise<void> {
		// Claim the LATEST-load token for this call. Every load (and every
		// `clearRecentProjects`) bumps it, so a token captured here goes stale the
		// instant a newer load or a workspace switch happens. After the fetch
		// awaits, we only assign `recentProjects` if our token is still the latest —
		// otherwise this is a stale response (e.g. workspace A resolving after the
		// user switched to B and B already loaded) and we DROP it.
		const loadToken = (this.recentProjectsLoadToken += 1);
		// Resolve the intended scope up front so the post-await guard can also verify
		// the response still matches the workspace this load targeted.
		const resolvedWorkspaceId = this.resolveRecentProjectsWorkspaceId(options.workspaceId);
		if (!options.background) {
			this.recentProjectsLoading = true;
			this.recentProjectsError = null;
		}
		if (options.preserveExistingOrder) {
			this.recentProjectsRequestPreserveOrder = true;
		}
		const shouldPreserveOrder = options.preserveExistingOrder || this.recentProjectsRequestPreserveOrder;
		try {
			const fetched = await this.fetchRecentProjects(resolvedWorkspaceId);
			// Stale-response guard: a newer load or a `clearRecentProjects` (workspace
			// switch) ran while we awaited → our token is no longer the latest, so
			// this response is for an outdated scope. Assign NOTHING; the newer load
			// owns the listing now.
			if (loadToken !== this.recentProjectsLoadToken) {
				return;
			}
			const projects = this.withCurrentLocalProjectSummary(fetched);
			this.recentProjects = shouldPreserveOrder
				? preserveRecentProjectOrder(this.recentProjects, projects)
				: projects;
		} catch (error) {
			// Only surface the error if THIS load is still the latest; a stale failed
			// load must not stomp the current scope's state.
			if (loadToken !== this.recentProjectsLoadToken) {
				return;
			}
			if (!options.silentFailure) {
				console.error("[ProjectStore] loadRecentProjects error:", error);
				this.statusMsg = "โหลดตอนล่าสุดไม่สำเร็จ";
				this.recentProjectsError = formatRecentProjectsError(error);
			}
		} finally {
			// Only the latest load owns the loading flag; a stale load resolving must
			// not flip a freshly-started newer load's spinner off.
			if (!options.background && loadToken === this.recentProjectsLoadToken) {
				this.recentProjectsLoading = false;
			}
		}
	}

	/**
	 * Resolve the workspace a Library load targets, mirroring the precedence
	 * `fetchRecentProjects` applies:
	 *   - a concrete string → that workspace.
	 *   - `null` → caller knows there is no resolvable workspace; scope to nothing.
	 *   - `undefined` → fall back to the persisted current-workspace id (or nothing).
	 * Captured at call time so the stale-response guard compares against the scope
	 * the load was actually issued for.
	 */
	private resolveRecentProjectsWorkspaceId(explicitWorkspaceId?: string | null): string | null {
		return explicitWorkspaceId === undefined
			? (readCurrentWorkspaceId() ?? null)
			: explicitWorkspaceId;
	}

	private fetchRecentProjects(explicitWorkspaceId?: string | null): Promise<ProjectSummary[]> {
		// Scope the Library to the CURRENT workspace so its story shelves contain
		// only that workspace's projects (cross-workspace isolation).
		//
		// The UI caller threads the RESOLVED current-workspace id from
		// `workspacesStore` (see `WorkspaceLibraryView` / `WorkspaceSidebar`):
		//   - a concrete string → scope to it.
		//   - `null` → the caller knows no workspace is resolvable yet → fetch
		//     NOTHING. We must NEVER fall through to `api.listProjects(undefined)`
		//     here, because that is the legacy UNSCOPED listing (every workspace's
		//     projects merged) — a cross-workspace data leak in the Library.
		//   - `undefined` (caller did not specify) → fall back to the persisted
		//     current-workspace id, and if THAT is also absent, still fetch nothing.
		//
		// `readCurrentWorkspaceId` reads the persisted current-workspace id directly
		// (NO static import of the workspaces/auth module graph — see its definition),
		// keeping the project store's test mocks unaffected.
		const workspaceId = this.resolveRecentProjectsWorkspaceId(explicitWorkspaceId);

		// No resolvable workspace → return an EMPTY listing instead of the legacy
		// unscoped (cross-workspace) one. The Library re-loads once the caller can
		// resolve a concrete workspace id.
		if (!workspaceId) {
			this.recentProjectsRequestPreserveOrder = false;
			return Promise.resolve([]);
		}

		// Reuse an in-flight request ONLY when it targets the same workspace.
		if (this.recentProjectsRequest && this.recentProjectsRequestWorkspaceId === workspaceId) {
			return this.recentProjectsRequest;
		}
		this.recentProjectsRequestWorkspaceId = workspaceId;
		this.recentProjectsRequest = api.listProjects(workspaceId)
			.then(({ projects }) => projects)
			.finally(() => {
				this.recentProjectsRequest = null;
				this.recentProjectsRequestPreserveOrder = false;
			});
		return this.recentProjectsRequest;
	}

	private withCurrentLocalProjectSummary(projects: ProjectSummary[]): ProjectSummary[] {
		if (!this.project || canUseBackendProjectEndpoints(this.project.projectId)) return projects;
		if (projects.some((project) => project.projectId === this.project?.projectId)) return projects;
		return [
			projectSummaryFromLocalState(this.project),
			...projects,
		];
	}

	async loadWorkflow(): Promise<void> {
		if (!this.project) {
			this.tasks = [];
			this.activityLog = [];
			return;
		}
		if (!canLoadProjectWorkflowFromBackend(this.project.projectId)) {
			this.tasks = this.project.tasks ?? [];
			this.activityLog = this.project.activityLog ?? [];
			if (this.selectedWorkflowTaskId && !this.tasks.some((task) => task.id === this.selectedWorkflowTaskId)) {
				this.selectedWorkflowTaskId = null;
			}
			return;
		}
		this.workflowLoading = true;
		try {
			const { tasks, activityLog } = await api.getProjectWorkflow(this.project.projectId);
			this.tasks = tasks;
			this.activityLog = activityLog;
			this.project.tasks = tasks;
			this.project.activityLog = activityLog;
			if (this.selectedWorkflowTaskId && !tasks.some((task) => task.id === this.selectedWorkflowTaskId)) {
				this.selectedWorkflowTaskId = null;
			}
		} catch (error) {
			console.error("[ProjectStore] loadWorkflow error:", error);
			this.statusMsg = "โหลดงานผลิตไม่สำเร็จ";
		} finally {
			this.workflowLoading = false;
		}
	}

	/**
	 * Re-anchor the save-conflict baseline to the SERVER's authoritative state right
	 * after a fresh chapter is created.
	 *
	 * The create flow builds `this.project` locally, then `saveState()` sets the
	 * baseline fingerprint from that LOCAL guess. But several top-level fields are
	 * server-owned/server-normalized and are NOT reflected back into `this.project`:
	 * `storyId` (minted via `generateStableStoryId()` on create), `workspaceId`
	 * (stamped from the request), and `targetLangs` (normalized to an array by
	 * `writeProjectState`). None of those are in the fingerprint-excluded set, so the
	 * local baseline diverges from the server's persisted state the moment the
	 * project is created — and the very next `GET /:id/workflow` re-persists the
	 * normalized state, locking the divergence in. The first edit / first AI gen then
	 * calls `assertNoStaleRemoteOverwrite()`, which refetches `GET /:id`, finds
	 * `remote !== baseline` (and `!== local`, since the editor hasn't changed those
	 * identity fields), and throws a FALSE `ProjectSaveConflictError` — blocking the
	 * first save (and the AI submit that depends on it) until a manual reload.
	 *
	 * The server is authoritative right after create, and there are no genuine local
	 * edits at this point (we just saved), so we adopt the server's normalized
	 * identity fields onto `this.project` and reset the baseline to server truth. This
	 * does NOT weaken conflict detection: page/layer/text/metadata still live in the
	 * fingerprint, so a real concurrent remote change after this point still trips the
	 * guard. We bail out if a local edit has already started (dirty) so we never
	 * silently discard in-flight work.
	 */
	private async resyncBaselineFromServerAfterCreate(): Promise<void> {
		if (!this.project) return;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) return;
		// Only safe while clean: the create flow re-syncs immediately after save, before
		// any editor change. If something already dirtied the project, leave the baseline
		// alone rather than risk clobbering local work.
		if (this.hasLocalProjectChanges() || this.hasCurrentProjectPendingAiResultApply()) return;
		const projectId = this.project.projectId;
		const localProject = this.project;
		try {
			const remoteProject = applySourceLangDefault(await api.loadProject(projectId));
			// Guard against an async project switch mid-fetch.
			if (!this.project || this.project.projectId !== projectId || this.project !== localProject) return;
			// The server is authoritative right after create and there are no local edits
			// yet, so adopt its normalized top-level fields as the new baseline. This
			// covers EVERY field that drifts between the locally-built guess and server
			// truth — not just the obvious identity ones (storyId / workspaceId /
			// targetLangs) but also normalized/defaulted fields and the server's own
			// `createdAt` — instead of trying to enumerate them.
			//
			// We deliberately PRESERVE the in-memory `pages` and `currentPage` (the page
			// content we just saved, which the editor is already showing) rather than
			// trusting the refetch for them: the saved pages ARE the server's pages, so
			// keeping the local copy is equivalent but can never wipe page state if the
			// refetch races a stale/empty read. `pages` already matches the server, so
			// the fingerprint still resolves to server truth.
			const adopted: ProjectState = {
				...remoteProject,
				pages: localProject.pages,
				currentPage: localProject.currentPage,
				// Keep the tasks/activity loadWorkflow() just hydrated (same persisted
				// source; both are fingerprint-excluded so the guard is unaffected).
				tasks: this.tasks,
				activityLog: this.activityLog,
			};
			this.project = adopted;
			this.targetLang = adopted.targetLang ?? this.targetLang;
			this.rememberProjectFingerprint();
		} catch (error) {
			// Best-effort: if the resync fails the worst case is the pre-existing false
			// conflict on first save, which the user can still recover from via reload.
			console.warn("[ProjectStore] resyncBaselineFromServerAfterCreate failed:", error);
		}
	}

	async updateTaskStatus(taskId: string, status: WorkflowTaskStatus): Promise<void> {
		if (!this.project) return;
		this.workflowLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const task = this.tasks.find((item) => item.id === taskId);
			this.updateLocalWorkflowTasks(
				{ taskIds: [taskId], status },
				() => `อัปเดตงานแล้ว: ${task?.title ?? "งาน"}`,
				"สถานะงานไม่เปลี่ยน",
			);
			this.workflowLoading = false;
			return;
		}
		try {
			const result = await api.updateTaskStatus(this.project.projectId, taskId, status);
			this.tasks = this.tasks.map((task) => task.id === result.task.id ? result.task : task);
			this.activityLog = result.activityLog;
			this.project.tasks = this.tasks;
			this.project.activityLog = this.activityLog;
			await this.loadVersions();
			await this.loadWorkspaceHub();
			this.adoptRemoteProjectMutation(["tasks", "activityLog"]);
			this.statusMsg = `อัปเดตงานแล้ว: ${result.task.title}`;
		} catch (error) {
			console.error("[ProjectStore] updateTaskStatus error:", error);
			this.statusMsg = "อัปเดตงานไม่สำเร็จ";
		} finally {
			this.workflowLoading = false;
		}
	}

	ensurePageReviewTask(pageIndex: number): WorkflowTask | null {
		if (!this.project) return null;
		const page = this.project.pages[pageIndex];
		if (!page) return null;
		const existing = this.tasks.find((task) =>
			task.type === "review"
			&& task.pageIndex === pageIndex
			&& task.status !== "done"
		);
		if (existing) {
			this.selectedWorkflowTaskId = existing.id;
			return existing;
		}
		const now = new Date().toISOString();
		const task: WorkflowTask = {
			id: createLocalStoreId(`page-review-p${pageIndex + 1}`),
			type: "review",
			status: "review",
			priority: "normal",
			pageIndex,
			pageImageId: page.imageId,
			title: `ตรวจหน้า ${pageIndex + 1} ก่อน Export`,
			createdAt: now,
			updatedAt: now,
		};
		this.tasks = [task, ...this.tasks];
		this.project.tasks = this.tasks;
		this.selectedWorkflowTaskId = task.id;
		this.appendLocalActivity(createLocalActivity(
			"task_updated",
			`สร้างงานตรวจหน้าแล้ว: ${task.title}`,
			{ pageIndex, taskId: task.id },
		));
		this.markCurrentPageUnsaved();
		this.statusMsg = `สร้างงานตรวจหน้า ${pageIndex + 1} แล้ว`;
		return task;
	}

	async updateTaskPriority(taskId: string, priority: WorkflowTaskPriority): Promise<void> {
		if (!this.project) return;
		this.workflowLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const task = this.tasks.find((item) => item.id === taskId);
			this.updateLocalWorkflowTasks(
				{ taskIds: [taskId], priority },
				() => `อัปเดตความด่วนแล้ว: ${task?.title ?? "งาน"}`,
				"ความด่วนงานไม่เปลี่ยน",
			);
			this.workflowLoading = false;
			return;
		}
		try {
			const result = await api.updateProjectTask(this.project.projectId, taskId, { priority });
			this.tasks = this.tasks.map((task) => task.id === result.task.id ? result.task : task);
			this.activityLog = result.activityLog;
			this.project.tasks = this.tasks;
			this.project.activityLog = this.activityLog;
			if (result.version) {
				await this.loadVersions();
			}
			await this.loadWorkspaceHub();
			this.adoptRemoteProjectMutation(["tasks", "activityLog"]);
			this.statusMsg = `อัปเดตความด่วนแล้ว: ${result.task.title}`;
		} catch (error) {
			console.error("[ProjectStore] updateTaskPriority error:", error);
			this.statusMsg = "อัปเดตความด่วนไม่สำเร็จ";
		} finally {
			this.workflowLoading = false;
		}
	}

	async bulkUpdateTasks(
		update: WorkflowTaskBulkUpdate,
		successMessage: (changedCount: number) => string = (changedCount) => `อัปเดต ${changedCount} งานแล้ว`,
		emptyMessage = "ไม่มีงานเปลี่ยน",
	): Promise<number> {
		if (!this.project || !update.taskIds.length) return 0;
		this.workflowLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const changedCount = this.updateLocalWorkflowTasks(update, successMessage, emptyMessage);
			this.workflowLoading = false;
			return changedCount;
		}
		try {
			const result = await api.bulkUpdateProjectTasks(this.project.projectId, update);
			const updatedTasks = new Map(result.tasks.map((task) => [task.id, task]));
			this.tasks = this.tasks.map((task) => updatedTasks.get(task.id) ?? task);
			this.activityLog = result.activityLog;
			this.project.tasks = this.tasks;
			this.project.activityLog = this.activityLog;
			if (result.version) {
				await this.loadVersions();
			}
			await this.loadWorkspaceHub();
			this.adoptRemoteProjectMutation(["tasks", "activityLog"]);
			this.statusMsg = result.changedCount > 0
				? successMessage(result.changedCount)
				: emptyMessage;
			return result.changedCount;
		} catch (error) {
			console.error("[ProjectStore] bulkUpdateTasks error:", error);
			this.statusMsg = "อัปเดตหลายงานไม่สำเร็จ";
			return 0;
		} finally {
			this.workflowLoading = false;
		}
	}

	async bulkUpdateTaskPriority(taskIds: string[], priority: WorkflowTaskPriority): Promise<number> {
		return this.bulkUpdateTasks(
			{ taskIds, priority },
			(changedCount) => `อัปเดตความด่วน ${changedCount} งานแล้ว`,
			"ความด่วนงานไม่เปลี่ยน",
		);
	}

	async bulkUpdateTaskStatus(taskIds: string[], status: WorkflowTaskStatus): Promise<number> {
		return this.bulkUpdateTasks(
			{ taskIds, status },
			(changedCount) => `อัปเดตสถานะ ${changedCount} งานแล้ว`,
			"สถานะงานไม่เปลี่ยน",
		);
	}

	/**
	 * Collab v1 — role-aware "submit on done" pipeline advance. Marks `taskId`
	 * DONE and, when it's not the terminal QC stage, OPENS the next stage on the
	 * same page (status → "todo") and assigns it to the next role. Replaces the
	 * old free-form status flip with the documented pipeline order
	 * (Clean → Translate → Typeset → QC). Persists through the existing task PATCH
	 * path in backend mode and the local workflow store in file-mode, so it works
	 * with no Postgres dependency. Returns the computed plan (for the UI to show
	 * the resulting stage), or null when the task can't be resolved.
	 */
	async submitTaskToNextStage(taskId: string): Promise<StageAdvancePlan | null> {
		if (!this.project) return null;
		const task = this.tasks.find((item) => item.id === taskId);
		if (!task) return null;
		const plan = planStageAdvance(task, this.tasks);

		this.workflowLoading = true;
		try {
			if (!canUseBackendProjectEndpoints(this.project.projectId)) {
				// File-mode: close the current stage, then open the next under its role.
				this.updateLocalWorkflowTasks(
					{ taskIds: [plan.currentTaskId], status: "done" },
					() => `ส่งงานต่อแล้ว: ${task.title}`,
					"สถานะงานไม่เปลี่ยน",
				);
				if (plan.nextTaskId && plan.nextAssignee) {
					this.updateLocalWorkflowTasks(
						{ taskIds: [plan.nextTaskId], status: "todo", assignee: plan.nextAssignee },
						() => `เปิดงานขั้นถัดไปให้ ${formatAssigneeHandle(plan.nextAssignee)}`,
						"งานขั้นถัดไปไม่เปลี่ยน",
					);
				}
				return plan;
			}

			// Backend: close the current stage via the bulk PATCH path.
			const doneResult = await api.bulkUpdateProjectTasks(this.project.projectId, {
				taskIds: [plan.currentTaskId],
				status: "done",
			});
			this.applyTaskMutationResult(doneResult.tasks, doneResult.activityLog);

			// Open the next stage (status + role assignee) when one exists.
			if (plan.nextTaskId && plan.nextAssignee) {
				const nextResult = await api.bulkUpdateProjectTasks(this.project.projectId, {
					taskIds: [plan.nextTaskId],
					status: "todo",
					assignee: plan.nextAssignee,
				});
				this.applyTaskMutationResult(nextResult.tasks, nextResult.activityLog);
			}

			await this.loadVersions();
			await this.loadWorkspaceHub();
			this.adoptRemoteProjectMutation(["tasks", "activityLog"]);
			// #E4: confirm the handoff actually worked. The backend branch used to return
			// SILENTLY (only the file-mode branch + the error path set a message), so a worker
			// in a real workspace couldn't tell their submit succeeded and just sat on the
			// finished page. Mirror the file-mode feedback.
			this.statusMsg = plan.nextAssignee
				? `ส่งงานต่อแล้ว: ${task.title} → เปิดให้ ${formatAssigneeHandle(plan.nextAssignee)}`
				: `ส่งงานต่อแล้ว: ${task.title} (จบสายงานแล้ว)`;
			return plan;
		} catch (error) {
			console.error("[ProjectStore] submitTaskToNextStage error:", error);
			this.statusMsg = "ส่งงานต่อไม่สำเร็จ";
			return null;
		} finally {
			this.workflowLoading = false;
		}
	}

	private applyTaskMutationResult(
		updatedTasks: readonly WorkflowTask[],
		activityLog: ActivityEvent[],
	): void {
		if (!this.project) return;
		const updated = new Map(updatedTasks.map((task) => [task.id, task]));
		this.tasks = this.tasks.map((task) => updated.get(task.id) ?? task);
		this.activityLog = activityLog;
		this.project.tasks = this.tasks;
		this.project.activityLog = this.activityLog;
	}

	async bulkUpdateTaskAssignee(taskIds: string[], assignee: string | null): Promise<number> {
		const normalizedAssignee = normalizeAssigneeHandle(assignee);
		const assigneeLabel = formatAssigneeHandle(normalizedAssignee);
		return this.bulkUpdateTasks(
			{ taskIds, assignee: normalizedAssignee },
			(changedCount) => normalizedAssignee
				? `มอบหมาย ${changedCount} งานให้ ${assigneeLabel}`
				: `ล้างคนรับงาน ${changedCount} งานแล้ว`,
			normalizedAssignee
				? `ไม่มีงานที่ต้องมอบหมายให้ ${assigneeLabel}`
				: "คนรับงานไม่เปลี่ยน",
		);
	}

	async bulkUpdateTaskDueAt(taskIds: string[], dueAt: string | null): Promise<number> {
		return this.bulkUpdateTasks(
			{ taskIds, dueAt },
			(changedCount) => dueAt ? `อัปเดตวันครบกำหนด ${changedCount} งานแล้ว` : `ล้างวันครบกำหนด ${changedCount} งานแล้ว`,
			dueAt ? "วันครบกำหนดไม่เปลี่ยน" : "ไม่มีวันครบกำหนดถูกล้าง",
		);
	}

	async updateTaskAssignee(taskId: string, assignee: string): Promise<void> {
		if (!this.project) return;
		this.workflowLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const normalizedAssignee = normalizeAssigneeHandle(assignee);
			const task = this.tasks.find((item) => item.id === taskId);
			this.updateLocalWorkflowTasks(
				{ taskIds: [taskId], assignee: normalizedAssignee },
				() => normalizedAssignee
					? `มอบหมาย ${task?.title ?? "งาน"} ให้ ${formatAssigneeHandle(normalizedAssignee)}`
					: `ล้างคนรับงาน: ${task?.title ?? "งาน"}`,
				"คนรับงานไม่เปลี่ยน",
			);
			this.workflowLoading = false;
			return;
		}
		try {
			const normalizedAssignee = normalizeAssigneeHandle(assignee);
			const result = await api.updateProjectTask(this.project.projectId, taskId, {
				assignee: normalizedAssignee,
			});
			this.tasks = this.tasks.map((task) => task.id === result.task.id ? result.task : task);
			this.activityLog = result.activityLog;
			this.project.tasks = this.tasks;
			this.project.activityLog = this.activityLog;
			if (result.version) {
				await this.loadVersions();
			}
			await this.loadWorkspaceHub();
			this.adoptRemoteProjectMutation(["tasks", "activityLog"]);
			this.statusMsg = normalizedAssignee
				? `มอบหมาย ${result.task.title} ให้ ${formatAssigneeHandle(normalizedAssignee)}`
				: `ล้างคนรับงาน: ${result.task.title}`;
		} catch (error) {
			console.error("[ProjectStore] updateTaskAssignee error:", error);
			this.statusMsg = "อัปเดตคนรับงานไม่สำเร็จ";
		} finally {
			this.workflowLoading = false;
		}
	}

	async updateTaskDueAt(taskId: string, dueAt: string | null): Promise<void> {
		if (!this.project) return;
		this.workflowLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const task = this.tasks.find((item) => item.id === taskId);
			this.updateLocalWorkflowTasks(
				{ taskIds: [taskId], dueAt },
				() => dueAt
					? `อัปเดตวันครบกำหนด: ${task?.title ?? "งาน"}`
					: `ล้างวันครบกำหนด: ${task?.title ?? "งาน"}`,
				dueAt ? "วันครบกำหนดไม่เปลี่ยน" : "ไม่มีวันครบกำหนดถูกล้าง",
			);
			this.workflowLoading = false;
			return;
		}
		try {
			const result = await api.updateProjectTask(this.project.projectId, taskId, { dueAt });
			this.tasks = this.tasks.map((task) => task.id === result.task.id ? result.task : task);
			this.activityLog = result.activityLog;
			this.project.tasks = this.tasks;
			this.project.activityLog = this.activityLog;
			if (result.version) {
				await this.loadVersions();
			}
			await this.loadWorkspaceHub();
			this.adoptRemoteProjectMutation(["tasks", "activityLog"]);
			this.statusMsg = result.task.dueAt
				? `อัปเดตวันครบกำหนด: ${result.task.title}`
				: `ล้างวันครบกำหนด: ${result.task.title}`;
		} catch (error) {
			console.error("[ProjectStore] updateTaskDueAt error:", error);
			this.statusMsg = "อัปเดตวันครบกำหนดไม่สำเร็จ";
		} finally {
			this.workflowLoading = false;
		}
	}

	async loadComments(): Promise<void> {
		if (!this.project) {
			this.comments = [];
			return;
		}
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			this.comments = this.project.comments ?? [];
			if (this.selectedProjectCommentId && !this.comments.some((comment) => comment.id === this.selectedProjectCommentId)) {
				this.selectedProjectCommentId = null;
			}
			this.commentsLoading = false;
			return;
		}
		this.commentsLoading = true;
		try {
			const { comments } = await api.getProjectComments(this.project.projectId);
			this.comments = comments;
			this.project.comments = comments;
			if (this.selectedProjectCommentId && !comments.some((comment) => comment.id === this.selectedProjectCommentId)) {
				this.selectedProjectCommentId = null;
			}
		} catch (error) {
			console.error("[ProjectStore] loadComments error:", error);
			this.statusMsg = "โหลดโน้ตไม่สำเร็จ";
		} finally {
			this.commentsLoading = false;
		}
	}

	async loadAiReviewMarkers(): Promise<void> {
		if (!this.project) {
			this.aiReviewMarkers = [];
			this.selectedAiReviewMarkerId = null;
			return;
		}
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			this.aiReviewMarkers = this.project.aiReviewMarkers ?? [];
			if (this.selectedAiReviewMarkerId && !this.aiReviewMarkers.some((marker) => marker.id === this.selectedAiReviewMarkerId)) {
				this.selectedAiReviewMarkerId = null;
			}
			this.aiReviewMarkersLoading = false;
			return;
		}
		this.aiReviewMarkersLoading = true;
		try {
			const { markers } = await api.getAiReviewMarkers(this.project.projectId);
			this.aiReviewMarkers = markers;
			this.project.aiReviewMarkers = markers;
			if (this.selectedAiReviewMarkerId && !markers.some((marker) => marker.id === this.selectedAiReviewMarkerId)) {
				this.selectedAiReviewMarkerId = null;
			}
		} catch (error) {
			console.error("[ProjectStore] loadAiReviewMarkers error:", error);
			this.statusMsg = "โหลดผล AI ไม่สำเร็จ";
		} finally {
			this.aiReviewMarkersLoading = false;
		}
	}

	/**
	 * Proactively recover any AI result that completed while the client poll loop
	 * was closed (the user navigated away during a minutes-long gen): the backend
	 * reconciles each stale `processing` marker against its job's DURABLE terminal
	 * result, so a finished result becomes ready (or a sanitized failure) WITHOUT a
	 * live poll. Called on AI-panel mount; harmless no-op when nothing is stale.
	 * The GET markers route also reconciles on read, so this is belt-and-suspenders.
	 */
	async reconcileAiReviewMarkers(): Promise<void> {
		if (!this.project) return;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) return;
		// Only worth a round-trip if some marker is actually still processing.
		if (!this.aiReviewMarkers.some((marker) => marker.status === "processing")) return;
		try {
			const { markers, changed } = await api.reconcileAiReviewMarkers(this.project.projectId);
			if (!this.project) return;
			this.aiReviewMarkers = markers;
			this.project.aiReviewMarkers = markers;
			if (this.selectedAiReviewMarkerId && !markers.some((marker) => marker.id === this.selectedAiReviewMarkerId)) {
				this.selectedAiReviewMarkerId = null;
			}
			if (changed) {
				this.statusMsg = "กู้ผล AI ที่ค้างอยู่แล้ว";
			}
		} catch (error) {
			console.error("[ProjectStore] reconcileAiReviewMarkers error:", error);
		}
	}

	async loadReviewDecisions(): Promise<void> {
		if (!this.project) {
			this.reviewDecisions = [];
			return;
		}
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			this.reviewDecisions = this.project.reviewDecisions ?? [];
			if (this.selectedReviewDecisionId && !this.reviewDecisions.some((decision) => decision.id === this.selectedReviewDecisionId)) {
				this.selectedReviewDecisionId = null;
			}
			this.reviewDecisionsLoading = false;
			return;
		}
		this.reviewDecisionsLoading = true;
		try {
			const { decisions } = await api.getProjectReviewDecisions(this.project.projectId);
			this.reviewDecisions = decisions;
			this.project.reviewDecisions = decisions;
			if (this.selectedReviewDecisionId && !decisions.some((decision) => decision.id === this.selectedReviewDecisionId)) {
				this.selectedReviewDecisionId = null;
			}
		} catch (error) {
			console.error("[ProjectStore] loadReviewDecisions error:", error);
			this.statusMsg = "โหลดผลรีวิวหน้าไม่สำเร็จ";
		} finally {
			this.reviewDecisionsLoading = false;
		}
	}

	async createReviewDecision(
		status: PageReviewDecisionStatus,
		body: string,
		targetPageIndex?: number,
	): Promise<PageReviewDecision | null> {
		if (!this.project) return null;
		// The review reader records a decision for the page the reviewer is LOOKING at
		// (the centered/visible page), not necessarily the editor's `currentPage`. Other
		// callers (WorkModePanel) omit the arg and keep the historical currentPage target.
		const decisionPageIndex = Number.isInteger(targetPageIndex)
			? Math.max(0, Math.min(targetPageIndex as number, this.project.pages.length - 1))
			: this.project.currentPage;
		this.reviewDecisionsLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const pageIndex = decisionPageIndex;
			const updatedAt = new Date().toISOString();
			const decision: PageReviewDecision = {
				id: createLocalStoreId("decision"),
				pageIndex,
				status,
				body: body.trim() || undefined,
				actor: "local",
				createdAt: updatedAt,
				updatedAt,
			};
			if (status === "approved") {
				this.tasks = this.tasks.map((task) => (
					task.type === "review" && task.pageIndex === pageIndex && task.status !== "done"
						? { ...task, status: "done", updatedAt }
						: task
				));
				this.project.tasks = this.tasks;
			}
			this.reviewDecisions = [decision, ...this.reviewDecisions];
			this.project.reviewDecisions = this.reviewDecisions;
			this.selectedReviewDecisionId = decision.id;
			this.appendLocalActivity(createLocalActivity(
				"review_decision_added",
				status === "approved"
					? `ผ่านรีวิวหน้า ${decision.pageIndex + 1} แล้ว`
					: `ส่งกลับแก้ หน้า ${decision.pageIndex + 1} แล้ว`,
				{ pageIndex: decision.pageIndex },
			));
			this.statusMsg = status === "approved"
				? `ผ่านรีวิวหน้า ${decision.pageIndex + 1} แล้ว`
				: `ส่งกลับแก้ หน้า ${decision.pageIndex + 1} แล้ว`;
			this.reviewDecisionsLoading = false;
			return decision;
		}
		try {
			const result = await api.createProjectReviewDecision(this.project.projectId, {
				pageIndex: decisionPageIndex,
				status,
				body: body.trim() || undefined,
			});
			this.reviewDecisions = result.decisions;
			this.tasks = result.tasks;
			this.activityLog = result.activityLog;
			this.project.reviewDecisions = this.reviewDecisions;
			this.project.tasks = this.tasks;
			this.project.activityLog = this.activityLog;
			this.selectedReviewDecisionId = result.decision.id;
			if (result.version) {
				await this.loadVersions();
			}
			this.adoptRemoteProjectMutation(["reviewDecisions", "tasks", "activityLog"]);
			this.statusMsg = status === "approved"
				? `ผ่านรีวิวหน้า ${result.decision.pageIndex + 1} แล้ว`
				: `ส่งกลับแก้ หน้า ${result.decision.pageIndex + 1} แล้ว`;
			return result.decision;
		} catch (error) {
			console.error("[ProjectStore] createReviewDecision error:", error);
			this.statusMsg = "บันทึกผลรีวิวหน้าไม่สำเร็จ";
			return null;
		} finally {
			this.reviewDecisionsLoading = false;
		}
	}

	// ── Review assignments ───────────────────────────────────────

	async loadReviewAssignments(): Promise<void> {
		if (!this.project) {
			this.reviewAssignments = [];
			return;
		}
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			this.reviewAssignments = this.project.reviewAssignments ?? [];
			return;
		}
		this.reviewAssignmentsLoading = true;
		try {
			const result = await api.listProjectReviewAssignments(this.project.projectId);
			this.reviewAssignments = result.assignments;
			if (this.project) this.project.reviewAssignments = result.assignments;
		} catch (error) {
			console.error("[ProjectStore] loadReviewAssignments error:", error);
		} finally {
			this.reviewAssignmentsLoading = false;
		}
	}

	async assignReview(input: api.ReviewAssignmentCreateInput): Promise<ReviewAssignment | null> {
		if (!this.project) return null;
		const projectId = this.project.projectId;
		this.reviewAssignmentsLoading = true;
		try {
			const result = await api.createProjectReviewAssignment(projectId, input);
			this.reviewAssignments = result.assignments;
			this.activityLog = result.activityLog;
			this.project.reviewAssignments = result.assignments;
			this.project.activityLog = result.activityLog;
			if (result.version) await this.loadVersions();
			this.adoptRemoteProjectMutation(["reviewAssignments", "activityLog"]);
			this.statusMsg = "มอบหมายงานรีวิวแล้ว";
			return result.assignment;
		} catch (error) {
			console.error("[ProjectStore] assignReview error:", error);
			this.statusMsg = "มอบหมายงานรีวิวไม่สำเร็จ";
			return null;
		} finally {
			this.reviewAssignmentsLoading = false;
		}
	}

	async updateReviewAssignmentStatus(assignmentId: string, status: ReviewAssignmentStatus): Promise<ReviewAssignment | null> {
		if (!this.project) return null;
		const projectId = this.project.projectId;
		this.reviewAssignmentsLoading = true;
		try {
			const result = await api.updateProjectReviewAssignment(projectId, assignmentId, { status });
			this.reviewAssignments = result.assignments;
			this.project.reviewAssignments = result.assignments;
			this.adoptRemoteProjectMutation(["reviewAssignments"]);
			return result.assignment;
		} catch (error) {
			console.error("[ProjectStore] updateReviewAssignmentStatus error:", error);
			return null;
		} finally {
			this.reviewAssignmentsLoading = false;
		}
	}

	/**
	 * Cancel a review assignment. The reason is MANDATORY (caller's dialog enforces
	 * a non-empty reason) and the backend ALWAYS notifies the affected reviewer —
	 * the cancel can never be silent. Returns `notified` so the UI can confirm.
	 */
	async cancelReviewAssignment(assignmentId: string, reason: string): Promise<{ assignment: ReviewAssignment; notified: boolean } | null> {
		if (!this.project) return null;
		const trimmed = reason.trim();
		if (!trimmed) return null;
		const projectId = this.project.projectId;
		this.reviewAssignmentsLoading = true;
		try {
			const result = await api.cancelProjectReviewAssignment(projectId, assignmentId, trimmed);
			this.reviewAssignments = result.assignments;
			this.activityLog = result.activityLog;
			this.project.reviewAssignments = result.assignments;
			this.project.activityLog = result.activityLog;
			if (result.version) await this.loadVersions();
			this.adoptRemoteProjectMutation(["reviewAssignments", "activityLog"]);
			// Reflect the REAL delivery state: only claim "and notified" when the
			// backend actually wrote the (mandatory) in-app notice. If it couldn't be
			// delivered, say the cancel succeeded but the notice could not be sent —
			// never claim a notification that didn't happen.
			this.statusMsg = result.notified
				? "ยกเลิกงานรีวิวและแจ้งผู้รับงานแล้ว"
				: "ยกเลิกงานรีวิวแล้ว แต่ส่งการแจ้งเตือนไม่สำเร็จ";
			return { assignment: result.assignment, notified: result.notified };
		} catch (error) {
			console.error("[ProjectStore] cancelReviewAssignment error:", error);
			this.statusMsg = "ยกเลิกงานรีวิวไม่สำเร็จ";
			return null;
		} finally {
			this.reviewAssignmentsLoading = false;
		}
	}

	// ── Revision send-back ──────────────────────────────────────────────────
	async loadRevisions(): Promise<void> {
		if (!this.project) {
			this.revisionRequests = [];
			return;
		}
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			this.revisionRequests = this.project.revisionRequests ?? [];
			return;
		}
		this.revisionRequestsLoading = true;
		try {
			const result = await api.listProjectRevisions(this.project.projectId);
			this.revisionRequests = result.revisions;
			if (this.project) this.project.revisionRequests = result.revisions;
		} catch (error) {
			console.error("[ProjectStore] loadRevisions error:", error);
		} finally {
			this.revisionRequestsLoading = false;
		}
	}

	/**
	 * Send work BACK to a worker as "revision #X" with a MANDATORY reason. The
	 * backend ALWAYS notifies the assigned worker (mandatory in-app + best-effort
	 * email) — the send-back can never be silent. Returns `notified` so the UI can
	 * reflect the REAL delivery state.
	 */
	async sendBackForRevision(input: api.RevisionRequestCreateInput): Promise<{ revision: RevisionRequest; notified: boolean } | null> {
		if (!this.project) return null;
		const reason = input.reason.trim();
		if (!reason) return null;
		const projectId = this.project.projectId;
		this.revisionRequestsLoading = true;
		try {
			const result = await api.createProjectRevision(projectId, { ...input, reason });
			this.revisionRequests = result.revisions;
			this.activityLog = result.activityLog;
			this.project.revisionRequests = result.revisions;
			this.project.activityLog = result.activityLog;
			if (result.version) await this.loadVersions();
			this.adoptRemoteProjectMutation(["revisionRequests", "activityLog"]);
			this.statusMsg = result.notified
				? `ส่งกลับให้แก้ Revision #${result.revision.revisionNumber} และแจ้งผู้รับงานแล้ว`
				: `ส่งกลับให้แก้ Revision #${result.revision.revisionNumber} แล้ว แต่ส่งการแจ้งเตือนไม่สำเร็จ`;
			return { revision: result.revision, notified: result.notified };
		} catch (error) {
			console.error("[ProjectStore] sendBackForRevision error:", error);
			this.statusMsg = "ส่งกลับให้แก้ไม่สำเร็จ";
			return null;
		} finally {
			this.revisionRequestsLoading = false;
		}
	}

	async updateRevisionStatus(revisionId: string, status: RevisionRequestStatus): Promise<RevisionRequest | null> {
		if (!this.project) return null;
		const projectId = this.project.projectId;
		this.revisionRequestsLoading = true;
		try {
			const result = await api.updateProjectRevision(projectId, revisionId, { status });
			this.revisionRequests = result.revisions;
			this.activityLog = result.activityLog;
			this.project.revisionRequests = result.revisions;
			this.project.activityLog = result.activityLog;
			this.adoptRemoteProjectMutation(["revisionRequests", "activityLog"]);
			return result.revision;
		} catch (error) {
			console.error("[ProjectStore] updateRevisionStatus error:", error);
			return null;
		} finally {
			this.revisionRequestsLoading = false;
		}
	}

	async loadWorkspaceHub(): Promise<void> {
		if (!this.project) {
			this.workspaceFeed = [];
			this.workspaceMessages = [];
			return;
		}
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			this.workspaceMessages = this.project.workspaceMessages ?? [];
			this.activityLog = this.project.activityLog ?? [];
			this.workspaceHubLoading = false;
			return;
		}
		this.workspaceHubLoading = true;
		try {
			const result = await api.getWorkspaceFeed(this.project.projectId);
			this.workspaceFeed = result.items;
			this.workspaceMessages = result.messages;
			this.activityLog = result.activityLog;
			this.project.workspaceMessages = result.messages;
			this.project.activityLog = result.activityLog;
		} catch (error) {
			console.error("[ProjectStore] loadWorkspaceHub error:", error);
			this.statusMsg = "โหลดบันทึกทีมไม่สำเร็จ";
		} finally {
			this.workspaceHubLoading = false;
		}
	}

	async loadCurrentWorkspaceMember(): Promise<void> {
		const workspaceId = this.project?.workspaceId?.trim();
		if (!workspaceId) {
			this.currentWorkspaceMember = null;
			this.currentWorkspaceMemberLoading = false;
			this.viewerStoryDutyRoles = [];
			return;
		}
		this.currentWorkspaceMemberLoading = true;
		try {
			const result = await api.getWorkspace(workspaceId);
			this.currentWorkspaceMember = result.member;
		} catch (error) {
			console.error("[ProjectStore] loadCurrentWorkspaceMember error:", error);
			this.currentWorkspaceMember = null;
		} finally {
			this.currentWorkspaceMemberLoading = false;
		}
		await this.loadViewerStoryDutyRoles(workspaceId);
	}

	// Fetch the viewer's series-level duty roles for the open story (multi-duty).
	// Best-effort + silent: a failure just leaves the studio-role caps in place.
	private async loadViewerStoryDutyRoles(workspaceId: string): Promise<void> {
		const storyId = this.project?.storyId?.trim();
		if (!storyId) {
			this.viewerStoryDutyRoles = [];
			return;
		}
		const { authStore } = await import("$lib/stores/auth.svelte.ts");
		const viewerId = authStore.currentUser?.id;
		if (!viewerId) {
			this.viewerStoryDutyRoles = [];
			return;
		}
		try {
			const { assignments } = await api.listStoryAssignments(workspaceId, storyId);
			this.viewerStoryDutyRoles = assignments
				.filter((a) => a.userId === viewerId)
				.map((a) => a.role);
		} catch {
			this.viewerStoryDutyRoles = [];
		}
	}

	async addWorkspaceMessage(body: string): Promise<WorkspaceMessage | null> {
		if (!this.project) return null;
		const trimmedBody = body.trim();
		if (!trimmedBody) return null;
		this.workspaceHubLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const message: WorkspaceMessage = {
				id: createLocalStoreId("message"),
				pageIndex: this.project.currentPage,
				body: trimmedBody,
				author: "local",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			this.workspaceMessages = [message, ...this.workspaceMessages];
			this.project.workspaceMessages = this.workspaceMessages;
			this.appendLocalActivity(createLocalActivity(
				"workspace_message_added",
				formatWorkspaceNoteAddedMessage(message.pageIndex),
				{ pageIndex: message.pageIndex },
			));
			this.syncLocalWorkspaceFeed();
			this.statusMsg = formatWorkspaceNoteAddedMessage(message.pageIndex);
			this.workspaceHubLoading = false;
			return message;
		}
		try {
			const result = await api.createWorkspaceMessage(this.project.projectId, {
				pageIndex: this.project.currentPage,
				body: trimmedBody,
			});
			this.workspaceFeed = result.items;
			this.workspaceMessages = result.messages;
			this.activityLog = result.activityLog;
			this.project.workspaceMessages = result.messages;
			this.project.activityLog = result.activityLog;
			if (result.version) {
				await this.loadVersions();
			}
			this.adoptRemoteProjectMutation(["workspaceMessages", "activityLog"]);
			this.statusMsg = formatWorkspaceNoteAddedMessage(result.message.pageIndex);
			return result.message;
		} catch (error) {
			console.error("[ProjectStore] addWorkspaceMessage error:", error);
			this.statusMsg = "เพิ่มโน้ตทีมไม่สำเร็จ";
			return null;
		} finally {
			this.workspaceHubLoading = false;
		}
	}

	async createAiReviewMarker(input: AiReviewMarkerCreateInput, options: AiReviewMarkerCreateOptions = {}): Promise<AiReviewMarker | null> {
		if (!this.project) return null;
		// The owning project is captured (with the project ref) BEFORE the API await.
		// The server write below targets THIS id, not whatever is open when the await
		// resolves, and the local-state apply is gated on it afterward — so a create
		// whose project was switched away mid-await still persists for the owner but
		// never writes the owner's marker response into the now-open project.
		const ownerProjectRef = this.project;
		const ownerProjectId = options.forProjectId ?? ownerProjectRef.projectId;
		// Local (backend-ineligible) markers only ever live in the open project's
		// in-memory state; cross-project ownership has no meaning there (the server
		// owns nothing to reload from), so an explicit forProjectId that does not
		// match the open project cannot be honored locally — skip rather than mutate
		// the wrong project's state.
		if (options.forProjectId && options.forProjectId !== ownerProjectRef.projectId && !canUseBackendProjectEndpoints(ownerProjectId)) {
			return null;
		}
		this.aiReviewMarkersLoading = true;
		if (!canUseBackendProjectEndpoints(ownerProjectId)) {
			const marker: AiReviewMarker = {
				id: createLocalStoreId("marker"),
				jobId: input.jobId,
				pageIndex: input.pageIndex,
				imageId: input.imageId,
				region: input.region,
				status: input.status ?? "needs_review",
				tier: input.tier,
				providerHint: input.providerHint,
				customPrompt: input.customPrompt,
				textLayers: input.textLayers,
				translateSfx: input.translateSfx,
				costEstimate: input.costEstimate,
				creditReservation: input.creditReservation,
				resultImageId: input.resultImageId,
				error: input.error,
				assignee: input.assignee,
				linkedCommentIds: input.linkedCommentIds,
				linkedTaskIds: input.linkedTaskIds,
				sourceMarkerId: input.sourceMarkerId,
				rerunIdempotencyKey: input.rerunIdempotencyKey,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			this.aiReviewMarkers = [marker, ...this.aiReviewMarkers];
			this.project.aiReviewMarkers = this.aiReviewMarkers;
			this.selectedAiReviewMarkerId = marker.id;
			this.appendLocalActivity(createLocalActivity(
				"ai_marker_created",
				formatAiMarkerPageMessage("สร้างผล AI", marker.pageIndex),
				{ pageIndex: marker.pageIndex },
			));
			this.statusMsg = formatAiMarkerPageMessage("สร้างผล AI", marker.pageIndex);
			this.aiReviewMarkersLoading = false;
			return marker;
		}
		// Count this server-backed create as in-flight; the finally clears the store-wide
		// loading flag only when the LAST concurrent create settles (see field comment).
		this.createAiReviewMarkerInFlight += 1;
		try {
			const result = await api.createAiReviewMarker(ownerProjectId, input);
			// Apply locally iff the CURRENTLY open project is still the marker's owner BY
			// ID — deliberately NOT the captured `ownerProjectRef` reference. A freshly
			// CREATED marker is NEW server state that postdates any reload, so merging it
			// into a same-id owner is always safe even if the user closed and REOPENED the
			// owner mid-await (a fresh project object with the same id). The reference
			// equality used by updateAiReviewMarker guards the opposite direction — adopting
			// a marker MUTATION as the new baseline must not run against a stale pre-reload
			// snapshot — which does not apply to a create. result.markers/activityLog/tasks
			// are the FULL remote-owned lists, so the apply below is a complete replacement
			// (not a diff against the old object), and adoptRemoteProjectMutation rebaselines
			// off this.project (the reopened object), so a reloaded owner is handled cleanly.
			//
			// The id match is necessary but not sufficient on a SIGN-OUT mid-await: the AI
			// store's cleanup() wipes its session state but the project store may still hold
			// the owner's id, so a same-id check alone would let a dead session's marker apply
			// locally. The optional isContextCurrent callback (the AI store passes its captured-
			// generation check) closes that gap; the server write above already happened so the
			// owner's state stays consistent and reloads the marker on the next open.
			if (this.project?.projectId !== ownerProjectId || !(options.isContextCurrent?.() ?? true)) {
				return result.marker;
			}
			this.aiReviewMarkers = result.markers;
			this.activityLog = result.activityLog;
			this.project.aiReviewMarkers = this.aiReviewMarkers;
			this.project.activityLog = this.activityLog;
			if (result.tasks) {
				this.tasks = result.tasks;
				this.project.tasks = this.tasks;
			}
			this.selectedAiReviewMarkerId = result.marker.id;
			if (result.version) {
				await this.loadVersions();
			}
			this.adoptRemoteProjectMutation(["aiReviewMarkers", "activityLog", "tasks"]);
			return result.marker;
		} catch (error) {
			console.error("[ProjectStore] createAiReviewMarker error:", error);
			if (this.project === ownerProjectRef && this.project.projectId === ownerProjectId) {
				this.statusMsg = "สร้างผล AI ไม่สำเร็จ";
			}
			return null;
		} finally {
			// The loading flag is REQUEST-scoped (set on entry, store-wide), NOT apply-scoped:
			// it must always settle when the request finishes, regardless of whether the open
			// project was replaced mid-create. Gating it on `this.project === ownerProjectRef`
			// (the round-9 regression) left the flag stuck-true after any same-id reload /
			// draft-restore / switch, wedging the AI panel in loading/readonly. Clear only when
			// the LAST concurrent create settles so an earlier finish can't unwedge the panel
			// while another create is still running. The marker STATE apply above stays gated on
			// the id/context check — only the flag is unconditional here.
			this.createAiReviewMarkerInFlight -= 1;
			if (this.createAiReviewMarkerInFlight <= 0) {
				this.createAiReviewMarkerInFlight = 0;
				this.aiReviewMarkersLoading = false;
			}
		}
	}

	async updateAiReviewMarker(markerId: string, input: AiReviewMarkerUpdateInput, options: AiReviewMarkerUpdateOptions = {}): Promise<AiReviewMarker | null> {
		if (!this.project) return null;
		const shouldSelect = options.select !== false;
		const projectRef = this.project;
		const projectId = projectRef.projectId;
		this.aiReviewMarkersLoading = true;
		if (!canUseBackendProjectEndpoints(projectId)) {
			const existingMarker = this.aiReviewMarkers.find((marker) => marker.id === markerId);
			if (!existingMarker) {
				this.statusMsg = "ไม่พบผล AI นี้";
				this.aiReviewMarkersLoading = false;
				return null;
			}
			const marker: AiReviewMarker = {
				...existingMarker,
				...input,
				assignee: input.assignee !== undefined ? input.assignee ?? undefined : existingMarker.assignee,
				updatedAt: new Date().toISOString(),
			};
			this.aiReviewMarkers = this.aiReviewMarkers.map((item) => item.id === markerId ? marker : item);
			this.project.aiReviewMarkers = this.aiReviewMarkers;
			if (shouldSelect) {
				this.selectedAiReviewMarkerId = marker.id;
			}
			this.appendLocalActivity(createLocalActivity(
				"ai_marker_updated",
				formatAiMarkerStatusMessage(marker.status),
				{ pageIndex: marker.pageIndex },
			));
			this.statusMsg = formatAiMarkerStatusMessage(marker.status);
			this.aiReviewMarkersLoading = false;
			return marker;
		}
		try {
			const result = await api.updateAiReviewMarker(projectId, markerId, input);
			if (this.project !== projectRef || this.project.projectId !== projectId) {
				return null;
			}
			this.aiReviewMarkers = result.markers;
			this.activityLog = result.activityLog;
			this.project.aiReviewMarkers = this.aiReviewMarkers;
			this.project.activityLog = this.activityLog;
			if (result.tasks) {
				this.tasks = result.tasks;
				this.project.tasks = this.tasks;
			}
			if (result.version) {
				await this.loadVersions();
			}
			this.adoptRemoteProjectMutation(["aiReviewMarkers", "activityLog", "tasks"]);
			this.statusMsg = formatAiMarkerStatusMessage(result.marker.status);
			return result.marker;
		} catch (error) {
			console.error("[ProjectStore] updateAiReviewMarker error:", error);
			this.statusMsg = "อัปเดตผล AI ไม่สำเร็จ";
			return null;
		} finally {
			if (this.project === projectRef) {
				this.aiReviewMarkersLoading = false;
			}
		}
	}

	async updateAiReviewMarkerStatus(markerId: string, status: AiReviewMarkerStatus): Promise<AiReviewMarker | null> {
		return this.updateAiReviewMarker(markerId, { status });
	}

	private aiResultLayerExists(marker: AiReviewMarker): boolean {
		const page = this.project?.pages[marker.pageIndex];
		return page?.imageLayers?.some((layer) => layer.id === `ai-result-${marker.id}`) === true;
	}

	private async resolveAiResultApplyStatus(marker: AiReviewMarker): Promise<"applied" | "pending" | "failed"> {
		if (!this.project) return "failed";
		if (canUseBackendProjectEndpoints(this.project.projectId) && this.saveSyncStatus !== "saved") {
			this.rememberPendingAiResultApply(marker);
			return "pending";
		}
		if (!this.aiResultLayerExists(marker)) {
				this.statusMsg = "วางผล AI ยังไม่สมบูรณ์: ไม่พบเลเยอร์ผล AI ในหน้านี้";
			return "failed";
		}
		const updated = await this.updateAiReviewMarkerStatus(marker.id, "applied");
		if (!updated) {
			this.rememberPendingAiResultApply(marker);
				this.statusMsg = "วางผล AI เป็นเลเยอร์แล้ว แต่ปิดรายการผล AI ไม่สำเร็จ: กดบันทึกเพื่อลองอีกครั้ง";
			return "failed";
		}
		this.forgetPendingAiResultApply(this.project.projectId, marker.id);
		return "applied";
	}

	private async flushPendingAiResultApplyMarkers(): Promise<{ failed: number }> {
		if (!this.project || !this.pendingAiResultApplyMarkers.size) return { failed: 0 };
		const projectRef = this.project;
		const projectId = projectRef.projectId;
		const pendingItems = this.getCurrentProjectPendingAiResultApplyMarkers();
		if (!pendingItems.length) return { failed: 0 };
		let appliedCount = 0;
		let failedCount = 0;
		for (const pending of pendingItems) {
			if (this.project !== projectRef || this.project.projectId !== projectId) return { failed: failedCount };
			const markerId = pending.markerId;
			const marker = this.aiReviewMarkers.find((item) => item.id === markerId)
				?? this.project.aiReviewMarkers?.find((item) => item.id === markerId);
			if (!marker) {
				this.forgetPendingAiResultApply(projectId, markerId);
				continue;
			}
			if (!this.aiResultLayerExists(marker)) {
				failedCount += 1;
				continue;
			}
			const updated = await this.updateAiReviewMarkerStatus(markerId, "applied");
			if (this.project !== projectRef || this.project.projectId !== projectId) return { failed: failedCount };
			if (updated) {
				this.forgetPendingAiResultApply(projectId, markerId);
				appliedCount += 1;
			} else {
				failedCount += 1;
			}
		}
		if (failedCount > 0) {
			this.statusMsg = "บันทึกเลเยอร์ผล AI แล้ว แต่ปิดรายการผล AI ไม่สำเร็จ: ลองบันทึกอีกครั้ง";
		} else if (appliedCount > 0) {
			this.statusMsg = "บันทึกเลเยอร์ผล AI แล้ว และปิดรายการผล AI แล้ว";
		}
		return { failed: failedCount };
	}

	async assignAiReviewMarker(markerId: string, assignee: string): Promise<void> {
		const normalizedAssignee = normalizeAssigneeHandle(assignee);
		await this.updateAiReviewMarker(markerId, {
			assignee: normalizedAssignee,
		});
		this.statusMsg = normalizedAssignee
			? `มอบหมายผล AI ให้ ${formatAssigneeHandle(normalizedAssignee)}`
			: "ล้างผู้รับผิดชอบของผล AI แล้ว";
	}

	async createAiReviewMarkerComment(markerId: string, body?: string): Promise<ProjectComment | null> {
		if (!this.project) return null;
		this.aiReviewMarkersLoading = true;
		this.commentsLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const marker = this.aiReviewMarkers.find((item) => item.id === markerId);
			if (!marker) {
				this.statusMsg = "ไม่พบผล AI นี้";
				this.aiReviewMarkersLoading = false;
				this.commentsLoading = false;
				return null;
			}
			const comment: ProjectComment = {
				id: createLocalStoreId("comment"),
				pageIndex: marker.pageIndex,
				region: marker.region,
				body: body?.trim() || "โน้ตแก้ผล AI",
				author: "local",
				mentions: [],
				status: "open",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			const updatedMarker: AiReviewMarker = {
				...marker,
				linkedCommentIds: Array.from(new Set([...(marker.linkedCommentIds ?? []), comment.id])),
				updatedAt: new Date().toISOString(),
			};
			this.comments = [comment, ...this.comments];
			this.aiReviewMarkers = this.aiReviewMarkers.map((item) => item.id === markerId ? updatedMarker : item);
			this.project.comments = this.comments;
			this.project.aiReviewMarkers = this.aiReviewMarkers;
			this.selectedAiReviewMarkerId = updatedMarker.id;
			this.selectedProjectCommentId = comment.id;
			this.appendLocalActivity(createLocalActivity(
				"comment_added",
				formatAiMarkerPageMessage("เพิ่มโน้ตแก้ผล AI", comment.pageIndex),
				{ pageIndex: comment.pageIndex },
			));
			this.statusMsg = formatAiMarkerPageMessage("เพิ่มโน้ตแก้ผล AI", comment.pageIndex);
			this.aiReviewMarkersLoading = false;
			this.commentsLoading = false;
			return comment;
		}
		try {
			const result = await api.createAiReviewMarkerComment(this.project.projectId, markerId, {
				body: body?.trim() || undefined,
			});
			this.aiReviewMarkers = result.markers;
			this.comments = result.comments;
			this.activityLog = result.activityLog;
			this.project.aiReviewMarkers = this.aiReviewMarkers;
			this.project.comments = this.comments;
			this.project.activityLog = this.activityLog;
			this.selectedAiReviewMarkerId = result.marker.id;
			if (result.version) {
				await this.loadVersions();
			}
			this.adoptRemoteProjectMutation(["aiReviewMarkers", "comments", "activityLog"]);
			this.statusMsg = formatAiMarkerPageMessage("เพิ่มโน้ตแก้ผล AI", result.comment.pageIndex);
			return result.comment;
		} catch (error) {
			console.error("[ProjectStore] createAiReviewMarkerComment error:", error);
			this.statusMsg = "เพิ่มโน้ตแก้ผล AI ไม่สำเร็จ";
			return null;
		} finally {
			this.aiReviewMarkersLoading = false;
			this.commentsLoading = false;
		}
	}

	async linkAiReviewMarkerReviewTask(markerId: string, assignee?: string): Promise<WorkflowTask | null> {
		if (!this.project) return null;
		this.aiReviewMarkersLoading = true;
		this.workflowLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const marker = this.aiReviewMarkers.find((item) => item.id === markerId);
			if (!marker) {
				this.statusMsg = "ไม่พบผล AI นี้";
				this.aiReviewMarkersLoading = false;
				this.workflowLoading = false;
				return null;
			}
			const normalizedAssignee = normalizeAssigneeHandle(assignee);
			const task: WorkflowTask = {
				id: createLocalStoreId(`ai-review-p${marker.pageIndex + 1}`),
				type: "review",
				status: "todo",
				priority: "high",
				pageIndex: marker.pageIndex,
				pageImageId: marker.imageId,
				title: `รีวิวผล AI หน้า ${marker.pageIndex + 1}`,
				assignee: normalizedAssignee ?? undefined,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			const updatedMarker: AiReviewMarker = {
				...marker,
				linkedTaskIds: Array.from(new Set([...(marker.linkedTaskIds ?? []), task.id])),
				updatedAt: new Date().toISOString(),
			};
			this.tasks = [task, ...this.tasks];
			this.aiReviewMarkers = this.aiReviewMarkers.map((item) => item.id === markerId ? updatedMarker : item);
			this.project.tasks = this.tasks;
			this.project.aiReviewMarkers = this.aiReviewMarkers;
			this.selectedAiReviewMarkerId = updatedMarker.id;
			this.selectedWorkflowTaskId = task.id;
			this.appendLocalActivity(createLocalActivity(
				"task_updated",
				`สร้างงานแก้จากผล AI แล้ว: ${task.title}`,
				{ pageIndex: task.pageIndex, taskId: task.id },
			));
			this.statusMsg = `สร้างงานแก้จากผล AI แล้ว: ${task.title}`;
			this.aiReviewMarkersLoading = false;
			this.workflowLoading = false;
			return task;
		}
		try {
			const normalizedAssignee = normalizeAssigneeHandle(assignee);
			const result = await api.linkAiReviewMarkerReviewTask(this.project.projectId, markerId, {
				assignee: normalizedAssignee ?? undefined,
			});
			this.aiReviewMarkers = result.markers;
			this.tasks = result.tasks;
			this.activityLog = result.activityLog;
			this.project.aiReviewMarkers = this.aiReviewMarkers;
			this.project.tasks = this.tasks;
			this.project.activityLog = this.activityLog;
			this.selectedAiReviewMarkerId = result.marker.id;
			if (result.version) {
				await this.loadVersions();
			}
			this.adoptRemoteProjectMutation(["aiReviewMarkers", "tasks", "activityLog"]);
			this.statusMsg = `สร้างงานแก้จากผล AI แล้ว: ${result.task.title}`;
			return result.task;
		} catch (error) {
			console.error("[ProjectStore] linkAiReviewMarkerReviewTask error:", error);
			this.statusMsg = "สร้างงานแก้จากผล AI ไม่สำเร็จ";
			return null;
		} finally {
			this.aiReviewMarkersLoading = false;
			this.workflowLoading = false;
		}
	}

	async addPageComment(
		body: string,
		layerId?: string,
		region?: { x: number; y: number; w: number; h: number },
		options?: { annotation?: ReviewAnnotation; pageIndex?: number }
	): Promise<ProjectComment | null> {
		if (!this.project) return null;
		const trimmedBody = body.trim();
		if (!trimmedBody) return null;
		// The review reader marks a SPECIFIC page (which may not be `currentPage`),
		// so allow an explicit target; default to the open page for editor callers.
		const targetPageIndex = options?.pageIndex ?? this.project.currentPage;
		const annotation = options?.annotation;
		this.commentsLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const comment: ProjectComment = {
				id: createLocalStoreId("comment"),
				pageIndex: targetPageIndex,
				layerId,
				region,
				annotation,
				body: trimmedBody,
				author: "local",
				mentions: [],
				status: "open",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			this.comments = [comment, ...this.comments];
			this.project.comments = this.comments;
			this.selectedProjectCommentId = comment.id;
			this.appendLocalActivity(createLocalActivity(
				"comment_added",
				formatPageCommentAddedMessage(comment.pageIndex),
				{ pageIndex: comment.pageIndex },
			));
			this.statusMsg = formatPageCommentAddedMessage(comment.pageIndex);
			this.commentsLoading = false;
			return comment;
		}
		try {
			const result = await api.createProjectComment(this.project.projectId, {
				pageIndex: targetPageIndex,
				layerId,
				region,
				annotation,
				body: trimmedBody,
			});
			this.comments = result.comments;
			this.activityLog = result.activityLog;
			this.project.comments = this.comments;
			this.project.activityLog = this.activityLog;
			this.selectedProjectCommentId = result.comment.id;
			await this.loadVersions();
			this.adoptRemoteProjectMutation(["comments", "activityLog"]);
			this.statusMsg = formatPageCommentAddedMessage(result.comment.pageIndex);
			return result.comment;
		} catch (error) {
			console.error("[ProjectStore] addPageComment error:", error);
			this.statusMsg = "เพิ่มโน้ตไม่สำเร็จ";
			return null;
		} finally {
			this.commentsLoading = false;
		}
	}

	async resolveComment(commentId: string): Promise<void> {
		if (!this.project) return;
		this.commentsLoading = true;
		if (!canUseBackendProjectEndpoints(this.project.projectId)) {
			const existingComment = this.comments.find((comment) => comment.id === commentId);
			if (!existingComment) {
				this.statusMsg = "ไม่พบโน้ตนี้";
				this.commentsLoading = false;
				return;
			}
			this.comments = this.comments.map((comment) => comment.id === commentId
				? { ...comment, status: "resolved", updatedAt: new Date().toISOString() }
				: comment);
			this.project.comments = this.comments;
			this.appendLocalActivity(createLocalActivity(
				"comment_resolved",
				"ปิดโน้ตแล้ว",
				{ pageIndex: existingComment.pageIndex },
			));
			this.statusMsg = "ปิดโน้ตแล้ว";
			this.commentsLoading = false;
			return;
		}
		try {
			const result = await api.updateProjectComment(this.project.projectId, commentId, {
				status: "resolved",
			});
			this.comments = result.comments;
			this.activityLog = result.activityLog;
			this.project.comments = this.comments;
			this.project.activityLog = this.activityLog;
			await this.loadVersions();
			this.adoptRemoteProjectMutation(["comments", "activityLog"]);
			this.statusMsg = "ปิดโน้ตแล้ว";
		} catch (error) {
			console.error("[ProjectStore] resolveComment error:", error);
			this.statusMsg = "ปิดโน้ตไม่สำเร็จ";
		} finally {
			this.commentsLoading = false;
		}
	}

	async openProject(projectId: string, editor?: any, options: { initialPageIndex?: number } = {}): Promise<boolean> {
		if (!projectId) return false;
		const openGeneration = ++this.projectOpenGeneration;
		const previousProjectId = this.project?.projectId ?? null;
		if (this.project?.projectId !== projectId) {
			// Switching projects: drop the outgoing project's pending autosave and let
			// any in-flight autosave finish writing the OLD project before we reassign
			// this.project (so the save targets the project it started on, not the new
			// one). saveBeforeProjectSwitch persists any remaining local changes below.
			// Only await when an autosave is actually in flight so the common path keeps
			// its original microtask timing.
			this.cancelAutosave();
			if (this.autosaveInFlightPromise) {
				await this.waitForAutosaveInFlight();
				if (this.projectOpenGeneration !== openGeneration) return false;
			}
			try {
				await this.saveBeforeProjectSwitch(projectId, editor);
				if (this.projectOpenGeneration !== openGeneration) return false;
			} catch (error) {
				if (this.projectOpenGeneration !== openGeneration) return false;
				console.error("[ProjectStore] saveBeforeProjectSwitch error:", error);
				this.setStatus(this.projectSwitchSaveFailureStatus(error), "prev_work_present");
				return false;
			}
			// P2 leak fix — a real project switch must revoke the OUTGOING project's
			// blob:/data: localImageUrls. We do this only AFTER saveBeforeProjectSwitch
			// has persisted any remaining local edits for the old project, so no unsaved
			// in-flight data is dropped. This branch is guarded by the projectId-changed
			// check above, so reloading the SAME project mid-session never clears.
			if (previousProjectId !== null && previousProjectId !== projectId) {
				this.clearLocalImageUrls();
			}
		} else if (this.saveInFlightPromise) {
			// SAME-ID RELOAD with a save in flight. We must NOT load remote state while
			// that save's POST is still running: when it completes, completeSave() would
			// otherwise install its (now pre-reload) committed snapshot as the baseline,
			// clobbering the fresh baseline this reload is about to seed — and the next
			// edit would then overwrite the just-committed server state with no conflict.
			// Drain the save gate FIRST so the reload can't interleave with the save at
			// all. (The generation/reference guard in completeSave is the belt to this
			// drain's braces — it also catches a save that BEGINS after this drain check
			// but is still mid-flight when we re-seed the baseline below.)
			//
			// DEADLOCK-SAFE: drainSaveInFlight only awaits the save promise; openProject
			// holds nothing performSave needs and has not yet touched `this.project`.
			this.cancelAutosave();
			await this.drainSaveInFlight();
			if (this.projectOpenGeneration !== openGeneration) return false;
		}
		this.statusMsg = "กำลังเปิดงาน...";
		try {
			if (this.project?.projectId !== projectId) {
				this.cancelInFlightPageLoad();
			}
			const loadedProject = await api.loadProject(projectId);
			if (this.projectOpenGeneration !== openGeneration) return false;
			this.project = applySourceLangDefault(loadedProject);
			this.clearPageSetChangedNotice();
			// Switch is now COMMITTED — the new project's state is irrevocably loaded and
			// this is still the latest open (generation matched above). Only now fire the
			// project-switch hooks to tear down the OUTGOING project's zombie AI poll
			// intervals. Firing here (not at the top of openProject) means a FAILED switch
			// — saveBeforeProjectSwitch rejecting, an autosave conflict, or a stale
			// generation bailing out above — leaves the old project open with its polls
			// fully alive. The projectId-keyed poll guard already neutralizes any stale
			// CLIENT write the instant `this.project` flipped, so running the teardown at
			// this seam (rather than before the save gate) can never let A's polls
			// interleave a write into B; this just stops the now-orphaned timers. Gated on
			// previousProjectId !== null: the first open from a blank store has nothing to
			// tear down.
			if (previousProjectId !== null && previousProjectId !== projectId) {
				this.runProjectSwitchHooks(previousProjectId, projectId);
			}
			this.syncActiveTrackFromProject(loadedProject);
			const initialPageIndex = options.initialPageIndex;
			if (
				initialPageIndex !== undefined
				&& initialPageIndex >= 0
				&& initialPageIndex < this.project.pages.length
			) {
				this.project.currentPage = initialPageIndex;
			}
			this.clearSelectedWorkItems();
			if (editor && this.project.pages.length) {
				const pageOpened = await this.loadPage(this.project.currentPage, editor);
				if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
				if (!pageOpened) return false;
			} else {
				this.markCurrentPageClean();
				this.statusMsg = this.project.pages.length === 0
					? "ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า"
					: `โหลด ${this.project.pages.length} หน้าแล้ว`;
			}
			await this.loadVersions();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadWorkflow();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadComments();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadAiReviewMarkers();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadReviewDecisions();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadReviewAssignments();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadRevisions();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadWorkspaceHub();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadCurrentWorkspaceMember();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadRecentProjects({ preserveExistingOrder: true });
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			await this.loadImageAssets();
			if (!this.isActiveProjectOpen(openGeneration, projectId)) return false;
			const assetRecoveryStatus = this.currentAssetRecoveryStatus();
			if (assetRecoveryStatus) {
				this.statusMsg = assetRecoveryStatus;
			}
			this.rememberProjectFingerprint();
			return true;
		} catch (error) {
			if (this.projectOpenGeneration !== openGeneration) return false;
			console.error("[ProjectStore] openProject error:", error);
			this.statusMsg = this.openProjectFailureStatus(projectId, previousProjectId, error);
			return false;
		}
	}

	/**
	 * Restore a version. With no `scope` this reverts the whole project. W3.9:
	 * pass `{ pageIndex }` / `{ pageIndex, layerId }` for a selective per-page or
	 * per-layer restore that leaves everything outside the scope untouched.
	 */
	async restoreVersion(versionId: string, editor?: any, scope?: VersionRestoreScope): Promise<void> {
		if (!this.project || !versionId) return;
		const projectId = this.project.projectId;
		const scoped = Boolean(scope && (scope.pageIndex !== undefined || scope.layerId !== undefined));
		this.statusMsg = scoped ? "กำลังย้อนเฉพาะส่วนที่เลือก..." : "กำลังย้อนงานไปจุดบันทึก...";
		// E3 — cancel any pending debounced autosave and drain an in-flight one BEFORE
		// restoring, otherwise a debounced autosave could fire after restoreProjectVersion
		// and re-POST the PRE-restore state over the version we just restored.
		this.cancelAutosave();
		await this.waitForAutosaveInFlight();
		try {
			const shouldPreserveLocalState = this.hasLocalProjectChanges() || this.hasCurrentProjectPendingAiResultApply();
			const recoveryDraftResult = shouldPreserveLocalState
				? await this.createLocalConflictRecoveryDraft(editor)
				: null;
			if (recoveryDraftResult && !recoveryDraftResult.persisted) {
				this.saveSyncStatus = "error";
				this.saveErrorKind = "generic";
				this.saveErrorMessage = "สำเนากู้คืนเก็บใน browser ไม่สำเร็จ";
				this.statusMsg = "ยังไม่ย้อนเวอร์ชัน: สำเนากู้คืนเก็บใน browser ไม่สำเร็จ ดาวน์โหลดสำเนาไว้ก่อน";
				return;
			}
			await api.restoreProjectVersion(projectId, versionId, scope);
			this.project = applySourceLangDefault(await api.loadProject(projectId));
			this.clearSelectedWorkItems();
			if (editor) {
				await this.loadPage(this.project.currentPage, editor);
			}
			await this.loadVersions();
			await this.loadWorkflow();
			await this.loadComments();
			await this.loadAiReviewMarkers();
			await this.loadReviewDecisions();
			await this.loadReviewAssignments();
			await this.loadRevisions();
			await this.loadWorkspaceHub();
			await this.loadImageAssets();
			this.rememberProjectFingerprint();
			this.versionDetail = null;
			this.versionComparison = null;
			this.statusMsg = recoveryDraftResult
				? `${scoped ? "ย้อนเฉพาะส่วนที่เลือกแล้ว" : "ย้อนงานไปจุดบันทึกแล้ว"} และเก็บสำเนากู้คืนไว้ในเครื่อง: ${recoveryDraftResult.draft.projectName}`
				: (scoped ? "ย้อนเฉพาะส่วนที่เลือกแล้ว" : "ย้อนงานไปจุดบันทึกแล้ว");
		} catch (error) {
			console.error("[ProjectStore] restoreVersion error:", error);
			this.statusMsg = scoped ? "ย้อนเฉพาะส่วนที่เลือกไม่สำเร็จ" : "ย้อนเวอร์ชันไม่สำเร็จ";
			throw error;
		}
	}

	async loadFiles(files: File[], editor: any): Promise<void> {
		return this.loadFilesWithSetup(files, editor);
	}

	/**
	 * Delete a just-created chapter project whose batched page upload failed PART-WAY
	 * through (some batches committed + metered, a later batch threw). Splitting the
	 * old single 80-page request into smaller batches made a late failure leave an
	 * orphan backend project plus partially-uploaded, already-metered assets; a blind
	 * retry would then re-create a project and re-upload the committed pages (double
	 * upload + double metering). Deleting the orphan wholesale (the backend removes
	 * the whole project tree, so its committed assets go with it) restores the old
	 * "one transaction" guarantee: a failed create leaves NO orphan project + NO
	 * orphan assets, and the next retry starts clean.
	 *
	 * Best-effort + non-throwing: the upload failure is the real error we want to
	 * surface; if cleanup itself fails we log and fall through so the original upload
	 * error still reaches the user. The delete confirm string mirrors the backend's
	 * `storyTitle ?? name` rule for a freshly-created project so the type-to-confirm
	 * server gate accepts it.
	 */
	private async cleanupOrphanCreatedProject(
		projectId: string,
		confirmTitle: string,
	): Promise<void> {
		if (!canUseBackendProjectEndpoints(projectId)) return;
		try {
			await api.deleteProject(projectId, confirmTitle);
		} catch (error) {
			console.error("[ProjectStore] cleanupOrphanCreatedProject failed", { projectId, error });
		}
	}

	async loadFilesWithSetup(
		files: File[],
		editor: any,
		setup: ProjectSetupOptions = {},
	): Promise<void> {
		const imageFiles = orderProjectImageFiles(files);
		const unsupportedSummary = formatUnsupportedImageFileSummary(files);
		if (!imageFiles.length) {
			this.statusMsg = unsupportedSummary
				? `ยังไม่มีไฟล์รูป PNG, JPG หรือ WebP ที่รองรับ; ${unsupportedSummary}`
				: "ยังไม่มีไฟล์รูป PNG, JPG หรือ WebP ที่รองรับ";
			return;
		}
		if (this.project && this.project.pages.length === 0) {
			await this.fillEmptyProjectWithPages(imageFiles, editor, {
				...setup,
				unsupportedSummary,
			});
			return;
		}

		// First-run scope guard (UNCONDITIONAL): this is the single chokepoint that calls
		// `api.createProject` below, so the workspace-scope enforcement lives here and does
		// NOT depend on `setup.requireScopedCreate`. A brand-new create must NEVER fall back
		// to an UNSCOPED personal/orphan project when the workspace context hasn't resolved
		// yet — from ANY caller (drag-drop, dialog, command palette, top bar, library). We
		// resolve the workspace exactly the way the rest of the app does (explicit setup id,
		// else the persisted current-workspace id) and, if NONE is resolvable, abort with a
		// clear "setting up…" status so the user can retry once the workspace loads. The
		// `requireScopedCreate` flag remains accepted as an explicit signal but is a no-op
		// for enforcement. The resolved id is threaded into the create call via setup so the
		// project is actually scoped (see `projectIdentityMetadataFromSetup`).
		const resolvedWorkspaceId = setup.workspaceId?.trim() || readCurrentWorkspaceId();
		if (!resolvedWorkspaceId) {
			this.statusMsg = "กำลังตั้งค่าเวิร์กสเปซของคุณ… ลองสร้างตอนใหม่อีกครั้งสักครู่";
			return;
		}
		const scopedSetup: ProjectSetupOptions = { ...setup, workspaceId: resolvedWorkspaceId };

		const previousProject = this.project ? cloneProjectState(this.project) : null;
		const previousProjectId = this.project?.projectId ?? null;
		// Snapshot of the previous project's AI queue rows, captured (below) just BEFORE
		// the new project id is assigned. If the create fails and rolls back, this is
		// handed to runRestoreRowsHooks so any row discarded during the create window
		// (a submit continuation that saw "switched away" once `this.project` flipped to
		// the new id) is re-inserted before resumePolling re-arms it. Empty until the
		// flip; a first-open from a blank store (previousProjectId === null) never fills it.
		let previousProjectAiRowSnapshot: unknown[] = [];
		const previousImageAssets = [...this.imageAssets];
		const previousImageAssetsProjectId = this.imageAssetsProjectId;
		let createdProjectId: string | null = null;
		let newProjectAssigned = false;
		// Hoisted so the catch's orphan-cleanup can recompute the exact delete confirm
		// string (the backend gates DELETE on `storyTitle ?? name` of the new project).
		const projectName = (setup.projectName ?? "ตอนใหม่").trim() || "ตอนใหม่";
		// Scope-resolved setup so the created project is stamped with the resolved
		// workspaceId (the guard above guarantees it resolves); the orphan-cleanup
		// confirm string (storyTitle ?? name) is unaffected by the workspaceId.
		const projectIdentity = projectIdentityMetadataFromSetup(scopedSetup);
		try {
			if (this.project) {
				try {
					await this.saveBeforeProjectSwitch("__new_project__", editor);
				} catch (error) {
					console.error("[ProjectStore] saveBeforeNewProject error:", error);
					this.setStatus(this.projectSwitchSaveFailureStatus(error), "prev_work_present");
					return;
				}
			}
			const targetLang = (setup.targetLang ?? this.targetLang).trim().toLowerCase() || this.targetLang;
			this.targetLang = targetLang;
			this.statusMsg = "กำลังสร้างงาน...";
			const { projectId } = await api.createProject(projectName, targetLang, projectIdentity);
			createdProjectId = projectId;

			this.statusMsg = "กำลังอัปโหลดรูป...";
			this.chapterUploadProgress = { phase: "pages", done: 0, total: 1, uploadedFiles: 0, totalFiles: imageFiles.length };
			// Merge-at-creation routes through /upload-transform as ONE request
			// (the server stitches every `perPage` sources into one page image, so
			// the batch cannot be split); plain creation keeps the batched,
			// resume-friendly keep upload.
			const mergeTransform = setup.pageTransform?.mode === "merge" ? setup.pageTransform : null;
			const upload = mergeTransform
				? await api.uploadImagesTransformed(projectId, imageFiles, "merge", { perPage: mergeTransform.perPage }, (fraction) => {
					const clamped = Math.max(0, Math.min(1, fraction));
					this.chapterUploadProgress = {
						phase: "pages",
						done: 0,
						total: 1,
						uploadedFiles: clamped * imageFiles.length,
						totalFiles: imageFiles.length,
					};
				})
				: (this.lastOwnPageSetMutationAt = Date.now()) && await uploadImagesInBatches(imageFiles, (batch, onProgress) => api.uploadImages(projectId, batch, onProgress, { assetKind: "page-image" }), {
					batchSize: setup.uploadBatchSize,
					onBatchStart: ({ batchIndex, batchCount, totalFiles, uploadedBeforeBatch }) => {
						this.statusMsg = batchCount > 1
							? `กำลังอัปโหลดรูป ${batchIndex + 1}/${batchCount}...`
							: "กำลังอัปโหลดรูป...";
						this.chapterUploadProgress = {
							phase: "pages",
							done: batchIndex,
							total: batchCount,
							uploadedFiles: Math.min(uploadedBeforeBatch, totalFiles),
							totalFiles,
						};
					},
					onBatchProgress: ({ batchIndex, batchCount, totalFiles, uploadedFilesEstimate }) => {
						this.chapterUploadProgress = {
							phase: "pages",
							done: batchIndex,
							total: batchCount,
							uploadedFiles: Math.min(uploadedFilesEstimate, totalFiles),
							totalFiles,
						};
					},
				});
			const { imageIds } = upload;
			// keep: 1 file = 1 page; merge: N files = ceil(N/perPage) stitched pages.
			const expectedPages = mergeTransform
				? Math.ceil(imageFiles.length / Math.max(2, mergeTransform.perPage))
				: imageFiles.length;
			if (imageIds.length !== expectedPages) {
				throw new Error(`อัปโหลดรูปได้ ${imageIds.length}/${expectedPages} หน้า`);
			}
			this.chapterUploadProgress = {
				phase: "pages",
				done: 1,
				total: 1,
				uploadedFiles: imageIds.length,
				totalFiles: imageFiles.length,
			};
			let coverImageId = imageIds[0];
			let coverOriginalName = imageFiles[0]?.name;
			let uploadedAssets = upload.assets ?? [];
			if (setup.coverFile && isSupportedImageFile(setup.coverFile)) {
					this.statusMsg = "กำลังอัปโหลดปกตอน...";
					this.chapterUploadProgress = { phase: "cover", done: 0, total: 1, uploadedFiles: 0, totalFiles: 1 };
				const coverUpload = await api.uploadImages(projectId, [setup.coverFile], undefined, { assetKind: "cover-image" });
				if (coverUpload.imageIds[0]) {
					coverImageId = coverUpload.imageIds[0];
					coverOriginalName = setup.coverFile.name;
					uploadedAssets = [...uploadedAssets, ...(coverUpload.assets ?? [])];
				}
			}

			// Page provenance label: 1:1 file name for keep; for merge the server
			// names the stitched asset itself, so prefer its originalName (same
			// rule applyImportedUpload uses for the bulk-import path).
			const assetByImageId = new Map(uploadedAssets.map((asset) => [asset.imageId, asset]));
			const pages: Page[] = imageIds.map((id, i) => ({
				imageId: id,
				imageName: id,
				originalName: mergeTransform
					? (assetByImageId.get(id)?.originalName ?? id)
					: (imageFiles[i]?.name ?? assetByImageId.get(id)?.originalName ?? id),
				textLayers: [],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}));

			// A brand-new project replaces whatever was open. ASSIGN it now (fireHooks:false)
			// so the steps below build against it, but DEFER the project-switch teardown: the
			// switch is NOT committed yet — saveState/loadPage/loadVersions/loadWorkflow below
			// can still throw and roll back to `previousProject`. Tearing down the OUTGOING
			// project's polls/rows is irreversible (cancelPollsForProject drops them with
			// nothing to restore), so firing the hook here would leave the rolled-back user
			// in the old project with its live AI jobs invisible + unpolled. We fire
			// runProjectSwitchHooks(previousProjectId, projectId) only once the create flow
			// COMMITS (after the last throwing step). The first create from a blank store
			// (previousProjectId === null) fires no hook either way.
			//
			// Snapshot the previous project's AI queue rows BEFORE this flip. After the flip
			// `this.project` points at the NEW id, so a previous-project submit continuation
			// resolving during the create window discards its queue row ("switched away"). On
			// the rollback path we restore from this snapshot so resumePolling can re-arm the
			// discarded row too (not just the surviving ones). Captured only on a real switch
			// (previousProjectId !== null); a first-open has no rows to lose.
			if (previousProjectId !== null) {
				previousProjectAiRowSnapshot = this.runSnapshotRowsHooks(previousProjectId);
			}
			this.replaceOpenProject({
				projectId,
				name: projectName,
				createdAt: new Date().toISOString(),
				...projectIdentity,
				coverImageId,
				coverOriginalName,
				pages,
				currentPage: 0,
				sourceLang: projectIdentity.sourceLang ?? DEFAULT_SOURCE_LANG,
				targetLang,
				textStylePresets: [],
				creditPresets: [],
				aiReviewMarkers: [],
				reviewDecisions: [],
				workspaceMessages: [],
				versionReviewRequests: [],
			}, { fireHooks: false });
			newProjectAssigned = true;
			this.clearSelectedWorkItems();
			this.setImageAssets(uploadedAssets);

			await this.saveState();
			await this.loadPage(0, editor);
			await this.loadVersions();
			await this.loadWorkflow();
			// The create flow's baseline was set from the locally-built project, which
			// lacks the server-owned/normalized identity fields (storyId/workspaceId/
			// targetLangs). Re-anchor it to server truth so the first real edit/AI gen
			// doesn't see a false save-conflict against the persisted state.
			await this.resyncBaselineFromServerAfterCreate();
			await this.loadComments();
			await this.loadAiReviewMarkers();
			await this.loadReviewDecisions();
			await this.loadWorkspaceHub();
			await this.loadRecentProjects();
			await this.loadImageAssets();
			// COMMIT POINT — every step that could throw and trigger the catch's rollback to
			// `previousProject` has now passed, so the switch to the new project is final.
			// Only NOW fire the deferred project-switch teardown for the OUTGOING project
			// (drop its zombie polls + orphaned queue rows). Firing here (not at the assign
			// above) means a mid-flow throw rolls back to the previous project with its AI
			// polls/rows STILL alive — the irreversible teardown never ran. A create from a
			// blank store (previousProjectId === null) is a first-open and tears down nothing.
			if (previousProjectId !== null && previousProjectId !== projectId) {
				this.runProjectSwitchHooks(previousProjectId, projectId);
			}
			this.statusMsg = unsupportedSummary
				? `โหลด ${pages.length} หน้าแล้ว; ข้าม ${unsupportedSummary}`
				: `โหลด ${pages.length} หน้าแล้ว`;
		} catch (error) {
			// An oversize upload (413 / batch-cap) is swallowed into statusMsg here and
			// never reaches the dialog's friendlyUploadError() catch, so map it to the
			// shared actionable guidance now instead of leaking the raw English 413.
			// A per-batch failure additionally names the exact failed page span.
			const message = uploadFailureStatus(error, "โหลดไฟล์ไม่ได้");
			// Atomicity fix: a batched page/cover upload that failed PART-WAY through
			// (before the new project was assigned to the store) leaves an orphan
			// backend project + partially-uploaded, already-metered assets. Delete the
			// orphan wholesale so a retry starts clean (no orphan project, no double
			// upload / double metering). Only when we DID create a project this attempt
			// but never finished assigning it (post-assign failures are save/load
			// retries on a fully-uploaded project — handled below, no delete).
			if (createdProjectId && !newProjectAssigned) {
				const confirmTitle = (projectIdentity.storyTitle ?? projectName).trim();
				await this.cleanupOrphanCreatedProject(createdProjectId, confirmTitle);
			}
			if (newProjectAssigned && this.project?.projectId === createdProjectId && previousProject) {
				// Roll back to the project that was open before the failed create. This is a
				// real id change (createdProjectId → previousProject.projectId), so let
				// replaceOpenProject FIRE the hooks (default): the switch-back is itself a real,
				// committed switch. The deferred forward hook (previousProjectId → createdProjectId)
				// never ran (we used fireHooks:false at the assign and only commit at the success
				// path's end), so the previous project's polls/rows are STILL alive and intact —
				// restoring it makes them current again with nothing to recreate. Firing the
				// rollback hook (createdProjectId → previousProjectId) tears down any queue rows
				// the aborted create produced under createdProjectId; cancelPollsForProject is a
				// harmless no-op when there are none, so this is safe and self-cleaning.
				this.replaceOpenProject(previousProject);
				this.tasks = previousProject.tasks ?? [];
				this.activityLog = previousProject.activityLog ?? [];
				this.comments = previousProject.comments ?? [];
				this.reviewDecisions = previousProject.reviewDecisions ?? [];
				this.aiReviewMarkers = previousProject.aiReviewMarkers ?? [];
				this.imageAssets = previousImageAssets;
				this.imageAssetsProjectId = previousImageAssetsProjectId;
				this.clearSelectedWorkItems();
				this.markCurrentPageClean();
				// Re-arm the restored project's AI polls. During the create window
				// `this.project` already pointed at the NEW (deferred-hook) id, so every poll
				// tick for the previous project's still-running rows FAILED isProjectContext-
				// Current and SELF-CLEARED its own interval (clearInterval + pendingJobs.delete),
				// leaving those rows processing/pending with no live poller. The forward switch
				// hook (previousProjectId → createdProjectId) was DEFERRED (fireHooks:false) and
				// only fires on commit, so cancelPollsForProject never ran and the rows + their
				// server jobs are intact — just unpolled. replaceOpenProject above made the
				// previous project current again, so resumePolling (registered here) re-arms a
				// fresh poll for each still-running row of the now-restored open project, reusing
				// the same machinery the WorkspaceShell remount path uses. The self-clearing
				// during the window is thus harmless: the rollback re-arms. Safe to call when
				// there were no running rows (it iterates an empty set) and idempotent against
				// any row that already has a live handle (it skips pendingJobs.has(id)).
				//
				// FIRST restore any queue row that was DISCARDED during the create window. A
				// previous-project submit continuation that resolved after the new id was
				// assigned saw "switched away" and dropped its (accepted+charged) queue row;
				// resumePolling can only re-arm rows that still EXIST, so without restoring
				// the row first the charged job would be orphaned + invisible. restoreMissing-
				// Rows re-inserts only rows whose id is gone (idempotent against survivors)
				// and does NOT re-arm intervals — the resume hook right after does that for
				// the restored + surviving rows alike. The discard path already wrote the
				// server marker via ownerProjectId, so a restored row + re-armed poll resumes.
				this.runRestoreRowsHooks(previousProjectAiRowSnapshot);
				this.runResumePollingHooks(editor);
				this.statusMsg = `สร้างงานใหม่ไม่สำเร็จ: ${message} ยังอยู่ในงานเดิม`;
			} else {
				this.statusMsg = newProjectAssigned && this.project?.projectId === createdProjectId
					? `สร้างงานแล้วแต่บันทึก/โหลดต่อไม่สำเร็จ: ${message} กดลองบันทึกอีกครั้งก่อนปิดงาน`
					: `โหลดไฟล์ไม่สำเร็จ: ${message}`;
			}
			console.error("[ProjectStore] loadFiles error:", error);
		} finally {
			this.chapterUploadProgress = null;
		}
	}

	async fillEmptyProjectWithPages(
		files: File[],
		editor: any,
		setup: ProjectSetupOptions = {},
	): Promise<void> {
		if (!this.project) {
			await this.loadFilesWithSetup(files, editor, setup);
			return;
		}
		if (this.project.pages.length > 0) {
			this.statusMsg = "งานนี้มีรูปหน้าแล้ว ใช้กู้รูปหรือสร้างตอนใหม่แทน";
			return;
		}
		const imageFiles = orderProjectImageFiles(files);
		const unsupportedSummary = setup.unsupportedSummary ?? formatUnsupportedImageFileSummary(files);
		if (!imageFiles.length) {
			this.statusMsg = unsupportedSummary
				? `ยังไม่มีไฟล์รูป PNG, JPG หรือ WebP ที่รองรับ; ${unsupportedSummary}`
				: "ยังไม่มีไฟล์รูป PNG, JPG หรือ WebP ที่รองรับ";
			return;
		}

		// First-run scope guard (defense in depth): a scoped-required first-run create
		// routed here (a zero-page project filled at first run) must not proceed without
		// a resolvable workspace id either. Mirrors the `loadFilesWithSetup` guard so
		// every create entry point that lands in this path is equally protected.
		if (setup.requireScopedCreate) {
			const resolvedWorkspaceId = setup.workspaceId?.trim() || readCurrentWorkspaceId();
			if (!resolvedWorkspaceId) {
				this.statusMsg = "กำลังตั้งค่าเวิร์กสเปซของคุณ… ลองสร้างตอนใหม่อีกครั้งสักครู่";
				return;
			}
		}

		const project = this.project;
		const previousProject = cloneProjectState(project);
		const previousImageAssets = [...this.imageAssets];
		const previousImageAssetsProjectId = this.imageAssetsProjectId;
		const previousLocalImageUrls = { ...this.localImageUrls };
		const previousAssetLoadErrors = JSON.parse(JSON.stringify(this.assetLoadErrors)) as Record<number, PageAssetLoadErrorEntry>;
		try {
			const targetLang = (setup.targetLang ?? project.targetLang ?? this.targetLang).trim().toLowerCase() || this.targetLang;
			project.targetLang = targetLang;
			this.targetLang = targetLang;
			if (setup.projectName?.trim() && !project.name.trim()) {
				project.name = setup.projectName.trim();
			}
			applyProjectIdentityMetadata(project, setup);

			let imageIds: string[] = [];
			let uploadedAssets: ProjectImageAssetSummary[] = [];
			this.statusMsg = "กำลังเพิ่มรูปเข้าโปรเจกต์นี้...";
			this.chapterUploadProgress = { phase: "pages", done: 0, total: 1, uploadedFiles: 0, totalFiles: imageFiles.length };
			// Idempotent retry: if a prior fill of THIS project's pages failed part-way
			// through the batched upload, resume from the committed prefix instead of
			// re-uploading (and re-metering) the already-committed pages. We only resume
			// when the file selection is byte-for-byte the same (same fingerprint) — a
			// changed selection invalidates the stash and uploads fresh.
			const pendingResume = this.pendingFillUploads.get(project.projectId);
			const canResume = !!pendingResume && imageUploadSelectionResumes(
				pendingResume.files,
				pendingResume.progress.committedFiles,
				imageFiles,
			);
			const resume = canResume ? pendingResume!.progress : undefined;
			if (pendingResume && !canResume) this.pendingFillUploads.delete(project.projectId);
			// Merge-at-creation (see loadFilesWithSetup): one /upload-transform
			// request — whole-batch stitch semantics, so no batched resume here.
			// Gated on backend support: a local/legacy projectId has no transform
			// endpoint, so merge degrades to keep-mode (1 file = 1 page) and the
			// page-count expectation below must match THAT, not ceil(N/perPage).
			const fillMergeTransform = canUseBackendProjectEndpoints(project.projectId) && setup.pageTransform?.mode === "merge"
				? setup.pageTransform
				: null;
			if (fillMergeTransform && canUseBackendProjectEndpoints(project.projectId)) {
				const upload = await api.uploadImagesTransformed(project.projectId, imageFiles, "merge", { perPage: fillMergeTransform.perPage }, (fraction) => {
					const clamped = Math.max(0, Math.min(1, fraction));
					this.chapterUploadProgress = {
						phase: "pages",
						done: 0,
						total: 1,
						uploadedFiles: clamped * imageFiles.length,
						totalFiles: imageFiles.length,
					};
				});
				imageIds = upload.imageIds;
				uploadedAssets = upload.assets ?? [];
				this.pendingFillUploads.delete(project.projectId);
			} else if (canUseBackendProjectEndpoints(project.projectId)) {
				const upload = (this.lastOwnPageSetMutationAt = Date.now()) && await uploadImagesInBatches(imageFiles, (batch, onProgress) => api.uploadImages(project.projectId, batch, onProgress, { assetKind: "page-image" }), {
					batchSize: setup.uploadBatchSize,
					resume,
					onBatchStart: ({ batchIndex, batchCount, totalFiles, uploadedBeforeBatch }) => {
						this.statusMsg = batchCount > 1
							? `กำลังอัปโหลดรูปเข้าโปรเจกต์นี้ ${batchIndex + 1}/${batchCount}...`
							: "กำลังอัปโหลดรูปเข้าโปรเจกต์นี้...";
						this.chapterUploadProgress = {
							phase: "pages",
							done: batchIndex,
							total: batchCount,
							uploadedFiles: Math.min(uploadedBeforeBatch, totalFiles),
							totalFiles,
						};
					},
					onBatchProgress: ({ batchIndex, batchCount, totalFiles, uploadedFilesEstimate }) => {
						this.chapterUploadProgress = {
							phase: "pages",
							done: batchIndex,
							total: batchCount,
							uploadedFiles: Math.min(uploadedFilesEstimate, totalFiles),
							totalFiles,
						};
					},
				});
				imageIds = upload.imageIds;
				uploadedAssets = upload.assets ?? [];
				// Full page upload succeeded (possibly after resuming): the resume stash
				// is spent, drop it so a later unrelated fill can't pick it up.
				this.pendingFillUploads.delete(project.projectId);
			} else {
				const uploads = [];
				for (const [index, file] of imageFiles.entries()) {
					this.statusMsg = imageFiles.length > 1
						? `กำลังเพิ่มรูปเข้าแท็บนี้ ${index + 1}/${imageFiles.length}...`
						: "กำลังเพิ่มรูปเข้าแท็บนี้...";
					this.chapterUploadProgress = {
						phase: "pages",
						done: index,
						total: imageFiles.length,
						uploadedFiles: index,
						totalFiles: imageFiles.length,
					};
					uploads.push(await this.uploadSingleProjectImage(file, {
						prefix: `page-${index + 1}`,
						fallbackWidth: 900,
						fallbackHeight: 1400,
					}));
				}
				imageIds = uploads.map((upload) => upload.imageId);
				uploadedAssets = uploads.map((upload) => upload.asset);
			}
			// keep: 1 file = 1 page; merge: N files = ceil(N/perPage) stitched pages.
			const fillExpectedPages = fillMergeTransform
				? Math.ceil(imageFiles.length / Math.max(2, fillMergeTransform.perPage))
				: imageFiles.length;
			if (imageIds.length !== fillExpectedPages) {
				throw new Error(`อัปโหลดรูปได้ ${imageIds.length}/${fillExpectedPages} หน้า`);
			}
			this.chapterUploadProgress = {
				phase: "pages",
				done: 1,
				total: 1,
				uploadedFiles: imageIds.length,
				totalFiles: imageFiles.length,
			};

			let coverImageId = imageIds[0];
			let coverOriginalName = imageFiles[0]?.name;
			if (setup.coverFile && isSupportedImageFile(setup.coverFile)) {
				this.statusMsg = "กำลังตั้งปกโปรเจกต์...";
				this.chapterUploadProgress = { phase: "cover", done: 0, total: 1, uploadedFiles: 0, totalFiles: 1 };
				if (canUseBackendProjectEndpoints(project.projectId)) {
					const coverUpload = await api.uploadImages(project.projectId, [setup.coverFile], undefined, { assetKind: "cover-image" });
					if (coverUpload.imageIds[0]) {
						coverImageId = coverUpload.imageIds[0];
						coverOriginalName = setup.coverFile.name;
						uploadedAssets = [...uploadedAssets, ...(coverUpload.assets ?? [])];
					}
				} else {
					const coverUpload = await this.uploadSingleProjectImage(setup.coverFile, {
						prefix: "cover",
						fallbackWidth: 900,
						fallbackHeight: 1400,
						metadata: { assetKind: "cover-image" },
					});
					coverImageId = coverUpload.imageId;
					coverOriginalName = setup.coverFile.name;
					uploadedAssets = [...uploadedAssets, coverUpload.asset];
				}
			}

			project.coverImageId = coverImageId;
			project.coverOriginalName = coverOriginalName;
			// Merge yields FEWER pages than source files (server-named stitched
			// assets) — provenance comes from the asset summary then, 1:1 file
			// names otherwise.
			const fillAssetByImageId = new Map(uploadedAssets.map((asset) => [asset.imageId, asset]));
			project.pages = imageIds.map((id, i) => ({
				imageId: id,
				imageName: id,
				originalName: fillMergeTransform
					? (fillAssetByImageId.get(id)?.originalName ?? id)
					: (imageFiles[i]?.name ?? fillAssetByImageId.get(id)?.originalName ?? id),
				textLayers: [],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}));
			project.currentPage = 0;
			this.clearSelectedWorkItems();
			this.assetLoadErrors = {};
			this.mergeImageAssets(uploadedAssets);

			if (canUseBackendProjectEndpoints(project.projectId)) {
				await this.saveState();
				await this.loadVersions();
				await this.loadWorkflow();
				// Re-anchor the baseline to the server's normalized identity fields
				// (storyId/workspaceId/targetLangs) so the first edit/AI gen on this
				// freshly-populated project doesn't trip a false save-conflict.
				await this.resyncBaselineFromServerAfterCreate();
				await this.loadComments();
				await this.loadAiReviewMarkers();
				await this.loadReviewDecisions();
				await this.loadWorkspaceHub();
				await this.loadRecentProjects();
				await this.loadImageAssets();
			} else {
				this.markCurrentPageClean();
			}
			await this.loadPage(0, editor);
			this.statusMsg = unsupportedSummary
				? `เพิ่มรูปเข้าโปรเจกต์นี้ ${project.pages.length} หน้าแล้ว; ข้าม ${unsupportedSummary}`
				: `เพิ่มรูปเข้าโปรเจกต์นี้ ${project.pages.length} หน้าแล้ว`;
		} catch (error) {
			// Same oversize-upload (413 / batch-cap) guidance on the fill-existing path:
			// the error is swallowed into statusMsg below, so surface the shared friendly
			// message here rather than the raw English 413 string. A per-batch failure
			// additionally names the exact failed page span.
			const message = uploadFailureStatus(error, "เพิ่มรูปเข้าโปรเจกต์นี้ไม่สำเร็จ");
			// Atomicity fix: a batched page upload that committed some batches before
			// failing leaves those pages uploaded + metered on this EXISTING project
			// (which we must NOT delete — the user wants to keep it). Stash the
			// committed prefix keyed by projectId (+ guarded by File-object identity on
			// retry) so a retry of
			// fillEmptyProjectWithPages resumes from the failed batch instead of
			// re-uploading (and re-metering) the committed pages. Only meaningful when
			// at least one batch committed; otherwise drop any stale stash.
			if (error instanceof ImageUploadBatchError && error.committed.committedFiles > 0) {
				this.pendingFillUploads.set(project.projectId, {
					// Stash the ACTUAL in-memory File[] of THIS attempt, not a serializable
					// fingerprint: only a retry presenting these exact File objects (identity)
					// for the committed prefix may resume — a same-looking fresh selection
					// cannot collide and will re-upload from scratch.
					files: imageFiles,
					progress: error.committed,
				});
			} else {
				this.pendingFillUploads.delete(project.projectId);
			}
			if (this.project?.projectId === project.projectId) {
				this.project = previousProject;
				this.tasks = previousProject.tasks ?? [];
				this.activityLog = previousProject.activityLog ?? [];
				this.comments = previousProject.comments ?? [];
				this.reviewDecisions = previousProject.reviewDecisions ?? [];
				this.aiReviewMarkers = previousProject.aiReviewMarkers ?? [];
				this.imageAssets = previousImageAssets;
				this.imageAssetsProjectId = previousImageAssetsProjectId;
				this.localImageUrls = previousLocalImageUrls;
				this.assetLoadErrors = previousAssetLoadErrors;
				this.clearSelectedWorkItems();
				this.markCurrentPageClean();
			}
			this.statusMsg = `เพิ่มรูปเข้าโปรเจกต์นี้ไม่สำเร็จ: ${message}`;
			console.error("[ProjectStore] fillEmptyProjectWithPages error:", error);
		} finally {
			this.chapterUploadProgress = null;
		}
	}

	/**
	 * Wave 3 W3.16: bulk import with server-side merge/split. Uploads the ordered
	 * source files via the transform endpoint (keep | merge | split), then appends
	 * the produced pages to the current project. Produced-page originalName is read
	 * back from the returned asset summaries so the source-filename trace persists.
	 * Returns the number of pages added (0 on failure).
	 */
	async bulkImportPages(
		files: File[],
		mode: api.BulkImportMode,
		editor: any,
		options: api.BulkImportTransformOptions = {},
	): Promise<number> {
		if (!this.project) {
			this.statusMsg = "เปิดตอนก่อน Import รูป";
			return 0;
		}
		const project = this.project;
		if (!canUseBackendProjectEndpoints(project.projectId)) {
			this.statusMsg = "ตอนนี้ยังบันทึกบนเซิร์ฟเวอร์ไม่ได้ จึงImportแบบรวม/ตัดไม่ได้";
			return 0;
		}
		// Preserve the user-arranged order from the bulk-import preview strip
		// (drag / Z→A); only drop unsupported files. Re-sorting here would stitch
		// (merge) or append (keep) pages in an order the user never confirmed.
		const imageFiles = filterProjectImageFiles(files);
		if (!imageFiles.length) {
			this.statusMsg = "ยังไม่มีไฟล์รูป PNG, JPG หรือ WebP ที่รองรับ";
			return 0;
		}

		this.bulkImportProgress = { phase: "uploading", uploadedFiles: 0, totalFiles: imageFiles.length };
		try {
			// KEEP mode: 1 source = 1 page, so the upload is splittable into independent,
			// atomically-committed batches (identical to the chapter-setup page upload).
			// Route it through the shared batched/XHR-progress machinery so the dialog
			// shows a real advancing bar, never trips the old 180s mega-request timeout,
			// and can RESUME a same-session retry from the committed prefix (no
			// re-upload / re-meter, no orphaned pages). merge/split need whole-batch
			// stitch/slice semantics, so they stay a single request — but now with real
			// byte progress, a generous timeout, and a server-reconcile on failure.
			if (mode === "keep") {
				return await this.bulkImportKeepBatched(project, imageFiles, editor);
			}
			return await this.bulkImportTransformWhole(project, imageFiles, mode, options, editor);
		} finally {
			this.bulkImportProgress = null;
		}
	}

	/**
	 * KEEP-mode bulk import: batched, byte-progress, resumable. Each batch is sent
	 * through the transform endpoint in keep mode (verbatim passthrough, 1 page per
	 * source) and commits atomically server-side. A mid-batch failure stashes the
	 * committed prefix for resume AND reconciles the already-committed pages into
	 * local + server state, so they are neither orphaned (billed but invisible) nor
	 * double-imported on the next retry.
	 */
	private async bulkImportKeepBatched(
		project: ProjectState,
		imageFiles: File[],
		editor: any,
	): Promise<number> {
		// Resume a same-session retry from the committed prefix when the SAME File
		// objects are presented for that prefix (collision-proof identity check). Two
		// resume shapes are honored:
		//  1. committedFiles > 0: a prior batch committed; skip that leading prefix AND
		//     reuse its planned `batchKeys` (prefix-identity guard).
		//  2. committedFiles === 0: the canonical P1 — the single/first batch committed
		//     server-side but its response was lost, so nothing committed BEFORE it.
		//     Nothing to skip, but the failed batch's ORIGINAL key must be reused so the
		//     server replays instead of duplicating. Gated by a FULL-selection identity
		//     guard so reusing the index-aligned keys is provably safe.
		const pendingResume = this.pendingBulkImports.get(project.projectId);
		const prefixResumes = !!pendingResume && imageUploadSelectionResumes(
			pendingResume.files,
			pendingResume.progress.committedFiles,
			imageFiles,
		);
		const keysResume = !!pendingResume
			&& pendingResume.progress.committedFiles <= 0
			&& (pendingResume.progress.batchKeys?.length ?? 0) > 0
			&& imageUploadKeysResume(pendingResume.files, imageFiles);
		const canResume = prefixResumes || keysResume;
		const resume = canResume ? pendingResume!.progress : undefined;
		if (pendingResume && !canResume) this.pendingBulkImports.delete(project.projectId);

		this.statusMsg = "กำลังอัปโหลดรูป...";
		try {
			const upload = await uploadImagesInBatches(
				imageFiles,
				(batch, onProgress, batchKey) => api.uploadImagesTransformed(project.projectId, batch, "keep", {}, onProgress, batchKey),
				{
					resume,
					onBatchStart: ({ batchIndex, batchCount, totalFiles, uploadedBeforeBatch }) => {
						this.statusMsg = batchCount > 1
							? `กำลังอัปโหลดรูป ${batchIndex + 1}/${batchCount}...`
							: "กำลังอัปโหลดรูป...";
						this.bulkImportProgress = {
							phase: "uploading",
							uploadedFiles: Math.min(uploadedBeforeBatch, totalFiles),
							totalFiles,
						};
					},
					onBatchProgress: ({ totalFiles, uploadedFilesEstimate }) => {
						this.bulkImportProgress = {
							phase: uploadedFilesEstimate >= totalFiles ? "processing" : "uploading",
							uploadedFiles: Math.min(uploadedFilesEstimate, totalFiles),
							totalFiles,
						};
					},
				},
			);
			// Full upload succeeded (possibly after resuming): the stash is spent.
			this.pendingBulkImports.delete(project.projectId);
			this.bulkImportProgress = { phase: "processing", uploadedFiles: imageFiles.length, totalFiles: imageFiles.length };
			const added = await this.applyImportedUpload(project, upload, editor);
			this.statusMsg = `Importแล้ว ${added} หน้า`;
			return added;
		} catch (error) {
			// Reconcile committed pages so partial progress is neither orphaned nor
			// double-imported: append the committed prefix to local + server state and
			// stash it for a resumable retry. Pages already committed + metered
			// server-side become real, visible, saved pages.
			let reconciledCount = 0;
			if (error instanceof ImageUploadBatchError) {
				// ALWAYS stash on a batch error — including when committedFiles === 0. That
				// zero-committed case IS the canonical P1: the single/first batch committed
				// server-side then lost its response, so the failed batch's `batchKeys` must
				// survive for the retry to re-send the SAME key (server replays → no
				// duplicate assets, no orphan). The prior `committedFiles === 0` branch
				// DELETED this stash, minting a fresh key on retry and re-opening the window.
				this.pendingBulkImports.set(project.projectId, {
					files: imageFiles,
					progress: error.committed,
				});
				// Only reconcile into local/server state when a prefix actually committed;
				// a zero-committed failure has no committed pages to surface yet (they only
				// become visible once the replayed retry returns the committed ids).
				if (error.committed.committedFiles > 0) {
					try {
						reconciledCount = await this.applyImportedUpload(
							project,
							{ imageIds: error.committed.imageIds, assets: error.committed.assets },
							editor,
						);
					} catch (reconcileError) {
						console.error("[ProjectStore] bulkImportPages reconcile failed:", reconcileError);
					}
				}
			} else {
				this.pendingBulkImports.delete(project.projectId);
			}
			const message = uploadFailureStatus(error, "Import รูปไม่สำเร็จ");
			this.statusMsg = reconciledCount > 0
				? `Importได้ ${reconciledCount} หน้าแล้ว ส่วนที่เหลือยังไม่สำเร็จ: ${message} — ลองอีกครั้งเพื่อImportส่วนที่เหลือต่อ`
				: `Import รูปไม่สำเร็จ: ${message}`;
			console.error("[ProjectStore] bulkImportPages (keep) error:", error);
			return reconciledCount;
		}
	}

	/**
	 * merge/split bulk import: one whole-batch transform request (stitch/slice is not
	 * splittable). Now streams real byte progress and uses a generous timeout. On
	 * failure the transform is whole-request atomic (nothing committed), but we still
	 * reload server image assets before rolling back local state so a partial
	 * server-side commit (defensive) is reconciled rather than orphaned.
	 */
	private async bulkImportTransformWhole(
		project: ProjectState,
		imageFiles: File[],
		mode: api.BulkImportMode,
		options: api.BulkImportTransformOptions,
		editor: any,
	): Promise<number> {
		const previousProject = cloneProjectState(project);
		const previousImageAssets = [...this.imageAssets];
		const previousImageAssetsProjectId = this.imageAssetsProjectId;
		try {
			this.statusMsg = mode === "merge" ? "กำลังรวมรูปและอัปโหลด..." : "กำลังตัดรูปยาวและอัปโหลด...";
			const upload = await api.uploadImagesTransformed(
				project.projectId,
				imageFiles,
				mode,
				options,
				(fraction) => {
					const clamped = Math.max(0, Math.min(1, fraction));
					this.bulkImportProgress = {
						phase: clamped >= 1 ? "processing" : "uploading",
						uploadedFiles: clamped * imageFiles.length,
						totalFiles: imageFiles.length,
					};
				},
			);
			if (!(upload.imageIds ?? []).length) {
				throw new Error("เซิร์ฟเวอร์ไม่ได้สร้างหน้าใหม่");
			}
			this.bulkImportProgress = { phase: "processing", uploadedFiles: imageFiles.length, totalFiles: imageFiles.length };
			const added = await this.applyImportedUpload(project, upload, editor);
			this.statusMsg = `Importแล้ว ${added} หน้า`;
			return added;
		} catch (error) {
			const message = uploadFailureStatus(error, "Import รูปไม่สำเร็จ");
			if (this.project?.projectId === project.projectId) {
				this.project = previousProject;
				this.imageAssets = previousImageAssets;
				this.imageAssetsProjectId = previousImageAssetsProjectId;
				this.clearSelectedWorkItems();
				this.markCurrentPageClean();
				// Reconcile against the server: a transform is whole-request atomic, but
				// reloading the authoritative asset list ensures the in-editor library
				// never diverges from the server after a failed import.
				try {
					await this.loadImageAssets();
				} catch (reloadError) {
					console.error("[ProjectStore] bulkImportPages reconcile reload failed:", reloadError);
				}
			}
			this.statusMsg = `Import รูปไม่สำเร็จ: ${message}`;
			console.error("[ProjectStore] bulkImportPages (transform) error:", error);
			return 0;
		}
	}

	/**
	 * Append produced pages from a (possibly partial) upload result to the current
	 * project, set the cover if unset, persist via saveState, refresh assets/recents,
	 * and navigate to the first newly-added page. Shared by the keep, merge/split, and
	 * keep-mode partial-reconcile paths so committed pages always land in BOTH local
	 * and server state. Returns the number of pages appended.
	 */
	private async applyImportedUpload(
		project: ProjectState,
		upload: { imageIds: string[]; assets?: ProjectImageAssetSummary[] },
		editor: any,
	): Promise<number> {
		const imageIds = upload.imageIds ?? [];
		if (!imageIds.length) return 0;
		// Skip ids already present so a reconcile/retry never double-appends a page.
		const existingIds = new Set(project.pages.map((page) => page.imageId));
		const assetByImageId = new Map((upload.assets ?? []).map((asset) => [asset.imageId, asset]));
		const newPages: Page[] = imageIds
			.filter((id) => !existingIds.has(id))
			.map((id) => ({
				imageId: id,
				imageName: id,
				originalName: assetByImageId.get(id)?.originalName ?? id,
				textLayers: [],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}));
		if (!newPages.length) {
			this.mergeImageAssets(upload.assets ?? []);
			return 0;
		}

		const hadPages = project.pages.length > 0;
		project.pages = [...project.pages, ...newPages];
		if (!project.coverImageId && newPages[0]) {
			project.coverImageId = newPages[0].imageId;
			project.coverOriginalName = newPages[0].originalName;
		}
		if (!hadPages) project.currentPage = 0;
		this.clearSelectedWorkItems();
		this.mergeImageAssets(upload.assets ?? []);

		await this.saveState();
		await this.loadImageAssets();
		await this.loadRecentProjects();
		const firstNewIndex = hadPages ? project.pages.length - newPages.length : 0;
		await this.loadPage(firstNewIndex, editor);
		return newPages.length;
	}

	async openFolder(editor: any): Promise<void> {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept = SUPPORTED_IMAGE_ACCEPT;

		input.onchange = async () => {
			if (!input.files?.length) return;
			await this.loadFilesWithSetup(Array.from(input.files!), editor);
		};

		input.click();
	}

	async loadPage(index: number, editor: any): Promise<boolean> {
		if (!this.project || !editor || index < 0 || index >= this.project.pages.length) return false;
		const page = this.project.pages[index];
		const loadKey = `${this.project.projectId}:${index}:${this.getPageImageId(page)}`;
		if (this.pageLoadInFlightPromise) {
			if (this.pageLoadInFlightKey === loadKey && this.pageLoadInFlightEditor === editor) return this.pageLoadInFlightPromise;
			await this.pageLoadInFlightPromise.catch(() => false);
			return this.loadPage(index, editor);
		}

		const loadPromise = this.performLoadPage(index, editor);
		this.pageLoadInFlightKey = loadKey;
		this.pageLoadInFlightEditor = editor;
		this.pageLoadInFlightPromise = loadPromise;
		try {
			return await loadPromise;
		} finally {
			if (this.pageLoadInFlightPromise === loadPromise) {
				this.pageLoadInFlightPromise = null;
				this.pageLoadInFlightKey = null;
				this.pageLoadInFlightEditor = null;
			}
		}
	}

	private async performLoadPage(index: number, editor: any): Promise<boolean> {
		if (!this.project || !editor || index < 0 || index >= this.project.pages.length) return false;
		const projectRef = this.project;
		const loadGeneration = this.pageLoadGeneration;
		// P1 wrong-page corruption — close the stroke-during-commit + navigate race.
		// performLoadPage is the single chokepoint EVERY navigation passes through, so
		// settle + cancel the image-tool deferred replay HERE, just before currentPage
		// advances. (1) Drain any in-flight commit + its replay microtask so stroke 1
		// finishes persisting to the OLD page; (2) ALWAYS cancel the deferred buffer so
		// a stroke buffered on the OLD page can never replay onto the NEW one. The drain
		// is gated on a pending commit (goToPage already awaits it for the busy UX, so
		// this is usually a no-op), but the cancel runs unconditionally — that is the
		// guarantee that holds for every caller, not just goToPage.
		if (this.shouldWaitForEditorBrushCommit(editor)) {
			try {
				await this.waitForEditorBrushCommit(editor);
			} catch (error) {
				// A failed brush commit is surfaced by the caller's own wait path; here we
				// only need the buffer drained so it can't replay onto the new page.
				console.error("[ProjectStore] performLoadPage brush-commit drain error:", error);
			}
		}
		if (typeof editor.cancelImageToolDeferredReplay === "function") {
			editor.cancelImageToolDeferredReplay();
		}
		// P1 cancel-stroke-on-nav — abandon any LIVE in-progress pointer gesture (suite
		// clone/heal OR legacy engine brush whose pointerUp has not yet fired) against
		// the OLD page, BEFORE currentPage advances, so its pending move/up can never
		// commit old-page pixels onto the new page. (editor.loadImage() also self-guards,
		// but it runs AFTER currentPage is set; do it here too so the cancel happens on
		// the page the stroke belongs to.)
		if (typeof editor.cancelActiveBrushGesture === "function") {
			editor.cancelActiveBrushGesture();
		}
		if (!this.project || index < 0 || index >= this.project.pages.length) return false;
		this.project.currentPage = index;
		// Concurrent-edit Phase 1: acquire a soft lease on the page being opened.
		// performLoadPage is the single chokepoint every navigation passes through,
		// so acquiring here covers open / next / prev / jump. Fire-and-forget +
		// non-throwing: a lock hiccup must never block page loading (CAS on save is
		// the final net). beginPageEdit releases the previous page's lease itself.
		this.acquirePageLease(index);
		const page = this.project.pages[index];
		const pageImageId = this.getPageImageId(page);
		this.clearPageAssetLoadError(index);
		this.isLoadingPage = true;

		this.statusMsg = `กำลังโหลดหน้า ${index + 1}...`;
		try {
			await editor.loadImage(this.getImageUrl(pageImageId));
			if (!this.isActivePageLoad(projectRef, loadGeneration, index)) return false;

			// W3.15 — feed long-page boundary cuts so the editor draws the red page
			// overlay + clips tools to the active sub-page. Start on the first page;
			// the editor then re-binds the active segment to whichever sub-page the
			// brush is over, so every logical page (not just segment 0) is editable.
			// setPageBoundaries also re-validates role/lock-gated multi-page mode for
			// this freshly-loaded page (see editor store onPageBoundariesChanged).
			editor.setActivePageSegment?.(0);
			editor.setPageBoundaries?.(page.pageBoundaries ?? []);

			// Phase A non-destructive edits — feed the page's saved bubble-clean edit
			// stack so the editor rebuilds its edit-composite overlay over the ORIGINAL
			// page image (the clean survives reload without a baked page PNG).
			editor.setImageEditLayers?.(page.imageEditLayers ?? [], page.imageId);

			let imageLayerLoadFailed = false;
			for (const imageLayer of page.imageLayers ?? []) {
				try {
					await editor.addImageLayer?.(imageLayer, this.getImageUrl(imageLayer.imageId));
				} catch (error) {
					if (!this.isActivePageLoad(projectRef, loadGeneration, index)) return false;
					const message = error instanceof Error ? error.message : "โหลดรูปเสริมไม่ได้";
					this.setPageAssetLoadError({
						pageIndex: index,
						imageId: imageLayer.imageId,
						imageName: imageLayer.imageName,
						originalName: imageLayer.originalName,
						message,
						kind: "image-layer",
						layerId: imageLayer.id,
						layerName: imageLayer.name || imageLayer.originalName || imageLayer.imageName || imageLayer.id,
					});
					this.statusMsg = `รูปเสริมหน้า ${index + 1} หาย`;
					imageLayerLoadFailed = true;
					console.error("[ProjectStore] loadPage image layer error:", error);
				}
				if (!this.isActivePageLoad(projectRef, loadGeneration, index)) return false;
			}

			// Render the ACTIVE Language Track's text. trackTextLayers backfills to the
			// flat `page.textLayers` for the default/legacy track (so single-language
			// projects render exactly as before) and returns the per-track bucket once a
			// non-default track has been materialized.
			for (const tl of trackTextLayers(page, this.activeTargetLang)) {
				editor.addTextLayer(tl);
			}

			if (!this.isActivePageLoad(projectRef, loadGeneration, index)) return false;
			this.statusMsg = imageLayerLoadFailed ? `รูปเสริมหน้า ${index + 1} หาย` : formatPagePosition(index, this.project.pages.length);
			return true;
		} catch (error) {
			if (!this.isActivePageLoad(projectRef, loadGeneration, index)) return false;
			const message = error instanceof Error ? error.message : "โหลดรูปไม่ได้";
			this.setPageAssetLoadError({
				pageIndex: index,
				imageId: pageImageId,
				imageName: page.imageName,
				originalName: page.originalName,
				message,
				kind: "page",
			});
			this.statusMsg = `รูปหน้า ${index + 1} หาย`;
			console.error("[ProjectStore] loadPage error:", error);
			// The page did open; keep navigation responsive so the user can relink the missing image.
			return true;
		} finally {
			if (this.isActivePageLoad(projectRef, loadGeneration, index)) {
				this.isLoadingPage = false;
				this.markCurrentPageClean();
			}
		}
	}

	async prevPage(editor: any): Promise<boolean> {
		if (!this.project) return false;
		if (this.pageNavigationBusy) {
			this.statusMsg = "รอโหลดหน้าปัจจุบันให้เสร็จก่อน";
			return false;
		}
		if (this.project.currentPage <= 0) {
			this.statusMsg = "อยู่หน้าแรกแล้ว";
			return false;
		}
		return this.goToPage(this.project.currentPage - 1, editor);
	}

	async nextPage(editor: any): Promise<boolean> {
		if (!this.project) return false;
		if (this.pageNavigationBusy) {
			this.statusMsg = "รอโหลดหน้าปัจจุบันให้เสร็จก่อน";
			return false;
		}
		if (this.project.currentPage >= this.project.pages.length - 1) {
			this.statusMsg = "อยู่หน้าสุดท้ายแล้ว";
			return false;
		}
		return this.goToPage(this.project.currentPage + 1, editor);
	}

	async goToPage(index: number, editor: any): Promise<boolean> {
		if (!this.project) return false;
		if (index < 0 || index >= this.project.pages.length) return false;
		if (index === this.project.currentPage) return false;
		if (this.pageNavigationBusy) {
			this.statusMsg = "รอโหลดหน้าปัจจุบันให้เสร็จก่อน";
			return false;
		}
		if (!editor) {
			if (this.hasLocalProjectChanges()) {
				try {
					// E2 — same autosave race guard as the editor branch below.
					this.cancelAutosave();
					await this.waitForAutosaveInFlight();
					await this.saveState();
				} catch (error) {
					console.error("[ProjectStore] goToPage save before null-editor switch error:", error);
					this.statusMsg = this.pageSwitchFailureStatus(index, error);
					return false;
				}
			}
			this.project.currentPage = index;
			this.clearSelectedWorkItems();
			this.statusMsg = formatPagePosition(index, this.project.pages.length);
			return true;
		}

		try {
			if (this.shouldWaitForEditorBrushCommit(editor)) await this.waitForEditorBrushCommit(editor);
			this.syncEditorLayers(editor);
			if (this.hasLocalProjectChanges()) {
				// E2 — cancel the pending debounce and drain any autosave already in
				// flight BEFORE our saveState(), otherwise two concurrent saveProject
				// POSTs race the same projectId and the second uses a stale
				// projectBaseFingerprint → spurious 409 that fails the page switch for a
				// single user in a single tab. Mirrors the named-version path (~3376).
				this.cancelAutosave();
				await this.waitForAutosaveInFlight();
				await this.saveState();
			}
			return await this.loadPage(index, editor);
		} catch (error) {
			console.error("[ProjectStore] goToPage error:", error);
			this.statusMsg = this.pageSwitchFailureStatus(index, error);
			return false;
		}
	}

	/** Build the {@link api.saveProject} options for the current project + lease state. */
	private currentSaveOptions(): { baseFingerprint: string | null; editLockId: string | null; editClientId: string | null; pageScoped: boolean } {
		return {
			baseFingerprint: this.projectBaseFingerprint,
			// C1: prove this save was made under a live page lease. If the lease was
			// taken over since, the backend 409s (editing_taken_over) instead of
			// silently clobbering the new holder.
			editLockId: editLeaseStore.heldLockId,
			editClientId: editSessionStore.clientId,
			// P0-2: flag a page-scoped save so the backend's prod gate requires the
			// lease header — a displaced/buggy client can't dodge the lease check by
			// omitting x-edit-lock-id. Stays true across a takeover (the marker is the
			// page-edit session, not the live lease), so the gate still fires.
			pageScoped: editLeaseStore.pageEditScopeActive,
		};
	}

	/**
	 * Persist the current project state — the single public save entry point used by
	 * EVERY save path (manual save, page switch, version restore, AI-apply, autosave's
	 * own internal call, ~30 sites).
	 *
	 * SINGLE-FLIGHT GATE. All saves share ONE in-flight promise (`saveInFlightPromise`,
	 * owned here — NOT a third mechanism). The autosave keeps its own debounce flags
	 * (`autosaveInFlight` / `autosaveInFlightPromise`, which `waitForAutosaveInFlight`
	 * still observes), but its actual POST goes through `runAutosave → saveState`, so the
	 * serialization lives in this one place.
	 *
	 * Why: a DIRECT saveState() and a fired autosave (or two direct saveState()s) used to
	 * read the SAME `projectBaseFingerprint` and POST /save concurrently. The backend CAS
	 * lets the first win; the LOSER throws ProjectSaveConflictError and drags the user
	 * into the conflict/recovery flow for a SELF-inflicted, single-user race.
	 *
	 * Contract when a save is already in flight, a SECOND saveState() arrives:
	 *  1. It AWAITS the in-flight save (it does NOT POST in parallel with the stale baseline).
	 *  2. It then RE-EVALUATES via {@link needsFollowUpSave} against the state the first
	 *     save left behind (the first save refreshed `projectBaseFingerprint` through
	 *     `completeSave → rememberProjectFingerprint`):
	 *       - still unsaved / errored / pending AI-apply → it issues its OWN fresh save;
	 *       - already clean ("saved")                    → it returns WITHOUT a second POST.
	 *
	 * Error semantics (documented, deliberate):
	 *  - The caller whose save actually POSTs gets that POST's result — a conflict (or any
	 *    error) PROPAGATES to it (the recovery/conflict flow + `throw` are preserved).
	 *  - A second caller that awaited a FAILED first save does NOT rethrow the first's
	 *    transient error. failSave() leaves the store in "error" with the dirty edits
	 *    intact, so the re-evaluation issues a FRESH save with the refreshed baseline
	 *    and the second caller surfaces ITS OWN result/error. This is intentional: the
	 *    second caller's job is "persist the current state", not "report the first
	 *    caller's failure"; the first caller already saw and handled its own error.
	 *  - Save conflicts / missing-baseline failures are different: retrying cannot prove
	 *    the remote still matches our baseline, so queued callers receive the same
	 *    recoverable conflict instead of issuing a trailing save that would fight CAS.
	 */
	async saveState(): Promise<void> {
		if (!this.project) return;

		if (this.hasSaveInFlight()) {
			// A save is already running. DRAIN every save currently in flight before we
			// decide whether to issue our own follow-up.
			//
			// Why a LOOP, not a single await: when several callers queue behind one POST
			// and the FIRST waiter wakes and chains a follow-up save, that follow-up's
			// beginSave() immediately flips saveSyncStatus to "saving". A LATER waiter that
			// only awaited the ORIGINAL promise would then see needsFollowUpSave() === false
			// ("saving" is neither "unsaved" nor "error") and RETURN while the follow-up POST
			// is still running — letting named-version creation / a project switch proceed
			// before the dirty mid-flight edit actually persists. So we keep awaiting
			// WHICHEVER promise is currently in the slot (each iteration awaits a DISTINCT,
			// freshly-installed follow-up promise) until the slot is empty; only then is the
			// store fully quiescent and safe to evaluate for ourselves.
			let drained = 0;
			let drainedConflict: unknown = null;
			const SAVE_DRAIN_GUARD = 10; // sanity cap against pathological save churn.
			for (;;) {
				const inFlight = this.saveInFlightPromise;
				if (!inFlight) break; // slot empty → store is quiescent; safe to evaluate.
				// Swallow its error — see the error semantics above; the originating caller
				// owns non-conflict errors. Conflicts are remembered because CAS requires a
				// reload path, not an automatic trailing retry against the same stale base.
				await inFlight.catch((error) => {
					if (this.isRecoverableSaveConflict(error)) drainedConflict = error;
				});
				drained += 1;
				if (drained >= SAVE_DRAIN_GUARD) {
					console.warn(
						`[ProjectStore] saveState drained ${drained} chained in-flight saves; ` +
							"proceeding without further waiting to avoid a livelock.",
					);
					break;
				}
			}
			// The drained saves may have changed the active project (switch/close) or fully
			// persisted our state. Only issue a follow-up save if there is STILL something
			// to persist for the SAME project — otherwise return without a redundant POST.
			if (drainedConflict) throw drainedConflict;
			if (!this.project || !this.needsFollowUpSave()) return;
			// A reentrant save may have begun again (e.g. an autosave timer fired during the
			// last await) AFTER the drain loop exited via the guard cap. Respect the gate
			// rather than POSTing blind alongside it.
			if (this.hasSaveInFlight()) return this.saveState();
		}

		const run = this.performSave();
		this.saveInFlightPromise = run;
		try {
			await run;
		} finally {
			// Only clear the slot if it still points at OUR run — a reentrant follow-up
			// save (the recursive saveState() above) may have installed a newer promise.
			if (this.saveInFlightPromise === run) this.saveInFlightPromise = null;
		}
	}

	/**
	 * Should a second saveState() that just awaited an in-flight save issue its own
	 * follow-up POST?
	 *
	 * Gate on STATUS, NOT `hasLocalProjectChanges()`: completeSave() refreshes the
	 * baseline fingerprint but does NOT reset `dirtyVersion` on a clean save (only
	 * markCurrentPageClean does), so `dirtyVersion>0` — and thus
	 * `hasLocalProjectChanges()` — stays true even after a fully-persisted "saved". Gating
	 * the follow-up on that would fire an endless redundant POST. This mirrors
	 * runAutosave()'s re-arm predicate exactly:
	 *   - "saved"            → clean, the in-flight save persisted everything → NO follow-up.
	 *   - "unsaved"          → edits arrived mid-save (dirtyVersion advanced) → follow-up.
	 *   - "error"            → the in-flight save failed → retry with the refreshed baseline.
	 *   - pending AI-apply   → markers still need flushing → follow-up.
	 */
	private needsFollowUpSave(): boolean {
		return (
			this.saveSyncStatus === "unsaved"
			|| this.saveSyncStatus === "error"
			|| this.hasCurrentProjectPendingAiResultApply()
		);
	}

	private isRecoverableSaveConflict(error: unknown): boolean {
		return error instanceof ProjectSaveConflictError
			|| isBackendProjectSaveConflict(error)
			|| isBackendProjectBaselineRequired(error);
	}

	/**
	 * Whether the single-flight save gate currently holds an in-flight save. A method
	 * (not a bare `this.saveInFlightPromise` truthiness test) so the drain loop's
	 * re-checks read the slot FRESH each time and aren't folded away by control-flow
	 * narrowing across the loop's `await`.
	 */
	private hasSaveInFlight(): boolean {
		return this.saveInFlightPromise !== null;
	}

	/** The actual save POST. Always run THROUGH saveState()'s single-flight gate. */
	private async performSave(): Promise<void> {
		if (!this.project) return;
		this.beginSave();
		let committedSnapshot: ProjectState | null = null;
		let postProject: ProjectState | null = null;
		try {
			if (canUseLocalDebugProjectFallback(this.project.projectId)) {
				this.completeSave();
				return;
			}
			await this.assertNoStaleRemoteOverwrite();
			// Capture the EXACT state we are about to POST. `api.saveProject` serializes the
			// body synchronously from this same object, so this clone is byte-for-byte what
			// the server stores. completeSave() refreshes the conflict-guard baseline from
			// THIS snapshot — not from `this.project` at completion time — so an edit that
			// lands while the POST is in flight does not corrupt the baseline into a hash the
			// server never saw (which would self-conflict the follow-up save). See
			// completeSave() / rememberProjectFingerprint() for the full rationale.
			committedSnapshot = cloneProjectState(this.project);
			// Bind this POST to the live project object reference it was issued against.
			// completeSave() adopts the committed snapshot as the baseline ONLY if the
			// reference still matches at completion — if a same-id reload re-seeded the
			// baseline mid-flight, this POST's (now-stale) snapshot must NOT clobber it.
			postProject = this.project;
			this.lastOwnPageSetMutationAt = Date.now();
			await api.saveProject(this.project.projectId, this.project, this.currentSaveOptions());
			this.completeSave(committedSnapshot, postProject);
			await this.flushPendingAiResultApplyMarkers();
			// P1 storage-bloat fix: the durable server state now references the new edit
			// ids, so any superseded destructive-edit blobs are safe to reclaim. Run AFTER
			// the save commits; best-effort (never throws), so storage GC can't fail a save.
			await this.reconcileSupersededEditImages();
		} catch (caughtError) {
			let error = caughtError;
			try {
				// 428 is recoverable only when a fresh server read proves the local payload
				// is already current, or the server still matches the previous local
				// baseline. Anything else must stay in the visible conflict flow so a
				// stale tab cannot turn a missing baseline into last-write-wins.
				if (
					committedSnapshot
					&& postProject
					&& await this.recoverBaselineRequiredSave(error, committedSnapshot, postProject)
				) return;
			} catch (recoveryError) {
				error = recoveryError;
			}
			console.error("[ProjectStore] saveState error:", error);
			this.failSave(error);
			this.setSaveFailureStatus(error);
			// C1: the backend rejected this save because another user took over the page
			// (our lease is gone but the SSE/heartbeat may not have flipped us yet). Run
			// the same defense as a heartbeat-detected takeover: read-only + recovery
			// snapshot, so the displaced holder's work is preserved, not clobbered.
			if (isBackendEditingTakenOver(error)) this.handleLeaseTakenOver();
			throw error;
		}
	}

	private async recoverBaselineRequiredSave(
		error: unknown,
		committedSnapshot: ProjectState,
		postProject: ProjectState,
	): Promise<boolean> {
		if (!isBackendProjectBaselineRequired(error)) return false;
		if (!this.project || this.project !== postProject) return false;
		const projectId = committedSnapshot.projectId;
		if (!canUseBackendProjectEndpoints(projectId)) return false;

		let remoteProject: ProjectState;
		try {
			remoteProject = applySourceLangDefault(await api.loadProject(projectId));
		} catch (loadError) {
			// Recovery re-read is best-effort; if it fails, preserve the original 428 so
			// the user stays on the explicit reload/recovery path instead of seeing a
			// floating generic network error.
			console.warn("[ProjectStore] 428 baseline recovery re-read failed:", loadError);
			return false;
		}
		if (!this.project || this.project !== postProject || this.project.projectId !== projectId) return false;

		const remoteFingerprint = createProjectStateFingerprint(remoteProject);
		const committedFingerprint = createProjectStateFingerprint(committedSnapshot);
		if (remoteFingerprint === committedFingerprint) {
			this.projectBaseSnapshot = committedSnapshot;
			this.projectBaseFingerprint = remoteFingerprint;
			this.completeSave(committedSnapshot, postProject);
			const aiFlush = await this.flushPendingAiResultApplyMarkers();
			await this.reconcileSupersededEditImages();
			// A failed AI-marker close is the only signal the user gets that the
			// marker is still pending — the recovery success message must not
			// overwrite it (codex P2).
			if (aiFlush.failed === 0) this.statusMsg = "โหลด state ล่าสุดแล้ว งานนี้ตรงกับเซิร์ฟเวอร์";
			return true;
		}

		if (!this.projectBaseSnapshot) return false;
		const previousBaseFingerprint = createProjectStateFingerprint(this.projectBaseSnapshot);
		if (remoteFingerprint !== previousBaseFingerprint) return false;

		// The remote still equals our last observed baseline, so replaying the exact
		// captured save payload is a normal CAS write with a freshly re-read base hash.
		this.projectBaseSnapshot = cloneProjectState(remoteProject);
		this.projectBaseFingerprint = remoteFingerprint;
		this.lastOwnPageSetMutationAt = Date.now();
			await api.saveProject(projectId, committedSnapshot, {
			...this.currentSaveOptions(),
			baseFingerprint: remoteFingerprint,
		});
		this.completeSave(committedSnapshot, postProject);
		const aiFlush = await this.flushPendingAiResultApplyMarkers();
		await this.reconcileSupersededEditImages();
		// Same rule as the fingerprint-match branch: keep the flush failure
		// message visible instead of reporting a clean recovery (codex P2).
		if (aiFlush.failed === 0) this.statusMsg = "โหลด state ล่าสุดแล้ว บันทึกซ้ำสำเร็จ";
		return true;
	}

	syncTextLayers(editor: any): void {
		if (!this.project || !editor) return;
		this.captureEditorTextLayers(editor.getAllTextLayers());
	}

	syncEditorLayers(editor: any): void {
		if (!this.project || !editor) return;
		if (typeof editor.getAllTextLayers === "function") {
			this.captureEditorTextLayers(editor.getAllTextLayers());
		}
		if (typeof editor.getAllImageLayers === "function") {
			this.captureEditorImageLayers(editor.getAllImageLayers());
		}
	}

	private buildLocalConflictRecoveryDraft(exportedAt: string): LocalConflictRecoveryDraft | null {
		if (!this.project) return null;
		const project = cloneProjectState(this.project);
		const textLayerCount = project.pages.reduce((total, page) => total + page.textLayers.length, 0);
		const imageLayerCount = project.pages.reduce((total, page) => total + (page.imageLayers?.length ?? 0), 0);
		return {
			kind: "manga-editor-conflict-local-copy",
			id: `${project.projectId}-${exportedAt.replace(/[:.]/g, "-")}`,
			exportedAt,
			reason: "project_save_conflict",
			message: this.saveErrorMessage ?? "งานถูกแก้จากที่อื่น โหลดใหม่ก่อนบันทึก",
			projectId: project.projectId,
			projectName: project.name,
			pageIndex: project.currentPage,
			pageCount: project.pages.length,
			textLayerCount,
			imageLayerCount,
			project,
		};
	}

	private persistLocalConflictRecoveryDraft(draft: LocalConflictRecoveryDraft): void {
		if (typeof localStorage === "undefined") return;
		const key = `${CONFLICT_RECOVERY_STORAGE_PREFIX}${draft.id}`;
		localStorage.setItem(key, JSON.stringify(draft));
		const index = JSON.parse(localStorage.getItem(CONFLICT_RECOVERY_INDEX_KEY) ?? "[]") as string[];
		const nextIndex = [draft.id, ...index.filter((id) => id !== draft.id)];
		if (nextIndex.length > 20) {
			const evicted = nextIndex.slice(20);
			for (const evictedId of evicted) {
				localStorage.removeItem(`${CONFLICT_RECOVERY_STORAGE_PREFIX}${evictedId}`);
			}
			nextIndex.splice(20);
		}
		localStorage.setItem(CONFLICT_RECOVERY_INDEX_KEY, JSON.stringify(nextIndex));
		this.loadLocalConflictRecoveryDrafts();
	}

	private readLocalConflictRecoveryDraft(id: string): LocalConflictRecoveryDraft | null {
		if (typeof localStorage === "undefined" || !id) return null;
		try {
			const raw = localStorage.getItem(`${CONFLICT_RECOVERY_STORAGE_PREFIX}${id}`);
			if (!raw) return null;
			const draft = JSON.parse(raw) as LocalConflictRecoveryDraft;
			if (draft?.kind !== "manga-editor-conflict-local-copy" || !draft.project?.pages) return null;
			return draft;
		} catch (error) {
			console.warn("[ProjectStore] read local conflict recovery draft failed:", error);
			return null;
		}
	}

	loadLocalConflictRecoveryDrafts(): LocalConflictRecoveryDraft[] {
		if (typeof localStorage === "undefined") {
			this.conflictRecoveryDrafts = [];
			return [];
		}
		let index: string[] = [];
		try {
			index = JSON.parse(localStorage.getItem(CONFLICT_RECOVERY_INDEX_KEY) ?? "[]") as string[];
		} catch {
			index = [];
		}
		const drafts = index
			.map((id) => this.readLocalConflictRecoveryDraft(id))
			.filter((draft): draft is LocalConflictRecoveryDraft => Boolean(draft));
		this.conflictRecoveryDrafts = drafts;
		return drafts;
	}

	deleteLocalConflictRecoveryDraft(id: string): void {
		if (typeof localStorage === "undefined" || !id) return;
		localStorage.removeItem(`${CONFLICT_RECOVERY_STORAGE_PREFIX}${id}`);
		const index = JSON.parse(localStorage.getItem(CONFLICT_RECOVERY_INDEX_KEY) ?? "[]") as string[];
		localStorage.setItem(CONFLICT_RECOVERY_INDEX_KEY, JSON.stringify(index.filter((draftId) => draftId !== id)));
		this.loadLocalConflictRecoveryDrafts();
		this.statusMsg = "ลบสำเนากู้คืนในเครื่องแล้ว";
	}

	async restoreLocalConflictRecoveryDraft(id: string, editor?: any): Promise<boolean> {
		const draft = this.readLocalConflictRecoveryDraft(id);
		if (!draft) {
			this.statusMsg = "ไม่พบสำเนากู้คืนนี้ในเครื่อง";
			this.loadLocalConflictRecoveryDrafts();
			return false;
		}
		if (this.project && editor) {
			await this.createLocalConflictRecoveryDraft(editor);
		}
		this.cancelInFlightPageLoad();
		// A recovery draft can belong to a DIFFERENT project than the one currently open
		// (the user may restore a draft from another project). Route through replaceOpenProject
		// so a real id change tears down the outgoing project's AI polls + orphaned queue rows;
		// a same-project restore (the common case) fires no hook and keeps its polls valid.
		const restored = cloneProjectState(draft.project);
		this.replaceOpenProject(restored);
		this.tasks = restored.tasks ?? [];
		this.activityLog = restored.activityLog ?? [];
		this.comments = restored.comments ?? [];
		this.reviewDecisions = restored.reviewDecisions ?? [];
		this.aiReviewMarkers = restored.aiReviewMarkers ?? [];
		this.pendingAiResultApplyMarkers.clear();
		this.assetLoadErrors = {};
		this.clearImageAssets();
		this.clearSelectedWorkItems();
		if (editor && restored.pages.length) {
			await this.loadPage(restored.currentPage, editor);
		}
		this.versionDetail = null;
		this.versions = [];
		this.markCurrentPageUnsaved();
		this.loadLocalConflictRecoveryDrafts();
		this.statusMsg = `กู้คืนสำเนาในเครื่องแล้ว: ${draft.projectName}`;
		return true;
	}

	async createLocalConflictRecoveryDraft(editor?: any): Promise<LocalConflictRecoveryDraftResult | null> {
		if (!this.project) return null;
		if (editor) {
			if (this.shouldWaitForEditorBrushCommit(editor)) await this.waitForEditorBrushCommit(editor);
			this.syncEditorLayers(editor);
		}
		const draft = this.buildLocalConflictRecoveryDraft(new Date().toISOString());
		if (!draft) return null;
		try {
			this.persistLocalConflictRecoveryDraft(draft);
			this.statusMsg = `เก็บสำเนากู้คืนในเครื่องแล้ว: ${draft.projectName}`;
			return { draft, persisted: true };
		} catch (error) {
			console.warn("[ProjectStore] persist local conflict recovery draft failed:", error);
			this.statusMsg = "สร้างสำเนากู้คืนแล้ว แต่เก็บใน browser ไม่สำเร็จ ดาวน์โหลดสำเนาไว้ก่อน";
			return { draft, persisted: false };
		}
	}

	async reloadProjectAfterConflict(
		editor?: any,
		options: { createRecoveryCopy?: boolean } = {},
	): Promise<boolean> {
		if (!this.project) return false;
		const projectId = this.project.projectId;
		const shouldCreateRecoveryCopy = options.createRecoveryCopy !== false;
		const recoveryDraftResult = shouldCreateRecoveryCopy
			? await this.createLocalConflictRecoveryDraft(editor)
			: null;
		if (!canUseBackendProjectEndpoints(projectId)) {
			this.saveSyncStatus = "unsaved";
			this.saveErrorKind = null;
			this.saveErrorMessage = null;
			this.statusMsg = recoveryDraftResult
				? recoveryDraftResult.persisted
					? `เก็บสำเนากู้คืนไว้ในเครื่องแล้ว: ${recoveryDraftResult.draft.projectName}`
					: "สร้างสำเนากู้คืนแล้ว แต่เก็บใน browser ไม่สำเร็จ ดาวน์โหลดสำเนาไว้ก่อน"
				: "งานนี้เป็นงานบนเครื่อง ไม่มีเวอร์ชันเซิร์ฟเวอร์ให้โหลด";
			return true;
		}
		const opened = await this.openProject(projectId, editor);
		if (opened !== false && recoveryDraftResult) {
			this.statusMsg = recoveryDraftResult.persisted
				? `โหลดล่าสุดแล้ว และเก็บสำเนากู้คืนไว้ในเครื่อง: ${recoveryDraftResult.draft.projectName}`
				: "โหลดล่าสุดแล้ว แต่สำเนากู้คืนเก็บใน browser ไม่สำเร็จ ดาวน์โหลดสำเนาไว้ก่อน";
		}
		return opened !== false;
	}

	async saveCurrentPage(editor?: any): Promise<void> {
		if (!this.project) return;
		this.statusMsg = "กำลังบันทึก...";
		try {
			if (editor) {
				if (this.shouldWaitForEditorBrushCommit(editor)) await this.waitForEditorBrushCommit(editor);
				this.syncEditorLayers(editor);
			}
			await this.saveState();
			await this.loadVersions();
			this.statusMsg = `บันทึกหน้า ${this.project.currentPage + 1} แล้ว`;
		} catch (error) {
			console.error("[ProjectStore] saveCurrentPage error:", error);
			if (isBrushCommitNavigationError(error)) this.failSave(error);
			this.setSaveFailureStatus(error);
		}
	}

	async downloadLocalConflictCopy(editor?: any): Promise<void> {
		if (!this.project) return;
		if (editor) {
			if (this.shouldWaitForEditorBrushCommit(editor)) await this.waitForEditorBrushCommit(editor);
			this.syncEditorLayers(editor);
		}
		const exportedAt = new Date().toISOString();
		const payload = this.buildLocalConflictRecoveryDraft(exportedAt);
		if (!payload) return;
		const safeName = (this.project.name || "project")
			.trim()
			.replace(/[\\/:*?"<>|]+/g, "-")
			.replace(/\s+/g, "-")
			.slice(0, 80) || "project";
		const stamp = exportedAt.replace(/[:.]/g, "-");
		const filename = `${safeName}_local-copy_${stamp}.json`;
		this.downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename);
		this.statusMsg = "ดาวน์โหลดสำเนางานในแท็บนี้แล้ว";
	}

	async repairDuplicateLayerIds(pageIndex = this.project?.currentPage ?? 0, editor?: any): Promise<LayerIdRepairResult | null> {
		if (!this.project || pageIndex < 0 || pageIndex >= this.project.pages.length) return null;
		const isCurrentPage = pageIndex === this.project.currentPage;
		const page = this.project.pages[pageIndex];
		this.statusMsg = `กำลังซ่อม Layer ID ซ้ำ หน้า ${pageIndex + 1}...`;
		try {
			if (editor) {
				if (this.shouldWaitForEditorBrushCommit(editor)) await this.waitForEditorBrushCommit(editor);
				this.syncEditorLayers(editor);
			}
			const textLayerIds = repairDuplicateLayerIdsInList(page.textLayers);
			const imageLayerIds = repairDuplicateLayerIdsInList(page.imageLayers);
			const result = {
				pageIndex,
				textLayerIds,
				imageLayerIds,
				total: textLayerIds + imageLayerIds,
			};
			if (result.total === 0) {
				this.statusMsg = `หน้า ${pageIndex + 1} ไม่มี Layer ID ซ้ำ`;
				return result;
			}

			this.markCurrentPageUnsaved();
			await this.saveState();
			if (editor && isCurrentPage) {
				await this.loadPage(pageIndex, editor);
			}
			await this.loadVersions();
			this.statusMsg = `ซ่อม Layer ID ซ้ำ ${result.total} จุด หน้า ${pageIndex + 1} แล้ว`;
			return result;
		} catch (error) {
			console.error("[ProjectStore] repairDuplicateLayerIds error:", error);
			this.setSaveFailureStatus(error);
			return null;
		}
	}

	async renameCurrentProject(name: string): Promise<boolean> {
		if (!this.project) return false;
		const nextName = name.trim().slice(0, 200);
		if (!nextName) {
			this.statusMsg = "ชื่องานต้องไม่ว่าง";
			return false;
		}
		if (nextName === this.project.name) return false;

		this.project.name = nextName;
		this.markCurrentPageUnsaved();
		this.statusMsg = "กำลังเปลี่ยนชื่องาน...";
		try {
			await this.saveState();
			await this.loadRecentProjects({ preserveExistingOrder: true });
			this.statusMsg = `เปลี่ยนชื่องานเป็น ${nextName} แล้ว`;
			return true;
		} catch (error) {
			console.error("[ProjectStore] renameCurrentProject error:", error);
			this.setSaveFailureStatus(error);
			return false;
		}
	}

	async reorderPage(fromIndex: number, toIndex: number, editor?: any): Promise<void> {
		if (!this.project) return;
		const previousCurrentPage = this.project.currentPage;
		const { items, plan } = movePageItems(this.project.pages, fromIndex, toIndex);
		if (!plan.moved) return;

		this.statusMsg = `กำลังย้ายหน้า ${plan.fromIndex + 1}...`;
		try {
			if (editor) {
				this.syncEditorLayers(editor);
			}

			this.project.pages = items;
			this.project.currentPage = remapPageIndex(previousCurrentPage, plan);
			this.remapPageLinkedState(plan);
			this.clearSelectedWorkItems();
			await this.saveState();

			if (editor) {
				await this.loadPage(this.project.currentPage, editor);
			}

			await this.loadVersions();
			await this.loadRecentProjects();
			this.statusMsg = `ย้ายหน้า ${plan.fromIndex + 1} ไปตำแหน่ง ${plan.toIndex + 1} แล้ว`;
		} catch (error) {
			console.error("[ProjectStore] reorderPage error:", error);
			const message = error instanceof Error ? error.message : "ย้ายหน้าไม่ได้";
			this.statusMsg = `ย้ายหน้าไม่สำเร็จ: ${message}`;
		}
	}

	async movePage(pageIndex: number, direction: -1 | 1, editor?: any): Promise<void> {
		await this.reorderPage(pageIndex, pageIndex + direction, editor);
	}

	/** @returns true when the page image was replaced AND persisted (failures roll back and report via statusMsg). */
	async replacePageImage(pageIndex: number, file: File, editor?: any): Promise<boolean> {
		// Mark this tab as the origin of the imminent page_set_changed echo.
		this.lastOwnPageSetMutationAt = Date.now();
		if (!this.project || pageIndex < 0 || pageIndex >= this.project.pages.length) return false;
		if (!isSupportedImageFile(file)) {
			this.statusMsg = `กู้รูปหน้า ${pageIndex + 1} ไม่สำเร็จ: ${file.name} ไม่ใช่ ${supportedImageCopy}`;
			return false;
		}
		const page = this.project.pages[pageIndex];
		const isCurrentPage = pageIndex === this.project.currentPage;
		this.statusMsg = `กำลังกู้รูปหน้า ${pageIndex + 1}...`;
		try {
			if (editor && isCurrentPage) {
				this.syncEditorLayers(editor);
			}

			const previousProject = cloneProjectState(this.project);
			const previousImageAssets = [...this.imageAssets];
			const previousImageAssetsProjectId = this.imageAssetsProjectId;
			const previousAssetLoadErrors = JSON.parse(JSON.stringify(this.assetLoadErrors)) as Record<number, PageAssetLoadErrorEntry>;
			const previousImageRefs = collectPageImageRelinkRefs(page);
			const { imageIds, assets } = await api.uploadImages(this.project.projectId, [file], undefined, { assetKind: "page-replacement" });
			const imageId = imageIds[0];
			if (!imageId) throw new Error("อัปโหลดเสร็จแต่ไม่ได้รับ image id");

			page.imageId = imageId;
			page.imageName = imageId;
			page.originalName = file.name;
			page.edits = undefined;
			remapPageImageReferences(this.project, pageIndex, previousImageRefs, imageId);
			this.resetPageQcHandoffForUpstreamChange(page, "pending");
			this.clearPageAssetLoadError(pageIndex);
			this.mergeImageAssets(assets);
			try {
				await this.saveState();
			} catch (error) {
				this.project = previousProject;
				this.tasks = previousProject.tasks ?? [];
				this.activityLog = previousProject.activityLog ?? [];
				this.comments = previousProject.comments ?? [];
				this.reviewDecisions = previousProject.reviewDecisions ?? [];
				this.aiReviewMarkers = previousProject.aiReviewMarkers ?? [];
				this.imageAssets = previousImageAssets;
				this.imageAssetsProjectId = previousImageAssetsProjectId;
				this.assetLoadErrors = previousAssetLoadErrors;
				throw error;
			}
			if (editor && isCurrentPage) {
				await this.loadPage(pageIndex, editor);
			}
			await this.loadVersions();
			await this.loadRecentProjects();
			this.statusMsg = `กู้รูปหน้า ${pageIndex + 1} แล้ว`;
			return true;
		} catch (error) {
			console.error("[ProjectStore] replacePageImage error:", error);
			const message = error instanceof Error ? error.message : "กู้รูปไม่สำเร็จ";
			this.statusMsg = `กู้รูปไม่สำเร็จ: ${message}`;
			return false;
		}
	}

	async replaceCurrentPageImage(file: File, editor: any): Promise<void> {
		if (!this.project) return;
		await this.replacePageImage(this.project.currentPage, file, editor);
	}

	// ── External-clean roundtrip ─────────────────────────────────────────────
	// Export the ORIGINAL page images (selected pages or all) for cleaning
	// outside the app, then import the cleaned files back. See
	// $lib/project/clean-roundtrip.ts for the filename key + the reason the
	// re-import REQUIRES identical pixel dimensions.

	cleanRoundtripBusy = $state(false);

	async exportOriginalsForCleaning(pageIndexes?: number[]): Promise<void> {
		if (!this.project || this.cleanRoundtripBusy) return;
		const project = this.project;
		const targets = (pageIndexes && pageIndexes.length ? pageIndexes : project.pages.map((_, index) => index))
			.filter((index) => index >= 0 && index < project.pages.length);
		if (!targets.length) {
			this.statusMsg = "ยังไม่มีหน้าให้Exportไปคลีน";
			return;
		}
		this.cleanRoundtripBusy = true;
		try {
			const files: ZipFileInput[] = [];
			const skipped: string[] = [];
			const exportedAt = new Date();
			for (const pageIndex of targets) {
				const page = project.pages[pageIndex];
				if (!page) continue;
				const pageNumber = pageIndex + 1;
				this.statusMsg = `กำลังดึงรูปต้นฉบับหน้า ${pageNumber}/${project.pages.length}...`;
				try {
					// ORIGINAL purpose = the raw stored bytes (มิติเท่าที่เก็บจริง), and the
					// server mints it only for moderation-passed assets — fail closed per page.
					const apiUrl = api.imageUrl(project.projectId, page.imageId);
					const signedUrl = await api.signedAssetUrl(apiUrl, project.projectId, page.imageId, "original");
					if (signedUrl === apiUrl && !this.localImageUrls[page.imageId]) {
						throw new Error("ยังดาวน์โหลดต้นฉบับไม่ได้ (รอรีวิว moderation)");
					}
					const sourceUrl = this.localImageUrls[page.imageId] && !api.isApiAssetUrl(this.localImageUrls[page.imageId]!)
						? this.localImageUrls[page.imageId]!
						: signedUrl;
					// Bound the asset fetch so a hung/black-holed download becomes a SKIPPED
					// page (caught below) instead of wedging the whole roundtrip with
					// cleanRoundtripBusy=true forever (#4 FE-2). Guard AbortSignal.timeout
					// for older runtimes that lack it.
					const fetchInit: RequestInit = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
						? { signal: AbortSignal.timeout(30000) }
						: {};
					const response = await fetch(sourceUrl, fetchInit);
					if (!response.ok) throw new Error(`ดาวน์โหลดไม่สำเร็จ (${response.status})`);
					const blob = await response.blob();
					files.push({
						path: `originals/${cleanExportFilename(pageNumber, page.originalName, page.imageId)}`,
						data: blob,
						modifiedAt: exportedAt,
					});
				} catch (error) {
					skipped.push(`หน้า ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (!files.length) {
				this.statusMsg = `Exportไปคลีนไม่สำเร็จ: ${skipped[0] ?? "ไม่มีหน้าที่ดึงได้"}`;
				return;
			}
			// README states the contract: clean in place, keep EXACT dimensions,
			// keep the page-NNN filename prefix for the import-back matching.
			const readme = [
				"Comic Workspace — external clean roundtrip",
				"",
				"1) คลีนรูปในโฟลเดอร์ originals/ ได้เลย (เช่นใน Photoshop)",
				"2) ห้ามเปลี่ยนขนาดรูปเด็ดขาด — ต้องกว้าง×สูงเท่าเดิมทุกพิกเซล",
				"   (ตำแหน่งข้อความ/เลเยอร์ทั้งหมดอ้างอิงพิกัดของรูปเดิม)",
				"3) คงชื่อไฟล์ส่วนหน้า page-NNN ไว้ เพื่อให้ระบบจับคู่หน้าได้ตอนนำกลับ",
				"4) นำกลับเข้าที่เมนูเดิมด้วยปุ่ม นำรูปที่คลีนแล้วกลับเข้า",
				"",
				"1) Clean the images inside originals/ (e.g. in Photoshop).",
				"2) DO NOT resize — the cleaned file must keep the EXACT same pixel dimensions.",
				"3) Keep the page-NNN filename prefix so pages can be matched on import.",
				...(skipped.length ? ["", "Skipped pages:", ...skipped] : []),
			].join("\n");
			files.push({ path: "README.txt", data: new Blob([readme], { type: "text/plain" }), modifiedAt: exportedAt });
			const zipBlob = await createZipBlob(files);
			const stamp = exportedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-");
			this.downloadBlob(zipBlob, `${(project.name || "chapter").replace(/[\\/:*?"<>|]/g, "_")}-originals-${stamp}.zip`);
			this.statusMsg = skipped.length
				? `Exportต้นฉบับ ${files.length - 1} หน้า (ข้าม ${skipped.length} หน้า: ${skipped[0]})`
				: `Exportต้นฉบับ ${files.length - 1} หน้าแล้ว — คลีนเสร็จแล้วนำกลับเข้าด้วยปุ่มImport`;
		} finally {
			this.cleanRoundtripBusy = false;
		}
	}

	async importCleanedPages(rawFiles: File[], editor?: any): Promise<void> {
		if (!this.project || this.cleanRoundtripBusy) return;
		const project = this.project;
		const files = filterProjectImageFiles(rawFiles);
		if (!files.length) {
			this.statusMsg = "ยังไม่มีไฟล์รูป PNG, JPG หรือ WebP ที่รองรับ";
			return;
		}
		const plan = planCleanedImport(files, project.pages.length);
		if (!plan.matches.length) {
			this.statusMsg = "จับคู่ไฟล์กับหน้าไม่ได้ — ชื่อไฟล์ต้องขึ้นต้นด้วย page-001 แบบเดียวกับตอนExport";
			return;
		}
		this.cleanRoundtripBusy = true;
		const replaced: number[] = [];
		const skipped: string[] = [];
		for (const item of plan.unmatched) skipped.push(`${item.name}: ไม่มีเลขหน้า page-NNN ในชื่อไฟล์`);
		for (const item of plan.outOfRange) skipped.push(`${item.file.name}: หน้า ${item.pageNumber} ไม่อยู่ในตอนนี้`);
		try {
			for (const item of plan.matches) {
				const page = project.pages[item.pageIndex];
				if (!page) continue;
				// IDENTICAL-DIMENSION GUARD: text layers / bboxes / edit ROIs are in
				// absolute source pixels — a different-sized image would shift them all.
				// The stored asset record carries the authoritative original size.
				const asset = this.imageAssets.find((entry) => entry.imageId === page.imageId);
				let expected = asset && asset.width > 0 && asset.height > 0
					? { width: asset.width, height: asset.height }
					: null;
				try {
					const actual = await readCleanedImageDimensions(item.file);
					if (!expected) {
						skipped.push(`หน้า ${item.pageNumber}: ไม่ทราบขนาดต้นฉบับ จึงไม่กล้าแทนที่ (ปลอดภัยไว้ก่อน)`);
						continue;
					}
					if (actual.width !== expected.width || actual.height !== expected.height) {
						skipped.push(`หน้า ${item.pageNumber}: ขนาดไม่ตรงต้นฉบับ (${actual.width}×${actual.height} ≠ ${expected.width}×${expected.height})`);
						continue;
					}
				} catch (error) {
					skipped.push(`หน้า ${item.pageNumber}: อ่านไฟล์ไม่ได้ (${error instanceof Error ? error.message : String(error)})`);
					continue;
				}
				// The honest success flag covers the save-failure rollback path too —
				// inspecting captured page state would read the pre-rollback mutation.
				const swapped = await this.replacePageImage(item.pageIndex, item.file, editor);
				if (swapped) {
					replaced.push(item.pageNumber);
				} else {
					skipped.push(`หน้า ${item.pageNumber}: แทนที่ไม่สำเร็จ`);
				}
			}
			const summary = [`นำรูปคลีนกลับเข้า ${replaced.length}/${plan.matches.length} หน้า`];
			if (skipped.length) summary.push(`ข้าม: ${skipped[0]}${skipped.length > 1 ? ` (+อีก ${skipped.length - 1})` : ""}`);
			this.statusMsg = summary.join(" — ");
		} finally {
			this.cleanRoundtripBusy = false;
		}
	}

	async replacePageImageLayerAsset(pageIndex: number, layerId: string, file: File, editor?: any): Promise<void> {
		if (!this.project || pageIndex < 0 || pageIndex >= this.project.pages.length || !layerId) return;
		if (!isSupportedImageFile(file)) {
			this.statusMsg = `กู้รูปเสริมไม่สำเร็จ: ${file.name} ไม่ใช่ ${supportedImageCopy}`;
			return;
		}
		const page = this.project.pages[pageIndex];
		const layerIndex = page.imageLayers?.findIndex((layer) => layer.id === layerId) ?? -1;
		if (layerIndex < 0 || !page.imageLayers?.[layerIndex]) {
			this.statusMsg = "กู้รูปเสริมไม่สำเร็จ: ไม่พบเลเยอร์นี้แล้ว";
			return;
		}

		const layer = page.imageLayers[layerIndex];
		const previousImageId = layer.imageId;
		const fallbackWidth = layer.w || editor?.imageWidth || 240;
		const fallbackHeight = layer.h || editor?.imageHeight || 120;
		const isCurrentPage = pageIndex === this.project.currentPage;
		this.statusMsg = `กำลังกู้รูปเสริมหน้า ${pageIndex + 1}...`;
		try {
			const previousProject = cloneProjectState(this.project);
			const previousImageAssets = [...this.imageAssets];
			const previousImageAssetsProjectId = this.imageAssetsProjectId;
			const previousAssetLoadErrors = JSON.parse(JSON.stringify(this.assetLoadErrors)) as Record<number, PageAssetLoadErrorEntry>;
			const { imageId } = await this.uploadSingleProjectImage(file, {
				prefix: "image-layer",
				fallbackWidth,
				fallbackHeight,
				metadata: { assetKind: "image-layer-replacement" },
			});
			const nextLayer: ImageLayer = {
				...layer,
				imageId,
				imageName: imageId,
				originalName: file.name,
				restoreImageId: layer.restoreImageId === previousImageId ? imageId : layer.restoreImageId,
			};
			page.imageLayers = [
				...page.imageLayers.slice(0, layerIndex),
				nextLayer,
				...page.imageLayers.slice(layerIndex + 1),
			];
			this.resetPageQcHandoffForUpstreamChange(page, "pending");
			this.clearPageAssetLoadErrorIf(pageIndex, (error) =>
				error.kind === "image-layer"
				&& (error.layerId === layerId || error.imageId === previousImageId)
			);
			try {
				await this.saveState();
			} catch (error) {
				this.project = previousProject;
				this.tasks = previousProject.tasks ?? [];
				this.activityLog = previousProject.activityLog ?? [];
				this.comments = previousProject.comments ?? [];
				this.reviewDecisions = previousProject.reviewDecisions ?? [];
				this.aiReviewMarkers = previousProject.aiReviewMarkers ?? [];
				this.imageAssets = previousImageAssets;
				this.imageAssetsProjectId = previousImageAssetsProjectId;
				this.assetLoadErrors = previousAssetLoadErrors;
				throw error;
			}
			if (editor && isCurrentPage) {
				await this.loadPage(pageIndex, editor);
			}
			await this.loadVersions();
			await this.loadRecentProjects();
			this.statusMsg = `กู้รูปเสริมหน้า ${pageIndex + 1} แล้ว`;
		} catch (error) {
			console.error("[ProjectStore] replacePageImageLayerAsset error:", error);
			const message = error instanceof Error ? error.message : "กู้รูปเสริมไม่สำเร็จ";
			this.statusMsg = `กู้รูปเสริมไม่สำเร็จ: ${message}`;
		}
	}

	async replaceCurrentPageImageLayerAsset(layerId: string, file: File, editor?: any): Promise<void> {
		if (!this.project) return;
		await this.replacePageImageLayerAsset(this.project.currentPage, layerId, file, editor);
	}

	getMatchingPageImageRelinkPreview(files: File[]): MatchingPageImageRelinkPreview {
		const unsupportedSummary = formatUnsupportedImageFileSummary(files);
		const orderedFiles = orderProjectImageFiles(files);
		const plan = this.project
			? buildPageImageRelinkPlan(this.project.pages, orderedFiles, undefined, { matchUnmatchedByOrder: true })
			: { matches: [], unmatchedPageIndexes: [], unusedFiles: orderedFiles };
		const nameMatchedCount = plan.matches.filter((match) => match.matchedBy === "name").length;
		const orderMatchedCount = plan.matches.filter((match) => match.matchedBy === "order").length;
		return {
			plan,
			supportedFileCount: orderedFiles.length,
			unsupportedSummary,
			nameMatchedCount,
			orderMatchedCount,
			requiresOrderConfirmation: orderMatchedCount > 0,
		};
	}

	async replaceMatchingPageImages(
		files: File[],
		editor?: any,
		options: ReplaceMatchingPageImagesOptions = {},
	): Promise<void> {
		if (!this.project || files.length === 0) return;
		const project = this.project;
		const preview = this.getMatchingPageImageRelinkPreview(files);
		const { plan, unsupportedSummary } = preview;
		if (!preview.supportedFileCount) {
			const suffix = unsupportedSummary ? `; ${unsupportedSummary}` : "";
			this.statusMsg = `กู้รูปไม่สำเร็จ: ยังไม่มีไฟล์ ${supportedImageCopy} ที่ใช้ได้${suffix}`;
			return;
		}
		if (!plan.matches.length) {
			const suffix = unsupportedSummary ? `; ${unsupportedSummary}` : "";
			this.statusMsg = `กู้รูปไม่สำเร็จ: ไม่พบชื่อไฟล์ที่ตรงกับหน้า${suffix}`;
			return;
		}
		if (preview.requiresOrderConfirmation && !options.allowOrderFallback) {
			this.statusMsg = `กู้รูปต้องยืนยัน: ${preview.orderMatchedCount} หน้าใช้ลำดับไฟล์จากโฟลเดอร์ ตรวจพรีวิวก่อนแทนรูป`;
			return;
		}

		const currentPageWillChange = plan.matches.some((match) => match.pageIndex === project.currentPage);
		this.statusMsg = `กำลังกู้รูป ${plan.matches.length} หน้า...`;
		try {
			if (editor && currentPageWillChange) {
				this.syncEditorLayers(editor);
			}

			const previousProject = cloneProjectState(project);
			const previousImageAssets = [...this.imageAssets];
			const previousImageAssetsProjectId = this.imageAssetsProjectId;
			const previousAssetLoadErrors = JSON.parse(JSON.stringify(this.assetLoadErrors)) as Record<number, PageAssetLoadErrorEntry>;
			const uploadFiles = plan.matches.map((match) => match.file);
			const { imageIds, assets } = await uploadImagesInBatches(uploadFiles, (batch) => api.uploadImages(project.projectId, batch, undefined, { assetKind: "page-replacement" }), {
				onBatchStart: ({ batchIndex, batchCount }) => {
					this.statusMsg = batchCount > 1
						? `กำลังกู้รูปชุด ${batchIndex + 1}/${batchCount}...`
						: `กำลังกู้รูป ${plan.matches.length} หน้า...`;
				},
			});
			if (imageIds.length < plan.matches.length) {
				throw new Error(`อัปโหลดได้ image id ${imageIds.length}/${plan.matches.length}`);
			}
			if (this.project !== project) {
				this.statusMsg = "ยกเลิกกู้รูป: งานเปลี่ยนระหว่างอัปโหลด";
				return;
			}

			for (const [index, match] of plan.matches.entries()) {
				const imageId = imageIds[index];
				const page = project.pages[match.pageIndex];
				if (!imageId || !page) continue;
				const previousImageRefs = collectPageImageRelinkRefs(page);
				page.imageId = imageId;
				page.imageName = imageId;
				page.originalName = match.file.name;
				page.edits = undefined;
				remapPageImageReferences(project, match.pageIndex, previousImageRefs, imageId);
				this.clearPageAssetLoadError(match.pageIndex);
			}

			this.mergeImageAssets(assets);
			try {
				await this.saveState();
			} catch (error) {
				this.project = previousProject;
				this.tasks = previousProject.tasks ?? [];
				this.activityLog = previousProject.activityLog ?? [];
				this.comments = previousProject.comments ?? [];
				this.reviewDecisions = previousProject.reviewDecisions ?? [];
				this.aiReviewMarkers = previousProject.aiReviewMarkers ?? [];
				this.imageAssets = previousImageAssets;
				this.imageAssetsProjectId = previousImageAssetsProjectId;
				this.assetLoadErrors = previousAssetLoadErrors;
				throw error;
			}
			if (editor && currentPageWillChange && project.currentPage >= 0) {
				await this.loadPage(project.currentPage, editor);
			}
			await this.loadVersions();
			await this.loadRecentProjects();
			const unmatched = plan.unmatchedPageIndexes.length;
			const orderMatched = plan.matches.filter((match) => match.matchedBy === "order").length;
			const orderNote = orderMatched > 0 ? ` (${orderMatched} ตามลำดับหน้า)` : "";
			const unsupportedNote = unsupportedSummary ? `; ข้าม ${unsupportedSummary}` : "";
			this.statusMsg = unmatched > 0
					? `กู้รูปแล้ว ${plan.matches.length} หน้า${orderNote}; อีก ${unmatched} หน้ายังต้องหาไฟล์ที่ตรงกัน${unsupportedNote}`
					: `กู้รูปแล้ว ${plan.matches.length} หน้า${orderNote}${unsupportedNote}`;
		} catch (error) {
			console.error("[ProjectStore] replaceMatchingPageImages error:", error);
			const message = error instanceof Error ? error.message : "กู้รูปไม่สำเร็จ";
			this.statusMsg = `กู้รูปไม่สำเร็จ: ${message}`;
		}
	}

	async setProjectCover(projectId: string, file: File): Promise<void> {
		if (!projectId || !file) return;
		if (!isSupportedImageFile(file)) {
			this.statusMsg = `ตั้งปกไม่สำเร็จ: ${file.name} ไม่ใช่ ${supportedImageCopy}`;
			return;
		}
		this.statusMsg = "กำลังอัปโหลดปกงาน...";
		try {
			const upload = await api.uploadImages(projectId, [file], undefined, { assetKind: "cover-image" });
			const imageId = upload.imageIds[0];
			if (!imageId) throw new Error("อัปโหลดเสร็จแต่ไม่ได้รับ image id");

			const targetProject = this.project?.projectId === projectId
				? this.project
				: await api.loadProject(projectId);
			// P0-2 (round-3): capture the CAS baseline BEFORE mutating cover fields so the
			// full-payload save goes through CAS. Without it this full-state save (it carries
			// `pages`) could silently overwrite a newer concurrent page edit; with it a stale
			// cover save is CAS-rejected (project_save_conflict) instead of clobbering.
			const coverBaseFingerprint = createProjectStateFingerprint(targetProject);
			targetProject.coverImageId = imageId;
			targetProject.coverOriginalName = file.name;
			await api.saveProject(projectId, targetProject, { baseFingerprint: coverBaseFingerprint });
			if (this.project?.projectId === projectId) {
				this.project = targetProject;
				this.mergeImageAssets(upload.assets);
				this.projectBaseSnapshot = cloneProjectState(targetProject);
				this.projectBaseFingerprint = createProjectStateFingerprint(targetProject);
				this.saveSyncStatus = "saved";
			}
			await this.loadRecentProjects();
			this.statusMsg = `อัปเดตปกแล้ว: ${file.name}`;
		} catch (error) {
			console.error("[ProjectStore] setProjectCover error:", error);
			const message = error instanceof Error ? error.message : "ตั้งปกไม่สำเร็จ";
			this.statusMsg = `ตั้งปกไม่สำเร็จ: ${message}`;
		}
	}

	private buildReferenceImageLayer(asset: ProjectImageAssetSummary, editor: any, originalName?: string): ImageLayer | null {
		if (!this.project || !editor) return null;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return null;

		const imageWidth = Math.max(1, editor.imageWidth || 1024);
		const imageHeight = Math.max(1, editor.imageHeight || 1024);
		const naturalWidth = Math.max(1, asset.width ?? Math.round(imageWidth * 0.35));
		const naturalHeight = Math.max(1, asset.height ?? Math.round(imageHeight * 0.35));
		const maxWidth = Math.max(96, Math.round(imageWidth * 0.42));
		const maxHeight = Math.max(96, Math.round(imageHeight * 0.42));
		const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
		const width = Math.max(24, Math.round(naturalWidth * scale));
		const height = Math.max(24, Math.round(naturalHeight * scale));

		return {
			id: `image-layer-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
			imageId: asset.imageId,
			imageName: asset.imageId,
			originalName: originalName ?? asset.originalName,
			sourceW: naturalWidth,
			sourceH: naturalHeight,
			x: Math.max(0, Math.round((imageWidth - width) / 2)),
			y: Math.max(0, Math.round((imageHeight - height) / 2)),
			w: width,
			h: height,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: editor.getAllImageLayers?.().length ?? page.imageLayers?.length ?? 0,
			role: "reference",
		};
	}

	private async placeReferenceImageLayer(asset: ProjectImageAssetSummary, editor: any, originalName?: string): Promise<ImageLayer | null> {
		if (!this.project || !editor) return null;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return null;

		const layer = this.buildReferenceImageLayer(asset, editor, originalName);
		if (!layer) return null;

		const addImageLayer = typeof editor.addImageLayerWithHistory === "function"
			? editor.addImageLayerWithHistory.bind(editor)
			: editor.addImageLayer?.bind(editor);
			if (!addImageLayer) throw new Error("ตัวแก้หน้ายังเพิ่มเลเยอร์รูปไม่ได้");

		const addedLayer = await addImageLayer(layer, this.getImageUrl(asset.imageId));
		page.imageLayers = editor.getAllImageLayers?.() ?? [...(page.imageLayers ?? []), addedLayer ?? layer];
		this.resetPageQcHandoffForUpstreamChange(page, "pending");
		this.markCurrentPageUnsaved();
		return addedLayer ?? layer;
	}

	private buildAiResultImageLayer(
		marker: AiReviewMarker,
		page: Page,
		editor: any,
		measuredResult?: { width: number; height: number } | null,
	): ImageLayer {
		const fallbackWidth = Math.max(1, Math.round(editor?.imageWidth ?? 1024));
		const fallbackHeight = Math.max(1, Math.round(editor?.imageHeight ?? 1024));
		const pageDimensions = this.getPageImageDimensions(page, fallbackWidth, fallbackHeight);
		const imageWidth = pageDimensions.width;
		const imageHeight = pageDimensions.height;
		const resultAsset = this.imageAssets.find((item) => item.imageId === marker.resultImageId || item.assetId === marker.resultImageId);
		const markerReferences = this.project?.aiReviewMarkers?.length ? this.project.aiReviewMarkers : this.aiReviewMarkers;
		const markerLabel = aiReviewMarkerReferenceLabel(markerReferences, marker);
		// The stored AI result is a FULL-PAGE composite (backend composites the
		// edited crop back onto the original page). To paint ONLY the crop region
		// — and never replace the whole page — the placed layer carries a
		// sourceCrop equal to the marker region, so the editor draws just that
		// sub-rectangle of the result image at the region's position+size.
		//
		// The crop decision MUST use the result's TRUE natural dimensions, never a
		// page-dim fallback: a region-sized legacy result (or a raw provider-
		// fallback that is larger-than-region-but-not-page) must place as a plain
		// region layer. Priority: (1) measured/decoded dims, (2) recorded asset
		// dims, (3) UNKNOWN → SAFE path (region-sized => no crop) rather than
		// inventing page dims and corrupting the layer.
		const reliableResult = (measuredResult && measuredResult.width > 0 && measuredResult.height > 0)
			? measuredResult
			: (resultAsset?.width && resultAsset?.height
				? { width: resultAsset.width, height: resultAsset.height }
				: null);
		// When dims are unknown, pass region-sized dims so the helper omits the
		// crop (safe: draws the result whole at the region, never squeezes a page).
		const resultWidth = Math.max(1, reliableResult?.width ?? Math.round(marker.region.w));
		const resultHeight = Math.max(1, reliableResult?.height ?? Math.round(marker.region.h));
		const geometry = buildAiResultLayerGeometry(marker.region, imageWidth, imageHeight, resultWidth, resultHeight);
		return {
			id: `ai-result-${marker.id}`,
			imageId: marker.resultImageId ?? "",
			imageName: marker.resultImageId ?? "ai-result",
			originalName: `ผล ${markerLabel} (หน้า ${marker.pageIndex + 1})`,
			sourceW: resultWidth,
			sourceH: resultHeight,
			sourceCrop: geometry.sourceCrop ?? undefined,
			x: geometry.x,
			y: geometry.y,
			w: geometry.w,
			h: geometry.h,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: editor?.getAllImageLayers?.().length ?? page.imageLayers?.length ?? 0,
			role: "overlay",
			aiMarkerId: marker.id,
		};
	}

	async placeAiReviewMarkerResultAsImageLayer(
		markerId: string,
		editor: any,
		options: { markApplied?: boolean; statusMessage?: string } = {},
	): Promise<ImageLayer | null> {
		if (!this.project) return null;
		const markApplied = options.markApplied !== false;
		const marker = this.aiReviewMarkers.find((item) => item.id === markerId)
			?? this.project.aiReviewMarkers?.find((item) => item.id === markerId);
		if (!marker) {
			this.statusMsg = "ไม่พบผล AI นี้";
			return null;
		}
		if (!this.aiReviewMarkers.some((item) => item.id === marker.id)) {
			this.aiReviewMarkers = this.project.aiReviewMarkers ?? [];
		}
		if (!marker.resultImageId) {
			this.statusMsg = "ผล AI นี้ยังไม่มีรูปผลลัพธ์";
			return null;
		}
		const page = this.project.pages[marker.pageIndex];
		if (!page) {
			this.statusMsg = `หน้าของผล AI ${marker.pageIndex + 1} ไม่มีแล้ว`;
			return null;
		}

		if (editor && this.project.currentPage !== marker.pageIndex) {
			const opened = await this.goToPage(marker.pageIndex, editor);
			if (!opened && this.project.currentPage !== marker.pageIndex) {
				this.statusMsg = `เปิดหน้าของผล AI ${marker.pageIndex + 1} ไม่สำเร็จ`;
				return null;
			}
		}

		const activePage = this.project.pages[marker.pageIndex];
		if (!activePage) return null;
		const existingLayer = activePage.imageLayers?.find((layer) => layer.id === `ai-result-${marker.id}`);
		const canPlaceReviewedResult = canPlaceAiResultAsEditableLayer(this.project, marker);
		const canStageBrushDraft = !markApplied
			&& marker.status === "needs_review"
			&& Boolean(marker.resultImageId)
			&& !getAiMarkerReferenceIssue(this.project, marker);
		if (existingLayer) {
			if (markApplied && marker.status !== "accepted" && marker.status !== "applied") {
				this.statusMsg = "ยืนยันผลผ่านก่อนวางเลเยอร์ AI";
				return null;
			}
			if (editor && this.project.currentPage === marker.pageIndex) {
				editor.selectImageLayer?.(existingLayer.id);
			}
			if (markApplied && marker.status !== "applied") {
				const applyState = await this.resolveAiResultApplyStatus(marker);
				this.statusMsg = options.statusMessage ?? (
					applyState === "applied"
						? "เลือกเลเยอร์ผล AI แล้ว"
						: "เลือกเลเยอร์ผล AI แล้ว บันทึกก่อนปิดรายการผล AI"
				);
				return existingLayer;
			}
			this.statusMsg = options.statusMessage ?? "เลือกเลเยอร์ผล AI แล้ว";
			return existingLayer;
		}
		if (!canPlaceReviewedResult && !canStageBrushDraft) {
			this.statusMsg = marker.status === "applied"
				? "กู้เลเยอร์ AI ไม่ได้เพราะผล AI นี้ไม่ตรงกับหน้าปัจจุบัน"
				: "ยืนยันผลผ่านก่อนวางเลเยอร์ AI";
			return null;
		}

		// Measure the result image's TRUE natural size before deciding the crop,
		// so a region-sized / non-full-page result is never mis-cropped against a
		// page-dim fallback. Falls back to recorded asset dims (then SAFE no-crop)
		// inside buildAiResultImageLayer when decode is unavailable.
		const measuredResult = await readImageUrlDimensions(this.getImageUrl(marker.resultImageId));
		const layer = this.buildAiResultImageLayer(marker, activePage, editor, measuredResult);
		let addedLayer: ImageLayer = layer;
		if (editor && this.project.currentPage === marker.pageIndex) {
			const addImageLayer = typeof editor.addImageLayerWithHistory === "function"
				? editor.addImageLayerWithHistory.bind(editor)
				: editor.addImageLayer?.bind(editor);
			if (!addImageLayer) {
				this.statusMsg = "ตัวแก้หน้ายังเพิ่มเลเยอร์รูปไม่ได้";
				return null;
			}
			addedLayer = await addImageLayer(layer, this.getImageUrl(marker.resultImageId)) ?? layer;
			const liveImageLayers = editor.getAllImageLayers?.();
			const uniqueLiveImageLayers = Array.isArray(liveImageLayers) ? keepLastLayerById(liveImageLayers) : null;
			activePage.imageLayers = uniqueLiveImageLayers?.some((item) => item.id === addedLayer.id)
				? uniqueLiveImageLayers
				: [...(activePage.imageLayers ?? []).filter((item) => item.id !== addedLayer.id), addedLayer];
		} else {
			activePage.imageLayers = [...(activePage.imageLayers ?? []), addedLayer];
		}
		this.project.pages = [...this.project.pages];

		this.resetPageQcHandoffForUpstreamChange(activePage, "pending");
		this.markCurrentPageUnsaved();
		if (markApplied) {
				const applyState = await this.resolveAiResultApplyStatus(marker);
				this.statusMsg = options.statusMessage ?? (
					applyState === "applied"
							? "วางผล AI เป็นเลเยอร์แล้ว"
							: "วางผล AI เป็นเลเยอร์แล้ว บันทึกก่อนปิดรายการผล AI"
				);
				return addedLayer;
			}
				this.statusMsg = options.statusMessage ?? "วางผล AI เป็นเลเยอร์แล้ว";
		return addedLayer;
	}

	async addReferenceImageLayerFromAsset(assetId: string, editor: any): Promise<ImageLayer | null> {
		if (!this.project || !editor || !assetId) return null;
		let asset = this.imageAssets.find((item) => item.assetId === assetId || item.imageId === assetId);
		if (!asset) {
			await this.loadImageAssets();
			asset = this.imageAssets.find((item) => item.assetId === assetId || item.imageId === assetId);
		}
		if (!asset) {
			this.statusMsg = "ไม่พบรูปนี้ในคลัง Asset";
			return null;
		}

		try {
			const addedLayer = await this.placeReferenceImageLayer(asset, editor);
			if (!addedLayer) return null;
			this.statusMsg = `เพิ่มรูปเสริมแล้ว: ${asset.originalName || asset.imageId}`;
			return addedLayer;
		} catch (error) {
			console.error("[ProjectStore] addReferenceImageLayerFromAsset error:", error);
			const message = error instanceof Error ? error.message : "เพิ่มรูปเสริมไม่สำเร็จ";
			this.statusMsg = `เพิ่มรูปเสริมไม่สำเร็จ: ${message}`;
			return null;
		}
	}

	async replaceImageLayerSourceFromAsset(assetId: string, layerId: string, editor: any): Promise<ImageLayer | null> {
		if (!this.project || !editor || !assetId || !layerId) return null;
		const page = this.project.pages[this.project.currentPage];
		if (!page) return null;

		let asset = this.imageAssets.find((item) => item.assetId === assetId || item.imageId === assetId);
		if (!asset) {
			await this.loadImageAssets();
			asset = this.imageAssets.find((item) => item.assetId === assetId || item.imageId === assetId);
		}
		if (!asset) {
			this.statusMsg = "ไม่พบรูปนี้ในคลัง Asset";
			return null;
		}

		const currentLayer = (editor.getAllImageLayers?.() ?? page.imageLayers ?? []).find((layer: ImageLayer) => layer.id === layerId) as ImageLayer | undefined;
		if (!currentLayer) {
			this.statusMsg = "แทนที่รูปไม่สำเร็จ: ไม่พบเลเยอร์ที่เลือก";
			return null;
		}
		if (currentLayer.locked === true) {
			this.statusMsg = "แทนที่รูปไม่ได้: เลเยอร์นี้ล็อกอยู่";
			return null;
		}

		const nextLayer: ImageLayer = {
			...currentLayer,
			imageId: asset.imageId,
			imageName: asset.imageId,
			originalName: asset.originalName,
			sourceW: asset.width,
			sourceH: asset.height,
			restoreImageId: undefined,
		};

		try {
			const replaceSource = typeof editor.replaceImageLayerSourceWithHistory === "function"
				? editor.replaceImageLayerSourceWithHistory.bind(editor)
				: editor.replaceImageLayerSourceInternal?.bind(editor);
			if (!replaceSource) throw new Error("ตัวแก้หน้ายังแทนที่รูปในเลเยอร์ไม่ได้");

			const replacedLayer = await replaceSource(layerId, nextLayer, this.getImageUrl(asset.imageId));
			const syncedLayers = editor.getAllImageLayers?.() ?? null;
			page.imageLayers = syncedLayers ?? (page.imageLayers ?? []).map((layer) => layer.id === layerId ? (replacedLayer ?? nextLayer) : layer);
			this.markCurrentPageUnsaved();
			this.statusMsg = `แทนที่รูปในเลเยอร์แล้ว: ${asset.originalName || asset.imageId}`;
			return replacedLayer ?? nextLayer;
		} catch (error) {
			console.error("[ProjectStore] replaceImageLayerSourceFromAsset error:", error);
			const message = error instanceof Error ? error.message : "แทนที่รูปไม่สำเร็จ";
			this.statusMsg = `แทนที่รูปไม่สำเร็จ: ${message}`;
			return null;
		}
	}

	async addReferenceImageLayer(file: File, editor: any): Promise<ImageLayer | null> {
		if (!this.project || !editor || !file) return null;
		if (!isSupportedImageFile(file)) {
			this.statusMsg = `เพิ่มรูปเสริมไม่สำเร็จ: ${file.name} ไม่ใช่ ${supportedImageCopy}`;
			return null;
		}

		this.statusMsg = "กำลังอัปโหลดรูปเสริม...";
		try {
			const { asset } = await this.uploadSingleProjectImage(file, {
				prefix: "reference-image",
				fallbackWidth: Math.max(1, Math.round(editor?.imageWidth ?? 1024)),
				fallbackHeight: Math.max(1, Math.round(editor?.imageHeight ?? 1024)),
				metadata: { assetKind: "reference-image-layer" },
			});
			const addedLayer = await this.placeReferenceImageLayer(asset, editor, file.name);
			if (!addedLayer) return null;
			this.statusMsg = `เพิ่มรูปเสริมแล้ว: ${file.name}`;
			return addedLayer;
		} catch (error) {
			console.error("[ProjectStore] addReferenceImageLayer error:", error);
			const message = error instanceof Error ? error.message : "เพิ่มรูปเสริมไม่สำเร็จ";
			this.statusMsg = `เพิ่มรูปเสริมไม่สำเร็จ: ${message}`;
			return null;
		}
	}

	private buildCreditImageLayersForPage(input: {
		asset: ProjectImageAssetSummary;
		pageWidth: number;
		pageHeight: number;
		preset: CreditPreset;
		maxWidth: number;
		repeatEveryPx: number;
		startIndex: number;
		originalName?: string;
	}): ImageLayer[] {
		const naturalWidth = Math.max(1, input.asset.width || input.maxWidth || 240);
		const naturalHeight = Math.max(1, input.asset.height || input.maxWidth || 120);
		const maxWidth = Math.max(16, Math.min(Math.round(input.maxWidth || 240), Math.round(input.pageWidth)));
		const width = Math.max(16, Math.min(maxWidth, naturalWidth));
		const height = Math.max(16, Math.round(width * (naturalHeight / naturalWidth)));
		const offset = Math.max(0, Math.round(input.preset.offset ?? 0));
		const xCenter = Math.round((input.pageWidth - width) / 2);
		const yCenter = Math.round((input.pageHeight - height) / 2);
		const baseX = input.preset.placement === "left"
			? offset
			: input.preset.placement === "right"
				? Math.max(0, Math.round(input.pageWidth - width - offset))
				: xCenter;
		const baseY = input.preset.placement === "top"
			? offset
			: input.preset.placement === "bottom" || input.preset.placement === "left" || input.preset.placement === "right"
				? Math.max(0, Math.round(input.pageHeight - height - offset))
				: yCenter;
		const repeatEveryPx = input.repeatEveryPx > 0
			? Math.max(32, Math.round(input.repeatEveryPx))
			: 0;
		const repeatCount = repeatEveryPx > 0
			? Math.min(200, Math.floor(Math.max(0, input.pageHeight - offset - height) / repeatEveryPx) + 1)
			: 1;
		const yPositions = repeatEveryPx > 0
			? Array.from(
				{ length: Math.max(1, repeatCount) },
				(_, index) => Math.min(Math.max(0, input.pageHeight - height), offset + index * repeatEveryPx),
			)
			: [baseY];
		const uniqueYPositions = [...new Set(yPositions)];
		const repeated = uniqueYPositions.length > 1;

		return uniqueYPositions.map((y, index) => ({
			id: `credit-image-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${index}`}`,
			name: repeated ? `รูปเครดิต ${index + 1}/${uniqueYPositions.length}` : undefined,
			imageId: input.asset.imageId,
			imageName: input.asset.imageId,
			originalName: input.originalName ?? input.asset.originalName,
			sourceW: naturalWidth,
			sourceH: naturalHeight,
			x: Math.max(0, Math.round(baseX)),
			y: Math.max(0, Math.round(y)),
			w: width,
			h: height,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: input.startIndex + index,
			role: "credit",
		}));
	}

	private buildCreditTextLayersForPage(input: {
		pageWidth: number;
		pageHeight: number;
		preset: CreditPreset;
		text: string;
		offset: number;
		repeatEveryPx: number;
		startIndex: number;
	}): TextLayer[] {
		const offset = Math.max(0, Math.round(input.offset));
		const repeatEveryPx = input.repeatEveryPx > 0
			? Math.max(32, Math.round(input.repeatEveryPx))
			: 0;
		const seedLayer = buildCreditLayerFromPreset(input.preset, {
			imageWidth: input.pageWidth,
			imageHeight: input.pageHeight,
			index: input.startIndex,
			text: input.text,
			offset,
		});
		if (repeatEveryPx <= 0) return [seedLayer];

		const maxY = Math.max(0, Math.round(input.pageHeight - seedLayer.h));
		const repeatCount = Math.min(200, Math.floor(Math.max(0, input.pageHeight - offset - seedLayer.h) / repeatEveryPx) + 1);
		const yPositions = Array.from(
			{ length: Math.max(1, repeatCount) },
			(_, index) => Math.min(maxY, offset + index * repeatEveryPx),
		);
		const uniqueYPositions = [...new Set(yPositions)];
		const repeated = uniqueYPositions.length > 1;

		return uniqueYPositions.map((y, index) => ({
			...buildCreditLayerFromPreset(input.preset, {
				imageWidth: input.pageWidth,
				imageHeight: input.pageHeight,
				index: input.startIndex + index,
				text: input.text,
				offset,
			}),
			name: repeated ? `เครดิตข้อความ ${index + 1}/${uniqueYPositions.length}` : undefined,
			y,
		}));
	}

	private getPageImageDimensions(page: Page, fallbackWidth: number, fallbackHeight: number): { width: number; height: number } {
		const pageImageId = this.getPageImageId(page);
		const asset = this.imageAssets.find((item) => item.imageId === pageImageId || item.assetId === pageImageId)
			?? this.imageAssets.find((item) => item.imageId === page.imageId || item.assetId === page.imageId);
		return {
			width: Math.max(1, asset?.width ?? fallbackWidth),
			height: Math.max(1, asset?.height ?? fallbackHeight),
		};
	}

	private getCreditPlacementPlans(scope: CreditApplyScope, preset: CreditPreset): Array<{ pageIndex: number; preset: CreditPreset }> {
		if (!this.project) return [];
		if (scope === "all") {
			return this.project.pages.map((_, pageIndex) => ({ pageIndex, preset }));
		}
		if (scope === "chapter-edges") {
			const lastPageIndex = this.project.pages.length - 1;
			if (lastPageIndex < 0) return [];
			const firstPreset = { ...preset, placement: "top" as CreditPlacement };
			const lastPreset = { ...preset, placement: "bottom" as CreditPlacement };
			return lastPageIndex === 0
				? [
					{ pageIndex: 0, preset: firstPreset },
					{ pageIndex: 0, preset: lastPreset },
				]
				: [
					{ pageIndex: 0, preset: firstPreset },
					{ pageIndex: lastPageIndex, preset: lastPreset },
				];
		}
		return [{ pageIndex: this.project.currentPage, preset }];
	}

	async addCreditImageLayer(file: File, editor: any, options: CreditImagePlacementOptions): Promise<ImageLayer[]> {
		if (!this.project || !editor || !file) return [];
		if (!isSupportedImageFile(file)) {
			this.statusMsg = `เพิ่มรูปเครดิตไม่สำเร็จ: ${file.name} ไม่ใช่ ${supportedImageCopy}`;
			return [];
		}

		const preset = this.creditPresets.find((item) => item.id === options.presetId) ?? this.creditPresets[0];
		if (!preset) return [];

		this.statusMsg = "กำลังเพิ่มรูปเครดิต...";
		try {
			let imageUrl: string | null = null;
			let asset: ProjectImageAssetSummary;
			if (canUseLocalDebugProjectFallback(this.project.projectId)) {
				const imageId = `credit-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
				const dimensions = await readImageFileDimensions(
					file,
					Math.max(1, Math.round(editor.imageWidth || 240)),
					Math.max(1, Math.round(editor.imageHeight || 120)),
				);
				asset = {
					assetId: imageId,
					imageId,
					originalName: file.name,
					mimeType: file.type,
					sizeBytes: file.size,
					sha256: `local-${imageId}`,
					storageDriver: "debug",
					storageKey: `local-object-url/${imageId}`,
					width: dimensions.width,
					height: dimensions.height,
					storageStatus: "released",
					moderationStatus: "passed",
					derivativeCount: 0,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				imageUrl = await this.registerLocalImageFile(imageId, file);
			} else {
				const upload = await api.uploadImages(this.project.projectId, [file], undefined, { assetKind: "credit-image-layer" });
				const imageId = upload.imageIds[0];
				if (!imageId) throw new Error("อัปโหลดเสร็จแต่ไม่ได้รับ image id");
				asset = upload.assets?.find((item) => item.imageId === imageId) ?? {
					assetId: imageId,
					imageId,
					originalName: file.name,
					mimeType: file.type,
					sizeBytes: file.size,
					sha256: "",
					storageDriver: "local",
					storageKey: "",
					width: Math.max(1, Math.round(editor.imageWidth || 240)),
					height: Math.max(1, Math.round(editor.imageHeight || 120)),
					storageStatus: "released" as const,
					moderationStatus: "passed" as const,
					derivativeCount: 0,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
			}
			this.mergeImageAssets([asset]);
			imageUrl ??= this.getImageUrl(asset.imageId);

			const currentPageIndex = this.project.currentPage;
			const scope = options.scope ?? (options.allPages ? "all" : "current");
			const placementPlans = this.getCreditPlacementPlans(scope, preset);
			const addedCurrentLayers: ImageLayer[] = [];
			const fallbackWidth = Math.max(1, Math.round(editor.imageWidth || asset.width || 1024));
			const fallbackHeight = Math.max(1, Math.round(editor.imageHeight || asset.height || 1024));

			for (const plan of placementPlans) {
				const pageIndex = plan.pageIndex;
				const page = this.project.pages[pageIndex];
				if (!page) continue;
				const pageImageLayers = page.imageLayers ?? [];
				const dimensions = pageIndex === currentPageIndex
					? { width: fallbackWidth, height: fallbackHeight }
					: this.getPageImageDimensions(page, fallbackWidth, fallbackHeight);
				const layers = this.buildCreditImageLayersForPage({
					asset,
					pageWidth: dimensions.width,
					pageHeight: dimensions.height,
					preset: plan.preset,
					maxWidth: options.maxWidth,
					repeatEveryPx: scope === "chapter-edges" ? 0 : options.repeatEveryPx,
					startIndex: pageImageLayers.length,
					originalName: file.name,
				});
				if (pageIndex === currentPageIndex) {
					const addImageLayer = typeof editor.addImageLayerWithHistory === "function"
						? editor.addImageLayerWithHistory.bind(editor)
						: editor.addImageLayer?.bind(editor);
					if (!addImageLayer) throw new Error("ตัวแก้หน้ายังเพิ่มเลเยอร์รูปไม่ได้");
					for (const layer of layers) {
						const addedLayer = await addImageLayer(layer, imageUrl);
						addedCurrentLayers.push(addedLayer ?? layer);
					}
					const latestImageLayers = editor.getAllImageLayers?.();
					page.imageLayers = Array.isArray(latestImageLayers)
						&& layers.every((layer) => latestImageLayers.some((item: ImageLayer) => item.id === layer.id))
						? latestImageLayers
						: [...pageImageLayers, ...layers];
				} else {
					page.imageLayers = [...pageImageLayers, ...layers];
				}
				this.resetPageQcHandoffForUpstreamChange(page, "pending");
			}

			this.markCurrentPageUnsaved();
			const scopeLabel = scope === "all"
				? "ทุกหน้า"
				: scope === "chapter-edges"
					? "หัวหน้าแรกและท้ายหน้าสุดท้าย"
					: "หน้านี้";
			const placementHint = scope === "current"
					? "ลากรูปเครดิตบนพื้นที่รูปเพื่อจัดตำแหน่ง"
				: "เปิดแต่ละหน้าแล้วลากรูปเครดิตเพื่อจูนตำแหน่ง";
			this.statusMsg = `เพิ่มรูปเครดิตแล้ว ${scopeLabel}: ${file.name} - ${placementHint}`;
			return addedCurrentLayers;
		} catch (error) {
			console.error("[ProjectStore] addCreditImageLayer error:", error);
			const message = error instanceof Error ? error.message : "เพิ่มรูปเครดิตไม่สำเร็จ";
			this.statusMsg = `เพิ่มรูปเครดิตไม่สำเร็จ: ${message}`;
			return [];
		}
	}

	private downloadUrl(url: string, filename: string): void {
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();
	}

	private downloadBlob(blob: Blob, filename: string): void {
		const url = URL.createObjectURL(blob);
		try {
			this.downloadUrl(url, filename);
		} finally {
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		}
	}

	// Download a persisted page asset by id. A bare `<a download href=/api/images/...>`
	// cannot send the `Authorization: Bearer` header, so a persisted asset 401s (the
	// file "downloads" as a 401 page) — and under signed-asset enforcement the image
	// route rejects a JWT Bearer entirely, accepting only a short-lived `assetToken`.
	// So we mint a signed `?assetToken=` URL (scoped to project/image/`export`) and
	// fetch the bytes through it, wrap them in a same-origin `blob:` object URL,
	// trigger the download, then revoke it. A local `blob:`/`data:` preview (the
	// `localImageUrls` fast path) needs no token and downloads directly.
	// Returns the delivered byte size when known (so the caller can meter the
	// export). A pure local `blob:`/`data:` fast path can't cheaply measure bytes
	// without re-fetching, so it returns `undefined` and the caller falls back to a
	// best-effort estimate.
	// SERVER-AUTHORITATIVE export authorization for a page's source image (codex P0).
	// Mints an EXPORT-purpose signed token for the page background/baked image: the
	// access-token route only issues one for an export-ready (`passed`) asset, so a
	// successful mint proves the asset cleared the export bar server-side. A local-only
	// (never-persisted) image has no server asset to gate — it cannot have entered the
	// moderated corpus, so it passes through. THROWS ExportAssetNotAuthorizedError when
	// a persisted page image cannot mint an export token (non-`passed`), so the caller
	// fails closed instead of delivering an export render of an unsafe page.
	// Gate ONE server asset id against the EXPORT bar (codex P0/P1). Mints an
	// EXPORT-purpose token; the access-token route only issues one for an export-ready
	// (`passed`) asset, so a successful mint proves the asset cleared the export bar
	// server-side. A purely local (never-persisted) preview blob:/data: has no server
	// asset to gate — it cannot have entered the moderated corpus, so it passes
	// through. THROWS ExportAssetNotAuthorizedError when a persisted asset cannot mint
	// an export token (needs_review / quarantined / blocked / unregistered), so the
	// caller fails closed. Reuses the SAME export-purpose check as the client ZIP
	// (`loadExportFabricImage`) so single-page == ZIP rigor.
	private async assertExportAssetAuthorized(imageId: string | null | undefined): Promise<void> {
		if (!this.project) return;
		const id = imageId?.trim();
		if (!id) return;
		// A purely local preview (blob:/data:) is not a server asset — nothing to gate.
		const localUrl = this.localImageUrls[id];
		if (localUrl && !api.isApiAssetUrl(localUrl)) return;
		const apiUrl = api.imageUrl(this.project.projectId, id);
		const signedUrl = await api.signedAssetUrl(apiUrl, this.project.projectId, id, "export", true);
		if (signedUrl === apiUrl) {
			throw new api.ExportAssetNotAuthorizedError(this.project.projectId, id);
		}
	}

	// SERVER-AUTHORITATIVE export authorization for EVERY asset a live single-page
	// merged export renders into the canvas (codex P1). The live-editor merged render
	// composites the in-memory canvas, so the server can't inspect the rendered bytes —
	// it CAN refuse to authorize an export of any non-`passed` asset. Gating ONLY the
	// page background (the prior behavior) left a hole: a user could add/load a
	// `needs_review` (released) image LAYER or non-destructive edit-layer mask/patch in
	// the editor, then single-page export would render that non-passed layer into the
	// download WITHOUT any export-purpose fetch for it. So we gate the FULL rendered
	// asset set — edited/source background + every VISIBLE image layer (its rendered
	// `imageId`) + every VISIBLE composable edit-layer's composited asset (fill-mask
	// `maskAssetId`; patch `patchAssetId`; healing/clone `realizedPatchAssetId`) — each
	// must pass the export bar (mint an EXPORT token / server passed-only), failing
	// closed if ANY isn't passed. This mirrors what the client ZIP path enforces via
	// `loadExportFabricImage` for the background, image layers, masks and patches, and
	// the server export-readiness aggregate. Must run AFTER the editor brush
	// commit/layer sync so it sees the FINAL layer set (a freshly-added layer is
	// already synced onto `page.imageLayers` / `page.imageEditLayers`).
	private async assertCurrentPageExportAuthorized(page: Page): Promise<void> {
		if (!this.project) return;
		// Background (edited bake or source) — the page's hard dependency.
		await this.assertExportAssetAuthorized(page.edits?.imageId || page.imageId);

		// VISIBLE image layers for the rendered track. Mirror the ZIP path's
		// `resolveExportImageLayers` (per-language override else flat `page.imageLayers`)
		// and its `visible !== false` filter — a hidden layer is not rendered, so it is
		// not gated. The rendered source is `layer.imageId` (the displayed pixels);
		// `restoreImageId` is provenance only and never composited.
		const lang = resolveExportLang(this.project);
		const imageLayers = lang === undefined ? (page.imageLayers ?? []) : trackImageLayers(page, lang);
		for (const layer of imageLayers) {
			if (layer.visible === false) continue;
			await this.assertExportAssetAuthorized(layer.imageId);
		}

		// VISIBLE non-destructive edit layers — gate the composited asset the export
		// actually paints (parity with `composeEditLayersOntoExportCanvas`: the same
		// composable kinds + the same per-kind asset id). The edit layer's
		// `sourceImageId` is the background, already gated above.
		const composableKinds = new Set(["fill-mask", "patch", "healing", "clone"]);
		for (const editLayer of page.imageEditLayers ?? []) {
			if (!editLayer || editLayer.visible === false) continue;
			const payload = editLayer.payload as
				| { type?: string; maskAssetId?: string; patchAssetId?: string; realizedPatchAssetId?: string }
				| undefined;
			if (!payload?.type || !composableKinds.has(payload.type)) continue;
			const compositedAssetId = payload.type === "fill-mask"
				? payload.maskAssetId
				: payload.type === "patch"
					? payload.patchAssetId
					: payload.realizedPatchAssetId;
			await this.assertExportAssetAuthorized(compositedAssetId);
		}
	}

	private async downloadPageAsset(imageId: string, filename: string): Promise<{ bytes?: number }> {
		if (!this.project) return {};
		const localUrl = this.localImageUrls[imageId];
		if (localUrl && !api.isApiAssetUrl(localUrl)) {
			this.downloadUrl(localUrl, filename);
			return {};
		}
		// FAIL CLOSED (codex P0): mint an EXPORT-purpose signed token and fetch the bytes
		// THROUGH it, so the server's image serve gate runs the STRICTER export bar
		// (moderation must be `passed`). `signedAssetUrl` returns the URL UNCHANGED when
		// no export token can be minted (the asset is needs_review/quarantined/blocked or
		// has no passing record) — DO NOT fetch that bare URL, because the un-tokened
		// fetch falls back to the Bearer editor_preview path, which the server treats as
		// the (laxer) editor_preview purpose and would serve a non-`passed` asset into
		// the export. Throwing here mirrors `loadExportFabricImage`'s fail-closed behavior
		// so the single-page persisted-asset export and the client ZIP/Fabric export path
		// enforce the SAME export gate.
		const apiUrl = api.imageUrl(this.project.projectId, imageId);
		const signedUrl = await api.signedAssetUrl(apiUrl, this.project.projectId, imageId, "export");
		if (signedUrl === apiUrl) {
			throw new api.ExportAssetNotAuthorizedError(this.project.projectId, imageId);
		}
		const { objectUrl, blob } = await api.fetchAuthedObjectUrlWithBlob(signedUrl);
		try {
			this.downloadUrl(objectUrl, filename);
		} finally {
			setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
		}
		return { bytes: blob.size };
	}

	private rememberExportDownload(runId: string, blob: Blob, filename: string): void {
		this.exportDownloads = {
			...this.exportDownloads,
			[runId]: { blob, filename },
		};
	}

	private forgetExportDownload(runId: string): void {
		const { [runId]: _removedDownload, ...remainingDownloads } = this.exportDownloads;
		this.exportDownloads = remainingDownloads;
	}

	private dispatchStorageQuotaUpdated(projectId: string, storageQuota: api.StorageQuotaSummary): void {
		if (typeof window === "undefined") return;
		window.dispatchEvent(new CustomEvent(STORAGE_QUOTA_UPDATED_EVENT, {
			detail: { projectId, storageQuota },
		}));
	}

	private replaceExportRun(nextRun: ExportRun | undefined, options: { persisted?: boolean } = {}): boolean {
		if (!this.project || !nextRun) return false;
		this.project.exportRuns = normalizeExportRuns((this.project.exportRuns ?? []).map((run) => (
			run.id === nextRun.id ? nextRun : run
		)));
		if (options.persisted) {
			this.adoptRemoteProjectMutation(["exportRuns"]);
		} else {
			this.markCurrentPageUnsaved();
		}
		return true;
	}

	private async persistExportRunAfterConflict(run: ExportRun): Promise<boolean> {
		if (!this.project || !canUseBackendProjectEndpoints(this.project.projectId)) return false;
		const projectId = this.project.projectId;
		const currentPage = this.project.currentPage;
		try {
			const remoteProject = await api.loadProject(projectId);
			// P0-2 (round-3): capture the CAS baseline from the JUST-loaded remote state
			// before mutating, so this full-payload save (it carries `pages`) goes through
			// CAS. `exportRuns` is a remote-owned key stripped by saveProject, so the
			// fingerprint (which already excludes remote-owned keys) is stable across the
			// mutation below; a stale full body is CAS-rejected instead of clobbering newer
			// page edits.
			const exportBaseFingerprint = createProjectStateFingerprint(remoteProject);
			remoteProject.currentPage = currentPage;
			remoteProject.exportRuns = normalizeExportRuns([
				run,
				...(remoteProject.exportRuns ?? []).filter((item) => item.id !== run.id),
			]);
			await api.saveProject(projectId, remoteProject, { baseFingerprint: exportBaseFingerprint });
			this.project = remoteProject;
			this.projectBaseSnapshot = cloneProjectState(remoteProject);
			this.projectBaseFingerprint = createProjectStateFingerprint(remoteProject);
			this.savedPageRevisionId = this.currentPageRevisionId;
			this.lastSavedAt = new Date().toISOString();
			this.saveErrorMessage = null;
			this.saveErrorKind = null;
			this.saveSyncStatus = "saved";
			return true;
		} catch (mergeError) {
			console.warn("[ProjectStore] export run conflict merge failed:", mergeError);
			return false;
		}
	}

	private getExportBaseName(page: Page): string {
		const sourceName = page.originalName || page.imageName || `page_${this.project!.currentPage + 1}`;
		return sourceName.replace(/\.[^.]+$/, "") || `page_${this.project!.currentPage + 1}`;
	}

	private getDataUrlByteLength(dataUrl: string): number {
		const commaIndex = dataUrl.indexOf(",");
		if (commaIndex === -1) return dataUrl.length;
		const metadata = dataUrl.slice(0, commaIndex);
		const payload = dataUrl.slice(commaIndex + 1);
		if (metadata.includes(";base64")) {
			const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
			return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
		}
		try {
			return new Blob([decodeURIComponent(payload)]).size;
		} catch {
			return payload.length;
		}
	}

	private async recordExportRun(input: ExportRunInput): Promise<ExportRun | null> {
		if (!this.project) return null;
		const run = createExportRun(input);
		this.project.exportRuns = normalizeExportRuns([run, ...(this.project.exportRuns ?? [])]);
		const statusBeforePersist = this.statusMsg;
		const statusCodeBeforePersist = this.statusMsgCode;
		try {
			await this.saveState();
		} catch (error) {
			console.warn("[ProjectStore] recordExportRun persist error:", error);
			// REMOTE-REPLACING sink: persistExportRunAfterConflict() loads the remote
			// project and ASSIGNS this.project. Only a 409 remote-drift conflict may
			// trigger that merge — isBackendProjectSaveConflict is deliberately 409-only.
			// A 428 baseline-required fires while local page edits are still UNSAVED, so
			// adopting the remote here would discard the very work the 428 path preserves;
			// it must NOT reach this merge (codex P1, round 3). The 428 instead leaves a
			// conflict status via setSaveFailureStatus() and a local recovery draft.
			const recovered = error instanceof ProjectSaveConflictError || isBackendProjectSaveConflict(error)
				? await this.persistExportRunAfterConflict(run)
				: false;
			// Restore the pre-persist status (text + code) when the recovery succeeded,
			// OR when saveState() left behind a save-failure status — matched by the
			// stable `save_failed` code instead of `.startsWith("บันทึกไม่สำเร็จ")`.
			if (recovered || this.statusMsgCode === "save_failed") {
				this.setStatus(statusBeforePersist, statusCodeBeforePersist);
			}
		}
		return run;
	}

	// Best-effort, IN-SESSION client-ZIP export metering.
	//
	// A successful client-ZIP export builds + downloads the file ENTIRELY in the
	// browser (no server artifact), then records usage via POST /usage/:id/export.
	// That record can transiently fail (network/429/409); previously the failure was
	// fire-and-forget. We keep a retryable marker on the in-memory run so a later
	// reconcile pass (next export, or `reconcilePendingExportMetering`) replays the
	// IDENTICAL, idempotent payload (stable `idempotencyKey`) — a replay that races a
	// previously-succeeded record can never double-charge (the server dedups).
	//
	// IMPORTANT (NOT durable across reload): a client-ZIP run has no server artifact,
	// and `exportRuns` is a SERVER-OWNED collection — `api.saveProject()` strips it and
	// the `/save` route keeps its own copy. So this marker, and its metering payload,
	// CANNOT be persisted from the client; it survives only for the current session.
	// We deliberately do NOT try to round-trip it through `/save` (a no-op that only
	// risks save-conflict churn). For a reload-durable, server-VERIFIED billable path,
	// the SERVER export pipeline (#316) is the trustworthy anchor: it meters real,
	// server-derived artifact bytes with its own durable pending/reconcile mechanism.
	// Client-ZIP bytes are fundamentally unverifiable server-side, so they are metered
	// best-effort only and must never be trusted as an authoritative billable claim.
	private async meterExportRun(runId: string, input: ExportMeteringInput): Promise<void> {
		if (!this.project) return;
		const projectId = this.project.projectId;
		// Bind the record to this run so the server can bill the run's real artifact
		// size (run-scoped accounting) IF/when an artifact is later uploaded.
		const payload: ExportMeteringInput = { ...input, exportRunId: runId };
		// Stash the payload on the in-memory run BEFORE the network call so a transient
		// failure still leaves a replayable in-session marker.
		this.markExportRunMeteringPending(runId, payload);
		try {
			await api.recordExportUsage(projectId, payload);
			this.markExportRunMetered(runId);
		} catch (meteringError) {
			console.warn("[ProjectStore] recordExportUsage failed; left an in-session retryable metering marker:", meteringError);
		}
	}

	private markExportRunMeteringPending(runId: string, input: ExportMeteringInput): void {
		const run = this.exportRuns.find((item) => item.id === runId);
		if (!run) return;
		// In-memory only: the metering marker is a session-scoped, idempotent annotation
		// (`exportRuns` is server-owned and cannot be persisted from the client). Adopt
		// without dirtying the page save-state.
		this.replaceExportRun({
			...run,
			meteringInput: input,
			meteringPending: true,
			meteringRecordedAt: undefined,
		}, { persisted: true });
	}

	private markExportRunMetered(runId: string): void {
		const run = this.exportRuns.find((item) => item.id === runId);
		if (!run) return;
		// Recorded: drop the pending flag + payload, keep a timestamp so reconcile
		// (and a future re-record) skips this run. Non-dirtying (see above).
		this.replaceExportRun({
			...run,
			meteringPending: undefined,
			meteringInput: undefined,
			meteringRecordedAt: new Date().toISOString(),
		}, { persisted: true });
	}

	// Replay every in-session export run whose usage was never recorded. Idempotent:
	// each replay reuses the run's stored `idempotencyKey`, so a record that actually
	// succeeded before (but whose success marker was lost) is deduped server-side.
	// Called opportunistically at the start of each export so a transient failure is
	// self-healing within the session. Markers do NOT survive a reload (see
	// meterExportRun): the server export pipeline (#316) owns reload-durable metering.
	async reconcilePendingExportMetering(): Promise<void> {
		if (!this.project) return;
		const projectId = this.project.projectId;
		const pending = this.exportRuns.filter(isExportRunMeteringPending);
		if (!pending.length) return;
		for (const run of pending) {
			const input = run.meteringInput;
			if (!input) continue;
			// Bail if the project changed under us mid-loop.
			if (!this.project || this.project.projectId !== projectId) return;
			try {
				await api.recordExportUsage(projectId, input);
				this.markExportRunMetered(run.id);
			} catch (error) {
				console.warn("[ProjectStore] reconcile export metering retry failed; keeping in-session marker:", error);
			}
		}
	}

	countChapterCreditLayers(): number {
		if (!this.project) return 0;
		return this.project.pages.reduce((total, page) => (
			total
			+ (page.textLayers ?? []).filter((layer) => layer.sourceCategory === "credit").length
			+ (page.imageLayers ?? []).filter((layer) => layer.role === "credit").length
		), 0);
	}

	private countCreditLayersOnPage(page: Page): number {
		return (page.textLayers ?? []).filter((layer) => layer.sourceCategory === "credit").length
			+ (page.imageLayers ?? []).filter((layer) => layer.role === "credit").length;
	}

	private formatCreditLayerBreakdown(textRemoved: number, imageRemoved: number): string {
		return `ข้อความ ${textRemoved} / รูป ${imageRemoved}`;
	}

	private matchesCreditDeleteTextLayer(layer: TextLayer, kind: CreditDeleteKind, match?: CreditDeleteMatch): boolean {
		if (layer.sourceCategory !== "credit" || kind === "image") return false;
		if (match?.text !== undefined) return layer.text === match.text;
		return true;
	}

	private matchesCreditDeleteImageLayer(layer: ImageLayer, kind: CreditDeleteKind, match?: CreditDeleteMatch): boolean {
		if (layer.role !== "credit" || kind === "text") return false;
		if (match?.imageId !== undefined) return layer.imageId === match.imageId;
		return true;
	}

	private creditDeleteTargetLabel(kind: CreditDeleteKind, match?: CreditDeleteMatch): string {
		if (match?.text !== undefined) return `ข้อความเครดิต "${match.text}"`;
		if (match?.imageId !== undefined) return "รูปเครดิตนี้";
		if (kind === "text") return "ข้อความเครดิต";
		if (kind === "image") return "รูปเครดิต";
		return "เครดิต";
	}

	getBatchExportGate(pageIndexes: number[]): BatchExportGate {
		if (!this.project) return buildBatchExportGate([]);
		const pageCount = this.project.pages.length;
		const validPageIndexes = Array.from(new Set(pageIndexes)).filter((pageIndex) => (
			Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount
		));
		const qcIssues = this.qcReport.issues;
		const summaries = validPageIndexes.map((pageIndex) => summarizePageWork({
			page: this.project!.pages[pageIndex],
			pageIndex,
			assetIntegrity: this.getPageAssetIntegrity(pageIndex),
			qcIssues,
			tasks: this.tasks,
			comments: this.comments,
			aiReviewMarkers: this.aiReviewMarkers,
			reviewDecisions: this.reviewDecisions,
			productionMode: this.project?.productionMode ?? "solo",
		}));
		const gate = buildBatchExportGate(summaries);
		if (validPageIndexes.length > 0 && (this.project.creditPolicy ?? "optional") === "required" && this.countChapterCreditLayers() === 0) {
			const firstPageIndex = validPageIndexes[0] ?? 0;
			return {
				...gate,
				readyCount: 0,
				holdCount: validPageIndexes.length,
				canExport: false,
				readyPageNumbers: [],
				holdPageNumbers: validPageIndexes.map((pageIndex) => pageIndex + 1),
				firstHoldPageIndex: validPageIndexes[0] ?? null,
				firstHoldReason: requiredCreditMissingHoldReason(),
				message: requiredCreditMissingMessage(),
				// Surface the chapter-wide credit hold as a checklist group so the new
				// all-blockers UX shows it alongside any per-page blockers.
				checklist: [
					{
						type: "required_credit_missing" as const,
						count: 1,
						pages: [{
							pageIndex: firstPageIndex,
							pageNumber: firstPageIndex + 1,
							detail: requiredCreditMissingHoldReason(),
							count: 1,
						}],
					},
					...gate.checklist.filter((group) => group.type !== "required_credit_missing"),
				],
			};
		}
		return gate;
	}

	clearBatchExportStatus(): void {
		if (this.isBatchExporting) return;
		this.batchExportStatus = "idle";
		this.batchExportProgress = null;
		this.batchExportMessage = "";
	}

	async exportPage(editor?: any): Promise<void> {
		if (!this.project) return;
		if (this.exportBlockedBySaveConflict) {
			this.statusMsg = "โหลดล่าสุดหรือเก็บสำเนากู้คืนก่อน Export เพื่อไม่ให้ส่งออกจาก state ที่ชนกัน";
			return;
		}
		// Self-heal any export whose usage failed to record on a previous attempt.
		await this.reconcilePendingExportMetering();
		const page = this.project.pages[this.project.currentPage];
		const baseName = this.getExportBaseName(page);
		const pageIndex = this.project.currentPage;

		// Single-page export readiness gate (parity with the batch/ZIP gate). Previously
		// single-page export had NO gate, so a page whose image asset is blocked /
		// quarantined / needs_review / still scanning — or any other unresolved blocker —
		// could be exported one page at a time, bypassing the batch gate. The server is
		// authoritative (the `export`-purpose image serve requires moderation `passed`),
		// but blocking here gives immediate feedback instead of a failed download.
		const gate = this.getBatchExportGate([pageIndex]);
		if (!gate.canExport) {
			this.statusMsg = gate.message || formatSinglePageExportFailureMessage(pageIndex, gate.firstHoldReason || "หน้านี้ยังไม่พร้อม Export");
			return;
		}

		if (editor?.exportMergedImageDataUrl) {
			try {
				if (this.shouldWaitForEditorBrushCommit(editor)) await this.waitForEditorBrushCommit(editor);
				this.syncEditorLayers(editor);
				await this.saveState();
				// SERVER-AUTHORITATIVE export gate (codex P0). The live-editor merged render
				// is composited from the in-memory canvas, so the server can't inspect the
				// rendered bytes — but it CAN refuse to authorize an export of a non-`passed`
				// page image. Probe the export bar by minting an EXPORT-purpose token for the
				// page's source/baked image; a non-`passed` (needs_review/quarantined/blocked/
				// unregistered) asset cannot mint one, so we FAIL CLOSED before delivering.
				// This stops a non-passed current page from being exported via the editor
				// path the same way the persisted-asset path fails closed.
				await this.assertCurrentPageExportAuthorized(page);
				const dataUrl = await editor.exportMergedImageDataUrl();
				const filename = `${baseName}_merged.png`;
				const bytes = this.getDataUrlByteLength(dataUrl);
				const exportProjectId = this.project.projectId;
				// Deliver the export FIRST, then record usage durably (mirrors the batch
				// path): a metering hiccup must never discard a delivered export or be
				// silently dropped.
				this.downloadUrl(dataUrl, filename);
				const message = `Export หน้าเดียวสำเร็จ: ${baseName}`;
				this.statusMsg = message;
				const run = await this.recordExportRun({
						kind: "single-page",
						status: "done",
						targetProfile: DRAFT_INTERNAL_EXPORT_PROFILE.id,
						filename,
						pageIndexes: [pageIndex],
					bytes,
					message,
				});
				if (run) {
					await this.meterExportRun(run.id, {
						bytes,
						pageIndexes: [pageIndex],
						pageCount: 1,
						filename,
						exportKind: "single-page",
						targetProfile: DRAFT_INTERNAL_EXPORT_PROFILE.id,
						idempotencyKey: `export:${exportProjectId}:page:${pageIndex}:${run.id}:${bytes}`,
					});
				}
			} catch (error) {
				console.error("[ProjectStore] exportPage error:", error);
				const message = formatExportFailureDetail(error, "ไม่สามารถ Export หน้านี้ได้");
				const statusMessage = formatSinglePageExportFailureMessage(pageIndex, message);
				const historyError = formatSinglePageExportFailureHistoryError(pageIndex, message);
				this.statusMsg = statusMessage;
					await this.recordExportRun({
						kind: "single-page",
						status: "error",
						targetProfile: DRAFT_INTERNAL_EXPORT_PROFILE.id,
						filename: `${baseName}_merged.png`,
					pageIndexes: [pageIndex],
					message: statusMessage,
					error: historyError,
				});
			}
			return;
		}

		const imageId = page.edits?.imageId || page.imageId;
		const filename = `${baseName}.png`;
		const exportProjectId = this.project.projectId;
		let deliveredBytes: number | undefined;
		try {
			const delivered = await this.downloadPageAsset(imageId, filename);
			deliveredBytes = delivered.bytes;
		} catch (error) {
			console.error("[ProjectStore] exportPage download error:", error);
			const detail = formatExportFailureDetail(error, "ไม่สามารถ Export หน้านี้ได้");
			const statusMessage = formatSinglePageExportFailureMessage(pageIndex, detail);
			const historyError = formatSinglePageExportFailureHistoryError(pageIndex, detail);
			this.statusMsg = statusMessage;
			await this.recordExportRun({
				kind: "single-page",
				status: "error",
				targetProfile: DRAFT_INTERNAL_EXPORT_PROFILE.id,
				filename,
				pageIndexes: [pageIndex],
				message: statusMessage,
				error: historyError,
			});
			return;
		}
		const message = `Export หน้าเดียวสำเร็จ: ${baseName}`;
		this.statusMsg = message;
		// This fallback path used to deliver the asset and record a run but NEVER
		// metered the export — every download through it was free. Meter it durably
		// now (run-scoped pending+retry) so every successful export path bills usage.
		const run = await this.recordExportRun({
				kind: "single-page",
				status: "done",
				targetProfile: DRAFT_INTERNAL_EXPORT_PROFILE.id,
				filename,
			pageIndexes: [pageIndex],
			bytes: deliveredBytes,
			message,
		});
		if (run) {
			// A local fast-path download can't cheaply measure bytes; fall back to the
			// page's known asset size, else a conservative 1-byte floor so the server's
			// per-page ceiling clamps it. The server is authoritative on the real size.
			const bytes = deliveredBytes ?? this.estimatePageExportBytes(page) ?? 1;
			await this.meterExportRun(run.id, {
				bytes,
				pageIndexes: [pageIndex],
				pageCount: 1,
				filename,
				exportKind: "single-page",
				targetProfile: DRAFT_INTERNAL_EXPORT_PROFILE.id,
				idempotencyKey: `export:${exportProjectId}:page:${pageIndex}:${run.id}:${bytes}`,
			});
		}
	}

	// Best-effort byte estimate for a page export when the delivered blob size is
	// unknown (local fast-path). Prefers a known asset record's size. Never used for
	// billing directly — the server clamps/validates — but keeps the metered value
	// plausible instead of a bare 1-byte floor when we do know the asset size.
	private estimatePageExportBytes(page: Page): number | undefined {
		const imageId = page.edits?.imageId || page.imageId;
		if (!imageId) return undefined;
		const asset = this.imageAssets.find((item) => item.imageId === imageId || item.assetId === imageId);
		return asset && Number.isFinite(asset.sizeBytes) && asset.sizeBytes > 0 ? asset.sizeBytes : undefined;
	}

		async exportPageBatch(pageIndexes: number[], editor?: any, exportOptions: { split?: ExportSplitOptions } = {}): Promise<void> {
			if (!this.project || this.isBatchExporting) return;
			// Self-heal any export whose usage failed to record on a previous attempt.
			await this.reconcilePendingExportMetering();
			if (!this.project) return;
			const targetProfile = exportProfileForCreditPolicy(this.project.creditPolicy).id;
			const pageCount = this.project.pages.length;
		const validPageIndexes = Array.from(new Set(pageIndexes)).filter((pageIndex) => (
			Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount
		));

		if (!validPageIndexes.length) {
			this.batchExportStatus = "error";
			this.batchExportProgress = null;
			this.batchExportMessage = "ไม่มีหน้าที่ใช้ Export ได้: เลือกหน้าที่มีอยู่แล้วลอง Export อีกครั้ง";
			this.statusMsg = this.batchExportMessage;
				await this.recordExportRun({
					kind: "batch-zip",
					status: "error",
					targetProfile,
					filename: "batch_export.zip",
				pageIndexes: [],
				message: this.batchExportMessage,
				error: this.batchExportMessage,
			});
			return;
		}

		try {
			this.batchExportStatus = "checking";
			this.batchExportProgress = {
				completed: 0,
				total: validPageIndexes.length,
				pageIndex: validPageIndexes[0],
				pageNumber: validPageIndexes[0] + 1,
				filename: "กำลังเตรียม Export",
				phase: "rendering",
			};
			this.batchExportMessage = `เตรียม Export ${validPageIndexes.length} หน้า...`;
			this.statusMsg = this.batchExportMessage;

			if (editor) {
				if (this.shouldWaitForEditorBrushCommit(editor)) await this.waitForEditorBrushCommit(editor);
				this.syncEditorLayers(editor);
			}
			if (this.hasLocalProjectChanges() || this.hasCurrentProjectPendingAiResultApply()) {
				await this.saveState();
			}

			if (!this.project) {
				throw new Error("งานปิดก่อน Export เสร็จ");
			}
			const gate = this.getBatchExportGate(validPageIndexes);
			if (!gate.canExport) {
				this.batchExportStatus = "error";
				this.batchExportProgress = null;
				this.batchExportMessage = gate.message;
				this.statusMsg = gate.message;
				return;
			}
			this.batchExportStatus = "exporting";
			const result = await exportPagesToZip(this.project, validPageIndexes, {
				imageUrlResolver: (imageId) => this.getImageUrl(imageId),
				// P1-c — publish (public-export) FAILS a page whose bubble-clean mask is
				// missing/unreadable instead of silently shipping the un-cleaned source;
				// draft-internal tolerates it (source-only + flagged in the manifest).
				exportProfile: targetProfile === "public-export" ? "publish" : "draft",
				// Optional webtoon split (by height or piece count; minimums enforced).
				...(exportOptions.split ? { split: exportOptions.split } : {}),
				onProgress: (progress) => {
					this.batchExportProgress = progress;
					// During "packaging" all pages are rendered and the synchronous ZIP
					// assembly is running — show an explicit "packaging…" message instead
					// of a 100% count that then looks frozen while createZipBlob runs.
					this.batchExportMessage = progress.phase === "packaging"
						? `กำลังแพ็กไฟล์ ZIP ${progress.completed}/${progress.total} หน้า…`
						: `กำลัง Export ${progress.completed}/${progress.total}: หน้า ${progress.pageNumber}`;
				},
			});

			// The ZIP is fully built and paid-for work is DONE — deliver the download
			// FIRST. Previously recordExportUsage ran before downloadBlob, so a
			// metering hiccup (429/409/network) threw into the catch and the entire
			// built export was thrown away + reported as a failure. Never discard a
			// completed export over a metering error: hand the file to the user, then
			// record usage durably (run-scoped pending+retry) below.
			this.downloadBlob(result.zipBlob, result.filename);

			const exportProjectId = this.project.projectId;
			// Build the exact, idempotent metering payload. Stable per export run:
			// (exportedAt, byte size) keys the server-side dedup so a retry that races
			// a prior success never double-charges.
			const meteringInput: ExportMeteringInput = {
				bytes: result.zipBlob.size,
				pageIndexes: result.exportedPages.map((page) => page.pageIndex),
				pageCount: result.exportedPages.length,
				filename: result.filename,
				exportKind: "batch-zip",
				targetProfile,
				idempotencyKey: `export:${exportProjectId}:batch:${result.manifest.exportedAt}:${result.zipBlob.size}`,
				metadata: {
					pageNumbers: result.exportedPages.map((page) => page.pageNumber),
				},
			};

			this.batchExportStatus = "done";
			this.batchExportProgress = null;
			const skippedCount = result.skippedPages.length;
			const sourceOnlyCount = result.sourceOnlyPages.length;
			const partialNotes: string[] = [];
			if (skippedCount > 0) {
				partialNotes.push(`ข้าม ${skippedCount} หน้า (${result.skippedPages.map((page) => page.pageNumber).join(", ")})`);
			}
			if (sourceOnlyCount > 0) {
				partialNotes.push(`${sourceOnlyCount} หน้าใช้รูปต้นฉบับ (${result.sourceOnlyPages.map((page) => page.pageNumber).join(", ")})`);
			}
			this.batchExportMessage = partialNotes.length > 0
				? `Export สำเร็จ ${result.exportedPages.length} หน้า — ${partialNotes.join("; ")}: ${result.filename}`
				: `Export สำเร็จ ${result.exportedPages.length} หน้า: ${result.filename}`;
			this.statusMsg = this.batchExportMessage;
				const run = await this.recordExportRun({
					kind: "batch-zip",
					status: "done",
					targetProfile,
					filename: result.filename,
				pageIndexes: result.exportedPages.map((page) => page.pageIndex),
				bytes: result.zipBlob.size,
				message: this.batchExportMessage,
			});
			if (run) {
				this.rememberExportDownload(run.id, result.zipBlob, result.filename);
				try {
					const savedArtifact = await api.uploadExportArtifact(
						this.project.projectId,
						run.id,
						result.filename,
						result.zipBlob,
					);
					const artifactRun = savedArtifact.exportRun ?? {
						...run,
						filename: savedArtifact.artifact.filename || run.filename,
						bytes: savedArtifact.artifact.sizeBytes,
						artifact: savedArtifact.artifact,
						artifactError: undefined,
					};
					const replaced = this.replaceExportRun(artifactRun, { persisted: Boolean(savedArtifact.exportRun) });
					if (replaced && !savedArtifact.exportRun) {
						await this.saveState();
					}
					if (savedArtifact.storageQuota) {
						this.dispatchStorageQuotaUpdated(this.project.projectId, savedArtifact.storageQuota);
					}
				} catch (artifactError) {
					console.warn("[ProjectStore] uploadExportArtifact error:", artifactError);
					const artifactErrorMessage = formatExportArtifactPersistenceError(artifactError);
					const statusMessage = formatExportArtifactPersistenceMessage(this.batchExportMessage, artifactError);
					this.replaceExportRun({ ...run, artifactError: artifactErrorMessage });
					this.statusMsg = statusMessage;
					try {
						await this.saveState();
					} catch (saveError) {
						console.warn("[ProjectStore] persist export artifact error marker failed:", saveError);
					} finally {
						this.statusMsg = statusMessage;
					}
				}
				// Durable metering: record AFTER the artifact-upload replaceExportRun
				// settles so the marker isn't clobbered, and against the persisted run
				// id so a failed record leaves a retryable pending marker on disk.
				await this.meterExportRun(run.id, meteringInput);
			}
		} catch (error) {
			console.error("[ProjectStore] exportPageBatch error:", error);
			const failureProgress = this.batchExportProgress;
			const pageError = error instanceof PageExportError ? error : null;
			const progressFailedPageIndex = failureProgress && failureProgress.completed < validPageIndexes.length
				? validPageIndexes[failureProgress.completed]
				: undefined;
			const failedPageIndex = pageError?.pageIndex ?? progressFailedPageIndex;
			const failedPageNumber = pageError?.pageNumber ?? (failedPageIndex !== undefined ? failedPageIndex + 1 : undefined);
			const message = formatExportFailureDetail(error, "ไม่สามารถ Export หน้าที่เลือกได้", pageError?.pageNumber);
			const historyError = formatBatchExportFailureHistoryError(validPageIndexes, failureProgress, message);
			this.batchExportStatus = "error";
			this.batchExportProgress = null;
			this.batchExportMessage = formatBatchExportFailureMessage(validPageIndexes, failureProgress, message);
			this.statusMsg = this.batchExportMessage;
				await this.recordExportRun({
					kind: "batch-zip",
					status: "error",
					targetProfile,
					filename: "batch_export.zip",
				pageIndexes: validPageIndexes,
				message: this.batchExportMessage,
				error: historyError,
				failedPageIndex,
				failedPageNumber,
			});
		}
	}

	async retryExportRun(runId: string, editor?: any, pageIndexesOverride?: number[]): Promise<void> {
		if (!this.project || !runId) return;
		const run = this.exportRuns.find((item) => item.id === runId);
		if (!run) {
			this.statusMsg = "ไม่พบประวัติ Export นี้";
			return;
		}

		const pageCount = this.project.pages.length;
		const scope = getExportRunPageScope(run, pageCount);
		const retryPageIndexes = Array.isArray(pageIndexesOverride)
			? pageIndexesOverride.filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount)
			: scope.pageIndexes;
		if (!retryPageIndexes.length) {
				this.statusMsg = scope.missingPageIndexes.length
					? "หน้าในประวัติ Export ไม่อยู่ในงานนี้แล้ว"
					: "ประวัติ Export นี้ไม่มีหน้าที่ตรงกับงานนี้";
			return;
		}

		if (run.kind === "batch-zip") {
			const retryEditor = editor && (
				this.saveSyncStatus === "unsaved"
				|| (typeof editor.hasPendingBrushCommit === "function" && editor.hasPendingBrushCommit())
				|| (typeof editor.hasBrushCommitError === "function" && editor.hasBrushCommitError())
			) ? editor : undefined;
			await this.exportPageBatch(retryPageIndexes, retryEditor);
			return;
		}

		const pageIndex = retryPageIndexes[0];
		if (Number.isInteger(pageIndex) && pageIndex !== this.project.currentPage) {
			const pageOpened = await this.goToPage(pageIndex, editor);
			if (!pageOpened) return;
		}
		await this.exportPage(editor);
	}

	async importJson(editor?: any): Promise<void> {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";

		input.onchange = async () => {
			if (!input.files?.[0] || !this.project) return;
			let data: unknown;
			try {
				const text = await input.files[0].text();
				data = JSON.parse(text);
			} catch (error) {
				console.error("[ProjectStore] importJson parse error:", error);
				this.statusMsg = "Importไม่สำเร็จ: ไฟล์ JSON อ่านไม่ได้";
				return;
			}

			if (isLayerImportDocument(data)) {
				try {
					const result = await this.importLayerDocument(data, editor);
					this.statusMsg = result.pageIndex === null
							? `ข้าม ${result.skipped} เลเยอร์ข้อความ: หน้าไม่ตรงกับตอนนี้`
							: `Import ${result.imported} เลเยอร์ข้อความ, ข้าม ${result.skipped}`;
				} catch (error) {
					console.error("[ProjectStore] importLayerDocument error:", error);
					this.statusMsg = this.importSaveFailureStatus(error);
				}
				return;
			}

			const pageIndex = this.project.currentPage;
			const sourceOptions = summarizeJsonImportSources(data);
			const shouldRemap = shouldAskForJsonImportRemap(this.project.pages.length, sourceOptions.length, sourceOptions);
			let payload: TranslationImportPayload | any[] = Array.isArray(data)
				? { entries: data, pageIndex }
				: data as TranslationImportPayload;
			if (shouldRemap) {
				const targetPages = this.project.pages.map((page, index) => ({
					pageIndex: index,
					imageName: page.imageName,
					originalName: page.originalName,
				}));
				const currentPage = this.project.pages[pageIndex];
				const selections = await importRemapStore.open({
					options: sourceOptions,
					projectPageCount: this.project.pages.length,
					targetPageIndex: pageIndex,
					// Locale-neutral fallback name; the dialog localizes the page label.
					targetImageName: currentPage?.originalName || currentPage?.imageName,
					targetLang: this.project.targetLang,
					targetPages,
				});
				if (!selections || !selections.some((selection) => selection.sourceOptionId)) {
					this.statusMsg = "ยกเลิกImport: เลือกต้นทาง JSON อย่างน้อย 1 หน้าเพื่อจับคู่กับตอนนี้";
					return;
				}
				payload = this.project.pages.length === 1
					? buildJsonImportRemapPayload(
						data,
						sourceOptions.find((option) => option.id === selections[0]?.sourceOptionId) ?? sourceOptions[0],
						pageIndex,
					) as TranslationImportPayload
					: buildJsonImportMappingsPayload(data, selections, sourceOptions) as TranslationImportPayload;
			}

			// Tag the import with the ACTIVE Language Track so the backend (and the local
			// fallback) materialize it into `languageOutputs[activeTargetLang]` for a
			// non-default track instead of the shared flat `page.textLayers`. Default /
			// single-language projects resolve to the default lang and stay byte-identical.
			// Arrays are normalized to an object so we can carry the lang field.
			if (Array.isArray(payload)) {
				payload = { entries: payload, lang: this.activeTargetLang };
			} else {
				payload = { ...payload, lang: this.activeTargetLang };
			}

			try {
				if (editor) {
					this.syncEditorLayers(editor);
				}
				if (this.hasLocalProjectChanges()) {
					await this.saveState();
				}
			} catch (error) {
				console.error("[ProjectStore] importJson save guard error:", error);
				this.statusMsg = this.importSaveFailureStatus(error);
				return;
			}

			let result: TranslationImportResult;
			if (canUseLocalDebugProjectFallback(this.project.projectId)) {
				try {
					const currentPageIndex = this.project.currentPage;
					const currentPage = this.project.pages[currentPageIndex];
					// Count layers on the ACTIVE track (not just flat `textLayers`): the import
					// materializes into the active Language Track, so the editor-injection below
					// must diff against that same track to pick up the newly-imported layers.
					const currentPageLayerCount = currentPage
						? trackTextLayers(currentPage, this.activeTargetLang).length
						: 0;
					result = applyLocalTranslationImport(this.project, payload);
					this.appendLocalActivity(createLocalActivity("import_json", `Import ${result.imported} เลเยอร์ข้อความจาก JSON`, {
						pageIndex: this.project.currentPage,
						metadata: {
							imported: result.imported,
							skipped: result.skipped,
							orderMapped: result.orderMapped,
							sourceFiltered: result.sourceFiltered,
							sourceMappings: result.sourceMappings?.length,
						},
					}));
					if (editor && currentPage) {
						for (const layer of trackTextLayers(currentPage, this.activeTargetLang).slice(currentPageLayerCount)) {
							editor.addTextLayer?.(layer);
						}
					}
					if (currentPage && result.imported > 0) {
						this.resetPageQcHandoffForUpstreamChange(currentPage, "pending");
					}
					this.markCurrentPageClean();
				} catch (error) {
					this.statusMsg = this.importApiFailureStatus(error);
					return;
				}
				this.statusMsg = formatTranslationImportStatus(result);
				return;
			}
			try {
				result = await api.importTranslations(this.project.projectId, payload);
			} catch (error) {
				this.statusMsg = this.importApiFailureStatus(error);
				return;
			}
			try {
				this.project = await api.loadProject(this.project.projectId);
				if (editor) {
					await this.loadPage(this.project.currentPage, editor);
				}
				await this.loadVersions();
				await this.loadComments();
				await this.loadAiReviewMarkers();
				await this.loadReviewDecisions();
				await this.loadWorkspaceHub();
			} catch (error) {
				this.statusMsg = this.importRefreshFailureStatus(error);
				return;
			}
			this.statusMsg = formatTranslationImportStatus(result);
		};

		input.click();
	}

	async importLayerDocument(data: unknown, editor?: any) {
		if (!this.project || !isLayerImportDocument(data)) {
			return { imported: 0, skipped: 0, pageIndex: null, layers: [] };
		}

		const result = buildLayerImportResult(this.project, data);
		if (result.pageIndex === null) {
			return result;
		}

		const previousPageIndex = this.project.currentPage;
		const previousLayers = [...(this.project.pages[result.pageIndex].textLayers ?? [])];
		this.project.pages[result.pageIndex].textLayers = result.layers;
		this.resetPageQcHandoffForUpstreamChange(this.project.pages[result.pageIndex], "pending");
		this.project.currentPage = result.pageIndex;
		try {
			await this.saveState();
		} catch (error) {
			this.project.pages[result.pageIndex].textLayers = previousLayers;
			this.project.currentPage = previousPageIndex;
			this.statusMsg = this.importSaveFailureStatus(error);
			throw error;
		}
		if (editor) {
			await this.loadPage(result.pageIndex, editor);
		}
		await this.loadVersions();
		return result;
	}

	async saveTextStylePreset(name: string, layer: TextLayer): Promise<TextStylePreset | null> {
		if (!this.project) return null;

		const trimmedName = name.trim();
		if (!trimmedName) return null;

		const preset = normalizeTextStylePreset({
			id: `preset-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
			name: trimmedName,
			style: buildTextStyleFromLayer(layer),
		});
		if (!preset) return null;

		const customPresets = Array.isArray(this.project.textStylePresets)
			? this.project.textStylePresets.filter((existing) => existing.id !== preset.id)
			: [];
		this.project.textStylePresets = [...customPresets, preset];
		await this.saveState();
		this.statusMsg = `Saved preset: ${preset.name}`;
		return preset;
	}

	addCreditLayer(editor: any, presetId: string, text: string, offset: number, scope: CreditApplyScope = "current", repeatEveryPx = 0): TextLayer | null {
		return this.addCreditTextLayer(editor, {
			presetId,
			text,
			offset,
			scope,
			repeatEveryPx,
		});
	}

	addCreditTextLayer(editor: any, options: CreditTextPlacementOptions): TextLayer | null {
		if (!editor || typeof editor.addTextLayer !== "function") return null;
		const preset = this.creditPresets.find((item) => item.id === options.presetId) ?? this.creditPresets[0];
		if (!preset || !editor.imageWidth || !editor.imageHeight) return null;
		const text = options.text;
		const offset = options.offset;
		const scope = options.scope ?? "current";
		const repeatEveryPx = scope === "chapter-edges" ? 0 : Math.max(0, Math.round(options.repeatEveryPx ?? 0));

		if (!this.project) {
			const existingLayers = editor.getAllTextLayers?.();
			const layers = this.buildCreditTextLayersForPage({
				pageWidth: Math.max(1, Math.round(editor.imageWidth)),
				pageHeight: Math.max(1, Math.round(editor.imageHeight)),
				preset,
				text,
				offset,
				repeatEveryPx,
				startIndex: Array.isArray(existingLayers) ? existingLayers.length : 0,
			});
			const addTextLayer = typeof editor.addTextLayerWithHistory === "function"
				? editor.addTextLayerWithHistory.bind(editor)
				: editor.addTextLayer.bind(editor);
			for (const layer of layers) {
				addTextLayer(layer);
			}
			const selectedLayer = layers.at(-1) ?? null;
			const repeatHint = layers.length > 1 ? ` / ซ้ำ ${layers.length} จุด` : "";
			this.statusMsg = scope === "current"
				? `เพิ่มเครดิตแล้ว: ${preset.name}${repeatHint} - ลากเครดิตบนพื้นที่รูปเพื่อจัดตำแหน่ง`
				: `เพิ่มเครดิตบนหน้านี้แล้ว: เปิดงานก่อนใช้เครดิตทุกหน้า/หัวท้าย`;
			return selectedLayer;
		}

		const currentPageIndex = this.project.currentPage;
		const placementPlans = this.getCreditPlacementPlans(scope, preset);
		const fallbackWidth = Math.max(1, Math.round(editor.imageWidth));
		const fallbackHeight = Math.max(1, Math.round(editor.imageHeight));
		let selectedLayer: TextLayer | null = null;
		let createdLayerCount = 0;

		for (const plan of placementPlans) {
			const page = this.project.pages[plan.pageIndex];
			if (!page) continue;
			const pageTextLayers = page.textLayers ?? [];
			const dimensions = plan.pageIndex === currentPageIndex
				? { width: fallbackWidth, height: fallbackHeight }
				: this.getPageImageDimensions(page, fallbackWidth, fallbackHeight);
			const layers = this.buildCreditTextLayersForPage({
				pageWidth: dimensions.width,
				pageHeight: dimensions.height,
				preset: plan.preset,
				text,
				offset,
				repeatEveryPx,
				startIndex: pageTextLayers.length,
			});
			createdLayerCount += layers.length;

			if (plan.pageIndex === currentPageIndex) {
				if (typeof editor.addTextLayerWithHistory === "function") {
					for (const layer of layers) editor.addTextLayerWithHistory(layer);
				} else {
					for (const layer of layers) editor.addTextLayer(layer);
				}
				const latestTextLayers = editor.getAllTextLayers?.();
				page.textLayers = Array.isArray(latestTextLayers)
					&& layers.every((layer) => latestTextLayers.some((item: TextLayer) => item.id === layer.id))
					? latestTextLayers
					: [...pageTextLayers, ...layers];
				selectedLayer = layers.at(-1) ?? selectedLayer;
			} else {
				page.textLayers = [...pageTextLayers, ...layers];
			}
			this.resetPageQcHandoffForUpstreamChange(page, "pending");
		}

		this.markCurrentPageUnsaved();
		const scopeLabel = scope === "all"
			? "ทุกหน้า"
			: scope === "chapter-edges"
				? "หัวหน้าแรกและท้ายหน้าสุดท้าย"
				: preset.name;
		const placementHint = scope === "current"
			? "ลากเครดิตบนพื้นที่รูปเพื่อจัดตำแหน่ง"
			: "เปิดแต่ละหน้าแล้วลากเครดิตเพื่อจูนตำแหน่ง";
		const repeatHint = repeatEveryPx > 0 && createdLayerCount > placementPlans.length
			? ` / ซ้ำ ${createdLayerCount} จุด`
			: "";
		this.statusMsg = `เพิ่มเครดิตแล้ว: ${scopeLabel}${repeatHint} - ${placementHint}`;
		return selectedLayer;
	}

	deleteCreditLayers(editor: any, allPages = false, kind: CreditDeleteKind = "all", match?: CreditDeleteMatch): number {
		if (!this.project) {
			const textLayers = Array.isArray(editor?.getAllTextLayers?.()) ? editor.getAllTextLayers() as TextLayer[] : [];
			const imageLayers = Array.isArray(editor?.getAllImageLayers?.()) ? editor.getAllImageLayers() as ImageLayer[] : [];
			const textCreditIds = textLayers
				.filter((layer) => this.matchesCreditDeleteTextLayer(layer, kind, match))
				.map((layer) => layer.id);
			const imageCreditIds = imageLayers
				.filter((layer) => this.matchesCreditDeleteImageLayer(layer, kind, match))
				.map((layer) => layer.id);
			for (const layerId of textCreditIds) {
				if (typeof editor?.removeTextLayerWithHistory === "function") {
					editor.removeTextLayerWithHistory(layerId);
				} else {
					editor?.removeTextLayer?.(layerId);
				}
			}
			for (const layerId of imageCreditIds) {
				if (typeof editor?.removeImageLayerWithHistory === "function") {
					editor.removeImageLayerWithHistory(layerId);
				} else {
					editor?.removeImageLayer?.(layerId);
				}
			}
			const removed = textCreditIds.length + imageCreditIds.length;
			if (removed > 0) {
				const scopeHint = allPages
					? " / เปิดงานก่อนลบเครดิตทุกหน้า"
					: "";
				const breakdown = this.formatCreditLayerBreakdown(textCreditIds.length, imageCreditIds.length);
				this.statusMsg = kind === "all" && !match
					? `ลบเครดิตบนหน้านี้แล้ว: ${removed} เลเยอร์ (${breakdown})${scopeHint}`
					: `ลบ${this.creditDeleteTargetLabel(kind, match)}บนหน้านี้แล้ว: ${removed} เลเยอร์ (${breakdown})${scopeHint}`;
			} else {
				if (kind === "all" && !match) {
					this.statusMsg = allPages
						? "เปิดงานก่อนลบเครดิตทุกหน้า"
						: "ไม่มีเครดิตให้ลบบนหน้านี้";
				} else {
					this.statusMsg = `ไม่มี${this.creditDeleteTargetLabel(kind, match)}ให้ลบบนหน้านี้`;
				}
			}
			return removed;
		}
		let removed = 0;
		let textRemoved = 0;
		let imageRemoved = 0;
		let affectedPages = 0;
		const currentPageIndex = this.project.currentPage;
		const targetPageIndexes = allPages
			? this.project.pages.map((_, index) => index)
			: [currentPageIndex];

		// TRACK INTEGRITY: read/write credit TEXT layers through the ACTIVE Language
		// Track. On a non-default track, `page.textLayers` is the DEFAULT (EN) layout —
		// reading/writing it directly would both miss the active track's credits AND
		// overwrite the default track with the active-track-minus-credits set. Credit
		// IMAGE layers stay on the shared flat `page.imageLayers` (image stack is shared
		// across tracks; cleaning/credit raster is not per-language).
		const activeLang = this.activeTargetLang;
		for (const pageIndex of targetPageIndexes) {
			const page = this.project.pages[pageIndex];
			if (!page) continue;
			const trackTexts = trackTextLayers(page, activeLang);
			const textCreditIds = trackTexts
				.filter((layer) => this.matchesCreditDeleteTextLayer(layer, kind, match))
				.map((layer) => layer.id);
			const imageCreditIds = (page.imageLayers ?? [])
				.filter((layer) => this.matchesCreditDeleteImageLayer(layer, kind, match))
				.map((layer) => layer.id);
			const pageRemoved = textCreditIds.length + imageCreditIds.length;
			if (pageRemoved > 0) affectedPages += 1;
			textRemoved += textCreditIds.length;
			imageRemoved += imageCreditIds.length;
			removed += pageRemoved;

			if (pageIndex === currentPageIndex && editor) {
				for (const layerId of textCreditIds) {
					if (typeof editor.removeTextLayerWithHistory === "function") {
						editor.removeTextLayerWithHistory(layerId);
					} else {
						editor.removeTextLayer?.(layerId);
					}
				}
				for (const layerId of imageCreditIds) {
					if (typeof editor.removeImageLayerWithHistory === "function") {
						editor.removeImageLayerWithHistory(layerId);
					} else {
						editor.removeImageLayer?.(layerId);
					}
				}
				const nextTextLayers = (editor.getAllTextLayers?.() as TextLayer[] | undefined)
					?? trackTexts.filter((layer) => !textCreditIds.includes(layer.id));
				this.writeActiveTrackTextLayers(page, nextTextLayers);
				page.imageLayers = editor.getAllImageLayers?.() ?? (page.imageLayers ?? []).filter((layer) => !imageCreditIds.includes(layer.id));
			} else {
				this.writeActiveTrackTextLayers(page, trackTexts.filter((layer) => !textCreditIds.includes(layer.id)));
				page.imageLayers = (page.imageLayers ?? []).filter((layer) => !imageCreditIds.includes(layer.id));
			}
			if (pageRemoved > 0) {
				this.resetPageQcHandoffForUpstreamChange(page, "pending");
			}
		}

		if (removed > 0) {
			this.markCurrentPageUnsaved();
			const breakdown = this.formatCreditLayerBreakdown(textRemoved, imageRemoved);
			if (kind !== "all" || match) {
				const targetLabel = this.creditDeleteTargetLabel(kind, match);
				this.statusMsg = allPages
					? `ลบ${targetLabel}จากทุกหน้าแล้ว: ${removed} เลเยอร์จาก ${affectedPages} หน้า (${breakdown})`
					: `ลบ${targetLabel}ในหน้า ${currentPageIndex + 1} แล้ว: ${removed} เลเยอร์ (${breakdown})`;
			} else if (allPages) {
				this.statusMsg = `ลบเครดิตทุกหน้าแล้ว: ${removed} เลเยอร์จาก ${affectedPages} หน้า (${breakdown}) / ตอนนี้ไม่มีเครดิตเหลือในตอน`;
			} else {
				const otherPageCredits = this.project.pages.reduce((total, page, pageIndex) => (
					pageIndex === currentPageIndex ? total : total + this.countCreditLayersOnPage(page)
				), 0);
				const otherPageHint = otherPageCredits > 0
					? ` / เครดิตหน้าอื่นยังอยู่ ${otherPageCredits} เลเยอร์`
					: " / ตอนนี้ไม่มีเครดิตหน้าอื่น";
				this.statusMsg = `ลบเครดิตหน้า ${currentPageIndex + 1} แล้ว: ${removed} เลเยอร์ (${breakdown})${otherPageHint}`;
			}
		} else {
			if (kind !== "all" || match) {
				const targetLabel = this.creditDeleteTargetLabel(kind, match);
				this.statusMsg = allPages
					? `ไม่มี${targetLabel}ให้ลบในทั้งตอน`
					: `ไม่มี${targetLabel}ให้ลบในหน้า ${currentPageIndex + 1}`;
			} else if (allPages) {
				this.statusMsg = "ไม่มีเครดิตให้ลบในทั้งตอน";
			} else {
				const otherPageCredits = this.project.pages.reduce((total, page, pageIndex) => (
					pageIndex === currentPageIndex ? total : total + this.countCreditLayersOnPage(page)
				), 0);
				const otherPageHint = otherPageCredits > 0
					? ` / เครดิตหน้าอื่นยังอยู่ ${otherPageCredits} เลเยอร์`
					: "";
				this.statusMsg = `ไม่มีเครดิตให้ลบในหน้า ${currentPageIndex + 1}${otherPageHint}`;
			}
		}
		return removed;
	}

	async saveCreditPreset(input: {
		name: string;
		text: string;
		placement: CreditPlacement;
		offset: number;
		style?: CreditPreset["style"];
	}): Promise<CreditPreset | null> {
		if (!this.project) return null;

		const preset = normalizeCreditPreset({
			id: `credit-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
			name: input.name,
			text: input.text,
			placement: input.placement,
			offset: input.offset,
			style: input.style,
		});
		if (!preset) return null;

		const customPresets = Array.isArray(this.project.creditPresets)
			? this.project.creditPresets.filter((existing) => existing.id !== preset.id)
			: [];
		this.project.creditPresets = [...customPresets, preset];
		await this.saveState();
		this.statusMsg = `บันทึก Credit preset แล้ว: ${preset.name}`;
		return preset;
	}

	async applyAiResult(resultImageId: string, editor: any, pageIndex = this.project?.currentPage ?? 0): Promise<void> {
		if (!this.project) return;
		const page = this.project.pages[pageIndex];
		if (!page) throw new Error(`ไม่พบหน้า ${pageIndex + 1}`);

		const imageWidth = Math.max(1, Math.round(editor?.imageWidth ?? 1024));
		const imageHeight = Math.max(1, Math.round(editor?.imageHeight ?? 1024));
		const existingLayer = page.imageLayers?.find((layer) => layer.imageId === resultImageId);
		if (existingLayer) {
			if (pageIndex === this.project.currentPage) {
				editor?.selectImageLayer?.(existingLayer.id);
			}
			this.statusMsg = `เลือกเลเยอร์ผล AI หน้า ${pageIndex + 1} แล้ว`;
			return;
		}

		const layer: ImageLayer = {
			id: `ai-result-legacy-${pageIndex + 1}-${Date.now().toString(36)}`,
			imageId: resultImageId,
			imageName: resultImageId,
			originalName: `ผล AI หน้า ${pageIndex + 1}`,
			x: 0,
			y: 0,
			w: imageWidth,
			h: imageHeight,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: editor?.getAllImageLayers?.().length ?? page.imageLayers?.length ?? 0,
			role: "overlay",
		};

		let addedLayer = layer;
		if (pageIndex === this.project.currentPage && editor) {
			const addImageLayer = typeof editor.addImageLayerWithHistory === "function"
				? editor.addImageLayerWithHistory.bind(editor)
				: editor.addImageLayer?.bind(editor);
			if (!addImageLayer) {
				this.statusMsg = "ตัวแก้หน้ายังเพิ่มเลเยอร์ผล AI ไม่ได้";
				return;
			}
			addedLayer = await addImageLayer(layer, this.getImageUrl(resultImageId)) ?? layer;
			page.imageLayers = editor.getAllImageLayers?.() ?? [...(page.imageLayers ?? []), addedLayer];
			editor.selectImageLayer?.(addedLayer.id);
		} else {
			page.imageLayers = [...(page.imageLayers ?? []), addedLayer];
		}

		this.resetPageQcHandoffForUpstreamChange(page, "pending");
		this.markCurrentPageUnsaved();
		this.statusMsg = `วางผล AI เป็นเลเยอร์หน้า ${pageIndex + 1} แล้ว`;
	}

	// ── Testing Utilities ─────────────────────────────────────
	// Reset state for testing purposes
	__resetForTesting() {
		this.cancelAutosave();
		this.autosaveInFlight = false;
		this.autosaveInFlightPromise = null;
		this.saveInFlightPromise = null;
		this.supersededEditImageIds.clear();
		this.reconcilingSupersededEditImages = false;
		this.pageSetChangedRealtimeUnsub?.();
		this.pageSetChangedRealtimeUnsub = null;
		this.pageSetChangedNotice = null;
		void this.wirePageSetChangedRealtime();
		this.project = null;
		this.setStatus("เปิดโฟลเดอร์เพื่อเริ่มงาน", "open_folder_to_start");
		this.targetLang = config.defaultLang;
		this.saveSyncStatus = "saved";
		this.saveErrorMessage = null;
		this.saveErrorKind = null;
		this.lastSavedAt = null;
		this.savedPageRevisionId = null;
		this.batchExportStatus = "idle";
		this.batchExportProgress = null;
		this.batchExportMessage = "";
		this.chapterUploadProgress = null;
		this.dirtyVersion = 0;
		this.saveStartedDirtyVersion = 0;
		this.isLoadingPage = false;
		this.pageLoadInFlightKey = null;
		this.pageLoadInFlightEditor = null;
		this.pageLoadInFlightPromise = null;
		this.projectOpenGeneration = 0;
		this.projectBaseFingerprint = null;
		this.projectBaseSnapshot = null;
		this.versions = [];
		this.versionsLoading = false;
		this.versionDetail = null;
		this.versionDetailLoading = false;
		this.versionReviewLoading = false;
		this.recentProjects = [];
		this.recentProjectsLoading = false;
		this.recentProjectsError = null;
		this.tasks = [];
		this.activityLog = [];
		this.workflowLoading = false;
		this.comments = [];
		this.commentsLoading = false;
		this.reviewDecisions = [];
		this.reviewDecisionsLoading = false;
		this.aiReviewMarkers = [];
		this.aiReviewMarkersLoading = false;
		this.createAiReviewMarkerInFlight = 0;
		this.pendingAiResultApplyMarkers.clear();
		this.assetLoadErrors = {};
		this.clearImageAssets();
		this.clearLocalImageUrls();
		this.imageAssetsLoading = false;
		this.currentWorkspaceMember = null;
		this.currentWorkspaceMemberLoading = false;
		this.exportDownloads = {};
		this.clearSelectedWorkItems();
	}

	// Await any in-flight debounced autosave (test-only accessor for the private guard).
	__waitForAutosaveInFlightForTesting(): Promise<void> {
		return this.waitForAutosaveInFlight();
	}

	// Whether the single-flight save gate currently holds an in-flight save (test-only).
	__hasSaveInFlightForTesting(): boolean {
		return this.saveInFlightPromise !== null;
	}

	// The current conflict-guard baseline fingerprint (test-only). Lets a test assert
	// that a stale in-flight save's committed snapshot did NOT overwrite the fresh
	// baseline seeded by a same-id reload.
	__getBaseFingerprintForTesting(): string | null {
		return this.projectBaseFingerprint;
	}

	// Set project state directly for testing
	__setProjectForTesting(project: ProjectState | null) {
		this.project = project;
		this.clearPageSetChangedNotice();
		if (project) {
			applySourceLangDefault(project);
			this.syncActiveTrackFromProject(project);
		}
		this.tasks = project?.tasks ?? [];
		this.activityLog = project?.activityLog ?? [];
		this.comments = project?.comments ?? [];
		this.reviewDecisions = project?.reviewDecisions ?? [];
		this.aiReviewMarkers = project?.aiReviewMarkers ?? [];
		this.pendingAiResultApplyMarkers.clear();
		this.assetLoadErrors = {};
		this.clearImageAssets();
		this.clearLocalImageUrls();
		this.markCurrentPageClean();
		this.clearSelectedWorkItems();
	}

	__markCurrentPageCleanForTesting() {
		this.markCurrentPageClean();
	}
}

export const projectStore = new ProjectStore();
void projectStore.wirePageSetChangedRealtime();
