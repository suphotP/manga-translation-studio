// Route-level proof of the orphaned-AI-result fix (P2): a marker left `processing`
// because the client poll loop closed mid-gen self-heals to its job's DURABLE
// terminal result the moment ANYONE reads the markers — with NO live client.
//
// Exercises the real Hono app end-to-end: create a project + a `processing` marker
// via the public routes, push a job into the shared queue and mark it `done`
// OUT-OF-BAND (simulating completion while the tab was closed), then GET the
// markers endpoint and assert the marker reaches `needs_review` + resultImageId.
// Also covers the explicit POST reconcile endpoint and the failure path.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuid } from "uuid";

const LOCAL_API_ORIGIN = "http://localhost:3401";
const BASE = `${LOCAL_API_ORIGIN}/api`;
const realFetch = globalThis.fetch;
const originalDataDir = process.env.DATA_DIR;
const originalAllowLegacy = process.env.ALLOW_LEGACY_ANONYMOUS_PROJECTS;
const dataDir = mkdtempSync(join(tmpdir(), "manga-reconcile-route-"));

let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
let jobQueue: typeof import("../services/queue.js").jobQueue;

beforeAll(async () => {
	process.env.DATA_DIR = dataDir;
	// Use the legacy anonymous prototype path so we can hit the project routes
	// without standing up auth — mirrors routes.test.ts.
	process.env.ALLOW_LEGACY_ANONYMOUS_PROJECTS = "true";
	const { serverConfig } = await import("../config.js");
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: true });
	app = (await import("../index.js")).app;
	jobQueue = (await import("../services/queue.js")).jobQueue;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url.startsWith(LOCAL_API_ORIGIN)) {
			return app.request(url.slice(LOCAL_API_ORIGIN.length), init);
		}
		return realFetch(input, init);
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
	if (originalDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = originalDataDir;
	if (originalAllowLegacy === undefined) delete process.env.ALLOW_LEGACY_ANONYMOUS_PROJECTS;
	else process.env.ALLOW_LEGACY_ANONYMOUS_PROJECTS = originalAllowLegacy;
	rmSync(dataDir, { recursive: true, force: true });
});

async function setupProjectWithProcessingMarker(jobId: string): Promise<{ projectId: string; markerId: string }> {
	const newRes = await fetch(`${BASE}/project/new`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "reconcile route fixture", lang: "th" }),
	});
	expect(newRes.status).toBe(200);
	const projectId: string = (await newRes.json()).projectId;
	const imageId = `${uuid()}.png`;
	const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			projectId,
			name: "reconcile route fixture",
			createdAt: new Date().toISOString(),
			pages: [{ imageId, imageName: imageId, textLayers: [], pendingAiJobs: [], coverRect: null }],
			currentPage: 0,
			targetLang: "th",
		}),
	});
	expect(saveRes.status).toBe(200);

	// The AI-marker create route now FAILS CLOSED on its jobId guard: the referenced
	// job must already EXIST and belong to this project. In production the AI job is
	// submitted server-side (queued with this project's id) BEFORE the marker is
	// created, so seed a `processing` job for THIS project first. Tests that later
	// drive the job to done/failed update this same job in place.
	await jobQueue.ready();
	await jobQueue.add(
		{
			jobId,
			projectId,
			imageId,
			crop: { x: 0, y: 0, w: 64, h: 64 },
			lang: "th",
			prompt: "translate sfx",
			tier: "sfx-pro",
			status: "processing",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
		{ idempotencyKey: `reconcile-route-${jobId}` },
	);

	const markerRes = await fetch(`${BASE}/project/${projectId}/ai-markers`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jobId,
			pageIndex: 0,
			imageId,
			region: { x: 0, y: 0, w: 64, h: 64 },
			status: "processing",
			tier: "sfx-pro",
			prompt: "translate sfx",
		}),
	});
	expect(markerRes.status).toBe(200);
	const marker = (await markerRes.json()).marker;
	expect(marker.status).toBe("processing");
	return { projectId, markerId: marker.id };
}

async function pushDurableJob(jobId: string, projectId: string): Promise<void> {
	await jobQueue.ready();
	await jobQueue.add(
		{
			jobId,
			projectId,
			imageId: "page.png",
			crop: { x: 0, y: 0, w: 64, h: 64 },
			lang: "th",
			prompt: "translate sfx",
			tier: "sfx-pro",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
		{ idempotencyKey: `reconcile-route-${jobId}` },
	);
}

describe("GET /api/project/:id/ai-markers durably heals a stale processing marker (no live client)", () => {
	test("a job that completed while the tab was closed surfaces its result on reopen (ready, not stuck processing)", async () => {
		const jobId = uuid();
		const { projectId, markerId } = await setupProjectWithProcessingMarker(jobId);

		// The gen finishes on the backend AFTER the client poll loop closed: the job
		// reaches `done` with a result image, but nothing has touched the marker.
		await pushDurableJob(jobId, projectId);
		await jobQueue.update(jobId, { status: "done", resultImageId: "ai-result-orphan.png" });

		// Reopen → read markers. The marker self-heals from the durable job result.
		const res = await fetch(`${BASE}/project/${projectId}/ai-markers`);
		expect(res.status).toBe(200);
		const { markers } = await res.json();
		const healed = markers.find((m: any) => m.id === markerId);
		expect(healed.status).toBe("needs_review");
		expect(healed.resultImageId).toBe("ai-result-orphan.png");
	});

	test("explicit POST /ai-markers/reconcile reports what self-healed", async () => {
		const jobId = uuid();
		const { projectId, markerId } = await setupProjectWithProcessingMarker(jobId);
		await pushDurableJob(jobId, projectId);
		await jobQueue.update(jobId, { status: "done", resultImageId: "explicit-reconcile.png" });

		const res = await fetch(`${BASE}/project/${projectId}/ai-markers/reconcile`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.changed).toBe(true);
		expect(body.reconciled).toContain(markerId);
		expect(body.markers.find((m: any) => m.id === markerId).resultImageId).toBe("explicit-reconcile.png");

		// Second call is a no-op (terminal state is stable).
		const again = await (await fetch(`${BASE}/project/${projectId}/ai-markers/reconcile`, { method: "POST" })).json();
		expect(again.changed).toBe(false);
	});

	test("a job that failed while away heals the marker to failed (no orphaned spinner)", async () => {
		const jobId = uuid();
		const { projectId, markerId } = await setupProjectWithProcessingMarker(jobId);
		await pushDurableJob(jobId, projectId);
		// A leaky provider failure — must be #278-sanitized by the time it lands on the marker.
		await jobQueue.update(jobId, { status: "error", error: "401 invalid api key sk-proj-LEAK" });

		const { markers } = await (await fetch(`${BASE}/project/${projectId}/ai-markers`)).json();
		const healed = markers.find((m: any) => m.id === markerId);
		expect(healed.status).toBe("failed");
		expect(healed.error ?? "").not.toContain("sk-proj");
		expect(healed.error ?? "").not.toContain("LEAK");
	});

	test("a marker whose job is still in-flight stays processing", async () => {
		const jobId = uuid();
		const { projectId, markerId } = await setupProjectWithProcessingMarker(jobId);
		await pushDurableJob(jobId, projectId); // stays `pending`

		const { markers } = await (await fetch(`${BASE}/project/${projectId}/ai-markers`)).json();
		expect(markers.find((m: any) => m.id === markerId).status).toBe("processing");
	});
});
