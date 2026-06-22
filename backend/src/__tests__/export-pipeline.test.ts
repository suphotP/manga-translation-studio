import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import sharp from "sharp";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import {
	enqueueExportJob,
	ExportJobTooLargeError,
	type ExportJob,
	type ExportJobStore,
	type ExportJobStoreSqlClient,
	getExportPresetConfig,
	maxExportOutputsPerPage,
	minExportSliceHeight,
	listExportPresetConfigs,
	MemoryExportJobStore,
	MissingLanguageOutputError,
	PostgresExportJobStore,
	processExportJob,
	renderExportForImage,
	resolveEffectiveConfig,
	resolveSignedUrlTtlSeconds,
	runDueExportJobs,
	setExportJobStoreForTests,
	setExportLayerReadinessAssertForTests,
	signExportUrl,
} from "../services/export-pipeline.js";
import { EXPORT_LAYER_LIMITS } from "../services/export-image-layers.js";
import type { ObjectStorage, StoredObject } from "../services/storage.js";
import {
	exportRoutes,
	PostgresExportPresetStore,
	type ExportPresetStoreSqlClient,
} from "../routes/export.js";
import { clampSplitThreshold } from "../services/image-merge-split.js";
import { listProjectUsageEventPage } from "../services/usage-ledger.js";

// ── Fakes ───────────────────────────────────────────────────────────────────

// In-memory object storage that can presign (so the signed-URL path is exercised
// without live R2) and records puts/reads so we can assert the source is never
// mutated.
class FakeObjectStorage implements ObjectStorage {
	readonly driver = "r2" as const;
	readonly images = new Map<string, Buffer>();
	readonly exports = new Map<string, Buffer>();
	readonly putExportCalls: string[] = [];
	readonly deleteExportCalls: string[] = [];
	canPresign = true;
	/** When set, putProjectExport throws once this many export objects have been written. */
	failPutExportAfter: number | undefined = undefined;

	seedImage(projectId: string, imageId: string, buffer: Buffer): void {
		this.images.set(`${projectId}/${imageId}`, buffer);
	}

	presignProjectObject(input: { projectId: string; objectId: string; kind: string; expiresInSeconds: number }): string | undefined {
		if (!this.canPresign) return undefined;
		return `https://signed.example/${input.kind}/${input.projectId}/${encodeURIComponent(input.objectId)}?exp=${input.expiresInSeconds}`;
	}

	async putProjectImage(): Promise<StoredObject> {
		throw new Error("export pipeline must never write project images (source mutation)");
	}

	readImageIds: string[] = [];

	async getProjectImage(input: { projectId: string; imageId: string }): Promise<Buffer | undefined> {
		// Spy: record every imageId the pipeline actually fetches from storage so a test
		// can assert a denied (never-grandfather / pre-moderation) id is NEVER read.
		this.readImageIds.push(input.imageId);
		return this.images.get(`${input.projectId}/${input.imageId}`);
	}

	getProjectImagePath(): undefined {
		return undefined;
	}

	async getProjectImageCreatedAtMs(input: { projectId: string; imageId: string }): Promise<number | undefined> {
		return this.images.has(`${input.projectId}/${input.imageId}`) ? 0 : undefined;
	}

	hasProjectImage(input: { projectId: string; imageId: string }): boolean {
		return this.images.has(`${input.projectId}/${input.imageId}`);
	}

	async deleteProjectImage(): Promise<boolean> {
		throw new Error("export pipeline must never delete project images (source mutation)");
	}

	async putProjectDerivative(): Promise<StoredObject> {
		throw new Error("not used");
	}

	async getProjectDerivative(): Promise<Buffer | undefined> {
		return undefined;
	}

	getProjectDerivativePath(): undefined {
		return undefined;
	}

	hasProjectDerivative(): boolean {
		return false;
	}

	async deleteProjectDerivative(): Promise<boolean> {
		return false;
	}

	async putProjectExport(input: { projectId: string; exportId: string; buffer: Buffer }): Promise<StoredObject> {
		// Simulate a partial-write failure mid-job once `failPutExportAfter` objects
		// have been written, so the orphan-cleanup path can be exercised.
		if (this.failPutExportAfter !== undefined && this.putExportCalls.length >= this.failPutExportAfter) {
			throw new Error("simulated export storage write failure");
		}
		this.putExportCalls.push(input.exportId);
		this.exports.set(`${input.projectId}/${input.exportId}`, input.buffer);
		return { driver: this.driver, key: `projects/${input.projectId}/exports/${input.exportId}` };
	}

	async getProjectExport(input: { projectId: string; exportId: string }): Promise<Buffer | undefined> {
		return this.exports.get(`${input.projectId}/${input.exportId}`);
	}

	async getProjectExportStream(input: { projectId: string; exportId: string }): Promise<{ stream: ReadableStream<Uint8Array>; sizeBytes: number } | undefined> {
		const buffer = this.exports.get(`${input.projectId}/${input.exportId}`);
		if (!buffer) return undefined;
		const bytes = new Uint8Array(buffer);
		return {
			sizeBytes: bytes.byteLength,
			stream: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
		};
	}

	getProjectExportPath(): undefined {
		return undefined;
	}

	hasProjectExport(input: { projectId: string; exportId: string }): boolean {
		return this.exports.has(`${input.projectId}/${input.exportId}`);
	}

	async deleteProjectExport(input: { projectId: string; exportId: string }): Promise<boolean> {
		this.deleteExportCalls.push(input.exportId);
		return this.exports.delete(`${input.projectId}/${input.exportId}`);
	}
}

// Minimal in-memory SQL client backing the PostgresExportJobStore: executes the
// subset of SQL the store issues (INSERT, SELECT by id, workspace-scoped SELECT,
// dynamic UPDATE...RETURNING, claim-next UPDATE...RETURNING).
class FakeExportJobSqlClient implements ExportJobStoreSqlClient {
	readonly rows: Array<Record<string, unknown>> = [];
	readonly queries: Array<{ query: string; params: unknown[] }> = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		const sql = query.replace(/\s+/g, " ").trim();

		if (sql.startsWith("INSERT INTO export_jobs")) {
			this.rows.push({
				id: params[0],
				workspace_id: params[1],
				project_id: params[2],
				chapter_id: params[3],
				requested_by: params[4],
				target_lang: params[5],
				preset: params[6],
				status: params[7],
				result_key: params[8],
				result_signed_url: params[9],
				error: params[10],
				params: params[11],
				created_at: params[12],
				completed_at: params[13],
			});
			return [] as T[];
		}

		if (sql.startsWith("UPDATE export_jobs SET status = 'processing'")) {
			const queued = this.rows
				.filter((row) => row.status === "queued")
				.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0];
			if (!queued) return [] as T[];
			queued.status = "processing";
			return [{ ...queued }] as T[];
		}

		if (sql.startsWith("UPDATE export_jobs SET")) {
			// Dynamic column update. Parse "col = $N[::cast]" pairs in order; $1 is id.
			const id = params[0];
			const row = this.rows.find((candidate) => candidate.id === id);
			if (!row) return [] as T[];
			const assignments = sql.slice("UPDATE export_jobs SET".length, sql.indexOf(" WHERE")).split(",");
			for (const assignment of assignments) {
				const match = assignment.trim().match(/^([a-z_]+) = \$(\d+)/);
				if (!match) continue;
				const column = match[1]!;
				const paramIndex = Number(match[2]) - 1;
				row[column] = params[paramIndex];
			}
			return [{ ...row }] as T[];
		}

		if (sql.startsWith("SELECT") && sql.includes("FROM export_jobs")) {
			const id = params[0];
			let matched = this.rows.filter((row) => row.id === id);
			if (sql.includes("workspace_id = $2")) {
				matched = matched.filter((row) => row.workspace_id === params[1]);
			} else if (sql.includes("workspace_id IS NULL")) {
				matched = matched.filter((row) => row.workspace_id === null || row.workspace_id === undefined);
			}
			return matched.map((row) => ({ ...row })) as T[];
		}

		return [] as T[];
	}
}

class FakeExportPresetSqlClient implements ExportPresetStoreSqlClient {
	readonly rows: Array<Record<string, unknown>> = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const sql = query.replace(/\s+/g, " ").trim();
		if (sql.startsWith("INSERT INTO export_presets")) {
			const existing = this.rows.find((row) => row.workspace_id === params[1] && row.name === params[2]);
			if (existing) {
				existing.config = params[3];
				existing.created_by = params[4];
				return [{ id: existing.id, created_at: existing.created_at }] as T[];
			}
			const row = {
				id: params[0],
				workspace_id: params[1],
				name: params[2],
				config: params[3],
				created_by: params[4],
				created_at: "2026-06-02T00:00:00.000Z",
			};
			this.rows.push(row);
			return [{ id: row.id, created_at: row.created_at }] as T[];
		}
		if (sql.startsWith("SELECT") && sql.includes("FROM export_presets")) {
			return this.rows
				.filter((row) => row.workspace_id === params[0])
				.sort((a, b) => String(a.name).localeCompare(String(b.name)))
				.map((row) => ({ ...row })) as T[];
		}
		return [] as T[];
	}
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const createdProjectDirs: string[] = [];

async function makeTallImage(width: number, height: number): Promise<Buffer> {
	return sharp({
		create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
	}).png().toBuffer();
}

// Register PASSING/RELEASED asset records for the given image ids so the export
// ENQUEUE readiness gate (codex P0/P1: every exported asset must be `passed`)
// admits the job. Without this, a page whose image has no asset record is held
// (missing moderation == not passed) and enqueue returns 409 export_not_ready.
function writePassingAssetsForTest(projectId: string, imageIds: string[]): void {
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(projectDir, { recursive: true });
	const now = new Date().toISOString();
	const index: Record<string, unknown> = {};
	for (const imageId of imageIds) {
		if (!imageId) continue;
		index[imageId] = {
			assetId: imageId,
			projectId,
			imageId,
			originalName: imageId,
			mimeType: "image/png",
			sizeBytes: 1,
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
		};
	}
	writeFileSync(join(projectDir, "assets.json"), JSON.stringify(index));
}

function createProjectOnDisk(options: { userId?: string; workspaceId?: string } = {}): { projectId: string; imageId: string } {
	const projectId = uuid();
	const imageId = `${uuid()}.png`;
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify({
		projectId,
		workspaceId: options.workspaceId,
		userId: options.userId ?? "",
		name: "Export Test",
		createdAt: new Date().toISOString(),
		pages: [{ imageId, imageName: imageId, textLayers: [], pendingAiJobs: [], coverRect: null }],
		currentPage: 0,
		targetLang: "th",
	}));
	createdProjectDirs.push(projectDir);
	writePassingAssetsForTest(projectId, [imageId]);
	return { projectId, imageId };
}

