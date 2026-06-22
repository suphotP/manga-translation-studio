import { redirect } from "@sveltejs/kit";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { config } from "$lib/config.ts";

/**
 * Email-verification wall. Call from a protected route guard AFTER confirming an
 * authenticated session: an authenticated-but-UNVERIFIED user is bounced to the OTP
 * entry page (`/verify-email`) and cannot reach the app until they confirm their
 * email. In dev (auto-verify) accounts are already verified, so this is a no-op.
 *
 * The verify page lives in the unguarded `(auth)` group, so redirecting to it never
 * loops; we also short-circuit if we are already on it as a belt-and-braces guard.
 *
 * When the auth-recovery UI kill-switch is OFF there is NO self-serve verification
 * screen to send the user to, so walling them would trap them in a redirect loop
 * (verify-email → app → verify-email). In that configuration we deliberately do not
 * wall; the backend still gates sensitive writes via requireEmailVerified.
 */
export function requireEmailVerified(pathname: string): void {
	if (!config.authRecoveryEnabled) return;
	if (!authStore.requiresEmailVerification) return;
	if (pathname.startsWith("/verify-email")) return;
	throw redirect(307, "/verify-email");
}
