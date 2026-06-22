import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import AiReviewRegionOverlay from "$lib/components/AiReviewRegionOverlay.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, Page, ProjectState } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

function marker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 10, y: 20, w: 120, h: 80 },
		status: "needs_review",
		tier: "clean-pro",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function page(): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
	};
}

function project(markers: AiReviewMarker[]): ProjectState {
	return {
		projectId: "project-1",
		name: "AI overlay test",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "en",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: markers,
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
	};
}

function installEditorGeometry(): HTMLElement {
	const workspace = document.createElement("div");
	workspace.className = "canvas-workspace";
	const canvas = document.createElement("canvas");
	workspace.appendChild(canvas);
	document.body.appendChild(workspace);

	vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
		left: 0,
		top: 0,
		width: 500,
		height: 400,
		right: 500,
		bottom: 400,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect);
	vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
		left: 0,
		top: 0,
		width: 500,
		height: 400,
		right: 500,
		bottom: 400,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect);

	editorStore.editor = {
		canvas: {
			upperCanvasEl: canvas,
			viewportTransform: [1, 0, 0, 1, 0, 0],
		},
		destroy: vi.fn(),
		setSelectionChromeMuted: vi.fn(),
		imageBounds: { left: 0, top: 0, width: 400, height: 800 },
		imageWidth: 800,
		imageHeight: 1600,
	};
	editorStore.currentTool = "select";
	return workspace;
}

