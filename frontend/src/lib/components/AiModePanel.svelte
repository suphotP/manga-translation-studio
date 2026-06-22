<script lang="ts">
	import { _ } from "$lib/i18n";
	import { editorStore, type BrushTargetState } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { isAiResultPlacementNeeded } from "$lib/project/ai-review-marker-intent.js";
	import { AI_QUALITY_OPTIONS, isQualityAllowed, type AiImageQuality } from "$lib/project/ai-quality.js";
	import type { AiTier } from "$lib/types.js";
	import AiReviewMarkersPanel from "./AiReviewMarkersPanel.svelte";
	import BatchPanel from "./BatchPanel.svelte";
	import CreditAmount from "./ui/CreditAmount.svelte";

	type BrushMode = "erase" | "restore";

	interface Labels {
		aiTranslation: string;
		language: string;
		sfx: string;
		generate: string;
		customPrompt: string;
		customPromptPlaceholder: string;
	}

	// Stable availability codes produced by AiModeContainer. The panel localizes
	// them via `$_()` and compares on the code — it never parses Thai status text.
	type AiTierAvailabilityReason =
		| "ready"
		| "openai_key"
		| "openrouter_key"
		| "sfx_provider"
		| "worker_unreachable"
		| "worker_no_account"
		| "provider_disabled"
		| "adapter_pending"
		| "provider_not_ready"
		| "needs_scope"
		| "needs_project";
	type AiTierRecoveryReason =
		| "openai_key"
		| "openrouter_key"
		| "sfx_provider"
		| "worker_unreachable"
		| "worker_no_account"
		| "provider_disabled"
		| "adapter_pending"
		| "generic"
		| "needs_scope"
		| "needs_project";

	interface AiTierOption {
		id: AiTier;
		name: string;
		detail: string;
		available?: boolean;
		provider?: string;
		availabilityReason?: AiTierAvailabilityReason;
		recoveryReason?: AiTierRecoveryReason;
	}

	interface Props {
		labels: Labels;
		projectOpen: boolean;
		languages: Record<string, string>;
		targetLang: string;
		aiTier: AiTier;
		aiTierOptions: AiTierOption[];
		aiQuality: AiImageQuality;
		/** Qualities the workspace plan permits; undefined = all allowed (no plan scope yet). */
		allowedAiQualities?: AiImageQuality[];
		planName?: string | null;
		sfxEnabled: boolean;
		isGenerating: boolean;
		/** True when an AI run was clicked with no canvas region selected — drives the inline region hint. */
		needsRegionHint?: boolean;
		customPrompt: string;
		currentTool: string;
		brushTarget: BrushTargetState;
		brushSize: number;
		brushHardness: number;
		brushOpacity: number;
		brushMode: BrushMode;
		brushCommitError?: string | null;
		readyAiResultLabel?: string | null;
		onTargetLangChange: (value: string) => void;
		onAiTierChange: (value: AiTier) => void;
		onAiQualityChange: (value: AiImageQuality) => void;
		onToggleSfx: () => void;
		onGenerate: () => void | Promise<void>;
		onCustomPromptChange: (value: string) => void;
		onBrushSizeChange: (value: number) => void;
		onBrushHardnessChange: (value: number) => void;
		onBrushOpacityChange: (value: number) => void;
		onBrushModeChange: (value: BrushMode) => void;
		onClearBrushMask: () => void;
		onSelectBrush: () => void;
		onAddImageLayer: () => void;
		onUseAiResultLayer: () => void | Promise<void>;
		onOpenLayers: () => void;
	}

	let {
		labels,
		projectOpen,
		languages,
		targetLang,
		aiTier,
		aiTierOptions,
		aiQuality,
		allowedAiQualities = undefined,
		planName = null,
		sfxEnabled,
		isGenerating,
		needsRegionHint = false,
		customPrompt,
		currentTool,
		brushTarget,
		brushSize,
		brushHardness,
		brushOpacity,
		brushMode,
		brushCommitError = null,
		readyAiResultLabel = null,
		onTargetLangChange,
		onAiTierChange,
		onAiQualityChange,
		onToggleSfx,
		onGenerate,
		onCustomPromptChange,
		onBrushSizeChange,
		onBrushHardnessChange,
		onBrushOpacityChange,
		onBrushModeChange,
		onClearBrushMask,
		onSelectBrush,
		onAddImageLayer,
		onUseAiResultLayer,
		onOpenLayers,
	}: Props = $props();

	let aiOpenOverride = $state<boolean | null>(null);
	let aiResultsOpenOverride = $state<boolean | null>(null);
	let brushOpenOverride = $state<boolean | null>(null);
	let currentPageAiReviewMarkers = $derived(projectStore.currentPageAiReviewMarkers);
	let currentPageAiReviewResultCount = $derived(currentPageAiReviewMarkers.length);
	let currentPageAiReviewNeedsReviewCount = $derived(currentPageAiReviewMarkers.filter((marker) => marker.status === "needs_review").length);
	let currentPageAiReviewPlacementCount = $derived(currentPageAiReviewMarkers.filter((marker) => isAiResultPlacementNeeded(projectStore.project, marker)).length);
	let aiResultsOpen = $derived(currentPageAiReviewResultCount > 0 && (aiResultsOpenOverride ?? true));
	let aiOpen = $derived(aiOpenOverride ?? (currentTool !== "brush" && currentPageAiReviewResultCount === 0));
	let brushOpen = $derived(brushOpenOverride ?? currentTool === "brush");
	let clearedSelectionForAiPanel = false;

	const controlIds = {
		aiBody: "ai-mode-controls",
		aiResultsBody: "ai-mode-results",
		brushBody: "ai-brush-controls",
		language: "ai-language-select",
		aiTier: "ai-tier-select",
		aiQuality: "ai-quality-select",
		customPrompt: "ai-custom-prompt",
		brushSize: "brush-size",
		brushHardness: "brush-hardness",
		brushOpacity: "brush-opacity",
	};

	$effect(() => {
		if (editorUiStore.rightPanelMode !== "ai") {
			clearedSelectionForAiPanel = false;
			return;
		}
		if (clearedSelectionForAiPanel) return;
		const selectedImageLayerId = editorStore.selectedImageLayer?.id ?? null;
		if (selectedImageLayerId?.startsWith("ai-result-")) {
			clearedSelectionForAiPanel = true;
			return;
		}
		if (editorStore.selectedLayer || editorStore.selectedImageLayer) {
			editorStore.clearSelection();
			editorUiStore.clearImageInspectorFocus();
		}
		clearedSelectionForAiPanel = true;
	});
	let brushPresets = $derived([
		{ id: "edge", label: $_("aiMode.presetEdgeLabel"), size: 18, hardness: 90, opacity: 100, detail: $_("aiMode.presetEdgeDetail") },
		{ id: "soft", label: $_("aiMode.presetSoftLabel"), size: 42, hardness: 35, opacity: 70, detail: $_("aiMode.presetSoftDetail") },
		{ id: "wide", label: $_("aiMode.presetWideLabel"), size: 72, hardness: 55, opacity: 100, detail: $_("aiMode.presetWideDetail") },
	]);

	let aiPanelTitle = $derived(aiTier === "sfx-pro" ? labels.aiTranslation : "AI Clean");
	let aiActionLabel = $derived(aiTier === "sfx-pro" ? labels.generate : $_("aiMode.cleanArea"));
	let aiBusyLabel = $derived(aiTier === "sfx-pro" ? $_("aiMode.generating") : $_("aiMode.cleaning"));
	let selectedTier = $derived(aiTierOptions.find((tier) => tier.id === aiTier) ?? aiTierOptions[0]);
	let selectedTierAvailable = $derived(selectedTier?.available !== false);
	let selectedReason = $derived<AiTierAvailabilityReason>(selectedTier?.availabilityReason ?? "ready");
	// Reason → status key. The two wrapped reasons share `statusWrapped` (with a
	// localized `{status}` clause); all others select a tier-status key directly.
	// When no reason is carried at all (tier blurb before capabilities resolve),
	// fall back to the generic ready blurb — same as the original `status` default.
	let aiModeStatus = $derived.by(() => {
		const name = selectedTier?.name ?? $_("aiMode.aiModeFallback");
		const provider = selectedTier?.provider ?? "";
		if (!selectedTier?.availabilityReason) {
			return $_("aiMode.modeReady", { values: { name } });
		}
		const statusKeyByReason: Record<Exclude<AiTierAvailabilityReason, "needs_scope" | "needs_project">, string> = {
			ready: "aiMode.statusReady",
			openai_key: "aiMode.statusOpenaiKey",
			openrouter_key: "aiMode.statusOpenrouterKey",
			sfx_provider: "aiMode.statusSfxProvider",
			worker_unreachable: "aiMode.statusWorkerUnreachable",
			worker_no_account: "aiMode.statusWorkerNoAccount",
			provider_disabled: "aiMode.statusProviderDisabled",
			adapter_pending: "aiMode.statusAdapterPending",
			provider_not_ready: "aiMode.statusProviderNotReady",
		};
		if (selectedReason === "needs_scope" || selectedReason === "needs_project") {
			const wrapped = selectedReason === "needs_scope" ? $_("aiMode.wrappedNeedsScope") : $_("aiMode.wrappedNeedsProject");
			return $_("aiMode.statusWrapped", { values: { name, status: wrapped } });
		}
		return $_(statusKeyByReason[selectedReason], { values: { name, provider } });
	});
	let aiModeRecovery = $derived.by(() => {
		const reason = selectedTier?.recoveryReason;
		if (!reason) return null;
		const name = selectedTier?.name ?? $_("aiMode.aiModeFallback");
		const recoveryKeyByReason: Record<AiTierRecoveryReason, string> = {
			openai_key: "aiMode.recoveryOpenaiKey",
			openrouter_key: "aiMode.recoveryOpenrouterKey",
			sfx_provider: "aiMode.recoverySfxProvider",
			worker_unreachable: "aiMode.recoveryWorkerUnreachable",
			worker_no_account: "aiMode.recoveryWorkerNoAccount",
			provider_disabled: "aiMode.recoveryProviderDisabled",
			adapter_pending: "aiMode.recoveryAdapterPending",
			generic: "aiMode.recoveryGeneric",
			needs_scope: "aiMode.recoveryNeedsScope",
			needs_project: "aiMode.recoveryNeedsProject",
		};
		return $_(recoveryKeyByReason[reason], { values: { name } });
	});
	let aiModeSummary = $derived(`${selectedTier?.name ?? $_("aiMode.aiModeFallback")} / ${targetLang.toUpperCase()}`);
	let selectedQualityOption = $derived(AI_QUALITY_OPTIONS.find((option) => option.id === aiQuality) ?? AI_QUALITY_OPTIONS[1]);
	let hasLockedQuality = $derived(AI_QUALITY_OPTIONS.some((option) => !isQualityAllowed(option.id, allowedAiQualities)));
	let aiResultsSummary = $derived(
		currentPageAiReviewNeedsReviewCount || currentPageAiReviewPlacementCount
			? $_("aiMode.resultsSummaryFull", { values: { results: currentPageAiReviewResultCount, review: currentPageAiReviewNeedsReviewCount, place: currentPageAiReviewPlacementCount } })
			: currentPageAiReviewResultCount
				? $_("aiMode.resultsSummaryShort", { values: { results: currentPageAiReviewResultCount } })
			: $_("aiMode.resultsSummaryNone"),
	);
	// The worker runtime states drive distinct eyebrow/meter labels. These now read
	// the STABLE availability code from AiModeContainer instead of substring-matching
	// the (localized) Thai status text — no language coupling.
	let unavailableWorker = $derived(!selectedTierAvailable && selectedReason === "worker_unreachable");
	let unavailableWorkerAccount = $derived(!selectedTierAvailable && selectedReason === "worker_no_account");
	let unavailableRuntime = $derived(unavailableWorker || unavailableWorkerAccount);
	let aiFocusTone = $derived(
		!projectOpen ? "blocked" : (!selectedTierAvailable ? "warning" : (isGenerating ? "running" : (needsRegionHint ? "warning" : "ready"))),
	);
	let aiFocusEyebrow = $derived(
		isGenerating
			? $_("aiMode.eyebrowRunning")
			: (!projectOpen ? $_("aiMode.eyebrowNoProject") : (!selectedTierAvailable ? (unavailableWorkerAccount ? $_("aiMode.accountNotReady") : (unavailableWorker ? $_("aiMode.workerNotResponding") : $_("aiMode.needsSetup"))) : $_("aiMode.ready"))),
	);
	let aiMeterLabel = $derived(selectedTierAvailable ? $_("aiMode.ready") : (unavailableWorkerAccount ? $_("aiMode.accountNotReady") : (unavailableWorker ? $_("aiMode.workerNotResponding") : $_("aiMode.needsSetup"))));
	let aiFocusTitle = $derived(aiTier === "sfx-pro" ? $_("aiMode.focusTitleSfx") : $_("aiMode.focusTitleClean"));
	let aiFocusDetail = $derived(
		!projectOpen
			? $_("aiMode.focusDetailNoProject")
			: !selectedTierAvailable
				? (aiModeRecovery ?? aiModeStatus)
				: isGenerating
					? $_("aiMode.focusDetailRunning")
					: aiTier === "sfx-pro"
						? $_("aiMode.focusDetailSfx")
						: $_("aiMode.focusDetailClean"),
	);
	let sfxStateLabel = $derived(aiTier === "sfx-pro" ? (sfxEnabled ? $_("aiMode.sfxOn") : $_("aiMode.sfxOff")) : $_("aiMode.cleanOnly"));
	let projectStateLabel = $derived(projectOpen ? $_("aiMode.projectOpen") : $_("aiMode.eyebrowNoProject"));
	let aiActionUnavailableLabel = $derived(
		!projectOpen
			? $_("aiMode.openProjectBeforeRun")
			: !selectedTierAvailable
				? $_("aiMode.setupModeBeforeRun")
				: "",
	);
	let sfxToggleUnavailableLabel = $derived(
		aiTier !== "sfx-pro"
			? $_("aiMode.sfxOnlySfxPro")
			: !selectedTierAvailable
				? $_("aiMode.sfxNotReady")
				: "",
	);
	let brushSummary = $derived(
		currentTool === "brush"
			? `${brushTarget.label} / ${brushSize}px`
			: $_("aiMode.pickBrushTool"),
	);
	let brushTargetLabel = $derived(
		currentTool !== "brush"
			? $_("aiMode.brushNotOpen")
			: brushTarget.label,
	);
	let brushTargetTitle = $derived(
		currentTool !== "brush"
			? $_("aiMode.openBrushBeforeErase")
			: brushTarget.titleCode
				? $_(`brushTarget.title.${brushTarget.titleCode}`)
				: brushTarget.title,
	);
	let brushTargetDetail = $derived(
		currentTool !== "brush"
			? $_("aiMode.brushManualHint")
			: brushMode === "restore" && brushTarget.canRestore
				? brushTarget.restoreHint
				: brushTarget.detail,
	);
	let showBrushRestoreMode = $derived(brushTarget.kind !== "image-layer" || brushTarget.canRestore);
	let brushRestorePending = $derived(brushTarget.kind === "image-layer" && brushTarget.canBrush && !brushTarget.canRestore);
	let brushContractLabel = $derived(brushTarget.canBrush ? $_("aiMode.brushReadyToUse") : $_("aiMode.pickTargetFirst"));
	let brushContractDetail = $derived(
		brushTarget.canBrush
			? `${brushTarget.label} / ${brushSize}px`
			: $_("aiMode.brushContractHint"),
	);
	let brushRecoveryOwner = $derived(
		brushTarget.kind === "image-layer"
			? $_("aiMode.brushOwnerImageLayer")
			: brushTarget.kind === "ai-mask"
				? $_("aiMode.brushOwnerAiMask")
				: $_("aiMode.brushOwnerCurrent"),
	);
	let brushRecoveryNextStep = $derived(
		brushTarget.kind === "image-layer"
			? $_("aiMode.brushNextStepImageLayer")
			: brushTarget.kind === "ai-mask"
				? $_("aiMode.brushNextStepAiMask")
				: $_("aiMode.brushNextStepDefault"),
	);

	function updateTargetLang(event: Event): void {
		onTargetLangChange((event.currentTarget as HTMLSelectElement).value);
	}

	function updateAiTier(event: Event): void {
		onAiTierChange((event.currentTarget as HTMLSelectElement).value as AiTier);
	}

	function updateCustomPrompt(event: Event): void {
		onCustomPromptChange((event.currentTarget as HTMLInputElement).value);
	}

	function updateBrushSize(event: Event): void {
		onBrushSizeChange(Number((event.currentTarget as HTMLInputElement).value));
	}

	function updateBrushHardness(event: Event): void {
		onBrushHardnessChange(Number((event.currentTarget as HTMLInputElement).value));
	}

	function updateBrushOpacity(event: Event): void {
		onBrushOpacityChange(Number((event.currentTarget as HTMLInputElement).value));
	}

	function applyBrushPreset(preset: typeof brushPresets[number]): void {
		onBrushSizeChange(preset.size);
		onBrushHardnessChange(preset.hardness);
		onBrushOpacityChange(preset.opacity);
	}
