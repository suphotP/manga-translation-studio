// Wave 0 W0.1 — exercise the multi-tenant backward-compat hatch in
// routes/project.ts::checkProjectOwnership directly. The hatch must:
//   - DENY anonymous access to projects whose state has both userId AND
//     workspaceId null when apiAuthRequired=true (prod posture).
//   - DENY the same case in dev when allowLegacyAnonymousProjects=false (default).
//   - ALLOW it only when apiAuthRequired=false AND
//     allowLegacyAnonymousProjects=true (explicit opt-in).
//   - Continue to gate workspace-scoped projects via the workspace catalog.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalDataDir = process.env.DATA_DIR;
const ownershipDataDir = mkdtempSync(join(tmpdir(), "manga-ownership-test-"));
process.env.DATA_DIR = ownershipDataDir;

const { PROJECTS_DIR, serverConfig } = await import("../config.js");
const { canReadProjectForUser, checkProjectOwnership, project, resetLegacyAnonymousProjectAccessTrackingForTests, getLegacyAnonymousProjectAccessTotalForTests } = await import("../routes/project.js");
const projectCatalogModule = await import("../services/project-catalog.js");
const { workspaceAccessStore } = await import("../services/workspace-access.js");
const { createUser, generateTokens, loadUser, markEmailVerified } = await import("../services/auth.service.js");
import type { ProjectState } from "../types/index.js";

function snapshotConfig() {
	return {
		apiAuthRequired: serverConfig.apiAuthRequired,
		allowLegacyAnonymousProjects: serverConfig.allowLegacyAnonymousProjects,
	};
}

function restoreConfig(snapshot: ReturnType<typeof snapshotConfig>) {
	Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
}

function setConfig(overrides: Partial<ReturnType<typeof snapshotConfig>>) {
	Object.assign(serverConfig as unknown as Record<string, unknown>, overrides);
}

interface MockContext {
	req: { method: string; path: string };
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	json(body: unknown, status?: number): Response;
}

function makeContext(opts: { user?: { userId: string; role: "admin" | "editor" | "viewer" }; method?: string; path?: string } = {}): MockContext {
	const store: Record<string, unknown> = {};
	if (opts.user) store.user = opts.user;
	return {
		req: { method: opts.method ?? "GET", path: opts.path ?? "/api/project/legacy/workflow" },
		get(key: string) {
			return store[key];
		},
		set(key: string, value: unknown) {
			store[key] = value;
		},
		json(body: unknown, status = 200) {
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	};
}

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
	const base: ProjectState = {
		projectId: "test-project",
		userId: "",
		name: "Test Project",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "en",
	};
	return { ...base, ...overrides } as ProjectState;
}

function writeLegacyProjectForList(projectId: string): void {
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, "state.json"),
		JSON.stringify(makeProject({ projectId, name: `Legacy ${projectId}`, userId: "" })),
	);
}

function readProjectStateForTest(projectId: string): ProjectState {
	return JSON.parse(readFileSync(join(PROJECTS_DIR, projectId, "state.json"), "utf8")) as ProjectState;
}

async function createVerifiedAuth(email: string, role: "admin" | "editor" | "viewer" = "editor"): Promise<{ userId: string; token: string }> {
	const created = await createUser({
		email,
		password: "StrongP@ss123",
		name: email,
	});
	await markEmailVerified(created.user.id);
	const fullUser = await loadUser(created.user.id);
	if (!fullUser) throw new Error("Expected test user");
	fullUser.role = role;
	const tokens = await generateTokens(fullUser);
	return { userId: fullUser.id, token: tokens.accessToken };
}

// In this test runtime the project catalog store is FILE-backed and
// `projectCatalogStore` is null, so workspace-scoped access can never be
// catalog-approved — that mirrors the deny-by-default posture we want from the
// hatch. For tests that need a positive "user can access project" outcome we
// use the userId-owner-match branch (which doesn't require the catalog).
void projectCatalogModule;

