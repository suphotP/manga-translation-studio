import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import sharp from "sharp";
import { PROJECTS_DIR } from "../config.js";
import {
	assertAssetReadyForAi,
	assertAssetReadyForAiAuthoritative,
	type AssetStore,
	type AssetWriteContext,
	type WorkspaceAssetUsage,
	buildModerationDerivativePlan,
	computeProjectAssetUsage,
	ensureThumbnailDerivative,
	getAssetRecord,
	getAssetRecordAuthoritative,
	getAssetWriteContextAuthoritative,
	hydrateAssetMirrorForProject,
	listAssetRecordPage,
	listAssetRecordPageAuthoritative,
	listAssetRecords,
	listAssetRecordsAuthoritative,
	recordUploadedAsset,
	removeAssetRecord,
	removeAssetRecordAuthoritative,
	restoreAssetRecordAuthoritative,
	setAssetStoreForTests,
	setWorkspaceLookupCatalogStoreForTests,
	storageStatusForModerationStatus,
	ThumbnailSourceDecodeError,
	__thumbnailTestHooks,
} from "../services/assets.js";
import { toAssetModerationResult } from "../services/moderation.js";
import { objectStorage } from "../services/storage.js";
import { cleanupUncommittedUploadObjects } from "../routes/images.js";
import {
	MemoryStorageQuotaReservationStore,
	StorageQuotaExceededError,
	assertProjectStorageQuota,
	readStorageQuotaConfig,
	setStorageQuotaReservationStoreForTests,
	summarizeProjectStorageQuota,
	summarizeProjectStorageQuotaForBilling,
	summarizeProjectStorageQuotaForProjectView,
} from "../services/storage-quota.js";
import { GIB } from "../services/plans.js";
import type { AssetDerivative, AssetModerationResult, AssetRecord, AssetStorageStatus } from "../types/index.js";

const createdProjectDirs: string[] = [];

function createProjectDir(options: { workspaceId?: string } = {}): string {
	const projectId = uuid();
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify({
		projectId,
		...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
		name: "Asset Pipeline Test",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
	}));
	createdProjectDirs.push(projectDir);
	return projectId;
}

