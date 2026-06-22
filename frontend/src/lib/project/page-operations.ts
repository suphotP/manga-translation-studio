import type { PageWorkSummary } from "$lib/project/page-work-summary.js";
import {
	PAGE_REVIEW_APPROVAL_NOT_RECORDED,
	FINAL_QC_HANDOFF_NOT_CLOSED,
} from "$lib/project/page-work-summary.js";
import { exportBlockerCopy } from "$lib/project/page-work-copy.js";
import { requiredCreditMissingHoldReason } from "$lib/project/export-profiles.js";
import type { WorkflowTaskType } from "$lib/types.js";
import { _ } from "$lib/i18n";
import { get } from "svelte/store";

export interface PageMovePlan {
	pageCount: number;
	fromIndex: number;
	toIndex: number;
	moved: boolean;
	indexMap: Record<number, number>;
}

export interface PageMoveResult<T> {
	items: T[];
	plan: PageMovePlan;
}

export interface BatchExportGate {
	pageCount: number;
	readyCount: number;
	holdCount: number;
	canExport: boolean;
	readyPageNumbers: number[];
	holdPageNumbers: number[];
	firstHoldPageIndex: number | null;
	firstHoldReason: string | null;
	message: string;
	/**
	 * All-blockers-all-pages checklist: every distinct blocker type with its total
	 * count and the pages it affects (for jump-to-page). This replaces the
	 * sequential first-hold UX — the export dialog renders this so the reviewer
	 * sees every outstanding type at once, not just the first hold on the first
	 * held page.
	 */
	checklist: ExportChecklistGroup[];
}

// Canonical export-blocker types for the checklist. Mirrors the backend
// readiness blocker types so both surfaces speak the same vocabulary.
export type ExportChecklistType =
	| "asset_not_ready"
	| "untranslated_text"
	| "unresolved_ai_marker"
	| "open_qc_comment"
	| "qc_issue"
	| "review_not_approved"
	| "open_task"
	| "required_credit_missing"
	| "other";

export interface ExportChecklistPageRef {
	pageIndex: number;
	pageNumber: number;
	/** The raw per-page blocker string (already localized via exportBlockerCopy at render). */
	detail: string;
	/** Numeric count parsed from the blocker string when present (e.g. "3 open comments" -> 3), else 1. */
	count: number;
}

export interface ExportChecklistGroup {
	type: ExportChecklistType;
	/** Total instances across all affected pages. */
	count: number;
	/** Affected pages in page order, for jump-to-page. */
	pages: ExportChecklistPageRef[];
}

export function clampPageIndex(index: number, pageCount: number): number {
	if (pageCount <= 0) return 0;
	if (!Number.isFinite(index)) return 0;
	return Math.max(0, Math.min(pageCount - 1, Math.round(index)));
}

export function createPageMovePlan(pageCount: number, fromIndex: number, toIndex: number): PageMovePlan {
	const indexMap: Record<number, number> = {};
	const validFrom = Number.isInteger(fromIndex) && fromIndex >= 0 && fromIndex < pageCount;
	const safeToIndex = clampPageIndex(toIndex, pageCount);
	const moved = pageCount > 1 && validFrom && fromIndex !== safeToIndex;

	for (let index = 0; index < pageCount; index += 1) {
		let nextIndex = index;
		if (moved) {
			if (index === fromIndex) {
				nextIndex = safeToIndex;
			} else if (fromIndex < safeToIndex && index > fromIndex && index <= safeToIndex) {
				nextIndex = index - 1;
			} else if (fromIndex > safeToIndex && index >= safeToIndex && index < fromIndex) {
				nextIndex = index + 1;
			}
		}
		indexMap[index] = nextIndex;
	}

	return {
		pageCount,
		fromIndex,
		toIndex: safeToIndex,
		moved,
		indexMap,
	};
}

export function movePageItems<T>(items: T[], fromIndex: number, toIndex: number): PageMoveResult<T> {
	const plan = createPageMovePlan(items.length, fromIndex, toIndex);
	if (!plan.moved) {
		return { items: [...items], plan };
	}

	const nextItems = [...items];
	const [movedItem] = nextItems.splice(fromIndex, 1);
	nextItems.splice(plan.toIndex, 0, movedItem);
	return { items: nextItems, plan };
}

export function remapPageIndex(pageIndex: number, plan: PageMovePlan): number {
	return plan.indexMap[pageIndex] ?? pageIndex;
}

