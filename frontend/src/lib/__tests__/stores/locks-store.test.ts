// Locks store tests (W2.7) — TTL expiry + SSE event handling.

import { describe, it, expect, beforeEach, vi } from "vitest";

// C4: the indicator must not render for a lock held by THIS very tab. The store
// compares lock.owner to the current user id and lock.clientId to this tab's
// editSession clientId — mock both so the self-filter is deterministic. `vi.hoisted`
// makes the shared mock object available to the hoisted vi.mock factory.
const mockAuth = vi.hoisted(() => ({ currentUser: null as { id: string } | null }));
vi.mock("$lib/stores/auth.svelte.ts", () => ({ authStore: mockAuth }));
vi.mock("$lib/stores/edit-session.svelte.ts", () => ({ editSessionStore: { clientId: "tab-self" } }));

import { locksStore } from "$lib/stores/locks.svelte.ts";
import { realtimeStore, type RealtimeEvent } from "$lib/stores/realtime.svelte.ts";

function lockAcquired(data: Record<string, unknown>, emittedAt = Date.now()): RealtimeEvent {
	return {
		id: `${emittedAt}-acq`,
		kind: "lock_acquired",
		workspaceId: "ws-1",
		emittedAt,
		data,
	};
}

function lockReleased(lockId: string): RealtimeEvent {
	return {
		id: `${Date.now()}-rel`,
		kind: "lock_released",
		workspaceId: "ws-1",
		emittedAt: Date.now(),
		data: { lockId },
	};
}

// Dispatch a synthetic SSE frame to the store via the realtime store's dispatch.
function emit(event: RealtimeEvent): void {
	// @ts-expect-error reach the private dispatch for test injection
	realtimeStore.dispatch(event);
}

describe("LocksStore", () => {
	beforeEach(() => {
		mockAuth.currentUser = null;
		locksStore.__resetForTesting();
		locksStore.wireToRealtime();
	});

	it("registers a lock on lock_acquired and exposes it by scope", () => {
		emit(lockAcquired({ lockId: "l-1", scope: "page", scopeId: "p-1", owner: "Aya", expiresAt: Date.now() + 60_000 }));
		const lock = locksStore.getByScope("page", "p-1");
		expect(lock?.lockId).toBe("l-1");
		expect(lock?.owner).toBe("Aya");
		expect(locksStore.all.length).toBe(1);
	});

	it("removes a lock on lock_released", () => {
		emit(lockAcquired({ lockId: "l-2", scope: "page", scopeId: "p-2", expiresAt: Date.now() + 60_000 }));
		expect(locksStore.getByScope("page", "p-2")).toBeDefined();
		emit(lockReleased("l-2"));
		expect(locksStore.getByScope("page", "p-2")).toBeUndefined();
		expect(locksStore.all.length).toBe(0);
	});

	it("hides a lock once its TTL has elapsed even without a release event", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		emit(lockAcquired({ lockId: "l-3", scope: "page", scopeId: "p-3", expiresAt: now + 1000 }, now));
		expect(locksStore.getByScope("page", "p-3")).toBeDefined();
		expect(locksStore.all.length).toBe(1);

		// Advance past expiry — read accessors must treat it as gone.
		vi.spyOn(Date, "now").mockReturnValue(now + 2000);
		expect(locksStore.getByScope("page", "p-3")).toBeUndefined();
		expect(locksStore.all.length).toBe(0);
		vi.restoreAllMocks();
	});

	it("prunes expired locks from the backing map on sweep", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		emit(lockAcquired({ lockId: "l-4", scope: "page", scopeId: "p-4", expiresAt: now + 1000 }, now));
		emit(lockAcquired({ lockId: "l-5", scope: "page", scopeId: "p-5", expiresAt: now + 999_000 }, now));

		vi.spyOn(Date, "now").mockReturnValue(now + 2000);
		locksStore.__pruneExpiredForTesting();
		// Expired entry physically removed; the long-lived one stays.
		expect(locksStore.locks.has("l-4")).toBe(false);
		expect(locksStore.locks.has("l-5")).toBe(true);
		vi.restoreAllMocks();
	});

	it("keeps locks without an expiresAt until explicitly released", () => {
		emit(lockAcquired({ lockId: "l-6", scope: "subject", scopeId: "s-6" }));
		locksStore.__pruneExpiredForTesting();
		expect(locksStore.getByScope("subject", "s-6")).toBeDefined();
	});

	// C4: self-tab presence suppression.
	it("hides a lock held by THIS user's THIS tab from the presence overlay", () => {
		mockAuth.currentUser = { id: "user-me" };
		emit(lockAcquired({ lockId: "l-self", scope: "page", scopeId: "p-self", owner: "user-me", clientId: "tab-self", expiresAt: Date.now() + 60_000 }));
		// The editing tab must NOT see "you are editing" pointing at itself.
		expect(locksStore.getByScope("page", "p-self")).toBeUndefined();
		expect(locksStore.all.length).toBe(0);
	});

	it("STILL shows a lock held by the same user's OTHER tab (genuinely another session)", () => {
		mockAuth.currentUser = { id: "user-me" };
		emit(lockAcquired({ lockId: "l-other-tab", scope: "page", scopeId: "p-x", owner: "user-me", clientId: "tab-elsewhere", expiresAt: Date.now() + 60_000 }));
		expect(locksStore.getByScope("page", "p-x")?.lockId).toBe("l-other-tab");
	});

	it("STILL shows a lock held by ANOTHER user", () => {
		mockAuth.currentUser = { id: "user-me" };
		emit(lockAcquired({ lockId: "l-them", scope: "page", scopeId: "p-y", owner: "user-them", clientId: "tab-self", expiresAt: Date.now() + 60_000 }));
		// Same clientId string but a different owner → not self → shown.
		expect(locksStore.getByScope("page", "p-y")?.lockId).toBe("l-them");
	});
});
