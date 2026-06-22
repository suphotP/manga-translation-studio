import { createHmac } from "crypto";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type DodoPayments from "dodopayments";
import { createDodoBillingRouter } from "../routes/billing-dodo.js";
import { createDodoWebhookRouter } from "../routes/webhooks-dodo.js";
import { DodoService, type DodoSqlClient, verifyWebhookSignature } from "../services/dodo.service.js";
import { isDunningGraceExpired } from "../services/billing-store.js";
import { originGuard, protectedApiAuthGuard } from "../middleware/security-guards.js";
import { serverConfig } from "../config.js";

const WEBHOOK_SECRET = "test-webhook-secret";

class FakeDodoSqlClient implements DodoSqlClient {
	readonly webhookEvents = new Map<string, { id: string; type: string; processed: boolean; error?: string }>();
	readonly billingCustomers = new Map<string, Record<string, unknown>>();
	readonly billingAccounts = new Map<string, Record<string, unknown>>();
	readonly workspaces = new Map<string, { workspace_id: string; chargeback_pending: boolean; suspended_at?: string | null; suspended_reason?: string | null }>();
	readonly disputes = new Map<string, Record<string, unknown>>();
	// Minimal payment_transactions ledger, keyed by (kind, dodo_event_ref) like the
	// real ON CONFLICT target, so the refund-revoke rollup can sum gross/refund/dispute.
	readonly paymentTransactions = new Map<string, { kind: string; dodo_payment_id: string | null; dodo_invoice_id: string | null; amount_cents: string | null }>();
	// storage_packs rows written by the add-on grant path, keyed by PK (storage_pack_id)
	// to model ON CONFLICT DO NOTHING (a replayed webhook re-derives the same PK → no dup).
	readonly storagePacks = new Map<string, { workspace_id: string; sku_id: string; pack_size_bytes: string }>();

	async begin<T>(fn: (transaction: DodoSqlClient) => Promise<T>): Promise<T> {
		return fn(this);
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		const normalized = query.replace(/\s+/g, " ").trim();
		if (normalized.startsWith("INSERT INTO dodo_webhook_events")) {
			const id = String(params[0]);
			if (this.webhookEvents.has(id)) return [] as T[];
			this.webhookEvents.set(id, { id, type: String(params[1]), processed: false });
			return [{ id }] as T[];
		}
		if (normalized.startsWith("UPDATE dodo_webhook_events SET processed_at")) {
			const row = this.webhookEvents.get(String(params[0]));
			if (row) row.processed = true;
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE dodo_webhook_events SET error")) {
			const row = this.webhookEvents.get(String(params[0]));
			if (row) row.error = String(params[1]);
			return [] as T[];
		}
		if (normalized.startsWith("INSERT INTO workspace_billing_customers")) {
			this.billingCustomers.set(String(params[0]), {
				workspace_id: params[0],
				dodo_customer_id: params[1],
				dodo_subscription_id: params[2],
				dodo_payment_method_id: params[3],
				status: params[4],
			});
			return [] as T[];
		}
		if (normalized.startsWith("INSERT INTO workspace_billing_accounts")) {
			const existing = this.billingAccounts.get(String(params[0]));
			// Model the REAL production SQL semantics:
			//  - INSERT (no existing row): plan_id := $2 (the insert default).
			//  - ON CONFLICT (existing row): plan_id := COALESCE(<validated planId>, existing.plan_id).
			//    upsertBillingAccount (8 params) uses $8; upsertBillingAccountStatus
			//    (6 params) uses $6. That validated-planId param is null when the incoming
			//    event carried no validated grant, so the stored plan_id is preserved; a
			//    validated grant upgrades it (even from 'free').
			const hasPeriodColumns = params.length >= 7;
			const metadataParam = hasPeriodColumns ? params[6] : params[4];
			let planId: unknown;
			if (!existing) {
				planId = params[1];
			} else if (params.length >= 8) {
				planId = params[7] ?? existing.plan_id; // COALESCE($8, existing)
			} else {
				planId = params[5] ?? existing.plan_id; // COALESCE($6, existing) — validated grant upgrades
			}
			this.billingAccounts.set(String(params[0]), {
				...existing,
				workspace_id: params[0],
				plan_id: planId,
				status: params[2],
				billing_email: params[3] ?? existing?.billing_email,
				current_period_start: hasPeriodColumns ? params[4] : existing?.current_period_start,
				current_period_end: hasPeriodColumns ? params[5] : existing?.current_period_end,
				metadata: {
					...(existing?.metadata as object | undefined),
					...JSON.parse(String(metadataParam)),
				},
			});
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspace_billing_accounts SET status = 'cancelled'")) {
			const row = this.billingAccounts.get(String(params[0]));
			if (row) {
				row.status = "cancelled";
				row.metadata = { ...(row.metadata as object), ...JSON.parse(String(params[1])) };
			}
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspace_billing_accounts SET status = $3")) {
			// resolveChargeback: params = [workspaceId, metadataJson, restoredStatus]
			const row = this.billingAccounts.get(String(params[0]));
			if (row) {
				row.status = params[2];
				row.metadata = { ...(row.metadata as object), ...JSON.parse(String(params[1])) };
			}
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspace_billing_accounts SET metadata = metadata")) {
			// recordPaymentDuringChargeback: params = [workspaceId, metadataJson]
			const row = this.billingAccounts.get(String(params[0]));
			if (row) {
				row.metadata = { ...(row.metadata as object), ...JSON.parse(String(params[1])) };
			}
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspace_billing_accounts SET status")) {
			const row = this.billingAccounts.get(String(params[0]));
			if (row) {
				row.status = params[1];
				row.metadata = { ...(row.metadata as object), ...JSON.parse(String(params[2])) };
			}
			return [] as T[];
		}
		if (normalized.startsWith("SELECT status, current_period_end, metadata FROM workspace_billing_accounts")) {
			const row = this.billingAccounts.get(String(params[0]));
			if (!row) return [] as T[];
			return [{
				status: row.status ?? null,
				current_period_end: row.current_period_end ?? null,
				metadata: row.metadata ?? {},
			}] as T[];
		}
		if (normalized.startsWith("SELECT chargeback_pending FROM workspaces")) {
			const workspace = this.workspaces.get(String(params[0]));
			return (workspace ? [{ chargeback_pending: workspace.chargeback_pending }] : []) as T[];
		}
		if (normalized.startsWith("SELECT metadata->>'chargeback_pending' AS chargeback_pending FROM workspace_billing_accounts")) {
			const row = this.billingAccounts.get(String(params[0]));
			const metadata = row?.metadata as Record<string, unknown> | undefined;
			const value = metadata?.chargeback_pending;
			return [{ chargeback_pending: value === true ? "true" : value === false ? "false" : value ?? null }] as T[];
		}
		if (normalized.startsWith("UPDATE workspaces SET suspended_at = COALESCE")) {
			// freezeWorkspace: params = [workspaceId, reason]. Idempotent — keep the
			// original instant/reason when already frozen (model COALESCE).
			const workspaceId = String(params[0]);
			const existing = this.workspaces.get(workspaceId) ?? { workspace_id: workspaceId, chargeback_pending: false };
			if (!existing.suspended_at) {
				existing.suspended_at = "now";
				existing.suspended_reason = String(params[1]);
			}
			this.workspaces.set(workspaceId, existing);
			return [] as T[];
		}
		if (
			normalized.startsWith("UPDATE workspaces SET suspended_at = NULL")
			&& normalized.includes("suspended_reason = 'chargeback'")
			&& normalized.includes("RETURNING")
		) {
			// M1 reason-guarded chargeback unfreeze: params = [workspaceId]. Clears the
			// freeze ONLY when it was frozen for 'chargeback' (an independent refund freeze
			// is left intact) and RETURNS the row so the caller knows a row was cleared.
			const workspaceId = String(params[0]);
			const existing = this.workspaces.get(workspaceId);
			if (existing && existing.suspended_reason === "chargeback") {
				existing.suspended_at = null;
				existing.suspended_reason = null;
				return [{ workspace_id: workspaceId }] as T[];
			}
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspaces SET suspended_at = NULL")) {
			// unfreezeWorkspace: params = [workspaceId].
			const workspaceId = String(params[0]);
			const existing = this.workspaces.get(workspaceId);
			if (existing) {
				existing.suspended_at = null;
				existing.suspended_reason = null;
			}
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspaces SET chargeback_pending = false")) {
			// Real Postgres only touches chargeback_pending here — PRESERVE suspended_at /
			// suspended_reason (the freeze is an independent column, cleared separately by the
			// reason-guarded unfreeze that runs later in resolveChargeback).
			const workspaceId = String(params[0]);
			const existing = this.workspaces.get(workspaceId) ?? { workspace_id: workspaceId, chargeback_pending: false };
			existing.chargeback_pending = false;
			this.workspaces.set(workspaceId, existing);
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE workspaces SET chargeback_pending")) {
			const workspaceId = String(params[0]);
			this.workspaces.set(workspaceId, { workspace_id: workspaceId, chargeback_pending: true });
			return [] as T[];
		}
		if (normalized.startsWith("INSERT INTO chargeback_disputes")) {
			this.disputes.set(String(params[2]), {
				id: params[0],
				workspace_id: params[1],
				dodo_dispute_id: params[2],
				reason: params[3],
				status: params[4],
			});
			return [] as T[];
		}
		if (normalized.startsWith("UPDATE chargeback_disputes SET status")) {
			const dispute = this.disputes.get(String(params[0]));
			if (dispute) {
				dispute.status = params[1];
				dispute.resolved_at = "now";
			}
			return [] as T[];
		}
		if (normalized.startsWith("SELECT workspace_id FROM chargeback_disputes")) {
			const dispute = this.disputes.get(String(params[0]));
			return (dispute ? [{ workspace_id: dispute.workspace_id }] : []) as T[];
		}
		if (normalized.startsWith("SELECT workspace_id FROM workspace_billing_customers")) {
			const subscriptionId = params[0];
			const customerId = params[1];
			for (const row of this.billingCustomers.values()) {
				if ((subscriptionId && row.dodo_subscription_id === subscriptionId) || (customerId && row.dodo_customer_id === customerId)) {
					return [{ workspace_id: row.workspace_id }] as T[];
				}
			}
			return [] as T[];
		}
		if (normalized.startsWith("SELECT workspace_id FROM workspace_billing_accounts WHERE metadata->>'dodo_payment_id'")) {
			const paymentId = params[0];
			for (const row of this.billingAccounts.values()) {
				const metadata = row.metadata as Record<string, unknown> | undefined;
				if (metadata?.dodo_payment_id === paymentId) {
					return [{ workspace_id: row.workspace_id }] as T[];
				}
			}
			return [] as T[];
		}
		// findBillingAccount: read the raw metadata blob for a workspace (dunning grace
		// deadline lookup in applyPaymentFailureFromEvent).
		if (normalized.startsWith("SELECT metadata FROM workspace_billing_accounts")) {
			const row = this.billingAccounts.get(String(params[0]));
			return (row ? [{ metadata: row.metadata ?? {} }] : []) as T[];
		}
		// hasActiveLinkedSubscription: the linked Dodo subscription + its status.
		if (normalized.startsWith("SELECT status, dodo_subscription_id FROM workspace_billing_customers")) {
			const row = this.billingCustomers.get(String(params[0]));
			return (row ? [{ status: row.status ?? null, dodo_subscription_id: row.dodo_subscription_id ?? null }] : []) as T[];
		}
		// payment_transactions ledger (revenue rows) — upsert keyed on (kind, ref).
		if (normalized.startsWith("INSERT INTO payment_transactions")) {
			// Param order mirrors upsertPaymentTransactionRow: $2 workspace, $3 payment id,
			// $4 invoice id, $5 event_ref, $6 event_id, $7 kind, $8 amount_cents.
			const kind = String(params[6]);
			const ref = params[4] != null ? String(params[4]) : `evt:${String(params[5])}`;
			const key = `${kind}:${ref}`;
			const existing = this.paymentTransactions.get(key);
			this.paymentTransactions.set(key, {
				kind,
				// Mirror COALESCE(existing, EXCLUDED): keep a prior id when the new row omits it.
				dodo_payment_id: params[2] != null ? String(params[2]) : (existing?.dodo_payment_id ?? null),
				dodo_invoice_id: params[3] != null ? String(params[3]) : (existing?.dodo_invoice_id ?? null),
				amount_cents: params[7] != null ? String(params[7]) : null,
			});
			return [] as T[];
		}
		// findPaymentIdByDisputeId: the disputed payment id recorded on the dispute row,
		// used to scope the LOST payment-ref tombstone when the resolution payload omits it.
		if (normalized.startsWith("SELECT dodo_payment_id FROM payment_transactions")) {
			const disputeRef = String(params[0]);
			const row = this.paymentTransactions.get(`dispute:${disputeRef}`);
			return (row && row.dodo_payment_id ? [{ dodo_payment_id: row.dodo_payment_id }] : []) as T[];
		}
		// findInvoiceIdByDisputeId: the disputed payment's invoice id recorded on the dispute
		// row, used to make the LOST payment-ref tombstone SYMMETRIC with extractAddonGrantRef
		// (an invoice-only add-on anchored on its invoice_id).
		if (normalized.startsWith("SELECT dodo_invoice_id FROM payment_transactions")) {
			const disputeRef = String(params[0]);
			const row = this.paymentTransactions.get(`dispute:${disputeRef}`);
			return (row && row.dodo_invoice_id ? [{ dodo_invoice_id: row.dodo_invoice_id }] : []) as T[];
		}
		// refundRollupForPayment: every ledger row for a given payment id.
		if (normalized.startsWith("SELECT kind, amount_cents FROM payment_transactions")) {
			const paymentId = String(params[0]);
			const rows = [...this.paymentTransactions.values()]
				.filter((r) => r.dodo_payment_id === paymentId)
				.map((r) => ({ kind: r.kind, amount_cents: r.amount_cents }));
			return rows as T[];
		}
		// storage_packs upsert from the add-on grant path (ON CONFLICT (PK) DO NOTHING).
		if (normalized.startsWith("INSERT INTO storage_packs")) {
			const packId = String(params[0]);
			if (!this.storagePacks.has(packId)) {
				this.storagePacks.set(packId, {
					workspace_id: String(params[1]),
					sku_id: String(params[2]),
					pack_size_bytes: String(params[3]),
				});
			}
			return [] as T[];
		}
		return [] as T[];
	}
}

