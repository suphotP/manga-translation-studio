import type {
	ActivityEvent,
	AiReviewMarker,
	PageReviewDecision,
	PageState,
	ProjectComment,
	ProjectState,
	WorkflowTask,
	WorkflowTaskType,
	WorkspaceMessage,
} from "../types/index.js";

/**
 * Server-side page-reorder remap.
 *
 * The general project save (`POST /project/:id/save`) treats the dedicated-
 * endpoint-owned sub-collections (tasks/activityLog/comments/aiReviewMarkers/
 * reviewDecisions/workspaceMessages) as SERVER-AUTHORITATIVE: it keeps the
 * persisted `state.x` and ignores whatever (possibly stale) full arrays the
 * client sent, so a general save can never silently clobber a concurrent change
 * made through a dedicated endpoint.
 *
 * The ONE legitimate way a general save mutates these collections is a page
 * reorder: the client reorders `state.pages` and saves, and every page-linked
 * record (keyed by `pageIndex`, and for tasks by the `page-<idx>-<type>` id and
 * "<Label> page <n>" title) must follow its page to the new index. Because the
 * save handler no longer trusts the client's arrays, that remap must happen
 * SERVER-SIDE here: derive the old→new page-index permutation from the page
 * order alone, then apply it to the persisted collections.
 *
 * This mirrors the frontend `remapPageLinkedState` / `page-operations.ts` rules
 * exactly (tasks, activity, comments, AI markers, review decisions, workspace
 * messages), so the in-memory store and the persisted state agree after a
 * reorder. We deliberately do NOT remap `versionReviewRequests` (not page-
 * linked) or `exportRuns` (historical records of what was exported), matching
 * the frontend, which leaves both untouched.
 */

const PAGE_TASK_ID_RE = /^page-(\d+)-(translate|clean|typeset|review)(-.+)?$/;
const WORKFLOW_TASK_LABELS: Record<WorkflowTaskType, string> = {
	translate: "Translate",
	clean: "Clean",
	typeset: "Typeset",
	review: "Review",
};

/**
 * A permutation of page indexes: `indexMap[oldIndex] === newIndex`. Identity
 * (`changed === false`) when the persisted and incoming page orders match, in
 * which case callers skip the remap entirely.
 */
export interface PageReorderPlan {
	indexMap: Record<number, number>;
	changed: boolean;
}

const IDENTITY_PLAN: PageReorderPlan = { indexMap: {}, changed: false };

