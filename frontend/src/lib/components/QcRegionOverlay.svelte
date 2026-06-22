<script lang="ts">
	import { _ } from "$lib/i18n";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import {
		getCanvasWorkspaceSize,
		imageRegionToWorkspaceBox,
		type WorkspaceRegionBox,
	} from "$lib/editor/overlay-geometry.js";
	import {
		buildCanvasOverlayLabelPlacements,
		formatCanvasOverlayLabelStyle,
		type CanvasOverlayLabelPlacement,
	} from "$lib/editor/overlay-label-placement.js";
	import { getCanvasOverlayZIndex, isCanvasOverlayInteractive } from "$lib/editor/overlay-priority.js";
	import type { QcIssue } from "$lib/project/qc-checks.js";
	import { resolveQcIssueMessage } from "$lib/project/qc-checks-i18n.js";
	import type { ImageLayer, TextLayer } from "$lib/types.js";

	interface Props {
		visible?: boolean;
	}

	type QcRegionItem = {
		key: string;
		layerId: string;
		layerKind: "text" | "image";
		pageIndex: number;
		issues: QcIssue[];
		primaryIssue: QcIssue;
		severity: QcIssue["severity"];
	};

	type QcRegionLayout = QcRegionItem & {
		activeLayer: boolean;
		box: WorkspaceRegionBox;
		labelPlacement: CanvasOverlayLabelPlacement;
		selected: boolean;
	};

	const DENSE_REGION_LABEL_LIMIT = 6;

	let { visible = true }: Props = $props();

	let issues = $derived(
		projectStore.project
			? projectStore.qcReport.issues.filter((issue) =>
				issue.layerId
				&& issue.pageIndex === projectStore.project!.currentPage
				&& issue.severity !== "info"
			)
			: []
	);

	let regions = $derived(buildRegionItems(issues));
	let regionLayouts = $derived(buildRegionLayouts(regions));
	let hasSelectedRegion = $derived(regionLayouts.some((item) => item.selected));

	function severityRank(severity: QcIssue["severity"]): number {
		if (severity === "error") return 0;
		if (severity === "warning") return 1;
		return 2;
	}

	function buildRegionItems(sourceIssues: QcIssue[]): QcRegionItem[] {
		const groups = new Map<string, QcIssue[]>();
		for (const issue of sourceIssues) {
			if (!issue.layerId || issue.pageIndex === undefined) continue;
			const layerKind = issue.layerKind ?? "text";
			const key = `${issue.pageIndex}:${layerKind}:${issue.layerId}`;
			groups.set(key, [...(groups.get(key) ?? []), issue]);
		}

		return Array.from(groups.entries()).map(([key, groupIssues]) => {
			const sortedIssues = [...groupIssues].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
			const primaryIssue = sortedIssues[0];
			return {
				key,
				layerId: primaryIssue.layerId!,
				layerKind: primaryIssue.layerKind ?? "text",
				pageIndex: primaryIssue.pageIndex!,
				issues: sortedIssues,
				primaryIssue,
				severity: primaryIssue.severity,
			};
		});
	}

	function issueLabel(issue: QcIssue): string {
		const labels: Record<QcIssue["code"], string> = {
			project_empty: $_("qcRegionOverlay.code.project_empty"),
			page_without_text: $_("qcRegionOverlay.code.page_without_text"),
			empty_text_layer: $_("qcRegionOverlay.code.empty_text_layer"),
			invalid_text_box: $_("qcRegionOverlay.code.invalid_text_box"),
			text_overflow_risk: $_("qcRegionOverlay.code.text_overflow_risk"),
			duplicate_layer_id: $_("qcRegionOverlay.code.duplicate_layer_id"),
			invalid_image_layer_box: $_("qcRegionOverlay.code.invalid_image_layer_box"),
			image_layer_missing_asset: $_("qcRegionOverlay.code.image_layer_missing_asset"),
			image_layer_asset_missing_from_inventory: $_("qcRegionOverlay.code.image_layer_asset_missing_from_inventory"),
			image_layer_outside_page: $_("qcRegionOverlay.code.image_layer_outside_page"),
			oversized_image_layer: $_("qcRegionOverlay.code.oversized_image_layer"),
			unchanged_source_text: $_("qcRegionOverlay.code.unchanged_source_text"),
			remaining_source_script: $_("qcRegionOverlay.code.remaining_source_script"),
			low_confidence_layer: $_("qcRegionOverlay.code.low_confidence_layer"),
			ai_job_failed: $_("qcRegionOverlay.code.ai_job_failed"),
			ai_job_pending: $_("qcRegionOverlay.code.ai_job_pending"),
			ai_marker_failed: $_("qcRegionOverlay.code.ai_marker_failed"),
			ai_marker_needs_review: $_("qcRegionOverlay.code.ai_marker_needs_review"),
			ai_marker_page_missing: $_("qcRegionOverlay.code.ai_marker_page_missing"),
			ai_marker_image_stale: $_("qcRegionOverlay.code.ai_marker_image_stale"),
			ai_marker_comment_link_missing: $_("qcRegionOverlay.code.ai_marker_comment_link_missing"),
			ai_marker_task_link_missing: $_("qcRegionOverlay.code.ai_marker_task_link_missing"),
			workflow_task_page_missing: $_("qcRegionOverlay.code.workflow_task_page_missing"),
			workflow_task_layer_missing: $_("qcRegionOverlay.code.workflow_task_layer_missing"),
			workflow_task_image_stale: $_("qcRegionOverlay.code.workflow_task_image_stale"),
			review_decision_page_missing: $_("qcRegionOverlay.code.review_decision_page_missing"),
			workflow_incomplete: $_("qcRegionOverlay.code.workflow_incomplete"),
			open_review_comments: $_("qcRegionOverlay.code.open_review_comments"),
			comment_page_missing: $_("qcRegionOverlay.code.comment_page_missing"),
			comment_anchor_missing: $_("qcRegionOverlay.code.comment_anchor_missing"),
		};
		return labels[issue.code] ?? $_("qcRegionOverlay.code.fallback");
	}

	function itemLabel(item: QcRegionItem): string {
		const extraCount = item.issues.length - 1;
		return extraCount > 0 ? `${issueLabel(item.primaryIssue)} +${extraCount}` : issueLabel(item.primaryIssue);
	}

	function compactItemLabel(item: QcRegionItem): string {
		return item.severity === "error" ? $_("qcRegionOverlay.compactError") : $_("qcRegionOverlay.compact");
	}

	function itemTitle(item: QcRegionItem): string {
		return item.issues.map((issue) => resolveQcIssueMessage(issue, $_)).join("\n");
	}

	function isSelected(item: QcRegionItem): boolean {
		return item.issues.some((issue) => issue.id === projectStore.selectedQcIssueId);
	}

	function collapseLabel(item: QcRegionLayout): boolean {
		return regionLayouts.length > DENSE_REGION_LABEL_LIMIT && !item.selected && !item.activeLayer;
	}

	function findLayer(item: QcRegionItem): Pick<TextLayer | ImageLayer, "id" | "x" | "y" | "w" | "h"> | null {
		if (!projectStore.project) return null;
		if (item.layerKind === "image") {
			if (item.pageIndex === projectStore.project.currentPage) {
				return editorStore.imageLayers.find((layer) => layer.id === item.layerId)
					?? projectStore.project.pages[item.pageIndex]?.imageLayers?.find((layer) => layer.id === item.layerId)
					?? null;
			}
			return projectStore.project.pages[item.pageIndex]?.imageLayers?.find((layer) => layer.id === item.layerId) ?? null;
		}
		if (item.pageIndex === projectStore.project.currentPage) {
			return editorStore.textLayers.find((layer) => layer.id === item.layerId)
				?? projectStore.project.pages[item.pageIndex]?.textLayers.find((layer) => layer.id === item.layerId)
				?? null;
		}
		return projectStore.project.pages[item.pageIndex]?.textLayers.find((layer) => layer.id === item.layerId) ?? null;
	}

	function layerBox(layer: Pick<TextLayer | ImageLayer, "x" | "y" | "w" | "h">): WorkspaceRegionBox | null {
		editorStore.viewportVersion;
		return imageRegionToWorkspaceBox(editorStore.editor, {
			x: layer.x,
			y: layer.y,
			w: layer.w,
			h: layer.h,
		});
	}

	function buildRegionLayouts(sourceRegions: QcRegionItem[]): QcRegionLayout[] {
		editorStore.viewportVersion;
		const pendingLayouts = sourceRegions.flatMap((item) => {
			const layer = findLayer(item);
			const box = layer ? layerBox(layer) : null;
			if (!box) return [];
			const activeLayer = item.layerKind === "image"
				? editorStore.selectedImageLayer?.id === item.layerId
				: editorStore.selectedLayer?.id === item.layerId;
			return [{
				...item,
				activeLayer,
				box,
				selected: isSelected(item),
			}];
		});
		const workspaceSize = getCanvasWorkspaceSize(editorStore.editor);
		const placements = buildCanvasOverlayLabelPlacements(
			pendingLayouts.map((item) => ({
				id: item.key,
				box: item.box,
				label: itemLabel(item),
				laneIndex: 0,
				preferredAlign: "left",
				selected: item.selected || item.activeLayer,
				preferredSide: item.severity === "error" ? "above" : "below",
			})),
			{
				viewportWidth: workspaceSize?.width,
				viewportHeight: workspaceSize?.height,
			},
		);

		return pendingLayouts.map((item) => ({
			...item,
			labelPlacement: placements[item.key],
		}));
	}

	function regionStyle(item: QcRegionLayout): string {
		return [
			`left:${item.box.left}px`,
			`top:${item.box.top}px`,
			`width:${item.box.width}px`,
			`height:${item.box.height}px`,
			`z-index:${getCanvasOverlayZIndex("qc", { selected: item.selected, activeLayer: item.activeLayer })}`,
			formatCanvasOverlayLabelStyle(item.labelPlacement),
		].join(";");
	}

	function openIssue(item: QcRegionItem): void {
		projectStore.selectQcIssue(item.primaryIssue.id);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectProjectComment(null);
		projectStore.selectWorkflowTask(null);
		projectStore.selectReviewDecision(null);
		editorUiStore.setRightPanelMode("layers");
		editorStore.setTool("select");
		const layer = findLayer(item);
		if (layer) {
			editorStore.editor?.focusImageRegion?.({
				x: layer.x,
				y: layer.y,
				w: layer.w,
				h: layer.h,
			});
		}
		if (item.layerKind === "image") {
			editorStore.selectImageLayer(item.layerId);
			projectStore.setStatusMsg($_("qcRegionOverlay.openedImage"));
			return;
		}
		editorStore.editTextLayer(item.layerId);
		projectStore.setStatusMsg($_("qcRegionOverlay.openedText"));
	}
