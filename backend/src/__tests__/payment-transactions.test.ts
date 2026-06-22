import { createHmac } from "crypto";
import { describe, expect, test } from "bun:test";
import type DodoPayments from "dodopayments";
import { DodoService, type DodoSqlClient } from "../services/dodo.service.js";
import { FilePaymentTransactionsStore } from "../services/payment-transactions-store.js";
import {
	backfillPaymentTransactions,
	extractTransactionsFromEvent,
	type BackfillSqlClient,
} from "../scripts/backfill-payment-transactions.js";
import { absCents, majorDecimalToCents, minorUnitsFor, negateCents, normalizeCents, readMinorUnitCents, sumCents } from "../utils/money.js";
import { serverConfig } from "../config.js";

const WEBHOOK_SECRET = "test-webhook-secret";

// --- Fake SQL client modelling the revenue-relevant tables -------------------
//
// Captures payment_transactions upserts so the record path / backfill can be
// asserted, and stubs the billing-account/workspace/chargeback statements the
// webhook handler touches so the full handleWebhookEvent path runs end-to-end.
interface TxRow {
	id: string;
	workspace_id: string | null;
	dodo_payment_id: string | null;
	dodo_invoice_id: string | null;
	dodo_event_ref: string | null;
	dodo_event_id: string | null;
	kind: string;
	amount_cents: number;
	tax_cents: number | null;
	currency: string | null;
	status: string | null;
	plan_id: string | null;
	billing_cycle: string | null;
	occurred_at: string;
	raw: unknown;
}

class FakeRevenueSqlClient implements DodoSqlClient, BackfillSqlClient {
	readonly webhookEvents = new Map<string, { id: string; type: string; payload: unknown }>();
	readonly billingAccounts = new Map<string, Record<string, unknown>>();
	readonly billingCustomers = new Map<string, Record<string, unknown>>();
	readonly workspaces = new Map<string, { workspace_id: string; chargeback_pending: boolean }>();
	readonly disputes = new Map<string, Record<string, unknown>>();
	// payment_transactions keyed by the idempotency key the unique indexes enforce.
	readonly txByKey = new Map<string, TxRow>();
	// The EXACT amount_cents string bound on each payment_transactions insert (what a
	// real bigint column receives) — used to prove no Number() truncation at ingest.
	readonly boundAmountCents: string[] = [];

	async begin<T>(fn: (transaction: DodoSqlClient) => Promise<T>): Promise<T> {
		return fn(this);
	}

