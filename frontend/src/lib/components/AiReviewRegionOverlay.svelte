<script lang="ts">
	import { _ } from "$lib/i18n";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import {
		focusAppliedAiResultLayer,
		openAiReviewMarkerTarget,
	} from "$lib/navigation/ai-review-navigation.js";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import {
		getCanvasWorkspaceSize,
		imageRegionToWorkspaceBox,
		resultRegionPreviewStyle,
		type WorkspaceRegionBox,
	} from "$lib/editor/overlay-geometry.js";
	import {
		buildCanvasOverlayLabelPlacements,
		formatCanvasOverlayLabelStyle,
		type CanvasOverlayLabelPlacement,
	} from "$lib/editor/overlay-label-placement.js";
	import { getCanvasOverlayZIndex, isCanvasOverlayInteractive } from "$lib/editor/overlay-priority.js";
	import {
		aiReviewMarkerPageReferenceLabel,
		aiReviewMarkerReferenceLabel,
		aiReviewRegionDisplayLabel,
		aiReviewStatusLabel,
		aiReviewTierLabel,
		findAiResultMarkerForLayer,
		hasAiResultLayer,
		isAiResultPlacementNeeded,
	} from "$lib/project/ai-review-marker-intent.js";
	import {
		buildAiRegionHistories,
		findAiRegionHistoryForMarker,
		findAiRegionVersion,
		type AiRegionHistory,
	} from "$lib/project/ai-review-region-history.js";
	import type { AiReviewMarker, AiReviewMarkerStatus } from "$lib/types.js";

	interface Props {
		visible?: boolean;
		actionDockVisible?: boolean;
	}

	let { visible = true, actionDockVisible = true }: Props = $props();

	// Natural pixel sizes of loaded AI result images, keyed by resultImageId, so
	// we can frame just the marker's crop region out of the (full-page) result.
	let resultNaturalSizes = $state<Record<string, { width: number; height: number }>>({});

	const attentionStatuses = new Set<AiReviewMarkerStatus>([
		"failed",
		"needs_review",
		"retry_requested",
	]);
	const MAX_UNSELECTED_REGION_MARKERS = 4;
	const markerStatusPriority: Record<AiReviewMarkerStatus, number> = {
		failed: 0,
		retry_requested: 1,
		needs_review: 2,
		processing: 3,
		rejected: 4,
		accepted: 5,
		applied: 6,
	};

	type AiReviewRegionLayout = {
		box: WorkspaceRegionBox;
		labelText: string;
		labelPlacement: CanvasOverlayLabelPlacement;
		marker: AiReviewMarker;
		selected: boolean;
		compactLabel: boolean;
	};

	let selectedAiLayerMarker = $derived(findAiResultMarkerForLayer(projectStore.currentPageAiReviewMarkers, editorStore.selectedImageLayer?.id));
	let primarySelectedMarkerId = $derived(selectedAiLayerMarker?.id ?? projectStore.selectedAiReviewMarkerId);
	// Per-region generation histories for this page so the anchored dock can let
	// the reviewer cycle older/newer AI results for the SAME crop region.
	let regionHistories = $derived(buildAiRegionHistories(projectStore.currentPageAiReviewMarkers));
	let markers = $derived(pickVisibleMarkers(projectStore.currentPageAiReviewMarkers));
	let regionLayouts = $derived(buildRegionLayouts(markers));
	let hasSelectedMarker = $derived(regionLayouts.some((item) => item.selected));
	let acceptedUnplacedSelected = $derived(regionLayouts.some((item) => item.selected && isAcceptedUnplaced(item.marker)));
	let aiPanelOwnsResults = $derived(editorUiStore.rightPanelMode === "ai" && projectStore.currentPageAiReviewMarkers.length > 0);
	let shouldMuteSelectionChrome = $derived(acceptedUnplacedSelected || aiPanelOwnsResults);
	let compactInspectorContext = $derived(editorUiStore.inspectorOpen && editorUiStore.rightPanelMode !== "ai");

	$effect(() => {
		editorStore.editor?.setSelectionChromeMuted?.(shouldMuteSelectionChrome);
		return () => {
			editorStore.editor?.setSelectionChromeMuted?.(false);
		};
	});

	function markerTime(marker: AiReviewMarker): number {
		// Use the SAME ordering key as buildAiRegionHistories (createdAt || updatedAt):
		// version order is generation/creation order, so the stepper and this overlay's
		// recency tiebreak must agree, or "‹ รุ่นก่อน" can step to the wrong version.
		return Date.parse(marker.createdAt || marker.updatedAt || "") || 0;
	}

	function compareMarkerPriority(a: AiReviewMarker, b: AiReviewMarker): number {
		const priorityDelta = markerStatusPriority[a.status] - markerStatusPriority[b.status];
		if (priorityDelta !== 0) return priorityDelta;
		return markerTime(b) - markerTime(a);
	}

	function pickVisibleMarkers(sourceMarkers: AiReviewMarker[]): AiReviewMarker[] {
		const selected = sourceMarkers.find(isSelectedMarker);
		const unselected = sourceMarkers
			.filter((marker) => attentionStatuses.has(marker.status) || isAcceptedUnplaced(marker))
			.filter((marker) => marker.id !== selected?.id)
			.sort(compareMarkerPriority)
			.slice(0, MAX_UNSELECTED_REGION_MARKERS);
		if (selected) return [selected, ...unselected];
		return unselected;
	}

	function isSelectedMarker(marker: AiReviewMarker): boolean {
		return marker.id === primarySelectedMarkerId;
	}

	function markerLabel(marker: AiReviewMarker): string {
		return $_(`aiReviewMarker.status.${aiReviewStatusLabel(marker)}`);
	}

	function markerDisplayLabel(marker: AiReviewMarker, selected: boolean): string {
		const display = aiReviewRegionDisplayLabel(projectStore.project, marker, selected);
		return display.kind === "status"
			? $_(`aiReviewMarker.status.${display.code}`)
			: $_(`aiReviewMarker.regionDisplay.${display.code}`);
	}

	function markerReference(marker: AiReviewMarker): string {
		return aiReviewMarkerReferenceLabel(projectStore.aiReviewMarkers, marker);
	}

	function markerPageReference(marker: AiReviewMarker): string {
		return aiReviewMarkerPageReferenceLabel(projectStore.aiReviewMarkers, marker);
	}

	function markerAccessibleLabel(marker: AiReviewMarker): string {
		return $_("aiReviewMarker.overlay.openRegionAria", {
			values: { status: markerLabel(marker), x: Math.round(marker.region.x), y: Math.round(marker.region.y) },
		});
	}

	function markerBox(marker: AiReviewMarker): WorkspaceRegionBox | null {
		editorStore.viewportVersion;
		return imageRegionToWorkspaceBox(editorStore.editor, marker.region);
	}

	function buildRegionLayouts(sourceMarkers: AiReviewMarker[]): AiReviewRegionLayout[] {
		editorStore.viewportVersion;
		const pendingLayouts = sourceMarkers.flatMap((marker) => {
			const box = markerBox(marker);
			if (!box) return [];
			const selected = isSelectedMarker(marker);
			const compactLabel = compactInspectorContext && !selected && marker.status === "needs_review";
			return [{
				box,
				labelText: compactLabel ? markerReference(marker) : markerDisplayLabel(marker, selected),
				marker,
				selected,
				compactLabel,
			}];
		});
		const workspaceSize = getCanvasWorkspaceSize(editorStore.editor);
		const placements = buildCanvasOverlayLabelPlacements(
			pendingLayouts.map((item) => ({
				id: item.marker.id,
				box: item.box,
				label: item.labelText,
				laneIndex: 2,
				preferredAlign: "left",
				selected: item.selected,
				preferredSide: "above",
			})),
			{
				defaultWidth: 54,
				minWidth: 34,
				maxWidth: 110,
				height: 20,
				viewportWidth: workspaceSize?.width,
				viewportHeight: workspaceSize?.height,
			},
		);

		return pendingLayouts.map((item) => ({
			...item,
			labelPlacement: placements[item.marker.id],
		}));
	}

	function regionStyle(item: AiReviewRegionLayout): string {
		return [
			`left:${item.box.left}px`,
			`top:${item.box.top}px`,
			`width:${item.box.width}px`,
			`height:${item.box.height}px`,
			`z-index:${getCanvasOverlayZIndex("ai-review", { selected: item.selected })}`,
			formatCanvasOverlayLabelStyle(item.labelPlacement),
		].join(";");
	}

	function actionDockStyle(item: AiReviewRegionLayout): string {
		const workspaceSize = getCanvasWorkspaceSize(editorStore.editor);
		const baseHeight = 76;
		const fullWidth = isAcceptedUnplaced(item.marker) ? 230 : 304;
		const compactWidth = 166;
		const dockHeight = baseHeight;
		const gap = 8;
		const railReserve = projectStore.currentPageAiReviewMarkers.length > 1 ? 248 : 0;
		const viewportWidth = workspaceSize?.width ?? item.box.left + item.box.width + fullWidth + gap;
		const viewportHeight = workspaceSize?.height ?? item.box.top + dockHeight;
		const rightSide = item.box.left + item.box.width + gap;
		const leftSide = item.box.left - fullWidth - gap;
		const rightLimit = Math.max(8, viewportWidth - railReserve - 8);
		const canUseFullRight = rightSide + fullWidth <= rightLimit;
		const canUseFullLeft = leftSide >= 8;
		const finalWidth = canUseFullRight || canUseFullLeft ? fullWidth : compactWidth;
		const finalHeight = finalWidth === compactWidth ? 89 : dockHeight;
		const finalLeftSide = item.box.left - finalWidth - gap;
		const left = rightSide + finalWidth <= rightLimit
			? rightSide
			: Math.max(8, finalLeftSide);
		const top = Math.min(
			Math.max(8, item.box.top + (item.box.height / 2) - (finalHeight / 2)),
			Math.max(8, viewportHeight - finalHeight),
		);
		return [
			`left:${Math.round(left)}px`,
			`top:${Math.round(top)}px`,
			`width:${finalWidth}px`,
			`--dock-columns:${finalWidth === compactWidth ? 2 : 4}`,
			`z-index:${getCanvasOverlayZIndex("ai-review", { selected: true }) + 1}`,
		].join(";");
	}

	// Pin the version stepper just BELOW the region's bottom edge (or above when
	// there is no room below), centred on the region, so it stays glued to the
	// crop the versions belong to as the viewport scrolls.
	function versionRailStyle(item: AiReviewRegionLayout): string {
		const workspaceSize = getCanvasWorkspaceSize(editorStore.editor);
		const railWidth = 128;
		const railHeight = 26;
		const gap = 6;
		const viewportWidth = workspaceSize?.width ?? item.box.left + item.box.width + railWidth;
		const viewportHeight = workspaceSize?.height ?? item.box.top + item.box.height + railHeight + gap;
		const centeredLeft = item.box.left + (item.box.width / 2) - (railWidth / 2);
		const left = Math.min(Math.max(8, centeredLeft), Math.max(8, viewportWidth - railWidth - 8));
		const below = item.box.top + item.box.height + gap;
		const above = item.box.top - railHeight - gap;
		const top = below + railHeight <= viewportHeight ? below : Math.max(8, above);
		return [
			`left:${Math.round(left)}px`,
			`top:${Math.round(top)}px`,
			`width:${railWidth}px`,
			`z-index:${getCanvasOverlayZIndex("ai-review", { selected: true }) + 2}`,
		].join(";");
	}

	function openMarker(marker: AiReviewMarker): void {
		openAiReviewMarkerTarget(marker, { focusRegion: true });
	}

	function markerHistory(marker: AiReviewMarker): AiRegionHistory | null {
		return findAiRegionHistoryForMarker(regionHistories, marker.id);
	}

	function markerVersionNumber(marker: AiReviewMarker): number {
		return findAiRegionVersion(markerHistory(marker), marker.id)?.version ?? 1;
	}

	function markerVersionCount(marker: AiReviewMarker): number {
		return markerHistory(marker)?.versions.length ?? 1;
	}

	function hasVersionHistory(marker: AiReviewMarker): boolean {
		return markerVersionCount(marker) > 1;
	}

	/**
	 * Switch the anchored region to an adjacent generation (older/newer). Selects
	 * the sibling marker and focuses its region so the result + controls stay
	 * anchored to the same crop on the canvas.
	 */
	function stepVersion(marker: AiReviewMarker, delta: number): void {
		const history = markerHistory(marker);
		if (!history) return;
		const current = findAiRegionVersion(history, marker.id);
		if (!current) return;
		const targetIndex = current.version - 1 + delta;
		const target = history.versions[targetIndex]?.marker;
		if (!target || target.id === marker.id) return;
		projectStore.selectAiReviewMarker(target.id);
		openAiReviewMarkerTarget(target, { focusRegion: true });
	}

	function hasAppliedResultLayer(marker: AiReviewMarker): boolean {
		return hasAiResultLayer(projectStore.project, marker);
	}

	// Show the AI result IN the crop region as soon as it is ready, so the
	// reviewer sees the edit in place before accepting. Skipped once the result
	// is applied as a real editable layer (the canvas already paints it then) and
	// for markers that have no result image yet.
	function shouldShowResultPreview(marker: AiReviewMarker): boolean {
		if (!marker.resultImageId) return false;
		if (marker.status === "rejected") return false;
		if (marker.status === "applied" && hasAppliedResultLayer(marker)) return false;
		return true;
	}

	// Params for signedAssetSrc: a browser <img> cannot send the Authorization
	// header, so owned-project assets need a short-lived signed assetToken. Reuse
	// the same "editor_preview" purpose the canvas loads page images with.
	function resultPreviewParams(marker: AiReviewMarker): SignedAssetSrcParams | null {
		const projectId = projectStore.project?.projectId;
		const imageId = marker.resultImageId;
		if (!projectId || !imageId) return null;
		return {
			projectId,
			imageId,
			url: projectStore.getImageUrl(imageId),
			purpose: "editor_preview",
		};
	}

	function resultPreviewStyle(item: AiReviewRegionLayout): string {
		const marker = item.marker;
		if (!marker.resultImageId) return "";
		const natural = resultNaturalSizes[marker.resultImageId];
		if (!natural) return "";
		return resultRegionPreviewStyle(
			{ width: item.box.width, height: item.box.height },
			marker.region,
			natural,
		);
	}

	function onResultImageLoad(marker: AiReviewMarker, event: Event): void {
		const img = event.currentTarget as HTMLImageElement;
		const id = marker.resultImageId;
		if (!id) return;
		const width = img.naturalWidth || 0;
		const height = img.naturalHeight || 0;
		if (width <= 0 || height <= 0) return;
		if (resultNaturalSizes[id]?.width === width && resultNaturalSizes[id]?.height === height) return;
		resultNaturalSizes = { ...resultNaturalSizes, [id]: { width, height } };
	}

	function isAcceptedUnplaced(marker: AiReviewMarker): boolean {
		return isAiResultPlacementNeeded(projectStore.project, marker);
	}

	function isAppliedResultLayerFocused(marker: AiReviewMarker): boolean {
		return marker.status === "applied"
			&& hasAppliedResultLayer(marker)
			&& editorStore.selectedImageLayer?.id === `ai-result-${marker.id}`;
	}

	async function updateMarker(marker: AiReviewMarker, status: AiReviewMarkerStatus): Promise<void> {
		projectStore.selectAiReviewMarker(marker.id);
		if (status === "applied") {
			const layer = await projectStore.placeAiReviewMarkerResultAsImageLayer(marker.id, editorStore.editor);
			if (layer) {
				editorUiStore.focusImageInspector(layer.id);
			}
			return;
		}
		await projectStore.updateAiReviewMarkerStatus(marker.id, status);
	}

