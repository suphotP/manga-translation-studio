import type { WorkflowTaskPriority } from "$lib/types.js";

export const WORKFLOW_TASK_PRIORITY_OPTIONS: readonly { id: WorkflowTaskPriority; label: string }[] = [
	{ id: "normal", label: "Normal" },
	{ id: "high", label: "High" },
	{ id: "urgent", label: "Urgent" },
];

const PRIORITY_RANK: Record<WorkflowTaskPriority, number> = {
	urgent: 0,
	high: 1,
	normal: 2,
};

export function normalizeWorkflowTaskPriority(value: unknown): WorkflowTaskPriority {
	return WORKFLOW_TASK_PRIORITY_OPTIONS.some((option) => option.id === value)
		? value as WorkflowTaskPriority
		: "normal";
}

export function workflowTaskPriorityLabel(priority: WorkflowTaskPriority | undefined): string {
	return WORKFLOW_TASK_PRIORITY_OPTIONS.find((option) => option.id === normalizeWorkflowTaskPriority(priority))?.label ?? "Normal";
}

export function workflowTaskPriorityRank(priority: WorkflowTaskPriority | undefined): number {
	return PRIORITY_RANK[normalizeWorkflowTaskPriority(priority)];
}

type WorkflowTaskPrioritySource = {
	priority?: unknown;
};

export function countTasksByPriority(tasks: readonly WorkflowTaskPrioritySource[]): Record<WorkflowTaskPriority, number> {
	return tasks.reduce<Record<WorkflowTaskPriority, number>>((counts, task) => {
		const priority = normalizeWorkflowTaskPriority(task.priority);
		counts[priority] += 1;
		return counts;
	}, { normal: 0, high: 0, urgent: 0 });
}

export function highestWorkflowTaskPriority(tasks: readonly WorkflowTaskPrioritySource[]): WorkflowTaskPriority {
	return [...tasks]
		.map((task) => normalizeWorkflowTaskPriority(task.priority))
		.sort((a, b) => workflowTaskPriorityRank(a) - workflowTaskPriorityRank(b))[0] ?? "normal";
}
