import type { WorkflowTask, WorkflowTaskType } from "$lib/types.js";
import type { PageWorkSummary } from "$lib/project/page-work-summary.js";

// Honest, COMPLETION-based per-lane progress for the chapter "production pipeline"
// rail in the Library. The previous implementation divided "a task/layer EXISTS"
// by page count and capped it at 94, so a brand-new chapter with one task on one
// page read 94% "พร้อมส่งต่อ" even though nothing was finished. These helpers base
// every lane's % on work that is genuinely DONE — never on mere existence — so a
// fresh chapter reads 0 across the board and only real completion moves the meter.

export type ChapterPipelineLane = "script" | "clean" | "translate" | "typeset" | "qc" | "done";

// Story-pipeline lanes that are driven by workflow tasks of a single task type.
// "qc" maps to the `review` task type; "script"/"done" are page-derived, not task-
// driven, so they are intentionally absent here.
const LANE_TASK_TYPE: Partial<Record<ChapterPipelineLane, WorkflowTaskType>> = {
	clean: "clean",
	translate: "translate",
	typeset: "typeset",
	qc: "review",
};

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function percent(done: number, total: number): number {
	if (total <= 0) return 0;
	return clampPercent((done / total) * 100);
}

// A page has its "script" in place once it carries editable text layers (the
// imported/authored source text). Completion = pages whose script is present.
function scriptDonePages(summaries: readonly PageWorkSummary[]): number {
	return summaries.filter((summary) => summary.layerCount > 0).length;
}

// A page is "done" for export once `exportReady` is true (the same honest signal
// the chapter dashboard uses). Completion = export-ready pages.
function exportDonePages(summaries: readonly PageWorkSummary[]): number {
	return summaries.filter((summary) => summary.exportReady).length;
}

function taskLaneDone(tasks: readonly WorkflowTask[], type: WorkflowTaskType): { done: number; total: number } {
	let done = 0;
	let total = 0;
	for (const task of tasks) {
		if (task.type !== type) continue;
		total += 1;
		// Only tasks that are actually finished count as completion. `done` is the
		// terminal workflow status; nothing else (todo/doing/review) is "complete".
		if (task.status === "done") done += 1;
	}
	return { done, total };
}

export interface ChapterPipelineProgressInput {
	lane: ChapterPipelineLane;
	summaries: readonly PageWorkSummary[];
	tasks: readonly WorkflowTask[];
}

// Completion-based progress for one lane of a LOADED chapter (real per-page +
// per-task data available). Returns 0 when nothing is done, 100 only when the
// lane's work is genuinely complete. Never fabricates a floor or a 94% ceiling.
export function chapterLaneProgressPercent(input: ChapterPipelineProgressInput): number {
	const { lane, summaries, tasks } = input;
	const totalPages = summaries.length;
	if (totalPages === 0) return 0;

	if (lane === "script") return percent(scriptDonePages(summaries), totalPages);
	if (lane === "done") return percent(exportDonePages(summaries), totalPages);

	const taskType = LANE_TASK_TYPE[lane];
	if (taskType) {
		const { done, total } = taskLaneDone(tasks, taskType);
		// When the lane has no tasks at all, fall back to the page-completion signal:
		// the chapter can still genuinely finish a stage without explicit task rows
		// (e.g. a solo run with no task tracking). "ready" pages are the only honest
		// "this stage is complete" signal we have without per-lane task data.
		if (total === 0) {
			const readyPages = summaries.filter((summary) => summary.status === "ready").length;
			return percent(readyPages, totalPages);
		}
		return percent(done, total);
	}

	return 0;
}
