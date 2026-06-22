<script lang="ts">
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
	import { annotationToImageRegion, annotationPinLocalPoint, freehandPolylinePoints } from "$lib/project/review-annotations.js";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { _ } from "$lib/i18n";
	import type { ProjectComment, ReviewAnnotation, TextLayer } from "$lib/types.js";

	interface Props {
		visible?: boolean;
	}

	type CommentRegionItem = {
		key: string;
		layerId?: string;
		pageIndex: number;
		region?: { x: number; y: number; w: number; h: number };
		/** Review mark shape (circle/rect/freehand/pin) to render exactly, if any. */
		annotation?: ReviewAnnotation;
		comments: ProjectComment[];
		primaryComment: ProjectComment;
		status: ProjectComment["status"];
	};

	type CommentRegionLayout = CommentRegionItem & {
		activeLayer: boolean;
		box: WorkspaceRegionBox;
		labelPlacement: CanvasOverlayLabelPlacement;
		selected: boolean;
	};

	const DENSE_REGION_LABEL_LIMIT = 6;

	let { visible = true }: Props = $props();

	let comments = $derived(
		projectStore.project
			? projectStore.comments.filter((comment) =>
				// Layer-anchored, explicit-region, OR review-mark (annotation) comments all
				// anchor to the page. Without the `annotation` clause, review marks (which
				// only carry an annotation, not a region) were invisible in the editor.
				(comment.layerId || comment.region || comment.annotation)
				&& comment.pageIndex === projectStore.project!.currentPage
				&& (comment.status === "open" || comment.id === projectStore.selectedProjectCommentId)
			)
			: []
	);

	let regions = $derived(buildRegionItems(comments));
	let regionLayouts = $derived(buildRegionLayouts(regions));
	let hasSelectedRegion = $derived(regionLayouts.some((item) => item.selected));
	let aiReviewOwnsCanvas = $derived(
		editorUiStore.rightPanelMode === "ai"
		&& projectStore.currentPageAiReviewMarkers.length > 0
		&& !projectStore.selectedProjectCommentId
	);

	function buildRegionItems(sourceComments: ProjectComment[]): CommentRegionItem[] {
		const groups = new Map<string, ProjectComment[]>();
		for (const comment of sourceComments) {
			if (!comment.layerId && !comment.region && !comment.annotation) continue;
			// Review marks (annotations) are each their own anchor — never collapse two
			// distinct drawn marks into one box — so key them by comment id. Layer/region
			// comments still cluster by their anchor so a thread shows as one box.
			const key = comment.annotation
				? `${comment.pageIndex}:annot:${comment.id}`
				: comment.layerId
					? `${comment.pageIndex}:layer:${comment.layerId}`
					: `${comment.pageIndex}:region:${comment.region!.x}:${comment.region!.y}:${comment.region!.w}:${comment.region!.h}`;
			groups.set(key, [...(groups.get(key) ?? []), comment]);
		}

		return Array.from(groups.entries()).map(([key, groupComments]) => {
			const selectedComment = groupComments.find((comment) => comment.id === projectStore.selectedProjectCommentId);
			const primaryComment = selectedComment
				?? groupComments.find((comment) => comment.status === "open")
				?? groupComments[0];
			const hasOpenComment = groupComments.some((comment) => comment.status === "open");
			return {
				key,
				layerId: primaryComment.layerId,
				pageIndex: primaryComment.pageIndex,
				region: primaryComment.region,
				annotation: primaryComment.annotation,
				comments: groupComments,
				primaryComment,
				status: hasOpenComment ? "open" : "resolved",
			};
		});
	}

	function itemLabel(item: CommentRegionItem): string {
		const extraCount = item.comments.length - 1;
		return extraCount > 0
			? $_("commentRegionOverlay.commentsPlus", { values: { n: extraCount } })
			: $_("commentRegionOverlay.comment");
	}

	function compactItemLabel(item: CommentRegionItem): string {
		return item.comments.length > 1 ? "C+" : "C";
	}

	function itemTitle(item: CommentRegionItem): string {
		return item.comments
			.map((comment) => `${comment.author}: ${comment.body} (${comment.status})`)
			.join("\n");
	}

	function isSelected(item: CommentRegionItem): boolean {
		return item.comments.some((comment) => comment.id === projectStore.selectedProjectCommentId);
	}

	function collapseLabel(item: CommentRegionLayout): boolean {
		return regionLayouts.length > DENSE_REGION_LABEL_LIMIT && !item.selected && !item.activeLayer;
	}

	function findLayer(item: CommentRegionItem): TextLayer | null {
		if (!item.layerId) return null;
		if (!projectStore.project) return null;
		if (item.pageIndex === projectStore.project.currentPage) {
			return editorStore.textLayers.find((layer) => layer.id === item.layerId)
				?? projectStore.project.pages[item.pageIndex]?.textLayers.find((layer) => layer.id === item.layerId)
				?? null;
		}
		return projectStore.project.pages[item.pageIndex]?.textLayers.find((layer) => layer.id === item.layerId) ?? null;
	}

	function layerBox(layer: TextLayer): WorkspaceRegionBox | null {
		editorStore.viewportVersion;
		return imageRegionToWorkspaceBox(editorStore.editor, {
			x: layer.x,
			y: layer.y,
			w: layer.w,
			h: layer.h,
		});
	}

	function itemRegion(item: CommentRegionItem): { x: number; y: number; w: number; h: number } | null {
		if (item.region) return item.region;
		if (item.annotation) {
			const editor = editorStore.editor;
			const imageWidth = editor?.imageWidth ?? 0;
			const imageHeight = editor?.imageHeight ?? 0;
			if (imageWidth > 0 && imageHeight > 0) {
				return annotationToImageRegion(item.annotation, imageWidth, imageHeight);
			}
		}
		return null;
	}

	function itemBox(item: CommentRegionItem, layer: TextLayer | null): WorkspaceRegionBox | null {
		const region = itemRegion(item);
		if (region) {
			editorStore.viewportVersion;
			return imageRegionToWorkspaceBox(editorStore.editor, region);
		}
		return layer ? layerBox(layer) : null;
	}

	function buildRegionLayouts(sourceRegions: CommentRegionItem[]): CommentRegionLayout[] {
		editorStore.viewportVersion;
		const pendingLayouts = sourceRegions.flatMap((item) => {
			const layer = findLayer(item);
			const box = itemBox(item, layer);
			if (!box) return [];
			const activeLayer = item.layerId !== undefined && editorStore.selectedLayer?.id === item.layerId;
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
				laneIndex: 1,
				preferredAlign: "right",
				selected: item.selected || item.activeLayer,
				preferredSide: "above",
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

	function regionStyle(item: CommentRegionLayout): string {
		return [
			`left:${item.box.left}px`,
			`top:${item.box.top}px`,
			`width:${item.box.width}px`,
			`height:${item.box.height}px`,
			`z-index:${getCanvasOverlayZIndex("comment", { selected: item.selected, activeLayer: item.activeLayer })}`,
			formatCanvasOverlayLabelStyle(item.labelPlacement),
		].join(";");
	}

	const ANNOTATION_DEFAULT_COLOR = "#FBBF24";

	/** Stroke colour for an annotation item (falls back to the review default). */
	function annotationColor(item: CommentRegionItem): string {
		return item.annotation?.color || ANNOTATION_DEFAULT_COLOR;
	}

	/**
	 * Map the annotation's full-image-normalized freehand points into the local
	 * SVG box space (0..100 viewBox). The box covers the annotation's (padded)
	 * normalized region, so we re-base each point onto that region.
	 */
	function annotationLocalPolyline(item: CommentRegionLayout): string {
		const a = item.annotation;
		if (!a || a.shape !== "freehand" || !a.points || a.points.length === 0) return "";
		// Box covers the (padded) bounds; recompute the un-padded region origin/extent
		// from the raw annotation so points map honestly into the box.
		const ox = a.x;
		const oy = a.y;
		const ew = a.w > 0 ? a.w : 1;
		const eh = a.h > 0 ? a.h : 1;
		return a.points
			.map((p) => `${(((p.x - ox) / ew) * 100).toFixed(2)},${(((p.y - oy) / eh) * 100).toFixed(2)}`)
			.join(" ");
	}

	function openComment(item: CommentRegionItem): void {
		projectStore.selectProjectComment(item.primaryComment.id);
		projectStore.selectAiReviewMarker(null);
		projectStore.selectWorkflowTask(null);
		projectStore.selectQcIssue(null);
		editorUiStore.setRightPanelMode("work");
		if (item.layerId) {
			editorStore.selectTextLayer(item.layerId);
		}
	}
</script>

{#if visible && regions.length && !aiReviewOwnsCanvas}
	<div
		class="comment-region-overlay"
		class:inactive={!isCanvasOverlayInteractive(editorStore.currentTool)}
		style={`z-index:${getCanvasOverlayZIndex("comment", { selected: hasSelectedRegion })};`}
		aria-label={$_("commentRegionOverlay.overlayLabel")}
	>
		{#each regionLayouts as item (item.key)}
			<button
				type="button"
				class={`comment-region-box ${item.status}`}
				class:selected={item.selected}
				class:active-layer={item.activeLayer}
				class:annotation={Boolean(item.annotation)}
				style={regionStyle(item)}
				onclick={() => openComment(item)}
				title={itemTitle(item)}
				aria-label={$_("commentRegionOverlay.openComment", { values: { label: itemLabel(item) } })}
			>
				{#if item.annotation}
					<!-- Render the EXACT review mark shape the reviewer drew (circle/rect/
						freehand/pin), scaled into the anchor box, so the editor mirrors the
						review reader rather than showing a generic rectangle. -->
					<svg class="annot-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
						{#if item.annotation.shape === "circle"}
							<ellipse cx="50" cy="50" rx="48" ry="48" fill="none" stroke={annotationColor(item)} stroke-width={item.selected ? 4 : 3} vector-effect="non-scaling-stroke" />
						{:else if item.annotation.shape === "rect"}
							<rect x="2" y="2" width="96" height="96" fill="none" stroke={annotationColor(item)} stroke-width={item.selected ? 4 : 3} vector-effect="non-scaling-stroke" />
						{:else if item.annotation.shape === "freehand"}
							<polyline points={annotationLocalPolyline(item)} fill="none" stroke={annotationColor(item)} stroke-width={item.selected ? 4 : 3} stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
						{:else}
							<circle cx={annotationPinLocalPoint(item.annotation).cx} cy={annotationPinLocalPoint(item.annotation).cy} r="22" fill={annotationColor(item)} stroke="#1a1205" stroke-width="2" vector-effect="non-scaling-stroke" />
						{/if}
					</svg>
				{/if}
				<span class="region-label" class:compact={collapseLabel(item)}>
					{collapseLabel(item) ? compactItemLabel(item) : itemLabel(item)}
				</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.comment-region-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}

	.comment-region-box {
		position: absolute;
		z-index: 20;
		min-width: 40px;
		min-height: 40px;
		padding: 0;
		border: 2px dotted rgba(94, 234, 212, 0.9);
		border-radius: 4px;
		background: rgba(20, 184, 166, 0.08);
		color: #ffffff;
		cursor: pointer;
		pointer-events: auto;
		box-shadow:
			0 0 0 1px rgba(0, 0, 0, 0.38),
			0 10px 22px rgba(0, 0, 0, 0.24);
	}

	.comment-region-overlay.inactive .comment-region-box {
		pointer-events: none;
	}

	/* Annotation marks render their exact drawn shape, so drop the generic dotted
		region box chrome and let the SVG shape carry the visual. */
	.comment-region-box.annotation {
		border: none;
		background: transparent;
		box-shadow: none;
		min-width: 18px;
		min-height: 18px;
	}

	.comment-region-box.annotation:hover,
	.comment-region-box.annotation.selected {
		background: rgba(124, 92, 255, 0.1);
		box-shadow: 0 0 0 2px rgba(124, 92, 255, 0.45);
		border-radius: 6px;
	}

	.annot-shape {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
		pointer-events: none;
	}

	.comment-region-box.resolved {
		border-color: rgba(151, 161, 176, 0.72);
		background: rgba(151, 161, 176, 0.08);
	}

	.comment-region-box:hover,
	.comment-region-box.selected {
		border-color: rgba(80, 190, 255, 0.98);
		background: rgba(0, 120, 212, 0.16);
		box-shadow:
			0 0 0 2px rgba(255, 255, 255, 0.32),
			0 0 0 6px rgba(0, 120, 212, 0.24),
			0 12px 28px rgba(0, 0, 0, 0.3);
	}

	.comment-region-box.selected,
	.comment-region-box.active-layer {
		pointer-events: none;
	}

	.comment-region-box.selected::before,
	.comment-region-box.active-layer::before {
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
		font-size: 11px;
		font-weight: 800;
		line-height: 1;
		text-transform: none;
		text-overflow: ellipsis;
		white-space: nowrap;
		box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
	}

	.region-label.compact {
		width: 24px;
		padding-inline: 0;
		text-align: center;
	}
</style>
