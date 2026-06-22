// Integration tests for API routes
// Tests the full HTTP request/response cycle using Bun's built-in fetch

import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BASE = "http://localhost:3001/api";
const LOCAL_API_ORIGIN = "http://localhost:3001";
let testProjectId: string;
let testImageId: string;
const realFetch = globalThis.fetch;
const originalDataDir = process.env.DATA_DIR;
const originalWorkerUrl = process.env.WORKER_URL;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalOpenAiImagesEnabled = process.env.OPENAI_IMAGES_ENABLED;
const originalOpenAiModerationEnabled = process.env.OPENAI_MODERATION_ENABLED;
const originalDailyAiCreditLimit = process.env.USAGE_DAILY_AI_CREDIT_THB;
const originalMonthlyAiCreditLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
const originalWorkspacePlanId = process.env.WORKSPACE_PLAN_ID;
const originalRateLimitAiSubmitPerMinute = process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE;
const originalRateLimitAiSubmitCostPerMinute = process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE;
const originalRateLimitAiSubmitPerHour = process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR;
const routesDataDir = mkdtempSync(join(tmpdir(), "manga-routes-test-"));
let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
// The directory the running server actually writes projects under. Usually
// `${routesDataDir}/projects`, but if a sibling test file imported config.ts
// first (module cache) PROJECTS_DIR is frozen to ITS data dir — so resolve the
// real one from config in beforeAll for any on-disk assertions.
let serverProjectsDir: string;

function enableOpenAiProvider(): void {
	process.env.OPENAI_API_KEY = "sk-test";
	process.env.OPENAI_IMAGES_ENABLED = "true";
	process.env.USAGE_DAILY_AI_CREDIT_THB = "1000";
	process.env.USAGE_MONTHLY_AI_CREDIT_THB = "1000";
}

// The AI-marker create route now FAILS CLOSED on its jobId guard: the referenced
// job must EXIST and belong to the same project before a client-supplied jobId is
// persisted (closes cross-project jobId forgery). Tests that create a marker with a
// fabricated jobId must therefore first register that job against the same project.
async function seedMarkerJob(jobId: string, projectId: string): Promise<void> {
	const { jobQueue } = await import("../services/queue.js");
	await jobQueue.add({
		jobId,
		projectId,
		imageId: "marker-seed-img",
		crop: { x: 0, y: 0, w: 1, h: 1 },
		lang: "en",
		prompt: "marker-seed",
		tier: "clean-pro",
		quality: "low",
		status: "done",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} as Parameters<typeof jobQueue.add>[0]);
}

function restoreOpenAiProviderEnv(): void {
	if (originalOpenAiKey === undefined) {
		delete process.env.OPENAI_API_KEY;
	} else {
		process.env.OPENAI_API_KEY = originalOpenAiKey;
	}
	if (originalOpenAiImagesEnabled === undefined) {
		delete process.env.OPENAI_IMAGES_ENABLED;
		} else {
			process.env.OPENAI_IMAGES_ENABLED = originalOpenAiImagesEnabled;
		}
		if (originalOpenAiModerationEnabled === undefined) {
			delete process.env.OPENAI_MODERATION_ENABLED;
		} else {
			process.env.OPENAI_MODERATION_ENABLED = originalOpenAiModerationEnabled;
		}
		if (originalDailyAiCreditLimit === undefined) {
		delete process.env.USAGE_DAILY_AI_CREDIT_THB;
	} else {
		process.env.USAGE_DAILY_AI_CREDIT_THB = originalDailyAiCreditLimit;
	}
	if (originalMonthlyAiCreditLimit === undefined) {
		delete process.env.USAGE_MONTHLY_AI_CREDIT_THB;
	} else {
		process.env.USAGE_MONTHLY_AI_CREDIT_THB = originalMonthlyAiCreditLimit;
	}
	if (originalWorkspacePlanId === undefined) {
		delete process.env.WORKSPACE_PLAN_ID;
	} else {
		process.env.WORKSPACE_PLAN_ID = originalWorkspacePlanId;
	}
}

beforeAll(async () => {
	process.env.DATA_DIR = routesDataDir;
	process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE = "1000";
	process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE = "10000";
	process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR = "10000";
	// This integration file shares one (anonymous → same IP) rate-limit key across
	// every test, so the generic per-minute API/write/export budgets are spent
	// cumulatively over the whole suite. The defaults (600 read / 240 write / 60
	// export per minute) are tight enough that adding a handful of tests can tip
	// late-running tests into spurious 429s. Raise them well above the suite's
	// total request count so the layered limiter never trips on aggregate volume;
	// the dedicated limiter tests assert their own narrow policies (queue capacity,
	// auth, etc.) which are unaffected by these generic ceilings.
	process.env.RATE_LIMIT_API_PER_MINUTE = "100000";
	process.env.RATE_LIMIT_API_PER_HOUR = "1000000";
	process.env.RATE_LIMIT_PROJECT_WRITE_PER_MINUTE = "100000";
	process.env.RATE_LIMIT_EXPORT_USAGE_PER_MINUTE = "100000";
	process.env.RATE_LIMIT_EXPORT_USAGE_PER_HOUR = "1000000";
	// Wave 0 W0.1: these integration tests intentionally exercise the legacy
	// pre-auth prototype flow (anonymous access to projects with no userId/
	// workspaceId). The backward-compat hatch is now opt-in via this flag;
	// without it every legacy path returns 401. Tests for the new deny-by-
	// default posture live in project-check-ownership.test.ts. We mutate
	// serverConfig directly because config.ts may already be module-cached from
	// a sibling test file, in which case the env var is too late.
	process.env.ALLOW_LEGACY_ANONYMOUS_PROJECTS = "true";
	const { serverConfig, PROJECTS_DIR } = await import("../config.js");
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: true });
	// Resolve the projects dir the server truly uses (see note on serverProjectsDir).
	serverProjectsDir = PROJECTS_DIR;
	app = (await import("../index.js")).app;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
		if (url.startsWith("http://worker.test/health")) {
			return Promise.resolve(new Response(JSON.stringify({ ok: true, accounts_available: 1 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}));
		}
		if (url.startsWith("http://worker-no-accounts.test/health")) {
			return Promise.resolve(new Response(JSON.stringify({
				ok: true,
				accounts_total: 1,
				accounts_available: 0,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}));
		}
		if (url.startsWith("http://worker-down.test/health")) {
			return Promise.resolve(new Response(JSON.stringify({ ok: false }), {
				status: 503,
				headers: { "Content-Type": "application/json" },
			}));
		}
		if (url.startsWith(LOCAL_API_ORIGIN)) {
			return app.request(url.slice(LOCAL_API_ORIGIN.length), init);
		}
		// Default benign image-moderation pass. With OPENAI_API_KEY="sk-test" set, the
		// mandatory CSAM screen on upload/AI-output now calls the provider and fails
		// CLOSED on an error (no real provider in tests). These integration tests are
		// not exercising moderation, so return a clean verdict instead of letting the
		// call hit the real endpoint (401) and quarantine every uploaded asset. Tests
		// that specifically assert a blocked/needs_review verdict override this with a
		// scoped wrappedFetch.
		if (url.startsWith("https://api.openai.com/v1/moderations")) {
			return Promise.resolve(new Response(JSON.stringify({
				id: "modr-test",
				model: "omni-moderation-latest",
				results: [{ flagged: false, categories: {}, category_scores: { sexual: 0.01, "sexual/minors": 0.01 }, category_applied_input_types: {} }],
			}), { status: 200, headers: { "Content-Type": "application/json" } }));
		}
		return realFetch(input, init);
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
	if (originalDataDir === undefined) {
		delete process.env.DATA_DIR;
	} else {
		process.env.DATA_DIR = originalDataDir;
	}
	if (originalWorkerUrl === undefined) {
		delete process.env.WORKER_URL;
	} else {
		process.env.WORKER_URL = originalWorkerUrl;
	}
	rmSync(routesDataDir, { recursive: true, force: true });
	restoreEnvValue("RATE_LIMIT_AI_SUBMIT_PER_MINUTE", originalRateLimitAiSubmitPerMinute);
	restoreEnvValue("RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE", originalRateLimitAiSubmitCostPerMinute);
	restoreEnvValue("RATE_LIMIT_AI_SUBMIT_PER_HOUR", originalRateLimitAiSubmitPerHour);
});

afterEach(() => {
	restoreOpenAiProviderEnv();
});

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

