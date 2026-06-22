// AI-support OWNER-OPS — the orchestration layer.
//
// This is where the deterministic gate (decision-policy.ts), the verified
// evidence (ai-tools.detectReconciliation, computed in CODE from gateway/ledger
// data), the bounded/idempotent side effects (credits.ts), the owner-decision
// store (owner-decisions-store.ts), and the owner notification all meet.
//
// FLOW (the security contract): the AI shell PROPOSES a structured ActionProposal.
// It does NOT execute. This module:
//   1. RE-COMPUTES the verified evidence in code (NEVER trusts the proposal's
//      claimed amount/evidence — the customer's words and the model's output are
//      DATA, never instructions). For grant_credit the verified evidence is the
//      reconciliation discrepancy computed from the requester's OWN succeeded
//      payments minus credits already accounted to them.
//   2. Runs the PURE deterministic gate over that verified evidence + per-user
//      velocity + circuit-breaker state + config caps.
//   3. AUTO_APPROVE  → executes the bounded/idempotent grant, records the decision
//                      (auto_approved, decided_by=ai, actor="support-ai-auto") with
//                      the verified evidence + executed_ref.
//      OWNER_REVIEW  → creates a PENDING owner-decision case (full structured
//                      proposal + recommendation + verified evidence) and notifies
//                      the OWNER. NOTHING executes.
//      DENY          → records a denied decision; the AI explains to the customer.
//
// Money is decided by CODE over verified data, never by AI judgment. The owner
// approve/deny/modify path (routes/admin/support owner endpoints) re-uses
// executeApprovedGrant so an owner approval is the SAME bounded/idempotent grant,
// audited as actor="owner".

import { serverConfig } from "../../config.js";
import {
	evaluateSupportDecision,
	type SupportDecision,
	type SupportDecisionAction,
	type VerifiedEvidence,
} from "./decision-policy.js";
import {
	ownerDecisionStore as defaultDecisionStore,
	type OwnerDecisionStore,
	type SupportDecisionRecord,
} from "./owner-decisions-store.js";
import { sumTicketAiTokensThb } from "../usage-ledger.js";
import {
	detectReconciliation,
	type SupportToolContext,
} from "./ai-tools.js";
import { creditService as defaultCreditService, type CreditService } from "../credits.js";
import { CENTS_PER_CREDIT } from "../plans.js";
import { listUsers as defaultListUsers } from "../auth.service.js";
import { notify as defaultNotify, type NotifyInput, type NotifyResult } from "../notification-dispatch.js";
import {
	supportOwnerAutoGrants,
	supportOwnerReviews,
	supportOwnerCircuitTripped,
} from "../../middleware/metrics.js";

// Convert a verified cents discrepancy into a grantable credit count at the project
// sale rate (CENTS_PER_CREDIT, the single margin knob in plans.ts), consistent with
// ai-tools' creditsForCents.
function centsToCredits(cents: number): number {
	if (!Number.isFinite(cents) || cents <= 0) return 0;
	return Math.floor(cents / CENTS_PER_CREDIT);
}

/**
 * The structured proposal the AI shell produces. It is DATA: the gate never
 * trusts `params.amount` as a money authority — for grant_credit the sanctioned
 * amount comes from the code-recomputed verified discrepancy, not this field.
 */
export interface ActionProposal {
	action: SupportDecisionAction;
	params?: Record<string, unknown>;
	currency?: string | null;
	/** The AI's human-readable recommendation (advisory; the gate decides money). */
	reason?: string;
}

export interface RouteProposalContext {
	ticketId: string;
	userId: string;
	workspaceId?: string;
	/** The customer-facing ticket subject (for the owner case + notification). */
	ticketSubject?: string;
	now?: () => number;
	toolCtx: SupportToolContext;
	decisionStore?: OwnerDecisionStore;
	creditService?: CreditService;
	notify?: (input: NotifyInput) => Promise<NotifyResult>;
	listUsers?: typeof defaultListUsers;
}

export interface RouteProposalResult {
	/** The gate's verdict. */
	verdict: SupportDecision["verdict"];
	decision: SupportDecisionRecord;
	/** Set when an AUTO grant executed (the executed_ref / grant id). */
	executedRef?: string;
	/** A short message the AI shell can relay to the customer. */
	customerMessage: string;
}

