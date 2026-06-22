// Back-office REVENUE reports API tests (backend/src/routes/admin/revenue.ts).
//
// Proves the money + gating invariants of the revenue surface in file mode (no DB):
//   * per-currency summary/timeseries/refunds NEVER mix USD with JPY,
//   * MRR/ARR derive from active subscriptions and are integer-cents strings,
//   * the transactions list paginates stably via the opaque cursor,
//   * CSV export escapes correctly, emits exact decimals (JPY 0-decimal, USD 2),
//     and per-currency subtotal rows (never a cross-currency total),
//   * every endpoint is 403 for a role lacking REVENUE_READ and 200 for accountant,
//   * export.csv additionally requires REVENUE_EXPORT.
//
// The real-Postgres SQL path is covered by payment-transactions-postgres.test.ts;
// here the in-memory FileBillingStore + FilePaymentTransactionsStore back the router
// so the report logic (grouping, BigInt netting, CSV) is exercised without a DB.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
	createAdminRevenueRouter,
	__test,
	type AdminRevenueRouterStores,
} from "../routes/admin/revenue.js";
import { FileBillingStore } from "../services/billing-store.js";
import { FilePaymentTransactionsStore } from "../services/payment-transactions-store.js";
import { MemoryResponseCache } from "../services/response-cache.js";
import type { UserRole } from "../types/auth.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "rev-test-"));

