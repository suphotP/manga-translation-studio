import { describe, expect, it } from "vitest";
import { applyLocalTranslationImport } from "$lib/project/local-translation-import.js";
import type { Page, ProjectState } from "$lib/types.js";

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		originalName: "page-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "flow208-project",
		name: "Moonlit Courier Chapter 104",
		createdAt: "2026-05-17T00:00:00.000Z",
		pages: [page()],
		currentPage: 0,
		targetLang: "TH",
		textStylePresets: [],
		creditPresets: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		...overrides,
	};
}

describe("applyLocalTranslationImport", () => {
	it("skips malformed-but-parseable rows without mutating text layers", () => {
		const localProject = project();

		const result = applyLocalTranslationImport(localProject, {
			entries: [
				null,
				{ pageNumber: 99, text: "wrong page" },
				{ translated_text: "", bbox: [10, 20, 120, 80] },
			],
		});

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(3);
		expect(result.skippedByReason).toEqual({
			invalid_entry: 1,
			page_not_found: 1,
			invalid_layer: 1,
		});
		expect(result.pages).toEqual([]);
		expect(localProject.pages[0].textLayers).toEqual([]);
	});

	it("reports explicit source mappings that filter every row", () => {
		const localProject = project({
			pages: [
				page({ imageId: "page-1.webp", imageName: "page-1.webp", originalName: "page-1.webp" }),
				page({ imageId: "page-2.webp", imageName: "page-2.webp", originalName: "page-2.webp" }),
			],
		});

		const result = applyLocalTranslationImport(localProject, {
			mappings: [{ targetPageIndex: 1, sourcePageNumber: 10 }],
			entries: [{ pageNumber: 1, text: "not selected" }],
		});

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.sourceFiltered).toBe(1);
		expect(result.sourceMappings).toEqual([
			expect.objectContaining({
				targetPageIndex: 1,
				sourcePageNumber: 10,
				imported: 0,
			}),
		]);
		expect(localProject.pages[0].textLayers).toEqual([]);
		expect(localProject.pages[1].textLayers).toEqual([]);
	});

	it("default/single-language project still writes the flat textLayers (byte-identical)", () => {
		const localProject = project();

		const result = applyLocalTranslationImport(localProject, {
			entries: [{ translated_text: "สวัสดี", bbox: [10, 20, 120, 80] }],
		});

		expect(result.imported).toBe(1);
		expect(localProject.pages[0].textLayers).toHaveLength(1);
		expect(localProject.pages[0].textLayers[0].text).toBe("สวัสดี");
		// No per-language bucket is materialized for the default track.
		expect(localProject.pages[0].languageOutputs).toBeUndefined();
	});

	it("materializes the import into languageOutputs[activeTrack] for a non-default track", () => {
		const localProject = project({
			targetLang: "EN",
			targetLangs: ["EN", "TH"],
			activeTargetLang: "TH",
			pages: [page({ textLayers: [{ id: "src-1", text: "Hello", x: 0, y: 0, w: 100, h: 40 }] })],
		});

		const result = applyLocalTranslationImport(localProject, {
			entries: [{ translated_text: "สวัสดี", bbox: [10, 20, 120, 80] }],
		});

		expect(result.imported).toBe(1);
		// The imported TH translation lands on the TH bucket...
		const thBucket = localProject.pages[0].languageOutputs?.TH;
		expect(thBucket).toBeDefined();
		expect(thBucket!.textLayers.some((layer) => layer.text === "สวัสดี")).toBe(true);
		// ...and NOT on the shared flat (default EN) layer.
		expect(localProject.pages[0].textLayers.some((layer) => layer.text === "สวัสดี")).toBe(false);
		expect(localProject.pages[0].textLayers).toEqual([
			expect.objectContaining({ id: "src-1", text: "Hello" }),
		]);
	});
});