/**
 * Route a single AI proposal through the deterministic gate and act on the
 * verdict. NEVER throws to the agent loop (best-effort path): any unexpected
 * error degrades to an owner-review case so the customer is never left without a
 * safe outcome and no money moves on an error.
 */
export async function routeActionProposal(
	proposal: ActionProposal,
	ctx: RouteProposalContext,
): Promise<RouteProposalResult> {
	const decisionStore = ctx.decisionStore ?? defaultDecisionStore;
	const creditSvc = ctx.creditService ?? defaultCreditService;
	const now = ctx.now ?? Date.now;
	const policy = serverConfig.supportDecisionPolicy;

	// ── 1. Re-compute SERVER-VERIFIED evidence in CODE (never trust the proposal). ──
	const { evidence, proposedCents } = await computeVerifiedEvidence(proposal, ctx);

	// ── 2. Velocity + circuit state (code-counted over durable rows). ───────────────
	const [velocity, windowVolume] = await Promise.all([
		decisionStore.getAutoGrantVelocity(ctx.userId, now),
		decisionStore.getAutoGrantWindowVolume(policy.circuitWindowSeconds, now),
	]);

	// ── 3. The PURE deterministic gate. ─────────────────────────────────────────────
	const verdict = evaluateSupportDecision({
		action: proposal.action,
		amountCents: proposedCents,
		currency: evidence.currency ?? proposal.currency ?? null,
		evidence,
		usage: velocity,
		circuit: { windowCount: windowVolume.windowCount, windowCents: windowVolume.windowCents },
		policy,
	});

	const evidenceJson: Record<string, unknown> = {
		verifiedDiscrepancyCents: evidence.verifiedDiscrepancyCents ?? 0,
		currency: evidence.currency ?? null,
		hasSucceededPayment: evidence.hasSucceededPayment ?? false,
		refs: evidence.refs ?? [],
	};
	const paramsJson: Record<string, unknown> = {
		...(proposal.params ?? {}),
		proposedAmountCents: proposedCents,
		// Persist the workspace so the owner-approve route can execute the grant into
		// the SAME workspace later (the owner endpoint has only the decision row).
		...(ctx.workspaceId?.trim() ? { workspaceId: ctx.workspaceId.trim() } : {}),
	};

	// ── 4. Act on the verdict. ───────────────────────────────────────────────────────
	if (verdict.verdict === "DENY") {
		const { record } = await decisionStore.createDecision({
			ticketId: ctx.ticketId,
			userId: ctx.userId,
			action: proposal.action,
			params: paramsJson,
			evidence: evidenceJson,
			recommendation: proposal.reason,
			decision: "denied",
			reason: verdict.reason,
			decidedBy: "ai",
			amountCents: 0,
			currency: evidence.currency ?? proposal.currency ?? undefined,
		});
		return {
			verdict: "DENY",
			decision: record,
			customerMessage: denyMessageFor(proposal.action, verdict),
		};
	}

	if (verdict.verdict === "OWNER_REVIEW") {
		supportOwnerReviews.inc({ reason: verdict.reason });
		if (verdict.reason === "owner_circuit_tripped") supportOwnerCircuitTripped.set(1);
		const { record } = await decisionStore.createDecision({
			ticketId: ctx.ticketId,
			userId: ctx.userId,
			action: proposal.action,
			params: paramsJson,
			evidence: evidenceJson,
			recommendation: proposal.reason,
			decision: "owner_pending",
			reason: verdict.reason,
			decidedBy: "ai",
			amountCents: verdict.sanctionedCents,
			currency: evidence.currency ?? proposal.currency ?? undefined,
		});
		// Notify the OWNER (never the customer, never staff). Best-effort.
		await notifyOwner(record, ctx).catch((error) => {
			console.warn(`[owner-ops] notifyOwner failed for decision ${record.id}: ${describeError(error)}`);
		});
		return {
			verdict: "OWNER_REVIEW",
			decision: record,
			customerMessage: "Thanks — I've sent this to our team for a quick review and we'll follow up shortly.",
		};
	}

	// ── AUTO_APPROVE — execute the bounded/idempotent grant. ─────────────────────────
	// Only grant_credit + the non-money safe actions can reach here. The non-money
	// safe actions have no side effect to execute through this money path (the agent
	// handles resend/reset via its own tools), so we just record the auto verdict.
	if (proposal.action !== "grant_credit") {
		const { record } = await decisionStore.createDecision({
			ticketId: ctx.ticketId,
			userId: ctx.userId,
			action: proposal.action,
			params: paramsJson,
			evidence: evidenceJson,
			recommendation: proposal.reason,
			decision: "auto_approved",
			reason: verdict.reason,
			decidedBy: "support-ai-auto",
			executedRef: `safe-action:${proposal.action}`,
			amountCents: 0,
			currency: evidence.currency ?? proposal.currency ?? undefined,
		});
		return { verdict: "AUTO_APPROVE", decision: record, executedRef: record.executedRef, customerMessage: "Done — I've taken care of that for you." };
	}

	// grant_credit AUTO: record the decision FIRST (idempotency anchor), then mint.
	const created = await decisionStore.createDecision({
		ticketId: ctx.ticketId,
		userId: ctx.userId,
		action: "grant_credit",
		params: paramsJson,
		evidence: evidenceJson,
		recommendation: proposal.reason,
		decision: "auto_approved",
		reason: verdict.reason,
		decidedBy: "support-ai-auto",
		amountCents: verdict.sanctionedCents,
		currency: evidence.currency ?? proposal.currency ?? undefined,
	});
	if (!created.created) {
		// A prior run already recorded (and executed) this proposal → idempotent no-op.
		return {
			verdict: "AUTO_APPROVE",
			decision: created.record,
			executedRef: created.record.executedRef,
			customerMessage: "Your account is already credited — sorry about the trouble!",
		};
	}

	const grantRef = await executeApprovedGrant({
		decision: created.record,
		sanctionedCents: verdict.sanctionedCents,
		workspaceId: ctx.workspaceId,
		userId: ctx.userId,
		creditService: creditSvc,
		decisionStore,
		actor: "support-ai-auto",
	});
	// Persist the executed_ref onto the (already auto_approved) row so velocity /
	// circuit counters see an EXECUTED grant and a retry stays idempotent.
	if (grantRef) {
		await decisionStore.settleDecision({
			id: created.record.id,
			from: "auto_approved",
			to: "auto_approved",
			decidedBy: "support-ai-auto",
			executedRef: grantRef,
		}).catch((error) => {
			console.warn(`[owner-ops] stamp executedRef failed for ${created.record.id}: ${describeError(error)}`);
		});
	}

	supportOwnerAutoGrants.inc();
	// Reflect the circuit gauge: trips to 1 once the window volume crosses a cap.
	const after = await decisionStore.getAutoGrantWindowVolume(policy.circuitWindowSeconds, now).catch(() => null);
	if (after) {
		const tripped = (policy.circuitWindowMaxCount > 0 && after.windowCount >= policy.circuitWindowMaxCount)
			|| (policy.circuitWindowMaxCents > 0 && after.windowCents >= policy.circuitWindowMaxCents);
		supportOwnerCircuitTripped.set(tripped ? 1 : 0);
	}

	return {
		verdict: "AUTO_APPROVE",
		decision: { ...created.record, executedRef: grantRef ?? undefined },
		executedRef: grantRef ?? undefined,
		customerMessage: "I've credited your account to cover the gap — sorry about that!",
	};
}

