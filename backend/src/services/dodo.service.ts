import { getSharedBunSql } from "./sql-pool.js";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import DodoPayments from "dodopayments";
import { serverConfig } from "../config.js";
import { absCents, negateCents, normalizeCents, readMinorUnitCents } from "../utils/money.js";
import {
	DISPUTE_OPEN_EVENTS,
	DISPUTE_RESOLVED_EVENTS,
	eventTypeToDisputeStatus,
	isLostDisputeResolution,
	readDisputeMinorUnits as readDisputeMinorUnitsShared,
} from "../utils/dispute.js";
import {
	BILLING_ADDONS,
	normalizeBillingAddonId,
	normalizeWorkspacePlanId,
	resolveBillingAddon,
	WORKSPACE_PLANS,
	type BillingAddonProduct,
	type WorkspacePlanId,
} from "./plans.js";
import {
	grantCredits as defaultGrantCredits,
	clawbackGrantsByKeyPrefix as defaultClawbackGrantsByKeyPrefix,
	type CreditGrant,
	type GrantCreditsInput,
} from "./credits.js";
import type { PaymentTransaction, PaymentTransactionsStore } from "./payment-transactions-store.js";
import {
	resolveWorkspaceBillingRecipient,
	sendPaymentReceiptBestEffort as defaultSendPaymentReceipt,
	sendPaymentFailedBestEffort as defaultSendPaymentFailed,
	type BillingNotificationSqlClient,
} from "./billing-notifications.js";

// A billing notification deferred until AFTER the webhook transaction commits.
// Collected DURING handleWebhookEvent (which resolves the recipient + data while it
// still has the tx), then flushed by processWebhook ONLY on the fresh-insert path
// (`processed === true`) so a redelivered/duplicate webhook never re-sends. The
// flush is best-effort; a notify/mail failure can never roll back the committed
// payment/credit state nor fail the webhook ack.
type PendingBillingNotification =
	| { kind: "receipt"; send: () => Promise<void> }
	| { kind: "failed"; send: () => Promise<void> };

export type DodoPlanKey = "starter" | "pro" | "studio" | "studio_plus";
export type DodoBillingCycle = "monthly" | "yearly";
export type DodoAddonKey = "byo_api";

export interface DodoSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: DodoSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

export interface DodoCheckoutInput {
	workspaceId: string;
	planKey: DodoPlanKey;
	cycle: DodoBillingCycle;
	addons?: DodoAddonKey[];
	customer: {
		email: string;
		name?: string;
	};
	// Apply-coupon-at-checkout (rank 10): an optional Dodo discount code applied to
	// the session. Additive — omitted by every existing caller, so behavior is
	// unchanged when absent.
	couponCode?: string;
}

export interface DodoCheckoutResult {
	checkout_url: string;
	session_id: string;
}

export interface DodoPortalResult {
	portal_url: string;
}

export interface DodoWebhookEvent {
	id?: string;
	type: string;
	data?: unknown;
	payload?: unknown;
	[key: string]: unknown;
}

export interface DodoServiceOptions {
	client?: DodoPayments;
	sqlClient?: DodoSqlClient | null;
	config?: typeof serverConfig;
	now?: () => Date;
	/**
	 * Mint credits for a validated add-on purchase. Injectable so the webhook
	 * add-on-grant path can be tested without the real file-backed credit store.
	 * Defaults to the production `creditService.grantCredits`. MONEY-CRITICAL: the
	 * caller MUST pass a stable `idempotencyKey` so a replayed webhook grants once.
	 */
	grantCredits?: (input: GrantCreditsInput) => Promise<CreditGrant>;
	/**
	 * FULL clawback (NEGATIVE-allowed, idempotent) of every credit grant minted under
	 * a payment ref prefix (`dodo-addon:<paymentRef>:`). Invoked by the refund /
	 * chargeback handlers so a refunded/charged-back AI-credit add-on is reversed even
	 * if already spent — driving the balance into a persistent debt. Injectable for the
	 * webhook tests; defaults to the production `creditService.clawbackGrantsByKeyPrefix`.
	 */
	clawbackGrantsByKeyPrefix?: (keyPrefix: string, reason: string) => Promise<unknown>;
	/**
	 * Best-effort transactional billing notifications, fired AFTER the webhook
	 * transaction commits and ONLY on the first (fresh-insert) processing of an
	 * event. Injectable so the webhook tests can assert the fire-once / replay-safe /
	 * never-blocking contract without the real mailer + notification stores.
	 * Defaults to the production billing-notification senders.
	 */
	sendPaymentReceipt?: typeof defaultSendPaymentReceipt;
	sendPaymentFailed?: typeof defaultSendPaymentFailed;
}

export class DodoBillingError extends Error {
	constructor(message: string, readonly code = "dodo_billing_error", readonly status = 500) {
		super(message);
		this.name = "DodoBillingError";
	}
}

const DEFAULT_RETURN_BASE_URL = "https://app.example.com";
const CHECKOUT_RETURN_PATH = "/billing/checkout/return?session_id={CHECKOUT_SESSION_ID}";
const BILLING_RETURN_PATH = "/settings/billing";

const DODO_TO_INTERNAL_PLAN: Record<DodoPlanKey, WorkspacePlanId> = {
	starter: "creator",
	pro: "pro",
	studio: "studio",
	// studio_plus is a real internal plan since the 2026-06-12 catalog redesign
	// ($99 tier) — it no longer aliases down to "studio".
	studio_plus: "studio_plus",
};

const SUBSCRIPTION_ACTIVE_EVENTS = new Set([
	"subscription.created",
	"subscription.active",
	"subscription.updated",
	"subscription.renewed",
]);
// NOTE: `subscription.plan_changed` is intentionally NOT in the active-sync set. A
// plan change carries effective/proration semantics (immediate-paid upgrade vs
// scheduled downgrade vs unpaid proration preview) and is routed to
// applyPlanChangeFromEvent so an unpaid/scheduled change can't rewrite the live plan.

const SUBSCRIPTION_CANCEL_EVENTS = new Set([
	"subscription.canceled",
	"subscription.cancelled",
	"subscription.expired",
]);

// Events that terminate access immediately (the subscription has actually
// ended). End-of-period cancellations (subscription.canceled/cancelled) keep
// paid access until the stored period end; only true expiry downgrades now.
const SUBSCRIPTION_EXPIRY_EVENTS = new Set([
	"subscription.expired",
]);

// Refund events carry the refunded amount. We record a NEGATIVE revenue row so net
// revenue nets, idempotent on the refund id (refund_events handles access/state).
const REFUND_EVENTS = new Set([
	"payment.refunded",
	"refund.succeeded",
	"refund.created",
]);

// Dispute event classification (open / resolved / lost) and the favorable-outcome
// predicate live in ../utils/dispute.js so the live path and the historical backfill
// share ONE source of truth and can't drift. `dispute.accepted` is terminal: the
// merchant accepted (lost) the dispute, so it routes through the resolution path —
// clearing chargeback_pending while keeping the account cancelled.

// The only currency the published plan catalog (plans.ts) is priced in. A
// `payment.succeeded` that grants a paid plan from forge-able metadata MUST be in
// this currency, or we cannot trust the (untrusted) amount against the USD price.
const EXPECTED_PLAN_CURRENCY = "USD";

