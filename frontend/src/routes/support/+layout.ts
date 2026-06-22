import { redirect } from "@sveltejs/kit";
import type { LayoutLoad } from "./$types";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { requireEmailVerified } from "$lib/auth/require-verified.ts";

export const ssr = false;
export const prerender = false;

const REDIRECT_COOKIE = "manga-editor.auth.intent.v1";

/**
 * Support is an authenticated, customer-scoped surface (the backend
 * `/api/support/tickets` endpoints are auth-only). Mirror the `(workspace)`
 * route guard: bounce anonymous visitors to `/login?redirect=<intent>` so they
 * land back on their ticket after signing in.
 *
 * Lives OUTSIDE the `(workspace)` group on purpose — that group remounts the
 * canvas/editor shell, which the support pages do not need (same reasoning the
 * `/settings` group uses). The backend deep-links tickets at
 * `/support/tickets/:id`, which this route home serves directly.
 */
export const load: LayoutLoad = async ({ url, fetch }) => {
	if (typeof window === "undefined") return {};

	await authStore.init(fetch);
	if (authStore.isAuthenticated) {
		requireEmailVerified(url.pathname);
		return { user: authStore.currentUser };
	}

	// This layout only ever runs under /support/*, so the intent always points
	// back into the support surface — no need to special-case /login or /signup.
	const intent = `${url.pathname}${url.search}`;
	if (typeof document !== "undefined") {
		document.cookie = `${REDIRECT_COOKIE}=${encodeURIComponent(intent)}; Path=/; Max-Age=900; SameSite=Lax`;
	}
	throw redirect(307, `/login?redirect=${encodeURIComponent(intent)}`);
};
