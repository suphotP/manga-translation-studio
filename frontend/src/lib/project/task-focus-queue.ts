import { normalizeAssigneeHandle } from "$lib/project/assignees.js";
import { isWorkflowTaskOpen, isWorkflowTaskOverdue, parseWorkflowTaskDueTime } from "$lib/project/task-due.js";
import { workflowTaskPriorityRank } from "$lib/project/task-priority.js";
import type { WorkflowTask, WorkflowTaskType } from "$lib/types.js";
import type { WorkInboxItem, WorkInboxWorkflowTitle } from "./work-inbox.js";

export type TaskFocusOrigin = "handoff" | "workflow";

export interface TaskFocusItem extends WorkInboxItem {
	focusOrigin: TaskFocusOrigin;
	workflowType?: WorkflowTaskType;
}

export interface TaskFocusQueueSummary {
	totalCount: number;
	handoffCount: number;
	workflowCount: number;
	blockerCount: number;
	commentCount: number;
	qcCount: number;
	aiCount: number;
	reviewCount: number;
}

const TASK_TYPE_ORDER: Record<WorkflowTaskType, number> = {
	translate: 0,
	clean: 1,
	typeset: 2,
	review: 3,
};

// Map a raw workflow task title to the stable work-inbox workflow-title code, so
// a focus item carries the SAME locale-neutral descriptor the inbox does (the
// consumer localizes via `$_("workInbox.workflowTitle.<code>")`). Mirrors
// work-inbox.ts's `workflowTitleDescriptor` precedence.
function focusWorkflowTitle(task: WorkflowTask): WorkInboxWorkflowTitle {
	const title = task.title.trim();
	if (/^Page\s+\d+\s*-\s*Review imported dialogue$/i.test(title) || /^Review imported dialogue$/i.test(title)) {
		return { code: "review_imported" };
	}
	if (/^Translate page \d+$/i.test(title)) return { code: "translate" };
	if (/^Clean page \d+$/i.test(title)) return { code: "clean" };
	if (/^Typeset page \d+$/i.test(title)) return { code: "typeset" };
	if (/^Review page \d+$/i.test(title)) return { code: "review" };
	const customTitle = title.replace(/^Page\s+\d+\s*-\s*/i, "").replace(/^หน้า\s+\d+\s*-\s*/i, "");
	return { code: "custom", customTitle };
}

function compareWorkflowFocusTasks(a: WorkflowTask, b: WorkflowTask): number {
	const overdueDelta = Number(isWorkflowTaskOverdue(b)) - Number(isWorkflowTaskOverdue(a));
	if (overdueDelta !== 0) return overdueDelta;

	const priorityDelta = workflowTaskPriorityRank(a.priority) - workflowTaskPriorityRank(b.priority);
	if (priorityDelta !== 0) return priorityDelta;

	const aDue = parseWorkflowTaskDueTime(a.dueAt) ?? Number.POSITIVE_INFINITY;
	const bDue = parseWorkflowTaskDueTime(b.dueAt) ?? Number.POSITIVE_INFINITY;
	if (aDue !== bDue) return aDue - bDue;

	if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
	const typeDelta = TASK_TYPE_ORDER[a.type] - TASK_TYPE_ORDER[b.type];
	if (typeDelta !== 0) return typeDelta;
	return a.title.localeCompare(b.title);
}

function taskToFocusItem(task: WorkflowTask): TaskFocusItem {
	const overdue = isWorkflowTaskOverdue(task);
	const assignee = normalizeAssigneeHandle(task.assignee);
	const dueAt = task.dueAt;
	const isReview = task.type === "review";
	const workflowTitle = focusWorkflowTitle(task);

	return {
		id: `workflow-focus-${task.id}`,
		focusOrigin: "workflow",
		kind: isReview ? "review_task" : "workflow_task",
		severity: overdue || task.priority === "urgent" ? "error" : task.priority === "high" ? "warning" : "info",
		priority: task.priority,
		status: task.status,
		workflowType: task.type,
		assignee: assignee ?? undefined,
		dueAt,
		overdue,
		pageIndex: task.pageIndex,
		// Locale-neutral title code: only a review task whose status is actually
		// `review` presents as "ready for review"; a still-`todo`/`doing` review task
		// keeps its workflow-title descriptor (so it doesn't render "Ready for review"
		// prematurely). Any non-review type presents its workflow title. The consumer
		// localizes via `$_` and routes by `workflowType`/`kind`.
		titleCode: isReview && task.status === "review" ? "review_ready" : "workflow",
		workflowTitle: isReview && task.status === "review" ? undefined : workflowTitle,
		// Structured detail mirrors a workflow task's: status + assignee + due.
		// (Focus-item detail is derived through structured fields by consumers, not
		// rendered raw, so this stays consistent with the inbox.)
		detail: {
			kind: "workflow_task",
			statusCode: task.status,
			assignee: assignee ?? undefined,
			dueAt,
			overdue,
		},
		sourceId: task.id,
	};
}

export function buildTaskFocusQueue(
	inboxItems: readonly WorkInboxItem[],
	tasks: readonly WorkflowTask[],
): TaskFocusItem[] {
	const representedTaskIds = new Set(
		inboxItems
			.filter((item) => item.kind === "workflow_task" || item.kind === "review_task")
			.map((item) => item.sourceId),
	);

	const handoffItems = inboxItems.map((item): TaskFocusItem => ({
		...item,
		focusOrigin: "handoff",
	}));

	const workflowItems = tasks
		.filter((task) =>
			isWorkflowTaskOpen(task)
			&& !representedTaskIds.has(task.id)
		)
		.sort(compareWorkflowFocusTasks)
		.map(taskToFocusItem);

	return [...handoffItems, ...workflowItems].slice(0, 140);
}

export function summarizeTaskFocusQueue(items: readonly TaskFocusItem[]): TaskFocusQueueSummary {
	return {
		totalCount: items.length,
		handoffCount: items.filter((item) => item.focusOrigin === "handoff").length,
		workflowCount: items.filter((item) => item.focusOrigin === "workflow").length,
		blockerCount: items.filter((item) => item.severity === "error" || item.overdue || item.priority === "urgent").length,
		commentCount: items.filter((item) => item.kind === "comment").length,
		qcCount: items.filter((item) => item.kind === "qc").length,
		aiCount: items.filter((item) => item.kind === "ai_marker").length,
		reviewCount: items.filter((item) => item.kind === "review_task" || item.status === "review").length,
	};
}