describe("Dodo webhook billing", () => {
	test("webhook signature verification accepts valid payloads and rejects tampering", () => {
		const event = JSON.stringify({ id: "evt_sig", type: "payment.succeeded", data: { metadata: { workspace_id: "ws_1" } } });
		const headers = signedHeaders(event, "evt_sig");

		expect(verifyWebhookSignature(event, headers, WEBHOOK_SECRET)).toBe(true);
		expect(verifyWebhookSignature(event.replace("ws_1", "ws_2"), headers, WEBHOOK_SECRET)).toBe(false);
	});

	test("webhook route returns 401 for tampered signatures", async () => {
		const app = new Hono();
		const service = createWebhookService(new FakeDodoSqlClient());
		app.route("/api/billing", createDodoWebhookRouter({ service }));
		const event = JSON.stringify(subscriptionEvent("evt_bad_sig", "subscription.created", "ws_bad"));
		const headers = signedHeaders(event, "evt_bad_sig");

		const res = await app.request("/api/billing/dodo/webhook", {
			method: "POST",
			headers,
			body: event.replace("ws_bad", "ws_tampered"),
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual(expect.objectContaining({ code: "dodo_webhook_signature_invalid" }));
	});

	test("idempotency skips a second event with the same Dodo id", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const event = JSON.stringify(subscriptionEvent("evt_duplicate", "subscription.created", "ws_duplicate"));
		const headers = signedHeaders(event, "evt_duplicate");

		const first = await service.processWebhook(event, headers);
		const second = await service.processWebhook(event, headers);

		expect(first.processed).toBe(true);
		expect(second.processed).toBe(false);
		expect(sql.webhookEvents.size).toBe(1);
		expect(sql.billingAccounts.get("ws_duplicate")?.status).toBe("active");
	});

	test("uses webhook-id header as the canonical webhook event id", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const event = JSON.stringify(subscriptionEventWithoutBodyId("subscription.active", "ws_header_id", "pro"));
		const headers = signedHeaders(event, "evt_header_canonical");

		const result = await service.processWebhook(event, headers);

		expect(result).toEqual(expect.objectContaining({
			processed: true,
			eventId: "evt_header_canonical",
			type: "subscription.active",
		}));
		expect(sql.webhookEvents.has("evt_header_canonical")).toBe(true);
		expect(sql.billingAccounts.get("ws_header_id")).toEqual(expect.objectContaining({
			plan_id: "pro",
			current_period_start: "2026-06-01T00:00:00.000Z",
			current_period_end: "2026-07-01T00:00:00.000Z",
		}));
	});

	test("subscription.created syncs the workspace billing plan and Dodo customer", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const event = JSON.stringify(subscriptionEvent("evt_sub_created", "subscription.created", "ws_created", "starter"));

		const result = await service.processWebhook(event, signedHeaders(event, "evt_sub_created"));

		expect(result.processed).toBe(true);
		expect(sql.billingCustomers.get("ws_created")).toEqual(expect.objectContaining({
			dodo_customer_id: "cus_ws_created",
			dodo_subscription_id: "sub_ws_created",
			status: "active",
		}));
		expect(sql.billingAccounts.get("ws_created")).toEqual(expect.objectContaining({
			plan_id: "creator",
			status: "active",
		}));
	});

	test("subscription.canceled keeps paid access until the period end", async () => {
		const sql = new FakeDodoSqlClient();
		// now() is well before the 2026-07-01 period end, so this is an
		// end-of-period cancellation: access must be preserved.
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);
		const event = JSON.stringify(subscriptionEvent("evt_sub_cancel", "subscription.canceled", "ws_cancel", "pro"));

		await service.processWebhook(event, signedHeaders(event, "evt_sub_cancel", now));

		const account = sql.billingAccounts.get("ws_cancel");
		expect(account).toEqual(expect.objectContaining({
			plan_id: "pro",
			// Still an access-granting status — the plan-resolution joins only honor
			// mock_active/trialing/active, so cancelling now would wrongly downgrade.
			status: "active",
			current_period_end: "2026-07-01T00:00:00.000Z",
		}));
		expect((account?.metadata as Record<string, unknown>).cancel_at_period_end).toBe(true);
	});

	test("subscription.expired downgrades the plan immediately", async () => {
		const sql = new FakeDodoSqlClient();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);
		const event = JSON.stringify(subscriptionEvent("evt_sub_expired", "subscription.expired", "ws_expired", "pro"));

		await service.processWebhook(event, signedHeaders(event, "evt_sub_expired", now));

		const account = sql.billingAccounts.get("ws_expired");
		expect(account).toEqual(expect.objectContaining({
			plan_id: "pro",
			status: "cancelled",
		}));
		expect((account?.metadata as Record<string, unknown>).cancel_at_period_end).toBe(false);
	});

	test("subscription.canceled downgrades when the stored period end has already passed", async () => {
		const sql = new FakeDodoSqlClient();
		// now() is after the 2026-07-01 period end → access has lapsed.
		const now = new Date("2026-08-01T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);
		const event = JSON.stringify(subscriptionEvent("evt_sub_late_cancel", "subscription.cancelled", "ws_late_cancel", "pro"));

		await service.processWebhook(event, signedHeaders(event, "evt_sub_late_cancel", now));

		expect(sql.billingAccounts.get("ws_late_cancel")?.status).toBe("cancelled");
	});

	test("dispute.won clears the chargeback hold and restores paid access", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const seed = JSON.stringify(subscriptionEvent("evt_resolve_seed", "subscription.active", "ws_resolve", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_resolve_seed"));
		const chargeback = JSON.stringify({
			type: "dispute.opened",
			data: { id: "dp_resolve", reason: "fraud", status: "opened", metadata: { workspace_id: "ws_resolve" } },
		});
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_dispute_open"));
		expect(sql.workspaces.get("ws_resolve")?.chargeback_pending).toBe(true);
		expect(sql.billingAccounts.get("ws_resolve")?.status).toBe("cancelled");

		const resolution = JSON.stringify({
			type: "dispute.won",
			data: { id: "dp_resolve", payment_id: "pay_resolve", status: "won" },
		});
		await service.processWebhook(resolution, signedHeaders(resolution, "evt_dispute_won"));

		expect(sql.workspaces.get("ws_resolve")?.chargeback_pending).toBe(false);
		const account = sql.billingAccounts.get("ws_resolve");
		expect(account?.status).toBe("active");
		expect((account?.metadata as Record<string, unknown>).chargeback_pending).toBe(false);
		expect(sql.disputes.get("dp_resolve")).toEqual(expect.objectContaining({ status: "won" }));
	});

	test("dispute.lost clears the pending flag but keeps the account cancelled", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const seed = JSON.stringify(subscriptionEvent("evt_lost_seed", "subscription.active", "ws_lost", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_lost_seed"));
		const chargeback = JSON.stringify({
			type: "dispute.opened",
			data: { id: "dp_lost", reason: "fraud", status: "opened", metadata: { workspace_id: "ws_lost" } },
		});
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_dispute_open_lost"));

		const resolution = JSON.stringify({
			type: "dispute.lost",
			data: { id: "dp_lost", status: "lost" },
		});
		await service.processWebhook(resolution, signedHeaders(resolution, "evt_dispute_lost"));

		expect(sql.workspaces.get("ws_lost")?.chargeback_pending).toBe(false);
		expect(sql.billingAccounts.get("ws_lost")?.status).toBe("cancelled");
		expect(sql.disputes.get("dp_lost")).toEqual(expect.objectContaining({ status: "lost" }));
	});

	test("dispute.accepted is terminal: clears the pending flag but keeps the account cancelled", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const seed = JSON.stringify(subscriptionEvent("evt_acc_seed", "subscription.active", "ws_accepted", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_acc_seed"));
		const chargeback = JSON.stringify({
			type: "dispute.opened",
			data: { id: "dp_accepted", reason: "fraud", status: "opened", metadata: { workspace_id: "ws_accepted" } },
		});
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_dispute_open_acc"));
		expect(sql.workspaces.get("ws_accepted")?.chargeback_pending).toBe(true);

		const accepted = JSON.stringify({
			type: "dispute.accepted",
			data: { id: "dp_accepted", status: "accepted", metadata: { workspace_id: "ws_accepted" } },
		});
		await service.processWebhook(accepted, signedHeaders(accepted, "evt_dispute_accepted"));

		// Terminal lost outcome: hold cleared, paid access stays revoked.
		expect(sql.workspaces.get("ws_accepted")?.chargeback_pending).toBe(false);
		expect(sql.billingAccounts.get("ws_accepted")?.status).toBe("cancelled");
		expect(sql.disputes.get("dp_accepted")).toEqual(expect.objectContaining({ status: "accepted" }));
	});

	test("rejects a webhook whose signed timestamp is outside the freshness window", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const event = JSON.stringify(subscriptionEvent("evt_stale_ts", "subscription.created", "ws_stale_ts"));
		// Sign with a timestamp far in the past (a captured/replayed delivery).
		const staleHeaders = signedHeaders(event, "evt_stale_ts", "1700000000");

		await expect(service.processWebhook(event, staleHeaders)).rejects.toMatchObject({
			code: "dodo_webhook_timestamp_stale",
			status: 401,
		});
		// Nothing was persisted: the event id must remain replayable-by-id only
		// after a fresh, legitimate delivery wins.
		expect(sql.webhookEvents.size).toBe(0);
		expect(sql.billingAccounts.has("ws_stale_ts")).toBe(false);
	});

	test("ignores a stale subscription.active that arrives after the subscription is cancelled", async () => {
		const sql = new FakeDodoSqlClient();
		// now() after the stored period end so the cancel terminally expires access.
		const now = new Date("2026-08-01T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);

		// 1. Subscription is active, then 2. terminally expires.
		const active = JSON.stringify(subscriptionEvent("evt_ooo_active", "subscription.active", "ws_ooo", "pro"));
		await service.processWebhook(active, signedHeaders(active, "evt_ooo_active", now));
		const expired = JSON.stringify(subscriptionEvent("evt_ooo_expired", "subscription.expired", "ws_ooo", "pro"));
		await service.processWebhook(expired, signedHeaders(expired, "evt_ooo_expired", now));
		expect(sql.billingAccounts.get("ws_ooo")?.status).toBe("cancelled");

		// 3. A stale, out-of-order subscription.updated retry lands AFTER expiry.
		// Its period end (2026-07-01) is already in the past relative to now, so it
		// must NOT reactivate the account.
		const staleUpdate = JSON.stringify(subscriptionEvent("evt_ooo_stale", "subscription.updated", "ws_ooo", "pro"));
		await service.processWebhook(staleUpdate, signedHeaders(staleUpdate, "evt_ooo_stale", now));

		expect(sql.billingAccounts.get("ws_ooo")?.status).toBe("cancelled");
	});

	test("dispute.won does not restore paid access once the subscription period has lapsed", async () => {
		const sql = new FakeDodoSqlClient();
		// now() is after the seeded period end (2026-07-01) → subscription lapsed.
		const now = new Date("2026-09-01T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);

		const seed = JSON.stringify(subscriptionEvent("evt_lapsed_seed", "subscription.active", "ws_lapsed", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_lapsed_seed", now));
		const chargeback = JSON.stringify({
			type: "dispute.opened",
			data: { id: "dp_lapsed", reason: "fraud", status: "opened", metadata: { workspace_id: "ws_lapsed" } },
		});
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_dispute_open_lapsed", now));

		const resolution = JSON.stringify({
			type: "dispute.won",
			data: { id: "dp_lapsed", status: "won", metadata: { workspace_id: "ws_lapsed" } },
		});
		await service.processWebhook(resolution, signedHeaders(resolution, "evt_dispute_won_lapsed", now));

		// Hold cleared, but no current subscription → access stays revoked.
		expect(sql.workspaces.get("ws_lapsed")?.chargeback_pending).toBe(false);
		expect(sql.billingAccounts.get("ws_lapsed")?.status).toBe("cancelled");
	});

	test("late payment.succeeded during an open chargeback does not re-activate paid access", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const seed = JSON.stringify(subscriptionEvent("evt_late_seed", "subscription.active", "ws_late_pay", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_late_seed"));
		const chargeback = JSON.stringify({
			type: "payment.chargeback.created",
			data: { dispute_id: "dp_late", payment_id: "pay_late", reason: "fraud", status: "opened", metadata: { workspace_id: "ws_late_pay" } },
		});
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_late_charge"));
		expect(sql.workspaces.get("ws_late_pay")?.chargeback_pending).toBe(true);
		expect(sql.billingAccounts.get("ws_late_pay")?.status).toBe("cancelled");

		const latePayment = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_late", metadata: { workspace_id: "ws_late_pay", plan_key: "pro" } },
		});
		await service.processWebhook(latePayment, signedHeaders(latePayment, "evt_late_pay_success"));

		// Must stay cancelled while the dispute is open; metadata still records the payment.
		const account = sql.billingAccounts.get("ws_late_pay");
		expect(account?.status).toBe("cancelled");
		expect((account?.metadata as Record<string, unknown>).dodo_payment_id).toBe("pay_late");
		expect((account?.metadata as Record<string, unknown>).receiptQueued).toBe(true);
		expect(sql.workspaces.get("ws_late_pay")?.chargeback_pending).toBe(true);
	});

	test("subscription.plan_changed syncs internal plan from Dodo product_id", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, {
			starter_monthly: "prod_starter_monthly",
			pro_monthly: "prod_pro_monthly",
			studio_monthly: "prod_studio_monthly",
		});
		// A trusted studio product with metadata that AGREES (plan_key=studio) → the
		// validated product plan (studio) is applied immediately.
		const event = JSON.stringify({
			type: "subscription.plan_changed",
			data: {
				id: "sub_ws_plan_changed",
				subscription_id: "sub_ws_plan_changed",
				customer_id: "cus_ws_plan_changed",
				product_id: "prod_studio_monthly",
				proration_billing_mode: "prorated_immediately",
				next_billing_date: "2026-08-01T00:00:00.000Z",
				metadata: {
					workspace_id: "ws_plan_changed",
					plan_key: "studio",
				},
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_plan_changed"));

		expect(sql.billingAccounts.get("ws_plan_changed")).toEqual(expect.objectContaining({
			plan_id: "studio",
			current_period_end: "2026-08-01T00:00:00.000Z",
		}));
	});

	test("subscription.plan_changed REJECTS a product/metadata plan mismatch (no immediate grant)", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, {
			starter_monthly: "prod_starter_monthly",
			pro_monthly: "prod_pro_monthly",
			studio_monthly: "prod_studio_monthly",
		});
		// MONEY-CRITICAL: a cheap-product / expensive-metadata mismatch. The trusted
		// product is STARTER but metadata claims STUDIO. The validation must REJECT the
		// mismatch and NOT grant any tier immediately — it is stored pending instead.
		const event = JSON.stringify({
			type: "subscription.plan_changed",
			data: {
				id: "sub_ws_pc_mismatch",
				subscription_id: "sub_ws_pc_mismatch",
				customer_id: "cus_ws_pc_mismatch",
				product_id: "prod_starter_monthly",
				proration_billing_mode: "prorated_immediately",
				next_billing_date: "2026-08-01T00:00:00.000Z",
				metadata: {
					workspace_id: "ws_pc_mismatch",
					plan_key: "studio",
				},
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_pc_mismatch"));

		const account = sql.billingAccounts.get("ws_pc_mismatch");
		// No paid tier granted immediately: a brand-new row falls back to "free".
		expect(account?.plan_id).toBe("free");
		expect((account?.metadata as Record<string, unknown>).plan_change_grant_rejected).toBeDefined();
	});

	test("subscription.renewed with an unrecognizable plan does NOT downgrade a paying workspace", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);

		// Seed a paying Pro workspace via a normal subscription.active (plan_key=pro).
		const seed = JSON.stringify(subscriptionEvent("evt_renew_seed", "subscription.active", "ws_renew", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_renew_seed"));
		expect(sql.billingAccounts.get("ws_renew")?.plan_id).toBe("pro");

		// A renewal lands with NO recognizable product_id (productIds map is empty)
		// and NO metadata.plan_key. Previously this defaulted to starter→creator and
		// overwrote plan_id, silently downgrading the paying customer. The guard must
		// preserve the stored plan_id.
		const renewal = JSON.stringify({
			type: "subscription.renewed",
			data: {
				id: "sub_ws_renew",
				subscription_id: "sub_ws_renew",
				customer_id: "cus_ws_renew",
				next_billing_date: "2026-08-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_renew" },
			},
		});
		await service.processWebhook(renewal, signedHeaders(renewal, "evt_renew_unknown_plan"));

		const account = sql.billingAccounts.get("ws_renew");
		expect(account?.plan_id).toBe("pro");
		expect(account?.status).toBe("active");
		expect(account?.current_period_end).toBe("2026-08-01T00:00:00.000Z");
	});

	test("subscription.active with metadata plan_key=studio but NO trusted product does NOT grant studio", async () => {
		const sql = new FakeDodoSqlClient();
		// No configured products → no trusted product can be matched. The signed event
		// carries only a forge-able metadata.plan_key=studio and NO validated amount.
		// The sync path MUST NOT grant Studio for free (status-only sync; plan stays free).
		const service = createWebhookService(sql, {});
		const event = JSON.stringify({
			type: "subscription.active",
			data: {
				id: "sub_ws_free_studio",
				subscription_id: "sub_ws_free_studio",
				customer_id: "cus_ws_free_studio",
				// No product_id, no currency, no amount — only forge-able metadata.
				current_period_end: "2026-07-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_free_studio", plan_key: "studio" },
			},
		});
		await service.processWebhook(event, signedHeaders(event, "evt_free_studio"));

		const account = sql.billingAccounts.get("ws_free_studio");
		// Brand-new row with no validated grant → falls back to free, NOT studio.
		expect(account?.plan_id).toBe("free");
		expect(account?.plan_id).not.toBe("studio");
		expect(account?.status).toBe("active");
		// The rejected grant is audit-logged for observability.
		expect((account?.metadata as Record<string, unknown>).dodo_subscription_plan_grant_rejected).toBeDefined();
	});

	test("subscription.active with metadata plan_key=studio does NOT downgrade an existing PAID plan", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, {});
		// Seed a paying Pro workspace by hand (trusted seed via the standard map).
		const paid = createWebhookService(sql);
		const seed = JSON.stringify(subscriptionEvent("evt_keep_seed", "subscription.active", "ws_keep_pro", "pro"));
		await paid.processWebhook(seed, signedHeaders(seed, "evt_keep_seed"));
		expect(sql.billingAccounts.get("ws_keep_pro")?.plan_id).toBe("pro");

		// An unvalidated active event (metadata studio, no product) must NEITHER upgrade
		// to studio NOR downgrade — it preserves the stored paid plan via COALESCE.
		const event = JSON.stringify({
			type: "subscription.active",
			data: {
				id: "sub_ws_keep_pro",
				subscription_id: "sub_ws_keep_pro",
				customer_id: "cus_ws_keep_pro",
				current_period_end: "2026-08-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_keep_pro", plan_key: "studio" },
			},
		});
		await service.processWebhook(event, signedHeaders(event, "evt_keep_studio"));

		const account = sql.billingAccounts.get("ws_keep_pro");
		expect(account?.plan_id).toBe("pro"); // unchanged — neither escalated nor downgraded
		expect((account?.metadata as Record<string, unknown>).dodo_subscription_plan_grant_rejected).toBeDefined();
	});

	test("PLANT-THEN-ACTIVATE: subscription.failed(plan_key=studio) then unvalidated subscription.active does NOT grant studio", async () => {
		const sql = new FakeDodoSqlClient();
		// No configured products → the only plan signal is the forge-able metadata.plan_key.
		const service = createWebhookService(sql, {});

		// (1) PLANT. A signed subscription.failed carries metadata.plan_key=studio with NO
		// trusted product and NO validated amount. This lands status=past_due (NOT yet
		// access-granting) on a brand-NEW workspace row. The old code derived the plan_id
		// from metadata and INSERTED plan_id=studio here — the plant. With the fix, a
		// non-granting status transition writes STATUS ONLY: plan_id must default to free.
		const failed = JSON.stringify({
			type: "subscription.failed",
			data: {
				id: "sub_ws_plant",
				subscription_id: "sub_ws_plant",
				customer_id: "cus_ws_plant",
				metadata: { workspace_id: "ws_plant", plan_key: "studio" },
			},
		});
		await service.processWebhook(failed, signedHeaders(failed, "evt_plant_failed"));
		const planted = sql.billingAccounts.get("ws_plant");
		expect(planted?.status).toBe("past_due");
		// The plant is closed: the new row's entitlement plan is free, NOT the metadata studio.
		expect(planted?.plan_id).toBe("free");
		expect(planted?.plan_id).not.toBe("studio");
		// The metadata-claimed plan is recorded for AUDIT only, never as the entitlement.
		expect((planted?.metadata as Record<string, unknown>).dodo_named_plan_key).toBe("studio");

		// (2) ACTIVATE. A later signed but UNVALIDATED subscription.active (still no product,
		// no amount) flips status to active. Its grant is rejected (internalPlan undefined),
		// so upsertBillingAccount COALESCE-preserves the stored plan. With the plant closed,
		// the preserved plan is free — so studio NEVER becomes access-granting.
		const active = JSON.stringify({
			type: "subscription.active",
			data: {
				id: "sub_ws_plant",
				subscription_id: "sub_ws_plant",
				customer_id: "cus_ws_plant",
				current_period_end: "2026-07-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_plant", plan_key: "studio" },
			},
		});
		await service.processWebhook(active, signedHeaders(active, "evt_plant_active"));
		const activated = sql.billingAccounts.get("ws_plant");
		expect(activated?.status).toBe("active");
		// THE EXPLOIT IS CLOSED: no free Studio via two signed events.
		expect(activated?.plan_id).toBe("free");
		expect(activated?.plan_id).not.toBe("studio");
		expect((activated?.metadata as Record<string, unknown>).dodo_subscription_plan_grant_rejected).toBeDefined();
	});

	test("REGRESSION: a validated payment.succeeded UPGRADES an existing FREE row (created at a non-granting status)", async () => {
		const sql = new FakeDodoSqlClient();
		// No configured products for the failure event → the only signal is forge-able
		// metadata, so the failure lands a non-granting (past_due, free) row — exactly the
		// real-world shape that the round-6 fix accidentally trapped at free after paying.
		const unconfigured = createWebhookService(sql, {});

		// (1) A signed subscription.failed lands an EXISTING row at past_due with plan_id=free
		// (status-only insert default; no validated grant, no plant).
		const failed = JSON.stringify({
			type: "subscription.failed",
			data: {
				id: "sub_ws_upgrade",
				subscription_id: "sub_ws_upgrade",
				customer_id: "cus_ws_upgrade",
				metadata: { workspace_id: "ws_upgrade", plan_key: "pro" },
			},
		});
		await unconfigured.processWebhook(failed, signedHeaders(failed, "evt_upgrade_failed"));
		const seeded = sql.billingAccounts.get("ws_upgrade");
		expect(seeded?.status).toBe("past_due");
		expect(seeded?.plan_id).toBe("free");

		// (2) The customer PAYS. A signed payment.succeeded with a TRUSTED product id
		// (prod_pro_monthly) validates via validatePaidGrant. The validated planId must now
		// UPGRADE the existing free row to pro — the round-6 regression left it stuck free.
		const paid = createWebhookService(sql);
		const success = JSON.stringify({
			type: "payment.succeeded",
			data: {
				id: "pay_ws_upgrade",
				payment_id: "pay_ws_upgrade",
				subscription_id: "sub_ws_upgrade",
				customer_id: "cus_ws_upgrade",
				product_id: "prod_pro_monthly",
				currency: "USD",
				total_amount: 1900,
				current_period_end: "2026-08-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_upgrade", plan_key: "pro" },
			},
		});
		await paid.processWebhook(success, signedHeaders(success, "evt_upgrade_paid"));
		const upgraded = sql.billingAccounts.get("ws_upgrade");
		expect(upgraded?.status).toBe("active");
		// The validated grant upgrades the existing free row to the paid plan.
		expect(upgraded?.plan_id).toBe("pro");
		expect(upgraded?.plan_id).not.toBe("free");
	});

	test("subscription.on_hold(plan_key=studio) does NOT plant a paid plan on a fresh workspace", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, {});
		const onHold = JSON.stringify({
			type: "subscription.on_hold",
			data: {
				id: "sub_ws_hold",
				subscription_id: "sub_ws_hold",
				customer_id: "cus_ws_hold",
				metadata: { workspace_id: "ws_hold", plan_key: "studio" },
			},
		});
		await service.processWebhook(onHold, signedHeaders(onHold, "evt_hold"));
		const account = sql.billingAccounts.get("ws_hold");
		expect(account?.status).toBe("past_due");
		expect(account?.plan_id).toBe("free");
		expect(account?.plan_id).not.toBe("studio");
		expect((account?.metadata as Record<string, unknown>).dodo_named_plan_key).toBe("studio");
	});

	test("subscription.failed on an EXISTING paid workspace preserves the validated plan (status-only)", async () => {
		const sql = new FakeDodoSqlClient();
		// Seed a genuinely-paying Pro workspace via the trusted-product path.
		const paid = createWebhookService(sql);
		const seed = JSON.stringify(subscriptionEvent("evt_fail_seed", "subscription.active", "ws_paid_fail", "pro"));
		await paid.processWebhook(seed, signedHeaders(seed, "evt_fail_seed"));
		expect(sql.billingAccounts.get("ws_paid_fail")?.plan_id).toBe("pro");

		// A subscription.failed carrying a forged metadata.plan_key=studio must NOT escalate
		// the existing plan — it writes status only, preserving the stored validated plan.
		const service = createWebhookService(sql, {});
		const failed = JSON.stringify({
			type: "subscription.failed",
			data: {
				id: "sub_ws_paid_fail",
				subscription_id: "sub_ws_paid_fail",
				customer_id: "cus_ws_paid_fail",
				metadata: { workspace_id: "ws_paid_fail", plan_key: "studio" },
			},
		});
		await service.processWebhook(failed, signedHeaders(failed, "evt_paid_fail"));
		const account = sql.billingAccounts.get("ws_paid_fail");
		expect(account?.status).toBe("past_due");
		expect(account?.plan_id).toBe("pro"); // preserved validated plan — not escalated to studio
		expect(account?.plan_id).not.toBe("studio");
	});

	test("subscription.active with a TRUSTED studio product DOES grant studio", async () => {
		const sql = new FakeDodoSqlClient();
		// Default service has the standard product map → prod_studio_monthly is trusted.
		const service = createWebhookService(sql);
		const event = JSON.stringify({
			type: "subscription.active",
			data: {
				id: "sub_ws_studio_ok",
				subscription_id: "sub_ws_studio_ok",
				customer_id: "cus_ws_studio_ok",
				product_id: "prod_studio_monthly",
				current_period_end: "2026-07-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_studio_ok", plan_key: "studio" },
			},
		});
		await service.processWebhook(event, signedHeaders(event, "evt_studio_ok"));

		const account = sql.billingAccounts.get("ws_studio_ok");
		expect(account?.plan_id).toBe("studio");
		expect(account?.status).toBe("active");
		expect((account?.metadata as Record<string, unknown>).dodo_subscription_plan_grant_rejected).toBeUndefined();
	});

	test("an active/renewed subscription event CLEARS a stale dunning grace and keeps the paid plan", async () => {
		const sql = new FakeDodoSqlClient();
		const now = new Date("2026-06-10T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);

		// Seed a paying Pro workspace.
		const seed = JSON.stringify(subscriptionEvent("evt_sub_recover_seed", "subscription.active", "ws_sub_recover", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_sub_recover_seed", now));
		// Stamp a STALE (already-past) dunning grace, as a prior payment.failed would have.
		const seedAccount = sql.billingAccounts.get("ws_sub_recover")!;
		seedAccount.metadata = {
			...(seedAccount.metadata as Record<string, unknown>),
			dunning_grace_until: "2026-06-05T00:00:00.000Z",
			dunning_failed_at: "2026-06-02T00:00:00.000Z",
			dunning_expired: true,
		};

		// A subscription.renewed (NOT a payment.succeeded) arrives with a trusted product,
		// re-establishing the live paid subscription. It must clear the stale dunning so
		// the access-time gate does not downgrade the now-active account.
		const renewal = JSON.stringify({
			type: "subscription.renewed",
			data: {
				id: "sub_ws_sub_recover",
				subscription_id: "sub_ws_sub_recover",
				customer_id: "cus_ws_sub_recover",
				product_id: "prod_pro_monthly",
				current_period_end: "2026-08-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_sub_recover", plan_key: "pro" },
			},
		});
		await service.processWebhook(renewal, signedHeaders(renewal, "evt_sub_recover_renew", now));

		const account = sql.billingAccounts.get("ws_sub_recover");
		expect(account?.plan_id).toBe("pro");
		expect(account?.status).toBe("active");
		const metadata = account?.metadata as Record<string, unknown>;
		// Dunning fully cleared → isDunningGraceExpired(metadata) is false → no downgrade.
		expect(metadata.dunning_grace_until).toBeNull();
		expect(metadata.dunning_failed_at).toBeNull();
		expect(metadata.dunning_expired).toBe(false);
		expect(isDunningGraceExpired(metadata, now)).toBe(false);
	});

	test("an UNRELATED/unvalidated subscription.updated does NOT clear dunning grace (delinquent account still downgrades at the deadline)", async () => {
		const sql = new FakeDodoSqlClient();
		const now = new Date("2026-06-10T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);

		// Seed a paying Pro workspace, then stamp a STILL-FAILING dunning grace whose
		// deadline is in the FUTURE (account currently held in grace, card still failing).
		const seed = JSON.stringify(subscriptionEvent("evt_sub_dun_keep_seed", "subscription.active", "ws_sub_dun_keep", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_sub_dun_keep_seed", now));
		const seedAccount = sql.billingAccounts.get("ws_sub_dun_keep")!;
		seedAccount.metadata = {
			...(seedAccount.metadata as Record<string, unknown>),
			dunning_grace_until: "2026-06-12T00:00:00.000Z",
			dunning_failed_at: "2026-06-09T00:00:00.000Z",
			dunning_expired: false,
		};

		// A non-recovery `subscription.updated` arrives: metadata-only change, NO recognized
		// product and NO amount → the paid-plan grant is REJECTED (internalPlan undefined).
		// This must NOT null the grace deadline; otherwise the access-time gate could never
		// downgrade the still-delinquent account.
		const update = JSON.stringify({
			type: "subscription.updated",
			data: {
				id: "sub_ws_sub_dun_keep",
				subscription_id: "sub_ws_sub_dun_keep",
				customer_id: "cus_ws_sub_dun_keep",
				// no product_id, no amount/currency → unvalidated paid grant
				metadata: { workspace_id: "ws_sub_dun_keep", plan_key: "pro" },
			},
		});
		await service.processWebhook(update, signedHeaders(update, "evt_sub_dun_keep_update", now));

		const account = sql.billingAccounts.get("ws_sub_dun_keep");
		const metadata = account?.metadata as Record<string, unknown>;
		// Grace metadata is left intact (NOT cleared) and the rejected grant is audited.
		expect(metadata.dunning_grace_until).toBe("2026-06-12T00:00:00.000Z");
		expect(metadata.dunning_failed_at).toBe("2026-06-09T00:00:00.000Z");
		expect(metadata.dodo_subscription_plan_grant_rejected).toBeTruthy();
		// The plan_id is preserved (status-only sync never downgrades a payer)...
		expect(account?.plan_id).toBe("pro");
		// ...and CRUCIALLY the access-time gate still downgrades once the deadline passes.
		expect(isDunningGraceExpired(metadata, new Date("2026-06-13T00:00:00.000Z"))).toBe(true);
	});

	test("a validated active subscription with NO current paid period does NOT clear dunning grace", async () => {
		const sql = new FakeDodoSqlClient();
		const now = new Date("2026-06-10T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);

		const seed = JSON.stringify(subscriptionEvent("evt_sub_noperiod_seed", "subscription.active", "ws_sub_noperiod", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_sub_noperiod_seed", now));
		const seedAccount = sql.billingAccounts.get("ws_sub_noperiod")!;
		seedAccount.metadata = {
			...(seedAccount.metadata as Record<string, unknown>),
			dunning_grace_until: "2026-06-12T00:00:00.000Z",
			dunning_failed_at: "2026-06-09T00:00:00.000Z",
			dunning_expired: false,
		};

		// Trusted product (grant validated) but NO current_period_end (and no future
		// period) → does not establish a current paid term, so dunning must NOT clear.
		const update = JSON.stringify({
			type: "subscription.updated",
			data: {
				id: "sub_ws_sub_noperiod",
				subscription_id: "sub_ws_sub_noperiod",
				customer_id: "cus_ws_sub_noperiod",
				product_id: "prod_pro_monthly",
				metadata: { workspace_id: "ws_sub_noperiod", plan_key: "pro" },
			},
		});
		await service.processWebhook(update, signedHeaders(update, "evt_sub_noperiod_update", now));

		const account = sql.billingAccounts.get("ws_sub_noperiod");
		const metadata = account?.metadata as Record<string, unknown>;
		expect(metadata.dunning_grace_until).toBe("2026-06-12T00:00:00.000Z");
		expect(metadata.dunning_failed_at).toBe("2026-06-09T00:00:00.000Z");
		expect(isDunningGraceExpired(metadata, new Date("2026-06-13T00:00:00.000Z"))).toBe(true);
	});

	test("payment.failed on an active account opens a dunning grace window and PRESERVES access", async () => {
		const sql = new FakeDodoSqlClient();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);
		const seed = JSON.stringify(subscriptionEvent("evt_seed", "subscription.created", "ws_failed", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_seed", now));
		const event = JSON.stringify({
			id: "evt_payment_failed",
			type: "payment.failed",
			data: { subscription_id: "sub_ws_failed", customer_id: "cus_ws_failed" },
		});

		await service.processWebhook(event, signedHeaders(event, "evt_payment_failed", now));

		// A renewal-failure must NOT instantly drop to free — access is held through the
		// grace deadline so the card can be retried. Status stays active; grace recorded.
		const account = sql.billingAccounts.get("ws_failed");
		expect(account?.status).toBe("active");
		expect(account?.plan_id).toBe("pro");
		const graceUntil = (account?.metadata as Record<string, unknown>).dunning_grace_until;
		expect(typeof graceUntil).toBe("string");
		expect(Date.parse(String(graceUntil))).toBeGreaterThan(now.getTime());
		expect((account?.metadata as Record<string, unknown>).dunning_expired).toBe(false);
	});

	test("payment.failure that lands after the grace deadline lapses revokes access (past_due)", async () => {
		const sql = new FakeDodoSqlClient();
		// First failure opens the grace window at t0.
		let now = new Date("2026-06-02T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);
		const seed = JSON.stringify(subscriptionEvent("evt_dun_seed", "subscription.created", "ws_dun", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_dun_seed", now));

		const fail1 = JSON.stringify({ type: "payment.failed", data: { subscription_id: "sub_ws_dun", customer_id: "cus_ws_dun" } });
		await service.processWebhook(fail1, signedHeaders(fail1, "evt_dun_fail_1", now));
		expect(sql.billingAccounts.get("ws_dun")?.status).toBe("active"); // still in grace

		// A later failure lands AFTER the 3-day grace deadline → dunning exhausted.
		now = new Date("2026-06-10T00:00:00.000Z");
		const fail2 = JSON.stringify({ type: "payment.failed", data: { subscription_id: "sub_ws_dun", customer_id: "cus_ws_dun" } });
		await service.processWebhook(fail2, signedHeaders(fail2, "evt_dun_fail_2", now));

		const account = sql.billingAccounts.get("ws_dun");
		expect(account?.status).toBe("past_due");
		expect((account?.metadata as Record<string, unknown>).dunning_expired).toBe(true);
	});

	test("a successful renewal during grace clears the dunning state and keeps access", async () => {
		const sql = new FakeDodoSqlClient();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);
		const seed = JSON.stringify(subscriptionEvent("evt_recover_seed", "subscription.active", "ws_recover", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_recover_seed", now));
		const fail = JSON.stringify({ type: "payment.failed", data: { subscription_id: "sub_ws_recover", customer_id: "cus_ws_recover" } });
		await service.processWebhook(fail, signedHeaders(fail, "evt_recover_fail", now));
		expect((sql.billingAccounts.get("ws_recover")?.metadata as Record<string, unknown>).dunning_grace_until).toBeDefined();

		// Card retry succeeds — a valid renewal payment for the same plan.
		const ok = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_recover", currency: "USD", total_amount: 1900, current_period_end: "2026-08-01T00:00:00.000Z", metadata: { workspace_id: "ws_recover", plan_key: "pro" } },
		});
		await service.processWebhook(ok, signedHeaders(ok, "evt_recover_ok", now));

		const account = sql.billingAccounts.get("ws_recover");
		expect(account?.status).toBe("active");
		expect((account?.metadata as Record<string, unknown>).dunning_grace_until).toBeNull();
	});

	test("payment.succeeded upserts a billing account when it arrives before subscription sync", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_out_of_order",
				customer_email: "buyer@example.com",
				// A trustworthy grant: USD + an amount clearing the Pro price floor.
				currency: "USD",
				total_amount: 1900,
				metadata: {
					workspace_id: "ws_out_of_order_payment",
					plan_key: "pro",
				},
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_payment_first"));

		expect(sql.billingAccounts.get("ws_out_of_order_payment")).toEqual(expect.objectContaining({
			plan_id: "pro",
			status: "active",
			billing_email: "buyer@example.com",
			metadata: expect.objectContaining({
				dodo_payment_id: "pay_out_of_order",
				receiptQueued: true,
			}),
		}));
	});

	// P1-2 (round-2): payment.succeeded + invoice.paid for the SAME charge must yield ONE
	// in-app receipt. The receipt's idempotencyKey is `dodo-receipt:<paymentRef>`, and the
	// in-app row dedupe key is derived from it (`...:inapp`). So both deliveries for the same
	// payment_id MUST resolve the IDENTICAL idempotencyKey (=> identical inAppDedupeKey =>
	// the second in-app row is suppressed in notify()), while two DISTINCT charges resolve
	// DISTINCT keys (=> two rows).
	test("payment.succeeded + invoice.paid for the SAME payment resolve ONE receipt dedupe key; distinct charges resolve TWO", async () => {
		const sql = new FakeDodoSqlClient();
		const receiptKeys: Array<string | undefined> = [];
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: STANDARD_PRODUCT_IDS },
			},
			sendPaymentReceipt: (async (input: { idempotencyKey?: string }) => { receiptKeys.push(input.idempotencyKey); }) as never,
		});

		const succeeded = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_dupe", customer_email: "b@e.com", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_dupe", plan_key: "pro" } },
		});
		const invoice = JSON.stringify({
			type: "invoice.paid",
			data: { payment_id: "pay_dupe", customer_email: "b@e.com", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_dupe", plan_key: "pro" } },
		});
		const distinct = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_other", customer_email: "b@e.com", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_dupe", plan_key: "pro" } },
		});

		await service.processWebhook(succeeded, signedHeaders(succeeded, "evt_succeeded"));
		await service.processWebhook(invoice, signedHeaders(invoice, "evt_invoice"));
		await service.processWebhook(distinct, signedHeaders(distinct, "evt_distinct"));

		// succeeded + invoice for the SAME payment → SAME key (one in-app row after dedupe).
		expect(receiptKeys[0]).toBe("dodo-receipt:pay_dupe");
		expect(receiptKeys[1]).toBe("dodo-receipt:pay_dupe");
		// A genuinely distinct charge → a DIFFERENT key (its own in-app row).
		expect(receiptKeys[2]).toBe("dodo-receipt:pay_other");
	});

	// F1 (round-3): the shape the round-2 test MISSED — payment.succeeded carries
	// payment_id (+invoice_id) while the sibling invoice.paid carries ONLY invoice_id (NO
	// payment_id). The EMAIL idempotencyKey (payment_id-first) then DIVERGES across the two
	// deliveries, but the IN-APP dedupe must still collapse them: the in-app PRIMARY key is
	// invoice-first (both deliveries carry invoice_id → converge), and every candidate ref
	// is forwarded so a sibling deriving a different primary still suppresses. We assert the
	// in-app key wiring the dodo service emits for this exact shape.
	test("invoice-only sibling: in-app receipt key converges on invoice_id; candidates cover both ids", async () => {
		const sql = new FakeDodoSqlClient();
		const receiptInputs: Array<{ idempotencyKey?: string; inAppIdempotencyKey?: string; idempotencyKeyCandidates?: string[] }> = [];
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: STANDARD_PRODUCT_IDS },
			},
			sendPaymentReceipt: (async (input: { idempotencyKey?: string; inAppIdempotencyKey?: string; idempotencyKeyCandidates?: string[] }) => {
				receiptInputs.push({ idempotencyKey: input.idempotencyKey, inAppIdempotencyKey: input.inAppIdempotencyKey, idempotencyKeyCandidates: input.idempotencyKeyCandidates });
			}) as never,
		});

		// payment.succeeded carries BOTH payment_id and invoice_id.
		const succeeded = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_X", invoice_id: "inv_X", customer_email: "b@e.com", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_io", plan_key: "pro" } },
		});
		// invoice.paid carries ONLY invoice_id (no payment_id) — the missed shape.
		const invoice = JSON.stringify({
			type: "invoice.paid",
			data: { invoice_id: "inv_X", customer_email: "b@e.com", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_io", plan_key: "pro" } },
		});
		// A genuinely distinct charge (different invoice_id AND payment_id).
		const distinct = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_Y", invoice_id: "inv_Y", customer_email: "b@e.com", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_io", plan_key: "pro" } },
		});

		await service.processWebhook(succeeded, signedHeaders(succeeded, "evt_io_succeeded"));
		await service.processWebhook(invoice, signedHeaders(invoice, "evt_io_invoice"));
		await service.processWebhook(distinct, signedHeaders(distinct, "evt_io_distinct"));

		expect(receiptInputs).toHaveLength(3);
		const [succeededInput, invoiceInput, distinctInput] = receiptInputs as [typeof receiptInputs[number], typeof receiptInputs[number], typeof receiptInputs[number]];
		// EMAIL key stays payment_id-first (unchanged behavior): succeeded=pay_X, invoice=inv_X.
		expect(succeededInput.idempotencyKey).toBe("dodo-receipt:pay_X");
		expect(invoiceInput.idempotencyKey).toBe("dodo-receipt:inv_X");
		// IN-APP key converges on invoice_id for BOTH deliveries of the SAME charge → ONE row.
		expect(succeededInput.inAppIdempotencyKey).toBe("dodo-receipt:inv_X");
		expect(invoiceInput.inAppIdempotencyKey).toBe("dodo-receipt:inv_X");
		// Candidate refs cover every identifier of the charge (symmetric backstop).
		expect(succeededInput.idempotencyKeyCandidates).toContain("dodo-receipt:pay_X");
		expect(succeededInput.idempotencyKeyCandidates).toContain("dodo-receipt:inv_X");
		expect(invoiceInput.idempotencyKeyCandidates).toContain("dodo-receipt:inv_X");
		// The distinct charge derives its OWN in-app key (different invoice_id) → its own row.
		expect(distinctInput.inAppIdempotencyKey).toBe("dodo-receipt:inv_Y");
	});

	test("payment.chargeback.created flags workspace chargeback_pending and records dispute", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const event = JSON.stringify({
			id: "evt_chargeback",
			type: "payment.chargeback.created",
			data: {
				dispute_id: "dp_123",
				reason: "fraud",
				status: "opened",
				metadata: { workspace_id: "ws_chargeback" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_chargeback"));

		expect(sql.workspaces.get("ws_chargeback")?.chargeback_pending).toBe(true);
		expect(sql.disputes.get("dp_123")).toEqual(expect.objectContaining({
			workspace_id: "ws_chargeback",
			reason: "fraud",
			status: "opened",
		}));
	});

	test("dispute.opened resolves workspace from the stored Dodo payment id", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const paymentEvent = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_disputed",
				currency: "USD",
				total_amount: 1900,
				metadata: { workspace_id: "ws_disputed", plan_key: "pro" },
			},
		});
		await service.processWebhook(paymentEvent, signedHeaders(paymentEvent, "evt_payment_disputed"));
		const disputeEvent = JSON.stringify({
			type: "dispute.opened",
			data: {
				id: "dp_by_payment",
				payment_id: "pay_disputed",
				reason: "fraud",
				status: "opened",
			},
		});

		await service.processWebhook(disputeEvent, signedHeaders(disputeEvent, "evt_dispute_by_payment"));

		expect(sql.workspaces.get("ws_disputed")?.chargeback_pending).toBe(true);
		expect(sql.billingAccounts.get("ws_disputed")).toEqual(expect.objectContaining({
			status: "cancelled",
			metadata: expect.objectContaining({
				dodo_payment_id: "pay_disputed",
				chargeback_pending: true,
			}),
		}));
		expect(sql.disputes.get("dp_by_payment")).toEqual(expect.objectContaining({
			workspace_id: "ws_disputed",
			reason: "fraud",
		}));
	});

	// ── P1 (money-critical): amount/currency/product validation on payment.succeeded ──

	test("payment.succeeded with plan_key=studio + ZERO amount does NOT grant studio", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_free_studio",
				currency: "USD",
				total_amount: 0,
				metadata: { workspace_id: "ws_free_studio", plan_key: "studio" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_free_studio"));

		// No paid entitlement granted from a zero-amount forged event.
		expect(sql.billingAccounts.get("ws_free_studio")).toBeUndefined();
	});

	test("payment.succeeded with a non-USD currency does NOT grant a paid plan", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_thb",
				currency: "THB",
				total_amount: 4900,
				metadata: { workspace_id: "ws_thb", plan_key: "studio" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_thb"));

		expect(sql.billingAccounts.get("ws_thb")).toBeUndefined();
	});

	test("payment.succeeded grants studio when the event carries a KNOWN product_id (price owned by Dodo)", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, { studio_monthly: "prod_studio_monthly" });
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_known_product",
				product_id: "prod_studio_monthly",
				// No amount/currency needed: a configured product id is trusted.
				metadata: { workspace_id: "ws_known_product", plan_key: "studio" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_known_product"));

		expect(sql.billingAccounts.get("ws_known_product")).toEqual(expect.objectContaining({
			plan_id: "studio",
			status: "active",
		}));
	});

	// ── P1 (money-critical): the GRANT must use the VALIDATED plan key, never metadata ──

	test("payment.succeeded with cart product=starter + metadata.plan_key=studio grants STARTER (validated key), not studio", async () => {
		const sql = new FakeDodoSqlClient();
		// Only starter is a configured product. The cart carries the trusted starter
		// product; metadata claims studio. The grant MUST follow the validated product
		// (starter→creator), never the forge-able metadata escalation. But a metadata
		// plan that DISAGREES with the product is a mismatch → rejected. So a clean
		// "validated key wins" case uses metadata that AGREES (or is absent).
		const service = createWebhookService(sql, { starter_monthly: "prod_starter_monthly" });
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_cart_starter",
				product_cart: [{ product_id: "prod_starter_monthly", quantity: 1 }],
				// metadata names studio but no top-level product; the cart product is starter.
				// With mismatch-rejection this is REJECTED rather than silently escalated.
				metadata: { workspace_id: "ws_cart_studio", plan_key: "studio" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_cart_starter"));

		// The escalation attempt is rejected (no grant): a brand-new workspace gets no
		// paid billing row at all (the rejection metadata write is a no-op without a row),
		// so it is certainly NOT granted studio.
		const account = sql.billingAccounts.get("ws_cart_studio");
		expect(account?.status).not.toBe("active");
		expect(account?.plan_id).not.toBe("studio");
	});

	test("payment.succeeded with cart product=starter (metadata agrees) grants STARTER, never studio", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, { starter_monthly: "prod_starter_monthly" });
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_cart_starter_ok",
				product_cart: [{ product_id: "prod_starter_monthly", quantity: 1 }],
				metadata: { workspace_id: "ws_cart_starter", plan_key: "starter" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_cart_starter_ok"));

		// starter → creator (DODO_TO_INTERNAL_PLAN), granted active — never studio.
		expect(sql.billingAccounts.get("ws_cart_starter")).toEqual(expect.objectContaining({
			plan_id: "creator",
			status: "active",
		}));
	});

	test("payment.succeeded with top-level product=starter but metadata.plan_key=studio is REJECTED (mismatch)", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, { starter_monthly: "prod_starter_monthly", studio_monthly: "prod_studio_monthly" });
		// Seed an existing FREE account so the rejection's metadata audit write lands on
		// a row (and we can assert the account was NOT escalated to studio).
		const seed = JSON.stringify(subscriptionEventWithoutBodyId("subscription.active", "ws_mismatch", "starter"));
		const seedConfigured = createWebhookService(sql, { starter_monthly: "prod_starter_monthly" });
		await seedConfigured.processWebhook(seed, signedHeaders(seed, "evt_mismatch_seed"));
		expect(sql.billingAccounts.get("ws_mismatch")?.plan_id).toBe("creator");

		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_mismatch",
				product_id: "prod_starter_monthly",
				metadata: { workspace_id: "ws_mismatch", plan_key: "studio" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_mismatch"));

		// A product/metadata plan mismatch grants NOTHING (audit-logged rejection); the
		// pre-existing starter plan is left untouched — certainly NOT escalated to studio.
		const account = sql.billingAccounts.get("ws_mismatch");
		expect(account?.plan_id).toBe("creator");
		expect(account?.plan_id).not.toBe("studio");
		expect((account?.metadata as Record<string, unknown> | undefined)?.dodo_payment_grant_rejected).toContain("product_metadata_plan_mismatch");
	});

	// ── P1: stale payment.succeeded must not reactivate a cancelled subscription ──

	test("a stale payment.succeeded does NOT reactivate a terminally-cancelled account", async () => {
		const sql = new FakeDodoSqlClient();
		// now() is after the seeded period end so the subscription is terminally expired.
		const now = new Date("2026-08-01T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);
		const seed = JSON.stringify(subscriptionEvent("evt_stale_seed", "subscription.active", "ws_stale_pay", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_stale_seed", now));
		const expired = JSON.stringify(subscriptionEvent("evt_stale_expired", "subscription.expired", "ws_stale_pay", "pro"));
		await service.processWebhook(expired, signedHeaders(expired, "evt_stale_expired", now));
		expect(sql.billingAccounts.get("ws_stale_pay")?.status).toBe("cancelled");

		// A stale, valid-looking payment success lands with a period end already in the
		// PAST (2026-07-01 < now) and no active linked subscription → must NOT reactivate.
		const stalePayment = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_stale",
				currency: "USD",
				total_amount: 1900,
				current_period_end: "2026-07-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_stale_pay", plan_key: "pro" },
			},
		});
		await service.processWebhook(stalePayment, signedHeaders(stalePayment, "evt_stale_pay", now));

		expect(sql.billingAccounts.get("ws_stale_pay")?.status).toBe("cancelled");
	});

	test("a payment.succeeded with a CURRENT future period DOES reactivate a cancelled account", async () => {
		const sql = new FakeDodoSqlClient();
		const now = new Date("2026-08-01T00:00:00.000Z");
		const service = createWebhookService(sql, STANDARD_PRODUCT_IDS, () => now);
		const seed = JSON.stringify(subscriptionEvent("evt_reactivate_seed", "subscription.active", "ws_reactivate", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_reactivate_seed", now));
		const expired = JSON.stringify(subscriptionEvent("evt_reactivate_expired", "subscription.expired", "ws_reactivate", "pro"));
		await service.processWebhook(expired, signedHeaders(expired, "evt_reactivate_expired", now));
		expect(sql.billingAccounts.get("ws_reactivate")?.status).toBe("cancelled");

		// A genuine new payment whose period end is in the FUTURE → reactivation allowed.
		const renewal = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_renewal",
				currency: "USD",
				total_amount: 1900,
				current_period_end: "2026-09-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_reactivate", plan_key: "pro" },
			},
		});
		await service.processWebhook(renewal, signedHeaders(renewal, "evt_reactivate_pay", now));

		expect(sql.billingAccounts.get("ws_reactivate")?.status).toBe("active");
	});

	// ── P1: a full refund revokes the paid entitlement ──

	test("a full refund of the paid charge revokes the workspace's paid entitlement", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		// Pay for Pro (records the +1900 payment row + grants the plan).
		const payment = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_refunded", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_refunded", plan_key: "pro" } },
		});
		await service.processWebhook(payment, signedHeaders(payment, "evt_refund_payment"));
		expect(sql.billingAccounts.get("ws_refunded")?.status).toBe("active");

		// A FULL refund (same amount) of that charge.
		const refund = JSON.stringify({
			type: "payment.refunded",
			data: { refund_id: "ref_full", payment_id: "pay_refunded", currency: "USD", amount: 1900, metadata: { workspace_id: "ws_refunded" } },
		});
		await service.processWebhook(refund, signedHeaders(refund, "evt_refund_full"));

		expect(sql.billingAccounts.get("ws_refunded")?.status).toBe("cancelled");
		expect((sql.billingAccounts.get("ws_refunded")?.metadata as Record<string, unknown>).refunded_full).toBe(true);
	});

	test("a PARTIAL refund leaves the paid entitlement intact", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql);
		const payment = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_partial", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_partial", plan_key: "pro" } },
		});
		await service.processWebhook(payment, signedHeaders(payment, "evt_partial_payment"));

		const refund = JSON.stringify({
			type: "payment.refunded",
			data: { refund_id: "ref_partial", payment_id: "pay_partial", currency: "USD", amount: 500, metadata: { workspace_id: "ws_partial" } },
		});
		await service.processWebhook(refund, signedHeaders(refund, "evt_refund_partial"));

		// Partial refund (500 of 1900) does not clear the gross paid → plan stays active.
		expect(sql.billingAccounts.get("ws_partial")?.status).toBe("active");
	});

	// ── P1: subscription.plan_changed proration / effective semantics ──

	test("subscription.plan_changed applies an immediate PAID upgrade", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, { studio_monthly: "prod_studio_monthly" });
		const seed = JSON.stringify(subscriptionEvent("evt_pc_seed", "subscription.active", "ws_pc_up", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_pc_seed"));

		const change = JSON.stringify({
			type: "subscription.plan_changed",
			data: {
				id: "sub_ws_pc_up", subscription_id: "sub_ws_pc_up", customer_id: "cus_ws_pc_up",
				product_id: "prod_studio_monthly",
				proration_billing_mode: "prorated_immediately",
				next_billing_date: "2026-08-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_pc_up", plan_key: "studio" },
			},
		});
		await service.processWebhook(change, signedHeaders(change, "evt_pc_up"));

		expect(sql.billingAccounts.get("ws_pc_up")).toEqual(expect.objectContaining({ plan_id: "studio", status: "active" }));
	});

	test("subscription.plan_changed with do_not_bill stores a PENDING plan and keeps the live plan", async () => {
		const sql = new FakeDodoSqlClient();
		const service = createWebhookService(sql, { starter_monthly: "prod_starter_monthly", pro_monthly: "prod_pro_monthly" });
		const seed = JSON.stringify(subscriptionEvent("evt_pc_seed2", "subscription.active", "ws_pc_down", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_pc_seed2"));
		expect(sql.billingAccounts.get("ws_pc_down")?.plan_id).toBe("pro");

		// A scheduled downgrade to starter effective at next billing, NOT billed now.
		const change = JSON.stringify({
			type: "subscription.plan_changed",
			data: {
				id: "sub_ws_pc_down", subscription_id: "sub_ws_pc_down", customer_id: "cus_ws_pc_down",
				product_id: "prod_starter_monthly",
				proration_billing_mode: "do_not_bill",
				effective_date: "2026-08-01T00:00:00.000Z",
				next_billing_date: "2026-08-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_pc_down", plan_key: "starter" },
			},
		});
		await service.processWebhook(change, signedHeaders(change, "evt_pc_down"));

		const account = sql.billingAccounts.get("ws_pc_down");
		// Live plan is UNCHANGED (still pro); the downgrade is recorded as pending.
		expect(account?.plan_id).toBe("pro");
		expect(account?.status).toBe("active");
		expect((account?.metadata as Record<string, unknown>).pending_plan_id).toBe("creator");
		expect((account?.metadata as Record<string, unknown>).pending_plan_effective_at).toBe("2026-08-01T00:00:00.000Z");
	});

	test("subscription.plan_changed to studio with NO validated product/amount does NOT grant studio (held pending)", async () => {
		const sql = new FakeDodoSqlClient();
		// No configured products at all, so no trusted product can be matched. The event
		// is billed-now (default) and not future-scheduled, yet carries only a forge-able
		// metadata.plan_key=studio and no validated amount. The OLD code applied studio
		// immediately; the fix must HOLD it pending (never write the paid tier).
		const service = createWebhookService(sql, {});
		const seed = JSON.stringify(subscriptionEvent("evt_pc_unv_seed", "subscription.active", "ws_pc_unv", "creator"));
		// Seed a free/creator baseline (metadata plan_key=creator is not a paid escalation here).
		await service.processWebhook(seed, signedHeaders(seed, "evt_pc_unv_seed"));

		const change = JSON.stringify({
			type: "subscription.plan_changed",
			data: {
				id: "sub_ws_pc_unv", subscription_id: "sub_ws_pc_unv", customer_id: "cus_ws_pc_unv",
				// No product_id, no currency, no amount — only forge-able metadata.
				proration_billing_mode: "prorated_immediately",
				next_billing_date: "2026-08-01T00:00:00.000Z",
				metadata: { workspace_id: "ws_pc_unv", plan_key: "studio" },
			},
		});
		await service.processWebhook(change, signedHeaders(change, "evt_pc_unv"));

		const account = sql.billingAccounts.get("ws_pc_unv");
		// Live plan is NOT studio — the unvalidated immediate change was held pending.
		expect(account?.plan_id).not.toBe("studio");
		expect((account?.metadata as Record<string, unknown>).pending_plan_id).toBe("studio");
		expect((account?.metadata as Record<string, unknown>).plan_change_grant_rejected).toBeDefined();
	});

	test("public Dodo webhook path bypasses production auth and origin guards", async () => {
		const snapshot = {
			apiAuthRequired: serverConfig.apiAuthRequired,
			apiOriginGuardEnabled: serverConfig.apiOriginGuardEnabled,
		};
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				apiAuthRequired: true,
				apiOriginGuardEnabled: true,
			});
			const app = new Hono();
			app.use("/api/*", originGuard());
			app.use("/api/*", protectedApiAuthGuard());
			app.route("/api/billing", createDodoWebhookRouter({
				service: {
					processWebhook: async () => ({ processed: true, eventId: "evt_public", type: "payment.succeeded" }),
				} as DodoService,
			}));
			app.route("/api/billing", createDodoBillingRouter({
				authMiddleware: async (c) => c.json({ error: "Unauthorized" }, 401),
				workspaceAccessStore: null,
			}));

			const res = await app.request("/api/billing/dodo/webhook", { method: "POST", body: "{}" });

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual(expect.objectContaining({ event_id: "evt_public" }));
		} finally {
			Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
		}
	});

	test("checkout-session route validates workspace access and returns Dodo checkout details", async () => {
		const calls: unknown[] = [];
		const app = new Hono();
		app.route("/api/billing", createDodoBillingRouter({
			authMiddleware: async (c, next) => {
				c.set("user" as never, { userId: "user_1", email: "buyer@example.com", role: "editor" } as never);
				await next();
			},
			workspaceAccessStore: {
				requirePermission: async (workspaceId, userId, permission) => {
					calls.push({ workspaceId, userId, permission });
					return {} as never;
				},
			},
			service: {
				createCheckoutSession: async (input: unknown) => {
					calls.push(input);
					return { checkout_url: "https://checkout.example/session", session_id: "chk_123" };
				},
			} as DodoService,
		}));

		const res = await app.request("/api/billing/ws_checkout/checkout-session", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ plan_key: "studio", billing_cycle: "yearly" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			checkout_url: "https://checkout.example/session",
			session_id: "chk_123",
		});
		expect(calls).toContainEqual({ workspaceId: "ws_checkout", userId: "user_1", permission: "update_workspace" });
		expect(calls).toContainEqual(expect.objectContaining({
			workspaceId: "ws_checkout",
			planKey: "studio",
			cycle: "yearly",
			customer: { email: "buyer@example.com" },
		}));
	});

	test("checkout creation attaches selected add-ons to the subscription cart item", async () => {
		const calls: unknown[] = [];
		const service = new DodoService({
			sqlClient: null,
			client: {
				checkoutSessions: {
					create: async (payload: unknown) => {
						calls.push(payload);
						return { checkout_url: "https://checkout.example/session", session_id: "chk_nested_addon" };
					},
				},
			} as DodoPayments,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: {
					...serverConfig.dodo,
					apiKey: "test-api-key",
					webhookSecret: WEBHOOK_SECRET,
					environment: "test_mode",
					productIds: {
						pro_monthly: "prod_pro_monthly",
						addon_byo_api: "addon_byo_api",
					},
				},
			},
		});

		const result = await service.createCheckoutSession({
			workspaceId: "ws_checkout_addon",
			planKey: "pro",
			cycle: "monthly",
			addons: ["byo_api"],
			customer: { email: "buyer@example.com" },
		});

		expect(result.session_id).toBe("chk_nested_addon");
		expect(calls[0]).toEqual(expect.objectContaining({
			product_cart: [{
				product_id: "prod_pro_monthly",
				quantity: 1,
				addons: [{ addon_id: "addon_byo_api", quantity: 1 }],
			}],
		}));
	});

	test("portal-session route returns Dodo customer portal URL", async () => {
		const app = new Hono();
		app.route("/api/billing", createDodoBillingRouter({
			authMiddleware: async (c, next) => {
				c.set("user" as never, { userId: "user_2", email: "owner@example.com", role: "admin" } as never);
				await next();
			},
			workspaceAccessStore: {
				requirePermission: async () => ({} as never),
			},
			service: {
				createPortalSession: async (workspaceId: string) => ({ portal_url: `https://portal.example/${workspaceId}` }),
			} as DodoService,
		}));

		const res = await app.request("/api/billing/ws_portal/portal-session", { method: "POST" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ portal_url: "https://portal.example/ws_portal" });
	});
});

