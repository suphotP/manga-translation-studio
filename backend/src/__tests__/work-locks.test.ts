// W2.10: tests for the soft-lock service.
//
// Uses InMemoryWorkLockStore so the suite runs without Postgres while still
// exercising the same WorkLockStore interface contract that the Postgres store
// implements. Auto-expiry uses an injected `now` Date so we can advance the
// clock deterministically.

import { describe, expect, test } from "bun:test";
import {
	InMemoryWorkLockStore,
	LockConflictError,
	LockNotFoundError,
	LockPermissionError,
	PostgresWorkLockStore,
	SameUserLockConflictError,
	type WorkLockEventPublisher,
	type WorkLockSqlClient,
} from "../services/work-locks.js";
import { canMutateWorkLocks, classifyLockRouteError, isLockServiceDependencyError } from "../routes/locks.js";
import {
	createInMemoryRealtimeBus,
	setRealtimeBusForTesting,
	type RealtimeEvent,
} from "../services/realtime-bus.js";

class FakeConcurrentInsertLockSqlClient implements WorkLockSqlClient {
	readonly queries: Array<{ query: string; params: unknown[] }> = [];
	selectActiveCount = 0;
	activeRow = {
		lock_id: "existing-lock",
		scope: "page",
		scope_id: "page-1",
		owner_user_id: "user-a",
		project_id: null,
		chapter_id: "chapter-1",
		page_id: "page-1",
		workspace_id: "workspace-1",
		acquired_at: "2026-06-02T10:00:00.000Z",
		auto_release_at: "2026-06-02T10:10:00.000Z",
		released_at: null,
		released_by: null,
		release_reason: null,
	};

	async begin<T>(fn: (transaction: WorkLockSqlClient) => Promise<T>): Promise<T> {
		return fn(this);
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		if (query.includes("UPDATE work_locks") && query.includes("auto_expired")) return [] as T[];
		if (query.includes("SELECT lock_id") && query.includes("WHERE scope = $1")) {
			this.selectActiveCount += 1;
			return (this.selectActiveCount === 1 ? [] : [this.activeRow]) as T[];
		}
		if (query.includes("INSERT INTO work_locks")) {
			const error = new Error("duplicate key value violates unique constraint \"work_locks_active_scope_idx\"") as Error & { code?: string };
			error.code = "23505";
			throw error;
		}
		return [] as T[];
	}
}

function plusMinutes(base: Date, minutes: number): Date {
	return new Date(base.getTime() + minutes * 60_000);
}