// Renewal-failure dunning grace. A `payment.failed` on a recurring charge does NOT
// instantly revoke paid access — the card may be retried successfully within this
// window. We keep the account `active` (access preserved) until the grace deadline,
// recording the dunning state in metadata; a later failure past the deadline (or an
// explicit cancel/expiry) is what actually downgrades. Mirrors a 3-day dunning retry
// schedule, which comfortably covers Dodo's automatic retry attempts.
const DUNNING_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export class DodoService {
	private readonly client: DodoPayments;
	private readonly sqlClient: DodoSqlClient | null;
	private readonly config: typeof serverConfig;
	private readonly now: () => Date;
	private readonly grantCredits: (input: GrantCreditsInput) => Promise<CreditGrant>;
	private readonly clawbackGrantsByKeyPrefix: (keyPrefix: string, reason: string) => Promise<unknown>;
	private readonly sendPaymentReceipt: typeof defaultSendPaymentReceipt;
	private readonly sendPaymentFailed: typeof defaultSendPaymentFailed;

	constructor(options: DodoServiceOptions = {}) {
		this.config = options.config ?? serverConfig;
		this.client = options.client ?? new DodoPayments({
			bearerToken: this.config.dodo.apiKey,
			environment: this.config.dodo.environment,
		});
		this.sqlClient = options.sqlClient === undefined ? createDefaultSqlClient() : options.sqlClient;
		this.now = options.now ?? (() => new Date());
		this.grantCredits = options.grantCredits ?? defaultGrantCredits;
		this.clawbackGrantsByKeyPrefix = options.clawbackGrantsByKeyPrefix ?? defaultClawbackGrantsByKeyPrefix;
		this.sendPaymentReceipt = options.sendPaymentReceipt ?? defaultSendPaymentReceipt;
		this.sendPaymentFailed = options.sendPaymentFailed ?? defaultSendPaymentFailed;
	}

	async createCheckoutSession(input: DodoCheckoutInput): Promise<DodoCheckoutResult> {
		this.requireDodoEnabled();
		const productId = this.getProductId(input.planKey, input.cycle);
		const addons = normalizeAddons(input.addons).map((addon) => ({
			addon_id: this.getAddonProductId(addon),
			quantity: 1,
		}));
		const productCart = [{
			product_id: productId,
			quantity: 1,
			...(addons.length > 0 ? { addons } : {}),
		}];

		// Dodo's checkout-session top-level `metadata` is copied onto the resulting
		// subscription (`Subscription.metadata`) and payment, so it round-trips on
		// every `subscription.*` / `payment.*` webhook. We deliberately do NOT set
		// `subscription_data.metadata`: that field is not part of Dodo's
		// `SubscriptionData` shape (only `on_demand` / `trial_period_days`), so it is
		// dropped server-side — and relying on it would mean the webhook payload
		// never carries `workspace_id`, breaking workspace linking on cancel/portal.
		// Apply-coupon-at-checkout (rank 10): when a coupon code is supplied, enable
		// discount entry and pre-apply it via `discount_code`. Both fields are only
		// added when a code is present, so the no-coupon path is byte-for-byte the
		// same request as before.
		const couponCode = input.couponCode?.trim().toUpperCase();
		const response = await this.client.checkoutSessions.create({
			product_cart: productCart,
			customer: {
				email: input.customer.email,
				name: input.customer.name,
			},
			return_url: this.checkoutReturnUrl(),
			...(couponCode ? { allow_discount_code: true, discount_code: couponCode } : {}),
			metadata: {
				workspace_id: input.workspaceId,
				plan_key: input.planKey,
				billing_cycle: input.cycle,
				addons: normalizeAddons(input.addons).join(","),
				...(couponCode ? { coupon_code: couponCode } : {}),
			},
		} as Parameters<DodoPayments["checkoutSessions"]["create"]>[0]);

		if (!response.checkout_url) {
			throw new DodoBillingError("Dodo checkout did not return a checkout URL", "dodo_checkout_url_missing", 502);
		}
		return {
			checkout_url: response.checkout_url,
			session_id: response.session_id,
		};
	}

	async createPortalSession(workspaceId: string): Promise<DodoPortalResult> {
		this.requireDodoEnabled();
		const client = this.requireSqlClient();
		const customer = await findBillingCustomer(client, { workspaceId });
		if (!customer?.dodo_customer_id) {
			throw new DodoBillingError("No Dodo customer is linked to this workspace", "dodo_customer_missing", 404);
		}
		const response = await this.client.customers.customerPortal.create(customer.dodo_customer_id, {
			return_url: this.billingReturnUrl(),
		});
		const portalUrl = readStringField(response, ["portal_url", "customer_portal_url", "url", "link"]);
		if (!portalUrl) {
			throw new DodoBillingError("Dodo portal did not return a portal URL", "dodo_portal_url_missing", 502);
		}
		return { portal_url: portalUrl };
	}

	verifyWebhookSignature(rawBody: string, headers: Headers | Record<string, string | undefined>, secret = this.config.dodo.webhookSecret): boolean {
		return verifyWebhookSignature(rawBody, headers, secret);
	}

	async processWebhook(rawBody: string, headers: Headers | Record<string, string | undefined>): Promise<{ processed: boolean; eventId: string; type: string }> {
		this.requireDodoEnabled();
		if (!this.verifyWebhookSignature(rawBody, headers)) {
			throw new DodoBillingError("Invalid Dodo webhook signature", "dodo_webhook_signature_invalid", 401);
		}
		// Replay guard. The HMAC is computed over `webhook-id.webhook-timestamp.body`,
		// so a captured/replayed delivery still verifies. Reject signatures whose
		// timestamp is outside a small tolerance window so a leaked old delivery (or
		// one captured before its `webhook-id` is recorded, e.g. after a data
		// restore) cannot be replayed indefinitely to mutate billing state.
		if (!isWebhookTimestampFresh(readHeader(headers, "webhook-timestamp"), this.now())) {
			throw new DodoBillingError("Stale Dodo webhook timestamp", "dodo_webhook_timestamp_stale", 401);
		}

		let event: DodoWebhookEvent;
		try {
			event = JSON.parse(rawBody) as DodoWebhookEvent;
		} catch {
			throw new DodoBillingError("Invalid Dodo webhook JSON", "dodo_webhook_invalid_json", 400);
		}
		const eventId = readHeader(headers, "webhook-id");
		if (!eventId || !event.type) {
			throw new DodoBillingError("Dodo webhook is missing webhook-id or type", "dodo_webhook_invalid_event", 400);
		}
		const normalizedEvent: DodoWebhookEvent = { ...event, id: eventId };

		// Per-call after-commit billing-notification buffer. A LOCAL (not instance state)
		// so concurrent processWebhook() calls on the same DodoService singleton can never
		// share or clobber each other's queued sends. The handler enqueues into THIS array;
		// it is flushed only on the fresh-insert path (so a replay never re-sends) and only
		// after the tx commits.
		const pending: PendingBillingNotification[] = [];

		const client = this.requireSqlClient();
		const result = await this.transaction(client, async (tx) => {
			const inserted = await tx.unsafe<{ id: string }>(`
				INSERT INTO dodo_webhook_events (id, type, payload, received_at)
				VALUES ($1, $2, $3::text::jsonb, now())
				ON CONFLICT (id) DO NOTHING
				RETURNING id
			`, [eventId, normalizedEvent.type, JSON.stringify(normalizedEvent)]);
			if (inserted.length === 0) {
				// REPLAY: this webhook-id was already processed -> the handler never runs, so
				// `pending` stays empty and nothing is flushed below.
				return { processed: false, eventId, type: normalizedEvent.type };
			}

			try {
				await this.handleWebhookEvent(tx, normalizedEvent, pending);
				await tx.unsafe(`
					UPDATE dodo_webhook_events
					SET processed_at = now(), error = NULL
					WHERE id = $1
				`, [eventId]);
				return { processed: true, eventId, type: normalizedEvent.type };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await tx.unsafe(`
					UPDATE dodo_webhook_events
					SET error = $2
					WHERE id = $1
				`, [eventId, message.slice(0, 2000)]);
				// The tx rolled back: nothing committed, so drop any queued notification.
				pending.length = 0;
				throw error;
			}
		});

		// ── AFTER-COMMIT, FIRE-ONCE billing notifications ─────────────────────────
		// Only the fresh-insert (first) processing of an event flushes; a replay
		// returned processed:false above (the handler never ran -> `pending` is empty)
		// and a rolled-back handler cleared it. Every send is
		// best-effort (the senders swallow their own errors) and runs OUTSIDE the
		// committed transaction, so a mail/notify failure can never roll back the
		// payment/credit mutation nor change the webhook ack we already computed.
		if (result.processed) {
			for (const item of pending) {
				try {
					await item.send();
				} catch (error) {
					// Defense in depth: the senders are already best-effort, but never let a
					// notification escape and disturb the webhook response.
					console.warn(`[dodo] post-commit billing notify (${item.kind}) failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		return result;
	}

	async handleWebhookEvent(tx: DodoSqlClient, event: DodoWebhookEvent, pending: PendingBillingNotification[] = []): Promise<void> {
		// `subscription.plan_changed` is NOT a plain "active" sync: a plan change can be
		// a scheduled (end-of-period) downgrade or an unpaid proration preview, neither of
		// which should rewrite the live plan_id immediately. It is handled with
		// effective/proration semantics in its own path (see applyPlanChangeFromEvent).
		if (event.type === "subscription.plan_changed") {
			await this.applyPlanChangeFromEvent(tx, event);
			return;
		}
		if (SUBSCRIPTION_ACTIVE_EVENTS.has(event.type)) {
			await this.syncSubscriptionFromEvent(tx, event, "active");
			return;
		}
		if (SUBSCRIPTION_CANCEL_EVENTS.has(event.type)) {
			await this.syncSubscriptionFromEvent(tx, event, "cancelled");
			return;
		}
		if (event.type === "payment.failed") {
			// Renewal-failure dunning grace: do NOT instantly drop to free. See
			// applyPaymentFailureFromEvent — access is preserved until a grace deadline.
			await this.applyPaymentFailureFromEvent(tx, event, pending);
			return;
		}
		if (event.type === "subscription.failed" || event.type === "subscription.on_hold") {
			await this.updateWorkspaceStatusFromEvent(tx, event, "past_due");
			return;
		}
		if (event.type === "payment.succeeded" || event.type === "invoice.paid") {
			// A delayed success for a payment whose chargeback is still open must
			// NOT flip the account back to `active` — that would re-grant paid
			// access during an unresolved dispute. Only the dispute resolution
			// events (won/cancelled/expired) restore access. We still record the
			// payment id so the dispute can be linked, but keep status cancelled.
			const workspaceId = extractWorkspaceId(event) ?? await findWorkspaceIdByEvent(tx, event);
			// Persist the revenue row regardless of the chargeback hold — the money
			// did move; only the access-granting status is gated by the dispute.
			await this.recordPaymentTransaction(tx, event, workspaceId);
			// MONEY-CRITICAL (P1 symmetric lock — held-vs-resolved ordering): the
			// held/normal decision below is `hasPendingChargeback`-gated, and on the held
			// branch `recordPaymentDuringChargeback` does a read-modify-write of the
			// deferred-grant ledger. That decision MUST be atomic with `resolveChargeback`,
			// which clears `chargeback_pending` + reconciles the SAME ledger under its own
			// FOR-UPDATE lock. Without serializing here, this payment could read
			// `chargeback_pending=true` (resolution not yet committed), THEN the loss
			// resolution commits (reads an empty ledger → no tombstone, clears the hold),
			// THEN this payment writes its deferred grant + re-sets `chargeback_pending=true`
			// → a clawed-back add-on left un-tombstoned, present, AND the hold spuriously
			// re-opened. So when this payment carries add-on grants, take the SAME
			// `lockBillingAccountRow` on THIS tx BEFORE the pending check: we then either run
			// strictly before resolution (resolution sees our deferred grant and tombstones
			// it on loss) or strictly after (we observe the cleared hold + go down the normal
			// path, where `applyAddonGrantsFromEvent` honors the loss tombstone and refuses
			// to grant). Either way the add-on resolves exactly once. Plan-only / non-add-on
			// payments keep the lock-free fast path (no ledger write to serialize).
			const addonDeferredCandidates = workspaceId
				? this.computeAddonGrantDescriptors(event, this.validateAddonGrants(event))
				: [];
			if (workspaceId && addonDeferredCandidates.length > 0) {
				await lockBillingAccountRow(tx, workspaceId);
			}
			if (workspaceId && await hasPendingChargeback(tx, workspaceId)) {
				// MONEY-CRITICAL (deferred add-on grant): an add-on purchase that lands
				// while a chargeback hold is open must NOT grant now (the funds are in
				// dispute), but it must NOT be silently lost either. The webhook event is
				// recorded as fully-processed, so a later replay of the SAME webhook-id is
				// deduped at the insert and the handler never re-runs — without this, the
				// paid add-on would NEVER grant even after a favorable resolution. So we
				// PERSIST the (trusted, idempotency-anchored) grant descriptors on the
				// billing account; resolveChargeback replays them exactly-once on a
				// favorable outcome (and discards them on a lost/accepted dispute). The
				// stable anchors keep it exactly-once even if a webhook replay also fires.
				// The deferred descriptors + the FOR-UPDATE lock were already taken above
				// (under the same tx) so the held decision is atomic with resolveChargeback.
				await this.recordPaymentDuringChargeback(tx, event, workspaceId, addonDeferredCandidates);
				return;
			}
			// MONEY-CRITICAL gate: only grant/restore a paid plan when the payment is
			// trustworthy (known product or a valid USD amount) AND not a stale event
			// reactivating a terminally-cancelled account. See applyPaymentSuccessFromEvent.
			await this.applyPaymentSuccessFromEvent(tx, event, workspaceId, pending);
			// Add-on grants (AI credit packs / storage packs) ride the same trusted
			// payment. They are resolved ONLY from configured Dodo add-on PRODUCT IDS
			// (never forge-able metadata) and granted idempotently — a replayed webhook
			// grants once. Separate from the plan grant: an add-on purchase carries no
			// plan, and a plan renewal carries no add-on. See applyAddonGrantsFromEvent.
			await this.applyAddonGrantsFromEvent(tx, event, workspaceId);
			return;
		}
		if (REFUND_EVENTS.has(event.type)) {
			// payment.refunded / refund.succeeded carry the refunded amount; record a
			// negative revenue row (idempotent on the refund id) so net revenue nets,
			// THEN revoke entitlement when cumulative refunds clear the gross paid.
			await this.recordRefundTransaction(tx, event);
			await this.revokeEntitlementOnFullRefund(tx, event);
			return;
		}
		if (DISPUTE_OPEN_EVENTS.has(event.type)) {
			await this.recordChargeback(tx, event);
			return;
		}
		if (DISPUTE_RESOLVED_EVENTS.has(event.type)) {
			await this.resolveChargeback(tx, event);
		}
	}

	// --- Revenue persistence (payment_transactions, migration 0052) -----------
	//
	// These run on the SAME `tx` as the dodo_webhook_events insert, so the existing
	// webhook idempotency (ON CONFLICT (id) DO NOTHING) already prevents a
	// re-delivered event from inserting twice. The unique indexes on
	// payment_transactions are a second line of defence (and protect the backfill).

	private async recordPaymentTransaction(tx: DodoSqlClient, event: DodoWebhookEvent, workspaceId: string | null): Promise<void> {
		const subject = getEventSubject(event);
		const paymentId = extractPaymentId(event);
		const invoiceId = readStringField(subject, ["invoice_id", "invoiceId"]) ?? null;
		// A row needs a dedupe ref: the payment id, else the invoice id, else the
		// webhook event id. Without any identifier we cannot dedupe, so skip.
		const ref = paymentId ?? invoiceId ?? event.id ?? null;
		if (!ref) return;
		const amountCents = readMinorUnits(subject, ["total_amount", "amount", "settlement_amount"]);
		const planKey = this.extractPlanKey(event);
		await upsertPaymentTransactionRow(tx, {
			workspaceId,
			dodoPaymentId: paymentId ?? null,
			dodoInvoiceId: invoiceId,
			dodoEventRef: ref,
			dodoEventId: event.id ?? null,
			kind: "payment",
			amountCents: amountCents ?? 0,
			taxCents: readMinorUnits(subject, ["tax", "settlement_tax"]) ?? null,
			currency: readStringField(subject, ["currency", "settlement_currency"]) ?? null,
			status: readStringField(subject, ["status"]) ?? "succeeded",
			planId: planKey ? DODO_TO_INTERNAL_PLAN[planKey] : null,
			billingCycle: readStringField(subject, ["billing_cycle", "billingCycle"]) ?? extractMetadataBillingCycle(event),
			occurredAt: extractTimestamp(subject, ["created_at", "createdAt", "settled_at", "settledAt", "timestamp"]) ?? null,
			raw: subject,
		});
	}

	private async recordRefundTransaction(tx: DodoSqlClient, event: DodoWebhookEvent): Promise<void> {
		const subject = getEventSubject(event);
		const refundId = readStringField(subject, ["refund_id", "refundId", "id"]);
		const paymentId = extractPaymentId(event);
		const ref = refundId ?? paymentId ?? event.id ?? null;
		if (!ref) return;
		const workspaceId = extractWorkspaceId(event)
			?? await findWorkspaceIdByEvent(tx, event)
			?? await findWorkspaceIdByPaymentId(tx, paymentId);
		const amount = readMinorUnits(subject, ["amount", "total_amount", "settlement_amount"]) ?? 0;
		await upsertPaymentTransactionRow(tx, {
			workspaceId,
			dodoPaymentId: paymentId ?? null,
			dodoEventRef: ref,
			dodoEventId: event.id ?? null,
			kind: "refund",
			// Refunds reduce revenue: store NEGATIVE so a plain SUM nets correctly.
			amountCents: negateCents(absCents(amount)),
			currency: readStringField(subject, ["currency"]) ?? null,
			status: readStringField(subject, ["status"]) ?? "refunded",
			occurredAt: extractTimestamp(subject, ["created_at", "createdAt", "timestamp"]) ?? null,
			raw: subject,
		});
	}

	async syncSubscription(workspaceId: string, dodoSubscriptionId: string): Promise<void> {
		const client = this.requireSqlClient();
		await client.unsafe(`
			UPDATE workspace_billing_customers
			SET dodo_subscription_id = $2, updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, dodoSubscriptionId]);
	}

	async refundSubscription(workspaceId: string, amount: number | undefined, reason: string, initiatedBy: string): Promise<unknown> {
		this.requireDodoEnabled();
		const client = this.requireSqlClient();
		const customer = await findBillingCustomer(client, { workspaceId });
		if (!customer?.dodo_subscription_id) {
			throw new DodoBillingError("No Dodo subscription is linked to this workspace", "dodo_subscription_missing", 404);
		}
		const account = await findBillingAccount(client, { workspaceId });
		const paymentId = readStringField(account?.metadata, ["dodo_payment_id"]);
		if (!paymentId) {
			throw new DodoBillingError("No refundable Dodo payment is linked to this workspace", "dodo_payment_missing", 404);
		}
		const metadata = { workspace_id: workspaceId, initiated_by: initiatedBy };
		const refund = await this.client.refunds.create({
			payment_id: paymentId,
			reason,
			metadata,
			items: amount ? [{ item_id: paymentId, amount }] : undefined,
		} as Parameters<DodoPayments["refunds"]["create"]>[0]);
		await client.unsafe(`
			INSERT INTO refund_events (id, workspace_id, dodo_refund_id, amount, currency, reason, initiated_by, initiated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, now())
			ON CONFLICT (dodo_refund_id) DO NOTHING
		`, [
			randomUUID(),
			workspaceId,
			readStringField(refund, ["refund_id"]) ?? randomUUID(),
			amount ?? readNumberField(refund, ["amount"]),
			readStringField(refund, ["currency"]),
			reason,
			initiatedBy,
		]);
		return refund;
	}

	private async syncSubscriptionFromEvent(tx: DodoSqlClient, event: DodoWebhookEvent, intent: "active" | "cancelled"): Promise<void> {
		const subject = getEventSubject(event);
		const workspaceId = extractWorkspaceId(event);
		if (!workspaceId) return;

		// MONEY-CRITICAL (P1): a signed `subscription.created|active|updated|renewed`
		// must NOT grant a paid plan from forge-able metadata. The plan it WRITES is
		// derived ONLY through `validatePaidGrant` — the SAME trusted-key logic the
		// payment.succeeded / plan_changed grant paths use — so a signed
		// `subscription.active` carrying metadata.plan_key=studio with NO recognized
		// product and NO sufficient validated amount can NOT grant Studio for free.
		//
		// `validatePaidGrant` trusts (a) a configured product id (price owned by Dodo,
		// authoritative), or (b) metadata.plan_key ONLY when backed by the expected
		// currency + an amount clearing the plan floor. When neither holds, the grant is
		// rejected: `validatedInternalPlan` stays undefined so `upsertBillingAccount`
		// preserves the stored plan_id (COALESCE) — a renewal never silently downgrades a
		// paying Pro/Studio workspace, and a forged event never silently upgrades a free one.
		const grant = this.validatePaidGrant(event);
		const validatedPlanKey = grant.trusted ? grant.planKey : undefined;
		// The plan the event NAMES (product/cart/metadata resolution) — for audit/metadata
		// only. Never used to grant a plan; the GRANT comes from `validatedPlanKey`.
		const namedPlanKey = this.extractPlanKey(event);
		const planKey = namedPlanKey ?? "starter";
		const internalPlan = validatedPlanKey ? DODO_TO_INTERNAL_PLAN[validatedPlanKey] : undefined;
		// A plan grant was REJECTED when the event named a (paid) plan but it could not be
		// validated against a trusted product or a sufficient amount. Audit-log it so the
		// rejection is observable; the live plan_id is left untouched (status-only sync).
		const planGrantRejected = intent === "active" && namedPlanKey !== null && validatedPlanKey === undefined
			? (grant.reason ?? "unvalidated_subscription_plan_grant")
			: null;
		const subscriptionId = extractSubscriptionId(event);
		const customerId = extractCustomerId(event);
		const paymentMethodId = readStringField(subject, ["payment_method_id", "paymentMethodId"]);
		const currentPeriodStart = extractTimestamp(subject, ["current_period_start", "currentPeriodStart", "period_start", "previous_billing_date", "previousBillingDate"]);
		const currentPeriodEnd = extractTimestamp(subject, ["current_period_end", "currentPeriodEnd", "period_end", "next_billing_date", "nextBillingDate", "cancel_at"]);
		const billingEmail = readStringField(subject, ["customer_email", "email"]);

		// Out-of-order delivery guard. Dodo documents that webhook events can arrive
		// out of order, so a stale/retried `subscription.active|updated|renewed` can
		// land AFTER the subscription has already been terminally cancelled/expired.
		// Treating that as authoritative would re-write the account to `active` and
		// the billing-plan joins would silently re-grant paid access. If the stored
		// account is already terminally cancelled, only honor a reactivation when the
		// incoming event proves a genuinely current/future paid period (a period end
		// in the future). A stale event with a missing or already-past period end is
		// ignored. A chargeback hold is also terminal here — never reactivate over it.
		if (intent === "active") {
			const current = await findBillingAccountState(tx, workspaceId);
			const incomingPeriodActive = isFutureTimestamp(currentPeriodEnd, this.now());
			if (current?.chargeback_pending) return;
			if (current?.status === "cancelled" && !incomingPeriodActive) return;
		}

		// Preserve paid access until the cancellation period ends. The
		// plan-resolution joins (usage-ledger / project-catalog) only honor
		// `mock_active | trialing | active`, so writing `cancelled` immediately on
		// an end-of-period cancellation would strip the paid plan even though the
		// already-paid period has not elapsed yet. We therefore keep the account
		// `active` and record the scheduled cancellation in metadata; the access
		// only drops on `subscription.expired` (or when the stored period end has
		// passed by the time the cancel event arrives).
		const periodEndPassed = isPastTimestamp(currentPeriodEnd, this.now());
		const expiresNow = SUBSCRIPTION_EXPIRY_EVENTS.has(event.type) || periodEndPassed;
		const status: "active" | "cancelled" = intent === "cancelled" && !expiresNow ? "active" : intent;
		const cancellationScheduled = intent === "cancelled" && !expiresNow;
		const cancelledAt = readStringField(subject, ["cancelled_at", "canceled_at"]);

		// Dunning recovery via a subscription event (P1): `upsertBillingAccount` shallow-
		// merges metadata, so a stale `dunning_grace_until` written by a prior
		// payment.failed survives onto a now-recovered subscription — and the access-time
		// gate (resolveWorkspacePlan → isDunningGraceExpired) would then wrongly downgrade
		// an active account to past_due/free. When an authoritative active-current event
		// re-establishes a live paid subscription, CLEAR the dunning state (not only
		// payment.succeeded ends dunning).
		//
		// P1 (clear-too-broad): `status === "active"` alone is NOT a recovery. A still-
		// FAILING account in active dunning grace can receive an unrelated, non-recovery
		// `subscription.updated` (e.g. a metadata-only change) — or a `subscription.active`
		// whose paid-plan grant was REJECTED/unvalidated — and nulling its grace deadline
		// would let a delinquent account keep paid access forever (the access-time gate can
		// no longer downgrade it at the original deadline). So clear dunning ONLY on a
		// GENUINE recovery, which requires BOTH:
		//   (1) the plan grant was VALIDATED this event (`internalPlan` is defined — a real
		//       paid plan granted via the trusted-product/amount path, not a rejected or
		//       status-only sync), AND
		//   (2) the subscription evidences a CURRENT/active-and-paid period: a current/
		//       future paid period end, proving the renewal actually re-established a live
		//       paid term (not merely `status==="active"` carried on a metadata update).
		// If either fails (rejected/unvalidated grant, no current paid period, or a winding-
		// down cancellation), LEAVE the dunning metadata intact so the access-time gate can
		// still downgrade at the deadline. (`payment.succeeded` independently clears dunning
		// on a real validated payment — that path is unchanged.)
		const recoveryPeriodActive = isFutureTimestamp(currentPeriodEnd, this.now());
		const clearsDunning = status === "active" && internalPlan !== undefined && recoveryPeriodActive;
		const dunningClear = clearsDunning
			? { dunning_grace_until: null, dunning_failed_at: null, dunning_expired: false }
			: {};

		if (customerId) {
			await upsertBillingCustomer(tx, {
				workspaceId,
				customerId,
				subscriptionId,
				paymentMethodId,
				status,
			});
		}
		await upsertBillingAccount(tx, {
			workspaceId,
			planId: internalPlan,
			status,
			billingEmail,
			currentPeriodStart,
			currentPeriodEnd,
			metadata: {
				provider: "dodo",
				dodo_event_id: event.id,
				dodo_event_type: event.type,
				dodo_plan_key: planKey,
				dodo_subscription_id: subscriptionId,
				dodo_customer_id: customerId,
				// When the user cancels but keeps access until period end, surface the
				// scheduled cancel so the UI/cron can downgrade at the right time.
				cancel_at_period_end: cancellationScheduled,
				...(cancelledAt ? { dodo_cancelled_at: cancelledAt } : {}),
				// Authoritative recovery clears any in-flight dunning grace (see above).
				...dunningClear,
				// Record an unvalidated paid-plan grant rejection for audit (plan unchanged).
				...(planGrantRejected ? { dodo_subscription_plan_grant_rejected: planGrantRejected } : {}),
			},
		});
	}

	private async updateWorkspaceStatusFromEvent(
		tx: DodoSqlClient,
		event: DodoWebhookEvent,
		status: "active" | "past_due",
		extraMetadata: Record<string, unknown> = {},
		// MONEY-CRITICAL (P1 plant-then-activate): the ONLY way this path may write a
		// PAID plan_id is via this `planKeyOverride` — the key the caller already
		// VALIDATED through `validatePaidGrant` (trusted product OR sufficient validated
		// amount). It is supplied ONLY by the validated `payment.succeeded` grant
		// (applyPaymentSuccessFromEvent, status=active). It is OMITTED for every
		// non-granting status transition (subscription.failed/on_hold/past_due, dunning
		// failures): those MUST NOT introduce a paid plan_id from forge-able
		// `metadata.plan_key`. Doing so on a NEW row (status past_due) would PLANT a paid
		// plan that a later unvalidated `subscription.active` then preserves via COALESCE
		// and flips access-granting — free Studio via two signed events. So without an
		// override we write STATUS ONLY: the metadata-named plan is recorded for AUDIT
		// only, the entitlement plan_id defaults to 'free' on a new row and is preserved
		// (never overwritten) on an existing row.
		planKeyOverride?: DodoPlanKey,
	): Promise<void> {
		const workspaceId = extractWorkspaceId(event) ?? await findWorkspaceIdByEvent(tx, event);
		if (!workspaceId) return;
		const subject = getEventSubject(event);
		// The plan the event NAMES (trusted product → cart → forge-able metadata). Used
		// only for audit when there is no validated override — NEVER as the entitlement
		// plan_id on a non-granting transition.
		const namedPlanKey = this.extractPlanKey(event);
		// Only a validated override grants a paid plan_id. Without it, planId stays
		// undefined so upsertBillingAccountStatus writes STATUS ONLY (new row → 'free',
		// existing row → preserve the stored — only-ever-validated — plan_id).
		const grantedPlanId = planKeyOverride ? DODO_TO_INTERNAL_PLAN[planKeyOverride] : undefined;
		await upsertBillingAccountStatus(tx, {
			workspaceId,
			planId: grantedPlanId,
			status,
			billingEmail: readStringField(subject, ["customer_email", "email"]),
			metadata: {
				provider: "dodo",
				dodo_event_id: event.id,
				dodo_event_type: event.type,
				dodo_payment_id: extractPaymentId(event),
				// Audit-only: surface the plan the event named so a metadata-claimed paid
				// tier on a non-granting event is observable WITHOUT becoming the entitlement.
				...(!planKeyOverride && namedPlanKey ? { dodo_named_plan_key: namedPlanKey } : {}),
				...extraMetadata,
			},
		});
	}

	// ── payment.succeeded entitlement gate (P1: money-critical) ──────────────────
	// A `payment.succeeded` is the strongest grant signal, but the event is signed by
	// Dodo over WHATEVER body Dodo sends — and the plan it grants comes from
	// forge-able `metadata.plan_key` if no recognized product is present. Two attacks
	// the unconditional `updateWorkspaceStatusFromEvent(active)` allowed:
	//   (a) a signed event with metadata.plan_key=studio + zero/wrong amount activates
	//       Studio for free (no amount/currency/product validation), and
	//   (b) a stale/replayed success reactivates a terminally-cancelled subscription.
	// This gate fixes BOTH: validate the grant is trustworthy, then mirror the
	// subscription stale-guard before flipping a cancelled account back to active.
	private async applyPaymentSuccessFromEvent(tx: DodoSqlClient, event: DodoWebhookEvent, workspaceId: string | null, pending: PendingBillingNotification[] = []): Promise<void> {
		if (!workspaceId) {
			// Out-of-order payment before the workspace is linkable. The revenue row is
			// already recorded; defer the grant (a later delivery carries the linkage).
			return;
		}
		const validation = this.validatePaidGrant(event);
		if (!validation.trusted || !validation.planKey) {
			// No trusted PLAN key. This is still a genuine successful payment when it carries
			// a VALIDATED ADD-ON / top-up (resolved ONLY from configured Dodo add-on product
			// ids, never forge-able metadata). An add-on-only purchase grants credits but
			// historically left a frozen workspace frozen — so UNFREEZE on any validated
			// successful payment for the workspace (plan OR add-on), while a forged/zero
			// event (no trusted plan AND no trusted add-on) still unfreezes NOTHING.
			const hasValidatedAddonGrant = this.validateAddonGrants(event).length > 0;
			if (hasValidatedAddonGrant) {
				// UNFREEZE path (add-on/top-up): the customer paid again → lift any refund/
				// chargeback freeze. Reached only from the signature-verified webhook path and
				// only after the add-on validated against a trusted product, so a forged event
				// can never lift the freeze. Idempotent (no-op when not frozen). The add-on's
				// own credit grant runs in applyAddonGrantsFromEvent; the credit DEBT is not
				// wiped (future grants pay it down). No plan status is written here (no plan).
				await this.unfreezeWorkspace(tx, workspaceId, event);
				return;
			}
			// Untrustworthy grant (unknown product AND no valid USD amount AND no trusted
			// add-on, e.g. a forged zero-amount Studio event). Record the rejection in
			// metadata for audit but do NOT grant any paid entitlement or unfreeze. Existing
			// access (if any) is left untouched.
			await tx.unsafe(`
				UPDATE workspace_billing_accounts
				SET metadata = metadata || $2::text::jsonb, updated_at = now()
				WHERE workspace_id = $1
			`, [workspaceId, JSON.stringify({
				provider: "dodo",
				dodo_event_id: event.id,
				dodo_event_type: event.type,
				dodo_payment_id: extractPaymentId(event),
				dodo_payment_grant_rejected: validation.reason,
			})]);
			return;
		}

		// Stale-payment guard (mirror of the subscription.active guard): a delayed/
		// replayed success must NOT resurrect a terminally-cancelled account unless the
		// payment proves a genuinely current/future paid period or an active linked
		// subscription. Without this, a stale success silently re-grants paid access.
		const current = await findBillingAccountState(tx, workspaceId);
		if (current?.status === "cancelled") {
			const subject = getEventSubject(event);
			const incomingPeriodEnd = extractTimestamp(subject, ["current_period_end", "currentPeriodEnd", "period_end", "next_billing_date", "nextBillingDate"]);
			const incomingPeriodActive = isFutureTimestamp(incomingPeriodEnd, this.now())
				|| isFutureTimestamp(current.current_period_end, this.now());
			const linkedSubscriptionActive = await hasActiveLinkedSubscription(tx, workspaceId);
			if (!incomingPeriodActive && !linkedSubscriptionActive) {
				await tx.unsafe(`
					UPDATE workspace_billing_accounts
					SET metadata = metadata || $2::text::jsonb, updated_at = now()
					WHERE workspace_id = $1
				`, [workspaceId, JSON.stringify({
					provider: "dodo",
					dodo_event_id: event.id,
					dodo_event_type: event.type,
					dodo_payment_id: extractPaymentId(event),
					dodo_payment_grant_rejected: "stale_payment_on_cancelled_account",
				})]);
				return;
			}
		}

		await this.updateWorkspaceStatusFromEvent(tx, event, "active", {
			receiptQueued: true,
			// A successful renewal clears any in-flight dunning grace.
			dunning_grace_until: null,
			dunning_failed_at: null,
		}, validation.planKey); // grant the VALIDATED plan key, never re-derive from metadata

		// UNFREEZE path: a subsequent SUCCESSFUL, validated payment means the customer paid
		// again → lift any refund/chargeback freeze so they regain edit access. Reached only
		// from the signature-verified webhook path AND only after the grant validated (a
		// forged zero-amount event returned above without reaching here), so a freeze can
		// never be lifted by an unverified/untrusted event. Idempotent (no-op when not
		// frozen). The credit DEBT is intentionally NOT wiped here — future grants pay it
		// down first; only the access freeze is lifted.
		await this.unfreezeWorkspace(tx, workspaceId, event);

		// Queue the EXISTING billing-receipt email + payment_succeeded in-app notice.
		// Replaces the dead `receiptQueued` flag with a REAL after-commit, fire-once
		// send (flushed by processWebhook only on the fresh-insert path). Resolve the
		// recipient + data HERE (tx still open); the flush itself touches no DB.
		await this.enqueuePaymentReceipt(tx, event, workspaceId, validation.planKey, pending);
	}

	// Resolve the receipt recipient + money/period from EXISTING data and queue the
	// dedicated billing-receipt template. Best-effort: a resolution failure logs and
	// skips the notification rather than disturbing the committed payment grant.
	private async enqueuePaymentReceipt(
		tx: DodoSqlClient,
		event: DodoWebhookEvent,
		workspaceId: string,
		planKey: DodoPlanKey | undefined,
		pending: PendingBillingNotification[],
	): Promise<void> {
		try {
			const subject = getEventSubject(event);
			const billingEmail = readStringField(subject, ["customer_email", "email"])
				?? await findBillingEmail(tx, workspaceId);
			const recipient = await resolveWorkspaceBillingRecipient(
				tx as unknown as BillingNotificationSqlClient,
				workspaceId,
				billingEmail,
			);
			const amountCentsRaw = readMinorUnits(subject, ["total_amount", "amount", "settlement_amount"]);
			const amountCents = amountCentsRaw != null ? Number(amountCentsRaw) : null;
			const currency = readStringField(subject, ["currency", "settlement_currency"]) ?? null;
			const workspaceName = await findWorkspaceName(tx, workspaceId) ?? workspaceId;
			const invoiceUrl = readStringField(subject, ["invoice_url", "invoiceUrl", "receipt_url", "receiptUrl"]);
			const periodStart = extractTimestamp(subject, ["current_period_start", "currentPeriodStart", "period_start", "previous_billing_date"]);
			const periodEnd = extractTimestamp(subject, ["current_period_end", "currentPeriodEnd", "period_end", "next_billing_date", "nextBillingDate"]);
			const planId = planKey ? DODO_TO_INTERNAL_PLAN[planKey] : null;
			// Stable per-payment idempotency anchor so a (provider-level) duplicate send
			// is deduped too; mirrors extractAddonGrantRef (payment_id-first). Drives the
			// EMAIL provider dedupe key (unchanged).
			const ref = extractAddonGrantRef(event) ?? event.id ?? workspaceId;
			// In-app receipt dedupe (P2): one charge can arrive as payment.succeeded
			// (payment_id) AND invoice.paid (invoice_id-only). Those derive DIVERGENT primary
			// refs, so a single shared write key won't collapse them. We (1) prefer the
			// invoice_id as the in-app PRIMARY ref when present — both event types carry it,
			// so independent deliveries converge on the SAME write key — and (2) pass EVERY
			// candidate ref (payment_id AND invoice_id AND event.id) so the existence pre-check
			// suppresses the row if a sibling delivery already wrote one under a different
			// primary (the reversed shape). Mirrors extractAddonGrantCandidateRefs exactly.
			const candidateRefs = extractAddonGrantCandidateRefs(event);
			const subjectInvoiceId = readStringField(subject, ["invoice_id", "invoiceId"]);
			const inAppRef = subjectInvoiceId ?? ref;
			const idempotencyKeyCandidates = Array.from(new Set([inAppRef, ...candidateRefs]))
				.map((candidate) => `dodo-receipt:${candidate}`);
			const send = this.sendPaymentReceipt;
			pending.push({
				kind: "receipt",
				send: () => send({
					recipient,
					workspaceId,
					workspaceName,
					planId,
					amount: amountCents != null && Number.isFinite(amountCents) ? Math.round(amountCents) / 100 : null,
					currency,
					invoiceUrl,
					periodStart,
					periodEnd,
					idempotencyKey: `dodo-receipt:${ref}`,
					inAppIdempotencyKey: `dodo-receipt:${inAppRef}`,
					idempotencyKeyCandidates,
				}),
			});
		} catch (error) {
			console.warn(`[dodo] failed to queue payment receipt for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ── Add-on grant write path (P0: paid-but-not-granted) ───────────────────────
	//
	// One recognized add-on line + its validated purchase quantity (clamped positive
	// integer). The grant path multiplies the per-unit effect by `quantity`.
	//
	// A successful payment can carry purchased ADD-ONS — AI credit packs (`credits-50`,
	// `credits-200`), storage packs (`storage-25gb`, `storage-100gb`), seats, team-jobs,
	// or the BYO Studio add-on. Before this path, an add-on purchase cleared payment but
	// the buyer received NOTHING (financial/data loss). This grants each recognized
	// add-on to the workspace from the TRUSTED product id (Dodo owns that product's
	// price), never from forge-able metadata, and idempotently (a replayed webhook grants
	// exactly once). Only AI-credit and storage add-ons have a grant effect here; seats /
	// team-jobs / byo-api are entitlement flags surfaced through the plan/quota read paths
	// and have no credit/storage write, so they are recognized-but-no-op (never an
	// over-grant of credits).
	private async applyAddonGrantsFromEvent(tx: DodoSqlClient, event: DodoWebhookEvent, workspaceId: string | null): Promise<void> {
		if (!workspaceId) return; // unlinked — a later delivery carries the workspace linkage
		const grants = this.validateAddonGrants(event);
		const descriptors = this.computeAddonGrantDescriptors(event, grants);
		if (descriptors.length === 0) return;
		// MONEY-CRITICAL (P1 lost-dispute-still-grants): refuse any descriptor whose anchor
		// was tombstoned by a terminally-LOST dispute. The hold is gone (chargeback_pending
		// false) so the redelivered `payment.succeeded` reaches this NORMAL path, but the
		// add-on it carries was clawed back — granting it would re-mint a refunded grant.
		// The tombstone is the EXACT per-occurrence anchors of the lost payment's grants, so
		// only the disputed payment is blocked; an unrelated new add-on (different anchors)
		// grants normally, and a favorable outcome never tombstones so its replays proceed.
		//
		// MONEY-CRITICAL (P1 never-held loss → first-seen replay grants the clawed-back add-on):
		// the EXACT-anchor tombstone above is created ONLY from DEFERRED descriptors recorded
		// while the chargeback hold was open. If the disputed `payment.succeeded` was NEVER seen
		// during the hold (it arrives for the FIRST time AFTER a `dispute.lost` cleared the hold),
		// there is no deferred record, so the loss wrote NO exact anchor and nothing here blocks
		// the grant. The terminal loss therefore ALSO persists a COARSER, payment-REF-scoped
		// tombstone (`denied_addon_payment_refs`) keyed on the disputed payment's stable ref. We
		// derive the SAME ref this event's anchors use and refuse EVERY descriptor when that ref
		// is denied — closing the never-held leak while staying scoped to ONLY the disputed
		// payment (a different payment_id → different ref → never blocked). The exact-anchor guard
		// is kept (precision/backcompat) as an additional, finer filter.
		const deniedRefs = await this.readDeniedAddonPaymentRefs(tx, workspaceId);
		if (deniedRefs.size > 0) {
			// SYMMETRIC ref match: the loss tombstone records EVERY candidate ref the disputed
			// payment's descriptors could have used (payment_id AND invoice_id). The disputed
			// payment.succeeded and its later first-seen invoice.paid/payment.succeeded replay
			// share these identifiers but may DERIVE different primary refs (payment_id vs
			// invoice_id). So refuse when ANY of this event's candidate refs is tombstoned — not
			// just the single `extractAddonGrantRef` primary — closing the invoice-only leak where
			// a no-payment-id add-on anchored on invoice_id but the redelivery presents payment_id
			// (or vice-versa). A genuinely different payment (different payment_id AND different
			// invoice_id) matches nothing and grants normally.
			for (const candidate of extractAddonGrantCandidateRefs(event)) {
				if (deniedRefs.has(candidate)) return; // whole disputed payment is clawed back
			}
		}
		const denied = await this.readDeniedAddonGrantAnchors(tx, workspaceId);
		const allowed = denied.size === 0
			? descriptors
			: descriptors.filter((descriptor) => !denied.has(descriptor.anchor));
		if (allowed.length === 0) return;
		await this.applyAddonGrantDescriptors(tx, workspaceId, allowed);
	}

	// Read the tombstone of payment REFS denied by a terminally-lost dispute (the coarse,
	// never-held guard companion to readDeniedAddonGrantAnchors). A redelivered/first-seen
	// `payment.succeeded` for a disputed-and-lost payment derives the SAME ref; the grant
	// path refuses ALL its add-on descriptors. Returns a Set for O(1) membership; tolerant
	// of legacy/missing metadata (empty set).
	private async readDeniedAddonPaymentRefs(tx: DodoSqlClient, workspaceId: string): Promise<Set<string>> {
		const rows = await tx.unsafe<{ metadata: Record<string, unknown> | string | null }>(`
			SELECT metadata
			FROM workspace_billing_accounts
			WHERE workspace_id = $1
			LIMIT 1
		`, [workspaceId]);
		const metadata = parseMetadata(rows[0]?.metadata);
		const raw = metadata.denied_addon_payment_refs;
		if (!Array.isArray(raw)) return new Set();
		const out = new Set<string>();
		for (const entry of raw) {
			if (typeof entry === "string" && entry.length > 0) out.add(entry);
		}
		return out;
	}

	// Read the tombstone of add-on grant anchors DENIED by a terminally-lost dispute. A
	// new-webhook-id replay of a clawed-back payment re-derives these exact anchors; the
	// grant path refuses any match so a lost dispute can never grant via the normal path.
	// Returns a Set for O(1) membership; tolerant of legacy/missing metadata (empty set).
	private async readDeniedAddonGrantAnchors(tx: DodoSqlClient, workspaceId: string): Promise<Set<string>> {
		const rows = await tx.unsafe<{ metadata: Record<string, unknown> | string | null }>(`
			SELECT metadata
			FROM workspace_billing_accounts
			WHERE workspace_id = $1
			LIMIT 1
		`, [workspaceId]);
		const metadata = parseMetadata(rows[0]?.metadata);
		const raw = metadata.denied_addon_grant_anchors;
		if (!Array.isArray(raw)) return new Set();
		const out = new Set<string>();
		for (const entry of raw) {
			if (typeof entry === "string" && entry.length > 0) out.add(entry);
		}
		return out;
	}

	// Flatten the resolved add-on lines into concrete, idempotency-anchored grant
	// descriptors. The anchor for every grant derives from THIS payment (payment id, else
	// invoice id, else the webhook event id) + the add-on id + occurrence index, so two
	// distinct packs (or two of the same pack) on one payment each grant once, and a
	// replay re-derives the SAME keys → no double-grant. Credit packs collapse the
	// purchased quantity into ONE grant of `quantity × packSize` (the credit store dedupes
	// on the key, so a multi-unit line is granted once, never multiplied on replay);
	// storage packs expand into `quantity` DISTINCT per-unit anchors (each row dedupes on
	// its PK → exactly N packs, never 2N on replay). Descriptors are a pure projection of
	// the trusted event — safe to persist for a deferred (chargeback-held) grant and
	// replay verbatim later, because the anchors stay stable.
	private computeAddonGrantDescriptors(event: DodoWebhookEvent, grants: ResolvedAddonGrant[]): AddonGrantDescriptor[] {
		if (grants.length === 0) return [];
		const ref = extractAddonGrantRef(event);
		if (!ref) return []; // no stable dedupe anchor → cannot grant idempotently; skip
		const descriptors: AddonGrantDescriptor[] = [];
		for (let index = 0; index < grants.length; index += 1) {
			const entry = grants[index];
			if (!entry) continue;
			const { addon, quantity } = entry;
			// quantity is already a clamped positive integer (parseAddonQuantity); guard
			// once more so a future caller can never multiply a grant by a bad value.
			const units = Number.isInteger(quantity) && quantity >= 1 ? Math.min(quantity, MAX_ADDON_LINE_QUANTITY) : 1;
			if (addon.kind === "ai_credits" && typeof addon.aiCredits === "number" && addon.aiCredits > 0) {
				descriptors.push({
					kind: "ai_credits",
					addonId: addon.id,
					amount: Math.floor(addon.aiCredits) * units,
					anchor: `dodo-addon:${ref}:${addon.id}:${index}`,
				});
			} else if (addon.kind === "storage" && typeof addon.storageBytes === "number" && addon.storageBytes > 0) {
				const bytes = Math.max(0, Math.floor(addon.storageBytes));
				for (let unit = 0; unit < units; unit += 1) {
					descriptors.push({
						kind: "storage",
						addonId: addon.id,
						bytes,
						anchor: `dodo-addon:${ref}:${addon.id}:${index}:q${unit}`,
					});
				}
			}
			// seat / team_jobs / byo_api: recognized but no credit/storage write here.
		}
		return descriptors;
	}

	// Apply pre-computed grant descriptors idempotently. Each credit grant dedupes on its
	// anchor (credit store), each storage pack on its anchor PK. Replaying the SAME
	// descriptors — whether from a webhook replay or a deferred-grant replay on dispute
	// resolution — re-derives the SAME anchors → granted exactly once total.
	private async applyAddonGrantDescriptors(tx: DodoSqlClient, workspaceId: string, descriptors: AddonGrantDescriptor[]): Promise<void> {
		for (const descriptor of descriptors) {
			if (descriptor.kind === "ai_credits" && typeof descriptor.amount === "number" && descriptor.amount > 0) {
				await this.grantCredits({
					workspaceId,
					ownerScope: "workspace",
					ownerId: workspaceId,
					creditClass: "shareable",
					amount: descriptor.amount,
					source: "addon_purchase",
					idempotencyKey: descriptor.anchor,
				});
			} else if (descriptor.kind === "storage" && typeof descriptor.bytes === "number" && descriptor.bytes > 0) {
				await this.grantStoragePackById(tx, workspaceId, descriptor.addonId, descriptor.bytes, descriptor.anchor);
			}
		}
	}

	// Insert a paid storage pack idempotently. The PK is the stable per-payment anchor,
	// so a replayed webhook (or a retried tx) re-derives the SAME id and ON CONFLICT DO
	// NOTHING keeps the pack-count and effective quota correct. Storage packs are monthly
	// add-ons that stay active until cancelled/expired; expiry is managed elsewhere (the
	// cron de-activator), so this inserts an active, non-expiring row.
	private async grantStoragePackById(tx: DodoSqlClient, workspaceId: string, addonId: string, bytes: number, anchor: string): Promise<void> {
		await tx.unsafe(`
			INSERT INTO storage_packs (storage_pack_id, workspace_id, sku_id, pack_size_bytes, active, metadata)
			VALUES ($1, $2, $3, $4, true, $5::text::jsonb)
			ON CONFLICT (storage_pack_id) DO NOTHING
		`, [
			anchor,
			workspaceId,
			addonId,
			Math.max(0, Math.floor(bytes)),
			JSON.stringify({ provider: "dodo", source: "addon_purchase", addon_id: addonId }),
		]);
	}

	// Resolve the ADD-ONS a payment is allowed to grant — ONLY from TRUSTED product ids,
	// the same trust basis as validatePaidGrant. Gather every product id the event carries
	// in a trusted position: the top-level product_id, each product_cart[] entry's
	// product_id, AND each cart entry's nested addons[].addon_id. Map each through the
	// configured Dodo add-on product-id catalog (DODO_PRODUCT_IDS `addon_<key>`/`<key>`) to
	// its billing add-on. Forge-able metadata (`metadata.addons`, `metadata.addon_id`) is
	// NEVER consulted — that is the exact channel an attacker would use to mint free packs.
	// Returns the recognized add-on products + each line's purchased quantity (a clamped
	// positive integer). Order/occurrences are preserved so the grant path can derive a
	// stable per-occurrence idempotency anchor.
	private validateAddonGrants(event: DodoWebhookEvent): ResolvedAddonGrant[] {
		const subject = getEventSubject(event);
		const lines = collectTrustedAddonProductIds(subject);
		if (lines.length === 0) return [];
		const catalogByProductId = this.addonProductIdToCatalogId();
		const resolved: ResolvedAddonGrant[] = [];
		for (const line of lines) {
			const catalogId = catalogByProductId.get(line.productId);
			if (!catalogId) continue; // not one of OUR configured add-on products
			const addon = resolveBillingAddon(catalogId);
			if (addon) resolved.push({ addon, quantity: line.quantity });
		}
		return resolved;
	}

	// Reverse map: configured Dodo add-on PRODUCT id → catalog add-on SKU id. The config
	// stores add-on product ids under `addon_<key>` (and a bare `<key>` fallback, mirroring
	// getAddonProductId). The key may be the underscore Dodo form (`byo_api`) or the catalog
	// hyphen form (`storage-25gb`); normalizeBillingAddonId folds both to the catalog id so
	// the underscore-vs-hyphen mismatch (a18 #4) can never drop a match. Built per call (the
	// config map is tiny and may be swapped in tests).
	private addonProductIdToCatalogId(): Map<string, string> {
		const map = new Map<string, string>();
		const configured = this.config.dodo.productIds;
		for (const [rawKey, productId] of Object.entries(configured)) {
			if (!productId) continue;
			const key = rawKey.startsWith("addon_") ? rawKey.slice("addon_".length) : rawKey;
			const catalogId = normalizeBillingAddonId(key);
			if (catalogId && BILLING_ADDONS.some((addon) => addon.id === catalogId)) {
				map.set(productId, catalogId);
			}
		}
		return map;
	}

	// Validate that a `payment.succeeded`/`invoice.paid` is allowed to GRANT a paid
	// plan AND return the TRUSTED plan key that must be granted. The caller MUST grant
	// the returned `planKey` — never re-derive the plan from forge-able metadata — so
	// the validation and the grant can't diverge (the attack: validate on a cheap cart
	// product while metadata.plan_key claims an expensive one).
	//
	// Trust derivation, strongest first:
	//   (a) a top-level/cart product_id mapping to one of OUR configured Dodo products.
	//       Dodo owns that product's price, so the plan it encodes is authoritative and
	//       the amount is implicitly correct. The returned planKey is the PRODUCT's plan,
	//       NOT metadata. If metadata.plan_key is present and DISAGREES with the product,
	//       the event is REJECTED (a forged metadata escalation over a cheap product).
	//   (b) the metadata-only path (no configured product present): the forge-able
	//       metadata.plan_key is only honored when the currency is the expected USD and
	//       the amount clears that plan's price floor. The returned planKey is the
	//       metadata plan, now backed by a sufficient validated amount.
	private validatePaidGrant(event: DodoWebhookEvent): { trusted: boolean; planKey?: DodoPlanKey; reason?: string } {
		const subject = getEventSubject(event);
		const metadataPlanKey = extractMetadataPlanKey(event);

		// Strongest signal: a configured product id (top-level, else inside product_cart).
		// findPlanKeyByProductId only matches product ids present in DODO_PRODUCT_IDS,
		// i.e. products we sell at a known price.
		const productId = readStringField(subject, ["product_id", "productId"]) ?? readProductIdFromCart(subject);
		const productPlanKey = productId ? this.findPlanKeyByProductId(productId) : null;
		if (productPlanKey) {
			// Reject a metadata plan that disagrees with the trusted product — an attacker
			// signing a cheap product while claiming an expensive plan_key in metadata.
			if (metadataPlanKey && metadataPlanKey !== productPlanKey) {
				return { trusted: false, reason: `product_metadata_plan_mismatch:${productPlanKey}!=${metadataPlanKey}` };
			}
			return { trusted: true, planKey: productPlanKey };
		}

		// Metadata-only path (attacker-forgeable plan_key). Require a known plan, the
		// expected currency, and a positive amount that clears the plan's price floor.
		if (!metadataPlanKey) {
			return { trusted: false, reason: "no_known_product_or_plan" };
		}
		const currency = readStringField(subject, ["currency", "settlement_currency"]);
		if (!currency || currency.trim().toUpperCase() !== EXPECTED_PLAN_CURRENCY) {
			return { trusted: false, reason: `unexpected_currency:${currency ?? "missing"}` };
		}
		// Subscription events carry the recurring price under different keys than a
		// one-off payment, so include them — a metadata-only subscription grant is only
		// trusted when the recurring amount clears the plan floor.
		const amountCentsRaw = readMinorUnits(subject, [
			"total_amount",
			"amount",
			"settlement_amount",
			"recurring_pre_tax_amount",
			"recurringPreTaxAmount",
		]);
		if (!amountCentsRaw) {
			return { trusted: false, reason: "missing_amount" };
		}
		let amountCents: bigint;
		try {
			amountCents = BigInt(normalizeCents(amountCentsRaw));
		} catch {
			return { trusted: false, reason: "unparseable_amount" };
		}
		const floorCents = expectedPlanFloorCents(metadataPlanKey);
		if (amountCents < floorCents) {
			return { trusted: false, reason: `amount_below_floor:${amountCents}<${floorCents}` };
		}
		return { trusted: true, planKey: metadataPlanKey };
	}

	// ── subscription.plan_changed (P1: proration/effective semantics) ────────────
	// A plan change is one of: an immediate PAID upgrade (apply now), a SCHEDULED
	// change effective at the next billing date (store as pending, don't rewrite the
	// live plan), or an UNPAID proration preview / do_not_bill (don't rewrite at all).
	// The old code routed this through the active-sync path and applied the tier
	// immediately regardless, so a scheduled downgrade stripped the paid tier early
	// and an unpaid change granted a tier with no payment.
	private async applyPlanChangeFromEvent(tx: DodoSqlClient, event: DodoWebhookEvent): Promise<void> {
		const subject = getEventSubject(event);
		const workspaceId = extractWorkspaceId(event) ?? await findWorkspaceIdByEvent(tx, event);
		if (!workspaceId) return;

		const subscriptionId = extractSubscriptionId(event);
		const currentPeriodEnd = extractTimestamp(subject, ["current_period_end", "currentPeriodEnd", "period_end", "next_billing_date", "nextBillingDate"]);

		// MONEY-CRITICAL: an IMMEDIATE plan change writes active+paid, so the TARGET plan
		// must be validated against a trusted product id OR a sufficient validated paid
		// amount — exactly like payment.succeeded. The validated key is what we grant; we
		// never re-derive the granted plan from forge-able metadata. A change with no
		// trusted product AND no validated amount can only be stored as PENDING (it never
		// writes a paid tier immediately) — a later validated payment.succeeded grants it.
		const validation = this.validatePaidGrant(event);
		const validatedPlanKey = validation.trusted ? validation.planKey : undefined;
		const validatedInternalPlan = validatedPlanKey ? DODO_TO_INTERNAL_PLAN[validatedPlanKey] : undefined;

		// The plan the event NAMES (product/cart/metadata resolution) — used only to
		// record the pending target when we can't grant immediately. Never granted directly.
		const namedPlanKey = this.extractPlanKey(event);
		const namedInternalPlan = namedPlanKey ? DODO_TO_INTERNAL_PLAN[namedPlanKey] : undefined;

		// Effective-now ⇔ the change takes effect immediately AND is billed now.
		// Dodo's proration mode tells us the billing intent:
		//   prorated_immediately / full_immediately / difference_immediately → billed now
		//   do_not_bill → not billed (scheduled or free preview)
		// `effective_date`/`effective_at`, when present and in the future, marks a
		// scheduled change. Absent both, default to immediate-and-paid (back-compat with
		// the prior behavior for plain plan_changed events that carry neither).
		const prorationMode = readStringField(subject, ["proration_billing_mode", "prorationBillingMode"]);
		const effectiveAt = extractTimestamp(subject, ["effective_date", "effectiveDate", "effective_at", "effectiveAt", "scheduled_at", "scheduledAt"]);
		const billedNow = prorationMode ? prorationMode !== "do_not_bill" : true;
		const scheduledFuture = isFutureTimestamp(effectiveAt, this.now());
		// Apply immediately ONLY when billed-now, not future-scheduled, AND the target plan
		// was VALIDATED (trusted product or sufficient amount). Otherwise → pending.
		const applyNow = billedNow && !scheduledFuture && validatedInternalPlan !== undefined;

		if (applyNow) {
			// Immediate paid change: rewrite the live plan to the VALIDATED key, keep active.
			await upsertBillingAccount(tx, {
				workspaceId,
				planId: validatedInternalPlan,
				status: "active",
				billingEmail: readStringField(subject, ["customer_email", "email"]),
				currentPeriodStart: extractTimestamp(subject, ["current_period_start", "currentPeriodStart", "period_start"]),
				currentPeriodEnd,
				metadata: {
					provider: "dodo",
					dodo_event_id: event.id,
					dodo_event_type: event.type,
					dodo_plan_key: validatedPlanKey ?? undefined,
					dodo_subscription_id: subscriptionId,
					pending_plan_id: null,
					pending_plan_effective_at: null,
				},
			});
			return;
		}

		// Scheduled / unpaid change: DO NOT touch the live plan_id. Record the pending
		// plan in metadata so a cron / next renewal can apply it at the effective date.
		// upsertBillingAccount with planId=undefined preserves the stored plan_id via
		// COALESCE, and never invents a paid tier on a brand-new row (falls back to free).
		await upsertBillingAccount(tx, {
			workspaceId,
			planId: undefined,
			status: "active",
			billingEmail: readStringField(subject, ["customer_email", "email"]),
			currentPeriodEnd,
			metadata: {
				provider: "dodo",
				dodo_event_id: event.id,
				dodo_event_type: event.type,
				dodo_subscription_id: subscriptionId,
				pending_plan_id: namedInternalPlan ?? null,
				pending_plan_key: namedPlanKey ?? null,
				pending_plan_effective_at: effectiveAt ?? null,
				pending_plan_proration_mode: prorationMode ?? null,
				// Record WHY an immediate change was downgraded to pending: a billed-now,
				// non-scheduled change that nonetheless lacked a validated product/amount
				// for the target plan is held (not granted) until a validated payment.
				...(billedNow && !scheduledFuture && validatedInternalPlan === undefined
					? { plan_change_grant_rejected: validation.reason ?? "unvalidated_immediate_plan_change" }
					: {}),
			},
		});
	}

	// ── payment.failed dunning grace (P1) ────────────────────────────────────────
	// A failed RENEWAL charge does not instantly revoke paid access (the prior code
	// set past_due, which the plan-resolution joins exclude → instant downgrade to
	// free). We keep the account `active` through a grace deadline so a retry can
	// succeed; only a failure that lands AFTER the grace deadline downgrades to
	// past_due. Explicit cancel/expiry still revoke immediately via their own paths.
	private async applyPaymentFailureFromEvent(tx: DodoSqlClient, event: DodoWebhookEvent, pending: PendingBillingNotification[] = []): Promise<void> {
		const workspaceId = extractWorkspaceId(event) ?? await findWorkspaceIdByEvent(tx, event);
		if (!workspaceId) return;
		const current = await findBillingAccountState(tx, workspaceId);

		// Already cancelled/expired (or no account): nothing to protect — fall through to
		// the prior past_due behavior so a failure on a non-active account is still recorded.
		const hasActiveAccess = current?.status != null
			&& (ACCESS_GRANTING_STATUSES as readonly string[]).includes(current.status);
		if (!hasActiveAccess) {
			await this.updateWorkspaceStatusFromEvent(tx, event, "past_due", {
				dunning_failed_at: this.now().toISOString(),
			});
			return;
		}

		// Read the existing grace deadline from metadata. The first failure opens the
		// grace window; a later failure past the deadline (dunning exhausted) revokes.
		const account = await findBillingAccount(tx, { workspaceId });
		const existingDeadlineRaw = readStringField(account?.metadata, ["dunning_grace_until"]);
		const existingDeadline = existingDeadlineRaw ? Date.parse(existingDeadlineRaw) : NaN;
		const now = this.now();
		const graceExpired = Number.isFinite(existingDeadline) && existingDeadline <= now.getTime();

		if (graceExpired) {
			// Dunning exhausted — the grace window already lapsed and the charge is still
			// failing. Now revoke paid access (past_due → plan resolution drops to free).
			await this.updateWorkspaceStatusFromEvent(tx, event, "past_due", {
				dunning_grace_until: existingDeadlineRaw,
				dunning_failed_at: now.toISOString(),
				dunning_expired: true,
			});
			// Final dunning notice: access is being revoked now (0 days left).
			await this.enqueuePaymentFailed(tx, event, workspaceId, 0, pending);
			return;
		}

		// Open (or keep) the grace window and PRESERVE access (status stays active). Do
		// not move plan_id. A grace deadline already in flight is kept (not extended) so
		// repeated failures can't perpetually push the revocation out.
		const isFirstFailure = !Number.isFinite(existingDeadline);
		const graceUntil = Number.isFinite(existingDeadline)
			? existingDeadlineRaw!
			: new Date(now.getTime() + DUNNING_GRACE_MS).toISOString();
		await tx.unsafe(`
			UPDATE workspace_billing_accounts
			SET metadata = metadata || $2::text::jsonb, updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, JSON.stringify({
			provider: "dodo",
			dodo_event_id: event.id,
			dodo_event_type: event.type,
			dunning_grace_until: graceUntil,
			dunning_failed_at: now.toISOString(),
			dunning_expired: false,
		})]);

		// Email ONLY on the FIRST failure (the transition that OPENS the grace window),
		// not on every repeated failure inside an already-open window — so a flapping
		// card can't spam the owner. Each webhook-id is still fire-once via `processed`.
		if (isFirstFailure) {
			const daysLeft = Math.max(0, Math.ceil((Date.parse(graceUntil) - now.getTime()) / (24 * 60 * 60 * 1000)));
			await this.enqueuePaymentFailed(tx, event, workspaceId, daysLeft, pending);
		}
	}

	// Resolve the recipient + queue the dedicated payment-failed template. Best-effort.
	private async enqueuePaymentFailed(
		tx: DodoSqlClient,
		event: DodoWebhookEvent,
		workspaceId: string,
		daysUntilDowngrade: number,
		pending: PendingBillingNotification[],
	): Promise<void> {
		try {
			const subject = getEventSubject(event);
			const billingEmail = readStringField(subject, ["customer_email", "email"])
				?? await findBillingEmail(tx, workspaceId);
			const recipient = await resolveWorkspaceBillingRecipient(
				tx as unknown as BillingNotificationSqlClient,
				workspaceId,
				billingEmail,
			);
			const workspaceName = await findWorkspaceName(tx, workspaceId) ?? workspaceId;
			const ref = extractAddonGrantRef(event) ?? event.id ?? workspaceId;
			const send = this.sendPaymentFailed;
			pending.push({
				kind: "failed",
				send: () => send({
					recipient,
					workspaceId,
					workspaceName,
					retryUrl: "/settings/billing",
					daysUntilDowngrade,
					idempotencyKey: `dodo-payfail:${ref}`,
				}),
			});
		} catch (error) {
			console.warn(`[dodo] failed to queue payment-failed notice for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ── Full-refund entitlement revocation (P1) ──────────────────────────────────
	// recordRefundTransaction persists the negative revenue row but never touched the
	// active billing account, so a fully-refunded workspace kept its paid plan. After
	// recording the refund we roll up cumulative refunds for the payment and, once they
	// clear the gross paid, atomically cancel the billing account (revoking the plan).
	private async revokeEntitlementOnFullRefund(tx: DodoSqlClient, event: DodoWebhookEvent): Promise<void> {
		const paymentId = extractPaymentId(event);
		const workspaceId = extractWorkspaceId(event)
			?? await findWorkspaceIdByEvent(tx, event)
			?? await findWorkspaceIdByPaymentId(tx, paymentId);
		if (!workspaceId || !paymentId) {
			// Without a payment id we cannot roll up refunds against a specific charge, and
			// without a workspace we have nothing to revoke. The revenue row is still durable.
			return;
		}

		// OWNER POLICY (refund): a refund is a money-reversal → FULLY claw back the AI
		// credits this payment granted (balance may go NEGATIVE = a debt) AND FREEZE the
		// workspace + all its projects. Both run for ANY refund of this charge (full OR
		// partial — a partial refund of a credit pack still reverses that pack), are
		// idempotent on a webhook replay (clawback is keyed per grant anchor; freeze is a
		// set-if-not-set), and are reached ONLY from the signature-verified webhook path.
		await this.clawbackAddonGrantsForPayment(event, "refund");
		await this.freezeWorkspace(tx, workspaceId, "payment_refund", event);

		const rollup = await refundRollupForPayment(tx, paymentId);
		// Only revoke the PLAN entitlement when cumulative refunds (+ any chargebacks
		// against the charge) clear the gross paid — a PARTIAL refund leaves the plan
		// intact. grossPaid<=0 means we have no recorded payment to compare against, so we
		// don't revoke on it alone. (The freeze above already blocks all edits regardless.)
		if (rollup.grossPaidCents <= 0n) return;
		if (rollup.refundedAbsCents + rollup.disputedAbsCents < rollup.grossPaidCents) return;

		await tx.unsafe(`
			UPDATE workspace_billing_accounts
			SET status = 'cancelled',
				metadata = metadata || $2::text::jsonb,
				updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, JSON.stringify({
			provider: "dodo",
			dodo_event_id: event.id,
			dodo_event_type: event.type,
			dodo_payment_id: paymentId,
			refunded_full: true,
		})]);
	}

	// ── Workspace FREEZE / credit-clawback helpers (refund + chargeback) ─────────
	//
	// OWNER-authorized: on a verified refund/chargeback we (1) FULLY claw back the AI
	// credits the disputed payment granted (NEGATIVE-allowed debt) and (2) FREEZE the
	// workspace so ALL mutating operations on it + its projects are blocked for EVERYONE
	// (owner + every member). Both are idempotent on a webhook replay.

	// Claw back EVERY AI-credit grant minted under the disputed payment's add-on anchors.
	// The grants were minted with idempotencyKey `dodo-addon:<paymentRef>:<addon>:<index>`
	// (extractAddonGrantRef = payment_id ?? invoice_id ?? event.id), so we claw back by the
	// candidate-ref prefixes this event can derive. FULL clawback allows the balance to go
	// negative (a persistent debt); a future grant pays the debt down first. Idempotent:
	// clawbackGrantsByKeyPrefix is a no-op per grant once its clawback debit exists, so a
	// webhook replay never double-reverses. A plan-only refund (no credit add-on) matches
	// no grant and is a silent no-op.
	private async clawbackAddonGrantsForPayment(event: DodoWebhookEvent, reason: string): Promise<void> {
		const refs = extractAddonGrantCandidateRefs(event);
		for (const ref of refs) {
			await this.clawbackGrantsByKeyPrefix(`dodo-addon:${ref}:`, `${reason}:${event.type}`);
		}
	}

	// Durably FREEZE a workspace: set workspaces.suspended_at + suspended_reason. Idempotent
	// — only sets suspended_at when it is currently NULL (a replayed refund/chargeback, or a
	// later chargeback on an already-refund-frozen workspace, keeps the ORIGINAL suspension
	// instant + reason so the freeze isn't perpetually re-stamped). The enforcement layer
	// (requirePermission) reads suspended_at and blocks every mutating permission while set.
	private async freezeWorkspace(
		tx: DodoSqlClient,
		workspaceId: string,
		reason: "payment_refund" | "chargeback",
		event: DodoWebhookEvent,
	): Promise<void> {
		await tx.unsafe(`
			UPDATE workspaces
			SET suspended_at = COALESCE(suspended_at, now()),
				suspended_reason = COALESCE(suspended_reason, $2),
				updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, reason]);
		// Mirror the freeze onto the billing account metadata for the dashboard/back-office
		// (a single read surfaces both billing status and the freeze + its reason).
		await tx.unsafe(`
			UPDATE workspace_billing_accounts
			SET metadata = metadata || $2::text::jsonb, updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, JSON.stringify({
			provider: "dodo",
			workspace_suspended: true,
			workspace_suspended_reason: reason,
			dodo_event_id: event.id,
			dodo_event_type: event.type,
		})]);
	}

	// Clear a workspace freeze (suspended_at → NULL). Reached on a subsequent SUCCESSFUL
	// payment / reactivation (the customer paid again) — NEVER by an unverified path. The
	// back-office unfreeze uses its own admin-gated route. Idempotent (a no-op when already
	// clear). Also clears the billing-metadata mirror.
	private async unfreezeWorkspace(tx: DodoSqlClient, workspaceId: string, event: DodoWebhookEvent): Promise<void> {
		await tx.unsafe(`
			UPDATE workspaces
			SET suspended_at = NULL,
				suspended_reason = NULL,
				updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId]);
		await tx.unsafe(`
			UPDATE workspace_billing_accounts
			SET metadata = metadata || $2::text::jsonb, updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, JSON.stringify({
			provider: "dodo",
			workspace_suspended: false,
			workspace_unsuspended_by: "payment",
			dodo_event_id: event.id,
			dodo_event_type: event.type,
		})]);
	}

	// Late payment.succeeded / invoice.paid that arrives while a chargeback is
	// still open: keep the account cancelled (no re-activation) but persist the
	// payment id and receipt-queued flag in metadata so the event is not lost.
	private async recordPaymentDuringChargeback(tx: DodoSqlClient, event: DodoWebhookEvent, workspaceId: string, deferredGrants: AddonGrantDescriptor[] = []): Promise<void> {
		// Accumulate any add-on grants this held payment owes into the account's
		// deferred-grant ledger (keyed by the stable per-occurrence anchor so re-recording
		// the same held payment never duplicates an entry). resolveChargeback drains this
		// list on a favorable outcome and clears it on a terminal loss.
		//
		// MONEY-CRITICAL (P1 lost-update + symmetric lock): the deferred-grant accumulation
		// is a read-modify-write of `metadata.deferred_addon_grants` (read via
		// mergeDeferredAddonGrants, written by the UPDATE below). It MUST serialize against
		// (a) another concurrent held add-on payment for the SAME workspace — otherwise both
		// read the same old array and the last `metadata || ...` write CLOBBERS the other
		// paid deferred grant — AND (b) a concurrent `resolveChargeback`, which clears the
		// hold + reconciles the same ledger. The caller (`handleWebhookEvent`, payment.succeeded
		// branch) already took `lockBillingAccountRow` on THIS tx BEFORE its
		// `hasPendingChargeback` decision when the payment carries add-on grants, so reaching
		// this method on the held branch means the FOR-UPDATE row lock is ALREADY held for the
		// rest of the txn. Postgres `SELECT ... FOR UPDATE` is re-entrant within a txn (a
		// second request on an already-held row is a no-op), so we re-assert it here for any
		// other/future caller without risk of self-block; it mirrors the FOR-UPDATE
		// serialization the credit-coupon / storage-CoW billing paths use. We only need the
		// lock when there is something to accumulate.
		if (deferredGrants.length > 0) {
			await lockBillingAccountRow(tx, workspaceId);
		}
		const pending = deferredGrants.length > 0
			? await this.mergeDeferredAddonGrants(tx, workspaceId, deferredGrants)
			: undefined;
		await tx.unsafe(`
			UPDATE workspace_billing_accounts
			SET metadata = metadata || $2::text::jsonb,
				updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, JSON.stringify({
			provider: "dodo",
			dodo_event_id: event.id,
			dodo_event_type: event.type,
			dodo_payment_id: extractPaymentId(event),
			receiptQueued: true,
			chargeback_pending: true,
			...(pending !== undefined ? { deferred_addon_grants: pending } : {}),
		})]);
	}

	// Read the account's currently-pending deferred add-on grants, union in the new ones
	// (dedup by anchor), and return the merged list. Pure read + merge; the caller writes
	// it back in the same metadata update.
	private async mergeDeferredAddonGrants(tx: DodoSqlClient, workspaceId: string, incoming: AddonGrantDescriptor[]): Promise<AddonGrantDescriptor[]> {
		const existing = await this.readDeferredAddonGrants(tx, workspaceId);
		const byAnchor = new Map<string, AddonGrantDescriptor>();
		for (const grant of existing) byAnchor.set(grant.anchor, grant);
		for (const grant of incoming) byAnchor.set(grant.anchor, grant);
		return [...byAnchor.values()];
	}

	// Parse the persisted deferred add-on grants from the account metadata, defensively
	// (only well-formed descriptors with a non-empty anchor + known kind survive). Never
	// throws on malformed data — a corrupt entry is simply dropped, never granted.
	private async readDeferredAddonGrants(tx: DodoSqlClient, workspaceId: string): Promise<AddonGrantDescriptor[]> {
		const rows = await tx.unsafe<{ metadata: Record<string, unknown> | string | null }>(`
			SELECT metadata
			FROM workspace_billing_accounts
			WHERE workspace_id = $1
			LIMIT 1
		`, [workspaceId]);
		const metadata = parseMetadata(rows[0]?.metadata);
		const raw = metadata.deferred_addon_grants;
		if (!Array.isArray(raw)) return [];
		const result: AddonGrantDescriptor[] = [];
		for (const entry of raw) {
			if (!entry || typeof entry !== "object") continue;
			const obj = entry as Record<string, unknown>;
			const anchor = typeof obj.anchor === "string" ? obj.anchor : null;
			const addonId = typeof obj.addonId === "string" ? obj.addonId : null;
			const kind = obj.kind === "ai_credits" || obj.kind === "storage" ? obj.kind : null;
			if (!anchor || !addonId || !kind) continue;
			if (kind === "ai_credits") {
				const amount = typeof obj.amount === "number" ? obj.amount : Number(obj.amount);
				if (!Number.isFinite(amount) || amount <= 0) continue;
				result.push({ kind, addonId, anchor, amount: Math.floor(amount) });
			} else {
				const bytes = typeof obj.bytes === "number" ? obj.bytes : Number(obj.bytes);
				if (!Number.isFinite(bytes) || bytes <= 0) continue;
				result.push({ kind, addonId, anchor, bytes: Math.floor(bytes) });
			}
		}
		return result;
	}

	private async recordChargeback(tx: DodoSqlClient, event: DodoWebhookEvent): Promise<void> {
		const subject = getEventSubject(event);
		const paymentId = extractPaymentId(event);
		const workspaceId = extractWorkspaceId(event)
			?? await findWorkspaceIdByEvent(tx, event)
			?? await findWorkspaceIdByPaymentId(tx, paymentId);
		const disputeId = readStringField(subject, ["dispute_id", "id", "chargeback_id"]) ?? event.id;
		const reason = readStringField(subject, ["reason", "dispute_reason"]);
		const status = readStringField(subject, ["status", "dispute_status"]) ?? "opened";
		const currency = readStringField(subject, ["currency"]) ?? null;
		// MONEY-CRITICAL (P1 invoice-only loss tombstone): the disputed add-on grant's
		// descriptor ref derives via `extractAddonGrantRef` = payment_id ?? invoice_id ??
		// event.id, so an add-on payment that carries NO payment_id was anchored on its
		// invoice_id. On a terminal loss we must tombstone EVERY candidate ref the disputed
		// payment's descriptors could have used — including its invoice_id. Persist the
		// disputed payment's invoice_id onto the dispute row HERE (alongside payment_id) so
		// `resolveChargeback` can recover it even when the resolution payload omits it.
		const invoiceId = readStringField(subject, ["invoice_id", "invoiceId"]) ?? null;
		// Dodo Dispute.amount is a decimal string of the MAJOR-unit amount (e.g.
		// "19.00"); convert to minor units (cents) as an INTEGER STRING, decimal-safe
		// (no float multiply) and CURRENCY-AWARE (JPY "1900" → 1900, not 190000).
		// Payment-style minor-unit fields are read as-is.
		const disputeAmountCents = readDisputeMinorUnits(subject, currency);

		// Persist the (negative) dispute revenue row FIRST and independently of the
		// workspace resolution. migration 0052 made workspace_id nullable precisely so
		// an out-of-order webhook (workspace not yet linkable) still records the money
		// movement — payments/refunds already tolerate a null workspace, and a dispute
		// must too or we silently drop a negative revenue record for the accountant.
		// Idempotent on (kind=dispute, dispute id).
		await upsertPaymentTransactionRow(tx, {
			workspaceId,
			dodoPaymentId: paymentId ?? null,
			dodoInvoiceId: invoiceId,
			dodoEventRef: disputeId ?? null,
			dodoEventId: event.id ?? null,
			kind: "dispute",
			amountCents: disputeAmountCents === null ? "0" : negateCents(disputeAmountCents),
			currency,
			status,
			occurredAt: extractTimestamp(subject, ["created_at", "createdAt", "timestamp"]) ?? null,
			raw: subject,
		});

		// The access-control side effects (chargeback hold, billing status, dispute
		// row) key on workspace_id, so they require a resolved workspace. The revenue
		// row above is already durable, so an unresolved workspace only defers the
		// hold (a later delivery / backfill carries the linkage) — it never loses money.
		if (!workspaceId) return;

		await tx.unsafe(`
			UPDATE workspaces
			SET chargeback_pending = true, updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId]);
		await tx.unsafe(`
			UPDATE workspace_billing_accounts
			SET status = 'cancelled',
				metadata = metadata || $2::text::jsonb,
				updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, JSON.stringify({
			provider: "dodo",
			dodo_event_id: event.id,
			dodo_event_type: event.type,
			dodo_payment_id: paymentId,
			chargeback_pending: true,
		})]);
		await tx.unsafe(`
			INSERT INTO chargeback_disputes (id, workspace_id, dodo_dispute_id, reason, status, amount_cents, currency, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, now())
			ON CONFLICT (dodo_dispute_id) DO UPDATE SET
				reason = EXCLUDED.reason,
				status = EXCLUDED.status,
				amount_cents = COALESCE(EXCLUDED.amount_cents, chargeback_disputes.amount_cents),
				currency = COALESCE(EXCLUDED.currency, chargeback_disputes.currency)
		`, [randomUUID(), workspaceId, disputeId, reason, status, disputeAmountCents, currency]);

		// OWNER POLICY (chargeback): same as a refund — FULLY claw back the disputed
		// payment's AI credits (NEGATIVE-allowed debt) AND FREEZE the workspace + projects.
		// Idempotent on a webhook replay; reached only from the signature-verified path. A
		// dispute.opened keys on a payment/invoice ref, so the clawback targets the SAME
		// anchors the add-on grant used. (A LOST resolution additionally tombstones those
		// anchors so a later first-seen redelivery can't re-grant — existing behavior.)
		await this.clawbackAddonGrantsForPayment(event, "chargeback");
		await this.freezeWorkspace(tx, workspaceId, "chargeback", event);
	}

	// Dodo also emits dispute resolution events (dispute.won/lost/accepted/
	// cancelled/expired). Without handling these, a workspace marked
	// `chargeback_pending` on dispute.opened would stay stuck in that state
	// forever. Resolution clears the pending flag; a favorable outcome
	// (won/cancelled/expired) restores paid access, while a lost or merchant-
	// accepted dispute (terminal loss) keeps the account cancelled.
	private async resolveChargeback(tx: DodoSqlClient, event: DodoWebhookEvent): Promise<void> {
		const subject = getEventSubject(event);
		const paymentId = extractPaymentId(event);
		const disputeId = readStringField(subject, ["dispute_id", "id", "chargeback_id"]) ?? event.id;
		const workspaceId = extractWorkspaceId(event)
			?? await findWorkspaceIdByEvent(tx, event)
			?? await findWorkspaceIdByPaymentId(tx, paymentId)
			?? await findWorkspaceIdByDisputeId(tx, disputeId);

		const resolvedStatus = readStringField(subject, ["status"]) ?? eventTypeToDisputeStatus(event.type);
		// A dispute is LOST (revenue stays deducted, access stays revoked) per the shared
		// fail-closed predicate: an explicit lost/accepted event type, or a generic
		// payment.chargeback.resolved whose status is NOT explicitly favorable. The
		// backfill uses the identical predicate so the two paths can't diverge.
		const lost = isLostDisputeResolution(event.type, resolvedStatus);

		// REVENUE REVERSAL — a FAVORABLE resolution (won/cancelled/expired, and
		// payment.chargeback.resolved when NOT lost) must neutralize the negative row
		// dispute.opened wrote, so net revenue goes back to +payment. We write a
		// POSITIVE reversal row (+ the disputed amount) keyed on a DISTINCT ref
		// (`{disputeId}:reversal`) so it never overwrites the opened row's negative
		// (a same-ref upsert would replace, not net). Idempotent on
		// (kind, dodo_event_ref): a re-delivered resolution converges on the one
		// reversal row and never double-credits. Written BEFORE the workspace
		// early-return (mirroring the dispute.opened null-workspace fix) so an
		// unresolved-workspace dispute still reconciles. A LOST/accepted dispute is
		// a real loss — leave the negative in place, write NO reversal.
		if (!lost && disputeId) {
			const reversal = await this.resolveDisputeReversalAmount(tx, subject, disputeId);
			if (reversal && reversal.amountCents !== "0") {
				await upsertPaymentTransactionRow(tx, {
					workspaceId,
					dodoPaymentId: paymentId ?? null,
					dodoEventRef: `${disputeId}:reversal`,
					dodoEventId: event.id ?? null,
					kind: "dispute",
					// Positive magnitude of the deducted amount → nets the opened row to 0.
					amountCents: absCents(reversal.amountCents),
					currency: reversal.currency,
					status: resolvedStatus,
					occurredAt: extractTimestamp(subject, ["created_at", "createdAt", "resolved_at", "resolvedAt", "timestamp"]) ?? null,
					raw: subject,
				});
			}
		}

		// The access-control side effects (chargeback hold, billing status, dispute
		// row) key on workspace_id, so they require a resolved workspace. The reversal
		// row above is already durable, so an unresolved workspace only defers the
		// hold clearing (a later delivery / backfill carries the linkage) — money is
		// already reconciled.
		if (!workspaceId) return;

		// MONEY-CRITICAL (P1 unlocked-resolution race): the deferred-add-on-grant
		// reconcile below is a read-modify-write of `metadata.deferred_addon_grants`
		// (+ `denied_addon_grant_anchors`) — read by `readDeferredAddonGrants` /
		// `readDeniedAddonGrantAnchors`, written by the UPDATE near the end of this
		// method. It MUST serialize against the SAME read-modify-write in
		// `recordPaymentDuringChargeback` (a held `payment.succeeded` appending its paid
		// grant) AND against another concurrent resolution. Without a lock these races
		// happen:
		//   - A terminal LOSS reads an EMPTY deferred set (the held payment hasn't
		//     committed yet), writes no tombstone, and clears the hold; the held
		//     payment then commits its deferred grant AFTERWARD → a clawed-back add-on
		//     is left un-tombstoned AND still present in metadata → re-granted on replay.
		//   - A FAVORABLE and a LOST resolution both read the SAME deferred set before
		//     either clears it → one grants while the other tombstones the same anchors.
		// Take the SAME `lockBillingAccountRow` (SELECT ... FOR UPDATE) on THIS `tx`
		// (the webhook's BEGIN connection — `transaction()` → `client.begin(fn)`, so the
		// lock is transaction-scoped and held until commit) BEFORE the first read. A
		// concurrent held-payment write or resolution then BLOCKS until this txn commits;
		// it then RE-READS the committed metadata: a held payment that committed before
		// us is seen by us (tombstoned on loss / granted on favorable), and a held
		// payment that commits after our lock releases sees our tombstone (loss) and
		// refuses to grant. All deferred/denied reads below happen AFTER this lock, so
		// none uses a pre-lock snapshot.
		await lockBillingAccountRow(tx, workspaceId);

		// A favorable resolution (won/cancelled/expired) clears the hold, but it must
		// NOT blindly re-enable a paid plan. If the subscription has since lapsed
		// (period end already passed, e.g. the dispute resolves months after the
		// billing period ended) restoring `active` would re-grant paid access without
		// a current subscription. Only restore `active` when the stored billing period
		// is still current; otherwise clear the hold but keep the account cancelled.
		let restoredBillingStatus: "active" | "cancelled" = "cancelled";
		if (!lost) {
			const current = await findBillingAccountState(tx, workspaceId);
			const periodStillCurrent = isFutureTimestamp(current?.current_period_end, this.now());
			restoredBillingStatus = periodStillCurrent ? "active" : "cancelled";
		}

		// MONEY-CRITICAL (deferred add-on grant): drain any add-on grants that were held
		// because they landed during this chargeback. On a FAVORABLE outcome the buyer
		// keeps the money, so the held add-on is finally granted — idempotently, via the
		// stable anchors, so a webhook replay can't double-grant. On a LOST/accepted
		// dispute the money is clawed back, so the held add-on is NEVER granted — we just
		// drop the pending entries. Either way the marker is cleared so it can't re-fire.
		//
		// MONEY-CRITICAL (P1 lost-dispute-still-grants): clearing `deferred_addon_grants`
		// alone is NOT enough on a LOSS. Once `chargeback_pending` flips false, a REDELIVERY
		// of the original `payment.succeeded` with a NEW webhook-id takes the NORMAL payment
		// path (no longer "held") and `applyAddonGrantsFromEvent` would re-derive the SAME
		// anchors and grant the add-on the dispute clawed back. So on a terminal loss we
		// PERSIST a tombstone of the denied anchors; `applyAddonGrantsFromEvent` refuses any
		// descriptor whose anchor is tombstoned. The tombstone is scoped to the EXACT
		// disputed-payment anchors (no payment-id/prefix matching), so a genuinely new,
		// unrelated add-on payment (different anchors) is never blocked, and a FAVORABLE
		// outcome writes NO tombstone (its grants proceed normally on any future replay).
		const deferred = await this.readDeferredAddonGrants(tx, workspaceId);
		if (!lost && deferred.length > 0) {
			await this.applyAddonGrantDescriptors(tx, workspaceId, deferred);
		}
		// On a terminal LOSS the held add-ons are clawed back; their anchors become the
		// tombstone. On a favorable outcome there is nothing to deny (empty).
		const deniedAnchors = lost ? deferred.map((grant) => grant.anchor) : [];
		// Union the newly-denied anchors with any tombstone a PRIOR loss already wrote
		// (deduped) so multiple losses on the same workspace each accumulate, and a
		// metadata `||` shallow-merge of `denied_addon_grant_anchors` replaces (not
		// appends to) the array — we must carry the prior entries forward ourselves. On a
		// favorable outcome `deniedAnchors` is empty and the existing tombstone is left
		// untouched (we omit the key from the merge object entirely).
		const tombstoneUpdate = deniedAnchors.length > 0
			? { denied_addon_grant_anchors: dedupeStrings([...await this.readDeniedAddonGrantAnchors(tx, workspaceId), ...deniedAnchors]) }
			: {};

		// MONEY-CRITICAL (P1 never-held loss): the exact-anchor tombstone above only covers
		// add-ons that were DEFERRED while the hold was open. If the disputed payment.succeeded
		// was NEVER seen during the hold, the loss recorded no anchor — so a LATER first-seen
		// delivery of that same payment_id would reach the normal grant path and re-mint the
		// clawed-back add-on. To close that, a terminal loss ALSO writes a COARSER tombstone
		// scoped to the disputed payment's REF (denied_addon_payment_refs); applyAddonGrantsFromEvent
		// refuses EVERY add-on descriptor whose event derives that ref.
		//
		// MONEY-CRITICAL (P1 invoice-only / no-payment-id replay slips past the tombstone):
		// the tombstone MUST be SYMMETRIC with descriptor ref derivation. `extractAddonGrantRef`
		// = payment_id ?? invoice_id ?? event.id, and BOTH `payment.succeeded` and `invoice.paid`
		// route through add-on granting. So a disputed add-on payment that carried NO payment_id
		// anchored its descriptors on its invoice_id. If the loss tombstoned only the payment_id,
		// a later first-seen `invoice.paid`/`payment.succeeded` replay (same invoice_id, deriving
		// ref = invoice_id) would not match and would grant the clawed-back add-on. We therefore
		// recover and tombstone EVERY candidate ref the disputed payment's descriptors could have
		// used — its payment_id AND its invoice_id — preferring identifiers this resolution carries
		// and falling back to the dispute row we persisted on dispute.opened. The replay of the
		// SAME logical payment presents the same payment_id/invoice_id, so matching ANY one blocks
		// it. We do NOT tombstone the dispute's event id — it could never equal the payment's ref
		// (a redelivery carries a different event id), so it would only bloat the set. A FAVORABLE
		// outcome writes NO payment-ref tombstone (refsOnLoss is empty when not lost). The set is
		// deduped and bounded (keep the most-recent refs) so it can't grow without limit; it blocks
		// ONLY refs of the disputed payment — an unrelated future add-on payment with a different
		// payment_id AND a different invoice_id is never touched.
		//
		// NOTE (no-id case): a disputed payment that has NEITHER payment_id NOR invoice_id would
		// have anchored its descriptors on `event.id` (per extractAddonGrantRef's final fallback).
		// Such a ref cannot be shared across distinct webhook deliveries (each redelivery carries a
		// new event id), so a first-seen redelivery never re-derives the same anchor — the loss has
		// nothing stable to tombstone and there is nothing to block. The normal per-event-id
		// idempotency (dodo_webhook_events ON CONFLICT (id) DO NOTHING) already prevents a literal
		// double-grant of the SAME event id, and a genuine redelivery (new id) is, by definition,
		// not the disputed occurrence's stable anchor. We deliberately do NOT invent a fragile guard
		// for this case.
		let paymentRefTombstoneUpdate: { denied_addon_payment_refs: string[] } | Record<string, never> = {};
		if (lost) {
			// Recover BOTH candidate refs the disputed payment's descriptors could have used:
			// its payment_id (this event's, else the dispute's recorded one) AND its invoice_id
			// (this event's, else the dispute's recorded one). Tombstone both so the later
			// first-seen replay matches on whichever ref it derives.
			const recoveredPaymentId = paymentId ?? (await findPaymentIdByDisputeId(tx, disputeId));
			const recoveredInvoiceId = readStringField(subject, ["invoice_id", "invoiceId"])
				?? (await findInvoiceIdByDisputeId(tx, disputeId));
			const refsOnLoss = [recoveredPaymentId, recoveredInvoiceId].filter(
				(ref): ref is string => typeof ref === "string" && ref.length > 0,
			);
			if (refsOnLoss.length > 0) {
				const existingRefs = await this.readDeniedAddonPaymentRefs(tx, workspaceId);
				const merged = dedupeStrings([...existingRefs, ...refsOnLoss]);
				// Keep the most-recent refs if the bound is exceeded (newest losses win).
				const bounded = merged.length > MAX_DENIED_ADDON_PAYMENT_REFS
					? merged.slice(merged.length - MAX_DENIED_ADDON_PAYMENT_REFS)
					: merged;
				paymentRefTombstoneUpdate = { denied_addon_payment_refs: bounded };
			}
		}

		await tx.unsafe(`
			UPDATE workspaces
			SET chargeback_pending = false, updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId]);
		await tx.unsafe(`
			UPDATE workspace_billing_accounts
			SET status = $3,
				metadata = metadata || $2::text::jsonb,
				updated_at = now()
			WHERE workspace_id = $1
		`, [workspaceId, JSON.stringify({
			provider: "dodo",
			dodo_event_id: event.id,
			dodo_event_type: event.type,
			dodo_payment_id: paymentId,
			chargeback_pending: false,
			dodo_dispute_status: resolvedStatus,
			// Clear the deferred-grant ledger: a favorable outcome just granted them
			// (idempotently); a loss must never grant. Either way they are done.
			deferred_addon_grants: [],
			// On a terminal loss, persist the denied anchors so a new-webhook-id replay of
			// the clawed-back payment (now on the normal path) is REFUSED at grant time.
			...tombstoneUpdate,
			// Coarser, payment-ref-scoped tombstone: blocks ALL add-ons tied to the disputed
			// payment even when it was never deferred (never-held → first-seen-after-loss leak).
			...paymentRefTombstoneUpdate,
		}), restoredBillingStatus]);
		await tx.unsafe(`
			UPDATE chargeback_disputes
			SET status = $2, resolved_at = now()
			WHERE dodo_dispute_id = $1
		`, [disputeId, resolvedStatus]);

		// MONEY-CRITICAL (P1 won-dispute-stays-frozen): clearing `chargeback_pending`
		// and restoring billing status above is NOT enough — `dispute.opened`
		// (recordChargeback) also set `workspaces.suspended_at` via freezeWorkspace, and
		// `suspended_at` is an INDEPENDENT column from `chargeback_pending`. On a FAVORABLE
		// resolution (won/cancelled/expired) the customer was vindicated, so the punitive
		// freeze MUST lift; otherwise the whole workspace + every member stays locked out of
		// all mutating ops until a brand-new payment or an admin manual unfreeze. We clear it
		// ONLY when `suspended_reason = 'chargeback'`, so an INDEPENDENT refund freeze
		// (suspended_reason = 'payment_refund') is NOT lifted by winning an unrelated dispute.
		// (Edge: if a refund froze first and a chargeback froze after, COALESCE kept the
		// 'payment_refund' reason → this no-ops and the refund freeze correctly persists.)
		// Unfreeze regardless of whether billing was restored to `active`: a won dispute must
		// not leave the customer FROZEN even if their subscription has since lapsed (a lapsed
		// plan is a normal 'cancelled', not a punitive freeze). The metadata mirror is updated
		// only when a row was actually cleared, so the dashboard freeze flag stays accurate.
		if (!lost) {
			const cleared = await tx.unsafe(`
				UPDATE workspaces
				SET suspended_at = NULL,
					suspended_reason = NULL,
					updated_at = now()
				WHERE workspace_id = $1 AND suspended_reason = 'chargeback'
				RETURNING workspace_id
			`, [workspaceId]);
			if (cleared.length > 0) {
				await tx.unsafe(`
					UPDATE workspace_billing_accounts
					SET metadata = metadata || $2::text::jsonb, updated_at = now()
					WHERE workspace_id = $1
				`, [workspaceId, JSON.stringify({
					provider: "dodo",
					workspace_suspended: false,
					workspace_unsuspended_by: "dispute_resolved",
					dodo_event_id: event.id,
					dodo_event_type: event.type,
				})]);
			}
		}
	}

	// Resolve the disputed amount (+ currency) to reverse on a favorable resolution.
	// Dodo resolution events often DON'T re-send the amount, so prefer the original
	// dispute.opened revenue row we already persisted (durable even with a null
	// workspace), and only fall back to an amount on the resolution payload itself.
	// Returns the POSITIVE-magnitude cents string + currency, or null when neither
	// source yields an amount (nothing to reverse).
	private async resolveDisputeReversalAmount(
		tx: DodoSqlClient,
		subject: Record<string, unknown>,
		disputeId: string,
	): Promise<{ amountCents: string; currency: string | null } | null> {
		// Primary source: the dispute.opened payment_transactions row. Its amount is
		// stored NEGATIVE; the reversal is its absolute magnitude. This is the source
		// of truth and keeps the reversal exactly equal to the deduction.
		const openedRows = await tx.unsafe<{ amount_cents: string | number; currency: string | null }>(`
			SELECT amount_cents, currency
			FROM payment_transactions
			WHERE kind = 'dispute' AND dodo_event_ref = $1
			LIMIT 1
		`, [disputeId]);
		const opened = openedRows[0];
		if (opened && opened.amount_cents !== null && opened.amount_cents !== undefined) {
			const magnitude = absCents(normalizeCents(String(opened.amount_cents)));
			if (magnitude !== "0") {
				return { amountCents: magnitude, currency: opened.currency ?? readStringField(subject, ["currency"]) ?? null };
			}
		}
		// Fallback: the resolution payload itself carried the amount (decimal-safe,
		// currency-aware so a JPY resolution amount isn't inflated 100x).
		const payloadCurrency = readStringField(subject, ["currency"]) ?? null;
		const payloadAmount = readDisputeMinorUnits(subject, payloadCurrency);
		if (payloadAmount !== null) {
			const magnitude = absCents(payloadAmount);
			if (magnitude !== "0") {
				return { amountCents: magnitude, currency: payloadCurrency };
			}
		}
		return null;
	}

	private returnBaseUrl(): string {
		const configured = (this.config.dodo as { returnBaseUrl?: string }).returnBaseUrl?.trim();
		return (configured || DEFAULT_RETURN_BASE_URL).replace(/\/+$/, "");
	}

	private checkoutReturnUrl(): string {
		return `${this.returnBaseUrl()}${CHECKOUT_RETURN_PATH}`;
	}

	private billingReturnUrl(): string {
		return `${this.returnBaseUrl()}${BILLING_RETURN_PATH}`;
	}

	private getProductId(planKey: DodoPlanKey, cycle: DodoBillingCycle): string {
		const key = `${planKey}_${cycle}`;
		const productId = this.config.dodo.productIds[key];
		if (!productId) {
			throw new DodoBillingError(`Missing Dodo product id for ${key}`, "dodo_product_id_missing", 400);
		}
		return productId;
	}

	// Resolve the configured-product plan key BEFORE falling back to forge-able
	// metadata: a top-level product_id, then a product_cart[] product id, then
	// metadata.plan_key. This ordering matters because the cart can carry the trusted
	// product when the top-level field is absent, and metadata must never win over a
	// trusted product. NOTE: this is NOT used to derive the GRANTED plan on a paid
	// success/plan-change — those use validatePaidGrant's returned key — but keeping
	// the resolution consistent prevents drift on the remaining (non-grant) callers.
	private extractPlanKey(event: DodoWebhookEvent): DodoPlanKey | null {
		const subject = getEventSubject(event);
		const productId = readStringField(subject, ["product_id", "productId"]) ?? readProductIdFromCart(subject);
		if (productId) {
			const matchedPlanKey = this.findPlanKeyByProductId(productId);
			if (matchedPlanKey) return matchedPlanKey;
		}
		return extractMetadataPlanKey(event);
	}

	private findPlanKeyByProductId(productId: string): DodoPlanKey | null {
		for (const planKey of Object.keys(DODO_TO_INTERNAL_PLAN) as DodoPlanKey[]) {
			if (
				this.config.dodo.productIds[`${planKey}_monthly`] === productId
				|| this.config.dodo.productIds[`${planKey}_yearly`] === productId
			) {
				return planKey;
			}
		}
		return null;
	}

	private getAddonProductId(addon: DodoAddonKey): string {
		const productId = this.config.dodo.productIds[`addon_${addon}`] ?? this.config.dodo.productIds[addon];
		if (!productId) {
			throw new DodoBillingError(`Missing Dodo add-on product id for ${addon}`, "dodo_addon_product_id_missing", 400);
		}
		return productId;
	}

	private requireDodoEnabled(): void {
		if (this.config.billingProvider !== "dodo") {
			throw new DodoBillingError("Dodo billing is not enabled", "dodo_billing_disabled", 503);
		}
	}

	private requireSqlClient(): DodoSqlClient {
		if (!this.sqlClient) {
			throw new DodoBillingError("Dodo billing requires a Postgres client", "dodo_store_unavailable", 503);
		}
		return this.sqlClient;
	}

	private async transaction<T>(client: DodoSqlClient, fn: (tx: DodoSqlClient) => Promise<T>): Promise<T> {
		if (client.begin) return client.begin(fn);
		return fn(client);
	}

	// ===== COUPONS (rank 9) =====
	//
	// Dodo discount-coupon CRUD, used by the back-office /api/admin/coupons surface.
	// Dodo discounts are PERCENTAGE-only; the API takes the amount in BASIS POINTS
	// (540 => 5.4%, 10000 => 100%). We accept a friendlier percent (0 < pct <= 100)
	// at the route and convert here so callers never deal in basis points.
	//
	// These methods are appended in a single clearly-marked block at the END of the
	// class (per the de-conflict note) so a rebase against a sibling PR that also
	// appends to this file is trivial. They do not touch any existing dodo method.

	async createDiscountCoupon(input: DodoCreateDiscountInput): Promise<DodoDiscount> {
		this.requireDodoEnabled();
		const body: Record<string, unknown> = {
			amount: percentToBasisPoints(input.percentOff),
			type: "percentage",
		};
		if (input.code !== undefined) body.code = input.code;
		if (input.name !== undefined) body.name = input.name;
		if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
		if (input.usageLimit !== undefined) body.usage_limit = input.usageLimit;
		if (input.restrictedTo !== undefined) body.restricted_to = input.restrictedTo;
		if (input.subscriptionCycles !== undefined) body.subscription_cycles = input.subscriptionCycles;
		if (input.metadata !== undefined) body.metadata = input.metadata;
		const discount = await this.client.discounts.create(body as unknown as Parameters<DodoPayments["discounts"]["create"]>[0]);
		return normalizeDodoDiscount(discount);
	}

	async listDiscountCoupons(query: DodoListDiscountsQuery = {}): Promise<DodoDiscount[]> {
		this.requireDodoEnabled();
		const params: Record<string, unknown> = {};
		if (query.code !== undefined) params.code = query.code;
		if (query.pageSize !== undefined) params.page_size = query.pageSize;
		if (query.pageNumber !== undefined) params.page_number = query.pageNumber;
		const page = await this.client.discounts.list(params as unknown as Parameters<DodoPayments["discounts"]["list"]>[0]);
		const items = collectDiscountItems(page);
		return items.map(normalizeDodoDiscount);
	}

	async getDiscountCoupon(discountId: string): Promise<DodoDiscount> {
		this.requireDodoEnabled();
		const discount = await this.client.discounts.retrieve(discountId);
		return normalizeDodoDiscount(discount);
	}

	async updateDiscountCoupon(discountId: string, input: DodoUpdateDiscountInput): Promise<DodoDiscount> {
		this.requireDodoEnabled();
		const body: Record<string, unknown> = {};
		if (input.percentOff !== undefined) body.amount = percentToBasisPoints(input.percentOff);
		if (input.code !== undefined) body.code = input.code;
		if (input.name !== undefined) body.name = input.name;
		if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
		if (input.usageLimit !== undefined) body.usage_limit = input.usageLimit;
		if (input.restrictedTo !== undefined) body.restricted_to = input.restrictedTo;
		if (input.subscriptionCycles !== undefined) body.subscription_cycles = input.subscriptionCycles;
		if (input.metadata !== undefined) body.metadata = input.metadata;
		const discount = await this.client.discounts.update(discountId, body as unknown as Parameters<DodoPayments["discounts"]["update"]>[1]);
		return normalizeDodoDiscount(discount);
	}

	async deleteDiscountCoupon(discountId: string): Promise<void> {
		this.requireDodoEnabled();
		await this.client.discounts.delete(discountId);
	}

	// ===== SUPPORT ACTIONS (rank 14) =====
	//
	// The back-office /api/admin/support refund action. Unlike `refundSubscription`
	// (the subscription-portal path, which REQUIRES a live Dodo subscription + a
	// linked `dodo_payment_id` and only works in Postgres mode), a support refund
	// works end-to-end in the file-mode + BILLING_PROVIDER=none deployment the support
	// console runs under: the operator references an ORIGINAL charge the money model
	// (#162) already recorded, and we write the offsetting NEGATIVE `payment_transactions`
	// row so net revenue nets — exactly like the `payment.refunded` webhook does, but
	// operator-initiated.
	//
	// MONEY-OUT SAFETY (P1). This is a human issuing a refund — money LEAVES the business
	// — so the path is airtight, idempotent, validated, AND ATOMIC PER CHARGE.
	//
	// CONCURRENCY (P1). Dedupe + validate + provider + ledger are NOT individually
	// atomic, so the whole critical section runs PER CHARGE under an exclusive lock
	// (`store.runChargeRefundCritical(chargeId, ...)` — a Postgres advisory xact lock in
	// DB mode, a per-charge mutex in file mode). Without it:
	//   * two concurrent SAME-key refunds both find no row and both call the provider; and
	//   * two concurrent DIFFERENT-key partials both read refunded=0, both pass the cap,
	//     and together out-refund the original (e.g. two $60 on a $100 charge → $120 out).
	// Holding the lock across the provider call (refunds are rare back-office ops) makes
	// "re-read cumulative → dedupe → validate → provider money-out → record" one atomic
	// unit, so the provider is called AT MOST ONCE per (charge, key) and the SUM of refunds
	// for a charge can NEVER exceed the original, even under N concurrent requests.
	//
	// The order INSIDE the lock, in order:
	//   (1) DEDUPE FIRST. Look up the ledger by `(kind='refund', dodoEventRef=key)` BEFORE
	//       touching the provider. If a refund already exists for the key (a concurrent or
	//       prior retry already committed it), return it WITHOUT calling Dodo again.
	//   (2) VALIDATE against the original charge (re-read INSIDE the lock so it reflects
	//       every refund that committed first): reject (400) when no original payment
	//       exists, the currency differs, the charge is already fully refunded/charged
	//       back, or requested + already-refunded + already-disputed would EXCEED the
	//       gross paid. dodoChargeId is therefore REQUIRED (caller-controlled amount/
	//       currency are never trusted).
	//   (3) PROVIDER. Only after (1)+(2) fire the real Dodo refund — PARTIAL amount via
	//       `items[].amount` (+ the SDK idempotency key) so a partial refund is partial at
	//       Dodo. A provider failure throws, which rolls back the transaction so NO phantom
	//       ledger row blocks a clean retry.
	//   (4) LEDGER. The idempotent negative row's dedupe ref is the key; dodoPaymentId stays
	//       the ORIGINAL charge id so refunds roll up against it (provider refund id → raw).
	//       Recorded inside the lock; committed when the section returns.
	//
	// The store dedupe `(kind='refund', dodoEventRef)` holds in BOTH file mode (byKey map)
	// and Postgres (the migration 0052 partial unique index).
	//
	// Appended as a single clearly-marked block at the END of the class (per the
	// de-conflict note) so a rebase against a sibling PR that also appends here is
	// trivial. It does NOT touch any existing dodo method or the COUPONS section.
	async recordSupportRefund(input: DodoSupportRefundInput): Promise<DodoSupportRefundResult> {
		const store = input.paymentTransactionsStore;
		const idempotencyKey = input.idempotencyKey.trim();
		if (!idempotencyKey) {
			throw new DodoBillingError("Support refund requires an idempotency key", "dodo_refund_idempotency_missing", 400);
		}
		const chargeId = input.dodoChargeId?.trim() ?? "";
		const currency = input.currency.trim().toUpperCase();
		// Positive magnitude of the requested refund, exact integer cents.
		const requestedAbs = absCents(input.amountCents);
		// Store NEGATIVE minor units so a plain SUM nets, mirroring the webhook refund
		// path (recordRefundTransaction).
		const amountCents = negateCents(requestedAbs);

		// chargeId is REQUIRED to validate a money-out AND is the key the per-charge lock
		// serializes on — validated BEFORE acquiring the lock so a missing charge fails fast.
		if (!chargeId) {
			throw new DodoBillingError(
				"Support refund requires the original charge id (dodoChargeId) to validate the amount/currency against the payment",
				"dodo_refund_charge_required",
				400,
			);
		}

		// ── PER-CHARGE CRITICAL SECTION (money-out concurrency safety, P1) ────────────
		// Everything from the dedupe read through the ledger write runs while THIS charge
		// is exclusively held, so concurrent refunds for the same charge are serialized.
		return store.runChargeRefundCritical(chargeId, input.workspaceId, async (section) => {
			// ── (1) DEDUPE FIRST — replay/concurrent-safe BEFORE any provider money-out ──
			// A retried OR concurrent support refund carrying the same idempotency key must
			// NOT issue a second provider refund. The canonical dedupe ref of the row is the
			// PROVIDER refund id (so the later Dodo webhook for that refund dedupes onto the
			// SAME row — one provider refund = one ledger row), which is unknown until AFTER
			// the provider call. So this PRE-PROVIDER replay guard matches on the support
			// idempotency key stashed in `raw.supportIdempotencyKey` (scoped to THIS charge).
			// Re-checked INSIDE the lock so a sibling request that committed its row first is
			// seen here and short-circuits without a second money-out.
			const existing = await section.findRefundBySupportKey(idempotencyKey);
			if (existing) {
				const priorRefundId = typeof existing.raw?.dodo_refund_id === "string" ? existing.raw.dodo_refund_id : null;
				return { transaction: existing, providerRefundId: priorRefundId };
			}

			// ── (2) VALIDATE against the ORIGINAL charge — re-read INSIDE the lock ────────
			// Re-reading the cumulative state under the lock is what makes the cap exact:
			// a concurrent different-key refund that committed first is included, so two
			// partials can never together exceed the original.
			const chargeState = await section.getChargeRefundState();
			if (!chargeState.found) {
				throw new DodoBillingError(
					`No original payment found for charge '${chargeId}' — cannot refund a charge that was never recorded`,
					"dodo_refund_original_not_found",
					400,
				);
			}
			const originalCurrency = chargeState.currency?.trim().toUpperCase() ?? "";
			if (!originalCurrency) {
				throw new DodoBillingError(
					`Original charge '${chargeId}' is missing currency — cannot safely validate a ${currency} refund`,
					"dodo_refund_original_currency_missing",
					400,
				);
			}
			if (originalCurrency !== currency) {
				throw new DodoBillingError(
					`Refund currency ${currency} does not match the original charge currency ${originalCurrency}`,
					"dodo_refund_currency_mismatch",
					400,
				);
			}
			// Cumulative cap: requested + already-refunded + already-disputed must not
			// exceed the gross paid. A chargeback/dispute is already a clawback against
			// the original payment; issuing a support refund on top would double-pay.
			// BigInt keeps this exact at any magnitude (integer cents only).
			const requested = BigInt(requestedAbs);
			const alreadyRefunded = BigInt(chargeState.alreadyRefundedCents);
			const alreadyDisputed = BigInt(chargeState.alreadyDisputedCents);
			const originalPaid = BigInt(chargeState.originalPaidCents);
			if (alreadyRefunded + alreadyDisputed >= originalPaid) {
				throw new DodoBillingError(
					`Charge '${chargeId}' is already fully refunded or charged back (${alreadyRefunded + alreadyDisputed}/${chargeState.originalPaidCents} ${currency})`,
					"dodo_refund_already_full",
					400,
				);
			}
			if (requested + alreadyRefunded + alreadyDisputed > originalPaid) {
				throw new DodoBillingError(
					`Refund of ${requestedAbs} ${currency} exceeds the remaining refundable amount ${chargeState.remainingRefundableCents} ${currency} for charge '${chargeId}'`,
					"dodo_refund_exceeds_original",
					400,
				);
			}

			// ── (3) Fire the REAL provider refund (only after dedupe + validation) ───────
			// Still inside the lock, so only ONE provider call ever fires per (charge, key)
			// and the next refund for this charge cannot start until our row is committed.
			// Dodo takes a partial amount via items[].amount (minor units); we also pass the
			// idempotency key to the SDK (belt + suspenders). A provider failure throws here,
			// rolling back the transaction so NO phantom ledger row blocks a clean retry.
			let providerRefundId: string | null = null;
			if (this.config.billingProvider === "dodo") {
				const refundAmount = Number(requestedAbs);
				if (!Number.isSafeInteger(refundAmount)) {
					throw new DodoBillingError("Refund amount exceeds the provider's representable range", "dodo_refund_amount_unrepresentable", 400);
				}
				const refund = await this.client.refunds.create(
					{
						payment_id: chargeId,
						// Partial refund: amount (minor units) for the charge's line item. Without
						// items[].amount Dodo would FULL-refund the payment while we record a partial.
						items: [{ item_id: chargeId, amount: refundAmount }],
						reason: input.reason,
						metadata: { workspace_id: input.workspaceId, initiated_by: input.initiatedBy, idempotency_key: idempotencyKey, currency },
					} as Parameters<DodoPayments["refunds"]["create"]>[0],
					{ idempotencyKey },
				);
				providerRefundId = readStringField(refund, ["refund_id", "id"]) ?? null;
			}

			// ── (4) Idempotent negative-revenue row — UNIFIED dedupe ref with the webhook ─
			// The canonical dedupe ref is the PROVIDER refund id when we got one back, so the
			// later Dodo refund WEBHOOK for that same refund (recordRefundTransaction, which
			// dedupes on dodoEventRef=refundId) lands on the ON CONFLICT (kind, dodo_event_ref)
			// path and UPDATES this EXISTING support row instead of inserting a SECOND row —
			// i.e. one provider refund records exactly ONE ledger row. When there is no
			// provider refund id (BILLING_PROVIDER=none — no webhook will ever follow), we
			// fall back to the idempotency key as the ref so the row still has a stable dedupe
			// identity. The idempotency key is ALSO stashed in raw.supportIdempotencyKey so the
			// pre-provider replay guard (step 1) can find this row on a retry.
			// dodoPaymentId stays the ORIGINAL charge id so this refund rolls up against the
			// charge in getChargeRefundState — exactly like the webhook refund path links to
			// its payment. Committed when this section returns; rolled back on throw.
			const dedupeRef = providerRefundId ?? idempotencyKey;
			const transaction = await section.recordRefund({
				workspaceId: input.workspaceId,
				dodoPaymentId: chargeId,
				dodoEventRef: dedupeRef,
				kind: "refund",
				amountCents,
				currency,
				status: "refunded",
				occurredAt: input.occurredAt ?? new Date().toISOString(),
				raw: {
					source: "support_console",
					initiated_by: input.initiatedBy,
					reason: input.reason,
					dodo_charge_id: chargeId,
					// Pre-provider replay dedupe key (the canonical ref is the provider refund id).
					supportIdempotencyKey: idempotencyKey,
					...(providerRefundId ? { dodo_refund_id: providerRefundId } : {}),
				},
			});
			return { transaction, providerRefundId };
		});
	}
}

