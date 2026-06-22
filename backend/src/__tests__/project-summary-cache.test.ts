// Unit tests for the keyed LRU that fronts the project-summary listing
// (the hottest cached read: workspace Library / dashboard).
//
// Proves the four invariants that motivated replacing the old single-slot cache:
//   * KEYED (no thrash): two distinct users' entries coexist — neither overwrites
//     the other, so concurrent callers both hit (the bug that made a single slot
//     fall through to a full recompute on every second caller),
//   * INVALIDATION: a write-path `.clear()` drops every entry,
//   * TTL: an entry past its 1s TTL is a miss and is recomputed,
//   * CAP: past PROJECT_SUMMARY_CACHE_MAX_ENTRIES the least-recently-used entry
//     is evicted (and a recent read protects an entry from eviction).

import { describe, expect, test } from "bun:test";
import { ProjectSummaryCache } from "../services/project-summary-cache.js";

// A page is opaque to the cache; a tagged object is enough to assert identity.
function page(tag: string): { tag: string } {
	return { tag };
}

describe("ProjectSummaryCache — keyed coexistence (no thrash)", () => {
	test("two distinct keys (e.g. two users) coexist — neither overwrites the other", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 200, ttlMs: 1000, now: () => 0 });
		const userA = JSON.stringify({ userId: "alice", workspaceId: "" });
		const userB = JSON.stringify({ userId: "bob", workspaceId: "" });

		cache.set(userA, page("A"));
		cache.set(userB, page("B"));

		// Both still resolve to their own page — the single-slot bug would have
		// evicted A when B was written, so A would miss here.
		expect(cache.get(userA)?.tag).toBe("A");
		expect(cache.get(userB)?.tag).toBe("B");
		expect(cache.size).toBe(2);
	});

	test("re-listing the same key returns the cached page (hit)", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 200, ttlMs: 1000, now: () => 100 });
		const key = JSON.stringify({ userId: "alice", cursor: "" });
		cache.set(key, page("first"));
		expect(cache.get(key)?.tag).toBe("first");
	});

	test("a miss on an unknown key returns undefined", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 200, ttlMs: 1000, now: () => 0 });
		expect(cache.get("never-set")).toBeUndefined();
	});
});

describe("ProjectSummaryCache — write invalidation", () => {
	test("clear() drops every entry (a project write invalidates all keys)", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 200, ttlMs: 1000, now: () => 0 });
		cache.set("k1", page("1"));
		cache.set("k2", page("2"));
		expect(cache.size).toBe(2);

		cache.clear();

		expect(cache.size).toBe(0);
		expect(cache.get("k1")).toBeUndefined();
		expect(cache.get("k2")).toBeUndefined();
	});
});

describe("ProjectSummaryCache — TTL expiry", () => {
	test("an entry is served within the TTL and missed once it elapses", () => {
		let nowMs = 1_000;
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 200, ttlMs: 1000, now: () => nowMs });
		cache.set("k", page("v"));

		// Still inside the 1s window.
		nowMs = 1_999;
		expect(cache.get("k")?.tag).toBe("v");

		// At/after expiry (expiresAt = 2000, exclusive) it is a miss and is dropped.
		nowMs = 2_000;
		expect(cache.get("k")).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	test("ttlMs <= 0 disables caching (always misses, stores nothing)", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 200, ttlMs: 0, now: () => 0 });
		cache.set("k", page("v"));
		expect(cache.get("k")).toBeUndefined();
		expect(cache.size).toBe(0);
	});
});

describe("ProjectSummaryCache — LRU cap eviction", () => {
	test("past the cap the OLDEST (least-recently-used) entry is evicted", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 2, ttlMs: 1000, now: () => 0 });
		cache.set("k1", page("1"));
		cache.set("k2", page("2"));
		cache.set("k3", page("3")); // exceeds cap → evicts k1 (oldest)

		expect(cache.size).toBe(2);
		expect(cache.get("k1")).toBeUndefined();
		expect(cache.get("k2")?.tag).toBe("2");
		expect(cache.get("k3")?.tag).toBe("3");
	});

	test("a recent READ refreshes recency, protecting an entry from eviction", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 2, ttlMs: 1000, now: () => 0 });
		cache.set("k1", page("1"));
		cache.set("k2", page("2"));

		// Touch k1 so it becomes most-recent; k2 is now the oldest.
		expect(cache.get("k1")?.tag).toBe("1");

		cache.set("k3", page("3")); // evicts k2 (now oldest), not k1
		expect(cache.get("k1")?.tag).toBe("1");
		expect(cache.get("k2")).toBeUndefined();
		expect(cache.get("k3")?.tag).toBe("3");
	});

	test("re-setting an existing key updates its page and refreshes recency (no growth)", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 2, ttlMs: 1000, now: () => 0 });
		cache.set("k1", page("1"));
		cache.set("k2", page("2"));
		cache.set("k1", page("1-updated")); // re-set: stays size 2, k1 now newest

		expect(cache.size).toBe(2);
		expect(cache.get("k1")?.tag).toBe("1-updated");

		cache.set("k3", page("3")); // evicts k2 (oldest), k1 survives
		expect(cache.get("k1")?.tag).toBe("1-updated");
		expect(cache.get("k2")).toBeUndefined();
	});

	test("maxEntries <= 0 disables caching (always misses)", () => {
		const cache = new ProjectSummaryCache<{ tag: string }>({ maxEntries: 0, ttlMs: 1000, now: () => 0 });
		cache.set("k", page("v"));
		expect(cache.get("k")).toBeUndefined();
		expect(cache.size).toBe(0);
	});
});
