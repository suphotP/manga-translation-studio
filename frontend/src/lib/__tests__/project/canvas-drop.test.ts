import { describe, expect, it } from "vitest";
import { resolveCanvasImageDropAction } from "$lib/project/canvas-drop.js";

describe("resolveCanvasImageDropAction", () => {
	it("creates a new project when dropping images into an empty workspace", () => {
		expect(resolveCanvasImageDropAction({
			hasProject: false,
			hasCurrentAssetError: false,
			fileCount: 12,
		})).toBe("create-project");
	});

	it("routes a single dropped image to current-page relink while a page image is missing", () => {
		expect(resolveCanvasImageDropAction({
			hasProject: true,
			hasCurrentAssetError: true,
			fileCount: 1,
		})).toBe("relink-current-page");
	});

	it("routes multiple dropped images to chapter relink while a page image is missing", () => {
		expect(resolveCanvasImageDropAction({
			hasProject: true,
			hasCurrentAssetError: true,
			fileCount: 14,
		})).toBe("relink-matching-pages");
	});

	it("does not create a new project from image drops on an active healthy canvas", () => {
		expect(resolveCanvasImageDropAction({
			hasProject: true,
			hasCurrentAssetError: false,
			fileCount: 12,
		})).toBeNull();
	});

	it("ignores empty drops", () => {
		expect(resolveCanvasImageDropAction({
			hasProject: true,
			hasCurrentAssetError: true,
			fileCount: 0,
		})).toBeNull();
	});
});
