// Platform RBAC foundation tests.
//
// The back-office (everything under /api/admin) gates on the SINGLE
// ROLE_PERMISSIONS map in types/auth.ts. These tests pin:
//   * each platform role's exact permission set (least-privilege),
//   * hasPermission tolerance (unknown role → [] perms, never throws),
//   * mapAuthUserRow coercion (known roles survive load; unknown → viewer),
//   * the last-owner + role-assignment guards in admin-protection.
//
// Per-route allow/deny gating + GET /api/admin/me are covered in gdpr.test.ts
// (which owns the admin-router HTTP harness).

import { describe, expect, test } from "bun:test";
import {
	ADMIN_PERMISSIONS,
	ROLE_PERMISSIONS,
	hasPermission,
	type UserRole,
} from "../types/auth.js";
import { mapAuthUserRow, type AuthUserRow } from "../services/auth-users.js";
import {
	AdminSelfProtectionError,
	assertLastOwnerMutationAllowed,
	assertRoleAssignmentAllowed,
} from "../services/admin-protection.js";

const A = ADMIN_PERMISSIONS;

// Every admin:* permission key. Used to assert a role has EXACTLY the expected
// back-office grants and nothing more.
const ALL_ADMIN_KEYS = Object.values(A);

function adminKeysOf(role: UserRole): string[] {
	return ROLE_PERMISSIONS[role].filter((p) => p.startsWith("admin:")).sort();
}

describe("platform role → permission map", () => {
	test("owner has every admin:* permission incl. roles.write", () => {
		expect(adminKeysOf("owner")).toEqual([...ALL_ADMIN_KEYS].sort());
		expect(hasPermission("owner", A.ROLES_WRITE)).toBe(true);
	});

	test("admin has every admin:* permission EXCEPT roles.write", () => {
		const expected = ALL_ADMIN_KEYS.filter((k) => k !== A.ROLES_WRITE).sort();
		expect(adminKeysOf("admin")).toEqual(expected);
		expect(hasPermission("admin", A.ROLES_WRITE)).toBe(false);
		// admin keeps refund/impersonate/users.write/coupons.write/content.moderate
		expect(hasPermission("admin", A.REFUND_WRITE)).toBe(true);
		expect(hasPermission("admin", A.IMPERSONATE)).toBe(true);
		expect(hasPermission("admin", A.USERS_WRITE)).toBe(true);
	});

	test("accountant is READ-ONLY money: access + revenue read/export + audit only", () => {
		expect(adminKeysOf("accountant")).toEqual(
			[A.ACCESS, A.REVENUE_READ, A.REVENUE_EXPORT, A.AUDIT_READ].sort(),
		);
		// denied everything else
		for (const denied of [A.REFUND_WRITE, A.COUPONS_WRITE, A.USERS_WRITE, A.IMPERSONATE, A.SUPPORT_ADJUST, A.CONTENT_MODERATE, A.ROLES_WRITE]) {
			expect(hasPermission("accountant", denied)).toBe(false);
		}
	});

	test("support can adjust + look up customers but no money/roles/delete", () => {
		expect(adminKeysOf("support")).toEqual(
			[A.ACCESS, A.SUPPORT_READ, A.SUPPORT_ADJUST, A.USERS_READ, A.CONTENT_READ, A.AUDIT_READ].sort(),
		);
		expect(hasPermission("support", A.SUPPORT_ADJUST)).toBe(true);
		// hard denies: refund, impersonate, roles, users.write (force-delete), coupons.write
		for (const denied of [A.REFUND_WRITE, A.IMPERSONATE, A.ROLES_WRITE, A.USERS_WRITE, A.COUPONS_WRITE, A.REVENUE_READ]) {
			expect(hasPermission("support", denied)).toBe(false);
		}
	});

	test("editor and viewer have NO admin:* permissions", () => {
		expect(adminKeysOf("editor")).toEqual([]);
		expect(adminKeysOf("viewer")).toEqual([]);
		expect(hasPermission("editor", A.ACCESS)).toBe(false);
		expect(hasPermission("viewer", A.ACCESS)).toBe(false);
	});

	test("only owner reaches admin:access? no — owner/admin/support/accountant do; editor/viewer do not", () => {
		expect(hasPermission("owner", A.ACCESS)).toBe(true);
		expect(hasPermission("admin", A.ACCESS)).toBe(true);
		expect(hasPermission("support", A.ACCESS)).toBe(true);
		expect(hasPermission("accountant", A.ACCESS)).toBe(true);
		expect(hasPermission("editor", A.ACCESS)).toBe(false);
		expect(hasPermission("viewer", A.ACCESS)).toBe(false);
	});
});

