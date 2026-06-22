import { describe, expect, test } from "bun:test";
import { PRESENCE_TTL_MS, PresenceStore } from "../services/presence.js";

function storeWithClock() {
	let now = 1_000_000;
	const store = new PresenceStore(() => now);
	return { store, advance: (ms: number) => { now += ms; }, setNow: (value: number) => { now = value; } };
}

describe("PresenceStore", () => {
	test("a heartbeat surfaces to OTHER users but never to self", () => {
		const { store } = storeWithClock();
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "0", projectId: "p1" });

		// Self sees no one else.
		expect(store.listForScope({ projectId: "p1", scope: "page", scopeId: "0", excludeUserId: "u1" })).toHaveLength(0);
		// A second user sees Ann.
		const others = store.listForScope({ projectId: "p1", scope: "page", scopeId: "0", excludeUserId: "u2" });
		expect(others).toHaveLength(1);
		// The exposed entry carries the non-PII display name + scope only — never userId.
		expect(others[0]).toMatchObject({ name: "Ann", scope: "page", scopeId: "0" });
		expect(others[0]).not.toHaveProperty("userId");
	});

	test("pings expire after the TTL and are pruned", () => {
		const { store, advance } = storeWithClock();
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "0", projectId: "p1" });

		advance(PRESENCE_TTL_MS - 1);
		expect(store.listForScope({ projectId: "p1", scope: "page", scopeId: "0", excludeUserId: "u2" })).toHaveLength(1);

		advance(2); // now strictly past the TTL
		expect(store.listForScope({ projectId: "p1", scope: "page", scopeId: "0", excludeUserId: "u2" })).toHaveLength(0);
		expect(store.size()).toBe(0);
	});

	test("a fresh heartbeat refreshes the TTL window", () => {
		const { store, advance } = storeWithClock();
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "0", projectId: "p1" });
		advance(PRESENCE_TTL_MS - 5);
		// Refresh before expiry.
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "0", projectId: "p1" });
		advance(10); // past the ORIGINAL window but inside the refreshed one
		expect(store.listForScope({ projectId: "p1", scope: "page", scopeId: "0", excludeUserId: "u2" })).toHaveLength(1);
	});

	test("scopes are isolated by project / scope / scopeId", () => {
		const { store } = storeWithClock();
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "0", projectId: "p1" });
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "1", projectId: "p1" });
		store.heartbeat({ userId: "u1", name: "Ann", scope: "task", scopeId: "0", projectId: "p1" });
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "0", projectId: "p2" });

		expect(store.listForScope({ projectId: "p1", scope: "page", scopeId: "0", excludeUserId: "x" })).toHaveLength(1);
		expect(store.listForScope({ projectId: "p1", scope: "page", scopeId: "1", excludeUserId: "x" })).toHaveLength(1);
		expect(store.listForScope({ projectId: "p1", scope: "task", scopeId: "0", excludeUserId: "x" })).toHaveLength(1);
		expect(store.listForScope({ projectId: "p2", scope: "page", scopeId: "0", excludeUserId: "x" })).toHaveLength(1);
	});

	test("clear removes a user's ping for a scope", () => {
		const { store } = storeWithClock();
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "0", projectId: "p1" });
		store.clear({ userId: "u1", scope: "page", scopeId: "0", projectId: "p1" });
		expect(store.listForScope({ projectId: "p1", scope: "page", scopeId: "0", excludeUserId: "x" })).toHaveLength(0);
	});

	test("the same user's latest heartbeat collapses to one entry per scope", () => {
		const { store, advance } = storeWithClock();
		store.heartbeat({ userId: "u1", name: "Ann", scope: "page", scopeId: "0", projectId: "p1" });
		advance(1000);
		store.heartbeat({ userId: "u1", name: "Ann (renamed)", scope: "page", scopeId: "0", projectId: "p1" });
		const others = store.listForScope({ projectId: "p1", scope: "page", scopeId: "0", excludeUserId: "x" });
		expect(others).toHaveLength(1);
		expect(others[0]?.name).toBe("Ann (renamed)");
	});
});
