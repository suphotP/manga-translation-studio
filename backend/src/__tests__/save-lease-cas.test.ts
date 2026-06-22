// Round-2 concurrent-edit regression coverage (PR #428 codex review P0-1 + P0-2).
//
// P0-1 — TOCTOU: the round-1 fix re-checked the page lease only BEFORE the commit, but
//   a cross-user takeover writes NO project state, so the CAS hash is unchanged and the
//   displaced holder's in-flight save would still write (clobber). This asserts the
//   lease is re-validated INSIDE the commit critical section (commitProjectStateWithCas's
//   leaseGuard) and the stale write is REJECTED + the persisted state is left untouched —
//   even though the takeover wrote nothing and the hash still matches.
//
// P0-2 — fail-open on a missing lease header: an attacker/buggy client could simply omit
//   x-edit-lock-id and the early gate allowed the save (CAS can't see a no-state-write
//   takeover). This asserts a page-scoped save with the require-lease-header flag ON and
//   NO header is rejected 428.
//
// File-mode (no DATABASE_URL): DATA_DIR is set before importing the route module so
// readProjectState/writeProjectState use the temp on-disk store. An InMemoryWorkLockStore
// is injected via __setWorkLockStoreForTesting so the lease paths run without Postgres.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ProjectState } from "../types/index.js";
import type { JWTPayload } from "../types/auth.js";

// We do NOT set DATA_DIR here: PROJECTS_DIR is frozen at config import, and in a shared
// test process a sibling file may have imported config first. Instead we read the dir
// config actually resolved to (via writeProjectState/readProjectState, which use it) and
// toggle the require-lease-header flag directly on the live serverConfig (restored in
// afterAll) — exactly how routes.test.ts mutates serverConfig to avoid env-cache races.
let restoreRequireLease: (() => void) | null = null;

// Minimal Hono-context stub: only header() + json() are exercised by the lease guards.
// `captured` is a live holder read AFTER the guard call (not destructured by value).
function makeContext(headers: Record<string, string>): {
	c: any;
	captured: { value: { body: any; status: number } | null };
} {
	const captured: { value: { body: any; status: number } | null } = { value: null };
	const c = {
		req: {
			header: (name: string): string | undefined => headers[name.toLowerCase()],
		},
		json: (body: any, status: number) => {
			captured.value = { body, status };
			return { __isResponse: true, status, body } as unknown as Response;
		},
	};
	return { c, captured };
}

function seedState(projectId: string, marker = "v1"): ProjectState {
	return {
		projectId,
		userId: "user-1",
		name: marker,
		createdAt: "2026-06-07T00:00:00.000Z",
		pages: [],
		currentPage: 0,
		targetLang: "th",
	} as unknown as ProjectState;
}

let project: typeof import("../routes/project.js");
let InMemoryWorkLockStore: typeof import("../services/work-locks.js").InMemoryWorkLockStore;

beforeAll(async () => {
	const { serverConfig } = await import("../config.js");
	const prev = serverConfig.requireEditLeaseHeaderEnabled;
	(serverConfig as unknown as Record<string, unknown>).requireEditLeaseHeaderEnabled = true;
	restoreRequireLease = () => {
		(serverConfig as unknown as Record<string, unknown>).requireEditLeaseHeaderEnabled = prev;
	};
	project = await import("../routes/project.js");
	({ InMemoryWorkLockStore } = await import("../services/work-locks.js"));
});

afterAll(() => {
	project.__setWorkLockStoreForTesting(null);
	project.__setProjectAdvisoryLockClientForTesting(null);
	restoreRequireLease?.();
});

const user: JWTPayload = { userId: "user-1", email: "a@b.c" } as JWTPayload;