// The standard Dodo product map for the published plans, used as the DEFAULT for the
// webhook service. A normal subscription/payment event carries one of these product
// ids, so the grant resolves via the TRUSTED-product path. Tests that specifically
// exercise the "no recognizable product" path pass an explicit (empty/partial) map.
const STANDARD_PRODUCT_IDS: Record<string, string> = {
	starter_monthly: "prod_starter_monthly",
	pro_monthly: "prod_pro_monthly",
	studio_monthly: "prod_studio_monthly",
	starter_yearly: "prod_starter_yearly",
	pro_yearly: "prod_pro_yearly",
	studio_yearly: "prod_studio_yearly",
};

function createWebhookService(sqlClient: FakeDodoSqlClient, productIds: Record<string, string> = STANDARD_PRODUCT_IDS, now?: () => Date): DodoService {
	return new DodoService({
		sqlClient,
		client: {} as DodoPayments,
		now,
		config: {
			...serverConfig,
			billingProvider: "dodo",
			dodo: {
				...serverConfig.dodo,
				apiKey: "test-api-key",
				webhookSecret: WEBHOOK_SECRET,
				environment: "test_mode",
				productIds,
			},
		},
	});
}

function subscriptionEvent(id: string, type: string, workspaceId: string, planKey = "pro") {
	return {
		id,
		type,
		data: {
			id: `sub_${workspaceId}`,
			subscription_id: `sub_${workspaceId}`,
			customer_id: `cus_${workspaceId}`,
			payment_method_id: `pm_${workspaceId}`,
			// A real subscription event carries the Dodo product id (price owned by Dodo),
			// which is the TRUSTED grant signal. The default product map below maps these,
			// so a normal subscription seed grants its plan via the trusted-product path
			// (not forge-able metadata).
			product_id: `prod_${planKey}_monthly`,
			current_period_end: "2026-07-01T00:00:00.000Z",
			metadata: {
				workspace_id: workspaceId,
				plan_key: planKey,
				billing_cycle: "monthly",
			},
		},
	};
}

