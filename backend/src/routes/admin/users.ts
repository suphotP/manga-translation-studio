// Back-office USERS-MGMT sub-router (rank 16 — user detail + role / enable-disable).
//
// Mounted at /api/admin/users-mgmt by backend/src/routes/admin.ts. The existing
// inline /users list/force-logout/force-delete routes stay in admin.ts; this
// sub-router is the NEW user detail + platform-role / enable-disable surface.
// The parent admin router already applies authMiddleware +
// requirePermission(ACCESS) on every path, so requests that reach here are
// authenticated platform admins. This sub-router layers the domain READ gate on
// top and gates each mutation with USERS_WRITE.
//
// EVERY mutation:
//   * routes the write through the ATOMIC owner-guarded service path
//     (updateUserProtectingLastOwner) — never the raw update — so a concurrent
//     demote/disable can never orphan the platform of its last active owner;
//   * enforces the owner-target policy (only an owner may mutate an owner) and
//     the role-assignment policy (only admin:roles.write may change roles);
//   * runs a fast last-owner pre-check (the atomic store path is the real
//     guarantee under a race; this gives the caller a clean 403 instead of a
//     wasted write attempt);
//   * writes an admin_audit row (same mechanism as /workspaces/:id/refund).

import { Hono } from "hono";
import { z } from "zod/v4";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { ADMIN_PERMISSIONS, ROLE_PERMISSIONS } from "../../types/auth.js";
import type { JWTPayload, User, UserRole } from "../../types/auth.js";
import { readJsonBody, readOptionalJsonBody } from "../../utils/request-body.js";
import { decodeUserCursor, encodeUserCursor, parseUserLimit } from "../../utils/user-list-cursor.js";
import {
	countActiveUsersByRole,
	countUsers,
	deleteUserProtectingLastOwner,
	listUsersPaginated,
	loadUser,
	revokeAllUserTokens,
	updateUserProtectingLastOwner,
} from "../../services/auth.service.js";
import { LastPlatformOwnerError, USER_LIST_DEFAULT_LIMIT } from "../../services/auth-users.js";
import {
	ADMIN_SELF_PROTECTION_REASON,
	AdminSelfProtectionError,
	assertLastOwnerMutationAllowed,
	assertOwnerTargetMutationAllowed,
	assertPlatformAdminSelfUpdateAllowed,
	assertRoleAssignmentAllowed,
} from "../../services/admin-protection.js";
import { gdprStore, type GdprStore } from "../../services/gdpr.js";
import {
	workspaceAccessStore as defaultWorkspaceAccessStore,
	type WorkspaceAccessStore,
} from "../../services/workspace-access.js";
import type { AdminRouterDeps } from "../admin.js";

// Assignable platform roles. owner is intentionally NOT a query filter value-only
// concern — it IS a valid role, but only an owner (admin:roles.write) can assign
// it, enforced below. This list is the request-validation allow-list and is
// derived from the single ROLE_PERMISSIONS source so it never drifts.
const ASSIGNABLE_ROLES = Object.keys(ROLE_PERMISSIONS) as [UserRole, ...UserRole[]];
const roleEnum = z.enum(ASSIGNABLE_ROLES);

const listQuerySchema = z.object({
	search: z.string().trim().max(200).optional(),
	role: roleEnum.optional(),
	// Status filter: "active" | "disabled". Anything else → no status filter.
	status: z.enum(["active", "disabled"]).optional(),
	cursor: z.string().trim().max(512).optional(),
	limit: z.number().int().min(1).max(200).optional(),
}).strict();

