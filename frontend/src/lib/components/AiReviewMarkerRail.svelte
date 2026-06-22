<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { openAiReviewMarkerTarget } from "$lib/navigation/ai-review-navigation.js";
	import {
		aiReviewMarkerPageReferenceLabel,
		aiReviewMarkerReferenceLabel,
		aiReviewRailActionLabel,
		aiReviewResultStateLabel,
		aiReviewStatusLabel,
		aiReviewTierLabel,
		findAiResultMarkerForLayer,
		hasAiResultLayer,
		isAiResultPlacementNeeded,
	} from "$lib/project/ai-review-marker-intent.js";
	import type { AiReviewMarker, AiReviewMarkerStatus } from "$lib/types.js";

	const railStatuses = new Set<AiReviewMarkerStatus>([
		"processing",
		"failed",
		"needs_review",
		"retry_requested",
	]);

	let selectedAiLayerMarker = $derived(findAiResultMarkerForLayer(projectStore.currentPageAiReviewMarkers, editorStore.selectedImageLayer?.id));
	let primarySelectedMarkerId = $derived(selectedAiLayerMarker?.id ?? projectStore.selectedAiReviewMarkerId);
	let markers = $derived(
		projectStore.currentPageAiReviewMarkers
			.filter((marker) =>
				railStatuses.has(marker.status)
				|| isAcceptedUnplaced(marker)
				|| isSelectedMarker(marker)
			)
			.sort((a, b) => Number(isSelectedMarker(b)) - Number(isSelectedMarker(a)))
	);
	let compactRail = $state(false);
	let showAllMarkers = $state(false);
	let inspectionRail = $derived(Boolean(editorStore.selectedImageLayer?.id?.startsWith("ai-result-")));
	let aiPanelResultMode = $derived(editorUiStore.rightPanelMode === "ai" && projectStore.currentPageAiReviewMarkers.length > 0);
	let inspectorRail = $derived(
		editorUiStore.workspaceView === "editor"
		&& editorUiStore.inspectorOpen
		&& !aiPanelResultMode
	);
	let railIsCompact = $derived(compactRail || inspectionRail || aiPanelResultMode || inspectorRail);
	let visibleMarkers = $derived(showAllMarkers ? markers : markers.slice(0, 6));
	let hiddenMarkerCount = $derived(Math.max(0, markers.length - visibleMarkers.length));
	let hasCollapsedMarkers = $derived(markers.length > 6);

	type GroupedSection = {
		status: string;
		label: string;
		color: string;
		items: AiReviewMarker[];
	};

	let groupedSections = $derived.by<GroupedSection[]>(() => {
		const needsReview: AiReviewMarker[] = [];
		const placement: AiReviewMarker[] = [];
		const applied: AiReviewMarker[] = [];
		const failed: AiReviewMarker[] = [];
		const running: AiReviewMarker[] = [];

		for (const marker of visibleMarkers) {
			if (isAcceptedUnplaced(marker)) {
				placement.push(marker);
			} else if (marker.status === "applied") {
				applied.push(marker);
			} else if (marker.status === "failed" || marker.status === "rejected") {
				failed.push(marker);
			} else if (marker.status === "processing" || marker.status === "retry_requested") {
				running.push(marker);
			} else if (marker.status === "needs_review" || marker.status === "accepted") {
				needsReview.push(marker);
			} else {
				needsReview.push(marker);
			}
		}

		return [
			{ status: "needs_review", label: $_("aiReviewMarker.rail.groupNeedsReview"), color: "var(--color-ws-amber)", items: needsReview },
			{ status: "placement", label: $_("aiReviewMarker.rail.groupPlacement"), color: "var(--color-ws-green)", items: placement },
			{ status: "applied", label: $_("aiReviewMarker.rail.groupApplied"), color: "var(--color-ws-blue)", items: applied },
			{ status: "running", label: $_("aiReviewMarker.rail.groupRunning"), color: "var(--color-ws-violet)", items: running },
			{ status: "failed", label: $_("aiReviewMarker.rail.groupFailed"), color: "var(--color-ws-rose)", items: failed },
		].filter(section => section.items.length > 0);
	});

	onMount(() => {
		if (typeof window.matchMedia !== "function") return;
		const query = window.matchMedia("(max-width: 980px)");
		const updateCompactRail = () => {
			compactRail = query.matches;
		};
		updateCompactRail();
		query.addEventListener("change", updateCompactRail);
		return () => query.removeEventListener("change", updateCompactRail);
	});

	function tierLabel(marker: AiReviewMarker): string {
		return aiReviewTierLabel(marker);
	}

	function hasAppliedResultLayer(marker: AiReviewMarker): boolean {
		return hasAiResultLayer(projectStore.project, marker);
	}

	// For clean tier-badge CSS classes
	function tierClass(tier: string): string {
		return tier;
	}

	function isAcceptedUnplaced(marker: AiReviewMarker): boolean {
		return isAiResultPlacementNeeded(projectStore.project, marker);
	}

	function statusLabel(marker: AiReviewMarker): string {
		return $_(`aiReviewMarker.status.${aiReviewStatusLabel(marker)}`);
	}

	function resultStateLabel(marker: AiReviewMarker): string {
		return $_(`aiReviewMarker.resultState.${aiReviewResultStateLabel(projectStore.project, marker)}`);
	}

	function combinedStateLabel(marker: AiReviewMarker): string {
		const status = statusLabel(marker);
		const result = resultStateLabel(marker);
		return status === result ? status : `${status} ${result}`;
	}

	function actionLabel(marker: AiReviewMarker): string {
		return $_(`aiReviewMarker.railAction.${aiReviewRailActionLabel(projectStore.project, marker)}`);
	}

	function statusInitial(status: AiReviewMarkerStatus): string {
		return $_(`aiReviewMarker.rail.initial.${status}`);
	}

	function markerStatusInitial(marker: AiReviewMarker): string {
		if (isAcceptedUnplaced(marker)) return $_("aiReviewMarker.rail.initialPlacement");
		return statusInitial(marker.status);
	}

	// Redesigned to support OCR / Clean label grouping clean badges
	function markerTitle(marker: AiReviewMarker): string {
		return `P${marker.pageIndex + 1}`;
	}

	function markerReference(marker: AiReviewMarker): string {
		return aiReviewMarkerReferenceLabel(projectStore.aiReviewMarkers, marker);
	}

	function markerPageReference(marker: AiReviewMarker): string {
		return aiReviewMarkerPageReferenceLabel(projectStore.aiReviewMarkers, marker);
	}

	function markerPageShortLabel(marker: AiReviewMarker): string {
		return `P${marker.pageIndex + 1}`;
	}

	function compactStateLine(marker: AiReviewMarker): string {
		if (isAcceptedUnplaced(marker)) return $_("aiReviewMarker.railAction.awaiting_placement");
		if (marker.status === "applied") return hasAppliedResultLayer(marker) ? $_("aiReviewMarker.resultState.placed") : $_("aiReviewMarker.resultState.layer_lost");
		if (marker.status === "failed") return $_("aiReviewMarker.resultState.needs_fix");
		if (marker.status === "processing") return $_("aiReviewMarker.status.processing");
		if (marker.status === "retry_requested") return $_("aiReviewMarker.regionDisplay.retry");
		return statusLabel(marker);
	}

	// Focus marker jumps viewport coordinates cleanly to marker region
	function openMarker(marker: AiReviewMarker): void {
		openAiReviewMarkerTarget(marker, {
			...(aiPanelResultMode ? { defaultPanelMode: null, placementPanelMode: null } : {}),
			focusRegion: true
		});
	}

	function isSelectedMarker(marker: AiReviewMarker): boolean {
		return marker.id === primarySelectedMarkerId;
	}

	function markerDetail(marker: AiReviewMarker): string {
		const { x, y, w, h } = marker.region;
		return $_("aiReviewMarker.rail.regionDetail", {
			values: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
		});
	}

	function markerLabel(marker: AiReviewMarker): string {
		return $_("aiReviewMarker.rail.openResultAria", {
			values: { page: markerTitle(marker), tier: tierLabel(marker), state: combinedStateLabel(marker), region: markerDetail(marker) },
		});
	}

	function markerActionTitle(marker: AiReviewMarker): string {
		const identity = `${markerPageReference(marker)} ${tierLabel(marker)} ${combinedStateLabel(marker)}`;
		if (isAcceptedUnplaced(marker)) return $_("aiReviewMarker.rail.titlePlacement", { values: { identity } });
		if (marker.status === "applied" && marker.resultImageId) {
			return hasAppliedResultLayer(marker)
				? $_("aiReviewMarker.rail.titleSelectLayer", { values: { identity } })
				: $_("aiReviewMarker.rail.titleRecoverLayer", { values: { identity } });
		}
		if (marker.status === "processing" || marker.status === "retry_requested") return $_("aiReviewMarker.rail.titleQueue", { values: { identity } });
		if (marker.status === "failed") return $_("aiReviewMarker.rail.titleFix", { values: { identity } });
		if (marker.resultImageId) return $_("aiReviewMarker.rail.titleReviewResult", { values: { identity } });
		return $_("aiReviewMarker.rail.titleReview", { values: { identity } });
	}
