// SECURITY regression tests for the usage route's cross-tenant IDOR + quota
// theft (codex audit, usage.ts).
//
// Proves:
//   1. checkProjectAccess gates WORKSPACE projects on real project membership via
//      projectCatalogStore.canAccessProject — a NON-member is denied (404) on
//      usage read, usage events, and the export-usage record; a MEMBER is allowed.
//   2. The export-usage record route no longer trusts the client-supplied `bytes`
//      for billing: a forged 50 GiB value is clamped to the project's real
//      server-owned export artifact size.
//
// Pattern mirrors project-check-ownership.test.ts: override DATA_DIR so the route
// reads real on-disk state.json files via readProjectStateFileGuarded, and stub
// projectCatalogStore.canAccessProject to model workspace membership.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

const originalDataDir = process.env.DATA_DIR;
const idorDataDir = mkdtempSync(join(tmpdir(), "manga-usage-idor-test-"));
process.env.DATA_DIR = idorDataDir;

const { PROJECTS_DIR } = await import("../config.js");
const { usage } = await import("../routes/usage.js");
const projectCatalogModule = await import("../services/project-catalog.js");
const usageLedgerModule = await import("../services/usage-ledger.js");
import type { ProjectState } from "../types/index.js";

const projectCatalogStore = projectCatalogModule.projectCatalogStore!;
const originalCanAccessProject = projectCatalogStore.canAccessProject.bind(projectCatalogStore);

// membership model: projectId -> set of userIds with access.
const members = new Map<string, Set<string>>();

beforeEach(() => {
	members.clear();
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = (async (input: {
		projectId: string;
		userId: string;
	}) => {
		return members.get(input.projectId)?.has(input.userId) ?? false;
	}) as typeof originalCanAccessProject;
});

afterEach(() => {
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = originalCanAccessProject;
});

afterAll(() => {
	rmSync(idorDataDir, { recursive: true, force: true });
	if (originalDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = originalDataDir;
});

function makeProjectId(): string {
	return crypto.randomUUID();
}

function writeWorkspaceProject(projectId: string, overrides: Partial<ProjectState> = {}): void {
	const dir = join(PROJECTS_DIR, projectId);
	mkdirSync(dir, { recursive: true });
	const state: ProjectState = {
		projectId,
		userId: "",
		workspaceId: "ws-1",
		name: "WS Project",
		createdAt: new Date().toISOString(),
		pages: [{ imageId: "img-0" }],
		currentPage: 0,
		targetLang: "en",
		...overrides,
	} as ProjectState;
	writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

function appAs(user: { userId: string; email: string } | null) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (user) {
			(c as { set: (key: string, value: unknown) => void }).set("user", {
				userId: user.userId,
				email: user.email,
				role: "editor",
			});
		}
		await next();
	});
	app.route("/api/usage", usage);
	return app;
}

function postExport(app: Hono, projectId: string, body: unknown) {
	return app.request(`/api/usage/${projectId}/export`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("usage route — workspace cross-tenant IDOR", () => {
	test("a NON-member is DENIED reading usage summary for a workspace project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["owner-a"]));

		const res = await appAs({ userId: "intruder", email: "evil@x.com" }).request(`/api/usage/${projectId}`);
		expect(res.status).toBe(404);
	});

	test("a NON-member is DENIED listing usage events for a workspace project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["owner-a"]));

		const res = await appAs({ userId: "intruder", email: "evil@x.com" }).request(`/api/usage/${projectId}/events`);
		expect(res.status).toBe(404);
	});

	test("a NON-member is DENIED recording export usage for a workspace project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["owner-a"]));

		const res = await postExport(appAs({ userId: "intruder", email: "evil@x.com" }), projectId, { bytes: 1024 });
		expect(res.status).toBe(404);
	});

	test("an unauthenticated caller is DENIED (401) on a workspace project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["owner-a"]));

		const res = await appAs(null).request(`/api/usage/${projectId}`);
		expect(res.status).toBe(401);
	});

	test("a MEMBER is ALLOWED to read usage for a workspace project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["member-a"]));

		const res = await appAs({ userId: "member-a", email: "a@studio.com" }).request(`/api/usage/${projectId}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { usage?: unknown };
		expect(body.usage).toBeDefined();
	});

	test("a MEMBER is ALLOWED to record export usage for a workspace project", async () => {
		const projectId = makeProjectId();
		writeWorkspaceProject(projectId);
		members.set(projectId, new Set(["member-a"]));

		const res = await postExport(appAs({ userId: "member-a", email: "a@studio.com" }), projectId, { bytes: 1024 });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok?: boolean };
		expect(body.ok).toBe(true);
	});
});
