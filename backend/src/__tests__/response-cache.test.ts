// Unit tests for the read-through TTL cache (backend/src/services/response-cache.ts).
//
// Proves the three invariants that make it safe to put in front of a route:
//   * NoopResponseCache NEVER caches (default in dev/test → no stale surprises),
//   * MemoryResponseCache serves within-TTL hits and recomputes after expiry,
//   * RedisResponseCache is FAIL-OPEN: a GET or SET error degrades to compute-fresh,
//     never throws, and never serves a value it could not parse.

import { describe, expect, test } from "bun:test";
import {
	NoopResponseCache,
	MemoryResponseCache,
	RedisResponseCache,
} from "../services/response-cache.js";

describe("NoopResponseCache", () => {
	test("always recomputes (no caching)", async () => {
		const cache = new NoopResponseCache();
		let calls = 0;
		const compute = async () => ({ n: ++calls });
		expect(await cache.getOrSet("k", 60, compute)).toEqual({ n: 1 });
		expect(await cache.getOrSet("k", 60, compute)).toEqual({ n: 2 });
		expect(calls).toBe(2);
	});
});

describe("MemoryResponseCache", () => {
	test("serves a within-TTL hit without recomputing", async () => {
		const cache = new MemoryResponseCache(() => 1_000);
		let calls = 0;
		const compute = async () => ({ n: ++calls });
		expect(await cache.getOrSet("k", 30, compute)).toEqual({ n: 1 });
		expect(await cache.getOrSet("k", 30, compute)).toEqual({ n: 1 });
		expect(calls).toBe(1);
	});

	test("recomputes once the TTL has elapsed", async () => {
		let nowMs = 1_000;
		const cache = new MemoryResponseCache(() => nowMs);
		let calls = 0;
		const compute = async () => ({ n: ++calls });
		expect(await cache.getOrSet("k", 30, compute)).toEqual({ n: 1 });
		nowMs += 30_000; // exactly at expiry boundary (expiresAt is exclusive)
		expect(await cache.getOrSet("k", 30, compute)).toEqual({ n: 2 });
		expect(calls).toBe(2);
	});

	test("refreshes stale values after TTL while serving only fresh hits", async () => {
		let nowMs = 1_000;
		const cache = new MemoryResponseCache(() => nowMs);
		let version = 0;
		const compute = async () => ({ version: ++version });

		const first = await cache.getOrSet("workspace:ws-1:user:u-1", 30, compute);
		nowMs += 29_999;
		const withinTtl = await cache.getOrSet("workspace:ws-1:user:u-1", 30, compute);
		nowMs += 1;
		const refreshed = await cache.getOrSet("workspace:ws-1:user:u-1", 30, compute);

		expect(first).toEqual({ version: 1 });
		expect(withinTtl).toEqual(first);
		expect(refreshed).toEqual({ version: 2 });
		expect(version).toBe(2);
	});

	test("ttl <= 0 disables caching (recomputes, stores nothing)", async () => {
		const cache = new MemoryResponseCache(() => 1_000);
		let calls = 0;
		const compute = async () => ({ n: ++calls });
		expect(await cache.getOrSet("k", 0, compute)).toEqual({ n: 1 });
		expect(await cache.getOrSet("k", 0, compute)).toEqual({ n: 2 });
		expect(calls).toBe(2);
	});

	test("distinct keys do not collide", async () => {
		const cache = new MemoryResponseCache(() => 0);
		expect(await cache.getOrSet("a", 30, async () => "A")).toBe("A");
		expect(await cache.getOrSet("b", 30, async () => "B")).toBe("B");
		expect(await cache.getOrSet("a", 30, async () => "A2")).toBe("A");
	});

	test("workspace/user-scoped keys never share cached bodies", async () => {
		const cache = new MemoryResponseCache(() => 1_000);
		const calls: string[] = [];
		const load = (workspaceId: string, userId: string, marker: string) =>
			cache.getOrSet(`dashboard:${workspaceId}:viewer:${userId}`, 30, async () => {
				calls.push(`${workspaceId}/${userId}`);
				return { workspaceId, userId, marker };
			});

		const first = await load("ws-1", "user-a", "first");
		const sameIdentity = await load("ws-1", "user-a", "ignored");
		const otherUser = await load("ws-1", "user-b", "other-user");
		const otherWorkspace = await load("ws-2", "user-a", "other-workspace");

		expect(sameIdentity).toEqual(first);
		expect(otherUser).toEqual({ workspaceId: "ws-1", userId: "user-b", marker: "other-user" });
		expect(otherWorkspace).toEqual({ workspaceId: "ws-2", userId: "user-a", marker: "other-workspace" });
		expect(calls).toEqual(["ws-1/user-a", "ws-1/user-b", "ws-2/user-a"]);
	});

	test("returns a structural copy, not a shared reference (JSON round-trip)", async () => {
		const cache = new MemoryResponseCache(() => 0);
		const first = await cache.getOrSet("k", 30, async () => ({ list: [1, 2] }));
		(first as { list: number[] }).list.push(99); // mutate the caller's copy
		const second = await cache.getOrSet("k", 30, async () => ({ list: [1, 2] }));
		expect(second).toEqual({ list: [1, 2] }); // cached entry is unaffected
	});

	test("upstream compute errors are not cached; a later success can populate the key", async () => {
		const cache = new MemoryResponseCache(() => 1_000);
		let calls = 0;

		await expect(cache.getOrSet("upstream", 30, async () => {
			calls++;
			throw new Error("upstream failed");
		})).rejects.toThrow("upstream failed");

		const retry = await cache.getOrSet("upstream", 30, async () => ({ ok: true, calls: ++calls }));
		const cached = await cache.getOrSet("upstream", 30, async () => ({ ok: false, calls: ++calls }));

		expect(retry).toEqual({ ok: true, calls: 2 });
		expect(cached).toEqual(retry);
		expect(calls).toBe(2);
	});
});

