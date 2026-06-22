<script lang="ts">
	import { onMount, tick } from "svelte";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { projectStore, MAX_VERSION_LABEL_LENGTH, type LocalConflictRecoveryDraft } from "$lib/stores/project.svelte.ts";
	import {
		formatSignedDelta,
		formatVersionSource,
	} from "$lib/panels/right-panel-model.js";
	import { exportBlockerCopy } from "$lib/project/page-work-copy.js";
	import { resolvePageStatusText } from "$lib/project/page-work-copy-i18n.js";
	import { findAiResultPlacementMarker } from "$lib/project/ai-review-marker-intent.js";
	import {
		resolveVisiblePageLayerCount,
		summarizePageWork,
		type PageWorkSummary,
	} from "$lib/project/page-work-summary.js";
	import type { QcIssue } from "$lib/project/qc-checks.js";
	import type {
		AiReviewMarker,
		PageReviewDecision,
		ProjectComment,
		ProjectState,
		VersionReviewStatus,
		WorkflowTask,
	} from "$lib/types.js";
	import { _ } from "$lib/i18n";
	import { safeT } from "$lib/i18n/safeLocale";
	import PageNavigator from "./PageNavigator.svelte";
	import ChapterTeamManager from "./ChapterTeamManager.svelte";
	import ProjectUsagePanel from "./ProjectUsagePanel.svelte";
	import ProjectVersionsPanel from "./ProjectVersionsPanel.svelte";
	import VersionDiffPanel from "./VersionDiffPanel.svelte";
	import Dialog from "./ui/Dialog.svelte";
	import type { VersionRestoreScope } from "$lib/api/client.ts";

	type ProjectSummaryActionId = "library" | "pages" | "work" | "versions";
	type ProjectPanelSectionId = "pages" | "usage" | "recovery" | "versions";

	interface ProjectSummaryAction {
		title: string;
		detail: string;
		status: string;
		buttonLabel: string;
		actionId: ProjectSummaryActionId;
		tone: "attention" | "ready" | "quiet";
	}

	interface Props {
		labels: {
			pages: string;
		};
		openVersionId: string | null;
		openVersionToken: number;
		onOpenVersionHandled?: () => void;
	}

	let { labels, openVersionId, openVersionToken, onOpenVersionHandled }: Props = $props();

	let pagesOpen = $state(false);
	let teamOpen = $state(false);
	let usageOpen = $state(false);
	let recoveryOpen = $state(false);
	let versionsOpen = $state(false);
	let diffOpen = $state(false);
	let pagesSectionElement: HTMLDivElement | null = null;
	let usageSectionElement: HTMLDivElement | null = null;
	let recoverySectionElement: HTMLDivElement | null = null;
	let versionsSectionElement: HTMLDivElement | null = null;
	let projectSectionScrollFrame = 0;
	let versionReviewNote = $state("");
	let pendingRestoreVersionId = $state<string | null>(null);
	let pendingRecoveryDraftId = $state<string | null>(null);
	let projectPageCount = $derived(projectStore.project?.pages.length ?? 0);
	let activeProjectTaskCount = $derived(projectStore.tasks.filter((task) => task.status !== "done").length);
	let projectSurfaceCount = $derived(projectStore.workInbox.length + activeProjectTaskCount);
	let canOpenProjectPages = $derived(Boolean(projectStore.project));
	let canOpenProjectFocus = $derived(Boolean(projectStore.project) && projectSurfaceCount > 0);
	let openVersionReviewCount = $derived(
		projectStore.project?.versionReviewRequests?.filter((review) => review.status === "open").length ?? 0
	);
	let currentPage = $derived(
		projectStore.project ? projectStore.project.pages[projectStore.project.currentPage] ?? null : null
	);
	let projectPageSummaries = $derived.by(() => buildProjectPageSummaries(
		projectStore.project,
		projectStore.tasks,
		projectStore.comments,
		projectStore.aiReviewMarkers,
		projectStore.reviewDecisions,
		projectStore.qcReport.issues,
		editorStore.textLayers.length,
		editorStore.hasImage,
	));
	let firstAiPlacementBlockedPageSummary = $derived(projectPageSummaries.find(hasAiPlacementBlocker) ?? null);
	let currentProjectTitle = $derived(projectStore.project?.name ?? $_("projectMode.noProject"));
	let currentPageDetail = $derived(getCurrentPageDetail());
	let openWorkDetail = $derived(getOpenWorkDetail());
	let projectSummaryAction = $derived(getProjectSummaryAction());
	let pendingRestoreVersion = $derived(getPendingRestoreVersion());
	let pendingRecoveryDraft = $derived(getPendingRecoveryDraft());
	let recoveryDrafts = $derived(projectStore.conflictRecoveryDrafts);

	onMount(() => {
		projectStore.loadLocalConflictRecoveryDrafts();
		if (openVersionId && openVersionToken > 0) {
			void openVersionReviewTarget(openVersionId).finally(() => {
				onOpenVersionHandled?.();
			});
		}
		const handleResize = () => {
			scrollActiveProjectSectionAfterRender();
		};
		window.addEventListener("resize", handleResize);
		return () => {
			window.removeEventListener("resize", handleResize);
			if (projectSectionScrollFrame) {
				window.cancelAnimationFrame(projectSectionScrollFrame);
			}
		};
	});

	function formatVersionDate(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return $_("projectMode.unknownTime");
		return new Intl.DateTimeFormat("th-TH", {
			month: "short",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}

	function togglePages(): void {
		pagesOpen = !pagesOpen;
		if (pagesOpen) {
			usageOpen = false;
			recoveryOpen = false;
			versionsOpen = false;
			scrollProjectSectionAfterRender("pages");
		}
	}

	function toggleTeam(): void {
		teamOpen = !teamOpen;
		if (teamOpen) {
			pagesOpen = false;
			usageOpen = false;
			recoveryOpen = false;
			versionsOpen = false;
		}
	}

	function toggleUsage(): void {
		usageOpen = !usageOpen;
		if (usageOpen) {
			pagesOpen = false;
			recoveryOpen = false;
			versionsOpen = false;
			scrollProjectSectionAfterRender("usage");
		}
	}

	function toggleRecovery(): void {
		recoveryOpen = !recoveryOpen;
		projectStore.loadLocalConflictRecoveryDrafts();
		if (recoveryOpen) {
			pagesOpen = false;
			usageOpen = false;
			versionsOpen = false;
			scrollProjectSectionAfterRender("recovery");
		}
	}

	function toggleVersions(): void {
		versionsOpen = !versionsOpen;
		if (versionsOpen) {
			pagesOpen = false;
			usageOpen = false;
			recoveryOpen = false;
			scrollProjectSectionAfterRender("versions");
		}
		if (versionsOpen && projectStore.project) {
			void projectStore.loadVersions();
		}
	}

	function toggleDiff(): void {
		diffOpen = !diffOpen;
		if (diffOpen && projectStore.project) {
			void projectStore.loadVersions();
		}
		if (!diffOpen) {
			projectStore.clearVersionComparison();
		}
	}

	function scrollProjectSectionAfterRender(section: ProjectPanelSectionId): void {
		void tick().then(() => {
			const sectionElement = getProjectSectionElement(section);
			if (!sectionElement) return;
			scrollProjectSectionIntoView(sectionElement);
			if (projectSectionScrollFrame) {
				window.cancelAnimationFrame(projectSectionScrollFrame);
			}
			projectSectionScrollFrame = window.requestAnimationFrame(() => {
				projectSectionScrollFrame = 0;
				scrollProjectSectionIntoView(sectionElement);
			});
		});
	}

	function scrollActiveProjectSectionAfterRender(): void {
		const activeSection = getActiveProjectSection();
		if (activeSection) {
			scrollProjectSectionAfterRender(activeSection);
		}
	}

	function getActiveProjectSection(): ProjectPanelSectionId | null {
		if (pagesOpen) return "pages";
		if (usageOpen) return "usage";
		if (recoveryOpen) return "recovery";
		if (versionsOpen) return "versions";
		return null;
	}

	function scrollProjectSectionIntoView(sectionElement: HTMLDivElement): void {
		sectionElement.scrollIntoView?.({ block: "start", inline: "nearest" });
	}

	function getProjectSectionElement(section: ProjectPanelSectionId): HTMLDivElement | null {
		if (section === "pages") return pagesSectionElement;
		if (section === "usage") return usageSectionElement;
		if (section === "recovery") return recoverySectionElement;
		return versionsSectionElement;
	}

	async function refreshVersions(): Promise<void> {
		await projectStore.loadVersions();
	}

	async function saveNamedVersion(label: string): Promise<boolean> {
		return (await projectStore.saveNamedVersion(label)) !== null;
	}

	async function viewVersion(versionId: string): Promise<void> {
		versionReviewNote = "";
		await projectStore.loadVersionDetail(versionId);
	}

	async function openVersionReviewTarget(versionId: string): Promise<void> {
		pagesOpen = false;
		usageOpen = false;
		versionsOpen = true;
		scrollProjectSectionAfterRender("versions");
		await projectStore.loadVersions();
		if (!projectStore.versions.some((version) => version.versionId === versionId)) {
			versionReviewNote = "";
			projectStore.versionDetail = null;
				projectStore.setStatusMsg($_("projectMode.msgVersionReviewMissing"));
			return;
		}
		await viewVersion(versionId);
	}

	function updateVersionReviewNote(value: string): void {
		versionReviewNote = value;
	}

	function restoreVersion(versionId: string): void {
		pendingRestoreVersionId = versionId;
	}

	// W3.9: visual version-diff handlers.
	async function compareVersions(targetVersionId: string, baseVersionId?: string): Promise<void> {
		await projectStore.compareVersions(targetVersionId, baseVersionId);
	}

	function clearVersionComparison(): void {
		projectStore.clearVersionComparison();
	}

	function versionDiffImageUrl(imageId: string): string {
		return projectStore.getImageUrl(imageId);
	}

	async function restoreVersionScope(versionId: string, scope: VersionRestoreScope): Promise<void> {
		await projectStore.restoreVersion(versionId, editorStore.editor, scope);
		editorStore.selectedLayer = null;
		editorStore.selectedImageLayer = null;
		editorStore.refreshTextLayers();
		editorStore.refreshImageLayers();
	}

	function restoreRecoveryDraft(draftId: string): void {
		pendingRecoveryDraftId = draftId;
	}

	function cancelRestoreVersion(): void {
		pendingRestoreVersionId = null;
	}

	function cancelRestoreRecoveryDraft(): void {
		pendingRecoveryDraftId = null;
	}

	async function confirmRestoreVersion(): Promise<void> {
		const versionId = pendingRestoreVersionId;
		if (!versionId) return;
		pendingRestoreVersionId = null;
		await projectStore.restoreVersion(versionId, editorStore.editor);
		editorStore.selectedLayer = null;
		editorStore.refreshTextLayers();
	}

	async function confirmRestoreRecoveryDraft(): Promise<void> {
		const draftId = pendingRecoveryDraftId;
		if (!draftId) return;
		pendingRecoveryDraftId = null;
		const restored = await projectStore.restoreLocalConflictRecoveryDraft(draftId, editorStore.editor);
		if (restored) {
			editorStore.selectedLayer = null;
			editorStore.selectedImageLayer = null;
			editorStore.refreshTextLayers();
			editorStore.refreshImageLayers();
		}
	}

	function deleteRecoveryDraft(draftId: string): void {
		projectStore.deleteLocalConflictRecoveryDraft(draftId);
	}

	function getPendingRestoreVersion() {
		if (!pendingRestoreVersionId) return null;
		return projectStore.versions.find((version) => version.versionId === pendingRestoreVersionId)
			?? (projectStore.versionDetail?.version.versionId === pendingRestoreVersionId
				? projectStore.versionDetail.version
				: null);
	}

	function getPendingRecoveryDraft(): LocalConflictRecoveryDraft | null {
		if (!pendingRecoveryDraftId) return null;
		return recoveryDrafts.find((draft) => draft.id === pendingRecoveryDraftId) ?? null;
	}

	function getOpenVersionReview() {
		return projectStore.versionDetail?.reviews.find((review) => review.status === "open") ?? null;
	}

	async function requestVersionReview(): Promise<void> {
		const versionId = projectStore.versionDetail?.version.versionId;
		if (!versionId) return;
		const review = await projectStore.requestVersionReview(versionId, versionReviewNote);
		if (review) {
			versionReviewNote = "";
		}
	}

	async function decideVersionReview(status: VersionReviewStatus): Promise<void> {
		const versionId = projectStore.versionDetail?.version.versionId;
		const openReview = getOpenVersionReview();
		if (!versionId || !openReview) return;
		const review = await projectStore.updateVersionReview(versionId, openReview.id, status, versionReviewNote);
		if (review) {
			versionReviewNote = "";
		}
	}

	function openProjectBrowser(): void {
		editorUiStore.openLibrary();
		queueWorkspaceNavigation({ view: "library" });
	}

	function openProjectPages(): void {
		if (!projectStore.project) return;
		editorUiStore.openPages();
		queueWorkspaceNavigation({
			view: "pages",
			projectId: projectStore.project.projectId,
		});
	}

	function openProjectExportHistory(): void {
		if (!projectStore.project) return;
		editorUiStore.openPages({ exportHistory: true });
		queueWorkspaceNavigation({
			view: "pages",
			projectId: projectStore.project.projectId,
		});
	}

	function openProjectWork(): void {
		if (!canOpenProjectFocus || !projectStore.project) return;
		editorUiStore.openWorkBoard();
		queueWorkspaceNavigation({
			view: "work",
			projectId: projectStore.project.projectId,
		});
	}

	function openVersionInspector(): void {
		pagesOpen = false;
		usageOpen = false;
		versionsOpen = true;
		scrollProjectSectionAfterRender("versions");
		if (projectStore.project) {
			void projectStore.loadVersions();
		}
	}

	function runProjectSummaryAction(): void {
		if (projectSummaryAction.actionId === "pages" && firstAiPlacementBlockedPageSummary) {
			void openAiPlacementFromProjectSummary(firstAiPlacementBlockedPageSummary);
			return;
		}
		if (projectSummaryAction.actionId === "library") {
			openProjectBrowser();
			return;
		}
		if (projectSummaryAction.actionId === "pages") {
			openProjectPages();
			return;
		}
		if (projectSummaryAction.actionId === "work") {
			openProjectWork();
			return;
		}
		openVersionInspector();
	}

	async function openAiPlacementFromProjectSummary(summary: PageWorkSummary): Promise<void> {
		if (!projectStore.project) return;
		const marker = findAiResultPlacementMarker(projectStore.project, projectStore.aiReviewMarkers, summary.pageIndex);
		if (!marker) {
			openProjectPages();
			return;
		}
		const opened = projectStore.project.currentPage === summary.pageIndex
			? true
			: await projectStore.goToPage(summary.pageIndex, editorStore.editor);
		if (!opened) return;
		editorStore.refreshTextLayers();
		projectStore.selectAiReviewMarker(marker.id);
		editorStore.editor?.focusImageRegion?.(marker.region);
		editorUiStore.setRightPanelMode("layers");
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex: summary.pageIndex,
		});
		projectStore.setStatusMsg(marker.status === "applied" ? $_("projectMode.msgAiLayerRecoveryOpened") : $_("projectMode.msgAiLayerPlacementOpened"));
	}

	function getCurrentPageDetail(): string {
		if (!projectStore.project) return $_("projectMode.openLibraryToPick");
		return $_("projectMode.pageProgress", { values: { current: projectStore.project.currentPage + 1, total: projectStore.project.pages.length } });
	}

	function getOpenWorkDetail(): string {
		if (!projectStore.project) return $_("projectMode.noWorkQueue");
		if (projectSurfaceCount === 0) return $_("projectMode.noPendingWork");
		return $_("projectMode.workDetailCounts", { values: { inbox: projectStore.workInbox.length, tasks: activeProjectTaskCount } });
	}

	function buildProjectPageSummaries(
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

	function hasAiPlacementBlocker(summary: PageWorkSummary): boolean {
		return summary.exportBlockers.some((blocker) => (
			blocker.includes("accepted AI result not placed")
			|| blocker.includes("applied AI layer missing")
		));
	}

	function getProjectSummaryAction(): ProjectSummaryAction {
		if (!projectStore.project) {
			return {
				title: $_("projectMode.summaryNoProjectTitle"),
				detail: $_("projectMode.summaryNoProjectDetail"),
				status: $_("projectMode.statusNoProject"),
				buttonLabel: $_("projectMode.openLibrary"),
				actionId: "library",
				tone: "quiet",
			};
		}
		if (firstAiPlacementBlockedPageSummary) {
			const firstReason = firstAiPlacementBlockedPageSummary.exportBlockers.find((blocker) => (
				blocker.includes("accepted AI result not placed")
				|| blocker.includes("applied AI layer missing")
			)) ?? firstAiPlacementBlockedPageSummary.nextAction;
			const reasonCopy = firstAiPlacementBlockedPageSummary.exportBlockers.length
				? exportBlockerCopy(firstReason)
				: resolvePageStatusText(firstAiPlacementBlockedPageSummary.statusLabel, $_, $_("pageWork.statusFallback"));
			return {
				title: $_("projectMode.summaryBlockedTitle", { values: { page: firstAiPlacementBlockedPageSummary.pageNumber, reason: reasonCopy } }),
				detail: resolvePageStatusText(firstAiPlacementBlockedPageSummary.statusLabel, $_, $_("pageWork.statusFallback")),
				status: $_("projectMode.statusExportNotReady"),
					buttonLabel: firstAiPlacementBlockedPageSummary.nextAction === "Place accepted AI result layer" ? $_("projectMode.placeAiLayer") : $_("projectMode.openChapterPages"),
				actionId: "pages",
				tone: "attention",
			};
		}
		if (openVersionReviewCount > 0) {
			return {
				title: $_("projectMode.summaryVersionReviewTitle"),
				detail: $_("projectMode.summaryVersionReviewDetail", { values: { n: openVersionReviewCount } }),
				status: $_("projectMode.statusVersionReview"),
				buttonLabel: $_("projectMode.openVersions"),
				actionId: "versions",
				tone: "attention",
			};
		}
		if (projectSurfaceCount > 0) {
			return {
				title: $_("projectMode.summaryPendingWorkTitle"),
				detail: openWorkDetail,
				status: $_("projectMode.statusProduction"),
				buttonLabel: $_("projectMode.openTeamBoard"),
				actionId: "work",
				tone: "ready",
			};
		}
		return {
			title: $_("projectMode.summaryReadyTitle"),
			detail: $_("projectMode.summaryReadyDetail"),
			status: "Clear",
			buttonLabel: $_("projectMode.openChapterPages"),
			actionId: "pages",
			tone: "quiet",
		};
	}
</script>

<div class="project-mode-panel">
	<section class="project-command-card ws-panel" aria-label={$_("projectMode.workSummaryLabel")}>
		<div class="project-command-copy">
			<span>{$_("projectMode.workSummary")}</span>
			<strong>{currentProjectTitle}</strong>
			<small>{currentPageDetail}</small>
		</div>

		<div class={`project-next-action ${projectSummaryAction.tone}`}>
			<div>
				<span>{projectSummaryAction.status}</span>
				<strong>{projectSummaryAction.title}</strong>
				<small>{projectSummaryAction.detail}</small>
			</div>
			<button type="button" class="ws-grad-primary" onclick={runProjectSummaryAction}>
				{projectSummaryAction.buttonLabel}
			</button>
		</div>

		<div class="project-context-grid" aria-label={$_("projectMode.workContextLabel")}>
			<div>
				<span>{$_("projectMode.currentPage")}</span>
				<strong>{projectStore.project ? projectStore.pageLabel : $_("projectMode.noPage")}</strong>
				<small>{projectStore.project ? $_("projectMode.chapterPage") : $_("projectMode.openProjectFirst")}</small>
			</div>
			<div class:attention={projectSurfaceCount > 0}>
				<span>{$_("projectMode.openWork")}</span>
				<strong>{projectSurfaceCount}</strong>
				<small>{openWorkDetail}</small>
			</div>
			<div class:attention={openVersionReviewCount > 0}>
				<span>{$_("projectMode.versionReview")}</span>
				<strong>{openVersionReviewCount}</strong>
				<small>{openVersionReviewCount > 0 ? $_("projectMode.versionReviewOpen") : $_("projectMode.noVersionReview")}</small>
			</div>
		</div>

		<div class="project-surface-actions" aria-label={$_("projectMode.surfaceShortcutsLabel")}>
			<button type="button" class="ws-btn-ghost" onclick={openProjectBrowser}>
				<strong>{$_("projectMode.workLibrary")}</strong>
				<small>{$_("projectMode.pickChapter")}</small>
			</button>
			{#if canOpenProjectPages}
				<button type="button" class="ws-btn-ghost" onclick={openProjectPages}>
					<strong>{$_("projectMode.chapterPages")}</strong>
					<small>{$_("projectMode.pagesInQueue", { values: { n: projectPageCount } })}</small>
				</button>
			{:else}
				<span class="project-action-receipt ws-panel-quiet">
					<strong>{$_("projectMode.chapterPages")}</strong>
					<small>{$_("projectMode.openProjectFirst")}</small>
				</span>
			{/if}
			{#if canOpenProjectFocus}
				<button type="button" class="ws-btn-ghost" onclick={openProjectWork}>
					<strong>{$_("projectMode.teamBoard")}</strong>
					<small>{$_("projectMode.openTasksCount", { values: { n: projectSurfaceCount } })}</small>
				</button>
			{:else}
				<span class="project-action-receipt ws-panel-quiet">
					<strong>{$_("projectMode.teamBoard")}</strong>
					<small>{projectStore.project ? $_("projectMode.noPendingWorkShort") : $_("projectMode.openProjectFirst")}</small>
				</span>
			{/if}
		</div>
	</section>

	<div class="panel-section ws-panel" bind:this={pagesSectionElement}>
		<button
			type="button"
			class="panel-section-header project-section-header"
			aria-label={`${$_("projectMode.sectionPages")} ${pagesOpen ? $_("projectMode.sectionOpen") : $_("projectMode.sectionClosed")}`}
			aria-expanded={pagesOpen}
			onclick={togglePages}
		>
			<span class="project-section-copy">
				<span>{labels.pages}</span>
				<small>{$_("projectMode.pagesSectionHint", { values: { n: projectPageCount } })}</small>
			</span>
			<span class="project-section-meter">{projectStore.project ? projectStore.pageLabel : $_("projectMode.noProject")}</span>
			<span class="project-section-chevron" class:open={pagesOpen} aria-hidden="true"></span>
		</button>
		{#if pagesOpen}
			<div class="panel-section-body">
				<PageNavigator />
			</div>
		{/if}
	</div>

	<div class="panel-section ws-panel">
		<button
			type="button"
			class="panel-section-header project-section-header"
			aria-label={`${safeT("chapterTeam.title", "Chapter team")} ${teamOpen ? $_("projectMode.sectionOpen") : $_("projectMode.sectionClosed")}`}
			aria-expanded={teamOpen}
			onclick={toggleTeam}
		>
			<span class="project-section-copy">
				<span>{safeT("chapterTeam.title", "Chapter team")}</span>
				<small>{safeT("chapterTeam.manageHint", "Switch Solo/Team, invite by email or UID, edit later")}</small>
			</span>
			<span class="project-section-meter">
				{(projectStore.project?.productionMode ?? "solo") === "team"
					? safeT("chapterTeam.team", "Team")
					: safeT("chapterTeam.solo", "Solo")}
			</span>
			<span class="project-section-chevron" class:open={teamOpen} aria-hidden="true"></span>
		</button>
		{#if teamOpen}
			<div class="panel-section-body">
				{#if projectStore.project}
					{#key projectStore.project.projectId}
						<ChapterTeamManager mode="manage" projectId={projectStore.project.projectId} />
					{/key}
				{:else}
					<p class="ct-panel-empty">{safeT("chapterTeam.openProjectFirst", "Open a chapter to manage its team.")}</p>
				{/if}
			</div>
		{/if}
	</div>

	<div class="panel-section ws-panel" bind:this={usageSectionElement}>
		<button
			type="button"
			class="panel-section-header project-section-header"
			aria-label={`${$_("projectMode.sectionUsage")} ${usageOpen ? $_("projectMode.sectionOpen") : $_("projectMode.sectionClosed")}`}
			aria-expanded={usageOpen}
			onclick={toggleUsage}
		>
			<span class="project-section-copy">
				<span>{$_("projectMode.usage")}</span>
				<small>{$_("projectMode.usageHint")}</small>
			</span>
			<span class="project-section-meter">{$_("projectMode.quota")}</span>
			<span class="project-section-chevron" class:open={usageOpen} aria-hidden="true"></span>
		</button>
		{#if usageOpen}
			<div class="panel-section-body">
				{#key projectStore.project?.projectId ?? "no-project"}
					<ProjectUsagePanel
						projectId={projectStore.project?.projectId ?? null}
						projectOpen={Boolean(projectStore.project)}
						onReviewStoredExports={openProjectExportHistory}
					/>
				{/key}
			</div>
		{/if}
	</div>

	<div class="panel-section ws-panel" bind:this={recoverySectionElement}>
		<button
			type="button"
			class="panel-section-header project-section-header"
			aria-label={`${$_("projectMode.sectionRecovery")} ${recoveryOpen ? $_("projectMode.sectionOpen") : $_("projectMode.sectionClosed")}`}
			aria-expanded={recoveryOpen}
			onclick={toggleRecovery}
		>
			<span class="project-section-copy">
				<span>{$_("projectMode.recovery")}</span>
				<small>{$_("projectMode.recoveryHint", { values: { n: recoveryDrafts.length } })}</small>
			</span>
			<span class:attention={recoveryDrafts.length > 0} class="project-section-meter">
				{recoveryDrafts.length > 0 ? $_("projectMode.draftCount", { values: { n: recoveryDrafts.length } }) : $_("projectMode.none")}
			</span>
			<span class="project-section-chevron" class:open={recoveryOpen} aria-hidden="true"></span>
		</button>
		{#if recoveryOpen}
			<div class="panel-section-body">
				{#if recoveryDrafts.length === 0}
					<div class="recovery-empty">
						<strong>{$_("projectMode.recoveryEmptyTitle")}</strong>
						<small>{$_("projectMode.recoveryEmptyDetail")}</small>
					</div>
				{:else}
					<div class="recovery-draft-list" aria-label={$_("projectMode.recoveryListLabel")}>
						{#each recoveryDrafts as draft (draft.id)}
							<article class="recovery-draft-card">
								<div>
									<span>{formatVersionDate(draft.exportedAt)}</span>
									<strong>{draft.projectName}</strong>
									<small>
										{$_("projectMode.draftSummary", { values: { pages: draft.pageCount, text: draft.textLayerCount, images: draft.imageLayerCount } })}
									</small>
								</div>
								<div class="recovery-draft-actions">
									<button type="button" class="ws-grad-primary" onclick={() => restoreRecoveryDraft(draft.id)}>{$_("projectMode.restore")}</button>
									<button type="button" class="quiet ws-btn-ghost" onclick={() => deleteRecoveryDraft(draft.id)}>{$_("projectMode.delete")}</button>
								</div>
							</article>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<div class="panel-section ws-panel" bind:this={versionsSectionElement}>
		<button
			type="button"
			class="panel-section-header project-section-header"
			aria-label={`${$_("projectMode.sectionVersions")} ${versionsOpen ? $_("projectMode.sectionOpen") : $_("projectMode.sectionClosed")}`}
			aria-expanded={versionsOpen}
			onclick={toggleVersions}
		>
			<span class="project-section-copy">
				<span>{$_("projectMode.versions")}</span>
				<small>{$_("projectMode.versionsHint", { values: { saves: projectStore.versions.length, reviews: openVersionReviewCount } })}</small>
			</span>
			<span class:attention={openVersionReviewCount > 0} class="project-section-meter">
					{openVersionReviewCount > 0 ? $_("projectMode.versionsPending", { values: { n: openVersionReviewCount } }) : $_("projectMode.history")}
			</span>
			<span class="project-section-chevron" class:open={versionsOpen} aria-hidden="true"></span>
		</button>
		{#if versionsOpen}
			<div class="panel-section-body">
				<ProjectVersionsPanel
					projectOpen={Boolean(projectStore.project)}
					versionsLoading={projectStore.versionsLoading}
					versionDetailLoading={projectStore.versionDetailLoading}
					versionReviewLoading={projectStore.versionReviewLoading}
					versions={projectStore.versions}
					versionDetail={projectStore.versionDetail}
					reviewNote={versionReviewNote}
					maxLabelLength={MAX_VERSION_LABEL_LENGTH}
					formatSource={formatVersionSource}
					formatDate={formatVersionDate}
					formatDelta={formatSignedDelta}
					onRefresh={refreshVersions}
					onSaveVersion={saveNamedVersion}
					onViewVersion={viewVersion}
					onRestoreVersion={restoreVersion}
					onReviewNoteChange={updateVersionReviewNote}
					onRequestReview={requestVersionReview}
					onDecideReview={decideVersionReview}
				/>

				<div class="version-diff-subsection">
					<button
						type="button"
						class="version-diff-toggle"
						aria-label={`${$_("projectMode.compareVersions")} ${diffOpen ? $_("projectMode.sectionOpen") : $_("projectMode.sectionClosed")}`}
						aria-expanded={diffOpen}
						onclick={toggleDiff}
					>
						<span>{$_("projectMode.compareVersionsAndRestore")}</span>
						<span class="version-diff-chevron" class:open={diffOpen} aria-hidden="true"></span>
					</button>
					{#if diffOpen}
						<VersionDiffPanel
							projectOpen={Boolean(projectStore.project)}
							projectId={projectStore.project?.projectId ?? null}
							versions={projectStore.versions}
							comparison={projectStore.versionComparison}
							comparisonLoading={projectStore.versionComparisonLoading}
							formatSource={formatVersionSource}
							formatDate={formatVersionDate}
							imageUrl={versionDiffImageUrl}
							onCompare={compareVersions}
							onClear={clearVersionComparison}
							onRestoreScope={restoreVersionScope}
						/>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>

<Dialog
	open={Boolean(pendingRestoreVersionId)}
	onClose={cancelRestoreVersion}
	size="sm"
	eyebrow={$_("projectMode.restoreVersionEyebrow")}
	title={$_("projectMode.restoreVersionTitle")}
	description={$_("projectMode.restoreVersionDescription")}
>
	<div class="restore-version-meta">
		<strong>{pendingRestoreVersion ? formatVersionSource(pendingRestoreVersion.source) : $_("projectMode.selectedSavePoint")}</strong>
		<small>{pendingRestoreVersion ? formatVersionDate(pendingRestoreVersion.createdAt) : pendingRestoreVersionId}</small>
	</div>
	{#snippet footer()}
		<button type="button" class="ws-dialog-btn" onclick={cancelRestoreVersion}>{$_("projectMode.cancel")}</button>
		<button type="button" class="ws-dialog-btn ws-dialog-btn-danger" onclick={confirmRestoreVersion}>{$_("projectMode.confirmRestoreVersion")}</button>
	{/snippet}
</Dialog>

<Dialog
	open={Boolean(pendingRecoveryDraftId)}
	onClose={cancelRestoreRecoveryDraft}
	size="sm"
	eyebrow={$_("projectMode.restoreDraftEyebrow")}
	title={$_("projectMode.restoreDraftTitle")}
	description={$_("projectMode.restoreDraftDescription")}
>
	<div class="restore-version-meta">
		<strong>{pendingRecoveryDraft?.projectName ?? $_("projectMode.selectedDraft")}</strong>
		<small>
			{pendingRecoveryDraft
				? $_("projectMode.draftDateMeta", { values: { date: formatVersionDate(pendingRecoveryDraft.exportedAt), pages: pendingRecoveryDraft.pageCount } })
				: pendingRecoveryDraftId}
		</small>
	</div>
	{#snippet footer()}
		<button type="button" class="ws-dialog-btn" onclick={cancelRestoreRecoveryDraft}>{$_("projectMode.cancel")}</button>
		<button type="button" class="ws-dialog-btn ws-dialog-btn-danger" onclick={confirmRestoreRecoveryDraft}>{$_("projectMode.confirmRestoreDraft")}</button>
	{/snippet}
</Dialog>

<style>
	.project-mode-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.project-command-card {
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

	.project-command-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
	}

	.project-command-copy > span {
		color: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
		font-size: 10px;
		font-weight: 850;
		text-transform: none;
	}

	.project-command-copy strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 16px;
		font-weight: 780;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.project-command-copy small {
		display: -webkit-box;
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 11px;
		line-height: 1.35;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.project-next-action {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 92px;
		align-items: center;
		gap: 9px;
		padding: 9px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 50%, transparent);
	}

	.project-next-action.attention {
		border-color: color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
	}

	.project-next-action.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 8%, transparent);
	}

	.project-next-action > div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.project-next-action span {
		color: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
		font-size: 9px;
		font-weight: 850;
		text-transform: none;
	}

	.project-next-action.attention span {
		color: var(--color-ws-amber);
	}

	.project-next-action.ready span {
		color: var(--color-ws-green);
	}

	.project-next-action strong,
	.project-next-action small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.project-next-action strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 820;
		white-space: nowrap;
	}

	.project-next-action small {
		display: -webkit-box;
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.project-next-action button {
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

	.project-next-action button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 66%, transparent);
		filter: brightness(1.06);
	}

	.project-context-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.project-context-grid div {
		display: flex;
		flex: 1 1 86px;
		min-width: 0;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 5px 7px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-bg) 46%, transparent);
	}

	.project-context-grid div.attention {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 9%, transparent);
	}

	.project-context-grid span {
		color: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
		font-size: 9px;
		font-weight: 850;
		line-height: 1.2;
		text-transform: none;
	}

	.project-context-grid div.attention span {
		color: var(--color-ws-amber);
	}

	.project-context-grid strong,
	.project-context-grid small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.project-context-grid strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
		white-space: nowrap;
	}

	.project-context-grid small {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
		color: var(--color-ws-text);
		font-size: 9px;
	}

	.project-surface-actions {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 7px;
	}

	.project-surface-actions button {
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

	.project-surface-actions button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
	}

	.project-action-receipt {
		display: flex;
		min-height: 48px;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		padding: 7px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-faint) 22%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 42%, transparent);
		color: color-mix(in srgb, var(--color-ws-text) 72%, transparent);
	}

	.project-surface-actions strong,
	.project-action-receipt strong,
	.project-surface-actions small,
	.project-action-receipt small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.project-surface-actions strong,
	.project-action-receipt strong {
		font-size: 11px;
		font-weight: 850;
	}

	.project-surface-actions small,
	.project-action-receipt small {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 720;
	}

	.project-section-header {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 18px;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		text-transform: none;
	}

	.project-section-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.project-section-copy > span {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
		text-overflow: ellipsis;
		text-transform: none;
		white-space: nowrap;
	}

	.project-section-copy small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 650;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: none;
	}

	.project-section-meter {
		min-width: 0;
		max-width: 118px;
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

	.project-section-meter.attention {
		border-color: color-mix(in srgb, var(--color-ws-amber) 36%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 11%, transparent);
		color: var(--color-ws-amber);
	}

	.project-section-chevron {
		justify-self: end;
		width: 7px;
		height: 7px;
		border-right: 1.5px solid var(--color-ws-text);
		border-bottom: 1.5px solid var(--color-ws-text);
		transform: rotate(-45deg);
		transition: transform 120ms ease, border-color 120ms ease;
	}

	.project-section-header:hover .project-section-chevron,
	.project-section-chevron.open {
		border-color: var(--color-ws-ink);
	}

	.project-section-chevron.open {
		transform: rotate(45deg);
	}

	.version-diff-subsection {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--ws-hair-strong);
	}

	.version-diff-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		min-height: 36px;
		padding: 8px 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 48%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 800;
		cursor: pointer;
	}

	.version-diff-chevron {
		width: 7px;
		height: 7px;
		border-right: 1.5px solid var(--color-ws-text);
		border-bottom: 1.5px solid var(--color-ws-text);
		transform: rotate(-45deg);
		transition: transform 120ms ease, border-color 120ms ease;
	}

	.version-diff-toggle:hover .version-diff-chevron,
	.version-diff-chevron.open {
		border-color: var(--color-ws-ink);
	}

	.version-diff-chevron.open {
		transform: rotate(45deg);
	}

	.recovery-empty,
	.recovery-draft-card {
		padding: 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 54%, transparent);
	}

	.recovery-empty,
	.recovery-draft-card > div:first-child {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.recovery-empty strong,
	.recovery-draft-card strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.recovery-empty small,
	.recovery-draft-card small {
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.35;
	}

	.recovery-draft-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.recovery-draft-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
	}

	.recovery-draft-card span {
		color: var(--color-ws-amber);
		font-size: 10px;
		font-weight: 850;
	}

	.recovery-draft-actions {
		display: flex;
		gap: 6px;
	}

	.recovery-draft-actions button {
		min-width: 44px;
		min-height: 36px;
		padding: 0 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
	}

	.recovery-draft-actions button.quiet {
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
		color: var(--color-ws-text);
	}

	.restore-version-meta {
		display: grid;
		gap: 3px;
		padding: 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
	}

	.restore-version-meta strong {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 850;
	}

	.restore-version-meta small {
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 720;
	}
</style>
