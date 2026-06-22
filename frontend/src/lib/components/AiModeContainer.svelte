<script lang="ts">
	import * as api from "$lib/api/client.ts";
	import { _ } from "$lib/i18n";
	import { config } from "$lib/config.js";
	import { SUPPORTED_IMAGE_ACCEPT } from "$lib/project/file-order.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import type { AiReviewMarker, AiTier } from "$lib/types.js";
	import { AI_IMAGE_QUALITIES, resolveUsableQuality, type AiImageQuality } from "$lib/project/ai-quality.js";
	import { formatAiCoverSelectionRequired } from "$lib/project/ai-job-copy.js";
	import AiModePanel from "./AiModePanel.svelte";

	interface Labels {
		aiTranslation: string;
		language: string;
		sfx: string;
		generate: string;
		customPrompt: string;
		customPromptPlaceholder: string;
	}

	interface Props {
		labels: Labels;
	}

	let { labels }: Props = $props();

		// Stable availability codes carried on each tier option. The PRODUCER
		// (this container) emits a code from `capability.reason`/state; the CONSUMER
		// (AiModePanel) localizes it via `$_()` and compares on the code — never on
		// Thai text. `status`/`recovery` reasons can diverge (the OpenRouter
		// detail-fallback shows the OpenRouter status but the generic recovery), so
		// they are tracked independently to preserve the exact original branching.
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
			// Absent on the seeded blurbs (no capability resolved yet); set once
			// /ai/capabilities returns or on the scoped-failure fallback.
			availabilityReason?: AiTierAvailabilityReason;
			recoveryReason?: AiTierRecoveryReason;
		}

	// Localized tier blurbs, rebuilt on locale change. `$derived` (not a frozen
	// `const`) so the `$_()` calls re-run when the active locale switches.
	let defaultAiTierOptions = $derived<AiTierOption[]>([
		{ id: "sfx-pro", name: "SFX Pro", detail: $_("aiMode.tierDetailSfxPro") },
		{ id: "clean-pro", name: "Clean Pro", detail: $_("aiMode.tierDetailCleanPro") },
		{ id: "budget-clean", name: "Budget Clean", detail: $_("aiMode.tierDetailBudgetClean") },
	]);

	let aiTierOptions = $state<AiTierOption[]>([]);
	// Seed the rendered options from the localized defaults until /ai/capabilities
	// resolves, so the panel always has tier blurbs.
	$effect(() => {
		if (aiTierOptions.length === 0) aiTierOptions = defaultAiTierOptions;
	});
	// The capability/seed writes copy `detail` from defaultAiTierOptions at BUILD time,
	// so a live locale switch would otherwise leave the tier blurbs in the previous
	// language. Overlay the freshly localized `detail` (by tier id) at render — a
	// $derived (not a state write) so there is no reseed loop, and capability data
	// (availabilityReason, provider, available) is preserved.
	let aiTierOptionsLocalized = $derived(
		aiTierOptions.map((option) => {
			const localized = defaultAiTierOptions.find((d) => d.id === option.id);
			return localized ? { ...option, detail: localized.detail } : option;
		}),
	);
	// Qualities the current workspace plan permits, from /ai/capabilities. Undefined
	// until a project is scoped / loaded (treated as "all allowed" — backend still
	// enforces). Studio = all three; Free = ["low"].
	let allowedAiQualities = $state<AiImageQuality[] | undefined>(undefined);
	let aiPlanName = $state<string | null>(null);
	let customPrompt = $state("");
	// When the user clicks an AI run with no canvas region selected, generateCover
	// silently no-ops (it only surfaces a transient status-bar message), so the
	// button reads as dead. Track that case here and feed it to the panel as a
	// persistent inline hint. Cleared the moment a valid region run starts (or the
	// tool/selection changes), so the affordance only shows when it's actually true.
	let needsRegionHint = $state(false);
	let capabilityRequestId = 0;

	// Dismiss the "select a region" hint as soon as the context changes — the user
	// switched tools, changed page, or left AI mode — so a stale hint never lingers
	// after they've moved on. Reading these reactive values registers the effect.
	$effect(() => {
		void editorStore.currentTool;
		void projectStore.project?.currentPage;
		void editorUiStore.rightPanelMode;
		needsRegionHint = false;
	});
	let panelBrushMode = $derived(editorStore.brushTarget.canRestore ? editorStore.brushMode : "erase");
	let readyBrushAiMarker = $derived.by(() => {
		const currentPage = projectStore.project?.currentPage ?? -1;
		const markerCandidates = [
			projectStore.selectedAiReviewMarker,
			...projectStore.currentPageAiReviewMarkers,
			...(projectStore.project?.aiReviewMarkers ?? []),
		];
		const isReady = (marker: AiReviewMarker | null | undefined) => (
			Boolean(marker?.resultImageId)
			&& (marker?.status === "needs_review" || marker?.status === "accepted")
			&& marker?.pageIndex === currentPage
		);
		return markerCandidates.find((marker, index) => (
			isReady(marker)
			&& markerCandidates.findIndex((candidate) => candidate?.id === marker?.id) === index
		)) ?? null;
	});
	let readyBrushAiResultLabel = $derived(readyBrushAiMarker?.resultImageId
		? $_("aiMode.readyBrushResultLabel", { values: { page: (readyBrushAiMarker.pageIndex ?? 0) + 1 } })
		: null);

	$effect(() => {
		const projectId = projectStore.project?.projectId;
		const lang = projectStore.activeTargetLang || projectStore.project?.targetLang;
		// Refetch when the selected quality changes too: the tier availability the
		// backend reports is gated on the quality that will be charged, so the panel's
		// "พร้อม"/lock state must track the user's quality pick.
		const quality = aiJobsStore.aiQuality;
		void refreshAiCapabilities(projectId, lang, quality);
	});

	async function refreshAiCapabilities(projectId?: string, lang?: string, quality?: AiImageQuality): Promise<void> {
		const requestId = ++capabilityRequestId;
		try {
			const result = await api.getAiCapabilities({
				projectId,
				lang,
				quality,
			});
			if (requestId !== capabilityRequestId) return;
			const planAllowed = result.plan?.allowedAiQualities;
			allowedAiQualities = planAllowed && planAllowed.length > 0
				? AI_IMAGE_QUALITIES.filter((quality) => planAllowed.includes(quality))
				: undefined;
			aiPlanName = result.plan?.name ?? null;
			// Snap the chosen quality into the plan's allowed set so the panel never
			// shows a locked quality as selected (e.g. switching to a Free workspace).
			const usableQuality = resolveUsableQuality(aiJobsStore.aiQuality, allowedAiQualities);
			if (usableQuality !== aiJobsStore.aiQuality) aiJobsStore.setAiQuality(usableQuality);
			const capabilityById = new Map(result.tiers.map((tier) => [tier.id, tier]));
			aiTierOptions = defaultAiTierOptions.map((option) => {
				const capability = capabilityById.get(option.id);
				if (!capability) return option;
				return {
					...option,
						available: capability.available,
						provider: capability.provider,
						availabilityReason: resolveAvailabilityReason(capability),
						recoveryReason: resolveRecoveryReason(capability),
					};
				});
			const selected = aiTierOptions.find((option) => option.id === aiJobsStore.aiTier);
			if (selected?.available === false) {
				const fallback = aiTierOptions.find((option) => option.available !== false);
				if (fallback) aiJobsStore.setAiTier(fallback.id);
			}
		} catch {
			if (requestId !== capabilityRequestId) return;
			// Capabilities unknown — fall back to "no plan scope" so the panel still
			// lets the user pick a quality (the backend remains the gating authority).
			allowedAiQualities = undefined;
			aiPlanName = null;
			aiTierOptions = unavailableAiTierOptions(
				projectId ? "needs_scope" : "needs_project",
			);
		}
	}

	function unavailableAiTierOptions(reason: "needs_scope" | "needs_project"): AiTierOption[] {
		return defaultAiTierOptions.map((option) => ({
			...option,
			available: false,
			availabilityReason: reason,
			recoveryReason: reason,
		}));
	}

	// Map the backend `capability.reason` (and the OpenRouter detail-fallback) to a
	// STABLE status code. The branching mirrors the original Thai formatter exactly
	// — only the output changed from a Thai sentence to a code the panel localizes.
	function resolveAvailabilityReason(
		capability: { available: boolean; reason?: string | null; detail?: string | null },
	): AiTierAvailabilityReason {
		if (capability.available) return "ready";
		if (capability.reason === "openai_images_not_configured") return "openai_key";
		if (capability.reason === "openrouter_not_configured") return "openrouter_key";
		if (capability.reason === "sfx_provider_unavailable") return "sfx_provider";
		if (capability.reason === "sfx_worker_unreachable") return "worker_unreachable";
		if (capability.reason === "sfx_worker_no_available_accounts") return "worker_no_account";
		if (capability.reason === "provider_disabled") return "provider_disabled";
		if (capability.reason === "adapter_pending") return "adapter_pending";
		const detail = capability.detail?.trim();
		if (detail?.includes("OpenRouter") && detail.includes("API key")) return "openrouter_key";
		return "provider_not_ready";
	}

	// Recovery code is keyed off `capability.reason` independently of the status
	// code: the OpenRouter detail-fallback shows the OpenRouter status but the
	// GENERIC recovery, so the two resolvers must stay separate to preserve that.
	function resolveRecoveryReason(
		capability: { available: boolean; reason?: string | null; detail?: string | null },
	): AiTierRecoveryReason | undefined {
		if (capability.available) return undefined;
		if (capability.reason === "openai_images_not_configured") return "openai_key";
		if (capability.reason === "sfx_worker_unreachable") return "worker_unreachable";
		if (capability.reason === "sfx_worker_no_available_accounts") return "worker_no_account";
		if (capability.reason === "sfx_provider_unavailable") return "sfx_provider";
		if (capability.reason === "openrouter_not_configured") return "openrouter_key";
		if (capability.reason === "provider_disabled") return "provider_disabled";
		if (capability.reason === "adapter_pending") return "adapter_pending";
		return "generic";
	}

	function updateAiTier(value: AiTier): void {
		aiJobsStore.setAiTier(value);
	}

	function updateAiQuality(value: AiImageQuality): void {
		// Guard against picking a locked quality even if the control is clicked
		// programmatically; the backend would reject it anyway.
		const usable = resolveUsableQuality(value, allowedAiQualities);
		aiJobsStore.setAiQuality(usable);
	}

	function updateCustomPrompt(value: string): void {
		customPrompt = value;
	}

	function updateBrushSize(value: number): void {
		editorStore.setBrushSize(value);
	}

	function updateBrushHardness(value: number): void {
		editorStore.setBrushHardness(value);
	}

	function updateBrushOpacity(value: number): void {
		editorStore.setBrushOpacity(value);
	}

	function updateBrushMode(value: "erase" | "restore"): void {
		editorStore.setBrushMode(value);
	}

	function restoreFullAiMask(): void {
		if (!editorStore.brushTarget.canClearMask) return;
		editorStore.editor?.clearEraserMask();
	}

	function addImageLayerForBrush(): void {
		if (!projectStore.project || !editorStore.editor) return;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = SUPPORTED_IMAGE_ACCEPT;
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file || !editorStore.editor) return;
			const layer = await projectStore.addReferenceImageLayer(file, editorStore.editor);
			if (!layer) return;
			editorStore.selectedImageLayer = layer;
			editorStore.selectedLayer = null;
			editorStore.refreshImageLayers();
			editorStore.setTool("brush");
			projectStore.setStatusMsg($_("aiMode.brushReadyForLayer", { values: { name: layer.name || layer.originalName || layer.imageName } }));
		};
		input.click();
	}

	async function useReadyAiResultForBrush(): Promise<void> {
		if (!readyBrushAiMarker || !editorStore.editor) return;
		try {
				const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer(readyBrushAiMarker.id, editorStore.editor, {
					markApplied: false,
					statusMessage: $_("aiMode.placedAiPendingReview"),
				});
			if (!layer) return;
			editorStore.selectedImageLayer = layer;
			editorStore.selectedLayer = null;
			editorStore.refreshImageLayers();
			editorStore.setTool("brush");
			projectStore.setStatusMsg($_("aiMode.brushReadyForAiResult", { values: { page: (readyBrushAiMarker.pageIndex ?? 0) + 1 } }));
		} catch (error: any) {
			projectStore.setStatusMsg($_("aiMode.placeAiResultFailed", { values: { error: error?.message || $_("aiMode.placeAiResultRetryHint") } }));
		}
	}

	async function handleGenerate(): Promise<void> {
		if (aiJobsStore.isGenerating) return;

		// Mirror generateCover's own region guard up front so the panel can show a
		// clear, persistent inline hint instead of the run reading as a dead button.
		// This does NOT change the run logic — generateCover still re-checks and is
		// the single source of truth for whether a job is actually submitted.
		const crop = editorStore.editor?.getCoverCrop?.();
		if (!crop || crop.w < config.minCropSize || crop.h < config.minCropSize) {
			needsRegionHint = true;
			projectStore.setStatusMsg(formatAiCoverSelectionRequired());
			return;
		}
		needsRegionHint = false;

		aiJobsStore.setGenerating(true);

		try {
			await aiJobsStore.generateCover(editorStore.editor, customPrompt || undefined);
			editorStore.setTool("select");
		} catch (error: any) {
			projectStore.setStatusMsg($_("aiMode.aiNotStarted", { values: { error: error.message || $_("aiMode.generateFailed") } }));
		} finally {
			aiJobsStore.setGenerating(false);
		}
	}
