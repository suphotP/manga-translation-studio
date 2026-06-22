import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	aiReviewResultLayerId,
	openAiReviewMarkerTarget,
	openAiReviewMarkerTargetOnPage,
} from "$lib/navigation/ai-review-navigation.js";
import {
	aiReviewRailActionLabel,
	aiReviewResultStateLabel,
	aiReviewRowIntentLabel,
	aiReviewRowStatusLabel,
} from "$lib/project/ai-review-marker-intent.js";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, Page, ProjectState } from "$lib/types.js";

const now = "2026-05-20T12:00:00.000Z";

function marker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "page-1.webp",
		region: { x: 20, y: 30, w: 120, h: 80 },
		status: "needs_review",
		tier: "clean-pro",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "page-1.webp",
		imageName: "page-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "AI navigation test",
		createdAt: now,
		currentPage: 0,
		targetLang: "en",
		pages: [page()],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		...overrides,
	};
}

function resetStores(): void {
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.editor = null;
	editorStore.selectedImageLayer = null;
}

beforeEach(() => {
	resetStores();
});

describe("AI review navigation", () => {
	it("selects and focuses needs-review markers without forcing placement", () => {
		const focusImageRegion = vi.fn();
		const target = marker({ id: "marker-needs-review" });
		projectStore.__setProjectForTesting(project({ aiReviewMarkers: [target] }));
		editorStore.editor = { focusImageRegion };
		editorUiStore.setRightPanelMode("layers");

		const outcome = openAiReviewMarkerTarget(target);

		expect(outcome).toBe("review");
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-needs-review");
		expect(focusImageRegion).toHaveBeenCalledWith(target.region);
		expect(editorUiStore.rightPanelMode).toBe("ai");
	});

	it("routes accepted unplaced markers into layer placement", () => {
		const focusImageRegion = vi.fn();
		const target = marker({
			id: "marker-accepted",
			status: "accepted",
			resultImageId: "result-accepted.webp",
		});
		projectStore.__setProjectForTesting(project({ aiReviewMarkers: [target] }));
		editorStore.selectedImageLayer = {
			id: "ai-result-stale",
			imageId: "stale-result.webp",
			imageName: "stale-result.webp",
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "overlay",
		};
		editorStore.editor = { focusImageRegion };
		editorUiStore.focusImageInspector("ai-result-stale");
		editorUiStore.setRightPanelMode("work");

		const outcome = openAiReviewMarkerTarget(target);

		expect(outcome).toBe("placement");
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-accepted");
		expect(focusImageRegion).toHaveBeenCalledWith(target.region);
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorStore.selectedImageLayer).toBeNull();
		expect(editorUiStore.imageInspectorFocusLayerId).toBeNull();
	});

	it("opens an accepted AI marker as an existing editable layer when the layer already exists", () => {
		const focusImageRegion = vi.fn();
		const selectImageLayer = vi.fn((layerId: string) => ({ id: layerId }));
		const target = marker({
			id: "marker-accepted-with-layer",
			status: "accepted",
			resultImageId: "result-accepted.webp",
		});
		const state = project({
			pages: [page({
				imageLayers: [{
					id: aiReviewResultLayerId(target),
					imageId: "result-accepted.webp",
					imageName: "ผล AI accepted.webp",
					x: 20,
					y: 30,
					w: 120,
					h: 80,
					rotation: 0,
					opacity: 1,
					index: 0,
					role: "overlay",
				}],
			})],
			aiReviewMarkers: [target],
		});
		projectStore.__setProjectForTesting(state);
		editorStore.editor = { focusImageRegion, selectImageLayer };
		editorUiStore.setRightPanelMode("work");

		const outcome = openAiReviewMarkerTarget(target);

		expect(outcome).toBe("applied-layer");
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-accepted-with-layer");
		expect(focusImageRegion).toHaveBeenCalledWith(target.region);
		expect(selectImageLayer).toHaveBeenCalledWith("ai-result-marker-accepted-with-layer");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-marker-accepted-with-layer");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(aiReviewResultStateLabel(state, target)).toBe("placed");
		expect(aiReviewRailActionLabel(state, target)).toBe("open_layer");
		expect(aiReviewRowIntentLabel(state, target)).toBe("open_layer");
		expect(aiReviewRowStatusLabel(state, target)).toBe("placed");
	});

	it("focuses the exact applied AI result layer instead of a stale layer", () => {
		const focusImageRegion = vi.fn();
		const selectImageLayer = vi.fn((layerId: string) => ({ id: layerId }));
		const stale = marker({
			id: "marker-stale",
			status: "applied",
			resultImageId: "result-stale.webp",
		});
		const target = marker({
			id: "marker-target",
			status: "applied",
			resultImageId: "result-target.webp",
		});
		projectStore.__setProjectForTesting(project({
			pages: [page({
				imageLayers: [
					{
						id: aiReviewResultLayerId(stale),
						imageId: "result-stale.webp",
						imageName: "ผล AI stale.webp",
						x: 0,
						y: 0,
						w: 100,
						h: 100,
						rotation: 0,
						opacity: 1,
						index: 0,
						role: "overlay",
					},
					{
						id: aiReviewResultLayerId(target),
						imageId: "result-target.webp",
						imageName: "ผล AI target.webp",
						x: 20,
						y: 30,
						w: 120,
						h: 80,
						rotation: 0,
						opacity: 1,
						index: 1,
						role: "overlay",
					},
				],
			})],
			aiReviewMarkers: [stale, target],
		}));
		editorStore.editor = { focusImageRegion, selectImageLayer };
		editorUiStore.setRightPanelMode("work");

		const outcome = openAiReviewMarkerTarget(target);

		expect(outcome).toBe("applied-layer");
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-target");
		expect(focusImageRegion).toHaveBeenCalledWith(target.region);
		expect(selectImageLayer).toHaveBeenCalledWith("ai-result-marker-target");
		expect(selectImageLayer).not.toHaveBeenCalledWith("ai-result-marker-stale");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-marker-target");
		expect(editorUiStore.rightPanelMode).toBe("layers");
	});

	it("jumps to the marker page before focusing an applied AI result layer", async () => {
		const focusImageRegion = vi.fn();
		const selectImageLayer = vi.fn((layerId: string) => ({ id: layerId }));
		const target = marker({
			id: "marker-page-2-applied",
			pageIndex: 1,
			status: "applied",
			resultImageId: "result-page-2.webp",
			region: { x: 80, y: 120, w: 150, h: 110 },
		});
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page(),
				page({
					imageId: "page-2.webp",
					imageName: "page-2.webp",
					imageLayers: [{
						id: aiReviewResultLayerId(target),
						imageId: "result-page-2.webp",
						imageName: "ผล AI page 2.webp",
						x: 80,
						y: 120,
						w: 150,
						h: 110,
						rotation: 0,
						opacity: 1,
						index: 0,
						role: "overlay",
					}],
				}),
			],
			aiReviewMarkers: [target],
		}));
		const goToPage = vi.spyOn(projectStore, "goToPage").mockImplementation(async (index) => {
			if (projectStore.project) projectStore.project.currentPage = index;
			return true;
		});
		editorStore.editor = { focusImageRegion, selectImageLayer };
		editorUiStore.setRightPanelMode("work");

		const outcome = await openAiReviewMarkerTargetOnPage(target);

		expect(outcome).toBe("applied-layer");
		expect(goToPage).toHaveBeenCalledWith(1, editorStore.editor);
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-page-2-applied");
		expect(focusImageRegion).toHaveBeenCalledWith(target.region);
		expect(selectImageLayer).toHaveBeenCalledWith("ai-result-marker-page-2-applied");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-marker-page-2-applied");
		expect(editorUiStore.rightPanelMode).toBe("layers");
	});

	it("does not focus or select a stale cross-page AI layer through the sync helper", () => {
		const focusImageRegion = vi.fn();
		const selectImageLayer = vi.fn();
		const target = marker({
			id: "marker-cross-page-sync",
			pageIndex: 1,
			status: "applied",
			resultImageId: "result-page-2.webp",
			region: { x: 70, y: 100, w: 150, h: 110 },
		});
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page(),
				page({
					imageId: "page-2.webp",
					imageName: "page-2.webp",
					imageLayers: [{
						id: aiReviewResultLayerId(target),
						imageId: "result-page-2.webp",
						imageName: "ผล AI page 2.webp",
						x: 70,
						y: 100,
						w: 150,
						h: 110,
						rotation: 0,
						opacity: 1,
						index: 0,
						role: "overlay",
					}],
				}),
			],
			aiReviewMarkers: [target],
		}));
		editorStore.editor = { focusImageRegion, selectImageLayer };
		editorUiStore.setRightPanelMode("work");

		const outcome = openAiReviewMarkerTarget(target);

		expect(outcome).toBe("review");
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-cross-page-sync");
		expect(projectStore.project?.currentPage).toBe(0);
		expect(focusImageRegion).not.toHaveBeenCalled();
		expect(selectImageLayer).not.toHaveBeenCalled();
		expect(editorUiStore.imageInspectorFocusLayerId).toBeNull();
		expect(editorUiStore.rightPanelMode).toBe("ai");
	});

	it("waits for the destination editor to settle before focusing a cross-page AI layer", async () => {
		const focusImageRegion = vi.fn();
		const selectImageLayer = vi.fn((layerId: string) => ({ id: layerId }));
		const target = marker({
			id: "marker-page-2-hydrated",
			pageIndex: 1,
			status: "applied",
			resultImageId: "result-page-2.webp",
			region: { x: 96, y: 120, w: 150, h: 110 },
		});
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page(),
				page({
					imageId: "page-2.webp",
					imageName: "page-2.webp",
					imageLayers: [{
						id: aiReviewResultLayerId(target),
						imageId: "result-page-2.webp",
						imageName: "ผล AI page 2.webp",
						x: 80,
						y: 120,
						w: 150,
						h: 110,
						rotation: 0,
						opacity: 1,
						index: 0,
						role: "overlay",
					}],
				}),
			],
			aiReviewMarkers: [target],
		}));
		const goToPage = vi.spyOn(projectStore, "goToPage").mockImplementation(async (index) => {
			if (projectStore.project) projectStore.project.currentPage = index;
			setTimeout(() => {
				editorStore.editor = { focusImageRegion, selectImageLayer };
			}, 0);
			return true;
		});
		editorStore.editor = null;
		editorUiStore.setRightPanelMode("work");

		const outcome = await openAiReviewMarkerTargetOnPage(target);

		expect(outcome).toBe("applied-layer");
		expect(goToPage).toHaveBeenCalledWith(1, null);
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-page-2-hydrated");
		expect(focusImageRegion).toHaveBeenCalledWith(target.region);
		expect(selectImageLayer).toHaveBeenCalledWith("ai-result-marker-page-2-hydrated");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-marker-page-2-hydrated");
		expect(editorUiStore.rightPanelMode).toBe("layers");
	});

	it("jumps to the marker page and opens placement for accepted unplaced results", async () => {
		const focusImageRegion = vi.fn();
		const target = marker({
			id: "marker-page-2-accepted",
			pageIndex: 1,
			status: "accepted",
			resultImageId: "result-page-2.webp",
			region: { x: 88, y: 144, w: 160, h: 100 },
		});
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page(),
				page({ imageId: "page-2.webp", imageName: "page-2.webp" }),
			],
			aiReviewMarkers: [target],
		}));
		const goToPage = vi.spyOn(projectStore, "goToPage").mockImplementation(async (index) => {
			if (projectStore.project) projectStore.project.currentPage = index;
			return true;
		});
		editorStore.selectedImageLayer = {
			id: "ai-result-stale",
			imageId: "stale-result.webp",
			imageName: "stale-result.webp",
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "overlay",
		};
		editorStore.editor = { focusImageRegion };
		editorUiStore.focusImageInspector("ai-result-stale");
		editorUiStore.setRightPanelMode("work");

		const outcome = await openAiReviewMarkerTargetOnPage(target);

		expect(outcome).toBe("placement");
		expect(goToPage).toHaveBeenCalledWith(1, editorStore.editor);
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-page-2-accepted");
		expect(focusImageRegion).toHaveBeenCalledWith(target.region);
		expect(editorStore.selectedImageLayer).toBeNull();
		expect(editorUiStore.imageInspectorFocusLayerId).toBeNull();
		expect(editorUiStore.rightPanelMode).toBe("layers");
	});

	it("does not claim a layer jump when the page switch fails", async () => {
		const focusImageRegion = vi.fn();
		const selectImageLayer = vi.fn();
		const target = marker({
			id: "marker-blocked-page-switch",
			pageIndex: 1,
			status: "applied",
			resultImageId: "result-page-2.webp",
		});
		projectStore.__setProjectForTesting(project({
			currentPage: 0,
			pages: [
				page(),
				page({
					imageLayers: [{
						id: aiReviewResultLayerId(target),
						imageId: "result-page-2.webp",
						imageName: "ผล AI page 2.webp",
						x: 20,
						y: 30,
						w: 120,
						h: 80,
						rotation: 0,
						opacity: 1,
						index: 0,
						role: "overlay",
					}],
				}),
			],
			aiReviewMarkers: [target],
		}));
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(false);
		editorStore.editor = { focusImageRegion, selectImageLayer };
		editorUiStore.setRightPanelMode("ai");

		const outcome = await openAiReviewMarkerTargetOnPage(target);

		expect(outcome).toBe("review");
		expect(goToPage).toHaveBeenCalledWith(1, editorStore.editor);
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-blocked-page-switch");
		expect(focusImageRegion).not.toHaveBeenCalled();
		expect(selectImageLayer).not.toHaveBeenCalled();
		expect(editorUiStore.rightPanelMode).toBe("ai");
	});
});
