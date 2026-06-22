import { describe, expect, test } from "bun:test";
import { SignatureTtlSingleFlightCache, SingleFlight } from "../services/single-flight.js";

function createGate(count: number): { wait: () => Promise<void> } {
	let arrived = 0;
	let release!: () => void;
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		async wait(): Promise<void> {
			arrived += 1;
			if (arrived >= count) release();
			await opened;
		},
	};
}

describe("SingleFlight", () => {
	test("coalesces concurrent work for the same key", async () => {
		const flight = new SingleFlight();
		let calls = 0;
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				flight.run("same", async () => {
					calls += 1;
					await Promise.resolve();
					return { value: 42 };
				}),
			),
		);

		expect(calls).toBe(1);
		expect(results).toEqual(Array.from({ length: 8 }, () => ({ value: 42 })));
		expect(flight.size).toBe(0);
	});

	test("does not coalesce different keys", async () => {
		const flight = new SingleFlight();
		const gate = createGate(2);
		const [a, b] = await Promise.all([
			flight.run("a", async () => {
				await gate.wait();
				return "A";
			}),
			flight.run("b", async () => {
				await gate.wait();
				return "B";
			}),
		]);

		expect(a).toBe("A");
		expect(b).toBe("B");
	});

	test("clears a failed flight so the next caller can retry", async () => {
		const flight = new SingleFlight();
		let calls = 0;
		const failed = await Promise.allSettled(
			Array.from({ length: 4 }, () =>
				flight.run("retry", async () => {
					calls += 1;
					await Promise.resolve();
					throw new Error("boom");
				}),
			),
		);

		expect(failed.every((result) => result.status === "rejected")).toBe(true);
		expect(calls).toBe(1);
		expect(flight.size).toBe(0);

		const retry = await flight.run("retry", () => "ok");
		expect(retry).toBe("ok");
		expect(calls).toBe(1);
	});
});

describe("SignatureTtlSingleFlightCache", () => {
	test("serves a live signature match without recomputing", async () => {
		const cache = new SignatureTtlSingleFlightCache<{ n: number }>({ maxEntries: 10, ttlMs: 1_000, now: () => 100 });
		let calls = 0;

		expect(await cache.getOrSet("k", "sig", () => ({ n: ++calls }))).toEqual({ n: 1 });
		expect(await cache.getOrSet("k", "sig", () => ({ n: ++calls }))).toEqual({ n: 1 });
		expect(calls).toBe(1);
	});

	test("single-flights concurrent misses for the same key and signature", async () => {
		const cache = new SignatureTtlSingleFlightCache<{ n: number }>({ maxEntries: 10, ttlMs: 1_000, now: () => 100 });
		let calls = 0;
		const results = await Promise.all(
			Array.from({ length: 7 }, () =>
				cache.getOrSet("workspace:user", "project-updated-at-signature", async () => {
					calls += 1;
					await Promise.resolve();
					return { n: 7 };
				}),
			),
		);

		expect(calls).toBe(1);
		expect(results).toEqual(Array.from({ length: 7 }, () => ({ n: 7 })));
		expect(cache.inflightSize).toBe(0);
	});

	test("does not coalesce different signatures for the same key", async () => {
		const cache = new SignatureTtlSingleFlightCache<string>({ maxEntries: 10, ttlMs: 1_000, now: () => 100 });
		const gate = createGate(2);
		const [oldAggregate, newAggregate] = await Promise.all([
			cache.getOrSet("workspace:user", "old-signature", async () => {
				await gate.wait();
				return "old";
			}),
			cache.getOrSet("workspace:user", "new-signature", async () => {
				await gate.wait();
				return "new";
			}),
		]);

		expect(oldAggregate).toBe("old");
		expect(newAggregate).toBe("new");
	});

	test("recomputes after TTL expiry", async () => {
		let nowMs = 100;
		const cache = new SignatureTtlSingleFlightCache<{ n: number }>({ maxEntries: 10, ttlMs: 500, now: () => nowMs });
		let calls = 0;

		expect(await cache.getOrSet("k", "sig", () => ({ n: ++calls }))).toEqual({ n: 1 });
		nowMs = 600;
		expect(await cache.getOrSet("k", "sig", () => ({ n: ++calls }))).toEqual({ n: 2 });
		expect(calls).toBe(2);
	});

	test("clears failed cache-miss flights and does not retain a failed value", async () => {
		const cache = new SignatureTtlSingleFlightCache<{ ok: boolean }>({ maxEntries: 10, ttlMs: 1_000, now: () => 100 });
		let calls = 0;
		const failed = await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				cache.getOrSet("k", "sig", async () => {
					calls += 1;
					await Promise.resolve();
					throw new Error("failed aggregate");
				}),
			),
		);

		expect(failed.every((result) => result.status === "rejected")).toBe(true);
		expect(calls).toBe(1);
		expect(cache.get("k", "sig")).toBeUndefined();
		expect(cache.inflightSize).toBe(0);

		const retry = await cache.getOrSet("k", "sig", () => ({ ok: true }));
		expect(retry).toEqual({ ok: true });
		expect(calls).toBe(1);
	});

	test("disabled cache bypasses storage and coalescing", async () => {
		const cache = new SignatureTtlSingleFlightCache<number>({ maxEntries: 10, ttlMs: 0, now: () => 100 });
		let calls = 0;
		const results = await Promise.all(
			Array.from({ length: 3 }, () =>
				cache.getOrSet("k", "sig", async () => {
					const value = ++calls;
					await Promise.resolve();
					return value;
				}),
			),
		);

		expect(results).toEqual([1, 2, 3]);
		expect(cache.size).toBe(0);
		expect(cache.inflightSize).toBe(0);
	});
});