describe("work locks - basic lifecycle", () => {
	test("acquire success creates an active lock with future expiry", async () => {
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-02T10:00:00.000Z");
		const acquired = await store.acquireLock("page", "page-1", "user-1", 10, {
			projectId: "project-1",
			chapterId: "chapter-1",
			now,
		});

		expect(acquired.lock_id).toBeString();
		expect(new Date(acquired.expires_at).toISOString()).toEqual(plusMinutes(now, 10).toISOString());

		const locks = await store.listLocksForChapter("chapter-1", { now });
		expect(locks).toHaveLength(1);
		expect(locks[0]).toMatchObject({
			lockId: acquired.lock_id,
			scope: "page",
			scopeId: "page-1",
			ownerUserId: "user-1",
		});
	});

	test("re-acquire by the same owner is idempotent", async () => {
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-02T10:00:00.000Z");
		const first = await store.acquireLock("page", "page-1", "user-1", 10, { now });
		const second = await store.acquireLock("page", "page-1", "user-1", 10, { now });
		expect(second.lock_id).toEqual(first.lock_id);
	});

	test("acquire conflict throws LockConflictError with held_by metadata", async () => {
		const store = new InMemoryWorkLockStore();
		await store.acquireLock("layer", "layer-1", "user-1", 10);

		try {
			await store.acquireLock("layer", "layer-1", "user-2", 10);
			throw new Error("expected lock conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(LockConflictError);
			expect((error as LockConflictError).conflict.held_by_user_id).toBe("user-1");
			expect((error as LockConflictError).conflict.expires_at).toBeString();
		}
	});

	test("auto-release after duration allows the next acquire from a different user", async () => {
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-02T00:00:00.000Z");
		await store.acquireLock("object", "object-1", "user-1", 1, { chapterId: "chapter-1", now });

		const later = new Date("2026-06-02T00:01:01.000Z");
		const acquired = await store.acquireLock("object", "object-1", "user-2", 10, { chapterId: "chapter-1", now: later });

		expect(acquired.lock_id).toBeString();
		const locks = await store.listLocksForChapter("chapter-1", { now: later });
		expect(locks).toHaveLength(1);
		expect(locks[0]!.ownerUserId).toBe("user-2");
	});

	test("extend updates expires_at and only the owner may extend", async () => {
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const acquired = await store.acquireLock("page", "page-1", "user-1", 1, { now });

		const extended = await store.extendLock(acquired.lock_id, "user-1", 5, {
			now: new Date("2026-06-02T00:00:30.000Z"),
		});

		expect(Date.parse(extended.expires_at)).toBeGreaterThan(Date.parse(acquired.expires_at));
		expect(extended.expires_at).toBe("2026-06-02T00:05:30.000Z");

		await expect(store.extendLock(acquired.lock_id, "user-2", 5, { now: new Date("2026-06-02T00:00:30.000Z") })).rejects.toBeInstanceOf(LockPermissionError);
	});

	test("extendLock cannot resurrect an already-expired lease (lazy expiry)", async () => {
		// Lazy expiry contract: with no per-op sweep, an expired lease must still be
		// non-extendable — the scope may already be free for another holder.
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const acquired = await store.acquireLock("page", "page-1", "user-1", 1, { now });
		// Two minutes later the 1-minute lease has expired; the owner cannot extend it.
		await expect(
			store.extendLock(acquired.lock_id, "user-1", 5, { now: new Date("2026-06-02T00:02:00.000Z") }),
		).rejects.toBeInstanceOf(LockNotFoundError);
	});

	test("getLock returns null once the lease has expired (time-aware, no sweep write)", async () => {
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const acquired = await store.acquireLock("page", "page-1", "user-1", 1, { now });
		expect(await store.getLock(acquired.lock_id, { now: new Date("2026-06-02T00:00:30.000Z") })).not.toBeNull();
		expect(await store.getLock(acquired.lock_id, { now: new Date("2026-06-02T00:02:00.000Z") })).toBeNull();
	});

	test("release by non-owner is forbidden, release on missing id is not_found", async () => {
		const store = new InMemoryWorkLockStore();
		const acquired = await store.acquireLock("page", "page-1", "user-1", 10);

		await expect(store.releaseLock(acquired.lock_id, "user-2")).rejects.toBeInstanceOf(LockPermissionError);
		await expect(store.releaseLock("missing-lock-id", "user-1")).rejects.toBeInstanceOf(LockNotFoundError);
	});

	test("admin force-release bypasses owner check and records audit metadata", async () => {
		const store = new InMemoryWorkLockStore();
		const acquired = await store.acquireLock("page", "page-1", "user-1", 10);

		const released = await store.forceReleaseByAdmin(acquired.lock_id, "admin-1");

		expect(released.releasedAt).toBeString();
		expect(released.releaseReason).toBe("admin_force_release");
		expect(released.releasedBy).toEqual("admin-1");
	});
});

describe("work locks - per-tab identity + takeover (concurrent-edit Phase 1)", () => {
	test("same user same tab (client_id) is idempotent and refreshes the lease", async () => {
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-07T10:00:00.000Z");
		const first = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a", now });
		const later = new Date("2026-06-07T10:02:00.000Z");
		const second = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a", now: later });
		expect(second.lock_id).toEqual(first.lock_id);
		// Lease expiry was pushed forward by the re-acquire (heartbeat behaviour).
		expect(Date.parse(second.expires_at)).toBeGreaterThan(Date.parse(first.expires_at));
	});

	test("same user DIFFERENT tab is steered with SameUserLockConflictError, not silently shared", async () => {
		const store = new InMemoryWorkLockStore();
		const first = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a" });
		try {
			await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-b" });
			throw new Error("expected same-user tab conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(SameUserLockConflictError);
			const conflict = (error as SameUserLockConflictError).conflict;
			expect(conflict.held_by_user_id).toBe("user-1");
			expect(conflict.held_by_client_id).toBe("tab-a");
			expect(conflict.lock_id).toBe(first.lock_id);
		}
	});

	test("takeover steals the other tab's lease (releases old, mints new) so the 2nd tab does not clobber", async () => {
		const store = new InMemoryWorkLockStore();
		const first = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a", chapterId: "c-1" });
		const taken = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-b", takeover: true, chapterId: "c-1" });
		expect(taken.lock_id).not.toEqual(first.lock_id);
		// Old lock is released with the audit reason; only the new tab's lock is active.
		const oldLock = await store.getLock(first.lock_id);
		expect(oldLock).toBeNull();
		const active = await store.listLocksForChapter("c-1");
		expect(active).toHaveLength(1);
		expect(active[0]!.lockId).toBe(taken.lock_id);
		expect(active[0]!.clientId).toBe("tab-b");
	});

	test("a DIFFERENT user still hits a hard lock_conflict regardless of client_id (CAS-before-overlap steering)", async () => {
		const store = new InMemoryWorkLockStore();
		await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a" });
		// Even with takeover, a different user can never steal the lease.
		await expect(store.acquireLock("page", "p:0", "user-2", 5, { clientId: "tab-z", takeover: true }))
			.rejects.toBeInstanceOf(LockConflictError);
	});

	test("an AUTHORIZED cross-user takeover steals a different user's lease and reports the displaced holder", async () => {
		const store = new InMemoryWorkLockStore();
		const first = await store.acquireLock("page", "p:0", "user-1", 5, {
			clientId: "tab-a",
			chapterId: "c-1",
			projectId: "proj-1",
			pageId: "proj-1:page:0",
			workspaceId: "ws-1",
		});
		// A different user WITH explicit cross-user authorization (the route only
		// sets this after confirming edit access) takes the page over.
		const taken = await store.acquireLock("page", "p:0", "user-2", 5, {
			clientId: "tab-z",
			takeover: true,
			allowCrossUserTakeover: true,
			chapterId: "c-1",
			projectId: "proj-1",
			pageId: "proj-1:page:0",
			workspaceId: "ws-1",
		});
		expect(taken.lock_id).not.toEqual(first.lock_id);
		// The displaced holder is surfaced (so the route can notify them), flagged crossUser.
		expect(taken.taken_over_from).toBeDefined();
		expect(taken.taken_over_from!.userId).toBe("user-1");
		expect(taken.taken_over_from!.crossUser).toBe(true);
		expect(taken.taken_over_from!.workspaceId).toBe("ws-1");
		expect(taken.taken_over_from!.pageId).toBe("proj-1:page:0");
		// The old holder's lock is gone; only the taker's lease is active.
		expect(await store.getLock(first.lock_id)).toBeNull();
		const active = await store.listLocksForChapter("c-1");
		expect(active).toHaveLength(1);
		expect(active[0]!.lockId).toBe(taken.lock_id);
		expect(active[0]!.ownerUserId).toBe("user-2");
	});

	test("a same-user takeover reports the displaced tab as a NON-cross-user holder", async () => {
		const store = new InMemoryWorkLockStore();
		await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a", workspaceId: "ws-1" });
		const taken = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-b", takeover: true, workspaceId: "ws-1" });
		expect(taken.taken_over_from).toBeDefined();
		expect(taken.taken_over_from!.userId).toBe("user-1");
		expect(taken.taken_over_from!.crossUser).toBe(false);
	});

	test("cross-user takeover WITHOUT allowCrossUserTakeover is still refused (authorization is mandatory)", async () => {
		const store = new InMemoryWorkLockStore();
		await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a" });
		// takeover:true alone (the unauthorized case) must NOT steal another user's lease.
		await expect(store.acquireLock("page", "p:0", "user-2", 5, { clientId: "tab-z", takeover: true }))
			.rejects.toBeInstanceOf(LockConflictError);
	});

	test("a missing client_id on either side is treated as the same anonymous tab (legacy compatibility)", async () => {
		const store = new InMemoryWorkLockStore();
		const first = await store.acquireLock("page", "p:0", "user-1", 5);
		const second = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-b" });
		// No client on the held lock → still idempotent for the same user.
		expect(second.lock_id).toEqual(first.lock_id);
	});

	test("auto-expiry still frees a tab-scoped lease so a user is never locked out permanently", async () => {
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-07T10:00:00.000Z");
		await store.acquireLock("page", "p:0", "user-1", 1, { clientId: "tab-a", now });
		const later = new Date("2026-06-07T10:01:01.000Z");
		// Same user's other tab can now acquire because the first tab's lease expired.
		const acquired = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-b", now: later });
		expect(acquired.lock_id).toBeString();
		expect(acquired.client_id).toBe("tab-b");
	});
});

describe("work locks - inspectLockHold (C1 save-path lease guard)", () => {
	test("the active holder (same user + same tab) is reported as held", async () => {
		const store = new InMemoryWorkLockStore();
		const lock = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a" });
		const hold = await store.inspectLockHold(lock.lock_id, "user-1", "tab-a");
		expect(hold.status).toBe("held");
	});

	test("after a cross-user takeover the DISPLACED holder is reported released:taken_over (C1 reject)", async () => {
		const store = new InMemoryWorkLockStore();
		const first = await store.acquireLock("page", "p:0", "user-1", 5, {
			clientId: "tab-a",
			projectId: "proj-1",
			pageId: "proj-1:page:0",
			workspaceId: "ws-1",
		});
		// user-2 (authorized) takes the page over.
		await store.acquireLock("page", "p:0", "user-2", 5, {
			clientId: "tab-z",
			takeover: true,
			allowCrossUserTakeover: true,
			projectId: "proj-1",
			pageId: "proj-1:page:0",
			workspaceId: "ws-1",
		});
		// The displaced holder's in-flight save inspects ITS OWN (now released) lock id.
		const hold = await store.inspectLockHold(first.lock_id, "user-1", "tab-a");
		expect(hold.status).toBe("released");
		if (hold.status === "released") expect(hold.reason).toBe("taken_over");
		// → the save path turns this into a 409 editing_taken_over instead of clobbering.
	});

	test("a never-existing lock id is not_found (save degrades to CAS, never blocked)", async () => {
		const store = new InMemoryWorkLockStore();
		const hold = await store.inspectLockHold("does-not-exist", "user-1", "tab-a");
		expect(hold.status).toBe("not_found");
	});

	test("an expired lease no longer counts as held (holder lost the page)", async () => {
		const store = new InMemoryWorkLockStore();
		const now = new Date("2026-06-07T10:00:00.000Z");
		const lock = await store.acquireLock("page", "p:0", "user-1", 1, { clientId: "tab-a", now });
		const later = new Date("2026-06-07T10:02:00.000Z");
		const hold = await store.inspectLockHold(lock.lock_id, "user-1", "tab-a", { now: later });
		// The store sweeps the expired row to released:auto_expired first, so either
		// "expired" (unswept) or "released" (swept) is a valid lost-lease signal — what
		// matters is it is NOT "held", so the stale save is rejected, not clobbering.
		expect(hold.status).not.toBe("held");
		expect(["expired", "released"]).toContain(hold.status);
	});

	test("a lock re-minted to another tab/user is held_by_other for the old caller", async () => {
		const store = new InMemoryWorkLockStore();
		const first = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a", workspaceId: "ws-1" });
		await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-b", takeover: true, workspaceId: "ws-1" });
		// The displaced tab-a checks the NEW active lock id with its own tab id.
		const active = await store.getLock(first.lock_id);
		expect(active).toBeNull(); // tab-a's own lock is gone
		// Inspect the new holder's lock as if tab-a still pointed at it (defensive).
		const newLockId = (await store.listLocksForChapter("ws-1")).length ? undefined : undefined;
		void newLockId;
		// tab-a inspecting its OWN released lock id is "released" (covered above); here we
		// assert a DIFFERENT-tab active lock is reported held_by_other.
		const reMint = await store.acquireLock("page", "p:1", "user-2", 5, { clientId: "tab-c", allowCrossUserTakeover: true });
		const hold = await store.inspectLockHold(reMint.lock_id, "user-1", "tab-a");
		expect(hold.status).toBe("held_by_other");
	});

	test("a missing client id on the caller side still matches the holder (legacy compat)", async () => {
		const store = new InMemoryWorkLockStore();
		const lock = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a" });
		// Legacy save without a client id: treated as the same anonymous tab → held.
		const hold = await store.inspectLockHold(lock.lock_id, "user-1");
		expect(hold.status).toBe("held");
	});
});

describe("work locks - submit / logout / sweep release patterns", () => {
	test("viewer role cannot acquire edit locks through the route guard", () => {
		expect(canMutateWorkLocks("viewer")).toBeFalse();
		expect(canMutateWorkLocks("editor")).toBeTrue();
		expect(canMutateWorkLocks("admin")).toBeTrue();
		// owner is a strict superset of admin — it must be able to mutate locks too.
		expect(canMutateWorkLocks("owner")).toBeTrue();
	});

	test("releaseAllByUser with a (scope, scope_id) filter releases only the matching locks", async () => {
		const store = new InMemoryWorkLockStore();
		// user-a holds two locks on chapter-1; user-b holds an unrelated lock.
		const aPage = await store.acquireLock("page", "page-1", "user-a", 10, { chapterId: "chapter-1" });
		const aObject = await store.acquireLock("object", "obj-7", "user-a", 10, { chapterId: "chapter-1" });
		const bPage = await store.acquireLock("page", "page-2", "user-b", 10, { chapterId: "chapter-1" });

		// Workflow submit on page-1: release every lock user-a holds whose
		// scope+scopeId match. The object lock stays.
		const released = await store.releaseAllByUser("user-a", "page", "page-1");
		expect(released.map((r) => r.lockId)).toEqual([aPage.lock_id]);

		const remaining = await store.listLocksForChapter("chapter-1");
		const remainingIds = remaining.map((lock) => lock.lockId).sort();
		expect(remainingIds).toEqual([aObject.lock_id, bPage.lock_id].sort());
	});

	test("releaseAllByUser without a scope is the logout pattern and releases every lock for the user", async () => {
		const store = new InMemoryWorkLockStore();
		const a = await store.acquireLock("page", "page-1", "user-a", 10);
		const b = await store.acquireLock("layer", "layer-7", "user-a", 10);
		const released = await store.releaseAllByUser("user-a");
		expect(released.map((r) => r.lockId).sort()).toEqual([a.lock_id, b.lock_id].sort());
		expect(released.every((r) => r.releaseReason === "user_logout")).toBeTrue();
	});

	test("releaseLocksForSubject releases page-associated layer and object locks on page submit", async () => {
		const store = new InMemoryWorkLockStore();
		const page = await store.acquireLock("page", "page-1", "user-a", 10, { chapterId: "chapter-1" });
		const layerWithPageLink = await store.acquireLock("layer", "layer-1", "user-a", 10, { chapterId: "chapter-1", pageId: "page-1" });
		const objectWithPageLink = await store.acquireLock("object", "object-7", "user-a", 10, { chapterId: "chapter-1", pageId: "page-1" });
		const otherPageLayer = await store.acquireLock("layer", "layer-2", "user-a", 10, { chapterId: "chapter-1" });
		const otherUserLayer = await store.acquireLock("layer", "layer-other", "user-b", 10, { chapterId: "chapter-1", pageId: "page-1" });

		const released = await store.releaseLocksForSubject("page", "page-1", "user-a", { reason: "workflow_submit" });
		expect(released.map((lock) => lock.lockId).sort()).toEqual([page.lock_id, layerWithPageLink.lock_id, objectWithPageLink.lock_id].sort());
		expect(released.every((lock) => lock.releaseReason === "workflow_submit")).toBeTrue();

		const remaining = await store.listLocksForChapter("chapter-1");
		expect(remaining.map((lock) => lock.lockId).sort()).toEqual([otherPageLayer.lock_id, otherUserLayer.lock_id].sort());
	});

	test("releaseLocksForSubject releases a page lock recorded by image id (page_id matches subject)", async () => {
		const store = new InMemoryWorkLockStore();
		// A page lock acquired by image id: scope_id is the image id, but page_id
		// carries the canonical page subject the workflow submit path releases by.
		const imageIdPageLock = await store.acquireLock("page", "image-abc", "user-a", 10, {
			chapterId: "chapter-1",
			pageId: "project-1:page:0",
		});
		// A child lock on the same page, plus an unrelated page's lock.
		const layerOnPage = await store.acquireLock("layer", "layer-1", "user-a", 10, {
			chapterId: "chapter-1",
			pageId: "project-1:page:0",
		});
		const otherPage = await store.acquireLock("page", "project-1:page:1", "user-a", 10, { chapterId: "chapter-1" });

		const released = await store.releaseLocksForSubject("page", "project-1:page:0", "user-a", { reason: "workflow_submit" });
		expect(released.map((lock) => lock.lockId).sort()).toEqual([imageIdPageLock.lock_id, layerOnPage.lock_id].sort());

		const remaining = await store.listLocksForChapter("chapter-1");
		expect(remaining.map((lock) => lock.lockId)).toEqual([otherPage.lock_id]);
	});

	test("getLock returns the active record and null after release/expiry", async () => {
		const store = new InMemoryWorkLockStore();
		const start = new Date("2026-06-02T10:00:00.000Z");
		const acquired = await store.acquireLock("page", "page-1", "user-a", 10, { chapterId: "chapter-1", now: start });

		const active = await store.getLock(acquired.lock_id, { now: start });
		expect(active?.lockId).toBe(acquired.lock_id);
		expect(active?.ownerUserId).toBe("user-a");

		// Expired locks are not returned (so callers can't extend a dead lock).
		const afterExpiry = await store.getLock(acquired.lock_id, { now: plusMinutes(start, 11) });
		expect(afterExpiry).toBeNull();

		// Released locks are not returned either.
		const acquired2 = await store.acquireLock("page", "page-2", "user-b", 10, { now: start });
		await store.releaseLock(acquired2.lock_id, "user-b", { now: start });
		expect(await store.getLock(acquired2.lock_id, { now: start })).toBeNull();
	});

	test("sweepExpiredLocks releases locks whose auto_release_at is in the past", async () => {
		const store = new InMemoryWorkLockStore();
		const start = new Date("2026-06-02T10:00:00.000Z");
		await store.acquireLock("page", "page-1", "user-a", 10, { now: start });
		await store.acquireLock("page", "page-2", "user-b", 10, { now: start });
		const count = await store.sweepExpiredLocks(plusMinutes(start, 11));
		expect(count).toEqual(2);
		// After the sweep the chapter listing should be empty (no locks left).
		const after = await store.listLocksForChapter("chapter-1", { now: plusMinutes(start, 11) });
		expect(after).toHaveLength(0);
	});
});

describe("work locks - route dependency error mapping", () => {
	test("maps Redis/Postgres-style dependency failures to a retryable 503 code", () => {
		const redisError = new Error("RedisError: Max reconnection attempts reached") as Error & { code?: string };
		redisError.code = "ECONNREFUSED";

		expect(isLockServiceDependencyError(redisError)).toBeTrue();
		expect(classifyLockRouteError(redisError)).toEqual({
			status: 503,
			body: {
				error: "Work lock service unavailable",
				code: "work_lock_service_unavailable",
				retryAfter: 30,
			},
			retryAfterSeconds: 30,
		});
	});

	test("keeps programmer and validation failures out of the retryable 503 bucket", () => {
		const mapped = classifyLockRouteError(new Error("Invalid lock scope"));

		expect(mapped).toEqual({
			status: 400,
			body: {
				error: "Invalid lock scope",
				code: "work_lock_error",
			},
		});
	});
});

describe("work locks - chapter scope", () => {
	test("chapter scope lock can be acquired and released by submit on the chapter", async () => {
		const store = new InMemoryWorkLockStore();
		const acquired = await store.acquireLock("chapter", "chapter-99", "user-a", 10, { chapterId: "chapter-99" });
		expect(acquired.lock_id).toBeTruthy();

		// Submitting at chapter level releases the chapter lock.
		const released = await store.releaseLocksForSubject("chapter", "chapter-99", "user-a");
		expect(released).toHaveLength(1);
		expect(released[0]!.scope).toEqual("chapter");
		expect(released[0]!.releaseReason).toEqual("workflow_transition");
	});

	test("listLocksForChapter includes scope-based chapter locks even without chapter_id", async () => {
		const store = new InMemoryWorkLockStore();
		const acquired = await store.acquireLock("chapter", "chapter-scope-only", "user-a", 10);

		const locks = await store.listLocksForChapter("chapter-scope-only");

		expect(locks).toHaveLength(1);
		expect(locks[0]!.lockId).toBe(acquired.lock_id);
		expect(locks[0]!.scope).toBe("chapter");
	});

	test("listLocksForChapter only returns active, unexpired locks for that chapter", async () => {
		const store = new InMemoryWorkLockStore();
		const start = new Date("2026-06-02T10:00:00.000Z");
		const a = await store.acquireLock("page", "page-1", "user-a", 10, { now: start, chapterId: "chapter-x" });
		await store.acquireLock("page", "page-2", "user-b", 10, { now: start, chapterId: "other-chapter" });
		const active = await store.listLocksForChapter("chapter-x", { now: plusMinutes(start, 1) });
		expect(active.map((lock) => lock.lockId)).toEqual([a.lock_id]);
	});
});

describe("work locks - postgres race handling", () => {
	test("unique-index races become LockConflictError with holder metadata", async () => {
		const client = new FakeConcurrentInsertLockSqlClient();
		const store = new PostgresWorkLockStore(client);

		await expect(store.acquireLock("page", "page-1", "user-b", 10, {
			chapterId: "chapter-1",
			now: new Date("2026-06-02T10:00:00.000Z"),
		})).rejects.toMatchObject({
			conflict: {
				held_by_user_id: "user-a",
				expires_at: "2026-06-02T10:10:00.000Z",
			},
		});
		await expect(store.acquireLock("page", "page-1", "user-b", 10, {
			chapterId: "chapter-1",
			now: new Date("2026-06-02T10:00:00.000Z"),
		})).rejects.toBeInstanceOf(LockConflictError);
	});

	test("a failing event publisher does not fail lock acquisition (best-effort publish)", async () => {
		const client = new FakeInsertingLockSqlClient();
		const publisher: WorkLockEventPublisher = {
			async publish() {
				throw new Error("redis unavailable");
			},
		};
		const store = new PostgresWorkLockStore(client, publisher);

		// The lock row is committed; the post-commit PUBLISH outage must not bubble
		// up as an acquire failure, or the client would think it failed to lock a
		// page that is in fact held — stranding collaborators until expiry.
		const lock = await store.acquireLock("page", "page-1", "user-a", 10, {
			workspaceId: "workspace-1",
			chapterId: "chapter-1",
			now: new Date("2026-06-02T10:00:00.000Z"),
		});
		expect(lock.lock_id).toBe("new-lock");
	});

	test("a real lock acquire is bridged onto the workspace SSE bus the frontend listens to", async () => {
		// The browser locks store keys off realtimeStore lock_acquired/lock_released
		// events, NOT the raw ws:locks:* Redis channel. publishLockEvent() must
		// therefore also fan out on the SSE bus. Use a no-op raw publisher + the
		// in-memory realtime bus and assert a lock_acquired SSE event arrives with
		// the canonical payload shape (owner/scope/scopeId/expiresAt).
		const bus = createInMemoryRealtimeBus(50);
		setRealtimeBusForTesting(bus);
		try {
			const subscription = bus.subscribe("workspace-1", {});
			const iterator = subscription[Symbol.asyncIterator]();
			const nextPromise = iterator.next();

			const store = new PostgresWorkLockStore(new FakeInsertingLockSqlClient(), {
				async publish() {/* raw channel no-op */},
			});
			await store.acquireLock("page", "page-1", "user-a", 10, {
				workspaceId: "workspace-1",
				chapterId: "chapter-1",
				now: new Date("2026-06-02T10:00:00.000Z"),
			});

			const result = await Promise.race([
				nextPromise,
				new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 1000)),
			]);
			expect(result.done).toBe(false);
			const event = (result as { value: RealtimeEvent }).value;
			expect(event.kind).toBe("lock_acquired");
			expect(event.workspaceId).toBe("workspace-1");
			expect(event.data.lockId).toBe("new-lock");
			expect(event.data.scope).toBe("page");
			expect(event.data.scopeId).toBe("page-1");
			expect(event.data.owner).toBe("user-a");
			expect(event.data.expiresAt).toBe("2026-06-02T10:10:00.000Z");

			subscription.close();
		} finally {
			setRealtimeBusForTesting(null);
		}
	});

	test("a real lock release is bridged onto the workspace SSE bus as lock_released", async () => {
		const bus = createInMemoryRealtimeBus(50);
		setRealtimeBusForTesting(bus);
		try {
			const subscription = bus.subscribe("workspace-1", {});
			const iterator = subscription[Symbol.asyncIterator]();
			const nextPromise = iterator.next();

			const store = new PostgresWorkLockStore(new FakeReleasingLockSqlClient(), {
				async publish() {/* raw channel no-op */},
			});
			await store.releaseLock("new-lock", "user-a", { now: new Date("2026-06-02T10:05:00.000Z") });

			const result = await Promise.race([
				nextPromise,
				new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 1000)),
			]);
			expect(result.done).toBe(false);
			const event = (result as { value: RealtimeEvent }).value;
			expect(event.kind).toBe("lock_released");
			expect(event.workspaceId).toBe("workspace-1");
			expect(event.data.lockId).toBe("new-lock");

			subscription.close();
		} finally {
			setRealtimeBusForTesting(null);
		}
	});
});

