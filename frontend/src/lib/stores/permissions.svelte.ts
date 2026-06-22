/*
	Central permission gating for PRIVILEGED UI affordances (2026-06-13).

	ONE derived boolean per privileged ACTION, so a component never re-derives
	"who may do this" from scattered signals (isAdmin here, billingStore plan there,
	account capabilities elsewhere). Every workspace-scoped action gates on the
	WORKSPACE ACCESS ROLE (workspacesStore.memberRole / .isAdmin) — the exact signal
	the backend enforces on (workspace-access.ts ROLE_PERMISSIONS) — NOT the account
	role and NOT the studio/duty role.

	Rule the UI follows everywhere:
	  • permission gap   → HIDE the affordance        (gate render on the boolean here)
	  • plan/quota limit → for a PERMITTED user, show it DISABLED + an upgrade CTA
	    (gate render on the boolean here; gate the disabled-state on the plan signal)
	Permission is checked first; the plan signal only chooses enabled-vs-disabled for
	a user who already holds the permission.

	This is orthogonal to:
	  • duty-profile.ts — which TOOL a member sees in the editor (translate/clean/…)
	  • authStore.can() — the low-level ACCOUNT permission this composes
	The backend remains the real authority on every mutation; these booleans only
	keep the UI honest so a member is never shown an action that would 403.
*/
import { authStore } from "$lib/stores/auth.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";

/** The WORKSPACE access role the backend authorizes on. */
export type WorkspaceAccessRole = "owner" | "admin" | "editor" | "viewer";

/** The four live signals every privileged-UI gate is derived from. */
export interface PermissionInputs {
	/** workspacesStore.isAdmin — memberRole ∈ {owner, admin}; team_lead maps to admin. */
	isAdmin: boolean;
	/**
	 * currentWorkspace.memberRole — the raw WORKSPACE access role (owner|admin|editor|
	 * viewer). team_lead is stored as `admin`, guest as `viewer` (workspaces.svelte.ts
	 * apiRoleFor). null when there is no current workspace (personal/solo or signed out).
	 */
	accessRole: WorkspaceAccessRole | null;
	/** authStore.can("manage:settings") — the ACCOUNT/platform-admin signal. */
	canManageAccountSettings: boolean;
	/** authStore.isAuthenticated — a signed-in (token-bearing) session. */
	isAuthenticated: boolean;
}

export interface PermissionFlags {
	// ── Catalog / project shape — backend manage_projects → owner/admin ──
	canCreateChapter: boolean;
	canCreateStory: boolean;
	canDeleteProject: boolean;
	canRenameStory: boolean;
	canManageLanguageTracks: boolean;
	// ── Members / invites — backend manage_members → owner/admin ──
	canInviteMember: boolean;
	canChangeMemberRole: boolean;
	canRemoveMember: boolean;
	/** Assign-review / send-back — backend requires manage_members (owner/admin). */
	canManageReviewAssignments: boolean;
	// ── Workspace settings / billing — backend update_workspace → owner/admin ──
	canManageSettings: boolean;
	/** ROLE visibility gate. Plan state (billingStore.canManageBilling) only decides
	 *  enabled-vs-disabled for a permitted admin — never visibility. */
	canManageBilling: boolean;
	// ── Editor access-role grants — backend owner/admin/editor ──
	// Deliberately NOT a FE hide-list: the backend grants these to EVERY editor-access
	// member, so hiding them would over-gate legitimate editors and give false security.
	// Exposed for surfaces that need the access-role signal, not to prevent a 403.
	canExport: boolean;
	canImport: boolean;
	canGenerateAI: boolean;
	// ── Platform/account admin — backend requireAdmin / manage:settings ──
	// The AI-config/admin dialog is a PLATFORM-admin surface keyed off the ACCOUNT
	// role, not the workspace role (a workspace owner is not automatically a platform
	// admin, and a platform admin keeps it even as a workspace viewer).
	canManagePlatformAdmin: boolean;
	// ── Workspace creation — backend only requires an authenticated (verified) user ──
	canCreateWorkspace: boolean;
}

/**
 * PURE resolver: maps the four live signals to one boolean per privileged action.
 * Kept pure (no store reads) so the role→capability matrix is unit-testable without
 * mounting the stores. The reactive `permissions` store below feeds it live values.
 */
export function resolvePermissions(input: PermissionInputs): PermissionFlags {
	const { isAdmin, accessRole, canManageAccountSettings, isAuthenticated } = input;
	// Owner/admin/editor = the backend "editor access role" (export/import/generate_ai).
	const editorAccess = accessRole === "owner" || accessRole === "admin" || accessRole === "editor";
	return {
		canCreateChapter: isAdmin,
		canCreateStory: isAdmin,
		canDeleteProject: isAdmin,
		canRenameStory: isAdmin,
		canManageLanguageTracks: isAdmin,
		canInviteMember: isAdmin,
		canChangeMemberRole: isAdmin,
		canRemoveMember: isAdmin,
		canManageReviewAssignments: isAdmin,
		canManageSettings: isAdmin,
		canManageBilling: isAdmin,
		canExport: editorAccess,
		canImport: editorAccess,
		canGenerateAI: editorAccess,
		canManagePlatformAdmin: canManageAccountSettings,
		canCreateWorkspace: isAuthenticated,
	};
}

class PermissionsStore {
	// Single source of truth: derive the whole flag set from the live stores once,
	// then forward each field. Components read `permissions.canCreateChapter` etc.
	#flags = $derived(
		resolvePermissions({
			isAdmin: workspacesStore.isAdmin,
			accessRole: workspacesStore.currentWorkspace?.memberRole ?? null,
			canManageAccountSettings: authStore.can("manage:settings"),
			isAuthenticated: authStore.isAuthenticated,
		}),
	);

	get canCreateChapter(): boolean { return this.#flags.canCreateChapter; }
	get canCreateStory(): boolean { return this.#flags.canCreateStory; }
	get canDeleteProject(): boolean { return this.#flags.canDeleteProject; }
	get canRenameStory(): boolean { return this.#flags.canRenameStory; }
	get canManageLanguageTracks(): boolean { return this.#flags.canManageLanguageTracks; }
	get canInviteMember(): boolean { return this.#flags.canInviteMember; }
	get canChangeMemberRole(): boolean { return this.#flags.canChangeMemberRole; }
	get canRemoveMember(): boolean { return this.#flags.canRemoveMember; }
	get canManageReviewAssignments(): boolean { return this.#flags.canManageReviewAssignments; }
	get canManageSettings(): boolean { return this.#flags.canManageSettings; }
	get canManageBilling(): boolean { return this.#flags.canManageBilling; }
	get canExport(): boolean { return this.#flags.canExport; }
	get canImport(): boolean { return this.#flags.canImport; }
	get canGenerateAI(): boolean { return this.#flags.canGenerateAI; }
	get canManagePlatformAdmin(): boolean { return this.#flags.canManagePlatformAdmin; }
	get canCreateWorkspace(): boolean { return this.#flags.canCreateWorkspace; }
}

export const permissions = new PermissionsStore();
