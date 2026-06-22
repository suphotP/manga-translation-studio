/*
	Permission clamp for the workspace "ทีม/หัวหน้า" (lead) vs "งานของฉัน" (my-work)
	view (2026-06-13).

	The lead/team overview ("ทุกตอน · ทุกบทบาท · จัดการทีม + glossary + Export") is an
	OWNER/ADMIN operator surface. It used to be reachable by ANY member because the
	`editorUiStore.workspaceTeamMode` toggle had no role gate and defaults to "lead"
	(persisted in localStorage) — so a plain worker (translator/typesetter) landed on
	the manager board and could reach review/assign/manage affordances they can't use.

	This module is the SINGLE clamp every team-mode surface reads through:
	  • canUseLeadView()   — only owner/admin may see/choose the lead overview.
	  • effectiveTeamMode() — the mode AFTER the clamp: "lead" only when the viewer is
	    an admin AND chose it; everyone else is always "assigned" (their own work),
	    so a stale stored "lead" can never strand a worker on the manager board.

	Pure functions (no runes) that READ the live stores — called inside a component
	`$derived(...)` they track their reads, exactly like duty-profile.ts. Kept here
	(not in editor-ui.svelte.ts) so the low-level UI store never has to import
	workspaces/auth and risk an import cycle. The backend remains the real authority.
*/
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";

/** True only for owner/admin (workspacesStore.isAdmin) — the lead/team overview. */
export function canUseLeadView(): boolean {
	return workspacesStore.isAdmin;
}

/** The team mode after the permission clamp. Non-admins are always "assigned". */
export function effectiveTeamMode(): "lead" | "assigned" {
	return workspacesStore.isAdmin && editorUiStore.workspaceTeamMode === "lead" ? "lead" : "assigned";
}
