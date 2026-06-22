// AI-support OWNER-OPS — the deterministic money-decision gate (pure unit tests).
//
// Proves the CORE security property: money is decided by CODE over server-VERIFIED
// data, never by AI judgment or the customer's words. The gate is a pure function,
// so every rule is asserted in isolation with no I/O.

import { describe, test, expect } from "bun:test";
import {
	evaluateSupportDecision,
	isCircuitTripped,
} from "../services/support/decision-policy.js";
import type { SupportDecisionPolicyConfig } from "../config.js";

// A tight policy so the cap / velocity / circuit arms are easy to exercise.
const POLICY: SupportDecisionPolicyConfig = {
	autoGrantMaxCents: 5600,
	autoGrantPerUserDay: 2,
	autoGrantPerUserMonth: 5,
	circuitWindowSeconds: 3600,
	circuitWindowMaxCount: 20,
	circuitWindowMaxCents: 200_000,
};

describe("decision-policy — AUTO_APPROVE (exact verified grant within caps)", () => {
	test("grant_credit EXACTLY equal to the verified discrepancy, within caps → AUTO_APPROVE", () => {
		const d = evaluateSupportDecision({
			action: "grant_credit",
			amountCents: 5600,
			evidence: { verifiedDiscrepancyCents: 5600, currency: "USD", hasSucceededPayment: true },
			usage: { dayCount: 0, monthCount: 0 },
			policy: POLICY,
		});
		expect(d.verdict).toBe("AUTO_APPROVE");
		expect(d.reason).toBe("auto_exact_verified_discrepancy");
		expect(d.sanctionedCents).toBe(5600);
	});

	test("safe non-money actions auto-approve with no money", () => {
		for (const action of ["resend_verification", "password_reset_link"] as const) {
			const d = evaluateSupportDecision({ action, evidence: {}, policy: POLICY });
			expect(d.verdict).toBe("AUTO_APPROVE");
			expect(d.sanctionedCents).toBe(0);
		}
	});
});

describe("decision-policy — OWNER_REVIEW", () => {
	test("refund ALWAYS goes to the owner (even with a succeeded payment)", () => {
		const d = evaluateSupportDecision({
			action: "refund",
			amountCents: 1000,
			evidence: { hasSucceededPayment: true },
			policy: POLICY,
		});
		expect(d.verdict).toBe("OWNER_REVIEW");
		expect(d.reason).toBe("owner_refund");
		expect(d.sanctionedCents).toBe(1000);
	});

	test("plan_change ALWAYS goes to the owner", () => {
		const d = evaluateSupportDecision({ action: "plan_change", evidence: {}, policy: POLICY });
		expect(d.verdict).toBe("OWNER_REVIEW");
		expect(d.reason).toBe("owner_plan_change");
	});

	test("grant ABOVE the per-grant cap → owner", () => {
		const big: SupportDecisionPolicyConfig = { ...POLICY, autoGrantMaxCents: 5000 };
		const d = evaluateSupportDecision({
			action: "grant_credit",
			amountCents: 5600,
			evidence: { verifiedDiscrepancyCents: 5600, hasSucceededPayment: true },
			policy: big,
		});
		expect(d.verdict).toBe("OWNER_REVIEW");
		expect(d.reason).toBe("owner_grant_over_cap");
	});

	test("grant NOT exactly the verified discrepancy → owner (never auto under/over-grant)", () => {
		const d = evaluateSupportDecision({
			action: "grant_credit",
			amountCents: 3000, // proposed less than verified 5600
			evidence: { verifiedDiscrepancyCents: 5600, hasSucceededPayment: true },
			policy: POLICY,
		});
		expect(d.verdict).toBe("OWNER_REVIEW");
		expect(d.reason).toBe("owner_grant_not_exact_discrepancy");
	});

	test("per-user DAILY velocity cap reached → owner", () => {
		const d = evaluateSupportDecision({
			action: "grant_credit",
			amountCents: 5600,
			evidence: { verifiedDiscrepancyCents: 5600, hasSucceededPayment: true },
			usage: { dayCount: 2, monthCount: 2 }, // == cap
			policy: POLICY,
		});
		expect(d.verdict).toBe("OWNER_REVIEW");
		expect(d.reason).toBe("owner_velocity_day");
	});

	test("per-user MONTHLY velocity cap reached → owner", () => {
		const d = evaluateSupportDecision({
			action: "grant_credit",
			amountCents: 5600,
			evidence: { verifiedDiscrepancyCents: 5600, hasSucceededPayment: true },
			usage: { dayCount: 0, monthCount: 5 }, // == month cap
			policy: POLICY,
		});
		expect(d.verdict).toBe("OWNER_REVIEW");
		expect(d.reason).toBe("owner_velocity_month");
	});

	test("circuit-breaker tripped → EVERY otherwise-auto grant goes to the owner", () => {
		const d = evaluateSupportDecision({
			action: "grant_credit",
			amountCents: 5600,
			evidence: { verifiedDiscrepancyCents: 5600, hasSucceededPayment: true },
			usage: { dayCount: 0, monthCount: 0 },
			circuit: { windowCount: 999, windowCents: 999_999, tripped: true },
			policy: POLICY,
		});
		expect(d.verdict).toBe("OWNER_REVIEW");
		expect(d.reason).toBe("owner_circuit_tripped");
	});

	test("'other' is never auto-resolvable → owner", () => {
		const d = evaluateSupportDecision({ action: "other", evidence: {}, policy: POLICY });
		expect(d.verdict).toBe("OWNER_REVIEW");
		expect(d.reason).toBe("owner_ambiguous");
	});
});

