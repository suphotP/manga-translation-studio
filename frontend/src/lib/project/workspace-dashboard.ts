import { isWorkspaceFeedAttention } from "$lib/project/workspace-feed-filters.js";
import { formatAssigneeHandle, normalizeAssigneeHandle } from "$lib/project/assignees.js";
import {
	formatWorkflowDueDay,
	isWorkflowTaskOpen,
	isWorkflowTaskOverdue,
	parseWorkflowTaskDueTime,
} from "$lib/project/task-due.js";
import { workflowTaskPriorityRank } from "$lib/project/task-priority.js";
import { buildStoryTitleKey } from "$lib/project/story-id.js";
import type { ProjectSummary, WorkspaceHomeTask } from "$lib/api/client.js";
import { formatRecentProjectName } from "$lib/project/recent-projects.js";
import type { WorkInboxItem } from "$lib/project/work-inbox.js";
import type { RoleCapabilityFlags } from "$lib/stores/auth.svelte.ts";
import type {
	WorkflowTask,
	WorkflowTaskType,
	WorkspaceFeedItem,
} from "$lib/types.js";

export const WORKSPACE_RECENT_PROJECT_LIMIT = 8;
export const WORKSPACE_ATTENTION_ITEM_LIMIT = 6;
export const WORKSPACE_PROJECT_BROWSER_GROUP_LIMIT = 6;
export const WORKSPACE_PROJECT_BROWSER_PROJECT_LIMIT = 5;
export const WORKSPACE_ASSIGNED_WORK_GROUP_LIMIT = 8;
export const WORKSPACE_ASSIGNED_WORK_TASK_LIMIT = 4;

export interface WorkspaceJobLane {
	id: WorkflowTaskType;
	/** Stable task-type CODE (equals `id`); consumers localize via `$_("taskType.<code>")`. */
	label: WorkflowTaskType;
	totalCount: number;
	openCount: number;
	doneCount: number;
	urgentCount: number;
	overdueCount: number;
	assignees: string[];
	firstOpenTaskId: string | null;
	firstOpenPageIndex: number | null;
	firstOpenTaskTitle: string | null;
	nextDueAt: string | null;
}

export interface WorkspaceAssignedWorkTask {
	id: string;
	type: WorkflowTaskType;
	/** Stable task-type CODE (equals `type`); consumers localize via `$_("taskType.<code>")`. */
	typeLabel: WorkflowTaskType;
	status: string;
	priority: string;
	pageIndex: number;
	title: string;
	assignee: string | null;
	dueAt: string | null;
	overdue: boolean;
}

export interface WorkspaceAssignedWorkGroup {
	id: string;
	assignee: string | null;
	label: string;
	openCount: number;
	urgentCount: number;
	highCount: number;
	overdueCount: number;
	reviewCount: number;
	nextDueAt: string | null;
	firstOpenTaskId: string | null;
	firstOpenPageIndex: number | null;
	tasks: WorkspaceAssignedWorkTask[];
}

export interface WorkspaceDashboardStats {
	openTaskCount: number;
	doneTaskCount: number;
	urgentTaskCount: number;
	highTaskCount: number;
	overdueTaskCount: number;
	attentionFeedCount: number;
	commentCount: number;
	aiAttentionCount: number;
}

export type DashboardTaskRowAccent = "cyan" | "violet" | "amber" | "rose" | "blue";
export type DashboardTaskRowStatusClass = "soon" | "active" | "late" | "idle";

export interface DashboardTaskRow {
	id: string;
	projectId: string;
	title: string;
	lane: string;
	due: string;
	status: string;
	statusClass: DashboardTaskRowStatusClass;
	progress: number;
	icon: string;
	accent: DashboardTaskRowAccent;
}

export interface DashboardTaskRowCopy {
	dueOverdue: string;
	dueNone: string;
	statusOverdue: string;
	statusTodo: string;
	statusInProgress: string;
	taskPageLane: (page: number) => string;
	taskTypePageTitle: (type: WorkspaceHomeTask["type"], page: number) => string;
}

export interface DashboardTaskRowsOptions {
	limit?: number;
}

export interface DashboardTaskRowOpenProjectFirstContext {
	currentProjectId: () => string | null | undefined;
	openProject: (projectId: string) => Promise<boolean | void>;
	openWorkBoard: () => void;
	openWorkBoardRoute: (projectId: string) => void;
}

export interface WorkspaceInboxSummary {
	totalCount: number;
	blockerCount: number;
	urgentCount: number;
	overdueCount: number;
	reviewCount: number;
	commentCount: number;
	qcCount: number;
	aiCount: number;
}

export type WorkspaceProjectWorkState = "attention" | "review" | "active" | "ready" | "setup";

export interface WorkspaceProjectBrowserChapter {
	project: ProjectSummary;
	chapterLabel: string;
	workState: WorkspaceProjectWorkState;
	nextAction: string;
	workSignal: string;
	densityLabel: string;
	openWorkCount: number;
	reviewCount: number;
	commentCount: number;
}

/** A chapter NUMBER with all its language-track chapters (issue #14c). */
export interface WorkspaceChapterNumberGroup {
	/** Stable grouping key. */
	key: string;
	/** The shared chapter number ("12"), or null when no number could be resolved. */
	chapterNumber: string | null;
	/** Representative chapter (first track) — drives the row's identity + click. */
	primary: WorkspaceProjectBrowserChapter;
	/** Every chapter that shares this number, in input order (one per language track). */
	tracks: WorkspaceProjectBrowserChapter[];
}

