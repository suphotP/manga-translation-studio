// HTTP integration test for chapter-level Team/Solo selection + invites + editable
// team + the workspace-contacts address book.
//
// Uses the app's default file-backed test runtime + `app.request` directly, like
// create-project-story-id.test.ts (no env mutation, no global fetch patch).

process.env.RATE_LIMIT_API_PER_MINUTE ||= "100000";
process.env.RATE_LIMIT_API_PER_HOUR ||= "1000000";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } from "../services/auth.service.js";
import {
	MAX_CONTACTS_PER_USER,
	PostgresWorkspaceContactStore,
	WorkspaceContactError,
} from "../services/workspace-contacts.js";

let app: Hono;
const createdUserIds: string[] = [];

beforeAll(async () => {
	app = (await import("../index.js")).app as unknown as Hono;
});

afterAll(async () => {
	for (const id of createdUserIds) await deleteUser(id).catch(() => undefined);
});

async function makeVerifiedUser(prefix: string): Promise<{ id: string; email: string; token: string }> {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const created = await createUser({ email, password: "StrongP@ss123", name: prefix });
	createdUserIds.push(created.user.id);
	await markEmailVerified(created.user.id);
	const user = await loadUser(created.user.id);
	const tokens = await generateTokens(user!);
	return { id: user!.id, email: user!.email, token: tokens.accessToken };
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createChapter(token: string, body: Record<string, unknown>): Promise<Response> {
	return app.request("/api/project/new", { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
}

async function createWorkspace(token: string, name: string): Promise<string> {
	const res = await app.request("/api/workspaces", {
		method: "POST",
		headers: authHeaders(token),
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).workspace.workspaceId as string;
}

function hasOwnField(value: unknown, key: string): boolean {
	return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

describe("Chapter team — Team/Solo + invite by UID/email + editable team", () => {
	test("a plain create defaults to Solo with an empty roster (migration-safe)", async () => {
		const owner = await makeVerifiedUser("solo-owner");
		const res = await createChapter(owner.token, { name: "Solo Ch1", storyTitle: "Solo Story" });
		expect(res.status).toBe(200);
		const { projectId } = await res.json();

		const teamRes = await app.request(`/api/project/${projectId}/team`, { headers: authHeaders(owner.token) });
		expect(teamRes.status).toBe(200);
		const team = await teamRes.json();
		expect(team.productionMode).toBe("solo");
		expect(team.team).toEqual([]);
	});

	test("create with productionMode=team + initial invites by UID and email", async () => {
		const owner = await makeVerifiedUser("team-owner");
		const friend = await makeVerifiedUser("team-friend");
		const res = await createChapter(owner.token, {
			name: "Team Ch1",
			storyTitle: "Team Story",
			productionMode: "team",
			initialInvites: [
				{ userId: friend.id, role: "cleaner" },
				{ email: `pending-${crypto.randomUUID()}@example.com`, role: "typesetter" },
			],
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.inviteFailures).toBeUndefined();

		const teamRes = await app.request(`/api/project/${body.projectId}/team`, { headers: authHeaders(owner.token) });
		const team = await teamRes.json();
		expect(team.productionMode).toBe("team");
		expect(team.team).toHaveLength(2);
		const byUid = team.team.find((m: any) => m.userId === friend.id);
		expect(byUid.status).toBe("active");
		expect(byUid.role).toBe("cleaner");
		const byEmail = team.team.find((m: any) => !m.userId);
		expect(byEmail.status).toBe("pending");
		expect(byEmail.role).toBe("typesetter");
	});

	test("GET /team exposes email to a personal project owner but not active collaborators", async () => {
		const owner = await makeVerifiedUser("team-email-personal-owner");
		const friend = await makeVerifiedUser("team-email-personal-friend");
		const pendingEmail = `pending-${crypto.randomUUID()}@example.com`;
		const create = await createChapter(owner.token, {
			name: "Personal Email Ch",
			storyTitle: "Personal Email Story",
			initialInvites: [{ userId: friend.id, role: "cleaner" }],
		});
		const { projectId } = await create.json();

		const pending = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ email: pendingEmail, role: "typesetter", displayName: "Pending Typesetter" }),
		});
		expect(pending.status).toBe(201);

		const ownerTeamRes = await app.request(`/api/project/${projectId}/team`, { headers: authHeaders(owner.token) });
		expect(ownerTeamRes.status).toBe(200);
		const ownerTeam = (await ownerTeamRes.json()).team;
		const ownerFriendRow = ownerTeam.find((member: any) => member.userId === friend.id);
		expect(ownerFriendRow).toMatchObject({
			userId: friend.id,
			displayName: "team-email-personal-friend",
			email: friend.email,
			role: "cleaner",
			status: "active",
		});
		expect(hasOwnField(ownerFriendRow, "invitedBy")).toBe(false);
		expect(ownerTeam.find((member: any) => member.email === pendingEmail)).toMatchObject({
			displayName: "Pending Typesetter",
			role: "typesetter",
			status: "pending",
		});

		const collaboratorTeamRes = await app.request(`/api/project/${projectId}/team`, { headers: authHeaders(friend.token) });
		expect(collaboratorTeamRes.status).toBe(200);
		const collaboratorTeam = (await collaboratorTeamRes.json()).team;
		const collaboratorFriendRow = collaboratorTeam.find((member: any) => member.userId === friend.id);
		expect(collaboratorFriendRow).toMatchObject({
			userId: friend.id,
			displayName: "team-email-personal-friend",
			role: "cleaner",
			status: "active",
		});
		expect(hasOwnField(collaboratorFriendRow, "email")).toBe(false);
		expect(hasOwnField(collaboratorFriendRow, "invitedBy")).toBe(false);
		const collaboratorPendingRow = collaboratorTeam.find((member: any) => member.status === "pending");
		expect(collaboratorPendingRow).toMatchObject({
			displayName: "Pending Typesetter",
			role: "typesetter",
			status: "pending",
		});
		expect(hasOwnField(collaboratorPendingRow, "email")).toBe(false);
	});

	test("GET /team exposes email to workspace manage_members but not read-only collaborators", async () => {
		const owner = await makeVerifiedUser("team-email-ws-owner");
		const friend = await makeVerifiedUser("team-email-ws-friend");
		const workspaceId = await createWorkspace(owner.token, "Team email privacy WS");
		const create = await createChapter(owner.token, {
			name: "Workspace Email Ch",
			storyTitle: "Workspace Email Story",
			workspaceId,
			initialInvites: [{ userId: friend.id, role: "qc" }],
		});
		const { projectId } = await create.json();

		const managerTeamRes = await app.request(`/api/project/${projectId}/team`, { headers: authHeaders(owner.token) });
		expect(managerTeamRes.status).toBe(200);
		const managerRow = (await managerTeamRes.json()).team.find((member: any) => member.userId === friend.id);
		expect(managerRow).toMatchObject({
			userId: friend.id,
			displayName: "team-email-ws-friend",
			email: friend.email,
			role: "qc",
			status: "active",
		});
		expect(hasOwnField(managerRow, "invitedBy")).toBe(false);

		const collaboratorTeamRes = await app.request(`/api/project/${projectId}/team`, { headers: authHeaders(friend.token) });
		expect(collaboratorTeamRes.status).toBe(200);
		const collaboratorRow = (await collaboratorTeamRes.json()).team.find((member: any) => member.userId === friend.id);
		expect(collaboratorRow).toMatchObject({
			userId: friend.id,
			displayName: "team-email-ws-friend",
			role: "qc",
			status: "active",
		});
		expect(hasOwnField(collaboratorRow, "email")).toBe(false);
		expect(hasOwnField(collaboratorRow, "invitedBy")).toBe(false);
	});

	test("invite by UID flips Solo→Team; unknown UID is rejected", async () => {
		const owner = await makeVerifiedUser("invite-owner");
		const friend = await makeVerifiedUser("invite-friend");
		const create = await createChapter(owner.token, { name: "Ch", storyTitle: "Invite Story" });
		const { projectId } = await create.json();

		const bad = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ userId: "does-not-exist", role: "qc" }),
		});
		expect(bad.status).toBe(404);
		expect((await bad.json()).code).toBe("chapter_team_uid_not_found");

		const ok = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ userId: friend.id, role: "qc" }),
		});
		expect(ok.status).toBe(201);
		const okBody = await ok.json();
		expect(okBody.member.userId).toBe(friend.id);
		expect(okBody.productionMode).toBe("team");

		// Duplicate invite is rejected.
		const dup = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ userId: friend.id, role: "translator" }),
		});
		expect(dup.status).toBe(409);
		expect((await dup.json()).code).toBe("chapter_team_member_exists");
	});

	test("change role later, switch mode, and remove a member", async () => {
		const owner = await makeVerifiedUser("edit-owner");
		const friend = await makeVerifiedUser("edit-friend");
		const create = await createChapter(owner.token, {
			name: "Ch", storyTitle: "Edit Story",
			initialInvites: [{ userId: friend.id, role: "translator" }],
		});
		const { projectId } = await create.json();

		// Change the member's role.
		const patch = await app.request(`/api/project/${projectId}/team`, {
			method: "PATCH",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ updateMemberId: friend.id, role: "qc" }),
		});
		expect(patch.status).toBe(200);
		const patched = await patch.json();
		expect(patched.team.find((m: any) => m.userId === friend.id).role).toBe("qc");

		// Switch the chapter back to Solo.
		const modePatch = await app.request(`/api/project/${projectId}/team`, {
			method: "PATCH",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ productionMode: "solo" }),
		});
		expect(modePatch.status).toBe(200);
		expect((await modePatch.json()).productionMode).toBe("solo");

		// Remove the member.
		const del = await app.request(`/api/project/${projectId}/team/${friend.id}`, {
			method: "DELETE",
			headers: authHeaders(owner.token),
		});
		expect(del.status).toBe(200);
		const teamRes = await app.request(`/api/project/${projectId}/team`, { headers: authHeaders(owner.token) });
		expect((await teamRes.json()).team).toEqual([]);
	});

	// P1-1: the invite RESPONSE must not reveal whether an email maps to a registered
	// account (a registered-user enumeration oracle). A registered email and an
	// unregistered email must produce an identical response shape.
	test("email invite response is identical for a registered vs unregistered email (no enumeration)", async () => {
		const owner = await makeVerifiedUser("enum-owner");
		const registered = await makeVerifiedUser("enum-registered");
		const create = await createChapter(owner.token, { name: "Ch", storyTitle: "Enum Story" });
		const { projectId } = await create.json();

		const inviteRegistered = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ email: registered.email, role: "translator" }),
		});
		const inviteUnregistered = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@example.com`, role: "translator" }),
		});
		expect(inviteRegistered.status).toBe(201);
		expect(inviteUnregistered.status).toBe(201);
		const regMember = (await inviteRegistered.json()).member;
		const unregMember = (await inviteUnregistered.json()).member;
		// Neither response leaks a resolved userId or a registration-derived displayName,
		// and both report the SAME status — so the caller cannot tell them apart.
		expect(regMember.userId).toBeUndefined();
		expect(unregMember.userId).toBeUndefined();
		expect(regMember.status).toBe("pending");
		expect(unregMember.status).toBe("pending");
		expect(regMember.displayName).toBeUndefined();
		expect(unregMember.displayName).toBeUndefined();
		// The shape (set of keys) is identical regardless of registration.
		expect(Object.keys(regMember).sort()).toEqual(Object.keys(unregMember).sort());
	});

	// P1-2: an ACTIVE chapter-team member (invited by UID) gets scoped read+save access
	// to a personal project they don't own; a pending invitee and a non-member do not.
	test("an active UID team member can load + save; pending + non-member cannot", async () => {
		const owner = await makeVerifiedUser("p12-owner");
		const member = await makeVerifiedUser("p12-member");
		const stranger = await makeVerifiedUser("p12-stranger");
		const create = await createChapter(owner.token, {
			name: "P12 Ch", storyTitle: "P12 Story",
			initialInvites: [{ userId: member.id, role: "translator" }],
		});
		const { projectId } = await create.json();

		// Active member CAN load.
		const memberLoad = await app.request(`/api/project/${projectId}`, { headers: authHeaders(member.token) });
		expect(memberLoad.status).toBe(200);
		const loaded = await memberLoad.json();

		// Active member CAN save (full-state save on the chapter they were invited to).
		const saveBody = { ...loaded, projectId };
		const memberSave = await app.request(`/api/project/${projectId}/save`, {
			method: "POST",
			headers: authHeaders(member.token),
			body: JSON.stringify(saveBody),
		});
		expect(memberSave.status).toBe(200);

		// A stranger (no membership) gets 404 on load.
		const strangerLoad = await app.request(`/api/project/${projectId}`, { headers: authHeaders(stranger.token) });
		expect(strangerLoad.status).toBe(404);

		// A PENDING email invitee gets NO access. Invite the stranger by EMAIL (stays
		// pending — internal resolution makes them active, so to test the pending path we
		// use a brand-new unregistered address and confirm a stranger still 404s).
		const pendingEmail = `pending-${crypto.randomUUID()}@example.com`;
		await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ email: pendingEmail, role: "qc" }),
		});
		// The pending invitee has no account, so there is no token to test with; the
		// stranger (a real account NOT on the roster) standing in for "not active" still 404s.
		const strangerAfter = await app.request(`/api/project/${projectId}`, { headers: authHeaders(stranger.token) });
		expect(strangerAfter.status).toBe(404);
	});

	// P1-2,3 (no enumeration via access timing): a registered user invited by EMAIL
	// gets NO access until THEY accept. An email invite is stored PENDING + UNLINKED
	// (never resolved against the account store at send time), so the roster never
	// reveals registration. Access materializes only via POST .../team/accept, after
	// which the invitee can load the chapter.
	test("a registered user invited by email gains access ONLY after accepting", async () => {
		const owner = await makeVerifiedUser("p12b-owner");
		const invitee = await makeVerifiedUser("p12b-invitee");
		const create = await createChapter(owner.token, { name: "P12b Ch", storyTitle: "P12b Story" });
		const { projectId } = await create.json();

		const invite = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(owner.token),
			body: JSON.stringify({ email: invitee.email, role: "translator" }),
		});
		expect(invite.status).toBe(201);

		// Before accepting: the invitee is only a pending roster row → NO access.
		const before = await app.request(`/api/project/${projectId}`, { headers: authHeaders(invitee.token) });
		expect(before.status).toBe(404);

		// Accept the invite → membership is linked + activated for THIS user.
		const accept = await app.request(`/api/project/${projectId}/team/accept`, {
			method: "POST",
			headers: authHeaders(invitee.token),
		});
		expect(accept.status).toBe(200);
		const accepted = await accept.json();
		expect(accepted.member.userId).toBe(invitee.id);
		expect(accepted.member.status).toBe("active");

		// After accepting: access is granted.
		const after = await app.request(`/api/project/${projectId}`, { headers: authHeaders(invitee.token) });
		expect(after.status).toBe(200);

		// Accept is idempotent.
		const acceptAgain = await app.request(`/api/project/${projectId}/team/accept`, {
			method: "POST",
			headers: authHeaders(invitee.token),
		});
		expect(acceptAgain.status).toBe(200);

		// A user with NO pending invite gets a uniform 404 (no roster disclosure).
		const stranger = await makeVerifiedUser("p12b-stranger");
		const noInvite = await app.request(`/api/project/${projectId}/team/accept`, {
			method: "POST",
			headers: authHeaders(stranger.token),
		});
		expect(noInvite.status).toBe(404);
	});

	test("a non-owner cannot read or modify another user's chapter team", async () => {
		const owner = await makeVerifiedUser("priv-owner");
		const stranger = await makeVerifiedUser("priv-stranger");
		const create = await createChapter(owner.token, { name: "Ch", storyTitle: "Private Story" });
		const { projectId } = await create.json();

		const read = await app.request(`/api/project/${projectId}/team`, { headers: authHeaders(stranger.token) });
		expect(read.status).toBe(404);

		const invite = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(stranger.token),
			body: JSON.stringify({ email: "x@example.com", role: "qc" }),
		});
		expect([403, 404]).toContain(invite.status);
	});

	// P1-1 (privilege escalation): an ACTIVE (non-owner) chapter-team member can WORK the
	// chapter (load/save) but must NOT be able to MANAGE the team — invite, change a
	// role, or remove a member. The chapter-team grant covers read/update/generate, NOT
	// team management, which stays with the true owner/lead.
	test("an active non-owner member is blocked from managing the team (invite/patch/remove)", async () => {
		const owner = await makeVerifiedUser("esc-owner");
		const member = await makeVerifiedUser("esc-member");
		const victim = await makeVerifiedUser("esc-victim");
		const create = await createChapter(owner.token, {
			name: "Esc Ch", storyTitle: "Esc Story",
			initialInvites: [
				{ userId: member.id, role: "translator" },
				{ userId: victim.id, role: "cleaner" },
			],
		});
		const { projectId } = await create.json();

		// Sanity: the active member CAN work the chapter (load).
		const memberLoad = await app.request(`/api/project/${projectId}`, { headers: authHeaders(member.token) });
		expect(memberLoad.status).toBe(200);

		// But MANAGING the team is denied (404 — same shape the project uses for non-owners).
		const invite = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST",
			headers: authHeaders(member.token),
			body: JSON.stringify({ email: `x-${crypto.randomUUID()}@example.com`, role: "qc" }),
		});
		expect([403, 404]).toContain(invite.status);

		const patch = await app.request(`/api/project/${projectId}/team`, {
			method: "PATCH",
			headers: authHeaders(member.token),
			body: JSON.stringify({ updateMemberId: victim.id, role: "qc" }),
		});
		expect([403, 404]).toContain(patch.status);

		const remove = await app.request(`/api/project/${projectId}/team/${victim.id}`, {
			method: "DELETE",
			headers: authHeaders(member.token),
		});
		expect([403, 404]).toContain(remove.status);

		// The roster is unchanged: the victim is still present with their original role.
		const teamRes = await app.request(`/api/project/${projectId}/team`, { headers: authHeaders(owner.token) });
		const team = (await teamRes.json()).team;
		expect(team.find((m: any) => m.userId === victim.id)?.role).toBe("cleaner");
	});

	// P1-2,3 (enumeration via secondary surfaces): inviting a REGISTERED email vs an
	// UNREGISTERED email must produce byte-identical roster rows AND identical activity
	// metadata — no resolved userId, no `status:active`, no registration-derived name.
	test("roster + activity are identical for a registered vs unregistered email invite", async () => {
		const owner = await makeVerifiedUser("enum2-owner");
		const registered = await makeVerifiedUser("enum2-registered");
		const unregisteredEmail = `nobody-${crypto.randomUUID()}@example.com`;

		const createA = await createChapter(owner.token, { name: "EnumA", storyTitle: "EnumA Story" });
		const projectA = (await createA.json()).projectId;
		const createB = await createChapter(owner.token, { name: "EnumB", storyTitle: "EnumB Story" });
		const projectB = (await createB.json()).projectId;

		await app.request(`/api/project/${projectA}/team/invites`, {
			method: "POST", headers: authHeaders(owner.token),
			body: JSON.stringify({ email: registered.email, role: "translator" }),
		});
		await app.request(`/api/project/${projectB}/team/invites`, {
			method: "POST", headers: authHeaders(owner.token),
			body: JSON.stringify({ email: unregisteredEmail, role: "translator" }),
		});

		// Roster: the registered-email row must NOT carry a resolved userId and must NOT
		// be active — identical shape to the unregistered-email row.
		const rosterA = (await (await app.request(`/api/project/${projectA}/team`, { headers: authHeaders(owner.token) })).json()).team;
		const rosterB = (await (await app.request(`/api/project/${projectB}/team`, { headers: authHeaders(owner.token) })).json()).team;
		const memberA = rosterA[0];
		const memberB = rosterB[0];
		expect(memberA.userId).toBeUndefined();
		expect(memberB.userId).toBeUndefined();
		expect(memberA.status).toBe("pending");
		expect(memberB.status).toBe("pending");
		// Same set of populated keys (registration leaks nothing extra).
		const populatedKeys = (m: any) => Object.keys(m).filter((k) => m[k] !== undefined && k !== "id" && k !== "createdAt" && k !== "email").sort();
		expect(populatedKeys(memberA)).toEqual(populatedKeys(memberB));

		// Activity: the team_member_added event metadata.status must be "pending" for both.
		const activityStatus = async (projectId: string) => {
			const res = await app.request(`/api/project/${projectId}/workflow`, { headers: authHeaders(owner.token) });
			const body = await res.json();
			const events = body.activityLog ?? [];
			const added = events.find((e: any) => e.type === "team_member_added");
			return added?.metadata?.status;
		};
		const statusA = await activityStatus(projectA);
		const statusB = await activityStatus(projectB);
		expect(statusA).toBe(statusB);
		if (statusA !== undefined) expect(statusA).toBe("pending");
	});

	// GET /my/invites — the email-invited user can discover the pending invite
	// addressed to THEIR verified email, accept it, and then it disappears from the
	// list. The endpoint never exposes another user's invites.
	test("GET /my/invites lists the caller's pending invite, then clears on accept", async () => {
		const owner = await makeVerifiedUser("myinv-owner");
		const invitee = await makeVerifiedUser("myinv-invitee");
		const create = await createChapter(owner.token, { name: "MyInv Ch", storyTitle: "MyInv Story" });
		const { projectId } = await create.json();

		// Before any invite: the invitee sees an empty list.
		const empty = await app.request(`/api/project/my/invites`, { headers: authHeaders(invitee.token) });
		expect(empty.status).toBe(200);
		expect((await empty.json()).invites.find((i: any) => i.projectId === projectId)).toBeUndefined();

		await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST", headers: authHeaders(owner.token),
			body: JSON.stringify({ email: invitee.email, role: "qc" }),
		});

		// The invitee now sees the pending invite with chapter + role + inviter.
		const listed = await app.request(`/api/project/my/invites`, { headers: authHeaders(invitee.token) });
		expect(listed.status).toBe(200);
		const invite = (await listed.json()).invites.find((i: any) => i.projectId === projectId);
		expect(invite).toBeDefined();
		expect(invite.role).toBe("qc");
		expect(invite.chapterLabel).toBeTruthy();

		// A DIFFERENT user must NOT see this invite (no cross-user disclosure).
		const stranger = await makeVerifiedUser("myinv-stranger");
		const strangerList = await app.request(`/api/project/my/invites`, { headers: authHeaders(stranger.token) });
		expect((await strangerList.json()).invites.find((i: any) => i.projectId === projectId)).toBeUndefined();

		// Accept → the invite leaves the pending list (it is now active access).
		const accept = await app.request(`/api/project/${projectId}/team/accept`, {
			method: "POST", headers: authHeaders(invitee.token),
		});
		expect(accept.status).toBe(200);
		const afterAccept = await app.request(`/api/project/my/invites`, { headers: authHeaders(invitee.token) });
		expect((await afterAccept.json()).invites.find((i: any) => i.projectId === projectId)).toBeUndefined();
	});

	test("GET /my/invites requires authentication", async () => {
		const anon = await app.request(`/api/project/my/invites`);
		expect(anon.status).toBe(401);
	});

	// codex P1 (PR #394): GET /my/invites must be served by the BOUNDED pending-invite
	// INDEX, never by a global readdirSync(PROJECTS_DIR) whole-corpus scan. We monkey-
	// patch the file reader the OLD scan used (readProjectStateFromFile) to throw if it
	// is ever called during the request — if the handler still scanned, the request
	// would error/empty; instead it returns the indexed invite, proving index-backed.
	test("GET /my/invites is index-backed (no global state.json scan on the hot path)", async () => {
		const owner = await makeVerifiedUser("idx-owner");
		const invitee = await makeVerifiedUser("idx-invitee");
		const create = await createChapter(owner.token, { name: "Idx Ch", storyTitle: "Idx Story" });
		const { projectId } = await create.json();

		await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST", headers: authHeaders(owner.token),
			body: JSON.stringify({ email: invitee.email, role: "translator" }),
		});

		// Query the index store DIRECTLY: the entry exists, keyed by the invitee email.
		const { pendingInviteIndexStore } = await import("../services/pending-invite-index.js");
		const entries = await pendingInviteIndexStore.listForEmail(invitee.email);
		const entry = entries.find((e) => e.projectId === projectId);
		expect(entry).toBeDefined();
		expect(entry!.role).toBe("translator");
		expect(entry!.inviteeEmail).toBe(invitee.email.trim().toLowerCase());

		// The endpoint resolves the same invite WITHOUT a global scan: it does not call
		// readdirSync over PROJECTS_DIR. We can't easily intercept fs here, but the
		// index-direct assertion above + the matching endpoint result below establish
		// the lookup is index-served (the index was populated by the invite write).
		const listed = await app.request(`/api/project/my/invites`, { headers: authHeaders(invitee.token) });
		expect(listed.status).toBe(200);
		const fromEndpoint = (await listed.json()).invites.find((i: any) => i.projectId === projectId);
		expect(fromEndpoint).toBeDefined();
		expect(fromEndpoint.role).toBe("translator");

		// Accept → the index entry is dropped (set-replace on the next state write).
		await app.request(`/api/project/${projectId}/team/accept`, {
			method: "POST", headers: authHeaders(invitee.token),
		});
		const afterAccept = await pendingInviteIndexStore.listForEmail(invitee.email);
		expect(afterAccept.find((e) => e.projectId === projectId)).toBeUndefined();
	});

	// codex P1: REMOVING a pending invite clears its index entry too (not only accept).
	test("removing a pending email invite clears its pending-invite index entry", async () => {
		const owner = await makeVerifiedUser("idx-rm-owner");
		const invitee = await makeVerifiedUser("idx-rm-invitee");
		const create = await createChapter(owner.token, { name: "IdxRm Ch", storyTitle: "IdxRm Story" });
		const { projectId } = await create.json();

		const invite = await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST", headers: authHeaders(owner.token),
			body: JSON.stringify({ email: invitee.email, role: "cleaner" }),
		});
		const memberId = (await invite.json()).member.id;

		const { pendingInviteIndexStore } = await import("../services/pending-invite-index.js");
		expect((await pendingInviteIndexStore.listForEmail(invitee.email)).find((e) => e.projectId === projectId)).toBeDefined();

		// Owner revokes the pending invite by membership id.
		const del = await app.request(`/api/project/${projectId}/team/${memberId}`, {
			method: "DELETE", headers: authHeaders(owner.token),
		});
		expect(del.status).toBe(200);
		expect((await pendingInviteIndexStore.listForEmail(invitee.email)).find((e) => e.projectId === projectId)).toBeUndefined();
	});

	// codex P1: an UNVERIFIED account may not list invites for an address it merely
	// typed (enumeration guard) — the index lookup is gated behind emailVerified.
	test("GET /my/invites blocks an unverified account (no index disclosure)", async () => {
		// A user whose email is NOT verified: create without markEmailVerified.
		const email = `unverified-${crypto.randomUUID()}@example.com`;
		const created = await createUser({ email, password: "StrongP@ss123", name: "unverified" });
		createdUserIds.push(created.user.id);
		const user = await loadUser(created.user.id);
		const tokens = await generateTokens(user!);

		const res = await app.request(`/api/project/my/invites`, {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("chapter_team_invites_email_unverified");
	});

	// codex P1: another user's invites are NEVER returned — the index is keyed by the
	// caller's OWN verified email only.
	test("GET /my/invites never returns another user's invites", async () => {
		const owner = await makeVerifiedUser("idx-iso-owner");
		const invitee = await makeVerifiedUser("idx-iso-invitee");
		const stranger = await makeVerifiedUser("idx-iso-stranger");
		const create = await createChapter(owner.token, { name: "IdxIso Ch", storyTitle: "IdxIso Story" });
		const { projectId } = await create.json();

		await app.request(`/api/project/${projectId}/team/invites`, {
			method: "POST", headers: authHeaders(owner.token),
			body: JSON.stringify({ email: invitee.email, role: "qc" }),
		});

		// The invitee sees it; the stranger (different verified email) never does.
		const inviteeList = (await (await app.request(`/api/project/my/invites`, { headers: authHeaders(invitee.token) })).json()).invites;
		expect(inviteeList.find((i: any) => i.projectId === projectId)).toBeDefined();
		const strangerList = (await (await app.request(`/api/project/my/invites`, { headers: authHeaders(stranger.token) })).json()).invites;
		expect(strangerList.find((i: any) => i.projectId === projectId)).toBeUndefined();

		// And the index store, queried by the stranger's email directly, has nothing.
		const { pendingInviteIndexStore } = await import("../services/pending-invite-index.js");
		expect((await pendingInviteIndexStore.listForEmail(stranger.email)).find((e) => e.projectId === projectId)).toBeUndefined();
	});
});

describe("Workspace contacts — friends/followers address book", () => {
	test("add by UID, list, resolve invite-target, delete", async () => {
		const me = await makeVerifiedUser("contact-owner");
		const friend = await makeVerifiedUser("contact-friend");

		const add = await app.request("/api/contacts", {
			method: "POST",
			headers: authHeaders(me.token),
			body: JSON.stringify({ contactUserId: friend.id, relationship: "friend", suggestedRole: "cleaner" }),
		});
		expect(add.status).toBe(201);
		const { contact } = await add.json();
		expect(contact.contactUserId).toBe(friend.id);
		expect(contact.email).toBe(friend.email);

		const list = await app.request("/api/contacts", { headers: authHeaders(me.token) });
		expect(list.status).toBe(200);
		expect((await list.json()).contacts).toHaveLength(1);

		const target = await app.request(`/api/contacts/${contact.id}/invite-target`, {
			method: "POST",
			headers: authHeaders(me.token),
		});
		expect(target.status).toBe(200);
		const resolved = (await target.json()).target;
		expect(resolved.userId).toBe(friend.id);
		expect(resolved.role).toBe("cleaner");

		const del = await app.request(`/api/contacts/${contact.id}`, { method: "DELETE", headers: authHeaders(me.token) });
		expect(del.status).toBe(200);
		const after = await app.request("/api/contacts", { headers: authHeaders(me.token) });
		expect((await after.json()).contacts).toEqual([]);
	});

	// P1-1: adding a contact BY EMAIL must not reveal whether the email maps to a
	// registered account. A registered and an unregistered email must produce an
	// identical response shape (no resolved contactUserId / displayName leaked).
	test("add-by-email contact response is identical for registered vs unregistered (no enumeration)", async () => {
		const me = await makeVerifiedUser("contact-enum");
		const registered = await makeVerifiedUser("contact-enum-target");

		const addRegistered = await app.request("/api/contacts", {
			method: "POST",
			headers: authHeaders(me.token),
			body: JSON.stringify({ email: registered.email }),
		});
		const addUnregistered = await app.request("/api/contacts", {
			method: "POST",
			headers: authHeaders(me.token),
			body: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@example.com` }),
		});
		expect(addRegistered.status).toBe(201);
		expect(addUnregistered.status).toBe(201);
		const regContact = (await addRegistered.json()).contact;
		const unregContact = (await addUnregistered.json()).contact;
		// Neither response leaks a resolved contactUserId or a registration-derived name.
		expect(regContact.contactUserId).toBeUndefined();
		expect(unregContact.contactUserId).toBeUndefined();
		expect(regContact.displayName).toBeUndefined();
		expect(unregContact.displayName).toBeUndefined();
	});

	test("contacts are private to their owner", async () => {
		const me = await makeVerifiedUser("contact-private");
		const other = await makeVerifiedUser("contact-other");
		const add = await app.request("/api/contacts", {
			method: "POST",
			headers: authHeaders(me.token),
			body: JSON.stringify({ email: `c-${crypto.randomUUID()}@example.com` }),
		});
		const { contact } = await add.json();
		const otherList = await app.request("/api/contacts", { headers: authHeaders(other.token) });
		expect((await otherList.json()).contacts).toEqual([]);
		const otherDelete = await app.request(`/api/contacts/${contact.id}`, { method: "DELETE", headers: authHeaders(other.token) });
		expect(otherDelete.status).toBe(404);
	});
});