const changeRoleSchema = z.object({
	role: roleEnum,
	reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

const disableSchema = z.object({
	reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

// Public user shape (no passwordHash) — the row returned by loadUser /
// updateUserProtectingLastOwner once secrets are stripped at the service edge.
type PublicUser = Omit<User, "passwordHash">;

function userListRow(user: PublicUser) {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		isActive: user.isActive,
		emailVerified: user.emailVerified ?? false,
		authProvider: user.authProvider,
		lastLogin: user.lastLogin ?? null,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
}

export function createAdminUsersRouter(deps: AdminRouterDeps = {}): Hono {
	const router = new Hono();
	const gdpr: GdprStore = deps.gdpr ?? gdprStore;
	const workspaceAccess: WorkspaceAccessStore | null =
		deps.workspaceAccess !== undefined ? deps.workspaceAccess : defaultWorkspaceAccessStore;

	// Baseline READ gate. Mutations layer requirePermission(USERS_WRITE) on top.
	router.use("*", requirePermission(ADMIN_PERMISSIONS.USERS_READ));

	// ── GET /users-mgmt — keyset-paginated list ───────────────────
	// Honest grand-total COUNT + one bounded keyset page run in parallel. Search,
	// role, and status filters are pushed into the store query before keyset
	// pagination, so a filtered page is filled with matching users and `total`
	// reflects that same filtered set.
	router.get("/", async (c) => {
		const parsed = listQuerySchema.safeParse({
			search: c.req.query("search"),
			role: c.req.query("role"),
			status: c.req.query("status"),
			cursor: c.req.query("cursor"),
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		const search = parsed.data.search || undefined;
		const role = parsed.data.role || undefined;
		const status = parsed.data.status || undefined;
		const cursor = decodeUserCursor(parsed.data.cursor);
		const limit = parseUserLimit(parsed.data.limit !== undefined ? String(parsed.data.limit) : undefined);

		const [{ users, nextCursor }, total] = await Promise.all([
			listUsersPaginated({ search, role, status, cursor, limit }),
			countUsers({ search, role, status }),
		]);

		return c.json({
			users: users.map(userListRow),
			total,
			nextCursor: encodeUserCursor(nextCursor),
			limit: limit ?? USER_LIST_DEFAULT_LIMIT,
		});
	});

	// ── GET /users-mgmt/:userId — detail ──────────────────────────
	router.get("/:userId", async (c) => {
		const userId = c.req.param("userId") ?? "";
		const user = await loadUser(userId);
		if (!user) return c.json({ error: "User not found", code: "user_not_found" }, 404);

		// Workspace memberships (count + lightweight rows). Bounded by the user's own
		// memberships, never a global scan. Tolerate a store error so the detail view
		// still renders the profile if the membership lookup fails.
		const workspaces = workspaceAccess
			? await workspaceAccess.listUserWorkspaces(userId).catch(() => [])
			: [];

		// Recent admin-audit activity TARGETING this user (cheap bounded read). Gives
		// the detail view a "what was done to this account" trail without a join.
		const recentActivity = await gdpr
			.listAdminAudit({ targetKind: "user", targetId: userId, limit: 20 })
			.then((result) => result.entries)
			.catch(() => []);

		return c.json({
			user: {
				...userListRow(user),
				externalIdentities: user.externalIdentities ?? [],
				tokensValidFromMs: user.tokensValidFromMs ?? 0,
			},
			workspaces: workspaces.map((workspace) => ({
				id: workspace.workspaceId,
				name: workspace.name,
				memberRole: workspace.memberRole,
				memberStudioRole: workspace.memberStudioRole,
				memberScope: workspace.memberScope,
			})),
			workspaceCount: workspaces.length,
			recentActivity,
		});
	});

	// ── PATCH /users-mgmt/:userId/role — change platform role ─────
	router.patch("/:userId/role", requirePermission(ADMIN_PERMISSIONS.USERS_WRITE), async (c) => {
		const admin = requireAdminUser(c);
		const userId = c.req.param("userId") ?? "";
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = changeRoleSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		const target = await loadUser(userId);
		if (!target) return c.json({ error: "User not found", code: "user_not_found" }, 404);

		const oldRole = target.role;
		const nextRole = parsed.data.role;
		// No-op role change: report success without an audit row or a needless write.
		if (oldRole === nextRole) {
			return c.json({ ok: true, changed: false, user: userListRow(target) });
		}

		let updated: PublicUser | null;
		try {
			// 1) Only admin:roles.write (owner) may change ANY platform role.
			assertRoleAssignmentAllowed({ actorRole: admin.role, nextRole });
			// 2) Owner-target policy: only an owner may mutate an owner.
			assertOwnerTargetMutationAllowed({
				actorRole: admin.role,
				targetCurrentRole: oldRole,
				isDestructive: nextRole !== "owner",
			});
			// 3) Self-protection: a platform admin/owner cannot demote themselves below
			//    super-admin (would risk locking the platform out of its own back-office).
			assertPlatformAdminSelfUpdateAllowed({
				actorUserId: admin.userId,
				targetUserId: userId,
				currentRole: oldRole,
				nextRole,
			});
			// 4) Last-owner pre-check (the atomic store path is the real race guarantee).
			assertLastOwnerMutationAllowed({
				targetCurrentRole: oldRole,
				nextRole,
				action: "update",
				ownerCount: await countActiveUsersByRole("owner"),
			});
			// 5) ATOMIC owner-guarded write — never the raw update.
			updated = await updateUserProtectingLastOwner(userId, { role: nextRole });
		} catch (error) {
			return mapMutationError(c, error);
		}
		if (!updated) return c.json({ error: "User not found", code: "user_not_found" }, 404);

		const entry = await gdpr.recordAdminAudit({
			adminUserId: admin.userId,
			action: "admin.user.role_change",
			targetKind: "user",
			targetId: userId,
			detail: { email: target.email, oldRole, newRole: nextRole, reason: parsed.data.reason ?? null },
		});
		return c.json({ ok: true, changed: true, user: userListRow(updated), audit: entry });
	});

	// ── POST /users-mgmt/:userId/disable ──────────────────────────
	router.post("/:userId/disable", requirePermission(ADMIN_PERMISSIONS.USERS_WRITE), async (c) => {
		const admin = requireAdminUser(c);
		const userId = c.req.param("userId") ?? "";
		const raw = await readOptionalJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = disableSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		const target = await loadUser(userId);
		if (!target) return c.json({ error: "User not found", code: "user_not_found" }, 404);
		if (!target.isActive) {
			return c.json({ ok: true, changed: false, user: userListRow(target) });
		}

		let updated: PublicUser | null;
		try {
			// Disabling an owner is destructive → owner-only.
			assertOwnerTargetMutationAllowed({
				actorRole: admin.role,
				targetCurrentRole: target.role,
				isDestructive: true,
			});
			// A platform admin/owner cannot disable their own account.
			assertPlatformAdminSelfUpdateAllowed({
				actorUserId: admin.userId,
				targetUserId: userId,
				currentRole: target.role,
				nextIsActive: false,
			});
			assertLastOwnerMutationAllowed({
				targetCurrentRole: target.role,
				nextIsActive: false,
				action: "update",
				ownerCount: await countActiveUsersByRole("owner"),
			});
			updated = await updateUserProtectingLastOwner(userId, { isActive: false });
		} catch (error) {
			return mapMutationError(c, error);
		}
		if (!updated) return c.json({ error: "User not found", code: "user_not_found" }, 404);

		const entry = await gdpr.recordAdminAudit({
			adminUserId: admin.userId,
			action: "admin.user.disable",
			targetKind: "user",
			targetId: userId,
			detail: { email: target.email, reason: parsed.data.reason ?? null },
		});
		return c.json({ ok: true, changed: true, user: userListRow(updated), audit: entry });
	});

	// ── POST /users-mgmt/:userId/enable ───────────────────────────
	// Enable is SAFE (re-activating can never reduce the active-owner count) so it
	// skips the last-owner / self guards. It still respects the owner-target policy:
	// a non-owner admin must not mutate an owner account.
	router.post("/:userId/enable", requirePermission(ADMIN_PERMISSIONS.USERS_WRITE), async (c) => {
		const admin = requireAdminUser(c);
		const userId = c.req.param("userId") ?? "";
		const raw = await readOptionalJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = disableSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		const target = await loadUser(userId);
		if (!target) return c.json({ error: "User not found", code: "user_not_found" }, 404);
		if (target.isActive) {
			return c.json({ ok: true, changed: false, user: userListRow(target) });
		}

		let updated: PublicUser | null;
		try {
			assertOwnerTargetMutationAllowed({
				actorRole: admin.role,
				targetCurrentRole: target.role,
				isDestructive: false,
			});
			updated = await updateUserProtectingLastOwner(userId, { isActive: true });
		} catch (error) {
			return mapMutationError(c, error);
		}
		if (!updated) return c.json({ error: "User not found", code: "user_not_found" }, 404);

		const entry = await gdpr.recordAdminAudit({
			adminUserId: admin.userId,
			action: "admin.user.enable",
			targetKind: "user",
			targetId: userId,
			detail: { email: target.email, reason: parsed.data.reason ?? null },
		});
		return c.json({ ok: true, changed: true, user: userListRow(updated), audit: entry });
	});

	// ── POST /users-mgmt/:userId/force-logout ─────────────────────
	// Revoke ALL of a user's tokens (forces re-login everywhere). Owner-target
	// policy: only an owner may force-logout an owner. Audited. Migrated here from
	// the removed inline admin.ts /users/:id/force-logout (this is now the one path).
	router.post("/:userId/force-logout", requirePermission(ADMIN_PERMISSIONS.USERS_WRITE), async (c) => {
		const admin = requireAdminUser(c);
		const userId = c.req.param("userId") ?? "";
		const target = await loadUser(userId);
		if (!target) return c.json({ error: "User not found", code: "user_not_found" }, 404);
		try {
			assertOwnerTargetMutationAllowed({
				actorRole: admin.role,
				targetCurrentRole: target.role,
				isDestructive: true,
			});
		} catch (error) {
			return mapMutationError(c, error);
		}
		await revokeAllUserTokens(userId);
		const entry = await gdpr.recordAdminAudit({
			adminUserId: admin.userId,
			action: "admin.user.force_logout",
			targetKind: "user",
			targetId: userId,
			detail: { email: target.email },
		});
		return c.json({ ok: true, audit: entry });
	});

	// ── DELETE /users-mgmt/:userId — force-delete ─────────────────
	// Atomic owner-guarded delete (never orphans the last active owner). Self-delete
	// via admin is disallowed (must go through /api/account grace flow). Audited.
	// Migrated here from the removed inline admin.ts DELETE /users/:id.
	router.delete("/:userId", requirePermission(ADMIN_PERMISSIONS.USERS_WRITE), async (c) => {
		const admin = requireAdminUser(c);
		const userId = c.req.param("userId") ?? "";
		if (admin.userId === userId) {
			return c.json({ error: "Admins cannot force-delete their own account", code: "self_target" }, 400);
		}
		const target = await loadUser(userId);
		if (!target) return c.json({ error: "User not found", code: "user_not_found" }, 404);
		let deleted: boolean;
		try {
			if (target.role === "owner") {
				// Owner-target policy: only an owner may delete another owner.
				assertOwnerTargetMutationAllowed({
					actorRole: admin.role,
					targetCurrentRole: target.role,
					isDestructive: true,
				});
				// Fast pre-check; the atomic delete below is the real last-owner race guard.
				assertLastOwnerMutationAllowed({
					targetCurrentRole: target.role,
					action: "delete",
					ownerCount: await countActiveUsersByRole("owner"),
				});
			}
			deleted = await deleteUserProtectingLastOwner(userId);
		} catch (error) {
			return mapMutationError(c, error);
		}
		const entry = await gdpr.recordAdminAudit({
			adminUserId: admin.userId,
			action: "admin.user.force_delete",
			targetKind: "user",
			targetId: userId,
			detail: { email: target.email, success: deleted },
		});
		return c.json({ ok: deleted, audit: entry });
	});

	return router;
}

/** Narrow the auth payload set by the parent authMiddleware. */
function requireAdminUser(c: { get: (key: "user") => JWTPayload | undefined }): JWTPayload {
	const user = c.get("user");
	if (!user) throw new Error("auth_required");
	return user;
}

/**
 * Translate the guard/store errors into the canonical admin responses. Both the
 * route-level self/owner/role guards (AdminSelfProtectionError) and the atomic
 * store-level last-owner race guard (LastPlatformOwnerError) map to 403 with the
 * same self-protection reason so the UI handles them uniformly.
 */
function mapMutationError(
	c: { json: (body: unknown, status?: 400 | 403) => Response },
	error: unknown,
): Response {
	if (error instanceof AdminSelfProtectionError) {
		return c.json({ error: error.message, reason: error.reason }, error.status as 403);
	}
	if (error instanceof LastPlatformOwnerError) {
		return c.json({ error: error.message, reason: ADMIN_SELF_PROTECTION_REASON }, 403);
	}
	throw error;
}
