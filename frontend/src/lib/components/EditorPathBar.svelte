<script lang="ts">
	import { _ } from "$lib/i18n";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import LanguageTrackSwitcher from "$lib/components/LanguageTrackSwitcher.svelte";
	import AddLanguageTrackDialog from "$lib/components/AddLanguageTrackDialog.svelte";
	import { isAiResultImageLayer } from "$lib/types.js";
	import type { WorkflowTask } from "$lib/types.js";
	import { normalizeAssigneeHandle } from "$lib/project/assignees.js";
	import { buildTaskFocusQueue, type TaskFocusItem } from "$lib/project/task-focus-queue.js";
	import { workInboxTitle } from "$lib/project/work-inbox-copy.js";
	import { resolvePageStatusText } from "$lib/project/page-work-copy-i18n.js";
	import {
		resolveVisiblePageLayerCount,
		summarizePageWork,
		type PageWorkSummary,
	} from "$lib/project/page-work-summary.js";

	let currentPage = $derived(projectStore.project?.pages[projectStore.project.currentPage] ?? null);
	let workspaceName = $derived(workspacesStore.currentWorkspace?.name?.trim() || "Workspace");
	let pageNumber = $derived((projectStore.project?.currentPage ?? 0) + 1);
	let pageCount = $derived(projectStore.project?.pages.length ?? 0);
	let title = $derived(projectStore.project?.name?.trim() || "Untitled manga");
	let language = $derived(projectStore.activeTargetLang.toUpperCase());
	let pageImageName = $derived(compactFileLabel(currentPage?.originalName ?? currentPage?.imageName));
	let pageName = $derived($_("editorPathBar.pageN", { values: { n: pageNumber } }));
	let pageToolsOpen = $state(false);
	let languageDialogOpen = $state(false);

	let breadcrumbs = $derived.by(() => {
		let storyName = $_("editorPathBar.newManga");
		let chapterLabel = $_("editorPathBar.chapterOne");

		if (editorEntry) {
			storyName = editorEntry.title || $_("editorPathBar.newManga");
			chapterLabel = editorEntry.chapterLabel || $_("editorPathBar.chapterOne");
		} else {
			const parts = title.split(/\s*-\s*/);
			if (parts.length >= 2) {
				storyName = parts[0];
				chapterLabel = parts[1];
			} else {
				storyName = title;
				chapterLabel = $_("editorPathBar.currentChapter");
			}
		}
		return { story: storyName, chapter: chapterLabel, page: $_("editorPathBar.pageN", { values: { n: pageNumber } }) };
	});
	let currentPageSummary = $derived(buildCurrentPageSummary());
	let workflowStatusLabel = $derived(resolvePageStatusText(currentPageSummary?.statusLabel, $_, $_("pageWork.statusFallback")));
	let selectedLayerSummary = $derived(resolveSelectedLayerSummary());
	let nearbyPages = $derived(buildNearbyPageChips());
	let taskFocusItems = $derived(buildTaskFocusQueue(projectStore.workInbox, projectStore.tasks));
	let currentPageFocusItem = $derived(resolveCurrentPageFocusItem());
	// Issue #10c: the worker's OWN open task for the page they're editing, so they
	// can mark it done + hand off without going back to the board. Matches the
	// board's dual-handle "mine" rule (email OR userId) and pipeline order.
	let myHandles = $derived(
		new Set(
			[authStore.user?.email, authStore.user?.id]
				.map((h) => normalizeAssigneeHandle(h ?? ""))
				.filter((h): h is string => Boolean(h)),
		),
	);
	let myPageTask = $derived.by<WorkflowTask | null>(() => resolveMyPageTask());
	let submittingPageTask = $state(false);
	// Only a team workspace has a duty pipeline to hand off into (matches the board).
	let canSubmitPageTask = $derived(Boolean(myPageTask) && editorUiStore.workspaceMode === "team");
	// Name the stage being submitted so the worker knows which task they're closing
	// (a page can carry several of their stages).
	const STAGE_LABEL_KEY: Record<WorkflowTask["type"], string> = {
		clean: "workBoardV2.colClean",
		translate: "workBoardV2.colTranslate",
		typeset: "workBoardV2.colTypeset",
		review: "workBoardV2.colReview",
	};
	let myPageTaskStageLabel = $derived(myPageTask ? $_(STAGE_LABEL_KEY[myPageTask.type]) : "");
	let editorReadinessAction = $derived(resolveEditorReadinessAction());
	let openTaskCount = $derived(currentPageSummary?.taskOpenCount ?? 0);
	let openCommentCount = $derived(currentPageSummary?.openCommentCount ?? 0);
	let aiAttentionCount = $derived(currentPageSummary?.aiAttentionCount ?? 0);
	let qcAttentionCount = $derived(currentPageSummary
		? currentPageSummary.qcErrorCount + currentPageSummary.qcWarningCount
		: 0);
	let currentPageSignalCount = $derived(
		openTaskCount
			+ openCommentCount
			+ aiAttentionCount
			+ qcAttentionCount,
	);
	let pathSignalDetail = $derived(buildPathSignalDetail());
	let pathSignalSummary = $derived(
		currentPageSignalCount > 0
			? $_("editorPathBar.signalNeedsCheck", { values: { count: currentPageSignalCount } })
			: $_("editorPathBar.signalLayers", { values: { count: currentPageSummary?.layerCount ?? 0 } }),
	);
	let saveActionBusy = $derived(projectStore.saveSyncStatus === "saving");
	let saveActionLabel = $derived(
		projectStore.saveSyncStatus === "saving"
			? $_("editorPathBar.saveSaving")
			: projectStore.saveSyncStatus === "error"
				? projectStore.saveErrorKind === "conflict"
					? $_("editorPathBar.saveReload")
					: $_("editorPathBar.saveRetry")
				: $_("editorPathBar.save")
	);
	let saveActionMeta = $derived(
		projectStore.saveSyncStatus === "saving"
			? $_("editorPathBar.metaSyncing")
			: projectStore.saveSyncStatus === "error"
				? projectStore.saveErrorKind === "conflict"
					? $_("editorPathBar.metaConflict")
					: $_("editorPathBar.metaFailed")
				: projectStore.saveSyncStatus === "unsaved"
					? $_("editorPathBar.metaUnsaved")
					: $_("editorPathBar.metaSaved")
	);
	let hasSaveConflict = $derived(projectStore.saveSyncStatus === "error" && saveActionLabel === $_("editorPathBar.saveReload"));
	let workflowOwnsSaveAction = $derived(
		projectStore.saveSyncStatus === "unsaved" || projectStore.saveSyncStatus === "error"
	);
	let workPanelOwnsCurrentPageFocus = $derived(
		editorUiStore.workspaceMode === "team"
		&& editorUiStore.rightPanelMode === "work"
		&& Boolean(currentPageFocusItem)
		&& projectStore.saveSyncStatus === "saved"
	);
	let editorEntry = $derived(resolveEditorEntry());
	let editorEntryLabel = $derived(
		editorEntry
			? `${editorEntry.title} / ${editorEntry.chapterLabel} / ${editorEntry.language.toUpperCase()}`
			: "",
	);
	let editorStarterActionActive = $derived(Boolean(
		editorStore.hasImage
		&& projectStore.saveSyncStatus === "saved"
		&& !editorStore.selectedLayer
		&& !editorStore.selectedImageLayer
		&& editorStore.textLayers.length === 0
		&& editorStore.imageLayers.length === 0
		&& currentPageSummary?.status !== "blocked"
	));

	function compactFileLabel(value: string | null | undefined): string {
		const text = value?.trim();
		if (!text) return $_("editorPathBar.noPageImage");
		if (text.length <= 34) return text;
		const dotIndex = text.lastIndexOf(".");
		const extension = dotIndex > 0 && text.length - dotIndex <= 8 ? text.slice(dotIndex) : "";
		const basename = extension ? text.slice(0, dotIndex) : text;
		return `${basename.slice(0, 14)}...${basename.slice(-10)}${extension}`;
	}

	function buildCurrentPageSummary(): PageWorkSummary | null {
		if (!projectStore.project || !currentPage) return null;
		const pageIndex = projectStore.project.currentPage;
		return summarizePageWork({
			page: currentPage,
			pageIndex,
			layerCount: resolveVisiblePageLayerCount(
				currentPage,
				true,
				editorStore.textLayers.length,
				editorStore.hasImage,
			),
			assetIntegrity: projectStore.getPageAssetIntegrity(pageIndex),
			qcIssues: projectStore.qcReport.issues,
			tasks: projectStore.tasks,
			comments: projectStore.comments,
			aiReviewMarkers: projectStore.aiReviewMarkers,
			reviewDecisions: projectStore.reviewDecisions,
			productionMode: projectStore.project.productionMode ?? "solo",
		});
	}

	function buildNearbyPageChips(): PageWorkSummary[] {
		const project = projectStore.project;
		if (!project) return [];
		const end = Math.min(project.pages.length, project.currentPage + 3);
		const start = Math.max(0, Math.min(project.currentPage - 2, end - 5));
		return project.pages.slice(start, end).map((page, offset) => {
			const pageIndex = start + offset;
			return summarizePageWork({
				page,
				pageIndex,
				layerCount: resolveVisiblePageLayerCount(
					page,
					pageIndex === project.currentPage,
					editorStore.textLayers.length,
					editorStore.hasImage,
				),
				assetIntegrity: projectStore.getPageAssetIntegrity(pageIndex),
				qcIssues: projectStore.qcReport.issues,
				tasks: projectStore.tasks,
				comments: projectStore.comments,
				aiReviewMarkers: projectStore.aiReviewMarkers,
				reviewDecisions: projectStore.reviewDecisions,
				productionMode: project.productionMode ?? "solo",
			});
		});
	}

	function buildPathSignalDetail(): string {
		const parts = [$_("editorPathBar.signalLayers", { values: { count: currentPageSummary?.layerCount ?? 0 } })];
		if (openTaskCount > 0) parts.push($_("editorPathBar.signalTasks", { values: { count: openTaskCount } }));
		if (openCommentCount > 0) parts.push($_("editorPathBar.signalNotes", { values: { count: openCommentCount } }));
		if (aiAttentionCount > 0) parts.push(`${aiAttentionCount} AI`);
		if (qcAttentionCount > 0) parts.push(`${qcAttentionCount} QC`);
		if (parts.length === 1) parts.push($_("editorPathBar.noPendingSignals"));
		return parts.join(" / ");
	}

	function pageStatusClass(summary: PageWorkSummary | null): string {
		if (!summary) return "empty";
		return summary.status;
	}

	function resolveSelectedLayerSummary(): { detail: string; kind: "base" | "image" | "text"; label: string } {
		const workPanelOwnsSelectionReceipt = editorUiStore.workspaceMode === "team" && editorUiStore.rightPanelMode === "work";
		const textLayer = editorStore.selectedLayer;
		if (textLayer) {
			const label = textLayer.name?.trim() || textLayer.text?.trim() || $_("editorPathBar.emptyText");
			const hasTextGeometry = textLayer.w > 0 && textLayer.h > 0 && textLayer.fontSize > 0;
			const detail = textLayer.locked === true
				? $_("editorPathBar.stateLocked")
				: textLayer.visible === false
					? $_("editorPathBar.stateHidden")
					: workPanelOwnsSelectionReceipt
						? $_("editorPathBar.stateSelected")
						: hasTextGeometry
						? `${Math.round(textLayer.x)}, ${Math.round(textLayer.y)} / ${textLayer.fontSize}px`
						: $_("editorPathBar.textBox");
			return { detail, kind: "text", label };
		}

		const imageLayer = editorStore.selectedImageLayer;
		if (imageLayer) {
			const label = imageLayer.name?.trim() || imageLayer.originalName?.trim() || imageLayer.imageName || $_("editorPathBar.extraImage");
			const kind = isAiResultImageLayer(imageLayer) ? "AI" : imageLayer.role === "credit" ? $_("editorPathBar.kindCredit") : $_("editorPathBar.extraImage");
			const hasImageGeometry = imageLayer.w > 0 && imageLayer.h > 0;
			const state = imageLayer.locked === true
				? $_("editorPathBar.stateLocked")
				: imageLayer.visible === false
					? $_("editorPathBar.stateHidden")
					: workPanelOwnsSelectionReceipt
						? $_("editorPathBar.stateSelected")
						: hasImageGeometry
						? `${Math.round((imageLayer.opacity ?? 1) * 100)}%`
						: $_("editorPathBar.stateSelecting");
			return { detail: `${kind} / ${state}`, kind: "image", label };
		}

		return { detail: $_("editorPathBar.baseLayerDetail"), kind: "base", label: $_("editorPathBar.baseImage") };
	}

	function resolveEditorEntry() {
		const entry = editorUiStore.workspaceEditorEntry;
		if (!entry || entry.source !== "library") return null;
		if (entry.projectId !== projectStore.project?.projectId) return null;
		return entry;
	}

	async function previousPage(): Promise<void> {
		if (await projectStore.prevPage(editorStore.editor)) {
			editorStore.refreshTextLayers();
			pushEditorHref(projectStore.project?.currentPage ?? 0);
		}
	}

	async function nextPage(): Promise<void> {
		if (await projectStore.nextPage(editorStore.editor)) {
			editorStore.refreshTextLayers();
			pushEditorHref(projectStore.project?.currentPage ?? 0);
		}
	}

	async function openPage(pageIndex: number): Promise<void> {
		if (await projectStore.goToPage(pageIndex, editorStore.editor)) {
			editorStore.refreshTextLayers();
			pushEditorHref(pageIndex);
		}
	}

	function requestConflictReload(): void {
		window.dispatchEvent(new CustomEvent("manga-editor:request-conflict-reload"));
	}

	function handleSaveAction(event: MouseEvent): void {
		const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		// Couples by value-equality to saveActionLabel (the localized "reload" word)
		// rendered into this button's text — compare against the same key, not the
		// data-save-action attr, so it matches whatever locale is active.
		if ((target?.textContent ?? "").includes($_("editorPathBar.saveReload"))) {
			requestConflictReload();
			return;
		}
		void projectStore.saveCurrentPage(editorStore.editor);
	}

	function startStarterTextLayer(): void {
		editorUiStore.setRightPanelMode("layers");
		editorStore.startTextPlacement();
	}

	function openStarterLayerPanel(): void {
		editorUiStore.setRightPanelMode("layers");
		requestAnimationFrame(() => {
			document.querySelector(".right-panel")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
		});
	}

	function openPages(): void {
		if (!projectStore.project) return;
		editorUiStore.openPages();
		queueWorkspaceNavigation({
			view: "pages",
			projectId: projectStore.project.projectId,
		});
	}

	function openWorkBoard(): void {
		if (!projectStore.project) return;
		editorUiStore.openWorkBoard();
		queueWorkspaceNavigation({
			view: "work",
			projectId: projectStore.project.projectId,
		});
	}

	// Open the current page's open task in the editor's contextual Work panel
	// (the right-panel inspector) — the in-editor replacement for the old
	// per-task Focus view.
	function openFocusItem(item: TaskFocusItem): void {
		projectStore.selectAiReviewMarker(item.kind === "ai_marker" ? item.sourceId : null);
		projectStore.selectProjectComment(item.kind === "comment" ? item.sourceId : null);
		projectStore.selectWorkflowTask(
			item.kind === "workflow_task" || item.kind === "review_task" ? item.sourceId : null,
		);
		projectStore.selectQcIssue(item.kind === "qc" ? item.sourceId : null);
		editorUiStore.setRightPanelMode("work");
	}

	function resolveCurrentPageFocusItem() {
		const pageIndex = projectStore.project?.currentPage;
		if (pageIndex === undefined) return null;
		return taskFocusItems.find((item) => item.pageIndex === pageIndex) ?? null;
	}

	const PAGE_TASK_ORDER: Record<WorkflowTask["type"], number> = { clean: 0, translate: 1, typeset: 2, review: 3 };
	// The viewer's own not-done task for the open page (+active language track for
	// language-bound stages; clean is language-agnostic). Earliest pipeline stage
	// first so "submit" advances the right step.
	function resolveMyPageTask(): WorkflowTask | null {
		const proj = projectStore.project;
		if (!proj || myHandles.size === 0) return null;
		const pageIndex = proj.currentPage;
		const activeLang = projectStore.activeTargetLang;
		const defaultLang = proj.targetLang ?? activeLang;
		const mine = projectStore.tasks.filter((task) => {
			if (task.pageIndex !== pageIndex || task.status === "done") return false;
			if (task.type !== "clean" && (task.targetLang ?? defaultLang) !== activeLang) return false;
			const handle = normalizeAssigneeHandle(task.assignee);
			return handle !== null && myHandles.has(handle);
		});
		mine.sort((a, b) => PAGE_TASK_ORDER[a.type] - PAGE_TASK_ORDER[b.type]);
		return mine[0] ?? null;
	}

	// Mark the viewer's page task done and advance the pipeline (same store call as
	// the board's "เสร็จ → ขั้นถัดไป"). Save first when there are unsaved edits so
	// the handoff reflects the latest canvas.
	async function submitMyPageTask(): Promise<void> {
		const task = myPageTask;
		if (!task || submittingPageTask) return;
		submittingPageTask = true;
		try {
			if (projectStore.saveSyncStatus === "unsaved") {
				await projectStore.saveCurrentPage(editorStore.editor);
			}
			// saveCurrentPage swallows its own failures (sets status to "error" and
			// returns) — so re-check AFTER it. Never hand off a page whose latest edits
			// didn't persist, or the next role inherits stale/lost work.
			if (projectStore.saveSyncStatus === "error") return;
			await projectStore.submitTaskToNextStage(task.id);
		} finally {
			submittingPageTask = false;
		}
	}

	function resolveEditorReadinessAction(): { label: string; detail: string; tone: string; action: () => void } {
		if (projectStore.saveSyncStatus === "unsaved") {
			return {
				label: $_("editorPathBar.readinessSaveBeforeHandoff"),
				detail: $_("editorPathBar.readinessUnsaved"),
				tone: "attention",
				action: () => void projectStore.saveCurrentPage(editorStore.editor),
			};
		}
		if (projectStore.saveSyncStatus === "error") {
			return {
				label: hasSaveConflict ? $_("editorPathBar.readinessReloadBeforeHandoff") : $_("editorPathBar.readinessRetryBeforeHandoff"),
				detail: hasSaveConflict ? $_("editorPathBar.metaConflict") : $_("editorPathBar.readinessSaveFailed"),
				tone: "blocked",
				action: hasSaveConflict ? requestConflictReload : () => void projectStore.saveCurrentPage(editorStore.editor),
			};
		}
		if (currentPageFocusItem) {
			return {
				label: $_("editorPathBar.readinessOpenPageTask"),
				detail: workInboxTitle(currentPageFocusItem, $_),
				tone: currentPageFocusItem.severity === "error" ? "blocked" : "attention",
				action: () => openFocusItem(currentPageFocusItem),
			};
		}
		if (currentPageSummary?.exportReady) {
			return {
				label: $_("editorPathBar.readinessCheckExport"),
				detail: $_("editorPathBar.readinessPageReady"),
				tone: "ready",
				action: openPages,
			};
		}
		return {
			label: $_("editorPathBar.readinessOpenPages"),
			detail: $_("editorPathBar.readinessSeeGate"),
			tone: currentPageSummary?.status === "blocked" ? "blocked" : "quiet",
			action: openPages,
		};
	}

	function returnToLibraryChapter(): void {
		if (!projectStore.project) return;
		const titleKey = editorEntry?.titleKey ?? editorUiStore.workspaceTitleKey;
		editorUiStore.openLibrary(titleKey);
		editorUiStore.setWorkspaceLanguageKey(editorEntry?.language ?? projectStore.project.targetLang);
		queueWorkspaceNavigation({
			view: "chapter",
			titleKey: titleKey ?? undefined,
			projectId: projectStore.project.projectId,
		});
	}

	function goToWorkspaceDashboard(): void {
		editorUiStore.openDashboard();
		queueWorkspaceNavigation({ view: "dashboard" });
	}

	function goToStoryView(): void {
		if (!projectStore.project) return;
		const titleKey = editorEntry?.titleKey ?? editorUiStore.workspaceTitleKey;
		editorUiStore.openLibrary(titleKey);
		editorUiStore.setWorkspaceLanguageKey(null);
		queueWorkspaceNavigation({
			view: "title",
			titleKey: titleKey ?? undefined,
		});
	}

	function goToChapterView(): void {
		returnToLibraryChapter();
	}

	function exportCurrentPage(): void {
		pageToolsOpen = false;
		if (projectStore.exportBlockedBySaveConflict) {
			requestConflictReload();
			return;
		}
		void projectStore.exportPage(editorStore.editor);
	}

	function importLayoutJson(): void {
		pageToolsOpen = false;
		void projectStore.importJson(editorStore.editor);
	}

	function pushEditorHref(pageIndex: number): void {
		if (!projectStore.project) return;
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex,
		});
	}