</script>

{#if visible && markers.length}
	<div
		class="ai-region-overlay"
		class:inactive={!isCanvasOverlayInteractive(editorStore.currentTool)}
		class:has-selection={hasSelectedMarker}
		style={`z-index:${getCanvasOverlayZIndex("ai-review", { selected: hasSelectedMarker })};`}
		aria-label={$_("aiReviewMarker.overlay.regionsAria")}
	>
		{#each regionLayouts as item (item.marker.id)}
			<button
				type="button"
				class={`ai-region-box ${item.marker.status}`}
				class:selected={item.selected}
				class:placement={isAcceptedUnplaced(item.marker)}
				class:layer-focused={isAppliedResultLayerFocused(item.marker)}
				style={regionStyle(item)}
				onclick={() => openMarker(item.marker)}
				title={`${markerPageReference(item.marker)} - ${markerLabel(item.marker)}`}
				aria-label={markerAccessibleLabel(item.marker)}
			>
				{#if shouldShowResultPreview(item.marker)}
					<!-- AI result framed to THIS crop region (the stored result is a
					     full-page composite; we scale+offset so only the region shows,
					     clipped by the box's overflow:hidden) so the edit is visible in
					     place before accept. -->
					<img
						class="region-result"
						use:signedAssetSrc={resultPreviewParams(item.marker)}
						alt={$_("aiReviewMarker.overlay.resultAlt", { values: { reference: markerReference(item.marker) } })}
						style={resultPreviewStyle(item)}
						draggable="false"
						data-testid={`ai-region-result-${item.marker.id}`}
						onload={(event) => onResultImageLoad(item.marker, event)}
					/>
				{/if}
				<span class="region-label" class:compact={item.compactLabel}>
					{#if item.compactLabel}
						<span>{item.labelText}</span>
					{:else}
						<span class="region-ref">{markerReference(item.marker)}</span>
						<span>{item.labelText}</span>
					{/if}
				</span>
			</button>
			{#if actionDockVisible && item.selected && hasVersionHistory(item.marker)}
				<!-- Anchored version stepper: cycle older/newer AI generations of the
				     SAME region, pinned beside the crop so the reviewer always sees
				     which area each version edits. Shown even when the AI panel owns
				     the results list, because the anchoring is the point. -->
				<div
					class="ai-region-versions"
					style={versionRailStyle(item)}
					aria-label={$_("aiReviewMarker.overlay.versionHistoryAria", { values: { count: markerVersionCount(item.marker) } })}
				>
					<button
						type="button"
						class="ai-region-version-step"
						disabled={markerVersionNumber(item.marker) <= 1}
						aria-label={$_("aiReviewMarker.overlay.versionPrevAria")}
						title={$_("aiReviewMarker.overlay.versionPrevTitle")}
						onclick={() => stepVersion(item.marker, -1)}
					>‹</button>
					<span class="ai-region-version-count" aria-live="polite">
						{$_("aiReviewMarker.overlay.versionCount", { values: { current: markerVersionNumber(item.marker), total: markerVersionCount(item.marker) } })}
					</span>
					<button
						type="button"
						class="ai-region-version-step"
						disabled={markerVersionNumber(item.marker) >= markerVersionCount(item.marker)}
						aria-label={$_("aiReviewMarker.overlay.versionNextAria")}
						title={$_("aiReviewMarker.overlay.versionNextTitle")}
						onclick={() => stepVersion(item.marker, 1)}
					>›</button>
				</div>
			{/if}
			{#if actionDockVisible && item.selected && !aiPanelOwnsResults && !isAppliedResultLayerFocused(item.marker) && !isAcceptedUnplaced(item.marker)}
				<div
					class="ai-region-actions"
					style={actionDockStyle(item)}
					aria-label={$_("aiReviewMarker.overlay.actionsAria", { values: { status: markerLabel(item.marker) } })}
				>
					<div class="ai-region-action-title">
						<strong>{markerPageReference(item.marker)} · {aiReviewTierLabel(item.marker)}</strong>
						<small>{markerLabel(item.marker)}{hasVersionHistory(item.marker) ? ` · ${$_("aiReviewMarker.overlay.versionInline", { values: { current: markerVersionNumber(item.marker), total: markerVersionCount(item.marker) } })}` : ""}</small>
					</div>
					{#if hasVersionHistory(item.marker)}
						<div class="ai-region-version-inline" aria-label={$_("aiReviewMarker.overlay.switchVersionAria")}>
							<button
								type="button"
								disabled={markerVersionNumber(item.marker) <= 1}
								aria-label={$_("aiReviewMarker.overlay.versionPrevAria")}
								onclick={() => stepVersion(item.marker, -1)}
							>{$_("aiReviewMarker.overlay.versionPrevInline")}</button>
							<button
								type="button"
								disabled={markerVersionNumber(item.marker) >= markerVersionCount(item.marker)}
								aria-label={$_("aiReviewMarker.overlay.versionNextAria")}
								onclick={() => stepVersion(item.marker, 1)}
							>{$_("aiReviewMarker.overlay.versionNextInline")}</button>
						</div>
					{/if}
					{#if item.marker.status === "applied"}
						<button type="button" onclick={() => openMarker(item.marker)}>{$_("aiReviewMarker.overlay.openThisResult")}</button>
						<button
							type="button"
							onclick={() => {
								if (!focusAppliedAiResultLayer(item.marker)) void updateMarker(item.marker, "applied");
							}}
						>
							{hasAppliedResultLayer(item.marker) ? $_("aiReviewMarker.railAction.open_layer") : $_("aiReviewMarker.railAction.recover_layer")}
						</button>
					{:else}
						<button type="button" onclick={() => openMarker(item.marker)}>{$_("aiReviewMarker.overlay.openThisResult")}</button>
						{#if item.marker.status === "failed" || item.marker.status === "retry_requested"}
							<button type="button" onclick={() => void updateMarker(item.marker, "retry_requested")}>{$_("aiReviewMarker.overlay.requestRerun")}</button>
						{/if}
					{/if}
				</div>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.ai-region-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}

	.ai-region-box {
		position: absolute;
		z-index: 10;
		min-width: 40px;
		min-height: 40px;
		padding: 0;
		overflow: hidden;
		border: 1px solid rgba(255, 210, 122, 0.58);
		border-radius: 4px;
		background: rgba(255, 210, 122, 0.035);
		color: #ffffff;
		cursor: pointer;
		pointer-events: auto;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.24);
		transition:
			background 120ms ease,
			border-color 120ms ease,
			box-shadow 120ms ease,
			opacity 120ms ease;
	}

	.ai-region-overlay.inactive .ai-region-box {
		pointer-events: none;
	}

	.region-result {
		position: absolute;
		display: block;
		pointer-events: none;
		/* Sits under the label/chrome but fills the region box. The inline style
		   sizes+offsets the full-page result so only the crop region shows. */
		z-index: 0;
	}

	.ai-region-overlay.has-selection .ai-region-box:not(.selected) {
		opacity: 0.48;
	}

	.ai-region-box:hover,
	.ai-region-box.selected {
		border-width: 2px;
		border-color: rgba(80, 190, 255, 0.98);
		background: rgba(0, 120, 212, 0.16);
		box-shadow:
			0 0 0 2px rgba(255, 255, 255, 0.34),
			0 0 0 6px rgba(0, 120, 212, 0.24),
			0 12px 28px rgba(0, 0, 0, 0.32);
	}

	.ai-region-box.selected {
		pointer-events: none;
	}

	.ai-region-box.selected::before {
		position: absolute;
		inset: -5px;
		border: 1px solid rgba(255, 255, 255, 0.72);
		border-radius: 7px;
		content: "";
		pointer-events: none;
	}

	.ai-region-box.layer-focused {
		border-width: 2px;
		border-color: rgba(110, 231, 211, 0.86);
		background: rgba(13, 148, 136, 0.13);
		box-shadow:
			0 0 0 2px rgba(255, 255, 255, 0.22),
			0 0 0 6px rgba(13, 148, 136, 0.2),
			0 12px 28px rgba(0, 0, 0, 0.28);
		opacity: 1;
		pointer-events: auto;
	}

	.ai-region-box.layer-focused::before {
		border-color: rgba(110, 231, 211, 0.54);
	}

	.ai-region-actions {
		position: absolute;
		display: grid;
		grid-template-columns: repeat(var(--dock-columns, 4), minmax(0, 1fr));
		gap: 5px;
		padding: 6px;
		border: 1px solid rgba(139, 211, 255, 0.44);
		border-radius: 7px;
		background: rgba(10, 15, 24, 0.92);
		box-shadow: 0 16px 36px rgba(0, 0, 0, 0.36);
		pointer-events: auto;
	}

	.ai-region-action-title {
		grid-column: 1 / -1;
		display: grid;
		gap: 2px;
		min-width: 0;
		color: var(--editor-text);
	}

	.ai-region-action-title strong,
	.ai-region-action-title small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ai-region-action-title strong {
		font-size: 10.5px;
		font-weight: 860;
		line-height: 1.1;
	}

	.ai-region-action-title small {
		color: var(--editor-text-dim);
		font-size: 9.5px;
		font-weight: 760;
		line-height: 1.1;
	}

	.ai-region-actions button {
		min-width: 0;
		min-height: 40px;
		padding: 0 6px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 5px;
		background: rgba(255, 255, 255, 0.06);
		color: #ffffff;
		font-size: 11px;
		font-weight: 800;
		cursor: pointer;
	}

	.ai-region-actions button:first-child {
		border-color: rgba(110, 231, 211, 0.42);
		background: rgba(110, 231, 211, 0.16);
		color: #cffff6;
	}

	.ai-region-versions {
		position: absolute;
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		padding: 3px 4px;
		border: 1px solid rgba(139, 211, 255, 0.5);
		border-radius: 999px;
		background: rgba(10, 15, 24, 0.94);
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.4);
		pointer-events: auto;
	}

	.ai-region-version-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 20px;
		padding: 0;
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		color: #ffffff;
		font-size: 14px;
		font-weight: 900;
		line-height: 1;
		cursor: pointer;
	}

	.ai-region-version-step:hover:not(:disabled) {
		border-color: rgba(110, 231, 211, 0.6);
		background: rgba(110, 231, 211, 0.2);
	}

	.ai-region-version-step:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}

	.ai-region-version-count {
		min-width: 56px;
		color: #cffff6;
		font-size: 10px;
		font-weight: 850;
		line-height: 1;
		text-align: center;
		white-space: nowrap;
	}

	.ai-region-version-inline {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 5px;
	}

	.ai-region-version-inline button {
		min-height: 32px;
		border-color: rgba(139, 211, 255, 0.42);
		background: rgba(139, 211, 255, 0.12);
		color: #d6ecff;
		font-size: 10.5px;
		font-weight: 820;
	}

	.ai-region-version-inline button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ai-region-box.failed,
	.ai-region-box.rejected {
		border-color: rgba(255, 139, 124, 0.74);
		background: rgba(255, 139, 124, 0.055);
	}

	.ai-region-box.retry_requested {
		border-style: dashed;
	}

	.ai-region-box.placement {
		border-color: rgba(255, 211, 106, 0.7);
		background: rgba(255, 211, 106, 0.03);
		box-shadow: 0 0 0 1px rgba(255, 211, 106, 0.08);
	}

	.ai-region-box.placement.selected {
		border-color: rgba(255, 211, 106, 0.9);
		background: rgba(255, 211, 106, 0.07);
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.16),
			0 0 0 4px rgba(255, 211, 106, 0.14),
			0 12px 28px rgba(0, 0, 0, 0.26);
	}

	.ai-region-box.placement.selected::before {
		border-color: rgba(255, 211, 106, 0.34);
	}

	.region-label {
		position: absolute;
		left: var(--overlay-label-left);
		top: var(--overlay-label-top);
		width: var(--overlay-label-width);
		height: var(--overlay-label-height);
		overflow: hidden;
		padding: 3px 5px;
		border-radius: 4px;
		background: rgba(25, 27, 30, 0.78);
		font-size: 9px;
		font-weight: 800;
		line-height: 1;
		text-overflow: ellipsis;
		white-space: nowrap;
		box-shadow: 0 5px 12px rgba(0, 0, 0, 0.2);
		opacity: 0.86;
	}

	.region-label,
	.region-ref {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.region-ref {
		color: #cffff6;
	}

	.region-label.compact {
		justify-content: center;
		padding-inline: 4px;
		background: rgba(25, 27, 30, 0.66);
		font-size: 8.5px;
	}

	.ai-region-box:hover .region-label,
	.ai-region-box.selected .region-label,
	.ai-region-box.failed .region-label,
	.ai-region-box.retry_requested .region-label {
		background: rgba(25, 27, 30, 0.94);
		opacity: 1;
	}
</style>