// ===== COUPONS (rank 9) — types + helpers =====

export interface DodoDiscount {
	discountId: string;
	code: string;
	/** Percentage off (basis points / 100), e.g. 5.4 for 540 bps. */
	percentOff: number;
	/** Raw basis-point amount as returned by Dodo. */
	amountBasisPoints: number;
	type: string;
	name: string | null;
	expiresAt: string | null;
	usageLimit: number | null;
	timesUsed: number;
	restrictedTo: string[];
	createdAt: string | null;
}

export interface DodoCreateDiscountInput {
	/** Percentage off, 0 < pct <= 100. Converted to Dodo basis points. */
	percentOff: number;
	code?: string;
	name?: string;
	expiresAt?: string;
	usageLimit?: number | null;
	restrictedTo?: string[];
	subscriptionCycles?: number | null;
	metadata?: Record<string, string>;
}

export interface DodoUpdateDiscountInput {
	percentOff?: number;
	code?: string;
	name?: string | null;
	expiresAt?: string | null;
	usageLimit?: number | null;
	restrictedTo?: string[];
	subscriptionCycles?: number | null;
	metadata?: Record<string, string> | null;
}

export interface DodoListDiscountsQuery {
	code?: string;
	pageSize?: number;
	pageNumber?: number;
}

// Dodo discount amount is in basis points (1..10000). Convert a human percent
// (0 < pct <= 100) to an integer basis-point amount. Decimal percents are
// supported to one extra precision (5.4% => 540) and rounded to the nearest bp.
function percentToBasisPoints(percent: number): number {
	if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
		throw new DodoBillingError("Discount percent must be between 0 (exclusive) and 100", "dodo_discount_percent_invalid", 400);
	}
	const bps = Math.round(percent * 100);
	if (bps < 1 || bps > 10000) {
		throw new DodoBillingError("Discount amount out of range", "dodo_discount_amount_invalid", 400);
	}
	return bps;
}