function subscriptionEventWithoutBodyId(type: string, workspaceId: string, planKey = "pro") {
	return {
		type,
		data: {
			id: `sub_${workspaceId}`,
			subscription_id: `sub_${workspaceId}`,
			customer_id: `cus_${workspaceId}`,
			payment_method_id: `pm_${workspaceId}`,
			product_id: `prod_${planKey}_monthly`,
			previous_billing_date: "2026-06-01T00:00:00.000Z",
			next_billing_date: "2026-07-01T00:00:00.000Z",
			metadata: {
				workspace_id: workspaceId,
				plan_key: planKey,
				billing_cycle: "monthly",
			},
		},
	};
}

// `at` aligns the signed `webhook-timestamp` with the service clock so the
// replay-freshness guard sees a recent delivery. Tests that pin `now()` to a
// fixed Date should pass that same Date here; otherwise the real clock is used.
function signedHeaders(rawBody: string, id: string, at: Date | string = new Date()): Record<string, string> {
	const timestamp = typeof at === "string" ? at : String(Math.floor(at.getTime() / 1000));
	const signature = createHmac("sha256", WEBHOOK_SECRET)
		.update(`${id}.${timestamp}.${rawBody}`)
		.digest("base64");
	return {
		"content-type": "application/json",
		"webhook-id": id,
		"webhook-timestamp": timestamp,
		"webhook-signature": `v1,${signature}`,
	};
}

