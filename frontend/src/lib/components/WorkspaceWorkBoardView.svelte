<script lang="ts">
	import { _ } from "$lib/i18n";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { buildWorkspaceHref } from "$lib/navigation/workspace-routes.js";
	import { formatAssigneeHandle } from "$lib/project/assignees.js";
	import {
		exportCreditSummaryPolicyLabel,
		exportPolicyControlLabel,
		workboardCreditPolicyDetail,
	} from "$lib/project/export-profiles.js";
	import {
		buildTaskFocusQueue,
		summarizeTaskFocusQueue,
		type TaskFocusItem,
	} from "$lib/project/task-focus-queue.js";
	import {
		buildWorkspaceAssignedWork,
		buildWorkspaceDashboardStats,
		buildWorkspaceInboxSummary,
		buildWorkspaceJobLanes,
		getWorkspaceAttentionItems,
		type WorkspaceAssignedWorkGroup,
		type WorkspaceJobLane,
	} from "$lib/project/workspace-dashboard.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { authStore, rolePermissionProfile } from "$lib/stores/auth.svelte.ts";
	import { getPagePreviewImageId } from "$lib/project/page-thumbnails.js";
	import { type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { isAiResultPlacementOrRecoveryNeeded } from "$lib/project/ai-review-marker-intent.js";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import type { WorkInboxItem } from "$lib/project/work-inbox.js";
	import { workInboxTitle } from "$lib/project/work-inbox-copy.js";
	import type { AiReviewMarker, CreditPolicy, Page, PageCleaningHandoffStatus, PageCleaningProofKind, PageQcHandoffStatus, PageTranslationHandoffStatus, TextLayer, TranslationScriptSlot, WorkflowTask } from "$lib/types.js";
	import WorkspaceAssignedWork from "./WorkspaceAssignedWork.svelte";
	import WorkspaceJobLanes from "./WorkspaceJobLanes.svelte";
	import WorkspacePriorityInbox from "./WorkspacePriorityInbox.svelte";
	import WorkspaceTopUtilityBar from "./WorkspaceTopUtilityBar.svelte";
	import CleanerHandoffBench from "./workspace/workboard/CleanerHandoffBench.svelte";
	import CollabSubmitBar from "./workspace/workboard/CollabSubmitBar.svelte";
	import ProductionRoleMap from "./workspace/workboard/ProductionRoleMap.svelte";
	import QcCreditBench from "./workspace/workboard/QcCreditBench.svelte";
	import ReviewCommandStrip from "./workspace/workboard/ReviewCommandStrip.svelte";
	import RoleNextStrip from "./workspace/workboard/RoleNextStrip.svelte";
	import SoloBlockerStrip from "./workspace/workboard/SoloBlockerStrip.svelte";
	import TranslatorScriptBench from "./workspace/workboard/TranslatorScriptBench.svelte";
	import TypesetterScriptBench from "./workspace/workboard/TypesetterScriptBench.svelte";

	type ReviewCommandTone = "hot" | "warn" | "ready" | "idle";
	type ReviewCommandFilter = "comments" | "ai-qc" | "review" | "blockers" | "workflow" | "all";

	interface ReviewCommand {
		id: string;
		label: string;
		count: number;
		detail: string;
		tone: ReviewCommandTone;
		item: TaskFocusItem | null;
		filter: ReviewCommandFilter;
	}

	interface BlockerVisualPreview {
		pageLabel: string;
		title: string;
		detail: string;
		previewUrl: string | null;
		previewParams: SignedAssetSrcParams | null;
		imageName: string;
		regionStyle: string | null;
	}

	interface ProductionRoleCard {
		id: string;
		title: string;
		lane: string;
		detail: string;
		taskType: WorkspaceJobLane["id"];
	}

	type ProductionPageTone = "ready" | "warn" | "raw";

	interface PageProductionSummary {
		pageIndex: number;
		pageLabel: string;
		imageName: string;
		cleanLabel: string;
		cleanTone: ProductionPageTone;
		translatorLabel: string;
		translatorTone: ProductionPageTone;
		typesetLabel: string;
		typesetTone: ProductionPageTone;
		qcLabel: string;
		qcTone: ProductionPageTone;
		nextRoleId: ProductionRoleCard["id"] | null;
		nextRoleLabel: string;
	}

	interface MainProjectHandoffSummary {
		ready: boolean;
		title: string;
		detail: string;
		action: string;
		nextRoleId: ProductionRoleCard["id"] | null;
		nextPageIndex: number | null;
		cleanLabel: string;
		cleanTone: ProductionPageTone;
		typesetLabel: string;
		typesetTone: ProductionPageTone;
		qcLabel: string;
		qcTone: ProductionPageTone;
		creditLabel: string;
		creditTone: ProductionPageTone;
	}

	interface PageStateRoleNextWork {
		pageIndex: number;
		roleId: ProductionRoleCard["id"];
		title: string;
		detail: string;
		action: string;
	}

	type TranslationSlotLayerSyncState = "synced" | "stale";

	interface CreditLayerSummary {
		currentText: number;
		currentImage: number;
		chapterText: number;
		chapterImage: number;
	}

	interface CompletedTaskReconciliation {
		taskIds: string[];
		translateCount: number;
		cleanCount: number;
		typesetCount: number;
		reviewCount: number;
		reviewNeedsFinalQcCount: number;
	}

	let PRODUCTION_ROLE_CARDS = $derived<readonly ProductionRoleCard[]>([
		{
			id: "cleaner",
			title: $_("workBoard.roleCleanerTitle"),
			lane: "Raw -> Clean",
			detail: $_("workBoard.roleCleanerDetail"),
			taskType: "clean",
		},
		{
			id: "translator",
			title: $_("workBoard.roleTranslatorTitle"),
			lane: "Raw -> Script",
			detail: $_("workBoard.roleTranslatorDetail"),
			taskType: "translate",
		},
		{
			id: "typesetter",
			title: $_("workBoard.roleTypesetterTitle"),
			lane: "Script -> Typeset",
			detail: $_("workBoard.roleTypesetterDetail"),
			taskType: "typeset",
		},
		{
			id: "qc",
			title: $_("workBoard.roleQcTitle"),
			lane: "Review -> Main",
			detail: $_("workBoard.roleQcDetail"),
			taskType: "review",
		},
	]);

	function translatorScriptSlotPlaceholder(category: TranslationScriptSlot["category"]): string {
		return category === "sfx" || category === "sign"
			? $_("workBoard.slotPlaceholderSfx")
			: $_("workBoard.slotPlaceholderDialogue");
	}

	let roleCapabilities = $derived(rolePermissionProfile(projectStore.currentWorkspaceMember?.memberStudioRole ?? authStore.role));
	let soloWorkspace = $derived(editorUiStore.workspaceMode === "solo");
	let taskFocusItems = $derived(buildTaskFocusQueue(projectStore.workInbox, projectStore.tasks));
	let focusSummary = $derived(summarizeTaskFocusQueue(taskFocusItems));
	let inboxItems = $derived(getWorkspaceAttentionItems(projectStore.workInbox, 12));
	let inboxSummary = $derived(buildWorkspaceInboxSummary(projectStore.workInbox));
	let jobLanes = $derived(buildWorkspaceJobLanes(projectStore.tasks, roleCapabilities));
	let jobLaneEmptyLabels = $derived(buildJobLaneEmptyLabels());
	let assignedWorkGroups = $derived(buildWorkspaceAssignedWork(projectStore.tasks, 12, 6));
	let workspaceStats = $derived(buildWorkspaceDashboardStats(projectStore.tasks, projectStore.workspaceFeed));
	let chapterPageIndexes = $derived(projectStore.project?.pages.map((_, index) => index) ?? []);
	let hasProjectPages = $derived(Boolean(projectStore.project && projectStore.project.pages.length > 0));
	let chapterReadiness = $derived(buildChapterReadiness());
	let activeLaneCount = $derived(jobLanes.filter((lane) => lane.openCount > 0).length);
	let primaryOwnerGroup = $derived(assignedWorkGroups.find((group) => group.assignee) ?? null);
	let unassignedGroup = $derived(assignedWorkGroups.find((group) => !group.assignee) ?? null);
	let unassignedOpenCount = $derived(unassignedGroup?.openCount ?? 0);
	let realAssigneeCount = $derived(new Set(
		assignedWorkGroups
			.map((group) => group.assignee?.trim().replace(/^@/, "").toLowerCase())
			.filter((assignee): assignee is string => Boolean(assignee) && assignee !== "local-user" && assignee !== "solo"),
	).size);
	let showOwnershipCeremony = $derived(!soloWorkspace || realAssigneeCount > 1);
	let showAssignedQueueOverview = $derived(!soloWorkspace || showOwnershipCeremony);
	let selectedProductionRoleId = $state<ProductionRoleCard["id"] | null>(null);
	let commentReviewItems = $derived(taskFocusItems.filter((item) => item.kind === "comment"));
	let aiQcReviewItems = $derived(taskFocusItems.filter((item) => item.kind === "ai_marker" || item.kind === "qc"));
	let decisionReviewItems = $derived(taskFocusItems.filter((item) => item.kind === "review_task" || item.status === "review"));
	let blockerReviewItems = $derived(
		taskFocusItems.filter((item) => item.severity === "error" || item.overdue || item.priority === "urgent" || isAiPlacementItem(item)),
	);
	let selectedRoleWorkflowItems = $derived(
		taskFocusItems.filter((item) =>
			item.kind === "workflow_task" || item.kind === "review_task"
		),
	);
	let selectedRoleNextItem = $derived(selectedRoleWorkflowItems[0] ?? null);
	let selectedRolePageStateNext = $derived(buildSelectedRolePageStateNext());
	let showCleanerHandoffBench = $derived(!soloWorkspace && selectedProductionRoleId === "cleaner");
	let showTranslatorScriptBench = $derived(!soloWorkspace && selectedProductionRoleId === "translator");
	let showTypesetterScriptBench = $derived(!soloWorkspace && selectedProductionRoleId === "typesetter");
	let showQcCreditBench = $derived(!soloWorkspace && selectedProductionRoleId === "qc");
	let showProductionRoleBench = $derived(showCleanerHandoffBench || showTranslatorScriptBench || showTypesetterScriptBench || showQcCreditBench);
	let currentPageCleaningHandoff = $derived(projectStore.project?.pages[projectStore.project.currentPage]?.cleaningHandoff ?? null);
	let currentPageCleanBrushProof = $derived(projectStore.project?.pages[projectStore.project.currentPage]?.imageLayers?.find((layer) => Boolean(layer.restoreImageId) && layer.role !== "credit") ?? null);
	let currentPageTranslationHandoff = $derived(projectStore.project?.pages[projectStore.project.currentPage]?.translationHandoff ?? null);
	let currentPageQcHandoff = $derived(projectStore.project?.pages[projectStore.project.currentPage]?.qcHandoff ?? null);
	let currentPageLabel = $derived(projectStore.project ? $_("workBoard.pageN", { values: { n: projectStore.project.currentPage + 1 } }) : $_("workBoard.noPagesYet"));
	let currentPageLanguageLabel = $derived(projectStore.project?.targetLang.toUpperCase() ?? "LANG");
	let currentPageName = $derived(projectStore.project?.pages[projectStore.project.currentPage]?.originalName || projectStore.project?.pages[projectStore.project.currentPage]?.imageName || currentPageLabel);
	let currentPageTypesetLayers = $derived(projectStore.project?.pages[projectStore.project.currentPage]?.textLayers ?? []);
	let topBlockerItem = $derived(blockerReviewItems[0] ?? null);
	let showSoloBlockerStrip = $derived(Boolean(soloWorkspace && topBlockerItem));
	let workModeDetail = $derived(
		soloWorkspace
			? topBlockerItem
				? $_("workBoard.firstWorkItem", { values: { title: workItemDisplayTitle(topBlockerItem) } })
				: $_("workBoard.seeNextWithBlocker")
			: selectedProductionRoleId
				? $_("workBoard.viewingRole", { values: { role: productionRoleTitle(selectedProductionRoleId) } })
				: $_("workBoard.splitRoles"),
	);
	let blockerPreviewFailures = $state<Record<string, boolean>>({});
	let topBlockerVisual = $derived(buildBlockerVisualPreview(topBlockerItem));
	let translatorBenchPreview = $derived(buildTranslatorBenchPreview());
	let translatorScriptSlots = $derived(buildTranslatorScriptSlots());
	let translatedScriptCount = $derived(translatorScriptSlots.filter((slot) => slot.translatedText.trim()).length);
	let currentPageOrphanedTypesetLayers = $derived(projectStore.project
		? orphanedTranslationSlotLayersForPage(projectStore.project.pages[projectStore.project.currentPage])
		: []);
	let orphanTypesetLayerCount = $derived(currentPageOrphanedTypesetLayers.length);
	let staleTypesetSlotCount = $derived(countStaleTypesetSlots());
	let currentTypesetSlotLayerCount = $derived(countTypesetSlotLayers());
	let missingTypesetSlotCount = $derived(Math.max(0, translatedScriptCount - currentTypesetSlotLayerCount));
	let qcTypesetTruthWarn = $derived(orphanTypesetLayerCount > 0 || staleTypesetSlotCount > 0 || translatedScriptCount === 0 || missingTypesetSlotCount > 0);
	let qcTypesetTruthLabel = $derived(typesetTruthStatusLabel());
	let creditLayerSummary = $derived(buildCreditLayerSummary());
	let creditPolicy = $derived((projectStore.project?.creditPolicy ?? "optional") as CreditPolicy);
	let creditRequired = $derived(creditPolicy === "required");
	let pageProductionSummaries = $derived(buildPageProductionSummaries());
	let currentPageProductionHandoff = $derived(buildCurrentPageProductionHandoff());
	let pageProductionOverflowCount = $derived(projectStore.project ? Math.max(0, projectStore.project.pages.length - pageProductionSummaries.length) : 0);
	let mainProjectHandoff = $derived(buildMainProjectHandoffSummary());
	let completedTaskReconciliation = $derived(buildCompletedTaskReconciliation());
	let currentPageOpenCommentCount = $derived(projectStore.project
		? projectStore.comments.filter((comment) => comment.pageIndex === projectStore.project!.currentPage && comment.status === "open").length
		: 0);
	let currentPageAiQcCount = $derived(projectStore.project
		? projectStore.currentPageAiReviewMarkers.filter((marker) => marker.status !== "applied").length
			+ projectStore.qcReport.issues.filter((issue) => issue.pageIndex === projectStore.project!.currentPage && issue.severity !== "info").length
		: 0);
	let currentPageNeedsCleanRecheck = $derived(needsCleanTypesetRecheck(projectStore.project?.currentPage ?? null));
	let latestReviewDecision = $derived(getLatestCurrentPageReviewDecision());
	let activeTranslatorScriptSlotId = $state<string | null>(null);
	let activeTranslatorScriptSlot = $derived(
		translatorScriptSlots.find((slot) => slot.id === activeTranslatorScriptSlotId) ?? translatorScriptSlots[0] ?? null,
	);
	let reviewCommands = $derived([
		buildReviewCommand("comments", $_("workBoard.cmdNotesLabel"), commentReviewItems, $_("workBoard.cmdNotesActive"), $_("workBoard.cmdNotesEmpty"), "warn", "comments"),
		buildReviewCommand("ai-qc", $_("workBoard.cmdAiQcLabel"), aiQcReviewItems, $_("workBoard.cmdAiQcActive"), $_("workBoard.cmdAiQcEmpty"), "warn", "ai-qc"),
		buildReviewCommand("decisions", $_("workBoard.cmdDecisionsLabel"), decisionReviewItems, $_("workBoard.cmdDecisionsActive"), $_("workBoard.cmdDecisionsEmpty"), "ready", "review"),
		buildReviewCommand("blockers", $_("workBoard.cmdBlockersLabel"), blockerReviewItems, $_("workBoard.cmdBlockersActive"), $_("workBoard.cmdBlockersEmpty"), "hot", "blockers"),
	]);
	let qcPrimaryCommand = $derived([
		reviewCommands.find((command) => command.id === "blockers"),
		reviewCommands.find((command) => command.id === "ai-qc"),
		reviewCommands.find((command) => command.id === "comments"),
		reviewCommands.find((command) => command.id === "decisions"),
	].find((command) => command?.item) ?? null);

	function reviewCommandAriaLabel(command: { id: string; label: string }): string {
		if (command.id === "comments") return $_("workBoard.cmdAriaNotes");
		if (command.id === "ai-qc") return $_("workBoard.cmdAriaAiQc");
		if (command.id === "decisions") return $_("workBoard.cmdAriaDecisions");
		if (command.id === "blockers") return $_("workBoard.cmdAriaBlockers");
		return $_("workBoard.cmdAriaGeneric", { values: { label: command.label } });
	}

	function buildChapterReadiness(): { tone: "ready" | "warn"; title: string; detail: string; action: string } {
		if (!projectStore.project) {
			return {
				tone: "warn",
				title: $_("workBoard.readinessNoChapterTitle"),
				detail: $_("workBoard.readinessNoChapterDetail"),
				action: $_("workBoard.selectChapter"),
			};
		}
		const exportGate = projectStore.getBatchExportGate(chapterPageIndexes);
		if (!exportGate.canExport) {
			return {
				tone: "warn",
				title: $_("workBoard.cannotExportYet"),
				detail: exportGate.message,
				action: topBlockerItem ? workPrimaryActionLabel(topBlockerItem) : $_("workBoard.viewBlocker"),
			};
		}
		const blockers = [
			inboxSummary.blockerCount ? $_("workBoard.blockerCountStuck", { values: { n: inboxSummary.blockerCount } }) : "",
			workspaceStats.overdueTaskCount ? $_("workBoard.overdueCount", { values: { n: workspaceStats.overdueTaskCount } }) : "",
			focusSummary.reviewCount ? $_("workBoard.reviewCount", { values: { n: focusSummary.reviewCount } }) : "",
			focusSummary.commentCount ? $_("workBoard.noteCount", { values: { n: focusSummary.commentCount } }) : "",
			focusSummary.aiCount + focusSummary.qcCount ? $_("workBoard.aiQualityCount", { values: { n: focusSummary.aiCount + focusSummary.qcCount } }) : "",
		].filter(Boolean);
		if (!blockers.length && workspaceStats.openTaskCount === 0) {
			return {
				tone: "ready",
				title: $_("workBoard.readyToExport"),
				detail: $_("workBoard.readyToExportDetail"),
				action: $_("workBoard.viewPages"),
			};
		}
		return {
			tone: "warn",
			title: $_("workBoard.cannotExportYet"),
			detail: blockers.length ? $_("workBoard.mustClear", { values: { items: blockers.join(" / ") } }) : $_("workBoard.openTasksBeforeExport", { values: { n: workspaceStats.openTaskCount } }),
			action: topBlockerItem ? workPrimaryActionLabel(topBlockerItem) : $_("workBoard.doNextWork"),
		};
	}

	function buildReviewCommand(
		id: string,
		label: string,
		items: readonly TaskFocusItem[],
		activeDetail: string,
		emptyDetail: string,
		activeTone: ReviewCommandTone,
		filter: ReviewCommandFilter,
	): ReviewCommand {
		return {
			id,
			label,
			count: items.length,
			detail: items.length ? activeDetail : emptyDetail,
			tone: items.length ? activeTone : "idle",
			item: items[0] ?? null,
			filter,
		};
	}

	function ownerSignal(group: WorkspaceAssignedWorkGroup | null): string {
		if (!group) return $_("workBoard.noOwnerQueue");
		const signals = [
			$_("workBoard.openTasksN", { values: { n: group.openCount } }),
			group.urgentCount ? $_("workBoard.urgentN", { values: { n: group.urgentCount } }) : "",
			group.reviewCount ? $_("workBoard.reviewCount", { values: { n: group.reviewCount } }) : "",
			group.overdueCount ? $_("workBoard.overdueCount", { values: { n: group.overdueCount } }) : "",
		].filter(Boolean);
		return signals.join(" / ");
	}

	function queueOverviewLabel(): string {
		return soloWorkspace ? $_("workBoard.queueOverviewSolo") : $_("workBoard.queueOverviewTeam");
	}

	function queueOverviewSummary(): string {
		if (soloWorkspace) {
			return $_("workBoard.queueSummarySolo", { values: { n: inboxItems.length } });
		}
		const parts = [
			$_("workBoard.urgentN", { values: { n: inboxItems.length } }),
			showAssignedQueueOverview ? $_("workBoard.ownersN", { values: { n: assignedWorkGroups.length } }) : "",
			$_("workBoard.stepsN", { values: { n: activeLaneCount } }),
		].filter(Boolean);
		return parts.join(" / ");
	}

	function lanePanelAriaLabel(): string {
		return soloWorkspace ? $_("workBoard.laneDetailSteps") : $_("workBoard.laneProductionQueue");
	}

	function lanePanelEyebrow(): string {
		return soloWorkspace ? $_("workBoard.laneOrderEyebrow") : $_("workBoard.laneProductionEyebrow");
	}

	function lanePanelTitle(): string {
		return soloWorkspace ? $_("workBoard.laneDetailSteps") : $_("workBoard.laneByStep");
	}

	function productionRoleCount(card: ProductionRoleCard): string {
		const lane = jobLanes.find((item) => item.id === card.taskType);
		const pageBacklogCount = productionRolePageBacklogCount(card);
		if (!lane) return pageBacklogCount ? $_("workBoard.pagesToDo", { values: { n: pageBacklogCount } }) : $_("workBoard.zeroTasks");
		if (pageBacklogCount > 0) return $_("workBoard.pagesToDo", { values: { n: pageBacklogCount } });
		if (lane.openCount > 0) return $_("workBoard.openDoneTotal", { values: { open: lane.openCount, done: lane.doneCount, total: lane.totalCount } });
		if (lane.totalCount > 0) return $_("workBoard.doneTotal", { values: { done: lane.doneCount, total: lane.totalCount } });
		return productionRoleEmptyLabel(card);
	}

	function productionRoleButtonLabel(card: ProductionRoleCard): string {
		return $_("workBoard.openRole", { values: { role: card.title } });
	}

	function currentPageHandoffActionLabel(): string {
		if (!currentPageProductionHandoff?.nextRoleId) return $_("workBoard.checkReturnChapter");
		return $_("workBoard.goToRole", { values: { role: currentPageProductionHandoff.nextRoleLabel } });
	}

	function productionPageOpenLabel(summary: PageProductionSummary): string {
		return $_("workBoard.openLabel", { values: { label: summary.pageLabel } });
	}

	function productionRolePageBacklogCount(card: ProductionRoleCard): number {
		const project = projectStore.project;
		if (!project) return 0;
		if (card.id === "cleaner") {
			return project.pages.filter((page) => (page.cleaningHandoff?.status ?? "raw") !== "clean_ready").length;
		}
		if (card.id === "translator") {
			return project.pages.filter((page) =>
				(page.cleaningHandoff?.status ?? "raw") === "clean_ready"
				&& ((page.translationHandoff?.status ?? "draft") !== "translated" || translatedScriptSlotCountForPage(page) === 0),
			).length;
		}
		if (card.id === "typesetter") {
			return project.pages.filter((page) =>
				page.translationHandoff?.status === "translated"
				&& translatedScriptSlotCountForPage(page) > 0
				&& (
					missingTranslatedSlotLayerCount(page) > 0
					|| staleTranslatedSlotLayerCountForPage(page) > 0
					|| orphanedTranslationSlotLayersForPage(page).length > 0
					|| page.cleaningHandoff?.typesetRecheckStatus === "needs_adjustment"
				),
			).length;
		}
		if (card.id === "qc") {
			const pageIndexes: number[] = [];
			const addQcPageIndex = (pageIndex: number): void => {
				if (project.pages[pageIndex] && !pageIndexes.includes(pageIndex)) pageIndexes.push(pageIndex);
			};
			for (const comment of projectStore.comments) {
				if (comment.status === "open") addQcPageIndex(comment.pageIndex);
			}
			for (const task of projectStore.tasks) {
				if (task.type === "review" && task.status !== "done") addQcPageIndex(task.pageIndex);
			}
			for (const issue of projectStore.qcReport.issues) {
				if (issue.severity !== "info" && issue.pageIndex !== undefined) addQcPageIndex(issue.pageIndex);
			}
			project.pages.forEach((page, pageIndex) => {
				if (needsCleanTypesetRecheck(pageIndex) || (pageReadyForFinalQc(page, pageIndex) && qcHandoffStatusForPage(page) !== "ready")) {
					addQcPageIndex(pageIndex);
				}
			});
			if (creditRequired && creditLayerSummary.chapterText + creditLayerSummary.chapterImage === 0) {
				addQcPageIndex(project.currentPage);
			}
			return pageIndexes.length;
		}
		return 0;
	}

	function productionRoleEmptyLabel(card: ProductionRoleCard): string {
		const project = projectStore.project;
		if (!project) return $_("workBoard.noWorkYet");
		if (card.id === "cleaner") return $_("workBoard.allDone");
		if (card.id === "translator") {
			const hasCleanReadyPage = project.pages.some((page) => (page.cleaningHandoff?.status ?? "raw") === "clean_ready");
			return hasCleanReadyPage ? $_("workBoard.allDone") : $_("workBoard.waitCleanFirst");
		}
		if (card.id === "typesetter") {
			const hasTranslatedScript = project.pages.some((page) =>
				page.translationHandoff?.status === "translated" && translatedScriptSlotCountForPage(page) > 0,
			);
			return hasTranslatedScript ? $_("workBoard.allDone") : $_("workBoard.waitTranslationScript");
		}
		if (card.id === "qc") {
			const upstreamBacklog = PRODUCTION_ROLE_CARDS
				.filter((role) => role.id !== "qc")
				.some((role) => productionRolePageBacklogCount(role) > 0);
			return upstreamBacklog ? $_("workBoard.waitUpstream") : $_("workBoard.allDone");
		}
		return $_("workBoard.noWorkYet");
	}

	function buildJobLaneEmptyLabels(): Partial<Record<WorkspaceJobLane["id"], string>> {
		if (soloWorkspace) return {};
		const labels: Partial<Record<WorkspaceJobLane["id"], string>> = {};
		for (const card of PRODUCTION_ROLE_CARDS) {
			const pageBacklogCount = productionRolePageBacklogCount(card);
			labels[card.taskType] = pageBacklogCount > 0
				? $_("workBoard.pagesFromPageState", { values: { n: pageBacklogCount } })
				: productionRoleEmptyLabel(card);
		}
		return labels;
	}

	function selectProductionRole(card: ProductionRoleCard): void {
		selectedProductionRoleId = card.id;
	}

	async function selectProductionPage(summary: PageProductionSummary): Promise<void> {
		if (!projectStore.project) return;
		const pageOpened = await ensurePageSelected(summary.pageIndex);
		if (!pageOpened) return;
		if (summary.nextRoleId) {
			const nextRole = PRODUCTION_ROLE_CARDS.find((card) => card.id === summary.nextRoleId);
			if (nextRole) selectProductionRole(nextRole);
		}
	}

	async function openMainProjectHandoff(): Promise<void> {
		if (!projectStore.project) return;
		if (mainProjectHandoff.ready || mainProjectHandoff.nextPageIndex === null) {
			openPages();
			return;
		}
		const pageOpened = await ensurePageSelected(mainProjectHandoff.nextPageIndex);
		if (!pageOpened) return;
		if (mainProjectHandoff.nextRoleId) {
			const nextRole = PRODUCTION_ROLE_CARDS.find((card) => card.id === mainProjectHandoff.nextRoleId);
			if (nextRole) selectProductionRole(nextRole);
		}
		// Internal coupling: mainProjectHandoff.action is built in THIS file's
		// buildMainProjectHandoffSummary() with $_("workBoard.mainActionGoCredit"),
		// so both sides localize together and stay equal.
		if (mainProjectHandoff.action === $_("workBoard.mainActionGoCredit")) {
			openCreditWorkflow();
		}
	}

	function openCurrentPageProductionHandoff(): void {
		if (!projectStore.project || !currentPageProductionHandoff) return;
		if (currentPageProductionHandoff.nextRoleId) {
			const nextRole = PRODUCTION_ROLE_CARDS.find((card) => card.id === currentPageProductionHandoff?.nextRoleId);
			if (nextRole) selectProductionRole(nextRole);
			return;
		}
		void openMainProjectHandoff();
	}

	function productionActorHandle(roleId: ProductionRoleCard["id"] | null = selectedProductionRoleId): string {
		if (roleId === "cleaner") return "cleaner";
		if (roleId === "translator") return "translator";
		if (roleId === "typesetter") return "typesetter";
		if (roleId === "qc") return "qc";
		return soloWorkspace ? "solo" : "local-user";
	}

	function updateCleanerHandoff(status: PageCleaningHandoffStatus, proofKind?: PageCleaningProofKind): void {
		projectStore.updateCurrentPageCleaningHandoff(status, proofKind, productionActorHandle("cleaner"));
	}

	function updateTranslatorHandoff(status: PageTranslationHandoffStatus): void {
		projectStore.updateCurrentPageTranslationHandoff(status, productionActorHandle("translator"));
	}

	function sendTranslatorHandoff(): void {
		for (const slot of translatorScriptSlots) {
			if (!slot.translatedText.trim()) continue;
			projectStore.updateCurrentPageTranslationScriptSlot({
				id: slot.id,
				label: slot.label,
				x: slot.x,
				y: slot.y,
				category: slot.category,
				sourceText: slot.sourceText,
				translatedText: slot.translatedText,
				note: slot.note,
				updatedAt: new Date().toISOString(),
			}, productionActorHandle("translator"));
		}
		projectStore.updateCurrentPageTranslationHandoff("translated", productionActorHandle("translator"));
	}

	function translatorHandoffTitle(): string {
		const status = currentPageTranslationHandoff?.status ?? "draft";
		if (status === "translated") return $_("workBoard.translatorSentToTypeset");
		if (status === "needs_translation") return $_("workBoard.translatorNeedsMore");
		return translatedScriptCount ? $_("workBoard.translatorHasDraft") : $_("workBoard.translatorNoScript");
	}

	function translatorHandoffDetail(): string {
		const status = currentPageTranslationHandoff?.status ?? "draft";
		if (status === "translated") return $_("workBoard.translatorDetailTranslated");
		if (status === "needs_translation") return $_("workBoard.translatorDetailNeedsTranslation");
		return translatedScriptCount
			? $_("workBoard.translatorDetailHasDraft")
			: $_("workBoard.translatorDetailEmpty");
	}

	function markCurrentPageCleanRecheck(status: "verified" | "needs_adjustment"): void {
		if (!projectStore.project) return;
		projectStore.updatePageTypesetCleanRecheck(projectStore.project.currentPage, status, productionActorHandle(selectedProductionRoleId));
		if (status === "needs_adjustment") selectedProductionRoleId = "typesetter";
	}

	async function updateCurrentPageQcHandoff(status: PageQcHandoffStatus): Promise<void> {
		const previousStatus = currentPageQcHandoff?.status ?? "pending";
		projectStore.updateCurrentPageQcHandoff(status, productionActorHandle("qc"));
		if (previousStatus === status) return;
		try {
			await projectStore.saveState();
		} catch {
			// saveState owns the visible recovery message and save-error state.
		}
	}

	function updateCreditPolicy(policy: CreditPolicy): void {
		projectStore.updateCreditPolicy(policy);
	}

	async function reconcileCompletedWorkflowTasks(): Promise<void> {
		if (!completedTaskReconciliation.taskIds.length) return;
		const shouldRouteFinalQc = completedTaskReconciliation.reviewNeedsFinalQcCount > 0;
		const nextFinalQcPageIndex = shouldRouteFinalQc
			? projectStore.tasks.find((task) =>
				completedTaskReconciliation.taskIds.includes(task.id)
				&& task.type === "review"
				&& qcHandoffStatusForPage(projectStore.project?.pages[task.pageIndex]) !== "ready"
			)?.pageIndex ?? null
			: null;
		await projectStore.bulkUpdateTaskStatus(completedTaskReconciliation.taskIds, "done");
		if (!shouldRouteFinalQc) return;
		if (typeof nextFinalQcPageIndex === "number") {
			await ensurePageSelected(nextFinalQcPageIndex);
		}
		const qcRole = PRODUCTION_ROLE_CARDS.find((card) => card.id === "qc");
		if (qcRole) selectProductionRole(qcRole);
		projectStore.setStatusMsg($_("workBoard.reviewClosedThenQc", { values: { n: (nextFinalQcPageIndex ?? projectStore.project?.currentPage ?? 0) + 1 } }));
	}

	function updateTranslatorDraft(slot: TranslationScriptSlot, value: string): void {
		projectStore.updateCurrentPageTranslationScriptSlot({
			...slot,
			translatedText: value,
			updatedAt: new Date().toISOString(),
		}, productionActorHandle("translator"));
	}

	function updateTranslatorSlotLabel(slot: TranslationScriptSlot, value: string): void {
		projectStore.updateCurrentPageTranslationScriptSlot({
			...slot,
			label: value.trim() || $_("workBoard.translationSlot"),
			updatedAt: new Date().toISOString(),
		}, productionActorHandle("translator"));
	}

	function selectTranslatorScriptSlot(slotId: string): void {
		activeTranslatorScriptSlotId = slotId;
	}

	function moveActiveTranslatorScriptSlot(event: MouseEvent): void {
		if (!translatorBenchPreview?.previewUrl) return;
		const slot = activeTranslatorScriptSlot;
		if (!slot) return;
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const clientX = event.clientX || rect.left + rect.width / 2;
		const clientY = event.clientY || rect.top + rect.height / 2;
		const x = Math.round(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
		const y = Math.round(Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100)));
		projectStore.updateCurrentPageTranslationScriptSlot({
			...slot,
			x,
			y,
			updatedAt: new Date().toISOString(),
		}, productionActorHandle("translator"));
	}

	function addTranslatorScriptSlot(): void {
		const pageIndex = projectStore.project?.currentPage ?? 0;
		const existingIds = new Set(translatorScriptSlots.map((slot) => slot.id));
		let ordinal = translatorScriptSlots.length + 1;
		let id = `custom-${pageIndex}-${ordinal}`;
		while (existingIds.has(id)) {
			ordinal += 1;
			id = `custom-${pageIndex}-${ordinal}`;
		}
		projectStore.updateCurrentPageTranslationScriptSlot({
			id,
			label: $_("workBoard.translationSlotN", { values: { n: ordinal } }),
			x: 50,
			y: 50,
			category: "dialogue",
			translatedText: "",
			updatedAt: new Date().toISOString(),
		}, productionActorHandle("translator"));
		activeTranslatorScriptSlotId = id;
	}

	function deleteTranslatorScriptSlot(slot: TranslationScriptSlot): void {
		projectStore.deleteCurrentPageTranslationScriptSlot(slot.id, productionActorHandle("translator"));
		if (activeTranslatorScriptSlotId === slot.id) activeTranslatorScriptSlotId = null;
	}

	function textLayerForTranslationSlot(slot: TranslationScriptSlot): TextLayer | null {
		return currentPageTypesetLayers.find((layer) => layer.sourceProvider === `translation-slot:${slot.id}`) ?? null;
	}

	function translationSlotIdFromProvider(layer: TextLayer): string | null {
		const prefix = "translation-slot:";
		return layer.sourceProvider?.startsWith(prefix) ? layer.sourceProvider.slice(prefix.length) : null;
	}

	function translationSlotIdsForPage(page: Page | undefined): string[] {
		return (page?.translationScriptSlots ?? []).map((slot) => slot.id);
	}

	function validTranslationSlotLayerCount(page: Page): number {
		const slotIds = translationSlotIdsForPage(page);
		return page.textLayers.filter((layer) => {
			const slotId = translationSlotIdFromProvider(layer);
			return Boolean(slotId && slotIds.includes(slotId));
		}).length;
	}

	function translatedScriptSlotIdsForPage(page: Page | undefined): Set<string> {
		return new Set((page?.translationScriptSlots ?? [])
			.filter((slot) => slot.translatedText.trim())
			.map((slot) => slot.id));
	}

	function validTranslatedSlotLayerCount(page: Page): number {
		const slotIds = translatedScriptSlotIdsForPage(page);
		return page.textLayers.filter((layer) => {
			const slotId = translationSlotIdFromProvider(layer);
			return Boolean(slotId && slotIds.has(slotId));
		}).length;
	}

	function missingTranslatedSlotLayerCount(page: Page): number {
		return Math.max(0, translatedScriptSlotCountForPage(page) - validTranslatedSlotLayerCount(page));
	}

	function staleTranslatedSlotLayerCountForPage(page: Page): number {
		const slotsById = new Map((page.translationScriptSlots ?? [])
			.filter((slot) => slot.translatedText.trim())
			.map((slot) => [slot.id, slot]));
		return page.textLayers.filter((layer) => {
			const slotId = translationSlotIdFromProvider(layer);
			const slot = slotId ? slotsById.get(slotId) : null;
			return Boolean(slot && translationSlotLayerSyncState(slot, layer) === "stale");
		}).length;
	}

	function qcHandoffStatusForPage(page: Page | undefined): PageQcHandoffStatus {
		return page?.qcHandoff?.status ?? "pending";
	}

	function latestReviewDecisionForPage(pageIndex: number) {
		return [...projectStore.reviewDecisions]
			.filter((decision) => decision.pageIndex === pageIndex)
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
	}

	function pageHasApprovedReviewDecision(pageIndex: number): boolean {
		return latestReviewDecisionForPage(pageIndex)?.status === "approved";
	}

	function pageReadyForReviewApproval(page: Page, pageIndex: number, orphanSlotLayerCount = orphanedTranslationSlotLayersForPage(page).length): boolean {
		const hasQcBlockers = projectStore.comments.some((comment) => comment.pageIndex === pageIndex && comment.status === "open")
			|| projectStore.tasks.some((task) => task.pageIndex === pageIndex && task.type === "review" && task.status !== "done")
			|| projectStore.qcReport.issues.some((issue) => issue.pageIndex === pageIndex && issue.severity !== "info")
			|| projectStore.aiReviewMarkers.some((marker) => marker.pageIndex === pageIndex && marker.status !== "applied");
		const translatedCount = translatedScriptSlotCountForPage(page);
		return page.cleaningHandoff?.status === "clean_ready"
			&& page.translationHandoff?.status === "translated"
			&& translatedCount > 0
			&& validTranslatedSlotLayerCount(page) >= translatedCount
			&& staleTranslatedSlotLayerCountForPage(page) === 0
			&& orphanSlotLayerCount === 0
			&& page.cleaningHandoff?.typesetRecheckStatus === "verified"
			&& !hasQcBlockers;
	}

	function pageNeedsReviewApprovalBeforeFinalQc(page: Page, pageIndex: number, orphanSlotLayerCount = orphanedTranslationSlotLayersForPage(page).length): boolean {
		return pageReadyForReviewApproval(page, pageIndex, orphanSlotLayerCount)
			&& !pageHasApprovedReviewDecision(pageIndex);
	}

	function pageReadyForFinalQc(page: Page, pageIndex: number, orphanSlotLayerCount = orphanedTranslationSlotLayersForPage(page).length): boolean {
		return pageReadyForReviewApproval(page, pageIndex, orphanSlotLayerCount)
			&& pageHasApprovedReviewDecision(pageIndex);
	}

	function orphanedTranslationSlotLayersForPage(page: Page | undefined): TextLayer[] {
		if (!page) return [];
		const slotIds = translationSlotIdsForPage(page);
		return page.textLayers.filter((layer) => {
			const slotId = translationSlotIdFromProvider(layer);
			return Boolean(slotId && !slotIds.includes(slotId));
		});
	}

	function translationSlotLayerSyncState(slot: TranslationScriptSlot, layer: TextLayer): TranslationSlotLayerSyncState {
		return (
			layer.text === slot.translatedText
			&& (layer.name ?? "") === slot.label
			&& (layer.sourceText ?? "") === (slot.sourceText ?? "")
			&& layer.sourceCategory === slot.category
		) ? "synced" : "stale";
	}

	function translationSlotLayerSyncLabel(state: TranslationSlotLayerSyncState): string {
		return state === "synced"
			? $_("workBoard.syncMatchesLatest")
			: $_("workBoard.syncScriptChanged");
	}

	function typesetLayerOpenActionLabel(): string {
		return $_("workBoard.openBoxPage", { values: { page: currentPageLabel } });
	}

	function typesetLayerOpenActionAria(slotOrLayer: TranslationScriptSlot | TextLayer): string {
		const name = "label" in slotOrLayer ? slotOrLayer.label : (slotOrLayer.name || slotOrLayer.id);
		return $_("workBoard.openBoxAria", { values: { name, page: currentPageLabel, lang: currentPageLanguageLabel } });
	}

	function typesetLayerCreateActionLabel(): string {
		return $_("workBoard.createBoxPage", { values: { page: currentPageLabel } });
	}

	function typesetLayerCreateActionAria(slot: TranslationScriptSlot): string {
		return $_("workBoard.createBoxAria", { values: { name: slot.label, page: currentPageLabel, lang: currentPageLanguageLabel } });
	}

	function createTextLayerFromTranslationSlot(slot: TranslationScriptSlot): void {
		const layer = projectStore.createTextLayerFromCurrentPageTranslationScriptSlot(slot.id, productionActorHandle("typesetter"));
		if (layer) {
			ensureLiveEditorHasTextLayer(layer);
			openTextLayerInEditor(layer.id);
		}
	}

	function updateTextLayerFromTranslationSlot(slot: TranslationScriptSlot): void {
		const layer = projectStore.updateTextLayerFromCurrentPageTranslationScriptSlot(slot.id, productionActorHandle("typesetter"));
		if (!layer) return;
		syncLiveEditorTextLayerFromProject(layer);
	}

	function unlinkOrphanTypesetLayer(layer: TextLayer): void {
		const nextLayer = projectStore.unlinkCurrentPageTranslationTextLayer(layer.id, productionActorHandle("typesetter"));
		if (!nextLayer) return;
		syncLiveEditorTextLayerFromProject(nextLayer);
	}

	function openTextLayerInEditor(layerId: string): void {
		const layer = currentPageTypesetLayers.find((item) => item.id === layerId);
		if (layer) ensureLiveEditorHasTextLayer(layer);
		editorUiStore.openEditor();
		editorUiStore.focusTextInspector(layerId);
	}

	function ensureLiveEditorHasTextLayer(layer: TextLayer): void {
		if (!editorStore.editor || typeof editorStore.editor.addTextLayer !== "function") return;
		const existingLayers = editorStore.editor.getAllTextLayers?.() ?? editorStore.textLayers;
		if (Array.isArray(existingLayers) && existingLayers.some((item: TextLayer) => item.id === layer.id)) return;
		if (typeof editorStore.editor.addTextLayerWithHistory === "function") {
			editorStore.editor.addTextLayerWithHistory(layer);
		} else {
			editorStore.editor.addTextLayer(layer);
		}
		editorStore.refreshTextLayers();
	}

	function syncLiveEditorTextLayerFromProject(layer: TextLayer): void {
		if (!editorStore.editor || typeof editorStore.editor.updateTextLayer !== "function") return;
		const existingLayers = editorStore.editor.getAllTextLayers?.() ?? editorStore.textLayers;
		if (!Array.isArray(existingLayers) || !existingLayers.some((item: TextLayer) => item.id === layer.id)) return;
		const update = {
			name: layer.name,
			text: layer.text,
			sourceText: layer.sourceText,
			sourceCategory: layer.sourceCategory,
			sourceProvider: layer.sourceProvider,
		};
		if (typeof editorStore.editor.updateTextLayerWithHistory === "function") {
			editorStore.editor.updateTextLayerWithHistory(layer.id, update);
		} else {
			editorStore.editor.updateTextLayer(layer.id, update);
		}
		editorStore.refreshTextLayers();
	}

	function workItemRouteLabel(item: WorkInboxItem | TaskFocusItem | null): string {
		if (!item) return $_("workBoard.noBlockingUrgent");
		return item.pageIndex === undefined ? $_("workBoard.wholeChapter") : $_("workBoard.pageN", { values: { n: item.pageIndex + 1 } });
	}

	function clampPercent(value: number, min = 0, max = 100): number {
		if (!Number.isFinite(value)) return min;
		return Math.min(max, Math.max(min, value));
	}

	function formatPercent(value: number): string {
		return `${Math.round(value * 10) / 10}%`;
	}

	function aiMarkerForItem(item: WorkInboxItem | TaskFocusItem | null): AiReviewMarker | null {
		if (item?.kind !== "ai_marker") return null;
		return projectStore.aiReviewMarkers.find((marker) => marker.id === item.sourceId) ?? null;
	}

	function markerRegionStyle(marker: AiReviewMarker, previewImageId: string | null): string | null {
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

	function buildBlockerVisualPreview(item: WorkInboxItem | TaskFocusItem | null): BlockerVisualPreview | null {
		if (!projectStore.project || !item || item.pageIndex === undefined) return null;
		const page = projectStore.project.pages[item.pageIndex];
		const marker = aiMarkerForItem(item);
		const previewImageId = page ? getPagePreviewImageId(page, projectStore.localImageUrls) : marker?.imageId ?? null;
		const failureKey = previewImageId ? `${projectStore.project.projectId}:${previewImageId}` : null;
		const previewUrl = previewImageId && !(failureKey && blockerPreviewFailures[failureKey])
			? projectStore.getImageUrl(previewImageId)
			: null;
		return {
			pageLabel: $_("workBoard.pageN", { values: { n: item.pageIndex + 1 } }),
			title: isAiPlacementItem(item) ? $_("workBoard.aiAreaApproved") : $_("workBoard.workAreaOnPage"),
			detail: isAiPlacementItem(item) ? $_("workBoard.waitPlaceAsLayer") : workItemDisplayTitle(item),
			previewUrl,
			// Signed assetToken for the backend preview <img> (blob: previews pass
			// through the action unchanged).
			previewParams: previewUrl && previewImageId
				? { projectId: projectStore.project.projectId, imageId: previewImageId, url: previewUrl, purpose: "editor_preview" }
				: null,
			imageName: page?.originalName || page?.imageName || previewImageId || $_("workBoard.pageN", { values: { n: item.pageIndex + 1 } }),
			regionStyle: marker ? markerRegionStyle(marker, previewImageId) : null,
		};
	}

	function buildTranslatorBenchPreview(): { pageLabel: string; imageName: string; previewUrl: string | null; previewParams: SignedAssetSrcParams | null } | null {
		if (!projectStore.project) return null;
		const pageIndex = projectStore.project.currentPage;
		const page = projectStore.project.pages[pageIndex];
		if (!page) return null;
		const previewImageId = getPagePreviewImageId(page, projectStore.localImageUrls);
		const previewUrl = previewImageId ? projectStore.getImageUrl(previewImageId) : null;
		return {
			pageLabel: $_("workBoard.pageN", { values: { n: pageIndex + 1 } }),
			imageName: page.originalName || page.imageName || previewImageId || $_("workBoard.pageN", { values: { n: pageIndex + 1 } }),
			previewUrl,
			previewParams: previewUrl && previewImageId
				? { projectId: projectStore.project.projectId, imageId: previewImageId, url: previewUrl, purpose: "editor_preview" }
				: null,
		};
	}

	function buildTranslatorScriptSlots(): Array<TranslationScriptSlot & { placeholder: string }> {
		const page = projectStore.project?.pages[projectStore.project.currentPage];
		// Only show the real slots the translator placed on THIS page. No seeded
		// sample pins/cards — an empty page shows an honest "add a slot" empty state.
		return (page?.translationScriptSlots ?? []).map((slot) => ({
			...slot,
			placeholder: translatorScriptSlotPlaceholder(slot.category),
		}));
	}

	function buildCreditLayerSummary(): CreditLayerSummary {
		const summary: CreditLayerSummary = {
			currentText: 0,
			currentImage: 0,
			chapterText: 0,
			chapterImage: 0,
		};
		const project = projectStore.project;
		if (!project) return summary;
		project.pages.forEach((page, index) => {
			const textCount = page.textLayers.filter((layer) => layer.sourceCategory === "credit").length;
			const imageCount = (page.imageLayers ?? []).filter((layer) => layer.role === "credit").length;
			summary.chapterText += textCount;
			summary.chapterImage += imageCount;
			if (index === project.currentPage) {
				summary.currentText = textCount;
				summary.currentImage = imageCount;
			}
		});
		return summary;
	}

	function translatedScriptSlotCountForPage(page: Page | undefined): number {
		return (page?.translationScriptSlots ?? []).filter((slot) => slot.translatedText.trim()).length;
	}

	function buildPageProductionSummary(page: Page, pageIndex: number): PageProductionSummary {
		const cleaningHandoff = page.cleaningHandoff;
		const cleanStatus = cleaningHandoff?.status ?? "raw";
		const translationStatus = page.translationHandoff?.status ?? "draft";
		const translatedCount = translatedScriptSlotCountForPage(page);
		const translatedScriptReady = translatedCount > 0;
		const translatedLayerCount = validTranslatedSlotLayerCount(page);
		const missingTranslatedLayerCount = missingTranslatedSlotLayerCount(page);
		const staleTranslatedLayerCount = staleTranslatedSlotLayerCountForPage(page);
		const orphanSlotLayerCount = orphanedTranslationSlotLayersForPage(page).length;
		const recheckStatus = cleaningHandoff?.typesetRecheckStatus;
		const qcHandoffStatus = qcHandoffStatusForPage(page);
		const openCommentCount = projectStore.comments.filter((comment) => comment.pageIndex === pageIndex && comment.status === "open").length;
		const openReviewTaskCount = projectStore.tasks.filter((task) => task.pageIndex === pageIndex && task.type === "review" && task.status !== "done").length;
		const qcIssueCount = projectStore.qcReport.issues.filter((issue) => issue.pageIndex === pageIndex && issue.severity !== "info").length;
		const qcCount = openCommentCount + openReviewTaskCount + qcIssueCount;
		const needsReviewApproval = pageNeedsReviewApprovalBeforeFinalQc(page, pageIndex, orphanSlotLayerCount);
		const readyForFinalQc = pageReadyForFinalQc(page, pageIndex, orphanSlotLayerCount);
		const imageName = page.originalName || page.imageName || $_("workBoard.pageN", { values: { n: pageIndex + 1 } });

		let nextRoleId: ProductionRoleCard["id"] | null = null;
		let nextRoleLabel = $_("workBoard.readyToHandoff");
		if (cleanStatus !== "clean_ready") {
			nextRoleId = "cleaner";
			nextRoleLabel = cleanStatus === "needs_clean" ? $_("workBoard.cleanerFix") : $_("workBoard.roleCleanerTitle");
		} else if (translationStatus !== "translated" || !translatedScriptReady) {
			nextRoleId = "translator";
			nextRoleLabel = translationStatus === "needs_translation"
				? $_("workBoard.translatorFix")
				: translationStatus === "translated" && !translatedScriptReady ? $_("workBoard.translatorAddScript") : $_("workBoard.roleTranslatorTitle");
		} else if (orphanSlotLayerCount > 0 || staleTranslatedLayerCount > 0 || missingTranslatedLayerCount > 0 || recheckStatus === "needs_adjustment") {
			nextRoleId = "typesetter";
			nextRoleLabel = orphanSlotLayerCount > 0
				? $_("workBoard.typesetterClearMissing")
				: recheckStatus === "needs_adjustment" ? $_("workBoard.typesetterFixPosition") : $_("workBoard.roleTypesetterTitle");
		} else if (recheckStatus !== "verified" || qcCount > 0) {
			nextRoleId = "qc";
			nextRoleLabel = recheckStatus === "verified" ? $_("workBoard.roleQcTitle") : $_("workBoard.qcCheckClean");
		} else if (needsReviewApproval) {
			nextRoleId = "qc";
			nextRoleLabel = $_("workBoard.qcCheckPage");
		} else if (readyForFinalQc && qcHandoffStatus !== "ready") {
			nextRoleId = "qc";
			nextRoleLabel = qcHandoffStatus === "needs_fix" ? $_("workBoard.qcFix") : $_("workBoard.qcClosePage");
		}
		const typesetLabel = orphanSlotLayerCount
			? $_("workBoard.boxesScriptMissing", { values: { n: orphanSlotLayerCount } })
			: staleTranslatedLayerCount
				? $_("workBoard.boxesNeedSync", { values: { n: staleTranslatedLayerCount } })
			: missingTranslatedLayerCount
				? $_("workBoard.slotsNotTypeset", { values: { n: missingTranslatedLayerCount } })
				: translatedLayerCount
				? recheckStatus === "verified"
					? $_("workBoard.cleanChecked")
					: recheckStatus === "needs_adjustment"
						? $_("workBoard.needPositionFix")
						: $_("workBoard.waitCleanCheck")
				: $_("workBoard.waitTypeset");
		const typesetTone: ProductionPageTone = orphanSlotLayerCount || recheckStatus === "needs_adjustment"
			? "warn"
			: staleTranslatedLayerCount
				? "warn"
			: missingTranslatedLayerCount
				? "warn"
				: translatedLayerCount
				? recheckStatus === "verified" ? "ready" : "raw"
				: "raw";

		return {
			pageIndex,
			pageLabel: `P${pageIndex + 1}`,
			imageName,
			cleanLabel: cleanStatus === "clean_ready" ? $_("workBoard.cleanReady") : cleanStatus === "needs_clean" ? $_("workBoard.cleanFix") : "raw",
			cleanTone: cleanStatus === "clean_ready" ? "ready" : cleanStatus === "needs_clean" ? "warn" : "raw",
			translatorLabel: translationStatus === "translated"
				? translatedScriptReady ? $_("workBoard.slotsReadyToSend", { values: { n: translatedCount } }) : $_("workBoard.noScriptReady")
				: translationStatus === "needs_translation"
					? $_("workBoard.translatorNeedsMore")
					: translatedCount
						? $_("workBoard.slotsDraft", { values: { n: translatedCount } })
						: $_("workBoard.waitTranslate"),
			translatorTone: translationStatus === "translated" && translatedScriptReady ? "ready" : translationStatus === "needs_translation" || translatedCount || translationStatus === "translated" ? "warn" : "raw",
			typesetLabel,
			typesetTone,
			qcLabel: qcCount
				? $_("workBoard.pendingCheck", { values: { n: qcCount } })
				: needsReviewApproval
					? $_("workBoard.awaitingReviewResult")
				: readyForFinalQc
					? qcHandoffStatus === "ready"
						? $_("workBoard.qcClosed")
						: qcHandoffStatus === "needs_fix" ? $_("workBoard.sentBackToFix") : $_("workBoard.waitQcClose")
					: $_("workBoard.notAtQcYet"),
			qcTone: qcCount || needsReviewApproval || (readyForFinalQc && qcHandoffStatus !== "ready") ? "warn" : readyForFinalQc ? "ready" : "raw",
			nextRoleId,
			nextRoleLabel,
		};
	}

	function buildPageProductionSummaries(): PageProductionSummary[] {
		const project = projectStore.project;
		if (!project) return [];
		return project.pages.slice(0, 8).map((page, pageIndex) => buildPageProductionSummary(page, pageIndex));
	}

	function buildCurrentPageProductionHandoff(): PageProductionSummary | null {
		const project = projectStore.project;
		if (!project) return null;
		const page = project.pages[project.currentPage];
		return page ? buildPageProductionSummary(page, project.currentPage) : null;
	}

	function needsCleanTypesetRecheck(pageIndex: number | null): boolean {
		const project = projectStore.project;
		if (!project || pageIndex === null) return false;
		const page = project.pages[pageIndex];
		if (!page) return false;
		const recheckStatus = page.cleaningHandoff?.typesetRecheckStatus ?? "pending";
		return page.cleaningHandoff?.status === "clean_ready"
			&& page.textLayers.some((layer) => layer.sourceProvider?.startsWith("translation-slot:"))
			&& recheckStatus === "pending";
	}

	function buildCompletedTaskReconciliation(): CompletedTaskReconciliation {
		const empty: CompletedTaskReconciliation = {
			taskIds: [],
			translateCount: 0,
			cleanCount: 0,
			typesetCount: 0,
			reviewCount: 0,
			reviewNeedsFinalQcCount: 0,
		};
		const project = projectStore.project;
		if (!project) return empty;
		const summary = { ...empty };
		for (const task of projectStore.tasks) {
			if (task.status === "done") continue;
			const page = project.pages[task.pageIndex];
			if (!page) continue;
			if (pageBackedTaskComplete(task, page)) {
				summary.taskIds.push(task.id);
				if (task.type === "translate") summary.translateCount += 1;
				if (task.type === "clean") summary.cleanCount += 1;
				if (task.type === "typeset") summary.typesetCount += 1;
				if (task.type === "review") {
					summary.reviewCount += 1;
					if (!soloWorkspace && qcHandoffStatusForPage(page) !== "ready") {
						summary.reviewNeedsFinalQcCount += 1;
					}
				}
			}
		}
		return summary;
	}

	function pageBackedTaskComplete(task: WorkflowTask, page: Page): boolean {
		if (task.type === "translate") {
			return page.translationHandoff?.status === "translated"
				&& translatedScriptSlotCountForPage(page) > 0;
		}
		if (task.type === "clean") return page.cleaningHandoff?.status === "clean_ready";
		if (task.type === "typeset") {
			return translatedScriptSlotCountForPage(page) > 0
				&& missingTranslatedSlotLayerCount(page) === 0
				&& staleTranslatedSlotLayerCountForPage(page) === 0
				&& orphanedTranslationSlotLayersForPage(page).length === 0
				&& page.cleaningHandoff?.typesetRecheckStatus === "verified";
		}
		if (task.type === "review") return reviewPageStateClear(task.pageIndex);
		return false;
	}

	function reviewPageStateClear(pageIndex: number): boolean {
		const latestDecision = latestReviewDecisionForPage(pageIndex);
		if (latestDecision?.status !== "approved") return false;
		const openComments = projectStore.comments.some((comment) => comment.pageIndex === pageIndex && comment.status === "open");
		const openQcIssues = projectStore.qcReport.issues.some((issue) => issue.pageIndex === pageIndex && issue.severity !== "info");
		const openAiMarkers = projectStore.aiReviewMarkers.some((marker) => marker.pageIndex === pageIndex && marker.status !== "applied");
		return !openComments && !openQcIssues && !openAiMarkers;
	}

	function buildMainProjectHandoffSummary(): MainProjectHandoffSummary {
		const project = projectStore.project;
		if (!project) {
			return {
				ready: false,
				title: $_("workBoard.noChapterOpenTitle"),
				detail: $_("workBoard.noChapterMainHandoffDetail"),
				action: $_("workBoard.selectChapter"),
				nextRoleId: null,
				nextPageIndex: null,
				cleanLabel: $_("workBoard.noPagesYet"),
				cleanTone: "raw",
				typesetLabel: $_("workBoard.noPagesYet"),
				typesetTone: "raw",
				qcLabel: $_("workBoard.noPagesYet"),
				qcTone: "raw",
				creditLabel: $_("workBoard.noCreditYet"),
				creditTone: "raw",
			};
		}
		const pageCount = project.pages.length;
		const cleanBlocked = project.pages
			.map((page, pageIndex) => ({ page, pageIndex }))
			.filter(({ page }) => (page.cleaningHandoff?.status ?? "raw") !== "clean_ready");
		const translationBlocked = project.pages
			.map((page, pageIndex) => ({ page, pageIndex }))
			.filter(({ page }) =>
				(page.cleaningHandoff?.status ?? "raw") === "clean_ready"
				&& ((page.translationHandoff?.status ?? "draft") !== "translated" || translatedScriptSlotCountForPage(page) === 0),
			);
		const translatedButNotTypeset = project.pages
			.map((page, pageIndex) => ({ page, pageIndex }))
			.filter(({ page }) =>
				page.translationHandoff?.status === "translated"
				&& translatedScriptSlotCountForPage(page) > 0
				&& (missingTranslatedSlotLayerCount(page) > 0 || staleTranslatedSlotLayerCountForPage(page) > 0)
				&& orphanedTranslationSlotLayersForPage(page).length === 0,
			);
		const orphanTypesetLinks = project.pages
			.map((page, pageIndex) => ({ page, pageIndex }))
			.filter(({ page }) =>
				orphanedTranslationSlotLayersForPage(page).length > 0,
			);
		const needsTypesetAdjustment = project.pages
			.map((page, pageIndex) => ({ page, pageIndex }))
			.filter(({ page }) =>
				page.textLayers.some((layer) => layer.sourceProvider?.startsWith("translation-slot:"))
				&& page.cleaningHandoff?.typesetRecheckStatus === "needs_adjustment",
			);
		const pendingCleanRecheck = project.pages
			.map((page, pageIndex) => ({ page, pageIndex }))
			.filter(({ page }) =>
				page.textLayers.some((layer) => layer.sourceProvider?.startsWith("translation-slot:"))
				&& page.cleaningHandoff?.status === "clean_ready"
				&& page.cleaningHandoff?.typesetRecheckStatus !== "verified",
			);
		const qcBlockerPageIndexes = [
			...projectStore.comments.filter((comment) => comment.status === "open").map((comment) => comment.pageIndex),
			...projectStore.tasks.filter((task) => task.type === "review" && task.status !== "done").map((task) => task.pageIndex),
			...projectStore.qcReport.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.pageIndex),
			...projectStore.aiReviewMarkers.filter((marker) => marker.status !== "applied").map((marker) => marker.pageIndex),
		].filter((pageIndex): pageIndex is number => pageIndex !== undefined && Boolean(project.pages[pageIndex]));
		const qcBlockerCount = qcBlockerPageIndexes.length;
		const finalQcBlocked = project.pages
			.map((page, pageIndex) => ({ page, pageIndex }))
			.filter(({ page, pageIndex }) =>
				pageReadyForFinalQc(page, pageIndex)
				&& qcHandoffStatusForPage(page) !== "ready",
			);
		const reviewApprovalBlocked = project.pages
			.map((page, pageIndex) => ({ page, pageIndex }))
			.filter(({ page, pageIndex }) =>
				pageNeedsReviewApprovalBeforeFinalQc(page, pageIndex)
				&& qcHandoffStatusForPage(page) !== "ready",
			);
		const creditCount = creditLayerSummary.chapterText + creditLayerSummary.chapterImage;
		const creditBlocked = creditRequired && creditCount === 0;
		const ready = cleanBlocked.length === 0
			&& translationBlocked.length === 0
			&& translatedButNotTypeset.length === 0
			&& orphanTypesetLinks.length === 0
			&& needsTypesetAdjustment.length === 0
			&& pendingCleanRecheck.length === 0
			&& qcBlockerCount === 0
			&& reviewApprovalBlocked.length === 0
			&& finalQcBlocked.length === 0
			&& !creditBlocked;
		const nextClean = cleanBlocked[0];
		const nextTranslation = translationBlocked[0];
		const nextOrphanTypeset = orphanTypesetLinks[0];
		const nextAdjustment = needsTypesetAdjustment[0];
		const nextTypeset = translatedButNotTypeset[0];
		const nextRecheck = pendingCleanRecheck[0];
		const nextReviewApproval = reviewApprovalBlocked[0];
		const nextFinalQc = finalQcBlocked[0];
		const nextRoleId: ProductionRoleCard["id"] | null = nextClean
			? "cleaner"
			: nextTranslation
				? "translator"
				: nextOrphanTypeset || nextAdjustment || nextTypeset
					? "typesetter"
					: nextRecheck || qcBlockerCount > 0 || nextReviewApproval || nextFinalQc || creditBlocked
						? "qc"
						: null;
		const nextPageIndex = nextClean?.pageIndex
			?? nextTranslation?.pageIndex
			?? nextOrphanTypeset?.pageIndex
			?? nextAdjustment?.pageIndex
			?? nextTypeset?.pageIndex
			?? nextRecheck?.pageIndex
			?? qcBlockerPageIndexes[0]
			?? nextReviewApproval?.pageIndex
			?? nextFinalQc?.pageIndex
			?? (creditBlocked ? project.currentPage : null)
			?? null;
		const blockerCount = cleanBlocked.length + translationBlocked.length + translatedButNotTypeset.length + orphanTypesetLinks.length + needsTypesetAdjustment.length + pendingCleanRecheck.length + qcBlockerCount + reviewApprovalBlocked.length + finalQcBlocked.length + (creditBlocked ? 1 : 0);
		const action = ready
			? $_("workBoard.mainActionGoExport")
			: nextRoleId === "cleaner"
				? $_("workBoard.goToRole", { values: { role: $_("workBoard.roleCleanerTitle") } })
				: nextRoleId === "translator"
					? $_("workBoard.goToRole", { values: { role: $_("workBoard.roleTranslatorTitle") } })
					: nextRoleId === "typesetter"
						? $_("workBoard.goToRole", { values: { role: $_("workBoard.roleTypesetterTitle") } })
						: creditBlocked
							? $_("workBoard.mainActionGoCredit")
						: qcBlockerCount > 0
							? $_("workBoard.mainActionGoQc")
							: nextRecheck
								? $_("workBoard.mainActionGoCleanCheck")
								: nextReviewApproval
									? $_("workBoard.mainActionGoReviewPage")
									: nextFinalQc
										? $_("workBoard.mainActionGoCloseQc")
										: nextRoleId === "qc"
											? $_("workBoard.mainActionGoQc")
											: $_("workBoard.mainActionGoNext");
		const typesetLabel = needsTypesetAdjustment.length
			? $_("workBoard.pagesFixPosition", { values: { n: needsTypesetAdjustment.length } })
			: orphanTypesetLinks.length
				? $_("workBoard.pagesScriptMissing", { values: { n: orphanTypesetLinks.length } })
				: translationBlocked.length
					? $_("workBoard.pagesWaitTranslate", { values: { n: translationBlocked.length } })
					: translatedButNotTypeset.length
						? $_("workBoard.pagesWaitTypeset", { values: { n: translatedButNotTypeset.length } })
						: pendingCleanRecheck.length
							? $_("workBoard.pagesWaitCleanCheck", { values: { n: pendingCleanRecheck.length } })
							: $_("workBoard.typesetOverClean");

		return {
			ready,
			title: ready ? $_("workBoard.readyToReturnMain") : $_("workBoard.blockersBeforeReturnMain", { values: { n: blockerCount } }),
			detail: ready
				? $_("workBoard.allPagesDoneDetail", { values: { n: pageCount } })
				: $_("workBoard.clearBelowFirst"),
			action,
			nextRoleId,
			nextPageIndex,
			cleanLabel: cleanBlocked.length ? $_("workBoard.pagesNotClean", { values: { n: cleanBlocked.length } }) : $_("workBoard.pagesCleanReady", { values: { n: pageCount } }),
			cleanTone: cleanBlocked.length ? "warn" : "ready",
			typesetLabel,
			typesetTone: needsTypesetAdjustment.length || orphanTypesetLinks.length || translationBlocked.length || translatedButNotTypeset.length || pendingCleanRecheck.length ? "warn" : "ready",
			qcLabel: qcBlockerCount
				? $_("workBoard.qcTasksPending", { values: { n: qcBlockerCount } })
				: reviewApprovalBlocked.length ? $_("workBoard.pagesAwaitReview", { values: { n: reviewApprovalBlocked.length } })
					: finalQcBlocked.length ? $_("workBoard.pagesAwaitQcClose", { values: { n: finalQcBlocked.length } }) : $_("workBoard.qcAllClosed"),
			qcTone: qcBlockerCount || reviewApprovalBlocked.length || finalQcBlocked.length ? "warn" : "ready",
			creditLabel: creditCount ? $_("workBoard.creditsInChapter", { values: { n: creditCount } }) : creditRequired ? $_("workBoard.exportNeedsCredit") : $_("workBoard.draftOptional"),
			creditTone: creditCount ? "ready" : creditRequired ? "warn" : "raw",
		};
	}

	function countStaleTypesetSlots(): number {
		return translatorScriptSlots.filter((slot) => {
			const layer = textLayerForTranslationSlot(slot);
			return layer && translationSlotLayerSyncState(slot, layer) === "stale";
		}).length;
	}

	function countTypesetSlotLayers(): number {
		return translatorScriptSlots.filter((slot) => slot.translatedText.trim() && textLayerForTranslationSlot(slot)).length;
	}

	function typesetTruthStatusLabel(): string {
		if (orphanTypesetLayerCount) return $_("workBoard.boxesScriptMissing", { values: { n: orphanTypesetLayerCount } });
		if (staleTypesetSlotCount) return $_("workBoard.boxesNeedSync", { values: { n: staleTypesetSlotCount } });
		if (!translatedScriptCount) return $_("workBoard.noTypesetScript");
		if (missingTypesetSlotCount) return $_("workBoard.slotsNotTypeset", { values: { n: missingTypesetSlotCount } });
		return $_("workBoard.matchesScript");
	}

	function getLatestCurrentPageReviewDecision() {
		return [...projectStore.currentPageReviewDecisions]
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
	}

	function reviewDecisionStatusLabel(): string {
		if (!latestReviewDecision) return $_("workBoard.noPageReviewYet");
		return latestReviewDecision.status === "approved" ? $_("workBoard.latestApproved") : $_("workBoard.latestSentBack");
	}

	function finalQcStatusLabel(): string {
		if (currentPageQcHandoff?.status === "ready") return $_("workBoard.qcClosed");
		if (currentPageQcHandoff?.status === "needs_fix") return $_("workBoard.reopenToCheck");
		return $_("workBoard.waitQcClose");
	}

	function finalQcStatusDetail(): string {
		if (currentPageQcHandoff?.status === "ready") return $_("workBoard.qcReadyDetail");
		if (currentPageQcHandoff?.status === "needs_fix") return $_("workBoard.qcReopenedDetail");
		return $_("workBoard.qcFinalStepDetail");
	}

	function currentPageNeedsReviewApprovalBeforeFinalQc(): boolean {
		if (!projectStore.project) return false;
		const pageIndex = projectStore.project.currentPage;
		const page = projectStore.project.pages[pageIndex];
		return page ? pageNeedsReviewApprovalBeforeFinalQc(page, pageIndex) : false;
	}

	function finalQcReviewApprovalDetail(): string {
		if (!latestReviewDecision) return $_("workBoard.qcNoApprovalDetail");
		return $_("workBoard.qcReviewSentBackDetail");
	}

	function finalQcCanCloseCurrentPage(): boolean {
		if (!projectStore.project) return false;
		const pageIndex = projectStore.project.currentPage;
		const page = projectStore.project.pages[pageIndex];
		return page ? pageReadyForFinalQc(page, pageIndex) : false;
	}

	function cleanHandoffStatusLabel(): string {
		if (currentPageCleaningHandoff?.status === "clean_ready") return $_("workBoard.cleanImageReady");
		if (currentPageCleaningHandoff?.status === "needs_clean") return $_("workBoard.needsMoreClean");
		return $_("workBoard.stillRaw");
	}

	function cleanHandoffImpactTitle(): string {
		if (currentPageCleaningHandoff?.status === "clean_ready") return $_("workBoard.cleanImpactReadyTitle");
		if (currentPageCleaningHandoff?.status === "needs_clean") return $_("workBoard.cleanImpactNeedsTitle");
		return $_("workBoard.cleanImpactRawTitle");
	}

	function cleanHandoffImpactDetail(): string {
		if (currentPageCleaningHandoff?.status === "clean_ready") return $_("workBoard.cleanImpactReadyDetail");
		if (currentPageCleaningHandoff?.status === "needs_clean") return $_("workBoard.cleanImpactNeedsDetail");
		return $_("workBoard.cleanImpactRawDetail");
	}

	function cleanHandoffProofLabel(): string {
		if (currentPageCleaningHandoff?.proofKind === "brush-edited-layer") return currentPageCleaningHandoff.proofLabel ?? $_("workBoard.hasBrushProof");
		if (currentPageCleaningHandoff?.proofKind === "no-clean-needed") return $_("workBoard.confirmNoClean");
		if (currentPageCleanBrushProof) return currentPageCleanBrushProof.name || currentPageCleanBrushProof.originalName || currentPageCleanBrushProof.imageName || $_("workBoard.hasBrushMark");
		return $_("workBoard.noBrushProof");
	}

	function typesetterCleanReadinessTone(): "ready" | "warn" | "raw" {
		if (currentPageCleaningHandoff?.typesetRecheckStatus === "needs_adjustment") return "warn";
		if (currentPageCleaningHandoff?.status === "clean_ready") return "ready";
		if (currentPageCleaningHandoff?.status === "needs_clean") return "warn";
		return "raw";
	}

	function typesetterCleanReadinessTitle(): string {
		if (currentPageCleaningHandoff?.typesetRecheckStatus === "verified") return $_("workBoard.typesetReadinessVerifiedTitle");
		if (currentPageCleaningHandoff?.typesetRecheckStatus === "needs_adjustment") return $_("workBoard.typesetReadinessAdjustTitle");
		if (currentPageCleaningHandoff?.status === "clean_ready") return $_("workBoard.typesetReadinessCleanTitle");
		if (currentPageCleaningHandoff?.status === "needs_clean") return $_("workBoard.typesetReadinessNeedsCleanTitle");
		return $_("workBoard.typesetReadinessRawTitle");
	}

	function typesetterCleanReadinessDetail(): string {
		if (currentPageCleaningHandoff?.typesetRecheckStatus === "verified") return $_("workBoard.typesetReadinessVerifiedDetail");
		if (currentPageCleaningHandoff?.typesetRecheckStatus === "needs_adjustment") return $_("workBoard.typesetReadinessAdjustDetail");
		if (currentPageCleaningHandoff?.status === "clean_ready") return $_("workBoard.typesetReadinessCleanDetail");
		if (currentPageCleaningHandoff?.status === "needs_clean") return $_("workBoard.typesetReadinessNeedsCleanDetail");
		return $_("workBoard.typesetReadinessRawDetail");
	}

	function translationSlotCleanContextLabel(existingTextLayer: TextLayer | null): string {
		if (!existingTextLayer) {
			return currentPageCleaningHandoff?.status === "clean_ready" ? $_("workBoard.createOnCleanReady") : $_("workBoard.createFromRaw");
		}
		if (currentPageCleaningHandoff?.typesetRecheckStatus === "verified") return $_("workBoard.cleanChecked");
		if (currentPageCleaningHandoff?.typesetRecheckStatus === "needs_adjustment") return $_("workBoard.typesetReadinessAdjustTitle");
		if (currentPageCleaningHandoff?.status === "clean_ready") return $_("workBoard.checkedSentToQc");
		return $_("workBoard.recheckWhenCleanReady");
	}

	function creditSummaryLabel(): string {
		const current = creditLayerSummary.currentText + creditLayerSummary.currentImage;
		const chapter = creditLayerSummary.chapterText + creditLayerSummary.chapterImage;
		const policy = exportCreditSummaryPolicyLabel(creditPolicy);
		return $_("workBoard.creditSummary", { values: { current, chapter, policy } });
	}

	function creditPolicyDetail(): string {
		const chapter = creditLayerSummary.chapterText + creditLayerSummary.chapterImage;
		return workboardCreditPolicyDetail(creditPolicy, chapter);
	}

	function qcPrimaryTitle(): string {
		if (!qcPrimaryCommand?.item) return $_("workBoard.qcQueueClear");
		return workItemDisplayTitle(qcPrimaryCommand.item);
	}

	function qcPrimaryDetail(): string {
		if (!qcPrimaryCommand?.item) return $_("workBoard.qcNothingToDecide");
		return `${qcPrimaryCommand.label} · ${workItemRouteLabel(qcPrimaryCommand.item)} · ${qcPrimaryCommand.detail}`;
	}

	function qcPrimaryActionLabel(): string {
		if (qcPrimaryCommand?.item && isAiPlacementItem(qcPrimaryCommand.item)) return $_("workBoard.placeAiLayer");
		return $_("workBoard.checkThisWork");
	}

	function markBlockerPreviewFailed(preview: BlockerVisualPreview): void {
		if (!projectStore.project || !preview.previewUrl) return;
		const page = topBlockerItem?.pageIndex === undefined ? null : projectStore.project.pages[topBlockerItem.pageIndex];
		const previewImageId = page ? getPagePreviewImageId(page, projectStore.localImageUrls) : null;
		if (!previewImageId) return;
		blockerPreviewFailures = {
			...blockerPreviewFailures,
			[`${projectStore.project.projectId}:${previewImageId}`]: true,
		};
	}

	function roleNextDetail(item: TaskFocusItem | null): string {
		if (!item) return $_("workBoard.noBacklogInChapter", { values: { mode: selectedWorkModeLabel() } });
		const parts = [
			workItemRouteLabel(item),
			workflowStatusDisplay(item.status ?? "open"),
			workBoardAssigneeLabel(item.assignee),
		];
		if (item.priority && item.priority !== "normal") parts.push(workBoardPriorityLabel(item.priority));
		return parts.join(" / ");
	}

	function selectedRolePageStateRoleIds(): ProductionRoleCard["id"][] {
		if (soloWorkspace) return [];
		if (selectedProductionRoleId) return [selectedProductionRoleId];
		// No preset gate any more: surface the next page-state work across every
		// production role so the full per-page detail stays visible.
		return PRODUCTION_ROLE_CARDS.map((card) => card.id);
	}

	function pageStateRoleTitle(roleId: ProductionRoleCard["id"], pageIndex: number): string {
		const pageLabel = $_("workBoard.pageN", { values: { n: pageIndex + 1 } });
		if (roleId === "cleaner") return $_("workBoard.cleanImagePage", { values: { page: pageLabel } });
		if (roleId === "translator") return $_("workBoard.translatePage", { values: { page: pageLabel } });
		if (roleId === "typesetter") return $_("workBoard.typesetPage", { values: { page: pageLabel } });
		if (roleId === "qc") return $_("workBoard.checkPage", { values: { page: pageLabel } });
		return $_("workBoard.openPage", { values: { page: pageLabel } });
	}

	function buildSelectedRolePageStateNext(): PageStateRoleNextWork | null {
		const project = projectStore.project;
		if (!project || soloWorkspace || selectedRoleNextItem) return null;
		for (const roleId of selectedRolePageStateRoleIds()) {
			for (let pageIndex = 0; pageIndex < project.pages.length; pageIndex += 1) {
				const summary = buildPageProductionSummary(project.pages[pageIndex], pageIndex);
				if (summary.nextRoleId !== roleId) continue;
				return {
					pageIndex,
					roleId,
					title: pageStateRoleTitle(roleId, pageIndex),
					detail: $_("workBoard.fromPageStateDetail", { values: { name: summary.imageName, next: summary.nextRoleLabel } }),
					action: $_("workBoard.openPageN", { values: { n: pageIndex + 1 } }),
				};
			}
		}
		return null;
	}

	function roleNextHeading(): string {
		if (selectedRoleNextItem && topBlockerItem?.id === selectedRoleNextItem.id) return $_("workBoard.fixToUnblockExport");
		if (topBlockerItem) return $_("workBoard.nextAfterBlocker");
		if (selectedRolePageStateNext) return $_("workBoard.workFromPageState");
		return $_("workBoard.modeNextWork", { values: { mode: selectedWorkModeLabel() } });
	}

	function workItemDisplayTitle(item: WorkInboxItem | TaskFocusItem | null): string {
		if (!item) return $_("workBoard.queueClear");
		const workflowType = "workflowType" in item ? item.workflowType : projectStore.tasks.find((task) => task.id === item.sourceId)?.type;
		const page = workItemRouteLabel(item);
		// CODE-BASED routing (no Thai string-matching): inbox/focus items now carry a
		// stable `titleCode` + `workflowType`, so we branch on those discriminants.
		// The returned display strings are localized via $_().
		if (item.kind === "comment") return $_("workBoard.readNotePage", { values: { page } });
		if (isAiPlacementItem(item)) return $_("workBoard.placeAiLayerPage", { values: { page } });
		if (item.kind === "ai_marker" && item.titleCode === "ai_rerun") return $_("workBoard.checkAiRerunPage", { values: { page } });
		if (item.kind === "ai_marker") return $_("workBoard.checkAiPage", { values: { page } });
		if (workflowType === "translate") return $_("workBoard.translatePage", { values: { page } });
		if (workflowType === "clean") return $_("workBoard.cleanImagePage", { values: { page } });
		if (workflowType === "typeset") return $_("workBoard.typesetPage", { values: { page } });
		if (workflowType === "review") return $_("workBoard.checkPage", { values: { page } });
		// Fallback: compose the localized title straight from the structured fields
		// (handles QC items and custom workflow titles).
		return workInboxTitle(item, $_);
	}

	function isAiPlacementItem(item: WorkInboxItem | TaskFocusItem | null): boolean {
		const marker = aiMarkerForItem(item);
		return Boolean(marker && isAiResultPlacementOrRecoveryNeeded(projectStore.project, marker));
	}

	function workPrimaryActionLabel(item: WorkInboxItem | TaskFocusItem | null): string {
		return isAiPlacementItem(item) ? $_("workBoard.placeAiLayer") : $_("workBoard.doThisWork");
	}

	function workItemCanvasActionLabel(item: WorkInboxItem | TaskFocusItem | null): string {
		if (!item) return $_("workBoard.viewPage");
		if (item.pageIndex === undefined) return $_("workBoard.viewWholeChapter");
		return $_("workBoard.viewPageN", { values: { n: item.pageIndex + 1 } });
	}

	function assignedGroupCanvasActionLabel(group: WorkspaceAssignedWorkGroup | null): string {
		if (!group || group.firstOpenPageIndex === null) return $_("workBoard.viewQueue");
		return $_("workBoard.viewPageN", { values: { n: group.firstOpenPageIndex + 1 } });
	}

	function roleNextPrimaryAction(): string {
		if (selectedRoleNextItem && topBlockerItem?.id === selectedRoleNextItem.id) return $_("workBoard.fixThisWork");
		return $_("workBoard.doThisWork");
	}

	function roleNextCanvasAction(): string {
		if (selectedRoleNextItem?.pageIndex !== undefined) {
			return selectedRoleNextItem && topBlockerItem?.id === selectedRoleNextItem.id
				? $_("workBoard.fixPageN", { values: { n: selectedRoleNextItem.pageIndex + 1 } })
				: $_("workBoard.openPageN", { values: { n: selectedRoleNextItem.pageIndex + 1 } });
		}
		if (selectedRoleNextItem && topBlockerItem?.id === selectedRoleNextItem.id) return $_("workBoard.fixWork");
		return $_("workBoard.openWork");
	}

	function openCurrentPageActionLabel(): string {
		if (!projectStore.project) return $_("workBoard.openPageEdit");
		if (!hasProjectPages) return $_("workBoard.zeroPagesCta");
		return $_("workBoard.openPageN", { values: { n: projectStore.project.currentPage + 1 } });
	}

	function selectedWorkModeLabel(): string {
		if (!soloWorkspace && selectedProductionRoleId) {
			return PRODUCTION_ROLE_CARDS.find((card) => card.id === selectedProductionRoleId)?.title ?? $_("workBoard.workQueue");
		}
		return soloWorkspace ? $_("workBoard.yourWorkQueue") : $_("workBoard.teamWorkQueue");
	}

	function workBoardAssigneeLabel(value: string | null | undefined, fallback = $_("workBoard.noAssigneeYet")): string {
		if (!value) return fallback;
		const normalized = value.trim().replace(/^@/, "");
		const lower = normalized.toLowerCase();
		if (!lower) return fallback;
		if (lower === "local-user") return $_("workBoard.you");
		if (lower === "solo") return soloWorkspace ? $_("workBoard.soloMode") : $_("workBoard.awaitTeamSplit");
		if (lower === "qa" || lower === "qc") return lower.toUpperCase();
		return formatAssigneeHandle(normalized);
	}

	function workBoardPriorityLabel(value: string): string {
		if (value === "urgent") return $_("workBoard.priorityUrgent");
		if (value === "high") return $_("workBoard.priorityHigh");
		if (value === "medium") return $_("workBoard.priorityMedium");
		if (value === "low") return $_("workBoard.priorityLow");
		return value;
	}

	function workflowStatusDisplay(value: string): string {
		const labels: Record<string, string> = {
			todo: $_("workBoard.statusTodo"),
			doing: $_("workBoard.statusDoing"),
			review: $_("workBoard.statusReview"),
			done: $_("workBoard.statusDone"),
			open: $_("workBoard.statusOpen"),
		};
		return labels[value] ?? value;
	}

	function blockerOwnerLabel(item: WorkInboxItem | TaskFocusItem | null): string {
		if (!item) return $_("workBoard.cleared");
		return workBoardAssigneeLabel(item.assignee, $_("workBoard.mustAssign"));
	}

	async function focusPrimaryOwner(): Promise<void> {
		if (!primaryOwnerGroup) return;
		await focusAssignedGroup(primaryOwnerGroup);
	}

	async function openPrimaryOwner(): Promise<void> {
		if (!primaryOwnerGroup) return;
		await openAssignedGroup(primaryOwnerGroup);
	}

	async function focusUnassigned(): Promise<void> {
		if (!unassignedGroup) return;
		await focusAssignedGroup(unassignedGroup);
	}

	async function focusTopBlocker(): Promise<void> {
		if (!topBlockerItem) return;
		if (await openAiPlacementItem(topBlockerItem)) return;
		const selected = await selectInboxItem(topBlockerItem);
		if (!selected) return;
		openFocus(topBlockerItem.id);
	}

	async function openTopBlocker(): Promise<void> {
		if (!topBlockerItem) return;
		await openInboxItemInEditor(topBlockerItem);
	}

	function openLibrary(): void {
		editorUiStore.openLibrary();
		queueWorkspaceNavigation({ view: "library" });
	}

	function openPages(): void {
		if (!projectStore.project) return;
		editorUiStore.openPages();
		queueWorkspaceNavigation({ view: "pages", projectId: projectStore.project.projectId });
	}

	// Zero-page recovery routes through the SAME setup flow every other
	// zero-page entry point uses (sidebar/dashboard): the chapter-setup dialog
	// in fill-existing mode actually attaches page images; the Import/Review
	// surface is for TEXT import and would dead-end the user (codex P2).
	function openZeroPageSetup(): void {
		editorUiStore.openChapterSetup({
			mode: "fill-existing-zero-page",
			projectId: projectStore.project?.projectId ?? "",
			titleKey: editorUiStore.workspaceTitleKey,
		});
	}

	function openImportReview(): void {
		if (!projectStore.project) return;
		editorUiStore.openImportReview();
		queueWorkspaceNavigation({ view: "import", projectId: projectStore.project.projectId });
	}

	function currentCanvasPageIndex(): number | undefined {
		if (projectStore.project?.pages[projectStore.project.currentPage]) return projectStore.project.currentPage;
		return undefined;
	}

	function openCanvas(pageIndex = currentCanvasPageIndex()): void {
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project?.projectId,
			pageIndex,
		});
	}

	async function openAiPlacementItem(item: WorkInboxItem | TaskFocusItem | null): Promise<boolean> {
		if (!projectStore.project) return false;
		const marker = aiMarkerForItem(item);
		if (!marker || !isAiResultPlacementOrRecoveryNeeded(projectStore.project, marker)) return false;
		if (!projectStore.project.pages[marker.pageIndex]) return selectInboxMissingPageRepair(item as WorkInboxItem);
		const opened = await ensurePageSelected(marker.pageIndex);
		if (!opened) return false;
		projectStore.selectAiReviewMarker(marker.id);
		projectStore.selectWorkflowTask(null);
		projectStore.selectProjectComment(null);
		projectStore.selectQcIssue(null);
		editorStore.editor?.focusImageRegion?.(marker.region);
		editorUiStore.setRightPanelMode("layers");
		openCanvas(marker.pageIndex);
		projectStore.setStatusMsg(marker.status === "applied" ? $_("workBoard.statusAiRecoveryOpened") : $_("workBoard.statusAiPlacementOpened"));
		return true;
	}

	// Focus mode was removed; "open this task" now opens the editor with the
	// already-selected item showing in the contextual Work panel. Callers select
	// the item first (selectInboxItem / selectWorkflowTask …) so this only has to
	// open the canvas for the current/target page.
	function openFocus(_itemId?: string | null): void {
		editorUiStore.setRightPanelMode("work");
		openCanvas();
	}

	function openCurrentPageReviewInFocus(): void {
		if (projectStore.project) {
			const task = projectStore.ensurePageReviewTask(projectStore.project.currentPage);
			projectStore.selectWorkflowTask(task?.id ?? null);
		}
		openFocus();
	}

	function focusHrefForItem(item: TaskFocusItem | WorkInboxItem | null): string | null {
		if (!projectStore.project || !item) return null;
		return buildWorkspaceHref({
			view: "work",
			projectId: projectStore.project.projectId,
		});
	}

	async function copyFocusLinkForItem(item: TaskFocusItem | WorkInboxItem | null): Promise<void> {
		const href = focusHrefForItem(item);
		if (!href) return;
		const link = typeof window === "undefined" ? href : new URL(href, window.location.origin).href;
		try {
			await navigator.clipboard?.writeText(link);
			projectStore.setStatusMsg($_("workBoard.statusWorkLinkCopied"));
		} catch {
			projectStore.setStatusMsg(`Work link: ${link}`);
		}
	}

	function chooseWorkspaceMode(mode: "solo" | "team"): void {
		editorUiStore.setWorkspaceMode(mode);
		projectStore.updateProductionMode(mode);
		if (mode === "solo") {
			selectedProductionRoleId = null;
		} else {
			selectedProductionRoleId ??= "cleaner";
		}
	}

	function productionRoleTitle(id: ProductionRoleCard["id"]): string {
		return PRODUCTION_ROLE_CARDS.find((card) => card.id === id)?.title ?? $_("workBoard.teamProduction");
	}

	async function ensurePageSelected(pageIndex: number): Promise<boolean> {
		if (!projectStore.project) return false;
		if (projectStore.project.currentPage === pageIndex) return true;
		const pageOpened = await projectStore.goToPage(pageIndex, editorStore.editor);
		if (!pageOpened) return false;
		editorStore.refreshTextLayers();
		return true;
	}

	async function openSelectedRolePageStateNext(): Promise<void> {
		if (!selectedRolePageStateNext) return;
		const opened = await ensurePageSelected(selectedRolePageStateNext.pageIndex);
		if (!opened) return;
		const nextRole = PRODUCTION_ROLE_CARDS.find((card) => card.id === selectedRolePageStateNext?.roleId);
		if (nextRole) selectProductionRole(nextRole);
		projectStore.setStatusMsg($_("workBoard.titleFromPageState", { values: { title: selectedRolePageStateNext.title } }));
	}

	function inboxItemSourceExists(item: WorkInboxItem): boolean {
		if (item.kind === "comment") return projectStore.comments.some((comment) => comment.id === item.sourceId);
		if (item.kind === "ai_marker") return projectStore.aiReviewMarkers.some((marker) => marker.id === item.sourceId);
		if (item.kind === "workflow_task" || item.kind === "review_task") return projectStore.tasks.some((task) => task.id === item.sourceId);
		if (item.kind === "qc") return projectStore.qcReport.issues.some((issue) => issue.id === item.sourceId);
		return true;
	}

	function inboxItemMissingSourceStatus(item: WorkInboxItem): string {
		if (item.kind === "comment") return $_("workBoard.noteGone");
		if (item.kind === "ai_marker") return $_("workBoard.aiMarkerGone");
		if (item.kind === "workflow_task" || item.kind === "review_task") return $_("workBoard.taskGone");
		if (item.kind === "qc") return $_("workBoard.qcItemCleared");
		return $_("workBoard.taskGone");
	}

	function selectInboxMissingPageRepair(item: WorkInboxItem): boolean {
		if (item.kind === "comment") {
			projectStore.selectProjectComment(item.sourceId);
			projectStore.selectWorkflowTask(null);
			projectStore.selectAiReviewMarker(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("workBoard.notePageGone"));
			return true;
		}
		if (item.kind === "workflow_task" || item.kind === "review_task") {
			projectStore.selectWorkflowTask(item.sourceId);
			projectStore.selectAiReviewMarker(null);
			projectStore.selectProjectComment(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("workBoard.taskPageGone"));
			return true;
		}
		if (item.kind === "ai_marker") {
			projectStore.selectAiReviewMarker(item.sourceId);
			projectStore.selectWorkflowTask(null);
			projectStore.selectProjectComment(null);
			projectStore.selectQcIssue(null);
			editorUiStore.setRightPanelMode("work");
			projectStore.setStatusMsg($_("workBoard.aiMarkerPageGone"));
			return true;
		}
		projectStore.setStatusMsg(item.pageIndex === undefined ? $_("workBoard.thisTaskPageGone") : $_("workBoard.taskPageNGone", { values: { n: item.pageIndex + 1 } }));
		return false;
	}

	function inboxItemHasMissingPage(item: WorkInboxItem): boolean {
		return Boolean(projectStore.project && item.pageIndex !== undefined && !projectStore.project.pages[item.pageIndex]);
	}

	function canvasPageForInboxItem(item: WorkInboxItem): number | undefined {
		if (projectStore.project && item.pageIndex !== undefined && projectStore.project.pages[item.pageIndex]) return item.pageIndex;
		return currentCanvasPageIndex();
	}

	function selectMissingPageTaskRepair(taskId: string | null): boolean {
		if (!taskId) return false;
		projectStore.selectWorkflowTask(taskId);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectProjectComment(null);
		projectStore.selectQcIssue(null);
		editorUiStore.setRightPanelMode("work");
		projectStore.setStatusMsg($_("workBoard.taskPageGone"));
		return true;
	}

	async function selectInboxItem(item: WorkInboxItem): Promise<boolean> {
		if (!inboxItemSourceExists(item)) {
			projectStore.setStatusMsg(inboxItemMissingSourceStatus(item));
			return false;
		}
		if (projectStore.project && item.pageIndex !== undefined && !projectStore.project.pages[item.pageIndex]) {
			return selectInboxMissingPageRepair(item);
		}
		if (item.pageIndex !== undefined && projectStore.project?.currentPage !== item.pageIndex) {
			const pageOpened = await ensurePageSelected(item.pageIndex);
			if (!pageOpened) return false;
		}

		projectStore.selectAiReviewMarker(item.kind === "ai_marker" ? item.sourceId : null);
		projectStore.selectProjectComment(item.kind === "comment" ? item.sourceId : null);
		projectStore.selectWorkflowTask(
			item.kind === "workflow_task" || item.kind === "review_task" ? item.sourceId : null,
		);
		projectStore.selectQcIssue(item.kind === "qc" ? item.sourceId : null);
		editorUiStore.setRightPanelMode("work");
		return true;
	}

	async function focusInboxItem(item: WorkInboxItem): Promise<void> {
		const selected = await selectInboxItem(item);
		if (!selected) return;
		if (inboxItemHasMissingPage(item)) {
			openCanvas(canvasPageForInboxItem(item));
			return;
		}
		openFocus(item.id);
	}

	async function openInboxItemInEditor(item: WorkInboxItem): Promise<void> {
		const selected = await selectInboxItem(item);
		if (!selected) return;
		openCanvas(canvasPageForInboxItem(item));
	}

	async function focusReviewCommand(command: ReviewCommand): Promise<void> {
		if (!command.item) return;
		const selected = await selectInboxItem(command.item);
		if (!selected) return;
		if (inboxItemHasMissingPage(command.item)) {
			openCanvas(canvasPageForInboxItem(command.item));
			return;
		}
		openFocus(command.item.id);
	}

	async function focusSelectedRoleNext(): Promise<void> {
		if (!selectedRoleNextItem) return;
		const selected = await selectInboxItem(selectedRoleNextItem);
		if (!selected) return;
		if (inboxItemHasMissingPage(selectedRoleNextItem)) {
			openCanvas(canvasPageForInboxItem(selectedRoleNextItem));
			return;
		}
		openFocus(selectedRoleNextItem.id);
	}

	async function openSelectedRoleNextInEditor(): Promise<void> {
		if (!selectedRoleNextItem) return;
		await openInboxItemInEditor(selectedRoleNextItem);
	}

	async function openReviewCommandInEditor(command: ReviewCommand): Promise<void> {
		if (!command.item) return;
		await openInboxItemInEditor(command.item);
	}

	async function focusQcPrimaryCommand(): Promise<void> {
		if (!qcPrimaryCommand?.item) return;
		if (await openAiPlacementItem(qcPrimaryCommand.item)) return;
		await focusReviewCommand(qcPrimaryCommand);
	}

	async function openQcPrimaryCommandInEditor(): Promise<void> {
		if (!qcPrimaryCommand?.item) return;
		if (await openAiPlacementItem(qcPrimaryCommand.item)) return;
		await openReviewCommandInEditor(qcPrimaryCommand);
	}

	function openCreditWorkflow(): void {
		if (!projectStore.project) return;
		openCanvas(projectStore.project.currentPage);
		editorUiStore.focusCreditTools();
		projectStore.setStatusMsg($_("workBoard.statusCreditToolsOpened"));
	}

	async function focusAssignedGroup(group: WorkspaceAssignedWorkGroup): Promise<void> {
		// "ทำคิวแรก/ทำคิวนี้/เปิดคิวงาน": select the group's first OPEN task and open it
		// on its own page. (Focus mode was removed; this opens the editor work panel on
		// the correct page+task instead of leaving the user on the current page.)
		await openAssignedGroup(group);
	}

	async function openAssignedGroup(group: WorkspaceAssignedWorkGroup): Promise<void> {
		if (!projectStore.project || group.firstOpenPageIndex === null) return;
		if (!projectStore.project.pages[group.firstOpenPageIndex]) {
			if (selectMissingPageTaskRepair(group.firstOpenTaskId)) {
				openCanvas(projectStore.project.currentPage);
			}
			return;
		}
		const pageOpened = await ensurePageSelected(group.firstOpenPageIndex);
		if (!pageOpened) return;
		projectStore.selectWorkflowTask(group.firstOpenTaskId);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectProjectComment(null);
		projectStore.selectQcIssue(null);
		editorUiStore.setRightPanelMode("work");
		openCanvas(group.firstOpenPageIndex);
	}

	async function openJobLane(lane: WorkspaceJobLane): Promise<void> {
		if (!projectStore.project || lane.firstOpenPageIndex === null) return;
		if (!projectStore.project.pages[lane.firstOpenPageIndex]) {
			if (selectMissingPageTaskRepair(lane.firstOpenTaskId)) {
				openCanvas(projectStore.project.currentPage);
			}
			return;
		}
		const pageOpened = await ensurePageSelected(lane.firstOpenPageIndex);
		if (!pageOpened) return;
		projectStore.selectWorkflowTask(lane.firstOpenTaskId);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectProjectComment(null);
		projectStore.selectQcIssue(null);
		editorUiStore.setRightPanelMode("work");
		openCanvas(lane.firstOpenPageIndex);
	}