/**
 * Execute the bounded, idempotent goodwill credit grant for an APPROVED decision
 * (auto OR owner-approved). Shared so the owner-approve route produces the
 * identical side effect, just audited as actor="owner". Mints PERSONAL credits
 * (immediately spendable). Bounded to the sanctioned cents. On success it stamps
 * the decision's executed_ref so a retry is a no-op. Returns the grant id, or
 * null when no workspace / nothing to grant.
 */
export async function executeApprovedGrant(input: {
	decision: SupportDecisionRecord;
	sanctionedCents: number;
	workspaceId?: string;
	userId: string;
	creditService: CreditService;
	decisionStore: OwnerDecisionStore;
	actor: string;
}): Promise<string | null> {
	const workspaceId = input.workspaceId?.trim();
	const credits = centsToCredits(input.sanctionedCents);
	if (!workspaceId || credits <= 0) return null;

	const grant = await input.creditService.grantCredits({
		workspaceId,
		ownerScope: "user",
		ownerId: input.userId,
		creditClass: "personal",
		amount: credits,
		source: "goodwill",
		// Idempotent on the DECISION id: a retried execution (auto retry or
		// double owner-approve) reuses the same key → exactly one grant ever mints.
		idempotencyKey: `support-decision:${input.decision.id}`,
	});
	return grant.id;
}