function normalizeDodoDiscount(raw: unknown): DodoDiscount {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const amount = typeof r.amount === "number" ? r.amount : Number(r.amount) || 0;
	return {
		discountId: String(r.discount_id ?? r.discountId ?? ""),
		code: String(r.code ?? ""),
		amountBasisPoints: amount,
		percentOff: Math.round((amount / 100) * 100) / 100,
		type: String(r.type ?? "percentage"),
		name: typeof r.name === "string" ? r.name : null,
		expiresAt: typeof r.expires_at === "string" ? r.expires_at : null,
		usageLimit: r.usage_limit === null || r.usage_limit === undefined ? null : Number(r.usage_limit),
		timesUsed: typeof r.times_used === "number" ? r.times_used : Number(r.times_used) || 0,
		restrictedTo: Array.isArray(r.restricted_to) ? r.restricted_to.map((id) => String(id)) : [],
		createdAt: typeof r.created_at === "string" ? r.created_at : null,
	};
}

// Dodo's list returns a paginated wrapper; tolerate either a plain array, a
// `{ items: [...] }` shape, or an SDK page exposing `.data`.
function collectDiscountItems(page: unknown): unknown[] {
	if (Array.isArray(page)) return page;
	if (page && typeof page === "object") {
		const obj = page as Record<string, unknown>;
		if (Array.isArray(obj.items)) return obj.items;
		if (Array.isArray(obj.data)) return obj.data;
	}
	return [];
}

