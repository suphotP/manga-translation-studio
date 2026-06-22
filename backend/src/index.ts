// Manga Editor Web — Backend API (Hono + Bun)
// Production-grade entry point with middleware stack

import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { serve } from "@hono/node-server";
import { createAccountRouter } from "./routes/account.js";
import { admin } from "./routes/admin.js";
import { ai } from "./routes/ai.js";
import { assets } from "./routes/assets.js";
import { auth } from "./routes/auth.js";
import { billing } from "./routes/billing.js";
import { billingDodo } from "./routes/billing-dodo.js";
import { dodoWebhooks } from "./routes/webhooks-dodo.js";
import { glossary } from "./routes/glossary.js";
import { adminCron } from "./routes/admin-cron.js";
import { cleanedImportRoutes, exportRoutes } from "./routes/export.js";
import { consent } from "./routes/consent.js";
import { credits } from "./routes/credits.js";
import { coupons } from "./routes/coupons.js";
import { contacts } from "./routes/contacts.js";
import { crops } from "./routes/crops.js";
import { images } from "./routes/images.js";
import { locks } from "./routes/locks.js";
import { notifications } from "./routes/notifications.js";
import { performance } from "./routes/performance.js";
import { presence } from "./routes/presence.js";
import { project } from "./routes/project.js";
import { quota } from "./routes/quota.js";
import { tm } from "./routes/translation-memory.js";
import { realtime } from "./routes/realtime.js";
import { usage } from "./routes/usage.js";
import { workStates } from "./routes/work-states.js";
import { workspaces } from "./routes/workspaces.js";
import { storage } from "./routes/storage.js";
import { textQa } from "./routes/text-qa.js";
import { supportTickets } from "./routes/support-tickets.js";
import { jobQueue } from "./services/queue.js";
import { bootstrapPlatformOwner } from "./services/auth-users.js";
import { AiJobSubmissionError } from "./services/ai-job-submission.js";
import { isHttpishError } from "./utils/http-error.js";
import { processAiJob, registerAiJobCancelCleanup } from "./services/ai-router.js";
import { startExportQueueProcessor } from "./services/export-pipeline.js";
import { serverConfig, PROJECTS_DIR, assertTurnstileConfigured } from "./config.js";
import { blockUnverifiedMutations, optionalAuth } from "./middleware/auth.middleware.js";
import { createSharedRateLimitStore, layeredRateLimit } from "./middleware/rate-limit.js";
import { RequestBodyLimitError, csrfGuard, originGuard, parseAllowedOrigins, protectedApiAuthGuard, requestSizeGuard } from "./middleware/security-guards.js";
import { requestLogger } from "./middleware/request-logger.js";
import { getMetrics, metricsMiddleware, rateLimitRejections, rateLimitStoreErrors } from "./middleware/metrics.js";
import { initSentry, sentryMiddleware, captureException, Sentry } from "./middleware/sentry.js";
import { buildSecureHeadersOptions } from "./middleware/secure-headers-config.js";
import { metricsAuth } from "./middleware/metrics-auth.js";
import { performHealthChecks } from "./services/monitoring.js";
import { notify } from "./services/notification-dispatch.js";
import { mkdirSync } from "fs";

// Initialize Sentry as the very first step so any subsequent boot-time error
// is captured. No-op when SENTRY_DSN is unset.
initSentry();