function stubAuth(role: UserRole) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId: `stub-${role}`, email: `${role}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
}

// Build a standalone app mounting ONLY the revenue sub-router, with the given role
// and seeded stores. Mirrors the real parent mount (authMiddleware then the router's
// own REVENUE_READ gate) so the gating path is identical to production.
function revenueAppAs(role: UserRole, stores: AdminRevenueRouterStores): Hono {
	const app = new Hono();
	app.use("*", stubAuth(role));
	app.route("/", createAdminRevenueRouter({}, stores));
	return app;
}

function makeStores(tag: string): { stores: AdminRevenueRouterStores; billing: FileBillingStore; transactions: FilePaymentTransactionsStore } {
	const billing = new FileBillingStore(join(tmpRoot, `${tag}-billing.json`));
	const transactions = new FilePaymentTransactionsStore(join(tmpRoot, `${tag}-tx.json`));
	return { stores: { billing, transactions }, billing, transactions };
}

afterAll(() => {
	// tmp dir is left for inspection by the harness; it lives under the OS tmpdir.
});

describe("admin revenue: gating", () => {
	const { stores } = makeStores("gate");
	const paths = ["/summary", "/transactions", "/timeseries", "/refunds-disputes"];

	for (const path of paths) {
		test(`support (no REVENUE_READ) is 403 on ${path}`, async () => {
			const res = await revenueAppAs("support", stores).request(path);
			expect(res.status).toBe(403);
		});
		test(`accountant is 200 on ${path}`, async () => {
			const res = await revenueAppAs("accountant", stores).request(path);
			expect(res.status).toBe(200);
		});
		test(`owner is 200 on ${path}`, async () => {
			const res = await revenueAppAs("owner", stores).request(path);
			expect(res.status).toBe(200);
		});
	}

	test("editor (no admin) is 403 on /summary", async () => {
		const res = await revenueAppAs("editor", stores).request("/summary");
		expect(res.status).toBe(403);
	});

	test("export.csv: accountant (has REVENUE_EXPORT) is 200", async () => {
		const res = await revenueAppAs("accountant", stores).request("/export.csv");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/csv");
	});

	test("export.csv: support (no REVENUE_EXPORT) is 403", async () => {
		const res = await revenueAppAs("support", stores).request("/export.csv");
		expect(res.status).toBe(403);
	});
});

describe("admin revenue: /summary (per-currency MRR/ARR from active subs)", () => {
	test("MRR/ARR + per-plan active counts as integer-cents strings", async () => {
		const { stores, billing } = makeStores("summary");
		// 2 pro ($19) + 1 creator ($8) active; 1 free ($0); 1 cancelled pro (excluded).
		await billing.setWorkspacePlan({ workspaceId: "ws-pro-1", planId: "pro", status: "active" });
		await billing.setWorkspacePlan({ workspaceId: "ws-pro-2", planId: "pro", status: "active" });
		await billing.setWorkspacePlan({ workspaceId: "ws-creator", planId: "creator", status: "trialing" });
		await billing.setWorkspacePlan({ workspaceId: "ws-free", planId: "free", status: "active" });
		await billing.setWorkspacePlan({ workspaceId: "ws-cancel", planId: "pro", status: "cancelled" });

		const res = await revenueAppAs("accountant", stores).request("/summary");
		expect(res.status).toBe(200);
		const body = await res.json();

		// Single USD currency block (catalog prices are USD).
		expect(body.currencies).toHaveLength(1);
		const usd = body.currencies[0];
		expect(usd.currency).toBe("USD");
		// MRR = 2*2500 + 1*900 + 1*0 = 5900 cents; ARR = 70800. (2026-06-12 prices:
		// pro $25, creator $9.)
		expect(usd.mrrCents).toBe("5900");
		expect(usd.arrCents).toBe("70800");
		expect(typeof usd.mrrCents).toBe("string");
		// 4 active known-plan subs (free counts as a sub even at $0); cancelled excluded.
		expect(usd.activeSubscriptions).toBe(4);
		expect(body.activeSubscriptionsTotal).toBe(4);

		const pro = body.plans.find((p: { planId: string }) => p.planId === "pro");
		expect(pro.activeSubscriptions).toBe(2);
		expect(pro.mrrCents).toBe("5000");
		expect(pro.arrCents).toBe("60000");
		expect(pro.currency).toBe("USD");
	});
});

describe("admin revenue: /transactions (filters + stable cursor pagination)", () => {
	async function seed(transactions: FilePaymentTransactionsStore): Promise<void> {
		// 5 USD payments + 2 JPY payments, distinct occurredAt so order is deterministic.
		for (let i = 0; i < 5; i++) {
			await transactions.upsertTransaction({
				kind: "payment",
				dodoEventRef: `usd_${i}`,
				amountCents: 1000 + i,
				currency: "USD",
				planId: "pro",
				occurredAt: `2026-05-1${i}T00:00:00.000Z`,
			});
		}
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "jpy_0", amountCents: 500, currency: "JPY", occurredAt: "2026-05-20T00:00:00.000Z" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "jpy_1", amountCents: 700, currency: "JPY", occurredAt: "2026-05-21T00:00:00.000Z" });
	}

	test("amount is a string; currency filter scopes the result", async () => {
		const { stores, transactions } = makeStores("tx-filter");
		await seed(transactions);
		const res = await revenueAppAs("accountant", stores).request("/transactions?currency=USD");
		const body = await res.json();
		expect(body.total).toBe(5);
		expect(body.transactions.every((t: { currency: string }) => t.currency === "USD")).toBe(true);
		expect(typeof body.transactions[0].amountCents).toBe("string");
		expect(body.transactions[0]).toHaveProperty("date");
		expect(body.transactions[0]).toHaveProperty("workspaceId");
	});

	test("cursor pages through every row exactly once (stable)", async () => {
		const { stores, transactions } = makeStores("tx-page");
		await seed(transactions);
		const app = revenueAppAs("accountant", stores);
		const seen: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		do {
			const url: string = cursor ? `/transactions?limit=3&cursor=${encodeURIComponent(cursor)}` : "/transactions?limit=3";
			const body = await (await app.request(url)).json();
			for (const t of body.transactions) seen.push(t.id);
			cursor = body.nextCursor;
			expect(++guard).toBeLessThan(20);
		} while (cursor);
		// 7 rows total, each id seen exactly once.
		expect(seen.length).toBe(7);
		expect(new Set(seen).size).toBe(7);
	});

	// ── P1 BUG 1: TRUE keyset survives mutation between page fetches ──────────────
	test("keyset: a row DELETED mid-pagination is never skipped, no row double-counted", async () => {
		const { stores, transactions } = makeStores("tx-del");
		// 10 USD payments, descending occurredAt so the page order is deterministic.
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			const tx = await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `del_${i}`, amountCents: 100 + i, currency: "USD", occurredAt: `2026-05-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` });
			ids.push(tx.id);
		}
		const app = revenueAppAs("accountant", stores);
		const seen: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		let mutated = false;
		do {
			const url: string = cursor ? `/transactions?limit=3&cursor=${encodeURIComponent(cursor)}` : "/transactions?limit=3";
			const body = await (await app.request(url)).json();
			for (const t of body.transactions) seen.push(t.id);
			cursor = body.nextCursor;
			// After the FIRST page, delete an UNSEEN row that is still ahead in the
			// ordering. An OFFSET cursor would then skip the row that shifts into the
			// vacated slot; a keyset cursor will not, because it resumes by sort key.
			if (!mutated && cursor) {
				mutated = true;
				// Delete an older (further-down) row not yet visited.
				const removeId = ids[0]; // oldest occurredAt → last in DESC order, unseen yet
				const internal = transactions as unknown as { transactions: Array<{ id: string }> };
				const idx = internal.transactions.findIndex((t) => t.id === removeId);
				if (idx >= 0) internal.transactions.splice(idx, 1);
			}
			expect(++guard).toBeLessThan(40);
		} while (cursor);
		// No id is ever seen twice (keyset never re-reads a boundary row).
		expect(new Set(seen).size).toBe(seen.length);
		// Every NON-deleted row is visited exactly once; the deleted row simply vanishes,
		// but no OTHER row is skipped to "make room" for it (the OFFSET failure mode).
		const survivors = ids.slice(1); // ids[0] was deleted
		for (const id of survivors) expect(seen).toContain(id);
	});

	test("keyset: a row INSERTED mid-pagination causes no duplicate of an already-seen row", async () => {
		const { stores, transactions } = makeStores("tx-ins");
		for (let i = 0; i < 6; i++) {
			await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `ins_${i}`, amountCents: 100 + i, currency: "USD", occurredAt: `2026-05-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` });
		}
		const app = revenueAppAs("accountant", stores);
		const seen: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		let inserted = false;
		do {
			const url: string = cursor ? `/transactions?limit=2&cursor=${encodeURIComponent(cursor)}` : "/transactions?limit=2";
			const body = await (await app.request(url)).json();
			for (const t of body.transactions) seen.push(t.id);
			cursor = body.nextCursor;
			if (!inserted && cursor) {
				inserted = true;
				// Insert a NEWER row (sorts before the cursor) — with an OFFSET cursor this
				// pushes every later row down by one, double-counting a boundary row. The
				// keyset resumes by sort key, so the newer row is simply never revisited.
				await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "ins_new", amountCents: 999, currency: "USD", occurredAt: "2026-05-31T00:00:00.000Z" });
			}
			expect(++guard).toBeLessThan(40);
		} while (cursor);
		// No row is double-counted even though the set grew mid-pagination.
		expect(new Set(seen).size).toBe(seen.length);
	});
});

// ── P1 BUG 1: /transactions and /export.csv share the SAME keyset cursor ─────────
describe("admin revenue: export and /transactions agree (same stable cursor)", () => {
	test("CSV data rows == the full keyset pagination of /transactions (same id set + order)", async () => {
		const { stores, transactions } = makeStores("agree");
		// Mixed currencies + kinds, enough rows to span multiple pages.
		for (let i = 0; i < 12; i++) {
			await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `ag_u_${i}`, amountCents: 1000 + i, currency: "USD", occurredAt: `2026-04-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` });
		}
		await transactions.upsertTransaction({ kind: "refund", dodoEventRef: "ag_r", amountCents: -500, currency: "USD", occurredAt: "2026-04-09T00:00:00.000Z" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "ag_j", amountCents: 700, currency: "JPY", occurredAt: "2026-04-08T00:00:00.000Z" });
		const app = revenueAppAs("accountant", stores);

		// Full keyset pagination of /transactions.
		const pagedIds: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		do {
			const url: string = cursor ? `/transactions?limit=5&cursor=${encodeURIComponent(cursor)}` : "/transactions?limit=5";
			const body = await (await app.request(url)).json();
			for (const t of body.transactions) pagedIds.push(t.id);
			cursor = body.nextCursor;
			expect(++guard).toBeLessThan(40);
		} while (cursor);

		// CSV export data rows (skip header + the subtotal footer).
		const csv = await (await app.request("/export.csv")).text();
		const lines = csv.split("\n").filter((l) => l.trim().length > 0);
		const dataLines = lines.slice(1).filter((l) => !l.startsWith('"#') && !l.startsWith('"currency"') && !l.startsWith('"USD"') && !l.startsWith('"JPY"'));
		const csvIds = dataLines.map((l) => l.split(",")[0].replace(/^"|"$/g, ""));

		expect(csvIds.length).toBe(14);
		// Same rows, same stable order — the export and the list can never disagree.
		expect(csvIds).toEqual(pagedIds);
	});
});

// ── P1 BUG 2: the export is PULL-based / lazily paged (memory-bounded) ───────────
describe("admin revenue: export streaming is bounded (lazy paging, not pre-materialized)", () => {
	// A store spy that wraps a real FilePaymentTransactionsStore, FORCES a tiny page
	// size (so a small seed spans many pages), and counts how many times
	// listTransactionsKeyset is invoked — letting us prove pages are produced
	// incrementally (per pull) rather than all up-front before the first byte.
	function spyStore(inner: FilePaymentTransactionsStore, pageSize: number): { store: AdminRevenueRouterStores["transactions"]; calls: () => number } {
		let calls = 0;
		const store = {
			upsertTransaction: inner.upsertTransaction.bind(inner),
			listTransactions: inner.listTransactions.bind(inner),
			countTransactions: inner.countTransactions.bind(inner),
			sumByPlan: inner.sumByPlan.bind(inner),
			sumByPeriod: inner.sumByPeriod.bind(inner),
			listTransactionsKeyset: async (opts: Parameters<FilePaymentTransactionsStore["listTransactionsKeyset"]>[0]) => {
				calls += 1;
				// Clamp to a tiny page so N rows require ~N/pageSize page fetches.
				return inner.listTransactionsKeyset({ ...opts, limit: pageSize });
			},
		} as unknown as AdminRevenueRouterStores["transactions"];
		return { store, calls: () => calls };
	}

	async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let out = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			out += decoder.decode(value, { stream: true });
		}
		out += decoder.decode();
		return out;
	}

	test("CSV stream pages incrementally as it is read (not all pages up-front)", async () => {
		const { transactions } = makeStores("lazy-csv");
		const ROWS = 20;
		for (let i = 0; i < ROWS; i++) {
			await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `lz_${i}`, amountCents: 100 + i, currency: "USD", occurredAt: `2026-03-${String(1 + i).padStart(2, "0")}T00:00:00.000Z` });
		}
		// 20 rows / page size 2 = 10 data pages. If the stream pre-materialized the whole
		// set in start(), all 10 page-calls would fire before any read; lazy pull must
		// fetch far fewer pages by the time only the first data chunk has been consumed.
		const { store, calls } = spyStore(transactions, 2);
		const reader = (__test.buildCsvStream!(store, {})).getReader();
		await reader.read(); // header chunk
		await reader.read(); // first data page chunk
		const afterFirstData = calls();
		expect(afterFirstData).toBeLessThan(10); // strictly fewer than the total pages
		// Reading further pages MORE of the store — proof of incremental paging.
		await reader.read();
		await reader.read();
		expect(calls()).toBeGreaterThan(afterFirstData);
		reader.cancel();

		// Separately: a full drain pages through EVERY row exactly once + valid CSV.
		const { store: s2, calls: c2 } = spyStore(transactions, 2);
		const csv = await drain(__test.buildCsvStream!(s2, {}));
		const dataLines = csv.split("\n").filter((l) => l.startsWith('"lz') || /^"[0-9a-f-]{36}"/i.test(l));
		const ids = dataLines.map((l) => l.split(",")[0].replace(/^"|"$/g, ""));
		expect(new Set(ids).size).toBe(ROWS);
		expect(c2()).toBeGreaterThanOrEqual(ROWS / 2); // at least one page per 2 rows
	});

	test("JSON stream is also pull-based, pages incrementally, and emits a valid bounded document", async () => {
		const { transactions } = makeStores("lazy-json");
		const ROWS = 12;
		for (let i = 0; i < ROWS; i++) {
			await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `lzj_${i}`, amountCents: 100 + i, currency: i % 2 ? "JPY" : "USD", occurredAt: `2026-03-${String(1 + i).padStart(2, "0")}T00:00:00.000Z` });
		}
		// Incremental-paging proof: by the time only the opening + first data chunk are
		// read, not all 6 pages (12 rows / 2) have been fetched.
		const { store, calls } = spyStore(transactions, 2);
		const reader = (__test.buildJsonStream!(store, {})).getReader();
		await reader.read(); // opening `{"transactions":[`
		await reader.read(); // first data page
		expect(calls()).toBeLessThan(6);
		reader.cancel();

		// Full drain → a single valid, bounded JSON document with per-currency subtotals.
		const { store: s2 } = spyStore(transactions, 2);
		const body = await drain(__test.buildJsonStream!(s2, {}));
		const parsed = JSON.parse(body);
		expect(parsed.transactions).toHaveLength(ROWS);
		expect(Array.isArray(parsed.subtotals)).toBe(true);
		// USD + JPY subtotals present, never merged into one.
		expect(parsed.subtotals.some((s: { currency: string }) => s.currency === "USD")).toBe(true);
		expect(parsed.subtotals.some((s: { currency: string }) => s.currency === "JPY")).toBe(true);
	});
});

describe("admin revenue: /timeseries (per-currency buckets, never mixed)", () => {
	test("a month bucket splits per currency", async () => {
		const { stores, transactions } = makeStores("ts");
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "ts_u1", amountCents: 5000, currency: "USD", occurredAt: "2026-06-10T00:00:00.000Z" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "ts_u2", amountCents: 1000, currency: "USD", occurredAt: "2026-06-12T00:00:00.000Z" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "ts_j1", amountCents: 300, currency: "JPY", occurredAt: "2026-06-15T00:00:00.000Z" });

		const res = await revenueAppAs("accountant", stores).request("/timeseries?interval=month");
		const body = await res.json();
		expect(body.interval).toBe("month");
		const usd = body.series.find((s: { currency: string }) => s.currency === "USD");
		const jpy = body.series.find((s: { currency: string }) => s.currency === "JPY");
		// USD June bucket nets 6000; JPY bucket 300 — never summed together.
		expect(usd.points.find((p: { period: string }) => p.period === "2026-06-01T00:00:00.000Z").amountCents).toBe("6000");
		expect(jpy.points.find((p: { period: string }) => p.period === "2026-06-01T00:00:00.000Z").amountCents).toBe("300");
	});
});

describe("admin revenue: /refunds-disputes (per-currency net impact)", () => {
	test("refunds + disputes + favorable reversal net per currency", async () => {
		const { stores, transactions } = makeStores("rd");
		// USD: payment +1999, refund -500, dispute -1900 opened, reversal +1900 (favorable).
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "rd_pay", amountCents: 1999, currency: "USD" });
		await transactions.upsertTransaction({ kind: "refund", dodoEventRef: "rd_ref", amountCents: -500, currency: "USD" });
		await transactions.upsertTransaction({ kind: "dispute", dodoEventRef: "rd_dp", amountCents: -1900, currency: "USD" });
		await transactions.upsertTransaction({ kind: "dispute", dodoEventRef: "rd_dp:reversal", amountCents: 1900, currency: "USD" });
		// JPY: refund -100 only — must stay in its own currency block.
		await transactions.upsertTransaction({ kind: "refund", dodoEventRef: "rd_jref", amountCents: -100, currency: "JPY" });

		const res = await revenueAppAs("accountant", stores).request("/refunds-disputes");
		const body = await res.json();
		const usd = body.currencies.find((b: { currency: string }) => b.currency === "USD");
		const jpy = body.currencies.find((b: { currency: string }) => b.currency === "JPY");
		expect(usd.refundCents).toBe("-500");
		expect(usd.refundCount).toBe(1);
		// dispute opened -1900 + reversal +1900 = 0 net dispute impact.
		expect(usd.disputeCents).toBe("0");
		expect(usd.disputeCount).toBe(2);
		expect(usd.netImpactCents).toBe("-500");
		expect(jpy.refundCents).toBe("-100");
		expect(jpy.netImpactCents).toBe("-100");
	});
});

describe("admin revenue: /export.csv (escaping, exact decimals, per-currency subtotals)", () => {
	test("CSV escapes, renders exact decimals per currency, and subtotals never mix currencies", async () => {
		const { stores, transactions } = makeStores("csv");
		// USD: two payments 1999 + 1 cent; JPY: a 0-decimal 1900. A status with a comma
		// and a quote to prove escaping + a formula-injection guard via workspace id.
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "c_u1", amountCents: 1999, currency: "USD", status: 'ok,"weird"', planId: "pro", workspaceId: "=cmd" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "c_u2", amountCents: 1, currency: "USD" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "c_j1", amountCents: 1900, currency: "JPY" });

		const res = await revenueAppAs("accountant", stores).request("/export.csv");
		expect(res.status).toBe(200);
		const csv = await res.text();
		const lines = csv.trim().split("\n");
		expect(lines[0]).toBe(__test.csvRow(["id", "date", "kind", "amount_cents", "amount_decimal", "currency", "plan", "status", "workspace_id"]));
		// Escaping: the comma+quote status is quoted with doubled quotes.
		expect(csv).toContain('"ok,""weird"""');
		// Formula-injection guard: a leading "=" is prefixed with a single quote.
		expect(csv).toContain('"\'=cmd"');
		// Exact decimals: USD 1999 → 19.99 (2-decimal); JPY 1900 → 1900 (0-decimal).
		expect(csv).toContain('"19.99"');
		expect(csv).toMatch(/"1900"[^\n]*"JPY"/);
		// Per-currency subtotal rows present and never mixed.
		expect(csv).toContain("subtotals (per currency, never mixed)");
		// USD payment subtotal = 1999 + 1 = 2000 → 20.00; JPY = 1900 → 1900.
		expect(csv).toContain(__test.csvRow(["USD", "payment", "2000", "20.00", 2]));
		expect(csv).toContain(__test.csvRow(["JPY", "payment", "1900", "1900", 1]));
	});

	test("?format=json returns transactions + per-currency subtotals", async () => {
		const { stores, transactions } = makeStores("csv-json");
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "j_u1", amountCents: 1999, currency: "USD" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "j_j1", amountCents: 1900, currency: "JPY" });

		const res = await revenueAppAs("accountant", stores).request("/export.csv?format=json");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.transactions).toHaveLength(2);
		const usd = body.subtotals.find((s: { currency: string }) => s.currency === "USD");
		const jpy = body.subtotals.find((s: { currency: string }) => s.currency === "JPY");
		expect(usd.amountCents).toBe("1999");
		expect(usd.amountDecimal).toBe("19.99");
		expect(jpy.amountCents).toBe("1900");
		expect(jpy.amountDecimal).toBe("1900"); // 0-decimal
	});
});

describe("admin revenue: money helpers", () => {
	test("centsToDecimalString respects minor digits and sign", () => {
		expect(__test.centsToDecimalString("1999", 2)).toBe("19.99");
		expect(__test.centsToDecimalString("-1900", 0)).toBe("-1900");
		expect(__test.centsToDecimalString("5", 2)).toBe("0.05");
		expect(__test.centsToDecimalString("0", 2)).toBe("0.00");
		expect(__test.centsToDecimalString("1234", 3)).toBe("1.234"); // KWD
		// Huge value stays exact (no float).
		expect(__test.centsToDecimalString("9007199254740993", 2)).toBe("90071992547409.93");
	});

	test("netCentsStrings sums with BigInt (no float drift, large totals exact)", () => {
		expect(__test.netCentsStrings(["1999", "-1999"])).toBe("0");
		const big = "9007199254740991";
		expect(__test.netCentsStrings(Array.from({ length: 1000 }, () => big))).toBe("9007199254740991000");
	});

	test("keyset cursor round-trips (occurredAt,createdAt,id) and rejects garbage", () => {
		const key = { occurredAt: "2026-05-10T00:00:00.000Z", createdAt: "2026-05-10T00:00:01.000Z", id: "tx-1" };
		const c = __test.encodeTxCursor(key);
		expect(__test.decodeTxCursor(c)).toEqual(key);
		expect(__test.decodeTxCursor("not-base64-$$$")).toBeNull();
		expect(__test.decodeTxCursor(undefined)).toBeNull();
		// A legacy 1-element (offset) cursor must be rejected, not silently misread.
		const legacy = Buffer.from(JSON.stringify([42]), "utf8").toString("base64url");
		expect(__test.decodeTxCursor(legacy)).toBeNull();
		// Wrong element types are rejected.
		const wrongTypes = Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
		expect(__test.decodeTxCursor(wrongTypes)).toBeNull();
	});

	test("minorDigitsFor: JPY 0, KWD 3, USD/default 2", () => {
		expect(__test.minorDigitsFor("JPY")).toBe(0);
		expect(__test.minorDigitsFor("kwd")).toBe(3);
		expect(__test.minorDigitsFor("USD")).toBe(2);
		expect(__test.minorDigitsFor(null)).toBe(2);
	});
});

// ── Real-Postgres integration (gated on PAYMENT_TX_TEST_DATABASE_URL) ──────────
// Proves the SAME router endpoints over the PostgresPaymentTransactionsStore +
// PostgresBillingStore: per-currency summary/timeseries/refunds never mix USD/JPY,
// the CSV export streams per-currency subtotals + exact decimals, and pagination is
// stable — on the real SQL path, not the in-memory fake.
//
//   docker run -d -e POSTGRES_PASSWORD=verify -e POSTGRES_USER=verify \
//     -e POSTGRES_DB=revenue -p 55471:5432 postgres:16
//   DATABASE_URL=postgres://verify:verify@127.0.0.1:55471/revenue bun run src/migrations/cli.ts up
//   PAYMENT_TX_TEST_DATABASE_URL=postgres://verify:verify@127.0.0.1:55471/revenue bun test admin-revenue

const PG_URL = process.env.PAYMENT_TX_TEST_DATABASE_URL?.trim();
const describePg = PG_URL ? describe : describe.skip;

describePg("admin revenue: real Postgres", async () => {
	const { PostgresPaymentTransactionsStore } = await import("../services/payment-transactions-store.js");
	const { PostgresBillingStore } = await import("../services/billing-store.js");
	const sql = new Bun.SQL(PG_URL as string);
	const transactions = new PostgresPaymentTransactionsStore(sql as never);
	const billing = new PostgresBillingStore(sql as never);
	const stores: AdminRevenueRouterStores = { transactions, billing };

	// workspace_billing_accounts.workspace_id has a NOT NULL FK to workspaces, so a
	// billing assignment must seed the workspace row first.
	async function seedWorkspace(workspaceId: string): Promise<void> {
		await sql.unsafe(
			`INSERT INTO workspaces (workspace_id, name) VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
			[workspaceId, `Test ${workspaceId}`],
		);
	}

	beforeEach(async () => {
		await sql.unsafe("DELETE FROM payment_transactions");
		await sql.unsafe("DELETE FROM workspace_billing_accounts");
		await sql.unsafe("DELETE FROM workspaces WHERE workspace_id LIKE 'pgws%'");
	});
	afterAll(async () => {
		await sql.close?.();
	});

	test("gating: accountant 200, support 403 (real stores)", async () => {
		expect((await revenueAppAs("accountant", stores).request("/summary")).status).toBe(200);
		expect((await revenueAppAs("support", stores).request("/summary")).status).toBe(403);
		expect((await revenueAppAs("support", stores).request("/export.csv")).status).toBe(403);
	});

	test("/summary: MRR/ARR from active subs as integer-cents strings", async () => {
		await seedWorkspace("pgws-pro1");
		await seedWorkspace("pgws-pro2");
		await seedWorkspace("pgws-cancel");
		await billing.setWorkspacePlan({ workspaceId: "pgws-pro1", planId: "pro", status: "active" });
		await billing.setWorkspacePlan({ workspaceId: "pgws-pro2", planId: "pro", status: "active" });
		await billing.setWorkspacePlan({ workspaceId: "pgws-cancel", planId: "pro", status: "cancelled" });
		const body = await (await revenueAppAs("accountant", stores).request("/summary")).json();
		const usd = body.currencies[0];
		expect(usd.currency).toBe("USD");
		expect(usd.mrrCents).toBe("3800"); // 2 * 1900
		expect(usd.arrCents).toBe("45600");
		expect(usd.activeSubscriptions).toBe(2);
	});

	test("/summary + /timeseries: USD is never summed with JPY (real SQL grouping)", async () => {
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "pg_su", amountCents: 5000, currency: "USD", occurredAt: "2026-06-10T00:00:00.000Z" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "pg_sj", amountCents: 100, currency: "JPY", occurredAt: "2026-06-11T00:00:00.000Z" });
		const ts = await (await revenueAppAs("owner", stores).request("/timeseries?interval=month")).json();
		const usd = ts.series.find((s: { currency: string }) => s.currency === "USD");
		const jpy = ts.series.find((s: { currency: string }) => s.currency === "JPY");
		expect(usd.points[0].amountCents).toBe("5000");
		expect(jpy.points[0].amountCents).toBe("100");
		expect(ts.series.length).toBe(2);
	});

	test("/refunds-disputes: net impact per currency, reversal nets dispute back", async () => {
		await transactions.upsertTransaction({ kind: "refund", dodoEventRef: "pg_rref", amountCents: -500, currency: "USD" });
		await transactions.upsertTransaction({ kind: "dispute", dodoEventRef: "pg_rdp", amountCents: -1900, currency: "USD" });
		await transactions.upsertTransaction({ kind: "dispute", dodoEventRef: "pg_rdp:reversal", amountCents: 1900, currency: "USD" });
		await transactions.upsertTransaction({ kind: "refund", dodoEventRef: "pg_rjref", amountCents: -100, currency: "JPY" });
		const body = await (await revenueAppAs("accountant", stores).request("/refunds-disputes")).json();
		const usd = body.currencies.find((b: { currency: string }) => b.currency === "USD");
		const jpy = body.currencies.find((b: { currency: string }) => b.currency === "JPY");
		expect(usd.refundCents).toBe("-500");
		expect(usd.disputeCents).toBe("0"); // -1900 + 1900
		expect(usd.netImpactCents).toBe("-500");
		expect(jpy.netImpactCents).toBe("-100");
	});

	test("/transactions: stable cursor pagination over real SQL", async () => {
		for (let i = 0; i < 7; i++) {
			await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `pg_pg_${i}`, amountCents: 1000 + i, currency: "USD", occurredAt: `2026-05-0${i + 1}T00:00:00.000Z` });
		}
		const app = revenueAppAs("accountant", stores);
		const seen = new Set<string>();
		let cursor: string | null = null;
		let guard = 0;
		do {
			const url: string = cursor ? `/transactions?limit=3&cursor=${encodeURIComponent(cursor)}` : "/transactions?limit=3";
			const body = await (await app.request(url)).json();
			for (const t of body.transactions) seen.add(t.id);
			cursor = body.nextCursor;
			expect(++guard).toBeLessThan(20);
		} while (cursor);
		expect(seen.size).toBe(7);
	});

	// ── P1 BUG 1: TRUE keyset on real SQL survives concurrent insert + delete ─────
	test("/transactions: keyset visits every row exactly once under mid-pagination mutation (real PG)", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 12; i++) {
			const tx = await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `pg_mut_${i}`, amountCents: 1000 + i, currency: "USD", occurredAt: `2026-05-${String(1 + i).padStart(2, "0")}T00:00:00.000Z` });
			ids.push(tx.id);
		}
		const app = revenueAppAs("accountant", stores);
		const seen: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		let mutated = false;
		do {
			const url: string = cursor ? `/transactions?limit=3&cursor=${encodeURIComponent(cursor)}` : "/transactions?limit=3";
			const body = await (await app.request(url)).json();
			for (const t of body.transactions) seen.push(t.id);
			cursor = body.nextCursor;
			if (!mutated && cursor) {
				mutated = true;
				// DELETE the oldest (still-unseen, last-in-DESC) row, and INSERT a brand new
				// newest row (already passed in DESC order). An OFFSET cursor would skip or
				// duplicate rows around both mutations; the keyset cursor must not.
				await sql.unsafe("DELETE FROM payment_transactions WHERE id = $1", [ids[0]]);
				await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "pg_mut_new", amountCents: 5, currency: "USD", occurredAt: "2026-05-31T00:00:00.000Z" });
			}
			expect(++guard).toBeLessThan(40);
		} while (cursor);
		// No row double-counted (keyset never re-reads a boundary row).
		expect(new Set(seen).size).toBe(seen.length);
		// Every surviving original row (ids[1..]) is visited exactly once — none skipped to
		// "fill" the deleted row's vacated slot (the OFFSET failure mode).
		for (const id of ids.slice(1)) expect(seen).toContain(id);
	});

	test("/transactions: keyset is stable when many rows share the SAME occurred_at (created_at + id tiebreak, real PG)", async () => {
		// All 9 rows share an identical occurred_at, so paging order falls entirely to
		// the created_at + id tiebreakers — the exact case the millisecond-truncation +
		// unique-id keyset must get right (no skip, no dup) across pages.
		const ids: string[] = [];
		for (let i = 0; i < 9; i++) {
			const tx = await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `pg_same_${i}`, amountCents: 100 + i, currency: "USD", occurredAt: "2026-07-01T00:00:00.000Z" });
			ids.push(tx.id);
		}
		const app = revenueAppAs("accountant", stores);
		const seen: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		do {
			const url: string = cursor ? `/transactions?limit=2&cursor=${encodeURIComponent(cursor)}` : "/transactions?limit=2";
			const body = await (await app.request(url)).json();
			for (const t of body.transactions) seen.push(t.id);
			cursor = body.nextCursor;
			expect(++guard).toBeLessThan(30);
		} while (cursor);
		expect(seen.length).toBe(9);
		expect(new Set(seen).size).toBe(9); // every row exactly once
		for (const id of ids) expect(seen).toContain(id);
	});

	test("/transactions and /export.csv agree row-for-row on real PG (same keyset cursor)", async () => {
		for (let i = 0; i < 11; i++) {
			await transactions.upsertTransaction({ kind: "payment", dodoEventRef: `pg_agr_${i}`, amountCents: 1000 + i, currency: i % 3 === 0 ? "JPY" : "USD", occurredAt: `2026-04-${String(1 + i).padStart(2, "0")}T00:00:00.000Z` });
		}
		const app = revenueAppAs("accountant", stores);
		const pagedIds: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		do {
			const url: string = cursor ? `/transactions?limit=4&cursor=${encodeURIComponent(cursor)}` : "/transactions?limit=4";
			const body = await (await app.request(url)).json();
			for (const t of body.transactions) pagedIds.push(t.id);
			cursor = body.nextCursor;
			expect(++guard).toBeLessThan(40);
		} while (cursor);
		const csv = await (await app.request("/export.csv")).text();
		const dataLines = csv.split("\n").filter((l) => /^"[0-9a-f-]{36}"/i.test(l));
		const csvIds = dataLines.map((l) => l.split(",")[0].replace(/^"|"$/g, ""));
		expect(csvIds.length).toBe(11);
		expect(csvIds).toEqual(pagedIds); // identical set + identical stable order
	});

	test("/export.csv: per-currency subtotals + exact decimals (USD 2, JPY 0) on real PG", async () => {
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "pg_cu1", amountCents: 1999, currency: "USD", status: 'ok,"x"' });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "pg_cu2", amountCents: 1, currency: "USD" });
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "pg_cj1", amountCents: 1900, currency: "JPY" });
		const res = await revenueAppAs("accountant", stores).request("/export.csv");
		const csv = await res.text();
		expect(csv).toContain('"ok,""x"""'); // escaped
		expect(csv).toContain('"19.99"'); // USD exact decimal
		expect(csv).toContain(__test.csvRow(["USD", "payment", "2000", "20.00", 2]));
		expect(csv).toContain(__test.csvRow(["JPY", "payment", "1900", "1900", 1]));
	});
});

