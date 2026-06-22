import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import type { ProjectImageAssetSummary } from "$lib/api/client.ts";
import { exportPagesToZip } from "$lib/project/page-export.js";
import { formatExportRunMessage } from "$lib/project/export-runs.js";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ImageEditLayer, ImageLayer, Page, ProjectState, TextLayer } from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {
		readonly status: number;
		readonly statusText: string;
		readonly body?: unknown;

		constructor(message: string, details: { status: number; statusText: string; body?: unknown }) {
			super(message);
			this.name = "ApiError";
			this.status = details.status;
			this.statusText = details.statusText;
			this.body = details.body;
		}
	},
	loadProject: vi.fn(),
	saveProject: vi.fn(),
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
	isApiAssetUrl: vi.fn((url: string) => typeof url === "string" && url.startsWith("/api/")),
	// Default: the page asset is `passed`, so the server mints an export token → the
	// fail-closed export gate passes and the test reaches the editor render failure.
	signedAssetUrl: vi.fn((url: string) => Promise.resolve(`${url}?assetToken=mock`)),
	ExportAssetNotAuthorizedError: class ExportAssetNotAuthorizedError extends Error {
		readonly projectId: string;
		readonly imageId: string;
		constructor(projectId: string, imageId: string) {
			super(`Asset ${projectId}/${imageId} is not authorized for export`);
			this.name = "ExportAssetNotAuthorizedError";
			this.projectId = projectId;
			this.imageId = imageId;
		}
	},
	fetchAuthedObjectUrlWithBlob: vi.fn(() =>
		Promise.resolve({ objectUrl: "blob:mock-export", blob: new Blob([new Uint8Array(1024)]) })),
	uploadExportArtifact: vi.fn(),
	recordExportUsage: vi.fn(() => Promise.resolve({ ok: true, eventId: "evt-mock", usage: {} })),
}));

vi.mock("$lib/project/page-export.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/project/page-export.js")>();
	return {
		...actual,
		exportPagesToZip: vi.fn(),
	};
});

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

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "text-layer-1",
		text: "พร้อม Export",
		x: 10,
		y: 20,
		w: 160,
		h: 48,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "image-layer-1",
		imageId: "image-layer-1.webp",
		imageName: "image-layer-1.webp",
		x: 10,
		y: 20,
		w: 160,
		h: 80,
		rotation: 0,
		opacity: 1,
		index: 0,
		role: "overlay",
		...overrides,
	};
}

