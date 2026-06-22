// AI-support OWNER-OPS — owner-decision endpoints (behavior tests, no Postgres).
//
// Drives the real createAdminSupportRouter mounted under createAdminRouter (so it
// goes through the SAME parent gates production uses), with in-memory stores
// injected. Proves the owner-ops guarantees:
//   * GET/approve/deny/modify are OWNER-ONLY (admin:roles.write): support, editor,
//     accountant, and even admin get 403; only owner reaches them.
//   * approve executes the bounded/idempotent grant ONCE (balance moves; a retry
//     does not double-grant) and is AUDITED as actor="owner".
//   * deny executes NOTHING.
//   * modify executes the OWNER's overridden amount.

import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createAdminRouter } from "../routes/admin.js";
import type { UserRole } from "../types/auth.js";
import { CreditService } from "../services/credits.js";
import { FileBillingStore } from "../services/billing-store.js";
import { FilePaymentTransactionsStore } from "../services/payment-transactions-store.js";
import { FileSupportTicketStore } from "../services/support-tickets.js";
import { FileOwnerDecisionStore } from "../services/support/owner-decisions-store.js";
import { createMemoryGdprStore } from "../services/gdpr.js";
import type { GdprStore } from "../services/gdpr.js";

function stubAuth(role: UserRole, userId = `stub-${role}`) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${role}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
}

interface Stores {
	creditService: CreditService;
	billing: FileBillingStore;
	paymentTransactionsStore: FilePaymentTransactionsStore;
	ticketStore: FileSupportTicketStore;
	ownerDecisionStore: FileOwnerDecisionStore;
	gdpr: GdprStore;
}

function freshStores(): Stores {
	return {
		creditService: new CreditService(undefined, undefined, { crossProcessSafe: false }),
		billing: new FileBillingStore(),
		paymentTransactionsStore: new FilePaymentTransactionsStore(),
		ticketStore: new FileSupportTicketStore(),
		ownerDecisionStore: new FileOwnerDecisionStore(),
		gdpr: createMemoryGdprStore(),
	};
}

function appAs(role: UserRole, stores: Stores, userId?: string): Hono {
	const app = new Hono();
	const deps = {
		workspaceAccess: null,
		billing: stores.billing,
		gdpr: stores.gdpr,
		authMiddleware: stubAuth(role, userId),
		creditService: stores.creditService,
		paymentTransactionsStore: stores.paymentTransactionsStore,
		ticketStore: stores.ticketStore,
		ownerDecisionStore: stores.ownerDecisionStore,
	} as unknown as Parameters<typeof createAdminRouter>[0];
	app.route("/", createAdminRouter(deps));
	return app;
}

// Seed a PENDING owner-review grant_credit case (e.g. a grant above the auto cap).
async function seedPendingGrant(stores: Stores, opts: { workspaceId: string; userId: string; amountCents: number }) {
	const { record } = await stores.ownerDecisionStore.createDecision({
		ticketId: "ticket-1",
		userId: opts.userId,
		action: "grant_credit",
		params: { workspaceId: opts.workspaceId, reason: "over cap" },
		evidence: { verifiedDiscrepancyCents: opts.amountCents, hasSucceededPayment: true, currency: "USD" },
		recommendation: "Customer paid but credits did not arrive.",
		decision: "owner_pending",
		reason: "owner_grant_over_cap",
		decidedBy: "ai",
		amountCents: opts.amountCents,
		currency: "USD",
	});
	return record;
}

// Seed a PENDING owner-review case for a NON-grant action (refund / plan_change).
// These are the actions the owner-ops surface records but does NOT auto-execute.
async function seedPendingNonGrant(
	stores: Stores,
	opts: { action: "refund" | "plan_change"; workspaceId: string; userId: string; amountCents?: number },
) {
	const { record } = await stores.ownerDecisionStore.createDecision({
		ticketId: `ticket-${opts.action}`,
		userId: opts.userId,
		action: opts.action,
		params: { workspaceId: opts.workspaceId, reason: opts.action === "refund" ? "duplicate charge" : "downgrade" },
		evidence: { hasSucceededPayment: true, currency: "USD" },
		recommendation: opts.action === "refund" ? "Customer was double-charged." : "Customer requests plan change.",
		decision: "owner_pending",
		reason: `owner_${opts.action}`,
		decidedBy: "ai",
		amountCents: opts.amountCents,
		currency: "USD",
	});
	return record;
}

