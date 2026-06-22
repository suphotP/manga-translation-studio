import { Hono } from "hono";
import { getAuthUser, optionalAuth } from "../middleware/auth.middleware.js";
import { getSharedStorageCowService, type AssetAccountKind } from "../services/storage-cow.js";
import { WorkspaceAccessError, workspaceAccessStore } from "../services/workspace-access.js";
import { isPlatformAdmin, type JWTPayload } from "../types/auth.js";

const quota = new Hono();
quota.use("*", optionalAuth);

function parseAccountKind(value: string): AssetAccountKind | null {
	return value === "workspace" || value === "user" ? value : null;
}

// A workspace OWNER/admin may inspect their OWN workspace's quota — not only a
// platform admin. We gate on `update_workspace`, the existing workspace RBAC
// permission that is owner/admin-only (editors/viewers lack it), mirroring how
// the storage routes authorize workspace-scoped reads. This does NOT widen access
// to ordinary members. Returns true when the caller may read this account's quota.
async function canReadQuota(
	accountKind: AssetAccountKind,
	accountId: string,
	user: JWTPayload,
): Promise<boolean> {
	// Platform admins keep full visibility. owner is a strict superset of admin,
	// so a literal role === "admin" would wrongly exclude owner — use the canonical
	// hierarchy helper instead.
	if (isPlatformAdmin(user.role)) return true;
	// A user may always read their own user-account quota.
	if (accountKind === "user" && accountId === user.userId) return true;
	// A workspace owner/admin may read their own workspace's quota.
	if (accountKind === "workspace" && workspaceAccessStore) {
		try {
			await workspaceAccessStore.requirePermission(accountId, user.userId, "update_workspace");
			return true;
		} catch (error) {
			// 403/404 → not an owner/admin of this workspace; deny. Re-throw anything
			// unexpected (a store failure must not silently grant or deny access).
			if (error instanceof WorkspaceAccessError) return false;
			throw error;
		}
	}
	return false;
}

quota.get("/:accountKind/:accountId", async (c) => {
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const accountKind = parseAccountKind(c.req.param("accountKind"));
	if (!accountKind) return c.json({ error: "Invalid account kind" }, 400);
	const accountId = c.req.param("accountId");

	if (!(await canReadQuota(accountKind, accountId, user))) {
		return c.json({ error: "Forbidden" }, 403);
	}

	const state = await getSharedStorageCowService().getQuotaState(accountKind, accountId);
	return c.json({
		account_kind: accountKind,
		account_id: accountId,
		used_bytes: state.used,
		limit_bytes: state.limit,
		frozen: state.frozen,
		top_5_largest_assets: state.top_5_largest,
	});
});

export { quota };
