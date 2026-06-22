// Collab v1 — role-aware "submit on done" pipeline advance.
//
// The Work Board previously flipped task status free-form (todo/doing/review/
// done in any direction). This module encodes the documented production pipeline
// so a "Submit / Mark done" action on the CURRENT stage advances the page's work
// to the NEXT stage and opens it for the next role — instead of arbitrary flips.
//
// Pipeline order (Suphot's four roles): Clean → Translate → Typeset → QC.
// Task types map 1:1 to roles: clean=Cleaner, translate=Translator,
// typeset=Typesetter, review=QC. QC ("review") is the terminal stage — submitting
// it marks the page's production work done (no further stage).
//
// Pure + framework-free so it's unit-testable and reused by the store. No
// Postgres dependency — it computes the transition from the in-memory task list
// and the store persists it via the existing task PATCH path.

import type { WorkflowTask, WorkflowTaskType } from "$lib/types.js";

export type ProductionRoleId = "cleaner" | "translator" | "typesetter" | "qc";

// Ordered pipeline stages. Index = position in the chain.
export const TASK_PIPELINE_ORDER: readonly WorkflowTaskType[] = ["clean", "translate", "typeset", "review"];

const TASK_TYPE_TO_ROLE: Record<WorkflowTaskType, ProductionRoleId> = {
	clean: "cleaner",
	translate: "translator",
	typeset: "typesetter",
	review: "qc",
};

// The default assignee handle the store stamps when a stage opens for its role.
// Matches the Work Board's `productionActorHandle(...)` handles so the opened
// task shows up under the right role queue.
const ROLE_ASSIGNEE_HANDLE: Record<ProductionRoleId, string> = {
	cleaner: "cleaner",
	translator: "translator",
	typesetter: "typesetter",
	qc: "qc",
};

export function taskTypeRole(type: WorkflowTaskType): ProductionRoleId {
	return TASK_TYPE_TO_ROLE[type];
}

export function roleAssigneeHandle(role: ProductionRoleId): string {
	return ROLE_ASSIGNEE_HANDLE[role];
}

/** The pipeline stage that follows `type`, or null if `type` is terminal (QC). */
export function nextPipelineStage(type: WorkflowTaskType): WorkflowTaskType | null {
	const index = TASK_PIPELINE_ORDER.indexOf(type);
	if (index < 0 || index >= TASK_PIPELINE_ORDER.length - 1) return null;
	return TASK_PIPELINE_ORDER[index + 1];
}

export interface StageAdvancePlan {
	/** The task being submitted — marked `done`. */
	currentTaskId: string;
	currentType: WorkflowTaskType;
	pageIndex: number;
	/** The next stage's task type + role, or null when submitting the terminal (QC) stage. */
	nextType: WorkflowTaskType | null;
	nextRole: ProductionRoleId | null;
	/** Existing task id for the next stage on the same page, if one already exists. */
	nextTaskId: string | null;
	/** Assignee handle to open the next stage under (null when terminal). */
	nextAssignee: string | null;
	/** True when this submit closes the final (QC) stage — page work is done. */
	terminal: boolean;
}

/**
 * Build the advance plan for submitting `task` as done. Looks up an existing
 * next-stage task on the same page so the store can re-open it rather than
 * duplicate. Returns null only when the task can't be resolved.
 */
export function planStageAdvance(task: WorkflowTask, allTasks: readonly WorkflowTask[]): StageAdvancePlan {
	const nextType = nextPipelineStage(task.type);
	const nextRole = nextType ? taskTypeRole(nextType) : null;
	const nextTask = nextType
		? allTasks.find((candidate) => candidate.pageIndex === task.pageIndex && candidate.type === nextType) ?? null
		: null;
	return {
		currentTaskId: task.id,
		currentType: task.type,
		pageIndex: task.pageIndex,
		nextType,
		nextRole,
		nextTaskId: nextTask?.id ?? null,
		nextAssignee: nextRole ? roleAssigneeHandle(nextRole) : null,
		terminal: nextType === null,
	};
}