function buildAssetRecord(projectId: string, imageId: string, overrides: Partial<AssetRecord> = {}): AssetRecord {
	const createdAt = overrides.createdAt ?? "2026-05-28T01:00:00.000Z";
	return {
		assetId: imageId,
		projectId,
		imageId,
		originalName: imageId,
		mimeType: "image/png",
		sizeBytes: 70,
		sha256: "a".repeat(64),
		storageDriver: "local",
		storageKey: `projects/${projectId}/images/${imageId}`,
		width: 1,
		height: 1,
		storageStatus: "released",
		moderation: {
			status: "passed",
			provider: "test",
			checkedAt: createdAt,
		},
		derivatives: [],
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

afterEach(() => {
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const projectDir of createdProjectDirs.splice(0)) {
		const resolved = resolve(projectDir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

describe("asset pipeline", () => {
	test("normal images get an overview moderation derivative only", () => {
		const plan = buildModerationDerivativePlan({ width: 1200, height: 800 });
		expect(plan.length).toBe(1);
		expect(plan[0]!.purpose).toBe("moderation_overview");
		expect(plan[0]!.sourceRect).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
	});

	test("long images get overview plus overlapped moderation tiles", () => {
		const plan = buildModerationDerivativePlan({ width: 800, height: 14492 });
		const tiles = plan.filter((item) => item.purpose === "moderation_tile");
		expect(plan[0]!.purpose).toBe("moderation_overview");
		expect(tiles.length).toBeGreaterThan(5);
		expect(tiles[1]!.sourceRect.y).toBeLessThan(tiles[0]!.sourceRect.y + tiles[0]!.sourceRect.h);
		expect(tiles.at(-1)!.sourceRect.y + tiles.at(-1)!.sourceRect.h).toBe(14492);
	});

	test("recordUploadedAsset stores metadata and allows passed assets for AI", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		const pngBuffer = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(imagePath, pngBuffer);

		let record: Awaited<ReturnType<typeof recordUploadedAsset>>;
		try {
			record = await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: pngBuffer.length,
			});
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previous;
			}
		}

		expect(record.width).toBe(1);
		expect(record.height).toBe(1);
		expect(record.sha256).toHaveLength(64);
		expect(record.storageDriver).toBe("local");
		expect(record.storageKey).toBe(`projects/${projectId}/images/${imageId}`);
		expect(record.moderation.status).toBe("passed");
		expect(getAssetRecord(projectId, imageId)?.assetId).toBe(imageId);
		expect(listAssetRecords(projectId).map((asset) => asset.assetId)).toEqual([imageId]);
		expect(() => assertAssetReadyForAi(projectId, imageId)).not.toThrow();
	});

	// SECURITY (CSAM quarantine invariant): `recordUploadedAsset` must set
	// storageStatus="blocked" for ANY hard block so the object is never
	// displayable / downloadable / exportable / served. We pass a precomputed
	// `moderation` (the AI-output / upload-route shape) to exercise the
	// storageStatus mapping at the write seam directly.
	async function recordWithModeration(status: AssetModerationResult["status"]): Promise<AssetRecord> {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		const pngBuffer = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(imagePath, pngBuffer);
		try {
			return await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: pngBuffer.length,
				moderation: {
					status,
					provider: "test",
					checkedAt: new Date().toISOString(),
				},
			});
		} finally {
			if (previous === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
			else process.env.OPENAI_MODERATION_ENABLED = previous;
		}
	}

	test("storageStatusForModerationStatus quarantines every hard block (allow-list)", () => {
		// Released ONLY for the explicit safe statuses.
		expect(storageStatusForModerationStatus("passed")).toBe("released");
		expect(storageStatusForModerationStatus("needs_review")).toBe("released");
		// Hard blocks quarantine.
		expect(storageStatusForModerationStatus("blocked")).toBe("blocked");
		// A raw `csam_block` that ever leaked past normalization must STILL quarantine
		// (fail-closed) - this is the core defense-in-depth guarantee.
		expect(storageStatusForModerationStatus("csam_block")).toBe("blocked");
		// Unknown / pending / undefined are NOT on the release allow-list -> blocked.
		expect(storageStatusForModerationStatus("pending")).toBe("blocked");
		expect(storageStatusForModerationStatus("totally-unknown")).toBe("blocked");
		expect(storageStatusForModerationStatus(undefined)).toBe("blocked");
	});

	test("recordUploadedAsset quarantines a csam_block verdict (normalized to blocked)", async () => {
		// The CSAM raw verdict normalizes to "blocked" before the record write.
		const assetModeration = toAssetModerationResult({
			decision: "block",
			status: "csam_block",
			categories: {},
			scores: { "sexual/minors": 0.9 },
			cached: false,
			ruleset_version: "1.0",
			provider: "openai_omni",
			checkedAt: new Date().toISOString(),
			reason: "sexual/minors",
		});
		expect(assetModeration.status).toBe("blocked");
		const record = await recordWithModeration(assetModeration.status);
		expect(record.storageStatus).toBe("blocked");
	});

	test("recordUploadedAsset quarantines a plain blocked verdict", async () => {
		const record = await recordWithModeration("blocked");
		expect(record.storageStatus).toBe("blocked");
	});

	test("recordUploadedAsset releases a passed verdict", async () => {
		const record = await recordWithModeration("passed");
		expect(record.storageStatus).toBe("released");
	});

	test("recordUploadedAsset releases a needs_review verdict with the review marker", async () => {
		const record = await recordWithModeration("needs_review");
		expect(record.storageStatus).toBe("released");
		// The review marker is carried on the moderation status for downstream AI gating.
		expect(record.moderation.status).toBe("needs_review");
	});

	test("AI readiness can fail closed when the asset registry is required", () => {
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;

		expect(() => assertAssetReadyForAi(projectId, imageId)).not.toThrow();
		expect(() => assertAssetReadyForAi(projectId, imageId, { requireRegistry: true }))
			.toThrow(`Asset ${imageId} is not registered for AI processing`);
	});

	test("AI readiness rejects assets that still need moderation review", () => {
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify({
			[imageId]: buildAssetRecord(projectId, imageId, {
				storageStatus: "released",
				moderation: {
					status: "needs_review",
					provider: "test",
					checkedAt: "2026-06-02T00:00:00.000Z",
				},
			}),
		}, null, 2));

		expect(() => assertAssetReadyForAi(projectId, imageId))
			.toThrow(`Asset ${imageId} moderation status is needs_review`);
	});

	test("reads asset indexes that were saved with a UTF-8 BOM", () => {
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const record = {
			assetId: imageId,
			projectId,
			imageId,
			originalName: "tiny.png",
			mimeType: "image/png",
			sizeBytes: 70,
			sha256: "a".repeat(64),
			storageDriver: "local",
			storageKey: `projects/${projectId}/images/${imageId}`,
			width: 1,
			height: 1,
			storageStatus: "released",
			moderation: {
				status: "passed",
				provider: "test",
				checkedAt: new Date().toISOString(),
			},
			derivatives: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeFileSync(
			join(PROJECTS_DIR, projectId, "assets.json"),
			`\uFEFF${JSON.stringify({ [imageId]: record }, null, 2)}`,
		);

		expect(listAssetRecords(projectId).map((asset) => asset.assetId)).toEqual([imageId]);
	});

	test("listAssetRecordPage returns bounded cursor pages and filterable assets", () => {
		const projectId = createProjectDir();
		const records = [
			buildAssetRecord(projectId, "asset-a.png", {
				createdAt: "2026-05-28T01:00:00.000Z",
				updatedAt: "2026-05-28T01:00:00.000Z",
				uploadedBy: { source: "human", userId: "user-1" },
			}),
			buildAssetRecord(projectId, "asset-b.png", {
				createdAt: "2026-05-28T02:00:00.000Z",
				updatedAt: "2026-05-28T02:00:00.000Z",
				storageStatus: "blocked",
				moderation: {
					status: "blocked",
					provider: "test",
					checkedAt: "2026-05-28T02:00:00.000Z",
				},
				uploadedBy: { source: "anonymous" },
			}),
			buildAssetRecord(projectId, "asset-c.png", {
				createdAt: "2026-05-28T03:00:00.000Z",
				updatedAt: "2026-05-28T03:00:00.000Z",
				uploadedBy: { source: "human", userId: "user-2" },
			}),
		];
		writeFileSync(
			join(PROJECTS_DIR, projectId, "assets.json"),
			JSON.stringify(Object.fromEntries(records.map((record) => [record.imageId, record])), null, 2),
		);

		const first = listAssetRecordPage(projectId, { limit: 2 });
		expect(first.assets.map((asset) => asset.assetId)).toEqual(["asset-c.png", "asset-b.png"]);
		expect(first.nextCursor).toBeDefined();

		const second = listAssetRecordPage(projectId, { limit: 2, cursor: first.nextCursor });
		expect(second.assets.map((asset) => asset.assetId)).toEqual(["asset-a.png"]);
		expect(second.nextCursor).toBeUndefined();

		expect(listAssetRecordPage(projectId, { storageStatus: "blocked" }).assets.map((asset) => asset.assetId)).toEqual(["asset-b.png"]);
		expect(listAssetRecordPage(projectId, { moderationStatus: "passed", source: "human" }).assets.map((asset) => asset.assetId)).toEqual(["asset-c.png", "asset-a.png"]);
	});

	test("listAssetRecordPage treats missing upload actors as anonymous and follows sort order for cursors", () => {
		const projectId = createProjectDir();
		const createdAt = "2026-05-28T01:00:00.000Z";
		const records = [
			buildAssetRecord(projectId, "asset-a.png", { createdAt, updatedAt: createdAt }),
			buildAssetRecord(projectId, "asset_0.png", { createdAt, updatedAt: createdAt }),
			buildAssetRecord(projectId, "asset-human.png", {
				createdAt,
				updatedAt: createdAt,
				uploadedBy: { source: "human", userId: "user-1" },
			}),
		];
		writeFileSync(
			join(PROJECTS_DIR, projectId, "assets.json"),
			JSON.stringify(Object.fromEntries(records.map((record) => [record.imageId, record])), null, 2),
		);

		const expectedOrder = listAssetRecords(projectId).map((asset) => asset.assetId);
		const drained: string[] = [];
		let cursor: string | undefined;
		do {
			const page = listAssetRecordPage(projectId, { limit: 1, cursor });
			drained.push(...page.assets.map((asset) => asset.assetId));
			cursor = page.nextCursor;
		} while (cursor);

		expect(drained).toEqual(expectedOrder);
		expect(new Set(drained).size).toBe(records.length);
		expect(listAssetRecordPage(projectId, { source: "anonymous" }).assets.map((asset) => asset.assetId)).toEqual(["asset-a.png", "asset_0.png"]);
	});

	test("ensureThumbnailDerivative creates and reuses a cached thumbnail derivative", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		const pngBuffer = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(imagePath, pngBuffer);

		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: pngBuffer.length,
			});
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previous;
			}
		}

		const first = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
		const second = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
		const record = getAssetRecord(projectId, imageId);

		expect(first.mimeType).toBe("image/webp");
		expect(first.cacheHit).toBe(false);
		expect(first.width).toBe(1);
		expect(first.height).toBe(1);
		expect(first.buffer.byteLength).toBeGreaterThan(0);
		expect(second.cacheHit).toBe(true);
		expect(second.derivativeId).toBe(first.derivativeId);
		expect(record?.derivatives.some((item) => item.id === first.derivativeId && item.purpose === "thumbnail" && item.status === "ready")).toBe(true);
	});

	test("ensureThumbnailDerivative fit=inside downscales a tall page WITHOUT cropping (webtoon strip preview)", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		// A tall "webtoon" source: 600×1500 (aspect 2.5). cover would crop it to the box;
		// inside must keep the whole page, just downscaled to the requested column width.
		const tallBuffer = await sharp({
			create: { width: 600, height: 1500, channels: 3, background: { r: 200, g: 200, b: 200 } },
		}).png().toBuffer();
		writeFileSync(imagePath, tallBuffer);

		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tall.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: tallBuffer.length,
			});

			// inside: request column width 400; height bound is just a ceiling.
			const inside = await ensureThumbnailDerivative(projectId, imageId, { width: 400, height: 1600, fit: "inside" });
			const insideMeta = await sharp(inside.buffer).metadata();
			// Aspect PRESERVED (no crop): 400 wide → 1000 tall (400 × 1500/600).
			expect(insideMeta.width).toBe(400);
			expect(insideMeta.height).toBe(1000);

			// cover at the same column width crops to the (smaller) box height.
			const cover = await ensureThumbnailDerivative(projectId, imageId, { width: 400, height: 600, fit: "cover" });
			const coverMeta = await sharp(cover.buffer).metadata();
			expect(coverMeta.height).toBe(600); // cropped, not the full 1000

			// The two fits must NOT collide in the derivative cache.
			expect(inside.derivativeId).not.toBe(cover.derivativeId);
			expect(inside.derivativeId).toContain("inside");

			// inside accepts widths well above the 512 cover cap (retina column crispness).
			const wide = await ensureThumbnailDerivative(projectId, imageId, { width: 1200, height: 4000, fit: "inside" });
			const wideMeta = await sharp(wide.buffer).metadata();
			expect(wideMeta.width).toBe(600); // clamped to source width (withoutEnlargement), not 512
			expect(wideMeta.height).toBe(1500); // full page, uncropped
		} finally {
			if (previous === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
			else process.env.OPENAI_MODERATION_ENABLED = previous;
		}
	});

	test("ensureThumbnailDerivative regenerates a corrupt cached derivative from the original", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		const pngBuffer = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(imagePath, pngBuffer);

		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: pngBuffer.length,
			});
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previous;
			}
		}

		const first = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
		await objectStorage.putProjectDerivative({
			projectId,
			derivativeId: first.derivativeId,
			buffer: Buffer.from("not-a-webp-thumbnail"),
		});
		// The hit path now trusts the PERSISTED derivative dims and does not decode the
		// cached bytes (Bug1). To exercise the corrupt-bytes regeneration path we must
		// first simulate a LEGACY record with no usable dims, so the hit path falls
		// back to a one-time decode — which fails on the garbage bytes — and re-derives
		// from the original.
		const index = JSON.parse(readFileSync(join(PROJECTS_DIR, projectId, "assets.json"), "utf8")) as Record<string, AssetRecord>;
		const legacyRecord = index[imageId];
		if (legacyRecord) {
			legacyRecord.derivatives = legacyRecord.derivatives.map((d) =>
				d.id === first.derivativeId ? { ...d, width: 0, height: 0, format: undefined } : d,
			);
			writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify(index, null, 2));
		}

		const regenerated = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });

		expect(regenerated.cacheHit).toBe(false);
		expect(regenerated.derivativeId).toBe(first.derivativeId);
		expect(regenerated.buffer.byteLength).toBeGreaterThan(0);
		expect(getAssetRecord(projectId, imageId)?.derivatives.some((item) => item.id === first.derivativeId && item.status === "ready")).toBe(true);
	});

	test("ensureThumbnailDerivative cache HIT returns persisted dims WITHOUT decoding the cached bytes (Bug1)", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		// A real multi-pixel source so the rendered thumbnail has non-trivial dims.
		const srcBuffer = await sharp({
			create: { width: 300, height: 450, channels: 3, background: { r: 10, g: 20, b: 30 } },
		}).png().toBuffer();
		writeFileSync(imagePath, srcBuffer);

		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "src.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: srcBuffer.length,
			});

			// First call GENERATES (decodes the source) and persists output dims.
			__thumbnailTestHooks.reset();
			const first = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
			expect(first.cacheHit).toBe(false);
			expect(__thumbnailTestHooks.decodeCount).toBeGreaterThan(0);
			const persistedDeriv = getAssetRecord(projectId, imageId)?.derivatives.find((d) => d.id === first.derivativeId);
			expect(persistedDeriv?.width).toBe(first.width);
			expect(persistedDeriv?.height).toBe(first.height);
			expect(persistedDeriv?.format).toBe("webp");

			// Second call is a cache HIT: it must return the SAME dims and perform ZERO
			// sharp decodes (no metadata() on the cached buffer).
			__thumbnailTestHooks.reset();
			const second = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
			expect(second.cacheHit).toBe(true);
			expect(second.width).toBe(first.width);
			expect(second.height).toBe(first.height);
			expect(__thumbnailTestHooks.decodeCount).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
			else process.env.OPENAI_MODERATION_ENABLED = previous;
		}
	});

	test("ensureThumbnailDerivative hit path backfills dims for a legacy record then is decode-free (Bug1)", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		const srcBuffer = await sharp({
			create: { width: 300, height: 450, channels: 3, background: { r: 5, g: 5, b: 5 } },
		}).png().toBuffer();
		writeFileSync(imagePath, srcBuffer);

		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "src.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: srcBuffer.length,
			});
			const first = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });

			// Simulate a LEGACY cache entry: the bytes exist but the record lost its dims.
			const index = JSON.parse(readFileSync(join(PROJECTS_DIR, projectId, "assets.json"), "utf8")) as Record<string, AssetRecord>;
			const rec = index[imageId];
			if (rec) {
				rec.derivatives = rec.derivatives.map((d) =>
					d.id === first.derivativeId ? { ...d, width: 0, height: 0, format: undefined } : d,
				);
			}
			writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify(index, null, 2));

			// First hit on the legacy entry decodes ONCE to recover dims and backfills.
			__thumbnailTestHooks.reset();
			const legacyHit = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
			expect(legacyHit.cacheHit).toBe(true);
			expect(legacyHit.width).toBe(first.width);
			expect(legacyHit.height).toBe(first.height);
			expect(__thumbnailTestHooks.decodeCount).toBe(1);

			// The backfill is fire-and-forget; let it settle, then a subsequent hit is decode-free.
			await new Promise((r) => setTimeout(r, 20));
			const backfilled = getAssetRecord(projectId, imageId)?.derivatives.find((d) => d.id === first.derivativeId);
			expect(backfilled?.width).toBe(first.width);
			expect(backfilled?.height).toBe(first.height);

			__thumbnailTestHooks.reset();
			const decodeFree = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
			expect(decodeFree.cacheHit).toBe(true);
			expect(__thumbnailTestHooks.decodeCount).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
			else process.env.OPENAI_MODERATION_ENABLED = previous;
		}
	});

	test("ensureThumbnailDerivative collapses concurrent cache-MISS requests for the same derivative to ONE generation and bounds total concurrency (Bug2)", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		// Distinct source images so each derivative is a genuine cache miss; reuse the
		// SAME image many times to prove inflight de-dup collapses duplicates.
		const projectId = createProjectDir();
		const sharedImageId = `${uuid()}.png`;
		const sharedPath = join(PROJECTS_DIR, projectId, "images", sharedImageId);
		const srcBuffer = await sharp({
			create: { width: 400, height: 600, channels: 3, background: { r: 80, g: 80, b: 80 } },
		}).png().toBuffer();
		writeFileSync(sharedPath, srcBuffer);

		// A pool of distinct images to stampede the semaphore.
		const stampedeIds: string[] = [];
		for (let i = 0; i < 20; i += 1) {
			const id = `${uuid()}.png`;
			writeFileSync(join(PROJECTS_DIR, projectId, "images", id), srcBuffer);
			stampedeIds.push(id);
		}

		try {
			await recordUploadedAsset({
				projectId,
				imageId: sharedImageId,
				originalName: "shared.png",
				filePath: sharedPath,
				mimeType: "image/png",
				sizeBytes: srcBuffer.length,
			});
			for (const id of stampedeIds) {
				await recordUploadedAsset({
					projectId,
					imageId: id,
					originalName: id,
					filePath: join(PROJECTS_DIR, projectId, "images", id),
					mimeType: "image/png",
					sizeBytes: srcBuffer.length,
				});
			}

			// (a) inflight de-dup: 10 concurrent requests for the SAME uncached
			// derivative must collapse to ONE generation (cacheHit=false on exactly one,
			// all share the same buffer + dims, total source decodes for it == 1).
			__thumbnailTestHooks.reset();
			const dedupResults = await Promise.all(
				Array.from({ length: 10 }, () =>
					ensureThumbnailDerivative(projectId, sharedImageId, { width: 96, height: 144 }),
				),
			);
			// All 10 concurrent requests collapsed onto ONE shared generation: the source
			// was decoded EXACTLY ONCE (the dedup invariant) — every awaiter resolved off
			// the same promise, so they all share its result (buffer/dims/derivativeId).
			const dedupFirst = dedupResults[0];
			expect(__thumbnailTestHooks.decodeCount).toBe(1); // the shared job decoded once
			expect(new Set(dedupResults.map((r) => r.derivativeId)).size).toBe(1);
			expect(dedupResults.every((r) => r.buffer === dedupFirst?.buffer)).toBe(true); // same shared result
			expect(dedupResults.every((r) => r.width === dedupFirst?.width)).toBe(true);
			expect(__thumbnailTestHooks.inflightSize).toBe(0); // entry cleaned up on settle

			// (b) semaphore bound: a stampede of distinct uncached derivatives must never
			// exceed the concurrency limit of in-flight generations at once.
			__thumbnailTestHooks.reset();
			await Promise.all(
				stampedeIds.map((id) => ensureThumbnailDerivative(projectId, id, { width: 96, height: 144 })),
			);
			expect(__thumbnailTestHooks.peakConcurrentGenerations).toBeGreaterThan(0);
			expect(__thumbnailTestHooks.peakConcurrentGenerations).toBeLessThanOrEqual(__thumbnailTestHooks.concurrencyLimit);
			expect(__thumbnailTestHooks.inflightSize).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
			else process.env.OPENAI_MODERATION_ENABLED = previous;
		}
	});

	test("ensureThumbnailDerivative inflight-dedup rejects all awaiters and cleans up on generation error (Bug2)", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		// A corrupt SOURCE so generation fails (decode throws) — exercises the error
		// path: every concurrent awaiter must reject and the inflight entry must clear.
		await objectStorage.putProjectImage({ projectId, imageId, buffer: Buffer.from("not-a-real-png") });
		writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify({
			[imageId]: buildAssetRecord(projectId, imageId, { storageKey: `projects/${projectId}/images/${imageId}` }),
		}, null, 2));

		try {
			__thumbnailTestHooks.reset();
			const results = await Promise.allSettled(
				Array.from({ length: 5 }, () =>
					ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 }),
				),
			);
			expect(results.every((r) => r.status === "rejected")).toBe(true);
			// No poisoned cache: the inflight entry is removed so a retry is clean.
			expect(__thumbnailTestHooks.inflightSize).toBe(0);
			await expect(ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 })).rejects.toThrow(ThumbnailSourceDecodeError);
		} finally {
			if (previous === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
			else process.env.OPENAI_MODERATION_ENABLED = previous;
		}
	});

	test("ensureThumbnailDerivative marks corrupt source images as failed thumbnails", async () => {
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		await objectStorage.putProjectImage({
			projectId,
			imageId,
			buffer: Buffer.from("not-a-real-png"),
		});
		const createdAt = new Date().toISOString();
		writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify({
			[imageId]: {
				assetId: imageId,
				projectId,
				imageId,
				originalName: "corrupt.png",
				mimeType: "image/png",
				sizeBytes: 14,
				sha256: "b".repeat(64),
				storageDriver: "local",
				storageKey: `projects/${projectId}/images/${imageId}`,
				width: 1,
				height: 1,
				storageStatus: "released",
				moderation: {
					status: "passed",
					provider: "test",
					checkedAt: createdAt,
				},
				derivatives: [],
				createdAt,
				updatedAt: createdAt,
			},
		}, null, 2));

		await expect(ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 })).rejects.toThrow(ThumbnailSourceDecodeError);
		expect(getAssetRecord(projectId, imageId)?.derivatives.some((item) => item.purpose === "thumbnail" && item.status === "failed")).toBe(true);
	});

	test("storage quota summary counts originals and ready derivative bytes", async () => {
		const previous = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		const pngBuffer = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(imagePath, pngBuffer);

		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "quota.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: pngBuffer.length,
			});
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previous;
			}
		}

		const beforeThumbnail = await summarizeProjectStorageQuota(projectId);
		const thumbnail = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
		const afterThumbnail = await summarizeProjectStorageQuota(projectId);

		expect(beforeThumbnail.originalBytes).toBe(pngBuffer.length);
		expect(beforeThumbnail.derivativeBytes).toBe(0);
		expect(afterThumbnail.derivativeBytes).toBe(thumbnail.buffer.byteLength);
		expect(afterThumbnail.usedBytes).toBe(pngBuffer.length + thumbnail.buffer.byteLength);
		expect(afterThumbnail.workspaceId).toBe(projectId);
	});

	test("storage quota summary counts persisted export artifact bytes", async () => {
		const projectId = createProjectDir();
		const projectDir = join(PROJECTS_DIR, projectId);
		writeFileSync(join(projectDir, "state.json"), JSON.stringify({
			projectId,
			name: "Asset Pipeline Test",
			createdAt: new Date().toISOString(),
			pages: [],
			currentPage: 0,
			targetLang: "th",
			exportRuns: [{
				id: "export-quota-test",
				kind: "batch-zip",
				status: "done",
				filename: "chapter.zip",
				pageIndexes: [0, 1],
				pageCount: 2,
				bytes: 512,
				message: "Exported chapter.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
				artifact: {
					exportId: "export-quota-test.zip",
					storageDriver: "local",
					storageKey: `projects/${projectId}/exports/export-quota-test.zip`,
					filename: "chapter.zip",
					mimeType: "application/zip",
					sizeBytes: 512,
					createdAt: "2026-05-17T00:00:00.000Z",
				},
			}],
		}));

		const summary = await summarizeProjectStorageQuota(projectId);

		expect(summary.exportArtifactBytes).toBe(512);
		expect(summary.exportArtifactCount).toBe(1);
		expect(summary.usedBytes).toBe(512);
	});

	test("storage quota summary aggregates active projects in the same workspace", async () => {
		const workspaceId = `workspace-${uuid()}`;
		const firstProjectId = createProjectDir({ workspaceId });
		const secondProjectId = createProjectDir({ workspaceId });
		writeFileSync(join(PROJECTS_DIR, firstProjectId, "assets.json"), JSON.stringify({
			"first.png": buildAssetRecord(firstProjectId, "first.png", {
				sizeBytes: 70,
				derivatives: [{
					id: "first-thumb",
					purpose: "thumbnail",
					status: "ready",
					width: 1,
					height: 1,
					sourceRect: { x: 0, y: 0, w: 1, h: 1 },
					scale: 1,
					sizeBytes: 15,
					createdAt: "2026-05-28T01:00:00.000Z",
				}],
			}),
		}));
		writeFileSync(join(PROJECTS_DIR, secondProjectId, "assets.json"), JSON.stringify({
			"second.png": buildAssetRecord(secondProjectId, "second.png", { sizeBytes: 80 }),
		}));

		const summary = await summarizeProjectStorageQuota(firstProjectId, 10, {
			workspaceId,
			workspaceProjectIds: [firstProjectId, secondProjectId],
		});

		expect(summary.workspaceId).toBe(workspaceId);
		expect(summary.originalBytes).toBe(150);
		expect(summary.derivativeBytes).toBe(15);
		expect(summary.pendingBytes).toBe(10);
		expect(summary.projectedBytes).toBe(175);
		expect(summary.assetCount).toBe(2);
		expect(summary.derivativeCount).toBe(1);
	});

	test("billing quota fallback aggregates local sibling project states", async () => {
		const workspaceId = `workspace-${uuid()}`;
		const firstProjectId = createProjectDir({ workspaceId });
		const secondProjectId = createProjectDir({ workspaceId });
		writeFileSync(join(PROJECTS_DIR, firstProjectId, "assets.json"), JSON.stringify({
			"first.png": buildAssetRecord(firstProjectId, "first.png", { sizeBytes: 70 }),
		}));
		writeFileSync(join(PROJECTS_DIR, secondProjectId, "assets.json"), JSON.stringify({
			"second.png": buildAssetRecord(secondProjectId, "second.png", { sizeBytes: 80 }),
		}));

		const workspaceSummary = await summarizeProjectStorageQuotaForBilling(firstProjectId, 10);
		const projectViewSummary = await summarizeProjectStorageQuotaForProjectView(firstProjectId, 10);

		expect(workspaceSummary.workspaceId).toBe(workspaceId);
		expect(workspaceSummary.originalBytes).toBe(150);
		expect(workspaceSummary.pendingBytes).toBe(10);
		expect(workspaceSummary.assetCount).toBe(2);
		expect(projectViewSummary.workspaceId).toBe(workspaceId);
		expect(projectViewSummary.scope).toBe("workspace");
		expect(projectViewSummary.originalBytes).toBe(150);
		expect(projectViewSummary.pendingBytes).toBe(10);
		expect(projectViewSummary.assetCount).toBe(2);
		expect(projectViewSummary.projectUsage).toEqual(expect.objectContaining({
			originalBytes: 70,
			pendingBytes: 10,
			assetCount: 1,
		}));
	});

	test("project view quota summaries include active workspace reservations", async () => {
		const workspaceId = `workspace-${uuid()}`;
		const firstProjectId = createProjectDir({ workspaceId });
		const secondProjectId = createProjectDir({ workspaceId });
		const store = new MemoryStorageQuotaReservationStore();
		const restoreStore = setStorageQuotaReservationStoreForTests(store);
		const now = Date.now();

		try {
			await store.reserve({
				projectId: secondProjectId,
				bytes: 40,
				reason: "parallel_project_upload",
				now,
				ttlMs: 60_000,
			});

			const summary = await summarizeProjectStorageQuotaForProjectView(firstProjectId, 10);

			expect(summary.workspaceId).toBe(workspaceId);
			expect(summary.scope).toBe("workspace");
			expect(summary.reservedBytes).toBe(40);
			expect(summary.activeReservationCount).toBe(1);
			expect(summary.projectedBytes).toBe(50);
			expect(summary.remainingBytes).toBe(summary.limitBytes - 50);
			expect(summary.projectUsage).toEqual(expect.objectContaining({
				pendingBytes: 10,
				assetCount: 0,
			}));
		} finally {
			restoreStore();
		}
	});

	// rank3 P1 N+1 fix (storage-quota): the hot project-view path must aggregate the
	// whole workspace in ONE asset query and never double-call for the single-project
	// breakdown. This drives the public entry point through a counting durable store.
	test("project view storage quota issues ONE asset aggregate for N projects and parity-matches the per-project sum", async () => {
		const workspaceId = `workspace-${uuid()}`;
		const firstProjectId = createProjectDir({ workspaceId });
		const secondProjectId = createProjectDir({ workspaceId });
		const thirdProjectId = createProjectDir({ workspaceId });

		const durable = new CountingDurableAssetStore();
		durable.seed(buildAssetRecord(firstProjectId, "first.png", {
			sizeBytes: 70,
			derivatives: [{
				id: "first-thumb", purpose: "thumbnail", status: "ready", width: 1, height: 1,
				sourceRect: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, sizeBytes: 15, createdAt: "2026-05-28T01:00:00.000Z",
			}],
		}));
		durable.seed(buildAssetRecord(secondProjectId, "second.png", { sizeBytes: 80 }));
		durable.seed(buildAssetRecord(thirdProjectId, "third.png", { sizeBytes: 30 }));
		const restoreStore = setAssetStoreForTests(durable);

		try {
			durable.resetCounts();
			const summary = await summarizeProjectStorageQuotaForProjectView(firstProjectId, 10);

			// Byte parity with the OLD per-project list+reduce over the same rows.
			expect(summary.originalBytes).toBe(180); // 70 + 80 + 30
			expect(summary.derivativeBytes).toBe(15);
			expect(summary.assetCount).toBe(3);
			expect(summary.derivativeCount).toBe(1);
			expect(summary.pendingBytes).toBe(10);
			expect(summary.scope).toBe("workspace");
			// Single-project breakdown served from the SAME aggregate (no extra call).
			expect(summary.projectUsage).toEqual(expect.objectContaining({
				originalBytes: 70,
				derivativeBytes: 15,
				assetCount: 1,
			}));

			// EXACTLY one workspace aggregate served the whole project-view, and the
			// per-project listByProject N+1 is gone entirely.
			expect(durable.summarizeCalls).toBe(1);
			expect(durable.listByProjectCalls).toBe(0);
		} finally {
			restoreStore();
		}
	});

	test("storage quota config lets plan storage and add-ons override Docker placeholder defaults", () => {
		const previousIncluded = process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
		const previousExtra = process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
		process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = String(2 * GIB);
		process.env.WORKSPACE_STORAGE_EXTRA_BYTES = "0";

		try {
			const config = readStorageQuotaConfig({
				planId: "pro",
				includedBytes: 25 * GIB,
				extraBytes: 50 * GIB,
			});
			expect(config.includedBytes).toBe(25 * GIB);
			expect(config.extraBytes).toBe(50 * GIB);
			expect(config.limitBytes).toBe(75 * GIB);
			const zeroStorageConfig = readStorageQuotaConfig({
				planId: "free",
				includedBytes: 0,
				extraBytes: 0,
			});
			expect(zeroStorageConfig.includedBytes).toBe(0);
			expect(zeroStorageConfig.limitBytes).toBe(0);
		} finally {
			if (previousIncluded === undefined) {
				delete process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
			} else {
				process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = previousIncluded;
			}
			if (previousExtra === undefined) {
				delete process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
			} else {
				process.env.WORKSPACE_STORAGE_EXTRA_BYTES = previousExtra;
			}
		}
	});

	test("storage quota check blocks writes that would exceed the workspace limit", async () => {
		const previousModeration = process.env.OPENAI_MODERATION_ENABLED;
		const previousIncluded = process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
		const previousExtra = process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
		const previousEnforced = process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		process.env.WORKSPACE_STORAGE_EXTRA_BYTES = "0";
		process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED = "true";
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const imagePath = join(PROJECTS_DIR, projectId, "images", imageId);
		const pngBuffer = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(imagePath, pngBuffer);
		process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = String(pngBuffer.length);

		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "quota.png",
				filePath: imagePath,
				mimeType: "image/png",
				sizeBytes: pngBuffer.length,
			});

			await expect(assertProjectStorageQuota(projectId, 1, "image_upload")).rejects.toThrow(StorageQuotaExceededError);
			const summary = await summarizeProjectStorageQuota(projectId, 1);
			expect(summary.remainingBytes).toBe(0);
			expect(summary.percentUsed).toBeGreaterThan(100);
		} finally {
			if (previousModeration === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previousModeration;
			}
			if (previousIncluded === undefined) {
				delete process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
			} else {
				process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = previousIncluded;
			}
			if (previousExtra === undefined) {
				delete process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
			} else {
				process.env.WORKSPACE_STORAGE_EXTRA_BYTES = previousExtra;
			}
			if (previousEnforced === undefined) {
				delete process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED;
			} else {
				process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED = previousEnforced;
			}
		}
	});

	test("storage quota reservations count active pending uploads before writes", async () => {
		const previousIncluded = process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
		const previousExtra = process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
		const previousEnforced = process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED;
		process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = "100";
		process.env.WORKSPACE_STORAGE_EXTRA_BYTES = "0";
		process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED = "true";
		const projectId = createProjectDir();
		const store = new MemoryStorageQuotaReservationStore();
		const now = Date.parse("2026-05-28T04:00:00.000Z");

		try {
			const first = await store.reserve({
				projectId,
				bytes: 70,
				reason: "image_upload",
				now,
				ttlMs: 60_000,
			});

			expect(first.summary.pendingBytes).toBe(70);
			expect(first.summary.reservedBytes).toBe(0);
			expect(first.summary.projectedBytes).toBe(70);
			await expect(assertProjectStorageQuota(projectId, 40, "export_artifact", {
				reservationStore: store,
				now: now + 1_000,
			})).rejects.toThrow(StorageQuotaExceededError);
			const sharedWorkspaceStore = new MemoryStorageQuotaReservationStore();
			await sharedWorkspaceStore.reserve({
				projectId: uuid(),
				workspaceId: "workspace-storage-shared",
				bytes: 70,
				reason: "parallel_project_upload",
				now,
				ttlMs: 60_000,
			});
			await expect(sharedWorkspaceStore.reserve({
				projectId: uuid(),
				workspaceId: "workspace-storage-shared",
				bytes: 40,
				reason: "parallel_project_upload",
				now: now + 1_000,
				ttlMs: 60_000,
			})).rejects.toThrow(StorageQuotaExceededError);
			await expect(store.reserve({
				projectId,
				bytes: 40,
				reason: "image_upload",
				now: now + 2_000,
				ttlMs: 60_000,
			})).rejects.toThrow(StorageQuotaExceededError);

			expect(await store.release(projectId, first.reservation.reservationId)).toBe(true);
			const second = await store.reserve({
				projectId,
				bytes: 40,
				reason: "image_upload",
				now: now + 3_000,
				ttlMs: 60_000,
			});
			expect(second.summary.projectedBytes).toBe(40);
			await expect(assertProjectStorageQuota(projectId, 40, "export_artifact", {
				reservationStore: store,
				now: now + 4_000,
			})).resolves.toMatchObject({
				projectedBytes: 80,
				reservedBytes: 40,
				activeReservationCount: 1,
			});
		} finally {
			if (previousIncluded === undefined) {
				delete process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
			} else {
				process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = previousIncluded;
			}
			if (previousExtra === undefined) {
				delete process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
			} else {
				process.env.WORKSPACE_STORAGE_EXTRA_BYTES = previousExtra;
			}
			if (previousEnforced === undefined) {
				delete process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED;
			} else {
				process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED = previousEnforced;
			}
		}
	});

	test("storage quota summaries include active reservations", async () => {
		const previousIncluded = process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
		const previousExtra = process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
		const previousEnforced = process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED;
		process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = "100";
		process.env.WORKSPACE_STORAGE_EXTRA_BYTES = "0";
		process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED = "true";
		const projectId = createProjectDir();
		const store = new MemoryStorageQuotaReservationStore();
		const now = Date.now();
		try {
			await store.reserve({
				projectId,
				bytes: 35,
				reason: "image_upload",
				now,
				ttlMs: 60_000,
			});

			const summary = await assertProjectStorageQuota(projectId, 0, "summary_test", {
				reservationStore: store,
				now: now + 1_000,
			});

			expect(summary).toMatchObject({
				reservedBytes: 35,
				activeReservationCount: 1,
				projectedBytes: 35,
				remainingBytes: 65,
			});
		} finally {
			if (previousIncluded === undefined) {
				delete process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
			} else {
				process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = previousIncluded;
			}
			if (previousExtra === undefined) {
				delete process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
			} else {
				process.env.WORKSPACE_STORAGE_EXTRA_BYTES = previousExtra;
			}
			if (previousEnforced === undefined) {
				delete process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED;
			} else {
				process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED = previousEnforced;
			}
		}
	});
});

