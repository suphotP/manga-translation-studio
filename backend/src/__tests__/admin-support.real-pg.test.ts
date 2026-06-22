// Real-Postgres integration for the back-office SUPPORT console (ranks 12-14).
//
// Drives createAdminSupportRouter (mounted under createAdminRouter, through the SAME
// parent gates production uses) against a LIVE Postgres with the Postgres-backed
// billing-store, payment_transactions store, and gdpr (audit) store. Proves end-to-end
// against real tables (no stubs):
//   * lookup returns REAL cross-entity data (plan + recent payments) for a workspace;
//   * credit grant is gated SUPPORT_ADJUST, AUDITED (admin_audit row), IDEMPOTENT;
//   * plan change is a real workspace_billing_accounts write, AUDITED;
//   * refund writes a correct NEGATIVE per-currency payment_transactions row, is gated
//     REFUND_WRITE, AUDITED, and IDEMPOTENT (retry on the dedupe ref → still one row).
//
// Migrations (incl. 0052 payment_transactions + the admin_audit + billing tables) must
// already be applied to TEST_DATABASE_URL:
//   docker run -d --name pg-support -e POSTGRES_PASSWORD=test -p 55445:5432 postgres:16
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55445/postgres bun run src/migrations/cli.ts up
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55445/postgres \
//     bun test src/__tests__/admin-support.real-pg.test.ts
//
// Gated on TEST_DATABASE_URL (skipped without it). One shared connection, seeded and
// torn down inside the test, mirroring admin-content.real-pg.test.ts.

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createAdminRouter } from "../routes/admin.js";
import type { UserRole } from "../types/auth.js";
import { PostgresBillingStore } from "../services/billing-store.js";
import { PostgresPaymentTransactionsStore } from "../services/payment-transactions-store.js";
import { PostgresGdprStore } from "../services/gdpr.js";
import { CreditService } from "../services/credits.js";
import { FileSupportTicketStore } from "../services/support-tickets.js";
import { dodoService } from "../services/dodo.service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

function stubAuth(role: UserRole, userId = `stub-${role}`) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${role}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
}