// Replay-window tolerance for the signed `webhook-timestamp` (seconds). Matches
// the Svix/Standard-Webhooks default of 5 minutes in each direction, which
// absorbs normal clock skew + delivery latency while bounding replay of a
// captured-but-old signed delivery.
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

// The `webhook-timestamp` header is unix seconds. Treat a missing/unparseable
// value, or one more than the tolerance away from now in either direction, as
// stale. Fails closed: an absent/garbage timestamp is rejected.
export function isWebhookTimestampFresh(
	timestamp: string | undefined,
	now: Date = new Date(),
	toleranceSeconds = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
	if (!timestamp) return false;
	const seconds = Number(timestamp.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) return false;
	const nowSeconds = Math.floor(now.getTime() / 1000);
	return Math.abs(nowSeconds - seconds) <= toleranceSeconds;
}

export function verifyWebhookSignature(
	rawBody: string,
	headers: Headers | Record<string, string | undefined>,
	secret: string,
): boolean {
	const webhookId = readHeader(headers, "webhook-id");
	const timestamp = readHeader(headers, "webhook-timestamp");
	const signature = readHeader(headers, "webhook-signature");
	if (!webhookId || !timestamp || !signature || !secret) return false;

	const signedPayload = `${webhookId}.${timestamp}.${rawBody}`;
	const key = decodeWebhookSecret(secret);
	const expected = createHmac("sha256", key).update(signedPayload).digest("base64");
	const candidates = signature
		.split(",")
		.map((part) => part.trim())
		.map((part) => part.startsWith("v1=") ? part.slice(3) : part)
		.filter((part) => part && part !== "v1");

	return candidates.some((candidate) => timingSafeBase64Equal(candidate, expected));
}

