// AI-support OWNER-OPS — the deterministic money-decision gate.
//
// CORE SECURITY PRINCIPLE: the AI must NEVER decide money by judgment, and must
// NEVER trust the customer's words. This module is a PURE FUNCTION: given an
// action, the SERVER-VERIFIED evidence (e.g. a reconciliation discrepancy
// computed in code from gateway/ledger data, NOT the customer's claim), the
// amount, the per-user usage so far, and the policy caps, it returns
// AUTO_APPROVE | OWNER_REVIEW | DENY + a machine reason. No I/O, no model call,
// no randomness — the same inputs always yield the same decision, so the
// money-routing logic is auditable and testable in isolation.
//
// The AI agent (ai-agent.ts) is only the conversational/evidence SHELL: it
// proposes a structured ActionProposal, and THIS gate (over verified data)
// decides what happens. Anything not auto-resolvable goes to the OWNER for a
// one-tap decision — never to staff, never executed by the AI.
//
// Decision rules (defaults; every threshold is config-driven via
// SupportDecisionPolicyConfig so an operator tunes them without a code change):
//   AUTO_APPROVE — ONLY a grant_credit whose amount EXACTLY equals a
//                  code-computed, gateway-verified reconciliation discrepancy
//                  (paid-succeeded minus already-credited, per currency), AND
//                  amount <= autoGrantMaxCents, AND the user is under their daily
//                  + monthly velocity caps, AND the circuit-breaker is not
//                  tripped. Also AUTO for the non-money safe actions
//                  (resend_verification / password_reset_link) within rate caps.
//   OWNER_REVIEW — refund (always), plan_change (always), a grant above the cap
//                  or not an exact verified discrepancy, anything ambiguous /
//                  insufficient-evidence, a velocity-cap exceedance, or a tripped
//                  circuit-breaker. The owner gets the full case + recommendation.
//   DENY         — out-of-policy: no successful payment found, the discrepancy is
//                  zero/negative, a grant with no verified evidence at all, an
//                  unknown action, or a non-positive money amount.

import {
	serverConfig,
	type SupportDecisionPolicyConfig,
} from "../../config.js";

/** The actions the support shell may PROPOSE. Money actions are gated hard. */
export const SUPPORT_DECISION_ACTIONS = [
	"grant_credit",
	"refund",
	"plan_change",
	"resend_verification",
	"password_reset_link",
	"other",
] as const;
export type SupportDecisionAction = (typeof SUPPORT_DECISION_ACTIONS)[number];

/** Actions that move money. These can NEVER be AUTO-approved unless the amount
 *  is an exact verified discrepancy within caps (grant_credit only). */
const MONEY_ACTIONS: ReadonlySet<SupportDecisionAction> = new Set([
	"grant_credit",
	"refund",
	"plan_change",
]);

export function isMoneyAction(action: SupportDecisionAction): boolean {
	return MONEY_ACTIONS.has(action);
}

/** The verdict the deterministic gate returns. */
export type SupportDecisionVerdict = "AUTO_APPROVE" | "OWNER_REVIEW" | "DENY";

/**
 * SERVER-VERIFIED evidence — the ONLY money signal the gate trusts. Every field
 * here must be computed in code from gateway/ledger data (payment_transactions /
 * credit ledger / reconciliation), NEVER copied from the customer's message or
 * the model's free-text. The customer's words are DATA elsewhere; here they have
 * no representation at all, which is what makes the gate prompt-injection proof.
 */
export interface VerifiedEvidence {
	/**
	 * A gateway-verified, code-computed paid-but-not-credited discrepancy in MINOR
	 * UNITS (cents), per currency. Present ONLY when reconciliation actually found
	 * a positive gap derived from the requester's OWN succeeded payments minus the
	 * credits already accounted to them. Absent/undefined means "no verified
	 * discrepancy" → a grant can never AUTO-approve.
	 */
	verifiedDiscrepancyCents?: number;
	/** The currency the discrepancy is denominated in (verified, not claimed). */
	currency?: string | null;
	/** True when reconciliation confirmed at least one SUCCEEDED payment exists for
	 *  the requester. A refund/grant with NO successful payment is out-of-policy. */
	hasSucceededPayment?: boolean;
	/** Opaque server-side references backing the evidence (tx ids, recon id, …) —
	 *  recorded in the audit/owner case, never interpreted as instructions. */
	refs?: string[];
}

/** Per-user auto-grant usage SO FAR (code-counted, idempotent), used for velocity. */
export interface SupportAutoGrantUsage {
	/** Auto-granted credits to THIS user in the trailing day window. */
	dayCount: number;
	/** Auto-granted credits to THIS user in the trailing month window. */
	monthCount: number;
}

