// Admin USERS-MGMT api barrel (rank 16 — user detail + role / enable-disable).
//
// Talks to the /admin/users-mgmt/* surface via the shared adminFetch client
// (same Bearer header + base URL handling as the rest of the admin surface; the
// client prepends config.apiBase, so paths here are base-relative — no /api).
// This is the NEW user detail + platform-role / enable-disable surface; the
// legacy user list helpers stay in api/admin.ts.

import { adminFetch } from "./client.ts";

export type AdminPlatformRole = "owner" | "admin" | "support" | "accountant" | "editor" | "viewer";

export interface AdminUserListRow {
	id: string;
	email: string;
	name: string;
	role: AdminPlatformRole;
	isActive: boolean;
	emailVerified: boolean;
	authProvider: string;
	lastLogin: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface AdminUserListResponse {
	users: AdminUserListRow[];
	/** Honest grand total for the search filter (not the page length). */
	total: number;
	/** Opaque keyset cursor for the next page, or null on the last page. */
	nextCursor: string | null;
	limit: number;
}

export interface AdminUserWorkspaceRow {
	id: string;
	name: string;
	memberRole: string;
	memberStudioRole: string;
	memberScope: unknown;
}

export interface AdminAuditRow {
	id: string;
	adminUserId: string;
	action: string;
	targetKind: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

export interface AdminUserDetail {
	user: AdminUserListRow & {
		externalIdentities: Array<{ provider: string; subject: string; emailVerified?: boolean }>;
		tokensValidFromMs: number;
	};
	workspaces: AdminUserWorkspaceRow[];
	workspaceCount: number;
	recentActivity: AdminAuditRow[];
}

export interface AdminUserMutationResult {
	ok: boolean;
	changed: boolean;
	user: AdminUserListRow;
	audit?: AdminAuditRow;
}

export interface ListUsersParams {
	search?: string;
	role?: AdminPlatformRole;
	status?: "active" | "disabled";
	cursor?: string;
	limit?: number;
}

function buildQuery(params: ListUsersParams): string {
	const query = new URLSearchParams();
	if (params.search) query.set("search", params.search);
	if (params.role) query.set("role", params.role);
	if (params.status) query.set("status", params.status);
	if (params.cursor) query.set("cursor", params.cursor);
	if (params.limit !== undefined) query.set("limit", String(params.limit));
	const qs = query.toString();
	return qs ? `?${qs}` : "";
}

// Paths must NOT start with /api: the shared adminFetch client prepends
// config.apiBase (which defaults to "/api"), exactly like content.ts / coupons.ts.
// A leading "/api" here produced a double "/api/api/admin/..." prefix → 404.
export const adminUsersApi = {
	/** Keyset-paginated platform-user list with optional role/status/search filters. */
	listUsers(params: ListUsersParams = {}): Promise<AdminUserListResponse> {
		return adminFetch<AdminUserListResponse>(`/admin/users-mgmt${buildQuery(params)}`);
	},

	/** Full detail for one user: profile, workspace memberships, recent admin activity. */
	getUser(userId: string): Promise<AdminUserDetail> {
		return adminFetch<AdminUserDetail>(`/admin/users-mgmt/${encodeURIComponent(userId)}`);
	},

	/** Change a user's platform role (owner-guarded + audited server-side). */
	changeRole(userId: string, role: AdminPlatformRole, reason?: string): Promise<AdminUserMutationResult> {
		return adminFetch<AdminUserMutationResult>(`/admin/users-mgmt/${encodeURIComponent(userId)}/role`, {
			method: "PATCH",
			body: JSON.stringify({ role, ...(reason ? { reason } : {}) }),
		});
	},

	/** Deactivate a user account (owner-guarded + last-owner protected + audited). */
	disableUser(userId: string, reason?: string): Promise<AdminUserMutationResult> {
		return adminFetch<AdminUserMutationResult>(`/admin/users-mgmt/${encodeURIComponent(userId)}/disable`, {
			method: "POST",
			body: JSON.stringify(reason ? { reason } : {}),
		});
	},

	/** Reactivate a previously-disabled user account (safe; audited). */
	enableUser(userId: string, reason?: string): Promise<AdminUserMutationResult> {
		return adminFetch<AdminUserMutationResult>(`/admin/users-mgmt/${encodeURIComponent(userId)}/enable`, {
			method: "POST",
			body: JSON.stringify(reason ? { reason } : {}),
		});
	},

	/** Revoke ALL of a user's tokens (force re-login everywhere; owner-guarded + audited). */
	forceLogout(userId: string): Promise<{ ok: boolean }> {
		return adminFetch<{ ok: boolean }>(`/admin/users-mgmt/${encodeURIComponent(userId)}/force-logout`, {
			method: "POST",
		});
	},

	/** Force-delete a user (atomic last-owner-guarded; cannot target self; audited). */
	forceDelete(userId: string): Promise<{ ok: boolean }> {
		return adminFetch<{ ok: boolean }>(`/admin/users-mgmt/${encodeURIComponent(userId)}`, {
			method: "DELETE",
		});
	},
};
