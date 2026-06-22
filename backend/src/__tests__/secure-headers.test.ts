// Tests for the secure-headers wiring (CSP / HSTS / X-Frame / Permissions-Policy).
//
// Builds a minimal Hono app with our hono/secure-headers options applied so we
// can assert on the headers without booting the full backend (which drags in
// Redis / Postgres / file-system bootstrap and is too expensive for a unit test).

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { buildSecureHeadersOptions } from "../middleware/secure-headers-config.js";

function buildApp(opts: Parameters<typeof buildSecureHeadersOptions>[0]): Hono {
	const app = new Hono();
	app.use("*", secureHeaders(buildSecureHeadersOptions(opts)));
	app.get("/healthz", (c) => c.json({ ok: true }));
	return app;
}

describe("secure-headers", () => {
	it("sets CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy on /healthz", async () => {
		const app = buildApp({ nodeEnv: "production" });
		const res = await app.request("/healthz");
		expect(res.status).toBe(200);

		const csp = res.headers.get("content-security-policy");
		expect(csp).toBeTruthy();
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("connect-src 'self' https://api.sentry.io");

		expect(res.headers.get("strict-transport-security")).toBe(
			"max-age=31536000; includeSubDomains",
		);
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
		expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");

		const pp = res.headers.get("permissions-policy");
		expect(pp).toContain("camera=()");
		expect(pp).toContain("microphone=()");
		expect(pp).toContain("geolocation=()");
	});

	it("allows 'unsafe-inline' in style-src in development", async () => {
		const app = buildApp({ nodeEnv: "development" });
		const res = await app.request("/healthz");
		const csp = res.headers.get("content-security-policy") || "";
		expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
	});

	it("does NOT allow 'unsafe-inline' in style-src in production", async () => {
		const app = buildApp({ nodeEnv: "production" });
		const res = await app.request("/healthz");
		const csp = res.headers.get("content-security-policy") || "";
		expect(csp).not.toContain("'unsafe-inline'");
		expect(csp).toMatch(/style-src [^;]*'self'/);
	});

	it("adds R2_PUBLIC_BASE_URL origin to img-src when configured", async () => {
		const app = buildApp({
			nodeEnv: "production",
			r2PublicBaseUrl: "https://cdn.example.com/path/ignored",
		});
		const res = await app.request("/healthz");
		const csp = res.headers.get("content-security-policy") || "";
		expect(csp).toMatch(/img-src [^;]*https:\/\/cdn\.example\.com/);
	});
});