function pageIdentity(page: PageState | undefined): string | undefined {
	const id = page?.imageId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Derive the old→new page-index permutation by matching pages across the two
 * orders by their stable `imageId`. Returns an identity plan (changed: false)
 * unless BOTH orders are the same multiset of unique imageIds in a DIFFERENT
 * order — i.e. a pure reorder. Page add/remove (different imageId sets) or
 * non-unique imageIds yield no plan, so the save handler simply preserves the
 * persisted collections verbatim (the dedicated endpoints / page add-remove
 * flows own those cases) rather than risk a wrong remap.
 */
export function derivePageReorderPlan(
	previousPages: readonly PageState[] | undefined,
	nextPages: readonly PageState[] | undefined,
): PageReorderPlan {
	const prev = previousPages ?? [];
	const next = nextPages ?? [];
	if (prev.length === 0 || prev.length !== next.length) return IDENTITY_PLAN;

	const prevIds = prev.map(pageIdentity);
	const nextIds = next.map(pageIdentity);
	if (prevIds.some((id) => id === undefined) || nextIds.some((id) => id === undefined)) {
		return IDENTITY_PLAN;
	}

	// Require unique ids in BOTH orders so the match is unambiguous.
	if (new Set(prevIds).size !== prevIds.length || new Set(nextIds).size !== nextIds.length) {
		return IDENTITY_PLAN;
	}

	const nextIndexById = new Map<string, number>();
	next.forEach((page, index) => {
		nextIndexById.set(pageIdentity(page) as string, index);
	});

	const indexMap: Record<number, number> = {};
	let changed = false;
	for (let oldIndex = 0; oldIndex < prev.length; oldIndex += 1) {
		const newIndex = nextIndexById.get(pageIdentity(prev[oldIndex]) as string);
		// Same multiset asserted above, so every old id resolves to a new index.
		if (newIndex === undefined) return IDENTITY_PLAN;
		indexMap[oldIndex] = newIndex;
		if (newIndex !== oldIndex) changed = true;
	}

	return { indexMap, changed };
}

function remapIndex(pageIndex: number, plan: PageReorderPlan): number {
	return plan.indexMap[pageIndex] ?? pageIndex;
}

function remapOptionalIndex(pageIndex: number | undefined, plan: PageReorderPlan): number | undefined {
	return pageIndex === undefined ? undefined : remapIndex(pageIndex, plan);
}

function remapTaskId(taskId: string | undefined, plan: PageReorderPlan): string | undefined {
	if (taskId === undefined) return undefined;
	const match = taskId.match(PAGE_TASK_ID_RE);
	if (!match) return taskId;
	const oldPageIndex = Number(match[1]);
	if (!Number.isInteger(oldPageIndex)) return taskId;
	const nextPageIndex = remapIndex(oldPageIndex, plan);
	return `page-${nextPageIndex}-${match[2]}${match[3] ?? ""}`;
}

function remapTaskIds(taskIds: string[] | undefined, plan: PageReorderPlan): string[] | undefined {
	return taskIds?.map((id) => remapTaskId(id, plan) as string);
}

function remapTaskTitle(title: string, type: WorkflowTaskType, nextPageIndex: number): string {
	return /^(Translate|Clean|Typeset|Review) page \d+$/.test(title)
		? `${WORKFLOW_TASK_LABELS[type]} page ${nextPageIndex + 1}`
		: title;
}

function remapActivityMetadata(
	metadata: Record<string, unknown> | undefined,
	plan: PageReorderPlan,
): Record<string, unknown> | undefined {
	if (!metadata) return metadata;
	const next: Record<string, unknown> = { ...metadata };
	for (const key of ["taskId", "linkedTaskId", "reviewTaskId"]) {
		if (typeof next[key] === "string") {
			next[key] = remapTaskId(next[key] as string, plan);
		}
	}
	if (Array.isArray(next.linkedTaskIds)) {
		next.linkedTaskIds = next.linkedTaskIds.map((item) => (
			typeof item === "string" ? remapTaskId(item, plan) : item
		));
	}
	return next;
}

function remapTasks(tasks: WorkflowTask[] | undefined, plan: PageReorderPlan): WorkflowTask[] | undefined {
	if (!Array.isArray(tasks)) return tasks;
	return tasks.map((task) => {
		const nextPageIndex = remapIndex(task.pageIndex, plan);
		return {
			...task,
			id: remapTaskId(task.id, plan) as string,
			pageIndex: nextPageIndex,
			title: remapTaskTitle(task.title, task.type, nextPageIndex),
		};
	});
}

function remapActivityLog(log: ActivityEvent[] | undefined, plan: PageReorderPlan): ActivityEvent[] | undefined {
	if (!Array.isArray(log)) return log;
	return log.map((event) => ({
		...event,
		pageIndex: remapOptionalIndex(event.pageIndex, plan),
		taskId: remapTaskId(event.taskId, plan),
		metadata: remapActivityMetadata(event.metadata, plan),
	}));
}

function remapComments(comments: ProjectComment[] | undefined, plan: PageReorderPlan): ProjectComment[] | undefined {
	if (!Array.isArray(comments)) return comments;
	return comments.map((comment) => ({ ...comment, pageIndex: remapIndex(comment.pageIndex, plan) }));
}

function remapMarkers(markers: AiReviewMarker[] | undefined, plan: PageReorderPlan): AiReviewMarker[] | undefined {
	if (!Array.isArray(markers)) return markers;
	return markers.map((marker) => ({
		...marker,
		pageIndex: remapIndex(marker.pageIndex, plan),
		linkedTaskIds: remapTaskIds(marker.linkedTaskIds, plan),
	}));
}

function remapDecisions(
	decisions: PageReviewDecision[] | undefined,
	plan: PageReorderPlan,
): PageReviewDecision[] | undefined {
	if (!Array.isArray(decisions)) return decisions;
	return decisions.map((decision) => ({ ...decision, pageIndex: remapIndex(decision.pageIndex, plan) }));
}

function remapMessages(
	messages: WorkspaceMessage[] | undefined,
	plan: PageReorderPlan,
): WorkspaceMessage[] | undefined {
	if (!Array.isArray(messages)) return messages;
	return messages.map((message) => ({
		...message,
		pageIndex: remapOptionalIndex(message.pageIndex, plan),
		linkedTaskId: remapTaskId(message.linkedTaskId, plan),
	}));
}

/**
 * Remap, IN PLACE, the persisted server-owned page-linked collections of
 * `state` onto a new page order described by `plan`. No-op when the plan is the
 * identity permutation (page order unchanged). `state.pages` must already be in
 * the NEW order; this only follows the linked records to their pages' new
 * indexes. Returns the same `state` for convenience.
 */
export function applyPageReorderToServerOwnedCollections(
	state: ProjectState,
	plan: PageReorderPlan,
): ProjectState {
	if (!plan.changed) return state;
	if (Array.isArray(state.tasks)) state.tasks = remapTasks(state.tasks, plan);
	if (Array.isArray(state.activityLog)) state.activityLog = remapActivityLog(state.activityLog, plan);
	if (Array.isArray(state.comments)) state.comments = remapComments(state.comments, plan);
	if (Array.isArray(state.aiReviewMarkers)) state.aiReviewMarkers = remapMarkers(state.aiReviewMarkers, plan);
	if (Array.isArray(state.reviewDecisions)) state.reviewDecisions = remapDecisions(state.reviewDecisions, plan);
	if (Array.isArray(state.workspaceMessages)) state.workspaceMessages = remapMessages(state.workspaceMessages, plan);
	// versionReviewRequests: not page-linked. exportRuns: historical export
	// records. Both are intentionally left untouched (matches the frontend).
	return state;
}
