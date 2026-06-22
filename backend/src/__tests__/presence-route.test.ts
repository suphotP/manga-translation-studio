import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { presence } from "../routes/presence.js";
import { serverConfig } from "../config.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import type { ProjectState } from "../types/index.js";

// Presence is now project/scope authorized. These tests drive the route with a
// fake project catalog + injected auth user so we can prove:
//   - a non-member is DENIED heartbeat/get/clear on a project they can't access,
//   - an authorized member sees only a non-PII display name of others (no
//     email/userId/PII),
//   - the file-mode (legacy anonymous) path still works for an ownerless project.

interface FakeState {
	userId?: string;
	workspaceId?: string;
}

// Project access fixtures keyed by projectId. `members` lists which userIds are
// allowed for a workspace project.
const projects = new Map<string, { state: FakeState; members: Set<string> }>();

const originalGetProjectState = projectCatalogStore!.getProjectState.bind(projectCatalogStore);
const originalCanAccessProject = projectCatalogStore!.canAccessProject.bind(projectCatalogStore);
const originalApiAuthRequired = serverConfig.apiAuthRequired;
const originalAllowLegacy = serverConfig.allowLegacyAnonymousProjects;

beforeEach(() => {
	projects.clear();
	(projectCatalogStore as { getProjectState: typeof originalGetProjectState }).getProjectState = (async (
		projectId: string,
	) => {
		const entry = projects.get(projectId);
		if (!entry) return null;
		return { projectId, userId: entry.state.userId ?? "", workspaceId: entry.state.workspaceId } as ProjectState;
	}) as typeof originalGetProjectState;
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = (async (
		input: { projectId: string; userId: string },
	) => {
		const entry = projects.get(input.projectId);
		if (!entry) return false;
		return entry.members.has(input.userId);
	}) as typeof originalCanAccessProject;
});

afterEach(() => {
	(projectCatalogStore as { getProjectState: typeof originalGetProjectState }).getProjectState = originalGetProjectState;
	(projectCatalogStore as { canAccessProject: typeof originalCanAccessProject }).canAccessProject = originalCanAccessProject;
	(serverConfig as { apiAuthRequired: boolean }).apiAuthRequired = originalApiAuthRequired;
	(serverConfig as { allowLegacyAnonymousProjects: boolean }).allowLegacyAnonymousProjects = originalAllowLegacy;
});

// App that injects an authed user (workspace member with a JWT identity).
function appAs(user: { userId: string; email: string }) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		// Inject the authed user the way auth.middleware does (presence reads it via
		// getAuthUser -> c.get("user")). Cast because this bare test app has no typed
		// context variable map.
		(c as { set: (key: string, value: unknown) => void }).set("user", {
			userId: user.userId,
			email: user.email,
			role: "editor",
		});
		await next();
	});
	app.route("/api/presence", presence);
	return app;
}

// App with NO auth (file-mode / legacy anonymous client).
function appAnon() {
	const app = new Hono();
	app.route("/api/presence", presence);
	return app;
}

