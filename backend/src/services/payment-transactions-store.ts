// Revenue persistence store (payment_transactions).
//
// One row per money-movement event — a payment, a refund, or a chargeback/dispute
// — extracted from the Dodo webhook payloads. This is the source of truth for ALL
// dollar reports (MRR cash, revenue timeseries, transactions list, refunds/disputes,
// accounting CSV). Amounts are stored in MINOR UNITS (cents) as integers exactly as
// Dodo emits them; refunds/disputes are stored NEGATIVE so a plain SUM nets.
//
// Mirrors the existing `file | postgres` store-selection pattern (billing-store.ts):
// an in-memory + JSON file store for local/test runtimes, and a Postgres store
// (writing the migration 0052 payment_transactions table) when DATABASE_URL + the
// billing store toggle are set.
//
// This module is the data layer ONLY. The HTTP revenue-report endpoints that consume
// these methods land in later gated PRs (rank 5-7); they are deliberately not built
// here. The record path (live webhook ingest) lives in dodo.service.ts and calls
// `upsertTransaction`; the backfill (scripts/backfill-payment-transactions.ts) replays
// dodo_webhook_events into this same store via the same idempotent upsert.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { absCents, centsStringToNumber, normalizeCents } from "../utils/money.js";

export type PaymentTransactionKind = "payment" | "refund" | "dispute";

export interface PaymentTransaction {
	id: string;
	workspaceId: string | null;
	dodoPaymentId: string | null;
	dodoInvoiceId: string | null;
	/** Refund id (refund rows) or dispute id (dispute rows); null for payments. */
	dodoEventRef: string | null;
	/** webhook-id of the Dodo delivery that produced this row (idempotency). */
	dodoEventId: string | null;
	kind: PaymentTransactionKind;
	/** Minor units (cents). Positive for payments, negative for refunds/disputes. */
	amountCents: number;
	/** Tax portion in minor units (payments only); null otherwise. */
	taxCents: number | null;
	currency: string | null;
	status: string | null;
	planId: string | null;
	billingCycle: string | null;
	/** When the money movement occurred (Dodo created_at), ISO 8601. */
	occurredAt: string;
	raw: Record<string, unknown>;
	createdAt: string;
}

/**
 * Idempotent upsert input. Either `dodoEventId` (per-delivery) or
 * (`kind` + `dodoEventRef`) (per money-movement) is the dedupe key. Both the live
 * record path and the backfill converge on the same row.
 */
export interface UpsertPaymentTransactionInput {
	id?: string;
	workspaceId?: string | null;
	dodoPaymentId?: string | null;
	dodoInvoiceId?: string | null;
	dodoEventRef?: string | null;
	dodoEventId?: string | null;
	kind: PaymentTransactionKind;
	/**
	 * Minor units (cents). number | bigint | string so a decimal-safe integer string
	 * (e.g. from a dispute major-unit conversion) round-trips into the bigint column
	 * without a lossy JS-number multiply. Normalized to an integer string on write.
	 */
	amountCents: number | bigint | string;
	taxCents?: number | bigint | string | null;
	currency?: string | null;
	status?: string | null;
	planId?: string | null;
	billingCycle?: string | null;
	occurredAt?: string | null;
	raw?: Record<string, unknown>;
}

export interface ListTransactionsOptions {
	workspaceId?: string;
	kind?: PaymentTransactionKind;
	planId?: string;
	status?: string;
	/** Restrict to a single currency (ISO code, case-insensitive). */
	currency?: string;
	/** Inclusive lower bound on occurred_at (ISO). */
	from?: string;
	/** Exclusive upper bound on occurred_at (ISO). */
	to?: string;
	limit?: number;
	offset?: number;
}

export interface ListTransactionsResult {
	transactions: PaymentTransaction[];
	total: number;
}

/**
 * A stable, UNIQUE keyset cursor over the transactions ordering
 * `(occurred_at DESC, created_at DESC, id DESC)`. Every component is part of the
 * sort key so the tuple is unique (id is the final tiebreaker) and paging can never
 * skip or duplicate a row even when rows are inserted/deleted between page fetches.
 */
export interface TransactionsKeysetCursor {
	occurredAt: string;
	createdAt: string;
	id: string;
}

export interface ListTransactionsKeysetOptions {
	workspaceId?: string;
	kind?: PaymentTransactionKind;
	planId?: string;
	status?: string;
	/** Restrict to a single currency (ISO code, case-insensitive). */
	currency?: string;
	/** Inclusive lower bound on occurred_at (ISO). */
	from?: string;
	/** Exclusive upper bound on occurred_at (ISO). */
	to?: string;
	limit?: number;
	/** Resume strictly AFTER this row in the stable ordering (true keyset). */
	cursor?: TransactionsKeysetCursor | null;
}

export interface ListTransactionsKeysetResult {
	transactions: PaymentTransaction[];
	/** The keyset cursor for the NEXT page, or null when the page is the last. */
	nextCursor: TransactionsKeysetCursor | null;
}

export interface SumByPlanOptions {
	from?: string;
	to?: string;
	/** Restrict to a single currency (ISO code, case-insensitive). */
	currency?: string;
}

export interface SumByPlanRow {
	planId: string | null;
	kind: PaymentTransactionKind;
	/**
	 * Currency of THIS bucket. Sums are grouped by currency too — minor units in
	 * different currencies are NEVER added together (you cannot add 100 JPY to 100
	 * USD cents). One row per (currency, plan, kind). Null only for legacy rows with
	 * no recorded currency.
	 */
	currency: string | null;
	/**
	 * Net minor units across the matched rows for this (currency, plan, kind), as an
	 * integer STRING. A large total can exceed Number.MAX_SAFE_INTEGER, so it is kept
	 * as a string (no float coercion) and is JSON-serializable as-is.
	 */
	amountCents: string;
	count: number;
}

export interface SumByPeriodOptions {
	interval: "day" | "month";
	from?: string;
	to?: string;
	kind?: PaymentTransactionKind;
	/** Restrict to a single currency (ISO code, case-insensitive). */
	currency?: string;
}

export interface SumByPeriodRow {
	/** ISO date of the bucket start (UTC), truncated to the interval. */
	period: string;
	/**
	 * Currency of THIS bucket. Sums are grouped by currency too so amounts in
	 * different currencies are never summed together. One row per (period, currency).
	 */
	currency: string | null;
	/** Net minor units in the bucket as an integer STRING (precision-safe). */
	amountCents: string;
	count: number;
}

export const PAYMENT_TX_DEFAULT_LIMIT = 50;
export const PAYMENT_TX_MAX_LIMIT = 500;