function writeProjectStateForTest(state: Record<string, unknown>): void {
	const projectDir = join(PROJECTS_DIR, String(state.projectId));
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify(state));
	createdProjectDirs.push(projectDir);
	// Register passing asset records for every page image (and edited/per-language
	// output id) referenced by the state so the enqueue readiness gate admits it.
	const pages = Array.isArray((state as { pages?: unknown }).pages) ? (state as { pages: Array<Record<string, unknown>> }).pages : [];
	const ids = new Set<string>();
	for (const page of pages) {
		if (typeof page.imageId === "string") ids.add(page.imageId);
		const edits = page.edits as Record<string, unknown> | undefined;
		if (edits && typeof edits.imageId === "string") ids.add(edits.imageId);
		const outputs = page.languageOutputs as Record<string, Record<string, unknown>> | undefined;
		if (outputs) {
			for (const output of Object.values(outputs)) {
				for (const key of ["typesetImageId", "exportImageId", "renderedImageId", "imageId"]) {
					const value = output[key];
					if (typeof value === "string") ids.add(value);
				}
				const oEdits = output.edits as Record<string, unknown> | undefined;
				if (oEdits && typeof oEdits.imageId === "string") ids.add(oEdits.imageId);
			}
		}
		const layers = page.imageLayers as Array<Record<string, unknown>> | undefined;
		if (Array.isArray(layers)) {
			for (const layer of layers) {
				if (layer && layer.visible !== false && typeof layer.imageId === "string") ids.add(layer.imageId);
			}
		}
	}
	writePassingAssetsForTest(String(state.projectId), [...ids]);
}

async function samplePixel(buffer: Buffer): Promise<{ r: number; g: number; b: number }> {
	const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const idx = ((Math.floor(info.height / 2) * info.width) + Math.floor(info.width / 2)) * info.channels;
	return { r: data[idx]!, g: data[idx + 1]!, b: data[idx + 2]! };
}

async function samplePixelAt(buffer: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }> {
	const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const px = Math.max(0, Math.min(info.width - 1, Math.round(x)));
	const py = Math.max(0, Math.min(info.height - 1, Math.round(y)));
	const idx = ((py * info.width) + px) * info.channels;
	return { r: data[idx]!, g: data[idx + 1]!, b: data[idx + 2]!, a: info.channels >= 4 ? data[idx + 3]! : 255 };
}

