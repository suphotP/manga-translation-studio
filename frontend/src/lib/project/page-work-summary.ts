import type { PageAssetIntegrity } from "$lib/project/page-assets.js";
import { normalizeAssigneeHandle } from "$lib/project/assignees.js";
import type { QcIssue, QcMessageCode, QcMessageValues } from "$lib/project/qc-checks.js";
import {
	countTasksByPriority,
	highestWorkflowTaskPriority,
	workflowTaskPriorityLabel,
} from "$lib/project/task-priority.js";
import {
	isWorkflowTaskOpen,
	summarizeWorkflowTaskDue,
} from "$lib/project/task-due.js";
import type {
	AiReviewMarker,
	Page,
	PageReviewDecision,
	ProductionMode,
	ProjectComment,
	WorkflowTask,
	WorkflowTaskPriority,
} from "$lib/types.js";

export type PageWorkStatus = "blocked" | "review" | "working" | "ready" | "empty";
export const PAGE_REVIEW_APPROVAL_NOT_RECORDED = "page review approval not recorded";
export const FINAL_QC_HANDOFF_NOT_CLOSED = "final QC handoff not closed";

export interface PageWorkSummary {
	pageIndex: number;
	pageNumber: number;
	name: string;
	layerCount: number;
	status: PageWorkStatus;
	statusLabel: string;
	nextAction: string;
	primarySignal: PageWorkPrimarySignal;
	assetIntegrity: PageAssetIntegrity | null;
	qcErrorCount: number;
	qcWarningCount: number;
	openCommentCount: number;
	aiAttentionCount: number;
	taskTotalCount: number;
	taskOpenCount: number;
	urgentTaskCount: number;
	highTaskCount: number;
	dueTaskCount: number;
	overdueTaskCount: number;
	nextDueAt: string | null;
	highestTaskPriority: WorkflowTaskPriority;
	priorityLabel: string;
	assignees: string[];
	latestReviewDecision: PageReviewDecision | null;
	exportReady: boolean;
	exportBlockers: string[];
}

/**
 * Stable, locale-independent CODE for the primary-signal headline. One code per
 * distinct headline; consumers localize via `$_("pageSignal.<code>", { values })`.
 * Unlike `kind` (which buckets the `ai-placement` variants together for action
 * routing), each label code is 1:1 with the rendered headline — so the
 * `ai-accepted-unplaced` vs `ai-applied-missing` distinction (formerly carried by
 * a Thai-substring test) is now a pure code comparison.
 */
export type PageWorkPrimarySignalLabelCode =
	| "asset"
	| "qc-error"
	| "ai-accepted-unplaced"
	| "ai-applied-missing"
	| "ai-review"
	| "review-change"
	| "comment"
	| "task-overdue"
	| "task-open"
	| "review-approval"
	| "final-qc"
	| "qc-warning"
	| "text-empty"
	| "ready";

export interface PageWorkPrimarySignal {
	kind:
		| "asset"
		| "ai-review"
		| "ai-placement"
		| "qc-error"
		| "review-change"
		| "comment"
		| "task-overdue"
		| "task-open"
		| "review-approval"
		| "final-qc"
		| "qc-warning"
		| "text-empty"
		| "ready";
	severity: "error" | "warning" | "info" | "ready";
	/**
	 * Stable headline CODE the consumer localizes via
	 * `$_("pageSignal.<labelCode>", { values: labelValues })`. Replaces the former
	 * pre-built Thai `label`.
	 */
	labelCode: PageWorkPrimarySignalLabelCode;
	/** Interpolation counts for count-bearing headlines (e.g. `{ n: qcErrorCount }`). */
	labelValues?: { n: number };
	/**
	 * Free-text detail line (comment body, task title, marker label, asset detail —
	 * all raw upstream text). When the detail is a QC issue message, it is carried
	 * structurally in {@link detailQc} instead so the consumer can localize it; in
	 * that case `detail` holds only the non-localized fallback (`status.nextAction`).
	 */
	detail: string;
	/**
	 * Structured QC message for a QC-sourced detail, localized by the consumer via
	 * `resolveQcIssueMessage`. Replaces the formerly-prebuilt Thai `QcIssue.message`
	 * that used to flow straight into {@link detail}.
	 */
	detailQc?: { messageCode: QcMessageCode; messageValues?: QcMessageValues };
	pageIndex: number;
	sourceId?: string;
	sourceKind?: "asset" | "ai_marker" | "qc" | "comment" | "task" | "review_decision";
	focusFilter?: "blockers" | "comments" | "workflow" | "review" | "ai-qc" | "all";
	actionKind: "open-editor" | "open-focus" | "open-ai-marker" | "relink-asset" | "open-work" | "export";
}

