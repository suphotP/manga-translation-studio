import { describe, expect, it } from "vitest";
import { buildProjectQcReport } from "$lib/project/qc-checks.js";
import type { ImageLayer, ProjectState } from "$lib/types.js";

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Chapter",
		createdAt: "2026-05-12T00:00:00.000Z",
		pages: [],
		currentPage: 0,
		targetLang: "th",
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "image-layer-1",
		imageId: "asset-1",
		imageName: "asset-1.webp",
		x: 20,
		y: 20,
		w: 200,
		h: 120,
		rotation: 0,
		opacity: 1,
		index: 0,
		role: "overlay",
		...overrides,
	};
}

describe("buildProjectQcReport", () => {
	it("reports empty projects and pages without text", () => {
		const empty = buildProjectQcReport(makeProject());
		expect(empty.warningCount).toBe(1);
		expect(empty.issues[0].code).toBe("project_empty");

		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}));

		expect(report.warningCount).toBe(1);
		expect(report.issues[0].code).toBe("page_without_text");
	});

	it("detects blocking layer and AI job issues", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-1",
					text: "",
					x: 0,
					y: 0,
					w: 0,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [{ jobId: "job-1", crop: { x: 0, y: 0, w: 10, h: 10 }, status: "error" }],
				coverRect: null,
			}],
		}));

		expect(report.errorCount).toBe(3);
		expect(report.issues.map((issue) => issue.code)).toEqual([
			"empty_text_layer",
			"invalid_text_box",
			"ai_job_failed",
		]);
	});

	it("blocks export readiness for visible image layers without a source asset", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "text-1",
					text: "Ready",
					x: 10,
					y: 10,
					w: 120,
					h: 40,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				imageLayers: [
					imageLayer({ id: "visible-missing-logo", imageId: "", imageName: "credit-logo.webp" }),
					imageLayer({ id: "hidden-draft-logo", imageId: "", imageName: "draft-logo.webp", visible: false }),
				],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}));

		expect(report.errorCount).toBe(1);
		expect(report.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({
				code: "image_layer_missing_asset",
				severity: "error",
				pageIndex: 0,
				layerId: "visible-missing-logo",
				layerKind: "image",
				messageCode: "image_layer_missing_asset",
				messageValues: { page: 1, layerName: "credit-logo.webp" },
			}),
		]));
		expect(report.issues.some((issue) => issue.layerId === "hidden-draft-logo")).toBe(false);
	});

	it("blocks visible image layers that are missing from a known asset inventory", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "page-asset",
				imageName: "page-asset.webp",
				textLayers: [{
					id: "text-1",
					text: "Ready",
					x: 10,
					y: 10,
					w: 120,
					h: 40,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				imageLayers: [
					imageLayer({ id: "stale-credit-logo", imageId: "missing-credit-logo", imageName: "credit-logo.webp" }),
				],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [], [], [], {
			assets: [{ imageId: "page-asset", width: 1000, height: 800 }],
			assetInventoryKnown: true,
		});

		expect(report.errorCount).toBe(1);
		expect(report.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({
				code: "image_layer_asset_missing_from_inventory",
				severity: "error",
				pageIndex: 0,
				layerId: "stale-credit-logo",
				layerKind: "image",
				messageCode: "image_layer_asset_missing_from_inventory",
				messageValues: { page: 1, layerName: "credit-logo.webp" },
			}),
		]));
	});

	it("does not false-block local image layer assets while asset inventory is known", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "page-asset",
				imageName: "page-asset.webp",
				textLayers: [{
					id: "text-1",
					text: "Ready",
					x: 10,
					y: 10,
					w: 120,
					h: 40,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				imageLayers: [
					imageLayer({ id: "local-credit-logo", imageId: "local-credit-logo", imageName: "credit-logo.webp" }),
				],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [], [], [], {
			assets: [{ imageId: "page-asset", width: 1000, height: 800 }],
			assetInventoryKnown: true,
			localImageIds: ["local-credit-logo"],
		});

		expect(report.issues.some((issue) => issue.code === "image_layer_asset_missing_from_inventory")).toBe(false);
		expect(report.errorCount).toBe(0);
	});

	it("warns for unchanged source text and low confidence draft layers", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-1",
					text: "Hello",
					sourceText: "Hello",
					sourceCategory: "dialogue",
					confidence: 0.4,
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}));

		expect(report.warningCount).toBe(2);
		expect(report.issues.map((issue) => issue.code)).toEqual([
			"unchanged_source_text",
			"low_confidence_layer",
		]);
	});

	it("keeps QC issue ids unique when imported data has duplicate layer ids", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [
					{
						id: "duplicate-layer",
						text: "Hello",
						sourceText: "Hello",
						sourceCategory: "dialogue",
						x: 0,
						y: 0,
						w: 100,
						h: 50,
						rotation: 0,
						fontSize: 24,
						alignment: "center",
						index: 0,
					},
					{
						id: "duplicate-layer",
						text: "Hello",
						sourceText: "Hello",
						sourceCategory: "dialogue",
						x: 20,
						y: 80,
						w: 100,
						h: 50,
						rotation: 0,
						fontSize: 24,
						alignment: "center",
						index: 1,
					},
				],
				imageLayers: [
					imageLayer({ id: "duplicate-image-layer", x: 1200, y: 20 }),
					imageLayer({ id: "duplicate-image-layer", x: 1300, y: 40 }),
				],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [], [], [], {
			assets: [{ imageId: "img-1", width: 1000, height: 800 }],
		});

		const ids = report.issues.map((issue) => issue.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(report.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "page-0-text-layer-duplicate-layer-duplicate-id",
				code: "duplicate_layer_id",
				duplicateLayerKind: "text",
				duplicateLayerCount: 2,
			}),
			expect.objectContaining({
				id: "page-0-image-layer-duplicate-image-layer-duplicate-id",
				code: "duplicate_layer_id",
				duplicateLayerKind: "image",
				duplicateLayerCount: 2,
			}),
		]));
		expect(ids).toContain("page-0-layer-duplicate-layer-unchanged");
		expect(ids).toContain("page-0-layer-duplicate-layer-duplicate-1-unchanged");
		expect(ids).toContain("page-0-image-layer-duplicate-image-layer-outside-page");
		expect(ids).toContain("page-0-image-layer-duplicate-image-layer-duplicate-1-outside-page");
	});

	it("warns when translated text is likely to overflow its layer box", () => {
		const report = buildProjectQcReport(makeProject({
			targetLang: "en",
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-1",
					text: "This translated dialogue is much too long for this tiny bubble and should be resized.",
					x: 0,
					y: 0,
					w: 95,
					h: 36,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}));

		expect(report.warningCount).toBe(1);
		expect(report.issues[0]).toMatchObject({
			code: "text_overflow_risk",
			layerId: "layer-1",
			layerKind: "text",
		});
	});

	it("warns when a translatable layer still looks like non-target source script", () => {
		const report = buildProjectQcReport(makeProject({
			targetLang: "en",
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-1",
					text: "まだ翻訳されていない台詞",
					sourceCategory: "dialogue",
					x: 0,
					y: 0,
					w: 240,
					h: 80,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}));

		expect(report.warningCount).toBe(1);
		expect(report.issues[0]).toMatchObject({
			code: "remaining_source_script",
			layerId: "layer-1",
			layerKind: "text",
		});
	});

	it("reports image layer geometry issues using page asset dimensions", () => {
		const report = buildProjectQcReport(makeProject({
			targetLang: "en",
			pages: [{
				imageId: "page-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-1",
					text: "Translated",
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				imageLayers: [
					imageLayer({ id: "bad-image", w: 0 }),
					imageLayer({ id: "outside-image", x: 1200, y: 10 }),
					imageLayer({ id: "oversized-image", w: 200, h: 2600 }),
				],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [], [], [], {
			assets: [{ imageId: "page-1", width: 1000, height: 800 }],
		});

		expect(report.errorCount).toBe(1);
		expect(report.warningCount).toBe(2);
		expect(report.issues.map((issue) => issue.code)).toEqual([
			"invalid_image_layer_box",
			"image_layer_outside_page",
			"oversized_image_layer",
		]);
		expect(report.issues.every((issue) => issue.layerKind === "image")).toBe(true);
	});

	it("summarizes incomplete workflow tasks without blocking export", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [{
			id: "page-0-review",
			type: "review",
			status: "review",
			pageIndex: 0,
			title: "Review page 1",
			createdAt: "",
			updatedAt: "",
		}]);

		expect(report.infoCount).toBe(1);
		expect(report.issues.at(-1)?.code).toBe("workflow_incomplete");
	});

	it("reports workflow tasks pointing at missing pages, layers, or stale page images", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "current-image",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-current",
					text: "Translated",
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [{
			id: "task-missing-page",
			type: "clean",
			status: "todo",
			priority: "high",
			pageIndex: 4,
			title: "Clean missing page",
			createdAt: "",
			updatedAt: "",
		}, {
			id: "task-missing-layer",
			type: "typeset",
			status: "doing",
			priority: "high",
			pageIndex: 0,
			layerId: "deleted-layer",
			title: "Typeset deleted bubble",
			createdAt: "",
			updatedAt: "",
		}, {
			id: "task-stale-image",
			type: "review",
			status: "review",
			priority: "urgent",
			pageIndex: 0,
			pageImageId: "old-image",
			title: "Review old redraw",
			createdAt: "",
			updatedAt: "",
		}]);

		expect(report.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({
				code: "workflow_task_page_missing",
				taskId: "task-missing-page",
			}),
			expect.objectContaining({
				code: "workflow_task_layer_missing",
				taskId: "task-missing-layer",
				pageIndex: 0,
				layerId: "deleted-layer",
			}),
			expect.objectContaining({
				code: "workflow_task_image_stale",
				taskId: "task-stale-image",
				pageIndex: 0,
			}),
		]));
	});

	it("warns when a review decision points at a missing page", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-current",
					text: "Translated",
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
			reviewDecisions: [{
				id: "review-missing-page",
				pageIndex: 4,
				status: "changes_requested",
				body: "This review belongs to a deleted import page",
				actor: "lead",
				createdAt: "",
				updatedAt: "",
			}],
		}));

		expect(report.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "review-decision-review-missing-page-missing-page",
				code: "review_decision_page_missing",
				severity: "warning",
				reviewDecisionId: "review-missing-page",
			}),
		]));
	});

	it("warns when an open comment points at a missing page", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-current",
					text: "Translated",
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [], [{
			id: "comment-missing-page",
			pageIndex: 4,
			layerId: "deleted-layer",
			body: "This comment belongs to a removed page",
			author: "lead",
			status: "open",
			createdAt: "",
			updatedAt: "",
		}]);

		const issue = report.issues.find((entry) => entry.code === "comment_page_missing");
		expect(issue).toMatchObject({
			id: "comment-comment-missing-page-missing-page",
			severity: "warning",
			commentId: "comment-missing-page",
		});
		expect(issue).not.toHaveProperty("pageIndex");
		expect(report.issues.some((issue) => issue.code === "comment_anchor_missing")).toBe(false);
		expect(report.issues.some((issue) => issue.code === "open_review_comments" && issue.pageIndex === 4)).toBe(false);
	});

	it("warns when a page has unresolved review comments", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [], [{
			id: "comment-1",
			pageIndex: 0,
			body: "Check redraw edge",
			author: "local-user",
			status: "open",
			createdAt: "",
			updatedAt: "",
		}]);

		expect(report.issues.some((issue) => issue.code === "open_review_comments")).toBe(true);
		expect(report.warningCount).toBe(2);
	});

	it("warns when an open comment points at a missing layer anchor", () => {
		const report = buildProjectQcReport(makeProject({
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-current",
					text: "Translated",
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		}), [], [{
			id: "comment-missing-anchor",
			pageIndex: 0,
			layerId: "deleted-layer",
			body: "This old anchor points nowhere",
			author: "lead",
			status: "open",
			createdAt: "",
			updatedAt: "",
		}]);

		expect(report.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "page-0-comment-comment-missing-anchor-missing-anchor",
				code: "comment_anchor_missing",
				pageIndex: 0,
				commentId: "comment-missing-anchor",
				layerId: "deleted-layer",
			}),
		]));
	});

	it("reports AI review markers that need team attention", () => {
		const project = makeProject({
			targetLang: "en",
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-1",
					text: "Translated",
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		});
		const report = buildProjectQcReport(project, [], [], [{
			id: "marker-1",
			jobId: "job-1",
			pageIndex: 0,
			imageId: "img-1",
			region: { x: 0, y: 0, w: 120, h: 80 },
			status: "failed",
			tier: "clean-pro",
			createdAt: "",
			updatedAt: "",
		}, {
			id: "marker-2",
			jobId: "job-2",
			pageIndex: 0,
			imageId: "img-1",
			region: { x: 20, y: 20, w: 120, h: 80 },
			status: "needs_review",
			tier: "sfx-pro",
			createdAt: "",
			updatedAt: "",
		}]);

		expect(report.errorCount).toBe(1);
		expect(report.warningCount).toBe(1);
		expect(report.issues.map((issue) => issue.code)).toContain("ai_marker_failed");
		expect(report.issues.map((issue) => issue.code)).toContain("ai_marker_needs_review");
	});

	it("reports stale AI marker page and image references before review actions", () => {
		const project = makeProject({
			pages: [{
				imageId: "current-image",
				imageName: "page-1.webp",
				edits: { imageId: "current-edit" },
				textLayers: [{
					id: "layer-1",
					text: "Translated",
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		});
		const report = buildProjectQcReport(project, [], [], [{
			id: "marker-stale",
			jobId: "job-stale",
			pageIndex: 0,
			imageId: "old-image",
			region: { x: 0, y: 0, w: 120, h: 80 },
			status: "needs_review",
			tier: "clean-pro",
			createdAt: "",
			updatedAt: "",
		}, {
			id: "marker-missing-page",
			jobId: "job-missing",
			pageIndex: 3,
			imageId: "current-image",
			region: { x: 20, y: 20, w: 120, h: 80 },
			status: "accepted",
			tier: "sfx-pro",
			createdAt: "",
			updatedAt: "",
		}]);

		const staleImage = report.issues.find((issue) => issue.code === "ai_marker_image_stale");
		const missingPage = report.issues.find((issue) => issue.code === "ai_marker_page_missing");
		expect(staleImage?.severity).toBe("error");
		expect(staleImage?.pageIndex).toBe(0);
		expect(staleImage?.markerId).toBe("marker-stale");
		expect(staleImage?.messageCode).toBe("ai_marker_image_stale");
		expect(staleImage?.messageValues).toMatchObject({ markerImageId: "old-image", page: 1, currentImageId: "current-edit" });
		expect(missingPage?.severity).toBe("error");
		expect(missingPage?.pageIndex).toBeUndefined();
		expect(missingPage?.markerId).toBe("marker-missing-page");
		expect(missingPage?.messageCode).toBe("ai_marker_page_missing");
		expect(missingPage?.messageValues).toEqual({ page: 4 });
	});

	it("warns when AI marker linked comments or tasks no longer exist", () => {
		const project = makeProject({
			pages: [{
				imageId: "current-image",
				imageName: "page-1.webp",
				textLayers: [{
					id: "layer-1",
					text: "Translated",
					x: 0,
					y: 0,
					w: 100,
					h: 50,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}],
		});

		const report = buildProjectQcReport(project, [{
			id: "live-task",
			type: "review",
			status: "review",
			pageIndex: 0,
			title: "Review page",
			createdAt: "",
			updatedAt: "",
		}], [{
			id: "live-comment",
			pageIndex: 0,
			body: "Check edge",
			author: "lead",
			status: "open",
			createdAt: "",
			updatedAt: "",
		}], [{
			id: "marker-links",
			jobId: "job-links",
			pageIndex: 0,
			imageId: "current-image",
			region: { x: 0, y: 0, w: 120, h: 80 },
			status: "retry_requested",
			tier: "clean-pro",
			linkedCommentIds: ["live-comment", "missing-comment"],
			linkedTaskIds: ["live-task", "missing-task"],
			createdAt: "",
			updatedAt: "",
		}]);

		expect(report.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({
				code: "ai_marker_comment_link_missing",
				markerId: "marker-links",
				pageIndex: 0,
				messageCode: "ai_marker_comment_link_missing_one",
				messageValues: { commentId: "missing-comment" },
			}),
			expect.objectContaining({
				code: "ai_marker_task_link_missing",
				markerId: "marker-links",
				pageIndex: 0,
				messageCode: "ai_marker_task_link_missing_one",
				messageValues: { taskLinkId: "missing-task" },
			}),
		]));
	});
});

describe("buildProjectQcReport per-language tracks (PR-8 consumer migration)", () => {
	const filledLayer = {
		id: "text-1",
		text: "แปลแล้ว",
		x: 10,
		y: 10,
		w: 120,
		h: 40,
		rotation: 0,
		fontSize: 24,
		alignment: "center" as const,
		index: 0,
	};

	it("QCs the ACTIVE track's text layers in a multi-track project", () => {
		// Page: default-lang (th) track has a real text layer; the secondary (en)
		// track has none. Switching activeTargetLang must change which track is QC'd.
		const project = makeProject({
			targetLang: "th",
			targetLangs: ["th", "en"],
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [filledLayer],
				languageOutputs: {
					th: { textLayers: [filledLayer] },
					en: { textLayers: [] },
				},
				pendingAiJobs: [],
				coverRect: null,
			}],
		});

		// Active = th (the materialized, non-empty track) → no "page_without_text".
		const thReport = buildProjectQcReport({ ...project, activeTargetLang: "th" });
		expect(thReport.issues.some((issue) => issue.code === "page_without_text")).toBe(false);

		// Active = en (the empty track) → reports the missing-text warning.
		const enReport = buildProjectQcReport({ ...project, activeTargetLang: "en" });
		expect(enReport.issues.some((issue) => issue.code === "page_without_text")).toBe(true);
	});

	it("treats a comment anchor against the active track's layers", () => {
		// Comment anchored to a layer that only exists in the th track. With en active
		// (which has no such layer) the anchor is flagged missing; with th active it is not.
		const project = makeProject({
			targetLang: "th",
			targetLangs: ["th", "en"],
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [filledLayer],
				languageOutputs: {
					th: { textLayers: [filledLayer] },
					en: { textLayers: [{ ...filledLayer, id: "text-en" }] },
				},
				pendingAiJobs: [],
				coverRect: null,
			}],
		});
		const comment = {
			id: "c-1",
			pageIndex: 0,
			layerId: "text-1",
			status: "open" as const,
			body: "fix",
			author: "qc",
			createdAt: "",
			updatedAt: "",
		};

		const thReport = buildProjectQcReport({ ...project, activeTargetLang: "th" }, [], [comment]);
		expect(thReport.issues.some((issue) => issue.code === "comment_anchor_missing")).toBe(false);

		const enReport = buildProjectQcReport({ ...project, activeTargetLang: "en" }, [], [comment]);
		expect(enReport.issues.some((issue) => issue.code === "comment_anchor_missing")).toBe(true);
	});

	it("is byte-identical for a legacy single-language project regardless of selection", () => {
		// No targetLangs / languageOutputs → single track. activeTargetLang is irrelevant.
		const base = makeProject({
			targetLang: "th",
			pages: [{
				imageId: "img-1",
				imageName: "page-1.webp",
				textLayers: [filledLayer],
				pendingAiJobs: [],
				coverRect: null,
			}],
		});

		const baseline = buildProjectQcReport(base);
		const withSelection = buildProjectQcReport({ ...base, activeTargetLang: "en" });

		// activeTrack() clamps a non-existent selection back to targetLang, so the
		// report (minus its timestamp) is identical to the un-selected baseline.
		expect({ ...withSelection, checkedAt: "" }).toEqual({ ...baseline, checkedAt: "" });
		expect(withSelection.issues.some((issue) => issue.code === "page_without_text")).toBe(false);
	});
});
