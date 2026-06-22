// One-shot backfill: replay historical Dodo webhook deliveries into the
// payment_transactions revenue table (migration 0052).
//
// Before that migration, payment.succeeded / invoice.paid / refund / dispute
// webhooks only mutated a metadata string — the amount/currency/date were never
// extracted, even though the raw JSON was preserved in dodo_webhook_events.payload.
// This script parses those stored payloads and upserts the corresponding revenue
// rows so historical revenue isn't lost.
//
// SAFE TO RE-RUN: every row is an idempotent upsert keyed on (kind, dodo_event_ref)
// / dodo_event_id (the same unique indexes the live record path uses), so re-running
// converges on the same rows and never double-counts.
//
// Usage:
//   bun run src/scripts/backfill-payment-transactions.ts            (live)
//   bun run src/scripts/backfill-payment-transactions.ts --dry-run  (count only)
//
// Requires DATABASE_URL. The extraction logic is exported (extractTransactionsFromEvent)
// so tests can exercise it without a database.

import { randomUUID } from "crypto";
import { absCents, negateCents, normalizeCents, readMinorUnitCents } from "../utils/money.js";
import {
	DISPUTE_OPEN_EVENTS,
	DISPUTE_RESOLVED_EVENTS,
	eventTypeToDisputeStatus,
	isLostDisputeResolution,
	readDisputeMinorUnits as readDisputeMinorUnitsShared,
} from "../utils/dispute.js";

export interface BackfillSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

interface WebhookEventRow {
	id: string;
	type: string;
	payload: Record<string, unknown> | string;
}

export interface BackfilledTransaction {
	workspaceId: string | null;
	dodoPaymentId: string | null;
	dodoInvoiceId: string | null;
	dodoEventRef: string | null;
	dodoEventId: string | null;
	kind: "payment" | "refund" | "dispute";
	// Minor units (cents) as an EXACT integer string (or a literal number for the
	// 0 default). Carried as a string end-to-end so a value above
	// Number.MAX_SAFE_INTEGER is never silently truncated before binding to the
	// bigint column.
	amountCents: number | string;
	taxCents: number | string | null;
	currency: string | null;
	status: string | null;
	planId: string | null;
	billingCycle: string | null;
	occurredAt: string | null;
	raw: Record<string, unknown>;
}

const DODO_TO_INTERNAL_PLAN: Record<string, string> = {
	starter: "creator",
	pro: "pro",
	studio: "studio",
	studio_plus: "studio_plus",
};

const PAYMENT_TYPES = new Set(["payment.succeeded", "invoice.paid"]);
const REFUND_TYPES = new Set(["payment.refunded", "refund.succeeded", "refund.created"]);
// Dispute OPEN vs RESOLVED classification (and the favorable-vs-lost predicate) is
// imported from ../utils/dispute.js — the SAME source of truth the live webhook path
// uses — so the backfill can't drift from the live record path.

// Per-dispute amount/currency carried forward while replaying events in order, so a
// favorable resolution can source its +reversal magnitude from the original
// dispute.opened row (mirrors the live path's "prefer the opened row, fall back to
// the resolution payload" rule without a DB round-trip).
export interface DisputeContext {
	amountCents: string | null;
	currency: string | null;
}

/**
 * Map ONE stored webhook event to the revenue rows it implies (0, 1). The
 * `eventId` is the dodo_webhook_events primary key (webhook-id), used for
 * dodo_event_id idempotency. Mirrors the live record path in dodo.service.ts.
 *
 * `disputeContext` carries the amount/currency seen on each dispute's OPEN event so a
 * later favorable RESOLUTION (won/cancelled/expired, or a favorable
 * payment.chargeback.resolved) can emit the SAME +reversal row the live
 * `resolveChargeback` path writes. It is read (resolution) and written (open) here so
 * a single in-order replay reconciles a payment + dispute.opened + dispute.won to the
 * original payment instead of leaving a net-zero hole.
 */