	listTransactions(): TxRow[] {
		return [...this.txByKey.values()];
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const normalized = query.replace(/\s+/g, " ").trim();

		if (normalized.startsWith("INSERT INTO dodo_webhook_events")) {
			const id = String(params[0]);
			if (this.webhookEvents.has(id)) return [] as T[];
			this.webhookEvents.set(id, { id, type: String(params[1]), payload: JSON.parse(String(params[2])) });
			return [{ id }] as T[];
		}
		if (normalized.startsWith("UPDATE dodo_webhook_events")) return [] as T[];

		if (normalized.startsWith("SELECT id, type, payload FROM dodo_webhook_events")) {
			return [...this.webhookEvents.values()].map((row) => ({ id: row.id, type: row.type, payload: row.payload })) as T[];
		}

		if (normalized.startsWith("INSERT INTO payment_transactions")) {
			// params: id, workspace_id, payment_id, invoice_id, event_ref, event_id,
			// kind, amount_cents, tax_cents, currency, status, plan_id, billing_cycle, occurred_at, raw
			const kind = String(params[6]);
			const eventRef = params[4] === null ? null : String(params[4]);
			const eventId = params[5] === null ? null : String(params[5]);
			const key = eventRef ? `ref:${kind}:${eventRef}` : `evt:${eventId}`;
			// Capture the exact bound minor-unit string (Postgres bigint receives this).
			this.boundAmountCents.push(String(params[7]));
			const existing = this.txByKey.get(key);
			const row: TxRow = {
				id: existing?.id ?? String(params[0]),
				workspace_id: existing?.workspace_id ?? (params[1] === null ? null : String(params[1])),
				dodo_payment_id: existing?.dodo_payment_id ?? (params[2] === null ? null : String(params[2])),
				dodo_invoice_id: existing?.dodo_invoice_id ?? (params[3] === null ? null : String(params[3])),
				dodo_event_ref: eventRef ?? existing?.dodo_event_ref ?? null,
				dodo_event_id: eventId ?? existing?.dodo_event_id ?? null,
				kind,
				amount_cents: Number(params[7]),
				tax_cents: params[8] === null ? (existing?.tax_cents ?? null) : Number(params[8]),
				currency: (params[9] === null ? existing?.currency : String(params[9])) ?? null,
				status: (params[10] === null ? existing?.status : String(params[10])) ?? null,
				plan_id: (params[11] === null ? existing?.plan_id : String(params[11])) ?? null,
				billing_cycle: (params[12] === null ? existing?.billing_cycle : String(params[12])) ?? null,
				occurred_at: String(params[13]),
				// raw is bound as a JS OBJECT to $15::jsonb (Bun.SQL serializes it into a jsonb
				// OBJECT). The mock mirrors that: accept the object as-is (a real jsonb column
				// would store/return it as an object), only parsing if a legacy string slips in.
				raw: typeof params[14] === "string" ? JSON.parse(params[14]) : (params[14] ?? {}),
			};
			this.txByKey.set(key, row);
			return [] as T[];
		}

		if (normalized.startsWith("INSERT INTO workspace_billing_customers")) {
			this.billingCustomers.set(String(params[0]), { workspace_id: params[0], dodo_subscription_id: params[2], dodo_customer_id: params[1] });
			return [] as T[];
		}
		if (normalized.startsWith("INSERT INTO workspace_billing_accounts")) {
			const existing = this.billingAccounts.get(String(params[0]));
			const hasPeriodColumns = params.length >= 7;
			const metadataParam = hasPeriodColumns ? params[6] : params[4];
			this.billingAccounts.set(String(params[0]), {
				...existing,
				workspace_id: params[0],
				status: params[2],
				metadata: { ...(existing?.metadata as object | undefined), ...JSON.parse(String(metadataParam)) },
			});
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspace_billing_accounts")) {
			const row = this.billingAccounts.get(String(params[0]));
			if (row) {
				if (normalized.includes("SET status = 'cancelled'")) row.status = "cancelled";
				const metaIndex = normalized.includes("SET status = $3") ? 1 : normalized.includes("metadata = metadata || $2") ? 1 : 2;
				const metaParam = params[metaIndex];
				if (typeof metaParam === "string") row.metadata = { ...(row.metadata as object), ...JSON.parse(metaParam) };
			}
			return [] as T[];
		}
		if (normalized.startsWith("SELECT status, current_period_end, metadata FROM workspace_billing_accounts")) {
			const row = this.billingAccounts.get(String(params[0]));
			return (row ? [{ status: row.status ?? null, current_period_end: null, metadata: row.metadata ?? {} }] : []) as T[];
		}
		if (normalized.startsWith("SELECT chargeback_pending FROM workspaces")) {
			const w = this.workspaces.get(String(params[0]));
			return (w ? [{ chargeback_pending: w.chargeback_pending }] : []) as T[];
		}
		if (normalized.startsWith("SELECT metadata->>'chargeback_pending'")) {
			const row = this.billingAccounts.get(String(params[0]));
			const meta = row?.metadata as Record<string, unknown> | undefined;
			return [{ chargeback_pending: meta?.chargeback_pending === true ? "true" : null }] as T[];
		}
		if (normalized.startsWith("UPDATE workspaces SET chargeback_pending = false")) {
			const w = this.workspaces.get(String(params[0]));
			if (w) w.chargeback_pending = false;
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspaces SET chargeback_pending")) {
			this.workspaces.set(String(params[0]), { workspace_id: String(params[0]), chargeback_pending: true });
			return [] as T[];
		}
		if (normalized.startsWith("INSERT INTO chargeback_disputes")) {
			this.disputes.set(String(params[2]), {
				dodo_dispute_id: params[2],
				reason: params[3],
				status: params[4],
				amount_cents: params[5] ?? null,
				currency: params[6] ?? null,
			});
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE chargeback_disputes")) return [] as T[];
		if (normalized.startsWith("SELECT workspace_id FROM workspace_billing_customers")) {
			const subscriptionId = params[0];
			for (const row of this.billingCustomers.values()) {
				if (subscriptionId && row.dodo_subscription_id === subscriptionId) return [{ workspace_id: row.workspace_id }] as T[];
			}
			return [] as T[];
		}
		if (normalized.startsWith("SELECT workspace_id FROM workspace_billing_accounts WHERE metadata->>'dodo_payment_id'")) {
			const paymentId = params[0];
			for (const row of this.billingAccounts.values()) {
				if ((row.metadata as Record<string, unknown>)?.dodo_payment_id === paymentId) return [{ workspace_id: row.workspace_id }] as T[];
			}
			return [] as T[];
		}
		if (normalized.startsWith("SELECT workspace_id FROM chargeback_disputes")) return [] as T[];
		if (normalized.startsWith("SELECT amount_cents, currency FROM payment_transactions WHERE kind = 'dispute' AND dodo_event_ref")) {
			// Reversal-amount lookup: find the dispute.opened row by its ref.
			const disputeId = String(params[0]);
			const row = this.txByKey.get(`ref:dispute:${disputeId}`);
			return (row ? [{ amount_cents: row.amount_cents, currency: row.currency }] : []) as T[];
		}
		return [] as T[];
	}
}

function createService(sql: FakeRevenueSqlClient, now?: () => Date): DodoService {
	return new DodoService({
		sqlClient: sql,
		client: {} as DodoPayments,
		now,
		config: {
			...serverConfig,
			billingProvider: "dodo",
			dodo: { ...serverConfig.dodo, apiKey: "test", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: {} },
		},
	});
}

function signedHeaders(rawBody: string, id: string, at: Date = new Date()): Record<string, string> {
	const timestamp = String(Math.floor(at.getTime() / 1000));
	const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
	return { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}

describe("payment_transactions record path", () => {
	test("payment.succeeded records a positive revenue row with amount/currency/plan/date", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_rev_1",
				total_amount: 1900,
				tax: 0,
				currency: "USD",
				status: "succeeded",
				created_at: "2026-06-01T10:00:00.000Z",
				metadata: { workspace_id: "ws_rev", plan_key: "pro", billing_cycle: "monthly" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_rev_1"));

		const rows = sql.listTransactions();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual(expect.objectContaining({
			kind: "payment",
			workspace_id: "ws_rev",
			dodo_payment_id: "pay_rev_1",
			amount_cents: 1900,
			currency: "USD",
			plan_id: "pro",
			billing_cycle: "monthly",
			occurred_at: "2026-06-01T10:00:00.000Z",
		}));
	});

	test("re-delivering the same payment event does not double-count revenue", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_dup", total_amount: 800, currency: "USD", metadata: { workspace_id: "ws_dup", plan_key: "starter" } },
		});
		const headers = signedHeaders(event, "evt_dup");

		const first = await service.processWebhook(event, headers);
		const second = await service.processWebhook(event, headers);

		expect(first.processed).toBe(true);
		expect(second.processed).toBe(false); // dodo_webhook_events idempotency
		expect(sql.listTransactions()).toHaveLength(1);
		expect(sql.listTransactions()[0].amount_cents).toBe(800);
	});

