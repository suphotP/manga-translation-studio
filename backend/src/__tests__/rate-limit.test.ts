import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { Hono, type Context } from "hono";
import { dirname } from "path";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import {
	FallbackRateLimitStore,
	MemoryRateLimitStore,
	RedisRateLimitStore,
	createDefaultRateLimitPolicies,
	layeredRateLimit,
	rateLimit,
	type RateLimitDecision,
	type RateLimitPolicy,
	type RateLimitStore,
	type RedisRateLimitClient,
} from "../middleware/rate-limit.js";
import { jobQueue } from "../services/queue.js";
import { safePath } from "../utils/security.js";

function buildApp(policies: RateLimitPolicy[], now = () => 1_700_000_000_000) {
	const app = new Hono();
	const blocked: RateLimitDecision[] = [];
	app.use("/api/*", layeredRateLimit({
		policies,
		store: new MemoryRateLimitStore(),
		now,
		onLimitExceeded: (decision) => blocked.push(decision),
	}));
	app.all("/api/*", (c) => c.json({ ok: true }));
	return { app, blocked };
}

class FakeRedisRateLimitClient implements RedisRateLimitClient {
	readonly values = new Map<string, number>();
	readonly expirations: Array<{ key: string; ttlMs: number }> = [];

	async send(command: string, args: string[]): Promise<number> {
		expect(command).toBe("EVAL");
		const key = args[2];
		const amount = Number.parseInt(args[3], 10);
		const ttlMs = Number.parseInt(args[4], 10);
		const next = (this.values.get(key) ?? 0) + amount;
		this.values.set(key, next);
		if (next === amount) {
			this.expirations.push({ key, ttlMs });
		}
		return next;
	}
}

class FailingRateLimitStore implements RateLimitStore {
	increment(): never {
		throw new Error("redis offline");
	}
}

function createRateLimitProject(projectId = crypto.randomUUID()): string {
	const statePath = safePath(PROJECTS_DIR, projectId, "state.json");
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, JSON.stringify({ id: projectId, pages: [] }));
	return projectId;
}

function nodeRequestEnv(remoteAddress: string) {
	return {
		incoming: {
			socket: {
				remoteAddress,
				remotePort: 443,
				remoteFamily: remoteAddress.includes(":") ? "IPv6" : "IPv4",
			},
		},
	};
}

