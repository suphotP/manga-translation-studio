import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { billingStore } from "$lib/stores/billing.svelte.ts";
import { perfAnalyticsStore } from "$lib/stores/perf-analytics.svelte.ts";
import { usageStore } from "$lib/stores/usage.svelte.ts";
import type { AuthResponse, AuthUser, PerfWorkspaceAggregate, UsageDashboard } from "$lib/api/client.ts";

const WS_ID = "ws-polling-1";
const TEST_POLL_INTERVAL_MS = 10_000;

const user: AuthUser = {
	id: "user-1",
	email: "polling@example.com",
	name: "Polling Tester",
	role: "admin",
	authProvider: "local",
	emailVerified: true,
	isActive: true,
};

function authResponse(accessToken: string, refreshToken: string): AuthResponse {
	return {
		user,
		tokens: { accessToken, refreshToken },
	};
}

function seedSession(accessToken: string, refreshToken = `${accessToken}-refresh`): void {
	authStore.__setSessionForTesting(authResponse(accessToken, refreshToken));
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function usageDashboard(workspaceId: string): UsageDashboard {
	return {
		workspaceId,
		scope: "filesystem",
		enforced: true,
		plan: {
			id: "studio",
			name: "Studio",
			monthlyAiCredits: 700,
			includedStorageBytes: 1_073_741_824,
			maxSeatsIncluded: 5,
		},
		projectIds: [],
		projectCount: 0,
		totals: {
			daily: {
				periodKey: "2026-06-11",
				aiCapturedThb: 0,
				aiActiveReservedThb: 0,
				aiCommittedThb: 0,
				uploadBytes: 0,
				exportBytes: 0,
				moderationImages: 0,
				limits: { aiCreditThb: 595, uploadBytes: 0, exportBytes: 0 },
				remaining: { aiCreditThb: 595, uploadBytes: null, exportBytes: null },
			},
			monthly: {
				periodKey: "2026-06",
				aiCapturedThb: 0,
				aiActiveReservedThb: 0,
				aiCommittedThb: 0,
				uploadBytes: 0,
				exportBytes: 0,
				moderationImages: 0,
				limits: { aiCreditThb: 595, uploadBytes: 0, exportBytes: 0 },
				remaining: { aiCreditThb: 595, uploadBytes: null, exportBytes: null },
			},
			eventCount: 0,
		},
		storage: {
			usedBytes: 0,
			originalBytes: 0,
			derivativeBytes: 0,
			exportArtifactBytes: 0,
			reservedBytes: 0,
			projectedBytes: 0,
			limitBytes: 1_073_741_824,
			includedBytes: 1_073_741_824,
			extraBytes: 0,
			remainingBytes: 1_073_741_824,
			percentUsed: 0,
			enforced: true,
		},
		egress: {
			windowMs: 3_600_000,
			totalRequests: 0,
			totalBytes: 0,
			limitBytes: 0,
			remainingBytes: 0,
			enforced: false,
			perProjectEnforced: false,
			projects: [],
		},
		memberAttribution: "unattributed",
		members: {
			count: 1,
			breakdown: [],
			unattributed: { aiCommittedThb: 0, uploadBytes: 0, exportBytes: 0 },
		},
	};
}

function perfAggregate(workspaceId: string): PerfWorkspaceAggregate {
	return {
		workspaceId,
		periodStart: "2026-06-01T00:00:00.000Z",
		memberCount: 1,
		medianComposite: 0,
		dimensionMedians: {
			throughput: 0,
			quality: 0,
			consistency: 0,
			ai_leverage: 0,
			collaboration: 0,
		},
		roi: {
			tmHits: 0,
			aiCaughtIssues: 0,
			timeSavedMinutes: 0,
			timeSavedHours: 0,
			moneySavedUsd: 0,
			hourlyRateUsd: 0,
		},
		computedAt: "2026-06-11T00:00:00.000Z",
	};
}

function requestUrl(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function requestAuthorization(init?: RequestInit): string | null {
	const headers = init?.headers;
	if (headers instanceof Headers) return headers.get("Authorization");
	if (Array.isArray(headers)) {
		return headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? null;
	}
	return (headers as Record<string, string> | undefined)?.Authorization ?? null;
}

async function settleAsync(turns = 12): Promise<void> {
	for (let i = 0; i < turns; i += 1) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
}

describe("auth-aware usage/perf polling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		authStore.__resetForTesting();
		usageStore.__resetForTesting();
		perfAnalyticsStore.__resetForTesting();
		billingStore.__resetForTesting();
	});

	afterEach(() => {
		usageStore.__resetForTesting();
		perfAnalyticsStore.__resetForTesting();
		billingStore.__resetForTesting();
		authStore.__resetForTesting();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("does not start protected polling while anonymous, then resumes when auth is restored", async () => {
		const calls = { usage: 0, perf: 0 };
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.includes("/usage/workspace/")) {
				calls.usage += 1;
				return Promise.resolve(json({ dashboard: usageDashboard(WS_ID) }));
			}
			if (url.includes("/perf/workspace")) {
				calls.perf += 1;
				return Promise.resolve(json({ aggregate: perfAggregate(WS_ID) }));
			}
			return Promise.resolve(json({}));
		}) as unknown as typeof fetch);

		const stopUsage = usageStore.startPolling(WS_ID, TEST_POLL_INTERVAL_MS);
		const stopPerf = perfAnalyticsStore.startPolling(WS_ID, TEST_POLL_INTERVAL_MS);
		await settleAsync();
		await vi.advanceTimersByTimeAsync(250);
		await settleAsync();

		expect(calls).toEqual({ usage: 0, perf: 0 });

		seedSession("access-restored");
		await vi.advanceTimersByTimeAsync(1_500);
		await settleAsync();

		expect(calls).toEqual({ usage: 1, perf: 1 });
		expect(usageStore.dashboard?.workspaceId).toBe(WS_ID);
		expect(perfAnalyticsStore.aggregate?.workspaceId).toBe(WS_ID);

		stopUsage();
		stopPerf();
	});

	it("pauses after post-refresh 401s and waits for a later authStore token change", async () => {
		const calls = { usage: 0, perf: 0, refresh: 0 };
		let rejectAuth = true;
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.includes("/auth/refresh")) {
				calls.refresh += 1;
				return Promise.resolve(rejectAuth ? json({ error: "expired" }, 401) : json(authResponse("access-2", "refresh-2")));
			}
			if (url.includes("/usage/workspace/")) {
				calls.usage += 1;
				return Promise.resolve(rejectAuth ? json({ error: "expired" }, 401) : json({ dashboard: usageDashboard(WS_ID) }));
			}
			if (url.includes("/perf/workspace")) {
				calls.perf += 1;
				return Promise.resolve(rejectAuth ? json({ error: "expired" }, 401) : json({ aggregate: perfAggregate(WS_ID) }));
			}
			return Promise.resolve(json({}));
		}) as unknown as typeof fetch);

		seedSession("access-1", "refresh-1");
		usageStore.startPolling(WS_ID, TEST_POLL_INTERVAL_MS);
		perfAnalyticsStore.startPolling(WS_ID, TEST_POLL_INTERVAL_MS);
		await settleAsync();

		expect(calls.usage).toBe(1);
		expect(calls.perf).toBe(1);
		expect(authStore.isAuthenticated).toBe(false);

		await vi.advanceTimersByTimeAsync(250);
		await settleAsync();
		expect(calls.usage).toBe(1);
		expect(calls.perf).toBe(1);

		rejectAuth = false;
		seedSession("access-2", "refresh-2");
		await vi.advanceTimersByTimeAsync(1_500);
		await settleAsync();

		expect(calls.usage).toBe(2);
		expect(calls.perf).toBe(2);
		expect(usageStore.error).toBeNull();
		expect(perfAnalyticsStore.error).toBeNull();
		expect(calls.refresh).toBeGreaterThanOrEqual(1);
	});

	it("keeps polling when apiFetch refreshes a stale access token successfully", async () => {
		let refreshCalls = 0;
		let usageCalls = 0;
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			if (url.includes("/auth/refresh")) {
				refreshCalls += 1;
				return Promise.resolve(json(authResponse("fresh-access", "fresh-refresh")));
			}
			if (url.includes("/usage/workspace/")) {
				usageCalls += 1;
				const auth = requestAuthorization(init);
				if (auth === "Bearer fresh-access") {
					return Promise.resolve(json({ dashboard: usageDashboard(WS_ID) }));
				}
				return Promise.resolve(json({ error: "expired" }, 401));
			}
			return Promise.resolve(json({}));
		}) as unknown as typeof fetch);

		seedSession("stale-access", "refresh-1");
		usageStore.startPolling(WS_ID, TEST_POLL_INTERVAL_MS);
		await settleAsync();

		expect(refreshCalls).toBe(1);
		expect(usageCalls).toBe(2);
		expect(usageStore.dashboard?.workspaceId).toBe(WS_ID);

		await vi.advanceTimersByTimeAsync(TEST_POLL_INTERVAL_MS);
		await settleAsync();

		expect(usageCalls).toBe(3);
		expect(authStore.accessToken).toBe("fresh-access");
	});
});