	test("a different delivery for the same payment id upserts the same row (no dupe)", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const make = (id: string) => {
			const event = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_same", total_amount: 1900, currency: "USD", metadata: { workspace_id: "ws_same", plan_key: "pro" } } });
			return { event, headers: signedHeaders(event, id) };
		};
		const a = make("evt_a");
		const b = make("evt_b");
		await service.processWebhook(a.event, a.headers);
		await service.processWebhook(b.event, b.headers);

		// Two distinct webhook deliveries, but one payment id → one revenue row.
		expect(sql.listTransactions()).toHaveLength(1);
	});

	test("refund event records a negative revenue row", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const event = JSON.stringify({
			type: "payment.refunded",
			data: { refund_id: "ref_1", payment_id: "pay_ref", amount: 1900, currency: "USD", status: "succeeded", created_at: "2026-06-05T00:00:00.000Z", metadata: { workspace_id: "ws_ref" } },
		});

		await service.processWebhook(event, signedHeaders(event, "evt_refund"));

		const rows = sql.listTransactions();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual(expect.objectContaining({ kind: "refund", amount_cents: -1900, currency: "USD", dodo_event_ref: "ref_1" }));
	});

	test("dispute event records a negative revenue row and captures the disputed amount", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const event = JSON.stringify({
			type: "dispute.opened",
			data: { dispute_id: "dp_rev", payment_id: "pay_disp", amount: "19.00", currency: "USD", status: "opened", metadata: { workspace_id: "ws_disp" } },
		});

		await service.processWebhook(event, signedHeaders(event, "evt_dispute"));

		const txRows = sql.listTransactions();
		expect(txRows).toHaveLength(1);
		// Dodo dispute amount is a major-unit string "19.00" → 1900 cents, stored negative.
		expect(txRows[0]).toEqual(expect.objectContaining({ kind: "dispute", amount_cents: -1900, currency: "USD" }));
		// chargeback_disputes.amount_cents is bound as a decimal-safe integer STRING.
		expect(sql.disputes.get("dp_rev")).toEqual(expect.objectContaining({ amount_cents: "1900", currency: "USD" }));
	});

	// --- BUG 3: live dispute path is currency-aware (JPY is 0-decimal) -----------
	test("live: a JPY dispute '1900' records -1900 (0-decimal), not -190000", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const event = JSON.stringify({
			type: "dispute.opened",
			data: { dispute_id: "dp_jpy_live", payment_id: "pay_jpy_live", amount: "1900", currency: "JPY", status: "opened", metadata: { workspace_id: "ws_jpy" } },
		});
		await service.processWebhook(event, signedHeaders(event, "evt_dispute_jpy"));
		const row = sql.listTransactions().find((t) => t.dodo_event_ref === "dp_jpy_live");
		// JPY "1900" is ALREADY minor units → -1900 (the 100x bug would store -190000).
		expect(row?.amount_cents).toBe(-1900);
		expect(row?.currency).toBe("JPY");
		expect(sql.disputes.get("dp_jpy_live")).toEqual(expect.objectContaining({ amount_cents: "1900", currency: "JPY" }));
	});

	// --- BUG 1: favorable dispute resolution reverses the deduction ----------
	//
	// Helper that nets every payment_transactions row by currency so we can assert
	// the post-resolution net revenue exactly.
	function netByCurrency(sql: FakeRevenueSqlClient): Map<string, string> {
		const totals = new Map<string, string>();
		for (const tx of sql.listTransactions()) {
			const cur = tx.currency ?? "";
			totals.set(cur, sumCents([totals.get(cur) ?? "0", tx.amount_cents]));
		}
		return totals;
	}

	for (const won of ["dispute.won", "dispute.cancelled", "dispute.expired"] as const) {
		test(`payment + dispute.opened + ${won} → net back to the original payment (per currency)`, async () => {
			const sql = new FakeRevenueSqlClient();
			const service = createService(sql);
			const pay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_w", total_amount: 1900, currency: "USD", metadata: { workspace_id: "ws_w", plan_key: "pro" } } });
			await service.processWebhook(pay, signedHeaders(pay, "evt_pay_w"));
			const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "dp_w", payment_id: "pay_w", amount: "19.00", currency: "USD", metadata: { workspace_id: "ws_w" } } });
			await service.processWebhook(open, signedHeaders(open, "evt_open_w"));
			// After opening, net = 1900 - 1900 = 0.
			expect(netByCurrency(sql).get("USD")).toBe("0");

			const resolve = JSON.stringify({ type: won, data: { dispute_id: "dp_w", payment_id: "pay_w" } });
			await service.processWebhook(resolve, signedHeaders(resolve, `evt_${won}`));

			// Favorable resolution writes +1900 reversal → net back to the payment.
			expect(netByCurrency(sql).get("USD")).toBe("1900");
			// Reversal is a DISTINCT row from the opened deduction (different ref).
			const reversal = sql.listTransactions().find((t) => t.dodo_event_ref === "dp_w:reversal");
			expect(reversal).toBeDefined();
			expect(reversal?.amount_cents).toBe(1900);
			expect(reversal?.kind).toBe("dispute");
			// The original negative dispute row is untouched.
			const opened = sql.listTransactions().find((t) => t.dodo_event_ref === "dp_w");
			expect(opened?.amount_cents).toBe(-1900);
		});
	}

	test("LOST dispute does NOT reverse: the negative deduction is retained (net stays 0)", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const pay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_l", total_amount: 1900, currency: "USD", metadata: { workspace_id: "ws_l", plan_key: "pro" } } });
		await service.processWebhook(pay, signedHeaders(pay, "evt_pay_l"));
		const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "dp_l", payment_id: "pay_l", amount: "19.00", currency: "USD", metadata: { workspace_id: "ws_l" } } });
		await service.processWebhook(open, signedHeaders(open, "evt_open_l"));

		const lost = JSON.stringify({ type: "dispute.lost", data: { dispute_id: "dp_l", payment_id: "pay_l" } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_lost_l"));

		// Lost dispute is a real loss — no reversal row, net stays 0.
		expect(netByCurrency(sql).get("USD")).toBe("0");
		expect(sql.listTransactions().find((t) => t.dodo_event_ref === "dp_l:reversal")).toBeUndefined();
	});

	test("dispute.accepted (merchant accepted the loss) does NOT reverse", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const pay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_a", total_amount: 1900, currency: "USD", metadata: { workspace_id: "ws_a", plan_key: "pro" } } });
		await service.processWebhook(pay, signedHeaders(pay, "evt_pay_a"));
		const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "dp_a", payment_id: "pay_a", amount: "19.00", currency: "USD", metadata: { workspace_id: "ws_a" } } });
		await service.processWebhook(open, signedHeaders(open, "evt_open_a"));
		const accepted = JSON.stringify({ type: "dispute.accepted", data: { dispute_id: "dp_a", payment_id: "pay_a" } });
		await service.processWebhook(accepted, signedHeaders(accepted, "evt_accepted_a"));
		expect(netByCurrency(sql).get("USD")).toBe("0");
		expect(sql.listTransactions().find((t) => t.dodo_event_ref === "dp_a:reversal")).toBeUndefined();
	});

	test("re-delivered favorable resolution does NOT double-credit (idempotent on the reversal ref)", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const pay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_i", total_amount: 1900, currency: "USD", metadata: { workspace_id: "ws_i", plan_key: "pro" } } });
		await service.processWebhook(pay, signedHeaders(pay, "evt_pay_i"));
		const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "dp_i", payment_id: "pay_i", amount: "19.00", currency: "USD", metadata: { workspace_id: "ws_i" } } });
		await service.processWebhook(open, signedHeaders(open, "evt_open_i"));

		// Same dispute resolution delivered twice with DIFFERENT webhook-ids.
		const resolve = JSON.stringify({ type: "dispute.won", data: { dispute_id: "dp_i", payment_id: "pay_i" } });
		await service.processWebhook(resolve, signedHeaders(resolve, "evt_won_i_a"));
		await service.processWebhook(resolve, signedHeaders(resolve, "evt_won_i_b"));

		// Net is +1900 (NOT +3800): only one reversal row exists.
		expect(netByCurrency(sql).get("USD")).toBe("1900");
		expect(sql.listTransactions().filter((t) => t.dodo_event_ref === "dp_i:reversal")).toHaveLength(1);
	});

	test("favorable resolution with UNRESOLVED workspace still writes the reversal row", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		// dispute.opened with NO workspace metadata and nothing to resolve from → the
		// negative dispute row persists with workspace_id NULL (BUG 1c precondition).
		const open = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "dp_orphan_rev", payment_id: "pay_orphan_rev", amount: "19.00", currency: "USD" } });
		await service.processWebhook(open, signedHeaders(open, "evt_open_orphan"));
		const opened = sql.listTransactions().find((t) => t.dodo_event_ref === "dp_orphan_rev");
		expect(opened?.workspace_id).toBeNull();
		expect(opened?.amount_cents).toBe(-1900);

		// Resolution also lacks a workspace — but the reversal row must still be written.
		const won = JSON.stringify({ type: "dispute.won", data: { dispute_id: "dp_orphan_rev", payment_id: "pay_orphan_rev" } });
		await service.processWebhook(won, signedHeaders(won, "evt_won_orphan"));
		const reversal = sql.listTransactions().find((t) => t.dodo_event_ref === "dp_orphan_rev:reversal");
		expect(reversal).toBeDefined();
		expect(reversal?.amount_cents).toBe(1900);
		expect(reversal?.workspace_id).toBeNull();
		expect(netByCurrency(sql).get("USD")).toBe("0"); // -1900 + 1900, no payment row here
	});

	test("payment recorded even while a chargeback is open (money still moved)", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		// Open a chargeback on the workspace first.
		const charge = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "dp_open", payment_id: "pay_x", amount: "10.00", currency: "USD", metadata: { workspace_id: "ws_cb" } } });
		await service.processWebhook(charge, signedHeaders(charge, "evt_cb_open"));
		expect(sql.workspaces.get("ws_cb")?.chargeback_pending).toBe(true);

		const late = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_late_rev", total_amount: 1000, currency: "USD", metadata: { workspace_id: "ws_cb", plan_key: "starter" } } });
		await service.processWebhook(late, signedHeaders(late, "evt_late_rev"));

		const payment = sql.listTransactions().find((tx) => tx.kind === "payment" && tx.dodo_payment_id === "pay_late_rev");
		expect(payment).toBeDefined();
		expect(payment?.amount_cents).toBe(1000);
		// Revenue was recorded, but the chargeback hold is still in place — the late
		// payment must NOT have re-activated paid access during the open dispute.
		expect(sql.workspaces.get("ws_cb")?.chargeback_pending).toBe(true);
	});
});

