// ATOMIC contact-cap CONCURRENCY proof (codex #388 P2).
//
// PostgresWorkspaceContactStore.create() used to run a read-then-write critical
// section — OR-dedupe probe → count(*) → INSERT — that was NOT atomic. Two
// parallel UNIQUE creates at MAX_CONTACTS_PER_USER - 1 could each probe (miss),
// each read count = MAX-1, and each INSERT, pushing the owner OVER the cap. File
// mode is effectively serialized in-process; Postgres is not.
//
// The fix wraps that whole sequence in ONE transaction and takes a per-owner
// advisory lock (pg_advisory_xact_lock(hashtext("workspace_contact:<owner>")))
// first, serializing concurrent create() calls for the SAME owner across
// connections; different owners never contend.
//
// This suite proves it two ways without a live DB:
//   1) The lock IS acquired around count + insert (query-shape assertion).
//   2) A fake SQL client that MODELS the advisory lock as a per-key in-process
//      mutex + a DELAY inside the critical section (to widen the race) shows that
//      two parallel unique inserts at MAX-1 yield exactly ONE success and ONE
//      contact_limit_reached — never two inserts. A control run WITHOUT honoring
//      the lock reproduces the original over-cap bug, proving the test has teeth.

import { describe, expect, test } from "bun:test";
import {
	MAX_CONTACTS_PER_USER,
	PostgresWorkspaceContactStore,
	WorkspaceContactError,
	type ContactSqlClient,
} from "../services/workspace-contacts.js";

interface StoredRow {
	id: string;
	owner_user_id: string;
	contact_user_id: string | null;
	email: string | null;
	display_name: string | null;
	relationship: string;
	suggested_role: string | null;
	created_at: string;
	updated_at: string;
}

// Shared mutable DB state across all "connections" (begin() handles).
interface SharedDbState {
	rows: StoredRow[];
	queries: Array<{ query: string; params: unknown[] }>;
	idSeq: number;
	// Tail of each per-key lock chain: a new txn awaits the prior tail before
	// entering and only releases when its own body ends — modeling
	// pg_advisory_xact_lock's "held until commit/rollback".
	lockTail: Map<string, Promise<void>>;
}

// In-memory fake backing the `workspace_contacts` table. It implements ONLY the
// queries create() issues. `honorLock` toggles whether the modeled advisory lock
// actually serializes a per-owner critical section — flipping it OFF reproduces
// the pre-fix race so we can prove the test would catch a regression.
//
// begin() returns a FRESH connection-scoped instance (its own heldRelease) that
// shares the SAME SharedDbState, so two parallel create() calls genuinely
// contend on the per-owner lock the way two Postgres connections would.
class FakeContactSqlClient implements ContactSqlClient {
	readonly state: SharedDbState;
	private heldRelease: (() => void) | null = null;

	constructor(
		private readonly opts: { honorLock: boolean; critSectionDelayMs?: number } = { honorLock: true },
		state?: SharedDbState,
	) {
		this.state = state ?? { rows: [], queries: [], idSeq: 0, lockTail: new Map() };
	}

	get rows(): StoredRow[] {
		return this.state.rows;
	}
	get queries(): Array<{ query: string; params: unknown[] }> {
		return this.state.queries;
	}

	async begin<T>(fn: (transaction: ContactSqlClient) => Promise<T>): Promise<T> {
		const conn = new FakeContactSqlClient(this.opts, this.state);
		try {
			return await fn(conn);
		} finally {
			if (conn.heldRelease) {
				conn.heldRelease();
				conn.heldRelease = null;
			}
		}
	}

	async unsafe<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
		this.state.queries.push({ query, params });
		const q = query.trim();

		if (q.startsWith("SELECT pg_advisory_xact_lock")) {
			await this.acquire(String(params[0]));
			return [] as T[];
		}

		if (q.startsWith("SELECT id, owner_user_id") && q.includes("AND (")) {
			// OR-dedupe probe.
			const [owner, uid, email] = params as [string, string | null, string | null];
			const found = this.state.rows
				.filter((r) => r.owner_user_id === owner && ((uid && r.contact_user_id === uid) || (email && r.email === email)))
				.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
				.slice(0, 1);
			return found as unknown as T[];
		}