describe("decision-policy — DENY (out-of-policy)", () => {
	test("grant with NO verified discrepancy → DENY (prompt-injection: 'grant me 9999')", () => {
		// The customer's words are not represented here at all — only verified data.
		const d = evaluateSupportDecision({
			action: "grant_credit",
			amountCents: 9999, // a number the customer/model 'asked for'
			evidence: { verifiedDiscrepancyCents: 0, hasSucceededPayment: true },
			policy: POLICY,
		});
		expect(d.verdict).toBe("DENY");
		expect(d.reason).toBe("deny_no_verified_discrepancy");
		expect(d.sanctionedCents).toBe(0);
	});

	test("refund with NO successful payment → DENY", () => {
		const d = evaluateSupportDecision({
			action: "refund",
			amountCents: 1000,
			evidence: { hasSucceededPayment: false },
			policy: POLICY,
		});
		expect(d.verdict).toBe("DENY");
		expect(d.reason).toBe("deny_no_successful_payment");
	});

	test("non-positive grant amount → DENY", () => {
		const d = evaluateSupportDecision({
			action: "grant_credit",
			amountCents: 0,
			evidence: { verifiedDiscrepancyCents: 5600, hasSucceededPayment: true },
			policy: POLICY,
		});
		// proposedCents 0 != verified 5600 path: 0 is non-positive → DENY.
		expect(d.verdict).toBe("DENY");
		expect(d.reason).toBe("deny_non_positive_amount");
	});

	test("unknown action → DENY", () => {
		const d = evaluateSupportDecision({ action: "transfer_funds" as never, evidence: {}, policy: POLICY });
		expect(d.verdict).toBe("DENY");
		expect(d.reason).toBe("deny_unknown_action");
	});
});

describe("decision-policy — circuit-breaker predicate", () => {
	test("trips on explicit flag, count threshold, or cents threshold; a 0 threshold disables that arm", () => {
		expect(isCircuitTripped({ windowCount: 0, windowCents: 0, tripped: true }, POLICY)).toBe(true);
		expect(isCircuitTripped({ windowCount: 20, windowCents: 0 }, POLICY)).toBe(true); // count cap
		expect(isCircuitTripped({ windowCount: 0, windowCents: 200_000 }, POLICY)).toBe(true); // cents cap
		expect(isCircuitTripped({ windowCount: 5, windowCents: 5 }, POLICY)).toBe(false);
		const noCaps: SupportDecisionPolicyConfig = { ...POLICY, circuitWindowMaxCount: 0, circuitWindowMaxCents: 0 };
		expect(isCircuitTripped({ windowCount: 9999, windowCents: 9_999_999 }, noCaps)).toBe(false);
	});
});