// ===== SUPPORT ACTIONS (rank 14) — types =====

export interface DodoSupportRefundInput {
	workspaceId: string;
	/** Refund amount in MINOR UNITS (integer cents). Stored negated. */
	amountCents: number | bigint | string;
	/** ISO-4217 currency code (per-currency money model). */
	currency: string;
	/** Operator-supplied reason, recorded in the row's raw payload + audit. */
	reason: string;
	/** The platform admin issuing the refund (audit attribution). */
	initiatedBy: string;
	/**
	 * Idempotency key — the refund row's dedupe ref. A retried support refund with
	 * the SAME key converges on the one existing negative row, so the money never
	 * goes out twice.
	 */
	idempotencyKey: string;
	/**
	 * The ORIGINAL Dodo charge/payment id. REQUIRED by recordSupportRefund: it is the key
	 * the refund amount + currency are validated against (and the cumulative refunds are
	 * summed by), and — when Dodo is the live provider — the payment the real provider
	 * refund fires against. Omitting it is a 400 (cannot validate a money-out).
	 */
	dodoChargeId?: string;
	/** When the refund occurred (defaults to now); lands the row in the revenue timeseries. */
	occurredAt?: string;
	/** The payment-transactions store to record the negative row through (file or Postgres). */
	paymentTransactionsStore: PaymentTransactionsStore;
}

