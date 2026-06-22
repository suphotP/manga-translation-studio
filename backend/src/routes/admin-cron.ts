import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { authMiddleware, requirePermission } from "../middleware/auth.middleware.js";
import { ADMIN_PERMISSIONS } from "../types/auth.js";
import type { JWTPayload } from "../types/auth.js";
import { CronScheduler, type CronRunResult, type ScheduledJobRow } from "../services/cron-scheduler.js";
import { gdprStore as defaultGdprStore, type GdprStore } from "../services/gdpr.js";

export interface CronAdminScheduler {
	listJobs(): Promise<ScheduledJobRow[]>;
	forceRun(name: string): Promise<CronRunResult | null>;
}

export interface AdminCronRouterDeps {
	scheduler?: CronAdminScheduler;
	authMiddleware?: MiddlewareHandler;
	platformAdminGuard?: MiddlewareHandler;
	/** Audit store for the force-run trail. DI seam for tests. */
	gdpr?: GdprStore;
}

const JOB_NAME_RE = /^[a-z0-9][a-z0-9-]{1,120}$/;

const SCHEDULER_UNAVAILABLE = {
	error: "Cron scheduler is not available (no database configured)",
	code: "scheduler_unavailable",
} as const;

export function createAdminCronRouter(deps: AdminCronRouterDeps = {}): Hono {
	const router = new Hono();
	let scheduler = deps.scheduler;
	const gdpr = deps.gdpr ?? defaultGdprStore;
	const platformAdminGuard = deps.platformAdminGuard ?? requirePermission(ADMIN_PERMISSIONS.CRON_WRITE);

	router.use("*", deps.authMiddleware ?? authMiddleware);
	router.use("*", platformAdminGuard);

	router.get("/jobs", async (c) => {
		const active = resolveScheduler();
		if (!active) {
			return c.json(SCHEDULER_UNAVAILABLE, 503);
		}
		const jobs = await active.listJobs();
		return c.json({ jobs });
	});

	router.post("/jobs/:name/trigger", async (c) => {
		const name = c.req.param("name");
		if (!JOB_NAME_RE.test(name)) {
			return c.json({ error: "Invalid job name", code: "invalid_job_name" }, 400);
		}
		const active = resolveScheduler();
		if (!active) {
			return c.json(SCHEDULER_UNAVAILABLE, 503);
		}
		const result = await active.forceRun(name);
		if (!result) {
			return c.json({ error: "Scheduled job not found", code: "scheduled_job_not_found" }, 404);
		}
		// Audit the REAL force-run. This is the path the admin UI actually calls
		// (the legacy admin.ts /cron/:id/trigger view is a no-op the UI never hits),
		// so the audit row must be written HERE for the trail to reflect operator
		// force-runs. Best-effort: the job already ran; a failed audit must not turn a
		// successful run into a 500.
		const admin = c.get("user") as JWTPayload | undefined;
		await gdpr.recordAdminAudit({
			adminUserId: admin?.userId ?? "unknown",
			actorRole: admin?.role,
			action: "admin.cron.force_run",
			targetKind: "cron_job",
			targetId: name,
			detail: { status: result.status, error: result.error ?? null },
		}).catch(() => { /* audit best-effort; the force-run already happened */ });
		return c.json({ result });
	});

	// Build (and memoize) the scheduler lazily. The default CronScheduler needs a
	// DATABASE_URL — when none is configured (file-mode dev / a misconfigured
	// deploy) constructing it throws. Surface that as a clean 503 ("scheduler
	// unavailable") rather than a raw 500, so the admin UI can render an honest
	// message instead of a stack-trace error. An injected scheduler (tests /
	// future file-backed scheduler) bypasses this entirely.
	function resolveScheduler(): CronAdminScheduler | null {
		if (scheduler) return scheduler;
		try {
			scheduler = new CronScheduler();
		} catch (error) {
			console.warn(
				`[admin-cron] scheduler unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
		return scheduler;
	}

	return router;
}

export const adminCron = createAdminCronRouter();