// ── Process-level last-resort handlers ───────────────────────────
// Without these, an unhandled promise rejection KILLS the process on Node >=15
// (we run under @hono/node-server's serve(), i.e. Node), and the only existing
// net is Sentry's onUnhandledRejection/onUncaughtException integrations — which
// register ONLY when SENTRY_DSN is set. Fire-and-forget `void <promise>` patterns
// exist across the codebase, so a single un-awaited rejection (e.g. a background
// export-job write throwing) would otherwise take down the whole API. Register
// these UNCONDITIONALLY (independent of SENTRY_DSN) and idempotently so a test
// re-import (or any second import of this module) does not stack duplicate
// handlers. captureException() already no-ops to a console.error when Sentry is
// not initialized, so the Sentry report is a no-op until a DSN is configured.
function registerProcessGuards(): void {
	const g = globalThis as { __mangaProcessGuardsRegistered?: boolean };
	if (g.__mangaProcessGuardsRegistered) return;
	g.__mangaProcessGuardsRegistered = true;

	// unhandledRejection: log loudly + report, but DO NOT exit. A stray rejection
	// from a best-effort background task should never take the API down — the
	// request pipeline and queue are still healthy. Matches Sentry's "warn" mode.
	process.on("unhandledRejection", (reason: unknown) => {
		const err = reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
		console.error("[Process] Unhandled promise rejection (process kept alive):", err);
		captureException(err, { kind: "unhandledRejection" });
	});

	// uncaughtException: by Node's guidance the process is in an undefined state
	// after an uncaught synchronous throw, so the safe move is to log + flush
	// telemetry + exit non-zero and let the supervisor restart us cleanly. This
	// service runs under Docker with a restart policy (see Dockerfile.api /
	// docker-compose), so `process.exit(1)` here yields a fresh, known-good
	// process rather than limping along in a corrupt state. We flush Sentry
	// first (best-effort, time-boxed) so the crash report is not lost on exit.
	process.on("uncaughtException", (err: Error) => {
		console.error("[Process] Uncaught exception — flushing telemetry and exiting (supervisor will restart):", err);
		captureException(err, { kind: "uncaughtException" });
		Sentry.flush(2000).catch(() => undefined).finally(() => {
			process.exit(1);
		});
	});
}

registerProcessGuards();

// Ensure data directories exist
mkdirSync(PROJECTS_DIR, { recursive: true });

const app = new Hono();

// GDPR data-export router, wired with a `notifyExportReady` dep so a finished
// export actually delivers a "ready" in-app + email notice (per the user's
// prefs) carrying the time-limited signed download link — instead of the
// previous deps-less `createAccountRouter()` whose `if (deps.notifyExportReady)`
// guard was always false, forcing the user to manually poll the export history.
// notify() is best-effort and swallows its own errors, so a notification hiccup
// never affects the export job's terminal "ready" state.
const account = createAccountRouter({
	notifyExportReady: async ({ userId, jobId, downloadUrl, expiresAt }) => {
		await notify({
			userId,
			type: "account_export_ready",
			title: "Your data export is ready",
			body: "Your account data export has finished. Use the secure link to download it before it expires.",
			// Relative path; the email template prefixes it with the mailer app-URL
			// base, and the in-app deep-link is served from the same origin.
			linkUrl: downloadUrl,
			metadata: { jobId, expiresAt },
		});
	},
});

const rateLimitStore = createSharedRateLimitStore();
const allowedCorsOrigins = parseAllowedOrigins(serverConfig.allowedOrigins);

// ── Middleware Stack ──────────────────────────────────────────
// 0. Secure response headers (CSP / HSTS / X-Frame / X-Content-Type / Referrer /
//    Permissions-Policy). Runs first so EVERY response — including errors and
//    health endpoints — carries the baseline security headers.
app.use("*", secureHeaders(buildSecureHeadersOptions({
	nodeEnv: process.env.NODE_ENV,
	r2PublicBaseUrl: serverConfig.r2.publicBaseUrl,
	cspReportUri: serverConfig.cspReportUri,
})));

// 0b. Sentry request tracing + error capture. Runs before any business logic so
//     thrown errors downstream are captured with request context.
app.use("*", sentryMiddleware());

// 1. CORS — configurable origins
app.use("*", cors({ origin: allowedCorsOrigins.length <= 1 ? (allowedCorsOrigins[0] ?? serverConfig.allowedOrigins) : allowedCorsOrigins }));