export interface DodoSupportRefundResult {
	transaction: PaymentTransaction;
	/** The real provider refund id when Dodo was live + a charge id was supplied; else null. */
	providerRefundId: string | null;
}

export const dodoService = new DodoService();

function createDefaultSqlClient(): DodoSqlClient | null {
	if (!process.env.DATABASE_URL?.trim()) return null;
	return getSharedBunSql(process.env.DATABASE_URL) as unknown as DodoSqlClient;
}

function readHeader(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function decodeWebhookSecret(secret: string): Buffer | string {
	const normalized = secret.trim();
	const withoutPrefix = normalized.startsWith("whsec_") ? normalized.slice("whsec_".length) : normalized;
	try {
		const decoded = Buffer.from(withoutPrefix, "base64");
		if (decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === withoutPrefix.replace(/=+$/, "")) {
			return decoded;
		}
	} catch {
		// Fall through to raw secret bytes.
	}
	return normalized;
}

function timingSafeBase64Equal(candidate: string, expected: string): boolean {
	const left = Buffer.from(candidate);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeAddons(addons: DodoAddonKey[] | undefined): DodoAddonKey[] {
	return [...new Set(addons ?? [])].filter((addon): addon is DodoAddonKey => addon === "byo_api");
}

function getEventSubject(event: DodoWebhookEvent): Record<string, unknown> {
	const data = event.data ?? event.payload;
	return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

function extractWorkspaceId(event: DodoWebhookEvent): string | null {
	const subject = getEventSubject(event);
	const metadata = readObjectField(subject, ["metadata"]) ?? readObjectField(event, ["metadata"]);
	return readStringField(metadata, ["workspace_id", "workspaceId"])
		?? readStringField(subject, ["workspace_id", "workspaceId"])
		?? readStringField(event, ["workspace_id", "workspaceId"])
		?? null;
}

function extractMetadataPlanKey(event: DodoWebhookEvent): DodoPlanKey | null {
	const subject = getEventSubject(event);
	const metadata = readObjectField(subject, ["metadata"]) ?? readObjectField(event, ["metadata"]);
	const raw = readStringField(metadata, ["plan_key", "planKey"])
		?? readStringField(subject, ["plan_key", "planKey"]);
	if (raw === "starter" || raw === "pro" || raw === "studio" || raw === "studio_plus") return raw;
	return null;
}

function extractSubscriptionId(event: DodoWebhookEvent): string | undefined {
	const subject = getEventSubject(event);
	return readStringField(subject, ["subscription_id", "subscriptionId", "id"])
		?? readStringField(event, ["subscription_id", "subscriptionId"]);
}

function extractCustomerId(event: DodoWebhookEvent): string | undefined {
	const subject = getEventSubject(event);
	const customer = readObjectField(subject, ["customer"]);
	return readStringField(subject, ["customer_id", "customerId"])
		?? readStringField(customer, ["customer_id", "customerId", "id"]);
}

function extractPaymentId(event: DodoWebhookEvent): string | undefined {
	const subject = getEventSubject(event);
	return readStringField(subject, ["payment_id", "paymentId"])
		?? readStringField(event, ["payment_id", "paymentId"]);
}

// The stable payment ref that every add-on grant anchor for an event derives from:
// payment id, else invoice id, else the webhook event id. `computeAddonGrantDescriptors`
// builds `dodo-addon:${ref}:<addon>:<index>` from this, so the LOST-dispute
// payment-ref tombstone (`denied_addon_payment_refs`) and the grant-refusal check MUST
// compute the IDENTICAL ref to match across two DISTINCT webhook deliveries (the disputed
// payment.succeeded and the later first-seen redelivery share only their payment_id).
function extractAddonGrantRef(event: DodoWebhookEvent): string | undefined {
	const subject = getEventSubject(event);
	return extractPaymentId(event)
		?? readStringField(subject, ["invoice_id", "invoiceId"])
		?? event.id;
}

// EVERY identifier an event's add-on grant descriptors could anchor on — the same
// candidates `extractAddonGrantRef` considers, but returned as a SET rather than a single
// preferred ref. The LOST-dispute payment-ref tombstone records all candidate refs of the
// disputed payment (payment_id AND invoice_id), so the grant-refusal check must test ALL
// of an event's candidates against the tombstone, not just its primary derived ref: the
// disputed payment.succeeded and its later first-seen invoice.paid/payment.succeeded replay
// share these identifiers but can DERIVE different primary refs. The event.id is included
// as a last-resort candidate so the precise event-id-only case (no payment_id/invoice_id)
// still works for the redelivery of the EXACT same event id, but it cannot bridge distinct
// deliveries (each carries a different event id) — matching that case relies on the normal
// per-event-id idempotency, not this tombstone.
function extractAddonGrantCandidateRefs(event: DodoWebhookEvent): string[] {
	const subject = getEventSubject(event);
	const candidates = [
		extractPaymentId(event),
		readStringField(subject, ["invoice_id", "invoiceId"]),
		event.id,
	];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0 && !seen.has(candidate)) {
			seen.add(candidate);
			out.push(candidate);
		}
	}
	return out;
}

function extractTimestamp(subject: Record<string, unknown>, keys: string[]): string | undefined {
	const value = readStringField(subject, keys);
	if (!value) return undefined;
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed > 0) {
		return new Date(parsed < 10_000_000_000 ? parsed * 1000 : parsed).toISOString();
	}
	return value;
}

function isPastTimestamp(timestamp: string | undefined, now: Date): boolean {
	if (!timestamp) return false;
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return false;
	return parsed <= now.getTime();
}

// A timestamp counts as "future" (i.e. a still-current paid period) only when it
// is present, parseable, and strictly after now. Missing/unparseable values are
// treated as NOT current so reactivation fails closed.
function isFutureTimestamp(timestamp: string | undefined | null, now: Date): boolean {
	if (!timestamp) return false;
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return false;
	return parsed > now.getTime();
}

async function findWorkspaceIdByEvent(tx: DodoSqlClient, event: DodoWebhookEvent): Promise<string | null> {
	const subscriptionId = extractSubscriptionId(event);
	const customerId = extractCustomerId(event);
	if (!subscriptionId && !customerId) return null;
	const rows = await tx.unsafe<{ workspace_id: string }>(`
		SELECT workspace_id
		FROM workspace_billing_customers
		WHERE ($1::text IS NOT NULL AND dodo_subscription_id = $1)
			OR ($2::text IS NOT NULL AND dodo_customer_id = $2)
		LIMIT 1
	`, [subscriptionId ?? null, customerId ?? null]);
	return rows[0]?.workspace_id ?? null;
}

async function findWorkspaceIdByPaymentId(tx: DodoSqlClient, paymentId: string | undefined): Promise<string | null> {
	if (!paymentId) return null;
	const rows = await tx.unsafe<{ workspace_id: string }>(`
		SELECT workspace_id
		FROM workspace_billing_accounts
		WHERE metadata->>'dodo_payment_id' = $1
		LIMIT 1
	`, [paymentId]);
	return rows[0]?.workspace_id ?? null;
}

// Billing statuses the plan-resolution joins honor as in-effect (mirror of
// billing-store ACTIVE_BILLING_STATUSES / usage-ledger's `status IN (...)`). Kept
// local so the dunning grace check can ask "does this account currently grant access"
// without importing the billing-store (which would drag its store wiring in).
const ACCESS_GRANTING_STATUSES = ["mock_active", "trialing", "active"] as const;

// Expected price FLOOR (minor units) a metadata-only `payment.succeeded` must clear to
// grant a paid plan. Derived from the published monthly USD price (plans.ts). Coupons
// in this codebase cap at 100% off, but a real paid grant via the forge-able metadata
// path must still be a positive charge — so the floor is the discounted monthly price
// with the maximum allowed discount applied, clamped to a strictly-positive minimum.
// Yearly purchases pay >= 1 monthly cycle, so the monthly-discounted floor is a safe
// lower bound for both cycles. A known product_id bypasses this (Dodo owns that price).
const MAX_CHECKOUT_DISCOUNT_FRACTION = 0.9; // allow up to 90% off via coupon
function expectedPlanFloorCents(planKey: DodoPlanKey): bigint {
	const internal = DODO_TO_INTERNAL_PLAN[planKey];
	const monthlyUsd = WORKSPACE_PLANS[internal]?.priceUsdMonthly ?? 0;
	const fullCents = Math.round(monthlyUsd * 100);
	if (fullCents <= 0) return 1n; // even a "free"-keyed grant must be a positive charge
	const discounted = Math.floor(fullCents * (1 - MAX_CHECKOUT_DISCOUNT_FRACTION));
	return BigInt(Math.max(discounted, 1));
}

// A Dodo payment can carry its product id inside product_cart[] when the top-level
// product_id is absent. Return the first cart product id, if any.
function readProductIdFromCart(subject: Record<string, unknown>): string | undefined {
	const cart = subject.product_cart;
	if (!Array.isArray(cart)) return undefined;
	for (const item of cart) {
		const id = readStringField(item, ["product_id", "productId"]);
		if (id) return id;
	}
	return undefined;
}

// A single trusted add-on line: its product id plus the validated purchase quantity.
// The quantity multiplies the grant (a paid `{ product_id, quantity: 2 }` of a 50-pack
// grants 100 credits / inserts 2 storage packs). It is ALWAYS a clamped positive
// integer (see parseAddonQuantity) so a forged/absurd quantity can never over-grant.
interface TrustedAddonLine {
	productId: string;
	quantity: number;
}

// A resolved add-on grant: the catalog add-on product + the validated purchase quantity
// (clamped positive integer). The grant path multiplies the per-unit grant by quantity.
interface ResolvedAddonGrant {
	addon: BillingAddonProduct;
	quantity: number;
}

// A concrete, idempotency-anchored add-on grant to apply. A pure projection of a trusted
// payment (no forge-able fields), so it can be persisted as a DEFERRED grant during a
// chargeback hold and replayed verbatim on favorable resolution — the stable anchor keeps
// the eventual grant exactly-once even if a webhook replay also tries to apply it.
interface AddonGrantDescriptor {
	kind: "ai_credits" | "storage";
	addonId: string;
	anchor: string;
	amount?: number; // ai_credits: total credits to mint (quantity × packSize)
	bytes?: number; // storage: pack size in bytes (one descriptor per purchased pack)
}

// Upper bound on a single add-on line's quantity. A real cart never buys thousands of
// credit/storage packs in one line; a huge value is almost certainly a forged/erroneous
// payload, so we clamp (and the caller logs) rather than mint an unbounded grant.
const MAX_ADDON_LINE_QUANTITY = 1000;

// Upper bound on the LOST-dispute payment-ref tombstone set (denied_addon_payment_refs).
// One entry per lost-disputed payment for the workspace; a real account loses very few
// disputes, so this is generous. Bounding it keeps the metadata JSONB from growing without
// limit under pathological replay; we keep the MOST RECENT refs (newest losses) when full.
const MAX_DENIED_ADDON_PAYMENT_REFS = 256;

// Parse a cart/addon line `quantity` into a SAFE positive integer in [1, MAX]. Defaults
// to 1 when absent. Returns `{ quantity, clamped }` so the caller can audit-log a clamp.
// Rejects non-positive / non-finite / non-integer values down to 1; caps absurd values
// to MAX_ADDON_LINE_QUANTITY. A fractional value (e.g. 2.5) floors to its integer part
// (2) when that is still >= 1, else falls back to 1 — never rounds UP into an over-grant.
function parseAddonQuantity(raw: unknown): { quantity: number; clamped: boolean } {
	let value: number | undefined;
	if (typeof raw === "number") {
		value = raw;
	} else if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) value = parsed;
	} else if (raw === undefined || raw === null) {
		return { quantity: 1, clamped: false };
	}
	if (value === undefined || !Number.isFinite(value)) {
		// Unparseable/garbage quantity → fail safe to a single unit (a real paid line
		// always has at least 1), and flag it so the caller can log the coercion.
		return { quantity: 1, clamped: true };
	}
	const floored = Math.floor(value);
	if (floored < 1) return { quantity: 1, clamped: true };
	if (floored > MAX_ADDON_LINE_QUANTITY) return { quantity: MAX_ADDON_LINE_QUANTITY, clamped: true };
	return { quantity: floored, clamped: floored !== value };
}

// Collect EVERY product id a webhook subject carries in a TRUSTED position, so the
// add-on grant path can map them to configured add-on products. Trusted positions are
// the top-level product_id, each product_cart[] entry's product_id, AND each cart
// entry's nested addons[].addon_id (Dodo nests purchased add-ons under the cart line).
// Forge-able metadata is deliberately NOT a source here. Order/duplicates are preserved
// so two of the same pack on one payment each get their own grant occurrence. Each line
// carries its purchased `quantity` (clamped positive integer) so a paid multi-unit line
// (`{ product_id, quantity: 2 }`) grants the full purchased amount, not a single unit.
// The top-level product_id has no per-line quantity field, so it is always quantity 1.
function collectTrustedAddonProductIds(subject: Record<string, unknown>): TrustedAddonLine[] {
	const lines: TrustedAddonLine[] = [];
	const topLevel = readStringField(subject, ["product_id", "productId"]);
	if (topLevel) lines.push({ productId: topLevel, quantity: 1 });
	const cart = subject.product_cart;
	if (Array.isArray(cart)) {
		for (const item of cart) {
			const lineProductId = readStringField(item, ["product_id", "productId"]);
			if (lineProductId) {
				const itemRecord = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
				const { quantity, clamped } = parseAddonQuantity(itemRecord.quantity ?? (itemRecord as Record<string, unknown>).qty);
				if (clamped) {
					console.warn("[dodo] add-on cart line quantity clamped", { productId: lineProductId, raw: itemRecord.quantity ?? (itemRecord as Record<string, unknown>).qty, used: quantity });
				}
				lines.push({ productId: lineProductId, quantity });
			}
			const nestedAddons = (item && typeof item === "object" ? (item as Record<string, unknown>).addons : undefined);
			if (Array.isArray(nestedAddons)) {
				for (const addon of nestedAddons) {
					const addonProductId = readStringField(addon, ["addon_id", "addonId", "product_id", "productId"]);
					if (addonProductId) {
						const addonRecord = addon && typeof addon === "object" ? (addon as Record<string, unknown>) : {};
						const { quantity, clamped } = parseAddonQuantity(addonRecord.quantity ?? (addonRecord as Record<string, unknown>).qty);
						if (clamped) {
							console.warn("[dodo] add-on nested line quantity clamped", { addonId: addonProductId, raw: addonRecord.quantity ?? (addonRecord as Record<string, unknown>).qty, used: quantity });
						}
						lines.push({ productId: addonProductId, quantity });
					}
				}
			}
		}
	}
	return lines;
}

// Is there a billing-customer row whose linked Dodo subscription is currently active?
// Used by the stale-payment guard so a legitimately-active subscription's late payment
// can still restore access even when the stored period end is missing/stale.
async function hasActiveLinkedSubscription(tx: DodoSqlClient, workspaceId: string): Promise<boolean> {
	const rows = await tx.unsafe<{ status: string | null; dodo_subscription_id: string | null }>(`
		SELECT status, dodo_subscription_id
		FROM workspace_billing_customers
		WHERE workspace_id = $1
		LIMIT 1
	`, [workspaceId]);
	const row = rows[0];
	if (!row?.dodo_subscription_id) return false;
	return (row.status ?? "").trim().toLowerCase() === "active";
}

interface RefundRollup {
	grossPaidCents: bigint;
	refundedAbsCents: bigint;
	disputedAbsCents: bigint;
}

// Roll up the recorded ledger for a single Dodo payment: gross paid (positive payment
// rows), refunded (absolute magnitude of the negative refund rows), and disputed
// (absolute magnitude of negative dispute rows, net of any positive reversal). Used to
// decide whether refunds have fully clawed back a charge so the entitlement is revoked.
// All summed exactly as integer cents via BigInt — never through a lossy JS number.
async function refundRollupForPayment(tx: DodoSqlClient, paymentId: string): Promise<RefundRollup> {
	const rows = await tx.unsafe<{ kind: string; amount_cents: string | number | null }>(`
		SELECT kind, amount_cents
		FROM payment_transactions
		WHERE dodo_payment_id = $1
	`, [paymentId]);
	let grossPaid = 0n;
	let refunded = 0n;
	let disputed = 0n;
	for (const row of rows) {
		if (row.amount_cents === null || row.amount_cents === undefined) continue;
		let cents: bigint;
		try {
			cents = BigInt(normalizeCents(String(row.amount_cents)));
		} catch {
			continue;
		}
		if (row.kind === "payment") {
			if (cents > 0n) grossPaid += cents;
		} else if (row.kind === "refund") {
			if (cents < 0n) refunded += -cents;
		} else if (row.kind === "dispute") {
			// Dispute rows are negative when opened, positive on a favorable reversal; the
			// NET (sum) is the amount actually clawed back. A fully-reversed dispute nets 0.
			disputed += cents;
		}
	}
	// disputed accumulated as signed sum; a net-positive (over-reversed) is clamped to 0.
	const disputedAbs = disputed < 0n ? -disputed : 0n;
	return { grossPaidCents: grossPaid, refundedAbsCents: refunded, disputedAbsCents: disputedAbs };
}

