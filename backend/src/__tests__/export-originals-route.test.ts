import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR } from "../config.js";
import { exportRoutes } from "../routes/export.js";
import { resetEgressAccountingForTesting } from "../services/egress-accounting.js";
import type { JWTPayload } from "../types/auth.js";
import type { AssetRecord, AssetStorageStatus, ProjectState } from "../types/index.js";

const createdProjectDirs: string[] = [];
const TEST_USER_ID = "originals-route-user";

function buildApp(): Hono {
	const app = new Hono();
	app.use("/api/export/*", async (c, next) => {
		const user: JWTPayload = {
			userId: TEST_USER_ID,
			email: "originals@example.com",
			role: "owner",
			emailVerified: true,
		};
		(c as unknown as { set(key: "user", value: JWTPayload): void }).set("user", user);
		await next();
	});
	app.route("/api/export", exportRoutes);
	return app;
}

function page(overrides: Partial<ProjectState["pages"][number]> = {}): ProjectState["pages"][number] {
	return {
		imageId: `${uuid()}.png`,
		imageName: "page.png",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function assetRecord(
	projectId: string,
	imageId: string,
	overrides: Partial<AssetRecord> = {},
): AssetRecord {
	const now = new Date("2026-06-11T00:00:00.000Z").toISOString();
	return {
		assetId: imageId,
		projectId,
		imageId,
		originalName: imageId,
		mimeType: "image/png",
		sizeBytes: 0,
		sha256: "0".repeat(64),
		storageDriver: "local",
		storageKey: `projects/${projectId}/images/${imageId}`,
		width: 1,
		height: 1,
		storageStatus: "released",
		moderation: { status: "passed", provider: "test", checkedAt: now },
		derivatives: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function writeOriginalsProject(input: {
	name?: string;
	pages: Array<{
		imageId?: string;
		imageName?: string;
		originalName?: string;
		bytes?: Buffer;
		writeBytes?: boolean;
		asset?: Partial<AssetRecord> | null;
	}>;
}): { projectId: string; state: ProjectState } {
	const projectId = uuid();
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	const pages = input.pages.map((entry) => {
		const imageId = entry.imageId ?? `${uuid()}.png`;
		const bytes = entry.bytes ?? Buffer.from(`bytes:${imageId}`);
		if (entry.writeBytes !== false) {
			writeFileSync(join(projectDir, "images", imageId), bytes);
		}
		return page({
			imageId,
			imageName: entry.imageName ?? imageId,
			originalName: entry.originalName,
		});
	});
	const state: ProjectState = {
		projectId,
		userId: TEST_USER_ID,
		name: input.name ?? "Originals Route Test",
		createdAt: new Date("2026-06-11T00:00:00.000Z").toISOString(),
		pages,
		currentPage: 0,
		targetLang: "th",
	};
	writeFileSync(join(projectDir, "state.json"), JSON.stringify(state));

	const assets: Record<string, AssetRecord> = {};
	for (const [index, entry] of input.pages.entries()) {
		if (entry.asset === null) continue;
		const imageId = pages[index]!.imageId;
		const bytes = entry.bytes ?? Buffer.from(`bytes:${imageId}`);
		assets[imageId] = assetRecord(projectId, imageId, {
			originalName: entry.originalName ?? entry.imageName ?? imageId,
			mimeType: entry.originalName?.toLowerCase().endsWith(".jpg") || entry.originalName?.toLowerCase().endsWith(".jpeg")
				? "image/jpeg"
				: "image/png",
			sizeBytes: bytes.byteLength,
			...entry.asset,
		});
	}
	writeFileSync(join(projectDir, "assets.json"), JSON.stringify(assets, null, 2));
	createdProjectDirs.push(projectDir);
	return { projectId, state };
}

function readZipEntries(data: ArrayBuffer): Map<string, Buffer> {
	const buffer = Buffer.from(data);
	const entries = new Map<string, Buffer>();
	let offset = 0;
	while (offset + 4 <= buffer.length) {
		const signature = buffer.readUInt32LE(offset);
		if (signature === 0x02014b50 || signature === 0x06054b50) break;
		expect(signature).toBe(0x04034b50);
		const method = buffer.readUInt16LE(offset + 8);
		expect(method).toBe(0);
		const compressedSize = buffer.readUInt32LE(offset + 18);
		const fileNameLength = buffer.readUInt16LE(offset + 26);
		const extraLength = buffer.readUInt16LE(offset + 28);
		const nameStart = offset + 30;
		const nameEnd = nameStart + fileNameLength;
		const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
		const dataStart = nameEnd + extraLength;
		const dataEnd = dataStart + compressedSize;
		entries.set(name, Buffer.from(buffer.subarray(dataStart, dataEnd)));
		offset = dataEnd;
	}
	return entries;
}

beforeEach(() => {
	resetEgressAccountingForTesting();
});

afterEach(() => {
	resetEgressAccountingForTesting();
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const dir of createdProjectDirs.splice(0)) {
		const resolved = resolve(dir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

describe("GET /api/export/originals/:chapterId", () => {
	test("zips original page bytes in page order with a manifest", async () => {
		const firstBytes = Buffer.from("page-one-original");
		const secondBytes = Buffer.from("page-two-original");
		const { projectId } = writeOriginalsProject({
			name: "Moonlit Courier Chapter 104",
			pages: [
				{ imageId: `${uuid()}.png`, originalName: "cover.png", bytes: firstBytes },
				{ imageId: `${uuid()}.jpg`, originalName: "spread.jpg", bytes: secondBytes },
			],
		});

		const res = await buildApp().request(`/api/export/originals/${projectId}`);

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/zip");
		expect(res.headers.get("Content-Disposition")).toContain("Moonlit Courier Chapter 104-originals.zip");
		expect(res.headers.get("X-Asset-Egress-Bytes")).toBeTruthy();

		const entries = readZipEntries(await res.arrayBuffer());
		expect([...entries.keys()]).toEqual(["manifest.json", "pages/001-cover.png", "pages/002-spread.jpg"]);
		expect(entries.get("pages/001-cover.png")?.toString()).toBe(firstBytes.toString());
		expect(entries.get("pages/002-spread.jpg")?.toString()).toBe(secondBytes.toString());

		const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
			kind: string;
			projectId: string;
			pageCount: number;
			pages: Array<{ pageIndex: number; pageNumber: number; filename: string; sourceName: string; sizeBytes: number }>;
		};
		expect(manifest.kind).toBe("chapter-originals");
		expect(manifest.projectId).toBe(projectId);
		expect(manifest.pageCount).toBe(2);
		expect(manifest.pages.map((entry) => entry.filename)).toEqual(["pages/001-cover.png", "pages/002-spread.jpg"]);
		expect(manifest.pages.map((entry) => entry.pageNumber)).toEqual([1, 2]);
		expect(manifest.pages[0]!.sourceName).toBe("cover.png");
		expect(manifest.pages[1]!.sizeBytes).toBe(secondBytes.byteLength);
	});

	test("Thai chapter name serves with an ASCII filename + RFC 5987 filename*", async () => {
		// codex P1 regression: Bun's Headers REJECT non-Latin1 values, so a Thai
		// chapter name 500'd the route after egress was already recorded.
		const bytes = Buffer.from("thai-name-original");
		const { projectId } = writeOriginalsProject({
			name: "บทที่ 104 จันทราเดือด",
			pages: [{ imageId: `${uuid()}.png`, originalName: "cover.png", bytes }],
		});

		const res = await buildApp().request(`/api/export/originals/${projectId}`);

		expect(res.status).toBe(200);
		const disposition = res.headers.get("Content-Disposition") ?? "";
		// Latin1-safe quoted fallback + full UTF-8 name in filename*.
		expect(disposition).toMatch(/filename="[\x20-\x7e]+"/);
		expect(disposition).toContain("filename*=UTF-8''");
		expect(disposition).toContain(encodeURIComponent("บทที่ 104 จันทราเดือด"));
		const entries = readZipEntries(await res.arrayBuffer());
		expect(entries.get("pages/001-cover.png")?.toString()).toBe(bytes.toString());
	});

	test("denies aijob_provider_* page ids by prefix even if a record exists", async () => {
		// codex P3 defense-in-depth: raw provider checkpoints must never be
		// downloadable, registration state notwithstanding.
		const checkpointId = "aijob_provider_somejob.png";
		const { projectId } = writeOriginalsProject({
			name: "Checkpoint Guard",
			pages: [{ imageId: checkpointId, originalName: checkpointId, bytes: Buffer.from("raw-checkpoint") }],
		});

		const res = await buildApp().request(`/api/export/originals/${projectId}`);

		expect(res.status).toBe(403);
		const body = await res.json() as { code: string };
		expect(body.code).toBe("asset_not_registered");
	});

	test("413s a chapter whose projected originals exceed the direct-download cap", async () => {
		// codex P2: size is projected from asset records BEFORE any storage read.
		// Inflate the RECORDED size past the cap without writing real bytes — the
		// projection must come from asset records, not from reading storage.
		const { projectId } = writeOriginalsProject({
			name: "Too Big",
			pages: [{
				imageId: `${uuid()}.png`,
				originalName: "huge.png",
				bytes: Buffer.from("xx"),
				asset: { sizeBytes: 600 * 1024 * 1024 },
			}],
		});

		const res = await buildApp().request(`/api/export/originals/${projectId}`);

		expect(res.status).toBe(413);
		const body = await res.json() as { code: string };
		expect(body.code).toBe("originals_too_large");
	});

	test("fails closed when a page image has no asset record", async () => {
		const { projectId } = writeOriginalsProject({
			pages: [
				{ imageId: `${uuid()}.png`, originalName: "registered.png" },
				{ imageId: `${uuid()}.png`, originalName: "missing-record.png", asset: null },
			],
		});

		const res = await buildApp().request(`/api/export/originals/${projectId}`);
		const body = (await res.json()) as { code: string; pageNumber: number };

		expect(res.status).toBe(403);
		expect(body.code).toBe("asset_not_registered");
		expect(body.pageNumber).toBe(2);
	});

	test("fails closed when a source asset is not passed and released", async () => {
		const { projectId } = writeOriginalsProject({
			pages: [{
				imageId: `${uuid()}.png`,
				originalName: "needs-review.png",
				asset: {
					storageStatus: "released" as AssetStorageStatus,
					moderation: { status: "needs_review", provider: "test", checkedAt: "2026-06-11T00:00:00.000Z" },
				},
			}],
		});

		const res = await buildApp().request(`/api/export/originals/${projectId}`);
		const body = (await res.json()) as { code: string; moderationStatus: string };

		expect(res.status).toBe(403);
		expect(body.code).toBe("asset_not_downloadable");
		expect(body.moderationStatus).toBe("needs_review");
	});

	test("returns 404 instead of a partial zip when source bytes are missing", async () => {
		const imageId = `${uuid()}.png`;
		const { projectId } = writeOriginalsProject({
			pages: [{ imageId, originalName: "missing-bytes.png", writeBytes: false }],
		});

		const res = await buildApp().request(`/api/export/originals/${projectId}`);
		const body = (await res.json()) as { code: string; imageId: string };

		expect(res.status).toBe(404);
		expect(body.code).toBe("source_image_not_found");
		expect(body.imageId).toBe(imageId);
	});
});
