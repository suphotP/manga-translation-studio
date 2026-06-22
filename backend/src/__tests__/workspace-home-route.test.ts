// HTTP integration test for GET /api/workspaces/:id/home.
//
// Proves the KEYSTONE behaviour: the aggregate is built across MULTIPLE projects
// the member can see WITHOUT any project being "open", and is gated on workspace
// membership. Uses the app's default test runtime (file-backed workspace/catalog
// stores, per-pid temp DATA_DIR) and `app.request` directly — exactly like
// credits-route.test.ts — so it does NOT mutate env or patch global fetch (which
// would leak state into sibling test files).

// Raise the shared per-process API rate-limit budget BEFORE anything imports the
// app (the layered limiter snapshots RATE_LIMIT_API_* at middleware construction).
// The bun runner shares ONE process across all 100+ test files and the api:global
// limit is IP-scoped, so every file's requests draw from the same 600/min budget;
// without this, the extra create/home requests these tests issue can tip a sibling
// file (credits/import/storage) over the cap → spurious 429s. Set at module-eval so
// it lands no matter which file imports the app first.
process.env.RATE_LIMIT_API_PER_MINUTE ||= "100000";
process.env.RATE_LIMIT_API_PER_HOUR ||= "1000000";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } from "../services/auth.service.js";
import { projectCatalogStore } from "../services/project-catalog.js";

// The app is imported lazily in beforeAll AFTER setting permissive AI-submit
// rate limits. The config singleton reads those env vars at import time, and the
// runner shares one process across test files — so importing the app statically
// here could initialize config before a sibling file's beforeAll sets its limits,
// making the sibling's AI-submit assertions hit an unexpected 429. Deferring the
// import (and matching routes.test.ts's limits) keeps the shared config
// consistent regardless of which app-importing file initializes config first.
let app: Hono;

const createdUserIds: string[] = [];

beforeAll(async () => {
	process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE ||= "1000";
	process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE ||= "10000";
	process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR ||= "10000";
	app = (await import("../index.js")).app as unknown as Hono;
});

async function makeVerifiedUser(emailPrefix: string): Promise<{ id: string; email: string; token: string }> {
	const created = await createUser({
		email: `${emailPrefix}-${crypto.randomUUID()}@example.com`,
		password: "StrongP@ss123",
		name: emailPrefix,
	});
	createdUserIds.push(created.user.id);
	await markEmailVerified(created.user.id);
	const user = await loadUser(created.user.id);
	const tokens = await generateTokens(user!);
	return { id: user!.id, email: user!.email, token: tokens.accessToken };
}

function authHeaders(token: string, json = false): Record<string, string> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (json) headers["Content-Type"] = "application/json";
	return headers;
}

async function createWorkspace(token: string, name: string): Promise<string> {
	const res = await app.request("/api/workspaces", {
		method: "POST",
		headers: authHeaders(token, true),
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).workspace.workspaceId as string;
}

async function createWorkspaceProject(token: string, workspaceId: string, name: string): Promise<string> {
	const res = await app.request("/api/project/new", {
		method: "POST",
		headers: authHeaders(token, true),
		body: JSON.stringify({ name, lang: "th", workspaceId }),
	});
	expect(res.status).toBe(200);
	return (await res.json()).projectId as string;
}

// A "legacy"/personal project: created with NO workspaceId, so its persisted state
// carries no workspace stamp (state.workspaceId is null/empty). This is the exact
// shape — pre-#277 projects, or any create without a workspace stamp — that the
// project browser (`GET /api/project`, user-ownership listing) shows but the
// workspace-scoped /home listing used to drop.
async function createPersonalProject(token: string, name: string): Promise<string> {
	const res = await app.request("/api/project/new", {
		method: "POST",
		headers: authHeaders(token, true),
		body: JSON.stringify({ name, lang: "th" }),
	});
	expect(res.status).toBe(200);
	const { projectId } = await res.json();
	// Sanity: the persisted state really has no workspace stamp.
	const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(token) });
	const state = await stateRes.json();
	expect(state.workspaceId == null || state.workspaceId === "").toBe(true);
	return projectId as string;
}

// The user's auto-provisioned personal/default workspace (role "owner"). Owned,
// unfiled (null-workspace) projects logically belong to this workspace, and the
// /home aggregate must surface them here to match the Library.
async function personalWorkspaceId(token: string): Promise<string> {
	const res = await app.request("/api/workspaces", { headers: authHeaders(token) });
	expect(res.status).toBe(200);
	const body = await res.json();
	const owned = (body.workspaces as Array<{ workspaceId: string; memberRole: string }>).find((w) => w.memberRole === "owner");
	expect(owned).toBeDefined();
	return owned!.workspaceId;
}

