import { v4 as uuid } from "uuid";
import type {
	ActivityEvent,
	PageState,
	ProjectState,
	WorkflowTask,
	WorkflowTaskPriority,
	WorkflowTaskType,
} from "../types/index.js";
import { normalizeAssigneeHandle } from "./assignees.js";

export const MAX_ACTIVITY_EVENTS = 200;
export const WORKFLOW_TASK_TYPES: WorkflowTaskType[] = ["translate", "clean", "typeset", "review"];
export const WORKFLOW_TASK_PRIORITIES: WorkflowTaskPriority[] = ["normal", "high", "urgent"];

const PRIORITY_RANK: Record<WorkflowTaskPriority, number> = {
	normal: 0,
	high: 1,
	urgent: 2,
};

export function taskTitle(type: WorkflowTaskType, pageIndex: number): string {
	const labels: Record<WorkflowTaskType, string> = {
		translate: "Translate",
		clean: "Clean",
		typeset: "Typeset",
		review: "Review",
	};
	return `${labels[type]} page ${pageIndex + 1}`;
}

export function taskIdFor(pageIndex: number, type: WorkflowTaskType, layerId?: string): string {
	return layerId ? `page-${pageIndex}-${type}-${layerId}` : `page-${pageIndex}-${type}`;
}

export function normalizeWorkflowTaskPriority(value: unknown): WorkflowTaskPriority {
	return WORKFLOW_TASK_PRIORITIES.includes(value as WorkflowTaskPriority)
		? value as WorkflowTaskPriority
		: "normal";
}

export function maxWorkflowTaskPriority(
	current: WorkflowTaskPriority | undefined,
	next: WorkflowTaskPriority,
): WorkflowTaskPriority {
	const normalized = normalizeWorkflowTaskPriority(current);
	return PRIORITY_RANK[next] > PRIORITY_RANK[normalized] ? next : normalized;
}

export function createActivity(input: Omit<ActivityEvent, "id" | "createdAt" | "actor"> & { actor?: string }): ActivityEvent {
	return {
		id: uuid(),
		actor: input.actor ?? "local-user",
		createdAt: new Date().toISOString(),
		...input,
	};
}

export function appendActivity(state: ProjectState, event: ActivityEvent): void {
	const existing = Array.isArray(state.activityLog) ? state.activityLog : [];
	state.activityLog = [event, ...existing].slice(0, MAX_ACTIVITY_EVENTS);
}

/**
 * Whether a page has any text content to review across ANY language track.
 *
 * A "review" (QC) task only makes sense when the page carries translated/typeset
 * text a reviewer must check. A raw scan with zero text layers — across the flat
 * default-track fields AND every per-language `languageOutputs` bucket — has
 * nothing to QC, so auto-generating a review task for it just clutters the queue
 * with useless work. We deliberately key this on TEXT only: an image-only page
 * (reference/overlay rasters, no text) is still nothing for a translation QC pass
 * to read. Pages gain a review task the moment any track gets its first text layer
 * (`ensureProjectWorkflow` runs on every save).
 */
export function pageHasReviewableText(page: PageState): boolean {
	if (Array.isArray(page.textLayers) && page.textLayers.length > 0) return true;
	const outputs = page.languageOutputs;
	if (outputs) {
		for (const bucket of Object.values(outputs)) {
			if (Array.isArray(bucket?.textLayers) && bucket.textLayers.length > 0) return true;
		}
	}
	return false;
}

/**
 * Whether an existing review task carries human intent worth preserving even on a
 * now-textless page: it's been moved off the default "todo" status, assigned,
 * given a due date, renamed, or had its priority bumped off the default "normal"
 * (manual/bulk triage via the task-priority routes). Auto-seeded review tasks
 * (untouched "todo", default "normal" priority, no assignee/due/custom title) are
 * safe to drop for textless pages.
 */
function isMeaningfulReviewTask(task: WorkflowTask | undefined): boolean {
	if (!task) return false;
	return (task.status !== undefined && task.status !== "todo")
		|| Boolean(normalizeAssigneeHandle(task.assignee))
		|| Boolean(task.dueAt)
		|| normalizeWorkflowTaskPriority(task.priority) !== "normal"
		|| (typeof task.title === "string" && task.title !== taskTitle("review", task.pageIndex));
}