		if (q.startsWith("SELECT count(*)")) {
			const owner = params[0] as string;
			// Snapshot the count NOW (before yielding), then optionally delay to widen
			// the race window. Returning the pre-delay snapshot models a read that
			// happened-before a concurrent writer's INSERT — exactly the interleave the
			// pre-fix code was vulnerable to. Under the advisory lock the second txn
			// can't even reach here until the first commits, so it never sees a stale
			// snapshot.
			const count = this.state.rows.filter((r) => r.owner_user_id === owner).length;
			if (this.opts.critSectionDelayMs) await new Promise((r) => setTimeout(r, this.opts.critSectionDelayMs));
			return [{ count }] as unknown as T[];
		}

		if (q.startsWith("UPDATE workspace_contacts SET")) {
			// Re-add of an existing target: merge in place by id ($1).
			const [id, uid, email, displayName, relationship, suggestedRole] = params as [
				string,
				string | null,
				string | null,
				string | null,
				string,
				string | null,
			];
			const existing = this.state.rows.find((r) => r.id === id);
			if (!existing) return [] as T[];
			existing.contact_user_id = uid ?? existing.contact_user_id;
			existing.email = email ?? existing.email;
			existing.display_name = displayName ?? existing.display_name;
			existing.relationship = relationship;
			existing.suggested_role = suggestedRole ?? existing.suggested_role;
			existing.updated_at = new Date().toISOString();
			return [existing] as unknown as T[];
		}

		if (q.startsWith("INSERT INTO workspace_contacts")) {
			const [owner, uid, email, displayName, relationship, suggestedRole] = params as [
				string,
				string | null,
				string | null,
				string | null,
				string,
				string | null,
			];
			// Backstop unique index: collapse an identical (owner, uid, email) key.
			const conflict = this.state.rows.find(
				(r) =>
					r.owner_user_id === owner &&
					(r.contact_user_id ?? "") === (uid ?? "") &&
					(r.email ?? "") === (email ?? ""),
			);
			const now = new Date().toISOString();
			if (conflict) {
				conflict.contact_user_id = uid ?? conflict.contact_user_id;
				conflict.email = email ?? conflict.email;
				conflict.display_name = displayName ?? conflict.display_name;
				conflict.relationship = relationship;
				conflict.suggested_role = suggestedRole ?? conflict.suggested_role;
				conflict.updated_at = now;
				return [conflict] as unknown as T[];
			}
			const row: StoredRow = {
				id: `contact-${++this.state.idSeq}`,
				owner_user_id: owner,
				contact_user_id: uid,
				email,
				display_name: displayName,
				relationship,
				suggested_role: suggestedRole,
				created_at: now,
				updated_at: now,
			};
			this.state.rows.push(row);
			return [row] as unknown as T[];
		}

		return [] as T[];
	}

	// Model pg_advisory_xact_lock: serialize per key, held until this txn ends.
	// When honorLock is false the lock is a no-op (reproduces the cross-connection
	// race).
	private async acquire(key: string): Promise<void> {
		if (!this.opts.honorLock) return;
		const prior = this.state.lockTail.get(key) ?? Promise.resolve();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// New tail = current holder waits for prior to release, then holds `held`.
		this.state.lockTail.set(
			key,
			prior.then(() => held),
		);
		await prior; // block until the previous holder's txn ends
		this.heldRelease = release; // released by begin()'s finally (commit/rollback)
	}
}

const OWNER = "owner-cap-race";