/**
 * Durable store that counts the read methods so the storage-quota project-view
 * path can assert it issues exactly ONE workspace aggregate and ZERO per-project
 * list queries (the N+1 that the rank3 P1 fix removed). Aggregation parity is
 * exercised via the real {@link computeProjectAssetUsage} helper.
 */
class CountingDurableAssetStore implements AssetStore {
	readonly records = new Map<string, AssetRecord>();
	summarizeCalls = 0;
	listByProjectCalls = 0;

	private key(projectId: string, assetId: string): string {
		return `${projectId}\0${assetId}`;
	}

	seed(record: AssetRecord): void {
		this.records.set(this.key(record.projectId, record.assetId), record);
	}

	resetCounts(): void {
		this.summarizeCalls = 0;
		this.listByProjectCalls = 0;
	}

	async write(record: AssetRecord): Promise<AssetRecord> {
		this.seed(record);
		return record;
	}

	async get(projectId: string, assetId: string): Promise<AssetRecord | undefined> {
		return this.records.get(this.key(projectId, assetId));
	}

	async listByProject(projectId: string): Promise<AssetRecord[]> {
		this.listByProjectCalls += 1;
		return [...this.records.values()].filter((record) => record.projectId === projectId);
	}

	async listPageByProject(projectId: string): Promise<{ assets: AssetRecord[]; nextCursor?: string }> {
		return { assets: await this.listByProject(projectId) };
	}

