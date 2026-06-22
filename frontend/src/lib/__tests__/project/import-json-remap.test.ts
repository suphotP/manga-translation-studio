import { describe, expect, it } from "vitest";
import {
	buildJsonImportMappingRows,
	buildJsonImportMappingsPayload,
	buildJsonImportRemapPayload,
	shouldAskForJsonImportRemap,
	summarizeJsonImportSources,
} from "$lib/project/import-json-remap.js";

describe("JSON import remap helpers", () => {
	it("summarizes source pages by one-based JSON page number", () => {
		const options = summarizeJsonImportSources({
			entries: [
				{ pageNumber: 5, translated_text: "A" },
				{ pageNumber: 5, translated_text: "B" },
				{ pageNumber: 10, translated_text: "C" },
			],
		});

		expect(options).toEqual([
			expect.objectContaining({
				id: "page-number:5",
				kind: "pageNumber",
				pageNumber: 5,
				sourcePageIndex: 4,
				sourcePageNumber: 5,
				entryCount: 2,
			}),
			expect.objectContaining({
				id: "page-number:10",
				kind: "pageNumber",
				pageNumber: 10,
				sourcePageIndex: 9,
				sourcePageNumber: 10,
				entryCount: 1,
			}),
		]);
	});

	it("summarizes source pages by image path tail", () => {
		const options = summarizeJsonImportSources([
			{ image_path: "C:\\chapter\\image-005.webp", translated_text: "A" },
			{ image_path: "C:\\chapter\\image-005.webp", translated_text: "B" },
			{ image_path: "C:\\chapter\\image-010.webp", translated_text: "C" },
		]);

		expect(options).toEqual([
			expect.objectContaining({
				id: "image-path:image-005.webp",
				kind: "imagePath",
				displayName: "image-005.webp",
				sourceImagePath: "C:\\chapter\\image-005.webp",
				entryCount: 2,
			}),
			expect.objectContaining({
				id: "image-path:image-010.webp",
				kind: "imagePath",
				displayName: "image-010.webp",
				sourceImagePath: "C:\\chapter\\image-010.webp",
				entryCount: 1,
			}),
		]);
	});

	it("asks for remap when JSON has more source pages than project pages", () => {
		expect(shouldAskForJsonImportRemap(1, 10)).toBe(true);
		expect(shouldAskForJsonImportRemap(10, 10)).toBe(false);
		expect(shouldAskForJsonImportRemap(10, 1)).toBe(false);
	});

	it("asks for remap when equal-count partial source page numbers do not fit the project", () => {
		const options = summarizeJsonImportSources({
			entries: [
				{ pageNumber: 5, translated_text: "A" },
				{ pageNumber: 8, translated_text: "B" },
			],
		});

		expect(shouldAskForJsonImportRemap(2, options.length, options)).toBe(true);
		expect(shouldAskForJsonImportRemap(8, options.length, options)).toBe(false);
	});

	it("builds source-to-target remap payload for a selected JSON page", () => {
		const payload = buildJsonImportRemapPayload(
			{ entries: [{ pageNumber: 5, translated_text: "A" }] },
			{
				id: "page-number:5",
				kind: "pageNumber",
				pageNumber: 5,
				entryCount: 1,
				sourcePageIndex: 4,
				sourcePageNumber: 5,
			},
			0,
		);

		expect(payload).toEqual({
			entries: [{ pageNumber: 5, translated_text: "A" }],
			targetPageIndex: 0,
			sourcePageIndex: 4,
			sourcePageNumber: 5,
			sourceImagePath: undefined,
			sourceImageName: undefined,
		});
	});

	it("defaults multi-page mappings by project image order", () => {
		const options = summarizeJsonImportSources({
			entries: [
				{ pageNumber: 5, translated_text: "A" },
				{ pageNumber: 8, translated_text: "B" },
			],
		});

		const rows = buildJsonImportMappingRows(
			[
				{ pageIndex: 0, imageName: "upload-005.webp", originalName: "page-005.webp" },
				{ pageIndex: 1, imageName: "upload-006.webp", originalName: "page-006.webp" },
			],
			options,
		);

		expect(rows).toEqual([
			expect.objectContaining({
				targetPageIndex: 0,
				targetPageNumber: 1,
				targetPageName: "page-005.webp",
				sourceOptionId: "page-number:5",
				defaultSourceOptionId: "page-number:5",
				reason: "order",
			}),
			expect.objectContaining({
				targetPageIndex: 1,
				targetPageNumber: 2,
				targetPageName: "page-006.webp",
				sourceOptionId: "page-number:8",
				defaultSourceOptionId: "page-number:8",
				reason: "order",
			}),
		]);
	});

	it("builds one mappings payload after manual reorder", () => {
		const data = {
			entries: [
				{ pageNumber: 5, translated_text: "A" },
				{ pageNumber: 8, translated_text: "B" },
				{ pageNumber: 9, translated_text: "C" },
			],
		};
		const options = summarizeJsonImportSources(data);
		const payload = buildJsonImportMappingsPayload(
			data,
			[
				{ targetPageIndex: 0, sourceOptionId: "page-number:8" },
				{ targetPageIndex: 1, sourceOptionId: "page-number:5" },
				{ targetPageIndex: 2, sourceOptionId: null },
			],
			options,
		);

		expect(payload).toEqual({
			entries: data.entries,
			mappings: [
				{
					targetPageIndex: 0,
					sourcePageIndex: 7,
					sourcePageNumber: 8,
					sourceImagePath: undefined,
					sourceImageName: undefined,
				},
				{
					targetPageIndex: 1,
					sourcePageIndex: 4,
					sourcePageNumber: 5,
					sourceImagePath: undefined,
					sourceImageName: undefined,
				},
			],
		});
	});
});