// 1b. Trailing-slash tolerance for the export API. `app.route("/api/export", …)`
//     + `exportRoutes.post("/", …)` matches `POST /api/export` but NOT
//     `POST /api/export/` (Hono treats the trailing slash as a distinct, unrouted
//     path → 404). External callers / proxies that append a slash should not 404,
//     so normalize the path by re-dispatching the SAME request (method + body +
//     headers preserved — no redirect that would drop a POST body) on the trimmed
//     path. Scoped to /api/export/* and placed before logging/rate-limit so the
//     effective request runs the rest of the pipeline exactly once.
app.use("/api/export/*", async (c, next) => {
	const url = new URL(c.req.url);
	if (url.pathname.length > "/api/export".length && url.pathname.endsWith("/")) {
		const trimmed = url.pathname.replace(/\/+$/, "");
		return app.fetch(new Request(url.origin + trimmed + url.search, c.req.raw), c.env);
	}
	await next();
});

// 2. Request logging
app.use("*", requestLogger);
app.use("*", metricsMiddleware());

// 3. Attach optional auth early so user-scoped rate limits are real, while routes still own access control.
app.use("/api/*", optionalAuth);

// 4. Layered API rate limiting for cheap reads, writes, uploads, exports, and AI submits.
app.use("/api/*", layeredRateLimit({
	store: rateLimitStore,
	onLimitExceeded: (decision) => {
		rateLimitRejections.inc({ policy: decision.policy.id });
	},
	onStoreError: (error, context) => {
		const message = error instanceof Error ? error.message : String(error);
		rateLimitStoreErrors.inc({ policy: context.policy.id });
		console.warn(`[RateLimit] ${context.policy.id} store error; applying ${context.policy.failureMode ?? "fallback"} mode: ${message}`);
	},
}));

// 5. Browser/API abuse guards. Auth is configurable for local prototype compatibility,
// but production can require authenticated mutation routes without touching route code.
app.use("/api/*", requestSizeGuard());
app.use("/api/*", originGuard());
app.use("/api/*", csrfGuard());
app.use("/api/*", protectedApiAuthGuard());
// Verify WALL: after auth is resolved, an authenticated-but-unverified user may read but
// cannot mutate anything outside the verify/recover/abandon allowlist. Mounted AFTER
// protectedApiAuthGuard so auth (401) is decided before verification (403), and after
// optionalAuth so the context user (with its emailVerified flag) is populated.
app.use("/api/*", blockUnverifiedMutations);

// ── Global Error Handler ─────────────────────────────────────
// Typed-error mapping (replaces the old substring heuristic). Exported so it can
// be exercised directly in tests without standing up the full middleware stack.
export function globalErrorHandler(err: Error, c: Context): Response {
	// Always log the REAL error server-side (full object + method/path for
	// correlation). The client-facing body below never leaks an internal message.
	console.error(`[ERROR] ${c.req.method} ${c.req.path}:`, err);

	// Oversized request bodies surface as a typed 413 with their limit.
	if (err instanceof RequestBodyLimitError) {
		return c.json({
			error: "Request body too large",
			code: "request_body_too_large",
			limitBytes: err.limitBytes,
		}, 413);
	}

	// AI job submission failures carry a pre-built `{ error, code, … }` body plus
	// an explicit status and optional Retry-After. Routes catch this locally, but
	// the handler mirrors that rendering for any instance that escapes.
	if (err instanceof AiJobSubmissionError) {
		if (err.retryAfter) c.header("Retry-After", String(err.retryAfter));
		return c.json(err.body, err.status as ContentfulStatusCode);
	}

	// Hono's own HTTPException renders via its prepared response/status.
	if (err instanceof HTTPException) {
		return err.getResponse();
	}

	// Typed, client-facing errors (WorkspaceAccessError, ByoApiError,
	// DodoBillingError, the generic HttpError, …) opt into the HTTP-ish contract
	// and carry an explicit status + stable code. Render exactly those — message
	// is intentional and code lets the frontend localize/branch.
	if (isHttpishError(err)) {
		return c.json({ error: err.message, code: err.code }, err.status as ContentfulStatusCode);
	}

	// Everything else is an unexpected server error: GENERIC body, NO leaked
	// message, no status inferred from message substrings.
	return c.json({ error: "Internal server error", code: "internal_error" }, 500);
}

