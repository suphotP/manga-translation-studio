import type { AiReviewMarker, ProjectComment, ProjectState, WorkflowTask, WorkflowTaskStatus } from "$lib/types.js";
import { normalizeAssigneeHandle } from "$lib/project/assignees.js";
import {
	normalizeWorkflowTaskPriority,
	workflowTaskPriorityRank,
} from "$lib/project/task-priority.js";
import {
	isWorkflowTaskOpen,
	isWorkflowTaskOverdue,
} from "$lib/project/task-due.js";
import type { QcIssue, QcMessageCode, QcMessageValues, QcReport, QcSeverity } from "./qc-checks.js";

export type WorkInboxKind = "ai_marker" | "comment" | "review_task" | "workflow_task" | "qc";

// Stable, locale-neutral discriminant for an inbox item's TITLE. Consumers
// localize via `$_("workInbox.title.<titleCode>", …)` and COMPARE on this code
// (never on the rendered text). The Thai composition that used to live here
// (pageLabel + markerTitle/qcIssueTitle/workflowTaskDisplayTitle) now lives in
// the consumers' `$_()` calls.
//   ai_failed       ← marker.status === "failed"            (ผล AI รันไม่สำเร็จ)
//   ai_rerun        ← marker.status === "retry_requested"   (AI รอรันใหม่)
//   ai_placement    ← accepted marker w/ resultImageId      (วางผล AI เป็นเลเยอร์)
//   ai_review       ← marker needs review                   (ผล AI รอรีวิว)
//   note            ← open comment                          (โน้ตรอแก้)
//   review_ready    ← review task in review                 (พร้อมรีวิว)
//   workflow        ← open/assigned workflow task           (see workflowTitleCode)
//   qc              ← QC issue                               (see qcCode)
export type WorkInboxTitleCode =
	| "ai_failed"
	| "ai_rerun"
	| "ai_placement"
	| "ai_review"
	| "note"
	| "review_ready"
	| "workflow"
	| "qc";

// Stable code for a workflow task's display title. Mirrors the old
// `workflowTaskDisplayTitle()` branch precedence; `custom` carries the raw
// remaining task title (locale-neutral free text) in `customTitle`.
//   review_imported ← "Review imported dialogue"  (รีวิวข้อความ Import)
//   translate       ← "Translate page N"          (แปลหน้า)
//   clean           ← "Clean page N"              (คลีนหน้า)
//   typeset         ← "Typeset page N"            (ไทป์เซ็ตหน้า)
//   review          ← "Review page N"            (ตรวจหน้า)
//   custom          ← anything else (free text in customTitle)
export type WorkInboxWorkflowTitleCode =
	| "review_imported"
	| "translate"
	| "clean"
	| "typeset"
	| "review"
	| "custom";

// Stable code for the inbox-priority word the helper used to emit. Maps the
// normalized workflow priority to the old Thai label (ด่วน/สำคัญ/ปกติ).
//   urgent ← urgent (ด่วน), high ← high (สำคัญ), normal ← otherwise (ปกติ)
export type WorkInboxPriorityCode = "urgent" | "high" | "normal";

// Structured, locale-neutral DETAIL. Each variant carries only data; consumers
// compose the localized string. `text`-bearing parts (comment body, QC message)
// are raw upstream data, NOT work-inbox-composed Thai, so they pass through.
export type WorkInboxDetail =
	// AI marker, accepted+result: "ผ่านรีวิว รอวางเลเยอร์ - @owner"
	| { kind: "ai_placement_ready"; assignee?: string }
	// AI marker, other: "<tier> - <credits> เครดิต - @owner". `creditUnits` is the
	// backend's quality-flat credit count; `estimatedThb` is the THB fallback the
	// consumer converts via `thbToCredits` only when `creditUnits` is missing.
	// `hasCost` mirrors the old `marker.costEstimate` truthiness gate.
	| {
		kind: "ai_marker";
		tier: string;
		hasCost: boolean;
		creditUnits?: number;
		estimatedThb?: number;
		assignee?: string;
	}
	// Open comment: the raw comment body (upstream text, not composed Thai).
	| { kind: "text"; text: string }
	// Review task: "<priority> - <workflowTitle> - @assignee"
	| {
		kind: "review_task";
		priorityCode: WorkInboxPriorityCode;
		workflowTitle: WorkInboxWorkflowTitle;
		assignee?: string;
	}
	// Assigned/open workflow task: "<status> - @assignee - (เลยกำหนด|ครบกำหนด) <dueDay>"
	| {
		kind: "workflow_task";
		statusCode: WorkflowTaskStatus;
		assignee?: string;
		dueAt?: string;
		overdue?: boolean;
	}
	// QC issue: the structured QC message (code + interpolation values). The
	// consumer localizes it via `resolveQcIssueMessage` instead of rendering the
	// formerly-composed Thai `QcIssue.message`.
	| { kind: "qc"; messageCode: QcMessageCode; messageValues?: QcMessageValues };