	async summarizeByWorkspace(_workspaceId: string, projectIds?: string[]): Promise<WorkspaceAssetUsage> {
		this.summarizeCalls += 1;
		const scope = new Set(projectIds ?? []);
		const grouped = new Map<string, AssetRecord[]>();
		for (const record of this.records.values()) {
			if (projectIds && projectIds.length > 0 && !scope.has(record.projectId)) continue;
			const bucket = grouped.get(record.projectId) ?? [];
			bucket.push(record);
			grouped.set(record.projectId, bucket);
		}
		const usage: WorkspaceAssetUsage = new Map();
		for (const [projectId, records] of grouped) {
			usage.set(projectId, computeProjectAssetUsage(records));
		}
		return usage;
	}

	async remove(projectId: string, assetId: string): Promise<boolean> {
		return this.records.delete(this.key(projectId, assetId));
	}

	async updateDerivatives(): Promise<AssetRecord | undefined> {
		return undefined;
	}

	async updateModeration(): Promise<AssetRecord | undefined> {
		return undefined;
	}

	async getWriteContext(projectId: string, assetId: string): Promise<AssetWriteContext | undefined> {
		return this.records.has(this.key(projectId, assetId)) ? {} : undefined;
	}

	async getManyByProject(projectId: string, assetIds: string[]): Promise<Map<string, AssetRecord>> {
		const out = new Map<string, AssetRecord>();
		for (const assetId of assetIds) {
			const record = this.records.get(this.key(projectId, assetId));
			if (record) out.set(assetId, record);
		}
		return out;
	}