beforeEach(() => {
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.destroy();
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("AiReviewRegionOverlay", () => {
	it("keeps routine unselected AI review anchors compact while another inspector owns the workflow", () => {
		installEditorGeometry();
		projectStore.__setProjectForTesting(project([
			marker({ id: "marker-1", region: { x: 10, y: 20, w: 120, h: 80 }, updatedAt: "2026-05-14T00:00:01.000Z" }),
			marker({ id: "marker-2", jobId: "job-2", region: { x: 40, y: 70, w: 110, h: 80 }, updatedAt: "2026-05-14T00:00:04.000Z" }),
			marker({ id: "marker-3", jobId: "job-3", status: "failed", region: { x: 80, y: 120, w: 110, h: 80 }, updatedAt: "2026-05-14T00:00:03.000Z" }),
			marker({ id: "marker-4", jobId: "job-4", status: "retry_requested", region: { x: 120, y: 160, w: 110, h: 80 }, updatedAt: "2026-05-14T00:00:02.000Z" }),
		]));

		render(AiReviewRegionOverlay);

		expect(screen.getAllByRole("button")).toHaveLength(4);
		expect(screen.getAllByText(/AI [1-4]/)).toHaveLength(4);
		expect(screen.queryByText("รอรีวิว")).toBeNull();
		expect(screen.getByText("รันพลาด")).toBeTruthy();
		expect(screen.getByText("รันใหม่")).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 40, 70" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รันพลาด ที่ 80, 120" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 10, 20" })).toBeTruthy();
	});

	it("keeps selected marker plus nearby AI context and keeps canvas decisions out of the overlay", async () => {
		installEditorGeometry();
		const updateStatus = vi.spyOn(projectStore, "updateAiReviewMarkerStatus").mockResolvedValue(undefined);
		const placeAiResult = vi.spyOn(projectStore, "placeAiReviewMarkerResultAsImageLayer").mockResolvedValue({
			id: "ai-result-marker-1",
			imageId: "result-1.webp",
			imageName: "result-1.webp",
			originalName: "AI result P1",
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		});
		projectStore.__setProjectForTesting(project([
			marker({ id: "marker-1", region: { x: 10, y: 20, w: 120, h: 80 }, resultImageId: "result-1.webp" }),
			marker({ id: "marker-2", jobId: "job-2", region: { x: 40, y: 70, w: 110, h: 80 } }),
		]));
		projectStore.selectAiReviewMarker("marker-1");
		editorUiStore.setRightPanelMode("layers");

		render(AiReviewRegionOverlay);

		expect(screen.getAllByRole("button")).toHaveLength(3);
		expect(screen.getByText("AI 1")).toBeTruthy();
		expect(screen.getByText("AI 2")).toBeTruthy();
		expect(screen.getAllByText("รอรีวิว").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByLabelText("คำสั่งผล AI รอรีวิว")).toBeTruthy();
		expect(screen.getByLabelText("พื้นที่ผล AI").classList.contains("has-selection")).toBe(true);
		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 40, 70" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ยอมรับและแปลงเป็นเลเยอร์แก้ไข" })).toBeNull();
		expect(placeAiResult).not.toHaveBeenCalled();

		expect(screen.getByText("P1 · AI 1 · Clean Pro")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เปิดผลนี้" }));
		expect(screen.queryByRole("button", { name: "ผ่าน" })).toBeNull();
		expect(screen.queryByRole("button", { name: "วางเลเยอร์" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ขอรันใหม่" })).toBeNull();
		expect(screen.queryByLabelText("คำสั่งผล AI รอรีวิว")).toBeNull();

		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-1");
		expect(editorUiStore.rightPanelMode).toBe("ai");
		expect(editorUiStore.imageInspectorFocusLayerId).toBeNull();
		expect(updateStatus).not.toHaveBeenCalledWith("marker-1", "accepted");
		expect(updateStatus).not.toHaveBeenCalledWith("marker-1", "retry_requested");
	});

	it("does not expose approval on stale review markers from the canvas overlay", async () => {
		installEditorGeometry();
		const updateStatus = vi.spyOn(projectStore, "updateAiReviewMarkerStatus").mockResolvedValue(undefined);
		projectStore.__setProjectForTesting(project([
			marker({
				id: "stale-marker",
				imageId: "old-image.webp",
				resultImageId: "result-1.webp",
			}),
		]));
		projectStore.selectAiReviewMarker("stale-marker");

		render(AiReviewRegionOverlay);

		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 10, 20" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ผ่าน" })).toBeNull();
		expect(screen.queryByRole("button", { name: "วางเลเยอร์" })).toBeNull();
		expect(updateStatus).not.toHaveBeenCalled();
	});

	it("lets the AI panel own decisions instead of duplicating a canvas action dock", () => {
		installEditorGeometry();
		projectStore.__setProjectForTesting(project([
			marker({ id: "marker-1", resultImageId: "result-1.webp" }),
			marker({ id: "marker-2", jobId: "job-2", status: "accepted", resultImageId: "result-2.webp" }),
		]));
		projectStore.selectAiReviewMarker("marker-1");
		editorUiStore.setRightPanelMode("ai");

		render(AiReviewRegionOverlay);

		expect(editorStore.editor?.setSelectionChromeMuted).toHaveBeenCalledWith(true);
		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 10, 20" })).toBeTruthy();
		expect(screen.getByText("AI 1")).toBeTruthy();
		expect(screen.getByText("AI 2")).toBeTruthy();
		expect(screen.queryByLabelText("คำสั่งผล AI รอรีวิว")).toBeNull();
		expect(screen.queryByRole("button", { name: "เปิดผลนี้" })).toBeNull();
	});

	it("lets the Layers selected-object inspector hide the canvas action dock while keeping locate anchors", async () => {
		installEditorGeometry();
		projectStore.__setProjectForTesting(project([
			marker({ id: "marker-1", resultImageId: "result-1.webp" }),
			marker({ id: "marker-2", jobId: "job-2", region: { x: 40, y: 70, w: 110, h: 80 } }),
		]));
		projectStore.selectAiReviewMarker("marker-1");
		editorUiStore.setRightPanelMode("layers");

		render(AiReviewRegionOverlay, { props: { actionDockVisible: false } });

		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 10, 20" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 40, 70" })).toBeTruthy();
		expect(screen.queryByLabelText("คำสั่งผล AI รอรีวิว")).toBeNull();
		expect(screen.queryByRole("button", { name: "เปิดผลนี้" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 10, 20" }));
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-1");
		expect(editorUiStore.rightPanelMode).toBe("ai");
	});

	it("keeps accepted unplaced markers visible as placement work on the canvas", async () => {
		installEditorGeometry();
		projectStore.__setProjectForTesting(project([
			marker({
				id: "marker-accepted",
				status: "accepted",
				resultImageId: "result-1.webp",
				region: { x: 10, y: 20, w: 120, h: 80 },
			}),
		]));

		render(AiReviewRegionOverlay);

		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: ผ่านรีวิว ที่ 10, 20" })).toBeTruthy();
		expect(screen.getByText("รอวาง")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: ผ่านรีวิว ที่ 10, 20" }));
		expect(screen.queryByLabelText("คำสั่งผล AI ผ่านรีวิว รอวางเลเยอร์")).toBeNull();
		expect(screen.queryByRole("button", { name: "วางเลเยอร์ AI" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เปิด Review" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ผ่าน" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ขอรันใหม่" })).toBeNull();
		expect(editorUiStore.rightPanelMode).toBe("layers");
	});

	it("keeps the applied AI region visible and clickable without duplicating the action dock", () => {
		installEditorGeometry();
		const appliedMarker = marker({
			id: "marker-1",
			status: "applied",
			resultImageId: "result-1.webp",
			region: { x: 10, y: 20, w: 120, h: 80 },
		});
		const state = project([appliedMarker]);
		state.pages[0].imageLayers = [{
			id: "ai-result-marker-1",
			imageId: "result-1.webp",
			imageName: "result-1.webp",
			originalName: "ผล AI หน้า 1",
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		}];
		projectStore.__setProjectForTesting(state);
		projectStore.selectAiReviewMarker("marker-1");
		editorStore.selectedImageLayer = state.pages[0].imageLayers[0];

		render(AiReviewRegionOverlay);

		const focusedRegion = screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: วางแล้ว ที่ 10, 20" });
		expect(focusedRegion.classList.contains("layer-focused")).toBe(true);
		expect(focusedRegion.textContent).toContain("AI 1");
		expect(getComputedStyle(focusedRegion).pointerEvents).toBe("auto");
		expect(getComputedStyle(focusedRegion).opacity).toBe("1");
		expect(screen.queryByLabelText("คำสั่งผล AI วางแล้ว")).toBeNull();
		expect(screen.queryByRole("button", { name: "เปิดเลเยอร์ AI" })).toBeNull();
	});

	it("overlays the AI result image inside the crop region as soon as a result is ready", () => {
		installEditorGeometry();
		projectStore.__setProjectForTesting(project([
			marker({
				id: "marker-ready",
				status: "needs_review",
				resultImageId: "result-ready.webp",
				region: { x: 10, y: 20, w: 120, h: 80 },
			}),
		]));

		render(AiReviewRegionOverlay);

		const preview = screen.getByTestId("ai-region-result-marker-ready") as HTMLImageElement;
		expect(preview).toBeTruthy();
		// The <img> is wired through the signedAssetSrc action (a browser <img>
		// cannot send the Authorization header for an owned-project asset), so the
		// element renders for the ready result regardless of the async token mint.
		expect(preview.classList.contains("region-result")).toBe(true);
	});

	it("does not overlay a result image once it is applied as a real editable layer", () => {
		installEditorGeometry();
		const appliedMarker = marker({
			id: "marker-applied",
			status: "applied",
			resultImageId: "result-applied.webp",
			region: { x: 10, y: 20, w: 120, h: 80 },
		});
		const state = project([appliedMarker]);
		state.pages[0].imageLayers = [{
			id: "ai-result-marker-applied",
			imageId: "result-applied.webp",
			imageName: "result-applied.webp",
			originalName: "ผล AI หน้า 1",
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		}];
		projectStore.__setProjectForTesting(state);

		render(AiReviewRegionOverlay);

		// The real canvas layer paints the result; the overlay must not double it.
		expect(screen.queryByTestId("ai-region-result-marker-applied")).toBeNull();
	});

	it("selects the applied AI region from the active image layer when the marker selection is stale", () => {
		installEditorGeometry();
		const appliedMarker = marker({
			id: "layer-selected-marker",
			status: "applied",
			resultImageId: "result-1.webp",
			region: { x: 10, y: 20, w: 120, h: 80 },
		});
		const staleReview = marker({
			id: "stale-review",
			jobId: "job-stale",
			status: "needs_review",
			region: { x: 60, y: 70, w: 90, h: 80 },
		});
		const state = project([staleReview, appliedMarker]);
		state.pages[0].imageLayers = [{
			id: "ai-result-layer-selected-marker",
			imageId: "result-1.webp",
			imageName: "result-1.webp",
			originalName: "ผล AI หน้า 1",
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		}];
		projectStore.__setProjectForTesting(state);
		projectStore.selectAiReviewMarker("stale-review");
		editorStore.selectedImageLayer = state.pages[0].imageLayers[0];

		render(AiReviewRegionOverlay);

		expect(screen.getByLabelText("พื้นที่ผล AI").classList.contains("has-selection")).toBe(true);
		const focusedRegion = screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: วางแล้ว ที่ 10, 20" });
		expect(focusedRegion.classList.contains("selected")).toBe(true);
		expect(focusedRegion.classList.contains("layer-focused")).toBe(true);
		expect(getComputedStyle(focusedRegion).pointerEvents).toBe("auto");
		expect(screen.getByRole("button", { name: "เปิดพื้นที่ผล AI: รอรีวิว ที่ 60, 70" }).classList.contains("selected")).toBe(false);
	});
});