// Give the project one page (so the standard per-page workflow tasks materialize)
// and assign the page-0 translate task to `assignee` via the real PATCH endpoint —
// `ensureProjectWorkflow` owns task identity, so we assign a materialized task
// rather than injecting a synthetic one into saved state.
async function seedProjectWithAssignedTask(token: string, projectId: string, assignee: string): Promise<void> {
	const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(token) });
	expect(stateRes.status).toBe(200);
	const state = await stateRes.json();
	state.pages = [{ imageId: "img-1", imageName: "p1.webp", textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null }];
	state.currentPage = 0;
	const saveRes = await app.request(`/api/project/${projectId}/save`, {
		method: "POST",
		headers: authHeaders(token, true),
		body: JSON.stringify(state),
	});
	expect(saveRes.status).toBe(200);

	const patchRes = await app.request(`/api/project/${projectId}/tasks/page-0-translate`, {
		method: "PATCH",
		headers: authHeaders(token, true),
		body: JSON.stringify({ assignee, priority: "high" }),
	});
	expect(patchRes.status).toBe(200);
}

afterAll(async () => {
	for (const id of createdUserIds) await deleteUser(id).catch(() => undefined);
});

describe("GET /api/workspaces/:id/home", () => {
	test("aggregates My-Work / pipeline ACROSS multiple projects with no chapter open", async () => {
		const owner = await makeVerifiedUser("ws-home-owner");
		const workspaceId = await createWorkspace(owner.token, "Home Aggregate WS");

		// Two projects in the workspace, each with a task assigned to the owner.
		const projectA = await createWorkspaceProject(owner.token, workspaceId, "Story A — Ch 1");
		const projectB = await createWorkspaceProject(owner.token, workspaceId, "Story B — Ch 2");
		await seedProjectWithAssignedTask(owner.token, projectA, owner.email);
		await seedProjectWithAssignedTask(owner.token, projectB, owner.email);

		const homeRes = await app.request(`/api/workspaces/${workspaceId}/home`, { headers: authHeaders(owner.token) });
		expect(homeRes.status).toBe(200);
		const home = await homeRes.json();

		// The translate task assigned in BOTH projects surfaces in My-Work — proving
		// cross-project aggregation independent of any single open chapter.
		const myProjectIds = home.myTasks.map((t: any) => t.projectId).sort();
		expect(myProjectIds).toEqual([projectA, projectB].sort());
		expect(home.myTasks.every((t: any) => t.type === "translate")).toBe(true);
		expect(home.counts.myOpenTasks).toBe(2);
		expect(home.counts.projects).toBeGreaterThanOrEqual(2);

		// Pipeline merges the materialized translate tasks across both projects
		// (one translate task per project page).
		const translate = home.pipelineByStage.find((p: any) => p.stage === "translate");
		expect(translate.total).toBeGreaterThanOrEqual(2);
		expect(translate.open).toBeGreaterThanOrEqual(2);

		// generatedAt is present and the response is honest data, not a mock.
		expect(typeof home.generatedAt).toBe("string");
	});

	test("caches the aggregate: a repeat visit with no project change skips the per-project state reads", async () => {
		const owner = await makeVerifiedUser("ws-home-cache");
		const workspaceId = await createWorkspace(owner.token, "Cache WS");
		const projectA = await createWorkspaceProject(owner.token, workspaceId, "Cache A");
		const projectB = await createWorkspaceProject(owner.token, workspaceId, "Cache B");
		await seedProjectWithAssignedTask(owner.token, projectA, owner.email);
		await seedProjectWithAssignedTask(owner.token, projectB, owner.email);

		// Count the EXPENSIVE work: full project-state reads. The cache must serve a
		// repeat dashboard visit without re-reading every project state.
		const original = projectCatalogStore.getProjectState.bind(projectCatalogStore);
		let stateReads = 0;
		(projectCatalogStore as { getProjectState: typeof original }).getProjectState = (async (
			projectId: string,
		) => {
			stateReads += 1;
			return original(projectId);
		}) as typeof original;

		try {
			// First visit: cold cache → reads each project's state.
			const first = await app.request(`/api/workspaces/${workspaceId}/home`, { headers: authHeaders(owner.token) });
			expect(first.status).toBe(200);
			const firstBody = await first.json();
			const coldReads = stateReads;
			expect(coldReads).toBeGreaterThanOrEqual(2); // both projects read

			// Second visit, nothing changed → served from cache, ZERO new state reads.
			const second = await app.request(`/api/workspaces/${workspaceId}/home`, { headers: authHeaders(owner.token) });
			expect(second.status).toBe(200);
			expect(stateReads).toBe(coldReads); // no additional reads
			// Same honest aggregate (cache returns equivalent data).
			expect((await second.json()).counts.projects).toBe(firstBody.counts.projects);

			// Mutating a project's state advances its updatedAt → busts the signature →
			// the next visit re-reads state (cache must not serve stale data).
			await seedProjectWithAssignedTask(owner.token, projectA, owner.email);
			const beforeWarm = stateReads;
			const third = await app.request(`/api/workspaces/${workspaceId}/home`, { headers: authHeaders(owner.token) });
			expect(third.status).toBe(200);
			expect(stateReads).toBeGreaterThan(beforeWarm); // cache busted → fresh reads
		} finally {
			(projectCatalogStore as { getProjectState: typeof original }).getProjectState = original;
		}
	});

	test("denies a non-member (404 workspace_not_found)", async () => {
		const owner = await makeVerifiedUser("ws-home-owner2");
		const intruder = await makeVerifiedUser("ws-home-intruder");
		const workspaceId = await createWorkspace(owner.token, "Private WS");

		const res = await app.request(`/api/workspaces/${workspaceId}/home`, { headers: authHeaders(intruder.token) });
		expect(res.status).toBe(404);
		expect((await res.json()).code).toBe("workspace_not_found");
	});

	test("returns honest empty aggregate for a workspace with no projects", async () => {
		const owner = await makeVerifiedUser("ws-home-empty");
		const workspaceId = await createWorkspace(owner.token, "Empty WS");

		const res = await app.request(`/api/workspaces/${workspaceId}/home`, { headers: authHeaders(owner.token) });
		expect(res.status).toBe(200);
		const home = await res.json();
		expect(home.myTasks).toEqual([]);
		expect(home.attention).toEqual([]);
		expect(home.activity).toEqual([]);
		expect(home.counts.projects).toBe(0);
		expect(home.pipelineByStage).toHaveLength(4);
	});

	test("bounded discovery: an EMPTY target workspace does NOT page the user's other-workspace projects", async () => {
		const owner = await makeVerifiedUser("ws-home-bounded");

		// The user owns MANY projects in workspace A...
		const busyWs = await createWorkspace(owner.token, "Busy WS");
		const otherWorkspaceProjects: string[] = [];
		for (let i = 0; i < 12; i += 1) {
			otherWorkspaceProjects.push(await createWorkspaceProject(owner.token, busyWs, `Busy ${i}`));
		}
		// ...and an EMPTY workspace B that the dashboard is loaded for.
		const emptyWs = await createWorkspace(owner.token, "Empty Target WS");

		// Spy on the catalog's source listing to count how many pages the endpoint
		// scans and which workspace it actually queries. The fix passes `workspaceId`
		// to the source AND caps page scans, so an empty target must:
		//   (a) query the source filtered to the EMPTY workspace, and
		//   (b) scan a bounded number of pages — never the user's whole project space.
		const original = projectCatalogStore.listProjectSummaryPage.bind(projectCatalogStore);
		const scannedWorkspaceIds: Array<string | undefined> = [];
		let scanCount = 0;
		(projectCatalogStore as { listProjectSummaryPage: typeof original }).listProjectSummaryPage = (async (
			options: Parameters<typeof original>[0] = {},
		) => {
			scanCount += 1;
			scannedWorkspaceIds.push(options?.workspaceId);
			return original(options);
		}) as typeof original;

		try {
			const res = await app.request(`/api/workspaces/${emptyWs}/home`, { headers: authHeaders(owner.token) });
			expect(res.status).toBe(200);
			const home = await res.json();
			expect(home.counts.projects).toBe(0);
			expect(home.myTasks).toEqual([]);
		} finally {
			(projectCatalogStore as { listProjectSummaryPage: typeof original }).listProjectSummaryPage = original;
		}

		// The source listing was queried WORKSPACE-SCOPED to the empty workspace
		// (never user-wide), so the busy workspace's 12 projects are never paged in.
		expect(scannedWorkspaceIds.every((id) => id === emptyWs)).toBe(true);
		expect(scannedWorkspaceIds).not.toContain(busyWs);
		// And the number of source pages scanned is hard-bounded — proving the work
		// done is bounded, not proportional to the user's total project count.
		expect(scanCount).toBeGreaterThanOrEqual(1);
		expect(scanCount).toBeLessThanOrEqual(3);
		// Sanity: the busy workspace really did have many projects to (not) scan.
		expect(otherWorkspaceProjects.length).toBe(12);
	});

	// P0 reconciliation: the dashboard /home aggregate must include the SAME owned
	// projects the Library (`GET /api/project`) shows for the user's personal/default
	// workspace. A project owned by the user with NO workspaceId (legacy / pre-#277 /
	// unstamped) used to be dropped by the workspace-scoped listing — leaving the
	// dashboard empty while the Library showed real projects. The two must AGREE.
	test("includes an OWNED null-workspace project in the user's personal/default workspace /home (matches Library)", async () => {
		const owner = await makeVerifiedUser("ws-home-personal");
		const personalWs = await personalWorkspaceId(owner.token);

		// A legacy/personal project with NO workspace stamp + a page-0 translate task
		// assigned to the owner.
		const legacyProject = await createPersonalProject(owner.token, "Unfiled Story — Ch 1");
		await seedProjectWithAssignedTask(owner.token, legacyProject, owner.email);

		// The Library (user-ownership listing) shows it.
		const libraryRes = await app.request("/api/project", { headers: authHeaders(owner.token) });
		expect(libraryRes.status).toBe(200);
		const libraryIds = (await libraryRes.json()).projects.map((p: any) => p.projectId);
		expect(libraryIds).toContain(legacyProject);

		// BEFORE the fix this dashboard was empty; AFTER, the same project's real data
		// surfaces in the hero / pipeline / my-tasks — reconciled with the Library.
		const homeRes = await app.request(`/api/workspaces/${personalWs}/home`, { headers: authHeaders(owner.token) });
		expect(homeRes.status).toBe(200);
		const home = await homeRes.json();

		expect(home.myTasks.map((t: any) => t.projectId)).toContain(legacyProject);
		expect(home.counts.myOpenTasks).toBeGreaterThanOrEqual(1);
		expect(home.counts.projects).toBeGreaterThanOrEqual(1);
		const translate = home.pipelineByStage.find((p: any) => p.stage === "translate");
		expect(translate.total).toBeGreaterThanOrEqual(1);
		expect(home.recentProject).not.toBeNull();
		expect(home.recentProject.projectId).toBe(legacyProject);
	});

	test("does NOT leak a project that explicitly belongs to a DIFFERENT workspace into the personal /home", async () => {
		const owner = await makeVerifiedUser("ws-home-isolation");
		const personalWs = await personalWorkspaceId(owner.token);

		// One owned null-workspace project (SHOULD appear) and one project explicitly
		// stamped to a separate, real workspace the user also owns (MUST NOT appear in
		// the personal-workspace dashboard).
		const legacyProject = await createPersonalProject(owner.token, "Unfiled — keep");
		const foreignWs = await createWorkspace(owner.token, "Foreign WS");
		const foreignProject = await createWorkspaceProject(owner.token, foreignWs, "Foreign — exclude");
		await seedProjectWithAssignedTask(owner.token, legacyProject, owner.email);
		await seedProjectWithAssignedTask(owner.token, foreignProject, owner.email);

		const homeRes = await app.request(`/api/workspaces/${personalWs}/home`, { headers: authHeaders(owner.token) });
		expect(homeRes.status).toBe(200);
		const home = await homeRes.json();

		const homeProjectIds: string[] = home.myTasks.map((t: any) => t.projectId);
		expect(homeProjectIds).toContain(legacyProject);
		// Real cross-workspace isolation: the explicitly-foreign-workspace project is
		// NOT folded into this workspace's aggregate.
		expect(homeProjectIds).not.toContain(foreignProject);

		// Symmetric check: the foreign workspace's dashboard shows ITS project and not
		// the unfiled one.
		const foreignHomeRes = await app.request(`/api/workspaces/${foreignWs}/home`, { headers: authHeaders(owner.token) });
		expect(foreignHomeRes.status).toBe(200);
		const foreignHome = await foreignHomeRes.json();
		const foreignIds: string[] = foreignHome.myTasks.map((t: any) => t.projectId);
		expect(foreignIds).toContain(foreignProject);
		expect(foreignIds).not.toContain(legacyProject);
	});
});

