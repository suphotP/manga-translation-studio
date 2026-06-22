import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import CommentRegionOverlay from "$lib/components/CommentRegionOverlay.svelte";
import QcRegionOverlay from "$lib/components/QcRegionOverlay.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, Page, ProjectComment, ProjectState, TextLayer } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

function textLayer(index: number): TextLayer {
	return {
		id: `layer-${index}`,
		text: "",
		x: 20 + (index * 18),
		y: 30 + (index * 20),
		w: 100,
		h: 42,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index,
	};
}

function comment(index: number): ProjectComment {
	return {
		id: `comment-${index}`,
		pageIndex: 0,
		region: {
			x: 20 + (index * 16),
			y: 30 + (index * 18),
			w: 86,
			h: 42,
		},
		body: `Comment ${index}`,
		author: "Reviewer",
		status: "open",
		createdAt: now,
		updatedAt: now,
	};
}

function aiMarker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "ai-marker-1",
		jobId: "ai-job-1",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 80, y: 90, w: 120, h: 80 },
		status: "needs_review",
		tier: "clean-pro",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Overlay density test",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "en",
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

describe("canvas region overlays", () => {
	it("collapses dense QC labels while keeping the selected issue readable", () => {
		installEditorGeometry();
		const layers = Array.from({ length: 7 }, (_, index) => textLayer(index));
		editorStore.textLayers = layers;
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: layers })],
		}));
		projectStore.selectQcIssue("page-0-layer-layer-1-empty");

		render(QcRegionOverlay);

		expect(screen.getAllByRole("button")).toHaveLength(7);
		expect(screen.getByText("ข้อความว่าง")).toBeTruthy();
		expect(screen.getAllByText("QC!")).toHaveLength(6);
	});

	it("renders text overflow QC labels as production copy instead of raw issue codes", () => {
		installEditorGeometry();
		const layers = [textLayer(0)];
		editorStore.textLayers = layers;
		projectStore.__setProjectForTesting(project({
			pages: [page({
				textLayers: [{
					...layers[0],
					text: "คำแปลที่ยาวเกินกล่องข้อความเล็กมากและต้องเตือนให้ปรับ",
					w: 54,
					h: 20,
				}],
			})],
		}));

		render(QcRegionOverlay);

		expect(screen.getByText(/ข้อความอาจล้น/)).toBeTruthy();
		expect(screen.queryByText(/text overflow risk/i)).toBeNull();
	});

	it("collapses dense comment labels while keeping the selected comment readable", () => {
		installEditorGeometry();
		const comments = Array.from({ length: 7 }, (_, index) => comment(index));
		projectStore.__setProjectForTesting(project({ comments }));
		projectStore.selectProjectComment("comment-2");

		render(CommentRegionOverlay);

		expect(screen.getAllByRole("button")).toHaveLength(7);
		expect(screen.getByText("คอมเมนต์")).toBeTruthy();
		expect(screen.getAllByText("C")).toHaveLength(6);
	});

	it("hides unselected comment regions while AI review owns the canvas", () => {
		installEditorGeometry();
		const comments = [comment(1)];
		projectStore.__setProjectForTesting(project({
			comments,
			aiReviewMarkers: [aiMarker()],
		}));
		editorUiStore.setRightPanelMode("ai");

		const rendered = render(CommentRegionOverlay);

		expect(screen.queryByRole("button", { name: /เปิดคอมเมนต์/ })).toBeNull();

		rendered.unmount();
		projectStore.selectProjectComment("comment-1");
		render(CommentRegionOverlay);

		expect(screen.getByRole("button", { name: "เปิดคอมเมนต์ คอมเมนต์" })).toBeTruthy();
	});

	it("focuses the region of the affected layer when clicking a QC region issue", async () => {
		installEditorGeometry();
		const focusImageRegion = vi.fn();
		editorStore.editor.focusImageRegion = focusImageRegion;
		editorStore.editor.setTool = vi.fn();

		const layers = [textLayer(0)];
		editorStore.textLayers = layers;
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: layers })],
		}));

		render(QcRegionOverlay);

		const button = screen.getByRole("button", { name: /เปิดรายการตรวจ ข้อความว่าง/ });
		expect(button).toBeTruthy();

		const { fireEvent } = await import("@testing-library/svelte");
		await fireEvent.click(button);

		expect(focusImageRegion).toHaveBeenCalledWith({
			x: layers[0].x,
			y: layers[0].y,
			w: layers[0].w,
			h: layers[0].h,
		});
	});
});