/**
 * Collapse chapters that share the same chapter NUMBER into one group, so a
 * chapter localized into several languages renders as a single row with its
 * language tracks nested (issue #14c). Chapters with no resolvable number each
 * stand alone (keyed by project id) so distinct untitled chapters never merge.
 * Input order is preserved: a group sorts to its first track's position, and the
 * first track is the primary.
 */
export function groupChaptersByNumber(
	chapters: readonly WorkspaceProjectBrowserChapter[],
): WorkspaceChapterNumberGroup[] {
	const groups: WorkspaceChapterNumberGroup[] = [];
	const byKey = new Map<string, WorkspaceChapterNumberGroup>();
	for (const chapter of chapters) {
		const number = chapter.project.chapterNumber?.trim() || null;
		const key = number ? `n:${number.toLowerCase()}` : `p:${chapter.project.projectId}`;
		const existing = byKey.get(key);
		if (existing) {
			existing.tracks.push(chapter);
			continue;
		}
		const group: WorkspaceChapterNumberGroup = { key, chapterNumber: number, primary: chapter, tracks: [chapter] };
		byKey.set(key, group);
		groups.push(group);
	}
	return groups;
}

export interface WorkspaceProjectLanguageSummary {
	lang: string;
	chapterCount: number;
	pageCount: number;
	/** Real total workflow tasks across this language's chapters (honest progress denominator). */
	totalTasks: number;
	openTasks: number;
	reviewTasks: number;
	openComments: number;
}

export interface WorkspaceProjectBrowserGroup {
	/**
	 * The library URL `[titleKey]` segment for this story — a hybrid
	 * `<storyId>-<slug>` for new stable ids, or the unchanged legacy slug id for
	 * pre-migration projects. Used to BUILD links and as today's match key.
	 */
	id: string;
	/**
	 * The raw, stable story id this group is keyed by (dash-free for new stories;
	 * the legacy slug for old ones). Used to RESOLVE a story from a URL segment in
	 * a rename-robust, back-compatible way via {@link storyGroupKeyMatches}.
	 */
	storyId: string;
	title: string;
	coverProjectId: string | null;
	coverImageId?: string;
	coverOriginalName?: string;
	chapterCount: number;
	hiddenChapterCount: number;
	totalPages: number;
	totalTextLayers: number;
	totalTasks: number;
	openTasks: number;
	reviewTasks: number;
	openComments: number;
	attentionChapterCount: number;
	activeChapterCount: number;
	readyChapterCount: number;
	nextAction: string;
	targetLangs: string[];
	languageSummaries: WorkspaceProjectLanguageSummary[];
	latestUpdatedAt: string;
	projects: ProjectSummary[];
	chapters: WorkspaceProjectBrowserChapter[];
}

/**
 * The chapter-label prefix word ("ตอน" in Thai, "Ch."/"Episode" elsewhere).
 *
 * Stored chapter data on disk is Thai-prefixed (`ตอน 1 - …`) and the parsing
 * regexes in this module ALWAYS keep accepting that Thai stored form — only the
 * DISPLAY prefix is localized. Callers pass the locale-resolved prefix; the
 * default is the Thai prefix so TH behaviour and every existing test stay
 * byte-identical without a prefix argument.
 */
export const DEFAULT_CHAPTER_LABEL_PREFIX = "ตอน";

const TASK_TYPE_ORDER: readonly WorkflowTaskType[] = ["translate", "clean", "typeset", "review"];
const TASK_TYPE_CAPABILITY: Record<WorkflowTaskType, keyof RoleCapabilityFlags> = {
	translate: "canTranslate",
	clean: "canClean",
	typeset: "canTypeset",
	review: "canReviewQC",
};

/**
 * The STABLE task-type CODE used as the localization key. The code IS the
 * `WorkflowTaskType` itself; consumers map it via `$_("taskType.<code>")`.
 * (Was a Thai `TASK_TYPE_LABELS` lookup; now framework-agnostic — see the codes
 * pattern in merged PRs #483-488/#492/#493.)
 */
export function workspaceTaskTypeLabel(type: WorkflowTaskType): WorkflowTaskType {
	return type;
}

function homeTaskAccentByType(task: WorkspaceHomeTask): DashboardTaskRowAccent {
	if (task.dueState === "overdue") return "rose";
	if (task.priority === "urgent") return "amber";
	if (task.type === "review") return "blue";
	if (task.type === "translate") return "cyan";
	if (task.type === "clean") return "violet";
	return "blue";
}

function homeTaskProgress(task: WorkspaceHomeTask): number {
	if (task.dueState === "overdue") return 20;
	if (task.status === "review") return 70;
	if (task.status === "todo") return 0;
	if (task.priority === "urgent") return 55;
	return 45;
}

