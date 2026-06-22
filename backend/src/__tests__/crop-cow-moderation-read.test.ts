// #2 crop moderation must read CoW content-addressed assets.
//
// resolveModerationImageUrl previously only called objectStorage.getProjectImage
// (the per-project `projects/<id>/images/<id>` key), so a copy-on-write asset
// whose bytes live at `content/<sha>` returned undefined → every crop check on a
// deduped asset 404'd ("crop_image_not_found"). The fix mirrors the image-serving
// path: when the asset record's storageKey is `content/<sha>`, read the content
// blob by sha. These tests pin that read path for both whole-image and crop modes.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "crypto";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { resolveModerationImageUrl, isCropAssetServable } from "../routes/crops.js";
import { objectStorage } from "../services/storage.js";
import { restoreAssetRecord, removeAssetRecord } from "../services/assets.js";
import { PROJECTS_DIR } from "../config.js";
import type { AssetRecord } from "../types/index.js";

function makeProjectDir(projectId: string): void {
	mkdirSync(join(PROJECTS_DIR, projectId, "images"), { recursive: true });
}

// 1x1 PNG (decodable by sharp).
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

const seeded: Array<{ projectId: string; imageId: string; sha256: string }> = [];

function cowAssetRecord(projectId: string, imageId: string, sha256: string): AssetRecord {
	const createdAt = "2026-06-05T00:00:00.000Z";
	return {
		assetId: imageId,
		projectId,
		imageId,
		originalName: imageId,
		mimeType: "image/png",
		sizeBytes: PNG.byteLength,
		sha256,
		storageDriver: "local",
		// CoW/content-addressed: bytes live at content/<sha>, NOT projects/<id>/images/<id>.
		storageKey: `content/${sha256}`,
		width: 1,
		height: 1,
		storageStatus: "released",
		moderation: { status: "passed", provider: "test", checkedAt: createdAt },
		derivatives: [],
		createdAt,
		updatedAt: createdAt,
	};
}

afterEach(async () => {
	for (const { projectId, imageId, sha256 } of seeded.splice(0)) {
		removeAssetRecord(projectId, imageId);
		await objectStorage.deleteContentBlob({ sha256 }).catch(() => undefined);
		rmSync(join(PROJECTS_DIR, projectId), { recursive: true, force: true });
	}
});

describe("resolveModerationImageUrl — CoW content-addressed read", () => {
	test("reads a content/<sha> blob for the whole image (no per-project object)", async () => {
		const projectId = `proj-${randomUUID()}`;
		const imageId = `${randomUUID()}.png`;
		const sha256 = createHash("sha256").update(PNG).digest("hex");
		makeProjectDir(projectId);
		await objectStorage.putContentBlob({ sha256, buffer: PNG });
		restoreAssetRecord(projectId, cowAssetRecord(projectId, imageId, sha256));
		seeded.push({ projectId, imageId, sha256 });

		// Sanity: the per-project key has NO object — only the content blob does. The
		// old code path (getProjectImage only) would have returned undefined here.
		expect(await objectStorage.getProjectImage({ projectId, imageId })).toBeUndefined();

		const url = await resolveModerationImageUrl(projectId, imageId);
		expect(typeof url).toBe("string");
		expect(url!.startsWith("data:image/")).toBe(true);
	});

	test("reads a content/<sha> blob for a crop region", async () => {
		const projectId = `proj-${randomUUID()}`;
		const imageId = `${randomUUID()}.png`;
		const sha256 = createHash("sha256").update(PNG).digest("hex");
		makeProjectDir(projectId);
		await objectStorage.putContentBlob({ sha256, buffer: PNG });
		restoreAssetRecord(projectId, cowAssetRecord(projectId, imageId, sha256));
		seeded.push({ projectId, imageId, sha256 });

		// A data URL here proves the crop pipeline read the CoW content blob (the only
		// place the bytes live); buildModerationImageDataUrl may re-encode the format.
		const url = await resolveModerationImageUrl(projectId, imageId, { x: 0, y: 0, w: 1, h: 1 });
		expect(typeof url).toBe("string");
		expect(url!.startsWith("data:image/")).toBe(true);
	});
});

describe("isCropAssetServable — crop servability guard (P1 bypass fix)", () => {
	function seedAsset(storageStatus: AssetRecord["storageStatus"], moderationStatus: AssetRecord["moderation"]["status"]): { projectId: string; imageId: string } {
		const projectId = `proj-${randomUUID()}`;
		const imageId = `${randomUUID()}.png`;
		const createdAt = "2026-06-05T00:00:00.000Z";
		makeProjectDir(projectId);
		restoreAssetRecord(projectId, {
			assetId: imageId,
			projectId,
			imageId,
			originalName: imageId,
			mimeType: "image/png",
			sizeBytes: PNG.byteLength,
			sha256: createHash("sha256").update(`${projectId}:${imageId}`).digest("hex"),
			storageDriver: "local",
			storageKey: `projects/${projectId}/images/${imageId}`,
			width: 1,
			height: 1,
			storageStatus,
			moderation: { status: moderationStatus, provider: "test", checkedAt: createdAt },
			derivatives: [],
			createdAt,
			updatedAt: createdAt,
		});
		seeded.push({ projectId, imageId, sha256: createHash("sha256").update(randomUUID()).digest("hex") });
		return { projectId, imageId };
	}

	test("a BLOCKED asset is NOT servable (crop cannot read blocked bytes)", async () => {
		const { projectId, imageId } = seedAsset("blocked", "blocked");
		expect(await isCropAssetServable(projectId, imageId)).toBe(false);
	});

	test("a quarantined asset is NOT servable", async () => {
		const { projectId, imageId } = seedAsset("quarantined", "pending");
		expect(await isCropAssetServable(projectId, imageId)).toBe(false);
	});

	test("a passed/released asset IS servable", async () => {
		const { projectId, imageId } = seedAsset("released", "passed");
		expect(await isCropAssetServable(projectId, imageId)).toBe(true);
	});

	test("a needs_review/released asset IS servable (displayable with marker)", async () => {
		const { projectId, imageId } = seedAsset("released", "needs_review");
		expect(await isCropAssetServable(projectId, imageId)).toBe(true);
	});
});
