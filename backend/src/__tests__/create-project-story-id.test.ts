// HTTP integration test for the create-project storyId integrity gate (#1).
//
// A client supplies `storyId` to "add a chapter to an existing story". Left
// unchecked, a crafted/stale client could stamp ANY storyId — including one owned by
// ANOTHER workspace the caller happens to be a member of — and the Library, which
// groups purely by storyId, would silently MERGE the new chapter into that other
// story. The server now classifies a supplied storyId against THIS create's scope and
// rejects only a FOREIGN id (one that already lives in a different workspace/owner),
// while still allowing a brand-new id (the client mints one for a new story) and an
// existing SAME-scope id (a legitimate chapter add).
//
// Uses the app's default file-backed test runtime + `app.request` directly (no env
// mutation, no global fetch patch), like storage-library-route / workspace-home.

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
	for (const id of createdUserIds) await deleteUser(id).catch(() => undefined);
});

async function makeVerifiedUser(prefix: string): Promise<{ id: string; token: string }> {
	const created = await createUser({ email: `${prefix}-${crypto.randomUUID()}@example.com`, password: "StrongP@ss123", name: prefix });
	createdUserIds.push(created.user.id);
	await markEmailVerified(created.user.id);
	const user = await loadUser(created.user.id);
	const tokens = await generateTokens(user!);
	return { id: user!.id, token: tokens.accessToken };
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createWorkspace(token: string, name: string): Promise<string> {
	const res = await app.request("/api/workspaces", { method: "POST", headers: authHeaders(token), body: JSON.stringify({ name }) });
	expect(res.status).toBe(201);
	return (await res.json()).workspace.workspaceId as string;
}

// Create a chapter/project; returns the HTTP response so the caller can assert status.
async function createChapter(
	token: string,
	body: Record<string, unknown>,
): Promise<Response> {
	return app.request("/api/project/new", { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
}

// Read a project's persisted storyId back (the create response is just { projectId }).
async function storyIdOf(token: string, projectId: string): Promise<string | undefined> {
	const res = await app.request(`/api/project/${projectId}`, { headers: authHeaders(token) });
	expect(res.status).toBe(200);
	return (await res.json()).storyId as string | undefined;
}

describe("POST /api/project/new — storyId integrity gate (#1)", () => {
	test("rejects a storyId that belongs to ANOTHER workspace (cross-workspace merge)", async () => {
		// One user, two workspaces they own. A story is created in workspace B; the
		// user then tries to create a chapter in workspace A reusing B's storyId.
		const user = await makeVerifiedUser("storyid-cross");
		const wsA = await createWorkspace(user.token, "Workspace A");
		const wsB = await createWorkspace(user.token, "Workspace B");

		// Seed a story in workspace B (no client storyId → server mints a stable one).
		const seedRes = await createChapter(user.token, { name: "B Story Ch1", lang: "th", workspaceId: wsB });
		expect(seedRes.status).toBe(200);
		const seedProjectId = (await seedRes.json()).projectId as string;
		const foreignStoryId = await storyIdOf(user.token, seedProjectId);
		expect(foreignStoryId).toBeTruthy();

		// Attempt to attach a chapter in workspace A using workspace B's storyId.
		const attackRes = await createChapter(user.token, {
			name: "A merge attempt",
			lang: "th",
			workspaceId: wsA,
			storyId: foreignStoryId,
		});
		expect(attackRes.status).toBe(403);
		expect((await attackRes.json()).code).toBe("story_not_accessible");
	});

	test("allows a brand-new (client-minted) storyId for a new story", async () => {
		const user = await makeVerifiedUser("storyid-new");
		const ws = await createWorkspace(user.token, "New Story WS");
		// A fresh, dash-free id that exists on no project yet — the new-story case.
		const freshStoryId = "newstory01";
		const res = await createChapter(user.token, {
			name: "Brand New Ch1",
			lang: "th",
			workspaceId: ws,
			storyId: freshStoryId,
		});
		expect(res.status).toBe(200);
		const projectId = (await res.json()).projectId as string;
		expect(await storyIdOf(user.token, projectId)).toBe(freshStoryId);
	});

	test("allows adding a chapter to an existing SAME-workspace story", async () => {
		const user = await makeVerifiedUser("storyid-same");
		const ws = await createWorkspace(user.token, "Same WS");

		const firstRes = await createChapter(user.token, { name: "Ch1", lang: "th", workspaceId: ws });
		expect(firstRes.status).toBe(200);
		const firstProjectId = (await firstRes.json()).projectId as string;
		const storyId = await storyIdOf(user.token, firstProjectId);
		expect(storyId).toBeTruthy();

		// Adding a second chapter under the SAME workspace's existing storyId is allowed.
		const secondRes = await createChapter(user.token, {
			name: "Ch2",
			lang: "th",
			workspaceId: ws,
			storyId,
		});
		expect(secondRes.status).toBe(200);
		const secondProjectId = (await secondRes.json()).projectId as string;
		expect(await storyIdOf(user.token, secondProjectId)).toBe(storyId);
	});

	test("rejects a storyId owned by a workspace the caller is NOT a member of (authoritative, not visible-scoped)", async () => {
		// The old classifier only scanned the CALLER's visible projects, so a storyId in a
		// workspace the caller cannot see could be misread as "new" and silently merged.
		// Ownership is now resolved authoritatively across the WHOLE catalog: a foreign
		// storyId is rejected even when its owning workspace is entirely invisible to the
		// caller (a different user's workspace they were never invited to).
		const owner = await makeVerifiedUser("storyid-other-owner");
		const ownerWs = await createWorkspace(owner.token, "Other Owner WS");
		const seedRes = await createChapter(owner.token, { name: "Other Ch1", lang: "th", workspaceId: ownerWs });
		expect(seedRes.status).toBe(200);
		const otherStoryId = await storyIdOf(owner.token, (await seedRes.json()).projectId as string);
		expect(otherStoryId).toBeTruthy();

		// A DIFFERENT user (no membership in ownerWs) tries to reuse that storyId in their
		// own workspace. They can't even see ownerWs, yet the foreign id must be rejected.
		const attacker = await makeVerifiedUser("storyid-attacker");
		const attackerWs = await createWorkspace(attacker.token, "Attacker WS");
		const attackRes = await createChapter(attacker.token, {
			name: "Cross-owner merge attempt",
			lang: "th",
			workspaceId: attackerWs,
			storyId: otherStoryId,
		});
		expect(attackRes.status).toBe(403);
		expect((await attackRes.json()).code).toBe("story_not_accessible");
	});

	test("rejects a personal-create storyId that belongs to a workspace story", async () => {
		// A personal (workspaceless) chapter must not be able to reuse a storyId that
		// lives on a workspace project — that would merge a private chapter into a
		// workspace story (different owner scope).
		const user = await makeVerifiedUser("storyid-personal");
		const ws = await createWorkspace(user.token, "Owner WS");
		const wsRes = await createChapter(user.token, { name: "WS Story Ch1", lang: "th", workspaceId: ws });
		expect(wsRes.status).toBe(200);
		const wsStoryId = await storyIdOf(user.token, (await wsRes.json()).projectId as string);
		expect(wsStoryId).toBeTruthy();

		const personalRes = await createChapter(user.token, {
			name: "Personal merge attempt",
			lang: "th",
			storyId: wsStoryId,
		});
		expect(personalRes.status).toBe(403);
		expect((await personalRes.json()).code).toBe("story_not_accessible");
	});
});