function postJson(app: Hono, path: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

interface PresenceResponseBody {
	ok?: boolean;
	lastSeen?: number;
	error?: string;
	code?: string;
	others?: Array<{ name: string; scope: string; scopeId: string; ageSec: number } & Record<string, unknown>>;
}

async function readBody(res: Response): Promise<PresenceResponseBody> {
	return (await res.json()) as PresenceResponseBody;
}

function workspaceProject(id: string, members: string[]): void {
	projects.set(id, { state: { workspaceId: "ws-1" }, members: new Set(members) });
}

function anonymousProject(id: string): void {
	projects.set(id, { state: { userId: "", workspaceId: undefined }, members: new Set() });
}

describe("presence route — workspace authorization", () => {
	test("a member can heartbeat and a SECOND member sees them by display name only (no PII)", async () => {
		const project = `proj-${crypto.randomUUID()}`;
		workspaceProject(project, ["user-a", "user-b"]);

		const annApp = appAs({ userId: "user-a", email: "ann@studio.com" });
		const benApp = appAs({ userId: "user-b", email: "ben@studio.com" });

		const first = await postJson(annApp, "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "3" });
		expect(first.status).toBe(200);
		expect((await readBody(first)).others).toHaveLength(0);

		const second = await postJson(benApp, "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "3" });
		expect(second.status).toBe(200);
		const body = await readBody(second);
		expect(body.others).toHaveLength(1);
		const entry = body.others![0]!;
		// Non-PII display handle (email local-part), never the raw email/userId.
		expect(entry.name).toBe("ann");
		expect(entry).not.toHaveProperty("userId");
		expect(entry).not.toHaveProperty("email");
		// No field anywhere in the entry exposes the email or raw user id.
		expect(JSON.stringify(entry)).not.toContain("ann@studio.com");
		expect(JSON.stringify(entry)).not.toContain("user-a");
	});

	test("a NON-member is DENIED heartbeat for a project they can't access", async () => {
		const project = `proj-${crypto.randomUUID()}`;
		workspaceProject(project, ["user-a"]);
		const intruder = appAs({ userId: "intruder", email: "evil@x.com" });
		const res = await postJson(intruder, "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "1" });
		expect(res.status).toBe(404);
	});

	test("a NON-member is DENIED reading presence (cannot enumerate who is online)", async () => {
		const project = `proj-${crypto.randomUUID()}`;
		workspaceProject(project, ["user-a"]);
		// user-a is genuinely present.
		await postJson(appAs({ userId: "user-a", email: "ann@studio.com" }), "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "1" });

		const intruder = appAs({ userId: "intruder", email: "evil@x.com" });
		const res = await intruder.request(`/api/presence?projectId=${project}&scope=page&scopeId=1`);
		expect(res.status).toBe(404);
	});

	test("a NON-member is DENIED clearing presence on a foreign project", async () => {
		const project = `proj-${crypto.randomUUID()}`;
		workspaceProject(project, ["user-a"]);
		const intruder = appAs({ userId: "intruder", email: "evil@x.com" });
		const res = await postJson(intruder, "/api/presence/clear", { projectId: project, scope: "page", scopeId: "1" });
		expect(res.status).toBe(404);
	});

	test("a member can clear only their OWN ping", async () => {
		const project = `proj-${crypto.randomUUID()}`;
		workspaceProject(project, ["user-a", "user-b"]);
		const annApp = appAs({ userId: "user-a", email: "ann@studio.com" });
		await postJson(annApp, "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "0" });
		await postJson(annApp, "/api/presence/clear", { projectId: project, scope: "page", scopeId: "0" });

		const benApp = appAs({ userId: "user-b", email: "ben@studio.com" });
		const list = await benApp.request(`/api/presence?projectId=${project}&scope=page&scopeId=0`);
		expect((await readBody(list)).others).toHaveLength(0);
	});

	test("GET excludes the caller themselves", async () => {
		const project = `proj-${crypto.randomUUID()}`;
		workspaceProject(project, ["user-a"]);
		const annApp = appAs({ userId: "user-a", email: "ann@studio.com" });
		await postJson(annApp, "/api/presence/heartbeat", { projectId: project, scope: "task", scopeId: "t1" });
		const selfList = await annApp.request(`/api/presence?projectId=${project}&scope=task&scopeId=t1`);
		expect((await readBody(selfList)).others).toHaveLength(0);
	});
});

describe("presence route — file-mode (legacy anonymous)", () => {
	test("anonymous client can ping/read an ownerless project when the legacy hatch is on", async () => {
		(serverConfig as { apiAuthRequired: boolean }).apiAuthRequired = false;
		(serverConfig as { allowLegacyAnonymousProjects: boolean }).allowLegacyAnonymousProjects = true;
		const project = `proj-${crypto.randomUUID()}`;
		anonymousProject(project);
		const app = appAnon();

		const first = await postJson(app, "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "3", userId: "user-a", name: "Ann" });
		expect(first.status).toBe(200);
		expect((await readBody(first)).others).toHaveLength(0);

		const second = await postJson(app, "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "3", userId: "user-b", name: "Ben" });
		const body = await readBody(second);
		expect(body.others).toHaveLength(1);
		expect(body.others![0]!.name).toBe("Ann");
		expect(body.others![0]).not.toHaveProperty("userId");
	});

	test("anonymous client is DENIED on a WORKSPACE project even with the hatch on", async () => {
		(serverConfig as { apiAuthRequired: boolean }).apiAuthRequired = false;
		(serverConfig as { allowLegacyAnonymousProjects: boolean }).allowLegacyAnonymousProjects = true;
		const project = `proj-${crypto.randomUUID()}`;
		workspaceProject(project, ["user-a"]);
		const res = await postJson(appAnon(), "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "1", userId: "x", name: "X" });
		expect(res.status).toBe(404);
	});

	test("anonymous write is rejected when auth is required (prod posture)", async () => {
		(serverConfig as { apiAuthRequired: boolean }).apiAuthRequired = true;
		const project = `proj-${crypto.randomUUID()}`;
		anonymousProject(project);
		const res = await postJson(appAnon(), "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "1", userId: "x", name: "X" });
		expect(res.status).toBe(401);
	});

	test("anonymous client is DENIED when the legacy hatch is OFF", async () => {
		(serverConfig as { apiAuthRequired: boolean }).apiAuthRequired = false;
		(serverConfig as { allowLegacyAnonymousProjects: boolean }).allowLegacyAnonymousProjects = false;
		const project = `proj-${crypto.randomUUID()}`;
		anonymousProject(project);
		const res = await postJson(appAnon(), "/api/presence/heartbeat", { projectId: project, scope: "page", scopeId: "1", userId: "x", name: "X" });
		expect(res.status).toBe(404);
	});

	test("invalid scope is a validation error (400) before any auth work", async () => {
		const project = `proj-${crypto.randomUUID()}`;
		workspaceProject(project, ["user-a"]);
		const res = await postJson(appAs({ userId: "user-a", email: "ann@studio.com" }), "/api/presence/heartbeat", { projectId: project, scope: "bogus", scopeId: "0" });
		expect(res.status).toBe(400);
	});
});