describe("backfill-payment-transactions", () => {
	test("extractTransactionsFromEvent maps a payment payload to a revenue row", () => {
		const rows = extractTransactionsFromEvent("evt_bf", "payment.succeeded", {
			type: "payment.succeeded",
			data: { payment_id: "pay_bf", total_amount: 1900, tax: 100, currency: "usd", created_at: "2026-05-01T00:00:00.000Z", metadata: { workspace_id: "ws_bf", plan_key: "pro" } },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual(expect.objectContaining({
			kind: "payment",
			// Minor-unit amounts are now carried as EXACT integer-cents STRINGS so a
			// value above Number.MAX_SAFE_INTEGER is never silently truncated (BUG 2).
			amountCents: "1900",
			taxCents: "100",
			currency: "usd",
			planId: "pro",
			workspaceId: "ws_bf",
			dodoEventRef: "pay_bf",
		}));
	});

	test("extractTransactionsFromEvent ignores non-revenue events", () => {
		expect(extractTransactionsFromEvent("evt_sub", "subscription.created", { data: {} })).toHaveLength(0);
	});

	test("backfill replays stored webhook events into payment_transactions (idempotent re-run)", async () => {
		const sql = new FakeRevenueSqlClient();
		// Seed historical webhook deliveries directly.
		sql.webhookEvents.set("evt_h1", { id: "evt_h1", type: "payment.succeeded", payload: { data: { payment_id: "pay_h1", total_amount: 1900, currency: "USD", metadata: { workspace_id: "ws_h", plan_key: "pro" } } } });
		sql.webhookEvents.set("evt_h2", { id: "evt_h2", type: "payment.refunded", payload: { data: { refund_id: "ref_h1", payment_id: "pay_h1", amount: 500, currency: "USD", metadata: { workspace_id: "ws_h" } } } });
		sql.webhookEvents.set("evt_h3", { id: "evt_h3", type: "subscription.created", payload: { data: {} } });

		const first = await backfillPaymentTransactions(sql);
		expect(first).toEqual({ scanned: 3, upserted: 2, skipped: 1 });
		expect(sql.listTransactions()).toHaveLength(2);

		// Re-run is idempotent: same rows, no duplicates.
		const second = await backfillPaymentTransactions(sql);
		expect(second.upserted).toBe(2);
		expect(sql.listTransactions()).toHaveLength(2);

		// Net revenue = 1900 payment - 500 refund.
		const net = sql.listTransactions().reduce((sum, tx) => sum + tx.amount_cents, 0);
		expect(net).toBe(1400);
	});

	test("dry-run counts rows without writing", async () => {
		const sql = new FakeRevenueSqlClient();
		sql.webhookEvents.set("evt_d1", { id: "evt_d1", type: "payment.succeeded", payload: { data: { payment_id: "pay_d1", total_amount: 800, currency: "USD" } } });
		const result = await backfillPaymentTransactions(sql, { dryRun: true });
		expect(result.upserted).toBe(1);
		expect(sql.listTransactions()).toHaveLength(0);
	});

	// --- BUG 1: backfill replays favorable dispute resolutions into a reversal ---
	//
	// Replaying history (payment +1900, dispute.opened -1900, dispute.won) must net
	// back to +1900 — the SAME positive reversal the live resolveChargeback path
	// writes — instead of leaving the deduction in place (net 0).
	function netCents(sql: FakeRevenueSqlClient): number {
		return sql.listTransactions().reduce((sum, tx) => sum + tx.amount_cents, 0);
	}

	for (const won of ["dispute.won", "dispute.cancelled", "dispute.expired"] as const) {
		test(`backfill: payment + dispute.opened + ${won} nets back to +1900 (idempotent re-run)`, async () => {
			const sql = new FakeRevenueSqlClient();
			// Replay order matters: received_at ASC → opened seen before resolution.
			sql.webhookEvents.set("evt_p", { id: "evt_p", type: "payment.succeeded", payload: { data: { payment_id: "pay_b", total_amount: 1900, currency: "USD", metadata: { workspace_id: "ws_b", plan_key: "pro" } } } });
			sql.webhookEvents.set("evt_o", { id: "evt_o", type: "dispute.opened", payload: { data: { dispute_id: "dp_b", payment_id: "pay_b", amount: "19.00", currency: "USD", metadata: { workspace_id: "ws_b" } } } });
			sql.webhookEvents.set("evt_r", { id: "evt_r", type: won, payload: { data: { dispute_id: "dp_b", payment_id: "pay_b" } } });

			const first = await backfillPaymentTransactions(sql);
			// 3 rows: +1900 payment, -1900 dispute.opened, +1900 reversal.
			expect(first.upserted).toBe(3);
			expect(netCents(sql)).toBe(1900);
			const reversal = sql.listTransactions().find((t) => t.dodo_event_ref === "dp_b:reversal");
			expect(reversal?.amount_cents).toBe(1900);
			expect(reversal?.kind).toBe("dispute");
			expect(sql.listTransactions().find((t) => t.dodo_event_ref === "dp_b")?.amount_cents).toBe(-1900);

			// Idempotent re-run: same rows, still nets +1900 (no double-credit).
			await backfillPaymentTransactions(sql);
			expect(sql.listTransactions()).toHaveLength(3);
			expect(netCents(sql)).toBe(1900);
			expect(sql.listTransactions().filter((t) => t.dodo_event_ref === "dp_b:reversal")).toHaveLength(1);
		});
	}

	test("backfill: a LOST dispute writes NO reversal — the negative stays (net 0)", async () => {
		const sql = new FakeRevenueSqlClient();
		sql.webhookEvents.set("evt_pl", { id: "evt_pl", type: "payment.succeeded", payload: { data: { payment_id: "pay_bl", total_amount: 1900, currency: "USD", metadata: { workspace_id: "ws_bl" } } } });
		sql.webhookEvents.set("evt_ol", { id: "evt_ol", type: "dispute.opened", payload: { data: { dispute_id: "dp_bl", payment_id: "pay_bl", amount: "19.00", currency: "USD" } } });
		sql.webhookEvents.set("evt_rl", { id: "evt_rl", type: "dispute.lost", payload: { data: { dispute_id: "dp_bl", payment_id: "pay_bl" } } });

		await backfillPaymentTransactions(sql);
		// Only payment + dispute.opened rows; lost resolution adds nothing.
		expect(sql.listTransactions()).toHaveLength(2);
		expect(sql.listTransactions().find((t) => t.dodo_event_ref === "dp_bl:reversal")).toBeUndefined();
		expect(netCents(sql)).toBe(0); // +1900 - 1900, deduction retained
	});

	test("backfill: generic payment.chargeback.resolved is fail-closed (no reversal unless explicitly favorable)", async () => {
		const sql = new FakeRevenueSqlClient();
		sql.webhookEvents.set("evt_pf", { id: "evt_pf", type: "payment.succeeded", payload: { data: { payment_id: "pay_bf", total_amount: 1900, currency: "USD" } } });
		sql.webhookEvents.set("evt_of", { id: "evt_of", type: "dispute.opened", payload: { data: { dispute_id: "dp_bf", payment_id: "pay_bf", amount: "19.00", currency: "USD" } } });
		// Resolved with an ambiguous/empty status → treated as a loss (no reversal).
		sql.webhookEvents.set("evt_rf", { id: "evt_rf", type: "payment.chargeback.resolved", payload: { data: { dispute_id: "dp_bf", payment_id: "pay_bf" } } });
		await backfillPaymentTransactions(sql);
		expect(sql.listTransactions().find((t) => t.dodo_event_ref === "dp_bf:reversal")).toBeUndefined();
		expect(netCents(sql)).toBe(0);

		// But payment.chargeback.resolved with an explicit favorable status DOES reverse.
		const sql2 = new FakeRevenueSqlClient();
		sql2.webhookEvents.set("evt_pf2", { id: "evt_pf2", type: "payment.succeeded", payload: { data: { payment_id: "pay_bf2", total_amount: 1900, currency: "USD" } } });
		sql2.webhookEvents.set("evt_of2", { id: "evt_of2", type: "dispute.opened", payload: { data: { dispute_id: "dp_bf2", payment_id: "pay_bf2", amount: "19.00", currency: "USD" } } });
		sql2.webhookEvents.set("evt_rf2", { id: "evt_rf2", type: "payment.chargeback.resolved", payload: { data: { dispute_id: "dp_bf2", payment_id: "pay_bf2", status: "won" } } });
		await backfillPaymentTransactions(sql2);
		expect(sql2.listTransactions().find((t) => t.dodo_event_ref === "dp_bf2:reversal")?.amount_cents).toBe(1900);
		expect(netCents(sql2)).toBe(1900);
	});

	// --- BUG 3: backfill dispute conversion is CURRENCY-AWARE (JPY not 100x) -----
	test("backfill: a JPY dispute '1900' converts to 1900 minor units (0-decimal), not 190000", () => {
		const opened = extractTransactionsFromEvent("evt_jpy", "dispute.opened", {
			data: { dispute_id: "dp_jpy", payment_id: "pay_jpy", amount: "1900", currency: "JPY" },
		});
		expect(opened).toHaveLength(1);
		// Negative deduction of 1900 (NOT -190000).
		expect(opened[0].amountCents).toBe("-1900");
		expect(opened[0].currency).toBe("JPY");
	});

	test("backfill: a KWD dispute '1.234' converts to 1234 minor units (3-decimal)", () => {
		const opened = extractTransactionsFromEvent("evt_kwd", "dispute.opened", {
			data: { dispute_id: "dp_kwd", payment_id: "pay_kwd", amount: "1.234", currency: "KWD" },
		});
		expect(opened[0].amountCents).toBe("-1234");
	});

	test("backfill: per-currency netting (JPY won + USD lost) is independent", async () => {
		const sql = new FakeRevenueSqlClient();
		// JPY: pay 1900, dispute 1900, WON → JPY net 1900.
		sql.webhookEvents.set("e_jp", { id: "e_jp", type: "payment.succeeded", payload: { data: { payment_id: "pj", total_amount: 1900, currency: "JPY" } } });
		sql.webhookEvents.set("e_jo", { id: "e_jo", type: "dispute.opened", payload: { data: { dispute_id: "dj", payment_id: "pj", amount: "1900", currency: "JPY" } } });
		sql.webhookEvents.set("e_jw", { id: "e_jw", type: "dispute.won", payload: { data: { dispute_id: "dj", payment_id: "pj" } } });
		// USD: pay 1000, dispute 1000, LOST → USD net 0.
		sql.webhookEvents.set("e_up", { id: "e_up", type: "payment.succeeded", payload: { data: { payment_id: "pu", total_amount: 1000, currency: "USD" } } });
		sql.webhookEvents.set("e_uo", { id: "e_uo", type: "dispute.opened", payload: { data: { dispute_id: "du", payment_id: "pu", amount: "10.00", currency: "USD" } } });
		sql.webhookEvents.set("e_ul", { id: "e_ul", type: "dispute.lost", payload: { data: { dispute_id: "du", payment_id: "pu" } } });

		await backfillPaymentTransactions(sql);
		const byCur = new Map<string, number>();
		for (const tx of sql.listTransactions()) byCur.set(tx.currency ?? "", (byCur.get(tx.currency ?? "") ?? 0) + tx.amount_cents);
		expect(byCur.get("JPY")).toBe(1900); // 1900 - 1900 + 1900
		expect(byCur.get("USD")).toBe(0); // 1000 - 1000, lost (no reversal)
	});
});

describe("FilePaymentTransactionsStore", () => {
	test("upsert is idempotent on (kind, ref) and lists newest-first", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pay_1", amountCents: 1900, currency: "usd", planId: "pro", occurredAt: "2026-06-01T00:00:00.000Z" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pay_1", amountCents: 1900, currency: "usd", planId: "pro", occurredAt: "2026-06-01T00:00:00.000Z" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pay_2", amountCents: 800, currency: "usd", planId: "starter", occurredAt: "2026-06-02T00:00:00.000Z" });

		const { transactions, total } = await store.listTransactions();
		expect(total).toBe(2); // pay_1 deduped
		expect(transactions[0].dodoEventRef).toBe("pay_2"); // newest first
		expect(transactions[0].currency).toBe("USD"); // normalized upper
	});

	test("sumByPlan nets refunds against payments per plan (string amounts)", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "p1", amountCents: 1900, planId: "pro", currency: "USD" });
		await store.upsertTransaction({ kind: "refund", dodoEventRef: "r1", amountCents: -500, planId: "pro", currency: "USD" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "p2", amountCents: 800, planId: "starter", currency: "USD" });

		const sums = await store.sumByPlan();
		const proPayment = sums.find((s) => s.planId === "pro" && s.kind === "payment");
		const proRefund = sums.find((s) => s.planId === "pro" && s.kind === "refund");
		// Amounts are precision-safe integer STRINGS, never JS numbers.
		expect(proPayment?.amountCents).toBe("1900");
		expect(proRefund?.amountCents).toBe("-500");
		expect(proPayment?.currency).toBe("USD");
	});

	test("sumByPeriod buckets by month (string amounts)", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "m1", amountCents: 1000, currency: "USD", occurredAt: "2026-06-03T00:00:00.000Z" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "m2", amountCents: 2000, currency: "USD", occurredAt: "2026-06-20T00:00:00.000Z" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "m3", amountCents: 500, currency: "USD", occurredAt: "2026-07-01T00:00:00.000Z" });

		const months = await store.sumByPeriod({ interval: "month" });
		expect(months).toHaveLength(2);
		expect(months[0]).toEqual(expect.objectContaining({ period: "2026-06-01T00:00:00.000Z", currency: "USD", amountCents: "3000", count: 2 }));
		expect(months[1]).toEqual(expect.objectContaining({ period: "2026-07-01T00:00:00.000Z", amountCents: "500" }));
	});

	test("date-range filter applies inclusive-from / exclusive-to", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "f1", amountCents: 100, occurredAt: "2026-06-01T00:00:00.000Z" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "f2", amountCents: 200, occurredAt: "2026-06-15T00:00:00.000Z" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "f3", amountCents: 400, occurredAt: "2026-07-01T00:00:00.000Z" });

		const { transactions, total } = await store.listTransactions({ from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" });
		expect(total).toBe(2); // f1 (incl) + f2, f3 excluded by exclusive `to`
		expect(transactions.map((t) => t.dodoEventRef).sort()).toEqual(["f1", "f2"]);
	});
});