// A workflow title descriptor: the stable code plus, for `custom`, the raw
// remaining title text.
export interface WorkInboxWorkflowTitle {
	code: WorkInboxWorkflowTitleCode;
	customTitle?: string;
}

export interface WorkInboxItem {
	id: string;
	kind: WorkInboxKind;
	severity: QcSeverity;
	priority?: WorkflowTask["priority"];
	status?: WorkflowTaskStatus;
	assignee?: string;
	dueAt?: string;
	overdue?: boolean;
	pageIndex?: number;
	/**
	 * Stable, locale-neutral TITLE discriminant. Consumers localize via
	 * `$_("workInbox.title.<titleCode>", { values: { page } })` and compare on
	 * this code instead of string-matching the (formerly Thai) rendered text.
	 */
	titleCode: WorkInboxTitleCode;
	/** Workflow title descriptor — present only when `titleCode === "workflow"`. */
	workflowTitle?: WorkInboxWorkflowTitle;
	/** QC issue code — present only when `titleCode === "qc"`. */
	qcCode?: QcIssue["code"];
	/** Structured, locale-neutral detail; consumers compose the localized string. */
	detail: WorkInboxDetail;
	sourceId: string;
}

// Map a marker status to its stable title code. Same precedence as the old
// `markerTitle()` (failed → retry → accepted+result → needs-review default).
function markerTitleCode(marker: AiReviewMarker): WorkInboxTitleCode {
	if (marker.status === "failed") return "ai_failed";
	if (marker.status === "retry_requested") return "ai_rerun";
	if (marker.status === "accepted" && marker.resultImageId) return "ai_placement";
	return "ai_review";
}

