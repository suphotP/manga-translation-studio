import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ImageLayer, ProjectState } from "$lib/types.js";

const projectId = "11111111-1111-4111-8111-111111111111";

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId,
		name: "Brush source persistence",
		createdAt: "2026-05-19T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [
			{
				imageId: "page-1.webp",
				imageName: "page-1.webp",
				textLayers: [],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "layer-1",
		name: "Cleaned layer",
		imageId: "brush-local.png",
		imageName: "brush-local.png",
		x: 10,
		y: 20,
		w: 100,
		h: 80,
		rotation: 0,
		opacity: 1,
		index: 0,
		role: "overlay",
		...overrides,
	};
}

function imageAsset(overrides: Partial<api.ProjectImageAssetSummary> = {}): api.ProjectImageAssetSummary {
	return {
		assetId: "replacement.webp",
		imageId: "replacement.webp",
		originalName: "replacement.webp",
		mimeType: "image/webp",
		sizeBytes: 1024,
		sha256: "sha",
		storageDriver: "local",
		storageKey: `projects/${projectId}/images/replacement.webp`,
		width: 320,
		height: 200,
		storageStatus: "released",
		moderationStatus: "passed",
		derivativeCount: 0,
		createdAt: "2026-05-19T00:00:00.000Z",
		updatedAt: "2026-05-19T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	projectStore.__resetForTesting();
});

// The legacy full-page-bake clean path (persistImageLayerSourceChange /
// persistCurrentPageBackgroundEdit) was removed for issue #6 — manual cleaning now
// flows entirely through the non-destructive imageEditLayers rails. The tests below
// cover the SHARED machinery that survived: the save-gate that drains pending brush
// commits, the asset-replace flow, the image-id reference check, and transform-as-data.
describe("save gate drains pending brush commits before persisting", () => {
	it("waits for pending brush commits before syncing and saving the current page", async () => {
		const editorLayer = imageLayer({ imageId: "persisted-after-brush.png", imageName: "persisted-after-brush.png" });
		const originalProject = project({
			pages: [{
				imageId: "page-1.webp",
				imageName: "page-1.webp",
				textLayers: [],
				imageLayers: [imageLayer({ imageId: "before-brush.png", imageName: "before-brush.png" })],
				pendingAiJobs: [],
				coverRect: null,
			}],
		});
		projectStore.__setProjectForTesting(originalProject);
		const calls: string[] = [];
		let resolveCommit!: () => void;
		const pendingCommit = new Promise<void>((resolve) => {
			resolveCommit = resolve;
		});
		const editor = {
			hasPendingBrushCommit: vi.fn(() => true),
			waitForPendingBrushCommit: vi.fn(async () => {
				calls.push("wait-start");
				await pendingCommit;
				calls.push("wait-end");
			}),
			getAllTextLayers: vi.fn(() => {
				calls.push("sync-text");
				return [];
			}),
			getAllImageLayers: vi.fn(() => {
				calls.push("sync-image");
				return [editorLayer];
			}),
		};
		vi.spyOn(api, "loadProject").mockImplementation(async () => originalProject);
		vi.spyOn(api, "saveProject").mockImplementation(async () => {
			calls.push("save");
		});
		vi.spyOn(api, "getProjectVersions").mockResolvedValue({ versions: [] });

		const savePromise = projectStore.saveCurrentPage(editor);
		await Promise.resolve();

		expect(calls).toEqual(["wait-start"]);
		expect(projectStore.project?.pages[0].imageLayers?.[0]?.imageId).toBe("before-brush.png");

		resolveCommit();
		await savePromise;

		expect(calls).toEqual(["wait-start", "wait-end", "sync-text", "sync-image", "save"]);
		expect(projectStore.project?.pages[0].imageLayers?.[0]?.imageId).toBe("persisted-after-brush.png");
	});

	it("waits for pending AI-mask background brush commits before saving page edits", async () => {
		const originalProject = project();
		projectStore.__setProjectForTesting(originalProject);
		const calls: string[] = [];
		let resolveCommit!: () => void;
		const pendingCommit = new Promise<void>((resolve) => {
			resolveCommit = resolve;
		});
		const editor = {
			hasPendingBrushCommit: vi.fn(() => true),
			waitForPendingBrushCommit: vi.fn(async () => {
				calls.push("wait-start");
				await pendingCommit;
				projectStore.project!.pages[0].edits = { imageId: "persisted-ai-mask.png" };
				calls.push("wait-end");
			}),
			getAllTextLayers: vi.fn(() => {
				calls.push("sync-text");
				return [];
			}),
			getAllImageLayers: vi.fn(() => {
				calls.push("sync-image");
				return [];
			}),
		};
		vi.spyOn(api, "loadProject").mockImplementation(async () => originalProject);
		vi.spyOn(api, "saveProject").mockImplementation(async (_projectId, payload) => {
			expect(payload.pages[0].edits?.imageId).toBe("persisted-ai-mask.png");
			calls.push("save");
		});
		vi.spyOn(api, "getProjectVersions").mockResolvedValue({ versions: [] });

		const savePromise = projectStore.saveCurrentPage(editor);
		await Promise.resolve();

		expect(calls).toEqual(["wait-start"]);
		expect(projectStore.project?.pages[0].edits).toBeUndefined();

		resolveCommit();
		await savePromise;

		expect(calls).toEqual(["wait-start", "wait-end", "sync-text", "sync-image", "save"]);
		expect(projectStore.project?.pages[0].edits).toEqual({ imageId: "persisted-ai-mask.png" });
	});

	it("blocks save after a brush commit failure even when no commit is pending", async () => {
		projectStore.__setProjectForTesting(project());
		const editor = {
			hasPendingBrushCommit: vi.fn(() => false),
			hasBrushCommitError: vi.fn(() => true),
			waitForPendingBrushCommit: vi.fn(async () => {
				throw new Error("quota");
			}),
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
		};
		const saveProject = vi.spyOn(api, "saveProject");

		await projectStore.saveCurrentPage(editor);

		expect(editor.waitForPendingBrushCommit).toHaveBeenCalledTimes(1);
		expect(saveProject).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("บันทึกไม่สำเร็จ: รอยแปรงยังไม่ถูกบันทึก (quota)");
	});
});