describe("P0-1 — in-lock lease guard rejects a displaced holder's in-flight save (takeover wrote no state)", () => {
	test("a takeover that mutates NO project state still rejects the displaced save, leaving persisted state untouched", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const projectId = `proj-toctou-${Date.now()}`;

		// Displaced holder (user-1 / tab-a) acquires the page lease.
		const lock = await store.acquireLock("page", "p:0", "user-1", 5, {
			clientId: "tab-a",
			projectId,
			pageId: `${projectId}:page:0`,
			workspaceId: "ws-1",
		});

		// Persist the baseline state the displaced holder loaded.
		const baseState = seedState(projectId, "committed-by-new-holder");
		await project.writeProjectState(projectId, baseState);
		const baseHash = project.hashProjectState(baseState);

		// A cross-user takeover happens. CRUCIALLY it writes NO project state — so the
		// persisted hash is UNCHANGED and the CAS hash-check alone cannot detect it.
		await store.acquireLock("page", "p:0", "user-2", 5, {
			clientId: "tab-z",
			takeover: true,
			allowCrossUserTakeover: true,
			projectId,
			pageId: `${projectId}:page:0`,
			workspaceId: "ws-1",
		});
		// Confirm the persisted state really is byte-identical (hash still matches): a
		// hash-only CAS would PASS here, proving the lease guard is the only defense.
		const stillPersisted = await project.readProjectState(projectId);
		expect(project.hashProjectState(stillPersisted!)).toBe(baseHash);

		// The displaced holder's in-flight save reaches the commit. Its lease guard,
		// invoked INSIDE the mutex, must see the takeover and throw — even though the hash
		// matches and the takeover wrote nothing.
		const { c } = makeContext({
			"x-edit-lock-id": lock.lock_id,
			"x-edit-client-id": "tab-a",
		});
		const guard = project.makePageLeaseGuard(c, user);
		expect(guard).toBeDefined();

		const staleWrite = seedState(projectId, "STALE-clobber-by-displaced-holder");
		let thrown: unknown;
		try {
			await project.commitProjectStateWithCas(projectId, baseHash, staleWrite, {}, undefined, guard);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(project.ProjectLeaseLostError);
		expect((thrown as InstanceType<typeof project.ProjectLeaseLostError>).takenOver).toBe(true);

		// The clobber must NOT have landed — persisted state is exactly the baseline.
		const after = await project.readProjectState(projectId);
		expect(after!.name).toBe("committed-by-new-holder");
		expect(project.hashProjectState(after!)).toBe(baseHash);
	});

	test("a holder who STILL owns the lease commits normally (no false rejection)", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const projectId = `proj-held-${Date.now()}`;
		const lock = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a", projectId });
		const baseState = seedState(projectId, "v1");
		await project.writeProjectState(projectId, baseState);
		const baseHash = project.hashProjectState(baseState);

		const { c } = makeContext({ "x-edit-lock-id": lock.lock_id, "x-edit-client-id": "tab-a" });
		const guard = project.makePageLeaseGuard(c, user);
		const next = seedState(projectId, "v2-legit");
		await project.commitProjectStateWithCas(projectId, baseHash, next, {}, undefined, guard);

		const after = await project.readProjectState(projectId);
		expect(after!.name).toBe("v2-legit");
	});
});

