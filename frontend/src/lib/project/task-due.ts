import type { WorkflowTask, WorkflowTaskStatus } from "$lib/types.js";

export const OPEN_WORKFLOW_TASK_STATUSES = new Set<WorkflowTaskStatus>(["todo", "doing", "review"]);

type WorkflowTaskDueSource = Pick<WorkflowTask, "status" | "dueAt">;

export interface WorkflowTaskDueSummary {
	dueTaskCount: number;
	overdueTaskCount: number;
	nextDueAt: string | null;
}

export function isWorkflowTaskOpen(task: Pick<WorkflowTask, "status">): boolean {
	return OPEN_WORKFLOW_TASK_STATUSES.has(task.status);
}

export function parseWorkflowTaskDueTime(dueAt: string | undefined): number | null {
	if (!dueAt) return null;
	const dueTime = Date.parse(dueAt);
	return Number.isFinite(dueTime) ? dueTime : null;
}

export function isWorkflowTaskOverdue(task: WorkflowTaskDueSource, now = Date.now()): boolean {
	if (!isWorkflowTaskOpen(task)) return false;
	const dueTime = parseWorkflowTaskDueTime(task.dueAt);
	return dueTime !== null && dueTime < now;
}

export function summarizeWorkflowTaskDue(
	tasks: readonly WorkflowTaskDueSource[],
	now = Date.now(),
): WorkflowTaskDueSummary {
	let dueTaskCount = 0;
	let overdueTaskCount = 0;
	let nextDueAt: string | null = null;
	let nextDueTime = Number.POSITIVE_INFINITY;

	for (const task of tasks) {
		if (!isWorkflowTaskOpen(task)) continue;
		const dueTime = parseWorkflowTaskDueTime(task.dueAt);
		if (dueTime === null) continue;
		dueTaskCount += 1;
		if (dueTime < now) overdueTaskCount += 1;
		if (dueTime < nextDueTime) {
			nextDueTime = dueTime;
			nextDueAt = task.dueAt ?? null;
		}
	}

	return { dueTaskCount, overdueTaskCount, nextDueAt };
}

export function formatWorkflowDueDay(dueAt: string | null | undefined): string {
	const dueTime = parseWorkflowTaskDueTime(dueAt ?? undefined);
	if (dueTime === null) return "";
	return new Date(dueTime).toISOString().slice(0, 10);
}