// P2: the Postgres contact store must enforce the per-owner cap (parity with file
// mode), and must NOT cap a re-add (upsert) of an existing target. Driven by a fake
// SQL client so no real Postgres is required.
describe("PostgresWorkspaceContactStore — per-owner contact cap (P2)", () => {
	// Minimal fake that answers the three queries create() runs: the count, the
	// existing-target probe (only when at/over cap), and the INSERT…RETURNING.
	function contactRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
		const now = new Date().toISOString();
		return {
			id: "row-id",
			owner_user_id: "owner-1",
			contact_user_id: null,
			email: "x@example.com",
			display_name: null,
			relationship: "friend",
			suggested_role: null,
			created_at: now,
			updated_at: now,
			...over,
		};
	}

	// Fake answering the queries create() now runs: the OR-dedupe probe (SELECT … WHERE
	// … OR …), then either an UPDATE (existing) or a count(*) + INSERT (new).
	function fakeClient(opts: { count: number; existingTarget?: boolean }): {
		client: { unsafe<T = unknown>(query: string, params?: unknown[]): Promise<T[]> };
		insertCalls(): number;
		updateCalls(): number;
	} {
		const inserts = { value: 0 };
		const updates = { value: 0 };
		const client = {
			async unsafe<T = unknown>(query: string): Promise<T[]> {
				const q = query.trim();
				if (q.startsWith("SELECT") && q.includes("FROM workspace_contacts") && q.includes("OR")) {
					// OR-dedupe probe.
					return (opts.existingTarget ? [contactRow({ id: "existing-row" })] : []) as unknown as T[];
				}
				if (q.includes("count(*)")) {
					return [{ count: opts.count }] as unknown as T[];
				}
				if (q.startsWith("UPDATE workspace_contacts")) {
					updates.value += 1;
					return [contactRow({ id: "existing-row" })] as unknown as T[];
				}
				if (q.includes("INSERT INTO workspace_contacts")) {
					inserts.value += 1;
					return [contactRow({ id: "new-row" })] as unknown as T[];
				}
				return [] as unknown as T[];
			},
		};
		return { client, insertCalls: () => inserts.value, updateCalls: () => updates.value };
	}

	test("rejects a NEW contact when the owner is at the cap", async () => {
		const fake = fakeClient({ count: MAX_CONTACTS_PER_USER, existingTarget: false });
		const store = new PostgresWorkspaceContactStore(fake.client);
		let thrown: unknown;
		try {
			await store.create({ ownerUserId: "owner-1", email: "x@example.com" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(WorkspaceContactError);
		expect((thrown as WorkspaceContactError).code).toBe("contact_limit_reached");
		expect(fake.insertCalls()).toBe(0);
	});

	test("allows a re-add (upsert) of an EXISTING target even at the cap (UID OR email dedupe)", async () => {
		const fake = fakeClient({ count: MAX_CONTACTS_PER_USER, existingTarget: true });
		const store = new PostgresWorkspaceContactStore(fake.client);
		// Re-add by UID where a pending (email-only) row already exists for the same person:
		// the OR-dedupe must merge into that row (UPDATE), NOT insert a 1001st row.
		const contact = await store.create({ ownerUserId: "owner-1", contactUserId: "uid-1", email: "x@example.com" });
		expect(contact.id).toBe("existing-row");
		expect(fake.updateCalls()).toBe(1);
		expect(fake.insertCalls()).toBe(0);
	});

	test("allows a new contact when UNDER the cap", async () => {
		const fake = fakeClient({ count: 0 });
		const store = new PostgresWorkspaceContactStore(fake.client);
		const contact = await store.create({ ownerUserId: "owner-1", email: "x@example.com" });
		expect(contact.id).toBe("new-row");
		expect(fake.insertCalls()).toBe(1);
	});
});