describe("P0-1 (round-3) — takeover shares the SAME per-project mutex as the save commit (no residual TOCTOU)", () => {
	// The takeover path (routes/locks.ts) now wraps its lock-store release+insert in the
	// SAME withProjectMutationLock(projectId) the save's commit critical section uses. This
	// asserts the serialization both ways:
	//   (a) when a save holds the mutex, a concurrent takeover BLOCKS until the save's
	//       leaseGuard+write critical section completes (so a takeover can never land
	//       between the in-mutex leaseGuard and the write); and
	//   (b) when the takeover wins the mutex first, the displaced save's in-mutex leaseGuard
	//       then sees the taken-over lock and REJECTS — the stale write never lands.
	test("(a) an in-flight save holding the mutex serializes a concurrent takeover until AFTER the write", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const projectId = `proj-serialize-${Date.now()}`;

		const lock = await store.acquireLock("page", "p:0", "user-1", 5, {
			clientId: "tab-a",
			projectId,
			pageId: `${projectId}:page:0`,
			workspaceId: "ws-1",
		});
		const baseState = seedState(projectId, "base");
		await project.writeProjectState(projectId, baseState);
		const baseHash = project.hashProjectState(baseState);

		const order: string[] = [];
		const { c } = makeContext({ "x-edit-lock-id": lock.lock_id, "x-edit-client-id": "tab-a" });
		// Wrap the real lease guard so we can (1) record that it ran while the save still
		// held the lease, and (2) yield a few microtasks AFTER it returns "held" — the exact
		// window the round-2 fix could not protect. With mutex-sharing the takeover cannot
		// run inside this window because it is queued behind the save on the same mutex.
		const realGuard = project.makePageLeaseGuard(c, user)!;
		const guard = async () => {
			const verdict = await realGuard();
			order.push("save:leaseGuard(held)");
			// Give a queued takeover every chance to interleave (it must NOT).
			await Promise.resolve();
			await Promise.resolve();
			return verdict;
		};

		const next = seedState(projectId, "save-committed");
		const savePromise = project.commitProjectStateWithCas(projectId, baseHash, next, {}, async () => {
			order.push("save:write+afterCommit");
			return undefined;
		}, guard);

		// Kick off the takeover under the SAME per-project mutex (mirrors routes/locks.ts).
		const takeoverPromise = project.withProjectMutationLock(projectId, async () => {
			order.push("takeover:run");
			return store.acquireLock("page", "p:0", "user-2", 5, {
				clientId: "tab-z",
				takeover: true,
				allowCrossUserTakeover: true,
				projectId,
				pageId: `${projectId}:page:0`,
				workspaceId: "ws-1",
			});
		});

		await Promise.all([savePromise, takeoverPromise]);

		// The save's whole critical section (leaseGuard → write) ran BEFORE the takeover.
		expect(order).toEqual(["save:leaseGuard(held)", "save:write+afterCommit", "takeover:run"]);
		// The legitimate save landed (the holder still held the lease at write time).
		const after = await project.readProjectState(projectId);
		expect(after!.name).toBe("save-committed");
	});

	test("(b) when the takeover wins the mutex first, the displaced save's in-mutex leaseGuard rejects", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const projectId = `proj-takeover-first-${Date.now()}`;

		const lock = await store.acquireLock("page", "p:0", "user-1", 5, {
			clientId: "tab-a",
			projectId,
			pageId: `${projectId}:page:0`,
			workspaceId: "ws-1",
		});
		const baseState = seedState(projectId, "committed-by-new-holder");
		await project.writeProjectState(projectId, baseState);
		const baseHash = project.hashProjectState(baseState);

		// Takeover acquires the project mutex FIRST and completes its release+insert.
		await project.withProjectMutationLock(projectId, () => store.acquireLock("page", "p:0", "user-2", 5, {
			clientId: "tab-z",
			takeover: true,
			allowCrossUserTakeover: true,
			projectId,
			pageId: `${projectId}:page:0`,
			workspaceId: "ws-1",
		}));

		// Now the displaced holder's save runs; its in-mutex leaseGuard sees the takeover.
		const { c } = makeContext({ "x-edit-lock-id": lock.lock_id, "x-edit-client-id": "tab-a" });
		const guard = project.makePageLeaseGuard(c, user);
		const staleWrite = seedState(projectId, "STALE-clobber");
		let thrown: unknown;
		try {
			await project.commitProjectStateWithCas(projectId, baseHash, staleWrite, {}, undefined, guard);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(project.ProjectLeaseLostError);
		expect((thrown as InstanceType<typeof project.ProjectLeaseLostError>).takenOver).toBe(true);
		const after = await project.readProjectState(projectId);
		expect(after!.name).toBe("committed-by-new-holder");
	});
});