// --- Fix 1: currency-aware sums (never add different currencies) -------------
describe("currency-aware sums", () => {
	test("sumByPlan returns SEPARATE buckets per currency (USD + JPY never added)", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "u1", amountCents: 1900, planId: "pro", currency: "USD", workspaceId: "ws_multi" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "u2", amountCents: 1100, planId: "pro", currency: "USD", workspaceId: "ws_multi" });
		// 100 JPY is 100 minor units (0-decimal) — adding it to USD cents would be nonsense.
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "j1", amountCents: 100, planId: "pro", currency: "JPY", workspaceId: "ws_multi" });

		const sums = await store.sumByPlan();
		const usd = sums.find((s) => s.currency === "USD" && s.kind === "payment");
		const jpy = sums.find((s) => s.currency === "JPY" && s.kind === "payment");
		expect(usd?.amountCents).toBe("3000"); // 1900 + 1100, USD only
		expect(jpy?.amountCents).toBe("100"); // JPY in its own bucket, never summed with USD
		expect(usd?.count).toBe(2);
		expect(jpy?.count).toBe(1);
		// No bucket ever merges currencies.
		expect(sums.filter((s) => s.kind === "payment").length).toBe(2);
	});

	test("sumByPeriod splits a single month into per-currency buckets", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pu", amountCents: 5000, currency: "USD", occurredAt: "2026-06-10T00:00:00.000Z" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pe", amountCents: 4000, currency: "EUR", occurredAt: "2026-06-12T00:00:00.000Z" });

		const months = await store.sumByPeriod({ interval: "month" });
		const usd = months.find((m) => m.currency === "USD");
		const eur = months.find((m) => m.currency === "EUR");
		expect(usd?.amountCents).toBe("5000");
		expect(eur?.amountCents).toBe("4000");
		// Same month, two currencies → two distinct buckets (never added to 9000).
		expect(months.filter((m) => m.period === "2026-06-01T00:00:00.000Z").length).toBe(2);
	});

	test("currency filter restricts to one currency", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "cf_u", amountCents: 200, currency: "USD" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "cf_j", amountCents: 300, currency: "JPY" });
		const sums = await store.sumByPlan({ currency: "usd" }); // case-insensitive
		expect(sums).toHaveLength(1);
		expect(sums[0]?.currency).toBe("USD");
		expect(sums[0]?.amountCents).toBe("200");
	});
});