describe("RedisResponseCache (fail-open)", () => {
	function memoryRedisClient() {
		const values = new Map<string, string>();
		const sent: Array<{ cmd: string; args: string[] }> = [];
		const client = {
			send: async (cmd: string, args: string[] = []) => {
				sent.push({ cmd, args });
				if (cmd === "GET") return values.get(args[0] ?? "") ?? null;
				if (cmd === "SET") {
					values.set(args[0] ?? "", args[1] ?? "");
					return "OK";
				}
				return null;
			},
		};
		return { client, sent, values };
	}

	test("returns a parsed hit on GET", async () => {
		const client = {
			send: async (cmd: string) => (cmd === "GET" ? JSON.stringify({ cached: true }) : null),
		};
		let calls = 0;
		const val = await new RedisResponseCache(client).getOrSet("k", 30, async () => {
			calls++;
			return { cached: false };
		});
		expect(val).toEqual({ cached: true });
		expect(calls).toBe(0); // compute never ran on a hit
	});

	test("on a miss, computes and writes SET with EX ttl", async () => {
		const sent: Array<{ cmd: string; args: string[] }> = [];
		const client = {
			send: async (cmd: string, args: string[]) => {
				sent.push({ cmd, args });
				return cmd === "GET" ? null : "OK";
			},
		};
		const val = await new RedisResponseCache(client).getOrSet("k", 45, async () => ({ fresh: 1 }));
		expect(val).toEqual({ fresh: 1 });
		const set = sent.find((s) => s.cmd === "SET");
		expect(set).toBeDefined();
		// args: [prefixedKey, jsonValue, "EX", ttlString]
		expect(set!.args[0]).toBe("rcache:k");
		expect(set!.args[2]).toBe("EX");
		expect(set!.args[3]).toBe("45");
	});

	test("workspace/user-scoped keys are isolated in Redis storage", async () => {
		const { client, sent } = memoryRedisClient();
		const cache = new RedisResponseCache(client);
		const calls: string[] = [];
		const load = (workspaceId: string, userId: string, marker: string) =>
			cache.getOrSet(`dashboard:${workspaceId}:viewer:${userId}`, 30, async () => {
				calls.push(`${workspaceId}/${userId}`);
				return { workspaceId, userId, marker };
			});

		const first = await load("ws-1", "user-a", "first");
		const sameIdentity = await load("ws-1", "user-a", "ignored");
		const otherUser = await load("ws-1", "user-b", "other-user");
		const otherWorkspace = await load("ws-2", "user-a", "other-workspace");

		expect(sameIdentity).toEqual(first);
		expect(otherUser).toEqual({ workspaceId: "ws-1", userId: "user-b", marker: "other-user" });
		expect(otherWorkspace).toEqual({ workspaceId: "ws-2", userId: "user-a", marker: "other-workspace" });
		expect(calls).toEqual(["ws-1/user-a", "ws-1/user-b", "ws-2/user-a"]);
		expect(sent.filter((s) => s.cmd === "SET").map((s) => s.args[0])).toEqual([
			"rcache:dashboard:ws-1:viewer:user-a",
			"rcache:dashboard:ws-1:viewer:user-b",
			"rcache:dashboard:ws-2:viewer:user-a",
		]);
	});

	test("a GET error degrades to compute-fresh (does not throw)", async () => {
		const client = {
			send: async (cmd: string) => {
				if (cmd === "GET") throw new Error("redis down");
				return "OK";
			},
		};
		const val = await new RedisResponseCache(client).getOrSet("k", 30, async () => ({ ok: 1 }));
		expect(val).toEqual({ ok: 1 });
	});

	test("a SET error still returns the freshly computed value", async () => {
		const client = {
			send: async (cmd: string) => {
				if (cmd === "GET") return null;
				throw new Error("redis write failed");
			},
		};
		const val = await new RedisResponseCache(client).getOrSet("k", 30, async () => ({ ok: 2 }));
		expect(val).toEqual({ ok: 2 });
	});

	test("upstream compute errors are not cached or written; the next success is cached", async () => {
		const { client, sent } = memoryRedisClient();
		const cache = new RedisResponseCache(client);
		let calls = 0;

		await expect(cache.getOrSet("upstream", 30, async () => {
			calls++;
			throw new Error("upstream failed");
		})).rejects.toThrow("upstream failed");
		expect(sent.filter((s) => s.cmd === "SET")).toHaveLength(0);

		const retry = await cache.getOrSet("upstream", 30, async () => ({ ok: true, calls: ++calls }));
		const cached = await cache.getOrSet("upstream", 30, async () => ({ ok: false, calls: ++calls }));

		expect(retry).toEqual({ ok: true, calls: 2 });
		expect(cached).toEqual(retry);
		expect(calls).toBe(2);
		expect(sent.filter((s) => s.cmd === "SET")).toHaveLength(1);
	});

	test("a non-string GET result is treated as a miss (no crash)", async () => {
		const client = {
			send: async (cmd: string) => (cmd === "GET" ? 12345 : "OK"),
		};
		const val = await new RedisResponseCache(client).getOrSet("k", 30, async () => ({ ok: 3 }));
		expect(val).toEqual({ ok: 3 });
	});

	test("ttl <= 0 bypasses Redis entirely (no GET, no SET) and computes fresh", async () => {
		const sent: string[] = [];
		const client = {
			send: async (cmd: string) => {
				sent.push(cmd);
				return cmd === "GET" ? null : "OK";
			},
		};
		let calls = 0;
		const val = await new RedisResponseCache(client).getOrSet("k", 0, async () => ({ n: ++calls }));
		expect(val).toEqual({ n: 1 });
		expect(sent).toEqual([]); // never touched Redis
		expect(calls).toBe(1);
	});

	test("ttl is floored and forced to a minimum of 1 second", async () => {
		const sent: string[][] = [];
		const client = {
			send: async (cmd: string, args: string[]) => {
				sent.push(args);
				return cmd === "GET" ? null : "OK";
			},
		};
		await new RedisResponseCache(client).getOrSet("k", 0.4, async () => ({}));
		const set = sent.find((a) => a[2] === "EX");
		expect(set![3]).toBe("1");
	});
});

