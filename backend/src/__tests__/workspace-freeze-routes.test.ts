// PR #414 P0/P1 regression: a FROZEN workspace (verified refund/chargeback or admin
// suspension) must block EVERY mutating authorization path — including the bespoke
// chapter-team fallback in checkProjectOwnership and the export ENQUEUE route — for
// everyone, while reads/readiness still pass. The central catalog path (canAccessProject
// / resolveProjectAccessContext) is covered directly in project-catalog.test.ts; here we
// cover the two paths that BYPASS the catalog gate and must consult suspension themselves.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR } from "../config.js";
import { checkProjectOwnership, project as projectRoutes } from "../routes/project.js";
import { exportRoutes } from "../routes/export.js";
import * as projectCatalogModule from "../services/project-catalog.js";
import * as workspaceAccessModule from "../services/workspace-access.js";
import type { ProjectState } from "../types/index.js";
import type { JWTPayload } from "../types/auth.js";

const projectCatalogStore = projectCatalogModule.projectCatalogStore!;
const workspaceAccessStore = workspaceAccessModule.workspaceAccessStore!;

const originalCanAccessProject = projectCatalogStore.canAccessProject.bind(projectCatalogStore);
const originalIsWorkspaceSuspended = workspaceAccessStore.isWorkspaceSuspended.bind(workspaceAccessStore);
const originalRequireScopedPermission = workspaceAccessStore.requireScopedPermission.bind(workspaceAccessStore);

let suspendedWorkspaces = new Set<string>();
let catalogAllows = false;

beforeEach(() => {
	suspendedWorkspaces = new Set<string>();
	catalogAllows = false;
	(workspaceAccessStore as { isWorkspaceSuspended: typeof originalIsWorkspaceSuspended }).isWorkspaceSuspended =
		(async (workspaceId: string) => suspendedWorkspaces.has(workspaceId)) as typeof originalIsWorkspaceSuspended;
	// Catalog membership is the WORKSPACE-MEMBER path; for the chapter-team fallback we
	// model a caller who is NOT a workspace member (catalog denies) but IS an active
	// chapter-team member, so the bespoke fallback runs.
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject =
		(async () => catalogAllows) as typeof originalCanAccessProject;
});

afterEach(() => {
	(workspaceAccessStore as { isWorkspaceSuspended: typeof originalIsWorkspaceSuspended }).isWorkspaceSuspended = originalIsWorkspaceSuspended;
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = originalCanAccessProject;
	(workspaceAccessStore as { requireScopedPermission: typeof originalRequireScopedPermission }).requireScopedPermission = originalRequireScopedPermission;
	for (const dir of createdDirs.splice(0)) {
		const resolved = resolve(dir);
		if (resolved.startsWith(resolve(PROJECTS_DIR))) rmSync(resolved, { recursive: true, force: true });
	}
});

const createdDirs: string[] = [];

function writeWorkspaceProject(overrides: Partial<ProjectState> = {}): ProjectState {
	const projectId = uuid();
	const state: ProjectState = {
		projectId,
		userId: "",
		workspaceId: "ws-frozen",
		name: "Frozen WS Project",
		createdAt: new Date().toISOString(),
		pages: [{ imageId: `${uuid()}.png` }],
		currentPage: 0,
		targetLang: "en",
		...overrides,
	} as ProjectState;
	const dir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(dir, "images"), { recursive: true });
	writeFileSync(join(dir, "state.json"), JSON.stringify(state));
	createdDirs.push(dir);
	return state;
}

const chapterTeamUser: JWTPayload = { userId: "team-member", email: "team@studio.com", role: "editor" };

function ownershipContext(user: JWTPayload, method: string, path: string) {
	const responses: Array<{ body: unknown; status: number }> = [];
	const c = {
		get: (key: string) => (key === "user" ? user : undefined),
		req: { method, path },
		json: (body: unknown, status = 200) => {
			responses.push({ body, status });
			return { body, status } as unknown;
		},
	};
	return { c, responses };
}