/**
 * Like {@link ensureProjectWorkflow} but returns TRUE iff it actually changed the project's
 * serialized state. ensureProjectWorkflow only ever mutates `state.tasks` and
 * `state.activityLog`, so comparing just those two (small) fields before/after is EXACTLY
 * equivalent to `hashProjectState(after) !== hashProjectState(before)` — but without
 * JSON.stringify-ing + sha256-ing the whole (multi-MB) project state twice on every read.
 * GET handlers use this to persist the lazy migration ONLY when it really changed something.
 */
export function ensureProjectWorkflowChanged(state: ProjectState): boolean {
	const now = new Date().toISOString();
	const existingTasks = Array.isArray(state.tasks) ? state.tasks : [];
	const byId = new Map(existingTasks.map((task) => [task.id, task]));
	const tasks: WorkflowTask[] = [];

	// Language-scoped tasks (translate / typeset / review) carry the project's
	// default target track so a seeded translate task is "th", not null/absent.
	// Cleaning is language-agnostic (shared cleaned raster across every target
	// language), so clean tasks deliberately leave targetLang absent. Falls back
	// across targetLang → targetLangs[0] so the field is populated even on a
	// project that only set the list form.
	const defaultTargetLang = state.targetLang?.trim()
		|| state.targetLangs?.find((lang) => typeof lang === "string" && lang.trim())?.trim()
		|| undefined;

	for (const [pageIndex, page] of state.pages.entries()) {
		const reviewable = pageHasReviewableText(page);
		for (const type of WORKFLOW_TASK_TYPES) {
			const id = taskIdFor(pageIndex, type);
			const existing = byId.get(id);
			// Skip auto-generating a review/QC task for a textless page (nothing to
			// QC). PRESERVE any review task a human already created/touched (status
			// moved off "todo", an assignee, a due date, or a renamed title) so we
			// never silently drop real review work — only the auto-seeded empties.
			if (type === "review" && !reviewable && !isMeaningfulReviewTask(existing)) {
				continue;
			}
			// Preserve a targetLang a human/import already set; otherwise stamp the
			// project default for language-scoped task types. Cleaning stays absent.
			const targetLang = existing?.targetLang?.trim()
				|| (type === "clean" ? undefined : defaultTargetLang);
			tasks.push({
				id,
				type,
				status: existing?.status ?? "todo",
				priority: normalizeWorkflowTaskPriority(existing?.priority),
				pageIndex,
				pageImageId: page.imageId,
				layerId: existing?.layerId,
				title: existing?.title ?? taskTitle(type, pageIndex),
				assignee: normalizeAssigneeHandle(existing?.assignee),
				dueAt: existing?.dueAt,
				...(targetLang ? { targetLang } : {}),
				createdAt: existing?.createdAt ?? now,
				updatedAt: existing?.updatedAt ?? now,
			});
		}
	}

	// Capture the serialized prior values BEFORE reassigning, then compare — small arrays only,
	// never the whole multi-MB state. JSON.stringify(undefined) === undefined, so an absent
	// tasks/activityLog vs a new [] is correctly detected as a change (matches the old hash).
	const prevTasksJson = JSON.stringify(state.tasks);
	const prevActivityJson = JSON.stringify(state.activityLog);
	state.tasks = tasks;
	state.activityLog = Array.isArray(state.activityLog) ? state.activityLog.slice(0, MAX_ACTIVITY_EVENTS) : [];
	return JSON.stringify(state.tasks) !== prevTasksJson || JSON.stringify(state.activityLog) !== prevActivityJson;
}

/** Back-compat wrapper: mutates `state` in place and returns it (existing callers/tests use the
 *  returned state). New read-path callers should use {@link ensureProjectWorkflowChanged}. */
export function ensureProjectWorkflow(state: ProjectState): ProjectState {
	ensureProjectWorkflowChanged(state);
	return state;
}