describe("RealtimeStore token auth recovery", () => {
	class FakeEventSource {
		static opened: string[] = [];
		readonly url: string;

		constructor(url: string) {
			this.url = url;
			FakeEventSource.opened.push(url);
		}

		addEventListener(): void {/* noop */}
		removeEventListener(): void {/* noop */}
		close(): void {/* noop */}
	}

	beforeEach(() => {
		vi.useFakeTimers();
		authStore.__resetForTesting();
		FakeEventSource.opened = [];
		vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
	});

	afterEach(async () => {
		const { realtimeStore } = await import("$lib/stores/realtime.svelte.ts");
		realtimeStore.__resetForTesting();
		authStore.__resetForTesting();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("refreshes once and retries realtime token mint when the access token expired", async () => {
		let refreshCalls = 0;
		const tokenAuthHeaders: Array<string | null> = [];
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			if (url.includes("/auth/refresh")) {
				refreshCalls += 1;
				return Promise.resolve(json(authResponse("fresh-access", "fresh-refresh")));
			}
			if (url.includes("/realtime/token")) {
				const auth = requestAuthorization(init);
				tokenAuthHeaders.push(auth);
				if (auth === "Bearer fresh-access") {
					return Promise.resolve(json({ token: "sse-token" }));
				}
				return Promise.resolve(json({ error: "expired" }, 401));
			}
			return Promise.resolve(json({}));
		}) as unknown as typeof fetch);

		seedSession("stale-access", "refresh-1");
		const { realtimeStore } = await import("$lib/stores/realtime.svelte.ts");
		realtimeStore.__resetForTesting();

		await realtimeStore.connect(WS_ID);
		await settleAsync();

		expect(refreshCalls).toBe(1);
		expect(tokenAuthHeaders).toEqual(["Bearer stale-access", "Bearer fresh-access"]);
		expect(FakeEventSource.opened).toHaveLength(1);
		expect(FakeEventSource.opened[0]).toContain("token=sse-token");
	});

	it("does not schedule a token-mint retry loop when refresh is rejected", async () => {
		let refreshCalls = 0;
		let tokenCalls = 0;
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url.includes("/auth/refresh")) {
				refreshCalls += 1;
				return Promise.resolve(json({ error: "invalid refresh" }, 401));
			}
			if (url.includes("/realtime/token")) {
				tokenCalls += 1;
				return Promise.resolve(json({ error: "expired" }, 401));
			}
			return Promise.resolve(json({}));
		}) as unknown as typeof fetch);

		seedSession("stale-access", "refresh-1");
		const { realtimeStore } = await import("$lib/stores/realtime.svelte.ts");
		realtimeStore.__resetForTesting();

		await realtimeStore.connect(WS_ID);
		await settleAsync();
		expect(realtimeStore.status).toBe("unavailable");
		expect(tokenCalls).toBe(1);
		expect(refreshCalls).toBe(1);

		await vi.advanceTimersByTimeAsync(30_000);
		await settleAsync();

		expect(tokenCalls).toBe(1);
		expect(FakeEventSource.opened).toHaveLength(0);
	});

	it("retries on backoff while paused with an UNCHANGED authenticated session (transient refresh failure)", async () => {
		// Token stays identical (refresh 429'd) — only the 60s backoff may resume it.
		vi.useFakeTimers();
		try {
			authStore.accessToken = "same-token" as any;
			authStore.user = { id: "u1" } as any;
			(authStore as any).status = "authenticated";
			const load = vi.spyOn(usageStore, "load").mockRejectedValue(Object.assign(new Error("401"), { status: 401 }));
			usageStore.startPolling("ws-1");
			await vi.advanceTimersByTimeAsync(100);
			load.mockClear();
			// Inside the backoff window: still parked despite being authenticated.
			await vi.advanceTimersByTimeAsync(30_000);
			expect(load).not.toHaveBeenCalled();
			// Past the backoff: one retry probe fires even though auth never changed.
			load.mockResolvedValue(undefined as any);
			await vi.advanceTimersByTimeAsync(40_000);
			expect(load).toHaveBeenCalled();
		} finally {
			usageStore.stopPolling();
			vi.useRealTimers();
		}
	});
});