</script>

{#if editorUiStore.workspaceView === "work"}
	<section class="ws-surface workspace-work-shell" aria-label={$_("workBoard.boardAria")}>
		<div class="ws-surface-inner">
		<WorkspaceTopUtilityBar />
		<header class="work-top">
			<div class="work-title">
				<span>{soloWorkspace ? $_("workBoard.workThisChapter") : $_("workBoard.production")}</span>
				<h1>{projectStore.project?.name ?? $_("workBoard.chapterWork")}</h1>
				{#if projectStore.project && hasProjectPages}
					<p>
						{$_("workBoard.topSummary", { values: { open: workspaceStats.openTaskCount, urgent: inboxSummary.totalCount, lanes: activeLaneCount } })}
					</p>
				{:else if !projectStore.project}
					<p>
						{$_("workBoard.openChapterTopHint")}
					</p>
				{/if}
			</div>
			<div class="work-actions">
				{#if projectStore.project}
					<button
						type="button"
						class:primary={!topBlockerItem || !hasProjectPages}
						onclick={() => hasProjectPages ? openCanvas() : openZeroPageSetup()}
					>
						{openCurrentPageActionLabel()}
					</button>
				{:else}
					<span class="action-receipt">{$_("workBoard.openChapterToEdit")}</span>
				{/if}
				<details class="work-route-menu">
					<summary>{$_("workBoard.goElsewhere")}</summary>
					<div>
						<button type="button" onclick={openLibrary}>{$_("workBoard.library")}</button>
						{#if projectStore.project}
							<button type="button" onclick={openPages}>{$_("workBoard.checkPages")}</button>
							<button type="button" onclick={openImportReview}>{$_("workBoard.importText")}</button>
						{:else}
							<span class="action-receipt">{$_("workBoard.openChapterToCheck")}</span>
							<span class="action-receipt">{$_("workBoard.openChapterToImport")}</span>
						{/if}
						{#if projectStore.project && taskFocusItems.length}
							<button type="button" onclick={() => openFocus()}>{$_("workBoard.viewBacklog")}</button>
						{:else if projectStore.project}
							<span class="action-receipt ready">{$_("workBoard.noBacklog")}</span>
						{:else}
							<span class="action-receipt">{$_("workBoard.openChapterForBacklog")}</span>
						{/if}
					</div>
				</details>
			</div>
		</header>

		{#if projectStore.project && !hasProjectPages}
			<section class="work-empty-pages" aria-label={$_("workBoard.zeroPagesAria")}>
				<div>
					<span>{$_("workBoard.zeroPagesEyebrow")}</span>
					<h2>{$_("workBoard.zeroPagesTitle")}</h2>
					<p>{$_("workBoard.zeroPagesDetail")}</p>
				</div>
				<button type="button" class="primary" onclick={openZeroPageSetup}>{$_("workBoard.zeroPagesCta")}</button>
			</section>
		{:else}
		<section class={`chapter-readiness ${chapterReadiness.tone}`} aria-label={$_("workBoard.exportReadinessAria")}>
			<div>
				<span>{$_("workBoard.exportStatus")}</span>
				<strong>{chapterReadiness.title}</strong>
				<small>{chapterReadiness.detail}</small>
			</div>
			{#if projectStore.project}
				<button
					type="button"
					class:primary={!topBlockerItem}
					onclick={() => topBlockerItem ? void focusTopBlocker() : selectedRoleNextItem ? void focusSelectedRoleNext() : openCanvas()}
				>
					{chapterReadiness.action}
				</button>
			{:else}
				<span class="action-receipt">{$_("workBoard.openChapterForStatus")}</span>
			{/if}
		</section>

		<CollabSubmitBar />

		<section class="work-mode-owner-strip" aria-label={$_("workBoard.workModeAria")}>
			<div>
				<span>{$_("workBoard.workMode")}</span>
				<strong>{soloWorkspace ? $_("workBoard.soloMode2") : $_("workBoard.teamProduction")}</strong>
				<small>{workModeDetail}</small>
			</div>
			<div class="work-mode-toggle" role="group" aria-label={$_("workBoard.toggleWorkModeAria")}>
				<button
					type="button"
					class:active={soloWorkspace}
					aria-pressed={soloWorkspace}
					onclick={() => chooseWorkspaceMode("solo")}
				>
					<strong>{$_("workBoard.soloMode2")}</strong>
					<small>{$_("workBoard.soloModeSub")}</small>
				</button>
				<button
					type="button"
					class:active={!soloWorkspace}
					aria-pressed={!soloWorkspace}
					onclick={() => chooseWorkspaceMode("team")}
				>
					<strong>{$_("workBoard.teamProduction")}</strong>
					<small>{$_("workBoard.teamModeSub")}</small>
				</button>
			</div>
		</section>

		{#if showSoloBlockerStrip && topBlockerItem}
			<SoloBlockerStrip
				topBlockerItem={topBlockerItem}
				topBlockerVisual={topBlockerVisual}
				workItemDisplayTitle={workItemDisplayTitle}
				workItemRouteLabel={workItemRouteLabel}
				blockerOwnerLabel={blockerOwnerLabel}
				workPrimaryActionLabel={workPrimaryActionLabel}
				workItemCanvasActionLabel={workItemCanvasActionLabel}
				onFocusTopBlocker={() => void focusTopBlocker()}
				onOpenTopBlocker={() => void openTopBlocker()}
				onCopyFocusLink={(item) => void copyFocusLinkForItem(item)}
				onMarkBlockerPreviewFailed={markBlockerPreviewFailed}
			/>
		{/if}

		<div class="work-kpis compact" aria-label={$_("workBoard.boardSummaryAria")}>
			<span>{$_("workBoard.openTasksN", { values: { n: workspaceStats.openTaskCount } })}</span>
			<span>{$_("workBoard.blockerCountStuck", { values: { n: inboxSummary.blockerCount } })}</span>
			<span>{$_("workBoard.reviewCount", { values: { n: focusSummary.reviewCount } })}</span>
			<span>{$_("workBoard.overdueCount", { values: { n: workspaceStats.overdueTaskCount } })}</span>
		</div>

		{#if !soloWorkspace}
			<ProductionRoleMap
				productionRoleCards={PRODUCTION_ROLE_CARDS}
				selectedProductionRoleId={selectedProductionRoleId}
				currentPageProductionHandoff={currentPageProductionHandoff}
				currentPageIndex={projectStore.project?.currentPage ?? null}
				pageProductionSummaries={pageProductionSummaries}
				pageProductionOverflowCount={pageProductionOverflowCount}
				mainProjectHandoff={mainProjectHandoff}
				completedTaskReconciliation={completedTaskReconciliation}
				productionRoleCount={productionRoleCount}
				productionRoleButtonLabel={productionRoleButtonLabel}
				currentPageHandoffActionLabel={currentPageHandoffActionLabel()}
				productionPageOpenLabel={productionPageOpenLabel}
				onSelectProductionRole={selectProductionRole}
				onOpenCurrentPageProductionHandoff={openCurrentPageProductionHandoff}
				onSelectProductionPage={(summary) => void selectProductionPage(summary)}
				onOpenMainProjectHandoff={() => void openMainProjectHandoff()}
				onReconcileCompletedWorkflowTasks={() => void reconcileCompletedWorkflowTasks()}
			/>
		{/if}

		{#if showCleanerHandoffBench}
			<CleanerHandoffBench
				currentPageLabel={currentPageLabel}
				currentPageName={currentPageName}
				currentPageCleaningHandoff={currentPageCleaningHandoff}
				currentPageCleanBrushProof={currentPageCleanBrushProof}
				cleanHandoffImpactTitle={cleanHandoffImpactTitle()}
				cleanHandoffImpactDetail={cleanHandoffImpactDetail()}
				cleanHandoffProofLabel={cleanHandoffProofLabel()}
				onMarkCleanReady={(proofKind) => updateCleanerHandoff("clean_ready", proofKind)}
				onMarkNeedsClean={() => updateCleanerHandoff("needs_clean")}
				cleanRoundtripBusy={projectStore.cleanRoundtripBusy}
				onExportOriginals={(scope) => void projectStore.exportOriginalsForCleaning(
					scope === "current" && projectStore.project ? [projectStore.project.currentPage] : undefined,
				)}
				onImportCleaned={(files) => void projectStore.importCleanedPages(files, editorStore.editor)}
			/>
		{/if}

		{#if showTranslatorScriptBench}
			<TranslatorScriptBench
				currentPageLabel={currentPageLabel}
				currentPageLanguageLabel={currentPageLanguageLabel}
				currentPageTranslationHandoff={currentPageTranslationHandoff}
				translatorBenchPreview={translatorBenchPreview}
				translatorScriptSlots={translatorScriptSlots}
				translatedScriptCount={translatedScriptCount}
				activeTranslatorScriptSlot={activeTranslatorScriptSlot}
				translatorHandoffTitle={translatorHandoffTitle()}
				translatorHandoffDetail={translatorHandoffDetail()}
				onUpdateTranslatorHandoff={updateTranslatorHandoff}
				onSendTranslatorHandoff={sendTranslatorHandoff}
				onMoveActiveTranslatorScriptSlot={moveActiveTranslatorScriptSlot}
				onSelectTranslatorScriptSlot={selectTranslatorScriptSlot}
				onAddTranslatorScriptSlot={addTranslatorScriptSlot}
				onUpdateTranslatorSlotLabel={updateTranslatorSlotLabel}
				onUpdateTranslatorDraft={updateTranslatorDraft}
				onDeleteTranslatorScriptSlot={deleteTranslatorScriptSlot}
			/>
		{/if}

		{#if showTypesetterScriptBench}
			<TypesetterScriptBench
				currentPageLabel={currentPageLabel}
				currentPageLanguageLabel={currentPageLanguageLabel}
				currentPageCleaningHandoff={currentPageCleaningHandoff}
				translatorScriptSlots={translatorScriptSlots}
				currentPageOrphanedTypesetLayers={currentPageOrphanedTypesetLayers}
				typesetterCleanReadinessTone={typesetterCleanReadinessTone()}
				typesetterCleanReadinessTitle={typesetterCleanReadinessTitle()}
				typesetterCleanReadinessDetail={typesetterCleanReadinessDetail()}
				textLayerForTranslationSlot={textLayerForTranslationSlot}
				translationSlotLayerSyncState={translationSlotLayerSyncState}
				translationSlotLayerSyncLabel={translationSlotLayerSyncLabel}
				translationSlotCleanContextLabel={translationSlotCleanContextLabel}
				typesetLayerOpenActionLabel={typesetLayerOpenActionLabel()}
				typesetLayerCreateActionLabel={typesetLayerCreateActionLabel()}
				typesetLayerOpenActionAria={typesetLayerOpenActionAria}
				typesetLayerCreateActionAria={typesetLayerCreateActionAria}
				onSelectCleaner={() => selectedProductionRoleId = "cleaner"}
				onUpdateTextLayerFromTranslationSlot={updateTextLayerFromTranslationSlot}
				onOpenTextLayerInEditor={openTextLayerInEditor}
				onCreateTextLayerFromTranslationSlot={createTextLayerFromTranslationSlot}
				onUnlinkOrphanTypesetLayer={unlinkOrphanTypesetLayer}
			/>
		{/if}

		{#if showQcCreditBench}
			<QcCreditBench
				currentPageLabel={currentPageLabel}
				currentPageQcHandoff={currentPageQcHandoff}
				currentPageNeedsCleanRecheck={currentPageNeedsCleanRecheck}
				currentPageNeedsReviewApprovalBeforeFinalQc={currentPageNeedsReviewApprovalBeforeFinalQc()}
				finalQcCanCloseCurrentPage={finalQcCanCloseCurrentPage()}
				finalQcStatusLabel={finalQcStatusLabel()}
				finalQcStatusDetail={finalQcStatusDetail()}
				finalQcReviewApprovalDetail={finalQcReviewApprovalDetail()}
				qcPrimaryCommand={qcPrimaryCommand}
				qcPrimaryTitle={qcPrimaryTitle()}
				qcPrimaryDetail={qcPrimaryDetail()}
				qcPrimaryActionLabel={qcPrimaryActionLabel()}
				qcPrimaryCommandCanvasActionLabel={qcPrimaryCommand?.item ? workItemCanvasActionLabel(qcPrimaryCommand.item) : ""}
				openCurrentPageActionLabel={openCurrentPageActionLabel()}
				creditPolicy={creditPolicy}
				creditSummaryLabel={creditSummaryLabel()}
				creditPolicyDetail={creditPolicyDetail()}
				cleanHandoffStatusLabel={cleanHandoffStatusLabel()}
				translatedScriptCount={translatedScriptCount}
				translatorScriptSlotCount={translatorScriptSlots.length}
				qcTypesetTruthWarn={qcTypesetTruthWarn}
				qcTypesetTruthLabel={qcTypesetTruthLabel}
				currentPageOpenCommentCount={currentPageOpenCommentCount}
				currentPageAiQcCount={currentPageAiQcCount}
				reviewDecisionStatusLabel={reviewDecisionStatusLabel()}
				exportPolicyControlLabel={exportPolicyControlLabel}
				onMarkCurrentPageCleanRecheck={markCurrentPageCleanRecheck}
				onOpenCurrentPageReviewInFocus={openCurrentPageReviewInFocus}
				onOpenCanvas={() => void openCanvas()}
				onFocusQcPrimaryCommand={() => void focusQcPrimaryCommand()}
				onOpenQcPrimaryCommandInEditor={() => void openQcPrimaryCommandInEditor()}
				onUpdateCurrentPageQcHandoff={(status) => void updateCurrentPageQcHandoff(status)}
				onOpenCreditWorkflow={openCreditWorkflow}
				onOpenPages={openPages}
				onUpdateCreditPolicy={updateCreditPolicy}
			/>
		{/if}

		{#if !showProductionRoleBench && (!showSoloBlockerStrip || (selectedRoleNextItem && selectedRoleNextItem.id !== topBlockerItem?.id))}
			<RoleNextStrip
				hasProject={Boolean(projectStore.project)}
				selectedRoleNextItem={selectedRoleNextItem}
				selectedRolePageStateNext={selectedRolePageStateNext}
				roleNextHeading={roleNextHeading()}
				roleNextPrimaryAction={roleNextPrimaryAction()}
				roleNextCanvasAction={roleNextCanvasAction()}
				workItemDisplayTitle={workItemDisplayTitle}
				roleNextDetail={roleNextDetail}
				onFocusSelectedRoleNext={() => void focusSelectedRoleNext()}
				onOpenSelectedRoleNextInEditor={() => void openSelectedRoleNextInEditor()}
				onCopyFocusLink={(item) => void copyFocusLinkForItem(item)}
				onOpenSelectedRolePageStateNext={() => void openSelectedRolePageStateNext()}
				onOpenCanvas={() => openCanvas()}
			/>
		{/if}

		<details class="work-advanced-strip" open={!soloWorkspace}>
			<summary data-expand-label={$_("workBoard.expand")} data-collapse-label={$_("workBoard.collapse")}>
				<span>{soloWorkspace ? $_("workBoard.moreWorkDetail") : $_("workBoard.moreWorkPaths")}</span>
				<strong>
					{soloWorkspace
						? $_("workBoard.soloAdvancedSummary", { values: { reviews: focusSummary.reviewCount, comments: focusSummary.commentCount, ai: focusSummary.aiCount + focusSummary.qcCount ? $_("workBoard.aiQualityCount", { values: { n: focusSummary.aiCount + focusSummary.qcCount } }) : $_("workBoard.noAiStuck") } })
						: $_("workBoard.teamAdvancedSummary")}
				</strong>
			</summary>
			{#if showOwnershipCeremony}
				<section class="ownership-strip" aria-label={$_("workBoard.ownershipAria")}>
					<div class="ownership-head">
						<span>{$_("workBoard.owner")}</span>
						<strong>{$_("workBoard.whoTakesNext")}</strong>
					</div>
					<article class={`ownership-card ${primaryOwnerGroup?.urgentCount || primaryOwnerGroup?.overdueCount ? "hot" : "info"}`}>
						<div>
							<span>{$_("workBoard.nextOwner")}</span>
							<strong>{workBoardAssigneeLabel(primaryOwnerGroup?.assignee, $_("workBoard.noOwnerYet"))}</strong>
							<small>{ownerSignal(primaryOwnerGroup)}</small>
						</div>
						<div class="ownership-actions">
							{#if primaryOwnerGroup}
								<button type="button" class="primary" onclick={focusPrimaryOwner}>{$_("workBoard.openQueue")}</button>
								<details class="work-row-more">
									<summary>{$_("workBoard.more")}</summary>
									<div class="work-row-more-menu">
										<button type="button" onclick={() => void openPrimaryOwner()}>{assignedGroupCanvasActionLabel(primaryOwnerGroup)}</button>
									</div>
								</details>
							{:else}
								<span class="action-receipt ready">{$_("workBoard.noOpenQueue")}</span>
							{/if}
						</div>
					</article>
					<article class={`ownership-card ${unassignedOpenCount ? "warn" : "ready"}`}>
						<div>
							<span>{$_("workBoard.unassigned")}</span>
							<strong>{$_("workBoard.openTasksN", { values: { n: unassignedOpenCount } })}</strong>
							<small>{unassignedOpenCount ? $_("workBoard.assignBeforeHandoff") : $_("workBoard.allOpenAssigned")}</small>
						</div>
						<div class="ownership-actions">
							{#if unassignedGroup && unassignedOpenCount > 0}
								<button type="button" onclick={focusUnassigned}>{$_("workBoard.assignOwner")}</button>
							{:else}
								<span class="action-receipt ready">{$_("workBoard.allDone")}</span>
							{/if}
						</div>
					</article>
					<article class={`ownership-card ${topBlockerItem ? "hot" : "ready"}`}>
						<div>
							<span>{$_("workBoard.mainBlocker")}</span>
							<strong>{blockerOwnerLabel(topBlockerItem)}</strong>
							<small>{topBlockerItem ? `${workItemRouteLabel(topBlockerItem)} / ${workItemDisplayTitle(topBlockerItem)}` : $_("workBoard.cmdBlockersEmpty")}</small>
						</div>
						<div class="ownership-actions">
							{#if topBlockerItem}
								<button type="button" class="primary" onclick={() => void focusTopBlocker()}>{workPrimaryActionLabel(topBlockerItem)}</button>
								<details class="work-row-more">
									<summary>{$_("workBoard.more")}</summary>
									<div class="work-row-more-menu">
										<button type="button" onclick={() => void openTopBlocker()}>{workItemCanvasActionLabel(topBlockerItem)}</button>
									</div>
								</details>
							{:else}
								<span class="action-receipt ready">{$_("workBoard.noBlocker")}</span>
							{/if}
						</div>
					</article>
				</section>
			{/if}
			{#if soloWorkspace}
				<ReviewCommandStrip
					variant="solo"
					reviewCommands={reviewCommands}
					reviewCommandAriaLabel={reviewCommandAriaLabel}
					workItemCanvasActionLabel={workItemCanvasActionLabel}
					onFocusReviewCommand={(command) => void focusReviewCommand(command)}
					onOpenReviewCommandInEditor={(command) => void openReviewCommandInEditor(command)}
				/>
			{:else if !showQcCreditBench}
				<ReviewCommandStrip
					variant="team"
					reviewCommands={reviewCommands}
					reviewCommandAriaLabel={reviewCommandAriaLabel}
					workItemCanvasActionLabel={workItemCanvasActionLabel}
					onFocusReviewCommand={(command) => void focusReviewCommand(command)}
					onOpenReviewCommandInEditor={(command) => void openReviewCommandInEditor(command)}
				/>
			{/if}
		</details>

		<details class="queue-overview" open={!soloWorkspace}>
			<summary data-expand-label={$_("workBoard.expand")} data-collapse-label={$_("workBoard.collapse")}>
				<span>{queueOverviewLabel()}</span>
				<strong>{queueOverviewSummary()}</strong>
			</summary>
			<div class="work-board-grid">
				<WorkspacePriorityInbox
					projectOpen={Boolean(projectStore.project)}
					items={inboxItems}
					summary={inboxSummary}
					showAssignee={!soloWorkspace || showAssignedQueueOverview}
					soloAssigneeLabel={soloWorkspace ? $_("workBoard.soloMode") : $_("workBoard.awaitTeamSplit")}
					onFocusItem={focusInboxItem}
					onOpenItemInEditor={openInboxItemInEditor}
				/>

				{#if showAssignedQueueOverview}
					<WorkspaceAssignedWork
						projectOpen={Boolean(projectStore.project)}
						groups={assignedWorkGroups}
						soloAssigneeLabel={soloWorkspace ? $_("workBoard.soloMode") : $_("workBoard.awaitTeamSplit")}
						onFocusGroup={focusAssignedGroup}
						onOpenGroup={openAssignedGroup}
					/>
				{/if}

					<section class="lane-panel" aria-label={lanePanelAriaLabel()}>
						<div class="lane-head">
							<div>
								<span>{lanePanelEyebrow()}</span>
								<h2>{lanePanelTitle()}</h2>
							</div>
						{#if taskFocusItems.length}
							<button type="button" onclick={() => openFocus()}>
								{$_("workBoard.openPageWork")}
							</button>
						{:else}
							<span class="action-receipt ready">{$_("workBoard.noWorkQueue")}</span>
						{/if}
					</div>
					<WorkspaceJobLanes lanes={jobLanes} emptyLaneLabels={jobLaneEmptyLabels} soloAssigneeLabel={soloWorkspace ? $_("workBoard.soloMode") : $_("workBoard.awaitTeamSplit")} onOpenLane={openJobLane} />
				</section>
			</div>
		</details>
		{/if}
		</div>
	</section>
{/if}

<style>
	/* Surface frame (position / scroll / background / typeface) + the centered
	   1200px content column come from the shared `.ws-surface` + `.ws-surface-inner`
	   utilities in app.css, so the work-board now matches every other surface instead
	   of its old Aptos / dark-slate / 1500px look. The board overlays above other
	   surfaces, so it keeps its own stacking context. */
	.workspace-work-shell {
		z-index: 49;
	}

	.work-top {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
	}

	.work-title {
		min-width: 0;
	}

	.work-title span,
	.lane-head span {
		color: var(--color-ws-violet, #8b5cf6);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.work-title h1,
	.work-title p,
	.lane-head h2 {
		margin: 0;
		letter-spacing: 0;
	}

	.work-title h1 {
		margin-top: 2px;
		color: var(--color-ws-ink, #ececf2);
		font-size: clamp(20px, 2.4vw, 26px);
		font-weight: 700;
		line-height: 1.12;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.work-title p {
		margin-top: 7px;
		color: #aab8ca;
		font-size: 13px;
		font-weight: 760;
		line-height: 1.35;
	}

	.work-actions {
		display: flex;
		flex: 0 0 auto;
		align-items: flex-start;
		gap: 8px;
	}

	.work-route-menu {
		position: relative;
	}

	.work-route-menu summary {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: #d7dee8;
		cursor: pointer;
		font-size: 12px;
		font-weight: 850;
		list-style: none;
	}

	.work-route-menu summary::-webkit-details-marker {
		display: none;
	}

	.work-route-menu > div {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 3;
		display: grid;
		gap: 6px;
		min-width: 156px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(29, 32, 36, 0.96);
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.36);
	}

	.work-route-menu[open] > div {
		position: static;
		display: flex;
		flex-wrap: wrap;
		margin-top: 6px;
		min-width: 0;
		max-width: 296px;
		box-shadow: none;
	}

	button {
		font-family: inherit;
	}

	.work-actions button,
	.work-route-menu button,
	:global(.production-role-action button),
	.lane-head button {
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: #d7dee8;
		cursor: pointer;
		font-size: 12px;
		font-weight: 850;
	}

	.work-actions button.primary {
		border-color: transparent;
		background: var(--ws-grad-primary, linear-gradient(100deg, #8b5cf6, #d946ef));
		color: #fff;
	}

	.work-empty-pages {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 16px;
		align-items: center;
		padding: clamp(18px, 3vw, 28px);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-accent) 14%, transparent), rgba(7, 12, 20, 0.64)),
			color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	.work-empty-pages div {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.work-empty-pages span {
		color: var(--color-ws-violet);
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.work-empty-pages h2,
	.work-empty-pages p {
		margin: 0;
		letter-spacing: 0;
	}

	.work-empty-pages h2 {
		color: var(--color-ws-ink);
		font-size: clamp(20px, 2.8vw, 28px);
		font-weight: 900;
		line-height: 1.12;
		overflow-wrap: anywhere;
	}

	.work-empty-pages p {
		color: #aab8ca;
		font-size: 13px;
		font-weight: 760;
		line-height: 1.5;
	}

	.work-empty-pages button {
		min-height: 42px;
		min-width: 136px;
		padding: 0 16px;
		border: 0;
		border-radius: var(--radius-ws-ctrl, 10px);
		background: var(--ws-grad-primary, linear-gradient(100deg, #8b5cf6, #d946ef));
		color: #fff;
		cursor: pointer;
		font-size: 13px;
		font-weight: 900;
	}

	.work-kpis {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.work-kpis span {
		display: inline-flex;
		align-items: center;
		min-width: 0;
		min-height: 36px;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 780;
	}

	:global(.production-role-map) {
		display: grid;
		gap: 10px;
		padding: 13px;
		border: 1px solid rgba(139, 92, 246, 0.16);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
	}

	:global(.production-role-head) {
		display: grid;
		gap: 3px;
	}

	:global(.production-role-head span),
	:global(.production-role-grid span) {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.production-role-head strong) {
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 900;
		line-height: 1.2;
	}

	:global(.production-role-grid) {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 8px;
	}

	:global(.production-role-grid article) {
		display: grid;
		min-width: 0;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
		align-content: space-between;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: #14141b;
	}

	:global(.production-role-grid article.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: rgba(39, 113, 88, 0.15);
	}

	:global(.production-role-grid article > div:first-child) {
		display: grid;
		min-width: 0;
		gap: 4px;
	}

	:global(.production-role-grid strong) {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		line-height: 1.2;
	}

	:global(.production-role-action) {
		display: grid;
		grid-template-columns: minmax(0, auto) minmax(104px, 1fr);
		gap: 6px;
		align-items: center;
	}

	:global(.production-role-action em) {
		color: #d8e7f7;
		font-size: 11px;
		font-style: normal;
		font-weight: 850;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.production-role-action button) {
		width: 100%;
		min-height: 40px;
	}

	:global(.current-page-handoff) {
		display: grid;
		grid-template-columns: minmax(0, 0.72fr) minmax(260px, 1fr) auto;
		gap: 10px;
		align-items: center;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background:
			linear-gradient(90deg, rgba(39, 113, 88, 0.13), color-mix(in srgb, var(--color-ws-bg) 52%, transparent)),
			color-mix(in srgb, var(--color-ws-bg) 52%, transparent);
	}

	:global(.current-page-handoff-copy) {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	:global(.current-page-handoff-copy span) {
		color: var(--color-ws-accent);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.current-page-handoff-copy strong) {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.current-page-handoff-copy small) {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.current-page-handoff-states) {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		min-width: 0;
	}

	:global(.current-page-handoff-states span) {
		min-height: 24px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 999px;
		padding: 4px 7px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.current-page-handoff-states span.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
		color: var(--color-ws-ink);
	}

	:global(.current-page-handoff-states span.warn) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 18%, transparent);
		color: var(--color-ws-amber);
	}

	:global(.current-page-handoff button) {
		min-height: 40px;
		min-width: 128px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 26%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 900;
	}

	:global(.current-page-handoff button.primary) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
		color: var(--color-ws-ink);
	}

	:global(.production-page-handoff) {
		display: grid;
		gap: 9px;
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
		border-radius: 12px;
		background: rgba(7, 11, 18, 0.34);
	}

	:global(.production-page-handoff[open]) {
		background: rgba(7, 11, 18, 0.48);
	}

	:global(.production-page-head) {
		display: grid;
		gap: 3px;
		min-height: 40px;
		align-content: center;
		min-width: 0;
		padding-right: 28px;
		cursor: pointer;
		list-style: none;
		position: relative;
	}

	:global(.production-page-head::-webkit-details-marker) {
		display: none;
	}

	:global(.production-page-head::after) {
		position: absolute;
		top: 50%;
		right: 2px;
		width: 22px;
		height: 22px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 8%, transparent);
		color: #cfe0ff;
		content: "+";
		display: grid;
		place-items: center;
		font-size: 14px;
		font-weight: 900;
		line-height: 1;
		transform: translateY(-50%);
	}

	:global(.production-page-handoff[open]) :global(.production-page-head::after) {
		content: "-";
	}

	:global(.production-page-head span),
	:global(.production-page-title span) {
		color: var(--color-ws-accent);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.production-page-head strong) {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		line-height: 1.2;
	}

	:global(.production-page-head small),
	:global(.production-page-title small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
	}

	:global(.production-page-grid) {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
		gap: 8px;
	}

	:global(.production-page-grid article) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 9px;
		align-items: center;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-bg) 48%, transparent);
	}

	:global(.production-page-grid article.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
	}

	:global(.production-page-title) {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	:global(.production-page-title strong) {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 900;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.production-page-states) {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		min-width: 0;
	}

	:global(.production-page-states span) {
		min-height: 24px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 999px;
		padding: 4px 7px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.production-page-states span.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
		color: var(--color-ws-ink);
	}

	:global(.production-page-states span.warn) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 18%, transparent);
		color: var(--color-ws-amber);
	}

	:global(.production-page-grid button) {
		min-height: 40px;
		min-width: 104px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 26%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 900;
	}

	:global(.main-project-handoff) {
		display: grid;
		grid-template-columns: minmax(0, 0.75fr) minmax(260px, 1fr) auto;
		gap: 10px;
		align-items: center;
		padding: 11px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 24%, transparent);
		border-radius: 12px;
		background:
			linear-gradient(90deg, color-mix(in srgb, var(--color-ws-amber) 16%, transparent), color-mix(in srgb, var(--color-ws-bg) 52%, transparent)),
			color-mix(in srgb, var(--color-ws-bg) 52%, transparent);
	}

	:global(.main-project-handoff.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
		background:
			linear-gradient(90deg, rgba(39, 113, 88, 0.16), color-mix(in srgb, var(--color-ws-bg) 52%, transparent)),
			color-mix(in srgb, var(--color-ws-bg) 52%, transparent);
	}

	:global(.main-project-handoff-copy) {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	:global(.main-project-handoff-copy span) {
		color: var(--color-ws-accent);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.main-project-handoff-copy strong) {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.main-project-handoff-copy small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
	}

	:global(.main-project-handoff-checks) {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		min-width: 0;
	}

	:global(.main-project-handoff-checks span) {
		min-height: 24px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 999px;
		padding: 4px 7px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.main-project-handoff-checks span.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
		color: var(--color-ws-ink);
	}

	:global(.main-project-handoff-checks span.warn) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 18%, transparent);
		color: var(--color-ws-amber);
	}

	:global(.main-project-handoff button) {
		min-height: 40px;
		min-width: 118px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 26%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 900;
	}

	:global(.main-project-handoff button.primary) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
		color: var(--color-ws-ink);
	}

	:global(.team-task-reconcile) {
		display: grid;
		grid-template-columns: minmax(0, 0.74fr) minmax(220px, 0.8fr) auto;
		gap: 10px;
		align-items: center;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 20%, transparent);
		border-radius: 12px;
		background: rgba(12, 18, 28, 0.62);
	}

	:global(.team-task-reconcile-copy) {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	:global(.team-task-reconcile-copy span) {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.team-task-reconcile-copy strong) {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.team-task-reconcile-copy small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
	}

	:global(.team-task-reconcile-states) {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		min-width: 0;
	}

	:global(.team-task-reconcile-states span) {
		min-height: 24px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 26%, transparent);
		border-radius: 999px;
		padding: 4px 7px;
		background: color-mix(in srgb, var(--color-ws-accent) 9%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.team-task-reconcile-states span.warn) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
		color: #ffe4a8;
	}

	:global(.team-task-reconcile button) {
		min-height: 40px;
		min-width: 132px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 26%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 900;
	}

	:global(.cleaner-handoff-bench),
	:global(.translator-script-bench),
	:global(.typesetter-script-bench),
	:global(.qc-credit-bench) {
		display: grid;
		gap: 10px;
		padding: 13px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		border-radius: 12px;
		background: rgba(8, 17, 18, 0.58);
	}

	:global(.cleaner-handoff-bench) {
		grid-template-columns: minmax(0, 0.9fr) minmax(150px, 0.34fr) minmax(220px, 0.64fr) auto;
		align-items: center;
	}

	:global(.cleaner-handoff-copy),
	:global(.cleaner-handoff-status),
	:global(.cleaner-handoff-impact) {
		display: grid;
		gap: 3px;
	}

	:global(.cleaner-handoff-copy span),
	:global(.cleaner-handoff-status span),
	:global(.cleaner-handoff-impact span) {
		color: var(--color-ws-accent);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.cleaner-handoff-copy strong) {
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 900;
		line-height: 1.2;
	}

	:global(.cleaner-handoff-impact strong) {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 900;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	:global(.cleaner-handoff-copy small),
	:global(.cleaner-handoff-status small),
	:global(.cleaner-handoff-impact small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
	}

	:global(.cleaner-handoff-status em) {
		width: fit-content;
		max-width: 100%;
		padding: 4px 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: 999px;
		color: #c2cfdf;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		font-size: 10px;
		font-style: normal;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.cleaner-handoff-status em.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		color: #a8ffe8;
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
	}

	:global(.cleaner-handoff-status),
	:global(.cleaner-handoff-impact) {
		padding: 9px 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-bg) 58%, transparent);
	}

	:global(.cleaner-handoff-status.ready),
	:global(.cleaner-handoff-impact.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 9%, transparent);
	}

	:global(.cleaner-handoff-actions button) {
		min-height: 40px;
		min-width: 140px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 74%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 900;
	}

	:global(.cleaner-handoff-actions button.primary) {
		background: linear-gradient(135deg, var(--color-ws-accent), var(--color-ws-violet));
		color: var(--color-ws-ink);
	}

	:global(.cleaner-roundtrip) {
		grid-column: 1 / -1;
		display: grid;
		gap: 6px;
		padding-top: 10px;
		border-top: 1px dashed color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
	}

	:global(.cleaner-roundtrip > span) {
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgba(221, 255, 246, 0.62);
	}

	:global(.cleaner-roundtrip-actions) {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	:global(.cleaner-roundtrip-actions button) {
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 74%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 800;
	}

	:global(.cleaner-roundtrip-actions button.primary) {
		background: linear-gradient(135deg, var(--color-ws-accent), var(--color-ws-violet));
		color: var(--color-ws-ink);
	}

	:global(.cleaner-roundtrip-actions button:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}

	:global(.cleaner-roundtrip > small) {
		font-size: 11px;
		line-height: 1.5;
		color: rgba(221, 255, 246, 0.55);
	}

	:global(.qc-credit-bench) {
		grid-template-columns: minmax(0, 1fr) minmax(220px, 0.46fr);
		border-color: color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		background:
			linear-gradient(135deg, rgba(23, 38, 66, 0.62), rgba(7, 13, 18, 0.72)),
			rgba(8, 17, 18, 0.58);
	}

	:global(.qc-credit-head),
	:global(.qc-truth-grid) {
		grid-column: 1 / -1;
	}

	:global(.qc-credit-head) {
		display: grid;
		gap: 3px;
	}

	:global(.qc-credit-head span),
	:global(.qc-decision-card span),
	:global(.qc-credit-summary span),
	:global(.qc-truth-grid span) {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.qc-credit-head strong) {
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 900;
		line-height: 1.2;
	}

	:global(.qc-credit-head small),
	:global(.qc-decision-card small),
	:global(.qc-credit-summary small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
	}

	:global(.qc-decision-card),
	:global(.qc-credit-summary),
	:global(.qc-truth-grid div) {
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-bg) 58%, transparent);
	}

	:global(.qc-decision-card) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		padding: 10px;
	}

	:global(.qc-decision-card.hot) {
		border-color: color-mix(in srgb, var(--color-ws-rose) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 18%, transparent);
	}

	:global(.qc-decision-card.warn) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 16%, transparent);
	}

	:global(.qc-decision-card.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background: rgba(42, 91, 63, 0.16);
	}

	:global(.qc-decision-card.idle) {
		opacity: 0.78;
	}

	:global(.qc-decision-card > div:first-child),
	:global(.qc-credit-summary > div) {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	:global(.qc-decision-card strong),
	:global(.qc-credit-summary strong),
	:global(.qc-truth-grid strong) {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	:global(.qc-decision-actions) {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 7px;
	}

	:global(.qc-decision-actions button),
	:global(.qc-credit-summary button) {
		min-height: 40px;
		min-width: 112px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 26%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-accent) 13%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 900;
	}

	:global(.qc-decision-actions button.primary),
	:global(.qc-credit-summary button.primary) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: linear-gradient(135deg, var(--color-ws-accent), var(--color-ws-violet));
		color: var(--color-ws-ink);
	}

	:global(.credit-policy-controls) {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 7px;
	}

	:global(.credit-policy-controls button) {
		min-width: 0;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		color: #b9c6d6;
	}

	:global(.credit-policy-controls button.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: rgba(42, 91, 63, 0.22);
		color: #c8f7da;
	}

	:global(.qc-credit-summary) {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
		align-content: center;
		padding: 10px;
	}

	:global(.qc-truth-grid) {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));
		gap: 8px;
	}

	:global(.qc-truth-grid div) {
		display: grid;
		gap: 3px;
		padding: 9px;
	}

	:global(.qc-truth-grid div.warn) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 16%, transparent);
	}

	:global(.translator-bench-head) {
		display: grid;
		gap: 3px;
	}

	:global(.typesetter-bench-head) {
		display: grid;
		gap: 3px;
	}

	:global(.translator-bench-head span),
	:global(.typesetter-bench-head span),
	:global(.translator-script-list span),
	:global(.typesetter-script-card span),
	:global(.translator-page-preview > span) {
		color: var(--color-ws-accent);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.translator-bench-head strong),
	:global(.typesetter-bench-head strong) {
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 900;
		line-height: 1.2;
	}

	:global(.translator-bench-head small),
	:global(.typesetter-bench-head small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
	}

	:global(.translator-handoff-card) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 24%, transparent);
		border-radius: 12px;
		background: rgba(72, 44, 6, 0.42);
	}

	:global(.translator-handoff-card.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 26%, transparent);
		background: rgba(7, 48, 38, 0.34);
	}

	:global(.translator-handoff-card div:first-child) {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	:global(.translator-handoff-card span) {
		color: var(--color-ws-amber);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.translator-handoff-card.ready span) {
		color: var(--color-ws-accent);
	}

	:global(.translator-handoff-card strong) {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.translator-handoff-card.ready strong) {
		color: var(--color-ws-ink);
	}

	:global(.translator-handoff-card small) {
		color: #c6b894;
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	:global(.translator-handoff-card.ready small) {
		color: #9edfcf;
	}

	:global(.translator-handoff-actions) {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
		min-width: 0;
	}

	:global(.translator-handoff-actions button) {
		min-height: 40px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 74%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 11px;
		font-weight: 900;
	}

	:global(.translator-handoff-actions button.primary) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 13%, transparent);
		color: var(--color-ws-ink);
	}

	:global(.typesetter-script-list) {
		display: grid;
		gap: 8px;
	}

	:global(.typesetter-script-empty) {
		display: grid;
		gap: 4px;
		padding: 14px 12px;
		border: 1px dashed color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 50%, transparent);
		text-align: center;
	}

	:global(.typesetter-script-empty strong) {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 900;
	}

	:global(.typesetter-script-empty small) {
		color: #8fa0b6;
		font-size: 11px;
		line-height: 1.4;
	}

	:global(.typesetter-script-card) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		padding: 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-bg) 58%, transparent);
	}

	:global(.typesetter-script-card.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
	}

	:global(.typesetter-script-card.done) {
		border-color: rgba(255, 216, 107, 0.3);
		background: rgba(255, 216, 107, 0.06);
	}

	:global(.typesetter-script-card.stale) {
		border-color: rgba(255, 172, 95, 0.42);
		background:
			linear-gradient(90deg, rgba(255, 172, 95, 0.1), color-mix(in srgb, var(--color-ws-bg) 58%, transparent)),
			color-mix(in srgb, var(--color-ws-bg) 58%, transparent);
	}

	:global(.typesetter-script-card.orphan) {
		border-color: rgba(255, 136, 136, 0.36);
		background:
			linear-gradient(90deg, rgba(255, 136, 136, 0.12), color-mix(in srgb, var(--color-ws-bg) 58%, transparent)),
			color-mix(in srgb, var(--color-ws-bg) 58%, transparent);
	}

	:global(.typesetter-script-card div) {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	:global(.typesetter-script-card strong) {
		display: -webkit-box;
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 850;
		line-height: 1.3;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}

	:global(.typesetter-sync-note) {
		width: fit-content;
		max-width: 100%;
		border-radius: 999px;
		padding: 3px 7px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 900;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	:global(.typesetter-sync-note.stale) {
		background: rgba(255, 172, 95, 0.16);
		color: #ffe1bd;
	}

	:global(.typesetter-orphan-group) {
		display: grid;
		gap: 8px;
		padding: 9px;
		border: 1px solid rgba(255, 136, 136, 0.22);
		border-radius: 12px;
		background: rgba(58, 15, 20, 0.24);
	}

	:global(.typesetter-orphan-head) {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	:global(.typesetter-orphan-head span) {
		color: #ffb1b1;
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.typesetter-orphan-head strong) {
		color: #ffe4e4;
		font-size: 13px;
		font-weight: 900;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	:global(.typesetter-orphan-head small) {
		color: #e7b8b8;
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
	}

	:global(.typesetter-clean-note) {
		width: fit-content;
		max-width: 100%;
		border-radius: 999px;
		padding: 3px 7px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: #dceaff;
		font-size: 10px;
		font-weight: 900;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	:global(.typesetter-clean-readiness) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-bg) 58%, transparent);
	}

	:global(.typesetter-clean-readiness.ready) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 9%, transparent);
	}

	:global(.typesetter-clean-readiness.warn) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 16%, transparent);
	}

	:global(.typesetter-clean-readiness > div) {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	:global(.typesetter-clean-readiness span) {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0;
	}

	:global(.typesetter-clean-readiness strong) {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	:global(.typesetter-clean-readiness small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
	}

	:global(.typesetter-clean-readiness button) {
		min-height: 40px;
		min-width: 112px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 26%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-accent) 13%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 900;
	}

	:global(.typesetter-script-actions) {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 7px;
		min-width: 0;
	}

	:global(.typesetter-script-card button) {
		min-height: 40px;
		min-width: 128px;
		max-width: 100%;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 900;
	}

	:global(.typesetter-script-card button.primary) {
		border-color: rgba(255, 216, 107, 0.32);
		background: rgba(255, 216, 107, 0.14);
		color: #ffe7a6;
	}

	:global(.typesetter-script-card em) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-style: normal;
		font-weight: 850;
		white-space: nowrap;
	}

	:global(.translator-bench-body) {
		display: grid;
		grid-template-columns: minmax(220px, 0.74fr) minmax(0, 1fr);
		gap: 10px;
		align-items: stretch;
	}

	:global(.translator-page-preview) {
		position: relative;
		display: grid;
		min-height: 260px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 12px;
		background:
			linear-gradient(135deg, rgba(30, 37, 45, 0.88), rgba(10, 13, 17, 0.92)),
			#101317;
	}

	:global(.translator-page-preview > span) {
		position: absolute;
		top: 10px;
		left: 10px;
		z-index: 2;
		padding: 4px 7px;
		border-radius: 7px;
		background: rgba(0, 0, 0, 0.58);
	}

	:global(.translator-page-preview img) {
		width: 100%;
		height: 100%;
		object-fit: contain;
		pointer-events: none;
	}

	:global(.translator-page-preview.placement-ready) {
		cursor: crosshair;
	}

	:global(.translator-placement-target) {
		position: absolute;
		inset: 0;
		z-index: 1;
		min-height: 100%;
		border: 0;
		background: transparent;
		cursor: crosshair;
	}

	:global(.translator-page-preview > strong) {
		align-self: center;
		justify-self: center;
		color: var(--color-ws-text);
		font-size: 13px;
		font-weight: 850;
	}

	:global(.translation-pin) {
		position: absolute;
		left: var(--pin-x);
		top: var(--pin-y);
		z-index: 2;
		min-height: 40px;
		min-width: 52px;
		max-width: 116px;
		transform: translate(-50%, -50%);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 44%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-bg) 82%, transparent);
		color: #d9fff5;
		cursor: pointer;
		font-size: 11px;
		font-weight: 900;
	}

	:global(.translation-pin.active) {
		border-color: rgba(255, 216, 107, 0.92);
		background: rgba(72, 44, 6, 0.9);
		box-shadow: 0 0 0 3px rgba(255, 216, 107, 0.18);
		color: var(--color-ws-ink);
	}

	:global(.translator-script-list) {
		display: grid;
		gap: 8px;
	}

	:global(.translator-slot-toolbar) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: stretch;
	}

	:global(.translator-placement-hint) {
		margin: 0;
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-accent) 8%, transparent);
		color: #b7c4d7;
		font-size: 11px;
		font-weight: 760;
		line-height: 1.3;
	}

	:global(.translator-placement-hint strong) {
		color: var(--color-ws-ink);
	}

	:global(.translator-script-empty) {
		display: grid;
		gap: 4px;
		padding: 14px 12px;
		border: 1px dashed color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 50%, transparent);
		text-align: center;
	}

	:global(.translator-script-empty strong) {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 900;
	}

	:global(.translator-script-empty small) {
		color: #8fa0b6;
		font-size: 11px;
		line-height: 1.4;
	}

	:global(.translator-slot-toolbar button),
	:global(.translator-slot-delete) {
		min-height: 40px;
		min-width: 72px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 74%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 11px;
		font-weight: 900;
	}

	:global(.translator-slot-delete) {
		border-color: rgba(255, 136, 136, 0.28);
		color: #ffd7d7;
	}

	:global(.translator-script-card) {
		display: grid;
		gap: 7px;
		padding: 7px;
		border: 1px solid transparent;
		border-radius: 12px;
	}

	:global(.translator-script-card.active) {
		border-color: rgba(255, 216, 107, 0.28);
		background: rgba(255, 216, 107, 0.06);
	}

	:global(.translator-slot-meta) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: 7px;
		align-items: end;
	}

	:global(.translator-slot-name),
	:global(.translator-script-text) {
		display: grid;
		gap: 5px;
	}

	:global(.translator-slot-name input) {
		min-height: 40px;
		width: 100%;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 11%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13px;
		font-weight: 850;
		padding: 8px 10px;
	}

	:global(.translator-slot-position) {
		align-self: center;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 850;
		white-space: nowrap;
	}

	:global(.translator-script-list textarea) {
		min-height: 86px;
		width: 100%;
		resize: vertical;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 11%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13px;
		line-height: 1.35;
		padding: 9px 10px;
	}

	@media (max-width: 860px) {
		:global(.cleaner-handoff-bench),
		:global(.translator-slot-toolbar),
		:global(.translator-slot-meta),
		:global(.typesetter-script-card) {
			grid-template-columns: 1fr;
		}

		:global(.translator-slot-position) {
			white-space: normal;
		}
	}

	.chapter-readiness {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		padding: 13px 14px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 22%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background:
			linear-gradient(90deg, rgba(131, 92, 27, 0.18), rgba(35, 39, 46, 0.86)),
			color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	.chapter-readiness.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 28%, transparent);
		background:
			linear-gradient(90deg, rgba(42, 91, 63, 0.18), rgba(35, 39, 46, 0.86)),
			color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	.chapter-readiness > div {
		display: grid;
		min-width: 0;
		gap: 4px;
	}

	.chapter-readiness span {
		color: var(--color-ws-amber);
		font-size: 10px;
		font-weight: 900;
	}

	.chapter-readiness.ready span {
		color: #9be7b8;
	}

	.chapter-readiness strong {
		color: var(--color-ws-ink);
		font-size: 15px;
		font-weight: 900;
		line-height: 1.18;
	}

	.chapter-readiness small {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.chapter-readiness button {
		min-height: 40px;
		padding: 0 13px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 32%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(145, 104, 35, 0.18);
		color: #ffe8b5;
		cursor: pointer;
		font-size: 12px;
		font-weight: 850;
	}

	.chapter-readiness.ready button {
		border-color: color-mix(in srgb, var(--color-ws-green) 36%, transparent);
		background: rgba(59, 130, 97, 0.18);
		color: #d9f5e3;
	}

	.work-mode-owner-strip {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	.work-mode-owner-strip > div:first-child {
		display: grid;
		min-width: 0;
		gap: 3px;
	}

	.work-mode-owner-strip span {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0;
	}

	.work-mode-owner-strip strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 900;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.work-mode-owner-strip small {
		overflow: hidden;
		color: #98a6b8;
		font-size: 11px;
		font-weight: 760;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.work-mode-toggle {
		display: grid;
		grid-template-columns: repeat(2, minmax(118px, 1fr));
		gap: 8px;
	}

	.work-mode-toggle button {
		display: grid;
		gap: 3px;
		min-height: 42px;
		padding: 7px 10px;
		border-color: color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		text-align: left;
	}

	.work-mode-toggle button.active {
		border-color: color-mix(in srgb, var(--color-ws-green) 55%, transparent);
		background: rgba(59, 130, 97, 0.22);
	}

	:global(.role-next-strip) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		padding: 12px 14px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 22%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background:
			linear-gradient(90deg, rgba(59, 130, 97, 0.16), color-mix(in srgb, var(--color-ws-accent) 6%, transparent)),
			color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	:global(.role-next-strip.idle) {
		border-color: color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	:global(.solo-blocker-strip) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		padding: 11px 14px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 18%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
	}

	:global(.solo-blocker-strip.active) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
		background:
			linear-gradient(90deg, rgba(131, 92, 27, 0.2), rgba(35, 39, 46, 0.88)),
			color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	:global(.solo-blocker-layout) {
		display: grid;
		grid-template-columns: minmax(250px, 0.45fr) minmax(0, 1fr);
		gap: 12px;
		align-items: center;
		min-width: 0;
	}

	:global(.blocker-visual-preview) {
		display: grid;
		grid-template-columns: 76px minmax(0, 1fr);
		gap: 12px;
		align-items: center;
		min-width: 0;
		min-height: 112px;
		padding: 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		border-radius: 10px;
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--color-ws-amber) 12%, transparent), rgba(139, 92, 246, 0.055)),
			rgba(11, 14, 19, 0.42);
		color: inherit;
		cursor: pointer;
		text-align: left;
	}

	:global(.blocker-page-frame) {
		position: relative;
		display: block;
		width: 76px;
		aspect-ratio: 2 / 3;
		overflow: hidden;
		border: 1px solid rgba(245, 247, 252, 0.18);
		border-radius: 5px;
		background:
			linear-gradient(135deg, rgba(226, 232, 240, 0.18), rgba(15, 23, 42, 0.2)),
			#1d2430;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.26);
	}

	:global(.blocker-page-frame img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	:global(.blocker-preview-placeholder) {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 4px;
		color: #d7e5f8;
		font-size: 10px;
		font-weight: 900;
		text-align: center;
	}

	:global(.blocker-region-target) {
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
			0 0 0 1px rgba(12, 16, 22, 0.72),
			0 0 18px color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
	}

	:global(.blocker-preview-copy) {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	:global(.blocker-preview-copy strong) {
		overflow: hidden;
		color: #fff1c7;
		font-size: 12px;
		font-weight: 900;
		line-height: 1.15;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.blocker-preview-copy small) {
		color: #c9d4e4;
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
	}

	:global(.solo-blocker-copy) {
		display: grid;
		min-width: 0;
		gap: 4px;
	}

	:global(.solo-blocker-copy span) {
		color: var(--color-ws-amber);
		font-size: 10px;
		font-weight: 900;
	}

	:global(.solo-blocker-copy strong) {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 900;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.solo-blocker-copy small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	:global(.solo-blocker-actions) {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	:global(.solo-blocker-actions button) {
		min-height: 40px;
		padding: 0 11px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 30%, transparent);
		border-radius: 7px;
		background: rgba(145, 104, 35, 0.17);
		color: #ffe8b5;
		cursor: pointer;
		font-size: 11px;
		font-weight: 850;
	}

	:global(.work-row-more) {
		position: relative;
		min-width: 0;
	}

	:global(.work-row-more summary) {
		display: grid;
		align-items: center;
		min-height: 40px;
		padding: 0 11px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 11px;
		font-weight: 850;
		list-style: none;
		white-space: nowrap;
	}

	:global(.work-row-more summary::-webkit-details-marker) {
		display: none;
	}

	:global(.work-row-more[open] summary) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 35%, transparent);
		background: rgba(139, 92, 246, 0.16);
	}

	:global(.work-row-more-menu) {
		position: absolute;
		z-index: 3;
		right: 0;
		display: grid;
		min-width: 134px;
		gap: 6px;
		margin-top: 6px;
		padding: 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		border-radius: 9px;
		background: var(--color-ws-surface);
		box-shadow: 0 14px 30px rgba(0, 0, 0, 0.28);
	}

	:global(.work-row-more:not([open])) :global(.work-row-more-menu) {
		display: none;
	}

	:global(.role-next-copy) {
		display: grid;
		min-width: 0;
		gap: 4px;
	}

	:global(.role-next-copy span) {
		color: #9be7b8;
		font-size: 10px;
		font-weight: 850;
	}

	:global(.role-next-copy strong) {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 15px;
		font-weight: 900;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.role-next-copy small) {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	:global(.role-next-actions) {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	:global(.role-next-actions button) {
		min-height: 40px;
		padding: 0 11px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 36%, transparent);
		border-radius: 7px;
		background: rgba(59, 130, 97, 0.17);
		color: #d9f5e3;
		cursor: pointer;
		font-size: 11px;
		font-weight: 850;
	}

	.work-advanced-strip {
		display: grid;
		gap: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
	}

	.work-advanced-strip summary {
		display: grid;
		grid-template-columns: minmax(0, 0.28fr) minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		min-height: 42px;
		padding: 10px 12px;
		cursor: pointer;
		list-style: none;
	}

	.work-advanced-strip summary::-webkit-details-marker {
		display: none;
	}

	.work-advanced-strip summary::after,
	.queue-overview summary::after {
		/* Localized open/close affordance: CSS can't call $_(), so the label text
		   comes from the reactive data-expand-label/data-collapse-label attrs that
		   each <summary> binds to $_("workBoard.expand"/"collapse"). attr() resolves on
		   the element owning ::after (the summary), so the attrs MUST live on <summary>,
		   not the parent <details> (else the pill renders blank). */
		content: attr(data-expand-label);
		justify-self: end;
		padding: 4px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 999px;
		color: #b6c7da;
		font-size: 10px;
		font-weight: 850;
	}

	.work-advanced-strip[open] summary::after,
	.queue-overview[open] summary::after {
		content: attr(data-collapse-label);
	}

	.work-advanced-strip summary span,
	.queue-overview summary span {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 900;
	}

	.work-advanced-strip summary strong,
	.queue-overview summary strong {
		min-width: 0;
		color: #e6edf7;
		font-size: 13px;
		font-weight: 850;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.work-advanced-strip[open] {
		padding-bottom: 10px;
	}

	.work-advanced-strip:not([open]) > :not(summary),
	.queue-overview:not([open]) > :not(summary) {
		display: none;
	}

	.queue-overview {
		display: grid;
		gap: 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
	}

	.queue-overview summary {
		display: grid;
		grid-template-columns: minmax(0, 0.28fr) minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		min-height: 44px;
		padding: 10px 12px;
		cursor: pointer;
		list-style: none;
	}

	.queue-overview summary::-webkit-details-marker {
		display: none;
	}

	.queue-overview[open] {
		padding-bottom: 12px;
	}

	.queue-overview[open] .work-board-grid {
		width: calc(100% - 20px);
		margin-inline: 10px;
	}

	.work-advanced-strip[open] .ownership-strip,
	.work-advanced-strip[open] :global(.solo-review-strip),
	.work-advanced-strip[open] :global(.review-command-strip) {
		width: calc(100% - 20px);
		margin-inline: 10px;
	}

	.ownership-strip {
		display: grid;
		grid-template-columns: minmax(170px, 0.7fr) repeat(3, minmax(0, 1fr));
		gap: 8px;
	}

	:global(.solo-review-strip) {
		display: grid;
		grid-template-columns: minmax(160px, 0.62fr) repeat(4, minmax(0, 1fr));
		gap: 8px;
	}

	.ownership-head,
	.ownership-card {
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	.ownership-head {
		display: grid;
		gap: 3px;
		align-content: center;
		padding: 11px 12px;
	}

	.ownership-head span,
	.ownership-card span {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	.ownership-head strong,
	.ownership-card strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ownership-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		padding: 10px;
	}

	.ownership-card.hot {
		border-color: color-mix(in srgb, var(--color-ws-rose) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 18%, transparent);
	}

	.ownership-card.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 16%, transparent);
	}

	.ownership-card.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 28%, transparent);
	}

	.ownership-card > div:first-child {
		display: grid;
		min-width: 0;
		gap: 4px;
	}

	.ownership-card small {
		display: -webkit-box;
		overflow: hidden;
		color: #9aa8b8;
		font-size: 11px;
		font-weight: 720;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.ownership-actions {
		display: grid;
		gap: 6px;
	}

	.ownership-actions button {
		min-height: 36px;
		min-width: 62px;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 11px;
		font-weight: 850;
	}

	.ownership-actions button.primary,
	:global(.review-command-actions button.primary) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background: rgba(139, 92, 246, 0.14);
		color: #f0f6ff;
	}

	:global(.action-receipt) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		min-width: 86px;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 10%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		color: #9eacba;
		font-size: 11px;
		font-weight: 850;
		line-height: 1.15;
		text-align: center;
	}

	:global(.action-receipt.ready) {
		border-color: color-mix(in srgb, var(--color-ws-green) 28%, transparent);
		background: rgba(42, 91, 63, 0.13);
		color: #bff1d3;
	}

	:global(.review-command-strip) {
		display: grid;
		grid-template-columns: minmax(160px, 0.7fr) repeat(4, minmax(0, 1fr));
		gap: 8px;
	}

	:global(.review-command-head),
	:global(.review-command-card) {
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
	}

	:global(.review-command-head) {
		display: grid;
		gap: 3px;
		align-content: center;
		padding: 11px 12px;
	}

	:global(.review-command-head span),
	:global(.review-command-copy span) {
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	:global(.review-command-head strong) {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 900;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.review-command-card) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		padding: 10px;
	}

	:global(.review-command-card.hot) {
		border-color: color-mix(in srgb, var(--color-ws-rose) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 18%, transparent);
	}

	:global(.review-command-card.warn) {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 16%, transparent);
	}

	:global(.review-command-card.ready) {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: rgba(42, 91, 63, 0.16);
	}

	:global(.review-command-card.idle) {
		opacity: 0.74;
	}

	:global(.review-command-copy) {
		display: grid;
		min-width: 0;
		gap: 3px;
	}

	:global(.review-command-copy strong) {
		color: #f7fbff;
		font-size: 24px;
		font-weight: 900;
		line-height: 1;
	}

	:global(.review-command-copy small) {
		display: -webkit-box;
		overflow: hidden;
		color: #9aa8b8;
		font-size: 11px;
		font-weight: 720;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	:global(.review-command-actions) {
		display: grid;
		gap: 6px;
	}

	:global(.review-command-actions button) {
		min-height: 36px;
		min-width: 62px;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 12%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 11px;
		font-weight: 850;
	}

	.work-board-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.15fr);
		gap: 12px;
		align-items: start;
	}

	.lane-panel {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 12px;
		grid-column: 1 / -1;
		padding: 15px;
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: rgba(34, 37, 42, 0.86);
		box-shadow: 0 16px 34px rgba(0, 0, 0, 0.18);
	}

	.lane-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.lane-head h2 {
		color: #e5edf8;
		font-size: 16px;
		font-weight: 850;
		line-height: 1.15;
	}

	@media (min-width: 1240px) {
		.work-board-grid {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr) minmax(360px, 0.8fr);
		}

		.lane-panel {
			grid-column: auto;
		}
	}

	@media (max-width: 980px) {
		.work-actions button,
		.work-mode-toggle button,
		.lane-head button,
		:global(.role-next-actions button),
		.ownership-actions button,
		:global(.review-command-actions button) {
			min-height: 40px;
		}

		.ownership-strip,
		:global(.solo-review-strip),
		:global(.review-command-strip) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.ownership-head,
		:global(.solo-review-strip) :global(.review-command-head),
		:global(.review-command-head) {
			grid-column: 1 / -1;
		}
	}

	@media (max-width: 1040px) {
		.work-top {
			align-items: stretch;
			flex-direction: column;
			gap: 10px;
		}

		.work-mode-owner-strip {
			grid-template-columns: 1fr;
		}

		.work-mode-toggle {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.work-title h1 {
			font-size: 28px;
			line-height: 1.12;
		}

		.work-title p {
			max-width: 72ch;
		}

		.work-actions {
			width: 100%;
			flex-wrap: wrap;
		}

		.work-actions button {
			flex: 1 1 110px;
			min-height: 38px;
			padding-inline: 8px;
		}

		.work-kpis {
			grid-template-columns: repeat(auto-fit, minmax(124px, 1fr));
		}

		:global(.production-role-map) {
			gap: 8px;
			padding: 10px;
		}

		:global(.production-role-grid) {
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 6px;
		}

		:global(.production-role-grid article) {
			gap: 6px;
			padding: 8px;
		}

		:global(.production-role-action) {
			grid-template-columns: minmax(0, 1fr);
		}

		:global(.production-role-action button) {
			padding-inline: 6px;
		}

		:global(.current-page-handoff) {
			grid-template-columns: 1fr;
		}

		:global(.team-task-reconcile) {
			grid-template-columns: 1fr;
		}

		:global(.translator-handoff-card) {
			grid-template-columns: 1fr;
		}

		:global(.translator-handoff-actions) {
			justify-content: flex-start;
		}

		:global(.translator-bench-body) {
			grid-template-columns: 1fr;
		}

		:global(.qc-credit-bench),
		:global(.qc-decision-card) {
			grid-template-columns: 1fr;
		}

		:global(.qc-decision-actions) {
			justify-content: flex-start;
		}

		:global(.qc-truth-grid) {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		:global(.cleaner-handoff-bench) {
			grid-template-columns: minmax(0, 1fr) minmax(180px, 0.5fr);
		}

		:global(.cleaner-handoff-copy) {
			grid-column: 1 / -1;
		}
	}

	@media (max-width: 900px) {
		.work-top {
			align-items: stretch;
			flex-direction: column;
		}

		.work-actions {
			width: 100%;
		}

		.work-actions button {
			flex: 1 1 0;
			padding-inline: 8px;
		}

		.work-empty-pages {
			grid-template-columns: 1fr;
		}

		.work-empty-pages button {
			width: 100%;
		}

		.work-kpis {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.work-board-grid {
			grid-template-columns: 1fr;
		}

		:global(.role-next-strip) {
			grid-template-columns: 1fr;
		}

		:global(.production-role-grid) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		:global(.role-next-actions) {
			justify-content: flex-start;
		}

		:global(.solo-blocker-strip) {
			grid-template-columns: 1fr;
		}

		:global(.solo-blocker-layout) {
			grid-template-columns: minmax(0, 1fr);
		}

		:global(.blocker-visual-preview) {
			grid-template-columns: 72px minmax(0, 1fr);
			width: 100%;
			min-height: 108px;
		}

		:global(.blocker-page-frame) {
			width: 72px;
		}

		:global(.solo-blocker-actions) {
			justify-content: flex-start;
		}

		.ownership-strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.ownership-head {
			grid-column: 1 / -1;
		}

		:global(.solo-review-strip),
		:global(.review-command-strip) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		:global(.solo-review-strip) :global(.review-command-head),
		:global(.review-command-head) {
			grid-column: 1 / -1;
		}
	}

	@media (max-width: 520px) {
		.work-actions {
			flex-direction: column;
		}

		.work-actions button {
			width: 100%;
		}

		:global(.production-role-grid) {
			grid-template-columns: 1fr;
		}

		:global(.production-page-grid article) {
			grid-template-columns: 1fr;
		}

		:global(.production-page-grid button) {
			width: 100%;
		}

		:global(.current-page-handoff),
		:global(.team-task-reconcile),
		:global(.main-project-handoff) {
			grid-template-columns: 1fr;
		}

		:global(.current-page-handoff button),
		:global(.team-task-reconcile button),
		:global(.main-project-handoff button) {
			width: 100%;
		}

		:global(.translator-page-preview) {
			min-height: 220px;
		}

		:global(.qc-truth-grid) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		:global(.cleaner-handoff-bench),
		:global(.typesetter-clean-readiness) {
			grid-template-columns: 1fr;
		}

		:global(.role-next-copy strong) {
			white-space: normal;
		}

		:global(.solo-blocker-copy strong) {
			white-space: normal;
		}

		:global(.review-command-strip) {
			grid-template-columns: 1fr;
		}

		:global(.solo-review-strip) {
			grid-template-columns: 1fr;
		}

		.ownership-strip {
			grid-template-columns: 1fr;
		}

		:global(.review-command-card) {
			grid-template-columns: 1fr;
		}

		.ownership-card {
			grid-template-columns: 1fr;
		}

		:global(.review-command-actions) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.ownership-actions {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	/* Flow202 creator-studio skin — superseded by the shared surface frame for
	   width/padding/font/header; only the title color override is kept (the active
	   Flow369 skin below re-skins the panels). */
	.work-title h1 {
		color: var(--color-ws-ink, #ececf2);
	}

	.work-title span,
	.lane-head span,
	.chapter-readiness span,
	:global(.role-next-copy span),
	:global(.solo-blocker-copy span),
	.work-advanced-strip summary span,
	.ownership-head span,
	.ownership-card span,
	:global(.review-command-head span),
	:global(.review-command-copy span),
	.queue-overview summary span {
		color: #d9b8ff;
		letter-spacing: 0.08em;
	}

	.work-title p,
	.chapter-readiness small,
	:global(.role-next-copy small),
	:global(.solo-blocker-copy small),
	.ownership-card small,
	:global(.review-command-copy small) {
		color: var(--workspace-text, rgba(255, 248, 255, 0.84));
	}

	.work-actions button,
	.work-route-menu summary,
	.work-route-menu button,
	.lane-head button,
	.chapter-readiness button,
	:global(.role-next-actions button),
	:global(.solo-blocker-actions button),
	.ownership-actions button,
	:global(.review-command-actions button) {
		min-height: 42px;
		border-color: var(--workspace-line, color-mix(in srgb, var(--color-ws-ink) 13%, transparent));
		/* Standardize control radius on the shared ws-ctrl token (this themed
		   override layer previously hardcoded the legacy 8px --workspace-radius). */
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		color: var(--workspace-ink, #fff8ff);
	}

	.work-actions button.primary,
	.chapter-readiness button.primary {
		border-color: transparent;
		background: linear-gradient(135deg, var(--workspace-violet, #9a5cff), var(--workspace-magenta, #f253b8));
		box-shadow: 0 18px 40px rgba(154, 92, 255, 0.3);
		color: white;
	}

	.work-route-menu > div,
	.chapter-readiness,
	:global(.role-next-strip),
	:global(.solo-blocker-strip),
	.work-advanced-strip,
	.queue-overview,
	.lane-panel,
	.ownership-head,
	.ownership-card,
	:global(.review-command-head),
	:global(.review-command-card) {
		border-color: var(--workspace-line, color-mix(in srgb, var(--color-ws-ink) 13%, transparent));
		border-radius: var(--workspace-radius, 8px);
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--color-ws-ink) 6%, transparent), transparent 38%),
			var(--workspace-panel, color-mix(in srgb, var(--color-ws-bg) 92%, transparent));
		box-shadow: 0 18px 58px rgba(0, 0, 0, 0.28);
	}

	/* The route-menu popover is a menu/control surface, not a panel — standardize
	   it on the shared ws-ctrl token to match its trigger and action buttons
	   (the themed block above otherwise drops it to the legacy 8px radius). */
	.work-route-menu > div {
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.work-kpis span {
		min-height: 38px;
		border-color: var(--workspace-line, color-mix(in srgb, var(--color-ws-ink) 13%, transparent));
		border-radius: var(--workspace-radius, 8px);
		background: color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		color: var(--workspace-muted, rgba(255, 248, 255, 0.56));
	}

	.chapter-readiness {
		padding: 16px;
		border-color: rgba(255, 211, 106, 0.3);
		background:
			linear-gradient(90deg, rgba(255, 211, 106, 0.14), rgba(242, 83, 184, 0.08)),
			var(--workspace-panel, color-mix(in srgb, var(--color-ws-bg) 92%, transparent));
	}

	.chapter-readiness.ready {
		border-color: rgba(137, 255, 181, 0.32);
		background:
			linear-gradient(90deg, rgba(137, 255, 181, 0.12), rgba(137, 255, 181, 0.08)),
			var(--workspace-panel, color-mix(in srgb, var(--color-ws-bg) 92%, transparent));
	}

	.chapter-readiness span,
	:global(.solo-blocker-copy span) {
		color: var(--workspace-amber, #ffd36a);
	}

	.chapter-readiness.ready span,
	:global(.role-next-copy span) {
		color: var(--workspace-cyan, var(--color-ws-accent));
	}

	.chapter-readiness strong,
	:global(.role-next-copy strong),
	:global(.solo-blocker-copy strong),
	.ownership-head strong,
	.ownership-card strong,
	:global(.review-command-head strong),
	:global(.review-command-copy strong),
	.lane-head h2,
	.queue-overview summary strong {
		color: var(--workspace-ink, #fff8ff);
	}

	.queue-overview {
		padding: 10px 12px;
	}

	.queue-overview summary,
	.work-advanced-strip summary {
		min-height: 48px;
	}

	:global(.role-next-strip.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background:
			linear-gradient(90deg, color-mix(in srgb, var(--color-ws-accent) 12%, transparent), rgba(154, 92, 255, 0.1)),
			var(--workspace-panel, color-mix(in srgb, var(--color-ws-bg) 92%, transparent));
	}

	:global(.solo-blocker-strip.active),
	:global(.review-command-card.hot),
	.ownership-card.hot {
		border-color: rgba(255, 109, 145, 0.36);
		background:
			linear-gradient(90deg, rgba(255, 109, 145, 0.14), rgba(242, 83, 184, 0.08)),
			var(--workspace-panel, color-mix(in srgb, var(--color-ws-bg) 92%, transparent));
	}

	:global(.review-command-card.warn),
	.ownership-card.warn {
		border-color: rgba(255, 211, 106, 0.3);
		background:
			linear-gradient(90deg, rgba(255, 211, 106, 0.12), rgba(154, 92, 255, 0.07)),
			var(--workspace-panel, color-mix(in srgb, var(--color-ws-bg) 92%, transparent));
	}

	:global(.review-command-card.ready),
	.ownership-card.ready {
		border-color: rgba(137, 255, 181, 0.28);
		background:
			linear-gradient(90deg, rgba(137, 255, 181, 0.1), rgba(137, 255, 181, 0.06)),
			var(--workspace-panel, color-mix(in srgb, var(--color-ws-bg) 92%, transparent));
	}

	.work-board-grid :global(.priority-inbox),
	.work-board-grid :global(.assigned-work),
	.lane-panel {
		border-radius: var(--workspace-radius, 8px);
	}

	@media (max-width: 900px) {
		.work-title h1 {
			font-size: clamp(19px, 5vw, 24px);
		}
	}

	/* Flow369 Current+Luxe alignment: the export-readiness board keeps its distinctive
	   panel skin (card backgrounds / accent borders) but the FRAME — width, padding,
	   typeface, header size — comes from the shared `.ws-surface` + `.ws-surface-inner`
	   utilities so it lines up with every other workspace surface. */
	.work-title h1 {
		font-size: clamp(20px, 2.4vw, 26px);
		font-weight: 700;
		letter-spacing: -0.01em;
		line-height: 1.12;
	}

	.work-title span,
	.lane-head span,
	.chapter-readiness span,
	:global(.role-next-copy span),
	:global(.solo-blocker-copy span),
	.work-advanced-strip summary span,
	.ownership-head span,
	.ownership-card span,
	:global(.review-command-head span),
	:global(.review-command-copy span),
	.queue-overview summary span {
		color: color-mix(in srgb, var(--color-ws-accent) 78%, transparent);
		font-weight: 680;
		letter-spacing: 0.02em;
		text-transform: none;
	}

	.work-actions button,
	.work-route-menu summary,
	.work-route-menu button,
	.lane-head button,
	.chapter-readiness button,
	:global(.role-next-actions button),
	:global(.solo-blocker-actions button),
	.ownership-actions button,
	:global(.review-command-actions button) {
		border-color: var(--ws-hair);
		background: var(--color-ws-surface);
		font-weight: 720;
	}

	.work-actions button.primary,
	.chapter-readiness button.primary,
	:global(.solo-blocker-actions button.primary) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 44%, transparent);
		background: linear-gradient(135deg, var(--color-ws-accent), var(--color-ws-violet));
		color: var(--color-ws-ink);
		box-shadow: 0 16px 42px color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
	}

	.work-route-menu > div,
	.chapter-readiness,
	:global(.role-next-strip),
	:global(.solo-blocker-strip),
	.work-advanced-strip,
	.queue-overview,
	.lane-panel,
	.ownership-head,
	.ownership-card,
	:global(.review-command-head),
	:global(.review-command-card),
	.work-kpis span {
		border-color: var(--ws-hair);
		background: var(--color-ws-surface);
		box-shadow: none;
		backdrop-filter: blur(18px);
	}

	.chapter-readiness {
		padding: 18px;
		background:
			linear-gradient(90deg, rgba(244, 201, 93, 0.1), color-mix(in srgb, var(--color-ws-accent) 6%, transparent)),
			var(--color-ws-surface);
	}

	.chapter-readiness.ready {
		background:
			linear-gradient(90deg, rgba(52, 211, 153, 0.1), color-mix(in srgb, var(--color-ws-accent) 6%, transparent)),
			var(--color-ws-surface);
	}

	:global(.role-next-strip.active) {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background:
			linear-gradient(90deg, color-mix(in srgb, var(--color-ws-accent) 12%, transparent), color-mix(in srgb, var(--color-ws-accent) 6%, transparent)),
			var(--color-ws-surface);
	}

	:global(.solo-blocker-strip.active),
	:global(.review-command-card.hot),
	.ownership-card.hot {
		border-color: rgba(255, 107, 153, 0.3);
		background:
			linear-gradient(90deg, rgba(255, 107, 153, 0.11), color-mix(in srgb, var(--color-ws-accent) 5%, transparent)),
			var(--color-ws-surface);
	}

	:global(.review-command-card.warn),
	.ownership-card.warn {
		border-color: rgba(244, 201, 93, 0.3);
		background:
			linear-gradient(90deg, rgba(244, 201, 93, 0.1), color-mix(in srgb, var(--color-ws-accent) 5%, transparent)),
			var(--color-ws-surface);
	}

	.chapter-readiness strong,
	:global(.role-next-copy strong),
	:global(.solo-blocker-copy strong),
	.ownership-head strong,
	.ownership-card strong,
	:global(.review-command-head strong),
	:global(.review-command-copy strong),
	.lane-head h2,
	.queue-overview summary strong {
		font-weight: 760;
	}

	@media (max-width: 900px) {
		.work-title h1 {
			font-size: clamp(19px, 5vw, 24px);
		}
	}
</style>