async function createProjectWithUploadedImage(name: string): Promise<{ projectId: string; imageId: string }> {
	const created = await (await fetch(`${BASE}/project/new`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, lang: "th" }),
	})).json();
	const pngBuffer = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		"base64",
	);
	const formData = new FormData();
	formData.append("images", new Blob([pngBuffer], { type: "image/png" }), `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
	const uploadRes = await fetch(`${BASE}/images/${created.projectId}/upload`, {
		method: "POST",
		body: formData,
	});
	expect(uploadRes.status).toBe(200);
	const upload = await uploadRes.json();
	return { projectId: created.projectId, imageId: upload.imageIds[0] };
}

// Like createProjectWithUploadedImage, but also establishes a real page-0 via the
// general save (uploading an image alone does not create pages) — required for the
// dedicated comment/marker endpoints, which 404 a missing page.
async function createProjectWithPage(name: string): Promise<{ projectId: string; imageId: string }> {
	const { projectId, imageId } = await createProjectWithUploadedImage(name);
	const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			projectId,
			name,
			createdAt: new Date().toISOString(),
			currentPage: 0,
			targetLang: "th",
			pages: [{ imageId, imageName: imageId, textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null }],
		}),
	});
	expect(saveRes.status).toBe(200);
	return { projectId, imageId };
}

describe("API Routes", () => {
	describe("Health", () => {
		test("GET /api/health returns ok", async () => {
			const res = await fetch(`${BASE}/health`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.ok).toBe(true);
			expect(data.version).toBe("0.1.0");
		});

		test("GET /api/readyz exposes readiness through the API proxy path", async () => {
			const res = await fetch(`${BASE}/readyz`);
			expect([200, 503]).toContain(res.status);
			const data = await res.json();
			expect(typeof data.healthy).toBe("boolean");
			expect(data.checks).toBeDefined();
		});
	});

	describe("Auth user management", () => {
		test("non-owner admin cannot mutate owner targets through legacy auth user routes", async () => {
			const { createUser, deleteUser, generateTokens, loadUser, updateUser } = await import("../services/auth.service.js");
			const admin = await createUser({
				email: `legacy-auth-admin-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Legacy Auth Admin",
				role: "admin",
			});
			const keeperOwner = await createUser({
				email: `legacy-auth-owner-keeper-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Owner Keeper",
				role: "owner",
			});
			const patchTarget = await createUser({
				email: `legacy-auth-owner-patch-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Owner Patch Target",
				role: "owner",
			});
			const deleteTarget = await createUser({
				email: `legacy-auth-owner-delete-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Owner Delete Target",
				role: "owner",
			});
			const disableTarget = await createUser({
				email: `legacy-auth-owner-disable-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Owner Disable Target",
				role: "owner",
			});
			const enableTarget = await createUser({
				email: `legacy-auth-owner-enable-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Owner Enable Target",
				role: "owner",
			});
			const ids = [
				admin.user.id,
				keeperOwner.user.id,
				patchTarget.user.id,
				deleteTarget.user.id,
				disableTarget.user.id,
				enableTarget.user.id,
			];

			try {
				await updateUser(enableTarget.user.id, { isActive: false });
				const adminUser = await loadUser(admin.user.id);
				expect(adminUser).toBeTruthy();
				const adminTokens = await generateTokens(adminUser!);
				const jsonHeaders = {
					"Content-Type": "application/json",
					Authorization: `Bearer ${adminTokens.accessToken}`,
				};
				const authHeaders = { Authorization: `Bearer ${adminTokens.accessToken}` };

				const patchRes = await fetch(`${BASE}/auth/users/${patchTarget.user.id}`, {
					method: "PATCH",
					headers: jsonHeaders,
					body: JSON.stringify({ name: "Taken Over" }),
				});
				expect(patchRes.status).toBe(403);
				expect((await loadUser(patchTarget.user.id))?.name).toBe("Owner Patch Target");

				const deleteRes = await fetch(`${BASE}/auth/users/${deleteTarget.user.id}`, {
					method: "DELETE",
					headers: authHeaders,
				});
				expect(deleteRes.status).toBe(403);
				expect(await loadUser(deleteTarget.user.id)).toBeTruthy();

				const disableRes = await fetch(`${BASE}/auth/users/${disableTarget.user.id}/disable`, {
					method: "POST",
					headers: authHeaders,
				});
				expect(disableRes.status).toBe(403);
				expect((await loadUser(disableTarget.user.id))?.isActive).toBe(true);

				const enableRes = await fetch(`${BASE}/auth/users/${enableTarget.user.id}/enable`, {
					method: "POST",
					headers: authHeaders,
				});
				expect(enableRes.status).toBe(403);
				expect((await loadUser(enableTarget.user.id))?.isActive).toBe(false);
			} finally {
				for (const id of ids) {
					await deleteUser(id).catch(() => undefined);
				}
			}
		});
	});

	describe("Usage catalog", () => {
		test("GET /api/usage/plans/catalog exposes mock plans and add-ons", async () => {
			const res = await fetch(`${BASE}/usage/plans/catalog`);
			expect(res.status).toBe(200);
			const data = await res.json();

			expect(data.billing).toMatchObject({
				status: "mock",
				currency: "USD",
			});
			expect(data.plans.map((plan: any) => plan.id)).toEqual(["free", "creator", "pro", "studio", "studio_plus"]);
			expect(data.addons.map((addon: any) => addon.id)).toEqual(expect.arrayContaining([
				"credits-500",
				"storage-25gb",
				"seat-1",
			]));
			// Retired SKUs must not be offered for sale.
			expect(data.addons.map((addon: any) => addon.id)).not.toContain("byo-api");
			expect(data.currentPlan.id).toBe("free");
		});

		test("GET /api/usage/:projectId/events returns a bounded cursor page", async () => {
			const project = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Usage Event Project",
					lang: "th",
				}),
			});
			expect(project.status).toBe(200);
			const projectBody = await project.json();
			const projectId = projectBody.projectId;

			// Export is FREE (2026-06-13): the endpoint succeeds but records NO
			// usage event, so the events list stays empty for export_bytes_recorded.
			const exportUsage = await fetch(`${BASE}/usage/${projectId}/export`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					bytes: 1234,
					idempotencyKey: `usage-events-${crypto.randomUUID()}`,
					exportKind: "single-page",
				}),
			});
			expect(exportUsage.status).toBe(200);

			const events = await fetch(`${BASE}/usage/${projectId}/events?limit=1&kind=export_bytes_recorded`);
			expect(events.status).toBe(200);
			const body = await events.json();
			expect(body.events).toHaveLength(0);

			// The /events route still validates its limit (the real coverage here).
			const invalidLimit = await fetch(`${BASE}/usage/${projectId}/events?limit=0`);
			expect(invalidLimit.status).toBe(400);
		});
	});

	describe("Project CRUD", () => {
		test("POST /api/project/new creates a project", async () => {
			const res = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Test Project",
					lang: "th",
					storyId: "test-project",
					storyTitle: "Test Project",
					chapterNumber: "104",
					chapterTitle: "Real File Smoke",
					chapterLabel: "ตอน 104 - Real File Smoke",
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.projectId).toBeDefined();
			expect(typeof data.projectId).toBe("string");
			testProjectId = data.projectId;
		});

		test("POST /api/project/new validates input", async () => {
			const res = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "A".repeat(201) }), // too long
			});
			expect(res.status).toBe(400);
		});

		test("POST /api/project/new persists a non-Japanese source language", async () => {
			const res = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Korean Source", lang: "en", sourceLang: "ko" }),
			});
			expect(res.status).toBe(200);
			const { projectId } = await res.json();
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(state.sourceLang).toBe("ko");
			expect(state.targetLang).toBe("en");
		});

		test("POST /api/project/new defaults source language to ja", async () => {
			const res = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Default Source", lang: "th" }),
			});
			expect(res.status).toBe(200);
			const { projectId } = await res.json();
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(state.sourceLang).toBe("ja");
		});

		test("POST /api/project/new mints a stable, dash-free storyId when none is provided", async () => {
			async function createStory(name: string): Promise<string> {
				const res = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					// Same title, no storyId: each must get its own stable id (no collision).
					body: JSON.stringify({ name, lang: "th", storyTitle: "Twin Title" }),
				});
				expect(res.status).toBe(200);
				const { projectId } = await res.json();
				const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
				return state.storyId;
			}

			const firstStoryId = await createStory("Twin A");
			const secondStoryId = await createStory("Twin B");
			// Stable id is non-empty, dash-free, URL-safe, and not derived from the title.
			expect(firstStoryId).toMatch(/^[0-9a-z]+$/);
			expect(firstStoryId).not.toContain("-");
			expect(firstStoryId).not.toContain("twin");
			// Two same-title stories get DIFFERENT ids → they never merge.
			expect(secondStoryId).not.toBe(firstStoryId);
		});

		test("POST /api/project/new reuses a caller-provided storyId (adding a chapter to an existing story)", async () => {
			const res = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Existing Story Ch2", lang: "th", storyId: "reusedstableid" }),
			});
			expect(res.status).toBe(200);
			const { projectId } = await res.json();
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(state.storyId).toBe("reusedstableid");
		});

		test("PATCH /api/project/:id/story renames storyTitle while preserving the stable storyId", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Rename Ch1", lang: "th", storyTitle: "Old Story Name" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const before = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(before.storyTitle).toBe("Old Story Name");
			const stableStoryId = before.storyId;
			expect(stableStoryId).toBeTruthy();

			const renameRes = await fetch(`${BASE}/project/${projectId}/story`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ storyTitle: "Brand New Story Name" }),
			});
			expect(renameRes.status).toBe(200);
			const renameBody = await renameRes.json();
			expect(renameBody.storyTitle).toBe("Brand New Story Name");
			// Stable id is returned unchanged.
			expect(renameBody.storyId).toBe(stableStoryId);

			const after = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(after.storyTitle).toBe("Brand New Story Name");
			expect(after.storyId).toBe(stableStoryId);
		});

		test("PATCH /api/project/:id/story rejects an empty title", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Empty Title Guard", lang: "th", storyTitle: "Keep Me" }),
			});
			const { projectId } = await createRes.json();
			const res = await fetch(`${BASE}/project/${projectId}/story`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ storyTitle: "   " }),
			});
			expect(res.status).toBe(400);
			const after = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(after.storyTitle).toBe("Keep Me");
		});

		test("POST /api/project/:id/save can rename storyTitle but never mutates the stable storyId", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Save Story Identity", lang: "th", storyTitle: "Save Original" }),
			});
			const { projectId } = await createRes.json();
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			const stableStoryId = state.storyId;
			expect(stableStoryId).toBeTruthy();

			// Attempt a save that renames the title AND tries to overwrite the stable id.
			const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...state, storyTitle: "Save Renamed", storyId: "tamperedid" }),
			});
			expect(saveRes.status).toBe(200);
			const after = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(after.storyTitle).toBe("Save Renamed");
			// storyId is server-preserved: the tamper attempt is ignored.
			expect(after.storyId).toBe(stableStoryId);
		});

		test("DELETE /api/project/:id permanently removes the project (with confirmation)", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Delete Me", lang: "th", storyTitle: "Delete Me Story" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			// It exists first.
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(200);
			const projectDir = join(serverProjectsDir, projectId);
			expect(existsSync(projectDir)).toBe(true);

			const delRes = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "Delete Me Story" }),
			});
			expect(delRes.status).toBe(200);
			const delBody = await delRes.json();
			expect(delBody.deleted).toBe(true);

			// Gone from GET, from the list, AND from disk.
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);
			const list = await (await fetch(`${BASE}/project`)).json();
			expect(list.projects.some((item: any) => item.projectId === projectId)).toBe(false);
			expect(existsSync(projectDir)).toBe(false);
		});

		test("DELETE /api/project/:id rejects a missing confirmation body (does not delete)", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Keep Without Confirm", lang: "th", storyTitle: "Keep Story" }),
			});
			const { projectId } = await createRes.json();

			// No body at all → 400, project still resolves.
			const noBody = await fetch(`${BASE}/project/${projectId}`, { method: "DELETE" });
			expect(noBody.status).toBe(400);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(200);

			// Empty object → 400 (confirmStoryTitle required).
			const emptyBody = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(emptyBody.status).toBe(400);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(200);
		});

		test("DELETE /api/project/:id rejects a mismatched confirmation title (does not delete)", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Mismatch Guard", lang: "th", storyTitle: "Right Title" }),
			});
			const { projectId } = await createRes.json();

			const wrong = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "Wrong Title" }),
			});
			expect(wrong.status).toBe(400);
			const body = await wrong.json();
			expect(body.code).toBe("delete_confirmation_mismatch");
			// Still present.
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(200);
			expect(existsSync(join(serverProjectsDir, projectId))).toBe(true);
		});

		test("DELETE confirmation falls back to the project name for legacy projects without a storyTitle", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// No storyTitle → confirmation matches the project name.
				body: JSON.stringify({ name: "Legacy Name Only", lang: "th" }),
			});
			const { projectId } = await createRes.json();

			const del = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "Legacy Name Only" }),
			});
			expect(del.status).toBe(200);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);
		});

		test("DELETE leaves a tombstone so a re-readable state.json cannot resurrect the project", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "No Resurrection", lang: "th", storyTitle: "No Resurrection Story" }),
			});
			const { projectId } = await createRes.json();
			const projectDir = join(serverProjectsDir, projectId);
			const statePath = join(projectDir, "state.json");
			const stateSnapshot = readFileSync(statePath, "utf8");

			const del = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "No Resurrection Story" }),
			});
			expect(del.status).toBe(200);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);

			// Tombstone marker exists outside the (now-deleted) project dir.
			expect(existsSync(join(serverProjectsDir, ".tombstones", projectId))).toBe(true);

			// Simulate a partial/failed delete or a stale replica: a readable state.json
			// reappears on disk. The tombstone must keep the project DELETED (no
			// resurrection) on the next read.
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(statePath, stateSnapshot);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);
			const list = await (await fetch(`${BASE}/project`)).json();
			expect(list.projects.some((item: any) => item.projectId === projectId)).toBe(false);
		});

		test("DELETE still succeeds + stays unresurrectable when the on-disk rmSync fails AFTER the tombstone is written", async () => {
			// Tombstone-FIRST invariant (Codex P1.1): the tombstone is written before
			// any store is touched. If the subsequent disk rmSync fails, the project is
			// ALREADY logically deleted + unreadable (the tombstone blocks every read),
			// so the DELETE succeeds (200) and the orphaned dir is logged for cleanup
			// rather than resurrecting the project by failing.
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Undeletable Disk", lang: "th", storyTitle: "Undeletable Story" }),
			});
			const { projectId } = await createRes.json();
			const projectDir = join(serverProjectsDir, projectId);
			expect(existsSync(projectDir)).toBe(true);

			// Make the project dir un-writable so removing its children (state.json,
			// images/) fails with EACCES — a real partial-delete condition AFTER the
			// tombstone write.
			chmodSync(projectDir, 0o500);
			try {
				const del = await fetch(`${BASE}/project/${projectId}`, {
					method: "DELETE",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ confirmStoryTitle: "Undeletable Story" }),
				});
				// Succeeds: the tombstone was written first, so the project is gone for good.
				expect(del.status).toBe(200);
				expect((await del.json()).deleted).toBe(true);

				// The tombstone exists, the project is unreadable, and the stale state.json
				// that survived the failed rmSync CANNOT resurrect it.
				expect(existsSync(join(serverProjectsDir, ".tombstones", projectId))).toBe(true);
				expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);
				const list = await (await fetch(`${BASE}/project`)).json();
				expect(list.projects.some((item: any) => item.projectId === projectId)).toBe(false);
			} finally {
				// Restore write perms so the orphaned dir can be cleaned up.
				chmodSync(projectDir, 0o700);
				rmSync(projectDir, { recursive: true, force: true });
			}

			// Still gone after cleanup — the tombstone keeps it deleted permanently.
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);
		});

		test("DELETE /api/project/:id returns 404 for a missing project", async () => {
			const res = await fetch(`${BASE}/project/00000000-0000-0000-0000-000000000000`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "anything" }),
			});
			expect(res.status).toBe(404);
		});

		test("DELETE on a TOMBSTONED id idempotently completes the reclaim (200), skipping type-to-confirm", async () => {
			// Data-integrity retry path: a prior DELETE wrote the tombstone (so the
			// project is ALREADY logically deleted + unreadable) but a transient catalog
			// failure 500'd before the reclaim finished. A naive retry would 404 on the
			// tombstone and never finish the reclaim. The handler must instead detect the
			// tombstone and idempotently re-run the completion phase, returning 200 — and
			// WITHOUT requiring the type-to-confirm title (whose state is now unreadable).
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Retry Complete", lang: "th", storyTitle: "Retry Complete Story" }),
			});
			const { projectId } = await createRes.json();

			// First delete tombstones + removes the project (file mode: no catalog/CoW).
			const firstDel = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "Retry Complete Story" }),
			});
			expect(firstDel.status).toBe(200);
			expect(existsSync(join(serverProjectsDir, ".tombstones", projectId))).toBe(true);

			// Retry with NO confirmation body at all: the tombstoned-retry branch skips
			// the type-to-confirm (the project is already deleted) and still returns 200,
			// idempotently re-running the reclaim. A pre-fix handler 404'd here.
			const retry = await fetch(`${BASE}/project/${projectId}`, { method: "DELETE" });
			expect(retry.status).toBe(200);
			expect((await retry.json()).deleted).toBe(true);

			// Still gone + still tombstoned: the completion is idempotent, not a resurrect.
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);
			expect(existsSync(join(serverProjectsDir, ".tombstones", projectId))).toBe(true);

			// A WRONG confirmation title is also accepted on the retry path (skipped),
			// because the project is already logically deleted — finishing the reclaim is
			// not a new destructive decision.
			const retryWrongTitle = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "totally wrong title" }),
			});
			expect(retryWrongTitle.status).toBe(200);
		});

		test("DELETE distinguishes a NEVER-EXISTED id (404) from a tombstoned one", async () => {
			// A fresh, never-created id has NO tombstone and NO state, so the handler must
			// NOT take the idempotent-completion branch — it returns 404, exactly as
			// before. (Guards against the retry branch swallowing genuinely-unknown ids.)
			const ghostId = "11111111-2222-4333-8444-555555555555";
			expect(existsSync(join(serverProjectsDir, ".tombstones", ghostId))).toBe(false);
			const res = await fetch(`${BASE}/project/${ghostId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "anything" }),
			});
			expect(res.status).toBe(404);
		});

		// Regression (P2): a chapter project with NO storyTitle whose `name` carries a
		// chapter suffix (the shape the Chapter setup dialog persists, `"<title> - ตอน N"`)
		// must be deletable. The library story-delete flow used to send the GROUP's
		// family-stripped display title (`"<title>"`) for every chapter — which never
		// matches the backend's `storyTitle ?? name` (the FULL suffixed name) for a
		// no-storyTitle project, making the story permanently undeletable. The fix sends
		// each chapter's OWN canonical title (`storyTitle ?? name`); these tests pin the
		// server contract the fixed client relies on.
		test("DELETE confirmation accepts the FULL suffixed name for a no-storyTitle chapter (family-stripped title is NOT the contract)", async () => {
			const suffixedName = "เรื่องเอ - ตอน 1";
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// No storyTitle → the server's expected confirm title is the full name.
				body: JSON.stringify({ name: suffixedName, lang: "th" }),
			});
			const { projectId } = await createRes.json();

			// The OLD buggy client sent the family-stripped group title ("เรื่องเอ") →
			// mismatch → undeletable. Assert the server rejects that (so the bug is real)…
			const stripped = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "เรื่องเอ" }),
			});
			expect(stripped.status).toBe(400);
			expect((await stripped.json()).code).toBe("delete_confirmation_mismatch");
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(200);

			// …and accepts the chapter's OWN canonical title (the fixed client sends this).
			const del = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: suffixedName }),
			});
			expect(del.status).toBe(200);
			expect((await del.json()).deleted).toBe(true);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);
		});

		test("DELETE confirmation accepts the storyTitle for a chapter whose name is a bare chapter label", async () => {
			// A chapter whose NAME is entirely a chapter label ("ตอน 5") but which DOES
			// carry a storyTitle: the fixed client sends the storyTitle (not the bare,
			// family-empty name), and the server accepts it.
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "ตอน 5", lang: "th", storyTitle: "เรื่องบี" }),
			});
			const { projectId } = await createRes.json();

			const del = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "เรื่องบี" }),
			});
			expect(del.status).toBe(200);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(404);
		});

		test("DELETE still rejects an empty/blind confirm and a wrong title for a no-storyTitle suffixed chapter", async () => {
			const suffixedName = "Story B - Chapter 3";
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: suffixedName, lang: "th" }),
			});
			const { projectId } = await createRes.json();

			// Empty confirm → 400 (zod min(1)); project survives.
			const empty = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "" }),
			});
			expect(empty.status).toBe(400);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(200);

			// Blind delete (no body) → 400; project survives.
			const blind = await fetch(`${BASE}/project/${projectId}`, { method: "DELETE" });
			expect(blind.status).toBe(400);
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(200);

			// Wrong title (the family-stripped "Story B") → 400; project survives.
			const wrong = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: "Story B" }),
			});
			expect(wrong.status).toBe(400);
			expect((await wrong.json()).code).toBe("delete_confirmation_mismatch");
			expect((await fetch(`${BASE}/project/${projectId}`)).status).toBe(200);

			// The canonical full name works (cleanup + positive control).
			const ok = await fetch(`${BASE}/project/${projectId}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmStoryTitle: suffixedName }),
			});
			expect(ok.status).toBe(200);
		});

		test("POST /api/project/new persists per-chapter reading direction and save guards invalid values", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Reading Direction Project",
					lang: "th",
					readingDirection: "rtl",
				}),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();

			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.readingDirection).toBe("rtl");

			// Switching to a valid direction sticks.
			const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...loaded, readingDirection: "vertical" }),
			});
			expect(saveRes.status).toBe(200);
			const afterSwitch = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(afterSwitch.readingDirection).toBe("vertical");

			// An invalid direction is rejected by the save guard and falls back to the stored value.
			const badSave = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...afterSwitch, readingDirection: "diagonal" }),
			});
			expect(badSave.status).toBe(200);
			const afterBad = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(afterBad.readingDirection).toBe("vertical");

			// The project summary surfaces the direction too.
			const list = await (await fetch(`${BASE}/project`)).json();
			const summary = list.projects.find((item: any) => item.projectId === projectId);
			expect(summary.readingDirection).toBe("vertical");
		});

		test("POST /api/project/new rejects an invalid reading direction at create", async () => {
			const res = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Bad Direction", readingDirection: "sideways" }),
			});
			expect(res.status).toBe(400);
		});

		test("GET /api/project/:id returns project state", async () => {
			const res = await fetch(`${BASE}/project/${testProjectId}`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.projectId).toBe(testProjectId);
			expect(data.name).toBe("Test Project");
			expect(data.storyId).toBe("test-project");
			expect(data.storyTitle).toBe("Test Project");
			expect(data.chapterNumber).toBe("104");
			expect(data.chapterTitle).toBe("Real File Smoke");
			expect(data.chapterLabel).toBe("ตอน 104 - Real File Smoke");
			expect(data.targetLang).toBe("th");
			expect(Array.isArray(data.pages)).toBe(true);
			expect(data.textStylePresets).toEqual([]);
			expect(data.creditPresets).toEqual([]);
		});

		test("GET /api/project lists accessible projects", async () => {
			const res = await fetch(`${BASE}/project`);
			expect(res.status).toBe(200);
			const data = await res.json();
			const summary = data.projects.find((item: any) => item.projectId === testProjectId);
			expect(summary).toBeDefined();
			expect(summary.name).toBe("Test Project");
			expect(summary.storyId).toBe("test-project");
			expect(summary.storyTitle).toBe("Test Project");
			expect(summary.chapterLabel).toBe("ตอน 104 - Real File Smoke");
			expect(summary.pageCount).toBe(0);
			expect(summary.updatedAt).toBeDefined();
		});

		test("GET /api/project supports bounded project-list pagination", async () => {
			const res = await fetch(`${BASE}/project?limit=1`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(Array.isArray(data.projects)).toBe(true);
			expect(data.projects.length).toBeLessThanOrEqual(1);
			if (data.nextCursor !== undefined) {
				expect(typeof data.nextCursor).toBe("string");
			}

			const invalid = await fetch(`${BASE}/project?limit=0`);
			expect(invalid.status).toBe(400);

			const invalidCursor = await fetch(`${BASE}/project?cursor=not-a-valid-cursor`);
			expect(invalidCursor.status).toBe(400);
		});

		test("GET /api/project/:id/pages supports bounded page pagination", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Page Catalog Route", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const state = {
				projectId,
				name: "Page Catalog Route",
				createdAt: "2026-05-28T01:00:00.000Z",
				pages: [
					{
						imageId: "page-0.png",
						imageName: "page-0.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					},
					{
						imageId: "page-1.png",
						imageName: "page-1.png",
						originalName: "001.png",
						textLayers: [{ id: "text-1", text: "Ready", x: 0, y: 0, w: 120, h: 40, rotation: 0, fontSize: 20, alignment: "center", index: 0 }],
						pendingAiJobs: [],
						coverRect: null,
						qcHandoff: { status: "ready", updatedAt: "2026-05-28T02:00:00.000Z" },
					},
					{
						imageId: "page-2.png",
						imageName: "page-2.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
						translationHandoff: { status: "needs_translation", updatedAt: "2026-05-28T02:30:00.000Z" },
					},
				],
				currentPage: 0,
				targetLang: "th",
			};
			const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});
			expect(saveRes.status).toBe(200);

			const firstRes = await fetch(`${BASE}/project/${projectId}/pages?limit=2`);
			expect(firstRes.status).toBe(200);
			const firstPage = await firstRes.json();
			expect(firstPage.pages.map((page: any) => page.pageIndex)).toEqual([0, 1]);
			expect(firstPage.pages[1]).toMatchObject({
				status: "review_ready",
				imageName: "page-1.png",
				originalName: "001.png",
				textLayerCount: 1,
			});
			expect(firstPage.nextCursor).toBeDefined();

			const secondRes = await fetch(`${BASE}/project/${projectId}/pages?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
			expect(secondRes.status).toBe(200);
			const secondPage = await secondRes.json();
			expect(secondPage.pages.map((page: any) => page.pageIndex)).toEqual([2]);
			expect(secondPage.pages[0].status).toBe("needs_translation");

			const filteredRes = await fetch(`${BASE}/project/${projectId}/pages?status=review_ready`);
			expect(filteredRes.status).toBe(200);
			const filtered = await filteredRes.json();
			expect(filtered.pages.map((page: any) => page.pageIndex)).toEqual([1]);
			const handoffFilteredRes = await fetch(`${BASE}/project/${projectId}/pages?status=needs_translation`);
			expect(handoffFilteredRes.status).toBe(200);
			const handoffFiltered = await handoffFilteredRes.json();
			expect(handoffFiltered.pages.map((page: any) => page.pageIndex)).toEqual([2]);

			const invalid = await fetch(`${BASE}/project/${projectId}/pages?limit=0`);
			expect(invalid.status).toBe(400);
			const invalidCursor = await fetch(`${BASE}/project/${projectId}/pages?cursor=not-a-valid-cursor`);
			expect(invalidCursor.status).toBe(400);
		});

		test("GET /api/project/:id/tasks supports bounded task pagination", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Task Catalog Route", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const state = {
				projectId,
				name: "Task Catalog Route",
				createdAt: "2026-05-28T01:00:00.000Z",
				pages: [
					{
						imageId: "page-0.png",
						imageName: "page-0.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					},
					{
						imageId: "page-1.png",
						imageName: "page-1.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					},
				],
				currentPage: 0,
				targetLang: "th",
				tasks: [
					{
						id: "page-0-translate",
						type: "translate",
						status: "doing",
						priority: "high",
						pageIndex: 0,
						title: "Translate page",
						assignee: "user-1",
						createdAt: "2026-05-28T01:00:00.000Z",
						updatedAt: "2026-05-28T03:00:00.000Z",
					},
					{
						id: "page-1-review",
						type: "review",
						status: "review",
						priority: "urgent",
						pageIndex: 1,
						title: "Review page",
						assignee: "user-2",
						createdAt: "2026-05-28T01:00:00.000Z",
						updatedAt: "2026-05-28T04:00:00.000Z",
					},
				],
			};
			// Seed the server-owned `tasks` collection on disk directly. The general
			// `/save` is server-authoritative for tasks (it ignores the body's copy so
			// a stale save can't clobber a concurrent dedicated-endpoint change), so we
			// cannot seed task fixtures through it — write `state.json` like the legacy/
			// textless task tests above.
			const { PROJECTS_DIR: activeProjectsDir } = await import("../config.js");
			const statePath = join(activeProjectsDir, projectId, "state.json");
			writeFileSync(statePath, JSON.stringify(state, null, 2));

			const firstRes = await fetch(`${BASE}/project/${projectId}/tasks?limit=2`);
			expect(firstRes.status).toBe(200);
			const firstPage = await firstRes.json();
			expect(firstPage.tasks).toHaveLength(2);
			expect(firstPage.nextCursor).toBeDefined();

			const secondRes = await fetch(`${BASE}/project/${projectId}/tasks?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
			expect(secondRes.status).toBe(200);
			const secondPage = await secondRes.json();
			expect(secondPage.tasks.length).toBeGreaterThan(0);

			const filteredRes = await fetch(`${BASE}/project/${projectId}/tasks?status=doing&type=translate&assignee=${encodeURIComponent("@user-1")}&pageIndex=0`);
			expect(filteredRes.status).toBe(200);
			const filtered = await filteredRes.json();
			expect(filtered.tasks.map((task: any) => task.id)).toEqual(["page-0-translate"]);

			const invalid = await fetch(`${BASE}/project/${projectId}/tasks?limit=0`);
			expect(invalid.status).toBe(400);
			const invalidCursor = await fetch(`${BASE}/project/${projectId}/tasks?cursor=not-a-valid-cursor`);
			expect(invalidCursor.status).toBe(400);
		});

		test("GET /api/project/:id/tasks materializes workflow tasks for legacy project state", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Legacy Workflow Tasks", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const state = {
				projectId,
				name: "Legacy Workflow Tasks",
				createdAt: "2026-05-28T01:00:00.000Z",
				pages: [{
					imageId: "legacy-page.png",
					imageName: "legacy-page.png",
					// Page carries text → a review/QC task IS materialized (something to QC).
					textLayers: [{
						id: "t1",
						text: "สวัสดี",
						x: 0,
						y: 0,
						w: 100,
						h: 40,
						rotation: 0,
						fontSize: 24,
						alignment: "center",
						index: 0,
					}],
					pendingAiJobs: [],
					coverRect: null,
				}],
				currentPage: 0,
				targetLang: "th",
			};
			const { PROJECTS_DIR: activeProjectsDir } = await import("../config.js");
			const statePath = join(activeProjectsDir, projectId, "state.json");
			writeFileSync(statePath, JSON.stringify(state, null, 2));

			const res = await fetch(`${BASE}/project/${projectId}/tasks?limit=10`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.tasks.map((task: any) => task.id).sort()).toEqual([
				"page-0-clean",
				"page-0-review",
				"page-0-translate",
				"page-0-typeset",
			]);
			const persisted = JSON.parse(readFileSync(statePath, "utf8"));
			expect(persisted.tasks).toHaveLength(4);
		});

		test("GET /api/project/:id/tasks skips the auto review/QC task for a textless page", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Textless Skip", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const state = {
				projectId,
				name: "Textless Skip",
				createdAt: "2026-05-28T01:00:00.000Z",
				pages: [{
					imageId: "raw-scan.png",
					imageName: "raw-scan.png",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				}],
				currentPage: 0,
				targetLang: "th",
			};
			const { PROJECTS_DIR: activeProjectsDir } = await import("../config.js");
			const statePath = join(activeProjectsDir, projectId, "state.json");
			writeFileSync(statePath, JSON.stringify(state, null, 2));

			const res = await fetch(`${BASE}/project/${projectId}/tasks?limit=10`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.tasks.map((task: any) => task.id).sort()).toEqual([
				"page-0-clean",
				"page-0-translate",
				"page-0-typeset",
			]);
		});

		test("GET /api/project/:id/comments and review-decisions support bounded feedback pagination", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Feedback Catalog Route", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const state = {
				projectId,
				name: "Feedback Catalog Route",
				createdAt: "2026-05-28T01:00:00.000Z",
				pages: [
					{
						imageId: "page-0.png",
						imageName: "page-0.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					},
					{
						imageId: "page-1.png",
						imageName: "page-1.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					},
				],
				currentPage: 0,
				targetLang: "th",
				comments: [
					{
						id: "comment-a",
						pageIndex: 0,
						body: "Open redraw note",
						author: "user-1",
						mentions: ["qa"],
						status: "open",
						createdAt: "2026-05-28T01:00:00.000Z",
						updatedAt: "2026-05-28T02:00:00.000Z",
					},
					{
						id: "comment-b",
						pageIndex: 1,
						layerId: "layer-1",
						body: "Resolved note",
						author: "user-2",
						mentions: [],
						status: "resolved",
						createdAt: "2026-05-28T01:00:00.000Z",
						updatedAt: "2026-05-28T03:00:00.000Z",
					},
				],
				reviewDecisions: [
					{
						id: "decision-a",
						pageIndex: 0,
						status: "approved",
						actor: "reviewer-1",
						createdAt: "2026-05-28T01:00:00.000Z",
						updatedAt: "2026-05-28T02:00:00.000Z",
					},
					{
						id: "decision-b",
						pageIndex: 1,
						status: "changes_requested",
						body: "Fix page 1",
						actor: "reviewer-2",
						createdAt: "2026-05-28T01:00:00.000Z",
						updatedAt: "2026-05-28T03:00:00.000Z",
					},
				],
			};
			// Seed server-owned comments/review-decisions on disk directly: the general
			// `/save` is server-authoritative for these (it keeps its persisted copy and
			// ignores the body's, so a stale save can't drop a concurrent dedicated-
			// endpoint change), so fixtures must be written to `state.json`.
			const { PROJECTS_DIR: activeProjectsDir } = await import("../config.js");
			const statePath = join(activeProjectsDir, projectId, "state.json");
			writeFileSync(statePath, JSON.stringify(state, null, 2));

			const commentsFirstRes = await fetch(`${BASE}/project/${projectId}/comments?limit=1`);
			expect(commentsFirstRes.status).toBe(200);
			const commentsFirst = await commentsFirstRes.json();
			expect(commentsFirst.comments.map((comment: any) => comment.id)).toEqual(["comment-b"]);
			expect(commentsFirst.nextCursor).toBeDefined();

			const commentsSecondRes = await fetch(`${BASE}/project/${projectId}/comments?limit=1&cursor=${encodeURIComponent(commentsFirst.nextCursor)}`);
			expect(commentsSecondRes.status).toBe(200);
			const commentsSecond = await commentsSecondRes.json();
			expect(commentsSecond.comments.map((comment: any) => comment.id)).toEqual(["comment-a"]);

			const commentsFilteredRes = await fetch(`${BASE}/project/${projectId}/comments?status=resolved&pageIndex=1&layerId=layer-1&author=user-2`);
			expect(commentsFilteredRes.status).toBe(200);
			const commentsFiltered = await commentsFilteredRes.json();
			expect(commentsFiltered.comments.map((comment: any) => comment.id)).toEqual(["comment-b"]);

			const decisionsFirstRes = await fetch(`${BASE}/project/${projectId}/review-decisions?limit=1`);
			expect(decisionsFirstRes.status).toBe(200);
			const decisionsFirst = await decisionsFirstRes.json();
			expect(decisionsFirst.decisions.map((decision: any) => decision.id)).toEqual(["decision-b"]);
			expect(decisionsFirst.nextCursor).toBeDefined();

			const decisionsSecondRes = await fetch(`${BASE}/project/${projectId}/review-decisions?limit=1&cursor=${encodeURIComponent(decisionsFirst.nextCursor)}`);
			expect(decisionsSecondRes.status).toBe(200);
			const decisionsSecond = await decisionsSecondRes.json();
			expect(decisionsSecond.decisions.map((decision: any) => decision.id)).toEqual(["decision-a"]);

			const decisionsFilteredRes = await fetch(`${BASE}/project/${projectId}/review-decisions?status=changes_requested&pageIndex=1&actor=reviewer-2`);
			expect(decisionsFilteredRes.status).toBe(200);
			const decisionsFiltered = await decisionsFilteredRes.json();
			expect(decisionsFiltered.decisions.map((decision: any) => decision.id)).toEqual(["decision-b"]);

				const invalid = await fetch(`${BASE}/project/${projectId}/comments?limit=0`);
				expect(invalid.status).toBe(400);

				const invalidCommentCursor = await fetch(`${BASE}/project/${projectId}/comments?cursor=not-a-cursor`);
				expect(invalidCommentCursor.status).toBe(400);
				expect(await invalidCommentCursor.json()).toEqual(expect.objectContaining({ error: "Invalid project comment cursor" }));

				const invalidDecisionCursor = await fetch(`${BASE}/project/${projectId}/review-decisions?cursor=not-a-cursor`);
				expect(invalidDecisionCursor.status).toBe(400);
				expect(await invalidDecisionCursor.json()).toEqual(expect.objectContaining({ error: "Invalid project review decision cursor" }));
			});

		test("GET /api/project/:id with invalid ID returns 400", async () => {
			const res = await fetch(`${BASE}/project/not-a-uuid`);
			expect(res.status).toBe(400);
		});

		test("GET /api/project/:id with non-existent ID returns 404", async () => {
			const res = await fetch(`${BASE}/project/00000000-0000-0000-0000-000000000000`);
			expect(res.status).toBe(404);
		});

		test("PATCH /api/project/:id/pages/:pageIndex/ai-result rejects retired flatten apply without mutating page edits", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Retired AI flatten guard", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const state = {
				projectId,
				name: "Retired AI flatten guard",
				createdAt: new Date().toISOString(),
				pages: [{
					imageId: "source.webp",
					imageName: "source.webp",
					textLayers: [],
					imageLayers: [],
					edits: { imageId: "existing-edit.webp" },
					pendingAiJobs: [],
					coverRect: null,
				}],
				currentPage: 0,
				targetLang: "th",
				activityLog: [],
			};
			// Seed on disk directly: the general `/save` is server-authoritative for
			// activityLog (it keeps its persisted copy, e.g. the project_created event,
			// and ignores the body's), so writing `state.json` is the only way to assert
			// against a truly empty activity log here.
			const { PROJECTS_DIR: activeProjectsDir } = await import("../config.js");
			const statePath = join(activeProjectsDir, projectId, "state.json");
			writeFileSync(statePath, JSON.stringify(state, null, 2));

			const applyRes = await fetch(`${BASE}/project/${projectId}/pages/0/ai-result`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ resultImageId: "destructive-ai-result.webp" }),
			});
			expect(applyRes.status).toBe(410);
			const applyBody = await applyRes.json();
			expect(applyBody.code).toBe("ai_result_flatten_retired");

			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.pages[0].edits).toEqual({ imageId: "existing-edit.webp" });
			expect(loaded.pages[0].imageLayers).toEqual([]);
			expect(loaded.activityLog ?? []).toEqual([]);
		});

		test("POST /api/project/:id/save saves state", async () => {
			const state = {
				projectId: testProjectId,
				name: "Updated Name",
				createdAt: new Date().toISOString(),
				coverImageId: "cover-test.png",
				coverOriginalName: "cover-test-source.png",
				pages: [],
				currentPage: 0,
				targetLang: "en",
			};
			const res = await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});
			expect(res.status).toBe(200);

			// Verify save
			const loaded = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(loaded.name).toBe("Updated Name");
			expect(loaded.targetLang).toBe("en");

			// Verify the project list cache is invalidated by saves.
			const listed = await (await fetch(`${BASE}/project`)).json();
			const summary = listed.projects.find((item: any) => item.projectId === testProjectId);
			expect(summary.name).toBe("Updated Name");
			expect(summary.coverImageId).toBe("cover-test.png");
			expect(summary.coverOriginalName).toBe("cover-test-source.png");
		});

		test("POST /api/project/:id/save rejects non-finite text-layer geometry with 400", async () => {
			const { projectId } = await createProjectWithUploadedImage("Bad Geometry Save");
			const state = {
				projectId,
				name: "Bad Geometry Save",
				createdAt: new Date().toISOString(),
				pages: [{
					imageId: "page-1.webp",
					imageName: "page-1.webp",
					textLayers: [{
						id: "text-bad",
						text: "boom",
						x: Number.POSITIVE_INFINITY,
						y: 0,
						w: 100,
						h: 40,
						rotation: 0,
						fontSize: 20,
						alignment: "center",
						index: 0,
					}],
					pendingAiJobs: [],
					coverRect: null,
				}],
				currentPage: 0,
				targetLang: "th",
			};
			const res = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Validation failed");
			// Nothing was persisted: the page list stays empty (the new project's default).
			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.pages).toEqual([]);
		});

		test("POST /api/project/:id/save rejects negative layer sizes and oversized text", async () => {
			const { projectId } = await createProjectWithUploadedImage("Bad Size Save");
			const base = {
				projectId,
				name: "Bad Size Save",
				createdAt: new Date().toISOString(),
				currentPage: 0,
				targetLang: "th",
			};
			const negativeSize = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...base,
					pages: [{
						imageId: "p.webp",
						imageName: "p.webp",
						textLayers: [{ id: "t1", text: "x", x: 0, y: 0, w: -5, h: 40, rotation: 0, fontSize: 20, alignment: "center", index: 0 }],
						pendingAiJobs: [],
						coverRect: null,
					}],
				}),
			});
			expect(negativeSize.status).toBe(400);

			const hugeText = "A".repeat(20_001);
			const oversized = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...base,
					pages: [{
						imageId: "p.webp",
						imageName: "p.webp",
						textLayers: [{ id: "t1", text: hugeText, x: 0, y: 0, w: 100, h: 40, rotation: 0, fontSize: 20, alignment: "center", index: 0 }],
						pendingAiJobs: [],
						coverRect: null,
					}],
				}),
			});
			expect(oversized.status).toBe(400);
		});

		test("POST /api/project/:id/save tightens scalar ranges (opacity 0..1, non-negative integer page+layer index, bounded rotation)", async () => {
			const { projectId } = await createProjectWithUploadedImage("Scalar Range Save");
			const base = {
				projectId,
				name: "Scalar Range Save",
				createdAt: new Date().toISOString(),
				targetLang: "th",
			};
			const page = (overrides: Record<string, unknown> = {}) => ({
				imageId: "p.webp",
				imageName: "p.webp",
				textLayers: [{ id: "t1", text: "x", x: 0, y: 0, w: 100, h: 40, rotation: 0, fontSize: 20, alignment: "center", index: 0 }],
				pendingAiJobs: [],
				coverRect: null,
				...overrides,
			});
			const imageLayer = (overrides: Record<string, unknown> = {}) => ({
				id: "i1", imageId: "i.webp", imageName: "i.webp",
				x: 0, y: 0, w: 100, h: 40, rotation: 0, opacity: 1, index: 0, ...overrides,
			});
			const post = (body: unknown) => fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			// opacity out of [0,1] is rejected (it's an alpha multiplier).
			expect((await post({ ...base, currentPage: 0, pages: [page({ imageLayers: [imageLayer({ opacity: 2.0 })] })] })).status).toBe(400);
			expect((await post({ ...base, currentPage: 0, pages: [page({ imageLayers: [imageLayer({ opacity: -1 })] })] })).status).toBe(400);
			// opacity exactly 0.5 (and the boundaries 0 / 1) are accepted.
			expect((await post({ ...base, currentPage: 0, pages: [page({ imageLayers: [imageLayer({ opacity: 0.5 })] })] })).status).toBe(200);

			// Negative currentPage / non-integer currentPage rejected.
			expect((await post({ ...base, currentPage: -1, pages: [page()] })).status).toBe(400);
			expect((await post({ ...base, currentPage: 1.5, pages: [page()] })).status).toBe(400);

			// Negative / non-integer layer index rejected (both text and image layers).
			expect((await post({ ...base, currentPage: 0, pages: [page({ textLayers: [{ id: "t1", text: "x", x: 0, y: 0, w: 100, h: 40, rotation: 0, fontSize: 20, alignment: "center", index: -1 }] })] })).status).toBe(400);
			expect((await post({ ...base, currentPage: 0, pages: [page({ imageLayers: [imageLayer({ index: 0.5 })] })] })).status).toBe(400);

			// Rotation: any FINITE angle is accepted — the editor doesn't normalize/clamp
			// Fabric `angle`, so a large user-entered or accumulated rotation is real
			// serialized state and must NOT 400 (only NaN/Infinity are invalid, and those
			// can't appear in JSON). Normal + negative-un-normalized angles also accepted.
			expect((await post({ ...base, currentPage: 0, pages: [page({ imageLayers: [imageLayer({ rotation: 4000 })] })] })).status).toBe(200);
			expect((await post({ ...base, currentPage: 0, pages: [page({ imageLayers: [imageLayer({ rotation: 270.5 })] })] })).status).toBe(200);
			expect((await post({ ...base, currentPage: 0, pages: [page({ imageLayers: [imageLayer({ rotation: -45 })] })] })).status).toBe(200);

			// Per-language image-layer scalars are validated too (not just text): a bad
			// opacity on languageOutputs[lang].imageLayers is rejected.
			expect((await post({ ...base, currentPage: 0, pages: [page({ languageOutputs: { ja: { textLayers: [], imageLayers: [imageLayer({ opacity: 2 })] } } })] })).status).toBe(400);
		});

		test("POST /api/project/:id/save rejects an oversized UNKNOWN/additive field (bounded catchall)", async () => {
			const { projectId } = await createProjectWithUploadedImage("Bad Unknown Save");
			const base = {
				projectId,
				name: "Bad Unknown Save",
				createdAt: new Date().toISOString(),
				currentPage: 0,
				targetLang: "th",
			};
			// A key the schema does not model, carrying a multi-megabyte string. Before
			// the bounded `.catchall(...)` this slipped through the permissive `.loose()`
			// branch and was persisted verbatim (DoS / storage abuse, since the prod node
			// server runs with BODY_SIZE_LIMIT=Infinity).
			const hugeUnknown = "A".repeat(200_001);
			const res = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...base,
					someUnmodeledField: hugeUnknown,
					pages: [{
						imageId: "p.webp",
						imageName: "p.webp",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					}],
				}),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Validation failed");

			// A small additive unknown field is still accepted (no regression).
			const ok = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...base,
					someUnmodeledField: "small additive value",
					pages: [{
						imageId: "p.webp",
						imageName: "p.webp",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					}],
				}),
			});
			expect(ok.status).toBe(200);
		});

		test("POST /api/project/:id/save rejects an oversized ELEMENT inside a length-bounded array bucket", async () => {
			const { projectId } = await createProjectWithUploadedImage("Bad Array Element Save");
			const base = {
				projectId,
				name: "Bad Array Element Save",
				createdAt: new Date().toISOString(),
				currentPage: 0,
				targetLang: "th",
			};
			// `translationScriptSlots` / `textStylePresets` / `creditPresets` cap array
			// LENGTH, but each element used to be `z.unknown()` — so one element could
			// still be a multi-megabyte string. The bounded element schema now rejects it.
			const hugeElement = "A".repeat(200_001);
			const res = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...base,
					textStylePresets: [hugeElement],
					pages: [{
						imageId: "p.webp",
						imageName: "p.webp",
						textLayers: [],
						translationScriptSlots: [{ note: hugeElement }],
						pendingAiJobs: [],
						coverRect: null,
					}],
				}),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Validation failed");
		});

		test("POST /api/project/:id/save still accepts a rich, valid state (no regression)", async () => {
			const { projectId } = await createProjectWithUploadedImage("Rich Valid Save");
			const savedAt = "2026-05-22T08:00:00.000Z";
			const state = {
				projectId,
				name: "Rich Valid Save",
				createdAt: savedAt,
				readingDirection: "rtl",
				pages: [{
					imageId: "page-1.webp",
					imageName: "page-1.webp",
					originalName: "p-001.webp",
					textLayers: [{
						id: "typeset-1",
						name: "main",
						text: "ถึงเวลาลุยแล้ว",
						sourceText: "It is time.",
						sourceCategory: "dialogue",
						sourceProvider: "translation-slot:dialogue-main",
						confidence: 0.9,
						protected: false,
						x: 120,
						y: 240,
						w: 320,
						h: 90,
						rotation: 0,
						fontSize: 28,
						fontFamily: "Arial",
						fill: "#111111",
						stroke: "#ffffff",
						strokeWidth: 2,
						alignment: "center",
						visible: true,
						locked: false,
						index: 0,
						zIndex: 2,
						effects: { shadow: { blur: 3 } },
					}],
					translationScriptSlots: [{
						id: "dialogue-main",
						label: "main",
						x: 42,
						y: 31,
						category: "dialogue",
						sourceText: "It is time.",
						translatedText: "ถึงเวลาลุยแล้ว",
					}],
					translationHandoff: { status: "translated", updatedAt: savedAt },
					cleaningHandoff: { status: "clean_ready", updatedAt: savedAt },
					qcHandoff: { status: "ready", updatedAt: savedAt },
					languageOutputs: {
						en: { textLayers: [{ id: "en-1", text: "Hello", x: 0, y: 0, w: 100, h: 40, rotation: 0, fontSize: 24, alignment: "center", index: 0 }] },
					},
					imageLayers: [{
						id: "credit-layer",
						imageId: "credit.webp",
						imageName: "credit.webp",
						x: 40,
						y: 1200,
						w: 360,
						h: 96,
						rotation: 0,
						opacity: 0.92,
						visible: true,
						locked: false,
						index: 1,
						zIndex: 3,
						role: "credit",
						blendMode: "normal",
					}],
					edits: { imageId: "page-1-edited.webp" },
					pendingAiJobs: [],
					coverRect: { x: 0, y: 0, w: 800, h: 1200 },
				}],
				currentPage: 0,
				sourceLang: "ja",
				targetLang: "th",
				targetLangs: ["th", "en"],
				creditPolicy: "required",
				productionMode: "team",
			};
			const res = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});
			expect(res.status).toBe(200);
			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.pages[0].textLayers[0].text).toBe("ถึงเวลาลุยแล้ว");
			expect(loaded.pages[0].imageLayers[0].role).toBe("credit");
			expect(loaded.pages[0].languageOutputs.en.textLayers[0].text).toBe("Hello");
			expect(loaded.pages[0].coverRect).toEqual({ x: 0, y: 0, w: 800, h: 1200 });

			// Round-trip: re-saving the full normalized GET response (with the
			// server-owned arrays it now carries) must also pass validation.
			const resave = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(loaded),
			});
			expect(resave.status).toBe(200);
		});

		test("project save and restore identity preservation keeps workspace binding server-owned", async () => {
			const { preserveProjectIdentityFields } = await import("../routes/project.js");
			const workspacePayload: any = { projectId: "project-1", userId: "client-user", workspaceId: "workspace-client" };
			preserveProjectIdentityFields(workspacePayload, {
				projectId: "project-1",
				userId: "owner-user",
				workspaceId: "workspace-real",
			} as any);
			expect(workspacePayload.userId).toBe("owner-user");
			expect(workspacePayload.workspaceId).toBe("workspace-real");

			const personalPayload: any = { projectId: "project-2", userId: "client-user", workspaceId: "workspace-client" };
			preserveProjectIdentityFields(personalPayload, {
				projectId: "project-2",
				userId: "owner-user",
			} as any);
			expect(personalPayload.userId).toBe("owner-user");
			expect(personalPayload.workspaceId).toBeUndefined();
			expect("workspaceId" in personalPayload).toBe(false);
		});

		test("POST /api/project/:id/save preserves team script and handoff page state through load and restore", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Team Handoff Roundtrip", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const savedAt = "2026-05-22T08:00:00.000Z";
			const state = {
				projectId,
				name: "Team Handoff Roundtrip",
				createdAt: savedAt,
				pages: [{
					imageId: "page-1.webp",
					imageName: "page-1.webp",
					originalName: "p104-001.webp",
					textLayers: [{
						id: "typeset-slot-dialogue-main",
						name: "บทพูดหลัก",
						text: "ถึงเวลาลุยแล้ว",
						sourceText: "It is time.",
						sourceCategory: "dialogue",
						sourceProvider: "translation-slot:dialogue-main",
						x: 120,
						y: 240,
						w: 320,
						h: 90,
						rotation: 0,
						fontSize: 28,
						fontFamily: "Arial",
						fill: "#111111",
						alignment: "center",
						visible: true,
						locked: false,
						index: 0,
						zIndex: 2,
					}],
					translationScriptSlots: [{
						id: "dialogue-main",
						label: "บทพูดหลัก",
						x: 42,
						y: 31,
						category: "dialogue",
						sourceText: "It is time.",
						translatedText: "ถึงเวลาลุยแล้ว",
						note: "วางใกล้บอลลูนด้านบน",
						updatedAt: savedAt,
					}],
					translationHandoff: {
						status: "translated",
						updatedAt: savedAt,
						updatedBy: "translator-a",
						note: "ส่งสคริปต์แล้ว",
					},
					cleaningHandoff: {
						status: "clean_ready",
						updatedAt: savedAt,
						updatedBy: "cleaner-a",
						note: "คลีนเสร็จหน้าแรก ส่งให้ลงคำ",
						typesetRecheckStatus: "verified",
						typesetRecheckUpdatedAt: savedAt,
						typesetRecheckUpdatedBy: "qc-a",
					},
					qcHandoff: {
						status: "ready",
						updatedAt: savedAt,
						updatedBy: "qc-a",
						note: "ปิด QC แล้ว",
					},
					imageLayers: [{
						id: "credit-logo-layer",
						name: "เครดิตท้ายหน้า",
						imageId: "credit-logo.webp",
						imageName: "credit-logo.webp",
						x: 40,
						y: 1200,
						w: 360,
						h: 96,
						rotation: 0,
						opacity: 0.92,
						visible: true,
						locked: false,
						index: 1,
						zIndex: 3,
						role: "credit",
						blendMode: "normal",
					}],
					pendingAiJobs: [],
					coverRect: null,
				}],
				currentPage: 0,
				targetLang: "th",
				creditPolicy: "required",
			};

			const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});
			expect(saveRes.status).toBe(200);
			const saveBody = await saveRes.json();
			expect(saveBody.version.versionId).toBeDefined();

			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.pages[0].translationScriptSlots).toEqual(state.pages[0].translationScriptSlots);
			expect(loaded.pages[0].translationHandoff).toEqual(state.pages[0].translationHandoff);
			expect(loaded.pages[0].cleaningHandoff).toEqual(state.pages[0].cleaningHandoff);
			expect(loaded.pages[0].qcHandoff).toEqual(state.pages[0].qcHandoff);
			expect(loaded.creditPolicy).toBe("required");
			expect(loaded.pages[0].textLayers[0].sourceProvider).toBe("translation-slot:dialogue-main");
			expect(loaded.pages[0].textLayers[0].sourceCategory).toBe("dialogue");
			expect(loaded.pages[0].imageLayers[0].role).toBe("credit");
			expect(loaded.pages[0].imageLayers[0].blendMode).toBe("normal");

			const mutatedState = {
				...loaded,
				name: "Team Handoff Mutated",
				pages: [{
					...loaded.pages[0],
					translationScriptSlots: [],
					translationHandoff: {
						status: "needs_translation",
						updatedAt: "2026-05-22T09:00:00.000Z",
					},
					cleaningHandoff: {
						status: "needs_clean",
						updatedAt: "2026-05-22T09:00:00.000Z",
					},
					qcHandoff: {
						status: "needs_fix",
						updatedAt: "2026-05-22T09:00:00.000Z",
					},
					textLayers: [],
				}],
			};
			const mutateRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(mutatedState),
			});
			expect(mutateRes.status).toBe(200);

			const restoreRes = await fetch(`${BASE}/project/${projectId}/versions/${saveBody.version.versionId}/restore`, {
				method: "POST",
			});
			expect(restoreRes.status).toBe(200);
			const restored = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(restored.name).toBe("Team Handoff Roundtrip");
			expect(restored.pages[0].translationScriptSlots).toEqual(state.pages[0].translationScriptSlots);
			expect(restored.pages[0].translationHandoff).toEqual(state.pages[0].translationHandoff);
			expect(restored.pages[0].cleaningHandoff).toEqual(state.pages[0].cleaningHandoff);
			expect(restored.pages[0].qcHandoff).toEqual(state.pages[0].qcHandoff);
			expect(restored.creditPolicy).toBe("required");
			expect(restored.pages[0].textLayers[0].sourceProvider).toBe("translation-slot:dialogue-main");
		});

		test("POST /api/project/:id/save rejects stale base fingerprints", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			const res = await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-Fingerprint": "00000000",
				},
				body: JSON.stringify({
					...state,
					name: "Should Not Overwrite",
				}),
			});

			expect(res.status).toBe(409);
			const body = await res.json();
			expect(body.code).toBe("project_save_conflict");
			const loaded = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(loaded.name).toBe("Updated Name");
		});

		test("P0-2 (round-3): a PAGE-BEARING save WITHOUT x-project-base-fingerprint is rejected 428 even when x-edit-page-scoped is omitted (hostile-client path)", async () => {
			// Server-AUTHORITATIVE page-scope inference: a body that carries `pages` is
			// page-bearing regardless of the (untrusted) client `x-edit-page-scoped` marker.
			// With the prod baseline-required flag ON, such a save MUST carry a CAS baseline
			// fingerprint or it is rejected 428 — so a buggy/hostile client that omits BOTH
			// the marker and the fingerprint can no longer slip a stale full-payload clobber
			// past CAS (the save's own as-loaded hash always matches itself).
			const { serverConfig } = await import("../config.js");
			const { createProjectStateFingerprint } = await import("../routes/project.js");
			const prev = serverConfig.requireProjectBaselineHeaderEnabled;
			// Pin the anonymous-access posture this suite relies on for its duration: a
			// sibling test file may have flipped apiAuthRequired/allowLegacyAnonymousProjects
			// (cross-file config-cache pollution that already breaks other createProject*
			// tests in the full run), which would otherwise 401 the project-create below.
			const prevAuthRequired = serverConfig.apiAuthRequired;
			const prevAllowAnon = serverConfig.allowLegacyAnonymousProjects;
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				requireProjectBaselineHeaderEnabled: true,
				apiAuthRequired: false,
				allowLegacyAnonymousProjects: true,
			});
			try {
				const createRes = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Baseline Required", lang: "th", storyTitle: "Baseline Required Story" }),
				});
				const { projectId } = await createRes.json();
				const state = await (await fetch(`${BASE}/project/${projectId}`)).json();

				// Hostile/buggy path: full project-state body WITH pages, NO fingerprint header,
				// NO x-edit-page-scoped marker. Must be rejected 428 (server infers page scope).
				const noFingerprint = await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...state, pages: [], name: "Stale Clobber Attempt" }),
				});
				expect(noFingerprint.status).toBe(428);
				expect((await noFingerprint.json()).code).toBe("project_baseline_required");
				// The clobber did NOT land.
				const afterReject = await (await fetch(`${BASE}/project/${projectId}`)).json();
				expect(afterReject.name).toBe("Baseline Required");

				// A page-bearing save WITH a correct base fingerprint succeeds (CAS passes).
				const withFingerprint = await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Project-Base-Fingerprint": createProjectStateFingerprint(afterReject),
					},
					body: JSON.stringify({ ...afterReject, name: "Legit Save" }),
				});
				expect(withFingerprint.status).toBe(200);
				const afterSave = await (await fetch(`${BASE}/project/${projectId}`)).json();
				expect(afterSave.name).toBe("Legit Save");
			} finally {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					requireProjectBaselineHeaderEnabled: prev,
					apiAuthRequired: prevAuthRequired,
					allowLegacyAnonymousProjects: prevAllowAnon,
				});
			}
		});

		test("P1 (round-5): a cover/export full-payload save (pages + fingerprint, NO lease header, NO page-scoped marker) is NOT 428'd, while a page-edit save (pageScoped marker) without a lease header IS 428'd", async () => {
			// Round-5 regression: the lease-header (x-edit-lock-id) requirement now keys on
			// the CLIENT page-edit signal (x-edit-page-scoped === "1"), NOT on the mere
			// presence of `pages`. So a legit cover/export utility save — which sends a full
			// state body (with `pages`) + a base fingerprint but is NOT a page-edit session
			// (no marker, no lease) — must NOT be rejected `edit_lease_required`; CAS (the
			// fingerprint) protects it. An actual page-edit save (marker set) WITHOUT a lease
			// header must STILL be 428'd. A pages-payload WITHOUT a fingerprint must STILL be
			// rejected by the (independent) baseline gate. All three gates run under BOTH prod
			// flags ON with a real lock store + authenticated user (the only env in which the
			// lease-header gate engages at all).
			const { serverConfig } = await import("../config.js");
			const { createProjectStateFingerprint, __setWorkLockStoreForTesting } = await import("../routes/project.js");
			const { InMemoryWorkLockStore } = await import("../services/work-locks.js");
			const { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } = await import("../services/auth.service.js");
			const prevBaseline = serverConfig.requireProjectBaselineHeaderEnabled;
			const prevLease = serverConfig.requireEditLeaseHeaderEnabled;
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				requireProjectBaselineHeaderEnabled: true,
				requireEditLeaseHeaderEnabled: true,
			});
			__setWorkLockStoreForTesting(new InMemoryWorkLockStore());
			const owner = await createUser({
				email: `lease-gate-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Lease Gate Owner",
			});
			try {
				await markEmailVerified(owner.user.id);
				const ownerUser = await loadUser(owner.user.id);
				const ownerTokens = await generateTokens(ownerUser!);
				const authHeaders = { Authorization: `Bearer ${ownerTokens.accessToken}` };
				const createRes = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...authHeaders },
					body: JSON.stringify({ name: "Lease Gate Project", lang: "th" }),
				});
				expect(createRes.status).toBe(200);
				const { projectId } = await createRes.json();
				const state = await (await fetch(`${BASE}/project/${projectId}`, { headers: authHeaders })).json();

				// (1) Cover/export utility save: full body WITH `pages`, a correct base
				// fingerprint, NO x-edit-lock-id, NO x-edit-page-scoped marker → ALLOWED.
				const coverLikeSave = await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Project-Base-Fingerprint": createProjectStateFingerprint(state),
						...authHeaders,
					},
					body: JSON.stringify({ ...state, coverImageId: "cover-from-utility.png" }),
				});
				expect(coverLikeSave.status).toBe(200);
				const afterCover = await (await fetch(`${BASE}/project/${projectId}`, { headers: authHeaders })).json();
				expect(afterCover.coverImageId).toBe("cover-from-utility.png");

				// (2) Actual page-edit save: client marks x-edit-page-scoped=1 but OMITS the
				// lease header → STILL rejected 428 edit_lease_required.
				const pageEditNoLease = await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Project-Base-Fingerprint": createProjectStateFingerprint(afterCover),
						"X-Edit-Page-Scoped": "1",
						...authHeaders,
					},
					body: JSON.stringify({ ...afterCover, name: "Page Edit No Lease" }),
				});
				expect(pageEditNoLease.status).toBe(428);
				expect((await pageEditNoLease.json()).code).toBe("edit_lease_required");

				// (3) A pages-payload WITHOUT a base fingerprint is STILL rejected by the
				// independent baseline gate (payload-inferred), even with NO marker/lease.
				const noFingerprint = await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...authHeaders },
					body: JSON.stringify({ ...afterCover, name: "Stale Clobber" }),
				});
				expect(noFingerprint.status).toBe(428);
				expect((await noFingerprint.json()).code).toBe("project_baseline_required");

				// None of the rejected attempts mutated state — only the cover save landed.
				const final = await (await fetch(`${BASE}/project/${projectId}`, { headers: authHeaders })).json();
				expect(final.coverImageId).toBe("cover-from-utility.png");
				expect(final.name).not.toBe("Page Edit No Lease");
				expect(final.name).not.toBe("Stale Clobber");
			} finally {
				__setWorkLockStoreForTesting(null);
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					requireProjectBaselineHeaderEnabled: prevBaseline,
					requireEditLeaseHeaderEnabled: prevLease,
				});
				await deleteUser(owner.user.id);
			}
		});

		test("general save never drops a concurrent dedicated-endpoint comment (server-authoritative collections)", async () => {
			// Repro of the #270 follow-up data-loss race: a general save carries the
			// client's STALE full comments array. Because comments are excluded from
			// the save-conflict fingerprint (they have a dedicated endpoint), the save
			// would NOT conflict — and the old writer trusted `body.comments`, silently
			// overwriting a concurrent comment added via POST /comments. The writer is
			// now server-authoritative for these collections, so the new comment survives.
			const { projectId, imageId } = await createProjectWithUploadedImage("Comment Race");
			// Establish a page via the general save (uploading an image alone does not
			// create pages); this is the "open" baseline Tab A holds.
			const baseSave = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					projectId,
					name: "Comment Race",
					createdAt: new Date().toISOString(),
					currentPage: 0,
					targetLang: "th",
					pages: [{ imageId, imageName: imageId, textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null }],
				}),
			});
			expect(baseSave.status).toBe(200);
			const opened = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(opened.pages.length).toBeGreaterThan(0);

			// Tab A's view at open time: zero comments. (Its stale snapshot.)
			const staleComments: unknown[] = [];

			// Tab B adds a comment through the dedicated endpoint -> server now has [new].
			const commentRes = await fetch(`${BASE}/project/${projectId}/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pageIndex: 0, body: "Concurrent QC note" }),
			});
			expect(commentRes.status).toBe(200);
			const { comment: newComment } = await commentRes.json();
			expect(newComment.id).toBeDefined();

			// Tab A now does a general save (a text-layer edit) carrying its STALE
			// comments=[]. No base fingerprint is sent (or a stale one would 409); we
			// send none so we exercise the writer's collection handling directly.
			const editedPages = opened.pages.map((page: any, index: number) => (
				index === 0
					? {
						...page,
						textLayers: [{
							id: "tl-race-1",
							text: "เพิ่มข้อความ",
							x: 10,
							y: 10,
							w: 100,
							h: 40,
							rotation: 0,
							fontSize: 24,
							alignment: "center",
							index: 0,
						}],
					}
					: page
			));
			const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...opened,
					pages: editedPages,
					comments: staleComments,
				}),
			});
			expect(saveRes.status).toBe(200);

			// The text-layer edit persisted...
			const reloaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(reloaded.pages[0].textLayers.length).toBe(1);
			// ...AND the concurrent comment was NOT dropped by the stale general save.
			const reloadedComments = await (await fetch(`${BASE}/project/${projectId}/comments`)).json();
			expect(reloadedComments.comments.some((c: any) => c.id === newComment.id)).toBe(true);
		});

		test("dedicated mutation CAS: two concurrent same-baseline comment posts → one 200, one 409 (true compare-and-swap, not last-write-wins)", async () => {
			const { projectId } = await createProjectWithPage("CAS Comment Race");
			// Open: GET stamps the current full-state hash both tabs capture as baseline.
			const openRes = await fetch(`${BASE}/project/${projectId}`);
			expect(openRes.status).toBe(200);
			const baseHash = openRes.headers.get("x-project-state-hash");
			expect(baseHash).toBeTruthy();

			// Two requests built off the SAME baseline hash. Serialized by the
			// per-project mutation lock, the first commits; the second re-verifies the
			// (now-drifted) persisted hash inside the lock and is REJECTED — proving the
			// later write does not silently clobber the earlier one.
			const post = () => fetch(`${BASE}/project/${projectId}/comments`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-State-Hash": baseHash as string,
				},
				body: JSON.stringify({ pageIndex: 0, body: "first" }),
			});
			const [a, b] = await Promise.all([post(), post()]);
			const statuses = [a.status, b.status].sort();
			expect(statuses).toEqual([200, 409]);
			const conflictRes = a.status === 409 ? a : b;
			expect((await conflictRes.json()).code).toBe("project_save_conflict");

			// Exactly ONE comment persisted (the loser did NOT overwrite).
			const after = await (await fetch(`${BASE}/project/${projectId}/comments`)).json();
			expect(after.comments.length).toBe(1);
		});

		test("dedicated mutation CAS: a STALE baseline hash 409s even without concurrency", async () => {
			const { projectId } = await createProjectWithPage("CAS Stale Baseline");
			const res = await fetch(`${BASE}/project/${projectId}/comments`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-State-Hash": "deadbeef-not-the-current-hash",
				},
				body: JSON.stringify({ pageIndex: 0, body: "stale" }),
			});
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("project_save_conflict");
		});

		test("dedicated mutation CAS back-compat: a request that OMITS the baseline header still succeeds (single-writer unchanged)", async () => {
			const { projectId } = await createProjectWithPage("CAS No Header");
			const res = await fetch(`${BASE}/project/${projectId}/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pageIndex: 0, body: "no header" }),
			});
			expect(res.status).toBe(200);
			// The successful mutation stamps the FRESH hash for the next mutation.
			expect(res.headers.get("x-project-state-hash")).toBeTruthy();
		});

		test("POST /api/project/:id/save byte-cap rejects a multi-byte payload that exceeds the BYTE limit (not just code-unit length)", async () => {
			const { serverConfig } = await import("../config.js");
			const { projectId } = await createProjectWithUploadedImage("Byte Cap Save");
			// The earlier requestSizeGuard caps JSON bodies at maxJsonBodySizeBytes (1MiB
			// default); raise it ABOVE MAX_SAVE_BODY_BYTES (64MiB) so the save route's OWN
			// byte-cap is the guard under test (prod can run an effectively-uncapped JSON
			// limit, which is exactly why the route has its own cap).
			const prevJsonLimit = serverConfig.maxJsonBodySizeBytes;
			(serverConfig as unknown as Record<string, unknown>).maxJsonBodySizeBytes = 256 * 1024 * 1024;
			try {
				// Each "界" is 1 UTF-16 code unit but 3 UTF-8 bytes. 22.4M chars → code-unit
				// length 22.4M (< the 67,108,864 code-unit value of a 64MiB string) but a
				// UTF-8 byte length of ~67.2MB (> MAX_SAVE_BODY_BYTES = 64MiB). A string-
				// length (`rawBody.length`) check would WRONGLY pass; the byte-length check
				// correctly rejects with 413.
				const multiByte = "界".repeat(22_400_000);
				const res = await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						projectId,
						name: multiByte,
						createdAt: new Date().toISOString(),
						currentPage: 0,
						targetLang: "th",
						pages: [],
					}),
				});
				expect(res.status).toBe(413);
				expect((await res.json()).code).toBe("payload_too_large");
			} finally {
				(serverConfig as unknown as Record<string, unknown>).maxJsonBodySizeBytes = prevJsonLimit;
			}
		});

		test("general save remaps page-linked collections server-side on a page reorder", async () => {
			// The general save treats tasks/comments/markers as server-authoritative,
			// but the ONE legit way a general save mutates them is a page reorder. The
			// backend must remap the persisted collections from the new page order
			// itself (not trust the client's arrays). Verify a comment + a human-set
			// task follow their page when the client reorders pages and saves.
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Reorder Remap", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const pngBuffer = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			);
			const uploadImage = async (name: string): Promise<string> => {
				const form = new FormData();
				form.append("images", new Blob([pngBuffer], { type: "image/png" }), `${name}.png`);
				const up = await (await fetch(`${BASE}/images/${projectId}/upload`, { method: "POST", body: form })).json();
				return up.imageIds[0];
			};
			const imageA = await uploadImage("reorder-a");
			const imageB = await uploadImage("reorder-b");

			// Two-page project: a@0, b@1, each with a text layer so review tasks exist.
			const baseState = {
				projectId,
				name: "Reorder Remap",
				createdAt: new Date().toISOString(),
				currentPage: 0,
				targetLang: "th",
				pages: [
					{ imageId: imageA, imageName: imageA, textLayers: [{ id: "a-tl", text: "หน้าเอ", x: 0, y: 0, w: 50, h: 20, rotation: 0, fontSize: 20, alignment: "center", index: 0 }], imageLayers: [], pendingAiJobs: [], coverRect: null },
					{ imageId: imageB, imageName: imageB, textLayers: [{ id: "b-tl", text: "หน้าบี", x: 0, y: 0, w: 50, h: 20, rotation: 0, fontSize: 20, alignment: "center", index: 0 }], imageLayers: [], pendingAiJobs: [], coverRect: null },
				],
			};
			expect((await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(baseState),
			})).status).toBe(200);

			// Dedicated endpoints add a comment on page 0 (a) and assign the page-1 (b)
			// translate task to a human (so it carries non-default state worth keeping).
			expect((await fetch(`${BASE}/project/${projectId}/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pageIndex: 0, body: "Note on page A" }),
			})).status).toBe(200);
			const taskRes = await fetch(`${BASE}/project/${projectId}/tasks/page-1-translate`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "doing" }),
			});
			expect(taskRes.status).toBe(200);

			// Client reorders pages (move a from index 0 to index 1) and general-saves
			// the new page order. The body carries no/stale collections.
			const beforeReorder = await (await fetch(`${BASE}/project/${projectId}`)).json();
			const reordered = { ...beforeReorder, pages: [beforeReorder.pages[1], beforeReorder.pages[0]] };
			expect((await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(reordered),
			})).status).toBe(200);

			// Page A is now index 1: its comment must follow to pageIndex 1.
			const afterComments = await (await fetch(`${BASE}/project/${projectId}/comments`)).json();
			const noteA = afterComments.comments.find((c: any) => c.body === "Note on page A");
			expect(noteA).toBeDefined();
			expect(noteA.pageIndex).toBe(1);

			// Page B is now index 0: the human-set translate task must follow, keeping
			// its "doing" status under the new id page-0-translate.
			const afterState = await (await fetch(`${BASE}/project/${projectId}`)).json();
			const movedTask = afterState.tasks.find((t: any) => t.id === "page-0-translate");
			expect(movedTask).toBeDefined();
			expect(movedTask.status).toBe("doing");
			expect(movedTask.title).toBe("Translate page 1");
			// The stale id must not survive.
			expect(afterState.tasks.some((t: any) => t.id === "page-1-translate" && t.status === "doing")).toBe(false);
		});

		test("authenticated viewers can read but cannot mutate owned projects", async () => {
			const { createUser, deleteUser, generateTokens, loadUser, updateUser, markEmailVerified } = await import("../services/auth.service.js");
			const created = await createUser({
				email: `viewer-mutation-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Viewer Mutation",
			});
			try {
				// Project creation now requires a verified email; confirm it so the test
				// exercises the role/ownership guard rather than the verification gate.
				await markEmailVerified(created.user.id);
				const editorUser = await loadUser(created.user.id);
				expect(editorUser).toBeTruthy();
				const editorTokens = await generateTokens(editorUser!);
				const createRes = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${editorTokens.accessToken}`,
					},
					body: JSON.stringify({ name: "Viewer Guard", lang: "th" }),
				});
				expect(createRes.status).toBe(200);
				const { projectId } = await createRes.json();
				await updateUser(created.user.id, { role: "viewer" });

				const readRes = await fetch(`${BASE}/project/${projectId}`, {
					headers: { Authorization: `Bearer ${editorTokens.accessToken}` },
				});
				expect(readRes.status).toBe(200);
				const state = await readRes.json();
				state.name = "Viewer Should Not Save";

				const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${editorTokens.accessToken}`,
					},
					body: JSON.stringify(state),
				});
				expect(saveRes.status).toBe(403);
				expect(await saveRes.json()).toEqual(expect.objectContaining({
					error: "Forbidden: Missing permission 'update:project'",
				}));
			} finally {
				await deleteUser(created.user.id);
			}
		});

		test("POST /api/project/:id/versions creates a named snapshot with label + author", async () => {
			const { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } = await import("../services/auth.service.js");
			const owner = await createUser({
				email: `named-version-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Named Version Owner",
			});
			try {
				await markEmailVerified(owner.user.id);
				const ownerUser = await loadUser(owner.user.id);
				const ownerTokens = await generateTokens(ownerUser!);
				const createRes = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokens.accessToken}` },
					body: JSON.stringify({ name: "Named Version Project", lang: "th" }),
				});
				expect(createRes.status).toBe(200);
				const { projectId } = await createRes.json();

				// Two named versions of byte-identical state must BOTH be created
				// (no stateHash dedupe for manual snapshots).
				const firstNamed = await fetch(`${BASE}/project/${projectId}/versions`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokens.accessToken}` },
					body: JSON.stringify({ label: "Before QC pass" }),
				});
				expect(firstNamed.status).toBe(200);
				const firstBody = await firstNamed.json();
				expect(firstBody.version.source).toBe("manual");
				expect(firstBody.version.label).toBe("Before QC pass");
				expect(firstBody.version.author).toBe(ownerUser!.email);

				const secondNamed = await fetch(`${BASE}/project/${projectId}/versions`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokens.accessToken}` },
					body: JSON.stringify({ label: "After QC pass" }),
				});
				expect(secondNamed.status).toBe(200);
				const secondBody = await secondNamed.json();
				expect(secondBody.version.versionId).not.toBe(firstBody.version.versionId);

				// Both named versions appear in the list with label + author preserved.
				const listed = await (await fetch(`${BASE}/project/${projectId}/versions`, {
					headers: { Authorization: `Bearer ${ownerTokens.accessToken}` },
				})).json();
				const labels = listed.versions
					.filter((version: any) => version.source === "manual")
					.map((version: any) => version.label);
				expect(labels).toContain("Before QC pass");
				expect(labels).toContain("After QC pass");

				// Validation: empty label is rejected.
				const badLabel = await fetch(`${BASE}/project/${projectId}/versions`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokens.accessToken}` },
					body: JSON.stringify({ label: "   " }),
				});
				expect(badLabel.status).toBe(400);

				// Authz: an unrelated authenticated user cannot create a version on a
				// project they do not own. Personal (userId-owned) projects return 404
				// rather than 403 so project existence is not leaked.
				const intruder = await createUser({
					email: `named-version-intruder-${crypto.randomUUID()}@example.com`,
					password: "StrongP@ss123",
					name: "Intruder",
				});
				try {
					const intruderUser = await loadUser(intruder.user.id);
					const intruderTokens = await generateTokens(intruderUser!);
					const denied = await fetch(`${BASE}/project/${projectId}/versions`, {
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: `Bearer ${intruderTokens.accessToken}` },
						body: JSON.stringify({ label: "Sneaky" }),
					});
					expect(denied.status).toBe(404);

					// Anonymous requests are rejected as well.
					const anon = await fetch(`${BASE}/project/${projectId}/versions`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ label: "Anon" }),
					});
					expect(anon.status).toBe(401);
				} finally {
					await deleteUser(intruder.user.id);
				}
			} finally {
				await deleteUser(owner.user.id);
			}
		});

		test("a failed new-version commit never prunes existing history (durable-then-prune ordering)", async () => {
			const { setProjectVersionRecordFailureForTests } = await import("../routes/project.js");
			const { projectId } = await createProjectWithUploadedImage("Prune Ordering Safety");

			// Seed > MAX_PROJECT_VERSIONS (50) prunable autosave version files directly
			// on disk so the next createProjectVersion would normally prune the oldest.
			const versionsDir = join(serverProjectsDir, projectId, "versions");
			mkdirSync(versionsDir, { recursive: true });
			const seededIds: string[] = [];
			for (let i = 0; i < 55; i++) {
				const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
				const versionId = `${createdAt.replace(/[:.]/g, "-")}_seed${String(i).padStart(3, "0")}`;
				seededIds.push(versionId);
				const metadata = {
					versionId,
					projectId,
					name: "seed",
					source: "save",
					createdAt,
					pageCount: 0,
					textLayerCount: 0,
				};
				writeFileSync(
					join(versionsDir, `${versionId}.json`),
					JSON.stringify({ metadata, state: { projectId, name: "seed", pages: [], currentPage: 0, targetLang: "th" } }),
				);
			}
			expect(seededIds.every((id) => existsSync(join(versionsDir, `${id}.json`)))).toBe(true);

			// Force the NEW version's durable catalog commit to throw — simulating a
			// failure mid-commit. The prune MUST NOT have run (it is ordered AFTER the
			// durable commit), so every seeded version survives.
			setProjectVersionRecordFailureForTests(() => {
				throw new Error("simulated new-version commit failure");
			});
			try {
				await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						projectId,
						name: "Prune Ordering Safety",
						createdAt: new Date().toISOString(),
						pages: [],
						currentPage: 0,
						targetLang: "th",
					}),
				});
			} finally {
				setProjectVersionRecordFailureForTests(null);
			}

			// History is intact: not a single seeded version was deleted.
			const survivors = seededIds.filter((id) => existsSync(join(versionsDir, `${id}.json`)));
			expect(survivors.length).toBe(seededIds.length);
		});

		test("project versions list and restore saved states", async () => {
			const firstVersions = await (await fetch(`${BASE}/project/${testProjectId}/versions`)).json();
			const updatedVersion = firstVersions.versions.find((version: any) => version.name === "Updated Name");
			expect(updatedVersion?.versionId).toBeDefined();

			const nextState = {
				projectId: testProjectId,
				name: "Version Target",
				createdAt: new Date().toISOString(),
				pages: [{
					imageId: "img-version",
					imageName: "version.png",
					textLayers: [{
						id: "layer-1",
						text: "Version layer",
						x: 10,
						y: 10,
						w: 120,
						h: 40,
						rotation: 0,
						fontSize: 16,
						alignment: "center",
						index: 0,
					}],
					pendingAiJobs: [],
					coverRect: null,
				}],
				currentPage: 0,
				targetLang: "ja",
			};
			const saveRes = await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(nextState),
			});
			expect(saveRes.status).toBe(200);

			const versionsAfterSave = await (await fetch(`${BASE}/project/${testProjectId}/versions`)).json();
			const firstVersionPage = await (await fetch(`${BASE}/project/${testProjectId}/versions?limit=1`)).json();
			expect(firstVersionPage.versions).toHaveLength(1);
			expect(firstVersionPage.nextCursor).toBeDefined();
			const secondVersionPage = await (await fetch(`${BASE}/project/${testProjectId}/versions?limit=1&cursor=${encodeURIComponent(firstVersionPage.nextCursor)}`)).json();
			expect(secondVersionPage.versions).toHaveLength(1);
			expect(secondVersionPage.versions[0].versionId).not.toBe(firstVersionPage.versions[0].versionId);
			const invalidVersionPage = await fetch(`${BASE}/project/${testProjectId}/versions?limit=0`);
			expect(invalidVersionPage.status).toBe(400);
			const invalidVersionCursorPage = await fetch(`${BASE}/project/${testProjectId}/versions?cursor=not-a-valid-cursor`);
			expect(invalidVersionCursorPage.status).toBe(400);

			const duplicateSaveRes = await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(nextState),
			});
			expect(duplicateSaveRes.status).toBe(200);
			const versionsAfterDuplicate = await (await fetch(`${BASE}/project/${testProjectId}/versions`)).json();
			expect(versionsAfterDuplicate.versions.length).toBe(versionsAfterSave.versions.length);

			const workflowRes = await fetch(`${BASE}/project/${testProjectId}/workflow`);
			expect(workflowRes.status).toBe(200);
			const workflow = await workflowRes.json();
			expect(workflow.tasks).toHaveLength(4);
			expect(workflow.tasks[0].status).toBe("todo");
			expect(workflow.tasks[0].priority).toBe("normal");

			const taskUpdateRes = await fetch(`${BASE}/project/${testProjectId}/tasks/${workflow.tasks[0].id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "doing" }),
			});
			expect(taskUpdateRes.status).toBe(200);
			const taskUpdate = await taskUpdateRes.json();
			expect(taskUpdate.task.status).toBe("doing");
			expect(taskUpdate.activityLog[0].type).toBe("task_updated");

			const assigneeUpdateRes = await fetch(`${BASE}/project/${testProjectId}/tasks/${workflow.tasks[0].id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ assignee: "@@typesetter-a" }),
			});
			expect(assigneeUpdateRes.status).toBe(200);
			const assigneeUpdate = await assigneeUpdateRes.json();
			expect(assigneeUpdate.task.assignee).toBe("typesetter-a");
			expect(assigneeUpdate.activityLog[0].message).toContain("assignee unassigned -> @typesetter-a");

			const priorityUpdateRes = await fetch(`${BASE}/project/${testProjectId}/tasks/${workflow.tasks[0].id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priority: "urgent" }),
			});
			expect(priorityUpdateRes.status).toBe(200);
			const priorityUpdate = await priorityUpdateRes.json();
			expect(priorityUpdate.task.priority).toBe("urgent");
			expect(priorityUpdate.activityLog[0].message).toContain("priority normal -> urgent");

			const dueAt = "2026-05-14T09:15:00.000Z";
			const dueUpdateRes = await fetch(`${BASE}/project/${testProjectId}/tasks/${workflow.tasks[0].id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ dueAt }),
			});
			expect(dueUpdateRes.status).toBe(200);
			const dueUpdate = await dueUpdateRes.json();
			expect(dueUpdate.task.dueAt).toBe(dueAt);
			expect(dueUpdate.activityLog[0].message).toContain("due unset -> 2026-05-14T09:15:00.000Z");
			expect(dueUpdate.activityLog[0].metadata.dueAt).toBe(dueAt);

			const invalidDueRes = await fetch(`${BASE}/project/${testProjectId}/tasks/${workflow.tasks[0].id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ dueAt: "not-a-date" }),
			});
			expect(invalidDueRes.status).toBe(400);

			const bulkDueAt = "2026-05-15T10:30:00.000Z";
			const bulkPriorityRes = await fetch(`${BASE}/project/${testProjectId}/tasks/bulk`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					taskIds: [workflow.tasks[1].id, workflow.tasks[2].id, "missing-task"],
					priority: "high",
					assignee: "@@bulk-owner",
					dueAt: bulkDueAt,
				}),
			});
			expect(bulkPriorityRes.status).toBe(200);
			const bulkPriority = await bulkPriorityRes.json();
			expect(bulkPriority.changedCount).toBe(2);
			expect(bulkPriority.missingTaskIds).toEqual(["missing-task"]);
			expect(bulkPriority.tasks.map((task: any) => task.priority)).toEqual(["high", "high"]);
			expect(bulkPriority.tasks.map((task: any) => task.dueAt)).toEqual([bulkDueAt, bulkDueAt]);
			expect(bulkPriority.tasks.map((task: any) => task.assignee)).toEqual(["bulk-owner", "bulk-owner"]);
			expect(bulkPriority.activityLog[0].message).toContain("Batch updated 2 tasks");
			expect(bulkPriority.activityLog[0].message).toContain("assignee @bulk-owner");

			const reviewDecisionRes = await fetch(`${BASE}/project/${testProjectId}/review-decisions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pageIndex: 0,
					status: "changes_requested",
					body: "Fix redraw before approval",
				}),
			});
			expect(reviewDecisionRes.status).toBe(200);
			const reviewDecision = await reviewDecisionRes.json();
			expect(reviewDecision.decision.status).toBe("changes_requested");
			expect(reviewDecision.decisions[0].body).toBe("Fix redraw before approval");
			expect(reviewDecision.tasks.find((task: any) => task.type === "review" && task.pageIndex === 0).status).toBe("review");
			expect(reviewDecision.activityLog[0].type).toBe("review_decision_added");

			const workspaceMessageRes = await fetch(`${BASE}/project/${testProjectId}/workspace-messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pageIndex: 0,
					body: "Ready for review @reviewer",
				}),
			});
			expect(workspaceMessageRes.status).toBe(200);
			const workspaceMessage = await workspaceMessageRes.json();
			expect(workspaceMessage.message.mentions).toEqual(["reviewer"]);
			expect(workspaceMessage.items.some((item: any) => item.kind === "message")).toBe(true);
			expect(workspaceMessage.activityLog[0].type).toBe("workspace_message_added");

			const commentCreateRes = await fetch(`${BASE}/project/${testProjectId}/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pageIndex: 0,
					body: "Check redraw edge @reviewer @qa-team",
					region: { x: 10, y: 20, w: 30, h: 40 },
				}),
			});
			expect(commentCreateRes.status).toBe(200);
			const commentCreate = await commentCreateRes.json();
			expect(commentCreate.comment.body).toBe("Check redraw edge @reviewer @qa-team");
			expect(commentCreate.comment.region).toEqual({ x: 10, y: 20, w: 30, h: 40 });
			expect(commentCreate.comment.mentions).toEqual(["reviewer", "qa-team"]);
			expect(commentCreate.activityLog[0].type).toBe("comment_added");
			expect(commentCreate.activityLog[0].metadata.mentions).toEqual(["reviewer", "qa-team"]);

			const commentResolveRes = await fetch(`${BASE}/project/${testProjectId}/comments/${commentCreate.comment.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "resolved" }),
			});
			expect(commentResolveRes.status).toBe(200);
			const commentResolve = await commentResolveRes.json();
			expect(commentResolve.comment.status).toBe("resolved");
			expect(commentResolve.activityLog[0].type).toBe("comment_resolved");

			await seedMarkerJob("job-review-1", testProjectId);
			const markerCreateRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-review-1",
					pageIndex: 0,
					imageId: "img-version",
					region: { x: 10, y: 20, w: 120, h: 80 },
					status: "needs_review",
					tier: "clean-pro",
					providerHint: "gemini-3.1-flash-image-preview",
					prompt: "Clean selected area",
					customPrompt: "Keep screentone texture",
					textLayers: ["SFX: BANG", "Narration: hurry"],
					translateSfx: false,
					costEstimate: {
						tier: "clean-pro",
						providerHint: "gemini-3.1-flash-image-preview",
						currency: "THB",
						megapixels: 0.01,
						estimatedThb: 2.3,
						reserveThb: 2.65,
						pricingVersion: "prototype-test",
					},
				}),
			});
			expect(markerCreateRes.status).toBe(200);
			const markerCreate = await markerCreateRes.json();
			expect(markerCreate.marker.status).toBe("needs_review");
			expect(markerCreate.marker.customPrompt).toBe("Keep screentone texture");
			expect(markerCreate.marker.textLayers).toEqual(["SFX: BANG", "Narration: hurry"]);
			expect(markerCreate.marker.translateSfx).toBe(false);
			expect(markerCreate.marker.linkedTaskIds).toContain("page-0-review");
			expect(markerCreate.tasks.find((task: any) => task.id === "page-0-review")?.status).toBe("review");
			expect(markerCreate.tasks.find((task: any) => task.id === "page-0-review")?.priority).toBe("high");
			expect(markerCreate.activityLog[0].type).toBe("ai_marker_created");

			const markerUpdateRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${markerCreate.marker.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "accepted" }),
			});
			expect(markerUpdateRes.status).toBe(200);
			const markerUpdate = await markerUpdateRes.json();
			expect(markerUpdate.marker.status).toBe("accepted");
			// Authz mass-assignment guard: `costEstimate` is server-owned (derived from
			// the AI job), NOT client-settable. The forged value in the create body is
			// stripped, so it must never round-trip onto the persisted marker.
			expect(markerUpdate.marker.costEstimate).toBeUndefined();
			expect(markerUpdate.marker.customPrompt).toBe("Keep screentone texture");
			expect(markerUpdate.marker.textLayers).toEqual(["SFX: BANG", "Narration: hurry"]);
			expect(markerUpdate.marker.translateSfx).toBe(false);
			expect(markerUpdate.activityLog[0].type).toBe("ai_marker_updated");

			const staleMarkerId = "marker-stale-image";
			const missingPageMarkerId = "marker-missing-page";
			const stateBeforeStaleRefs = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			stateBeforeStaleRefs.aiReviewMarkers = [
				...(stateBeforeStaleRefs.aiReviewMarkers ?? []),
				{
					id: staleMarkerId,
					jobId: "job-stale-image",
					pageIndex: 0,
					imageId: "old-page-image",
					region: { x: 10, y: 20, w: 120, h: 80 },
					status: "needs_review",
					tier: "clean-pro",
					resultImageId: "result-stale-image",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				{
					id: missingPageMarkerId,
					jobId: "job-missing-page",
					pageIndex: 99,
					imageId: "img-version",
					region: { x: 10, y: 20, w: 120, h: 80 },
					status: "accepted",
					tier: "clean-pro",
					resultImageId: "result-missing-page",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			];
			// Seed the synthetic stale/missing-page markers on disk directly: the
			// general `/save` is server-authoritative for aiReviewMarkers (it keeps its
			// persisted copy and ignores the body's, so a stale save can't clobber a
			// concurrent dedicated-endpoint change), so we can't seed markers through it.
			const { PROJECTS_DIR: staleProjectsDir } = await import("../config.js");
			const staleStatePath = join(staleProjectsDir, testProjectId, "state.json");
			writeFileSync(staleStatePath, JSON.stringify(stateBeforeStaleRefs, null, 2));

			const staleAcceptRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${staleMarkerId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "accepted" }),
			});
			expect(staleAcceptRes.status).toBe(409);
			const staleAccept = await staleAcceptRes.json();
			expect(staleAccept.error).toBe("AI marker source is stale");
			expect(staleAccept.message).toContain("old-page-image");

			const missingPageApplyRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${missingPageMarkerId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "applied" }),
			});
			expect(missingPageApplyRes.status).toBe(409);
			const missingPageApply = await missingPageApplyRes.json();
			expect(missingPageApply.message).toContain("missing page 100");

			const markerAssignRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${markerCreate.marker.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ assignee: "@reviewer-a" }),
			});
			expect(markerAssignRes.status).toBe(200);
			const markerAssign = await markerAssignRes.json();
			expect(markerAssign.marker.assignee).toBe("reviewer-a");

			const markerRepairLinksRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${markerCreate.marker.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					status: markerAssign.marker.status,
					linkedCommentIds: ["comment-live"],
					linkedTaskIds: ["task-live"],
				}),
			});
			expect(markerRepairLinksRes.status).toBe(200);
			const markerRepairLinks = await markerRepairLinksRes.json();
			expect(markerRepairLinks.marker.linkedCommentIds).toEqual(["comment-live"]);
			expect(markerRepairLinks.marker.linkedTaskIds).toEqual(["task-live"]);

			const markerCommentRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${markerCreate.marker.id}/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: "AI edge needs redraw QA" }),
			});
			expect(markerCommentRes.status).toBe(200);
			const markerComment = await markerCommentRes.json();
			expect(markerComment.comment.body).toBe("AI edge needs redraw QA");
			expect(markerComment.marker.linkedCommentIds).toContain(markerComment.comment.id);
			expect(markerComment.activityLog[0].type).toBe("ai_marker_updated");

			const markerTaskRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${markerCreate.marker.id}/review-task`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ assignee: "@@reviewer-a" }),
			});
			expect(markerTaskRes.status).toBe(200);
			const markerTask = await markerTaskRes.json();
			expect(markerTask.task.type).toBe("review");
			expect(markerTask.task.status).toBe("review");
			expect(markerTask.task.assignee).toBe("reviewer-a");
			expect(markerTask.marker.linkedTaskIds).toContain(markerTask.task.id);
			expect(markerTask.activityLog.find((event: any) => event.type === "task_updated")?.message).toContain("assigned @reviewer-a");

			const detailRes = await fetch(`${BASE}/project/${testProjectId}/versions/${updatedVersion.versionId}`);
			expect(detailRes.status).toBe(200);
			const detail = await detailRes.json();
			expect(detail.version.versionId).toBe(updatedVersion.versionId);
			expect(detail.diff.current.pageCount).toBe(1);
			expect(detail.diff.snapshot.pageCount).toBe(0);
			expect(detail.diff.changedPageCount).toBe(1);

			const versionReviewRes = await fetch(`${BASE}/project/${testProjectId}/versions/${updatedVersion.versionId}/reviews`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: "Review this version @lead" }),
			});
			expect(versionReviewRes.status).toBe(200);
			const versionReview = await versionReviewRes.json();
			expect(versionReview.review.status).toBe("open");
			expect(versionReview.review.mentions).toEqual(["lead"]);
			expect(versionReview.activityLog[0].type).toBe("version_review_requested");
			expect(versionReview.items.some((item: any) => item.kind === "version_review")).toBe(true);

			const versionReviewUpdateRes = await fetch(`${BASE}/project/${testProjectId}/versions/${updatedVersion.versionId}/reviews/${versionReview.review.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "approved", body: "Approved for handoff" }),
			});
			expect(versionReviewUpdateRes.status).toBe(200);
			const versionReviewUpdate = await versionReviewUpdateRes.json();
			expect(versionReviewUpdate.review.status).toBe("approved");
			expect(versionReviewUpdate.activityLog[0].type).toBe("version_review_updated");

			const restoreRes = await fetch(`${BASE}/project/${testProjectId}/versions/${updatedVersion.versionId}/restore`, {
				method: "POST",
			});
			expect(restoreRes.status).toBe(200);

			const restored = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(restored.name).toBe("Updated Name");
			expect(restored.targetLang).toBe("en");
		}, 30_000);

		test("W3.9: version compare + selective per-page/layer restore", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Diff target", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const now = new Date().toISOString();

			const baseLayer = {
				id: "layer-keep",
				text: "keep me",
				x: 10, y: 10, w: 120, h: 40,
				rotation: 0, fontSize: 16, alignment: "center", index: 0,
			};
			const stateA = {
				projectId,
				name: "Diff target",
				createdAt: now,
				targetLang: "th",
				currentPage: 0,
				pages: [
					{
						imageId: "img-a-0",
						imageName: "a0.png",
						textLayers: [
							{ ...baseLayer },
							{ ...baseLayer, id: "layer-edit", text: "OLD TEXT", x: 20 },
						],
						pendingAiJobs: [],
						coverRect: null,
					},
					{
						imageId: "img-a-1",
						imageName: "a1.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					},
				],
			};
			const saveA = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(stateA),
			});
			expect(saveA.status).toBe(200);
			const versionsAfterA = await (await fetch(`${BASE}/project/${projectId}/versions`)).json();
			const versionA = versionsAfterA.versions[0];
			expect(versionA?.versionId).toBeDefined();

			// State B edits a layer on page 0 and changes page 1's image.
			const stateB = {
				...stateA,
				pages: [
					{
						...stateA.pages[0],
						textLayers: [
							{ ...baseLayer },
							{ ...baseLayer, id: "layer-edit", text: "NEW TEXT", x: 80 },
						],
					},
					{ ...stateA.pages[1], imageId: "img-b-1" },
				],
			};
			const saveB = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(stateB),
			});
			expect(saveB.status).toBe(200);

			// Compare version A against itself → no changed pages.
			const compareRes = await fetch(`${BASE}/project/${projectId}/versions/compare?base=${versionA.versionId}&target=${versionA.versionId}`);
			expect(compareRes.status).toBe(200);
			const sameDiff = await compareRes.json();
			expect(sameDiff.diff.changedPageCount).toBe(0);

			// Validation: target is required.
			const missingTarget = await fetch(`${BASE}/project/${projectId}/versions/compare`);
			expect(missingTarget.status).toBe(400);
			// Unknown target → 404, not captured as a versionId by the param route.
			const badTarget = await fetch(`${BASE}/project/${projectId}/versions/compare?target=2099-01-01T00-00-00-000Z_deadbeef`);
			expect(badTarget.status).toBe(404);

			// Selective restore: revert ONLY layer-edit on page 0 to version A.
			const layerRestore = await fetch(`${BASE}/project/${projectId}/versions/${versionA.versionId}/restore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pageIndex: 0, layerId: "layer-edit" }),
			});
			expect(layerRestore.status).toBe(200);
			const layerRestoreBody = await layerRestore.json();
			expect(layerRestoreBody.scope).toBe("layer");
			expect(layerRestoreBody.restoredLayerKind).toBe("text");

			const afterLayer = await (await fetch(`${BASE}/project/${projectId}`)).json();
			// layer-edit reverted, sibling untouched, page 1 image kept current.
			const p0 = afterLayer.pages[0].textLayers;
			expect(p0.find((l: any) => l.id === "layer-edit").text).toBe("OLD TEXT");
			expect(p0.find((l: any) => l.id === "layer-keep").text).toBe("keep me");
			expect(afterLayer.pages[1].imageId).toBe("img-b-1");

			// Selective restore: revert ONLY page 1 to version A image.
			const pageRestore = await fetch(`${BASE}/project/${projectId}/versions/${versionA.versionId}/restore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pageIndex: 1 }),
			});
			expect(pageRestore.status).toBe(200);
			expect((await pageRestore.json()).scope).toBe("page");
			const afterPage = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(afterPage.pages[1].imageId).toBe("img-a-1");
			// page 0 still has the previously layer-restored value (no data loss).
			expect(afterPage.pages[0].textLayers.find((l: any) => l.id === "layer-edit").text).toBe("OLD TEXT");

			// Invalid scoped restores must NOT create a reversible snapshot — otherwise
			// repeated bad requests pollute history and the version-cap prune can
			// eventually discard real saves even though nothing was restored.
			const versionsBeforeBad = (await (await fetch(`${BASE}/project/${projectId}/versions`)).json()).versions.length;

			// Scope validation: layerId without pageIndex is rejected.
			const badScope = await fetch(`${BASE}/project/${projectId}/versions/${versionA.versionId}/restore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ layerId: "layer-edit" }),
			});
			expect(badScope.status).toBe(400);
			// Out-of-range page rejected.
			const oob = await fetch(`${BASE}/project/${projectId}/versions/${versionA.versionId}/restore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pageIndex: 99 }),
			});
			expect(oob.status).toBe(400);
			// Unknown layer rejected.
			const missingLayer = await fetch(`${BASE}/project/${projectId}/versions/${versionA.versionId}/restore`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pageIndex: 0, layerId: "nope" }),
			});
			expect(missingLayer.status).toBe(404);

			// No new snapshot was written by any of the three rejected requests.
			const versionsAfterBad = (await (await fetch(`${BASE}/project/${projectId}/versions`)).json()).versions.length;
			expect(versionsAfterBad).toBe(versionsBeforeBad);
		}, 30_000);

		test("W3.9: compare + selective restore enforce project ownership", async () => {
			const { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } = await import("../services/auth.service.js");
			const owner = await createUser({
				email: `w39-owner-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Owner",
			});
			try {
				await markEmailVerified(owner.user.id);
				const ownerUser = await loadUser(owner.user.id);
				const ownerTokens = await generateTokens(ownerUser!);
				const createRes = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokens.accessToken}` },
					body: JSON.stringify({ name: "Owned diff", lang: "th" }),
				});
				expect(createRes.status).toBe(200);
				const { projectId } = await createRes.json();
				const named = await fetch(`${BASE}/project/${projectId}/versions`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokens.accessToken}` },
					body: JSON.stringify({ label: "v1" }),
				});
				expect(named.status).toBe(200);
				const { version } = await named.json();

				const intruder = await createUser({
					email: `w39-intruder-${crypto.randomUUID()}@example.com`,
					password: "StrongP@ss123",
					name: "Intruder",
				});
				try {
					const intruderUser = await loadUser(intruder.user.id);
					const intruderTokens = await generateTokens(intruderUser!);
					// Intruder cannot compare (404 to avoid leaking existence).
					const deniedCompare = await fetch(`${BASE}/project/${projectId}/versions/compare?target=${version.versionId}`, {
						headers: { Authorization: `Bearer ${intruderTokens.accessToken}` },
					});
					expect(deniedCompare.status).toBe(404);
					// Intruder cannot selectively restore.
					const deniedRestore = await fetch(`${BASE}/project/${projectId}/versions/${version.versionId}/restore`, {
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: `Bearer ${intruderTokens.accessToken}` },
						body: JSON.stringify({ pageIndex: 0 }),
					});
					expect(deniedRestore.status).toBe(404);
					// Anonymous denied.
					const anon = await fetch(`${BASE}/project/${projectId}/versions/compare?target=${version.versionId}`);
					expect(anon.status).toBe(401);
				} finally {
					await deleteUser(intruder.user.id);
				}
			} finally {
				await deleteUser(owner.user.id);
			}
		}, 30_000);

		test("version-review: blocks self-approval (requester === reviewer) with a 403", async () => {
			const { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } = await import("../services/auth.service.js");
			const owner = await createUser({
				email: `vr-self-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Requester",
			});
			try {
				await markEmailVerified(owner.user.id);
				const ownerUser = await loadUser(owner.user.id);
				const ownerTokens = await generateTokens(ownerUser!);
				const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokens.accessToken}` };

				const createRes = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: authHeaders,
					body: JSON.stringify({ name: "Self-approval guard", lang: "th" }),
				});
				expect(createRes.status).toBe(200);
				const { projectId } = await createRes.json();

				// Create a named version to attach a review to.
				const named = await fetch(`${BASE}/project/${projectId}/versions`, {
					method: "POST",
					headers: authHeaders,
					body: JSON.stringify({ label: "v1" }),
				});
				expect(named.status).toBe(200);
				const { version } = await named.json();

				// The owner requests a version review (requester = owner email).
				const reviewRes = await fetch(`${BASE}/project/${projectId}/versions/${version.versionId}/reviews`, {
					method: "POST",
					headers: authHeaders,
					body: JSON.stringify({ body: "Please review this snapshot" }),
				});
				expect(reviewRes.status).toBe(200);
				const { review } = await reviewRes.json();
				expect(review.requester).toBe(owner.user.email);

				// The SAME user cannot approve their own request → 403.
				const selfApprove = await fetch(`${BASE}/project/${projectId}/versions/${version.versionId}/reviews/${review.id}`, {
					method: "PATCH",
					headers: authHeaders,
					body: JSON.stringify({ status: "approved", body: "LGTM" }),
				});
				expect(selfApprove.status).toBe(403);

				// Self changes-requested is also blocked.
				const selfChanges = await fetch(`${BASE}/project/${projectId}/versions/${version.versionId}/reviews/${review.id}`, {
					method: "PATCH",
					headers: authHeaders,
					body: JSON.stringify({ status: "changes_requested", body: "redo" }),
				});
				expect(selfChanges.status).toBe(403);

				// The request is untouched — still open, original body preserved.
				const detail = await (await fetch(`${BASE}/project/${projectId}/versions/${version.versionId}`, {
					headers: { Authorization: `Bearer ${ownerTokens.accessToken}` },
				})).json();
				const stillOpen = detail.reviews.find((r: any) => r.id === review.id);
				expect(stillOpen.status).toBe("open");
				expect(stillOpen.body).toBe("Please review this snapshot");

				// Reopening (status "open") by the same user is still allowed (no decision).
				const reopen = await fetch(`${BASE}/project/${projectId}/versions/${version.versionId}/reviews/${review.id}`, {
					method: "PATCH",
					headers: authHeaders,
					body: JSON.stringify({ status: "open" }),
				});
				expect(reopen.status).toBe(200);
			} finally {
				await deleteUser(owner.user.id);
			}
		}, 30_000);

		test("version-review: a decision preserves the original request body (no data-loss)", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Decision data-loss guard", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();

			const named = await fetch(`${BASE}/project/${projectId}/versions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ label: "v1" }),
			});
			expect(named.status).toBe(200);
			const { version } = await named.json();

			// Anonymous (local-user) request — exempt from the self-approval guard.
			const reviewRes = await fetch(`${BASE}/project/${projectId}/versions/${version.versionId}/reviews`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: "Original request description @lead" }),
			});
			expect(reviewRes.status).toBe(200);
			const { review } = await reviewRes.json();

			const decideRes = await fetch(`${BASE}/project/${projectId}/versions/${version.versionId}/reviews/${review.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "approved", body: "Approved — shipping it" }),
			});
			expect(decideRes.status).toBe(200);
			const decided = await decideRes.json();
			// Original request body survives; the reviewer note is stored separately.
			expect(decided.review.status).toBe("approved");
			expect(decided.review.body).toBe("Original request description @lead");
			expect(decided.review.decisionNote).toBe("Approved — shipping it");
			expect(decided.review.mentions).toContain("lead");
		}, 30_000);

		test("version-review: listing survives a malformed version record", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Crash-safe listing", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();

			// Create one good named version.
			const named = await fetch(`${BASE}/project/${projectId}/versions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ label: "good-v1" }),
			});
			expect(named.status).toBe(200);

			// Plant a corrupt (non-JSON) version record on disk next to it.
			const { writeFileSync, mkdirSync } = await import("fs");
			const { join } = await import("path");
			const versionsDir = join(serverProjectsDir, projectId, "versions");
			mkdirSync(versionsDir, { recursive: true });
			const corruptId = `${new Date().toISOString().replace(/[:.]/g, "-")}_corruptaaaaaaaaaaaaaaaaaaaaaaaa`;
			writeFileSync(join(versionsDir, `${corruptId}.json`), "{ this is not valid json ");

			// Listing must NOT 500 — it skips the bad record and returns the good one.
			const listRes = await fetch(`${BASE}/project/${projectId}/versions`);
			expect(listRes.status).toBe(200);
			const list = await listRes.json();
			expect(Array.isArray(list.versions)).toBe(true);
			expect(list.versions.some((v: any) => v.label === "good-v1")).toBe(true);
			expect(list.versions.some((v: any) => v.versionId === corruptId)).toBe(false);
		}, 30_000);

		test("rejects linked workspace and AI anchors that point at another page", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Scoped anchor guard", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			const now = new Date().toISOString();
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			// Both pages carry text so the auto review/QC tasks (page-N-review) the
			// cross-page anchor guard links against are materialized (textless pages
			// no longer get an auto review task).
			const anchorTextLayer = {
				id: "anchor-text",
				text: "ทดสอบ",
				x: 0,
				y: 0,
				w: 100,
				h: 40,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			};
			state.pages = [
				{
					imageId: "anchor-page-0",
					imageName: "anchor-page-0.png",
					textLayers: [{ ...anchorTextLayer }],
					pendingAiJobs: [],
					coverRect: null,
				},
				{
					imageId: "anchor-page-1",
					imageName: "anchor-page-1.png",
					textLayers: [{ ...anchorTextLayer }],
					pendingAiJobs: [],
					coverRect: null,
				},
			];
			state.tasks = [
				{
					id: "anchor-task-page-0",
					pageIndex: 0,
					type: "review",
					status: "todo",
					priority: "normal",
					title: "Review page 1",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "anchor-task-page-1",
					pageIndex: 1,
					type: "review",
					status: "todo",
					priority: "normal",
					title: "Review page 2",
					createdAt: now,
					updatedAt: now,
				},
			];
			state.comments = [
				{
					id: "anchor-comment-page-0",
					pageIndex: 0,
					body: "Page 1 comment",
					author: "tester",
					status: "open",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "anchor-comment-page-1",
					pageIndex: 1,
					body: "Page 2 comment",
					author: "tester",
					status: "open",
					createdAt: now,
					updatedAt: now,
				},
			];
			// Seed server-owned tasks/comments on disk directly: the general `/save`
			// is server-authoritative for these (it ignores the body's copy so a stale
			// save can't clobber a concurrent dedicated-endpoint change), so the cross-
			// page anchor fixtures must be written to `state.json`.
			const { PROJECTS_DIR: anchorProjectsDir } = await import("../config.js");
			const anchorStatePath = join(anchorProjectsDir, projectId, "state.json");
			writeFileSync(anchorStatePath, JSON.stringify(state, null, 2));

			const workspaceMessageRes = await fetch(`${BASE}/project/${projectId}/workspace-messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pageIndex: 0,
					linkedTaskId: "page-1-review",
					body: "Cross-page link should not pass",
				}),
			});
			expect(workspaceMessageRes.status).toBe(400);
			expect(await workspaceMessageRes.json()).toEqual(expect.objectContaining({
				error: "Linked task does not belong to page",
			}));

			await seedMarkerJob("anchor-marker-job", projectId);
			const aiMarkerRes = await fetch(`${BASE}/project/${projectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "anchor-marker-job",
					pageIndex: 0,
					imageId: "anchor-page-0",
					region: { x: 1, y: 1, w: 10, h: 10 },
					status: "needs_review",
					tier: "clean-pro",
					linkedTaskIds: ["page-0-review"],
					linkedCommentIds: ["anchor-comment-page-1"],
				}),
			});
			expect(aiMarkerRes.status).toBe(400);
			expect(await aiMarkerRes.json()).toEqual(expect.objectContaining({
				error: "Linked comment does not belong to marker page",
			}));
		});

		test("keeps open version review snapshots when pruning old versions", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Version prune guard", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			let state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.name = "Version prune reviewed base";
			state.pages = [{
				imageId: "reviewed-image",
				imageName: "reviewed-image.png",
				textLayers: [{
					id: "reviewed-layer",
					text: "Reviewed base",
					x: 10,
					y: 10,
					w: 120,
					h: 40,
					rotation: 0,
					fontSize: 16,
					alignment: "center",
					index: 0,
				}],
				pendingAiJobs: [],
				coverRect: null,
			}];
			const baseSaveRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});
			expect(baseSaveRes.status).toBe(200);
			const baseSave = await baseSaveRes.json();
			const reviewedVersionId = baseSave.version.versionId;

			const reviewRes = await fetch(`${BASE}/project/${projectId}/versions/${reviewedVersionId}/reviews`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: "Keep this snapshot under review" }),
			});
			expect(reviewRes.status).toBe(200);

			state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			for (let index = 0; index < 55; index += 1) {
				state.name = `Version prune rotation ${index}`;
				state.pages[0].textLayers = [{
					id: `rotation-layer-${index}`,
					text: `Rotation ${index}`,
					x: 10 + index,
					y: 10,
					w: 120,
					h: 40,
					rotation: 0,
					fontSize: 16,
					alignment: "center",
					index: 0,
				}];
				const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(state),
				});
				expect(saveRes.status).toBe(200);
				state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			}

			const versionsAfterPrune = await (await fetch(`${BASE}/project/${projectId}/versions`)).json();
			expect(versionsAfterPrune.versions.some((version: any) => version.versionId === reviewedVersionId)).toBe(true);
			expect(versionsAfterPrune.versions.length).toBeLessThanOrEqual(51);

			const reviewedDetailRes = await fetch(`${BASE}/project/${projectId}/versions/${reviewedVersionId}`);
			expect(reviewedDetailRes.status).toBe(200);
			const reviewedDetail = await reviewedDetailRes.json();
			expect(reviewedDetail.reviews.some((review: any) => review.versionId === reviewedVersionId && review.status === "open")).toBe(true);
		}, 45_000);
	});

	describe("Review assignments (PR #390 codex P1 fixes)", () => {
		// Mint an owner so the route's manage/assignee guards pass (owner may assign
		// review work to themselves on a personal/file-mode project).
		async function ownerWithProject(name: string): Promise<{ token: string; projectId: string; userId: string; cleanup: () => Promise<void> }> {
			const { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } = await import("../services/auth.service.js");
			const created = await createUser({
				email: `review-assign-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name,
			});
			await markEmailVerified(created.user.id);
			const user = await loadUser(created.user.id);
			const tokens = await generateTokens(user!);
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.accessToken}` },
				body: JSON.stringify({ name, lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json();
			return {
				token: tokens.accessToken,
				projectId,
				userId: created.user.id,
				cleanup: async () => { await deleteUser(created.user.id); },
			};
		}

		test("P1-1: malformed JSON body returns 400 (not 500) on assign", async () => {
			const ctx = await ownerWithProject("Malformed JSON Owner");
			try {
				const res = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
					body: "{ this is not json",
				});
				expect(res.status).toBe(400);
				expect((await res.json()).error).toBe("Invalid JSON body");
			} finally {
				await ctx.cleanup();
			}
		});

		test("P1-2: a non-ISO dueAt is rejected with 400 before any write", async () => {
			const ctx = await ownerWithProject("Bad DueAt Owner");
			try {
				const res = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
					body: JSON.stringify({ assigneeUserId: ctx.userId, dueAt: "next tuesday" }),
				});
				expect(res.status).toBe(400);
				const body = await res.json();
				expect(body.error).toBe("Validation failed");

				// No assignment was persisted (the bad write was rejected pre-commit).
				const listRes = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, {
					headers: { Authorization: `Bearer ${ctx.token}` },
				});
				expect((await listRes.json()).assignments).toHaveLength(0);
			} finally {
				await ctx.cleanup();
			}
		});

		test("P1-2: a valid ISO dueAt is accepted and stored as canonical ISO", async () => {
			const ctx = await ownerWithProject("Good DueAt Owner");
			try {
				const res = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
					body: JSON.stringify({ assigneeUserId: ctx.userId, dueAt: "2026-07-01T09:00:00.000Z" }),
				});
				expect(res.status).toBe(200);
				const body = await res.json();
				expect(body.assignment.dueAt).toBe("2026-07-01T09:00:00.000Z");
			} finally {
				await ctx.cleanup();
			}
		});

		test("P1-3: pageIndexes all out of range → 400 (does NOT widen to whole chapter)", async () => {
			const ctx = await ownerWithProject("Bad Scope Owner");
			try {
				// Seed a 5-page project so the upper-bound range check is active.
				const state = {
					projectId: ctx.projectId,
					name: "Bad Scope Owner",
					createdAt: new Date().toISOString(),
					currentPage: 0,
					targetLang: "th",
					pages: Array.from({ length: 5 }, (_, i) => ({
						imageId: `img-${i}`,
						imageName: `p${i}.png`,
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					})),
				};
				const saveRes = await fetch(`${BASE}/project/${ctx.projectId}/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
					body: JSON.stringify(state),
				});
				expect(saveRes.status).toBe(200);

				// [999] on a 5-page project is fully out of range and must be rejected,
				// not silently turned into a whole-chapter assignment.
				const res = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
					body: JSON.stringify({ assigneeUserId: ctx.userId, pageIndexes: [999] }),
				});
				expect(res.status).toBe(400);
				expect((await res.json()).code).toBe("review_assignment_invalid_scope");

				const listRes = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, {
					headers: { Authorization: `Bearer ${ctx.token}` },
				});
				expect((await listRes.json()).assignments).toHaveLength(0);
			} finally {
				await ctx.cleanup();
			}
		});

		test("P1-4: cancel ALWAYS writes an in-app notification for the reviewer", async () => {
			const ctx = await ownerWithProject("Cancel Notify Owner");
			try {
				const assignRes = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
					body: JSON.stringify({ assigneeUserId: ctx.userId }),
				});
				expect(assignRes.status).toBe(200);
				const { assignment } = await assignRes.json();

				const cancelRes = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments/${assignment.id}/cancel`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
					body: JSON.stringify({ reason: "duplicate work" }),
				});
				expect(cancelRes.status).toBe(200);
				const cancelBody = await cancelRes.json();
				expect(cancelBody.assignment.status).toBe("cancelled");
				// The mandatory in-app notice was delivered → notified:true reflects reality.
				expect(cancelBody.notified).toBe(true);

				const { notificationStore } = await import("../services/notifications.js");
				const page = await notificationStore.listForUser(ctx.userId);
				expect(page.items.some((n: any) => n.type === "review_cancelled")).toBe(true);
			} finally {
				await ctx.cleanup();
			}
		});

		test("P2: GET review-assignments + revisions LIST is read-only (no state write / no version bump even when normalization drops malformed rows)", async () => {
			const ctx = await ownerWithProject("ReadOnly List Owner");
			try {
				// Seed state.json directly with one VALID and one MALFORMED row in each
				// collection. Under the old code the GET handlers normalized + WROTE the
				// project on a safe method (dropping the malformed rows changes the hash),
				// bumping the version. The fix normalizes in-memory only.
				const now = new Date().toISOString();
				const state = {
					projectId: ctx.projectId,
					userId: ctx.userId,
					name: "ReadOnly List Owner",
					createdAt: now,
					currentPage: 0,
					targetLang: "th",
					pages: [{ imageId: "img-0", imageName: "p0.png", textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null }],
					reviewAssignments: [
						{ id: "ra-valid", assigneeUserId: ctx.userId, status: "assigned", assignedBy: ctx.userId, createdAt: now, updatedAt: now },
						// Malformed: empty assigneeUserId → normalize drops it.
						{ id: "ra-bad", assigneeUserId: "", status: "assigned", assignedBy: ctx.userId, createdAt: now, updatedAt: now },
					],
					revisionRequests: [
						{ id: "rr-valid", assignedToUserId: ctx.userId, reason: "fix it", requestedBy: ctx.userId, status: "requested", revisionNumber: 1, createdAt: now, updatedAt: now },
						// Malformed: empty assignedToUserId → normalize drops it.
						{ id: "rr-bad", assignedToUserId: "", reason: "x", requestedBy: ctx.userId, status: "requested", revisionNumber: 1, createdAt: now, updatedAt: now },
					],
				};
				const statePath = join(serverProjectsDir, ctx.projectId, "state.json");
				writeFileSync(statePath, JSON.stringify(state, null, 2));

				const stateBefore = readFileSync(statePath, "utf8");
				const versionsBefore = (await (await fetch(`${BASE}/project/${ctx.projectId}/versions`, {
					headers: { Authorization: `Bearer ${ctx.token}` },
				})).json()).versions.length;

				// GET both lists twice — normalization is reflected in the RESPONSE (the
				// malformed rows are dropped) but must NOT be persisted.
				const raRes = await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, { headers: { Authorization: `Bearer ${ctx.token}` } });
				expect(raRes.status).toBe(200);
				expect((await raRes.json()).assignments.map((a: any) => a.id)).toEqual(["ra-valid"]);

				const rrRes = await fetch(`${BASE}/project/${ctx.projectId}/revisions`, { headers: { Authorization: `Bearer ${ctx.token}` } });
				expect(rrRes.status).toBe(200);
				expect((await rrRes.json()).revisions.map((r: any) => r.id)).toEqual(["rr-valid"]);

				await fetch(`${BASE}/project/${ctx.projectId}/review-assignments`, { headers: { Authorization: `Bearer ${ctx.token}` } });
				await fetch(`${BASE}/project/${ctx.projectId}/revisions`, { headers: { Authorization: `Bearer ${ctx.token}` } });

				// The on-disk state.json is byte-identical (the malformed rows are STILL
				// there — no surprise normalize-write happened on the GETs) and the version
				// count did not move.
				expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
				const versionsAfter = (await (await fetch(`${BASE}/project/${ctx.projectId}/versions`, {
					headers: { Authorization: `Bearer ${ctx.token}` },
				})).json()).versions.length;
				expect(versionsAfter).toBe(versionsBefore);
			} finally {
				await ctx.cleanup();
			}
		});
	});

	describe("Concurrency safety", () => {
		// Mirror the server's hashProjectState: sha256 over JSON.stringify(state).
		async function projectBaseStateHash(projectId: string): Promise<string> {
			const { createHash } = await import("crypto");
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			return createHash("sha256").update(JSON.stringify(state)).digest("hex");
		}

		test("GET /api/project/:id/workflow is read-only: repeated reads never rewrite state.json", async () => {
			const createRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "ReadOnly GET Project", lang: "th" }),
			});
			const { projectId } = await createRes.json();

			// First workflow GET may lazily MATERIALIZE the workflow (a one-time
			// migration write). After that, the on-disk state.json must be STABLE:
			// a pure read must not keep rewriting it (the GET-with-write-side-effect
			// anti-pattern). Capture the file content + mtime after the first GET, then
			// assert later GETs leave both untouched.
			await fetch(`${BASE}/project/${projectId}/workflow`);
			const statePath = join(serverProjectsDir, projectId, "state.json");
			const afterFirst = readFileSync(statePath, "utf8");
			const mtimeAfterFirst = statSync(statePath).mtimeMs;

			await new Promise((resolve) => setTimeout(resolve, 5));
			for (let i = 0; i < 4; i += 1) {
				const res = await fetch(`${BASE}/project/${projectId}/workflow`);
				expect(res.status).toBe(200);
			}
			expect(readFileSync(statePath, "utf8")).toBe(afterFirst);
			expect(statSync(statePath).mtimeMs).toBe(mtimeAfterFirst);
		});

		// Seed a project with one page so ensureProjectWorkflow materializes tasks
		// and comment/page-scoped endpoints accept pageIndex 0.
		async function createProjectWithOnePage(name: string): Promise<string> {
			const created = await createProjectWithUploadedImage(name);
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			const saveRes = await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...state,
					pages: [{ imageId: created.imageId, imageName: "p0.png", textLayers: [] }],
				}),
			});
			expect(saveRes.status).toBe(200);
			return projectId;
		}

		test("PATCH /api/project/:id/tasks/:taskId rejects a stale baseline with 409 (CAS guard)", async () => {
			const projectId = await createProjectWithOnePage("CAS Task Project");

			// Materialize the workflow and stabilize state, then capture the baseline.
			const workflow = await (await fetch(`${BASE}/project/${projectId}/workflow`)).json();
			const taskId = workflow.tasks[0].id;
			const baseline = await projectBaseStateHash(projectId);

			// Writer A mutates with the valid baseline → succeeds and changes state.
			const okRes = await fetch(`${BASE}/project/${projectId}/tasks/${taskId}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-State-Hash": baseline,
				},
				body: JSON.stringify({ status: "doing" }),
			});
			expect(okRes.status).toBe(200);

			// Writer B replays the NOW-STALE baseline → must be rejected with 409 rather
			// than silently clobbering writer A's change (last-write-wins).
			const conflictRes = await fetch(`${BASE}/project/${projectId}/tasks/${taskId}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-State-Hash": baseline,
				},
				body: JSON.stringify({ status: "done" }),
			});
			expect(conflictRes.status).toBe(409);
			expect((await conflictRes.json()).code).toBe("project_save_conflict");

			// Writer B with the FRESH baseline succeeds (the guard is not sticky).
			const freshBaseline = await projectBaseStateHash(projectId);
			const retryRes = await fetch(`${BASE}/project/${projectId}/tasks/${taskId}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-State-Hash": freshBaseline,
				},
				body: JSON.stringify({ status: "done" }),
			});
			expect(retryRes.status).toBe(200);
			expect((await retryRes.json()).task.status).toBe("done");

			// Back-compat: omitting the header keeps the prior (unguarded) behavior.
			const noHeaderRes = await fetch(`${BASE}/project/${projectId}/tasks/${taskId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "review" }),
			});
			expect(noHeaderRes.status).toBe(200);
		});

		test("POST /api/project/:id/comments honors the CAS baseline guard", async () => {
			const projectId = await createProjectWithOnePage("CAS Comment Project");
			const baseline = await projectBaseStateHash(projectId);

			// First comment with a valid baseline succeeds and advances state.
			const firstRes = await fetch(`${BASE}/project/${projectId}/comments`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-State-Hash": baseline,
				},
				body: JSON.stringify({ pageIndex: 0, body: "first comment" }),
			});
			expect(firstRes.status).toBe(200);

			// A second poster carrying the stale baseline is rejected (would otherwise
			// have read a pre-first-comment state and clobbered it on write).
			const staleRes = await fetch(`${BASE}/project/${projectId}/comments`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Project-Base-State-Hash": baseline,
				},
				body: JSON.stringify({ pageIndex: 0, body: "stale comment" }),
			});
			expect(staleRes.status).toBe(409);
			expect((await staleRes.json()).code).toBe("project_save_conflict");
		});
	});

	describe("Image Upload & Serve", () => {
		test("POST /api/images/:projectId/upload accepts images", async () => {
			// Create a minimal PNG (1x1 pixel)
			const pngBuffer = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			);
			const blob = new Blob([pngBuffer], { type: "image/png" });

			const fd = new FormData();
			fd.append("images", blob, "test.png");

			const res = await fetch(`${BASE}/images/${testProjectId}/upload`, {
				method: "POST",
				body: fd,
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imageIds).toBeDefined();
			expect(data.imageIds.length).toBe(1);
			expect(data.storageReservation).toEqual(expect.objectContaining({
				status: "captured",
				bytes: pngBuffer.length,
			}));
			testImageId = data.imageIds[0];
		});

		test("POST /api/images/:projectId/upload returns 400 (not 500) for a bodyless / non-multipart request", async () => {
			// A POST with no body (or a non-multipart Content-Type) makes c.req.formData()
			// throw ERR_FORMDATA_PARSE_ERROR; left uncaught this surfaced as a 500
			// "Internal server error". A malformed client request must be a clean 400.
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "bodyless-upload", lang: "th" }),
			})).json() as { projectId: string };
			const res = await fetch(`${BASE}/images/${created.projectId}/upload`, { method: "POST" });
			expect(res.status).toBe(400);
			const data = await res.json() as { code?: string };
			expect(data.code).toBe("invalid_multipart_body");
		});

		test("POST /api/images/:projectId/upload-transform returns 400 (not 500) for a bodyless request", async () => {
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "bodyless-transform", lang: "th" }),
			})).json() as { projectId: string };
			const res = await fetch(`${BASE}/images/${created.projectId}/upload-transform`, { method: "POST" });
			expect(res.status).toBe(400);
			const data = await res.json() as { code?: string };
			expect(data.code).toBe("invalid_multipart_body");
		});

		test("POST /api/images/:projectId/upload succeeds if reservation release cleanup fails after commit", async () => {
			const {
				MemoryStorageQuotaReservationStore,
				setStorageQuotaReservationStoreForTests,
			} = await import("../services/storage-quota.js");
			const memoryStore = new MemoryStorageQuotaReservationStore();
			const releaseCalls: string[] = [];
			const restore = setStorageQuotaReservationStoreForTests({
				reserve: (input) => memoryStore.reserve(input),
				release: async (_projectId, reservationId) => {
					releaseCalls.push(reservationId);
					throw new Error("redis release unavailable");
				},
				listActive: (projectId, now) => memoryStore.listActive(projectId, now),
			});
			try {
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				const fd = new FormData();
				fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "release-cleanup.png");

				const res = await fetch(`${BASE}/images/${testProjectId}/upload`, {
					method: "POST",
					body: fd,
				});

				expect(res.status).toBe(200);
				const body = await res.json();
				expect(body.imageIds).toHaveLength(1);
				expect(releaseCalls).toHaveLength(1);
			} finally {
				restore();
			}
		});

		test("POST /api/images/:projectId/upload rolls back objects and assets when usage recording fails", async () => {
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Usage Rollback Upload", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const [{ listAssetRecords }, { objectStorage }, { usageLedger }, { uploadAuditStore }] = await Promise.all([
				import("../services/assets.js"),
				import("../services/storage.js"),
				import("../services/usage-ledger.js"),
				import("../services/upload-audit.js"),
			]);
			const beforeAssets = listAssetRecords(projectId);
			const originalRecordUpload = usageLedger.recordUpload;
			const originalDeleteProjectImage = objectStorage.deleteProjectImage;
			const deletedImageIds: string[] = [];

			(usageLedger as any).recordUpload = async () => {
				throw new Error("usage ledger write unavailable");
			};
			(objectStorage as any).deleteProjectImage = async (input: any) => {
				deletedImageIds.push(input.imageId);
				return originalDeleteProjectImage.call(objectStorage, input);
			};

			try {
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				const fd = new FormData();
				fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "usage-fails.png");

				const res = await fetch(`${BASE}/images/${projectId}/upload`, {
					method: "POST",
					body: fd,
				});

				expect(res.status).toBe(500);
				expect(listAssetRecords(projectId)).toEqual(beforeAssets);
				expect(deletedImageIds).toHaveLength(1);
				expect(await objectStorage.hasProjectImage({ projectId, imageId: deletedImageIds[0] })).toBe(false);
				expect(await uploadAuditStore.listProjectEvents(projectId, { imageId: deletedImageIds[0] })).toEqual([]);
			} finally {
				(usageLedger as any).recordUpload = originalRecordUpload;
				(objectStorage as any).deleteProjectImage = originalDeleteProjectImage;
			}
		});

		test("POST /api/images/:projectId/upload preserves asset accounting when rollback object cleanup fails", async () => {
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Cleanup Failure Upload", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const [{ listAssetRecords }, { objectStorage }, { usageLedger }, { uploadAuditStore }] = await Promise.all([
				import("../services/assets.js"),
				import("../services/storage.js"),
				import("../services/usage-ledger.js"),
				import("../services/upload-audit.js"),
			]);
			const originalRecordUpload = usageLedger.recordUpload;
			const originalDeleteProjectImage = objectStorage.deleteProjectImage;

			(usageLedger as any).recordUpload = async () => {
				throw new Error("usage ledger write unavailable");
			};
			(objectStorage as any).deleteProjectImage = async () => {
				throw new Error("r2 delete unavailable");
			};

			try {
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				const fd = new FormData();
				fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "cleanup-fails.png");

				const res = await fetch(`${BASE}/images/${projectId}/upload`, {
					method: "POST",
					body: fd,
				});

				expect(res.status).toBe(500);
				const records = listAssetRecords(projectId);
				expect(records).toHaveLength(1);
				expect(await objectStorage.hasProjectImage({ projectId, imageId: records[0].imageId })).toBe(true);
				expect(await uploadAuditStore.listProjectEvents(projectId, { imageId: records[0].imageId })).toHaveLength(1);
			} finally {
				(usageLedger as any).recordUpload = originalRecordUpload;
				(objectStorage as any).deleteProjectImage = originalDeleteProjectImage;
			}
		});

		test("POST /api/images/:projectId/upload does not roll back committed usage after response assembly fails", async () => {
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Committed Response Failure Upload", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const [{ listAssetRecords }, { objectStorage }, { usageLedger }] = await Promise.all([
				import("../services/assets.js"),
				import("../services/storage.js"),
				import("../services/usage-ledger.js"),
			]);
			const originalRecordUpload = usageLedger.recordUpload;
			let committedImageId = "";

			(usageLedger as any).recordUpload = async function (input: any) {
				const result = await originalRecordUpload.call(usageLedger, input);
				committedImageId = input.metadata?.imageIds?.[0] ?? "";
				const circularSummary: any = {};
				circularSummary.self = circularSummary;
				return { event: result.event, summary: circularSummary };
			};

			try {
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				const fd = new FormData();
				fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "response-fails.png");

				const res = await fetch(`${BASE}/images/${projectId}/upload`, {
					method: "POST",
					body: fd,
				});

				expect(res.status).toBe(500);
				expect(committedImageId).toBeTruthy();
				expect(listAssetRecords(projectId).some((asset) => asset.imageId === committedImageId)).toBe(true);
				expect(await objectStorage.hasProjectImage({ projectId, imageId: committedImageId })).toBe(true);
			} finally {
				(usageLedger as any).recordUpload = originalRecordUpload;
			}
		});

			test("POST /api/images/:projectId/upload rejects undecodable image bytes before storage accounting", async () => {
				const beforeAssets = await (await fetch(`${BASE}/images/${testProjectId}/assets`)).json();
				const fd = new FormData();
				fd.append("images", new Blob([Buffer.from("not-a-real-png")], { type: "image/png" }), "bad.png");

			const res = await fetch(`${BASE}/images/${testProjectId}/upload`, {
				method: "POST",
				body: fd,
			});

			expect(res.status).toBe(422);
			expect(await res.json()).toEqual(expect.objectContaining({ code: "image_not_decodable" }));
				const afterAssets = await (await fetch(`${BASE}/images/${testProjectId}/assets`)).json();
				expect(afterAssets.assets.length).toBe(beforeAssets.assets.length);
			});

			test("POST /api/images/:projectId/upload validates an entire batch before storing any file", async () => {
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Atomic Upload Validation", lang: "th" }),
				})).json();
				const projectId = created.projectId;
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				const fd = new FormData();
				fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "valid-first.png");
				fd.append("images", new Blob([Buffer.from("not-a-real-png")], { type: "image/png" }), "bad-second.png");

				const res = await fetch(`${BASE}/images/${projectId}/upload`, {
					method: "POST",
					body: fd,
				});

				expect(res.status).toBe(422);
				expect(await res.json()).toEqual(expect.objectContaining({
					code: "image_not_decodable",
					filename: "bad-second.png",
				}));
				const afterAssets = await (await fetch(`${BASE}/images/${projectId}/assets`)).json();
				expect(afterAssets.assets).toEqual([]);
			});

			test("POST /api/images/:projectId/upload rejects images below configured minimum dimensions", async () => {
				const { serverConfig } = await import("../config.js");
				const snapshot = {
					minUploadImageWidth: serverConfig.minUploadImageWidth,
					minUploadImageHeight: serverConfig.minUploadImageHeight,
				};
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Minimum Dimension Upload", lang: "th" }),
				})).json();
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				try {
					Object.assign(serverConfig as unknown as Record<string, unknown>, {
						minUploadImageWidth: 2,
						minUploadImageHeight: 2,
					});
					const fd = new FormData();
					fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "too-small.png");

					const res = await fetch(`${BASE}/images/${created.projectId}/upload`, {
						method: "POST",
						body: fd,
					});

					expect(res.status).toBe(422);
					expect(await res.json()).toEqual(expect.objectContaining({
						code: "image_dimensions_too_small",
						filename: "too-small.png",
						width: 1,
						height: 1,
						minWidth: 2,
						minHeight: 2,
					}));
					const afterAssets = await (await fetch(`${BASE}/images/${created.projectId}/assets`)).json();
					expect(afterAssets.assets).toEqual([]);
				} finally {
					Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
				}
			});

			test("POST /api/images/:projectId/upload EXEMPTS tiny image-edit ROI assets from the min-dimension floor (Phase B)", async () => {
				// A non-destructive edit-layer realized patch / mask is a tiny ROI (well below
				// the page min-dimension floor). Tagged via the `metadata.assetKind` form field,
				// it must be ACCEPTED — otherwise brush/heal/clone edits over small regions can
				// never persist as edit layers (the bug real-browser QA surfaced).
				//
				// codex #392 P2 — the exemption is NOT granted on client `assetKind` alone; the
				// upload's `pageImageId` must resolve to a REAL page in the server's authoritative
				// state. We seed such a page (state.json) so the exemption is server-corroborated.
				const { serverConfig, PROJECTS_DIR: activeProjectsDir } = await import("../config.js");
				const snapshot = {
					minUploadImageWidth: serverConfig.minUploadImageWidth,
					minUploadImageHeight: serverConfig.minUploadImageHeight,
				};
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Edit ROI Upload", lang: "th" }),
				})).json();
				// Seed an authoritative page whose imageId the edit asset composites over.
				const pageImageId = "page-source-1.png";
				writeFileSync(
					join(activeProjectsDir, created.projectId, "state.json"),
					JSON.stringify({
						projectId: created.projectId,
						name: "Edit ROI Upload",
						pages: [{ imageId: pageImageId, imageName: "p.png", textLayers: [], pendingAiJobs: [], coverRect: null }],
						currentPage: 0,
						targetLang: "th",
					}),
				);
				// 1×1 PNG — far below any sane page min-dimension.
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				try {
					Object.assign(serverConfig as unknown as Record<string, unknown>, {
						minUploadImageWidth: 64,
						minUploadImageHeight: 64,
					});
					const fd = new FormData();
					fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "edit-patch.png");
					// Real edit asset: references the seeded page's actual imageId.
					fd.append("metadata", JSON.stringify({ assetKind: "image-edit-patch", pageImageId, pageIndex: 0 }));

					const res = await fetch(`${BASE}/images/${created.projectId}/upload`, { method: "POST", body: fd });
					expect(res.status).toBe(200);
					const body = await res.json();
					expect(Array.isArray(body.imageIds)).toBe(true);
					expect(body.imageIds.length).toBe(1);

					// And a NORMAL (untagged) 1×1 upload is STILL rejected by the same floor.
					const fd2 = new FormData();
					fd2.append("images", new Blob([pngBuffer], { type: "image/png" }), "page-too-small.png");
					const res2 = await fetch(`${BASE}/images/${created.projectId}/upload`, { method: "POST", body: fd2 });
					expect(res2.status).toBe(422);
					expect(await res2.json()).toEqual(expect.objectContaining({ code: "image_dimensions_too_small" }));
				} finally {
					Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
				}
			});

			test("POST /api/images/:projectId/upload PERSISTS edit-asset provenance on the record (Phase D)", async () => {
				// Phase D — a corroborated edit-layer upload must tag the AssetRecord with
				// server-side provenance (assetKind / pageImageId / pageIndex / editLayerId) so
				// the orphaned-edit-asset GC sweep can find it by metadata. (The forged-tag guard
				// is covered by the next test; here the pageImageId resolves to a real page.)
				const { serverConfig, PROJECTS_DIR: activeProjectsDir } = await import("../config.js");
				const { listAssetRecords } = await import("../services/assets.js");
				const snapshot = {
					minUploadImageWidth: serverConfig.minUploadImageWidth,
					minUploadImageHeight: serverConfig.minUploadImageHeight,
				};
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Edit Provenance", lang: "th" }),
				})).json();
				const pageImageId = "page-source-1.png";
				writeFileSync(
					join(activeProjectsDir, created.projectId, "state.json"),
					JSON.stringify({
						projectId: created.projectId,
						name: "Edit Provenance",
						pages: [{ imageId: pageImageId, imageName: "p.png", textLayers: [], pendingAiJobs: [], coverRect: null }],
						currentPage: 0,
						targetLang: "th",
					}),
				);
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				try {
					Object.assign(serverConfig as unknown as Record<string, unknown>, { minUploadImageWidth: 64, minUploadImageHeight: 64 });
					const fd = new FormData();
					fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "mask.png");
					fd.append("metadata", JSON.stringify({ assetKind: "image-edit-mask", pageImageId, pageIndex: 0, editLayerId: "edit-layer-1" }));
					const res = await fetch(`${BASE}/images/${created.projectId}/upload`, { method: "POST", body: fd });
					expect(res.status).toBe(200);
					const body = await res.json();
					const imageId = body.imageIds[0];

					const records = listAssetRecords(created.projectId);
					const record = records.find((r) => r.imageId === imageId);
					expect(record?.metadata?.assetKind).toBe("image-edit-mask");
					expect(record?.metadata?.pageImageId).toBe(pageImageId);
					expect(record?.metadata?.pageIndex).toBe(0);
					expect(record?.metadata?.editLayerId).toBe("edit-layer-1");
				} finally {
					Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
				}
			});

			test("POST /api/images/:projectId/upload does NOT honor a FORGED edit-asset exemption (codex #392 P2)", async () => {
				// A normal page upload must not bypass the 64×64 floor by FORGING
				// `metadata.assetKind`. The exemption requires a `pageImageId` that resolves to a
				// real page in the authoritative state; a forged kind with an unknown/missing
				// pageImageId stays subject to the floor.
				const { serverConfig } = await import("../config.js");
				const snapshot = {
					minUploadImageWidth: serverConfig.minUploadImageWidth,
					minUploadImageHeight: serverConfig.minUploadImageHeight,
				};
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Forged Edit ROI", lang: "th" }),
				})).json();
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				try {
					Object.assign(serverConfig as unknown as Record<string, unknown>, {
						minUploadImageWidth: 64,
						minUploadImageHeight: 64,
					});
					// Forged: claims edit-asset kind but the pageImageId does not exist in state
					// (the fresh project has no pages), so the exemption must be DENIED.
					const fd = new FormData();
					fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "forged.png");
					fd.append("metadata", JSON.stringify({ assetKind: "image-edit-patch", pageImageId: "does-not-exist.png", pageIndex: 0 }));
					const res = await fetch(`${BASE}/images/${created.projectId}/upload`, { method: "POST", body: fd });
					expect(res.status).toBe(422);
					expect(await res.json()).toEqual(expect.objectContaining({ code: "image_dimensions_too_small" }));

					// Also forged: claims the kind but supplies NO pageImageId at all.
					const fd2 = new FormData();
					fd2.append("images", new Blob([pngBuffer], { type: "image/png" }), "forged2.png");
					fd2.append("metadata", JSON.stringify({ assetKind: "image-edit-mask" }));
					const res2 = await fetch(`${BASE}/images/${created.projectId}/upload`, { method: "POST", body: fd2 });
					expect(res2.status).toBe(422);
					expect(await res2.json()).toEqual(expect.objectContaining({ code: "image_dimensions_too_small" }));
				} finally {
					Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
				}
			});

			test("POST /api/images/:projectId/upload enforces chapter image and byte ceilings", async () => {
				const { serverConfig } = await import("../config.js");
				const snapshot = {
					maxImagesPerChapter: serverConfig.maxImagesPerChapter,
					maxChapterOriginalBytes: serverConfig.maxChapterOriginalBytes,
					maxUploadBatchSizeBytes: serverConfig.maxUploadBatchSizeBytes,
				};
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				try {
					Object.assign(serverConfig as unknown as Record<string, unknown>, {
						maxImagesPerChapter: 1000,
						maxChapterOriginalBytes: 1024 * 1024,
						maxUploadBatchSizeBytes: pngBuffer.length - 1,
					});
					const batchLimitedProject = await (await fetch(`${BASE}/project/new`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: "Upload Batch Limit", lang: "th" }),
					})).json();
					const batchLimitedFd = new FormData();
					batchLimitedFd.append("images", new Blob([pngBuffer], { type: "image/png" }), "one.png");

					const batchLimited = await fetch(`${BASE}/images/${batchLimitedProject.projectId}/upload`, {
						method: "POST",
						body: batchLimitedFd,
					});
					expect(batchLimited.status).toBe(413);
					expect(await batchLimited.json()).toEqual(expect.objectContaining({
						code: "request_body_too_large",
						limitBytes: pngBuffer.length - 1,
					}));

					Object.assign(serverConfig as unknown as Record<string, unknown>, {
						maxImagesPerChapter: 1,
						maxChapterOriginalBytes: 1024 * 1024,
						maxUploadBatchSizeBytes: 1024 * 1024,
					});
					const imageLimitedProject = await (await fetch(`${BASE}/project/new`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: "Chapter Image Limit", lang: "th" }),
					})).json();
					const imageLimitedFd = new FormData();
					imageLimitedFd.append("images", new Blob([pngBuffer], { type: "image/png" }), "one.png");
					imageLimitedFd.append("images", new Blob([pngBuffer], { type: "image/png" }), "two.png");

					const imageLimited = await fetch(`${BASE}/images/${imageLimitedProject.projectId}/upload`, {
						method: "POST",
						body: imageLimitedFd,
					});
					expect(imageLimited.status).toBe(413);
					expect(await imageLimited.json()).toEqual(expect.objectContaining({
						code: "chapter_image_limit_exceeded",
						limitImages: 1,
					}));

					Object.assign(serverConfig as unknown as Record<string, unknown>, {
						maxImagesPerChapter: 1000,
						maxChapterOriginalBytes: pngBuffer.length - 1,
						maxUploadBatchSizeBytes: 1024 * 1024,
					});
					const byteLimitedProject = await (await fetch(`${BASE}/project/new`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: "Chapter Byte Limit", lang: "th" }),
					})).json();
					const byteLimitedFd = new FormData();
					byteLimitedFd.append("images", new Blob([pngBuffer], { type: "image/png" }), "one.png");

					const byteLimited = await fetch(`${BASE}/images/${byteLimitedProject.projectId}/upload`, {
						method: "POST",
						body: byteLimitedFd,
					});
					expect(byteLimited.status).toBe(413);
					expect(await byteLimited.json()).toEqual(expect.objectContaining({
						code: "chapter_original_bytes_limit_exceeded",
					}));
				} finally {
					Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
				}
			});

			test("POST /api/images/:projectId/upload counts active upload reservations against chapter image cap", async () => {
				const { serverConfig } = await import("../config.js");
				const {
					MemoryStorageQuotaReservationStore,
					setStorageQuotaReservationStoreForTests,
				} = await import("../services/storage-quota.js");
				const snapshot = {
					maxImagesPerChapter: serverConfig.maxImagesPerChapter,
					maxChapterOriginalBytes: serverConfig.maxChapterOriginalBytes,
					maxUploadBatchSizeBytes: serverConfig.maxUploadBatchSizeBytes,
				};
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				const memoryStore = new MemoryStorageQuotaReservationStore();
				const releases: string[] = [];
				const restoreStore = setStorageQuotaReservationStoreForTests({
					reserve: (input) => memoryStore.reserve(input),
					release: async (projectId, reservationId) => {
						releases.push(reservationId);
						return memoryStore.release(projectId, reservationId);
					},
					listActive: (workspaceId, now) => memoryStore.listActive(workspaceId, now),
				});
				try {
					Object.assign(serverConfig as unknown as Record<string, unknown>, {
						maxImagesPerChapter: 1,
						maxChapterOriginalBytes: 1024 * 1024,
						maxUploadBatchSizeBytes: 1024 * 1024,
					});
					const created = await (await fetch(`${BASE}/project/new`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: "Reserved Chapter Image Limit", lang: "th" }),
					})).json();
					await memoryStore.reserve({
						projectId: created.projectId,
						bytes: pngBuffer.length,
						reason: "image_upload",
						metadata: { fileCount: 1, chapterOriginalBytes: pngBuffer.length },
						ttlMs: 60_000,
						now: Date.now() - 1_000,
					});
					const fd = new FormData();
					fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "one.png");

					const res = await fetch(`${BASE}/images/${created.projectId}/upload`, {
						method: "POST",
						body: fd,
					});

					expect(res.status).toBe(413);
					expect(await res.json()).toEqual(expect.objectContaining({
						code: "chapter_image_limit_exceeded",
						limitImages: 1,
						persistedImages: 0,
						reservedImages: 2,
						projectedImages: 2,
					}));
					expect(releases).toHaveLength(1);
					const afterAssets = await (await fetch(`${BASE}/images/${created.projectId}/assets`)).json();
					expect(afterAssets.assets).toEqual([]);
				} finally {
					restoreStore();
					Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
				}
			});

			test("POST /api/images/:projectId/upload counts active upload reservations against chapter byte cap", async () => {
				const { serverConfig } = await import("../config.js");
				const {
					MemoryStorageQuotaReservationStore,
					setStorageQuotaReservationStoreForTests,
				} = await import("../services/storage-quota.js");
				const snapshot = {
					maxImagesPerChapter: serverConfig.maxImagesPerChapter,
					maxChapterOriginalBytes: serverConfig.maxChapterOriginalBytes,
					maxUploadBatchSizeBytes: serverConfig.maxUploadBatchSizeBytes,
				};
				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				const memoryStore = new MemoryStorageQuotaReservationStore();
				const restoreStore = setStorageQuotaReservationStoreForTests({
					reserve: (input) => memoryStore.reserve(input),
					release: (projectId, reservationId) => memoryStore.release(projectId, reservationId),
					listActive: (workspaceId, now) => memoryStore.listActive(workspaceId, now),
				});
				try {
					Object.assign(serverConfig as unknown as Record<string, unknown>, {
						maxImagesPerChapter: 1000,
						maxChapterOriginalBytes: pngBuffer.length,
						maxUploadBatchSizeBytes: 1024 * 1024,
					});
					const created = await (await fetch(`${BASE}/project/new`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: "Reserved Chapter Byte Limit", lang: "th" }),
					})).json();
					await memoryStore.reserve({
						projectId: created.projectId,
						bytes: pngBuffer.length,
						reason: "image_upload",
						metadata: { fileCount: 1, chapterOriginalBytes: pngBuffer.length },
						ttlMs: 60_000,
						now: Date.now() - 1_000,
					});
					const fd = new FormData();
					fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "one.png");

					const res = await fetch(`${BASE}/images/${created.projectId}/upload`, {
						method: "POST",
						body: fd,
					});

					expect(res.status).toBe(413);
					expect(await res.json()).toEqual(expect.objectContaining({
						code: "chapter_original_bytes_limit_exceeded",
						limitBytes: pngBuffer.length,
						persistedBytes: 0,
						reservedBytes: pngBuffer.length * 2,
						projectedBytes: pngBuffer.length * 2,
					}));
					const afterAssets = await (await fetch(`${BASE}/images/${created.projectId}/assets`)).json();
					expect(afterAssets.assets).toEqual([]);
				} finally {
					restoreStore();
					Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
				}
			});

			test("GET /api/images/:projectId/assets lists uploaded project assets", async () => {
				const res = await fetch(`${BASE}/images/${testProjectId}/assets`);
				expect(res.status).toBe(200);
				const data = await res.json();
				expect(data.assets.length).toBeGreaterThanOrEqual(2);
				const asset = data.assets.find((item: any) => item.imageId === testImageId);
				expect(asset).toBeDefined();
				expect(asset.originalName).toBe("test.png");
				expect(asset.width).toBe(1);
				expect(asset.height).toBe(1);
				expect(asset.moderationStatus).toBe("passed");
			});

			test("GET /api/images/:projectId/assets supports bounded cursor pagination and filters", async () => {
				const first = await fetch(`${BASE}/images/${testProjectId}/assets?limit=1&storageStatus=released&moderationStatus=passed&source=anonymous`);
				expect(first.status).toBe(200);
				const firstPage = await first.json();
				expect(firstPage.assets).toHaveLength(1);
				expect(firstPage.nextCursor).toEqual(expect.any(String));
				expect(firstPage.assets[0].storageStatus).toBe("released");
				expect(firstPage.assets[0].moderationStatus).toBe("passed");
				expect(firstPage.assets[0].uploadedBy.source).toBe("anonymous");

				const second = await fetch(`${BASE}/images/${testProjectId}/assets?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}&storageStatus=released&moderationStatus=passed&source=anonymous`);
				expect(second.status).toBe(200);
				const secondPage = await second.json();
				expect(secondPage.assets).toHaveLength(1);
				expect(secondPage.assets[0].assetId).not.toBe(firstPage.assets[0].assetId);
			});

			test("GET /api/images/:projectId/assets rejects invalid pagination filters", async () => {
				const invalidLimit = await fetch(`${BASE}/images/${testProjectId}/assets?limit=0`);
				expect(invalidLimit.status).toBe(400);
				expect(await invalidLimit.json()).toEqual(expect.objectContaining({ code: "invalid_limit" }));

				const malformedLimit = await fetch(`${BASE}/images/${testProjectId}/assets?limit=10abc`);
				expect(malformedLimit.status).toBe(400);
				expect(await malformedLimit.json()).toEqual(expect.objectContaining({ code: "invalid_limit" }));

				const invalidCursor = await fetch(`${BASE}/images/${testProjectId}/assets?cursor=not-a-cursor`);
				expect(invalidCursor.status).toBe(400);
				expect(await invalidCursor.json()).toEqual(expect.objectContaining({ code: "invalid_cursor" }));

				const invalidStatus = await fetch(`${BASE}/images/${testProjectId}/assets?storageStatus=archived`);
				expect(invalidStatus.status).toBe(400);
				expect(await invalidStatus.json()).toEqual(expect.objectContaining({ code: "invalid_storage_status" }));
			});

			test("GET /api/images/:projectId/upload-audit supports cursor pagination and upload actor filters", async () => {
				const first = await fetch(`${BASE}/images/${testProjectId}/upload-audit?limit=1&source=anonymous`);
				expect(first.status).toBe(200);
				const firstPage = await first.json();
				expect(firstPage.events).toHaveLength(1);
				expect(firstPage.events[0].actor.source).toBe("anonymous");
				expect(firstPage.nextCursor).toEqual(expect.any(String));

				const second = await fetch(`${BASE}/images/${testProjectId}/upload-audit?limit=1&source=anonymous&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
				expect(second.status).toBe(200);
				const secondPage = await second.json();
				expect(secondPage.events).toHaveLength(1);
				expect(secondPage.events[0].auditId).not.toBe(firstPage.events[0].auditId);

				const byImage = await fetch(`${BASE}/images/${testProjectId}/upload-audit?imageId=${encodeURIComponent(testImageId)}`);
				expect(byImage.status).toBe(200);
				const byImagePage = await byImage.json();
				expect(byImagePage.events.length).toBeGreaterThan(0);
				expect(byImagePage.events.every((event: any) => event.imageId === testImageId)).toBe(true);
			});

			test("GET /api/images/:projectId/upload-audit rejects invalid pagination filters", async () => {
				const invalidCursor = await fetch(`${BASE}/images/${testProjectId}/upload-audit?cursor=not-a-cursor`);
				expect(invalidCursor.status).toBe(400);
				expect(await invalidCursor.json()).toEqual(expect.objectContaining({ code: "invalid_cursor" }));

				const invalidSource = await fetch(`${BASE}/images/${testProjectId}/upload-audit?source=botnet`);
				expect(invalidSource.status).toBe(400);
				expect(await invalidSource.json()).toEqual(expect.objectContaining({ code: "invalid_source" }));

				const invalidImage = await fetch(`${BASE}/images/${testProjectId}/upload-audit?imageId=../../bad.png`);
				expect(invalidImage.status).toBe(400);
				expect(await invalidImage.json()).toEqual(expect.objectContaining({ code: "invalid_image_id" }));
			});

		test("GET /api/images/:projectId/:imageId serves image", async () => {
			const res = await fetch(`${BASE}/images/${testProjectId}/${testImageId}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("image/");
			expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
			const buf = await res.arrayBuffer();
			expect(buf.byteLength).toBeGreaterThan(0);
		});

		test("GET /api/images/:projectId/:imageId blocks quarantined or blocked assets", async () => {
			const pngBuffer = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			);
			const fd = new FormData();
			fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "blocked.png");
			const upload = await fetch(`${BASE}/images/${testProjectId}/upload`, {
				method: "POST",
				body: fd,
			});
			expect(upload.status).toBe(200);
			const { imageIds } = await upload.json();
			const blockedImageId = imageIds[0];
			const { PROJECTS_DIR } = await import("../config.js");
			const assetIndexPath = join(PROJECTS_DIR, testProjectId, "assets.json");
			const index = JSON.parse(readFileSync(assetIndexPath, "utf8"));
			index[blockedImageId].storageStatus = "blocked";
			index[blockedImageId].moderation.status = "blocked";
			writeFileSync(assetIndexPath, JSON.stringify(index, null, 2));

			const res = await fetch(`${BASE}/images/${testProjectId}/${blockedImageId}`);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual(expect.objectContaining({ code: "asset_not_released" }));
		});

		test("GET /api/images/:projectId/:imageId serves soft-warned (needs_review) assets with a review marker", async () => {
			// Soft moderation warnings (e.g. non-blocking shonen violence) passed the
			// mandatory policy: the page must stay servable/displayable with its review
			// marker. Only HARD blocks (block / csam_block) are withheld from serving.
			// AI processing of warned assets is still gated separately by AI readiness.
			const pngBuffer = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			);
			const fd = new FormData();
			fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "needs-review.png");
			const upload = await fetch(`${BASE}/images/${testProjectId}/upload`, {
				method: "POST",
				body: fd,
			});
			expect(upload.status).toBe(200);
			const { imageIds } = await upload.json();
			const reviewImageId = imageIds[0];
			const { PROJECTS_DIR } = await import("../config.js");
			const assetIndexPath = join(PROJECTS_DIR, testProjectId, "assets.json");
			const index = JSON.parse(readFileSync(assetIndexPath, "utf8"));
			index[reviewImageId].storageStatus = "released";
			index[reviewImageId].moderation.status = "needs_review";
			writeFileSync(assetIndexPath, JSON.stringify(index, null, 2));

			const res = await fetch(`${BASE}/images/${testProjectId}/${reviewImageId}`);
			expect(res.status).toBe(200);
		});

		test("GET /api/images/:projectId/:imageId/thumbnail serves cached WebP derivative", async () => {
			const url = `${BASE}/images/${testProjectId}/${testImageId}/thumbnail?width=96&height=144`;
			const first = await fetch(url);
			expect(first.status).toBe(200);
			expect(first.headers.get("Content-Type")).toBe("image/webp");
			expect(first.headers.get("X-Thumbnail-Cache")).toBe("miss");
			expect(first.headers.get("X-Thumbnail-Id")).toContain(".thumbnail.96x144.");
			const firstBuf = await first.arrayBuffer();
			expect(firstBuf.byteLength).toBeGreaterThan(0);

			const second = await fetch(url);
			expect(second.status).toBe(200);
			expect(second.headers.get("X-Thumbnail-Cache")).toBe("hit");
		});

		test("GET /api/images/:projectId/:imageId/thumbnail returns controlled error for corrupt source images", async () => {
			const { objectStorage } = await import("../services/storage.js");
			const { restoreAssetRecord } = await import("../services/assets.js");
			const corruptImageId = "33333333-3333-4333-8333-333333333333.png";
			const corruptBytes = Buffer.from("not-a-real-png");
			const storedObject = await objectStorage.putProjectImage({
				projectId: testProjectId,
				imageId: corruptImageId,
				buffer: corruptBytes,
			});
			// Register a passing/released asset record directly (bypassing the
			// decode-validating upload path) so the corrupt object clears the serve
			// gate — which now fails closed on a missing record (codex P0-2) — and the
			// thumbnail DECODER is the thing that surfaces the controlled 422.
			const nowIso = new Date().toISOString();
			restoreAssetRecord(testProjectId, {
				assetId: corruptImageId,
				projectId: testProjectId,
				imageId: corruptImageId,
				originalName: corruptImageId,
				mimeType: "image/png",
				sizeBytes: corruptBytes.byteLength,
				sha256: "0".repeat(64),
				storageDriver: storedObject.driver,
				storageKey: storedObject.key,
				width: 1,
				height: 1,
				storageStatus: "released",
				moderation: { status: "passed", provider: "test", checkedAt: nowIso },
				derivatives: [],
				createdAt: nowIso,
				updatedAt: nowIso,
			});

			const res = await fetch(`${BASE}/images/${testProjectId}/${corruptImageId}/thumbnail?width=96&height=144`);
			expect(res.status).toBe(422);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			const body = await res.json();
			expect(body.code).toBe("image_not_decodable");
			expect(body.imageId).toBe(corruptImageId);
		});

		test("upload to non-existent project returns 404", async () => {
			const blob = new Blob(["test"], { type: "image/png" });
			const fd = new FormData();
			fd.append("images", blob, "test.png");

			const res = await fetch(`${BASE}/images/00000000-0000-0000-0000-000000000000/upload`, {
				method: "POST",
				body: fd,
			});
			expect(res.status).toBe(404);
		});

		test("serve image with no asset record is denied (fail-closed, codex P0-2)", async () => {
			// An id with neither an object nor an authoritative asset record must be
			// DENIED (403), not 404. The serve gate fails closed on a missing record so
			// an un-registered / pre-moderation object (e.g. the raw AI provider
			// checkpoint) can never be fetched by id.
			const res = await fetch(`${BASE}/images/${testProjectId}/00000000-0000-0000-0000-000000000000.png`);
			expect(res.status).toBe(403);
			const body = await res.json();
			expect(body.code).toBe("asset_not_registered");
		});

		describe("Bulk import transform (W3.16)", () => {
			async function solidPng(width: number, height: number, channel: number): Promise<Buffer> {
				const sharp = (await import("sharp")).default;
				return sharp({
					create: { width, height, channels: 3, background: { r: channel, g: channel, b: channel } },
				}).png().toBuffer();
			}

			// Vertical gradient so each sliced chunk has distinct bytes (a solid color
			// would make adjacent equal-height chunks SHA-identical and get deduped).
			async function gradientPng(width: number, height: number): Promise<Buffer> {
				const sharp = (await import("sharp")).default;
				const channels = 3;
				const raw = Buffer.alloc(width * height * channels);
				for (let y = 0; y < height; y++) {
					const value = Math.floor((y / Math.max(1, height - 1)) * 255);
					for (let x = 0; x < width; x++) {
						const offset = (y * width + x) * channels;
						raw[offset] = value;
						raw[offset + 1] = (value + 64) % 256;
						raw[offset + 2] = (value + 128) % 256;
					}
				}
				return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
			}

			async function newProject(name: string): Promise<string> {
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, lang: "th" }),
				})).json();
				return created.projectId;
			}

			async function solidJpeg(width: number, height: number, channel: number): Promise<Buffer> {
				const sharp = (await import("sharp")).default;
				return sharp({
					create: { width, height, channels: 3, background: { r: channel, g: channel, b: channel } },
				}).jpeg().toBuffer();
			}

			async function assetByImageId(projectId: string, imageId: string) {
				const list = await (await fetch(`${BASE}/images/${projectId}/assets`)).json();
				return list.assets.find((a: { imageId: string }) => a.imageId === imageId);
			}

			test("keep mode imports each image as its own page and preserves original_name", async () => {
				const projectId = await newProject("keep-mode");
				const fd = new FormData();
				fd.append("mode", "keep");
				fd.append("images", new Blob([await solidPng(40, 60, 10)], { type: "image/png" }), "page-a.png");
				fd.append("images", new Blob([await solidPng(40, 60, 20)], { type: "image/png" }), "page-b.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(200);
				const data = await res.json();
				expect(data.imageIds.length).toBe(2);
				const asset = await assetByImageId(projectId, data.imageIds[0]);
				expect(asset.originalName).toBe("page-a.png");
			});

			test("keep mode does NOT collapse intentionally identical pages", async () => {
				const projectId = await newProject("keep-dupe");
				const fd = new FormData();
				fd.append("mode", "keep");
				// Two byte-identical blank pages — keep mode promises 1 source = 1 page.
				const blank = await solidPng(40, 60, 255);
				fd.append("images", new Blob([blank], { type: "image/png" }), "blank-1.png");
				fd.append("images", new Blob([blank], { type: "image/png" }), "blank-2.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(200);
				const data = await res.json();
				expect(data.imageIds.length).toBe(2);
			});

			test("keep mode preserves the source extension and MIME for non-PNG inputs", async () => {
				const projectId = await newProject("keep-jpeg");
				const fd = new FormData();
				fd.append("mode", "keep");
				fd.append("images", new Blob([await solidJpeg(48, 64, 33)], { type: "image/jpeg" }), "photo.jpg");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(200);
				const data = await res.json();
				expect(data.imageIds.length).toBe(1);
				expect(data.imageIds[0].endsWith(".jpg")).toBe(true);
				const asset = await assetByImageId(projectId, data.imageIds[0]);
				expect(asset.mimeType).toBe("image/jpeg");
				expect(asset.originalName).toBe("photo.jpg");
			});

			test("merge mode stitches N-per-page into one tall page at median width", async () => {
				const projectId = await newProject("merge-mode");
				const fd = new FormData();
				fd.append("mode", "merge");
				fd.append("perPage", "2");
				fd.append("images", new Blob([await solidPng(40, 80, 10)], { type: "image/png" }), "01.png");
				fd.append("images", new Blob([await solidPng(60, 60, 20)], { type: "image/png" }), "02.png");
				fd.append("images", new Blob([await solidPng(50, 80, 30)], { type: "image/png" }), "03.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(200);
				const data = await res.json();
				// 3 images at perPage=2 -> 2 stitched pages ([01+02], [03]).
				expect(data.imageIds.length).toBe(2);
				const first = await assetByImageId(projectId, data.imageIds[0]);
				// First merged page scales 40px and 60px sources into median width 50:
				// 40x80 -> 50x100, 60x60 -> 50x50, then stacks vertically.
				expect(first.width).toBe(50);
				expect(first.height).toBe(150);
				expect(first.originalName).toBe("01+02.merged.png");
			});

			test("split mode slices a tall image above the threshold into chunks", async () => {
				const projectId = await newProject("split-mode");
				const fd = new FormData();
				fd.append("mode", "split");
				fd.append("splitThreshold", "300");
				fd.append("images", new Blob([await gradientPng(40, 700)], { type: "image/png" }), "tall.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(200);
				const data = await res.json();
				// 700px / 300px -> 300, 300, 100 = 3 chunks.
				expect(data.imageIds.length).toBe(3);
				const heights = (await Promise.all(
					data.imageIds.map((id: string) => assetByImageId(projectId, id)),
				)).map((a: { height: number }) => a.height);
				expect(heights).toEqual([300, 300, 100]);
			});

			test("split mode leaves short images as a single page", async () => {
				const projectId = await newProject("split-short");
				const fd = new FormData();
				fd.append("mode", "split");
				fd.append("splitThreshold", "5000");
				fd.append("images", new Blob([await solidPng(40, 400, 5)], { type: "image/png" }), "short.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(200);
				const data = await res.json();
				expect(data.imageIds.length).toBe(1);
			});

			test("merge mode dedupes identical produced pages by SHA", async () => {
				const projectId = await newProject("merge-dedupe");
				const fd = new FormData();
				fd.append("mode", "merge");
				fd.append("perPage", "2");
				// Two identical pairs -> two identical merged pages -> deduped to one.
				fd.append("images", new Blob([await solidPng(50, 50, 7)], { type: "image/png" }), "a.png");
				fd.append("images", new Blob([await solidPng(50, 50, 7)], { type: "image/png" }), "a.png");
				fd.append("images", new Blob([await solidPng(50, 50, 7)], { type: "image/png" }), "a.png");
				fd.append("images", new Blob([await solidPng(50, 50, 7)], { type: "image/png" }), "a.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(200);
				const data = await res.json();
				expect(data.imageIds.length).toBe(1);
			});

			test("applies the order spec before transform", async () => {
				const projectId = await newProject("merge-order");
				const fd = new FormData();
				fd.append("mode", "merge");
				fd.append("perPage", "2");
				fd.append("order", JSON.stringify([1, 0]));
				fd.append("images", new Blob([await solidPng(40, 40, 9)], { type: "image/png" }), "first.png");
				fd.append("images", new Blob([await solidPng(40, 40, 9)], { type: "image/png" }), "second.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(200);
				const data = await res.json();
				const merged = await assetByImageId(projectId, data.imageIds[0]);
				// order [1,0] makes second.png lead the merge trace.
				expect(merged.originalName).toBe("second+first.merged.png");
			});

			// Regression (codex P1, PR #439 R2): keep-mode commits the WHOLE batch before
			// responding, but the client XHR can still reject AFTER that commit (lost
			// response / timeout). The client retries the SAME batch with the SAME
			// `Idempotency-Key`; the server MUST replay the original committed imageIds
			// instead of re-committing — otherwise (keep-mode disables SHA dedupe) the
			// retry duplicates the assets and orphans the first commit's assets.
			test("keep mode replays a committed batch on a same-Idempotency-Key retry (no dup/orphan)", async () => {
				const projectId = await newProject("keep-idempotent");
				async function listAssetImageIds(): Promise<string[]> {
					const list = await (await fetch(`${BASE}/images/${projectId}/assets`)).json();
					return (list.assets as Array<{ imageId: string }>).map((a) => a.imageId).sort();
				}
				const batchKey = `batch-${crypto.randomUUID()}`;
				const buildForm = async () => {
					const fd = new FormData();
					fd.append("mode", "keep");
					fd.append("images", new Blob([await solidPng(40, 60, 11)], { type: "image/png" }), "p1.png");
					fd.append("images", new Blob([await solidPng(40, 60, 22)], { type: "image/png" }), "p2.png");
					return fd;
				};

				// First commit succeeds (this is the request whose RESPONSE the client loses).
				const first = await fetch(`${BASE}/images/${projectId}/upload-transform`, {
					method: "POST",
					headers: { "Idempotency-Key": batchKey },
					body: await buildForm(),
				});
				expect(first.status).toBe(200);
				const firstData = await first.json();
				expect(firstData.imageIds.length).toBe(2);
				const committedImageIds = [...firstData.imageIds].sort();
				const afterFirst = await listAssetImageIds();
				expect(afterFirst).toEqual(committedImageIds);

				// Client retries the SAME batch with the SAME key (fresh File blobs, as a
				// real reselect would produce). Server replays the original committed result.
				const retry = await fetch(`${BASE}/images/${projectId}/upload-transform`, {
					method: "POST",
					headers: { "Idempotency-Key": batchKey },
					body: await buildForm(),
				});
				expect(retry.status).toBe(200);
				const retryData = await retry.json();
				// SAME imageIds returned — not a fresh second commit.
				expect([...retryData.imageIds].sort()).toEqual(committedImageIds);
				// And crucially NO duplicate/orphaned assets: the asset set is unchanged.
				const afterRetry = await listAssetImageIds();
				expect(afterRetry).toEqual(committedImageIds);
			});

			test("rejects an invalid transform mode", async () => {
				const projectId = await newProject("bad-mode");
				const fd = new FormData();
				fd.append("mode", "bogus");
				fd.append("images", new Blob([await solidPng(40, 40, 1)], { type: "image/png" }), "x.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(400);
				const data = await res.json();
				expect(data.code).toBe("invalid_transform_mode");
			});

			test("rejects an order spec that does not cover every file", async () => {
				const projectId = await newProject("bad-order");
				const fd = new FormData();
				fd.append("mode", "keep");
				fd.append("order", JSON.stringify([0]));
				fd.append("images", new Blob([await solidPng(40, 40, 1)], { type: "image/png" }), "a.png");
				fd.append("images", new Blob([await solidPng(40, 40, 1)], { type: "image/png" }), "b.png");
				const res = await fetch(`${BASE}/images/${projectId}/upload-transform`, { method: "POST", body: fd });
				expect(res.status).toBe(400);
				const data = await res.json();
				expect(data.code).toBe("invalid_order");
			});
		});
	});

	describe("Export artifacts", () => {
		test("POST export artifact requires update rights because it mutates retained project state", async () => {
			const { createUser, deleteUser, generateTokens, loadUser, updateUser, markEmailVerified } = await import("../services/auth.service.js");
			const createdUser = await createUser({
				email: `viewer-export-artifact-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Viewer Export Artifact",
			});
			try {
				// Project creation now requires a verified email; confirm it first.
				await markEmailVerified(createdUser.user.id);
				const editorUser = await loadUser(createdUser.user.id);
				expect(editorUser).toBeTruthy();
				const editorTokens = await generateTokens(editorUser!);
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${editorTokens.accessToken}`,
					},
					body: JSON.stringify({ name: "Viewer Export Artifact Guard", lang: "th" }),
				})).json();
				const projectId = created.projectId;
				const state = await (await fetch(`${BASE}/project/${projectId}`, {
					headers: { Authorization: `Bearer ${editorTokens.accessToken}` },
				})).json();
				state.exportRuns = [{
					id: "export-viewer-artifact",
					kind: "batch-zip",
					status: "done",
					filename: "viewer.zip",
					pageIndexes: [0],
					pageCount: 1,
					bytes: 0,
					message: "Exported viewer.zip",
					createdAt: "2026-05-28T00:00:00.000Z",
					completedAt: "2026-05-28T00:00:00.000Z",
				}];
				await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${editorTokens.accessToken}`,
					},
					body: JSON.stringify(state),
				});
				await updateUser(createdUser.user.id, { role: "viewer" });

				const formData = new FormData();
				formData.append("filename", "viewer.zip");
				formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "viewer.zip");
				const upload = await fetch(`${BASE}/project/${projectId}/exports/export-viewer-artifact/artifact`, {
					method: "POST",
					headers: { Authorization: `Bearer ${editorTokens.accessToken}` },
					body: formData,
				});

				expect(upload.status).toBe(403);
				expect(await upload.json()).toEqual(expect.objectContaining({
					error: "Forbidden: Missing permission 'update:project'",
				}));
			} finally {
				await deleteUser(createdUser.user.id);
			}
		});

		test("POST/GET /api/project/:id/exports/:runId/artifact persists and serves a batch ZIP", async () => {
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Export Artifact Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-route-test",
				kind: "batch-zip",
				status: "done",
				filename: "chapter.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported chapter.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			// Seed exportRuns on disk directly: the general `/save` is server-
			// authoritative for exportRuns (it keeps its persisted copy and ignores the
			// body's, so a stale save can't drop a concurrent export-run change), so the
			// artifact endpoints' fixture run must be written to `state.json`.
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			const formData = new FormData();
			formData.append("filename", "chapter.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "chapter.zip");

			const upload = await fetch(`${BASE}/project/${projectId}/exports/export-route-test/artifact`, {
				method: "POST",
				body: formData,
			});
			expect(upload.status).toBe(200);
			const uploadBody = await upload.json();
			expect(uploadBody.artifact).toMatchObject({
				exportId: "export-route-test.zip",
				filename: "chapter.zip",
				mimeType: "application/zip",
				sizeBytes: 7,
			});
			expect(uploadBody.storageQuota).toMatchObject({
				exportArtifactBytes: 7,
				exportArtifactCount: 1,
			});

			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].artifact).toMatchObject({
				exportId: "export-route-test.zip",
				filename: "chapter.zip",
			});

			const download = await fetch(`${BASE}/project/${projectId}/exports/export-route-test/artifact`);
			expect(download.status).toBe(200);
			expect(download.headers.get("Content-Type")).toBe("application/zip");
			expect(download.headers.get("Content-Disposition")).toContain("chapter.zip");
			expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(await download.text()).toBe("zipdata");
		});

		// P3 fix: the export-run artifact download must meter egress (so authorized
		// clients can't pull huge chapter ZIPs through backend memory unmetered) AND
		// stream the object instead of buffering the whole thing into one Buffer.
		test("GET export-run artifact records egress per download and streams (no full-buffer read)", async () => {
			const { setAssetEgressStoreForTesting, MemoryAssetEgressStore } = await import("../services/egress-accounting.js");
			const { objectStorage } = await import("../services/storage.js");

			// Recording spy meter (mirrors the image-serve metering). Wraps the real
			// in-memory store and captures every recordWithAllowance call so we can
			// assert the served export bytes were metered.
			const recorded: Array<{ projectId: string; imageId: string; purpose: string; bytes: number; statusCode: number; skipAbuseReservation?: boolean }> = [];
			const inner = new MemoryAssetEgressStore();
			setAssetEgressStoreForTesting({
				record: (input) => inner.record(input),
				recordWithAllowance: (input) => {
					recorded.push({ projectId: input.projectId, imageId: input.imageId, purpose: input.purpose, bytes: input.bytes, statusCode: input.statusCode, skipAbuseReservation: input.skipAbuseReservation });
					return inner.recordWithAllowance(input);
				},
				summarize: (projectId, now) => inner.summarize(projectId, now),
			});

			// Assert the route uses the STREAMING storage path, not the full-buffer one.
			const streamSpy = spyOn(objectStorage, "getProjectExportStream");
			const bufferSpy = spyOn(objectStorage, "getProjectExport");

			try {
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Export Stream Meter Project", lang: "th" }),
				})).json();
				const projectId = created.projectId;

				// Write the artifact object directly, then reference it from a done run.
				const zipBytes = Buffer.from("PK-streamed-export-artifact-payload");
				await objectStorage.putProjectExport({ projectId, exportId: "export-stream-meter.zip", buffer: zipBytes });

				const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
				state.exportRuns = [{
					id: "export-stream-meter",
					kind: "batch-zip",
					status: "done",
					filename: "metered.zip",
					pageIndexes: [0],
					pageCount: 1,
					bytes: zipBytes.byteLength,
					message: "Exported metered.zip",
					createdAt: "2026-05-29T00:00:00.000Z",
					completedAt: "2026-05-29T00:00:00.000Z",
					artifact: {
						exportId: "export-stream-meter.zip",
						filename: "metered.zip",
						mimeType: "application/zip",
						sizeBytes: zipBytes.byteLength,
					},
				}];
				const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
				writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

				const download = await fetch(`${BASE}/project/${projectId}/exports/export-stream-meter/artifact`);
				expect(download.status).toBe(200);
				expect(download.headers.get("Content-Type")).toBe("application/zip");
				expect(download.headers.get("Content-Disposition")).toContain("metered.zip");
				expect(download.headers.get("X-Asset-Egress-Bytes")).toBe(String(zipBytes.byteLength));
				expect(await download.text()).toBe(zipBytes.toString());

				// Streaming path used; full-buffer read NOT used for the download.
				expect(streamSpy).toHaveBeenCalled();
				expect(bufferSpy).not.toHaveBeenCalled();

				// Egress recorded once for the served export bytes, with the abuse
				// reservation already taken (skipAbuseReservation) so it isn't double counted.
				const exportRecords = recorded.filter((r) => r.projectId === projectId);
				expect(exportRecords).toHaveLength(1);
				expect(exportRecords[0]).toMatchObject({
					projectId,
					purpose: "export",
					bytes: zipBytes.byteLength,
					statusCode: 200,
					skipAbuseReservation: true,
				});
			} finally {
				streamSpy.mockRestore();
				bufferSpy.mockRestore();
				const { resetEgressAccountingForTesting } = await import("../services/egress-accounting.js");
				resetEgressAccountingForTesting();
			}
		});

		// P3 fix: the per-object export download (/api/export/:id/objects/:objectId)
		// must likewise meter egress and stream instead of full-buffering.
		test("GET export object records egress per download and streams (no full-buffer read)", async () => {
			const { setAssetEgressStoreForTesting, MemoryAssetEgressStore } = await import("../services/egress-accounting.js");
			const { objectStorage } = await import("../services/storage.js");
			const { exportJobStore } = await import("../services/export-pipeline.js");

			const recorded: Array<{ projectId: string; imageId: string; purpose: string; bytes: number; statusCode: number; skipAbuseReservation?: boolean }> = [];
			const inner = new MemoryAssetEgressStore();
			setAssetEgressStoreForTesting({
				record: (input) => inner.record(input),
				recordWithAllowance: (input) => {
					recorded.push({ projectId: input.projectId, imageId: input.imageId, purpose: input.purpose, bytes: input.bytes, statusCode: input.statusCode, skipAbuseReservation: input.skipAbuseReservation });
					return inner.recordWithAllowance(input);
				},
				summarize: (projectId, now) => inner.summarize(projectId, now),
			});
			const streamSpy = spyOn(objectStorage, "getProjectExportStream");
			const bufferSpy = spyOn(objectStorage, "getProjectExport");

			try {
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Export Object Stream Project", lang: "th" }),
				})).json();
				const projectId = created.projectId;

				const objectId = "export-job-output/page-001.jpg";
				const objectBytes = Buffer.from("streamed-single-export-object-bytes");
				await objectStorage.putProjectExport({ projectId, exportId: objectId, buffer: objectBytes });

				// Seed a done job that recorded this object as a produced output so the
				// route's jobProducedObject guard passes.
				const job = await exportJobStore.create({
					id: "export-object-job-1",
					projectId,
					preset: "webtoon",
					status: "done",
					params: {
						outputs: [{ objectId, contentType: "image/jpeg", sizeBytes: objectBytes.byteLength }],
					},
					createdAt: "2026-05-29T00:00:00.000Z",
					completedAt: "2026-05-29T00:00:00.000Z",
				} as Parameters<typeof exportJobStore.create>[0]);

				const path = `/api/export/${encodeURIComponent(job.id)}/objects/${objectId.split("/").map(encodeURIComponent).join("/")}`;
				const download = await fetch(`${LOCAL_API_ORIGIN}${path}`);
				expect(download.status).toBe(200);
				expect(download.headers.get("Content-Type")).toBe("image/jpeg");
				expect(download.headers.get("X-Asset-Egress-Bytes")).toBe(String(objectBytes.byteLength));
				expect(await download.text()).toBe(objectBytes.toString());

				expect(streamSpy).toHaveBeenCalled();
				expect(bufferSpy).not.toHaveBeenCalled();

				const exportRecords = recorded.filter((r) => r.projectId === projectId);
				expect(exportRecords).toHaveLength(1);
				expect(exportRecords[0]).toMatchObject({
					projectId,
					imageId: objectId,
					purpose: "export",
					bytes: objectBytes.byteLength,
					statusCode: 200,
					skipAbuseReservation: true,
				});
			} finally {
				streamSpy.mockRestore();
				bufferSpy.mockRestore();
				const { resetEgressAccountingForTesting } = await import("../services/egress-accounting.js");
				resetEgressAccountingForTesting();
			}
		});

		test("POST export artifact reserves quota around retained artifact writes", async () => {
			const {
				MemoryStorageQuotaReservationStore,
				setStorageQuotaReservationStoreForTests,
			} = await import("../services/storage-quota.js");
			const memoryStore = new MemoryStorageQuotaReservationStore();
			const reserves: any[] = [];
			const releases: string[] = [];
			const restore = setStorageQuotaReservationStoreForTests({
				reserve: async (input) => {
					reserves.push(input);
					return memoryStore.reserve(input);
				},
				release: async (projectId, reservationId) => {
					releases.push(reservationId);
					return memoryStore.release(projectId, reservationId);
				},
				listActive: (projectId, now) => memoryStore.listActive(projectId, now),
			});
			try {
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Reserved Export Artifact Project", lang: "th" }),
				})).json();
				const projectId = created.projectId;
				const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
				state.exportRuns = [{
					id: "export-reserved-artifact",
					kind: "batch-zip",
					status: "done",
					filename: "reserved.zip",
					pageIndexes: [0],
					pageCount: 1,
					bytes: 0,
					message: "Exported reserved.zip",
					createdAt: "2026-05-17T00:00:00.000Z",
					completedAt: "2026-05-17T00:00:00.000Z",
				}];
				// Seed exportRuns on disk directly (general `/save` is server-
				// authoritative for exportRuns — see batch-ZIP test above).
				const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
				writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

				const formData = new FormData();
				formData.append("filename", "reserved.zip");
				formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "reserved.zip");

				const upload = await fetch(`${BASE}/project/${projectId}/exports/export-reserved-artifact/artifact`, {
					method: "POST",
					body: formData,
				});

				expect(upload.status).toBe(200);
				expect(reserves).toContainEqual(expect.objectContaining({
					projectId,
					bytes: 7,
					reason: "export_artifact",
				}));
				expect(releases).toHaveLength(1);
				expect(await memoryStore.listActive(projectId)).toHaveLength(0);
			} finally {
				restore();
			}
		});

		test("GET export artifact returns 404 before an artifact exists", async () => {
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Missing Export Artifact Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-missing-artifact",
				kind: "batch-zip",
				status: "done",
				filename: "missing.zip",
				pageIndexes: [0],
				pageCount: 1,
				message: "Exported missing.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const download = await fetch(`${BASE}/project/${projectId}/exports/export-missing-artifact/artifact`);
			expect(download.status).toBe(404);
		});

		test("DELETE export artifact removes the stored ZIP without deleting history", async () => {
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Delete Export Artifact Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-delete-artifact",
				kind: "batch-zip",
				status: "done",
				filename: "delete-me.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported delete-me.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			// Seed exportRuns on disk directly (general `/save` is server-authoritative
			// for exportRuns — see batch-ZIP test above).
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			const formData = new FormData();
			formData.append("filename", "delete-me.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "delete-me.zip");
			const upload = await fetch(`${BASE}/project/${projectId}/exports/export-delete-artifact/artifact`, {
				method: "POST",
				body: formData,
			});
			expect(upload.status).toBe(200);

			const remove = await fetch(`${BASE}/project/${projectId}/exports/export-delete-artifact/artifact`, {
				method: "DELETE",
			});
			expect(remove.status).toBe(200);
			const removeBody = await remove.json();
			expect(removeBody.deleted).toBe(true);
			expect(removeBody.exportRun.filename).toBe("delete-me.zip");
			expect(removeBody.exportRun.artifact).toBeUndefined();
			expect(removeBody.storageQuota.exportArtifactBytes).toBe(0);

			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].filename).toBe("delete-me.zip");
			expect(loaded.exportRuns[0].artifact).toBeUndefined();

			const download = await fetch(`${BASE}/project/${projectId}/exports/export-delete-artifact/artifact`);
			expect(download.status).toBe(404);
		});

		test("POST export artifact is blocked by workspace storage quota", async () => {
			const previousIncluded = process.env.WORKSPACE_STORAGE_INCLUDED_BYTES;
			const previousExtra = process.env.WORKSPACE_STORAGE_EXTRA_BYTES;
			const previousEnforced = process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED;
			process.env.WORKSPACE_STORAGE_INCLUDED_BYTES = "1";
			process.env.WORKSPACE_STORAGE_EXTRA_BYTES = "0";
			process.env.WORKSPACE_STORAGE_QUOTA_ENFORCED = "true";

			try {
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Quota Export Artifact Project", lang: "th" }),
				})).json();
				const projectId = created.projectId;
				const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
				state.exportRuns = [{
					id: "export-quota-artifact",
					kind: "batch-zip",
					status: "done",
					filename: "quota.zip",
					pageIndexes: [0],
					pageCount: 1,
					message: "Exported quota.zip",
					createdAt: "2026-05-17T00:00:00.000Z",
					completedAt: "2026-05-17T00:00:00.000Z",
				}];
				// Seed exportRuns on disk directly (general `/save` is server-
				// authoritative for exportRuns — see batch-ZIP test above).
				const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
				writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

				const formData = new FormData();
				formData.append("filename", "quota.zip");
				formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "quota.zip");

				const upload = await fetch(`${BASE}/project/${projectId}/exports/export-quota-artifact/artifact`, {
					method: "POST",
					body: formData,
				});
				expect(upload.status).toBe(413);
				const body = await upload.json();
				expect(body.code).toBe("storage_quota_exceeded");
				expect(body.reason).toBe("export_artifact");
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

		test("POST export artifact runs a compensating delete (no orphaned object) when the state commit fails", async () => {
			const { setExportArtifactStateWriteFailureForTests } = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Orphan Export Artifact Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-orphan-artifact",
				kind: "batch-zip",
				status: "done",
				filename: "orphan.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported orphan.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			const formData = new FormData();
			formData.append("filename", "orphan.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "orphan.zip");

			// Force the state commit (after the object is written) to throw, simulating
			// a failed persistence write mid-upload.
			setExportArtifactStateWriteFailureForTests(() => {
				throw new Error("simulated state-commit failure");
			});
			let upload: Response;
			try {
				upload = await fetch(`${BASE}/project/${projectId}/exports/export-orphan-artifact/artifact`, {
					method: "POST",
					body: formData,
				});
			} finally {
				setExportArtifactStateWriteFailureForTests(null);
			}

			// The request fails (500) — but the just-written object must NOT be left
			// orphaned: the compensating delete should have removed it.
			expect(upload.status).toBe(500);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-orphan-artifact.zip" })).toBe(false);

			// State never gained a reference, so the artifact stays undefined.
			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].artifact).toBeUndefined();
		});

		test("POST export artifact keeps the committed artifact when the POST-COMMIT version snapshot fails (no compensating delete, download returns bytes)", async () => {
			const { setExportArtifactVersionSnapshotFailureForTests } = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Post-Commit Snapshot Failure Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-postcommit-artifact",
				kind: "batch-zip",
				status: "done",
				filename: "postcommit.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported postcommit.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			const formData = new FormData();
			formData.append("filename", "postcommit.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "postcommit.zip");

			// Force the POST-COMMIT version snapshot to throw. The state commit has
			// already durably referenced the new object, so this must NOT trigger a
			// compensating delete and must NOT fail the upload as if the artifact is gone.
			setExportArtifactVersionSnapshotFailureForTests(() => {
				throw new Error("simulated post-commit version-snapshot failure");
			});
			let upload: Response;
			try {
				upload = await fetch(`${BASE}/project/${projectId}/exports/export-postcommit-artifact/artifact`, {
					method: "POST",
					body: formData,
				});
			} finally {
				setExportArtifactVersionSnapshotFailureForTests(null);
			}

			// The artifact is committed: upload still succeeds and the object survives.
			expect(upload.status).toBe(200);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-postcommit-artifact.zip" })).toBe(true);

			// The reference is durably persisted...
			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].artifact).toMatchObject({ exportId: "export-postcommit-artifact.zip" });

			// ...and the download returns the real bytes, NOT a 404.
			const download = await fetch(`${BASE}/project/${projectId}/exports/export-postcommit-artifact/artifact`);
			expect(download.status).toBe(200);
			expect(await download.text()).toBe("zipdata");
		});

		test("POST export artifact keeps the committed artifact when only the CATALOG sync throws (durable file commit already references it; no compensating delete, file-fallback download returns bytes)", async () => {
			const { setExportArtifactCatalogSyncFailureForTests } = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Catalog-Sync Failure Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-catalog-artifact",
				kind: "batch-zip",
				status: "done",
				filename: "catalog.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported catalog.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			const formData = new FormData();
			formData.append("filename", "catalog.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "catalog.zip");

			// Force ONLY the catalog sync to throw — but writeProjectState has already
			// written state.json durably (the file-fallback read source) before the
			// catalog mirror runs. The file already references the artifact, so this is
			// a secondary-store desync, NOT a lost durable reference. It must NOT trigger
			// a compensating delete: the artifact stays committed + downloadable.
			setExportArtifactCatalogSyncFailureForTests(() => {
				throw new Error("simulated catalog-sync-only failure");
			});
			let upload: Response;
			try {
				upload = await fetch(`${BASE}/project/${projectId}/exports/export-catalog-artifact/artifact`, {
					method: "POST",
					body: formData,
				});
			} finally {
				setExportArtifactCatalogSyncFailureForTests(null);
			}

			// The artifact is committed (file commit succeeded): upload still succeeds
			// and the object survives — no compensating delete ran.
			expect(upload.status).toBe(200);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-catalog-artifact.zip" })).toBe(true);

			// The file-backed state still references the artifact...
			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].artifact).toMatchObject({ exportId: "export-catalog-artifact.zip" });

			// ...and the file-fallback download returns the real bytes, NOT a 404.
			const download = await fetch(`${BASE}/project/${projectId}/exports/export-catalog-artifact/artifact`);
			expect(download.status).toBe(200);
			expect(await download.text()).toBe("zipdata");
		});

		test("POST export artifact FAILS + compensating-deletes the object when the CATALOG sync throws and file-fallback is DISABLED (Postgres-authoritative read source has no artifact reference; no orphan, no success-then-404)", async () => {
			const { setExportArtifactCatalogSyncFailureForTests } = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { serverConfig, PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
			const { projectCatalogStore } = await import("../services/project-catalog.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Catalog-Authoritative Failure Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-pg-artifact",
				kind: "batch-zip",
				status: "done",
				filename: "pg.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported pg.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			// Mirror the export run into BOTH the file and the catalog: with file-fallback
			// disabled the upload route reads the run from the catalog (the authoritative
			// read source), so it must exist there before the upload starts.
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));
			await projectCatalogStore!.upsertProjectState(state);

			const formData = new FormData();
			formData.append("filename", "pg.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "pg.zip");

			// Postgres-authoritative deployment: loadProjectState() reads the CATALOG row
			// first and never consults the durable state.json file. So the artifact is
			// only committed once the catalog sync SUCCEEDS. Force the catalog sync to
			// throw: catalogSync:"required" (chosen because file-fallback is disabled)
			// must let it propagate → stateCommitted stays false → the just-written
			// object is compensating-deleted (no orphan) and the upload reports failure.
			const prevFallback = serverConfig.projectCatalogFileFallbackEnabled;
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				projectCatalogFileFallbackEnabled: false,
			});
			setExportArtifactCatalogSyncFailureForTests(() => {
				throw new Error("simulated catalog-sync failure (postgres-authoritative)");
			});
			let upload: Response;
			try {
				upload = await fetch(`${BASE}/project/${projectId}/exports/export-pg-artifact/artifact`, {
					method: "POST",
					body: formData,
				});
			} finally {
				setExportArtifactCatalogSyncFailureForTests(null);
			}

			// With file-fallback DISABLED the catalog IS the read source, so a catalog-sync
			// throw means the read source never gained the artifact reference. The upload
			// MUST fail (catalogSync:"required" let the throw propagate → stateCommitted
			// stayed false) rather than report a success that later 404s.
			expect(upload.status).toBe(500);
			// ...and the just-written object MUST be compensating-deleted (no orphan): the
			// read source has no reference to it, so leaving the bytes would be a pure
			// orphan, and a later download is a clean 404 (object gone), not success-then-404.
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-pg-artifact.zip" })).toBe(false);
			const download = await fetch(`${BASE}/project/${projectId}/exports/export-pg-artifact/artifact`);
			expect(download.status).toBe(404);

			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				projectCatalogFileFallbackEnabled: prevFallback,
			});
		});

		test("POST export artifact COMMITS (downloadable, no delete) on full success with file-fallback DISABLED (catalog read source references the artifact)", async () => {
			const { objectStorage } = await import("../services/storage.js");
			const { serverConfig, PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
			const { projectCatalogStore } = await import("../services/project-catalog.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Catalog-Authoritative Success Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-pg-ok",
				kind: "batch-zip",
				status: "done",
				filename: "pg-ok.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported pg-ok.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));
			await projectCatalogStore!.upsertProjectState(state);

			const formData = new FormData();
			formData.append("filename", "pg-ok.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "pg-ok.zip");

			const prevFallback = serverConfig.projectCatalogFileFallbackEnabled;
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				projectCatalogFileFallbackEnabled: false,
			});
			let upload: Response;
			try {
				upload = await fetch(`${BASE}/project/${projectId}/exports/export-pg-ok/artifact`, {
					method: "POST",
					body: formData,
				});
			} finally {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					projectCatalogFileFallbackEnabled: prevFallback,
				});
			}

			// Full success: catalog sync succeeded, so the catalog read source references
			// the artifact and the object survives + downloads.
			expect(upload.status).toBe(200);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-pg-ok.zip" })).toBe(true);
			const loadedCatalog = await projectCatalogStore!.getProjectState(projectId);
			expect(loadedCatalog?.exportRuns?.[0]?.artifact).toMatchObject({ exportId: "export-pg-ok.zip" });
			const download = await fetch(`${BASE}/project/${projectId}/exports/export-pg-ok/artifact`);
			expect(download.status).toBe(200);
			expect(await download.text()).toBe("zipdata");
		});

		test("DELETE export artifact never leaves a ghost reference when the state commit fails (object intact + still referenced)", async () => {
			const { setExportArtifactStateWriteFailureForTests } = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Ghost Export Artifact Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-ghost-artifact",
				kind: "batch-zip",
				status: "done",
				filename: "ghost.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported ghost.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			const formData = new FormData();
			formData.append("filename", "ghost.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "ghost.zip");
			const upload = await fetch(`${BASE}/project/${projectId}/exports/export-ghost-artifact/artifact`, {
				method: "POST",
				body: formData,
			});
			expect(upload.status).toBe(200);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-ghost-artifact.zip" })).toBe(true);

			// Force the reference-removal state commit to fail. The state-first ordering
			// means the physical delete must NOT have run yet, so the object stays and
			// the reference stays — consistent + retryable, never a dangling pointer.
			setExportArtifactStateWriteFailureForTests(() => {
				throw new Error("simulated state-commit failure");
			});
			let remove: Response;
			try {
				remove = await fetch(`${BASE}/project/${projectId}/exports/export-ghost-artifact/artifact`, {
					method: "DELETE",
				});
			} finally {
				setExportArtifactStateWriteFailureForTests(null);
			}
			expect(remove.status).toBe(500);

			// Object still present (delete never ran) AND the reference is still there:
			// the download works, so there is no ghost reference to a deleted object.
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-ghost-artifact.zip" })).toBe(true);
			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].artifact).toMatchObject({ exportId: "export-ghost-artifact.zip" });
			const download = await fetch(`${BASE}/project/${projectId}/exports/export-ghost-artifact/artifact`);
			expect(download.status).toBe(200);
			expect(await download.text()).toBe("zipdata");
		});

		test("DELETE export artifact SUCCEEDS (reference removed, object physically deleted, no orphan, no 500) when the CATALOG sync throws and file-fallback is ENABLED (file is the read source)", async () => {
			const { setExportArtifactCatalogSyncFailureForTests } = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Delete Catalog-Sync Failure (file-fallback) Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-del-catalog-file",
				kind: "batch-zip",
				status: "done",
				filename: "del-catalog.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported del-catalog.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			const formData = new FormData();
			formData.append("filename", "del-catalog.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "del-catalog.zip");
			const upload = await fetch(`${BASE}/project/${projectId}/exports/export-del-catalog-file/artifact`, {
				method: "POST",
				body: formData,
			});
			expect(upload.status).toBe(200);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-del-catalog-file.zip" })).toBe(true);

			// Force ONLY the catalog sync to throw on the reference-removal commit. With
			// file-fallback ENABLED the durable state.json file IS the read source and is
			// written FIRST, so the reference is already removed from the read source. The
			// catalog throw is a secondary-store desync and must NOT abort the delete with a
			// 500 (which would strand the now-unreferenced object as an orphan while the user
			// already lost the artifact). catalogSync:"best-effort" swallows it and the
			// physical delete proceeds.
			setExportArtifactCatalogSyncFailureForTests(() => {
				throw new Error("simulated catalog-sync-only failure (delete, file-fallback)");
			});
			let remove: Response;
			try {
				remove = await fetch(`${BASE}/project/${projectId}/exports/export-del-catalog-file/artifact`, {
					method: "DELETE",
				});
			} finally {
				setExportArtifactCatalogSyncFailureForTests(null);
			}

			// No 500: the operation succeeded because the file read source no longer
			// references the artifact.
			expect(remove.status).toBe(200);
			const removeBody = await remove.json();
			expect(removeBody.deleted).toBe(true);
			expect(removeBody.exportRun.artifact).toBeUndefined();

			// The object was physically deleted — no orphan left behind.
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-del-catalog-file.zip" })).toBe(false);

			// The file-backed read source no longer references the artifact, and the download
			// is a clean 404 (gone), not success-then-ghost.
			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].artifact).toBeUndefined();
			const download = await fetch(`${BASE}/project/${projectId}/exports/export-del-catalog-file/artifact`);
			expect(download.status).toBe(404);
		});

		test("DELETE export artifact FAILS cleanly (reference + object intact, retryable, no ghost) when the CATALOG sync throws and file-fallback is DISABLED (catalog is the read source)", async () => {
			const { setExportArtifactCatalogSyncFailureForTests } = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { serverConfig, PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
			const { projectCatalogStore } = await import("../services/project-catalog.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Delete Catalog-Sync Failure (postgres) Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-del-catalog-pg",
				kind: "batch-zip",
				status: "done",
				filename: "del-pg.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported del-pg.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));
			await projectCatalogStore!.upsertProjectState(state);

			const formData = new FormData();
			formData.append("filename", "del-pg.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "del-pg.zip");
			// Postgres-authoritative deployment: loadProjectState() reads the CATALOG row
			// first and never consults the file. Run the whole upload + delete in this mode
			// so the catalog is the read source throughout.
			const prevFallback = serverConfig.projectCatalogFileFallbackEnabled;
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				projectCatalogFileFallbackEnabled: false,
			});
			let remove: Response;
			try {
				const uploadResp = await fetch(`${BASE}/project/${projectId}/exports/export-del-catalog-pg/artifact`, {
					method: "POST",
					body: formData,
				});
				expect(uploadResp.status).toBe(200);
				expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-del-catalog-pg.zip" })).toBe(true);

				// Force the catalog sync to throw on the reference-removal commit:
				// catalogSync:"required" (chosen because file-fallback is disabled) must let it
				// propagate → the operation fails cleanly BEFORE the physical delete runs, with
				// the OBJECT still intact (retryable), never a ghost (reference → missing object).
				setExportArtifactCatalogSyncFailureForTests(() => {
					throw new Error("simulated catalog-sync failure (delete, postgres-authoritative)");
				});
				try {
					remove = await fetch(`${BASE}/project/${projectId}/exports/export-del-catalog-pg/artifact`, {
						method: "DELETE",
					});
				} finally {
					setExportArtifactCatalogSyncFailureForTests(null);
				}

				// The delete MUST fail (required catalog sync threw → reference-removal not
				// durably committed to the Postgres read source).
				expect(remove.status).toBe(500);
				// The anti-ghost guarantee: because the required catalog commit propagated BEFORE
				// the physical delete, the object is still present — a retry can re-drive the whole
				// operation. (NB: the test harness FileProjectCatalogStore reads from the same
				// state.json that writeProjectState wrote, so the catalog ROW contents cannot be
				// asserted "intact" here the way they could against a real Postgres store; the
				// load-bearing route invariant — no physical delete on a failed required sync — is
				// the object-presence check below.)
				expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-del-catalog-pg.zip" })).toBe(true);
			} finally {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					projectCatalogFileFallbackEnabled: prevFallback,
				});
			}
		});

		test("DELETE export artifact SUCCEEDS on full success with file-fallback DISABLED (catalog reference removed + object deleted)", async () => {
			const { objectStorage } = await import("../services/storage.js");
			const { serverConfig, PROJECTS_DIR: exportProjectsDir } = await import("../config.js");
			const { projectCatalogStore } = await import("../services/project-catalog.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Delete Full-Success (postgres) Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-del-pg-ok",
				kind: "batch-zip",
				status: "done",
				filename: "del-pg-ok.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported del-pg-ok.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));
			await projectCatalogStore!.upsertProjectState(state);

			const formData = new FormData();
			formData.append("filename", "del-pg-ok.zip");
			formData.append("artifact", new Blob(["zipdata"], { type: "application/zip" }), "del-pg-ok.zip");
			const uploadResp = await fetch(`${BASE}/project/${projectId}/exports/export-del-pg-ok/artifact`, {
				method: "POST",
				body: formData,
			});
			expect(uploadResp.status).toBe(200);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-del-pg-ok.zip" })).toBe(true);

			const prevFallback = serverConfig.projectCatalogFileFallbackEnabled;
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				projectCatalogFileFallbackEnabled: false,
			});
			let remove: Response;
			try {
				remove = await fetch(`${BASE}/project/${projectId}/exports/export-del-pg-ok/artifact`, {
					method: "DELETE",
				});
			} finally {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					projectCatalogFileFallbackEnabled: prevFallback,
				});
			}

			// Full success in Postgres mode: catalog reference removed + object deleted.
			expect(remove.status).toBe(200);
			const removeBody = await remove.json();
			expect(removeBody.deleted).toBe(true);
			expect(removeBody.exportRun.artifact).toBeUndefined();
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-del-pg-ok.zip" })).toBe(false);
			const loadedCatalog = await projectCatalogStore!.getProjectState(projectId);
			expect(loadedCatalog?.exportRuns?.[0]?.artifact).toBeUndefined();
		});

		test("POST export artifact with an oversized declared Content-Length is rejected before buffering", async () => {
			const { serverConfig } = await import("../config.js");
			const previousLimit = serverConfig.maxUploadBatchSizeBytes;
			// Shrink the per-upload cap so a small test body is "oversized".
			(serverConfig as unknown as Record<string, unknown>).maxUploadBatchSizeBytes = 16;
			try {
				const created = await (await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Oversized Export Artifact Project", lang: "th" }),
				})).json();
				const projectId = created.projectId;

				// Declared Content-Length far exceeds the cap → must 413 before formData()
				// ever buffers the body.
				const response = await fetch(`${BASE}/project/${projectId}/exports/export-oversized-artifact/artifact`, {
					method: "POST",
					headers: {
						"content-type": "multipart/form-data; boundary=----x",
						"content-length": "1048576",
					},
					body: "data".repeat(64),
				});

				expect(response.status).toBe(413);
				expect(await response.json()).toEqual(expect.objectContaining({ code: "request_body_too_large" }));
			} finally {
				(serverConfig as unknown as Record<string, unknown>).maxUploadBatchSizeBytes = previousLimit;
			}
		});

		test("REPLACEMENT export artifact whose state commit FAILS leaves the OLD artifact bytes intact + still referenced (no data loss)", async () => {
			const {
				setExportArtifactStateWriteFailureForTests,
				setExportObjectSuffixForTests,
			} = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Replace Fail Export Artifact Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-replace-fail",
				kind: "batch-zip",
				status: "done",
				filename: "v1.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported v1.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			// First (successful) upload establishes the live artifact at `${runId}.zip`.
			const firstForm = new FormData();
			firstForm.append("filename", "v1.zip");
			firstForm.append("artifact", new Blob(["ORIGINAL-BYTES"], { type: "application/zip" }), "v1.zip");
			const first = await fetch(`${BASE}/project/${projectId}/exports/export-replace-fail/artifact`, {
				method: "POST",
				body: firstForm,
			});
			expect(first.status).toBe(200);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-replace-fail.zip" })).toBe(true);

			// Replacement upload: force a deterministic versioned id, and make the
			// state commit fail AFTER the new object is written.
			setExportObjectSuffixForTests(() => "ver2");
			setExportArtifactStateWriteFailureForTests(() => {
				throw new Error("simulated state-commit failure");
			});
			let replace: Response;
			try {
				const replaceForm = new FormData();
				replaceForm.append("filename", "v2.zip");
				replaceForm.append("artifact", new Blob(["REPLACEMENT-BYTES"], { type: "application/zip" }), "v2.zip");
				replace = await fetch(`${BASE}/project/${projectId}/exports/export-replace-fail/artifact`, {
					method: "POST",
					body: replaceForm,
				});
			} finally {
				setExportArtifactStateWriteFailureForTests(null);
				setExportObjectSuffixForTests(null);
			}
			expect(replace.status).toBe(500);

			// The OLD object must be untouched: same bytes, still referenced, still
			// downloadable. The replacement wrote a NEW id, so the live artifact was
			// never overwritten.
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-replace-fail.zip" })).toBe(true);
			// The new temp object must have been compensating-deleted (no orphan).
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-replace-fail-ver2.zip" })).toBe(false);

			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].artifact).toMatchObject({ exportId: "export-replace-fail.zip" });
			const download = await fetch(`${BASE}/project/${projectId}/exports/export-replace-fail/artifact`);
			expect(download.status).toBe(200);
			expect(await download.text()).toBe("ORIGINAL-BYTES");
		});

		test("REPLACEMENT export artifact SUCCESS swaps the reference to the new object and GCs the old object", async () => {
			const { setExportObjectSuffixForTests } = await import("../routes/project.js");
			const { objectStorage } = await import("../services/storage.js");
			const { PROJECTS_DIR: exportProjectsDir } = await import("../config.js");

			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Replace OK Export Artifact Project", lang: "th" }),
			})).json();
			const projectId = created.projectId;
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.exportRuns = [{
				id: "export-replace-ok",
				kind: "batch-zip",
				status: "done",
				filename: "v1.zip",
				pageIndexes: [0],
				pageCount: 1,
				bytes: 0,
				message: "Exported v1.zip",
				createdAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.000Z",
			}];
			writeFileSync(join(exportProjectsDir, projectId, "state.json"), JSON.stringify(state, null, 2));

			const firstForm = new FormData();
			firstForm.append("filename", "v1.zip");
			firstForm.append("artifact", new Blob(["ORIGINAL-BYTES"], { type: "application/zip" }), "v1.zip");
			const first = await fetch(`${BASE}/project/${projectId}/exports/export-replace-ok/artifact`, {
				method: "POST",
				body: firstForm,
			});
			expect(first.status).toBe(200);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-replace-ok.zip" })).toBe(true);

			setExportObjectSuffixForTests(() => "ver2");
			let replace: Response;
			try {
				const replaceForm = new FormData();
				replaceForm.append("filename", "v2.zip");
				replaceForm.append("artifact", new Blob(["REPLACEMENT-BYTES"], { type: "application/zip" }), "v2.zip");
				replace = await fetch(`${BASE}/project/${projectId}/exports/export-replace-ok/artifact`, {
					method: "POST",
					body: replaceForm,
				});
			} finally {
				setExportObjectSuffixForTests(null);
			}
			expect(replace.status).toBe(200);
			const body = await replace.json();
			expect(body.artifact).toMatchObject({ exportId: "export-replace-ok-ver2.zip" });

			// Reference now points at the NEW object; the OLD object is GC'd.
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-replace-ok-ver2.zip" })).toBe(true);
			expect(await objectStorage.hasProjectExport({ projectId, exportId: "export-replace-ok.zip" })).toBe(false);

			const loaded = await (await fetch(`${BASE}/project/${projectId}`)).json();
			expect(loaded.exportRuns[0].artifact).toMatchObject({ exportId: "export-replace-ok-ver2.zip" });
			const download = await fetch(`${BASE}/project/${projectId}/exports/export-replace-ok/artifact`);
			expect(download.status).toBe(200);
			expect(await download.text()).toBe("REPLACEMENT-BYTES");
		});
	});

	describe("AI Routes", () => {
		test("POST /api/ai/translate validates input", async () => {
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toContain("Validation failed");
		});

		test("POST /api/ai/translate rejects invalid project ID", async () => {
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					projectId: "not-a-uuid",
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
				}),
			});
			expect(res.status).toBe(400);
		});

		test("POST /api/ai/translate returns tier cost estimate and credit reserve", async () => {
			enableOpenAiProvider();
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": `cost-estimate-${crypto.randomUUID()}`,
				},
				body: JSON.stringify({
					projectId: testProjectId,
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					tier: "sfx-pro",
					translateSfx: true,
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.tier).toBe("sfx-pro");
			// LEAK-SAFE: the internal system/template prompt must NEVER be returned to
			// the client (sibling to #258/#278). The submit response carries the jobId,
			// tier, cost estimate, and credit reservation the FE needs — but NOT the
			// ~900-char `buildPrompt` output.
			expect(data.prompt).toBeUndefined();
			expect(JSON.stringify(data)).not.toContain("Translate ALL text");
			expect(data.costEstimate).toEqual(expect.objectContaining({
				tier: "sfx-pro",
				providerHint: "openai-gpt-image-2",
				currency: "THB",
				quality: "low",
			}));
			expect(data.creditReservation).toEqual(expect.objectContaining({
				status: "reserved",
				amountThb: data.costEstimate.reserveThb,
				currency: "THB",
			}));
		});

		test("POST /api/ai/translate estimates cost from clamped crop dimensions", async () => {
			enableOpenAiProvider();
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": `cost-clamp-${crypto.randomUUID()}`,
				},
				body: JSON.stringify({
					projectId: testProjectId,
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 2048, h: 512 },
					lang: "th",
					tier: "sfx-pro",
					translateSfx: true,
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.costEstimate).toEqual(expect.objectContaining({
				outputSize: "1024x1024",
				megapixels: 0.01,
			}));
		});

		test("POST /api/ai/translate blocks high quality on the free plan (medium is allowed)", async () => {
			// 2026-06-12 catalog: free tastes medium via its 100-credit grant; only
			// HIGH stays paid-gated (Pro and up).
			enableOpenAiProvider();
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					projectId: testProjectId,
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					tier: "sfx-pro",
					quality: "high",
				}),
			});
			expect(res.status).toBe(402);
			const data = await res.json();
			expect(data).toEqual(expect.objectContaining({
				code: "ai_quality_not_allowed",
				quality: "high",
			}));
			expect(data.plan).toEqual(expect.objectContaining({
				id: "free",
				allowedAiQualities: ["low", "medium"],
				}));
			});

			test("POST /api/ai/translate blocks plan-disallowed quality before external moderation", async () => {
				enableOpenAiProvider();
				process.env.OPENAI_MODERATION_ENABLED = "true";
				let moderationCalled = false;
				const wrappedFetch = globalThis.fetch;
				globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
					const url = typeof input === "string"
						? input
						: input instanceof URL
							? input.toString()
							: input.url;
					if (url.startsWith("https://api.openai.com/v1/moderations")) {
						moderationCalled = true;
						return Promise.resolve(new Response(JSON.stringify({
							results: [{ flagged: false, category_scores: {}, categories: {} }],
						}), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}));
					}
					return wrappedFetch(input, init);
				}) as typeof fetch;

				try {
					const res = await fetch(`${BASE}/ai/translate`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							projectId: testProjectId,
							imageId: testImageId,
							crop: { x: 0, y: 0, w: 1, h: 1 },
							lang: "th",
							tier: "clean-pro",
							quality: "high",
						}),
					});
					expect(res.status).toBe(402);
					expect(moderationCalled).toBe(false);
				} finally {
					globalThis.fetch = wrappedFetch;
				}
			});

			test("POST /api/ai/translate keeps default idempotency quality-aware", async () => {
				enableOpenAiProvider();
				process.env.WORKSPACE_PLAN_ID = "pro";
			const customPrompt = `quality-key-${crypto.randomUUID()}`;
			const requestBody = {
				projectId: testProjectId,
				imageId: testImageId,
				crop: { x: 0, y: 0, w: 1, h: 1 },
				lang: "th",
				tier: "sfx-pro",
				customPrompt,
			};

			const lowRes = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...requestBody, quality: "low" }),
			});
			expect(lowRes.status).toBe(200);
			const low = await lowRes.json();

			const highRes = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...requestBody, quality: "high" }),
			});
			expect(highRes.status).toBe(200);
			const high = await highRes.json();

			expect(low.quality).toBe("low");
			expect(high.quality).toBe("high");
			expect(high.jobId).not.toBe(low.jobId);
			expect(high.reused).toBe(false);
			expect(high.creditReservation.amountThb).toBeGreaterThan(low.creditReservation.amountThb);

			process.env.WORKSPACE_PLAN_ID = "free";
			const replayRes = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...requestBody, quality: "high" }),
			});
			expect(replayRes.status).toBe(200);
			const replay = await replayRes.json();
			expect(replay.jobId).toBe(high.jobId);
			expect(replay.reused).toBe(true);

			const { jobQueue } = await import("../services/queue.js");
			const lowJob = await jobQueue.get(low.jobId);
			const highJob = await jobQueue.get(high.jobId);
			expect(lowJob?.idempotencyKey).toMatch(/^ai-submit:[a-f0-9]{64}$/);
			expect(highJob?.idempotencyKey).toMatch(/^ai-submit:[a-f0-9]{64}$/);
			expect(lowJob?.idempotencyKey).not.toContain(customPrompt);
			expect(highJob?.idempotencyKey).not.toContain(customPrompt);
			const { buildPrompt } = await import("../prompt/builder.js");
			const legacyPrompt = buildPrompt({
				lang: "Thai",
				langCode: "th",
				customPrompt,
			});
			const lowLegacyKey = `${testProjectId}:${testImageId}:${JSON.stringify(requestBody.crop)}:th:sfx-pro:low:${legacyPrompt}`;
			const highLegacyKey = `${testProjectId}:${testImageId}:${JSON.stringify(requestBody.crop)}:th:sfx-pro:high:${legacyPrompt}`;
			expect((await jobQueue.getByIdempotencyKey(lowLegacyKey))?.jobId).toBe(low.jobId);
			expect((await jobQueue.getByIdempotencyKey(highLegacyKey))?.jobId).toBe(high.jobId);
		});

		test("POST /api/ai/translate reuses legacy default idempotency keys during migration", async () => {
			enableOpenAiProvider();
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Legacy AI Idempotency", lang: "th" }),
			})).json();
			const legacyProjectId = created.projectId;
			const pngBuffer = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			);
			const fd = new FormData();
			fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "legacy-ai-idempotency.png");
			const uploadRes = await fetch(`${BASE}/images/${legacyProjectId}/upload`, {
				method: "POST",
				body: fd,
			});
			expect(uploadRes.status).toBe(200);
			const upload = await uploadRes.json();
			const legacyImageId = upload.imageIds[0];
			const customPrompt = `legacy-key-${crypto.randomUUID()}`;
			const crop = { x: 0, y: 0, w: 1, h: 1 };
			const requestBody = {
				projectId: legacyProjectId,
				imageId: legacyImageId,
				crop,
				lang: "th",
				tier: "sfx-pro",
				quality: "low",
				customPrompt,
			};
			const { buildPrompt } = await import("../prompt/builder.js");
			const legacyPrompt = buildPrompt({
				lang: "Thai",
				langCode: "th",
				customPrompt,
			});
			const legacyKey = `${legacyProjectId}:${legacyImageId}:${JSON.stringify(crop)}:th:sfx-pro:low:${legacyPrompt}`;
			const { jobQueue } = await import("../services/queue.js");
			const legacyJobId = `legacy-submit-${crypto.randomUUID()}`;
			await jobQueue.add({
				jobId: legacyJobId,
				projectId: legacyProjectId,
				imageId: legacyImageId,
				crop,
				lang: "th",
				prompt: legacyPrompt,
				tier: "sfx-pro",
				quality: "low",
				status: "done",
				idempotencyKey: legacyKey,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}, { idempotencyKey: legacyKey });

			const replayRes = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Real-IP": "203.0.113.35",
				},
				body: JSON.stringify(requestBody),
			});
			expect(replayRes.status).toBe(200);
			const replay = await replayRes.json();
			expect(replay.jobId).toBe(legacyJobId);
			expect(replay.reused).toBe(true);
		});

		test("POST /api/ai/translate backfills legacy idempotency alias when reusing hashed jobs", async () => {
			enableOpenAiProvider();
			const created = await (await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Hash AI Idempotency Backfill", lang: "th" }),
			})).json();
			const hashProjectId = created.projectId;
			const pngBuffer = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			);
			const fd = new FormData();
			fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "hash-ai-idempotency.png");
			const uploadRes = await fetch(`${BASE}/images/${hashProjectId}/upload`, {
				method: "POST",
				body: fd,
			});
			expect(uploadRes.status).toBe(200);
			const upload = await uploadRes.json();
			const hashImageId = upload.imageIds[0];
			const customPrompt = `hash-only-${crypto.randomUUID()}`;
			const crop = { x: 0, y: 0, w: 1, h: 1 };
			const requestBody = {
				projectId: hashProjectId,
				imageId: hashImageId,
				crop,
				lang: "th",
				tier: "sfx-pro",
				quality: "low",
				customPrompt,
			};
			const [{ buildPrompt }, { createHash }, { jobQueue }] = await Promise.all([
				import("../prompt/builder.js"),
				import("node:crypto"),
				import("../services/queue.js"),
			]);
			const prompt = buildPrompt({
				lang: "Thai",
				langCode: "th",
				customPrompt,
			});
			const hashedKey = `ai-submit:${createHash("sha256")
				.update(JSON.stringify({
					projectId: hashProjectId,
					imageId: hashImageId,
					crop,
					lang: "th",
					tier: "sfx-pro",
					quality: "low",
					prompt,
				}))
				.digest("hex")}`;
			const legacyKey = `${hashProjectId}:${hashImageId}:${JSON.stringify(crop)}:th:sfx-pro:low:${prompt}`;
			const hashOnlyJobId = `hash-only-submit-${crypto.randomUUID()}`;
			await jobQueue.add({
				jobId: hashOnlyJobId,
				projectId: hashProjectId,
				imageId: hashImageId,
				crop,
				lang: "th",
				prompt,
				tier: "sfx-pro",
				quality: "low",
				status: "done",
				idempotencyKey: hashedKey,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}, { idempotencyKey: hashedKey });

			const replayRes = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(requestBody),
			});
			expect(replayRes.status).toBe(200);
			const replay = await replayRes.json();
			expect(replay.jobId).toBe(hashOnlyJobId);
			expect(replay.reused).toBe(true);
			expect((await jobQueue.getByIdempotencyKey(hashedKey))?.jobId).toBe(hashOnlyJobId);
			expect((await jobQueue.getByIdempotencyKey(legacyKey))?.jobId).toBe(hashOnlyJobId);
		});

		test("POST /api/ai/translate rejects oversized idempotency keys before queueing", async () => {
			enableOpenAiProvider();
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": "x".repeat(301),
				},
				body: JSON.stringify({
					projectId: testProjectId,
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					tier: "sfx-pro",
					quality: "low",
				}),
			});
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data).toEqual(expect.objectContaining({
				code: "invalid_idempotency_key",
				maxLength: 300,
			}));
		});

		test("POST /api/ai/translate rejects explicitly empty idempotency keys before queueing", async () => {
			enableOpenAiProvider();
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": "",
					"X-Real-IP": "203.0.113.36",
				},
				body: JSON.stringify({
					projectId: testProjectId,
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					tier: "sfx-pro",
					quality: "low",
				}),
			});
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data).toEqual(expect.objectContaining({
				code: "invalid_idempotency_key",
				maxLength: 300,
			}));
		});

		test("POST /api/project/:id/ai-markers/:markerId/rerun queues job and marker atomically", async () => {
			enableOpenAiProvider();
			const stateRes = await fetch(`${BASE}/project/${testProjectId}`);
			expect(stateRes.status).toBe(200);
			const state = await stateRes.json();
			// Seed the linked comment on disk directly: the general `/save` is server-
			// authoritative for comments (it ignores the body's copy so a stale save
			// can't drop a concurrent dedicated-endpoint change), so the comment the
			// rerun marker links to must be written to `state.json`. The page text layer
			// is persisted the same way so the auto page-0-review task materializes.
			const { PROJECTS_DIR: rerunProjectsDir } = await import("../config.js");
			writeFileSync(
				join(rerunProjectsDir, testProjectId, "state.json"),
				JSON.stringify({
					...state,
					targetLang: "th",
					pages: [{
						imageId: testImageId,
						imageName: "test.png",
						// Carries text so the auto page-0-review task this marker links
						// to is materialized (textless pages no longer auto-get review).
						textLayers: [{
							id: "rerun-text",
							text: "ทดสอบ",
							x: 0,
							y: 0,
							w: 100,
							h: 40,
							rotation: 0,
							fontSize: 24,
							alignment: "center",
							index: 0,
						}],
						pendingAiJobs: [],
						coverRect: null,
					}],
					comments: [{
						id: "comment-rerun",
						pageIndex: 0,
						body: "Rerun context",
						author: "tester",
						status: "open",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					}],
					currentPage: 0,
				}, null, 2),
			);

			await seedMarkerJob("job-rerun-source", testProjectId);
			const markerCreateRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-rerun-source",
					pageIndex: 0,
					imageId: testImageId,
					region: { x: 0, y: 0, w: 1, h: 1 },
					status: "retry_requested",
					tier: "sfx-pro",
					prompt: "Old generated prompt",
					customPrompt: "Keep source lettering",
					textLayers: ["BANG", "aside"],
					translateSfx: false,
					linkedCommentIds: ["comment-rerun"],
					linkedTaskIds: ["page-0-review"],
				}),
			});
			expect(markerCreateRes.status).toBe(200);
			const markerCreate = await markerCreateRes.json();
			const idempotencyKey = `route-rerun-${crypto.randomUUID()}`;

			const rerunRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${markerCreate.marker.id}/rerun`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
					"X-Project-Id": testProjectId,
					"X-AI-Tier": "sfx-pro",
				},
				body: JSON.stringify({ lang: "th" }),
			});
			expect(rerunRes.status).toBe(200);
			const rerun = await rerunRes.json();
			expect(rerun.jobId).toBeDefined();
			expect(rerun.marker).toEqual(expect.objectContaining({
				jobId: rerun.jobId,
				status: "processing",
				sourceMarkerId: markerCreate.marker.id,
				rerunIdempotencyKey: idempotencyKey,
				customPrompt: "Keep source lettering",
				textLayers: ["BANG", "aside"],
				translateSfx: false,
				linkedCommentIds: ["comment-rerun"],
				linkedTaskIds: expect.arrayContaining(["page-0-review"]),
			}));

			const duplicateRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${markerCreate.marker.id}/rerun`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
					"X-Project-Id": testProjectId,
					"X-AI-Tier": "sfx-pro",
				},
				body: JSON.stringify({ lang: "th" }),
			});
			expect(duplicateRes.status).toBe(200);
			const duplicate = await duplicateRes.json();
			expect(duplicate.reused).toBe(true);
			expect(duplicate.jobId).toBe(rerun.jobId);
			expect(duplicate.marker.id).toBe(rerun.marker.id);
			expect(duplicate.markers.filter((item: any) => item.sourceMarkerId === markerCreate.marker.id && item.jobId === rerun.jobId)).toHaveLength(1);
		});

		// MONEY (per-language money rule): rerunning the SAME source marker for a
		// DIFFERENT language with NO client Idempotency-Key must produce a DISTINCT
		// job + DISTINCT credit reservation (the server-generated fallback key now
		// folds in the normalized requested lang). A same-lang rerun replay still
		// de-dupes to the one job (no second charge).
		test("POST /api/project/:id/ai-markers/:markerId/rerun without Idempotency-Key: distinct langs => distinct jobs+reservations, same lang reuses", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "pro";
			const { projectId: plProjectId, imageId: plImageId } = await createProjectWithUploadedImage("Rerun Per-Language Money");
			const state = await (await fetch(`${BASE}/project/${plProjectId}`)).json();
			const saveRes = await fetch(`${BASE}/project/${plProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...state,
					targetLang: "th",
					targetLangs: ["th", "en", "ja"],
					pages: [{
						imageId: plImageId,
						imageName: "test.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					}],
					currentPage: 0,
				}),
			});
			expect(saveRes.status).toBe(200);

			await seedMarkerJob("job-rerun-pl-source", plProjectId);
			const markerCreate = await (await fetch(`${BASE}/project/${plProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-rerun-pl-source",
					pageIndex: 0,
					imageId: plImageId,
					region: { x: 0, y: 0, w: 1, h: 1 },
					status: "failed",
					tier: "sfx-pro",
					prompt: "Source prompt",
					customPrompt: "Shared custom prompt",
					textLayers: ["SFX"],
					translateSfx: false,
				}),
			})).json();
			const sourceId = markerCreate.marker.id;

			// No Idempotency-Key header on ANY of these calls — exercise the
			// server-generated fallback key path.
			const rerunHeaders = { "Content-Type": "application/json", "X-Project-Id": plProjectId, "X-AI-Tier": "sfx-pro" };

			const enRes = await fetch(`${BASE}/project/${plProjectId}/ai-markers/${sourceId}/rerun`, {
				method: "POST", headers: rerunHeaders, body: JSON.stringify({ lang: "en" }),
			});
			expect(enRes.status).toBe(200);
			const en = await enRes.json();
			expect(en.reused).toBeFalsy();

			const jaRes = await fetch(`${BASE}/project/${plProjectId}/ai-markers/${sourceId}/rerun`, {
				method: "POST", headers: rerunHeaders, body: JSON.stringify({ lang: "ja" }),
			});
			expect(jaRes.status).toBe(200);
			const ja = await jaRes.json();
			// DISTINCT job for the second language (NOT a reuse of the "en" job).
			expect(ja.reused).toBeFalsy();
			expect(ja.jobId).not.toBe(en.jobId);

			const { jobQueue } = await import("../services/queue.js");
			const enJob = await jobQueue.get(en.jobId);
			const jaJob = await jobQueue.get(ja.jobId);
			expect(enJob?.lang).toBe("en");
			expect(jaJob?.lang).toBe("ja");
			// Each per-language rerun carries its OWN reserved credit — neither skipped.
			expect(enJob?.creditReservation?.status).toBe("reserved");
			expect(jaJob?.creditReservation?.status).toBe("reserved");
			expect(en.creditReservation).toBeDefined();
			expect(ja.creditReservation).toBeDefined();
			// Markers land in distinct per-language buckets.
			expect(en.marker.targetLang).toBe("en");
			expect(ja.marker.targetLang).toBe("ja");
			expect(en.marker.jobId).not.toBe(ja.marker.jobId);

			// Same-lang rerun replay (still no Idempotency-Key) reuses the "en" job:
			// one job, no second charge.
			const enAgainRes = await fetch(`${BASE}/project/${plProjectId}/ai-markers/${sourceId}/rerun`, {
				method: "POST", headers: rerunHeaders, body: JSON.stringify({ lang: "en" }),
			});
			expect(enAgainRes.status).toBe(200);
			const enAgain = await enAgainRes.json();
			expect(enAgain.reused).toBe(true);
			expect(enAgain.jobId).toBe(en.jobId);
			// Case-insensitive: "EN" normalizes to the same bucket/key as "en".
			const enUpperRes = await fetch(`${BASE}/project/${plProjectId}/ai-markers/${sourceId}/rerun`, {
				method: "POST", headers: rerunHeaders, body: JSON.stringify({ lang: "EN" }),
			});
			expect(enUpperRes.status).toBe(200);
			const enUpper = await enUpperRes.json();
			expect(enUpper.reused).toBe(true);
			expect(enUpper.jobId).toBe(en.jobId);
		});

		test("POST /api/project/:id/ai-markers/:markerId/rerun rejects non-rerunnable and stale-image markers", async () => {
			// A marker cannot be CREATED already-`accepted` (gated approval; authz
			// mass-assignment guard). Reach the accepted state the legitimate way:
			// create it in a job-lifecycle state, then PATCH it to accepted.
			await seedMarkerJob("job-rerun-accepted", testProjectId);
			const acceptedMarkerRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-rerun-accepted",
					pageIndex: 0,
					imageId: testImageId,
					region: { x: 0, y: 0, w: 1, h: 1 },
					status: "needs_review",
					tier: "sfx-pro",
				}),
			});
			expect(acceptedMarkerRes.status).toBe(200);
			const acceptedMarker = await acceptedMarkerRes.json();
			const acceptedPatchRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${acceptedMarker.marker.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "accepted" }),
			});
			expect(acceptedPatchRes.status).toBe(200);
			const acceptedRerunRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${acceptedMarker.marker.id}/rerun`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Project-Id": testProjectId, "X-AI-Tier": "sfx-pro" },
				body: JSON.stringify({ lang: "th" }),
			});
			expect(acceptedRerunRes.status).toBe(409);

			await seedMarkerJob("job-rerun-stale", testProjectId);
			const staleMarkerRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-rerun-stale",
					pageIndex: 0,
					imageId: testImageId,
					region: { x: 0, y: 0, w: 1, h: 1 },
					status: "failed",
					tier: "sfx-pro",
				}),
			});
			expect(staleMarkerRes.status).toBe(200);
			const staleMarker = await staleMarkerRes.json();
			const currentState = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			const staleSaveRes = await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...currentState,
					pages: [{
						...currentState.pages[0],
						imageId: "00000000-0000-0000-0000-000000000000.png",
						edits: undefined,
					}],
				}),
			});
			expect(staleSaveRes.status).toBe(200);
			const staleRerunRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${staleMarker.marker.id}/rerun`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Project-Id": testProjectId, "X-AI-Tier": "sfx-pro" },
				body: JSON.stringify({ lang: "th" }),
			});
			expect(staleRerunRes.status).toBe(400);
			const restoreValidImageRes = await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(currentState),
			});
			expect(restoreValidImageRes.status).toBe(200);
		});

		test("POST /api/project/:id/ai-markers/:markerId/retry re-queues with edited prompt and transitions source -> retry_requested", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "pro";
			// Use a dedicated project so AI queue admission caps from earlier tests don't interfere.
			const { projectId: retryProjectId, imageId: retryImageId } = await createProjectWithUploadedImage("Retry Edited Prompt");
			const stateRes = await fetch(`${BASE}/project/${retryProjectId}`);
			const state = await stateRes.json();
			const saveRes = await fetch(`${BASE}/project/${retryProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...state,
					targetLang: "th",
					pages: [{
						imageId: retryImageId,
						imageName: "test.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					}],
					currentPage: 0,
				}),
			});
			expect(saveRes.status).toBe(200);

			// A reviewer looked at the result (needs_review) and wants to retry with a tweaked prompt.
			await seedMarkerJob("job-retry-source", retryProjectId);
			const markerCreateRes = await fetch(`${BASE}/project/${retryProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-retry-source",
					pageIndex: 0,
					imageId: retryImageId,
					region: { x: 0, y: 0, w: 1, h: 1 },
					status: "needs_review",
					tier: "sfx-pro",
					prompt: "Original prompt",
					customPrompt: "Original custom prompt",
					textLayers: ["KABOOM"],
					translateSfx: true,
				}),
			});
			expect(markerCreateRes.status).toBe(200);
			const markerCreate = await markerCreateRes.json();
			const sourceId = markerCreate.marker.id;
			const idempotencyKey = `route-retry-${crypto.randomUUID()}`;

			const retryRes = await fetch(`${BASE}/project/${retryProjectId}/ai-markers/${sourceId}/retry`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
					"X-Project-Id": retryProjectId,
					"X-AI-Tier": "sfx-pro",
				},
				body: JSON.stringify({ lang: "th", promptOverride: "Keep SFX but soften wording" }),
			});
			expect(retryRes.status).toBe(200);
			const retry = await retryRes.json();
			expect(retry.jobId).toBeDefined();
			// New marker carries the edited prompt and links back to the source.
			expect(retry.marker).toEqual(expect.objectContaining({
				jobId: retry.jobId,
				status: "processing",
				sourceMarkerId: sourceId,
				rerunIdempotencyKey: idempotencyKey,
				customPrompt: "Keep SFX but soften wording",
				textLayers: ["KABOOM"],
				translateSfx: true,
			}));
			// Source marker transitions to the "retrying" state.
			expect(retry.sourceMarker.status).toBe("retry_requested");
			const persistedSource = retry.markers.find((item: any) => item.id === sourceId);
			expect(persistedSource.status).toBe("retry_requested");

			// Idempotent replay returns the same job + marker without duplicating.
			const duplicateRes = await fetch(`${BASE}/project/${retryProjectId}/ai-markers/${sourceId}/retry`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
					"X-Project-Id": retryProjectId,
					"X-AI-Tier": "sfx-pro",
				},
				body: JSON.stringify({ lang: "th", promptOverride: "Keep SFX but soften wording" }),
			});
			expect(duplicateRes.status).toBe(200);
			const duplicate = await duplicateRes.json();
			expect(duplicate.reused).toBe(true);
			expect(duplicate.jobId).toBe(retry.jobId);
			expect(duplicate.markers.filter((item: any) => item.sourceMarkerId === sourceId && item.jobId === retry.jobId)).toHaveLength(1);
		});

		// MONEY (per-language money rule): retrying the SAME source marker with the
		// SAME edited prompt but a DIFFERENT language and NO client Idempotency-Key
		// must produce a DISTINCT job + DISTINCT credit reservation. Same lang +
		// same prompt replay still de-dupes (no second charge).
		test("POST /api/project/:id/ai-markers/:markerId/retry without Idempotency-Key: distinct langs => distinct jobs+reservations, same lang reuses", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "pro";
			const { projectId: plProjectId, imageId: plImageId } = await createProjectWithUploadedImage("Retry Per-Language Money");
			const state = await (await fetch(`${BASE}/project/${plProjectId}`)).json();
			const saveRes = await fetch(`${BASE}/project/${plProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...state,
					targetLang: "th",
					targetLangs: ["th", "en", "ja"],
					pages: [{
						imageId: plImageId,
						imageName: "test.png",
						textLayers: [],
						pendingAiJobs: [],
						coverRect: null,
					}],
					currentPage: 0,
				}),
			});
			expect(saveRes.status).toBe(200);

			await seedMarkerJob("job-retry-pl-source", plProjectId);
			const markerCreate = await (await fetch(`${BASE}/project/${plProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-retry-pl-source",
					pageIndex: 0,
					imageId: plImageId,
					region: { x: 0, y: 0, w: 1, h: 1 },
					status: "needs_review",
					tier: "sfx-pro",
					prompt: "Source prompt",
					customPrompt: "Original custom prompt",
					textLayers: ["SFX"],
					translateSfx: true,
				}),
			})).json();
			const sourceId = markerCreate.marker.id;

			// No Idempotency-Key header — exercise the server-generated fallback key.
			// Keep the edited prompt CONSTANT across calls so ONLY the language differs:
			// that isolates the lang segment of the fallback key as the discriminator.
			const editedPrompt = "Soften the wording";
			const retryHeaders = { "Content-Type": "application/json", "X-Project-Id": plProjectId, "X-AI-Tier": "sfx-pro" };

			const enRes = await fetch(`${BASE}/project/${plProjectId}/ai-markers/${sourceId}/retry`, {
				method: "POST", headers: retryHeaders, body: JSON.stringify({ lang: "en", promptOverride: editedPrompt }),
			});
			expect(enRes.status).toBe(200);
			const en = await enRes.json();
			expect(en.reused).toBeFalsy();

			const jaRes = await fetch(`${BASE}/project/${plProjectId}/ai-markers/${sourceId}/retry`, {
				method: "POST", headers: retryHeaders, body: JSON.stringify({ lang: "ja", promptOverride: editedPrompt }),
			});
			expect(jaRes.status).toBe(200);
			const ja = await jaRes.json();
			// DISTINCT job for the second language (NOT a reuse of the "en" job),
			// even though the edited prompt is identical.
			expect(ja.reused).toBeFalsy();
			expect(ja.jobId).not.toBe(en.jobId);

			const { jobQueue } = await import("../services/queue.js");
			const enJob = await jobQueue.get(en.jobId);
			const jaJob = await jobQueue.get(ja.jobId);
			expect(enJob?.lang).toBe("en");
			expect(jaJob?.lang).toBe("ja");
			// Each per-language retry carries its OWN reserved credit — neither skipped.
			expect(enJob?.creditReservation?.status).toBe("reserved");
			expect(jaJob?.creditReservation?.status).toBe("reserved");
			expect(en.creditReservation).toBeDefined();
			expect(ja.creditReservation).toBeDefined();
			expect(en.marker.targetLang).toBe("en");
			expect(ja.marker.targetLang).toBe("ja");

			// Same-lang + same-prompt retry replay (still no Idempotency-Key) reuses
			// the "en" job: one job, no second charge.
			const enAgainRes = await fetch(`${BASE}/project/${plProjectId}/ai-markers/${sourceId}/retry`, {
				method: "POST", headers: retryHeaders, body: JSON.stringify({ lang: "en", promptOverride: editedPrompt }),
			});
			expect(enAgainRes.status).toBe(200);
			const enAgain = await enAgainRes.json();
			expect(enAgain.reused).toBe(true);
			expect(enAgain.jobId).toBe(en.jobId);
		});

		test("POST /api/project/:id/ai-markers/:markerId/retry runs the edited prompt through moderation and blocks disallowed text", async () => {
			enableOpenAiProvider();
			process.env.OPENAI_MODERATION_ENABLED = "true";
			const stateRes = await fetch(`${BASE}/project/${testProjectId}`);
			const state = await stateRes.json();
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...state,
					targetLang: "th",
					pages: [{ imageId: testImageId, imageName: "test.png", textLayers: [], pendingAiJobs: [], coverRect: null }],
					currentPage: 0,
				}),
			});
			await seedMarkerJob("job-retry-moderation", testProjectId);
			const markerCreate = await (await fetch(`${BASE}/project/${testProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-retry-moderation",
					pageIndex: 0,
					imageId: testImageId,
					region: { x: 0, y: 0, w: 1, h: 1 },
					status: "needs_review",
					tier: "sfx-pro",
				}),
			})).json();

			let moderationCalled = false;
			const wrappedFetch = globalThis.fetch;
			globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.startsWith("https://api.openai.com/v1/moderations")) {
					moderationCalled = true;
					// W1.6 only hard-blocks text via the minors policy: a score at/above the
					// text "sexual/minors" threshold (0.2) but below the CSAM cutoff (0.5)
					// yields status "block" -> code "moderation_blocked". A bare `flagged`
					// with no scores is treated as a soft warn (needs_review), not a block.
					return Promise.resolve(new Response(JSON.stringify({
						results: [{
							flagged: true,
							category_scores: { "sexual/minors": 0.35 },
							categories: { "sexual/minors": true },
						}],
					}), { status: 200, headers: { "Content-Type": "application/json" } }));
				}
				return wrappedFetch(input, init);
			}) as typeof fetch;

			try {
				const retryRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${markerCreate.marker.id}/retry`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Project-Id": testProjectId, "X-AI-Tier": "sfx-pro" },
					body: JSON.stringify({ lang: "th", promptOverride: "disallowed override prompt" }),
				});
				// W1.6 returns 403 for moderation-blocked prompts (consistent with the
				// image-moderation gate) carrying a moderation_blocked / csam_block code,
				// instead of the earlier generic 400.
				expect(retryRes.status).toBe(403);
				const retryBody = await retryRes.json() as { code?: string };
				expect(retryBody.code).toBe("moderation_blocked");
				expect(moderationCalled).toBe(true);
				// No retry marker should be created when moderation blocks the prompt.
				const markersAfter = await (await fetch(`${BASE}/project/${testProjectId}/ai-markers`)).json();
				expect(markersAfter.markers.some((item: any) => item.sourceMarkerId === markerCreate.marker.id)).toBe(false);
				// Source marker keeps its original status (not flipped to retry_requested) on block.
				const sourceAfter = markersAfter.markers.find((item: any) => item.id === markerCreate.marker.id);
				expect(sourceAfter.status).toBe("needs_review");
			} finally {
				globalThis.fetch = wrappedFetch;
				delete process.env.OPENAI_MODERATION_ENABLED;
			}
		});

		test("POST /api/project/:id/ai-markers/:markerId/retry rejects markers in a non-retryable state", async () => {
			await seedMarkerJob("job-retry-processing", testProjectId);
			const processingMarker = await (await fetch(`${BASE}/project/${testProjectId}/ai-markers`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jobId: "job-retry-processing",
					pageIndex: 0,
					imageId: testImageId,
					region: { x: 0, y: 0, w: 1, h: 1 },
					status: "processing",
					tier: "sfx-pro",
				}),
			})).json();
			const retryRes = await fetch(`${BASE}/project/${testProjectId}/ai-markers/${processingMarker.marker.id}/retry`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Project-Id": testProjectId, "X-AI-Tier": "sfx-pro" },
				body: JSON.stringify({ promptOverride: "tweak" }),
			});
			expect(retryRes.status).toBe(409);
		});

		test("POST /api/ai/translate rejects unavailable clean tiers before queueing", async () => {
			process.env.WORKSPACE_PLAN_ID = "pro";
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": `clean-unavailable-${crypto.randomUUID()}`,
				},
				body: JSON.stringify({
					projectId: testProjectId,
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					tier: "clean-pro",
				}),
			});
			expect(res.status).toBe(409);
			const data = await res.json();
			expect(data).toEqual(expect.objectContaining({
				code: "ai_provider_unavailable",
				reason: "openai_images_not_configured",
				tier: "clean-pro",
			}));
		});

		test("POST /api/ai/status/:jobId/cancel cancels a queued job and releases its reservation", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "pro";
			const submitRes = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": `cancel-route-${crypto.randomUUID()}`,
				},
				body: JSON.stringify({
					projectId: testProjectId,
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					tier: "sfx-pro",
				}),
			});
			expect(submitRes.status).toBe(200);
			const queued = await submitRes.json();

			const cancelRes = await fetch(`${BASE}/ai/status/${queued.jobId}/cancel`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(200);
			const cancelled = await cancelRes.json();
			expect(cancelled).toEqual(expect.objectContaining({
				ok: true,
				status: "cancelled",
				error: "Cancelled before processing",
			}));
			expect(cancelled.creditReservation).toEqual(expect.objectContaining({
				status: "released",
				reason: "job_cancelled",
			}));

			const statusRes = await fetch(`${BASE}/ai/status/${queued.jobId}`);
			expect(statusRes.status).toBe(200);
			const status = await statusRes.json();
			expect(status.status).toBe("cancelled");
			expect(status.events.some((event: any) => event.type === "credit:released")).toBe(true);
		});

		test("POST /api/ai/status/:jobId/retry creates a fresh queued retry job", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "pro";
			const previousDailyLimit = process.env.USAGE_DAILY_AI_CREDIT_THB;
			const previousMonthlyLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
			process.env.USAGE_DAILY_AI_CREDIT_THB = "1000";
			process.env.USAGE_MONTHLY_AI_CREDIT_THB = "1000";
			try {
				const retryRouteIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
				const submitRes = await fetch(`${BASE}/ai/translate`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": `retry-route-${crypto.randomUUID()}`,
						"x-forwarded-for": retryRouteIp,
					},
					body: JSON.stringify({
						projectId: testProjectId,
						imageId: testImageId,
						crop: { x: 0, y: 0, w: 1, h: 1 },
						lang: "th",
						tier: "sfx-pro",
					}),
				});
				expect(submitRes.status).toBe(200);
				const queued = await submitRes.json();

				const cancelRes = await fetch(`${BASE}/ai/status/${queued.jobId}/cancel`, {
					method: "POST",
					headers: { "x-forwarded-for": retryRouteIp },
				});
				expect(cancelRes.status).toBe(200);
				const [{ jobQueue }, { AI_COST_PRICING_VERSION }] = await Promise.all([
					import("../services/queue.js"),
					import("../services/cost-estimator.js"),
				]);
				await jobQueue.update(queued.jobId, {
					costEstimate: {
						...queued.costEstimate,
						pricingVersion: "legacy-stale-pricing",
						estimatedThb: 0.01,
						reserveThb: 0.01,
					},
					creditReservation: {
						...queued.creditReservation,
						status: "released",
						amountThb: 0.01,
						settledAt: Date.now(),
						reason: "job_cancelled",
					},
				});

				const retryRes = await fetch(`${BASE}/ai/status/${queued.jobId}/retry`, {
					method: "POST",
					headers: { "x-forwarded-for": retryRouteIp },
				});
				expect(retryRes.status).toBe(200);
				const retry = await retryRes.json();
				expect(retry).toEqual(expect.objectContaining({
					ok: true,
					status: "pending",
				}));
				expect(retry.jobId).not.toBe(queued.jobId);
				expect(retry.creditReservation).toEqual(expect.objectContaining({ status: "reserved" }));
				expect(retry.costEstimate.pricingVersion).toBe(AI_COST_PRICING_VERSION);
				expect(retry.creditReservation.amountThb).toBe(retry.costEstimate.reserveThb);
				expect(retry.creditReservation.amountThb).not.toBe(0.01);
				expect(retry.sourceEvents.some((event: any) => event.type === "retry:created")).toBe(true);
			} finally {
				if (previousDailyLimit === undefined) {
					delete process.env.USAGE_DAILY_AI_CREDIT_THB;
				} else {
					process.env.USAGE_DAILY_AI_CREDIT_THB = previousDailyLimit;
				}
				if (previousMonthlyLimit === undefined) {
					delete process.env.USAGE_MONTHLY_AI_CREDIT_THB;
				} else {
					process.env.USAGE_MONTHLY_AI_CREDIT_THB = previousMonthlyLimit;
				}
			}
		});

		test("POST /api/ai/status/:jobId/retry blocks plan-disallowed quality before requeueing", async () => {
			enableOpenAiProvider();
			const { jobQueue } = await import("../services/queue.js");
			const sourceJobId = `quality-retry-${crypto.randomUUID()}`;
			await jobQueue.add({
				jobId: sourceJobId,
				projectId: testProjectId,
				imageId: testImageId,
				crop: { x: 0, y: 0, w: 1, h: 1 },
				lang: "th",
				prompt: "Retry high quality",
				tier: "clean-pro",
				quality: "high",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}, { idempotencyKey: sourceJobId });
			await jobQueue.update(sourceJobId, { status: "error", error: "provider failed" });

			const retryRes = await fetch(`${BASE}/ai/status/${sourceJobId}/retry`, {
				method: "POST",
				headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
			});
			expect(retryRes.status).toBe(402);
			const retry = await retryRes.json();
			expect(retry).toEqual(expect.objectContaining({
				code: "ai_quality_not_allowed",
				quality: "high",
			}));
		});

		test("POST /api/ai/status/:jobId/retry requires a registered ready asset when production guard is enabled", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "pro";
			const [{ jobQueue }, { serverConfig }, assets] = await Promise.all([
				import("../services/queue.js"),
				import("../config.js"),
				import("../services/assets.js"),
			]);
			const sourceJobId = `asset-guard-retry-${crypto.randomUUID()}`;
			const originalAsset = assets.getAssetRecord(testProjectId, testImageId);
			expect(originalAsset).toBeDefined();
			const snapshot = {
				aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi,
			};
			try {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					aiRequireAssetRegistryForAi: true,
				});
				assets.removeAssetRecord(testProjectId, testImageId);
				await jobQueue.add({
					jobId: sourceJobId,
					projectId: testProjectId,
					imageId: testImageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					prompt: "Retry after asset quarantine",
					tier: "sfx-pro",
					quality: "low",
					status: "pending",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				}, { idempotencyKey: sourceJobId });
				await jobQueue.update(sourceJobId, { status: "error", error: "provider failed" });

				const retryRes = await fetch(`${BASE}/ai/status/${sourceJobId}/retry`, {
					method: "POST",
					headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
				});
				expect(retryRes.status).toBe(423);
				const retry = await retryRes.json();
				expect(retry.error).toContain(`Asset ${testImageId} is not registered for AI processing`);
			} finally {
				Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
				if (originalAsset) assets.restoreAssetRecord(testProjectId, originalAsset);
			}
		});

		test("POST /api/ai/status/:jobId/retry rejects terminal non-retriable jobs before repricing", async () => {
			enableOpenAiProvider();
			const { jobQueue } = await import("../services/queue.js");
			const doneJobId = `done-retry-${crypto.randomUUID()}`;
			await jobQueue.add({
				jobId: doneJobId,
				projectId: testProjectId,
				imageId: `missing-retry-${crypto.randomUUID()}.png`,
				crop: { x: 0, y: 0, w: 10, h: 10 },
				lang: "th",
				prompt: "Already done",
				tier: "sfx-pro",
				quality: "low",
				status: "done",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}, { idempotencyKey: doneJobId });

			const retryRes = await fetch(`${BASE}/ai/status/${doneJobId}/retry`, {
				method: "POST",
				headers: {
					"x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
					"x-project-id": testProjectId,
				},
			});
			expect(retryRes.status).toBe(409);
			const retry = await retryRes.json();
			expect(retry).toEqual(expect.objectContaining({
				error: "AI job cannot be retried from done",
				status: "done",
			}));
		});

		test("POST /api/ai/status/:jobId/retry rejects provider-classified non-retryable jobs before repricing", async () => {
			enableOpenAiProvider();
			const { jobQueue } = await import("../services/queue.js");
			const blockedJobId = `blocked-retry-${crypto.randomUUID()}`;
			await jobQueue.add({
				jobId: blockedJobId,
				projectId: testProjectId,
				imageId: testImageId,
				crop: { x: 0, y: 0, w: 10, h: 10 },
				lang: "th",
				prompt: "Provider auth failed",
				tier: "sfx-pro",
				quality: "low",
				status: "error",
				error: "OpenAI image edit error 401 (invalid_api_key): Invalid API key",
				retryable: false,
				failureCode: "invalid_api_key",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}, { idempotencyKey: blockedJobId });

			const retryRes = await fetch(`${BASE}/ai/status/${blockedJobId}/retry`, {
				method: "POST",
				headers: {
					"x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
					"x-project-id": testProjectId,
				},
			});
			expect(retryRes.status).toBe(409);
			const retry = await retryRes.json();
			expect(retry).toEqual(expect.objectContaining({
				error: "AI job cannot be retried because the last failure is non-retriable",
				status: "error",
				retryable: false,
				failureCode: "invalid_api_key",
			}));
		});

		test("POST /api/ai/translate applies plan queue caps before queueing", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "free";
			const { projectId, imageId } = await createProjectWithUploadedImage("Plan Queue Cap Submit");
			const { jobQueue } = await import("../services/queue.js");
			for (let index = 0; index < 5; index += 1) {
				await jobQueue.add({
					jobId: `plan-submit-cap-${crypto.randomUUID()}`,
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					prompt: `existing open job ${index}`,
					tier: "sfx-pro",
					quality: "low",
					status: "processing",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				}, { idempotencyKey: `plan-submit-cap-existing-${index}-${crypto.randomUUID()}` });
			}

			const rejectedKey = `plan-submit-cap-rejected-${crypto.randomUUID()}`;
			const res = await fetch(`${BASE}/ai/translate`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": rejectedKey,
				},
				body: JSON.stringify({
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					tier: "sfx-pro",
					quality: "low",
				}),
			});
			expect(res.status).toBe(429);
			const body = await res.json();
			expect(body).toEqual(expect.objectContaining({
				code: "ai_queue_capacity_exceeded",
				reason: "project_open_limit",
			}));
			expect(body.queue.limits.maxProjectOpenJobs).toBe(5);
			expect(body.queue.snapshot.projectOpenJobs).toBe(5);
			expect(await jobQueue.getByIdempotencyKey(rejectedKey)).toBeUndefined();
		});

		test("POST /api/ai/status/:jobId/retry applies plan queue caps before reserving retry credit", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "free";
			const { projectId, imageId } = await createProjectWithUploadedImage("Plan Queue Cap Retry");
			const { jobQueue } = await import("../services/queue.js");
			for (let index = 0; index < 5; index += 1) {
				await jobQueue.add({
					jobId: `plan-retry-cap-open-${crypto.randomUUID()}`,
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					lang: "th",
					prompt: `existing retry open job ${index}`,
					tier: "sfx-pro",
					quality: "low",
					status: "processing",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				}, { idempotencyKey: `plan-retry-cap-existing-${index}-${crypto.randomUUID()}` });
			}
			const sourceJobId = `plan-retry-cap-source-${crypto.randomUUID()}`;
			await jobQueue.add({
				jobId: sourceJobId,
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 1, h: 1 },
				lang: "th",
				prompt: "Retry should honor the free plan queue cap",
				tier: "sfx-pro",
				quality: "low",
				status: "error",
				error: "provider failed",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}, { idempotencyKey: sourceJobId });

			const retryKey = `plan-retry-cap-rejected-${crypto.randomUUID()}`;
			const retryRes = await fetch(`${BASE}/ai/status/${sourceJobId}/retry`, {
				method: "POST",
				headers: { "Idempotency-Key": retryKey },
			});
			expect(retryRes.status).toBe(429);
			const retry = await retryRes.json();
			expect(retry).toEqual(expect.objectContaining({
				code: "ai_queue_capacity_exceeded",
				reason: "project_open_limit",
			}));
			expect(retry.queue.limits.maxProjectOpenJobs).toBe(5);
			expect(await jobQueue.getByIdempotencyKey(retryKey)).toBeUndefined();
		});

		test("GET /api/ai/status/:jobId checks project ownership before returning job details", async () => {
			enableOpenAiProvider();
			const { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } = await import("../services/auth.service.js");
			const owner = await createUser({
				email: `status-owner-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Status Owner",
			});
			const other = await createUser({
				email: `status-other-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Status Other",
			});
			try {
				// Project creation now requires a verified email; confirm the owner's.
				await markEmailVerified(owner.user.id);
				const ownerUser = await loadUser(owner.user.id);
				const otherUser = await loadUser(other.user.id);
				expect(ownerUser).toBeTruthy();
				expect(otherUser).toBeTruthy();
				const ownerTokens = await generateTokens(ownerUser!);
				const otherTokens = await generateTokens(otherUser!);
				const projectRes = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${ownerTokens.accessToken}`,
					},
					body: JSON.stringify({ name: "Owned AI Status Project", lang: "th" }),
				});
				expect(projectRes.status).toBe(200);
				const { projectId } = await projectRes.json();

				const pngBuffer = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					"base64",
				);
				const fd = new FormData();
				fd.append("images", new Blob([pngBuffer], { type: "image/png" }), "owned.png");
				const upload = await fetch(`${BASE}/images/${projectId}/upload`, {
					method: "POST",
					headers: { Authorization: `Bearer ${ownerTokens.accessToken}` },
					body: fd,
				});
				expect(upload.status).toBe(200);
				const { imageIds } = await upload.json();

				const submitRes = await fetch(`${BASE}/ai/translate`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${ownerTokens.accessToken}`,
						"Idempotency-Key": `status-access-${crypto.randomUUID()}`,
					},
					body: JSON.stringify({
						projectId,
						imageId: imageIds[0],
						crop: { x: 0, y: 0, w: 1, h: 1 },
						lang: "th",
						tier: "sfx-pro",
					}),
				});
				expect(submitRes.status).toBe(200);
				const queued = await submitRes.json();

				const blocked = await fetch(`${BASE}/ai/status/${queued.jobId}`, {
					headers: { Authorization: `Bearer ${otherTokens.accessToken}` },
				});
				expect(blocked.status).toBe(404);

				const allowed = await fetch(`${BASE}/ai/status/${queued.jobId}`, {
					headers: { Authorization: `Bearer ${ownerTokens.accessToken}` },
				});
				expect(allowed.status).toBe(200);
			} finally {
				await deleteUser(owner.user.id);
				await deleteUser(other.user.id);
			}
		});

		test("GET /api/ai/status/:jobId returns 404 for non-existent job", async () => {
			const res = await fetch(`${BASE}/ai/status/non-existent`);
			expect(res.status).toBe(404);
		});

		test("GET /api/ai/status/:jobId exposes blocked jobs as terminal errors for existing pollers", async () => {
			enableOpenAiProvider();
			const { jobQueue } = await import("../services/queue.js");
			const blockedJobId = `blocked-status-${crypto.randomUUID()}`;
			await jobQueue.add({
				jobId: blockedJobId,
				projectId: testProjectId,
				imageId: testImageId,
				crop: { x: 0, y: 0, w: 10, h: 10 },
				lang: "th",
				prompt: "Provider blocked",
				tier: "sfx-pro",
				quality: "low",
				status: "blocked",
				error: "Provider blocked this request",
				retryable: false,
				failureCode: "content_policy",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}, { idempotencyKey: blockedJobId });

			const res = await fetch(`${BASE}/ai/status/${blockedJobId}`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual(expect.objectContaining({
				status: "error",
				queueStatus: "blocked",
				blocked: true,
				error: "Provider blocked this request",
				retryable: false,
				failureCode: "content_policy",
			}));
		});

		test("GET /api/ai/capabilities exposes provider readiness without secrets", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "pro";
			const res = await fetch(`${BASE}/ai/capabilities`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.planScoped).toBe(false);
			expect(data.plan).toBeNull();
			expect(data.tiers).toContainEqual(expect.objectContaining({
				id: "sfx-pro",
				available: true,
				provider: "openai-gpt-image-2",
			}));
			expect(data.tiers).toContainEqual(expect.objectContaining({
				id: "clean-pro",
				available: true,
				provider: "openai-gpt-image-2",
			}));
			expect(JSON.stringify(data)).not.toContain("openrouterApiKey");
			expect(JSON.stringify(data)).not.toContain("sk-test");
		});

		test("GET /api/ai/capabilities reports OpenAI image config when no key is configured", async () => {
			const res = await fetch(`${BASE}/ai/capabilities`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.tiers).toContainEqual(expect.objectContaining({
				id: "sfx-pro",
				available: false,
				provider: "openai-gpt-image-2",
				reason: "openai_images_not_configured",
			}));
		});

		test("GET /api/ai/capabilities keeps clean tiers on the same OpenAI image provider", async () => {
			enableOpenAiProvider();
			process.env.WORKSPACE_PLAN_ID = "pro";
			const res = await fetch(`${BASE}/ai/capabilities`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.tiers).toContainEqual(expect.objectContaining({
				id: "budget-clean",
				available: true,
				provider: "openai-gpt-image-2",
			}));
		});

		test("GET /api/ai/capabilities without a project does not apply workspace plan gates", async () => {
			enableOpenAiProvider();
			const res = await fetch(`${BASE}/ai/capabilities`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.planScoped).toBe(false);
			expect(data.plan).toBeNull();
			expect(data.tiers).toContainEqual(expect.objectContaining({
				id: "clean-pro",
				quality: "medium",
				available: true,
			}));
		});

		test("GET /api/ai/capabilities marks plan-blocked tiers unavailable for a project", async () => {
			enableOpenAiProvider();
			const res = await fetch(`${BASE}/ai/capabilities?projectId=${encodeURIComponent(testProjectId)}`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.planScoped).toBe(true);
			expect(data.plan).toEqual(expect.objectContaining({
				scope: "project",
				projectId: testProjectId,
				id: "free",
				allowedAiQualities: ["low", "medium"],
			}));
			// Free allows medium since the 2026-06-12 catalog, so clean-pro (medium
			// default) is available; only a HIGH selection is plan-blocked (asserted
			// in the SELECTED-quality test below).
			expect(data.tiers).toContainEqual(expect.objectContaining({
				id: "clean-pro",
				quality: "medium",
				available: true,
			}));
			expect(data.tiers).toContainEqual(expect.objectContaining({
				id: "budget-clean",
				quality: "low",
				available: true,
			}));
		});

		test("GET /api/ai/capabilities gates tiers against the SELECTED quality, not the tier default", async () => {
			enableOpenAiProvider();
			// With quality=low selected, EVERY tier the user
			// could actually run at low becomes available — including clean-pro, which the
			// tier-default (medium) path marks unavailable. This is what stops the panel
			// from false-locking clean-pro when generate at low would succeed.
			const lowRes = await fetch(`${BASE}/ai/capabilities?projectId=${encodeURIComponent(testProjectId)}&quality=low`);
			expect(lowRes.status).toBe(200);
			const lowData = await lowRes.json();
			expect(lowData.tiers).toContainEqual(expect.objectContaining({
				id: "clean-pro",
				quality: "low",
				available: true,
			}));
			expect(lowData.tiers).toContainEqual(expect.objectContaining({
				id: "budget-clean",
				quality: "low",
				available: true,
			}));

			// With quality=high selected (the value generate would charge), the same
			// tiers are correctly LOCKED for the free plan — matching what
			// assertAiQualityAllowedForProject does on generate (no 402 surprise).
			// (medium is free-allowed since the 2026-06-12 catalog, so HIGH is the
			// plan-blocked selection here.)
			const highRes = await fetch(`${BASE}/ai/capabilities?projectId=${encodeURIComponent(testProjectId)}&quality=high`);
			expect(highRes.status).toBe(200);
			const highData = await highRes.json();
			expect(highData.tiers).toContainEqual(expect.objectContaining({
				id: "budget-clean",
				quality: "high",
				available: false,
				reason: "ai_quality_not_allowed",
			}));
		});

		test("GET /api/ai/capabilities rejects an invalid quality", async () => {
			const res = await fetch(`${BASE}/ai/capabilities?quality=ultra`);
			expect(res.status).toBe(400);
		});

		test("GET /api/ai/admin/config requires admin auth", async () => {
			const res = await fetch(`${BASE}/ai/admin/config`);
			expect(res.status).toBe(401);
			const data = await res.json();
			expect(data.error).toContain("Unauthorized");
		});
	});

	describe("Import", () => {
		test("POST /api/project/:id/import-json returns 400 for malformed JSON", async () => {
			const projectRes = await fetch(`${BASE}/project/new`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Malformed import test", lang: "th" }),
			});
			const { projectId } = await projectRes.json();

			const res = await fetch(`${BASE}/project/${projectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{not-json",
			});

			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toBe("Invalid JSON body");
		}, 10_000);

		test("POST /api/project/:id/import-json imports translations", async () => {
			// First add a page with an image
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.pages = [{
				imageId: testImageId,
				imageName: testImageId,
				originalName: "test.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entries: [{
						image_path: "test.png",
						box: [10, 20, 100, 50],
						translated_text: "สวัสดี",
						index: 0,
					}],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(1);
			expect(data.skipped).toBe(0);
			expect(data.skippedByReason).toEqual({
				invalid_entry: 0,
				page_not_found: 0,
				invalid_layer: 0,
			});
			expect(data.pages).toEqual([
				expect.objectContaining({
					pageIndex: 0,
					originalName: "test.png",
					imported: 1,
				}),
			]);
		}, 10_000);

		test("import-json skips oversized/non-finite/non-object rows (invalid_entry) but imports valid ones", async () => {
			// Self-contained (fresh project) so the row-validation behavior is asserted
			// independently of shared-suite state.
			const { projectId, imageId } = await createProjectWithUploadedImage("Resilient Import");
			const state = await (await fetch(`${BASE}/project/${projectId}`)).json();
			state.targetLang = "th";
			state.targetLangs = ["th"];
			state.pages = [{
				imageId,
				imageName: imageId,
				originalName: "resilient.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${projectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entries: [
						// valid
						{ image_path: "resilient.png", box: [10, 20, 100, 50], translated_text: "ดี", index: 0 },
						// non-object row → invalid_entry, must NOT 500 the batch
						"not-an-object",
						// oversized text → invalid_entry
						{ image_path: "resilient.png", box: [0, 0, 50, 50], translated_text: "A".repeat(20_001), index: 1 },
						// non-finite bbox → invalid_entry
						{ image_path: "resilient.png", bbox: [0, 0, 1e12, 50], translated_text: "x", index: 2 },
						// another valid
						{ image_path: "resilient.png", box: [60, 20, 120, 50], translated_text: "เยี่ยม", index: 3 },
					],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(2);
			expect(data.skipped).toBe(3);
			expect(data.skippedByReason.invalid_entry).toBe(3);

			const after = await (await fetch(`${BASE}/project/${projectId}`)).json();
			const texts = after.pages[0].textLayers.map((l: { text: string }) => l.text);
			expect(texts).toContain("ดี");
			expect(texts).toContain("เยี่ยม");
			// The oversized row never persisted its multi-megabyte string.
			expect(after.pages[0].textLayers.every((l: { text: string }) => l.text.length < 20_001)).toBe(true);
		}, 10_000);

		test("import-json materializes a non-default lang into languageOutputs[lang], not flat textLayers", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.targetLang = "en";
			state.targetLangs = ["en", "th"];
			state.pages = [{
				imageId: testImageId,
				imageName: testImageId,
				originalName: "perlang.png",
				textLayers: [{ id: "src-1", text: "Hello", x: 0, y: 0, w: 100, h: 40, rotation: 0, fontSize: 24, alignment: "center", index: 0 }],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					lang: "th",
					entries: [{ image_path: "perlang.png", box: [10, 20, 100, 50], translated_text: "สวัสดี", index: 0 }],
				}),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).imported).toBe(1);

			const after = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			const page = after.pages[0];
			// The TH translation lands on the TH bucket...
			expect(page.languageOutputs?.th?.textLayers?.some((l: { text: string }) => l.text === "สวัสดี")).toBe(true);
			// ...and the flat (default EN) layer is untouched — no per-language illusion.
			expect(page.textLayers.some((l: { text: string }) => l.text === "สวัสดี")).toBe(false);
			expect(page.textLayers).toEqual([
				expect.objectContaining({ id: "src-1", text: "Hello" }),
			]);
		}, 10_000);

		test("import-json rejects a lang that is not a declared target track and writes nothing", async () => {
			// AUTHZ P1 (PR #311): importLang must be resolved + validated against the
			// project's normalized targetLangs BEFORE any write. A lang outside the
			// declared tracks may not materialize a languageOutputs bucket.
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.targetLang = "en";
			state.targetLangs = ["en", "th"];
			state.pages = [{
				imageId: testImageId,
				imageName: testImageId,
				originalName: "undeclared-lang.png",
				textLayers: [{ id: "src-1", text: "Hello", x: 0, y: 0, w: 100, h: 40, rotation: 0, fontSize: 24, alignment: "center", index: 0 }],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					lang: "ko", // NOT in targetLangs ["en", "th"]
					entries: [{ image_path: "undeclared-lang.png", box: [10, 20, 100, 50], translated_text: "안녕", index: 0 }],
				}),
			});
			expect(res.status).toBe(422);
			expect(await res.json()).toEqual(expect.objectContaining({
				code: "language_track_not_found",
				language: "ko",
			}));

			// Nothing was written: no `ko` bucket, flat layers untouched.
			const after = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			const page = after.pages[0];
			expect(page.languageOutputs?.ko).toBeUndefined();
			expect(page.textLayers).toEqual([
				expect.objectContaining({ id: "src-1", text: "Hello" }),
			]);
		}, 10_000);

		test("import-json denies a caller lacking import:project for the language BEFORE any write", async () => {
			// AUTHZ P1 (PR #311): the per-language ownership check must run BEFORE the
			// mutation. A viewer (no import:project permission) importing a declared
			// target lang is rejected and the project state stays unchanged.
			const { createUser, deleteUser, generateTokens, loadUser, updateUser, markEmailVerified } = await import("../services/auth.service.js");
			const created = await createUser({
				email: `import-viewer-${crypto.randomUUID()}@example.com`,
				password: "StrongP@ss123",
				name: "Import Viewer",
			});
			try {
				await markEmailVerified(created.user.id);
				const editorUser = await loadUser(created.user.id);
				const editorTokens = await generateTokens(editorUser!);
				const createRes = await fetch(`${BASE}/project/new`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorTokens.accessToken}` },
					body: JSON.stringify({ name: "Import Authz Guard", lang: "en" }),
				});
				expect(createRes.status).toBe(200);
				const { projectId } = await createRes.json();

				// Declare "th" as a real target track via the dedicated languages
				// endpoint (the only path that can add a track) so the lang is VALID and
				// the ONLY thing that can block the import is the per-language permission
				// check.
				const addTrack = await fetch(`${BASE}/project/${projectId}/languages`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorTokens.accessToken}` },
					body: JSON.stringify({ language: "th" }),
				});
				expect(addTrack.status).toBe(200);
				expect((await addTrack.json()).targetLangs).toEqual(["en", "th"]);

				// Give the project a real page to import onto.
				const state = await (await fetch(`${BASE}/project/${projectId}`, {
					headers: { Authorization: `Bearer ${editorTokens.accessToken}` },
				})).json();
				state.pages = [{
					imageId: testImageId,
					imageName: testImageId,
					originalName: "authz.png",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				}];
				await fetch(`${BASE}/project/${projectId}/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorTokens.accessToken}` },
					body: JSON.stringify(state),
				});

				// Demote the owner to viewer (read:project + export:project only, NO
				// import:project).
				await updateUser(created.user.id, { role: "viewer" });

				const res = await fetch(`${BASE}/project/${projectId}/import-json`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorTokens.accessToken}` },
					body: JSON.stringify({
						lang: "th", // declared, so only the permission gate can block this
						entries: [{ image_path: "authz.png", box: [10, 20, 100, 50], translated_text: "สวัสดี", index: 0 }],
					}),
				});
				expect(res.status).toBe(403);
				expect(await res.json()).toEqual(expect.objectContaining({
					error: "Forbidden: Missing permission 'import:project'",
				}));

				// No write happened: no `th` bucket on the page.
				const after = await (await fetch(`${BASE}/project/${projectId}`, {
					headers: { Authorization: `Bearer ${editorTokens.accessToken}` },
				})).json();
				expect(after.pages[0].languageOutputs?.th).toBeUndefined();
			} finally {
				await deleteUser(created.user.id);
			}
		}, 15_000);

		test("import-json default/no-lang path still writes flat textLayers (byte-compatible)", async () => {
			// A valid member importing the default (or omitting lang) keeps writing the
			// flat page.textLayers — the round-1 single-language behavior is preserved.
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.targetLang = "en";
			state.targetLangs = ["en", "th"];
			state.pages = [{
				imageId: testImageId,
				imageName: testImageId,
				originalName: "flat-default.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					// no lang ⇒ default (en) ⇒ flat write
					entries: [{ image_path: "flat-default.png", box: [10, 20, 100, 50], translated_text: "Hi there", index: 0 }],
				}),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).imported).toBe(1);

			const after = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			const page = after.pages[0];
			expect(page.textLayers.some((l: { text: string }) => l.text === "Hi there")).toBe(true);
			// Default import does not materialize a per-language bucket.
			expect(page.languageOutputs?.en).toBeUndefined();
		}, 10_000);

		test("import-json matches absolute image paths by filename and skips empty translated text", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.pages = [{
				imageId: testImageId,
				imageName: testImageId,
				originalName: "image-01.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					version: 1,
					entries: [
						{
							image_path: "C:\\Users\\Suphot\\Downloads\\p104\\image-01.webp",
							box: [10, 20, 110, 70],
							original_text: "HELLO",
							translated_text: "สวัสดี",
						},
						{
							image_path: "C:\\Users\\Suphot\\Downloads\\p104\\image-01.webp",
							box: [20, 30, 120, 80],
							original_text: "CREDIT",
							translated_text: "",
						},
					],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(1);
			expect(data.skipped).toBe(1);
			expect(data.skippedByReason.invalid_layer).toBe(1);
			expect(data.pages).toEqual([
				expect.objectContaining({
					pageIndex: 0,
					originalName: "image-01.webp",
					imported: 1,
				}),
			]);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toEqual([
				expect.objectContaining({
					text: "สวัสดี",
					sourceText: "HELLO",
					sourceProvider: "json-import",
					x: 10,
					y: 20,
					w: 100,
					h: 50,
				}),
			]);
		}, 10_000);

		test("import-json keeps existing translator slots and clean handoff on target page", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			const savedAt = "2026-05-22T10:00:00.000Z";
			const translationScriptSlots = [{
				id: "dialogue-existing",
				label: "ช่องแปลเดิม",
				x: 55,
				y: 35,
				category: "dialogue",
				sourceText: "Existing source",
				translatedText: "ข้อความเดิม",
				note: "ห้ามหายตอน import",
				updatedAt: savedAt,
			}];
			const cleaningHandoff = {
				status: "clean_ready",
				updatedAt: savedAt,
				updatedBy: "cleaner-b",
				note: "คลีนแล้วก่อน import json",
			};
			const translationHandoff = {
				status: "translated",
				updatedAt: savedAt,
				updatedBy: "translator-b",
				note: "ห้ามหายตอน import",
			};
			const qcHandoff = {
				status: "ready",
				updatedAt: savedAt,
				updatedBy: "qc-b",
				note: "import แล้วต้องกลับไปรอปิด QC",
			};
			state.currentPage = 0;
			state.pages = [{
				imageId: testImageId,
				imageName: testImageId,
				originalName: "image-01.webp",
				textLayers: [],
				translationScriptSlots,
				translationHandoff,
				cleaningHandoff,
				qcHandoff,
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entries: [{
						image_path: "image-01.webp",
						box: [30, 40, 170, 100],
						original_text: "NEW LINE",
						translated_text: "บรรทัดใหม่",
					}],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(1);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].translationScriptSlots).toEqual(translationScriptSlots);
			expect(updated.pages[0].translationHandoff).toEqual(translationHandoff);
			expect(updated.pages[0].cleaningHandoff).toEqual(cleaningHandoff);
			expect(updated.pages[0].qcHandoff).toMatchObject({
				status: "pending",
				updatedBy: "import-json",
				note: "import แล้วต้องกลับไปรอปิด QC",
			});
			expect(updated.pages[0].textLayers).toEqual([
				expect.objectContaining({
					text: "บรรทัดใหม่",
					sourceText: "NEW LINE",
					sourceProvider: "json-import",
					x: 30,
					y: 40,
					w: 140,
					h: 60,
				}),
			]);
		}, 10_000);

		test("import-json accepts OCR items on the current page as editable text layers", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [{
				imageId: testImageId,
				imageName: testImageId,
				originalName: "image-01.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pageIndex: 0,
					items: [{
						text: "HELLO",
						cat: "dialogue",
						bbox: [50, 60, 200, 90],
						confidence: 0.91,
					}],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(1);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers[0]).toEqual(expect.objectContaining({
				text: "HELLO",
				sourceCategory: "dialogue",
				confidence: 0.91,
				x: 50,
				y: 60,
				w: 200,
				h: 90,
			}));
		}, 10_000);

		test("import-json splits multi-page entries by image_path before pageIndex fallback", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [
				{
					imageId: `${testImageId}`,
					imageName: `${testImageId}`,
					originalName: "image-01.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
				{
					imageId: `${testImageId}`,
					imageName: `${testImageId}`,
					originalName: "image-02.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
			];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pageIndex: 0,
					entries: [{
						image_path: "C:\\Users\\Suphot\\Downloads\\p104\\image-02.webp",
						box: [10, 20, 110, 70],
						translated_text: "หน้าสอง",
					}],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.pages).toEqual([
				expect.objectContaining({
					pageIndex: 1,
					originalName: "image-02.webp",
					imported: 1,
				}),
			]);
			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toHaveLength(0);
			expect(updated.pages[1].textLayers).toEqual([
				expect.objectContaining({ text: "หน้าสอง" }),
			]);
		}, 10_000);

		test("import-json skips image_path entries that do not match the open project pages", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [{
				imageId: `${testImageId}`,
				imageName: `${testImageId}`,
				originalName: "image-01.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pageIndex: 0,
					entries: [
						{
							image_path: "C:\\Users\\Suphot\\Downloads\\p104\\image-01.webp",
							box: [10, 20, 110, 70],
							translated_text: "หน้าเดียว",
						},
						{
							image_path: "C:\\Users\\Suphot\\Downloads\\p104\\image-02.webp",
							box: [20, 30, 120, 80],
							translated_text: "ต้องไม่เข้าหน้าแรก",
						},
					],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(1);
			expect(data.skipped).toBe(1);
			expect(data.skippedByReason.page_not_found).toBe(1);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toEqual([
				expect.objectContaining({ text: "หน้าเดียว" }),
			]);
		}, 10_000);

		test("import-json falls back to image_path order when OCR filenames do not match pages", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [
				{
					imageId: `${testImageId}`,
					imageName: `${testImageId}`,
					originalName: "page-a.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
				{
					imageId: `${testImageId}`,
					imageName: `${testImageId}`,
					originalName: "page-b.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
			];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entries: [
						{
							image_path: "C:\\Users\\Suphot\\Downloads\\p104\\scan-002.webp",
							box: [20, 30, 120, 80],
							translated_text: "page two text",
						},
						{
							image_path: "C:\\Users\\Suphot\\Downloads\\p104\\scan-001.webp",
							box: [10, 20, 110, 70],
							translated_text: "page one text",
						},
					],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(2);
			expect(data.skipped).toBe(0);
			expect(data.orderMapped).toBe(2);
			expect(data.orderMappedPaths).toEqual(["scan-001.webp", "scan-002.webp"]);
			expect(data.pages).toEqual([
				expect.objectContaining({ pageIndex: 0, originalName: "page-a.webp", imported: 1 }),
				expect.objectContaining({ pageIndex: 1, originalName: "page-b.webp", imported: 1 }),
			]);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toEqual([
				expect.objectContaining({ text: "page one text" }),
			]);
			expect(updated.pages[1].textLayers).toEqual([
				expect.objectContaining({ text: "page two text" }),
			]);
		}, 10_000);

		test("import-json does not order-map partial chapter JSON without explicit source remap", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [{
				imageId: `${testImageId}`,
				imageName: `${testImageId}`,
				originalName: "uploaded-page-05.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entries: [
						{
							image_path: "chapter/page-01.webp",
							bbox: [10, 20, 110, 70],
							translated_text: "page one should not import",
						},
						{
							image_path: "chapter/page-05.webp",
							bbox: [20, 30, 120, 80],
							translated_text: "page five needs remap",
						},
					],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(0);
			expect(data.skipped).toBe(2);
			expect(data.skippedByReason.page_not_found).toBe(2);
			expect(data.orderMapped).toBe(0);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toHaveLength(0);
		}, 10_000);

		test("import-json remaps a selected JSON source page into the current uploaded image", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [{
				imageId: `${testImageId}`,
				imageName: `${testImageId}`,
				originalName: "uploaded-page-05.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			}];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					targetPageIndex: 0,
					sourcePageNumber: 5,
					entries: [
						{
							pageNumber: 1,
							bbox: [10, 20, 110, 70],
							translated_text: "page one should be ignored",
						},
						{
							pageNumber: 5,
							bbox: [20, 30, 120, 80],
							translated_text: "page five imported",
						},
						{
							pageNumber: 10,
							bbox: [30, 40, 130, 90],
							translated_text: "page ten should be ignored",
						},
					],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(1);
			expect(data.skipped).toBe(0);
			expect(data.sourceFiltered).toBe(2);
			expect(data.sourceMapped).toEqual(expect.objectContaining({
				targetPageIndex: 0,
				sourcePageIndex: 4,
				sourcePageNumber: 5,
				ignoredEntries: 2,
			}));
			expect(data.pages).toEqual([
				expect.objectContaining({ pageIndex: 0, originalName: "uploaded-page-05.webp", imported: 1 }),
			]);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toEqual([
				expect.objectContaining({ text: "page five imported" }),
			]);
		}, 10_000);

		test("import-json maps multiple selected JSON source pages into target pages in one request", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [
				{
					imageId: `${testImageId}`,
					imageName: `${testImageId}`,
					originalName: "uploaded-page-05.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
				{
					imageId: "22222222-2222-4222-8222-222222222222.webp",
					imageName: "22222222-2222-4222-8222-222222222222.webp",
					originalName: "uploaded-page-08.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
			];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mappings: [
						{ targetPageIndex: 0, sourcePageNumber: 5 },
						{ targetPageIndex: 1, sourcePageNumber: 8 },
					],
					entries: [
						{
							pageNumber: 8,
							image_path: "chapter/source-page-08.webp",
							bbox: [30, 40, 130, 90],
							translated_text: "source page eight imported",
						},
						{
							pageNumber: 5,
							image_path: "chapter/source-page-05.webp",
							bbox: [20, 30, 120, 80],
							translated_text: "source page five imported",
						},
						{
							pageNumber: 10,
							image_path: "chapter/source-page-10.webp",
							bbox: [40, 50, 140, 100],
							translated_text: "source page ten should be ignored",
						},
					],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(2);
			expect(data.skipped).toBe(0);
			expect(data.skippedByReason.page_not_found).toBe(0);
			expect(data.sourceFiltered).toBe(1);
			expect(data.orderMapped).toBe(0);
			expect(data.sourceMappings).toEqual([
				expect.objectContaining({
					targetPageIndex: 0,
					sourcePageIndex: 4,
					sourcePageNumber: 5,
					imported: 1,
				}),
				expect.objectContaining({
					targetPageIndex: 1,
					sourcePageIndex: 7,
					sourcePageNumber: 8,
					imported: 1,
				}),
			]);
			expect(data.pages).toEqual([
				expect.objectContaining({ pageIndex: 0, originalName: "uploaded-page-05.webp", imported: 1 }),
				expect.objectContaining({ pageIndex: 1, originalName: "uploaded-page-08.webp", imported: 1 }),
			]);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toEqual([
				expect.objectContaining({ text: "source page five imported" }),
			]);
			expect(updated.pages[1].textLayers).toEqual([
				expect.objectContaining({ text: "source page eight imported" }),
			]);
		}, 10_000);

		test("import-json rejects duplicate explicit target mappings before writing layers", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [
				{
					imageId: `${testImageId}`,
					imageName: `${testImageId}`,
					originalName: "uploaded-page-05.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
				{
					imageId: "22222222-2222-4222-8222-222222222222.webp",
					imageName: "22222222-2222-4222-8222-222222222222.webp",
					originalName: "uploaded-page-08.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
			];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mappings: [
						{ targetPageIndex: 0, sourcePageNumber: 5 },
						{ targetPageIndex: 0, sourcePageNumber: 8 },
					],
					entries: [
						{ pageNumber: 5, bbox: [20, 30, 120, 80], translated_text: "page five" },
						{ pageNumber: 8, bbox: [30, 40, 130, 90], translated_text: "page eight" },
					],
				}),
			});
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data).toEqual({
				error: "Duplicate target page mapping",
				targetPageIndex: 0,
			});

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toHaveLength(0);
			expect(updated.pages[1].textLayers).toHaveLength(0);
		}, 10_000);

		test("import-json rejects duplicate explicit source mappings before writing layers", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [
				{
					imageId: `${testImageId}`,
					imageName: `${testImageId}`,
					originalName: "uploaded-page-05.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
				{
					imageId: "22222222-2222-4222-8222-222222222222.webp",
					imageName: "22222222-2222-4222-8222-222222222222.webp",
					originalName: "uploaded-page-08.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
			];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mappings: [
						{ targetPageIndex: 0, sourcePageNumber: 5 },
						{ targetPageIndex: 1, sourcePageNumber: 5 },
					],
					entries: [
						{ pageNumber: 5, bbox: [20, 30, 120, 80], translated_text: "page five" },
					],
				}),
			});
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data).toEqual({
				error: "Duplicate source mapping",
				targetPageIndex: 1,
			});

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toHaveLength(0);
			expect(updated.pages[1].textLayers).toHaveLength(0);
		}, 10_000);

		test("import-json accepts stable page and image aliases without hallucinated path fallback", async () => {
			const state = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			state.currentPage = 0;
			state.pages = [
				{
					imageId: `${testImageId}`,
					imageName: `${testImageId}`,
					originalName: "image-01.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
				{
					imageId: "11111111-1111-4111-8111-111111111111.webp",
					imageName: "11111111-1111-4111-8111-111111111111.webp",
					originalName: "image-02.webp",
					textLayers: [],
					pendingAiJobs: [],
					coverRect: null,
				},
			];
			await fetch(`${BASE}/project/${testProjectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(state),
			});

			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entries: [
						{
							pageNumber: 1,
							box: [10, 20, 110, 70],
							translated_text: "เลขหน้า",
						},
						{
							fileName: "image-02.webp",
							box: [20, 30, 120, 80],
							translated_text: "ชื่อไฟล์",
						},
						{
							imageName: "not-real.webp",
							box: [30, 40, 130, 90],
							translated_text: "ไม่ควรเข้า",
						},
					],
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(2);
			expect(data.skipped).toBe(1);
			expect(data.skippedByReason.page_not_found).toBe(1);
			expect(data.pages).toEqual([
				expect.objectContaining({ pageIndex: 0, originalName: "image-01.webp", imported: 1 }),
				expect.objectContaining({ pageIndex: 1, originalName: "image-02.webp", imported: 1 }),
			]);

			const updated = await (await fetch(`${BASE}/project/${testProjectId}`)).json();
			expect(updated.pages[0].textLayers).toEqual([
				expect.objectContaining({ text: "เลขหน้า" }),
			]);
			expect(updated.pages[1].textLayers).toEqual([
				expect.objectContaining({ text: "ชื่อไฟล์" }),
			]);
		}, 10_000);

		test("import with empty entries returns 0 imported", async () => {
			const res = await fetch(`${BASE}/project/${testProjectId}/import-json`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ entries: [] }),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.imported).toBe(0);
			expect(data.skipped).toBe(0);
			expect(data.pages).toEqual([]);
		});
	});
});
