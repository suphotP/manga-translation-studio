// Money-out CONCURRENCY proof for the support-console refund path (PR #184 P1).
//
// recordSupportRefund's critical section — dedupe → re-read cumulative → validate →
// provider money-out → ledger write — is NOT individually atomic, so it must be
// serialized PER CHARGE (a Postgres advisory xact lock in DB mode, a per-charge mutex
// in file mode). Two classes of race are proven closed here:
//
//   BUG 1 — N concurrent SAME-key refunds: each used to find no row and each call the
//     provider, double-spending. After the fix the provider is called EXACTLY ONCE and
//     exactly ONE negative ledger row exists; the losers converge on that row.
//
//   BUG 2 — N concurrent DIFFERENT-key partials on one charge: each used to read
//     refunded=0, pass the cap, and together out-refund the original (two $60 on a $100
//     charge → $120 out). After the fix the SUM of refunds NEVER exceeds the original;
//     the over-budget requests are rejected (dodo_refund_exceeds_original /
//     dodo_refund_already_full) and the provider is called only for those that fit.
//
// The provider stub COUNTS calls and adds a small async delay to WIDEN the race window
// (so the buggy code would reliably interleave). The file-mode suite always runs (it
// exercises the in-process mutex). The real-Postgres suite (the advisory lock — the only
// place the cross-connection race actually manifests) is gated on TEST_DATABASE_URL:
//
//   docker run -d --name pg-refund -e POSTGRES_PASSWORD=test -p 55446:5432 postgres:16
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55446/postgres bun run src/migrations/cli.ts up
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55446/postgres \
//     bun test src/__tests__/support-refund-concurrency.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DodoService, DodoBillingError } from "../services/dodo.service.js";
import {
	FilePaymentTransactionsStore,
	PostgresPaymentTransactionsStore,
	type PaymentTransactionsStore,
} from "../services/payment-transactions-store.js";
import { serverConfig } from "../config.js";
import type DodoPayments from "dodopayments";

// A DodoService wired to a LIVE-provider config with a COUNTING, DELAYING refunds.create
// spy. The delay widens the race window so the pre-fix interleaving is reliably hit.
function spyDodo(delayMs = 25): { dodo: DodoService; calls: Array<{ paymentId: string; amount: number }>; callCount: () => number } {
	const calls: Array<{ paymentId: string; amount: number }> = [];
	const dodo = new DodoService({
		sqlClient: null,
		client: {
			refunds: {
				create: async (body: unknown, _options: unknown) => {
					// Record BEFORE the await so the count reflects entry into the provider
					// call (a buggy interleave would push twice here).
					const b = body as { payment_id: string; items?: Array<{ amount: number }> };
					calls.push({ paymentId: b.payment_id, amount: b.items?.[0]?.amount ?? 0 });
					await new Promise((r) => setTimeout(r, delayMs));
					return { refund_id: `rfnd_${calls.length}`, status: "succeeded" };
				},
			},
		} as unknown as DodoPayments,
		config: { ...serverConfig, billingProvider: "dodo" },
	});
	return { dodo, calls, callCount: () => calls.length };
}

// Settle a batch of recordSupportRefund promises and bucket fulfilled vs the 400-rejected.
async function settle(promises: Array<Promise<unknown>>): Promise<{ ok: number; rejected: DodoBillingError[] }> {
	const results = await Promise.allSettled(promises);
	const rejected = results
		.filter((r): r is PromiseRejectedResult => r.status === "rejected")
		.map((r) => r.reason as DodoBillingError);
	return { ok: results.filter((r) => r.status === "fulfilled").length, rejected };
}