	async getManyWriteContexts(projectId: string, assetIds: string[]): Promise<Map<string, AssetWriteContext>> {
		const out = new Map<string, AssetWriteContext>();
		for (const assetId of assetIds) {
			if (this.records.has(this.key(projectId, assetId))) out.set(assetId, {});
		}
		return out;
	}

	async removeManyByProject(projectId: string, assetIds: string[]): Promise<Set<string>> {
		const removed = new Set<string>();
		for (const assetId of assetIds) {
			if (this.records.delete(this.key(projectId, assetId))) removed.add(assetId);
		}
		return removed;
	}
}

/**
 * Minimal in-memory durable store standing in for the Postgres asset store. It
 * records the write contexts (to assert workspace inference) and remove calls
 * (to assert the durable row is deleted), and serves listByProject for mirror
 * hydration. Selected via setAssetStoreForTests so the postgres-mode branches in
 * assets.ts run without a live database.
 */
class InMemoryDurableAssetStore implements AssetStore {
	readonly records = new Map<string, AssetRecord>();
	readonly contexts = new Map<string, AssetWriteContext>();
	readonly writeContexts: AssetWriteContext[] = [];
	readonly removed: Array<{ projectId: string; assetId: string }> = [];

	private key(projectId: string, assetId: string): string {
		return `${projectId}\0${assetId}`;
	}

	async write(record: AssetRecord, context: AssetWriteContext = {}): Promise<AssetRecord> {
		this.writeContexts.push(context);
		this.records.set(this.key(record.projectId, record.assetId), record);
		// Mirror PostgresAssetStore: the upsert overwrites workspace_id/metadata from
		// the supplied context, so persist it for getWriteContext to recover later.
		this.contexts.set(this.key(record.projectId, record.assetId), context);
		return record;
	}

	async get(projectId: string, assetId: string): Promise<AssetRecord | undefined> {
		return this.records.get(this.key(projectId, assetId));
	}

	async listByProject(projectId: string): Promise<AssetRecord[]> {
		return [...this.records.values()].filter((record) => record.projectId === projectId);
	}

	async listPageByProject(projectId: string): Promise<{ assets: AssetRecord[]; nextCursor?: string }> {
		return { assets: await this.listByProject(projectId) };
	}

