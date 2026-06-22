import { describe, expect, test } from "bun:test";
import {
	AdminSelfProtectionError,
	assertOwnerTargetMutationAllowed,
	assertPlatformAdminSelfDeleteAllowed,
	assertPlatformAdminSelfUpdateAllowed,
	assertWorkspaceAdminSelfMutationAllowed,
	countWorkspaceAdmins,
} from "../services/admin-protection.js";
import type { WorkspaceMemberRecord } from "../services/workspace-access.js";

describe("admin self-protection", () => {
	test("blocks platform admin self-demotion and self-deletion with explicit reason", () => {
		expect(() => assertPlatformAdminSelfUpdateAllowed({
			actorUserId: "admin-1",
			targetUserId: "admin-1",
			currentRole: "admin",
			nextRole: "editor",
		})).toThrow(AdminSelfProtectionError);

		try {
			assertPlatformAdminSelfDeleteAllowed("admin-1", "admin-1");
			throw new Error("expected guard to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(AdminSelfProtectionError);
			expect((error as AdminSelfProtectionError).reason).toBe("admin_self_protection");
			expect((error as AdminSelfProtectionError).status).toBe(403);
		}
	});

	test("blocks sole workspace admin from removing or demoting themselves", () => {
		// Guard now takes a precomputed admin count (rank 20: no full-roster load).
		expect(() => assertWorkspaceAdminSelfMutationAllowed({
			actorUserId: "admin-1",
			targetUserId: "admin-1",
			currentRole: "admin",
			nextRole: "viewer",
			adminCount: 1,
			action: "update",
		})).toThrow(AdminSelfProtectionError);

		expect(() => assertWorkspaceAdminSelfMutationAllowed({
			actorUserId: "admin-1",
			targetUserId: "admin-1",
			currentRole: "admin",
			adminCount: 1,
			action: "remove",
		})).toThrow(AdminSelfProtectionError);
	});

	test("allows self-demotion when another workspace admin remains", () => {
		expect(() => assertWorkspaceAdminSelfMutationAllowed({
			actorUserId: "admin-1",
			targetUserId: "admin-1",
			currentRole: "admin",
			nextRole: "viewer",
			adminCount: 2,
			action: "update",
		})).not.toThrow();
	});

	test("owner-target policy: non-owner admin cannot mutate an owner", () => {
		// Non-owner actor + owner target + any mutation → blocked.
		expect(() => assertOwnerTargetMutationAllowed({
			actorRole: "admin",
			targetCurrentRole: "owner",
			isDestructive: true,
		})).toThrow(AdminSelfProtectionError);
		expect(() => assertOwnerTargetMutationAllowed({
			actorRole: "admin",
			targetCurrentRole: "owner",
			isDestructive: false,
		})).toThrow(AdminSelfProtectionError);
		expect(() => assertOwnerTargetMutationAllowed({
			actorRole: "support",
			targetCurrentRole: "owner",
			isDestructive: false,
		})).toThrow(AdminSelfProtectionError);
	});

	test("owner-target policy: owner CAN mutate another owner; non-owner targets allowed", () => {
		// Owner actor → allowed even when destructive.
		expect(() => assertOwnerTargetMutationAllowed({
			actorRole: "owner",
			targetCurrentRole: "owner",
			isDestructive: true,
		})).not.toThrow();
		// Owner actor → allowed for non-destructive owner edits too.
		expect(() => assertOwnerTargetMutationAllowed({
			actorRole: "owner",
			targetCurrentRole: "owner",
			isDestructive: false,
		})).not.toThrow();
		// Non-owner target → admin may manage freely.
		expect(() => assertOwnerTargetMutationAllowed({
			actorRole: "admin",
			targetCurrentRole: "editor",
			isDestructive: true,
		})).not.toThrow();
	});

	test("countWorkspaceAdmins counts owner+admin and ignores editors/viewers", () => {
		const members: WorkspaceMemberRecord[] = [
			{ workspaceId: "w", userId: "u-owner", role: "owner", scope: {}, createdAt: "", updatedAt: "" },
			{ workspaceId: "w", userId: "u-admin", role: "admin", scope: {}, createdAt: "", updatedAt: "" },
			{ workspaceId: "w", userId: "u-editor", role: "editor", scope: {}, createdAt: "", updatedAt: "" },
			{ workspaceId: "w", userId: "u-viewer", role: "viewer", scope: {}, createdAt: "", updatedAt: "" },
		];
		expect(countWorkspaceAdmins(members)).toBe(2);
		expect(countWorkspaceAdmins([])).toBe(0);
	});
});
