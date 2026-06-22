import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceApiRole, WorkspaceRecord } from "$lib/api/client.ts";
import {
	permissions,
	resolvePermissions,
	type PermissionFlags,
	type PermissionInputs,
	type WorkspaceAccessRole,
} from "$lib/stores/permissions.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";

// The privileged ACTIONS that must be owner/admin-only (the leak class the user hit:
// translator/typesetter seeing "create story", a viewer seeing billing/portal).
const ADMIN_ONLY: Array<keyof PermissionFlags> = [
	"canCreateChapter",
	"canCreateStory",
	"canDeleteProject",
	"canRenameStory",
	"canManageLanguageTracks",
	"canInviteMember",
	"canChangeMemberRole",
	"canRemoveMember",
	"canManageReviewAssignments",
	"canManageSettings",
	"canManageBilling",
];

// The backend "editor access role" grants (export/import/generate_ai). These are
// deliberately NOT hidden from editor-access members — the backend allows them, so a
// FE hide would over-gate. Guard against re-introducing that over-gate.
const EDITOR_ACCESS_GRANTS: Array<keyof PermissionFlags> = ["canExport", "canImport", "canGenerateAI"];

/** Inputs as the real stores would report them for a member of a given workspace role. */
function inputsForRole(role: WorkspaceAccessRole | null, account: Partial<PermissionInputs> = {}): PermissionInputs {
	return {
		isAdmin: role === "owner" || role === "admin",
		accessRole: role,
		canManageAccountSettings: account.canManageAccountSettings ?? false,
		isAuthenticated: account.isAuthenticated ?? role !== null,
	};
}

describe("resolvePermissions — role → privileged-action matrix", () => {
	// apiRoleFor (workspaces.svelte.ts) collapses the studio display roles onto the
	// four backend access roles: owner→owner, admin/team_lead→admin, translator/
	// cleaner/typesetter/qc→editor, guest→viewer. The resolver only ever sees those.
	it("owner / admin / team_lead get EVERY admin-only action", () => {
		// owner→"owner"; admin & team_lead both ride the "admin" access role.
		for (const role of ["owner", "admin"] as const) {
			const flags = resolvePermissions(inputsForRole(role));
			for (const action of ADMIN_ONLY) expect(flags[action], `${role}.${action}`).toBe(true);
			for (const grant of EDITOR_ACCESS_GRANTS) expect(flags[grant], `${role}.${grant}`).toBe(true);
		}
	});

	it("translator / cleaner / typesetter / qc (editor access) get NO admin-only action but KEEP export/import/AI", () => {
		// All four studio duties collapse to the "editor" access role.
		const flags = resolvePermissions(inputsForRole("editor"));
		for (const action of ADMIN_ONLY) expect(flags[action], action).toBe(false);
		// The headline leak: a translator must NOT see "create story/chapter".
		expect(flags.canCreateChapter).toBe(false);
		expect(flags.canCreateStory).toBe(false);
		// …but they CAN export/import/generate (backend grants it) — do not over-gate.
		for (const grant of EDITOR_ACCESS_GRANTS) expect(flags[grant], grant).toBe(true);
	});

	it("viewer / guest get NOTHING — no admin action, no export/import/AI", () => {
		// guest collapses to the "viewer" access role.
		const flags = resolvePermissions(inputsForRole("viewer"));
		for (const action of ADMIN_ONLY) expect(flags[action], action).toBe(false);
		for (const grant of EDITOR_ACCESS_GRANTS) expect(flags[grant], grant).toBe(false);
	});

	it("anonymous (no workspace, not authenticated) gets every flag false", () => {
		const flags = resolvePermissions(inputsForRole(null, { isAuthenticated: false }));
		for (const value of Object.values(flags)) expect(value).toBe(false);
	});

	it("a solo owner (memberRole stamped 'owner' on create) keeps full rights", () => {
		const flags = resolvePermissions(inputsForRole("owner"));
		expect(flags.canCreateChapter).toBe(true);
		expect(flags.canManageBilling).toBe(true);
		expect(flags.canInviteMember).toBe(true);
	});

	it("canManagePlatformAdmin is keyed off the ACCOUNT signal, independent of workspace role", () => {
		// A workspace viewer who is a PLATFORM admin still gets the admin/AI-config dialog…
		expect(resolvePermissions(inputsForRole("viewer", { canManageAccountSettings: true })).canManagePlatformAdmin).toBe(
			true,
		);
		// …and a workspace OWNER who is not a platform admin does NOT.
		expect(resolvePermissions(inputsForRole("owner", { canManageAccountSettings: false })).canManagePlatformAdmin).toBe(
			false,
		);
	});

	it("canCreateWorkspace tracks authentication, not workspace role", () => {
		expect(resolvePermissions(inputsForRole(null, { isAuthenticated: true })).canCreateWorkspace).toBe(true);
		expect(resolvePermissions(inputsForRole(null, { isAuthenticated: false })).canCreateWorkspace).toBe(false);
	});
});

// ── Live-store wiring: prove the `permissions` singleton reads the REAL signals ──
// (guards the plumbing currentWorkspace.memberRole → isAdmin → permissions.*, the
//  exact path that was leaking the create button to non-admins).
function makeWorkspace(memberRole: WorkspaceApiRole | undefined): WorkspaceRecord {
	return {
		workspaceId: "ws-perms-test",
		name: "Perms Test",
		planId: "free",
		storageIncludedBytes: 0,
		storageExtraBytes: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		memberRole,
		memberScope: {},
	};
}

describe("permissions store — live workspace wiring", () => {
	beforeEach(() => {
		workspacesStore.workspaces = [];
		workspacesStore.currentWorkspaceId = null;
	});
	afterEach(() => {
		workspacesStore.workspaces = [];
		workspacesStore.currentWorkspaceId = null;
	});

	it("an owner workspace member sees create + billing", () => {
		workspacesStore.workspaces = [makeWorkspace("owner")];
		workspacesStore.currentWorkspaceId = "ws-perms-test";
		expect(permissions.canCreateChapter).toBe(true);
		expect(permissions.canManageBilling).toBe(true);
		expect(permissions.canExport).toBe(true);
	});

	it("an editor-access member (translator/typesetter) is denied create but keeps export", () => {
		workspacesStore.workspaces = [makeWorkspace("editor")];
		workspacesStore.currentWorkspaceId = "ws-perms-test";
		expect(permissions.canCreateChapter).toBe(false);
		expect(permissions.canManageBilling).toBe(false);
		expect(permissions.canExport).toBe(true);
	});

	it("a viewer/guest member is denied create, billing AND export", () => {
		workspacesStore.workspaces = [makeWorkspace("viewer")];
		workspacesStore.currentWorkspaceId = "ws-perms-test";
		expect(permissions.canCreateChapter).toBe(false);
		expect(permissions.canManageBilling).toBe(false);
		expect(permissions.canExport).toBe(false);
	});
});