	async summarizeByWorkspace(workspaceId: string, projectIds?: string[]): Promise<WorkspaceAssetUsage> {
		// Mirror PostgresAssetStore.summarizeByWorkspace: scope by the resolved
		// project list when provided (parity with the per-project path), else by the
		// row's persisted workspace_id. Group the in-memory records by project and
		// reduce each group via the shared usage helper.
		const grouped = new Map<string, AssetRecord[]>();
		for (const record of this.records.values()) {
			const inScope = projectIds && projectIds.length > 0
				? projectIds.includes(record.projectId)
				: (this.contexts.get(this.key(record.projectId, record.assetId))?.workspaceId ?? undefined) === workspaceId;
			if (!inScope) continue;
			const bucket = grouped.get(record.projectId) ?? [];
			bucket.push(record);
			grouped.set(record.projectId, bucket);
		}
		const usage: WorkspaceAssetUsage = new Map();
		for (const [projectId, records] of grouped) {
			usage.set(projectId, computeProjectAssetUsage(records));
		}
		return usage;
	}

	async remove(projectId: string, assetId: string): Promise<boolean> {
		this.removed.push({ projectId, assetId });
		this.contexts.delete(this.key(projectId, assetId));
		return this.records.delete(this.key(projectId, assetId));
	}

	async updateDerivatives(projectId: string, assetId: string, derivatives: AssetDerivative[]): Promise<AssetRecord | undefined> {
		const existing = this.records.get(this.key(projectId, assetId));
		if (!existing) return undefined;
		// Targeted update mirroring PostgresAssetStore.updateDerivatives: only the
		// derivative list + updatedAt change; the rest of the durable record (and,
		// in Postgres, workspace_id/metadata) is untouched.
		const updated: AssetRecord = { ...existing, derivatives, updatedAt: new Date().toISOString() };
		this.records.set(this.key(projectId, assetId), updated);
		return updated;
	}

	async updateModeration(projectId: string, assetId: string, moderation: AssetModerationResult, storageStatus?: AssetStorageStatus): Promise<AssetRecord | undefined> {
		const existing = this.records.get(this.key(projectId, assetId));
		if (!existing) return undefined;
		const updated: AssetRecord = {
			...existing,
			moderation,
			storageStatus: storageStatus ?? existing.storageStatus,
			updatedAt: new Date().toISOString(),
		};
		this.records.set(this.key(projectId, assetId), updated);
		return updated;
	}

	async getWriteContext(projectId: string, assetId: string): Promise<AssetWriteContext | undefined> {
		// Mirror PostgresAssetStore.getWriteContext: workspace_id/metadata live on
		// the row (not on AssetRecord), so recover the persisted context for rollback.
		if (!this.records.has(this.key(projectId, assetId))) return undefined;
		return this.contexts.get(this.key(projectId, assetId)) ?? {};
	}

	async getManyByProject(projectId: string, assetIds: string[]): Promise<Map<string, AssetRecord>> {
		const out = new Map<string, AssetRecord>();
		for (const assetId of assetIds) {
			const record = this.records.get(this.key(projectId, assetId));
			if (record) out.set(assetId, record);
		}
		return out;
	}

	async getManyWriteContexts(projectId: string, assetIds: string[]): Promise<Map<string, AssetWriteContext>> {
		const out = new Map<string, AssetWriteContext>();
		for (const assetId of assetIds) {
			if (this.records.has(this.key(projectId, assetId))) {
				out.set(assetId, this.contexts.get(this.key(projectId, assetId)) ?? {});
			}
		}
		return out;
	}

	async removeManyByProject(projectId: string, assetIds: string[]): Promise<Set<string>> {
		const removed = new Set<string>();
		for (const assetId of assetIds) {
			this.removed.push({ projectId, assetId });
			this.contexts.delete(this.key(projectId, assetId));
			if (this.records.delete(this.key(projectId, assetId))) removed.add(assetId);
		}
		return removed;
	}
}

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

