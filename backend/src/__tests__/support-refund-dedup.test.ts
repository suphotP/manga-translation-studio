// Money double-record proof for the support-console refund path (PR #184 P1).
//
// THE BUG (pre-fix): a support-initiated refund recorded its negative ledger row keyed
// on `dodo_event_ref = <idempotencyKey>`, while the later Dodo refund WEBHOOK for the
// SAME provider refund records keyed on `dodo_event_ref = <providerRefundId>`. Because
// the only dedupe identity is `(kind, dodo_event_ref)`, the two are DISTINCT rows — so
// ONE $25 provider refund became -2500 (support key) + -2500 (refund id) = -$50: the
// cumulative refunded read DOUBLE and revenue was understated by the extra refund.
//
// THE FIX: unify the dedupe IDENTITY. When `refunds.create` returns a real provider
// refund id, the support row is recorded with `dodo_event_ref = <providerRefundId>` —
// the SAME key the webhook uses — so the webhook's `ON CONFLICT (kind, dodo_event_ref)`
// UPDATES the EXISTING support row instead of inserting a second. The support
// idempotency key (only known pre-provider) is stashed in `raw.supportIdempotencyKey`
// and is the PRE-PROVIDER replay guard (so a retried same-key refund never re-calls the
// provider). When there is no provider refund id (BILLING_PROVIDER=none, no webhook will
// follow), the ref falls back to the idempotency key.
//
// NEGATIVE CONTROL (committed, always runs): `recordLegacySupportRefund` reproduces the
// OLD identity (`dodo_event_ref = idempotencyKey`) and PROVES that the same webhook then
// records a SECOND row / doubles the refunded total — i.e. the proof is not a bare
// assertion against the fixed code, it demonstrates the bug the fix removes.
//
// File mode always runs. The real-Postgres mirror (same unique-index dedupe the live
// system relies on) is gated on TEST_DATABASE_URL:
//
//   docker run -d --name pg-refund-dedup -e POSTGRES_PASSWORD=test -p 55447:5432 postgres:16
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55447/postgres bun run src/migrations/cli.ts up
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55447/postgres \
//     bun test src/__tests__/support-refund-dedup.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DodoService } from "../services/dodo.service.js";
import {
	FilePaymentTransactionsStore,
	PostgresPaymentTransactionsStore,
	type PaymentTransactionsStore,
	type UpsertPaymentTransactionInput,
} from "../services/payment-transactions-store.js";
import { absCents, negateCents } from "../utils/money.js";
import { serverConfig } from "../config.js";
import type DodoPayments from "dodopayments";

// A DodoService whose refunds.create returns a KNOWN, STABLE refund id (the same id the
// later webhook will carry). billingProvider="dodo" so the provider branch fires.
function dodoReturning(refundId: string): { dodo: DodoService; calls: number } {
	const state = { calls: 0 };
	const dodo = new DodoService({
		sqlClient: null,
		client: {
			refunds: {
				create: async () => {
					state.calls += 1;
					return { refund_id: refundId, status: "succeeded" };
				},
			},
		} as unknown as DodoPayments,
		config: { ...serverConfig, billingProvider: "dodo" },
	});
	return {
		dodo,
		get calls() {
			return state.calls;
		},
	};
}

// Simulate the Dodo refund webhook landing for provider refund `refundId` against
// `chargeId`. The live webhook path (recordRefundTransaction → upsertPaymentTransactionRow)
// records a refund row keyed on `dodo_event_ref = refundId` with a NEGATIVE amount; this
// reproduces that write through the SAME store, so the `(kind, dodo_event_ref)` dedupe is
// exercised exactly as in production.
function simulateRefundWebhook(
	store: PaymentTransactionsStore,
	opts: { chargeId: string; refundId: string; workspaceId: string; amountCents: number; currency: string },
): Promise<unknown> {
	return store.upsertTransaction({
		workspaceId: opts.workspaceId,
		dodoPaymentId: opts.chargeId,
		dodoEventRef: opts.refundId,
		dodoEventId: `evt_${opts.refundId}`,
		kind: "refund",
		amountCents: negateCents(absCents(opts.amountCents)),
		currency: opts.currency,
		status: "refunded",
		occurredAt: new Date().toISOString(),
		raw: { refund_id: opts.refundId, payment_id: opts.chargeId, amount: opts.amountCents },
	});
}

