// Basic Auth gate for the Prometheus /metrics scrape endpoint.
//
// Production posture is fail-closed: if no credentials are configured we refuse
// to serve metrics rather than silently exposing internal counters / labels.
// In development we allow the route through with a one-shot warning so local
// scrapers and `curl /metrics` keep working.

import type { Context, MiddlewareHandler, Next } from "hono";

interface MetricsAuthOptions {
	user: string;
	pass: string;
	nodeEnv?: string;
}

let devOpenWarned = false;

function timingSafeEqual(a: string, b: string): boolean {
	const bufA = new TextEncoder().encode(a);
	const bufB = new TextEncoder().encode(b);
	// Pad to equal length so length itself doesn't leak via timing.
	const len = Math.max(bufA.length, bufB.length);
	let mismatch = bufA.length ^ bufB.length;
	for (let i = 0; i < len; i++) {
		const x = i < bufA.length ? (bufA[i] ?? 0) : 0;
		const y = i < bufB.length ? (bufB[i] ?? 0) : 0;
		mismatch |= x ^ y;
	}
	return mismatch === 0;
}

function decodeBasicAuth(header: string | undefined): { user: string; pass: string } | null {
	if (!header) return null;
	const match = /^Basic\s+(.+)$/i.exec(header.trim());
	if (!match || !match[1]) return null;
	let decoded: string;
	try {
		decoded = atob(match[1]);
	} catch {
		return null;
	}
	const sep = decoded.indexOf(":");
	if (sep < 0) return null;
	return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

function unauthorized(): Response {
	return new Response(JSON.stringify({ error: "unauthorized" }), {
		status: 401,
		headers: {
			"Content-Type": "application/json",
			"WWW-Authenticate": 'Basic realm="metrics", charset="UTF-8"',
		},
	});
}

export function metricsAuth(options: MetricsAuthOptions): MiddlewareHandler {
	const { user, pass } = options;
	const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? "development";
	const hasCreds = Boolean(user) && Boolean(pass);

	return async (c: Context, next: Next) => {
		if (!hasCreds) {
			if (nodeEnv === "production") {
				return new Response(JSON.stringify({ error: "metrics_disabled_no_credentials" }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (!devOpenWarned) {
				devOpenWarned = true;
				console.warn(
					"[metrics-auth] metrics endpoint open in dev (no METRICS_BASIC_AUTH_USER / METRICS_BASIC_AUTH_PASS set)",
				);
			}
			await next();
			return;
		}

		const provided = decodeBasicAuth(c.req.header("authorization"));
		if (!provided) {
			return unauthorized();
		}
		const userOk = timingSafeEqual(provided.user, user);
		const passOk = timingSafeEqual(provided.pass, pass);
		if (!userOk || !passOk) {
			return unauthorized();
		}
		await next();
	};
}

// Test-only hook: reset the dev-open warning latch between cases.
export function __resetMetricsAuthDevWarnLatch(): void {
	devOpenWarned = false;
}