// ── P0 (money): add-on grant webhook write path ──────────────────────────────────
// Add-on purchases (AI credit packs / storage packs) that arrive on a trusted payment
// must be GRANTED (the buyer paid → they receive the credits/storage). Grants resolve
// ONLY from configured Dodo add-on PRODUCT IDS (never forge-able metadata) and are
// idempotent (a replayed webhook grants exactly once) to the correct workspace.
describe("Dodo webhook — add-on grant write path (P0)", () => {
	// Product-id catalog: a plan product (so the plan path is exercised too) plus add-on
	// product ids keyed the way config stores them (`addon_<catalog-id>`).
	const ADDON_PRODUCT_IDS: Record<string, string> = {
		studio_monthly: "prod_studio_monthly",
		"addon_credits-50": "prod_addon_credits50",
		"addon_credits-200": "prod_addon_credits200",
		"addon_storage-25gb": "prod_addon_storage25",
		"addon_byo_api": "prod_addon_byo", // underscore Dodo key → byo-api catalog id
	};

	function captureGrants() {
		const grants: Array<{ workspaceId: string; amount: number; creditClass: string; source: string; idempotencyKey?: string }> = [];
		const grantCredits = async (input: { workspaceId: string; amount: number; creditClass: string; source: string; idempotencyKey?: string }) => {
			// Model the credit store's idempotency: a repeated key returns the prior grant.
			const existing = input.idempotencyKey
				? grants.find((g) => g.idempotencyKey === input.idempotencyKey)
				: undefined;
			if (existing) return { id: "grant-existing" } as never;
			grants.push({ ...input });
			return { id: `grant-${grants.length}` } as never;
		};
		return { grants, grantCredits };
	}

	function makeService(sql: FakeDodoSqlClient, grantCredits: (input: never) => Promise<never>) {
		return new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: {
					...serverConfig.dodo,
					apiKey: "test-api-key",
					webhookSecret: WEBHOOK_SECRET,
					environment: "test_mode",
					productIds: ADDON_PRODUCT_IDS,
				},
			},
		});
	}

	test("AI credit pack (credits-50, legacy) on a trusted cart grants the rebased 500 shareable credits", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_credits50",
				product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }],
				metadata: { workspace_id: "ws_addon" },
			},
		});

		const result = await service.processWebhook(event, signedHeaders(event, "evt_credits50"));
		expect(result.processed).toBe(true);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toEqual(expect.objectContaining({
			workspaceId: "ws_addon",
			// Legacy pack quantities are REBASED ×10 in the catalog so a replayed
			// pre-rebase purchase mints post-rebase value (review #586 P1).
			amount: 500,
			creditClass: "shareable",
			source: "addon_purchase",
		}));
		expect(grants[0].idempotencyKey).toBe("dodo-addon:pay_credits50:credits-50:0");
	});

	test("a REPLAYED add-on webhook grants exactly once (idempotent on the derived key)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_replay",
				product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }],
				metadata: { workspace_id: "ws_replay" },
			},
		});

		// First delivery grants. Second delivery with the SAME webhook-id is deduped at the
		// dodo_webhook_events insert (handler never re-runs). A DIFFERENT webhook-id for the
		// SAME payment re-runs the handler but the derived idempotencyKey dedupes the grant.
		await service.processWebhook(event, signedHeaders(event, "evt_replay_1"));
		await service.processWebhook(event, signedHeaders(event, "evt_replay_1")); // same id → skipped
		await service.processWebhook(event, signedHeaders(event, "evt_replay_2")); // new id, same payment
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(2000);
	});

	test("storage pack (storage-25gb) inserts ONE storage_packs row, idempotent on replay", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_storage",
				product_cart: [{ product_id: "prod_addon_storage25", quantity: 1 }],
				metadata: { workspace_id: "ws_storage" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_storage_1"));
		await service.processWebhook(event, signedHeaders(event, "evt_storage_2")); // replay (new id, same payment)
		expect(sql.storagePacks.size).toBe(1);
		const pack = [...sql.storagePacks.values()][0];
		expect(pack.workspace_id).toBe("ws_storage");
		expect(pack.sku_id).toBe("storage-25gb");
		expect(Number(pack.pack_size_bytes)).toBe(25 * 1024 * 1024 * 1024);
		// Storage pack is NOT an AI credit grant.
		expect(grants).toHaveLength(0);
	});

	test("metadata-only add-on id is NOT granted (never trust forge-able metadata)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);
		// A forged event: NO trusted product id; the add-on id is only in metadata. The
		// trusted-only resolver must ignore it → no grant (the buyer of nothing gets nothing,
		// and an attacker cannot mint free credits via metadata).
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_forged",
				// A trusted PLAN product so the payment is "trusted" overall, but the add-on
				// claim lives only in forge-able metadata.
				product_id: "prod_studio_monthly",
				metadata: { workspace_id: "ws_forged", addons: "credits-200", addon_id: "credits-50" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_forged"));
		expect(grants).toHaveLength(0);
		expect(sql.storagePacks.size).toBe(0);
	});

	test("paid cart quantity multiplies the credit grant (quantity:2 → 1000 rebased), granted ONCE on replay", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_qty2",
				product_cart: [{ product_id: "prod_addon_credits50", quantity: 2 }],
				metadata: { workspace_id: "ws_qty2" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_qty2_a"));
		// One grant of 2×500 = 1000 rebased credits (quantity honored, NOT a single pack).
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(1000);
		expect(grants[0].idempotencyKey).toBe("dodo-addon:pay_qty2:credits-50:0");

		// Replay (new webhook-id, same payment) must re-derive the SAME anchor → granted
		// once total, NEVER 4×50. The credit store dedupes on the key.
		await service.processWebhook(event, signedHeaders(event, "evt_qty2_b"));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(1000);
	});

	test("storage-pack quantity inserts N rows (quantity:3 → 3 packs), idempotent on replay", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_storage_qty",
				product_cart: [{ product_id: "prod_addon_storage25", quantity: 3 }],
				metadata: { workspace_id: "ws_storage_qty" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_storage_qty_a"));
		expect(sql.storagePacks.size).toBe(3);
		// Replay (new id, same payment) re-derives the SAME 3 PKs → still exactly 3, not 6.
		await service.processWebhook(event, signedHeaders(event, "evt_storage_qty_b"));
		expect(sql.storagePacks.size).toBe(3);
		for (const pack of sql.storagePacks.values()) {
			expect(pack.sku_id).toBe("storage-25gb");
			expect(Number(pack.pack_size_bytes)).toBe(25 * 1024 * 1024 * 1024);
		}
		expect(grants).toHaveLength(0);
	});

	test("absurd/negative/fractional quantities are clamped (never an unbounded or zero grant)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);
		// quantity 0 / negative / non-integer must floor-safe to at least 1; a huge value
		// caps at MAX_ADDON_LINE_QUANTITY (1000). Use three distinct payments.
		const zero = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_zero", product_cart: [{ product_id: "prod_addon_credits50", quantity: 0 }], metadata: { workspace_id: "ws_clamp" } } });
		const frac = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_frac", product_cart: [{ product_id: "prod_addon_credits50", quantity: 2.9 }], metadata: { workspace_id: "ws_clamp" } } });
		const huge = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_huge", product_cart: [{ product_id: "prod_addon_credits50", quantity: 999999 }], metadata: { workspace_id: "ws_clamp" } } });

		await service.processWebhook(zero, signedHeaders(zero, "evt_clamp_zero"));
		await service.processWebhook(frac, signedHeaders(frac, "evt_clamp_frac"));
		await service.processWebhook(huge, signedHeaders(huge, "evt_clamp_huge"));

		const amounts = grants.map((g) => g.amount);
		expect(amounts).toContain(500);     // quantity 0 → 1 unit (rebased pack)
		expect(amounts).toContain(1000);    // quantity 2.9 → floored to 2 units
		expect(amounts).toContain(500_000); // quantity 999999 → capped at 1000 units × 500
	});

	test("a held add-on (chargeback pending) is NOT granted now but IS granted once on favorable resolution", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			now: () => now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: ADDON_PRODUCT_IDS },
			},
		});

		// Seed an active paid subscription with a future period end (so favorable resolution
		// restores access), then open a chargeback on it.
		const seed = JSON.stringify(subscriptionEvent("evt_held_seed", "subscription.active", "ws_held", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_held_seed", now));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_held", status: "opened", metadata: { workspace_id: "ws_held" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_held_dispute", now));
		expect(sql.workspaces.get("ws_held")?.chargeback_pending).toBe(true);

		// Add-on payment arrives WHILE the hold is open → deferred, NOT granted yet.
		const addonPay = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_held_addon", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_held" } },
		});
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_held_addon", now));
		expect(grants).toHaveLength(0); // held — money in dispute, no grant yet

		// Dispute resolves FAVORABLY (won) → the held add-on is finally granted, exactly once.
		const won = JSON.stringify({ type: "dispute.won", data: { id: "dp_held", status: "won", metadata: { workspace_id: "ws_held" } } });
		await service.processWebhook(won, signedHeaders(won, "evt_held_won", now));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(2000);
		expect(grants[0].idempotencyKey).toBe("dodo-addon:pay_held_addon:credits-200:0");

		// A REPLAY of the held add-on webhook (new id, same payment) after resolution must
		// NOT double-grant — hold cleared → normal path → SAME anchor → deduped.
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_held_addon_replay", now));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(2000);
	});

	test("a held add-on whose dispute is LOST is NEVER granted (money clawed back)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_lost_addon_seed", "subscription.active", "ws_lost_addon", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_lost_addon_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_lost_addon", status: "opened", metadata: { workspace_id: "ws_lost_addon" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_lost_addon_dispute"));

		const addonPay = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_lost_addon", product_cart: [{ product_id: "prod_addon_credits50", quantity: 2 }], metadata: { workspace_id: "ws_lost_addon" } },
		});
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_lost_addon_pay"));
		expect(grants).toHaveLength(0);

		// Dispute LOST → held add-on must never grant.
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_lost_addon", status: "lost", metadata: { workspace_id: "ws_lost_addon" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_lost_addon_resolve"));
		expect(grants).toHaveLength(0);
		// Even a later replay of the held add-on (new id) must not grant: hold is cleared but
		// the deferred ledger was dropped on the loss, and the still-cancelled account... the
		// normal path would re-grant on a fresh delivery, so assert the deferred marker is gone.
		const account = sql.billingAccounts.get("ws_lost_addon");
		expect((account?.metadata as Record<string, unknown>)?.deferred_addon_grants).toEqual([]);
	});

	test("BYO add-on (underscore byo_api product) is recognized but mints NO credits", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_byo",
				product_cart: [{ product_id: "prod_studio_monthly", quantity: 1, addons: [{ addon_id: "prod_addon_byo", quantity: 1 }] }],
				metadata: { workspace_id: "ws_byo" },
			},
		});

		await service.processWebhook(event, signedHeaders(event, "evt_byo"));
		// byo-api is a non-AI add-on: recognized (underscore→hyphen alias) but no credit grant.
		expect(grants).toHaveLength(0);
		expect(sql.storagePacks.size).toBe(0);
	});

	// ── P1 (round 3): concurrency + lost-dispute replay on the deferred-grant path ──

	// A SQL client that models REAL transaction interleaving for the deferred-add-on-grant
	// read-modify-write. Each `begin` runs against a per-transaction handle that shares the
	// root's data Maps. A `SELECT ... FOR UPDATE` on a workspace's billing-account row
	// acquires a per-workspace async mutex held until that transaction commits (the `begin`
	// fn resolves). To EXPOSE the lost-update bug, the metadata read (`SELECT metadata FROM
	// workspace_billing_accounts`) yields to the microtask queue before returning — so two
	// concurrent `begin` bodies genuinely interleave their read-modify-write. With the
	// FOR-UPDATE lock the second waits for the first's committed array and appends to it;
	// WITHOUT it (the pre-fix code) both read the same old array and the last
	// `metadata || ...` write clobbers the other grant.
	class InterleavingFakeSql extends FakeDodoSqlClient {
		private readonly rowLocks = new Map<string, Promise<void>>();

		async begin<T>(fn: (transaction: DodoSqlClient) => Promise<T>): Promise<T> {
			let releaseLock: () => void = () => {};
			let lockedWs: string | null = null;
			// The transaction handle delegates all data ops to the root client (shared Maps),
			// but its FOR-UPDATE acquires/holds the per-workspace lock for THIS txn.
			const root = this;
			const txn: DodoSqlClient = {
				begin: (innerFn) => innerFn(txn),
				unsafe: async <U = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<U[]> => {
					const normalized = query.replace(/\s+/g, " ").trim();
					if (normalized.startsWith("SELECT 1 FROM workspace_billing_accounts") && normalized.includes("FOR UPDATE")) {
						const ws = String(params[0]);
						// Re-entrant within a txn: a second FOR-UPDATE on a row THIS txn already
						// holds is a no-op in Postgres (no self-block). Model that so a caller +
						// callee both asserting the lock on the same tx don't deadlock the fake.
						if (lockedWs === ws) return [] as U[];
						// Block until any in-flight holder of this workspace's lock commits.
						while (root.rowLocks.has(ws)) {
							await root.rowLocks.get(ws);
						}
						const hold = new Promise<void>((resolve) => { releaseLock = resolve; });
						root.rowLocks.set(ws, hold);
						lockedWs = ws;
						return [] as U[];
					}
					if (normalized.startsWith("SELECT metadata FROM workspace_billing_accounts")) {
						// Yield so a concurrent txn's read-modify-write can interleave here.
						await Promise.resolve();
						await Promise.resolve();
					}
					return root.unsafe<U>(query, params);
				},
			};
			try {
				return await fn(txn);
			} finally {
				if (lockedWs !== null) {
					root.rowLocks.delete(lockedWs);
					releaseLock();
				}
			}
		}
	}

	test("two concurrent held add-on payments BOTH defer (neither lost-updated) and both grant on favorable resolve", async () => {
		const sql = new InterleavingFakeSql();
		const { grants, grantCredits } = captureGrants();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			now: () => now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: ADDON_PRODUCT_IDS },
			},
		});

		// Active paid subscription with a future period end, then open a chargeback hold.
		const seed = JSON.stringify(subscriptionEvent("evt_cc_seed", "subscription.active", "ws_cc", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_cc_seed", now));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_cc", status: "opened", metadata: { workspace_id: "ws_cc" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_cc_dispute", now));
		expect(sql.workspaces.get("ws_cc")?.chargeback_pending).toBe(true);

		// Two DISTINCT held add-on payments for the SAME workspace, processed CONCURRENTLY.
		const payA = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_cc_A", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_cc" } } });
		const payB = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_cc_B", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_cc" } } });
		await Promise.all([
			service.processWebhook(payA, signedHeaders(payA, "evt_cc_A", now)),
			service.processWebhook(payB, signedHeaders(payB, "evt_cc_B", now)),
		]);
		expect(grants).toHaveLength(0); // both held — money in dispute

		// BOTH deferred grants must be present in the ledger — neither lost-updated.
		const account = sql.billingAccounts.get("ws_cc");
		const pending = (account?.metadata as Record<string, unknown>)?.deferred_addon_grants as Array<{ anchor: string }>;
		expect(Array.isArray(pending)).toBe(true);
		const anchors = new Set(pending.map((g) => g.anchor));
		expect(anchors.has("dodo-addon:pay_cc_A:credits-50:0")).toBe(true);
		expect(anchors.has("dodo-addon:pay_cc_B:credits-200:0")).toBe(true);
		expect(pending).toHaveLength(2);

		// Favorable resolution grants BOTH held add-ons exactly once.
		const won = JSON.stringify({ type: "dispute.won", data: { id: "dp_cc", status: "won", metadata: { workspace_id: "ws_cc" } } });
		await service.processWebhook(won, signedHeaders(won, "evt_cc_won", now));
		const amounts = grants.map((g) => g.amount).sort((a, b) => a - b);
		expect(amounts).toEqual([500, 2000]);
	});

	test("a LOST dispute then a NEW-webhook-id replay of the clawed-back payment grants NOTHING (tombstone)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_tomb_seed", "subscription.active", "ws_tomb", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_tomb_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_tomb", status: "opened", metadata: { workspace_id: "ws_tomb" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_tomb_dispute"));

		// Add-on payment lands during the hold → deferred, not granted.
		const addonPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_tomb", product_cart: [{ product_id: "prod_addon_credits50", quantity: 2 }], metadata: { workspace_id: "ws_tomb" } } });
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_tomb_pay"));
		expect(grants).toHaveLength(0);

		// Dispute LOST → money clawed back, tombstone written, deferred ledger cleared.
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_tomb", status: "lost", metadata: { workspace_id: "ws_tomb" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_tomb_lost"));
		expect(grants).toHaveLength(0);
		const account = sql.billingAccounts.get("ws_tomb");
		expect((account?.metadata as Record<string, unknown>)?.deferred_addon_grants).toEqual([]);
		expect((account?.metadata as Record<string, unknown>)?.denied_addon_grant_anchors)
			.toEqual(["dodo-addon:pay_tomb:credits-50:0"]);

		// The OLD payment.succeeded is REDELIVERED with a NEW webhook-id. The hold is gone,
		// so it takes the NORMAL payment path — and WITHOUT the tombstone it would re-grant
		// the clawed-back add-on. The tombstone must REFUSE it: grants stays empty.
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_tomb_replay"));
		expect(grants).toHaveLength(0);
	});

	test("after a LOST dispute, a genuinely UNRELATED new add-on payment still grants (tombstone is anchor-scoped)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_unrel_seed", "subscription.active", "ws_unrel", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_unrel_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_unrel", status: "opened", metadata: { workspace_id: "ws_unrel" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_unrel_dispute"));
		const heldPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_unrel_held", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_unrel" } } });
		await service.processWebhook(heldPay, signedHeaders(heldPay, "evt_unrel_held"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_unrel", status: "lost", metadata: { workspace_id: "ws_unrel" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_unrel_lost"));
		expect(grants).toHaveLength(0);

		// A DIFFERENT add-on payment (different payment id → different anchors) after the
		// loss must NOT be blocked by the tombstone — the buyer paid; they get their credits.
		const freshPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_unrel_fresh", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_unrel" } } });
		await service.processWebhook(freshPay, signedHeaders(freshPay, "evt_unrel_fresh"));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(2000);
		expect(grants[0].idempotencyKey).toBe("dodo-addon:pay_unrel_fresh:credits-200:0");
	});

	test("a FAVORABLE resolution writes NO tombstone and grants the held add-on exactly once on replay", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			now: () => now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: ADDON_PRODUCT_IDS },
			},
		});

		const seed = JSON.stringify(subscriptionEvent("evt_fav_seed", "subscription.active", "ws_fav", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_fav_seed", now));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_fav", status: "opened", metadata: { workspace_id: "ws_fav" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_fav_dispute", now));
		const addonPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_fav", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_fav" } } });
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_fav_pay", now));
		const won = JSON.stringify({ type: "dispute.won", data: { id: "dp_fav", status: "won", metadata: { workspace_id: "ws_fav" } } });
		await service.processWebhook(won, signedHeaders(won, "evt_fav_won", now));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(500);

		// No tombstone on a favorable outcome.
		const account = sql.billingAccounts.get("ws_fav");
		expect((account?.metadata as Record<string, unknown>)?.denied_addon_grant_anchors).toBeUndefined();

		// A new-id replay of the held add-on after the WIN must grant exactly once (anchor dedupe).
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_fav_replay", now));
		expect(grants).toHaveLength(1);
	});

	// ── P1 (round 4): symmetric lock on the RESOLUTION read-modify-write ──

	// resolveChargeback originally read deferred_addon_grants + denied_addon_grant_anchors
	// WITHOUT a FOR-UPDATE lock, while the held-payment path (recordPaymentDuringChargeback)
	// DID lock its deferred read-modify-write. With the held payment committed during the
	// hold and the terminal LOSS resolution arriving after, the resolution MUST observe the
	// committed deferred grant and tombstone its EXACT anchor — and on a concurrent run the
	// two read-modify-writes must not lost-update each other. The fix takes the SAME
	// lockBillingAccountRow on the resolution's tx (and on the held-payment branch before the
	// hasPendingChargeback decision), so the two serialize. This test drives the realistic
	// ordering (held payment commits, THEN loss) on the InterleavingFakeSql and asserts the
	// loss sees the deferred grant, tombstones it, grants nothing, and refuses a later replay.
	test("a held add-on payment committed under the hold is TOMBSTONED and NEVER granted on a LOST resolution", async () => {
		const sql = new InterleavingFakeSql();
		const { grants, grantCredits } = captureGrants();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			now: () => now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: ADDON_PRODUCT_IDS },
			},
		});

		const seed = JSON.stringify(subscriptionEvent("evt_race_seed", "subscription.active", "ws_race", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_race_seed", now));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_race", status: "opened", metadata: { workspace_id: "ws_race" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_race_dispute", now));
		expect(sql.workspaces.get("ws_race")?.chargeback_pending).toBe(true);

		// Held add-on payment commits its deferred grant under the hold (not granted yet).
		const heldPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_race", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_race" } } });
		await service.processWebhook(heldPay, signedHeaders(heldPay, "evt_race_pay", now));
		expect(grants).toHaveLength(0);
		const anchor = "dodo-addon:pay_race:credits-50:0";
		expect(((sql.billingAccounts.get("ws_race")?.metadata as Record<string, unknown>)?.deferred_addon_grants as Array<{ anchor: string }>).map((g) => g.anchor)).toEqual([anchor]);

		// Terminal LOSS resolution. Under the symmetric lock it RE-READS the committed deferred
		// grant (no pre-lock snapshot), tombstones its exact anchor, clears the ledger + hold,
		// and grants nothing — the clawed-back add-on must never materialize.
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_race", status: "lost", metadata: { workspace_id: "ws_race" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_race_lost", now));

		expect(grants).toHaveLength(0); // clawed-back add-on must never be granted
		const meta = sql.billingAccounts.get("ws_race")?.metadata as Record<string, unknown>;
		expect(meta?.deferred_addon_grants).toEqual([]);
		expect(meta?.denied_addon_grant_anchors).toEqual([anchor]);
		expect(sql.workspaces.get("ws_race")?.chargeback_pending).toBe(false);

		// A new-webhook-id REPLAY of the clawed-back payment (now on the normal path) must
		// still be refused by the tombstone — no grant ever materializes.
		await service.processWebhook(heldPay, signedHeaders(heldPay, "evt_race_replay", now));
		expect(grants).toHaveLength(0);
	});

	// The symmetric lock means a held add-on payment and a terminal LOSS resolution for the
	// SAME workspace can fire CONCURRENTLY without lost-updating each other's metadata
	// read-modify-write. Whatever the interleave the lock picks, the outcome is internally
	// CONSISTENT: the deferred ledger ends empty, the add-on is applied AT MOST once, and a
	// granted add-on is never ALSO tombstoned (a granted-and-clawed-back inconsistency). The
	// add-on can only be granted if the loss did NOT tombstone its anchor (i.e. the payment
	// was a fresh post-resolution success outside the held set), never both.
	test("a held add-on payment racing a LOST resolution never lost-updates (consistent outcome)", async () => {
		const sql = new InterleavingFakeSql();
		const { grants, grantCredits } = captureGrants();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			now: () => now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: ADDON_PRODUCT_IDS },
			},
		});

		const seed = JSON.stringify(subscriptionEvent("evt_rc_seed", "subscription.active", "ws_rc", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_rc_seed", now));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_rc", status: "opened", metadata: { workspace_id: "ws_rc" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_rc_dispute", now));

		const anchor = "dodo-addon:pay_rc:credits-50:0";
		const heldPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_rc", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_rc" } } });
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_rc", status: "lost", metadata: { workspace_id: "ws_rc" } } });
		await Promise.all([
			service.processWebhook(heldPay, signedHeaders(heldPay, "evt_rc_pay", now)),
			service.processWebhook(lost, signedHeaders(lost, "evt_rc_lost", now)),
		]);

		const meta = sql.billingAccounts.get("ws_rc")?.metadata as Record<string, unknown>;
		// The ledger is never lost-updated into a half-written state — it ends empty.
		expect(meta?.deferred_addon_grants).toEqual([]);
		// The add-on is applied AT MOST once, never duplicated by an interleaved read-modify-write.
		expect(grants.length).toBeLessThanOrEqual(1);
		const denied = (meta?.denied_addon_grant_anchors as string[] | undefined) ?? [];
		// A granted add-on is never ALSO tombstoned for the same anchor — no granted-and-clawed-back.
		if (grants.some((g) => g.idempotencyKey === anchor)) {
			expect(denied).not.toContain(anchor);
		}
		// Whenever the loss tombstoned the held grant, that grant was NOT also handed out.
		if (denied.includes(anchor)) {
			expect(grants.some((g) => g.idempotencyKey === anchor)).toBe(false);
		}
	});

	// A FAVORABLE and a LOST resolution must not BOTH apply the same deferred set: the lock
	// serializes them. Whichever commits first either grants (favorable) or tombstones
	// (loss) and CLEARS the deferred ledger; the second re-reads an EMPTY ledger and does
	// nothing further. Either way the held add-on resolves exactly once — never both granted
	// and clawed back.
	test("a FAVORABLE and a LOST resolution racing the same deferred set apply it exactly once", async () => {
		const sql = new InterleavingFakeSql();
		const { grants, grantCredits } = captureGrants();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			now: () => now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: ADDON_PRODUCT_IDS },
			},
		});

		const seed = JSON.stringify(subscriptionEvent("evt_dbl_seed", "subscription.active", "ws_dbl", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_dbl_seed", now));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_dbl", status: "opened", metadata: { workspace_id: "ws_dbl" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_dbl_dispute", now));
		const heldPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_dbl", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_dbl" } } });
		await service.processWebhook(heldPay, signedHeaders(heldPay, "evt_dbl_pay", now));
		expect(grants).toHaveLength(0);

		// Two DISTINCT resolution events (a favorable and a loss) for the SAME dispute fire
		// concurrently. The lock serializes them: the deferred grant is drained-and-granted
		// XOR tombstoned, NEVER both. So grants is 0 or 1 (not 1-then-clawed-or-double), and
		// the deferred ledger ends empty.
		const won = JSON.stringify({ type: "dispute.won", data: { id: "dp_dbl", status: "won", metadata: { workspace_id: "ws_dbl" } } });
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_dbl", status: "lost", metadata: { workspace_id: "ws_dbl" } } });
		await Promise.all([
			service.processWebhook(won, signedHeaders(won, "evt_dbl_won", now)),
			service.processWebhook(lost, signedHeaders(lost, "evt_dbl_lost", now)),
		]);

		// The held add-on was applied AT MOST once (favorable grant) — never both granted and
		// tombstoned for the same set in a way that double-counts.
		expect(grants.length).toBeLessThanOrEqual(1);
		const account = sql.billingAccounts.get("ws_dbl");
		const meta = account?.metadata as Record<string, unknown>;
		expect(meta?.deferred_addon_grants).toEqual([]);
		// If the loss committed (with or after the win), the anchor is tombstoned; if only the
		// win committed both, there is no tombstone. Either way the count is consistent: a
		// tombstoned anchor implies the grant was NOT kept.
		const denied = (meta?.denied_addon_grant_anchors as string[] | undefined) ?? [];
		if (denied.includes("dodo-addon:pay_dbl:credits-50:0")) {
			// Loss won the lock first → grant must not have fired.
			expect(grants).toHaveLength(0);
		}
	});

	// ── P1 (round 5): NEVER-HELD loss → first-seen payment.succeeded must NOT grant ──
	//
	// The exact-anchor tombstone (denied_addon_grant_anchors) is created ONLY from DEFERRED
	// descriptors recorded while the hold was open. If the disputed payment.succeeded was
	// NEVER seen during the hold and arrives for the FIRST TIME AFTER dispute.lost cleared
	// the hold, the loss wrote NO anchor — so without a coarser guard the first-seen payment
	// reaches the normal grant path and re-mints the clawed-back add-on (money leak). The
	// payment-REF-scoped tombstone (denied_addon_payment_refs) closes this.

	test("dispute.lost then a FIRST-SEEN payment.succeeded for the SAME payment_id grants ZERO (never-held leak)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_nh_seed", "subscription.active", "ws_nh", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_nh_seed"));

		// Dispute opens and is LOST — carrying the payment_id of the (not-yet-seen) charge.
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_nh", status: "opened", payment_id: "pay_nh", metadata: { workspace_id: "ws_nh" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_nh_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_nh", status: "lost", payment_id: "pay_nh", metadata: { workspace_id: "ws_nh" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_nh_lost"));

		// The terminal loss persists a payment-ref tombstone even though NOTHING was deferred.
		const account = sql.billingAccounts.get("ws_nh");
		expect((account?.metadata as Record<string, unknown>)?.denied_addon_payment_refs).toEqual(["pay_nh"]);

		// The disputed add-on payment is now seen for the FIRST time (hold already cleared, so
		// it takes the NORMAL grant path). WITHOUT the payment-ref tombstone it would grant the
		// clawed-back add-on. It MUST grant ZERO credits/storage.
		const addonPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_nh", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_nh" } } });
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_nh_pay"));
		expect(grants).toHaveLength(0);
		expect(sql.storagePacks.size).toBe(0);
	});

	test("never-held loss: the payment-ref tombstone blocks STORAGE add-ons too (not just credits)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_nhs_seed", "subscription.active", "ws_nhs", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_nhs_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_nhs", status: "opened", payment_id: "pay_nhs", metadata: { workspace_id: "ws_nhs" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_nhs_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_nhs", status: "lost", payment_id: "pay_nhs", metadata: { workspace_id: "ws_nhs" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_nhs_lost"));

		const addonPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_nhs", product_cart: [{ product_id: "prod_addon_storage25", quantity: 3 }], metadata: { workspace_id: "ws_nhs" } } });
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_nhs_pay"));
		expect(sql.storagePacks.size).toBe(0);
		expect(grants).toHaveLength(0);
	});

	test("never-held loss whose RESOLUTION omits payment_id resolves the ref from the recorded dispute row", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_nho_seed", "subscription.active", "ws_nho", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_nho_seed"));
		// dispute.opened CARRIES the payment_id (recorded on the dispute row), but the
		// resolution does NOT — the tombstone ref must be recovered from the dispute row.
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_nho", status: "opened", payment_id: "pay_nho", metadata: { workspace_id: "ws_nho" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_nho_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_nho", status: "lost", metadata: { workspace_id: "ws_nho" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_nho_lost"));

		const account = sql.billingAccounts.get("ws_nho");
		expect((account?.metadata as Record<string, unknown>)?.denied_addon_payment_refs).toEqual(["pay_nho"]);

		const addonPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_nho", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_nho" } } });
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_nho_pay"));
		expect(grants).toHaveLength(0);
	});

	test("after a never-held loss, an UNRELATED add-on payment (different payment_id) still grants", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_nhu_seed", "subscription.active", "ws_nhu", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_nhu_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_nhu", status: "opened", payment_id: "pay_nhu_bad", metadata: { workspace_id: "ws_nhu" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_nhu_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_nhu", status: "lost", payment_id: "pay_nhu_bad", metadata: { workspace_id: "ws_nhu" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_nhu_lost"));

		// A genuinely DIFFERENT add-on payment (different payment_id → different ref) after the
		// loss must NOT be blocked: the buyer paid; they get their credits.
		const freshPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_nhu_good", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_nhu" } } });
		await service.processWebhook(freshPay, signedHeaders(freshPay, "evt_nhu_fresh"));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(2000);
		expect(grants[0].idempotencyKey).toBe("dodo-addon:pay_nhu_good:credits-200:0");
	});

	test("a FAVORABLE never-held resolution writes NO payment-ref tombstone and a later first-seen payment grants", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			now: () => now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: ADDON_PRODUCT_IDS },
			},
		});

		const seed = JSON.stringify(subscriptionEvent("evt_nhf_seed", "subscription.active", "ws_nhf", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_nhf_seed", now));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_nhf", status: "opened", payment_id: "pay_nhf", metadata: { workspace_id: "ws_nhf" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_nhf_dispute", now));
		const won = JSON.stringify({ type: "dispute.won", data: { id: "dp_nhf", status: "won", payment_id: "pay_nhf", metadata: { workspace_id: "ws_nhf" } } });
		await service.processWebhook(won, signedHeaders(won, "evt_nhf_won", now));

		// A favorable outcome must NOT write a payment-ref tombstone.
		const account = sql.billingAccounts.get("ws_nhf");
		expect((account?.metadata as Record<string, unknown>)?.denied_addon_payment_refs).toBeUndefined();

		// The add-on payment, seen first AFTER the win, grants normally — the buyer kept the money.
		const addonPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_nhf", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_nhf" } } });
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_nhf_pay", now));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(500);
	});

	test("held-then-lost still tombstones the EXACT anchor (round-3 invariant preserved alongside the ref guard)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_ht_seed", "subscription.active", "ws_ht", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_ht_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_ht", status: "opened", payment_id: "pay_ht", metadata: { workspace_id: "ws_ht" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_ht_dispute"));
		const addonPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_ht", product_cart: [{ product_id: "prod_addon_credits50", quantity: 2 }], metadata: { workspace_id: "ws_ht" } } });
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_ht_pay"));
		expect(grants).toHaveLength(0);
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_ht", status: "lost", payment_id: "pay_ht", metadata: { workspace_id: "ws_ht" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_ht_lost"));

		const meta = sql.billingAccounts.get("ws_ht")?.metadata as Record<string, unknown>;
		// Exact-anchor tombstone (round 3) is STILL written for the deferred grant.
		expect(meta?.denied_addon_grant_anchors).toEqual(["dodo-addon:pay_ht:credits-50:0"]);
		// And the coarser payment-ref tombstone (round 5) is ALSO written.
		expect(meta?.denied_addon_payment_refs).toEqual(["pay_ht"]);
		// A new-id replay is refused.
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_ht_replay"));
		expect(grants).toHaveLength(0);
	});

	// ── P1 (round 6): INVOICE-ONLY / no-payment-id loss → first-seen replay must NOT grant ──
	//
	// extractAddonGrantRef = payment_id ?? invoice_id ?? event.id, and BOTH payment.succeeded
	// and invoice.paid route through add-on granting. So a disputed add-on payment that carried
	// NO payment_id anchored its descriptors on its invoice_id. If the loss tombstone records
	// ONLY a payment_id, a later first-seen invoice.paid/payment.succeeded replay (same
	// invoice_id) would NOT match and would grant the clawed-back add-on. The tombstone MUST be
	// SYMMETRIC: record EVERY candidate ref (payment_id AND invoice_id) the disputed payment's
	// descriptors could have used, and the grant-refusal check must test ALL of an event's
	// candidate refs against the tombstone.

	test("invoice-only loss (dispute carries invoice_id, no payment_id) then first-seen invoice.paid replay grants ZERO", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_io_seed", "subscription.active", "ws_io", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_io_seed"));

		// Dispute opens + is LOST carrying ONLY the invoice_id of the (not-yet-seen) charge —
		// no payment_id (the add-on payment was invoice-anchored).
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_io", status: "opened", invoice_id: "inv_io", metadata: { workspace_id: "ws_io" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_io_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_io", status: "lost", invoice_id: "inv_io", metadata: { workspace_id: "ws_io" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_io_lost"));

		// The loss must tombstone the invoice_id (the only candidate ref the disputed payment had).
		const account = sql.billingAccounts.get("ws_io");
		expect((account?.metadata as Record<string, unknown>)?.denied_addon_payment_refs).toEqual(["inv_io"]);

		// First-seen invoice.paid replay (invoice-anchored add-on, no payment_id) must grant ZERO.
		const replay = JSON.stringify({ type: "invoice.paid", data: { invoice_id: "inv_io", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_io" } } });
		await service.processWebhook(replay, signedHeaders(replay, "evt_io_replay"));
		expect(grants).toHaveLength(0);
		expect(sql.storagePacks.size).toBe(0);
	});

	test("invoice-only loss where the RESOLUTION omits invoice_id recovers it from the recorded dispute row", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_ior_seed", "subscription.active", "ws_ior", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_ior_seed"));

		// dispute.opened CARRIES the invoice_id (recorded on the dispute row); the resolution
		// omits BOTH payment_id and invoice_id — the tombstone ref must be recovered from the row.
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_ior", status: "opened", invoice_id: "inv_ior", metadata: { workspace_id: "ws_ior" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_ior_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_ior", status: "lost", metadata: { workspace_id: "ws_ior" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_ior_lost"));

		const account = sql.billingAccounts.get("ws_ior");
		expect((account?.metadata as Record<string, unknown>)?.denied_addon_payment_refs).toEqual(["inv_ior"]);

		// First-seen payment.succeeded replay that DERIVES its ref from invoice_id is refused.
		const replay = JSON.stringify({ type: "payment.succeeded", data: { invoice_id: "inv_ior", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_ior" } } });
		await service.processWebhook(replay, signedHeaders(replay, "evt_ior_replay"));
		expect(grants).toHaveLength(0);
	});

	test("loss recovers BOTH payment_id AND invoice_id; a replay presenting EITHER identifier is blocked", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_both_seed", "subscription.active", "ws_both", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_both_seed"));

		// The disputed charge carries BOTH ids.
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_both", status: "opened", payment_id: "pay_both", invoice_id: "inv_both", metadata: { workspace_id: "ws_both" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_both_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_both", status: "lost", payment_id: "pay_both", invoice_id: "inv_both", metadata: { workspace_id: "ws_both" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_both_lost"));

		// Both candidate refs are tombstoned (deduped).
		const denied = (sql.billingAccounts.get("ws_both")?.metadata as Record<string, unknown>)?.denied_addon_payment_refs as string[];
		expect(denied.slice().sort()).toEqual(["inv_both", "pay_both"]);

		// A replay that derives its primary ref from payment_id is blocked.
		const replayByPayment = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_both", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_both" } } });
		await service.processWebhook(replayByPayment, signedHeaders(replayByPayment, "evt_both_replay_pay"));
		expect(grants).toHaveLength(0);

		// A replay that presents ONLY the invoice_id (derives ref = invoice_id) is ALSO blocked.
		const replayByInvoice = JSON.stringify({ type: "invoice.paid", data: { invoice_id: "inv_both", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_both" } } });
		await service.processWebhook(replayByInvoice, signedHeaders(replayByInvoice, "evt_both_replay_inv"));
		expect(grants).toHaveLength(0);
	});

	test("invoice-only loss does NOT over-block: an unrelated add-on (different payment_id AND invoice_id) still grants", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_iou_seed", "subscription.active", "ws_iou", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_iou_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_iou", status: "opened", invoice_id: "inv_iou_bad", metadata: { workspace_id: "ws_iou" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_iou_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_iou", status: "lost", invoice_id: "inv_iou_bad", metadata: { workspace_id: "ws_iou" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_iou_lost"));

		// A genuinely DIFFERENT add-on payment (different payment_id AND different invoice_id)
		// must NOT be blocked: the buyer paid; they get their credits.
		const freshPay = JSON.stringify({ type: "invoice.paid", data: { payment_id: "pay_iou_good", invoice_id: "inv_iou_good", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_iou" } } });
		await service.processWebhook(freshPay, signedHeaders(freshPay, "evt_iou_fresh"));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(2000);
		// Anchored on payment_id (preferred over invoice_id), confirming a real grant.
		expect(grants[0].idempotencyKey).toBe("dodo-addon:pay_iou_good:credits-200:0");
	});

	test("FAVORABLE invoice-only resolution writes NO payment-ref tombstone and a later first-seen invoice.paid grants", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			grantCredits: grantCredits as never,
			now: () => now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: ADDON_PRODUCT_IDS },
			},
		});

		const seed = JSON.stringify(subscriptionEvent("evt_iof_seed", "subscription.active", "ws_iof", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_iof_seed", now));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_iof", status: "opened", invoice_id: "inv_iof", metadata: { workspace_id: "ws_iof" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_iof_dispute", now));
		const won = JSON.stringify({ type: "dispute.won", data: { id: "dp_iof", status: "won", invoice_id: "inv_iof", metadata: { workspace_id: "ws_iof" } } });
		await service.processWebhook(won, signedHeaders(won, "evt_iof_won", now));

		// A favorable outcome must NOT write a payment-ref tombstone.
		const account = sql.billingAccounts.get("ws_iof");
		expect((account?.metadata as Record<string, unknown>)?.denied_addon_payment_refs).toBeUndefined();

		// The invoice-anchored add-on, seen first AFTER the win, grants normally.
		const replay = JSON.stringify({ type: "invoice.paid", data: { invoice_id: "inv_iof", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_iof" } } });
		await service.processWebhook(replay, signedHeaders(replay, "evt_iof_replay", now));
		expect(grants).toHaveLength(1);
		expect(grants[0].amount).toBe(500);
		expect(grants[0].idempotencyKey).toBe("dodo-addon:inv_iof:credits-50:0");
	});

	test("the same-payment_id never-held case (round 5) still grants ZERO alongside the symmetric ref tombstone", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_r5_seed", "subscription.active", "ws_r5", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_r5_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_r5", status: "opened", payment_id: "pay_r5", metadata: { workspace_id: "ws_r5" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_r5_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_r5", status: "lost", payment_id: "pay_r5", metadata: { workspace_id: "ws_r5" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_r5_lost"));

		// Only payment_id is tombstoned (no invoice_id on this dispute) — not over-recorded.
		expect((sql.billingAccounts.get("ws_r5")?.metadata as Record<string, unknown>)?.denied_addon_payment_refs).toEqual(["pay_r5"]);

		const addonPay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_r5", product_cart: [{ product_id: "prod_addon_credits200", quantity: 1 }], metadata: { workspace_id: "ws_r5" } } });
		await service.processWebhook(addonPay, signedHeaders(addonPay, "evt_r5_pay"));
		expect(grants).toHaveLength(0);
	});

	// NEGATIVE CONTROL for the symmetric-ref tombstone: prove the invoice-only replay leaks
	// WITHOUT a symmetric tombstone, i.e. that a payment-id-ONLY tombstone fails to block an
	// invoice-anchored replay. We assert the inverse of the fix by checking that the
	// tombstone set CONTAINS the invoice_id (the candidate a payment-id-only tombstone would
	// have missed) — if the fix regressed to payment-id-only, `denied_addon_payment_refs`
	// would be empty here (the invoice-only dispute carries no payment_id) and the replay
	// below would grant.
	test("NEGATIVE CONTROL: an invoice-only dispute with no payment_id still produces a non-empty tombstone (would be empty if payment-id-only)", async () => {
		const sql = new FakeDodoSqlClient();
		const { grants, grantCredits } = captureGrants();
		const service = makeService(sql, grantCredits);

		const seed = JSON.stringify(subscriptionEvent("evt_nc_seed", "subscription.active", "ws_nc", "studio"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_nc_seed"));
		const chargeback = JSON.stringify({ type: "dispute.opened", data: { id: "dp_nc", status: "opened", invoice_id: "inv_nc", metadata: { workspace_id: "ws_nc" } } });
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_nc_dispute"));
		const lost = JSON.stringify({ type: "dispute.lost", data: { id: "dp_nc", status: "lost", invoice_id: "inv_nc", metadata: { workspace_id: "ws_nc" } } });
		await service.processWebhook(lost, signedHeaders(lost, "evt_nc_lost"));

		const refs = (sql.billingAccounts.get("ws_nc")?.metadata as Record<string, unknown>)?.denied_addon_payment_refs as string[] | undefined;
		// A payment-id-only tombstone would be undefined/empty here (no payment_id). The
		// symmetric fix records the invoice_id, so the set is non-empty and blocks the replay.
		expect(refs).toEqual(["inv_nc"]);

		const replay = JSON.stringify({ type: "invoice.paid", data: { invoice_id: "inv_nc", product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }], metadata: { workspace_id: "ws_nc" } } });
		await service.processWebhook(replay, signedHeaders(replay, "evt_nc_replay"));
		expect(grants).toHaveLength(0);
	});
});