export interface PageBatchSummary {
	pageCount: number;
	layerCount: number;
	exportReadyCount: number;
	blockedCount: number;
	reviewCount: number;
	attentionCount: number;
	assetScanningCount: number;
	assetBlockedCount: number;
	commentCount: number;
	aiAttentionCount: number;
	urgentTaskCount: number;
	highTaskCount: number;
	dueTaskCount: number;
	overdueTaskCount: number;
}

export const EMPTY_PAGE_BATCH_SUMMARY: PageBatchSummary = {
	pageCount: 0,
	layerCount: 0,
	exportReadyCount: 0,
	blockedCount: 0,
	reviewCount: 0,
	attentionCount: 0,
	assetScanningCount: 0,
	assetBlockedCount: 0,
	commentCount: 0,
	aiAttentionCount: 0,
	urgentTaskCount: 0,
	highTaskCount: 0,
	dueTaskCount: 0,
	overdueTaskCount: 0,
};

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export interface PageWorkSummaryInput {
	page: Page;
	pageIndex: number;
	layerCount?: number;
	assetIntegrity?: PageAssetIntegrity | null;
	qcIssues?: QcIssue[];
	tasks?: WorkflowTask[];
	comments?: ProjectComment[];
	aiReviewMarkers?: AiReviewMarker[];
	reviewDecisions?: PageReviewDecision[];
	productionMode?: ProductionMode;
}

const ACTIVE_AI_MARKER_STATUSES = new Set(["failed", "needs_review", "retry_requested"] as const);

export function formatPageWorkName(page: Page, pageIndex: number): string {
	const sourceName = page.originalName || page.imageName || `Page ${pageIndex + 1}`;
	return sourceName.replace(/\.[^.]+$/, "") || `Page ${pageIndex + 1}`;
}

export function resolveVisiblePageLayerCount(
	page: Page,
	isCurrentPage: boolean,
	liveTextLayerCount: number,
	editorHasPageImage: boolean,
): number {
	if (!isCurrentPage) return page.textLayers?.length ?? 0;
	return editorHasPageImage ? liveTextLayerCount : page.textLayers?.length ?? 0;
}

function compareUpdatedAtDesc(a: PageReviewDecision, b: PageReviewDecision): number {
	return Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || "");
}

function getLatestReviewDecision(decisions: PageReviewDecision[]): PageReviewDecision | null {
	if (!decisions.length) return null;
	return [...decisions].sort(compareUpdatedAtDesc)[0] ?? null;
}

function uniqueSortedAssignees(tasks: WorkflowTask[], markers: AiReviewMarker[]): string[] {
	const assignees = new Set<string>();
	for (const task of tasks) {
		const assignee = normalizeAssigneeHandle(task.assignee);
		if (assignee) assignees.add(assignee);
	}
	for (const marker of markers) {
		const assignee = normalizeAssigneeHandle(marker.assignee);
		if (assignee) assignees.add(assignee);
	}
	return [...assignees].sort((a, b) => a.localeCompare(b));
}

function reviewNextAction(overdueTaskCount: number, openCommentCount: number): string {
	if (overdueTaskCount > 0) return "Clear overdue task handoff";
	if (openCommentCount > 0) return "Resolve open review notes";
	return "Clear warnings or task handoff";
}

function firstAiReviewNextAction(aiReviewBlockers: string[]): string {
	const firstBlocker = aiReviewBlockers[0] ?? "";
	if (firstBlocker.includes("accepted AI result not placed")) return "Place accepted AI result layer";
	if (firstBlocker.includes("applied AI layer missing")) return "Recover missing applied AI layer";
	if (firstBlocker.includes("AI review item")) return "Review AI result";
	return "Fix blocking QC or AI item";
}

