// Back-office SUPPORT console (ranks 12-14) — behavior tests.
//
// Drives the real createAdminSupportRouter mounted under createAdminRouter (so it goes
// through the SAME parent gates production uses), with fully in-memory stores injected
// so the assertions are deterministic and need no Postgres. Proves the four guarantees
// the support console exists to deliver:
//   * lookup is READ-ONLY + gated SUPPORT_READ (editor 403) and returns REAL cross-entity
//     data (profile + plan + credit balance + recent payments) for the resolved customer;
//   * credit grant is a REAL credits.ts grant (balance moves), gated SUPPORT_ADJUST,
//     AUDITED, and IDEMPOTENT (a retry with the same key does not double-grant);
//   * plan change is a REAL billing-store write (plan moves), gated SUPPORT_ADJUST, audited;
//   * refund is a REAL negative per-currency payment_transactions row, gated REFUND_WRITE,
//     audited, and IDEMPOTENT (a retry with the same key does not double-refund).
//
// Real-Postgres coverage lives in admin-support.real-pg.test.ts (gated on TEST_DATABASE_URL).

import { describe, test, expect, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createAdminRouter } from "../routes/admin.js";
import type { UserRole } from "../types/auth.js";
import { CreditService } from "../services/credits.js";
import { FileBillingStore, BillingStoreError } from "../services/billing-store.js";
import { FilePaymentTransactionsStore } from "../services/payment-transactions-store.js";
import { FileSupportTicketStore } from "../services/support-tickets.js";
import { createMemoryGdprStore } from "../services/gdpr.js";
import { dodoService, DodoService } from "../services/dodo.service.js";
import type { GdprStore } from "../services/gdpr.js";
import { serverConfig } from "../config.js";
import type DodoPayments from "dodopayments";

// Stub auth — attaches a fixed platform role without JWT verification.
function stubAuth(role: UserRole, userId = `stub-${role}`) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${role}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
}

// Fresh, fully-isolated in-memory stores per test.
function freshStores() {
	const creditService = new CreditService(join(tmpdir(), `admin-support-credits-${randomUUID()}.json`), undefined, { crossProcessSafe: false });
	// In-memory: no persist path → state lives only for this test.
	const billing = new FileBillingStore();
	const paymentTransactionsStore = new FilePaymentTransactionsStore();
	const ticketStore = new FileSupportTicketStore();
	const gdpr = createMemoryGdprStore();
	return { creditService, billing, paymentTransactionsStore, ticketStore, gdpr };
}

function appAs(role: UserRole, stores: ReturnType<typeof freshStores>, userId?: string, dodo: DodoService = dodoService): Hono {
	const app = new Hono();
	// Support-domain DI (creditService/paymentTransactionsStore/ticketStore/dodoService)
	// is threaded through AdminRouterDeps → createAdminSupportRouter(deps); the parent
	// AdminRouterDeps type does not list them, so build the object loosely and cast.
	const deps = {
		// workspaceAccess null → lookup falls back to treating the query as a workspace id.
		workspaceAccess: null,
		billing: stores.billing,
		gdpr: stores.gdpr,
		authMiddleware: stubAuth(role, userId),
		creditService: stores.creditService,
		paymentTransactionsStore: stores.paymentTransactionsStore,
		ticketStore: stores.ticketStore,
		dodoService: dodo,
	} as unknown as Parameters<typeof createAdminRouter>[0];
	app.route("/", createAdminRouter(deps));
	return app;
}

// A DodoService wired to a LIVE-provider config + a SPY refunds.create that COUNTS calls
// and records the exact args passed to the provider. Lets the money-out tests assert
// the provider is hit exactly once (replay-safe) and with the partial amount + currency.
function spyDodo(): { dodo: DodoService; calls: Array<{ body: unknown; options: unknown }> } {
	const calls: Array<{ body: unknown; options: unknown }> = [];
	const dodo = new DodoService({
		sqlClient: null,
		client: {
			refunds: {
				create: async (body: unknown, options: unknown) => {
					calls.push({ body, options });
					return { refund_id: `rfnd_${calls.length}`, status: "succeeded" };
				},
			},
		} as unknown as DodoPayments,
		config: { ...serverConfig, billingProvider: "dodo" },
	});
	return { dodo, calls };
}

