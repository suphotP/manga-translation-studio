// Builds the hono/secure-headers configuration for this backend.
//
// Single source of truth for our CSP / Permissions-Policy posture so the prod
// middleware wiring and the unit tests share one definition. Pulled into its
// own module so test code can call it without booting the whole app.

import type { secureHeaders } from "hono/secure-headers";

// `SecureHeadersOptions` is not re-exported by hono; derive it from the
// public middleware factory's parameter type so we don't drift.
type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

export interface BuildSecureHeadersInput {
	nodeEnv?: string;
	// R2_PUBLIC_BASE_URL — if set, allowed as an img-src origin so the editor can
	// fetch original / preview assets that live on the public R2 / CDN host.
	r2PublicBaseUrl?: string;
	// Optional CSP report-uri target.
	cspReportUri?: string;
}

function parseOrigin(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return `${url.protocol}//${url.host}`;
	} catch {
		return null;
	}
}

export function buildSecureHeadersOptions(input: BuildSecureHeadersInput = {}): SecureHeadersOptions {
	const isProd = input.nodeEnv === "production";
	const r2Origin = parseOrigin(input.r2PublicBaseUrl);

	const imgSrc: string[] = ["'self'", "data:", "blob:"];
	if (r2Origin) imgSrc.push(r2Origin);

	const styleSrc: string[] = ["'self'"];
	if (!isProd) styleSrc.push("'unsafe-inline'");

	const connectSrc: string[] = ["'self'", "https://api.sentry.io", "https://*.ingest.sentry.io"];

	const contentSecurityPolicy: NonNullable<SecureHeadersOptions["contentSecurityPolicy"]> = {
		defaultSrc: ["'self'"],
		imgSrc,
		styleSrc,
		connectSrc,
		scriptSrc: ["'self'"],
		fontSrc: ["'self'", "data:"],
		objectSrc: ["'none'"],
		frameAncestors: ["'none'"],
		baseUri: ["'self'"],
	};
	if (input.cspReportUri) {
		(contentSecurityPolicy as Record<string, string[] | string>)["reportUri"] = input.cspReportUri;
	}

	return {
		contentSecurityPolicy,
		crossOriginResourcePolicy: "cross-origin",
		strictTransportSecurity: "max-age=31536000; includeSubDomains",
		xFrameOptions: "DENY",
		xContentTypeOptions: true,
		referrerPolicy: "strict-origin-when-cross-origin",
		permissionsPolicy: {
			camera: [],
			microphone: [],
			geolocation: [],
		},
	};
}
