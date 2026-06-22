// Real-Postgres integration coverage for the revenue layer (payment_transactions).
//
// Gated on PAYMENT_TX_TEST_DATABASE_URL so the default `bun test` run (no DB) skips
// it cleanly; CI / local verification points it at a migrated Postgres to prove the
// SQL path itself is correct — the in-memory fake cannot validate real bigint SUMs,
// real ON CONFLICT idempotency, or the nullable workspace_id behavior.
//
//   docker run -d -e POSTGRES_PASSWORD=verify -e POSTGRES_USER=verify \
//     -e POSTGRES_DB=revenue -p 55439:5432 postgres:16-alpine
//   DATABASE_URL=postgres://verify:verify@127.0.0.1:55439/revenue bun run src/migrations/cli.ts up
//   PAYMENT_TX_TEST_DATABASE_URL=postgres://verify:verify@127.0.0.1:55439/revenue bun test payment-transactions-postgres

import { createHmac } from "crypto";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type DodoPayments from "dodopayments";
import { serverConfig } from "../config.js";
import { DodoService, type DodoSqlClient } from "../services/dodo.service.js";
import { PostgresPaymentTransactionsStore } from "../services/payment-transactions-store.js";
import { backfillPaymentTransactions, type BackfillSqlClient } from "../scripts/backfill-payment-transactions.js";
import { majorDecimalToCents, negateCents, sumCents } from "../utils/money.js";

const DB_URL = process.env.PAYMENT_TX_TEST_DATABASE_URL?.trim();
const describeMaybe = DB_URL ? describe : describe.skip;
const WEBHOOK_SECRET = "pg-test-webhook-secret";

function signedHeaders(rawBody: string, id: string): Record<string, string> {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
	return { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}

describeMaybe("PostgresPaymentTransactionsStore (real Postgres)", () => {
	const sql = new Bun.SQL(DB_URL as string);
	const store = new PostgresPaymentTransactionsStore(sql as never);

	beforeEach(async () => {
		await sql.unsafe("DELETE FROM payment_transactions");
	});
	afterAll(async () => {
		await sql.close?.();
	});

	test("Fix 1: sumByPlan returns SEPARATE per-currency buckets (USD never added to JPY)", async () => {
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pg_u1", amountCents: 1900, currency: "USD", planId: "pro" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pg_u2", amountCents: 1100, currency: "USD", planId: "pro" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pg_j1", amountCents: 100, currency: "JPY", planId: "pro" });

		const sums = await store.sumByPlan();
		const usd = sums.find((s) => s.currency === "USD" && s.kind === "payment");
		const jpy = sums.find((s) => s.currency === "JPY" && s.kind === "payment");
		expect(usd?.amountCents).toBe("3000");
		expect(jpy?.amountCents).toBe("100");
		expect(typeof usd?.amountCents).toBe("string");
		// Same plan + kind, two currencies → two buckets, never merged.
		expect(sums.filter((s) => s.kind === "payment").length).toBe(2);
	});

	test("Fix 1: sumByPeriod splits a month per currency", async () => {
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pg_pu", amountCents: 5000, currency: "USD", occurredAt: "2026-06-10T00:00:00.000Z" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pg_pe", amountCents: 4000, currency: "EUR", occurredAt: "2026-06-12T00:00:00.000Z" });
		const months = await store.sumByPeriod({ interval: "month" });
		const usd = months.find((m) => m.currency === "USD");
		const eur = months.find((m) => m.currency === "EUR");
		expect(usd?.amountCents).toBe("5000");
		expect(eur?.amountCents).toBe("4000");
		expect(months.filter((m) => m.period === "2026-06-01T00:00:00.000Z").length).toBe(2);
	});

	test("Fix 3: a large multi-row SUM stays precise as a string (bigint, no float drift)", async () => {
		// 1000 rows of 9_007_199_254_740_991 cents — the SUM far exceeds a JS number's
		// safe integer range, so ::text + BigInt is the only way to keep it exact.
		const per = "9007199254740991";
		for (let i = 0; i < 1000; i++) {
			await store.upsertTransaction({ kind: "payment", dodoEventRef: `pg_big_${i}`, amountCents: per, currency: "USD", planId: "pro" });
		}
		const sums = await store.sumByPlan({ currency: "USD" });
		const bucket = sums.find((s) => s.kind === "payment");
		expect(bucket?.amountCents).toBe(sumCents(Array.from({ length: 1000 }, () => per)));
		expect(bucket?.amountCents).toBe("9007199254740991000");
	});

	test("Fix 3: decimal dispute '19.99' nets exactly against a 1999 payment", async () => {
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pg_pay99", amountCents: 1999, currency: "USD", planId: "pro" });
		await store.upsertTransaction({ kind: "dispute", dodoEventRef: "pg_dp99", amountCents: negateCents(majorDecimalToCents("19.99")!), currency: "USD" });
		const sums = await store.sumByPlan({ currency: "USD" });
		const net = sumCents(sums.map((s) => s.amountCents));
		expect(net).toBe("0");
	});

	test("Fix 2: a payment_transactions row persists with workspace_id NULL", async () => {
		const row = await store.upsertTransaction({ kind: "dispute", dodoEventRef: "pg_orphan", amountCents: negateCents(majorDecimalToCents("19.99")!), currency: "USD", workspaceId: null });
		expect(row.workspaceId).toBeNull();
		expect(row.amountCents).toBe(-1999);
		const { transactions } = await store.listTransactions({ kind: "dispute" });
		expect(transactions.find((t) => t.dodoEventRef === "pg_orphan")?.workspaceId).toBeNull();
	});

	test("Fix 4: re-delivery (diff event id, same ref) dedupes via ON CONFLICT (kind, ref)", async () => {
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pg_redeliver", dodoEventId: "pg_evt_a", amountCents: 1900, currency: "USD" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pg_redeliver", dodoEventId: "pg_evt_b", amountCents: 1900, currency: "USD" });
		const { total, transactions } = await store.listTransactions({ kind: "payment" });
		expect(total).toBe(1);
		// COALESCE keeps the first event id; both deliveries converge on one row.
		expect(transactions[0]?.amountCents).toBe(1900);
	});
});

