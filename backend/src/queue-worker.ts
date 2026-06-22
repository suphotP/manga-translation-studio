async function main(): Promise<void> {
	process.env.PROCESS_ROLE ||= "queue-worker";

	// Initialize Sentry before any other module loads so worker-side init failures
	// (config, queue connect, ai-router boot) are captured. No-op without SENTRY_DSN.
	const { initSentry } = await import("./middleware/sentry.js");
	initSentry();

	const [
		{ serverConfig },
		{ processAiJob, registerAiJobCancelCleanup },
		{ jobQueue },
	] = await Promise.all([
		import("./config.js"),
		import("./services/ai-router.js"),
		import("./services/queue.js"),
	]);

	await jobQueue.ready();
	const stats = await jobQueue.stats();
	if (stats.store !== "redis") {
		throw new Error("AI queue worker requires AI_QUEUE_STORE=redis or REDIS_URL so API and worker processes share durable queue state");
	}

	registerAiJobCancelCleanup(jobQueue);
	jobQueue.onProcess(processAiJob, {
		pollIntervalMs: serverConfig.aiQueueProcessorPollIntervalMs,
		keepPollTimerRef: true,
	});

	console.log(`[AI Queue Worker] Started with Redis queue polling every ${serverConfig.aiQueueProcessorPollIntervalMs}ms`);

	let shutdownStarted = false;
	async function gracefulShutdown(signal: string): Promise<void> {
		if (shutdownStarted) return;
		shutdownStarted = true;
		const timeoutMs = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "30000", 10);
		console.log(`[AI Queue Worker] ${signal} received. Draining queue for up to ${timeoutMs}ms`);
		jobQueue.pause();
		const idle = await jobQueue.waitForIdle(timeoutMs);
		jobQueue.stopProcessing();
		if (!idle) {
			// W4.9: drain window expired with jobs still in flight. Rather than
			// abandoning them to the lease-expiry recovery path (which can take the
			// full lease TTL), proactively mark them re-claimable so the replacement
			// worker resumes them from their last checkpoint immediately — no double
			// provider call, no double credit charge (capture only happens at `done`).
			try {
				const reclaimed = await jobQueue.releaseActiveLeasesForShutdown();
				console.warn(`[AI Queue Worker] Shutdown timeout with ${reclaimed.length} active AI job(s); marked re-claimable for resume: ${reclaimed.join(", ") || "none"}`);
			} catch (error) {
				console.error(`[AI Queue Worker] Failed to release active leases on shutdown: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			console.log("[AI Queue Worker] Queue drained. Shutdown complete.");
		}
		process.exit(0);
	}

	process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
	process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(`[AI Queue Worker] Fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