// ── OWNER POLICY: refund/chargeback → credit clawback (NEGATIVE) + workspace FREEZE ──
//
// On a verified refund/chargeback we (1) FULLY claw back the disputed payment's AI
// credit grants — allowed to drive the balance NEGATIVE (a debt) — and (2) FREEZE the
// workspace (suspended_at) so ALL edits are blocked for EVERYONE. A subsequent
// successful payment unfreezes. All idempotent on a webhook replay. The clawback dep is
// injected so we can assert the exact anchors targeted without a real credit store.
describe("Dodo webhook — refund/chargeback clawback (negative) + workspace freeze", () => {
	const PRODUCT_IDS: Record<string, string> = {
		pro_monthly: "prod_pro_monthly",
		studio_monthly: "prod_studio_monthly",
		"addon_credits-50": "prod_addon_credits50",
	};

	function captureClawbacks() {
		const calls: Array<{ keyPrefix: string; reason: string }> = [];
		const clawbackGrantsByKeyPrefix = async (keyPrefix: string, reason: string) => {
			calls.push({ keyPrefix, reason });
			return [];
		};
		return { calls, clawbackGrantsByKeyPrefix };
	}

	function makeService(
		sql: FakeDodoSqlClient,
		clawbackGrantsByKeyPrefix: (keyPrefix: string, reason: string) => Promise<unknown>,
		now?: () => Date,
	) {
		return new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			clawbackGrantsByKeyPrefix,
			now,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: {
					...serverConfig.dodo,
					apiKey: "test-api-key",
					webhookSecret: WEBHOOK_SECRET,
					environment: "test_mode",
					productIds: PRODUCT_IDS,
				},
			},
		});
	}

	test("a refund claws back the payment's credits (by anchor prefix) and FREEZES the workspace", async () => {
		const sql = new FakeDodoSqlClient();
		const { calls, clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		// Seed a paid charge so the rollup has a gross-paid to compare against.
		const payment = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_rf", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_rf", plan_key: "pro" } },
		});
		await service.processWebhook(payment, signedHeaders(payment, "evt_rf_pay"));
		expect(sql.workspaces.get("ws_rf")?.suspended_at).toBeFalsy();

		// FULL refund of that charge.
		const refund = JSON.stringify({
			type: "payment.refunded",
			data: { refund_id: "ref_rf", payment_id: "pay_rf", currency: "USD", amount: 1900, metadata: { workspace_id: "ws_rf" } },
		});
		await service.processWebhook(refund, signedHeaders(refund, "evt_rf_refund"));

		// FREEZE set with the refund reason.
		expect(sql.workspaces.get("ws_rf")?.suspended_at).toBe("now");
		expect(sql.workspaces.get("ws_rf")?.suspended_reason).toBe("payment_refund");
		// CLAWBACK targeted the disputed payment's add-on anchor prefix.
		expect(calls.some((c) => c.keyPrefix === "dodo-addon:pay_rf:" && c.reason.startsWith("refund:"))).toBe(true);
		// Plan entitlement also revoked on a full refund (existing behavior preserved).
		expect(sql.billingAccounts.get("ws_rf")?.status).toBe("cancelled");
	});

	test("a chargeback claws back the payment's credits and FREEZES the workspace", async () => {
		const sql = new FakeDodoSqlClient();
		const { calls, clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		const chargeback = JSON.stringify({
			type: "payment.chargeback.created",
			data: { dispute_id: "dp_cb", payment_id: "pay_cb", reason: "fraud", status: "opened", metadata: { workspace_id: "ws_cb" } },
		});
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_cb"));

		expect(sql.workspaces.get("ws_cb")?.chargeback_pending).toBe(true);
		expect(sql.workspaces.get("ws_cb")?.suspended_at).toBe("now");
		expect(sql.workspaces.get("ws_cb")?.suspended_reason).toBe("chargeback");
		expect(calls.some((c) => c.keyPrefix === "dodo-addon:pay_cb:" && c.reason.startsWith("chargeback:"))).toBe(true);
	});

	test("M1: a WON dispute lifts the chargeback FREEZE, not just the hold", async () => {
		const sql = new FakeDodoSqlClient();
		const { clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		// dispute.opened freezes the workspace (reason 'chargeback').
		const opened = JSON.stringify({
			type: "payment.chargeback.created",
			data: { dispute_id: "dp_won", payment_id: "pay_won", status: "opened", metadata: { workspace_id: "ws_won" } },
		});
		await service.processWebhook(opened, signedHeaders(opened, "evt_won_open"));
		expect(sql.workspaces.get("ws_won")?.suspended_at).toBe("now");
		expect(sql.workspaces.get("ws_won")?.suspended_reason).toBe("chargeback");

		// The customer WINS the dispute.
		const won = JSON.stringify({
			type: "dispute.won",
			data: { id: "dp_won", status: "won", payment_id: "pay_won", metadata: { workspace_id: "ws_won" } },
		});
		await service.processWebhook(won, signedHeaders(won, "evt_won_resolve"));

		// The hold clears AND the punitive freeze lifts — the vindicated customer regains
		// access instead of staying locked out until a new payment / admin unfreeze.
		expect(sql.workspaces.get("ws_won")?.chargeback_pending).toBe(false);
		expect(sql.workspaces.get("ws_won")?.suspended_at).toBeFalsy();
		expect(sql.workspaces.get("ws_won")?.suspended_reason).toBeFalsy();
	});

	test("M1 guard: winning a chargeback does NOT lift an INDEPENDENT refund freeze", async () => {
		const sql = new FakeDodoSqlClient();
		const { clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		// A refund freezes the workspace with reason 'payment_refund'.
		const refund = JSON.stringify({
			type: "payment.refunded",
			data: { refund_id: "ref_g", payment_id: "pay_g", currency: "USD", amount: 1900, metadata: { workspace_id: "ws_guard" } },
		});
		await service.processWebhook(refund, signedHeaders(refund, "evt_guard_refund"));
		expect(sql.workspaces.get("ws_guard")?.suspended_reason).toBe("payment_refund");

		// An UNRELATED dispute on the same workspace is then WON.
		const won = JSON.stringify({
			type: "dispute.won",
			data: { id: "dp_guard", status: "won", payment_id: "pay_g2", metadata: { workspace_id: "ws_guard" } },
		});
		await service.processWebhook(won, signedHeaders(won, "evt_guard_won"));

		// The refund freeze MUST persist — only a 'chargeback'-reason freeze is auto-lifted.
		expect(sql.workspaces.get("ws_guard")?.suspended_at).toBe("now");
		expect(sql.workspaces.get("ws_guard")?.suspended_reason).toBe("payment_refund");
	});

	test("webhook replay is idempotent: freeze keeps the original reason, clawback re-issued safely (per-grant no-op downstream)", async () => {
		const sql = new FakeDodoSqlClient();
		const { calls, clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		const chargeback = JSON.stringify({
			type: "payment.chargeback.created",
			data: { dispute_id: "dp_idem", payment_id: "pay_idem", reason: "fraud", status: "opened", metadata: { workspace_id: "ws_idem" } },
		});
		const headers = signedHeaders(chargeback, "evt_idem");
		const first = await service.processWebhook(chargeback, headers);
		const second = await service.processWebhook(chargeback, headers);

		expect(first.processed).toBe(true);
		// Same webhook-id → deduped at the events insert, handler never re-runs.
		expect(second.processed).toBe(false);
		expect(sql.workspaces.get("ws_idem")?.suspended_at).toBe("now");
		// Only ONE clawback call (the second delivery was deduped).
		expect(calls.filter((c) => c.keyPrefix === "dodo-addon:pay_idem:").length).toBe(1);
	});

	test("a later refund on an already-chargeback-frozen workspace keeps the ORIGINAL reason (idempotent freeze)", async () => {
		const sql = new FakeDodoSqlClient();
		const { clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		const chargeback = JSON.stringify({
			type: "payment.chargeback.created",
			data: { dispute_id: "dp_first", payment_id: "pay_first", status: "opened", metadata: { workspace_id: "ws_two" } },
		});
		await service.processWebhook(chargeback, signedHeaders(chargeback, "evt_two_cb"));
		// A separate refund event for the same workspace.
		const payment = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_two_b", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_two", plan_key: "pro" } } });
		// (payment.succeeded is held because chargeback_pending — fine; we just need a refund.)
		await service.processWebhook(payment, signedHeaders(payment, "evt_two_pay"));
		const refund = JSON.stringify({ type: "payment.refunded", data: { refund_id: "ref_two", payment_id: "pay_two_b", currency: "USD", amount: 1900, metadata: { workspace_id: "ws_two" } } });
		await service.processWebhook(refund, signedHeaders(refund, "evt_two_refund"));

		// Freeze reason stays the chargeback (the original), not overwritten by the refund.
		expect(sql.workspaces.get("ws_two")?.suspended_reason).toBe("chargeback");
	});

	test("a subsequent SUCCESSFUL validated payment UNFREEZES the workspace", async () => {
		const sql = new FakeDodoSqlClient();
		const { clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		// Seed + refund → frozen.
		const payment = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_uf", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_uf", plan_key: "pro" } } });
		await service.processWebhook(payment, signedHeaders(payment, "evt_uf_pay"));
		const refund = JSON.stringify({ type: "payment.refunded", data: { refund_id: "ref_uf", payment_id: "pay_uf", currency: "USD", amount: 1900, metadata: { workspace_id: "ws_uf" } } });
		await service.processWebhook(refund, signedHeaders(refund, "evt_uf_refund"));
		expect(sql.workspaces.get("ws_uf")?.suspended_at).toBe("now");

		// A NEW successful, validated payment (trusted product id) → unfreeze.
		const repay = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_uf2", product_id: "prod_pro_monthly", currency: "USD", total_amount: 1900, current_period_end: "2999-01-01T00:00:00.000Z", metadata: { workspace_id: "ws_uf", plan_key: "pro" } } });
		await service.processWebhook(repay, signedHeaders(repay, "evt_uf_repay"));

		expect(sql.workspaces.get("ws_uf")?.suspended_at).toBeFalsy();
	});

	test("a forged ZERO-amount payment does NOT unfreeze (unfreeze only on a validated grant)", async () => {
		const sql = new FakeDodoSqlClient();
		const { clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		const payment = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_fz", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_fz", plan_key: "pro" } } });
		await service.processWebhook(payment, signedHeaders(payment, "evt_fz_pay"));
		const refund = JSON.stringify({ type: "payment.refunded", data: { refund_id: "ref_fz", payment_id: "pay_fz", currency: "USD", amount: 1900, metadata: { workspace_id: "ws_fz" } } });
		await service.processWebhook(refund, signedHeaders(refund, "evt_fz_refund"));
		expect(sql.workspaces.get("ws_fz")?.suspended_at).toBe("now");

		// Forged zero-amount, no product id → grant REJECTED → must NOT unfreeze.
		const forged = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_fz2", currency: "USD", total_amount: 0, metadata: { workspace_id: "ws_fz", plan_key: "studio" } } });
		await service.processWebhook(forged, signedHeaders(forged, "evt_fz_forged"));

		expect(sql.workspaces.get("ws_fz")?.suspended_at).toBe("now");
	});

	// P1-3: an ADD-ON / top-up only purchase (no trusted PLAN key) is still a genuine
	// validated successful payment and must lift the freeze — previously it granted
	// credits but left the workspace frozen.
	test("a successful ADD-ON-only payment (no plan key) UNFREEZES the workspace", async () => {
		const sql = new FakeDodoSqlClient();
		const { clawbackGrantsByKeyPrefix } = captureClawbacks();
		const service = makeService(sql, clawbackGrantsByKeyPrefix);

		// Seed + refund → frozen.
		const payment = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_ao", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_ao", plan_key: "pro" } } });
		await service.processWebhook(payment, signedHeaders(payment, "evt_ao_pay"));
		const refund = JSON.stringify({ type: "payment.refunded", data: { refund_id: "ref_ao", payment_id: "pay_ao", currency: "USD", amount: 1900, metadata: { workspace_id: "ws_ao" } } });
		await service.processWebhook(refund, signedHeaders(refund, "evt_ao_refund"));
		expect(sql.workspaces.get("ws_ao")?.suspended_at).toBe("now");

		// A NEW successful payment carrying ONLY a TRUSTED add-on product (an AI credit
		// pack) — NO plan_key, NO plan product. It grants credits AND must unfreeze.
		const addonRepay = JSON.stringify({
			type: "payment.succeeded",
			data: {
				payment_id: "pay_ao2",
				currency: "USD",
				total_amount: 900,
				product_cart: [{ product_id: "prod_addon_credits50", quantity: 1 }],
				metadata: { workspace_id: "ws_ao" },
			},
		});
		await service.processWebhook(addonRepay, signedHeaders(addonRepay, "evt_ao_repay"));

		expect(sql.workspaces.get("ws_ao")?.suspended_at).toBeFalsy();
	});
});