async function solidPng(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

// Count pixels whose luminance is clearly DARKER than a near-white background —
// used to detect whether dark text ended up painted on top of a white image layer.
async function countDarkPixels(buffer: Buffer, threshold = 160): Promise<number> {
	const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	let dark = 0;
	for (let i = 0; i < data.length; i += info.channels) {
		const lum = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
		if (lum < threshold) dark += 1;
	}
	return dark;
}

afterEach(() => {
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const dir of createdProjectDirs.splice(0)) {
		const resolved = resolve(dir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

// ── Preset configs ───────────────────────────────────────────────────────────

describe("export preset configs", () => {
	test("web_reader is max-width 1200 JPEG q85", () => {
		expect(getExportPresetConfig("web_reader")).toMatchObject({ maxWidth: 1200, format: "jpeg", quality: 85 });
	});

	test("mobile is max-width 720 JPEG q75", () => {
		expect(getExportPresetConfig("mobile")).toMatchObject({ maxWidth: 720, format: "jpeg", quality: 75 });
	});

	test("webtoon_split slices into 1500/2000/3000 chunks", () => {
		expect(getExportPresetConfig("webtoon_split").sliceHeights).toEqual([1500, 2000, 3000]);
	});

	test("master keeps the source untouched (no resize/re-encode)", () => {
		const config = getExportPresetConfig("master");
		expect(config.format).toBe("original");
		expect(config.maxWidth).toBeUndefined();
		expect(config.quality).toBeUndefined();
	});

	test("webp_avif targets a modern format", () => {
		expect(getExportPresetConfig("webp_avif").format).toBe("avif");
	});

	test("listExportPresetConfigs returns all five built-ins", () => {
		expect(listExportPresetConfigs().map((c) => c.preset).sort()).toEqual([
			"master", "mobile", "web_reader", "webp_avif", "webtoon_split",
		]);
	});
});

// ── Signed URL TTL ────────────────────────────────────────────────────────────

describe("signed URL expiry", () => {
	afterEach(() => {
		delete process.env.EXPORT_SIGNED_URL_TTL_SECONDS;
	});

	test("defaults to 15 minutes", () => {
		expect(resolveSignedUrlTtlSeconds()).toBe(15 * 60);
	});

	test("caps an oversized override at one hour", () => {
		expect(resolveSignedUrlTtlSeconds(99999)).toBe(60 * 60);
	});

	test("honors a sane override", () => {
		expect(resolveSignedUrlTtlSeconds(300)).toBe(300);
	});

	test("rejects a non-positive override and falls back to default", () => {
		expect(resolveSignedUrlTtlSeconds(0)).toBe(15 * 60);
		expect(resolveSignedUrlTtlSeconds(-5)).toBe(15 * 60);
	});

	test("signExportUrl mints a URL via the storage presigner", () => {
		const storage = new FakeObjectStorage();
		const url = signExportUrl("project-1", "export-1/page.jpg", { storage, ttlSeconds: 120 });
		expect(url).toContain("https://signed.example/export/project-1/");
		expect(url).toContain("exp=120");
	});

	test("signExportUrl returns undefined when the driver cannot presign (local disk)", () => {
		const storage = new FakeObjectStorage();
		storage.canPresign = false;
		expect(signExportUrl("project-1", "export-1/page.jpg", { storage })).toBeUndefined();
	});
});

// ── Image transform ────────────────────────────────────────────────────────────

describe("renderExportForImage", () => {
	test("master copies the source bytes byte-for-byte (no mutation, no re-encode)", async () => {
		const source = await makeTallImage(800, 600);
		const outputs = await renderExportForImage("page.png", source, getExportPresetConfig("master"), "exp-1");
		expect(outputs).toHaveLength(1);
		expect(outputs[0]!.buffer.equals(source)).toBe(true);
		expect(outputs[0]!.objectId).toContain("exp-1/");
	});

	test("web_reader downsizes wide images to the max width", async () => {
		const source = await makeTallImage(3000, 1000);
		const outputs = await renderExportForImage("page.png", source, getExportPresetConfig("web_reader"), "exp-2");
		expect(outputs).toHaveLength(1);
		const meta = await sharp(outputs[0]!.buffer).metadata();
		expect(meta.width).toBe(1200);
		expect(meta.format).toBe("jpeg");
	});

	test("webtoon_split slices a tall page into multiple encoded chunks + reports slice index", async () => {
		const source = await makeTallImage(1000, 5000);
		const outputs = await renderExportForImage("page.png", source, getExportPresetConfig("webtoon_split"), "exp-3");
		expect(outputs.length).toBeGreaterThan(1);
		expect(outputs.every((o) => typeof o.sliceIndex === "number")).toBe(true);
		// Slice heights sum back to the source height.
		const totalHeight = outputs.reduce((sum, o) => sum + o.height, 0);
		expect(totalHeight).toBe(5000);
	});

	test("webtoon_split honors an explicit custom height split override", async () => {
		const source = await makeTallImage(1000, 4200);
		const config = resolveEffectiveConfig("webtoon_split", {
			split: { mode: "height", heightPerPiece: 1800 },
		});
		const outputs = await renderExportForImage("page.png", source, config, "exp-custom-height");
		expect(outputs.map((o) => o.height)).toEqual([1800, 1800, 600]);
		expect(outputs.every((o) => o.sliceIndex !== undefined)).toBe(true);
	});
});

describe("resolveEffectiveConfig (persisted job params)", () => {
	test("applies persisted maxWidth/quality/format overrides over the preset", () => {
		const config = resolveEffectiveConfig("web_reader", { maxWidth: 800, quality: 60, format: "webp" });
		expect(config).toMatchObject({ maxWidth: 800, quality: 60, format: "webp", preset: "web_reader" });
	});

	test("ignores unsafe/malformed overrides and clamps to bounds", () => {
		const config = resolveEffectiveConfig("mobile", { maxWidth: -5, quality: 999, format: "exe", sliceHeights: ["x"] });
		expect(config.maxWidth).toBe(720); // unchanged: negative override ignored
		expect(config.quality).toBe(100); // clamped from 999
		expect(config.format).toBe("jpeg"); // unknown format ignored
		expect(config.sliceHeights).toBeUndefined(); // no valid heights
	});

	test("explicit height split wins over legacy sliceHeights and reuses upload split clamping", () => {
		const config = resolveEffectiveConfig("webtoon_split", {
			sliceHeights: [3000],
			split: { mode: "height", heightPerPiece: 1750 },
		});
		expect(config.sliceHeights).toEqual([1750]);

		const tiny = resolveEffectiveConfig("webtoon_split", {
			split: { mode: "height", heightPerPiece: 1 },
		});
		expect(tiny.sliceHeights).toEqual([clampSplitThreshold(1)]);
	});

	test("processExportJob renders with the persisted maxWidth override", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		storage.seedImage(projectId, "wide.png", await makeTallImage(3000, 1000));
		// Enqueue web_reader (default maxWidth 1200) but override to 600.
		const queued = await enqueueExportJob({
			projectId,
			preset: "web_reader",
			imageIds: ["wide.png"],
			params: { maxWidth: 600 },
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.outputs[0]!.width).toBe(600);
	});

	test("processExportJob applies explicit height split from persisted params", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		storage.seedImage(projectId, "long.png", await makeTallImage(1000, 4200));
		const queued = await enqueueExportJob({
			projectId,
			preset: "webtoon_split",
			imageIds: ["long.png"],
			params: { split: { mode: "height", heightPerPiece: 1800 } },
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		expect(result.outputs.map((o) => o.height)).toEqual([1800, 1800, 600]);
		expect(result.outputs.every((o) => o.sourceImageId === "long.png")).toBe(true);
	});
});

// ── DoS hardening: slice-param validation + pre-render pixel gate ──────────────

describe("export DoS limits (slice clamp + per-page output cap + pre-render gate)", () => {
	const ENV_KEYS = ["EXPORT_MIN_SLICE_HEIGHT", "EXPORT_MAX_OUTPUTS_PER_PAGE", "MAX_EXPORT_JOB_MEGAPIXELS"] as const;
	afterEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});

	test("a tiny client slice height is clamped UP to the min floor (not accepted verbatim)", () => {
		// A malicious sliceHeights: [1] would make sliceTall loop one page into
		// height/1 outputs; resolveEffectiveConfig must clamp every value UP to the floor.
		const min = minExportSliceHeight();
		const config = resolveEffectiveConfig("webtoon_split", { sliceHeights: [1, 2, 5] });
		expect(config.sliceHeights).toBeDefined();
		expect(config.sliceHeights!.every((h) => h >= min)).toBe(true);
		expect(Math.min(...config.sliceHeights!)).toBe(min);
	});

	test("a tiny slice height produces a BOUNDED number of outputs (per-page cap), not thousands", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		// A tall page that, sliced at 1px, would be 4000 outputs. With the clamp it
		// must produce far fewer (bounded by the min-slice-height + per-page cap).
		storage.seedImage(projectId, "tall.png", await makeTallImage(800, 4000));
		const queued = await enqueueExportJob({
			projectId,
			preset: "webtoon_split",
			imageIds: ["tall.png"],
			params: { sliceHeights: [1] }, // hostile tiny override
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		// Output count is bounded: height(4000)/minSlice(200) = 20 ≪ 4000, and never
		// above the per-page hard cap.
		expect(result.outputs.length).toBeGreaterThan(0);
		expect(result.outputs.length).toBeLessThanOrEqual(maxExportOutputsPerPage());
		expect(result.outputs.length).toBeLessThanOrEqual(Math.ceil(4000 / minExportSliceHeight()));
		expect(result.job.status).toBe("done");
	});

	test("per-page output cap bounds slices even when the min-slice floor is lowered", async () => {
		// Force a tiny min slice AND a small per-page cap: the cap must still bound the
		// loop (defense-in-depth in sliceTall), so a 4000px page can't explode.
		process.env.EXPORT_MIN_SLICE_HEIGHT = "1";
		process.env.EXPORT_MAX_OUTPUTS_PER_PAGE = "10";
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		storage.seedImage(projectId, "tall.png", await makeTallImage(400, 4000));
		const queued = await enqueueExportJob({
			projectId,
			preset: "webtoon_split",
			imageIds: ["tall.png"],
			params: { sliceHeights: [1] },
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.outputs.length).toBeLessThanOrEqual(10);
		expect(result.job.status).toBe("done");
	});

	test("a job whose estimated output pixels exceed the per-job ceiling fails BEFORE the render loop (no OOM accumulation)", async () => {
		// Drop the per-job pixel budget to ~0.5 MP; a single 1000x1000 (1 MP) page then
		// trips the preflight and the job must transition to error WITHOUT writing any
		// export object (the gate runs before `rendered[]` and before any storage put).
		process.env.MAX_EXPORT_JOB_MEGAPIXELS = "0.5";
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		storage.seedImage(projectId, "big.png", await makeTallImage(1000, 1000));
		const queued = await enqueueExportJob({
			projectId,
			preset: "master", // no width resize → full source pixels estimated
			imageIds: ["big.png"],
		}, { store });
		await expect(processExportJob(queued.id, { store, storage })).rejects.toBeInstanceOf(ExportJobTooLargeError);
		const after = await store.get(queued.id);
		expect(after?.status).toBe("error");
		// Nothing was written: the gate fired before the write phase.
		expect(storage.putExportCalls.length).toBe(0);
		expect(storage.exports.size).toBe(0);
	});

	test("a normal multi-page export under the budget still completes (the gate is generous)", async () => {
		process.env.MAX_EXPORT_JOB_MEGAPIXELS = "50"; // generous
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		storage.seedImage(projectId, "a.png", await makeTallImage(1000, 1500)); // 1.5 MP
		storage.seedImage(projectId, "b.png", await makeTallImage(1000, 1500)); // 1.5 MP
		const queued = await enqueueExportJob({
			projectId,
			preset: "master",
			imageIds: ["a.png", "b.png"],
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		expect(result.outputs.length).toBeGreaterThanOrEqual(2);
	});
});

// ── Job lifecycle ────────────────────────────────────────────────────────────

describe("export job lifecycle", () => {
	test("enqueue -> process -> done with a signed URL (single page)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const imageId = "page-1.png";
		storage.seedImage(projectId, imageId, await makeTallImage(2000, 1500));

		const queued = await enqueueExportJob({
			projectId,
			preset: "web_reader",
			imageIds: [imageId],
		}, { store });
		expect(queued.status).toBe("queued");

		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		expect(result.job.completedAt).toBeTruthy();
		expect(result.signedUrl).toContain("https://signed.example/");
		expect(result.outputs).toHaveLength(1);

		// The produced output + a manifest.json exist; the source image was never
		// written or deleted (FakeObjectStorage throws on putProjectImage/delete).
		expect(storage.exports.size).toBe(2);
		expect(storage.putExportCalls.some((id) => id.endsWith("manifest.json"))).toBe(true);
		expect(storage.hasProjectImage({ projectId, imageId })).toBe(true);

		const reloaded = await store.get(queued.id);
		expect(reloaded?.status).toBe("done");
		expect(reloaded?.resultKey).toBeTruthy();
	});

	test("a completed export records NO billable usage — export is free (2026-06-13)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const imageId = "page-1.png";
		storage.seedImage(projectId, imageId, await makeTallImage(2000, 1500));

		const queued = await enqueueExportJob({
			projectId,
			preset: "web_reader",
			imageIds: [imageId],
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		expect(result.outputs.length).toBeGreaterThan(0);

		// Export is FREE: the pipeline writes outputs but records NO export-bytes
		// usage event (the meter was removed). Storage reservation + freeze gate stay.
		const page = await listProjectUsageEventPage(projectId, { limit: 50 });
		expect(page.events.filter((e) => e.kind === "export_bytes_recorded")).toHaveLength(0);
	});

	test("a missing source image transitions the job to error and rethrows", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const queued = await enqueueExportJob({
			projectId: uuid(),
			preset: "mobile",
			imageIds: ["does-not-exist.png"],
		}, { store });

		await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/not found/);
		const failed = await store.get(queued.id);
		expect(failed?.status).toBe("error");
		expect(failed?.error).toContain("does-not-exist.png");
		expect(failed?.completedAt).toBeTruthy();
	});

	test("processExportJob throws for an unknown job id", async () => {
		const store = new MemoryExportJobStore();
		await expect(processExportJob("missing", { store })).rejects.toThrow(/not found/);
	});

	test("enqueue rejects an empty image list and an unknown preset", async () => {
		const store = new MemoryExportJobStore();
		await expect(enqueueExportJob({ projectId: uuid(), preset: "web_reader", imageIds: [] }, { store }))
			.rejects.toThrow(/at least one source/);
		await expect(enqueueExportJob({ projectId: uuid(), preset: "bogus" as never, imageIds: ["a.png"] }, { store }))
			.rejects.toThrow(/Unknown export preset/);
	});

	test("runDueExportJobs drains the queue and isolates per-job failures", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		storage.seedImage(projectId, "ok.png", await makeTallImage(900, 700));

		const good = await enqueueExportJob({ projectId, preset: "mobile", imageIds: ["ok.png"] }, { store });
		const bad = await enqueueExportJob({ projectId, preset: "mobile", imageIds: ["missing.png"] }, { store });

		const processed = await runDueExportJobs({ store, storage });
		expect(processed.sort()).toEqual([good.id, bad.id].sort());
		expect((await store.get(good.id))?.status).toBe("done");
		expect((await store.get(bad.id))?.status).toBe("error");
	});

	test("targetLang selects that language's typeset output; omitted defaults to the project target language", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "source.png";
		const thTypesetImageId = "page-th.png";
		const enTypesetImageId = "page-en.png";
		const white = await sharp({ create: { width: 40, height: 40, channels: 3, background: "white" } }).png().toBuffer();
		const blue = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
		const red = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
		storage.seedImage(projectId, sourceImageId, white);
		storage.seedImage(projectId, thTypesetImageId, blue);
		storage.seedImage(projectId, enTypesetImageId, red);

		const state = {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				languageOutputs: {
					th: { typesetImageId: thTypesetImageId },
					en: { typesetImageId: enTypesetImageId },
				},
			}],
		} as never;

		const explicit = await enqueueExportJob({
			projectId,
			preset: "master",
			targetLang: "en",
			imageIds: [sourceImageId],
			state,
		}, { store });
		const explicitResult = await processExportJob(explicit.id, { store, storage });
		const explicitBuffer = storage.exports.get(`${projectId}/${explicitResult.outputs[0]!.objectId}`)!;
		expect(await samplePixel(explicitBuffer)).toMatchObject({ r: 255, g: 0, b: 0 });
		expect((await store.get(explicit.id))?.targetLang).toBe("en");

		const omitted = await enqueueExportJob({
			projectId,
			preset: "master",
			targetLang: "th",
			imageIds: [sourceImageId],
			state,
		}, { store });
		const omittedResult = await processExportJob(omitted.id, { store, storage });
		const omittedBuffer = storage.exports.get(`${projectId}/${omittedResult.outputs[0]!.objectId}`)!;
		expect(await samplePixel(omittedBuffer)).toMatchObject({ r: 0, g: 0, b: 255 });
		expect((await store.get(omitted.id))?.targetLang).toBe("th");
	});

	test("explicit non-default targetLang with no page output rejects instead of silently exporting the source", async () => {
		const store = new MemoryExportJobStore();
		const projectId = uuid();
		const sourceImageId = "source.png";
		const thTypesetImageId = "page-th.png";

		// Project default "th"; the page has a th output but NO en output.
		const state = {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				languageOutputs: {
					th: { typesetImageId: thTypesetImageId },
				},
			}],
		} as never;

		// Explicit "en" (differs from default, no en output) => hard error, no job created.
		let thrown: unknown;
		try {
			await enqueueExportJob({
				projectId,
				preset: "master",
				targetLang: "en",
				requestedTargetLang: "en",
				imageIds: [sourceImageId],
				state,
			}, { store });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(MissingLanguageOutputError);
		expect((thrown as MissingLanguageOutputError).targetLang).toBe("en");
		expect((thrown as MissingLanguageOutputError).imageIds).toEqual([sourceImageId]);

		// The default "th" track (present) still enqueues fine and renders that output.
		const ok = await enqueueExportJob({
			projectId,
			preset: "master",
			targetLang: "th",
			requestedTargetLang: "th",
			imageIds: [sourceImageId],
			state,
		}, { store });
		expect(ok.targetLang).toBe("th");
		const plans = ok.params.renderPlans as Array<{ sourceImageId: string; renderImageId: string }> | undefined;
		expect(plans?.[0]?.renderImageId).toBe(thTypesetImageId);

		// Omitted track => legacy path, no guard, renders the source untouched.
		const omitted = await enqueueExportJob({
			projectId,
			preset: "master",
			imageIds: [sourceImageId],
			state,
		}, { store });
		expect(omitted.params.renderPlans).toBeUndefined();
	});
});

// ── Postgres store + workspace isolation ─────────────────────────────────────