// Map a raw workflow task title to its stable display code. Mirrors the old
// `workflowTaskDisplayTitle()`: recognize the canonical English/Thai production
// titles; otherwise emit `custom` with the page-prefix-stripped remainder.
function workflowTitleDescriptor(task: WorkflowTask): WorkInboxWorkflowTitle {
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

function inboxPriorityCode(priority: WorkflowTask["priority"] | undefined): WorkInboxPriorityCode {
	const normalized = normalizeWorkflowTaskPriority(priority);
	if (normalized === "urgent") return "urgent";
	if (normalized === "high") return "high";
	return "normal";
}

function markerSeverity(marker: AiReviewMarker): QcSeverity {
	return marker.status === "failed" ? "error" : "warning";
}

function markerPriority(marker: AiReviewMarker): WorkflowTask["priority"] {
	return marker.status === "failed" ? "urgent" : "high";
}

function markerDetail(marker: AiReviewMarker): WorkInboxDetail {
	const assignee = normalizeAssigneeHandle(marker.assignee) ?? undefined;
	if (marker.status === "accepted" && marker.resultImageId) {
		return { kind: "ai_placement_ready", assignee };
	}
	// User-facing AI cost is CREDITS, not baht. Carry the raw backend numbers so
	// the consumer (which owns the usage-store conversion/formatting) reproduces
	// the old `formatCreditsCompact(creditUnits ?? thbToCredits(estimatedThb))`
	// exactly. The framework-agnostic helper must not import Svelte stores.
	return {
		kind: "ai_marker",
		tier: marker.tier,
		hasCost: Boolean(marker.costEstimate),
		creditUnits: marker.costEstimate?.creditUnits,
		estimatedThb: marker.costEstimate?.estimatedThb,
		assignee,
	};
}

function hasAiResultLayer(project: ProjectState | null, marker: AiReviewMarker): boolean {
	const page = project?.pages[marker.pageIndex];
	return page?.imageLayers?.some((layer) => layer.id === `ai-result-${marker.id}`) === true;
}

function markerNeedsInbox(project: ProjectState | null, marker: AiReviewMarker): boolean {
	if (marker.status === "failed" || marker.status === "needs_review" || marker.status === "retry_requested") return true;
	if (marker.status === "accepted" && marker.resultImageId) return !hasAiResultLayer(project, marker);
	return false;
}

function buildMarkerItems(project: ProjectState | null, markers: AiReviewMarker[]): WorkInboxItem[] {
	return markers
		.filter((marker) => markerNeedsInbox(project, marker))
		.map((marker) => {
			const assignee = normalizeAssigneeHandle(marker.assignee);
			return {
				id: `ai-marker-${marker.id}`,
				kind: "ai_marker",
				severity: markerSeverity(marker),
				priority: markerPriority(marker),
				assignee: assignee ?? undefined,
				pageIndex: marker.pageIndex,
				titleCode: markerTitleCode(marker),
				detail: markerDetail(marker),
				sourceId: marker.id,
			};
		});
}

function buildCommentItems(comments: ProjectComment[]): WorkInboxItem[] {
	return comments
		.filter((comment) => comment.status === "open")
		.map((comment) => ({
			id: `comment-${comment.id}`,
			kind: "comment",
			severity: "warning",
			pageIndex: comment.pageIndex,
			titleCode: "note",
			detail: { kind: "text", text: comment.body },
			sourceId: comment.id,
		}));
}

function buildReviewTaskItems(tasks: WorkflowTask[]): WorkInboxItem[] {
	return tasks
		.filter((task) => task.type === "review" && task.status === "review")
		.map((task) => {
			const priority = normalizeWorkflowTaskPriority(task.priority);
			const assignee = normalizeAssigneeHandle(task.assignee);
			return {
				id: `review-task-${task.id}`,
				kind: "review_task",
				severity: priority === "urgent" ? "error" : priority === "high" ? "warning" : "info",
				priority,
				assignee: assignee ?? undefined,
				pageIndex: task.pageIndex,
				titleCode: "review_ready",
				detail: {
					kind: "review_task",
					priorityCode: inboxPriorityCode(priority),
					workflowTitle: workflowTitleDescriptor(task),
					assignee: assignee ?? undefined,
				},
				sourceId: task.id,
			};
		});
}

function buildAssignedTaskItems(tasks: WorkflowTask[]): WorkInboxItem[] {
	return tasks
		.filter((task) => {
			if (!isWorkflowTaskOpen(task)) return false;
			if (task.type === "review" && task.status === "review") return false;
			const priority = normalizeWorkflowTaskPriority(task.priority);
			return Boolean(normalizeAssigneeHandle(task.assignee)) || priority === "urgent" || priority === "high" || isWorkflowTaskOverdue(task);
		})
		.map((task) => {
			const priority = normalizeWorkflowTaskPriority(task.priority);
			const assignee = normalizeAssigneeHandle(task.assignee);
			const overdue = isWorkflowTaskOverdue(task);
			return {
				id: `workflow-task-${task.id}`,
				kind: "workflow_task",
				severity: overdue || priority === "urgent" ? "error" : priority === "high" ? "warning" : "info",
				priority,
				status: task.status,
				assignee: assignee ?? undefined,
				dueAt: task.dueAt,
				overdue,
				pageIndex: task.pageIndex,
				titleCode: "workflow",
				workflowTitle: workflowTitleDescriptor(task),
				detail: {
					kind: "workflow_task",
					statusCode: task.status,
					assignee: assignee ?? undefined,
					dueAt: task.dueAt,
					overdue,
				},
				sourceId: task.id,
			};
		});
}

function buildQcItems(report: QcReport): WorkInboxItem[] {
	return report.issues
		.filter((issue) => issue.severity !== "info")
		.map((issue: QcIssue) => ({
			id: `qc-${issue.id}`,
			kind: "qc",
			severity: issue.severity,
			pageIndex: issue.pageIndex,
			titleCode: "qc",
			qcCode: issue.code,
			detail: { kind: "qc", messageCode: issue.messageCode, messageValues: issue.messageValues },
			sourceId: issue.id,
		}));
}

function severityRank(severity: QcSeverity): number {
	const ranks: Record<QcSeverity, number> = {
		error: 0,
		warning: 1,
		info: 2,
	};
	return ranks[severity];
}

export function buildWorkInbox(
	project: ProjectState | null,
	tasks: WorkflowTask[],
	comments: ProjectComment[],
	markers: AiReviewMarker[],
	report: QcReport
): WorkInboxItem[] {
	if (!project) return [];
	return [
		...buildMarkerItems(project, markers),
		...buildCommentItems(comments),
		...buildAssignedTaskItems(tasks),
		...buildReviewTaskItems(tasks),
		...buildQcItems(report),
	]
		.sort((a, b) => {
			const severityDelta = severityRank(a.severity) - severityRank(b.severity);
			if (severityDelta !== 0) return severityDelta;
			const overdueDelta = Number(Boolean(b.overdue)) - Number(Boolean(a.overdue));
			if (overdueDelta !== 0) return overdueDelta;
			const priorityDelta = workflowTaskPriorityRank(a.priority) - workflowTaskPriorityRank(b.priority);
			if (priorityDelta !== 0) return priorityDelta;
			return (a.pageIndex ?? Number.MAX_SAFE_INTEGER) - (b.pageIndex ?? Number.MAX_SAFE_INTEGER);
		})
		.slice(0, 100);
}