/** Window-wide auto-grant volume, used by the circuit-breaker. */
export interface SupportCircuitState {
	/** Count of AUTO grants executed in the breaker window. */
	windowCount: number;
	/** Total cents AUTO-granted in the breaker window. */
	windowCents: number;
	/** True when an operator/the breaker has explicitly tripped the AUTO tier. */
	tripped?: boolean;
}

export interface EvaluateDecisionInput {
	action: SupportDecisionAction;
	/** Proposed money amount in MINOR UNITS (cents). Ignored for non-money actions. */
	amountCents?: number;
	currency?: string | null;
	/** SERVER-VERIFIED evidence (never the customer's words). */
	evidence: VerifiedEvidence;
	/** Per-user auto-grant velocity so far. Omitted → treated as 0/0 (fresh). */
	usage?: SupportAutoGrantUsage;
	/** Circuit-breaker state. Omitted → treated as not-tripped, empty window. */
	circuit?: SupportCircuitState;
	/** Policy caps. Defaults to serverConfig.supportDecisionPolicy. */
	policy?: SupportDecisionPolicyConfig;
}

export interface SupportDecision {
	verdict: SupportDecisionVerdict;
	/** Stable machine reason code (audited; never customer-facing free text). */
	reason: SupportDecisionReason;
	/** Human-readable detail for the owner case / audit / canned reply. */
	detail: string;
	/**
	 * The amount the policy SANCTIONS, in minor units. For AUTO_APPROVE this is the
	 * exact verified discrepancy (== the proposed amount). For OWNER_REVIEW it is
	 * the proposed amount the owner will see/modify. For DENY it is 0.
	 */
	sanctionedCents: number;
}

export type SupportDecisionReason =
	| "auto_exact_verified_discrepancy"
	| "auto_safe_action"
	| "owner_refund"
	| "owner_plan_change"
	| "owner_grant_over_cap"
	| "owner_grant_not_exact_discrepancy"
	| "owner_velocity_day"
	| "owner_velocity_month"
	| "owner_circuit_tripped"
	| "owner_ambiguous"
	| "deny_no_successful_payment"
	| "deny_no_verified_discrepancy"
	| "deny_non_positive_amount"
	| "deny_unknown_action";

