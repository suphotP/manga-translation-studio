import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import sharp from "sharp";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR } from "../config.js";
import { cleanedImportRoutes } from "../routes/export.js";
import { resetEgressAccountingForTesting } from "../services/egress-accounting.js";
import { createZipBuffer, type ZipFileInput } from "../services/zip-writer.js";
import { setStorageQuotaReservationStoreForTests, StorageQuotaExceededError } from "../services/storage-quota.js";
import { workspaceAccessStore } from "../services/workspace-access.js";
import {
	createInMemoryRealtimeBus,
	getRealtimeBus,
	setRealtimeBusForTesting,
	type RealtimeEvent,
} from "../services/realtime-bus.js";
import type { JWTPayload } from "../types/auth.js";
import type { AssetRecord, ProjectState } from "../types/index.js";

const createdProjectDirs: string[] = [];
const TEST_USER_ID = "import-cleaned-route-user";

function buildApp(): Hono {
	const app = new Hono();
	app.use("/api/import/*", async (c, next) => {
		const user: JWTPayload = {
			userId: TEST_USER_ID,
			email: "cleaned-import@example.com",
			role: "editor",
			emailVerified: true,
		};
		(c as unknown as { set(key: "user", value: JWTPayload): void }).set("user", user);
		await next();
	});
	app.route("/api/import", cleanedImportRoutes);
	return app;
}

async function png(width: number, height: number, background = "#ffffff"): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
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
	input: { originalName: string; bytes: Buffer; width: number; height: number },
): AssetRecord {
	const now = new Date("2026-06-11T00:00:00.000Z").toISOString();
	return {
		assetId: imageId,
		projectId,
		imageId,
		originalName: input.originalName,
		mimeType: "image/png",
		sizeBytes: input.bytes.byteLength,
		sha256: "0".repeat(64),
		storageDriver: "local",
		storageKey: `projects/${projectId}/images/${imageId}`,
		width: input.width,
		height: input.height,
		storageStatus: "released",
		moderation: { status: "passed", provider: "test", checkedAt: now },
		derivatives: [],
		createdAt: now,
		updatedAt: now,
	};
}

async function writeProject(input: {
	name?: string;
	workspaceId?: string;
	pages: Array<{ originalName: string; width: number; height: number; bytes?: Buffer }>;
}): Promise<{ projectId: string; state: ProjectState; manifest: unknown; filenames: string[] }> {
	const projectId = uuid();
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	const assets: Record<string, AssetRecord> = {};
	const pages: ProjectState["pages"] = [];
	const filenames: string[] = [];
	for (const [index, entry] of input.pages.entries()) {
		const imageId = `${uuid()}.png`;
		const bytes = entry.bytes ?? await png(entry.width, entry.height);
		writeFileSync(join(projectDir, "images", imageId), bytes);
		pages.push(page({
			imageId,
			imageName: imageId,
			originalName: entry.originalName,
		}));
		assets[imageId] = assetRecord(projectId, imageId, {
			originalName: entry.originalName,
			bytes,
			width: entry.width,
			height: entry.height,
		});
		filenames.push(`pages/${String(index + 1).padStart(3, "0")}-${entry.originalName}`);
	}
	const state: ProjectState = {
		projectId,
		userId: TEST_USER_ID,
		...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
		name: input.name ?? "Cleaned Import Test",
		createdAt: new Date("2026-06-11T00:00:00.000Z").toISOString(),
		pages,
		currentPage: 0,
		targetLang: "th",
	};
	writeFileSync(join(projectDir, "state.json"), JSON.stringify(state));
	writeFileSync(join(projectDir, "assets.json"), JSON.stringify(assets, null, 2));
	createdProjectDirs.push(projectDir);
	return {
		projectId,
		state,
		filenames,
		manifest: {
			kind: "chapter-originals",
			chapterId: projectId,
			projectId,
			projectName: state.name,
			createdAt: "2026-06-11T00:00:00.000Z",
			pageCount: pages.length,
			pages: pages.map((projectPage, pageIndex) => ({
				pageIndex,
				pageNumber: pageIndex + 1,
				imageId: projectPage.imageId,
				sourceName: projectPage.originalName,
				filename: filenames[pageIndex],
				mimeType: "image/png",
				sizeBytes: assets[projectPage.imageId]!.sizeBytes,
			})),
		},
	};
}