describe("rate limit middleware", () => {
	test("legacy rateLimit enforces an epoch-aligned fixed window and emits retry headers", async () => {
		const app = new Hono();
		// Anchor `now` to an epoch-aligned 60s boundary so a full window remains and
		// Retry-After is the full 60s. MemoryRateLimitStore now uses the same
		// epoch-aligned fixed window as RedisRateLimitStore (window-model parity);
		// an unaligned `now` would (correctly) report only the remainder of the window.
		const epochAlignedNow = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
		app.use("/api/*", rateLimit({
			windowMs: 60_000,
			maxRequests: 2,
			store: new MemoryRateLimitStore(),
			now: () => epochAlignedNow,
		}));
		app.get("/api/health", (c) => c.json({ ok: true }));

		const first = await app.request("/api/health", { headers: { "x-forwarded-for": "203.0.113.1" } });
		const second = await app.request("/api/health", { headers: { "x-forwarded-for": "203.0.113.1" } });
		const third = await app.request("/api/health", { headers: { "x-forwarded-for": "203.0.113.1" } });

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(third.status).toBe(429);
		expect(third.headers.get("X-RateLimit-Policy")).toBe("api:legacy");
		expect(third.headers.get("Retry-After")).toBe("60");
		expect(await third.json()).toEqual(expect.objectContaining({
			code: "rate_limit_exceeded",
			policyId: "api:legacy",
		}));
	});

	test("IP scoped policies ignore spoofed proxy headers unless proxy trust is enabled", async () => {
		const previousTrust = serverConfig.trustProxyHeaders;
		(serverConfig as { trustProxyHeaders: boolean }).trustProxyHeaders = false;
		try {
			const { app } = buildApp([
				{
					id: "api:global",
					windowMs: 60_000,
					maxRequests: 1,
					scopes: ["ip"],
				},
			]);

			const first = await app.request("/api/health", {
				headers: { "x-forwarded-for": "203.0.113.10" },
			}, nodeRequestEnv("198.51.100.10"));
			const second = await app.request("/api/health", {
				headers: { "x-forwarded-for": "203.0.113.11" },
			}, nodeRequestEnv("198.51.100.10"));
			const third = await app.request("/api/health", {
				headers: { "x-forwarded-for": "203.0.113.12" },
			}, nodeRequestEnv("198.51.100.11"));

			expect(first.status).toBe(200);
			expect(second.status).toBe(429);
			expect(second.headers.get("X-RateLimit-Policy")).toBe("api:global");
			expect(third.status).toBe(200);
		} finally {
			(serverConfig as { trustProxyHeaders: boolean }).trustProxyHeaders = previousTrust;
		}
	});

	test("layered policies use the endpoint-specific AI submit policy before the global limit", async () => {
		const { app, blocked } = buildApp([
			{
				id: "api:global",
				windowMs: 60_000,
				maxRequests: 10,
				scopes: ["ip"],
			},
			{
				id: "api:ai-submit",
				windowMs: 60_000,
				maxRequests: 1,
				scopes: ["ip"],
				matches: (c) => c.req.method === "POST" && c.req.path === "/api/ai/translate",
			},
		]);

		const first = await app.request("/api/ai/translate", {
			method: "POST",
			headers: { "x-real-ip": "198.51.100.5" },
		});
		const second = await app.request("/api/ai/translate", {
			method: "POST",
			headers: { "x-real-ip": "198.51.100.5" },
		});

		expect(first.status).toBe(200);
		expect(first.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit");
		expect(second.status).toBe(429);
		expect(second.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit");
		expect(blocked).toHaveLength(1);
		expect(blocked[0].policy.id).toBe("api:ai-submit");
	});

	test("default AI submit policies cover retry endpoints", async () => {
		const previousPerMinute = process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE;
		const previousCost = process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE;
		const previousPerHour = process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR;
		process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE = "1";
		process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE = "1000";
		process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR = "1000";
		try {
			const { app, blocked } = buildApp(createDefaultRateLimitPolicies());
			const headers = { "x-real-ip": "198.51.100.55" };
			const first = await app.request("/api/ai/status/job-1/retry", { method: "POST", headers });
			const second = await app.request("/api/ai/status/job-1/retry", { method: "POST", headers });

			expect(first.status).toBe(200);
			expect(first.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit");
			expect(second.status).toBe(429);
			expect(second.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit");
			expect(blocked[0].policy.id).toBe("api:ai-submit");
		} finally {
			if (previousPerMinute === undefined) {
				delete process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE;
			} else {
				process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE = previousPerMinute;
			}
			if (previousCost === undefined) {
				delete process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE;
			} else {
				process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE = previousCost;
			}
			if (previousPerHour === undefined) {
				delete process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR;
			} else {
				process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR = previousPerHour;
			}
		}
	});

	test("default AI submit cost policy charges retry by the stored job tier", async () => {
		const previousPerMinute = process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE;
		const previousCost = process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE;
		const previousPerHour = process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR;
		process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE = "1000";
		process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE = "19";
		process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR = "1000";
		try {
			const { jobQueue } = await import("../services/queue.js");
			const jobId = `retry-cost-${crypto.randomUUID()}`;
			await jobQueue.add({
				jobId,
				projectId: `project-${crypto.randomUUID()}`,
				imageId: "retry-source.png",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				prompt: "test",
				tier: "sfx-pro",
				status: "cancelled",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}, { idempotencyKey: `retry-cost-${jobId}` });

			const { app, blocked } = buildApp(createDefaultRateLimitPolicies());
			const res = await app.request(`/api/ai/status/${jobId}/retry`, {
				method: "POST",
				headers: { "x-real-ip": "198.51.100.56", "x-ai-tier": "budget-clean" },
			});

			expect(res.status).toBe(429);
			expect(res.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit-cost");
			expect(await res.json()).toEqual(expect.objectContaining({
				policyId: "api:ai-submit-cost",
				requestCost: 20,
			}));
			expect(blocked[0].requestCost).toBe(20);
		} finally {
			if (previousPerMinute === undefined) {
				delete process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE;
			} else {
				process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE = previousPerMinute;
			}
			if (previousCost === undefined) {
				delete process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE;
			} else {
				process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE = previousCost;
			}
			if (previousPerHour === undefined) {
				delete process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR;
			} else {
				process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR = previousPerHour;
			}
		}
	});

	test("workspace scoped policies isolate project uploads for the same IP", async () => {
		const { app } = buildApp([
			{
				id: "api:upload",
				windowMs: 60_000,
				maxRequests: 1,
				scopes: ["ip", "workspace"],
				matches: (c) => c.req.method === "POST" && c.req.path.includes("/upload"),
			},
		]);
		const headers = { "x-forwarded-for": "192.0.2.10" };

		const projectA1 = await app.request("/api/images/project-a/upload", { method: "POST", headers });
		const projectA2 = await app.request("/api/images/project-a/upload", { method: "POST", headers });
		const projectB1 = await app.request("/api/images/project-b/upload", { method: "POST", headers });

		expect(projectA1.status).toBe(200);
		expect(projectA2.status).toBe(429);
		expect(projectB1.status).toBe(200);
	});

	test("workspace scoped policies isolate export usage records for usage routes", async () => {
		const { app } = buildApp([
			{
				id: "api:export-usage",
				windowMs: 60_000,
				maxRequests: 1,
				scopes: ["ip", "workspace"],
				matches: (c) => c.req.method === "POST" && c.req.path.endsWith("/export"),
			},
		]);
		const headers = { "x-forwarded-for": "192.0.2.20" };

		const projectA1 = await app.request("/api/usage/project-a/export", { method: "POST", headers });
		const projectA2 = await app.request("/api/usage/project-a/export", { method: "POST", headers });
		const projectB1 = await app.request("/api/usage/project-b/export", { method: "POST", headers });

		expect(projectA1.status).toBe(200);
		expect(projectA2.status).toBe(429);
		expect(projectB1.status).toBe(200);
	});

	test("workspace scoped policies do not trust client-supplied workspace headers without a project path", async () => {
		const { app } = buildApp([
			{
				id: "api:ai-submit",
				windowMs: 60_000,
				maxRequests: 1,
				scopes: ["ip", "workspace"],
				matches: (c) => c.req.method === "POST" && c.req.path === "/api/ai/translate",
			},
		]);
		const baseHeaders = { "x-forwarded-for": "192.0.2.21" };

		const first = await app.request("/api/ai/translate", {
			method: "POST",
			headers: { ...baseHeaders, "x-workspace-id": "workspace-a" },
		});
		const second = await app.request("/api/ai/translate", {
			method: "POST",
			headers: { ...baseHeaders, "x-workspace-id": "workspace-b" },
		});

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
		expect(second.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit");
	});

	test("workspace scoped policies isolate AI submits by the trusted body project id", async () => {
		const projectA = createRateLimitProject();
		const projectB = createRateLimitProject();
		const { app } = buildApp([
			{
				id: "api:ai-submit",
				windowMs: 60_000,
				maxRequests: 1,
				scopes: ["ip", "workspace"],
				matches: (c) => c.req.method === "POST" && c.req.path === "/api/ai/translate",
			},
		]);
		const baseHeaders = {
			"content-type": "application/json",
			"x-forwarded-for": "192.0.2.22",
		};

		const projectA1 = await app.request("/api/ai/translate", {
			method: "POST",
			headers: { ...baseHeaders, "x-workspace-id": "spoof-a" },
			body: JSON.stringify({ projectId: projectA }),
		});
		const projectA2 = await app.request("/api/ai/translate", {
			method: "POST",
			headers: { ...baseHeaders, "x-workspace-id": "spoof-b" },
			body: JSON.stringify({ projectId: projectA }),
		});
		const projectB1 = await app.request("/api/ai/translate", {
			method: "POST",
			headers: { ...baseHeaders, "x-workspace-id": "spoof-a" },
			body: JSON.stringify({ projectId: projectB }),
		});

		expect(projectA1.status).toBe(200);
		expect(projectA2.status).toBe(429);
		expect(projectB1.status).toBe(200);
		expect(projectA2.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit");
	});

	test("workspace scoped policies keep invalid AI submit project ids in one shared bucket", async () => {
		const { app } = buildApp([
			{
				id: "api:ai-submit",
				windowMs: 60_000,
				maxRequests: 1,
				scopes: ["ip", "workspace"],
				matches: (c) => c.req.method === "POST" && c.req.path === "/api/ai/translate",
			},
		]);
		const baseHeaders = {
			"content-type": "application/json",
			"x-forwarded-for": "192.0.2.23",
		};

		const first = await app.request("/api/ai/translate", {
			method: "POST",
			headers: baseHeaders,
			body: JSON.stringify({ projectId: "not-a-real-project-a" }),
		});
		const second = await app.request("/api/ai/translate", {
			method: "POST",
			headers: baseHeaders,
			body: JSON.stringify({ projectId: crypto.randomUUID() }),
		});

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
		expect(second.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit");
	});

	test("workspace scoped policies isolate large valid AI submit bodies by project id", async () => {
		const projectA = createRateLimitProject();
		const projectB = createRateLimitProject();
		const { app } = buildApp([
			{
				id: "api:ai-submit",
				windowMs: 60_000,
				maxRequests: 1,
				scopes: ["ip", "workspace"],
				matches: (c) => c.req.method === "POST" && c.req.path === "/api/ai/translate",
			},
		]);
		const baseHeaders = {
			"content-type": "application/json",
			"x-forwarded-for": "192.0.2.24",
		};
		const largeTextLayers = Array.from({ length: 50 }, () => "x".repeat(2000));

		const projectA1 = await app.request("/api/ai/translate", {
			method: "POST",
			headers: baseHeaders,
			body: JSON.stringify({ projectId: projectA, textLayers: largeTextLayers }),
		});
		const projectA2 = await app.request("/api/ai/translate", {
			method: "POST",
			headers: baseHeaders,
			body: JSON.stringify({ projectId: projectA, textLayers: largeTextLayers }),
		});
		const projectB1 = await app.request("/api/ai/translate", {
			method: "POST",
			headers: baseHeaders,
			body: JSON.stringify({ projectId: projectB, textLayers: largeTextLayers }),
		});

		expect(projectA1.status).toBe(200);
		expect(projectA2.status).toBe(429);
		expect(projectB1.status).toBe(200);
	});

	test("workspace scoped retry policies fail closed if trusted job lookup fails", async () => {
		const originalGet = jobQueue.get.bind(jobQueue);
		(jobQueue as any).get = async () => {
			throw new Error("queue lookup unavailable");
		};
		try {
			const { app } = buildApp([
				{
					id: "api:ai-submit",
					windowMs: 60_000,
					maxRequests: 1,
					scopes: ["ip", "workspace"],
					failureMode: "block",
					matches: (c) => c.req.method === "POST" && /^\/api\/ai\/status\/[^/]+\/retry$/.test(c.req.path),
				},
			]);

			const res = await app.request("/api/ai/status/job-a/retry", {
				method: "POST",
				headers: { "x-forwarded-for": "192.0.2.25" },
			});

			expect(res.status).toBe(503);
			expect(await res.json()).toEqual(expect.objectContaining({
				code: "rate_limit_store_unavailable",
				policyId: "api:ai-submit",
			}));
		} finally {
			(jobQueue as any).get = originalGet;
		}
	});

	test("user scoped policies isolate authenticated users when auth runs before limiting", async () => {
		const app = new Hono();
		app.use("/api/*", async (c, next) => {
			const userId = c.req.header("x-test-user-id");
			if (userId) {
				c.set("user", { userId, email: `${userId}@example.com`, role: "editor" });
			}
			await next();
		});
		app.use("/api/*", layeredRateLimit({
			policies: [{
				id: "api:user-scoped-export-usage",
				windowMs: 60_000,
				maxRequests: 1,
				scopes: ["ip", "workspace", "user"],
				matches: (c) => c.req.method === "POST" && c.req.path.endsWith("/export"),
			}],
			store: new MemoryRateLimitStore(),
			now: () => 1_700_000_000_000,
		}));
		app.all("/api/*", (c) => c.json({ ok: true }));
		const baseHeaders = { "x-forwarded-for": "192.0.2.30" };

		const userA1 = await app.request("/api/usage/project-a/export", { method: "POST", headers: { ...baseHeaders, "x-test-user-id": "user-a" } });
		const userA2 = await app.request("/api/usage/project-a/export", { method: "POST", headers: { ...baseHeaders, "x-test-user-id": "user-a" } });
		const userB1 = await app.request("/api/usage/project-a/export", { method: "POST", headers: { ...baseHeaders, "x-test-user-id": "user-b" } });

		expect(userA1.status).toBe(200);
		expect(userA2.status).toBe(429);
		expect(userB1.status).toBe(200);
	});

	test("default policies classify expensive routes separately from cheap API reads", () => {
		const policies = createDefaultRateLimitPolicies();
		const policyIds = policies.map((policy) => policy.id);
		const aiPolicies = policies.filter((policy) => policy.id.startsWith("api:ai-submit"));
		const translateContext = {
			req: { method: "POST", path: "/api/ai/translate", header: () => "sfx-pro", query: () => "" },
		} as unknown as Context;
		const rerunContext = {
			req: { method: "POST", path: "/api/project/project-a/ai-markers/marker-a/rerun", header: () => "sfx-pro", query: () => "" },
		} as unknown as Context;
		const markerCreateContext = {
			req: { method: "POST", path: "/api/project/project-a/ai-markers", header: () => "sfx-pro", query: () => "" },
		} as unknown as Context;

		expect(policyIds).toContain("api:global");
		expect(policyIds).toContain("api:global-hour");
		expect(policyIds).toContain("api:auth-login");
		expect(policyIds).toContain("api:auth-register");
		expect(policyIds).toContain("api:auth-refresh");
		expect(policyIds).toContain("api:auth-sensitive");
		expect(policyIds).toContain("api:project-write");
		expect(policyIds).toContain("api:upload");
		expect(policyIds).toContain("api:upload-byte-units");
		expect(policyIds).toContain("api:upload-hour");
		expect(policyIds).toContain("api:image-read");
		expect(policyIds).toContain("api:asset-token");
		expect(policyIds).toContain("api:ai-submit");
		expect(policyIds).toContain("api:ai-submit-cost");
		expect(policyIds).toContain("api:ai-submit-hour");
		expect(policyIds).toContain("api:export-usage");
		expect(policyIds).toContain("api:export-usage-hour");
		expect(policyIds).toContain("api:admin");
		expect(aiPolicies).toHaveLength(3);
		expect(aiPolicies.every((policy) => policy.matches?.(translateContext))).toBe(true);
		expect(aiPolicies.every((policy) => policy.matches?.(rerunContext))).toBe(true);
		expect(aiPolicies.every((policy) => !policy.matches?.(markerCreateContext))).toBe(true);
	});

	test("default auth policies fail closed for brute-force sensitive endpoints", () => {
		const policies = createDefaultRateLimitPolicies();
		const authPolicies = policies.filter((policy) => policy.id.startsWith("api:auth-"));
		const loginContext = {
			req: { method: "POST", path: "/api/auth/login" },
		} as Context;
		const registerContext = {
			req: { method: "POST", path: "/api/auth/register" },
		} as Context;
		const refreshContext = {
			req: { method: "POST", path: "/api/auth/refresh" },
		} as Context;
		const sensitiveContext = {
			req: { method: "POST", path: "/api/auth/change-password" },
		} as Context;

		expect(authPolicies.map((policy) => policy.id).sort()).toEqual([
			"api:auth-login",
			"api:auth-refresh",
			"api:auth-register",
			"api:auth-sensitive",
			"api:auth-session",
			"api:auth-session-hour",
		]);
		// The brute-force-sensitive credential endpoints (login/register/refresh/
		// change-password) all fail CLOSED. The cheap per-navigation session-check
		// buckets (api:auth-session*) intentionally fail OPEN so a limiter blip
		// never logs real users out — they are NOT a credential-guessing surface.
		const sensitivePolicies = authPolicies.filter((policy) => !policy.id.startsWith("api:auth-session"));
		expect(sensitivePolicies.every((policy) => policy.failureMode === "block")).toBe(true);
		const sessionPolicies = authPolicies.filter((policy) => policy.id.startsWith("api:auth-session"));
		expect(sessionPolicies).toHaveLength(2);
		expect(sessionPolicies.every((policy) => policy.failureMode === "fallback")).toBe(true);
		expect(authPolicies.find((policy) => policy.id === "api:auth-login")?.matches?.(loginContext)).toBe(true);
		expect(authPolicies.find((policy) => policy.id === "api:auth-register")?.matches?.(registerContext)).toBe(true);
		expect(authPolicies.find((policy) => policy.id === "api:auth-refresh")?.matches?.(refreshContext)).toBe(true);
		expect(authPolicies.find((policy) => policy.id === "api:auth-sensitive")?.matches?.(sensitiveContext)).toBe(true);
	});

	test("session-check endpoints (/auth/me, /auth/refresh) are exempt from api:global and bucketed generously so rapid navigation never logs the user out", async () => {
		// Reproduce the P3 bug scenario: a tiny generic per-minute budget, then a
		// fast-clicking human flips between pages firing GET /api/auth/me far past
		// that budget. With the exemption, /auth/me must NEVER 429 from api:global —
		// it rides its own generous api:auth-session bucket instead. Other API
		// traffic still trips the tight global limit, proving we did not just widen
		// the global bucket.
		const policies = createDefaultRateLimitPolicies().map((policy) =>
			policy.id === "api:global"
				? { ...policy, maxRequests: 3 }
				: policy.id === "api:global-hour"
					? { ...policy, maxRequests: 3 }
					: policy,
		);
		const { app } = buildApp(policies);
		const headers = { "x-forwarded-for": "198.51.100.77" };

		// 24 rapid /auth/me hits in the window — about what ~24 page loads/min does.
		const meStatuses: number[] = [];
		for (let i = 0; i < 24; i++) {
			const res = await app.request("/api/auth/me", { headers });
			meStatuses.push(res.status);
		}
		expect(meStatuses.every((status) => status === 200)).toBe(true);

		// A different cheap API path on the SAME ip still trips the tight global cap,
		// confirming the exemption is scoped to the session-check endpoints only.
		const other1 = await app.request("/api/something-else", { headers });
		const other2 = await app.request("/api/something-else", { headers });
		const other3 = await app.request("/api/something-else", { headers });
		const other4 = await app.request("/api/something-else", { headers });
		expect(other1.status).toBe(200);
		expect(other4.status).toBe(429);
		expect(other4.headers.get("X-RateLimit-Policy")).toBe("api:global");
	});

	test("login and register stay tightly rate-limited (the session-check exemption never loosens credential endpoints)", async () => {
		const { app } = buildApp(createDefaultRateLimitPolicies());
		const headers = { "x-forwarded-for": "198.51.100.78" };

		// Default login cap is 10/min (block). The 11th must 429 on api:auth-login.
		let loginRejected: Response | null = null;
		for (let i = 0; i < 12; i++) {
			const res = await app.request("/api/auth/login", { method: "POST", headers });
			if (res.status === 429) {
				loginRejected = res;
				break;
			}
		}
		expect(loginRejected).not.toBeNull();
		expect(loginRejected!.headers.get("X-RateLimit-Policy")).toBe("api:auth-login");

		// Default register cap is 5/min (block). The 6th must 429 on api:auth-register.
		const regHeaders = { "x-forwarded-for": "198.51.100.79" };
		let registerRejected: Response | null = null;
		for (let i = 0; i < 7; i++) {
			const res = await app.request("/api/auth/register", { method: "POST", headers: regHeaders });
			if (res.status === 429) {
				registerRejected = res;
				break;
			}
		}
		expect(registerRejected).not.toBeNull();
		expect(registerRejected!.headers.get("X-RateLimit-Policy")).toBe("api:auth-register");
	});

	test("default export usage policies are failure-closed and only match export accounting writes", () => {
		const policies = createDefaultRateLimitPolicies();
		const exportPolicies = policies.filter((policy) => policy.id.startsWith("api:export-usage"));
		const exportContext = {
			req: { method: "POST", path: "/api/usage/project-a/export" },
		} as Context;
		const readContext = {
			req: { method: "GET", path: "/api/usage/project-a" },
		} as Context;

		expect(exportPolicies.map((policy) => policy.id).sort()).toEqual(["api:export-usage", "api:export-usage-hour"]);
		expect(exportPolicies.every((policy) => policy.failureMode === "block")).toBe(true);
		expect(exportPolicies.every((policy) => policy.scopes?.includes("workspace") && policy.scopes.includes("user"))).toBe(true);
		expect(exportPolicies.every((policy) => policy.matches?.(exportContext))).toBe(true);
		expect(exportPolicies.every((policy) => !policy.matches?.(readContext))).toBe(true);
	});

	// ── DoS hardening: upload-transform + export-enqueue admission ─────────────

	test("the upload + byte-unit + hour upload policies ALSO match /upload-transform (Sharp merge/split is throttled like /upload)", () => {
		const policies = createDefaultRateLimitPolicies();
		const uploadPolicies = policies.filter((policy) =>
			policy.id === "api:upload" || policy.id === "api:upload-byte-units" || policy.id === "api:upload-hour");
		expect(uploadPolicies).toHaveLength(3);

		const rawUpload = { req: { method: "POST", path: "/api/images/proj-a/upload" } } as Context;
		const transformUpload = { req: { method: "POST", path: "/api/images/proj-a/upload-transform" } } as Context;
		const readContext = { req: { method: "GET", path: "/api/images/proj-a/img-1" } } as Context;
		const otherPostContext = { req: { method: "POST", path: "/api/images/proj-a/upload-something-else" } } as Context;

		// Both Sharp-heavy ingest endpoints are covered by ALL THREE upload policies.
		expect(uploadPolicies.every((policy) => policy.matches?.(rawUpload))).toBe(true);
		expect(uploadPolicies.every((policy) => policy.matches?.(transformUpload))).toBe(true);
		// Reads + unrelated POSTs are not.
		expect(uploadPolicies.every((policy) => !policy.matches?.(readContext))).toBe(true);
		expect(uploadPolicies.every((policy) => !policy.matches?.(otherPostContext))).toBe(true);
	});

	test("export ENQUEUE has its own failure-closed admission cap (per-minute + per-hour) on POST /api/export only", () => {
		const policies = createDefaultRateLimitPolicies();
		const enqueuePolicies = policies.filter((policy) => policy.id.startsWith("api:export-enqueue"));
		expect(enqueuePolicies.map((policy) => policy.id).sort()).toEqual(["api:export-enqueue", "api:export-enqueue-hour"]);
		expect(enqueuePolicies.every((policy) => policy.failureMode === "block")).toBe(true);
		expect(enqueuePolicies.every((policy) =>
			policy.scopes?.includes("workspace") && policy.scopes.includes("user") && policy.scopes.includes("ip"))).toBe(true);

		const enqueueContext = { req: { method: "POST", path: "/api/export" } } as Context;
		const statusReadContext = { req: { method: "GET", path: "/api/export/job-1" } } as Context;
		const presetsContext = { req: { method: "GET", path: "/api/export/presets" } } as Context;
		const usageExportContext = { req: { method: "POST", path: "/api/usage/proj-a/export" } } as Context;

		// Only the enqueue POST is admission-capped; status/preset reads + the unrelated
		// usage-export accounting write are NOT matched by the enqueue policy.
		expect(enqueuePolicies.every((policy) => policy.matches?.(enqueueContext))).toBe(true);
		expect(enqueuePolicies.every((policy) => !policy.matches?.(statusReadContext))).toBe(true);
		expect(enqueuePolicies.every((policy) => !policy.matches?.(presetsContext))).toBe(true);
		expect(enqueuePolicies.every((policy) => !policy.matches?.(usageExportContext))).toBe(true);
	});

	test("export enqueue admission cap actually 429s a flood (end-to-end through the limiter)", async () => {
		// Tighten the per-minute enqueue cap to 3 so a burst trips it fast; the 4th
		// POST /api/export must 429 on api:export-enqueue.
		const policies = createDefaultRateLimitPolicies().map((policy) =>
			policy.id === "api:export-enqueue" ? { ...policy, maxRequests: 3 } : policy);
		const { app } = buildApp(policies);
		const headers = { "x-forwarded-for": "203.0.113.55", "content-type": "application/json" };
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			const res = await app.request("/api/export", { method: "POST", headers, body: "{}" });
			statuses.push(res.status);
		}
		const rejected = statuses.filter((s) => s === 429);
		expect(rejected.length).toBeGreaterThan(0);
	});

	// ── AI support ticket policies (rank6, Layer 1) ───────────────────────────

	test("default ticket policies exist, fail closed, and only match ticket open/reply paths", () => {
		const policies = createDefaultRateLimitPolicies();
		const ticketPolicies = policies.filter((policy) => policy.id.startsWith("api:ticket-"));
		// The support-ticket router is mounted at /api/support (index.ts), so the
		// real, mounted paths are /api/support/tickets[...]. The cost-weighted AI
		// limiter must match THOSE paths — matching the un-mounted /api/tickets prefix
		// (the original bug) meant the limiter never fired on a real request.
		const openContext = { req: { method: "POST", path: "/api/support/tickets" } } as Context;
		const replyContext = { req: { method: "POST", path: "/api/support/tickets/t-1/messages" } } as Context;
		const listContext = { req: { method: "GET", path: "/api/support/tickets" } } as Context;
		// The bare /api/tickets prefix is NOT a mounted route and must NOT match.
		const unmountedOpenContext = { req: { method: "POST", path: "/api/tickets" } } as Context;
		const unmountedReplyContext = { req: { method: "POST", path: "/api/tickets/t-1/messages" } } as Context;

		expect(ticketPolicies.map((policy) => policy.id).sort()).toEqual([
			"api:ticket-ai-msg-hour",
			"api:ticket-ai-msg-min",
			"api:ticket-ai-token-min",
			"api:ticket-open",
			"api:ticket-reply",
		]);
		// Every ticket policy fails CLOSED (block) — an unavailable limiter must not
		// leak ticket/AI traffic.
		expect(ticketPolicies.every((policy) => policy.failureMode === "block")).toBe(true);

		const open = ticketPolicies.find((p) => p.id === "api:ticket-open")!;
		expect(open.matches?.(openContext)).toBe(true);
		expect(open.matches?.(replyContext)).toBe(false);
		expect(open.matches?.(listContext)).toBe(false); // GET is not "open".
		expect(open.matches?.(unmountedOpenContext)).toBe(false); // un-mounted prefix

		const aiReplyPolicies = ticketPolicies.filter((p) => p.id.startsWith("api:ticket-ai-"));
		expect(aiReplyPolicies.every((p) => p.matches?.(replyContext))).toBe(true);
		expect(aiReplyPolicies.every((p) => !p.matches?.(openContext))).toBe(true);
		// Regression: the AI-cost limiter must NOT match the un-mounted /api/tickets
		// prefix (would silently never fire on real /api/support/tickets traffic).
		expect(aiReplyPolicies.some((p) => p.matches?.(unmountedReplyContext))).toBe(false);

		// The per-minute AI message policy is scoped per user AND ticket so one
		// chatty ticket cannot starve another; the cost policy weights by tokens.
		expect(ticketPolicies.find((p) => p.id === "api:ticket-ai-msg-min")?.scopes).toEqual(["user", "ticket"]);
		expect(typeof ticketPolicies.find((p) => p.id === "api:ticket-ai-token-min")?.requestCost).toBe("function");
	});

	test("ticket-open policy blocks past the per-hour cap (fail-closed spam guard)", async () => {
		const prev = process.env.RATE_LIMIT_TICKET_OPEN_PER_HOUR;
		process.env.RATE_LIMIT_TICKET_OPEN_PER_HOUR = "1";
		try {
			const { app, blocked } = buildApp(createDefaultRateLimitPolicies());
			const headers = { "x-real-ip": "198.51.100.71" };
			const first = await app.request("/api/support/tickets", { method: "POST", headers });
			const second = await app.request("/api/support/tickets", { method: "POST", headers });
			expect(first.status).toBe(200);
			expect(second.status).toBe(429);
			expect(blocked.some((d) => d.policy.id === "api:ticket-open")).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.RATE_LIMIT_TICKET_OPEN_PER_HOUR;
			else process.env.RATE_LIMIT_TICKET_OPEN_PER_HOUR = prev;
		}
	});

	test("ticket AI per-minute message policy blocks the 5th reply in a minute (driven by TICKET_AI_MSG_PER_MINUTE)", async () => {
		const prev = process.env.TICKET_AI_MSG_PER_MINUTE;
		process.env.TICKET_AI_MSG_PER_MINUTE = "4";
		try {
			const { app, blocked } = buildApp(createDefaultRateLimitPolicies());
			// Small Content-Length so the (separate) token-unit policy charges reserve-only
			// and does not trip first — this test isolates the per-minute MESSAGE policy.
			const headers = { "x-real-ip": "198.51.100.72", "content-length": "10" };
			const statuses: number[] = [];
			for (let i = 0; i < 5; i++) {
				const res = await app.request("/api/support/tickets/t-7/messages", { method: "POST", headers });
				statuses.push(res.status);
			}
			expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
			expect(statuses[4]).toBe(429);
			expect(blocked.some((d) => d.policy.id === "api:ticket-ai-msg-min")).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.TICKET_AI_MSG_PER_MINUTE;
			else process.env.TICKET_AI_MSG_PER_MINUTE = prev;
		}
	});

	test("ticket AI per-minute message policy keys per ticket so one ticket cannot starve another", async () => {
		const prev = process.env.TICKET_AI_MSG_PER_MINUTE;
		process.env.TICKET_AI_MSG_PER_MINUTE = "1";
		try {
			const { app } = buildApp(createDefaultRateLimitPolicies());
			// Small Content-Length so the token-unit policy stays reserve-only and this
			// test isolates the per-ticket-keyed MESSAGE policy.
			const headers = { "x-real-ip": "198.51.100.73", "content-length": "10" };
			// Ticket A: first allowed, second blocked.
			expect((await app.request("/api/support/tickets/a/messages", { method: "POST", headers })).status).toBe(200);
			expect((await app.request("/api/support/tickets/a/messages", { method: "POST", headers })).status).toBe(429);
			// Ticket B (same user) still has its own budget.
			expect((await app.request("/api/support/tickets/b/messages", { method: "POST", headers })).status).toBe(200);
		} finally {
			if (prev === undefined) delete process.env.TICKET_AI_MSG_PER_MINUTE;
			else process.env.TICKET_AI_MSG_PER_MINUTE = prev;
		}
	});

	test("ticket AI token-cost policy charges ceil(estimatedPromptTokens/100) per reply", async () => {
		const { estimateTicketAiTokenUnits } = await import("../middleware/rate-limit.js");
		// FAIL CLOSED: no Content-Length (chunked / streamed) is priced at the MAX
		// body (16KiB → 4096 prompt tokens + 600 reserve = 4696 → ceil(4696/100)=47),
		// NOT reserve-only, so a flood of large no-Content-Length replies cannot slip
		// the token-unit limiter.
		const emptyCtx = { req: { header: () => undefined } } as unknown as Context;
		expect(estimateTicketAiTokenUnits(emptyCtx)).toBe(47);
		// ~4000 chars → ~1000 prompt tokens + 600 reserve = 1600 → ceil(1600/100)=16.
		const bigCtx = { req: { header: (n: string) => (n === "content-length" ? "4000" : undefined) } } as unknown as Context;
		expect(estimateTicketAiTokenUnits(bigCtx)).toBe(16);
		// A header claiming MORE than the max body is clamped to the same 47 units so a
		// forged huge Content-Length can neither under- nor over-charge.
		const hugeCtx = { req: { header: (n: string) => (n === "content-length" ? "10000000" : undefined) } } as unknown as Context;
		expect(estimateTicketAiTokenUnits(hugeCtx)).toBe(47);

		// And the live policy rejects once the per-minute token-unit budget is spent.
		// Driven by the canonical TICKET_AI_TOKEN_UNITS_PER_MINUTE env (single source
		// of truth shared with the guardrail config), NOT a RATE_LIMIT_* alias.
		const prev = process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE;
		process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE = "10";
		try {
			const { app, blocked } = buildApp(createDefaultRateLimitPolicies());
			const headers = { "x-real-ip": "198.51.100.74", "content-length": "4000", "content-type": "text/plain" };
			// First reply costs 16 units > the 10-unit minute budget → blocked.
			const res = await app.request("/api/support/tickets/t-9/messages", { method: "POST", headers, body: "x".repeat(10) });
			expect(res.status).toBe(429);
			expect(blocked.some((d) => d.policy.id === "api:ticket-ai-token-min" && d.requestCost === 16)).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE;
			else process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE = prev;
		}
	});

	// P2 fail-closed: a flood of large CHUNKED / no-Content-Length replies must not
	// slip the token-unit limiter by being priced at reserve-only. Each such reply is
	// charged the MAX-body estimate (47 units), so two of them exceed a 60-unit budget
	// and the second is blocked — exactly as a single 16KiB-body reply would be.
	test("ticket AI token-cost policy charges the MAX reservation for chunked / no-Content-Length replies (burst blocked)", async () => {
		const prev = process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE;
		process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE = "60"; // budget < 2 * 47 max-units
		try {
			const { app, blocked } = buildApp(createDefaultRateLimitPolicies());
			// No content-length header → server treats it as a chunked / streamed body.
			const headers = { "x-real-ip": "198.51.100.99", "content-type": "text/plain" };
			// First reply costs 47 max-units (≤ 60) → allowed.
			const first = await app.request("/api/support/tickets/t-chunk/messages", { method: "POST", headers });
			expect(first.status).toBe(200);
			// Second reply would push the per-minute total to 94 > 60 → blocked.
			const second = await app.request("/api/support/tickets/t-chunk/messages", { method: "POST", headers });
			expect(second.status).toBe(429);
			expect(blocked.some((d) => d.policy.id === "api:ticket-ai-token-min" && d.requestCost === 47)).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE;
			else process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE = prev;
		}
	});

	test("ticket AI rate-limit policies are driven by the canonical TICKET_AI_* envs (single source of truth)", () => {
		const prevMin = process.env.TICKET_AI_MSG_PER_MINUTE;
		const prevHour = process.env.TICKET_AI_MSG_PER_HOUR;
		const prevTok = process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE;
		// And assert the OLD parallel namespace is dead: setting it must NOT move the limiter.
		const prevAlias = process.env.RATE_LIMIT_TICKET_AI_MSG_PER_MINUTE;
		process.env.TICKET_AI_MSG_PER_MINUTE = "7";
		process.env.TICKET_AI_MSG_PER_HOUR = "55";
		process.env.TICKET_AI_TOKEN_UNITS_PER_MINUTE = "33";
		process.env.RATE_LIMIT_TICKET_AI_MSG_PER_MINUTE = "999"; // ignored alias
		try {
			const policies = createDefaultRateLimitPolicies();
			const byId = (id: string) => policies.find((p) => p.id === id);
			// The limiter reads the documented TICKET_AI_* config, not the dead alias.
			expect(byId("api:ticket-ai-msg-min")?.maxRequests).toBe(7);
			expect(byId("api:ticket-ai-msg-hour")?.maxRequests).toBe(55);
			expect(byId("api:ticket-ai-token-min")?.maxRequests).toBe(33);
		} finally {
			const restore = (name: string, value: string | undefined) => {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			};
			restore("TICKET_AI_MSG_PER_MINUTE", prevMin);
			restore("TICKET_AI_MSG_PER_HOUR", prevHour);
			restore("TICKET_AI_TOKEN_UNITS_PER_MINUTE", prevTok);
			restore("RATE_LIMIT_TICKET_AI_MSG_PER_MINUTE", prevAlias);
		}
	});

	test("redis store uses atomic weighted window keys and sets expiry once per window", async () => {
		const client = new FakeRedisRateLimitClient();
		const store = new RedisRateLimitStore({
			client,
			keyPrefix: "test-rate-limit",
			expiryBufferSeconds: 2,
		});
		const now = 1_700_000_000_123;
		const windowMs = 60_000;

		const first = await store.increment("api:global:ip:203.0.113.9", windowMs, now);
		const second = await store.increment("api:global:ip:203.0.113.9", windowMs, now + 1000, 3);

		expect(first).toEqual({ count: 1, resetAt: 1_700_000_040_000 });
		expect(second).toEqual({ count: 4, resetAt: 1_700_000_040_000 });
		expect(client.values.size).toBe(1);
		expect(client.expirations).toHaveLength(1);
		expect(client.expirations[0].ttlMs).toBe(62_000);
		expect([...client.values.keys()][0]).toBe("test-rate-limit:api:global:ip:203.0.113.9:1699999980000");
	});

	test("weighted policies charge request cost before rejecting expensive bursts", async () => {
		const { app } = buildApp([{
			id: "api:weighted-ai",
			windowMs: 60_000,
			maxRequests: 5,
			keyFn: () => "weighted",
			requestCost: 3,
		}]);

		const first = await app.request("/api/ai/translate", { method: "POST" });
		const second = await app.request("/api/ai/translate", { method: "POST" });
		const body = await second.json();

		expect(first.status).toBe(200);
		expect(first.headers.get("X-RateLimit-Remaining")).toBe("2");
		expect(second.status).toBe(429);
		expect(body).toEqual(expect.objectContaining({
			code: "rate_limit_exceeded",
			policyId: "api:weighted-ai",
			requestCost: 3,
		}));
	});

	test("expensive policies fail closed when the shared rate-limit store is unavailable", async () => {
		const app = new Hono();
		const storeErrors: string[] = [];
		app.use("/api/*", layeredRateLimit({
			policies: [{
				id: "api:ai-submit",
				windowMs: 60_000,
				maxRequests: 1,
				keyFn: () => "ai",
				failureMode: "block",
			}],
			store: new FailingRateLimitStore(),
			fallbackStore: null,
			now: () => 1_700_000_000_000,
			onStoreError: (error) => storeErrors.push(error instanceof Error ? error.message : String(error)),
		}));
		app.post("/api/ai/translate", (c) => c.json({ ok: true }));

		const response = await app.request("/api/ai/translate", { method: "POST" });
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(response.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit");
		expect(body).toEqual(expect.objectContaining({
			code: "rate_limit_store_unavailable",
			policyId: "api:ai-submit",
		}));
		expect(storeErrors).toEqual(["redis offline"]);
	});

	test("request cost lookup failures are handled by policy failure mode", async () => {
		const app = new Hono();
		const storeErrors: string[] = [];
		app.use("/api/*", layeredRateLimit({
			policies: [{
				id: "api:ai-submit-cost",
				windowMs: 60_000,
				maxRequests: 10,
				keyFn: () => "ai-cost",
				requestCost: async () => {
					throw new Error("queue lookup failed");
				},
				failureMode: "block",
			}],
			store: new MemoryRateLimitStore(),
			fallbackStore: null,
			now: () => 1_700_000_000_000,
			onStoreError: (error) => storeErrors.push(error instanceof Error ? error.message : String(error)),
		}));
		app.post("/api/ai/status/job-1/retry", (c) => c.json({ ok: true }));

		const response = await app.request("/api/ai/status/job-1/retry", { method: "POST" });
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(response.headers.get("X-RateLimit-Policy")).toBe("api:ai-submit-cost");
		expect(body).toEqual(expect.objectContaining({
			code: "rate_limit_store_unavailable",
			policyId: "api:ai-submit-cost",
		}));
		expect(storeErrors).toEqual(["queue lookup failed"]);
	});

	test("fallback store keeps API available if redis is unavailable", async () => {
		const errors: string[] = [];
		const store = new FallbackRateLimitStore({
			primary: new FailingRateLimitStore(),
			fallback: new MemoryRateLimitStore(),
			onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
		});
		const { app } = buildApp([{
			id: "api:global",
			windowMs: 60_000,
			maxRequests: 1,
			keyFn: () => "global",
		}]);
		app.use("/limited/*", layeredRateLimit({
			policies: [{
				id: "api:fallback",
				windowMs: 60_000,
				maxRequests: 1,
				keyFn: () => "fallback",
			}],
			store,
			now: () => 1_700_000_000_000,
		}));
		app.get("/limited/check", (c) => c.json({ ok: true }));

		const first = await app.request("/limited/check");
		const second = await app.request("/limited/check");

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
		expect(errors).toEqual(["redis offline", "redis offline"]);
	});

	test("memory store uses the same epoch-aligned fixed window as the redis store", async () => {
		const memory = new MemoryRateLimitStore();
		const redisClient = new FakeRedisRateLimitClient();
		const redis = new RedisRateLimitStore({ client: redisClient, keyPrefix: "parity" });
		const windowMs = 60_000;
		// Deliberately unaligned timestamps that all fall inside the same epoch window
		// [1_699_999_980_000, 1_700_000_040_000).
		const t0 = 1_700_000_000_123;
		const t1 = t0 + 1_000;
		const expectedResetAt = Math.floor(t0 / windowMs) * windowMs + windowMs;

		const memFirst = memory.increment("k", windowMs, t0);
		const redisFirst = await redis.increment("k", windowMs, t0);
		const memSecond = memory.increment("k", windowMs, t1, 3);
		const redisSecond = await redis.increment("k", windowMs, t1, 3);

		// Same window boundary (resetAt) reported by both stores...
		expect(memFirst.resetAt).toBe(expectedResetAt);
		expect(redisFirst.resetAt).toBe(expectedResetAt);
		expect(memSecond.resetAt).toBe(expectedResetAt);
		expect(redisSecond.resetAt).toBe(expectedResetAt);
		// ...and the counts accumulate identically within that window.
		expect(memFirst.count).toBe(redisFirst.count);
		expect(memSecond.count).toBe(redisSecond.count);
		expect(memSecond.count).toBe(4);
	});

	test("fallback store continues the count in the SAME epoch window when redis throws mid-window", async () => {
		// Primary that serves the first hit then starts throwing, exercising the
		// primary -> memory-fallback transition within a single epoch window.
		class FlakyRedisStore implements RateLimitStore {
			private readonly inner = new RedisRateLimitStore({
				client: new FakeRedisRateLimitClient(),
				keyPrefix: "flaky",
			});
			throwNext = false;
			async increment(key: string, windowMs: number, now: number, amount = 1) {
				if (this.throwNext) throw new Error("redis offline");
				return this.inner.increment(key, windowMs, now, amount);
			}
		}

		const primary = new FlakyRedisStore();
		const store = new FallbackRateLimitStore({ primary, fallback: new MemoryRateLimitStore() });
		const windowMs = 60_000;
		const t0 = 1_700_000_000_123; // unaligned, inside window [..980_000, ..040_000)
		const t1 = t0 + 5_000; // still inside the same epoch window
		const expectedResetAt = Math.floor(t0 / windowMs) * windowMs + windowMs;

		// First hit goes through Redis.
		const first = await store.increment("client", windowMs, t0);
		expect(first.count).toBe(1);
		expect(first.resetAt).toBe(expectedResetAt);

		// Redis blips; the next hit degrades to the memory fallback. The window
		// boundary stays stable (no second misaligned window), so a client cannot
		// burst past the cap by straddling the blip.
		primary.throwNext = true;
		const second = await store.increment("client", windowMs, t1);
		expect(second.resetAt).toBe(expectedResetAt);
		// Fallback starts its own counter (fail-open posture; documented gap), but it
		// is anchored to the SAME epoch window, not a fresh first-hit window.
		expect(second.resetAt).toBe(first.resetAt);
	});

	test("memory store rolls over to a fresh window at the epoch boundary", () => {
		const memory = new MemoryRateLimitStore();
		const windowMs = 60_000;
		const windowStart = Math.floor(1_700_000_000_000 / windowMs) * windowMs;
		const lastMsOfWindow = windowStart + windowMs - 1;
		const firstMsOfNextWindow = windowStart + windowMs;

		const a = memory.increment("roll", windowMs, windowStart);
		const b = memory.increment("roll", windowMs, lastMsOfWindow);
		expect(a.count).toBe(1);
		expect(b.count).toBe(2);
		expect(a.resetAt).toBe(windowStart + windowMs);
		expect(b.resetAt).toBe(windowStart + windowMs);

		// Crossing the boundary resets the count and advances resetAt by one window.
		const c = memory.increment("roll", windowMs, firstMsOfNextWindow);
		expect(c.count).toBe(1);
		expect(c.resetAt).toBe(windowStart + 2 * windowMs);
	});
});