afterAll(() => {
	process.env.DATA_DIR = originalDataDir;
	try {
		rmSync(ownershipDataDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

beforeEach(() => {
	// The legacy-anonymous counter is process-global; sibling test files that
	// hit project routes through the allowLegacyAnonymousProjects hatch will
	// have incremented it. Reset before EACH test so this suite's counter
	// assertions remain meaningful regardless of run order.
	resetLegacyAnonymousProjectAccessTrackingForTests();
});

afterEach(() => {
	resetLegacyAnonymousProjectAccessTrackingForTests();
});

describe("checkProjectOwnership — Wave 0 W0.1 backward-compat hatch", () => {
	test("both nulls + apiAuthRequired=true → 401 (prod posture denies legacy anonymous)", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: true, allowLegacyAnonymousProjects: true });
			const ctx = makeContext();
			const project = makeProject({ userId: "" });
			const result = await checkProjectOwnership(ctx as unknown as never, project);
			expect(result).not.toBeNull();
			expect(result!.status).toBe(401);
			expect(await result!.json()).toEqual({ error: "Unauthorized" });
			expect(getLegacyAnonymousProjectAccessTotalForTests()).toBe(0);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("workspace-scoped project + authenticated user without catalog grant → 404 (not-found, not 403, to avoid leak)", async () => {
		// File-mode catalog (projectCatalogStore=null in this test runtime) can
		// never grant access. The route deliberately returns 404 rather than 403
		// so unauthorized users can't probe which projects exist.
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: true, allowLegacyAnonymousProjects: false });
			const ctx = makeContext({ user: { userId: "user-a", role: "editor" } });
			const project = makeProject({ workspaceId: "workspace-other", userId: "owner-x" });
			const result = await checkProjectOwnership(ctx as unknown as never, project);
			expect(result).not.toBeNull();
			expect(result!.status).toBe(404);
			expect(await result!.json()).toEqual({ error: "Project not found" });
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("authenticated owner of a userId-scoped project → null (access allowed)", async () => {
		// The "matching scope" case the spec calls out: a user who is the
		// project's owner gets through. We exercise the userId-owner branch here
		// because it doesn't require the catalog store (which is null in
		// file-mode test runtime).
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: true, allowLegacyAnonymousProjects: false });
			const ctx = makeContext({ user: { userId: "user-a", role: "editor" } });
			const project = makeProject({ userId: "user-a" });
			const result = await checkProjectOwnership(ctx as unknown as never, project);
			expect(result).toBeNull();
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("authenticated non-owner of a userId-scoped project (no workspace) → 404", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: true, allowLegacyAnonymousProjects: false });
			const ctx = makeContext({ user: { userId: "user-a", role: "editor" } });
			const project = makeProject({ userId: "owner-x" });
			const result = await checkProjectOwnership(ctx as unknown as never, project);
			expect(result).not.toBeNull();
			expect(result!.status).toBe(404);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("legacy flag true + apiAuthRequired=false + both nulls → null (legacy path) + warning counted", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: true });
			const ctx = makeContext();
			const project = makeProject({ userId: "" });
			const result = await checkProjectOwnership(ctx as unknown as never, project);
			expect(result).toBeNull();
			expect(getLegacyAnonymousProjectAccessTotalForTests()).toBe(1);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("legacy flag false (default) + apiAuthRequired=false + both nulls → 401", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: false });
			const ctx = makeContext();
			const project = makeProject({ userId: "" });
			const result = await checkProjectOwnership(ctx as unknown as never, project);
			expect(result).not.toBeNull();
			expect(result!.status).toBe(401);
			expect(await result!.json()).toEqual({ error: "Unauthorized" });
			expect(getLegacyAnonymousProjectAccessTotalForTests()).toBe(0);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("legacy flag true + apiAuthRequired=true (prod overrides legacy) + both nulls → 401", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: true, allowLegacyAnonymousProjects: true });
			const ctx = makeContext();
			const project = makeProject({ userId: "" });
			const result = await checkProjectOwnership(ctx as unknown as never, project);
			expect(result).not.toBeNull();
			expect(result!.status).toBe(401);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("anonymous + project has userId set → 401 (legacy hatch never reopens for owned projects)", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: true });
			const ctx = makeContext();
			const project = makeProject({ userId: "owner-x" });
			const result = await checkProjectOwnership(ctx as unknown as never, project);
			expect(result).not.toBeNull();
			expect(result!.status).toBe(401);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("anonymous project create is rejected when the legacy hatch is closed", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: false });
			const res = await project.request("/new", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Blocked Anonymous", lang: "th" }),
			});
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("anonymous project create is allowed only when the legacy hatch is explicitly open", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: true });
			const res = await project.request("/new", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Allowed Anonymous", lang: "th" }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as { projectId?: string };
			expect(typeof body.projectId).toBe("string");
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("project create accepts targetLangs and persists the primary target language", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: true });
			const res = await project.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Multi Track", lang: "th", targetLangs: ["en", "th", "en"] }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as { projectId: string };
			const state = readProjectStateForTest(body.projectId);
			expect(state.targetLang).toBe("en");
			expect(state.targetLangs).toEqual(["en", "th"]);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("language track endpoints add, reject duplicate, and reject removing primary or last tracks", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: true });
			const createRes = await project.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Track Ops", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json() as { projectId: string };

			const addRes = await project.request(`/${projectId}/languages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ language: "en" }),
			});
			expect(addRes.status).toBe(200);
			expect(await addRes.json()).toEqual(expect.objectContaining({
				targetLang: "th",
				targetLangs: ["th", "en"],
			}));
			expect(readProjectStateForTest(projectId).activityLog?.[0]?.type).toBe("language_track_added");

			const duplicateRes = await project.request(`/${projectId}/languages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ language: "en" }),
			});
			expect(duplicateRes.status).toBe(409);
			expect(await duplicateRes.json()).toEqual(expect.objectContaining({ code: "language_track_exists" }));

			const removePrimaryRes = await project.request(`/${projectId}/languages/th`, { method: "DELETE" });
			expect(removePrimaryRes.status).toBe(400);
			expect(await removePrimaryRes.json()).toEqual(expect.objectContaining({ code: "cannot_remove_primary_language_track" }));

			const removeSecondaryRes = await project.request(`/${projectId}/languages/en`, { method: "DELETE" });
			expect(removeSecondaryRes.status).toBe(200);
			expect(await removeSecondaryRes.json()).toEqual(expect.objectContaining({
				targetLang: "th",
				targetLangs: ["th"],
			}));

			const removeLastRes = await project.request(`/${projectId}/languages/th`, { method: "DELETE" });
			expect(removeLastRes.status).toBe(400);
			expect(await removeLastRes.json()).toEqual(expect.objectContaining({ code: "cannot_remove_last_language_track" }));
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("save path ignores body.targetLangs and cannot add an out-of-scope language track", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: true });
			const createRes = await project.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Save Backdoor", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json() as { projectId: string };
			expect(readProjectStateForTest(projectId).targetLangs).toEqual(["th"]);

			// Attempt to smuggle an extra track through the general save path. The
			// save endpoint must treat the track set as server-owned and ignore the
			// incoming targetLangs entirely — track changes only go through the gated
			// POST/DELETE /:id/languages endpoints.
			const saveRes = await project.request(`/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId, pages: [], targetLang: "th", targetLangs: ["th", "ko"] }),
			});
			expect(saveRes.status).toBe(200);
			const saved = readProjectStateForTest(projectId);
			expect(saved.targetLangs).toEqual(["th"]);
			expect(saved.targetLang).toBe("th");
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("save path cannot drop the primary or last track via targetLangs", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: true });
			const createRes = await project.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Save Drop Primary", lang: "th" }),
			});
			expect(createRes.status).toBe(200);
			const { projectId } = await createRes.json() as { projectId: string };

			// Add a legitimate secondary track through the gated endpoint.
			const addRes = await project.request(`/${projectId}/languages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ language: "en" }),
			});
			expect(addRes.status).toBe(200);
			expect(readProjectStateForTest(projectId).targetLangs).toEqual(["th", "en"]);

			// A save that tries to replace the whole set with just "en" must not be
			// able to drop the primary ("th") — DELETE's not-primary / not-last
			// invariant cannot be bypassed via the save path.
			const saveRes = await project.request(`/${projectId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId, pages: [], targetLang: "en", targetLangs: ["en"] }),
			});
			expect(saveRes.status).toBe(200);
			const saved = readProjectStateForTest(projectId);
			expect(saved.targetLangs).toEqual(["th", "en"]);
			expect(saved.targetLang).toBe("th");
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("workspace create rejects an out-of-scope language anywhere in targetLangs", async () => {
		const auth = await createVerifiedAuth("create-scope-array@example.com", "admin");
		const workspaceId = "workspace-create-scope-array";
		await workspaceAccessStore.createWorkspace({ workspaceId, name: "Create Scope Array", ownerUserId: auth.userId });
		const members = (workspaceAccessStore as unknown as { members?: Array<{ workspaceId: string; userId: string; scope: unknown }> }).members;
		const ownerMember = members?.find((member) => member.workspaceId === workspaceId && member.userId === auth.userId);
		if (!ownerMember) throw new Error("Expected workspace owner member");
		ownerMember.scope = { languages: ["th", "en"] };

		// The primary ("th") is in scope, but a non-primary element ("ko") is NOT.
		// Create must validate EVERY requested language, not just the primary.
		const deniedRes = await project.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${auth.token}`,
			},
			body: JSON.stringify({ name: "Scoped Create Array", workspaceId, lang: "th", targetLangs: ["th", "ko"] }),
		});
		expect(deniedRes.status).toBe(403);
		expect(await deniedRes.json()).toEqual(expect.objectContaining({ code: "workspace_project_create_scope_denied" }));

		// An all-in-scope multi-track create still succeeds.
		const allowedRes = await project.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${auth.token}`,
			},
			body: JSON.stringify({ name: "Scoped Create OK", workspaceId, lang: "th", targetLangs: ["th", "en"] }),
		});
		expect(allowedRes.status).toBe(200);
		const { projectId } = await allowedRes.json() as { projectId: string };
		expect(readProjectStateForTest(projectId).targetLangs).toEqual(["th", "en"]);
	});

	test("workspace language track add is checked against member language scope", async () => {
		const auth = await createVerifiedAuth("track-scope@example.com", "admin");
		const workspaceId = "workspace-track-scope";
		await workspaceAccessStore.createWorkspace({ workspaceId, name: "Track Scope", ownerUserId: auth.userId });
		// Narrow the owner in-memory for this focused route test. File mode does not
		// support inviting a scoped collaborator, but the route reads the same member
		// scope object through requirePermission.
		const members = (workspaceAccessStore as unknown as { members?: Array<{ workspaceId: string; userId: string; scope: unknown }> }).members;
		const ownerMember = members?.find((member) => member.workspaceId === workspaceId && member.userId === auth.userId);
		if (!ownerMember) throw new Error("Expected workspace owner member");
		ownerMember.scope = { languages: ["th", "en"] };

		const createRes = await project.request("/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${auth.token}`,
			},
			body: JSON.stringify({ name: "Scoped Track", workspaceId, lang: "th" }),
		});
		expect(createRes.status).toBe(200);
		const { projectId } = await createRes.json() as { projectId: string };

		const allowedRes = await project.request(`/${projectId}/languages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${auth.token}`,
			},
			body: JSON.stringify({ language: "en" }),
		});
		expect(allowedRes.status).toBe(200);

		const deniedRes = await project.request(`/${projectId}/languages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${auth.token}`,
			},
			body: JSON.stringify({ language: "ko" }),
		});
		expect(deniedRes.status).toBe(403);
		expect(await deniedRes.json()).toEqual(expect.objectContaining({ code: "workspace_language_track_scope_denied" }));
	});

	test("anonymous project list is rejected when the legacy hatch is closed", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: false });
			writeLegacyProjectForList("00000000-0000-4000-8000-000000000001");
			const res = await project.request("/");
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
			expect(canReadProjectForUser(makeProject({ projectId: "00000000-0000-4000-8000-000000000001", userId: "" }))).toBe(false);
		} finally {
			restoreConfig(snapshot);
		}
	});

	test("anonymous project list includes legacy projects only when the hatch is open", async () => {
		const snapshot = snapshotConfig();
		try {
			setConfig({ apiAuthRequired: false, allowLegacyAnonymousProjects: true });
			writeLegacyProjectForList("00000000-0000-4000-8000-000000000002");
			const res = await project.request("/");
			expect(res.status).toBe(200);
			const body = await res.json() as { projects: Array<{ projectId: string }> };
			expect(body.projects.map((item: { projectId: string }) => item.projectId)).toContain("00000000-0000-4000-8000-000000000002");
			expect(canReadProjectForUser(makeProject({ projectId: "00000000-0000-4000-8000-000000000002", userId: "" }))).toBe(true);
		} finally {
			restoreConfig(snapshot);
		}
	});
});
