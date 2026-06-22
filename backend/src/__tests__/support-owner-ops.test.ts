// AI-support OWNER-OPS — the orchestration layer (routeActionProposal) behavior.
//
// Proves the proposal → deterministic gate → act flow over VERIFIED data:
//   * verified discrepancy within caps → AUTO grant executes once + owner NOT
//     notified;
//   * refund → OWNER_REVIEW, NOTHING executes, owner notified, pending case created;
//   * over-cap grant → OWNER_REVIEW, NOTHING executes;
//   * prompt-injection (no verified discrepancy) → DENY, NOTHING executes;
//   * circuit-breaker volume in the window forces OWNER_REVIEW for an
//     otherwise-auto grant.
// All stores are in-memory/file and isolated per test; no model is involved.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CreditService } from "../services/credits.js";
import { FilePaymentTransactionsStore } from "../services/payment-transactions-store.js";
import { FilePaymentReconciliationStore } from "../services/support/payment-reconciliations-store.js";
import { FileOwnerDecisionStore, PostgresOwnerDecisionStore } from "../services/support/owner-decisions-store.js";
import {
	routeActionProposal,
	executeClawback,
	buildOwnerOpsDigest,
	parseDigestDate,
	ClawbackError,
	type RouteProposalContext,
} from "../services/support/owner-ops.js";
import type { SupportToolContext } from "../services/support/ai-tools.js";
import type { NotifyInput, NotifyResult } from "../services/notification-dispatch.js";
import { CENTS_PER_CREDIT } from "../services/plans.js";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "owner-ops-"));
	tempDirs.push(dir);
	return dir;
}

interface H {
	creditService: CreditService;
	paymentTxStore: FilePaymentTransactionsStore;
	reconciliationStore: FilePaymentReconciliationStore;
	decisionStore: FileOwnerDecisionStore;
	notifications: NotifyInput[];
}

function harness(): H {
	const dir = tempDir();
	return {
		creditService: new CreditService(join(dir, "credits.json"), 50, { crossProcessSafe: false }),
		paymentTxStore: new FilePaymentTransactionsStore(join(dir, "payments.json")),
		reconciliationStore: new FilePaymentReconciliationStore(join(dir, "recon.json")),
		decisionStore: new FileOwnerDecisionStore(join(dir, "decisions.json")),
		notifications: [],
	};
}

const USER = "cust-1";
const OWNER = { id: "owner-1", email: "owner@example.com", name: "Owner", role: "owner", isActive: true };

function ctx(h: H, workspaceId: string): RouteProposalContext {
	const toolCtx: SupportToolContext = {
		userId: USER,
		workspaceId,
		ticketId: "ticket-1",
		creditService: h.creditService,
		paymentTxStore: h.paymentTxStore,
		reconciliationStore: h.reconciliationStore,
	};
	const notify = async (input: NotifyInput): Promise<NotifyResult> => {
		h.notifications.push(input);
		return { inAppDelivered: true, emailAttempted: false, skipped: [] };
	};
	return {
		ticketId: "ticket-1",
		userId: USER,
		workspaceId,
		toolCtx,
		decisionStore: h.decisionStore,
		creditService: h.creditService,
		notify,
		listUsers: (async () => [OWNER]) as never,
	};
}

describe("owner-ops — verified auto grant", () => {
	let h: H;
	beforeEach(() => { h = harness(); });

	test("verified discrepancy within caps → AUTO grant executes once; owner NOT notified", async () => {
		const ws = "ws-auto";
		// credits-50 pack ($4 / 400 USD cents) bought but uncredited → owes the SKU's rebased 500
		// credits (4500 credit-equivalent cents, under the 1000-credit auto-grant cap) →
		// AUTO-approves EXACTLY the SKU-promised 500 credits.
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "p1", amountCents: 400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: USER, sku: "credits-50" } } });

		const out = await routeActionProposal({ action: "grant_credit", reason: "topup not credited" }, ctx(h, ws));
		expect(out.verdict).toBe("AUTO_APPROVE");
		expect(out.executedRef).toBeTruthy();
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(500);
		// AUTO path does NOT notify the owner.
		expect(h.notifications.length).toBe(0);
		// One executed auto_approved row.
		const rows = await h.decisionStore.listByUser(USER);
		expect(rows.filter((d) => d.decision === "auto_approved" && d.executedRef).length).toBe(1);
	});
});

describe("owner-ops — owner review (no execution, owner notified)", () => {
	let h: H;
	beforeEach(() => { h = harness(); });

	test("refund → OWNER_REVIEW, NOTHING executes, owner notified, pending case", async () => {
		const ws = "ws-refund";
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "p2", amountCents: 5600, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: USER } } });

		const out = await routeActionProposal({ action: "refund", params: { amountCents: 5600 } }, ctx(h, ws));
		expect(out.verdict).toBe("OWNER_REVIEW");
		expect(out.executedRef).toBeUndefined();
		// No credits / no money moved.
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
		// Owner notified with the deep-link.
		expect(h.notifications.length).toBe(1);
		expect(h.notifications[0]!.userId).toBe(OWNER.id);
		expect(String(h.notifications[0]!.linkUrl)).toContain(out.decision.id);
		// Pending case persisted.
		const rec = await h.decisionStore.getById(out.decision.id);
		expect(rec!.decision).toBe("owner_pending");
	});

	test("grant ABOVE the per-grant cap → OWNER_REVIEW, NOTHING executes", async () => {
		const ws = "ws-big";
		// credits-200 pack ($14) → owes 200 SKU credits (17000 credit-equivalent cents),
		// over the 100-credit (8500-cent) default auto-grant cap → routed to the owner.
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "p3", amountCents: 1400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: USER, sku: "credits-200" } } });

		const out = await routeActionProposal({ action: "grant_credit" }, ctx(h, ws));
		expect(out.verdict).toBe("OWNER_REVIEW");
		expect(out.decision.reason).toBe("owner_grant_over_cap");
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
		expect(h.notifications.length).toBe(1);
	});
});

