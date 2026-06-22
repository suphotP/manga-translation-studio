// Admin OWNER-OPS owner-decision api barrel (OWNER-ONLY).
//
// The "owner talks to the bot, approves cases" surface. Talks to the owner-only
// endpoints under /api/admin/support/owner/* via the shared adminFetch client
// (same Bearer header + base URL handling as the rest of /admin). The deterministic
// support gate routes money/account cases it cannot auto-resolve into a PENDING
// owner-decision queue; the owner reviews each case (customer + the bot's
// recommendation + the server-VERIFIED evidence + the proposed action/amount) and
// makes a one-tap Approve / Deny / Modify decision.
//
// PATH CONVENTION (IMPORTANT, mirrors admin/support.ts): adminFetch prepends
// `config.apiBase` (`/api`), so paths here must NOT start with `/api` — they start
// at `/admin/...`. The owner endpoints live UNDER the support sub-router, so the
// real paths are `/admin/support/owner/decisions[...]` (verified against
// backend/src/routes/admin/support.ts registerOwnerDecisionRoutes).
//
// AUTHORIZATION: every route is gated server-side to admin:roles.write — held ONLY
// by the owner role — so a non-owner admin/support/accountant 403s. This barrel is
// the wire; the backend stays authoritative.

import { adminFetch } from "./client.ts";

/** The structured action the support AI proposed (the bot's recommendation). */
export type OwnerDecisionAction =
	| "grant_credit"
	| "refund"
	| "plan_change"
	| "resend_verification"
	| "password_reset_link"
	| "other";

/** Lifecycle state of a decision row (only `owner_pending` shows in the queue). */
export type OwnerDecisionState =
	| "auto_approved"
	| "owner_pending"
	| "owner_approved"
	| "owner_denied"
	| "denied";

/**
 * The server-VERIFIED evidence the deterministic gate decided over. Computed in
 * CODE from the customer's OWN payments/credits — never the customer's words or the
 * model's claim. This is WHY the owner can trust the case at a glance.
 */
export interface OwnerDecisionEvidence {
	/** Verified money gap (integer MINOR UNITS / cents) computed from real payments. */
	verifiedDiscrepancyCents?: number;
	currency?: string | null;
	/** Whether the customer has at least one succeeded payment on file. */
	hasSucceededPayment?: boolean;
	/** Opaque provenance refs (e.g. `recon:<ticketId>`). */
	refs?: string[];
	// The store persists evidence as free-form JSON; keep room for forward fields.
	[key: string]: unknown;
}

/**
 * One owner-decision case as serialized by the backend (serializeDecision in
 * routes/admin/support.ts). `amountCents` is the sanctioned/proposed amount in
 * MINOR UNITS; `reason` is the stable machine reason code that says WHY it was
 * escalated (cap / refund / ambiguous / velocity / circuit).
 */
export interface OwnerDecision {
	id: string;
	ticketId: string | null;
	userId: string;
	action: OwnerDecisionAction;
	params: Record<string, unknown>;
	evidence: OwnerDecisionEvidence;
	/** The bot's human-readable recommendation (advisory; the gate decided money). */
	recommendation: string | null;
	decision: OwnerDecisionState;
	/** Stable machine reason code from the gate (e.g. owner_grant_over_cap). */
	reason: string | null;
	decidedBy: string;
	executedRef: string | null;
	/** Sanctioned/proposed amount in MINOR UNITS (cents). */
	amountCents: number;
	currency: string | null;
	createdAt: string;
	decidedAt: string | null;
}

export interface OwnerDecisionListResult {
	decisions: OwnerDecision[];
}

export interface OwnerDecisionSettleResult {
	ok: boolean;
	/** True when the case was already settled (idempotent no-op; do NOT re-show as new). */
	alreadySettled?: boolean;
	decision: OwnerDecision;
	/** Side-effect ref when an approve/modify executed a grant (the grant id). */
	executedRef?: string | null;
}

/** Owner override on approve: the new sanctioned amount in MINOR UNITS (cents). */
export interface OwnerModifyInput {
	amountCents: number;
	reason?: string;
}

export const adminOwnerDecisionsApi = {
	// GET the pending owner-review queue (oldest first). OWNER-ONLY.
	listPending(limit = 100): Promise<OwnerDecisionListResult> {
		return adminFetch<OwnerDecisionListResult>(
			`/admin/support/owner/decisions?limit=${encodeURIComponent(String(limit))}`,
		);
	},

	// GET a single case (any state) for a deep-link. OWNER-ONLY.
	get(id: string): Promise<{ decision: OwnerDecision }> {
		return adminFetch<{ decision: OwnerDecision }>(
			`/admin/support/owner/decisions/${encodeURIComponent(id)}`,
		);
	},

	// APPROVE → execute the proposed action as actor="owner" (bounded/idempotent/audited).
	approve(id: string): Promise<OwnerDecisionSettleResult> {
		return adminFetch<OwnerDecisionSettleResult>(
			`/admin/support/owner/decisions/${encodeURIComponent(id)}/approve`,
			{ method: "POST" },
		);
	},

	// DENY → no money moves; mark owner_denied.
	deny(id: string): Promise<OwnerDecisionSettleResult> {
		return adminFetch<OwnerDecisionSettleResult>(
			`/admin/support/owner/decisions/${encodeURIComponent(id)}/deny`,
			{ method: "POST" },
		);
	},

	// MODIFY → override the amount, then execute the modified amount. amountCents is MINOR UNITS.
	modify(id: string, input: OwnerModifyInput): Promise<OwnerDecisionSettleResult> {
		return adminFetch<OwnerDecisionSettleResult>(
			`/admin/support/owner/decisions/${encodeURIComponent(id)}/modify`,
			{ method: "POST", body: JSON.stringify(input) },
		);
	},
};