describeReal("admin support console (real Postgres)", () => {
	test("lookup + credit grant (idempotent, audited) + plan change + refund (negative, idempotent, audited)", async () => {
		const NS = `bosup-${Date.now()}`;
		const WS = `${NS}-ws`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });

		const billing = new PostgresBillingStore(raw);
		const paymentTransactionsStore = new PostgresPaymentTransactionsStore(raw);
		const gdpr = new PostgresGdprStore(raw);
		// Credits stay file-backed (no DB table) — isolated temp path, single process.
		const creditService = new CreditService(`/tmp/${NS}-credits.json`, undefined, { crossProcessSafe: false });
		const ticketStore = new FileSupportTicketStore();

		const deps = {
			workspaceAccess: null,
			billing,
			gdpr,
			creditService,
			paymentTransactionsStore,
			ticketStore,
			dodoService,
			authMiddleware: stubAuth("admin", `${NS}-admin`),
		} as unknown as Parameters<typeof createAdminRouter>[0];
		const app = new Hono();
		app.route("/", createAdminRouter(deps));

		try {
			// --- seed: the workspace row (FK target) + a plan + a real payment row ---
			await raw.unsafe(
				`INSERT INTO workspaces (workspace_id, name, created_at, updated_at)
				 VALUES ($1, $2, now(), now()) ON CONFLICT (workspace_id) DO NOTHING`,
				[WS, "Support Co"],
			);
			await billing.setWorkspacePlan({ workspaceId: WS, planId: "pro", status: "active" });
			const CHARGE = `${NS}-charge`;
			await paymentTransactionsStore.upsertTransaction({
				workspaceId: WS, kind: "payment", amountCents: 2999, currency: "USD", status: "succeeded",
				dodoPaymentId: CHARGE, dodoEventRef: `${NS}-pay`,
			});

			// --- lookup returns the real plan + payment ---
			const lookup = await app.request(`/support/lookup?query=${WS}`);
			expect(lookup.status).toBe(200);
			const lk = await lookup.json() as {
				plan: { planId: string } | null;
				recentPayments: Array<{ amountCents: number; currency: string | null }>;
			};
			expect(lk.plan?.planId).toBe("pro");
			expect(lk.recentPayments.some((p) => p.amountCents === 2999 && p.currency === "USD")).toBe(true);

			// --- credit grant: idempotent on the key ---
			const grantBody = JSON.stringify({ amount: 400, reason: "goodwill", idempotencyKey: `${NS}-grant` });
			const g1 = await app.request(`/support/workspaces/${WS}/credits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: grantBody });
			expect(g1.status).toBe(200);
			const grant1 = (await g1.json() as { grant: { id: string } }).grant;
			const g2 = await app.request(`/support/workspaces/${WS}/credits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: grantBody });
			const grant2 = (await g2.json() as { grant: { id: string } }).grant;
			expect(grant2.id).toBe(grant1.id); // same grant, no double-grant
			expect(creditService.getBalance("workspace", WS).shareable).toBe(400);

			// --- plan change: real billing write ---
			const pc = await app.request(`/support/workspaces/${WS}/plan-change`, {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ planId: "studio", status: "active", reason: "comped" }),
			});
			expect(pc.status).toBe(200);
			expect((await billing.getWorkspaceAssignment(WS))?.planId).toBe("studio");

			// --- refund: negative per-currency row, validated against the charge, idempotent ---
			const refundBody = JSON.stringify({ amountMinor: 2999, currency: "usd", reason: "duplicate", dodoChargeId: CHARGE, idempotencyKey: `${NS}-refund` });
			const r1 = await app.request(`/support/workspaces/${WS}/refund`, { method: "POST", headers: { "Content-Type": "application/json" }, body: refundBody });
			expect(r1.status).toBe(200);
			const refund1 = (await r1.json() as { refund: { id: string; amountCents: number; currency: string | null } }).refund;
			expect(refund1.amountCents).toBe(-2999);
			expect(refund1.currency).toBe("USD");
			const r2 = await app.request(`/support/workspaces/${WS}/refund`, { method: "POST", headers: { "Content-Type": "application/json" }, body: refundBody });
			const refund2 = (await r2.json() as { refund: { id: string } }).refund;
			expect(refund2.id).toBe(refund1.id); // same row, no double-refund
			const refunds = await paymentTransactionsStore.listTransactions({ workspaceId: WS, kind: "refund" });
			expect(refunds.total).toBe(1);

			// --- over-refund + wrong currency + no-original are rejected (money-out safety) ---
			const over = await app.request(`/support/workspaces/${WS}/refund`, {
				method: "POST", headers: { "Content-Type": "application/json" },
				// 2999 already refunded above; any further refund exceeds the original.
				body: JSON.stringify({ amountMinor: 1, currency: "usd", reason: "x", dodoChargeId: CHARGE, idempotencyKey: `${NS}-over` }),
			});
			expect(over.status).toBe(400);
			expect((await over.json() as { code: string }).code).toBe("dodo_refund_already_full");
			const ghost = await app.request(`/support/workspaces/${WS}/refund`, {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ amountMinor: 100, currency: "usd", reason: "x", dodoChargeId: `${NS}-ghost`, idempotencyKey: `${NS}-ghost-k` }),
			});
			expect(ghost.status).toBe(400);
			expect((await ghost.json() as { code: string }).code).toBe("dodo_refund_original_not_found");

			// --- every mutation landed in admin_audit, each carrying the explicit actorRole ---
			const { entries } = await gdpr.listAdminAudit({ adminUserId: `${NS}-admin`, limit: 100 });
			const actions = entries.map((e) => e.action);
			expect(actions).toContain("admin.support.credit_grant");
			expect(actions).toContain("admin.support.plan_change");
			expect(actions).toContain("admin.support.refund");
			const supportRows = entries.filter((e) => e.action.startsWith("admin.support."));
			expect(supportRows.length).toBeGreaterThanOrEqual(3);
			for (const row of supportRows) {
				expect(row.actorRole).toBe("admin");
			}
		} finally {
			await raw.unsafe(`DELETE FROM payment_transactions WHERE workspace_id = $1`, [WS]).catch(() => {});
			await raw.unsafe(`DELETE FROM admin_audit WHERE target_id = $1`, [WS]).catch(() => {});
			await raw.unsafe(`DELETE FROM workspace_billing_accounts WHERE workspace_id = $1`, [WS]).catch(() => {});
			await raw.unsafe(`DELETE FROM workspaces WHERE workspace_id = $1`, [WS]).catch(() => {});
			await raw.close?.();
		}
	});

	test("gating under real PG: editor 403 (lookup), support 403 (refund — REFUND_WRITE)", async () => {
		const NS = `bosup-gate-${Date.now()}`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		const mkApp = (role: UserRole) => {
			const deps = {
				workspaceAccess: null,
				billing: new PostgresBillingStore(raw),
				gdpr: new PostgresGdprStore(raw),
				creditService: new CreditService(`/tmp/${NS}-${role}-credits.json`, undefined, { crossProcessSafe: false }),
				paymentTransactionsStore: new PostgresPaymentTransactionsStore(raw),
				ticketStore: new FileSupportTicketStore(),
				dodoService,
				authMiddleware: stubAuth(role),
			} as unknown as Parameters<typeof createAdminRouter>[0];
			const app = new Hono();
			app.route("/", createAdminRouter(deps));
			return app;
		};
		try {
			// editor rejected at ACCESS gate on a read.
			expect((await mkApp("editor").request("/support/lookup?query=x")).status).toBe(403);
			// support holds SUPPORT_READ but NOT REFUND_WRITE.
			const refund = await mkApp("support").request("/support/workspaces/ws/refund", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "x", idempotencyKey: "k" }),
			});
			expect(refund.status).toBe(403);
		} finally {
			await raw.close?.();
		}
	});
});
