import { describe, expect, it } from "vitest";
import {
	buildPageImageRelinkPlan,
	collectPageImageRelinkRefs,
	remapPageImageReferences,
} from "$lib/project/page-relink.js";
import type { Page, ProjectState } from "$lib/types.js";

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-01.webp",
		imageName: "image-01.webp",
		originalName: "image-01.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function imageFile(name: string): File {
	return new File(["image"], name, { type: "image/webp" });
}

describe("buildPageImageRelinkPlan", () => {
	it("matches page images by original filename", () => {
		const first = imageFile("image-01.webp");
		const second = imageFile("image-02.webp");

		const plan = buildPageImageRelinkPlan([
			page({ originalName: "image-01.webp" }),
			page({ imageId: "legacy-id", imageName: "image-02.webp", originalName: "image-02.webp" }),
		], [second, first]);

		expect(plan.matches.map((match) => [match.pageIndex, match.file.name])).toEqual([
			[0, "image-01.webp"],
			[1, "image-02.webp"],
		]);
		expect(plan.matches.map((match) => match.matchedBy)).toEqual(["name", "name"]);
		expect(plan.unmatchedPageIndexes).toEqual([]);
		expect(plan.unusedFiles).toEqual([]);
	});

	it("normalizes path-like page identifiers from imported JSON", () => {
		const file = imageFile("image-03.webp");
		const plan = buildPageImageRelinkPlan([
			page({
				imageId: "C:\\Users\\Suphot\\Downloads\\p104\\image-03.webp",
				imageName: "C:\\Users\\Suphot\\Downloads\\p104\\image-03.webp",
				originalName: undefined,
			}),
		], [file]);

		expect(plan.matches).toHaveLength(1);
		expect(plan.matches[0].file).toBe(file);
	});

	it("reports unmatched pages and unused files", () => {
		const extra = imageFile("extra.webp");
		const plan = buildPageImageRelinkPlan([
			page({ originalName: "image-04.webp" }),
		], [extra]);

		expect(plan.matches).toEqual([]);
		expect(plan.unmatchedPageIndexes).toEqual([0]);
		expect(plan.unusedFiles).toEqual([extra]);
	});

	it("can fall back to page order when imported page names do not match selected files", () => {
		const plan = buildPageImageRelinkPlan([
			page({ imageId: "ocr-a", originalName: "ocr-page-a.png", imageName: "ocr-page-a.png" }),
			page({ imageId: "ocr-b", originalName: "ocr-page-b.png", imageName: "ocr-page-b.png" }),
			page({ originalName: "image-03.webp", imageName: "image-03.webp" }),
		], [
			imageFile("image-01.webp"),
			imageFile("image-02.webp"),
			imageFile("image-03.webp"),
		], undefined, {
			matchUnmatchedByOrder: true,
		});

		expect(plan.matches.map((match) => [match.pageIndex, match.file.name, match.matchedBy])).toEqual([
			[2, "image-03.webp", "name"],
			[0, "image-01.webp", "order"],
			[1, "image-02.webp", "order"],
		]);
		expect(plan.unmatchedPageIndexes).toEqual([]);
		expect(plan.unusedFiles).toEqual([]);
	});
});

describe("remapPageImageReferences", () => {
	it("updates page-scoped task and AI marker image references after relink", () => {
		const firstPage = page({
			imageId: "legacy-image.webp",
			imageName: "legacy-image.webp",
			originalName: "image-01.webp",
			edits: { imageId: "edited-image.webp" },
		});
		const project = {
			projectId: "project-1",
			name: "Project",
			createdAt: "2026-05-14T00:00:00.000Z",
			currentPage: 0,
			targetLang: "th",
			pages: [
				firstPage,
				page({ imageId: "image-02.webp", imageName: "image-02.webp", originalName: "image-02.webp" }),
			],
			tasks: [
				{
					id: "page-0-review",
					type: "review",
					status: "todo",
					priority: "normal",
					pageIndex: 0,
					pageImageId: "legacy-image.webp",
					title: "Review page 1",
					createdAt: "2026-05-14T00:00:00.000Z",
					updatedAt: "2026-05-14T00:00:00.000Z",
				},
				{
					id: "page-1-review",
					type: "review",
					status: "todo",
					priority: "normal",
					pageIndex: 1,
					pageImageId: "image-02.webp",
					title: "Review page 2",
					createdAt: "2026-05-14T00:00:00.000Z",
					updatedAt: "2026-05-14T00:00:00.000Z",
				},
				{
					id: "custom-ref",
					type: "clean",
					status: "todo",
					priority: "normal",
					pageIndex: 0,
					pageImageId: "reference-layer.webp",
					title: "Custom ref",
					createdAt: "2026-05-14T00:00:00.000Z",
					updatedAt: "2026-05-14T00:00:00.000Z",
				},
			],
			aiReviewMarkers: [
				{
					id: "marker-1",
					jobId: "job-1",
					pageIndex: 0,
					imageId: "edited-image.webp",
					region: { x: 1, y: 2, w: 3, h: 4 },
					status: "needs_review",
					tier: "clean-pro",
					createdAt: "2026-05-14T00:00:00.000Z",
					updatedAt: "2026-05-14T00:00:00.000Z",
				},
				{
					id: "marker-2",
					jobId: "job-2",
					pageIndex: 1,
					imageId: "image-02.webp",
					region: { x: 1, y: 2, w: 3, h: 4 },
					status: "needs_review",
					tier: "clean-pro",
					createdAt: "2026-05-14T00:00:00.000Z",
					updatedAt: "2026-05-14T00:00:00.000Z",
				},
			],
		} satisfies ProjectState;

		const result = remapPageImageReferences(
			project,
			0,
			collectPageImageRelinkRefs(firstPage),
			"uploaded-image.webp",
		);

		expect(result).toEqual({ taskCount: 1, markerCount: 1 });
		expect(project.tasks?.[0].pageImageId).toBe("uploaded-image.webp");
		expect(project.tasks?.[1].pageImageId).toBe("image-02.webp");
		expect(project.tasks?.[2].pageImageId).toBe("reference-layer.webp");
		expect(project.aiReviewMarkers?.[0].imageId).toBe("uploaded-image.webp");
		expect(project.aiReviewMarkers?.[1].imageId).toBe("image-02.webp");
	});
});
