// Merge-at-creation (webtoon strips): `setup.pageTransform = { mode: "merge",
// perPage }` routes the chapter-create upload through /upload-transform as ONE
// stitched request (NOT the batched keep upload), builds ceil(N/perPage) pages
// named from the server's asset summaries, and honestly fails when the server
// returns a different page count than the transform implies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ProjectState } from "$lib/types.js";

const CREATED_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const EXISTING_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

vi.mock("$lib/api/client.ts", () => {
	class ApiError extends Error {
		readonly status: number;
		constructor(message: string, status: number) {
			super(message);
			this.name = "ApiError";
			this.status = status;
		}
	}
	return {
		ApiError,
		UPLOAD_TOO_LARGE_MESSAGE: "too large",
		isUploadTooLargeError: () => false,
		createProject: vi.fn(),
		deleteProject: vi.fn(),
		uploadImages: vi.fn(),
		uploadImagesTransformed: vi.fn(),
		loadProject: vi.fn(),
		listProjects: vi.fn(),
		saveProject: vi.fn(),
		submitAiJob: vi.fn(),
		getAiStatus: vi.fn(),
		cancelAiJob: vi.fn(),
		createAiReviewMarker: vi.fn(),
	};
});

vi.mock("$lib/stores/import-remap.svelte.ts", () => ({
	importRemapStore: { open: vi.fn() },
}));

function pageFile(name: string): File {
	return new File(["page-bytes"], name, { type: "image/png" });
}

function stubPostUploadTail(): void {
	const store = projectStore as unknown as Record<string, any>;
	for (const method of [
		"saveState",
		"loadPage",
		"loadVersions",
		"loadWorkflow",
		"resyncBaselineFromServerAfterCreate",
		"loadComments",
		"loadAiReviewMarkers",
		"loadReviewDecisions",
		"loadWorkspaceHub",
		"loadRecentProjects",
		"loadImageAssets",
		"saveBeforeProjectSwitch",
	]) {
		vi.spyOn(store, method).mockResolvedValue(undefined);
	}
}

function emptyProject(): ProjectState {
	return {
		projectId: EXISTING_PROJECT_ID,
		name: "Existing Empty",
		storyTitle: "Existing Story",
		createdAt: "2026-05-14T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	stubPostUploadTail();
	projectStore.project = null;
	vi.mocked(api.createProject).mockResolvedValue({ projectId: CREATED_PROJECT_ID } as any);
	vi.mocked(api.saveProject).mockResolvedValue({} as any);
});

afterEach(() => {
	projectStore.project = null;
});

describe("merge-at-creation", () => {
	it("routes the create upload through /upload-transform and builds merged pages", async () => {
		vi.mocked(api.uploadImagesTransformed).mockResolvedValue({
			imageIds: ["merged-1.png", "merged-2.png"],
			assets: [
				{ imageId: "merged-1.png", originalName: "merged-001.png" } as any,
				{ imageId: "merged-2.png", originalName: "merged-002.png" } as any,
			],
		} as any);

		await projectStore.loadFilesWithSetup(
			[pageFile("s1.png"), pageFile("s2.png"), pageFile("s3.png"), pageFile("s4.png")],
			null,
			{ projectName: "Webtoon Ch", storyTitle: "Webtoon Story", workspaceId: "ws-test", pageTransform: { mode: "merge", perPage: 2 } } as any,
		);

		// One transform request; the batched keep upload never fires for pages.
		expect(api.uploadImagesTransformed).toHaveBeenCalledTimes(1);
		const [projectId, files, mode, options] = vi.mocked(api.uploadImagesTransformed).mock.calls[0]!;
		expect(projectId).toBe(CREATED_PROJECT_ID);
		expect((files as File[]).map((file) => file.name)).toEqual(["s1.png", "s2.png", "s3.png", "s4.png"]);
		expect(mode).toBe("merge");
		expect(options).toEqual({ perPage: 2 });
		expect(api.uploadImages).not.toHaveBeenCalled();

		// 4 sources at 2:1 → 2 pages, provenance from the server asset names.
		expect(projectStore.project?.pages.map((page) => page.imageId)).toEqual(["merged-1.png", "merged-2.png"]);
		expect(projectStore.project?.pages.map((page) => page.originalName)).toEqual(["merged-001.png", "merged-002.png"]);
	});

	it("fails honestly when the server returns fewer merged pages than the transform implies", async () => {
		vi.mocked(api.uploadImagesTransformed).mockResolvedValue({
			imageIds: ["merged-1.png"],
			assets: [{ imageId: "merged-1.png", originalName: "merged-001.png" } as any],
		} as any);
		vi.mocked(api.deleteProject).mockResolvedValue(undefined as any);

		await projectStore.loadFilesWithSetup(
			[pageFile("s1.png"), pageFile("s2.png"), pageFile("s3.png"), pageFile("s4.png")],
			null,
			{ projectName: "Webtoon Ch", storyTitle: "Webtoon Story", workspaceId: "ws-test", pageTransform: { mode: "merge", perPage: 2 } } as any,
		);

		// 4 files at 2:1 expects 2 pages; 1 came back → create aborts, no project kept.
		expect(projectStore.project).toBeNull();
		expect(projectStore.statusMsg).toContain("1/2");
	});

	it("fill-existing-zero-page path also honors the merge transform", async () => {
		projectStore.project = emptyProject();
		vi.mocked(api.uploadImagesTransformed).mockResolvedValue({
			imageIds: ["merged-1.png"],
			assets: [{ imageId: "merged-1.png", originalName: "merged-001.png" } as any],
		} as any);

		await projectStore.loadFilesWithSetup(
			[pageFile("s1.png"), pageFile("s2.png")],
			null,
			{ workspaceId: "ws-test", pageTransform: { mode: "merge", perPage: 2 } } as any,
		);

		expect(api.uploadImagesTransformed).toHaveBeenCalledTimes(1);
		expect(vi.mocked(api.uploadImagesTransformed).mock.calls[0]![0]).toBe(EXISTING_PROJECT_ID);
		expect(api.uploadImages).not.toHaveBeenCalled();
		expect(projectStore.project?.pages.map((page) => page.imageId)).toEqual(["merged-1.png"]);
		expect(projectStore.project?.pages[0]?.originalName).toBe("merged-001.png");
	});
});