describeMaybe("Dodo webhook record path (real Postgres)", () => {
	const sql = new Bun.SQL(DB_URL as string);
	const store = new PostgresPaymentTransactionsStore(sql as never);

	function createService(): DodoService {
		return new DodoService({
			sqlClient: sql as unknown as DodoSqlClient,
			client: {} as DodoPayments,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: {} },
			},
		});
	}

	// chargeback_disputes.workspace_id has a NOT NULL FK to workspaces, so any test
	// that resolves a workspace (dispute.opened with workspace metadata) must seed the
	// workspaces row first or the dispute-hold insert fails on the FK.
	async function seedWorkspace(workspaceId: string): Promise<void> {
		await sql.unsafe(
			`INSERT INTO workspaces (workspace_id, name) VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
			[workspaceId, `Test ${workspaceId}`],
		);
	}

	beforeEach(async () => {
		await sql.unsafe("DELETE FROM payment_transactions");
		await sql.unsafe("DELETE FROM dodo_webhook_events");
		await sql.unsafe("DELETE FROM chargeback_disputes");
		await sql.unsafe("DELETE FROM workspace_billing_accounts");
		await sql.unsafe("DELETE FROM workspace_billing_customers");
		await sql.unsafe("DELETE FROM workspaces WHERE workspace_id LIKE 'pg_ws%'");
	});
	afterAll(async () => {
		await sql.close?.();
	});

	test("Fix 2: dispute webhook with UNRESOLVED workspace still writes the (negative) row, workspace_id NULL", async () => {
		const service = createService();
		// No metadata.workspace_id and no billing account/customer to resolve from.
		const event = JSON.stringify({
			type: "dispute.opened",
			data: { dispute_id: "pg_dp_orphan", payment_id: "pg_pay_orphan", amount: "19.99", currency: "USD", status: "opened" },
		});
		const result = await service.processWebhook(event, signedHeaders(event, "pg_evt_dp_orphan"));
		expect(result.processed).toBe(true);

		const { transactions } = await store.listTransactions({ kind: "dispute" });
		const dispute = transactions.find((t) => t.dodoEventRef === "pg_dp_orphan");
		expect(dispute).toBeDefined();
		expect(dispute?.workspaceId).toBeNull(); // money record NOT dropped
		expect(dispute?.amountCents).toBe(-1999); // decimal-safe "19.99" → -1999
		// Workspace-keyed side effect (the dispute hold row) is deferred — no workspace.
		const disputeRows = await sql.unsafe("SELECT 1 FROM chargeback_disputes WHERE dodo_dispute_id = $1", ["pg_dp_orphan"]);
		expect(disputeRows.length).toBe(0);
	});

	test("Fix 4: re-delivered dispute webhook (diff webhook-id, same dispute id) → ONE dispute row", async () => {
		const service = createService();
		const body = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "pg_dp_re", payment_id: "pg_pay_re", amount: "19.99", currency: "USD" } });
		await service.processWebhook(body, signedHeaders(body, "pg_evt_re_a"));
		await service.processWebhook(body, signedHeaders(body, "pg_evt_re_b"));
		const { total } = await store.listTransactions({ kind: "dispute" });
		expect(total).toBe(1);
	});

	// --- BUG 1: favorable dispute resolution reverses the deduction (real PG) ---

	// Net all payment_transactions rows for a currency as an exact integer string.
	async function netForCurrency(currency: string): Promise<string> {
		const sums = await store.sumByPlan({ currency });
		return sumCents(sums.map((s) => s.amountCents));
	}

	for (const won of ["dispute.won", "dispute.cancelled", "dispute.expired"] as const) {
		test(`Fix BUG1: payment 1900 + dispute.opened + ${won} → net back to 1900 (per currency)`, async () => {
			const service = createService();
			await seedWorkspace(`pg_wsw_${won}`);
			const pay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: `pg_pw_${won}`, total_amount: 1900, currency: "USD", metadata: { workspace_id: `pg_wsw_${won}`, plan_key: "pro" } } });
			await service.processWebhook(pay, signedHeaders(pay, `pg_evt_pw_${won}`));
			const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: `pg_dpw_${won}`, payment_id: `pg_pw_${won}`, amount: "19.00", currency: "USD", metadata: { workspace_id: `pg_wsw_${won}` } } });
			await service.processWebhook(open, signedHeaders(open, `pg_evt_ow_${won}`));
			expect(await netForCurrency("USD")).toBe("0"); // 1900 - 1900

			const resolve = JSON.stringify({ type: won, data: { dispute_id: `pg_dpw_${won}`, payment_id: `pg_pw_${won}` } });
			await service.processWebhook(resolve, signedHeaders(resolve, `pg_evt_rw_${won}`));

			expect(await netForCurrency("USD")).toBe("1900"); // reversal restores it
			const { transactions } = await store.listTransactions({ kind: "dispute" });
			const reversal = transactions.find((t) => t.dodoEventRef === `pg_dpw_${won}:reversal`);
			expect(reversal?.amountCents).toBe(1900);
			const opened = transactions.find((t) => t.dodoEventRef === `pg_dpw_${won}`);
			expect(opened?.amountCents).toBe(-1900); // untouched
		});
	}

	test("Fix BUG1: LOST dispute keeps the negative (net stays 0, no reversal row)", async () => {
		const service = createService();
		await seedWorkspace("pg_wsl");
		const pay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pg_pl", total_amount: 1900, currency: "USD", metadata: { workspace_id: "pg_wsl", plan_key: "pro" } } });
		await service.processWebhook(pay, signedHeaders(pay, "pg_evt_pl"));
		const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "pg_dpl", payment_id: "pg_pl", amount: "19.00", currency: "USD", metadata: { workspace_id: "pg_wsl" } } });
		await service.processWebhook(open, signedHeaders(open, "pg_evt_ol"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { dispute_id: "pg_dpl", payment_id: "pg_pl" } });
		await service.processWebhook(lost, signedHeaders(lost, "pg_evt_ll"));

		expect(await netForCurrency("USD")).toBe("0");
		const { transactions } = await store.listTransactions({ kind: "dispute" });
		expect(transactions.find((t) => t.dodoEventRef === "pg_dpl:reversal")).toBeUndefined();
	});

	test("Fix BUG1: re-delivered favorable resolution is idempotent (no double-credit)", async () => {
		const service = createService();
		await seedWorkspace("pg_wsi");
		const pay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pg_pi", total_amount: 1900, currency: "USD", metadata: { workspace_id: "pg_wsi", plan_key: "pro" } } });
		await service.processWebhook(pay, signedHeaders(pay, "pg_evt_pi"));
		const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "pg_dpi", payment_id: "pg_pi", amount: "19.00", currency: "USD", metadata: { workspace_id: "pg_wsi" } } });
		await service.processWebhook(open, signedHeaders(open, "pg_evt_oi"));
		const resolve = JSON.stringify({ type: "dispute.won", data: { dispute_id: "pg_dpi", payment_id: "pg_pi" } });
		await service.processWebhook(resolve, signedHeaders(resolve, "pg_evt_ri_a"));
		await service.processWebhook(resolve, signedHeaders(resolve, "pg_evt_ri_b"));

		expect(await netForCurrency("USD")).toBe("1900"); // NOT 3800
		const { transactions } = await store.listTransactions({ kind: "dispute" });
		expect(transactions.filter((t) => t.dodoEventRef === "pg_dpi:reversal")).toHaveLength(1);
	});

	test("Fix BUG1: favorable resolution with UNRESOLVED workspace still writes the reversal row", async () => {
		const service = createService();
		// No workspace metadata, nothing to resolve from → dispute row persists null ws.
		const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "pg_dp_orphan_rev", payment_id: "pg_pay_orphan_rev", amount: "19.00", currency: "USD" } });
		await service.processWebhook(open, signedHeaders(open, "pg_evt_oorph"));
		const won = JSON.stringify({ type: "dispute.won", data: { dispute_id: "pg_dp_orphan_rev", payment_id: "pg_pay_orphan_rev" } });
		await service.processWebhook(won, signedHeaders(won, "pg_evt_rorph"));

		const { transactions } = await store.listTransactions({ kind: "dispute" });
		const reversal = transactions.find((t) => t.dodoEventRef === "pg_dp_orphan_rev:reversal");
		expect(reversal).toBeDefined();
		expect(reversal?.workspaceId).toBeNull();
		expect(reversal?.amountCents).toBe(1900);
		const opened = transactions.find((t) => t.dodoEventRef === "pg_dp_orphan_rev");
		expect(opened?.amountCents).toBe(-1900);
		expect(await netForCurrency("USD")).toBe("0"); // -1900 + 1900 (no payment row here)
	});

	test("Fix BUG2: a >MAX_SAFE_INTEGER cents string ingests EXACTLY through to the bigint column", async () => {
		const service = createService();
		// total_amount above Number.MAX_SAFE_INTEGER (9007199254740991) — Number() would
		// truncate it. The string/BigInt path keeps it exact in the bigint column; the
		// precision-safe SUM reads it back exactly.
		const big = "9007199254740993";
		await seedWorkspace("pg_wsbig");
		const pay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pg_big", total_amount: big, currency: "USD", metadata: { workspace_id: "pg_wsbig" } } });
		await service.processWebhook(pay, signedHeaders(pay, "pg_evt_big"));
		const sums = await store.sumByPlan({ currency: "USD" });
		const bucket = sums.find((s) => s.kind === "payment");
		expect(bucket?.amountCents).toBe(big); // EXACT — no truncation to ...992
	});

	test("Fix BUG3: a JPY dispute '1900' records -1900 minor units (0-decimal), not -190000", async () => {
		const service = createService();
		const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "pg_dp_jpy", payment_id: "pg_pay_jpy", amount: "1900", currency: "JPY" } });
		await service.processWebhook(open, signedHeaders(open, "pg_evt_jpy"));
		const { transactions } = await store.listTransactions({ kind: "dispute" });
		const dispute = transactions.find((t) => t.dodoEventRef === "pg_dp_jpy");
		expect(dispute?.amountCents).toBe(-1900); // not -190000 (the 100x bug)
		expect(dispute?.currency).toBe("JPY");
	});
});

// --- BUG 1: backfill of payment + dispute.opened + dispute.won (real PG) -------
describeMaybe("backfill payment_transactions (real Postgres)", () => {
	const sql = new Bun.SQL(DB_URL as string);
	const store = new PostgresPaymentTransactionsStore(sql as never);

	// Insert a stored webhook delivery with an explicit (monotonic) received_at so the
	// backfill replays opened before its resolution.
	async function seedEvent(id: string, type: string, data: unknown, receivedAt: string): Promise<void> {
		await sql.unsafe(
			`INSERT INTO dodo_webhook_events (id, type, payload, received_at) VALUES ($1, $2, $3::jsonb, $4)
			 ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, payload = EXCLUDED.payload, received_at = EXCLUDED.received_at`,
			[id, type, JSON.stringify({ type, data }), receivedAt],
		);
	}

	async function netForCurrency(currency: string): Promise<string> {
		const sums = await store.sumByPlan({ currency });
		return sumCents(sums.map((s) => s.amountCents));
	}

	beforeEach(async () => {
		await sql.unsafe("DELETE FROM payment_transactions");
		await sql.unsafe("DELETE FROM dodo_webhook_events");
	});
	afterAll(async () => {
		await sql.close?.();
	});

	test("Fix BUG1: backfill of payment + dispute.opened + dispute.won nets +1900 (idempotent)", async () => {
		await seedEvent("bf_pay", "payment.succeeded", { payment_id: "bf_p", total_amount: 1900, currency: "USD", metadata: { plan_key: "pro" } }, "2026-01-01T00:00:00.000Z");
		await seedEvent("bf_open", "dispute.opened", { dispute_id: "bf_dp", payment_id: "bf_p", amount: "19.00", currency: "USD" }, "2026-01-02T00:00:00.000Z");
		await seedEvent("bf_won", "dispute.won", { dispute_id: "bf_dp", payment_id: "bf_p" }, "2026-01-03T00:00:00.000Z");

		const first = await backfillPaymentTransactions(sql as unknown as BackfillSqlClient);
		expect(first.upserted).toBe(3); // payment, dispute.opened, reversal
		expect(await netForCurrency("USD")).toBe("1900"); // not 0 — the reversal restores it
		const { transactions } = await store.listTransactions({ kind: "dispute" });
		expect(transactions.find((t) => t.dodoEventRef === "bf_dp:reversal")?.amountCents).toBe(1900);
		expect(transactions.find((t) => t.dodoEventRef === "bf_dp")?.amountCents).toBe(-1900);

		// Idempotent re-run: same rows, still +1900 (no double-credit).
		await backfillPaymentTransactions(sql as unknown as BackfillSqlClient);
		expect(await netForCurrency("USD")).toBe("1900");
		const reversals = (await store.listTransactions({ kind: "dispute" })).transactions.filter((t) => t.dodoEventRef === "bf_dp:reversal");
		expect(reversals).toHaveLength(1);
	});

	test("Fix BUG1: backfill of a LOST dispute keeps the negative (net 0, no reversal)", async () => {
		await seedEvent("bfl_pay", "payment.succeeded", { payment_id: "bfl_p", total_amount: 1900, currency: "USD" }, "2026-02-01T00:00:00.000Z");
		await seedEvent("bfl_open", "dispute.opened", { dispute_id: "bfl_dp", payment_id: "bfl_p", amount: "19.00", currency: "USD" }, "2026-02-02T00:00:00.000Z");
		await seedEvent("bfl_lost", "dispute.lost", { dispute_id: "bfl_dp", payment_id: "bfl_p" }, "2026-02-03T00:00:00.000Z");

		await backfillPaymentTransactions(sql as unknown as BackfillSqlClient);
		expect(await netForCurrency("USD")).toBe("0"); // deduction retained
		const { transactions } = await store.listTransactions({ kind: "dispute" });
		expect(transactions.find((t) => t.dodoEventRef === "bfl_dp:reversal")).toBeUndefined();
	});

	test("Fix BUG3: backfill JPY dispute '1900' converts to -1900 (0-decimal), per-currency netting independent", async () => {
		// JPY: pay 1900, dispute 1900, WON → JPY net 1900 (and 1900 NOT 190000).
		await seedEvent("bfj_pay", "payment.succeeded", { payment_id: "bfj_p", total_amount: 1900, currency: "JPY" }, "2026-03-01T00:00:00.000Z");
		await seedEvent("bfj_open", "dispute.opened", { dispute_id: "bfj_dp", payment_id: "bfj_p", amount: "1900", currency: "JPY" }, "2026-03-02T00:00:00.000Z");
		await seedEvent("bfj_won", "dispute.won", { dispute_id: "bfj_dp", payment_id: "bfj_p" }, "2026-03-03T00:00:00.000Z");
		// USD lost in the same backfill — must not affect the JPY bucket.
		await seedEvent("bfu_pay", "payment.succeeded", { payment_id: "bfu_p", total_amount: 1000, currency: "USD" }, "2026-03-04T00:00:00.000Z");
		await seedEvent("bfu_open", "dispute.opened", { dispute_id: "bfu_dp", payment_id: "bfu_p", amount: "10.00", currency: "USD" }, "2026-03-05T00:00:00.000Z");
		await seedEvent("bfu_lost", "dispute.lost", { dispute_id: "bfu_dp", payment_id: "bfu_p" }, "2026-03-06T00:00:00.000Z");

		await backfillPaymentTransactions(sql as unknown as BackfillSqlClient);
		const { transactions } = await store.listTransactions({ kind: "dispute" });
		expect(transactions.find((t) => t.dodoEventRef === "bfj_dp")?.amountCents).toBe(-1900); // not -190000
		expect(await netForCurrency("JPY")).toBe("1900");
		expect(await netForCurrency("USD")).toBe("0");
	});
});