describe("P1 (round-3) — AI marker rerun/retry commit rides the CAS + in-mutex versioning rail", () => {
	// The rerun/retry routes now commit via commitProjectStateWithVersion (the same rail
	// every other marker route uses), so a concurrent commit that drifted the persisted
	// state between the route's read and its commit is REJECTED (project_save_conflict)
	// instead of clobbering — and the version snapshot runs INSIDE the per-project mutex.
	test("a stale baseline (persisted state drifted after the route loaded it) is CAS-rejected, not clobbered", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const projectId = `proj-rerun-cas-${Date.now()}`;

		// The route loads state and captures projectCasBaseHash from it.
		const loaded = seedState(projectId, "loaded-by-rerun-route");
		await project.writeProjectState(projectId, loaded);
		const staleBaseHash = project.hashProjectState(loaded);

		// A concurrent commit lands FIRST (e.g. another marker write), drifting the hash.
		const concurrent = seedState(projectId, "committed-by-concurrent-writer");
		await project.writeProjectState(projectId, concurrent);

		// The rerun's commit (against its now-stale baseline) must be CAS-rejected.
		const rerunMutation = seedState(projectId, "rerun-marker-write");
		let thrown: unknown;
		try {
			await project.commitProjectStateWithVersion(projectId, staleBaseHash, rerunMutation);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(project.ProjectStateCasConflictError);
		// The concurrent writer's state survives; the stale rerun write did NOT clobber it.
		const after = await project.readProjectState(projectId);
		expect(after!.name).toBe("committed-by-concurrent-writer");
	});

	test("a single-writer rerun commit (no drift) succeeds + snapshots a version", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const projectId = `proj-rerun-ok-${Date.now()}`;
		const loaded = seedState(projectId, "v1");
		await project.writeProjectState(projectId, loaded);
		const baseHash = project.hashProjectState(loaded);

		const next = seedState(projectId, "rerun-committed");
		const version = await project.commitProjectStateWithVersion(projectId, baseHash, next);
		expect(version).toBeDefined();
		const after = await project.readProjectState(projectId);
		expect(after!.name).toBe("rerun-committed");
	});
});

describe("P0-2 — require-lease-header gate rejects a header-less page-scoped save", () => {
	test("page-scoped save with NO x-edit-lock-id is rejected 428 when the flag is ON", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const { c, captured } = makeContext({}); // NO lease header
		const res = await project.rejectIfPageLeaseLost(c, user, { pageScoped: true });
		expect(res).not.toBeNull();
		expect((res as any).status).toBe(428);
		expect(captured.value!.body.code).toBe("edit_lease_required");
	});

	test("a NON-page-scoped (metadata) save with no header is allowed (not subject to the gate)", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const { c } = makeContext({});
		const res = await project.rejectIfPageLeaseLost(c, user, { pageScoped: false });
		expect(res).toBeNull();
	});

	test("a page-scoped save WITH a valid held lease header passes the gate", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const lock = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a" });
		const { c } = makeContext({ "x-edit-lock-id": lock.lock_id, "x-edit-client-id": "tab-a" });
		const res = await project.rejectIfPageLeaseLost(c, user, { pageScoped: true });
		expect(res).toBeNull();
	});

	test("a page-scoped save whose lease was TAKEN OVER is rejected 409 editing_taken_over (early gate)", async () => {
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		const first = await store.acquireLock("page", "p:0", "user-1", 5, {
			clientId: "tab-a",
			projectId: "proj-x",
			pageId: "proj-x:page:0",
			workspaceId: "ws-1",
		});
		await store.acquireLock("page", "p:0", "user-2", 5, {
			clientId: "tab-z",
			takeover: true,
			allowCrossUserTakeover: true,
			projectId: "proj-x",
			pageId: "proj-x:page:0",
			workspaceId: "ws-1",
		});
		const { c, captured } = makeContext({
			"x-edit-lock-id": first.lock_id,
			"x-edit-client-id": "tab-a",
		});
		const res = await project.rejectIfPageLeaseLost(c, user, { pageScoped: true });
		expect(res).not.toBeNull();
		expect((res as any).status).toBe(409);
		expect(captured.value!.body.code).toBe("editing_taken_over");
	});
});