export function buildDashboardTaskRows(
	tasks: readonly WorkspaceHomeTask[],
	copy: DashboardTaskRowCopy,
	options: DashboardTaskRowsOptions = {},
): DashboardTaskRow[] {
	const safeLimit = options.limit === undefined
		? tasks.length
		: Math.max(0, Math.floor(options.limit));

	// KEYSTONE: My-Work rows come from the cross-project workspace-home aggregate
	// only. Each row carries its own project/chapter context, so dashboard and
	// /tasks can share the same display model without falling back to the open
	// chapter's local task list.
	return tasks.slice(0, safeLimit).map((task): DashboardTaskRow => {
		const overdue = task.dueState === "overdue";
		const chapter = task.chapterLabel?.trim();
		const story = task.storyTitle?.trim() || task.projectName;
		const lane = [
			story,
			chapter,
			copy.taskPageLane(task.pageIndex + 1),
		].filter(Boolean).join(" · ");
		return {
			id: `${task.projectId}:${task.id}`,
			projectId: task.projectId,
			title: task.title || copy.taskTypePageTitle(task.type, task.pageIndex + 1),
			lane,
			due: overdue ? copy.dueOverdue : task.dueAt ? formatWorkflowDueDay(task.dueAt) : copy.dueNone,
			status: overdue ? copy.statusOverdue : task.status === "todo" ? copy.statusTodo : copy.statusInProgress,
			statusClass: overdue ? "late" : task.status === "todo" ? "idle" : "active",
			progress: homeTaskProgress(task),
			icon: task.type === "review" ? "✓" : task.type === "translate" ? "T" : task.type === "clean" ? "✦" : "↗",
			accent: homeTaskAccentByType(task),
		};
	});
}

export async function openDashboardTaskRowProjectFirst(
	row: DashboardTaskRow,
	context: DashboardTaskRowOpenProjectFirstContext,
): Promise<boolean> {
	// Cross-project task rows must open their own project before surfacing the
	// work board; otherwise a row can silently no-op or land on the wrong chapter.
	if (context.currentProjectId() !== row.projectId) {
		const opened = await context.openProject(row.projectId);
		if (opened === false) return false;
	}
	context.openWorkBoard();
	context.openWorkBoardRoute(row.projectId);
	return true;
}

function compareWorkspaceLaneTasks(a: WorkflowTask, b: WorkflowTask): number {
	const overdueDelta = Number(isWorkflowTaskOverdue(b)) - Number(isWorkflowTaskOverdue(a));
	if (overdueDelta !== 0) return overdueDelta;

	const priorityDelta = workflowTaskPriorityRank(a.priority) - workflowTaskPriorityRank(b.priority);
	if (priorityDelta !== 0) return priorityDelta;

	const aDue = parseWorkflowTaskDueTime(a.dueAt) ?? Number.POSITIVE_INFINITY;
	const bDue = parseWorkflowTaskDueTime(b.dueAt) ?? Number.POSITIVE_INFINITY;
	if (aDue !== bDue) return aDue - bDue;

	if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
	return a.title.localeCompare(b.title);
}

export function workflowTaskTypeAllowedByCapabilities(type: WorkflowTaskType, capabilities?: RoleCapabilityFlags | null): boolean {
	if (!capabilities) return true;
	return Boolean(capabilities[TASK_TYPE_CAPABILITY[type]]);
}

export function buildWorkspaceJobLanes(tasks: readonly WorkflowTask[], capabilities?: RoleCapabilityFlags | null): WorkspaceJobLane[] {
	return TASK_TYPE_ORDER.filter((type) => workflowTaskTypeAllowedByCapabilities(type, capabilities)).map((type) => {
		const laneTasks = tasks.filter((task) => task.type === type);
		const openTasks = laneTasks.filter(isWorkflowTaskOpen);
		const assignees = new Set<string>();
		const orderedOpenTasks = [...openTasks].sort(compareWorkspaceLaneTasks);
		const firstOpenTask = orderedOpenTasks[0] ?? null;
		const nextDueAt = orderedOpenTasks
			.map((task) => task.dueAt)
			.filter((dueAt): dueAt is string => Boolean(dueAt))
			.sort((a, b) => (parseWorkflowTaskDueTime(a) ?? Number.POSITIVE_INFINITY) - (parseWorkflowTaskDueTime(b) ?? Number.POSITIVE_INFINITY))[0] ?? null;

		for (const task of laneTasks) {
			const assignee = normalizeAssigneeHandle(task.assignee);
			if (assignee) assignees.add(assignee);
		}

		return {
			id: type,
			// The lane label is the stable task-type CODE (same value as `id`).
			// Consumers localize it via `$_("taskType.<code>")`; see WorkspaceJobLanes.
			label: type,
			totalCount: laneTasks.length,
			openCount: openTasks.length,
			doneCount: laneTasks.filter((task) => task.status === "done").length,
			urgentCount: openTasks.filter((task) => task.priority === "urgent").length,
			overdueCount: openTasks.filter((task) => isWorkflowTaskOverdue(task)).length,
			assignees: [...assignees].sort((a, b) => a.localeCompare(b)),
			firstOpenTaskId: firstOpenTask?.id ?? null,
			firstOpenPageIndex: firstOpenTask?.pageIndex ?? null,
			firstOpenTaskTitle: firstOpenTask?.title ?? null,
			nextDueAt,
		};
	});
}

function assignedWorkGroupId(assignee: string | null): string {
	return assignee ? `assignee-${assignee.toLowerCase()}` : "unassigned";
}

