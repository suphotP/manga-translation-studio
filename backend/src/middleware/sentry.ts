// Sentry error tracking integration for Bun + Hono
// Captures unhandled errors, promise rejections, and request context

import type { Context, Next } from "hono";
import * as Sentry from "@sentry/bun";

// ── Sentry Initialization ───────────────────────────────────────

interface SentryConfig {
	dsn: string;
	environment: string;
	tracesSampleRate: number;
	profilesSampleRate?: number;
	release?: string;
}

let isInitialized = false;

// Query params whose values are credentials and must never reach observability.
// The realtime SSE endpoint authenticates via ?token=... (EventSource cannot set
// an Authorization header), and that short-lived token grants workspace event
// access until it expires — so it must be scrubbed from any URL/query we record.
const SENSITIVE_QUERY_KEYS = new Set(["token", "access_token", "accessToken", "sse_token", "lastEventId"]);
const REDACTED = "[redacted]";

/** Strip sensitive query-param values from a full URL before it is recorded. */
export function redactSensitiveUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		let mutated = false;
		for (const key of url.searchParams.keys()) {
			if (SENSITIVE_QUERY_KEYS.has(key)) {
				url.searchParams.set(key, REDACTED);
				mutated = true;
			}
		}
		return mutated ? url.toString() : rawUrl;
	} catch {
		// Not a parseable absolute URL — fall back to a coarse regex redaction so a
		// relative path or malformed URL still gets its token stripped.
		return rawUrl.replace(/([?&](?:token|access_token|accessToken|sse_token)=)[^&#]*/gi, `$1${REDACTED}`);
	}
}

/** Return a shallow copy of a query map with sensitive values redacted. */
export function redactSensitiveQuery(query: Record<string, string>): Record<string, string> {
	let mutated = false;
	const safe: Record<string, string> = {};
	for (const [key, value] of Object.entries(query)) {
		if (SENSITIVE_QUERY_KEYS.has(key)) {
			safe[key] = REDACTED;
			mutated = true;
		} else {
			safe[key] = value;
		}
	}
	return mutated ? safe : query;
}

// Request headers that carry credentials and must be stripped before recording.
const SENSITIVE_HEADER_KEYS = new Set(["authorization", "cookie", "x-api-key", "x-realtime-token"]);

/** Return a shallow copy of a header map with credential headers removed. */
export function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
	const safe: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) safe[key] = value;
	}
	return safe;
}

type BunOptionsWithProfiling = Sentry.BunOptions & {
	profilesSampleRate?: number;
};

/**
 * Resolve the Sentry release tag used for release tracking / "introduced in"
 * regression markers. Precedence: explicit override → SENTRY_RELEASE (set by CI
 * to the deployed git SHA) → GIT_SHA → package version → sentinel. Pure +
 * env-injectable so the precedence is unit-testable.
 */
export function resolveSentryRelease(
	override?: string,
	env: Record<string, string | undefined> = process.env,
): string {
	return (
		override?.trim()
		|| env.SENTRY_RELEASE?.trim()
		|| env.GIT_SHA?.trim()
		|| env.npm_package_version?.trim()
		|| "0.1.0"
	);
}

function readSampleRate(value: string | undefined, fallback: number): number {
	if (!value) return fallback;

	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		return fallback;
	}

	return parsed;
}