// ── P0 (round-5): CROSS-REPLICA serialization via the DB advisory lock ───────────────
//
// Postgres mode wraps BOTH the save-commit critical section and the takeover's lock
// release+mint in a shared `pg_advisory_xact_lock(hashtext('project-mutation:'+id))` txn,
// so they serialize even when they land on DIFFERENT replicas (the in-process mutex alone
// cannot span replicas). pg_advisory_xact_lock needs a real Postgres, so we inject a FAKE
// advisory-lock client (via __setProjectAdvisoryLockClientForTesting) that faithfully
// MODELS the two load-bearing Postgres semantics: (1) `pg_advisory_xact_lock(key)` BLOCKS
// until any other open txn holding the same key commits/rolls back; (2) the lock auto-
// releases at txn end. The fake serializes per-key via a promise chain (exactly like a real
// advisory xact lock would queue contending sessions) and records acquire/release ordering.
//
// This validates the LOGIC + lock ordering off-Postgres. On real Postgres the same
// `pg_advisory_xact_lock` SQL provides the identical guarantee across replicas.
type FakeTxn = { unsafe: (q: string, params?: unknown[]) => Promise<any[]> };
function makeFakeAdvisoryClient(events: string[]) {
	// One promise-chain tail per advisory key — models the cross-session serialization of
	// pg_advisory_xact_lock: a second `begin` for the same key cannot enter its critical
	// section until the first txn's chain link settles (its COMMIT/ROLLBACK).
	const keyTails = new Map<string, Promise<unknown>>();
	return {
		async begin<T>(fn: (tx: FakeTxn) => Promise<T>): Promise<T> {
			let releaseHeldLock: null | (() => void) = null;
			let acquiredKey: string | null = null;
			const tx: FakeTxn = {
				unsafe: async (q: string, params?: unknown[]) => {
					if (q.includes("pg_advisory_xact_lock")) {
						const key = String(params?.[0] ?? "");
						acquiredKey = key;
						const previous = keyTails.get(key) ?? Promise.resolve();
						// This txn's hold is a promise that resolves only when we release at
						// txn end; the NEXT contender chains onto it and so blocks until then.
						let resolveHold!: () => void;
						const hold = new Promise<void>((resolve) => { resolveHold = resolve; });
						const tail = previous.then(() => hold);
						keyTails.set(key, tail);
						releaseHeldLock = () => {
							resolveHold();
							if (keyTails.get(key) === tail) keyTails.delete(key);
						};
						// Wait until all prior holders of this key have released (committed).
						await previous;
						events.push(`advisory:acquire(${key})`);
						return [];
					}
					return [];
				},
			};
			try {
				const result = await fn(tx);
				return result;
			} finally {
				if (acquiredKey) events.push(`advisory:release(${acquiredKey})`);
				const release = releaseHeldLock as null | (() => void);
				if (release) release();
			}
		},
		async unsafe() { return []; },
	};
}

