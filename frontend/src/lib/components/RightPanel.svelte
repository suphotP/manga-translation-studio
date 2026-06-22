<!-- RightPanel - editor-side work modes, layer controls, AI tools, and project utilities -->
<script lang="ts">
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
	import AiModeContainer from "./AiModeContainer.svelte";
	import LayersModePanel from "./LayersModePanel.svelte";
	import ProjectModePanel from "./ProjectModePanel.svelte";
	import RightPanelHeader from "./RightPanelHeader.svelte";
	import WorkModePanel from "./WorkModePanel.svelte";
	import { _ } from "$lib/i18n";
	import {
		RIGHT_PANEL_TABS,
		buildRightPanelContext,
		buildRightPanelTabMeta,
		type RightPanelContextMetrics,
	} from "$lib/panels/right-panel-model.js";
	import type { RightPanelMode } from "$lib/stores/editor-ui.svelte.ts";
	import TranslateModePanel from "./editor/TranslateModePanel.svelte";
	import { resolveDutyCapabilities } from "$lib/editor/duty-profile.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";

	// Localized label bundle handed to the mode panels (AI / Layers / Project).
	// Built reactively from the `rightPanel.*` i18n namespace so it re-renders on
	// locale change; the typed shape keeps the `Labels` prop contracts below.
	let t = $derived({
		aiTranslation: $_("rightPanel.aiTranslation"),
		language: $_("rightPanel.language"),
		sfx: $_("rightPanel.sfx"),
		generate: $_("rightPanel.generate"),
		customPrompt: $_("rightPanel.customPrompt"),
		customPromptPlaceholder: $_("rightPanel.customPromptPlaceholder"),
		properties: $_("rightPanel.properties"),
		text: $_("rightPanel.text"),
		fontSize: $_("rightPanel.fontSize"),
		alignment: $_("rightPanel.alignment"),
		alignmentLeft: $_("rightPanel.alignmentLeft"),
		alignmentCenter: $_("rightPanel.alignmentCenter"),
		alignmentRight: $_("rightPanel.alignmentRight"),
		canvas: $_("rightPanel.canvas"),
		aspectRatio: $_("rightPanel.aspectRatio"),
		pages: $_("rightPanel.pages"),
	});

	// Page label shown when no project is open. When a project IS open the
	// store-derived `projectStore.pageLabel` ("1/5", "ยังไม่มีหน้า", …) is used.
	let workNotOpenLabel = $derived($_("rightPanel.workNotOpen"));

	// แท็บ "แปล" โชว์เฉพาะ duty ที่แปลได้ (translator/lead/owner) — กรองด้วย
	// ตัวกรองเดียวกับ dock; แท็บอื่นคงเดิม
	let dutyCaps = $derived(resolveDutyCapabilities({
		userId: authStore.user?.id,
		email: authStore.user?.email,
		accountRole: authStore.role,
		memberStudioRole: projectStore.currentWorkspaceMember?.memberStudioRole,
		chapterTeam: projectStore.project?.chapterTeam,
		storyRoles: projectStore.viewerStoryDutyRoles,
	}));
	let panelTabs = $derived(RIGHT_PANEL_TABS.filter((tab) => tab.id !== "translate" || dutyCaps.canTranslate || dutyCaps.canTypeset));

	let openProjectVersionId = $state<string | null>(null);
	let openProjectVersionToken = $state(0);
	let rightPanelContent: HTMLDivElement | null = $state(null);

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
	let currentPageWorkspaceFeed = $derived(projectStore.currentPageWorkspaceFeed);
	let currentPageComments = $derived(
		projectStore.project
			? projectStore.comments.filter((comment) => comment.pageIndex === projectStore.project!.currentPage)
			: []
	);
	let rightPanelMetrics: RightPanelContextMetrics = $derived({
		mode: editorUiStore.rightPanelMode,
		projectOpen: Boolean(projectStore.project),
		pageLabel: projectStore.project ? projectStore.pageLabel : workNotOpenLabel,
		activeTool: editorStore.currentTool,
		aiTier: aiJobsStore.aiTier,
		isGenerating: aiJobsStore.isGenerating,
		brushTargetLabel: editorStore.brushTarget.label,
		brushCanBrush: editorStore.brushTarget.canBrush,
		hasBaseImage: editorStore.hasImage,
		textLayerCount: editorStore.textLayers.length,
		imageLayerCount: editorStore.imageLayers.length,
		selectedLayerText: editorStore.selectedLayer?.text ?? null,
		selectedLayerLocked: editorStore.selectedLayer?.locked === true,
		selectedImageLayerName: editorStore.selectedImageLayer?.originalName ?? editorStore.selectedImageLayer?.imageName ?? null,
		selectedImageLayerLocked: editorStore.selectedImageLayer?.locked === true,
		currentPageInboxCount: currentPageInboxItems.length,
		workspaceFeedCount: projectStore.workspaceFeed.length,
		currentPageWorkspaceFeedCount: currentPageWorkspaceFeed.length,
		qcErrorCount: qcReport.errorCount,
		qcWarningCount: qcReport.warningCount,
		currentPageCommentCount: currentPageComments.length,
		currentPageTaskCount: currentPageTasks.length,
		workflowDoneCount,
		workflowTaskCount: projectStore.tasks.length,
		pageCount: projectStore.project?.pages.length ?? 0,
		versionCount: projectStore.versions.length,
	});
	let rightPanelContext = $derived(buildRightPanelContext(rightPanelMetrics));
	let selectedImageLayerIsAiResult = $derived(
		Boolean(editorStore.selectedImageLayer?.id?.startsWith("ai-result-"))
	);

	function resetRightPanelScroll(): void {
		requestAnimationFrame(() => {
			if (!rightPanelContent) return;
			rightPanelContent.scrollTop = 0;
			rightPanelContent.scrollLeft = 0;
		});
	}

	function getPanelTabMeta(id: RightPanelMode): string {
		return buildRightPanelTabMeta(id, rightPanelMetrics);
	}

	function setRightPanelMode(id: RightPanelMode): void {
		editorUiStore.setRightPanelMode(id);
		resetRightPanelScroll();
	}

	function openVersionReviewTarget(versionId: string): void {
		openProjectVersionId = versionId;
		openProjectVersionToken += 1;
		editorUiStore.setRightPanelMode("project");
		resetRightPanelScroll();
	}

	function openProjectPagesTarget(): void {
		if (!projectStore.project) {
			editorUiStore.setRightPanelMode("project");
			return;
		}
		editorUiStore.openPages();
		queueWorkspaceNavigation({
			view: "pages",
			projectId: projectStore.project.projectId,
		});
	}

	function clearOpenVersionRequest(): void {
		openProjectVersionId = null;
	}