describe("admin revenue: response caching (/summary, /timeseries)", () => {
	// Wrap a real billing store so we can count how often the expensive scan runs.
	function countingBilling(inner: FileBillingStore): { billing: FileBillingStore; calls: () => number } {
		let n = 0;
		const proxy = new Proxy(inner, {
			get(target, prop, receiver) {
				if (prop === "listAssignments") {
					return async (...args: unknown[]) => {
						n++;
						return (target.listAssignments as (...a: unknown[]) => unknown)(...args);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		return { billing: proxy as FileBillingStore, calls: () => n };
	}

	async function seedSummary(billing: FileBillingStore): Promise<void> {
		await billing.setWorkspacePlan({ workspaceId: "c-pro", planId: "pro", status: "active" });
		await billing.setWorkspacePlan({ workspaceId: "c-creator", planId: "creator", status: "active" });
	}

	test("/summary: a within-TTL second hit does NOT re-scan billing, and bodies match", async () => {
		const raw = new FileBillingStore(join(tmpRoot, "cache-hit-billing.json"));
		await seedSummary(raw);
		const { billing, calls } = countingBilling(raw);
		const stores: AdminRevenueRouterStores = {
			billing,
			transactions: new FilePaymentTransactionsStore(join(tmpRoot, "cache-hit-tx.json")),
			cache: new MemoryResponseCache(() => 1_000), // frozen clock → stays within TTL
		};
		const app = revenueAppAs("accountant", stores);
		const a = await (await app.request("/summary")).json();
		const b = await (await app.request("/summary")).json();
		expect(calls()).toBe(1); // computed once, second served from cache
		expect(b).toEqual(a);
		expect(a.currencies[0].mrrCents).toBe("3400"); // 2500 + 900
	});

	test("/summary: default (no injected cache) recomputes every call", async () => {
		const raw = new FileBillingStore(join(tmpRoot, "cache-default-billing.json"));
		await seedSummary(raw);
		const { billing, calls } = countingBilling(raw);
		// No `cache` in stores → getResponseCache() → NoopResponseCache under NODE_ENV=test.
		const stores: AdminRevenueRouterStores = {
			billing,
			transactions: new FilePaymentTransactionsStore(join(tmpRoot, "cache-default-tx.json")),
		};
		const app = revenueAppAs("accountant", stores);
		await app.request("/summary");
		await app.request("/summary");
		expect(calls()).toBe(2);
	});

	test("caching never bypasses the REVENUE_READ gate (cache lives behind auth)", async () => {
		const raw = new FileBillingStore(join(tmpRoot, "cache-auth-billing.json"));
		await seedSummary(raw);
		const stores: AdminRevenueRouterStores = {
			billing: raw,
			transactions: new FilePaymentTransactionsStore(join(tmpRoot, "cache-auth-tx.json")),
			cache: new MemoryResponseCache(() => 1_000),
		};
		// Accountant warms the cache.
		expect((await revenueAppAs("accountant", stores).request("/summary")).status).toBe(200);
		// A role without REVENUE_READ is still 403 — the gate runs before the handler.
		expect((await revenueAppAs("support", stores).request("/summary")).status).toBe(403);
	});

	test("/timeseries: different query params are cached independently", async () => {
		const transactions = new FilePaymentTransactionsStore(join(tmpRoot, "cache-ts-tx.json"));
		await transactions.upsertTransaction({ kind: "payment", dodoEventRef: "ts1", amountCents: 1000, currency: "USD", occurredAt: "2026-05-10T00:00:00.000Z" });
		let n = 0;
		const proxy = new Proxy(transactions, {
			get(target, prop, receiver) {
				if (prop === "sumByPeriod") {
					return async (...args: unknown[]) => {
						n++;
						return (target.sumByPeriod as (...a: unknown[]) => unknown)(...args);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		const stores: AdminRevenueRouterStores = {
			billing: new FileBillingStore(join(tmpRoot, "cache-ts-billing.json")),
			transactions: proxy as FilePaymentTransactionsStore,
			cache: new MemoryResponseCache(() => 1_000),
		};
		const app = revenueAppAs("accountant", stores);
		await app.request("/timeseries?interval=month");
		await app.request("/timeseries?interval=month"); // cache hit (same key)
		await app.request("/timeseries?interval=day"); // different param → recompute
		expect(n).toBe(2);
	});
});