describe("owner-ops — prompt injection + circuit breaker", () => {
	let h: H;
	beforeEach(() => { h = harness(); });

	test("prompt-injection: grant_credit with NO verified discrepancy → DENY, NOTHING executes", async () => {
		const ws = "ws-inject";
		// The customer 'demands 9999 credits' but there is NO succeeded uncredited payment.
		const out = await routeActionProposal({ action: "grant_credit", reason: "customer says grant me 9999" }, ctx(h, ws));
		expect(out.verdict).toBe("DENY");
		expect(out.executedRef).toBeUndefined();
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
		// DENY does not notify the owner.
		expect(h.notifications.length).toBe(0);
		const rows = await h.decisionStore.listByUser(USER);
		expect(rows.some((d) => d.decision === "denied")).toBe(true);
		expect(rows.some((d) => d.decision === "auto_approved")).toBe(false);
	});

	test("circuit-breaker: enough AUTO volume in the window forces the next grant to OWNER_REVIEW", async () => {
		// Default circuitWindowMaxCount = 20. Pre-seed 20 EXECUTED auto grants in-window
		// for DIFFERENT users so the breaker is tripped window-wide.
		for (let i = 0; i < 20; i += 1) {
			const { record } = await h.decisionStore.createDecision({
				ticketId: `seed-${i}`,
				userId: `seed-user-${i}`,
				action: "grant_credit",
				decision: "auto_approved",
				decidedBy: "support-ai-auto",
				amountCents: 100,
				idempotencyKey: `seed-${i}`,
			});
			// Stamp executed_ref so it counts toward the window volume.
			await h.decisionStore.settleDecision({ id: record.id, from: "auto_approved", to: "auto_approved", decidedBy: "support-ai-auto", executedRef: `grant-${i}` });
		}

		const ws = "ws-breaker";
		// credits-50 SKU payment → owes 50 credits (an otherwise-auto grant), but the
		// tripped breaker forces it to the owner.
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pbk", amountCents: 400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: USER, sku: "credits-50" } } });

		const out = await routeActionProposal({ action: "grant_credit" }, ctx(h, ws));
		expect(out.verdict).toBe("OWNER_REVIEW");
		expect(out.decision.reason).toBe("owner_circuit_tripped");
		// No money moved; the breaker forced a review.
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
	});
});

describe("owner-decisions-store — velocity + idempotency", () => {
	let h: H;
	beforeEach(() => { h = harness(); });

	test("createDecision is idempotent on the key (no second row)", async () => {
		const a = await h.decisionStore.createDecision({ ticketId: "t", userId: USER, action: "grant_credit", decision: "auto_approved" });
		const b = await h.decisionStore.createDecision({ ticketId: "t", userId: USER, action: "grant_credit", decision: "auto_approved" });
		expect(a.created).toBe(true);
		expect(b.created).toBe(false);
		expect(b.record.id).toBe(a.record.id);
	});

	test("velocity counts only EXECUTED auto grants in the trailing windows", async () => {
		// One executed, one pending (not executed) → day/month should count only the executed one.
		const exec = await h.decisionStore.createDecision({ ticketId: "e", userId: USER, action: "grant_credit", decision: "auto_approved", idempotencyKey: "e" });
		await h.decisionStore.settleDecision({ id: exec.record.id, from: "auto_approved", to: "auto_approved", decidedBy: "ai", executedRef: "g1" });
		await h.decisionStore.createDecision({ ticketId: "p", userId: USER, action: "grant_credit", decision: "owner_pending", idempotencyKey: "p" });

		const v = await h.decisionStore.getAutoGrantVelocity(USER);
		expect(v.dayCount).toBe(1);
		expect(v.monthCount).toBe(1);
	});
});