</script>

{#if visible && regions.length}
	<div
		class="qc-region-overlay"
		class:inactive={!isCanvasOverlayInteractive(editorStore.currentTool)}
		style={`z-index:${getCanvasOverlayZIndex("qc", { selected: hasSelectedRegion })};`}
		aria-label={$_("qcRegionOverlay.overlayLabel")}
	>
		{#each regionLayouts as item (item.key)}
			<button
				type="button"
				class={`qc-region-box ${item.severity}`}
				class:selected={item.selected}
				class:active-layer={item.activeLayer}
				style={regionStyle(item)}
				onclick={() => openIssue(item)}
				title={itemTitle(item)}
				aria-label={$_("qcRegionOverlay.openIssueLabel", { values: { label: itemLabel(item) } })}
			>
				<span class="region-label" class:compact={collapseLabel(item)}>
					{collapseLabel(item) ? compactItemLabel(item) : itemLabel(item)}
				</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.qc-region-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}

	.qc-region-box {
		position: absolute;
		z-index: 30;
		min-width: 40px;
		min-height: 40px;
		padding: 0;
		border: 1px dashed rgba(255, 211, 122, 0.9);
		border-radius: 4px;
		background: rgba(255, 211, 122, 0.08);
		color: #ffffff;
		cursor: pointer;
		pointer-events: auto;
		box-shadow:
			0 0 0 1px rgba(0, 0, 0, 0.36),
			0 10px 22px rgba(0, 0, 0, 0.22);
	}

	.qc-region-overlay.inactive .qc-region-box {
		pointer-events: none;
	}

	.qc-region-box.error {
		border-color: rgba(255, 139, 124, 0.94);
		background: rgba(255, 139, 124, 0.09);
	}

	.qc-region-box:hover,
	.qc-region-box.selected {
		border-color: rgba(80, 190, 255, 0.98);
		background: rgba(0, 120, 212, 0.16);
		box-shadow:
			0 0 0 2px rgba(255, 255, 255, 0.32),
			0 0 0 6px rgba(0, 120, 212, 0.24),
			0 12px 28px rgba(0, 0, 0, 0.3);
	}

	.qc-region-box.selected,
	.qc-region-box.active-layer {
		pointer-events: none;
	}

	.qc-region-box.selected::before,
	.qc-region-box.active-layer::before {
		position: absolute;
		inset: -5px;
		border: 1px solid rgba(255, 255, 255, 0.72);
		border-radius: 7px;
		content: "";
		pointer-events: none;
	}

	.region-label {
		position: absolute;
		left: var(--overlay-label-left);
		top: var(--overlay-label-top);
		width: var(--overlay-label-width);
		height: var(--overlay-label-height);
		overflow: hidden;
		padding: 4px 7px;
		border-radius: 4px;
		background: rgba(25, 27, 30, 0.94);
		font-size: 10px;
		font-weight: 800;
		line-height: 1;
		text-transform: uppercase;
		text-overflow: ellipsis;
		white-space: nowrap;
		box-shadow: 0 8px 18px rgba(0, 0, 0, 0.26);
	}

	.region-label.compact {
		width: 26px;
		padding-inline: 0;
		text-align: center;
	}
</style>
