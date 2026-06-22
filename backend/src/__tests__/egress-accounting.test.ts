import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import { images } from "../routes/images.js";
import {
	EgressAccountingUnavailableError,
	EgressLimitExceededError,
	MemoryAssetEgressStore,
	RedisAssetEgressStore,
	type RedisAssetEgressClient,
	assertProjectEgressAllowance,
	recordAssetEgress,
	recordAssetEgressWithAllowance,
	resetEgressAccountingForTesting,
	setAssetEgressStoreForTesting,
	summarizeProjectEgress,
	summarizeProjectsEgress,
} from "../services/egress-accounting.js";

const previousEnv: Record<string, string | undefined> = {};
const createdProjectDirs: string[] = [];
// Wave 0 W0.1: tests below build legacy anonymous prototype projects (no
// userId, no workspaceId) and access them via the images route — that path is
// gated by allowLegacyAnonymousProjects after the hatch was closed.
let previousAllowLegacyAnonymousProjects: boolean;

beforeEach(() => {
	for (const key of [
		"ASSET_EGRESS_WINDOW_MS",
		"ASSET_EGRESS_PROJECT_WINDOW_BYTES",
		"ASSET_EGRESS_LIMIT_ENFORCED",
		"ASSET_EGRESS_STORE",
		"ASSET_EGRESS_REDIS_KEY_PREFIX",
		"REDIS_URL",
	]) {
		previousEnv[key] = process.env[key];
	}
	process.env.ASSET_EGRESS_WINDOW_MS = "60000";
	delete process.env.ASSET_EGRESS_PROJECT_WINDOW_BYTES;
	delete process.env.ASSET_EGRESS_LIMIT_ENFORCED;
	delete process.env.ASSET_EGRESS_STORE;
	delete process.env.ASSET_EGRESS_REDIS_KEY_PREFIX;
	delete process.env.REDIS_URL;
	resetEgressAccountingForTesting();
	previousAllowLegacyAnonymousProjects = serverConfig.allowLegacyAnonymousProjects;
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: true });
});