// ── FILE MODE (in-process per-charge mutex) — always runs ──────────────────────────
describe("support refund concurrency (file mode mutex)", () => {
	const CHARGE = "charge-file-1";
	const WS = "ws-file-1";
	let store: FilePaymentTransactionsStore;
	let spy: ReturnType<typeof spyDodo>;

	beforeEach(async () => {
		store = new FilePaymentTransactionsStore(); // in-memory, no persist path
		spy = spyDodo();
		// Seed the original $100.00 charge.
		await store.upsertTransaction({
			workspaceId: WS, kind: "payment", amountCents: 10000, currency: "USD", status: "succeeded",
			dodoPaymentId: CHARGE, dodoEventRef: "pay-file-1",
		});
	});

	test("BUG 1: 8 concurrent SAME-key refunds → provider called ONCE, one ledger row", async () => {
		const refund = (i: number) => spy.dodo.recordSupportRefund({
			workspaceId: WS, amountCents: 2500, currency: "USD", reason: `r${i}`,
			initiatedBy: "admin", idempotencyKey: "same-key", dodoChargeId: CHARGE,
			paymentTransactionsStore: store,
		});
		const { ok, rejected } = await settle(Array.from({ length: 8 }, (_, i) => refund(i)));
		// All 8 resolve (the losers converge on the winner's row, no error), and the
		// provider fired exactly once.
		expect(ok).toBe(8);
		expect(rejected).toHaveLength(0);
		expect(spy.callCount()).toBe(1);
		const rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
		expect(rows.total).toBe(1);
		expect(rows.transactions[0]?.amountCents).toBe(-2500);
		// Cumulative refunded is exactly one partial, never 8×.
		const state = await store.getChargeRefundState(CHARGE, WS);
		expect(state.alreadyRefundedCents).toBe("2500");
	});

	test("BUG 2: 5 concurrent DIFFERENT-key $30 partials on a $100 charge → never over-refund", async () => {
		// 5 × $30 = $150 requested against $100 paid. At most 3 ($90) can fit; the rest
		// must be rejected, and the provider must fire only for the ones that fit.
		const refund = (i: number) => spy.dodo.recordSupportRefund({
			workspaceId: WS, amountCents: 3000, currency: "USD", reason: `r${i}`,
			initiatedBy: "admin", idempotencyKey: `key-${i}`, dodoChargeId: CHARGE,
			paymentTransactionsStore: store,
		});
		const { ok, rejected } = await settle(Array.from({ length: 5 }, (_, i) => refund(i)));
		// 3 fit ($90), 2 rejected with the cap error.
		expect(ok).toBe(3);
		expect(rejected).toHaveLength(2);
		for (const e of rejected) {
			expect(e).toBeInstanceOf(DodoBillingError);
			expect(["dodo_refund_exceeds_original", "dodo_refund_already_full"]).toContain(e.code);
		}
		// Provider called only for the 3 that fit.
		expect(spy.callCount()).toBe(3);
		// The decisive invariant: total refunded NEVER exceeds the original.
		const state = await store.getChargeRefundState(CHARGE, WS);
		expect(BigInt(state.alreadyRefundedCents) <= BigInt(state.originalPaidCents)).toBe(true);
		expect(state.alreadyRefundedCents).toBe("9000");
		expect(state.remainingRefundableCents).toBe("1000");
	});

	test("sequential cases still pass: partial then exact-remaining then over-refund 400", async () => {
		const r1 = await spy.dodo.recordSupportRefund({
			workspaceId: WS, amountCents: 4000, currency: "USD", reason: "a",
			initiatedBy: "admin", idempotencyKey: "seq-1", dodoChargeId: CHARGE, paymentTransactionsStore: store,
		});
		expect(r1.transaction.amountCents).toBe(-4000);
		const r2 = await spy.dodo.recordSupportRefund({
			workspaceId: WS, amountCents: 6000, currency: "USD", reason: "b",
			initiatedBy: "admin", idempotencyKey: "seq-2", dodoChargeId: CHARGE, paymentTransactionsStore: store,
		});
		expect(r2.transaction.amountCents).toBe(-6000);
		// $100 now fully refunded; any further refund is rejected.
		await expect(spy.dodo.recordSupportRefund({
			workspaceId: WS, amountCents: 1, currency: "USD", reason: "c",
			initiatedBy: "admin", idempotencyKey: "seq-3", dodoChargeId: CHARGE, paymentTransactionsStore: store,
		})).rejects.toMatchObject({ code: "dodo_refund_already_full" });
		expect(spy.callCount()).toBe(2);
	});
});

// ── REAL POSTGRES (advisory xact lock) — the cross-connection race only manifests here ─
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const runOrSkip = TEST_DATABASE_URL.trim() ? describe : describe.skip;