function resolveStatus(
	page: Page,
	layerCount: number,
	assetIntegrity: PageAssetIntegrity | null,
	qcErrorCount: number,
	qcWarningCount: number,
	openCommentCount: number,
	aiAttentionCount: number,
	aiReviewBlockers: string[],
	taskOpenCount: number,
	overdueTaskCount: number,
	latestReviewDecision: PageReviewDecision | null,
	productionMode: ProductionMode,
): Pick<PageWorkSummary, "status" | "statusLabel" | "nextAction"> {
	if (
		assetIntegrity?.status === "missing"
		|| assetIntegrity?.status === "failed"
		|| assetIntegrity?.status === "scanning"
		|| assetIntegrity?.status === "blocked"
		|| assetIntegrity?.status === "unknown"
		|| qcErrorCount > 0
		|| aiAttentionCount > 0
	) {
		return {
			status: "blocked",
			statusLabel: "Blocked",
			nextAction: assetIntegrity?.status === "missing" || assetIntegrity?.status === "failed"
				? "Relink or restore page image"
				: assetIntegrity?.status === "scanning"
						? "Wait for asset scan or moderation review"
					: assetIntegrity?.status === "blocked"
						? "Replace blocked page image"
						: assetIntegrity?.status === "unknown"
							? "Retry asset inventory check"
							: aiReviewBlockers.length > 0
								? firstAiReviewNextAction(aiReviewBlockers)
								: "Fix blocking QC or AI item",
		};
	}

	if (
		openCommentCount > 0
		|| latestReviewDecision?.status === "changes_requested"
		|| pageNeedsReviewApproval(page, latestReviewDecision, productionMode)
		|| pageNeedsFinalQcHandoff(page, latestReviewDecision, productionMode)
		|| taskOpenCount > 0
		|| qcWarningCount > 0
	) {
		return {
			status: "review",
			statusLabel: "Review",
			nextAction: pageNeedsReviewApproval(page, latestReviewDecision, productionMode) && taskOpenCount === 0
				? "Approve page review"
				: pageNeedsFinalQcHandoff(page, latestReviewDecision, productionMode)
				? "Close final QC handoff"
				: reviewNextAction(overdueTaskCount, openCommentCount),
		};
	}

	if (layerCount === 0) {
		return {
			status: "empty",
			statusLabel: "No text",
			nextAction: "Add or import editable text layers",
		};
	}

	return {
		status: "ready",
		statusLabel: "Ready",
		nextAction: "Ready for export review",
	};
}

function hasAiResultLayer(page: Page, marker: AiReviewMarker): boolean {
	return page.imageLayers?.some((layer) => layer.id === `ai-result-${marker.id}`) === true;
}

function markerNeedsExportAttention(page: Page, marker: AiReviewMarker): boolean {
	if (ACTIVE_AI_MARKER_STATUSES.has(marker.status)) return true;
	if (!marker.resultImageId) return false;
	if (marker.status === "accepted") return !hasAiResultLayer(page, marker);
	if (marker.status === "applied") return !hasAiResultLayer(page, marker);
	return false;
}

function buildAiReviewExportBlockers(page: Page, markers: AiReviewMarker[]): string[] {
	const activeCount = markers.filter((marker) => ACTIVE_AI_MARKER_STATUSES.has(marker.status)).length;
	const acceptedUnplacedCount = markers.filter((marker) => (
		marker.status === "accepted"
		&& Boolean(marker.resultImageId)
		&& !hasAiResultLayer(page, marker)
	)).length;
	const appliedMissingCount = markers.filter((marker) => (
		marker.status === "applied"
		&& Boolean(marker.resultImageId)
		&& !hasAiResultLayer(page, marker)
	)).length;
	const blockers: string[] = [];
	if (activeCount > 0) blockers.push(pluralize(activeCount, "AI review item"));
	if (acceptedUnplacedCount > 0) blockers.push(pluralize(acceptedUnplacedCount, "accepted AI result not placed", "accepted AI results not placed"));
	if (appliedMissingCount > 0) blockers.push(pluralize(appliedMissingCount, "applied AI layer missing", "applied AI layers missing"));
	return blockers;
}

