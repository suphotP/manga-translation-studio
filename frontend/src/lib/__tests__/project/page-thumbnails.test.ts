import { describe, expect, it } from "vitest";
import { getPagePreviewImageId, isLikelyServedProjectImageId } from "$lib/project/page-thumbnails.js";
import type { Page } from "$lib/types.js";

function makePage(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "550e8400-e29b-41d4-a716-446655440000.webp",
		imageName: "page-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

describe("page thumbnails", () => {
	it("allows project-upload UUID images and AI result images", () => {
		expect(isLikelyServedProjectImageId("550e8400-e29b-41d4-a716-446655440000.webp")).toBe(true);
		expect(isLikelyServedProjectImageId("550e8400-e29b-41d4-a716-446655440000.png")).toBe(true);
		expect(isLikelyServedProjectImageId("result_550e8400-e29b-41d4-a716-446655440000.png")).toBe(true);
	});

	it("blocks legacy import filenames to avoid thumbnail 404 storms", () => {
		expect(isLikelyServedProjectImageId("image-01.webp")).toBe(false);
		expect(isLikelyServedProjectImageId("C:\\pages\\image-01.webp")).toBe(false);
		expect(isLikelyServedProjectImageId("../image-01.webp")).toBe(false);
	});

	it("prefers edited AI result image ids when available", () => {
		expect(getPagePreviewImageId(makePage({
			edits: { imageId: "result_550e8400-e29b-41d4-a716-446655440000.png" },
		}))).toBe("result_550e8400-e29b-41d4-a716-446655440000.png");
	});
});
