import { describe, expect, it } from "vitest";
import { buildTaskFocusQueue, summarizeTaskFocusQueue } from "$lib/project/task-focus-queue.js";
import type { WorkflowTask } from "$lib/types.js";
import type { WorkInboxItem } from "$lib/project/work-inbox.js";

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: overrides.id ?? "task-1",
		type: overrides.type ?? "translate",
		status: overrides.status ?? "todo",
		priority: overrides.priority ?? "normal",
		pageIndex: overrides.pageIndex ?? 0,
		title: overrides.title ?? "Translate page 1",
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function inboxItem(overrides: Partial<WorkInboxItem> = {}): WorkInboxItem {
	return {
		id: overrides.id ?? "qc-1",
		kind: overrides.kind ?? "qc",
		severity: overrides.severity ?? "warning",
		pageIndex: overrides.pageIndex ?? 0,
		titleCode: overrides.titleCode ?? "qc",
		qcCode: overrides.qcCode ?? "page_without_text",
		detail: overrides.detail ?? { kind: "text", text: "Check this page" },
		sourceId: overrides.sourceId ?? "qc-1",
		...overrides,
	};
}

describe("buildTaskFocusQueue", () => {
	it("keeps inbox handoffs first and appends normal workflow tasks", () => {
		const queue = buildTaskFocusQueue(
			[inboxItem({ id: "handoff-1", sourceId: "qc-1" })],
			[
				task({ id: "translate-1", type: "translate", pageIndex: 0 }),
				task({ id: "clean-1", type: "clean", pageIndex: 0, assignee: "@@Mai" }),
			],
		);

		expect(queue.map((item) => item.id)).toEqual([
			"handoff-1",
			"workflow-focus-translate-1",
			"workflow-focus-clean-1",
		]);
		expect(queue[0].focusOrigin).toBe("handoff");
		expect(queue[1]).toMatchObject({
			focusOrigin: "workflow",
			kind: "workflow_task",
			workflowType: "translate",
			sourceId: "translate-1",
			severity: "info",
		});
		// The clean-1 task keeps the factory's default title ("Translate page 1"),
		// so its workflow-title code resolves to the recognized "translate" form.
		expect(queue[2]).toMatchObject({
			sourceId: "clean-1",
			assignee: "Mai",
			titleCode: "workflow",
			workflowTitle: { code: "translate" },
			detail: { kind: "workflow_task", statusCode: "todo", assignee: "Mai", overdue: false },
		});
	});

	it("does not duplicate workflow tasks already represented by inbox handoffs", () => {
		const queue = buildTaskFocusQueue(
			[
				inboxItem({
					id: "workflow-task-clean-1",
					kind: "workflow_task",
					sourceId: "clean-1",
					titleCode: "workflow",
					workflowTitle: { code: "clean" },
				}),
			],
			[
				task({ id: "clean-1", type: "clean", priority: "urgent" }),
				task({ id: "typeset-1", type: "typeset" }),
			],
		);

		expect(queue.map((item) => item.sourceId)).toEqual(["clean-1", "typeset-1"]);
		expect(queue.filter((item) => item.sourceId === "clean-1")).toHaveLength(1);
	});

	it("orders workflow tasks by overdue, priority, due date, page, and type", () => {
		const queue = buildTaskFocusQueue([], [
			task({ id: "page-2-normal", type: "translate", pageIndex: 1 }),
			task({
				id: "page-1-high-later",
				type: "typeset",
				priority: "high",
				pageIndex: 0,
				dueAt: "2999-01-03T00:00:00.000Z",
			}),
			task({
				id: "page-1-high-sooner",
				type: "clean",
				priority: "high",
				pageIndex: 0,
				dueAt: "2999-01-01T00:00:00.000Z",
			}),
			task({
				id: "page-3-overdue",
				type: "review",
				priority: "normal",
				pageIndex: 2,
				dueAt: "2000-01-01T00:00:00.000Z",
			}),
		]);

		expect(queue.map((item) => item.sourceId)).toEqual([
			"page-3-overdue",
			"page-1-high-sooner",
			"page-1-high-later",
			"page-2-normal",
		]);
		expect(queue[0]).toMatchObject({
			kind: "review_task",
			severity: "error",
			overdue: true,
		});
	});

	it("appends every open workflow task in production order (no preset gating)", () => {
		const tasks = [
			task({ id: "translate-1", type: "translate" }),
			task({ id: "clean-1", type: "clean" }),
			task({ id: "typeset-1", type: "typeset" }),
			task({ id: "review-1", type: "review" }),
		];
		const handoff = inboxItem({
			id: "qc-source-script",
			kind: "qc",
			sourceId: "qc-source-script",
			qcCode: "remaining_source_script",
		});

		// The workflow-preset chooser was removed; the focus queue now surfaces the
		// full set of open workflow tasks (sorted translate -> clean -> typeset ->
		// review) after the hand-off items, regardless of any role abstraction.
		expect(buildTaskFocusQueue([handoff], tasks).map((item) => item.sourceId)).toEqual([
			"qc-source-script",
			"translate-1",
			"clean-1",
			"typeset-1",
			"review-1",
		]);
	});

	it("summarizes focus queues for role and issue context", () => {
		const queue = buildTaskFocusQueue(
			[
				inboxItem({ id: "comment-1", kind: "comment", sourceId: "comment-1" }),
				inboxItem({ id: "ai-1", kind: "ai_marker", sourceId: "ai-1", severity: "error" }),
			],
			[
				task({ id: "review-1", type: "review", status: "review", priority: "high" }),
				task({ id: "translate-1", type: "translate", priority: "urgent" }),
			],
		);

		expect(summarizeTaskFocusQueue(queue)).toMatchObject({
			totalCount: 4,
			handoffCount: 2,
			workflowCount: 2,
			blockerCount: 2,
			commentCount: 1,
			aiCount: 1,
			reviewCount: 1,
		});
	});
});
