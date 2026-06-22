// VERIFICATION (PR #184 Codex P1): the BACKFILL upsert must MERGE raw (existing ||
// incoming), not CLOBBER it — the SAME as the live webhook (dodo.service.ts) and
// support (payment-transactions-store.ts) paths.
//
// SCENARIO (the bug the fix removes):
//   1. A support-console refund records its negative ledger row keyed on the PROVIDER
//      refund id R, stashing raw.supportIdempotencyKey=K (the pre-provider replay guard).
//   2. The Dodo refund WEBHOOK for the SAME refund R is later replayed by the backfill.
//      Its payload has NO supportIdempotencyKey. The backfill dedupes onto the SAME
//      (kind='refund', dodo_event_ref=R) row.
//   3. PRE-FIX: `raw = EXCLUDED.raw` CLOBBERS the support fields → a later same-key
//      support replay can't find the row via raw->>'supportIdempotencyKey' → re-enters
//      the provider refund path (a SECOND money-out).
//   4. POST-FIX: `raw = payment_transactions.raw || EXCLUDED.raw` MERGES → K survives,
//      the replay short-circuits, provider is NOT called a second time.
//
// Gated on TEST_DATABASE_URL (skipped without it):
//   docker run -d --name pg-backfill-raw -e POSTGRES_PASSWORD=test -p 55449:5432 postgres:16
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55449/postgres bun run src/migrations/cli.ts up
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55449/postgres \
//     bun test src/__tests__/backfill-raw-merge.real-pg.test.ts

import { describe, test, expect } from "bun:test";
import { DodoService } from "../services/dodo.service.js";
import { PostgresPaymentTransactionsStore } from "../services/payment-transactions-store.js";
import { backfillPaymentTransactions, type BackfillSqlClient } from "../scripts/backfill-payment-transactions.js";
import { serverConfig } from "../config.js";
import type DodoPayments from "dodopayments";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

// A DodoService whose refunds.create returns a KNOWN, STABLE refund id and counts calls,
// so we can prove the SECOND (replay) refund never re-calls the provider.
function dodoReturning(refundId: string): { dodo: DodoService; calls: () => number } {
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
	return { dodo, calls: () => state.calls };
}

describeReal("backfill raw merge preserves support provenance (real Postgres)", () => {
	test("backfill of the refund webhook does NOT clobber raw.supportIdempotencyKey; same-key replay finds the row (no 2nd provider call)", async () => {
		const NS = `bfraw-${Date.now()}`;
		const WS = `${NS}-ws`;
		const CHARGE = `${NS}-charge`;
		const REFUND_ID = `${NS}-refund`; // R — the provider refund id (canonical dedupe ref)
		const KEY = `${NS}-idem`; // K — supportIdempotencyKey
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		const store = new PostgresPaymentTransactionsStore(raw);

		try {
			// Seed the ORIGINAL charge so the refund's amount/currency cap validates.
			await store.upsertTransaction({
				workspaceId: WS,
				dodoPaymentId: CHARGE,
				dodoEventRef: CHARGE,
				kind: "payment",
				amountCents: 5000,
				currency: "USD",
				status: "succeeded",
				occurredAt: new Date().toISOString(),
				raw: { source: "test" },
			});

			const { dodo, calls } = dodoReturning(REFUND_ID);

			// (1) Support-console refund — provider returns R, row keyed on R, raw has K.
			const first = await dodo.recordSupportRefund({
				workspaceId: WS,
				dodoChargeId: CHARGE,
				idempotencyKey: KEY,
				amountCents: 2500,
				currency: "USD",
				initiatedBy: "admin@example.com",
				reason: "customer request",
				paymentTransactionsStore: store,
			});
			expect(first.providerRefundId).toBe(REFUND_ID);
			expect(calls()).toBe(1);

			const seeded = await store.findByEventRef("refund", REFUND_ID);
			expect(seeded).not.toBeNull();
			expect(seeded?.raw?.supportIdempotencyKey).toBe(KEY);

			// (2) Seed the Dodo refund WEBHOOK for R into dodo_webhook_events (NO support key).
			await raw.unsafe(
				`INSERT INTO dodo_webhook_events (id, type, payload, received_at)
				 VALUES ($1, $2, $3::jsonb, now())
				 ON CONFLICT (id) DO NOTHING`,
				[
					`${NS}-evt`,
					"refund.succeeded",
					JSON.stringify({
						data: {
							refund_id: REFUND_ID,
							payment_id: CHARGE,
							amount: 2500,
							currency: "USD",
							status: "succeeded",
							created_at: new Date().toISOString(),
						},
					}),
				],
			);

			// (3) Run the backfill over stored webhook events. It dedupes onto the SAME
			// (refund, R) row and (pre-fix) WOULD clobber raw with the webhook payload.
			const client = raw as unknown as BackfillSqlClient;
			const result = await backfillPaymentTransactions(client);
			expect(result.upserted).toBeGreaterThanOrEqual(1);

			// (4a) The support provenance MUST survive the backfill merge.
			const afterBackfill = await store.findByEventRef("refund", REFUND_ID);
			expect(afterBackfill).not.toBeNull();
			expect(afterBackfill?.raw?.supportIdempotencyKey).toBe(KEY); // <-- the P1 assertion
			// The webhook payload also folded in (merge, not isolated-clobber-the-other-way).
			expect(afterBackfill?.raw?.refund_id).toBe(REFUND_ID);
			// Still ONE refund row for R (dedupe held).
			const refundRows = await raw.unsafe(
				`SELECT count(*)::int AS n FROM payment_transactions WHERE kind = 'refund' AND dodo_event_ref = $1`,
				[REFUND_ID],
			);
			expect(refundRows[0].n).toBe(1);

			// (4b) A same-key support replay must still FIND the row via the stashed K and
			// short-circuit WITHOUT a second provider money-out.
			const replay = await dodo.recordSupportRefund({
				workspaceId: WS,
				dodoChargeId: CHARGE,
				idempotencyKey: KEY,
				amountCents: 2500,
				currency: "USD",
				initiatedBy: "admin@example.com",
				reason: "customer request",
				paymentTransactionsStore: store,
			});
			expect(replay.transaction.id).toBe(seeded!.id); // same row
			expect(calls()).toBe(1); // provider NOT called a second time — money-out safety intact
		} finally {
			await raw.unsafe(`DELETE FROM payment_transactions WHERE workspace_id = $1`, [WS]).catch(() => {});
			await raw.unsafe(`DELETE FROM dodo_webhook_events WHERE id = $1`, [`${NS}-evt`]).catch(() => {});
			await raw.close?.();
		}
	});
});