function imageLayerMissingAssetBlocker(page: Page, pageQcIssues: QcIssue[]): { blocker: string; issueCount: number } | null {
	const issues = pageQcIssues.filter((item) => (
		item.code === "image_layer_missing_asset"
		|| item.code === "image_layer_asset_missing_from_inventory"
	));
	const issue = issues[0];
	if (!issue) return null;
	const layer = page.imageLayers?.find((item) => item.id === issue.layerId);
	const layerName = layer?.name || layer?.originalName || layer?.imageName || issue.layerId || "รูปเสริม";
	return {
		blocker: issue.code === "image_layer_asset_missing_from_inventory"
			? `image layer asset missing from inventory: ${layerName}`
			: `image layer asset missing: ${layerName}`,
		issueCount: issues.length,
	};
}

function buildExportBlockers(
	page: Page,
	assetIntegrity: PageAssetIntegrity | null,
	pageQcIssues: QcIssue[],
	qcErrorCount: number,
	qcWarningCount: number,
	openCommentCount: number,
	aiReviewBlockers: string[],
	latestReviewDecision: PageReviewDecision | null,
	productionMode: ProductionMode,
): string[] {
	const blockers: string[] = [];

	if (assetIntegrity?.status === "scanning") blockers.push("image asset still scanning");
	if (assetIntegrity?.status === "unknown") blockers.push("image asset inventory unknown");
	if (assetIntegrity?.status === "missing" || assetIntegrity?.status === "failed" || assetIntegrity?.status === "blocked") {
		blockers.push("image asset not ready");
	}
	const scopedMissingImageAsset = imageLayerMissingAssetBlocker(page, pageQcIssues);
	if (scopedMissingImageAsset) blockers.push(scopedMissingImageAsset.blocker);
	const remainingQcErrorCount = qcErrorCount - (scopedMissingImageAsset?.issueCount ?? 0);
	if (remainingQcErrorCount > 0) blockers.push(pluralize(remainingQcErrorCount, "QC error"));
	blockers.push(...aiReviewBlockers);
	if (latestReviewDecision?.status === "changes_requested") blockers.push("review changes requested");
	if (openCommentCount > 0) blockers.push(pluralize(openCommentCount, "open comment"));
	// NOTE: open/overdue workflow tasks are NOT export blockers. Every new chapter
	// is auto-seeded with default open "todo" tasks (clean/translate/typeset/review),
	// so blocking on their mere existence makes a perfectly exportable chapter
	// un-exportable. The backend readiness contract (computeExportReadiness) does NOT
	// gate on these per-page tasks — it gates on the workflow WORK-STATE
	// (approved/released), which is surfaced separately via the review-approval /
	// final-QC handoff blockers below. So we only keep the genuine work-state gate.
	if (pageNeedsReviewApproval(page, latestReviewDecision, productionMode)) blockers.push(PAGE_REVIEW_APPROVAL_NOT_RECORDED);
	if (qcWarningCount > 0) blockers.push(pluralize(qcWarningCount, "QC warning"));
	// NOTE: "no editable text layers" is NOT an export blocker. Art-only,
	// cleaning-only, and SFX pages legitimately carry no dialogue/text layers yet are
	// fully exportable (the raw/edited page image still renders). The backend
	// readiness contract intentionally does NOT flag zero-text pages
	// (countUntranslatedRegions skips them), so the FE gate must not either.
	if (pageNeedsFinalQcHandoff(page, latestReviewDecision, productionMode)) blockers.push(FINAL_QC_HANDOFF_NOT_CLOSED);

	return blockers;
}