// P1: in file mode (default test runtime = file-backed stores) a workspace-scoped
// project create must SUCCEED for a member and STAMP state.workspaceId so the
// dashboard / home aggregate can find it — and must be membership-gated so a
// non-member can never stamp a workspace they don't belong to.
describe("POST /api/project/new (workspace-scoped create, file mode)", () => {
	test("member create stamps state.workspaceId and surfaces in /home", async () => {
		const owner = await makeVerifiedUser("ws-create-owner");
		const workspaceId = await createWorkspace(owner.token, "Create WS");

		const createRes = await app.request("/api/project/new", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ name: "Stamped Ch 1", lang: "th", workspaceId }),
		});
		expect(createRes.status).toBe(200);
		const { projectId } = await createRes.json();
		expect(typeof projectId).toBe("string");

		// The persisted state carries the workspaceId — the missing link that kept
		// the file-mode dashboard empty.
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		expect(stateRes.status).toBe(200);
		const state = await stateRes.json();
		expect(state.workspaceId).toBe(workspaceId);
		expect(state.targetLang).toBe("th");

		// And the workspace home aggregate now finds the created project.
		const homeRes = await app.request(`/api/workspaces/${workspaceId}/home`, { headers: authHeaders(owner.token) });
		expect(homeRes.status).toBe(200);
		const home = await homeRes.json();
		expect(home.counts.projects).toBeGreaterThanOrEqual(1);
	});

	test("rejects a create for a workspace the caller is NOT a member of (no silent success, no 503)", async () => {
		const owner = await makeVerifiedUser("ws-create-owner2");
		const intruder = await makeVerifiedUser("ws-create-intruder");
		const workspaceId = await createWorkspace(owner.token, "Member-only WS");

		const res = await app.request("/api/project/new", {
			method: "POST",
			headers: authHeaders(intruder.token, true),
			body: JSON.stringify({ name: "Intruder Ch", lang: "th", workspaceId }),
		});
		// Membership-denied: NOT 503 (store-missing) and NOT 200 (silent success).
		// requirePermission rejects a non-member with 404 workspace_not_found (the
		// same non-leaking gate the /home aggregate uses for non-members).
		expect(res.status).not.toBe(503);
		expect(res.status).not.toBe(200);
		expect([403, 404]).toContain(res.status);
		expect((await res.json()).code).toBe("workspace_not_found");

		// And the intruder's workspace home stays empty — nothing was stamped.
		const ownerHome = await app.request(`/api/workspaces/${workspaceId}/home`, { headers: authHeaders(owner.token) });
		expect(ownerHome.status).toBe(200);
		expect((await ownerHome.json()).counts.projects).toBe(0);
	});

	test("legacy create with NO workspaceId still succeeds (personal/legacy path unchanged)", async () => {
		const owner = await makeVerifiedUser("ws-create-legacy");
		const res = await app.request("/api/project/new", {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify({ name: "Personal Ch", lang: "th" }),
		});
		expect(res.status).toBe(200);
		const { projectId } = await res.json();
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = await stateRes.json();
		// Personal project: no workspace stamp.
		expect(state.workspaceId == null || state.workspaceId === "").toBe(true);
	});

	test("seeded translate task carries the chapter targetLang (not null); clean stays language-agnostic", async () => {
		const owner = await makeVerifiedUser("ws-create-langtask");
		const workspaceId = await createWorkspace(owner.token, "Lang Task WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Lang Ch 1");

		// Give the project one page so ensureProjectWorkflow materializes per-page tasks.
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = await stateRes.json();
		state.pages = [{ imageId: "img-1", imageName: "p1.webp", textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null }];
		state.currentPage = 0;
		const saveRes = await app.request(`/api/project/${projectId}/save`, {
			method: "POST",
			headers: authHeaders(owner.token, true),
			body: JSON.stringify(state),
		});
		expect(saveRes.status).toBe(200);

		const afterRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const after = await afterRes.json();
		const translate = after.tasks.find((t: any) => t.type === "translate" && t.pageIndex === 0);
		const clean = after.tasks.find((t: any) => t.type === "clean" && t.pageIndex === 0);
		expect(translate).toBeDefined();
		// The translate task is language-scoped to the chapter target language.
		expect(translate.targetLang).toBe("th");
		// Cleaning is shared/raster-level → language-agnostic (no targetLang stamp).
		expect(clean.targetLang == null).toBe(true);
	});
});
