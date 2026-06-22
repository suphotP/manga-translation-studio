process.env.RATE_LIMIT_API_PER_MINUTE ||= "100000";
process.env.RATE_LIMIT_API_PER_HOUR ||= "1000000";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } from "../services/auth.service.js";
import {
	WorkspaceAccessError,
	workspaceAccessStore,
	type WorkspaceMemberRecord,
} from "../services/workspace-access.js";
import type { WorkLockStore } from "../services/work-locks.js";

type WorkspacesRouteModule = typeof import("../routes/workspaces.js");

const store = workspaceAccessStore!;
const createdUserIds: string[] = [];
const nowIso = "2026-06-12T08:00:00.000Z";

let app: Hono;
let setWorkspaceWorkLockStoreForTesting: WorkspacesRouteModule["setWorkspaceWorkLockStoreForTesting"];
let restoreStoreDoubles: () => void = () => undefined;

beforeAll(async () => {
	const routes = await import("../routes/workspaces.js");
	setWorkspaceWorkLockStoreForTesting = routes.setWorkspaceWorkLockStoreForTesting;
	app = (await import("../index.js")).app as unknown as Hono;
});

afterEach(() => {
	restoreStoreDoubles();
	restoreStoreDoubles = () => undefined;
	setWorkspaceWorkLockStoreForTesting();
});

afterAll(async () => {
	for (const userId of createdUserIds.splice(0)) {
		await deleteUser(userId).catch(() => undefined);
	}
});

async function makeVerifiedUser(prefix: string): Promise<{ id: string; token: string }> {
	const created = await createUser({
		email: `${prefix}-${crypto.randomUUID()}@example.com`,
		password: "StrongP@ss123",
		name: prefix,
	});
	createdUserIds.push(created.user.id);
	await markEmailVerified(created.user.id);
	const user = await loadUser(created.user.id);
	const tokens = await generateTokens(user!);
	return { id: user!.id, token: tokens.accessToken };
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

function memberRecord(userId: string, role: WorkspaceMemberRecord["role"]): WorkspaceMemberRecord {
	return {
		workspaceId: "ws-leave",
		userId,
		role,
		memberStudioRole: role === "owner" ? "owner" : "translator",
		scope: role === "owner" ? {} : { taskTypes: ["translate"], aiCreditPolicy: "job_scoped" },
		createdAt: nowIso,
		updatedAt: nowIso,
	};
}

function installWorkspaceMemberDouble(member: WorkspaceMemberRecord | null): {
	removeInputs: Array<Parameters<typeof store.removeMember>[0]>;
	getMemberAfterMutation: () => WorkspaceMemberRecord | null;
} {
	let activeMember = member ? { ...member } : null;
	const removeInputs: Array<Parameters<typeof store.removeMember>[0]> = [];
	const originalGetMember = store.getMember;
	const originalRemoveMember = store.removeMember;

	(store as typeof store & { getMember: typeof store.getMember }).getMember = async (workspaceId: string, userId: string) => {
		if (!activeMember || activeMember.workspaceId !== workspaceId || activeMember.userId !== userId) return null;
		return { ...activeMember };
	};
	(store as typeof store & { removeMember: typeof store.removeMember }).removeMember = async (input) => {
		removeInputs.push(input);
		if (!activeMember || activeMember.role === "owner") {
			throw new WorkspaceAccessError("Workspace member not found or cannot remove owner", 404, "workspace_member_not_found");
		}
		activeMember = null;
	};

	restoreStoreDoubles = () => {
		(store as typeof store & { getMember: typeof store.getMember }).getMember = originalGetMember;
		(store as typeof store & { removeMember: typeof store.removeMember }).removeMember = originalRemoveMember;
	};
	return {
		removeInputs,
		getMemberAfterMutation: () => activeMember,
	};
}

function installWorkLockDouble(): Array<{ userId: string; workspaceId: string }> {
	const releaseCalls: Array<{ userId: string; workspaceId: string }> = [];
	setWorkspaceWorkLockStoreForTesting({
		releaseAllByUserInWorkspace: async (userId: string, workspaceId: string) => {
			releaseCalls.push({ userId, workspaceId });
			return [];
		},
	} as Partial<WorkLockStore> as WorkLockStore);
	return releaseCalls;
}

describe("POST /api/workspaces/:workspaceId/members/me/leave", () => {
	test("returns 403 with a transfer-ownership hint when the current member is owner", async () => {
		const owner = await makeVerifiedUser("leave-owner");
		const { removeInputs } = installWorkspaceMemberDouble(memberRecord(owner.id, "owner"));
		const releaseCalls = installWorkLockDouble();

		const response = await app.request("/api/workspaces/ws-leave/members/me/leave", {
			method: "POST",
			headers: authHeaders(owner.token),
		});
		const body = await response.json() as { error?: string; code?: string };

		expect(response.status).toBe(403);
		expect(body.code).toBe("workspace_owner_cannot_leave");
		expect(body.error).toContain("Transfer ownership");
		expect(removeInputs).toHaveLength(0);
		expect(releaseCalls).toHaveLength(0);
	});

	test("removes the active member as themselves and releases only their workspace locks", async () => {
		const member = await makeVerifiedUser("leave-member");
		const installed = installWorkspaceMemberDouble(memberRecord(member.id, "editor"));
		const releaseCalls = installWorkLockDouble();

		const response = await app.request("/api/workspaces/ws-leave/members/me/leave", {
			method: "POST",
			headers: authHeaders(member.token),
		});
		const body = await response.json() as { ok?: boolean };

		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(installed.removeInputs).toEqual([{
			workspaceId: "ws-leave",
			userId: member.id,
			actorUserId: member.id,
			expectedScope: { taskTypes: ["translate"], aiCreditPolicy: "job_scoped" },
		}]);
		expect(installed.getMemberAfterMutation()).toBeNull();
		expect(releaseCalls).toEqual([{ userId: member.id, workspaceId: "ws-leave" }]);
	});

	test("requires an active membership before leaving", async () => {
		const intruder = await makeVerifiedUser("leave-intruder");
		const { removeInputs } = installWorkspaceMemberDouble(null);
		const releaseCalls = installWorkLockDouble();

		const response = await app.request("/api/workspaces/ws-leave/members/me/leave", {
			method: "POST",
			headers: authHeaders(intruder.token),
		});
		const body = await response.json() as { code?: string };

		expect(response.status).toBe(404);
		expect(body.code).toBe("workspace_not_found");
		expect(removeInputs).toHaveLength(0);
		expect(releaseCalls).toHaveLength(0);
	});
});
