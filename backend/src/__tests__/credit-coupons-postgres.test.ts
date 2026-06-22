// Real-Postgres integration coverage for the internal credit-coupon store
// (migration 0055). The in-memory fake cannot validate real ON CONFLICT
// idempotency, the FOR UPDATE + INSERT...SELECT max_redemptions guard, or the
// transactional per_user_limit count — so these are asserted against a migrated
// Postgres.
//
// Gated on CREDIT_COUPONS_TEST_DATABASE_URL so the default `bun test` run skips:
//
//   docker run -d --name pgcoup -e POSTGRES_PASSWORD=verify -e POSTGRES_USER=verify \
//     -e POSTGRES_DB=coupons -p 55471:5432 postgres:16
//   DATABASE_URL=postgres://verify:verify@127.0.0.1:55471/coupons bun run src/migrations/cli.ts up
//   CREDIT_COUPONS_TEST_DATABASE_URL=postgres://verify:verify@127.0.0.1:55471/coupons \
//     bun test credit-coupons-postgres

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PostgresCreditCouponStore, CreditCouponError } from "../services/credit-coupons.js";

const DB_URL = process.env.CREDIT_COUPONS_TEST_DATABASE_URL?.trim();
const describeMaybe = DB_URL ? describe : describe.skip;

// Typed client view so `rows[0]` indexes a T[] under noUncheckedIndexedAccess
// (the raw Bun.SQL .unsafe<T> type returns T, not T[]) — mirrors the typed-client
// seam owner-guard-postgres-race.test.ts uses.
interface TestSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