// The OLD (buggy) support-refund record path: keyed on the IDEMPOTENCY KEY, with the
// provider refund id only in raw — exactly the pre-fix identity. Used by the negative
// control to demonstrate the double-record the fix removes.
function recordLegacySupportRefund(
	store: PaymentTransactionsStore,
	opts: { chargeId: string; idempotencyKey: string; providerRefundId: string; workspaceId: string; amountCents: number; currency: string },
): Promise<unknown> {
	const input: UpsertPaymentTransactionInput = {
		workspaceId: opts.workspaceId,
		dodoPaymentId: opts.chargeId,
		dodoEventRef: opts.idempotencyKey, // <-- the BUG: not the provider refund id
		kind: "refund",
		amountCents: negateCents(absCents(opts.amountCents)),
		currency: opts.currency,
		status: "refunded",
		occurredAt: new Date().toISOString(),
		raw: { source: "support_console", dodo_charge_id: opts.chargeId, dodo_refund_id: opts.providerRefundId },
	};
	return store.upsertTransaction(input);
}

function runSuite(label: string, makeStore: () => PaymentTransactionsStore | Promise<PaymentTransactionsStore>, teardown?: (store: PaymentTransactionsStore) => Promise<void>) {
	describe(label, () => {
		const WS = `dedup-${label.replace(/\W+/g, "-")}-ws`;
		let store: PaymentTransactionsStore;

		async function seedCharge(chargeId: string, paidCents: number): Promise<void> {
			await store.upsertTransaction({
				workspaceId: WS, kind: "payment", amountCents: paidCents, currency: "USD", status: "succeeded",
				dodoPaymentId: chargeId, dodoEventRef: `${chargeId}-pay`,
			});
		}

		beforeEach(async () => {
			store = await makeStore();
		});

		afterAll(async () => {
			if (teardown && store) await teardown(store);
		});

		// (a) THE FIX: support refund (returns refund id R) records ONE row keyed on R;
		// the subsequent Dodo refund WEBHOOK for R dedupes onto that SAME row — NO second
		// row, cumulative refunded = the single amount, revenue reflects ONE -amount.
		test("support refund + its webhook = exactly ONE ledger row (refund id R)", async () => {
			const CHARGE = `${WS}-a`;
			await seedCharge(CHARGE, 10000); // $100 paid
			const R = "rfnd_known_A";
			const svc = dodoReturning(R);

			const result = await svc.dodo.recordSupportRefund({
				workspaceId: WS, amountCents: 2500, currency: "USD", reason: "goodwill",
				initiatedBy: "admin", idempotencyKey: "sup-key-A", dodoChargeId: CHARGE,
				paymentTransactionsStore: store,
			});
			expect(svc.calls).toBe(1);
			expect(result.providerRefundId).toBe(R);
			// The support row's canonical dedupe ref is the PROVIDER refund id (unified with
			// the webhook), and the idempotency key is preserved in raw for replay dedupe.
			expect(result.transaction.dodoEventRef).toBe(R);
			expect(result.transaction.raw.supportIdempotencyKey).toBe("sup-key-A");

			let rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
			expect(rows.total).toBe(1);
			expect(rows.transactions[0]?.amountCents).toBe(-2500);

			// Now the Dodo refund webhook for the SAME provider refund R arrives.
			await simulateRefundWebhook(store, { chargeId: CHARGE, refundId: R, workspaceId: WS, amountCents: 2500, currency: "USD" });

			// DECISIVE: still exactly ONE refund row — the webhook deduped onto the support row.
			rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
			expect(rows.total).toBe(1);
			expect(rows.transactions[0]?.amountCents).toBe(-2500);
			// The webhook MERGED into the existing row: provenance survives, payload folds in.
			expect(rows.transactions[0]?.raw.supportIdempotencyKey).toBe("sup-key-A");
			expect(rows.transactions[0]?.raw.source).toBe("support_console");

			// Cumulative refunded is the SINGLE refund, never doubled; revenue nets ONE -amount.
			const state = await store.getChargeRefundState(CHARGE, WS);
			expect(state.alreadyRefundedCents).toBe("2500");
			expect(state.remainingRefundableCents).toBe("7500");
			const sums = await store.sumByPlan({});
			const refundSum = sums.filter((s) => s.kind === "refund").reduce((acc, s) => acc + BigInt(s.amountCents), 0n);
			expect(refundSum).toBe(-2500n); // exactly one -2500, not -5000
		});

		// NEGATIVE CONTROL: the OLD identity (ref = idempotencyKey) double-records.
		// This is what the fix removes — it MUST fail to dedupe (two rows, doubled total).
		test("NEGATIVE CONTROL: legacy ref=idempotencyKey double-records on the webhook", async () => {
			const CHARGE = `${WS}-neg`;
			await seedCharge(CHARGE, 10000);
			const R = "rfnd_known_NEG";

			// OLD support path: row keyed on the idempotency key, refund id only in raw.
			await recordLegacySupportRefund(store, {
				chargeId: CHARGE, idempotencyKey: "legacy-key", providerRefundId: R,
				workspaceId: WS, amountCents: 2500, currency: "USD",
			});
			let rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
			expect(rows.total).toBe(1);

			// The webhook for the SAME refund R arrives (keyed on R, not the idempotency key).
			await simulateRefundWebhook(store, { chargeId: CHARGE, refundId: R, workspaceId: WS, amountCents: 2500, currency: "USD" });

			// PROOF OF THE BUG: two DISTINCT rows because the dedupe identities differ.
			rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
			expect(rows.total).toBe(2);
			// And the cumulative refunded reads DOUBLE — one $25 refund booked as $50 out.
			const state = await store.getChargeRefundState(CHARGE, WS);
			expect(state.alreadyRefundedCents).toBe("5000");
		});

		// (b) replay the SAME idempotency key BEFORE the provider would be called a 2nd time:
		// no second provider call, no second row (pre-provider replay guard via raw key).
		test("same-key replay before provider → no 2nd provider call, no 2nd row", async () => {
			const CHARGE = `${WS}-b`;
			await seedCharge(CHARGE, 10000);
			const R = "rfnd_known_B";
			const svc = dodoReturning(R);
			const call = () => svc.dodo.recordSupportRefund({
				workspaceId: WS, amountCents: 2500, currency: "USD", reason: "x",
				initiatedBy: "admin", idempotencyKey: "replay-key", dodoChargeId: CHARGE,
				paymentTransactionsStore: store,
			});
			const first = await call();
			const second = await call();
			expect(svc.calls).toBe(1); // provider fired only once
			expect(second.transaction.id).toBe(first.transaction.id); // converged on same row
			const rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
			expect(rows.total).toBe(1);
		});

		// (c) no-provider path (BILLING_PROVIDER=none): records once keyed on the idempotency
		// key (no webhook will ever follow) and is idempotent on replay.
		test("BILLING_PROVIDER=none → records once (ref=idempotencyKey) + idempotent", async () => {
			const CHARGE = `${WS}-c`;
			await seedCharge(CHARGE, 10000);
			const dodo = new DodoService({
				sqlClient: null,
				client: { refunds: { create: async () => { throw new Error("provider must NOT be called in none mode"); } } } as unknown as DodoPayments,
				config: { ...serverConfig, billingProvider: "none" },
			});
			const call = () => dodo.recordSupportRefund({
				workspaceId: WS, amountCents: 2500, currency: "USD", reason: "x",
				initiatedBy: "admin", idempotencyKey: "none-key", dodoChargeId: CHARGE,
				paymentTransactionsStore: store,
			});
			const first = await call();
			expect(first.providerRefundId).toBeNull();
			expect(first.transaction.dodoEventRef).toBe("none-key"); // falls back to the key
			const second = await call();
			expect(second.transaction.id).toBe(first.transaction.id);
			const rows = await store.listTransactions({ workspaceId: WS, kind: "refund" });
			expect(rows.total).toBe(1);
			expect(rows.transactions[0]?.amountCents).toBe(-2500);
		});
	});
}