function buildPrimarySignal(input: {
	page: Page;
	pageIndex: number;
	layerCount: number;
	assetIntegrity: PageAssetIntegrity | null;
	pageQcIssues: QcIssue[];
	pageTasks: WorkflowTask[];
	pageComments: ProjectComment[];
	pageMarkers: AiReviewMarker[];
	qcErrorCount: number;
	qcWarningCount: number;
	openCommentCount: number;
	aiAttentionCount: number;
	taskOpenCount: number;
	overdueTaskCount: number;
	latestReviewDecision: PageReviewDecision | null;
	productionMode: ProductionMode;
	status: Pick<PageWorkSummary, "nextAction">;
}): PageWorkPrimarySignal {
	const {
		page,
		pageIndex,
		layerCount,
		assetIntegrity,
		pageQcIssues,
		pageTasks,
		pageComments,
		pageMarkers,
		qcErrorCount,
		qcWarningCount,
		openCommentCount,
		aiAttentionCount,
		taskOpenCount,
		overdueTaskCount,
		latestReviewDecision,
		productionMode,
		status,
	} = input;
	const base = { pageIndex };
	const assetBlocked = assetIntegrity && assetIntegrity.status !== "ready";
	if (assetBlocked) {
		return {
			...base,
			kind: "asset",
			severity: assetIntegrity.status === "scanning" ? "warning" : "error",
			labelCode: "asset",
			detail: assetIntegrity.detail || status.nextAction,
			sourceKind: "asset",
			focusFilter: "blockers",
			actionKind: assetIntegrity.status === "missing" || assetIntegrity.status === "failed" ? "relink-asset" : "open-focus",
		};
	}
	if (qcErrorCount > 0) {
		const issue = pageQcIssues.find((item) => item.severity === "error");
		return {
			...base,
			kind: "qc-error",
			severity: "error",
			labelCode: "qc-error",
			labelValues: { n: qcErrorCount },
			detail: status.nextAction,
			...(issue ? { detailQc: { messageCode: issue.messageCode, messageValues: issue.messageValues } } : {}),
			sourceId: issue?.id,
			sourceKind: "qc",
			focusFilter: "blockers",
			actionKind: "open-focus",
		};
	}
	if (aiAttentionCount > 0) {
		const marker = pageMarkers.find((item) => markerNeedsExportAttention(page, item));
		const acceptedUnplaced = marker?.status === "accepted" && Boolean(marker.resultImageId) && !hasAiResultLayer(page, marker);
		const appliedMissing = marker?.status === "applied" && Boolean(marker.resultImageId) && !hasAiResultLayer(page, marker);
		return {
			...base,
			kind: acceptedUnplaced || appliedMissing ? "ai-placement" : "ai-review",
			severity: "error",
			labelCode: acceptedUnplaced
				? "ai-accepted-unplaced"
				: appliedMissing
					? "ai-applied-missing"
					: "ai-review",
			...(acceptedUnplaced || appliedMissing ? {} : { labelValues: { n: aiAttentionCount } }),
			detail: marker?.label || status.nextAction,
			sourceId: marker?.id,
			sourceKind: "ai_marker",
			focusFilter: "ai-qc",
			actionKind: marker?.id ? "open-ai-marker" : "open-focus",
		};
	}
	if (latestReviewDecision?.status === "changes_requested") {
		return {
			...base,
			kind: "review-change",
			severity: "warning",
			labelCode: "review-change",
			detail: latestReviewDecision.note || status.nextAction,
			sourceId: latestReviewDecision.id,
			sourceKind: "review_decision",
			focusFilter: "review",
			actionKind: "open-focus",
		};
	}
	if (openCommentCount > 0) {
		const comment = pageComments.find((item) => item.status === "open");
		return {
			...base,
			kind: "comment",
			severity: "warning",
			labelCode: "comment",
			labelValues: { n: openCommentCount },
			detail: comment?.body ?? status.nextAction,
			sourceId: comment?.id,
			sourceKind: "comment",
			focusFilter: "comments",
			actionKind: "open-focus",
		};
	}
	if (overdueTaskCount > 0) {
		const task = pageTasks.find((item) => isWorkflowTaskOpen(item) && summarizeWorkflowTaskDue([item]).overdueTaskCount > 0);
		return {
			...base,
			kind: "task-overdue",
			severity: "warning",
			labelCode: "task-overdue",
			labelValues: { n: overdueTaskCount },
			detail: task?.title ?? status.nextAction,
			sourceId: task?.id,
			sourceKind: "task",
			focusFilter: "workflow",
			actionKind: "open-focus",
		};
	}
	if (taskOpenCount > 0) {
		const task = pageTasks.find(isWorkflowTaskOpen);
		return {
			...base,
			kind: "task-open",
			severity: "info",
			labelCode: "task-open",
			labelValues: { n: taskOpenCount },
			detail: task?.title ?? status.nextAction,
			sourceId: task?.id,
			sourceKind: "task",
			focusFilter: "workflow",
			actionKind: "open-focus",
		};
	}
	if (pageNeedsReviewApproval(page, latestReviewDecision, productionMode)) {
		return {
			...base,
			kind: "review-approval",
			severity: "warning",
			labelCode: "review-approval",
			detail: status.nextAction,
			sourceKind: "review_decision",
			focusFilter: "review",
			actionKind: "open-focus",
		};
	}
	if (pageNeedsFinalQcHandoff(page, latestReviewDecision, productionMode)) {
		return {
			...base,
			kind: "final-qc",
			severity: "warning",
			labelCode: "final-qc",
			detail: status.nextAction,
			sourceKind: "review_decision",
			focusFilter: "review",
			actionKind: "open-focus",
		};
	}
	if (qcWarningCount > 0) {
		const issue = pageQcIssues.find((item) => item.severity === "warning");
		return {
			...base,
			kind: "qc-warning",
			severity: "warning",
			labelCode: "qc-warning",
			labelValues: { n: qcWarningCount },
			detail: status.nextAction,
			...(issue ? { detailQc: { messageCode: issue.messageCode, messageValues: issue.messageValues } } : {}),
			sourceId: issue?.id,
			sourceKind: "qc",
			focusFilter: "ai-qc",
			actionKind: "open-focus",
		};
	}
	if (layerCount === 0) {
		return {
			...base,
			kind: "text-empty",
			severity: "info",
			labelCode: "text-empty",
			detail: status.nextAction,
			focusFilter: "all",
			actionKind: "open-editor",
		};
	}
	return {
		...base,
		kind: "ready",
		severity: "ready",
		labelCode: "ready",
		detail: status.nextAction,
		actionKind: "export",
	};
}

