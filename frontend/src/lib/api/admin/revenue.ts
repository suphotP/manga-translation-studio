// Admin REVENUE api barrel.
//
// Talks to /api/admin/revenue/* via the shared adminFetch client (same Bearer
// header + base URL handling as the rest of the admin surface). Mirrors the
// backend revenue sub-router (backend/src/routes/admin/revenue.ts):
//   GET /summary            MRR/ARR + revenue-by-plan, PER CURRENCY
//   GET /transactions       paginated payment_transactions (cursor + filters)
//   GET /timeseries         revenue per period (day|month) PER CURRENCY (charts)
//   GET /refunds-disputes   refunds + disputes (+ favorable reversals) PER CURRENCY
//   GET /export.csv         accountant export (CSV or ?format=json)
//
// MONEY: every amount on the wire is an integer-cents STRING (never a JS number) —
// a SUM can exceed Number.MAX_SAFE_INTEGER — and figures are PER CURRENCY (never a
// cross-currency total). These types preserve that contract: amounts stay `string`.

import { adminApiBase, adminFetch, getAdminApiToken } from "./client.ts";

export type RevenueTxKind = "payment" | "refund" | "dispute";
export type RevenueInterval = "day" | "month";

// ── /summary ──────────────────────────────────────────────────────
export interface RevenueSummaryCurrencyBlock {
	currency: string;
	/** MRR in minor units (cents) as an integer string. */
	mrrCents: string;
	/** ARR (= MRR * 12) in minor units as an integer string. */
	arrCents: string;
	activeSubscriptions: number;
}

export interface RevenueSummaryPlanRow {
	planId: string;
	planName: string;
	activeSubscriptions: number;
	mrrCents: string;
	arrCents: string;
	currency: string;
}

export interface RevenueSummary {
	/** One block per currency — figures are never summed across currencies. */
	currencies: RevenueSummaryCurrencyBlock[];
	plans: RevenueSummaryPlanRow[];
	activeSubscriptionsTotal: number;
}

// ── /transactions ─────────────────────────────────────────────────
export interface RevenueTransaction {
	id: string;
	/** Minor units (cents) as an integer string; negative for refunds/disputes. */
	amountCents: string;
	currency: string | null;
	kind: RevenueTxKind;
	plan: string | null;
	status: string | null;
	/** When the money movement occurred (ISO 8601). */
	date: string;
	workspaceId: string | null;
}

export interface RevenueTransactionsPage {
	transactions: RevenueTransaction[];
	total: number;
	/** Opaque keyset cursor for the next page, or null when exhausted. */
	nextCursor: string | null;
}

export interface RevenueTransactionsQuery {
	from?: string;
	to?: string;
	currency?: string;
	kind?: RevenueTxKind;
	workspaceId?: string;
	plan?: string;
	limit?: number;
	cursor?: string;
}

// ── /timeseries ───────────────────────────────────────────────────
export interface RevenueTimeseriesPoint {
	/** Bucket start (UTC ISO), truncated to the interval. */
	period: string;
	/** Net minor units in the bucket as an integer string. */
	amountCents: string;
	count: number;
}

export interface RevenueTimeseriesSeries {
	currency: string | null;
	points: RevenueTimeseriesPoint[];
}

export interface RevenueTimeseries {
	interval: RevenueInterval;
	/** One series per currency — buckets are never merged across currencies. */
	series: RevenueTimeseriesSeries[];
}

export interface RevenueTimeseriesQuery {
	interval?: RevenueInterval;
	from?: string;
	to?: string;
	currency?: string;
	kind?: RevenueTxKind;
}

// ── /refunds-disputes ─────────────────────────────────────────────
export interface RevenueRefundsDisputesCurrencyBlock {
	currency: string | null;
	refundCents: string;
	refundCount: number;
	disputeCents: string;
	disputeCount: number;
	/** Net money-out impact for this currency (negative = money out). */
	netImpactCents: string;
}

export interface RevenueRefundsDisputes {
	/** One block per currency — never a cross-currency total. */
	currencies: RevenueRefundsDisputesCurrencyBlock[];
}

export interface RevenueRefundsDisputesQuery {
	from?: string;
	to?: string;
	currency?: string;
}