</script>

{#if editorUiStore.workspaceView === "editor" && projectStore.project}
	<section class="editor-path-bar ws-panel-quiet" class:has-entry={Boolean(editorEntry)} aria-label={$_("editorPathBar.barAria")}>
		<div class="path-copy">
			<div class="identity-meta sr-only" aria-label={$_("editorPathBar.currentPositionAria")} style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0;">
				{#if editorEntry}
					<span>{$_("editorPathBar.fromLibrary")}</span>
				{:else}
					<span>{$_("editorPathBar.chapter")}</span>
				{/if}
				<span>{language}</span>
				<span>{$_("editorPathBar.pageOfCount", { values: { n: pageNumber, total: pageCount } })}</span>
				<span>{workflowStatusLabel}</span>
			</div>

			<div class="editor-breadcrumbs-container">
				<nav class="editor-breadcrumbs" aria-label={$_("editorPathBar.breadcrumbsAria")}>
					<button
						type="button"
						class="breadcrumb-item workspace clickable ws-btn-ghost"
						onclick={goToWorkspaceDashboard}
						title={$_("editorPathBar.backToHomeTitle", { values: { name: workspaceName } })}
						aria-label={$_("editorPathBar.backToWorkspaceAria", { values: { name: workspaceName } })}
					>
						<svg class="breadcrumb-ws-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
							<path d="M12 3 14.02 9.22 20.56 9.22 15.27 13.06 17.29 19.28 12 15.44 6.71 19.28 8.73 13.06 3.44 9.22 9.98 9.22Z" fill="currentColor"/>
						</svg>
						<span>{workspaceName}</span>
					</button>
					<span class="breadcrumb-separator">/</span>
					<button
						type="button"
						class="breadcrumb-item story clickable ws-btn-ghost"
						onclick={goToStoryView}
						aria-label={$_("editorPathBar.backToStoryAria", { values: { story: breadcrumbs.story } })}
					>
						{breadcrumbs.story}
					</button>
					<span class="breadcrumb-separator">/</span>
					<button
						type="button"
						class="breadcrumb-item chapter clickable ws-btn-ghost"
						onclick={goToChapterView}
						aria-label={$_("editorPathBar.backToChapterAria", { values: { chapter: breadcrumbs.chapter } })}
					>
						{breadcrumbs.chapter}
					</button>
					<span class="breadcrumb-separator">/</span>
					<span class="breadcrumb-item page">{breadcrumbs.page}</span>
					<LanguageTrackSwitcher
						class="breadcrumb-lang"
						canManage={workspacesStore.isAdmin && Boolean(projectStore.project)}
						onManage={() => (languageDialogOpen = true)}
					/>
				</nav>
			</div>

			<!-- Declutter (topbar redesign): the chip only appears when a LAYER is
			     actually selected — the default "base image" state told users nothing
			     and ate a whole topbar slot. -->
			{#if selectedLayerSummary.kind !== "base"}
				<div
					class={`selected-layer-chip ${selectedLayerSummary.kind}`}
					title={`${selectedLayerSummary.label} / ${selectedLayerSummary.detail}`}
					aria-label={$_("editorPathBar.selectedLayerAria", { values: { label: selectedLayerSummary.label, detail: selectedLayerSummary.detail } })}
				>
					<strong>{selectedLayerSummary.label}</strong>
					<small>{selectedLayerSummary.detail}</small>
				</div>
			{/if}
			<p title={pageImageName} style="display: none;">{pageName}</p>
			{#if editorStarterActionActive}
				<div class="path-next path-starter" aria-label={$_("editorPathBar.startEditAria")}>
					<span class="ready">{$_("editorPathBar.startEdit")}</span>
					<button type="button" class="primary ws-grad-primary" onclick={startStarterTextLayer} aria-label={$_("editorPathBar.placeFirstTextAria")}>
						{$_("editorPathBar.placeText")}
					</button>
					<button type="button" class="ws-btn-ghost" onclick={openStarterLayerPanel} aria-label={$_("editorPathBar.openLayerPanelAria")}>
						{$_("editorPathBar.layer")}
					</button>
				</div>
			{:else}
				<!-- Status, not coaching: the bar reports WHERE the page is; prescriptive
				     "do this next" copy is QC's job (user direction 2026-06-11). -->
				<div class="path-next" title={workflowStatusLabel} aria-label={$_("editorPathBar.pageStatusOnlyAria", { values: { status: workflowStatusLabel } })}>
					<span class={pageStatusClass(currentPageSummary)}>
						{$_("editorPathBar.pageWork")}
					</span>
					<strong>{workflowStatusLabel}</strong>
					{#if workPanelOwnsCurrentPageFocus && currentPageFocusItem}
						<span
							class={`path-readiness-receipt ${editorReadinessAction.tone}`}
							aria-label={$_("editorPathBar.workPanelOpenAria", { values: { title: workInboxTitle(currentPageFocusItem, $_) } })}
							title={$_("editorPathBar.workPanelOpenTitle")}
						>
							{$_("editorPathBar.workPanelOpen")}
						</span>
					{:else}
						<button
							type="button"
							class={`path-readiness-action ws-btn-ghost ${editorReadinessAction.tone}`}
							onclick={editorReadinessAction.action}
							aria-label={$_("editorPathBar.readinessActionAria", { values: { label: editorReadinessAction.label, detail: editorReadinessAction.detail } })}
						>
							{editorReadinessAction.label}
						</button>
					{/if}
				</div>
			{/if}
		</div>

		{#if editorEntry}
			<!-- Declutter (topbar redesign): the old 3-line "library context" box ate
			     a third of the bar; the breadcrumb already names the chapter. One
			     compact return button keeps the affordance — details ride the title. -->
			<div class="library-entry-chip compact" aria-label={$_("editorPathBar.libraryContextAria")}>
				<button
					type="button"
					class="ws-btn-ghost"
					onclick={returnToLibraryChapter}
					title={`${editorEntryLabel} — ${editorEntry.language.toUpperCase()} / ${editorEntry.reason}`}
				>
					{$_("editorPathBar.backToChapter")}
				</button>
			</div>
		{/if}

		<div class="path-signals" aria-label={$_("editorPathBar.signalsAria", { values: { detail: pathSignalDetail } })} title={pathSignalDetail}>
			<span class:attention={currentPageSignalCount > 0}>{pathSignalSummary}</span>
		</div>

		<div class="page-strip" aria-label={$_("editorPathBar.pageStripAria")}>
			{#if projectStore.canGoPrev && !projectStore.pageNavigationBusy}
				<button
					type="button"
					class="page-step-btn ws-btn-ghost"
					onclick={previousPage}
					aria-label={$_("editorPathBar.prevPageAria")}
				>
					&lt;
				</button>
			{:else if projectStore.pageNavigationBusy}
				<span class="page-step-btn page-busy-note" aria-label={$_("editorPathBar.openingOtherPage")}>&lt;</span>
			{/if}
			{#each nearbyPages as page (page.pageIndex)}
				{#if page.pageIndex === projectStore.project.currentPage}
					<span
						class={`page-strip-btn ${page.status} current`}
						title={$_("editorPathBar.editingPageAria", { values: { n: page.pageNumber, status: resolvePageStatusText(page.statusLabel, $_, $_("pageWork.statusFallback")) } })}
						aria-current="page"
						aria-label={$_("editorPathBar.editingPageAria", { values: { n: page.pageNumber, status: resolvePageStatusText(page.statusLabel, $_, $_("pageWork.statusFallback")) } })}
					>
						P{page.pageNumber}
					</span>
				{:else}
					{#if projectStore.pageNavigationBusy}
						<span
							class={`page-strip-btn ${page.status} page-busy-note`}
							title={$_("editorPathBar.openingOtherPage")}
							aria-label={$_("editorPathBar.openingBeforePageAria", { values: { n: page.pageNumber } })}
						>
							P{page.pageNumber}
						</span>
					{:else}
						<button
							type="button"
							class={`page-strip-btn ws-btn-ghost ${page.status}`}
							onclick={() => openPage(page.pageIndex)}
							title={$_("editorPathBar.openPageAria", { values: { n: page.pageNumber, status: resolvePageStatusText(page.statusLabel, $_, $_("pageWork.statusFallback")) } })}
							aria-label={$_("editorPathBar.openPageAria", { values: { n: page.pageNumber, status: resolvePageStatusText(page.statusLabel, $_, $_("pageWork.statusFallback")) } })}
						>
							P{page.pageNumber}
						</button>
					{/if}
				{/if}
			{/each}
			{#if projectStore.canGoNext && !projectStore.pageNavigationBusy}
				<button
					type="button"
					class="page-step-btn ws-btn-ghost"
					onclick={nextPage}
					aria-label={$_("editorPathBar.nextPageAria")}
				>
					&gt;
				</button>
			{:else if projectStore.pageNavigationBusy}
				<span class="page-step-btn page-busy-note" aria-label={$_("editorPathBar.openingOtherPage")}>&gt;</span>
			{/if}
		</div>

		<div class="path-actions">
			{#if saveActionBusy || workflowOwnsSaveAction}
				<span
					class="path-action-save path-action-receipt"
					title={projectStore.saveSyncDetail || (workflowOwnsSaveAction ? $_("editorPathBar.saveReceiptOwnedTitle") : $_("editorPathBar.saveReceiptSavingTitle"))}
					aria-live="polite"
				>
					<strong>{saveActionLabel}</strong>
					<small>{saveActionMeta}</small>
				</span>
			{:else}
				<button
					type="button"
					class="path-action-save ws-btn-ghost"
					class:save-error={projectStore.saveSyncStatus === "error"}
					data-save-action={hasSaveConflict ? "reload" : "save"}
					onclick={handleSaveAction}
					title={projectStore.saveSyncDetail || (hasSaveConflict ? $_("editorPathBar.saveReloadTitle") : $_("editorPathBar.saveOnlyTitle"))}
					aria-label={$_("editorPathBar.saveButtonAria", { values: { label: saveActionLabel, meta: saveActionMeta } })}
				>
					<strong>{saveActionLabel}</strong>
					<small>{saveActionMeta}</small>
				</button>
			{/if}
			{#if canSubmitPageTask}
				<button
					type="button"
					class="path-action-submit"
					disabled={submittingPageTask || projectStore.saveSyncStatus === "error"}
					onclick={() => void submitMyPageTask()}
					title={$_("editorPathBar.submitPageTaskTitle")}
				>
					<strong>{$_("editorPathBar.submitPageTask")}</strong>
					<small>{submittingPageTask ? $_("editorPathBar.submitPageTaskBusy") : myPageTaskStageLabel}</small>
				</button>
			{/if}
			<div class="path-tools-wrap">
				<button
					type="button"
					class="ws-btn-ghost"
					class:active={pageToolsOpen}
					onclick={() => pageToolsOpen = !pageToolsOpen}
					aria-expanded={pageToolsOpen}
					aria-haspopup="menu"
				>
					{$_("editorPathBar.tools")}
				</button>
				{#if pageToolsOpen}
					<div class="path-tools-menu ws-panel" role="menu" aria-label={$_("editorPathBar.toolsMenuAria")}>
						{#if projectStore.exportBlockedBySaveConflict}
							<div class="path-menu-receipt blocked" role="menuitem" tabindex="-1">
								<strong>{$_("editorPathBar.exportBlockedConflict")}</strong>
								<small>{$_("editorPathBar.exportBlockedConflictDetail")}</small>
							</div>
						{:else}
							<button type="button" class="ws-btn-ghost" role="menuitem" onclick={exportCurrentPage}>
								<strong>{$_("editorPathBar.exportPng")}</strong>
								<small>{$_("editorPathBar.currentPage")}</small>
							</button>
						{/if}
						<button type="button" class="ws-btn-ghost" role="menuitem" onclick={importLayoutJson}>
							<strong>{$_("editorPathBar.importJson")}</strong>
							<small>{$_("editorPathBar.ocrLayout")}</small>
						</button>
						<button type="button" class="ws-btn-ghost" role="menuitem" onclick={openPages}>
							<strong>{$_("editorPathBar.openPagesInChapter")}</strong>
							<small>{$_("editorPathBar.pageMapAndExport")}</small>
						</button>
						{#if taskFocusItems.length}
							<button type="button" class="ws-btn-ghost" role="menuitem" onclick={openWorkBoard}>
								<strong>{$_("editorPathBar.openTeamBoard")}</strong>
								<small>{$_("editorPathBar.nextChapterWork")}</small>
							</button>
						{:else}
							<div class="path-menu-receipt" role="menuitem" tabindex="-1">
								<strong>{$_("editorPathBar.noPendingWork")}</strong>
								<small>{$_("editorPathBar.noNextWorkOnPage")}</small>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</section>

	<AddLanguageTrackDialog
		open={languageDialogOpen}
		onClose={() => (languageDialogOpen = false)}
	/>
{/if}

<style>
	.editor-path-bar {
		--path-panel: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		--path-panel-strong: color-mix(in srgb, var(--color-ws-surface2) 88%, var(--color-ws-bg));
		--path-hover: color-mix(in srgb, var(--color-ws-line) 8%, transparent);
		--path-accent-soft: color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
		--path-accent-line: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		--path-blue-soft: color-mix(in srgb, var(--color-ws-blue) 12%, transparent);
		--path-green-soft: color-mix(in srgb, var(--color-ws-green) 14%, transparent);
		--path-green-line: color-mix(in srgb, var(--color-ws-green) 36%, transparent);
		--path-amber-soft: color-mix(in srgb, var(--color-ws-amber) 14%, transparent);
		--path-amber-line: color-mix(in srgb, var(--color-ws-amber) 38%, transparent);
		--path-rose-soft: color-mix(in srgb, var(--color-ws-rose) 14%, transparent);
		--path-rose-line: color-mix(in srgb, var(--color-ws-rose) 44%, transparent);
		--path-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 3%, transparent) inset,
			0 18px 44px -24px color-mix(in srgb, var(--color-ws-bg) 92%, transparent);
		position: relative;
		z-index: 34;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto auto;
		gap: 10px;
		align-items: center;
		box-sizing: border-box;
		width: 100%;
		min-height: 52px;
		padding: 8px 14px;
		border: 0;
		border-bottom: 1px solid var(--ws-hair);
		border-radius: 0;
		/* Keep editor chrome visually tied to workspace surfaces without touching
		   Fabric canvas/tool ownership or changing the navigation structure. */
		background: color-mix(in srgb, var(--color-ws-bg) 86%, transparent);
		box-shadow: var(--path-shadow);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		pointer-events: auto;
	}

	.editor-path-bar.has-entry {
		grid-template-columns: minmax(0, 1fr) minmax(170px, 220px) auto auto auto;
	}

	.path-copy {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		min-width: 0;
	}

	.editor-breadcrumbs-container {
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.editor-breadcrumbs {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-family: var(--font-ws-sans);
		font-size: 13px;
		color: var(--color-ws-text);
	}

	.breadcrumb-item {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}

	.breadcrumb-item.clickable {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-width: 40px;
		min-height: 40px;
		border: 1px solid transparent;
		border-radius: var(--radius-ws-ctrl, 10px);
		background: transparent;
		padding: 0 8px;
		cursor: pointer;
		font-family: var(--font-ws-sans);
		text-align: left;
		transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
	}

	.breadcrumb-item.clickable:hover {
		color: var(--color-ws-ink);
		background: var(--path-hover);
	}

	/* Workspace anchor: the editor's "you are inside this workspace" identity +
	   one-tap return to the workspace dashboard. Mirrors the sidebar brand mark. */
	.breadcrumb-item.workspace {
		gap: 6px;
		max-width: 160px;
		border-color: var(--path-accent-line);
		background: var(--path-accent-soft);
		color: var(--color-ws-ink);
		font-weight: 700;
	}

	.breadcrumb-item.workspace > span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.breadcrumb-item.workspace:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 60%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 20%, transparent);
	}

	.breadcrumb-ws-mark {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		color: color-mix(in srgb, var(--color-ws-accent) 40%, var(--color-ws-ink));
	}

	.breadcrumb-item.story {
		color: var(--color-ws-ink);
		font-weight: 800;
		font-size: 13px;
	}

	.breadcrumb-item.chapter {
		color: var(--color-ws-text);
	}

	.breadcrumb-item.page {
		color: var(--color-ws-blue);
		font-weight: 700;
	}

	.breadcrumb-separator {
		color: color-mix(in srgb, var(--color-ws-line) 18%, transparent);
		font-size: 10px;
		user-select: none;
	}

	.breadcrumb-badge {
		padding: 2px 6px;
		border: 1px solid color-mix(in srgb, var(--color-ws-blue) 34%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: var(--path-blue-soft);
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 900;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.identity-meta span:not(:last-child)::after {
		content: "/";
		margin-left: 6px;
		color: var(--color-ws-faint);
	}

	.path-copy p {
		display: none;
		margin: 2px 0 0;
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 700;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.path-next {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 7px;
		align-items: center;
		margin-top: 0;
		min-width: 0;
		max-width: 500px;
	}

	.path-next span {
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--path-panel);
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 800;
		white-space: nowrap;
	}

	.path-next span.blocked {
		background: var(--path-rose-soft);
		color: color-mix(in srgb, var(--color-ws-rose) 66%, var(--color-ws-ink));
	}

	.path-next span.review {
		background: var(--path-amber-soft);
		color: color-mix(in srgb, var(--color-ws-amber) 68%, var(--color-ws-ink));
	}

	.path-next span.ready {
		background: var(--path-green-soft);
		color: color-mix(in srgb, var(--color-ws-green) 68%, var(--color-ws-ink));
	}

	.path-next strong {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 720;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.path-readiness-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 40px;
		padding: 0 12px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 11px;
		font-weight: 800;
		white-space: nowrap;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	.path-readiness-action:hover {
		border-color: var(--ws-hair-strong);
		background: var(--path-hover);
	}

	.path-readiness-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 40px;
		padding: 0 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--path-panel);
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 820;
		white-space: nowrap;
	}

	.path-readiness-action.ready {
		border-color: var(--path-green-line);
		background: var(--path-green-soft);
	}

	.path-readiness-action.attention {
		border-color: var(--path-amber-line);
		background: var(--path-amber-soft);
	}

	.path-readiness-action.blocked {
		border-color: var(--path-rose-line);
		background: var(--path-rose-soft);
	}

	.path-readiness-receipt.attention,
	.path-readiness-receipt.blocked {
		border-color: var(--path-amber-line);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
		color: color-mix(in srgb, var(--color-ws-amber) 68%, var(--color-ws-ink));
	}

	.path-starter {
		grid-template-columns: auto auto auto;
		max-width: 390px;
	}

	.path-starter button {
		min-width: 0;
		min-height: 40px;
		padding: 6px 12px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font: inherit;
		font-size: 11px;
		font-weight: 850;
		letter-spacing: 0;
		white-space: nowrap;
		transition: background 0.14s ease, border-color 0.14s ease, filter 0.14s ease;
	}

	.path-starter button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 62%, var(--ws-hair));
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
	}

	.path-starter button:hover {
		border-color: var(--ws-hair-strong);
		background: var(--path-hover);
		color: var(--color-ws-ink);
	}

	.path-starter button.primary:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 72%, var(--ws-hair));
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
		filter: brightness(1.08);
	}

	.selected-layer-chip {
		display: grid;
		width: min(280px, 100%);
		min-width: 0;
		min-height: 32px;
		align-content: center;
		gap: 1px;
		margin-top: 5px;
		padding: 5px 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--path-panel);
	}

	.selected-layer-chip.text {
		border-color: color-mix(in srgb, var(--color-ws-green) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 9%, transparent);
	}

	.selected-layer-chip.image {
		border-color: color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
		background: var(--path-accent-soft);
	}

	.selected-layer-chip small,
	.selected-layer-chip strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-layer-chip strong {
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
		line-height: 1.08;
	}

	.selected-layer-chip small {
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 720;
		line-height: 1.08;
	}

	.library-entry-chip {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		align-items: center;
		min-width: 0;
		max-width: 220px;
		min-height: 40px;
		padding: 5px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: var(--path-accent-soft);
	}

	.library-entry-chip button {
		min-width: 72px;
		min-height: 40px;
		padding: 0 8px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 10px;
		font-weight: 800;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	.library-entry-chip button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
	}

	.path-signals {
		display: flex;
		gap: 6px;
		align-items: center;
		color: var(--color-ws-text);
		font-size: 10px;
		white-space: nowrap;
	}

	.path-signals span {
		padding: 4px 8px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: var(--path-panel);
	}

	.path-signals span.attention {
		border-color: var(--path-amber-line);
		background: var(--path-amber-soft);
		color: color-mix(in srgb, var(--color-ws-amber) 68%, var(--color-ws-ink));
	}

	.page-strip {
		display: flex;
		gap: 5px;
		align-items: center;
		padding: 4px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--path-panel);
	}

	.page-strip-btn,
	.page-step-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 40px;
		padding: 0 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-text);
		font: inherit;
		font-size: 10px;
		font-weight: 850;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
	}

	.page-step-btn {
		min-width: 40px;
		padding-inline: 7px;
		color: var(--color-ws-faint);
	}

	.page-strip-btn.blocked {
		border-color: var(--path-rose-line);
		color: color-mix(in srgb, var(--color-ws-rose) 66%, var(--color-ws-ink));
	}

	.page-strip-btn.review {
		border-color: var(--path-amber-line);
		color: color-mix(in srgb, var(--color-ws-amber) 68%, var(--color-ws-ink));
	}

	.page-strip-btn.ready {
		border-color: var(--path-green-line);
		color: color-mix(in srgb, var(--color-ws-green) 68%, var(--color-ws-ink));
	}

	.page-step-btn:hover:not(.page-busy-note):not(.page-edge-note),
	button.page-strip-btn:hover:not(.current),
	.page-strip-btn.current {
		border-color: color-mix(in srgb, var(--color-ws-accent) 56%, transparent);
		background: var(--path-accent-soft);
		color: var(--color-ws-ink);
	}

	.page-busy-note,
	.page-edge-note,
	.page-strip-btn.current {
		cursor: default;
		opacity: 0.78;
	}

	.page-busy-note {
		border-style: dashed;
		background: color-mix(in srgb, var(--color-ws-line) 6%, transparent);
		color: var(--color-ws-faint);
	}

	.page-edge-note {
		border-style: dashed;
		background: color-mix(in srgb, var(--color-ws-line) 3%, transparent);
		color: var(--color-ws-faint);
	}

	.path-actions {
		position: relative;
		display: flex;
		gap: 5px;
		align-items: center;
	}

	.path-actions button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 40px;
		padding: 0 12px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		font-weight: 700;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	.path-action-save {
		display: inline-flex;
		min-width: 86px;
		min-height: 40px;
		flex-direction: column;
		gap: 1px;
		align-items: flex-start !important;
		padding-inline: 12px !important;
		border-color: var(--path-green-line) !important;
		background: var(--path-green-soft) !important;
	}

	.path-action-receipt {
		justify-content: center;
		color: var(--color-ws-green);
		cursor: default;
		opacity: 0.78;
	}

	.path-action-save strong,
	.path-action-save small {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.path-action-save strong {
		color: var(--color-ws-ink);
		font-size: 11px;
		line-height: 1.05;
	}

	.path-action-save small {
		color: var(--color-ws-green);
		font-size: 9px;
		line-height: 1.05;
	}

	.path-action-save.save-error {
		border-color: var(--path-rose-line) !important;
		background: var(--path-rose-soft) !important;
	}

	.path-action-save.save-error small {
		color: color-mix(in srgb, var(--color-ws-rose) 70%, var(--color-ws-ink));
	}

	/* Per-page "mark done → hand off" (issue #10c) — accent-toned to read as the
	   forward/advance action, distinct from the green Save. */
	.path-action-submit {
		display: inline-flex;
		min-width: 96px;
		min-height: 40px;
		flex-direction: column;
		gap: 1px;
		align-items: flex-start;
		justify-content: center;
		padding-inline: 12px;
		border: 1px solid var(--color-ws-accent);
		border-radius: var(--radius-ws-ctrl, 8px);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
		cursor: pointer;
	}
	.path-action-submit:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
	}
	.path-action-submit:disabled {
		opacity: 0.55;
		cursor: progress;
	}
	.path-action-submit strong {
		color: var(--color-ws-accent);
		font-size: 11px;
		line-height: 1.05;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.path-action-submit small {
		color: color-mix(in srgb, var(--color-ws-accent) 75%, var(--color-ws-ink));
		font-size: 9px;
		line-height: 1.05;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.path-tools-wrap {
		position: relative;
		display: inline-flex;
	}

	.path-tools-wrap button.active {
		border-color: var(--path-accent-line);
		background: var(--path-accent-soft);
	}

	.path-tools-menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 1300;
		display: grid;
		min-width: 178px;
		gap: 4px;
		padding: 6px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow: var(--path-shadow);
	}

	.path-tools-menu button,
	.path-menu-receipt {
		display: flex;
		min-height: 42px;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		border-color: transparent;
		background: transparent;
		text-align: left;
	}

	.path-menu-receipt {
		justify-content: center;
		padding: 0 9px;
		color: var(--color-ws-text);
		cursor: default;
	}

	.path-menu-receipt.blocked {
		border-color: color-mix(in srgb, var(--color-ws-rose) 26%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, transparent);
		color: var(--color-ws-rose);
	}

	.path-tools-menu button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
		background: var(--path-accent-soft);
	}

	.path-tools-menu strong {
		font-size: 11px;
	}

	.path-tools-menu small {
		color: var(--color-ws-text);
		font-size: 10px;
	}

	.path-actions button:hover {
		border-color: var(--ws-hair-strong);
		background: var(--path-hover);
	}

	@media (max-width: 980px) {
		.editor-path-bar {
			grid-template-columns: minmax(0, 1fr) auto;
		}

		.editor-path-bar.has-entry {
			grid-template-columns: minmax(0, 1fr) minmax(156px, 210px) auto;
		}

		.path-copy {
			grid-template-columns: minmax(0, 1fr);
			gap: 4px;
		}

		.selected-layer-chip {
			max-width: 320px;
			min-height: 32px;
			grid-template-columns: auto minmax(0, 1fr);
			column-gap: 6px;
			margin-top: 4px;
		}

		.selected-layer-chip small {
			grid-column: 2;
		}

		.path-signals {
			display: none;
		}

		.page-strip {
			display: none;
		}

		.path-next strong {
			display: none;
		}

		.path-next {
			grid-template-columns: auto auto;
		}

		.path-starter {
			grid-template-columns: auto auto auto;
			max-width: min(100%, 390px);
		}

		.path-actions {
			min-width: 0;
			gap: 4px;
			justify-content: flex-end;
		}

		.editor-path-bar.has-entry .path-actions {
			grid-column: 3;
		}

		.path-actions button {
			min-width: 40px;
			min-height: 40px;
			padding: 0 9px;
			font-size: 11px;
		}
	}

	@media (max-width: 680px) {
		.editor-path-bar {
			width: auto;
			grid-template-columns: minmax(0, 1fr);
			min-height: 0;
		}

		.page-strip {
			overflow-x: auto;
			justify-content: flex-start;
		}

		.page-strip-btn {
			flex: 0 0 auto;
		}

		.path-actions {
			justify-content: space-between;
		}

		.library-entry-chip {
			max-width: none;
		}

		.path-actions button {
			flex: 1 1 0;
		}
	}

	/* ── Mobile editor path bar (≤640px) ─────────────────────────────────────
	   Two intentional rows, no overlap: (1) a compact "current chapter / page"
	   breadcrumb + the next-action button, (2) the horizontally-scrolling page
	   strip alongside Save + the tools popover. The workspace/story crumbs and the
	   selected-layer + readiness receipts are dropped from this strip (still
	   reachable: workspace via the toolbar overflow, layer info via the inspector,
	   page tools via "เครื่องมือ"). Desktop is untouched (gated by this query). */
	@media (max-width: 640px) {
		.editor-path-bar,
		.editor-path-bar.has-entry {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 6px;
			padding: 6px 10px;
			row-gap: 6px;
			align-items: center;
		}

		.path-copy {
			grid-column: 1 / -1;
			grid-template-columns: minmax(0, 1fr);
			gap: 6px;
		}

		/* Collapse the breadcrumb trail to just the current chapter + page. */
		.editor-breadcrumbs {
			gap: 4px;
			font-size: 12px;
			flex-wrap: nowrap;
			overflow: hidden;
		}

		.breadcrumb-item.workspace,
		.breadcrumb-item.story,
		.breadcrumb-separator:nth-of-type(1),
		.breadcrumb-separator:nth-of-type(2) {
			display: none;
		}

		.breadcrumb-item.chapter,
		.breadcrumb-item.page {
			min-height: 36px;
			max-width: 42vw;
		}

		/* The selected-layer receipt + library entry chip move off this strip on
		   mobile (the inspector + toolbar surface the same context). */
		.selected-layer-chip,
		.library-entry-chip {
			display: none;
		}

		.path-next {
			grid-template-columns: auto minmax(0, 1fr);
			gap: 6px;
		}

		.path-next strong {
			display: none;
		}

		.path-signals {
			display: none;
		}

		/* Page strip + actions share the second row; strip scrolls, no wrap. */
		.page-strip {
			grid-column: 1;
			display: flex;
			min-width: 0;
			overflow-x: auto;
			justify-content: flex-start;
			-webkit-overflow-scrolling: touch;
			scrollbar-width: none;
		}

		.page-strip::-webkit-scrollbar {
			display: none;
		}

		.page-strip-btn,
		.page-step-btn {
			flex: 0 0 auto;
			min-width: 40px;
			min-height: 40px;
		}

		.path-actions {
			grid-column: 2;
			min-width: 0;
			gap: 6px;
			justify-content: flex-end;
		}

		.path-actions button {
			min-width: 44px;
			min-height: 44px;
		}

		.path-action-save {
			flex: 0 0 auto;
			min-width: 84px;
			min-height: 44px;
		}
	}

	/* Topbar redesign: compact library-return — a single button, no text block. */
	.library-entry-chip.compact {
		display: flex;
		align-items: center;
		padding: 0;
		border: 0;
		background: transparent;
	}
	.library-entry-chip.compact button {
		white-space: nowrap;
	}
</style>