describe("PostgresExportJobStore", () => {
	test("constructor rejects missing DATABASE_URL when no client is injected", () => {
		expect(() => new PostgresExportJobStore(undefined, "")).toThrow(/requires DATABASE_URL/);
	});

	test("create + get round-trips a job with parsed params", async () => {
		const client = new FakeExportJobSqlClient();
		const store = new PostgresExportJobStore(client);
		const job = await enqueueExportJob({
			workspaceId: "ws-1",
			projectId: "proj-1",
			preset: "web_reader",
			imageIds: ["a.png"],
		}, { store });

		const loaded = await store.get(job.id);
		expect(loaded?.workspaceId).toBe("ws-1");
		expect(loaded?.targetLang).toBeUndefined();
		expect(loaded?.preset).toBe("web_reader");
		expect(loaded?.params.imageIds).toEqual(["a.png"]);
	});

	test("getForWorkspace never resolves another tenant's job", async () => {
		const client = new FakeExportJobSqlClient();
		const store = new PostgresExportJobStore(client);
		const job = await enqueueExportJob({ workspaceId: "ws-1", projectId: "proj-1", preset: "mobile", imageIds: ["a.png"] }, { store });

		expect(await store.getForWorkspace(job.id, "ws-1")).toBeDefined();
		// Cross-tenant read is denied even with a valid id.
		expect(await store.getForWorkspace(job.id, "ws-2")).toBeUndefined();
		// An anonymous (no-workspace) read must not see a workspace job.
		expect(await store.getForWorkspace(job.id, undefined)).toBeUndefined();
	});

	test("update transitions status and persists the signed URL + completedAt", async () => {
		const client = new FakeExportJobSqlClient();
		const store = new PostgresExportJobStore(client);
		const job = await enqueueExportJob({ workspaceId: "ws-1", projectId: "proj-1", preset: "mobile", imageIds: ["a.png"] }, { store });

		const updated = await store.update(job.id, {
			status: "done",
			resultKey: "projects/proj-1/exports/x",
			resultSignedUrl: "https://signed/x",
			completedAt: "2026-06-02T01:00:00.000Z",
		});
		expect(updated?.status).toBe("done");
		expect(updated?.resultSignedUrl).toBe("https://signed/x");
		expect(updated?.completedAt).toBe("2026-06-02T01:00:00.000Z");
	});

	test("claimNextQueued flips exactly one queued job to processing", async () => {
		const client = new FakeExportJobSqlClient();
		const store = new PostgresExportJobStore(client);
		await enqueueExportJob({ projectId: "p", preset: "mobile", imageIds: ["a.png"] }, { store, now: () => new Date("2026-06-02T00:00:00.000Z") });
		await enqueueExportJob({ projectId: "p", preset: "mobile", imageIds: ["b.png"] }, { store, now: () => new Date("2026-06-02T00:00:01.000Z") });

		const first = await store.claimNextQueued();
		const second = await store.claimNextQueued();
		const third = await store.claimNextQueued();
		expect(first?.status).toBe("processing");
		expect(second?.status).toBe("processing");
		expect(first?.id).not.toBe(second?.id);
		expect(third).toBeUndefined();
	});
});

describe("PostgresExportPresetStore", () => {
	test("save upserts by (workspace, name) and listByWorkspace is workspace-scoped", async () => {
		const client = new FakeExportPresetSqlClient();
		const store = new PostgresExportPresetStore(client);
		await store.save({ id: "p1", workspaceId: "ws-1", name: "House Web", config: { maxWidth: 1200 }, createdBy: "u1" });
		await store.save({ id: "p2", workspaceId: "ws-1", name: "House Web", config: { maxWidth: 1000 }, createdBy: "u1" });
		await store.save({ id: "p3", workspaceId: "ws-2", name: "Other", config: {}, createdBy: "u2" });

		const ws1 = await store.listByWorkspace("ws-1");
		expect(ws1).toHaveLength(1); // upserted, not duplicated
		expect(ws1[0]!.config).toEqual({ maxWidth: 1000 });
		expect(await store.listByWorkspace("ws-2")).toHaveLength(1);
		expect(await store.listByWorkspace("ws-3")).toHaveLength(0);
	});
});

// ── Routes (anonymous / personal-project path) ───────────────────────────────

function buildApp() {
	const app = new Hono();
	app.route("/api/export", exportRoutes);
	return app;
}

// Export authz mirrors the project routes: an ownerless (legacy) project is only
// reachable without auth when the legacy-anonymous hatch is explicitly enabled
// (apiAuthRequired=false AND allowLegacyAnonymousProjects=true). Toggle it for the
// anonymous-path tests and restore afterward.
function enableLegacyAnonymous(): () => void {
	const snapshot = {
		apiAuthRequired: serverConfig.apiAuthRequired,
		allowLegacyAnonymousProjects: serverConfig.allowLegacyAnonymousProjects,
	};
	Object.assign(serverConfig as unknown as Record<string, unknown>, {
		apiAuthRequired: false,
		allowLegacyAnonymousProjects: true,
	});
	return () => Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
}

// Force the hardened posture (legacy-anonymous hatch OFF) deterministically, since
// serverConfig is a shared singleton other tests in the suite mutate.
function disableLegacyAnonymous(): () => void {
	const snapshot = {
		apiAuthRequired: serverConfig.apiAuthRequired,
		allowLegacyAnonymousProjects: serverConfig.allowLegacyAnonymousProjects,
	};
	Object.assign(serverConfig as unknown as Record<string, unknown>, {
		apiAuthRequired: false,
		allowLegacyAnonymousProjects: false,
	});
	return () => Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
}