</script>

{#if markers.length}
	<div
		class="ai-marker-rail ws-sans"
		class:compact={railIsCompact}
		class:inspection={inspectionRail}
		class:panel-result-mode={aiPanelResultMode}
		class:inspector-compact={inspectorRail}
		role="region"
		aria-label={aiPanelResultMode ? $_("aiReviewMarker.rail.regionAriaPanel") : $_("aiReviewMarker.rail.regionAria")}
	>
		{#each groupedSections as section (section.status)}
			{#if !railIsCompact}
				<div class="ai-rail-group-header">
					<span class="ai-rail-group-dot" style="background: {section.color}"></span>
					<span class="ai-rail-group-label">{section.label}</span>
					<span class="ai-rail-group-count">{section.items.length}</span>
				</div>
			{/if}
			{#each section.items as marker (marker.id)}
				<button
					class={`ai-marker-card ws-btn-ghost ${marker.status}`}
					class:selected={isSelectedMarker(marker)}
					onclick={() => openMarker(marker)}
					title={markerActionTitle(marker)}
					aria-label={markerLabel(marker)}
				>
					<span class="ai-marker-status-dot" aria-hidden="true">{markerStatusInitial(marker)}</span>
					{#if railIsCompact}
						<span class="ai-marker-compact-copy" aria-hidden="true">
							<strong>
								<span>{markerReference(marker)}</span>
								<em>{markerPageShortLabel(marker)}</em>
							</strong>
							<small>{compactStateLine(marker)}</small>
						</span>
					{:else}
						<span class="ai-marker-card-copy">
							<strong>
								<span>{markerReference(marker)}</span>
								{markerTitle(marker)}
								<span class={`ai-tier-badge ${tierClass(marker.tier)}`}>{tierLabel(marker)}</span>
							</strong>
							<small>{combinedStateLabel(marker)} · {markerDetail(marker)}</small>
						</span>
						<span class="ai-marker-card-action" class:ready={Boolean(marker.resultImageId)}>{actionLabel(marker)}</span>
					{/if}
				</button>
			{/each}
		{/each}
		{#if hasCollapsedMarkers}
			<button
				type="button"
				class="ai-marker-overflow ws-btn-ghost"
				onclick={() => {
					showAllMarkers = !showAllMarkers;
				}}
				title={showAllMarkers ? $_("aiReviewMarker.rail.collapseAria") : $_("aiReviewMarker.rail.showMoreAria", { values: { count: hiddenMarkerCount } })}
				aria-label={showAllMarkers ? $_("aiReviewMarker.rail.collapseAria") : $_("aiReviewMarker.rail.showMoreAria", { values: { count: hiddenMarkerCount } })}
			>
				{#if showAllMarkers}
					{railIsCompact ? $_("aiReviewMarker.rail.collapseShort") : $_("aiReviewMarker.rail.collapseLong")}
				{:else}
					{railIsCompact ? $_("aiReviewMarker.rail.moreShort", { values: { count: hiddenMarkerCount } }) : $_("aiReviewMarker.rail.moreLong", { values: { count: hiddenMarkerCount } })}
				{/if}
			</button>
		{/if}
	</div>
{/if}

<style>
	.ai-rail-group-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
		margin-bottom: 2px;
		padding-inline: 4px;
	}

	.ai-rail-group-dot {
		flex: 0 0 6px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.ai-rail-group-label {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 850;
		text-transform: none;
		letter-spacing: 0.02em;
	}

	.ai-rail-group-count {
		margin-left: auto;
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		border-radius: 999px;
		padding: 1px 4px;
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 800;
	}

	.ai-tier-badge {
		font-size: 8px;
		font-weight: 900;
		padding: 1px 4.5px;
		border-radius: 999px;
		text-transform: uppercase;
		white-space: nowrap;
		margin-left: 5px;
		display: inline-block;
	}
	.ai-tier-badge.budget-clean {
		background: color-mix(in srgb, var(--color-ws-blue) 14%, transparent);
		color: var(--color-ws-blue);
		border: 1px solid color-mix(in srgb, var(--color-ws-blue) 25%, transparent);
	}
	.ai-tier-badge.clean-pro {
		background: color-mix(in srgb, var(--color-ws-green) 14%, transparent);
		color: var(--color-ws-green);
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 25%, transparent);
	}
	.ai-tier-badge.sfx-pro {
		background: color-mix(in srgb, var(--color-ws-violet) 14%, transparent);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-violet) 25%, transparent);
	}

	.ai-marker-rail {
		position: absolute;
		top: 138px;
		right: 12px;
		z-index: 34;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: clamp(174px, 18vw, 224px);
		max-height: calc(100% - 124px);
		overflow-y: auto;
		padding: 1px 3px 1px 1px;
		pointer-events: auto;
	}

	.ai-marker-card,
	.ai-marker-overflow {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface) 84%, transparent);
		color: var(--color-ws-ink);
		font-weight: 850;
		box-shadow: 0 10px 24px -18px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
	}

	.ai-marker-card {
		width: 100%;
		justify-content: flex-start;
		gap: 8px;
		padding: 6px 7px;
		cursor: pointer;
		text-align: left;
	}

	.ai-marker-card:hover,
	.ai-marker-card.selected {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-surface2) 82%, transparent);
	}

	.ai-marker-card.selected {
		border-color: color-mix(in srgb, var(--color-ws-accent) 58%, transparent);
		background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-violet) 68%, var(--color-ws-surface2)), color-mix(in srgb, var(--color-ws-accent) 68%, var(--color-ws-surface2)));
	}

	.ai-marker-rail.panel-result-mode {
		width: clamp(144px, 15vw, 184px);
		opacity: 0.82;
	}

	.ai-marker-rail.inspector-compact {
		width: clamp(112px, 10vw, 136px);
		opacity: 0.88;
	}

	.ai-marker-rail.panel-result-mode:hover,
	.ai-marker-rail.inspector-compact:hover,
	.ai-marker-rail.inspector-compact:focus-within,
	.ai-marker-rail.panel-result-mode:focus-within {
		opacity: 1;
	}

	.ai-marker-rail.panel-result-mode .ai-marker-card,
	.ai-marker-rail.inspector-compact .ai-marker-card,
	.ai-marker-rail.inspector-compact .ai-marker-overflow,
	.ai-marker-rail.panel-result-mode .ai-marker-overflow {
		border-color: color-mix(in srgb, var(--color-ws-green) 20%, transparent);
		background: color-mix(in srgb, var(--color-ws-surface) 62%, transparent);
		box-shadow: 0 10px 24px -20px color-mix(in srgb, var(--color-ws-bg) 88%, transparent);
	}

	.ai-marker-rail.inspection {
		top: auto;
		right: 12px;
		bottom: 92px;
		flex-direction: row;
		max-width: min(280px, calc(100% - 24px));
		max-height: 52px;
		overflow-x: auto;
		overflow-y: hidden;
		padding: 2px;
	}

	.ai-marker-rail.inspection .ai-marker-card,
	.ai-marker-rail.inspection .ai-marker-overflow {
		border-color: color-mix(in srgb, var(--color-ws-green) 24%, transparent);
		background: color-mix(in srgb, var(--color-ws-surface) 60%, transparent);
		box-shadow: 0 10px 24px -18px color-mix(in srgb, var(--color-ws-bg) 88%, transparent);
		opacity: 0.82;
	}

	.ai-marker-rail.inspection .ai-marker-card:hover,
	.ai-marker-rail.inspection .ai-marker-card.selected {
		opacity: 1;
	}

	.ai-marker-status-dot {
		display: inline-flex;
		flex: 0 0 28px;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 64%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		line-height: 1;
	}

	.ai-marker-card-copy {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 2px;
	}

	.ai-marker-card-copy strong {
		display: flex;
		align-items: center;
		gap: 5px;
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 11px;
		line-height: 1.15;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-marker-card-copy strong span {
		flex: 0 0 auto;
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 24%, transparent);
		border-radius: 999px;
		padding: 1px 5px;
		background: color-mix(in srgb, var(--color-ws-green) 10%, transparent);
		color: var(--color-ws-green);
		font-size: 9px;
	}

	.ai-marker-card-copy small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 680;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-marker-card-action {
		flex: 0 0 auto;
		border-radius: 999px;
		padding: 3px 6px;
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
	}

	.ai-marker-compact-copy {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 1px;
		text-align: left;
	}

	.ai-marker-compact-copy strong,
	.ai-marker-compact-copy small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-marker-compact-copy strong {
		display: flex;
		align-items: center;
		gap: 4px;
		justify-content: space-between;
		color: var(--color-ws-ink);
		font-size: 10px;
		line-height: 1.05;
	}

	.ai-marker-compact-copy strong span,
	.ai-marker-compact-copy strong em {
		flex: 0 0 auto;
		border-radius: 999px;
		font-style: normal;
	}

	.ai-marker-compact-copy strong span {
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 24%, transparent);
		padding: 1px 5px;
		background: color-mix(in srgb, var(--color-ws-green) 12%, transparent);
		color: var(--color-ws-green);
	}

	.ai-marker-compact-copy strong em {
		color: color-mix(in srgb, var(--color-ws-ink) 82%, transparent);
		font-size: 9px;
	}

	.ai-marker-compact-copy small {
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 850;
		line-height: 1.1;
	}

	.ai-marker-card-action.ready {
		background: color-mix(in srgb, var(--color-ws-green) 16%, transparent);
		color: var(--color-ws-green);
	}

	.ai-marker-card.needs_review .ai-marker-status-dot,
	.ai-marker-card.retry_requested .ai-marker-status-dot {
		color: var(--color-ws-amber);
	}

	.ai-marker-card.accepted .ai-marker-status-dot,
	.ai-marker-card.applied .ai-marker-status-dot {
		color: var(--color-ws-green);
	}

	.ai-marker-card.accepted .ai-marker-status-dot {
		color: var(--color-ws-amber);
	}

	.ai-marker-card.failed .ai-marker-status-dot,
	.ai-marker-card.rejected .ai-marker-status-dot {
		color: var(--color-ws-rose);
	}

	.ai-marker-overflow {
		justify-content: center;
		min-height: 40px;
		padding: 0 8px;
		color: var(--color-ws-text);
		font-size: 10px;
	}

	@media (max-width: 980px) {
		.ai-marker-rail,
		.ai-marker-rail.compact {
			width: 112px;
			gap: 6px;
		}

		.ai-marker-rail.panel-result-mode,
		.ai-marker-rail.compact.panel-result-mode {
			width: 96px;
			gap: 5px;
		}

		.ai-marker-rail.inspection {
			width: auto;
			gap: 6px;
		}

		.ai-marker-card {
			justify-content: flex-start;
			min-height: 44px;
			gap: 5px;
			padding: 6px 8px;
		}

		.ai-marker-rail.panel-result-mode .ai-marker-card {
			justify-content: center;
			min-height: 40px;
			padding: 5px 6px;
		}

		.ai-marker-status-dot {
			flex-basis: 26px;
			width: 26px;
			height: 26px;
		}

		.ai-marker-rail.panel-result-mode .ai-marker-status-dot {
			flex-basis: 22px;
			width: 22px;
			height: 22px;
			font-size: 9px;
		}

		.ai-marker-rail.panel-result-mode .ai-marker-compact-copy {
			align-items: center;
			flex: 0 0 auto;
			gap: 0;
		}

		.ai-marker-rail.panel-result-mode .ai-marker-compact-copy strong {
			justify-content: center;
		}

		.ai-marker-rail.panel-result-mode .ai-marker-compact-copy strong em,
		.ai-marker-rail.panel-result-mode .ai-marker-compact-copy small {
			display: none;
		}

		.ai-marker-rail.panel-result-mode .ai-marker-compact-copy strong span {
			padding: 1px 4px;
			font-size: 9px;
		}

		.ai-marker-overflow {
			padding: 0;
			font-size: 9px;
		}
	}
</style>
