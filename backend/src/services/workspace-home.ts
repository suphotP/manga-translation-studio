import type {
	PageReviewDecision,
	ProjectState,
	WorkflowTask,
	WorkflowTaskStatus,
	WorkflowTaskType,
	WorkspaceFeedItem,
} from "../types/index.js";
import { normalizeAssigneeHandle } from "./assignees.js";
import { buildWorkspaceFeed } from "./workspace-hub.js";
import { normalizeWorkflowTaskPriority } from "./workflow.js";

/**
 * Cross-project workspace-home aggregate. This is the "KEYSTONE" surface: it
 * decouples the dashboard / My-Work / activity widgets from whichever single
 * chapter happens to be open in the editor. Per-project readers
 * (`buildWorkspaceFeed`, the workflow task list) are fanned across EVERY project
 * the member can see and merged server-side here so the frontend never has to
 * have a project "open" to show real, honest, aggregated data.
 */

export const WORKSPACE_HOME_MAX_MY_TASKS = 60;
export const WORKSPACE_HOME_MAX_ATTENTION = 40;
export const WORKSPACE_HOME_MAX_ACTIVITY = 60;
export const WORKSPACE_HOME_MAX_AI_JOBS = 40;
// dueToday is the most urgent slice of myTasks; cap it like the other lists so
// the response can never carry an unbounded array. `counts.dueToday` keeps the
// true total so the UI can still show "N due today" honestly.
export const WORKSPACE_HOME_MAX_DUE_TODAY = 60;

/** Lightweight project context stamped onto every aggregated row. */
export interface WorkspaceHomeProjectRef {
	projectId: string;
	projectName: string;
	storyId?: string;
	storyTitle?: string;
	chapterLabel?: string;
	targetLang?: string;
}