function pageUsesFinalQcHandoff(page: Page, productionMode: ProductionMode): boolean {
	return productionMode === "team" || Boolean(
		page.cleaningHandoff
		|| page.translationHandoff
		|| page.translationScriptSlots?.length
		|| page.textLayers?.some((layer) => layer.sourceProvider?.startsWith("translation-slot:")),
	);
}

function pageNeedsFinalQcHandoff(page: Page, latestReviewDecision: PageReviewDecision | null, productionMode: ProductionMode): boolean {
	return pageUsesFinalQcHandoff(page, productionMode)
		&& latestReviewDecision?.status === "approved"
		&& page.qcHandoff?.status !== "ready";
}

function pageNeedsReviewApproval(page: Page, latestReviewDecision: PageReviewDecision | null, productionMode: ProductionMode): boolean {
	return pageUsesFinalQcHandoff(page, productionMode)
		&& latestReviewDecision?.status !== "approved";
}

export function summarizePageWork(input: PageWorkSummaryInput): PageWorkSummary {
	const {
		page,
		pageIndex,
		layerCount = page.textLayers?.length ?? 0,
		assetIntegrity = null,
		qcIssues = [],
		tasks = [],
		comments = [],
		aiReviewMarkers = [],
		reviewDecisions = [],
		productionMode = "solo",
	} = input;

	const pageQcIssues = qcIssues.filter((issue) => issue.pageIndex === pageIndex);
	const pageTasks = tasks.filter((task) => task.pageIndex === pageIndex);
	const pageComments = comments.filter((comment) => comment.pageIndex === pageIndex);
	const pageMarkers = aiReviewMarkers.filter((marker) => marker.pageIndex === pageIndex);
	const pageReviewDecisions = reviewDecisions.filter((decision) => decision.pageIndex === pageIndex);

	const qcErrorCount = pageQcIssues.filter((issue) => issue.severity === "error").length;
	const qcWarningCount = pageQcIssues.filter((issue) => issue.severity === "warning").length;
	// The "page has no editable text layers" condition is ALSO surfaced by the QC
	// engine as a `page_without_text` warning. It is NOT a real export blocker
	// (art-only / cleaning-only / SFX pages are legitimately exportable, and the
	// backend readiness contract never flags text-less pages), so exclude it from
	// the warning count that gates export. It still counts toward the status/signal
	// warning count above, so the work board keeps surfacing it as a soft hint.
	const exportQcWarningCount = pageQcIssues.filter(
		(issue) => issue.severity === "warning" && issue.code !== "page_without_text",
	).length;
	const openCommentCount = pageComments.filter((comment) => comment.status === "open").length;
	const aiAttentionCount = pageMarkers.filter((marker) => markerNeedsExportAttention(page, marker)).length;
	const aiReviewBlockers = buildAiReviewExportBlockers(page, pageMarkers);
	const openTasks = pageTasks.filter(isWorkflowTaskOpen);
	const taskOpenCount = openTasks.length;
	const taskPriorityCounts = countTasksByPriority(openTasks);
	const highestTaskPriority = highestWorkflowTaskPriority(openTasks);
	const dueSummary = summarizeWorkflowTaskDue(openTasks);
	const latestReviewDecision = getLatestReviewDecision(pageReviewDecisions);
	const exportBlockers = buildExportBlockers(
		page,
		assetIntegrity,
		pageQcIssues,
		qcErrorCount,
		exportQcWarningCount,
		openCommentCount,
		aiReviewBlockers,
		latestReviewDecision,
		productionMode,
	);
	const status = resolveStatus(
		page,
		layerCount,
		assetIntegrity,
		qcErrorCount,
		qcWarningCount,
		openCommentCount,
		aiAttentionCount,
		aiReviewBlockers,
		taskOpenCount,
		dueSummary.overdueTaskCount,
		latestReviewDecision,
		productionMode,
	);
	const primarySignal = buildPrimarySignal({
		page,
		pageIndex,
		layerCount,
		assetIntegrity,
		pageQcIssues,
		pageTasks,
		pageComments,
		pageMarkers,
		qcErrorCount,
		qcWarningCount,
		openCommentCount,
		aiAttentionCount,
		taskOpenCount,
		overdueTaskCount: dueSummary.overdueTaskCount,
		latestReviewDecision,
		productionMode,
		status,
	});

	return {
		pageIndex,
		pageNumber: pageIndex + 1,
		name: formatPageWorkName(page, pageIndex),
		layerCount,
		...status,
		primarySignal,
		assetIntegrity,
		qcErrorCount,
		qcWarningCount,
		openCommentCount,
		aiAttentionCount,
		taskTotalCount: pageTasks.length,
		taskOpenCount,
		urgentTaskCount: taskPriorityCounts.urgent,
		highTaskCount: taskPriorityCounts.high,
		dueTaskCount: dueSummary.dueTaskCount,
		overdueTaskCount: dueSummary.overdueTaskCount,
		nextDueAt: dueSummary.nextDueAt,
		highestTaskPriority,
		priorityLabel: workflowTaskPriorityLabel(highestTaskPriority),
		assignees: uniqueSortedAssignees(pageTasks, pageMarkers),
		latestReviewDecision,
		exportReady: exportBlockers.length === 0,
		exportBlockers,
	};
}

