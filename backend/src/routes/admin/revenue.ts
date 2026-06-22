// Back-office REVENUE sub-router (ranks 5-7: revenue reports for owner/accountant).
//
// Mounted at /api/admin/revenue by backend/src/routes/admin.ts. The parent admin
// router already applies authMiddleware + requirePermission(ACCESS) on every path,
// so requests that reach here are authenticated platform admins. This sub-router
// layers the domain's READ gate on top, and the CSV export additionally requires
// REVENUE_EXPORT (a stricter accountant-export gate) on top of READ.
//
// MONEY RULES (the whole point of this surface):
//   * Amounts are MINOR UNITS (cents) carried as integer STRINGS / BigInt end-to-end.
//     A SUM over many rows can exceed Number.MAX_SAFE_INTEGER, so we NEVER coerce a
//     total through Number(). The payment-transactions store already returns
//     precision-safe `amountCents` strings from sumByPlan / sumByPeriod; we only ever
//     add them with BigInt.
//   * Figures are PER-CURRENCY only. You cannot add 100 JPY minor units to 100 USD
//     cents, so every aggregate is grouped by currency and emitted as one block per
//     currency — a sum is never taken across currencies, including in CSV total rows.
//
// Endpoints (all gated, all per-currency):
//   GET /summary            MRR/ARR + revenue-by-plan from active subscriptions
//   GET /transactions       paginated payment_transactions (keyset cursor + filters)
//   GET /timeseries         revenue per period (day|month) per currency (charts)
//   GET /refunds-disputes   refunds + disputes (+ favorable reversals) per currency
//   GET /export.csv         accountant export (CSV or ?format=json), per-currency subtotals

import { Hono } from "hono";
import { z } from "zod/v4";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { ADMIN_PERMISSIONS } from "../../types/auth.js";
import type { AdminRouterDeps } from "../admin.js";
import {
	billingStore as defaultBillingStore,
	ACTIVE_BILLING_STATUSES,
	type BillingStore,
} from "../../services/billing-store.js";
import {
	paymentTransactionsStore as defaultPaymentTransactionsStore,
	PAYMENT_TX_DEFAULT_LIMIT,
	PAYMENT_TX_MAX_LIMIT,
	type PaymentTransaction,
	type PaymentTransactionKind,
	type PaymentTransactionsStore,
	type TransactionsKeysetCursor,
} from "../../services/payment-transactions-store.js";
import { WORKSPACE_PLANS, type WorkspacePlanId } from "../../services/plans.js";
import { getResponseCache, type ResponseCache } from "../../services/response-cache.js";

// Short TTL for the global revenue aggregates (/summary, /timeseries). These
// re-scan billing/payment data on every dashboard load but are identical for
// every admin and tolerate a few seconds of staleness. Override with
// REVENUE_CACHE_TTL_SECONDS=0 to disable. Capped so a typo can't pin stale data.
const REVENUE_CACHE_TTL_SECONDS = (() => {
	const raw = Number(process.env.REVENUE_CACHE_TTL_SECONDS);
	if (!Number.isFinite(raw) || raw < 0) return 30;
	return Math.min(raw, 300);
})();

// USD is the catalog billing currency (plans.ts priceUsdMonthly), so MRR/ARR derived
// from plan list prices is reported under this currency block.
const PLAN_PRICE_CURRENCY = "USD";

const txKindSchema = z.enum(["payment", "refund", "dispute"]);

// Shared filter schema for the transactions list + CSV export. Dates are ISO 8601
// (the store treats `from` inclusive, `to` exclusive). Currency is upper-cased ISO.
const dateRangeSchema = z.object({
	from: z.string().trim().min(1).max(64).optional(),
	to: z.string().trim().min(1).max(64).optional(),
	currency: z.string().trim().min(1).max(8).optional(),
	kind: txKindSchema.optional(),
	workspaceId: z.string().trim().min(1).max(120).optional(),
	plan: z.string().trim().min(1).max(120).optional(),
});

const transactionsQuerySchema = dateRangeSchema.extend({
	limit: z.number().int().min(1).max(PAYMENT_TX_MAX_LIMIT).optional(),
	cursor: z.string().trim().max(512).optional(),
});