export interface WorkspaceHomeTask extends WorkspaceHomeProjectRef {
	id: string;
	type: WorkflowTaskType;
	status: WorkflowTaskStatus;
	priority: WorkflowTask["priority"];
	title: string;
	pageIndex: number;
	assignee?: string;
	dueAt?: string;
	dueState?: "overdue" | "soon" | "scheduled";
	// createdAt/updatedAt are carried verbatim from the source WorkflowTask so a
	// WorkspaceHomeTask is structurally a superset of WorkflowTask (the frontend
	// dashboard helpers consume it directly as one).
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceHomeFeedItem extends WorkspaceFeedItem, WorkspaceHomeProjectRef {}

export interface WorkspaceHomeAiJob extends WorkspaceHomeProjectRef {
	id: string;
	markerId: string;
	jobId: string;
	pageIndex: number;
	status: string;
	tier: string;
	updatedAt: string;
	error?: string;
}

export type WorkspacePipelineStage = WorkflowTaskType;

export interface WorkspacePipelineStageCounts {
	stage: WorkspacePipelineStage;
	todo: number;
	doing: number;
	review: number;
	done: number;
	total: number;
	open: number;
}

export interface WorkspaceHomeCounts {
	projects: number;
	myOpenTasks: number;
	attention: number;
	aiJobs: number;
	dueToday: number;
	overdue: number;
	openTasks: number;
}

/**
 * Distinct target-language codes across EVERY project the member can see, sorted
 * and upper-cased. Workspace-scoped (never the open chapter) so the dashboard's
 * "target languages" metric is stable when a chapter is opened/closed. Empty when
 * the workspace has no projects.
 */
function distinctTargetLangs(projects: WorkspaceHomeProjectInput[]): string[] {
	const seen = new Set<string>();
	for (const input of projects) {
		const code = input.state?.targetLang?.trim();
		if (code) seen.add(code.toUpperCase());
	}
	return Array.from(seen).sort();
}

/**
 * Stable, WORKSPACE-scoped "resume where you left off" project that powers the
 * dashboard hero. It is the most-recently-updated project the member can see
 * (the projects list arrives ordered updated_at DESC), derived here from the
 * aggregate's OWN inputs — NOT from whichever single chapter happens to be open
 * in the editor. This is the keystone field that lets the hero stay identical
 * when a chapter is opened or closed. `null` when the workspace has no projects.
 */
export interface WorkspaceHomeRecentProject extends WorkspaceHomeProjectRef {
	sourceLang?: string;
	pageCount: number;
	updatedAt: string;
	/**
	 * Cover image identity for the hero, sourced from the SAME project state as the
	 * rest of the aggregate (never the open chapter). The frontend builds the
	 * thumbnail URL from `projectId` + `coverImageId`, so the hero cover stays
	 * identical when a chapter is opened/closed. Omitted when the project has no
	 * cover yet (honest fallback to the seeded DefaultCover).
	 */
	coverImageId?: string;
	coverOriginalName?: string;
	/**
	 * Honest localization progress: the share of pages with a latest `approved`
	 * review decision. `hasProgress` gates whether the UI may show the number —
	 * when no page has been reviewed yet we expose `0` + `hasProgress:false` so
	 * the hero renders an honest "no progress data" state instead of a fabricated
	 * percentage.
	 */
	progressPercent: number;
	hasProgress: boolean;
}

export interface WorkspaceHomeAggregate {
	workspaceId: string;
	generatedAt: string;
	myTasks: WorkspaceHomeTask[];
	attention: WorkspaceHomeFeedItem[];
	activity: WorkspaceHomeFeedItem[];
	aiJobs: WorkspaceHomeAiJob[];
	pipelineByStage: WorkspacePipelineStageCounts[];
	dueToday: WorkspaceHomeTask[];
	counts: WorkspaceHomeCounts;
	/**
	 * Distinct target-language codes across every visible project (sorted, upper-cased).
	 * Workspace-scoped so the dashboard's "target languages" metric is independent of
	 * the open chapter. Empty for an empty workspace.
	 */
	targetLangs: string[];
	/** Stable workspace-scoped hero project; null when the workspace has no projects. */
	recentProject: WorkspaceHomeRecentProject | null;
}

export interface WorkspaceHomeProjectInput {
	state: ProjectState;
	/** Display name override (e.g. from the catalog summary). Falls back to state.name. */
	name?: string;
}

export interface BuildWorkspaceHomeOptions {
	workspaceId: string;
	projects: WorkspaceHomeProjectInput[];
	/**
	 * Identity handles for the viewing member (email and/or userId). A task whose
	 * normalized assignee matches any of these surfaces in `myTasks`. Empty/omitted
	 * means the member has no resolvable handle, so `myTasks` stays empty rather
	 * than guessing.
	 */
	viewerHandles?: Array<string | null | undefined>;
	/**
	 * Per-project duty task types the viewer holds (series-level assignment,
	 * unless overridden by chapter-team membership — see services/story-duties).
	 * An open task with NO explicit assignee whose type matches a duty surfaces
	 * in `myTasks`; an explicit assignee always wins over duty inference.
	 */
	viewerDutyTypesByProject?: ReadonlyMap<string, ReadonlySet<WorkflowTaskType>>;
	now?: number;
}

const PIPELINE_STAGES: WorkspacePipelineStage[] = ["translate", "clean", "typeset", "review"];

const WORKSPACE_DUE_SOON_MS = 24 * 60 * 60 * 1000;

function projectRef(state: ProjectState, name: string | undefined): WorkspaceHomeProjectRef {
	return {
		projectId: state.projectId,
		projectName: (name ?? state.name ?? state.projectId).trim() || state.projectId,
		storyId: state.storyId,
		storyTitle: state.storyTitle,
		chapterLabel: state.chapterLabel ?? state.chapterTitle ?? state.chapterNumber,
		targetLang: state.targetLang,
	};
}

function normalizeHandleSet(handles: Array<string | null | undefined> | undefined): Set<string> {
	const set = new Set<string>();
	for (const raw of handles ?? []) {
		const normalized = normalizeAssigneeHandle(raw);
		if (normalized) set.add(normalized.toLowerCase());
	}
	return set;
}

function taskDueState(task: WorkflowTask, now: number): WorkspaceHomeTask["dueState"] {
	if (!task.dueAt || task.status === "done") return undefined;
	const dueTime = Date.parse(task.dueAt);
	if (!Number.isFinite(dueTime)) return undefined;
	if (dueTime < now) return "overdue";
	if (dueTime - now <= WORKSPACE_DUE_SOON_MS) return "soon";
	return "scheduled";
}

function isDueToday(task: WorkflowTask, now: number): boolean {
	if (!task.dueAt || task.status === "done") return false;
	const dueTime = Date.parse(task.dueAt);
	if (!Number.isFinite(dueTime)) return false;
	const today = new Date(now);
	const startOfDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
	const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
	// Anything already overdue OR landing inside today's UTC window counts as
	// "needs attention today" — the dashboard's "due today" lane is really a
	// "do this now" lane, so overdue work belongs here too.
	return dueTime < endOfDay;
}

function dueRank(state: WorkspaceHomeTask["dueState"]): number {
	if (state === "overdue") return 0;
	if (state === "soon") return 1;
	if (state === "scheduled") return 2;
	return 3;
}

function emptyPipeline(): WorkspacePipelineStageCounts[] {
	return PIPELINE_STAGES.map((stage) => ({
		stage,
		todo: 0,
		doing: 0,
		review: 0,
		done: 0,
		total: 0,
		open: 0,
	}));
}

/**
 * Pure aggregator: merge the per-project workflow/feed readers across every
 * project the caller passes in. The route is responsible for only passing
 * projects the member is authorized to see (and for resolving the member's
 * identity handles), so this function has no authorization concerns — it is the
 * deterministic merge step that the route + the unit tests share.
 */
export function buildWorkspaceHomeAggregate(options: BuildWorkspaceHomeOptions): WorkspaceHomeAggregate {
	const now = options.now ?? Date.now();
	const viewerHandles = normalizeHandleSet(options.viewerHandles);

	const myTasks: WorkspaceHomeTask[] = [];
	const dueToday: WorkspaceHomeTask[] = [];
	const attention: WorkspaceHomeFeedItem[] = [];
	const activity: WorkspaceHomeFeedItem[] = [];
	const aiJobs: WorkspaceHomeAiJob[] = [];
	const pipeline = emptyPipeline();
	const pipelineByStage = new Map(pipeline.map((entry) => [entry.stage, entry]));

	let openTasks = 0;
	let overdue = 0;

	for (const input of options.projects) {
		const state = input.state;
		if (!state || typeof state.projectId !== "string" || !state.projectId) continue;
		const ref = projectRef(state, input.name);

		// --- workflow tasks → myTasks, dueToday, pipelineByStage ---
		for (const task of state.tasks ?? []) {
			const stageEntry = pipelineByStage.get(task.type as WorkspacePipelineStage);
			if (stageEntry) {
				stageEntry.total += 1;
				if (task.status === "todo") stageEntry.todo += 1;
				else if (task.status === "doing") stageEntry.doing += 1;
				else if (task.status === "review") stageEntry.review += 1;
				else if (task.status === "done") stageEntry.done += 1;
				if (task.status !== "done") stageEntry.open += 1;
			}
			if (task.status !== "done") openTasks += 1;

			const dueState = taskDueState(task, now);
			if (dueState === "overdue") overdue += 1;

			const homeTask: WorkspaceHomeTask = {
				...ref,
				// The task's own language track (translate/typeset/review) takes
				// precedence over the project-default carried by `ref` so a
				// language-scoped task reports its real target; language-agnostic
				// clean tasks (no task targetLang) fall back to the project default.
				...(task.targetLang?.trim() ? { targetLang: task.targetLang.trim() } : {}),
				id: task.id,
				type: task.type,
				status: task.status,
				priority: normalizeWorkflowTaskPriority(task.priority),
				title: task.title,
				pageIndex: task.pageIndex,
				assignee: normalizeAssigneeHandle(task.assignee),
				dueAt: task.dueAt,
				dueState,
				createdAt: task.createdAt,
				updatedAt: task.updatedAt,
			};

			const assigneeHandle = homeTask.assignee?.toLowerCase();
			const dutyTypes = options.viewerDutyTypesByProject?.get(state.projectId);
			// Explicit assignee wins; an UNASSIGNED task of a duty type the viewer
			// holds (series/chapter assignment) is theirs by duty.
			const isMine = assigneeHandle
				? viewerHandles.has(assigneeHandle)
				: Boolean(dutyTypes?.has(task.type));
			if (isMine && task.status !== "done") {
				myTasks.push(homeTask);
			}
			if (task.status !== "done" && isDueToday(task, now)) {
				dueToday.push(homeTask);
			}
		}

		// --- feed → attention (severity/priority) + activity (chronological) ---
		const feed = buildWorkspaceFeed(state);
		for (const item of feed) {
			const stamped: WorkspaceHomeFeedItem = { ...item, ...ref };
			activity.push(stamped);
			if (item.severity === "error" || item.severity === "warning" || item.priority === "urgent" || item.dueState === "overdue") {
				attention.push(stamped);
			}
		}

		// --- AI review markers still needing attention → aiJobs ---
		for (const marker of state.aiReviewMarkers ?? []) {
			if (marker.status === "accepted" || marker.status === "applied" || marker.status === "rejected") continue;
			aiJobs.push({
				...ref,
				id: `${state.projectId}:${marker.id}`,
				markerId: marker.id,
				jobId: marker.jobId,
				pageIndex: marker.pageIndex,
				status: marker.status,
				tier: marker.tier,
				updatedAt: marker.updatedAt,
				error: marker.error,
			});
		}
	}

	myTasks.sort(compareTaskUrgency);
	dueToday.sort(compareTaskUrgency);
	attention.sort(compareAttention);
	activity.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	aiJobs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

	const trimmedMyTasks = myTasks.slice(0, WORKSPACE_HOME_MAX_MY_TASKS);
	const trimmedAttention = attention.slice(0, WORKSPACE_HOME_MAX_ATTENTION);
	const trimmedActivity = activity.slice(0, WORKSPACE_HOME_MAX_ACTIVITY);
	const trimmedAiJobs = aiJobs.slice(0, WORKSPACE_HOME_MAX_AI_JOBS);
	const trimmedDueToday = dueToday.slice(0, WORKSPACE_HOME_MAX_DUE_TODAY);

	// The hero's "resume where you left off" project: the most-recently-updated
	// project the member can see. The route passes projects ordered updated_at
	// DESC, so the first valid project is the natural, stable hero. Derived from
	// the SAME inputs as the rest of the aggregate — never the open chapter.
	const recentProject = pickRecentProject(options.projects);

	return {
		workspaceId: options.workspaceId,
		generatedAt: new Date(now).toISOString(),
		myTasks: trimmedMyTasks,
		attention: trimmedAttention,
		activity: trimmedActivity,
		aiJobs: trimmedAiJobs,
		pipelineByStage: pipeline,
		dueToday: trimmedDueToday,
		targetLangs: distinctTargetLangs(options.projects),
		recentProject,
		counts: {
			projects: options.projects.length,
			myOpenTasks: myTasks.length,
			attention: attention.length,
			aiJobs: aiJobs.length,
			dueToday: dueToday.length,
			overdue,
			openTasks,
		},
	};
}

/**
 * Latest review decision per page, then the share that is `approved`. This is an
 * honest, server-derivable completion signal (it needs no editor/canvas state):
 * a page counts as "done" only when its most-recent review decision is approval.
 *
 * Only decisions whose `pageIndex` points at a CURRENT page (0 <= idx < totalPages)
 * are counted — stale decisions left behind by deleted/reordered pages must never
 * inflate progress past the real page set. We dedupe to the latest decision per
 * current page and clamp the result to [0, 100] so the hero meter can never exceed
 * 100% or show progress when no current page has any review data.
 */
function approvedPageProgress(state: ProjectState): { percent: number; hasProgress: boolean } {
	const totalPages = state.pages?.length ?? 0;
	const decisions = state.reviewDecisions ?? [];
	if (totalPages === 0 || decisions.length === 0) return { percent: 0, hasProgress: false };

	const latestByPage = new Map<number, PageReviewDecision>();
	for (const decision of decisions) {
		// Ignore decisions for pages that no longer exist (out-of-range index). A
		// decision for a deleted page must not count toward either the numerator
		// (approved) or the denominator (totalPages is the CURRENT page count).
		if (!Number.isInteger(decision.pageIndex) || decision.pageIndex < 0 || decision.pageIndex >= totalPages) {
			continue;
		}
		const prev = latestByPage.get(decision.pageIndex);
		if (!prev || Date.parse(decision.updatedAt) >= Date.parse(prev.updatedAt)) {
			latestByPage.set(decision.pageIndex, decision);
		}
	}
	// No in-range decision => no honest progress signal (e.g. every decision is for
	// a since-deleted page). Surface `hasProgress:false` instead of a fake 0%.
	if (latestByPage.size === 0) return { percent: 0, hasProgress: false };

	let approved = 0;
	for (const decision of latestByPage.values()) {
		if (decision.status === "approved") approved += 1;
	}
	const percent = Math.min(100, Math.max(0, Math.round((approved / totalPages) * 100)));
	return { percent, hasProgress: true };
}

/**
 * The stable hero project: the first (most-recently-updated) project the member
 * can see. Returns `null` for an empty workspace so the hero renders an honest
 * empty state.
 */
function pickRecentProject(projects: WorkspaceHomeProjectInput[]): WorkspaceHomeRecentProject | null {
	for (const input of projects) {
		const state = input.state;
		if (!state || typeof state.projectId !== "string" || !state.projectId) continue;
		const ref = projectRef(state, input.name);
		const progress = approvedPageProgress(state);
		return {
			...ref,
			sourceLang: state.sourceLang,
			pageCount: state.pages?.length ?? 0,
			updatedAt: latestProjectActivityAt(state),
			progressPercent: progress.percent,
			hasProgress: progress.hasProgress,
			// Cover from the SAME project state — keeps the hero cover aggregate-backed
			// and stable across chapter open/close (never read from projectStore).
			coverImageId: state.coverImageId,
			coverOriginalName: state.coverOriginalName,
		};
	}
	return null;
}

/**
 * A real "last touched" timestamp for the hero's caption, sourced from the
 * project's own activity/tasks rather than an invented value. Falls back to the
 * creation time when nothing else is dated.
 */
function latestProjectActivityAt(state: ProjectState): string {
	let latest = Date.parse(state.createdAt);
	const consider = (value: string | undefined): void => {
		if (!value) return;
		const ms = Date.parse(value);
		if (Number.isFinite(ms) && (!Number.isFinite(latest) || ms > latest)) latest = ms;
	};
	for (const task of state.tasks ?? []) consider(task.updatedAt);
	for (const event of state.activityLog ?? []) consider(event.createdAt);
	for (const decision of state.reviewDecisions ?? []) consider(decision.updatedAt);
	return Number.isFinite(latest) ? new Date(latest).toISOString() : state.createdAt;
}

function compareTaskUrgency(a: WorkspaceHomeTask, b: WorkspaceHomeTask): number {
	const dueDelta = dueRank(a.dueState) - dueRank(b.dueState);
	if (dueDelta !== 0) return dueDelta;
	const priorityDelta = priorityValue(a.priority) - priorityValue(b.priority);
	if (priorityDelta !== 0) return priorityDelta;
	return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function priorityValue(priority: WorkflowTask["priority"]): number {
	const normalized = normalizeWorkflowTaskPriority(priority);
	if (normalized === "urgent") return 0;
	if (normalized === "high") return 1;
	return 2;
}

const SEVERITY_RANK: Record<NonNullable<WorkspaceFeedItem["severity"]>, number> = {
	error: 0,
	warning: 1,
	info: 2,
};

function compareAttention(a: WorkspaceHomeFeedItem, b: WorkspaceHomeFeedItem): number {
	const severityA = a.severity ? SEVERITY_RANK[a.severity] : Number.MAX_SAFE_INTEGER;
	const severityB = b.severity ? SEVERITY_RANK[b.severity] : Number.MAX_SAFE_INTEGER;
	if (severityA !== severityB) return severityA - severityB;
	return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}
