// Auth UI signal store — owns *only* the in-context AuthModal's open/close +
// active mode. Deliberately separate from `auth.svelte.ts` (which owns the
// session/tokens/permissions): any "Sign in" / "Get started" button anywhere in
// the app can call `authUiStore.openAuthModal("login" | "register" | "forgot")`
// to surface the modal without a full page navigation, and the modal reacts to
// the now-authenticated session via `authStore` once a flow succeeds.

export type AuthModalMode = "login" | "register" | "forgot";

class AuthUiStore {
	/** When true the AuthModal overlay is mounted/visible. */
	open = $state(false);
	/** Which tab the modal opens on / is currently showing. */
	mode = $state<AuthModalMode>("login");
	/**
	 * Optional callback invoked once a flow authenticates the session (login or
	 * register). Lets a trigger react in-context (e.g. re-run a route guard) on
	 * top of the global session reaction. Cleared on close.
	 */
	onAuthenticated = $state<(() => void) | null>(null);

	/** Open the modal on a given mode (defaults to sign-in). */
	openAuthModal(mode: AuthModalMode = "login", onAuthenticated?: () => void): void {
		this.mode = mode;
		this.onAuthenticated = onAuthenticated ?? null;
		this.open = true;
	}

	/** Switch the active tab without closing. */
	setMode(mode: AuthModalMode): void {
		this.mode = mode;
	}

	/** Close the modal and drop any one-shot success callback. */
	close(): void {
		this.open = false;
		this.onAuthenticated = null;
	}

	__resetForTesting(): void {
		this.open = false;
		this.mode = "login";
		this.onAuthenticated = null;
	}
}

export const authUiStore = new AuthUiStore();