describe("PostgresWorkspaceContactStore atomic cap (codex #388 P2)", () => {
	test("acquires a per-owner pg_advisory_xact_lock around the count + insert", async () => {
		const fake = new FakeContactSqlClient({ honorLock: true });
		const store = new PostgresWorkspaceContactStore(fake);
		await store.create({ ownerUserId: OWNER, contactUserId: "u-1" });

		const lockQ = fake.queries.find((entry) => entry.query.includes("pg_advisory_xact_lock"));
		expect(lockQ).toBeDefined();
		expect(lockQ?.params[0]).toBe(`workspace_contact:${OWNER}`);

		// The lock must be taken BEFORE the count and the insert.
		const order = fake.queries.map((e) => e.query.trim());
		const lockIdx = order.findIndex((q) => q.startsWith("SELECT pg_advisory_xact_lock"));
		const countIdx = order.findIndex((q) => q.startsWith("SELECT count(*)"));
		const insertIdx = order.findIndex((q) => q.startsWith("INSERT INTO workspace_contacts"));
		expect(lockIdx).toBeGreaterThanOrEqual(0);
		expect(lockIdx).toBeLessThan(countIdx);
		expect(countIdx).toBeLessThan(insertIdx);
	});

	test("two parallel UNIQUE inserts at MAX-1 cannot both succeed (one wins, one hits the cap)", async () => {
		const fake = new FakeContactSqlClient({ honorLock: true, critSectionDelayMs: 15 });
		// Seed MAX-1 existing contacts for the owner.
		const now = new Date().toISOString();
		for (let i = 0; i < MAX_CONTACTS_PER_USER - 1; i++) {
			fake.rows.push({
				id: `seed-${i}`,
				owner_user_id: OWNER,
				contact_user_id: `seed-u-${i}`,
				email: null,
				display_name: null,
				relationship: "friend",
				suggested_role: null,
				created_at: now,
				updated_at: now,
			});
		}
		const store = new PostgresWorkspaceContactStore(fake);

		// Two DISTINCT new targets, fired in parallel.
		const results = await Promise.allSettled([
			store.create({ ownerUserId: OWNER, contactUserId: "race-a" }),
			store.create({ ownerUserId: OWNER, contactUserId: "race-b" }),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		const reason = rejected[0]?.reason;
		expect(reason).toBeInstanceOf(WorkspaceContactError);
		expect((reason as WorkspaceContactError).code).toBe("contact_limit_reached");

		// The cap held: total rows for the owner never exceeds MAX.
		expect(fake.rows.filter((r) => r.owner_user_id === OWNER).length).toBe(MAX_CONTACTS_PER_USER);
	});

	test("control: WITHOUT the lock the same race over-fills the cap (proves the test has teeth)", async () => {
		const fake = new FakeContactSqlClient({ honorLock: false, critSectionDelayMs: 15 });
		const now = new Date().toISOString();
		for (let i = 0; i < MAX_CONTACTS_PER_USER - 1; i++) {
			fake.rows.push({
				id: `seed-${i}`,
				owner_user_id: OWNER,
				contact_user_id: `seed-u-${i}`,
				email: null,
				display_name: null,
				relationship: "friend",
				suggested_role: null,
				created_at: now,
				updated_at: now,
			});
		}
		const store = new PostgresWorkspaceContactStore(fake);
		const results = await Promise.allSettled([
			store.create({ ownerUserId: OWNER, contactUserId: "race-a" }),
			store.create({ ownerUserId: OWNER, contactUserId: "race-b" }),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		// The pre-fix behaviour: both pass the cap check and both insert → OVER cap.
		expect(fulfilled.length).toBe(2);
		expect(fake.rows.filter((r) => r.owner_user_id === OWNER).length).toBe(MAX_CONTACTS_PER_USER + 1);
	});

	test("re-adding an EXISTING target at cap is still allowed (upsert, not a new row)", async () => {
		const fake = new FakeContactSqlClient({ honorLock: true });
		const now = new Date().toISOString();
		for (let i = 0; i < MAX_CONTACTS_PER_USER; i++) {
			fake.rows.push({
				id: `seed-${i}`,
				owner_user_id: OWNER,
				contact_user_id: `seed-u-${i}`,
				email: null,
				display_name: null,
				relationship: "friend",
				suggested_role: null,
				created_at: now,
				updated_at: now,
			});
		}
		const store = new PostgresWorkspaceContactStore(fake);
		// Owner is AT cap; re-adding an existing target (seed-u-0) must succeed via the
		// UPDATE path and NOT throw contact_limit_reached.
		const updated = await store.create({ ownerUserId: OWNER, contactUserId: "seed-u-0", displayName: "Renamed" });
		expect(updated.contactUserId).toBe("seed-u-0");
		expect(updated.displayName).toBe("Renamed");
		expect(fake.rows.filter((r) => r.owner_user_id === OWNER).length).toBe(MAX_CONTACTS_PER_USER);
	});
});