// Per-key in-process single-flight: on a TTL-expiry miss, N concurrent callers for
// the SAME key must trigger compute() ONCE (no thundering herd against the DB),
// all receive the value, a compute rejection must propagate to every waiter WITHOUT
// poisoning the key (next call retries), and DIFFERENT keys never coalesce. Verified
// for both MemoryResponseCache and the fail-open RedisResponseCache.

/** Resolves only after `count` callers have entered compute(); proves NO coalescing. */
function gate(count: number) {
	let arrived = 0;
	let release!: () => void;
	const open = new Promise<void>((r) => (release = r));
	return {
		// Awaiting this inside compute blocks until `count` distinct callers arrive.
		async wait() {
			if (++arrived >= count) release();
			await open;
		},
	};
}

describe("MemoryResponseCache (single-flight coalescing)", () => {
	test("N concurrent callers for one key compute ONCE and all get the value", async () => {
		const cache = new MemoryResponseCache(() => 1_000);
		let calls = 0;
		const value = await Promise.all(
			Array.from({ length: 8 }, () =>
				cache.getOrSet("k", 30, async () => {
					calls++;
					await Promise.resolve(); // yield so all 8 are in-flight together
					return { n: 42 };
				}),
			),
		);
		expect(calls).toBe(1);
		for (const v of value) expect(v).toEqual({ n: 42 });
	});

	test("concurrent duplicate identity requests coalesce without crossing user keys", async () => {
		const cache = new MemoryResponseCache(() => 1_000);
		const calls: string[] = [];
		const duplicateKey = "dashboard:ws-1:viewer:user-a";
		const otherUserKey = "dashboard:ws-1:viewer:user-b";

		const results = await Promise.all([
			...Array.from({ length: 6 }, () =>
				cache.getOrSet(duplicateKey, 30, async () => {
					calls.push("ws-1/user-a");
					await Promise.resolve();
					return { workspaceId: "ws-1", userId: "user-a" };
				}),
			),
			cache.getOrSet(otherUserKey, 30, async () => {
				calls.push("ws-1/user-b");
				await Promise.resolve();
				return { workspaceId: "ws-1", userId: "user-b" };
			}),
		]);

		expect(results.slice(0, 6).every((r) => r.userId === "user-a")).toBe(true);
		expect(results[6]).toEqual({ workspaceId: "ws-1", userId: "user-b" });
		expect(calls.sort()).toEqual(["ws-1/user-a", "ws-1/user-b"]);
	});

	test("compute rejection propagates to ALL waiters and does not poison the key", async () => {
		const cache = new MemoryResponseCache(() => 1_000);
		let calls = 0;
		const boom = Array.from({ length: 5 }, () =>
			cache.getOrSet("k", 30, async () => {
				calls++;
				await Promise.resolve();
				throw new Error("compute failed");
			}),
		);
		const results = await Promise.allSettled(boom);
		expect(results.every((r) => r.status === "rejected")).toBe(true);
		expect(calls).toBe(1); // all five coalesced onto one (failed) compute

		// The failed flight was cleared on settle: the next call retries (fail-open).
		// A successful retry returning its OWN value proves the key was not poisoned.
		let retried = false;
		const retry = await cache.getOrSet("k", 30, async () => {
			retried = true;
			return { ok: true };
		});
		expect(retried).toBe(true);
		expect(retry).toEqual({ ok: true });
	});

	test("different keys do NOT coalesce (each computes independently)", async () => {
		const cache = new MemoryResponseCache(() => 1_000);
		const g = gate(2); // resolves only once BOTH compute()s run concurrently
		const [a, b] = await Promise.all([
			cache.getOrSet("a", 30, async () => {
				await g.wait();
				return "A";
			}),
			cache.getOrSet("b", 30, async () => {
				await g.wait();
				return "B";
			}),
		]);
		expect(a).toBe("A");
		expect(b).toBe("B");
	});
});