app.onError(globalErrorHandler);

// ── Routes ───────────────────────────────────────────────────
app.route("/api/ai", ai);
app.route("/api/auth", auth);
app.route("/api/assets", assets);
app.route("/api/project", project);
app.route("/api/images", images);
app.route("/api/locks", locks);
app.route("/api/quota", quota);
app.route("/api/usage", usage);
app.route("/api/work-states", workStates);
app.route("/api/tm", tm);
app.route("/api/workspaces", workspaces);
app.route("/api/storage", storage);
// The Dodo webhook MUST be mounted before the authenticated `billing` router.
// `billing` applies `authMiddleware` to all `/api/billing/*` requests, so an
// unauthenticated POST from Dodo to `/api/billing/dodo/webhook` would be
// rejected with 401 before the signature-verified webhook handler runs.
// Registering `dodoWebhooks` first lets the public, signature-verified route
// match first and keeps the rest of `/api/billing` behind auth.
app.route("/api/billing", dodoWebhooks);
app.route("/api/billing", billing);
app.route("/api/billing", billingDodo);
app.route("/api/glossary", glossary);
app.route("/api/admin/cron", adminCron);
app.route("/api/export", exportRoutes);
app.route("/api/import", cleanedImportRoutes);
app.route("/api/account", account);
app.route("/api/consent", consent);
app.route("/api/admin", admin);
app.route("/api/notifications", notifications);
app.route("/api/contacts", contacts);
app.route("/api/credits", credits);
app.route("/api/coupons", coupons);
app.route("/api/crops", crops);
app.route("/api/text-qa", textQa);
app.route("/api/support", supportTickets);
app.route("/api/perf", performance);
app.route("/api/realtime", realtime);
app.route("/api/presence", presence);

async function getReadinessPayload() {
	const readiness = await performHealthChecks();
	if (jobQueue.isDraining()) {
		readiness.checks.queue_drain = {
			healthy: false,
			message: `Draining ${jobQueue.activeCount()} active AI job(s)`,
		};
		readiness.healthy = false;
	}
	return readiness;
}

// Health check
app.get("/api/health", (c) => c.json({
	ok: true,
	version: "0.1.0",
	uptime: process.uptime(),
}));

app.get("/api/readyz", async (c) => {
	const readiness = await getReadinessPayload();
	return c.json(readiness, readiness.healthy ? 200 : 503);
});

app.get("/healthz", (c) => c.json({
	ok: true,
	version: "0.1.0",
	uptime: process.uptime(),
}));

app.get("/readyz", async (c) => {
	const readiness = await getReadinessPayload();
	return c.json(readiness, readiness.healthy ? 200 : 503);
});

app.get(
	"/metrics",
	metricsAuth({
		user: serverConfig.metricsBasicAuthUser,
		pass: serverConfig.metricsBasicAuthPass,
	}),
	async () => {
		return new Response(await getMetrics(), {
			headers: { "Content-Type": "text/plain; version=0.0.4" },
		});
	},
);

export { app };