export function extractTransactionsFromEvent(
	eventId: string,
	type: string,
	payload: unknown,
	disputeContext: Map<string, DisputeContext> = new Map(),
): BackfilledTransaction[] {
	const event = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
	const subject = readSubject(event);

	if (PAYMENT_TYPES.has(type)) {
		const paymentId = readString(subject, ["payment_id", "paymentId"]) ?? readString(event, ["payment_id", "paymentId"]);
		const invoiceId = readString(subject, ["invoice_id", "invoiceId"]);
		const ref = paymentId ?? invoiceId ?? eventId ?? null;
		if (!ref) return [];
		const planKey = readPlanKey(event, subject);
		return [{
			workspaceId: readWorkspaceId(event, subject),
			dodoPaymentId: paymentId ?? null,
			dodoInvoiceId: invoiceId ?? null,
			dodoEventRef: ref,
			dodoEventId: eventId ?? null,
			kind: "payment",
			amountCents: readMinor(subject, ["total_amount", "amount", "settlement_amount"]) ?? 0,
			taxCents: readMinor(subject, ["tax", "settlement_tax"]) ?? null,
			currency: readString(subject, ["currency", "settlement_currency"]) ?? null,
			status: readString(subject, ["status"]) ?? "succeeded",
			planId: planKey ? DODO_TO_INTERNAL_PLAN[planKey] ?? null : null,
			billingCycle: readString(subject, ["billing_cycle", "billingCycle"]) ?? readBillingCycle(event, subject),
			occurredAt: readTimestamp(subject, ["created_at", "createdAt", "settled_at", "settledAt", "timestamp"]),
			raw: subject,
		}];
	}

	if (REFUND_TYPES.has(type)) {
		const refundId = readString(subject, ["refund_id", "refundId", "id"]);
		const paymentId = readString(subject, ["payment_id", "paymentId"]);
		const ref = refundId ?? paymentId ?? eventId ?? null;
		if (!ref) return [];
		const amount = readMinor(subject, ["amount", "total_amount", "settlement_amount"]) ?? 0;
		return [{
			workspaceId: readWorkspaceId(event, subject),
			dodoPaymentId: paymentId ?? null,
			dodoInvoiceId: null,
			dodoEventRef: ref,
			dodoEventId: eventId ?? null,
			kind: "refund",
			// Refunds reduce revenue: store NEGATIVE (decimal-safe string) so a SUM nets.
			amountCents: negateCents(absCents(amount)),
			taxCents: null,
			currency: readString(subject, ["currency"]) ?? null,
			status: readString(subject, ["status"]) ?? "refunded",
			planId: null,
			billingCycle: null,
			occurredAt: readTimestamp(subject, ["created_at", "createdAt", "timestamp"]),
			raw: subject,
		}];
	}

	if (DISPUTE_OPEN_EVENTS.has(type)) {
		const disputeId = readString(subject, ["dispute_id", "id", "chargeback_id"]) ?? eventId;
		const paymentId = readString(subject, ["payment_id", "paymentId"]);
		const ref = disputeId ?? null;
		if (!ref) return [];
		const currency = readString(subject, ["currency"]) ?? null;
		const amount = readDisputeMinor(subject, currency);
		// Remember the opened magnitude/currency so a later favorable resolution can
		// reverse the EXACT same amount (mirrors the live path's source-of-truth row).
		disputeContext.set(disputeId, { amountCents: amount, currency });
		return [{
			workspaceId: readWorkspaceId(event, subject),
			dodoPaymentId: paymentId ?? null,
			dodoInvoiceId: null,
			dodoEventRef: ref,
			dodoEventId: eventId ?? null,
			kind: "dispute",
			amountCents: amount === null ? "0" : negateCents(absCents(amount)),
			taxCents: null,
			currency,
			status: readString(subject, ["status", "dispute_status"]) ?? "opened",
			planId: null,
			billingCycle: null,
			occurredAt: readTimestamp(subject, ["created_at", "createdAt", "timestamp"]),
			raw: subject,
		}];
	}

	if (DISPUTE_RESOLVED_EVENTS.has(type)) {
		const disputeId = readString(subject, ["dispute_id", "id", "chargeback_id"]) ?? eventId;
		const ref = disputeId ?? null;
		if (!ref) return [];
		const paymentId = readString(subject, ["payment_id", "paymentId"]);
		const resolvedStatus = readString(subject, ["status"]) ?? eventTypeToDisputeStatus(type);
		// Fail-closed (shared predicate): a terminal loss/accepted, or a generic
		// payment.chargeback.resolved that isn't explicitly favorable, writes NO
		// reversal — the negative dispute.opened deduction stays. Only a favorable
		// resolution emits the +reversal row.
		if (isLostDisputeResolution(type, resolvedStatus)) return [];

		// Source the reversal magnitude the SAME way the live path does: prefer the
		// original dispute.opened amount (its source of truth), else the resolution
		// payload itself. Currency follows the opened row, then the payload.
		const payloadCurrency = readString(subject, ["currency"]) ?? null;
		const opened = disputeContext.get(disputeId);
		let magnitude = opened?.amountCents && opened.amountCents !== null ? absCents(opened.amountCents) : null;
		let currency = opened?.currency ?? payloadCurrency;
		if (!magnitude || magnitude === "0") {
			const payloadAmount = readDisputeMinor(subject, payloadCurrency);
			magnitude = payloadAmount === null ? null : absCents(payloadAmount);
			currency = payloadCurrency ?? opened?.currency ?? null;
		}
		// Nothing to reverse (no opened amount and no payload amount) — no row.
		if (!magnitude || magnitude === "0") return [];
		return [{
			workspaceId: readWorkspaceId(event, subject),
			dodoPaymentId: paymentId ?? null,
			dodoInvoiceId: null,
			// DISTINCT ref so the +reversal never overwrites the opened row's negative;
			// idempotent on (kind, dodo_event_ref) just like the live reversal.
			dodoEventRef: `${disputeId}:reversal`,
			dodoEventId: eventId ?? null,
			kind: "dispute",
			// POSITIVE magnitude → nets the opened deduction back to the payment.
			amountCents: absCents(magnitude),
			taxCents: null,
			currency,
			status: resolvedStatus,
			planId: null,
			billingCycle: null,
			occurredAt: readTimestamp(subject, ["created_at", "createdAt", "resolved_at", "resolvedAt", "timestamp"]),
			raw: subject,
		}];
	}

	return [];
}