// ── Transactional billing notifications (after-commit, fire-once, replay-safe) ──
// The receipt / payment-failed sends are wired as BEST-EFFORT side-effects that fire
// ONLY after the webhook transaction commits and ONLY on the first (fresh-insert)
// processing of an event. A webhook REPLAY must not re-send, and a notify FAILURE must
// never fail the webhook ack / break the committed payment state.
describe("Dodo webhook — transactional billing notifications", () => {
	function captureBillingNotifications() {
		const receipts: Array<{ workspaceId: string; amount?: number | null; currency?: string | null }> = [];
		const failures: Array<{ workspaceId: string; daysUntilDowngrade: number }> = [];
		const sendPaymentReceipt = async (input: { workspaceId: string; amount?: number | null; currency?: string | null }) => {
			receipts.push({ workspaceId: input.workspaceId, amount: input.amount, currency: input.currency });
		};
		const sendPaymentFailed = async (input: { workspaceId: string; daysUntilDowngrade: number }) => {
			failures.push({ workspaceId: input.workspaceId, daysUntilDowngrade: input.daysUntilDowngrade });
		};
		return { receipts, failures, sendPaymentReceipt, sendPaymentFailed };
	}

	function makeNotifyService(
		sql: FakeDodoSqlClient,
		spies: ReturnType<typeof captureBillingNotifications>,
		now?: () => Date,
	): DodoService {
		return new DodoService({
			sqlClient: sql,
			client: {} as DodoPayments,
			now,
			sendPaymentReceipt: spies.sendPaymentReceipt as never,
			sendPaymentFailed: spies.sendPaymentFailed as never,
			config: {
				...serverConfig,
				billingProvider: "dodo",
				dodo: { ...serverConfig.dodo, apiKey: "test-api-key", webhookSecret: WEBHOOK_SECRET, environment: "test_mode", productIds: STANDARD_PRODUCT_IDS },
			},
		});
	}

	test("payment.succeeded fires the receipt ONCE after commit, with the event's amount/currency", async () => {
		const sql = new FakeDodoSqlClient();
		const spies = captureBillingNotifications();
		const service = makeNotifyService(sql, spies);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_receipt", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_receipt", plan_key: "pro" } },
		});

		const result = await service.processWebhook(event, signedHeaders(event, "evt_receipt_once"));

		expect(result.processed).toBe(true);
		expect(spies.receipts).toHaveLength(1);
		expect(spies.receipts[0]).toEqual({ workspaceId: "ws_receipt", amount: 19, currency: "USD" });
		expect(spies.failures).toHaveLength(0);
	});

	test("a webhook REPLAY of payment.succeeded does NOT re-send the receipt", async () => {
		const sql = new FakeDodoSqlClient();
		const spies = captureBillingNotifications();
		const service = makeNotifyService(sql, spies);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_replay", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_replay", plan_key: "pro" } },
		});
		const headers = signedHeaders(event, "evt_receipt_replay");

		const first = await service.processWebhook(event, headers);
		const second = await service.processWebhook(event, headers);

		expect(first.processed).toBe(true);
		expect(second.processed).toBe(false);
		// Replay (same webhook-id) deduped at the insert → no second receipt.
		expect(spies.receipts).toHaveLength(1);
	});

	test("payment.failed (first failure) fires the payment-failed notice ONCE; a replay does not re-send", async () => {
		const sql = new FakeDodoSqlClient();
		const spies = captureBillingNotifications();
		const now = new Date("2026-06-02T00:00:00.000Z");
		const service = makeNotifyService(sql, spies, () => now);
		// Seed an ACTIVE account (so the failure opens a dunning grace + emails).
		const seed = JSON.stringify(subscriptionEvent("evt_pf_seed", "subscription.active", "ws_payfail", "pro"));
		await service.processWebhook(seed, signedHeaders(seed, "evt_pf_seed", now));

		const fail = JSON.stringify({ type: "payment.failed", data: { subscription_id: "sub_ws_payfail", customer_id: "cus_ws_payfail" } });
		const failHeaders = signedHeaders(fail, "evt_pf_fail", now);
		const first = await service.processWebhook(fail, failHeaders);
		const replay = await service.processWebhook(fail, failHeaders);

		expect(first.processed).toBe(true);
		expect(replay.processed).toBe(false);
		expect(spies.failures).toHaveLength(1);
		expect(spies.failures[0]?.workspaceId).toBe("ws_payfail");
		expect(spies.failures[0]?.daysUntilDowngrade ?? 0).toBeGreaterThan(0);
	});

	test("a notify FAILURE does NOT fail the webhook nor roll back the committed payment grant", async () => {
		const sql = new FakeDodoSqlClient();
		const spies = captureBillingNotifications();
		// Replace the receipt sender with one that THROWS.
		spies.sendPaymentReceipt = (async () => { throw new Error("mailer exploded"); }) as never;
		const service = makeNotifyService(sql, spies);
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_safe", currency: "USD", total_amount: 1900, metadata: { workspace_id: "ws_notify_safe", plan_key: "pro" } },
		});

		const result = await service.processWebhook(event, signedHeaders(event, "evt_notify_safe"));

		// Webhook still acks processed; the plan grant + receiptQueued metadata committed.
		expect(result.processed).toBe(true);
		const account = sql.billingAccounts.get("ws_notify_safe");
		expect(account?.status).toBe("active");
		expect(account?.plan_id).toBe("pro");
		expect((account?.metadata as Record<string, unknown>).receiptQueued).toBe(true);
	});

	test("payment.succeeded with NO trustworthy amount still acks; the sender receives a null amount (never a fabricated figure)", async () => {
		const sql = new FakeDodoSqlClient();
		const spies = captureBillingNotifications();
		const service = makeNotifyService(sql, spies);
		// A TRUSTED product id grants the plan WITHOUT an amount/currency in the payload.
		const event = JSON.stringify({
			type: "payment.succeeded",
			data: { payment_id: "pay_noamt", product_id: "prod_pro_monthly", metadata: { workspace_id: "ws_noamt", plan_key: "pro" } },
		});

		const result = await service.processWebhook(event, signedHeaders(event, "evt_noamt"));

		expect(result.processed).toBe(true);
		// The receipt send still fires (best-effort), but with a null amount — the sender
		// is responsible for skipping the dedicated money template, never fabricating one.
		expect(spies.receipts).toHaveLength(1);
		expect(spies.receipts[0]?.amount).toBeNull();
	});
});