afterEach(() => {
	resetEgressAccountingForTesting();
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: previousAllowLegacyAnonymousProjects });
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const projectDir of createdProjectDirs.splice(0)) {
		const resolved = resolve(projectDir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

function createProjectWithImage(bytes = "image-bytes") {
	const projectId = uuid();
	const imageId = `${uuid()}.png`;
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify({
		projectId,
		name: "Egress Test",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
	}));
	writeFileSync(join(projectDir, "images", imageId), Buffer.from(bytes));
	// Register a passing/released asset record so the serve gate (which now fails
	// closed on a missing record — codex P0-2) treats this image as servable.
	const now = new Date().toISOString();
	writeFileSync(join(projectDir, "assets.json"), JSON.stringify({
		[imageId]: {
			assetId: imageId, projectId, imageId, originalName: imageId, mimeType: "image/png",
			sizeBytes: Buffer.from(bytes).byteLength, sha256: "0".repeat(64), storageDriver: "local",
			storageKey: `projects/${projectId}/images/${imageId}`, width: 1, height: 1,
			storageStatus: "released", moderation: { status: "passed", provider: "test", checkedAt: now },
			derivatives: [], createdAt: now, updatedAt: now,
		},
	}));
	createdProjectDirs.push(projectDir);
	return { projectId, imageId, bytes };
}

class FakeRedisEgressClient implements RedisAssetEgressClient {
	private readonly hashes = new Map<string, Map<string, string>>();
	private readonly sets = new Map<string, Set<string>>();
	readonly commandCounts: Record<string, number> = {};

	send(command: string, args: string[]): unknown {
		const upper = command.toUpperCase();
		this.commandCounts[upper] = (this.commandCounts[upper] ?? 0) + 1;
		switch (upper) {
			case "EVAL":
				return this.record(args);
			case "SMEMBERS":
				return Array.from(this.sets.get(args[0]) ?? []);
			case "HGETALL":
				return this.flattenHash(args[0]);
			default:
				throw new Error(`Unexpected Redis command: ${command}`);
		}
	}

	private record(args: string[]): string[] {
		const bucketKey = args[2];
		const indexKey = args[3];
		const totalKey = args[4];
		const [
			projectId,
			imageId,
			purpose,
			windowStart,
			windowEnd,
			bytes,
			statusCode,
			cacheHit,
			tokenRequired,
			tokenAccepted,
			updatedAt,
			_ttlMs,
			enforced,
			limitBytes,
		] = args.slice(5);
		const totalHash = this.hashes.get(totalKey) ?? new Map<string, string>();
		this.hashes.set(totalKey, totalHash);
		const currentTotalBytes = Number(totalHash.get("totalBytes") ?? 0);
		const projectedBytes = currentTotalBytes + Number(bytes);
		if (enforced === "1" && Number(limitBytes) > 0 && projectedBytes > Number(limitBytes)) {
			return ["LIMIT", String(currentTotalBytes), String(projectedBytes)];
		}
		const hash = this.hashes.get(bucketKey) ?? new Map<string, string>();
		this.hashes.set(bucketKey, hash);
		hash.set("projectId", projectId);
		hash.set("imageId", imageId);
		hash.set("purpose", purpose);
		hash.set("windowStart", windowStart);
		hash.set("windowEnd", windowEnd);
		hash.set("lastStatusCode", statusCode);
		hash.set("updatedAt", updatedAt);
		this.increment(hash, "requests", 1);
		this.increment(hash, "bytes", Number(bytes));
		this.increment(hash, "cacheHits", Number(cacheHit));
		this.increment(hash, "tokenRequiredRequests", Number(tokenRequired));
		this.increment(hash, "tokenAcceptedRequests", Number(tokenAccepted));
		totalHash.set("projectId", projectId);
		totalHash.set("windowStart", windowStart);
		totalHash.set("windowEnd", windowEnd);
		totalHash.set("updatedAt", updatedAt);
		this.increment(totalHash, "totalRequests", 1);
		this.increment(totalHash, "totalBytes", Number(bytes));
		this.increment(totalHash, "cacheHits", Number(cacheHit));
		this.increment(totalHash, "tokenRequiredRequests", Number(tokenRequired));
		this.increment(totalHash, "tokenAcceptedRequests", Number(tokenAccepted));
		const index = this.sets.get(indexKey) ?? new Set<string>();
		this.sets.set(indexKey, index);
		index.add(bucketKey);
		return ["OK", ...this.flattenHash(bucketKey)];
	}

	private increment(hash: Map<string, string>, key: string, amount: number): void {
		hash.set(key, String(Number(hash.get(key) ?? 0) + amount));
	}

	private flattenHash(key: string): string[] {
		return Array.from(this.hashes.get(key) ?? []).flatMap(([field, value]) => [field, value]);
	}
}

describe("egress accounting", () => {
	test("aggregates asset bytes by project, purpose, and asset", async () => {
		const now = 1_700_000_000_000;
		await recordAssetEgress({
			projectId: "project-1",
			imageId: "image-a.png",
			purpose: "editor_preview",
			bytes: 100,
			statusCode: 200,
			now,
		});
		await recordAssetEgress({
			projectId: "project-1",
			imageId: "image-a.png",
			purpose: "editor_preview",
			bytes: 50,
			statusCode: 200,
			now,
		});
		await recordAssetEgress({
			projectId: "project-1",
			imageId: "image-b.png",
			purpose: "thumbnail",
			bytes: 25,
			statusCode: 200,
			cacheHit: true,
			now,
		});

		const summary = await summarizeProjectEgress("project-1", now);
		expect(summary.totalRequests).toBe(3);
		expect(summary.totalBytes).toBe(175);
		expect(summary.byPurpose).toEqual([
			{ purpose: "editor_preview", requests: 2, bytes: 150 },
			{ purpose: "thumbnail", requests: 1, bytes: 25 },
		]);
		expect(summary.byAsset[0]).toEqual({ imageId: "image-a.png", requests: 2, bytes: 150 });
	});

	test("can enforce a project egress limit when the production flag is enabled", async () => {
		process.env.ASSET_EGRESS_PROJECT_WINDOW_BYTES = "100";
		process.env.ASSET_EGRESS_LIMIT_ENFORCED = "true";
		const now = 1_700_000_000_000;
		await recordAssetEgress({
			projectId: "project-1",
			imageId: "image-a.png",
			purpose: "editor_preview",
			bytes: 80,
			statusCode: 200,
			now,
		});

		await expect(assertProjectEgressAllowance("project-1", 21, now)).rejects.toThrow(EgressLimitExceededError);
		await expect(assertProjectEgressAllowance("project-1", 20, now)).resolves.toBeDefined();
	});

	test("aggregates Redis-backed egress across shared store clients", async () => {
		const client = new FakeRedisEgressClient();
		const storeA = new RedisAssetEgressStore({ client, keyPrefix: "test:egress" });
		const storeB = new RedisAssetEgressStore({ client, keyPrefix: "test:egress" });
		const now = 1_700_000_000_000;

		await storeA.record({
			projectId: "project-1",
			imageId: "image-a.png",
			purpose: "editor_preview",
			bytes: 120,
			statusCode: 200,
			tokenRequired: true,
			tokenAccepted: true,
			now,
		});
		await storeB.record({
			projectId: "project-1",
			imageId: "image-b.png",
			purpose: "thumbnail",
			bytes: 30,
			statusCode: 200,
			cacheHit: true,
			now,
		});

		const summary = await storeA.summarize("project-1", now);
		expect(summary.totalRequests).toBe(2);
		expect(summary.totalBytes).toBe(150);
		expect(summary.byPurpose).toEqual([
			{ purpose: "editor_preview", requests: 1, bytes: 120 },
			{ purpose: "thumbnail", requests: 1, bytes: 30 },
		]);
		expect(summary.byAsset).toEqual([
			{ imageId: "image-a.png", requests: 1, bytes: 120 },
			{ imageId: "image-b.png", requests: 1, bytes: 30 },
		]);
	});

	test("Redis-backed atomic allowance recording rejects over-limit concurrent reservations", async () => {
		process.env.ASSET_EGRESS_PROJECT_WINDOW_BYTES = "100";
		process.env.ASSET_EGRESS_LIMIT_ENFORCED = "true";
		const client = new FakeRedisEgressClient();
		const storeA = new RedisAssetEgressStore({ client, keyPrefix: "test:egress" });
		const storeB = new RedisAssetEgressStore({ client, keyPrefix: "test:egress" });
		const now = 1_700_000_000_000;

		await storeA.recordWithAllowance({
			projectId: "project-1",
			imageId: "image-a.png",
			purpose: "editor_preview",
			bytes: 60,
			statusCode: 200,
			now,
		});

		await expect(storeB.recordWithAllowance({
			projectId: "project-1",
			imageId: "image-b.png",
			purpose: "editor_preview",
			bytes: 50,
			statusCode: 200,
			now,
		})).rejects.toThrow(EgressLimitExceededError);

		const summary = await storeA.summarize("project-1", now);
		expect(summary.totalBytes).toBe(60);
		expect(summary.byAsset).toEqual([
			{ imageId: "image-a.png", requests: 1, bytes: 60 },
		]);
	});

	test("fails closed when enforced egress accounting is unavailable", async () => {
		process.env.ASSET_EGRESS_PROJECT_WINDOW_BYTES = "100";
		process.env.ASSET_EGRESS_LIMIT_ENFORCED = "true";
		setAssetEgressStoreForTesting({
			record: () => {
				throw new Error("redis unavailable");
			},
			summarize: () => {
				throw new Error("redis unavailable");
			},
		});

		await expect(assertProjectEgressAllowance("project-1", 1, 1_700_000_000_000)).rejects.toThrow(EgressAccountingUnavailableError);
		await expect(recordAssetEgressWithAllowance({
			projectId: "project-1",
			imageId: "image-a.png",
			purpose: "editor_preview",
			bytes: 1,
			statusCode: 200,
			now: 1_700_000_000_000,
		})).rejects.toThrow(EgressAccountingUnavailableError);
	});

	test("rejects malformed egress enforcement values instead of disabling limits", async () => {
		process.env.ASSET_EGRESS_LIMIT_ENFORCED = "treu";

		await expect(recordAssetEgress({
			projectId: "project-1",
			imageId: "image-a.png",
			purpose: "editor_preview",
			bytes: 1,
			statusCode: 200,
			now: 1_700_000_000_000,
		})).rejects.toThrow("ASSET_EGRESS_LIMIT_ENFORCED must be true or false");
	});

	test("image route records served bytes and exposes a project egress summary", async () => {
		const { projectId, imageId, bytes } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const imageResponse = await app.request(`/api/images/${projectId}/${imageId}`);
		const usageResponse = await app.request(`/api/images/${projectId}/egress-usage`);
		const usage = await usageResponse.json();

		expect(imageResponse.status).toBe(200);
		expect(imageResponse.headers.get("X-Asset-Egress-Bytes")).toBe(String(bytes.length));
		expect(usageResponse.status).toBe(200);
		expect(usage.egress.totalBytes).toBe(bytes.length);
		expect(usage.egress.byAsset[0]).toEqual({
			imageId,
			requests: 1,
			bytes: bytes.length,
		});
	});

	// ── rank14: batched per-project egress summary ───────────────────────────────
	test("MemoryAssetEgressStore.summarizeMany equals per-project summarize (parity)", () => {
		const store = new MemoryAssetEgressStore();
		const now = 1_700_000_000_000;
		store.record({ projectId: "p1", imageId: "a.png", purpose: "editor_preview", bytes: 100, statusCode: 200, now });
		store.record({ projectId: "p1", imageId: "b.png", purpose: "thumbnail", bytes: 40, statusCode: 200, now });
		store.record({ projectId: "p2", imageId: "c.png", purpose: "editor_preview", bytes: 25, statusCode: 200, now });
		// p3 has no traffic → must still get an (empty) summary in order.

		const projectIds = ["p1", "p2", "p3"];
		const batched = store.summarizeMany(projectIds, now);
		const perProject = projectIds.map((id) => store.summarize(id, now));

		// Same order, same numbers, byte-for-byte.
		expect(batched).toEqual(perProject);
		expect(batched.map((s) => s.projectId)).toEqual(projectIds);
		expect(batched[0]!.totalBytes).toBe(140);
		expect(batched[1]!.totalBytes).toBe(25);
		expect(batched[2]!.totalBytes).toBe(0);
	});

	test("summarizeProjectsEgress returns one summary per project in input order", async () => {
		const store = new MemoryAssetEgressStore();
		const now = 1_700_000_000_000;
		store.record({ projectId: "p2", imageId: "a.png", purpose: "editor_preview", bytes: 10, statusCode: 200, now });
		setAssetEgressStoreForTesting(store);

		const summaries = await summarizeProjectsEgress(["p1", "p2"], now);
		expect(summaries.map((s) => s.projectId)).toEqual(["p1", "p2"]);
		expect(summaries[0]!.totalBytes).toBe(0);
		expect(summaries[1]!.totalBytes).toBe(10);
		expect(await summarizeProjectsEgress([], now)).toEqual([]);
	});

	test("Redis summarizeMany collapses the per-project N+1 (one HGETALL per bucket, parity)", async () => {
		const client = new FakeRedisEgressClient();
		const store = new RedisAssetEgressStore({ client, keyPrefix: "test:egress" });
		const now = 1_700_000_000_000;
		// 2 projects, 3 buckets total.
		await store.record({ projectId: "p1", imageId: "a.png", purpose: "editor_preview", bytes: 100, statusCode: 200, now });
		await store.record({ projectId: "p1", imageId: "b.png", purpose: "thumbnail", bytes: 40, statusCode: 200, now });
		await store.record({ projectId: "p2", imageId: "c.png", purpose: "editor_preview", bytes: 25, statusCode: 200, now });

		// Parity with the per-project path first.
		const perProject = [
			await store.summarize("p1", now),
			await store.summarize("p2", now),
			await store.summarize("p3", now),
		];

		// Reset only the command counters, then exercise the batched read.
		for (const key of Object.keys(client.commandCounts)) client.commandCounts[key] = 0;
		const batched = await store.summarizeMany(["p1", "p2", "p3"], now);

		expect(batched).toEqual(perProject);

		// Batched does ONE SMEMBERS per project (3) and HGETALLs each bucket exactly
		// ONCE (3 buckets) — not a serial SMEMBERS+HGETALL chain per project.
		expect(client.commandCounts.SMEMBERS).toBe(3);
		expect(client.commandCounts.HGETALL).toBe(3);
	});
});