export interface BackfillResult {
	scanned: number;
	upserted: number;
	skipped: number;
}

/**
 * Stream dodo_webhook_events and upsert the derived revenue rows. `dryRun` counts
 * the rows that WOULD be written without touching payment_transactions.
 */
export async function backfillPaymentTransactions(client: BackfillSqlClient, options: { dryRun?: boolean } = {}): Promise<BackfillResult> {
	const events = await client.unsafe<WebhookEventRow>(`
		SELECT id, type, payload
		FROM dodo_webhook_events
		ORDER BY received_at ASC
	`);
	let upserted = 0;
	let skipped = 0;
	// Replay is ordered (received_at ASC), so each dispute's OPEN event is seen before
	// its resolution; this carries the opened amount/currency forward so a favorable
	// resolution reverses the exact disputed amount.
	const disputeContext = new Map<string, DisputeContext>();
	for (const row of events) {
		let payload: unknown = row.payload;
		if (typeof payload === "string") {
			try {
				payload = JSON.parse(payload);
			} catch {
				payload = {};
			}
		}
		const transactions = extractTransactionsFromEvent(row.id, row.type, payload, disputeContext);
		if (transactions.length === 0) {
			skipped += 1;
			continue;
		}
		for (const tx of transactions) {
			if (options.dryRun) {
				upserted += 1;
				continue;
			}
			await upsertRow(client, tx);
			upserted += 1;
		}
	}
	return { scanned: events.length, upserted, skipped };
}