const timeseriesQuerySchema = z.object({
	interval: z.enum(["day", "month"]).optional(),
	from: z.string().trim().min(1).max(64).optional(),
	to: z.string().trim().min(1).max(64).optional(),
	currency: z.string().trim().min(1).max(8).optional(),
	kind: txKindSchema.optional(),
});

const refundsDisputesQuerySchema = z.object({
	from: z.string().trim().min(1).max(64).optional(),
	to: z.string().trim().min(1).max(64).optional(),
	currency: z.string().trim().min(1).max(8).optional(),
});

const exportQuerySchema = dateRangeSchema.extend({
	format: z.enum(["csv", "json"]).optional(),
});

// ── Keyset cursor for the transactions list + export ──────────────
// A TRUE keyset cursor over the store's stable, UNIQUE ordering
// `(occurred_at DESC, created_at DESC, id DESC)` — NOT an offset. We encode the last
// row's (occurredAt, createdAt, id) so the next page resumes strictly after it.
// Because the tuple includes the unique id tiebreaker, paging visits every matching
// row exactly once even when rows are inserted/deleted mid-pagination (an OFFSET
// cursor would skip or double-count those rows). The /transactions endpoint and the
// CSV/JSON export share this exact cursor + ordering so they can never disagree.
function encodeTxCursor(cursor: TransactionsKeysetCursor): string {
	return Buffer.from(JSON.stringify([cursor.occurredAt, cursor.createdAt, cursor.id]), "utf8").toString("base64url");
}

function decodeTxCursor(cursor: string | undefined): TransactionsKeysetCursor | null {
	if (!cursor?.trim()) return null;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== 3) return null;
		const [occurredAt, createdAt, id] = parsed;
		if (typeof occurredAt !== "string" || !occurredAt) return null;
		if (typeof createdAt !== "string" || !createdAt) return null;
		if (typeof id !== "string" || !id) return null;
		return { occurredAt, createdAt, id };
	} catch {
		return null;
	}
}

// ── Money helpers (BigInt, never Number on a sum) ─────────────────
/** Net an array of integer-cents strings into one exact integer string. */
function netCentsStrings(values: string[]): string {
	let total = BigInt(0);
	for (const value of values) {
		if (!value) continue;
		total += BigInt(value);
	}
	return total.toString();
}

/** Convert an integer-cents string to an exact decimal-major string for the given
 * currency's minor-unit count, WITHOUT any float math. "1999" + 2 → "19.99";
 * "-1900" + 0 (JPY) → "-1900". Pure string/BigInt arithmetic so a huge value stays
 * exact and no currency is ever assumed 2-decimal. */