// ── CLAWBACK — reverse an erroneous executed grant (OWNER-only path) ─────────────

export class ClawbackError extends Error {
	constructor(message: string, readonly status = 400, readonly code = "clawback_error") {
		super(message);
		this.name = "ClawbackError";
	}
}

export interface ClawbackResult {
	decision: SupportDecisionRecord;
	/** Credits actually deducted back (clamped to the unspent remainder). */
	reversedCredits: number;
	/** Credits the customer already spent that could NOT be recovered. */
	unrecoverableCredits: number;
	/** The credits-service reversal ref (the grant id that was reversed). */
	reversalRef: string;
	/** True when the row was already clawed_back (idempotent read-only no-op). */
	alreadyClawedBack: boolean;
}

/** The reversal amounts a clawed_back row stored on `params.clawback` (always present). */
function readClawback(decision: SupportDecisionRecord, grantIdFallback: string): {
	reversedCredits: number;
	unrecoverableCredits: number;
	reversalRef: string;
} {
	const prior = isPlainObjectRecord(decision.params?.clawback) ? decision.params.clawback : {};
	const reversalRef = typeof prior.reversalRef === "string" && prior.reversalRef.trim()
		? prior.reversalRef.trim()
		: (decision.executedRef?.trim() || grantIdFallback);
	return {
		reversedCredits: readNonNegativeNumber(prior.reversedCredits),
		unrecoverableCredits: readNonNegativeNumber(prior.unrecoverableCredits),
		reversalRef,
	};
}

/**
 * Claw back (reverse) a previously-EXECUTED goodwill credit grant recorded on a
 * support decision — an AI auto-grant that turned out erroneous, or an
 * owner-approved grant. This is the owner's correction lever for the
 * autonomous-grant safety net.
 *
 * ATOMIC + SINGLE-ATTEMPT — no recovery / revert state machine, no observable
 * intermediate "pending-finalize" state, no loser polling:
 *   1. Validate the decision (a grant with an executed grant ref). If it is already
 *      `clawed_back`, return the stored reversal READ-ONLY (idempotent no-op).
 *   2. Compute the reversal via creditSvc.reverseGrant — IDEMPOTENT on
 *      `grant-reversal:<grantId>`, so calling it more than once (a retry, or a racing
 *      loser) nets AT MOST ONE debit and returns the same reversed/unrecoverable
 *      amounts.
 *   3. Hand the final amounts + the audit to decisionStore.clawbackDecision, which in
 *      ONE atomic guarded transaction does the CAS to `clawed_back`, writes the amounts,
 *      and (winner-only, inside the txn, pre-commit) runs the audit. The guarded UPDATE
 *      is the SINGLE winner-gate: under concurrency exactly ONE caller wins; losers
 *      match 0 rows and read back the committed row READ-ONLY (their step-2 reverseGrant
 *      was an idempotent no-op).
 *
 * Guarantees — all hold trivially by construction:
 *   * BOUNDED — deducts at most the granted credits, clamped by reverseGrant() to the
 *     unspent remainder (the balance model never goes negative; any already-spent
 *     portion is reported as unrecoverable, never written as debt).
 *   * REVERSE AT-MOST-ONCE — reverseGrant is idempotent on the grant id, so across any
 *     interleaving of concurrent calls + retries its net effect is at most one debit.
 *   * AUDITED — a committed `clawed_back` row ALWAYS carries its amounts AND has an
 *     audit row, because both the amount-write and the audit happen in the SAME atomic
 *     transition: if the audit throws, the transition rolls back (the row stays
 *     not-clawed-back) and the op FAILS CLOSED (ClawbackError) so a retry is a clean
 *     fresh attempt. No clawback ever reports success without a durable audit.
 *   * NO REVERT / NO DOUBLE-ANYTHING — the row only ever moves to clawed_back on full
 *     success, so there is no half-done state to revert and no racing caller can undo or
 *     double a committed clawback. Losers are read-only.
 *
 * Throws ClawbackError (4xx) for a non-grant / never-executed decision so the route
 * returns a precise status; the credits reversal itself never throws for the
 * already-spent case (it clamps).
 */
