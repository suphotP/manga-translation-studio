// RBAC regression test for GET /api/storage/quota/:accountKind/:accountId
// (routes/quota.ts).
//
// Before the fix, workspace quota inspection was gated behind platform-admin ONLY
// (`user.role !== "admin"` → 403), so a workspace OWNER/admin could not see their
// own workspace's quota / freeze / top-assets. The fix additionally allows a
// workspace owner/admin via the existing workspace RBAC permission
// `update_workspace` (owner/admin-only — editors/viewers lack it), WITHOUT
// widening access to ordinary members.
//
// We assert:
//   - a platform admin can read any workspace quota (unchanged),
//   - a workspace OWNER/admin can read THEIR OWN workspace quota (the fix),
//   - an ordinary member (no update_workspace) is still 403,
//   - a user can read their own user-account quota; another user's is 403.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Stub the storage-cow service so the route's getQuotaState() never needs a real
// DATABASE_URL — we only care about the authorization decision in front of it.
// Spread the REAL module first: other modules in this process import more
// exports (QuotaFrozenError, AssetAccountKind, …) and a partial factory makes
// their evaluation throw "Export named ... not found" (cross-file mock.module
// hazard — see export-pipeline-egress.test.ts).
import * as realStorageCow from "../services/storage-cow.js";
const QUOTA_STATE = { used: 10, limit: 100, frozen: false, top_5_largest: [] };
mock.module("../services/storage-cow.js", () => ({
	...realStorageCow,
	getSharedStorageCowService: () => ({
		getQuotaState: async () => QUOTA_STATE,
	}),
}));

const { quota } = await import("../routes/quota.js");
const workspaceAccessModule = await import("../services/workspace-access.js");

const workspaceAccessStore = workspaceAccessModule.workspaceAccessStore!;
const { WorkspaceAccessError } = workspaceAccessModule;
const originalRequirePermission = workspaceAccessStore.requirePermission.bind(workspaceAccessStore);

// Membership map: workspaceId -> userId -> set of permissions the user holds.
const memberships = new Map<string, Map<string, Set<string>>>();

beforeEach(() => {
	memberships.clear();
	(workspaceAccessStore as { requirePermission: typeof originalRequirePermission }).requirePermission = (async (
		workspaceId: string,
		userId: string,
		permission: string,
	) => {
		const perms = memberships.get(workspaceId)?.get(userId);
		if (!perms) throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		if (!perms.has(permission)) {
			throw new WorkspaceAccessError("Forbidden", 403, "workspace_permission_denied");
		}
		return { workspaceId, userId, role: "owner" } as never;
	}) as typeof originalRequirePermission;
});

afterEach(() => {
	(workspaceAccessStore as { requirePermission: typeof originalRequirePermission }).requirePermission = originalRequirePermission;
});

function grant(workspaceId: string, userId: string, permissions: string[]): void {
	const byUser = memberships.get(workspaceId) ?? new Map<string, Set<string>>();
	byUser.set(userId, new Set(permissions));
	memberships.set(workspaceId, byUser);
}

function appAs(user: { userId: string; role: string } | null): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (user) {
			(c as { set: (key: string, value: unknown) => void }).set("user", {
				userId: user.userId,
				email: `${user.userId}@x.com`,
				role: user.role,
			});
		}
		await next();
	});
	app.route("/api/storage/quota", quota);
	return app;
}

async function getQuota(app: Hono, kind: string, id: string): Promise<Response> {
	return app.request(`/api/storage/quota/${kind}/${id}`);
}

describe("quota route — RBAC for workspace owners/admins", () => {
	test("a workspace OWNER/admin can read their OWN workspace quota", async () => {
		const ws = "ws-owned";
		grant(ws, "owner-1", ["update_workspace"]);
		const res = await getQuota(appAs({ userId: "owner-1", role: "editor" }), "workspace", ws);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { account_kind: string; limit_bytes: number };
		expect(body.account_kind).toBe("workspace");
		expect(body.limit_bytes).toBe(100);
	});

	test("a platform admin can read any workspace quota (unchanged)", async () => {
		const res = await getQuota(appAs({ userId: "root", role: "admin" }), "workspace", "ws-other");
		expect(res.status).toBe(200);
	});

	test("a platform OWNER can read any workspace quota (owner=admin hierarchy)", async () => {
		// owner is a strict superset of admin; a literal role === "admin" gate used
		// to wrongly 403 an owner who has no workspace membership for this account.
		const res = await getQuota(appAs({ userId: "founder", role: "owner" }), "workspace", "ws-other");
		expect(res.status).toBe(200);
	});

	test("an ordinary member WITHOUT update_workspace is still 403", async () => {
		const ws = "ws-member";
		grant(ws, "member-1", ["read_workspace", "read_project"]); // no update_workspace
		const res = await getQuota(appAs({ userId: "member-1", role: "editor" }), "workspace", ws);
		expect(res.status).toBe(403);
	});

	test("a non-member cannot read a workspace's quota", async () => {
		const res = await getQuota(appAs({ userId: "stranger", role: "editor" }), "workspace", "ws-nobody");
		expect(res.status).toBe(403);
	});

	test("a user can read their OWN user-account quota; another user's is 403", async () => {
		const own = await getQuota(appAs({ userId: "u-1", role: "editor" }), "user", "u-1");
		expect(own.status).toBe(200);
		const other = await getQuota(appAs({ userId: "u-1", role: "editor" }), "user", "u-2");
		expect(other.status).toBe(403);
	});

	test("an unauthenticated caller is 401", async () => {
		const res = await getQuota(appAs(null), "workspace", "ws-owned");
		expect(res.status).toBe(401);
	});
});