/**
 * The refund state of ONE original charge, used to validate an operator-issued
 * support refund against the money that actually came in (money-out safety, P1).
 *
 * A charge is identified by its `dodo_payment_id`. The original PAYMENT row(s) carry
 * `kind='payment', dodo_payment_id=<chargeId>`; every REFUND issued against it (webhook
 * OR support-console) carries `kind='refund', dodo_payment_id=<chargeId>` and a NEGATIVE
 * `amount_cents`; every lost chargeback/dispute carries `kind='dispute'` and a NEGATIVE
 * `amount_cents` too. This rolls those up so the caller can reject a refund that would
 * refund more than was paid, double-pay after a chargeback, use the wrong currency, or
 * target a charge that does not exist.
 *
 * All amounts are POSITIVE integer-cents STRINGS (decimal-safe, magnitude-unbounded):
 *   * `originalPaidCents` — the gross paid for the charge (sum of its payment rows).
 *   * `alreadyRefundedCents` — the absolute total already refunded against it.
 *   * `alreadyDisputedCents` — the absolute net chargeback/dispute clawback against it.
 *   * `remainingRefundableCents` — `originalPaidCents - alreadyRefundedCents - alreadyDisputedCents`, floored at 0.
 */
export interface ChargeRefundState {
	/** Whether at least one PAYMENT row exists for this charge id. */
	found: boolean;
	/** The charge's currency (ISO, upper-case) as recorded on its payment row(s); null if none. */
	currency: string | null;
	/** Gross paid for the charge, positive integer-cents STRING. */
	originalPaidCents: string;
	/** Absolute total already refunded against the charge, positive integer-cents STRING. */
	alreadyRefundedCents: string;
	/** Absolute net dispute/chargeback clawback against the charge, positive integer-cents STRING. */
	alreadyDisputedCents: string;
	/** originalPaidCents − alreadyRefundedCents − alreadyDisputedCents, floored at 0, positive integer-cents STRING. */
	remainingRefundableCents: string;
}

/**
 * The locked, per-charge handle a support-refund critical section operates through
 * (money-out concurrency safety, P1). Every method here reads/writes COMMITTED-inside-
 * the-lock state for ONE charge: while the section runs, no other refund for the same
 * charge can interleave (Postgres `pg_advisory_xact_lock(hashtext(chargeId))`; file mode
 * a per-charge async mutex). This is what makes "re-read cumulative → dedupe → validate
 * → provider money-out → record" atomic, so two concurrent SAME-key refunds call the
 * provider exactly once and two concurrent DIFFERENT-key partials can never out-refund
 * the original.
 */
export interface ChargeRefundCriticalSection {
	/**
	 * SAME-key dedupe INSIDE the lock: the existing `(kind='refund', dodoEventRef=key)`
	 * row for this charge, or null. A concurrent retry that already committed its row is
	 * seen here, so the provider is NOT called a second time.
	 */
	findRefundByRef(dodoEventRef: string): Promise<PaymentTransaction | null>;
	/**
	 * PRE-PROVIDER replay dedupe by the SUPPORT idempotency key INSIDE the lock.
	 *
	 * The canonical dedupe ref of a support refund is the PROVIDER refund id (so the
	 * later Dodo refund webhook dedupes onto the SAME row — one provider refund = one
	 * ledger row). But the operator-supplied idempotency key is only known BEFORE the
	 * provider call, so it cannot also be the row's `dodo_event_ref`. We therefore stash
	 * it in the refund row's `raw.supportIdempotencyKey` and look it up here, scoped to
	 * THIS charge's refund rows, to short-circuit a retried/concurrent SAME-key support
	 * refund WITHOUT issuing a second provider money-out. Returns the existing row or null.
	 */
	findRefundBySupportKey(idempotencyKey: string): Promise<PaymentTransaction | null>;
	/**
	 * Cumulative refund state for THIS charge, re-read INSIDE the lock (so it reflects
	 * every refund that committed before this section acquired the lock). The cap check
	 * (`requested + alreadyRefunded <= originalPaid`) runs against this snapshot.
	 */
	getChargeRefundState(): Promise<ChargeRefundState>;
	/**
	 * Record the negative refund row INSIDE the lock (the money-out reservation+finalize).
	 * Committed when the section returns; rolled back if the section throws (e.g. the
	 * provider call failed) so a failed refund leaves NO phantom row blocking a retry.
	 */
	recordRefund(input: UpsertPaymentTransactionInput): Promise<PaymentTransaction>;
}

export interface PaymentTransactionsStore {
	/** Idempotent insert-or-update keyed on dodoEventId / (kind, dodoEventRef). */
	upsertTransaction(input: UpsertPaymentTransactionInput): Promise<PaymentTransaction>;
	/**
	 * Serialize a support refund's whole critical section PER CHARGE so the cumulative
	 * cap check, the SAME-key dedupe, the provider money-out, and the ledger write are
	 * ATOMIC against every other refund for the same `chargeId` (money-out safety, P1).
	 *
	 * The callback runs while the charge is exclusively held (Postgres advisory xact lock
	 * inside a transaction; file mode a per-charge mutex). It MUST, in order: dedupe via
	 * `findRefundByRef` (return early WITHOUT calling the provider if a row exists), re-read
	 * `getChargeRefundState` and validate the cumulative cap/currency, call the provider,
	 * then `recordRefund`. If the callback throws after the provider call, the row write is
	 * rolled back so a retry is clean. ONLY one provider call ever fires per (charge, key),
	 * and the SUM of refunds for a charge can NEVER exceed the original.
	 */
	runChargeRefundCritical<T>(
		chargeId: string,
		workspaceId: string | null | undefined,
		fn: (section: ChargeRefundCriticalSection) => Promise<T>,
	): Promise<T>;
	/**
	 * Look up the single existing row for a `(kind, dodoEventRef)` logical key, or null.
	 * This is the SAME dedupe key `upsertTransaction` converges on. The support-refund
	 * path calls this FIRST so a retried refund (same idempotency key) is detected and
	 * returned WITHOUT re-calling the payment provider — closing the window where a
	 * provider refund fired before the idempotent ledger upsert (money-out safety, P1).
	 */
	findByEventRef(kind: PaymentTransactionKind, dodoEventRef: string): Promise<PaymentTransaction | null>;
	/**
	 * The existing refund row for `chargeId` whose `raw.supportIdempotencyKey` equals the
	 * given key, or null. Backs the PRE-PROVIDER replay dedupe of a support refund (whose
	 * canonical dedupe ref is the provider refund id, not the idempotency key) — see
	 * `ChargeRefundCriticalSection.findRefundBySupportKey`.
	 */
	findRefundBySupportKey(chargeId: string, idempotencyKey: string, workspaceId?: string | null): Promise<PaymentTransaction | null>;
	/**
	 * Roll up the original-charge state for a refund validation: the gross paid, the
	 * currency, the cumulative amount ALREADY refunded, and the net amount ALREADY
	 * disputed/charged back against the charge id (`dodo_payment_id`). Optionally scoped
	 * to a workspace. Decimal-safe (BigInt) so it is exact at any magnitude. The
	 * support-refund path uses this to REJECT a refund that exceeds the remaining
	 * refundable amount, is in the wrong currency, or targets a charge with no recorded
	 * payment (money-out safety, P1).
	 */
	getChargeRefundState(chargeId: string, workspaceId?: string | null): Promise<ChargeRefundState>;
	/** Filtered + paginated transactions (newest first) with a matching total. */
	listTransactions(options?: ListTransactionsOptions): Promise<ListTransactionsResult>;
	/**
	 * Filtered transactions paged by a TRUE keyset cursor over the stable, unique
	 * ordering `(occurred_at DESC, created_at DESC, id DESC)`. Unlike `listTransactions`
	 * (OFFSET-based, which can skip/dup rows when the set changes mid-pagination), this
	 * resumes strictly after the cursor row, so visiting every page reads each matching
	 * row exactly once even under concurrent inserts/deletes. This is the cursor used by
	 * the revenue /transactions endpoint AND the accountant export.
	 */
	listTransactionsKeyset(options?: ListTransactionsKeysetOptions): Promise<ListTransactionsKeysetResult>;
	/** Count of rows matching the filters (no paging) — the size of the keyset set. */
	countTransactions(options?: ListTransactionsOptions): Promise<number>;
	/** Net minor units grouped by (currency, plan_id, kind) over the filtered window. */
	sumByPlan(options?: SumByPlanOptions): Promise<SumByPlanRow[]>;
	/** Net minor units bucketed by (period, currency) over the filtered window. */
	sumByPeriod(options: SumByPeriodOptions): Promise<SumByPeriodRow[]>;
}