describe("owner-ops — clawback (service level)", () => {
	let h: H;
	beforeEach(() => { h = harness(); });

	// Seed an EXECUTED auto-grant: a decision row + the real credit grant it minted,
	// stamping the grant id onto executed_ref (what executeApprovedGrant does).
	async function seedExecutedAutoGrant(ws: string, credits: number) {
		const { record } = await h.decisionStore.createDecision({
			ticketId: "t-cb", userId: USER, action: "grant_credit", decision: "auto_approved",
			decidedBy: "support-ai-auto", amountCents: credits * CENTS_PER_CREDIT, idempotencyKey: "cb-1",
			params: { workspaceId: ws },
		});
		const grant = await h.creditService.grantCredits({
			workspaceId: ws, ownerScope: "user", ownerId: USER, creditClass: "personal",
			amount: credits, source: "goodwill", idempotencyKey: `support-decision:${record.id}`,
		});
		await h.decisionStore.settleDecision({ id: record.id, from: "auto_approved", to: "auto_approved", decidedBy: "support-ai-auto", executedRef: grant.id });
		return { record, grant };
	}

	test("reverses EXACTLY the granted amount once (idempotent)", async () => {
		const ws = "ws-cb-svc";
		const { record } = await seedExecutedAutoGrant(ws, 100);
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(100);

		const r = await executeClawback({ decisionId: record.id, reason: "erroneous", ownerUserId: "o1", creditService: h.creditService, decisionStore: h.decisionStore });
		expect(r.reversedCredits).toBe(100);
		expect(r.unrecoverableCredits).toBe(0);
		expect(r.alreadyClawedBack).toBe(false);
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
		const after = await h.decisionStore.getById(record.id);
		expect(after!.decision).toBe("clawed_back");

		// Idempotent: a retry deducts nothing more.
		const retry = await executeClawback({ decisionId: record.id, reason: "erroneous", ownerUserId: "o1", creditService: h.creditService, decisionStore: h.decisionStore });
		expect(retry.alreadyClawedBack).toBe(true);
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
	});

	test("clawback no longer counts toward auto-grant velocity / window", async () => {
		const ws = "ws-cb-vel";
		const { record } = await seedExecutedAutoGrant(ws, 100);
		// Before clawback: the executed auto-grant counts.
		expect((await h.decisionStore.getAutoGrantVelocity(USER)).dayCount).toBe(1);
		expect((await h.decisionStore.getAutoGrantWindowVolume(3600)).windowCount).toBe(1);
		await executeClawback({ decisionId: record.id, reason: "x", ownerUserId: "o1", creditService: h.creditService, decisionStore: h.decisionStore });
		// After: the row is clawed_back, so velocity + window drop it.
		expect((await h.decisionStore.getAutoGrantVelocity(USER)).dayCount).toBe(0);
		expect((await h.decisionStore.getAutoGrantWindowVolume(3600)).windowCount).toBe(0);
	});

	test("already-spent grant clamps the reversal (no debt)", async () => {
		const ws = "ws-cb-spent";
		const { record } = await seedExecutedAutoGrant(ws, 100);
		await h.creditService.consume(ws, USER, 70, "ai_job", "job-x");
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(30);
		const r = await executeClawback({ decisionId: record.id, reason: "x", ownerUserId: "o1", creditService: h.creditService, decisionStore: h.decisionStore });
		expect(r.reversedCredits).toBe(30);
		expect(r.unrecoverableCredits).toBe(70);
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
	});

	test("a never-executed / non-grant decision cannot be clawed back", async () => {
		const pending = await h.decisionStore.createDecision({ userId: USER, action: "grant_credit", decision: "owner_pending", idempotencyKey: "pend-cb" });
		await expect(executeClawback({ decisionId: pending.record.id, reason: "x", ownerUserId: "o1", creditService: h.creditService, decisionStore: h.decisionStore })).rejects.toBeInstanceOf(ClawbackError);
	});

	test("CONCURRENT clawback of the same decision reverses ONCE, audits ONCE; the loser returns alreadyClawedBack", async () => {
		const ws = "ws-cb-race";
		const { record } = await seedExecutedAutoGrant(ws, 100);
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(100);

		const audits: string[] = [];
		const run = () => executeClawback({
			decisionId: record.id,
			reason: "race",
			ownerUserId: "o1",
			creditService: h.creditService,
			decisionStore: h.decisionStore,
			auditReversal: async (o) => { audits.push(`${o.reversedCredits}:${o.unrecoverableCredits}`); },
		});
		// Fire the clawback twice concurrently (simulating a double-submit / retry).
		const [a, b] = await Promise.all([run(), run()]);

		// Exactly ONE winner reversed; the other is the idempotent already-clawed-back no-op.
		const winners = [a, b].filter((r) => !r.alreadyClawedBack);
		const losers = [a, b].filter((r) => r.alreadyClawedBack);
		expect(winners.length).toBe(1);
		expect(losers.length).toBe(1);
		expect(winners[0]!.reversedCredits).toBe(100);
		// The loser reports the recorded reversal without re-deducting.
		expect(losers[0]!.reversedCredits).toBe(100);
		// Reversed ONCE: balance is exactly 0 (not double-deducted) and ONE audit row.
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
		expect(audits.length).toBe(1);
		const after = await h.decisionStore.getById(record.id);
		expect(after!.decision).toBe("clawed_back");
	});

	test("audit is ALWAYS invoked on a successful (winning) reversal", async () => {
		const ws = "ws-cb-audit";
		const { record } = await seedExecutedAutoGrant(ws, 80);
		let audited: { reversedCredits: number; reversalRef: string } | null = null;
		const r = await executeClawback({
			decisionId: record.id, reason: "ok", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async (o) => { audited = { reversedCredits: o.reversedCredits, reversalRef: o.reversalRef }; },
		});
		expect(r.alreadyClawedBack).toBe(false);
		expect(audited).not.toBeNull();
		expect(audited!.reversedCredits).toBe(80);
		expect(audited!.reversalRef).toBe(r.reversalRef);
	});

	test("FAIL-CLOSED: when the audit throws, the transition never commits + throws (no silent unaudited reversal)", async () => {
		const ws = "ws-cb-failaudit";
		const { record } = await seedExecutedAutoGrant(ws, 100);
		// Audit runs INSIDE the atomic transition; if it throws the whole transition rolls
		// back → the op fails closed and the row never moves to clawed_back.
		await expect(executeClawback({
			decisionId: record.id, reason: "x", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => { throw new Error("audit store down"); },
		})).rejects.toMatchObject({ code: "clawback_audit_failed" });

		// The transition never committed → the row is still the prior executed state with
		// NO clawback marker, so a retry is a clean fresh attempt (no revert path needed).
		const after = await h.decisionStore.getById(record.id);
		expect(after!.decision).toBe("auto_approved");
		expect(after!.params.clawback).toBeUndefined();

		// Retry with a WORKING audit succeeds, reverses ONCE (idempotent grant reversal),
		// and the balance is exactly 0 (never double-deducted).
		let audited = 0;
		const retry = await executeClawback({
			decisionId: record.id, reason: "x", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => { audited += 1; },
		});
		expect(retry.alreadyClawedBack).toBe(false);
		expect(retry.reversedCredits).toBe(100);
		expect(audited).toBe(1);
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
		expect((await h.decisionStore.getById(record.id))!.decision).toBe("clawed_back");
	});

	// ── ATOMIC SINGLE-ATTEMPT: at-most-once reverse, one audit, no half-done state ─────

	// (a) CONCURRENCY: under Promise.all exactly ONE caller wins the atomic transition;
	// the net reverseGrant effect is ONCE and there is exactly ONE audit. The loser reads
	// the committed clawed_back row READ-ONLY (its own reverseGrant was an idempotent
	// no-op). We slow the FIRST reverse so both callers race past the (idempotent) reverse
	// into the single-winner-gate transition.
	test("CONCURRENT clawback → reverse net effect ONCE, one audit, exactly one winner; loser read-only", async () => {
		const ws = "ws-cb-concurrent";
		const { record } = await seedExecutedAutoGrant(ws, 100);
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(100);

		let reverseCalls = 0;
		const realReverse = h.creditService.reverseGrant.bind(h.creditService);
		const instrumented = Object.create(h.creditService) as CreditService;
		instrumented.reverseGrant = (async (grantId: string, reason: string) => {
			reverseCalls += 1;
			if (reverseCalls === 1) await new Promise<void>((r) => setTimeout(r, 5));
			return realReverse(grantId, reason);
		}) as CreditService["reverseGrant"];

		const audits: string[] = [];
		const run = () => executeClawback({
			decisionId: record.id, reason: "race", ownerUserId: "o1",
			creditService: instrumented, decisionStore: h.decisionStore,
			auditReversal: async (o) => { audits.push(`${o.reversedCredits}:${o.unrecoverableCredits}`); },
		});
		const [a, b] = await Promise.all([run(), run()]);

		const winners = [a, b].filter((r) => !r.alreadyClawedBack);
		const losers = [a, b].filter((r) => r.alreadyClawedBack);
		expect(winners.length).toBe(1);
		expect(losers.length).toBe(1);
		// reverseGrant is idempotent, so even if both callers invoke it the NET money effect
		// is one debit: the balance is exactly 0 (never double-deducted).
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
		// Exactly ONE audit — the audit runs only for the winner, inside the atomic txn.
		expect(audits.length).toBe(1);
		expect(winners[0]!.reversedCredits).toBe(100);
		// The loser reads the committed clawed_back row (its reverseGrant was a no-op).
		expect(losers[0]!.reversedCredits).toBe(100);
		const after = await h.decisionStore.getById(record.id);
		expect(after!.decision).toBe("clawed_back");
		// A committed clawed_back row ALWAYS carries its amounts (same atomic statement).
		expect((after!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);
	});

	test("FILE store never exposes clawed_back while the winning audit is still pending", async () => {
		const ws = "ws-cb-no-speculative-read";
		const { record, grant } = await seedExecutedAutoGrant(ws, 100);

		let releaseAudit!: () => void;
		let auditCompleted = false;
		const auditBlocker = new Promise<void>((release) => { releaseAudit = release; });
		let auditStarted!: () => void;
		const auditStartedSignal = new Promise<void>((resolve) => { auditStarted = resolve; });
		const first = executeClawback({
			decisionId: record.id, reason: "race", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => {
				auditStarted();
				await auditBlocker;
				auditCompleted = true;
			},
		});
		await auditStartedSignal;

		const duringAudit = await h.decisionStore.getById(record.id);
		expect(duringAudit!.decision).toBe("auto_approved");
		expect(duringAudit!.params.clawback).toBeUndefined();

		let secondSettled = false;
		const second = executeClawback({
			decisionId: record.id, reason: "race", ownerUserId: "o2",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => { throw new Error("loser must not audit"); },
		}).finally(() => { secondSettled = true; });

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(secondSettled).toBe(false);
		expect(auditCompleted).toBe(false);
		expect((await h.decisionStore.getById(record.id))!.decision).toBe("auto_approved");

		releaseAudit();
		const [winner, loser] = await Promise.all([first, second]);
		expect(winner.alreadyClawedBack).toBe(false);
		expect(loser.alreadyClawedBack).toBe(true);
		expect(loser.reversedCredits).toBe(100);
		expect(auditCompleted).toBe(true);

		const after = await h.decisionStore.getById(record.id);
		expect(after!.decision).toBe("clawed_back");
		expect((after!.params.clawback as { reversalRef?: string }).reversalRef).toBe(grant.id);
		const reversalLedgerRows = h.creditService.listLedger(ws).filter((entry) => entry.refId === `grant-reversal:${grant.id}`);
		expect(reversalLedgerRows.length).toBe(1);
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
	});

	test("FILE store concurrent audit failure rejects waiters and leaves the row un-clawed", async () => {
		const ws = "ws-cb-concurrent-audit-fail";
		const { record, grant } = await seedExecutedAutoGrant(ws, 100);

		let releaseAudit!: () => void;
		const auditBlocker = new Promise<void>((release) => { releaseAudit = release; });
		let auditStarted!: () => void;
		const auditStartedSignal = new Promise<void>((resolve) => { auditStarted = resolve; });
		const first = executeClawback({
			decisionId: record.id, reason: "race", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => {
				auditStarted();
				await auditBlocker;
				throw new Error("audit store down");
			},
		});
		await auditStartedSignal;

		let secondSettled = false;
		const second = executeClawback({
			decisionId: record.id, reason: "race", ownerUserId: "o2",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => { throw new Error("loser must not audit"); },
		}).finally(() => { secondSettled = true; });

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(secondSettled).toBe(false);
		expect((await h.decisionStore.getById(record.id))!.decision).toBe("auto_approved");

		releaseAudit();
		const [a, b] = await Promise.allSettled([first, second]);
		expect(a.status).toBe("rejected");
		expect(b.status).toBe("rejected");
		if (a.status === "rejected") expect(a.reason).toMatchObject({ code: "clawback_audit_failed" });
		if (b.status === "rejected") expect(b.reason).toMatchObject({ code: "clawback_audit_failed" });

		const afterFailure = await h.decisionStore.getById(record.id);
		expect(afterFailure!.decision).toBe("auto_approved");
		expect(afterFailure!.params.clawback).toBeUndefined();
		const reversalLedgerRows = h.creditService.listLedger(ws).filter((entry) => entry.refId === `grant-reversal:${grant.id}`);
		expect(reversalLedgerRows.length).toBe(1);

		let audited = 0;
		const retry = await executeClawback({
			decisionId: record.id, reason: "race", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => { audited += 1; },
		});
		expect(retry.alreadyClawedBack).toBe(false);
		expect(retry.reversedCredits).toBe(100);
		expect(audited).toBe(1);
		expect((await h.decisionStore.getById(record.id))!.decision).toBe("clawed_back");
		expect(h.creditService.listLedger(ws).filter((entry) => entry.refId === `grant-reversal:${grant.id}`).length).toBe(1);
	});

	// (b) A committed clawed_back row ALWAYS has its amounts AND was audited — proven by
	// construction: the amount-write and the audit are in the SAME atomic transition, so a
	// row is never observable in a half-done "amounts-but-no-audit" / "audit-but-no-amounts"
	// state. After a successful clawback, both the stored amounts and the one audit exist.
	test("ATOMIC: a committed clawed_back row always carries amounts AND was audited (single txn)", async () => {
		const ws = "ws-cb-atomic";
		const { record } = await seedExecutedAutoGrant(ws, 100);
		let audited = 0;
		const r = await executeClawback({
			decisionId: record.id, reason: "ok", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => { audited += 1; },
		});
		expect(r.alreadyClawedBack).toBe(false);
		expect(audited).toBe(1); // audited exactly once, in the same transition that committed
		const after = await h.decisionStore.getById(record.id);
		expect(after!.decision).toBe("clawed_back");
		// The amounts landed in the SAME atomic statement as the state — never a partial row.
		expect((after!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);
		expect((after!.params.clawback as { unrecoverableCredits?: number }).unrecoverableCredits).toBe(0);
	});

	// (c) ALREADY clawed_back → subsequent calls are READ-ONLY and return the stored
	// result, no re-deduct, no re-audit. (Replaces the old FINALIZED read-only test.)
	test("ALREADY clawed_back → subsequent calls read-only, return stored amounts, no re-deduct/re-audit", async () => {
		const ws = "ws-cb-already";
		const { record } = await seedExecutedAutoGrant(ws, 100);
		await h.creditService.consume(ws, USER, 40, "ai_job", "job-fin"); // 60 unspent
		// First clawback: reverses 60, 40 unrecoverable.
		let audited = 0;
		const first = await executeClawback({
			decisionId: record.id, reason: "ok", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => { audited += 1; },
		});
		expect(first.alreadyClawedBack).toBe(false);
		expect(first.reversedCredits).toBe(60);
		expect(first.unrecoverableCredits).toBe(40);
		expect(audited).toBe(1);

		// Subsequent calls: read-only, exact stored amounts, no extra debit/audit. We
		// instrument reverseGrant to prove the read-only path never even calls it.
		let reverseCalls = 0;
		const realReverse = h.creditService.reverseGrant.bind(h.creditService);
		const instrumented = Object.create(h.creditService) as CreditService;
		instrumented.reverseGrant = (async (g: string, r: string) => { reverseCalls += 1; return realReverse(g, r); }) as CreditService["reverseGrant"];
		const second = await executeClawback({
			decisionId: record.id, reason: "ok", ownerUserId: "o1",
			creditService: instrumented, decisionStore: h.decisionStore,
			auditReversal: async () => { audited += 1; },
		});
		expect(second.alreadyClawedBack).toBe(true);
		expect(second.reversedCredits).toBe(60);
		expect(second.unrecoverableCredits).toBe(40);
		expect(reverseCalls).toBe(0); // read-only: never re-deducts
		expect(audited).toBe(1); // no re-audit
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(0);
	});

	// (d) PER-GRANT attribution + always-audited still hold: a clawback reverses ONLY this
	// grant's unspent remainder, never an unrelated later top-up, and always audits.
	test("PER-GRANT attribution: clawback never debits an unrelated later top-up; always audited", async () => {
		const ws = "ws-cb-attr";
		const { record } = await seedExecutedAutoGrant(ws, 100); // goodwill grant (clawback target)
		// Fully spend the goodwill grant, then add a separate personal top-up.
		await h.creditService.consume(ws, USER, 100, "ai_job", "job-spend");
		await h.creditService.grantCredits({
			workspaceId: ws, ownerScope: "user", ownerId: USER, creditClass: "personal",
			amount: 50, source: "topup", idempotencyKey: "topup-unrelated",
		});
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(50);

		let audited = 0;
		const r = await executeClawback({
			decisionId: record.id, reason: "erroneous", ownerUserId: "o1",
			creditService: h.creditService, decisionStore: h.decisionStore,
			auditReversal: async () => { audited += 1; },
		});
		// The goodwill grant was fully spent → nothing recoverable; the unrelated top-up is UNTOUCHED.
		expect(r.reversedCredits).toBe(0);
		expect(r.unrecoverableCredits).toBe(100);
		expect(audited).toBe(1); // always audited, even when 0 recovered
		expect(h.creditService.getBalance("member", USER, ws).personal).toBe(50);
	});

	// (e) FAIL-CLOSED at the STORE level: an audit throw inside the atomic transition
	// leaves the row NOT clawed_back (no half-done state to revert) — proven directly via
	// the store CAS. A retry with a working audit then commits cleanly.
	test("ATOMIC store: an audit throw rolls the transition back (row stays executed, no clawback marker)", async () => {
		const ws = "ws-cb-store-failclosed";
		const { record, grant } = await seedExecutedAutoGrant(ws, 100);
		const reversal = {
			reason: "x", reversalRef: grant.id, clawedBackAt: new Date().toISOString(),
			reversedCredits: 100, unrecoverableCredits: 0,
		};
		await expect(h.decisionStore.clawbackDecision({
			id: record.id, decidedBy: "owner:A", reversal,
			audit: async () => { throw new Error("audit store down"); },
		})).rejects.toThrow(/audit store down/);
		// The transition never committed: still executed, no clawback marker.
		const after = await h.decisionStore.getById(record.id);
		expect(after!.decision).toBe("auto_approved");
		expect(after!.params.clawback).toBeUndefined();

		// A clean retry (working audit) wins and commits atomically.
		let audited = 0;
		const ok = await h.decisionStore.clawbackDecision({
			id: record.id, decidedBy: "owner:A", reversal, audit: async () => { audited += 1; },
		});
		expect(ok.won).toBe(true);
		expect(ok.record!.decision).toBe("clawed_back");
		expect(audited).toBe(1);
		expect((ok.record!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);
	});

	// (f) STORE winner-gate: a duplicate transition on an already-clawed_back row is a
	// READ-ONLY no-op (won=false) that returns the committed row — never a second winner.
	test("ATOMIC store: a duplicate transition is a read-only no-op (won=false, returns committed row)", async () => {
		const ws = "ws-cb-store-dup";
		const { record, grant } = await seedExecutedAutoGrant(ws, 100);
		const reversal = {
			reason: "x", reversalRef: grant.id, clawedBackAt: new Date().toISOString(),
			reversedCredits: 100, unrecoverableCredits: 0,
		};
		const first = await h.decisionStore.clawbackDecision({ id: record.id, decidedBy: "owner:A", reversal });
		expect(first.won).toBe(true);
		expect(first.record!.decision).toBe("clawed_back");
		// Second call: the row is no longer eligible → won=false, returns the committed row.
		const second = await h.decisionStore.clawbackDecision({ id: record.id, decidedBy: "owner:B", reversal });
		expect(second.won).toBe(false);
		expect(second.record!.decision).toBe("clawed_back");
		expect((second.record!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);
	});
});

describe("owner-ops — daily digest builder", () => {
	let h: H;
	beforeEach(() => { h = harness(); });

	test("parseDigestDate: valid/invalid/today", () => {
		expect(parseDigestDate("2024-03-15")).toBe(Date.UTC(2024, 2, 15));
		expect(parseDigestDate("garbage")).toBeNull();
		expect(parseDigestDate("2024-13-40")).not.toBeNull(); // Date.UTC wraps; format is the gate
		const today = parseDigestDate(undefined, () => Date.UTC(2024, 5, 10, 14, 30));
		expect(today).toBe(Date.UTC(2024, 5, 10));
	});

	test("aggregates per-day counts + AI token spend windowing", async () => {
		const day = Date.UTC(2024, 5, 1); // 2024-06-01
		// Seed rows; createdAt is set to 'now' by the store, so build the digest for
		// 'today' (the harness clock) — assert relative counts independent of date.
		await h.decisionStore.createDecision({ userId: "a", action: "grant_credit", decision: "auto_approved", amountCents: 5600, executedRef: "g1", idempotencyKey: "d-a" });
		await h.decisionStore.createDecision({ userId: "b", action: "grant_credit", decision: "auto_approved", amountCents: 2800, executedRef: "g2", idempotencyKey: "d-b" });
		await h.decisionStore.createDecision({ userId: "c", action: "refund", decision: "owner_pending", amountCents: 9999, idempotencyKey: "d-c" });
		await h.decisionStore.createDecision({ userId: "d", action: "grant_credit", decision: "denied", idempotencyKey: "d-d" });

		// Stub the AI-token meter: spend-since-dayStart=12.5 THB, spend-since-dayEnd=2 THB
		// → the bounded day spend is 10.5 THB.
		let call = 0;
		const sumAiTokensThb = async (_startMs: number): Promise<number> => (call++ === 0 ? 12.5 : 2);

		const digest = await buildOwnerOpsDigest({ dayStartMs: Date.now(), decisionStore: h.decisionStore, sumAiTokensThb });
		expect(digest.autoGrants.count).toBe(2);
		expect(digest.autoGrants.totalCents).toBe(5600 + 2800);
		expect(digest.ownerPending).toBe(1);
		expect(digest.denied).toBe(1);
		expect(digest.totalDecisions).toBe(4);
		expect(digest.aiTokenSpendThb).toBe(10.5);
		// A day far in the past (no rows that day) → all zero, and the date echoes back.
		const empty = await buildOwnerOpsDigest({ dayStartMs: day, decisionStore: h.decisionStore, sumAiTokensThb: async () => 0 });
		expect(empty.totalDecisions).toBe(0);
		expect(empty.date).toBe("2024-06-01");
	});
});

// ── Real Postgres: the owner-decision store against actual SQL (migration 0060) ──
// Proves the jsonb round-trip, the pending-queue/velocity/window queries, and the
// guarded settleDecision UPDATE (the array-literal ANY() that makes a retried
// owner-approve a no-op) all behave on real Postgres, not just the file fake.
//
//   RECON_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres \
//     bun test support-owner-ops
const PG_URL = process.env.RECON_TEST_DATABASE_URL?.trim();
const describePg = PG_URL ? describe : describe.skip;

describePg("owner-decisions-store — real Postgres (0060)", () => {
	const sql = new Bun.SQL(PG_URL as string);
	const store = new PostgresOwnerDecisionStore(sql as never);

	beforeEach(async () => { await sql.unsafe("DELETE FROM support_decisions"); });
	afterAll(async () => { await sql.unsafe("DELETE FROM support_decisions"); await sql.close?.(); });

	// ticketId is omitted: support_decisions.ticket_id FK → support_tickets(id), and
	// these store-level tests don't seed tickets. The decision store works ticket-less
	// (the explicit idempotency key keeps each proposal distinct).
	test("createDecision persists jsonb + is idempotent on the key", async () => {
		const a = await store.createDecision({
			userId: "u-pg", action: "grant_credit", idempotencyKey: "k-pg",
			params: { workspaceId: "ws", reason: "x" },
			evidence: { verifiedDiscrepancyCents: 5600, currency: "USD", hasSucceededPayment: true },
			decision: "owner_pending", amountCents: 5600, currency: "USD", reason: "owner_grant_over_cap",
		});
		expect(a.created).toBe(true);
		// jsonb round-trips to objects.
		expect((a.record.evidence as { verifiedDiscrepancyCents?: number }).verifiedDiscrepancyCents).toBe(5600);
		const b = await store.createDecision({ userId: "u-pg", action: "grant_credit", idempotencyKey: "k-pg", decision: "owner_pending" });
		expect(b.created).toBe(false);
		expect(b.record.id).toBe(a.record.id);

		const pending = await store.listPending();
		expect(pending.length).toBe(1);
	});

	test("settleDecision is a guarded one-shot transition (retry is a no-op)", async () => {
		const { record } = await store.createDecision({ userId: "u2", action: "grant_credit", idempotencyKey: "k-settle", decision: "owner_pending", amountCents: 5600 });
		const first = await store.settleDecision({ id: record.id, from: "owner_pending", to: "owner_approved", decidedBy: "owner:o1", executedRef: "grant-x" });
		expect(first!.decision).toBe("owner_approved");
		expect(first!.executedRef).toBe("grant-x");
		// A second attempt from owner_pending finds the row already terminal → null no-op.
		const second = await store.settleDecision({ id: record.id, from: "owner_pending", to: "owner_denied", decidedBy: "owner:o1" });
		expect(second).toBeNull();
		const after = await store.getById(record.id);
		expect(after!.decision).toBe("owner_approved");
	});

	test("velocity + window aggregates count only EXECUTED auto grants", async () => {
		const exec = await store.createDecision({ userId: "uv", action: "grant_credit", decision: "auto_approved", amountCents: 100, idempotencyKey: "ve" });
		await store.settleDecision({ id: exec.record.id, from: "auto_approved", to: "auto_approved", decidedBy: "ai", executedRef: "g" });
		await store.createDecision({ userId: "uv", action: "grant_credit", decision: "owner_pending", idempotencyKey: "vp" });
		const v = await store.getAutoGrantVelocity("uv");
		expect(v.dayCount).toBe(1);
		const w = await store.getAutoGrantWindowVolume(3600);
		expect(w.windowCount).toBe(1);
		expect(w.windowCents).toBe(100);
	});

	test("clawbackDecision atomically transitions + stamps amounts in ONE statement", async () => {
		const exec = await store.createDecision({ userId: "ucb", action: "grant_credit", decision: "auto_approved", amountCents: 5600, idempotencyKey: "cb-pg", executedRef: "grant-pg" });
		await store.settleDecision({ id: exec.record.id, from: "auto_approved", to: "auto_approved", decidedBy: "ai", executedRef: "grant-pg" });
		// ONE atomic transition: state + final amounts land together (no separate finalize).
		const reversal = { reason: "erroneous", reversalRef: "grant-pg", clawedBackAt: new Date().toISOString(), reversedCredits: 100, unrecoverableCredits: 0 };
		const first = await store.clawbackDecision({ id: exec.record.id, decidedBy: "owner:o1", reversal });
		expect(first.won).toBe(true);
		expect(first.record!.decision).toBe("clawed_back");
		expect((first.record!.params.clawback as { reason?: string }).reason).toBe("erroneous");
		// A committed clawed_back row already carries its amounts (same statement).
		expect((first.record!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);
		// Retry of the transition → read-only no-op (already clawed_back) so it never wins twice.
		const retry = await store.clawbackDecision({ id: exec.record.id, decidedBy: "owner:o1", reversal });
		expect(retry.won).toBe(false);
		expect(retry.record!.decision).toBe("clawed_back");
		// A clawed-back grant no longer counts toward velocity.
		expect((await store.getAutoGrantVelocity("ucb")).dayCount).toBe(0);
	});

	test("clawbackDecision is atomic under CONCURRENCY (Promise.all) — exactly ONE winner", async () => {
		const exec = await store.createDecision({ userId: "uconc", action: "grant_credit", decision: "auto_approved", amountCents: 5600, idempotencyKey: "cb-conc", executedRef: "grant-conc" });
		await store.settleDecision({ id: exec.record.id, from: "auto_approved", to: "auto_approved", decidedBy: "ai", executedRef: "grant-conc" });
		const reversal = { reason: "race", reversalRef: "grant-conc", clawedBackAt: new Date().toISOString(), reversedCredits: 100, unrecoverableCredits: 0 };
		// Two concurrent atomic transitions race over the same row. The DB row-lock
		// serializes them: exactly ONE matches the eligible guard and wins (won=true); the
		// other sees clawed_back, matches 0 rows, and is a read-only no-op (won=false).
		const [a, b] = await Promise.all([
			store.clawbackDecision({ id: exec.record.id, decidedBy: "owner:o1", reversal }),
			store.clawbackDecision({ id: exec.record.id, decidedBy: "owner:o2", reversal }),
		]);
		const winners = [a, b].filter((r) => r.won);
		expect(winners.length).toBe(1);
		expect(winners[0]!.record!.decision).toBe("clawed_back");
		expect((await store.getById(exec.record.id))!.decision).toBe("clawed_back");
	});

	test("clawbackDecision audit runs INSIDE the txn; a throw rolls the whole transition back", async () => {
		const exec = await store.createDecision({ userId: "uaud", action: "grant_credit", decision: "auto_approved", amountCents: 5600, idempotencyKey: "cb-aud", executedRef: "grant-aud" });
		await store.settleDecision({ id: exec.record.id, from: "auto_approved", to: "auto_approved", decidedBy: "ai", executedRef: "grant-aud" });
		const reversal = { reason: "x", reversalRef: "grant-aud", clawedBackAt: new Date().toISOString(), reversedCredits: 100, unrecoverableCredits: 0 };
		// Audit throws inside the transaction → the guarded UPDATE is rolled back.
		await expect(store.clawbackDecision({
			id: exec.record.id, decidedBy: "owner:o1", reversal,
			audit: async () => { throw new Error("audit store down"); },
		})).rejects.toThrow(/audit store down/);
		// The real PG row is STILL the prior executed state — the transition never committed.
		const after = await store.getById(exec.record.id);
		expect(after!.decision).toBe("auto_approved");
		expect(after!.params.clawback).toBeUndefined();
		// A clean retry (working audit) wins + commits atomically.
		let audited = 0;
		const ok = await store.clawbackDecision({ id: exec.record.id, decidedBy: "owner:o1", reversal, audit: async () => { audited += 1; } });
		expect(ok.won).toBe(true);
		expect(ok.record!.decision).toBe("clawed_back");
		expect(audited).toBe(1);
		expect((ok.record!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);
	});

	test("listByCreatedWindow returns rows within the UTC-day bounds", async () => {
		await store.createDecision({ userId: "uw", action: "grant_credit", decision: "auto_approved", amountCents: 100, idempotencyKey: "win-1" });
		const now = Date.now();
		const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
		const within = await store.listByCreatedWindow(dayStart, dayStart + 86_400_000);
		expect(within.length).toBe(1);
		// A window far in the past has no rows.
		const past = await store.listByCreatedWindow(Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 2));
		expect(past.length).toBe(0);
	});

	// ── executeClawback state machine over the REAL Postgres store (true SQL row-lock
	// serialization, not the single-event-loop file fake) ───────────────────────────

	// Seed an EXECUTED auto-grant in the PG decision store + mint the real credit grant.
	async function seedPgExecutedGrant(creditSvc: CreditService, ws: string, credits: number, key: string) {
		const { record } = await store.createDecision({
			userId: USER, action: "grant_credit", decision: "auto_approved",
			decidedBy: "support-ai-auto", amountCents: credits * CENTS_PER_CREDIT, idempotencyKey: key,
			params: { workspaceId: ws },
		});
		const grant = await creditSvc.grantCredits({
			workspaceId: ws, ownerScope: "user", ownerId: USER, creditClass: "personal",
			amount: credits, source: "goodwill", idempotencyKey: `support-decision:${record.id}`,
		});
		await store.settleDecision({ id: record.id, from: "auto_approved", to: "auto_approved", decidedBy: "support-ai-auto", executedRef: grant.id });
		return { record, grant };
	}

	test("PG executeClawback: atomic happy path reverses once + commits clawed_back+amounts+audit", async () => {
		const credits = new CreditService(join(tempDir(), "pg-happy-credits.json"), 50, { crossProcessSafe: false });
		const ws = "ws-pg-happy";
		const { record } = await seedPgExecutedGrant(credits, ws, 100, "pg-happy");
		expect(credits.getBalance("member", USER, ws).personal).toBe(100);

		let audited = 0;
		const r = await executeClawback({
			decisionId: record.id, reason: "erroneous", ownerUserId: "o1",
			creditService: credits, decisionStore: store,
			auditReversal: async () => { audited += 1; },
		});
		expect(r.alreadyClawedBack).toBe(false);
		expect(r.reversedCredits).toBe(100);
		expect(audited).toBe(1);
		expect(credits.getBalance("member", USER, ws).personal).toBe(0);
		const after = await store.getById(record.id);
		expect(after!.decision).toBe("clawed_back");
		// Committed row carries its amounts (same atomic statement as the state).
		expect((after!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);

		// A retry is a read-only no-op: no second debit, no re-audit.
		const again = await executeClawback({
			decisionId: record.id, reason: "erroneous", ownerUserId: "o1",
			creditService: credits, decisionStore: store,
			auditReversal: async () => { audited += 1; },
		});
		expect(again.alreadyClawedBack).toBe(true);
		expect(again.reversedCredits).toBe(100);
		expect(audited).toBe(1); // no re-audit
		expect(credits.getBalance("member", USER, ws).personal).toBe(0);
	});

	test("PG concurrent executeClawback: net reverse ONCE, exactly ONE winner + ONE audit, loser read-only", async () => {
		const credits = new CreditService(join(tempDir(), "pg-conc-credits.json"), 50, { crossProcessSafe: false });
		const ws = "ws-pg-conc";
		const { record } = await seedPgExecutedGrant(credits, ws, 100, "pg-conc");
		expect(credits.getBalance("member", USER, ws).personal).toBe(100);

		const audits: number[] = [];
		const run = (owner: string) => executeClawback({
			decisionId: record.id, reason: "race", ownerUserId: owner,
			creditService: credits, decisionStore: store,
			auditReversal: async (o) => { audits.push(o.reversedCredits); },
		});
		const [a, b] = await Promise.all([run("o1"), run("o2")]);

		const winners = [a, b].filter((r) => !r.alreadyClawedBack);
		const losers = [a, b].filter((r) => r.alreadyClawedBack);
		expect(winners.length).toBe(1);
		expect(losers.length).toBe(1);
		// reverseGrant is idempotent → even if both callers invoke it, the NET money effect
		// is one debit: the balance is exactly 0 (never double-deducted).
		expect(credits.getBalance("member", USER, ws).personal).toBe(0);
		// Exactly ONE audit — the audit runs only for the winner, inside its atomic txn.
		expect(audits.length).toBe(1);
		expect(winners[0]!.reversedCredits).toBe(100);
		// Loser reads the committed clawed_back row (its reverseGrant was an idempotent no-op).
		expect(losers[0]!.reversedCredits).toBe(100);
		const after = await store.getById(record.id);
		expect(after!.decision).toBe("clawed_back");
		// The committed row always carries its amounts (same atomic statement as the state).
		expect((after!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);
	});

	test("PG already clawed_back → subsequent call read-only (stored amounts, no re-deduct/re-audit)", async () => {
		const credits = new CreditService(join(tempDir(), "pg-fin-credits.json"), 50, { crossProcessSafe: false });
		const ws = "ws-pg-fin";
		const { record } = await seedPgExecutedGrant(credits, ws, 100, "pg-fin");
		await credits.consume(ws, USER, 40, "ai_job", "job-pgfin"); // 60 unspent

		let audited = 0;
		const first = await executeClawback({ decisionId: record.id, reason: "ok", ownerUserId: "o1", creditService: credits, decisionStore: store, auditReversal: async () => { audited += 1; } });
		expect(first.reversedCredits).toBe(60);
		expect(first.unrecoverableCredits).toBe(40);
		expect(audited).toBe(1);

		let reverseCalls = 0;
		const realReverse = credits.reverseGrant.bind(credits);
		const instrumented = Object.create(credits) as CreditService;
		instrumented.reverseGrant = (async (g: string, r: string) => { reverseCalls += 1; return realReverse(g, r); }) as CreditService["reverseGrant"];
		const second = await executeClawback({ decisionId: record.id, reason: "ok", ownerUserId: "o1", creditService: instrumented, decisionStore: store, auditReversal: async () => { audited += 1; } });
		expect(second.alreadyClawedBack).toBe(true);
		expect(second.reversedCredits).toBe(60);
		expect(second.unrecoverableCredits).toBe(40);
		expect(reverseCalls).toBe(0);
		expect(audited).toBe(1);
		expect(credits.getBalance("member", USER, ws).personal).toBe(0);
	});

	// FAIL-CLOSED over REAL Postgres: an audit throw inside the atomic transition rolls
	// the whole transition back (true SQL ROLLBACK via begin()) — the row stays the prior
	// executed state with NO clawback marker. A clean retry then commits + reverses once.
	test("PG executeClawback FAIL-CLOSED: an audit throw rolls back the transition (no half-done state)", async () => {
		const credits = new CreditService(join(tempDir(), "pg-failclosed-credits.json"), 50, { crossProcessSafe: false });
		const ws = "ws-pg-failclosed";
		const { record } = await seedPgExecutedGrant(credits, ws, 100, "pg-failclosed");

		await expect(executeClawback({
			decisionId: record.id, reason: "x", ownerUserId: "o1",
			creditService: credits, decisionStore: store,
			auditReversal: async () => { throw new Error("audit store down"); },
		})).rejects.toMatchObject({ code: "clawback_audit_failed" });

		// The real PG row never moved (the guarded UPDATE rolled back) — no clawback marker.
		const after = await store.getById(record.id);
		expect(after!.decision).toBe("auto_approved");
		expect(after!.params.clawback).toBeUndefined();
		// reverseGrant ran (idempotent) but the balance reflects a single debit on retry.

		// Clean retry: working audit → commits atomically, reverses exactly once overall.
		let audited = 0;
		const retry = await executeClawback({
			decisionId: record.id, reason: "x", ownerUserId: "o1",
			creditService: credits, decisionStore: store,
			auditReversal: async () => { audited += 1; },
		});
		expect(retry.alreadyClawedBack).toBe(false);
		expect(retry.reversedCredits).toBe(100);
		expect(audited).toBe(1);
		expect(credits.getBalance("member", USER, ws).personal).toBe(0);
		expect((await store.getById(record.id))!.decision).toBe("clawed_back");
	});

	// PG store-level: the atomic transition is the single winner-gate. After a winner
	// commits, any further transition is a read-only no-op (won=false) — never a second
	// winner and never a state that can be reverted.
	test("PG store: once committed, a further clawbackDecision is a read-only no-op (no revert path)", async () => {
		const credits = new CreditService(join(tempDir(), "pg-winnergate-credits.json"), 50, { crossProcessSafe: false });
		const ws = "ws-pg-winnergate";
		const { record, grant } = await seedPgExecutedGrant(credits, ws, 100, "pg-winnergate");
		const reversal = { reason: "x", reversalRef: grant.id, clawedBackAt: new Date().toISOString(), reversedCredits: 100, unrecoverableCredits: 0 };

		const first = await store.clawbackDecision({ id: record.id, decidedBy: "owner:A", reversal });
		expect(first.won).toBe(true);
		expect(first.record!.decision).toBe("clawed_back");
		// Any subsequent transition matches 0 rows → read-only no-op returning the committed row.
		const second = await store.clawbackDecision({ id: record.id, decidedBy: "owner:B", reversal });
		expect(second.won).toBe(false);
		expect(second.record!.decision).toBe("clawed_back");
		expect((second.record!.params.clawback as { reversedCredits?: number }).reversedCredits).toBe(100);
	});
});

// cleanup
afterAll(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