// ── /export.csv?format=json ───────────────────────────────────────
export interface RevenueExportSubtotal {
	currency: string | null;
	kind: RevenueTxKind;
	amountCents: string;
	/** Exact decimal-major string for the currency's precision (no float). */
	amountDecimal: string;
	count: number;
}

export interface RevenueExportJson {
	transactions: RevenueTransaction[];
	/** Per-currency, per-kind subtotals — never mixed across currencies. */
	subtotals: RevenueExportSubtotal[];
}

export type RevenueExportQuery = Omit<RevenueTransactionsQuery, "limit" | "cursor">;

// Build a `?a=b&c=d` query string from a record, dropping undefined/empty values.
function buildQuery(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") continue;
		search.set(key, String(value));
	}
	const qs = search.toString();
	return qs ? `?${qs}` : "";
}

export const adminRevenueApi = {
	/** MRR/ARR + revenue-by-plan, per currency, from active subscriptions. */
	getSummary(): Promise<RevenueSummary> {
		return adminFetch<RevenueSummary>(`/admin/revenue/summary`);
	},

	/** One paginated page of payment_transactions (cursor + filters). */
	listTransactions(query: RevenueTransactionsQuery = {}): Promise<RevenueTransactionsPage> {
		const qs = buildQuery({
			from: query.from,
			to: query.to,
			currency: query.currency,
			kind: query.kind,
			workspaceId: query.workspaceId,
			plan: query.plan,
			limit: query.limit,
			cursor: query.cursor,
		});
		return adminFetch<RevenueTransactionsPage>(`/admin/revenue/transactions${qs}`);
	},

	/** Revenue per period per currency, for charts. */
	getTimeseries(query: RevenueTimeseriesQuery = {}): Promise<RevenueTimeseries> {
		const qs = buildQuery({
			interval: query.interval,
			from: query.from,
			to: query.to,
			currency: query.currency,
			kind: query.kind,
		});
		return adminFetch<RevenueTimeseries>(`/admin/revenue/timeseries${qs}`);
	},

	/** Refunds + disputes (+ favorable reversals) per currency, with net impact. */
	getRefundsDisputes(query: RevenueRefundsDisputesQuery = {}): Promise<RevenueRefundsDisputes> {
		const qs = buildQuery({ from: query.from, to: query.to, currency: query.currency });
		return adminFetch<RevenueRefundsDisputes>(`/admin/revenue/refunds-disputes${qs}`);
	},

	/** Accountant export as structured JSON (transactions + per-currency subtotals). */
	exportJson(query: RevenueExportQuery = {}): Promise<RevenueExportJson> {
		const qs = buildQuery({
			from: query.from,
			to: query.to,
			currency: query.currency,
			kind: query.kind,
			workspaceId: query.workspaceId,
			plan: query.plan,
			format: "json",
		});
		return adminFetch<RevenueExportJson>(`/admin/revenue/export.csv${qs}`);
	},

	/**
	 * Absolute URL of the CSV export for a date range. NOTE: the admin surface is
	 * Bearer-authenticated (no cookie), so a plain navigation to this URL is NOT
	 * authenticated — prefer {@link fetchExportCsv} for an authorized download. This
	 * is exposed for building a copyable link / opening in a context that carries the
	 * token, and for tests that assert the query shape.
	 */
	exportCsvUrl(query: RevenueExportQuery = {}): string {
		const qs = buildQuery({
			from: query.from,
			to: query.to,
			currency: query.currency,
			kind: query.kind,
			workspaceId: query.workspaceId,
			plan: query.plan,
		});
		return `${adminApiBase()}/admin/revenue/export.csv${qs}`;
	},

	/**
	 * Authenticated CSV download: fetches export.csv with the Bearer token and
	 * returns the body as a Blob (a download button revokes the object URL after
	 * triggering the save). Throws AdminApiError on a non-2xx (e.g. 403 for a role
	 * without REVENUE_EXPORT).
	 */
	async fetchExportCsv(query: RevenueExportQuery = {}): Promise<Blob> {
		const url = this.exportCsvUrl(query);
		const headers = new Headers();
		const token = getAdminApiToken();
		if (token) headers.set("Authorization", `Bearer ${token}`);
		const res = await fetch(url, { headers });
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`Revenue CSV export failed (${res.status})${detail ? `: ${detail}` : ""}`);
		}
		return res.blob();
	},
};