function imageAsset(overrides: Partial<ProjectImageAssetSummary> = {}): ProjectImageAssetSummary {
	return {
		assetId: "page-1.webp",
		imageId: "page-1.webp",
		originalName: "page-1.webp",
		mimeType: "image/webp",
		sizeBytes: 1024,
		sha256: "hash",
		storageDriver: "local",
		storageKey: "projects/project-1/images/page-1.webp",
		width: 900,
		height: 1350,
		storageStatus: "released",
		moderationStatus: "passed",
		derivativeCount: 0,
		createdAt: "2026-05-25T00:00:00.000Z",
		updatedAt: "2026-05-25T00:00:00.000Z",
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "flow208-project",
		name: "Export Failure Feedback",
		createdAt: "2026-05-25T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [page()],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

beforeEach(() => {
	projectStore.__resetForTesting();
	vi.clearAllMocks();
	vi.mocked(api.loadProject).mockImplementation(async () => JSON.parse(JSON.stringify(projectStore.project)));
	vi.mocked(api.saveProject).mockResolvedValue(undefined);
});

describe("ProjectStore export failure feedback", () => {
	it("names the current page and safe retry action when a single-page editor export fails", async () => {
		projectStore.__setProjectForTesting(project({
			currentPage: 1,
			pages: [
				page({ imageId: "page-1.webp", imageName: "page-1.webp" }),
				page({ imageId: "page-2.webp", imageName: "page-2.webp" }),
			],
		}));
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			exportMergedImageDataUrl: vi.fn().mockRejectedValue(new Error("canvas tainted")),
		};

		await projectStore.exportPage(editor);

		expect(projectStore.statusMsg).toBe(
			"Export หน้า 2 ไม่สำเร็จ: canvas tainted; งานเดิมยังอยู่ ตรวจหน้านี้หรือบันทึกงานแล้วลอง Export อีกครั้ง",
		);
		expect(projectStore.exportRuns[0]).toMatchObject({
			kind: "single-page",
			status: "error",
			pageIndexes: [1],
			message: projectStore.statusMsg,
			error: "หน้า 2 - canvas tainted; งานเดิมยังอยู่ ตรวจหน้านี้หรือบันทึกงานแล้วลอง Export อีกครั้ง",
		});
		expect(formatExportRunMessage(projectStore.exportRuns[0])).toBe(
			"Export ไม่สำเร็จ: หน้า 2 - canvas tainted; งานเดิมยังอยู่ ตรวจหน้านี้หรือบันทึกงานแล้วลอง Export อีกครั้ง",
		);
	});

	it("keeps batch failure context for the next failed page and completed progress", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ imageId: "page-1.webp", imageName: "page-1.webp" }),
				page({ imageId: "page-2.webp", imageName: "page-2.webp" }),
				page({ imageId: "page-3.webp", imageName: "page-3.webp" }),
			],
		}));
		projectStore.project!.pages[0].textLayers = [textLayer({ id: "text-layer-1" })];
		projectStore.project!.pages[1].textLayers = [textLayer({ id: "text-layer-2" })];
		projectStore.project!.pages[2].textLayers = [textLayer({ id: "text-layer-3" })];
		vi.mocked(exportPagesToZip).mockImplementation(async (_project, _pageIndexes, options) => {
			options.onProgress?.({
				completed: 1,
				total: 3,
				pageIndex: 0,
				pageNumber: 1,
				filename: "001_page-1_merged.png",
				phase: "rendering",
			});
			throw new Error("renderer lost layer image");
		});

		await projectStore.exportPageBatch([0, 1, 2]);

		expect(projectStore.batchExportStatus).toBe("error");
		expect(projectStore.batchExportProgress).toBeNull();
		expect(projectStore.batchExportMessage).toBe(
			"Export ไม่สำเร็จ: หน้า 2; ทำสำเร็จแล้ว 1/3 ในชุด หน้า 1-3 - renderer lost layer image; งานเดิมยังอยู่ ตรวจชุดหน้าที่ระบุหรือบันทึกงานแล้วลอง Export อีกครั้ง",
		);
		expect(projectStore.statusMsg).toBe(projectStore.batchExportMessage);
		expect(projectStore.exportRuns[0]).toMatchObject({
			kind: "batch-zip",
			status: "error",
			pageIndexes: [0, 1, 2],
			failedPageIndex: 1,
			failedPageNumber: 2,
			message: projectStore.batchExportMessage,
			error: "หน้า 2; ทำสำเร็จแล้ว 1/3 ในชุด หน้า 1-3 - renderer lost layer image; งานเดิมยังอยู่ ตรวจชุดหน้าที่ระบุหรือบันทึกงานแล้วลอง Export อีกครั้ง",
		});
		expect(formatExportRunMessage(projectStore.exportRuns[0])).toBe(
			"Export ไม่สำเร็จ: หน้า 2; ทำสำเร็จแล้ว 1/3 ในชุด หน้า 1-3 - renderer lost layer image; งานเดิมยังอยู่ ตรวจชุดหน้าที่ระบุหรือบันทึกงานแล้วลอง Export อีกครั้ง",
		);
	});

	it("blocks batch export before rendering when a visible image layer is missing its asset id", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({
					textLayers: [textLayer()],
					imageLayers: [
						imageLayer({ id: "credit-logo", imageId: "", imageName: "credit-logo.webp", role: "credit" }),
					],
				}),
			],
		}));

		await projectStore.exportPageBatch([0]);

		expect(exportPagesToZip).not.toHaveBeenCalled();
		expect(projectStore.batchExportStatus).toBe("error");
		expect(projectStore.batchExportMessage).toBe(
			"ส่งออกยังไม่พร้อม: 1 หน้าต้องเคลียร์ 1 รายการ",
		);
		expect(projectStore.statusMsg).toBe(projectStore.batchExportMessage);
	});

	it("blocks batch export before rendering when a visible image layer is missing from known inventory", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "project-inventory-missing",
			pages: [
				page({
					imageId: "page-1.webp",
					imageName: "page-1.webp",
					textLayers: [textLayer()],
					imageLayers: [
						imageLayer({ id: "credit-logo", imageId: "missing-credit-logo.webp", imageName: "credit-logo.webp", role: "credit" }),
					],
				}),
			],
		}));
		projectStore.imageAssets = [imageAsset({ imageId: "page-1.webp", assetId: "page-1.webp" })];
		projectStore.imageAssetsProjectId = "project-inventory-missing";

		await projectStore.exportPageBatch([0]);

		expect(exportPagesToZip).not.toHaveBeenCalled();
		expect(projectStore.batchExportStatus).toBe("error");
		expect(projectStore.batchExportMessage).toBe(
			"ส่งออกยังไม่พร้อม: 1 หน้าต้องเคลียร์ 1 รายการ",
		);
		expect(projectStore.statusMsg).toBe(projectStore.batchExportMessage);
	});

	// OPTION A invariant: the user-facing chapter export delivers, and persists as
	// the durable artifact, the EXACT client-side Fabric-rendered ZIP produced by
	// exportPagesToZip (page-export.ts) — never a server-side SVG re-render. The
	// download handed to the user and the artifact uploaded to the server must be
	// the SAME blob, and metering must measure that blob's real byte size.
	it("delivers and persists the client Fabric ZIP verbatim — no server SVG re-render", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "flow208-project",
			name: "Fabric Export Chapter",
			pages: [
				page({ imageId: "page-1.webp", imageName: "page-1.webp", textLayers: [textLayer({ id: "t-1" })] }),
			],
		}));

		// The exact bytes the client Fabric renderer would build + download.
		const fabricZipBlob = new Blob(["client-fabric-zip-bytes"], { type: "application/zip" });
		vi.mocked(exportPagesToZip).mockResolvedValue({
			zipBlob: fabricZipBlob,
			filename: "Fabric-Export-Chapter_1p.zip",
			manifest: {
				projectId: "flow208-project",
				projectName: "Fabric Export Chapter",
				exportedAt: "2026-06-07T00:00:00.000Z",
				pageCount: 1,
				requestedPageCount: 1,
				pages: [],
				skippedPages: [],
			},
			exportedPages: [
				{
					pageIndex: 0,
					pageNumber: 1,
					imageId: "page-1.webp",
					sourceName: "page-1.webp",
					baseName: "page-1",
					filename: "001_page-1_merged.png",
					layerCount: 1,
					width: 900,
					height: 1350,
					renderMode: "full",
					layers: [],
				},
			],
			skippedPages: [],
			sourceOnlyPages: [],
		});
		vi.mocked(api.uploadExportArtifact).mockImplementation(async (_projectId, runId, filename, artifact) => ({
			artifact: {
				exportId: `${runId}.zip`,
				storageDriver: "local",
				storageKey: `projects/flow208-project/exports/${runId}.zip`,
				filename,
				mimeType: "application/zip",
				// The server measures the bytes IT received — proving the delivered
				// Fabric blob is exactly what becomes the durable artifact.
				sizeBytes: artifact.size,
				createdAt: "2026-06-07T00:00:00.000Z",
			},
		}));

		const downloadBlob = vi
			.spyOn(projectStore as unknown as { downloadBlob: (blob: Blob, filename: string) => void }, "downloadBlob")
			.mockImplementation(() => {});

		await projectStore.exportPageBatch([0]);

		expect(projectStore.batchExportStatus).toBe("done");
		// 1. The blob delivered to the user is the client Fabric ZIP (same object).
		expect(downloadBlob).toHaveBeenCalledWith(fabricZipBlob, "Fabric-Export-Chapter_1p.zip");
		// 2. The durable server artifact is uploaded from that SAME Fabric ZIP blob —
		//    the server never re-renders text via its SVG export pipeline.
		expect(api.uploadExportArtifact).toHaveBeenCalledTimes(1);
		const [, , uploadedFilename, uploadedBlob] = vi.mocked(api.uploadExportArtifact).mock.calls[0];
		expect(uploadedBlob).toBe(fabricZipBlob);
		expect(uploadedFilename).toBe("Fabric-Export-Chapter_1p.zip");
		// 3. Metering measures the real Fabric ZIP byte size (bytes/quota accounting).
		expect(api.recordExportUsage).toHaveBeenCalledTimes(1);
		const meteringPayload = vi.mocked(api.recordExportUsage).mock.calls[0][1] as { bytes: number };
		expect(meteringPayload.bytes).toBe(fabricZipBlob.size);

		downloadBlob.mockRestore();
	});
});