// Register the provider processor only for the real API process.
// Route tests import the Hono app directly and must not consume worker accounts.
if (import.meta.main) {
	// Secure-by-default bot gate: refuse to serve auth in production unless Turnstile is
	// properly configured (or explicitly disabled). FIRST thing in the bootstrap — before
	// queues/processors start — so a security-config failure is side-effect-free. Scoped to
	// THIS auth-serving process; non-HTTP workers/scripts that import config are unaffected.
	assertTurnstileConfigured(serverConfig.turnstile);

	// Platform-owner bootstrap: promote ADMIN_BOOTSTRAP_EMAIL to `owner` so the FIRST
	// admin can reach /admin (the back-office is otherwise unreachable — see
	// bootstrapPlatformOwner). Idempotent + best-effort; never blocks the listener.
	await bootstrapPlatformOwner();
	// Boot-degraded, not boot-blocked (issue #4 RT-1): a transient Redis/queue blip
	// must NOT stop the HTTP listener from binding — otherwise the Docker healthcheck
	// burns its retries and the deploy rolls back over a momentary flap. /readyz still
	// reports unready so the LB pulls this node, and the queue auto-recovers once Redis
	// returns (ready()'s promise resets on rejection — see queue.ts).
	try {
		await jobQueue.ready();
	} catch (error) {
		console.error("[Backend] Job queue not ready at boot; starting degraded:", error);
	}
	if (serverConfig.aiQueueProcessorEnabled) {
		registerAiJobCancelCleanup(jobQueue);
		jobQueue.onProcess(processAiJob, { pollIntervalMs: serverConfig.aiQueueProcessorPollIntervalMs });
		console.log(`[Backend] AI queue processor enabled (poll ${serverConfig.aiQueueProcessorPollIntervalMs}ms)`);
	} else {
		console.log("[Backend] AI queue processor disabled; use `bun run queue:worker` to process Redis jobs");
	}

	// Drain enqueued export jobs in-process so an API-only deployment advances them
	// queued -> done without a separate runner. Disable with
	// EXPORT_QUEUE_PROCESSOR_ENABLED=false to run an external drainer instead.
	let stopExportProcessor: (() => void) | undefined;
	if (serverConfig.exportQueueProcessorEnabled) {
		stopExportProcessor = startExportQueueProcessor({ pollIntervalMs: serverConfig.exportQueueProcessorPollIntervalMs });
		console.log(`[Backend] Export queue processor enabled (poll ${serverConfig.exportQueueProcessorPollIntervalMs}ms)`);
	} else {
		console.log("[Backend] Export queue processor disabled; advance export jobs with an external runDueExportJobs runner");
	}

	// ── Start Server ─────────────────────────────────────────────
	const { port, host } = serverConfig;
	console.log(`[Backend] Starting on http://${host}:${port}`);
	console.log(`[Backend] Data dir: ${PROJECTS_DIR}`);
	const server = serve({ fetch: app.fetch, port, hostname: host });

	let shutdownStarted = false;
	async function gracefulShutdown(signal: string): Promise<void> {
		if (shutdownStarted) return;
		shutdownStarted = true;
		const timeoutMs = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "30000", 10);
		console.log(`[Backend] ${signal} received. Draining queue for up to ${timeoutMs}ms`);
		jobQueue.pause();
		stopExportProcessor?.();
		server.close();
		const idle = await jobQueue.waitForIdle(timeoutMs);
		jobQueue.stopProcessing();
		if (!idle) {
			// W4.9: hand in-flight jobs back to the queue (re-claimable, checkpoint
			// preserved) so a peer/replacement process resumes them immediately on a
			// rolling deploy instead of waiting out the lease TTL.
			try {
				const reclaimed = await jobQueue.releaseActiveLeasesForShutdown();
				console.warn(`[Backend] Shutdown timeout with ${reclaimed.length} active AI job(s); marked re-claimable for resume: ${reclaimed.join(", ") || "none"}`);
			} catch (error) {
				console.error(`[Backend] Failed to release active leases on shutdown: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			console.log("[Backend] Queue drained. Shutdown complete.");
		}
		process.exit(0);
	}

	process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
	process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));

	setTimeout(async () => {
		try {
			const resp = await fetch(`${serverConfig.workerUrl}/health`);
			console.log(`[Backend] Worker: ${JSON.stringify(await resp.json())}`);
		} catch {
			console.warn(`[Backend] Worker at ${serverConfig.workerUrl} not responding`);
		}
	}, 2000);
}
