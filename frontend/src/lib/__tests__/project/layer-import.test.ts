import { describe, expect, it } from "vitest";
import {
	buildLayerImportResult,
	isLayerImportDocument,
	resolveLayerImportPageIndex,
} from "$lib/project/layer-import.js";
import type { ProjectState } from "$lib/types.js";

function makeProject(): ProjectState {
	return {
		projectId: "project-1",
		name: "Chapter",
		createdAt: "2026-05-12T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [
			{
				imageId: "asset-1.webp",
				imageName: "asset-1.webp",
				originalName: "image-01.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
			{
				imageId: "asset-2.webp",
				imageName: "asset-2.webp",
				originalName: "image-02.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
	};
}

describe("layer JSON import", () => {
	it("detects our exported layer document shape", () => {
		expect(isLayerImportDocument({ textLayers: [] })).toBe(true);
		expect(isLayerImportDocument({ entries: [] })).toBe(false);
		expect(isLayerImportDocument([])).toBe(false);
	});

	it("resolves page by exported imageName before falling back to current page", () => {
		const project = makeProject();
		expect(resolveLayerImportPageIndex(project, { imageName: "image-02.webp", textLayers: [] })).toBe(1);
		expect(resolveLayerImportPageIndex(project, { imageName: "missing.webp", pageIndex: 0, textLayers: [] })).toBeNull();
		expect(resolveLayerImportPageIndex(project, { pageIndex: 1, textLayers: [] })).toBe(1);
		expect(resolveLayerImportPageIndex(project, { textLayers: [] })).toBe(0);
	});

	it("normalizes valid layers and skips malformed layers", () => {
		const project = makeProject();
		const result = buildLayerImportResult(project, {
			imageName: "image-01.webp",
			textLayers: [
				{
					id: "layer-1",
					text: "Round trip",
					x: 10.4,
					y: 20.5,
					w: 100.2,
					h: 50.7,
					rotation: 0,
					fontSize: 24,
					charSpacing: 140,
					skewX: 12.4,
					skewY: -7.6,
					alignment: "center",
					fill: "#c1121f",
					stroke: "#ffffff",
					strokeWidth: 3.5,
					visible: false,
					locked: true,
					index: 0,
				},
				{ text: "bad geometry", x: 0, y: 0, w: 0, h: 10 },
				{ x: 0, y: 0, w: 10, h: 10 },
			],
		}, () => "new-id");

		expect(result.pageIndex).toBe(0);
		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(2);
		expect(result.layers).toEqual([
			expect.objectContaining({
				id: "layer-1",
				text: "Round trip",
				x: 10,
				y: 21,
				w: 100,
				h: 51,
				fill: "#c1121f",
				stroke: "#ffffff",
				strokeWidth: 3.5,
				charSpacing: 140,
				skewX: 12,
				skewY: -8,
				visible: false,
				locked: true,
				sourceProvider: "layer-json-import",
			}),
		]);
	});

	it("skips the whole document when explicit imageName does not match the project", () => {
		const result = buildLayerImportResult(makeProject(), {
			imageName: "other-page.webp",
			textLayers: [{ text: "nope", x: 0, y: 0, w: 10, h: 10 }],
		});

		expect(result.pageIndex).toBeNull();
		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(1);
	});
});
