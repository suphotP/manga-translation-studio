import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { authStore } from "$lib/stores/auth.svelte.ts";

export const ssr = false;
export const prerender = false;

const REDIRECT_COOKIE = "manga-editor.auth.intent.v1";

/**
 * Root index guard + IA redirect.
 *
 * W4.6 moved the workspace home to `/dashboard` (marketing landing lives at
 * `/about`), so the root no longer renders the legacy WorkspaceShell — it
 * forwards into the app. We keep W1.4's auth guard: an authenticated visitor
 * is sent straight to `/dashboard`, while an anonymous one is bounced to
 * `/login` with the intent preserved (query + cookie backup) so they land back
 * in the workspace after signing in. Mirrors `(workspace)/+layout.ts`.
 */
export const load: PageLoad = async ({ url, fetch }) => {
	if (typeof window === "undefined") return {};

	await authStore.init(fetch);
	if (authStore.isAuthenticated) {
		redirect(307, "/dashboard");
	}

	const intent = "/dashboard";
	if (typeof document !== "undefined") {
		document.cookie = `${REDIRECT_COOKIE}=${encodeURIComponent(intent)}; Path=/; Max-Age=900; SameSite=Lax`;
	}
	throw redirect(307, `/login?redirect=${encodeURIComponent(intent)}`);
};