describe("export routes", () => {
	test("GET /presets returns the five built-in presets without auth", async () => {
		const res = await buildApp().request("/api/export/presets");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { presets: { preset: string }[]; workspacePresets: unknown[] };
		expect(body.presets.map((p) => p.preset).sort()).toEqual([
			"master", "mobile", "web_reader", "webp_avif", "webtoon_split",
		]);
		expect(body.workspacePresets).toEqual([]);
	});

	test("POST / enqueues a job for an anonymous project and returns 202 + queued job", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk();
			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader" }),
			});
			expect(res.status).toBe(202);
			const body = (await res.json()) as { job: { status: string; preset: string; params: { imageIds: string[] } } };
			expect(body.job.status).toBe("queued");
			expect(body.job.preset).toBe("web_reader");
			// Defaulted to the project's page image ids.
			expect(body.job.params.imageIds.length).toBe(1);
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / rejects unknown params keys (strict schema) — no arbitrary z.record(unknown)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk();
			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				// An unrecognized control field must be rejected, not silently passed through.
				body: JSON.stringify({ projectId, preset: "web_reader", params: { evilControl: 1 } }),
			});
			expect(res.status).toBe(400);
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / rejects an over-long sliceHeights array and out-of-range slice values (slice-control DoS gate)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk();
			// 100-element sliceHeights array exceeds the bound → 400.
			const tooMany = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "webtoon_split", params: { sliceHeights: Array(100).fill(1500) } }),
			});
			expect(tooMany.status).toBe(400);

			// A non-integer / out-of-range slice value is rejected at the schema.
			const badValue = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "webtoon_split", params: { sliceHeights: [0] } }),
			});
			expect(badValue.status).toBe(400);
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / accepts a valid bounded sliceHeights override (normal webtoon export still works)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk();
			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "webtoon_split", params: { sliceHeights: [1500, 2000] } }),
			});
			expect(res.status).toBe(202);
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / accepts an explicit custom-height split override", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk();
			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					projectId,
					preset: "webtoon_split",
					params: { split: { mode: "height", heightPerPiece: 1800 } },
				}),
			});
			expect(res.status).toBe(202);
			const body = (await res.json()) as { job: { params: { split?: { mode?: string; heightPerPiece?: number } } } };
			expect(body.job.params.split).toEqual({ mode: "height", heightPerPiece: 1800 });
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / rejects malformed custom-height split overrides", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk();
			for (const split of [
				{ mode: "count", pieceCount: 4 },
				{ mode: "height", heightPerPiece: 0 },
				{ mode: "height", heightPerPiece: 1200, extra: true },
			]) {
				const res = await buildApp().request("/api/export", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ projectId, preset: "webtoon_split", params: { split } }),
				});
				expect(res.status).toBe(400);
			}
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / persists explicit targetLang, and omitted targetLang defaults to the project targetLang", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const projectId = uuid();
			const imageId = "page.png";
			writeProjectStateForTest({
				projectId,
				userId: "",
				name: "Export Lang Test",
				createdAt: new Date().toISOString(),
				// Page has an "en" output so the explicit non-default track is valid.
				pages: [{
					imageId,
					imageName: imageId,
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
					languageOutputs: { en: { typesetImageId: "page-en.png" } },
				}],
				currentPage: 0,
				targetLang: "th",
			});
			const explicit = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader", targetLang: "en" }),
			});
			expect(explicit.status).toBe(202);
			const explicitBody = (await explicit.json()) as { job: { id: string; targetLang?: string } };
			expect(explicitBody.job.targetLang).toBe("en");
			expect((await store.get(explicitBody.job.id))?.targetLang).toBe("en");

			const omitted = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader" }),
			});
			expect(omitted.status).toBe(202);
			const omittedBody = (await omitted.json()) as { job: { id: string; targetLang?: string } };
			expect(omittedBody.job.targetLang).toBe("th");
			expect((await store.get(omittedBody.job.id))?.targetLang).toBe("th");
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / rejects an explicit non-default targetLang that has no per-page output (no silent source export)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const projectId = uuid();
			const imageId = "page.png";
			// Default "th"; the page has a th output but NO en output.
			writeProjectStateForTest({
				projectId,
				userId: "",
				name: "Export Missing Lang Test",
				createdAt: new Date().toISOString(),
				pages: [{
					imageId,
					imageName: imageId,
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
					languageOutputs: { th: { typesetImageId: "page-th.png" } },
				}],
				currentPage: 0,
				targetLang: "th",
			});

			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader", targetLang: "en" }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { code: string; targetLang: string; imageIds: string[] };
			expect(body.code).toBe("missing_language_output");
			expect(body.targetLang).toBe("en");
			expect(body.imageIds).toEqual([imageId]);
			// No job should have been created (the queue is empty).
			expect(await store.claimNextQueued()).toBeUndefined();
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / is BLOCKED (409 export_not_ready) when the EDITED export background is not moderation-passed (codex P0/P1)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const projectId = uuid();
			const imageId = "src.png";
			const editedId = "edited.png";
			// The export renders the EDITED background (page.edits.imageId). Source is
			// passed, but the edited asset is needs_review → export must be held server-side.
			writeProjectStateForTest({
				projectId,
				userId: "",
				name: "Export Edited Moderation Gate",
				createdAt: new Date().toISOString(),
				pages: [{ imageId, imageName: imageId, textLayers: [], pendingAiJobs: [], coverRect: null, edits: { imageId: editedId } }],
				currentPage: 0,
				targetLang: "th",
			});
			// Override the edited asset to needs_review (writeProjectStateForTest wrote it passed).
			const now = new Date().toISOString();
			writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify({
				[imageId]: { assetId: imageId, projectId, imageId, originalName: imageId, mimeType: "image/png", sizeBytes: 1, sha256: "0".repeat(64), storageDriver: "local", storageKey: `projects/${projectId}/images/${imageId}`, width: 1, height: 1, storageStatus: "released", moderation: { status: "passed", provider: "test", checkedAt: now }, derivatives: [], createdAt: now, updatedAt: now },
				[editedId]: { assetId: editedId, projectId, imageId: editedId, originalName: editedId, mimeType: "image/png", sizeBytes: 1, sha256: "1".repeat(64), storageDriver: "local", storageKey: `projects/${projectId}/images/${editedId}`, width: 1, height: 1, storageStatus: "released", moderation: { status: "needs_review", provider: "test", checkedAt: now }, derivatives: [], createdAt: now, updatedAt: now },
			}));

			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader" }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { code: string; blockers: string[] };
			expect(body.code).toBe("export_not_ready");
			expect(body.blockers).toContain("moderation_not_passed");
			// No job enqueued.
			expect(await store.claimNextQueued()).toBeUndefined();
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / is BLOCKED when a visible image LAYER asset is not moderation-passed (codex P0/P1)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const projectId = uuid();
			const imageId = "bg.png";
			const layerId = "layer.png";
			writeProjectStateForTest({
				projectId,
				userId: "",
				name: "Export Layer Moderation Gate",
				createdAt: new Date().toISOString(),
				pages: [{ imageId, imageName: imageId, textLayers: [], pendingAiJobs: [], coverRect: null, imageLayers: [{ id: "l1", imageId: layerId, visible: true }] }],
				currentPage: 0,
				targetLang: "th",
			});
			const now = new Date().toISOString();
			writeFileSync(join(PROJECTS_DIR, projectId, "assets.json"), JSON.stringify({
				[imageId]: { assetId: imageId, projectId, imageId, originalName: imageId, mimeType: "image/png", sizeBytes: 1, sha256: "0".repeat(64), storageDriver: "local", storageKey: `projects/${projectId}/images/${imageId}`, width: 1, height: 1, storageStatus: "released", moderation: { status: "passed", provider: "test", checkedAt: now }, derivatives: [], createdAt: now, updatedAt: now },
				// Layer asset blocked → export held.
				[layerId]: { assetId: layerId, projectId, imageId: layerId, originalName: layerId, mimeType: "image/png", sizeBytes: 1, sha256: "2".repeat(64), storageDriver: "local", storageKey: `projects/${projectId}/images/${layerId}`, width: 1, height: 1, storageStatus: "blocked", moderation: { status: "blocked", provider: "test", checkedAt: now }, derivatives: [], createdAt: now, updatedAt: now },
			}));

			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader" }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { code: string; blockers: string[] };
			expect(body.code).toBe("export_not_ready");
			expect(body.blockers).toContain("moderation_not_passed");
			expect(await store.claimNextQueued()).toBeUndefined();
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / is BLOCKED when a page image has NO asset record (legacy unregistered asset no longer slips, codex P0/P1)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const projectId = uuid();
			const imageId = `${uuid()}.png`;
			// State references a page image but NO assets.json is written → unregistered.
			mkdirSync(join(PROJECTS_DIR, projectId, "images"), { recursive: true });
			createdProjectDirs.push(join(PROJECTS_DIR, projectId));
			writeFileSync(join(PROJECTS_DIR, projectId, "state.json"), JSON.stringify({
				projectId,
				userId: "",
				name: "Export Unregistered Asset Gate",
				createdAt: new Date().toISOString(),
				pages: [{ imageId, imageName: imageId, textLayers: [], pendingAiJobs: [], coverRect: null }],
				currentPage: 0,
				targetLang: "th",
			}));

			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader" }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { code: string; blockers: string[] };
			expect(body.code).toBe("export_not_ready");
			expect(body.blockers).toContain("moderation_not_passed");
			expect(await store.claimNextQueued()).toBeUndefined();
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / denies an ownerless project when the legacy-anonymous hatch is off (hardened default)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = disableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk(); // ownerless, no workspace
			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader" }),
			});
			// Hardened posture (flag off): anonymous cannot export an ownerless project.
			expect(res.status).toBe(401);
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / rejects an unknown preset", async () => {
		const { projectId } = createProjectOnDisk();
		const res = await buildApp().request("/api/export", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId, preset: "nope" }),
		});
		expect(res.status).toBe(400);
	});

	test("POST / returns 404 for a missing project", async () => {
		const res = await buildApp().request("/api/export", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: uuid(), preset: "mobile" }),
		});
		expect(res.status).toBe(404);
	});

	test("POST / denies an anonymous caller for an owner-bound project (isolation)", async () => {
		const { projectId } = createProjectOnDisk({ userId: "owner-1" });
		const res = await buildApp().request("/api/export", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId, preset: "mobile" }),
		});
		// Owner-bound project, no auth -> 401 (anonymous cannot export it).
		expect(res.status).toBe(401);
	});

	test("GET /:id returns a freshly minted signed URL + per-object download views for a completed job", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk();
			storage.seedImage(projectId, "p.png", await makeTallImage(1000, 800));
			const queued = await enqueueExportJob({ projectId, preset: "mobile", imageIds: ["p.png"] }, { store });
			await processExportJob(queued.id, { store, storage });

			const res = await buildApp().request(`/api/export/${queued.id}`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				job: { status: string; resultSignedUrl: string; outputs: Array<{ objectId: string; downloadPath: string }> };
			};
			expect(body.job.status).toBe("done");
			expect(body.job.resultSignedUrl).toContain("https://");
			// Every produced object (page + manifest) is downloadable via a backend path.
			expect(body.job.outputs.length).toBeGreaterThanOrEqual(2);
			expect(body.job.outputs.every((o) => o.downloadPath.startsWith(`/api/export/${queued.id}/objects/`))).toBe(true);
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("GET /:id returns 404 for an unknown job", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		try {
			const res = await buildApp().request(`/api/export/${uuid()}`);
			expect(res.status).toBe(404);
		} finally {
			restore();
		}
	});

	test("GET /:id/objects/* serves a produced export object through the backend (local-disk fallback)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			// Use the real local-disk object storage so the source/export round-trips
			// on disk and the presign path returns undefined (forcing the backend
			// download fallback this route provides).
			const { objectStorage } = await import("../services/storage.js");
			const { projectId, imageId } = createProjectOnDisk();
			await objectStorage.putProjectImage({ projectId, imageId, buffer: await makeTallImage(900, 700) });
			const queued = await enqueueExportJob({ projectId, preset: "mobile", imageIds: [imageId] }, { store });
			await processExportJob(queued.id, { store });

			const statusRes = await buildApp().request(`/api/export/${queued.id}`);
			const body = (await statusRes.json()) as { job: { outputs: Array<{ objectId: string; downloadPath: string }> } };
			const pageOutput = body.job.outputs.find((o) => !o.objectId.endsWith("manifest.json"))!;
			expect(pageOutput).toBeDefined();

			const dl = await buildApp().request(pageOutput.downloadPath);
			expect(dl.status).toBe(200);
			expect((await dl.arrayBuffer()).byteLength).toBeGreaterThan(0);

			// An object the job never produced is not downloadable through this route.
			const bogus = await buildApp().request(`/api/export/${queued.id}/objects/${queued.id}/not-a-real-output.jpg`);
			expect(bogus.status).toBe(404);
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST /presets requires auth", async () => {
		const res = await buildApp().request("/api/export/presets", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", name: "X", config: {} }),
		});
		expect(res.status).toBe(401);
	});
});