runOrSkip("support refund concurrency (REAL Postgres advisory lock)", () => {
	// One Bun.SQL pool with several connections so concurrent transactions land on
	// DISTINCT connections — exactly the condition the race needs.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const raw: any = new Bun.SQL(TEST_DATABASE_URL, { max: 10 });
	const store: PaymentTransactionsStore = new PostgresPaymentTransactionsStore(raw);
	const NS = `refund-race-${Date.now()}`;
	const WS = `${NS}-ws`;

	async function seedCharge(chargeId: string, paidCents: number): Promise<void> {
		await raw.unsafe(
			`INSERT INTO workspaces (workspace_id, name, created_at, updated_at)
			 VALUES ($1, $2, now(), now()) ON CONFLICT (workspace_id) DO NOTHING`,
			[WS, "Refund Race Co"],
		);
		await store.upsertTransaction({
			workspaceId: WS, kind: "payment", amountCents: paidCents, currency: "USD", status: "succeeded",
			dodoPaymentId: chargeId, dodoEventRef: `${chargeId}-pay`,
		});
	}

	beforeEach(async () => {
		await raw.unsafe(`DELETE FROM payment_transactions WHERE workspace_id = $1`, [WS]).catch(() => {});
	});

	afterAll(async () => {
		await raw.unsafe(`DELETE FROM payment_transactions WHERE workspace_id = $1`, [WS]).catch(() => {});
		await raw.unsafe(`DELETE FROM workspaces WHERE workspace_id = $1`, [WS]).catch(() => {});
		await raw.close?.();
	});

	test("BUG 1: 10 concurrent SAME-key refunds → provider called ONCE, one ledger row", async () => {
		const CHARGE = `${NS}-c1`;
		await seedCharge(CHARGE, 10000);
		const spy = spyDodo();
		const refund = (i: number) => spy.dodo.recordSupportRefund({
			workspaceId: WS, amountCents: 2500, currency: "USD", reason: `r${i}`,
			initiatedBy: "admin", idempotencyKey: "pg-same-key", dodoChargeId: CHARGE,
			paymentTransactionsStore: store,
		});
		const { rejected } = await settle(Array.from({ length: 10 }, (_, i) => refund(i)));
		// The (kind, dodo_event_ref) unique index is a backstop: if two reservations ever
		// raced the insert, the loser would surface a conflict rather than double-spend.
		// With the advisory lock the dedupe SELECT serializes first, so no conflict at all.
		expect(rejected).toHaveLength(0);
		expect(spy.callCount()).toBe(1);
		const rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
		expect(rows.total).toBe(1);
		const state = await store.getChargeRefundState(CHARGE, WS);
		expect(state.alreadyRefundedCents).toBe("2500");
	});

	test("BUG 2: 5 concurrent DIFFERENT-key $30 partials on a $100 charge → never over-refund", async () => {
		const CHARGE = `${NS}-c2`;
		await seedCharge(CHARGE, 10000);
		const spy = spyDodo();
		const refund = (i: number) => spy.dodo.recordSupportRefund({
			workspaceId: WS, amountCents: 3000, currency: "USD", reason: `r${i}`,
			initiatedBy: "admin", idempotencyKey: `pg-key-${i}`, dodoChargeId: CHARGE,
			paymentTransactionsStore: store,
		});
		const { ok, rejected } = await settle(Array.from({ length: 5 }, (_, i) => refund(i)));
		expect(ok).toBe(3);
		expect(rejected).toHaveLength(2);
		for (const e of rejected) {
			expect(["dodo_refund_exceeds_original", "dodo_refund_already_full"]).toContain(e.code);
		}
		expect(spy.callCount()).toBe(3);
		const state = await store.getChargeRefundState(CHARGE, WS);
		expect(BigInt(state.alreadyRefundedCents) <= BigInt(state.originalPaidCents)).toBe(true);
		expect(state.alreadyRefundedCents).toBe("9000");
	});

	test("HAMMER: 12 different-key partials of varied size never breach the original", async () => {
		const CHARGE = `${NS}-c3`;
		await seedCharge(CHARGE, 10000); // $100
		const spy = spyDodo(10);
		// Mixed amounts summing well past $100; whichever subset wins must total <= $100.
		const amounts = [1500, 2000, 1000, 3000, 2500, 1500, 4000, 500, 2000, 3000, 1000, 2500];
		const { rejected } = await settle(
			amounts.map((amt, i) => spy.dodo.recordSupportRefund({
				workspaceId: WS, amountCents: amt, currency: "USD", reason: `h${i}`,
				initiatedBy: "admin", idempotencyKey: `pg-hammer-${i}`, dodoChargeId: CHARGE,
				paymentTransactionsStore: store,
			})),
		);
		const state = await store.getChargeRefundState(CHARGE, WS);
		// Decisive invariant under heavy concurrency: never out-refund the original.
		expect(BigInt(state.alreadyRefundedCents) <= BigInt(state.originalPaidCents)).toBe(true);
		// Provider was called for exactly the winners (the rows that landed).
		const rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
		expect(spy.callCount()).toBe(rows.total);
		// At least one request was rejected (we requested far more than $100).
		expect(rejected.length).toBeGreaterThan(0);
		for (const e of rejected) {
			expect(["dodo_refund_exceeds_original", "dodo_refund_already_full"]).toContain(e.code);
		}
	});
});