interface PaymentTransactionsSnapshot {
	transactions: PaymentTransaction[];
}

interface PaymentTxSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	/**
	 * Run `fn` inside a Bun.SQL transaction on a single reserved connection (so an
	 * advisory xact lock taken inside it actually serializes across connections). When
	 * absent we fall back to explicit BEGIN/COMMIT/ROLLBACK on the pooled client.
	 */
	begin?<T>(fn: (transaction: PaymentTxSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

export class PaymentTransactionsStoreError extends Error {
	constructor(message: string, readonly code = "payment_tx_store_error") {
		super(message);
		this.name = "PaymentTransactionsStoreError";
	}
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return PAYMENT_TX_DEFAULT_LIMIT;
	const floored = Math.floor(limit);
	if (floored < 1) return 1;
	return Math.min(floored, PAYMENT_TX_MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
	if (offset === undefined || !Number.isFinite(offset)) return 0;
	return Math.max(0, Math.floor(offset));
}

/**
 * Compare two rows under the stable, UNIQUE transactions ordering
 * `(occurred_at DESC, created_at DESC, id DESC)`. Returns <0 when `a` sorts BEFORE
 * `b` (i.e. `a` is "newer"/earlier in the page sequence). Used by the file-mode
 * keyset list so its ordering matches the Postgres `ORDER BY ... DESC` exactly.
 */
function compareTxDesc(a: { occurredAt: string; createdAt: string; id: string }, b: { occurredAt: string; createdAt: string; id: string }): number {
	return b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function toKeysetCursor(tx: PaymentTransaction): TransactionsKeysetCursor {
	return { occurredAt: tx.occurredAt, createdAt: tx.createdAt, id: tx.id };
}

function toIso(value: string | null | undefined): string {
	if (!value) return new Date().toISOString();
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return new Date().toISOString();
	return new Date(parsed).toISOString();
}

function truncateToInterval(iso: string, interval: "day" | "month"): string {
	const date = new Date(iso);
	if (interval === "day") {
		return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
	}
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

function buildIdempotencyKey(input: { dodoEventId?: string | null; kind: string; dodoEventRef?: string | null }): string | null {
	// Match the Postgres conflict target EXACTLY: prefer the logical (kind, ref) key
	// — a given money movement is one row regardless of how many webhook deliveries
	// (different webhook-ids) reference it — and only fall back to the per-delivery
	// event id when no ref is present. Preferring the event id here (the old order)
	// caused file mode to DUPE a re-delivered webhook that carried a different
	// webhook-id but the same payment/refund/dispute ref, diverging from Postgres.
	if (input.dodoEventRef?.trim()) return `ref:${input.kind}:${input.dodoEventRef.trim()}`;
	if (input.dodoEventId?.trim()) return `evt:${input.dodoEventId.trim()}`;
	return null;
}

/**
 * In-memory store with optional JSON persistence (local + test runtimes). Upsert is
 * idempotent on the event id / (kind, ref) key, exactly like the Postgres unique
 * indexes. Writes are atomic: a failed persist rolls back the in-memory mutation.
 */
export class FilePaymentTransactionsStore implements PaymentTransactionsStore {
	private readonly transactions: PaymentTransaction[] = [];
	private readonly byKey = new Map<string, PaymentTransaction>();
	/**
	 * Per-charge serialization tail (money-out safety, P1). The file store is a single
	 * in-process map, but a support refund's "read cumulative → dedupe → provider call →
	 * write" critical section is async and spans an await on the provider; two concurrent
	 * refunds for the SAME charge could otherwise both read refunded=0 and both fire the
	 * provider. We chain each charge's critical sections onto a per-charge promise so they
	 * run strictly one-at-a-time (the in-process analogue of the Postgres advisory lock).
	 */
	private readonly chargeRefundLocks = new Map<string, Promise<unknown>>();

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	async runChargeRefundCritical<T>(
		chargeId: string,
		workspaceId: string | null | undefined,
		fn: (section: ChargeRefundCriticalSection) => Promise<T>,
	): Promise<T> {
		const charge = chargeId.trim();
		const section: ChargeRefundCriticalSection = {
			findRefundByRef: (dodoEventRef) => this.findByEventRef("refund", dodoEventRef),
			findRefundBySupportKey: (idempotencyKey) => this.findRefundBySupportKey(charge, idempotencyKey, workspaceId),
			getChargeRefundState: () => this.getChargeRefundState(charge, workspaceId),
			recordRefund: (input) => this.upsertTransaction(input),
		};
		// Chain this critical section onto the charge's tail so sections for the SAME
		// charge run strictly one-at-a-time. We swallow the prior section's outcome
		// (`catch`) so one failed refund never poisons the next waiter's turn.
		const prior = (this.chargeRefundLocks.get(charge) ?? Promise.resolve()).catch(() => undefined);
		const run = prior.then(() => fn(section));
		// The next waiter chains on a settled-either-way promise (never rejects).
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.chargeRefundLocks.set(charge, tail);
		try {
			return await run;
		} finally {
			// GC the map entry once we are the last section for this charge (no newer
			// waiter replaced the tail), so a long-lived store does not accumulate keys.
			if (this.chargeRefundLocks.get(charge) === tail) this.chargeRefundLocks.delete(charge);
		}
	}

	async upsertTransaction(input: UpsertPaymentTransactionInput): Promise<PaymentTransaction> {
		const key = buildIdempotencyKey(input);
		const now = new Date().toISOString();
		const existing = key ? this.byKey.get(key) : undefined;
		const record: PaymentTransaction = {
			id: existing?.id ?? input.id ?? crypto.randomUUID(),
			workspaceId: input.workspaceId?.trim() || existing?.workspaceId || null,
			dodoPaymentId: input.dodoPaymentId?.trim() || existing?.dodoPaymentId || null,
			dodoInvoiceId: input.dodoInvoiceId?.trim() || existing?.dodoInvoiceId || null,
			dodoEventRef: input.dodoEventRef?.trim() || existing?.dodoEventRef || null,
			dodoEventId: input.dodoEventId?.trim() || existing?.dodoEventId || null,
			kind: input.kind,
			// Normalize cents decimal-safely (string → exact integer) before storing.
			// The per-row PUBLIC shape is a JS number; a realistic single-transaction
			// amount fits, and the precision-critical aggregation (sumByPlan /
			// sumByPeriod) re-parses via BigInt. `centsStringToNumber` HARD-REJECTS
			// (throws) a magnitude above Number.MAX_SAFE_INTEGER rather than silently
			// truncating — no wrong cent value is ever persisted.
			amountCents: centsStringToNumber(normalizeCents(input.amountCents)),
			taxCents: input.taxCents === undefined || input.taxCents === null ? (existing?.taxCents ?? null) : centsStringToNumber(normalizeCents(input.taxCents)),
			currency: input.currency?.trim()?.toUpperCase() || existing?.currency || null,
			status: input.status?.trim() || existing?.status || null,
			planId: input.planId?.trim() || existing?.planId || null,
			billingCycle: input.billingCycle?.trim() || existing?.billingCycle || null,
			occurredAt: toIso(input.occurredAt ?? existing?.occurredAt),
			// MERGE raw (existing then incoming) to mirror the Postgres `raw || EXCLUDED.raw`
			// upsert: when a Dodo refund WEBHOOK dedupes onto an EXISTING support-console
			// refund row, the support row's provenance (source / initiated_by / reason /
			// supportIdempotencyKey) must survive while the webhook's payload fields fold in
			// (incoming wins on any key collision).
			raw: input.raw ? { ...(existing?.raw ?? {}), ...input.raw } : (existing?.raw ?? {}),
			createdAt: existing?.createdAt ?? now,
		};

		const previousList = existing ? [...this.transactions] : undefined;
		if (existing) {
			const index = this.transactions.findIndex((tx) => tx.id === existing.id);
			if (index >= 0) this.transactions[index] = record;
		} else {
			this.transactions.push(record);
		}
		if (key) this.byKey.set(key, record);

		try {
			this.persist();
		} catch (error) {
			if (existing && previousList) {
				this.transactions.length = 0;
				this.transactions.push(...previousList);
				this.byKey.set(key as string, existing);
			} else {
				const index = this.transactions.findIndex((tx) => tx.id === record.id);
				if (index >= 0) this.transactions.splice(index, 1);
				if (key) this.byKey.delete(key);
			}
			throw error;
		}
		return { ...record };
	}

	async findByEventRef(kind: PaymentTransactionKind, dodoEventRef: string): Promise<PaymentTransaction | null> {
		const ref = dodoEventRef.trim();
		if (!ref) return null;
		// Same key shape buildIdempotencyKey uses for a (kind, ref) row.
		const existing = this.byKey.get(`ref:${kind}:${ref}`);
		return existing ? { ...existing } : null;
	}

	async findRefundBySupportKey(chargeId: string, idempotencyKey: string, workspaceId?: string | null): Promise<PaymentTransaction | null> {
		const charge = chargeId.trim();
		const key = idempotencyKey.trim();
		const ws = workspaceId?.trim() || null;
		if (!charge || !key) return null;
		for (const tx of this.transactions) {
			if (tx.kind !== "refund") continue;
			if (tx.dodoPaymentId !== charge) continue;
			if (ws && tx.workspaceId !== ws) continue;
			if (typeof tx.raw?.supportIdempotencyKey === "string" && tx.raw.supportIdempotencyKey === key) {
				return { ...tx };
			}
		}
		return null;
	}

	async getChargeRefundState(chargeId: string, workspaceId?: string | null): Promise<ChargeRefundState> {
		const charge = chargeId.trim();
		const ws = workspaceId?.trim() || null;
		let paid = BigInt(0);
		let refunded = BigInt(0);
		let disputed = BigInt(0);
		let found = false;
		let currency: string | null = null;
		for (const tx of this.transactions) {
			if (tx.dodoPaymentId !== charge) continue;
			if (ws && tx.workspaceId !== ws) continue;
			// BigInt keeps the rollup exact at any magnitude.
			const abs = BigInt(absCents(tx.amountCents));
			if (tx.kind === "payment") {
				found = true;
				paid += abs;
				if (!currency && tx.currency) currency = tx.currency;
			} else if (tx.kind === "refund") {
				refunded += abs;
			} else if (tx.kind === "dispute") {
				disputed += BigInt(tx.amountCents);
			}
		}
		const disputedAbs = disputed < BigInt(0) ? -disputed : BigInt(0);
		const remaining = paid - refunded - disputedAbs;
		return {
			found,
			currency,
			originalPaidCents: paid.toString(),
			alreadyRefundedCents: refunded.toString(),
			alreadyDisputedCents: disputedAbs.toString(),
			remainingRefundableCents: (remaining > BigInt(0) ? remaining : BigInt(0)).toString(),
		};
	}

	async listTransactions(options: ListTransactionsOptions = {}): Promise<ListTransactionsResult> {
		const limit = normalizeLimit(options.limit);
		const offset = normalizeOffset(options.offset);
		const filtered = this.transactions
			.filter((tx) => this.matches(tx, options))
			.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
		const page = filtered.slice(offset, offset + limit).map((tx) => ({ ...tx }));
		return { transactions: page, total: filtered.length };
	}

	async listTransactionsKeyset(options: ListTransactionsKeysetOptions = {}): Promise<ListTransactionsKeysetResult> {
		const limit = normalizeLimit(options.limit);
		const cursor = options.cursor ?? null;
		const filtered = this.transactions
			.filter((tx) => this.matches(tx, options))
			.sort(compareTxDesc)
			// Keyset: keep only rows strictly AFTER the cursor in the stable ordering.
			// compareTxDesc(cursor, tx) < 0 means the cursor row sorts before tx, i.e. tx
			// comes later in the page sequence — exactly the rows we still owe the client.
			.filter((tx) => (cursor ? compareTxDesc(cursor, tx) < 0 : true));
		const page = filtered.slice(0, limit).map((tx) => ({ ...tx }));
		const last = page[page.length - 1];
		// hasMore iff at least one matching row remains beyond this page.
		const hasMore = filtered.length > limit && Boolean(last);
		return { transactions: page, nextCursor: hasMore && last ? toKeysetCursor(last) : null };
	}

	async countTransactions(options: ListTransactionsOptions = {}): Promise<number> {
		let count = 0;
		for (const tx of this.transactions) {
			if (this.matches(tx, options)) count += 1;
		}
		return count;
	}

	async sumByPlan(options: SumByPlanOptions = {}): Promise<SumByPlanRow[]> {
		// CURRENCY-AWARE: group by (currency, plan, kind). Minor units in different
		// currencies are NEVER added together. Accumulate as BigInt so a large total
		// stays precise, then emit an integer string.
		const buckets = new Map<string, { planId: string | null; kind: PaymentTransactionKind; currency: string | null; amount: bigint; count: number }>();
		for (const tx of this.transactions) {
			if (!this.matches(tx, options)) continue;
			const currency = tx.currency ?? null;
			const key = `${currency ?? ""} ${tx.planId ?? ""} ${tx.kind}`;
			const row = buckets.get(key) ?? { planId: tx.planId, kind: tx.kind, currency, amount: BigInt(0), count: 0 };
			row.amount += BigInt(normalizeCents(tx.amountCents));
			row.count += 1;
			buckets.set(key, row);
		}
		return [...buckets.values()]
			.map((row) => ({ planId: row.planId, kind: row.kind, currency: row.currency, amountCents: row.amount.toString(), count: row.count }))
			.sort((a, b) =>
				(a.currency ?? "").localeCompare(b.currency ?? "")
				|| (a.planId ?? "").localeCompare(b.planId ?? "")
				|| a.kind.localeCompare(b.kind));
	}

	async sumByPeriod(options: SumByPeriodOptions): Promise<SumByPeriodRow[]> {
		// CURRENCY-AWARE: one bucket per (period, currency). Never add across currencies.
		const buckets = new Map<string, { period: string; currency: string | null; amount: bigint; count: number }>();
		for (const tx of this.transactions) {
			if (!this.matches(tx, options)) continue;
			const period = truncateToInterval(tx.occurredAt, options.interval);
			const currency = tx.currency ?? null;
			const key = `${period} ${currency ?? ""}`;
			const row = buckets.get(key) ?? { period, currency, amount: BigInt(0), count: 0 };
			row.amount += BigInt(normalizeCents(tx.amountCents));
			row.count += 1;
			buckets.set(key, row);
		}
		return [...buckets.values()]
			.map((row) => ({ period: row.period, currency: row.currency, amountCents: row.amount.toString(), count: row.count }))
			.sort((a, b) => a.period.localeCompare(b.period) || (a.currency ?? "").localeCompare(b.currency ?? ""));
	}

	private matches(tx: PaymentTransaction, options: { workspaceId?: string; kind?: PaymentTransactionKind; planId?: string; status?: string; currency?: string; from?: string; to?: string }): boolean {
		if (options.workspaceId && tx.workspaceId !== options.workspaceId) return false;
		if (options.kind && tx.kind !== options.kind) return false;
		if (options.planId && tx.planId !== options.planId) return false;
		if (options.status && tx.status !== options.status) return false;
		if (options.currency && tx.currency !== options.currency.trim().toUpperCase()) return false;
		if (options.from && tx.occurredAt < toIso(options.from)) return false;
		if (options.to && tx.occurredAt >= toIso(options.to)) return false;
		return true;
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<Partial<PaymentTransactionsSnapshot>>(this.persistPath);
			if (Array.isArray(snapshot.transactions)) {
				for (const tx of snapshot.transactions) {
					if (isTransaction(tx)) {
						this.transactions.push(tx);
						const key = buildIdempotencyKey(tx);
						if (key) this.byKey.set(key, tx);
					}
				}
			}
		} catch (error) {
			console.warn(`[PaymentTransactionsStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		mkdirSync(dirname(this.persistPath), { recursive: true });
		const snapshot: PaymentTransactionsSnapshot = { transactions: this.transactions };
		writeFileSync(this.persistPath, JSON.stringify(snapshot, null, 2));
	}
}

/**
 * Postgres-backed store. Reads/writes the migration 0052 payment_transactions table.
 * Upsert is idempotent on the (kind, dodo_event_ref) and dodo_event_id unique
 * indexes so re-delivered webhooks and re-run backfills never double-count.
 */
export class PostgresPaymentTransactionsStore implements PaymentTransactionsStore {
	private readonly client: PaymentTxSqlClient;

	constructor(databaseUrlOrClient: string | PaymentTxSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new PaymentTransactionsStoreError("PaymentTransactionsStore postgres mode requires DATABASE_URL", "payment_tx_store_unconfigured");
			}
			this.client = new Bun.SQL(databaseUrlOrClient) as unknown as PaymentTxSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	/**
	 * Serialize a support refund's critical section PER CHARGE on a real connection
	 * (money-out safety, P1). Opens a transaction, takes `pg_advisory_xact_lock(
	 * hashtext(chargeId))` (released automatically at COMMIT/ROLLBACK, so it cannot leak),
	 * then runs `fn` with a section whose reads/writes go through the SAME transaction —
	 * so the cumulative cap re-read, the SAME-key dedupe, the provider call, and the row
	 * write are atomic against every other refund for this charge. Two same-key refunds
	 * thus call the provider once; N different-key partials can never out-refund the
	 * original (the loser's cap check sees the winner's committed reservation row).
	 */
	async runChargeRefundCritical<T>(
		chargeId: string,
		workspaceId: string | null | undefined,
		fn: (section: ChargeRefundCriticalSection) => Promise<T>,
	): Promise<T> {
		const charge = chargeId.trim();
		const ws = workspaceId?.trim() || null;
		return this.runTransaction(async (tx) => {
			// Per-charge advisory lock: serializes every refund for THIS charge across
			// connections for the life of the transaction. hashtext maps the arbitrary
			// charge id to the bigint the lock takes.
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [charge]);
			const section: ChargeRefundCriticalSection = {
				findRefundByRef: (dodoEventRef) => this.findByEventRefOn(tx, "refund", dodoEventRef),
				findRefundBySupportKey: (idempotencyKey) => this.findRefundBySupportKeyOn(tx, charge, idempotencyKey, ws),
				getChargeRefundState: () => this.getChargeRefundStateOn(tx, charge, ws),
				recordRefund: (input) => this.upsertTransactionOn(tx, input),
			};
			return fn(section);
		});
	}

	/**
	 * Run `fn` inside a Bun.SQL transaction (so the advisory xact lock serializes across
	 * connections). Falls back to explicit BEGIN/COMMIT/ROLLBACK when the client lacks
	 * `begin`. Mirrors auth-users' runTransaction helper.
	 */
	private async runTransaction<T>(fn: (tx: PaymentTxSqlClient) => Promise<T>): Promise<T> {
		if (this.client.begin) return this.client.begin(fn);
		await this.client.unsafe("BEGIN");
		try {
			const result = await fn(this.client);
			await this.client.unsafe("COMMIT");
			return result;
		} catch (error) {
			await this.client.unsafe("ROLLBACK");
			throw error;
		}
	}

	upsertTransaction(input: UpsertPaymentTransactionInput): Promise<PaymentTransaction> {
		return this.upsertTransactionOn(this.client, input);
	}

	private async upsertTransactionOn(client: PaymentTxSqlClient, input: UpsertPaymentTransactionInput): Promise<PaymentTransaction> {
		// Conflict target: prefer the logical (kind, dodo_event_ref) key when a ref is
		// present (a refund/dispute always has one; a payment uses payment_id as its
		// ref), else the per-delivery dodo_event_id. Both map to the partial unique
		// indexes in migration 0052. On conflict we COALESCE so a later delivery can
		// fill in fields an earlier one lacked (e.g. workspace linkage) without nulling.
		const id = input.id ?? crypto.randomUUID();
		const eventRef = input.dodoEventRef?.trim() || null;
		const eventId = input.dodoEventId?.trim() || null;
		const occurredAt = toIso(input.occurredAt);
		const params = [
			id,
			input.workspaceId?.trim() || null,
			input.dodoPaymentId?.trim() || null,
			input.dodoInvoiceId?.trim() || null,
			eventRef,
			eventId,
			input.kind,
			// Decimal-safe integer STRING bound to the bigint column (no JS-number coercion).
			normalizeCents(input.amountCents),
			input.taxCents === undefined || input.taxCents === null ? null : normalizeCents(input.taxCents),
			input.currency?.trim()?.toUpperCase() || null,
			input.status?.trim() || null,
			input.planId?.trim() || null,
			input.billingCycle?.trim() || null,
			occurredAt,
			// Bind the raw OBJECT (not JSON.stringify(...)) to $15::jsonb. Bun.SQL serializes
			// a JS object into a jsonb OBJECT; binding a pre-stringified JSON string instead
			// stores a jsonb STRING SCALAR (the whole payload quoted), which makes `raw->>key`
			// (e.g. the supportIdempotencyKey lookup + raw merge) silently return NULL.
			input.raw ?? {},
		];
		const conflictTarget = eventRef ? "(kind, dodo_event_ref)" : "(dodo_event_id)";
		const rows = await client.unsafe<PaymentTransactionRow>(`
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
				-- MERGE raw (existing concat incoming) rather than replace: when a Dodo refund
				-- WEBHOOK dedupes onto an EXISTING support-console refund row (same provider
				-- refund id, same (kind, dodo_event_ref)), the support row's provenance
				-- (source / initiated_by / reason / supportIdempotencyKey) MUST survive while
				-- the webhook payload folds in. The jsonb concat keeps existing keys and lets
				-- the incoming payload win on any key collision.
				raw = payment_transactions.raw || EXCLUDED.raw
			RETURNING id, workspace_id, dodo_payment_id, dodo_invoice_id, dodo_event_ref, dodo_event_id,
				kind, amount_cents, tax_cents, currency, status, plan_id, billing_cycle, occurred_at, raw, created_at
		`, params);
		const row = rows[0];
		if (!row) throw new PaymentTransactionsStoreError("Failed to persist payment transaction", "payment_tx_upsert_failed");
		return mapTransactionRow(row);
	}

	findByEventRef(kind: PaymentTransactionKind, dodoEventRef: string): Promise<PaymentTransaction | null> {
		return this.findByEventRefOn(this.client, kind, dodoEventRef);
	}

	private async findByEventRefOn(client: PaymentTxSqlClient, kind: PaymentTransactionKind, dodoEventRef: string): Promise<PaymentTransaction | null> {
		const ref = dodoEventRef.trim();
		if (!ref) return null;
		// Matches the (kind, dodo_event_ref) partial unique index from migration 0052.
		const rows = await client.unsafe<PaymentTransactionRow>(`
			SELECT id, workspace_id, dodo_payment_id, dodo_invoice_id, dodo_event_ref, dodo_event_id,
				kind, amount_cents, tax_cents, currency, status, plan_id, billing_cycle, occurred_at, raw, created_at
			FROM payment_transactions
			WHERE kind = $1 AND dodo_event_ref = $2
			LIMIT 1
		`, [kind, ref]);
		const row = rows[0];
		return row ? mapTransactionRow(row) : null;
	}

	findRefundBySupportKey(chargeId: string, idempotencyKey: string, workspaceId?: string | null): Promise<PaymentTransaction | null> {
		return this.findRefundBySupportKeyOn(this.client, chargeId, idempotencyKey, workspaceId);
	}

	private async findRefundBySupportKeyOn(client: PaymentTxSqlClient, chargeId: string, idempotencyKey: string, workspaceId?: string | null): Promise<PaymentTransaction | null> {
		const charge = chargeId.trim();
		const key = idempotencyKey.trim();
		if (!charge || !key) return null;
		const params: unknown[] = [charge, key];
		let wsClause = "";
		if (workspaceId?.trim()) {
			params.push(workspaceId.trim());
			wsClause = ` AND workspace_id = $${params.length}`;
		}
		// Find THIS charge's refund row whose raw carries the support idempotency key. The
		// canonical dedupe ref is the provider refund id, so the idempotency key lives in
		// raw — this is the pre-provider replay guard for support refunds.
		const rows = await client.unsafe<PaymentTransactionRow>(`
			SELECT id, workspace_id, dodo_payment_id, dodo_invoice_id, dodo_event_ref, dodo_event_id,
				kind, amount_cents, tax_cents, currency, status, plan_id, billing_cycle, occurred_at, raw, created_at
			FROM payment_transactions
			WHERE kind = 'refund' AND dodo_payment_id = $1 AND raw->>'supportIdempotencyKey' = $2${wsClause}
			LIMIT 1
		`, params);
		const row = rows[0];
		return row ? mapTransactionRow(row) : null;
	}

	getChargeRefundState(chargeId: string, workspaceId?: string | null): Promise<ChargeRefundState> {
		return this.getChargeRefundStateOn(this.client, chargeId, workspaceId);
	}

	private async getChargeRefundStateOn(client: PaymentTxSqlClient, chargeId: string, workspaceId?: string | null): Promise<ChargeRefundState> {
		const charge = chargeId.trim();
		const ws = workspaceId?.trim() || null;
		// SUM grouped by kind, returned as ::text so a large total stays precise (no JS
		// number coercion). Refund rows are stored NEGATIVE; we ABS in the rollup below.
		const params: unknown[] = [charge];
		let wsClause = "";
		if (ws) {
			params.push(ws);
			wsClause = ` AND workspace_id = $${params.length}`;
		}
		const rows = await client.unsafe<{ kind: string; currency: string | null; amount: string | number; count: string | number }>(`
			SELECT kind, MAX(currency) AS currency, COALESCE(SUM(amount_cents), 0)::text AS amount, COUNT(*)::bigint AS count
			FROM payment_transactions
			WHERE dodo_payment_id = $1${wsClause}
			GROUP BY kind
		`, params);
		let paid = BigInt(0);
		let refunded = BigInt(0);
		let disputed = BigInt(0);
		let found = false;
		let currency: string | null = null;
		for (const row of rows) {
			const amount = BigInt(String(row.amount ?? "0"));
			const abs = amount < BigInt(0) ? -amount : amount;
			if (row.kind === "payment") {
				if (Number(row.count) > 0) found = true;
				paid += abs;
				if (!currency && row.currency) currency = row.currency;
			} else if (row.kind === "refund") {
				refunded += abs;
			} else if (row.kind === "dispute") {
				disputed += amount;
			}
		}
		const disputedAbs = disputed < BigInt(0) ? -disputed : BigInt(0);
		const remaining = paid - refunded - disputedAbs;
		return {
			found,
			currency,
			originalPaidCents: paid.toString(),
			alreadyRefundedCents: refunded.toString(),
			alreadyDisputedCents: disputedAbs.toString(),
			remainingRefundableCents: (remaining > BigInt(0) ? remaining : BigInt(0)).toString(),
		};
	}

	async listTransactions(options: ListTransactionsOptions = {}): Promise<ListTransactionsResult> {
		const limit = normalizeLimit(options.limit);
		const offset = normalizeOffset(options.offset);
		const { where, params } = this.buildFilter(options);
		const countRows = await this.client.unsafe<{ total: string | number }>(`
			SELECT COUNT(*)::bigint AS total FROM payment_transactions ${where}
		`, params);
		const total = Number(countRows[0]?.total ?? 0);

		const pageParams = [...params, limit, offset];
		const rows = await this.client.unsafe<PaymentTransactionRow>(`
			SELECT id, workspace_id, dodo_payment_id, dodo_invoice_id, dodo_event_ref, dodo_event_id,
				kind, amount_cents, tax_cents, currency, status, plan_id, billing_cycle, occurred_at, raw, created_at
			FROM payment_transactions
			${where}
			ORDER BY occurred_at DESC, created_at DESC, id ASC
			LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
		`, pageParams);
		return { transactions: rows.map(mapTransactionRow), total };
	}

	async listTransactionsKeyset(options: ListTransactionsKeysetOptions = {}): Promise<ListTransactionsKeysetResult> {
		const limit = normalizeLimit(options.limit);
		const { where, params } = this.buildFilter(options);
		const conditions: string[] = [];
		if (where) conditions.push(where.replace(/^WHERE /, ""));
		// Precision: the cursor carries millisecond-ISO strings (what mapTransactionRow
		// emits via toISOString()). occurred_at is ALWAYS written at millisecond
		// precision (upsert binds toIso(...), never the column default), so it compares
		// against the cursor exactly as-is. created_at, however, defaults to now() and
		// can hold microseconds — so it is TRUNCATED TO MILLISECONDS in both the ordering
		// and the cursor comparison, matching the cursor's precision. With `id` (the PK,
		// unique) as the final tiebreaker, a row is never skipped or duplicated at a page
		// boundary due to sub-millisecond rounding. (occurred_at stays raw so the
		// occurred_at index remains usable for the leading sort key.)
		const createdMs = "date_trunc('milliseconds', created_at)";
		// TRUE keyset over the UNIFORM-DESC ordering (occurred_at, created_at, id). A
		// single row-comparison with SCALAR binds — no JS array `= ANY(...)`. Because all
		// three columns sort DESC, `(occurred_at, created_at, id) < (cursor...)` selects
		// exactly the rows that come after the cursor, with id as the unique tiebreaker.
		if (options.cursor) {
			params.push(options.cursor.occurredAt, options.cursor.createdAt, options.cursor.id);
			const o = params.length - 2;
			const cr = params.length - 1;
			const i = params.length;
			conditions.push(`(occurred_at, ${createdMs}, id) < ($${o}::timestamptz, $${cr}::timestamptz, $${i}::text)`);
		}
		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		// Fetch limit + 1 to detect a further page WITHOUT a separate COUNT (offset-free).
		params.push(limit + 1);
		const limitParam = params.length;
		const rows = await this.client.unsafe<PaymentTransactionRow>(`
			SELECT id, workspace_id, dodo_payment_id, dodo_invoice_id, dodo_event_ref, dodo_event_id,
				kind, amount_cents, tax_cents, currency, status, plan_id, billing_cycle, occurred_at, raw, created_at
			FROM payment_transactions
			${whereClause}
			ORDER BY occurred_at DESC, ${createdMs} DESC, id DESC
			LIMIT $${limitParam}
		`, params);
		const mapped = rows.map(mapTransactionRow);
		const page = mapped.slice(0, limit);
		const last = page[page.length - 1];
		const hasMore = mapped.length > limit && Boolean(last);
		return { transactions: page, nextCursor: hasMore && last ? toKeysetCursor(last) : null };
	}

	async countTransactions(options: ListTransactionsOptions = {}): Promise<number> {
		const { where, params } = this.buildFilter(options);
		const rows = await this.client.unsafe<{ total: string | number }>(`
			SELECT COUNT(*)::bigint AS total FROM payment_transactions ${where}
		`, params);
		return Number(rows[0]?.total ?? 0);
	}

	async sumByPlan(options: SumByPlanOptions = {}): Promise<SumByPlanRow[]> {
		// CURRENCY-AWARE: group by (currency, plan, kind) so minor units in different
		// currencies are never summed together. SUM is returned as ::text (not coerced
		// through JS number) so a large total keeps full precision.
		const { where, params } = this.buildFilter(options);
		const rows = await this.client.unsafe<{ plan_id: string | null; kind: string; currency: string | null; amount: string | number; count: string | number }>(`
			SELECT plan_id, kind, currency, COALESCE(SUM(amount_cents), 0)::text AS amount, COUNT(*)::bigint AS count
			FROM payment_transactions
			${where}
			GROUP BY currency, plan_id, kind
			ORDER BY currency NULLS FIRST, plan_id NULLS FIRST, kind
		`, params);
		return rows.map((row) => ({
			planId: row.plan_id ?? null,
			kind: row.kind as PaymentTransactionKind,
			currency: row.currency ?? null,
			amountCents: normalizeCents(String(row.amount ?? "0")),
			count: Number(row.count) || 0,
		}));
	}

	async sumByPeriod(options: SumByPeriodOptions): Promise<SumByPeriodRow[]> {
		// CURRENCY-AWARE: one bucket per (period, currency). SUM returned as ::text.
		const interval = options.interval === "day" ? "day" : "month";
		const { where, params } = this.buildFilter(options);
		const rows = await this.client.unsafe<{ period: Date | string; currency: string | null; amount: string | number; count: string | number }>(`
			SELECT date_trunc('${interval}', occurred_at AT TIME ZONE 'UTC') AS period,
				currency,
				COALESCE(SUM(amount_cents), 0)::text AS amount,
				COUNT(*)::bigint AS count
			FROM payment_transactions
			${where}
			GROUP BY period, currency
			ORDER BY period ASC, currency NULLS FIRST
		`, params);
		return rows.map((row) => ({
			period: row.period instanceof Date ? row.period.toISOString() : new Date(String(row.period)).toISOString(),
			currency: row.currency ?? null,
			amountCents: normalizeCents(String(row.amount ?? "0")),
			count: Number(row.count) || 0,
		}));
	}

	private buildFilter(options: { workspaceId?: string; kind?: PaymentTransactionKind; planId?: string; status?: string; currency?: string; from?: string; to?: string }): { where: string; params: unknown[] } {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (options.workspaceId) {
			params.push(options.workspaceId);
			conditions.push(`workspace_id = $${params.length}`);
		}
		if (options.currency) {
			params.push(options.currency.trim().toUpperCase());
			conditions.push(`currency = $${params.length}`);
		}
		if (options.kind) {
			params.push(options.kind);
			conditions.push(`kind = $${params.length}`);
		}
		if (options.planId) {
			params.push(options.planId);
			conditions.push(`plan_id = $${params.length}`);
		}
		if (options.status) {
			params.push(options.status);
			conditions.push(`status = $${params.length}`);
		}
		if (options.from) {
			params.push(toIso(options.from));
			conditions.push(`occurred_at >= $${params.length}::timestamptz`);
		}
		if (options.to) {
			params.push(toIso(options.to));
			conditions.push(`occurred_at < $${params.length}::timestamptz`);
		}
		return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
	}
}

interface PaymentTransactionRow {
	id: string;
	workspace_id: string | null;
	dodo_payment_id: string | null;
	dodo_invoice_id: string | null;
	dodo_event_ref: string | null;
	dodo_event_id: string | null;
	kind: string;
	amount_cents: string | number;
	tax_cents: string | number | null;
	currency: string | null;
	status: string | null;
	plan_id: string | null;
	billing_cycle: string | null;
	occurred_at: Date | string;
	raw: Record<string, unknown> | string | null;
	created_at: Date | string;
}

function mapTransactionRow(row: PaymentTransactionRow): PaymentTransaction {
	let raw: Record<string, unknown> = {};
	if (typeof row.raw === "string") {
		try {
			raw = JSON.parse(row.raw) as Record<string, unknown>;
		} catch {
			raw = {};
		}
	} else if (row.raw && typeof row.raw === "object") {
		raw = row.raw;
	}
	return {
		id: row.id,
		workspaceId: row.workspace_id ?? null,
		dodoPaymentId: row.dodo_payment_id ?? null,
		dodoInvoiceId: row.dodo_invoice_id ?? null,
		dodoEventRef: row.dodo_event_ref ?? null,
		dodoEventId: row.dodo_event_id ?? null,
		kind: (row.kind === "refund" || row.kind === "dispute" ? row.kind : "payment") as PaymentTransactionKind,
		// Map the bigint column to the public JS-number shape, HARD-REJECTING (throw)
		// any per-row magnitude above Number.MAX_SAFE_INTEGER instead of silently
		// truncating via Number(). A realistic single transaction fits; a corrupt /
		// overflowing row surfaces loudly rather than reporting a wrong cent value.
		amountCents: centsStringToNumber(normalizeCents(String(row.amount_cents ?? "0"))),
		taxCents: row.tax_cents === null || row.tax_cents === undefined ? null : centsStringToNumber(normalizeCents(String(row.tax_cents))),
		currency: row.currency ?? null,
		status: row.status ?? null,
		planId: row.plan_id ?? null,
		billingCycle: row.billing_cycle ?? null,
		occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(String(row.occurred_at)).toISOString(),
		raw,
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString(),
	};
}

function isTransaction(value: unknown): value is PaymentTransaction {
	const tx = value as Partial<PaymentTransaction>;
	return Boolean(
		tx
		&& typeof tx.id === "string"
		&& (tx.kind === "payment" || tx.kind === "refund" || tx.kind === "dispute")
		&& typeof tx.amountCents === "number"
		&& typeof tx.occurredAt === "string",
	);
}

export function createPaymentTransactionsStore(): PaymentTransactionsStore {
	if (serverConfig.billingStore === "postgres") {
		return new PostgresPaymentTransactionsStore();
	}
	return new FilePaymentTransactionsStore(join(DATA_DIR, "payment-transactions.json"));
}

export const paymentTransactionsStore = createPaymentTransactionsStore();
