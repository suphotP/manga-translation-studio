import { redirect } from "@sveltejs/kit";
import type { LayoutLoad } from "./$types";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { requireEmailVerified } from "$lib/auth/require-verified.ts";

export const ssr = false;
export const prerender = false;

const REDIRECT_COOKIE = "manga-editor.auth.intent.v1";

/**
 * W1.4 route guard: every page under `(workspace)/` requires an authenticated
 * session. Anonymous users are bounced to `/login?redirect=<intent>` so they
 * land back where they were after signing in. We also write the intent to a
 * cookie as a backup in case the query string is lost during navigation
 * (e.g. the user signs up first and then comes back).
 *
 * The legacy app shell (`+page.svelte` rendering `<WorkspaceShell />`) lives
 * outside this group, so the existing single-page editor entry point keeps
 * working even before auth lands product-wide.
 */
export const load: LayoutLoad = async ({ url, fetch }) => {
	// SSR is disabled for this app and `authStore` touches `localStorage`,
	// so the guard only runs in the browser.
	if (typeof window === "undefined") return {};

	await authStore.init(fetch);
	if (authStore.isAuthenticated) {
		// Verification wall: an unverified account is bounced to the OTP screen and
		// cannot reach the workspace until it confirms its email (no-op in dev).
		requireEmailVerified(url.pathname);
		return { user: authStore.currentUser };
	}

	const intent = `${url.pathname}${url.search}`;
	// Avoid redirect loops if the guard somehow runs on an auth route.
	if (intent.startsWith("/login") || intent.startsWith("/signup")) {
		return {};
	}

	if (typeof document !== "undefined") {
		document.cookie = `${REDIRECT_COOKIE}=${encodeURIComponent(intent)}; Path=/; Max-Age=900; SameSite=Lax`;
	}
	const target = `/login?redirect=${encodeURIComponent(intent)}`;
	throw redirect(307, target);
};