function cleanedZip(manifest: unknown, entries: Array<{ path: string; data: Buffer }>): File {
	const files: ZipFileInput[] = [
		{ path: "manifest.json", data: `${JSON.stringify(manifest, null, 2)}\n`, modifiedAt: new Date("2026-06-11T00:00:00.000Z") },
		...entries.map((entry) => ({ path: entry.path, data: entry.data, modifiedAt: new Date("2026-06-11T00:00:00.000Z") })),
	];
	return new File([createZipBuffer(files)], "cleaned.zip", { type: "application/zip" });
}

function readState(projectId: string): ProjectState {
	return JSON.parse(readFileSync(join(PROJECTS_DIR, projectId, "state.json"), "utf8")) as ProjectState;
}

function readAssets(projectId: string): Record<string, AssetRecord> {
	return JSON.parse(readFileSync(join(PROJECTS_DIR, projectId, "assets.json"), "utf8")) as Record<string, AssetRecord>;
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

function captureWorkspaceEvents(workspaceId: string): { events: RealtimeEvent[]; close: () => void } {
	const events: RealtimeEvent[] = [];
	const controller = new AbortController();
	const sub = getRealtimeBus().subscribe(workspaceId, { signal: controller.signal });
	(async () => { for await (const event of sub) events.push(event); })().catch(() => {});
	return { events, close: () => controller.abort() };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("POST /api/import/cleaned/:chapterId", () => {
	test("imports a cleaned ZIP as page cleaned backgrounds with asset records", async () => {
		const project = await writeProject({
			name: "Moonlit Courier Chapter 104",
			pages: [
				{ originalName: "cover.png", width: 120, height: 80 },
				{ originalName: "spread.png", width: 140, height: 90 },
			],
		});
		const form = new FormData();
		form.set("file", cleanedZip(project.manifest, [
			{ path: project.filenames[0]!, data: await png(120, 80, "#fef3c7") },
			{ path: project.filenames[1]!, data: await png(140, 90, "#dbeafe") },
		]));

		const res = await buildApp().request(`/api/import/cleaned/${project.projectId}`, { method: "POST", body: form });

		expect(res.status).toBe(200);
		const body = await res.json() as { imported: number; pages: Array<{ cleanedImageId: string; moderationStatus: string }> };
		expect(body.imported).toBe(2);
		expect(body.pages.map((entry) => entry.moderationStatus)).toEqual(["passed", "passed"]);
		const state = readState(project.projectId);
		expect(state.pages.map((projectPage) => projectPage.edits?.imageId)).toEqual(body.pages.map((entry) => entry.cleanedImageId));
		expect(state.pages[0]!.edits?.imageId).not.toBe(project.state.pages[0]!.imageId);
		const assets = readAssets(project.projectId);
		for (const imported of body.pages) {
			expect(assets[imported.cleanedImageId]).toEqual(expect.objectContaining({
				imageId: imported.cleanedImageId,
				storageStatus: "released",
				metadata: expect.objectContaining({ assetKind: "cleaned-background", source: "import_cleaned" }),
			}));
		}
	});

	test("rejects a zip entry whose deflate stream inflates past its declared size (zip bomb)", async () => {
		// codex P1: inflate is bounded by the CLAIMED uncompressedSize.
		const { deflateRawSync } = await import("zlib");
		const project = await writeProject({ pages: [{ originalName: "cover.png", width: 120, height: 80 }] });
		const realPng = await png(120, 80, "#fee");
		const honest = createZipBuffer([
			{ path: "manifest.json", data: JSON.stringify(project.manifest) },
			{ path: project.filenames[0]!, data: realPng },
		]);
		// Corrupt the central-directory + local uncompressedSize fields of the
		// image entry down to 10 bytes while leaving the deflate stream intact.
		const lying = Buffer.from(honest);
		const needle = deflateRawSync(realPng).subarray(0, 8);
		// find the image entry's local header by its path then patch sizes after it
		const namePos = lying.indexOf(Buffer.from(project.filenames[0]!, "utf8"));
		// local header layout: ...crc(4) compSize(4) uncompSize(4) nameLen(2) extraLen(2) name
		const localSizeOffset = namePos - 8; // uncompSize is 8 bytes before the name field start... locate via signature instead
		void needle; void localSizeOffset;
		// Simpler + robust: patch EVERY 4-byte uncompressedSize that equals realPng.length
		const sizeLe = Buffer.alloc(4); sizeLe.writeUInt32LE(realPng.length);
		const lieLe = Buffer.alloc(4); lieLe.writeUInt32LE(10);
		let at = lying.indexOf(sizeLe);
		while (at !== -1) {
			lieLe.copy(lying, at);
			at = lying.indexOf(sizeLe, at + 4);
		}
		const form = new FormData();
		form.set("file", new File([lying], "cleaned.zip", { type: "application/zip" }));

		const res = await buildApp().request(`/api/import/cleaned/${project.projectId}`, { method: "POST", body: form });

		// Node throws ERR_BUFFER_TOO_LARGE at maxOutputLength (→400 invalid_zip);
		// Bun's zlib TRUNCATES at the cap instead, so the 10-byte garbage then
		// fails image decode (→422). Both are fail-closed with zero writes —
		// the security property under test is the bounded inflate itself.
		expect([400, 422]).toContain(res.status);
		const body = await res.json() as { code: string };
		expect(["invalid_zip", "cleaned_image_not_decodable"]).toContain(body.code);
		expect(readState(project.projectId).pages[0]!.edits).toBeUndefined();
	});

	test("merges into the LATEST state — a concurrent save between authorize and commit survives", async () => {
		// codex P1: whole-state write from the authorize-time snapshot dropped
		// concurrent changes; commit now re-reads and merges only pages[i].edits.
		const project = await writeProject({ pages: [{ originalName: "cover.png", width: 120, height: 80 }] });
		const form = new FormData();
		form.set("file", cleanedZip(project.manifest, [
			{ path: project.filenames[0]!, data: await png(120, 80, "#cfe") },
		]));
		// simulate a save landing after authorize read: mutate the persisted state
		const statePath = join(PROJECTS_DIR, project.projectId, "state.json");
		const persisted = JSON.parse(readFileSync(statePath, "utf8")) as ProjectState;
		persisted.name = "Renamed mid-import";
		writeFileSync(statePath, JSON.stringify(persisted));

		const res = await buildApp().request(`/api/import/cleaned/${project.projectId}`, { method: "POST", body: form });

		expect(res.status).toBe(200);
		const state = readState(project.projectId);
		expect(state.name).toBe("Renamed mid-import");
		expect(state.pages[0]!.edits?.imageId).toBeTruthy();
	});

	test("413s when the workspace storage quota cannot cover the import", async () => {
		const restore = setStorageQuotaReservationStoreForTests({
			reserve: async () => { throw new StorageQuotaExceededError("quota full", { requestedBytes: 1, availableBytes: 0 }); },
			release: async () => true,
			listActive: async () => [],
		} as never);
		try {
			const project = await writeProject({ pages: [{ originalName: "cover.png", width: 120, height: 80 }] });
			const form = new FormData();
			form.set("file", cleanedZip(project.manifest, [
				{ path: project.filenames[0]!, data: await png(120, 80, "#efe") },
			]));
			const res = await buildApp().request(`/api/import/cleaned/${project.projectId}`, { method: "POST", body: form });
			expect(res.status).toBe(413);
			expect(((await res.json()) as { code: string }).code).toBe("storage_quota_exceeded");
			expect(readState(project.projectId).pages[0]!.edits).toBeUndefined();
		} finally {
			restore();
		}
	});

	test("accepts multipart images matched by manifest basenames", async () => {
		const project = await writeProject({
			pages: [{ originalName: "page-one.png", width: 200, height: 100 }],
		});
		const form = new FormData();
		form.set("manifest", JSON.stringify(project.manifest));
		form.append("images", new File([await png(200, 100, "#dcfce7")], "001-page-one.png", { type: "image/png" }));

		const res = await buildApp().request(`/api/import/cleaned/${project.projectId}`, { method: "POST", body: form });

		expect(res.status).toBe(200);
		const state = readState(project.projectId);
		expect(state.pages[0]!.edits?.imageId).toBeTruthy();
		expect(state.pages[0]!.edits?.imageId).not.toBe(project.state.pages[0]!.imageId);
	});

	test("rejects a missing manifest page without partial state or asset writes", async () => {
		const project = await writeProject({
			pages: [
				{ originalName: "cover.png", width: 120, height: 80 },
				{ originalName: "spread.png", width: 140, height: 90 },
			],
		});
		const originalAssetIds = Object.keys(readAssets(project.projectId)).sort();
		const form = new FormData();
		form.set("file", cleanedZip(project.manifest, [
			{ path: project.filenames[0]!, data: await png(120, 80, "#fee2e2") },
		]));

		const res = await buildApp().request(`/api/import/cleaned/${project.projectId}`, { method: "POST", body: form });

		expect(res.status).toBe(400);
		const body = await res.json() as { code: string };
		expect(body.code).toBe("cleaned_import_missing_page");
		expect(readState(project.projectId).pages.every((projectPage) => projectPage.edits === undefined)).toBe(true);
		expect(Object.keys(readAssets(project.projectId)).sort()).toEqual(originalAssetIds);
	});

	test("rejects a dimension mismatch without partial state or asset writes", async () => {
		const project = await writeProject({
			pages: [
				{ originalName: "cover.png", width: 120, height: 80 },
				{ originalName: "spread.png", width: 140, height: 90 },
			],
		});
		const originalAssetIds = Object.keys(readAssets(project.projectId)).sort();
		const form = new FormData();
		form.set("file", cleanedZip(project.manifest, [
			{ path: project.filenames[0]!, data: await png(120, 80, "#fee2e2") },
			{ path: project.filenames[1]!, data: await png(180, 90, "#fee2e2") },
		]));

		const res = await buildApp().request(`/api/import/cleaned/${project.projectId}`, { method: "POST", body: form });

		expect(res.status).toBe(422);
		const body = await res.json() as { code: string; expected: { width: number; height: number }; actual: { width: number; height: number } };
		expect(body.code).toBe("cleaned_import_dimension_mismatch");
		expect(body.expected).toEqual({ width: 140, height: 90 });
		expect(body.actual).toEqual({ width: 180, height: 90 });
		expect(readState(project.projectId).pages.every((projectPage) => projectPage.edits === undefined)).toBe(true);
		expect(Object.keys(readAssets(project.projectId)).sort()).toEqual(originalAssetIds);
	});

	test("emits page_set_changed after a cleaned import commits", async () => {
		const workspaceId = "ws-import-cleaned-rt";
		const originalRequirePermission = workspaceAccessStore.requirePermission.bind(workspaceAccessStore);
		(workspaceAccessStore as { requirePermission: unknown }).requirePermission = (async () => ({
			workspaceId,
			userId: TEST_USER_ID,
			role: "editor",
			scope: {},
			createdAt: "",
			updatedAt: "",
		})) as typeof originalRequirePermission;
		setRealtimeBusForTesting(createInMemoryRealtimeBus());
		const cap = captureWorkspaceEvents(workspaceId);
		try {
			const project = await writeProject({
				name: "Realtime Cleaned Import",
				workspaceId,
				pages: [
					{ originalName: "cover.png", width: 120, height: 80 },
					{ originalName: "spread.png", width: 140, height: 90 },
				],
			});
			const form = new FormData();
			form.set("file", cleanedZip(project.manifest, [
				{ path: project.filenames[0]!, data: await png(120, 80, "#eeeeee") },
				{ path: project.filenames[1]!, data: await png(140, 90, "#eeeeee") },
			]));

			const res = await buildApp().request(`/api/import/cleaned/${project.projectId}`, {
				method: "POST",
				body: form,
			});
			expect(res.status).toBe(200);
			await flush();

			const event = cap.events.find((candidate) => candidate.kind === "page_set_changed");
			expect(event?.data).toEqual({
				projectId: project.projectId,
				changedBy: TEST_USER_ID,
				pageCount: 2,
			});
		} finally {
			cap.close();
			setRealtimeBusForTesting(null);
			(workspaceAccessStore as { requirePermission: unknown }).requirePermission = originalRequirePermission;
		}
	});
});
