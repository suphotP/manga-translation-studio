// Frontend Sentry (pre-launch issue 2). Mirrors the backend posture:
// - blank PUBLIC_SENTRY_DSN disables everything (dev default — fail-safe)
// - release tagged with the build commit so errors attribute to deploys,
//   matching the backend's SENTRY_RELEASE=GIT_SHA convention
// - the same credential-scrubbing rules as backend/src/middleware/sentry.ts:
//   short-lived tokens must never reach observability storage.
import * as Sentry from "@sentry/sveltekit";
import { handleErrorWithSentry } from "@sentry/sveltekit";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

if (dsn) {
	Sentry.init({
		dsn,
		environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) || import.meta.env.MODE,
		release: (import.meta.env.VITE_GIT_SHA as string | undefined) || undefined,
		// ERRORS ONLY for launch: tracing transactions/spans bypass beforeSend
		// (it only covers error/message events), so sampled spans could carry
		// auth-callback URLs to Sentry unscrubbed (review #595 r2 P1). Re-enable
		// tracing only together with span-level scrubbing.
		tracesSampleRate: 0,
		beforeSend(event) {
			// Credentials must never reach observability storage (the backend rule).
			// Covers SSE query tokens AND auth-callback params (sso_code,
			// refresh_token, link_intent_token, …) in both query and fragment —
			// the SDK copies window.location.href into request.url, and on a
			// callback page that URL carries live secrets until the auth store
			// clears it (review #595 P1). The entire #fragment is dropped: nothing
			// in our app encodes non-secret state there.
			const SENSITIVE_PARAM = /([?&#](?:token|access_token|accessToken|sse_token|refresh_token|refreshToken|sso_code|code|state|link_intent_token|id_token)=)[^&#]*/gi;
			const scrub = (raw: string): string => raw.replace(/#.*$/, "").replace(SENSITIVE_PARAM, "$1[redacted]");
			if (event.request?.url) event.request.url = scrub(event.request.url);
			if (event.request?.headers?.Referer) event.request.headers.Referer = scrub(event.request.headers.Referer);
			for (const crumb of event.breadcrumbs ?? []) {
				if (typeof crumb.data?.url === "string") crumb.data.url = scrub(crumb.data.url);
				if (typeof crumb.data?.to === "string") crumb.data.to = scrub(crumb.data.to);
				if (typeof crumb.data?.from === "string") crumb.data.from = scrub(crumb.data.from);
			}
			return event;
		},
	});
}

export const handleError = handleErrorWithSentry();
