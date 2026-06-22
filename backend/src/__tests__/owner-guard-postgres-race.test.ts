import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { LastPlatformOwnerError, PostgresAuthUserStore, type AuthUserSqlClient } from "../services/auth-users.js";
import type { User } from "../types/auth.js";

/**
 * REAL-Postgres concurrency proof for the last-owner guard (PR #169 P1, TOCTOU).
 *
 * The check-then-mutate race only manifests against a real database: two
 * concurrent demote/disable/delete transactions can each read ownerCount=2 from
 * a stale snapshot and both commit, orphaning the platform. The in-process fake
 * SQL client cannot reproduce true connection-level concurrency, so this test is
 * gated on a real PG connection string and SKIPS otherwise.
 *
 * Provide the DB via RBAC_PG_TEST_URL (preferred) or DATABASE_URL, e.g.:
 *   docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rbac -p 55481:5432 postgres:16
 *   bun run src/migrations/cli.ts up   (with DATABASE_URL set)
 *   RBAC_PG_TEST_URL=postgres://postgres:postgres@localhost:55481/rbac bun test owner-guard-postgres-race
 *
 * It asserts: under Promise.all-fired concurrent owner mutations, EXACTLY one
 * succeeds, the loser fails with LastPlatformOwnerError, and at least one active
 * owner ALWAYS remains (never zero).
 */
const PG_URL = process.env.RBAC_PG_TEST_URL ?? process.env.DATABASE_URL ?? "";
const runOrSkip = PG_URL.trim() ? describe : describe.skip;

function makeOwner(id: string): User {
	const now = new Date().toISOString();
	return {
		id,
		email: `${id}@example.com`,
		passwordHash: "x",
		name: id,
		role: "owner",
		authProvider: "local",
		emailVerified: true,
		createdAt: now,
		updatedAt: now,
		isActive: true,
	};
}

runOrSkip("last-owner guard under REAL Postgres concurrency", () => {
	// Each store gets its OWN Bun.SQL pool so concurrent transactions run on
	// distinct connections — exactly the condition the race needs.
	const sqlA = new Bun.SQL(PG_URL) as unknown as AuthUserSqlClient & { close?: () => Promise<void> };
	const sqlB = new Bun.SQL(PG_URL) as unknown as AuthUserSqlClient & { close?: () => Promise<void> };
	const admin = new Bun.SQL(PG_URL) as unknown as AuthUserSqlClient & { close?: () => Promise<void> };
	const storeA = new PostgresAuthUserStore(sqlA);
	const storeB = new PostgresAuthUserStore(sqlB);
	const seedStore = new PostgresAuthUserStore(admin);

	async function activeOwnerCount(): Promise<number> {
		const rows = await admin.unsafe<{ count: string | number }>(
			`SELECT COUNT(*)::int AS count FROM auth_users WHERE role = 'owner' AND is_active = true`,
		);
		return Number(rows[0]?.count ?? 0);
	}

	async function seedTwoActiveOwners(): Promise<void> {
		await admin.unsafe(`DELETE FROM auth_users WHERE user_id IN ('owner-a', 'owner-b')`);
		await seedStore.create(makeOwner("owner-a"));
		await seedStore.create(makeOwner("owner-b"));
	}

	beforeEach(seedTwoActiveOwners);

	afterAll(async () => {
		await admin.unsafe(`DELETE FROM auth_users WHERE user_id IN ('owner-a', 'owner-b')`);
		await Promise.allSettled([sqlA.close?.(), sqlB.close?.(), admin.close?.()]);
	});

	test("concurrent demote(owner-a) + disable(owner-b): exactly one wins, an owner always remains", async () => {
		expect(await activeOwnerCount()).toBe(2);

		const results = await Promise.allSettled([
			storeA.updateProtectingLastOwner("owner-a", { role: "admin" }),
			storeB.updateProtectingLastOwner("owner-b", { isActive: false }),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		// The decisive invariant: zero-owner lockout never happens.
		expect(await activeOwnerCount()).toBeGreaterThanOrEqual(1);
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastPlatformOwnerError);
	});

	test("concurrent delete(owner-a) + demote(owner-b): exactly one wins, an owner always remains", async () => {
		expect(await activeOwnerCount()).toBe(2);

		const results = await Promise.allSettled([
			storeA.deleteProtectingLastOwner("owner-a"),
			storeB.updateProtectingLastOwner("owner-b", { role: "admin" }),
		]);

		const succeeded = results.filter(
			(r) => r.status === "fulfilled" && r.value !== false && r.value !== null,
		);
		const rejected = results.filter((r) => r.status === "rejected");
		expect(await activeOwnerCount()).toBeGreaterThanOrEqual(1);
		expect(succeeded).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastPlatformOwnerError);
	});

	test("hammer: 20 concurrent destructive ops on a 2-owner platform never reach zero owners", async () => {
		// Repeat the race many times to flush out non-determinism. After each round
		// we re-seed two owners; the invariant must hold every single time.
		for (let round = 0; round < 20; round++) {
			await seedTwoActiveOwners();
			const ops: Array<Promise<unknown>> = [
				storeA.updateProtectingLastOwner("owner-a", { isActive: false }),
				storeB.deleteProtectingLastOwner("owner-b"),
			];
			const results = await Promise.allSettled(ops);
			const remaining = await activeOwnerCount();
			expect(remaining).toBeGreaterThanOrEqual(1);
			const rejected = results.filter((r) => r.status === "rejected");
			// At most one destructive op can win; at least one must be rejected.
			expect(rejected.length).toBeGreaterThanOrEqual(1);
			for (const r of rejected) {
				expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LastPlatformOwnerError);
			}
		}
	});
});
