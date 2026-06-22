import { describe, expect, test } from "bun:test";

// No module mocks on purpose: these suites exercise MemoryRateLimitStore and
// FallbackRateLimitStore with injected primary stores, so the middleware's
// real imports (config, client-ip, …) load fine and the Redis path is never
// touched. (An earlier conversion carried vitest mocks whose specifiers
// resolved outside this checkout — they were silent no-ops; codex P2.)
import { FallbackRateLimitStore, MemoryRateLimitStore } from "../middleware/rate-limit.js";


type IncrementResult = { count: number; resetAt: number };
type IncrementStore = {
	increment(key: string, windowMs: number, now: number, amount?: number): IncrementResult | Promise<IncrementResult>;
};

class AlwaysFailStore {
	increment(): never {
		throw new Error("redis offline");
	}
}

function epochResetAt(now: number, windowMs: number): number {
	return Math.floor(now / windowMs) * windowMs + windowMs;
}

async function findJitteredWindow(
	store: IncrementStore,
	now: number,
	windowMs: number,
	prefix: string,
): Promise<{ key: string; first: IncrementResult }> {
	const unjitteredResetAt = epochResetAt(now, windowMs);
	for (let index = 0; index < 200; index++) {
		const key = `${prefix}:${index}`;
		const first = await store.increment(key, windowMs, now);
		if (first.resetAt !== unjitteredResetAt) {
			return { key, first };
		}
	}
	throw new Error("expected at least one deterministic jittered rate-limit key");
}

describe("rate-limit fallback memory windows", () => {
	test("jittered memory windows count inside one shifted boundary and reset at that boundary", async () => {
		const store = new MemoryRateLimitStore({ windowJitterMs: 10_000 });
		const windowMs = 60_000;
		const epochBoundary = Math.floor(1_700_000_000_000 / windowMs) * windowMs;

		const { key, first } = await findJitteredWindow(store, epochBoundary, windowMs, "memory-jitter");

		expect(first.count).toBe(1);
		expect(first.resetAt).toBeGreaterThan(epochBoundary);
		expect(first.resetAt).toBeLessThanOrEqual(epochBoundary + 10_000);

		const beforeReset = store.increment(key, windowMs, first.resetAt - 1, 4);
		expect(beforeReset).toEqual({ count: 5, resetAt: first.resetAt });

		const afterReset = store.increment(key, windowMs, first.resetAt, 2);
		expect(afterReset).toEqual({ count: 2, resetAt: first.resetAt + windowMs });
	});

	test("default Redis fallback memory store has jitter and preserves weighted counts until reset", async () => {
		const errors: string[] = [];
		const store = new FallbackRateLimitStore({
			primary: new AlwaysFailStore(),
			onError: (error: unknown) => errors.push(error instanceof Error ? error.message : String(error)),
		});
		const windowMs = 60_000;
		const epochBoundary = Math.floor(1_700_000_000_000 / windowMs) * windowMs;

		const { key, first } = await findJitteredWindow(store, epochBoundary, windowMs, "fallback-jitter");

		expect(first.count).toBe(1);
		expect(first.resetAt).toBeGreaterThan(epochBoundary);
		expect(first.resetAt).toBeLessThanOrEqual(epochBoundary + 5_000);

		const weightedBurst = await store.increment(key, windowMs, first.resetAt - 1, 3);
		expect(weightedBurst).toEqual({ count: 4, resetAt: first.resetAt });

		const nextWindow = await store.increment(key, windowMs, first.resetAt);
		expect(nextWindow).toEqual({ count: 1, resetAt: first.resetAt + windowMs });
		expect(errors.every((message) => message === "redis offline")).toBe(true);
	});
});