// --- Fix 3: decimal-safe + large-sum precision (BigInt, no float drift) ------
describe("decimal-safe money helpers", () => {
	test("majorDecimalToCents converts decimal strings exactly (no float multiply)", () => {
		expect(majorDecimalToCents("19.99")).toBe("1999"); // the classic 19.99*100 float trap
		expect(majorDecimalToCents("19.00")).toBe("1900");
		expect(majorDecimalToCents("0.01")).toBe("1");
		expect(majorDecimalToCents("1234567890.12")).toBe("123456789012");
		expect(majorDecimalToCents("-5.50")).toBe("-550");
		expect(majorDecimalToCents("100")).toBe("10000");
		// JPY (0-decimal): "1900" major == 1900 minor.
		expect(majorDecimalToCents("1900", 0)).toBe("1900");
	});

	test("majorDecimalToCents rounds the sub-cent tail half-up per the defined rule", () => {
		expect(majorDecimalToCents("19.005")).toBe("1901"); // 1900.5 cents → 1901 (half-up)
		expect(majorDecimalToCents("19.004")).toBe("1900"); // below half → 1900
		expect(majorDecimalToCents("19.994")).toBe("1999");
		expect(majorDecimalToCents("19.995")).toBe("2000");
	});

	test("majorDecimalToCents rejects unparseable input", () => {
		expect(majorDecimalToCents("abc")).toBeNull();
		expect(majorDecimalToCents("")).toBeNull();
		expect(majorDecimalToCents(".")).toBeNull();
	});

	test("normalizeCents / negateCents / absCents keep integers exact", () => {
		expect(normalizeCents(1900)).toBe("1900");
		expect(normalizeCents("1900")).toBe("1900");
		expect(normalizeCents(BigInt("90071992547409910"))).toBe("90071992547409910");
		expect(negateCents("1900")).toBe("-1900");
		expect(negateCents("-1900")).toBe("1900");
		expect(absCents("-1900")).toBe("1900");
	});

	test("sumCents stays precise above Number.MAX_SAFE_INTEGER (no float drift)", () => {
		// Number.MAX_SAFE_INTEGER is 9007199254740991. Build a total just past it whose
		// low digits a JS number cannot represent: MAX_SAFE_INTEGER + 1 + 1 + ... so the
		// exact integer ends in digits that float rounding drops.
		const rows = ["9007199254740991", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1"]; // 9007199254740991 + 10
		const total = sumCents(rows);
		expect(total).toBe("9007199254741001"); // exact via BigInt
		// A JS number cannot hold this exactly — round-tripping through Number drifts.
		expect(String(Number(total))).not.toBe(total);
	});

	// --- BUG 2: a JS NUMBER above MAX_SAFE_INTEGER is REJECTED, not truncated ----
	test("normalizeCents THROWS on a JS number above Number.MAX_SAFE_INTEGER (exact-or-rejected)", () => {
		// 9007199254740993 (MAX_SAFE_INTEGER + 2) cannot exist as a JS number — the
		// literal materializes as ...992. Whatever unsafe whole number arrives, it was
		// already corrupted, so we reject rather than store a wrong cent value.
		expect(() => normalizeCents(9007199254740993)).toThrow(/MAX_SAFE_INTEGER/);
		expect(() => normalizeCents(Number.MAX_SAFE_INTEGER + 10)).toThrow(/MAX_SAFE_INTEGER/);
		// The boundary value itself is still exactly representable → accepted.
		expect(normalizeCents(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
		// The string/BigInt path stays EXACT at any magnitude (the safe way in).
		expect(normalizeCents("9007199254740993")).toBe("9007199254740993");
		expect(normalizeCents(BigInt("9007199254740993"))).toBe("9007199254740993");
		// A genuinely fractional number is still accepted (rounded half-up).
		expect(normalizeCents(1900.4)).toBe("1900");
		expect(normalizeCents(1900.5)).toBe("1901");
	});

	test("readMinorUnitCents THROWS on a numeric field above MAX_SAFE_INTEGER but is EXACT via string", () => {
		// A numeric JSON field that overflowed → reject (don't persist the corrupted value).
		expect(() => readMinorUnitCents({ total_amount: 9007199254740993 }, ["total_amount"])).toThrow(/MAX_SAFE_INTEGER/);
		// The same magnitude as a STRING ingests exactly (preferred provider shape).
		expect(readMinorUnitCents({ total_amount: "9007199254740993" }, ["total_amount"])).toBe("9007199254740993");
		// A safe numeric field is unchanged.
		expect(readMinorUnitCents({ amount: 1900 }, ["amount"])).toBe("1900");
	});

	test("majorDecimalToCents THROWS on an unsafe whole NUMBER (number path is exact-or-rejected)", () => {
		expect(() => majorDecimalToCents(9007199254740993)).toThrow(/MAX_SAFE_INTEGER/);
		// A string of the same magnitude converts exactly (USD default 2 decimals).
		expect(majorDecimalToCents("9007199254740993")).toBe("900719925474099300");
	});

	// --- BUG 3: decimal→cents is CURRENCY-AWARE (JPY 0 / USD 2 / KWD 3) ----------
	test("minorUnitsFor maps ISO-4217 zero/two/three-decimal currencies", () => {
		expect(minorUnitsFor("JPY")).toBe(0);
		expect(minorUnitsFor("jpy")).toBe(0); // case-insensitive
		expect(minorUnitsFor("KRW")).toBe(0);
		expect(minorUnitsFor("VND")).toBe(0);
		expect(minorUnitsFor("USD")).toBe(2);
		expect(minorUnitsFor("EUR")).toBe(2);
		expect(minorUnitsFor("KWD")).toBe(3);
		expect(minorUnitsFor("BHD")).toBe(3);
		expect(minorUnitsFor(null)).toBe(2); // unknown/empty defaults to 2
		expect(minorUnitsFor("ZZZ")).toBe(2);
	});

	test("majorDecimalToCents respects per-currency minor units (JPY 0, USD 2, KWD 3)", () => {
		// The 100x bug: JPY "1900" is ALREADY minor units → 1900, not 190000.
		expect(majorDecimalToCents("1900", minorUnitsFor("JPY"))).toBe("1900");
		// USD "19.00" → 1900 cents.
		expect(majorDecimalToCents("19.00", minorUnitsFor("USD"))).toBe("1900");
		// KWD "1.234" → 1234 fils (3-decimal).
		expect(majorDecimalToCents("1.234", minorUnitsFor("KWD"))).toBe("1234");
		// KWD rounds the 4th decimal half-up at the fil.
		expect(majorDecimalToCents("1.2345", minorUnitsFor("KWD"))).toBe("1235");
	});
});

describe("Postgres-shape decimal/large-sum behavior (file store mirrors PG)", () => {
	test("a large multi-row SUM is returned precisely as a string", async () => {
		const store = new FilePaymentTransactionsStore();
		// 1000 rows of 9_007_199_254_740_991 cents each (each row fits in a JS number,
		// the SUM does not). The Postgres store returns SUM as ::text for the same reason.
		for (let i = 0; i < 1000; i++) {
			await store.upsertTransaction({ kind: "payment", dodoEventRef: `big_${i}`, amountCents: "9007199254740991", currency: "USD", planId: "pro" });
		}
		const sums = await store.sumByPlan();
		const bucket = sums.find((s) => s.currency === "USD" && s.kind === "payment");
		expect(bucket?.amountCents).toBe("9007199254740991000");
		expect(bucket?.count).toBe(1000);
	});

	test("a dispute of '19.99' nets exactly -1999 against a 1999 payment", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pay_x", amountCents: 1999, currency: "USD", planId: "pro" });
		await store.upsertTransaction({ kind: "dispute", dodoEventRef: "dp_x", amountCents: negateCents(majorDecimalToCents("19.99")!), currency: "USD" });
		const sums = await store.sumByPlan();
		const net = sumCents(sums.map((s) => s.amountCents));
		expect(net).toBe("0"); // 1999 payment - 1999 dispute nets to zero, exactly
	});

	test("support refund rejects a fully charged-back payment instead of double-paying", async () => {
		const store = new FilePaymentTransactionsStore();
		const service = new DodoService({
			client: {} as DodoPayments,
			sqlClient: null,
			config: {
				...serverConfig,
				billingProvider: "none",
			},
		});
		await store.upsertTransaction({
			workspaceId: "ws_refund_cb",
			dodoPaymentId: "pay_refund_cb",
			dodoEventRef: "pay_refund_cb",
			kind: "payment",
			amountCents: 10000,
			currency: "USD",
		});
		await store.upsertTransaction({
			workspaceId: "ws_refund_cb",
			dodoPaymentId: "pay_refund_cb",
			dodoEventRef: "dp_refund_cb",
			kind: "dispute",
			amountCents: -10000,
			currency: "USD",
		});

		const state = await store.getChargeRefundState("pay_refund_cb", "ws_refund_cb");
		expect(state).toMatchObject({
			originalPaidCents: "10000",
			alreadyRefundedCents: "0",
			alreadyDisputedCents: "10000",
			remainingRefundableCents: "0",
		});
		await expect(
			service.recordSupportRefund({
				workspaceId: "ws_refund_cb",
				amountCents: 10000,
				currency: "USD",
				reason: "chargeback already clawed back",
				initiatedBy: "admin_refund",
				idempotencyKey: "support_refund_after_cb",
				dodoChargeId: "pay_refund_cb",
				paymentTransactionsStore: store,
			}),
		).rejects.toMatchObject({ code: "dodo_refund_already_full", status: 400 });
		expect((await store.listTransactions({ kind: "refund" })).total).toBe(0);
	});

	// --- BUG 2: per-row cents above Number.MAX_SAFE_INTEGER are HARD-REJECTED --
	test("upsert HARD-REJECTS a per-row cents magnitude above Number.MAX_SAFE_INTEGER (no silent truncation)", async () => {
		const store = new FilePaymentTransactionsStore();
		// 9007199254740993 = MAX_SAFE_INTEGER + 2; Number() would silently round it to
		// ...992. The store throws instead of persisting a WRONG cent value.
		await expect(
			store.upsertTransaction({ kind: "payment", dodoEventRef: "pay_huge", amountCents: "9007199254740993", currency: "USD" }),
		).rejects.toThrow(/MAX_SAFE_INTEGER/);
		// Nothing was persisted.
		expect((await store.listTransactions()).total).toBe(0);
	});

	test("upsert stores a value EXACTLY at Number.MAX_SAFE_INTEGER (boundary is allowed)", async () => {
		const store = new FilePaymentTransactionsStore();
		const row = await store.upsertTransaction({ kind: "payment", dodoEventRef: "pay_max", amountCents: "9007199254740991", currency: "USD" });
		expect(row.amountCents).toBe(9007199254740991);
	});
});

describe("readMinorUnitCents preserves exact integer cents (BUG 2 ingest path)", () => {
	test("an integer-string cents field above MAX_SAFE_INTEGER stays EXACT (no Number() truncation)", () => {
		// Number("9007199254740993") === 9007199254740992 (silent loss). The reader
		// keeps the exact value as a string via BigInt.
		expect(readMinorUnitCents({ total_amount: "9007199254740993" }, ["total_amount"])).toBe("9007199254740993");
		expect(readMinorUnitCents({ amount: "12345678901234567890" }, ["amount"])).toBe("12345678901234567890");
	});

	test("a numeric cents field and a missing field behave as before", () => {
		expect(readMinorUnitCents({ total_amount: 1900 }, ["total_amount"])).toBe("1900");
		expect(readMinorUnitCents({}, ["total_amount", "amount"])).toBeNull();
	});

	test("a webhook ingest of a >MAX_SAFE_INTEGER cents string round-trips EXACTLY (no precision loss)", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		// total_amount as an integer STRING above MAX_SAFE_INTEGER (provider edge case).
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_big_str", total_amount: "9007199254740993", currency: "USD", metadata: { workspace_id: "ws_big" } },
		});
		await service.processWebhook(event, signedHeaders(event, "evt_big_str"));
		const row = sql.listTransactions().find((t) => t.dodo_payment_id === "pay_big_str");
		expect(row).toBeDefined();
		// The EXACT integer string was bound to the (bigint) amount_cents column — never
		// coerced through Number(), which would have truncated 993 → 992.
		expect(sql.boundAmountCents).toContain("9007199254740993");
	});
});