async function upsertRow(client: BackfillSqlClient, tx: BackfilledTransaction): Promise<void> {
	const eventRef = tx.dodoEventRef?.trim() || null;
	const eventId = tx.dodoEventId?.trim() || null;
	if (!eventRef && !eventId) return;
	const occurredAt = tx.occurredAt && !Number.isNaN(Date.parse(tx.occurredAt))
		? new Date(tx.occurredAt).toISOString()
		: new Date().toISOString();
	const conflictTarget = eventRef ? "(kind, dodo_event_ref)" : "(dodo_event_id)";
	await client.unsafe(`
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
			-- MERGE raw (existing || incoming) rather than replace — SAME as the live
			-- webhook (dodo.service.ts) and support (payment-transactions-store) paths.
			-- A backfill of a Dodo refund WEBHOOK can dedupe onto an EXISTING support-console
			-- refund row (both keyed on the SAME provider refund id via (kind, dodo_event_ref)),
			-- so the support row's provenance (source / initiated_by / reason /
			-- supportIdempotencyKey) MUST survive — clobbering it would let a later same-key
			-- support replay miss the row via raw->>'supportIdempotencyKey' and re-enter the
			-- provider refund path (money-out safety would drop to provider-idempotency only).
			raw = payment_transactions.raw || EXCLUDED.raw
	`, [
		randomUUID(),
		tx.workspaceId,
		tx.dodoPaymentId,
		tx.dodoInvoiceId,
		eventRef,
		eventId,
		tx.kind,
		// Decimal-safe integer STRING bound to the bigint column.
		normalizeCents(tx.amountCents),
		tx.taxCents === null ? null : normalizeCents(tx.taxCents),
		tx.currency?.trim()?.toUpperCase() || null,
		tx.status?.trim() || null,
		tx.planId?.trim() || null,
		tx.billingCycle?.trim() || null,
		occurredAt,
		// Bind the raw OBJECT (not JSON.stringify(...)) to $15::jsonb so it lands as a jsonb
		// OBJECT, matching the live record path — a pre-stringified string stores a jsonb
		// STRING SCALAR that breaks `raw->>key` lookups and the raw merge on later upserts.
		tx.raw ?? {},
	]);
}

// --- payload readers (mirror dodo.service.ts) -------------------------------

function readSubject(event: Record<string, unknown>): Record<string, unknown> {
	const data = event.data ?? event.payload;
	return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

function readString(source: unknown, keys: string[]): string | undefined {
	if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
	const record = source as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}

// Read a minor-unit (cents) field as an EXACT integer-cents STRING — never via
// Number()/Math.round(), which would silently truncate a value above
// Number.MAX_SAFE_INTEGER. Mirrors dodo.service.ts readMinorUnits.
function readMinor(source: Record<string, unknown>, keys: string[]): string | undefined {
	return readMinorUnitCents(source, keys) ?? undefined;
}

// Returns positive-magnitude integer cents as a STRING (decimal-safe; currency-aware
// so a JPY/zero-decimal dispute isn't inflated 100x) or null. Delegates to the SAME
// shared reader the live dodo.service.ts path uses so the two can't drift.
function readDisputeMinor(subject: Record<string, unknown>, currency: string | null | undefined): string | null {
	return readDisputeMinorUnitsShared(subject, readMinor, currency);
}

function readObject(source: unknown, keys: string[]): Record<string, unknown> | undefined {
	if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
	const record = source as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	}
	return undefined;
}

function readWorkspaceId(event: Record<string, unknown>, subject: Record<string, unknown>): string | null {
	const metadata = readObject(subject, ["metadata"]) ?? readObject(event, ["metadata"]);
	return readString(metadata, ["workspace_id", "workspaceId"])
		?? readString(subject, ["workspace_id", "workspaceId"])
		?? readString(event, ["workspace_id", "workspaceId"])
		?? null;
}

function readPlanKey(event: Record<string, unknown>, subject: Record<string, unknown>): string | null {
	const metadata = readObject(subject, ["metadata"]) ?? readObject(event, ["metadata"]);
	const raw = readString(metadata, ["plan_key", "planKey"]) ?? readString(subject, ["plan_key", "planKey"]);
	if (raw === "starter" || raw === "pro" || raw === "studio" || raw === "studio_plus") return raw;
	return null;
}

function readBillingCycle(event: Record<string, unknown>, subject: Record<string, unknown>): string | null {
	const metadata = readObject(subject, ["metadata"]) ?? readObject(event, ["metadata"]);
	return readString(metadata, ["billing_cycle", "billingCycle"]) ?? null;
}

function readTimestamp(subject: Record<string, unknown>, keys: string[]): string | null {
	const value = readString(subject, keys);
	if (!value) return null;
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed > 0) {
		return new Date(parsed < 10_000_000_000 ? parsed * 1000 : parsed).toISOString();
	}
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		console.error("DATABASE_URL is required to backfill payment_transactions");
		process.exitCode = 1;
		return;
	}
	const client = new Bun.SQL(databaseUrl) as unknown as BackfillSqlClient;
	try {
		const result = await backfillPaymentTransactions(client, { dryRun });
		console.log(`${dryRun ? "[dry-run] " : ""}Scanned ${result.scanned} webhook events; ${result.upserted} transaction rows ${dryRun ? "would be" : ""} upserted, ${result.skipped} non-revenue events skipped.`);
	} finally {
		await client.close?.();
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