function compareAssignedWorkGroups(
	a: WorkspaceAssignedWorkGroup,
	b: WorkspaceAssignedWorkGroup,
): number {
	const overdueDelta = b.overdueCount - a.overdueCount;
	if (overdueDelta !== 0) return overdueDelta;

	const urgentDelta = b.urgentCount - a.urgentCount;
	if (urgentDelta !== 0) return urgentDelta;

	const highDelta = b.highCount - a.highCount;
	if (highDelta !== 0) return highDelta;

	const aDue = parseWorkflowTaskDueTime(a.nextDueAt ?? undefined) ?? Number.POSITIVE_INFINITY;
	const bDue = parseWorkflowTaskDueTime(b.nextDueAt ?? undefined) ?? Number.POSITIVE_INFINITY;
	if (aDue !== bDue) return aDue - bDue;

	const unassignedDelta = Number(a.assignee === null) - Number(b.assignee === null);
	if (unassignedDelta !== 0) return unassignedDelta;

	const openDelta = b.openCount - a.openCount;
	if (openDelta !== 0) return openDelta;

	return a.label.localeCompare(b.label);
}

export function buildWorkspaceAssignedWork(
	tasks: readonly WorkflowTask[],
	groupLimit = WORKSPACE_ASSIGNED_WORK_GROUP_LIMIT,
	taskLimit = WORKSPACE_ASSIGNED_WORK_TASK_LIMIT,
): WorkspaceAssignedWorkGroup[] {
	const groups = new Map<string, { assignee: string | null; tasks: WorkflowTask[] }>();
	for (const task of tasks) {
		if (!isWorkflowTaskOpen(task)) continue;
		const assignee = normalizeAssigneeHandle(task.assignee);
		const groupId = assignedWorkGroupId(assignee);
		const group = groups.get(groupId) ?? { assignee, tasks: [] };
		group.tasks = [...group.tasks, task];
		groups.set(groupId, group);
	}

	const safeGroupLimit = Math.max(0, Math.floor(groupLimit));
	const safeTaskLimit = Math.max(0, Math.floor(taskLimit));

	return [...groups.entries()]
		.map(([id, group]): WorkspaceAssignedWorkGroup => {
			const orderedTasks = [...group.tasks].sort(compareWorkspaceLaneTasks);
			const firstOpenTask = orderedTasks[0] ?? null;
			const nextDueAt = orderedTasks
				.map((task) => task.dueAt)
				.filter((dueAt): dueAt is string => Boolean(dueAt))
				.sort((a, b) => (parseWorkflowTaskDueTime(a) ?? Number.POSITIVE_INFINITY) - (parseWorkflowTaskDueTime(b) ?? Number.POSITIVE_INFINITY))[0] ?? null;

			return {
				id,
				assignee: group.assignee,
				label: formatAssigneeHandle(group.assignee, "Unassigned queue"),
				openCount: orderedTasks.length,
				urgentCount: orderedTasks.filter((task) => task.priority === "urgent").length,
				highCount: orderedTasks.filter((task) => task.priority === "high").length,
				overdueCount: orderedTasks.filter((task) => isWorkflowTaskOverdue(task)).length,
				reviewCount: orderedTasks.filter((task) => task.status === "review" || task.type === "review").length,
				nextDueAt,
				firstOpenTaskId: firstOpenTask?.id ?? null,
				firstOpenPageIndex: firstOpenTask?.pageIndex ?? null,
				tasks: orderedTasks.slice(0, safeTaskLimit).map((task) => ({
					id: task.id,
					type: task.type,
					typeLabel: workspaceTaskTypeLabel(task.type),
					status: task.status,
					priority: task.priority,
					pageIndex: task.pageIndex,
					title: task.title,
					assignee: normalizeAssigneeHandle(task.assignee),
					dueAt: task.dueAt ?? null,
					overdue: isWorkflowTaskOverdue(task),
				})),
			};
		})
		.sort(compareAssignedWorkGroups)
		.slice(0, safeGroupLimit);
}

export function buildWorkspaceDashboardStats(
	tasks: readonly WorkflowTask[],
	workspaceFeed: readonly WorkspaceFeedItem[],
): WorkspaceDashboardStats {
	const openTasks = tasks.filter(isWorkflowTaskOpen);
	return {
		openTaskCount: openTasks.length,
		doneTaskCount: tasks.filter((task) => task.status === "done").length,
		urgentTaskCount: openTasks.filter((task) => task.priority === "urgent").length,
		highTaskCount: openTasks.filter((task) => task.priority === "high").length,
		overdueTaskCount: openTasks.filter((task) => isWorkflowTaskOverdue(task)).length,
		attentionFeedCount: workspaceFeed.filter(isWorkspaceFeedAttention).length,
		commentCount: workspaceFeed.filter((item) => item.kind === "comment").length,
		aiAttentionCount: workspaceFeed.filter((item) => item.kind === "ai_marker" && item.severity !== "info").length,
	};
}

export function buildWorkspaceInboxSummary(items: readonly WorkInboxItem[]): WorkspaceInboxSummary {
	return {
		totalCount: items.length,
		blockerCount: items.filter((item) => item.severity === "error").length,
		urgentCount: items.filter((item) => item.priority === "urgent").length,
		overdueCount: items.filter((item) => item.overdue).length,
		reviewCount: items.filter((item) => item.kind === "review_task").length,
		commentCount: items.filter((item) => item.kind === "comment").length,
		qcCount: items.filter((item) => item.kind === "qc").length,
		aiCount: items.filter((item) => item.kind === "ai_marker").length,
	};
}