describe("hasPermission tolerance", () => {
	test("an unknown role returns [] (no throw)", () => {
		const unknown = "galaxy-brain" as unknown as UserRole;
		expect(() => hasPermission(unknown, A.ACCESS)).not.toThrow();
		expect(hasPermission(unknown, A.ACCESS)).toBe(false);
		expect(hasPermission(unknown, "read:project")).toBe(false);
	});
});

describe("mapAuthUserRow role coercion", () => {
	function rowWithRole(role: string): AuthUserRow {
		return {
			user_id: "u1",
			email: "u1@example.com",
			password_hash: "hash",
			name: "User",
			role,
			auth_provider: "local",
			external_subject: null,
			email_verified: true,
			verification_email_send_failed: false,
			tokens_valid_from_ms: 0,
			is_active: true,
			last_login_at: null,
			created_at: "2026-06-03T00:00:00.000Z",
			updated_at: "2026-06-03T00:00:00.000Z",
		} as AuthUserRow;
	}

	test("known platform roles survive load intact", () => {
		for (const role of ["owner", "admin", "support", "accountant", "editor", "viewer"] as const) {
			expect(mapAuthUserRow(rowWithRole(role)).role).toBe(role);
		}
	});

	test("an unknown stored role is coerced to least-privileged viewer (not editor)", () => {
		expect(mapAuthUserRow(rowWithRole("superuser")).role).toBe("viewer");
		expect(mapAuthUserRow(rowWithRole("")).role).toBe("viewer");
	});
});

describe("last-owner guard", () => {
	test("blocks demoting / disabling / deleting the last owner", () => {
		expect(() => assertLastOwnerMutationAllowed({
			targetCurrentRole: "owner", nextRole: "admin", action: "update", ownerCount: 1,
		})).toThrow(AdminSelfProtectionError);
		expect(() => assertLastOwnerMutationAllowed({
			targetCurrentRole: "owner", nextIsActive: false, action: "update", ownerCount: 1,
		})).toThrow(AdminSelfProtectionError);
		expect(() => assertLastOwnerMutationAllowed({
			targetCurrentRole: "owner", action: "delete", ownerCount: 1,
		})).toThrow(AdminSelfProtectionError);
	});

	test("allows the mutation when another owner remains", () => {
		expect(() => assertLastOwnerMutationAllowed({
			targetCurrentRole: "owner", nextRole: "admin", action: "update", ownerCount: 2,
		})).not.toThrow();
		expect(() => assertLastOwnerMutationAllowed({
			targetCurrentRole: "owner", action: "delete", ownerCount: 2,
		})).not.toThrow();
	});

	test("ignores non-owner targets entirely", () => {
		expect(() => assertLastOwnerMutationAllowed({
			targetCurrentRole: "admin", nextRole: "viewer", action: "update", ownerCount: 1,
		})).not.toThrow();
	});
});

describe("role-assignment guard (only owner mints roles)", () => {
	test("owner may assign roles", () => {
		expect(() => assertRoleAssignmentAllowed({ actorRole: "owner", nextRole: "admin" })).not.toThrow();
	});

	test("admin/support/accountant cannot change roles", () => {
		for (const actor of ["admin", "support", "accountant", "editor", "viewer"] as const) {
			expect(() => assertRoleAssignmentAllowed({ actorRole: actor, nextRole: "support" }))
				.toThrow(AdminSelfProtectionError);
		}
	});

	test("a request that does not change the role is a no-op for any actor", () => {
		expect(() => assertRoleAssignmentAllowed({ actorRole: "support" })).not.toThrow();
		expect(() => assertRoleAssignmentAllowed({ actorRole: "admin" })).not.toThrow();
	});
});