export async function executeClawback(input: {
	decisionId: string;
	reason: string;
	ownerUserId: string;
	creditService?: CreditService;
	decisionStore?: OwnerDecisionStore;
	/**
	 * Records the admin audit for the reversal. Runs ONLY for the winner, INSIDE the
	 * atomic clawback transition, BEFORE commit. If it throws, the transition rolls back
	 * and the clawback fails closed (ClawbackError) — a committed clawed_back row is
	 * therefore always audited. Omit it only in tests that assert the lower-level flow.
	 */
	auditReversal?: (outcome: { reversedCredits: number; unrecoverableCredits: number; reversalRef: string; decision: SupportDecisionRecord }) => Promise<void>;
}): Promise<ClawbackResult> {
	const decisionStore = input.decisionStore ?? defaultDecisionStore;
	const creditSvc = input.creditService ?? defaultCreditService;

	const decision = await decisionStore.getById(input.decisionId);
	if (!decision) throw new ClawbackError("Decision not found", 404, "decision_not_found");
	if (decision.action !== "grant_credit") {
		throw new ClawbackError("Only credit grants can be clawed back", 400, "clawback_not_a_grant");
	}

	const reason = input.reason?.trim() || "owner_clawback";

	// ── ALREADY clawed_back → READ-ONLY (idempotent no-op) ───────────────────────────
	// The row only ever reaches clawed_back via a fully-committed atomic transition
	// (amounts + audit), so the stored reversal is always complete + audited. Return it
	// without deducting or re-auditing.
	if (decision.decision === "clawed_back") {
		const stored = readClawback(decision, "");
		return { decision, ...stored, alreadyClawedBack: true };
	}

	// Only an EXECUTED grant (auto_approved / owner_approved, with a grant ref) can be
	// reversed — there is nothing to deduct otherwise.
	if (decision.decision !== "auto_approved" && decision.decision !== "owner_approved") {
		throw new ClawbackError(
			`Decision is '${decision.decision}', not an executed grant; nothing to claw back`,
			409,
			"clawback_not_executed",
		);
	}
	const grantId = decision.executedRef?.trim();
	if (!grantId) {
		throw new ClawbackError("Grant has no executed reference; nothing to reverse", 409, "clawback_no_grant_ref");
	}

	// ── REVERSE (idempotent) — compute the bounded per-grant reversal amount ──────────
	// reverseGrant clamps to THIS grant's own unspent remainder (never an unrelated
	// grant/topup) and is idempotent on `grant-reversal:<grantId>`: a retry — or a
	// concurrent loser — mints no second debit and returns the same amounts. So this is
	// safe to call before knowing whether we win the transition; the winner-gate below is
	// what makes the decision row move at most once.
	const reversal = await creditSvc.reverseGrant(grantId, `clawback:${decision.id}`);

	// ── ONE ATOMIC TRANSITION — CAS → clawed_back + amounts + (winner-only) audit ─────
	// The store does it all-or-nothing: the guarded UPDATE is the single winner-gate, the
	// amounts land in the same statement (no pending-finalize), and the audit runs inside
	// the txn before commit (a throw rolls the whole thing back → fail closed, no revert).
	const clawedBackAt = new Date().toISOString();
	const wonRow = decision; // for the audit's decision snapshot (the winning row pre-commit)
	const { won, record } = await decisionStore.clawbackDecision({
		id: decision.id,
		decidedBy: `owner:${input.ownerUserId}`,
		reversal: {
			reason,
			reversalRef: grantId,
			clawedBackAt,
			reversedCredits: reversal.reversed,
			unrecoverableCredits: reversal.unrecoverable,
		},
		audit: input.auditReversal
			? () => input.auditReversal!({
				reversedCredits: reversal.reversed,
				unrecoverableCredits: reversal.unrecoverable,
				reversalRef: grantId,
				decision: wonRow,
			}).catch((auditError) => {
				// Surface a stable error code; the store rolls the transition back on throw.
				throw new ClawbackError(
					`Clawback audit could not be written: ${describeError(auditError)}`,
					500,
					"clawback_audit_failed",
				);
			})
			: undefined,
	});

	if (won) {
		return {
			decision: record ?? { ...decision, decision: "clawed_back" },
			reversedCredits: reversal.reversed,
			unrecoverableCredits: reversal.unrecoverable,
			reversalRef: grantId,
			alreadyClawedBack: false,
		};
	}

	// ── LOSER / DUPLICATE — READ-ONLY ─────────────────────────────────────────────────
	// A concurrent winner committed clawed_back first (our reverseGrant above was an
	// idempotent no-op). Return the committed row's stored amounts; never re-audit.
	const current = record ?? (await decisionStore.getById(decision.id)) ?? decision;
	const stored = readClawback(current, grantId);
	return { decision: current, ...stored, alreadyClawedBack: true };
}