export function initSentry(config?: Partial<SentryConfig>) {
	if (isInitialized) return;

	const dsn = config?.dsn || process.env.SENTRY_DSN;
	if (!dsn) {
		console.warn("[Sentry] No DSN provided, error tracking disabled");
		return;
	}

	const tracesSampleRate = config?.tracesSampleRate ?? readSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1);
	const profilesSampleRate = config?.profilesSampleRate ?? readSampleRate(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0.1);
	const sentryOptions: BunOptionsWithProfiling = {
		dsn,
		environment: config?.environment || process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
		tracesSampleRate,
		profilesSampleRate,

		integrations: [
			Sentry.onUncaughtExceptionIntegration({
				exitEvenIfOtherHandlersAreRegistered: false,
			}),
			Sentry.onUnhandledRejectionIntegration({
				mode: "warn",
			}),
			Sentry.captureConsoleIntegration({
				levels: ["error", "warn"],
			}),
			Sentry.httpIntegration(),
			Sentry.linkedErrorsIntegration(),
			Sentry.requestDataIntegration(),
			Sentry.nodeContextIntegration(),
		],

		// Filter sensitive data
		beforeSend(event, hint) {
			// Remove request bodies for sensitive endpoints
			if (event.request?.data) {
				const url = event.request.url || "";
				if (url.includes("/admin/config")) {
					delete event.request.data;
				}
			}

			// Redact credential query params (e.g. the SSE ?token=) from any URL or
			// query string the SDK auto-captures, so short-lived workspace tokens
			// never land in observability.
			if (event.request?.url) {
				event.request.url = redactSensitiveUrl(event.request.url);
			}
			if (typeof event.request?.query_string === "string") {
				event.request.query_string = redactSensitiveUrl(`?${event.request.query_string}`).replace(/^\?/, "");
			} else if (event.request?.query_string && typeof event.request.query_string === "object") {
				event.request.query_string = redactSensitiveQuery(event.request.query_string as Record<string, string>);
			}

			// Sanitize headers. The SDK captures headers with their ORIGINAL casing
			// (e.g. `X-Realtime-Token`, `Authorization`), so exact lowercase deletes
			// would miss them and leak the short-lived realtime token. Use the
			// case-insensitive helper to strip every credential header regardless of
			// casing.
			if (event.request?.headers) {
				event.request.headers = redactSensitiveHeaders(
					event.request.headers as Record<string, string>,
				);
			}

			// Add custom context for AI errors
			const exception = hint.originalException;
			if (exception instanceof Error) {
				if (exception.message.includes("AI") || exception.message.includes("translation")) {
					event.tags = { ...event.tags, error_domain: "ai_processing" };
				}
				if (exception.message.includes("image") || exception.message.includes("upload")) {
					event.tags = { ...event.tags, error_domain: "image_processing" };
				}
			}

			return event;
		},

		// Release tracking. Prefer an explicit SENTRY_RELEASE (CI sets this to the
		// deployed git SHA / image tag so Sentry attributes errors + regressions to
		// a release and surfaces "introduced in" markers), then GIT_SHA, the package
		// version, and finally a sentinel. See resolveSentryRelease.
		release: resolveSentryRelease(config?.release),
	};

	Sentry.init(sentryOptions);

	isInitialized = true;
	console.log("[Sentry] Error tracking initialized");
}

// ── Middleware ───────────────────────────────────────────────────

export function sentryMiddleware() {
	return async (c: Context, next: Next) => {
		const route = c.req.routePath || c.req.path;
		const spanName = `${c.req.method} ${route}`;
		// Scrub credential query params (e.g. the SSE ?token=) before any of these
		// land in spans/scope/extras — the global request-data integration would
		// otherwise leak the short-lived workspace token to observability.
		const safeUrl = redactSensitiveUrl(c.req.url);

		return Sentry.startSpan({
			op: "http.server",
			name: spanName,
			forceTransaction: true,
			attributes: {
				"http.request.method": c.req.method,
				"http.route": route,
				"url.full": safeUrl,
			},
		}, async (span) => Sentry.withScope(async (scope) => {
			scope.setTag("http.method", c.req.method);
			scope.setTag("http.route", route);
			scope.setContext("http", {
				method: c.req.method,
				url: safeUrl,
				headers: redactSensitiveHeaders(c.req.header()),
			});

			try {
				await next();
				Sentry.setHttpStatus(span, c.res.status);
			} catch (error) {
				Sentry.setHttpStatus(span, c.res.status || 500);
				scope.setExtras({
					request_body: c.req.raw.body,
					query_params: redactSensitiveQuery(c.req.query()),
				});
				scope.setTag("status_code", String(c.res.status || 500));

				Sentry.captureException(error);
				throw error;
			}
		}));
	};
}

// ── Custom Error Reporting ───────────────────────────────────────

export function captureMessage(message: string, level: "info" | "warning" | "error" = "info") {
	if (!isInitialized) return;
	Sentry.captureMessage(message, { level });
}

export function captureException(error: Error, context?: Record<string, any>) {
	if (!isInitialized) {
		console.error("[Error]", error);
		return;
	}

	Sentry.withScope((scope) => {
		if (context) {
			Object.entries(context).forEach(([key, value]) => {
				scope.setExtra(key, value);
			});
		}
		Sentry.captureException(error);
	});
}

// ── Business Error Tracking ───────────────────────────────────────

export function trackAiJobError(jobId: string, error: string, context?: {
	projectId?: string;
	imageId?: string;
	lang?: string;
}) {
	if (!isInitialized) return;

	Sentry.withScope((scope) => {
		scope.setTag("error_type", "ai_job_failure");
		scope.setContext("ai_job", {
			jobId,
			error,
			...context,
		});
		Sentry.captureMessage(`AI job failed: ${error}`, "error");
	});
}

export function trackImageUploadError(filename: string, error: string) {
	if (!isInitialized) return;

	Sentry.withScope((scope) => {
		scope.setTag("error_type", "image_upload_failure");
		scope.setContext("upload", { filename, error });
		Sentry.captureMessage(`Image upload failed: ${error}`, "error");
	});
}

export { Sentry };
