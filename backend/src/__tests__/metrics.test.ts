// Metrics middleware tests

import { describe, it, expect, beforeEach } from "bun:test";
import { getMetrics, httpRequestCounter, httpRequestDuration, aiJobQueueSize } from "../middleware/metrics.js";

describe("Metrics Middleware", () => {
	beforeEach(() => {
		httpRequestCounter.reset();
		httpRequestDuration.reset();
		aiJobQueueSize.reset();
	});

	it("should increment HTTP request counter", async () => {
		const initialCount = await httpRequestCounter.get();
		httpRequestCounter.inc({
			method: "GET",
			route: "/api/health",
			status_code: "200",
		});

		const newCount = await httpRequestCounter.get();
		expect(newCount.values).toHaveLength(1);
	});

	it("should record HTTP request duration", async () => {
		httpRequestDuration.observe({
			method: "POST",
			route: "/api/ai/translate",
			status_code: "200",
		}, 0.5);

		const metric = await httpRequestDuration.get();
		expect(metric.values.some(value =>
			value.labels.method === "POST" &&
			value.labels.route === "/api/ai/translate" &&
			value.labels.status_code === "200"
		)).toBe(true);
	});

	it("should track AI job queue size", async () => {
		aiJobQueueSize.set({ status: "pending" }, 10);
		aiJobQueueSize.set({ status: "processing" }, 3);
		aiJobQueueSize.set({ status: "done" }, 50);
		aiJobQueueSize.set({ status: "error" }, 2);

		const metric = await aiJobQueueSize.get();
		expect(metric.values).toHaveLength(4);
	});

	it("should generate Prometheus metrics", async () => {
		httpRequestCounter.inc({
			method: "GET",
			route: "/api/health",
			status_code: "200",
		});

		const metrics = await getMetrics();
		expect(metrics).toContain("http_requests_total");
	});
});