describe("RedisResponseCache (single-flight coalescing, fail-open)", () => {
	test("N concurrent miss callers for one key compute ONCE; one GET, one SET", async () => {
		const sent: string[] = [];
		const client = {
			send: async (cmd: string) => {
				sent.push(cmd);
				return cmd === "GET" ? null : "OK"; // always a miss
			},
		};
		let calls = 0;
		const cache = new RedisResponseCache(client);
		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				cache.getOrSet("k", 30, async () => {
					calls++;
					await Promise.resolve();
					return { fresh: true };
				}),
			),
		);
		expect(calls).toBe(1);
		for (const r of results) expect(r).toEqual({ fresh: true });
		expect(sent.filter((c) => c === "GET")).toHaveLength(1); // coalesced: a single GET
		expect(sent.filter((c) => c === "SET")).toHaveLength(1); // and a single SET
	});

	test("a GET error still degrades to a SINGLE coalesced compute (fail-open preserved)", async () => {
		const client = {
			send: async (cmd: string) => {
				if (cmd === "GET") throw new Error("redis down");
				return "OK";
			},
		};
		let calls = 0;
		const cache = new RedisResponseCache(client);
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				cache.getOrSet("k", 30, async () => {
					calls++;
					await Promise.resolve();
					return { ok: 1 };
				}),
			),
		);
		expect(calls).toBe(1); // coalescing did not turn a GET error into a herd
		for (const r of results) expect(r).toEqual({ ok: 1 });
	});

	test("compute rejection propagates to all waiters and the key retries next call", async () => {
		const client = { send: async (cmd: string) => (cmd === "GET" ? null : "OK") };
		let calls = 0;
		const cache = new RedisResponseCache(client);
		const boom = Array.from({ length: 4 }, () =>
			cache.getOrSet("k", 30, async () => {
				calls++;
				await Promise.resolve();
				throw new Error("compute failed");
			}),
		);
		const settled = await Promise.allSettled(boom);
		expect(settled.every((r) => r.status === "rejected")).toBe(true);
		expect(calls).toBe(1);
		// Not poisoned: next call recomputes successfully via its own compute.
		let retried = false;
		const retry = await cache.getOrSet("k", 30, async () => {
			retried = true;
			return { ok: 2 };
		});
		expect(retried).toBe(true);
		expect(retry).toEqual({ ok: 2 });
	});

	test("different keys do NOT coalesce", async () => {
		const client = { send: async (cmd: string) => (cmd === "GET" ? null : "OK") };
		const cache = new RedisResponseCache(client);
		const g = gate(2);
		const [a, b] = await Promise.all([
			cache.getOrSet("a", 30, async () => {
				await g.wait();
				return "A";
			}),
			cache.getOrSet("b", 30, async () => {
				await g.wait();
				return "B";
			}),
		]);
		expect(a).toBe("A");
		expect(b).toBe("B");
	});
});
