<script lang="ts">
	import { _ } from "$lib/i18n";
	import { buildWorkspaceHref } from "$lib/navigation/workspace-routes.js";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { SUPPORTED_IMAGE_ACCEPT } from "$lib/project/file-order.js";
	import { EXPORT_SPLIT_MAX_PIECES, EXPORT_SPLIT_MIN_HEIGHT, type ExportSplitOptions } from "$lib/project/page-export.js";
	import { pageImageRelinkOrderFallbackCancelMessage } from "$lib/project/page-relink-confirmation.js";
	import { buildChapterDashboard } from "$lib/project/chapter-dashboard.js";
	import {
		exportHistoryPagesMissingCopy,
		exportBlockerCopy,
		exportMissingPagesCopy,
		exportRetryCopy,
	} from "$lib/project/page-work-copy.js";
	import {
		resolvePageStatusText,
		resolvePageAssetLabelText,
		resolvePageSignalLabel,
		resolvePageSignalDetail,
	} from "$lib/project/page-work-copy-i18n.js";
	import {
		type BatchExportGate,
		type ExportChecklistGroup,
	} from "$lib/project/page-operations.js";
	import {
		formatExportRunMessage,
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
		requiredCreditGateDetail,
	} from "$lib/project/export-profiles.js";
	import {
		pageNeedsAttention,
		resolveVisiblePageLayerCount,
		summarizePageBatch,
		summarizePageWork,
		type PageWorkSummary,
	} from "$lib/project/page-work-summary.js";
	import { formatAssigneeHandle, normalizeAssigneeHandle } from "$lib/project/assignees.js";
	import { buildTaskFocusQueue, type TaskFocusItem } from "$lib/project/task-focus-queue.js";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.js";
	import { findAiResultPlacementMarker } from "$lib/project/ai-review-marker-intent.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { effectiveTeamMode } from "$lib/stores/workspace-team-mode.ts";
	import { pageRelinkConfirmationStore } from "$lib/stores/page-relink-confirmation.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import type { WorkspaceStudioRole } from "$lib/api/client.js";
	import type { QcIssue } from "$lib/project/qc-checks.js";
	import type { PageAssetLoadIssue } from "$lib/project/page-assets.js";
	import type {
		AiReviewMarker,
		ExportRun,
		Page,
		PageReviewDecision,
		ProjectComment,
		ProjectState,
		WorkflowTask,
		WorkflowTaskPriority,
		WorkflowTaskType,
	} from "$lib/types.js";
	import WorkspaceChapterQueue from "./WorkspaceChapterQueue.svelte";
	import WorkspaceTopUtilityBar from "./WorkspaceTopUtilityBar.svelte";
	import DefaultCover from "./ui/DefaultCover.svelte";
	import NumberValue from "./ui/NumberValue.svelte";
	import StatTile from "./ui/StatTile.svelte";
	import PageTile, { type PageRoleDot, type PageStatusChip } from "./ui/PageTile.svelte";
	import SparkleIcon from "./ui/SparkleIcon.svelte";
	import AiJobCard from "./ui/AiJobCard.svelte";
	import AttentionRow from "./ui/AttentionRow.svelte";
	import SectionBand from "./ui/SectionBand.svelte";
	import ModeToggle from "./ui/ModeToggle.svelte";
	import RoleBadge, { type WorkRole, type RoleState as AtomRoleState } from "./ui/RoleBadge.svelte";
	import LanguageCoverageChips from "./ui/LanguageCoverageChips.svelte";
	import { thumbnailUrl as buildThumbnailUrl } from "$lib/api/client.js";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";

	// ---- Chapter reskin (chapter.html): role-scoped status dots + 2-mode view ----
	type ChapterRole = "clean" | "translate" | "typeset" | "qc";
	type RoleState = "done" | "wait" | "active" | "none";
	type AssignmentScope = "current" | "next" | "visible";
	type AssignmentRole = "all" | WorkflowTaskType;

	const ROLE_ORDER: ChapterRole[] = ["clean", "translate", "typeset", "qc"];
	const ASSIGNMENT_ROLES: AssignmentRole[] = ["all", "clean", "translate", "typeset", "review"];
	let ROLE_LABEL = $derived<Record<ChapterRole, string>>({
		clean: $_("pagesView.roleClean"),
		translate: $_("pagesView.roleTranslate"),
		typeset: $_("pagesView.roleTypeset"),
		qc: "QC",
	});
	const ROLE_DOT: Record<ChapterRole, string> = {
		clean: "bg-ws-green",
		translate: "bg-ws-cyan",
		typeset: "bg-ws-violet",
		qc: "bg-ws-amber",
	};
	const ROLE_STATE_COLOR: Record<RoleState, string> = {
		done: "var(--color-ws-green)",
		active: "var(--color-ws-accent)",
		wait: "var(--color-ws-amber)",
		none: "var(--color-ws-faint)",
	};

	interface PagesNextVisualPreview {
		pageLabel: string;
		title: string;
		detail: string;
		previewUrl: string | null;
		previewParams: SignedAssetSrcParams | null;
		regionStyle: string | null;
	}

	let pageSummaries = $derived.by(() => buildPageSummaries(
		projectStore.project,
		projectStore.tasks,
		projectStore.comments,
		projectStore.aiReviewMarkers,
		projectStore.reviewDecisions,
		projectStore.qcReport.issues,
		editorStore.textLayers.length,
		editorStore.hasImage,
	));
	let chapterBatchSummary = $derived(summarizePageBatch(pageSummaries));
	let chapterDashboard = $derived(buildChapterDashboard(pageSummaries, chapterBatchSummary));
	let chapterPageIndexes = $derived(projectStore.project?.pages.map((_, index) => index) ?? []);
	let chapterExportGate = $derived(projectStore.getBatchExportGate(chapterPageIndexes));
	let chapterExportGateMessage = $state("");
	// $_ read keeps this label reactive to locale switches (codex P2).
	let chapterExportTargetLabel = $derived(($_, batchExportActionTargetLabel(projectStore.project?.creditPolicy)));
	let allTaskFocusItems = $derived(buildTaskFocusQueue(projectStore.workInbox, projectStore.tasks));
	let currentPageSummary = $derived(
		projectStore.project ? pageSummaries[projectStore.project.currentPage] ?? null : null,
	);
	let nextPageSummary = $derived(
		pageSummaries.find(pageNeedsAttention) ?? currentPageSummary ?? pageSummaries[0] ?? null,
	);
	let nextPreviewFailures = $state<Record<string, boolean>>({});
	let nextPageVisual = $derived(buildPagesNextVisualPreview(nextPageSummary));
	let assetRecoverySummaries = $derived(pageSummaries.filter(assetNeedsRecovery));
	let chapterCreditCount = $derived(projectStore.countChapterCreditLayers());
	let publicExportCreditBlocked = $derived((projectStore.project?.creditPolicy ?? "optional") === "required" && chapterCreditCount === 0);
	let recentExportRuns = $derived(getVisibleExportHistoryRuns(projectStore.exportRuns));
	let failedRecentExportRunCount = $derived(recentExportRuns.filter((run) => run.status === "error").length);
	let exportHistoryHasFailureAttention = $derived(
		recentExportRuns.some((run) => run.status === "error"),
	);
	let exportHistoryHasArtifactAttention = $derived(
		recentExportRuns.some((run) => Boolean(run.artifactError)),
	);
	let exportHistoryHasRunAttention = $derived(
		recentExportRuns.some((run) => run.status === "error" || Boolean(run.artifactError) || exportRunScope(run).missingPageIndexes.length > 0),
	);
	let exportHistoryNeedsAttention = $derived(
		editorUiStore.workspacePagesExportHistoryToken > 0
			|| exportHistoryHasRunAttention,
	);
	let shouldOpenExportHistory = $derived(
		editorUiStore.workspacePagesExportHistoryToken > 0
			|| exportHistoryHasFailureAttention
			|| exportHistoryHasArtifactAttention
			|| (exportHistoryHasRunAttention && chapterDashboard.attentionCount === 0),
	);

	// 2-mode view: lead (full team grid + batch + review/export) vs assigned (single-role queue).
	let teamMode = $derived(effectiveTeamMode());
	let isLead = $derived(teamMode === "lead");
	let assignedRole = $derived(studioRoleToChapterRole(projectStore.currentWorkspaceMember?.memberStudioRole));

	let targetLangLabel = $derived((projectStore.project?.targetLang ?? "").toUpperCase());
	let sourceLangLabel = $derived((projectStore.project?.sourceLang ?? "ja").toUpperCase());
	let chapterProgressPercent = $derived(chapterDashboard.totalPages > 0
		? Math.round((chapterDashboard.totalPages - chapterDashboard.attentionCount) / chapterDashboard.totalPages * 1000) / 10
		: 0);
	let typesetDoneCount = $derived(pageSummaries.filter((summary) => roleState(summary, "typeset") === "done").length);
	let qcDoneCount = $derived(pageSummaries.filter((summary) => roleState(summary, "qc") === "done").length);

	// Assigned-mode queue: only the pages this contributor's single role must still work.
	let assignedQueue = $derived(pageSummaries.filter((summary) => {
		const state = roleState(summary, assignedRole);
		return state === "wait" || state === "active";
	}));
	let assignedDone = $derived(pageSummaries.filter((summary) => roleState(summary, assignedRole) === "done"));
	let assignedReturned = $derived(assignedQueue.filter((summary) => summary.status === "blocked" || summary.qcErrorCount > 0).length);
	let assignedProgressPercent = $derived(pageSummaries.length > 0
		? Math.round((assignedDone.length / pageSummaries.length) * 1000) / 10
		: 0);
	let assignmentScope = $state<AssignmentScope>("current");
	let assignmentRole = $state<AssignmentRole>("all");
	let assignmentOwner = $state("");
	let assignmentPriority = $state<WorkflowTaskPriority | "keep">("keep");
	let assignmentDueValue = $state("");
	let assignmentFeedback = $state("");
	let assignmentPanelEl = $state<HTMLElement>();
	let assignmentTaskIds = $derived(resolveAssignmentTaskIds());
	let assignmentTaskCount = $derived(assignmentTaskIds.length);
	let assignmentCanApply = $derived(
		assignmentTaskCount > 0
			&& !projectStore.workflowLoading
			&& (
				assignmentOwner.trim().length > 0
				|| assignmentPriority !== "keep"
				|| assignmentDueValue.trim().length > 0
			),
	);

	// AI jobs + comment/QC digests for the side rail (derived from existing summaries).
	let aiReviewPages = $derived(pageSummaries.filter((summary) => summary.aiAttentionCount > 0));
	let commentDigestPages = $derived(pageSummaries.filter((summary) => summary.openCommentCount > 0 || summary.qcErrorCount > 0 || summary.qcWarningCount > 0));
	let totalCommentCount = $derived(pageSummaries.reduce((sum, summary) => sum + summary.openCommentCount, 0));

	function pageOf(summary: PageWorkSummary): Page | null {
		return projectStore.project?.pages[summary.pageIndex] ?? null;
	}

	function studioRoleToChapterRole(role: WorkspaceStudioRole | null | undefined): ChapterRole {
		if (role === "translator") return "translate";
		if (role === "cleaner") return "clean";
		if (role === "qc") return "qc";
		return "typeset";
	}

	// Per-role completion state for a page, derived from existing handoff + summary signals.
	function roleState(summary: PageWorkSummary, role: ChapterRole): RoleState {
		const page = pageOf(summary);
		if (!page) return "none";
		if (role === "clean") {
			// A page explicitly returned to cleaning (or with a broken asset) is still work,
			// even if it already has text layers — check that before the layerCount shortcut.
			if (assetNeedsRecovery(summary) || page.cleaningHandoff?.status === "needs_clean") return "wait";
			if (page.cleaningHandoff?.status === "clean_ready" || summary.layerCount > 0 || summary.exportReady) return "done";
			return "none";
		}
		if (role === "translate") {
			if (
				summary.exportReady
				|| summary.layerCount > 0
				|| page.translationHandoff?.status === "translated"
				|| (page.translationScriptSlots && page.translationScriptSlots.length > 0)
			) return "done";
			if (page.translationHandoff?.status === "draft") return "active";
			return "none";
		}
		if (role === "typeset") {
			if (summary.exportReady || page.qcHandoff?.status === "ready" || summary.layerCount > 0) return "done";
			if (summary.status === "working") return "active";
			return "none";
		}
		// qc
		if (summary.exportReady || page.qcHandoff?.status === "ready") return "done";
		if (summary.qcErrorCount > 0 || summary.status === "review" || page.qcHandoff?.status === "pending" || page.qcHandoff?.status === "needs_fix") return "wait";
		if (summary.layerCount > 0) return "wait";
		return "none";
	}

	function pageReadyTone(summary: PageWorkSummary): { label: string; cls: string } {
		if (assetNeedsRecovery(summary)) return { label: "Missing", cls: "text-ws-rose bg-ws-rose/10 border-ws-rose/20" };
		if (summary.exportReady) return { label: "Ready", cls: "text-ws-green bg-ws-green/10 border-ws-green/20" };
		if (summary.status === "review") return { label: "Review", cls: "text-ws-amber bg-ws-amber/10 border-ws-amber/20" };
		if (summary.layerCount > 0) return { label: "Edited", cls: "text-ws-accent bg-ws-accent/10 border-ws-accent/20" };
		return { label: "Todo", cls: "text-ws-faint bg-ws-surface2/40 border-ws-line/12" };
	}

	function pageAiMarkerTone(summary: PageWorkSummary): { label: string; color: string } | null {
		if (assetNeedsRecovery(summary)) return null;
		const marker = pageAiPlacementMarker(summary);
		if (marker) {
		// HEX on purpose: PageTile builds `${color}24`/`${color}4d` hex-alpha strings
		// and feeds the SVG `fill` presentation attribute — var() breaks both
		// (invalid CSS is dropped; presentation attrs don't resolve var()).
		return marker.status === "applied"
				? { label: $_("pagesView.aiApplied"), color: "#34D399" }
				: { label: $_("pagesView.aiPending"), color: "#FBBF24" };
		}
		if (summary.aiAttentionCount > 0) return { label: $_("pagesView.aiPending"), color: "#FBBF24" };
		return null;
	}

	// ---- atom bridges: map the local role/tone signals onto the shared ui/* atom props ----
	const ROLE_STATE_TO_ATOM: Record<RoleState, AtomRoleState> = {
		done: "done",
		active: "active",
		wait: "todo",
		none: "todo",
	};

	function pageRoleDots(summary: PageWorkSummary): PageRoleDot[] {
		return ROLE_ORDER.map((role) => ({
			role: role as WorkRole,
			state: assetNeedsRecovery(summary) && roleState(summary, role) === "wait"
				? "blocked"
				: ROLE_STATE_TO_ATOM[roleState(summary, role)],
		}));
	}

	function pageStatusChip(summary: PageWorkSummary): PageStatusChip {
		const tone = pageReadyTone(summary);
		// pageReadyTone returns tailwind classes; map its label to a concrete ws color for PageTile.
		const colorByLabel: Record<string, string> = {
			Missing: "var(--color-ws-rose)",
			Ready: "var(--color-ws-green)",
			Review: "var(--color-ws-amber)",
			Edited: "var(--color-ws-accent)",
			Todo: "var(--color-ws-faint)",
		};
		return { label: tone.label, color: colorByLabel[tone.label] ?? "var(--color-ws-faint)" };
	}

	function pageAiMarkerChip(summary: PageWorkSummary): PageStatusChip | null {
		const marker = pageAiMarkerTone(summary);
		return marker ? { label: marker.label, color: marker.color } : null;
	}

	// Source→target language coverage for the header / mode rail chips.
	let languagePairs = $derived(
		targetLangLabel
			? [{ from: sourceLangLabel, to: targetLangLabel, pct: chapterProgressPercent }]
			: [],
	);

	function assignedRowState(summary: PageWorkSummary): { label: string; cls: string } {
		if (assetNeedsRecovery(summary)) {
			if (summary.assetIntegrity?.status === "scanning") return { label: $_("pagesView.rowWaitScan"), cls: "text-ws-faint bg-ws-surface2/40 border-ws-line/12" };
			return { label: $_("pagesView.rowBlocked"), cls: "text-ws-rose bg-ws-rose/10 border-ws-rose/25" };
		}
		if (summary.status === "blocked" || summary.qcErrorCount > 0) return { label: $_("pagesView.rowReturned"), cls: "text-ws-rose bg-ws-rose/10 border-ws-rose/25" };
		return { label: $_("pagesView.rowWaitClean"), cls: "text-ws-green bg-ws-green/10 border-ws-green/22" };
	}

	function assignedRowAction(summary: PageWorkSummary): { label: string; kind: "primary" | "ghost" | "wait" } {
		if (summary.assetIntegrity?.status === "scanning") return { label: $_("pagesView.rowActionWait"), kind: "wait" };
		if (assetNeedsRecovery(summary)) return { label: $_("pagesView.rowActionNotifyLead"), kind: "ghost" };
		if (summary.status === "blocked" || summary.qcErrorCount > 0) return { label: $_("pagesView.rowActionRedo"), kind: "primary" };
		return { label: $_("pagesView.rowActionStartClean"), kind: "ghost" };
	}

	function pageGridThumb(summary: PageWorkSummary): string | null {
		const page = pageOf(summary);
		const imageId = getPagePreviewImageId(page ?? undefined, projectStore.localImageUrls);
		if (!projectStore.project || !imageId) return null;
		const key = `${projectStore.project.projectId}:${summary.pageIndex}:${imageId}`;
		if (gridThumbFailures[key]) return null;
		return buildThumbnailUrl(projectStore.project.projectId, imageId, 256, 340);
	}

	// Asset identity for a grid thumbnail so signedAssetSrc / PageTile can attach
	// a signed assetToken (a browser <img> has no Bearer header → 401).
	function pageGridThumbParams(summary: PageWorkSummary): SignedAssetSrcParams | null {
		const page = pageOf(summary);
		const imageId = getPagePreviewImageId(page ?? undefined, projectStore.localImageUrls);
		const url = pageGridThumb(summary);
		if (!projectStore.project || !imageId || !url) return null;
		return {
			projectId: projectStore.project.projectId,
			imageId,
			url,
			purpose: "thumbnail",
			// Mark failed only AFTER signedAssetSrc exhausts its token re-mint retry,
			// not on a raw <img onerror> (which aborts the re-sign on the first error,
			// leaving an expired-token thumbnail permanently broken).
			onFailed: () => markGridThumbFailed(summary),
		};
	}

	function markGridThumbFailed(summary: PageWorkSummary): void {
		const page = pageOf(summary);
		const imageId = getPagePreviewImageId(page ?? undefined, projectStore.localImageUrls);
		if (!projectStore.project || !imageId) return;
		gridThumbFailures = { ...gridThumbFailures, [`${projectStore.project.projectId}:${summary.pageIndex}:${imageId}`]: true };
	}

	let gridThumbFailures = $state<Record<string, boolean>>({});

	function toggleTeamMode(mode: "lead" | "assigned"): void {
		editorUiStore.setWorkspaceTeamMode(mode);
	}

	function focusPagesAssignmentPanel(): void {
		assignmentPanelEl?.scrollIntoView?.({ behavior: "smooth", block: "start" });
		assignmentPanelEl?.querySelector<HTMLElement>("input, select, button")?.focus();
	}

	function isWorkflowTaskOpen(task: WorkflowTask): boolean {
		return task.status !== "done";
	}

	function assignmentScopePageIndexes(): number[] {
		if (!projectStore.project) return [];
		if (assignmentScope === "current") return [projectStore.project.currentPage];
		if (assignmentScope === "next") return nextPageSummary ? [nextPageSummary.pageIndex] : [];
		return pageSummaries.map((summary) => summary.pageIndex);
	}

	function resolveAssignmentTaskIds(): string[] {
		const pageIndexes = new Set(assignmentScopePageIndexes());
		return projectStore.tasks
			.filter((task) =>
				pageIndexes.has(task.pageIndex)
				&& isWorkflowTaskOpen(task)
				&& (assignmentRole === "all" || task.type === assignmentRole),
			)
			.map((task) => task.id);
	}

	function assignmentScopeText(): string {
		if (assignmentScope === "current") return $_("pagesView.assignScopeCurrent");
		if (assignmentScope === "next") return $_("pagesView.assignScopeNext");
		return $_("pagesView.assignScopeVisible");
	}

	function assignmentRoleText(role: AssignmentRole = assignmentRole): string {
		if (role === "all") return $_("pagesView.assignAllRoles");
		if (role === "clean") return ROLE_LABEL.clean;
		if (role === "translate") return ROLE_LABEL.translate;
		if (role === "typeset") return ROLE_LABEL.typeset;
		return "QC";
	}

	function assignmentPriorityText(priority: WorkflowTaskPriority): string {
		if (priority === "urgent") return $_("pagesView.assignPriorityUrgent");
		if (priority === "high") return $_("pagesView.assignPriorityHigh");
		return $_("pagesView.assignPriorityNormal");
	}

	function normalizeAssignmentDueAt(value: string): string | null {
		if (!value) return null;
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}

	function updateAssignmentOwner(event: Event): void {
		assignmentOwner = (event.target as HTMLInputElement).value;
		assignmentFeedback = "";
	}

	function updateAssignmentDue(event: Event): void {
		assignmentDueValue = (event.target as HTMLInputElement).value;
		assignmentFeedback = "";
	}

	async function applyPagesAssignment(): Promise<void> {
		if (!assignmentTaskIds.length || projectStore.workflowLoading) return;
		const normalizedOwner = normalizeAssigneeHandle(assignmentOwner);
		const dueAt = assignmentDueValue.trim() ? normalizeAssignmentDueAt(assignmentDueValue) : undefined;
		if (assignmentDueValue.trim() && !dueAt) {
			assignmentFeedback = $_("pagesView.assignInvalidDue");
			return;
		}
		if (!normalizedOwner && assignmentPriority === "keep" && dueAt === undefined) {
			assignmentFeedback = $_("pagesView.assignPickChange");
			return;
		}

		const update: {
			taskIds: string[];
			assignee?: string;
			priority?: WorkflowTaskPriority;
			dueAt?: string | null;
		} = { taskIds: assignmentTaskIds };
		if (normalizedOwner) update.assignee = normalizedOwner;
		if (assignmentPriority !== "keep") update.priority = assignmentPriority;
		if (dueAt !== undefined) update.dueAt = dueAt;

		const changedCount = await projectStore.bulkUpdateTasks(
			update,
			(count) => $_("pagesView.assignFeedbackUpdated", {
				values: {
					n: count,
					scope: assignmentScopeText(),
					role: assignmentRoleText(),
					owner: normalizedOwner ? formatAssigneeHandle(normalizedOwner) : $_("pagesView.assignOwnerUnchanged"),
				},
			}),
			$_("pagesView.assignFeedbackNoChange"),
		);
		assignmentFeedback = changedCount > 0
			? $_("pagesView.assignFeedbackUpdated", {
				values: {
					n: changedCount,
					scope: assignmentScopeText(),
					role: assignmentRoleText(),
					owner: normalizedOwner ? formatAssigneeHandle(normalizedOwner) : $_("pagesView.assignOwnerUnchanged"),
				},
			})
			: $_("pagesView.assignFeedbackNoChange");
	}

	function buildPageSummaries(
		project: ProjectState | null,
		tasks: WorkflowTask[],
		comments: ProjectComment[],
		aiReviewMarkers: AiReviewMarker[],
		reviewDecisions: PageReviewDecision[],
		qcIssues: QcIssue[],
		currentEditorTextLayerCount: number,
		currentEditorHasImage: boolean,
	): PageWorkSummary[] {
		if (!project) return [];
		return project.pages.map((page, index) => summarizePageWork({
			page,
			pageIndex: index,
			layerCount: resolveVisiblePageLayerCount(
				page,
				project.currentPage === index,
				currentEditorTextLayerCount,
				currentEditorHasImage,
			),
			assetIntegrity: projectStore.getPageAssetIntegrity(index),
			qcIssues,
			tasks,
			comments,
			aiReviewMarkers,
			reviewDecisions,
			productionMode: project.productionMode ?? "solo",
		}));
	}

	function openLibrary(): void {
		editorUiStore.openLibrary();
		queueWorkspaceNavigation({ view: "library" });
	}

	function openCanvas(): void {
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project?.projectId,
			pageIndex: projectStore.project?.currentPage ?? 0,
		});
	}

	function openCurrentPageActionLabel(): string {
		if (!projectStore.project) return $_("pagesView.openPageEdit");
		return $_("pagesView.openPageN", { values: { n: projectStore.project.currentPage + 1 } });
	}

	function openWork(): void {
		if (!projectStore.project) return;
		editorUiStore.openWorkBoard();
		queueWorkspaceNavigation({
			view: "work",
			projectId: projectStore.project.projectId,
		});
	}

	function openImportReview(): void {
		if (!projectStore.project) return;
		editorUiStore.openImportReview();
		queueWorkspaceNavigation({ view: "import", projectId: projectStore.project.projectId });
	}

	function openProjectInspector(): void {
		editorUiStore.setRightPanelMode("project");
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project?.projectId,
			pageIndex: projectStore.project?.currentPage ?? 0,
		});
	}

	// Open the page's pending task in the editor's contextual Work panel — the
	// in-editor replacement for the removed per-task Focus view.
	async function openFocusItem(item: TaskFocusItem): Promise<void> {
		if (!projectStore.project) return;
		if (item.pageIndex !== undefined) {
			const pageOpened = await ensurePageSelected(item.pageIndex);
			if (!pageOpened) return;
		}
		projectStore.selectAiReviewMarker(item.kind === "ai_marker" ? item.sourceId : null);
		projectStore.selectProjectComment(item.kind === "comment" ? item.sourceId : null);
		projectStore.selectWorkflowTask(
			item.kind === "workflow_task" || item.kind === "review_task" ? item.sourceId : null,
		);
		projectStore.selectQcIssue(item.kind === "qc" ? item.sourceId : null);
		editorUiStore.setRightPanelMode("work");
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex: item.pageIndex ?? projectStore.project.currentPage,
		});
	}

	function firstFocusItemForPage(pageIndex: number): TaskFocusItem | null {
		return allTaskFocusItems.find((item) => item.pageIndex === pageIndex) ?? null;
	}

	function openCreditWorkflow(): void {
		if (!projectStore.project) return;
		editorUiStore.focusCreditTools();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex: projectStore.project.currentPage,
		});
		projectStore.setStatusMsg($_("pagesView.statusCreditToolsOpened"));
	}

	function chapterExportHeading(): string {
		if (!projectStore.project) return $_("pagesView.exportOpenChapterFirst");
		if (projectStore.isBatchExporting) return $_("pagesView.exportInProgress");
		if (projectStore.batchExportStatus === "done") return $_("pagesView.exportDone");
		if (chapterExportGate.canExport) return $_("pagesView.exportTargetReady", { values: { target: chapterExportTargetLabel } });
		return $_("pagesView.exportNotReady");
	}

	function chapterExportDetail(): string {
		if (!projectStore.project) return $_("pagesView.exportOpenChapterForGate");
		if (projectStore.batchExportMessage) return projectStore.batchExportMessage;
		if (chapterExportGateMessage) return chapterExportGateMessage;
		if (chapterExportGate.canExport) return $_("pagesView.exportReadyCount", { values: { ready: chapterExportGate.readyCount, total: chapterExportGate.pageCount } });
		return chapterExportGate.message;
	}

	function runChapterExportGate(): void {
		projectStore.clearBatchExportStatus();
		chapterExportGateMessage = chapterExportGate.message;
	}

	// Optional webtoon split: cut each exported page into vertical slices for
	// fast web loading — selectable by height-per-piece OR piece count, with the
	// minimums enforced in planExportSliceHeight (≥200px per slice, ≤200 pieces).
	let splitMode = $state<"none" | "height" | "count">("none");
	let splitHeightRaw = $state(2000);
	let splitCountRaw = $state(10);
	let splitOptions = $derived.by((): ExportSplitOptions | undefined => {
		if (splitMode === "height") {
			return { mode: "height", heightPerPiece: Math.max(EXPORT_SPLIT_MIN_HEIGHT, Math.round(splitHeightRaw) || EXPORT_SPLIT_MIN_HEIGHT) };
		}
		if (splitMode === "count") {
			return { mode: "count", pieceCount: Math.min(EXPORT_SPLIT_MAX_PIECES, Math.max(2, Math.round(splitCountRaw) || 2)) };
		}
		return undefined;
	});

	async function exportChapter(): Promise<void> {
		if (!projectStore.project || projectStore.isBatchExporting) return;
		projectStore.clearBatchExportStatus();
		chapterExportGateMessage = chapterExportGate.message;
		if (!chapterExportGate.canExport) return;
		await projectStore.exportPageBatch(chapterPageIndexes, undefined, splitOptions ? { split: splitOptions } : {});
	}

	// Jump to the first page a checklist blocker type affects, opening the most
	// relevant surface (credit workflow / work board / AI placement / focus).
	async function jumpToChecklistBlocker(group: ExportChecklistGroup): Promise<void> {
		if (group.type === "required_credit_missing") {
			openCreditWorkflow();
			return;
		}
		if (group.type === "review_not_approved") {
			editorUiStore.setWorkspaceMode("team");
			editorUiStore.openWorkBoard();
			queueWorkspaceNavigation({ view: "work", projectId: projectStore.project?.projectId });
			projectStore.setStatusMsg($_("pagesView.statusOpenWorkBoardApprove"));
			return;
		}
		const targetPageIndex = group.pages[0]?.pageIndex ?? null;
		if (targetPageIndex === null) return;
		const summary = pageSummaries[targetPageIndex] ?? null;
		const aiPlacementMarker = pageAiPlacementMarker(summary);
		if (group.type === "unresolved_ai_marker" && aiPlacementMarker) {
			await openAiPlacement(aiPlacementMarker);
			return;
		}
		const pageOpened = await ensurePageSelected(targetPageIndex);
		if (!pageOpened) return;
		const focusItem = firstFocusItemForPage(targetPageIndex);
		if (focusItem) {
			await openFocusItem(focusItem);
			projectStore.setStatusMsg($_("pagesView.statusOpenBlockerBeforeExport", { values: { n: targetPageIndex + 1 } }));
			return;
		}
		openWork();
		projectStore.setStatusMsg($_("pagesView.statusOpenWorkBeforeExport", { values: { n: targetPageIndex + 1 } }));
	}

	async function ensurePageSelected(pageIndex: number): Promise<boolean> {
		if (!projectStore.project) return false;
		if (projectStore.project.currentPage === pageIndex) return true;
		const pageOpened = await projectStore.goToPage(pageIndex, editorStore.editor);
		if (!pageOpened) return false;
		editorStore.refreshTextLayers();
		return true;
	}

	async function openPage(pageIndex: number): Promise<void> {
		if (!projectStore.project) return;
		const pageOpened = await ensurePageSelected(pageIndex);
		if (!pageOpened) return;
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex,
		});
	}

	async function openAiPlacement(marker: AiReviewMarker): Promise<void> {
		if (!projectStore.project) return;
		const pageOpened = await ensurePageSelected(marker.pageIndex);
		if (!pageOpened) return;
		projectStore.selectAiReviewMarker(marker.id);
		editorStore.editor?.focusImageRegion?.(marker.region);
		editorUiStore.setRightPanelMode("layers");
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex: marker.pageIndex,
		});
		projectStore.setStatusMsg(marker.status === "applied" ? $_("pagesView.statusAiRecoveryOpened") : $_("pagesView.statusAiPlacementOpened"));
	}

	async function openPagePrimaryAction(summary: PageWorkSummary | null): Promise<void> {
		if (!summary) return;
		const marker = pageAiPlacementMarker(summary);
		if (marker) {
			await openAiPlacement(marker);
			return;
		}
		if (summary.primarySignal.actionKind === "relink-asset") {
			relinkPage(summary);
			return;
		}
		if (summary.primarySignal.actionKind === "open-focus") {
			const focusItem = firstFocusItemForPage(summary.pageIndex);
			if (focusItem) {
				await openFocusItem(focusItem);
				return;
			}
		}
		await openPage(summary.pageIndex);
	}

	function pageEditorHref(summary: PageWorkSummary | null): string | null {
		if (!projectStore.project || !summary) return null;
		return buildWorkspaceHref({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex: summary.pageIndex,
		});
	}

	function absoluteWorkspaceLink(href: string): string {
		if (typeof window === "undefined") return href;
		return new URL(href, window.location.origin).toString();
	}

	async function copyPageLink(summary: PageWorkSummary | null): Promise<void> {
		const href = pageEditorHref(summary);
		if (!href) return;
		const link = absoluteWorkspaceLink(href);
		if (!navigator.clipboard?.writeText) {
			projectStore.setStatusMsg(`Page link: ${link}`);
			return;
		}
		try {
			await navigator.clipboard.writeText(link);
			projectStore.setStatusMsg($_("pagesView.statusPageLinkCopied"));
		} catch {
			projectStore.setStatusMsg(`Page link: ${link}`);
		}
	}

	function exportRunScope(run: ExportRun) {
		return getExportRunPageScope(run, projectStore.project?.pages.length ?? 0);
	}

	function formatExportRunDetail(run: ExportRun): string {
		const scope = exportRunScope(run);
		const parts = [
			run.kind === "batch-zip" ? $_("pagesView.exportKindZip") : $_("pagesView.exportKindPng"),
			formatExportRunPages(run),
		];
		const targetProfile = exportRunTargetProfileLabel(run);
		if (targetProfile) parts.unshift(targetProfile);
		if (scope.missingPageIndexes.length) {
			parts.push($_(`pageWork.export.${exportMissingPagesCopy()}`, { values: { n: scope.missingPageIndexes.length } }));
		}
		const size = formatExportRunSize(run.bytes);
		if (size) parts.push(size);
		return parts.join(" / ");
	}

	function exportRunMessage(run: ExportRun): string {
		return formatExportRunMessage(run);
	}

	function exportRecoveryPageIndex(run: ExportRun, pageIndexes: number[]): number | undefined {
		const livePageIndexes = new Set(pageIndexes);
		if (Number.isInteger(run.failedPageIndex) && livePageIndexes.has(run.failedPageIndex!)) {
			return run.failedPageIndex!;
		}
		const sources = [run.error, run.message].filter((value): value is string => Boolean(value));
		for (const source of sources) {
			// SENTINEL (string-coupling): this regex parses the page number out of
			// export error strings produced by still-hardcoded-Thai sources
			// (frontend/src/lib/project/page-export.ts `หน้า ${n} …`, export-runs.ts,
			// and backend export errors). The literal "หน้า" must byte-match that
			// source word, so it stays hardcoded (and counted) until those sources are
			// localized. Not a UI string.
			for (const match of source.matchAll(/หน้า\s*(\d+)/gu)) {
				const pageNumber = Number(match[1]);
				if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
				const pageIndex = pageNumber - 1;
				if (livePageIndexes.has(pageIndex)) return pageIndex;
			}
		}
		return pageIndexes[0];
	}

	function exportFailedPageHint(run: ExportRun): string {
		return Number.isInteger(run.failedPageNumber) && run.failedPageNumber! > 0
			? $_("pagesView.exportFailedAtPage", { values: { n: run.failedPageNumber } })
			: "";
	}

	function exportFocusTitle(run: ExportRun, pageIndexes: number[]): string {
		const recoveryPageIndex = exportRecoveryPageIndex(run, pageIndexes);
		return recoveryPageIndex !== undefined && recoveryPageIndex !== pageIndexes[0]
			? $_("pagesView.exportOpenReportedPage", { values: { n: recoveryPageIndex + 1 } })
			: $_("pagesView.exportOpenFirstLivePage");
	}

	function formatArtifactError(message: string): string {
		return message
			.replace(/^Stored ZIP was not saved:\s*/i, $_("pagesView.artifactStoreFailedPrefix"))
			.replace(/Workspace storage is full\.?/i, $_("pagesView.artifactStorageFull"));
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
		if (!pageIndexes.length) return $_(`pageWork.export.${exportHistoryPagesMissingCopy()}`);
		if (projectStore.isBatchExporting) return $_("pagesView.exportInProgressActive");
		const blockedMessage = exportRetryBlockedMessage(run, pageIndexes);
		if (blockedMessage) return blockedMessage;
		return $_(`pageWork.export.${exportRetryCopy(missingPageCount > 0)}`, { values: { n: pageIndexes.length } });
	}

	function exportBlockerActionLabel(run: ExportRun, pageIndexes: number[]): string {
		if (projectStore.isBatchExporting) return "";
		const gate = getExportRetryGate(run, pageIndexes);
		if (!gate || gate.canExport) return "";
		if (gate.firstHoldReason === requiredCreditMissingHoldReason()) return $_("pagesView.openCredit");
		return $_("pagesView.clearBeforeExport");
	}

	async function openExportRunBlocker(run: ExportRun): Promise<void> {
		const scope = exportRunScope(run);
		const gate = getExportRetryGate(run, scope.pageIndexes);
		if (!gate || gate.canExport) {
			await focusExportRun(run);
			return;
		}
		if (gate.firstHoldReason === requiredCreditMissingHoldReason()) {
			openCreditWorkflow();
			return;
		}
		const targetPageIndex = gate.firstHoldPageIndex ?? scope.pageIndexes[0];
		if (targetPageIndex === undefined) return;
		const summary = pageSummaries[targetPageIndex] ?? null;
		const aiPlacementMarker = pageAiPlacementMarker(summary);
		if (aiPlacementMarker) {
			await openAiPlacement(aiPlacementMarker);
			return;
		}
		const pageOpened = await ensurePageSelected(targetPageIndex);
		if (!pageOpened) return;
		openWork();
		projectStore.setStatusMsg($_("pagesView.statusOpenWorkBeforeExport", { values: { n: targetPageIndex + 1 } }));
	}

	function pageStatusLabel(value: string | null | undefined): string {
		return resolvePageStatusText(value, $_, $_("pagesView.pageNotSelected"));
	}

	function pageActionHeading(summary: PageWorkSummary | null): string {
		if (!summary) return $_("pagesView.headingOpenChapter");
		if (summary.primarySignal.kind === "ready" || summary.exportReady) return $_("pagesView.headingReady");
		if (summary.primarySignal.kind === "asset") return $_("pagesView.headingAsset");
		if (summary.primarySignal.kind === "ai-placement") return $_("pagesView.headingAiPlacement");
		if (summary.primarySignal.kind === "ai-review") return $_("pagesView.headingAiReview");
		if (summary.primarySignal.kind === "qc-error" || summary.primarySignal.kind === "qc-warning") return $_("pagesView.headingQc");
		if (summary.primarySignal.kind === "review-change") return $_("pagesView.headingReviewChange");
		if (summary.primarySignal.kind === "comment") return $_("pagesView.headingComment");
		if (summary.primarySignal.kind === "task-overdue") return $_("pagesView.headingTaskOverdue");
		if (summary.primarySignal.kind === "task-open") return $_("pagesView.headingTaskOpen");
		if (summary.primarySignal.kind === "review-approval") return $_("pagesView.headingReviewApproval");
		if (summary.primarySignal.kind === "final-qc") return $_("pagesView.headingFinalQc");
		if (summary.primarySignal.kind === "text-empty") return $_("pagesView.headingTextEmpty");
		return $_("pagesView.headingNextCheck");
	}

	function pageActionDetail(summary: PageWorkSummary | null): string {
		if (!summary) return $_("pagesView.detailOpenChapter");
		if (summary.primarySignal.kind === "ready" || summary.exportReady) return $_("pagesView.detailReady");
		const aiPlacementBlocker = aiPlacementBlockerCopy(summary);
		if (aiPlacementBlocker) return $_("pagesView.detailExportBlocked", { values: { blocker: aiPlacementBlocker } });
		// No coaching fallback: when the signal has no detail, show the page STATUS —
		// prescriptive "do this next" copy is QC's job, not the pages list's.
		return [resolvePageSignalLabel(summary.primarySignal, $_), resolvePageSignalDetail(summary.primarySignal, $_)]
			.filter(Boolean)
			.join(" / ") || resolvePageStatusText(summary.statusLabel, $_, $_("pageWork.statusFallback"));
	}

	function clampPercent(value: number, min = 0, max = 100): number {
		if (!Number.isFinite(value)) return min;
		return Math.min(max, Math.max(min, value));
	}

	function formatPercent(value: number): string {
		return `${Math.round(value * 10) / 10}%`;
	}

	function pageAiPlacementMarker(summary: PageWorkSummary | null): AiReviewMarker | null {
		if (!projectStore.project || !summary) return null;
		return findAiResultPlacementMarker(projectStore.project, projectStore.aiReviewMarkers, summary.pageIndex);
	}

	function markerRegionStyle(marker: AiReviewMarker, previewImageId: string | null): string {
		const asset = projectStore.imageAssets.find((item) =>
			item.imageId === previewImageId
			|| item.assetId === previewImageId
			|| item.imageId === marker.imageId
			|| item.assetId === marker.imageId
		);
		const width = Math.max(1, asset?.width ?? 900);
		const height = Math.max(1, asset?.height ?? 1350);
		const left = clampPercent((marker.region.x / width) * 100, 1, 96);
		const top = clampPercent((marker.region.y / height) * 100, 1, 96);
		const regionWidth = clampPercent((marker.region.w / width) * 100, 4, 98 - left);
		const regionHeight = clampPercent((marker.region.h / height) * 100, 4, 98 - top);
		return [
			`--region-left:${formatPercent(left)}`,
			`--region-top:${formatPercent(top)}`,
			`--region-width:${formatPercent(regionWidth)}`,
			`--region-height:${formatPercent(regionHeight)}`,
		].join(";");
	}

	function buildPagesNextVisualPreview(summary: PageWorkSummary | null): PagesNextVisualPreview | null {
		if (!projectStore.project || !summary) return null;
		const page = projectStore.project.pages[summary.pageIndex];
		if (!page) return null;
		const marker = pageAiPlacementMarker(summary);
		const previewImageId = getPagePreviewImageId(page, projectStore.localImageUrls);
		const failureKey = previewImageId ? `${projectStore.project.projectId}:${previewImageId}` : null;
		const previewUrl = previewImageId && !(failureKey && nextPreviewFailures[failureKey])
			? projectStore.getImageUrl(previewImageId)
			: null;
		return {
			pageLabel: $_("pagesView.pageN", { values: { n: summary.pageIndex + 1 } }),
			title: resolvePageSignalLabel(summary.primarySignal, $_),
			detail: marker ? $_("pagesView.goldFrameHint") : (resolvePageSignalDetail(summary.primarySignal, $_) || pageActionDetail(summary)),
			previewUrl,
			// Full-image preview <img> needs a signed assetToken when it resolves to a
			// backend URL (blob: local previews pass through the action unchanged).
			previewParams: previewUrl && previewImageId
				? {
					projectId: projectStore.project.projectId,
					imageId: previewImageId,
					url: previewUrl,
					purpose: "editor_preview",
					// Mark failed only AFTER signedAssetSrc exhausts its token re-mint
					// retry, not on a raw <img onerror> (which aborts the re-sign on the
					// first error, leaving an expired-token preview permanently broken).
					onFailed: () => markNextPreviewFailed(summary),
				}
				: null,
			regionStyle: marker ? markerRegionStyle(marker, previewImageId) : null,
		};
	}

	function markNextPreviewFailed(summary: PageWorkSummary | null): void {
		if (!projectStore.project || !summary) return;
		const page = projectStore.project.pages[summary.pageIndex];
		const previewImageId = page ? getPagePreviewImageId(page, projectStore.localImageUrls) : null;
		if (!previewImageId) return;
		nextPreviewFailures = {
			...nextPreviewFailures,
			[`${projectStore.project.projectId}:${previewImageId}`]: true,
		};
	}

	function hasAiPlacementBlocker(summary: PageWorkSummary): boolean {
		return summary.primarySignal.kind === "ai-placement" || summary.exportBlockers.some((blocker) => (
			blocker.includes("accepted AI result not placed")
			|| blocker.includes("applied AI layer missing")
		));
	}

	function aiPlacementBlockerCopy(summary: PageWorkSummary): string | null {
		if (summary.primarySignal.kind === "ai-placement") return resolvePageSignalLabel(summary.primarySignal, $_);
		const blocker = summary.exportBlockers.find((item) => (
			item.includes("accepted AI result not placed")
			|| item.includes("applied AI layer missing")
		));
		return blocker ? exportBlockerCopy(blocker) : null;
	}

	function pagePrimaryActionLabel(summary: PageWorkSummary | null): string {
		if (!summary) return $_("pagesView.actionCheckPage");
		if (summary.primarySignal.actionKind === "relink-asset") return $_("pagesView.actionRecoverPage", { values: { n: summary.pageNumber } });
		if (summary.primarySignal.kind === "ai-placement") {
			// The applied-layer-missing vs accepted-unplaced distinction is now a stable
			// label CODE on the signal (was a Thai "หาย" substring test against the
			// page-work-summary headline).
			return summary.primarySignal.labelCode === "ai-applied-missing"
				? $_("pagesView.actionRecoverLayerPage", { values: { n: summary.pageNumber } })
				: $_("pagesView.actionPlaceAiLayerPage", { values: { n: summary.pageNumber } });
		}
		if (summary.primarySignal.kind === "ai-review") return $_("pagesView.actionCheckAiPage", { values: { n: summary.pageNumber } });
		if (summary.primarySignal.kind === "comment") return $_("pagesView.actionReadNotePage", { values: { n: summary.pageNumber } });
		if (summary.primarySignal.kind === "qc-error" || summary.primarySignal.kind === "qc-warning") return $_("pagesView.actionCheckQcPage", { values: { n: summary.pageNumber } });
		if (summary.primarySignal.kind === "task-open" || summary.primarySignal.kind === "task-overdue") return $_("pagesView.actionOpenTaskPage", { values: { n: summary.pageNumber } });
		if (summary.primarySignal.kind === "text-empty") return $_("pagesView.actionPlaceTextPage", { values: { n: summary.pageNumber } });
		if (summary.primarySignal.kind === "ready") return $_("pagesView.actionCheckExportPage", { values: { n: summary.pageNumber } });
		return $_("pagesView.actionCheckPageN", { values: { n: summary.pageNumber } });
	}

	function assetNeedsRecovery(summary: PageWorkSummary): boolean {
		return summary.assetIntegrity?.status === "missing"
			|| summary.assetIntegrity?.status === "failed"
			|| summary.assetIntegrity?.status === "blocked";
	}

	function assetIntegrityLabel(summary: PageWorkSummary): string {
		if (!summary.assetIntegrity) return "";
		if (summary.assetIntegrity.status === "missing") return $_("pagesView.assetMissing");
		if (summary.assetIntegrity.status === "failed") return $_("pagesView.assetLoadFailed");
		if (summary.assetIntegrity.status === "blocked") return $_("pagesView.assetBlocked");
		if (summary.assetIntegrity.status === "unknown") return $_("pagesView.assetUnknown");
		return resolvePageAssetLabelText(summary.assetIntegrity, $_);
	}

	function relinkPage(summary: PageWorkSummary): void {
		if (!projectStore.project) return;
		const layerId = summary.assetIntegrity?.issueKind === "image-layer" ? summary.assetIntegrity.layerId : null;
		relinkIssue(summary, layerId ? projectStore.getPageAssetLoadIssues(summary.pageIndex).find((issue) => issue.layerId === layerId) ?? null : null);
	}

	function relinkIssue(summary: PageWorkSummary, issue: PageAssetLoadIssue | null): void {
		if (!projectStore.project) return;
		const layerId = issue?.kind === "image-layer" ? issue.layerId : null;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;
			if (layerId) {
				void projectStore.replacePageImageLayerAsset(summary.pageIndex, layerId, file, editorStore.editor);
			} else {
				void projectStore.replacePageImage(summary.pageIndex, file, editorStore.editor);
			}
		};
		input.click();
	}

	function recoveryIssues(summary: PageWorkSummary): PageAssetLoadIssue[] {
		return projectStore.getPageAssetLoadIssues(summary.pageIndex);
	}

	function recoveryIssueName(issue: PageAssetLoadIssue): string {
		return issue.layerName || issue.originalName || issue.imageName || issue.imageId;
	}

	function relinkMatchingPageImages(): void {
		if (!projectStore.project) return;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.multiple = true;
		input.onchange = async () => {
			const files = Array.from(input.files ?? []);
			if (!files.length) return;
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

	function pageDisplayTitle(summary: PageWorkSummary): string {
		return $_("pagesView.pageN", { values: { n: summary.pageNumber } });
	}

	async function focusExportRun(run: ExportRun): Promise<void> {
		const scope = exportRunScope(run);
		if (!scope.pageIndexes.length) {
			projectStore.setStatusMsg($_(`pageWork.export.${exportHistoryPagesMissingCopy()}`));
			return;
		}
		const recoveryPageIndex = exportRecoveryPageIndex(run, scope.pageIndexes) ?? scope.pageIndexes[0];
		await openPage(recoveryPageIndex);
		projectStore.setStatusMsg(recoveryPageIndex !== scope.pageIndexes[0]
			? $_("pagesView.statusOpenedReportedPage", { values: { n: recoveryPageIndex + 1 } })
			: scope.missingPageIndexes.length
			? $_("pagesView.statusOpenedFirstLivePage")
			: $_("pagesView.statusOpenedFirstHistoryPage"));
	}

	function retryExportRun(run: ExportRun): void {
		const scope = exportRunScope(run);
		if (!scope.pageIndexes.length) {
			projectStore.setStatusMsg($_(`pageWork.export.${exportHistoryPagesMissingCopy()}`));
			return;
		}
		const blockedMessage = exportRetryBlockedMessage(run, scope.pageIndexes);
		if (blockedMessage) {
			projectStore.setStatusMsg(blockedMessage);
			return;
		}
		void projectStore.retryExportRun(run.id, undefined, scope.pageIndexes);
	}

	function exportDownloadTitle(run: ExportRun): string {
		return projectStore.canDownloadExportRun(run.id)
			? $_("pagesView.downloadFile", { values: { filename: run.filename } })
			: $_("pagesView.downloadSessionOnly");
	}

	function exportDeleteTitle(run: ExportRun): string {
		return run.artifact
			? $_("pagesView.deleteStoredZip", { values: { filename: run.filename } })
			: $_("pagesView.noPersistedZip");
	}

	function exportArtifactStatus(run: ExportRun): string {
		if (run.status !== "done" || run.kind !== "batch-zip") return "";
		if (run.artifact) return $_("pagesView.zipStored");
		if (run.artifactError) {
			return projectStore.canDownloadExportRun(run.id)
				? $_("pagesView.zipStoreFailedSessionOnly")
				: $_("pagesView.zipStoreFailedRecreate");
		}
		if (projectStore.canDownloadExportRun(run.id)) return $_("pagesView.zipSessionOnly");
		return $_("pagesView.zipNoneRecreate");
	}
</script>
{#if editorUiStore.workspaceView === "pages"}
	<section class="ws-surface workspace-pages-shell" aria-label={$_("pagesView.shellAria")} data-team-mode={teamMode}>
		<div class="ws-surface-inner pages-inner">

			<!-- ===== PREMIUM GLOBAL HEADER (breadcrumb · search · AI credits · create · account) ===== -->
			<WorkspaceTopUtilityBar />

			<!-- ===== CHAPTER HEADER ===== -->
			<section class="chapter-header-shell ws-panel relative overflow-hidden rounded-ws p-[clamp(1rem,3vw,1.5rem)]">
				<div class="pages-soft-wash pages-soft-wash-accent pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full"></div>
				<div class="chapter-header relative flex flex-col gap-[clamp(1rem,2.5vw,1.25rem)]">
					<!-- cover -->
					<div class="relative shrink-0">
						<div class="chapter-cover-frame h-[clamp(110px,18vw,140px)] w-[clamp(82px,13.4vw,104px)] overflow-hidden rounded-ws-card border border-ws-line/12">
							<DefaultCover seed={projectStore.project?.projectId ?? "chapter"} ratio="portrait" />
						</div>
						<span class="absolute left-1.5 top-1.5 max-w-[88px] truncate rounded-ws-ctrl bg-ws-bg/70 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-ws-ink/90 backdrop-blur">{projectStore.project?.name ?? $_("pagesView.chapter")}</span>
					</div>

					<!-- info -->
					<div class="min-w-0 flex-1">
						<div class="mb-1.5 flex flex-wrap items-center gap-2">
							<span class="section-label">{$_("pagesView.chapterPages")}</span>
							{#if projectStore.project}
								{#if chapterDashboard.attentionCount > 0}
									<span class="inline-flex items-center gap-1.5 rounded-full border border-ws-violet/20 bg-ws-violet/10 px-2 py-0.5 text-[11px] font-medium text-ws-violet"><span class="ws-dot bg-ws-violet"></span> {$_("pagesView.inProgress")}</span>
								{:else}
									<span class="inline-flex items-center gap-1.5 rounded-full border border-ws-green/20 bg-ws-green/10 px-2 py-0.5 text-[11px] font-medium text-ws-green"><span class="ws-dot bg-ws-green"></span> {$_("pagesView.readyToSend")}</span>
								{/if}
								{#if chapterBatchSummary.reviewCount > 0}
									<span class="inline-flex items-center gap-1.5 rounded-full border border-ws-amber/20 bg-ws-amber/10 px-2 py-0.5 text-[11px] font-medium text-ws-amber">review · <NumberValue value={chapterBatchSummary.reviewCount} /></span>
								{/if}
							{/if}
						</div>

						<h1 class="truncate text-[clamp(1.05rem,2.6vw,1.3125rem)] font-semibold leading-snug tracking-tight text-ws-ink">{projectStore.project?.name ?? $_("pagesView.workPages")}</h1>
						<p class="mt-1 flex flex-wrap items-center gap-x-1 text-[13px] text-ws-text">
							{#if projectStore.project}
								<NumberValue value={projectStore.project.pages.length} /> {$_("pagesView.pagesWord")} / {targetLangLabel} / {pageStatusLabel(currentPageSummary?.statusLabel)}
							{:else}
								{$_("pagesView.openChapterOverview")}
							{/if}
						</p>

						<!-- per-language coverage + chapter progress -->
						<div class="mt-4 flex flex-wrap items-stretch gap-2.5">
							<div class="min-w-[min(100%,170px)] flex-1 rounded-ws-card ws-panel-quiet p-3">
								<div class="mb-2 flex items-center justify-between gap-2">
									<LanguageCoverageChips pairs={languagePairs} />
									<NumberValue value={chapterProgressPercent} suffix="%" compact={false} class="text-[12px] font-semibold text-ws-ink" />
								</div>
								<div class="ws-track h-1.5"><div class="ws-fill pages-progress-fill" style={`width:${chapterProgressPercent}%`}></div></div>
								<p class="mt-1.5 flex flex-wrap items-center gap-x-1 text-[10.5px] text-ws-text">{$_("pagesView.typesetWord")} <NumberValue value={typesetDoneCount} />/<NumberValue value={chapterDashboard.totalPages} /> · QC <NumberValue value={qcDoneCount} />/<NumberValue value={chapterDashboard.totalPages} /></p>
							</div>
							<button type="button" onclick={openProjectInspector} class="ws-btn-ghost only-lead flex h-11 w-11 shrink-0 items-center justify-center rounded-ws-card text-ws-text" title={$_("pagesView.settingsLangProject")}>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
							</button>
						</div>
					</div>

					<!-- ONE primary action -->
					<div class="chapter-header-action flex shrink-0 flex-wrap gap-2">
						{#if projectStore.project}
							<button type="button" onclick={openCanvas} class="ws-grad-primary pages-primary-action relative flex h-11 w-full items-center justify-center gap-2 rounded-ws-card px-6 text-[clamp(0.875rem,1.6vw,0.9rem)] font-semibold text-white">
								<span class="only-lead relative">{$_("pagesView.openEditor")}</span>
								<span class="only-assigned relative">{$_("pagesView.continueWith", { values: { role: ROLE_LABEL[assignedRole] } })}</span>
								<svg width="17" height="17" viewBox="0 0 24 24" fill="none" class="relative"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
							</button>
							<span class="only-lead chapter-header-receipt flex flex-wrap items-center gap-x-1 text-[11px] text-ws-faint"><NumberValue value={chapterDashboard.exportReadyCount} /> {$_("pagesView.pagesReadyExport")}</span>
							<span class="only-assigned chapter-header-receipt flex flex-wrap items-center gap-x-1 text-[11px] text-ws-faint">{$_("pagesView.remainingPrefix")} <NumberValue value={assignedQueue.length} /> {$_("pagesView.pagesInQueueRole", { values: { role: ROLE_LABEL[assignedRole] } })}</span>
						{:else}
							<button type="button" onclick={openLibrary} class="ws-btn-ghost relative flex h-11 w-full items-center justify-center gap-2 rounded-ws-card px-6 text-[14px] font-semibold text-ws-ink">{$_("pagesView.openLibrary")}</button>
						{/if}
					</div>
				</div>
			</section>

			<!-- ===== MODE TOGGLE ===== -->
			<section>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="flex flex-wrap items-center gap-3">
						<ModeToggle />
						<span class="only-lead hidden text-[12px] text-ws-faint sm:block">{$_("pagesView.modeLeadHint")}</span>
						<span class="only-assigned hidden text-[12px] text-ws-faint sm:block">{$_("pagesView.modeAssignedHintPre")} <span class="font-medium text-ws-green">{ROLE_LABEL[assignedRole]}</span> {$_("pagesView.modeAssignedHintPost")}</span>
					</div>

					<!-- lead: role legend / assigned: role badge -->
					<div class="flex flex-wrap items-center gap-2">
						<div class="only-lead flex flex-wrap items-center gap-1.5">
							{#each ROLE_ORDER as role (role)}
								<RoleBadge role={role as WorkRole} state="active" />
							{/each}
						</div>
						<span class="only-lead"><LanguageCoverageChips pairs={languagePairs} /></span>
						<span class="only-assigned inline-flex items-center gap-2">
							<RoleBadge role={assignedRole as WorkRole} state="active" />
							<LanguageCoverageChips pairs={languagePairs} />
						</span>
					</div>
				</div>
			</section>

			{#if !projectStore.project}
				<section class="ws-panel flex min-h-[120px] items-center justify-center rounded-ws p-6 text-center text-sm text-ws-text/70">
					{$_("pagesView.openWorkspacePrompt")}
				</section>
			{:else if isLead}
				<!-- ===== LEAD MODE: operations + pages grid + side rail ===== -->
				<section class="chapter-grid grid gap-6">
					<div class="chapter-main min-w-0 space-y-4">

						<section class="pages-next-action ws-panel rounded-ws p-[clamp(0.875rem,2vw,1.125rem)]" aria-label={$_("pagesView.nextActionAria")}>
							{#if nextPageVisual}
								<button
									type="button"
									class="next-visual ws-panel-quiet"
									aria-label={$_("pagesView.previewWork", { values: { page: nextPageVisual.pageLabel } })}
									onclick={() => void openPagePrimaryAction(nextPageSummary)}
								>
									<span class="next-visual-frame" aria-hidden="true">
										{#if nextPageVisual.previewUrl && nextPageVisual.previewParams}
											<img
												use:signedAssetSrc={nextPageVisual.previewParams}
												alt=""
											/>
										{:else}
											<span>{nextPageVisual.pageLabel}</span>
										{/if}
										{#if nextPageVisual.regionStyle}
											<i style={nextPageVisual.regionStyle}></i>
										{/if}
									</span>
									<span class="min-w-0 flex-1 text-left">
										<strong class="block truncate text-[12px] font-semibold text-ws-green">{nextPageVisual.pageLabel}</strong>
										<small class="mt-0.5 block text-[10.5px] leading-snug text-ws-text">{nextPageVisual.title} / {nextPageVisual.detail}</small>
									</span>
								</button>
							{/if}
							<div class="next-copy min-w-0">
								<span class="text-[10px] font-semibold uppercase tracking-wide text-ws-green">{pageActionHeading(nextPageSummary)}</span>
								<strong class="mt-1 block truncate text-[clamp(1rem,2.4vw,1.0625rem)] font-semibold text-ws-ink">
									{#if nextPageSummary}
										<span title={nextPageSummary.name}>{pageDisplayTitle(nextPageSummary)}</span>
									{:else}
										{$_("pagesView.noPagesYet")}
									{/if}
								</strong>
								<small class="mt-0.5 block text-[12px] leading-snug text-ws-text">{pageActionDetail(nextPageSummary)}</small>
							</div>
							<div class="next-meta min-w-0">
								{#if nextPageSummary}
									<span class="text-[11px] font-medium text-ws-text">{resolvePageStatusText(nextPageSummary.statusLabel, $_, $_("pageWork.statusFallback"))}</span>
									<small class="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11px] text-ws-faint"><NumberValue value={nextPageSummary.taskOpenCount} /> {$_("pagesView.tasksWord")} / <NumberValue value={nextPageSummary.openCommentCount} /> {$_("pagesView.notesWord")} / <NumberValue value={nextPageSummary.qcErrorCount + nextPageSummary.qcWarningCount} /> QC</small>
								{:else}
									<span class="text-[11px] font-medium text-ws-text">{$_("pagesView.waitChapter")}</span>
									<small class="mt-0.5 block text-[11px] text-ws-faint">{$_("pagesView.openChapterToStartQueue")}</small>
								{/if}
							</div>
							<div class="next-buttons">
								{#if nextPageSummary}
									<button type="button" class="ws-btn-ghost" onclick={() => void openPagePrimaryAction(nextPageSummary)}>
										{pagePrimaryActionLabel(nextPageSummary)}
									</button>
									<button type="button" class="ws-btn-ghost" onclick={() => void copyPageLink(nextPageSummary)}>
										{$_("pagesView.copyLink")}
									</button>
								{:else}
									<span class="next-receipt">{$_("pagesView.noPagesYet")}</span>
									<span class="next-receipt">{$_("pagesView.noPageLink")}</span>
								{/if}
								{#if projectStore.project && chapterDashboard.attentionCount > 0}
									<button type="button" class="ws-grad-primary primary" onclick={openWork}>{$_("pagesView.viewBacklog")}</button>
								{:else}
									<span class="next-receipt ready">{projectStore.project ? $_("pagesView.noBacklog") : $_("pagesView.openChapterForBacklog")}</span>
								{/if}
							</div>
						</section>

						<section
							bind:this={assignmentPanelEl}
							class="pages-assignment-panel ws-panel rounded-ws p-3"
							aria-label={$_("pagesView.assignmentPanelAria")}
						>
							<div class="flex flex-wrap items-start justify-between gap-3">
								<div class="min-w-[min(100%,220px)] flex-1">
									<span class="text-[10px] font-semibold uppercase tracking-wide text-ws-violet">{$_("pagesView.assignmentEyebrow")}</span>
									<strong class="mt-1 block text-[15px] font-semibold text-ws-ink">{$_("pagesView.assignmentHeading")}</strong>
									<small class="mt-0.5 block text-[12px] leading-snug text-ws-text">
										{$_("pagesView.assignmentDetail", {
											values: {
												n: assignmentTaskCount,
												scope: assignmentScopeText(),
												role: assignmentRoleText(),
											},
										})}
									</small>
								</div>

								<div class="assignment-controls grid flex-[2_1_520px] grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2">
									<label class="assignment-field">
										<span>{$_("pagesView.assignScopeLabel")}</span>
										<select bind:value={assignmentScope} onchange={() => { assignmentFeedback = ""; }}>
											<option value="current">{$_("pagesView.assignScopeCurrent")}</option>
											<option value="next">{$_("pagesView.assignScopeNext")}</option>
											<option value="visible">{$_("pagesView.assignScopeVisible")}</option>
										</select>
									</label>
									<label class="assignment-field">
										<span>{$_("pagesView.assignRoleLabel")}</span>
										<select bind:value={assignmentRole} onchange={() => { assignmentFeedback = ""; }}>
											{#each ASSIGNMENT_ROLES as role (role)}
												<option value={role}>{assignmentRoleText(role)}</option>
											{/each}
										</select>
									</label>
									<label class="assignment-field">
										<span>{$_("pagesView.assignOwnerLabel")}</span>
										<input
											type="text"
											value={assignmentOwner}
											oninput={updateAssignmentOwner}
											placeholder="@lead"
										/>
									</label>
									<label class="assignment-field">
										<span>{$_("pagesView.assignPriorityLabel")}</span>
										<select bind:value={assignmentPriority} onchange={() => { assignmentFeedback = ""; }}>
											<option value="keep">{$_("pagesView.assignPriorityKeep")}</option>
											<option value="normal">{assignmentPriorityText("normal")}</option>
											<option value="high">{assignmentPriorityText("high")}</option>
											<option value="urgent">{assignmentPriorityText("urgent")}</option>
										</select>
									</label>
									<label class="assignment-field">
										<span>{$_("pagesView.assignDueLabel")}</span>
										<input
											type="datetime-local"
											value={assignmentDueValue}
											oninput={updateAssignmentDue}
										/>
									</label>
									<div class="assignment-submit">
										{#if assignmentCanApply}
											<button type="button" class="ws-grad-primary primary" onclick={() => void applyPagesAssignment()}>
												{$_("pagesView.assignApply", { values: { n: assignmentTaskCount } })}
											</button>
										{:else}
											<span class="assignment-receipt">
												{$_("pagesView.assignApplyHint", { values: { n: assignmentTaskCount } })}
											</span>
										{/if}
									</div>
								</div>
							</div>
							{#if assignmentFeedback}
								<p class="mt-2 text-[12px] font-medium text-ws-green" role="status">{assignmentFeedback}</p>
							{/if}
						</section>

						<div class="pages-kpis" aria-label={$_("pagesView.kpisAria")}>
							<StatTile label={$_("pagesView.kpiPages")} value={chapterDashboard.totalPages} />
							<StatTile label={$_("pagesView.kpiNeedsCheck")} value={chapterDashboard.attentionCount} tone={chapterDashboard.attentionCount > 0 ? "amber" : "neutral"} />
							<StatTile label={$_("pagesView.kpiAwaitingReview")} value={chapterBatchSummary.reviewCount} tone={chapterBatchSummary.reviewCount > 0 ? "amber" : "neutral"} />
							{#if publicExportCreditBlocked}
								<StatTile label={$_("pagesView.kpiCreditBlocked")} value={0} tone="amber" />
							{:else if chapterDashboard.attentionCount > 0}
								<StatTile label={$_("pagesView.kpiExportNow")} value={0} tone="amber" />
							{:else}
								<StatTile label={$_("pagesView.kpiReadyExport")} value={chapterDashboard.exportReadyCount} tone="green" />
							{/if}
							<StatTile label={$_("pagesView.kpiOpenTasks")} value={chapterDashboard.signals.openTasks} />
						</div>

						{#if publicExportCreditBlocked}
							<section class="gate-card gate-amber ws-panel rounded-ws" aria-label={$_("pagesView.creditGateAria")}>
								<div class="min-w-0">
									<span class="text-[10px] font-semibold uppercase tracking-wide text-ws-amber">{$_("pagesView.creditRequired")}</span>
									<strong class="mt-1 block text-[15px] font-semibold text-ws-ink">{$_("pagesView.addCreditBeforeSale")}</strong>
									<small class="mt-0.5 block text-[12px] leading-snug text-ws-text">{requiredCreditGateDetail()}</small>
								</div>
								<div class="gate-actions">
									<button type="button" class="ws-grad-primary primary" onclick={openCreditWorkflow}>
										{$_("pagesView.openCredit")}
									</button>
								</div>
							</section>
						{/if}

						{#if projectStore.project}
							<section
								class={`gate-card ws-panel rounded-ws ${chapterExportGate.canExport ? "gate-green" : "gate-amber"}`}
								aria-label={$_("pagesView.exportGateAria")}
							>
								<div class="min-w-0">
									<span class={`text-[10px] font-semibold uppercase tracking-wide ${chapterExportGate.canExport ? "text-ws-green" : "text-ws-violet"}`}>{chapterExportTargetLabel}</span>
									<strong class="mt-1 block text-[15px] font-semibold text-ws-ink">{chapterExportHeading()}</strong>
									<small class="mt-0.5 block text-[12px] leading-snug text-ws-text">{chapterExportDetail()}</small>
								</div>
								<div class="split-controls" role="group" aria-label={$_("pagesView.splitGroupAria")}>
									<label class="split-mode">
										{$_("pagesView.splitLabel")}
										<select bind:value={splitMode} disabled={projectStore.isBatchExporting}>
											<option value="none">{$_("pagesView.splitNone")}</option>
											<option value="height">{$_("pagesView.splitByHeight")}</option>
											<option value="count">{$_("pagesView.splitByCount")}</option>
										</select>
									</label>
									{#if splitMode === "height"}
										<label class="split-value">
											{$_("pagesView.splitHeightLabel")}
											<input type="number" min={EXPORT_SPLIT_MIN_HEIGHT} max="20000" step="100" bind:value={splitHeightRaw} disabled={projectStore.isBatchExporting} aria-label={$_("pagesView.splitHeightAria")} />
										</label>
										<small class="split-hint">{$_("pagesView.splitHeightHint", { values: { min: EXPORT_SPLIT_MIN_HEIGHT } })}</small>
									{:else if splitMode === "count"}
										<label class="split-value">
											{$_("pagesView.splitCountLabel")}
											<input type="number" min="2" max={EXPORT_SPLIT_MAX_PIECES} bind:value={splitCountRaw} disabled={projectStore.isBatchExporting} aria-label={$_("pagesView.splitCountAria")} />
										</label>
										<small class="split-hint">{$_("pagesView.splitCountHint", { values: { min: EXPORT_SPLIT_MIN_HEIGHT, max: EXPORT_SPLIT_MAX_PIECES } })}</small>
									{/if}
								</div>
								<div class="gate-actions">
									<button type="button" class="ws-btn-ghost" onclick={runChapterExportGate}>
										{$_("pagesView.checkExport")}
									</button>
									{#if chapterExportGate.canExport && !projectStore.isBatchExporting}
										<button type="button" class="ws-grad-primary primary" onclick={() => void exportChapter()}>
											Export ZIP
										</button>
									{:else}
										<button
											type="button"
											class="ws-grad-primary primary"
											disabled
											aria-disabled="true"
											title={$_("pagesView.clearChecklistBeforeExport")}
										>
											{projectStore.isBatchExporting ? $_("pagesView.exportInProgress") : "Export ZIP"}
										</button>
									{/if}
								</div>
								{#if !chapterExportGate.canExport && chapterExportGate.checklist.length}
									<ul class="export-checklist" aria-label={$_("pagesView.checklistAria")}>
										{#each chapterExportGate.checklist as group (group.type)}
											<li class="export-checklist-row">
												<button
													type="button"
													class="export-checklist-jump"
													onclick={() => void jumpToChecklistBlocker(group)}
													title={$_("pagesView.jumpToPageToClear", { values: { n: group.pages[0]?.pageNumber ?? "" } })}
												>
													<span class="export-checklist-mark" aria-hidden="true">✕</span>
													<span class="export-checklist-label">{$_(`pageWork.checklistType.${group.type}`)}</span>
													<span class="export-checklist-count"><NumberValue value={group.count} /></span>
													<span class="export-checklist-pages">
														{$_("pagesView.pagesWord")} {group.pages.slice(0, 6).map((p) => p.pageNumber).join(", ")}{group.pages.length > 6 ? "…" : ""}
													</span>
												</button>
											</li>
										{/each}
									</ul>
								{/if}
							</section>
						{/if}

						{#if assetRecoverySummaries.length}
							<section class="recovery-card ws-panel rounded-ws" aria-label={$_("pagesView.recoveryAria")}>
								<div class="recovery-head">
									<div class="min-w-0">
										<span class="text-[10px] font-semibold uppercase tracking-wide text-ws-rose">{$_("pagesView.recoverBeforeExport")}</span>
										<strong class="mt-1 flex flex-wrap items-center gap-x-1 text-[15px] font-semibold text-ws-ink"><NumberValue value={assetRecoverySummaries.length} /> {$_("pagesView.pagesNeedRecovery")}</strong>
										<small class="mt-0.5 block text-[12px] leading-snug text-ws-text">{$_("pagesView.recoveryStickyNote")}</small>
									</div>
									<button type="button" class="recovery-bulk" onclick={relinkMatchingPageImages}>
										{$_("pagesView.matchAllImages")}
									</button>
								</div>
								<div class="recovery-list">
									{#each assetRecoverySummaries.slice(0, 4) as summary (summary.pageIndex)}
										<article class="recovery-row ws-panel-quiet">
											<div class="min-w-0">
												<span class="text-[10px] font-semibold uppercase tracking-wide text-ws-rose">{assetIntegrityLabel(summary)}</span>
												<strong class="mt-1 block text-[14px] font-semibold text-ws-ink">{pageDisplayTitle(summary)}</strong>
												<small class="mt-0.5 block truncate text-[12px] text-ws-text" title={summary.assetIntegrity?.detail}>{summary.assetIntegrity?.detail ?? $_("pagesView.pickNewImage")}</small>
												{#if recoveryIssues(summary).length > 1}
													<div class="recovery-issue-list" role="group" aria-label={$_("pagesView.imagesToRecoverPage", { values: { n: summary.pageNumber } })}>
														<em><NumberValue value={recoveryIssues(summary).length} /> {$_("pagesView.itemsOnThisPage")}</em>
														{#each recoveryIssues(summary).slice(0, 4) as issue (`${issue.kind ?? "page"}:${issue.layerId ?? issue.imageId}`)}
															<button type="button" onclick={() => relinkIssue(summary, issue)}>
																{recoveryIssueName(issue)}
															</button>
														{/each}
													</div>
												{/if}
											</div>
											<div class="recovery-actions">
												<button type="button" class="ws-btn-ghost" onclick={() => void openPage(summary.pageIndex)}>{$_("pagesView.checkPageN", { values: { n: summary.pageNumber } })}</button>
												<button type="button" class="primary" onclick={() => relinkPage(summary)}>
													{summary.assetIntegrity?.issueKind === "image-layer" ? $_("pagesView.recoverOverlay") : $_("pagesView.recoverPageN", { values: { n: summary.pageNumber } })}
												</button>
											</div>
										</article>
									{/each}
								</div>
							</section>
						{/if}

						{#if recentExportRuns.length}
							<details class="pages-export-history ws-panel" aria-label={$_("pagesView.historyAria")} role="region" open={shouldOpenExportHistory}>
								<summary class="export-history-heading">
									<div class="min-w-0">
										<span>{$_("pagesView.latestExport")}</span>
										<strong class="flex flex-wrap items-center gap-x-1"><NumberValue value={recentExportRuns.length} /> {$_("pagesView.timesWord")}</strong>
									</div>
									<small class="flex flex-wrap items-center gap-x-1">{#if failedRecentExportRunCount}{$_("pagesView.failedWord")} <NumberValue value={failedRecentExportRunCount} /> /&nbsp;{/if}{$_("pagesView.toggleExportHistory")}</small>
								</summary>
								<div class="export-history-list">
									{#each recentExportRuns as run (run.id)}
										{@const scope = exportRunScope(run)}
										{@const retryBlockedMessage = exportRetryBlockedMessage(run, scope.pageIndexes)}
										{@const blockerActionLabel = exportBlockerActionLabel(run, scope.pageIndexes)}
										{@const retryReady = canRetryExportRun(run, scope.pageIndexes)}
										<article class={`export-history-row ${run.status}`}>
											<div class="export-history-copy">
												<span>{run.status === "error" ? $_("pagesView.runError") : $_("pagesView.runDone")}</span>
												<strong>{run.filename}</strong>
												<small>{exportRunMessage(run)}</small>
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
											<div class="export-history-actions">
												{#if scope.pageIndexes.length}
													<button
														type="button"
														onclick={() => void focusExportRun(run)}
														title={exportFocusTitle(run, scope.pageIndexes)}
													>
														{$_("pagesView.openPageBtn")}
													</button>
												{:else}
													<span class="export-action-unavailable" title={$_(`pageWork.export.${exportHistoryPagesMissingCopy()}`)}>
														{$_("pagesView.pageGone")}
													</span>
												{/if}
												{#if blockerActionLabel}
													<button
														type="button"
														class="primary"
														onclick={() => void openExportRunBlocker(run)}
														title={retryBlockedMessage || $_("pagesView.openWorkBeforeExportTitle")}
													>
														{blockerActionLabel}
													</button>
												{/if}
												{#if retryReady}
													<button
														type="button"
														onclick={() => retryExportRun(run)}
														title={exportRetryTitle(run, scope.pageIndexes, scope.missingPageIndexes.length)}
													>
														{exportRetryActionLabel(run)}
													</button>
												{:else}
													<span class="export-retry-unavailable" title={exportRetryTitle(run, scope.pageIndexes, scope.missingPageIndexes.length)}>
														{projectStore.isBatchExporting ? $_("pagesView.exportInProgress") : $_("pagesView.redoAfterClear")}
													</span>
												{/if}
												{#if run.status === "done" && run.kind === "batch-zip"}
													{#if projectStore.canDownloadExportRun(run.id)}
														<button
															type="button"
															onclick={() => void projectStore.downloadExportRun(run.id)}
															title={exportDownloadTitle(run)}
														>
															{$_("pagesView.download")}
														</button>
													{:else}
														<span class="export-action-unavailable" title={exportDownloadTitle(run)}>
															{$_("pagesView.downloadUnavailable")}
														</span>
													{/if}
													{#if run.artifact}
														{#if projectStore.canDeleteExportArtifact(run.id)}
															<button
																type="button"
																onclick={() => void projectStore.deleteExportArtifact(run.id)}
																title={exportDeleteTitle(run)}
															>
																{$_("pagesView.deleteZip")}
															</button>
														{:else}
															<span class="export-action-unavailable" title={exportDeleteTitle(run)}>
																{$_("pagesView.deleteZipUnavailable")}
															</span>
														{/if}
													{/if}
												{/if}
											</div>
										</article>
									{/each}
								</div>
							</details>
						{/if}

						<!-- batch ops toolbar -->
						<div class="ws-panel flex flex-wrap items-center gap-3 rounded-ws px-4 py-3" aria-label={$_("pagesView.batchOpsAria")}>
							<span class="flex items-center gap-2 text-[12.5px] text-ws-text">
								<span class="flex h-4 w-4 items-center justify-center rounded-ws-ctrl border border-ws-line/20 bg-ws-surface2/60">
									<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M5 12l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
								</span>
								<NumberValue value={chapterDashboard.totalPages} class="font-medium text-ws-ink" /> {$_("pagesView.pagesWord")}
							</span>
							<span class="h-5 w-px bg-ws-line/15"></span>
							<button type="button" onclick={focusPagesAssignmentPanel} class="ws-btn-ghost flex min-h-9 items-center gap-1.5 rounded-ws-ctrl px-2.5 text-[12px] font-medium text-ws-text">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M5 19c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
								{$_("pagesView.assign")}
							</button>
							<button type="button" onclick={openImportReview} class="ws-btn-ghost flex min-h-9 items-center gap-1.5 rounded-ws-ctrl px-2.5 text-[12px] font-medium text-ws-text">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12l4.2 4.2L19 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
								{$_("pagesView.importText")}
							</button>
							<div class="ml-auto flex items-center gap-2">
								<button type="button" onclick={openProjectInspector} class="pages-accent-chip flex min-h-9 items-center gap-1.5 rounded-ws-ctrl border border-ws-accent/20 bg-ws-accent/10 px-2.5 text-[12px] font-medium text-ws-accent transition hover:bg-ws-accent/15">
									<SparkleIcon size={13} />
									{$_("pagesView.runAiBatch")}
								</button>
							</div>
						</div>

						<!-- grid header + legend -->
						<SectionBand title={$_("pagesView.pagesWord")} subtitle="pages">
							{#snippet action()}
								<div class="flex flex-wrap items-center justify-end gap-1.5">
									<span class="flex flex-wrap items-center gap-x-1 text-[11px] text-ws-faint">{$_("pagesView.allWord")} <NumberValue value={chapterDashboard.totalPages} class="font-medium text-ws-ink" /></span>
									{#each ROLE_ORDER as role (role)}
										<RoleBadge role={role as WorkRole} state="active" />
									{/each}
									<span class="inline-flex items-center gap-1 text-[11px] text-ws-faint"><span class="ws-dot bg-ws-faint"></span>{$_("pagesView.notStarted")}</span>
								</div>
							{/snippet}
						</SectionBand>

						<!-- THE PAGES GRID: auto-fit reflow — more columns wide, fewer narrow -->
						<div class="pages-grid" aria-label={$_("pagesView.pagesGridAria")}>
							{#each pageSummaries as summary (summary.pageIndex)}
								<PageTile
									pageNo={summary.pageNumber}
									thumbUrl={pageGridThumb(summary) ?? ""}
									assetProjectId={pageGridThumbParams(summary)?.projectId ?? ""}
									assetImageId={pageGridThumbParams(summary)?.imageId ?? ""}
									assetPurpose="thumbnail"
									seed={`${projectStore.project?.projectId ?? "p"}:${summary.pageIndex}`}
									roles={pageRoleDots(summary)}
									aiMarker={pageAiMarkerChip(summary)}
									statusChip={pageStatusChip(summary)}
									qcCount={summary.qcErrorCount + summary.qcWarningCount}
									commentCount={summary.openCommentCount}
									assetBroken={assetNeedsRecovery(summary)}
									assetLabel={assetIntegrityLabel(summary)}
									revised={Boolean(summary.latestReviewDecision)}
									active={summary.pageIndex === (projectStore.project?.currentPage ?? -1)}
									href={pageEditorHref(summary) ?? "#"}
									onclick={(event) => { event.preventDefault(); void openPage(summary.pageIndex); }}
								/>
							{/each}
						</div>

						<!-- detailed all-pages list (existing wired queue) -->
						<WorkspaceChapterQueue
							project={projectStore.project}
							summaries={pageSummaries}
							selectedPageIndex={projectStore.project?.currentPage ?? null}
							variant="wide"
							onOpenPage={openPage}
							onOpenWork={openWork}
							onOpenProjectPanel={openProjectInspector}
						/>
					</div>

					<!-- ===== SIDE RAIL (lead): review / AI / version / comments ===== -->
					<aside class="min-w-0 space-y-5">
						<!-- Review / approve -->
						<div class="ws-panel rounded-ws p-5">
							<div class="mb-3.5 flex items-center justify-between gap-2">
								<h3 class="text-[14px] font-semibold text-ws-ink">{$_("pagesView.reviewHeading")}</h3>
								{#if chapterBatchSummary.reviewCount > 0}
									<span class="inline-flex items-center gap-1.5 rounded-full border border-ws-amber/20 bg-ws-amber/10 px-2 py-0.5 text-[11px] font-medium text-ws-amber"><span class="ws-dot bg-ws-amber"></span><NumberValue value={chapterBatchSummary.reviewCount} /> {$_("pagesView.awaitingReviewWord")}</span>
								{:else}
									<span class="inline-flex items-center gap-1.5 rounded-full border border-ws-green/20 bg-ws-green/10 px-2 py-0.5 text-[11px] font-medium text-ws-green">{$_("pagesView.passed")}</span>
								{/if}
							</div>
							<p class="mb-3 flex flex-wrap items-center gap-x-1 text-[12px] text-ws-text">{$_("pagesView.typesetWord")} <NumberValue value={typesetDoneCount} />/<NumberValue value={chapterDashboard.totalPages} /> · {$_("pagesView.qcClosed")} <NumberValue value={qcDoneCount} />/<NumberValue value={chapterDashboard.totalPages} /></p>
							<div class="space-y-2">
								<button type="button" onclick={openWork} class="ws-grad-primary pages-primary-action relative flex h-10 w-full items-center justify-center gap-2 rounded-ws-ctrl text-[13px] font-semibold text-white">
									<svg width="15" height="15" viewBox="0 0 24 24" fill="none" class="relative"><path d="M5 12l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
									<span class="relative">{$_("pagesView.checkBacklog")}</span>
								</button>
								<button type="button" onclick={openProjectInspector} class="ws-btn-ghost flex h-10 w-full items-center justify-center gap-2 rounded-ws-ctrl text-[13px] font-medium text-ws-text">{$_("pagesView.viewWorkDetail")}</button>
							</div>
						</div>

						<!-- AI jobs -->
						<details open class="ws-panel rounded-ws">
							<summary class="flex items-center gap-2.5 px-5 py-4">
								<svg class="chev text-ws-faint" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
								<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-ws-ctrl border border-ws-accent/25 bg-ws-accent/15 text-ws-accent"><SparkleIcon size={12} /></span>
								<h3 class="text-[14px] font-semibold text-ws-ink">{$_("pagesView.aiJobsHeading")}</h3>
								{#if aiReviewPages.length > 0}
									<span class="inline-flex items-center gap-1 rounded-full border border-ws-amber/20 bg-ws-amber/10 px-1.5 py-0.5 text-[11px] font-medium text-ws-amber"><NumberValue value={aiReviewPages.length} /> {$_("pagesView.aiPending")}</span>
								{/if}
							</summary>
							<div class="px-5 pb-5">
								<div class="space-y-1 border-t border-ws-line/[0.07] pt-3">
									{#if aiReviewPages.length}
										{#each aiReviewPages.slice(0, 4) as summary (summary.pageIndex)}
											<AttentionRow
												tone="ai"
												text={$_("pagesView.pageWithSignal", { values: { n: summary.pageNumber, signal: resolvePageSignalLabel(summary.primarySignal, $_) } })}
												meta={resolvePageSignalDetail(summary.primarySignal, $_) || resolvePageStatusText(summary.statusLabel, $_, $_("pageWork.statusFallback"))}
												badge={$_("pagesView.aiPending")}
												onclick={() => void openPagePrimaryAction(summary)}
											/>
										{/each}
									{:else}
										<p class="py-1 text-[12px] text-ws-faint">{$_("pagesView.noAiPending")}</p>
									{/if}
									<button type="button" onclick={openProjectInspector} class="ws-btn-ghost flex min-h-9 w-full items-center justify-center rounded-ws-ctrl px-3 text-center text-[12px] text-ws-text transition hover:text-ws-ink">{$_("pagesView.openAiPanel")}</button>
								</div>
							</div>
						</details>

						<!-- Comments / QC digest -->
						<details class="ws-panel rounded-ws">
							<summary class="flex items-center gap-2.5 px-5 py-4">
								<svg class="chev text-ws-faint" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
								<h3 class="text-[14px] font-semibold text-ws-ink">{$_("pagesView.commentsQcHeading")}</h3>
								<NumberValue value={totalCommentCount + chapterDashboard.signals.qcErrors + chapterDashboard.signals.qcWarnings} class="ml-auto rounded-full bg-ws-surface2/60 px-1.5 py-0.5 text-[11px] text-ws-faint" />
							</summary>
							<div class="px-5 pb-5">
								<div class="space-y-1 border-t border-ws-line/[0.07] pt-3">
									{#if commentDigestPages.length}
										{#each commentDigestPages.slice(0, 5) as summary (summary.pageIndex)}
											{@const noteCount = summary.openCommentCount}
											{@const qcCount = summary.qcErrorCount + summary.qcWarningCount}
											<AttentionRow
												tone={qcCount > 0 ? "review" : "mention"}
												text={$_("pagesView.pageWithSignal", { values: { n: summary.pageNumber, signal: resolvePageSignalLabel(summary.primarySignal, $_) } })}
												meta={$_("pagesView.notesQcMeta", { values: { notes: noteCount, qc: qcCount } })}
												onclick={() => void openPagePrimaryAction(summary)}
											/>
										{/each}
									{:else}
										<p class="py-1 text-[12px] text-ws-faint">{$_("pagesView.noNotesOrQc")}</p>
									{/if}
								</div>
							</div>
						</details>
					</aside>
				</section>
			{:else}
				<!-- ===== ASSIGNED MODE: single-role focused queue ===== -->
				<section class="assigned-main space-y-5">
					<!-- focus banner -->
					<div class="ws-panel relative flex flex-col gap-4 overflow-hidden rounded-ws p-[clamp(1rem,3vw,1.25rem)] sm:flex-row sm:items-center">
						<div class="pages-soft-wash pages-soft-wash-success pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full"></div>
						<span class="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-ws-card border border-ws-green/25 bg-ws-green/10 text-ws-green">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 16l5-5 3 3 5-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 19h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
						</span>
						<div class="relative min-w-0 flex-1">
							<div class="mb-0.5 flex flex-wrap items-center gap-2">
								<span class="section-label">{$_("pagesView.myQueueLabel")}</span>
								<RoleBadge role={assignedRole as WorkRole} state="active" />
								<LanguageCoverageChips pairs={languagePairs} />
							</div>
							<h2 class="flex flex-wrap items-center gap-x-1 text-[clamp(0.95rem,2.4vw,1rem)] font-semibold leading-snug text-ws-ink">{$_("pagesView.youMustRolePre", { values: { role: ROLE_LABEL[assignedRole] } })} <NumberValue value={assignedQueue.length} class="text-ws-green" /> {$_("pagesView.pagesInThisChapter")}</h2>
							<p class="mt-0.5 flex flex-wrap items-center gap-x-1 text-[12.5px] text-ws-text">{projectStore.project?.name} · {$_("pagesView.doneWord")} <NumberValue value={assignedDone.length} />/<NumberValue value={chapterDashboard.totalPages} /></p>
						</div>
						<div class="relative shrink-0">
							{#if assignedQueue.length}
								<button type="button" onclick={() => void openPagePrimaryAction(assignedQueue[0])} class="ws-grad-primary pages-primary-action relative flex h-11 w-full items-center justify-center gap-2 rounded-ws-card px-6 text-[14px] font-semibold text-white sm:w-auto">
									<span class="relative">{$_("pagesView.openNextPage")}</span>
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="relative"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
								</button>
							{:else}
								<span class="inline-flex items-center gap-1.5 rounded-ws-card border border-ws-green/20 bg-ws-green/10 px-5 py-3 text-[13px] font-medium text-ws-green">{$_("pagesView.queueEmptyDone")}</span>
							{/if}
						</div>
					</div>

					<!-- progress strip (role-scoped) -->
					<div class="ws-panel-quiet flex flex-col gap-4 rounded-ws p-4 sm:flex-row sm:items-center">
						<div class="flex-1">
							<div class="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 text-[12px]">
								<span class="text-ws-text">{$_("pagesView.myRoleProgress", { values: { role: ROLE_LABEL[assignedRole] } })}</span>
								<span class="flex flex-wrap items-center gap-x-1 font-medium text-ws-ink"><NumberValue value={assignedDone.length} /> / <NumberValue value={chapterDashboard.totalPages} /> {$_("pagesView.pagesWord")} · <NumberValue value={assignedProgressPercent} suffix="%" compact={false} /></span>
							</div>
							<div class="ws-track h-2"><div class="ws-fill pages-progress-fill role" style={`width:${assignedProgressPercent}%`}></div></div>
						</div>
						<div class="flex items-center gap-4 border-ws-line/[0.07] sm:border-l sm:pl-4">
							<div class="text-center"><NumberValue value={assignedQueue.length} class="text-[18px] font-semibold leading-none text-ws-green" /><p class="mt-1 text-[10.5px] text-ws-faint">{$_("pagesView.remainingWord")}</p></div>
							<div class="text-center"><NumberValue value={assignedReturned} class="text-[18px] font-semibold leading-none text-ws-amber" /><p class="mt-1 text-[10.5px] text-ws-faint">{$_("pagesView.returnedWord")}</p></div>
						</div>
					</div>

					<!-- focused work list -->
					<div>
						<div class="mb-3 flex items-center justify-between">
							<h3 class="section-label">{$_("pagesView.pagesToRole", { values: { role: ROLE_LABEL[assignedRole] } })}</h3>
							<span class="text-[11.5px] text-ws-faint">{$_("pagesView.sortedByPage")}</span>
						</div>
						{#if assignedQueue.length}
							<div class="ws-panel divide-y divide-ws-line/[0.07] rounded-ws">
								{#each assignedQueue as summary (summary.pageIndex)}
									{@const row = assignedRowState(summary)}
									{@const action = assignedRowAction(summary)}
									<div class="ws-row-hover flex items-center gap-3.5 p-3.5">
										<div class="relative h-[74px] w-[56px] shrink-0 overflow-hidden rounded-ws-card border border-ws-line/12">
											{#if pageGridThumb(summary)}
												<img use:signedAssetSrc={pageGridThumbParams(summary)} alt="" class="h-full w-full object-cover" />
											{:else}
												<DefaultCover seed={`${projectStore.project?.projectId ?? "p"}:${summary.pageIndex}`} ratio="portrait" />
											{/if}
										</div>
										<div class="min-w-0 flex-1">
											<div class="mb-1 flex flex-wrap items-center gap-2">
												<span class="text-[13.5px] font-semibold tabular-nums text-ws-ink">{$_("pagesView.pageN", { values: { n: summary.pageNumber } })}</span>
												<span class={`inline-flex items-center gap-1.5 rounded-full border px-1.5 py-px text-[10.5px] font-medium ${row.cls}`}><span class="ws-dot" style="width:5px;height:5px;background:currentColor"></span>{row.label}</span>
												{#if pageAiPlacementMarker(summary)}
													<span class="inline-flex items-center gap-1 rounded-full border border-ws-green/20 bg-ws-green/10 px-1.5 py-px text-[10px] font-medium text-ws-green"><SparkleIcon size={9} />{$_("pagesView.aiReady")}</span>
												{/if}
											</div>
											<p class="truncate text-[12.5px] text-ws-ink">{resolvePageSignalLabel(summary.primarySignal, $_)}</p>
											<p class="mt-0.5 text-[11.5px] text-ws-faint">{resolvePageSignalDetail(summary.primarySignal, $_) || resolvePageStatusText(summary.statusLabel, $_, $_("pageWork.statusFallback"))}</p>
										</div>
										<div class="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
											{#if summary.overdueTaskCount > 0}
												<span class="text-[11px] font-medium text-ws-rose">{$_("pagesView.overdue")}</span>
											{:else if summary.nextDueAt}
												<span class="num text-[11px] font-medium text-ws-amber">{summary.nextDueAt.slice(0, 10)}</span>
											{:else}
												<span class="text-[11px] font-medium text-ws-faint">—</span>
											{/if}
											<span class="text-[10.5px] text-ws-faint">{sourceLangLabel} → {targetLangLabel || "—"}</span>
										</div>
										{#if action.kind === "wait"}
											<button type="button" disabled class="ws-panel-quiet flex h-9 shrink-0 cursor-not-allowed items-center rounded-ws-ctrl px-4 text-[12.5px] font-medium text-ws-faint">{action.label}</button>
										{:else if action.kind === "primary"}
											<button type="button" onclick={() => void openPagePrimaryAction(summary)} class="ws-grad-primary pages-primary-action relative flex h-9 shrink-0 items-center gap-1.5 rounded-ws-ctrl px-4 text-[12.5px] font-semibold text-white"><span class="relative">{action.label}</span></button>
										{:else}
											<button type="button" onclick={() => void openPagePrimaryAction(summary)} class="ws-btn-ghost flex h-9 shrink-0 items-center gap-1.5 rounded-ws-ctrl px-4 text-[12.5px] font-medium text-ws-ink"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>{action.label}</button>
										{/if}
									</div>
								{/each}
							</div>
						{:else}
							<div class="ws-panel flex min-h-[90px] items-center justify-center rounded-ws p-6 text-center text-[13px] text-ws-green">{$_("pagesView.roleQueueEmpty", { values: { role: ROLE_LABEL[assignedRole] } })}</div>
						{/if}
					</div>

					<!-- already done (collapsed, role-scoped) -->
					<details class="ws-panel rounded-ws">
						<summary class="flex items-center gap-2.5 px-5 py-4">
							<svg class="chev text-ws-faint" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
							<h3 class="text-[14px] font-semibold text-ws-ink">{$_("pagesView.roleDone", { values: { role: ROLE_LABEL[assignedRole] } })}</h3>
							<span class="ml-auto inline-flex items-center gap-1 rounded-full border border-ws-green/20 bg-ws-green/10 px-1.5 py-0.5 text-[11px] text-ws-green"><NumberValue value={assignedDone.length} /> {$_("pagesView.pagesWord")}</span>
						</summary>
						<div class="px-5 pb-5">
							<div class="assigned-done-grid border-t border-ws-line/[0.07] pt-3.5">
								{#each assignedDone as summary (summary.pageIndex)}
									<button type="button" onclick={() => void openPage(summary.pageIndex)} class="relative aspect-[3/4] w-full overflow-hidden rounded-ws-ctrl border border-ws-line/12">
										{#if pageGridThumb(summary)}
											<img use:signedAssetSrc={pageGridThumbParams(summary)} alt="" class="h-full w-full object-cover" />
										{:else}
											<DefaultCover seed={`${projectStore.project?.projectId ?? "p"}:${summary.pageIndex}`} ratio="portrait" />
										{/if}
										<span class="absolute inset-0 bg-ws-green/[0.08]"></span>
										<span class="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-ws-green/40 bg-ws-green/20 text-ws-green"><svg width="8" height="8" viewBox="0 0 24 24" fill="none"><path d="M5 12l4 4 10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
										<span class="absolute bottom-1 left-1 rounded-ws-ctrl bg-ws-bg/70 px-1 text-[9px] font-medium tabular-nums text-ws-ink/85">{summary.pageNumber}</span>
									</button>
								{/each}
							</div>
							<p class="mt-3 text-[11px] text-ws-faint">{$_("pagesView.assignedModeHintPre")} <span class="text-ws-green">{ROLE_LABEL[assignedRole]}</span> {$_("pagesView.assignedModeHintPost")}</p>
						</div>
					</details>
				</section>
			{/if}
		</div>
	</section>
{/if}

<style>
	/* Surface frame (position / scroll / background / typeface) + the centered
	   1200px content column come from the shared `.ws-surface` + `.ws-surface-inner`
	   utilities in app.css. Pages overlays ABOVE the other surfaces, so it keeps its
	   own higher stacking context. */
	.workspace-pages-shell {
		z-index: 50;
	}

	/* container contexts so child @container queries resolve against real content width */
	.chapter-main,
	.assigned-main {
		container-type: inline-size;
		min-width: 0;
	}

	.num {
		font-variant-numeric: tabular-nums;
		font-feature-settings: "tnum" 1;
	}

	.pages-soft-wash {
		background: radial-gradient(circle, color-mix(in srgb, var(--wash-color) 16%, transparent), transparent 65%);
	}
	.pages-soft-wash-accent {
		--wash-color: var(--color-ws-accent);
	}
	.pages-soft-wash-success {
		--wash-color: var(--color-ws-green);
	}
	.chapter-cover-frame,
	.pages-primary-action {
		box-shadow: 0 14px 34px -22px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}
	.pages-primary-action {
		transition: filter 0.14s ease, box-shadow 0.14s ease;
	}
	.pages-primary-action:hover {
		filter: brightness(1.06);
		box-shadow: 0 16px 36px -20px color-mix(in srgb, var(--color-ws-accent) 72%, transparent);
	}
	.pages-progress-fill {
		background: linear-gradient(90deg, var(--color-ws-violet), var(--color-ws-accent));
	}
	.pages-progress-fill.role {
		background: linear-gradient(90deg, var(--color-ws-green), var(--color-ws-accent));
	}

	.pages-assignment-panel {
		scroll-margin-top: 76px;
	}

	.assignment-field {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 5px;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 700;
	}

	.assignment-field span {
		color: var(--color-ws-faint);
	}

	.assignment-field select,
	.assignment-field input {
		min-height: 38px;
		width: 100%;
		min-width: 0;
		padding: 4px 9px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 34%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
		font-size: 12px;
	}

	.assignment-submit {
		display: flex;
		align-items: end;
		min-width: 0;
	}

	.assignment-submit button,
	.assignment-receipt {
		width: 100%;
		min-height: 38px;
	}

	.assignment-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		color: var(--color-ws-faint);
		font-size: 11px;
		font-weight: 700;
		text-align: center;
	}

	.section-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.13em;
		text-transform: uppercase;
		color: var(--color-ws-faint);
	}

	/* mode visibility */
	.workspace-pages-shell[data-team-mode="lead"] .only-assigned {
		display: none !important;
	}
	.workspace-pages-shell[data-team-mode="assigned"] .only-lead {
		display: none !important;
	}

	/* page tile lift */
	.page-tile {
		transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
	}
	.page-tile:hover {
		transform: translateY(-2px);
		border-color: var(--ws-hair-strong);
		box-shadow: 0 18px 36px -22px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}

	/* two-column chapter layout (grid + side rail), collapses under 1180px */
	.chapter-grid {
		grid-template-columns: minmax(0, 1fr) 320px;
	}
	@media (max-width: 1180px) {
		.chapter-grid {
			grid-template-columns: 1fr;
		}
	}

	/* collapsible details chevron */
	details > summary {
		list-style: none;
		cursor: pointer;
	}
	details > summary::-webkit-details-marker {
		display: none;
	}
	details[open] .chev {
		transform: rotate(90deg);
	}
	.chev {
		transition: transform 0.18s ease;
	}

	/* ---- export history (kept from prior surface, retuned to ws tokens) ---- */
	.pages-export-history {
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws);
		background: color-mix(in srgb, var(--color-ws-surface2) 24%, transparent);
	}
	.pages-export-history summary {
		cursor: pointer;
		list-style: none;
	}
	.pages-export-history summary::-webkit-details-marker {
		display: none;
	}
	.pages-export-history:not([open]) > :not(summary) {
		display: none;
	}
	.export-history-heading,
	.export-history-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
	}
	.export-history-heading span,
	.export-history-copy span {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 700;
	}
	.export-history-heading strong,
	.export-history-copy strong {
		display: block;
		margin-top: 3px;
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.export-history-heading small,
	.export-history-copy small,
	.export-history-copy em {
		color: var(--color-ws-text);
		font-size: 12px;
		font-style: normal;
		font-weight: 500;
		line-height: 1.35;
	}
	.export-history-copy .retry-blocked,
	.export-history-copy .failed-page-hint {
		color: var(--color-ws-amber);
		overflow-wrap: anywhere;
	}
	.export-history-copy .artifact-retained {
		color: var(--color-ws-violet);
	}
	.export-history-copy .artifact-error-detail {
		color: var(--color-ws-rose);
		overflow-wrap: anywhere;
	}
	.export-history-list {
		display: grid;
		gap: 8px;
	}
	.export-history-row {
		padding: 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 24%, transparent);
	}
	.export-history-row.error {
		border-color: color-mix(in srgb, var(--color-ws-rose) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, transparent);
	}
	.export-history-copy {
		display: grid;
		gap: 3px;
		min-width: 0;
	}
	.export-history-actions {
		display: flex;
		flex: 0 0 auto;
		gap: 8px;
	}
	.export-history-actions button,
	.export-retry-unavailable,
	.export-action-unavailable {
		min-height: 40px;
		padding: 0 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 28%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 600;
	}
	.export-history-actions button {
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}
	.export-history-actions button:hover {
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		border-color: var(--ws-hair-strong);
	}
	.export-retry-unavailable,
	.export-action-unavailable {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-ws-faint);
		cursor: default;
		text-align: center;
	}
	.export-history-actions button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		color: var(--color-ws-blue);
	}

	@media (max-width: 900px) {
		.pages-inner {
			gap: 20px;
		}
		.export-history-heading,
		.export-history-row {
			align-items: stretch;
			flex-direction: column;
		}
		.export-history-actions {
			width: 100%;
		}
		.export-history-actions button,
		.export-retry-unavailable,
		.export-action-unavailable {
			flex: 1 1 0;
		}
	}

	/* ===== RESPONSIVE LAYOUT PRIMITIVES ===== */

	/* chapter header: cover + info + action. Stacks on phones, becomes a row
	   (cover | info | action) once there's room, all driven by container width. */
	.chapter-header-shell {
		container-type: inline-size;
	}
	@container (min-width: 560px) {
		.chapter-header {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: start;
		}
		.chapter-header-action {
			grid-column: 1 / -1;
		}
	}
	@container (min-width: 920px) {
		.chapter-header {
			grid-template-columns: auto minmax(0, 1fr) auto;
			align-items: center;
		}
		.chapter-header-action {
			grid-column: auto;
			flex-direction: column;
			align-items: flex-end;
			justify-content: center;
		}
		.chapter-header-action .chapter-header-receipt {
			justify-content: flex-end;
			text-align: right;
		}
	}
	.chapter-header-action {
		width: 100%;
	}
	@container (min-width: 920px) {
		.chapter-header-action {
			width: auto;
			min-width: 180px;
		}
	}

	/* THE PAGES GRID — fluid auto-fit reflow across the whole width range.
	   Tile min shrinks on narrow viewports so phones still get 2+ columns,
	   and the gap scales with viewport width. */
	.pages-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(clamp(104px, 30vw, 128px), 1fr));
		gap: clamp(0.5rem, 1.4vw, 0.75rem);
	}
	@media (min-width: 640px) {
		.pages-grid {
			grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
		}
	}

	/* role-scoped "done" thumbnails — same fluid auto-fit approach, smaller min. */
	.assigned-done-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(clamp(72px, 22vw, 86px), 1fr));
		gap: 8px;
	}

	/* page tile lift (atom renders the .page-tile element, so target it globally) */
	:global(.page-tile) {
		transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
	}
	:global(.page-tile:hover) {
		transform: translateY(-2px);
		border-color: var(--ws-hair-strong);
		box-shadow: 0 18px 36px -22px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}

	/* ===== NEXT-ACTION CARD (ws tokens) ===== */
	.pages-next-action {
		display: grid;
		grid-template-columns: 1fr;
		align-items: stretch;
		gap: 12px;
	}
	@container (min-width: 560px) {
		.pages-next-action {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: center;
		}
		.pages-next-action .next-buttons {
			grid-column: 1 / -1;
		}
	}
	@container (min-width: 920px) {
		.pages-next-action {
			grid-template-columns: minmax(220px, 0.85fr) minmax(0, 1.2fr) minmax(150px, 0.55fr) auto;
		}
		.pages-next-action .next-buttons {
			grid-column: auto;
		}
	}

	.next-visual {
		display: flex;
		gap: 12px;
		align-items: center;
		min-width: 0;
		padding: 9px;
		border-radius: var(--radius-ws-card);
		color: inherit;
		cursor: pointer;
		text-align: left;
	}

	.next-visual-frame {
		position: relative;
		display: block;
		width: clamp(60px, 16vw, 76px);
		flex: none;
		aspect-ratio: 2 / 3;
		overflow: hidden;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: var(--color-ws-surface2);
	}
	.next-visual-frame img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.next-visual-frame > span {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 4px;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
		text-align: center;
	}
	.next-visual-frame i {
		position: absolute;
		left: var(--region-left);
		top: var(--region-top);
		width: var(--region-width);
		height: var(--region-height);
		min-width: 8px;
		min-height: 8px;
		border: 2px solid var(--color-ws-amber);
		border-radius: 3px;
		background: color-mix(in srgb, var(--color-ws-amber) 20%, transparent);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--color-ws-bg) 72%, transparent),
			0 0 18px color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
	}

	.next-copy,
	.next-meta {
		min-width: 0;
	}

	.next-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.next-buttons button,
	.next-buttons .next-receipt {
		min-height: 40px;
		padding: 0 13px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 600;
	}
	.next-buttons button {
		cursor: pointer;
	}
	.next-buttons button.primary {
		border: 1px solid transparent;
		color: var(--color-ws-ink);
	}

	/* shared receipt chip (replaces old .pages-action-receipt) */
	.next-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-surface2) 28%, transparent);
		color: var(--color-ws-faint);
		cursor: default;
		text-align: center;
	}
	.next-receipt.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 10%, transparent);
		color: var(--color-ws-green);
	}

	/* ===== GATE CARDS (credit / export) — ws tokens ===== */
	.gate-card {
		display: grid;
		grid-template-columns: 1fr;
		align-items: center;
		gap: 12px;
		padding: clamp(0.8rem, 2vw, 0.95rem);
	}
	@container (min-width: 520px) {
		.gate-card {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	}
	.gate-card.gate-green {
		border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent);
	}
	.gate-card.gate-amber {
		border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent);
	}
	.gate-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.gate-actions button {
		min-height: 40px;
		padding: 0 13px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.gate-actions button.primary {
		border: 1px solid transparent;
		color: var(--color-ws-ink);
	}
	.gate-actions button:disabled,
	.gate-actions button[aria-disabled="true"] {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.export-checklist {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.export-checklist-row {
		margin: 0;
	}
	.export-checklist-jump {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 40px;
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-amber) 8%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.export-checklist-jump:hover {
		background: color-mix(in srgb, var(--color-ws-amber) 16%, transparent);
	}
	.export-checklist-mark {
		color: var(--color-ws-amber);
		font-weight: 700;
	}
	.export-checklist-label {
		font-weight: 600;
	}
	.export-checklist-count {
		min-width: 22px;
		padding: 0 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-amber) 20%, transparent);
		color: var(--color-ws-amber);
		font-weight: 700;
		text-align: center;
	}
	.export-checklist-pages {
		margin-left: auto;
		color: var(--color-ws-text);
	}

	/* ===== ASSET RECOVERY — ws tokens ===== */
	.recovery-card {
		display: grid;
		gap: 10px;
		padding: clamp(0.75rem, 1.8vw, 0.875rem);
		border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent);
	}
	.recovery-head,
	.recovery-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
	}
	.recovery-head > div,
	.recovery-row > div:first-child {
		min-width: 0;
		flex: 1 1 200px;
	}
	.recovery-issue-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 7px;
	}
	.recovery-issue-list em,
	.recovery-issue-list button {
		min-height: 36px;
		border-radius: var(--radius-ws-ctrl);
		font-size: 11px;
		font-style: normal;
		font-weight: 600;
	}
	.recovery-issue-list em {
		display: inline-flex;
		align-items: center;
		gap: 0.25ch;
		padding: 0 9px;
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-text);
	}
	.recovery-issue-list button {
		max-width: 180px;
		overflow: hidden;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 35%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 10%, transparent);
		color: var(--color-ws-green);
		cursor: pointer;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.recovery-list {
		display: grid;
		gap: 8px;
	}
	.recovery-row {
		padding: 10px;
		border-radius: var(--radius-ws-card);
	}
	.recovery-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.recovery-bulk,
	.recovery-actions button {
		min-height: 40px;
		padding: 0 12px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.recovery-actions button.primary,
	.recovery-bulk {
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 16%, transparent);
		color: var(--color-ws-rose);
	}

	.split-controls {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 8px;
	}
	.split-mode,
	.split-value {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--color-ws-text);
	}
	.split-controls select,
	.split-controls input {
		min-height: 36px;
		padding: 2px 8px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 36%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
		font-size: 12px;
	}
	.split-controls input {
		width: 84px;
	}
	.split-hint {
		font-size: 11px;
		color: var(--color-ws-faint);
	}
</style>