// ── FILE MODE — always runs ───────────────────────────────────────────────────────
runSuite("dedup (file mode)", () => new FilePaymentTransactionsStore());

// ── REAL POSTGRES — the unique-index dedupe the live system relies on ───────────────
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_DATABASE_URL.trim()) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const raw: any = new Bun.SQL(TEST_DATABASE_URL, { max: 10 });
	const store = new PostgresPaymentTransactionsStore(raw);
	runSuite(
		"dedup (REAL Postgres)",
		async () => {
			await raw.unsafe(`DELETE FROM payment_transactions WHERE workspace_id LIKE 'dedup-%'`).catch(() => {});
			await raw.unsafe(
				`INSERT INTO workspaces (workspace_id, name, created_at, updated_at)
				 VALUES ('dedup-dedup-REAL-Postgres-ws', 'Refund Dedup Co', now(), now())
				 ON CONFLICT (workspace_id) DO NOTHING`,
			).catch(() => {});
			return store;
		},
		async () => {
			await raw.unsafe(`DELETE FROM payment_transactions WHERE workspace_id LIKE 'dedup-%'`).catch(() => {});
			await raw.unsafe(`DELETE FROM workspaces WHERE workspace_id LIKE 'dedup-%'`).catch(() => {});
			await raw.close?.();
		},
	);
}