describe("asset registry postgres-mode mirror", () => {
	test("removeAssetRecord deletes the durable DB row, not only the JSON mirror", async () => {
		const previousModeration = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		writeFileSync(join(PROJECTS_DIR, projectId, "images", imageId), TINY_PNG);
		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				imageBuffer: TINY_PNG,
				mimeType: "image/png",
				sizeBytes: TINY_PNG.length,
			});
			// The durable store has the row and the JSON mirror sees it.
			expect(durable.records.size).toBe(1);
			expect(listAssetRecords(projectId).map((asset) => asset.assetId)).toEqual([imageId]);

			const removed = removeAssetRecord(projectId, imageId);
			expect(removed).toBe(true);
			// The best-effort DB delete is fired async; let the microtask settle.
			await Promise.resolve();
			await Promise.resolve();
			expect(durable.removed).toEqual([{ projectId, assetId: imageId }]);
			expect(durable.records.size).toBe(0);
		} finally {
			restoreStore();
			if (previousModeration === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previousModeration;
			}
		}
	});

	test("postgres-mode listing hydrates persisted rows from the durable store after a lost mirror", async () => {
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = "persisted.png";
		// Durable row exists but the JSON mirror on disk is empty (clean disk).
		await durable.write(buildAssetRecord(projectId, imageId), { workspaceId: "workspace-x" });
		try {
			expect(listAssetRecords(projectId).length).toBeGreaterThanOrEqual(0);
			// Awaitable hydration repopulates the mirror so sync reads observe the row.
			await hydrateAssetMirrorForProject(projectId);
			expect(listAssetRecords(projectId).map((asset) => asset.assetId)).toEqual([imageId]);
			expect(getAssetRecord(projectId, imageId)?.imageId).toBe(imageId);
			expect(listAssetRecordPage(projectId, { limit: 10 }).assets.map((asset) => asset.assetId)).toEqual([imageId]);
		} finally {
			restoreStore();
		}
	});

	// Round-2 #1: a NON-EMPTY but stale JSON mirror must not hide durable rows.
	// The round-1 hydration only ran when the mirror was empty, so a second
	// instance / restarted container / DB-restored project (mirror present but
	// out of date) would serve the wrong list. The authoritative listing reads
	// straight from the store regardless of mirror contents.
	test("authoritative listing reflects the durable store even when the JSON mirror is stale and non-empty", async () => {
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const durableImageId = "from-db.png";
		const staleImageId = "stale-mirror-only.png";
		// Durable store (source of truth) holds the real row.
		await durable.write(buildAssetRecord(projectId, durableImageId), { workspaceId: "ws" });
		// The on-disk mirror is NON-EMPTY but stale: it lists a different asset that
		// no longer exists in the durable store, and is missing the durable row.
		writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify({
			[staleImageId]: buildAssetRecord(projectId, staleImageId),
		}));
		try {
			// Round-1 sync helper trusts the stale mirror (bug surface).
			expect(listAssetRecords(projectId).map((a) => a.assetId)).toEqual([staleImageId]);
			// Authoritative listing ignores the stale mirror and returns the DB row.
			const authoritative = await listAssetRecordsAuthoritative(projectId);
			expect(authoritative.map((a) => a.assetId)).toEqual([durableImageId]);
			const page = await listAssetRecordPageAuthoritative(projectId, { limit: 10 });
			expect(page.assets.map((a) => a.assetId)).toEqual([durableImageId]);
			// Authoritative single lookup likewise comes from the DB, not the mirror.
			expect((await getAssetRecordAuthoritative(projectId, durableImageId))?.imageId).toBe(durableImageId);
			expect(await getAssetRecordAuthoritative(projectId, staleImageId)).toBeUndefined();
		} finally {
			restoreStore();
		}
	});

	// Round-2 #5: in postgres mode with a missing mirror, a blocked/quarantined
	// asset that exists in asset_records must not be treated as servable. The
	// authoritative lookup awaits the durable store before deciding.
	test("authoritative lookup surfaces a blocked durable asset even with an empty JSON mirror", async () => {
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = "blocked.png";
		// Durable row is blocked; the JSON mirror on disk is empty (clean disk).
		await durable.write(buildAssetRecord(projectId, imageId, {
			storageStatus: "blocked",
			moderation: { status: "blocked", provider: "test", checkedAt: "2026-05-28T01:00:00.000Z" },
		}), { workspaceId: "ws" });
		try {
			// The stale-mirror sync helper would see nothing and treat it as missing.
			expect(getAssetRecord(projectId, imageId)).toBeUndefined();
			// Authoritative lookup returns the blocked row, so callers can refuse it.
			const asset = await getAssetRecordAuthoritative(projectId, imageId);
			expect(asset?.storageStatus).toBe("blocked");
			expect(asset?.moderation.status).toBe("blocked");
			// AI readiness must reject the blocked asset (it exists durably), instead
			// of mistaking the empty mirror for an unregistered/legacy asset.
			await expect(assertAssetReadyForAiAuthoritative(projectId, imageId)).rejects.toThrow(/moderation status is blocked|not released/);
		} finally {
			restoreStore();
		}
	});

	test("authoritative AI readiness rejects durable assets that still need moderation review", async () => {
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = "needs-review.png";
		await durable.write(buildAssetRecord(projectId, imageId, {
			storageStatus: "released",
			moderation: { status: "needs_review", provider: "test", checkedAt: "2026-06-02T00:00:00.000Z" },
		}), { workspaceId: "ws" });
		try {
			await expect(assertAssetReadyForAiAuthoritative(projectId, imageId))
				.rejects.toThrow(`Asset ${imageId} moderation status is needs_review`);
		} finally {
			restoreStore();
		}
	});

	// Round-2 #2: restore after a failed object-delete must re-insert the durable
	// row, not only rewrite the JSON mirror. Otherwise the async DELETE drops the
	// asset_records row while the object remains.
	test("authoritative restore re-inserts the durable row after an upload-cleanup rollback", async () => {
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = "rollback.png";
		const record = buildAssetRecord(projectId, imageId);
		await durable.write(record, { workspaceId: "ws" });
		try {
			// Simulate the cleanup delete (authoritative): durable row is removed.
			const removed = await removeAssetRecordAuthoritative(projectId, imageId);
			expect(removed).toBe(true);
			expect(await durable.get(projectId, imageId)).toBeUndefined();
			// Object delete failed → rollback restores the durable row, not just JSON.
			await restoreAssetRecordAuthoritative(projectId, record, { workspaceId: "ws" });
			expect((await durable.get(projectId, imageId))?.imageId).toBe(imageId);
			expect((await listAssetRecordsAuthoritative(projectId)).map((a) => a.assetId)).toEqual([imageId]);
		} finally {
			restoreStore();
		}
	});

	// Round-2 #2 (companion): removeAssetRecordAuthoritative awaits the durable
	// DELETE so async callers (upload cleanup / AI rollback) cannot race the
	// object delete.
	test("authoritative remove awaits the durable DELETE", async () => {
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = "await-delete.png";
		await durable.write(buildAssetRecord(projectId, imageId), { workspaceId: "ws" });
		try {
			await removeAssetRecordAuthoritative(projectId, imageId);
			// No microtask flushing needed: the DELETE is awaited inline.
			expect(durable.removed).toEqual([{ projectId, assetId: imageId }]);
			expect(durable.records.size).toBe(0);
		} finally {
			restoreStore();
		}
	});

	// Round-2 #3: thumbnail derivative metadata + sizeBytes must persist to the
	// durable store, not only assets.json. After a clean disk / DB restore the
	// ready derivative must still be present on the asset_records row.
	test("thumbnail generation persists the derivative to the durable store", async () => {
		const previousModeration = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		writeFileSync(join(PROJECTS_DIR, projectId, "images", imageId), TINY_PNG);
		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				imageBuffer: TINY_PNG,
				mimeType: "image/png",
				sizeBytes: TINY_PNG.length,
			});
			// Wipe the on-disk mirror to prove persistence does not depend on it.
			writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify({}));
			const thumbnail = await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
			// The durable row carries the ready thumbnail derivative with its bytes.
			const durableRecord = await durable.get(projectId, imageId);
			const ready = durableRecord?.derivatives.find((d) => d.purpose === "thumbnail" && d.status === "ready");
			expect(ready).toBeDefined();
			expect(ready?.sizeBytes).toBe(thumbnail.buffer.byteLength);
			// And it is observable through the authoritative lookup after a lost mirror.
			const authoritative = await getAssetRecordAuthoritative(projectId, imageId);
			expect(authoritative?.derivatives.some((d) => d.status === "ready" && d.purpose === "thumbnail")).toBe(true);
		} finally {
			restoreStore();
			if (previousModeration === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previousModeration;
			}
		}
	});

	// Round-2 #3 (companion): updateDerivatives must not clobber the durable
	// workspace context (workspace_id/metadata) that a full upsert would overwrite.
	test("persisting a derivative preserves the durable workspace context", async () => {
		const previousModeration = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir({ workspaceId: "ws-keep" });
		const imageId = `${uuid()}.png`;
		writeFileSync(join(PROJECTS_DIR, projectId, "images", imageId), TINY_PNG);
		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				imageBuffer: TINY_PNG,
				mimeType: "image/png",
				sizeBytes: TINY_PNG.length,
			});
			expect(durable.writeContexts).toHaveLength(1);
			expect(durable.writeContexts[0]?.workspaceId).toBe("ws-keep");
			await ensureThumbnailDerivative(projectId, imageId, { width: 96, height: 144 });
			// The derivative update went through updateDerivatives (targeted), so no
			// additional full write() was issued that could clobber workspace context.
			expect(durable.writeContexts).toHaveLength(1);
		} finally {
			restoreStore();
			if (previousModeration === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previousModeration;
			}
		}
	});

	// Round-2 #4: the test source must stay plain text (no embedded NUL byte), so
	// ripgrep does not treat this file as binary. Guards against regressions in
	// the InMemoryDurableAssetStore key separator.
	test("this test source contains no embedded NUL byte", () => {
		const source = readFileSync(resolve(import.meta.dir, "asset-pipeline.test.ts"), "utf8");
		expect(source.includes("\0")).toBe(false);
	});

	test("recordUploadedAsset infers workspace_id from project state when only projectId is passed", async () => {
		const previousModeration = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir({ workspaceId: "workspace-from-state" });
		const imageId = `${uuid()}.png`;
		writeFileSync(join(PROJECTS_DIR, projectId, "images", imageId), TINY_PNG);
		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				imageBuffer: TINY_PNG,
				mimeType: "image/png",
				sizeBytes: TINY_PNG.length,
			});
			expect(durable.writeContexts).toHaveLength(1);
			expect(durable.writeContexts[0]?.workspaceId).toBe("workspace-from-state");
		} finally {
			restoreStore();
			if (previousModeration === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previousModeration;
			}
		}
	});

	test("explicit workspaceId still overrides the inferred project workspace", async () => {
		const previousModeration = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir({ workspaceId: "workspace-from-state" });
		const imageId = `${uuid()}.png`;
		writeFileSync(join(PROJECTS_DIR, projectId, "images", imageId), TINY_PNG);
		try {
			await recordUploadedAsset({
				projectId,
				workspaceId: "explicit-workspace",
				imageId,
				originalName: "tiny.png",
				imageBuffer: TINY_PNG,
				mimeType: "image/png",
				sizeBytes: TINY_PNG.length,
			});
			expect(durable.writeContexts[0]?.workspaceId).toBe("explicit-workspace");
		} finally {
			restoreStore();
			if (previousModeration === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previousModeration;
			}
		}
	});

	// Round-3 #2: in postgres mode the JSON mirror write is a best-effort,
	// non-authoritative cache. A local-disk failure (read-only / full volume)
	// after the durable object + DB row are committed must NOT fail the upload —
	// otherwise a successful durable upload is wrongly reported as a failure and
	// cleaned up.
	test("recordUploadedAsset does not fail when the best-effort mirror write throws", async () => {
		const previousModeration = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir({ workspaceId: "ws-mirror" });
		const imageId = `${uuid()}.png`;
		writeFileSync(join(PROJECTS_DIR, projectId, "images", imageId), TINY_PNG);
		// Force the local mirror write to fail by deleting the project dir out from
		// under it (writeAssetIndex can no longer persist assets.json).
		rmSync(join(PROJECTS_DIR, projectId), { recursive: true, force: true });
		try {
			const record = await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				imageBuffer: TINY_PNG,
				mimeType: "image/png",
				sizeBytes: TINY_PNG.length,
			});
			// The durable write succeeded and is returned despite the mirror failure.
			expect(record.assetId).toBe(imageId);
			expect(await durable.get(projectId, imageId)).toBeDefined();
		} finally {
			restoreStore();
			if (previousModeration === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previousModeration;
			}
		}
	});

	// Round-3 #3: workspace inference must be billing-INDEPENDENT. The catalog
	// lookup now uses getProjectWorkspaceStoragePlan (which coalesces to `free` and
	// resolves the workspace from the projects->workspaces join), not
	// getProjectWorkspacePlan (which returns null unless an ACTIVE billing account
	// exists). So a free / no-billing project still persists its workspace_id.
	test("recordUploadedAsset populates workspace_id for a no-billing project via the catalog", async () => {
		const previousModeration = process.env.OPENAI_MODERATION_ENABLED;
		process.env.OPENAI_MODERATION_ENABLED = "false";
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		// Stub catalog: getProjectWorkspacePlan would return null (no billing), but
		// the billing-independent storage-plan lookup resolves the workspace.
		const restoreCatalog = setWorkspaceLookupCatalogStoreForTests({
			async getProjectWorkspaceStoragePlan(projectId: string) {
				return {
					projectId,
					workspaceId: "workspace-free-no-billing",
					planId: "free",
					includedStorageBytes: undefined,
					extraStorageBytes: 0,
					projectIds: [projectId],
				};
			},
		});
		// Project id with NO on-disk state.json, so the only workspace source is the
		// catalog lookup (proving the billing-independent path resolves it).
		const projectId = uuid();
		mkdirSync(join(PROJECTS_DIR, projectId, "images"), { recursive: true });
		createdProjectDirs.push(join(PROJECTS_DIR, projectId));
		const imageId = `${uuid()}.png`;
		writeFileSync(join(PROJECTS_DIR, projectId, "images", imageId), TINY_PNG);
		try {
			await recordUploadedAsset({
				projectId,
				imageId,
				originalName: "tiny.png",
				imageBuffer: TINY_PNG,
				mimeType: "image/png",
				sizeBytes: TINY_PNG.length,
			});
			expect(durable.writeContexts).toHaveLength(1);
			expect(durable.writeContexts[0]?.workspaceId).toBe("workspace-free-no-billing");
		} finally {
			restoreCatalog();
			restoreStore();
			if (previousModeration === undefined) {
				delete process.env.OPENAI_MODERATION_ENABLED;
			} else {
				process.env.OPENAI_MODERATION_ENABLED = previousModeration;
			}
		}
	});

	// Round-3 #4: a rollback after a failed object-delete must preserve the row's
	// workspace_id + metadata. These live on the durable row but are NOT carried on
	// AssetRecord, so the cleanup path captures the write context before delete and
	// passes it back to restore — otherwise the re-inserted row would have a NULL
	// workspace_id and dropped reservation metadata.
	test("getAssetWriteContextAuthoritative recovers workspace/metadata for restore", async () => {
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = "rollback-context.png";
		const record = buildAssetRecord(projectId, imageId);
		const originalContext = { workspaceId: "ws-rollback", metadata: { storageReservationId: "res-42" } };
		await durable.write(record, originalContext);
		try {
			// Cleanup captures the durable context BEFORE deleting the row.
			const captured = await getAssetWriteContextAuthoritative(projectId, imageId);
			expect(captured).toEqual(originalContext);

			// Simulate cleanup: delete the durable row, then object-delete fails.
			await removeAssetRecordAuthoritative(projectId, imageId);
			expect(await durable.get(projectId, imageId)).toBeUndefined();

			// Rollback restores the row WITH the captured context (not an empty one).
			await restoreAssetRecordAuthoritative(projectId, record, captured ?? {});
			expect((await durable.get(projectId, imageId))?.imageId).toBe(imageId);
			// The re-inserted row keeps its workspace + reservation metadata.
			const afterRestore = durable.writeContexts.at(-1);
			expect(afterRestore?.workspaceId).toBe("ws-rollback");
			expect(afterRestore?.metadata).toEqual({ storageReservationId: "res-42" });
			expect(await getAssetWriteContextAuthoritative(projectId, imageId)).toEqual(originalContext);
		} finally {
			restoreStore();
		}
	});

	// Round-3 #4 (companion): a rollback that does NOT recapture context would null
	// the workspace_id — this documents the regression the capture-before-delete
	// guards against.
	test("restoring without the captured context drops workspace_id (regression guard)", async () => {
		const durable = new InMemoryDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = "rollback-naive.png";
		const record = buildAssetRecord(projectId, imageId);
		await durable.write(record, { workspaceId: "ws-original", metadata: { storageReservationId: "res-1" } });
		try {
			await removeAssetRecordAuthoritative(projectId, imageId);
			// Naive restore with an empty context (the old behavior).
			await restoreAssetRecordAuthoritative(projectId, record);
			const naive = await getAssetWriteContextAuthoritative(projectId, imageId);
			expect(naive?.workspaceId).toBeUndefined();
			expect(naive?.metadata).toBeUndefined();
		} finally {
			restoreStore();
		}
	});
});

