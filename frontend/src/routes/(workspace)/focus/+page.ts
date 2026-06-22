import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const ssr = false;
export const prerender = false;

/**
 * Bare `/focus` has no view of its own. "Focus" work is always scoped to a
 * project/chapter (the real surface is project-scoped, e.g. inside the editor /
 * work board) — there is nothing meaningful to show for a focus URL with no
 * project context. Hitting `/focus` directly (bookmark, hand-typed URL, or a
 * stale nav link) used to fall through to SvelteKit's full-screen 404 and log
 * `SvelteKitError: Not found: /focus`.
 *
 * Forward it to the workspace home (`/dashboard`) instead, where the user can
 * pick a chapter to work on. This mirrors the other bare-route redirects in
 * `(workspace)` (`/settings`, `/billing`, `/library/[titleKey]/chapters`):
 * `ssr=false`, `prerender=false`, `redirect(307, …)` from `load`. The matching
 * `+page.svelte` is a never-rendered safety net should the redirect ever be
 * skipped.
 */
export const load: PageLoad = () => {
	redirect(307, "/dashboard");
};