// --- Fix 4: file-store idempotency parity with Postgres ----------------------
describe("idempotency key parity (file store)", () => {
	test("re-delivered webhook (diff event id, same ref) dedupes to ONE row", async () => {
		const store = new FilePaymentTransactionsStore();
		// Same payment ref, two distinct webhook deliveries (different dodoEventId).
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pay_redeliver", dodoEventId: "evt_first", amountCents: 1900, currency: "USD" });
		await store.upsertTransaction({ kind: "payment", dodoEventRef: "pay_redeliver", dodoEventId: "evt_second", amountCents: 1900, currency: "USD" });
		const { total } = await store.listTransactions();
		// Prefers (kind, ref) like Postgres → one row, not two.
		expect(total).toBe(1);
	});

	test("falls back to event id only when no ref is present", async () => {
		const store = new FilePaymentTransactionsStore();
		await store.upsertTransaction({ kind: "payment", dodoEventId: "evt_only", amountCents: 500, currency: "USD" });
		await store.upsertTransaction({ kind: "payment", dodoEventId: "evt_only", amountCents: 500, currency: "USD" });
		const { total } = await store.listTransactions();
		expect(total).toBe(1);
	});
});

// --- Fix 2 + Fix 4: webhook record path (dispute null workspace, parity) -----
describe("dispute revenue persists even when workspace is unresolved", () => {
	test("dispute webhook with NO resolvable workspace still writes the negative row (workspace_id null)", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		// No metadata.workspace_id, and no billing account / customer to resolve from.
		const event = JSON.stringify({
			type: "dispute.opened",
			data: { dispute_id: "dp_orphan", payment_id: "pay_orphan", amount: "19.99", currency: "USD", status: "opened" },
		});
		await service.processWebhook(event, signedHeaders(event, "evt_dp_orphan"));

		const rows = sql.listTransactions();
		const dispute = rows.find((r) => r.kind === "dispute" && r.dodo_event_ref === "dp_orphan");
		expect(dispute).toBeDefined();
		// The money record is not lost: workspace_id stays null (migration 0052 made it
		// nullable precisely so out-of-order webhooks persist), amount is decimal-safe.
		expect(dispute?.workspace_id).toBeNull();
		expect(dispute?.amount_cents).toBe(-1999); // "19.99" → 1999 cents, stored negative
		expect(dispute?.currency).toBe("USD");
		// The chargeback hold side effect is deferred (no workspace), but no money dropped.
		expect(sql.disputes.get("dp_orphan")).toBeUndefined();
	});

	test("re-delivered dispute (diff webhook id, same dispute id) dedupes to one row", async () => {
		const sql = new FakeRevenueSqlClient();
		const service = createService(sql);
		const make = (id: string) => {
			const event = JSON.stringify({ type: "dispute.opened", data: { dispute_id: "dp_redeliver", payment_id: "pay_d", amount: "19.99", currency: "USD", metadata: { workspace_id: "ws_d" } } });
			return { event, headers: signedHeaders(event, id) };
		};
		const a = make("evt_d_a");
		const b = make("evt_d_b");
		await service.processWebhook(a.event, a.headers);
		await service.processWebhook(b.event, b.headers);
		// Two deliveries, one dispute id → one dispute revenue row.
		expect(sql.listTransactions().filter((r) => r.kind === "dispute")).toHaveLength(1);
	});
});