export interface PageWorkBatchInput {
	pages: Page[];
	/** Per-page asset integrity. Called once per page index; keep it O(1) per page. */
	assetIntegrityFor?: (pageIndex: number) => PageAssetIntegrity | null;
	/** Per-page layer count override (e.g. live editor layers for the open page). */
	layerCountFor?: (page: Page, pageIndex: number) => number | undefined;
	qcIssues?: QcIssue[];
	tasks?: WorkflowTask[];
	comments?: ProjectComment[];
	aiReviewMarkers?: AiReviewMarker[];
	reviewDecisions?: PageReviewDecision[];
	productionMode?: ProductionMode;
}

function bucketByPageIndex<T extends { pageIndex?: number }>(records: T[]): Map<number, T[]> {
	const buckets = new Map<number, T[]>();
	for (const record of records) {
		const pageIndex = record.pageIndex;
		// Records with a non-numeric pageIndex (e.g. QcIssue.pageIndex is optional) never
		// matched the original `record.pageIndex === pageIndex` per-page filter, so they
		// belong to no page bucket — drop them to keep output identical.
		if (typeof pageIndex !== "number") continue;
		const existing = buckets.get(pageIndex);
		if (existing) existing.push(record);
		else buckets.set(pageIndex, [record]);
	}
	return buckets;
}

