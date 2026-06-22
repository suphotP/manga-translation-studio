// HTTP integration test for GET /api/project?workspaceId=… — the workspace-scoped
// Library listing (cross-workspace isolation, P1).
//
// Proves: (a) a member listing with workspaceId=A sees ONLY workspace A's
// projects, never workspace B's; (b) passing a workspaceId the caller is NOT a
// member of is rejected (404 workspace_not_found), never leaking another tenant's
// projects; (c) the no-workspaceId path is preserved (back-compat: the caller's
// full ownership listing).
//
// Mirrors workspace-home-route.test.ts: file-backed stores, per-pid temp DATA_DIR,
// `app.request` directly (no env mutation / global fetch patch), so it does not
// leak state into sibling test files.

process.env.RATE_LIMIT_API_PER_MINUTE ||= "100000";
process.env.RATE_LIMIT_API_PER_HOUR ||= "1000000";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } from "../services/auth.service.js";

let app: Hono;
const createdUserIds: string[] = [];

beforeAll(async () => {
	process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE ||= "1000";
	process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE ||= "10000";
	process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR ||= "10000";
	app = (await import("../index.js")).app as unknown as Hono;
});

afterAll(async () => {
	for (const id of createdUserIds) {
		try {
			await deleteUser(id);
		} catch {
			// best-effort cleanup
		}
	}
});

async function makeVerifiedUser(emailPrefix: string): Promise<{ id: string; token: string }> {
	const created = await createUser({
		email: `${emailPrefix}-${crypto.randomUUID()}@example.com`,
		password: "StrongP@ss123",
		name: emailPrefix,
	});
	createdUserIds.push(created.user.id);
	await markEmailVerified(created.user.id);
	const user = await loadUser(created.user.id);
	const tokens = await generateTokens(user!);
	return { id: user!.id, token: tokens.accessToken };
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

async function createWorkspaceProject(
	token: string,
	workspaceId: string,
	name: string,
	storyId?: string,
): Promise<string> {
	const body: Record<string, unknown> = { name, lang: "th", workspaceId };
	if (storyId) body.storyId = storyId;
	const res = await app.request("/api/project/new", {
		method: "POST",
		headers: authHeaders(token, true),
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	return (await res.json()).projectId as string;
}

async function listProjects(token: string, workspaceId?: string): Promise<Response> {
	const url = workspaceId
		? `/api/project?workspaceId=${encodeURIComponent(workspaceId)}`
		: "/api/project";
	return app.request(url, { headers: authHeaders(token) });
}

describe("GET /api/project workspace scope (cross-workspace isolation)", () => {
	test("a member listing with workspaceId=A sees ONLY A's projects, not B's", async () => {
		const owner = await makeVerifiedUser("plws-owner");
		const wsA = await createWorkspace(owner.token, "Workspace A");
		const wsB = await createWorkspace(owner.token, "Workspace B");

		const a1 = await createWorkspaceProject(owner.token, wsA, "A — Ch 1");
		const a2 = await createWorkspaceProject(owner.token, wsA, "A — Ch 2");
		const b1 = await createWorkspaceProject(owner.token, wsB, "B — Ch 1");

		const res = await listProjects(owner.token, wsA);
		expect(res.status).toBe(200);
		const ids = ((await res.json()).projects as Array<{ projectId: string; workspaceId?: string }>).map((p) => p.projectId);
		expect(new Set(ids)).toEqual(new Set([a1, a2]));
		expect(ids).not.toContain(b1);

		// And workspaceId=B shows only B's project.
		const resB = await listProjects(owner.token, wsB);
		expect(resB.status).toBe(200);
		const idsB = ((await resB.json()).projects as Array<{ projectId: string }>).map((p) => p.projectId);
		expect(new Set(idsB)).toEqual(new Set([b1]));
	});

	test("listing a workspace the caller is NOT a member of is rejected (never leaks projects)", async () => {
		const owner = await makeVerifiedUser("plws-owner2");
		const intruder = await makeVerifiedUser("plws-intruder");
		const wsPrivate = await createWorkspace(owner.token, "Private WS");
		await createWorkspaceProject(owner.token, wsPrivate, "Private — Ch 1");

		const res = await listProjects(intruder.token, wsPrivate);
		expect(res.status).toBe(404);
		expect((await res.json()).code).toBe("workspace_not_found");
	});

	test("story shelves sharing a storyId across DIFFERENT workspaces stay separate (scoped lists)", async () => {
		// The backend stamps a server-verified storyId; the same client storyId in a
		// DIFFERENT workspace is rejected as foreign on create, so each workspace owns
		// its own story. Listing each workspace returns only that workspace's chapter,
		// proving the lists never merge regardless of any shared id intent.
		const owner = await makeVerifiedUser("plws-story");
		const wsA = await createWorkspace(owner.token, "Story WS A");
		const wsB = await createWorkspace(owner.token, "Story WS B");

		const a1 = await createWorkspaceProject(owner.token, wsA, "Story — Ch 1", "story-shared-1");
		const b1 = await createWorkspaceProject(owner.token, wsB, "Story — Ch 1");

		const resA = await listProjects(owner.token, wsA);
		const idsA = ((await resA.json()).projects as Array<{ projectId: string; workspaceId?: string }>);
		expect(idsA.map((p) => p.projectId)).toEqual([a1]);
		// The summary carries the workspaceId so the client can namespace grouping.
		expect(idsA[0].workspaceId).toBe(wsA);

		const resB = await listProjects(owner.token, wsB);
		const idsB = ((await resB.json()).projects as Array<{ projectId: string }>).map((p) => p.projectId);
		expect(idsB).toEqual([b1]);
	});

	test("no-workspaceId listing is preserved (back-compat: caller's full ownership listing)", async () => {
		const owner = await makeVerifiedUser("plws-compat");
		const wsA = await createWorkspace(owner.token, "Compat WS A");
		const wsB = await createWorkspace(owner.token, "Compat WS B");
		const a1 = await createWorkspaceProject(owner.token, wsA, "Compat A — Ch 1");
		const b1 = await createWorkspaceProject(owner.token, wsB, "Compat B — Ch 1");

		const res = await listProjects(owner.token);
		expect(res.status).toBe(200);
		const ids = ((await res.json()).projects as Array<{ projectId: string }>).map((p) => p.projectId);
		// Unscoped path still surfaces every workspace the caller is a member of.
		expect(ids).toContain(a1);
		expect(ids).toContain(b1);
	});
});
