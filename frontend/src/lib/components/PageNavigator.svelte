<script lang="ts">
	import { tick } from "svelte";
	import { _ } from "$lib/i18n";
	import * as api from "$lib/api/client.ts";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import {
		computeVirtualWindow,
		scrollOffsetForIndex,
		shouldVirtualize,
		DEFAULT_OVERSCAN,
	} from "$lib/project/list-virtualization.js";
	import type { PageAssetIntegrity } from "$lib/project/page-assets.js";
	import type { QcIssue } from "$lib/project/qc-checks.js";
	import {
		buildChapterDashboard,
		type ChapterDashboardLaneId,
	} from "$lib/project/chapter-dashboard.js";
	import {
		type BatchExportGate,
	} from "$lib/project/page-operations.js";
	import {
		formatExportRunMessage as formatProjectExportRunMessage,
		formatExportRunPages,
		formatExportRunSize,
		getExportRunPageScope,
		getVisibleExportHistoryRuns,
	} from "$lib/project/export-runs.js";
	import {
		batchExportActionTargetLabel,
		exportRetryActionLabel,
		exportRunTargetProfileLabel,
		requiredCreditMissingHoldReason,
	} from "$lib/project/export-profiles.js";
	import {
		formatPageWorkName,
		pageNeedsAttention,
		resolveVisiblePageLayerCount,
		summarizePageBatch,
		summarizePageWork,
		summarizePageWorkBatch,
		type PageBatchSummary,
		type PageWorkSummary,
	} from "$lib/project/page-work-summary.js";
	import { formatAssigneeHandle, normalizeAssigneeHandle } from "$lib/project/assignees.js";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.js";
	import { SUPPORTED_IMAGE_ACCEPT } from "$lib/project/file-order.js";
	import { pageImageRelinkOrderFallbackCancelMessage } from "$lib/project/page-relink-confirmation.js";
	import { pageRelinkConfirmationStore } from "$lib/stores/page-relink-confirmation.svelte.ts";
	import LockOwnerIndicator from "./ui/LockOwnerIndicator.svelte";
	import { pageLockId } from "$lib/collab/page-lock-id.ts";
	import { formatWorkflowDueDay, isWorkflowTaskOpen } from "$lib/project/task-due.js";
	import { workflowTaskPriorityLabel } from "$lib/project/task-priority.js";
	import {
		READING_DIRECTION_OPTIONS,
		readingCssDirection,
		readingMoveControls,
		readingNavGlyphs,
	} from "$lib/project/reading-direction.js";
	import {
		exportBlockerCopy,
		exportFocusHistoryCopy,
		exportHistoryPagesMissingCopy,
		exportMissingPagesCopy,
		exportRetryCopy,
		exportRunNoMatchingPagesCopy,
	} from "$lib/project/page-work-copy.js";
	import {
		resolvePageStatusText,
		resolvePageAssetLabelText,
		resolvePageAssetRecoveryTitle,
		resolvePageAssetRecoveryAction,
	} from "$lib/project/page-work-copy-i18n.js";
	import type {
		AiReviewMarker,
		ExportRun,
		PageReviewDecision,
		ProjectComment,
		ProjectState,
		WorkflowTask,
		WorkflowTaskPriority,
		WorkflowTaskStatus,
	} from "$lib/types.js";
	import ChapterDashboardPanel from "./ChapterDashboardPanel.svelte";

	type PageFilter = "all" | "attention" | "overdue" | "urgent" | "high" | "blocked" | "review" | "empty" | "ready";
	let BATCH_STATUS_OPTIONS = $derived<readonly { id: WorkflowTaskStatus; label: string }[]>([
		{ id: "todo", label: $_("pageNav.statusTodo") },
		{ id: "doing", label: $_("pageNav.statusDoing") },
		{ id: "review", label: $_("pageNav.statusReview") },
		{ id: "done", label: $_("pageNav.statusDone") },
	]);

	let pageFilters = $derived<{ id: PageFilter; label: string }[]>([
		{ id: "all", label: $_("pageNav.filterAll") },
		{ id: "attention", label: $_("pageNav.filterAttention") },
		{ id: "overdue", label: $_("pageNav.filterOverdue") },
		{ id: "urgent", label: $_("pageNav.filterUrgent") },
		{ id: "high", label: $_("pageNav.filterHigh") },
		{ id: "blocked", label: $_("pageNav.filterBlocked") },
		{ id: "review", label: $_("pageNav.filterReview") },
		{ id: "empty", label: $_("pageNav.filterEmpty") },
		{ id: "ready", label: $_("pageNav.filterReadyExport") },
	]);

	// Localise via svelte-i18n with a Thai fallback ($_ returns the key on a miss).
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let pageFilter = $state<PageFilter>("all");
	let pageJumpValue = $state("");
	let batchGateMessage = $state("");
	let batchAssigneeValue = $state("");
	let batchDueValue = $state("");
	let selectedPageMap = $state<Record<number, boolean>>({});
	let thumbnailFailures = $state<Record<string, boolean>>({});
	let currentPage = $derived(
		projectStore.project ? projectStore.project.pages[projectStore.project.currentPage] ?? null : null
	);
	let readingDirection = $derived(projectStore.readingDirection);
	let readingDirectionOption = $derived(
		READING_DIRECTION_OPTIONS.find((option) => option.value === readingDirection) ?? READING_DIRECTION_OPTIONS[1]
	);
	// RTL reverses the visual order of the prev/next nav and the mini-list, so the chevron
	// glyphs and per-row move controls flip (via pure helpers) to stay aligned with their
	// visual side. The logical handlers/move directions are never changed.
	let navGlyphs = $derived(readingNavGlyphs(readingDirection));
	let moveControls = $derived(readingMoveControls(readingDirection));
	let currentAssetIntegrity = $derived(projectStore.currentPageAssetIntegrity);
	// O(pages + records) bucketed bulk summary that DOES NOT depend on the live editor
	// text-layer count: it uses each page's persisted textLayers. Decoupling the bulk
	// pass from `editorStore.textLayers.length` means editing text on the open page no
	// longer re-summarizes all N pages on every layer add/remove (the >100-page jank).
	// The open page's live layer count is merged back in via `pageSummaries` below, so
	// only that single page is recomputed per keystroke.
	let basePageSummaries = $derived.by(() => buildPageSummaries(
		projectStore.project,
		projectStore.tasks,
		projectStore.comments,
		projectStore.aiReviewMarkers,
		projectStore.reviewDecisions,
		projectStore.qcReport.issues,
	));
	// Re-summarize ONLY the current page with the live editor layer count, then splice it
	// into the bucketed base array. This isolates per-keystroke reactivity to one page
	// instead of triggering the full bulk rebuild.
	let pageSummaries = $derived.by(() => {
		const project = projectStore.project;
		if (!project) return basePageSummaries;
		const currentIndex = project.currentPage;
		const baseCurrent = basePageSummaries[currentIndex];
		if (!baseCurrent) return basePageSummaries;
		const liveLayerCount = resolveVisiblePageLayerCount(
			project.pages[currentIndex],
			true,
			editorStore.textLayers.length,
			editorStore.hasImage,
		);
		if (liveLayerCount === baseCurrent.layerCount) return basePageSummaries;
		const liveCurrent = summarizePageWork({
			page: project.pages[currentIndex],
			pageIndex: currentIndex,
			layerCount: liveLayerCount,
			assetIntegrity: getPageAssetIntegrity(currentIndex),
			qcIssues: projectStore.qcReport.issues,
			tasks: projectStore.tasks,
			comments: projectStore.comments,
			aiReviewMarkers: projectStore.aiReviewMarkers,
			reviewDecisions: projectStore.reviewDecisions,
			productionMode: project.productionMode ?? "solo",
		});
		const merged = basePageSummaries.slice();
		merged[currentIndex] = liveCurrent;
		return merged;
	});
	let currentPageSummary = $derived(
		projectStore.project ? pageSummaries[projectStore.project.currentPage] ?? null : null
	);
	let filteredPageSummaries = $derived(
		pageSummaries.filter((summary) => isCurrentPage(summary) || matchesPageFilter(summary, pageFilter))
	);
	// Display order honors reading direction: RTL shows the highest page first (right-to-left),
	// LTR/vertical keep natural ascending order. Logical page indexes are never mutated.
	let readingOrderedPageSummaries = $derived(
		readingDirection === "rtl" ? [...filteredPageSummaries].reverse() : filteredPageSummaries
	);

	// ── Page strip virtualization (W3.5) ───────────────────────────────────────────
	// A 100-300 page chapter would otherwise render every page-mini-row (thumbnail +
	// chips + lock indicator) on each reactive update, which janks scroll. We render
	// only the visible window (+ overscan) into a fixed-height scroll container and pad
	// the top/bottom with spacers so the scrollbar geometry stays correct. The window is
	// computed over the *display-ordered* array, so RTL/vertical order is untouched.
	const VIRTUAL_ROW_HEIGHT = 108; // min-height 104 + 4px gap (see .page-mini-row)
	let pageListEl = $state<HTMLDivElement | null>(null);
	let listScrollTop = $state(0);
	let listViewportHeight = $state(330); // matches .page-mini-list max-height fallback
	let listResizeObserver: ResizeObserver | null = null;
	let virtualizationActive = $derived(
		readingDirection !== "vertical" && shouldVirtualize(readingOrderedPageSummaries.length)
	);
	let virtualWindow = $derived(
		computeVirtualWindow({
			itemCount: readingOrderedPageSummaries.length,
			scrollTop: listScrollTop,
			viewportHeight: listViewportHeight,
			rowHeight: VIRTUAL_ROW_HEIGHT,
			overscan: DEFAULT_OVERSCAN,
		})
	);
	// When virtualization is off (short list / vertical webtoon stack) render every row;
	// otherwise render just the computed slice. Order/identity is preserved either way.
	let visiblePageSummaries = $derived(
		virtualizationActive
			? readingOrderedPageSummaries.slice(virtualWindow.startIndex, virtualWindow.endIndex + 1)
			: readingOrderedPageSummaries
	);

	function syncListMetrics(): void {
		if (!pageListEl) return;
		listScrollTop = pageListEl.scrollTop;
		listViewportHeight = pageListEl.clientHeight || listViewportHeight;
	}

	function handleListScroll(): void {
		syncListMetrics();
	}

	function registerPageList(node: HTMLDivElement): { destroy(): void } {
		pageListEl = node;
		syncListMetrics();
		// ResizeObserver keeps the window in sync when the panel resizes. Guarded so a
		// missing/non-constructor global (older browsers, some test envs) degrades to
		// scroll-event-driven virtualization instead of breaking the whole panel.
		if (typeof ResizeObserver === "function") {
			try {
				listResizeObserver = new ResizeObserver(() => syncListMetrics());
				listResizeObserver.observe(node);
			} catch {
				listResizeObserver = null;
			}
		}
		// Bring the active page into view on first mount (e.g. resuming a chapter).
		void scrollActivePageIntoView();
		return {
			destroy() {
				listResizeObserver?.disconnect();
				listResizeObserver = null;
				if (pageListEl === node) pageListEl = null;
			},
		};
	}

	function displayIndexOfPage(pageIndex: number): number {
		return readingOrderedPageSummaries.findIndex((summary) => summary.pageIndex === pageIndex);
	}

	async function scrollActivePageIntoView(): Promise<void> {
		if (!projectStore.project) return;
		const activePageIndex = projectStore.project.currentPage;
		await tick();
		if (!pageListEl) return;
		syncListMetrics();
		const displayIndex = displayIndexOfPage(activePageIndex);
		if (displayIndex < 0) return;
		const target = scrollOffsetForIndex(displayIndex, {
			scrollTop: pageListEl.scrollTop,
			viewportHeight: pageListEl.clientHeight || listViewportHeight,
			rowHeight: VIRTUAL_ROW_HEIGHT,
			itemCount: readingOrderedPageSummaries.length,
		});
		if (target === null) return;
		pageListEl.scrollTop = target;
		listScrollTop = target;
	}

	// Keep the active page visible when navigation moves it (prev/next, jump, lane open).
	// Reading `currentPage` makes this effect re-run on every page change; the heavy
	// scroll work is deferred to a tick so the windowed slice has rendered first.
	$effect(() => {
		void projectStore.project?.currentPage;
		void scrollActivePageIntoView();
	});
	let chapterBatchSummary = $derived(summarizePageBatch(pageSummaries));
	let chapterDashboard = $derived(buildChapterDashboard(pageSummaries, chapterBatchSummary));
	let selectedPageSummaries = $derived(pageSummaries.filter((summary) => isPageSelected(summary)));
	let selectedBatchSummary = $derived(summarizePageBatch(selectedPageSummaries));
	let visibleBatchSummary = $derived(summarizePageBatch(filteredPageSummaries));
	let activeBatchSummary = $derived(selectedBatchSummary.pageCount > 0 ? selectedBatchSummary : visibleBatchSummary);
	let activeExportGate = $derived(getBatchExportGateForSummaries(getActiveScopeSummaries()));
	// $_ read makes the derived re-run on locale switch — the helper resolves
	// strings via get(_) which is NOT reactive by itself (codex P2).
	let batchExportTargetLabel = $derived(($_, batchExportActionTargetLabel(projectStore.project?.creditPolicy)));
	let batchCreditBlocked = $derived(activeExportGate.firstHoldReason === requiredCreditMissingHoldReason());
	let batchScopeLabel = $derived(selectedBatchSummary.pageCount > 0 ? $_("pageNav.scopeSelected") : $_("pageNav.scopeFilter"));
	let activeScopeOpenTaskIds = $derived(getActiveScopeOpenTaskIds());
	let recentExportRuns = $derived(getVisibleExportHistoryRuns(projectStore.exportRuns));
	let failedRecentExportRunCount = $derived(recentExportRuns.filter((run) => run.status === "error").length);
	let canJumpToTypedPage = $derived(Boolean(projectStore.project && pageJumpValue.trim()));
	let canSelectVisiblePages = $derived(filteredPageSummaries.length > 0 && !projectStore.isBatchExporting);
	let canOpenFirstSelectedPage = $derived(selectedPageSummaries.length > 0 && !projectStore.isBatchExporting);
	let canOpenFirstHoldPage = $derived(activeBatchSummary.attentionCount > 0 && !projectStore.isBatchExporting);
	let canEditActiveScopeTasks = $derived(activeScopeOpenTaskIds.length > 0 && !projectStore.workflowLoading && !projectStore.isBatchExporting);
	let canRunActiveScopeExport = $derived(activeExportGate.pageCount > 0 && !projectStore.isBatchExporting);
	let canSetActiveScopeDue = $derived(canEditActiveScopeTasks && Boolean(normalizeBatchDueAt(batchDueValue)));
	let canAssignActiveScope = $derived(canEditActiveScopeTasks && Boolean(normalizeBatchAssignee(batchAssigneeValue)));

	function getPageAssetIntegrity(index: number): PageAssetIntegrity | null {
		return projectStore.getPageAssetIntegrity(index);
	}

	// Bulk page summaries via the O(pages + records) bucketed batch path. This pass uses
	// each page's PERSISTED text-layer count (no `editorStore` dependency) so it does not
	// re-run on every live layer add/remove; the open page's live count is merged in by
	// the `pageSummaries` derivation above.
	function buildPageSummaries(
		project: ProjectState | null,
		tasks: WorkflowTask[],
		comments: ProjectComment[],
		aiReviewMarkers: AiReviewMarker[],
		reviewDecisions: PageReviewDecision[],
		qcIssues: QcIssue[],
	): PageWorkSummary[] {
		if (!project) return [];
		return summarizePageWorkBatch({
			pages: project.pages,
			assetIntegrityFor: getPageAssetIntegrity,
			qcIssues,
			tasks,
			comments,
			aiReviewMarkers,
			reviewDecisions,
			productionMode: project.productionMode ?? "solo",
		});
	}

	function matchesPageFilter(summary: PageWorkSummary, filter: PageFilter): boolean {
		if (filter === "all") return true;
		if (filter === "attention") return pageNeedsAttention(summary);
		if (filter === "overdue") return summary.overdueTaskCount > 0;
		if (filter === "urgent") return summary.urgentTaskCount > 0;
		if (filter === "high") return summary.urgentTaskCount === 0 && summary.highTaskCount > 0;
		if (filter === "empty") return summary.layerCount === 0;
		return summary.status === filter;
	}

	function isCurrentPage(summary: PageWorkSummary): boolean {
		return projectStore.project?.currentPage === summary.pageIndex;
	}

	function formatAssignees(summary: PageWorkSummary): string {
		if (!summary.assignees.length) return $_("pageNav.noAssignee");
		if (summary.assignees.length <= 2) return summary.assignees.map((assignee) => formatAssigneeHandle(assignee)).join(", ");
		return `${summary.assignees.slice(0, 2).map((assignee) => formatAssigneeHandle(assignee)).join(", ")} +${summary.assignees.length - 2}`;
	}

	function formatQcLabel(summary: PageWorkSummary): string {
		if (summary.qcErrorCount > 0) return $_("pageNav.qcErrors", { values: { n: summary.qcErrorCount } });
		if (summary.qcWarningCount > 0) return $_("pageNav.qcWarnings", { values: { n: summary.qcWarningCount } });
		return $_("pageNav.qcPassed");
	}

	function formatExportLabel(summary: PageWorkSummary): string {
		return summary.exportReady ? $_("pageNav.readyExport") : $_("pageNav.holdCount", { values: { n: summary.exportBlockers.length } });
	}

	function firstExportBlockerCopy(summary: PageWorkSummary): string | null {
		const blocker = summary.exportBlockers.find((item) => (
			item.includes("accepted AI result not placed")
			|| item.includes("applied AI layer missing")
		));
		return blocker ? exportBlockerCopy(blocker) : null;
	}

	function formatBatchLine(summary: PageBatchSummary, gate: BatchExportGate): string {
		if (!summary.pageCount) return $_("pageNav.noPagesYet");
		return $_("pageNav.batchReadyLine", { values: { ready: gate.readyCount, total: gate.pageCount, target: batchExportTargetLabel } });
	}

	function formatBatchAttention(summary: PageBatchSummary): string {
		if (!summary.pageCount) return $_("pageNav.pickFilterOrOpen");
		const parts = [
			$_("pageNav.countBlocked", { values: { n: summary.blockedCount } }),
			$_("pageNav.countReview", { values: { n: summary.reviewCount } }),
			$_("pageNav.countLayers", { values: { n: summary.layerCount } }),
		];
		if (summary.assetBlockedCount > 0) parts.unshift($_("pageNav.countImagesBlocked", { values: { n: summary.assetBlockedCount } }));
		if (summary.assetScanningCount > 0) parts.push($_("pageNav.countImagesScanning", { values: { n: summary.assetScanningCount } }));
		if (summary.urgentTaskCount > 0) parts.unshift($_("pageNav.countUrgent", { values: { n: summary.urgentTaskCount } }));
		if (summary.overdueTaskCount > 0) parts.unshift($_("pageNav.countOverdue", { values: { n: summary.overdueTaskCount } }));
		if (summary.dueTaskCount > 0) parts.push($_("pageNav.countHasDueDate", { values: { n: summary.dueTaskCount } }));
		if (summary.highTaskCount > 0) parts.push($_("pageNav.countHigh", { values: { n: summary.highTaskCount } }));
		if (summary.commentCount > 0) parts.push($_("pageNav.countNotes", { values: { n: summary.commentCount } }));
		if (summary.aiAttentionCount > 0) parts.push($_("pageNav.countAiToReview", { values: { n: summary.aiAttentionCount } }));
		return parts.join(" / ");
	}

	function formatPageFocusDetail(summary: PageWorkSummary): string {
		const firstBlocker = firstExportBlockerCopy(summary);
		if (firstBlocker) return $_("pageNav.exportNotReadyReason", { values: { reason: firstBlocker } });
		const parts = [
			$_("pageNav.countLayers", { values: { n: summary.layerCount } }),
			$_("pageNav.countOpenWork", { values: { n: summary.taskOpenCount } }),
			formatQcLabel(summary),
		];
		if (summary.openCommentCount > 0) parts.push($_("pageNav.countOpenNotes", { values: { n: summary.openCommentCount } }));
		if (summary.aiAttentionCount > 0) parts.push($_("pageNav.countAiToReview", { values: { n: summary.aiAttentionCount } }));
		if (summary.overdueTaskCount > 0) parts.push($_("pageNav.countOverdue", { values: { n: summary.overdueTaskCount } }));
		else if (summary.nextDueAt) parts.push($_("pageNav.dueOn", { values: { day: formatWorkflowDueDay(summary.nextDueAt) } }));
		if (summary.assignees.length) parts.push($_("pageNav.assigneeLabel", { values: { who: formatAssignees(summary) } }));
		return parts.join(" / ");
	}

	function normalizeBatchAssignee(value: string): string {
		return normalizeAssigneeHandle(value) ?? "";
	}

	function normalizeBatchDueAt(value: string): string | null {
		if (!value) return null;
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}

	function workflowStatusLabel(status: WorkflowTaskStatus): string {
		return BATCH_STATUS_OPTIONS.find((option) => option.id === status)?.label ?? status;
	}

	function getPageThumbnailKey(summary: PageWorkSummary): string | null {
		if (!projectStore.project) return null;
		const page = projectStore.project.pages[summary.pageIndex];
		const imageId = getPagePreviewImageId(page);
		return imageId ? `${projectStore.project.projectId}:${imageId}` : null;
	}

	function getPageThumbnailUrl(summary: PageWorkSummary): string | null {
		if (!projectStore.project) return null;
		const page = projectStore.project.pages[summary.pageIndex];
		const imageId = getPagePreviewImageId(page);
		if (!imageId || summary.assetIntegrity?.status !== "ready") return null;
		const key = getPageThumbnailKey(summary);
		if (key && thumbnailFailures[key]) return null;
		return api.thumbnailUrl(projectStore.project.projectId, imageId, 192, 288);
	}

	// Action params for an authed <img>: the bare thumbnail URL plus the asset
	// identity so the signedAssetSrc action can attach a signed assetToken (a
	// browser <img> can't send a Bearer header). Null when no servable thumbnail.
	function getPageThumbnailParams(summary: PageWorkSummary): SignedAssetSrcParams | null {
		if (!projectStore.project) return null;
		const page = projectStore.project.pages[summary.pageIndex];
		const imageId = getPagePreviewImageId(page);
		if (!imageId || summary.assetIntegrity?.status !== "ready") return null;
		const key = getPageThumbnailKey(summary);
		if (key && thumbnailFailures[key]) return null;
		return {
			projectId: projectStore.project.projectId,
			imageId,
			url: api.thumbnailUrl(projectStore.project.projectId, imageId, 192, 288),
			purpose: "thumbnail",
			// Mark failed only AFTER signedAssetSrc exhausts its token re-mint retry,
			// not on a raw <img onerror> (which fires on the first error and aborts the
			// re-sign, leaving an expired-token thumbnail permanently broken).
			onFailed: () => markThumbnailFailed(summary),
		};
	}

	function markThumbnailFailed(summary: PageWorkSummary): void {
		const key = getPageThumbnailKey(summary);
		if (!key) return;
		thumbnailFailures = { ...thumbnailFailures, [key]: true };
	}

	function clearThumbnailFailure(summary: PageWorkSummary): void {
		const key = getPageThumbnailKey(summary);
		if (!key || !thumbnailFailures[key]) return;
		const nextFailures = { ...thumbnailFailures };
		delete nextFailures[key];
		thumbnailFailures = nextFailures;
	}

	function isPageSelected(summary: PageWorkSummary): boolean {
		return Boolean(selectedPageMap[summary.pageIndex]);
	}

	function clearBatchFeedback(): void {
		batchGateMessage = "";
		projectStore.clearBatchExportStatus();
	}

	function togglePageSelection(summary: PageWorkSummary): void {
		const next = { ...selectedPageMap };
		if (next[summary.pageIndex]) {
			delete next[summary.pageIndex];
		} else {
			next[summary.pageIndex] = true;
		}
		clearBatchFeedback();
		selectedPageMap = next;
	}

	function selectVisiblePages(): void {
		if (!filteredPageSummaries.length) return;
		const next = { ...selectedPageMap };
		for (const summary of filteredPageSummaries) {
			next[summary.pageIndex] = true;
		}
		clearBatchFeedback();
		selectedPageMap = next;
	}

	function clearSelectedPages(): void {
		clearBatchFeedback();
		selectedPageMap = {};
	}

	function setPageFilter(filter: PageFilter): void {
		if (pageFilter === filter) return;
		clearBatchFeedback();
		pageFilter = filter;
	}

	function laneToFilter(laneId: ChapterDashboardLaneId): PageFilter {
		if (laneId === "attention") return "attention";
		if (laneId === "overdue") return "overdue";
		if (laneId === "urgent") return "urgent";
		if (laneId === "high") return "high";
		if (laneId === "working") return "all";
		return laneId;
	}

	function getLaneSummaries(laneId: ChapterDashboardLaneId): PageWorkSummary[] {
		if (laneId === "attention") return pageSummaries.filter(pageNeedsAttention);
		if (laneId === "overdue") return pageSummaries.filter((summary) => summary.overdueTaskCount > 0);
		if (laneId === "urgent") return pageSummaries.filter((summary) => summary.urgentTaskCount > 0);
		if (laneId === "high") return pageSummaries.filter((summary) => summary.urgentTaskCount === 0 && summary.highTaskCount > 0);
		if (laneId === "empty") return pageSummaries.filter((summary) => summary.layerCount === 0);
		return pageSummaries.filter((summary) => summary.status === laneId);
	}

	function openFirstLanePage(laneId: ChapterDashboardLaneId): void {
		const target = getLaneSummaries(laneId)[0];
		if (!target) return;
		void goToPage(target.pageIndex);
	}

	function filterDashboardLane(laneId: ChapterDashboardLaneId): void {
		setPageFilter(laneToFilter(laneId));
	}

	function getActiveScopeSummaries(): PageWorkSummary[] {
		return selectedPageSummaries.length ? selectedPageSummaries : filteredPageSummaries;
	}

	function getActiveScopeOpenTaskIds(): string[] {
		const activePageIndexes = new Set(getActiveScopeSummaries().map((summary) => summary.pageIndex));
		return projectStore.tasks
			.filter((task) => activePageIndexes.has(task.pageIndex) && isWorkflowTaskOpen(task))
			.map((task) => task.id);
	}

	function openFirstSelectedPage(): void {
		const target = selectedPageSummaries[0];
		if (!target) return;
		void goToPage(target.pageIndex);
	}

	function openFirstHoldPage(): void {
		const scope = selectedPageSummaries.length ? selectedPageSummaries : filteredPageSummaries;
		const target = scope.find((summary) => !summary.exportReady);
		if (!target) return;
		void goToPage(target.pageIndex);
	}

	function getBatchExportGateForSummaries(summaries: PageWorkSummary[]): BatchExportGate {
		return projectStore.getBatchExportGate(summaries.map((summary) => summary.pageIndex));
	}

	function openCreditWorkflow(): void {
		if (!projectStore.project) return;
		editorUiStore.focusCreditTools();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex: projectStore.project.currentPage,
		});
		projectStore.setStatusMsg($_("pageNav.msgOpenedCreditTool"));
	}

	function runBatchExportGate(): void {
		const gate: BatchExportGate = getBatchExportGateForSummaries(getActiveScopeSummaries());
		projectStore.clearBatchExportStatus();
		batchGateMessage = gate.message;
		if (!gate.canExport && gate.firstHoldPageIndex !== null) {
			void goToPage(gate.firstHoldPageIndex);
		}
	}

	async function markActiveScopePriority(priority: WorkflowTaskPriority): Promise<void> {
		if (!activeScopeOpenTaskIds.length || projectStore.workflowLoading) return;
		clearBatchFeedback();
		const changedCount = await projectStore.bulkUpdateTaskPriority(activeScopeOpenTaskIds, priority);
		const label = workflowTaskPriorityLabel(priority).toLowerCase();
		batchGateMessage = changedCount > 0
			? $_("pageNav.msgPriorityChanged", { values: { n: changedCount, label } })
			: $_("pageNav.msgNoPriorityToChange", { values: { label } });
	}

	async function markActiveScopeStatus(status: WorkflowTaskStatus): Promise<void> {
		if (!activeScopeOpenTaskIds.length || projectStore.workflowLoading) return;
		clearBatchFeedback();
		const changedCount = await projectStore.bulkUpdateTaskStatus(activeScopeOpenTaskIds, status);
		const label = workflowStatusLabel(status);
		batchGateMessage = changedCount > 0
			? $_("pageNav.msgStatusMoved", { values: { n: changedCount, label } })
			: $_("pageNav.msgNoStatusToMove", { values: { label } });
	}

	async function assignActiveScope(): Promise<void> {
		if (!activeScopeOpenTaskIds.length || projectStore.workflowLoading) return;
		const assignee = normalizeBatchAssignee(batchAssigneeValue);
		if (!assignee) {
			batchGateMessage = $_("pageNav.msgEnterAssigneeFirst");
			return;
		}
		clearBatchFeedback();
		const changedCount = await projectStore.bulkUpdateTaskAssignee(activeScopeOpenTaskIds, assignee);
		batchGateMessage = changedCount > 0
			? $_("pageNav.msgAssigned", { values: { n: changedCount, who: formatAssigneeHandle(assignee) } })
			: $_("pageNav.msgNoOpenToAssign", { values: { who: formatAssigneeHandle(assignee) } });
	}

	async function clearActiveScopeAssignee(): Promise<void> {
		if (!activeScopeOpenTaskIds.length || projectStore.workflowLoading) return;
		clearBatchFeedback();
		const changedCount = await projectStore.bulkUpdateTaskAssignee(activeScopeOpenTaskIds, null);
		batchGateMessage = changedCount > 0
			? $_("pageNav.msgAssigneesCleared", { values: { n: changedCount } })
			: $_("pageNav.msgNoAssigneeToClear");
	}

	async function setActiveScopeDueAt(): Promise<void> {
		if (!activeScopeOpenTaskIds.length || projectStore.workflowLoading) return;
		const dueAt = normalizeBatchDueAt(batchDueValue);
		if (!dueAt) {
			batchGateMessage = $_("pageNav.msgPickDueDateFirst");
			return;
		}
		clearBatchFeedback();
		const changedCount = await projectStore.bulkUpdateTaskDueAt(activeScopeOpenTaskIds, dueAt);
		batchGateMessage = changedCount > 0
			? $_("pageNav.msgDueDateSet", { values: { n: changedCount } })
			: $_("pageNav.msgNoDueDateChanged");
	}

	async function clearActiveScopeDueAt(): Promise<void> {
		if (!activeScopeOpenTaskIds.length || projectStore.workflowLoading) return;
		clearBatchFeedback();
		const changedCount = await projectStore.bulkUpdateTaskDueAt(activeScopeOpenTaskIds, null);
		batchGateMessage = changedCount > 0
			? $_("pageNav.msgDueDatesCleared", { values: { n: changedCount } })
			: $_("pageNav.msgNoDueDateToClear");
	}

	function updateBatchAssignee(e: Event): void {
		batchAssigneeValue = (e.target as HTMLInputElement).value;
	}

	function updateBatchDueValue(e: Event): void {
		batchDueValue = (e.target as HTMLInputElement).value;
	}

	function handleBatchAssigneeKeydown(e: KeyboardEvent): void {
		if (e.key !== "Enter") return;
		e.preventDefault();
		void assignActiveScope();
	}

	function handleBatchDueKeydown(e: KeyboardEvent): void {
		if (e.key !== "Enter") return;
		e.preventDefault();
		void setActiveScopeDueAt();
	}

	async function exportActiveScope(): Promise<void> {
		if (projectStore.isBatchExporting) return;
		const scope = getActiveScopeSummaries();
		const gate: BatchExportGate = getBatchExportGateForSummaries(scope);
		projectStore.clearBatchExportStatus();
		batchGateMessage = gate.message;

		if (!gate.canExport) {
			if (gate.firstHoldPageIndex !== null) {
				await goToPage(gate.firstHoldPageIndex);
			}
			return;
		}

		await projectStore.exportPageBatch(scope.map((summary) => summary.pageIndex), editorStore.editor);
	}

	async function movePage(summary: PageWorkSummary, direction: -1 | 1): Promise<void> {
		if (!projectStore.project) return;
		clearBatchFeedback();
		selectedPageMap = {};
		await projectStore.movePage(summary.pageIndex, direction, editorStore.editor);
		editorStore.refreshTextLayers();
		pageJumpValue = "";
	}

	function relinkPage(summary: PageWorkSummary): void {
		if (!projectStore.project) return;
		clearBatchFeedback();
		const layerId = summary.assetIntegrity?.issueKind === "image-layer" ? summary.assetIntegrity.layerId : null;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;
			clearThumbnailFailure(summary);
			clearBatchFeedback();
			if (layerId) {
				void projectStore.replacePageImageLayerAsset(summary.pageIndex, layerId, file, editorStore.editor);
			} else {
				void projectStore.replacePageImage(summary.pageIndex, file, editorStore.editor);
			}
		};
		input.click();
	}

	function relinkCurrentPage(): void {
		if (!currentPageSummary) return;
		relinkPage(currentPageSummary);
	}

	function relinkMatchingPageImages(): void {
		if (!projectStore.project) return;
		clearBatchFeedback();
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.multiple = true;
		input.onchange = async () => {
			const files = Array.from(input.files ?? []);
			if (!files.length) return;
			for (const summary of pageSummaries) {
				clearThumbnailFailure(summary);
			}
			clearBatchFeedback();
			const preview = projectStore.getMatchingPageImageRelinkPreview(files);
			const confirmed = await pageRelinkConfirmationStore.confirmOrderFallback(preview);
			if (!confirmed) {
				projectStore.setStatusMsg(pageImageRelinkOrderFallbackCancelMessage);
				return;
			}
			void projectStore.replaceMatchingPageImages(files, editorStore.editor, {
				allowOrderFallback: preview.requiresOrderConfirmation,
			});
		};
		input.click();
	}

	function assetNeedsRecovery(asset: PageAssetIntegrity | null): boolean {
		return asset?.status === "missing" || asset?.status === "failed" || asset?.status === "blocked";
	}

	function assetRecoveryTitle(asset: PageAssetIntegrity): string {
		return resolvePageAssetRecoveryTitle(asset, $_);
	}

	function assetRecoveryAction(asset: PageAssetIntegrity): string {
		return resolvePageAssetRecoveryAction(asset, $_);
	}

	async function goToPage(index: number) {
		if (projectStore.project?.currentPage === index) return;
		if (await projectStore.goToPage(index, editorStore.editor)) {
			editorStore.refreshTextLayers();
			pageJumpValue = "";
			syncEditorPageHref(index);
		}
	}

	function runCurrentPageExportGate(): void {
		if (!currentPageSummary) return;
		const gate: BatchExportGate = getBatchExportGateForSummaries([currentPageSummary]);
		projectStore.clearBatchExportStatus();
		batchGateMessage = gate.message;
		if (!gate.canExport && gate.firstHoldPageIndex !== null) {
			void goToPage(gate.firstHoldPageIndex);
		}
	}

	function syncEditorPageHref(pageIndex: number): void {
		if (!projectStore.project || editorUiStore.workspaceView !== "editor") return;
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex,
		});
	}

	function goPrevPage(): void {
		if (!projectStore.project || !projectStore.canGoPrev || projectStore.pageNavigationBusy) return;
		void goToPage(projectStore.project.currentPage - 1);
	}

	function goNextPage(): void {
		if (!projectStore.project || !projectStore.canGoNext || projectStore.pageNavigationBusy) return;
		void goToPage(projectStore.project.currentPage + 1);
	}

	function updatePageJump(e: Event) {
		pageJumpValue = (e.target as HTMLInputElement).value;
	}

	function submitPageJump() {
		if (!projectStore.project || !pageJumpValue.trim()) return;
		const requestedPage = Number(pageJumpValue);
		if (!Number.isFinite(requestedPage)) return;
		const targetIndex = Math.max(0, Math.min(projectStore.project.pages.length - 1, Math.round(requestedPage) - 1));
		void goToPage(targetIndex);
	}

	function handlePageJumpKeydown(e: KeyboardEvent) {
		if (e.key !== "Enter") return;
		e.preventDefault();
		submitPageJump();
	}

	function formatExportRunTime(run: ExportRun): string {
		const date = new Date(run.completedAt);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function formatExportRunDetail(run: ExportRun): string {
		const scope = getExportRunPageScope(run, projectStore.project?.pages.length ?? 0);
		const parts = [
			run.kind === "batch-zip" ? $_("pageNav.zipWholeBatch") : $_("pageNav.pngSinglePage"),
			formatExportRunPages(run),
		];
		const targetProfile = exportRunTargetProfileLabel(run);
		if (targetProfile) parts.unshift(targetProfile);
		if (scope.missingPageIndexes.length) {
			parts.push($_(`pageWork.export.${exportMissingPagesCopy()}`, { values: { n: scope.missingPageIndexes.length } }));
		}
		const size = formatExportRunSize(run.bytes);
		if (size) parts.push(size);
		const time = formatExportRunTime(run);
		if (time) parts.push(time);
		return parts.join(" / ");
	}

	function formatExportRunMessage(run: ExportRun): string {
		return formatProjectExportRunMessage(run);
	}

	function formatArtifactError(message: string): string {
		return message
			.replace(/^Stored ZIP was not saved:\s*/i, $_("pageNav.artifactZipNotSaved"))
			.replace(/Workspace storage is full\.?/i, $_("pageNav.artifactStorageFull"));
	}

	function getExportRetryGate(run: ExportRun, pageIndexes: number[]): BatchExportGate | null {
		if (run.kind !== "batch-zip" || !pageIndexes.length) return null;
		return projectStore.getBatchExportGate(pageIndexes);
	}

	function exportRetryBlockedMessage(run: ExportRun, pageIndexes: number[]): string {
		const gate = getExportRetryGate(run, pageIndexes);
		return gate && !gate.canExport ? gate.message : "";
	}

	function canRetryExportRun(run: ExportRun, pageIndexes: number[]): boolean {
		if (!pageIndexes.length || projectStore.isBatchExporting) return false;
		const gate = getExportRetryGate(run, pageIndexes);
		return !gate || gate.canExport;
	}

	function exportRetryTitle(run: ExportRun, pageIndexes: number[], missingPageCount: number): string {
		if (!pageIndexes.length) return exportRunUnavailableMessage(run);
		if (projectStore.isBatchExporting) return $_("pageNav.exportingNow");
		const blockedMessage = exportRetryBlockedMessage(run, pageIndexes);
		if (blockedMessage) return blockedMessage;
		return $_(`pageWork.export.${exportRetryCopy(missingPageCount > 0)}`, { values: { n: pageIndexes.length } });
	}

	function getExportRunPageIndexes(run: ExportRun): number[] {
		return getExportRunPageScope(run, projectStore.project?.pages.length ?? 0).pageIndexes;
	}

	function getExportRunMissingPageCount(run: ExportRun): number {
		return getExportRunPageScope(run, projectStore.project?.pages.length ?? 0).missingPageIndexes.length;
	}

	function exportRunUnavailableMessage(run: ExportRun): string {
		return getExportRunMissingPageCount(run)
			? $_(`pageWork.export.${exportHistoryPagesMissingCopy()}`)
			: $_(`pageWork.export.${exportRunNoMatchingPagesCopy()}`);
	}

	function exportRecoveryPageIndex(run: ExportRun, pageIndexes: number[]): number {
		const livePageIndexes = new Set(pageIndexes);
		if (Number.isInteger(run.failedPageIndex) && livePageIndexes.has(run.failedPageIndex!)) {
			return run.failedPageIndex!;
		}
		const sources = [run.error, run.message].filter((value): value is string => Boolean(value));
		// Recover the failed page number from free-text export error/message strings. Those
		// strings come from the export-runs formatter (outside this component) and still use a
		// fixed Thai "page" word, so the pattern must match that exact word in every UI locale;
		// the key resolves to the same Thai token in all locales (an internal parse token, never
		// rendered), with the Thai also kept here as the `msg` fallback so the i18n guard treats
		// it as bound rather than raw hardcoded copy.
		const pageWordPattern = new RegExp(`${msg("pageNav.pageWordToken", "หน้า")}\\s*(\\d+)`, "gu");
		for (const source of sources) {
			for (const match of source.matchAll(pageWordPattern)) {
				const pageNumber = Number(match[1]);
				if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
				const pageIndex = pageNumber - 1;
				if (livePageIndexes.has(pageIndex)) return pageIndex;
			}
		}
		return pageIndexes[0];
	}

	async function focusExportRun(run: ExportRun): Promise<void> {
		const pageIndexes = getExportRunPageIndexes(run);
		if (!pageIndexes.length) {
			projectStore.setStatusMsg(exportRunUnavailableMessage(run));
			return;
		}

		const nextSelection: Record<number, boolean> = {};
		for (const pageIndex of pageIndexes) {
			nextSelection[pageIndex] = true;
		}
		clearBatchFeedback();
		pageFilter = "all";
		selectedPageMap = nextSelection;
		batchGateMessage = exportFocusHistoryCopy(pageIndexes.length);
		const targetPageIndex = exportRecoveryPageIndex(run, pageIndexes);
		await goToPage(targetPageIndex);
		projectStore.setStatusMsg(targetPageIndex !== pageIndexes[0]
			? $_("pageNav.msgFocusedExportWithProblem", { values: { n: targetPageIndex + 1 } })
			: $_("pageNav.msgFocusedExportHistory"));
	}

	function retryExportRun(run: ExportRun): void {
		const pageIndexes = getExportRunPageIndexes(run);
		if (!pageIndexes.length) {
			projectStore.setStatusMsg(exportRunUnavailableMessage(run));
			return;
		}
		const blockedMessage = exportRetryBlockedMessage(run, pageIndexes);
		if (blockedMessage) {
			projectStore.setStatusMsg(blockedMessage);
			return;
		}
		void projectStore.retryExportRun(run.id, editorStore.editor, pageIndexes);
	}

	function exportDownloadTitle(run: ExportRun): string {
		return projectStore.canDownloadExportRun(run.id)
			? $_("pageNav.downloadFile", { values: { file: run.filename } })
			: $_("pageNav.fileSessionOnly");
	}

	function exportDeleteTitle(run: ExportRun): string {
		return run.artifact
			? $_("pageNav.deleteStoredZip", { values: { file: run.filename } })
			: $_("pageNav.noStoredZip");
	}

	function exportArtifactStatus(run: ExportRun): string {
		if (run.status !== "done" || run.kind !== "batch-zip") return "";
		if (run.artifact) return $_("pageNav.zipStoredCountsSpace");
		if (run.artifactError) {
			return projectStore.canDownloadExportRun(run.id)
				? $_("pageNav.zipStoreFailedSession")
				: $_("pageNav.zipStoreFailedRecreate");
		}
		if (projectStore.canDownloadExportRun(run.id)) return $_("pageNav.zipSessionOnly");
		return $_("pageNav.noStoredZipFromHistory");
	}

	function exportFailedPageHint(run: ExportRun): string {
		return Number.isInteger(run.failedPageNumber) && run.failedPageNumber! > 0
			? $_("pageNav.failedAtPageHint", { values: { n: run.failedPageNumber } })
			: "";
	}
</script>

<div class="pages-panel ws-sans">
	<div class="page-navigator" dir={readingCssDirection(readingDirection)}>
		{#if projectStore.canGoPrev && !projectStore.pageNavigationBusy}
			<button
				class="page-nav-btn ws-btn-ghost"
				onclick={goPrevPage}
				aria-label={$_("pageNav.prevPage")}
			>{navGlyphs.prev}</button>
		{:else}
			<span class="page-nav-receipt" aria-label={projectStore.pageNavigationBusy ? $_("pageNav.changingPage") : $_("pageNav.noPrevPage")}>{navGlyphs.prev}</span>
		{/if}
		<div class="page-current">
			<span>{projectStore.pageLabel}</span>
			<small>{currentPage ? formatPageWorkName(currentPage, projectStore.project?.currentPage ?? 0) : $_("pageNav.noPageSelected")}</small>
			<small class="reading-dir-chip" dir="ltr" title={readingDirectionOption.helper}>
				<span aria-hidden="true">{readingDirectionOption.icon}</span> {readingDirectionOption.label}
			</small>
			{#if currentAssetIntegrity}
				<small class={`page-asset-chip ${currentAssetIntegrity.status}`} title={currentAssetIntegrity.detail}>
					{resolvePageAssetLabelText(currentAssetIntegrity, $_)}
				</small>
			{/if}
		</div>
		{#if projectStore.canGoNext && !projectStore.pageNavigationBusy}
			<button
				class="page-nav-btn ws-btn-ghost"
				onclick={goNextPage}
				aria-label={$_("pageNav.nextPage")}
			>{navGlyphs.next}</button>
		{:else}
			<span class="page-nav-receipt" aria-label={projectStore.pageNavigationBusy ? $_("pageNav.changingPage") : $_("pageNav.noNextPage")}>{navGlyphs.next}</span>
		{/if}
	</div>
	{#if currentAssetIntegrity && currentPageSummary && currentAssetIntegrity.status !== "ready"}
		<div
			class={`asset-recovery-card ws-panel ${currentAssetIntegrity.status}`}
			role="status"
			aria-label={$_("pageNav.recoverPageImageAria", { values: { n: currentPageSummary.pageNumber } })}
		>
			<div class="asset-recovery-copy">
				<span>{resolvePageAssetLabelText(currentAssetIntegrity, $_)}</span>
				<strong>{assetRecoveryTitle(currentAssetIntegrity)}</strong>
				<small>{currentAssetIntegrity.detail} {assetRecoveryAction(currentAssetIntegrity)}</small>
			</div>
			{#if assetNeedsRecovery(currentAssetIntegrity)}
				<div class="asset-recovery-actions">
					<button type="button" onclick={relinkCurrentPage}>
						{currentAssetIntegrity.issueKind === "image-layer" ? $_("pageNav.recoverExtraImage") : $_("pageNav.recoverThisPageImage")}
					</button>
					{#if currentAssetIntegrity.issueKind !== "image-layer"}
						<button type="button" onclick={relinkMatchingPageImages}>{$_("pageNav.matchFolder")}</button>
					{/if}
				</div>
			{:else}
				<span class="asset-recovery-wait">{$_("pageNav.waitingScan")}</span>
			{/if}
		</div>
	{/if}

	{#if projectStore.project}
		{#if currentPageSummary}
			<section class={`page-focus-card ws-panel ${currentPageSummary.status}`} aria-label={$_("pageNav.currentPageFocusAria")}>
				<div class="page-focus-copy">
			<span>{resolvePageStatusText(currentPageSummary.statusLabel, $_, $_("pageWork.statusFallback"))}</span>
					<strong>{$_("pageNav.pageTitleName", { values: { n: currentPageSummary.pageNumber, name: currentPageSummary.name } })}</strong>
					<em>{formatPageFocusDetail(currentPageSummary)}</em>
					<LockOwnerIndicator
						scope="page"
						scopeId={pageLockId(projectStore.project.projectId, currentPageSummary.pageIndex)}
					/>
				</div>
				<div class="page-focus-stats" aria-label={$_("pageNav.currentPageStatsAria")}>
					<div>
						<span>{$_("pageNav.layers")}</span>
						<strong>{currentPageSummary.layerCount}</strong>
					</div>
					<div>
						<span>{$_("pageNav.openWork")}</span>
						<strong>{currentPageSummary.taskOpenCount}</strong>
					</div>
					<div>
						<span>QC</span>
						<strong>{formatQcLabel(currentPageSummary)}</strong>
					</div>
				</div>
				{#if firstExportBlockerCopy(currentPageSummary)}
					<div class="page-focus-blocker" role="status">
						<span>{$_("pageNav.exportNotReady")}</span>
						<strong>{firstExportBlockerCopy(currentPageSummary)}</strong>
					</div>
				{/if}
				<div class="page-focus-actions">
					<button
						type="button"
						class="ws-btn-ghost"
						onclick={() => togglePageSelection(currentPageSummary)}
						aria-label={isPageSelected(currentPageSummary) ? $_("pageNav.currentPageSelectedAria") : $_("pageNav.selectCurrentPageAria")}
					>
						{isPageSelected(currentPageSummary) ? $_("pageNav.selected") : $_("pageNav.select")}
					</button>
					<button
						type="button"
						class="page-focus-primary-action ws-grad-primary"
						class:gate-ready={currentPageSummary.exportReady}
						onclick={runCurrentPageExportGate}
						aria-label={$_("pageNav.checkCurrentPageGateAria")}
					>
						{$_("pageNav.checkGate")}
					</button>
				</div>
			</section>
		{/if}

		<ChapterDashboardPanel
			dashboard={chapterDashboard}
			currentPageSummary={currentPageSummary}
			activeBatchSummary={activeBatchSummary}
			activeExportGate={activeExportGate}
			batchExportTargetLabel={batchExportTargetLabel}
			batchScopeLabel={batchScopeLabel}
			onOpenLane={openFirstLanePage}
			onFilterLane={filterDashboardLane}
		/>

		<div class="batch-action-bar ws-panel" aria-label={$_("pageNav.batchActionsAria")}>
			<div class="batch-summary">
				<span>{batchScopeLabel}</span>
				<strong>{formatBatchLine(activeBatchSummary, activeExportGate)}</strong>
				<small>{formatBatchAttention(activeBatchSummary)}</small>
			</div>
			<div class="batch-actions">
				{#if canSelectVisiblePages}
					<button type="button" class="batch-action-btn" onclick={selectVisiblePages} title={$_("pageNav.selectAllInFilterTitle")}>
						{$_("pageNav.selectAll")}
					</button>
				{:else}
					<span class="batch-action-receipt">{projectStore.isBatchExporting ? $_("pageNav.exporting") : $_("pageNav.noPages")}</span>
				{/if}
				{#if canOpenFirstSelectedPage}
					<button type="button" class="batch-action-btn" onclick={openFirstSelectedPage} title={$_("pageNav.openFirstSelectedTitle")}>
						{$_("pageNav.openFirstPage")}
					</button>
				{:else}
					<span class="batch-action-receipt">{projectStore.isBatchExporting ? $_("pageNav.exporting") : $_("pageNav.selectPageFirst")}</span>
				{/if}
				{#if canOpenFirstHoldPage}
					<button type="button" class="batch-action-btn" onclick={openFirstHoldPage} title={$_("pageNav.openFirstHoldTitle")}>
						{$_("pageNav.openHold")}
					</button>
				{:else}
					<span class="batch-action-receipt">{projectStore.isBatchExporting ? $_("pageNav.exporting") : $_("pageNav.noHold")}</span>
				{/if}
				{#if canEditActiveScopeTasks}
					<button type="button" class="batch-action-btn priority-urgent" onclick={() => markActiveScopePriority("urgent")} aria-label={$_("pageNav.setScopeUrgentAria")} title={$_("pageNav.setScopeUrgentTitle")}>
						{$_("pageNav.priorityUrgent")}
					</button>
					<button type="button" class="batch-action-btn priority-high" onclick={() => markActiveScopePriority("high")} aria-label={$_("pageNav.setScopeHighAria")} title={$_("pageNav.setScopeHighTitle")}>
						{$_("pageNav.priorityHigh")}
					</button>
					<button type="button" class="batch-action-btn priority-normal" onclick={() => markActiveScopePriority("normal")} aria-label={$_("pageNav.setScopeNormalAria")} title={$_("pageNav.setScopeNormalTitle")}>
						{$_("pageNav.priorityNormal")}
					</button>
				{:else}
					<span class="batch-action-receipt">{projectStore.workflowLoading ? $_("pageNav.syncingWork") : $_("pageNav.noOpenWork")}</span>
					<span class="batch-action-receipt">{projectStore.workflowLoading ? $_("pageNav.syncingWork") : $_("pageNav.noOpenWork")}</span>
					<span class="batch-action-receipt">{projectStore.workflowLoading ? $_("pageNav.syncingWork") : $_("pageNav.noOpenWork")}</span>
				{/if}
				{#if canRunActiveScopeExport}
					<button type="button" class="batch-action-btn" class:gate-ready={activeExportGate.canExport && activeExportGate.pageCount > 0} onclick={runBatchExportGate} title={$_("pageNav.checkPublicTitle")}>
						{$_("pageNav.checkPublic")}
					</button>
					<button type="button" class="batch-action-btn batch-primary-action ws-grad-primary" class:gate-ready={activeExportGate.canExport && activeExportGate.pageCount > 0} onclick={exportActiveScope} title={$_("pageNav.exportZipTitle")}>
						Export ZIP
					</button>
				{:else}
					<span class="batch-action-receipt">{projectStore.isBatchExporting ? $_("pageNav.exporting") : $_("pageNav.noExportPages")}</span>
					<span class="batch-action-receipt">{projectStore.isBatchExporting ? $_("pageNav.exporting") : $_("pageNav.noExportPages")}</span>
				{/if}
				{#if batchCreditBlocked}
					<button
						type="button"
						class="batch-action-btn credit-route"
						onclick={openCreditWorkflow}
						title={$_("pageNav.openCreditTitle")}
					>
						{$_("pageNav.openCredit")}
					</button>
				{/if}
				{#if canOpenFirstSelectedPage}
					<button type="button" class="batch-action-btn" onclick={clearSelectedPages} title={$_("pageNav.clearSelectedTitle")}>
						{$_("pageNav.clear")}
					</button>
				{:else}
					<span class="batch-action-receipt">{projectStore.isBatchExporting ? $_("pageNav.exporting") : $_("pageNav.noSelection")}</span>
				{/if}
			</div>
			<div class="batch-status-row" aria-label={$_("pageNav.batchStatusAria")}>
				{#each BATCH_STATUS_OPTIONS as option (option.id)}
					{#if canEditActiveScopeTasks}
						<button
							type="button"
							class={`batch-action-btn status-${option.id}`}
							onclick={() => markActiveScopeStatus(option.id)}
							title={$_("pageNav.moveAllToStatusTitle", { values: { label: option.label } })}
						>
							{option.label}
						</button>
					{:else}
						<span class="batch-action-receipt">{option.label}</span>
					{/if}
				{/each}
			</div>
			<div class="batch-due-row">
				<input
					class="batch-due-input"
					type="datetime-local"
					value={batchDueValue}
					aria-label={$_("pageNav.batchDueAria")}
					oninput={updateBatchDueValue}
					onkeydown={handleBatchDueKeydown}
					readonly={!canEditActiveScopeTasks}
				/>
				{#if canSetActiveScopeDue}
					<button type="button" class="batch-action-btn due-set" onclick={setActiveScopeDueAt} aria-label={$_("pageNav.setBatchDueAria")} title={$_("pageNav.setBatchDueTitle")}>
						{$_("pageNav.set")}
					</button>
				{:else}
					<span class="batch-action-receipt">{canEditActiveScopeTasks ? $_("pageNav.pickDayFirst") : $_("pageNav.noOpenWork")}</span>
				{/if}
				{#if canEditActiveScopeTasks}
					<button type="button" class="batch-action-btn" onclick={clearActiveScopeDueAt} aria-label={$_("pageNav.clearBatchDueAria")} title={$_("pageNav.clearBatchDueTitle")}>
						{$_("pageNav.clear")}
					</button>
				{:else}
					<span class="batch-action-receipt">{$_("pageNav.noOpenWork")}</span>
				{/if}
			</div>
			<div class="batch-assignee-row">
				<input
					class="batch-assignee-input"
					type="text"
					value={batchAssigneeValue}
					placeholder={$_("pageNav.assigneePlaceholder")}
					aria-label={$_("pageNav.batchAssigneeAria")}
					oninput={updateBatchAssignee}
					onkeydown={handleBatchAssigneeKeydown}
					readonly={!canEditActiveScopeTasks}
				/>
				{#if canAssignActiveScope}
					<button type="button" class="batch-action-btn" onclick={assignActiveScope} title={$_("pageNav.assignScopeTitle")}>
						{$_("pageNav.assign")}
					</button>
				{:else}
					<span class="batch-action-receipt">{canEditActiveScopeTasks ? $_("pageNav.enterNameFirst") : $_("pageNav.noOpenWork")}</span>
				{/if}
				{#if canEditActiveScopeTasks}
					<button type="button" class="batch-action-btn" onclick={clearActiveScopeAssignee} title={$_("pageNav.clearAssigneeTitle")}>
						{$_("pageNav.clear")}
					</button>
				{:else}
					<span class="batch-action-receipt">{$_("pageNav.noOpenWork")}</span>
				{/if}
			</div>
			{#if projectStore.batchExportMessage || batchGateMessage}
				<small
					class="batch-gate-message"
					class:gate-ready={(projectStore.batchExportStatus === "done") || (activeExportGate.canExport && activeExportGate.pageCount > 0)}
					class:gate-error={projectStore.batchExportStatus === "error" || (!activeExportGate.canExport && Boolean(batchGateMessage))}
					class:exporting={projectStore.isBatchExporting}
				>{projectStore.batchExportMessage || batchGateMessage}</small>
			{/if}
			{#if projectStore.batchExportProgress && projectStore.isBatchExporting}
				<small class="batch-export-progress">
					{projectStore.batchExportProgress.completed}/{projectStore.batchExportProgress.total}
					{projectStore.batchExportProgress.filename}
				</small>
			{/if}
		</div>

		{#if recentExportRuns.length}
			<div class="export-history-panel ws-panel" aria-label={$_("pageNav.exportHistoryAria")}>
				<div class="export-history-heading">
					<span>{$_("pageNav.exportHistory")}</span>
					<small>
						{$_("pageNav.recentRuns", { values: { n: recentExportRuns.length } })}{failedRecentExportRunCount ? $_("pageNav.failedSuffix", { values: { n: failedRecentExportRunCount } }) : ""}
					</small>
				</div>
				<div class="export-history-list">
					{#each recentExportRuns as run (run.id)}
						{@const runPageIndexes = getExportRunPageIndexes(run)}
						{@const missingPageCount = getExportRunMissingPageCount(run)}
						{@const retryBlockedMessage = exportRetryBlockedMessage(run, runPageIndexes)}
						{@const retryReady = canRetryExportRun(run, runPageIndexes)}
						<div class={`export-run-row ${run.status}`}>
							<div class="export-run-main">
								<strong>{run.filename}</strong>
								<small class:error-detail={run.status === "error"}>{formatExportRunMessage(run)}</small>
								<em>{formatExportRunDetail(run)}</em>
								{#if exportArtifactStatus(run)}
									<small class:artifact-retained={Boolean(run.artifact)}>{exportArtifactStatus(run)}</small>
								{/if}
								{#if run.artifactError}
									<small class="artifact-error-detail">{formatArtifactError(run.artifactError)}</small>
								{/if}
								{#if retryBlockedMessage}
									<small class="retry-blocked">{retryBlockedMessage}</small>
								{/if}
								{#if exportFailedPageHint(run)}
									<small class="failed-page-hint">{exportFailedPageHint(run)}</small>
								{/if}
							</div>
							<div class="export-run-actions">
								{#if runPageIndexes.length && !projectStore.isBatchExporting}
									<button
										type="button"
										class="batch-action-btn export-focus-btn"
										onclick={() => focusExportRun(run)}
										aria-label={$_("pageNav.focusExportAria", { values: { file: run.filename } })}
										title={$_("pageNav.focusExportTitle")}
									>
										{$_("pageNav.focus")}
									</button>
								{:else}
									<span class="batch-action-status export-focus-status" title={runPageIndexes.length ? $_("pageNav.exportingNow") : exportRunUnavailableMessage(run)}>
										{runPageIndexes.length ? $_("pageNav.exporting") : $_("pageNav.noPages")}
									</span>
								{/if}
								{#if retryReady}
									<button
										type="button"
										class="batch-action-btn export-retry-btn"
										onclick={() => retryExportRun(run)}
										aria-label={`${exportRetryActionLabel(run)} ${run.filename}`}
										title={exportRetryTitle(run, runPageIndexes, missingPageCount)}
									>
										{exportRetryActionLabel(run)}
									</button>
								{:else}
									<span class="batch-action-status export-retry-status" title={exportRetryTitle(run, runPageIndexes, missingPageCount)}>
										{projectStore.isBatchExporting ? $_("pageNav.exporting") : $_("pageNav.waitingClear")}
									</span>
								{/if}
								{#if run.status === "done" && run.kind === "batch-zip"}
									{#if projectStore.canDownloadExportRun(run.id)}
										<button
											type="button"
											class="batch-action-btn export-download-btn"
											onclick={() => void projectStore.downloadExportRun(run.id)}
											aria-label={$_("pageNav.downloadExportAria", { values: { file: run.filename } })}
											title={exportDownloadTitle(run)}
										>
											{$_("pageNav.download")}
										</button>
									{:else}
										<span class="batch-action-status export-download-status" title={exportDownloadTitle(run)}>
											{$_("pageNav.downloadNotReady")}
										</span>
									{/if}
									{#if run.artifact}
										{#if projectStore.canDeleteExportArtifact(run.id)}
											<button
												type="button"
												class="batch-action-btn export-delete-btn"
												onclick={() => void projectStore.deleteExportArtifact(run.id)}
												aria-label={$_("pageNav.deleteStoredExportAria", { values: { file: run.filename } })}
												title={exportDeleteTitle(run)}
											>
												{$_("pageNav.deleteFile")}
											</button>
										{:else}
											<span class="batch-action-status export-delete-status" title={exportDeleteTitle(run)}>
												{$_("pageNav.deleteZipNotReady")}
											</span>
										{/if}
									{/if}
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="page-manager-toolbar">
			<div class="page-filter-row" role="group" aria-label={$_("pageNav.pageFilterAria")}>
				{#each pageFilters as filter (filter.id)}
					<button
						class="page-filter-btn ws-btn-ghost"
						class:active={pageFilter === filter.id}
						onclick={() => setPageFilter(filter.id)}
						aria-pressed={pageFilter === filter.id}
					>
						{filter.label}
					</button>
				{/each}
			</div>
			<div class="page-jump-row">
				<input
					id="page-jump"
					class="panel-input"
					type="text"
					inputmode="numeric"
					pattern="[0-9]*"
					placeholder={$_("pageNav.pageJumpPlaceholder")}
					value={pageJumpValue}
					oninput={updatePageJump}
					onkeydown={handlePageJumpKeydown}
					readonly={!projectStore.project}
				/>
				{#if canJumpToTypedPage}
					<button
						class="panel-btn page-jump-btn ws-grad-primary"
						onclick={submitPageJump}
					>
						{$_("pageNav.go")}
					</button>
				{:else}
					<span class="page-jump-receipt">{projectStore.project ? $_("pageNav.enterPageNumber") : $_("pageNav.openWorkFirst")}</span>
				{/if}
			</div>
		</div>

		<div
			class="page-mini-list"
			aria-label={$_("pageNav.pagesInChapterAria")}
			data-reading-direction={readingDirection}
			data-virtualized={virtualizationActive ? "true" : "false"}
			use:registerPageList
			onscroll={handleListScroll}
		>
			{#if virtualizationActive && virtualWindow.padStart > 0}
				<div class="page-mini-spacer" style={`height:${virtualWindow.padStart}px`} aria-hidden="true"></div>
			{/if}
			{#each visiblePageSummaries as summary (summary.pageIndex)}
				{@const thumbnailUrl = getPageThumbnailUrl(summary)}
				{@const thumbnailParams = getPageThumbnailParams(summary)}
				<div
					class={`page-mini-row ws-panel-quiet ${summary.status}`}
					class:asset-attention={summary.assetIntegrity?.status === "missing" || summary.assetIntegrity?.status === "failed" || summary.assetIntegrity?.status === "blocked"}
					class:active={summary.pageIndex === projectStore.project.currentPage}
					class:selected={isPageSelected(summary)}
				>
					<button
						type="button"
						class="page-select-toggle"
						class:selected={isPageSelected(summary)}
						onclick={() => togglePageSelection(summary)}
						aria-pressed={isPageSelected(summary)}
						aria-label={$_("pageNav.selectPageIntoBatchAria", { values: { n: summary.pageNumber } })}
					>
					</button>
					{#if projectStore.pageNavigationBusy}
						<span
							class="page-row-open page-row-open-receipt"
							aria-label={$_("pageNav.openingPageAria", { values: { n: summary.pageNumber } })}
						>
							<span class="page-thumb" aria-hidden="true">
								{#if thumbnailUrl && thumbnailParams}
									<img
										use:signedAssetSrc={thumbnailParams}
										alt=""
										loading="lazy"
										decoding="async"
									/>
								{:else}
									<span>P{summary.pageNumber}</span>
								{/if}
							</span>
							<span class="page-mini-main">
								<span>{summary.name}</span>
								<small>{$_("pageNav.openingPage")}</small>
							</span>
						</span>
					{:else}
						<button
							type="button"
							class="page-row-open"
							onclick={() => goToPage(summary.pageIndex)}
							aria-label={$_("pageNav.openPageAria", { values: { n: summary.pageNumber, status: resolvePageStatusText(summary.statusLabel, $_, $_("pageWork.statusFallback")) } })}
							title={summary.exportBlockers.length ? summary.exportBlockers.join(", ") : resolvePageStatusText(summary.statusLabel, $_, $_("pageWork.statusFallback"))}
						>
						<span class="page-thumb" aria-hidden="true">
							{#if thumbnailUrl && thumbnailParams}
								<img
									use:signedAssetSrc={thumbnailParams}
									alt=""
									loading="lazy"
									decoding="async"
								/>
							{:else}
								<span>P{summary.pageNumber}</span>
							{/if}
						</span>
						<span class="page-mini-main">
							<span>{summary.name}</span>
							<span class="page-mini-signals">
								<span class={`page-status-chip ${summary.status}`}>{resolvePageStatusText(summary.statusLabel, $_, $_("pageWork.statusFallback"))}</span>
								<span
									class:exportReady={summary.exportReady}
									class:issue-hot={!summary.exportReady}
									class="page-count-chip"
									title={summary.exportBlockers.join(", ") || $_("pageNav.pageReadyExport")}
								>
									{formatExportLabel(summary)}
								</span>
								{#if summary.assetIntegrity}
									<span class={`page-asset-chip ${summary.assetIntegrity.status}`} title={summary.assetIntegrity.detail}>
										{resolvePageAssetLabelText(summary.assetIntegrity, $_)}
									</span>
								{/if}
								<span class="page-count-chip">{$_("pageNav.countLayers", { values: { n: summary.layerCount } })}</span>
								<span class:issue-hot={summary.qcErrorCount > 0 || summary.qcWarningCount > 0} class="page-count-chip">
									{formatQcLabel(summary)}
								</span>
								{#if summary.openCommentCount > 0}
									<span class="page-count-chip issue-hot">{$_("pageNav.countNotes", { values: { n: summary.openCommentCount } })}</span>
								{/if}
								{#if summary.aiAttentionCount > 0}
									<span class="page-count-chip issue-hot">{$_("pageNav.countAiResults", { values: { n: summary.aiAttentionCount } })}</span>
								{/if}
								{#if summary.overdueTaskCount > 0}
									<span class="page-priority-chip overdue" title={$_("pageNav.overdueOnPageTitle")}>{$_("pageNav.countOverdue", { values: { n: summary.overdueTaskCount } })}</span>
								{:else if summary.nextDueAt}
									<span class="page-count-chip due" title={$_("pageNav.nextDueTitle")}>{$_("pageNav.dueOn", { values: { day: formatWorkflowDueDay(summary.nextDueAt) } })}</span>
								{/if}
								{#if summary.urgentTaskCount > 0}
									<span class="page-priority-chip urgent" title={$_("pageNav.urgentOnPageTitle")}>{$_("pageNav.countUrgent", { values: { n: summary.urgentTaskCount } })}</span>
								{:else if summary.highTaskCount > 0}
									<span class="page-priority-chip high" title={$_("pageNav.highOnPageTitle")}>{$_("pageNav.countHigh", { values: { n: summary.highTaskCount } })}</span>
								{/if}
								<span class="page-assignee-chip" title={formatAssignees(summary)}>
									{formatAssignees(summary)}
								</span>
								<LockOwnerIndicator
									scope="page"
									scopeId={pageLockId(projectStore.project.projectId, summary.pageIndex)}
								/>
							</span>
						</span>
						</button>
					{/if}
					<div class="page-row-actions" aria-label={$_("pageNav.pageActionsAria", { values: { n: summary.pageNumber } })}>
						{#if summary.pageIndex > 0}
							<button
								type="button"
								class="page-row-action-btn"
								onclick={() => movePage(summary, -1)}
								aria-label={$_("pageNav.movePageAria", { values: { n: summary.pageNumber, dir: moveControls.earlier.word } })}
								title={$_("pageNav.movePageTitle", { values: { dir: moveControls.earlier.word } })}
							>{moveControls.earlier.glyph}</button>
						{:else}
							<span class="page-row-action-receipt" aria-label={$_("pageNav.pageAtTopAria", { values: { n: summary.pageNumber } })}>{moveControls.earlier.glyph}</span>
						{/if}
						{#if summary.pageIndex < projectStore.project.pages.length - 1}
							<button
								type="button"
								class="page-row-action-btn"
								onclick={() => movePage(summary, 1)}
								aria-label={$_("pageNav.movePageAria", { values: { n: summary.pageNumber, dir: moveControls.later.word } })}
								title={$_("pageNav.movePageTitle", { values: { dir: moveControls.later.word } })}
							>{moveControls.later.glyph}</button>
						{:else}
							<span class="page-row-action-receipt" aria-label={$_("pageNav.pageAtBottomAria", { values: { n: summary.pageNumber } })}>{moveControls.later.glyph}</span>
						{/if}
						<button
							type="button"
							class="page-row-action-btn relink"
							onclick={() => relinkPage(summary)}
							aria-label={summary.assetIntegrity?.issueKind === "image-layer"
								? $_("pageNav.recoverExtraImagePageAria", { values: { n: summary.pageNumber } })
								: $_("pageNav.recoverPageImageNumberAria", { values: { n: summary.pageNumber } })}
							title={summary.assetIntegrity?.issueKind === "image-layer" ? $_("pageNav.recoverExtraImage") : $_("pageNav.recoverImage")}
						>R</button>
					</div>
				</div>
			{/each}
			{#if virtualizationActive && virtualWindow.padEnd > 0}
				<div class="page-mini-spacer" style={`height:${virtualWindow.padEnd}px`} aria-hidden="true"></div>
			{/if}
			{#if filteredPageSummaries.length === 0}
				<div class="empty-state">{$_("pageNav.noPagesMatchFilter")}</div>
			{/if}
	</div>
	{:else}
		<div class="empty-state">{$_("pageNav.openWorkBeforeManaging")}</div>
	{/if}
</div>

<style>
	.pages-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: var(--color-ws-ink);
		--pn-surface-soft: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		--pn-surface-muted: color-mix(in srgb, var(--color-ws-surface) 70%, transparent);
		--pn-surface-hover: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		--pn-accent-line: color-mix(in srgb, var(--color-ws-accent) 46%, transparent);
		--pn-accent-soft: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		--pn-blue-line: color-mix(in srgb, var(--color-ws-blue) 42%, transparent);
		--pn-blue-soft: color-mix(in srgb, var(--color-ws-blue) 14%, transparent);
		--pn-cyan-line: color-mix(in srgb, var(--color-ws-cyan) 38%, transparent);
		--pn-cyan-soft: color-mix(in srgb, var(--color-ws-cyan) 12%, transparent);
		--pn-green-line: color-mix(in srgb, var(--color-ws-green) 42%, transparent);
		--pn-green-soft: color-mix(in srgb, var(--color-ws-green) 14%, transparent);
		--pn-green-strong: color-mix(in srgb, var(--color-ws-green) 70%, var(--color-ws-ink));
		--pn-amber-line: color-mix(in srgb, var(--color-ws-amber) 42%, transparent);
		--pn-amber-soft: color-mix(in srgb, var(--color-ws-amber) 12%, transparent);
		--pn-amber-strong: color-mix(in srgb, var(--color-ws-amber) 72%, var(--color-ws-ink));
		--pn-rose-line: color-mix(in srgb, var(--color-ws-rose) 48%, transparent);
		--pn-rose-soft: color-mix(in srgb, var(--color-ws-rose) 14%, transparent);
		--pn-rose-strong: color-mix(in srgb, var(--color-ws-rose) 76%, var(--color-ws-ink));
	}

	.page-navigator {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr) 40px;
		align-items: center;
		gap: 8px;
	}

	.page-nav-btn,
	.page-nav-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 800;
	}

	.page-nav-btn {
		cursor: pointer;
	}

	.page-nav-receipt {
		border-style: dashed;
		color: var(--color-ws-faint);
	}

	.page-nav-btn:hover {
		border-color: var(--pn-accent-line);
		background: var(--pn-surface-hover);
	}

	.page-current {
		display: flex;
		min-width: 0;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 700;
	}

	.page-current small {
		max-width: 100%;
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.reading-dir-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px;
		border: 1px solid var(--pn-cyan-line);
		border-radius: 999px;
		background: var(--pn-cyan-soft);
		color: var(--color-ws-cyan) !important;
		font-weight: 800 !important;
	}

	.reading-dir-chip span {
		font-weight: 900;
	}

	.page-focus-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		padding: 10px;
		border-color: var(--pn-blue-line);
		border-radius: var(--radius-ws-card);
		background: var(--pn-blue-soft);
	}

	.page-focus-card.blocked {
		border-color: var(--pn-rose-line);
		background: var(--pn-rose-soft);
	}

	.page-focus-card.review {
		border-color: var(--pn-amber-line);
		background: var(--pn-amber-soft);
	}

	.page-focus-card.ready {
		border-color: var(--pn-green-line);
		background: var(--pn-green-soft);
	}

	.page-focus-card.empty {
		border-color: var(--pn-blue-line);
		background: var(--pn-blue-soft);
	}

	.page-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.page-focus-copy span,
	.page-focus-stats span,
	.page-focus-blocker span {
		color: var(--color-ws-faint);
		font-size: 9px;
		font-weight: 900;
		text-transform: uppercase;
	}

	.page-focus-copy strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 850;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.page-focus-copy small,
	.page-focus-copy em {
		color: var(--color-ws-text);
		font-size: 10px;
		font-style: normal;
		font-weight: 720;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.page-focus-stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(42px, auto));
		gap: 5px;
	}

	.page-focus-stats div {
		min-width: 42px;
		padding: 5px 6px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-soft);
		text-align: center;
	}

	.page-focus-stats strong {
		display: block;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
	}

	.page-focus-blocker {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 7px 8px;
		border: 1px solid var(--pn-rose-line);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-rose-soft);
	}

	.page-focus-blocker strong {
		color: var(--pn-rose-strong);
		font-size: 12px;
		font-weight: 900;
		line-height: 1.25;
	}

	.page-focus-blocker small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.3;
	}

	.page-focus-actions {
		display: flex;
		grid-column: 1 / -1;
		gap: 6px;
	}

	.page-focus-actions button {
		flex: 1 1 0;
		min-height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
	}

	.page-focus-actions button:hover {
		border-color: var(--pn-accent-line);
		background: var(--pn-surface-hover);
	}

	.page-focus-actions .page-focus-primary-action {
		border-color: var(--pn-accent-line);
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
	}

	.page-focus-actions .page-focus-primary-action.gate-ready {
		border-color: var(--pn-green-line);
		color: var(--color-ws-ink);
	}

	.page-manager-toolbar {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.page-filter-row {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding-bottom: 1px;
	}

	.page-filter-btn {
		flex: 1 1 68px;
		min-width: 0;
		min-height: 40px;
		padding: 0 7px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 10px;
		font-weight: 750;
	}

	.page-filter-btn:hover,
	.page-filter-btn.active {
		border-color: var(--pn-accent-line);
		background: var(--pn-accent-soft);
		color: var(--color-ws-ink);
	}

	.page-jump-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 52px;
		gap: 6px;
	}

	.page-jump-btn,
	.page-jump-receipt {
		display: grid;
		align-items: center;
		justify-items: center;
		height: 40px;
		padding: 0;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		font-size: 11px;
	}

	.page-jump-btn {
		border-color: var(--pn-accent-line);
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-weight: 850;
	}

	.page-jump-receipt {
		border-style: dashed;
		color: var(--color-ws-faint);
		font-weight: 750;
		text-align: center;
	}

	.page-jump-btn:hover {
		border-color: var(--pn-accent-line);
		filter: brightness(1.05);
	}

	.page-jump-row .panel-input {
		min-width: 0;
		height: 40px;
		padding: 0 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-ink);
		font-size: 11px;
		outline: none;
	}

	.page-jump-row .panel-input:focus {
		border-color: var(--pn-accent-line);
		box-shadow: var(--ws-focus-ring);
	}

	.batch-action-bar {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 6px;
		padding: 8px;
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
	}

	.batch-summary {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.batch-summary span {
		color: var(--color-ws-faint);
		font-size: 9px;
		font-weight: 850;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	.batch-summary strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		line-height: 1.2;
	}

	.batch-summary small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.batch-actions {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
		gap: 4px;
	}

	.batch-status-row {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 4px;
	}

	.batch-assignee-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 54px 48px;
		gap: 4px;
	}

	.batch-due-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 54px 48px;
		gap: 4px;
	}

	.batch-assignee-input,
	.batch-due-input {
		min-width: 0;
		height: 40px;
		padding: 0 7px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 42%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		outline: none;
	}

	.batch-assignee-input:focus,
	.batch-due-input:focus {
		border-color: var(--pn-accent-line);
		box-shadow: var(--ws-focus-ring);
	}

	.batch-assignee-input:read-only,
	.batch-due-input:read-only {
		opacity: 0.35;
	}

	.batch-action-btn,
	.batch-action-receipt {
		display: inline-flex;
		min-width: 0;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 750;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.batch-action-btn {
		cursor: pointer;
	}

	.batch-action-receipt {
		border-style: dashed;
		cursor: default;
		text-align: center;
	}

	.batch-action-btn:hover {
		border-color: var(--pn-accent-line);
		background: var(--pn-surface-hover);
		color: var(--color-ws-ink);
	}

	.batch-action-btn.gate-ready {
		border-color: var(--pn-green-line);
		color: var(--pn-green-strong);
	}

	.batch-action-btn.batch-primary-action {
		border-color: var(--ws-hair);
		background: var(--pn-surface-muted);
		color: var(--color-ws-text);
	}

	.batch-action-btn.batch-primary-action.gate-ready {
		border-color: var(--pn-accent-line);
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
	}

	.batch-action-btn.credit-route {
		border-color: var(--pn-blue-line);
		background: var(--pn-blue-soft);
		color: var(--color-ws-blue);
	}

	.batch-action-btn.priority-urgent {
		border-color: var(--pn-rose-line);
		background: var(--pn-rose-soft);
		color: var(--pn-rose-strong);
	}

	.batch-action-btn.priority-high {
		border-color: var(--pn-amber-line);
		background: var(--pn-amber-soft);
		color: var(--pn-amber-strong);
	}

	.batch-action-btn.priority-normal {
		border-color: var(--ws-hair-strong);
		color: var(--color-ws-text);
	}

	.batch-action-btn.status-doing {
		border-color: var(--pn-blue-line);
		color: var(--color-ws-blue);
	}

	.batch-action-btn.status-review {
		border-color: var(--pn-amber-line);
		color: var(--pn-amber-strong);
	}

	.batch-action-btn.status-done {
		border-color: var(--pn-green-line);
		color: var(--pn-green-strong);
	}

	.batch-action-btn.due-set {
		border-color: var(--pn-blue-line);
		color: var(--color-ws-blue);
	}

	.batch-action-status {
		display: inline-flex;
		min-width: 0;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-faint);
		font-size: 10px;
		font-weight: 750;
		text-align: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.batch-gate-message {
		display: block;
		padding-top: 1px;
		color: var(--pn-amber-strong);
		font-size: 10px;
		font-weight: 700;
		line-height: 1.25;
	}

	.batch-gate-message.gate-ready {
		color: var(--pn-green-strong);
	}

	.batch-gate-message.gate-error {
		color: var(--pn-rose-strong);
	}

	.batch-gate-message.exporting,
	.batch-export-progress {
		color: var(--color-ws-blue);
	}

	.batch-export-progress {
		display: block;
		overflow: hidden;
		font-size: 10px;
		font-weight: 700;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.export-history-panel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
	}

	.export-history-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.export-history-heading span {
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
	}

	.export-history-heading small {
		color: var(--color-ws-text);
		font-size: 10px;
	}

	.export-history-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.export-run-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		align-items: center;
		padding-left: 6px;
		border-left: 3px solid var(--pn-green-line);
	}

	.export-run-row.error {
		border-left-color: var(--pn-rose-line);
	}

	.export-run-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.export-run-main strong,
	.export-run-main small,
	.export-run-main em {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.export-run-main strong {
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 800;
	}

	.export-run-main small {
		color: var(--color-ws-text);
		font-size: 10px;
	}

	.export-run-main small.error-detail {
		color: var(--pn-rose-strong);
	}

	.export-run-main small.retry-blocked {
		color: var(--color-ws-amber);
		white-space: normal;
	}

	.export-run-main small.failed-page-hint {
		color: var(--color-ws-amber);
		font-weight: 850;
		white-space: normal;
	}

	.export-run-main small.artifact-retained {
		color: var(--color-ws-violet);
	}

	.export-run-main small.artifact-error-detail {
		color: var(--pn-rose-strong);
		white-space: normal;
	}

	.export-run-main em {
		color: var(--color-ws-faint);
		font-size: 9px;
		font-style: normal;
		font-weight: 700;
		text-transform: uppercase;
	}

	.export-run-actions {
		display: flex;
		max-width: 148px;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 4px;
	}

	.export-retry-btn {
		width: 52px;
	}

	.export-retry-status {
		width: 72px;
	}

	.export-focus-btn {
		width: 44px;
	}

	.export-focus-status {
		width: 64px;
	}

	.export-download-btn,
	.export-delete-btn {
		width: 72px;
	}

	.page-mini-list {
		display: flex;
		max-height: 330px;
		flex-direction: column;
		gap: 4px;
		overflow-y: auto;
		padding-right: 2px;
	}

	/* Virtualization spacers stand in for off-window rows so the scrollbar geometry
	   stays correct. They must not shrink (flex column) and never add gap of their own. */
	.page-mini-spacer {
		flex: 0 0 auto;
		width: 100%;
		pointer-events: none;
	}

	/* Webtoon/vertical: render the strip as a single continuous scroll stack so the
	   preview matches the chosen reading mode (pages butt together, no gaps). */
	.page-mini-list[data-reading-direction="vertical"] {
		gap: 0;
	}

	.page-mini-list[data-reading-direction="vertical"] .page-mini-row {
		border-radius: 0;
		border-top-color: var(--ws-hair);
	}

	.page-mini-list[data-reading-direction="vertical"] .page-mini-row:first-child {
		border-top-left-radius: var(--radius-ws-card);
		border-top-right-radius: var(--radius-ws-card);
	}

	.page-mini-list[data-reading-direction="vertical"] .page-mini-row:last-child {
		border-bottom-left-radius: var(--radius-ws-card);
		border-bottom-right-radius: var(--radius-ws-card);
	}

	.page-mini-row {
		display: grid;
		flex: 0 0 auto;
		grid-template-columns: 40px minmax(0, 1fr) 40px;
		align-items: start;
		gap: 6px;
		width: 100%;
		min-height: 104px;
		padding: 7px 6px;
		border: 1px solid transparent;
		border-left-color: var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		color: var(--color-ws-ink);
		text-align: left;
	}

	.page-mini-row:hover {
		border-color: var(--ws-hair-strong);
		background: var(--pn-surface-hover);
	}

	.page-mini-row.active {
		border-color: var(--pn-accent-line);
		background: var(--pn-accent-soft);
	}

	.page-mini-row.selected {
		border-color: var(--pn-blue-line);
		background: var(--pn-blue-soft);
	}

	.page-mini-row.blocked {
		border-left-color: var(--pn-rose-line);
	}

	.page-mini-row.review {
		border-left-color: var(--pn-amber-line);
	}

	.page-mini-row.ready {
		border-left-color: var(--pn-green-line);
	}

	.page-mini-row.empty {
		border-left-color: var(--pn-blue-line);
	}

	.page-mini-row.asset-attention {
		border-color: var(--pn-rose-line);
		background: var(--pn-rose-soft);
	}

	.asset-recovery-card {
		display: flex;
		min-width: 0;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 10px;
		border-color: var(--pn-amber-line);
		border-radius: var(--radius-ws-card);
		background: var(--pn-amber-soft);
	}

	.asset-recovery-card.failed,
	.asset-recovery-card.missing,
	.asset-recovery-card.blocked {
		border-color: var(--pn-rose-line);
		background: var(--pn-rose-soft);
	}

	.asset-recovery-copy {
		display: flex;
		min-width: 0;
		flex: 1 1 190px;
		flex-direction: column;
		gap: 3px;
	}

	.asset-recovery-copy span {
		color: var(--pn-amber-strong);
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	.asset-recovery-card.failed .asset-recovery-copy span,
	.asset-recovery-card.missing .asset-recovery-copy span,
	.asset-recovery-card.blocked .asset-recovery-copy span {
		color: var(--pn-rose-strong);
	}

	.asset-recovery-copy strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	.asset-recovery-copy small {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 650;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.asset-recovery-actions {
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.asset-recovery-actions button,
	.asset-recovery-wait {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-ink);
		font-family: inherit;
		font-size: 11px;
		font-weight: 850;
		white-space: nowrap;
	}

	.asset-recovery-actions button {
		cursor: pointer;
	}

	.asset-recovery-actions button:hover {
		border-color: var(--pn-amber-line);
		color: var(--pn-amber-strong);
	}

	.asset-recovery-actions button:first-child {
		border-color: var(--pn-accent-line);
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
	}

	.asset-recovery-wait {
		color: var(--color-ws-faint);
	}

	.page-select-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		margin-top: 0;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		cursor: pointer;
	}

	.page-select-toggle.selected {
		border-color: var(--pn-accent-line);
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
	}

	.page-select-toggle.selected::after {
		display: block;
		width: 10px;
		height: 10px;
		border-radius: max(2px, calc(var(--radius-ws-ctrl) / 5));
		background: var(--color-ws-ink);
		content: "";
	}

	.page-row-open {
		display: grid;
		grid-template-columns: 42px minmax(0, 1fr);
		align-items: start;
		gap: 8px;
		min-width: 0;
		min-height: 40px;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.page-row-open-receipt {
		color: var(--color-ws-faint);
		cursor: default;
	}

	.page-row-actions {
		display: flex;
		flex-direction: column;
		gap: 4px;
		align-items: stretch;
	}

	.page-row-action-btn,
	.page-row-action-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		min-height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 900;
		line-height: 1;
	}

	.page-row-action-btn {
		cursor: pointer;
	}

	.page-row-action-receipt {
		border-style: dashed;
	}

	.page-row-action-btn:hover {
		border-color: var(--pn-accent-line);
		background: var(--pn-surface-hover);
		color: var(--color-ws-ink);
	}

	.page-row-action-btn.relink:hover {
		border-color: var(--pn-amber-line);
		color: var(--pn-amber-strong);
	}

	.page-thumb {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 42px;
		height: 58px;
		overflow: hidden;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--pn-surface-muted);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 850;
	}

	.page-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.page-mini-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.page-mini-main > span:not(.page-mini-signals) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.page-mini-main > span:not(.page-mini-signals) {
		font-size: 11px;
		font-weight: 650;
	}

	.page-mini-main small {
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	.page-mini-signals {
		display: flex;
		min-width: 0;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 4px;
		overflow: visible;
	}

	.page-status-chip,
	.page-count-chip,
	.page-priority-chip,
	.page-assignee-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		max-width: 82px;
		min-height: 18px;
		padding: 2px 5px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: var(--pn-surface-muted);
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.page-status-chip.blocked,
	.page-count-chip.issue-hot {
		border-color: var(--pn-rose-line);
		background: var(--pn-rose-soft);
		color: var(--pn-rose-strong);
	}

	.page-count-chip.due {
		border-color: var(--pn-blue-line);
		background: var(--pn-blue-soft);
		color: var(--color-ws-blue);
	}

	.page-count-chip.exportReady {
		border-color: var(--pn-green-line);
		background: var(--pn-green-soft);
		color: var(--pn-green-strong);
	}

	.page-priority-chip.urgent {
		border-color: var(--pn-rose-line);
		background: var(--pn-rose-soft);
		color: var(--pn-rose-strong);
	}

	.page-priority-chip.overdue {
		border-color: var(--pn-rose-line);
		background: var(--pn-rose-soft);
		color: var(--pn-rose-strong);
	}

	.page-priority-chip.high {
		border-color: var(--pn-amber-line);
		background: var(--pn-amber-soft);
		color: var(--pn-amber-strong);
	}

	.page-status-chip.review {
		border-color: var(--pn-amber-line);
		background: var(--pn-amber-soft);
		color: var(--pn-amber-strong);
	}

	.page-status-chip.ready {
		border-color: var(--pn-green-line);
		background: var(--pn-green-soft);
		color: var(--pn-green-strong);
	}

	.page-status-chip.empty {
		border-color: var(--pn-blue-line);
		background: var(--pn-blue-soft);
		color: var(--color-ws-blue);
	}

	.page-assignee-chip {
		max-width: 96px;
		color: var(--color-ws-ink);
	}

	.page-asset-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		justify-self: flex-end;
		max-width: 64px;
		min-height: 18px;
		padding: 2px 5px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: var(--pn-surface-muted);
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.page-current .page-asset-chip {
		justify-self: center;
		max-width: 92px;
	}

	.page-asset-chip.ready {
		border-color: var(--pn-green-line);
		background: var(--pn-green-soft);
		color: var(--pn-green-strong);
	}

	.page-asset-chip.scanning {
		border-color: var(--pn-amber-line);
		background: var(--pn-amber-soft);
		color: var(--pn-amber-strong);
	}

	.page-asset-chip.missing,
	.page-asset-chip.failed,
	.page-asset-chip.blocked {
		border-color: var(--pn-rose-line);
		background: var(--pn-rose-soft);
		color: var(--pn-rose-strong);
	}

	@media (max-width: 420px) {
		.asset-recovery-card {
			align-items: stretch;
			flex-direction: column;
		}

		.asset-recovery-actions {
			justify-content: stretch;
		}

		.asset-recovery-actions button {
			flex: 1 1 120px;
		}
	}
</style>