</script>

<AiModePanel
	{labels}
	projectOpen={Boolean(projectStore.project)}
	languages={config.languages}
	targetLang={projectStore.activeTargetLang}
	aiTier={aiJobsStore.aiTier}
	aiTierOptions={aiTierOptionsLocalized}
	aiQuality={aiJobsStore.aiQuality}
	allowedAiQualities={allowedAiQualities}
	planName={aiPlanName}
	sfxEnabled={aiJobsStore.sfxToggle}
	isGenerating={aiJobsStore.isGenerating}
	needsRegionHint={needsRegionHint}
	customPrompt={customPrompt}
	currentTool={editorStore.currentTool}
	brushTarget={editorStore.brushTarget}
	brushSize={editorStore.brushSize}
	brushHardness={editorStore.brushHardness}
	brushOpacity={editorStore.brushOpacity}
	brushMode={panelBrushMode}
	brushCommitError={editorStore.brushCommitError}
	readyAiResultLabel={readyBrushAiResultLabel}
	onTargetLangChange={(value) => projectStore.setTargetLang(value)}
	onAiTierChange={updateAiTier}
	onAiQualityChange={updateAiQuality}
	onToggleSfx={() => aiJobsStore.toggleSfx()}
	onGenerate={handleGenerate}
	onCustomPromptChange={updateCustomPrompt}
	onBrushSizeChange={updateBrushSize}
	onBrushHardnessChange={updateBrushHardness}
	onBrushOpacityChange={updateBrushOpacity}
	onBrushModeChange={updateBrushMode}
	onClearBrushMask={restoreFullAiMask}
	onSelectBrush={() => editorStore.setTool("brush")}
	onAddImageLayer={addImageLayerForBrush}
	onUseAiResultLayer={useReadyAiResultForBrush}
	onOpenLayers={() => editorUiStore.startBrushLayerPick()}
/>