describe("ProjectStore live single-page export gates EVERY rendered asset (codex P1-1)", () => {
	// A `signedAssetUrl` that mints a token for `passed` asset ids and FAILS CLOSED
	// (returns the URL unchanged) for the listed non-`passed` ids — exactly the
	// server's behavior (an `export` token is only issued for a `passed` asset).
	function mockExportAuthDenies(deniedImageIds: string[]): void {
		const denied = new Set(deniedImageIds);
		vi.mocked(api.signedAssetUrl).mockImplementation((url: string, _projectId, imageId) =>
			Promise.resolve(denied.has(imageId) ? url : `${url}?assetToken=mock`));
	}

	it("fails closed (no download, no bytes) when a VISIBLE image LAYER is needs_review even though the background is passed", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({
					imageId: "page-1.webp",
					imageName: "page-1.webp",
					imageLayers: [
						imageLayer({ id: "overlay-1", imageId: "needs-review-layer.webp", imageName: "needs-review-layer.webp" }),
					],
				}),
			],
		}));
		// Background is export-ready; the overlay layer is NOT (needs_review).
		mockExportAuthDenies(["needs-review-layer.webp"]);

		const exportMergedImageDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
		// The real editor's getAllImageLayers() returns the LIVE layers (incl. a
		// freshly-added one). syncEditorLayers() captures these onto page.imageLayers
		// BEFORE the gate runs, so the gate sees the final layer set.
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => projectStore.project!.pages[0].imageLayers ?? []),
			exportMergedImageDataUrl,
		};
		const downloadUrl = vi
			.spyOn(projectStore as unknown as { downloadUrl: (url: string, filename: string) => void }, "downloadUrl")
			.mockImplementation(() => {});

		await projectStore.exportPage(editor);

		// FAIL CLOSED: the non-passed layer must block the export BEFORE rendering bytes
		// or triggering a download.
		expect(exportMergedImageDataUrl).not.toHaveBeenCalled();
		expect(downloadUrl).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toContain("Export หน้า 1 ไม่สำเร็จ");
		expect(projectStore.exportRuns[0]).toMatchObject({ kind: "single-page", status: "error", pageIndexes: [0] });

		downloadUrl.mockRestore();
	});

	it("fails closed when a VISIBLE non-destructive edit-layer mask is needs_review", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({
					imageId: "page-1.webp",
					imageName: "page-1.webp",
					imageEditLayers: [
						{
							id: "edit-1",
							kind: "bubble-clean",
							target: "page-background",
							visible: true,
							opacity: 1,
							sourceImageId: "page-1.webp",
							bbox: { x: 0, y: 0, w: 32, h: 32 },
							payload: {
								type: "fill-mask",
								maskAssetId: "needs-review-mask.webp",
								maskEncoding: "png-alpha",
								fill: { r: 255, g: 255, b: 255, a: 255 },
							},
							index: 0,
							tool: { id: "bubble-clean" },
							createdAt: "2026-06-07T00:00:00.000Z",
						},
					],
				}),
			],
		}));
		mockExportAuthDenies(["needs-review-mask.webp"]);

		const exportMergedImageDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => []),
			exportMergedImageDataUrl,
		};
		const downloadUrl = vi
			.spyOn(projectStore as unknown as { downloadUrl: (url: string, filename: string) => void }, "downloadUrl")
			.mockImplementation(() => {});

		await projectStore.exportPage(editor);

		expect(exportMergedImageDataUrl).not.toHaveBeenCalled();
		expect(downloadUrl).not.toHaveBeenCalled();
		expect(projectStore.exportRuns[0]).toMatchObject({ kind: "single-page", status: "error", pageIndexes: [0] });

		downloadUrl.mockRestore();
	});

	// #420 test-depth: the gate composites the SAME asset the export paints for EVERY
	// composable edit-layer kind. fill-mask is covered above; assert patch / healing /
	// clone also FAIL CLOSED when their composited asset (patchAssetId for `patch`,
	// realizedPatchAssetId for `healing`/`clone`) is non-passed. The gate reads the
	// per-kind asset id (project.svelte.ts assertCurrentPageExportAuthorized).
	const compositedEditLayerCases = [
		{
			type: "patch" as const,
			assetField: "patchAssetId" as const,
			assetId: "needs-review-patch.webp",
			kind: "patch-inpaint",
			extraPayload: { patchEncoding: "png-rgba" } as Record<string, unknown>,
		},
		{
			type: "healing" as const,
			assetField: "realizedPatchAssetId" as const,
			assetId: "needs-review-healing.webp",
			kind: "spot-heal",
			extraPayload: { maskAssetId: "needs-review-healing.webp" } as Record<string, unknown>,
		},
		{
			type: "clone" as const,
			assetField: "realizedPatchAssetId" as const,
			assetId: "needs-review-clone.webp",
			kind: "clone-stamp",
			extraPayload: { maskAssetId: "needs-review-clone.webp" } as Record<string, unknown>,
		},
	];

	for (const testCase of compositedEditLayerCases) {
		it(`fails closed when a VISIBLE ${testCase.type} edit-layer's composited asset is non-passed`, async () => {
			projectStore.__setProjectForTesting(project({
				pages: [
					page({
						imageId: "page-1.webp",
						imageName: "page-1.webp",
						imageEditLayers: [
							{
								id: `edit-${testCase.type}`,
								kind: testCase.kind,
								target: "page-background",
								visible: true,
								opacity: 1,
								sourceImageId: "page-1.webp",
								bbox: { x: 0, y: 0, w: 32, h: 32 },
								payload: {
									type: testCase.type,
									[testCase.assetField]: testCase.assetId,
									...testCase.extraPayload,
								},
								index: 0,
								tool: { id: testCase.kind },
								createdAt: "2026-06-07T00:00:00.000Z",
							} as unknown as ImageEditLayer,
						],
					}),
				],
			}));
			// The background is export-ready; only the edit-layer's composited asset is denied.
			mockExportAuthDenies([testCase.assetId]);

			const exportMergedImageDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
			const editor = {
				getAllTextLayers: vi.fn(() => []),
				getAllImageLayers: vi.fn(() => []),
				exportMergedImageDataUrl,
			};
			const downloadUrl = vi
				.spyOn(projectStore as unknown as { downloadUrl: (url: string, filename: string) => void }, "downloadUrl")
				.mockImplementation(() => {});

			await projectStore.exportPage(editor);

			// FAIL CLOSED: the non-passed composited asset blocks export BEFORE rendering
			// bytes or triggering a download.
			expect(exportMergedImageDataUrl).not.toHaveBeenCalled();
			expect(downloadUrl).not.toHaveBeenCalled();
			expect(projectStore.statusMsg).toContain("Export หน้า 1 ไม่สำเร็จ");
			expect(projectStore.exportRuns[0]).toMatchObject({ kind: "single-page", status: "error", pageIndexes: [0] });

			downloadUrl.mockRestore();
		});
	}

	it("renders + downloads when the background AND every visible layer are passed", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({
					imageId: "page-1.webp",
					imageName: "page-1.webp",
					imageLayers: [
						imageLayer({ id: "overlay-1", imageId: "passed-layer.webp", imageName: "passed-layer.webp" }),
						// A HIDDEN non-passed layer is NOT rendered, so it must NOT block export.
						imageLayer({ id: "overlay-2", imageId: "needs-review-hidden.webp", imageName: "needs-review-hidden.webp", visible: false }),
					],
				}),
			],
		}));
		// Everything visible is passed; only the hidden layer would be denied.
		mockExportAuthDenies(["needs-review-hidden.webp"]);

		const exportMergedImageDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
		const editor = {
			getAllTextLayers: vi.fn(() => []),
			getAllImageLayers: vi.fn(() => projectStore.project!.pages[0].imageLayers ?? []),
			exportMergedImageDataUrl,
		};
		const downloadUrl = vi
			.spyOn(projectStore as unknown as { downloadUrl: (url: string, filename: string) => void }, "downloadUrl")
			.mockImplementation(() => {});

		await projectStore.exportPage(editor);

		expect(exportMergedImageDataUrl).toHaveBeenCalledTimes(1);
		expect(downloadUrl).toHaveBeenCalledTimes(1);
		expect(projectStore.statusMsg).toContain("Export หน้าเดียวสำเร็จ");

		downloadUrl.mockRestore();
	});
});