export function getWorkspaceAttentionItems(
	items: readonly WorkInboxItem[],
	limit = WORKSPACE_ATTENTION_ITEM_LIMIT,
): WorkInboxItem[] {
	const safeLimit = Math.max(0, Math.floor(limit));
	return items.slice(0, safeLimit);
}

export function formatAssigneeSummary(assignees: readonly string[]): string {
	const normalized = assignees
		.map((assignee) => normalizeAssigneeHandle(assignee))
		.filter((assignee): assignee is string => Boolean(assignee));
	if (normalized.length === 0) return "Unassigned";
	if (normalized.length <= 2) return normalized.map((assignee) => formatAssigneeHandle(assignee)).join(", ");
	return `${normalized.slice(0, 2).map((assignee) => formatAssigneeHandle(assignee)).join(", ")} +${normalized.length - 2}`;
}

export function getWorkspaceRecentProjects(
	projects: readonly ProjectSummary[],
	limit = WORKSPACE_RECENT_PROJECT_LIMIT,
): ProjectSummary[] {
	const safeLimit = Math.max(0, Math.floor(limit));
	return projects.slice(0, safeLimit);
}

/**
 * Story "family" name (the project name with chapter/hash suffixes stripped). For a
 * project with no usable name this returns `""` (not a rendered Thai string), so the
 * consumer localizes the empty case via `$_("library.untitledStory")`. Grouping/ID
 * derivation (`groupIdFromTitle`) already maps the empty/non-Latin title to a stable
 * `untitled-<hash>` key, so untitled projects keep grouping together.
 */