async function auditActions(gdpr: GdprStore): Promise<string[]> {
	const { entries } = await gdpr.listAdminAudit({ limit: 100 });
	return entries.map((e) => e.action);
}

describe("admin support console (ranks 12-14)", () => {
	let stores: ReturnType<typeof freshStores>;
	beforeEach(() => {
		stores = freshStores();
	});

	// ── Lookup ────────────────────────────────────────────────────
	test("lookup: returns REAL cross-entity data scoped to admin (plan + balance + payments)", async () => {
		const WS = "ws-lookup-1";
		// Seed a plan + a shareable grant + a payment for the workspace.
		await stores.billing.setWorkspacePlan({ workspaceId: WS, planId: "pro", status: "active" });
		await stores.creditService.grantCredits({
			workspaceId: WS, ownerScope: "workspace", ownerId: WS, creditClass: "shareable", amount: 500, source: "goodwill",
		});
		await stores.paymentTransactionsStore.upsertTransaction({
			workspaceId: WS, kind: "payment", amountCents: 1999, currency: "USD", status: "succeeded", dodoEventRef: "pay-1",
		});

		const res = await appAs("support", stores).request(`/support/lookup?query=${WS}`);
		expect(res.status).toBe(200);
		const body = await res.json() as {
			workspace: { id: string } | null;
			plan: { planId: string; status: string | null } | null;
			creditBalance: { shareable: number; total: number };
			recentPayments: Array<{ amountCents: number; currency: string | null }>;
		};
		expect(body.workspace?.id).toBe(WS);
		expect(body.plan?.planId).toBe("pro");
		expect(body.plan?.status).toBe("active");
		expect(body.creditBalance.shareable).toBe(500);
		expect(body.recentPayments).toHaveLength(1);
		expect(body.recentPayments[0]?.amountCents).toBe(1999);
		expect(body.recentPayments[0]?.currency).toBe("USD");
	});

	test("lookup: unknown customer → 404", async () => {
		const res = await appAs("support", stores).request("/support/lookup?query=nobody-here");
		expect(res.status).toBe(404);
	});

	test("lookup: editor is rejected at the ACCESS gate (403)", async () => {
		const res = await appAs("editor", stores).request("/support/lookup?query=ws-lookup-1");
		expect(res.status).toBe(403);
	});

	test("lookup: accountant is rejected (no SUPPORT_READ) (403)", async () => {
		const res = await appAs("accountant", stores).request("/support/lookup?query=ws-lookup-1");
		expect(res.status).toBe(403);
	});

	// ── Credit grant ──────────────────────────────────────────────
	test("credit grant: REAL grant moves the balance, is AUDITED + IDEMPOTENT on retry", async () => {
		const WS = "ws-grant-1";
		const body = JSON.stringify({ amount: 250, reason: "goodwill apology", idempotencyKey: "grant-key-1" });
		const app = appAs("support", stores);

		const res1 = await app.request(`/support/workspaces/${WS}/credits`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body,
		});
		expect(res1.status).toBe(200);
		const out1 = await res1.json() as { ok: boolean; grant: { id: string; amount: number } };
		expect(out1.ok).toBe(true);
		expect(out1.grant.amount).toBe(250);

		// Balance actually moved (shareable, workspace-owned).
		expect(stores.creditService.getBalance("workspace", WS).shareable).toBe(250);

		// Retry with the SAME idempotency key → same grant id, balance unchanged (no double-grant).
		const res2 = await app.request(`/support/workspaces/${WS}/credits`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body,
		});
		expect(res2.status).toBe(200);
		const out2 = await res2.json() as { grant: { id: string } };
		expect(out2.grant.id).toBe(out1.grant.id);
		expect(stores.creditService.getBalance("workspace", WS).shareable).toBe(250);

		// Audited (both calls record an audit row — the action is the same).
		const actions = await auditActions(stores.gdpr);
		expect(actions.filter((a) => a === "admin.support.credit_grant").length).toBeGreaterThanOrEqual(1);
	});

	test("credit grant: accountant is rejected (no SUPPORT_ADJUST) (403)", async () => {
		const res = await appAs("accountant", stores).request("/support/workspaces/ws/credits", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 100, reason: "x" }),
		});
		expect(res.status).toBe(403);
	});

	test("credit grant: personal class without userId → 400", async () => {
		const res = await appAs("support", stores).request("/support/workspaces/ws/credits", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 100, reason: "x", creditClass: "personal" }),
		});
		expect(res.status).toBe(400);
	});

	test("credit grant: missing idempotencyKey → 400 (grant must be replay-safe, no double-mint)", async () => {
		const res = await appAs("support", stores).request("/support/workspaces/ws-grant-nokey/credits", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 100, reason: "missing key" }),
		});
		expect(res.status).toBe(400);
	});

	test("credit grant: double-submit with the SAME key is replay-safe — one grant, balance unchanged", async () => {
		const WS = "ws-grant-replay";
		const body = JSON.stringify({ amount: 750, reason: "goodwill", idempotencyKey: "grant-replay-key" });
		const app = appAs("support", stores);
		const r1 = await app.request(`/support/workspaces/${WS}/credits`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		const r2 = await app.request(`/support/workspaces/${WS}/credits`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		const g1 = (await r1.json() as { grant: { id: string } }).grant;
		const g2 = (await r2.json() as { grant: { id: string } }).grant;
		// Same grant id, and the balance moved EXACTLY ONCE (no double-grant on retry).
		expect(g2.id).toBe(g1.id);
		expect(stores.creditService.getBalance("workspace", WS).shareable).toBe(750);
	});

	// ── Plan change ───────────────────────────────────────────────
	test("plan change: REAL billing write moves the plan + is AUDITED", async () => {
		const WS = "ws-plan-1";
		await stores.billing.setWorkspacePlan({ workspaceId: WS, planId: "free", status: "active" });
		const res = await appAs("support", stores).request(`/support/workspaces/${WS}/plan-change`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "studio", status: "active", reason: "comped upgrade" }),
		});
		expect(res.status).toBe(200);
		const out = await res.json() as { billing: { planId: string } };
		expect(out.billing.planId).toBe("studio");
		// Persisted.
		const assignment = await stores.billing.getWorkspaceAssignment(WS);
		expect(assignment?.planId).toBe("studio");
		expect(await auditActions(stores.gdpr)).toContain("admin.support.plan_change");
	});

	test("plan change: unknown plan → 400", async () => {
		const res = await appAs("support", stores).request("/support/workspaces/ws/plan-change", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "enterprise-mega", reason: "x" }),
		});
		expect(res.status).toBe(400);
	});

	test("plan change: a billing PERSISTENCE failure is a 500 server fault, not a 400", async () => {
		// A billing store whose write fails at the persistence layer (DB down etc.).
		const failingBilling = {
			getWorkspaceAssignment: async () => null,
			setWorkspacePlan: async () => {
				throw new BillingStoreError("Failed to persist workspace plan assignment", "billing_assignment_failed");
			},
		} as unknown as ReturnType<typeof freshStores>["billing"];
		const res = await appAs("support", { ...stores, billing: failingBilling }).request("/support/workspaces/ws-fail/plan-change", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "studio", status: "active", reason: "x" }),
		});
		expect(res.status).toBe(500);
		expect((await res.json() as { code: string }).code).toBe("billing_assignment_failed");
	});

	test("plan change: accountant is rejected (no SUPPORT_ADJUST) (403)", async () => {
		const res = await appAs("accountant", stores).request("/support/workspaces/ws/plan-change", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "pro", reason: "x" }),
		});
		expect(res.status).toBe(403);
	});

	// ── Refund ────────────────────────────────────────────────────
	test("refund: writes a correct NEGATIVE per-currency row, AUDITED + IDEMPOTENT on retry", async () => {
		const WS = "ws-refund-1";
		const CHARGE = "pay-refund-1";
		// Seed the ORIGINAL payment so the refund validates against a real charge.
		await stores.paymentTransactionsStore.upsertTransaction({
			workspaceId: WS, kind: "payment", dodoPaymentId: CHARGE, dodoEventRef: CHARGE,
			amountCents: 1999, currency: "USD", status: "succeeded",
		});
		const body = JSON.stringify({ amountMinor: 1999, currency: "usd", reason: "duplicate charge", dodoChargeId: CHARGE, idempotencyKey: "refund-key-1" });
		// Only owner/admin hold REFUND_WRITE.
		const app = appAs("admin", stores);

		const res1 = await app.request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body,
		});
		expect(res1.status).toBe(200);
		const out1 = await res1.json() as { ok: boolean; refund: { id: string; amountCents: number; currency: string | null; kind: string } };
		expect(out1.ok).toBe(true);
		// Stored NEGATIVE (refund reduces revenue), per-currency (uppercased), integer cents.
		expect(out1.refund.amountCents).toBe(-1999);
		expect(out1.refund.currency).toBe("USD");
		expect(out1.refund.kind).toBe("refund");

		// Exactly one refund row exists.
		const after1 = await stores.paymentTransactionsStore.listTransactions({ workspaceId: WS, kind: "refund" });
		expect(after1.total).toBe(1);

		// Retry with the SAME idempotency key → converges on the same row, still ONE refund.
		const res2 = await app.request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body,
		});
		expect(res2.status).toBe(200);
		const out2 = await res2.json() as { refund: { id: string } };
		expect(out2.refund.id).toBe(out1.refund.id);
		const after2 = await stores.paymentTransactionsStore.listTransactions({ workspaceId: WS, kind: "refund" });
		expect(after2.total).toBe(1);

		// Net revenue for the workspace nets to the negative refund (no double-out).
		const sum = await stores.paymentTransactionsStore.sumByPlan({ currency: "USD" });
		const refundBucket = sum.find((r) => r.kind === "refund" && r.currency === "USD");
		expect(refundBucket?.amountCents).toBe("-1999");

		expect(await auditActions(stores.gdpr)).toContain("admin.support.refund");
	});

	test("refund: support role CANNOT issue a refund — REFUND_WRITE required (403)", async () => {
		const res = await appAs("support", stores).request("/support/workspaces/ws/refund", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "x", idempotencyKey: "k" }),
		});
		expect(res.status).toBe(403);
	});

	test("refund: missing idempotencyKey → 400 (money-out must be replay-safe)", async () => {
		const res = await appAs("admin", stores).request("/support/workspaces/ws/refund", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "x", dodoChargeId: "pay-x" }),
		});
		expect(res.status).toBe(400);
	});

	test("refund: missing dodoChargeId → 400 (cannot validate amount/currency without the original)", async () => {
		const res = await appAs("admin", stores).request("/support/workspaces/ws/refund", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "x", idempotencyKey: "k-nocharge" }),
		});
		expect(res.status).toBe(400);
	});

	// ── Refund money-out safety (P1): provider replay-safety + validation ──────────
	async function seedPayment(WS: string, charge: string, amountCents: number, currency = "USD") {
		await stores.paymentTransactionsStore.upsertTransaction({
			workspaceId: WS, kind: "payment", dodoPaymentId: charge, dodoEventRef: charge,
			amountCents, currency, status: "succeeded",
		});
	}

	test("refund (provider live): double-submit with the same key calls Dodo refunds.create EXACTLY ONCE + one ledger row", async () => {
		const WS = "ws-provider-once";
		const CHARGE = "pay_live_1";
		await seedPayment(WS, CHARGE, 5000);
		const { dodo, calls } = spyDodo();
		const app = appAs("admin", stores, undefined, dodo);
		const body = JSON.stringify({ amountMinor: 5000, currency: "USD", reason: "duplicate", dodoChargeId: CHARGE, idempotencyKey: "live-key-1" });

		const r1 = await app.request(`/support/workspaces/${WS}/refund`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		const r2 = await app.request(`/support/workspaces/${WS}/refund`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		const ref1 = (await r1.json() as { refund: { id: string }; providerRefundId: string | null });
		const ref2 = (await r2.json() as { refund: { id: string }; providerRefundId: string | null });

		// Provider hit EXACTLY ONCE despite the retry — no second money-out at Dodo.
		expect(calls.length).toBe(1);
		// Same ledger row + same provider refund id returned on the replay.
		expect(ref2.refund.id).toBe(ref1.refund.id);
		expect(ref2.providerRefundId).toBe(ref1.providerRefundId);
		const refunds = await stores.paymentTransactionsStore.listTransactions({ workspaceId: WS, kind: "refund" });
		expect(refunds.total).toBe(1);
	});

	test("refund (provider live): a PARTIAL refund passes the amount + currency to the provider", async () => {
		const WS = "ws-provider-partial";
		const CHARGE = "pay_live_2";
		await seedPayment(WS, CHARGE, 5000);
		const { dodo, calls } = spyDodo();
		const app = appAs("admin", stores, undefined, dodo);
		// Refund 2000 of a 5000 charge — must be PARTIAL at the provider, not a full refund.
		const body = JSON.stringify({ amountMinor: 2000, currency: "USD", reason: "partial", dodoChargeId: CHARGE, idempotencyKey: "partial-key-1" });
		const res = await app.request(`/support/workspaces/${WS}/refund`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		expect(res.status).toBe(200);

		expect(calls.length).toBe(1);
		const sent = calls[0]!.body as { payment_id: string; items: Array<{ item_id: string; amount: number }>; metadata: { currency: string } };
		// The PARTIAL amount (minor units) is sent to Dodo via items[].amount — not omitted
		// (which would make Dodo full-refund the payment).
		expect(sent.payment_id).toBe(CHARGE);
		expect(sent.items[0]?.amount).toBe(2000);
		expect(sent.metadata.currency).toBe("USD");
		// And the SDK idempotency option is passed (belt + suspenders provider dedupe).
		expect((calls[0]!.options as { idempotencyKey: string }).idempotencyKey).toBe("partial-key-1");

		// Ledger records the partial NEGATIVE amount.
		const refunds = await stores.paymentTransactionsStore.listTransactions({ workspaceId: WS, kind: "refund" });
		expect(refunds.transactions[0]?.amountCents).toBe(-2000);
	});

	test("refund: amount > original paid → 400 (over-refund rejected) and provider NOT called", async () => {
		const WS = "ws-over";
		const CHARGE = "pay_over_1";
		await seedPayment(WS, CHARGE, 1000);
		const { dodo, calls } = spyDodo();
		const app = appAs("admin", stores, undefined, dodo);
		const res = await app.request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 1500, currency: "USD", reason: "too much", dodoChargeId: CHARGE, idempotencyKey: "over-key" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json() as { code: string }).code).toBe("dodo_refund_exceeds_original");
		// No money left the provider, and no ledger row was written.
		expect(calls.length).toBe(0);
		expect((await stores.paymentTransactionsStore.listTransactions({ workspaceId: WS, kind: "refund" })).total).toBe(0);
	});

	test("refund: wrong currency → 400 (currency mismatch rejected)", async () => {
		const WS = "ws-cur";
		const CHARGE = "pay_cur_1";
		await seedPayment(WS, CHARGE, 1000, "USD");
		const res = await appAs("admin", stores).request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 1000, currency: "EUR", reason: "wrong cur", dodoChargeId: CHARGE, idempotencyKey: "cur-key" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json() as { code: string }).code).toBe("dodo_refund_currency_mismatch");
	});

	test("refund: original payment with missing currency → 400 (fail closed)", async () => {
		const WS = "ws-cur-missing";
		const CHARGE = "pay_cur_missing_1";
		await seedPayment(WS, CHARGE, 1000, "");
		const res = await appAs("admin", stores).request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 1000, currency: "USD", reason: "missing cur", dodoChargeId: CHARGE, idempotencyKey: "cur-missing-key" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json() as { code: string }).code).toBe("dodo_refund_original_currency_missing");
		expect((await stores.paymentTransactionsStore.listTransactions({ workspaceId: WS, kind: "refund" })).total).toBe(0);
	});

	test("refund: matching original payment currency still succeeds", async () => {
		const WS = "ws-cur-match";
		const CHARGE = "pay_cur_match_1";
		await seedPayment(WS, CHARGE, 1000, "USD");
		const res = await appAs("admin", stores).request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 1000, currency: "USD", reason: "match cur", dodoChargeId: CHARGE, idempotencyKey: "cur-match-key" }),
		});
		expect(res.status).toBe(200);
		const refunds = await stores.paymentTransactionsStore.listTransactions({ workspaceId: WS, kind: "refund" });
		expect(refunds.total).toBe(1);
		expect(refunds.transactions[0]?.currency).toBe("USD");
		expect(refunds.transactions[0]?.amountCents).toBe(-1000);
	});

	test("refund: no original payment for the charge → 400", async () => {
		const WS = "ws-noorig";
		const res = await appAs("admin", stores).request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 500, currency: "USD", reason: "ghost", dodoChargeId: "pay_ghost", idempotencyKey: "ghost-key" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json() as { code: string }).code).toBe("dodo_refund_original_not_found");
	});

	test("refund: cumulative partial refunds can never exceed the original", async () => {
		const WS = "ws-cumulative";
		const CHARGE = "pay_cum_1";
		await seedPayment(WS, CHARGE, 1000);
		const app = appAs("admin", stores);
		// First partial 600 — OK (remaining 400).
		const r1 = await app.request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 600, currency: "USD", reason: "p1", dodoChargeId: CHARGE, idempotencyKey: "cum-1" }),
		});
		expect(r1.status).toBe(200);
		// Second partial 500 would total 1100 > 1000 → REJECTED.
		const r2 = await app.request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 500, currency: "USD", reason: "p2", dodoChargeId: CHARGE, idempotencyKey: "cum-2" }),
		});
		expect(r2.status).toBe(400);
		expect((await r2.json() as { code: string }).code).toBe("dodo_refund_exceeds_original");
		// A second partial of 400 (exactly the remaining) is allowed.
		const r3 = await app.request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 400, currency: "USD", reason: "p3", dodoChargeId: CHARGE, idempotencyKey: "cum-3" }),
		});
		expect(r3.status).toBe(200);
		// Now fully refunded — any further refund is rejected.
		const r4 = await app.request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 1, currency: "USD", reason: "p4", dodoChargeId: CHARGE, idempotencyKey: "cum-4" }),
		});
		expect(r4.status).toBe(400);
		expect((await r4.json() as { code: string }).code).toBe("dodo_refund_already_full");
		// Exactly two refund rows totaling -1000.
		const sum = await stores.paymentTransactionsStore.sumByPlan({ currency: "USD" });
		expect(sum.find((r) => r.kind === "refund")?.amountCents).toBe("-1000");
	});

	// ── Audit attribution (P2): actorRole is recorded explicitly ───────────────────
	test("audit: every support mutation records actorRole explicitly (admin)", async () => {
		const WS = "ws-audit-role";
		const CHARGE = "pay_audit_1";
		await stores.billing.setWorkspacePlan({ workspaceId: WS, planId: "free", status: "active" });
		await seedPayment(WS, CHARGE, 1000);
		const app = appAs("admin", stores, "audit-admin");
		await app.request(`/support/workspaces/${WS}/credits`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 10, reason: "r", idempotencyKey: "audit-grant" }),
		});
		await app.request(`/support/workspaces/${WS}/plan-change`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "pro", reason: "r" }),
		});
		await app.request(`/support/workspaces/${WS}/refund`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 500, currency: "USD", reason: "r", dodoChargeId: CHARGE, idempotencyKey: "audit-refund" }),
		});
		const { entries } = await stores.gdpr.listAdminAudit({ limit: 100 });
		const supportEntries = entries.filter((e) => e.action.startsWith("admin.support."));
		expect(supportEntries.length).toBe(3);
		// Every support-console audit row carries the explicit actor role.
		for (const e of supportEntries) {
			expect(e.actorRole).toBe("admin");
		}
	});
});