describe("image layer source replacement + reference tracking", () => {
	it("replaces a selected image layer source from an existing asset while preserving layer geometry", async () => {
		const layer = imageLayer({
			name: "Phone UI",
			imageId: "old.webp",
			imageName: "old.webp",
			originalName: "old.webp",
			x: 40,
			y: 60,
			w: 280,
			h: 160,
			rotation: 12,
			opacity: 0.72,
			flipX: true,
			flipY: true,
			blendMode: "multiply",
			restoreImageId: "old-original.webp",
		});
		projectStore.__setProjectForTesting(project({
			pages: [{
				imageId: "page-1.webp",
				imageName: "page-1.webp",
				textLayers: [],
				imageLayers: [layer],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}));
		projectStore.imageAssets = [imageAsset()];
		let editorLayer = layer;
		const editor = {
			replaceImageLayerSourceWithHistory: vi.fn(async (_id: string, nextLayer: ImageLayer) => {
				editorLayer = nextLayer;
				return nextLayer;
			}),
			getAllImageLayers: vi.fn(() => [editorLayer]),
		};

		const replaced = await projectStore.replaceImageLayerSourceFromAsset("replacement.webp", "layer-1", editor);

		expect(editor.replaceImageLayerSourceWithHistory).toHaveBeenCalledWith(
			"layer-1",
			expect.objectContaining({
				id: "layer-1",
				name: "Phone UI",
				imageId: "replacement.webp",
				imageName: "replacement.webp",
				originalName: "replacement.webp",
				sourceW: 320,
				sourceH: 200,
				x: 40,
				y: 60,
				w: 280,
				h: 160,
				rotation: 12,
				opacity: 0.72,
				flipX: true,
				flipY: true,
				blendMode: "multiply",
				restoreImageId: undefined,
			}),
			"/api/images/11111111-1111-4111-8111-111111111111/replacement.webp",
		);
		expect(replaced?.imageId).toBe("replacement.webp");
		expect(projectStore.project?.pages[0].imageLayers?.[0]).toMatchObject({
			id: "layer-1",
			imageId: "replacement.webp",
			sourceW: 320,
			sourceH: 200,
			x: 40,
			y: 60,
			w: 280,
			h: 160,
			flipX: true,
			flipY: true,
			blendMode: "multiply",
		});
		expect(projectStore.statusMsg).toBe("แทนที่รูปในเลเยอร์แล้ว: replacement.webp");
	});

	it("treats edit-layer sourceImageId AND mask asset as live references", () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				{
					imageId: "page-1.webp",
					imageName: "page-1.webp",
					textLayers: [],
					imageLayers: [],
					pendingAiJobs: [],
					coverRect: null,
					imageEditLayers: [
						{
							id: "edit-1",
							kind: "bubble-clean",
							target: "page-background",
							sourceImageId: "src-edit-base.png",
							visible: true,
							opacity: 1,
							blendMode: "normal",
							index: 0,
							bbox: { x: 10, y: 10, w: 20, h: 20 },
							payload: {
								type: "fill-mask",
								maskAssetId: "mask-roi.png",
								maskEncoding: "png-alpha",
								fill: { r: 255, g: 255, b: 255, a: 255 },
							},
							tool: { id: "bubble-clean" },
							createdAt: "2026-05-19T00:00:00.000Z",
						},
					],
				},
			],
		} as unknown as Partial<ProjectState>));

		const isReferenced = (id: string): boolean =>
			(projectStore as unknown as { isImageIdReferenced(id: string): boolean }).isImageIdReferenced(id);

		// The edit-layer base source id is live (the fix codex flagged as missing).
		expect(isReferenced("src-edit-base.png")).toBe(true);
		// The mask ROI asset is live (P1-b base case).
		expect(isReferenced("mask-roi.png")).toBe(true);
		// The page's own image id is still live.
		expect(isReferenced("page-1.webp")).toBe(true);
		// An unrelated id is NOT referenced.
		expect(isReferenced("totally-unrelated.png")).toBe(false);
	});
});

