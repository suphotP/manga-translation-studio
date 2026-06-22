import { redirect } from "@sveltejs/kit";
import type { LayoutLoad } from "./$types";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { requireEmailVerified } from "$lib/auth/require-verified.ts";

export const ssr = false;
export const prerender = false;

const REDIRECT_COOKIE = "manga-editor.auth.intent.v1";

/**
 * Onboarding sits outside the workspace layout shell so the tour can render
 * full-bleed, but it still needs an authenticated user. Mirror the
 * `(workspace)/+layout.ts` guard logic.
 */
export const load: LayoutLoad = async ({ url, fetch }) => {
	if (typeof window === "undefined") return {};
	await authStore.init(fetch);
	if (authStore.isAuthenticated) {
		requireEmailVerified(url.pathname);
		return { user: authStore.currentUser };
	}

	const intent = `${url.pathname}${url.search}`;
	if (typeof document !== "undefined") {
		document.cookie = `${REDIRECT_COOKIE}=${encodeURIComponent(intent)}; Path=/; Max-Age=900; SameSite=Lax`;
	}
	throw redirect(307, `/login?redirect=${encodeURIComponent(intent)}`);
};