export function getWorkspaceProjectFamilyName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "";
	const withoutHash = trimmed.replace(/\s+#?[0-9a-f]{6,}$/i, "").trim();
	const withoutChapterSuffix = withoutHash
		.replace(/\s*[-–—]?\s*(chapter|ch\.?|episode|ep\.?|ตอน)\s*[:#-]?\s*\d+.*$/i, "")
		.replace(/\s+[#-]?\d{1,4}$/i, "")
		.trim();
	return withoutChapterSuffix || withoutHash || trimmed;
}

export function getWorkspaceProjectChapterLabel(
	name: string,
	prefix: string = DEFAULT_CHAPTER_LABEL_PREFIX,
): string {
	// Parsing ALWAYS accepts the Thai stored form (`ตอน …`) so existing on-disk
	// data keeps resolving; only the emitted `prefix` is localized.
	const trimmed = name.trim().replace(/\s+#?[0-9a-f]{6,}$/i, "");
	const thaiExplicit = trimmed.match(/(?:^|\s)ตอน\s*[:#-]?\s*(\d+(?:\.\d+)?[a-z]?)/i);
	if (thaiExplicit) {
		return `${prefix} ${thaiExplicit[1]}`;
	}
	const explicit = trimmed.match(/\b(chapter|ch\.?|episode|ep\.?)\s*[:#-]?\s*(\d+(?:\.\d+)?[a-z]?)\b/i);
	if (explicit) {
		return `${prefix} ${explicit[2]}`;
	}

	const trailing = trimmed.match(/(?:^|\s)[#-]?(\d{1,4}[a-z]?)$/i);
	if (trailing) return `${prefix} ${trailing[1]}`;
	return prefix;
}

export function getWorkspaceProjectStoryTitle(project: ProjectSummary): string {
	const explicit = project.storyTitle?.trim();
	if (explicit) return explicit;
	return getWorkspaceProjectFamilyName(formatRecentProjectName(project));
}

/**
 * The exact string the DELETE /project/:id confirmation must echo for THIS chapter
 * project. It mirrors the backend rule verbatim — `(state.storyTitle ?? state.name
 * ?? "").trim()` (backend/src/routes/project.ts) — NOT the family-stripped group
 * DISPLAY title.
 *
 * Why this matters: the library story-delete iterates every chapter and previously
 * sent the GROUP's display title (a chapter-suffix-stripped, possibly-localized
 * name). For a chapter with NO `storyTitle` whose `name` carries a chapter suffix
 * (e.g. `"เรื่องเอ - ตอน 1"`, the shape the setup dialog persists), the group title
 * (`"เรื่องเอ"`) NEVER equals the backend's expected full `name` → the story was
 * permanently undeletable. Sending each chapter's own canonical title fixes that
 * while keeping the type-to-confirm a pure UI gate (an empty value still 400s).
 */
export function getWorkspaceProjectDeleteConfirmTitle(project: ProjectSummary): string {
	return (project.storyTitle ?? project.name ?? "").trim();
}

export function getWorkspaceProjectStoryId(project: ProjectSummary): string {
	const explicit = project.storyId?.trim();
	if (explicit) return explicit;
	return groupIdFromTitle(getWorkspaceProjectStoryTitle(project));
}

/**
 * The MAP key story shelves are grouped under. It namespaces the raw `storyId`
 * by the project's `workspaceId` so two DIFFERENT workspaces that happen to share
 * a `storyId` (e.g. an imported/duplicated id) never merge into one shelf
 * (cross-workspace isolation). The listing is already workspace-scoped at the API,
 * so this is defense-in-depth; it also keeps a mixed (personal + workspace) list
 * — should one ever be passed — correctly partitioned. The group's exposed
 * `storyId`/URL `id` stay the raw, un-namespaced story id.
 */
function workspaceProjectGroupKey(project: ProjectSummary): string {
	const storyId = getWorkspaceProjectStoryId(project);
	const workspaceId = project.workspaceId?.trim();
	return workspaceId ? `${workspaceId}::${storyId}` : storyId;
}

/**
 * Re-prefix a stored chapter label for DISPLAY in the active locale.
 *
 * Stored labels are Thai-prefixed (`ตอน 12 - Title`). For display we swap a
 * LEADING Thai `ตอน` prefix for the locale prefix while leaving the rest of the
 * label (chapter number + title text) untouched. A label without the Thai
 * prefix (already localized or free-form) is returned verbatim.
 */
function localizeStoredChapterLabel(label: string, prefix: string): string {
	if (prefix === DEFAULT_CHAPTER_LABEL_PREFIX) return label;
	const match = label.match(/^ตอน(\b|\s|$)/);
	if (!match) return label;
	return `${prefix}${label.slice("ตอน".length)}`;
}

export function getWorkspaceProjectChapterDisplayLabel(
	project: ProjectSummary,
	prefix: string = DEFAULT_CHAPTER_LABEL_PREFIX,
): string {
	const explicit = project.chapterLabel?.trim();
	if (explicit) return localizeStoredChapterLabel(explicit, prefix);
	const number = project.chapterNumber?.trim();
	const title = project.chapterTitle?.trim();
	if (number || title) {
		const numberLabel = number ? `${prefix} ${number}` : "";
		return [numberLabel, title].filter(Boolean).join(" - ") || prefix;
	}
	return getWorkspaceProjectChapterLabel(formatRecentProjectName(project), prefix);
}

function getWorkspaceProjectChapterSortValue(project: ProjectSummary): number | null {
	const explicit = project.chapterNumber?.trim();
	if (explicit) {
		const parsed = Number(explicit.match(/\d+(?:\.\d+)?/)?.[0]);
		if (Number.isFinite(parsed)) return parsed;
	}
	const label = getWorkspaceProjectChapterDisplayLabel(project);
	const value = label.match(/(\d+(?:\.\d+)?)/)?.[1];
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Small, deterministic, ASCII (base-36) hash of an arbitrary title. Used ONLY to
 * disambiguate titles whose Latin slug is empty — most importantly non-Latin
 * (Thai) titles, every one of which otherwise slugs to nothing and would collide
 * under the single `"untitled"` id. FNV-1a over the raw code points; not
 * security-sensitive.
 */
function titleHash(title: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < title.length; index += 1) {
		hash ^= title.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function groupIdFromTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	// A Latin slug stays byte-identical to the legacy behaviour so existing
	// (un-migrated) library URLs keep resolving. Only when the slug collapses to ""
	// — every non-Latin (e.g. Thai) title — do we fall back to a per-title hash so
	// distinct Thai stories no longer all merge under one `"untitled"` group.
	if (slug) return slug;
	return `untitled-${titleHash(title.trim())}`;
}

function projectUpdatedTime(project: Pick<ProjectSummary, "updatedAt">): number {
	const time = new Date(project.updatedAt).getTime();
	return Number.isFinite(time) ? time : 0;
}

function compareProjectUpdatedAt(a: ProjectSummary, b: ProjectSummary): number {
	return projectUpdatedTime(b) - projectUpdatedTime(a);
}

function compareProjectGroups(a: WorkspaceProjectBrowserGroup, b: WorkspaceProjectBrowserGroup): number {
	const updatedDelta = projectUpdatedTime({ updatedAt: b.latestUpdatedAt }) - projectUpdatedTime({ updatedAt: a.latestUpdatedAt });
	if (updatedDelta !== 0) return updatedDelta;
	return a.title.localeCompare(b.title);
}

/**
 * The effective set of Language Tracks a SINGLE project carries.
 *
 * Per-language model (PR-6+): a project may declare `targetLangs` (e.g.
 * `["th","en"]`) so one project row surfaces multiple languages. We de-dupe and
 * always include `targetLang` so a legacy project (no `targetLangs`, or one that
 * already matches `targetLang`) resolves to exactly `[targetLang]` — identical to
 * the pre-per-language behaviour. The result is order-preserving with the default
 * lang guaranteed present (`"unknown"` only when the project declares no lang at
 * all). Mirrors the backend `normalizeTargetLangs` contract.
 */
function projectLanguageTracks(project: ProjectSummary): string[] {
	const seen = new Set<string>();
	const tracks: string[] = [];
	const add = (value: string | undefined | null) => {
		const lang = value?.trim();
		if (!lang || seen.has(lang)) return;
		seen.add(lang);
		tracks.push(lang);
	};
	add(project.targetLang);
	for (const lang of project.targetLangs ?? []) add(lang);
	if (tracks.length === 0) add("unknown");
	return tracks;
}

/**
 * Per-language roll-up for a title group.
 *
 * Each project contributes its chapter/page/task counts ONCE PER declared track
 * (see {@link projectLanguageTracks}). This means:
 *  - A single project declaring `targetLangs: ["th","en"]` surfaces BOTH a `th`
 *    and an `en` summary even though it is one project row.
 *  - Legacy sibling-per-language families (one project per language) still bucket
 *    by their single `targetLang` exactly as before.
 *  - A project never lands in the same language bucket twice (tracks are de-duped
 *    per project), so a language that shows up as both a sibling project AND in
 *    another project's `targetLangs` is honestly counted — one chapter per
 *    contributing project, never double.
 */
function buildWorkspaceProjectLanguageSummaries(projects: readonly ProjectSummary[]): WorkspaceProjectLanguageSummary[] {
	const byLang = new Map<string, WorkspaceProjectLanguageSummary>();
	for (const project of projects) {
		for (const lang of projectLanguageTracks(project)) {
			const current = byLang.get(lang) ?? {
				lang,
				chapterCount: 0,
				pageCount: 0,
				totalTasks: 0,
				openTasks: 0,
				reviewTasks: 0,
				openComments: 0,
			};
			current.chapterCount += 1;
			current.pageCount += project.pageCount;
			current.totalTasks += project.taskCount ?? 0;
			current.openTasks += project.openTaskCount ?? 0;
			current.reviewTasks += project.reviewTaskCount ?? 0;
			current.openComments += project.openCommentCount ?? 0;
			byLang.set(lang, current);
		}
	}
	return [...byLang.values()].sort((a, b) => a.lang.localeCompare(b.lang));
}

function compareProjectChapters(a: ProjectSummary, b: ProjectSummary): number {
	const aName = formatRecentProjectName(a);
	const bName = formatRecentProjectName(b);
	const aChapter = getWorkspaceProjectChapterSortValue(a);
	const bChapter = getWorkspaceProjectChapterSortValue(b);
	if (aChapter !== null && bChapter !== null && aChapter !== bChapter) return aChapter - bChapter;
	if (aChapter !== null && bChapter === null) return -1;
	if (aChapter === null && bChapter !== null) return 1;

	const updatedDelta = compareProjectUpdatedAt(a, b);
	if (updatedDelta !== 0) return updatedDelta;
	return aName.localeCompare(bName);
}

function projectWorkSignalLabel(project: ProjectSummary): string {
	const parts: string[] = [];
	if (project.openTaskCount) parts.push(`${project.openTaskCount} open jobs`);
	if (project.reviewTaskCount) parts.push(`${project.reviewTaskCount} review`);
	if (project.openCommentCount) parts.push(`${project.openCommentCount} comments`);
	return parts.length ? parts.join(" / ") : "Clear queue";
}

function projectWorkState(project: ProjectSummary): WorkspaceProjectWorkState {
	if ((project.openCommentCount ?? 0) > 0) return "attention";
	if ((project.reviewTaskCount ?? 0) > 0) return "review";
	if ((project.openTaskCount ?? 0) > 0) return "active";
	if ((project.taskCount ?? 0) > 0 || project.textLayerCount > 0) return "ready";
	return "setup";
}

function projectNextAction(project: ProjectSummary): string {
	if ((project.openCommentCount ?? 0) > 0 && (project.reviewTaskCount ?? 0) > 0) {
		return "Resolve review comments";
	}
	if ((project.openCommentCount ?? 0) > 0) return "Resolve comments";
	if ((project.reviewTaskCount ?? 0) > 0) return "Review queued pages";
	if ((project.openTaskCount ?? 0) > 0) return "Continue production jobs";
	if ((project.taskCount ?? 0) > 0) return "Ready for export check";
	if (project.textLayerCount > 0) return "Create workflow tasks";
	return "Import pages or layers";
}

function projectDensityLabel(project: ProjectSummary): string {
	const pageCount = Math.max(0, project.pageCount);
	const openWork = (project.openTaskCount ?? 0) + (project.openCommentCount ?? 0);
	if (pageCount === 0) return "No pages";
	if (openWork === 0) return `${pageCount} pages clear`;
	const density = openWork / pageCount;
	if (density >= 1) return "Heavy queue";
	if (density >= 0.35) return "Moderate queue";
	return "Light queue";
}

function getProjectCoverImageId(project: ProjectSummary): string | undefined {
	return project.coverImageId;
}

function buildWorkspaceProjectBrowserChapter(
	project: ProjectSummary,
	prefix: string = DEFAULT_CHAPTER_LABEL_PREFIX,
): WorkspaceProjectBrowserChapter {
	return {
		project,
		chapterLabel: getWorkspaceProjectChapterDisplayLabel(project, prefix),
		workState: projectWorkState(project),
		nextAction: projectNextAction(project),
		workSignal: projectWorkSignalLabel(project),
		densityLabel: projectDensityLabel(project),
		openWorkCount: project.openTaskCount ?? 0,
		reviewCount: project.reviewTaskCount ?? 0,
		commentCount: project.openCommentCount ?? 0,
	};
}

function compareProjectBrowserChapters(
	a: WorkspaceProjectBrowserChapter,
	b: WorkspaceProjectBrowserChapter,
): number {
	return compareProjectChapters(a.project, b.project);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function disambiguateFallbackChapterLabels(
	chapters: readonly WorkspaceProjectBrowserChapter[],
	prefix: string = DEFAULT_CHAPTER_LABEL_PREFIX,
): WorkspaceProjectBrowserChapter[] {
	const fallbackCount = chapters.filter((chapter) => chapter.chapterLabel === prefix).length;
	if (fallbackCount <= 1) return [...chapters];
	const numberedFallback = new RegExp(`^${escapeRegExp(prefix)}\\s+(\\d+)$`, "i");
	const usedChapterNumbers = new Set(
		chapters
			.map((chapter) => chapter.chapterLabel.match(numberedFallback)?.[1])
			.filter((value): value is string => Boolean(value))
			.map((value) => Number(value)),
	);
	let nextFallbackNumber = 1;
	return chapters.map((chapter) => {
		if (chapter.chapterLabel !== prefix) return chapter;
		while (usedChapterNumbers.has(nextFallbackNumber)) nextFallbackNumber += 1;
		const labelNumber = nextFallbackNumber;
		usedChapterNumbers.add(labelNumber);
		nextFallbackNumber += 1;
		return { ...chapter, chapterLabel: `${prefix} ${labelNumber}` };
	});
}

function groupNextAction(group: WorkspaceProjectBrowserGroup): string {
	if (group.openComments > 0) return "Resolve chapter comments";
	if (group.reviewTasks > 0) return "Review chapter queue";
	if (group.openTasks > 0) return "Continue open jobs";
	if (group.totalTasks > 0) return "Check export readiness";
	if (group.totalTextLayers > 0) return "Plan workflow tasks";
	return "Set up chapters";
}

export function buildWorkspaceProjectBrowser(
	projects: readonly ProjectSummary[],
	groupLimit = WORKSPACE_PROJECT_BROWSER_GROUP_LIMIT,
	projectLimit = WORKSPACE_PROJECT_BROWSER_PROJECT_LIMIT,
	chapterLabelPrefix: string = DEFAULT_CHAPTER_LABEL_PREFIX,
): WorkspaceProjectBrowserGroup[] {
	const groups = new Map<string, WorkspaceProjectBrowserGroup>();
	const safeProjectLimit = Math.max(0, Math.floor(projectLimit));
	for (const project of projects) {
		const title = getWorkspaceProjectStoryTitle(project);
		// Group by the STABLE story id (the real key) NAMESPACED by workspace, so
		// the same storyId in two workspaces does not merge into one shelf. The
		// exposed `id`/`storyId` stay the RAW story id — only the lookup key carries
		// the workspace prefix. Expose a hybrid `<storyId>-<slug>` segment as `id`
		// for readable, rename-robust URLs. Legacy slug-based ids carry dashes and
		// pass through unchanged.
		const storyId = getWorkspaceProjectStoryId(project);
		const groupKey = workspaceProjectGroupKey(project);
		const id = buildStoryTitleKey(storyId, title);
		const group = groups.get(groupKey) ?? {
			id,
			storyId,
			title,
			coverProjectId: project.projectId,
			coverImageId: getProjectCoverImageId(project),
			coverOriginalName: project.coverOriginalName,
			chapterCount: 0,
			hiddenChapterCount: 0,
			totalPages: 0,
			totalTextLayers: 0,
			totalTasks: 0,
			openTasks: 0,
			reviewTasks: 0,
			openComments: 0,
			attentionChapterCount: 0,
			activeChapterCount: 0,
			readyChapterCount: 0,
			nextAction: "Set up chapters",
			targetLangs: [],
			languageSummaries: [],
			latestUpdatedAt: project.updatedAt,
			projects: [],
			chapters: [],
		};
		const chapter = buildWorkspaceProjectBrowserChapter(project, chapterLabelPrefix);
		if (!group.coverImageId && getProjectCoverImageId(project)) {
			group.coverProjectId = project.projectId;
			group.coverImageId = getProjectCoverImageId(project);
			group.coverOriginalName = project.coverOriginalName;
		}
		group.chapterCount += 1;
		group.totalPages += project.pageCount;
		group.totalTextLayers += project.textLayerCount;
		group.totalTasks += project.taskCount ?? 0;
		group.openTasks += project.openTaskCount ?? 0;
		group.reviewTasks += project.reviewTaskCount ?? 0;
		group.openComments += project.openCommentCount ?? 0;
		if (chapter.workState === "attention" || chapter.workState === "review") group.attentionChapterCount += 1;
		if (chapter.workState === "active") group.activeChapterCount += 1;
		if (chapter.workState === "ready") group.readyChapterCount += 1;
		if (projectUpdatedTime(project) > projectUpdatedTime({ updatedAt: group.latestUpdatedAt })) {
			group.latestUpdatedAt = project.updatedAt;
		}
		// Per-language model: a single project can declare multiple `targetLangs`,
		// so a title surfaces every language any of its projects carries — merged
		// with (and de-duped against) sibling-per-language chapters.
		const newLangs = projectLanguageTracks(project).filter((lang) => !group.targetLangs.includes(lang));
		if (newLangs.length > 0) {
			group.targetLangs = [...group.targetLangs, ...newLangs].sort((a, b) => a.localeCompare(b));
		}
		group.projects = [...group.projects, project].sort(compareProjectChapters);
		group.languageSummaries = buildWorkspaceProjectLanguageSummaries(group.projects);
		group.chapters = [...group.chapters, chapter].sort(compareProjectBrowserChapters);
		group.hiddenChapterCount = Math.max(0, group.chapterCount - Math.min(group.chapterCount, safeProjectLimit));
		group.nextAction = groupNextAction(group);
		groups.set(groupKey, group);
	}

	const safeGroupLimit = Math.max(0, Math.floor(groupLimit));
	return [...groups.values()].sort(compareProjectGroups).slice(0, safeGroupLimit).map((group) => ({
		...group,
		chapters: disambiguateFallbackChapterLabels(group.chapters, chapterLabelPrefix),
	}));
}