function centsToDecimalString(cents: string, minorDigits: number): string {
	const negative = cents.startsWith("-");
	const digits = (negative ? cents.slice(1) : cents).replace(/^0+(?=\d)/, "");
	if (minorDigits <= 0) return (negative ? "-" : "") + (digits || "0");
	const padded = digits.padStart(minorDigits + 1, "0");
	const intPart = padded.slice(0, padded.length - minorDigits);
	const fracPart = padded.slice(padded.length - minorDigits);
	return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

// ── CSV rendering (RFC-4180 escaping) ─────────────────────────────
/** Escape a CSV field: always quote, double embedded quotes. Guards against
 * spreadsheet formula injection by prefixing a leading =,+,-,@ with a single quote. */
function csvField(value: string | number | null | undefined): string {
	let text = value === null || value === undefined ? "" : String(value);
	if (/^[=+\-@]/.test(text)) text = `'${text}`;
	return `"${text.replace(/"/g, '""')}"`;
}

function csvRow(fields: Array<string | number | null | undefined>): string {
	return fields.map(csvField).join(",");
}

/**
 * Optional store overrides for tests. The payment-transactions store is a module
 * singleton (like the other revenue stores) and intentionally NOT part of the shared
 * AdminRouterDeps, so admin.ts stays untouched; tests pass it via this second
 * argument. Production calls `createAdminRevenueRouter(deps)` and gets the singleton.
 */
export interface AdminRevenueRouterStores {
	transactions?: PaymentTransactionsStore;
	billing?: BillingStore;
	/** Injectable for tests; defaults to the shared process cache (Redis or no-op). */
	cache?: ResponseCache;
}

export function createAdminRevenueRouter(deps: AdminRouterDeps = {}, stores: AdminRevenueRouterStores = {}): Hono {
	const router = new Hono();
	const billing: BillingStore = stores.billing ?? deps.billing ?? defaultBillingStore;
	const transactions: PaymentTransactionsStore = stores.transactions ?? defaultPaymentTransactionsStore;
	const cache: ResponseCache = stores.cache ?? getResponseCache();

	// Baseline READ gate for the whole revenue surface.
	router.use("*", requirePermission(ADMIN_PERMISSIONS.REVENUE_READ));

	// ── GET /summary — MRR/ARR + revenue-by-plan, per currency ────
	// MRR is derived from ACTIVE subscriptions (billing-store assignments in an
	// in-effect status) priced from the plan catalog. The catalog prices plans in
	// USD, so MRR/ARR live under the USD currency block. Active sub counts by plan
	// are reported alongside. (Cash actually collected, which can be multi-currency,
	// is reported by /timeseries + /transactions from payment_transactions.)
	router.get("/summary", async (c) => {
		// Global aggregate (no per-caller variation) → cacheable under a static key.
		const body = await cache.getOrSet("revenue:summary:v1", REVENUE_CACHE_TTL_SECONDS, async () => {
			const assignments = await billing.listAssignments();
			const active = assignments.filter((a) => (ACTIVE_BILLING_STATUSES as readonly string[]).includes(a.status));

			// Per-plan active counts + per-plan MRR (cents) accumulated with BigInt.
			const byPlan = new Map<WorkspacePlanId, { count: number; mrrCents: bigint }>();
			for (const assignment of active) {
				const plan = WORKSPACE_PLANS[assignment.planId];
				if (!plan) continue;
				const row = byPlan.get(assignment.planId) ?? { count: 0, mrrCents: BigInt(0) };
				row.count += 1;
				// priceUsdMonthly is whole dollars in the catalog → exact cents via integer math.
				row.mrrCents += BigInt(Math.round(plan.priceUsdMonthly)) * BigInt(100);
				byPlan.set(assignment.planId, row);
			}

			let totalMrrCents = BigInt(0);
			const plans = [...byPlan.entries()]
				.map(([planId, row]) => {
					totalMrrCents += row.mrrCents;
					const plan = WORKSPACE_PLANS[planId];
					return {
						planId,
						planName: plan?.name ?? planId,
						activeSubscriptions: row.count,
						// BigInt → string here so the cached JSON round-trips losslessly
						// (JSON.stringify cannot serialize BigInt).
						mrrCents: row.mrrCents.toString(),
						arrCents: (row.mrrCents * BigInt(12)).toString(),
						currency: PLAN_PRICE_CURRENCY,
					};
				})
				.sort((a, b) => a.planId.localeCompare(b.planId));

			// Active subs that map to a known catalog plan (the ones that contribute MRR).
			const activeKnown = active.filter((a) => WORKSPACE_PLANS[a.planId]).length;

			return {
				// One block per currency. Plan prices are USD-only, so there is a single
				// USD block today; the shape is per-currency so multi-currency catalog
				// pricing can extend it without changing the API contract.
				currencies: [
					{
						currency: PLAN_PRICE_CURRENCY,
						mrrCents: totalMrrCents.toString(),
						arrCents: (totalMrrCents * BigInt(12)).toString(),
						activeSubscriptions: activeKnown,
					},
				],
				plans,
				activeSubscriptionsTotal: active.length,
			};
		});
		return c.json(body);
	});

	// ── GET /transactions — paginated payment_transactions ────────
	router.get("/transactions", async (c) => {
		const parsed = transactionsQuerySchema.safeParse({
			from: c.req.query("from"),
			to: c.req.query("to"),
			currency: c.req.query("currency"),
			kind: c.req.query("kind"),
			workspaceId: c.req.query("workspaceId"),
			plan: c.req.query("plan"),
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
			cursor: c.req.query("cursor"),
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		const cursor = decodeTxCursor(parsed.data.cursor);
		const limit = parsed.data.limit ?? PAYMENT_TX_DEFAULT_LIMIT;
		const filter = {
			from: parsed.data.from,
			to: parsed.data.to,
			currency: parsed.data.currency,
			kind: parsed.data.kind,
			workspaceId: parsed.data.workspaceId,
			planId: parsed.data.plan,
		};
		// TRUE keyset paging (no offset) so a row inserted/deleted between page fetches
		// can never be skipped or double-counted. `total` is the size of the matching set
		// (a cheap COUNT) — it is informational; the cursor, not the total, drives paging.
		const [result, total] = await Promise.all([
			transactions.listTransactionsKeyset({ ...filter, limit, cursor }),
			transactions.countTransactions(filter),
		]);

		return c.json({
			transactions: result.transactions.map(serializeTransaction),
			total,
			nextCursor: result.nextCursor ? encodeTxCursor(result.nextCursor) : null,
		});
	});

	// ── GET /timeseries — revenue per period per currency ─────────
	router.get("/timeseries", async (c) => {
		const parsed = timeseriesQuerySchema.safeParse({
			interval: c.req.query("interval"),
			from: c.req.query("from"),
			to: c.req.query("to"),
			currency: c.req.query("currency"),
			kind: c.req.query("kind"),
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		const interval = parsed.data.interval ?? "month";
		// Global aggregate keyed by every input that changes the result. JSON-encode
		// the normalized params so no value can collide with the key delimiter.
		const cacheKey = "revenue:timeseries:v1:" + JSON.stringify([
			interval,
			parsed.data.from ?? null,
			parsed.data.to ?? null,
			parsed.data.currency ?? null,
			parsed.data.kind ?? null,
		]);
		const body = await cache.getOrSet(cacheKey, REVENUE_CACHE_TTL_SECONDS, async () => {
			const rows = await transactions.sumByPeriod({
				interval,
				from: parsed.data.from,
				to: parsed.data.to,
				currency: parsed.data.currency,
				kind: parsed.data.kind,
			});
			// Group into one series per currency for charting — never merge currencies.
			const byCurrency = new Map<string, { period: string; amountCents: string; count: number }[]>();
			for (const row of rows) {
				const key = row.currency ?? "";
				const list = byCurrency.get(key) ?? [];
				list.push({ period: row.period, amountCents: row.amountCents, count: row.count });
				byCurrency.set(key, list);
			}
			const series = [...byCurrency.entries()]
				.map(([currency, points]) => ({ currency: currency || null, points }))
				.sort((a, b) => (a.currency ?? "").localeCompare(b.currency ?? ""));

			return { interval, series };
		});
		return c.json(body);
	});

	// ── GET /refunds-disputes — refunds + disputes per currency ───
	// Reports refund + dispute rows (negative) and favorable reversal rows (positive
	// `dispute` rows keyed `{disputeId}:reversal`). Net impact per currency is the
	// BigInt sum of every refund + dispute row (reversals net back automatically).
	router.get("/refunds-disputes", async (c) => {
		const parsed = refundsDisputesQuerySchema.safeParse({
			from: c.req.query("from"),
			to: c.req.query("to"),
			currency: c.req.query("currency"),
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		// sumByPlan groups by (currency, plan, kind); we re-aggregate the refund +
		// dispute kinds per (currency, kind) so plan does not fragment the view.
		const rows = await transactions.sumByPlan({ from: parsed.data.from, to: parsed.data.to, currency: parsed.data.currency });

		const byCurrency = new Map<string, { refundCents: bigint; refundCount: number; disputeCents: bigint; disputeCount: number }>();
		for (const row of rows) {
			if (row.kind !== "refund" && row.kind !== "dispute") continue;
			const key = row.currency ?? "";
			const bucket = byCurrency.get(key) ?? { refundCents: BigInt(0), refundCount: 0, disputeCents: BigInt(0), disputeCount: 0 };
			if (row.kind === "refund") {
				bucket.refundCents += BigInt(row.amountCents);
				bucket.refundCount += row.count;
			} else {
				// dispute kind also carries the positive favorable-reversal rows; netting
				// them here yields the true dispute impact for the currency.
				bucket.disputeCents += BigInt(row.amountCents);
				bucket.disputeCount += row.count;
			}
			byCurrency.set(key, bucket);
		}

		const currencies = [...byCurrency.entries()]
			.map(([currency, bucket]) => ({
				currency: currency || null,
				refundCents: bucket.refundCents.toString(),
				refundCount: bucket.refundCount,
				disputeCents: bucket.disputeCents.toString(),
				disputeCount: bucket.disputeCount,
				// Net impact (negative = money out) for this currency, never cross-currency.
				netImpactCents: (bucket.refundCents + bucket.disputeCents).toString(),
			}))
			.sort((a, b) => (a.currency ?? "").localeCompare(b.currency ?? ""));

		return c.json({ currencies });
	});

	// ── GET /export.csv — accountant export (CSV or ?format=json) ─
	// Additionally gated on REVENUE_EXPORT (a stricter accountant-export key) on top
	// of the READ gate above. The export streams the transaction set in bounded pages
	// so a large date range never materializes the whole table in memory at once.
	router.get("/export.csv", requirePermission(ADMIN_PERMISSIONS.REVENUE_EXPORT), async (c) => {
		const parsed = exportQuerySchema.safeParse({
			from: c.req.query("from"),
			to: c.req.query("to"),
			currency: c.req.query("currency"),
			kind: c.req.query("kind"),
			workspaceId: c.req.query("workspaceId"),
			plan: c.req.query("plan"),
			format: c.req.query("format"),
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		const baseFilter: ExportFilter = {
			from: parsed.data.from,
			to: parsed.data.to,
			currency: parsed.data.currency,
			kind: parsed.data.kind,
			workspaceId: parsed.data.workspaceId,
			planId: parsed.data.plan,
		};

		// JSON variant: per-currency subtotals + the transaction list, STREAMED via the
		// same bounded keyset pager so memory stays bounded to ~one page (the whole
		// result set is never accumulated). Emits one JSON document
		// {"transactions":[...],"subtotals":[...]} — the transactions array is written
		// page-by-page, subtotals (a tiny per-currency map) are appended at the end.
		if (parsed.data.format === "json") {
			const stream = buildJsonStream(transactions, baseFilter);
			return new Response(stream, {
				status: 200,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
				},
			});
		}

		// CSV variant: stream the bounded pages into a ReadableStream so a large range
		// never buffers the whole result set. Per-currency subtotal rows are appended
		// at the end — a total row NEVER mixes currencies.
		const filename = `revenue-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
		const stream = buildCsvStream(transactions, baseFilter);
		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename="${filename}"`,
				"Cache-Control": "no-store",
			},
		});
	});

	// Retain the de-conflict scaffold placeholder so the shared admin-subrouters
	// gating test (which probes /_placeholder for 200/403) keeps passing.
	router.get("/_placeholder", (c) => c.json({ scaffold: "revenue" }));

	return router;
}

// ── Serialization ─────────────────────────────────────────────────
interface SerializedTransaction {
	id: string;
	amountCents: string;
	currency: string | null;
	kind: PaymentTransactionKind;
	plan: string | null;
	status: string | null;
	date: string;
	workspaceId: string | null;
}

function serializeTransaction(tx: PaymentTransaction): SerializedTransaction {
	return {
		id: tx.id,
		// amount as a STRING cents value (never a JS number on the wire).
		amountCents: String(tx.amountCents),
		currency: tx.currency,
		kind: tx.kind,
		plan: tx.planId,
		status: tx.status,
		date: tx.occurredAt,
		workspaceId: tx.workspaceId,
	};
}

// ── Export collection (bounded paging, per-currency subtotals) ────
interface ExportFilter {
	from?: string;
	to?: string;
	currency?: string;
	kind?: PaymentTransactionKind;
	workspaceId?: string;
	planId?: string;
}

interface ExportSubtotal {
	currency: string;
	kind: PaymentTransactionKind;
	amountCents: string;
	minorDigits: number;
	count: number;
}

const EXPORT_PAGE_SIZE = PAYMENT_TX_MAX_LIMIT;

// Minimal ISO-4217 minor-unit lookup mirrored from utils/money.ts so the CSV decimal
// rendering respects JPY (0) / KWD (3) without summing or float math.
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
function minorDigitsFor(currency: string | null): number {
	if (!currency) return 2;
	const code = currency.trim().toUpperCase();
	if (ZERO_DECIMAL.has(code)) return 0;
	if (THREE_DECIMAL.has(code)) return 3;
	return 2;
}

interface ExportSubtotalBucket {
	currency: string;
	kind: PaymentTransactionKind;
	amount: bigint;
	count: number;
}

/** Accumulate a single page's rows into the per-(currency,kind) subtotal map. */
function accumulateSubtotals(subtotals: Map<string, ExportSubtotalBucket>, tx: PaymentTransaction): void {
	// Subtotal key NEVER crosses currencies — one bucket per (currency, kind).
	const currency = tx.currency ?? "";
	const key = `${currency} ${tx.kind}`;
	const bucket = subtotals.get(key) ?? { currency, kind: tx.kind, amount: BigInt(0), count: 0 };
	bucket.amount += BigInt(tx.amountCents);
	bucket.count += 1;
	subtotals.set(key, bucket);
}

/**
 * A bounded export pager over the SAME stable keyset cursor as the /transactions
 * endpoint. Each `next()` call fetches exactly ONE page (<= EXPORT_PAGE_SIZE rows)
 * from the store; the caller drives it, so at most one page of rows is ever held in
 * memory. The subtotal map (one tiny bucket per currency,kind) is the only growing
 * state, and it is bounded by the number of distinct currencies, not the row count.
 * Keyset (not offset) means a row inserted/deleted between pages can't be skipped or
 * double-counted, so the export agrees with /transactions row-for-row.
 */
class ExportPager {
	private cursor: TransactionsKeysetCursor | null = null;
	private done = false;
	readonly subtotals = new Map<string, ExportSubtotalBucket>();

	constructor(private readonly store: PaymentTransactionsStore, private readonly filter: ExportFilter) {}

	/** Fetch the next bounded page; returns [] once exhausted. Accumulates subtotals. */
	async next(): Promise<PaymentTransaction[]> {
		if (this.done) return [];
		const { transactions: page, nextCursor } = await this.store.listTransactionsKeyset({
			...this.filter,
			limit: EXPORT_PAGE_SIZE,
			cursor: this.cursor,
		});
		for (const tx of page) accumulateSubtotals(this.subtotals, tx);
		this.cursor = nextCursor;
		// Exhausted when the store reports no further page (nextCursor null). An empty
		// page also terminates (defensive: a concurrent delete could empty a tail page).
		if (!nextCursor || page.length === 0) this.done = true;
		return page;
	}

	isDone(): boolean {
		return this.done;
	}
}

function subtotalsToRows(subtotals: Map<string, ExportSubtotalBucket>): ExportSubtotal[] {
	return [...subtotals.values()]
		.map((bucket) => ({
			currency: bucket.currency,
			kind: bucket.kind,
			amountCents: bucket.amount.toString(),
			minorDigits: minorDigitsFor(bucket.currency || null),
			count: bucket.count,
		}))
		.sort((a, b) => a.currency.localeCompare(b.currency) || a.kind.localeCompare(b.kind));
}

/** Serialize one export subtotal for the JSON variant (with exact decimal). */
function serializeSubtotal(s: ExportSubtotal): Record<string, unknown> {
	return {
		currency: s.currency || null,
		kind: s.kind,
		amountCents: s.amountCents,
		amountDecimal: centsToDecimalString(s.amountCents, s.minorDigits),
		count: s.count,
	};
}

/** Build a PULL-based streaming JSON body for the export's `?format=json` variant.
 * Emits a single document {"transactions":[ ... ],"subtotals":[ ... ]}; the
 * transactions array is written one bounded keyset page per `pull()` (so memory stays
 * bounded to ~one page — the whole set is NEVER materialized), and the small per-
 * currency subtotal map is appended after the array closes. */
function buildJsonStream(store: PaymentTransactionsStore, filter: ExportFilter): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const pager = new ExportPager(store, filter);
	let openWritten = false;
	let wroteAnyRow = false;
	let closeWritten = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (!openWritten) {
					controller.enqueue(encoder.encode('{"transactions":['));
					openWritten = true;
				}
				// One bounded page of transaction rows per pull; the runtime applies
				// backpressure between pulls so only ~one page is ever in memory.
				if (!pager.isDone()) {
					const page = await pager.next();
					if (page.length > 0) {
						let chunk = "";
						for (const tx of page) {
							chunk += (wroteAnyRow ? "," : "") + JSON.stringify(serializeTransaction(tx));
							wroteAnyRow = true;
						}
						controller.enqueue(encoder.encode(chunk));
						return;
					}
				}
				// All rows emitted: close the array and append the bounded subtotals.
				if (!closeWritten) {
					closeWritten = true;
					const subtotals = subtotalsToRows(pager.subtotals).map(serializeSubtotal);
					controller.enqueue(encoder.encode(`],"subtotals":${JSON.stringify(subtotals)}}`));
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
}

const CSV_HEADER = ["id", "date", "kind", "amount_cents", "amount_decimal", "currency", "plan", "status", "workspace_id"];

function csvDataRow(tx: PaymentTransaction): string {
	const minorDigits = minorDigitsFor(tx.currency);
	return csvRow([
		tx.id,
		tx.occurredAt,
		tx.kind,
		String(tx.amountCents),
		centsToDecimalString(String(tx.amountCents), minorDigits),
		tx.currency ?? "",
		tx.planId ?? "",
		tx.status ?? "",
		tx.workspaceId ?? "",
	]);
}

/** Build a PULL-based streaming CSV body. The next bounded keyset page is fetched
 * INSIDE `pull()` — one page per pull — so the runtime's backpressure (it stops
 * pulling once `desiredSize <= 0`) keeps memory bounded to ~one page. Nothing is
 * pre-materialized in `start()`; the whole result set is never held at once. Per-
 * currency subtotal rows are emitted after the data (a subtotal row NEVER mixes
 * currencies). A store/page error surfaces as a stream error. */
function buildCsvStream(store: PaymentTransactionsStore, filter: ExportFilter): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const pager = new ExportPager(store, filter);
	let headerWritten = false;
	let footerWritten = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (!headerWritten) {
					controller.enqueue(encoder.encode(csvRow(CSV_HEADER) + "\n"));
					headerWritten = true;
				}
				// Pull exactly ONE bounded page of data rows per invocation. The runtime
				// re-invokes pull() only when it wants more, so at most one page of rows is
				// buffered in memory regardless of the total range size.
				if (!pager.isDone()) {
					const page = await pager.next();
					if (page.length > 0) {
						let chunk = "";
						for (const tx of page) chunk += csvDataRow(tx) + "\n";
						controller.enqueue(encoder.encode(chunk));
						return;
					}
					// Empty page (set exhausted) falls through to the footer below.
				}
				// All data rows emitted: append the per-currency subtotal rows once, then
				// close. Subtotals are bounded (one row per currency,kind), not by row count.
				if (!footerWritten) {
					footerWritten = true;
					const subtotalRows = subtotalsToRows(pager.subtotals);
					if (subtotalRows.length > 0) {
						let footer = "\n";
						footer += csvRow(["# subtotals (per currency, never mixed)"]) + "\n";
						footer += csvRow(["currency", "kind", "amount_cents", "amount_decimal", "count"]) + "\n";
						for (const s of subtotalRows) {
							footer += csvRow([s.currency, s.kind, s.amountCents, centsToDecimalString(s.amountCents, s.minorDigits), s.count]) + "\n";
						}
						controller.enqueue(encoder.encode(footer));
					}
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
}

// Re-export internal helpers for unit testing (not part of the public router API).
export const __test = {
	centsToDecimalString,
	csvField,
	csvRow,
	netCentsStrings,
	encodeTxCursor,
	decodeTxCursor,
	minorDigitsFor,
	subtotalsToRows,
	buildCsvStream,
	buildJsonStream,
};
