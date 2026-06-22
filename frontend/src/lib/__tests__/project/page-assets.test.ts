import { describe, expect, it } from "vitest";
import { findPageAssetRecord, getPageAssetIntegrity } from "$lib/project/page-assets.js";
import type { Page } from "$lib/types.js";

function makePage(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "img-1",
		imageName: "image-01.webp",
		originalName: "image-01.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

describe("getPageAssetIntegrity", () => {
	it("marks normal pages as ready", () => {
		expect(getPageAssetIntegrity(makePage(), 0)).toMatchObject({
			pageIndex: 0,
			status: "ready",
			label: "Ready",
			imageId: "img-1",
		});
	});

	it("surfaces current page load failures", () => {
		expect(getPageAssetIntegrity(makePage(), 1, {
			pageIndex: 1,
			imageId: "img-1",
			imageName: "image-01.webp",
			message: "404",
		})).toMatchObject({
			pageIndex: 1,
			status: "failed",
			label: "Failed",
			detail: "404",
		});
	});

	it("surfaces image-layer load failures without blaming the base page image", () => {
		expect(getPageAssetIntegrity(makePage(), 1, {
			pageIndex: 1,
			imageId: "overlay-1",
			imageName: "overlay.webp",
			originalName: "overlay-source.webp",
			message: "404 overlay",
			kind: "image-layer",
			layerId: "layer-overlay",
			layerName: "Logo overlay",
		})).toMatchObject({
			pageIndex: 1,
			status: "failed",
			label: "Failed",
			detail: "รูปเสริม Logo overlay โหลดไม่ได้: 404 overlay",
			imageId: "overlay-1",
			originalName: "overlay-source.webp",
			issueKind: "image-layer",
			layerId: "layer-overlay",
		});
	});

	it("marks pages without an image id as missing", () => {
		expect(getPageAssetIntegrity(makePage({ imageId: "" }), 2)).toMatchObject({
			pageIndex: 2,
			status: "missing",
			label: "Missing",
		});
	});

	it("marks page image ids missing when a loaded asset inventory has no matching record", () => {
		expect(getPageAssetIntegrity(makePage(), 3, null, null, true)).toMatchObject({
			pageIndex: 3,
			status: "missing",
			label: "Missing",
			detail: "image-01.webp ไม่อยู่ในคลังรูปของงาน; กู้รูปหน้านี้หรือจับคู่โฟลเดอร์รูป",
			imageId: "img-1",
		});
	});

	it("blocks readiness when the asset inventory could not be loaded", () => {
		expect(getPageAssetIntegrity(makePage(), 3, null, null, false, "network down")).toMatchObject({
			pageIndex: 3,
			status: "unknown",
			label: "Unknown",
			detail: "ตรวจคลังรูปไม่ได้: network down",
			imageId: "img-1",
		});
	});

	it("keeps released assets ready when the loaded asset inventory matches", () => {
		expect(getPageAssetIntegrity(makePage(), 3, null, {
			assetId: "img-1",
			imageId: "img-1",
			originalName: "image-01.webp",
			storageStatus: "released",
			moderationStatus: "passed",
		}, true)).toMatchObject({
			pageIndex: 3,
			status: "ready",
			label: "Ready",
			imageId: "img-1",
		});
	});

	it("labels pages with generated image edits as edited but still ready", () => {
		expect(getPageAssetIntegrity(makePage({ edits: { imageId: "result-1" } }), 0)).toMatchObject({
			status: "ready",
			label: "Edited",
		});
	});

	it("uses the source image asset before generated edit assets", () => {
		const record = findPageAssetRecord(makePage({ edits: { imageId: "result-1" } }), [
			{ assetId: "result-1", imageId: "result-1", originalName: "generated.webp" },
			{ assetId: "img-1", imageId: "img-1", originalName: "image-01.webp" },
		]);

		expect(record).toMatchObject({
			assetId: "img-1",
			originalName: "image-01.webp",
		});
	});

	it("marks quarantined or review-needed assets as scanning holds", () => {
		expect(getPageAssetIntegrity(makePage(), 0, null, {
			assetId: "img-1",
			imageId: "img-1",
			originalName: "image-01.webp",
			storageStatus: "quarantined",
			moderationStatus: "needs_review",
		})).toMatchObject({
			status: "scanning",
			label: "ต้องตรวจ",
			storageStatus: "quarantined",
			moderationStatus: "needs_review",
		});
	});

	it("marks blocked storage or moderation assets as blocked", () => {
		expect(getPageAssetIntegrity(makePage(), 0, null, {
			assetId: "img-1",
			imageId: "img-1",
			originalName: "image-01.webp",
			storageStatus: "blocked",
			moderationStatus: "blocked",
		})).toMatchObject({
			status: "blocked",
			label: "Blocked",
			detail: "image-01.webp ติดบล็อกจาก storage หรือการตรวจรูป",
		});
	});
});
