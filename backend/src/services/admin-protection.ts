import { ADMIN_PERMISSIONS, hasPermission } from "../types/auth.js";
import type { UserRole } from "../types/auth.js";
import type { WorkspaceMemberRecord, WorkspaceRole } from "./workspace-access.js";

export const ADMIN_SELF_PROTECTION_REASON = "admin_self_protection";

export class AdminSelfProtectionError extends Error {
	readonly status = 403;
	readonly reason = ADMIN_SELF_PROTECTION_REASON;

	constructor(message = "Admin self-protection blocks this action") {
		super(message);
	}
}

/** Platform roles that carry full back-office super-admin powers. */
function isPlatformAdminRole(role: UserRole): boolean {
	return role === "owner" || role === "admin";
}

export function assertPlatformAdminSelfUpdateAllowed(input: {
	actorUserId: string;
	targetUserId: string;
	currentRole: UserRole;
	nextRole?: UserRole;
	nextIsActive?: boolean;
}): void {
	if (input.actorUserId !== input.targetUserId) return;
	if (!isPlatformAdminRole(input.currentRole)) return;
	// An admin/owner editing their own account cannot drop below super-admin or
	// disable themselves — that would risk locking the platform out of its own
	// back-office. (The last-owner guard below additionally protects the final
	// owner against demotion by ANYONE, not just self.)
	if (input.nextRole && !isPlatformAdminRole(input.nextRole)) {
		throw new AdminSelfProtectionError("Platform admins cannot demote themselves below admin role");
	}
	if (input.nextIsActive === false) {
		throw new AdminSelfProtectionError("Platform admins cannot disable their own account");
	}
}

export function assertPlatformAdminSelfDeleteAllowed(actorUserId: string | undefined, targetUserId: string): void {
	if (actorUserId === targetUserId) {
		throw new AdminSelfProtectionError("Platform admins cannot delete their own user account");
	}
}

/**
 * Last-owner guard. The platform must always retain at least one active owner —
 * the only role that can mint other owners/admins (admin:roles.write). This
 * mirrors {@link assertWorkspaceAdminSelfMutationAllowed} but for PLATFORM owners
 * and protects against demotion/disable/delete by ANYONE (not just self), so an
 * admin or a bug can never orphan the platform.
 *
 * @param ownerCount number of currently-active platform owners (count of
 *   auth_users WHERE role = 'owner' AND is_active). Pass a precomputed count so
 *   the route does not load the whole user table just to run this guard.
 */
export function assertLastOwnerMutationAllowed(input: {
	targetCurrentRole: UserRole;
	nextRole?: UserRole;
	nextIsActive?: boolean;
	action: "update" | "delete";
	ownerCount: number;
}): void {
	if (input.targetCurrentRole !== "owner") return;
	const isLastOwner = input.ownerCount <= 1;
	if (!isLastOwner) return;

	if (input.action === "delete") {
		throw new AdminSelfProtectionError("Cannot delete the last platform owner");
	}
	if (input.nextRole && input.nextRole !== "owner") {
		throw new AdminSelfProtectionError("Cannot demote the last platform owner");
	}
	if (input.nextIsActive === false) {
		throw new AdminSelfProtectionError("Cannot disable the last platform owner");
	}
}

/**
 * Only roles holding admin:roles.write (owner) may assign or change platform
 * roles. support/accountant — even though they reach the back-office — must be
 * forbidden from mutating roles. Throws if the actor lacks the permission and a
 * role change is being attempted.
 */
export function assertRoleAssignmentAllowed(input: {
	actorRole: UserRole;
	/** The role being assigned to the target, if the request changes it. */
	nextRole?: UserRole;
}): void {
	if (!input.nextRole) return;
	if (!hasPermission(input.actorRole, ADMIN_PERMISSIONS.ROLES_WRITE)) {
		throw new AdminSelfProtectionError("Only an owner can change platform roles");
	}
}

/**
 * Owner-target policy (secure default): only an OWNER may mutate an OWNER.
 * A non-owner platform admin can manage every non-owner account, but any
 * mutation whose TARGET is currently an owner is owner-only. This blocks account
 * takeover paths where an admin changes an owner's email/name without touching
 * role/status, then takes over the reset-password flow.
 */
export function assertOwnerTargetMutationAllowed(input: {
	actorRole: UserRole;
	targetCurrentRole: UserRole;
	/** Deprecated compatibility flag; owner targets are guarded for every mutation. */
	isDestructive: boolean;
}): void {
	if (input.targetCurrentRole !== "owner") return;
	if (input.actorRole === "owner") return;
	throw new AdminSelfProtectionError("Only an owner can mutate another owner");
}

export function assertWorkspaceAdminSelfMutationAllowed(input: {
	actorUserId: string;
	targetUserId: string;
	currentRole: WorkspaceRole;
	nextRole?: WorkspaceRole;
	/**
	 * Number of active workspace admins (role IN owner/admin). Pass either the
	 * full roster via {@link countWorkspaceAdmins} OR a precomputed count from a
	 * targeted aggregate (preferred — the route no longer loads the whole roster
	 * just to run this guard).
	 */
	adminCount: number;
	action: "update" | "remove";
}): void {
	if (input.actorUserId !== input.targetUserId) return;
	if (!isWorkspaceAdminRole(input.currentRole)) return;

	const adminCount = input.adminCount;
	if (input.action === "remove" && adminCount <= 1) {
		throw new AdminSelfProtectionError("Workspace admins cannot remove themselves when they are the only admin");
	}
	if (input.nextRole && !isWorkspaceAdminRole(input.nextRole) && adminCount <= 1) {
		throw new AdminSelfProtectionError("Workspace admins cannot demote themselves below admin when they are the only admin");
	}
}

/** Count active workspace admins (role IN owner/admin) from a member roster. */
export function countWorkspaceAdmins(members: WorkspaceMemberRecord[]): number {
	return members.filter((member) => isWorkspaceAdminRole(member.role)).length;
}

function isWorkspaceAdminRole(role: WorkspaceRole): boolean {
	return role === "owner" || role === "admin";
}
