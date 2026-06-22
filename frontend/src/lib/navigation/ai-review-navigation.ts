import { aiResultLayerId, isAiResultLayerAvailable, isAiResultPlacementNeeded } from "$lib/project/ai-review-marker-intent.js";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore, type RightPanelMode } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker } from "$lib/types.js";

export type AiReviewOpenOutcome = "applied-layer" | "placement" | "review";

interface OpenAiReviewMarkerTargetOptions {
	defaultPanelMode?: RightPanelMode | null;
	focusRegion?: boolean;
	placementPanelMode?: RightPanelMode | null;
	selectMarker?: boolean;
}

function waitForPageTargetSettle(): Promise<void> {
	return new Promise((resolve) => {
		queueMicrotask(() => setTimeout(resolve, 0));
	});
}

export function aiReviewResultLayerId(marker: AiReviewMarker): string {
	return aiResultLayerId(marker);
}

export function focusAppliedAiResultLayer(marker: AiReviewMarker): boolean {
	if (!isAiResultLayerAvailable(projectStore.project, marker)) return false;
	const layerId = aiReviewResultLayerId(marker);
	editorStore.editor?.selectImageLayer?.(layerId);
	editorUiStore.focusImageInspector(layerId);
	return true;
}

export function openAiReviewMarkerTarget(
	marker: AiReviewMarker,
	options: OpenAiReviewMarkerTargetOptions = {},
): AiReviewOpenOutcome {
	const {
		defaultPanelMode = "ai",
		focusRegion = true,
		placementPanelMode = "layers",
		selectMarker = true,
	} = options;

	if (selectMarker) projectStore.selectAiReviewMarker(marker.id);

	const isCurrentPage = Boolean(projectStore.project && marker.pageIndex === projectStore.project.currentPage);

	if (!isCurrentPage) {
		editorStore.clearSelection();
		editorUiStore.clearImageInspectorFocus();
		if (defaultPanelMode) editorUiStore.setRightPanelMode(defaultPanelMode);
		return "review";
	}

	if (focusRegion) editorStore.editor?.focusImageRegion?.(marker.region);

	if (focusAppliedAiResultLayer(marker)) return "applied-layer";

	if (isAiResultPlacementNeeded(projectStore.project, marker)) {
		editorStore.clearSelection();
		editorUiStore.clearImageInspectorFocus();
		if (placementPanelMode) editorUiStore.setRightPanelMode(placementPanelMode);
		return "placement";
	}

	editorStore.clearSelection();
	editorUiStore.clearImageInspectorFocus();
	if (defaultPanelMode) editorUiStore.setRightPanelMode(defaultPanelMode);
	return "review";
}

export async function openAiReviewMarkerTargetOnPage(
	marker: AiReviewMarker,
	options: OpenAiReviewMarkerTargetOptions = {},
): Promise<AiReviewOpenOutcome> {
	const project = projectStore.project;
	if (project && marker.pageIndex !== project.currentPage) {
		const opened = await projectStore.goToPage(marker.pageIndex, editorStore.editor);
		if (!opened && projectStore.project?.currentPage !== marker.pageIndex) {
			if (options.selectMarker !== false) projectStore.selectAiReviewMarker(marker.id);
			editorStore.clearSelection();
			editorUiStore.clearImageInspectorFocus();
			if (options.defaultPanelMode !== undefined && options.defaultPanelMode !== null) {
				editorUiStore.setRightPanelMode(options.defaultPanelMode);
			}
			return "review";
		}
		await waitForPageTargetSettle();
	}

	return openAiReviewMarkerTarget(marker, options);
}