</script>

<div class="right-panel" class:ai-layer-focus={selectedImageLayerIsAiResult}>
	<RightPanelHeader
		pageLabel={projectStore.project ? projectStore.pageLabel : workNotOpenLabel}
		tabs={panelTabs}
		activeMode={editorUiStore.rightPanelMode}
		context={rightPanelContext}
		getTabMeta={getPanelTabMeta}
		onModeChange={setRightPanelMode}
	/>
	<div class="right-panel-content" bind:this={rightPanelContent}>

	<!-- โหมดแปล -->
	{#if editorUiStore.rightPanelMode === "translate"}
		<TranslateModePanel />
	{/if}
	<!-- AI tools -->
	{#if editorUiStore.rightPanelMode === "ai"}
		<AiModeContainer labels={t} />
	{/if}
	<!-- Layers / Inspector -->
	{#if editorUiStore.rightPanelMode === "layers"}
		<LayersModePanel labels={t} />
	{/if}
	<!-- Work -->
	{#if editorUiStore.rightPanelMode === "work"}
		<WorkModePanel onOpenVersionReview={openVersionReviewTarget} onOpenProjectPages={openProjectPagesTarget} />
	{/if}

	<!-- Project -->
	{#if editorUiStore.rightPanelMode === "project"}
		<ProjectModePanel
			labels={t}
			openVersionId={openProjectVersionId}
			openVersionToken={openProjectVersionToken}
			onOpenVersionHandled={clearOpenVersionRequest}
		/>
	{/if}
</div>
</div>

<style>
	/* ── Workspace (ws-*) design-system remap, scoped to the right panel ──
	   The editor mode panels (Work / Project / AI) share a small set of
	   `--editor-*` tokens. Re-pointing those tokens (and the legacy teal accent)
	   at the workspace palette reskins every mode panel + sub-panel to the
	   ws design vocabulary in one place — visual only, no markup/logic change. */
	.right-panel {
		--editor-text: var(--color-ws-ink);
		--editor-text-dim: var(--color-ws-text);
		--editor-text-muted: var(--color-ws-faint);
		--editor-border: var(--ws-hair-strong);
		--editor-border-soft: var(--ws-hair);
		--editor-bg: var(--color-ws-bg);
		--editor-surface: var(--color-ws-surface);
		--editor-surface-raised: var(--color-ws-surface2);
		--editor-accent: var(--color-ws-accent);
		--editor-accent-hover: var(--color-ws-violet);

		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		border-left: 1px solid var(--ws-hair);
		font-family: var(--font-ws-sans);
		background:
			radial-gradient(circle at 80% 0%, color-mix(in srgb, var(--color-ws-accent) 8%, transparent), transparent 28%),
			linear-gradient(180deg, var(--color-ws-surface), var(--color-ws-bg));
	}

	.right-panel-content {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 12px 12px 14px;
		scrollbar-gutter: stable;
	}

	.right-panel-content :global(.panel-section) {
		margin-bottom: 9px;
		overflow: hidden;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow:
			0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset,
			0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}

	.right-panel-content :global(.panel-section-header) {
		padding: 11px 12px;
		background: transparent;
		letter-spacing: 0;
	}

	.right-panel-content :global(.panel-section-body) {
		padding: 11px;
	}

	@media (max-width: 900px) and (orientation: portrait) {
		.right-panel {
			border-top: 1px solid var(--ws-hair);
			border-left: 0;
		}

		.right-panel-content {
			padding: 8px 10px;
		}
	}

	@media (min-width: 901px) and (max-width: 1180px) and (pointer: coarse) {
		.right-panel-content {
			padding: 10px 9px 12px;
		}

		.right-panel.ai-layer-focus :global(.right-panel-context) {
			display: none;
		}

		.right-panel-content :global(.panel-section-header) {
			padding: 10px;
		}

		.right-panel-content :global(.panel-section-body) {
			padding: 10px;
		}
	}

</style>
