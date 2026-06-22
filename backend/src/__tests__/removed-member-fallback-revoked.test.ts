// P1 (pre-launch issue 15, live-proven): removing a member from a workspace did
// NOT revoke their chapter-team fallback access — removeMember only soft-disables
// the workspace_members row and never syncs state.chapterTeam, so the stale
// ACTIVE roster entry kept granting read AND save through checkProjectOwnership's
// fallback (and the images.ts mirror). These tests pin the revocation predicate:
//
//   - was-a-member + removed  → revoked (the fallback gates on this)
//   - never-a-member external → NOT revoked (per-chapter collaborator keeps access)
//   - re-invited (disabled_at cleared) → access restored
//
// plus the workspace-scoped work-lock release on removal.
import { beforeEach, describe, expect, test } from "bun:test";
import { FileWorkspaceAccessStore } from "../services/workspace-access.js";
import { InMemoryWorkLockStore } from "../services/work-locks.js";

// File-mode has no createInvite (Postgres-only feature) — seed the membership
// row directly into the store's private array, the established pattern in
// workspace-access.test.ts.
function seedMember(store: FileWorkspaceAccessStore, workspaceId: string, userId: string): void {
	const members = (store as unknown as { members: Array<Record<string, unknown>> }).members;
	const now = new Date().toISOString();
	members.push({
		workspaceId,
		userId,
		role: "editor",
		memberStudioRole: "translator",
		scope: {},
		createdAt: now,
		updatedAt: now,
	});
}

function reenableMember(store: FileWorkspaceAccessStore, workspaceId: string, userId: string): void {
	// Mirrors the PG acceptInvite upsert, which clears disabled_at on re-invite.
	const members = (store as unknown as { members: Array<{ workspaceId: string; userId: string; disabledAt?: string }> }).members;
	const row = members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
	if (row) delete row.disabledAt;
}

describe("isMembershipRevoked (the revocation predicate)", () => {
	let store: FileWorkspaceAccessStore;

	beforeEach(async () => {
		store = new FileWorkspaceAccessStore();
		await store.createWorkspace({ workspaceId: "ws-revoke", name: "Revoke WS", ownerUserId: "owner-1" });
		seedMember(store, "ws-revoke", "worker-1");
	});

	test("an active member is NOT revoked", async () => {
		expect(await store.getMember("ws-revoke", "worker-1")).not.toBeNull();
		expect(await store.isMembershipRevoked("ws-revoke", "worker-1")).toBe(false);
	});

	test("a removed member IS revoked (row soft-disabled, not deleted)", async () => {
		await store.removeMember({ workspaceId: "ws-revoke", userId: "worker-1", actorUserId: "owner-1" });
		// getMember (membership checks) sees nothing…
		expect(await store.getMember("ws-revoke", "worker-1")).toBeNull();
		// …but the revocation predicate sees the tombstone — this is what denies
		// the chapter-team fallback for ex-members.
		expect(await store.isMembershipRevoked("ws-revoke", "worker-1")).toBe(true);
	});

	test("a NEVER-member (external chapter collaborator) is not revoked", async () => {
		expect(await store.isMembershipRevoked("ws-revoke", "outsider-9")).toBe(false);
	});

	test("re-inviting a removed member clears the revocation", async () => {
		await store.removeMember({ workspaceId: "ws-revoke", userId: "worker-1", actorUserId: "owner-1" });
		expect(await store.isMembershipRevoked("ws-revoke", "worker-1")).toBe(true);
		// Re-invite re-enables the same membership row (PG acceptInvite clears
		// disabled_at — mirrored directly here since file-mode has no invites).
		reenableMember(store, "ws-revoke", "worker-1");
		expect(await store.isMembershipRevoked("ws-revoke", "worker-1")).toBe(false);
		expect(await store.getMember("ws-revoke", "worker-1")).not.toBeNull();
	});
});

describe("workspace-scoped work-lock release on member removal", () => {
	test("releases only the removed member's locks in THAT workspace", async () => {
		const locks = new InMemoryWorkLockStore();
		const mine = await locks.acquireLock("page", "page-1", "worker-1", 10, { workspaceId: "ws-a", projectId: "proj-1" });
		const otherWs = await locks.acquireLock("page", "page-2", "worker-1", 10, { workspaceId: "ws-b", projectId: "proj-2" });
		const otherUser = await locks.acquireLock("page", "page-3", "worker-2", 10, { workspaceId: "ws-a", projectId: "proj-1" });
		expect(mine.lock_id).toBeTruthy();
		expect(otherWs.lock_id).toBeTruthy();
		expect(otherUser.lock_id).toBeTruthy();

		const released = await locks.releaseAllByUserInWorkspace("worker-1", "ws-a");
		expect(released.map((lock) => lock.scopeId)).toEqual(["page-1"]);
		expect(released[0]?.releaseReason).toBe("member_removed");

		// Untouched: same user other workspace, other user same workspace.
		expect((await locks.inspectLockHold(otherWs.lock_id, "worker-1")).status).toBe("held");
		expect((await locks.inspectLockHold(otherUser.lock_id, "worker-2")).status).toBe("held");
		// And the released lock is genuinely gone.
		expect((await locks.inspectLockHold(mine.lock_id, "worker-1")).status).toBe("released");
	});
});