// ── Export parity: image-layer compositing ───────────────────────────────────
//
// The CLIENT export composites every visible page.imageLayers[] over the
// background in z-order. These assert the SERVER pipeline now does the same:
// visible layers paint at their placed position/size, hidden layers are
// excluded, z-order is honored, a missing layer asset is skipped (not fatal),
// and a text-only / layerless page stays byte-identical to the pre-parity output.
describe("export parity: image-layer compositing", () => {
	function stateWithLayers(
		projectId: string,
		sourceImageId: string,
		imageLayers: Array<Record<string, unknown>>,
	): never {
		return {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				imageLayers,
			}],
		} as never;
	}

	test("composites a visible image layer over the background at its placed box (differs from background-only)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const layerImageId = "overlay.png";
		// White page; a small red layer placed at (60,60) sized 40x40.
		storage.seedImage(projectId, sourceImageId, await solidPng(200, 200, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, layerImageId, await solidPng(40, 40, { r: 255, g: 0, b: 0 }));

		const state = stateWithLayers(projectId, sourceImageId, [{
			id: "overlay-1",
			imageId: layerImageId,
			imageName: layerImageId,
			x: 60, y: 60, w: 40, h: 40,
			rotation: 0, opacity: 1, index: 0, zIndex: 0,
		}]);

		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		// The render plan persisted the image layer so the processor is self-contained.
		const plans = queued.params.renderPlans as Array<{ imageLayers?: unknown[] }> | undefined;
		expect(plans?.[0]?.imageLayers).toHaveLength(1);

		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;

		// Inside the layer box => red; outside (a corner) => still white background.
		const inside = await samplePixelAt(out, 80, 80);
		expect(inside.r).toBeGreaterThan(200);
		expect(inside.g).toBeLessThan(60);
		expect(inside.b).toBeLessThan(60);
		const corner = await samplePixelAt(out, 5, 5);
		expect(corner.r).toBeGreaterThan(200);
		expect(corner.g).toBeGreaterThan(200);
		expect(corner.b).toBeGreaterThan(200);
	});

	test("excludes a hidden (visible:false) layer", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const layerImageId = "hidden.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(120, 120, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, layerImageId, await solidPng(120, 120, { r: 0, g: 0, b: 255 }));

		const state = stateWithLayers(projectId, sourceImageId, [{
			id: "hidden-1",
			imageId: layerImageId,
			imageName: layerImageId,
			x: 0, y: 0, w: 120, h: 120,
			rotation: 0, opacity: 1, index: 0, zIndex: 0,
			visible: false,
		}]);

		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		// A page with ONLY a hidden layer carries no image-layer plan.
		const plans = queued.params.renderPlans as Array<{ imageLayers?: unknown[] }> | undefined;
		expect(plans?.[0]?.imageLayers ?? undefined).toBeUndefined();

		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		// The full-page blue layer was hidden => the page stays white.
		const center = await samplePixelAt(out, 60, 60);
		expect(center.r).toBeGreaterThan(200);
		expect(center.g).toBeGreaterThan(200);
		expect(center.b).toBeGreaterThan(200);
	});

	test("honors z-order: a higher-z layer paints over a lower-z layer", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(100, 100, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, "low.png", await solidPng(100, 100, { r: 0, g: 255, b: 0 }));   // green
		storage.seedImage(projectId, "high.png", await solidPng(100, 100, { r: 255, g: 0, b: 0 }));  // red

		// Both cover the whole page; the high-z red must win at the center.
		const state = stateWithLayers(projectId, sourceImageId, [
			{ id: "low", imageId: "low.png", imageName: "low.png", x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, index: 0, zIndex: 1 },
			{ id: "high", imageId: "high.png", imageName: "high.png", x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, index: 1, zIndex: 5 },
		]);

		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		const center = await samplePixelAt(out, 50, 50);
		expect(center.r).toBeGreaterThan(200); // red on top
		expect(center.g).toBeLessThan(60);
		expect(center.b).toBeLessThan(60);
	});

	test("skips a missing layer asset on a DRAFT export (page still renders, job completes)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(80, 80, { r: 255, g: 255, b: 255 }));
		// Layer asset deliberately NOT seeded.

		const state = stateWithLayers(projectId, sourceImageId, [{
			id: "ghost",
			imageId: "does-not-exist.png",
			imageName: "does-not-exist.png",
			x: 0, y: 0, w: 80, h: 80, rotation: 0, opacity: 1, index: 0, zIndex: 0,
		}]);

		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
			// Draft/internal preview: a missing layer asset is skipped (not fatal),
			// matching the client's per-layer honesty. (A PUBLISH export fails closed —
			// see "missing-layer fail-closed for publish" below.)
			params: { draft: true },
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		const center = await samplePixelAt(out, 40, 40);
		// The page background is intact (the unrenderable layer was skipped, not drawn).
		expect(center.r).toBeGreaterThan(200);
		expect(center.g).toBeGreaterThan(200);
		expect(center.b).toBeGreaterThan(200);
	});

	test("applies layer opacity (semi-transparent layer blends toward the background)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(60, 60, { r: 0, g: 0, b: 0 }));    // black bg
		storage.seedImage(projectId, "white.png", await solidPng(60, 60, { r: 255, g: 255, b: 255 })); // white layer

		const state = stateWithLayers(projectId, sourceImageId, [{
			id: "half",
			imageId: "white.png",
			imageName: "white.png",
			x: 0, y: 0, w: 60, h: 60, rotation: 0, opacity: 0.5, index: 0, zIndex: 0,
		}]);

		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		const center = await samplePixelAt(out, 30, 30);
		// 50% white over black => mid-gray (not full white, not black).
		expect(center.r).toBeGreaterThan(90);
		expect(center.r).toBeLessThan(180);
	});

	test("a per-language languageOutputs[track].imageLayers overrides the flat page.imageLayers", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(100, 100, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, "flat.png", await solidPng(100, 100, { r: 0, g: 255, b: 0 }));  // default green
		storage.seedImage(projectId, "en.png", await solidPng(100, 100, { r: 255, g: 0, b: 0 }));    // en red

		// Default project lang "th"; page has a flat green layer, but the explicit "en"
		// track overrides imageLayers with a red layer. Exporting "en" must use the red.
		const state = {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				imageLayers: [
					{ id: "flat", imageId: "flat.png", imageName: "flat.png", x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, index: 0, zIndex: 0 },
				],
				languageOutputs: {
					en: {
						textLayers: [],
						imageLayers: [
							{ id: "en-layer", imageId: "en.png", imageName: "en.png", x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, index: 0, zIndex: 0 },
						],
					},
				},
			}],
		} as never;

		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "en", requestedTargetLang: "en", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		const center = await samplePixelAt(out, 50, 50);
		// The en-track override (red) wins over the flat default (green).
		expect(center.r).toBeGreaterThan(200);
		expect(center.g).toBeLessThan(60);
	});

	test("a text-only / layerless page stays byte-identical to the pre-parity master output", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const source = await solidPng(100, 80, { r: 123, g: 45, b: 67 });
		storage.seedImage(projectId, sourceImageId, source);

		// No imageLayers, no languageOutputs => legacy single-language path, no plan.
		const state = {
			projectId,
			targetLang: "th",
			pages: [{ imageId: sourceImageId, imageName: sourceImageId, textLayers: [], pendingAiJobs: [], coverRect: null }],
		} as never;

		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		// Master with no layers/text => byte-for-byte copy of the immutable source.
		expect(out.equals(source)).toBe(true);
	});
});

// ── P1 #1: moderation/release bypass (defense-in-depth) ───────────────────────
// A visible image layer whose asset is registered-but-blocked/pending (or fails
// the readiness assert) must FAIL the export job — never silently composited
// (would leak unmoderated content) and never silently skipped (would drop content
// the user placed). A registry-clean (legacy/unregistered) layer is unaffected.
describe("export parity: image-layer readiness gate (defense-in-depth)", () => {
	function stateWithOneLayer(projectId: string, sourceImageId: string, layer: Record<string, unknown>): never {
		return {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				imageLayers: [layer],
			}],
		} as never;
	}

	test("a BLOCKED/pending visible layer asset FAILS the job (not composited, not skipped)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const layerImageId = "blocked.png";
		// Both source + layer bytes EXIST in storage — only the registry verdict blocks it,
		// proving we gate on readiness, not on byte availability.
		storage.seedImage(projectId, sourceImageId, await solidPng(80, 80, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, layerImageId, await solidPng(80, 80, { r: 255, g: 0, b: 0 }));

		// Simulate the authoritative registry reporting this layer as not-released.
		const restore = setExportLayerReadinessAssertForTests(async (_projectId, imageId) => {
			if (imageId === layerImageId) {
				throw new Error(`Export layer asset ${imageId} is not released (storageStatus=blocked)`);
			}
		});
		try {
			const state = stateWithOneLayer(projectId, sourceImageId, {
				id: "blocked-1", imageId: layerImageId, imageName: layerImageId,
				x: 0, y: 0, w: 80, h: 80, rotation: 0, opacity: 1, index: 0, zIndex: 0,
			});
			const queued = await enqueueExportJob({
				projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
			}, { store });

			await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/not released/);
			const failed = await store.get(queued.id);
			expect(failed?.status).toBe("error");
			// Nothing was written to the exports namespace — the blocked content never leaked.
			expect(storage.exports.size).toBe(0);
		} finally {
			restore();
		}
	});

	test("SECURITY: an aijob_provider_* render background FAILS the job (raw checkpoint bypass)", async () => {
		// Exploit: a member points the per-language render background at the RAW
		// pre-moderation provider checkpoint `aijob_provider_<jobId>.png` (no asset
		// record, deleted only on job terminal). The pipeline must HARD-DENY it before
		// any read — never composite unmoderated bytes into the artifact — even though
		// an unregistered NON-checkpoint id would be allowed (prototype compat).
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const checkpointId = "aijob_provider_job-xyz.png";
		// Both source + the raw checkpoint bytes EXIST in storage — only the prefix gate
		// blocks it, proving we deny on identity, not byte availability.
		storage.seedImage(projectId, sourceImageId, await solidPng(80, 80, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, checkpointId, await solidPng(80, 80, { r: 255, g: 0, b: 0 }));

		const state = {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				// Laundered: per-language typeset background points at the raw checkpoint.
				languageOutputs: { th: { typesetImageId: checkpointId } },
			}],
		} as never;
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });

		await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/internal pre-moderation object/);
		const failed = await store.get(queued.id);
		expect(failed?.status).toBe("error");
		// Nothing was written to the exports namespace — the raw bytes never leaked.
		expect(storage.exports.size).toBe(0);
		// DENY-BEFORE-ANY-READ: the raw checkpoint bytes were never fetched into memory —
		// not even by the preflight pixel-budget estimator (which reads source headers
		// before the render loop). The deny must fire before the FIRST storage read.
		expect(storage.readImageIds).not.toContain(checkpointId);
	});

	test("SECURITY: an aijob_provider_* PLACED LAYER also FAILS the job", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const checkpointId = "aijob_provider_layer-job.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(80, 80, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, checkpointId, await solidPng(80, 80, { r: 0, g: 255, b: 0 }));
		const state = stateWithOneLayer(projectId, sourceImageId, {
			id: "ck-1", imageId: checkpointId, imageName: checkpointId,
			x: 0, y: 0, w: 80, h: 80, rotation: 0, opacity: 1, index: 0, zIndex: 0,
		});
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/internal pre-moderation object/);
		expect((await store.get(queued.id))?.status).toBe("error");
		expect(storage.exports.size).toBe(0);
	});

	test("a registry-clean (legacy/unregistered) layer is allowed and composites", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const layerImageId = "ok.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(80, 80, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, layerImageId, await solidPng(80, 80, { r: 255, g: 0, b: 0 }));

		// Default assert (getAssetRecordAuthoritative) returns undefined for an
		// unseeded asset registry => legacy compatibility => allowed.
		const state = stateWithOneLayer(projectId, sourceImageId, {
			id: "ok-1", imageId: layerImageId, imageName: layerImageId,
			x: 0, y: 0, w: 80, h: 80, rotation: 0, opacity: 1, index: 0, zIndex: 0,
		});
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		const center = await samplePixelAt(out, 40, 40);
		expect(center.r).toBeGreaterThan(200);
		expect(center.g).toBeLessThan(60);
	});
});

