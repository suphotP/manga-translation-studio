// Prometheus metrics middleware for Hono
// Tracks HTTP requests, response times, status codes, and custom business metrics

import type { Context, Next } from "hono";
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

// ── Prometheus Registry ──────────────────────────────────────────
const register = new Registry();

// Collect default metrics (CPU, memory, event loop lag)
collectDefaultMetrics({ register });

// ── HTTP Metrics ─────────────────────────────────────────────────

// Request counter by method, route, and status code
export const httpRequestCounter = new Counter({
	name: "http_requests_total",
	help: "Total number of HTTP requests",
	labelNames: ["method", "route", "status_code"],
	registers: [register],
});

// Request duration histogram
export const httpRequestDuration = new Histogram({
	name: "http_request_duration_seconds",
	help: "Duration of HTTP requests in seconds",
	labelNames: ["method", "route", "status_code"],
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
	registers: [register],
});

// Active requests gauge
export const httpActiveRequests = new Gauge({
	name: "http_active_requests",
	help: "Number of active HTTP requests",
	registers: [register],
});

// ── Business Metrics ─────────────────────────────────────────────

// AI job queue metrics
export const aiJobQueueSize = new Gauge({
	name: "ai_job_queue_size",
	help: "Current number of jobs in the queue",
	labelNames: ["status"],
	registers: [register],
});

export const aiJobDuration = new Histogram({
	name: "ai_job_duration_seconds",
	help: "Duration of AI job processing",
	labelNames: ["status"],
	buckets: [1, 5, 10, 30, 60, 120, 300],
	registers: [register],
});

export const aiJobErrors = new Counter({
	name: "ai_job_errors_total",
	help: "Total number of failed AI jobs",
	labelNames: ["error_type"],
	registers: [register],
});

export const aiQueueAdmissionRejections = new Counter({
	name: "ai_queue_admission_rejections_total",
	help: "Total number of AI job submissions rejected by queue admission controls",
	labelNames: ["reason"],
	registers: [register],
});

export const usageQuotaRejections = new Counter({
	name: "usage_quota_rejections_total",
	help: "Total number of requests rejected by workspace plan or usage quota controls",
	labelNames: ["reason"],
	registers: [register],
});

// ── AI support-agent cost / anti-abuse guardrails ────────────────
// These track every guardrail trip in front of the gpt-5.5 support agent so an
// operator can alert on spend abuse without reading logs. The kill-switch gauge
// is 1 while the agent is hard-disabled (budget over OR operator kill-switch).

export const aiSupportBudgetRejections = new Counter({
	name: "ai_support_budget_rejections_total",
	help: "Support tickets routed to the human queue because the global monthly AI budget was exhausted",
	registers: [register],
});

export const aiSupportHandoffs = new Counter({
	name: "ai_support_handoff_total",
	help: "Support tickets handed off to a human queue instead of the AI agent, by reason",
	labelNames: ["reason"],
	registers: [register],
});

export const aiSupportSpamRejections = new Counter({
	name: "ai_support_spam_rejections_total",
	help: "Support messages rejected/coalesced by spam pre-checks (dup, gibberish, disposable email)",
	labelNames: ["reason"],
	registers: [register],
});

export const aiSupportKillSwitchActive = new Gauge({
	name: "ai_support_kill_switch_active",
	help: "1 when the AI support agent is hard-disabled (operator kill-switch or budget exhausted), else 0",
	registers: [register],
});

// ── AI-support OWNER-OPS deterministic money-decision metrics ───────────────────
export const supportOwnerAutoGrants = new Counter({
	name: "support_owner_auto_grants_total",
	help: "Support credit grants AUTO-approved+executed by the deterministic gate (exact verified discrepancy within caps)",
	registers: [register],
});

export const supportOwnerReviews = new Counter({
	name: "support_owner_reviews_total",
	help: "Support proposals routed to the OWNER for a one-tap decision instead of auto-executing, by reason",
	labelNames: ["reason"],
	registers: [register],
});

export const supportOwnerCircuitTripped = new Gauge({
	name: "support_owner_circuit_tripped",
	help: "1 when the support auto-grant circuit-breaker is tripped (all grants forced to owner review), else 0",
	registers: [register],
});

// Image upload metrics
export const imageUploadSize = new Histogram({
	name: "image_upload_size_bytes",
	help: "Size of uploaded images in bytes",
	buckets: [1024, 10240, 102400, 1048576, 10485760, 52428800],
	registers: [register],
});

export const imageUploadDuration = new Histogram({
	name: "image_upload_duration_seconds",
	help: "Duration of image uploads",
	buckets: [0.1, 0.5, 1, 2, 5, 10],
	registers: [register],
});

export const rateLimitRejections = new Counter({
	name: "rate_limit_rejections_total",
	help: "Total number of requests rejected by rate-limit policy",
	labelNames: ["policy"],
	registers: [register],
});

export const rateLimitStoreErrors = new Counter({
	name: "rate_limit_store_errors_total",
	help: "Total number of rate-limit store failures before policy fail-mode handling",
	labelNames: ["policy"],
	registers: [register],
});

export const securityGuardRejections = new Counter({
	name: "api_security_guard_rejections_total",
	help: "Total number of API requests rejected by auth, origin, CSRF, or request-size guards",
	labelNames: ["reason", "method"],
	registers: [register],
});

// Project metrics
export const activeProjects = new Gauge({
	name: "active_projects_total",
	help: "Number of active projects",
	registers: [register],
});

export const totalImagesProcessed = new Counter({
	name: "total_images_processed_total",
	help: "Total number of images processed",
	registers: [register],
});

// ── Middleware ───────────────────────────────────────────────────

export function metricsMiddleware() {
	return async (c: Context, next: Next) => {
		const start = Date.now();
		httpActiveRequests.inc();

		// Extract route pattern (fallback to path if no route matched)
		const route = c.req.routePath || c.req.path;

		try {
			await next();

			// Record metrics after response
			const duration = (Date.now() - start) / 1000;
			const statusCode = c.res.status.toString();

			httpRequestCounter.inc({
				method: c.req.method,
				route,
				status_code: statusCode,
			});

			httpRequestDuration.observe({
				method: c.req.method,
				route,
				status_code: statusCode,
			}, duration);
		} catch (error) {
			// Record error metrics
			const duration = (Date.now() - start) / 1000;
			const statusCode = "500";

			httpRequestCounter.inc({
				method: c.req.method,
				route,
				status_code: statusCode,
			});

			httpRequestDuration.observe({
				method: c.req.method,
				route,
				status_code: statusCode,
			}, duration);

			throw error;
		} finally {
			httpActiveRequests.dec();
		}
	};
}

// ── Metrics Endpoint ─────────────────────────────────────────────

export async function getMetrics(): Promise<string> {
	return await register.metrics();
}

// ── Export Registry for Custom Metrics ───────────────────────────

export { register };
