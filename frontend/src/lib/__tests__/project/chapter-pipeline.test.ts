import { describe, expect, it } from "vitest";
import { chapterLaneProgressPercent } from "$lib/project/chapter-pipeline.js";
import type { PageWorkSummary } from "$lib/project/page-work-summary.js";
import type { WorkflowTask, WorkflowTaskStatus, WorkflowTaskType } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

function summary(overrides: Partial<PageWorkSummary> = {}): PageWorkSummary {
	return {
		pageIndex: 0,
		pageNumber: 1,
		name: "Page 1",
		layerCount: 0,
		status: "empty",
		statusLabel: "No text",
		nextAction: "Add or import editable text layers",
		primarySignal: {
			kind: "text-empty",
			severity: "info",
			labelCode: "text-empty",
			detail: "Add or import editable text layers",
			pageIndex: overrides.pageIndex ?? 0,
			actionKind: "open-editor",
		},
		assetIntegrity: null,
		qcErrorCount: 0,
		qcWarningCount: 0,
		openCommentCount: 0,
		aiAttentionCount: 0,
		taskTotalCount: 0,
		taskOpenCount: 0,
		urgentTaskCount: 0,
		highTaskCount: 0,
		dueTaskCount: 0,
		overdueTaskCount: 0,
		nextDueAt: null,
		highestTaskPriority: "normal",
		priorityLabel: "Normal",
		assignees: [],
		latestReviewDecision: null,
		exportReady: false,
		exportBlockers: [],
		...overrides,
	};
}

function task(type: WorkflowTaskType, status: WorkflowTaskStatus, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: `${type}-${status}-${overrides.pageIndex ?? 0}`,
		type,
		status,
		priority: "normal",
		pageIndex: overrides.pageIndex ?? 0,
		pageImageId: "image-1",
		title: `${type} task`,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("chapterLaneProgressPercent", () => {
	it("returns 0 for a brand-new chapter with one open task on one empty page (no fake 94%)", () => {
		// The exact bug: a single open task on a 1-page chapter previously read 94%.
		const summaries = [summary()];
		const tasks = [task("translate", "todo")];
		for (const lane of ["script", "clean", "translate", "typeset", "qc", "done"] as const) {
			expect(chapterLaneProgressPercent({ lane, summaries, tasks })).toBe(0);
		}
	});

	it("returns 0 for every lane when the chapter has no pages", () => {
		for (const lane of ["script", "clean", "translate", "typeset", "qc", "done"] as const) {
			expect(chapterLaneProgressPercent({ lane, summaries: [], tasks: [] })).toBe(0);
		}
	});

	it("counts only DONE tasks for task-driven lanes", () => {
		const summaries = [
			summary({ pageIndex: 0, layerCount: 1 }),
			summary({ pageIndex: 1, pageNumber: 2, name: "Page 2", layerCount: 1 }),
		];
		// 2 translate tasks, 1 done → 50%. clean has 1 task, 0 done → 0%.
		const tasks = [
			task("translate", "done", { pageIndex: 0 }),
			task("translate", "doing", { pageIndex: 1 }),
			task("clean", "review", { pageIndex: 0 }),
		];
		expect(chapterLaneProgressPercent({ lane: "translate", summaries, tasks })).toBe(50);
		expect(chapterLaneProgressPercent({ lane: "clean", summaries, tasks })).toBe(0);
	});

	it("treats `review` task completion as the QC lane progress", () => {
		const summaries = [
			summary({ pageIndex: 0, layerCount: 1 }),
			summary({ pageIndex: 1, pageNumber: 2, name: "Page 2", layerCount: 1 }),
		];
		const tasks = [
			task("review", "done", { pageIndex: 0 }),
			task("review", "todo", { pageIndex: 1 }),
		];
		expect(chapterLaneProgressPercent({ lane: "qc", summaries, tasks })).toBe(50);
	});

	it("bases the script lane on pages that have text layers", () => {
		const summaries = [
			summary({ pageIndex: 0, layerCount: 2, status: "ready", exportReady: true }),
			summary({ pageIndex: 1, pageNumber: 2, name: "Page 2", layerCount: 0 }),
		];
		expect(chapterLaneProgressPercent({ lane: "script", summaries, tasks: [] })).toBe(50);
	});

	it("bases the done lane on export-ready pages only", () => {
		const summaries = [
			summary({ pageIndex: 0, layerCount: 1, status: "ready", exportReady: true }),
			summary({ pageIndex: 1, pageNumber: 2, name: "Page 2", layerCount: 1, status: "review", exportReady: false }),
		];
		expect(chapterLaneProgressPercent({ lane: "done", summaries, tasks: [] })).toBe(50);
	});

	it("reads 100 on every lane for a fully completed chapter", () => {
		const summaries = [
			summary({ pageIndex: 0, layerCount: 2, status: "ready", exportReady: true }),
			summary({ pageIndex: 1, pageNumber: 2, name: "Page 2", layerCount: 2, status: "ready", exportReady: true }),
		];
		const tasks = [
			task("clean", "done", { pageIndex: 0 }),
			task("translate", "done", { pageIndex: 0 }),
			task("typeset", "done", { pageIndex: 0 }),
			task("review", "done", { pageIndex: 0 }),
		];
		for (const lane of ["script", "clean", "translate", "typeset", "qc", "done"] as const) {
			expect(chapterLaneProgressPercent({ lane, summaries, tasks })).toBe(100);
		}
	});

	it("falls back to ready-page completion for a task-driven lane with no tasks", () => {
		// No task rows for the lane → use the only honest 'stage complete' signal we
		// have: ready pages. 1 of 2 pages ready → 50%, never a fabricated value.
		const summaries = [
			summary({ pageIndex: 0, layerCount: 1, status: "ready", exportReady: true }),
			summary({ pageIndex: 1, pageNumber: 2, name: "Page 2", layerCount: 1, status: "review" }),
		];
		expect(chapterLaneProgressPercent({ lane: "typeset", summaries, tasks: [] })).toBe(50);
	});

	it("never exceeds 100 or drops below 0", () => {
		const summaries = [summary({ layerCount: 1, status: "ready", exportReady: true })];
		const tasks = [task("translate", "done")];
		expect(chapterLaneProgressPercent({ lane: "translate", summaries, tasks })).toBe(100);
		expect(chapterLaneProgressPercent({ lane: "done", summaries, tasks })).toBe(100);
	});
});
