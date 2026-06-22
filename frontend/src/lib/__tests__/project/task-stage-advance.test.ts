import { describe, expect, it } from "vitest";
import {
	TASK_PIPELINE_ORDER,
	nextPipelineStage,
	planStageAdvance,
	roleAssigneeHandle,
	taskTypeRole,
} from "$lib/project/task-stage-advance.js";
import type { WorkflowTask, WorkflowTaskType } from "$lib/types.js";

function task(type: WorkflowTaskType, pageIndex = 0, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: `page-${pageIndex}-${type}`,
		type,
		status: "todo",
		priority: "normal",
		pageIndex,
		title: `${type} page ${pageIndex + 1}`,
		createdAt: "2026-06-05T00:00:00.000Z",
		updatedAt: "2026-06-05T00:00:00.000Z",
		...overrides,
	};
}

describe("task-stage-advance", () => {
	it("encodes the documented pipeline order Clean → Translate → Typeset → QC", () => {
		expect([...TASK_PIPELINE_ORDER]).toEqual(["clean", "translate", "typeset", "review"]);
	});

	it("maps each stage to its role + assignee handle", () => {
		expect(taskTypeRole("clean")).toBe("cleaner");
		expect(taskTypeRole("translate")).toBe("translator");
		expect(taskTypeRole("typeset")).toBe("typesetter");
		expect(taskTypeRole("review")).toBe("qc");
		expect(roleAssigneeHandle("cleaner")).toBe("cleaner");
		expect(roleAssigneeHandle("qc")).toBe("qc");
	});

	it("advances each stage to the next in order", () => {
		expect(nextPipelineStage("clean")).toBe("translate");
		expect(nextPipelineStage("translate")).toBe("typeset");
		expect(nextPipelineStage("typeset")).toBe("review");
	});

	it("treats QC (review) as terminal", () => {
		expect(nextPipelineStage("review")).toBeNull();
	});

	it("plans an advance that opens the next stage for the next role", () => {
		const tasks = [task("clean"), task("translate"), task("typeset"), task("review")];
		const plan = planStageAdvance(tasks[0], tasks);
		expect(plan.currentTaskId).toBe("page-0-clean");
		expect(plan.nextType).toBe("translate");
		expect(plan.nextRole).toBe("translator");
		expect(plan.nextTaskId).toBe("page-0-translate");
		expect(plan.nextAssignee).toBe("translator");
		expect(plan.terminal).toBe(false);
	});

	it("plans a terminal submit for QC with no next stage", () => {
		const tasks = [task("review")];
		const plan = planStageAdvance(tasks[0], tasks);
		expect(plan.terminal).toBe(true);
		expect(plan.nextType).toBeNull();
		expect(plan.nextRole).toBeNull();
		expect(plan.nextTaskId).toBeNull();
		expect(plan.nextAssignee).toBeNull();
	});

	it("only matches the next-stage task on the SAME page", () => {
		const tasks = [task("clean", 0), task("translate", 1)];
		const plan = planStageAdvance(tasks[0], tasks);
		// translate exists only on page 1, so there is no same-page next task.
		expect(plan.nextType).toBe("translate");
		expect(plan.nextTaskId).toBeNull();
	});
});