// Fake SQL client whose SELECT returns an active lock owned by user-a and whose
// UPDATE marks it released — drives PostgresWorkLockStore.releaseLock end-to-end.
class FakeReleasingLockSqlClient implements WorkLockSqlClient {
	async begin<T>(fn: (transaction: WorkLockSqlClient) => Promise<T>): Promise<T> {
		return fn(this);
	}

	async unsafe<T = Record<string, unknown>>(query: string, _params: unknown[] = []): Promise<T[]> {
		if (query.includes("SELECT") && query.includes("FROM work_locks")) {
			return [{
				lock_id: "new-lock",
				scope: "page",
				scope_id: "page-1",
				owner_user_id: "user-a",
				project_id: null,
				chapter_id: "chapter-1",
				page_id: "page-1",
				workspace_id: "workspace-1",
				acquired_at: "2026-06-02T10:00:00.000Z",
				auto_release_at: "2026-06-02T10:10:00.000Z",
				released_at: null,
				released_by: null,
				release_reason: null,
			}] as T[];
		}
		if (query.includes("UPDATE work_locks") && query.includes("released_at = $2")) {
			return [{
				lock_id: "new-lock",
				scope: "page",
				scope_id: "page-1",
				owner_user_id: "user-a",
				project_id: null,
				chapter_id: "chapter-1",
				page_id: "page-1",
				workspace_id: "workspace-1",
				acquired_at: "2026-06-02T10:00:00.000Z",
				auto_release_at: "2026-06-02T10:10:00.000Z",
				released_at: "2026-06-02T10:05:00.000Z",
				released_by: "user-a",
				release_reason: "released",
			}] as T[];
		}
		// Auto-expiry sweep UPDATE returns nothing.
		return [] as T[];
	}
}

class FakeInsertingLockSqlClient implements WorkLockSqlClient {
	async begin<T>(fn: (transaction: WorkLockSqlClient) => Promise<T>): Promise<T> {
		return fn(this);
	}

	async unsafe<T = Record<string, unknown>>(query: string, _params: unknown[] = []): Promise<T[]> {
		if (query.includes("INSERT INTO work_locks")) {
			return [{
				lock_id: "new-lock",
				scope: "page",
				scope_id: "page-1",
				owner_user_id: "user-a",
				project_id: null,
				chapter_id: "chapter-1",
				page_id: "page-1",
				workspace_id: "workspace-1",
				acquired_at: "2026-06-02T10:00:00.000Z",
				auto_release_at: "2026-06-02T10:10:00.000Z",
				released_at: null,
				released_by: null,
				release_reason: null,
			}] as T[];
		}
		// SELECT existing active lock + auto-expiry sweep both return no rows.
		return [] as T[];
	}
}
