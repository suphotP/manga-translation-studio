/*
	Duty-capability resolution for the EDITOR tool surface (2026-06-13).

	The editor must show each member only the tools of their DUTY — คนคลีนเห็น
	ชุดคลีน คนลงคำเห็นชุดตัวอักษร คนแปลเห็นโหมดแปล. The duty is resolved with the
	same precedence the backend story-duties resolver uses:

	  1. ACTIVE chapter-team row for this user on the OPEN chapter (override —
	     a guest override means "no duty here" even if the studio role says
	     translator)
	  2. workspace studio role (series-level duty)
	  3. account role (personal projects / legacy editor — full editor caps)

	This module is PURE resolution: it maps the inputs to a RolePermissionKey
	and capability flags via rolePermissionProfile. Components derive from it;
	the backend remains the real authority on every mutation.
*/
import {
	authStore,
	rolePermissionProfile,
	type RoleCapabilityFlags,
	type RolePermissionKey,
} from "$lib/stores/auth.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";

export interface DutyRoleInput {
	/** Signed-in account id (authStore.user.id). */
	userId: string | null | undefined;
	/** Signed-in account email — chapter-team rows may be keyed by email. */
	email: string | null | undefined;
	/** Account role (authStore.role) — final fallback. */
	accountRole: RolePermissionKey | null | undefined;
	/** Workspace member studio role, when the open project belongs to a workspace. */
	memberStudioRole: string | null | undefined;
	/** The open chapter's team roster (ProjectState.chapterTeam), if any. */
	chapterTeam:
		| Array<{ userId?: string; email?: string; role?: string; status?: string }>
		| null
		| undefined;
	/**
	 * The viewer's SERIES-level duty roles on the open story (story assignments).
	 * A member can hold SEVERAL (translator + typesetter, …), so their capability
	 * caps become the UNION of these on top of the studio/account role — this is
	 * what lets a multi-duty member actually claim every duty they're assigned,
	 * matching the backend inbox resolver. Ignored when a chapter-team override is
	 * active (chapter overrides series, same precedence as the backend).
	 */
	storyRoles?: Iterable<string> | null | undefined;
}

const KNOWN_ROLE_KEYS = new Set<string>([
	"owner", "admin", "team_lead", "translator", "cleaner", "typesetter", "qc",
	"guest", "support", "accountant", "editor", "viewer",
]);

function asRoleKey(value: string | null | undefined): RolePermissionKey | null {
	const normalized = value?.trim();
	return normalized && KNOWN_ROLE_KEYS.has(normalized) ? normalized as RolePermissionKey : null;
}

/**
 * Resolve which role profile governs the editor tool surface for this user on
 * the open chapter. Returns null when nothing is known (anonymous) — callers
 * then fall back to the permissionless profile.
 */
export function resolveDutyRoleKey(input: DutyRoleInput): RolePermissionKey | null {
	const email = input.email?.trim().toLowerCase() || null;
	const mine = input.chapterTeam?.find((member) => {
		if (member.status !== "active") return false;
		if (input.userId && member.userId === input.userId) return true;
		return Boolean(email && member.email?.trim().toLowerCase() === email);
	});
	const overrideRole = asRoleKey(mine?.role);
	if (overrideRole) return overrideRole;
	const studioRole = asRoleKey(input.memberStudioRole);
	if (studioRole) return studioRole;
	return asRoleKey(input.accountRole ?? null);
}

/** True when the viewer has an ACTIVE chapter-team row on the open chapter — a
 *  single-duty override that wins over series-level (story) assignments. */
function hasChapterTeamOverride(input: DutyRoleInput): boolean {
	const email = input.email?.trim().toLowerCase() || null;
	const mine = input.chapterTeam?.find((member) => {
		if (member.status !== "active") return false;
		if (input.userId && member.userId === input.userId) return true;
		return Boolean(email && member.email?.trim().toLowerCase() === email);
	});
	return Boolean(asRoleKey(mine?.role));
}

/** Capability flags for the resolved duty (anonymous ⇒ all false). */
export function resolveDutyCapabilities(input: DutyRoleInput): RoleCapabilityFlags {
	const { permissions: _permissions, ...capabilities } = rolePermissionProfile(resolveDutyRoleKey(input));
	// Chapter-team override is single-duty and authoritative — never union series
	// roles on top of it (chapter overrides series, mirroring the backend).
	if (hasChapterTeamOverride(input) || !input.storyRoles) return capabilities;
	// Otherwise UNION the viewer's series-level (story-assignment) duty caps so a
	// member who holds several roles (translator + typesetter, …) can claim/see
	// EVERY duty they're assigned — not just their single workspace studio role.
	for (const role of input.storyRoles) {
		const key = asRoleKey(role);
		if (!key) continue;
		const { permissions: _p, ...roleCaps } = rolePermissionProfile(key);
		capabilities.canTranslate ||= roleCaps.canTranslate;
		capabilities.canClean ||= roleCaps.canClean;
		capabilities.canTypeset ||= roleCaps.canTypeset;
		capabilities.canReviewQC ||= roleCaps.canReviewQC;
	}
	return capabilities;
}

/**
 * Capabilities of the CURRENT user on the OPEN chapter, read straight from the
 * stores — shared by every tool-activation surface (dock, keyboard shortcuts,
 * right-click quick switch) so no path can bypass the duty filter.
 */
export function currentDutyCapabilities(): RoleCapabilityFlags {
	return resolveDutyCapabilities({
		userId: authStore.user?.id,
		email: authStore.user?.email,
		accountRole: authStore.role,
		memberStudioRole: projectStore.currentWorkspaceMember?.memberStudioRole,
		chapterTeam: projectStore.project?.chapterTeam,
		storyRoles: projectStore.viewerStoryDutyRoles,
	});
}

/** True when the duty allows this tool (untagged tools are universal). */
export function dutyAllowsTool(
	def: { capability?: keyof RoleCapabilityFlags },
	capabilities: RoleCapabilityFlags = currentDutyCapabilities(),
): boolean {
	return !def.capability || capabilities[def.capability];
}