describe("owner-ops endpoints — OWNER-ONLY gating", () => {
	let stores: Stores;
	beforeEach(() => { stores = freshStores(); });

	test("non-owner roles are FORBIDDEN from the owner queue + decisions (admin/support/accountant/editor → 403)", async () => {
		for (const role of ["admin", "support", "accountant", "editor"] as UserRole[]) {
			const app = appAs(role, stores);
			const list = await app.request("/support/owner/decisions");
			// editor lacks admin:access entirely (403 at the parent gate); the rest hold
			// SUPPORT_READ/ACCESS but lack admin:roles.write → 403 at the owner gate.
			expect(list.status).toBe(403);
		}
	});

	test("owner CAN read the pending queue", async () => {
		await seedPendingGrant(stores, { workspaceId: "ws1", userId: "cust-1", amountCents: 1800 });
		const app = appAs("owner", stores);
		const res = await app.request("/support/owner/decisions");
		expect(res.status).toBe(200);
		const body = await res.json() as { decisions: Array<{ id: string; decision: string }> };
		expect(body.decisions.length).toBe(1);
		expect(body.decisions[0]!.decision).toBe("owner_pending");
	});
});

describe("owner-ops endpoints — approve / deny / modify", () => {
	let stores: Stores;
	beforeEach(() => { stores = freshStores(); });

	test("owner APPROVE executes the grant ONCE (idempotent) and audits actor=owner", async () => {
		const rec = await seedPendingGrant(stores, { workspaceId: "ws-approve", userId: "cust-a", amountCents: 1800 }); // 200 credits @ 9¢/credit
		const app = appAs("owner", stores, "owner-1");

		const res = await app.request(`/support/owner/decisions/${rec.id}/approve`, { method: "POST" });
		expect(res.status).toBe(200);
		// 1800 / 9 = 200 personal credits minted into the workspace for the user.
		expect(stores.creditService.getBalance("member", "cust-a", "ws-approve").personal).toBe(200);

		// Retry the SAME approve → no double-grant (already settled + idempotent grant key).
		const retry = await app.request(`/support/owner/decisions/${rec.id}/approve`, { method: "POST" });
		expect(retry.status).toBe(200);
		const retryBody = await retry.json() as { alreadySettled?: boolean };
		expect(retryBody.alreadySettled).toBe(true);
		expect(stores.creditService.getBalance("member", "cust-a", "ws-approve").personal).toBe(200);

		// Audited as actor="owner".
		const audit = await stores.gdpr.listAdminAudit({ action: "admin.support.owner_decision.approve" });
		expect(audit.entries.length).toBe(1);
		expect(audit.entries[0]!.actorRole).toBe("owner");

		// The decision row is now owner_approved with an executed_ref.
		const after = await stores.ownerDecisionStore.getById(rec.id);
		expect(after!.decision).toBe("owner_approved");
		expect(after!.executedRef).toBeTruthy();
	});

	test("owner DENY executes NOTHING", async () => {
		const rec = await seedPendingGrant(stores, { workspaceId: "ws-deny", userId: "cust-d", amountCents: 1800 });
		const app = appAs("owner", stores, "owner-1");

		const res = await app.request(`/support/owner/decisions/${rec.id}/deny`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(stores.creditService.getBalance("member", "cust-d", "ws-deny").personal).toBe(0);
		const after = await stores.ownerDecisionStore.getById(rec.id);
		expect(after!.decision).toBe("owner_denied");
		expect(after!.executedRef).toBeFalsy();
	});

	test("owner MODIFY executes the OWNER's overridden amount", async () => {
		// AI proposed 1800 (200 credits); owner cuts it to 900 (100 credits).
		const rec = await seedPendingGrant(stores, { workspaceId: "ws-mod", userId: "cust-m", amountCents: 1800 });
		const app = appAs("owner", stores, "owner-1");

		const res = await app.request(`/support/owner/decisions/${rec.id}/modify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountCents: 900, reason: "partial goodwill" }),
		});
		expect(res.status).toBe(200);
		// 900 / 9 = 100 credits (the MODIFIED amount, not the proposed 200).
		expect(stores.creditService.getBalance("member", "cust-m", "ws-mod").personal).toBe(100);
		const after = await stores.ownerDecisionStore.getById(rec.id);
		expect(after!.decision).toBe("owner_approved");
		expect(after!.amountCents).toBe(900);
	});

	test("approve on a missing decision → 404", async () => {
		const app = appAs("owner", stores, "owner-1");
		const res = await app.request(`/support/owner/decisions/does-not-exist/approve`, { method: "POST" });
		expect(res.status).toBe(404);
	});

	// ── P1 #4: approving a refund / plan_change must NOT report a fake success. ──
	// The owner-ops surface cannot itself execute these (they go through the
	// dedicated REFUND_WRITE / SUPPORT_ADJUST tools), so the approval must surface
	// an honest executionPending state — never a silent no-op dressed as "done".
	test("approve REFUND records the decision but returns executionPending (no money moves here)", async () => {
		const rec = await seedPendingNonGrant(stores, { action: "refund", workspaceId: "ws-rf", userId: "cust-rf", amountCents: 1999 });
		const app = appAs("owner", stores, "owner-1");

		const res = await app.request(`/support/owner/decisions/${rec.id}/approve`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json() as {
			ok: boolean;
			executedRef: string | null;
			executionPending: boolean;
			followUp?: { action: string; route: string | null; permission: string | null };
			decision: { decision: string; executionPending: boolean };
		};
		// Honest signal: approved + recorded, but NOT executed here.
		expect(body.ok).toBe(true);
		expect(body.executionPending).toBe(true);
		expect(body.executedRef).toBeNull();
		expect(body.followUp?.action).toBe("refund");
		expect(body.followUp?.permission).toBe("REFUND_WRITE");
		expect(body.followUp?.route).toContain("/refund");

		// NO refund row was written by the owner-ops surface (no fabricated money out).
		const refunds = await stores.paymentTransactionsStore.listTransactions({ workspaceId: "ws-rf", kind: "refund" });
		expect(refunds.total).toBe(0);

		// The persisted row is owner_approved WITHOUT an executed ref, and serializes
		// executionPending=true so the queue/detail UI shows "queued", not "done".
		const after = await stores.ownerDecisionStore.getById(rec.id);
		expect(after!.decision).toBe("owner_approved");
		expect(after!.executedRef).toBeFalsy();
		expect(body.decision.executionPending).toBe(true);
	});

	test("approve PLAN_CHANGE returns executionPending with a SUPPORT_ADJUST follow-up", async () => {
		const rec = await seedPendingNonGrant(stores, { action: "plan_change", workspaceId: "ws-pc", userId: "cust-pc" });
		const app = appAs("owner", stores, "owner-1");

		const res = await app.request(`/support/owner/decisions/${rec.id}/approve`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json() as {
			executionPending: boolean;
			executedRef: string | null;
			followUp?: { action: string; permission: string | null };
		};
		expect(body.executionPending).toBe(true);
		expect(body.executedRef).toBeNull();
		expect(body.followUp?.action).toBe("plan_change");
		expect(body.followUp?.permission).toBe("SUPPORT_ADJUST");

		const after = await stores.ownerDecisionStore.getById(rec.id);
		expect(after!.decision).toBe("owner_approved");
		expect(after!.executedRef).toBeFalsy();
	});

	test("approve GRANT is NOT pending — it executes inline (executedRef set, executionPending=false)", async () => {
		const rec = await seedPendingGrant(stores, { workspaceId: "ws-grant-pending", userId: "cust-gp", amountCents: 1800 });
		const app = appAs("owner", stores, "owner-1");
		const res = await app.request(`/support/owner/decisions/${rec.id}/approve`, { method: "POST" });
		const body = await res.json() as { executionPending: boolean; executedRef: string | null };
		expect(body.executionPending).toBe(false);
		expect(body.executedRef).toBeTruthy();
	});
});

// Approve a seeded pending grant so the row is owner_approved with a real grant
// executed_ref — the precondition for a clawback.
async function seedExecutedGrant(stores: Stores, opts: { workspaceId: string; userId: string; amountCents: number }) {
	const rec = await seedPendingGrant(stores, opts);
	const app = appAs("owner", stores, "owner-1");
	const res = await app.request(`/support/owner/decisions/${rec.id}/approve`, { method: "POST" });
	expect(res.status).toBe(200);
	return rec;
}

describe("owner-ops — CLAWBACK", () => {
	let stores: Stores;
	beforeEach(() => { stores = freshStores(); });

	test("clawback is OWNER-ONLY (admin/support/accountant → 403)", async () => {
		const rec = await seedExecutedGrant(stores, { workspaceId: "ws-cb", userId: "cust-cb", amountCents: 1800 });
		for (const role of ["admin", "support", "accountant"] as UserRole[]) {
			const app = appAs(role, stores);
			const res = await app.request(`/support/owner/decisions/${rec.id}/clawback`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "erroneous" }),
			});
			expect(res.status).toBe(403);
		}
		// Balance untouched by the forbidden attempts (still 200 credits).
		expect(stores.creditService.getBalance("member", "cust-cb", "ws-cb").personal).toBe(200);
	});

	test("clawback reverses EXACTLY the granted amount, once (idempotent), audited actor=owner", async () => {
		const rec = await seedExecutedGrant(stores, { workspaceId: "ws-cb2", userId: "cust-cb2", amountCents: 1800 }); // 200 credits @ 9¢/credit
		expect(stores.creditService.getBalance("member", "cust-cb2", "ws-cb2").personal).toBe(200);
		const app = appAs("owner", stores, "owner-1");

		const res = await app.request(`/support/owner/decisions/${rec.id}/clawback`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "AI erred" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { reversedCredits: number; unrecoverableCredits: number; decision: { decision: string } };
		expect(body.reversedCredits).toBe(200);
		expect(body.unrecoverableCredits).toBe(0);
		expect(body.decision.decision).toBe("clawed_back");
		// Exactly the granted amount deducted back → balance now 0.
		expect(stores.creditService.getBalance("member", "cust-cb2", "ws-cb2").personal).toBe(0);

		// Idempotent: a retry deducts nothing more and reports alreadyClawedBack.
		const retry = await app.request(`/support/owner/decisions/${rec.id}/clawback`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "AI erred" }),
		});
		expect(retry.status).toBe(200);
		const retryBody = await retry.json() as { alreadyClawedBack: boolean };
		expect(retryBody.alreadyClawedBack).toBe(true);
		expect(stores.creditService.getBalance("member", "cust-cb2", "ws-cb2").personal).toBe(0);

		// Audited as actor="owner" EXACTLY once — the idempotent retry is not re-audited.
		const audit = await stores.gdpr.listAdminAudit({ action: "admin.support.owner_decision.clawback" });
		expect(audit.entries.length).toBe(1);
		expect(audit.entries[0]!.actorRole).toBe("owner");

		const after = await stores.ownerDecisionStore.getById(rec.id);
		expect(after!.decision).toBe("clawed_back");
	});

	test("clawback handles an ALREADY-SPENT grant gracefully (clamps to available)", async () => {
		const rec = await seedExecutedGrant(stores, { workspaceId: "ws-cb3", userId: "cust-cb3", amountCents: 1800 }); // 200 credits @ 9¢/credit
		// Customer spends 150 of the 200 granted credits.
		await stores.creditService.consume("ws-cb3", "cust-cb3", 150, "ai_job", "job-1");
		expect(stores.creditService.getBalance("member", "cust-cb3", "ws-cb3").personal).toBe(50);
		const app = appAs("owner", stores, "owner-1");

		const res = await app.request(`/support/owner/decisions/${rec.id}/clawback`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "spent some" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { reversedCredits: number; unrecoverableCredits: number };
		// Only the unspent 50 can be reversed; the spent 150 is unrecoverable (no debt).
		expect(body.reversedCredits).toBe(50);
		expect(body.unrecoverableCredits).toBe(150);
		// Balance floored at 0 (never negative).
		expect(stores.creditService.getBalance("member", "cust-cb3", "ws-cb3").personal).toBe(0);
	});

	test("clawback of a non-grant / never-executed decision is rejected", async () => {
		// A pending (never-executed) grant cannot be clawed back.
		const pending = await seedPendingGrant(stores, { workspaceId: "ws-cb4", userId: "cust-cb4", amountCents: 5600 });
		const app = appAs("owner", stores, "owner-1");
		const res = await app.request(`/support/owner/decisions/${pending.id}/clawback`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "x" }),
		});
		expect(res.status).toBe(409);
	});

	test("clawback on a missing decision → 404", async () => {
		const app = appAs("owner", stores, "owner-1");
		const res = await app.request(`/support/owner/decisions/nope/clawback`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "x" }),
		});
		expect(res.status).toBe(404);
	});

	test("FAIL-CLOSED: a reversal whose AUDIT cannot be written returns 500 (not a silent ok) and reverts", async () => {
		const rec = await seedExecutedGrant(stores, { workspaceId: "ws-cb-fc", userId: "cust-cb-fc", amountCents: 1800 }); // 200 credits @ 9¢/credit
		expect(stores.creditService.getBalance("member", "cust-cb-fc", "ws-cb-fc").personal).toBe(200);

		// Make the admin-audit write fail ONLY for the clawback action.
		let failAudit = true;
		const realRecord = stores.gdpr.recordAdminAudit.bind(stores.gdpr);
		stores.gdpr.recordAdminAudit = (async (input: Parameters<GdprStore["recordAdminAudit"]>[0]) => {
			if (failAudit && input.action === "admin.support.owner_decision.clawback") {
				throw new Error("audit DB down");
			}
			return realRecord(input);
		}) as GdprStore["recordAdminAudit"];

		const app = appAs("owner", stores, "owner-1");
		const res = await app.request(`/support/owner/decisions/${rec.id}/clawback`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "AI erred" }),
		});
		// A money reversal must never report a clean success without an audit trail.
		expect(res.status).toBe(500);
		const body = await res.json() as { code: string };
		expect(body.code).toBe("clawback_audit_failed");
		// Reverted to the prior executed state so the retry re-runs the full path.
		const after = await stores.ownerDecisionStore.getById(rec.id);
		expect(after!.decision).toBe("owner_approved");
		expect(after!.params.clawback).toBeUndefined();
		// No clawback audit row was written.
		expect((await stores.gdpr.listAdminAudit({ action: "admin.support.owner_decision.clawback" })).entries.length).toBe(0);

		// Retry once audit recovers: succeeds, reverses ONCE (idempotent), audits ONCE.
		failAudit = false;
		const retry = await app.request(`/support/owner/decisions/${rec.id}/clawback`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "AI erred" }),
		});
		expect(retry.status).toBe(200);
		const retryBody = await retry.json() as { reversedCredits: number; alreadyClawedBack: boolean };
		expect(retryBody.alreadyClawedBack).toBe(false);
		expect(retryBody.reversedCredits).toBe(200);
		expect(stores.creditService.getBalance("member", "cust-cb-fc", "ws-cb-fc").personal).toBe(0);
		expect((await stores.gdpr.listAdminAudit({ action: "admin.support.owner_decision.clawback" })).entries.length).toBe(1);
		expect((await stores.ownerDecisionStore.getById(rec.id))!.decision).toBe("clawed_back");
	});
});

describe("owner-ops — DAILY DIGEST", () => {
	let stores: Stores;
	beforeEach(() => { stores = freshStores(); });

	test("digest is OWNER-ONLY (admin/support → 403)", async () => {
		for (const role of ["admin", "support"] as UserRole[]) {
			const app = appAs(role, stores);
			const res = await app.request(`/support/owner/digest`);
			expect(res.status).toBe(403);
		}
	});

	test("digest returns correct per-day aggregates", async () => {
		// Seed a spread of decisions (all created 'today'). The auto-grant amount is in
		// credit-equivalent cents at the 9-satang sale rate: 900 == 100 credits, matching
		// the clawback seed below (and the single THB_PER_CREDIT=0.85 knob).
		await stores.ownerDecisionStore.createDecision({
			userId: "u1", action: "grant_credit", decision: "auto_approved", amountCents: 900,
			executedRef: "g-auto-1", idempotencyKey: "k-auto-1",
		});
		await stores.ownerDecisionStore.createDecision({
			userId: "u2", action: "grant_credit", decision: "owner_pending", amountCents: 1800, idempotencyKey: "k-pend-1",
		});
		await stores.ownerDecisionStore.createDecision({
			userId: "u3", action: "refund", decision: "owner_denied", amountCents: 9999, idempotencyKey: "k-deny-1",
		});
		await stores.ownerDecisionStore.createDecision({
			userId: "u4", action: "grant_credit", decision: "denied", amountCents: 0, idempotencyKey: "k-gate-deny-1",
		});
		// One clawback (seed executed → claw back).
		const rec = await seedExecutedGrant(stores, { workspaceId: "ws-d", userId: "u5", amountCents: 900 }); // 100 credits
		const appOwner = appAs("owner", stores, "owner-1");
		await appOwner.request(`/support/owner/decisions/${rec.id}/clawback`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "erroneous" }),
		});

		const res = await appOwner.request(`/support/owner/digest`);
		expect(res.status).toBe(200);
		const { digest } = await res.json() as { digest: {
			autoGrants: { count: number; totalCents: number };
			ownerPending: number; ownerApproved: number; ownerDenied: number;
			clawedBack: { count: number; totalCentsReversed: number };
			denied: number; escalations: number; totalDecisions: number;
		} };
		expect(digest.autoGrants.count).toBe(1);
		expect(digest.autoGrants.totalCents).toBe(900);
		expect(digest.ownerPending).toBe(1);
		expect(digest.ownerDenied).toBe(1);
		expect(digest.denied).toBe(1);
		expect(digest.clawedBack.count).toBe(1);
		expect(digest.clawedBack.totalCentsReversed).toBe(900); // 100 credits × 9
		// The seeded executed grant was owner_approved before clawback; after clawback
		// it is clawed_back, so ownerApproved counts only non-clawed approvals (0 here).
		expect(digest.ownerApproved).toBe(0);
		// Escalations = pending + approved + denied (the owner-routed cases).
		expect(digest.escalations).toBe(1 + 0 + 1);
		// 4 explicit createDecision rows + 1 from seedExecutedGrant (which itself only
		// inserts one row, then approves + claws it back in place) = 5 total.
		expect(digest.totalDecisions).toBe(5);
	});

	test("digest rejects a malformed date", async () => {
		const app = appAs("owner", stores, "owner-1");
		const res = await app.request(`/support/owner/digest?date=not-a-date`);
		expect(res.status).toBe(400);
	});

	test("digest for a day with no activity is all-zero", async () => {
		const app = appAs("owner", stores, "owner-1");
		const res = await app.request(`/support/owner/digest?date=2020-01-01`);
		expect(res.status).toBe(200);
		const { digest } = await res.json() as { digest: { totalDecisions: number; autoGrants: { count: number } } };
		expect(digest.totalDecisions).toBe(0);
		expect(digest.autoGrants.count).toBe(0);
	});
});