export function remapOptionalPageIndex(pageIndex: number | undefined, plan: PageMovePlan): number | undefined {
	return pageIndex === undefined ? undefined : remapPageIndex(pageIndex, plan);
}

const PAGE_TASK_ID_RE = /^page-(\d+)-(translate|clean|typeset|review)(-.+)?$/;
const DEFAULT_WORKFLOW_TASK_TITLE_RE = /^(?:Translate|Clean|Typeset|Review) page \d+$|^(?:แปล|คลีน|ไทป์เซ็ต|รีวิว)หน้า \d+$/;
// PERSISTED workflow titles stay canonical English on purpose: work-inbox's
// workflowTitleDescriptor and task-focus-queue's focusWorkflowTitle classify
// default tasks by the `Translate/Clean/Typeset/Review page N` pattern and
// relocalize at DISPLAY time — storing a localized title would flip the task
// to `custom` and freeze its language (codex P2).
const WORKFLOW_TASK_CANONICAL_LABELS: Record<WorkflowTaskType, string> = {
	translate: "Translate",
	clean: "Clean",
	typeset: "Typeset",
	review: "Review",
};

function interpolateFallback(fallback: string, values?: Record<string, string | number>): string {
	if (!values) return fallback;
	return Object.entries(values).reduce(
		(text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
		fallback,
	);
}

function t(key: string, fallback: string, values?: Record<string, string | number>): string {
	try {
		const translate = get(_);
		const value = translate(key, values ? { values } : undefined);
		if (value && value !== key) return value;
	} catch {
		// Locale may be unavailable in isolated unit tests; fall back below.
	}
	return interpolateFallback(fallback, values);
}

export function remapPageTaskId(taskId: string, plan: PageMovePlan): string {
	const match = taskId.match(PAGE_TASK_ID_RE);
	if (!match) return taskId;
	const oldPageIndex = Number(match[1]);
	if (!Number.isInteger(oldPageIndex)) return taskId;
	const nextPageIndex = remapPageIndex(oldPageIndex, plan);
	return `page-${nextPageIndex}-${match[2]}${match[3] ?? ""}`;
}

export function getPageTaskType(taskId: string): WorkflowTaskType | null {
	return (taskId.match(PAGE_TASK_ID_RE)?.[2] as WorkflowTaskType | undefined) ?? null;
}

export function remapOptionalPageTaskId(taskId: string | undefined, plan: PageMovePlan): string | undefined {
	return taskId === undefined ? undefined : remapPageTaskId(taskId, plan);
}

export function remapPageTaskIds(taskIds: string[] | undefined, plan: PageMovePlan): string[] | undefined {
	return taskIds?.map((taskId) => remapPageTaskId(taskId, plan));
}

export function remapWorkflowTaskTitle(
	title: string,
	type: WorkflowTaskType,
	nextPageIndex: number,
): string {
	return DEFAULT_WORKFLOW_TASK_TITLE_RE.test(title)
		? `${WORKFLOW_TASK_CANONICAL_LABELS[type]} page ${nextPageIndex + 1}`
		: title;
}

export function remapPageTaskMetadata(
	metadata: Record<string, unknown> | undefined,
	plan: PageMovePlan,
): Record<string, unknown> | undefined {
	if (!metadata) return metadata;
	const nextMetadata = { ...metadata };
	for (const key of ["taskId", "linkedTaskId", "reviewTaskId"]) {
		if (typeof nextMetadata[key] === "string") {
			nextMetadata[key] = remapPageTaskId(nextMetadata[key], plan);
		}
	}
	if (Array.isArray(nextMetadata.linkedTaskIds)) {
		nextMetadata.linkedTaskIds = nextMetadata.linkedTaskIds.map((item) => (
			typeof item === "string" ? remapPageTaskId(item, plan) : item
		));
	}
	return nextMetadata;
}

/** Parse a leading integer count from a blocker string ("3 open comments" -> 3), else 1. */
function parseBlockerCount(blocker: string): number {
	const match = blocker.match(/^(\d+)\s/);
	if (!match) return 1;
	const value = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Classify a raw per-page blocker string into a canonical checklist type. */
export function classifyExportBlocker(blocker: string): ExportChecklistType {
	if (blocker === requiredCreditMissingHoldReason()) return "required_credit_missing";
	if (blocker === PAGE_REVIEW_APPROVAL_NOT_RECORDED || blocker === FINAL_QC_HANDOFF_NOT_CLOSED) return "review_not_approved";
	if (blocker.startsWith("image asset") || blocker.startsWith("image layer asset")) return "asset_not_ready";
	if (blocker === "no editable text layers" || /untranslated/i.test(blocker)) return "untranslated_text";
	if (/AI (review item|result|layer)/i.test(blocker)) return "unresolved_ai_marker";
	if (/open comment/i.test(blocker)) return "open_qc_comment";
	if (/QC (error|warning)/i.test(blocker)) return "qc_issue";
	if (/(overdue|open) task/i.test(blocker)) return "open_task";
	if (blocker === "review changes requested") return "review_not_approved";
	return "other";
}

/**
 * Build the all-blockers-all-pages checklist from the per-page summaries: group
 * every page's blockers by canonical type, summing counts and collecting the
 * pages each type affects (in page order) for jump-to-page. This is the
 * non-sequential replacement for firstHoldReason.
 */
export function buildExportChecklist(summaries: PageWorkSummary[]): ExportChecklistGroup[] {
	const groups = new Map<ExportChecklistType, ExportChecklistGroup>();
	const order: ExportChecklistType[] = [];
	// Track the page ref per (type,pageIndex) so multiple raw blockers that
	// classify to the same type for one page merge into a single ref (summed
	// count, combined detail) instead of listing the page more than once.
	const pageRefByGroup = new Map<ExportChecklistType, Map<number, ExportChecklistGroup["pages"][number]>>();
	for (const summary of summaries) {
		for (const blocker of summary.exportBlockers) {
			const type = classifyExportBlocker(blocker);
			let group = groups.get(type);
			if (!group) {
				group = { type, count: 0, pages: [] };
				groups.set(type, group);
				pageRefByGroup.set(type, new Map());
				order.push(type);
			}
			const count = parseBlockerCount(blocker);
			group.count += count;
			const refs = pageRefByGroup.get(type)!;
			const existing = refs.get(summary.pageIndex);
			if (existing) {
				existing.count += count;
				if (blocker && existing.detail !== blocker) {
					existing.detail = existing.detail ? `${existing.detail}; ${blocker}` : blocker;
				}
			} else {
				const ref = {
					pageIndex: summary.pageIndex,
					pageNumber: summary.pageNumber,
					detail: blocker,
					count,
				};
				refs.set(summary.pageIndex, ref);
				group.pages.push(ref);
			}
		}
	}
	// Keep pages within each group in page order for predictable jump-to-page.
	for (const group of groups.values()) {
		group.pages.sort((a, b) => a.pageIndex - b.pageIndex);
	}
	return order.map((type) => groups.get(type)!);
}

export function buildBatchExportGate(summaries: PageWorkSummary[]): BatchExportGate {
	const readySummaries = summaries.filter((summary) => summary.exportReady);
	const holdSummaries = summaries.filter((summary) => !summary.exportReady);
	const firstHold = holdSummaries[0] ?? null;
	const firstHoldReason = firstHold?.exportBlockers[0] ?? null;
	const pageCount = summaries.length;
	const holdCount = holdSummaries.length;
	const readyCount = readySummaries.length;
	const checklist = buildExportChecklist(summaries);

	if (!pageCount) {
		return {
			pageCount: 0,
			readyCount: 0,
			holdCount: 0,
			canExport: false,
			readyPageNumbers: [],
			holdPageNumbers: [],
			firstHoldPageIndex: null,
			firstHoldReason: null,
			message: t("pageOperations.batchExport.empty", "ไม่มีหน้าในขอบเขตส่งออกตอนนี้"),
			checklist,
		};
	}

	if (holdCount > 0 && firstHold) {
		return {
			pageCount,
			readyCount,
			holdCount,
			canExport: false,
			readyPageNumbers: readySummaries.map((summary) => summary.pageNumber),
			holdPageNumbers: holdSummaries.map((summary) => summary.pageNumber),
			firstHoldPageIndex: firstHold.pageIndex,
			firstHoldReason,
			message: t(
				"pageOperations.batchExport.blocked",
				"ส่งออกยังไม่พร้อม: {holdCount} หน้าต้องเคลียร์ {checklistCount} รายการ",
				{ holdCount, checklistCount: checklist.length },
			),
			checklist,
		};
	}

	return {
		pageCount,
		readyCount,
		holdCount: 0,
		canExport: true,
		readyPageNumbers: readySummaries.map((summary) => summary.pageNumber),
		holdPageNumbers: [],
		firstHoldPageIndex: null,
		firstHoldReason: null,
		message: t("pageOperations.batchExport.ready", "ส่งออกพร้อมแล้ว: {pageCount} หน้า", { pageCount }),
		checklist: [],
	};
}