describe("P0 (round-5) — save + takeover serialize via the SHARED DB advisory lock (cross-replica)", () => {
	test("the save commit runs INSIDE the project advisory-lock txn (acquire → write → release ordering)", async () => {
		const events: string[] = [];
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		project.__setProjectAdvisoryLockClientForTesting(makeFakeAdvisoryClient(events) as any);
		try {
			const projectId = `proj-adv-save-${Date.now()}`;
			const lock = await store.acquireLock("page", "p:0", "user-1", 5, {
				clientId: "tab-a",
				projectId,
				pageId: `${projectId}:page:0`,
				workspaceId: "ws-1",
			});
			const baseState = seedState(projectId, "base");
			await project.writeProjectState(projectId, baseState);
			const baseHash = project.hashProjectState(baseState);

			const { c } = makeContext({ "x-edit-lock-id": lock.lock_id, "x-edit-client-id": "tab-a" });
			const guard = project.makePageLeaseGuard(c, user)!;
			const wrappedGuard = async () => { events.push("save:leaseGuard"); return guard(); };
			const next = seedState(projectId, "save-committed");
			await project.commitProjectStateWithCas(projectId, baseHash, next, {}, async () => {
				events.push("save:write");
				return undefined;
			}, wrappedGuard);

			const key = `project-mutation:${projectId}`;
			// The whole read→leaseGuard→write critical section ran INSIDE the advisory lock.
			expect(events).toEqual([
				`advisory:acquire(${key})`,
				"save:leaseGuard",
				"save:write",
				`advisory:release(${key})`,
			]);
			const after = await project.readProjectState(projectId);
			expect(after!.name).toBe("save-committed");
		} finally {
			project.__setProjectAdvisoryLockClientForTesting(null);
		}
	});

	test("a takeover and a displaced save SERIALIZE on the SAME advisory key; the displaced in-txn lease re-check rejects", async () => {
		const events: string[] = [];
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		project.__setProjectAdvisoryLockClientForTesting(makeFakeAdvisoryClient(events) as any);
		try {
			const projectId = `proj-adv-serialize-${Date.now()}`;
			const lock = await store.acquireLock("page", "p:0", "user-1", 5, {
				clientId: "tab-a",
				projectId,
				pageId: `${projectId}:page:0`,
				workspaceId: "ws-1",
			});
			const baseState = seedState(projectId, "committed-by-new-holder");
			await project.writeProjectState(projectId, baseState);
			const baseHash = project.hashProjectState(baseState);

			// The takeover takes the SAME cross-replica lock FIRST and completes (mirrors
			// routes/locks.ts using withProjectCrossReplicaLock for a cross-user takeover).
			await project.withProjectCrossReplicaLock(projectId, async () => {
				events.push("takeover:run");
				return store.acquireLock("page", "p:0", "user-2", 5, {
					clientId: "tab-z",
					takeover: true,
					allowCrossUserTakeover: true,
					projectId,
					pageId: `${projectId}:page:0`,
					workspaceId: "ws-1",
				});
			});

			// Now the displaced holder's save runs in its OWN advisory-lock txn; because the
			// takeover already released the lock, the in-txn leaseGuard sees taken_over and
			// rejects — the stale write never lands.
			const { c } = makeContext({ "x-edit-lock-id": lock.lock_id, "x-edit-client-id": "tab-a" });
			const guard = project.makePageLeaseGuard(c, user);
			const staleWrite = seedState(projectId, "STALE-clobber");
			let thrown: unknown;
			try {
				await project.commitProjectStateWithCas(projectId, baseHash, staleWrite, {}, undefined, guard);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(project.ProjectLeaseLostError);
			expect((thrown as InstanceType<typeof project.ProjectLeaseLostError>).takenOver).toBe(true);

			const key = `project-mutation:${projectId}`;
			// Both critical sections acquired+released the SAME advisory key, strictly
			// serialized: takeover's whole section before the displaced save's section.
			expect(events).toEqual([
				`advisory:acquire(${key})`,
				"takeover:run",
				`advisory:release(${key})`,
				`advisory:acquire(${key})`,
				`advisory:release(${key})`,
			]);
			const after = await project.readProjectState(projectId);
			expect(after!.name).toBe("committed-by-new-holder");
		} finally {
			project.__setProjectAdvisoryLockClientForTesting(null);
		}
	});

	test("file mode (NO advisory client) keeps the in-process mutex path — commit still works without a DB", async () => {
		const events: string[] = [];
		const store = new InMemoryWorkLockStore();
		project.__setWorkLockStoreForTesting(store);
		project.__setProjectAdvisoryLockClientForTesting(null); // explicit: no Postgres
		const projectId = `proj-adv-filemode-${Date.now()}`;
		const lock = await store.acquireLock("page", "p:0", "user-1", 5, { clientId: "tab-a", projectId });
		const baseState = seedState(projectId, "v1");
		await project.writeProjectState(projectId, baseState);
		const baseHash = project.hashProjectState(baseState);
		const { c } = makeContext({ "x-edit-lock-id": lock.lock_id, "x-edit-client-id": "tab-a" });
		const guard = project.makePageLeaseGuard(c, user);
		const next = seedState(projectId, "v2-file");
		await project.commitProjectStateWithCas(projectId, baseHash, next, {}, undefined, guard);
		// No advisory events recorded (the DB path was never entered) but the write landed.
		expect(events).toEqual([]);
		const after = await project.readProjectState(projectId);
		expect(after!.name).toBe("v2-file");
	});
});