const EMPTY_QC_ISSUES: readonly QcIssue[] = [];
const EMPTY_TASKS: readonly WorkflowTask[] = [];
const EMPTY_COMMENTS: readonly ProjectComment[] = [];
const EMPTY_MARKERS: readonly AiReviewMarker[] = [];
const EMPTY_REVIEW_DECISIONS: readonly PageReviewDecision[] = [];

/**
 * Bulk-summarize every page of a chapter in O(pages + records) instead of the
 * O(pages × records) you get from calling {@link summarizePageWork} in a loop
 * (each call would re-scan the full tasks/comments/markers/decisions/qc arrays).
 *
 * We bucket every per-record collection by `pageIndex` ONCE, then hand each page
 * only its own bucket. Because {@link summarizePageWork} re-filters its inputs by
 * `pageIndex`, feeding it an already-page-scoped bucket yields byte-identical
 * {@link PageWorkSummary} output to the unbucketed per-page path — the bucketing is
 * a pure pre-grouping, not a behavior change.
 */
export function summarizePageWorkBatch(input: PageWorkBatchInput): PageWorkSummary[] {
	const {
		pages,
		assetIntegrityFor,
		layerCountFor,
		qcIssues = EMPTY_QC_ISSUES as QcIssue[],
		tasks = EMPTY_TASKS as WorkflowTask[],
		comments = EMPTY_COMMENTS as ProjectComment[],
		aiReviewMarkers = EMPTY_MARKERS as AiReviewMarker[],
		reviewDecisions = EMPTY_REVIEW_DECISIONS as PageReviewDecision[],
		productionMode = "solo",
	} = input;

	const qcByPage = bucketByPageIndex(qcIssues);
	const tasksByPage = bucketByPageIndex(tasks);
	const commentsByPage = bucketByPageIndex(comments);
	const markersByPage = bucketByPageIndex(aiReviewMarkers);
	const decisionsByPage = bucketByPageIndex(reviewDecisions);

	return pages.map((page, pageIndex) => summarizePageWork({
		page,
		pageIndex,
		layerCount: layerCountFor?.(page, pageIndex),
		assetIntegrity: assetIntegrityFor?.(pageIndex) ?? null,
		qcIssues: qcByPage.get(pageIndex),
		tasks: tasksByPage.get(pageIndex),
		comments: commentsByPage.get(pageIndex),
		aiReviewMarkers: markersByPage.get(pageIndex),
		reviewDecisions: decisionsByPage.get(pageIndex),
		productionMode,
	}));
}

export function pageNeedsAttention(summary: PageWorkSummary): boolean {
	return summary.status !== "ready";
}

export function summarizePageBatch(summaries: PageWorkSummary[]): PageBatchSummary {
	if (!summaries.length) return EMPTY_PAGE_BATCH_SUMMARY;

	return summaries.reduce<PageBatchSummary>((batch, summary) => ({
		pageCount: batch.pageCount + 1,
		layerCount: batch.layerCount + summary.layerCount,
		exportReadyCount: batch.exportReadyCount + (summary.exportReady ? 1 : 0),
		blockedCount: batch.blockedCount + (summary.status === "blocked" ? 1 : 0),
		reviewCount: batch.reviewCount + (summary.status === "review" ? 1 : 0),
		attentionCount: batch.attentionCount + (pageNeedsAttention(summary) ? 1 : 0),
		assetScanningCount: batch.assetScanningCount + (summary.assetIntegrity?.status === "scanning" ? 1 : 0),
		assetBlockedCount: batch.assetBlockedCount + (summary.assetIntegrity?.status === "blocked" ? 1 : 0),
		commentCount: batch.commentCount + summary.openCommentCount,
		aiAttentionCount: batch.aiAttentionCount + summary.aiAttentionCount,
		urgentTaskCount: batch.urgentTaskCount + summary.urgentTaskCount,
		highTaskCount: batch.highTaskCount + summary.highTaskCount,
		dueTaskCount: batch.dueTaskCount + summary.dueTaskCount,
		overdueTaskCount: batch.overdueTaskCount + summary.overdueTaskCount,
	}), { ...EMPTY_PAGE_BATCH_SUMMARY });
}