describeMaybe("PostgresCreditCouponStore (real Postgres)", () => {
	const sql = new Bun.SQL(DB_URL as string) as unknown as TestSqlClient;
	const store = new PostgresCreditCouponStore(sql as never);

	beforeEach(async () => {
		await sql.unsafe("DELETE FROM credit_coupon_redemptions");
		await sql.unsafe("DELETE FROM credit_coupons");
	});
	afterAll(async () => {
		await sql.close?.();
	});

	test("create with explicit code persists + lists with redemptionCount 0", async () => {
		const c = await store.createCoupon({ code: "PGWELCOME", creditAmount: 100, maxRedemptions: 5, perUserLimit: 1, createdBy: "admin-1" });
		expect(c.code).toBe("PGWELCOME");
		expect(c.redemptionCount).toBe(0);
		const list = await store.listCoupons();
		expect(list.find((x) => x.code === "PGWELCOME")?.creditAmount).toBe(100);
	});

	test("duplicate explicit code → 409", async () => {
		await store.createCoupon({ code: "DUPE123", creditAmount: 10, createdBy: "a" });
		await expect(store.createCoupon({ code: "dupe123", creditAmount: 10, createdBy: "a" })).rejects.toBeInstanceOf(CreditCouponError);
	});

	test("redeem once reserves exactly one row; a same-key retry is idempotent", async () => {
		await store.createCoupon({ code: "ONCEPG", creditAmount: 50, perUserLimit: 1, createdBy: "a" });
		const now = new Date();
		const first = await store.reserveRedemption({ code: "ONCEPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "ONCEPG:u1", now });
		expect(first.alreadyRedeemed).toBe(false);
		const retry = await store.reserveRedemption({ code: "ONCEPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "ONCEPG:u1", now });
		expect(retry.alreadyRedeemed).toBe(true);
		expect(retry.redemption.id).toBe(first.redemption.id);
		const rows = await sql.unsafe<{ count: string }>("SELECT COUNT(*) AS count FROM credit_coupon_redemptions");
		expect(Number(rows[0]!.count)).toBe(1);
	});

	test("same client idempotency string is user-scoped", async () => {
		await store.createCoupon({ code: "SAMEPG", creditAmount: 50, maxRedemptions: 2, perUserLimit: 1, createdBy: "a" });
		const now = new Date();
		const first = await store.reserveRedemption({ code: "SAMEPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "client-key", now });
		const second = await store.reserveRedemption({ code: "SAMEPG", userId: "u2", workspaceId: "ws1", idempotencyKey: "client-key", now });
		expect(first.alreadyRedeemed).toBe(false);
		expect(second.alreadyRedeemed).toBe(false);
		expect(second.redemption.id).not.toBe(first.redemption.id);

		const replay = await store.reserveRedemption({ code: "SAMEPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "client-key", now });
		expect(replay.alreadyRedeemed).toBe(true);
		expect(replay.redemption.id).toBe(first.redemption.id);

		const rows = await sql.unsafe<{ count: string }>("SELECT COUNT(*) AS count FROM credit_coupon_redemptions");
		expect(Number(rows[0]!.count)).toBe(2);
	});

	test("per_user_limit blocks a distinct second redeem by the same user", async () => {
		await store.createCoupon({ code: "LIMPG", creditAmount: 10, perUserLimit: 1, createdBy: "a" });
		const now = new Date();
		await store.reserveRedemption({ code: "LIMPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "k1", now });
		await expect(store.reserveRedemption({ code: "LIMPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "k2", now })).rejects.toMatchObject({ code: "per_user_limit_reached" });
	});

	test("max_redemptions enforced across users (concurrent-safe guard)", async () => {
		await store.createCoupon({ code: "CAPPG", creditAmount: 5, maxRedemptions: 2, perUserLimit: 1, createdBy: "a" });
		const now = new Date();
		await store.reserveRedemption({ code: "CAPPG", userId: "uA", workspaceId: "ws1", idempotencyKey: "kA", now });
		await store.reserveRedemption({ code: "CAPPG", userId: "uB", workspaceId: "ws1", idempotencyKey: "kB", now });
		await expect(store.reserveRedemption({ code: "CAPPG", userId: "uC", workspaceId: "ws1", idempotencyKey: "kC", now })).rejects.toMatchObject({ code: "max_redemptions_reached" });
		const rows = await sql.unsafe<{ count: string }>("SELECT COUNT(*) AS count FROM credit_coupon_redemptions");
		expect(Number(rows[0]!.count)).toBe(2);
	});

	test("concurrent redeems never exceed max_redemptions", async () => {
		await store.createCoupon({ code: "RACEPG", creditAmount: 5, maxRedemptions: 3, perUserLimit: 1, createdBy: "a" });
		const now = new Date();
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) =>
				store.reserveRedemption({ code: "RACEPG", userId: `r${i}`, workspaceId: "ws1", idempotencyKey: `k${i}`, now }),
			),
		);
		const ok = results.filter((r) => r.status === "fulfilled").length;
		expect(ok).toBe(3);
		const rows = await sql.unsafe<{ count: string }>("SELECT COUNT(*) AS count FROM credit_coupon_redemptions");
		expect(Number(rows[0]!.count)).toBe(3);
	});

	test("expired + disabled coupons are rejected", async () => {
		await store.createCoupon({ code: "EXPPG", creditAmount: 10, expiresAt: new Date(Date.now() - 1000).toISOString(), createdBy: "a" });
		await expect(store.reserveRedemption({ code: "EXPPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "k", now: new Date() })).rejects.toMatchObject({ code: "coupon_expired" });

		const killed = await store.createCoupon({ code: "DISPG", creditAmount: 10, createdBy: "a" });
		await store.disableCoupon(killed.id);
		await expect(store.reserveRedemption({ code: "DISPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "k", now: new Date() })).rejects.toMatchObject({ code: "coupon_disabled" });
	});

	test("attachGrantId links the credits-service grant id", async () => {
		await store.createCoupon({ code: "GRANTPG", creditAmount: 10, createdBy: "a" });
		const out = await store.reserveRedemption({ code: "GRANTPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "k", now: new Date() });
		await store.attachGrantId(out.redemption.id, "grant-xyz");
		const rows = await sql.unsafe<{ grant_id: string }>("SELECT grant_id FROM credit_coupon_redemptions WHERE id = $1", [out.redemption.id]);
		expect(rows[0]!.grant_id).toBe("grant-xyz");
	});

	test("P1 recovery: a reserved-but-ungranted row replays with grantId still NULL, then attaches once", async () => {
		// Simulates the crash window: reserveRedemption committed the row, but the
		// (separate) credit grant never ran, so grant_id is NULL. A same-key retry must
		// return the EXISTING row (alreadyRedeemed) carrying grantId=undefined so the
		// route knows to COMPLETE the grant — never report "already redeemed, 0 credits"
		// for a redemption whose grant never finished.
		await store.createCoupon({ code: "RECOVERPG", creditAmount: 60, perUserLimit: 1, createdBy: "a" });
		const now = new Date();
		const first = await store.reserveRedemption({ code: "RECOVERPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "RECOVERPG:u1", now });
		expect(first.alreadyRedeemed).toBe(false);
		expect(first.redemption.grantId).toBeUndefined(); // grant has NOT run yet

		// Retry before any grant: converges on the same row, grant still unlinked.
		const retry = await store.reserveRedemption({ code: "RECOVERPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "RECOVERPG:u1", now });
		expect(retry.alreadyRedeemed).toBe(true);
		expect(retry.redemption.id).toBe(first.redemption.id);
		expect(retry.redemption.grantId).toBeUndefined();

		// The route completes the grant + links it; a further replay now reports it done.
		await store.attachGrantId(first.redemption.id, "grant-recovered");
		const afterLink = await store.reserveRedemption({ code: "RECOVERPG", userId: "u1", workspaceId: "ws1", idempotencyKey: "RECOVERPG:u1", now });
		expect(afterLink.alreadyRedeemed).toBe(true);
		expect(afterLink.redemption.grantId).toBe("grant-recovered");

		// Still exactly one redemption row — recovery never reserves twice.
		const rows = await sql.unsafe<{ count: string }>("SELECT COUNT(*) AS count FROM credit_coupon_redemptions WHERE coupon_id = $1", [first.redemption.couponId]);
		expect(Number(rows[0]!.count)).toBe(1);
	});

	test("auto-generated code path produces a valid unique code", async () => {
		const c = await store.createCoupon({ creditAmount: 25, createdBy: "a" });
		expect(c.code).toMatch(/^[A-Z0-9-]{4,32}$/);
		expect(c.redemptionCount).toBe(0);
	});
});