</script>

{#if currentTool === "brush" && !brushTarget.canBrush}
	<section class={`brush-command-strip ws-panel ${brushTarget.tone}`} aria-label={$_("aiMode.brushCleanStatusLabel")}>
		<div class="brush-command-copy">
			<span>{brushContractLabel}</span>
			<small>{brushContractDetail}</small>
		</div>
		<div class="brush-command-actions">
			{#if projectOpen}
				{#if readyAiResultLabel}
					<button type="button" class="panel-btn panel-btn-primary ws-grad-primary" onclick={onUseAiResultLayer}>
						{$_("aiMode.placeAiLayer")}
					</button>
				{/if}
				<button type="button" class="panel-btn panel-btn-primary ws-grad-primary" onclick={onAddImageLayer}>
					{$_("aiMode.addFixImage")}
				</button>
				<button type="button" class="panel-btn ws-btn-ghost" onclick={onOpenLayers}>
					{$_("aiMode.openLayersPanel")}
				</button>
			{:else}
				<span class="brush-command-action-state">{$_("aiMode.openChapterBeforeLayer")}</span>
			{/if}
		</div>
	</section>
{/if}

{#if currentPageAiReviewResultCount > 0}
	<div class="panel-section ai-results-section ws-panel">
		<button
			type="button"
			class="panel-section-header ai-section-header"
			aria-label={`${$_("aiMode.pageResults")} ${aiResultsOpen ? $_("aiMode.expanded") : $_("aiMode.collapsed")}: ${aiResultsSummary}`}
			aria-expanded={aiResultsOpen}
			aria-controls={controlIds.aiResultsBody}
			onclick={() => aiResultsOpenOverride = !aiResultsOpen}
		>
			<span class="ai-section-copy">
				<span>{$_("aiMode.pageResults")}</span>
				<small>{aiResultsSummary}</small>
			</span>
			<span class="ai-section-meter active">
				{$_("aiMode.resultsCount", { values: { n: currentPageAiReviewResultCount } })}
			</span>
			<span class="ai-section-chevron" class:open={aiResultsOpen} aria-hidden="true"></span>
		</button>
		{#if aiResultsOpen}
			<div id={controlIds.aiResultsBody} class="panel-section-body ai-results-body" role="region" aria-label={$_("aiMode.reviewQueueLabel")}>
				<AiReviewMarkersPanel embedded />
			</div>
		{/if}
	</div>
{/if}

<div class="panel-section">
	<button
		type="button"
		class="panel-section-header ai-section-header"
		aria-label={`${aiPanelTitle} ${aiOpen ? $_("aiMode.expanded") : $_("aiMode.collapsed")}: ${aiModeSummary}`}
		aria-expanded={aiOpen}
		aria-controls={controlIds.aiBody}
		onclick={() => aiOpenOverride = !aiOpen}
	>
		<span class="ai-section-copy">
			<span>{aiPanelTitle}</span>
			<small>{aiModeSummary}</small>
			</span>
			<span class="ai-section-meter" class:warn={!selectedTierAvailable}>
				{aiMeterLabel}
			</span>
		<span class="ai-section-chevron" class:open={aiOpen} aria-hidden="true"></span>
	</button>
	{#if aiOpen}
		<div id={controlIds.aiBody} class="panel-section-body flex flex-col gap-2">
			<section class={`ai-focus-card ws-panel ${aiFocusTone}`} aria-label={$_("aiMode.focusLabel")}>
				<div class="ai-focus-copy">
					<span>{aiFocusEyebrow}</span>
					<strong>{aiFocusTitle}</strong>
					<small>{aiFocusDetail}</small>
				</div>
				<div class="ai-focus-chips" aria-label={$_("aiMode.contextLabel")}>
					<span>{selectedTier?.name ?? $_("aiMode.aiModeFallback")}</span>
					<span>{targetLang.toUpperCase()}</span>
					<span>{sfxStateLabel}</span>
					<span>{projectStateLabel}</span>
				</div>
				{#if needsRegionHint}
					<!-- Region affordance: the AI run was clicked with no canvas region
					     selected, so make the next step unmistakable instead of silent. -->
					<div class="ai-region-hint" role="status" aria-label={$_("aiPanel.regionHintTitle")}>
						<span class="ai-region-hint-badge">{$_("aiPanel.regionHintBadge")}</span>
						<span class="ai-region-hint-copy">
							<strong>{$_("aiPanel.regionHintTitle")}</strong>
							<small>{$_("aiPanel.regionHintDetail")}</small>
						</span>
					</div>
				{/if}
				{#if isGenerating}
					<div class="panel-btn panel-btn-primary ws-grad-primary ai-focus-action ai-focus-action-receipt loading" role="status" aria-label={aiBusyLabel}>
						<span class="spinner"></span>
						{aiBusyLabel}
					</div>
				{:else if aiActionUnavailableLabel}
					<div class="ai-focus-action-state" role="note">{aiActionUnavailableLabel}</div>
				{:else}
					<button
						class="panel-btn panel-btn-primary ws-grad-primary ai-focus-action"
						aria-label={aiActionLabel}
						onclick={onGenerate}
					>
						<span>{aiActionLabel}</span>
						<!-- The per-op charge is driven by the selected QUALITY (1/9/36), not the
						     tier — show it on the commit button so the cost is unambiguous and
						     matches exactly what generate reserves (no "Budget" implies-cheap
						     surprise when สูง is picked). White-on-accent, so render plain
						     (CreditAmount tones force their own color). -->
						<span class="ai-focus-action-cost">{$_("aiMode.creditsPerRun", { values: { credits: selectedQualityOption.creditUnits } })}</span>
					</button>
				{/if}
			</section>

			<div>
				<label class="panel-label" for={controlIds.language}>{labels.language}</label>
				<select
					id={controlIds.language}
					class="panel-select"
					value={targetLang}
					onchange={updateTargetLang}
				>
					{#each Object.entries(languages) as [code, name] (code)}
						<option value={code}>{name}</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="panel-label" for={controlIds.aiTier}>{$_("aiMode.aiModeLabel")}</label>
				<select
					id={controlIds.aiTier}
					class="panel-select"
					value={aiTier}
					onchange={updateAiTier}
				>
					{#each aiTierOptions as tier (tier.id)}
						<option value={tier.id}>
							{tier.name} - {tier.available === false ? $_("aiMode.notAvailableYet") : tier.detail}
						</option>
					{/each}
					</select>
					<div class="ai-mode-status" class:warn={!selectedTierAvailable}>{aiModeStatus}</div>
					{#if !selectedTierAvailable && aiModeRecovery}
						<div class="ai-recovery-card" role="note" aria-label={$_("aiMode.recoveryCardLabel")}>
							<span>{$_("aiMode.nextFix")}</span>
							<small>{aiModeRecovery}</small>
						</div>
					{/if}
				</div>

			<div>
				<div class="ai-quality-head">
					<span class="panel-label" id={controlIds.aiQuality} style="margin-bottom:0">{$_("aiMode.aiQualityLabel")}</span>
					<span class="ai-quality-current">
						{selectedQualityOption.label}
						<CreditAmount credits={selectedQualityOption.creditUnits} compact={false} size="xs" tone="cyan" />
						<span class="ai-quality-current-unit">{$_("aiMode.perRunUnit")}</span>
					</span>
				</div>
				<div class="ai-quality-grid" role="group" aria-labelledby={controlIds.aiQuality}>
					{#each AI_QUALITY_OPTIONS as option (option.id)}
						{@const allowed = isQualityAllowed(option.id, allowedAiQualities)}
						<button
							type="button"
							class="ai-quality-btn"
							class:active={aiQuality === option.id && allowed}
							class:locked={!allowed}
							aria-pressed={aiQuality === option.id}
							aria-disabled={!allowed}
							disabled={!allowed}
							title={allowed
								? $_("aiMode.qualityAllowedTitle", { values: { sub: option.subLabel, detail: option.detail, credits: option.creditUnits } })
								: $_("aiMode.qualityLockedTitle", { values: { sub: option.subLabel, plan: planName ? ` ${planName}` : "" } })}
							onclick={() => { if (allowed) onAiQualityChange(option.id); }}
						>
							<span class="ai-quality-name">
								<strong>{option.label}</strong>
								<small>{option.subLabel}</small>
							</span>
							<span class="ai-quality-cost">
								<CreditAmount credits={option.creditUnits} compact={false} size="xs" tone={allowed ? (aiQuality === option.id ? "cyan" : "faint") : "faint"} />
							</span>
							{#if !allowed}
								<span class="ai-quality-lock" aria-hidden="true">
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none">
										<rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.8" />
										<path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.8" />
									</svg>
								</span>
							{/if}
						</button>
					{/each}
				</div>
				{#if hasLockedQuality}
					<div class="ai-quality-upsell" role="note">
						{$_("aiMode.qualityUpsell", { values: { plan: planName ? ` ${planName}` : "" } })}
					</div>
				{/if}
			</div>

			<div class="flex items-center justify-between">
				<span class="panel-label" style="margin-bottom:0">{labels.sfx}</span>
				{#if sfxToggleUnavailableLabel}
					<span class="panel-toggle-state">{sfxToggleUnavailableLabel}</span>
				{:else}
					<button
						class="panel-toggle"
						class:on={sfxEnabled}
						onclick={onToggleSfx}
						aria-label={$_("aiMode.toggleSfx")}
						aria-pressed={sfxEnabled}
					></button>
				{/if}
			</div>

			<div>
				<label class="panel-label" for={controlIds.customPrompt}>{labels.customPrompt}</label>
				<input
					id={controlIds.customPrompt}
					class="panel-input"
					type="text"
					placeholder={labels.customPromptPlaceholder}
					value={customPrompt}
					oninput={updateCustomPrompt}
				/>
			</div>
		</div>
	{/if}
</div>

<div class="panel-section">
	<button
		type="button"
		class="panel-section-header ai-section-header"
		aria-label={`${$_("aiMode.brushClean")} ${brushOpen ? $_("aiMode.expanded") : $_("aiMode.collapsed")}: ${brushSummary}`}
		aria-expanded={brushOpen}
		aria-controls={controlIds.brushBody}
		onclick={() => brushOpenOverride = !brushOpen}
	>
		<span class="ai-section-copy">
			<span>{$_("aiMode.brushClean")}</span>
			<small>{brushSummary}</small>
		</span>
		<span class="ai-section-meter" class:active={currentTool === "brush"}>
			{brushTargetLabel}
		</span>
		<span class="ai-section-chevron" class:open={brushOpen} aria-hidden="true"></span>
	</button>
	{#if brushOpen}
		<div id={controlIds.brushBody} class="panel-section-body flex flex-col gap-2">
			{#if brushCommitError}
				<section class="brush-commit-alert" role="alert" aria-label={$_("aiMode.brushCommitFailedLabel")}>
					<div>
						<span>{$_("aiMode.holdSaveExport")}</span>
						<strong>{$_("aiMode.brushNotSaved")}</strong>
						<small>{brushCommitError}</small>
					</div>
					<ul class="brush-recovery-steps" aria-label={$_("aiMode.brushRecoveryStepsLabel")}>
						<li>{brushRecoveryOwner}</li>
						<li>{brushRecoveryNextStep}</li>
						<li>{$_("aiMode.brushStepSaveAgain")}</li>
					</ul>
					<div class="brush-recovery-actions">
						<button type="button" class="panel-btn panel-btn-primary ws-grad-primary" onclick={onSelectBrush}>
							{$_("aiMode.backToBrush")}
						</button>
						{#if projectOpen}
							<button type="button" class="panel-btn ws-btn-ghost" onclick={onOpenLayers}>
								{$_("aiMode.viewTargetLayer")}
							</button>
						{:else}
							<span class="brush-command-action-state">{$_("aiMode.openChapterBeforeViewLayer")}</span>
						{/if}
						{#if brushTarget.canClearMask}
							<button
								type="button"
								class="panel-btn ws-btn-ghost brush-danger-action"
								onclick={onClearBrushMask}
								title={$_("aiMode.restoreFullAiTitle")}
							>
								{$_("aiMode.restoreFullAi")}
							</button>
						{/if}
					</div>
				</section>
			{/if}
			<section class={`brush-target-card ws-panel ${currentTool === "brush" ? "active" : "idle"}`} aria-label={$_("aiMode.brushTargetLabel")}>
				<div class="brush-target-copy">
					<span>{brushTargetLabel}</span>
					<strong>{brushTargetTitle}</strong>
					<small>{brushTargetDetail}</small>
				</div>
				{#if currentTool !== "brush"}
					<div class="brush-target-actions">
						<button type="button" class="panel-btn panel-btn-primary ws-grad-primary brush-target-action" onclick={onSelectBrush}>
							{$_("aiMode.openBrush")}
						</button>
					</div>
				{:else if !brushTarget.canBrush}
					<p class="brush-target-action-note">
						{$_("aiMode.useCommandsAboveHint")}
					</p>
				{/if}
			</section>
			{#if currentTool === "brush" && brushTarget.canBrush}
				<div class="brush-mode-toggle" aria-label={$_("aiMode.brushModeLabel")}>
						<button
							type="button"
							class:active={brushMode === "erase" && brushTarget.canBrush}
							aria-pressed={brushMode === "erase"}
							onclick={() => onBrushModeChange("erase")}
						>
							{$_(`brushTarget.erase.${brushTarget.eraseLabelCode}`)}
						</button>
						{#if showBrushRestoreMode}
							{#if brushTarget.canRestore}
								<button
									type="button"
									class:active={brushMode === "restore"}
									aria-pressed={brushMode === "restore"}
									onclick={() => onBrushModeChange("restore")}
									title={brushTarget.restoreHint}
								>
									{$_(`brushTarget.restore.${brushTarget.restoreLabelCode}`)}
								</button>
							{:else}
								<span class="brush-mode-state" title={brushTarget.restoreHint}>
									{$_("aiMode.brushRestoreNotReady")}
								</span>
							{/if}
						{/if}
					</div>
				{#if brushRestorePending}
					<div class="brush-restore-pending" role="note">
						{$_("aiMode.brushRestorePending")}
					</div>
				{/if}
				<div class="brush-preset-grid" aria-label={$_("aiMode.brushPresetLabel")}>
					{#each brushPresets as preset (preset.id)}
							<button
								type="button"
								class="brush-preset-btn"
								onclick={() => applyBrushPreset(preset)}
								title={`${preset.detail}: ${preset.size}px / ${preset.hardness}% / ${preset.opacity}%`}
							>
							<strong>{preset.label}</strong>
							<span>{preset.size}px / {preset.hardness}%</span>
						</button>
					{/each}
				</div>
				<div>
					<label class="panel-label" for={controlIds.brushSize}>{$_("aiMode.brushSizeLabel", { values: { size: brushSize } })}</label>
					<input
						id={controlIds.brushSize}
						class="panel-input"
						type="range"
						min="5"
						max="100"
						value={brushSize}
						oninput={updateBrushSize}
						style="height: 40px !important; min-height: 40px !important;"
					/>
				</div>
				<div>
					<label class="panel-label" for={controlIds.brushHardness}>{$_("aiMode.brushHardnessLabel", { values: { hardness: brushHardness } })}</label>
					<input
						id={controlIds.brushHardness}
						class="panel-input"
						type="range"
						min="0"
						max="100"
						value={brushHardness}
						oninput={updateBrushHardness}
						style="height: 40px !important; min-height: 40px !important;"
					/>
				</div>
				<div>
					<label class="panel-label" for={controlIds.brushOpacity}>{$_("aiMode.brushOpacityLabel", { values: { opacity: brushOpacity } })}</label>
					<input
						id={controlIds.brushOpacity}
						class="panel-input"
						type="range"
						min="0"
						max="100"
						value={brushOpacity}
						oninput={updateBrushOpacity}
						style="height: 40px !important; min-height: 40px !important;"
					/>
				</div>
				{#if brushTarget.kind === "image-layer"}
					<div class="brush-target-note">
						{$_("aiMode.brushImageLayerNote", { values: { impact: brushTarget.impact } })}
					</div>
				{:else if brushTarget.canClearMask}
					<details class="legacy-brush-details">
						<summary>{$_("aiMode.legacyTools")}</summary>
						<div class="legacy-brush-body">
							<button
								class="panel-btn ws-btn-ghost"
								onclick={onClearBrushMask}
								title={$_("aiMode.restoreFullAiTitle")}
							>
								{$_("aiMode.restoreFullAi")}
							</button>
							<div class="brush-target-note danger-note">
								{$_("aiMode.legacyDangerNote")}
							</div>
						</div>
					</details>
				{:else}
					<div class="brush-target-note">{brushTarget.detail}</div>
				{/if}
			{:else}
				<div class="brush-target-note">{readyAiResultLabel ?? $_("aiMode.brushDefaultHint")}</div>
			{/if}
		</div>
	{/if}
</div>

<BatchPanel compactWhenReviewing={currentPageAiReviewResultCount > 0} />

<style>
	.spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		margin-right: 6px;
		border: 2px solid color-mix(in srgb, var(--color-ws-ink, #ECECF2) 30%, transparent);
		border-top-color: var(--color-ws-ink, #ECECF2);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.panel-btn.loading {
		animation: pulse 1.5s ease-in-out infinite;
	}

	.panel-btn {
		min-height: 40px;
		border-radius: var(--radius-ws-ctrl, 10px);
	}

	.panel-btn-primary.ws-grad-primary {
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 52%, transparent);
		background: linear-gradient(100deg, var(--color-ws-violet, #8B5CF6) 0%, var(--color-ws-accent, #7C5CFF) 100%);
		color: var(--color-ws-ink, #ECECF2);
	}

	.panel-btn.ws-btn-ghost {
		border: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-surface, #15151D) 42%, transparent);
		color: var(--color-ws-ink, #ECECF2);
	}

	.ai-results-section {
		border-color: color-mix(in srgb, var(--color-ws-green, #34D399) 22%, transparent);
		background: color-mix(in srgb, var(--color-ws-green, #34D399) 4%, var(--color-ws-surface, #15151D));
	}

	.ai-results-body {
		padding-top: 8px;
	}

	.ai-focus-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 28%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		padding: 10px;
		background:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 14%, transparent),
				color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 82%, transparent)
			),
			var(--color-ws-surface, #15151D);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-ws-ink, #ECECF2) 4%, transparent);
	}

	.ai-focus-card.ready {
		border-color: color-mix(in srgb, var(--color-ws-green, #34D399) 30%, transparent);
		background:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--color-ws-green, #34D399) 15%, transparent),
				color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 84%, transparent)
			),
			var(--color-ws-surface, #15151D);
	}

	.ai-focus-card.running {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 34%, transparent);
		background:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 18%, transparent),
				color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 86%, transparent)
			),
			var(--color-ws-surface, #15151D);
	}

	.ai-focus-card.warning,
	.ai-focus-card.blocked {
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 32%, transparent);
		background:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--color-ws-amber, #FBBF24) 14%, transparent),
				color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 86%, transparent)
			),
			var(--color-ws-surface, #15151D);
	}

	.ai-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.ai-focus-copy span {
		color: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 64%, var(--color-ws-ink, #ECECF2));
		font-size: 10px;
		font-weight: 820;
		line-height: 1.2;
		text-transform: none;
	}

	.ai-focus-card.ready .ai-focus-copy span {
		color: color-mix(in srgb, var(--color-ws-green, #34D399) 72%, var(--color-ws-ink, #ECECF2));
	}

	.ai-focus-card.warning .ai-focus-copy span,
	.ai-focus-card.blocked .ai-focus-copy span {
		color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 78%, var(--color-ws-ink, #ECECF2));
	}

	.ai-focus-copy strong {
		color: var(--color-ws-ink, #ECECF2);
		font-size: 13px;
		font-weight: 820;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	.ai-focus-copy small {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
		font-weight: 620;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.ai-focus-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.ai-focus-chips span {
		border: 1px solid var(--ws-hair-strong);
		border-radius: 999px;
		padding: 2px 7px;
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 62%, transparent);
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
	}

	.ai-focus-action {
		width: 100%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 40px;
	}

	.ai-focus-action-cost {
		display: inline-flex;
		align-items: baseline;
		font-size: 11px;
		font-weight: 760;
		opacity: 0.9;
		white-space: nowrap;
	}

	.ai-focus-action-receipt {
		cursor: default;
	}

	.ai-region-hint {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 8px 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 36%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 11%, var(--color-ws-surface, #15151D));
	}

	.ai-region-hint-badge {
		flex-shrink: 0;
		margin-top: 1px;
		padding: 2px 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 40%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 14%, transparent);
		color: var(--color-ws-amber, #FBBF24);
		font-size: 9px;
		font-weight: 820;
		line-height: 1.3;
		white-space: nowrap;
	}

	.ai-region-hint-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.ai-region-hint-copy strong {
		color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 62%, var(--color-ws-ink, #ECECF2));
		font-size: 11.5px;
		font-weight: 840;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	.ai-region-hint-copy small {
		color: var(--color-ws-amber, #FBBF24);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.ai-focus-action-state {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		width: 100%;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 24%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 9%, var(--color-ws-surface, #15151D));
		color: var(--color-ws-amber, #FBBF24);
		font-size: 11px;
		font-weight: 820;
		line-height: 1.25;
		text-align: center;
	}

	.ai-section-header {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 8px;
		text-align: left;
		text-transform: none;
	}

	.ai-section-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.ai-section-copy > span {
		overflow: hidden;
		text-overflow: ellipsis;
		text-transform: none;
		white-space: nowrap;
	}

	.ai-section-copy small {
		overflow: hidden;
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: none;
	}

	.ai-section-meter {
		border: 1px solid color-mix(in srgb, var(--color-ws-green, #34D399) 26%, transparent);
		border-radius: 999px;
		padding: 2px 7px;
		background: color-mix(in srgb, var(--color-ws-green, #34D399) 8%, transparent);
		color: var(--color-ws-green, #34D399);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
		white-space: nowrap;
		text-transform: none;
	}

	.ai-section-meter.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 10%, transparent);
		color: var(--color-ws-amber, #FBBF24);
	}

	.ai-section-meter.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 10%, transparent);
		color: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 68%, var(--color-ws-ink, #ECECF2));
	}

	.ai-section-chevron {
		justify-self: end;
		width: 7px;
		height: 7px;
		border-right: 1.5px solid var(--color-ws-text, #9A9AA8);
		border-bottom: 1.5px solid var(--color-ws-text, #9A9AA8);
		transform: rotate(-45deg);
		transition: transform 120ms ease, border-color 120ms ease;
	}

	.ai-section-header:hover .ai-section-chevron,
	.ai-section-chevron.open {
		border-color: var(--color-ws-ink, #ECECF2);
	}

	.ai-section-chevron.open {
		transform: rotate(45deg);
	}

	.ai-mode-status {
		margin-top: 5px;
		padding: 6px 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green, #34D399) 22%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-green, #34D399) 8%, transparent);
		color: var(--color-ws-green, #34D399);
		font-size: 10px;
		font-weight: 760;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	.ai-mode-status.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 10%, transparent);
		color: var(--color-ws-amber, #FBBF24);
	}

	.ai-quality-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 6px;
	}

	.ai-quality-current {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 11px;
		font-weight: 800;
		line-height: 1.1;
	}

	.ai-quality-current-unit {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 650;
	}

	.ai-quality-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}

	.ai-quality-btn {
		position: relative;
		display: flex;
		min-width: 0;
		min-height: 56px;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 4px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 22%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		padding: 7px 8px;
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 62%, transparent);
		color: var(--color-ws-ink, #ECECF2);
		text-align: left;
		cursor: pointer;
		transition: border-color 120ms ease, background 120ms ease;
	}

	.ai-quality-btn:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 44%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 10%, transparent);
	}

	.ai-quality-btn.active {
		border-color: color-mix(in srgb, var(--color-ws-cyan, #22D3EE) 50%, transparent);
		background:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--color-ws-cyan, #22D3EE) 16%, transparent),
				color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 82%, transparent)
			),
			var(--color-ws-surface, #15151D);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-ws-cyan, #22D3EE) 18%, transparent);
	}

	.ai-quality-btn.locked {
		cursor: not-allowed;
		opacity: 0.55;
		border-style: dashed;
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 9%, var(--color-ws-surface, #15151D));
	}

	.ai-quality-name {
		display: flex;
		align-items: baseline;
		gap: 5px;
		min-width: 0;
	}

	.ai-quality-name strong {
		font-size: 13px;
		font-weight: 840;
		line-height: 1.1;
	}

	.ai-quality-name small {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 9px;
		font-weight: 720;
		line-height: 1.1;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.ai-quality-cost {
		display: inline-flex;
		align-items: center;
	}

	.ai-quality-lock {
		position: absolute;
		top: 6px;
		right: 6px;
		display: inline-flex;
		color: var(--color-ws-amber, #FBBF24);
	}

	.ai-quality-upsell {
		margin-top: 6px;
		padding: 6px 7px;
		border: 1px dashed color-mix(in srgb, var(--color-ws-amber, #FBBF24) 26%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 6%, transparent);
		color: var(--color-ws-amber, #FBBF24);
		font-size: 10px;
		font-weight: 720;
		line-height: 1.3;
	}

	.panel-toggle-state {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		padding: 0 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 22%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 9%, var(--color-ws-surface, #15151D));
		color: var(--color-ws-amber, #FBBF24);
		font-size: 10px;
		font-weight: 780;
		line-height: 1.2;
		white-space: nowrap;
	}

	.ai-recovery-card {
		margin-top: 6px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 22%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		padding: 7px;
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 10%, var(--color-ws-surface, #15151D));
	}

	.ai-recovery-card span {
		color: var(--color-ws-amber, #FBBF24);
		font-size: 10px;
		font-weight: 840;
		line-height: 1.2;
	}

	.ai-recovery-card small {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.35;
		overflow-wrap: break-word;
		word-break: normal;
	}

	.brush-command-strip {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
		margin-bottom: 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green, #34D399) 22%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		padding: 8px 9px;
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 72%, transparent);
	}

	.brush-command-strip.blocked {
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 26%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 10%, var(--color-ws-surface, #15151D));
	}

	.brush-command-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.brush-command-copy span {
		color: var(--color-ws-green, #34D399);
		font-size: 11px;
		font-weight: 860;
		line-height: 1.15;
		text-transform: none;
	}

	.brush-command-strip.blocked .brush-command-copy span {
		color: var(--color-ws-amber, #FBBF24);
	}

	.brush-command-copy small {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 680;
		line-height: 1.3;
		overflow-wrap: break-word;
		word-break: normal;
	}

	.brush-command-actions {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		min-width: 0;
		flex-wrap: wrap;
		gap: 6px;
	}

	.brush-command-actions .panel-btn {
		flex: 1 1 96px;
		min-width: 96px;
	}

	.brush-command-action-state {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		flex: 1 1 100%;
		padding: 0 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 22%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 9%, var(--color-ws-surface, #15151D));
		color: var(--color-ws-amber, #FBBF24);
		font-size: 10px;
		font-weight: 780;
		line-height: 1.25;
		text-align: center;
	}

	.brush-target-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 24%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		padding: 9px;
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 72%, transparent);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-ws-ink, #ECECF2) 4%, transparent);
	}

	.brush-target-card.active {
		border-color: color-mix(in srgb, var(--color-ws-green, #34D399) 30%, transparent);
		background:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--color-ws-green, #34D399) 12%, transparent),
				color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 76%, transparent)
			),
			var(--color-ws-surface, #15151D);
	}

	.brush-target-copy {
		display: flex;
		flex: 1 1 180px;
		min-width: min(100%, 180px);
		flex-direction: column;
		gap: 3px;
	}

	.brush-target-copy span {
		color: var(--color-ws-green, #34D399);
		font-size: 10px;
		font-weight: 820;
		line-height: 1.2;
	}

	.brush-target-card.idle .brush-target-copy span {
		color: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 64%, var(--color-ws-ink, #ECECF2));
	}

	.brush-target-copy strong {
		color: var(--color-ws-ink, #ECECF2);
		font-size: 12px;
		font-weight: 820;
		line-height: 1.2;
		overflow-wrap: break-word;
		word-break: normal;
	}

	.brush-target-copy small,
	.brush-target-note {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.35;
		overflow-wrap: break-word;
		word-break: normal;
	}

	.brush-target-actions {
		display: flex;
		flex: 0 1 100%;
		min-width: 0;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.brush-target-action {
		min-width: 86px;
		min-height: 40px;
		justify-content: center;
	}

	.brush-target-action-note {
		flex: 1 1 120px;
		margin: 0;
		color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 82%, transparent);
		font-size: 10px;
		font-weight: 720;
		line-height: 1.35;
		text-align: right;
	}

	.legacy-brush-details {
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 22%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 8%, var(--color-ws-surface, #15151D));
	}

	.legacy-brush-details summary {
		min-height: 40px;
		padding: 10px;
		color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 64%, var(--color-ws-ink, #ECECF2));
		font-size: 11px;
		font-weight: 840;
		cursor: pointer;
	}

	.legacy-brush-body {
		display: grid;
		gap: 7px;
		padding: 0 10px 10px;
	}

	.brush-commit-alert {
		display: grid;
		gap: 6px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber, #FBBF24) 42%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		padding: 9px;
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 12%, var(--color-ws-surface, #15151D));
		color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 62%, var(--color-ws-ink, #ECECF2));
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-ws-ink, #ECECF2) 6%, transparent);
	}

	.brush-commit-alert div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.brush-commit-alert span {
		font-size: 10px;
		font-weight: 850;
		line-height: 1.2;
		text-transform: none;
	}

	.brush-commit-alert strong {
		color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 35%, var(--color-ws-ink, #ECECF2));
		font-size: 12px;
		font-weight: 850;
		line-height: 1.2;
	}

	.brush-commit-alert small,
	.brush-commit-alert p {
		margin: 0;
		color: var(--color-ws-amber, #FBBF24);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.brush-recovery-steps {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.brush-recovery-steps li {
		position: relative;
		padding-left: 12px;
		color: var(--color-ws-amber, #FBBF24);
		font-size: 10px;
		font-weight: 650;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.brush-recovery-steps li::before {
		position: absolute;
		top: 0.47em;
		left: 1px;
		width: 4px;
		height: 4px;
		border-radius: 999px;
		background: var(--color-ws-amber, #FBBF24);
		content: "";
	}

	.brush-recovery-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
	}

	.brush-recovery-actions .panel-btn {
		min-height: 40px;
		white-space: normal;
	}

	.brush-recovery-actions .brush-danger-action {
		grid-column: 1 / -1;
		border-color: color-mix(in srgb, var(--color-ws-rose, #FB7185) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 16%, transparent);
		color: color-mix(in srgb, var(--color-ws-rose, #FB7185) 36%, var(--color-ws-ink, #ECECF2));
	}

	.brush-mode-toggle {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 6px;
	}

	.brush-mode-toggle button,
	.brush-mode-state {
		min-height: 40px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 62%, transparent);
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
		font-weight: 820;
	}

	.brush-mode-toggle button.active {
		border-color: color-mix(in srgb, var(--color-ws-green, #34D399) 36%, transparent);
		background: color-mix(in srgb, var(--color-ws-green, #34D399) 16%, transparent);
		color: color-mix(in srgb, var(--color-ws-green, #34D399) 34%, var(--color-ws-ink, #ECECF2));
	}

	.brush-mode-state {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 8px;
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 22%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 8%, var(--color-ws-surface, #15151D));
		color: var(--color-ws-amber, #FBBF24);
		text-align: center;
	}

	.brush-restore-pending {
		padding: 7px 8px;
		border: 1px dashed color-mix(in srgb, var(--color-ws-amber, #FBBF24) 22%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 6%, transparent);
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 700;
		line-height: 1.35;
	}

	.brush-preset-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}

	.brush-preset-btn {
		display: flex;
		min-width: 0;
		min-height: 42px;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 2px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 22%, transparent);
		border-radius: var(--radius-ws-ctrl, 10px);
		padding: 6px 7px;
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 62%, transparent);
		color: var(--color-ws-ink, #ECECF2);
		text-align: left;
	}

	.brush-preset-btn:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 11%, transparent);
	}

	.brush-preset-btn strong {
		font-size: 11px;
		font-weight: 820;
		line-height: 1.1;
	}

	.brush-preset-btn span {
		overflow: hidden;
		max-width: 100%;
		color: var(--color-ws-text, #9A9AA8);
		font-size: 9px;
		font-weight: 700;
		line-height: 1.15;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.panel-toggle {
		min-width: 42px;
		min-height: 40px;
	}

	.panel-input {
		height: 40px !important;
		min-height: 40px !important;
	}

	@media (min-width: 861px) and (max-width: 1040px) {
		.ai-focus-action,
		.panel-select,
		.panel-input {
			min-height: 40px;
		}

		.panel-toggle {
			min-width: 42px;
			min-height: 40px;
		}
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.8; }
	}
</style>
