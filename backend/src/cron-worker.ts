// Wave 2 W2.4 — standalone cron-worker process.
//
// Boots independently from the API server so scheduled jobs do not contend
// with request traffic and so multi-replica deployments can run the cron
// container exactly once while keeping >1 API replica. Each job inside the
// scheduler still guards itself with a pg advisory lock, so even running
// multiple cron-worker replicas is safe (the second replica logs and skips).
//
// Mirrors backend/src/queue-worker.ts in shape so ops can observe a uniform
// "extra background process" pattern.

async function main(): Promise<void> {
	process.env.PROCESS_ROLE ||= "cron-worker";

	// Initialize Sentry before any other module loads so worker-side init
	// failures (config, scheduler boot) are captured. No-op without SENTRY_DSN.
	const { initSentry } = await import("./middleware/sentry.js");
	initSentry();

	const [{ serverConfig }, { CronScheduler, isSchedulerEnabled }] = await Promise.all([
		import("./config.js"),
		import("./services/cron-scheduler.js"),
	]);

	if (!isSchedulerEnabled()) {
		console.log("[Cron Worker] SCHEDULER_ENABLED is false; exiting without starting scheduler");
		return;
	}

	const scheduler = new CronScheduler({
		config: {
			auditRetentionDays: serverConfig.auditRetentionDays,
			draftExportTtlHours: serverConfig.draftExportTtlHours,
			gdprErasureGraceDays: serverConfig.gdprErasureGraceDays,
			usageLedgerStore: serverConfig.usageLedgerStore,
		},
	});
	await scheduler.initialize();
	const pollIntervalMs = serverConfig.schedulerPollIntervalMs;
	scheduler.start({ pollIntervalMs });

	console.log(`[Cron Worker] Started; polling for due jobs every ${pollIntervalMs}ms`);

	let shutdownStarted = false;
	async function gracefulShutdown(signal: string): Promise<void> {
		if (shutdownStarted) return;
		shutdownStarted = true;
		console.log(`[Cron Worker] ${signal} received. Stopping scheduler`);
		try {
			await scheduler.close();
		} catch (error) {
			console.warn(`[Cron Worker] Shutdown error: ${error instanceof Error ? error.message : String(error)}`);
		}
		console.log("[Cron Worker] Shutdown complete.");
		process.exit(0);
	}

	process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
	process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(`[Cron Worker] Fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