describe("PR #414 — chapter-team fallback consults workspace suspension", () => {
	test("a frozen workspace BLOCKS a chapter-team member's mutating save (403 workspace_suspended)", async () => {
		const state = writeWorkspaceProject({
			chapterTeam: [{ userId: chapterTeamUser.userId, status: "active", role: "translate" } as never],
		});
		suspendedWorkspaces.add("ws-frozen");

		const { c, responses } = ownershipContext(chapterTeamUser, "POST", `/api/projects/${state.projectId}`);
		const result = await checkProjectOwnership(c as never, state, "update:project");

		expect(result).not.toBeNull();
		expect(responses[0]?.status).toBe(403);
		expect((responses[0]?.body as { code?: string }).code).toBe("workspace_suspended");
	});

	test("a frozen workspace still ALLOWS a chapter-team member to READ (no 403)", async () => {
		const state = writeWorkspaceProject({
			chapterTeam: [{ userId: chapterTeamUser.userId, status: "active", role: "translate" } as never],
		});
		suspendedWorkspaces.add("ws-frozen");

		const { c } = ownershipContext(chapterTeamUser, "GET", `/api/projects/${state.projectId}`);
		const result = await checkProjectOwnership(c as never, state, "read:project");

		// null == allowed (no error response).
		expect(result).toBeNull();
	});

	test("a NON-frozen workspace ALLOWS a chapter-team member's mutating save", async () => {
		const state = writeWorkspaceProject({
			chapterTeam: [{ userId: chapterTeamUser.userId, status: "active", role: "translate" } as never],
		});
		// not suspended

		const { c } = ownershipContext(chapterTeamUser, "POST", `/api/projects/${state.projectId}`);
		const result = await checkProjectOwnership(c as never, state, "update:project");

		expect(result).toBeNull();
	});
});

describe("PR #414 — export enqueue is blocked while the workspace is frozen", () => {
	function buildExportApp(user: JWTPayload | null): Hono {
		const app = new Hono();
		app.use("*", async (c, next) => {
			if (user) (c as { set: (k: string, v: unknown) => void }).set("user", user);
			await next();
		});
		app.route("/api/export", exportRoutes);
		return app;
	}

	beforeEach(() => {
		// The export gate runs AFTER requireScopedPermission succeeds, so stub it to grant
		// the member (a real member row is orthogonal to the freeze regression).
		(workspaceAccessStore as { requireScopedPermission: typeof originalRequireScopedPermission }).requireScopedPermission =
			(async () => ({
				workspaceId: "ws-frozen",
				userId: "exporter",
				role: "owner",
				scope: {},
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})) as typeof originalRequireScopedPermission;
	});

	test("POST /api/export returns 403 workspace_suspended when the workspace is frozen", async () => {
		const state = writeWorkspaceProject();
		suspendedWorkspaces.add("ws-frozen");

		const res = await buildExportApp({ userId: "exporter", email: "x@y.com", role: "owner" }).request("/api/export", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ projectId: state.projectId, preset: "master", imageIds: [state.pages[0]!.imageId] }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("workspace_suspended");
	});

	test("POST /api/export is NOT blocked by the freeze gate when the workspace is not frozen", async () => {
		const state = writeWorkspaceProject();
		// not suspended

		const res = await buildExportApp({ userId: "exporter", email: "x@y.com", role: "owner" }).request("/api/export", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ projectId: state.projectId, preset: "master", imageIds: [state.pages[0]!.imageId] }),
		});

		// The freeze gate did not fire; any non-403-workspace_suspended outcome is acceptable
		// here (the enqueue may still 200 or fail later for unrelated pipeline reasons).
		if (res.status === 403) {
			const body = (await res.json()) as { code?: string };
			expect(body.code).not.toBe("workspace_suspended");
		}
	});
});

describe("PR #414 — POST /:id/team/accept is blocked while the workspace is frozen", () => {
	function buildProjectApp(user: JWTPayload | null): Hono {
		const app = new Hono();
		app.use("*", async (c, next) => {
			if (user) (c as { set: (k: string, v: unknown) => void }).set("user", user);
			await next();
		});
		app.route("/api/project", projectRoutes);
		return app;
	}

	test("returns 403 workspace_suspended when frozen (before any accept/verify logic)", async () => {
		const state = writeWorkspaceProject();
		suspendedWorkspaces.add("ws-frozen");
		const res = await buildProjectApp({ userId: "invitee", email: "invitee@studio.com", role: "editor" })
			.request(`/api/project/${state.projectId}/team/accept`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("workspace_suspended");
	});

	test("a NON-frozen workspace does NOT return workspace_suspended on accept", async () => {
		const state = writeWorkspaceProject();
		// not suspended
		const res = await buildProjectApp({ userId: "invitee", email: "invitee@studio.com", role: "editor" })
			.request(`/api/project/${state.projectId}/team/accept`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
		// proceeds past the freeze gate (then fails later for unrelated reasons: unverified / no-invite)
		if (res.status === 403) {
			const body = (await res.json()) as { code?: string };
			expect(body.code).not.toBe("workspace_suspended");
		}
	});
});