// ── P1 #2: interleaved image/text z-order parity with the client ──────────────
// The client builds ONE combined image+text stack sorted by zIndex (image wins an
// equal-z tie). A text layer whose zIndex sits BELOW an image layer's must render
// the image OVER the text (the server's old two-pass "all images then all text"
// got this wrong). The common "all text above all images" case is unchanged.
describe("export parity: interleaved image/text z-order", () => {
	// Text layers are resolved through `languageOutputs[track].textLayers` (the same
	// per-language path the pipeline uses); image layers are read flat. zIndex on
	// each layer drives the interleave under test.
	function stateWithImageAndText(
		projectId: string,
		sourceImageId: string,
		imageLayers: Array<Record<string, unknown>>,
		textLayers: Array<Record<string, unknown>>,
	): never {
		return {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				imageLayers,
				languageOutputs: { th: { textLayers } },
			}],
		} as never;
	}

	// A full-page white image layer + large black text. Whichever has the higher
	// zIndex paints last (on top): text-above => dark glyphs survive; text-below =>
	// the opaque white image covers the text, leaving (near-)no dark pixels.
	const whiteLayer = (zIndex: number) => ({
		id: `img-${zIndex}`, imageId: "white.png", imageName: "white.png",
		x: 0, y: 0, w: 200, h: 200, rotation: 0, opacity: 1, index: 0, zIndex,
	});
	const blackText = (zIndex: number) => ({
		id: `txt-${zIndex}`, text: "HELLO WORLD",
		x: 10, y: 80, w: 180, h: 40, rotation: 0, fontSize: 40,
		fill: "#000000", alignment: "left", index: 1, zIndex,
	});

	async function renderDark(
		imageZ: number,
		textZ: number,
	): Promise<number> {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		// Black background so a missing/hidden white layer can't be confused with text.
		storage.seedImage(projectId, sourceImageId, await solidPng(200, 200, { r: 80, g: 80, b: 80 }));
		storage.seedImage(projectId, "white.png", await solidPng(200, 200, { r: 255, g: 255, b: 255 }));
		const state = stateWithImageAndText(projectId, sourceImageId, [whiteLayer(imageZ)], [blackText(textZ)]);
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		return countDarkPixels(out);
	}

	test("text BELOW an image layer: the image renders OVER the text (text hidden)", async () => {
		// text zIndex 1 < image zIndex 5 => white image paints last, covering the text.
		const dark = await renderDark(5, 1);
		// The opaque white full-page layer covers both the grey background AND the text.
		expect(dark).toBeLessThan(50);
	});

	test("text ABOVE an image layer (common case): the text renders OVER the image", async () => {
		// text zIndex 5 > image zIndex 1 => text paints last, dark glyphs survive on white.
		const dark = await renderDark(1, 5);
		expect(dark).toBeGreaterThan(200);
	});

	test("all-fallback (no zIndex anywhere): text renders ABOVE multiple image layers, matching the client", async () => {
		// Client fallback (page-export.ts): image z = its array index (0, 1); text z =
		// imageLayers.length + textIndex = 2 => text paints last (on top). The old
		// server text fallback `layer.index` tied with the first image and let the
		// SECOND image (fallback z=1) cover the text — this asserts the fix.
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(200, 200, { r: 80, g: 80, b: 80 }));
		storage.seedImage(projectId, "white.png", await solidPng(200, 200, { r: 255, g: 255, b: 255 }));
		const noZ = (id: string) => ({
			id, imageId: "white.png", imageName: "white.png",
			x: 0, y: 0, w: 200, h: 200, rotation: 0, opacity: 1, index: 0,
		});
		const text = {
			id: "t", text: "HELLO WORLD",
			x: 10, y: 80, w: 180, h: 40, rotation: 0, fontSize: 40,
			fill: "#000000", alignment: "left", index: 0,
		};
		const state = stateWithImageAndText(projectId, sourceImageId, [noZ("a"), noZ("b")], [text]);
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		expect(await countDarkPixels(out)).toBeGreaterThan(200);
	});

	test("HIDDEN image layer doesn't shrink the text fallback base (client parity, no-zIndex)", async () => {
		// A hidden image layer sits at pre-filter index 0; the visible one at index 1.
		// Client base = page.imageLayers.length (2, PRE-filter), so the no-zIndex text
		// resolves to z=2 and renders ABOVE the visible image (fallback z=1). The old
		// post-filter base (1) tied the text with the visible image and let it be
		// covered — this asserts the pre-filter base.
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(200, 200, { r: 80, g: 80, b: 80 }));
		storage.seedImage(projectId, "white.png", await solidPng(200, 200, { r: 255, g: 255, b: 255 }));
		const imgLayer = (id: string, visible: boolean) => ({
			id, imageId: "white.png", imageName: "white.png",
			x: 0, y: 0, w: 200, h: 200, rotation: 0, opacity: 1, index: 0, visible,
		});
		const text = {
			id: "t", text: "HELLO WORLD",
			x: 10, y: 80, w: 180, h: 40, rotation: 0, fontSize: 40,
			fill: "#000000", alignment: "left", index: 0,
		};
		const state = stateWithImageAndText(projectId, sourceImageId, [imgLayer("hidden", false), imgLayer("shown", true)], [text]);
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		expect(await countDarkPixels(out)).toBeGreaterThan(200);
	});

	test("text-only page is unaffected by interleaving (text renders as before)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(200, 200, { r: 255, g: 255, b: 255 }));
		const state = stateWithImageAndText(projectId, sourceImageId, [], [blackText(0)]);
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		expect(await countDarkPixels(out)).toBeGreaterThan(200);
	});
});

// ── P1 #3: DoS resource limits before Sharp allocation ────────────────────────
// Unbounded layer count / source pixels / target pixels could exhaust CPU+memory.
// A violation must REJECT the job with an actionable error before any large Sharp
// allocation; a within-limit page composites fine.
describe("export parity: image-layer DoS limits", () => {
	function stateWithLayers(projectId: string, sourceImageId: string, imageLayers: Array<Record<string, unknown>>): never {
		return {
			projectId, targetLang: "th",
			pages: [{ imageId: sourceImageId, imageName: sourceImageId, textLayers: [], pendingAiJobs: [], coverRect: null, imageLayers }],
		} as never;
	}

	test("a layer with an oversized target box REJECTS the job (actionable error, no OOM)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(40, 40, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, "huge.png", await solidPng(10, 10, { r: 255, g: 0, b: 0 }));

		// Target box far exceeds the per-layer target-pixel cap (but each dimension
		// stays within the project's 1e6-px coordinate caps, proving we bound the
		// PRODUCT, not just a single dimension).
		const oversize = Math.ceil(Math.sqrt(EXPORT_LAYER_LIMITS.maxTargetPixelsPerLayer)) + 1000;
		const state = stateWithLayers(projectId, sourceImageId, [{
			id: "huge", imageId: "huge.png", imageName: "huge.png",
			x: 0, y: 0, w: oversize, h: oversize, rotation: 0, opacity: 1, index: 0, zIndex: 0,
		}]);
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });

		await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/too large/);
		const failed = await store.get(queued.id);
		expect(failed?.status).toBe("error");
		expect(storage.exports.size).toBe(0);
	});

	test("too many visible layers REJECTS the job before any decode", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(40, 40, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, "tiny.png", await solidPng(2, 2, { r: 0, g: 0, b: 255 }));

		const count = EXPORT_LAYER_LIMITS.maxVisibleLayersPerPage + 5;
		const layers = Array.from({ length: count }, (_, i) => ({
			id: `l-${i}`, imageId: "tiny.png", imageName: "tiny.png",
			x: 0, y: 0, w: 2, h: 2, rotation: 0, opacity: 1, index: i, zIndex: i,
		}));
		const state = stateWithLayers(projectId, sourceImageId, layers);
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });

		await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/too many visible image layers/);
		expect((await store.get(queued.id))?.status).toBe("error");
		expect(storage.exports.size).toBe(0);
	});

	test("a within-limit page composites fine (limits do not regress the happy path)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(100, 100, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, "ok.png", await solidPng(50, 50, { r: 255, g: 0, b: 0 }));

		const state = stateWithLayers(projectId, sourceImageId, [{
			id: "ok", imageId: "ok.png", imageName: "ok.png",
			x: 25, y: 25, w: 50, h: 50, rotation: 0, opacity: 1, index: 0, zIndex: 0,
		}]);
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		const center = await samplePixelAt(out, 50, 50);
		expect(center.r).toBeGreaterThan(200);
		expect(center.g).toBeLessThan(60);
	});
});

// Sanity: the module-level store + signing remain wired (no behavioral change).
describe("module wiring", () => {
	test("setExportJobStoreForTests swaps and restores the active store", async () => {
		const fake: ExportJobStore = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(fake);
		const job: ExportJob = await enqueueExportJob({ projectId: "p", preset: "master", imageIds: ["a.png"] });
		expect(await fake.get(job.id)).toBeDefined();
		restore();
	});
});

// ── Money integrity: post-commit export-usage metering ───────────────────────
//
// A completed PAID export must be metered EXACTLY ONCE or left in a retryable
// pending state — a transient ledger blip (or quota rejection) must never silently
// drop export-byte accounting. These drive the retry / durable-pending / reconcile
// logic via the recorder seam so we don't depend on the real ledger failing.
// ── Export hardening (codex regression audit) ─────────────────────────────────
describe("export hardening: source/edited readiness fail-closed (#1)", () => {
	test("a BLOCKED registered SOURCE/background asset FAILS the job (no output written)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "blocked-source.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(60, 60, { r: 255, g: 255, b: 255 }));

		// The render background (source/edited) is asserted through the SAME readiness
		// seam as layers. Simulate the registry reporting it as not-passed.
		const restore = setExportLayerReadinessAssertForTests(async (_p, imageId) => {
			if (imageId === sourceImageId) {
				throw new Error(`Export layer asset ${imageId} moderation status is blocked`);
			}
		});
		try {
			const queued = await enqueueExportJob({
				projectId, preset: "master", imageIds: [sourceImageId],
			}, { store });
			await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/moderation status is blocked/);
			const failed = await store.get(queued.id);
			expect(failed?.status).toBe("error");
			// Nothing leaked into the exports namespace.
			expect(storage.exports.size).toBe(0);
		} finally {
			restore();
		}
	});

	test("a BLOCKED registered EDITED background (renderImageId != source) FAILS the job", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "source.png";
		const editedImageId = "edited.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(60, 60, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, editedImageId, await solidPng(60, 60, { r: 0, g: 0, b: 0 }));

		// The page's language output points the export background at the EDITED image.
		const state = {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				languageOutputs: { th: { edits: { imageId: editedImageId } } },
			}],
		} as never;

		const restore = setExportLayerReadinessAssertForTests(async (_p, imageId) => {
			if (imageId === editedImageId) {
				throw new Error(`Export layer asset ${imageId} is not released (storageStatus=blocked)`);
			}
		});
		try {
			const queued = await enqueueExportJob({
				projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
			}, { store });
			await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/not released/);
			expect((await store.get(queued.id))?.status).toBe("error");
			expect(storage.exports.size).toBe(0);
		} finally {
			restore();
		}
	});
});

describe("export hardening: flat-text fallback for legacy/default track (#2)", () => {
	test("a single-language project with only flat page.textLayers exports WITH the text rendered", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		// White background so the rendered black text shows up as dark pixels.
		storage.seedImage(projectId, sourceImageId, await solidPng(200, 120, { r: 255, g: 255, b: 255 }));

		// Legacy/default shape: NO languageOutputs, text lives ONLY in flat page.textLayers.
		const state = {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				pendingAiJobs: [],
				coverRect: null,
				textLayers: [{
					id: "t1", text: "HELLO", x: 10, y: 10, w: 180, h: 60,
					fontSize: 48, fill: "#000000", alignment: "left", visible: true,
				}],
			}],
		} as never;

		// Default track (resolved targetLang = project default "th"), as the route passes it.
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });
		// The render plan must carry the flat text (was dropped before the fix).
		const planText = (queued.params.renderPlans as Array<{ textLayers?: unknown[] }>)?.[0]?.textLayers;
		expect(Array.isArray(planText) && planText.length).toBe(1);

		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		// The black glyphs must be present (a no-text export of a white page has ~0 dark px).
		expect(await countDarkPixels(out)).toBeGreaterThan(50);
	});
});

describe("export hardening: orphan cleanup on partial-write failure (#3)", () => {
	test("a put failure mid-job DELETEs the objects already written (no orphans) and the job errors", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		// webtoon_split produces multiple slices; fail after the first write so at least
		// one orphan would exist without compensating deletes.
		storage.seedImage(projectId, "tall.png", await makeTallImage(1000, 6000));
		storage.failPutExportAfter = 1;

		const queued = await enqueueExportJob({ projectId, preset: "webtoon_split", imageIds: ["tall.png"] }, { store });
		await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/simulated export storage write failure/);

		expect((await store.get(queued.id))?.status).toBe("error");
		// The one object that WAS written must have been compensating-deleted.
		expect(storage.deleteExportCalls.length).toBeGreaterThanOrEqual(1);
		// No orphan objects remain in the exports namespace.
		expect(storage.exports.size).toBe(0);
	});
});

