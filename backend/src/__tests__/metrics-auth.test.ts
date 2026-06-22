// Tests for the Basic Auth gate on /metrics.
//
// Fail-closed in production when no credentials are configured (503), permissive
// in development with a warning, and Basic-Auth enforced when credentials are
// set. Builds a minimal Hono app so we don't drag in the full backend boot.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
	__resetMetricsAuthDevWarnLatch,
	metricsAuth,
} from "../middleware/metrics-auth.js";

const METRICS_BODY = "# HELP http_requests_total Total\nhttp_requests_total 0\n";

function buildApp(opts: {
	user: string;
	pass: string;
	nodeEnv: string;
}): Hono {
	const app = new Hono();
	app.get(
		"/metrics",
		metricsAuth({ user: opts.user, pass: opts.pass, nodeEnv: opts.nodeEnv }),
		() =>
			new Response(METRICS_BODY, {
				headers: { "Content-Type": "text/plain; version=0.0.4" },
			}),
	);
	return app;
}

function basicAuthHeader(user: string, pass: string): string {
	return `Basic ${btoa(`${user}:${pass}`)}`;
}

describe("metrics-auth", () => {
	beforeEach(() => {
		__resetMetricsAuthDevWarnLatch();
	});

	let originalWarn: typeof console.warn;
	beforeEach(() => {
		originalWarn = console.warn;
		console.warn = () => {};
	});
	afterEach(() => {
		console.warn = originalWarn;
	});

	it("returns 503 in production when both creds are unset", async () => {
		const app = buildApp({ user: "", pass: "", nodeEnv: "production" });
		const res = await app.request("/metrics");
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body).toEqual({ error: "metrics_disabled_no_credentials" });
	});

	it("returns 200 in development when both creds are unset", async () => {
		const app = buildApp({ user: "", pass: "", nodeEnv: "development" });
		const res = await app.request("/metrics");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("http_requests_total");
	});

	it("returns 401 with WWW-Authenticate when creds set but Authorization missing", async () => {
		const app = buildApp({ user: "ops", pass: "secret", nodeEnv: "production" });
		const res = await app.request("/metrics");
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate") || "").toMatch(/^Basic\s+realm=/i);
	});

	it("returns 200 with prom text on correct Basic Auth", async () => {
		const app = buildApp({ user: "ops", pass: "secret", nodeEnv: "production" });
		const res = await app.request("/metrics", {
			headers: { Authorization: basicAuthHeader("ops", "secret") },
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("http_requests_total");
	});

	it("returns 401 on wrong password", async () => {
		const app = buildApp({ user: "ops", pass: "secret", nodeEnv: "production" });
		const res = await app.request("/metrics", {
			headers: { Authorization: basicAuthHeader("ops", "wrong") },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate") || "").toMatch(/^Basic\s+realm=/i);
	});

	it("returns 401 on wrong username", async () => {
		const app = buildApp({ user: "ops", pass: "secret", nodeEnv: "production" });
		const res = await app.request("/metrics", {
			headers: { Authorization: basicAuthHeader("attacker", "secret") },
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 on malformed Authorization header", async () => {
		const app = buildApp({ user: "ops", pass: "secret", nodeEnv: "production" });
		const res = await app.request("/metrics", {
			headers: { Authorization: "Bearer not-basic" },
		});
		expect(res.status).toBe(401);
	});
});
