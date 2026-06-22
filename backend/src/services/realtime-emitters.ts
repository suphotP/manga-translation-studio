// Realtime emitter helpers — thin wrappers around publishRealtimeEvent() so the
// surface-area services (ai-router, comments routes, workflow, locks…) don't
// repeat workspace-id lookup or envelope shaping.
//
// W2.7 Phase 1: SSE only. All emitters are best-effort — they swallow errors so
// realtime side-effects never block business logic.

import { publishRealtimeEvent } from "./realtime-bus.js";
import { readProjectStateFileGuarded } from "../utils/project-state-file.js";
import { sanitizeOptionalAiError } from "../utils/ai-error-sanitizer.js";
import type { AiJob, JobStatus, ProjectState } from "../types/index.js";

// Cache project→workspace lookups for a short window. Status events fire 1-5+
// times per job (queued, attempt, success/failure, done) so we don't want to hit
// the JSON file every single event; the cache TTL is short enough that
// workspace re-association still propagates.
const PROJECT_WORKSPACE_CACHE = new Map<string, { workspaceId: string | null; expiresAt: number }>();
const PROJECT_WORKSPACE_CACHE_TTL_MS = 60_000;

/** Look up the workspaceId for a given projectId. Returns null when missing or unknown. */
export async function resolveWorkspaceIdForProject(projectId: string, projectStateLoader?: (id: string) => Promise<ProjectState | null>): Promise<string | null> {
	const cached = PROJECT_WORKSPACE_CACHE.get(projectId);
	if (cached && cached.expiresAt > Date.now()) return cached.workspaceId;

	let state: ProjectState | null = null;
	if (projectStateLoader) {
		try {
			state = await projectStateLoader(projectId);
		} catch (error) {
			console.warn(`[Realtime] project state loader failed for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!state) {
		// Tombstone-aware: a permanently-deleted project must not have its stale
		// state.json resurrected to route realtime events to a workspace channel.
		state = readProjectStateFileGuarded<ProjectState>(projectId);
	}

	const workspaceId = state?.workspaceId?.trim() || null;
	PROJECT_WORKSPACE_CACHE.set(projectId, {
		workspaceId,
		expiresAt: Date.now() + PROJECT_WORKSPACE_CACHE_TTL_MS,
	});
	return workspaceId;
}

/** Test hook to clear the workspace cache between tests. */
export function clearWorkspaceLookupCacheForTesting(): void {
	PROJECT_WORKSPACE_CACHE.clear();
}

/** Allow tests to pre-seed the workspace lookup cache to skip file IO. */
export function seedWorkspaceLookupForTesting(projectId: string, workspaceId: string | null): void {
	PROJECT_WORKSPACE_CACHE.set(projectId, {
		workspaceId,
		expiresAt: Date.now() + 5 * 60_000,
	});
}

// ── AI job status ──────────────────────────────────────────────

export interface AiJobStatusEvent {
	jobId: string;
	projectId: string;
	status: JobStatus | string;
	tier?: string;
	provider?: string;
	error?: string;
	progress?: number;
	resultImageId?: string;
}

export async function emitAiJobStatusEvent(input: AiJobStatusEvent): Promise<void> {
	const workspaceId = await resolveWorkspaceIdForProject(input.projectId);
	if (!workspaceId) return;
	// Defense-at-emit: the realtime SSE channel must enforce the SAME allowlist as
	// the persist layer (queue.updateFromProcessor/appendEvent via
	// ai-error-sanitizer). Callers (e.g. ai-router finalize catch) pass the raw
	// provider/internal exception message, and SSE fans it out to every workspace
	// subscriber — so without this the channel would leak raw provider text that
	// the API (`GET /api/ai/status/:jobId`) already sanitizes. Funnel `error`
	// through the same helper so the value emitted matches the persisted/API value.
	const sanitizedError = sanitizeOptionalAiError(input.error);
	await publishRealtimeEvent(workspaceId, "ai_job_status", {
		jobId: input.jobId,
		projectId: input.projectId,
		status: input.status,
		tier: input.tier,
		provider: input.provider,
		error: sanitizedError,
		progress: input.progress,
		resultImageId: input.resultImageId,
	});
}

export async function emitAiJobStatusForJob(job: AiJob, extra?: { progress?: number; error?: string }): Promise<void> {
	await emitAiJobStatusEvent({
		jobId: job.jobId,
		projectId: job.projectId,
		status: job.status,
		tier: job.tier,
		provider: job.provider,
		resultImageId: job.resultImageId,
		progress: extra?.progress,
		error: extra?.error ?? job.error,
	});
}

// ── Comments ───────────────────────────────────────────────────

export interface CommentNewEvent {
	commentId: string;
	projectId: string;
	pageId?: string;
	pageIndex?: number;
	threadId?: string;
	author?: string;
	excerpt?: string;
}

export async function emitCommentNewEvent(input: CommentNewEvent): Promise<void> {
	const workspaceId = await resolveWorkspaceIdForProject(input.projectId);
	if (!workspaceId) return;
	await publishRealtimeEvent(workspaceId, "comment_new", {
		commentId: input.commentId,
		projectId: input.projectId,
		pageId: input.pageId,
		pageIndex: input.pageIndex,
		threadId: input.threadId,
		author: input.author,
		excerpt: input.excerpt,
	});
}

// ── Locks ─────────────────────────────────────────────────────
// PR #85 (work-locks) hasn't landed yet — these stubs let downstream services
// call into the realtime layer once the locks service ships without another
// round of plumbing.

export interface LockEvent {
	lockId: string;
	scope: string;
	scopeId: string;
	owner?: string;
	projectId?: string;
	workspaceId?: string;
	expiresAt?: string;
}

export async function emitLockAcquiredEvent(input: LockEvent): Promise<void> {
	const workspaceId = input.workspaceId?.trim()
		|| (input.projectId ? await resolveWorkspaceIdForProject(input.projectId) : null);
	if (!workspaceId) return;
	await publishRealtimeEvent(workspaceId, "lock_acquired", {
		lockId: input.lockId,
		scope: input.scope,
		scopeId: input.scopeId,
		owner: input.owner,
		projectId: input.projectId,
		expiresAt: input.expiresAt,
	});
}

export async function emitLockReleasedEvent(input: LockEvent): Promise<void> {
	const workspaceId = input.workspaceId?.trim()
		|| (input.projectId ? await resolveWorkspaceIdForProject(input.projectId) : null);
	if (!workspaceId) return;
	await publishRealtimeEvent(workspaceId, "lock_released", {
		lockId: input.lockId,
		scope: input.scope,
		scopeId: input.scopeId,
		owner: input.owner,
		projectId: input.projectId,
	});
}

// ── Workflow transitions ──────────────────────────────────────

export interface WorkflowTransitionEvent {
	subjectKind: string;
	subjectId: string;
	from: string;
	to: string;
	by?: string;
	projectId?: string;
	workspaceId?: string;
}

export async function emitWorkflowTransitionEvent(input: WorkflowTransitionEvent): Promise<void> {
	const workspaceId = input.workspaceId?.trim()
		|| (input.projectId ? await resolveWorkspaceIdForProject(input.projectId) : null);
	if (!workspaceId) return;
	await publishRealtimeEvent(workspaceId, "workflow_transition", {
		subjectKind: input.subjectKind,
		subjectId: input.subjectId,
		from: input.from,
		to: input.to,
		by: input.by,
		projectId: input.projectId,
	});
}

// ── Activity feed ─────────────────────────────────────────────

export interface ActivityFeedEvent {
	workspaceId: string;
	actor?: string;
	verb: string;
	subject?: string;
	subjectKind?: string;
	projectId?: string;
	metadata?: Record<string, unknown>;
}

export async function emitActivityFeedEvent(input: ActivityFeedEvent): Promise<void> {
	if (!input.workspaceId?.trim()) return;
	await publishRealtimeEvent(input.workspaceId, "activity_feed", {
		actor: input.actor,
		verb: input.verb,
		subject: input.subject,
		subjectKind: input.subjectKind,
		projectId: input.projectId,
		metadata: input.metadata,
	});
}

// ── Presence ──────────────────────────────────────────────────

export interface PresencePingEvent {
	workspaceId: string;
	userId: string;
	lastSeen?: number;
	context?: { projectId?: string; pageIndex?: number };
}

export async function emitPresencePingEvent(input: PresencePingEvent): Promise<void> {
	if (!input.workspaceId?.trim()) return;
	await publishRealtimeEvent(input.workspaceId, "presence_ping", {
		userId: input.userId,
		lastSeen: input.lastSeen ?? Date.now(),
		context: input.context,
	});
}