// P1 storage-bloat ROOT FIX — a pure MOVE / SCALE / ROTATE of an image layer must
// persist as TRANSFORM DATA on the layer (x/y/w/h/rotation/opacity/flip) reusing
// the SAME imageId. It must NEVER re-encode + re-upload a new image asset (the
// "ขยับนิดเดียวก็บวม" bloat). captureEditorImageLayers is the persist entry the
// editor calls on every transform via onImageLayersChange.
describe("image-layer transform persists as data, not a new image asset", () => {
	it("a move/scale/rotate writes transform data to project state and uploads NOTHING", async () => {
		const layer = imageLayer({
			imageId: "asset-abc.webp",
			imageName: "asset-abc.webp",
			x: 10,
			y: 20,
			w: 100,
			h: 80,
			rotation: 0,
		});
		projectStore.__setProjectForTesting(project({
			pages: [{
				imageId: "page-1.webp",
				imageName: "page-1.webp",
				textLayers: [],
				imageLayers: [layer],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}));
		const uploadImages = vi.spyOn(api, "uploadImages");
		const uploadImagesTransformed = vi.spyOn(api, "uploadImagesTransformed");
		const del = vi.spyOn(api, "deleteWorkspaceStorageAsset");

		// Editor serializes the dragged/scaled/rotated layer: NEW geometry, SAME imageId.
		const moved: ImageLayer = {
			...layer,
			x: 250,
			y: 410,
			w: 180,
			h: 144,
			rotation: 37,
			opacity: 0.5,
			flipX: true,
		};
		projectStore.captureEditorImageLayers([moved]);

		// ZERO image bytes are produced or uploaded for a transform.
		expect(uploadImages).not.toHaveBeenCalled();
		expect(uploadImagesTransformed).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();

		// The transform is stored as DATA on the layer, reusing the same asset id.
		const persisted = projectStore.project?.pages[0].imageLayers?.[0];
		expect(persisted?.imageId).toBe("asset-abc.webp");
		expect(persisted).toMatchObject({
			x: 250,
			y: 410,
			w: 180,
			h: 144,
			rotation: 37,
			opacity: 0.5,
			flipX: true,
		});
		// The edit marks the page dirty (so it persists on the next /save) but the
		// underlying image asset is untouched — no new blob, no GC churn.
		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});
});