function clampInt(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

/**
 * THE deterministic gate. Pure function over verified data — no I/O, no AI, no
 * randomness. Order matters: hard DENY (out-of-policy) first, then the
 * non-money safe-action AUTO path, then the money path (which can only AUTO for
 * an EXACT verified grant within every cap), defaulting everything else to the
 * OWNER. Fails CLOSED: any uncertainty routes to OWNER_REVIEW, never AUTO.
 */
export function evaluateSupportDecision(input: EvaluateDecisionInput): SupportDecision {
	const policy = input.policy ?? serverConfig.supportDecisionPolicy;
	const action = input.action;
	const usage = input.usage ?? { dayCount: 0, monthCount: 0 };
	const circuit = input.circuit ?? { windowCount: 0, windowCents: 0, tripped: false };

	// ── Unknown / unsupported action → DENY (never guess at money). ──────────────
	if (!(SUPPORT_DECISION_ACTIONS as readonly string[]).includes(action)) {
		return deny("deny_unknown_action", `Unsupported action '${String(action)}'.`);
	}

	// ── Non-money safe actions → AUTO within rate caps (no money moves). ─────────
	// resend_verification / password_reset_link cannot move money; they are
	// auto-approved so the AI can self-serve the common safe cases. (Rate caps for
	// these live in the agent's per-ticket admission/rate layer; the gate's job is
	// only to confirm they are MONEY-SAFE.)
	if (action === "resend_verification" || action === "password_reset_link") {
		return {
			verdict: "AUTO_APPROVE",
			reason: "auto_safe_action",
			detail: `'${action}' is a non-money safe action and is auto-approved.`,
			sanctionedCents: 0,
		};
	}

	// ── 'other' is never auto-resolvable → OWNER reviews. ────────────────────────
	if (action === "other") {
		return ownerReview("owner_ambiguous", "Action is not auto-resolvable; routed to the owner.", clampInt(input.amountCents));
	}

	// ── Money actions ────────────────────────────────────────────────────────────
	const proposedCents = clampInt(input.amountCents);

	// refund + plan_change ALWAYS go to the owner (money out / billing change are
	// never auto-decided, regardless of evidence). plan_change carries no cents.
	if (action === "refund") {
		if (proposedCents <= 0) {
			return deny("deny_non_positive_amount", "Refund amount must be a positive number of minor units.");
		}
		if (input.evidence.hasSucceededPayment !== true) {
			// No verified successful payment to refund against → out-of-policy DENY.
			return deny("deny_no_successful_payment", "No verified successful payment found to refund against.");
		}
		return ownerReview("owner_refund", "Refunds are always owner-reviewed (money out).", proposedCents);
	}
	if (action === "plan_change") {
		return ownerReview("owner_plan_change", "Plan changes are always owner-reviewed.", proposedCents);
	}

	// grant_credit — the ONLY action that can AUTO-approve, and ONLY when the
	// amount is an EXACT gateway-verified discrepancy within every cap.
	if (action === "grant_credit") {
		const verified = clampInt(input.evidence.verifiedDiscrepancyCents);

		// No verified discrepancy at all → there is NOTHING to auto-resolve. If the
		// customer "asked for credit" with no server-verified gap, that is the exact
		// prompt-injection case: DENY (the AI explains; a real dispute can escalate).
		if (verified <= 0) {
			return deny("deny_no_verified_discrepancy", "No code-computed, gateway-verified discrepancy exists, so no credit is owed.");
		}
		if (proposedCents <= 0) {
			return deny("deny_non_positive_amount", "Grant amount must be a positive number of minor units.");
		}

		// The proposed amount MUST be EXACTLY the verified discrepancy. A larger
		// amount is out-of-policy; a SMALLER amount is "not exact" and is left to the
		// owner (the AI does not get to under-grant a partial settlement either).
		if (proposedCents !== verified) {
			return ownerReview(
				"owner_grant_not_exact_discrepancy",
				`Proposed grant (${proposedCents}) does not equal the verified discrepancy (${verified}); owner decides.`,
				proposedCents,
			);
		}

		// Cap check: amount must be within the per-grant auto cap.
		const autoMax = clampInt(policy.autoGrantMaxCents);
		if (verified > autoMax) {
			return ownerReview(
				"owner_grant_over_cap",
				`Verified discrepancy (${verified}) exceeds the auto-grant cap (${autoMax}); owner decides.`,
				verified,
			);
		}

		// Circuit-breaker: if the AUTO tier is tripped, EVERYTHING goes to the owner.
		if (isCircuitTripped(circuit, policy)) {
			return ownerReview(
				"owner_circuit_tripped",
				"The auto-grant circuit-breaker is tripped; all grants are routed to the owner until it resets.",
				verified,
			);
		}

		// Per-user velocity caps (day then month). At-or-over the cap → owner.
		const dayCap = clampInt(policy.autoGrantPerUserDay);
		const monthCap = clampInt(policy.autoGrantPerUserMonth);
		if (clampInt(usage.dayCount) >= dayCap) {
			return ownerReview("owner_velocity_day", `User hit the daily auto-grant cap (${dayCap}); owner decides.`, verified);
		}
		if (clampInt(usage.monthCount) >= monthCap) {
			return ownerReview("owner_velocity_month", `User hit the monthly auto-grant cap (${monthCap}); owner decides.`, verified);
		}

		// All gates passed: an EXACT verified discrepancy, within the per-grant cap,
		// under velocity, breaker not tripped → AUTO-approve EXACTLY the verified amount.
		return {
			verdict: "AUTO_APPROVE",
			reason: "auto_exact_verified_discrepancy",
			detail: `Auto-approved: amount equals the gateway-verified discrepancy (${verified}) within all caps.`,
			sanctionedCents: verified,
		};
	}

	// Defensive default (unreachable given the action allow-list) → fail CLOSED.
	return ownerReview("owner_ambiguous", "Unhandled action; routed to the owner.", proposedCents);
}

/**
 * Circuit-breaker trip predicate. Trips when an operator explicitly set the
 * tripped flag OR the AUTO volume in the breaker window exceeds EITHER the
 * count or the cents threshold. A 0 threshold disables that arm.
 */
export function isCircuitTripped(
	circuit: SupportCircuitState,
	policy: SupportDecisionPolicyConfig = serverConfig.supportDecisionPolicy,
): boolean {
	if (circuit.tripped === true) return true;
	const countCap = clampInt(policy.circuitWindowMaxCount);
	const centsCap = clampInt(policy.circuitWindowMaxCents);
	if (countCap > 0 && clampInt(circuit.windowCount) >= countCap) return true;
	if (centsCap > 0 && clampInt(circuit.windowCents) >= centsCap) return true;
	return false;
}

function deny(reason: SupportDecisionReason, detail: string): SupportDecision {
	return { verdict: "DENY", reason, detail, sanctionedCents: 0 };
}

function ownerReview(reason: SupportDecisionReason, detail: string, sanctionedCents: number): SupportDecision {
	return { verdict: "OWNER_REVIEW", reason, detail, sanctionedCents: clampInt(sanctionedCents) };
}