describe("export hardening: missing-layer fail-closed for publish, flagged for draft (#4, codex audit P1)", () => {
	function stateWithMissingLayer(projectId: string, sourceImageId: string, missingLayerId: string): never {
		return {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				imageLayers: [{
					id: "ghost", imageId: missingLayerId, imageName: missingLayerId,
					x: 0, y: 0, w: 80, h: 80, rotation: 0, opacity: 1, index: 0, zIndex: 0,
				}],
			}],
		} as never;
	}

	test("a genuinely MISSING visible layer asset FAILS a PUBLISH export (fail-closed, no partial artifact)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const missingLayerId = "ghost.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(80, 80, { r: 255, g: 255, b: 255 }));
		// Note: the layer asset bytes are intentionally NOT seeded (missing/unreadable).

		const state = stateWithMissingLayer(projectId, sourceImageId, missingLayerId);
		// No `draft` flag => publish profile => must FAIL rather than silently drop the layer.
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
		}, { store });

		await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/could not be composited/);
		const failed = await store.get(queued.id);
		expect(failed?.status).toBe("error");
		// Nothing was published — no partial artifact missing the user-placed layer.
		expect(storage.exports.size).toBe(0);
	});

	test("a genuinely MISSING visible layer asset is SKIPPED + flagged on a DRAFT export (job still done)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const missingLayerId = "ghost.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(80, 80, { r: 255, g: 255, b: 255 }));
		// Note: the layer asset bytes are intentionally NOT seeded (missing/unreadable).

		const state = stateWithMissingLayer(projectId, sourceImageId, missingLayerId);
		// Explicit draft/internal preview => skip + FLAG instead of failing.
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
			params: { draft: true },
		}, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");

		// The job records the dropped layer (honest, not silently wrong).
		const reloaded = await store.get(queued.id);
		const skipped = reloaded?.params.skippedLayers as Array<{ imageId: string; reason: string }> | undefined;
		expect(Array.isArray(skipped)).toBe(true);
		expect(skipped!.some((s) => s.imageId === missingLayerId)).toBe(true);

		// The manifest.json also carries the notice.
		const manifestObjectId = reloaded?.params.manifestObjectId as string;
		const manifestBuffer = storage.exports.get(`${projectId}/${manifestObjectId}`)!;
		const manifest = JSON.parse(manifestBuffer.toString("utf8"));
		expect(manifest.skippedLayers?.some((s: { imageId: string }) => s.imageId === missingLayerId)).toBe(true);
	});

	test("a BLOCKED/pending visible layer asset FAILS even a DRAFT export (unmoderated content never leaks)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		const layerImageId = "blocked.png";
		// Bytes EXIST — only the registry verdict blocks it, proving the readiness gate
		// fires before any byte read regardless of the draft profile.
		storage.seedImage(projectId, sourceImageId, await solidPng(80, 80, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, layerImageId, await solidPng(80, 80, { r: 255, g: 0, b: 0 }));

		const restore = setExportLayerReadinessAssertForTests(async (_p, imageId) => {
			if (imageId === layerImageId) {
				throw new Error(`Export layer asset ${imageId} moderation status is blocked`);
			}
		});
		try {
			const state = stateWithMissingLayer(projectId, sourceImageId, layerImageId);
			const queued = await enqueueExportJob({
				projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
				params: { draft: true },
			}, { store });
			await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/moderation status is blocked/);
			expect((await store.get(queued.id))?.status).toBe("error");
			expect(storage.exports.size).toBe(0);
		} finally {
			restore();
		}
	});
});

describe("export hardening: master preserves true source extension (#7)", () => {
	test("a raw master copy keeps the source .png extension (not .bin)", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		storage.seedImage(projectId, "p.png", await makeTallImage(100, 80));

		const queued = await enqueueExportJob({ projectId, preset: "master", imageIds: ["p.png"] }, { store });
		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		expect(result.outputs[0]!.objectId.endsWith(".png")).toBe(true);
		expect(result.outputs[0]!.objectId.endsWith(".bin")).toBe(false);
	});
});

describe("export hardening: export id authz (#6)", () => {
	test("POST / rejects an imageId that does not resolve to a project page", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId } = createProjectOnDisk(); // one real page image
			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader", imageIds: ["not-a-page-image.png"] }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { code: string };
			expect(body.code).toBe("unknown_export_id");
			// No job was enqueued.
			expect(await store.claimNextQueued()).toBeUndefined();
		} finally {
			restoreConfig();
			restore();
		}
	});

	test("POST / accepts the real page image id (happy path still works)", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const { projectId, imageId } = createProjectOnDisk();
			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader", imageIds: [imageId] }),
			});
			expect(res.status).toBe(202);
		} finally {
			restoreConfig();
			restore();
		}
	});

	// Codex P1 #3: a legit edited-page export id (page.edits.imageId, the id the
	// client uses) must be ACCEPTED and NORMALIZED back to its canonical page so page
	// scope + sourcePageCount stay page-based (counted once, not twice).
	test("POST / accepts page.edits.imageId and normalizes it to ONE canonical page", async () => {
		const store = new MemoryExportJobStore();
		const restore = setExportJobStoreForTests(store);
		const restoreConfig = enableLegacyAnonymous();
		try {
			const projectId = uuid();
			const sourceImageId = `${uuid()}.png`;
			const editedImageId = `${uuid()}-edited.png`;
			writeProjectStateForTest({
				projectId,
				userId: "",
				name: "Edited Export Test",
				createdAt: new Date().toISOString(),
				currentPage: 0,
				targetLang: "th",
				pages: [{
					imageId: sourceImageId,
					imageName: sourceImageId,
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
					edits: { imageId: editedImageId },
				}],
			});

			// Request the EDITED id (and, redundantly, the source id) — the route must
			// accept the edited id and collapse both to the single canonical page.
			const res = await buildApp().request("/api/export", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, preset: "web_reader", imageIds: [editedImageId, sourceImageId] }),
			});
			expect(res.status).toBe(202);

			const queued = await store.claimNextQueued();
			expect(queued).toBeDefined();
			// Normalized to the canonical source page id, deduped to ONE page.
			expect(queued!.params.imageIds).toEqual([sourceImageId]);
			const plans = queued!.params.renderPlans as Array<{ sourceImageId: string; renderImageId: string }>;
			expect(plans).toHaveLength(1);
			expect(plans[0]!.sourceImageId).toBe(sourceImageId);
			// Background resolves through the page-edit chain to the EDITED id.
			expect(plans[0]!.renderImageId).toBe(editedImageId);
		} finally {
			restoreConfig();
			restore();
		}
	});
});

describe("export hardening: codex P1 per-language + edited-background fixes", () => {
	// Codex P1 #1: a MATERIALIZED track with textLayers: [] must render NO text — it
	// must NOT flat-fall-back to page.textLayers (which would leak default/source text
	// into a per-language output). Mirrors client trackTextLayers (bucket.textLayers ?? []).
	test("a materialized track with empty textLayers renders NO flat/default text", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "page.png";
		// White background so any leaked black text would show as dark pixels.
		storage.seedImage(projectId, sourceImageId, await solidPng(200, 120, { r: 255, g: 255, b: 255 }));

		const state = {
			projectId,
			targetLang: "th",
			targetLangs: ["th", "en"],
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				pendingAiJobs: [],
				coverRect: null,
				// Flat/default (th) text that MUST NOT leak into the en track.
				textLayers: [{
					id: "t1", text: "SOURCE", x: 10, y: 10, w: 180, h: 60,
					fontSize: 48, fill: "#000000", alignment: "left", visible: true,
				}],
				// Materialized en bucket with NO text (translation not authored yet).
				languageOutputs: { en: { textLayers: [] } },
			}],
		} as never;

		// Export the EXPLICIT non-default "en" track.
		const queued = await enqueueExportJob({
			projectId, preset: "master", targetLang: "en", requestedTargetLang: "en",
			imageIds: [sourceImageId], state,
		}, { store });
		// The render plan must carry NO text for the en track (was wrongly the flat text).
		const planText = (queued.params.renderPlans as Array<{ textLayers?: unknown[] }> | undefined)?.[0]?.textLayers;
		expect(planText ?? []).toHaveLength(0);

		const result = await processExportJob(queued.id, { store, storage });
		expect(result.job.status).toBe("done");
		const out = storage.exports.get(`${projectId}/${result.outputs[0]!.objectId}`)!;
		// No leaked black glyphs: a blank white page has ~0 dark pixels.
		expect(await countDarkPixels(out)).toBeLessThan(20);
	});

	// Codex P1 #2: a default/legacy page with a registered BLOCKED page.edits.imageId
	// (flat — NO languageOutputs) must render+assert the EDITED background and FAIL the
	// export closed, never silently exporting the un-moderated original source.
	test("a flat/default page with a BLOCKED page.edits.imageId FAILS the export closed", async () => {
		const store = new MemoryExportJobStore();
		const storage = new FakeObjectStorage();
		const projectId = uuid();
		const sourceImageId = "source.png";
		const editedImageId = "edited.png";
		storage.seedImage(projectId, sourceImageId, await solidPng(60, 60, { r: 255, g: 255, b: 255 }));
		storage.seedImage(projectId, editedImageId, await solidPng(60, 60, { r: 0, g: 0, b: 0 }));

		// Flat/default page (NO languageOutputs) with an EDITED background id.
		const state = {
			projectId,
			targetLang: "th",
			pages: [{
				imageId: sourceImageId,
				imageName: sourceImageId,
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				edits: { imageId: editedImageId },
			}],
		} as never;

		// Registry reports the EDITED background as blocked.
		const restore = setExportLayerReadinessAssertForTests(async (_p, imageId) => {
			if (imageId === editedImageId) {
				throw new Error(`Export layer asset ${imageId} moderation status is blocked`);
			}
		});
		try {
			const queued = await enqueueExportJob({
				projectId, preset: "master", targetLang: "th", imageIds: [sourceImageId], state,
			}, { store });
			// The plan must target the EDITED background (not the source).
			const plan = (queued.params.renderPlans as Array<{ renderImageId: string }>)?.[0];
			expect(plan?.renderImageId).toBe(editedImageId);

			await expect(processExportJob(queued.id, { store, storage })).rejects.toThrow(/moderation status is blocked/);
			expect((await store.get(queued.id))?.status).toBe("error");
			// Fail closed: nothing leaked into the exports namespace.
			expect(storage.exports.size).toBe(0);
		} finally {
			restore();
		}
	});
});