// Resolve the disputed payment id for a resolution event that may not re-send it. Prefer
// the dispute row recorded by dispute.opened (dodo_event_ref = disputeId carries the
// payment id), else any payment_transactions row already linked to this dispute. Used to
// scope the LOST-dispute payment-ref tombstone when the resolution payload omits payment_id.
async function findPaymentIdByDisputeId(tx: DodoSqlClient, disputeId: string | undefined): Promise<string | null> {
	if (!disputeId) return null;
	const rows = await tx.unsafe<{ dodo_payment_id: string | null }>(`
		SELECT dodo_payment_id
		FROM payment_transactions
		WHERE kind = 'dispute' AND dodo_event_ref = $1 AND dodo_payment_id IS NOT NULL
		LIMIT 1
	`, [disputeId]);
	return rows[0]?.dodo_payment_id ?? null;
}

// Recover the disputed payment's INVOICE id from the dispute.opened payment_transactions
// row (dodo_event_ref = disputeId carries the invoice id we persisted on record). Used to
// make the LOST-dispute payment-ref tombstone SYMMETRIC with `extractAddonGrantRef`: an
// add-on payment that carried NO payment_id anchored its grant descriptors on its
// invoice_id, so the loss tombstone must include that invoice_id or the later first-seen
// `invoice.paid`/`payment.succeeded` redelivery (same invoice_id) would slip past the
// payment-id-only tombstone and re-mint the clawed-back add-on.
async function findInvoiceIdByDisputeId(tx: DodoSqlClient, disputeId: string | undefined): Promise<string | null> {
	if (!disputeId) return null;
	const rows = await tx.unsafe<{ dodo_invoice_id: string | null }>(`
		SELECT dodo_invoice_id
		FROM payment_transactions
		WHERE kind = 'dispute' AND dodo_event_ref = $1 AND dodo_invoice_id IS NOT NULL
		LIMIT 1
	`, [disputeId]);
	return rows[0]?.dodo_invoice_id ?? null;
}

async function findWorkspaceIdByDisputeId(tx: DodoSqlClient, disputeId: string | undefined): Promise<string | null> {
	if (!disputeId) return null;
	const rows = await tx.unsafe<{ workspace_id: string }>(`
		SELECT workspace_id
		FROM chargeback_disputes
		WHERE dodo_dispute_id = $1
		LIMIT 1
	`, [disputeId]);
	return rows[0]?.workspace_id ?? null;
}

async function hasPendingChargeback(tx: DodoSqlClient, workspaceId: string): Promise<boolean> {
	// Authoritative source is workspaces.chargeback_pending. Fall back to the
	// billing-account metadata flag in case the workspaces row is missing (e.g.
	// dispute recorded against a payment before the workspace row was backfilled).
	const workspaceRows = await tx.unsafe<{ chargeback_pending: boolean }>(`
		SELECT chargeback_pending
		FROM workspaces
		WHERE workspace_id = $1
		LIMIT 1
	`, [workspaceId]);
	if (workspaceRows[0]?.chargeback_pending === true) return true;

	const accountRows = await tx.unsafe<{ chargeback_pending: unknown }>(`
		SELECT metadata->>'chargeback_pending' AS chargeback_pending
		FROM workspace_billing_accounts
		WHERE workspace_id = $1
		LIMIT 1
	`, [workspaceId]);
	return accountRows[0]?.chargeback_pending === "true" || accountRows[0]?.chargeback_pending === true;
}


async function findBillingCustomer(tx: DodoSqlClient, input: { workspaceId: string }): Promise<{ dodo_customer_id: string; dodo_subscription_id?: string | null } | null> {
	const rows = await tx.unsafe<{ dodo_customer_id: string; dodo_subscription_id?: string | null }>(`
		SELECT dodo_customer_id, dodo_subscription_id
		FROM workspace_billing_customers
		WHERE workspace_id = $1
		LIMIT 1
	`, [input.workspaceId]);
	return rows[0] ?? null;
}

interface BillingAccountState {
	status: string | null;
	current_period_end: string | null;
	chargeback_pending: boolean;
}

// Normalize a billing-account `metadata` column (jsonb that the driver may hand back as a
// parsed object OR a raw JSON string) into a plain object. Never throws — a malformed
// string yields {}.
function parseMetadata(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}
	if (value && typeof value === "object") return value;
	return {};
}

// Order-preserving string dedupe for accumulating tombstone anchor arrays.
function dedupeStrings(values: string[]): string[] {
	return [...new Set(values)];
}

// MONEY-CRITICAL (P1 lost-update serialization): take a row-level write lock on the
// workspace's billing-account row so a read-modify-write of its `metadata` JSONB (e.g.
// the deferred-add-on-grant ledger) cannot interleave with a concurrent webhook for the
// SAME workspace. `SELECT ... FOR UPDATE` makes a second transaction BLOCK until the
// first commits, so the second then reads the first's committed array and appends to it
// (no clobbering `metadata || ...` write loses a paid deferred grant). Runs inside the
// webhook's BEGIN (`this.transaction`), so the lock is held for the rest of the txn and
// released on commit. Selecting `1` (not a column) keeps it a pure advisory row-lock;
// the row may not exist yet (first event for the workspace), in which case there is
// nothing to lock and nothing to clobber — the subsequent UPDATE is a no-op anyway.
async function lockBillingAccountRow(tx: DodoSqlClient, workspaceId: string): Promise<void> {
	await tx.unsafe(`
		SELECT 1
		FROM workspace_billing_accounts
		WHERE workspace_id = $1
		FOR UPDATE
	`, [workspaceId]);
}

// Read the current billing-account row so out-of-order webhooks can decide
// whether a (re)activation is legitimate. Returns null when no account exists
// yet (first event for the workspace), in which case callers proceed normally.
async function findBillingAccountState(tx: DodoSqlClient, workspaceId: string): Promise<BillingAccountState | null> {
	const rows = await tx.unsafe<{ status: string | null; current_period_end: string | Date | null; metadata: Record<string, unknown> | string | null }>(`
		SELECT status, current_period_end, metadata
		FROM workspace_billing_accounts
		WHERE workspace_id = $1
		LIMIT 1
	`, [workspaceId]);
	const row = rows[0];
	if (!row) return null;
	let metadata: Record<string, unknown> = {};
	if (typeof row.metadata === "string") {
		try {
			metadata = JSON.parse(row.metadata) as Record<string, unknown>;
		} catch {
			metadata = {};
		}
	} else if (row.metadata && typeof row.metadata === "object") {
		metadata = row.metadata;
	}
	const periodEnd = row.current_period_end instanceof Date
		? row.current_period_end.toISOString()
		: (row.current_period_end ?? null);
	return {
		status: row.status ?? null,
		current_period_end: periodEnd,
		chargeback_pending: metadata.chargeback_pending === true || metadata.chargeback_pending === "true",
	};
}

async function findBillingAccount(tx: DodoSqlClient, input: { workspaceId: string }): Promise<{ metadata: Record<string, unknown> } | null> {
	const rows = await tx.unsafe<{ metadata: Record<string, unknown> | string | null }>(`
		SELECT metadata
		FROM workspace_billing_accounts
		WHERE workspace_id = $1
		LIMIT 1
	`, [input.workspaceId]);
	const metadata = rows[0]?.metadata;
	if (!metadata) return null;
	if (typeof metadata === "string") {
		try {
			return { metadata: JSON.parse(metadata) as Record<string, unknown> };
		} catch {
			return { metadata: {} };
		}
	}
	return { metadata };
}

// Best-effort workspace display name for the receipt email. Falls back to the
// caller's default (the workspace id) on any miss/error.
async function findWorkspaceName(tx: DodoSqlClient, workspaceId: string): Promise<string | undefined> {
	try {
		const rows = await tx.unsafe<{ name: string | null }>(
			"SELECT name FROM workspaces WHERE workspace_id = $1 LIMIT 1",
			[workspaceId],
		);
		return rows[0]?.name?.trim() || undefined;
	} catch {
		return undefined;
	}
}

// The stored billing email (set from prior Dodo events). Used only as a fallback
// when THIS event's subject carried no customer_email. Best-effort.
async function findBillingEmail(tx: DodoSqlClient, workspaceId: string): Promise<string | undefined> {
	try {
		const rows = await tx.unsafe<{ billing_email: string | null }>(
			"SELECT billing_email FROM workspace_billing_accounts WHERE workspace_id = $1 LIMIT 1",
			[workspaceId],
		);
		return rows[0]?.billing_email?.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function upsertBillingCustomer(tx: DodoSqlClient, input: {
	workspaceId: string;
	customerId: string;
	subscriptionId?: string;
	paymentMethodId?: string;
	status: string;
}): Promise<void> {
	await tx.unsafe(`
		INSERT INTO workspace_billing_customers (
			workspace_id, dodo_customer_id, dodo_subscription_id, dodo_payment_method_id, status, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, now(), now())
		ON CONFLICT (workspace_id) DO UPDATE SET
			dodo_customer_id = EXCLUDED.dodo_customer_id,
			dodo_subscription_id = COALESCE(EXCLUDED.dodo_subscription_id, workspace_billing_customers.dodo_subscription_id),
			dodo_payment_method_id = COALESCE(EXCLUDED.dodo_payment_method_id, workspace_billing_customers.dodo_payment_method_id),
			status = EXCLUDED.status,
			updated_at = now()
	`, [input.workspaceId, input.customerId, input.subscriptionId ?? null, input.paymentMethodId ?? null, input.status]);
}

async function upsertBillingAccount(tx: DodoSqlClient, input: {
	workspaceId: string;
	// Undefined when the incoming event carried no recognizable plan (unknown
	// product_id + no metadata.plan_key). In that case we must NOT overwrite the
	// stored plan — see syncSubscriptionFromEvent — so the plan column is preserved
	// via COALESCE on conflict and falls back to "free" only for a brand-new row.
	planId: WorkspacePlanId | undefined;
	status: "active" | "cancelled";
	billingEmail?: string;
	currentPeriodStart?: string;
	currentPeriodEnd?: string;
	metadata: Record<string, unknown>;
}): Promise<void> {
	const resolvedPlanId = input.planId ? normalizeWorkspacePlanId(input.planId) : null;
	// Insert default for a first-time row when the plan is unknown: a renewal/update
	// for a workspace with no prior billing row and no resolvable plan should not
	// invent a paid tier, so fall back to "free". For an EXISTING row, COALESCE keeps
	// the stored plan_id untouched (the parameter is null → EXCLUDED.plan_id is null).
	const insertPlanId = resolvedPlanId ?? "free";
	await tx.unsafe(`
		INSERT INTO workspace_billing_accounts (
			workspace_id, plan_id, status, billing_email, current_period_start, current_period_end, metadata, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, now(), now())
		ON CONFLICT (workspace_id) DO UPDATE SET
			plan_id = COALESCE($8, workspace_billing_accounts.plan_id),
			status = EXCLUDED.status,
			billing_email = COALESCE(EXCLUDED.billing_email, workspace_billing_accounts.billing_email),
			current_period_start = COALESCE(EXCLUDED.current_period_start, workspace_billing_accounts.current_period_start),
			current_period_end = COALESCE(EXCLUDED.current_period_end, workspace_billing_accounts.current_period_end),
			metadata = workspace_billing_accounts.metadata || EXCLUDED.metadata,
			updated_at = now()
		`, [
			input.workspaceId,
			insertPlanId,
			input.status,
			input.billingEmail ?? null,
			input.currentPeriodStart ?? null,
			input.currentPeriodEnd ?? null,
			JSON.stringify(input.metadata),
			resolvedPlanId,
		]);
	}

async function upsertBillingAccountStatus(tx: DodoSqlClient, input: {
	workspaceId: string;
	// MONEY-CRITICAL (P1 plant-then-activate): a PAID plan_id may be written here ONLY
	// when the caller passes a VALIDATED `planId` (derived from the validatePaidGrant
	// key). It is `undefined` for every non-granting status transition (past_due /
	// on_hold / subscription.failed / dunning), and in that case this function NEVER
	// writes a metadata-derived paid plan:
	//   - NEW row: plan_id defaults to 'free' (NOT a metadata plan), so a failed/on_hold
	//     event on a never-validated workspace can't PLANT a paid tier that a later
	//     unvalidated subscription.active would then COALESCE-preserve into access.
	//   - EXISTING row: the ON CONFLICT branch writes plan_id ONLY from the VALIDATED
	//     `planId` param (COALESCE($6, existing.plan_id)). A validated grant upgrades the
	//     stored plan (even from 'free' — a real customer who paid is no longer stuck
	//     free); a non-granting write (planId undefined → $6 null) PRESERVES the stored
	//     plan. The param is the ONLY thing that can set the existing plan_id, and it is
	//     set solely from the validatePaidGrant key — never from forge-able metadata — so
	//     the plant-then-activate exploit stays closed.
	planId: WorkspacePlanId | undefined;
	status: "active" | "past_due";
	billingEmail?: string;
	metadata: Record<string, unknown>;
}): Promise<void> {
	const resolvedPlanId = input.planId ? normalizeWorkspacePlanId(input.planId) : null;
	// New-row insert default: only a VALIDATED plan is granted; an unvalidated/absent
	// plan (every past_due path) falls back to 'free' so no paid tier is ever planted.
	// The ON CONFLICT branch upgrades plan_id ONLY from the validated $6 param (null →
	// preserve), so an existing free row that pays is upgraded while a non-granting write
	// leaves the stored plan untouched.
	const insertPlanId = resolvedPlanId ?? "free";
	await tx.unsafe(`
		INSERT INTO workspace_billing_accounts (
			workspace_id, plan_id, status, billing_email, current_period_start, current_period_end, metadata, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, NULL, NULL, $5::text::jsonb, now(), now())
		ON CONFLICT (workspace_id) DO UPDATE SET
			plan_id = COALESCE($6, workspace_billing_accounts.plan_id),
			status = EXCLUDED.status,
			billing_email = COALESCE(EXCLUDED.billing_email, workspace_billing_accounts.billing_email),
			metadata = workspace_billing_accounts.metadata || EXCLUDED.metadata,
			updated_at = now()
	`, [
		input.workspaceId,
		insertPlanId,
		input.status,
		input.billingEmail ?? null,
		JSON.stringify(input.metadata),
		resolvedPlanId,
	]);
}

function readObjectField(source: unknown, keys: string[]): Record<string, unknown> | undefined {
	if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
	const record = source as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	}
	return undefined;
}

function readStringField(source: unknown, keys: string[]): string | undefined {
	if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
	const record = source as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}

function readNumberField(source: unknown, keys: string[]): number | undefined {
	if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
	const record = source as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	}
	return undefined;
}

// Dodo payment/refund amounts (total_amount, amount, settlement_amount, tax) are
// already in the smallest denomination of the currency (cents). Read them as an
// EXACT integer-cents STRING — never via Number()/Math.round(), which would
// silently truncate a value above Number.MAX_SAFE_INTEGER. Returns undefined when
// no field is present. The transaction stores bind this string straight to the
// bigint column with no lossy coercion.
function readMinorUnits(source: Record<string, unknown>, keys: string[]): string | undefined {
	return readMinorUnitCents(source, keys) ?? undefined;
}

// Thin wrapper over the SHARED dispute amount reader (../utils/dispute.js) so the
// live path and the backfill convert a Dodo dispute amount the SAME way: prefer an
// explicit minor-unit field, else parse the major-unit decimal string DECIMAL-SAFELY
// and CURRENCY-AWARELY ("19.99" USD → 1999; "1900" JPY → 1900, not 190000).
function readDisputeMinorUnits(subject: Record<string, unknown>, currency: string | null | undefined): string | null {
	return readDisputeMinorUnitsShared(subject, readMinorUnits, currency);
}

function extractMetadataBillingCycle(event: DodoWebhookEvent): string | null {
	const subject = getEventSubject(event);
	const metadata = readObjectField(subject, ["metadata"]) ?? readObjectField(event, ["metadata"]);
	return readStringField(metadata, ["billing_cycle", "billingCycle"]) ?? null;
}

interface PaymentTransactionRowInput {
	workspaceId: string | null;
	dodoPaymentId?: string | null;
	dodoInvoiceId?: string | null;
	dodoEventRef: string | null;
	dodoEventId: string | null;
	kind: "payment" | "refund" | "dispute";
	// Minor units (cents). Accept number | bigint | string so a decimal-safe integer
	// string (e.g. from the dispute major-unit converter) is bound to the bigint
	// column without a lossy round-trip through a JS number.
	amountCents: number | bigint | string;
	taxCents?: number | bigint | string | null;
	currency?: string | null;
	status?: string | null;
	planId?: string | null;
	billingCycle?: string | null;
	occurredAt?: string | null;
	raw: Record<string, unknown>;
}

// Idempotent revenue-row upsert run on the WEBHOOK transaction (same `tx` as the
// dodo_webhook_events insert), so the existing per-event idempotency already
// prevents double recording. The unique indexes from migration 0052 are a second
// line of defence (and what the backfill relies on). Mirrors the
// PostgresPaymentTransactionsStore.upsertTransaction SQL exactly. When neither a
// ref nor an event id is available there is no dedupe key — skip rather than risk
// duplicate revenue rows.
async function upsertPaymentTransactionRow(tx: DodoSqlClient, input: PaymentTransactionRowInput): Promise<void> {
	const eventRef = input.dodoEventRef?.trim() || null;
	const eventId = input.dodoEventId?.trim() || null;
	if (!eventRef && !eventId) return;
	const occurredAt = input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt))
		? new Date(input.occurredAt).toISOString()
		: new Date().toISOString();
	const conflictTarget = eventRef ? "(kind, dodo_event_ref)" : "(dodo_event_id)";
	await tx.unsafe(`
		INSERT INTO payment_transactions (
			id, workspace_id, dodo_payment_id, dodo_invoice_id, dodo_event_ref, dodo_event_id,
			kind, amount_cents, tax_cents, currency, status, plan_id, billing_cycle, occurred_at, raw
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
		ON CONFLICT ${conflictTarget} DO UPDATE SET
			workspace_id = COALESCE(payment_transactions.workspace_id, EXCLUDED.workspace_id),
			dodo_payment_id = COALESCE(payment_transactions.dodo_payment_id, EXCLUDED.dodo_payment_id),
			dodo_invoice_id = COALESCE(payment_transactions.dodo_invoice_id, EXCLUDED.dodo_invoice_id),
			dodo_event_ref = COALESCE(payment_transactions.dodo_event_ref, EXCLUDED.dodo_event_ref),
			dodo_event_id = COALESCE(payment_transactions.dodo_event_id, EXCLUDED.dodo_event_id),
			amount_cents = EXCLUDED.amount_cents,
			tax_cents = COALESCE(EXCLUDED.tax_cents, payment_transactions.tax_cents),
			currency = COALESCE(EXCLUDED.currency, payment_transactions.currency),
			status = COALESCE(EXCLUDED.status, payment_transactions.status),
			plan_id = COALESCE(EXCLUDED.plan_id, payment_transactions.plan_id),
			billing_cycle = COALESCE(EXCLUDED.billing_cycle, payment_transactions.billing_cycle),
			occurred_at = EXCLUDED.occurred_at,
			-- MERGE raw (existing || incoming) rather than replace. When a Dodo refund
			-- WEBHOOK dedupes onto an EXISTING support-console refund row (the support path
			-- now records its row keyed on the SAME provider refund id, so one provider
			-- refund = one ledger row), the support row's provenance (source / initiated_by /
			-- reason / supportIdempotencyKey) MUST survive while the webhook payload folds in.
			raw = payment_transactions.raw || EXCLUDED.raw
	`, [
		randomUUID(),
		input.workspaceId,
		input.dodoPaymentId ?? null,
		input.dodoInvoiceId ?? null,
		eventRef,
		eventId,
		input.kind,
		// Bind cents as a decimal-safe INTEGER STRING (bigint column) — never coerce
		// through a JS number, so large amounts and decimal-derived values stay exact.
		normalizeCents(input.amountCents),
		input.taxCents === undefined || input.taxCents === null ? null : normalizeCents(input.taxCents),
		input.currency?.trim()?.toUpperCase() || null,
		input.status?.trim() || null,
		input.planId?.trim() || null,
		input.billingCycle?.trim() || null,
		occurredAt,
		// Bind the raw OBJECT (not JSON.stringify(...)) to $15::text::jsonb so it lands as a jsonb
		// OBJECT, not a quoted jsonb STRING SCALAR. The latter breaks `raw || EXCLUDED.raw`
		// merge and any `raw->>key` lookup (e.g. a support row's supportIdempotencyKey).
		input.raw ?? {},
	]);
}