// ── DAILY DIGEST — post-hoc spot-check of autonomous support activity ────────────

export interface OwnerOpsDigest {
	/** The UTC day the digest covers (YYYY-MM-DD). */
	date: string;
	/** [startMs, endMs) UTC-day bounds the aggregates were computed over. */
	windowStartMs: number;
	windowEndMs: number;
	/** Auto-grants the AI executed (count + total credits/cents auto-granted). */
	autoGrants: { count: number; totalCents: number };
	/** Cases routed to the owner and still awaiting a decision (created that day). */
	ownerPending: number;
	/** Owner decisions taken (approve/deny) — counted by the day they were CREATED. */
	ownerApproved: number;
	ownerDenied: number;
	/** Grants reversed (clawed back) — count + credits/cents reversed that day. */
	clawedBack: { count: number; totalCentsReversed: number };
	/** Gate DENY verdicts (out-of-policy) that day. */
	denied: number;
	/** Owner-review escalations created that day (== ownerPending + already-decided). */
	escalations: number;
	/** AI support-agent token spend for the day, in THB (global meter). */
	aiTokenSpendThb: number;
	/** Total decision rows created that day (every verdict). */
	totalDecisions: number;
}

/** Start-of-UTC-day epoch ms for a given epoch ms. */
function startOfUtcDayMs(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Parse a YYYY-MM-DD (UTC) into a start-of-day epoch ms, or null when invalid. */
export function parseDigestDate(date: string | undefined, now: () => number = Date.now): number | null {
	if (!date || !date.trim()) return startOfUtcDayMs(now());
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
	if (!m) return null;
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return Number.isFinite(ms) ? ms : null;
}

function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build the owner-ops activity digest for a single UTC day. Pure aggregation over
 * the durable decision rows (the same store the velocity/window counters read) +
 * the global AI token meter. Read-only: nothing is mutated. The owner uses this to
 * spot-check the day's autonomous activity post-hoc — the "owner-in-the-loop
 * async" safety net.
 */
export async function buildOwnerOpsDigest(input: {
	dayStartMs: number;
	decisionStore?: OwnerDecisionStore;
	sumAiTokensThb?: (startMs: number) => Promise<number>;
}): Promise<OwnerOpsDigest> {
	const decisionStore = input.decisionStore ?? defaultDecisionStore;
	const sumAiTokens = input.sumAiTokensThb ?? sumTicketAiTokensThb;
	const windowStartMs = startOfUtcDayMs(input.dayStartMs);
	const windowEndMs = windowStartMs + 24 * 60 * 60 * 1000;

	const decisions = await decisionStore.listByCreatedWindow(windowStartMs, windowEndMs);

	const autoGrants = { count: 0, totalCents: 0 };
	const clawedBack = { count: 0, totalCentsReversed: 0 };
	let ownerPending = 0;
	let ownerApproved = 0;
	let ownerDenied = 0;
	let denied = 0;

	for (const d of decisions) {
		switch (d.decision) {
			case "auto_approved":
				if (d.action === "grant_credit") {
					autoGrants.count += 1;
					autoGrants.totalCents += clampInt(d.amountCents);
				}
				break;
			case "owner_pending":
				ownerPending += 1;
				break;
			case "owner_approved":
				ownerApproved += 1;
				break;
			case "owner_denied":
				ownerDenied += 1;
				break;
			case "denied":
				denied += 1;
				break;
			case "clawed_back": {
				clawedBack.count += 1;
				const clawback = isPlainObjectRecord(d.params?.clawback) ? d.params.clawback : {};
				// Convert reversed CREDITS back to cents for a money-consistent total.
				clawedBack.totalCentsReversed += Math.round(readNonNegativeNumber(clawback.reversedCredits) * CENTS_PER_CREDIT);
				break;
			}
			default:
				break;
		}
	}

	// Day-windowed AI token THB = spend-since-dayStart minus spend-since-dayEnd
	// (the meter sums from a start to NOW, so subtracting the later window yields
	// the bounded day). For "today" the dayEnd window is empty → just sinceStart.
	const [sinceStart, sinceEnd] = await Promise.all([
		sumAiTokens(windowStartMs).catch(() => 0),
		sumAiTokens(windowEndMs).catch(() => 0),
	]);
	const aiTokenSpendThb = Math.max(0, roundThb(sinceStart - sinceEnd));

	// Escalations = every case the gate routed to the owner that day (still pending
	// + already decided by the owner). A clawback is a correction of an executed
	// grant, not an escalation, so it is NOT counted here.
	const escalations = ownerPending + ownerApproved + ownerDenied;

	return {
		date: isoDate(windowStartMs),
		windowStartMs,
		windowEndMs,
		autoGrants,
		ownerPending,
		ownerApproved,
		ownerDenied,
		clawedBack,
		denied,
		escalations,
		aiTokenSpendThb,
		totalDecisions: decisions.length,
	};
}

/**
 * Optionally dispatch the daily digest to the owner(s) as a notification. Gated by
 * serverConfig.supportOwnerDigestNotifyEnabled (default OFF) so it is opt-in; a
 * scheduled job hook calls this once a day. Best-effort + idempotent on the digest
 * date (the notification idempotencyKey) so a re-run never double-notifies. Returns
 * the number of owners notified (0 when disabled / no owner / nothing to report).
 */
export async function notifyOwnerOpsDigest(input: {
	digest: OwnerOpsDigest;
	notify?: (input: NotifyInput) => Promise<NotifyResult>;
	listUsers?: typeof defaultListUsers;
	enabled?: boolean;
}): Promise<number> {
	const enabled = input.enabled ?? serverConfig.supportOwnerDigestNotifyEnabled;
	if (!enabled) return 0;
	// Nothing autonomous happened that day → no digest noise.
	if (input.digest.totalDecisions === 0) return 0;
	const notify = input.notify ?? defaultNotify;
	const listUsers = input.listUsers ?? defaultListUsers;
	const owners = (await listUsers()).filter((u) => u.role === "owner" && u.isActive !== false);
	if (owners.length === 0) return 0;
	const d = input.digest;
	const title = `Support owner-ops digest — ${d.date}`;
	const body = [
		`Auto-grants: ${d.autoGrants.count} (${d.autoGrants.totalCents}¢)`,
		`Awaiting you: ${d.ownerPending}`,
		`Approved: ${d.ownerApproved} · Denied: ${d.ownerDenied}`,
		`Clawed back: ${d.clawedBack.count} (${d.clawedBack.totalCentsReversed}¢)`,
		`Gate denials: ${d.denied}`,
		`Escalations: ${d.escalations}`,
		`AI token spend: ${d.aiTokenSpendThb} THB`,
	].join(" · ");
	await Promise.all(owners.map((owner) =>
		notify({
			userId: owner.id,
			email: owner.email,
			name: owner.name,
			// Reuse the existing 'ticket_escalated' support type (in the 0054 CHECK set)
			// so no second migration is needed; metadata carries the structured digest.
			type: "ticket_escalated",
			title,
			body,
			linkUrl: `/admin/support/owner/digest?date=${d.date}`,
			// Idempotent per day: a re-run reuses the key → no double-notify.
			idempotencyKey: `owner-ops-digest:${d.date}`,
			metadata: { source: "support_owner_ops_digest", digest: { ...d } },
		}).catch((error) => {
			console.warn(`[owner-ops] digest notify failed for owner ${owner.id}: ${describeError(error)}`);
			return { inAppDelivered: false, emailAttempted: false, skipped: [] } as NotifyResult;
		}),
	));
	return owners.length;
}

function roundThb(value: number): number {
	return Math.round(value * 100) / 100;
}

function clampInt(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// ── verified-evidence computation (code, never the customer's words) ─────────────

async function computeVerifiedEvidence(
	proposal: ActionProposal,
	ctx: RouteProposalContext,
): Promise<{ evidence: VerifiedEvidence; proposedCents: number }> {
	if (proposal.action === "grant_credit") {
		const recon = await detectReconciliation(ctx.toolCtx);
		const verifiedCents = recon.discrepancyExists ? Math.max(0, Math.floor(recon.discrepancyCents)) : 0;
		// The PROPOSED amount the AI relays is IGNORED as a money authority: for an
		// auto-grant the only amount the policy will sanction is the EXACT verified
		// discrepancy. We therefore set the proposed amount to the verified amount so
		// the "exact discrepancy" gate is satisfied by VERIFIED data, never by a
		// number the model (or the customer) chose. A model attempting to grant more
		// than verified cannot widen this — proposedCents is verified-derived.
		return {
			evidence: {
				verifiedDiscrepancyCents: verifiedCents,
				currency: recon.currency,
				hasSucceededPayment: recon.paidCents > 0,
				refs: [`recon:${ctx.ticketId}`],
			},
			proposedCents: verifiedCents,
		};
	}

	if (proposal.action === "refund") {
		// Refunds always go to the owner; we still compute whether a succeeded payment
		// exists so a refund against NO payment is a hard DENY (out-of-policy). The
		// owner sees the requested amount and decides/modifies it.
		const recon = await detectReconciliation(ctx.toolCtx).catch(() => null);
		const requested = readPositiveCents(proposal.params?.amountCents ?? proposal.params?.amount);
		return {
			evidence: {
				hasSucceededPayment: (recon?.paidCents ?? 0) > 0,
				currency: recon?.currency ?? (proposal.currency ?? null),
				refs: [`recon:${ctx.ticketId}`],
			},
			proposedCents: requested,
		};
	}

	// plan_change / safe actions / other carry no verified money amount.
	return { evidence: { hasSucceededPayment: false, currency: proposal.currency ?? null, refs: [] }, proposedCents: 0 };
}

function readPositiveCents(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

// ── owner notification (never the customer; never staff) ─────────────────────────

async function notifyOwner(decision: SupportDecisionRecord, ctx: RouteProposalContext): Promise<void> {
	const notify = ctx.notify ?? defaultNotify;
	const listUsers = ctx.listUsers ?? defaultListUsers;
	const owners = (await listUsers()).filter((u) => u.role === "owner" && u.isActive !== false);
	if (owners.length === 0) return;
	const title = `Owner review: ${decision.action.replace(/_/g, " ")} for a customer`;
	const body = `${decision.recommendation ?? "A support case needs your decision."} (reason: ${decision.reason ?? "review"})`;
	await Promise.all(owners.map((owner) =>
		notify({
			userId: owner.id,
			email: owner.email,
			name: owner.name,
			// Reuse the existing 'ticket_escalated' support notification type (in the
			// 0054 CHECK set) so no second migration is needed; the metadata + link
			// carry the decision id so the owner queue UI can deep-link the case.
			type: "ticket_escalated",
			title,
			body,
			linkUrl: `/admin/support/owner/decisions/${decision.id}`,
			metadata: {
				source: "support_owner_ops",
				decisionId: decision.id,
				ticketId: decision.ticketId ?? null,
				action: decision.action,
				reason: decision.reason ?? null,
				amountCents: decision.amountCents,
				currency: decision.currency ?? null,
			},
		}),
	));
}

function denyMessageFor(action: SupportDecisionAction, verdict: SupportDecision): string {
	if (action === "grant_credit") {
		return "I checked your payments and credits and everything reconciles — there's no missing balance to credit. If you think this is wrong, I can pass it to our team for a closer look.";
	}
	if (action === "refund") {
		return "I couldn't find a matching successful payment to refund. I can route this to our team to investigate.";
	}
	return `I'm not able to action that automatically (${verdict.reason}). I can pass it to our team if you'd like.`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