/**
 * Durable store whose authoritative removals can be forced to fail, to exercise
 * the upload-cleanup data-integrity invariant: an object is deleted ONLY when its
 * record removal is confirmed. `failBatchRemove` makes the batched DELETE
 * (removeManyByProject) throw; `failPerImageRemove` makes the per-image fallback
 * (remove) throw too. Records that fail to delete stay in the store.
 */
class RemoveFailingDurableAssetStore extends InMemoryDurableAssetStore {
	failBatchRemove = false;
	failPerImageRemove = false;

	override async removeManyByProject(projectId: string, assetIds: string[]): Promise<Set<string>> {
		if (this.failBatchRemove) {
			throw new Error("simulated batch DELETE failure");
		}
		return super.removeManyByProject(projectId, assetIds);
	}

	override async remove(projectId: string, assetId: string): Promise<boolean> {
		if (this.failPerImageRemove) {
			throw new Error("simulated per-image DELETE failure");
		}
		return super.remove(projectId, assetId);
	}
}

describe("upload-cleanup object-delete integrity (round-3 P1b)", () => {
	const TINY = TINY_PNG;

	async function seedUploadedObject(durable: InMemoryDurableAssetStore, projectId: string, imageId: string): Promise<void> {
		// The object is written to storage AND a durable asset record points at it —
		// the steady state after a successful per-image upload step.
		await objectStorage.putProjectImage({ projectId, imageId, buffer: TINY });
		await durable.write(buildAssetRecord(projectId, imageId), { workspaceId: "ws" });
	}

	async function objectExists(projectId: string, imageId: string): Promise<boolean> {
		return await objectStorage.hasProjectImage({ projectId, imageId });
	}

	// The regression: when removeAssetRecordsAuthoritativeBatch throws, the old code
	// emptied removedAssetIds yet STILL object-deleted every image — leaving the
	// surviving DB rows pointing at deleted objects. With the fix, the per-image
	// fallback deletes the records first, so the objects are only deleted once each
	// record removal is confirmed. Records gone + objects gone, integrity preserved.
	test("batch DELETE failure falls back to per-image deletes; objects deleted only after confirmed record removal", async () => {
		const durable = new RemoveFailingDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageA = "a.png";
		const imageB = "b.png";
		try {
			await seedUploadedObject(durable, projectId, imageA);
			await seedUploadedObject(durable, projectId, imageB);
			durable.failBatchRemove = true; // batch path throws -> per-image fallback

			await cleanupUncommittedUploadObjects(projectId, [imageA, imageB]);

			// Records were removed by the fallback, so their objects were safe to delete.
			expect(await durable.get(projectId, imageA)).toBeUndefined();
			expect(await durable.get(projectId, imageB)).toBeUndefined();
			expect(await objectExists(projectId, imageA)).toBe(false);
			expect(await objectExists(projectId, imageB)).toBe(false);
		} finally {
			restoreStore();
		}
	});

	// The data-integrity guard proper: both the batch DELETE and the per-image
	// fallback fail, so NO record removal is ever confirmed. The object MUST be
	// preserved — deleting it would orphan the surviving asset_records row.
	test("does NOT delete the object when record removal cannot be confirmed (batch + per-image both fail)", async () => {
		const durable = new RemoveFailingDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageId = "stuck.png";
		try {
			await seedUploadedObject(durable, projectId, imageId);
			durable.failBatchRemove = true;
			durable.failPerImageRemove = true;

			await cleanupUncommittedUploadObjects(projectId, [imageId]);

			// The record could not be removed, so the object is left intact: no DB row
			// points at a deleted object. This is the invariant the regression broke.
			expect((await durable.get(projectId, imageId))?.imageId).toBe(imageId);
			expect(await objectExists(projectId, imageId)).toBe(true);
		} finally {
			restoreStore();
		}
	});

	// Mixed batch outcome via the per-image fallback: one record deletes cleanly, one
	// keeps failing. Only the confirmed-removed image's object is deleted; the other
	// image's row + object are both preserved.
	test("per-image fallback deletes only the objects whose record removal succeeded", async () => {
		const durable = new RemoveFailingDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const okImage = "ok.png";
		const stuckImage = "stuck.png";
		try {
			await seedUploadedObject(durable, projectId, okImage);
			await seedUploadedObject(durable, projectId, stuckImage);
			durable.failBatchRemove = true;
			// Make ONLY the stuck image's per-image delete fail.
			const realRemove = durable.remove.bind(durable);
			durable.failPerImageRemove = false;
			(durable as unknown as { remove: InMemoryDurableAssetStore["remove"] }).remove = async (
				pId: string,
				aId: string,
			) => {
				if (aId === stuckImage) throw new Error("simulated per-image DELETE failure");
				return realRemove(pId, aId);
			};

			await cleanupUncommittedUploadObjects(projectId, [okImage, stuckImage]);

			// ok.png: record removed -> object deleted.
			expect(await durable.get(projectId, okImage)).toBeUndefined();
			expect(await objectExists(projectId, okImage)).toBe(false);
			// stuck.png: record removal failed -> row AND object both preserved.
			expect((await durable.get(projectId, stuckImage))?.imageId).toBe(stuckImage);
			expect(await objectExists(projectId, stuckImage)).toBe(true);
		} finally {
			restoreStore();
		}
	});

	// An image whose object was written but whose record was never created (the upload
	// failed between putProjectImage and recordUploadedAsset — imageId is pushed before
	// the record exists) must still have its orphan object cleaned up: nothing in the
	// DB points at it, so deleting it is safe and skipping it would leak storage.
	test("still cleans up an orphan object that has no durable record", async () => {
		const durable = new RemoveFailingDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const orphanImage = "orphan.png";
		try {
			// Object on disk but NO asset record (mirror or durable).
			await objectStorage.putProjectImage({ projectId, imageId: orphanImage, buffer: TINY });
			expect(await durable.get(projectId, orphanImage)).toBeUndefined();

			await cleanupUncommittedUploadObjects(projectId, [orphanImage]);

			expect(await objectExists(projectId, orphanImage)).toBe(false);
		} finally {
			restoreStore();
		}
	});

	// Happy path stays intact: batch DELETE succeeds, records + objects both removed.
	test("success path batch-deletes records and their objects", async () => {
		const durable = new RemoveFailingDurableAssetStore();
		const restoreStore = setAssetStoreForTests(durable);
		const projectId = createProjectDir();
		const imageA = "a.png";
		const imageB = "b.png";
		try {
			await seedUploadedObject(durable, projectId, imageA);
			await seedUploadedObject(durable, projectId, imageB);

			await cleanupUncommittedUploadObjects(projectId, [imageA, imageB]);

			expect(await durable.get(projectId, imageA)).toBeUndefined();
			expect(await durable.get(projectId, imageB)).toBeUndefined();
			expect(await objectExists(projectId, imageA)).toBe(false);
			expect(await objectExists(projectId, imageB)).toBe(false);
		} finally {
			restoreStore();
		}
	});
});
