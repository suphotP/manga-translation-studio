// Routes: Project CRUD + state management + import
// Path traversal protection, input validation, ownership checks

import { getSharedBunSql } from "../services/sql-pool.js";
import { Hono } from "hono";
import { z } from "zod/v4";
import { Buffer } from "buffer";
import { PROJECTS_DIR, serverConfig } from "../config.js";
// Wave 0 W0.1: log + count every legacy anonymous-project access so the hatch
// can be phased out. Warnings are deduped per-project per-process to avoid log
// flood; the metric tally is unconditional.
const legacyAnonymousAccessWarned = new Set<string>();
let legacyAnonymousProjectAccessTotal = 0;
export function getLegacyAnonymousProjectAccessTotalForTests(): number {
	return legacyAnonymousProjectAccessTotal;
}
export function resetLegacyAnonymousProjectAccessTrackingForTests(): void {
	legacyAnonymousAccessWarned.clear();
	legacyAnonymousProjectAccessTotal = 0;
}
// Test-only seam: lets the export-artifact atomicity tests force a state-commit
// failure AFTER the object has been written/deleted, so we can prove the
// compensating delete (upload) and state-first tombstone (delete) keep storage
// and the run reference consistent on partial failure. Production never sets it.
let exportArtifactStateWriteFailureForTests: (() => void) | null = null;
export function setExportArtifactStateWriteFailureForTests(hook: (() => void) | null): void {
	exportArtifactStateWriteFailureForTests = hook;
}

// Test-only seam: forces the POST-COMMIT version snapshot (createProjectVersion)
// in the export-artifact upload route to throw AFTER the state commit has durably
// referenced the new object. Asserts the committed artifact is NEVER compensating-
// deleted on a post-commit failure. Production never sets it.
let exportArtifactVersionSnapshotFailureForTests: (() => void) | null = null;
export function setExportArtifactVersionSnapshotFailureForTests(hook: (() => void) | null): void {
	exportArtifactVersionSnapshotFailureForTests = hook;
}

// Test-only seam: forces writeProjectState()'s CATALOG sync to throw AFTER the
// durable state.json file write has already succeeded — i.e. the file already
// references the artifact, only the (best-effort) catalog mirror failed. Asserts
// the export-artifact upload still treats the artifact as committed (no
// compensating delete) because a durable store already references it. Production
// never sets it.
let exportArtifactCatalogSyncFailureForTests: (() => void) | null = null;
export function setExportArtifactCatalogSyncFailureForTests(hook: (() => void) | null): void {
	exportArtifactCatalogSyncFailureForTests = hook;
}

// Test-only seam: makes the versioned-replacement object id deterministic so the
// atomicity tests can assert on the exact new/old export object ids. Production
// uses a random unique suffix (see uniqueExportObjectSuffix). Set to a function
// that returns the suffix to use for the NEXT replacement upload.
let exportObjectSuffixForTests: (() => string) | null = null;
export function setExportObjectSuffixForTests(hook: (() => string) | null): void {
	exportObjectSuffixForTests = hook;
}

// Test-only seam: forces the NEW version's durable catalog commit
// (recordProjectVersion) inside createProjectVersion to throw — simulating a
// failure mid-commit. Asserts that the retention prune runs AFTER this durable
// commit, so a failed new-version commit NEVER deletes existing history with no
// replacement recorded (the prune is reached only once the new version is durable).
// Production never sets it.
let projectVersionRecordFailureForTests: (() => void) | null = null;
export function setProjectVersionRecordFailureForTests(hook: (() => void) | null): void {
	projectVersionRecordFailureForTests = hook;
}
function uniqueExportObjectSuffix(): string {
	if (exportObjectSuffixForTests) return exportObjectSuffixForTests();
	return randomUUID().replace(/-/g, "").slice(0, 12);
}
function warnLegacyAnonymousProjectAccess(projectId: string | undefined): void {
	legacyAnonymousProjectAccessTotal += 1;
	const key = projectId || "<unknown>";
	if (legacyAnonymousAccessWarned.has(key)) return;
	legacyAnonymousAccessWarned.add(key);
	console.warn(
		`[security] legacy anonymous project access (projectId=${key}). `
		+ "ALLOW_LEGACY_ANONYMOUS_PROJECTS=true is enabled. This path will be "
		+ "removed once existing prototype projects are migrated to a workspace/user.",
	);
}
function allowsLegacyAnonymousProjectAccess(): boolean {
	return !serverConfig.apiAuthRequired && serverConfig.allowLegacyAnonymousProjects;
}
import { readJsonFile } from "../utils/json-file.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { projectStateSaveSchema, validateImportEntry, MAX_SAVE_BODY_BYTES } from "../schemas/project-state.js";
import { safePath, isValidProjectId, isValidImageId, sanitizeFilename, isProjectTombstonedIn, PROJECT_TOMBSTONES_DIR_NAME } from "../utils/security.js";
import { objectStorage } from "../services/storage.js";
import {
	assertEgressNotThrottledOrResponse,
	recordEgressWithAllowanceOrResponse,
	releaseEgressReservationBestEffort,
	reserveEgressForReadOrResponse,
} from "../services/egress-guard.js";
import {
	StorageQuotaExceededError,
	releaseProjectStorageQuotaReservationBestEffort,
	reserveProjectStorageQuota,
	summarizeProjectStorageQuotaForProjectView,
	type StorageQuotaReservation,
} from "../services/storage-quota.js";
import { getSharedStorageCowService } from "../services/storage-cow.js";
import { ProjectSummaryCache } from "../services/project-summary-cache.js";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "fs";
import { v4 as uuid } from "uuid";
import { createHash, randomUUID } from "crypto";
import type { AiReviewMarker, AiReviewMarkerStatus, ExportArtifact, PageReviewDecisionStatus, PageState, ProjectComment, ProjectCommentStatus, ProjectState, ReviewAssignment, RevisionRequest, TextLayerData, TextLayerSourceCategory, VersionReviewStatus, WorkflowTask, WorkflowTaskPriority, WorkflowTaskStatus, WorkflowTaskType } from "../types/index.js";
import { optionalAuth, getAuthUser } from "../middleware/auth.middleware.js";
import { workLockStore as defaultWorkLockStore, type WorkLockStore } from "../services/work-locks.js";
// Mutable binding (not a direct const re-export) so tests can inject an
// InMemoryWorkLockStore — the production singleton is null without DATABASE_URL, which
// would otherwise make the lease-guard paths untestable off Postgres. Defaults to the
// real singleton; `__setWorkLockStoreForTesting` swaps it.
let workLockStore: WorkLockStore | null = defaultWorkLockStore;
export function __setWorkLockStoreForTesting(store: WorkLockStore | null): void {
	workLockStore = store;
}
import type { JWTPayload } from "../types/auth.js";
import { hasPermission } from "../types/auth.js";
import { loadUser } from "../services/auth.service.js";
import { WORKFLOW_TASK_TYPES, appendActivity, createActivity, ensureProjectWorkflow, ensureProjectWorkflowChanged, maxWorkflowTaskPriority, normalizeWorkflowTaskPriority, taskIdFor } from "../services/workflow.js";
import { applyPageReorderToServerOwnedCollections, derivePageReorderPlan } from "../services/page-reorder.js";
import { AiJobSubmissionError, submitAiJob } from "../services/ai-job-submission.js";
import { runWithLedgerActor } from "../services/usage-ledger.js";
import { resolveLedgerActorUserId } from "./ai.js";
import { jobQueue } from "../services/queue.js";
import { MAX_PROJECT_COMMENTS, createProjectComment, extractProjectCommentMentions, normalizeProjectComments, normalizeProjectCommentsChanged, resolveCommentMentions, type MentionCandidate } from "../services/comments.js";
import { emitCommentNewEvent, emitActivityFeedEvent, emitWorkflowTransitionEvent, seedWorkspaceLookupForTesting } from "../services/realtime-emitters.js";
import { publishPageSetChangedEvent, publishRealtimeEvent } from "../services/realtime-bus.js";
import { notify } from "../services/notification-dispatch.js";
import { authUserStore } from "../services/auth-users.js";
import {
	ChapterTeamError,
	MAX_CHAPTER_TEAM_MEMBERS,
	acceptChapterTeamInvite,
	buildChapterTeamMember,
	chapterTeamInviteSchema,
	chapterTeamPatchSchema,
	getChapterTeam,
	getProductionMode,
	isActiveChapterTeamMember,
	resolveTeamMember,
	type ChapterTeamInviteInput,
} from "../services/chapter-team.js";
import {
	derivePendingInviteEntries,
	pendingInviteIndexStore,
	MAX_PENDING_INVITES_PER_EMAIL,
} from "../services/pending-invite-index.js";
import type { ChapterTeamMember } from "../types/index.js";
import { MAX_PAGE_REVIEW_DECISIONS, createPageReviewDecision, normalizeProjectReviewDecisions, normalizeProjectReviewDecisionsChanged } from "../services/review-decisions.js";
import {
	MAX_REVIEW_ASSIGNMENTS,
	cancelReviewAssignment,
	createReviewAssignment,
	describeReviewAssignmentScope,
	normalizeReviewAssignments,
	resolveReviewAssignmentScope,
	updateReviewAssignment,
} from "../services/review-assignments.js";
import {
	MAX_REVISION_REQUESTS,
	createRevisionRequest,
	describeRevisionScope,
	nextRevisionNumber,
	normalizeRevisionRequests,
	resolveRevisionScope,
	updateRevisionRequest,
} from "../services/revision-requests.js";
import { MAX_WORKSPACE_MESSAGES, buildWorkspaceFeed, createWorkspaceMessage, normalizeWorkspaceMessages, normalizeWorkspaceMessagesChanged } from "../services/workspace-hub.js";
import { MAX_VERSION_REVIEW_REQUESTS, createVersionReviewRequest, isSelfReviewDecision, normalizeVersionReviewRequests, normalizeVersionReviewRequestsChanged, updateVersionReviewRequest } from "../services/version-reviews.js";
import { formatAssigneeHandle, normalizeAssigneeHandle } from "../services/assignees.js";
import { applySelectiveRestore, computeVersionDiff } from "../services/version-diff.js";
import { collectEditLayerAssetIds } from "../services/edit-layer-assets.js";
import {
	InvalidProjectPageCursorError,
	InvalidProjectCommentCursorError,
	InvalidProjectReviewDecisionCursorError,
	InvalidProjectSummaryCursorError,
	InvalidProjectTaskCursorError,
	InvalidProjectVersionCursorError,
	mergeProjectPageSummaries,
	mergeProjectVersions,
	mergeProjectSummaries,
	normalizeTargetLangs,
	paginateProjectSummaries,
	paginateProjectPages,
	paginateProjectTasks,
	paginateProjectComments,
	paginateProjectReviewDecisions,
	paginateProjectVersions,
	projectCatalogStore,
	isProjectAccessFullyDenied,
	isMutatingProjectPermission,
	resolveProjectDefaultLang,
	summarizeProjectPages,
	type ProjectCatalogStore,
	type ProjectSummary,
	type ProjectSummaryPage,
	type StoryIdOwnership,
	type ProjectVersionMetadata,
	type ProjectVersionPage,
	type ProjectVersionRecord,
} from "../services/project-catalog.js";
import {
	WorkspaceAccessError,
	workspaceAccessStore,
	workspaceScopeCovers,
	workspaceScopeAllowsNewProject,
	isFineGrainedScope,
} from "../services/workspace-access.js";
import type { WorkspaceScopeCheck } from "../services/workspace-access.js";
import {
	MAX_AI_REVIEW_MARKERS,
	createAiReviewMarker,
	linkAiReviewMarkerComment,
	linkAiReviewMarkerTask,
	normalizeAiReviewMarkers,
	normalizeAiReviewMarkersChanged,
	reconcileProcessingAiReviewMarkers,
	updateAiReviewMarker,
} from "../services/ai-review-markers.js";
import { readJsonBody } from "../utils/request-body.js";

const project = new Hono();
// Optional authentication - works without token for prototype
project.use("*", optionalAuth);
class ProjectStateStoreUnavailableError extends Error {
	readonly projectId: string;
	override readonly cause: unknown;

	constructor(projectId: string, cause: unknown) {
		super("Project state store unavailable");
		this.name = "ProjectStateStoreUnavailableError";
		this.projectId = projectId;
		this.cause = cause;
	}
}

project.onError((error, c) => {
	if (error instanceof ProjectStateStoreUnavailableError) {
		console.error("Project state store unavailable", { projectId: error.projectId, error: error.cause });
		return c.json({
			error: "Project state store unavailable",
			code: "project_state_store_unavailable",
		}, 503);
	}
	throw error;
});
const EXPORT_RUN_ID_RE = /^export-[a-z0-9._-]{1,180}$/i;
const EPHEMERAL_PROJECT_FINGERPRINT_KEYS = new Set(["currentPage", "userId"]);

// Server-owned sub-collections that are mutated through dedicated endpoints
// (workflow/comments/ai-markers/review-decisions/workspace-feed/exports), NOT the
// general save path. The frontend hydrates these into its in-memory project via
// separate loads after opening a project, so its conflict-guard baseline differs
// from both the `GET /project/:id` refetch and the on-disk state fingerprinted
// here on save. Including them produced a FALSE `project_save_conflict` on the
// first save of a freshly-created chapter. Excluding them keeps the genuine
// stale-overwrite protection intact (real page/layer/text/metadata changes are
// still fingerprinted) while the dedicated endpoints continue to own concurrency
// for these collections.
//
// MUST stay byte-identical to the frontend `REMOTE_OWNED_PROJECT_KEYS` in
// `frontend/src/lib/project/project-state-fingerprint.ts`, since the frontend
// sends this fingerprint in the `X-Project-Base-Fingerprint` header.
const REMOTE_OWNED_PROJECT_FINGERPRINT_KEYS = new Set([
	"tasks",
	"activityLog",
	"comments",
	"aiReviewMarkers",
	"reviewDecisions",
	"reviewAssignments",
	"revisionRequests",
	"workspaceMessages",
	"versionReviewRequests",
	"exportRuns",
]);

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

function normalizeProjectStateForFingerprint(value: unknown, parentKey = ""): JsonLike {
	if (value === null || value === undefined) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((item) => normalizeProjectStateForFingerprint(item));
	if (typeof value !== "object") return null;

	const normalized: Record<string, JsonLike> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		if (parentKey === "" && (EPHEMERAL_PROJECT_FINGERPRINT_KEYS.has(key) || REMOTE_OWNED_PROJECT_FINGERPRINT_KEYS.has(key))) continue;
		normalized[key] = normalizeProjectStateForFingerprint((value as Record<string, unknown>)[key], key);
	}
	return normalized;
}

function hashProjectFingerprintString(input: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function createProjectStateFingerprint(projectState: ProjectState): string {
	return hashProjectFingerprintString(JSON.stringify(normalizeProjectStateForFingerprint(projectState)));
}

// ── Validation Schemas ───────────────────────────────────────

// Stable, URL-safe, dash-free story identifier. Stories used to be keyed by a
// title-derived slug, which collided on duplicate titles and broke on rename.
// A new story now gets a short random base36 id (no '-') so it stays stable
// across renames and never collides. The id is dash-free on purpose: the
// library URL is `/library/<storyId>-<slug>` and the parser splits on the FIRST
// '-', so the leading dash-free token is always the id and the rest is the
// cosmetic slug. Existing slug-based ids keep working via parser back-compat.
const STORY_ID_LENGTH = 10;
function generateStableStoryId(): string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
	let id = "";
	for (let index = 0; index < STORY_ID_LENGTH; index += 1) {
		id += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return id;
}

const createProjectSchema = z.object({
	name: z.string().min(1).max(200).default("Untitled"),
	lang: z.string().min(1).max(10).default("th"),
	targetLangs: z.array(z.string().trim().min(1).max(10)).min(1).max(20).optional(),
	sourceLang: z.string().trim().min(1).max(10).default("ja"),
	workspaceId: z.string().trim().min(1).max(200).optional(),
	storyId: z.string().trim().min(1).max(120).optional(),
	storyTitle: z.string().trim().min(1).max(200).optional(),
	chapterNumber: z.string().trim().max(40).optional(),
	chapterTitle: z.string().trim().max(200).optional(),
	chapterLabel: z.string().trim().max(220).optional(),
	readingDirection: z.enum(["rtl", "ltr", "vertical"]).optional(),
	// Chapter-level Team/Solo selection + invite-at-creation. Absent ⇒ Solo /
	// owner-only (migration-safe default). `initialInvites` are added to the new
	// chapter's roster (UID resolved to an active user; email → pending invite) and
	// notified through the existing invite path. Errors per-invite are non-fatal:
	// the chapter is still created and the failures are returned for the UI to show.
	productionMode: z.enum(["solo", "team"]).optional(),
	initialInvites: z.array(chapterTeamInviteSchema).max(MAX_CHAPTER_TEAM_MEMBERS).optional(),
});

const projectLanguageSchema = z.object({
	language: z.string().trim().min(1).max(10),
}).strict();

// Story-level metadata edit. Today only the story TITLE is genuinely story-level
// and editable here: reading direction is per-chapter and the per-language
// targetLangs/activeTargetLang are managed by the dedicated /languages routes.
// `storyId` is intentionally NOT accepted — it is the stable key (#244) and never
// changes on rename.
const updateStorySchema = z.object({
	storyTitle: z.string().trim().min(1).max(200),
}).strict();

// Server-side confirmation for the irreversible project/story DELETE. The client
// must echo the exact story title it typed in the type-to-confirm dialog; the
// server re-validates it against the project's own title BEFORE deleting, so an
// empty/blind DELETE (auth alone) can never destroy a story.
const projectDeleteSchema = z.object({
	confirmStoryTitle: z.string().min(1).max(200),
}).strict();

const projectListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(500).optional(),
	cursor: z.string().trim().min(1).max(500).optional(),
	includeFileFallback: z.enum(["true", "false"]).optional(),
	// Cross-workspace isolation (P1): when the Library/dashboard is loaded for one
	// workspace it passes that workspace id so the listing is BOUNDED to that
	// workspace AT THE SOURCE (catalog SQL/file filter), never merging story
	// shelves from the caller's OTHER workspaces. Membership is enforced in the
	// handler (a workspaceId the caller is not a member of is rejected). Omitted by
	// legacy/personal callers → unchanged user-ownership listing (back-compat).
	workspaceId: z.string().trim().min(1).max(200).optional(),
}).strict();

const projectPageListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(500).optional(),
	cursor: z.string().trim().min(1).max(500).optional(),
	status: z.enum(["draft", "needs_translation", "translated", "needs_clean", "cleaned", "review_ready", "needs_fix"]).optional(),
	pageIndex: z.coerce.number().int().min(0).optional(),
}).strict();

const projectTaskListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(500).optional(),
	cursor: z.string().trim().min(1).max(500).optional(),
	status: z.enum(["todo", "doing", "review", "done"]).optional(),
	type: z.enum(["translate", "clean", "typeset", "review"]).optional(),
	assignee: z.string().trim().min(1).max(120).optional(),
	pageIndex: z.coerce.number().int().min(0).optional(),
}).strict();

const projectCommentListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_PROJECT_COMMENTS).optional(),
	cursor: z.string().trim().min(1).max(500).optional(),
	status: z.enum(["open", "resolved"]).optional(),
	pageIndex: z.coerce.number().int().min(0).optional(),
	layerId: z.string().trim().min(1).max(160).optional(),
	author: z.string().trim().min(1).max(120).optional(),
}).strict();

const projectReviewDecisionListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_PAGE_REVIEW_DECISIONS).optional(),
	cursor: z.string().trim().min(1).max(500).optional(),
	status: z.enum(["approved", "changes_requested"]).optional(),
	pageIndex: z.coerce.number().int().min(0).optional(),
	actor: z.string().trim().min(1).max(120).optional(),
}).strict();

const importJsonMappingSchema = z.object({
	targetPageIndex: z.number().int().min(0),
	sourcePageIndex: z.number().int().min(0).optional(),
	sourcePageNumber: z.number().int().min(1).optional(),
	sourceImagePath: z.string().min(1).max(1000).optional(),
	sourceImageName: z.string().min(1).max(1000).optional(),
	sourceFileName: z.string().min(1).max(1000).optional(),
}).refine((value) => (
	value.sourcePageIndex !== undefined ||
	value.sourcePageNumber !== undefined ||
	value.sourceImagePath !== undefined ||
	value.sourceImageName !== undefined ||
	value.sourceFileName !== undefined
), {
	message: "Expected source page or image identifier",
});

const importJsonSchema = z.object({
	version: z.number().int().optional(),
	// Target Language Track the import materializes into (Stream C). Omitted /
	// default-lang imports write the flat `page.textLayers` (byte-identical for
	// single-language projects); a non-default lang writes `languageOutputs[lang]`.
	lang: z.string().trim().min(1).max(40).optional(),
	pageIndex: z.number().int().min(0).optional(),
	targetPageIndex: z.number().int().min(0).optional(),
	sourcePageIndex: z.number().int().min(0).optional(),
	sourcePageNumber: z.number().int().min(1).optional(),
	sourcePage: z.number().int().min(1).optional(),
	sourceImagePath: z.string().min(1).max(1000).optional(),
	sourceImageName: z.string().min(1).max(1000).optional(),
	sourceFileName: z.string().min(1).max(1000).optional(),
	image_path: z.string().min(1).max(1000).optional(),
	entries: z.array(z.unknown()).max(1000).optional(),
	items: z.array(z.unknown()).max(1000).optional(),
	mappings: z.array(importJsonMappingSchema).max(500).optional(),
}).refine((value) => Array.isArray(value.entries) || Array.isArray(value.items), {
	message: "Expected entries or items",
});

const taskUpdateSchema = z.object({
	status: z.enum(["todo", "doing", "review", "done"]).optional(),
	assignee: z.union([z.string().trim().max(120), z.null()]).optional(),
	priority: z.enum(["normal", "high", "urgent"]).optional(),
	dueAt: z.union([z.string().trim().max(80), z.null()]).optional(),
}).refine((value) => value.status !== undefined || value.assignee !== undefined || value.priority !== undefined || value.dueAt !== undefined, {
	message: "Expected status, assignee, priority, or dueAt",
});

const taskBulkUpdateSchema = z.object({
	taskIds: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
	status: z.enum(["todo", "doing", "review", "done"]).optional(),
	assignee: z.union([z.string().trim().max(120), z.null()]).optional(),
	priority: z.enum(["normal", "high", "urgent"]).optional(),
	dueAt: z.union([z.string().trim().max(80), z.null()]).optional(),
}).refine((value) => value.status !== undefined || value.assignee !== undefined || value.priority !== undefined || value.dueAt !== undefined, {
	message: "Expected status, assignee, priority, or dueAt",
});

// Review reader marks are stored normalized (0..1) to the page image so they
// overlay at any render scale. Keep the point budget bounded so a freehand stroke
// can't bloat a comment record.
const reviewAnnotationSchema = z.object({
	shape: z.enum(["pin", "circle", "rect", "freehand"]),
	x: z.number().min(0).max(1),
	y: z.number().min(0).max(1),
	w: z.number().min(0).max(1),
	h: z.number().min(0).max(1),
	points: z.array(z.object({
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
	})).max(2000).optional(),
	color: z.string().trim().max(32).optional(),
});

const commentCreateSchema = z.object({
	pageIndex: z.number().int().min(0),
	layerId: z.string().trim().min(1).max(160).optional(),
	region: z.object({
		x: z.number().min(0),
		y: z.number().min(0),
		w: z.number().min(1),
		h: z.number().min(1),
	}).optional(),
	annotation: reviewAnnotationSchema.optional(),
	body: z.string().trim().min(1).max(2000),
});

const commentUpdateSchema = z.object({
	body: z.string().trim().min(1).max(2000).optional(),
	status: z.enum(["open", "resolved"]).optional(),
}).refine((value) => value.body !== undefined || value.status !== undefined, {
	message: "Expected body or status",
});

const reviewDecisionCreateSchema = z.object({
	pageIndex: z.number().int().min(0),
	status: z.enum(["approved", "changes_requested"]),
	body: z.string().trim().min(1).max(2000).optional(),
});

const reviewAssignmentPageIndexesSchema = z.array(z.number().int().min(0)).max(500).optional();

// dueAt must be a real ISO-8601 datetime. A free-form string can throw on the
// Postgres `timestamptz` insert (catalog mirror) and drift the file/catalog
// copies, so reject it with a clean 400 BEFORE any write. `offset: true` allows
// both `Z` and `+hh:mm` offsets (the service re-normalizes to canonical ISO).
const reviewAssignmentDueAtSchema = z
	.string()
	.trim()
	.max(64)
	.datetime({ offset: true, message: "Expected an ISO-8601 datetime for dueAt" });

const reviewAssignmentCreateSchema = z.object({
	assigneeUserId: z.string().trim().min(1).max(160),
	targetLang: z.string().trim().min(1).max(32).optional(),
	pageIndexes: reviewAssignmentPageIndexesSchema,
	priority: z.enum(["normal", "high", "urgent"]).optional(),
	dueAt: reviewAssignmentDueAtSchema.optional(),
	instructions: z.string().trim().max(2000).optional(),
});

const reviewAssignmentUpdateSchema = z.object({
	status: z.enum(["assigned", "in_review", "submitted"]).optional(),
	targetLang: z.string().trim().min(1).max(32).optional(),
	pageIndexes: reviewAssignmentPageIndexesSchema,
	priority: z.enum(["normal", "high", "urgent"]).optional(),
	dueAt: z.union([reviewAssignmentDueAtSchema, z.null()]).optional(),
	instructions: z.string().trim().max(2000).optional(),
}).refine((value) => Object.keys(value).length > 0, {
	message: "Expected at least one field to update",
});

// Cancel REQUIRES a non-empty reason — the affected reviewer is always notified,
// so the system can never cancel silently (the user's explicit ask).
const reviewAssignmentCancelSchema = z.object({
	reason: z.string().trim().min(1).max(2000),
});

// Revision send-back schemas. The reason is MANDATORY on create (the worker is
// always notified, so a send-back can never be silent — the user's explicit ask).
const revisionPageIndexesSchema = z.array(z.number().int().min(0)).max(500).optional();

const revisionDueAtSchema = z
	.string()
	.trim()
	.max(64)
	.datetime({ offset: true, message: "Expected an ISO-8601 datetime for dueAt" });

const revisionRequestCreateSchema = z.object({
	assignedToUserId: z.string().trim().min(1).max(160),
	reason: z.string().trim().min(1).max(2000),
	targetLang: z.string().trim().min(1).max(32).optional(),
	pageIndexes: revisionPageIndexesSchema,
	sourceReviewDecisionId: z.string().trim().min(1).max(160).optional(),
	priority: z.enum(["normal", "high", "urgent"]).optional(),
	dueAt: revisionDueAtSchema.optional(),
});

const revisionRequestUpdateSchema = z.object({
	status: z.enum(["requested", "in_progress", "resubmitted", "accepted", "cancelled"]).optional(),
	reason: z.string().trim().min(1).max(2000).optional(),
	pageIndexes: revisionPageIndexesSchema,
	priority: z.enum(["normal", "high", "urgent"]).optional(),
	dueAt: z.union([revisionDueAtSchema, z.null()]).optional(),
}).refine((value) => Object.keys(value).length > 0, {
	message: "Expected at least one field to update",
});

const workspaceMessageCreateSchema = z.object({
	pageIndex: z.number().int().min(0).optional(),
	body: z.string().trim().min(1).max(2000),
	linkedTaskId: z.string().trim().min(1).max(160).optional(),
	linkedCommentId: z.string().trim().min(1).max(160).optional(),
	region: z.object({
		x: z.number().min(0),
		y: z.number().min(0),
		w: z.number().min(1),
		h: z.number().min(1),
	}).optional(),
});

const versionReviewCreateSchema = z.object({
	body: z.string().trim().min(1).max(2000).optional(),
});

const namedVersionCreateSchema = z.object({
	label: z.string().trim().min(1).max(120),
});

const versionReviewUpdateSchema = z.object({
	status: z.enum(["open", "approved", "changes_requested"]),
	body: z.string().trim().min(1).max(2000).optional(),
});

// W3.9: optional scope for a selective per-page/layer restore. With no fields
// the restore reverts the whole project (legacy behaviour). `layerId` requires
// `pageIndex` so a layer is always restored onto a known page.
const versionRestoreScopeSchema = z.object({
	pageIndex: z.number().int().min(0).optional(),
	layerId: z.string().trim().min(1).max(200).optional(),
}).refine((value) => value.layerId === undefined || value.pageIndex !== undefined, {
	message: "layerId requires pageIndex",
	path: ["pageIndex"],
});

// W3.9: compare two snapshots of the same project. `base` defaults to current
// project state when omitted.
const versionCompareQuerySchema = z.object({
	base: z.string().trim().min(1).max(200).optional(),
	target: z.string().trim().min(1).max(200),
}).strict();

const markerRegionSchema = z.object({
	x: z.number().finite().min(0),
	y: z.number().finite().min(0),
	w: z.number().finite().min(1),
	h: z.number().finite().min(1),
});

const aiReviewMarkerStatusSchema = z.enum([
	"processing",
	"needs_review",
	"accepted",
	"rejected",
	"retry_requested",
	"applied",
	"failed",
]);

const aiTierSchema = z.enum(["budget-clean", "clean-pro", "sfx-pro"]);

// A marker's status at CREATE reflects its AI job lifecycle (a freshly-submitted or
// already-resolved job) and may legitimately be set by the client that owns the job
// result. The APPROVAL states — `accepted` and `applied` — are review DECISIONS that
// must only be reached through the PATCH route, which enforces the stale-reference
// gate before approving/applying. So they are NOT acceptable at creation: a client
// must not be able to forge a marker into an already-approved/applied state.
const aiReviewMarkerCreateStatusSchema = z.enum([
	"processing",
	"needs_review",
	"rejected",
	"retry_requested",
	"failed",
]);

// MASS-ASSIGNMENT GUARD (authz): the AI-marker create/update input schemas
// accept ONLY genuinely user-settable fields. The server-owned billing/job/result
// state — `status`, `costEstimate`, `creditReservation`, `resultImageId`,
// `sourceMarkerId`, `rerunIdempotencyKey` — is NEVER trusted from the client; it is
// derived server-side from the AI job/asset/ledger (the reconciler + submit/rerun/
// retry flows, which build markers from their own server-side object literals, not
// from these schemas). Without this, a client could forge a marker into an
// `accepted`/`applied`/`failed` review state, attach an arbitrary `resultImageId`
// (composited/exported), fabricate a credit reservation/cost, or masquerade as a
// rerun child. Zod strips unknown keys, so a client that still sends any of those is
// silently ignored. `jobId` IS accepted (the FE links the marker to the job it just
// submitted) but the create route FAILS CLOSED: it requires the referenced job to
// EXIST and belong to THIS project before persisting, closing cross-tenant jobId
// forgery (an unknown job or a different-project job is rejected, not tolerated).
const aiReviewMarkerCreateSchema = z.object({
	jobId: z.string().trim().min(1).max(160),
	pageIndex: z.number().int().min(0),
	imageId: z.string().trim().min(1).max(260),
	region: markerRegionSchema,
	// Job-lifecycle status only (no `accepted`/`applied` — those are gated approvals
	// reachable solely via PATCH). Defaults to `processing` when omitted.
	status: aiReviewMarkerCreateStatusSchema.optional(),
	tier: aiTierSchema,
	providerHint: z.string().trim().min(1).max(120).optional(),
	// `prompt` (the internal system/template prompt) is DELIBERATELY not accepted:
	// it must never be persisted on the marker or served over GET /ai-markers
	// (leak-safe, sibling to #258/#278). Zod strips unknown keys, so a client that
	// still sends it is silently ignored. The user's own input is `customPrompt`.
	customPrompt: z.string().trim().max(5000).optional(),
	textLayers: z.array(z.string().trim().max(2000)).max(50).optional(),
	translateSfx: z.boolean().optional(),
	error: z.string().trim().min(1).max(1000).optional(),
	assignee: z.string().trim().max(120).optional(),
	linkedCommentIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
	linkedTaskIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
});

const aiReviewMarkerUpdateSchema = z.object({
	// `status` is a USER-DRIVEN review decision (accept/reject/apply/retry_requested,
	// gated by the route's stale-reference check). The job-driven terminal transitions
	// (processing→needs_review/failed) are written server-side by the reconciler, not
	// here. Server-owned billing/job/result fields are NOT accepted (see create note).
	status: aiReviewMarkerStatusSchema.optional(),
	providerHint: z.string().trim().min(1).max(120).optional(),
	// See create schema: the internal `prompt` is never accepted/persisted/served.
	customPrompt: z.string().trim().max(5000).optional(),
	textLayers: z.array(z.string().trim().max(2000)).max(50).optional(),
	translateSfx: z.boolean().optional(),
	error: z.string().trim().min(1).max(1000).optional(),
	assignee: z.union([z.string().trim().max(120), z.null()]).optional(),
	linkedCommentIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
	linkedTaskIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
	message: "Expected marker update",
});

const aiReviewMarkerCommentSchema = z.object({
	body: z.string().trim().min(1).max(2000).optional(),
});

const aiReviewMarkerRerunSchema = z.object({
	lang: z.string().trim().min(1).max(10).optional(),
});

const aiReviewMarkerRetrySchema = z.object({
	lang: z.string().trim().min(1).max(10).optional(),
	promptOverride: z.string().trim().min(1).max(5000).optional(),
});

// LEAK-SAFE (prompt class, sibling to #258/#278): the rerun/retry endpoints return
// the submitted job + the marker. The internal system/template `prompt` (the
// ~900-char `buildPrompt` output) must NEVER reach the client — it is not stored on
// the marker and must not be serialized in the job-submission echo either. Strip it
// from any response object that might carry it (a spread `...result` or an explicit
// `prompt: existingJob.prompt`). The user's own instruction stays as `customPrompt`.
function omitInternalPrompt<T extends Record<string, unknown>>(payload: T): Omit<T, "prompt"> {
	const { prompt: _internalPrompt, ...rest } = payload;
	return rest;
}

const aiReviewMarkerReviewTaskSchema = z.object({
	assignee: z.union([z.string().trim().max(120), z.null()]).optional(),
});

const VERSION_ID_RE = /^[0-9TZA-Za-z_-]+$/;
const MAX_PROJECT_VERSIONS = 50;
const PROJECT_SUMMARY_CACHE_TTL_MS = 1000;
// Cap on the keyed project-summary LRU. Bounds memory under many distinct
// (user, workspace, cursor) tuples while letting concurrent callers' pages
// coexist (a single slot would thrash to a full recompute on every second
// caller). Past the cap the least-recently-used entry is evicted.
const PROJECT_SUMMARY_CACHE_MAX_ENTRIES = (() => {
	const parsed = parseInt(process.env.PROJECT_SUMMARY_CACHE_MAX_ENTRIES || "200", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
})();
const AI_MARKER_ATTENTION_STATUSES = new Set<AiReviewMarkerStatus>(["failed", "needs_review", "retry_requested"]);

const projectVersionListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_PROJECT_VERSIONS).optional(),
	cursor: z.string().trim().min(1).max(500).optional(),
}).strict();

// Keyed LRU for the project-summary listing — the hottest cached read (workspace
// Library / dashboard). One slot per (user, workspace, cursor, config) key, so
// concurrent callers no longer overwrite each other into a full-recompute
// thrash. ACCEPTED TRADEOFF: per-instance + 1s TTL. In prod the API runs
// multiple replicas, so a write on one replica does not invalidate another's
// cache — a reader can see up to ~1s of cross-replica staleness. That window is
// deliberately accepted (the 1s TTL bounds it; the listing is a soft view, not
// an authority). Within an instance, write paths call `.clear()` to invalidate
// eagerly. See services/project-summary-cache.ts for the full rationale.
const projectSummaryCache = new ProjectSummaryCache<ProjectSummaryPage>({
	maxEntries: PROJECT_SUMMARY_CACHE_MAX_ENTRIES,
	ttlMs: PROJECT_SUMMARY_CACHE_TTL_MS,
});

// ── Helper ───────────────────────────────────────────────────

function validateProjectId(c: any): string | Response {
	const id = c.req.param("id");
	if (!isValidProjectId(id)) {
		return c.json({ error: "Invalid project ID" }, 400);
	}
	return id;
}

function validateExportRunId(c: any): string | Response {
	const runId = c.req.param("runId");
	if (!EXPORT_RUN_ID_RE.test(runId)) {
		return c.json({ error: "Invalid export run ID" }, 400);
	}
	return runId;
}

function readProjectStateFromFile(projectId: string): ProjectState | null {
	const statePath = safePath(PROJECTS_DIR, projectId, "state.json");
	if (!existsSync(statePath)) return null;
	return readJsonFile<ProjectState>(statePath);
}

// Deletion tombstones. A permanently-deleted project gets a marker file under
// PROJECTS_DIR/.tombstones/<projectId> (see PROJECT_TOMBSTONES_DIR_NAME). The
// marker dir starts with a dot and the id is a UUID, so it is never treated as a
// project dir (isValidProjectId rejects it) by any catalog/disk scan. The
// tombstone is the durable record that a project was deleted: even if the on-disk
// tree or the catalog row is only partially gone, reads check the tombstone FIRST
// and refuse to resurrect the project (no backfill, no file fallback). Both this
// route reader (`loadProjectState`) and the file catalog's readState honor it.
// Creating a project with the same id (impossible in practice — ids are fresh
// UUIDs) clears the marker via writeProjectState.
function projectTombstonePath(projectId: string): string {
	return safePath(PROJECTS_DIR, PROJECT_TOMBSTONES_DIR_NAME, projectId);
}

function isProjectTombstoned(projectId: string): boolean {
	return isProjectTombstonedIn(PROJECTS_DIR, projectId);
}

function writeProjectTombstone(projectId: string): void {
	const dir = safePath(PROJECTS_DIR, PROJECT_TOMBSTONES_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	writeFileAtomic(projectTombstonePath(projectId), `${new Date().toISOString()}\n`);
}

function clearProjectTombstone(projectId: string): void {
	try {
		rmSync(projectTombstonePath(projectId), { force: true });
	} catch {
		// Best-effort: a leftover tombstone for a freshly (re)created id would only
		// hide it; ids are fresh UUIDs so this is unreachable in practice.
	}
}

type ProjectStateCatalogReader = Pick<ProjectCatalogStore, "findExistingProjectIds" | "getProjectState" | "upsertProjectState">;
type ProjectVersionCatalogReader = Pick<ProjectCatalogStore, "getProjectVersion">;

async function loadProjectState(projectId: string, options: {
	catalogStore?: ProjectStateCatalogReader | null;
	fileFallbackEnabled?: boolean;
	fileReader?: (projectId: string) => ProjectState | null;
	tombstoneCheck?: (projectId: string) => boolean;
} = {}): Promise<ProjectState | null> {
	const catalogStore = options.catalogStore ?? projectCatalogStore;
	const fileReader = options.fileReader ?? readProjectStateFromFile;
	const tombstoneCheck = options.tombstoneCheck ?? isProjectTombstoned;
	// A permanently-deleted project must never resurrect, even if a partial delete
	// (e.g. a failed disk rmSync, or a catalog row that outlived its file tree) left
	// a readable source behind for the file fallback / backfill to pick up. The
	// tombstone is the durable "this id is gone" record; honor it before any read.
	if (tombstoneCheck(projectId)) return null;
	if (catalogStore) {
		const fileFallbackEnabled = options.fileFallbackEnabled ?? serverConfig.projectCatalogFileFallbackEnabled;
		try {
			const catalogState = await catalogStore.getProjectState(projectId);
			if (catalogState && fileFallbackEnabled) {
				try {
					return fileReader(projectId) ?? catalogState;
				} catch (error) {
					console.warn("Project file fallback read failed; using catalog state", { projectId, error });
					return catalogState;
				}
			}
			if (catalogState) return catalogState;
		} catch (error) {
			if (!fileFallbackEnabled) throw error;
			console.warn("Project catalog state read failed; falling back to file state", { projectId, error });
			const fileState = fileReader(projectId);
			if (fileState) return fileState;
			throw error;
		}
		const catalogRowExists = fileFallbackEnabled
			? true
			: (await catalogStore.findExistingProjectIds([projectId])).has(projectId);
		if (!catalogRowExists) return null;
		const fileState = fileReader(projectId);
		if (fileState) {
			try {
				await catalogStore.upsertProjectState(fileState);
			} catch (error) {
				if (!fileFallbackEnabled) throw error;
				console.warn("Project catalog state backfill failed; falling back to file state", { projectId, error });
			}
			return fileState;
		}
		return null;
	}
	return fileReader(projectId);
}

async function readProjectState(projectId: string): Promise<ProjectState | null> {
	try {
		return await loadProjectState(projectId);
	} catch (error) {
		throw new ProjectStateStoreUnavailableError(projectId, error);
	}
}

function getProjectVersionsDir(projectId: string): string {
	const versionsDir = safePath(PROJECTS_DIR, projectId, "versions");
	mkdirSync(versionsDir, { recursive: true });
	return versionsDir;
}

function countTextLayers(state: ProjectState): number {
	return state.pages.reduce((total, page) => total + (page.textLayers?.length ?? 0), 0);
}

// Phase C — total non-destructive image edits (bubble-clean / brush / heal / clone)
// across the project, so version diffs can surface "edits added/removed".
function countImageEditLayers(state: ProjectState): number {
	return state.pages.reduce((total, page) => total + (page.imageEditLayers?.length ?? 0), 0);
}

function countOpenTasks(state: ProjectState): number {
	return (state.tasks ?? []).filter((task) => task.status !== "done").length;
}

function countOpenReviewTasks(state: ProjectState): number {
	return (state.tasks ?? []).filter((task) => task.type === "review" && task.status !== "done").length;
}

function countOpenComments(state: ProjectState): number {
	return (state.comments ?? []).filter((comment) => comment.status !== "resolved").length;
}

function hasMaterializedBaseWorkflowTasks(state: ProjectState): boolean {
	const tasks = Array.isArray(state.tasks) ? state.tasks : [];
	if (tasks.length === 0 && state.pages.length > 0) return false;
	const taskIds = new Set(tasks.map((task) => task.id));
	return state.pages.every((_, pageIndex) => (
		WORKFLOW_TASK_TYPES.every((type) => taskIds.has(taskIdFor(pageIndex, type)))
	));
}

function getProjectCoverSummary(state: ProjectState): Pick<ProjectSummary, "coverImageId" | "coverOriginalName"> {
	const firstPage = state.pages[0];
	const coverImageId = state.coverImageId ?? firstPage?.edits?.imageId ?? firstPage?.imageId;
	const coverOriginalName = state.coverOriginalName ?? firstPage?.originalName;
	return coverImageId ? { coverImageId, coverOriginalName } : {};
}

async function writeProjectState(projectId: string, state: ProjectState, options: { catalogSync?: "required" | "best-effort" } = {}): Promise<void> {
	const targetLangs = normalizeTargetLangs({
		targetLang: state.targetLang,
		targetLangs: state.targetLangs,
	});
	state.targetLangs = targetLangs;
	state.targetLang = targetLangs[0] ?? "th";
	if (exportArtifactStateWriteFailureForTests) {
		const fail = exportArtifactStateWriteFailureForTests;
		fail();
	}
	const projectDir = safePath(PROJECTS_DIR, projectId);
	mkdirSync(projectDir, { recursive: true });
	const statePath = safePath(PROJECTS_DIR, projectId, "state.json");
	// Atomic write (temp + fsync + rename): a crash mid-write must never leave a
	// truncated state.json that makes the project un-openable. The catalog mirror
	// below still runs AFTER the durable file commit (ordering preserved).
	//
	// COMPACT (no `null, 2` indent): state.json is a machine-read blob (never
	// hand-edited), and the 2-space pretty-print ~doubled the bytes written + the
	// serialize time for no functional benefit — a real win on 200-500 page,
	// multi-MB chapters under 5s autosave + multi-editor load. SAFE: every hash /
	// CAS baseline / version dedup is computed on the STATE OBJECT
	// (`hashProjectState` = sha256(JSON.stringify(state)) and the fingerprint's
	// normalize) — NONE read this serialized string — so the on-disk format change
	// cannot shift the hash, the CAS baseline, or version-dedup. Readers (readJsonFile
	// → JSON.parse) are indentation-agnostic.
	writeFileAtomic(statePath, JSON.stringify(state));
	// Writing real state for an id means it is a live project again; drop any stale
	// deletion tombstone so it stays readable (defensive — ids are fresh UUIDs).
	clearProjectTombstone(projectId);
	// A state write can change the listing for arbitrary keys/cursors (a new/
	// reordered chapter shifts any page that could contain it), so there is no
	// precise key to evict — full clear is the correct, simple invalidation at a
	// 1s TTL.
	projectSummaryCache.clear();
	// Maintain the PENDING-INVITE INDEX (codex P1): re-derive this project's pending
	// email invites from the just-written chapterTeam and set-replace its index entries
	// — so an invite appears on create and is dropped on accept/remove (every path goes
	// through here). The index is a SECONDARY lookup store (state.json is authoritative),
	// so a sync failure must NEVER fail the durable write; it is best-effort + logged.
	try {
		await pendingInviteIndexStore.syncProject(projectId, derivePendingInviteEntries(state));
	} catch (error) {
		console.warn("Best-effort pending-invite index sync failed", { projectId, error });
	}
	// The durable file commit (state.json above) is now done. A failure of the
	// catalog mirror below is a SECONDARY-store desync, not a loss of the primary
	// durable reference — callers that gate compensating deletes on this resolving
	// must opt into `catalogSync: "best-effort"` so a catalog-only throw does NOT
	// make them treat the (file-referenced) artifact as uncommitted.
	if (!projectCatalogStore && !exportArtifactCatalogSyncFailureForTests) return;
	try {
		if (exportArtifactCatalogSyncFailureForTests) {
			const fail = exportArtifactCatalogSyncFailureForTests;
			fail();
		}
		await projectCatalogStore?.upsertProjectState(state);
	} catch (error) {
		if (options.catalogSync === "best-effort") {
			console.warn("Best-effort project catalog sync failed", { projectId, error });
			return;
		}
		throw error;
	}
}

/**
 * Cover-safety for asset deletion (#2): clear the project's EXPLICIT cover metadata
 * IFF it still names the asset about to be deleted, persisting durably through the
 * same dual-store path (`loadProjectState` honoring file-state precedence →
 * `writeProjectState`) so a force-delete never leaves `state.coverImageId` pointing
 * at a dead asset (a broken Library cover). After clearing, `getProjectCoverSummary`
 * falls back to the first page's image, so the cover degrades gracefully rather than
 * 404-ing. No-op (returns false) when the project is gone or its cover does not match,
 * so the storage route can call it unconditionally on a force-delete. Used by the
 * storage delete route, which owns the asset lifecycle but not project state.
 */
export async function clearProjectCoverImageIfMatches(projectId: string, imageId: string): Promise<boolean> {
	const state = await loadProjectState(projectId);
	if (!state) return false;
	if (state.coverImageId !== imageId) return false;
	delete state.coverImageId;
	delete state.coverOriginalName;
	// Best-effort catalog sync: the durable file commit is the cover's primary
	// reference and must not be blocked by a secondary-store hiccup mid-delete.
	await writeProjectState(projectId, state, { catalogSync: "best-effort" });
	return true;
}

/**
 * P1-2 DATA-SAFETY — every edit-layer asset id (mask / realized-patch / clone-source)
 * referenced by ANY durable VERSION SNAPSHOT of this project. Asset-deletion / GC scans
 * normally look at LIVE state only; but after a revert/delete drops an edit layer from
 * live state, a stored snapshot still references its tiny mask/patch asset, and restoring
 * that snapshot would copy `imageEditLayers` metadata pointing at a now-deleted asset →
 * broken render/export. The storage delete-guard + GC consult this so a snapshot-referenced
 * edit asset is protected (non-force 409 / GC-skip) even when no live layer points at it.
 *
 * Best-effort + bounded: lists version metadata (catalog + file fallback) and reads each
 * record's state, collecting edit-layer asset ids. A read failure on one version is logged
 * and skipped rather than throwing — a transient version-store hiccup must NOT make the
 * guard silently report "no snapshot references" (which would re-open the data-loss hole);
 * callers treat a thrown/partial scan conservatively where it matters.
 */
export async function collectVersionSnapshotEditAssetIds(
	projectId: string,
	opts: { throwOnError?: boolean } = {},
): Promise<Set<string>> {
	// `throwOnError` is for the AUTOMATED GC reaper: a partial/empty result on a transient
	// version-store failure must NOT be read as "no snapshot references" (that would let the
	// reaper delete a snapshot-pinned asset = data loss). With throwOnError the failure
	// propagates and the GC skips that project. The interactive delete-guard keeps the lenient
	// default (best-effort) — it only widens protection, never the inverse.
	const throwOnError = opts.throwOnError === true;
	const ids = new Set<string>();
	const versionIds = new Set<string>();
	const includeFileVersions = !projectCatalogStore || serverConfig.projectCatalogFileFallbackEnabled;
	if (projectCatalogStore) {
		try {
			const page = await projectCatalogStore.listProjectVersions({ projectId, limit: MAX_PROJECT_VERSIONS });
			for (const v of page.versions) versionIds.add(v.versionId);
		} catch (error) {
			console.warn("[storage-gc] catalog version list failed while protecting edit assets", { projectId, error });
			if (throwOnError) throw error;
		}
	}
	if (includeFileVersions) {
		try {
			for (const v of listProjectVersions(projectId)) versionIds.add(v.versionId);
		} catch (error) {
			console.warn("[storage-gc] file version list failed while protecting edit assets", { projectId, error });
			if (throwOnError) throw error;
		}
	}
	for (const versionId of versionIds) {
		try {
			const record = await resolveProjectVersionRecord(projectId, versionId);
			if (record?.state) {
				for (const id of collectEditLayerAssetIds(record.state)) ids.add(id);
			}
		} catch (error) {
			console.warn("[storage-gc] version record read failed while protecting edit assets", { projectId, versionId, error });
			if (throwOnError) throw error;
		}
	}
	return ids;
}

// Best-effort compensating delete of an export object that was written to storage
// but whose state reference failed to commit (upload partial failure). Swallows
// errors so the original commit failure is the one surfaced to the caller, while
// still clearing the orphaned bytes from hidden quota.
async function deleteOrphanedExportObjectBestEffort(projectId: string, exportId: string, runId: string): Promise<void> {
	try {
		await objectStorage.deleteProjectExport({ projectId, exportId });
	} catch (error) {
		console.warn("[export-artifact] failed to delete orphaned export object after state-commit failure", {
			projectId,
			exportId,
			runId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function exportAttachmentFilename(filename: string): string {
	const safeName = sanitizeFilename(filename || "chapter-export.zip");
	return safeName.toLowerCase().endsWith(".zip") ? safeName : `${safeName}.zip`;
}

function exportAttachmentHeader(filename: string): string {
	return `attachment; filename="${exportAttachmentFilename(filename).replace(/"/g, "")}"`;
}

function hashProjectState(state: ProjectState): string {
	return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function pageImageIdSequence(state: Pick<ProjectState, "pages">): string[] {
	return (state.pages ?? []).map((page) => page.imageId);
}

function pageImageIdSequenceChanged(before: string[], after: string[]): boolean {
	if (before.length !== after.length) return true;
	return before.some((imageId, index) => imageId !== after[index]);
}

function realtimeChangedBy(user: JWTPayload | undefined): string {
	return user?.userId?.trim() || "anonymous";
}

// Optimistic-concurrency (CAS) guard for the dedicated server-owned-collection
// mutation endpoints (tasks / comments / review-decisions / workspace-messages /
// ai-markers / version-reviews). These do loadProjectState → mutate → write with
// NO baseline check, so two concurrent requests that each loaded the same
// pre-mutation state silently clobber each other (last write wins).
//
// The general `/save` path already gates on `x-project-base-fingerprint`, but
// that fingerprint deliberately EXCLUDES exactly these server-owned collections
// (REMOTE_OWNED_PROJECT_FINGERPRINT_KEYS) — so it can't protect a concurrent
// task/comment edit. Here we compare an OPTIONAL `x-project-base-state-hash`
// header (the full-state hash the client captured when it loaded the collection)
// against the freshly loaded state's full-state hash, rejecting on drift with the
// same 409 `project_save_conflict` contract the save path uses.
//
// C5: when `serverConfig.requireProjectBaselineHeaderEnabled` is ON (prod default),
// the header is REQUIRED for these write endpoints — a request that omits it is
// rejected 428 rather than defaulting to last-write-wins (which let a concurrency-
// blind client overwrite a change made before its own stale read). The browser client
// always seeds the baseline from the project GET, so only a concurrency-blind caller
// is rejected. When OFF (dev/test default) a missing header keeps the prior opt-in
// behavior so existing callers/tests are unaffected. A present-but-stale header
// always rejects 409 regardless of the flag.
function checkProjectBaselineConflict(c: any, state: ProjectState): Response | null {
	const baseStateHash = c.req.header("x-project-base-state-hash")?.trim();
	if (!baseStateHash) {
		if (serverConfig.requireProjectBaselineHeaderEnabled) {
			return c.json({
				error: "Missing concurrency baseline header (x-project-base-state-hash)",
				code: "project_baseline_required",
			}, 428);
		}
		return null;
	}
	if (hashProjectState(state) !== baseStateHash) {
		return c.json({
			error: "Project changed remotely",
			code: "project_save_conflict",
		}, 409);
	}
	return null;
}

// Per-PROJECT in-process async mutex registry for the read-check-write of project
// state. Keyed by projectId so two concurrent mutations of the SAME project run
// strictly one-at-a-time, while different projects stay fully parallel. Mirrors the
// queue's per-file `fileQueueMutationTails` chain (services/queue.ts): chain each
// operation onto the previous holder's promise, `.catch` so a rejected op never
// poisons the chain for the next waiter. Per-process by design (file mode is
// single-process; multi-replica prod uses Postgres which the catalog write hits).
//
// P0-1 (round-3): the page-lease TAKEOVER path (routes/locks.ts) ALSO acquires this
// same per-project mutex (keyed by the resolved projectId) around its lock-store
// release+insert, so a takeover and a save's commit critical section serialize on ONE
// boundary. Both paths take the project mutex FIRST and only THEN touch the work-locks
// store (no lock-order inversion ⇒ no deadlock). That eliminates the residual TOCTOU
// where a takeover could land after the in-mutex leaseGuard saw "held" and during the
// displaced holder's writeProjectState.
const projectMutationTails = new Map<string, Promise<unknown>>();

async function withProjectMutationLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
	const previous = projectMutationTails.get(projectId) ?? Promise.resolve();
	const run = previous.then(() => operation());
	// The stored tail is the rejection-swallowing wrapper; keep a reference so the
	// cleanup below compares against the SAME object (a fresh `.catch()` would be a
	// new promise that never matches).
	const tail = run.catch(() => undefined);
	projectMutationTails.set(projectId, tail);
	try {
		return await run;
	} finally {
		// Drop the chain entry once it is the tail and settled, so the Map does not
		// grow unbounded across the lifetime of the process. A newer waiter that
		// already replaced the tail is left untouched.
		if (projectMutationTails.get(projectId) === tail) {
			projectMutationTails.delete(projectId);
		}
	}
}

// ── P0 (round-5): CROSS-REPLICA project critical section ─────────────────────────────
//
// The in-process `withProjectMutationLock` only serializes within ONE Bun process. Prod
// runs 2 replicas behind Caddy (rolling 2-replica), so a takeover on replica A and a
// displaced save on replica B do NOT contend on it. The residual cross-replica clobber:
// replica B reads state hash H + (early) sees the lease held; replica A's takeover then
// releases/re-mints the work-lock (writing NO project state, so the CAS hash is STILL H);
// replica B's in-mutex leaseGuard — running on its OWN process mutex — can race the
// takeover and still see "held", then writes stale state → silent clobber.
//
// Fix: in POSTGRES mode, wrap the WHOLE save-commit critical section (read → leaseGuard →
// write) AND the takeover's lock release+mint in a shared DB-backed critical section keyed
// by the projectId, using `pg_advisory_xact_lock(hashtext('project-mutation:'+id))` taken
// at the START of a transaction. The advisory lock is connection/txn-scoped and auto-
// releases on COMMIT/ROLLBACK, so it spans replicas: a save either fully completes before
// the takeover, or its in-txn leaseGuard sees the released/taken-over lock and rejects
// (editing_taken_over). The transaction is purely the CARRIER for the advisory lock (a
// cross-replica mutex) — the durable file/catalog writes inside the operation are NOT
// rolled back by it; correctness comes from mutual exclusion, not from rows in this txn.
//
// FILE mode (no DATABASE_URL → no advisory client) keeps ONLY the in-process mutex —
// single process, already correct; the DB path is never entered.
//
// LOCK ORDERING (identical on BOTH the save and the takeover site ⇒ no inversion / no
// deadlock): (1) acquire the in-process `withProjectMutationLock(projectId)` FIRST, THEN
// (2) acquire the DB advisory lock, THEN (3) touch the work-lock store / write project
// state, all inside the same advisory-lock transaction. Every project uses the SAME
// ordering and the advisory key is a pure function of projectId, so two critical sections
// for the same project queue (never cross-acquire), and different projects never contend.
interface ProjectAdvisoryLockClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: ProjectAdvisoryLockClient) => Promise<T>): Promise<T>;
}

let projectAdvisoryLockDatabaseUrl: string | undefined;
let projectAdvisoryLockClientCache: ProjectAdvisoryLockClient | null = null;
// Test-only seam: inject a fake advisory-lock client so the cross-replica serialization
// logic (advisory-lock acquire ordering, in-txn leaseGuard rejection) can be exercised
// WITHOUT a real Postgres. When set, it OVERRIDES the DATABASE_URL-derived client.
// Production never sets it (stays null → real Bun.SQL client by DATABASE_URL).
let projectAdvisoryLockClientForTests: ProjectAdvisoryLockClient | null = null;
export function __setProjectAdvisoryLockClientForTesting(client: ProjectAdvisoryLockClient | null): void {
	projectAdvisoryLockClientForTests = client;
}

function getProjectAdvisoryLockClient(): ProjectAdvisoryLockClient | null {
	if (projectAdvisoryLockClientForTests) return projectAdvisoryLockClientForTests;
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		projectAdvisoryLockDatabaseUrl = undefined;
		projectAdvisoryLockClientCache = null;
		return null;
	}
	if (projectAdvisoryLockClientCache && projectAdvisoryLockDatabaseUrl === databaseUrl) {
		return projectAdvisoryLockClientCache;
	}
	projectAdvisoryLockDatabaseUrl = databaseUrl;
	// DELIBERATELY a private pool, NOT getSharedBunSql(): this client CARRIES the
	// cross-replica advisory lock (holds a connection/transaction open) while the
	// code inside the lock reads/writes project state THROUGH THE SHARED POOL. If
	// the lock carrier and the work it wraps drew from the same pool, a small
	// PG_POOL_MAX (e.g. 1) would self-deadlock every Postgres-backed save: the
	// lock holds the last connection while the inner catalog call waits for one.
	projectAdvisoryLockClientCache = new Bun.SQL(databaseUrl, { max: 4 }) as unknown as ProjectAdvisoryLockClient;
	return projectAdvisoryLockClientCache;
}

// Stable advisory-lock KEY string for a project's mutation critical section. Namespaced so
// it can never collide with another subsystem's `hashtext()`-keyed advisory lock.
function projectMutationAdvisoryKey(projectId: string): string {
	return `project-mutation:${projectId}`;
}

async function runInProjectAdvisoryLockTxn<T>(
	client: ProjectAdvisoryLockClient,
	projectId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const acquireAndRun = async (tx: ProjectAdvisoryLockClient): Promise<T> => {
		// Take the cross-replica mutex FIRST in this transaction; it blocks until any
		// other replica/connection holding the same key's xact lock commits/rolls back.
		await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [projectMutationAdvisoryKey(projectId)]);
		return operation();
	};
	if (client.begin) return client.begin(acquireAndRun);
	// Fallback for clients without a `begin` helper: drive BEGIN/COMMIT/ROLLBACK manually.
	await client.unsafe("BEGIN");
	try {
		const result = await acquireAndRun(client);
		await client.unsafe("COMMIT");
		return result;
	} catch (error) {
		await client.unsafe("ROLLBACK");
		throw error;
	}
}

// Run `operation` inside the project's cross-replica critical section. In Postgres mode it
// is the in-process mutex (cheap same-replica insurance) wrapping the DB advisory-lock txn
// (the cross-replica guarantee); in file mode it is the in-process mutex alone. Shared by
// the save-commit path and the takeover path so they genuinely serialize across replicas.
export async function withProjectCrossReplicaLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
	const client = getProjectAdvisoryLockClient();
	return withProjectMutationLock(projectId, async () => {
		if (!client) return operation();
		return runInProjectAdvisoryLockTxn(client, projectId, operation);
	});
}

// True (storage-atomic) compare-and-swap commit for the dedicated server-owned
// mutation endpoints AND the general /save path. The previous guard
// (`checkProjectBaselineConflict`) compared the client's baseline hash to the
// freshly-loaded state OUTSIDE any lock, then mutated + wrote — so two concurrent
// requests could BOTH pass the check (each loaded the same pre-mutation state) and
// the later write would clobber the earlier (last-write-wins). This helper closes
// that window: it serializes per-project and, INSIDE the lock, re-reads the
// persisted state and verifies its full-state hash still equals `expectedBaseHash`
// (the hash of the state the route loaded BEFORE mutating). If a concurrent writer
// committed in between, the persisted hash drifted → reject with the same 409
// `project_save_conflict` contract instead of overwriting. A single-writer flow
// always re-reads its own just-loaded state (hash matches) → writes exactly as
// before, so back-compat is preserved.
class ProjectStateCasConflictError extends Error {
	constructor() {
		super("Project changed remotely");
	}
}

// P0-1 (round-2): thrown out of `commitProjectStateWithCas` when the in-lock lease
// re-check finds the caller no longer holds the page lease. `takenOver` distinguishes
// a cross-user takeover (→ `editing_taken_over`, client flips read-only + snapshots a
// recovery draft) from a generic lost-lease (→ `project_save_conflict`). Carrying the
// verdict on the error lets the same critical section that does the hash CAS ALSO
// enforce the lease atomically under the per-project mutex.
class ProjectLeaseLostError extends Error {
	constructor(readonly takenOver: boolean) {
		super(takenOver ? "Editing was taken over" : "Project changed remotely");
	}
}

async function commitProjectStateWithCas<T = void>(
	projectId: string,
	expectedBaseHash: string,
	mutatedState: ProjectState,
	writeOptions: { catalogSync?: "required" | "best-effort" } = {},
	// C6: optional step run INSIDE the same per-project mutex, AFTER the durable
	// state write. The save path uses this to run version-snapshot + retention-prune
	// so state-commit + versioning + prune are ONE serialized unit. Without it the
	// version snapshot ran after the lock released, letting a second concurrent
	// commit interleave between this save's write and its snapshot — so the snapshot
	// could capture a DIFFERENT (newer) committed state than the one this save wrote,
	// or two saves could race version-id/prune bookkeeping. Runs only on a successful
	// write (a CAS conflict throws before reaching it).
	afterCommit?: () => Promise<T>,
	// P0-1 (round-2): optional page-lease re-check run INSIDE the per-project mutex,
	// IMMEDIATELY before the durable write — atomically with the hash CAS. A
	// cross-user takeover mutates NO project state, so the displaced holder's CAS
	// baseline hash is unchanged: the hash check alone CANNOT see the displacement.
	// Re-inspecting the lease HERE, under the same mutex that serializes the takeover's
	// lock-release against this write, closes the TOCTOU window where the early
	// (pre-lock) lease check passed and a takeover then slipped in before the write.
	// Returns a verdict; a "lost" verdict throws ProjectLeaseLostError (mapped to the
	// recovery-draft / save-conflict response by the route) instead of clobbering.
	leaseGuard?: () => Promise<PageLeaseVerdict>,
): Promise<T | undefined> {
	// P0 (round-5): the read-check-write critical section runs under the CROSS-REPLICA
	// project lock (in-process mutex + Postgres advisory-lock txn), so the in-txn
	// leaseGuard re-check + write serialize against a takeover happening on ANOTHER
	// replica — not just within this process. File mode degrades to the in-process mutex.
	return withProjectCrossReplicaLock(projectId, async () => {
		const persisted = await readProjectState(projectId);
		// A delete that interleaved between load and write removes the project; treat
		// the disappearance as drift rather than resurrecting it with our stale write.
		if (!persisted || hashProjectState(persisted) !== expectedBaseHash) {
			throw new ProjectStateCasConflictError();
		}
		// Validate the page lease UNDER the mutex, after the hash CAS and before the
		// write — so the lease can never be displaced between the check and the write.
		if (leaseGuard) {
			const verdict = await leaseGuard();
			if (verdict.kind === "lost") {
				throw new ProjectLeaseLostError(verdict.takenOver);
			}
		}
		await writeProjectState(projectId, mutatedState, writeOptions);
		return afterCommit ? await afterCommit() : undefined;
	});
}

// C6 / P1-4 (round-2): the dedicated server-owned mutation endpoints all share the same
// shape — CAS-commit the mutated state, then snapshot a "save" version. Doing the
// version snapshot AFTER `commitProjectStateWithCas` released the per-project mutex let
// a SECOND concurrent commit interleave between this route's write and its snapshot, so
// the snapshot could capture a DIFFERENT (newer) committed state, or two routes could
// race version-id/retention-prune bookkeeping. This helper runs the version snapshot
// INSIDE the same mutex via the `afterCommit` hook (exactly like /save), making
// state-commit + version-snapshot + retention-prune ONE serialized unit. Returns the
// created version metadata (the `!` is safe: the afterCommit callback always returns
// metadata; a CAS conflict throws before it runs).
async function commitProjectStateWithVersion(
	projectId: string,
	expectedBaseHash: string,
	mutatedState: ProjectState,
	source: ProjectVersionMetadata["source"] = "save",
	// perf(save) #437: the calling route already hashed THIS exact post-mutation object
	// (to stamp the response `x-project-state-hash` header). Thread that hash into the
	// in-mutex version snapshot so the full multi-MB chapter is sha256'd ONCE per save,
	// not re-hashed by createProjectVersion. MUST equal `hashProjectState(mutatedState)`
	// for the passed object — same value either way, so version-dedup + the stored
	// `metadata.stateHash` are byte-identical. This is purely a dedupe of the redundant
	// re-hash of the SAME in-memory state; the in-mutex CAS RE-READ hash inside
	// commitProjectStateWithCas (a freshly re-read PERSISTED object — a genuinely
	// different correctness check) is untouched.
	stateHash?: string,
): Promise<ProjectVersionMetadata> {
	return (await commitProjectStateWithCas(
		projectId,
		expectedBaseHash,
		mutatedState,
		{},
		// afterCommit runs INSIDE the per-project cross-replica mutex (#428): commit +
		// version snapshot stay ONE serialized unit. The threaded hash reaches the snapshot
		// here so the in-lock versioning keeps #428's atomicity AND #437's hash-once win.
		() => createProjectVersion(projectId, mutatedState, source, { stateHash }),
	))!;
}

// C1 / P0-1: a displaced/expired holder's in-flight save must NOT pass merely because
// its state-hash baseline still matches — a cross-user takeover writes NOTHING to
// project state, so the displaced holder's CAS baseline is unchanged and would silently
// clobber the new holder. The save additionally verifies the caller still HOLDS the page
// lease it claimed (via the `x-edit-lock-id` + `x-edit-client-id` headers the lease
// client sends). If the lock was taken over / released / expired / re-minted to another
// client, reject so the client routes its stale write into the #412 recovery-draft flow
// (`editing_taken_over`) instead of overwriting.
//
// The verdict is produced by `evaluatePageLeaseHold` (a pure inspection) so the SAME
// check can run BOTH cheaply pre-lock (fast-fail) AND again INSIDE the commit mutex,
// atomically with the hash CAS (P0-1: closes the TOCTOU window where a takeover slipped
// in between the early check and the write).
type PageLeaseVerdict =
	// Allowed: still holding, idempotent same-tab, no lease claimed, no lock store, or
	// an inspection error degraded to allow (CAS still guards). `headerPresent` records
	// whether the request actually carried `x-edit-lock-id` (used by the P0-2 prod
	// require-header enforcement).
	| { kind: "allow"; headerPresent: boolean }
	// Positive evidence the lease was lost. `takenOver` drives `editing_taken_over` vs
	// the generic `project_save_conflict` response.
	| { kind: "lost"; takenOver: boolean };

async function evaluatePageLeaseHold(c: any, user: JWTPayload | undefined): Promise<PageLeaseVerdict> {
	const lockId = c.req.header("x-edit-lock-id")?.trim();
	if (!workLockStore || !user || !lockId) {
		return { kind: "allow", headerPresent: Boolean(lockId) };
	}
	const clientId = c.req.header("x-edit-client-id")?.trim() || undefined;
	let hold;
	try {
		hold = await workLockStore.inspectLockHold(lockId, user.userId, clientId);
	} catch (error) {
		// An inspection error degrades to "allow" so a lock-store hiccup can never wedge
		// saving — but the header WAS present, so a require-header prod deploy still has
		// its admission gate satisfied; CAS remains the net for the lease decision here.
		console.warn("[save] lease-hold inspection failed; allowing save (CAS still guards)", error);
		return { kind: "allow", headerPresent: true };
	}
	// Still holding (or a same-tab idempotent heartbeat) → allow. A `not_found` lock id
	// is also allowed: the lease may have legitimately expired+been pruned, or the
	// client minted a fresh lock the server never saw (degrade to CAS) — we only block
	// on POSITIVE evidence of displacement so we never strand a genuine save.
	if (hold.status === "held" || hold.status === "not_found") {
		return { kind: "allow", headerPresent: true };
	}
	// taken_over / released / expired / re-held by another client = the caller no longer
	// owns the page. Steer into the recovery-draft flow rather than clobber.
	const takenOver = (hold.status === "released" && hold.reason === "taken_over")
		|| hold.status === "held_by_other";
	return { kind: "lost", takenOver };
}

// Build the 409 lost-lease response. `editing_taken_over` lets the client flip
// read-only + snapshot a recovery draft; other lost-lease states reuse the generic
// save-conflict contract the client already routes into reload/recover.
function pageLeaseLostResponse(c: any, takenOver: boolean): Response {
	return c.json({
		error: takenOver ? "Editing was taken over" : "Project changed remotely",
		code: takenOver ? "editing_taken_over" : "project_save_conflict",
	}, 409);
}

// Early (pre-lock) lease gate for the /save path. Fast-fails an already-displaced save
// before doing the expensive body parse, AND (P0-2) enforces the prod require-lease-
// header policy. Returns a Response to reject, or null to proceed (the authoritative
// re-check runs again INSIDE the commit mutex via `makePageLeaseGuard`).
//
// P0-2: when `requireEditLeaseHeaderEnabled` is ON (prod) and this save TARGETS A
// SPECIFIC PAGE (a lease is expected), a missing `x-edit-lock-id` is rejected 428 —
// otherwise an attacker/buggy client could simply omit the header and the fail-open
// would let a takeover-clobber through (CAS alone can't see a no-state-write takeover).
// `pageScoped` is false for first-save-before-lease / non-page-scoped saves so those
// are never broken.
async function rejectIfPageLeaseLost(
	c: any,
	user: JWTPayload | undefined,
	options: { pageScoped?: boolean } = {},
): Promise<Response | null> {
	const verdict = await evaluatePageLeaseHold(c, user);
	if (verdict.kind === "lost") {
		return pageLeaseLostResponse(c, verdict.takenOver);
	}
	// P0-2: prod require-lease-header enforcement for page-scoped saves.
	if (
		options.pageScoped
		&& serverConfig.requireEditLeaseHeaderEnabled
		&& workLockStore
		&& user
		&& !verdict.headerPresent
	) {
		return c.json({
			error: "Missing edit-lease header (x-edit-lock-id)",
			code: "edit_lease_required",
		}, 428);
	}
	return null;
}

// Capture the request's lease identity ONCE (the header values are read off `c`, which
// is request-scoped and immutable here) and return a guard the commit mutex can invoke
// to re-validate the lease atomically with the hash CAS (P0-1). Returns null when no
// lease is claimed / no lock store — the guard is skipped and CAS is the net, as before.
function makePageLeaseGuard(c: any, user: JWTPayload | undefined): (() => Promise<PageLeaseVerdict>) | undefined {
	const lockId = c.req.header("x-edit-lock-id")?.trim();
	if (!workLockStore || !user || !lockId) return undefined;
	return () => evaluatePageLeaseHold(c, user);
}

// Maps a CAS conflict OR an in-lock lost-lease (P0-1) thrown out of
// `commitProjectStateWithCas` onto the shared 409 response; rethrows anything else.
// Routes call this in their catch so a genuine concurrent-drift conflict surfaces as
// 409 `project_save_conflict` (and a takeover as `editing_taken_over`), not a 500.
function projectCasConflictResponse(c: any, error: unknown): Response | null {
	if (error instanceof ProjectLeaseLostError) {
		return pageLeaseLostResponse(c, error.takenOver);
	}
	if (error instanceof ProjectStateCasConflictError) {
		return c.json({
			error: "Project changed remotely",
			code: "project_save_conflict",
		}, 409);
	}
	return null;
}

// Stamp the current full-state hash on a dedicated-endpoint response so a
// concurrency-aware client can capture it and echo it back as the
// `x-project-base-state-hash` baseline on its NEXT mutation (activating the CAS).
// Pure additive header — clients that ignore it are unaffected.
// `precomputedHash` lets a caller that already hashed THIS exact (post-mutation)
// state object pass it in so the chapter is not re-serialized + sha256'd a second
// time on the hot save path. It MUST be `hashProjectState(state)` for the state
// being stamped — pass it only when the same object was just hashed unchanged.
function setProjectStateHashHeader(c: any, state: ProjectState, precomputedHash?: string): void {
	c.header("x-project-state-hash", precomputedHash ?? hashProjectState(state));
}

// Persist the marker state durably, and if that write fails, ROLL BACK the AI job
// that was already queued + charged by `submitAiJob` BEFORE this write. Without the
// rollback a state-write failure would strand a charged, queued job with NO marker
// to surface it (invisible spend that still consumes worker capacity). `cancel`
// moves a pending/processing job to "cancelled", which releases/refunds its credit
// reservation (queue.applyJobUpdate → releaseSharedCreditsBestEffort). Best-effort
// on the cancel itself: a cancel failure must not mask the original write error,
// and the queue's reservation reconciler is the backstop. Rethrows the write error
// so the route's existing catch maps it to the right response.
// Best-effort cancel of an already-charged/queued AI job whose marker state-write did
// not land (a write error OR — P1 round-3 — a CAS conflict). Without it a failed marker
// write strands a charged, queued job with NO marker to surface it (invisible spend that
// still consumes worker capacity). `cancel` moves a pending/processing job to "cancelled",
// releasing/refunding its credit reservation; failures here are swallowed (the queue's
// reservation reconciler is the backstop) so the cancel never masks the original error.
async function rollbackAiJobBestEffort(projectId: string, jobId: string, cause: unknown): Promise<void> {
	try {
		await jobQueue.cancel(jobId);
	} catch (cancelError) {
		console.warn("[ai-marker] failed to roll back queued job after marker state commit failed", {
			projectId,
			jobId,
			cause: cause instanceof Error ? cause.message : String(cause),
			cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
		});
	}
}

// P1 (round-3): CAS + in-mutex versioning for the AI marker RERUN/RETRY commit, with the
// same job-rollback safety net (`rollbackAiJobBestEffort`). These two routes
// previously wrote the marker state + snapshotted a version OUTSIDE the per-project mutex
// and OUTSIDE CAS, so a concurrent commit could clobber/interleave with the marker write
// (the same gap the other marker routes already closed via commitProjectStateWithVersion).
// Routing them through `commitProjectStateWithVersion` brings them onto the standard CAS +
// in-mutex versioning path. Because the job was already charged + queued by submitAiJob
// BEFORE this commit, a CAS conflict (or any commit failure) must ALSO cancel the job to
// avoid invisible spend — so we roll the job back on failure, then rethrow so the route's
// existing catch maps a CAS conflict to 409 `project_save_conflict`.
async function commitAiMarkerRerunStateOrRollbackJob(
	projectId: string,
	expectedBaseHash: string,
	state: ProjectState,
	jobId: string,
): Promise<ProjectVersionMetadata> {
	try {
		return await commitProjectStateWithVersion(projectId, expectedBaseHash, state);
	} catch (commitError) {
		await rollbackAiJobBestEffort(projectId, jobId, commitError);
		throw commitError;
	}
}

function getProtectedVersionReviewIds(state: ProjectState): Set<string> {
	return new Set((state.versionReviewRequests ?? [])
		.filter((request) => request.status === "open" && VERSION_ID_RE.test(request.versionId))
		.map((request) => request.versionId));
}

async function createProjectVersion(
	projectId: string,
	state: ProjectState,
	source: ProjectVersionMetadata["source"],
	options: { label?: string; author?: string; dedupe?: boolean; stateHash?: string } = {},
): Promise<ProjectVersionMetadata> {
	// Reuse the caller's already-computed full-state hash when supplied (hot save
	// path: the route just hashed THIS exact post-mutation object). `stateHash` MUST
	// equal `hashProjectState(state)` for the passed object; pass it only when the
	// same object was hashed without intervening mutation. Same sha256 value either
	// way, so the version-dedup + stored `metadata.stateHash` are byte-identical.
	const stateHash = options.stateHash ?? hashProjectState(state);
	// Named/manual snapshots are explicit user intent: always create a distinct
	// version even when state is byte-identical to an existing one. Autosave-style
	// versions ("save"/"import-json") still dedupe by stateHash to avoid churn.
	const dedupe = options.dedupe ?? source !== "manual";
	if (dedupe) {
		for (const version of listProjectVersions(projectId)) {
			const record = readProjectVersionRecord(projectId, version.versionId);
			if (record && (record.metadata.stateHash ?? hashProjectState(record.state)) === stateHash) {
				const metadata = { ...record.metadata, stateHash };
				await projectCatalogStore?.upsertProjectState(record.state);
				await projectCatalogStore?.recordProjectVersion(metadata, record.state);
				return metadata;
			}
		}
	}

	const createdAt = new Date().toISOString();
	const versionId = `${createdAt.replace(/[:.]/g, "-")}_${uuid()}`;
	const metadata: ProjectVersionMetadata = {
		versionId,
		projectId,
		name: state.name,
		storyId: state.storyId,
		storyTitle: state.storyTitle,
		chapterNumber: state.chapterNumber,
		chapterTitle: state.chapterTitle,
		chapterLabel: state.chapterLabel,
		source,
		...(options.label ? { label: options.label } : {}),
		...(options.author ? { author: options.author } : {}),
		createdAt,
		pageCount: state.pages.length,
		textLayerCount: countTextLayers(state),
		stateHash,
	};
	const versionsDir = getProjectVersionsDir(projectId);
	// Durably commit the NEW version FIRST — disk record (atomic write) and catalog
	// record — BEFORE pruning any old versions. Pruning before the new record is
	// durably committed means a failure mid-commit (recordProjectVersion throws, or
	// a crash between the prune and the record) could delete visible history with no
	// replacement recorded. Ordering: new-version durable → prune old (best-effort).
	// Compact (no pretty-print): the version record is a machine-read snapshot blob
	// (readJsonFile → JSON.parse, never hand-edited). On the autosave hot path this
	// stores ANOTHER full copy of a multi-MB chapter; dropping the 2-space indent ~halves
	// the bytes + serialize time. `metadata.stateHash` is computed on the state OBJECT
	// (above), independent of this serialization, so version-dedup stays byte-stable.
	writeFileAtomic(safePath(versionsDir, `${versionId}.json`), JSON.stringify({ metadata, state }));
	await projectCatalogStore?.upsertProjectState(state, { updatedAt: createdAt });
	if (projectVersionRecordFailureForTests) {
		const fail = projectVersionRecordFailureForTests;
		fail();
	}
	await projectCatalogStore?.recordProjectVersion(metadata, state);

	// Retention prune AFTER the new version is durably committed in both stores.
	// This is best-effort: a prune failure must NOT roll back / hide the just-saved
	// version, so we never let it throw out of here. The retention count/behavior is
	// unchanged — only the ordering moved for safety.
	try {
		const prunedVersionIds = pruneProjectVersions(projectId, getProtectedVersionReviewIds(state));
		if (prunedVersionIds.length > 0) {
			await projectCatalogStore?.deleteProjectVersions(projectId, prunedVersionIds);
		}
	} catch (error) {
		console.warn("Best-effort project version prune failed after durable commit", { projectId, versionId, error });
	}
	return metadata;
}

function listProjectVersions(projectId: string): ProjectVersionMetadata[] {
	const versionsDir = getProjectVersionsDir(projectId);
	return readdirSync(versionsDir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => {
			// A corrupt/truncated/non-JSON version record must NOT 500 the whole
			// listing (which would make the project un-openable). Skip + log it.
			try {
				const raw = readJsonFile<{ metadata?: ProjectVersionMetadata }>(safePath(versionsDir, file));
				return raw.metadata;
			} catch (error) {
				console.warn("Skipping unreadable project version record", { versionsDir, file, error });
				return undefined;
			}
		})
		.filter((metadata): metadata is ProjectVersionMetadata => Boolean(metadata?.versionId))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.versionId.localeCompare(a.versionId));
}

function readProjectVersionRecord(projectId: string, versionId: string): ProjectVersionRecord | null {
	if (!VERSION_ID_RE.test(versionId)) return null;
	const versionPath = safePath(getProjectVersionsDir(projectId), `${versionId}.json`);
	if (!existsSync(versionPath)) return null;
	const raw = readJsonFile<{ metadata?: ProjectVersionMetadata; state?: ProjectState }>(versionPath);
	if (!raw.metadata || !raw.state) return null;
	return { metadata: raw.metadata, state: raw.state };
}

export async function resolveProjectVersionRecord(projectId: string, versionId: string, options: {
	catalogStore?: ProjectVersionCatalogReader | null;
	fileFallbackEnabled?: boolean;
	fileReader?: (projectId: string, versionId: string) => ProjectVersionRecord | null;
} = {}): Promise<ProjectVersionRecord | null> {
	const catalogStore = options.catalogStore ?? projectCatalogStore;
	const fileFallbackEnabled = options.fileFallbackEnabled ?? serverConfig.projectCatalogFileFallbackEnabled;
	const fileReader = options.fileReader ?? readProjectVersionRecord;
	const readFallbackFile = () => fileReader(projectId, versionId);
	if (!catalogStore) return readFallbackFile();
	try {
		const catalogRecord = await catalogStore.getProjectVersion(projectId, versionId);
		if (catalogRecord) return catalogRecord;
		return fileFallbackEnabled ? readFallbackFile() : null;
	} catch (error) {
		if (!fileFallbackEnabled) throw error;
		const fileRecord = readFallbackFile();
		if (fileFallbackEnabled && fileRecord) {
			console.warn("Project catalog version read failed; falling back to file version", { projectId, versionId, error });
			return fileRecord;
		}
		throw error;
	}
}

async function readProjectVersionRecordAny(projectId: string, versionId: string): Promise<ProjectVersionRecord | null> {
	try {
		return await resolveProjectVersionRecord(projectId, versionId);
	} catch (error) {
		throw new ProjectStateStoreUnavailableError(projectId, error);
	}
}

function summarizeState(state: ProjectState) {
	return {
		name: state.name,
		storyId: state.storyId,
		storyTitle: state.storyTitle,
		chapterNumber: state.chapterNumber,
		chapterTitle: state.chapterTitle,
		chapterLabel: state.chapterLabel,
		pageCount: state.pages.length,
		textLayerCount: countTextLayers(state),
		editLayerCount: countImageEditLayers(state),
		pages: state.pages.map((page, pageIndex) => ({
			pageIndex,
			imageId: page.imageId,
			imageName: page.imageName,
			originalName: page.originalName,
			textLayerCount: page.textLayers?.length ?? 0,
			editLayerCount: page.imageEditLayers?.length ?? 0,
		})),
	};
}

function compareVersionState(currentState: ProjectState, snapshotState: ProjectState) {
	const current = summarizeState(currentState);
	const snapshot = summarizeState(snapshotState);
	const maxPages = Math.max(current.pages.length, snapshot.pages.length);
	const changedPages = [];

	for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
		const currentPage = current.pages[pageIndex];
		const snapshotPage = snapshot.pages[pageIndex];
		const currentTextLayerCount = currentPage?.textLayerCount ?? 0;
		const snapshotTextLayerCount = snapshotPage?.textLayerCount ?? 0;
		const currentEditLayerCount = currentPage?.editLayerCount ?? 0;
		const snapshotEditLayerCount = snapshotPage?.editLayerCount ?? 0;
		const label =
			currentPage?.originalName ??
			currentPage?.imageName ??
			snapshotPage?.originalName ??
			snapshotPage?.imageName ??
			`Page ${pageIndex + 1}`;
		if (
			!currentPage ||
			!snapshotPage ||
			currentTextLayerCount !== snapshotTextLayerCount ||
			currentEditLayerCount !== snapshotEditLayerCount
		) {
			changedPages.push({
				pageIndex,
				label,
				currentTextLayerCount,
				snapshotTextLayerCount,
				currentEditLayerCount,
				snapshotEditLayerCount,
			});
		}
	}

	return {
		current,
		snapshot,
		pageDelta: snapshot.pageCount - current.pageCount,
		textLayerDelta: snapshot.textLayerCount - current.textLayerCount,
		editLayerDelta: snapshot.editLayerCount - current.editLayerCount,
		changedPages: changedPages.slice(0, 50),
		changedPageCount: changedPages.length,
	};
}

function syncAiReviewMarkerAttentionTask(state: ProjectState, marker: AiReviewMarker) {
	if (!AI_MARKER_ATTENTION_STATUSES.has(marker.status)) return null;
	ensureProjectWorkflow(state);
	const task = state.tasks?.find((item) => item.pageIndex === marker.pageIndex && item.type === "review");
	if (!task) return null;

	const previousStatus = task.status;
	const previousPriority = normalizeWorkflowTaskPriority(task.priority);
	if (task.status !== "review") {
		task.status = "review";
	}
	const attentionPriority: WorkflowTaskPriority = marker.status === "failed" ? "urgent" : "high";
	task.priority = maxWorkflowTaskPriority(task.priority, attentionPriority);
	const statusChanged = previousStatus !== task.status;
	const priorityChanged = previousPriority !== task.priority;
	if (statusChanged || priorityChanged) {
		task.updatedAt = new Date().toISOString();
	}
	linkAiReviewMarkerTask(marker, task.id);

	return {
		task,
		previousStatus,
		previousPriority,
		statusChanged,
		priorityChanged,
	};
}

function getAiReviewMarkerReferenceError(state: ProjectState, marker: AiReviewMarker): string | null {
	const page = state.pages[marker.pageIndex];
	if (!page) {
		return `AI marker points at missing page ${marker.pageIndex + 1}`;
	}

	const expectedImageIds = [page.imageId, page.edits?.imageId].filter((imageId): imageId is string => Boolean(imageId));
	if (!expectedImageIds.includes(marker.imageId)) {
		const currentImageId = expectedImageIds[expectedImageIds.length - 1] ?? "unknown";
		return `AI marker source image ${marker.imageId} no longer matches page ${marker.pageIndex + 1} image ${currentImageId}`;
	}

	return null;
}

function resolveLinkedTask(state: ProjectState, taskId: string): WorkflowTask | null {
	const task = state.tasks?.find((item) => item.id === taskId);
	return task && typeof task.pageIndex === "number" && Number.isInteger(task.pageIndex) ? task : null;
}

function resolveLinkedTaskPageIndex(state: ProjectState, taskId: string): number | null {
	return resolveLinkedTask(state, taskId)?.pageIndex ?? null;
}

function resolveLinkedCommentPageIndex(state: ProjectState, commentId: string): number | null {
	const comment = state.comments?.find((item) => item.id === commentId);
	return typeof comment?.pageIndex === "number" && Number.isInteger(comment.pageIndex) ? comment.pageIndex : null;
}

function resolveWorkspaceMessageScopeContext(
	state: ProjectState,
	input: { pageIndex?: number; linkedTaskId?: string; linkedCommentId?: string },
): { pageIndex?: number; taskType?: WorkflowTaskType } | { error: string; status: number } {
	let pageIndex = input.pageIndex;
	let taskType: WorkflowTaskType | undefined;
	if (pageIndex !== undefined && !state.pages[pageIndex]) {
		return { error: "Page not found", status: 404 };
	}

	if (input.linkedTaskId) {
		const task = resolveLinkedTask(state, input.linkedTaskId);
		if (!task) return { error: "Linked task not found", status: 400 };
		if (pageIndex !== undefined && pageIndex !== task.pageIndex) {
			return { error: "Linked task does not belong to page", status: 400 };
		}
		pageIndex = task.pageIndex;
		taskType = task.type;
	}

	if (input.linkedCommentId) {
		const commentPageIndex = resolveLinkedCommentPageIndex(state, input.linkedCommentId);
		if (commentPageIndex === null) return { error: "Linked comment not found", status: 400 };
		if (pageIndex !== undefined && pageIndex !== commentPageIndex) {
			return { error: "Linked comment does not belong to page", status: 400 };
		}
		pageIndex = commentPageIndex;
	}

	return { pageIndex, taskType };
}

function resolveAiMarkerLinkedAnchorScope(
	state: ProjectState,
	pageIndex: number,
	input: { linkedTaskIds?: string[]; linkedCommentIds?: string[] },
): { taskTypes: WorkflowTaskType[] } | { error: string; status: number } {
	const taskTypes = new Set<WorkflowTaskType>();
	for (const taskId of input.linkedTaskIds ?? []) {
		const task = resolveLinkedTask(state, taskId);
		if (!task) return { error: "Linked task not found", status: 400 };
		if (task.pageIndex !== pageIndex) return { error: "Linked task does not belong to marker page", status: 400 };
		taskTypes.add(task.type);
	}

	for (const commentId of input.linkedCommentIds ?? []) {
		const commentPageIndex = resolveLinkedCommentPageIndex(state, commentId);
		if (commentPageIndex === null) return { error: "Linked comment not found", status: 400 };
		if (commentPageIndex !== pageIndex) return { error: "Linked comment does not belong to marker page", status: 400 };
	}

	return { taskTypes: [...taskTypes] };
}

export function canReadProjectForUser(state: ProjectState, user?: JWTPayload): boolean {
	if (state.workspaceId?.trim()) return false;
	if (!user) return !state.userId && allowsLegacyAnonymousProjectAccess();
	if (!state.userId || state.userId === user.userId) return true;
	// A chapter-team ACTIVE member gets scoped read access to a personal project they
	// don't own (the invite/accept flow wired their userId onto the roster). Pending
	// (email-only) invites are NOT active and stay excluded.
	return isActiveChapterTeamMember(state, user.userId);
}

interface ProjectSummaryListOptions {
	limit?: number;
	cursor?: string;
	includeFileFallback?: boolean;
	// Workspace-scoped Library (P1): bound the listing to one workspace at the
	// catalog source. Membership is verified by the caller BEFORE this runs.
	workspaceId?: string;
}

function projectSummaryCacheKey(user: JWTPayload | undefined, options: ProjectSummaryListOptions): string {
	return JSON.stringify({
		userId: user?.userId ?? "anonymous",
		apiAuthRequired: serverConfig.apiAuthRequired,
		allowLegacyAnonymousProjects: serverConfig.allowLegacyAnonymousProjects,
		limit: options.limit ?? 100,
		cursor: options.cursor ?? "",
		includeFileFallback: shouldIncludeProjectFileFallback(options),
		// A workspace-scoped page is a DIFFERENT result set than the unscoped (or
		// another workspace's) one — key on it so the cache never serves a stale
		// cross-workspace listing.
		workspaceId: options.workspaceId ?? "",
	});
}

function shouldIncludeProjectFileFallback(options: ProjectSummaryListOptions): boolean {
	return serverConfig.projectCatalogFileFallbackEnabled && options.includeFileFallback !== false;
}

async function listProjectSummaryPage(user?: JWTPayload, options: ProjectSummaryListOptions = {}): Promise<ProjectSummaryPage> {
	const cacheKey = projectSummaryCacheKey(user, options);
	const cached = projectSummaryCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const workspaceId = options.workspaceId?.trim() || undefined;
	let page: ProjectSummaryPage;
	if (projectCatalogStore) {
		// A workspace-scoped listing is sourced ENTIRELY from the catalog store's
		// workspace filter (which also enforces per-member scope). The file fallback
		// only ever surfaces ownerless/legacy PERSONAL projects (no workspace stamp),
		// so it can contribute nothing to a workspace page — and merging it would
		// re-introduce cross-scope rows. Skip it when a workspace is requested.
		const includeFileFallback = !workspaceId && shouldIncludeProjectFileFallback(options);
		const catalogPage = await projectCatalogStore.listProjectSummaryPage({
			userId: user?.userId,
			workspaceId,
			limit: options.limit,
			cursor: options.cursor,
		});
		if (!includeFileFallback) {
			page = catalogPage;
		} else {
			const fileSummaries = listProjectSummariesFromFiles(user);
			await backfillMissingCatalogSummaries(fileSummaries);
			const mergedPage = paginateProjectSummaries(
				mergeProjectSummaries(catalogPage.projects, fileSummaries),
				{ cursor: options.cursor, limit: options.limit },
			);
			page = {
				projects: mergedPage.projects,
				nextCursor: mergedPage.nextCursor ?? catalogPage.nextCursor,
			};
		}
	} else {
		page = paginateProjectSummaries(listProjectSummariesFromFiles(user), {
			cursor: options.cursor,
			limit: options.limit,
		});
	}
	projectSummaryCache.set(cacheKey, page);
	return page;
}

async function backfillMissingCatalogSummaries(
	fileSummaries: ProjectSummary[],
): Promise<void> {
	if (!projectCatalogStore || fileSummaries.length === 0) return;
	let catalogIds: Set<string>;
	try {
		catalogIds = await projectCatalogStore.findExistingProjectIds(fileSummaries.map((summary) => summary.projectId));
	} catch (error) {
		console.warn("Failed to check existing project catalog rows before backfill", { error });
		return;
	}
	const missingSummaries = fileSummaries.filter((summary) => !catalogIds.has(summary.projectId));
	for (const summary of missingSummaries) {
		try {
			const state = readProjectStateFromFile(summary.projectId);
			if (!state) continue;
			await projectCatalogStore.upsertProjectState(state, { updatedAt: summary.updatedAt });
		} catch (error) {
			console.warn("Failed to backfill project catalog row", { projectId: summary.projectId, error });
		}
	}
}

function listProjectSummariesFromFiles(user?: JWTPayload): ProjectSummary[] {
	const summaries = readdirSync(PROJECTS_DIR)
		.filter((entry) => isValidProjectId(entry))
		// A permanently-deleted project must never reappear in a listing, even if a
		// stale state.json survived a partial delete (it stays gone via its tombstone).
		.filter((projectId) => !isProjectTombstoned(projectId))
		.map((projectId): ProjectSummary | null => {
			try {
					const statePath = safePath(PROJECTS_DIR, projectId, "state.json");
					if (!existsSync(statePath)) return null;
					const state = readJsonFile<ProjectState>(statePath);
					if (!canReadProjectForUser(state, user)) return null;
					const targetLangs = normalizeTargetLangs({ targetLang: state.targetLang, targetLangs: state.targetLangs });
					return {
						projectId,
						name: state.name,
					createdAt: state.createdAt,
					updatedAt: statSync(statePath).mtime.toISOString(),
					storyId: state.storyId,
					storyTitle: state.storyTitle,
					chapterNumber: state.chapterNumber,
					chapterTitle: state.chapterTitle,
					chapterLabel: state.chapterLabel,
						readingDirection: state.readingDirection,
						...getProjectCoverSummary(state),
						sourceLang: state.sourceLang ?? "ja",
						targetLang: targetLangs[0] ?? "th",
						targetLangs,
					pageCount: state.pages.length,
					textLayerCount: countTextLayers(state),
					taskCount: state.tasks?.length ?? 0,
					openTaskCount: countOpenTasks(state),
					reviewTaskCount: countOpenReviewTasks(state),
					commentCount: state.comments?.length ?? 0,
					openCommentCount: countOpenComments(state),
				};
			} catch {
				return null;
			}
		})
		.filter((summary): summary is ProjectSummary => Boolean(summary))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.projectId.localeCompare(a.projectId));
	return summaries;
}

function pruneProjectVersions(projectId: string, protectedVersionIds = new Set<string>()): string[] {
	const versionsDir = getProjectVersionsDir(projectId);
	const versions = listProjectVersions(projectId);
	const deletedVersionIds: string[] = [];
	let keptUnprotectedVersions = 0;
	for (const version of versions) {
		if (protectedVersionIds.has(version.versionId)) continue;
		// Named snapshots are explicit user intent — never prune them by the cap.
		if (version.source === "manual") continue;
		keptUnprotectedVersions += 1;
		if (keptUnprotectedVersions <= MAX_PROJECT_VERSIONS) continue;
		const versionPath = safePath(versionsDir, `${version.versionId}.json`);
		if (existsSync(versionPath)) unlinkSync(versionPath);
		deletedVersionIds.push(version.versionId);
	}
	return deletedVersionIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathTail(value: string): string {
	return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

const importPathCollator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

function asPageIndex(value: unknown): number | undefined {
	const numeric = asNumber(value);
	if (numeric !== undefined) return numeric;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Number.parseInt(value.trim(), 10);
	}
	return undefined;
}

function pageMatchesIdentifier(page: ProjectState["pages"][number], identifier: string): boolean {
	const normalized = pathTail(identifier.trim());
	const candidates = [page.imageId, page.imageName, page.originalName].filter(Boolean) as string[];
	return candidates.some((candidate) => {
		const candidateTail = pathTail(candidate);
		return candidate === identifier || candidate === normalized || candidateTail === normalized;
	});
}

function importImagePathKey(value: string): string {
	return pathTail(value.trim()).toLowerCase();
}

function getImportImagePath(item: Record<string, unknown>, fallbackImagePath?: string): string | undefined {
	return asString(item.image_path) ?? asString(item.imagePath) ?? asString(item.path) ?? fallbackImagePath;
}

function hasExplicitImportPageLocator(item: Record<string, unknown>): boolean {
	return asPageIndex(item.pageIndex) !== undefined
		|| asPageIndex(item.pageNumber) !== undefined
		|| asPageIndex(item.page) !== undefined
		|| asString(item.assetId) !== undefined
		|| asString(item.imageId) !== undefined
		|| asString(item.imageName) !== undefined
		|| asString(item.fileName) !== undefined
		|| asString(item.filename) !== undefined;
}

function buildImportImagePathOrderFallback(
	state: ProjectState,
	entries: unknown[],
	fallbackImagePath?: string,
): Map<string, number> {
	const reservedPageIndexes = new Set<number>();
	const unmatchedPaths = new Map<string, string>();

	for (const entry of entries) {
		if (!isRecord(entry) || hasExplicitImportPageLocator(entry)) continue;
		const rawImagePath = getImportImagePath(entry, fallbackImagePath);
		if (!rawImagePath) continue;

		const directPageIndex = state.pages.findIndex((page) => pageMatchesIdentifier(page, rawImagePath));
		if (directPageIndex >= 0) {
			reservedPageIndexes.add(directPageIndex);
			continue;
		}

		const key = importImagePathKey(rawImagePath);
		if (key && !unmatchedPaths.has(key)) {
			unmatchedPaths.set(key, rawImagePath);
		}
	}

	const availablePageIndexes = state.pages
		.map((_, pageIndex) => pageIndex)
		.filter((pageIndex) => !reservedPageIndexes.has(pageIndex));
	const orderedUnmatchedKeys = Array.from(unmatchedPaths.entries())
		.sort((a, b) => importPathCollator.compare(pathTail(a[1]), pathTail(b[1])))
		.map(([key]) => key);
	if (orderedUnmatchedKeys.length !== availablePageIndexes.length) {
		return new Map();
	}
	const fallback = new Map<string, number>();
	for (let index = 0; index < orderedUnmatchedKeys.length && index < availablePageIndexes.length; index += 1) {
		const key = orderedUnmatchedKeys[index];
		const pageIndex = availablePageIndexes[index];
		if (key === undefined || pageIndex === undefined) continue;
		fallback.set(key, pageIndex);
	}
	return fallback;
}

interface ImportSourceFilter {
	pageIndex?: number;
	imageIdentifier?: string;
}

interface ResolvedImportMapping {
	targetPageIndex: number;
	targetPage: ProjectState["pages"][number];
	sourceFilter: ImportSourceFilter;
	imported: number;
}

function getImportSourceFilter(value: {
	sourcePageIndex?: number;
	sourcePageNumber?: number;
	sourcePage?: number;
	sourceImagePath?: string;
	sourceImageName?: string;
	sourceFileName?: string;
}): ImportSourceFilter | null {
	const sourcePageIndex = value.sourcePageIndex
		?? (value.sourcePageNumber !== undefined ? value.sourcePageNumber - 1 : undefined)
		?? (value.sourcePage !== undefined ? value.sourcePage - 1 : undefined);
	const imageIdentifier = value.sourceImagePath ?? value.sourceImageName ?? value.sourceFileName;
	if (sourcePageIndex === undefined && !imageIdentifier) return null;
	return {
		pageIndex: sourcePageIndex,
		imageIdentifier,
	};
}

function importSourceFilterKey(filter: ImportSourceFilter): string {
	return `${filter.pageIndex ?? ""}::${filter.imageIdentifier ? importImagePathKey(filter.imageIdentifier) : ""}`;
}

function getEntrySourcePageIndex(item: Record<string, unknown>): number | undefined {
	const pageIndex = asPageIndex(item.pageIndex);
	if (pageIndex !== undefined) return pageIndex;
	const pageNumber = asPageIndex(item.pageNumber) ?? asPageIndex(item.page);
	return pageNumber === undefined ? undefined : pageNumber - 1;
}

function getEntryImageIdentifiers(item: Record<string, unknown>, fallbackImagePath?: string): string[] {
	return [
		asString(item.assetId),
		asString(item.imageId),
		asString(item.imageName),
		asString(item.fileName),
		asString(item.filename),
		getImportImagePath(item, fallbackImagePath),
	].filter((value): value is string => Boolean(value));
}

function importIdentifierMatches(left: string, right: string): boolean {
	const leftKey = importImagePathKey(left);
	const rightKey = importImagePathKey(right);
	return left.trim() === right.trim() || leftKey === rightKey;
}

function entryMatchesImportSourceFilter(
	item: Record<string, unknown>,
	filter: ImportSourceFilter,
	fallbackImagePath?: string,
): boolean {
	const comparisons: boolean[] = [];
	if (filter.pageIndex !== undefined) {
		const entryPageIndex = getEntrySourcePageIndex(item);
		if (entryPageIndex !== undefined) {
			comparisons.push(entryPageIndex === filter.pageIndex);
		}
	}
	if (filter.imageIdentifier) {
		const identifiers = getEntryImageIdentifiers(item, fallbackImagePath);
		if (identifiers.length) {
			comparisons.push(identifiers.some((identifier) => importIdentifierMatches(identifier, filter.imageIdentifier!)));
		}
	}
	return comparisons.some(Boolean);
}

function serializeImportSourceMapping(mapping: {
	targetPageIndex: number;
	sourceFilter: ImportSourceFilter;
	imported?: number;
	sourceFiltered?: number;
}) {
	return {
		targetPageIndex: mapping.targetPageIndex,
		sourcePageIndex: mapping.sourceFilter.pageIndex,
		sourcePageNumber: mapping.sourceFilter.pageIndex === undefined ? undefined : mapping.sourceFilter.pageIndex + 1,
		sourceImage: mapping.sourceFilter.imageIdentifier,
		imported: mapping.imported,
		ignoredEntries: mapping.sourceFiltered ?? 0,
	};
}

function shouldReportOrderFallbackMapping(
	state: ProjectState,
	item: Record<string, unknown>,
	fallbackImagePath: string | undefined,
	imagePathOrderFallback: Map<string, number>,
): string | null {
	if (hasExplicitImportPageLocator(item)) return null;
	const rawImagePath = getImportImagePath(item, fallbackImagePath);
	if (!rawImagePath) return null;
	if (state.pages.some((page) => pageMatchesIdentifier(page, rawImagePath))) return null;
	const key = importImagePathKey(rawImagePath);
	return imagePathOrderFallback.has(key) ? pathTail(rawImagePath) : null;
}

function findImportPage(
	state: ProjectState,
	item: Record<string, unknown>,
	fallbackPageIndex?: number,
	fallbackImagePath?: string,
	imagePathOrderFallback?: Map<string, number>,
) {
	const pageIndex = asPageIndex(item.pageIndex);
	if (pageIndex !== undefined && Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < state.pages.length) {
		return state.pages[pageIndex];
	}

	const pageNumber = asPageIndex(item.pageNumber) ?? asPageIndex(item.page);
	if (pageNumber !== undefined && Number.isInteger(pageNumber)) {
		const zeroBasedIndex = pageNumber - 1;
		if (zeroBasedIndex >= 0 && zeroBasedIndex < state.pages.length) {
			return state.pages[zeroBasedIndex];
		}
		return null;
	}

	const imageIdentifier =
		asString(item.assetId) ??
		asString(item.imageId) ??
		asString(item.imageName) ??
		asString(item.fileName) ??
		asString(item.filename);
	if (imageIdentifier) {
		return state.pages.find((page) => pageMatchesIdentifier(page, imageIdentifier)) ?? null;
	}

	const rawImagePath = getImportImagePath(item, fallbackImagePath);
	if (rawImagePath) {
		const directPage = state.pages.find((page) => pageMatchesIdentifier(page, rawImagePath));
		if (directPage) return directPage;
		const fallbackIndex = imagePathOrderFallback?.get(importImagePathKey(rawImagePath));
		return fallbackIndex === undefined ? null : state.pages[fallbackIndex] ?? null;
	}

	const fallbackIndex = fallbackPageIndex;
	if (fallbackIndex !== undefined && Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < state.pages.length) {
		return state.pages[fallbackIndex];
	}
	return state.pages[state.currentPage] ?? null;
}

function readBox(item: Record<string, unknown>): { x: number; y: number; w: number; h: number } {
	const bbox = Array.isArray(item.bbox) ? item.bbox.map(asNumber) : undefined;
	if (bbox?.length === 4 && bbox.every((value) => value !== undefined)) {
		const [x, y, w, h] = bbox as [number, number, number, number];
		return {
			x: Math.max(0, Math.round(x)),
			y: Math.max(0, Math.round(y)),
			w: Math.max(1, Math.round(w)),
			h: Math.max(1, Math.round(h)),
		};
	}

	const box = Array.isArray(item.box) ? item.box.map(asNumber) : undefined;
	if (box?.length === 4 && box.every((value) => value !== undefined)) {
		const [x1, y1, x2, y2] = box as [number, number, number, number];
		const left = Math.min(x1, x2);
		const top = Math.min(y1, y2);
		return {
			x: Math.max(0, Math.round(left)),
			y: Math.max(0, Math.round(top)),
			w: Math.max(1, Math.round(Math.abs(x2 - x1))),
			h: Math.max(1, Math.round(Math.abs(y2 - y1))),
		};
	}

	return { x: 0, y: 0, w: 220, h: 80 };
}

function estimateImportedFontSize(text: string, box: { w: number; h: number }): number {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return 16;

	let low = 10;
	let high = 36;
	let best = 16;

	while (low <= high) {
		const fontSize = Math.floor((low + high) / 2);
		const averageGlyphWidth = fontSize * 0.58;
		const usableWidth = Math.max(1, box.w * 0.88);
		const charsPerLine = Math.max(1, Math.floor(usableWidth / averageGlyphWidth));
		const estimatedLines = Math.max(1, Math.ceil(normalized.length / charsPerLine));
		const estimatedHeight = estimatedLines * fontSize * 1.18;
		const fitsHeight = estimatedHeight <= box.h * 0.78;
		const fitsWidth = fontSize <= box.w * 0.18;

		if (fitsHeight && fitsWidth) {
			best = fontSize;
			low = fontSize + 1;
		} else {
			high = fontSize - 1;
		}
	}

	return Math.max(10, Math.min(36, best));
}

const TEXT_LAYER_SOURCE_CATEGORIES: readonly TextLayerSourceCategory[] = [
	"dialogue",
	"narration",
	"sfx",
	"sign",
	"title",
	"credit",
	"logo",
	"page_number",
	"other",
];

function normalizeImportedSourceCategory(value: string | undefined): TextLayerSourceCategory | undefined {
	if (value === undefined) return undefined;
	return (TEXT_LAYER_SOURCE_CATEGORIES as readonly string[]).includes(value)
		? (value as TextLayerSourceCategory)
		: undefined;
}

function normalizeImportedLayer(item: Record<string, unknown>, index: number) {
	const explicitTranslation = "translated_text" in item || "translation" in item || "thai" in item || "targetText" in item;
	const translatedText =
		asString(item.translated_text) ??
		asString(item.translation) ??
		asString(item.thai) ??
		asString(item.targetText);
	const sourceText =
		asString(item.original_text) ??
		asString(item.sourceText) ??
		asString(item.source_text) ??
		asString(item.text);

	if (explicitTranslation && !translatedText?.trim()) return null;

	const text = (translatedText?.trim() || sourceText?.trim() || "").trim();
	if (!text) return null;

	const box = readBox(item);
	const category = asString(item.cat) ?? asString(item.category);
	const confidence = asNumber(item.confidence);
	const importedFontSize = estimateImportedFontSize(text, box);

	return {
		id: uuid(),
		text,
		sourceText,
		sourceCategory: normalizeImportedSourceCategory(category),
		sourceProvider: "json-import",
		confidence,
		protected: item.protected === true,
		x: box.x,
		y: box.y,
		w: box.w,
		h: box.h,
		rotation: asNumber(item.rotation) ?? asNumber(item.angle) ?? 0,
		fontSize: importedFontSize,
		alignment: "center" as const,
		index: asNumber(item.index) ?? index,
	};
}

/**
 * Append an imported text layer to the correct Language Track of a page (Stream C).
 *
 * - DEFAULT track: pushes onto the flat `page.textLayers` exactly as before, so
 *   single-language / legacy projects stay byte-identical and never grow a
 *   `languageOutputs` map.
 * - NON-default track: materializes into `page.languageOutputs[lang]`. The bucket
 *   is seeded from the page's source layout (the flat fields) on first write — the
 *   same product rule the frontend `seedTrackOutput`/`writeTrackTextLayers` use —
 *   so an imported translation lands on its own track without polluting the shared
 *   flat layer or the default track. Mutates the page in place.
 *
 * Returns the layer array the imported layer was appended to (so the caller can
 * stamp the per-track index).
 */
function appendImportedLayerToTrack(
	page: PageState,
	lang: string,
	isDefault: boolean,
	layer: TextLayerData,
): void {
	if (isDefault) {
		if (!page.textLayers) page.textLayers = [];
		page.textLayers.push({ ...layer, index: layer.index ?? page.textLayers.length });
		return;
	}
	if (!page.languageOutputs) page.languageOutputs = {};
	let bucket = page.languageOutputs[lang];
	if (!bucket) {
		// Seed a fresh non-default track from the source layout (copied boxes/styles),
		// mirroring the frontend `seedTrackOutput`. Handoffs are workflow state, not
		// layout, so a fresh track starts without them.
		bucket = {
			textLayers: (page.textLayers ?? []).map((source) => ({ ...source })),
			...(page.translationScriptSlots !== undefined
				? { translationScriptSlots: page.translationScriptSlots.map((slot) => ({ ...slot })) }
				: {}),
		};
		page.languageOutputs[lang] = bucket;
	}
	bucket.textLayers.push({ ...layer, index: layer.index ?? bucket.textLayers.length });
}

type ImportSkipReason = "invalid_entry" | "page_not_found" | "invalid_layer";

function createSkipSummary(): Record<ImportSkipReason, number> {
	return {
		invalid_entry: 0,
		page_not_found: 0,
		invalid_layer: 0,
	};
}

// Check if the authenticated user owns this project
// Returns null if access is allowed, or a Response if access is denied
// Permissions an ACTIVE chapter-team member (non-owner) is granted on the chapter
// they were invited to: read the project and work on it (edit/save/AI), but NOT
// destructive/ownership-only actions (delete) — those stay with the owner/lead.
// An empty permission (legacy unscoped check) is treated as read-equivalent access.
function chapterTeamPermissionGranted(permission: string | undefined): boolean {
	if (!permission) return true;
	return permission === "read:project"
		|| permission === "update:project"
		|| permission === "generate:ai";
}

export async function checkProjectOwnership(
	c: any,
	project: ProjectState,
	permission = inferProjectPermission(c),
	scopeCheck: WorkspaceScopeCheck = {},
): Promise<Response | null> {
	const user = getAuthUser(c) as JWTPayload | undefined;

	// Wave 0 W0.1: close the multi-tenant backward-compat hatch.
	// Previously: anonymous requests were allowed on projects whose state had no
	// userId AND no workspaceId. That hatch is now gated by two flags:
	//   - apiAuthRequired (prod posture) MUST be false, AND
	//   - allowLegacyAnonymousProjects MUST be explicitly opted in.
	// Anything else → 401 Unauthorized.
	if (!user) {
		if (project.userId || project.workspaceId?.trim()) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		if (!allowsLegacyAnonymousProjectAccess()) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		// Legacy prototype project (no userId, no workspaceId) explicitly allowed
		// via ALLOW_LEGACY_ANONYMOUS_PROJECTS=true in non-prod posture.
		warnLegacyAnonymousProjectAccess(project.projectId);
		return null;
	}

	if (project.workspaceId?.trim()) {
		if (project.projectId && projectCatalogStore && await projectCatalogStore.canAccessProject({
			projectId: project.projectId,
			userId: user.userId,
			permission,
			...scopeCheck,
		})) {
			return null;
		}
		// Chapter-team grant (workspace project): an ACTIVE chapter-team member gets the
		// same scoped read+work access as on a personal project, even if they are not a
		// workspace-level member. Pending invites and destructive permissions are excluded.
		// FREEZE gate: the chapter-team fallback BYPASSES the catalog `canAccessProject`
		// path, so it must consult the same suspension truth — a frozen workspace blocks
		// the fallback's MUTATING grants (update:project / generate:ai) for everyone while
		// still allowing reads.
		if (chapterTeamPermissionGranted(permission) && isActiveChapterTeamMember(project, user.userId)) {
			// REVOCATION gate: removal from the WORKSPACE revokes the chapter-team
			// fallback too. removeMember only soft-disables the membership row and
			// never syncs state.chapterTeam, so without this check an ex-member kept
			// read+SAVE access through the stale roster entry (P1, live-proven).
			// A never-member external chapter collaborator has no membership row and
			// passes; re-inviting clears disabled_at and restores access.
			if (
				workspaceAccessStore
				&& await workspaceAccessStore.isMembershipRevoked(project.workspaceId.trim(), user.userId)
			) {
				return c.json({ error: "Project not found" }, 404);
			}
			if (
				isMutatingProjectPermission(permission)
				&& workspaceAccessStore
				&& await workspaceAccessStore.isWorkspaceSuspended(project.workspaceId.trim())
			) {
				return c.json({ error: "Workspace is suspended (payment refund/chargeback). Pay to restore access.", code: "workspace_suspended" }, 403);
			}
			return null;
		}
		return c.json({ error: "Project not found" }, 404);
	}

	// If project has userId, check ownership
	if (project.userId && project.userId !== user.userId) {
		if (project.projectId && projectCatalogStore && await projectCatalogStore.canAccessProject({
			projectId: project.projectId,
			userId: user.userId,
			permission,
			...scopeCheck,
		})) {
			return null;
		}
		// Chapter-team grant: an ACTIVE chapter-team member of a PERSONAL project they
		// don't own gets scoped read+work access (read/update/generate). The chapter IS
		// the project for a personal-mode chapter, so an active member may load + save it.
		// Pending invites grant nothing; destructive/ownership-only permissions (delete)
		// stay owner-only. Mirrors the workspace membership grant but for personal chapters.
		if (chapterTeamPermissionGranted(permission) && isActiveChapterTeamMember(project, user.userId)) {
			return null;
		}
		return c.json({ error: "Project not found" }, 404);
	}

	if (permission && !hasPermission(user.role, permission)) {
		return c.json({ error: `Forbidden: Missing permission '${permission}'` }, 403);
	}

	return null;
}

/**
 * Authorize a FULL-PROJECT-STATE mutation (a whole-`ProjectState` save or a full
 * version restore) that touches EVERY language track at once.
 *
 * Per-language scoping (workspace `scope.languages`) means a language-scoped
 * collaborator can pass a single-language `checkProjectOwnership({ language })`
 * check, yet a full-state write persists every language's `languageOutputs`. So a
 * full-state mutation must be authorized against ALL of the project's language
 * tracks (plus any extra tracks an incoming snapshot would introduce): we run the
 * per-language `update:project` check for each distinct language and return the
 * first denial. An UNSCOPED owner/editor (no `scope.languages` restriction) passes
 * every per-language check unchanged (`scopeListAllows([], lang)` is always true),
 * so their normal full save/restore is preserved byte-for-byte. A collaborator
 * scoped to a SUBSET of languages is rejected (403/404) on the first out-of-scope
 * track — they must use the per-language endpoints instead of a full-state write.
 */
async function checkFullProjectStateOwnership(
	c: any,
	state: ProjectState,
	_extraLanguages: Iterable<string> = [],
): Promise<Response | null> {
	// A full-state save / full version restore writes SHARED, non-language project
	// state in addition to every language track, so it must require TRULY
	// project-wide (unscoped) access — NOT merely a per-language check repeated for
	// each current track. A previous per-language loop let a member whose
	// `scope.languages` happened to cover ALL current tracks pass every check and
	// full-save/restore the whole project (including shared project state) — that is
	// not unscoped project-wide access. `requireProjectWide` rejects any member with
	// ANY fine-grained scope restriction (languages/projectIds/chapter/page/task/asset),
	// even one whose lists currently cover every track. A genuine project-wide
	// owner/editor (no scope restriction) passes unchanged; a scoped collaborator must
	// use the per-language / per-page endpoints, whose single-resource checks remain.
	return checkProjectOwnership(c, state, "update:project", { requireProjectWide: true });
}

function preserveProjectIdentityFields(target: ProjectState, current: ProjectState): void {
	target.userId = current.userId;
	// The stable story key (#244) is server-owned: a save can rename the cosmetic
	// `storyTitle` but must NEVER mutate `storyId`, otherwise a rename would break
	// the `/library/<storyId>-<slug>` routing and split a story into two groups.
	if (current.storyId) {
		target.storyId = current.storyId;
	} else {
		delete target.storyId;
	}
	if (current.workspaceId?.trim()) {
		target.workspaceId = current.workspaceId;
	} else {
		delete target.workspaceId;
	}
	target.sourceLang = target.sourceLang?.trim() || current.sourceLang || "ja";
	// Language tracks are server-owned for MULTI-TRACK projects. The save path must
	// NOT be a track-mutation backdoor: once a project has more than one language
	// track, `body.targetLangs`/`body.targetLang` are IGNORED here and the persisted
	// set is sourced exclusively from the CURRENT state. Adding/removing tracks (and
	// the not-last / not-primary invariant) is gated solely through the dedicated
	// POST/DELETE /:id/languages endpoints, which run scope checks. The active primary
	// is pinned to the current set's first entry, so an incoming value can neither add
	// a track (via normalizeTargetLangs appending an unknown value) nor drop/replace
	// the primary.
	//
	// For SINGLE-LANGUAGE / legacy projects (≤1 track), the legitimate flow of editing
	// the one target language on save is preserved: the incoming single `targetLang`
	// is honored, but the project stays single-track (body.targetLangs cannot add a
	// second track here). The save route's own scope check on `body.targetLang` still
	// rejects an out-of-scope single-language change at the route level.
	const currentTracks = normalizeTargetLangs({
		targetLang: current.targetLang,
		targetLangs: current.targetLangs,
	});
	if (currentTracks.length > 1) {
		target.targetLangs = currentTracks;
		target.targetLang = currentTracks[0] ?? "th";
	} else {
		const lang = target.targetLang?.trim() || current.targetLang;
		const singleTrack = normalizeTargetLangs({ targetLang: lang });
		target.targetLangs = singleTrack;
		target.targetLang = singleTrack[0] ?? "th";
	}
}

async function checkProjectTaskAccess(c: any, state: ProjectState, task: WorkflowTask, permission = "update:project"): Promise<Response | null> {
	return checkProjectOwnership(c, state, permission, {
		language: state.targetLang,
		pageIndex: task.pageIndex,
		taskType: task.type,
		resourceKind: "task",
	});
}

/**
 * Authorize an action on an AI review marker against the marker's ACTUAL scope
 * (its page + language + the `review` workflow), rather than an empty project-wide
 * context. A reviewer scoped to a specific page/task-type would otherwise be denied
 * by `isFineGrainedProjectWideAccess` (a scoped reviewer with an undefined
 * pageIndex/taskType is treated as "asking for everything") BEFORE the marker is
 * even loaded — locking a legitimately page/task-scoped reviewer out of their own
 * in-scope marker. Resolve the marker first, then pass its page/lang/review scope
 * here. Unscoped owners/editors are unaffected. This does NOT widen access: it
 * authorizes against the marker's real scope, so an out-of-scope marker still 403s.
 */
async function checkAiReviewMarkerAccess(
	c: any,
	state: ProjectState,
	marker: AiReviewMarker,
	permission = "update:project",
): Promise<Response | null> {
	return checkProjectOwnership(c, state, permission, {
		language: marker.targetLang ?? state.targetLang,
		pageIndex: marker.pageIndex,
		taskType: "review",
		resourceKind: "review",
	});
}

function parseWorkflowTaskIdScope(taskId: string): { pageIndex: number; taskType: WorkflowTaskType } | null {
	const match = /^page-(\d+)-([a-z]+)(?:-.+)?$/.exec(taskId);
	if (!match) return null;
	const pageIndex = Number(match[1]);
	const taskType = match[2] as WorkflowTaskType;
	if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || !WORKFLOW_TASK_TYPES.includes(taskType)) {
		return null;
	}
	return { pageIndex, taskType };
}

async function checkProjectTaskIdScopeAccess(
	c: any,
	state: ProjectState,
	taskId: string,
	permission = "update:project",
): Promise<Response | null> {
	const taskScope = parseWorkflowTaskIdScope(taskId);
	return checkProjectOwnership(c, state, permission, taskScope
		? {
			language: state.targetLang,
			pageIndex: taskScope.pageIndex,
			taskType: taskScope.taskType,
			resourceKind: "task",
		}
		: { resourceKind: "task" });
}

/**
 * Evaluates a per-resource scope check for the bulk task path and returns the
 * same `Response | null` that `checkProjectOwnership` would for an equivalent
 * single call.
 */
type ProjectTaskScopeChecker = (scopeCheck: WorkspaceScopeCheck) => Response | null;

/**
 * Resolve the caller's project access ONCE for a batch of task checks, then hand
 * back an in-memory checker that authorizes each task without re-querying the
 * access store. This is the bulk-path equivalent of calling
 * `checkProjectOwnership` per task, with byte-for-byte identical response
 * semantics (401 anonymous / 404 not-a-member / 403 missing-permission /
 * 404 scope-denied), but O(1) store reads instead of O(n).
 *
 * Returns a `Response` when the whole batch is rejected up front (anonymous, or
 * the caller cannot access the project at all). Otherwise returns a
 * `ProjectTaskScopeChecker`.
 */
async function resolveProjectTaskScopeChecker(
	c: any,
	state: ProjectState,
	permission = "update:project",
): Promise<Response | ProjectTaskScopeChecker> {
	const user = getAuthUser(c) as JWTPayload | undefined;

	// Mirror checkProjectOwnership's anonymous handling exactly.
	if (!user) {
		if (state.userId || state.workspaceId?.trim()) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		if (!allowsLegacyAnonymousProjectAccess()) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		warnLegacyAnonymousProjectAccess(state.projectId);
		// Legacy anonymous prototype project: unscoped access to every task.
		return () => null;
	}

	const usesCatalogStore = Boolean(
		state.workspaceId?.trim() || (state.userId && state.userId !== user.userId),
	);

	if (usesCatalogStore) {
		// Catalog-store branch: resolve membership/role/scope ONCE. Denied access
		// (no membership row, disabled member, or insufficient role) maps to the
		// same 404 the per-task path returns; per-task scope mismatches also 404.
		const context = state.projectId && projectCatalogStore
			? await projectCatalogStore.resolveProjectAccessContext({
				projectId: state.projectId,
				userId: user.userId,
				permission,
			})
			: null;
		// Chapter-team grant: an ACTIVE chapter-team member who is NOT a workspace-level
		// member (e.g. an email-invite collaborator who accepted into this chapter) gets
		// the SAME whole-chapter scoped read/work access that `checkProjectOwnership`
		// grants them — the chapter IS the project, so they may list its tasks/comments.
		// This keeps the scoped-list endpoints (tasks/comments) consistent with the
		// project-load + review-assignment paths, which already honor the grant. Without
		// it a legitimately-assigned reviewer could load the project but get 404/422 when
		// the reader fetched the page comments (their own review marks), so the marks were
		// invisible to the assignee. Pending invites grant nothing (isActive… is false).
		// Only a HARD denial (not a scoped-member context) falls through to this grant,
		// so a genuinely scope-restricted workspace member is still bound by their scope.
		if ((!context || isProjectAccessFullyDenied(context))
			&& chapterTeamPermissionGranted(permission)
			&& isActiveChapterTeamMember(state, user.userId)) {
			// REVOCATION gate (mirror of checkProjectOwnership): a workspace-removed
			// user must not retain access through their stale chapterTeam entry.
			if (
				state.workspaceId?.trim()
				&& workspaceAccessStore
				&& await workspaceAccessStore.isMembershipRevoked(state.workspaceId.trim(), user.userId)
			) {
				return c.json({ error: "Project not found" }, 404);
			}
			// FREEZE gate: this fallback bypasses the catalog suspension check, so a
			// frozen workspace must still block the fallback's MUTATING grants for a
			// chapter-team-only member; reads pass.
			if (
				isMutatingProjectPermission(permission)
				&& state.workspaceId?.trim()
				&& workspaceAccessStore
				&& await workspaceAccessStore.isWorkspaceSuspended(state.workspaceId.trim())
			) {
				return c.json({ error: "Workspace is suspended (payment refund/chargeback). Pay to restore access.", code: "workspace_suspended" }, 403);
			}
			return () => null;
		}
		if (!context) {
			return c.json({ error: "Project not found" }, 404);
		}
		return (scopeCheck: WorkspaceScopeCheck) =>
			context.allows(scopeCheck) ? null : c.json({ error: "Project not found" }, 404);
	}

	// Owner (or no userId + no workspaceId) branch: no scope, just the role-level
	// permission gate. Resolved once; every task shares the same decision.
	if (permission && !hasPermission(user.role, permission)) {
		return c.json({ error: `Forbidden: Missing permission '${permission}'` }, 403);
	}
	return () => null;
}

function inferProjectPermission(c: any): string {
	const method = String(c.req.method ?? "GET").toUpperCase();
	const path = String(c.req.path ?? "");
	if (method === "GET" || method === "HEAD") return "read:project";
	if (path.endsWith("/import-json")) return "import:project";
	if (path.includes("/ai-markers/") && path.endsWith("/rerun")) return "generate:ai";
	if (path.includes("/exports/") && method === "POST") return "export:project";
	return "update:project";
}

function workspaceProjectCreateErrorResponse(c: any, error: unknown): Response {
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}

async function checkLanguageTrackManagementAccess(c: any, state: ProjectState, language: string): Promise<Response | null> {
	if (state.workspaceId?.trim()) {
		const user = getAuthUser(c) as JWTPayload | undefined;
		if (!user) return c.json({ error: "Unauthorized" }, 401);
		if (!workspaceAccessStore) {
			return c.json({
				error: "Workspace language track changes require a workspace access store",
				code: "workspace_language_track_store_unavailable",
			}, 503);
		}
		try {
			const member = await workspaceAccessStore.requirePermission(state.workspaceId, user.userId, "manage_projects");
			// Adding/removing a project LANGUAGE TRACK reshapes the shared, project-wide
			// `targetLangs` set (and re-pins the primary track) — it is NOT a per-language
			// edit confined to one track. The prior `workspaceScopeAllowsNewProject` check
			// deliberately PERMITS a `scope.languages`-scoped member as long as the track
			// matches their language, which let a language-scoped manager add/remove tracks
			// for the whole project. Track management must therefore require TRULY
			// project-wide (unscoped) authority: reject ANY fine-grained scope restriction
			// (languages/projectIds/chapterIds/pageIndexes/taskTypes/assetPurposes). An
			// unscoped owner/admin/editor with `manage_projects` passes unchanged.
			if (isFineGrainedScope(member.scope)) {
				throw new WorkspaceAccessError("Forbidden: workspace scope cannot manage this language track", 403, "workspace_language_track_scope_denied");
			}
			return null;
		} catch (error) {
			return workspaceProjectCreateErrorResponse(c, error);
		}
	}
	return checkProjectOwnership(c, state, "update:project", { language });
}

// Authorize a hard project delete. Workspace projects require the workspace
// `manage_projects` permission (the same gate that guards project creation /
// language-track management). Non-workspace / legacy projects require the app
// role `delete:project` (owner/admin only — editors cannot self-delete a project
// outside a workspace) via the shared ownership/permission check.
async function checkProjectDeleteAccess(c: any, state: ProjectState): Promise<Response | null> {
	if (state.workspaceId?.trim()) {
		const user = getAuthUser(c) as JWTPayload | undefined;
		if (!user) return c.json({ error: "Unauthorized" }, 401);
		if (!workspaceAccessStore) {
			return c.json({
				error: "Workspace project deletion requires a workspace access store",
				code: "workspace_project_delete_store_unavailable",
			}, 503);
		}
		try {
			const member = await workspaceAccessStore.requirePermission(state.workspaceId, user.userId, "manage_projects");
			// An IRREVERSIBLE whole-project delete destroys EVERY language track, page,
			// comment, review-decision, version, and on-disk asset — not just the slice a
			// scoped member may write. `requirePermission` only checks the role grant
			// (`manage_projects`), so a member who carries that permission but is confined
			// by a fine-grained `scope` (e.g. `languages:["fr"]`) would otherwise be able to
			// delete the entire project. Project delete therefore requires TRULY
			// project-wide (unscoped) authority: reject ANY fine-grained scope restriction.
			// An unscoped owner/admin/editor with `manage_projects` passes unchanged.
			if (isFineGrainedScope(member.scope)) {
				throw new WorkspaceAccessError("Forbidden: workspace scope cannot delete this project", 403, "workspace_project_delete_scope_denied");
			}
			return null;
		} catch (error) {
			return workspaceProjectCreateErrorResponse(c, error);
		}
	}
	return checkProjectOwnership(c, state, "delete:project", { language: state.targetLang });
}

// Authorize a CHAPTER TEAM MANAGEMENT mutation (set mode, invite, change role,
// remove). This requires TRUE owner/lead authority — NOT the scoped chapter-team
// `update:project` grant that an ACTIVE invited member carries (which only lets them
// read/save/generate on the chapter). Otherwise an invited member could invite,
// re-role, or remove other members (privilege escalation, codex P1-1).
//
//   - Workspace project: requires the workspace `manage_projects` permission AND
//     project-wide (unscoped) authority — a member confined to one language/page must
//     not reshape the whole chapter's team — exactly like language-track management /
//     delete. The chapter-team grant is deliberately NOT consulted here.
//   - Personal (non-workspace) project: requires being the actual project OWNER
//     (`state.userId === user.userId`) with the `update:project` role permission. We
//     check ownership DIRECTLY rather than via checkProjectOwnership(), because that
//     helper now also returns null for an active chapter-team member — which must NOT
//     be allowed to MANAGE the team.
async function checkChapterTeamManageAccess(c: any, state: ProjectState): Promise<Response | null> {
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	if (state.workspaceId?.trim()) {
		if (!workspaceAccessStore) {
			return c.json({
				error: "Chapter team changes require a workspace access store",
				code: "workspace_chapter_team_store_unavailable",
			}, 503);
		}
		try {
			const member = await workspaceAccessStore.requirePermission(state.workspaceId, user.userId, "manage_projects");
			if (isFineGrainedScope(member.scope)) {
				throw new WorkspaceAccessError("Forbidden: workspace scope cannot manage this chapter team", 403, "workspace_chapter_team_scope_denied");
			}
			return null;
		} catch (error) {
			return workspaceProjectCreateErrorResponse(c, error);
		}
	}

	// Personal project: only the true owner may manage the team. An active invited
	// member (state.userId !== user.userId) is rejected with the same 404 the project
	// uses for non-owners — they can work the chapter but never manage its roster.
	if (state.userId) {
		if (state.userId !== user.userId) {
			return c.json({ error: "Project not found" }, 404);
		}
		if (!hasPermission(user.role, "update:project")) {
			return c.json({ error: "Forbidden: Missing permission 'update:project'" }, 403);
		}
		return null;
	}

	// Legacy anonymous/ownerless project: fall back to the standard ownership check
	// (anonymous-access gating). No chapter-team grant applies without an owner.
	return checkProjectOwnership(c, state, "update:project", { language: state.targetLang });
}

/**
 * Authorize MANAGING review assignments (assign / update / cancel). Only a
 * workspace owner/lead (the `manage_members` permission, held by owner+admin)
 * may hand out or revoke review work — an editor/reviewer cannot reassign their
 * peers. Non-workspace / personal projects fall back to the owner check (the
 * personal owner manages their own review work). Mirrors
 * `checkProjectDeleteAccess` so the auth posture matches the rest of the route.
 */
async function checkReviewAssignmentManageAccess(c: any, state: ProjectState): Promise<Response | null> {
	if (state.workspaceId?.trim()) {
		const user = getAuthUser(c) as JWTPayload | undefined;
		if (!user) return c.json({ error: "Unauthorized" }, 401);
		if (!workspaceAccessStore) {
			return c.json({
				error: "Workspace review assignment requires a workspace access store",
				code: "workspace_review_assignment_store_unavailable",
			}, 503);
		}
		try {
			const member = await workspaceAccessStore.requirePermission(state.workspaceId, user.userId, "manage_members");
			if (isFineGrainedScope(member.scope)) {
				throw new WorkspaceAccessError("Forbidden: workspace scope cannot manage review/revision work", 403, "workspace_review_assignment_scope_denied");
			}
			return null;
		} catch (error) {
			return workspaceProjectCreateErrorResponse(c, error);
		}
	}
	return checkProjectOwnership(c, state, "update:project", { language: state.targetLang });
}

/**
 * Resolve a display handle for an ACTIVE chapter-team member, or `null` when the
 * user is not one. A chapter-team member earns scoped read+work access via
 * `isActiveChapterTeamMember` (see `checkProjectOwnership`), so they are a valid
 * recipient of review/revision work even though they may not be a workspace-level
 * member (e.g. an email-invite collaborator who accepted into one chapter). Prefers
 * the live account name/email, falling back to the roster's stored display fields.
 */
async function resolveActiveChapterTeamAssigneeHandle(
	state: ProjectState,
	assigneeUserId: string,
): Promise<string | null | undefined> {
	if (!isActiveChapterTeamMember(state, assigneeUserId)) return null;
	// REVOCATION gate (review #590 r2): a workspace-REMOVED user's stale roster
	// entry no longer grants project ACCESS, so they must not be a valid
	// assignment recipient either — otherwise owners mint review/revision work +
	// notifications for someone who will 404 on arrival. Never-member externals
	// (no membership row) stay assignable.
	if (
		state.workspaceId?.trim()
		&& workspaceAccessStore
		&& await workspaceAccessStore.isMembershipRevoked(state.workspaceId.trim(), assigneeUserId)
	) {
		return null;
	}
	const profile = await authUserStore.load(assigneeUserId).catch(() => null);
	if (profile?.name || profile?.email) return profile.name || profile.email;
	const member = getChapterTeam(state).find(
		(m) => m.status === "active" && m.userId === assigneeUserId,
	);
	return member?.displayName || member?.email || undefined;
}

/**
 * Validate that `assigneeUserId` may receive review/revision work on this project
 * and resolve a display handle for the rail badge. A valid recipient is either a
 * workspace member (workspace project) / the owner (personal project), OR an ACTIVE
 * chapter-team member — the latter is how an email/UID-invited collaborator (who is
 * NOT a workspace-level member) is handed work on the one chapter they joined,
 * mirroring the scoped access `checkProjectOwnership` already grants them. Returns
 * `{ error }` (a 4xx body) or the resolved `{ handle }`.
 */
async function resolveReviewAssignee(
	c: any,
	state: ProjectState,
	assigneeUserId: string,
): Promise<{ handle?: string } | { error: Response }> {
	const workspaceId = state.workspaceId?.trim();
	if (!workspaceId) {
		const user = getAuthUser(c) as JWTPayload | undefined;
		const ownerId = user?.userId ?? state.userId;
		if (assigneeUserId === ownerId) {
			return { handle: user?.email };
		}
		// A personal chapter in Team mode can have active members who joined via an
		// invite — they are legitimate work recipients on this chapter.
		const teamHandle = await resolveActiveChapterTeamAssigneeHandle(state, assigneeUserId);
		if (teamHandle !== null) return { handle: teamHandle };
		return { error: c.json({ error: "Assignee must be a workspace member", code: "review_assignee_not_member" }, 422) };
	}
	if (!workspaceAccessStore) {
		return { error: c.json({ error: "Workspace review assignment requires a workspace access store", code: "workspace_review_assignment_store_unavailable" }, 503) };
	}
	const member = await workspaceAccessStore.getMember(workspaceId, assigneeUserId).catch(() => null);
	if (!member) {
		// Not a workspace-level member — but an active chapter-team member (e.g. an
		// email-invite collaborator who accepted into this chapter) has scoped work
		// access and may still be assigned review/revision work on this chapter.
		const teamHandle = await resolveActiveChapterTeamAssigneeHandle(state, assigneeUserId);
		if (teamHandle !== null) return { handle: teamHandle };
		return { error: c.json({ error: "Assignee must be a workspace member", code: "review_assignee_not_member" }, 422) };
	}
	const profile = await authUserStore.load(assigneeUserId).catch(() => null);
	return { handle: profile?.name || profile?.email || undefined };
}


function normalizeProjectLanguageTracks(state: ProjectState): string[] {
	const targetLangs = normalizeTargetLangs({
		targetLang: state.targetLang,
		targetLangs: state.targetLangs,
	});
	state.targetLangs = targetLangs;
	state.targetLang = targetLangs[0] ?? "th";
	return targetLangs;
}

/**
 * Resolve a comment's bare `@handle` mentions to workspace-member user IDs and
 * `notify()` each one — the realtime/notification half of P1.6 (mentions were
 * previously stored as inert strings and only surfaced via SSE/activity, so a
 * mentioned reviewer was never actually pinged).
 *
 * Tenant-scoped by construction: candidates are sourced ONLY from the comment's
 * own workspace membership, so a handle can never resolve to a user outside this
 * workspace. The author is skipped (no self-ping). Best-effort throughout: a
 * realtime/notification failure never fails the comment write. Returns the
 * resolved member user IDs (for the caller to persist on the comment + tests).
 */
/**
 * Resolve `@handle` mention strings to workspace-member user IDs, tenant-scoped to
 * the project's OWN workspace. Shared by the comment and review mention notifiers
 * so a handle can never resolve to a user outside this workspace (candidates are
 * sourced ONLY from THIS workspace's membership). Returns [] on any store failure
 * (best-effort — mention resolution never fails the business write). The author is
 * skipped (no self-ping) and the result is de-duplicated.
 */
async function resolveWorkspaceMentionUserIds(input: {
	workspaceId: string;
	projectId: string;
	mentions: string[];
	authorUserId?: string;
}): Promise<string[]> {
	const { workspaceId, projectId, mentions, authorUserId } = input;
	if (mentions.length === 0 || !workspaceAccessStore) return [];
	let candidates: MentionCandidate[] = [];
	try {
		// Single round-trip in the all-Postgres config (JOIN to auth_users); a
		// per-member loop via the configured auth store otherwise — including the
		// mixed config (Postgres workspace store + file auth store) where the JOIN
		// would find no rows. `authUserStore` carries the `kind` discriminator the
		// store uses to choose. Replaces the former 2N-query N+1 that called
		// authUserStore.load() per member (each = 2 SELECTs, the second an unused
		// external-identity read). Shape is identical to before: { userId, name?,
		// email? }, fed straight into resolveCommentMentions.
		candidates = await workspaceAccessStore.listMentionCandidates(workspaceId, authUserStore);
	} catch (error) {
		console.warn(`[project] mention resolve failed for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	return resolveCommentMentions({ mentions, candidates, authorUserId });
}

async function notifyCommentMentions(input: {
	state: ProjectState;
	projectId: string;
	comment: ProjectComment;
	authorUserId?: string;
	notifyType: "comment_new" | "comment_reply";
}): Promise<string[]> {
	const { state, projectId, comment, authorUserId, notifyType } = input;
	const workspaceId = state.workspaceId?.trim();
	const mentions = comment.mentions ?? [];
	if (!workspaceId || mentions.length === 0) return [];

	const mentionedUserIds = await resolveWorkspaceMentionUserIds({ workspaceId, projectId, mentions, authorUserId });
	const excerpt = comment.body?.slice(0, 200);
	await Promise.all(mentionedUserIds.map((userId) =>
		notify({
			userId,
			type: notifyType,
			title: `${comment.author ?? "Someone"} mentioned you in a comment`,
			body: excerpt,
			workspaceId,
			linkUrl: `/projects/${projectId}/review?page=${comment.pageIndex + 1}`,
			metadata: { projectId, commentId: comment.id, pageIndex: comment.pageIndex },
		}).catch((error) => {
			console.warn(`[project] mention notify failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
		}),
	));
	return mentionedUserIds;
}

/**
 * P1: resolve + notify @mentions inside a version review REQUEST or DECISION text
 * — the review counterpart of `notifyCommentMentions`. Previously a review-request
 * or review-decision could @mention a reviewer and they were never pinged (only
 * comments notified). Tenant-scoped (candidates from this workspace only), author
 * skipped, de-duplicated, best-effort. `skipUserIds` lets an edit/decision suppress
 * re-pinging people already notified on a prior request/decision (idempotency).
 * Reuses the existing `comment_reply` notification type so no schema migration is
 * needed. Returns the user IDs that were freshly notified.
 */
async function notifyReviewMentions(input: {
	workspaceId: string | undefined;
	projectId: string;
	mentions: string[];
	actor?: string;
	authorUserId?: string;
	subjectLabel: "review request" | "review decision";
	linkUrl: string;
	body?: string;
	metadata: Record<string, unknown>;
	skipUserIds?: Iterable<string>;
}): Promise<string[]> {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId || input.mentions.length === 0) return [];
	const resolved = await resolveWorkspaceMentionUserIds({
		workspaceId,
		projectId: input.projectId,
		mentions: input.mentions,
		authorUserId: input.authorUserId,
	});
	const skip = new Set(input.skipUserIds ?? []);
	const targets = resolved.filter((userId) => !skip.has(userId));
	const excerpt = input.body?.slice(0, 200);
	await Promise.all(targets.map((userId) =>
		notify({
			userId,
			type: "comment_reply",
			title: `${input.actor ?? "Someone"} mentioned you in a ${input.subjectLabel}`,
			body: excerpt,
			workspaceId,
			linkUrl: input.linkUrl,
			metadata: input.metadata,
		}).catch((error) => {
			console.warn(`[project] review mention notify failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
		}),
	));
	return targets;
}

function normalizeTaskDueAtInput(value: string | null | undefined): {
	provided: boolean;
	dueAt?: string;
	error?: string;
} {
	if (value === undefined) return { provided: false };
	if (value === null || !value.trim()) return { provided: true, dueAt: undefined };
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return { provided: true, error: "Invalid dueAt" };
	}
	return { provided: true, dueAt: date.toISOString() };
}

// ── Routes ───────────────────────────────────────────────────

// Create new project
project.get("/", async (c) => {
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user && !allowsLegacyAnonymousProjectAccess()) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const parsed = projectListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	// Cross-workspace isolation (P1): a workspace-scoped Library request must prove
	// the caller is a member of that workspace BEFORE we list it — otherwise the
	// workspace param would be an enumeration handle for another tenant's projects.
	// Reuse the same membership gate the rest of the app uses (the requirePermission
	// helper that backs GET /api/workspaces); a non-member is rejected (404
	// workspace_not_found) exactly like GET /api/workspaces/:id/home. The catalog
	// store ALSO scope-filters each row, so this is defense-in-depth, not the only
	// guard.
	const requestedWorkspaceId = parsed.data.workspaceId?.trim();
	if (requestedWorkspaceId) {
		if (!user) return c.json({ error: "Unauthorized" }, 401);
		if (!workspaceAccessStore) {
			return c.json({
				error: "Workspace project listing requires a workspace access store",
				code: "workspace_project_store_unavailable",
			}, 503);
		}
		try {
			await workspaceAccessStore.requirePermission(requestedWorkspaceId, user.userId, "read_workspace");
		} catch (error) {
			return workspaceProjectCreateErrorResponse(c, error);
		}
	}
	try {
		const page = await listProjectSummaryPage(user, {
			limit: parsed.data.limit,
			cursor: parsed.data.cursor,
			workspaceId: requestedWorkspaceId,
			includeFileFallback: parsed.data.includeFileFallback === undefined
				? undefined
				: parsed.data.includeFileFallback === "true",
		});
		return c.json({ projects: page.projects, nextCursor: page.nextCursor });
	} catch (error) {
		if (error instanceof InvalidProjectSummaryCursorError) {
			return c.json({ error: "Invalid project cursor" }, 400);
		}
		throw error;
	}
});

// ── My pending chapter-team invites ──────────────────────────────────────────
//
// Lists the PENDING email invites addressed to the CALLER's own VERIFIED email —
// the only thing that lets an email-invited user actually find the chapter they
// must POST .../team/accept against (the accept endpoint matches on the caller's
// verified email but needs the project id, and a pure email invite's in-app
// notification is unlinked at send time). Security posture mirrors the accept
// endpoint exactly:
//   - the caller must be authenticated AND email-verified (so an unverified
//     account can't enumerate invites for an address it merely typed);
//   - we match ONLY pending, account-UNLINKED rows whose email equals the
//     caller's authoritative verified email — never another user's invites;
//   - the response carries only what the invitee needs to recognize + accept
//     (project id, chapter label, role, inviter display, invitedAt). It never
//     reveals roster contents, other members, or whether any OTHER email is
//     invited. A caller with no invites gets an empty list (not a 404), which is
//     not an enumeration oracle because it only ever reflects the caller's own
//     verified address.
//
// PERF / codex P1 (PR #394): this used to readdirSync(PROJECTS_DIR) and parse up to
// 5000 state.json files on EVERY request — event-loop-blocking read amplification not
// bounded by the per-IP rate limit, with invite discovery incomplete past the cap. It
// now resolves the caller's invites through the bounded, INDEXED pendingInviteIndex
// (a point lookup keyed by the caller's verified email — maintained on every invite
// create/accept/remove via writeProjectState → syncProject), so there is NO global
// scan and NO whole-corpus parse on the hot path.
project.get("/my/invites", async (c) => {
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized" }, 401);
	// Load the authoritative account for the canonical VERIFIED email (same gate the
	// accept endpoint uses) — never trust the token's email alone, and an unverified
	// account may not list invites for an address it has not proven it controls.
	const account = await authUserStore.load(user.userId).catch(() => null);
	if (!account || !account.isActive || !account.emailVerified) {
		return c.json({ error: "Email must be verified to view invites", code: "chapter_team_invites_email_unverified" }, 403);
	}
	const email = account.email.trim().toLowerCase();
	if (!email) return c.json({ invites: [] });

	// Bounded indexed lookup of THIS verified email's pending invites — no scan.
	let indexed: Awaited<ReturnType<typeof pendingInviteIndexStore.listForEmail>>;
	try {
		indexed = await pendingInviteIndexStore.listForEmail(email, MAX_PENDING_INVITES_PER_EMAIL);
	} catch (error) {
		console.warn("Pending-invite index lookup failed", { error });
		return c.json({ invites: [] });
	}

	const invites: Array<{
		projectId: string;
		chapterLabel: string;
		storyTitle?: string;
		role: ChapterTeamMember["role"];
		invitedByName?: string;
		invitedAt: string;
	}> = [];
	const inviterNameCache = new Map<string, string | undefined>();
	for (const entry of indexed) {
		// Defensive: skip any stale index row for a project that has since been
		// tombstoned (delete-then-index-cleanup race) — never surface an invite for a
		// deleted chapter. This is an O(1) on-disk marker check, NOT a state parse.
		if (isProjectTombstoned(entry.projectId)) continue;
		let invitedByName: string | undefined;
		if (entry.invitedBy) {
			if (inviterNameCache.has(entry.invitedBy)) {
				invitedByName = inviterNameCache.get(entry.invitedBy);
			} else {
				const inviter = await authUserStore.load(entry.invitedBy).catch(() => null);
				invitedByName = inviter?.name ?? inviter?.email ?? undefined;
				inviterNameCache.set(entry.invitedBy, invitedByName);
			}
		}
		invites.push({
			projectId: entry.projectId,
			chapterLabel: (entry.chapterLabel ?? entry.storyTitle ?? "a chapter").trim() || "a chapter",
			storyTitle: entry.storyTitle,
			role: entry.role,
			invitedByName,
			invitedAt: entry.invitedAt,
		});
	}
	invites.sort((a, b) => b.invitedAt.localeCompare(a.invitedAt));
	return c.json({ invites });
});

type StoryIdScopeVerdict =
	// storyId is unknown across every project the caller can see → a brand-new story
	// (the client mints a fresh id for a new story), safe to use as-is.
	| "new"
	// storyId already lives on a project INSIDE this create's scope → adding another
	// chapter to an existing same-scope story, safe.
	| "in-scope"
	// storyId already belongs to a project OUTSIDE this create's scope (a different
	// workspace, or — for a personal create — a workspaced/other-owner project). Using
	// it here would MERGE this chapter into a story the Library shows under another
	// owner/workspace. Must be rejected.
	| "foreign";

/**
 * Authz/data-integrity (#1): decide whether a client-supplied `storyId` may be used
 * for a create in this scope. The client sends a `storyId` in TWO legitimate cases —
 * a freshly minted id for a BRAND-NEW story, and an EXISTING story's id when adding a
 * chapter to it — so we must allow both while rejecting the attack: stamping a chapter
 * with a storyId that belongs to a DIFFERENT workspace/owner, which the Library (which
 * groups purely by storyId) would silently merge into that other story.
 *
 * Ownership is resolved AUTHORITATIVELY via an UNCAPPED, indexed point lookup
 * (`resolveStoryIdOwnership`) over EVERY non-deleted project — NOT a scan of the
 * caller's visible-project list. The previous implementation paged the caller's
 * visible projects and STOPPED after a cap (1000); a caller who could see more than
 * that many projects could reuse a FOREIGN storyId that sorted after the cap — the
 * scan missed it, classified it "new", and the create persisted the cross-workspace
 * merge. The authoritative lookup closes that bypass: the cap no longer exists, and a
 * foreign storyId is rejected no matter how many projects the caller can see.
 *
 * Classification relative to THIS create's scope (the target workspace for a workspace
 * create, or the caller's own personal/workspaceless projects otherwise):
 *   - storyId owned by THIS scope        → "in-scope" (allow: adding a chapter);
 *   - storyId owned by a DIFFERENT scope → "foreign" (reject: cross-workspace/owner merge);
 *   - storyId owned by NO project        → "new" (allow: a brand-new client-minted story).
 * A catalog read failure fails CLOSED → "foreign".
 */
async function classifyClientStoryId(
	user: JWTPayload | undefined,
	workspaceId: string | undefined,
	storyId: string,
): Promise<StoryIdScopeVerdict> {
	const catalog = projectCatalogStore;
	// No catalog to verify against → cannot prove ownership; treat any supplied id as
	// foreign so an unverifiable free-form id is never silently honored.
	if (!catalog) return "foreign";
	const userId = user?.userId;
	// A personal create with no authenticated user has no owner scope to anchor against.
	if (!workspaceId && !userId) return "foreign";

	let ownership: StoryIdOwnership;
	try {
		ownership = await catalog.resolveStoryIdOwnership(storyId);
	} catch (error) {
		console.warn("storyId ownership resolution failed; rejecting client storyId", { workspaceId, error });
		return "foreign";
	}

	// Unknown across the WHOLE catalog → a brand-new client-minted story.
	if (!ownership.exists) return "new";

	if (workspaceId) {
		// Workspace create: in-scope only when the storyId already lives in THIS
		// workspace; any other owner (another workspace, or any personal owner —
		// including ownerless legacy) is foreign and rejected.
		return ownership.workspaceIds.includes(workspaceId) ? "in-scope" : "foreign";
	}

	// Personal create: in-scope only when the storyId already lives on THIS user's own
	// personal (workspaceless) projects. A storyId on any workspace project, another
	// user's personal project, or an ownerless legacy personal project is foreign.
	return userId !== undefined && ownership.ownerUserIds.includes(userId) ? "in-scope" : "foreign";
}

const createProjectHandler = async (c: any) => {
	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = createProjectSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const targetLangs = normalizeTargetLangs({
		targetLang: parsed.data.lang,
		targetLangs: parsed.data.targetLangs,
	});

	const user = getAuthUser(c) as JWTPayload | undefined;
	if (user) {
		const fullUser = await loadUser(user.userId);
		if (!fullUser || !fullUser.isActive) {
			return c.json({ error: "Unauthorized: User not found or inactive" }, 401);
		}
		if (!fullUser.emailVerified) {
			return c.json({ error: "Email verification required", code: "email_not_verified" }, 403);
		}
	}
	const workspaceId = parsed.data.workspaceId?.trim();
	if (!workspaceId && !user && !allowsLegacyAnonymousProjectAccess()) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	if (!workspaceId && user && !hasPermission(user.role, "create:project")) {
		return c.json({ error: "Forbidden: Missing permission 'create:project'" }, 403);
	}
	if (workspaceId) {
		if (!user) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		// A workspace-scoped create only needs the workspace ACCESS store to verify
		// the caller is a member with `manage_projects` — the project itself is
		// persisted by writeProjectState (file or Postgres-mirrored alike) and the
		// catalog reads it back from there, so a project-catalog store is NOT
		// required here. In file mode (no Postgres) both stores are the JSON-file
		// implementations and are non-null, so this path now SUCCEEDS instead of
		// 503-ing — which is what lets a file-mode/self-host workspace dashboard
		// actually populate. The membership check below is the security gate: the
		// FileWorkspaceAccessStore.requirePermission backs GET /api/workspaces, so a
		// user who is not a member of `workspaceId` is rejected (404/403) here and
		// can never stamp a workspace they don't belong to. Postgres mode is
		// unchanged: the same requirePermission + scope check runs against the DB.
		if (!workspaceAccessStore) {
			return c.json({
				error: "Workspace project creation requires a workspace access store",
				code: "workspace_project_store_unavailable",
			}, 503);
		}
		try {
			const member = await workspaceAccessStore.requirePermission(workspaceId, user.userId, "manage_projects");
			if (!targetLangs.every((language) => workspaceScopeAllowsNewProject(member.scope, { language }))) {
				throw new WorkspaceAccessError("Forbidden: workspace scope cannot create new projects", 403, "workspace_project_create_scope_denied");
			}
		} catch (error) {
			return workspaceProjectCreateErrorResponse(c, error);
		}
	}

	// Authz/data-integrity (#1): a client-supplied `storyId` may legitimately be a
	// fresh id for a NEW story or an EXISTING same-scope story's id (adding a chapter).
	// We reject ONLY when the id already belongs to a project OUTSIDE this create's
	// scope (a different workspace/owner) — using it there would merge this chapter
	// into another owner's story (the Library groups purely by storyId). A new or
	// same-scope id is allowed; the caller can always start a fresh story by omitting
	// `storyId`.
	//
	// The gate applies ONLY to a SCOPED create (a workspace create, or an authenticated
	// personal create) — those have an owner scope worth protecting. The legacy
	// ANONYMOUS prototype path (no user, no workspace, gated by
	// ALLOW_LEGACY_ANONYMOUS_PROJECTS) has no multi-tenant scope and intentionally
	// persists a free-form storyId verbatim, so it is exempt.
	const requestedStoryId = parsed.data.storyId;
	if (requestedStoryId && (workspaceId || user)) {
		const verdict = await classifyClientStoryId(user, workspaceId, requestedStoryId);
		if (verdict === "foreign") {
			return c.json({
				error: "Cannot add a chapter to that story",
				code: "story_not_accessible",
			}, 403);
		}
	}

	const projectId = uuid();
	const projectDir = safePath(PROJECTS_DIR, projectId);
	mkdirSync(safePath(PROJECTS_DIR, projectId, "images"), { recursive: true });

	const state: ProjectState = {
		projectId,
		workspaceId,
		userId: user?.userId || "", // Empty string for prototype without auth
		name: parsed.data.name,
		createdAt: new Date().toISOString(),
		// Backend is authoritative for the stable story key: reuse the (now server-
		// VERIFIED) id the client sent when adding a chapter to an existing story, and
		// mint a fresh dash-free stable id when starting a brand-new story so two
		// stories with the same title never collide and a rename never changes it.
		storyId: requestedStoryId ?? generateStableStoryId(),
		storyTitle: parsed.data.storyTitle,
		chapterNumber: parsed.data.chapterNumber,
		chapterTitle: parsed.data.chapterTitle,
		chapterLabel: parsed.data.chapterLabel,
		readingDirection: parsed.data.readingDirection,
		// Chapter-level Team/Solo selection. An explicit team-mode create, or any
		// initial invite, makes this a Team chapter; otherwise Solo (owner-only).
		productionMode: parsed.data.productionMode
			?? ((parsed.data.initialInvites?.length ?? 0) > 0 ? "team" : "solo"),
		pages: [],
		currentPage: 0,
		sourceLang: parsed.data.sourceLang,
		targetLang: targetLangs[0] ?? "th",
		targetLangs,
		textStylePresets: [],
		creditPresets: [],
		tasks: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		exportRuns: [],
		activityLog: [createActivity({
			type: "project_created",
			message: `Created project: ${parsed.data.name}`,
			messageKey: "activity.projectCreated",
			messageParams: { name: parsed.data.name },
		})],
	};

	// Invite-at-creation: resolve each initial invite into a roster member. A bad
	// invite (unknown UID, duplicate) is NON-FATAL — the chapter is still created and
	// the failures are returned so the UI can surface them. The dispatch happens after
	// the state write so we never notify someone about a chapter that failed to persist.
	const inviteFailures: Array<{ index: number; code: string; message: string }> = [];
	const dispatchedInvites: ChapterTeamMember[] = [];
	const initialInvites = parsed.data.initialInvites ?? [];
	if (initialInvites.length > 0) {
		const team: ChapterTeamMember[] = [];
		for (let index = 0; index < initialInvites.length; index += 1) {
			const invite = initialInvites[index]!;
			try {
				const member = await resolveAndBuildChapterTeamMember(team, {
					userId: invite.userId,
					email: invite.email,
					displayName: invite.displayName,
					role: invite.role,
				}, user?.userId);
				team.push(member);
				dispatchedInvites.push(member);
			} catch (error) {
				if (error instanceof ChapterTeamError) {
					inviteFailures.push({ index, code: error.code, message: error.message });
				} else {
					throw error;
				}
			}
		}
		state.chapterTeam = team;
	}

	await writeProjectState(projectId, state);
	for (const member of dispatchedInvites) {
		await dispatchChapterTeamInvite({ state, member, inviterName: user?.email });
	}
	return c.json({ projectId, ...(inviteFailures.length > 0 ? { inviteFailures } : {}) });
};

project.post("/", createProjectHandler);
project.post("/new", createProjectHandler);

project.post("/:id/languages", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = projectLanguageSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const language = parsed.data.language;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const accessError = await checkLanguageTrackManagementAccess(c, state, language);
	if (accessError) return accessError;

	const targetLangs = normalizeProjectLanguageTracks(state);
	if (targetLangs.includes(language)) {
		return c.json({
			error: "Language track already exists",
			code: "language_track_exists",
		}, 409);
	}
	state.targetLangs = [...targetLangs, language];
	state.targetLang = state.targetLangs[0] ?? language;
	appendActivity(state, createActivity({
		type: "language_track_added",
		message: `Added language track: ${language}`,
		messageKey: "activity.languageTrackAdded",
		messageParams: { language },
		actor: (getAuthUser(c) as JWTPayload | undefined)?.email ?? (getAuthUser(c) as JWTPayload | undefined)?.userId,
		metadata: { language, targetLangs: state.targetLangs },
	}));
	await writeProjectState(idResult, state);
	return c.json({
		projectId: idResult,
		targetLang: state.targetLang,
		targetLangs: state.targetLangs,
	});
});

project.delete("/:id/languages/:language", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const parsed = projectLanguageSchema.safeParse({ language: c.req.param("language") });
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const language = parsed.data.language;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const accessError = await checkLanguageTrackManagementAccess(c, state, language);
	if (accessError) return accessError;

	const targetLangs = normalizeProjectLanguageTracks(state);
	if (!targetLangs.includes(language)) {
		return c.json({
			error: "Language track not found",
			code: "language_track_not_found",
		}, 404);
	}
	if (targetLangs.length <= 1) {
		return c.json({
			error: "Cannot remove the last language track",
			code: "cannot_remove_last_language_track",
		}, 400);
	}
	if (language === targetLangs[0]) {
		return c.json({
			error: "Cannot remove the primary language track",
			code: "cannot_remove_primary_language_track",
		}, 400);
	}
	state.targetLangs = targetLangs.filter((targetLang) => targetLang !== language);
	state.targetLang = state.targetLangs[0] ?? "th";
	appendActivity(state, createActivity({
		type: "language_track_removed",
		message: `Removed language track: ${language}`,
		messageKey: "activity.languageTrackRemoved",
		messageParams: { language },
		actor: (getAuthUser(c) as JWTPayload | undefined)?.email ?? (getAuthUser(c) as JWTPayload | undefined)?.userId,
		metadata: { language, targetLangs: state.targetLangs },
	}));
	await writeProjectState(idResult, state);
	return c.json({
		projectId: idResult,
		targetLang: state.targetLang,
		targetLangs: state.targetLangs,
	});
});

// Rename a story (the only genuinely story-level editable field today). Renames
// the cosmetic `storyTitle` on a SINGLE chapter project; the stable `storyId`
// (#244) is preserved untouched so `/library/<storyId>-<slug>` still resolves.
// The client renames a whole story by calling this once per chapter project in
// the story group. Uses the same `update:project` / `manage_projects` posture as
// the other metadata edits.
project.patch("/:id/story", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	const parsed = updateStorySchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	// `storyTitle`/`storyId` are SHARED, non-language project metadata (the story
	// group spans every language track). Authorizing this with a per-language
	// `{ language: state.targetLang }` check let a member scoped to that single
	// language rename the whole shared story. A shared-metadata mutation must
	// require TRULY project-wide (unscoped) authority — `requireProjectWide`
	// rejects ANY fine-grained scope restriction. An unscoped owner/editor passes
	// unchanged; a scoped collaborator is denied (403/404).
	const ownershipError = await checkProjectOwnership(c, state, "update:project", { requireProjectWide: true });
	if (ownershipError) return ownershipError;
	// Renaming the story is CATALOG shaping, not chapter work — for workspace
	// projects it needs the same owner/admin authority as create/delete (product
	// decision 2026-06-13). Personal projects keep the owner-only path above.
	// FAIL CLOSED like the sibling create/delete gates: a workspace project with
	// no access store must 503, never skip the manage gate.
	if (state.workspaceId?.trim() && !workspaceAccessStore) {
		return c.json({
			error: "Workspace story rename requires a workspace access store",
			code: "workspace_story_rename_store_unavailable",
		}, 503);
	}
	if (state.workspaceId?.trim() && workspaceAccessStore) {
		const user = getAuthUser(c) as JWTPayload;
		try {
			await workspaceAccessStore.requirePermission(state.workspaceId.trim(), user.userId, "manage_projects");
		} catch (error) {
			if (error instanceof WorkspaceAccessError) {
				return c.json({ error: error.message, code: error.code }, error.status);
			}
			throw error;
		}
	}

	const previousTitle = state.storyTitle;
	state.storyTitle = parsed.data.storyTitle;
	if (previousTitle !== state.storyTitle) {
		appendActivity(state, createActivity({
			type: "story_renamed",
			message: `Renamed story to: ${state.storyTitle}`,
			messageKey: "activity.storyRenamed",
			messageParams: { title: state.storyTitle },
			actor: (getAuthUser(c) as JWTPayload | undefined)?.email ?? (getAuthUser(c) as JWTPayload | undefined)?.userId,
			metadata: { storyId: state.storyId, previousTitle, storyTitle: state.storyTitle },
		}));
	}
	await writeProjectState(idResult, state);
	// PUSH the title change so every other member's Library/Sidebar/Dashboard re-fetches
	// and shows the new title within seconds. writeProjectState above only busts the
	// SERVER caches — without this realtime push a peer who already has the workspace
	// open keeps the STALE title for the whole session (F-audit HIGH cache-coherence).
	if (previousTitle !== state.storyTitle && state.workspaceId) {
		await publishRealtimeEvent(state.workspaceId, "project_meta_changed", {
			projectId: idResult,
			storyId: state.storyId,
			storyTitle: state.storyTitle,
		});
	}
	return c.json({
		projectId: idResult,
		storyId: state.storyId,
		storyTitle: state.storyTitle,
	});
});

// Sentinel thrown by the catalog-delete step of finishProjectDeletion so the
// route can map ONLY that failure to a 500 (every other reclaim step is
// best-effort and must never fail the delete). See finishProjectDeletion.
export class ProjectCatalogDeleteFailedError extends Error {
	override readonly cause: unknown;
	constructor(cause: unknown) {
		super("Project catalog delete failed");
		this.name = "ProjectCatalogDeleteFailedError";
		this.cause = cause;
	}
}

// Injectable dependencies for finishProjectDeletion. Production passes nothing and
// the module bindings are used; tests inject failing/spy stores to drive the
// catalog-throws→500→retry-reclaims + reorder semantics without a live Postgres.
export interface FinishProjectDeletionDeps {
	catalogStore?: Pick<ProjectCatalogStore, "deleteProject"> | null;
	/** Reclaim the project's CoW asset ledger. Only invoked when `cowEnabled`. */
	reclaimCowAssets?: (projectId: string) => Promise<unknown>;
	/** Postgres-gate: CoW tables only exist when the catalog is DB-backed. */
	cowEnabled?: boolean;
	removeInviteIndex?: (projectId: string) => Promise<void>;
	removeProjectDir?: (projectId: string) => void;
}

// Finish a project deletion AFTER its tombstone is written. This is the idempotent
// "completion" phase shared by the first-pass delete AND the tombstoned-retry path
// (see the delete route below), so a transient catalog failure that 500s the first
// call can be driven to completion by a client retry without leaking storage.
//
// Reclaim order matters and is the whole data-integrity invariant. EVERY step here
// is idempotent on already-deleted state (rmSync force, deleteAssetsForProject,
// pendingInviteIndexStore.removeProject, and deleteProject's `DELETE … WHERE id`
// are all no-ops when their target is already gone), so re-running the whole phase
// is safe:
//  1. Remove the on-disk project tree. The tombstone marker lives OUTSIDE the
//     project dir, so rmSync can't remove it. A failure here does NOT resurrect the
//     project (the tombstone blocks every read) — log the orphaned dir and keep
//     going rather than failing.
//  2. Drop the pending-invite index rows (best-effort; idempotent). In Postgres
//     mode the catalog-row delete below also cascades these — this explicit call
//     covers file mode (no FK) and a retry where the row delete already happened.
//  3. Reclaim the CoW storage ledger BEFORE the catalog-row delete. `asset_records`
//     has NO FK to `projects` (migration 0021), so the reclaim is independent of
//     whether the catalog row still exists — running it FIRST guarantees the
//     highest-value reclaim (ref_count/quota accounting) happens even if the catalog
//     delete in step 4 then throws and 500s. deleteAssetsForProject drops the
//     project's asset_versions WITH the ref-count/quota accounting (CoW-safe: a blob
//     another project still references keeps a positive ref_count and survives; only
//     blobs that reach ref_count=0 are later freed by the orphan-blob GC cron) and
//     then removes the asset_records. Best-effort + postgres-gated (the CoW tables
//     only exist when the catalog is DB-backed); file mode reclaims its bytes via
//     the step-1 rmSync of the project tree.
//  4. Remove the catalog row (child rows cascade). This is the ONLY step that can
//     fail the delete: on a throw, propagate ProjectCatalogDeleteFailedError so the
//     route returns 500. The tombstone already blocks every read, so a residual row
//     can't resurrect the project — and the client's retry re-enters via the
//     tombstoned-retry path and finishes the (now-reclaimed-anyway) row delete.
export async function finishProjectDeletion(projectId: string, deps: FinishProjectDeletionDeps = {}): Promise<void> {
	const catalogStore = deps.catalogStore !== undefined ? deps.catalogStore : projectCatalogStore;
	const cowEnabled = deps.cowEnabled ?? Boolean(projectCatalogStore && process.env.DATABASE_URL?.trim());
	const reclaimCowAssets = deps.reclaimCowAssets
		?? ((id: string) => getSharedStorageCowService().deleteAssetsForProject(id));
	const removeInviteIndex = deps.removeInviteIndex
		?? ((id: string) => pendingInviteIndexStore.removeProject(id));
	const removeProjectDir = deps.removeProjectDir
		?? ((id: string) => { rmSync(safePath(PROJECTS_DIR, id), { recursive: true, force: true }); });

	try {
		removeProjectDir(projectId);
	} catch (error) {
		console.error("Project directory delete failed after tombstone (orphaned dir left for cleanup)", { projectId, error });
	}

	// Drop this project's pending-invite index rows. Best-effort + idempotent — a
	// stale index row would only ever surface an invite for a now-deleted chapter,
	// which the accept endpoint then 404s, so it is not a correctness hazard worth
	// failing the delete.
	try {
		await removeInviteIndex(projectId);
	} catch (error) {
		console.warn("Best-effort pending-invite index delete failed", { projectId, error });
	}

	// Reclaim the project's CoW storage ledger BEFORE dropping the catalog row.
	// `asset_records` has NO FK to `projects` (migration 0021), so the project's
	// asset_records + asset_versions otherwise survive the row delete with every
	// content_blobs ref_count inflated and the workspace/user storage quota never
	// given back — an unbounded quota + orphan-object leak. Running it first means a
	// later catalog-delete failure still leaves the storage reclaimed. Best-effort +
	// postgres-gated.
	if (cowEnabled) {
		try {
			await reclaimCowAssets(projectId);
		} catch (error) {
			console.error("Project CoW storage reclaim failed after delete (storage left for orphan-blob GC)", { projectId, error });
		}
	}

	try {
		await catalogStore?.deleteProject(projectId);
	} catch (error) {
		console.error("Project catalog delete failed", { projectId, error });
		throw new ProjectCatalogDeleteFailedError(error);
	}

	// Deleting a project removes it from listings under arbitrary keys/cursors —
	// full clear is the correct, simple invalidation at a 1s TTL.
	projectSummaryCache.clear();
}

// Permanently delete a chapter project: its catalog rows (pages/tasks/comments/
// review-decisions/versions/version-reviews cascade via ON DELETE CASCADE) and
// its on-disk project directory (state, versions, images, derivatives, exports).
// Deleting a STORY = the client calls this for every chapter project under the
// story's stable `storyId`. Irreversible — gated behind `delete:project` (app
// role) or workspace `manage_projects`, and a hard type-to-confirm in the UI.
//
// A FRESH delete runs the full gate (state-based permission check + type-to-confirm)
// then tombstones + reclaims. A RETRY of an already-tombstoned id is an idempotent
// COMPLETION of an in-flight delete that previously 500'd (the project is already
// logically deleted): it requires authentication but skips the now-meaningless
// type-to-confirm — see the tombstoned-retry branch below.
project.delete("/:id", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;

	// Transactional + durable delete (no resurrection). Tombstone-FIRST — order
	// matters and is the whole correctness invariant:
	//  1. Write the deletion tombstone BEFORE touching either store. If this throws,
	//     FAIL with 500 — NOTHING is deleted yet, so the project is fully intact and
	//     safe to retry. Once the tombstone exists, EVERY guarded read path
	//     (loadProjectState, the file catalog's readState, and the file-mode
	//     readProjectStateFileGuarded used by export/images/text-qa/ai/crops/…)
	//     refuses to serve this id, so it is logically deleted + unresurrectable
	//     even if a residual readable state.json or catalog row survives.
	//  2. Run finishProjectDeletion: disk rmSync → invite-index cleanup → CoW
	//     storage reclaim → catalog-row delete. CoW reclaim runs BEFORE the catalog
	//     delete (asset_records has no FK to projects, migration 0021) so the
	//     highest-value reclaim survives even if the catalog delete then throws.
	//     Only the catalog-delete step can fail the request (→ 500); every other
	//     step is best-effort and never resurrects the (tombstoned) project.
	// Net invariant: a 200 GUARANTEES the tombstone exists AND the project can never
	// be read again (disk + catalog gone, and tombstoned regardless).
	//
	// RETRY / IDEMPOTENT-COMPLETION SEMANTICS (data-integrity fix). The catalog
	// delete in step 2 can throw transiently (e.g. a DB blip) and 500. On the first
	// pass that throw happened AFTER the tombstone was written but potentially BEFORE
	// the CoW reclaim — and on a naive retry the tombstone makes readProjectState()
	// return null, so the handler used to bail 404 and could NEVER finish the reclaim,
	// orphaning asset_records + inflating quota forever. So: if the id is ALREADY
	// tombstoned, this is a RETRY of an in-flight delete, not a fresh request. The
	// project is ALREADY logically deleted, so finishing the reclaim is NOT a new
	// destructive decision: we SKIP the type-to-confirm (its required state is now
	// unreadable, and re-confirming an already-deleted title is meaningless) but still
	// require authentication so the completion isn't an unauthenticated trigger/oracle,
	// then idempotently re-run finishProjectDeletion and return 200 (or 500 if the
	// catalog delete still fails — the next retry completes it). A NEVER-EXISTED id has
	// no tombstone and no state, so it still returns 404.
	if (isProjectTombstoned(idResult)) {
		// Tombstoned ⇒ a prior DELETE already passed full auth + type-to-confirm and
		// wrote the durable "this id is gone" record. The retry only finishes the
		// idempotent reclaim of an already-deleted project — keep an authentication
		// gate (no anonymous completion) but skip the state-based title/permission
		// checks, whose backing state is intentionally unreadable post-tombstone.
		const user = getAuthUser(c) as JWTPayload | undefined;
		if (!user && !allowsLegacyAnonymousProjectAccess()) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		try {
			await finishProjectDeletion(idResult);
		} catch (error) {
			if (error instanceof ProjectCatalogDeleteFailedError) {
				return c.json({ error: "Could not delete project", code: "project_delete_catalog_failed" }, 500);
			}
			throw error;
		}
		return c.json({ ok: true, deleted: true, projectId: idResult });
	}

	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const deletionError = await checkProjectDeleteAccess(c, state);
	if (deletionError) return deletionError;

	// Server-side confirmation: the request MUST echo the exact story title the user
	// typed in the type-to-confirm dialog. Auth alone is NOT enough to destroy a
	// story — a blind/empty DELETE is rejected here (the type-to-confirm in the UI
	// is convenience, not the security boundary). (On a tombstoned retry above this
	// is intentionally skipped: the project is already logically deleted.)
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Project delete requires a confirmation body", code: "delete_confirmation_required" }, 400);
	}
	const parsed = projectDeleteSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Project delete requires confirmStoryTitle", code: "delete_confirmation_required" }, 400);
	}
	// The dialog confirms against the story title; fall back to the project name for
	// legacy projects that never had a storyTitle set. Trimmed exact match.
	const expectedTitle = (state.storyTitle ?? state.name ?? "").trim();
	if (parsed.data.confirmStoryTitle.trim() !== expectedTitle) {
		return c.json({ error: "Confirmation title does not match", code: "delete_confirmation_mismatch" }, 400);
	}

	try {
		writeProjectTombstone(idResult);
	} catch (error) {
		// Nothing deleted yet — the project is fully intact, so refuse and let the
		// client retry rather than half-deleting without a resurrection guard.
		console.error("Project deletion tombstone write failed; aborting delete", { projectId: idResult, error });
		return c.json({ error: "Could not delete project", code: "project_delete_tombstone_failed" }, 500);
	}

	try {
		await finishProjectDeletion(idResult);
	} catch (error) {
		if (error instanceof ProjectCatalogDeleteFailedError) {
			// The tombstone is already written, so this id is logically deleted +
			// unreadable. Fail so the client retries — the retry re-enters via the
			// tombstoned-retry branch above and idempotently finishes the reclaim +
			// catalog-row delete.
			return c.json({ error: "Could not delete project", code: "project_delete_catalog_failed" }, 500);
		}
		throw error;
	}

	return c.json({ ok: true, deleted: true, projectId: idResult });
});

// ── Chapter team (Team/Solo + invites) ───────────────────────────────────────
//
// The roster lives on ProjectState (`state.chapterTeam`) and the production mode on
// `state.productionMode`. Reads require `read:project`; every MUTATION requires
// owner/lead authority (checkChapterTeamManageAccess). All mutations commit through
// the per-project CAS lock so a concurrent team edit can't be clobbered.

type SerializedTeamMember = Pick<ChapterTeamMember, "id" | "userId" | "displayName" | "role" | "status" | "createdAt"> & {
	email?: string;
};

/** Public view of a chapter team member with PII fields added only by caller authority. */
function serializeTeamMember(member: ChapterTeamMember, options: { includeEmail?: boolean } = {}): SerializedTeamMember {
	return {
		id: member.id,
		userId: member.userId,
		displayName: member.displayName,
		role: member.role,
		status: member.status,
		createdAt: member.createdAt,
		// The roster is readable by collaborators; email is invite PII, not roster metadata.
		...(options.includeEmail && member.email ? { email: member.email } : {}),
	};
}

/**
 * Serialize the chapter-team roster for THIS caller: emails appear only when
 * the same policy as GET /team allows (review #598: team MUTATION responses
 * previously hardcoded includeEmail and let any manage_projects editor
 * recover every roster email via a no-op PATCH).
 */
async function serializeTeamForCaller(c: any, state: ProjectState): Promise<SerializedTeamMember[]> {
	const includeEmail = await canReadChapterTeamEmail(c, state);
	return getChapterTeam(state).map((member) => serializeTeamMember(member, { includeEmail }));
}

async function canReadChapterTeamEmail(c: any, state: ProjectState): Promise<boolean> {
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return false;

	if (state.workspaceId?.trim()) {
		if (!workspaceAccessStore) return false;
		try {
			const member = await workspaceAccessStore.requirePermission(state.workspaceId, user.userId, "manage_members");
			// Scoped managers may be able to work inside a project, but roster email is workspace-level PII.
			return workspaceScopeCovers(member.scope, undefined);
		} catch {
			return false;
		}
	}

	// Personal chapters have no workspace member manager; only the true owner may see invite email.
	return Boolean(state.userId && state.userId === user.userId);
}

// Non-enumerating public view for the IMMEDIATE response to an EMAIL invite.
//
// An email invite resolves the address to a registered user INTERNALLY (so an
// existing account is wired up + granted access), but the response the caller sees
// must NOT reveal whether the email maps to a registered account — otherwise the
// invite endpoint is a registered-user enumeration oracle. So for an email invite we
// echo back a STABLE pending-looking shape (no resolved userId, status "pending", and
// only the caller-supplied displayName) regardless of registration. The roster still
// stores the real resolved member; GET /team is gated behind team-manage authority.
function serializeInviteResponseMember(
	member: ChapterTeamMember,
	byEmail: boolean,
	requestedDisplayName: string | undefined,
): ChapterTeamMember {
	if (!byEmail) return serializeTeamMember(member, { includeEmail: true });
	return {
		id: member.id,
		email: member.email,
		displayName: requestedDisplayName,
		role: member.role,
		status: "pending",
		invitedBy: member.invitedBy,
		createdAt: member.createdAt,
	};
}

function chapterTeamErrorResponse(c: any, error: unknown): Response | null {
	if (error instanceof ChapterTeamError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	return null;
}

// Best-effort: dispatch the chapter-team invite through the EXISTING notification
// path (in-app + email, gated by the recipient's prefs). A notify failure never
// blocks the team mutation — notify() already swallows its own side-effect errors.
async function dispatchChapterTeamInvite(input: {
	state: ProjectState;
	member: ChapterTeamMember;
	inviterName?: string;
}): Promise<void> {
	const { state, member, inviterName } = input;
	if (!member.userId && !member.email) return;
	const chapterLabel = (state.chapterLabel ?? state.storyTitle ?? state.name ?? "a chapter").trim() || "a chapter";
	// Account-aware accept deep link.
	//
	// SECURITY NOTE (chapter-team invites carry NO token): unlike the WORKSPACE invite
	// system (/invite/:id?token=…, which mints + hashes a one-time token), a chapter-team
	// invite is accepted via POST /:id/team/accept, which authorizes purely by matching the
	// CALLER's authenticated + VERIFIED email to the invited email (see GET /my/invites). So
	// there is no token to embed — embedding a fabricated one would be MEANINGLESS, and the
	// email match IS the security boundary. We therefore point invitees at the page that
	// surfaces + accepts their pending invites:
	//   - invitee WITH an account (resolved userId) → /library (PendingInvitesPanel lives there)
	//   - invitee with NO account yet (pure email invite) → /signup so they create the account
	//     under the invited email, then the same /library accept flow picks the invite up.
	const acceptUrl = member.userId ? "/library" : "/signup";
	try {
		await notify({
			// notify() requires a userId for the in-app row; for a pure email invite
			// (no resolved user yet) it still fires the email channel via input.email.
			userId: member.userId ?? "",
			email: member.email,
			name: member.displayName,
			type: "invite_received",
			title: `You were invited to ${chapterLabel}`,
			body: inviterName
				? `${inviterName} invited you to join the chapter team as ${member.role}.`
				: `You were invited to join the chapter team as ${member.role}.`,
			workspaceId: state.workspaceId,
			linkUrl: acceptUrl,
			metadata: {
				projectId: state.projectId,
				role: member.role,
				chapterTeamMemberId: member.id,
			},
		});
	} catch (error) {
		console.warn("[chapter-team] invite notify failed (best-effort)", { projectId: state.projectId, error });
	}
}

// Resolve an invite target (UID → active user; email → existing user or pending)
// and build a roster member, throwing ChapterTeamError on a bad target/duplicate.
// Shared by the create handler (initial invites) and the POST invites route.
async function resolveAndBuildChapterTeamMember(
	team: ChapterTeamMember[],
	input: ChapterTeamInviteInput,
	invitedBy: string | undefined,
): Promise<ChapterTeamMember> {
	let resolved: { userId?: string; email?: string; displayName?: string; status: ChapterTeamMember["status"] };
	if (input.userId) {
		// UID invite: the inviter already knows the platform UID (this is NOT email
		// enumeration), so we resolve + add the user as ACTIVE immediately. An unknown
		// UID fails closed with a uniform error.
		const target = await authUserStore.load(input.userId);
		if (!target || !target.isActive) {
			throw new ChapterTeamError("No active user with that UID", "chapter_team_uid_not_found", 404);
		}
		resolved = { userId: target.id, email: target.email, displayName: target.name ?? input.displayName, status: "active" };
	} else {
		// EMAIL invite: ALWAYS create a PENDING, UNLINKED row — never look the email up
		// against the account store at send time. A pending row carries only the invited
		// email + caller-supplied displayName (no resolved userId, no registration-derived
		// name), identically whether or not the email maps to a registered user. The
		// invitee's account is linked + activated ONLY when THEY accept (POST .../team/accept).
		// This removes the registration-enumeration oracle that a resolve-at-send-time
		// (active-vs-pending) row would leak through the roster + activity log.
		resolved = { email: input.email, displayName: input.displayName, status: "pending" };
	}
	return buildChapterTeamMember(team, input, resolved, invitedBy);
}

// GET the chapter team + production mode.
project.get("/:id/team", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	const accessError = await checkProjectOwnership(c, state, "read:project");
	if (accessError) return accessError;
	const includeEmail = await canReadChapterTeamEmail(c, state);
	return c.json({
		productionMode: getProductionMode(state),
		team: getChapterTeam(state).map((member) => serializeTeamMember(member, { includeEmail })),
		maxMembers: MAX_CHAPTER_TEAM_MEMBERS,
	});
});

// POST a chapter team invite (by UID or email).
project.post("/:id/team/invites", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	const accessError = await checkChapterTeamManageAccess(c, state);
	if (accessError) return accessError;
	const projectCasBaseHash = hashProjectState(state);

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	const parsed = chapterTeamInviteSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const input: ChapterTeamInviteInput = {
		userId: parsed.data.userId,
		email: parsed.data.email,
		displayName: parsed.data.displayName,
		role: parsed.data.role,
	};

	const actor = getAuthUser(c) as JWTPayload | undefined;
	const team = getChapterTeam(state);
	// Resolve the target. A UID invite must point at a REAL user (fail closed on an
	// unknown UID); an email invite stays PENDING until the recipient exists/accepts.
	let member: ChapterTeamMember;
	try {
		member = await resolveAndBuildChapterTeamMember(team, input, actor?.userId);
	} catch (error) {
		const teamError = chapterTeamErrorResponse(c, error);
		if (teamError) return teamError;
		throw error;
	}
	const nextTeam = [...team, member];
	const nextState: ProjectState = { ...state, chapterTeam: nextTeam };
	// Inviting people implies a Team chapter; flip Solo→Team on the first invite so
	// the workflow gates match (spec: convert Solo ↔ Team).
	if (getProductionMode(nextState) === "solo") {
		nextState.productionMode = "team";
	}
	ensureProjectWorkflow(nextState);
	appendActivity(nextState, createActivity({
		type: "team_member_added",
		message: `Invited ${member.displayName ?? member.email ?? member.userId ?? "a collaborator"} as ${member.role}`,
		actor: actor?.userId,
		metadata: { chapterTeamMemberId: member.id, role: member.role, status: member.status },
	}));

	try {
		await commitProjectStateWithCas(idResult, projectCasBaseHash, nextState);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	await dispatchChapterTeamInvite({ state: nextState, member, inviterName: actor?.email });
	setProjectStateHashHeader(c, nextState);
	// Non-enumerating response: an email invite gets a stable pending-looking member
	// back regardless of whether the email mapped to a registered account (P1-1).
	const responseMember = serializeInviteResponseMember(member, !input.userId, input.displayName);
	return c.json({ member: responseMember, productionMode: getProductionMode(nextState) }, 201);
});

// PATCH the chapter team: set production mode and/or update a member's role.
project.patch("/:id/team", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	const accessError = await checkChapterTeamManageAccess(c, state);
	if (accessError) return accessError;
	const projectCasBaseHash = hashProjectState(state);

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	const parsed = chapterTeamPatchSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const actor = getAuthUser(c) as JWTPayload | undefined;
	const team = [...getChapterTeam(state)];
	const nextState: ProjectState = { ...state, chapterTeam: team };
	const changes: string[] = [];

	if (parsed.data.productionMode !== undefined && parsed.data.productionMode !== getProductionMode(state)) {
		nextState.productionMode = parsed.data.productionMode;
		changes.push(`mode → ${parsed.data.productionMode}`);
	}
	if (parsed.data.updateMemberId !== undefined && parsed.data.role !== undefined) {
		const memberIndex = team.findIndex(
			(member) => member.id === parsed.data.updateMemberId || member.userId === parsed.data.updateMemberId,
		);
		if (memberIndex < 0) {
			return c.json({ error: "Team member not found", code: "chapter_team_member_not_found" }, 404);
		}
		const updated = { ...team[memberIndex]!, role: parsed.data.role };
		team[memberIndex] = updated;
		changes.push(`${updated.displayName ?? updated.email ?? updated.userId} → ${parsed.data.role}`);
	}

	if (changes.length === 0) {
		return c.json({ productionMode: getProductionMode(state), team: await serializeTeamForCaller(c, state) });
	}

	ensureProjectWorkflow(nextState);
	appendActivity(nextState, createActivity({
		type: "team_member_updated",
		message: `Chapter team updated: ${changes.join(", ")}`,
		actor: actor?.userId,
	}));
	try {
		await commitProjectStateWithCas(idResult, projectCasBaseHash, nextState);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, nextState);
	return c.json({ productionMode: getProductionMode(nextState), team: await serializeTeamForCaller(c, nextState) });
});

// DELETE a chapter team member (by membership id or resolved UID).
project.delete("/:id/team/:memberId", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	const accessError = await checkChapterTeamManageAccess(c, state);
	if (accessError) return accessError;
	const projectCasBaseHash = hashProjectState(state);

	const memberId = c.req.param("memberId");
	const team = getChapterTeam(state);
	const target = resolveTeamMember(team, memberId);
	if (!target) {
		return c.json({ error: "Team member not found", code: "chapter_team_member_not_found" }, 404);
	}
	const actor = getAuthUser(c) as JWTPayload | undefined;
	const nextTeam = team.filter((member) => member.id !== target.id);
	const nextState: ProjectState = { ...state, chapterTeam: nextTeam };
	ensureProjectWorkflow(nextState);
	appendActivity(nextState, createActivity({
		type: "team_member_removed",
		message: `Removed ${target.displayName ?? target.email ?? target.userId ?? "a collaborator"} from the chapter team`,
		actor: actor?.userId,
		metadata: { chapterTeamMemberId: target.id },
	}));
	try {
		await commitProjectStateWithCas(idResult, projectCasBaseHash, nextState);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, nextState);
	return c.json({ ok: true, removed: serializeTeamMember(target, { includeEmail: await canReadChapterTeamEmail(c, nextState) }), productionMode: getProductionMode(nextState) });
});

// POST accept a pending EMAIL invite for the AUTHENTICATED user. An email invite is
// stored as a pending, account-UNLINKED row at send time (so the roster/activity can
// never leak whether an email maps to a registered user — codex P1-2,3). The invitee
// links + activates their own membership here, by their VERIFIED email. No team-manage
// authority is required (the user is acting on their OWN invite), but the membership is
// only granted when a matching pending invite actually exists.
project.post("/:id/team/accept", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized" }, 401);
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	// A frozen (refund/chargeback-suspended) workspace blocks ALL mutating project ops for
	// EVERYONE. Accepting an invite writes project state (chapterTeam + workflow + activity),
	// so it is blocked too — this route commits directly via CAS and does not pass through the
	// central catalog gate, so the suspension check is enforced explicitly here (codex P1).
	if (
		state.workspaceId?.trim()
		&& workspaceAccessStore
		&& (await workspaceAccessStore.isWorkspaceSuspended(state.workspaceId.trim()))
	) {
		return c.json({ error: "Workspace is suspended", code: "workspace_suspended" }, 403);
	}

	// Only a VERIFIED email may accept (so an invite can't be claimed by an account that
	// merely typed someone else's address). Load the authoritative user record for the
	// canonical email + display name rather than trusting the token alone.
	const account = await authUserStore.load(user.userId).catch(() => null);
	if (!account || !account.isActive || !account.emailVerified) {
		return c.json({ error: "Email must be verified to accept an invite", code: "chapter_team_accept_email_unverified" }, 403);
	}
	const projectCasBaseHash = hashProjectState(state);
	const result = acceptChapterTeamInvite(state, {
		userId: account.id,
		email: account.email,
		displayName: account.name,
	});
	if (!result) {
		// No pending invite for this email — uniform 404 (never reveals roster contents).
		return c.json({ error: "No pending invite for this account", code: "chapter_team_no_pending_invite" }, 404);
	}
	// Already-active members short-circuit (idempotent accept) without a state churn.
	if (getChapterTeam(state).some((m) => m.id === result.member.id && m.status === "active" && m.userId === account.id)) {
		setProjectStateHashHeader(c, state);
		return c.json({ member: serializeTeamMember(result.member, { includeEmail: await canReadChapterTeamEmail(c, state) }), productionMode: getProductionMode(state) });
	}
	const nextState: ProjectState = { ...state, chapterTeam: result.team };
	ensureProjectWorkflow(nextState);
	appendActivity(nextState, createActivity({
		type: "team_member_updated",
		message: `${account.name ?? account.email} accepted the chapter team invite as ${result.member.role}`,
		actor: account.id,
		metadata: { chapterTeamMemberId: result.member.id, role: result.member.role, status: "active" },
	}));
	try {
		await commitProjectStateWithCas(idResult, projectCasBaseHash, nextState);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, nextState);
	return c.json({ member: serializeTeamMember(result.member, { includeEmail: await canReadChapterTeamEmail(c, nextState) }), productionMode: getProductionMode(nextState) }, 200);
});

project.get("/:id/workflow", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	// GET must be read-only/idempotent: only persist the lazy workflow migration
	// when it actually changed state, never as an unconditional side-effect of a
	// read (which let concurrent reopens race writes and churn versions, #279).
	// Persist the lazy migration ONLY when it actually changed state — detected by the
	// migrator itself (cheap, scoped to the fields it touches) instead of hashing the whole
	// multi-MB project twice on every read.
	if (ensureProjectWorkflowChanged(state)) {
		await writeProjectState(idResult, state, { catalogSync: "best-effort" });
	}
	setProjectStateHashHeader(c, state);
	return c.json({
		tasks: state.tasks ?? [],
		activityLog: state.activityLog ?? [],
	});
});

project.get("/:id/pages", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const parsed = projectPageListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state, "read:project", {
		pageIndex: parsed.data.pageIndex,
	});
	if (ownershipError) return ownershipError;

	try {
		const fileSummaries = summarizeProjectPages(state);
		if (projectCatalogStore) {
			const catalogPage = await projectCatalogStore.listProjectPages({
				projectId: idResult,
				limit: parsed.data.limit,
				cursor: parsed.data.cursor,
				status: parsed.data.status,
				pageIndex: parsed.data.pageIndex,
			});
			if (catalogPage.pages.length > 0 || catalogPage.nextCursor || parsed.data.cursor) {
				const mergedPage = paginateProjectPages(mergeProjectPageSummaries(catalogPage.pages, fileSummaries), {
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
					status: parsed.data.status,
					pageIndex: parsed.data.pageIndex,
				});
				return c.json({ pages: mergedPage.pages, nextCursor: mergedPage.nextCursor });
			}
		}

		const filePage = paginateProjectPages(fileSummaries, {
			limit: parsed.data.limit,
			cursor: parsed.data.cursor,
			status: parsed.data.status,
			pageIndex: parsed.data.pageIndex,
		});
		return c.json({ pages: filePage.pages, nextCursor: filePage.nextCursor });
	} catch (error) {
		if (error instanceof InvalidProjectPageCursorError) {
			return c.json({ error: "Invalid project page cursor" }, 400);
		}
		throw error;
	}
});

project.get("/:id/tasks", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const parsed = projectTaskListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	// SCOPED-READ FILTER (authz): this GET authorizes using CALLER-SUPPLIED filters
	// (`pageIndex`/`type`). A page/task-scoped member who omits them is treated as
	// "asking for everything" and hit a blanket project-wide denial — indistinguishable
	// from "not a member". Resolve the caller's membership/scope once: a non-member /
	// insufficient-role caller still gets the opaque 404/403, but a legitimate member
	// who simply omitted the required scoping filter gets an ACTIONABLE error telling
	// them to scope the request, instead of a confusing denial.
	const scopeChecker = await resolveProjectTaskScopeChecker(c, state, "read:project");
	if (scopeChecker instanceof Response) return scopeChecker;
	const taskScopeError = scopeChecker({
		pageIndex: parsed.data.pageIndex,
		taskType: parsed.data.type,
		resourceKind: "task",
	});
	if (taskScopeError) {
		if (parsed.data.pageIndex === undefined || parsed.data.type === undefined) {
			return c.json({
				error: "This task list is scoped — supply pageIndex and type to read your assigned tasks",
				code: "scope_filter_required",
				requiredFilters: ["pageIndex", "type"],
			}, 422);
		}
		return taskScopeError;
	}

	const workflowWasMaterialized = hasMaterializedBaseWorkflowTasks(state);
	ensureProjectWorkflow(state);
	if (!workflowWasMaterialized) {
		await writeProjectState(idResult, state, { catalogSync: "best-effort" });
	}
	const assignee = normalizeAssigneeHandle(parsed.data.assignee);

	try {
		if (projectCatalogStore) {
			const catalogPage = await projectCatalogStore.listProjectTasks({
				projectId: idResult,
				limit: parsed.data.limit,
				cursor: parsed.data.cursor,
				status: parsed.data.status,
				type: parsed.data.type,
				assignee,
				pageIndex: parsed.data.pageIndex,
			});
			if (catalogPage.tasks.length > 0 || catalogPage.nextCursor) {
				return c.json({ tasks: catalogPage.tasks, nextCursor: catalogPage.nextCursor });
			}
		}

		const filePage = paginateProjectTasks(state.tasks ?? [], {
			limit: parsed.data.limit,
			cursor: parsed.data.cursor,
			status: parsed.data.status,
			type: parsed.data.type,
			assignee,
			pageIndex: parsed.data.pageIndex,
		});
		return c.json({ tasks: filePage.tasks, nextCursor: filePage.nextCursor });
	} catch (error) {
		if (error instanceof InvalidProjectTaskCursorError) {
			return c.json({ error: "Invalid project task cursor" }, 400);
		}
		throw error;
	}
});

project.patch("/:id/tasks/bulk", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	// Storage-atomic CAS baseline: the hash of the state AS LOADED here. The commit
	// below re-reads + re-verifies this INSIDE the per-project lock, so a concurrent
	// mutation that committed between this load and our write is rejected (409)
	// rather than silently clobbered.
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = taskBulkUpdateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	ensureProjectWorkflow(state);
	const requestedTaskIds = [...new Set(parsed.data.taskIds.map((taskId) => taskId.trim()).filter(Boolean))];
	// Resolve the caller's project membership/role/scope ONCE for the whole batch,
	// then authorize every task in-memory. Previously each task issued its own
	// checkProjectOwnership -> canAccessProject -> membership query (O(n) ≈ 2n
	// store reads for n tasks across both check phases); this is O(1).
	const scopeChecker = await resolveProjectTaskScopeChecker(c, state, "update:project");
	if (scopeChecker instanceof Response) return scopeChecker;
	// Phase 1 — scope parsed from each requested task id (mirrors
	// checkProjectTaskIdScopeAccess: falls back to a bare task resource check when
	// the id does not match the page-N-type shape).
	for (const taskId of requestedTaskIds) {
		const taskScope = parseWorkflowTaskIdScope(taskId);
		const ownershipError = scopeChecker(taskScope
			? {
				language: state.targetLang,
				pageIndex: taskScope.pageIndex,
				taskType: taskScope.taskType,
				resourceKind: "task",
			}
			: { resourceKind: "task" });
		if (ownershipError) return ownershipError;
	}
	const requestedTaskSet = new Set(requestedTaskIds);
	const matchedTasks = (state.tasks ?? []).filter((task) => requestedTaskSet.has(task.id));
	if (!matchedTasks.length) return c.json({ error: "No matching tasks found" }, 404);
	const matchedTaskIds = new Set(matchedTasks.map((task) => task.id));
	// Phase 2 — scope from the matched task objects (mirrors checkProjectTaskAccess).
	for (const task of matchedTasks) {
		const ownershipError = scopeChecker({
			language: state.targetLang,
			pageIndex: task.pageIndex,
			taskType: task.type,
			resourceKind: "task",
		});
		if (ownershipError) return ownershipError;
	}

	const now = new Date().toISOString();
	const nextStatus = parsed.data.status as WorkflowTaskStatus | undefined;
	const nextPriority = parsed.data.priority as WorkflowTaskPriority | undefined;
	const nextAssignee = parsed.data.assignee === undefined
		? undefined
		: normalizeAssigneeHandle(parsed.data.assignee);
	const dueInput = normalizeTaskDueAtInput(parsed.data.dueAt);
	if (dueInput.error) {
		return c.json({ error: dueInput.error }, 400);
	}
	const changedTasks: Array<{
		taskId: string;
		pageIndex: number;
		taskType: string;
		previousStatus: WorkflowTaskStatus;
		status: WorkflowTaskStatus;
		previousPriority: WorkflowTaskPriority;
		priority: WorkflowTaskPriority;
		previousAssignee?: string;
		assignee?: string;
		previousDueAt?: string;
		dueAt?: string;
	}> = [];

	for (const task of matchedTasks) {
		const previousStatus = task.status;
		const previousAssignee = task.assignee;
		const previousPriority = normalizeWorkflowTaskPriority(task.priority);
		const previousDueAt = task.dueAt;
		const statusChanged = nextStatus !== undefined && nextStatus !== previousStatus;
		const priorityChanged = nextPriority !== undefined && nextPriority !== previousPriority;
		const assigneeChanged = parsed.data.assignee !== undefined && nextAssignee !== previousAssignee;
		const dueAtChanged = dueInput.provided && dueInput.dueAt !== previousDueAt;
		if (!statusChanged && !priorityChanged && !assigneeChanged && !dueAtChanged) continue;

		if (nextStatus !== undefined) task.status = nextStatus;
		if (nextPriority !== undefined) task.priority = nextPriority;
		if (parsed.data.assignee !== undefined) task.assignee = nextAssignee;
		if (dueInput.provided) task.dueAt = dueInput.dueAt;
		task.updatedAt = now;
		changedTasks.push({
			taskId: task.id,
			pageIndex: task.pageIndex,
			taskType: task.type,
			previousStatus,
			status: task.status,
			previousPriority,
			priority: task.priority,
			previousAssignee,
			assignee: task.assignee,
			previousDueAt,
			dueAt: task.dueAt,
		});
	}

	if (!changedTasks.length) {
		return c.json({
			tasks: matchedTasks,
			activityLog: state.activityLog ?? [],
			changedCount: 0,
			missingTaskIds: requestedTaskIds.filter((taskId) => !matchedTaskIds.has(taskId)),
		});
	}

	const changeLabels = [
		nextStatus !== undefined ? `status ${nextStatus}` : null,
		nextPriority !== undefined ? `priority ${nextPriority}` : null,
		parsed.data.assignee !== undefined ? `assignee ${formatAssigneeHandle(nextAssignee)}` : null,
		dueInput.provided ? `due ${dueInput.dueAt ?? "cleared"}` : null,
	].filter(Boolean);
	const missingTaskIds = requestedTaskIds.filter((taskId) => !matchedTaskIds.has(taskId));
	appendActivity(state, createActivity({
		type: "task_updated",
		message: `Batch updated ${changedTasks.length} tasks: ${changeLabels.join(", ")}`,
		metadata: {
			count: changedTasks.length,
			taskIds: changedTasks.map((task) => task.taskId),
			missingTaskIds,
			status: nextStatus,
			priority: nextPriority,
			assignee: nextAssignee,
			dueAt: dueInput.provided ? dueInput.dueAt : undefined,
			changes: changedTasks,
		},
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	// P1: a BULK task update previously emitted NOTHING, so collaborators' boards went
	// stale. Emit AFTER the CAS commit succeeds, scoped to the project's workspace.
	// Event-storm avoidance: ONE batched activity_feed event for the whole batch
	// (not one per task), then a workflow_transition ONLY for tasks whose STATUS
	// actually changed (those are the moves that re-position Kanban cards) — a
	// priority/assignee/due-only batch emits no per-task transitions. Best-effort.
	if (state.workspaceId) {
		seedWorkspaceLookupForTesting(idResult, state.workspaceId);
		const actor = (getAuthUser(c) as JWTPayload | undefined)?.email
			?? (getAuthUser(c) as JWTPayload | undefined)?.userId
			?? "user";
		await emitActivityFeedEvent({
			workspaceId: state.workspaceId,
			actor,
			verb: "bulk_updated",
			subjectKind: "task",
			projectId: idResult,
			metadata: {
				count: changedTasks.length,
				taskIds: changedTasks.map((task) => task.taskId),
				status: nextStatus,
				priority: nextPriority,
				assignee: nextAssignee,
				dueAt: dueInput.provided ? dueInput.dueAt : undefined,
			},
		}).catch(() => {/* swallow */});
		const statusMoves = changedTasks.filter((task) => task.previousStatus !== task.status);
		await Promise.all(statusMoves.map((task) =>
			emitWorkflowTransitionEvent({
				subjectKind: "task",
				subjectId: task.taskId,
				from: task.previousStatus,
				to: task.status,
				by: actor,
				projectId: idResult,
				workspaceId: state.workspaceId,
			}).catch(() => {/* swallow */}),
		));
	}
	return c.json({
		tasks: matchedTasks,
		activityLog: state.activityLog ?? [],
		changedCount: changedTasks.length,
		missingTaskIds,
		version,
	});
});

project.patch("/:id/tasks/:taskId", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	// Storage-atomic CAS baseline: the hash of the state AS LOADED here. The commit
	// below re-reads + re-verifies this INSIDE the per-project lock, so a concurrent
	// mutation that committed between this load and our write is rejected (409)
	// rather than silently clobbered.
	const projectCasBaseHash = hashProjectState(state);

	ensureProjectWorkflow(state);
	const taskId = c.req.param("taskId");
	const scopedAccessError = await checkProjectTaskIdScopeAccess(c, state, taskId);
	if (scopedAccessError) return scopedAccessError;

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = taskUpdateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const task = state.tasks?.find((item) => item.id === taskId);
	if (!task) return c.json({ error: "Task not found" }, 404);
	const ownershipError = await checkProjectTaskAccess(c, state, task);
	if (ownershipError) return ownershipError;

	const previousStatus = task.status;
	const previousAssignee = task.assignee;
	const previousPriority = normalizeWorkflowTaskPriority(task.priority);
	const previousDueAt = task.dueAt;
	const nextStatus = parsed.data.status as WorkflowTaskStatus | undefined;
	const nextPriority = parsed.data.priority as WorkflowTaskPriority | undefined;
	const nextAssignee = parsed.data.assignee === undefined
		? previousAssignee
		: normalizeAssigneeHandle(parsed.data.assignee);
	const dueInput = normalizeTaskDueAtInput(parsed.data.dueAt);
	if (dueInput.error) {
		return c.json({ error: dueInput.error }, 400);
	}
	const statusChanged = nextStatus !== undefined && nextStatus !== previousStatus;
	const assigneeChanged = nextAssignee !== previousAssignee;
	const priorityChanged = nextPriority !== undefined && nextPriority !== previousPriority;
	const dueAtChanged = dueInput.provided && dueInput.dueAt !== previousDueAt;

	if (!statusChanged && !assigneeChanged && !priorityChanged && !dueAtChanged) {
		return c.json({
			task,
			activityLog: state.activityLog ?? [],
		});
	}

	if (nextStatus !== undefined) {
		task.status = nextStatus;
	}
	if (nextPriority !== undefined) {
		task.priority = nextPriority;
	}
	if (parsed.data.assignee !== undefined) {
		task.assignee = nextAssignee;
	}
	if (dueInput.provided) {
		task.dueAt = dueInput.dueAt;
	}
	task.updatedAt = new Date().toISOString();
	const changes = [
		statusChanged ? `${previousStatus} -> ${task.status}` : null,
		priorityChanged ? `priority ${previousPriority} -> ${task.priority}` : null,
		assigneeChanged ? `assignee ${formatAssigneeHandle(previousAssignee)} -> ${formatAssigneeHandle(task.assignee)}` : null,
		dueAtChanged ? `due ${previousDueAt || "unset"} -> ${task.dueAt || "cleared"}` : null,
	].filter(Boolean);
	appendActivity(state, createActivity({
		type: "task_updated",
		message: `${task.title}: ${changes.join(", ")}`,
		pageIndex: task.pageIndex,
		taskId: task.id,
		metadata: {
			taskType: task.type,
			previousStatus,
			status: task.status,
			previousPriority,
			priority: task.priority,
			previousAssignee,
			assignee: task.assignee,
			previousDueAt,
			dueAt: task.dueAt,
		},
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	// P1: a single task update previously committed but emitted NOTHING, so other
	// collaborators' boards/lanes went stale until a manual reload. Emit AFTER the
	// CAS commit succeeds (never advertise a write that lost the CAS race), scoped to
	// the project's workspace subscribers: an activity_feed event so any field change
	// (priority/assignee/due) re-syncs the card, plus a workflow_transition whenever
	// the STATUS actually changed so Kanban lanes move the card live. Best-effort — a
	// realtime failure never fails the task write.
	if (state.workspaceId) {
		seedWorkspaceLookupForTesting(idResult, state.workspaceId);
		const actor = (getAuthUser(c) as JWTPayload | undefined)?.email
			?? (getAuthUser(c) as JWTPayload | undefined)?.userId
			?? "user";
		await emitActivityFeedEvent({
			workspaceId: state.workspaceId,
			actor,
			verb: "updated",
			subject: task.id,
			subjectKind: "task",
			projectId: idResult,
			metadata: {
				pageIndex: task.pageIndex,
				taskType: task.type,
				previousStatus,
				status: task.status,
				previousPriority,
				priority: task.priority,
				previousAssignee,
				assignee: task.assignee,
				previousDueAt,
				dueAt: task.dueAt,
			},
		}).catch(() => {/* swallow */});
		if (statusChanged) {
			await emitWorkflowTransitionEvent({
				subjectKind: "task",
				subjectId: task.id,
				from: previousStatus,
				to: task.status,
				by: actor,
				projectId: idResult,
				workspaceId: state.workspaceId,
			}).catch(() => {/* swallow */});
		}
	}
	return c.json({
		task,
		activityLog: state.activityLog ?? [],
		version,
	});
});

project.get("/:id/comments", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const parsed = projectCommentListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	// SCOPED-READ FILTER (authz): same as GET /:id/tasks — a page-scoped member who
	// omits `pageIndex` is otherwise denied project-wide and cannot tell that from a
	// non-membership 404. Resolve scope once; a non-member/insufficient-role caller
	// keeps the opaque 404/403, but a scoped member who omitted `pageIndex` gets an
	// actionable error telling them to scope the request.
	const scopeChecker = await resolveProjectTaskScopeChecker(c, state, "read:project");
	if (scopeChecker instanceof Response) return scopeChecker;
	const commentScopeError = scopeChecker({
		pageIndex: parsed.data.pageIndex,
		resourceKind: "comment",
	});
	if (commentScopeError) {
		if (parsed.data.pageIndex === undefined) {
			return c.json({
				error: "This comment list is scoped — supply pageIndex to read comments in your scope",
				code: "scope_filter_required",
				requiredFilters: ["pageIndex"],
			}, 422);
		}
		return commentScopeError;
	}

	// Read-only GET: only persist the comment normalization if it changed something
	// on disk; a pure read must not write (avoids concurrent-read write races).
	if (normalizeProjectCommentsChanged(state)) {
		await writeProjectState(idResult, state, { catalogSync: "best-effort" });
	}
	const limit = parsed.data.limit ?? MAX_PROJECT_COMMENTS;
	try {
		if (projectCatalogStore) {
			const catalogPage = await projectCatalogStore.listProjectComments({
				projectId: idResult,
				limit,
				cursor: parsed.data.cursor,
				status: parsed.data.status,
				pageIndex: parsed.data.pageIndex,
				layerId: parsed.data.layerId,
				author: parsed.data.author,
			});
			if (catalogPage.comments.length > 0 || parsed.data.cursor) {
				return c.json({ comments: catalogPage.comments, nextCursor: catalogPage.nextCursor });
			}
		}

		const filePage = paginateProjectComments(state.comments ?? [], {
			limit,
			cursor: parsed.data.cursor,
			status: parsed.data.status,
			pageIndex: parsed.data.pageIndex,
			layerId: parsed.data.layerId,
			author: parsed.data.author,
		});
		return c.json({ comments: filePage.comments, nextCursor: filePage.nextCursor });
	} catch (error) {
		if (error instanceof InvalidProjectCommentCursorError) {
			return c.json({ error: "Invalid project comment cursor" }, 400);
		}
		throw error;
	}
});

project.post("/:id/comments", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	// Storage-atomic CAS baseline: the hash of the state AS LOADED here. The commit
	// below re-reads + re-verifies this INSIDE the per-project lock, so a concurrent
	// mutation that committed between this load and our write is rejected (409)
	// rather than silently clobbered.
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = commentCreateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	if (parsed.data.pageIndex >= state.pages.length) {
		return c.json({ error: "Page not found" }, 404);
	}
	// P1: pass `resourceKind: "comment"` so the scope check treats this as a comment,
	// not a task. A comment is NOT task-typed, so a TASK-TYPE-scoped collaborator
	// (e.g. a cleaner scoped to `taskTypes:["clean"]`) who has page access must be
	// able to comment on that page — they were previously locked out because the
	// task-type relaxation only fired for reads. The relaxation in project-catalog
	// now also covers comment writes with a page/chapter context (see
	// canRelaxTaskTypeScopeForPageContext), so page/language scope is still enforced
	// (an out-of-scope page is still denied) without over-restricting on task type.
	const ownershipError = await checkProjectOwnership(c, state, "update:project", {
		pageIndex: parsed.data.pageIndex,
		resourceKind: "comment",
	});
	if (ownershipError) return ownershipError;

	const user = getAuthUser(c) as JWTPayload | undefined;
	const comments = normalizeProjectComments(state);
	// Stamp the authenticated identity as the author (email preferred, then userId)
	// so comments attribute to the real signer — mirroring the review-decision route
	// (`actor: user?.email || user?.userId`). Without this the service default left
	// every comment as the literal "local-user". The client never sends an author
	// (it's not in commentCreateSchema), so this can't be spoofed.
	const comment = createProjectComment({
		...parsed.data,
		author: user?.email || user?.userId || "local-user",
	});
	state.comments = [comment, ...comments].slice(0, MAX_PROJECT_COMMENTS);
	appendActivity(state, createActivity({
		type: "comment_added",
		message: `Comment added on page ${comment.pageIndex + 1}`,
		messageKey: "activity.commentAdded",
		messageParams: { page: comment.pageIndex + 1 },
		pageIndex: comment.pageIndex,
		metadata: { commentId: comment.id, layerId: comment.layerId, region: comment.region, mentions: comment.mentions },
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	// W2.7 Realtime: SSE subscribers receive a comment_new event so the comments
	// pane and the activity feed update without a page reload.
	if (state.workspaceId) seedWorkspaceLookupForTesting(idResult, state.workspaceId);
	await emitCommentNewEvent({
		commentId: comment.id,
		projectId: idResult,
		pageIndex: comment.pageIndex,
		author: comment.author ?? "user",
		excerpt: comment.body?.slice(0, 200),
	}).catch(() => {/* swallow */});
	if (state.workspaceId) {
		await emitActivityFeedEvent({
			workspaceId: state.workspaceId,
			actor: comment.author ?? "user",
			verb: "commented",
			subject: comment.id,
			subjectKind: "comment",
			projectId: idResult,
			metadata: { pageIndex: comment.pageIndex },
		}).catch(() => {/* swallow */});
	}
	// P1.6: resolve the bare `@handle` mentions to workspace-member user IDs and
	// notify() each (in-app + email per their prefs). Best-effort — never fails the
	// write. Tenant-scoped: only this workspace's members are candidates.
	await notifyCommentMentions({
		state,
		projectId: idResult,
		comment,
		authorUserId: user?.userId,
		notifyType: "comment_new",
	}).catch(() => {/* swallow */});
	return c.json({
		comment,
		comments: state.comments,
		activityLog: state.activityLog ?? [],
		version,
	});
});

project.patch("/:id/comments/:commentId", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	// Storage-atomic CAS baseline: the hash of the state AS LOADED here. The commit
	// below re-reads + re-verifies this INSIDE the per-project lock, so a concurrent
	// mutation that committed between this load and our write is rejected (409)
	// rather than silently clobbered.
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = commentUpdateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const comments = normalizeProjectComments(state);
	const comment = comments.find((item) => item.id === c.req.param("commentId"));
	if (!comment) return c.json({ error: "Comment not found" }, 404);

	// P1: authorize against the COMMENT's OWN page + the comment resourceKind, not an
	// empty project-wide context. The previous unscoped `checkProjectOwnership(c,
	// state)` rejected ANY page/task-type-scoped collaborator on an undefined
	// pageIndex/taskType (`isFineGrainedProjectWideAccess` treats undefined as
	// "asking for everything") — locking a scoped member out of editing/resolving a
	// comment on a page they DO have access to. We must locate the comment first to
	// know its page, then authorize that exact scope: a member scoped to the comment's
	// page may edit it; a member scoped to a DIFFERENT page is still denied (404).
	const ownershipError = await checkProjectOwnership(c, state, "update:project", {
		pageIndex: comment.pageIndex,
		resourceKind: "comment",
	});
	if (ownershipError) return ownershipError;

	const previousStatus = comment.status;
	const previousBody = comment.body;
	// Snapshot the ALREADY-notified mentions BEFORE we re-resolve, so an edit that
	// adds a new @handle only pings the newly-added mentionee — never re-pinging the
	// people the create (or a prior edit) already notified. Idempotent on re-PATCH.
	const previousMentions = new Set(comment.mentions ?? []);
	if (parsed.data.body !== undefined) {
		comment.body = parsed.data.body;
	}
	if (parsed.data.status !== undefined) {
		comment.status = parsed.data.status as ProjectCommentStatus;
	}

	if (comment.status === previousStatus && comment.body === previousBody) {
		return c.json({ comment, comments, activityLog: state.activityLog ?? [] });
	}

	// P1: a comment EDIT must re-resolve @mentions. Previously only the create path
	// extracted mentions, so editing a comment to add/change an @handle left the
	// stored `mentions` stale and never pinged the newly-mentioned user. Re-extract
	// from the (possibly changed) body so the persisted mentions stay accurate and
	// the notify step below has the full current set to diff against.
	const bodyChanged = comment.body !== previousBody;
	if (bodyChanged) {
		comment.mentions = extractProjectCommentMentions(comment.body ?? "");
	}

	comment.updatedAt = new Date().toISOString();
	const activityType = comment.status === "resolved" && previousStatus !== "resolved"
		? "comment_resolved"
		: "comment_updated";
	appendActivity(state, createActivity({
		type: activityType,
		message: activityType === "comment_resolved"
			? `Comment resolved on page ${comment.pageIndex + 1}`
			: `Comment updated on page ${comment.pageIndex + 1}`,
		messageKey: activityType === "comment_resolved" ? "activity.commentResolved" : "activity.commentUpdated",
		messageParams: { page: comment.pageIndex + 1 },
		pageIndex: comment.pageIndex,
		metadata: { commentId: comment.id, previousStatus, status: comment.status },
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	// Realtime: a comment edit/resolve previously only committed — other reviewers
	// watching the comments pane / activity feed never saw it without a reload.
	// Emit an activity_feed event AFTER the CAS commit succeeds (so we never
	// advertise a write that lost the CAS race) so the resolve/update propagates
	// live. Best-effort: a realtime failure never fails the business write.
	if (state.workspaceId) {
		seedWorkspaceLookupForTesting(idResult, state.workspaceId);
		const actor = (getAuthUser(c) as JWTPayload | undefined)?.email
			?? (getAuthUser(c) as JWTPayload | undefined)?.userId
			?? comment.author ?? "user";
		await emitActivityFeedEvent({
			workspaceId: state.workspaceId,
			actor,
			verb: activityType === "comment_resolved" ? "resolved" : "updated",
			subject: comment.id,
			subjectKind: "comment",
			projectId: idResult,
			metadata: { pageIndex: comment.pageIndex, previousStatus, status: comment.status },
		}).catch(() => {/* swallow */});
	}
	// P1: notify ONLY the mentions this edit newly ADDED (handles not present before
	// the edit) so the freshly-mentioned user gets pinged once, while everyone the
	// create / a prior edit already notified is NOT re-pinged. We pass a shallow
	// comment view carrying just the newly-added handles to the shared resolver —
	// tenant-scoped + author-skipped + best-effort like the create path.
	if (bodyChanged) {
		const newlyAddedMentions = (comment.mentions ?? []).filter((handle) => !previousMentions.has(handle));
		if (newlyAddedMentions.length > 0) {
			const editor = getAuthUser(c) as JWTPayload | undefined;
			await notifyCommentMentions({
				state,
				projectId: idResult,
				comment: { ...comment, mentions: newlyAddedMentions },
				authorUserId: editor?.userId,
				notifyType: "comment_reply",
			}).catch(() => {/* swallow */});
		}
	}
	return c.json({
		comment,
		comments,
		activityLog: state.activityLog ?? [],
		version,
	});
});

project.get("/:id/review-decisions", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const parsed = projectReviewDecisionListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state, "read:project", {
		pageIndex: parsed.data.pageIndex,
	});
	if (ownershipError) return ownershipError;

	// Read-only GET: persist the normalization only when it actually changed state.
	if (normalizeProjectReviewDecisionsChanged(state)) {
		await writeProjectState(idResult, state, { catalogSync: "best-effort" });
	}
	const limit = parsed.data.limit ?? MAX_PAGE_REVIEW_DECISIONS;
	try {
		if (projectCatalogStore) {
			const catalogPage = await projectCatalogStore.listProjectReviewDecisions({
				projectId: idResult,
				limit,
				cursor: parsed.data.cursor,
				status: parsed.data.status,
				pageIndex: parsed.data.pageIndex,
				actor: parsed.data.actor,
			});
			if (catalogPage.decisions.length > 0 || parsed.data.cursor) {
				return c.json({ decisions: catalogPage.decisions, nextCursor: catalogPage.nextCursor });
			}
		}

		const filePage = paginateProjectReviewDecisions(state.reviewDecisions ?? [], {
			limit,
			cursor: parsed.data.cursor,
			status: parsed.data.status,
			pageIndex: parsed.data.pageIndex,
			actor: parsed.data.actor,
		});
		return c.json({ decisions: filePage.decisions, nextCursor: filePage.nextCursor });
	} catch (error) {
		if (error instanceof InvalidProjectReviewDecisionCursorError) {
			return c.json({ error: "Invalid project review decision cursor" }, 400);
		}
		throw error;
	}
});

project.post("/:id/review-decisions", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	// Storage-atomic CAS baseline: the hash of the state AS LOADED here. The commit
	// below re-reads + re-verifies this INSIDE the per-project lock, so a concurrent
	// mutation that committed between this load and our write is rejected (409)
	// rather than silently clobbered.
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = reviewDecisionCreateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	if (parsed.data.pageIndex >= state.pages.length) {
		return c.json({ error: "Page not found" }, 404);
	}
	const ownershipError = await checkProjectOwnership(c, state, "update:project", {
		pageIndex: parsed.data.pageIndex,
		taskType: "review",
		resourceKind: "task",
	});
	if (ownershipError) return ownershipError;

	const user = getAuthUser(c) as JWTPayload | undefined;
	const decisions = normalizeProjectReviewDecisions(state);
	const decision = createPageReviewDecision({
		...parsed.data,
		status: parsed.data.status as PageReviewDecisionStatus,
		actor: user?.email || user?.userId || "local-user",
	});
	state.reviewDecisions = [decision, ...decisions].slice(0, MAX_PAGE_REVIEW_DECISIONS);

	ensureProjectWorkflow(state);
	const reviewTask = state.tasks?.find((task) => task.pageIndex === decision.pageIndex && task.type === "review");
	const previousReviewTaskStatus = reviewTask?.status;
	if (reviewTask) {
		reviewTask.status = decision.status === "approved" ? "done" : "review";
		reviewTask.updatedAt = decision.updatedAt;
	}

	appendActivity(state, createActivity({
		type: "review_decision_added",
		message: decision.status === "approved"
			? `Page ${decision.pageIndex + 1} approved`
			: `Page ${decision.pageIndex + 1} changes requested`,
		messageKey: decision.status === "approved" ? "activity.pageApproved" : "activity.pageChangesRequested",
		messageParams: { page: decision.pageIndex + 1 },
		pageIndex: decision.pageIndex,
		taskId: reviewTask?.id,
		metadata: {
			decisionId: decision.id,
			status: decision.status,
			reviewTaskStatus: reviewTask?.status,
		},
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	// Realtime: a review decision mutates the page's review task (approve→done /
	// changes_requested→review) but previously emitted NOTHING, so Work/Focus lanes
	// and the activity feed only updated on a manual reload. Emit AFTER the CAS
	// commit succeeds: an activity_feed event for the decision, plus a
	// workflow_transition event whenever the review task's status actually changed
	// so task lanes move the card live. Best-effort — a realtime failure never
	// fails the decision write.
	if (state.workspaceId) {
		seedWorkspaceLookupForTesting(idResult, state.workspaceId);
		const actor = decision.actor ?? "user";
		await emitActivityFeedEvent({
			workspaceId: state.workspaceId,
			actor,
			verb: decision.status === "approved" ? "approved" : "requested_changes",
			subject: decision.id,
			subjectKind: "review_decision",
			projectId: idResult,
			metadata: {
				pageIndex: decision.pageIndex,
				status: decision.status,
				taskId: reviewTask?.id,
				reviewTaskStatus: reviewTask?.status,
			},
		}).catch(() => {/* swallow */});
		if (reviewTask && reviewTask.status !== previousReviewTaskStatus) {
			await emitWorkflowTransitionEvent({
				subjectKind: "task",
				subjectId: reviewTask.id,
				from: previousReviewTaskStatus ?? "",
				to: reviewTask.status,
				by: actor,
				projectId: idResult,
				workspaceId: state.workspaceId,
			}).catch(() => {/* swallow */});
		}
	}
	// P1: notify @mentions in the decision note (parity with comments). A reviewer
	// writing "@alice please re-check" on a changes-requested decision now pings
	// Alice. Tenant-scoped, author-skipped, best-effort.
	await notifyReviewMentions({
		workspaceId: state.workspaceId,
		projectId: idResult,
		mentions: extractProjectCommentMentions(decision.body ?? ""),
		actor: decision.actor,
		authorUserId: user?.userId,
		subjectLabel: "review decision",
		linkUrl: `/projects/${idResult}/review?page=${decision.pageIndex + 1}`,
		body: decision.body,
		metadata: { projectId: idResult, decisionId: decision.id, pageIndex: decision.pageIndex, status: decision.status },
	}).catch(() => {/* swallow */});
	return c.json({
		decision,
		decisions: state.reviewDecisions,
		tasks: state.tasks ?? [],
		activityLog: state.activityLog ?? [],
		version,
	});
});

// ── Review assignments ───────────────────────────────────────
// Assign a slice of review work to a specific reviewer, list current
// assignments, update one, or cancel one. Cancel ALWAYS notifies the affected
// reviewer (in-app + email) with a mandatory reason — the system can never
// cancel silently (the user's explicit ask).

project.get("/:id/review-assignments", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state, "read:project");
	if (ownershipError) return ownershipError;

	// Read-only: normalize in-memory for the response only. A GET must never write
	// project state (no version churn / surprise writes on a safe method); any
	// persisted normalization happens lazily on the next real mutation (POST/PATCH).
	const assignments = normalizeReviewAssignments(state);
	return c.json({ assignments });
});

project.post("/:id/review-assignments", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = reviewAssignmentCreateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	// Only owner/lead may assign review work.
	const manageError = await checkReviewAssignmentManageAccess(c, state);
	if (manageError) return manageError;

	const assignee = await resolveReviewAssignee(c, state, parsed.data.assigneeUserId);
	if ("error" in assignee) return assignee.error;

	// Reject a narrow assignment whose pages are ALL out of range, rather than
	// silently widening it to the whole chapter (which would turn a bad narrow
	// assignment into an unintended broad one).
	if (resolveReviewAssignmentScope(parsed.data.pageIndexes, state.pages.length).kind === "invalid") {
		return c.json({ error: "All provided pageIndexes are out of range", code: "review_assignment_invalid_scope" }, 400);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const actor = user?.email || user?.userId || "local-user";
	const assignments = normalizeReviewAssignments(state);
	const assignment = createReviewAssignment({
		assigneeUserId: parsed.data.assigneeUserId,
		assigneeHandle: assignee.handle,
		targetLang: parsed.data.targetLang,
		pageIndexes: parsed.data.pageIndexes,
		priority: parsed.data.priority,
		dueAt: parsed.data.dueAt,
		instructions: parsed.data.instructions,
		assignedBy: actor,
	}, state.pages.length);
	state.reviewAssignments = [assignment, ...assignments].slice(0, MAX_REVIEW_ASSIGNMENTS);

	const scopeLabel = describeReviewAssignmentScope(assignment);
	appendActivity(state, createActivity({
		type: "review_assigned",
		message: `Review assigned to ${assignment.assigneeHandle ?? assignment.assigneeUserId} (${scopeLabel})`,
		messageKey: "activity.reviewAssigned",
		messageParams: { name: assignment.assigneeHandle ?? assignment.assigneeUserId, scope: scopeLabel },
		actor,
		metadata: { assignmentId: assignment.id, assigneeUserId: assignment.assigneeUserId, scope: scopeLabel },
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflictResp = projectCasConflictResponse(c, error);
		if (conflictResp) return conflictResp;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	// Notify the assignee that they have review work (in-app + email per prefs).
	await notify({
		userId: assignment.assigneeUserId,
		type: "work_assigned",
		// Baked English = email/legacy fallback; the in-app row is localised in the
		// viewer's locale through the metadata i18n keys.
		title: `${actor} assigned you a review`,
		body: `${scopeLabel}${assignment.instructions ? ` — ${assignment.instructions}` : ""}`,
		workspaceId: state.workspaceId,
		linkUrl: `/projects/${idResult}/review`,
		metadata: {
			projectId: idResult,
			assignmentId: assignment.id,
			scope: scopeLabel,
			titleKey: "notifications.message.reviewAssignedTitle",
			titleParams: { actor },
			bodyKey: assignment.instructions ? "notifications.message.reviewAssignedBodyWithNote" : "notifications.message.reviewAssignedBody",
			bodyParams: assignment.instructions ? { scope: scopeLabel, note: assignment.instructions } : { scope: scopeLabel },
		},
	}).catch(() => {/* swallow */});
	return c.json({ assignment, assignments: state.reviewAssignments, activityLog: state.activityLog ?? [], version });
});

project.patch("/:id/review-assignments/:assignmentId", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = reviewAssignmentUpdateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const manageError = await checkReviewAssignmentManageAccess(c, state);
	if (manageError) return manageError;

	const assignmentId = c.req.param("assignmentId");
	const assignments = normalizeReviewAssignments(state);
	const existing = assignments.find((entry) => entry.id === assignmentId);
	if (!existing) return c.json({ error: "Review assignment not found" }, 404);
	if (existing.status === "cancelled") {
		return c.json({ error: "Cannot update a cancelled review assignment", code: "review_assignment_cancelled" }, 409);
	}
	// Same scope guard as create: an explicit pageIndexes update that is entirely
	// out of range must not silently widen the assignment to the whole chapter.
	if (parsed.data.pageIndexes !== undefined
		&& resolveReviewAssignmentScope(parsed.data.pageIndexes, state.pages.length).kind === "invalid") {
		return c.json({ error: "All provided pageIndexes are out of range", code: "review_assignment_invalid_scope" }, 400);
	}

	const updated = updateReviewAssignment(existing, parsed.data, state.pages.length);
	state.reviewAssignments = assignments.map((entry) => entry.id === assignmentId ? updated : entry);
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflictResp = projectCasConflictResponse(c, error);
		if (conflictResp) return conflictResp;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	return c.json({ assignment: updated, assignments: state.reviewAssignments, activityLog: state.activityLog ?? [], version });
});

project.post("/:id/review-assignments/:assignmentId/cancel", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	// Reason is MANDATORY (schema enforces min(1)) — a cancel can never be silent.
	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = reviewAssignmentCancelSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const manageError = await checkReviewAssignmentManageAccess(c, state);
	if (manageError) return manageError;

	const assignmentId = c.req.param("assignmentId");
	const assignments = normalizeReviewAssignments(state);
	const existing = assignments.find((entry) => entry.id === assignmentId);
	if (!existing) return c.json({ error: "Review assignment not found" }, 404);
	if (existing.status === "cancelled") {
		return c.json({ error: "Review assignment is already cancelled", code: "review_assignment_cancelled" }, 409);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const actor = user?.email || user?.userId || "local-user";
	const cancelled = cancelReviewAssignment(existing, { reason: parsed.data.reason, cancelledBy: actor });
	state.reviewAssignments = assignments.map((entry) => entry.id === assignmentId ? cancelled : entry);

	const scopeLabel = describeReviewAssignmentScope(cancelled);
	appendActivity(state, createActivity({
		type: "review_cancelled",
		message: `Review cancelled for ${cancelled.assigneeHandle ?? cancelled.assigneeUserId} (${scopeLabel})`,
		messageKey: "activity.reviewCancelled",
		messageParams: { name: cancelled.assigneeHandle ?? cancelled.assigneeUserId, scope: scopeLabel },
		actor,
		metadata: { assignmentId: cancelled.id, assigneeUserId: cancelled.assigneeUserId, reason: cancelled.cancelReason, scope: scopeLabel },
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflictResp = projectCasConflictResponse(c, error);
		if (conflictResp) return conflictResp;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	// MANDATORY notify: the affected reviewer may already have started, so they
	// must ALWAYS get the in-app notice (mandatoryInApp bypasses the in_app pref —
	// a user cannot silence a "your work was cancelled" safety notice). Email stays
	// pref-gated + best-effort. We report `notified` from the GUARANTEED in-app
	// delivery so the UI never claims "notified" when nothing was delivered.
	const notifyResult = await notify({
		userId: cancelled.assigneeUserId,
		type: "review_cancelled",
		title: `${actor} cancelled your review`,
		body: `${scopeLabel} — ${cancelled.cancelReason}`,
		workspaceId: state.workspaceId,
		linkUrl: `/projects/${idResult}/review`,
		metadata: { projectId: idResult, assignmentId: cancelled.id, reason: cancelled.cancelReason, scope: scopeLabel },
		mandatoryInApp: true,
	}).catch((error) => {
		console.warn(`[project] review cancel notify failed for ${cancelled.assigneeUserId}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	});
	return c.json({
		assignment: cancelled,
		assignments: state.reviewAssignments,
		activityLog: state.activityLog ?? [],
		version,
		// True only when the guaranteed in-app row was actually written. If even the
		// mandatory in-app write failed (store down) or no recipient resolved, the UI
		// is told the truth (notified:false) so it won't claim "and notified".
		notified: Boolean(notifyResult?.inAppDelivered),
	});
});

// ── Revision send-back ──────────────────────────────────────────────────────
// A reviewer/lead returns work to a WORKER as "revision #X" with a mandatory
// reason; the worker is ALWAYS notified (mandatory in-app + best-effort email).
// Reuses the review-assignment manage-access + assignee-resolution patterns.

project.get("/:id/revisions", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state, "read:project");
	if (ownershipError) return ownershipError;

	// Read-only: normalize in-memory for the response only. A GET must never write
	// project state (no version churn / surprise writes on a safe method); any
	// persisted normalization happens lazily on the next real mutation (POST/PATCH).
	const revisions = normalizeRevisionRequests(state);
	return c.json({ revisions });
});

project.post("/:id/revisions", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	// Reason is MANDATORY (schema enforces min(1)) — a send-back can never be silent.
	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = revisionRequestCreateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	// Only owner/lead may send work back for revision.
	const manageError = await checkReviewAssignmentManageAccess(c, state);
	if (manageError) return manageError;

	// The worker the revision is sent BACK to must be a workspace member (or the
	// owner on a personal project). Reuses the review-assignee membership check.
	const worker = await resolveReviewAssignee(c, state, parsed.data.assignedToUserId);
	if ("error" in worker) return worker.error;

	// Reject a narrow scope whose pages are ALL out of range, rather than silently
	// widening it into a whole-chapter revision.
	if (resolveRevisionScope(parsed.data.pageIndexes, state.pages.length).kind === "invalid") {
		return c.json({ error: "All provided pageIndexes are out of range", code: "revision_invalid_scope" }, 400);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const actor = user?.email || user?.userId || "local-user";
	const revisions = normalizeRevisionRequests(state);
	const revision = createRevisionRequest({
		assignedToUserId: parsed.data.assignedToUserId,
		assignedToHandle: worker.handle,
		reason: parsed.data.reason,
		requestedBy: actor,
		targetLang: parsed.data.targetLang,
		pageIndexes: parsed.data.pageIndexes,
		sourceReviewDecisionId: parsed.data.sourceReviewDecisionId,
		priority: parsed.data.priority,
		dueAt: parsed.data.dueAt,
	}, nextRevisionNumber(revisions), state.pages.length);
	state.revisionRequests = [revision, ...revisions].slice(0, MAX_REVISION_REQUESTS);

	const scopeLabel = describeRevisionScope(revision);
	const who = revision.assignedToHandle ?? revision.assignedToUserId;
	appendActivity(state, createActivity({
		type: "revision_requested",
		message: `Sent ${scopeLabel} back to ${who} as Revision #${revision.revisionNumber}`,
		messageKey: "activity.revisionRequested",
		messageParams: { name: who, scope: scopeLabel, number: revision.revisionNumber },
		actor,
		metadata: { revisionId: revision.id, assignedToUserId: revision.assignedToUserId, revisionNumber: revision.revisionNumber, reason: revision.reason, scope: scopeLabel },
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflictResp = projectCasConflictResponse(c, error);
		if (conflictResp) return conflictResp;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	// MANDATORY notify: the worker must ALWAYS get the in-app notice that their
	// work was sent back (mandatoryInApp bypasses the in_app pref — a "fix your
	// work" notice cannot be silenced). Email stays pref-gated + best-effort. We
	// report `notified` from the GUARANTEED in-app delivery so the UI never claims
	// "notified" when nothing was delivered.
	const notifyResult = await notify({
		userId: revision.assignedToUserId,
		type: "revision_requested",
		title: `${actor} sent work back — Revision #${revision.revisionNumber}`,
		body: `${scopeLabel} — ${revision.reason}`,
		workspaceId: state.workspaceId,
		linkUrl: `/projects/${idResult}`,
		metadata: { projectId: idResult, revisionId: revision.id, revisionNumber: revision.revisionNumber, reason: revision.reason, scope: scopeLabel },
		mandatoryInApp: true,
	}).catch((error) => {
		console.warn(`[project] revision notify failed for ${revision.assignedToUserId}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	});
	return c.json({
		revision,
		revisions: state.revisionRequests,
		activityLog: state.activityLog ?? [],
		version,
		notified: Boolean(notifyResult?.inAppDelivered),
	});
});

project.patch("/:id/revisions/:revisionId", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = revisionRequestUpdateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const manageError = await checkReviewAssignmentManageAccess(c, state);
	if (manageError) return manageError;

	const revisionId = c.req.param("revisionId");
	const revisions = normalizeRevisionRequests(state);
	const existing = revisions.find((entry) => entry.id === revisionId);
	if (!existing) return c.json({ error: "Revision request not found" }, 404);
	if (existing.status === "accepted" || existing.status === "cancelled") {
		return c.json({ error: "Cannot update a resolved revision request", code: "revision_resolved" }, 409);
	}
	if (parsed.data.pageIndexes !== undefined
		&& resolveRevisionScope(parsed.data.pageIndexes, state.pages.length).kind === "invalid") {
		return c.json({ error: "All provided pageIndexes are out of range", code: "revision_invalid_scope" }, 400);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const actor = user?.email || user?.userId || "local-user";
	const updated = updateRevisionRequest(existing, { ...parsed.data, resolvedBy: actor }, state.pages.length);
	state.revisionRequests = revisions.map((entry) => entry.id === revisionId ? updated : entry);

	// Log a resolution when this update closed the revision (accepted/cancelled).
	// `existing` was guaranteed OPEN by the 409 guard above, so reaching a resolved
	// status here always means this update is the one that closed it.
	const becameResolved = updated.status === "accepted" || updated.status === "cancelled";
	if (becameResolved) {
		const scopeLabel = describeRevisionScope(updated);
		appendActivity(state, createActivity({
			type: "revision_resolved",
			message: `Revision #${updated.revisionNumber} ${updated.status} (${scopeLabel})`,
			messageKey: "activity.revisionResolved",
			messageParams: { number: updated.revisionNumber, status: updated.status, scope: scopeLabel },
			actor,
			metadata: { revisionId: updated.id, revisionNumber: updated.revisionNumber, status: updated.status, scope: scopeLabel },
		}));
	}
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflictResp = projectCasConflictResponse(c, error);
		if (conflictResp) return conflictResp;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	return c.json({ revision: updated, revisions: state.revisionRequests, activityLog: state.activityLog ?? [], version });
});

project.get("/:id/workspace-feed", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	// Read-only GET: run the lazy normalizations in memory, but only persist them
	// when they actually changed state. An unconditional write here was the
	// GET-with-write-side-effect anti-pattern that let concurrent reopens race.
	// Run ALL six lazy migrations (each mutates state in place) and persist if ANY changed —
	// computed per-migrator (cheap, scoped to the fields each touches) instead of hashing the
	// whole multi-MB project twice on every workspace-feed poll. NB: do NOT short-circuit — all
	// six must run so every migration applies; OR the results AFTER.
	const feedChanged = [
		ensureProjectWorkflowChanged(state),
		normalizeProjectCommentsChanged(state),
		normalizeAiReviewMarkersChanged(state),
		normalizeProjectReviewDecisionsChanged(state),
		normalizeWorkspaceMessagesChanged(state),
		normalizeVersionReviewRequestsChanged(state),
	].some(Boolean);
	if (feedChanged) {
		await writeProjectState(idResult, state, { catalogSync: "best-effort" });
	}
	return c.json({
		items: buildWorkspaceFeed(state),
		messages: state.workspaceMessages ?? [],
		activityLog: state.activityLog ?? [],
	});
});

project.post("/:id/workspace-messages", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	// Storage-atomic CAS baseline: the hash of the state AS LOADED here. The commit
	// below re-reads + re-verifies this INSIDE the per-project lock, so a concurrent
	// mutation that committed between this load and our write is rejected (409)
	// rather than silently clobbered.
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = workspaceMessageCreateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	ensureProjectWorkflow(state);
	normalizeProjectComments(state);
	normalizeAiReviewMarkers(state);
	normalizeProjectReviewDecisions(state);
	const pageContext = resolveWorkspaceMessageScopeContext(state, parsed.data);
	if ("error" in pageContext) return c.json({ error: pageContext.error }, pageContext.status as any);
	const ownershipError = await checkProjectOwnership(c, state, "update:project", {
		pageIndex: pageContext.pageIndex,
		taskType: pageContext.taskType,
	});
	if (ownershipError) return ownershipError;
	const messages = normalizeWorkspaceMessages(state);
	const user = getAuthUser(c) as JWTPayload | undefined;
	const message = createWorkspaceMessage({
		...parsed.data,
		pageIndex: pageContext.pageIndex,
		author: user?.email || user?.userId || "local-user",
	});
	state.workspaceMessages = [message, ...messages].slice(0, MAX_WORKSPACE_MESSAGES);
	appendActivity(state, createActivity({
		type: "workspace_message_added",
		message: message.pageIndex === undefined
			? "Workspace handoff note added"
			: `Workspace handoff note added on page ${message.pageIndex + 1}`,
		messageKey: message.pageIndex === undefined ? "activity.handoffNoteAdded" : "activity.handoffNoteAddedOnPage",
		...(message.pageIndex === undefined ? {} : { messageParams: { page: message.pageIndex + 1 } }),
		pageIndex: message.pageIndex,
		taskId: message.linkedTaskId,
		metadata: {
			messageId: message.id,
			linkedCommentId: message.linkedCommentId,
			mentions: message.mentions,
			region: message.region,
		},
	}));
	// perf(save) #437: hash the post-mutation state ONCE and thread it through both the
	// in-mutex version snapshot AND the response header — collapses the redundant re-hashes
	// of the SAME in-memory state into 1 (does NOT touch #428's in-mutex CAS re-read hash
	// of the freshly re-read PERSISTED object, a separate correctness check).
	const savedStateHash = hashProjectState(state);
	let version: ProjectVersionMetadata;
	try {
		// P1-4: commit + version snapshot run as ONE serialized unit inside the per-project
		// mutex (see commitProjectStateWithVersion) so no concurrent commit can interleave
		// between this write and its snapshot. The precomputed hash is threaded into the
		// in-mutex snapshot so versioning reuses it instead of re-hashing the chapter.
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state, "save", savedStateHash);
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, state, savedStateHash);
	return c.json({
		message,
		messages: state.workspaceMessages,
		items: buildWorkspaceFeed(state),
		activityLog: state.activityLog ?? [],
		version,
	});
});

project.get("/:id/ai-markers", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	normalizeAiReviewMarkers(state);
	// Durable self-heal: a marker left `processing` because the client poll loop
	// closed before the (minutes-long) gen finished is reconciled here against the
	// job's DURABLE terminal result, so reopening the project surfaces the finished
	// AI result (ready) or a sanitized failure — never a stuck spinner / orphaned
	// image — without needing a live poll. Idempotent and races harmlessly with a
	// live poll loop. Persist a version only when something actually changed.
	const reconcile = await reconcileProcessingAiReviewMarkers(state, (jobId) => jobQueue.getMarkerReconcileView(jobId));
	if (reconcile.changed) {
		// Persist the recovered marker projection durably, but DO NOT snapshot a
		// project version: this is a passive read-time self-heal of a server-owned,
		// fingerprint-excluded collection (aiReviewMarkers), not a user edit. Cutting
		// a version here would let two concurrent reopens race two near-identical
		// version snapshots past hash-dedupe (`updatedAt` differs) → version churn,
		// and is the GET-with-write-side-effect anti-pattern that caused the #279
		// false-save-conflict. Only write when something actually changed.
		await writeProjectState(idResult, state, { catalogSync: "best-effort" });
	}
	return c.json({ markers: state.aiReviewMarkers ?? [] });
});

// Explicit durable reconciliation of stale `processing` markers against their
// jobs' terminal result. The GET route already reconciles on read, but the AI
// panel can call this to proactively recover orphaned results (e.g. on mount or
// a manual refresh) and learn whether anything self-healed.
project.post("/:id/ai-markers/reconcile", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	normalizeAiReviewMarkers(state);
	const reconcile = await reconcileProcessingAiReviewMarkers(state, (jobId) => jobQueue.getMarkerReconcileView(jobId));
	if (reconcile.changed) {
		// Same as the GET path: persist durably without a version snapshot. The
		// reconcile is a system self-heal, not a user edit; versioning it would let
		// concurrent reopens (e.g. two AiReviewMarkersPanel onMount calls) race
		// duplicate snapshots. The marker projection is durably written either way.
		await writeProjectState(idResult, state, { catalogSync: "best-effort" });
	}
	return c.json({
		markers: state.aiReviewMarkers ?? [],
		reconciled: reconcile.reconciledMarkerIds,
		changed: reconcile.changed,
	});
});

project.post("/:id/ai-markers", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// C5/P1-3: this server-owned mutation must honor the same baseline/CAS contract as
	// the other dedicated endpoints — otherwise a concurrency-blind write is last-write-
	// wins, AND the prod require-baseline-header gate would 428 the browser. The client
	// now sends X-Project-Base-State-Hash on this call.
	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = aiReviewMarkerCreateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const page = state.pages[parsed.data.pageIndex];
	if (!page) return c.json({ error: "Page not found" }, 404);
	if (![page.imageId, page.edits?.imageId].filter(Boolean).includes(parsed.data.imageId)) {
		return c.json({ error: "Marker image does not belong to page" }, 400);
	}

	// jobId forgery guard (FAIL CLOSED): the marker links to the AI job the client
	// just submitted, and later reconciliation resolves that `jobId` and copies the
	// job's `resultImageId` / `costEstimate` / `creditReservation` onto the marker.
	// So the referenced job MUST exist AND belong to THIS project before we persist
	// the client-supplied `jobId` — otherwise a client could point a marker at
	// another project's/user's job and have the reconciler pull its result/cost onto
	// a marker they can read (cross-tenant leak). The legitimate flow submits the AI
	// job server-side (queued with this project's `projectId`) BEFORE creating the
	// marker, so the job is already resolvable here. We reject on: a queue-lookup
	// failure (don't fail open on a transient error), an unknown/not-yet-visible job,
	// or a job whose `projectId` differs from this project.
	let referencedJob: Awaited<ReturnType<typeof jobQueue.get>> | undefined;
	try {
		referencedJob = await jobQueue.get(parsed.data.jobId);
	} catch {
		return c.json({ error: "Marker job could not be verified" }, 503);
	}
	if (!referencedJob || referencedJob.projectId !== idResult) {
		return c.json({ error: "Marker job does not belong to project" }, 400);
	}

	ensureProjectWorkflow(state);
	normalizeProjectComments(state);
	const linkedAnchorScope = resolveAiMarkerLinkedAnchorScope(state, parsed.data.pageIndex, parsed.data);
	if ("error" in linkedAnchorScope) return c.json({ error: linkedAnchorScope.error }, linkedAnchorScope.status as any);
	const authorizationTaskTypes = linkedAnchorScope.taskTypes.length > 0 ? linkedAnchorScope.taskTypes : ["review" as const];
	for (const taskType of authorizationTaskTypes) {
		const ownershipError = await checkProjectOwnership(c, state, "generate:ai", {
			language: state.targetLang,
			pageIndex: parsed.data.pageIndex,
			taskType,
		});
		if (ownershipError) return ownershipError;
	}

	const markers = normalizeAiReviewMarkers(state);
	const marker = createAiReviewMarker({
		...parsed.data,
		// Status reflects the AI job lifecycle and defaults to `processing`. The
		// schema already blocks the gated approval states (`accepted`/`applied`). The
		// client CANNOT forge `resultImageId`, `costEstimate`, `creditReservation`,
		// `sourceMarkerId`, or `rerunIdempotencyKey` (stripped from the input schema) —
		// those are derived server-side from the job via the reconciler/rerun/retry flows.
		status: parsed.data.status ?? "processing",
		// Per-language bucket (Stream C): a directly-created marker has no
		// per-request lang, so it lives in the project's default-language track.
		targetLang: state.targetLang,
	});
	state.aiReviewMarkers = [marker, ...markers].slice(0, MAX_AI_REVIEW_MARKERS);
	const attentionTask = syncAiReviewMarkerAttentionTask(state, marker);
	if (attentionTask?.statusChanged || attentionTask?.priorityChanged) {
		appendActivity(state, createActivity({
			type: "task_updated",
			message: `${attentionTask.task.title}: review requested by AI marker`,
			pageIndex: attentionTask.task.pageIndex,
			taskId: attentionTask.task.id,
			metadata: {
				taskType: attentionTask.task.type,
				previousStatus: attentionTask.previousStatus,
				status: attentionTask.task.status,
				previousPriority: attentionTask.previousPriority,
				priority: attentionTask.task.priority,
				markerId: marker.id,
				jobId: marker.jobId,
			},
		}));
	}
	appendActivity(state, createActivity({
		type: "ai_marker_created",
		message: `AI review marker created on page ${marker.pageIndex + 1}`,
		messageKey: "activity.aiMarkerCreated",
		messageParams: { page: marker.pageIndex + 1 },
		pageIndex: marker.pageIndex,
		metadata: {
			markerId: marker.id,
			jobId: marker.jobId,
			status: marker.status,
			tier: marker.tier,
		},
	}));
	let version: ProjectVersionMetadata;
	try {
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state);
	} catch (error) {
		const casConflict = projectCasConflictResponse(c, error);
		if (casConflict) return casConflict;
		throw error;
	}
	setProjectStateHashHeader(c, state);
	return c.json({
		marker,
		markers: state.aiReviewMarkers,
		tasks: state.tasks ?? [],
		activityLog: state.activityLog ?? [],
		version,
	});
});

project.post("/:id/ai-markers/:markerId/rerun", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// P1 (round-3): CAS baseline captured as-loaded so the marker commit goes through
	// the standard CAS + in-mutex versioning path (commitAiMarkerRerunStateOrRollbackJob).
	const projectCasBaseHash = hashProjectState(state);

	const rawBody = await c.req.text();
	let body: unknown = {};
	if (rawBody.trim()) {
		try {
			body = JSON.parse(rawBody);
		} catch {
			return c.json({ error: "Malformed JSON" }, 400);
		}
	}
	const parsed = aiReviewMarkerRerunSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	// Normalize the requested language the SAME way the submit/bucket path does
	// (trim + lowercase, falling back to the project default when omitted) so the
	// value used for the per-language credit reservation, the marker bucket, and the
	// idempotency fallback key all agree. MONEY: this normalized lang MUST be a
	// segment of the server-generated fallback key below — rerunning the same source
	// marker under "en" then "ja" has to produce DISTINCT keys (⇒ distinct jobs +
	// distinct credit reservations), while replaying the same source marker + same
	// lang stays idempotent (one job, no double charge).
	const requestedLanguage = parsed.data.lang?.trim().toLowerCase() || resolveProjectDefaultLang(state);
	const languageScopeError = await checkProjectOwnership(c, state, "generate:ai", { language: requestedLanguage });
	if (languageScopeError) return languageScopeError;

	const markers = normalizeAiReviewMarkers(state);
	const sourceMarker = markers.find((item) => item.id === c.req.param("markerId"));
	if (!sourceMarker) return c.json({ error: "AI review marker not found" }, 404);
	if (sourceMarker.status !== "failed" && sourceMarker.status !== "retry_requested") {
		return c.json({ error: "Only failed or retry-requested AI markers can be rerun" }, 409);
	}

	const page = state.pages[sourceMarker.pageIndex];
	if (!page) return c.json({ error: "Marker page not found" }, 404);
	if (![page.imageId, page.edits?.imageId].filter(Boolean).includes(sourceMarker.imageId)) {
		return c.json({ error: "Marker image does not belong to page" }, 400);
	}

	const idempotencyKey = c.req.header("Idempotency-Key")
		|| `ai-marker-rerun:${idResult}:${sourceMarker.id}:${sourceMarker.jobId}:${requestedLanguage}:${sourceMarker.updatedAt}`;
	const existingJob = await jobQueue.getByIdempotencyKey(idempotencyKey);
	const existingMarker = existingJob
		? markers.find((item) => item.jobId === existingJob.jobId && item.sourceMarkerId === sourceMarker.id)
		: undefined;
	if (existingJob && existingMarker) {
		return c.json({
			jobId: existingJob.jobId,
			tier: existingJob.tier ?? sourceMarker.tier,
			costEstimate: existingJob.costEstimate,
			creditReservation: existingJob.creditReservation,
			reused: true,
			marker: existingMarker,
			markers,
			tasks: state.tasks ?? [],
			activityLog: state.activityLog ?? [],
		});
	}

	const rerunActorUserId = resolveLedgerActorUserId(c);
	try {
		const result = await runWithLedgerActor(rerunActorUserId, () => submitAiJob({
			projectId: idResult,
			imageId: sourceMarker.imageId,
			crop: sourceMarker.region,
			lang: requestedLanguage,
			customPrompt: sourceMarker.customPrompt,
			textLayers: sourceMarker.textLayers,
			translateSfx: sourceMarker.translateSfx,
			tier: sourceMarker.tier,
		}, { idempotencyKey, actorUserId: rerunActorUserId }));

		const repairedMarker = markers.find((item) => item.jobId === result.jobId && item.sourceMarkerId === sourceMarker.id);
		if (repairedMarker) {
			return c.json({
				...omitInternalPrompt(result),
				marker: repairedMarker,
				markers,
				tasks: state.tasks ?? [],
				activityLog: state.activityLog ?? [],
			});
		}

		const marker = createAiReviewMarker({
			jobId: result.jobId,
			pageIndex: sourceMarker.pageIndex,
			imageId: sourceMarker.imageId,
			region: sourceMarker.region,
			status: "processing",
			tier: result.tier ?? sourceMarker.tier,
			customPrompt: sourceMarker.customPrompt,
			textLayers: sourceMarker.textLayers,
			translateSfx: sourceMarker.translateSfx,
			costEstimate: result.costEstimate as any,
			creditReservation: result.creditReservation as any,
			linkedCommentIds: sourceMarker.linkedCommentIds,
			linkedTaskIds: sourceMarker.linkedTaskIds,
			sourceMarkerId: sourceMarker.id,
			rerunIdempotencyKey: idempotencyKey,
			// Per-language bucket (Stream C): tag the marker with the SAME language the
			// rerun job ran under (`requestedLanguage` = per-request `lang`, else the
			// project default) so the marker and its job stay in the same lang bucket.
			targetLang: requestedLanguage,
		});
		state.aiReviewMarkers = [marker, ...markers].slice(0, MAX_AI_REVIEW_MARKERS);
		appendActivity(state, createActivity({
			type: "ai_marker_created",
			message: `AI marker rerun queued on page ${marker.pageIndex + 1}`,
			pageIndex: marker.pageIndex,
			metadata: {
				markerId: marker.id,
				sourceMarkerId: sourceMarker.id,
				jobId: marker.jobId,
				sourceJobId: sourceMarker.jobId,
				status: marker.status,
				tier: marker.tier,
				rerunIdempotencyKey: idempotencyKey,
			},
		}));
		let version: ProjectVersionMetadata;
		try {
			version = await commitAiMarkerRerunStateOrRollbackJob(idResult, projectCasBaseHash, state, result.jobId);
		} catch (commitError) {
			const casConflict = projectCasConflictResponse(c, commitError);
			if (casConflict) return casConflict;
			throw commitError;
		}
		return c.json({
			...omitInternalPrompt(result),
			marker,
			markers: state.aiReviewMarkers,
			tasks: state.tasks ?? [],
			activityLog: state.activityLog ?? [],
			version,
		});
	} catch (error) {
		if (error instanceof AiJobSubmissionError) {
			if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
			return c.json(error.body, error.status as any);
		}
		throw error;
	}
});

// Retry-with-prompt: re-submit the AI job for a marker with a user-edited prompt.
// Unlike /rerun (which replays the source marker's existing custom prompt), this
// lets the reviewer tweak the prompt after seeing the before/after result. The
// composed prompt still passes through submitAiJob's moderation gate, and the
// source marker is moved to the retry_requested ("retrying") state.
const AI_MARKER_RETRY_ALLOWED_STATUSES = new Set<AiReviewMarkerStatus>([
	"needs_review",
	"failed",
	"retry_requested",
	"accepted",
	"rejected",
]);

project.post("/:id/ai-markers/:markerId/retry", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// P1 (round-3): CAS baseline captured as-loaded so the marker commit goes through
	// the standard CAS + in-mutex versioning path (commitAiMarkerRerunStateOrRollbackJob).
	const projectCasBaseHash = hashProjectState(state);

	const rawBody = await c.req.text();
	let body: unknown = {};
	if (rawBody.trim()) {
		try {
			body = JSON.parse(rawBody);
		} catch {
			return c.json({ error: "Malformed JSON" }, 400);
		}
	}
	const parsed = aiReviewMarkerRetrySchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	// Normalize the requested language the SAME way the submit/bucket path does
	// (trim + lowercase, falling back to the project default when omitted) so the
	// per-language credit reservation, the marker bucket, and the idempotency fallback
	// key all agree. MONEY: this normalized lang MUST be a segment of the
	// server-generated fallback key below so retrying the same source marker under
	// different langs produces DISTINCT keys (⇒ distinct jobs + distinct reservations).
	const requestedLanguage = parsed.data.lang?.trim().toLowerCase() || resolveProjectDefaultLang(state);
	const languageScopeError = await checkProjectOwnership(c, state, "generate:ai", { language: requestedLanguage });
	if (languageScopeError) return languageScopeError;

	const markers = normalizeAiReviewMarkers(state);
	const sourceMarker = markers.find((item) => item.id === c.req.param("markerId"));
	if (!sourceMarker) return c.json({ error: "AI review marker not found" }, 404);
	if (!AI_MARKER_RETRY_ALLOWED_STATUSES.has(sourceMarker.status)) {
		return c.json({ error: "This AI marker cannot be retried in its current state" }, 409);
	}

	const page = state.pages[sourceMarker.pageIndex];
	if (!page) return c.json({ error: "Marker page not found" }, 404);
	if (![page.imageId, page.edits?.imageId].filter(Boolean).includes(sourceMarker.imageId)) {
		return c.json({ error: "Marker image does not belong to page" }, 400);
	}

	// The edited prompt becomes the new marker's customPrompt; fall back to the
	// source marker's prompt so a no-edit retry still has a stable idempotency key.
	const effectiveCustomPrompt = parsed.data.promptOverride?.trim() || sourceMarker.customPrompt;

	const idempotencyKey = c.req.header("Idempotency-Key")
		|| `ai-marker-retry:${idResult}:${sourceMarker.id}:${sourceMarker.jobId}:${requestedLanguage}:${effectiveCustomPrompt ?? ""}`;
	const existingJob = await jobQueue.getByIdempotencyKey(idempotencyKey);
	const existingMarker = existingJob
		? markers.find((item) => item.jobId === existingJob.jobId && item.sourceMarkerId === sourceMarker.id)
		: undefined;
	if (existingJob && existingMarker) {
		return c.json({
			jobId: existingJob.jobId,
			tier: existingJob.tier ?? sourceMarker.tier,
			costEstimate: existingJob.costEstimate,
			creditReservation: existingJob.creditReservation,
			reused: true,
			marker: existingMarker,
			sourceMarker,
			markers,
			tasks: state.tasks ?? [],
			activityLog: state.activityLog ?? [],
		});
	}

	try {
		const result = await runWithLedgerActor(resolveLedgerActorUserId(c), () => submitAiJob({
			projectId: idResult,
			imageId: sourceMarker.imageId,
			crop: sourceMarker.region,
			lang: requestedLanguage,
			customPrompt: effectiveCustomPrompt,
			textLayers: sourceMarker.textLayers,
			translateSfx: sourceMarker.translateSfx,
			tier: sourceMarker.tier,
		}, { idempotencyKey }));

		const previousSourceStatus = sourceMarker.status;
		updateAiReviewMarker(sourceMarker, { status: "retry_requested" });

		const repairedMarker = markers.find((item) => item.jobId === result.jobId && item.sourceMarkerId === sourceMarker.id);
		const marker = repairedMarker ?? createAiReviewMarker({
			jobId: result.jobId,
			pageIndex: sourceMarker.pageIndex,
			imageId: sourceMarker.imageId,
			region: sourceMarker.region,
			status: "processing",
			tier: result.tier ?? sourceMarker.tier,
			customPrompt: effectiveCustomPrompt,
			textLayers: sourceMarker.textLayers,
			translateSfx: sourceMarker.translateSfx,
			costEstimate: result.costEstimate as any,
			creditReservation: result.creditReservation as any,
			linkedCommentIds: sourceMarker.linkedCommentIds,
			linkedTaskIds: sourceMarker.linkedTaskIds,
			sourceMarkerId: sourceMarker.id,
			rerunIdempotencyKey: idempotencyKey,
			// Per-language bucket (Stream C): tag the marker with the SAME language the
			// retry job ran under (`requestedLanguage` = per-request `lang`, else the
			// project default) so the marker and its job stay in the same lang bucket.
			targetLang: requestedLanguage,
		});
		if (!repairedMarker) {
			state.aiReviewMarkers = [marker, ...markers].slice(0, MAX_AI_REVIEW_MARKERS);
		}
		appendActivity(state, createActivity({
			type: "ai_marker_created",
			message: `AI marker retried with edited prompt on page ${marker.pageIndex + 1}`,
			pageIndex: marker.pageIndex,
			metadata: {
				markerId: marker.id,
				sourceMarkerId: sourceMarker.id,
				jobId: marker.jobId,
				sourceJobId: sourceMarker.jobId,
				previousSourceStatus,
				promptEdited: Boolean(parsed.data.promptOverride?.trim()),
				status: marker.status,
				tier: marker.tier,
				rerunIdempotencyKey: idempotencyKey,
			},
		}));
		let version: ProjectVersionMetadata;
		try {
			version = await commitAiMarkerRerunStateOrRollbackJob(idResult, projectCasBaseHash, state, result.jobId);
		} catch (commitError) {
			const casConflict = projectCasConflictResponse(c, commitError);
			if (casConflict) return casConflict;
			throw commitError;
		}
		return c.json({
			...omitInternalPrompt(result),
			marker,
			sourceMarker,
			markers: state.aiReviewMarkers,
			tasks: state.tasks ?? [],
			activityLog: state.activityLog ?? [],
			version,
		});
	} catch (error) {
		if (error instanceof AiJobSubmissionError) {
			if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
			return c.json(error.body, error.status as any);
		}
		throw error;
	}
});

project.patch("/:id/ai-markers/:markerId", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// C5/P1-3: honor the baseline/CAS contract (see POST /ai-markers).
	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = aiReviewMarkerUpdateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const markers = normalizeAiReviewMarkers(state);
	const marker = markers.find((item) => item.id === c.req.param("markerId"));
	if (!marker) return c.json({ error: "AI review marker not found" }, 404);

	// Authorize against the marker's actual page/language/review scope (resolved
	// above) so a legitimately page/task-scoped reviewer is not denied by an empty
	// project-wide check before the marker is even loaded.
	const ownershipError = await checkAiReviewMarkerAccess(c, state, marker);
	if (ownershipError) return ownershipError;

	const requestedStatus = parsed.data.status as AiReviewMarkerStatus | undefined;
	if (requestedStatus === "accepted" || requestedStatus === "applied") {
		const referenceError = getAiReviewMarkerReferenceError(state, marker);
		if (referenceError) {
			return c.json({
				error: "AI marker source is stale",
				message: `${referenceError}. Rerun or recreate the marker before approval or apply.`,
			}, 409);
		}
	}

	const previousStatus = marker.status;
	updateAiReviewMarker(marker, {
		...parsed.data,
		status: requestedStatus,
		assignee: parsed.data.assignee,
		// Server-owned billing/job/result fields (`costEstimate`, `creditReservation`,
		// `resultImageId`, `sourceMarkerId`, `rerunIdempotencyKey`) are NOT accepted from
		// the client here — stripped from the update schema and set only server-side.
	});
	const attentionTask = syncAiReviewMarkerAttentionTask(state, marker);
	if (attentionTask?.statusChanged || attentionTask?.priorityChanged) {
		appendActivity(state, createActivity({
			type: "task_updated",
			message: `${attentionTask.task.title}: review requested by AI marker`,
			pageIndex: attentionTask.task.pageIndex,
			taskId: attentionTask.task.id,
			metadata: {
				taskType: attentionTask.task.type,
				previousStatus,
				previousTaskStatus: attentionTask.previousStatus,
				status: attentionTask.task.status,
				previousPriority: attentionTask.previousPriority,
				priority: attentionTask.task.priority,
				markerId: marker.id,
				jobId: marker.jobId,
			},
		}));
	}
	appendActivity(state, createActivity({
		type: "ai_marker_updated",
		message: previousStatus === marker.status
			? `AI review marker updated on page ${marker.pageIndex + 1}`
			: `AI review marker ${previousStatus} -> ${marker.status} on page ${marker.pageIndex + 1}`,
		pageIndex: marker.pageIndex,
		metadata: {
			markerId: marker.id,
			jobId: marker.jobId,
			previousStatus,
			status: marker.status,
			tier: marker.tier,
		},
	}));
	let version: ProjectVersionMetadata;
	try {
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state);
	} catch (error) {
		const casConflict = projectCasConflictResponse(c, error);
		if (casConflict) return casConflict;
		throw error;
	}
	setProjectStateHashHeader(c, state);
	return c.json({
		marker,
		markers,
		tasks: state.tasks ?? [],
		activityLog: state.activityLog ?? [],
		version,
	});
});

project.post("/:id/ai-markers/:markerId/comments", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// C5/P1-3: honor the baseline/CAS contract (see POST /ai-markers).
	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const requestBody = await readJsonBody(c);
	if (!requestBody.ok) return requestBody.response;
	const parsed = aiReviewMarkerCommentSchema.safeParse(requestBody.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const markers = normalizeAiReviewMarkers(state);
	const marker = markers.find((item) => item.id === c.req.param("markerId"));
	if (!marker) return c.json({ error: "AI review marker not found" }, 404);
	if (!state.pages[marker.pageIndex]) return c.json({ error: "Marker page not found" }, 404);

	// Authorize against the marker's actual page/language/review scope (after the
	// marker is resolved) so a page/task-scoped reviewer can comment on an in-scope
	// marker instead of hitting a project-wide denial.
	const ownershipError = await checkAiReviewMarkerAccess(c, state, marker);
	if (ownershipError) return ownershipError;

	const comments = normalizeProjectComments(state);
	const defaultBody = [
		`Review AI marker: ${marker.tier} / ${marker.status}`,
		`Region ${Math.round(marker.region.x)},${Math.round(marker.region.y)} ${Math.round(marker.region.w)}x${Math.round(marker.region.h)}`,
		// The user's OWN instruction is fine to surface; the internal system/template
		// prompt is never stored on the marker (leak-safe), so there is nothing else
		// to expose here.
		marker.customPrompt ? `Prompt: ${marker.customPrompt}` : null,
		marker.error ? `Error: ${marker.error}` : null,
	].filter(Boolean).join("\n");
	const body = (parsed.data.body?.trim() || defaultBody).slice(0, 2000);
	const user = getAuthUser(c) as JWTPayload | undefined;
	const comment = createProjectComment({
		pageIndex: marker.pageIndex,
		body,
		// Attribute to the signing reviewer (email preferred), mirroring the plain
		// comment + review-decision routes, instead of the literal "local-user".
		author: user?.email || user?.userId || "local-user",
	});
	state.comments = [comment, ...comments].slice(0, MAX_PROJECT_COMMENTS);
	linkAiReviewMarkerComment(marker, comment.id);
	appendActivity(state, createActivity({
		type: "comment_added",
		message: `Comment added from AI marker on page ${marker.pageIndex + 1}`,
		messageKey: "activity.commentAddedFromAiMarker",
		messageParams: { page: marker.pageIndex + 1 },
		pageIndex: marker.pageIndex,
		metadata: { commentId: comment.id, markerId: marker.id, jobId: marker.jobId },
	}));
	appendActivity(state, createActivity({
		type: "ai_marker_updated",
		message: `AI review marker linked to comment on page ${marker.pageIndex + 1}`,
		messageKey: "activity.aiMarkerLinkedToComment",
		messageParams: { page: marker.pageIndex + 1 },
		pageIndex: marker.pageIndex,
		metadata: {
			markerId: marker.id,
			jobId: marker.jobId,
			commentId: comment.id,
			status: marker.status,
			tier: marker.tier,
		},
	}));
	let version: ProjectVersionMetadata;
	try {
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state);
	} catch (error) {
		const casConflict = projectCasConflictResponse(c, error);
		if (casConflict) return casConflict;
		throw error;
	}
	setProjectStateHashHeader(c, state);
	// W2.7 Realtime: emit comment_new for the AI-marker-derived comment so the
	// comments pane and reviewers see it without a refresh.
	if (state.workspaceId) seedWorkspaceLookupForTesting(idResult, state.workspaceId);
	await emitCommentNewEvent({
		commentId: comment.id,
		projectId: idResult,
		pageIndex: comment.pageIndex,
		author: comment.author ?? "ai-marker",
		excerpt: comment.body?.slice(0, 200),
	}).catch(() => {/* swallow */});
	return c.json({
		marker,
		comment,
		markers,
		comments: state.comments,
		activityLog: state.activityLog ?? [],
		version,
	});
});

project.post("/:id/ai-markers/:markerId/review-task", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// C5/P1-3: honor the baseline/CAS contract (see POST /ai-markers).
	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = aiReviewMarkerReviewTaskSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const markers = normalizeAiReviewMarkers(state);
	const marker = markers.find((item) => item.id === c.req.param("markerId"));
	if (!marker) return c.json({ error: "AI review marker not found" }, 404);

	// Authorize against the marker's actual page/language/review scope (after the
	// marker is resolved) so a page/task-scoped reviewer can act on an in-scope
	// review task instead of hitting a project-wide denial.
	const ownershipError = await checkAiReviewMarkerAccess(c, state, marker);
	if (ownershipError) return ownershipError;

	ensureProjectWorkflow(state);
	const task = state.tasks?.find((item) => item.pageIndex === marker.pageIndex && item.type === "review");
	if (!task) return c.json({ error: "Review task not found" }, 404);

	const previousStatus = task.status;
	const previousAssignee = task.assignee;
	task.status = "review";
	if (parsed.data.assignee !== undefined) {
		task.assignee = normalizeAssigneeHandle(parsed.data.assignee);
		updateAiReviewMarker(marker, { assignee: task.assignee ?? null });
	} else if (marker.assignee && !task.assignee) {
		task.assignee = marker.assignee;
	}
	task.updatedAt = new Date().toISOString();
	linkAiReviewMarkerTask(marker, task.id);
	const assigneeDetail = task.assignee ? ` / assigned ${formatAssigneeHandle(task.assignee)}` : "";
	appendActivity(state, createActivity({
		type: "task_updated",
		message: `${task.title}: linked from AI marker${assigneeDetail}`,
		pageIndex: task.pageIndex,
		taskId: task.id,
		metadata: {
			taskType: task.type,
			previousStatus,
			status: task.status,
			previousAssignee,
			assignee: task.assignee,
			markerId: marker.id,
			jobId: marker.jobId,
		},
	}));
	appendActivity(state, createActivity({
		type: "ai_marker_updated",
		message: `AI review marker linked to review task on page ${marker.pageIndex + 1}`,
		pageIndex: marker.pageIndex,
		taskId: task.id,
		metadata: {
			markerId: marker.id,
			jobId: marker.jobId,
			status: marker.status,
			tier: marker.tier,
		},
	}));
	let version: ProjectVersionMetadata;
	try {
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state);
	} catch (error) {
		const casConflict = projectCasConflictResponse(c, error);
		if (casConflict) return casConflict;
		throw error;
	}
	setProjectStateHashHeader(c, state);
	return c.json({
		marker,
		task,
		markers,
		tasks: state.tasks ?? [],
		activityLog: state.activityLog ?? [],
		version,
	});
});

project.patch("/:id/pages/:pageIndex/ai-result", async (c) => {
	return c.json({
		error: "AI result page flattening is retired",
		message: "Apply AI results as editable image layers and save the project instead.",
		code: "ai_result_flatten_retired",
	}, 410);
});

project.post("/:id/exports/:runId/artifact", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const runId = validateExportRunId(c);
	if (runId instanceof Response) return runId;

	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	const ownershipError = await checkProjectOwnership(c, state, "update:project");
	if (ownershipError) return ownershipError;

	const runs = state.exportRuns ?? [];
	const run = runs.find((item) => item.id === runId);
	if (!run) return c.json({ error: "Export run not found" }, 404);
	if (run.kind !== "batch-zip" || run.status !== "done") {
		return c.json({ error: "Only completed batch ZIP exports can store artifacts" }, 400);
	}

	const formData = await c.req.formData();
	const artifactFile = formData.get("artifact");
	if (!(artifactFile instanceof File)) {
		return c.json({ error: "Expected artifact file" }, 400);
	}
	if (artifactFile.size <= 0) {
		return c.json({ error: "Export artifact is empty" }, 400);
	}

	const filenameInput = typeof formData.get("filename") === "string"
		? String(formData.get("filename"))
		: artifactFile.name || run.filename;
	const filename = exportAttachmentFilename(filenameInput || run.filename);
	const buffer = Buffer.from(await artifactFile.arrayBuffer());
	const replacementDeltaBytes = Math.max(0, buffer.byteLength - (run.artifact?.sizeBytes ?? 0));
	let storageReservation: StorageQuotaReservation | undefined;
	try {
		if (replacementDeltaBytes > 0) {
			const result = await reserveProjectStorageQuota({
				projectId: idResult,
				bytes: replacementDeltaBytes,
				reason: "export_artifact",
				metadata: {
					runId,
					replacementBytes: buffer.byteLength,
					previousBytes: run.artifact?.sizeBytes ?? 0,
				},
			});
			storageReservation = result.reservation;
		}
	} catch (error) {
		if (error instanceof StorageQuotaExceededError) {
			return c.json({
				error: "Storage quota exceeded",
				code: "storage_quota_exceeded",
				reason: error.reason,
				attemptedBytes: error.attemptedBytes,
				quota: await summarizeProjectStorageQuotaForProjectView(idResult, error.attemptedBytes),
			}, 413);
		}
		throw error;
	}
	// Data-loss atomicity for REPLACEMENT uploads: never write over the
	// currently-referenced object before the new reference is durably committed.
	// The old code always used the fixed id `${runId}.zip`, so re-uploading to a
	// run that already had an artifact overwrote the live object in place. If the
	// subsequent state commit then failed, the run still referenced that id but its
	// bytes were already clobbered — a corrupted/lost artifact.
	//
	// Instead: a first upload (no prior artifact) writes the canonical `${runId}.zip`;
	// a replacement writes a NEW versioned object id and only flips the reference
	// once the state commit succeeds. The old object is GC'd AFTER a successful
	// swap; on commit failure only the new temp object is removed, leaving the
	// previously-referenced artifact intact + still referenced + downloadable.
	const previousExportId = run.artifact?.exportId;
	const exportId = previousExportId
		? `${runId}-${uniqueExportObjectSuffix()}.zip`
		: `${runId}.zip`;
	const isReplacement = Boolean(previousExportId) && previousExportId !== exportId;
	let objectWritten = false;
	// Tracks whether writeProjectState() durably committed the new reference.
	// The compensating delete below must fire ONLY while this is false: once the
	// state references the just-written object on disk, deleting that object would
	// strand the reference and 404 every later download. Post-commit failures
	// (e.g. the best-effort version snapshot) must NEVER trigger the delete.
	let stateCommitted = false;
	let artifact: ExportArtifact | undefined;
	let now = "";
	try {
		const stored = await objectStorage.putProjectExport({ projectId: idResult, exportId, buffer });
		objectWritten = true;
		now = new Date().toISOString();
		artifact = {
			exportId,
			storageDriver: stored.driver,
			storageKey: stored.key,
			filename,
			mimeType: artifactFile.type || "application/zip",
			sizeBytes: buffer.byteLength,
			createdAt: now,
		};

		state.exportRuns = runs.map((item) => item.id === runId
			? {
				...item,
				filename,
				bytes: buffer.byteLength,
				artifact,
				completedAt: item.completedAt || now,
			}
			: item);
		// The "committed" decision MUST match the store that loadProjectState() will
		// actually READ in this deployment, because that read source is what later
		// GET /exports/:runId/artifact resolves the artifact reference from:
		//
		//   * file-fallback ENABLED (dev / file-mode): loadProjectState() prefers the
		//     durable state.json FILE that writeProjectState() commits FIRST. So the
		//     file commit alone is enough to "commit" the artifact; a catalog-sync-only
		//     throw is a SECONDARY-store desync and must NOT propagate (otherwise the
		//     catch below would compensating-delete an object the file still references,
		//     404'ing every later file-fallback download). Use catalogSync:"best-effort".
		//
		//   * file-fallback DISABLED (production / Postgres-authoritative): loadProjectState()
		//     reads the CATALOG row first and never consults the file. So the artifact is
		//     only truly committed once the catalog sync SUCCEEDS; a catalog-sync-only
		//     failure means the read source has NO artifact reference — returning success
		//     here would make a later download 404 against a stale catalog while the object
		//     + file still exist (orphan + success-then-404). Use catalogSync:"required" so
		//     the catalog throw propagates → stateCommitted stays false → the just-written
		//     object is compensating-deleted (no orphan) and the client gets an error + retries.
		const fileFallbackEnabled = serverConfig.projectCatalogFileFallbackEnabled;
		await writeProjectState(idResult, state, {
			catalogSync: fileFallbackEnabled ? "best-effort" : "required",
		});
		// State now durably references the new object in the actual read source: the
		// artifact is COMMITTED. From here on it must never be compensating-deleted.
		stateCommitted = true;
	} catch (error) {
		// Compensating delete of the JUST-WRITTEN object only, and ONLY when the
		// state commit did not durably reference it. Because a replacement writes a
		// fresh versioned id (never the live one), removing it here can never touch
		// the previously-referenced artifact: the old object's bytes and the run's
		// reference to it both remain intact + downloadable. For a first upload the
		// written id was untracked (no prior artifact), so removing it leaves no
		// orphan. We never delete an id that an existing artifact still references
		// on disk, nor an id that this commit just made the live reference.
		if (!stateCommitted && objectWritten && run.artifact?.exportId !== exportId) {
			await deleteOrphanedExportObjectBestEffort(idResult, exportId, runId);
		}
		if (storageReservation) {
			await releaseProjectStorageQuotaReservationBestEffort(idResult, storageReservation.reservationId, {
				reason: "export_artifact",
				phase: "rollback",
				runId,
			});
		}
		throw error;
	}

	// --- POST-COMMIT, best-effort work ---------------------------------------
	// The artifact + reference are durably committed above. Nothing below may
	// delete the committed object or fail the upload as if the artifact were gone.
	// createProjectVersion() is a post-commit snapshot that CAN throw (filesystem
	// write / catalog store); if it does we log and continue with a committed
	// artifact rather than rolling back a reference that already exists on disk.
	let version: ProjectVersionMetadata | undefined;
	try {
		if (exportArtifactVersionSnapshotFailureForTests) {
			const fail = exportArtifactVersionSnapshotFailureForTests;
			fail();
		}
		version = await createProjectVersion(idResult, state, "save");
	} catch (error) {
		console.error(
			`[export-artifact] post-commit version snapshot failed for project=${idResult} run=${runId} exportId=${exportId}; artifact stays committed`,
			error,
		);
	}
	// Reference now durably points at the NEW object. GC the superseded old object
	// best-effort — a failure here only leaves orphaned bytes (cleaned up later /
	// on next delete), never corrupts the live, committed artifact.
	if (isReplacement && previousExportId) {
		await deleteOrphanedExportObjectBestEffort(idResult, previousExportId, runId);
	}
	if (storageReservation) {
		await releaseProjectStorageQuotaReservationBestEffort(idResult, storageReservation.reservationId, {
			reason: "export_artifact",
			phase: "after_commit",
			runId,
		});
	}
	return c.json({
		artifact,
		exportRun: state.exportRuns.find((item) => item.id === runId),
		storageQuota: await summarizeProjectStorageQuotaForProjectView(idResult),
		version,
	});
});

project.get("/:id/exports/:runId/artifact", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const runId = validateExportRunId(c);
	if (runId instanceof Response) return runId;

	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	const ownershipError = await checkProjectOwnership(c, state, "read:project");
	if (ownershipError) return ownershipError;

	const run = (state.exportRuns ?? []).find((item) => item.id === runId);
	if (!run) return c.json({ error: "Export run not found" }, 404);
	if (!run.artifact) return c.json({ error: "Export artifact not found" }, 404);

	// Pre-check the abuse throttle BEFORE touching the (potentially huge) ZIP, so an
	// already-over-threshold project is rejected without forcing a backend/R2 read
	// (mirrors the image-serve path). Exact-byte reservation happens once size known.
	const preThrottleError = await assertEgressNotThrottledOrResponse(c, idResult, "asset_read");
	if (preThrottleError) return preThrottleError;

	// Stream the artifact instead of buffering the ENTIRE chapter ZIP (multi-hundred-
	// MB) into one Buffer per download, and meter the bytes against the SAME egress
	// reservation/recording the image-serve path uses so authorized clients can no
	// longer pull huge exports through backend memory unmetered.
	const exportStream = await objectStorage.getProjectExportStream({
		projectId: idResult,
		exportId: run.artifact.exportId,
	});
	if (!exportStream) return c.json({ error: "Export artifact not found" }, 404);
	const { stream, sizeBytes } = exportStream;

	// Reserve the bytes against the abuse window before serving so concurrent pulls
	// cannot collectively overshoot the threshold; recording below skips the abuse
	// increment to avoid double-counting these reserved bytes.
	const reserveError = await reserveEgressForReadOrResponse(c, idResult, sizeBytes, "asset_read");
	if (reserveError) {
		await stream.cancel().catch(() => {});
		return reserveError;
	}
	const recordError = await recordEgressWithAllowanceOrResponse(c, {
		projectId: idResult,
		imageId: run.artifact.exportId,
		purpose: "export",
		bytes: sizeBytes,
		statusCode: 200,
		skipAbuseReservation: true,
	});
	if (recordError) {
		await releaseEgressReservationBestEffort(idResult, sizeBytes);
		await stream.cancel().catch(() => {});
		return recordError;
	}

	return new Response(stream, {
		headers: {
			"Content-Type": run.artifact.mimeType || "application/zip",
			"Content-Length": String(sizeBytes),
			"Content-Disposition": exportAttachmentHeader(run.artifact.filename || run.filename),
			"Cache-Control": "private, max-age=0",
			"X-Content-Type-Options": "nosniff",
			"X-Asset-Egress-Bytes": String(sizeBytes),
		},
	});
});

project.delete("/:id/exports/:runId/artifact", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const runId = validateExportRunId(c);
	if (runId instanceof Response) return runId;

	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	const ownershipError = await checkProjectOwnership(c, state, "update:project");
	if (ownershipError) return ownershipError;

	const runs = state.exportRuns ?? [];
	const run = runs.find((item) => item.id === runId);
	if (!run) return c.json({ error: "Export run not found" }, 404);
	if (!run.artifact) return c.json({ error: "Export artifact not found" }, 404);

	const exportId = run.artifact.exportId;

	// Atomicity: remove the state reference FIRST (state-first tombstone), then
	// delete the object. The previous order deleted the object before committing
	// state, so a failed state write left the run still pointing at a now-missing
	// ZIP — a ghost reference (broken download + phantom quota). Committing the
	// reference removal first means a failed commit leaves the object intact and
	// still referenced (consistent + retryable); the physical delete only runs
	// once the reference is durably gone.
	state.exportRuns = runs.map((item) => {
		if (item.id !== runId) return item;
		const { artifact: _removedArtifact, ...runWithoutArtifact } = item;
		return {
			...runWithoutArtifact,
			message: item.message || `Exported ${item.filename}`,
		};
	});
	appendActivity(state, createActivity({
		type: "export_artifact_removed",
		message: `Removed stored export artifact ${run.filename}`,
		metadata: {
			exportRunId: runId,
			exportId,
			filename: run.artifact.filename || run.filename,
			sizeBytes: run.artifact.sizeBytes,
		},
	}));
	// The reference-removal commit MUST match the store loadProjectState() actually
	// READS in this deployment — symmetrically to the upload path above — because that
	// read source is what a later GET /exports/:runId/artifact resolves the (now
	// removed) artifact reference from. The artifact is "removed" only once the READ
	// source no longer references it:
	//
	//   * file-fallback ENABLED (dev / file-mode): loadProjectState() prefers the
	//     durable state.json FILE that writeProjectState() commits FIRST, so the file
	//     removal alone IS the durable removal. A catalog-sync-only throw is a
	//     SECONDARY-store desync and must NOT abort the delete (otherwise the client
	//     gets a 500 while the read source already dropped the reference → the
	//     artifact is gone to the user, a retry 404s, and the object is left orphaned
	//     because the physical delete below never ran). Use catalogSync:"best-effort"
	//     and proceed to physically delete the now-unreferenced object.
	//
	//   * file-fallback DISABLED (production / Postgres-authoritative): loadProjectState()
	//     reads the CATALOG row first and never consults the file. The reference is only
	//     truly removed once the catalog sync SUCCEEDS; a catalog-sync-only failure means
	//     the read source still references the artifact, so we must NOT physically delete
	//     the object (that would create the ghost: live reference → missing object). Use
	//     catalogSync:"required" so the throw propagates → the operation fails cleanly with
	//     the reference + object both intact (retryable), before the physical delete runs.
	const fileFallbackEnabled = serverConfig.projectCatalogFileFallbackEnabled;
	await writeProjectState(idResult, state, {
		catalogSync: fileFallbackEnabled ? "best-effort" : "required",
	});
	// POST-COMMIT best-effort snapshot: the artifact reference is already durably
	// removed from the read source, so a version-snapshot failure must NOT fail the
	// request or block the physical delete below (symmetric to the upload path).
	let version;
	try {
		version = await createProjectVersion(idResult, state, "save");
	} catch (error) {
		console.error(
			`[export-artifact] post-commit version snapshot failed for project=${idResult} run=${runId}; reference already removed, continuing`,
			error,
		);
	}

	// Reference is durably removed from the read source; now drop the physical
	// object. This is POST-COMMIT best-effort: a failure here only leaves an
	// unreferenced object (orphaned bytes, GC'd later) — far safer than a dangling
	// pointer — and must NEVER fail the request or resurrect the reference (the read
	// source already dropped it). Swallow a throw and report `deleted: false`.
	let deleted = false;
	try {
		deleted = await objectStorage.deleteProjectExport({
			projectId: idResult,
			exportId,
		});
	} catch (error) {
		console.error(
			`[export-artifact] post-commit physical delete failed for project=${idResult} run=${runId} exportId=${exportId}; reference already removed, object left for later GC`,
			error,
		);
	}
	return c.json({
		ok: true,
		deleted,
		exportRun: state.exportRuns.find((item) => item.id === runId),
		storageQuota: await summarizeProjectStorageQuotaForProjectView(idResult),
		version,
	});
});

// Load project state
project.get("/:id", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	let state: ProjectState | null;
	try {
		state = await loadProjectState(idResult);
	} catch (error) {
		console.error("Project state store unavailable", { projectId: idResult, error });
		return c.json({
			error: "Project state store unavailable",
			code: "project_state_store_unavailable",
		}, 503);
	}
	if (!state) return c.json({ error: "Project not found" }, 404);

	// Check ownership
	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	normalizeAiReviewMarkers(state);
	normalizeProjectReviewDecisions(state);
	normalizeWorkspaceMessages(state);
	normalizeVersionReviewRequests(state);
	// Stamp the current full-state hash so the client can seed its CAS baseline for
	// the next server-owned-collection mutation (see commitProjectStateWithCas).
	setProjectStateHashHeader(c, state);
	return c.json(state);
});

// Create a named ("manual") version snapshot with a user-supplied label.
project.post("/:id/versions", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;

	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	// Authz: creating a version mutates persisted project history, so require
	// the same update permission (and language scope) as a save.
	const ownershipError = await checkProjectOwnership(c, state, "update:project", { language: state.targetLang });
	if (ownershipError) return ownershipError;

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	const parsed = namedVersionCreateSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const author = user?.email || user?.userId || "local-user";
	const version = await createProjectVersion(idResult, state, "manual", {
		label: parsed.data.label,
		author,
	});
	return c.json({ version });
});

project.get("/:id/versions", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const parsed = projectVersionListQuerySchema.safeParse(c.req.query());
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	const includeFileVersions = !projectCatalogStore || serverConfig.projectCatalogFileFallbackEnabled;
	const hasPaginationQuery = parsed.data.limit !== undefined || parsed.data.cursor !== undefined;
	if (!hasPaginationQuery) {
		const fileVersions = includeFileVersions ? listProjectVersions(idResult) : [];
		if (projectCatalogStore) {
			try {
				const catalogPage = await projectCatalogStore.listProjectVersions({
					projectId: idResult,
					limit: MAX_PROJECT_VERSIONS,
				});
				return c.json({ versions: mergeProjectVersions(catalogPage.versions, fileVersions) });
			} catch (error) {
				if (serverConfig.projectCatalogFileFallbackEnabled && fileVersions.length > 0) {
					console.warn("Project catalog version list failed; falling back to file versions", { projectId: idResult, error });
					return c.json({ versions: fileVersions });
				}
				throw new ProjectStateStoreUnavailableError(idResult, error);
			}
		}
		return c.json({ versions: fileVersions });
	}

	try {
		const fileVersions = includeFileVersions ? listProjectVersions(idResult) : [];
		if (projectCatalogStore) {
			let catalogPage: ProjectVersionPage;
			try {
				catalogPage = await projectCatalogStore.listProjectVersions({
					projectId: idResult,
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
				});
			} catch (error) {
				if (error instanceof InvalidProjectVersionCursorError) {
					return c.json({ error: "Invalid project version cursor" }, 400);
				}
				if (serverConfig.projectCatalogFileFallbackEnabled && fileVersions.length > 0) {
					console.warn("Project catalog version list failed; falling back to file versions", { projectId: idResult, error });
					const filePage = paginateProjectVersions(fileVersions, {
						limit: parsed.data.limit,
						cursor: parsed.data.cursor,
					});
					return c.json({ versions: filePage.versions, nextCursor: filePage.nextCursor });
				}
				throw new ProjectStateStoreUnavailableError(idResult, error);
			}
			if (catalogPage.versions.length > 0 || catalogPage.nextCursor || parsed.data.cursor) {
				const mergedPage = paginateProjectVersions(mergeProjectVersions(catalogPage.versions, fileVersions), {
					limit: parsed.data.limit,
					cursor: parsed.data.cursor,
				});
				return c.json({ versions: mergedPage.versions, nextCursor: mergedPage.nextCursor });
			}
		}

		const filePage = paginateProjectVersions(fileVersions, {
			limit: parsed.data.limit,
			cursor: parsed.data.cursor,
		});
		return c.json({ versions: filePage.versions, nextCursor: filePage.nextCursor });
	} catch (error) {
		if (error instanceof InvalidProjectVersionCursorError) {
			return c.json({ error: "Invalid project version cursor" }, 400);
		}
		throw error;
	}
});

// W3.9: visual diff between two arbitrary snapshots of the same project.
// `target` is required; `base` is optional and defaults to the live project
// state (so "current vs older version" works with a single query param).
// NOTE: registered BEFORE the `/:versionId` route so "compare" is not captured
// as a version id by Hono's param matcher.
project.get("/:id/versions/compare", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	const parsed = versionCompareQuerySchema.safeParse(c.req.query());
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const targetRecord = await readProjectVersionRecordAny(idResult, parsed.data.target);
	if (!targetRecord) return c.json({ error: "Target version not found" }, 404);

	let baseState: ProjectState = state;
	let baseVersion: ProjectVersionMetadata | null = null;
	if (parsed.data.base) {
		const baseRecord = await readProjectVersionRecordAny(idResult, parsed.data.base);
		if (!baseRecord) return c.json({ error: "Base version not found" }, 404);
		baseState = baseRecord.state;
		baseVersion = baseRecord.metadata;
	}

	return c.json({
		baseVersion,
		targetVersion: targetRecord.metadata,
		diff: computeVersionDiff(baseState, targetRecord.state),
	});
});

project.get("/:id/versions/:versionId", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	const versionId = c.req.param("versionId");
	const version = await readProjectVersionRecordAny(idResult, versionId);
	if (!version) return c.json({ error: "Version not found" }, 404);

	return c.json({
		version: version.metadata,
		diff: compareVersionState(state, version.state),
		reviews: normalizeVersionReviewRequests(state).filter((request) => request.versionId === versionId),
	});
});

project.post("/:id/versions/:versionId/reviews", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// C5/P1-3: honor the baseline/CAS contract (see POST /ai-markers).
	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	const versionId = c.req.param("versionId");
	if (!await readProjectVersionRecordAny(idResult, versionId)) {
		return c.json({ error: "Version not found" }, 404);
	}

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = versionReviewCreateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const actor = user?.email || user?.userId || "local-user";
	const reviews = normalizeVersionReviewRequests(state);
	let review = reviews.find((request) => request.versionId === versionId && request.status === "open");
	// Snapshot the handles already on the existing open request so re-opening it with
	// the same @mentions does NOT re-ping them — only newly-added handles notify.
	const previousReviewMentions = new Set(review?.mentions ?? []);
	if (review) {
		review = {
			...review,
			body: parsed.data.body ?? review.body,
			requester: actor,
			updatedAt: new Date().toISOString(),
		};
		review.mentions = extractProjectCommentMentions(review.body ?? "");
		state.versionReviewRequests = reviews.map((request) => request.id === review!.id ? review! : request);
	} else {
		review = createVersionReviewRequest({
			versionId,
			body: parsed.data.body,
			requester: actor,
		});
		state.versionReviewRequests = [review, ...reviews].slice(0, MAX_VERSION_REVIEW_REQUESTS);
	}

	appendActivity(state, createActivity({
		type: "version_review_requested",
		message: `Version review requested ${versionId.slice(0, 18)}`,
		metadata: {
			versionId,
			reviewId: review.id,
			mentions: review.mentions,
		},
	}));
	let version: ProjectVersionMetadata;
	try {
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state);
	} catch (error) {
		const casConflict = projectCasConflictResponse(c, error);
		if (casConflict) return casConflict;
		throw error;
	}
	setProjectStateHashHeader(c, state);
	// P1: notify @mentions in the review-request body (parity with comments). Only
	// newly-added handles on a re-open are pinged. Tenant-scoped, author-skipped.
	const newReviewMentions = (review.mentions ?? []).filter((handle) => !previousReviewMentions.has(handle));
	await notifyReviewMentions({
		workspaceId: state.workspaceId,
		projectId: idResult,
		mentions: newReviewMentions,
		actor,
		authorUserId: user?.userId,
		subjectLabel: "review request",
		linkUrl: `/projects/${idResult}/review?version=${versionId}`,
		body: review.body,
		metadata: { projectId: idResult, versionId, reviewId: review.id },
	}).catch(() => {/* swallow */});
	return c.json({
		review,
		reviews: state.versionReviewRequests?.filter((request) => request.versionId === versionId) ?? [],
		activityLog: state.activityLog ?? [],
		items: buildWorkspaceFeed(state),
		version,
	});
});

project.patch("/:id/versions/:versionId/reviews/:reviewId", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// C5/P1-3: honor the baseline/CAS contract (see POST /ai-markers).
	const conflict = checkProjectBaselineConflict(c, state);
	if (conflict) return conflict;
	const projectCasBaseHash = hashProjectState(state);

	const ownershipError = await checkProjectOwnership(c, state);
	if (ownershipError) return ownershipError;

	const versionId = c.req.param("versionId");
	if (!await readProjectVersionRecordAny(idResult, versionId)) {
		return c.json({ error: "Version not found" }, 404);
	}

	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = versionReviewUpdateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const actor = user?.email || user?.userId || "local-user";
	const reviewId = c.req.param("reviewId");
	const reviews = normalizeVersionReviewRequests(state);
	const review = reviews.find((request) => request.id === reviewId && request.versionId === versionId);
	if (!review) return c.json({ error: "Version review not found" }, 404);

	// Self-approval bypass guard: the requester may not decide (approve /
	// changes-request) their OWN version-review request. The approver must differ
	// from the requester. Reopening (status "open") is still allowed.
	if (isSelfReviewDecision(review, { status: parsed.data.status as VersionReviewStatus, reviewer: actor })) {
		return c.json({ error: "You cannot review your own version request; another reviewer must decide." }, 403);
	}

	// Handles already on the request BEFORE this decision — they were notified at
	// request time, so a decision that re-states them must NOT re-ping them. Only a
	// NEW @mention introduced by the reviewer's decision note notifies.
	const priorReviewMentions = new Set(review.mentions ?? []);
	const updatedReview = updateVersionReviewRequest(review, {
		status: parsed.data.status as VersionReviewStatus,
		body: parsed.data.body,
		reviewer: actor,
	});
	state.versionReviewRequests = reviews.map((request) => request.id === reviewId ? updatedReview : request);
	appendActivity(state, createActivity({
		type: "version_review_updated",
		message: updatedReview.status === "approved"
			? `Version approved ${versionId.slice(0, 18)}`
			: updatedReview.status === "changes_requested"
				? `Version changes requested ${versionId.slice(0, 18)}`
				: `Version review reopened ${versionId.slice(0, 18)}`,
		metadata: {
			versionId,
			reviewId,
			status: updatedReview.status,
			mentions: updatedReview.mentions,
		},
	}));
	let version: ProjectVersionMetadata;
	try {
		version = await commitProjectStateWithVersion(idResult, projectCasBaseHash, state);
	} catch (error) {
		const casConflict = projectCasConflictResponse(c, error);
		if (casConflict) return casConflict;
		throw error;
	}
	setProjectStateHashHeader(c, state);
	// P1: notify @mentions newly introduced by the reviewer's decision note (parity
	// with comments). Tenant-scoped, author-skipped, idempotent (prior request
	// mentions already notified are skipped).
	const newDecisionMentions = (updatedReview.mentions ?? []).filter((handle) => !priorReviewMentions.has(handle));
	await notifyReviewMentions({
		workspaceId: state.workspaceId,
		projectId: idResult,
		mentions: newDecisionMentions,
		actor,
		authorUserId: user?.userId,
		subjectLabel: "review decision",
		linkUrl: `/projects/${idResult}/review?version=${versionId}`,
		body: updatedReview.decisionNote ?? updatedReview.body,
		metadata: { projectId: idResult, versionId, reviewId, status: updatedReview.status },
	}).catch(() => {/* swallow */});
	return c.json({
		review: updatedReview,
		reviews: state.versionReviewRequests.filter((request) => request.versionId === versionId),
		activityLog: state.activityLog ?? [],
		items: buildWorkspaceFeed(state),
		version,
	});
});

project.post("/:id/versions/:versionId/restore", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	const versionId = c.req.param("versionId");
	const versionState = (await readProjectVersionRecordAny(idResult, versionId))?.state ?? null;
	if (!versionState) return c.json({ error: "Version not found" }, 404);

	// W3.9: optional per-page/layer restore scope. An empty/missing body keeps
	// the legacy full-project restore behaviour.
	//
	// AUTHZ ORDER (P1 fix): the restore scope MUST be parsed BEFORE authorizing,
	// because a FULL restore and a SCOPED per-page restore require DIFFERENT access.
	// Running an empty/unscoped `update:project` check up front would reject ANY
	// fine-grained member (e.g. a page-scoped member: `isFineGrainedProjectWideAccess`
	// treats an undefined `pageIndex` against `scope.pageIndexes` as "asking for
	// everything") — locking a page-scoped member out of restoring their OWN page,
	// which the scoped path is supposed to permit. So we parse first, then authorize
	// against the SAME scope the restore actually targets.
	let rawBody: unknown = {};
	const rawText = await c.req.text();
	if (rawText.trim()) {
		try {
			rawBody = JSON.parse(rawText);
		} catch {
			return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
		}
	}
	const scopeParsed = versionRestoreScopeSchema.safeParse(rawBody);
	if (!scopeParsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: scopeParsed.error.issues }, 400);
	}
	const scope = scopeParsed.data;
	const scoped = scope.pageIndex !== undefined;

	if (scoped) {
		// SCOPED per-page/layer restore: merges exactly ONE page (or one layer on a
		// page) from the snapshot into the current state. Authorize against the SAME
		// scope the restore actually MUTATES — its pageIndex AND every language whose
		// output the merge would overwrite — mirroring how the per-page write endpoints
		// (e.g. comments) pass `pageIndex` into `checkProjectOwnership`. A member scoped
		// to that page/language may selectively restore it; a member scoped to a
		// DIFFERENT page/language is still rejected (403/404) by the page/language scope.
		//
		// P1 (codex re-review): the scope of authorization MUST cover everything the
		// operation writes. A PAGE-scoped restore swaps the WHOLE `PageState` via
		// `applySelectiveRestore` — including `languageOutputs` for EVERY language on the
		// page (the flat default track AND each non-default track), on both the current
		// page being overwritten and the snapshot page being introduced. So a
		// single-language check is an over-grant: a member scoped to (page 0, `en`) could
		// overwrite `ja`/`ko`/… outputs (other translators' work) on page 0. We therefore
		// authorize a PAGE restore against the UNION of all affected languages and return
		// the first denial — a single-language-scoped member gets 403/404; a member with
		// access to every language on the page (or a project-wide owner/editor) passes.
		// A LAYER-scoped restore only touches the FLAT default-track layers (it never
		// reads or writes `languageOutputs`), so it is correctly authorized against the
		// single default-track language.
		const defaultTrackLang = state.targetLang
			?? normalizeTargetLangs({ targetLang: state.targetLang, targetLangs: state.targetLangs })[0];
		let restoreLanguages: string[];
		if (scope.layerId !== undefined) {
			// Layer restore: only the flat default-track layers are mutated.
			restoreLanguages = [defaultTrackLang];
		} else {
			// Page restore: the entire PageState is swapped, so every language present on
			// either the current page (overwritten) or the snapshot page (introduced) is
			// mutated — plus the live AND snapshot default tracks (the flat layers).
			const currentPage = state.pages[scope.pageIndex] as PageState | undefined;
			const snapshotPage = versionState.pages?.[scope.pageIndex] as PageState | undefined;
			const affected = new Set<string>([defaultTrackLang]);
			if (versionState.targetLang) affected.add(versionState.targetLang);
			for (const lang of Object.keys(currentPage?.languageOutputs ?? {})) affected.add(lang);
			for (const lang of Object.keys(snapshotPage?.languageOutputs ?? {})) affected.add(lang);
			restoreLanguages = [...affected];
		}
		for (const language of restoreLanguages) {
			const scopedRestoreError = await checkProjectOwnership(c, state, "update:project", {
				language,
				pageIndex: scope.pageIndex,
			});
			if (scopedRestoreError) return scopedRestoreError;
		}
	} else {
		// FULL RESTORE SCOPE (authz): a full (non-scoped) restore replaces the ENTIRE live
		// state with the snapshot — every language track's `languageOutputs` plus SHARED,
		// non-language project state. A whole-project restore therefore requires TRULY
		// project-wide (unscoped) access: an unscoped owner/editor passes unchanged; a
		// member with ANY fine-grained scope restriction (languages/pages/chapters/…),
		// even one whose lists currently cover every track, must NOT full-restore.
		const fullRestoreError = await checkFullProjectStateOwnership(
			c,
			state,
			normalizeTargetLangs({ targetLang: versionState.targetLang, targetLangs: versionState.targetLangs }),
		);
		if (fullRestoreError) return fullRestoreError;
	}

	// Normalize the live state's review requests up front; shared by both the
	// scoped and full restore paths and by the reversible snapshot taken below.
	const preservedVersionReviews = normalizeVersionReviewRequests(state);

	if (scoped) {
		// Selective restore: merge a single page/layer from the snapshot into the
		// CURRENT state. Everything outside the scope is preserved verbatim — no
		// full-revert side effects, no data loss on the rest of the project.
		//
		// Compute and validate the merge BEFORE snapshotting. applySelectiveRestore
		// is pure (it clones, never mutates `state`), so a bad pageIndex/layerId
		// returns 400/404 here without ever writing a "restore" snapshot — otherwise
		// repeated invalid scoped requests would pollute version history and, via the
		// 50-version prune, eventually discard real saves even though no restore ran.
		const merge = applySelectiveRestore(state, versionState, scope);
		if (!merge.ok) {
			const status = merge.code === "page_out_of_range" ? 400 : 404;
			return c.json({ error: merge.message, code: merge.code }, status);
		}

		// Snapshot the live state only now that the restore is known-valid, so the
		// partial restore stays reversible without discarding in-flight work.
		await createProjectVersion(idResult, state, "restore");

		const mergedState = merge.state;
		ensureProjectWorkflow(mergedState);
		normalizeProjectComments(mergedState);
		normalizeAiReviewMarkers(mergedState);
		normalizeProjectReviewDecisions(mergedState);
		normalizeWorkspaceMessages(mergedState);
		normalizeVersionReviewRequests(mergedState);
		const scopeLabel = merge.scope === "layer"
			? `layer ${merge.restoredLayerId} on page ${(merge.restoredPageIndex ?? 0) + 1}`
			: `page ${(merge.restoredPageIndex ?? 0) + 1}`;
		appendActivity(mergedState, createActivity({
			type: "version_restored",
			message: `Restored ${scopeLabel} from ${versionId.slice(0, 18)}`,
			metadata: {
				versionId,
				scope: merge.scope,
				pageIndex: merge.restoredPageIndex,
				layerId: merge.restoredLayerId,
				layerKind: merge.restoredLayerKind,
			},
		}));
		await writeProjectState(idResult, mergedState);
		return c.json({
			ok: true,
			restoredVersionId: versionId,
			scope: merge.scope,
			restoredPageIndex: merge.restoredPageIndex,
			restoredLayerId: merge.restoredLayerId,
			restoredLayerKind: merge.restoredLayerKind,
		});
	}

	// Full restore replaces the live state wholesale, so snapshot it first to keep
	// the restore reversible and never silently discard in-flight work. (The scoped
	// path above snapshots only after validating, to avoid polluting history on a
	// rejected request; a full restore has no such validation gate.)
	await createProjectVersion(idResult, state, "restore");

	preserveProjectIdentityFields(versionState, state);
	versionState.versionReviewRequests = preservedVersionReviews;
	ensureProjectWorkflow(versionState);
	normalizeProjectComments(versionState);
	normalizeAiReviewMarkers(versionState);
	normalizeProjectReviewDecisions(versionState);
	normalizeWorkspaceMessages(versionState);
	normalizeVersionReviewRequests(versionState);
	appendActivity(versionState, createActivity({
		type: "version_restored",
		message: `Restored version ${versionId.slice(0, 18)}`,
		metadata: { versionId, scope: "project" },
	}));
	await writeProjectState(idResult, versionState);
	return c.json({ ok: true, restoredVersionId: versionId, scope: "project" });
});

// Save project state
project.post("/:id/save", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;

	// Load state to check ownership
	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);
	// Storage-atomic CAS baseline for the save path: the full-state hash AS LOADED.
	// The save merges the persisted server-owned collections (`body.tasks = state.tasks`
	// …) read from THIS same snapshot, so verifying the persisted hash still equals
	// this inside the commit lock rejects a save that raced ANY concurrent change
	// (page/text edits OR a dedicated-endpoint mutation) instead of clobbering it.
	const projectCasBaseHash = hashProjectState(state);

	// Read the raw body and reject an oversized payload at the DOOR, before parsing.
	// The prod node server runs with BODY_SIZE_LIMIT=Infinity (for large uploads), so
	// nothing else caps the save body — and the per-field schema bounds below cap each
	// DIMENSION (string/array/depth/key-count) but not the TOTAL size. This single
	// guard closes the whole DoS class (breadth × depth × count) for any save; the
	// limit is far above any legitimate project state. (A real chapter save is a few
	// MB; this only rejects abusive multi-hundred-MB payloads.)
	let rawBody: string;
	try {
		rawBody = await c.req.text();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	// Compare the BYTE length, not `rawBody.length` (UTF-16 code units): a payload of
	// multi-byte JSON (e.g. CJK text, emoji) encodes to MORE bytes than its string
	// length, so a string-length check let a body that exceeds the intended BYTE cap
	// through. `Buffer.byteLength(..., "utf8")` is the actual serialized size.
	if (Buffer.byteLength(rawBody, "utf8") > MAX_SAVE_BODY_BYTES) {
		return c.json({ error: "Project state too large", code: "payload_too_large" }, 413);
	}
	let body: any;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	// Basic sanity check — must have projectId matching
	if (!body.projectId || body.projectId !== idResult) {
		return c.json({ error: "Project ID mismatch" }, 400);
	}
	// Strict-but-bounded schema validation BEFORE any mutation/write: reject
	// malformed/oversized state (non-finite or out-of-range geometry, negative
	// sizes, multi-megabyte text, unbounded arrays) with a 400 instead of
	// persisting it. The schema is permissive on unknown/additive fields (it keeps
	// them) so a legitimate save never breaks; it only enforces the bounds. The
	// server-owned collections it loosely bounds here are discarded + rebuilt from
	// the persisted state below regardless.
	const validation = projectStateSaveSchema.safeParse(body);
	if (!validation.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: validation.error.issues }, 400);
	}
	// Persist the VALIDATED/bounded data, not the raw request body. The schema's
	// permissive branches keep unknown/additive fields but now bound them
	// (`.catchall(boundedUnknownValue)` caps unknown string/array length + nesting
	// depth), so re-pointing `body` at `validation.data` means every downstream
	// mutation + the final writeProjectState persists the sanitized object — a raw
	// `body` would still carry unbounded unknown payloads (the prod node server runs
	// with BODY_SIZE_LIMIT=Infinity, so nothing else caps them).
	body = validation.data;
	const saveChangesPageSet = pageImageIdSequenceChanged(
		pageImageIdSequence(state),
		pageImageIdSequence(body as ProjectState),
	);
	const requestedTargetLang = typeof body.targetLang === "string" && body.targetLang.trim()
		? body.targetLang.trim()
		: state.targetLang;
	// FULL-STATE SAVE SCOPE (authz): this route persists the client-supplied FULL
	// `ProjectState.pages`, i.e. EVERY language track's `languageOutputs`. Authorizing
	// only the current/requested single language would let a language-SCOPED
	// collaborator overwrite OTHER languages' text/data. So a full-state save must be
	// authorized against EVERY language track (plus the requested target lang). An
	// unscoped owner/editor passes unchanged; a collaborator scoped to a subset of
	// languages is rejected. (Scoped contributors should use the per-language
	// endpoints — import-json, AI track writes — which are language-scoped.)
	const ownershipError = await checkFullProjectStateOwnership(c, state, [requestedTargetLang]);
	if (ownershipError) return ownershipError;
	// C1: reject a displaced/expired page-lease holder's in-flight save BEFORE the
	// CAS check — a takeover writes nothing to state, so the displaced holder's
	// baseline still matches and would silently clobber the new holder. Opt-in via
	// the `x-edit-lock-id` header + fail-open (see rejectIfPageLeaseLost). P0-2: when
	// the client marks the save page-scoped (`x-edit-page-scoped`, a page is open / a
	// lease is expected) and the prod require-lease-header flag is on, a MISSING lease
	// header is rejected 428 so a displaced/buggy client can't dodge the lease check.
	const saveUser = getAuthUser(c) as JWTPayload | undefined;
	// TWO INDEPENDENT GATES drive off TWO DIFFERENT signals (round-5 P1 — split them so a
	// legit cover/export full-payload save is not 428'd while the hostile-client net stays
	// intact):
	//
	//  (1) The mandatory-BASE-FINGERPRINT gate (the real clobber-prevention CAS net) keys on
	//      the PAYLOAD: ANY body that carries `pages` (`bodyCarriesPages`) MUST present
	//      `x-project-base-fingerprint` (when the prod baseline flag is on) or it is rejected.
	//      Server-inferred so a buggy/hostile client cannot dodge CAS by omitting a header —
	//      cover/export utility saves DO send a fingerprint, so they pass.
	//
	//  (2) The LEASE-HEADER (`x-edit-lock-id`) requirement keys on the client PAGE-EDIT
	//      signal (`x-edit-page-scoped` === "1"), NOT on the mere presence of `pages`. Only
	//      an actual page-EDIT save carries a lease; the legit `saveState()` page-edit path
	//      sets pageScoped=true + the lock id. Cover/export utility saves carry `pages`
	//      (full state) but are NOT page-edit sessions — they omit the marker + lease and
	//      are protected by CAS (gate 1) instead, so they must NOT be forced to carry a lease.
	//
	// Net: hostile client (full pages, no fingerprint) → rejected by gate (1); honest page
	// edit (pageScoped + lease) → lease enforced by gate (2); cover/export (pages +
	// fingerprint, no lease) → allowed, CAS-protected. (A no-state-write takeover is invisible
	// to CAS, but only a real page-edit session can be displaced by a takeover — and those
	// always carry the marker + lease — so keying gate (2) on the client marker is sound.)
	const bodyCarriesPages = Array.isArray(body.pages);
	const clientPageScoped = c.req.header("x-edit-page-scoped")?.trim() === "1";
	const leaseLost = await rejectIfPageLeaseLost(c, saveUser, { pageScoped: clientPageScoped });
	if (leaseLost) return leaseLost;
	const baseFingerprint = c.req.header("x-project-base-fingerprint")?.trim();
	// P0-2 (round-3): a page-bearing save MUST carry a CAS baseline fingerprint. The
	// save's own `projectCasBaseHash` is computed from the server state read DURING this
	// request, so it always matches itself — it ONLY catches drift between this read and
	// the commit, NOT a STALE full-payload overwrite (a client that loaded old state and
	// POSTs it back). The `x-project-base-fingerprint` is the only signal that catches a
	// stale full body, so when the prod baseline-required flag is ON we REJECT 428 a
	// page-bearing save that omits it — a hostile/buggy client can no longer clobber
	// newer page edits by simply dropping the header. (Gated by the same flag as the
	// dedicated-endpoint baseline requirement so dev/test and legitimate first-saves are
	// unaffected; a PRESENT-but-stale fingerprint always rejects 409 regardless of flag.)
	if (!baseFingerprint && bodyCarriesPages && serverConfig.requireProjectBaselineHeaderEnabled) {
		return c.json({
			error: "Missing concurrency baseline header (x-project-base-fingerprint)",
			code: "project_baseline_required",
		}, 428);
	}
	if (baseFingerprint && createProjectStateFingerprint(state) !== baseFingerprint) {
		return c.json({
			error: "Project changed remotely",
			code: "project_save_conflict",
		}, 409);
	}

	// Preserve server-owned identity fields when saving.
	preserveProjectIdentityFields(body as ProjectState, state);
	// Keep reading direction within the allowed set; drop unknown values.
	if (body.readingDirection !== undefined
		&& body.readingDirection !== "rtl"
		&& body.readingDirection !== "ltr"
		&& body.readingDirection !== "vertical") {
		body.readingDirection = state.readingDirection;
	}
	// Server-authoritative sub-collections. These are mutated ONLY through their
	// dedicated endpoints (workflow/comments/ai-markers/review-decisions/
	// workspace-feed/exports), so the general save must NOT trust the client's
	// (possibly stale) full arrays — doing so silently dropped a concurrent
	// dedicated-endpoint change (e.g. Tab A hydrated comments=[old]; Tab B posted
	// a new comment via /comments → [new, old]; Tab A's general save carrying the
	// stale [old] would overwrite [new] away). We always keep the persisted
	// `state.x` and IGNORE `body.x`.
	//
	// The one legitimate way a general save mutates these is a PAGE REORDER: the
	// client reorders `state.pages` and saves, and every page-linked record must
	// follow its page to the new index. We do that remap SERVER-SIDE from the page
	// order alone (see page-reorder.ts) instead of trusting the client's arrays,
	// so a reorder never becomes a vector for clobbering a concurrent change.
	const reorderPlan = derivePageReorderPlan(
		state.pages,
		Array.isArray(body.pages) ? (body.pages as ProjectState["pages"]) : state.pages,
	);
	applyPageReorderToServerOwnedCollections(state, reorderPlan);
	body.tasks = state.tasks;
	body.activityLog = state.activityLog;
	body.comments = state.comments;
	body.aiReviewMarkers = state.aiReviewMarkers;
	body.reviewDecisions = state.reviewDecisions;
	body.reviewAssignments = state.reviewAssignments;
	body.revisionRequests = state.revisionRequests;
	body.workspaceMessages = state.workspaceMessages;
	body.versionReviewRequests = state.versionReviewRequests;
	body.exportRuns = state.exportRuns;
	// The chapter team roster is server-owned (mutated only through the dedicated
	// /:id/team endpoints), so the general save must NOT trust the client's
	// (possibly stale) array — same rule as tasks/comments/etc. above. Always keep
	// the persisted `state.chapterTeam` and ignore any client-sent value.
	body.chapterTeam = state.chapterTeam;
	ensureProjectWorkflow(body as ProjectState);
	normalizeProjectComments(body as ProjectState);
	normalizeAiReviewMarkers(body as ProjectState);
	normalizeProjectReviewDecisions(body as ProjectState);
	normalizeReviewAssignments(body as ProjectState);
	normalizeRevisionRequests(body as ProjectState);
	normalizeWorkspaceMessages(body as ProjectState);
	normalizeVersionReviewRequests(body as ProjectState);
	// perf(save) #437: hash the merged/normalized state ONCE here and thread it through
	// both the in-mutex version snapshot AND the response header. `body` is not mutated
	// after this point, so this single sha256 is byte-identical to what createProjectVersion
	// + setProjectStateHashHeader would each recompute — collapsing the redundant re-hashes
	// of the SAME in-memory state into 1 on the autosave hot path (200-500 page, multi-MB
	// chapters). This does NOT touch #428's in-mutex CAS RE-READ hash (the freshly re-read
	// PERSISTED object inside commitProjectStateWithCas, a separate correctness check).
	const savedStateHash = hashProjectState(body as ProjectState);
	let version: ProjectVersionMetadata;
	try {
		// C6: run the version snapshot + retention prune INSIDE the same per-project
		// mutex as the state commit (via the afterCommit hook) so state-commit +
		// versioning + prune are one serialized unit. A concurrent commit can no longer
		// interleave between this save's write and its snapshot. The `!` is safe: the
		// afterCommit callback always returns a metadata, and a CAS conflict throws.
		// P0-1: re-validate the page lease UNDER the same mutex (leaseGuard), atomically
		// with the hash CAS and immediately before the write — closes the TOCTOU window
		// where a takeover (which writes NO state, so the hash is unchanged) slipped in
		// between the early lease check and the write. A lost lease throws
		// ProjectLeaseLostError → mapped to editing_taken_over / save-conflict below.
		version = (await commitProjectStateWithCas(
			idResult,
			projectCasBaseHash,
			body as ProjectState,
			{},
			// Thread the precomputed hash into the in-mutex snapshot (#437 hash-once) so the
			// version metadata reuses it instead of re-hashing the whole chapter again.
			() => createProjectVersion(idResult, body as ProjectState, "save", { stateHash: savedStateHash }),
			makePageLeaseGuard(c, saveUser),
		))!;
	} catch (error) {
		const conflict = projectCasConflictResponse(c, error);
		if (conflict) return conflict;
		throw error;
	}
	setProjectStateHashHeader(c, body as ProjectState, savedStateHash);
	if (saveChangesPageSet) {
		await publishPageSetChangedEvent((body as ProjectState).workspaceId, {
			projectId: idResult,
			changedBy: realtimeChangedBy(saveUser),
			pageCount: (body as ProjectState).pages.length,
		});
	}
	return c.json({ ok: true, version });
});

// Import translations.json
project.post("/:id/import-json", async (c) => {
	const idResult = validateProjectId(c);
	if (idResult instanceof Response) return idResult;

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	const parsed = importJsonSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const state = await readProjectState(idResult);
	if (!state) return c.json({ error: "Project not found" }, 404);

	// Resolve the target Language Track BEFORE authorization so the ownership
	// check is language-scoped (matching the per-language AI/track writes). An
	// import can only target a DECLARED target language; resolving + validating
	// the lang after the auth check would let a caller write into an arbitrary /
	// unauthorized language bucket. Absent / default-lang imports write the flat
	// `page.textLayers` (single-language projects stay byte-identical); a
	// non-default lang materializes into `page.languageOutputs[lang]` so an
	// imported TH translation lands on the TH track, not the shared flat layer.
	const defaultLang = resolveProjectDefaultLang(state);
	const importLang = parsed.data.lang?.trim().toLowerCase() || defaultLang;
	const importLangIsDefault = importLang === defaultLang;

	// Reject a lang that is not one of the project's normalized target tracks.
	// (The default lang is always a valid track.) This blocks materializing a
	// `languageOutputs` bucket for an undeclared language.
	const projectTargetLangs = normalizeProjectLanguageTracks(state);
	if (!importLangIsDefault && !projectTargetLangs.includes(importLang)) {
		return c.json({
			error: "Cannot import into a language that is not a declared target track",
			code: "language_track_not_found",
			language: importLang,
		}, 422);
	}

	// Per-language ownership check: enforce that the caller has import:project
	// permission for THIS language BEFORE any mutation.
	const ownershipError = await checkProjectOwnership(c, state, "import:project", { language: importLang });
	if (ownershipError) return ownershipError;

	let imported = 0;
	let skipped = 0;
	let orderMapped = 0;
	let sourceFiltered = 0;
	const orderMappedPaths = new Set<string>();
	const skippedByReason = createSkipSummary();
	const importedByPage = new Map<number, {
		pageIndex: number;
		imageId: string;
		imageName: string;
		originalName?: string;
		imported: number;
	}>();
	const entries = parsed.data.entries ?? parsed.data.items ?? [];
	const hasExplicitMappings = parsed.data.mappings !== undefined;
	const resolvedMappings: ResolvedImportMapping[] = [];
	if (hasExplicitMappings) {
		const targetPageIndexes = new Set<number>();
		const sourceKeys = new Set<string>();
		for (const mapping of parsed.data.mappings ?? []) {
			if (targetPageIndexes.has(mapping.targetPageIndex)) {
				return c.json({ error: "Duplicate target page mapping", targetPageIndex: mapping.targetPageIndex }, 400);
			}
			targetPageIndexes.add(mapping.targetPageIndex);
			const targetPage = state.pages[mapping.targetPageIndex];
			if (!targetPage) {
				return c.json({ error: "Target page not found" }, 400);
			}
			const sourceFilter = getImportSourceFilter(mapping);
			if (!sourceFilter) {
				return c.json({ error: "Mapping source not found" }, 400);
			}
			const sourceKey = importSourceFilterKey(sourceFilter);
			if (sourceKeys.has(sourceKey)) {
				return c.json({ error: "Duplicate source mapping", targetPageIndex: mapping.targetPageIndex }, 400);
			}
			sourceKeys.add(sourceKey);
			resolvedMappings.push({
				targetPageIndex: mapping.targetPageIndex,
				targetPage,
				sourceFilter,
				imported: 0,
			});
		}
	}
	const sourceFilter = hasExplicitMappings ? null : getImportSourceFilter(parsed.data);
	const targetPageIndex = parsed.data.targetPageIndex ?? (sourceFilter ? parsed.data.pageIndex ?? state.currentPage : undefined);
	const targetPage = sourceFilter
		? state.pages[targetPageIndex ?? state.currentPage]
		: null;
	if (sourceFilter && !targetPage) {
		return c.json({ error: "Target page not found" }, 400);
	}
	// Validate every row UP FRONT. Per-row schema validation skips+counts a non-object
	// row, an oversized text field, or a non-finite / out-of-range bbox/box
	// (invalid_entry) rather than 500-ing the whole import or persisting an absurd
	// coordinate / multi-megabyte string. We do it BEFORE building the image-path order
	// fallback: that fallback derives a per-page mapping from each row's image_path and
	// bails out entirely (returns an empty map) when its unmatched-key count differs
	// from the available-page count — so an invalid row's stray image_path could shift
	// that count and zero out the fallback, starving otherwise-valid rows into
	// page_not_found skips. Building it from the VALID rows only removes that poisoning.
	const validatedEntries: { entryIndex: number; entry: Record<string, unknown> }[] = [];
	for (const [entryIndex, rawEntry] of entries.entries()) {
		const entryValidation = validateImportEntry(rawEntry);
		if (!entryValidation.ok) {
			skipped++;
			skippedByReason.invalid_entry++;
			continue;
		}
		validatedEntries.push({ entryIndex, entry: entryValidation.entry });
	}
	const imagePathOrderFallback = sourceFilter || hasExplicitMappings
		? new Map<string, number>()
		: buildImportImagePathOrderFallback(state, validatedEntries.map((v) => v.entry), parsed.data.image_path);
	const importedAt = new Date().toISOString();

	for (const { entryIndex, entry } of validatedEntries) {
		const matchedMapping = hasExplicitMappings
			? resolvedMappings.find((mapping) => entryMatchesImportSourceFilter(entry, mapping.sourceFilter, parsed.data.image_path))
			: undefined;
		if (hasExplicitMappings && !matchedMapping) {
			sourceFiltered++;
			continue;
		}
		if (sourceFilter && !entryMatchesImportSourceFilter(entry, sourceFilter, parsed.data.image_path)) {
			sourceFiltered++;
			continue;
		}

		const orderMappedPath = shouldReportOrderFallbackMapping(
			state,
			entry,
			parsed.data.image_path,
			imagePathOrderFallback,
		);
		const page = matchedMapping
			? matchedMapping.targetPage
			: (sourceFilter && targetPage
				? targetPage
				: findImportPage(state, entry, parsed.data.pageIndex, parsed.data.image_path, imagePathOrderFallback));
		if (!page) {
			skipped++;
			skippedByReason.page_not_found++;
			continue;
		}

		const layer = normalizeImportedLayer(entry, entryIndex);
		if (!layer) {
			skipped++;
			skippedByReason.invalid_layer++;
			continue;
		}

		appendImportedLayerToTrack(page, importLang, importLangIsDefault, layer);
		// QC handoff is per-language: a non-default-track import resets that track's
		// bucket handoff; the default track keeps using the flat page field.
		const qcHandoffNext = {
			status: "pending" as const,
			updatedAt: importedAt,
			updatedBy: "import-json",
		};
		if (importLangIsDefault) {
			page.qcHandoff = { ...page.qcHandoff, ...qcHandoffNext };
		} else {
			const bucket = page.languageOutputs![importLang]!;
			bucket.qcHandoff = { ...bucket.qcHandoff, ...qcHandoffNext };
		}
		imported++;
		if (matchedMapping) {
			matchedMapping.imported++;
		}
		if (orderMappedPath) {
			orderMapped++;
			orderMappedPaths.add(orderMappedPath);
		}
		const pageIndex = state.pages.indexOf(page);
		const existingPageSummary = importedByPage.get(pageIndex);
		if (existingPageSummary) {
			existingPageSummary.imported++;
		} else {
			importedByPage.set(pageIndex, {
				pageIndex,
				imageId: page.imageId,
				imageName: page.imageName,
				originalName: page.originalName,
				imported: 1,
			});
		}
	}

	ensureProjectWorkflow(state);
	appendActivity(state, createActivity({
		type: "import_json",
		message: `Imported ${imported} text layers from JSON`,
		metadata: {
			imported,
			skipped,
			orderMapped,
			sourceFiltered,
			sourceMappings: hasExplicitMappings ? resolvedMappings.length : undefined,
		},
	}));
	await writeProjectState(idResult, state);
	const version = await createProjectVersion(idResult, state, "import-json");
	return c.json({
		imported,
		skipped,
		skippedByReason,
		orderMapped,
		orderMappedPaths: Array.from(orderMappedPaths).sort(importPathCollator.compare),
		sourceFiltered,
		sourceMapped: sourceFilter ? {
			...serializeImportSourceMapping({
				targetPageIndex: targetPageIndex ?? state.currentPage,
				sourceFilter,
				sourceFiltered,
			}),
		} : undefined,
		sourceMappings: hasExplicitMappings
			? resolvedMappings.map((mapping) => serializeImportSourceMapping(mapping))
			: undefined,
		pages: Array.from(importedByPage.values()).sort((a, b) => a.pageIndex - b.pageIndex),
		version,
	});
});

export { loadProjectState, preserveProjectIdentityFields, project };
// Round-2 concurrent-edit guards, exported for focused regression tests (P0-1 in-lock
// lease guard, P0-2 require-lease-header). Internal API; not part of the route surface.
export {
	commitProjectStateWithCas,
	commitProjectStateWithVersion,
	makePageLeaseGuard,
	rejectIfPageLeaseLost,
	ProjectStateCasConflictError,
	ProjectLeaseLostError,
	hashProjectState,
	createProjectStateFingerprint,
	readProjectState,
	writeProjectState,
	withProjectMutationLock,
};
