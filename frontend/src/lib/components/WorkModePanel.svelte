<script lang="ts">
	import { tick } from "svelte";
	import { _ } from "$lib/i18n";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { openAiReviewMarkerTargetOnPage } from "$lib/navigation/ai-review-navigation.js";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import {
		RIGHT_PANEL_WORKFLOW_PRIORITY_OPTIONS,
		RIGHT_PANEL_WORKFLOW_STATUS_OPTIONS,
		inboxSeverityLabel,
		qcSeverityLabel,
		workspaceKindLabel,
	} from "$lib/panels/right-panel-model.js";
	import {
		isWorkspaceFeedItemActionable,
		workInboxItemToTarget,
		workspaceFeedItemToTarget,
		type WorkTarget,
	} from "$lib/project/work-targets.js";
	import { isAiResultPlacementNeeded } from "$lib/project/ai-review-marker-intent.js";
	import type { WorkspaceFeedFilter } from "$lib/project/workspace-feed-filters.js";
	import type { WorkInboxItem } from "$lib/project/work-inbox.js";
	import type {
		AiReviewMarker,
		PageReviewDecisionStatus,
		ProjectComment,
		WorkflowTaskPriority,
		WorkflowTaskStatus,
		WorkspaceFeedItem,
	} from "$lib/types.js";
	import AiReviewMarkersPanel from "./AiReviewMarkersPanel.svelte";
	import WorkCommentsPanel from "./WorkCommentsPanel.svelte";
	import WorkInboxPanel from "./WorkInboxPanel.svelte";
	import WorkspaceHubPanel from "./WorkspaceHubPanel.svelte";
	import WorkQcPanel from "./WorkQcPanel.svelte";
	import WorkWorkflowPanel from "./WorkWorkflowPanel.svelte";

	type CommentAnchorMode = "page" | "layer" | "region";
	type WorkPanelScope = "page" | "all";
	type WorkSectionId = "inbox" | "hub" | "ai" | "qc" | "comments" | "workflow";

	let workSectionSwitches = $derived<Array<{ id: WorkSectionId; label: string; detail: string }>>([
		{ id: "inbox", label: $_("workMode.sectionInboxLabel"), detail: $_("workMode.sectionInboxDetail") },
		{ id: "hub", label: $_("workMode.sectionHubLabel"), detail: $_("workMode.sectionHubDetail") },
		{ id: "ai", label: $_("workMode.sectionAiLabel"), detail: $_("workMode.sectionAiDetail") },
		{ id: "qc", label: $_("workMode.sectionQcLabel"), detail: $_("workMode.sectionQcDetail") },
		{ id: "comments", label: $_("workMode.sectionCommentsLabel"), detail: $_("workMode.sectionCommentsDetail") },
		{ id: "workflow", label: $_("workMode.sectionWorkflowLabel"), detail: $_("workMode.sectionWorkflowDetail") },
	]);
	const soloAdvancedWorkSections: readonly WorkSectionId[] = ["hub", "workflow"];

	// Localise via svelte-i18n with a Thai fallback ($_ returns the key on a miss).
	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	interface WorkActionSummary {
		section: WorkSectionId;
		title: string;
		detail: string;
		nextLabel: string;
		status: string;
		tone: "attention" | "ready" | "quiet";
	}

	interface Props {
		onOpenVersionReview: (versionId: string) => void | Promise<void>;
		onOpenProjectPages: () => void | Promise<void>;
	}

	let { onOpenVersionReview, onOpenProjectPages }: Props = $props();

	const workflowStatusOptions = RIGHT_PANEL_WORKFLOW_STATUS_OPTIONS;
	const workflowPriorityOptions = RIGHT_PANEL_WORKFLOW_PRIORITY_OPTIONS;

	let inboxOpen = $state(false);
	let workspaceHubOpen = $state(false);
	let aiReviewOpen = $state(false);
	let qcOpen = $state(false);
	let commentsOpen = $state(false);
	let workflowOpen = $state(false);
	let inboxSectionElement = $state<HTMLDivElement | null>(null);
	let workspaceHubSectionElement = $state<HTMLDivElement | null>(null);
	let aiReviewSectionElement = $state<HTMLDivElement | null>(null);
	let qcSectionElement = $state<HTMLDivElement | null>(null);
	let commentsSectionElement = $state<HTMLDivElement | null>(null);
	let workflowSectionElement = $state<HTMLDivElement | null>(null);
	let newComment = $state("");
	let workspaceNote = $state("");
	let reviewNote = $state("");
	let commentAnchorMode = $state<CommentAnchorMode>("page");
	let inboxScope = $state<WorkPanelScope>("page");
	let workspaceHubScope = $state<WorkPanelScope>("page");
	let workspaceHubFilter = $state<WorkspaceFeedFilter>("all");
	let selectedInboxItemId = $state<string | null>(null);
	let selectedWorkspaceItemId = $state<string | null>(null);
	let lastAutoOpenedWorkTargetKey = $state<string | null>(null);

	let currentPageTasks = $derived(
		projectStore.project
			? projectStore.tasks.filter((task) => task.pageIndex === projectStore.project!.currentPage)
			: []
	);
	let workflowDoneCount = $derived(projectStore.tasks.filter((task) => task.status === "done").length);
	let qcReport = $derived(projectStore.qcReport);
	let currentPageInboxItems = $derived(
		projectStore.workInbox.filter((item) => item.pageIndex === undefined || item.pageIndex === projectStore.project?.currentPage)
	);
	let visibleInboxItems = $derived(inboxScope === "all" ? projectStore.workInbox : currentPageInboxItems);
	let currentPageWorkspaceFeed = $derived(projectStore.currentPageWorkspaceFeed);
	let visibleWorkspaceFeed = $derived(workspaceHubScope === "all" ? projectStore.workspaceFeed : currentPageWorkspaceFeed);
	let currentPageComments = $derived(
		projectStore.project
			? projectStore.comments.filter((comment) => comment.pageIndex === projectStore.project!.currentPage)
			: []
	);
	let panelComments = $derived(getPanelComments());
	let openPageComments = $derived(panelComments.filter((comment) => comment.status !== "resolved"));
	let visibleInboxAttentionCount = $derived(
		visibleInboxItems.filter((item) => item.severity === "error" || item.severity === "warning").length
	);
	let openPageCommentCount = $derived(openPageComments.length);
	let activePageTaskCount = $derived(currentPageTasks.filter((task) => task.status !== "done").length);
	let aiReviewNeedsCount = $derived(
		projectStore.currentPageAiReviewMarkers.filter((marker) => marker.status !== "accepted" && marker.status !== "applied").length
	);
	let aiPlacementNeedsCount = $derived(
		projectStore.currentPageAiReviewMarkers.filter(markerNeedsPlacement).length
	);
	let aiReviewMeterLabel = $derived(
		aiPlacementNeedsCount > 0
			? $_("workMode.aiWaitingPlacement", { values: { n: aiPlacementNeedsCount } })
			: aiReviewNeedsCount
				? $_("workMode.aiWaitingReview", { values: { n: aiReviewNeedsCount } })
				: $_("workMode.ready")
	);
	let aiReviewMeterNeedsAttention = $derived(aiPlacementNeedsCount > 0 || aiReviewNeedsCount > 0);
	let aiReviewWorkCount = $derived(aiPlacementNeedsCount + aiReviewNeedsCount);
	let aiReviewWorkMetricLabel = $derived(aiPlacementNeedsCount > 0 ? $_("workMode.aiToPlace") : $_("workMode.aiResults"));
	let workScopeLabel = $derived(
		projectStore.project
			? $_("workMode.pageOfTotal", { values: { current: projectStore.project.currentPage + 1, total: projectStore.project.pages.length } })
			: $_("workMode.workspaceNotOpen")
	);
	let currentPageQcIssues = $derived(
		qcReport.issues.filter((issue) => issue.pageIndex === undefined || issue.pageIndex === projectStore.project?.currentPage)
	);
	let currentPageQcErrorCount = $derived(currentPageQcIssues.filter((issue) => issue.severity === "error").length);
	let currentPageQcWarningCount = $derived(currentPageQcIssues.filter((issue) => issue.severity === "warning").length);
	let currentPageQcInfoCount = $derived(currentPageQcIssues.filter((issue) => issue.severity === "info").length);
	let currentPageReviewDecisions = $derived(projectStore.currentPageReviewDecisions);
	let latestPageReviewDecision = $derived(currentPageReviewDecisions[0] ?? null);
	let selectedWorkTargetForPanel = $derived(getSelectedWorkTargetForPanel());
	let activeWorkSection = $derived(getActiveWorkSection());
	let focusedPageReviewDecision = $derived(
		projectStore.selectedReviewDecision
			? projectStore.selectedReviewDecision
			: latestPageReviewDecision
	);
	let focusedPageReviewDecisionIsStale = $derived(
		Boolean(
			focusedPageReviewDecision
			&& projectStore.project
			&& !projectStore.project.pages[focusedPageReviewDecision.pageIndex]
		)
	);
	let focusedPageReviewScopeLabel = $derived(
		focusedPageReviewDecisionIsStale && focusedPageReviewDecision
			? $_("workMode.pageMissing", { values: { n: focusedPageReviewDecision.pageIndex + 1 } })
			: focusedPageReviewDecision
				? $_("workMode.pageN", { values: { n: focusedPageReviewDecision.pageIndex + 1 } })
				: $_("workMode.currentPage")
	);
	// Stable scope code for WorkWorkflowPanel's review title (was inferred there by
	// value-matching the rendered Thai label). All three branches here are
	// page-scoped: a specific page (decision present, stale or not) or the current
	// page (no decision yet).
	let focusedPageReviewScopeKind = $derived<"page" | "currentPage">(
		focusedPageReviewDecision ? "page" : "currentPage"
	);
	let reviewDecisionStatusCopy = $derived(
		focusedPageReviewDecisionIsStale
			? $_("workMode.staleItem")
			: focusedPageReviewDecision
				? $_("workMode.latestReview")
				: $_("workMode.awaitingReview")
	);
	let soloWorkspace = $derived(editorUiStore.workspaceMode === "solo");
	let workPanelTitle = $derived(soloWorkspace ? $_("workMode.panelTitleSolo") : $_("workMode.panelTitleTeam"));
	let workPanelScopeTitle = $derived(!projectStore.project ? $_("workMode.workNotOpen") : (soloWorkspace ? $_("workMode.soloWork") : $_("workMode.thisPageWork")));
	let workPanelGuide = $derived(
		projectStore.project
			? soloWorkspace
				? $_("workMode.guideSolo")
				: $_("workMode.guideTeam")
			: $_("workMode.guideNoProject")
	);
	let workBoardActionLabel = $derived(projectStore.project ? (soloWorkspace ? $_("workMode.viewAllWork") : $_("workMode.openWorkBoard")) : $_("workMode.home"));
	let workBoardActionMeta = $derived(
		projectStore.project
			? soloWorkspace
				? $_("workMode.boardMetaSolo")
				: $_("workMode.boardMetaTeam")
			: $_("workMode.boardMetaNoProject")
	);
	let workAttentionLabel = $derived(soloWorkspace ? $_("workMode.needsFix") : $_("workMode.needsLook"));
	let selectedCommentLayerLabel = $derived(
		editorStore.selectedLayer
			? `${editorStore.selectedLayer.text || $_("workMode.emptyText")}`
			: ""
	);
	let currentCommentRegion = $derived(getCurrentCommentRegion());
	let nextWorkAction = $derived(getNextWorkAction());
	let defaultWorkSection = $derived(projectStore.project && !soloWorkspace ? nextWorkAction.section : null);
	let displayedWorkSection = $derived(activeWorkSection ?? defaultWorkSection);

	function getNextWorkAction(): WorkActionSummary {
		if (!projectStore.project) {
			return {
				section: "inbox",
				title: $_("workMode.actionOpenWorkspaceTitle"),
				detail: $_("workMode.actionOpenWorkspaceDetail"),
				nextLabel: $_("workMode.openInbox"),
				status: $_("workMode.statusWaitingOpen"),
				tone: "quiet",
			};
		}
		if (visibleInboxAttentionCount > 0) {
			return {
				section: "inbox",
				title: $_("workMode.actionFixInboxTitle"),
				detail: $_("workMode.actionFixInboxDetail", { values: { n: visibleInboxAttentionCount } }),
				nextLabel: $_("workMode.openInbox"),
				status: $_("workMode.needsFix"),
				tone: "attention",
			};
		}
		if (currentPageQcErrorCount > 0 || currentPageQcWarningCount > 0) {
				return {
					section: "qc",
					title: soloWorkspace ? $_("workMode.actionQcTitleSolo") : $_("workMode.actionQcTitleTeam"),
					detail: $_("workMode.actionQcDetail", { values: { errors: currentPageQcErrorCount, warnings: currentPageQcWarningCount, info: currentPageQcInfoCount } }),
					nextLabel: $_("workMode.openQc"),
					status: $_("workMode.statusQc"),
					tone: currentPageQcErrorCount > 0 ? "attention" : "ready",
			};
		}
		if (openPageCommentCount > 0) {
			return {
				section: "comments",
				title: $_("workMode.actionResolveNotesTitle"),
				detail: $_("workMode.actionResolveNotesDetail", { values: { n: openPageCommentCount } }),
				nextLabel: $_("workMode.openNotes"),
				status: $_("workMode.statusNotes"),
				tone: "ready",
			};
		}
		if (aiPlacementNeedsCount > 0) {
			return {
				section: "ai",
				title: $_("workMode.actionPlaceAiTitle"),
				detail: $_("workMode.actionPlaceAiDetail", { values: { n: aiPlacementNeedsCount } }),
				nextLabel: $_("workMode.placeAiLayer"),
				status: $_("workMode.aiToPlace"),
				tone: "attention",
			};
		}
		if (aiReviewNeedsCount > 0) {
			return {
				section: "ai",
				title: $_("workMode.actionReviewAiTitle"),
				detail: $_("workMode.actionReviewAiDetail", { values: { n: aiReviewNeedsCount } }),
				nextLabel: $_("workMode.openAiReview"),
				status: $_("workMode.statusReviewAi"),
				tone: "ready",
			};
		}
		if (activePageTaskCount > 0) {
			return {
				section: "workflow",
				title: soloWorkspace ? $_("workMode.actionPendingTasksTitleSolo") : $_("workMode.actionPendingTasksTitleTeam"),
				detail: soloWorkspace
					? $_("workMode.actionPendingTasksDetailSolo", { values: { n: activePageTaskCount } })
					: $_("workMode.actionPendingTasksDetailTeam", { values: { n: activePageTaskCount } }),
				nextLabel: soloWorkspace ? $_("workMode.openWorkflowStep") : $_("workMode.openProductionWork"),
				status: soloWorkspace ? $_("workMode.statusPendingTasks") : $_("workMode.statusProduction"),
				tone: "ready",
			};
		}
		return {
			section: "hub",
			title: soloWorkspace ? $_("workMode.actionClearTitleSolo") : $_("workMode.actionClearTitleTeam"),
			detail: soloWorkspace
				? $_("workMode.actionClearDetailSolo")
				: $_("workMode.actionClearDetailTeam"),
			nextLabel: soloWorkspace ? $_("workMode.viewDetails") : $_("workMode.openTeamUpdates"),
			status: $_("workMode.statusCleared"),
			tone: "quiet",
		};
	}

	function markerNeedsPlacement(marker: AiReviewMarker): boolean {
		return isAiResultPlacementNeeded(projectStore.project, marker);
	}

	function revealWorkSection(section: WorkSectionId): void {
		inboxOpen = section === "inbox";
		workspaceHubOpen = section === "hub";
		aiReviewOpen = section === "ai";
		qcOpen = section === "qc";
		commentsOpen = section === "comments";
		workflowOpen = section === "workflow";
		if (section === "workflow") {
			if (projectStore.project) void projectStore.loadWorkflow();
		}
		scrollWorkSectionAfterRender(section);
	}

	function scrollWorkSectionAfterRender(section: WorkSectionId): void {
		void tick().then(() => {
			getWorkSectionElement(section)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
		});
	}

	function getWorkSectionElement(section: WorkSectionId): HTMLDivElement | null {
		if (section === "inbox") return inboxSectionElement;
		if (section === "hub") return workspaceHubSectionElement;
		if (section === "ai") return aiReviewSectionElement;
		if (section === "qc") return qcSectionElement;
		if (section === "comments") return commentsSectionElement;
		return workflowSectionElement;
	}

	function getActiveWorkSection(): WorkSectionId | null {
		if (inboxOpen) return "inbox";
		if (workspaceHubOpen) return "hub";
		if (aiReviewOpen) return "ai";
		if (qcOpen) return "qc";
		if (commentsOpen) return "comments";
		if (workflowOpen) return "workflow";
		return null;
	}

	function workSectionLabel(section: WorkSectionId | null): string {
		if (!section) return $_("workMode.all");
		return workSectionLabelCopy(section);
	}

	function workSectionLabelCopy(section: WorkSectionId): string {
		if (!soloWorkspace) return workSectionSwitches.find((item) => item.id === section)?.label ?? $_("workMode.all");
		if (section === "hub") return $_("workMode.soloHubLabel");
		if (section === "workflow") return $_("workMode.soloWorkflowLabel");
		if (section === "qc") return $_("workMode.soloQcLabel");
		return workSectionSwitches.find((item) => item.id === section)?.label ?? $_("workMode.all");
	}

	function workSectionDetailCopy(section: WorkSectionId): string {
		if (!soloWorkspace) return workSectionSwitches.find((item) => item.id === section)?.detail ?? "";
		if (section === "hub") return $_("workMode.soloHubDetail");
		if (section === "workflow") return $_("workMode.soloWorkflowDetail");
		if (section === "qc") return $_("workMode.soloQcDetail");
		if (section === "comments") return $_("workMode.soloCommentsDetail");
		return workSectionSwitches.find((item) => item.id === section)?.detail ?? "";
	}

	function visibleWorkSectionSwitches(): typeof workSectionSwitches {
		const currentSection = displayedWorkSection;
		return workSectionSwitches.filter((item) => {
			if (item.id === currentSection) return false;
			if (!soloWorkspace) return true;
			if (currentSection && soloAdvancedWorkSections.includes(currentSection)) return true;
			return !soloAdvancedWorkSections.includes(item.id);
		});
	}

	function shouldRenderWorkSection(section: WorkSectionId): boolean {
		if (!soloWorkspace) return displayedWorkSection ? section === displayedWorkSection : true;
		if (activeWorkSection === section) return true;
		return !soloAdvancedWorkSections.includes(section);
	}

	function workSectionIsOpen(section: WorkSectionId, open: boolean): boolean {
		return open || displayedWorkSection === section;
	}

	function getSelectedWorkTargetForPanel(): { key: string; section: WorkSectionId } | null {
		const projectId = projectStore.project?.projectId ?? "no-project";
		if (projectStore.selectedProjectCommentId) {
			return { key: `${projectId}:comments:${projectStore.selectedProjectCommentId}`, section: "comments" };
		}
		if (projectStore.selectedAiReviewMarkerId) {
			return { key: `${projectId}:ai:${projectStore.selectedAiReviewMarkerId}`, section: "ai" };
		}
		if (projectStore.selectedReviewDecisionId) {
			return { key: `${projectId}:review:${projectStore.selectedReviewDecisionId}`, section: "workflow" };
		}
		if (projectStore.selectedWorkflowTaskId) {
			return { key: `${projectId}:task:${projectStore.selectedWorkflowTaskId}`, section: "workflow" };
		}
		if (projectStore.selectedQcIssueId) {
			return { key: `${projectId}:qc:${projectStore.selectedQcIssueId}`, section: "qc" };
		}
		return null;
	}

	$effect(() => {
		if (editorUiStore.rightPanelMode !== "work") return;
		if (!selectedWorkTargetForPanel) {
			lastAutoOpenedWorkTargetKey = null;
			return;
		}
		if (lastAutoOpenedWorkTargetKey === selectedWorkTargetForPanel.key) return;
		lastAutoOpenedWorkTargetKey = selectedWorkTargetForPanel.key;
		revealWorkSection(selectedWorkTargetForPanel.section);
	});

	function toggleInbox(): void {
		inboxOpen = !inboxOpen;
		if (inboxOpen) scrollWorkSectionAfterRender("inbox");
	}

	function toggleWorkspaceHub(): void {
		workspaceHubOpen = !workspaceHubOpen;
		if (workspaceHubOpen) scrollWorkSectionAfterRender("hub");
	}

	function toggleAiReview(): void {
		aiReviewOpen = !aiReviewOpen;
		if (aiReviewOpen) scrollWorkSectionAfterRender("ai");
	}

	function toggleQc(): void {
		qcOpen = !qcOpen;
		if (qcOpen) scrollWorkSectionAfterRender("qc");
	}

	function toggleComments(): void {
		commentsOpen = !commentsOpen;
		if (commentsOpen) scrollWorkSectionAfterRender("comments");
	}

	function openWorkspaceHome(): void {
		editorUiStore.openDashboard();
		queueWorkspaceNavigation({ view: "dashboard" });
	}

	function openWorkBoard(): void {
		if (!projectStore.project) {
			openWorkspaceHome();
			return;
		}
		editorUiStore.openWorkBoard();
		queueWorkspaceNavigation({ view: "work", projectId: projectStore.project.projectId });
	}

	function toggleWorkflow(): void {
		workflowOpen = !workflowOpen;
		if (workflowOpen && projectStore.project) {
			void projectStore.loadWorkflow();
		}
		if (workflowOpen) scrollWorkSectionAfterRender("workflow");
	}

	function workspaceFeedTime(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function workspaceHubFilterLabel(): string {
		const labels = {
			all: $_("workMode.filterAll"),
			attention: $_("workMode.filterAttention"),
			due: $_("workMode.filterDue"),
			tasks: $_("workMode.filterTasks"),
			exports: "Export",
			notes: $_("workMode.filterNotes"),
		} satisfies Record<typeof workspaceHubFilter, string>;
		return labels[workspaceHubFilter];
	}

	async function addWorkspaceNote(): Promise<void> {
		const message = await projectStore.addWorkspaceMessage(workspaceNote);
		if (message) {
			workspaceNote = "";
		}
	}

	function updateWorkspaceNote(value: string): void {
		workspaceNote = value;
	}

	function clearWorkTargetSelections(): void {
		projectStore.selectProjectComment(null);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectWorkflowTask(null);
		projectStore.selectQcIssue(null);
		projectStore.selectReviewDecision(null);
	}

	function targetSourceExists(target: WorkTarget): boolean {
		if (target.kind === "comment") return projectStore.comments.some((comment) => comment.id === target.sourceId);
		if (target.kind === "task") return projectStore.tasks.some((task) => task.id === target.sourceId);
		if (target.kind === "review_decision") return projectStore.reviewDecisions.some((decision) => decision.id === target.sourceId);
		if (target.kind === "ai_marker") return projectStore.aiReviewMarkers.some((marker) => marker.id === target.sourceId);
		if (target.kind === "qc_issue") return qcReport.issues.some((issue) => issue.id === target.sourceId);
		if (target.kind === "version_review") return projectStore.project?.versionReviewRequests?.some((review) => review.id === target.sourceId) ?? Boolean(target.versionId);
		return true;
	}

	function targetSourcePageIndex(target: WorkTarget): number | undefined {
		if (target.kind === "comment") return projectStore.comments.find((comment) => comment.id === target.sourceId)?.pageIndex ?? target.pageIndex;
		if (target.kind === "task") return projectStore.tasks.find((task) => task.id === target.sourceId)?.pageIndex ?? target.pageIndex;
		if (target.kind === "review_decision") return projectStore.reviewDecisions.find((decision) => decision.id === target.sourceId)?.pageIndex ?? target.pageIndex;
		if (target.kind === "ai_marker") return projectStore.aiReviewMarkers.find((marker) => marker.id === target.sourceId)?.pageIndex ?? target.pageIndex;
		return target.pageIndex;
	}

	async function focusAiMarkerTarget(markerId: string): Promise<void> {
		const marker = projectStore.aiReviewMarkers.find((item) => item.id === markerId);
		projectStore.selectAiReviewMarker(markerId);
		if (!marker) {
			projectStore.setStatusMsg($_("workMode.msgAiResultGone"));
			return;
		}

		const outcome = await openAiReviewMarkerTargetOnPage(marker, { defaultPanelMode: null });
		if (outcome === "applied-layer") {
			projectStore.setStatusMsg($_("workMode.msgOpenedAiLayer", { values: { n: marker.pageIndex + 1 } }));
			return;
		}

		if (outcome === "placement") {
			projectStore.setStatusMsg($_("workMode.msgOpenedAiPlacement", { values: { n: marker.pageIndex + 1 } }));
			return;
		}

		projectStore.setStatusMsg($_("workMode.msgFocusedAiRegion", { values: { n: marker.pageIndex + 1 } }));
	}

	function workTargetMissingSourceStatus(target: WorkTarget): string {
		if (target.kind === "comment") return $_("workMode.msgNoteGone");
		if (target.kind === "task") return $_("workMode.msgTaskGone");
		if (target.kind === "review_decision") return $_("workMode.msgReviewItemGone");
		if (target.kind === "ai_marker") return $_("workMode.msgAiResultGone");
		if (target.kind === "qc_issue") return $_("workMode.msgQcItemCleared");
		if (target.kind === "version_review") return $_("workMode.msgVersionReviewGone");
		return $_("workMode.msgTaskGone");
	}

	function openTargetWithMissingPage(target: WorkTarget, pageIndex: number): boolean {
		if (target.kind === "comment") {
			commentsOpen = true;
			scrollWorkSectionAfterRender("comments");
			projectStore.selectProjectComment(target.sourceId);
			projectStore.setStatusMsg($_("workMode.msgNotePageMissing"));
			return true;
		}
		if (target.kind === "task") {
			revealWorkSection("workflow");
			projectStore.selectWorkflowTask(target.sourceId);
			projectStore.setStatusMsg($_("workMode.msgTaskPageMissing"));
			return true;
		}
		if (target.kind === "review_decision") {
			revealWorkSection("workflow");
			projectStore.selectReviewDecision(target.sourceId);
			projectStore.setStatusMsg($_("workMode.msgReviewPageMissing"));
			return true;
		}
		if (target.kind === "ai_marker") {
			aiReviewOpen = true;
			scrollWorkSectionAfterRender("ai");
			projectStore.selectAiReviewMarker(target.sourceId);
			projectStore.setStatusMsg($_("workMode.msgAiPageMissing"));
			return true;
		}
		projectStore.setStatusMsg($_("workMode.msgWorkPageGone", { values: { n: pageIndex + 1 } }));
		return false;
	}

	async function goToTargetPage(target: WorkTarget, pageIndex = targetSourcePageIndex(target)): Promise<boolean> {
		if (
			projectStore.project
			&& pageIndex !== undefined
			&& pageIndex !== projectStore.project.currentPage
			&& editorStore.editor
		) {
			return await projectStore.goToPage(pageIndex, editorStore.editor);
		}
		return true;
	}

	async function openWorkTarget(target: WorkTarget): Promise<boolean> {
		if (!targetSourceExists(target)) {
			projectStore.setStatusMsg(workTargetMissingSourceStatus(target));
			return false;
		}

		if (target.kind === "export_run") {
			const targetPageIndex = targetSourcePageIndex(target);
			await onOpenProjectPages();
			projectStore.setStatusMsg(
				projectStore.project && targetPageIndex !== undefined && !projectStore.project.pages[targetPageIndex]
					? $_("workMode.msgExportHistoryPageGone")
					: $_("workMode.msgOpenedExportHistory"),
			);
			return true;
		}

		const targetPageIndex = targetSourcePageIndex(target);
		if (projectStore.project && targetPageIndex !== undefined && !projectStore.project.pages[targetPageIndex]) {
			clearWorkTargetSelections();
			return openTargetWithMissingPage(target, targetPageIndex);
		}

		const pageOpened = await goToTargetPage(target, targetPageIndex);
		if (!pageOpened) return false;

		clearWorkTargetSelections();

		if (target.kind === "comment") {
			commentsOpen = true;
			scrollWorkSectionAfterRender("comments");
			projectStore.selectProjectComment(target.sourceId);
			const comment = projectStore.comments.find((entry) => entry.id === target.sourceId);
			if (comment?.layerId) {
				focusCommentAnchor(comment);
			} else if (comment?.region) {
				projectStore.setStatusMsg($_("workMode.msgFocusedNoteRegion"));
			} else {
				projectStore.setStatusMsg($_("workMode.msgOpenedPageNote"));
			}
			return true;
		}

		if (target.kind === "task") {
			revealWorkSection("workflow");
			projectStore.selectWorkflowTask(target.sourceId);
			projectStore.setStatusMsg($_("workMode.msgFocusedReviewTask"));
			return true;
		}

		if (target.kind === "review_decision") {
			revealWorkSection("workflow");
			projectStore.selectReviewDecision(target.sourceId);
			projectStore.setStatusMsg($_("workMode.msgFocusedReview"));
			return true;
		}

		if (target.kind === "ai_marker") {
			aiReviewOpen = true;
			scrollWorkSectionAfterRender("ai");
			await focusAiMarkerTarget(target.sourceId);
			return true;
		}

		if (target.kind === "qc_issue") {
			focusQcIssue(target.sourceId);
			return true;
		}

		if (target.kind === "version_review") {
			const versionId = target.versionId
				?? projectStore.project?.versionReviewRequests?.find((review) => review.id === target.sourceId)?.versionId;
			if (!versionId) {
				projectStore.setStatusMsg($_("workMode.msgVersionCheckpointGone"));
				return false;
			}
			await onOpenVersionReview(versionId);
			return true;
		}

		return true;
	}

	async function focusQcIssue(issueId: string): Promise<void> {
		qcOpen = true;
		scrollWorkSectionAfterRender("qc");
		projectStore.selectQcIssue(issueId);
		projectStore.selectProjectComment(null);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectWorkflowTask(null);
		projectStore.selectReviewDecision(null);
		const issue = qcReport.issues.find((entry) => entry.id === issueId);
		if (issue?.code === "duplicate_layer_id") {
			const result = await projectStore.repairDuplicateLayerIds(issue.pageIndex ?? projectStore.project?.currentPage ?? 0, editorStore.editor);
			if (result?.total) {
				projectStore.selectQcIssue(null);
			}
			return;
		}
		if ((issue?.code === "comment_page_missing" || issue?.code === "comment_anchor_missing") && issue.commentId) {
			commentsOpen = true;
			scrollWorkSectionAfterRender("comments");
			projectStore.selectProjectComment(issue.commentId);
			projectStore.setStatusMsg(issue.code === "comment_page_missing"
				? $_("workMode.msgNotePageMissing")
				: $_("workMode.msgNoteAnchorMissing"));
			return;
		}
		if ((
			issue?.code === "ai_marker_page_missing"
			|| issue?.code === "ai_marker_image_stale"
			|| issue?.code === "ai_marker_comment_link_missing"
			|| issue?.code === "ai_marker_task_link_missing"
		) && issue.markerId) {
			aiReviewOpen = true;
			scrollWorkSectionAfterRender("ai");
			projectStore.selectAiReviewMarker(issue.markerId);
			if (issue.code === "ai_marker_page_missing") {
				projectStore.setStatusMsg($_("workMode.msgAiPageMissing"));
			} else if (issue.code === "ai_marker_image_stale") {
				projectStore.setStatusMsg($_("workMode.msgAiImageStale"));
			} else if (issue.code === "ai_marker_comment_link_missing") {
				projectStore.setStatusMsg($_("workMode.msgAiCommentLinkMissing"));
			} else {
				projectStore.setStatusMsg($_("workMode.msgAiTaskLinkMissing"));
			}
			return;
		}
		if (
			(
				issue?.code === "workflow_task_page_missing"
				|| issue?.code === "workflow_task_layer_missing"
				|| issue?.code === "workflow_task_image_stale"
			)
			&& issue.taskId
		) {
			revealWorkSection("workflow");
			projectStore.selectWorkflowTask(issue.taskId);
			if (issue.code === "workflow_task_page_missing") {
				projectStore.setStatusMsg($_("workMode.msgTaskPageMissing"));
			} else if (issue.code === "workflow_task_layer_missing") {
				projectStore.setStatusMsg($_("workMode.msgTaskLayerMissing"));
			} else {
				projectStore.setStatusMsg($_("workMode.msgTaskImageStale"));
			}
			return;
		}
		if (issue?.code === "review_decision_page_missing" && issue.reviewDecisionId) {
			revealWorkSection("workflow");
			projectStore.selectReviewDecision(issue.reviewDecisionId);
			projectStore.setStatusMsg($_("workMode.msgReviewPageMissing"));
			return;
		}
		if (issue?.code === "page_without_text") {
			editorStore.setTool("text");
			projectStore.setStatusMsg($_("workMode.msgPageWithoutText"));
			return;
		}
		if (
			issue?.layerId
			&& projectStore.project
			&& issue.pageIndex === projectStore.project.currentPage
		) {
			if (issue.layerKind === "image") {
				editorUiStore.setRightPanelMode("layers");
				editorStore.selectImageLayer(issue.layerId);
				projectStore.setStatusMsg($_("workMode.msgOpenedImageLayerFromQc"));
			} else {
				editorStore.setTool("select");
				editorUiStore.focusTextInspector(issue.layerId);
				editorStore.editTextLayer(issue.layerId);
				projectStore.setStatusMsg($_("workMode.msgOpenedTextLayerFromQc"));
			}
			return;
		}
		projectStore.setStatusMsg($_("workMode.msgFocusedQcOnCanvas"));
	}

	async function openWorkspaceItem(item: WorkspaceFeedItem): Promise<void> {
		const target = workspaceFeedItemToTarget(item);
		if (!target) return;
		if (await openWorkTarget(target)) {
			selectedWorkspaceItemId = item.id;
		}
	}

	async function openInboxItem(item: WorkInboxItem): Promise<void> {
		if (await openWorkTarget(workInboxItemToTarget(item))) {
			selectedInboxItemId = item.id;
		}
	}

	function updateWorkflowTask(taskId: string, status: WorkflowTaskStatus): void {
		void projectStore.updateTaskStatus(taskId, status);
	}

	function updateWorkflowPriority(taskId: string, priority: WorkflowTaskPriority): void {
		void projectStore.updateTaskPriority(taskId, priority);
	}

	function updateWorkflowAssignee(taskId: string, assignee: string): void {
		void projectStore.updateTaskAssignee(taskId, assignee);
	}

	function updateWorkflowDueAt(taskId: string, dueAt: string | null): void {
		void projectStore.updateTaskDueAt(taskId, dueAt);
	}

	function updateReviewNote(value: string): void {
		reviewNote = value;
	}

	function useCommentAsReviewNote(comment: ProjectComment): void {
		projectStore.selectProjectComment(comment.id);
		commentsOpen = true;
		workflowOpen = true;
		scrollWorkSectionAfterRender("workflow");
		const anchor = commentAnchorLabel(comment);
		const body = normalizedCommentBody(comment);
		reviewNote = anchor ? `${body}\n\n${$_("workMode.position")}: ${anchor}` : body;
		focusReviewNoteAfterRender();
		projectStore.setStatusMsg($_("workMode.msgCopiedOpenNotesToReview"));
	}

	function useOpenCommentsAsReviewNote(comments: ProjectComment[]): void {
		if (!comments.length) return;
		projectStore.selectProjectComment(comments[0].id);
		commentsOpen = true;
		workflowOpen = true;
		scrollWorkSectionAfterRender("workflow");
		reviewNote = comments
			.map((comment, index) => {
				const anchor = commentAnchorLabel(comment);
				const anchorLine = anchor ? `\n   ${$_("workMode.position")}: ${anchor}` : "";
				return `${index + 1}. ${normalizedCommentBody(comment)}${anchorLine}`;
			})
			.join("\n\n");
		focusReviewNoteAfterRender();
		projectStore.setStatusMsg($_("workMode.msgCopiedOpenNotesToReview"));
	}

	function normalizedCommentBody(comment: ProjectComment): string {
		return comment.body.replace(/\s+/g, " ").trim() || $_("workMode.noteFromReview");
	}

	// Locate the review-note <textarea> rendered by WorkWorkflowPanel, which is outside this
	// component's scope and still hardcodes a Thai aria-label. The selector must match that
	// exact literal regardless of UI locale, so this key resolves to the same Thai value in
	// every locale (an internal selector token, never shown as copy); the Thai also lives here
	// as the `msg` fallback so the i18n guard treats it as bound rather than raw hardcoded text.
	function reviewNoteAriaSelector(): string {
		return msg("workMode.reviewNoteAriaSelector", "โน้ตรีวิวของหน้านี้");
	}

	function focusReviewNoteAfterRender(): void {
		void tick().then(() => {
			const note = document.querySelector<HTMLTextAreaElement>(`[aria-label="${reviewNoteAriaSelector()}"]`);
			if (!note) return;
			note.scrollIntoView({ block: "center", inline: "nearest" });
			note.focus({ preventScroll: true });
		});
	}

	function syncWorkflowPanel(): void {
		void projectStore.loadWorkflow();
		void projectStore.loadReviewDecisions();
	}

	async function submitReviewDecision(status: PageReviewDecisionStatus): Promise<void> {
		const decision = await projectStore.createReviewDecision(status, reviewNote);
		if (decision) {
			reviewNote = "";
		}
	}

	async function addComment(): Promise<void> {
			const layerId = commentAnchorMode === "layer" ? editorStore.selectedLayer?.id : undefined;
			const region = commentAnchorMode === "region" ? getCurrentCommentRegion() : undefined;
			if (commentAnchorMode === "layer" && !layerId) {
				projectStore.setStatusMsg($_("workMode.msgSelectTextLayerBeforeNote"));
				return;
			}
			if (commentAnchorMode === "region" && !region) {
				projectStore.setStatusMsg($_("workMode.msgDragRegionBeforeNote"));
				return;
			}
		const comment = await projectStore.addPageComment(newComment, layerId, region);
		if (comment) {
			newComment = "";
		}
	}

	function resolveComment(commentId: string): void {
		void projectStore.resolveComment(commentId);
	}

	function updateNewComment(value: string): void {
		newComment = value;
	}

	function updateCommentAnchorMode(value: CommentAnchorMode): void {
		commentAnchorMode = value;
	}

	function commentAnchorModeLabel(value: CommentAnchorMode): string {
		if (value === "layer") return $_("workComments.anchorLayer");
		if (value === "region") return $_("workMode.anchorRegion");
		return $_("workMode.anchorWholePage");
	}

	function commentAnchorLabel(comment: ProjectComment): string | null {
		if (projectStore.project && !projectStore.project.pages[comment.pageIndex]) {
			return $_("workMode.pageMissing", { values: { n: comment.pageIndex + 1 } });
		}
		if (comment.region) {
			return `${$_("workMode.anchorRegion")}: ${Math.round(comment.region.x)}, ${Math.round(comment.region.y)} / ${Math.round(comment.region.w)}x${Math.round(comment.region.h)}`;
		}
		if (!comment.layerId) return $_("workMode.wholePageNote");
		if (!projectStore.project) return $_("workMode.layerNote");
		const page = projectStore.project.pages[comment.pageIndex];
		const layer = page?.textLayers.find((item) => item.id === comment.layerId)
			?? (comment.pageIndex === projectStore.project.currentPage
				? editorStore.textLayers.find((item) => item.id === comment.layerId)
				: undefined);
		if (!layer) return $_("workMode.layerMissing", { values: { id: comment.layerId } });
		const text = (layer.text || $_("workMode.emptyText")).replace(/\s+/g, " ").trim();
		const layerLabel = $_("workComments.anchorLayer");
		return text.length > 28 ? `${layerLabel} / ${text.slice(0, 25)}...` : `${layerLabel} / ${text}`;
	}

	function focusCommentAnchor(comment: ProjectComment): void {
		projectStore.selectProjectComment(comment.id);
		if (!projectStore.project) return;
		if (!projectStore.project.pages[comment.pageIndex]) {
			projectStore.setStatusMsg($_("workMode.msgNotePageMissing"));
			return;
		}
		if (comment.pageIndex !== projectStore.project.currentPage) return;
		if (comment.region) {
			editorStore.setTool("select");
			return;
		}
			if (!comment.layerId) return;
			editorStore.selectTextLayer(comment.layerId);
			if (editorStore.selectedLayer?.id !== comment.layerId) {
				projectStore.setStatusMsg($_("workMode.msgNoteLayerGoneOnPage"));
				return;
			}
		editorUiStore.focusTextInspector(comment.layerId);
	}

	function getPanelComments(): ProjectComment[] {
		const selectedComment = projectStore.selectedProjectComment;
		if (!selectedComment || currentPageComments.some((comment) => comment.id === selectedComment.id)) return currentPageComments;
		return [selectedComment, ...currentPageComments];
	}

	function getCurrentCommentRegion(): { x: number; y: number; w: number; h: number } | undefined {
		const crop = editorStore.editor?.getCoverCrop?.();
		if (!crop || crop.w <= 0 || crop.h <= 0) return undefined;
		return {
			x: Math.round(crop.x),
			y: Math.round(crop.y),
			w: Math.round(crop.w),
			h: Math.round(crop.h),
		};
	}
</script>

<div class="work-mode-panel" class:section-focused={displayedWorkSection !== null}>
		<section class="work-command-card ws-panel" aria-label={$_("workMode.commandCardAria")}>
			<div class="work-command-copy">
				<span>{workPanelTitle}</span>
				<strong>{projectStore.project?.name ?? $_("workMode.workspaceNotOpen")}</strong>
			<small>{workScopeLabel}</small>
		</div>
		<div class={`work-next-action ${nextWorkAction.tone}`} class:summary-only={displayedWorkSection !== null}>
			<div>
				<span>{nextWorkAction.status}</span>
				<strong>{nextWorkAction.title}</strong>
				<small>{nextWorkAction.detail}</small>
			</div>
			{#if !displayedWorkSection}
				<button type="button" class="ws-grad-primary" onclick={() => revealWorkSection(nextWorkAction.section)}>
					{nextWorkAction.nextLabel}
				</button>
			{/if}
		</div>
		<div class="work-route-note" aria-label={$_("workMode.guideAria")}>
			<span>{workPanelScopeTitle}</span>
			<small>{workPanelGuide}</small>
		</div>
		{#if !displayedWorkSection}
			<div class="work-surface-actions" aria-label={$_("workMode.openMainSurfaceAria")}>
				<button type="button" class="primary ws-grad-primary" onclick={openWorkBoard}>
					<strong>{workBoardActionLabel}</strong>
					<small>{workBoardActionMeta}</small>
				</button>
			</div>
		{/if}
		<div class="work-command-metrics" aria-label={$_("workMode.metricsAria")}>
			<span class:attention={visibleInboxAttentionCount > 0}>
				<b>{visibleInboxAttentionCount}</b>
				{workAttentionLabel}
			</span>
				<span>
					<b>{activePageTaskCount}</b>
					{$_("workMode.metricProduction")}
				</span>
				<span>
					<b>{openPageCommentCount}</b>
					{$_("workMode.metricNotes")}
				</span>
				<span class:attention={aiReviewWorkCount > 0}>
					<b>{aiReviewWorkCount}</b>
					{aiReviewWorkMetricLabel}
				</span>
		</div>
	</section>

	{#if displayedWorkSection}
		<details class="work-section-switcher ws-panel-quiet" aria-label={$_("workMode.switchSectionAria")}>
			<summary data-expand-label={$_("workMode.expand")} data-collapse-label={$_("workMode.collapse")}>
				<span>{$_("workMode.switchSection")}</span>
				<strong>{workSectionLabel(displayedWorkSection)}</strong>
			</summary>
			<div class="work-section-switcher-body">
				{#each visibleWorkSectionSwitches() as item (item.id)}
					<button type="button" class="ws-btn-ghost" onclick={() => revealWorkSection(item.id)}>
						<strong>{workSectionLabelCopy(item.id)}</strong>
						<small>{workSectionDetailCopy(item.id)}</small>
					</button>
				{/each}
			</div>
		</details>
	{/if}

	{#if soloWorkspace && !displayedWorkSection}
		<details class="solo-advanced-work ws-panel-quiet" aria-label={$_("workMode.advancedWorkAria")}>
			<summary data-expand-label={$_("workMode.expand")} data-collapse-label={$_("workMode.collapse")}>
				<span>{$_("workMode.advancedWork")}</span>
				<small>{$_("workMode.advancedWorkHint")}</small>
			</summary>
			<div class="solo-advanced-work-body">
				<button type="button" class="ws-btn-ghost" onclick={() => revealWorkSection("hub")}>
					<strong>{workSectionLabelCopy("hub")}</strong>
					<small>{$_("workMode.countUpdates", { values: { n: projectStore.workspaceFeed.length } })}</small>
				</button>
				<button type="button" class="ws-btn-ghost" onclick={() => revealWorkSection("workflow")}>
					<strong>{workSectionLabelCopy("workflow")}</strong>
					<small>{$_("workMode.doneCount", { values: { done: workflowDoneCount, total: projectStore.tasks.length } })}</small>
				</button>
			</div>
		</details>
	{/if}

	{#if shouldRenderWorkSection("inbox")}
	<div class="panel-section ws-panel" class:active-work-section={displayedWorkSection === "inbox"} bind:this={inboxSectionElement}>
	<button
		type="button"
		class="panel-section-header work-section-header"
		aria-label={$_("workMode.sectionHeaderAria", { values: { label: $_("workMode.sectionInboxLabel"), state: workSectionIsOpen("inbox", inboxOpen) ? $_("workMode.stateOpen") : $_("workMode.stateClosed") } })}
		aria-expanded={workSectionIsOpen("inbox", inboxOpen)}
		onclick={toggleInbox}
	>
				<span class="section-copy">
				<span>{$_("workMode.sectionInboxLabel")}</span>
					<small>{$_("workMode.inboxCounts", { values: { pages: currentPageInboxItems.length, total: projectStore.workInbox.length } })}</small>
			</span>
		<span class:attention={visibleInboxAttentionCount > 0} class="section-meter">
			{visibleInboxAttentionCount ? $_("workMode.countNeedsFix", { values: { n: visibleInboxAttentionCount } }) : $_("workMode.ready")}
		</span>
		<span class="section-chevron" class:open={workSectionIsOpen("inbox", inboxOpen)} aria-hidden="true"></span>
	</button>
	{#if workSectionIsOpen("inbox", inboxOpen)}
		<div class="panel-section-body">
			<WorkInboxPanel
				totalCount={projectStore.workInbox.length}
				pageCount={currentPageInboxItems.length}
				projectOpen={Boolean(projectStore.project)}
				items={visibleInboxItems}
				scope={inboxScope}
				selectedItemId={selectedInboxItemId}
				severityLabel={inboxSeverityLabel}
				onScopeChange={(scope) => inboxScope = scope}
				onOpenItem={openInboxItem}
			/>
		</div>
	{/if}
</div>
{/if}

{#if shouldRenderWorkSection("hub")}
<div class="panel-section ws-panel" class:active-work-section={displayedWorkSection === "hub"} bind:this={workspaceHubSectionElement}>
	<button
		type="button"
		class="panel-section-header work-section-header"
		aria-label={$_("workMode.sectionHeaderAria", { values: { label: workSectionLabelCopy("hub"), state: workSectionIsOpen("hub", workspaceHubOpen) ? $_("workMode.stateOpen") : $_("workMode.stateClosed") } })}
		aria-expanded={workSectionIsOpen("hub", workspaceHubOpen)}
		onclick={toggleWorkspaceHub}
	>
		<span class="section-copy">
			<span>{workSectionLabelCopy("hub")}</span>
				<small>{$_("workMode.hubCounts", { values: { pages: currentPageWorkspaceFeed.length, total: projectStore.workspaceFeed.length } })}</small>
		</span>
		<span class="section-meter">{workspaceHubFilterLabel()}</span>
		<span class="section-chevron" class:open={workSectionIsOpen("hub", workspaceHubOpen)} aria-hidden="true"></span>
	</button>
	{#if workSectionIsOpen("hub", workspaceHubOpen)}
		<div class="panel-section-body">
			<WorkspaceHubPanel
				projectOpen={Boolean(projectStore.project)}
				totalEventCount={projectStore.workspaceFeed.length}
				pageEventCount={currentPageWorkspaceFeed.length}
				loading={projectStore.workspaceHubLoading}
				note={workspaceNote}
				items={visibleWorkspaceFeed}
				scope={workspaceHubScope}
				filter={workspaceHubFilter}
				selectedItemId={selectedWorkspaceItemId}
				kindLabel={workspaceKindLabel}
				timeLabel={workspaceFeedTime}
				isActionable={isWorkspaceFeedItemActionable}
				onNoteChange={updateWorkspaceNote}
				onScopeChange={(scope) => workspaceHubScope = scope}
				onFilterChange={(filter) => workspaceHubFilter = filter}
				onSync={() => projectStore.loadWorkspaceHub()}
				onAddHandoff={addWorkspaceNote}
				onOpenItem={openWorkspaceItem}
			/>
		</div>
	{/if}
</div>
{/if}

{#if shouldRenderWorkSection("ai")}
<div class="panel-section ws-panel" class:active-work-section={displayedWorkSection === "ai"} bind:this={aiReviewSectionElement}>
	<button
		type="button"
		class="panel-section-header work-section-header"
		aria-label={$_("workMode.sectionHeaderAria", { values: { label: $_("workMode.sectionAiLabel"), state: workSectionIsOpen("ai", aiReviewOpen) ? $_("workMode.stateOpen") : $_("workMode.stateClosed") } })}
		aria-expanded={workSectionIsOpen("ai", aiReviewOpen)}
		onclick={toggleAiReview}
	>
			<span class="section-copy">
				<span>{$_("workMode.sectionAiLabel")}</span>
				<small>{$_("workMode.aiOnThisPage", { values: { n: projectStore.currentPageAiReviewMarkers.length } })}</small>
			</span>
		<span class:attention={aiReviewMeterNeedsAttention} class="section-meter">
			{aiReviewMeterLabel}
		</span>
		<span class="section-chevron" class:open={workSectionIsOpen("ai", aiReviewOpen)} aria-hidden="true"></span>
	</button>
	{#if workSectionIsOpen("ai", aiReviewOpen)}
		<div class="panel-section-body">
			<AiReviewMarkersPanel />
		</div>
	{/if}
</div>
{/if}

{#if shouldRenderWorkSection("qc")}
<div class="panel-section ws-panel" class:active-work-section={displayedWorkSection === "qc"} bind:this={qcSectionElement}>
	<button
		type="button"
		class="panel-section-header work-section-header"
		aria-label={$_("workMode.sectionHeaderAria", { values: { label: $_("workMode.sectionQcLabel"), state: workSectionIsOpen("qc", qcOpen) ? $_("workMode.stateOpen") : $_("workMode.stateClosed") } })}
		aria-expanded={workSectionIsOpen("qc", qcOpen)}
		onclick={toggleQc}
	>
			<span class="section-copy">
				<span>{workSectionLabelCopy("qc")}</span>
				<small>{$_("workMode.itemsOnThisPage", { values: { n: currentPageQcIssues.length } })}</small>
			</span>
			<span class:attention={currentPageQcErrorCount > 0} class="section-meter">
				{currentPageQcErrorCount ? $_("workMode.countBlocks", { values: { n: currentPageQcErrorCount } }) : $_("workMode.countToCheck", { values: { n: currentPageQcWarningCount } })}
			</span>
		<span class="section-chevron" class:open={workSectionIsOpen("qc", qcOpen)} aria-hidden="true"></span>
	</button>
	{#if workSectionIsOpen("qc", qcOpen)}
		<div class="panel-section-body">
			<WorkQcPanel
				projectOpen={Boolean(projectStore.project)}
				errorCount={currentPageQcErrorCount}
				warningCount={currentPageQcWarningCount}
				infoCount={currentPageQcInfoCount}
				issues={currentPageQcIssues}
				selectedIssueId={projectStore.selectedQcIssueId}
				severityLabel={qcSeverityLabel}
				onIssueSelect={focusQcIssue}
			/>
		</div>
	{/if}
</div>
{/if}

{#if shouldRenderWorkSection("comments")}
<div class="panel-section ws-panel" class:active-work-section={displayedWorkSection === "comments"} bind:this={commentsSectionElement}>
	<button
		type="button"
		class="panel-section-header work-section-header"
		aria-label={$_("workMode.sectionHeaderAria", { values: { label: $_("workMode.sectionCommentsLabel"), state: workSectionIsOpen("comments", commentsOpen) ? $_("workMode.stateOpen") : $_("workMode.stateClosed") } })}
		aria-expanded={workSectionIsOpen("comments", commentsOpen)}
		onclick={toggleComments}
	>
		<span class="section-copy">
			<span>{$_("workMode.notesReviewHeading")}</span>
			<small>{$_("workMode.openOnThisPage", { values: { n: openPageCommentCount } })}</small>
		</span>
		<span class="section-meter">{commentAnchorModeLabel(commentAnchorMode)}</span>
		<span class="section-chevron" class:open={workSectionIsOpen("comments", commentsOpen)} aria-hidden="true"></span>
	</button>
	{#if workSectionIsOpen("comments", commentsOpen)}
		<div class="panel-section-body">
			<WorkCommentsPanel
				projectOpen={Boolean(projectStore.project)}
				loading={projectStore.commentsLoading}
				commentText={newComment}
				anchorMode={commentAnchorMode}
				selectedLayerAvailable={Boolean(editorStore.selectedLayer)}
				selectedLayerLabel={selectedCommentLayerLabel}
				regionAvailable={Boolean(currentCommentRegion)}
				comments={panelComments}
				selectedCommentId={projectStore.selectedProjectCommentId}
				getAnchorLabel={commentAnchorLabel}
				onCommentTextChange={updateNewComment}
				onAnchorModeChange={updateCommentAnchorMode}
				onAddComment={addComment}
				onFocusAnchor={focusCommentAnchor}
				onUseCommentAsReviewNote={useCommentAsReviewNote}
				onUseOpenCommentsAsReviewNote={useOpenCommentsAsReviewNote}
				onResolveComment={resolveComment}
			/>
		</div>
	{/if}
</div>
{/if}

{#if shouldRenderWorkSection("workflow")}
<div class="panel-section ws-panel" class:active-work-section={displayedWorkSection === "workflow"} bind:this={workflowSectionElement}>
	<button
		type="button"
		class="panel-section-header work-section-header"
		aria-label={$_("workMode.sectionHeaderAria", { values: { label: workSectionLabelCopy("workflow"), state: workSectionIsOpen("workflow", workflowOpen) ? $_("workMode.stateOpen") : $_("workMode.stateClosed") } })}
		aria-expanded={workSectionIsOpen("workflow", workflowOpen)}
		onclick={toggleWorkflow}
	>
		<span class="section-copy">
			<span>{workSectionLabelCopy("workflow")}</span>
				<small>{$_("workMode.doneInChapter", { values: { done: workflowDoneCount, total: projectStore.tasks.length } })}</small>
		</span>
		<span class:attention={activePageTaskCount > 0} class="section-meter">
			{activePageTaskCount ? $_("workMode.countOpen", { values: { n: activePageTaskCount } }) : $_("workMode.done")}
		</span>
		<span class="section-chevron" class:open={workSectionIsOpen("workflow", workflowOpen)} aria-hidden="true"></span>
	</button>
	{#if workSectionIsOpen("workflow", workflowOpen)}
		<div class="panel-section-body">
			<WorkWorkflowPanel
				projectOpen={Boolean(projectStore.project)}
				workflowLoading={projectStore.workflowLoading}
				reviewLoading={projectStore.reviewDecisionsLoading}
				workflowDoneCount={workflowDoneCount}
				totalTaskCount={projectStore.tasks.length}
				reviewNote={reviewNote}
				focusedReviewDecision={focusedPageReviewDecision}
				selectedReviewDecisionId={projectStore.selectedReviewDecisionId}
				reviewScopeLabel={focusedPageReviewScopeLabel}
				reviewScopeKind={focusedPageReviewScopeKind}
				reviewStatusCopy={reviewDecisionStatusCopy}
				reviewActionsDisabled={focusedPageReviewDecisionIsStale}
				tasks={currentPageTasks}
				selectedTaskId={projectStore.selectedWorkflowTaskId}
				openComments={openPageComments}
				selectedCommentId={projectStore.selectedProjectCommentId}
				statusOptions={workflowStatusOptions}
				priorityOptions={workflowPriorityOptions}
				activityLog={projectStore.activityLog}
				timeLabel={workspaceFeedTime}
				getCommentAnchorLabel={commentAnchorLabel}
				onUseCommentAsReviewNote={useCommentAsReviewNote}
				onSync={syncWorkflowPanel}
				onReviewNoteChange={updateReviewNote}
				onSubmitReviewDecision={submitReviewDecision}
				onTaskStatusChange={updateWorkflowTask}
				onTaskPriorityChange={updateWorkflowPriority}
				onTaskAssigneeChange={updateWorkflowAssignee}
				onTaskDueAtChange={updateWorkflowDueAt}
			/>
		</div>
	{/if}
</div>
{/if}
</div>

<style>
	.work-mode-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.work-mode-panel.section-focused .panel-section:not(.active-work-section) {
		display: none;
	}

	.work-section-switcher {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface) 70%, transparent);
	}

	.work-section-switcher summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 8px 10px;
		cursor: pointer;
		list-style: none;
	}

	.work-section-switcher summary::-webkit-details-marker {
		display: none;
	}

	.work-section-switcher summary::after {
		color: var(--color-ws-text);
		content: attr(data-expand-label);
		font-size: 10px;
		font-weight: 850;
	}

	.work-section-switcher[open] summary::after {
		content: attr(data-collapse-label);
	}

	.work-section-switcher summary span {
		color: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 850;
	}

	.work-section-switcher summary strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
	}

	.work-section-switcher-body {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
		padding: 0 8px 8px;
	}

	.work-section-switcher:not([open]) .work-section-switcher-body {
		display: none;
	}

	.work-section-switcher-body button {
		display: grid;
		min-height: 40px;
		gap: 2px;
		padding: 7px 8px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font: inherit;
		text-align: left;
	}

	.work-section-switcher-body button strong,
	.work-section-switcher-body button small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.work-section-switcher-body button strong {
		font-size: 11px;
		font-weight: 850;
	}

	.work-section-switcher-body button small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
	}

	.solo-advanced-work {
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-accent) 5%, var(--color-ws-surface));
	}

	.solo-advanced-work summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 8px 10px;
		color: var(--color-ws-ink);
		cursor: pointer;
		list-style: none;
	}

	.solo-advanced-work summary::-webkit-details-marker {
		display: none;
	}

	.solo-advanced-work summary::after {
		color: color-mix(in srgb, var(--color-ws-violet) 76%, var(--color-ws-text));
		content: attr(data-expand-label);
		font-size: 10px;
		font-weight: 850;
	}

	.solo-advanced-work[open] summary::after {
		content: attr(data-collapse-label);
	}

	.solo-advanced-work summary span,
	.solo-advanced-work summary small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.solo-advanced-work summary span {
		font-size: 11px;
		font-weight: 850;
	}

	.solo-advanced-work summary small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
	}

	.solo-advanced-work-body {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
		padding: 0 8px 8px;
	}

	.solo-advanced-work:not([open]) .solo-advanced-work-body {
		display: none;
	}

	.solo-advanced-work-body button {
		display: grid;
		min-height: 40px;
		gap: 2px;
		padding: 7px 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 46%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font: inherit;
		text-align: left;
	}

	.solo-advanced-work-body button strong,
	.solo-advanced-work-body button small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.solo-advanced-work-body button strong {
		font-size: 11px;
		font-weight: 850;
	}

	.solo-advanced-work-body button small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 700;
	}

	.work-command-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background:
			linear-gradient(135deg,
				color-mix(in srgb, var(--color-ws-accent) 12%, transparent),
				color-mix(in srgb, var(--color-ws-surface2) 94%, transparent)),
			var(--color-ws-surface);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	.work-command-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
	}

	.work-command-copy > span {
		color: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0.02em;
		text-transform: none;
	}

	.work-command-copy strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 16px;
		font-weight: 760;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.work-command-copy small {
		color: var(--color-ws-text);
		font-size: 11px;
		line-height: 1.35;
	}

	.work-next-action {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 86px;
		align-items: center;
		gap: 9px;
		padding: 9px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 50%, transparent);
	}

	.work-next-action.summary-only {
		grid-template-columns: minmax(0, 1fr);
	}

	.work-next-action.attention {
		border-color: color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
	}

	.work-next-action.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 8%, transparent);
	}

	.work-next-action > div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.work-next-action span {
		color: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
		font-size: 9px;
		font-weight: 850;
		text-transform: none;
	}

	.work-next-action.attention span {
		color: var(--color-ws-amber);
	}

	.work-next-action.ready span {
		color: var(--color-ws-green);
	}

	.work-next-action strong,
	.work-next-action small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.work-next-action strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 800;
		white-space: nowrap;
	}

	.work-next-action small {
		display: -webkit-box;
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.work-next-action button {
		min-width: 0;
		min-height: 40px;
		padding: 0 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 10px;
		font-weight: 800;
	}

	.work-next-action button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 66%, transparent);
		filter: brightness(1.06);
	}

	.work-route-note {
		display: grid;
		grid-template-columns: 76px minmax(0, 1fr);
		align-items: center;
		min-width: 0;
		gap: 8px;
		padding: 7px 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 46%, transparent);
	}

	.work-route-note span {
		color: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
		font-size: 9px;
		font-weight: 850;
		line-height: 1.2;
		text-transform: none;
	}

	.work-route-note small {
		display: block;
		min-width: 0;
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.25;
		white-space: normal;
	}

	.work-surface-actions {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 7px;
		align-items: stretch;
	}

	.work-surface-actions button {
		display: flex;
		min-width: 0;
		min-height: 42px;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		padding: 7px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-accent) 7%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		text-align: left;
	}

	.work-surface-actions button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 48%, transparent);
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
	}

	.work-surface-actions button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 48%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
	}

	.work-surface-actions button.primary:hover {
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
		filter: brightness(1.06);
	}

	.work-surface-actions strong,
	.work-surface-actions small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.work-surface-actions strong {
		font-size: 11px;
		font-weight: 850;
	}

	.work-surface-actions small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 720;
	}

	@media (min-width: 901px) and (max-width: 1040px) {
		.work-command-card {
			gap: 8px;
			padding: 10px;
		}

		.work-next-action {
			grid-template-columns: minmax(0, 1fr);
			align-items: stretch;
		}

		.work-next-action button {
			min-height: 40px;
		}

		.work-surface-actions {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	}

	.work-command-metrics {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.work-command-metrics span {
		display: flex;
		min-width: 0;
		flex: 1 1 72px;
		overflow: hidden;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 5px 7px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-bg) 50%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 760;
	}

	.work-command-metrics span.attention {
		border-color: color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 11%, transparent);
		color: var(--color-ws-amber);
	}

	.work-command-metrics b {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
	}

	.work-section-header {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 18px;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding-block: 7px;
		text-transform: none;
		width: 100%;
		text-align: left;
	}

	.section-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.section-copy > span {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
		text-overflow: ellipsis;
		text-transform: none;
		white-space: nowrap;
	}

	.section-copy small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 650;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: none;
	}

	.section-meter {
		min-width: 0;
		max-width: 112px;
		overflow: hidden;
		padding: 4px 7px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 64%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 780;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: none;
	}

	.section-meter.attention {
		border-color: color-mix(in srgb, var(--color-ws-amber) 36%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 11%, transparent);
		color: var(--color-ws-amber);
	}

	.section-chevron {
		justify-self: end;
		width: 7px;
		height: 7px;
		border-right: 1.5px solid var(--color-ws-text);
		border-bottom: 1.5px solid var(--color-ws-text);
		transform: rotate(-45deg);
		transition: transform 120ms ease, border-color 120ms ease;
	}

	.work-section-header:hover .section-chevron,
	.section-chevron.open {
		border-color: var(--color-ws-ink);
	}

	.section-chevron.open {
		transform: rotate(45deg);
	}
</style>
