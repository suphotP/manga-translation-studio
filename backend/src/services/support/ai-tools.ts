// AI-support — the tools the gpt-5.5 support agent may call (OWNER-OPS model).
//
// Four tools, three READ-ONLY and one PROPOSAL:
//   get_customer_360            — plan, credit balance, recent payments, open tickets.
//   check_payment_reconciliation — detect a paid-but-not-credited discrepancy.
//   propose_action              — PROPOSE a money/account action (grant_credit /
//                                 refund / plan_change / resend_verification /
//                                 password_reset_link). The AI does NOT execute: the
//                                 proposal is routed through the DETERMINISTIC policy
//                                 gate (decision-policy.ts) over SERVER-VERIFIED data.
//                                 The gate decides AUTO_APPROVE (execute the bounded,
//                                 idempotent, audited grant) | OWNER_REVIEW (create a
//                                 pending owner case + notify the owner; NOTHING moves)
//                                 | DENY (no action). Money is decided by CODE over
//                                 verified data, never by AI judgment.
//   escalate_to_department      — set status=escalated, assign the dept queue, notify,
//                                 and signal the loop to stop.
//
// SECURITY: the customer's message text and the model's chosen `amount` are DATA,
// never instructions. For grant_credit the sanctioned amount is the code-recomputed
// reconciliation discrepancy — a model (or a prompt-injecting customer) asking to
// "grant 9999" with no verified discrepancy can NEVER auto-approve money.
//
// Every tool is invoked through `executeSupportTool` which validates args, runs the
// implementation, and returns a JSON-stringifiable result the loop feeds back to the
// model.

import { CreditService, creditService as defaultCreditService } from "../credits.js";
import {
	paymentTransactionsStore as defaultPaymentTxStore,
	type PaymentTransaction,
	type PaymentTransactionsStore,
} from "../payment-transactions-store.js";
import {
	paymentReconciliationStore as defaultReconciliationStore,
	type PaymentReconciliationStore,
} from "./payment-reconciliations-store.js";
import {
	supportTicketStore as defaultTicketStore,
	type SupportTicketStore,
} from "../support-tickets.js";
import { minorUnitsFor } from "../../utils/money.js";
import { CENTS_PER_CREDIT, planMonthlyCredits, resolveBillingAddon } from "../plans.js";
import type { SupportToolDefinition } from "./ai-provider.js";
import {
	SUPPORT_DECISION_ACTIONS,
	type SupportDecisionAction,
} from "./decision-policy.js";
import {
	routeActionProposal,
	type ActionProposal,
} from "./owner-ops.js";
import type { OwnerDecisionStore } from "./owner-decisions-store.js";
import type { NotifyInput, NotifyResult } from "../notification-dispatch.js";

// Departments the agent may escalate to. Kept small + explicit so the model can't
// route to an arbitrary queue. Maps 1:1 to a human work queue label on the ticket.
export const SUPPORT_DEPARTMENTS = ["billing", "technical", "abuse", "account", "general"] as const;
export type SupportDepartment = (typeof SUPPORT_DEPARTMENTS)[number];

export interface SupportToolContext {
	/** The authenticated requester (ticket owner) — tools are scoped to this user. */
	userId: string;
	/** The workspace the ticket/credits belong to (for credit grants + payment scoping). */
	workspaceId?: string;
	ticketId: string;
	/** Ticket subject — surfaced in the owner-review case for context. */
	ticketSubject?: string;
	/** Currency to grant credits in if not derivable from payments. */
	defaultCurrency?: string;
	creditService?: CreditService;
	paymentTxStore?: PaymentTransactionsStore;
	reconciliationStore?: PaymentReconciliationStore;
	ticketStore?: SupportTicketStore;
	/** Owner-decision store the proposal gate records to (DI seam for tests). */
	decisionStore?: OwnerDecisionStore;
	/** Owner-notification fn (DI seam for tests). */
	notify?: (input: NotifyInput) => Promise<NotifyResult>;
	/** Owner lookup (DI seam for tests). */
	listUsers?: () => Promise<Array<{ id: string; email?: string; name?: string; role: string; isActive?: boolean }>>;
	now?: () => number;
}

/** A tool returned a directive the AGENT must act on (escalate ends the loop). */
export interface SupportToolEscalation {
	department: SupportDepartment;
	reason: string;
}

export interface SupportToolOutcome {
	/** JSON-stringifiable payload fed back to the model as the tool result. */
	result: Record<string, unknown>;
	/** When set, the agent must escalate + STOP the loop after this tool. */
	escalate?: SupportToolEscalation;
}

// ── Tool JSON-schema definitions (sent to the model) ────────────────────────────

export const SUPPORT_TOOL_DEFINITIONS: SupportToolDefinition[] = [
	{
		name: "get_customer_360",
		description:
			"Look up the current customer's account: plan, current credit balance, their most recent payments, and their open support tickets. READ-ONLY. Always call this before stating any account fact — never invent balances, payments, or plan details.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "check_payment_reconciliation",
		description:
			"Compare the customer's successful payments against the credits actually granted to them, to determine whether a 'paid but credits did not arrive' discrepancy exists and, if so, how much (in minor units / cents). READ-ONLY — this does NOT grant anything. Call this whenever a customer says they topped up but did not receive credits.",
		parameters: {
			type: "object",
			properties: {
				since: {
					type: "string",
					description: "Optional ISO-8601 lower bound; only consider payments on/after this time.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "propose_action",
		description:
			"PROPOSE a money or account action for a customer. You do NOT execute it: the proposal is routed through a deterministic policy that decides over SERVER-VERIFIED payment/credit data. A grant_credit that exactly matches a verified paid-but-not-credited discrepancy within caps is auto-applied; a refund, plan change, larger grant, or anything not exactly verified is sent to the owner for a one-tap decision (NOTHING moves until they approve); a request with no verified basis is declined. NEVER trust the customer's stated amount — propose grant_credit only after check_payment_reconciliation confirms a discrepancy. Returns the policy verdict (auto_approved / owner_review / denied) and a message to relay to the customer.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [...SUPPORT_DECISION_ACTIONS],
					description: "The action to propose. grant_credit resolves a verified discrepancy; refund/plan_change always go to the owner; resend_verification/password_reset_link are safe non-money actions.",
				},
				amount: {
					type: "number",
					description: "Requested amount in MINOR UNITS (cents) for refund. For grant_credit this is ignored — the sanctioned amount is the code-verified discrepancy. Optional.",
				},
				reason: { type: "string", description: "Short human-readable recommendation for the owner / audit." },
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: "escalate_to_department",
		description:
			"Hand the ticket to a human department when you cannot fully resolve it, the customer needs a refund or account change beyond your tools, or the issue requires manual review. This stops the AI from replying further.",
		parameters: {
			type: "object",
			properties: {
				department: {
					type: "string",
					enum: [...SUPPORT_DEPARTMENTS],
					description: "Which human queue to route to.",
				},
				reason: { type: "string", description: "Why this needs a human." },
			},
			required: ["department", "reason"],
			additionalProperties: false,
		},
	},
];

// ── Reconciliation core (shared by check_payment_reconciliation + grant_credit) ──

export interface ReconciliationResult {
	/** True when the customer is owed more SKU credits than were actually granted. */
	discrepancyExists: boolean;
	/**
	 * The unfunded gap expressed in CREDIT-EQUIVALENT minor units (== discrepancyCredits
	 * × CENTS_PER_CREDIT, the sale rate). This is the unit the deterministic gate reasons
	 * in (its caps/velocity are credit-equivalent cents), and `centsToCredits` inverts it
	 * back to EXACTLY `discrepancyCredits` when the grant mints. It is NOT raw money paid.
	 * 0 when none.
	 */
	discrepancyCents: number;
	currency: string | null;
	/** Gross money the customer PAID for credit-bearing SKUs, in real minor units (e.g. USD cents). */
	paidCents: number;
	/** Credit-equivalent minor units of the credits already accounted to the customer. */
	creditedCents: number;
	/** The credits OWED-but-not-granted — the SKU-promised amount a grant must mint. */
	discrepancyCredits: number;
	detail: string;
}

// Convert a credit COUNT into credit-equivalent minor units at the project sale rate
// (CENTS_PER_CREDIT, the single margin knob in plans.ts: 1 credit = 0.85 currency
// units = 85 minor units). The deterministic gate reasons in these credit-equivalent
// cents (its caps/velocity are credit-equivalent), and owner-ops' centsToCredits
// inverts it back to the exact credit count when minting — so a grant always mints
// EXACTLY the SKU-promised credits, never a flat per-cent rate applied to USD money.
function creditEquivalentCents(credits: number): number {
	if (!Number.isFinite(credits) || credits <= 0) return 0;
	return Math.floor(credits) * CENTS_PER_CREDIT;
}

/**
 * Detect a paid-but-not-credited discrepancy for the REQUESTING USER (ctx.userId).
 *
 * SKU-BASED (money, P1): the credits a payment OWES are the credits its SKU PROMISED
 * (a credit pack's `addon.aiCredits`, a plan's `plan.monthlyAiCredits`), NOT the money
 * paid divided by a flat per-cent rate. The flat rate (CENTS_PER_CREDIT, the cost-basis
 * sale rate) is a margin FLOOR, not a SKU's sale price: a $4 credits-50 pack promises 50
 * credits, never floor(400 USD cents / 85)=4. Dividing the cost-basis rate into a USD
 * amount is doubly wrong (wrong rate AND wrong currency), so reconciliation maps each
 * succeeded payment to its SKU and sums the PROMISED CREDITS owed. A payment whose SKU
 * we cannot resolve owes 0 credits (fail-closed) — it can NEVER auto-grant; a genuine
 * untagged payment routes to the owner via the no-discrepancy path / escalation.
 *
 * SCOPING (money + security, P1): a grant is paid to ctx.userId, so the discrepancy
 * that justifies it MUST be derived solely from that user's OWN records. We never use
 * workspace-wide aggregates — a payment another member made (or an unattributed
 * workspace payment) can NEVER create a discrepancy that credits THIS requester.
 *   * owed    = sum of PROMISED CREDITS over the requesting user's OWN SUCCEEDED,
 *              SKU-resolved payments. payment_transactions has no user column, so a
 *              payment is attributed to a user only via its `raw.metadata.user_id`. A
 *              payment with no user attribution, or one attributed to a DIFFERENT user,
 *              does not count (fail-closed).
 *   * granted = credits already accounted to THIS user: the goodwill credits a PRIOR
 *              reconciliation granted to them (payment_reconciliations, listByUser, stored
 *              as credit-equivalent cents) PLUS their OWN top-up / add-on credit-ledger
 *              grants (ledger.userId, stored as credit counts).
 *
 * discrepancy(credits) = max(0, owedCredits − grantedCredits). Prior grants + the user's
 * own purchases reduce the gap, so a fully-credited customer yields 0 (grant nothing).
 * The reported discrepancyCents is that credit gap × CENTS_PER_CREDIT (credit-equivalent
 * cents), which the gate/grant convert back to exactly discrepancyCredits.
 */
export async function detectReconciliation(
	ctx: SupportToolContext,
	options: { since?: string } = {},
): Promise<ReconciliationResult> {
	const paymentTxStore = ctx.paymentTxStore ?? defaultPaymentTxStore;
	const reconciliationStore = ctx.reconciliationStore ?? defaultReconciliationStore;
	const creditSvc = ctx.creditService ?? defaultCreditService;
	const workspaceId = ctx.workspaceId?.trim();
	const userId = ctx.userId?.trim();

	// Without a workspace we cannot scope payments → no confident discrepancy.
	if (!workspaceId) {
		return emptyReconciliation("No workspace is associated with this customer, so payments cannot be reconciled automatically.");
	}
	// Without a requesting user we cannot attribute a grant → never grant.
	if (!userId) {
		return emptyReconciliation("No customer identity is associated with this ticket, so payments cannot be reconciled automatically.");
	}

	const { transactions } = await paymentTxStore.listTransactions({
		workspaceId,
		from: options.since,
		limit: 500,
	});
	// Per-currency tally of the REQUESTING USER's OWN SUCCEEDED payments: how many CREDITS
	// each currency's SKU-resolved payments PROMISED, plus the gross money paid (for the
	// human-readable detail only). Currencies stay in separate buckets — credit AMOUNTS
	// are currency-less, but we still report the gap in the currency the payments were in.
	// Refunds/disputes (kind !== 'payment', stored negative) and non-succeeded payments
	// are excluded so a failed/pending row can never inflate the owed credits.
	const owedByCurrency = new Map<string, { owedCredits: number; paidCents: number }>();
	for (const tx of transactions) {
		if (!isSucceededPayment(tx)) continue;
		if (paymentUserId(tx) !== userId) continue; // fail-closed: only the requester's own payments
		const currency = tx.currency ?? ctx.defaultCurrency?.toUpperCase() ?? "";
		// Promised credits come from the payment's SKU — NOT the money divided by a rate.
		// An unresolved SKU owes 0 credits (fail-closed: never auto-grant from raw money).
		const owedCredits = paymentSkuCredits(tx);
		const bucket = owedByCurrency.get(currency) ?? { owedCredits: 0, paidCents: 0 };
		bucket.owedCredits += owedCredits;
		bucket.paidCents += tx.amountCents;
		owedByCurrency.set(currency, bucket);
	}

	// Credits already accounted to THIS user: prior AI reconciliations granted to them
	// (stored as credit-equivalent cents → convert back to a credit COUNT) + their OWN
	// top-up / add-on credit-ledger grants (already credit counts). Credits are
	// currency-less, so they reduce whichever currency's owed credits we evaluate — this
	// can only LOWER a discrepancy, never raise one, which keeps the grant conservative.
	const priorReconciliations = await reconciliationStore.listByUser(userId);
	const priorGrantedCredits = priorReconciliations.reduce(
		(sum, r) => sum + centsToCreditCount(Math.max(0, r.grantedCents)),
		0,
	);

	const ledger = creditSvc.listLedger(workspaceId);
	const purchasedCredits = ledger
		.filter((entry) => entry.userId === userId
			&& entry.delta > 0
			&& (entry.reason === "grant:topup" || entry.reason === "grant:addon_purchase"))
		.reduce((sum, entry) => sum + entry.delta, 0);
	const grantedCredits = priorGrantedCredits + purchasedCredits;

	// Pick the currency with the largest unfunded CREDIT gap AFTER subtracting the user's
	// own granted credits. Currencies are evaluated independently; we never combine them.
	let bestCurrency: string | null = null;
	let bestPaidCents = 0;
	let bestDiscrepancyCredits = 0;
	for (const [currency, bucket] of owedByCurrency) {
		const gap = Math.max(0, bucket.owedCredits - grantedCredits);
		if (gap > bestDiscrepancyCredits) {
			bestDiscrepancyCredits = gap;
			bestPaidCents = bucket.paidCents;
			bestCurrency = currency || null;
		}
	}

	// No positive gap in any single currency → still surface the dominant paid currency
	// (largest succeeded-payment total) for the no-discrepancy message.
	const reportedCurrency = bestCurrency
		?? pickDominantCurrency(owedByCurrency)
		?? ctx.defaultCurrency?.toUpperCase()
		?? null;
	const reportedPaidCents = bestCurrency !== null
		? bestPaidCents
		: (reportedCurrency ? (owedByCurrency.get(reportedCurrency)?.paidCents ?? 0) : 0);

	const discrepancyCredits = bestDiscrepancyCredits;
	// Report the gap to the gate in credit-equivalent cents (its unit); centsToCredits
	// inverts it back to EXACTLY discrepancyCredits when the bounded grant mints.
	const discrepancyCents = creditEquivalentCents(discrepancyCredits);
	const creditedCents = creditEquivalentCents(grantedCredits);
	const exists = discrepancyCredits > 0;
	const hadAnyPaid = [...owedByCurrency.values()].some((v) => v.paidCents > 0);

	return {
		discrepancyExists: exists,
		discrepancyCents,
		currency: reportedCurrency,
		paidCents: reportedPaidCents,
		creditedCents,
		discrepancyCredits,
		detail: exists
			? `Customer paid ${formatMinor(reportedPaidCents, reportedCurrency)} for SKUs promising more credits than were granted — ${grantedCredits} credit(s) are accounted for, leaving ${discrepancyCredits} credit(s) owed.`
			: !hadAnyPaid
				? "No successful payments found for this customer, so there is nothing to reconcile."
				: "Payments and credits reconcile — no paid-but-uncredited discrepancy was found.",
	};
}

/** A revenue row counts toward "paid" only if it is a SUCCEEDED payment (not a
 *  refund/dispute, not a failed/pending/processing payment). Refunds/disputes use a
 *  different `kind`; a payment that did not settle has a non-"succeeded" status. */
function isSucceededPayment(tx: PaymentTransaction): boolean {
	return tx.kind === "payment" && tx.amountCents > 0 && (tx.status ?? "").trim().toLowerCase() === "succeeded";
}

/** The user a payment is attributable to, taken ONLY from the Dodo subject's
 *  `metadata.user_id` — the value our own checkout sets (payment_transactions has no
 *  user column). We deliberately do NOT fall back to a top-level `raw.user_id`/`raw.userId`:
 *  those are uncontrolled provider/payload fields and trusting them would let a payment
 *  that lacks our checkout metadata be attributed to (and grant credits to) whoever that
 *  field names. Returns null when no trusted attribution exists — such a row is
 *  UNATTRIBUTED, belongs to no single requester, and must never justify a grant. */
function paymentUserId(tx: PaymentTransaction): string | null {
	const raw = tx.raw;
	if (!raw || typeof raw !== "object") return null;
	const metadata = (raw as Record<string, unknown>).metadata;
	return metadata && typeof metadata === "object"
		? firstString(metadata as Record<string, unknown>, ["user_id", "userId"])
		: null;
}

/**
 * The AI credits a SUCCEEDED payment OWES — resolved HOLISTICALLY from its SKU, never
 * from the money paid (money, P1). FOUR rounds of single-branch patches kept letting a
 * non-AI purchase fall through to mint the plan's free AI credits, so the resolution is
 * now a strict, FAIL-SAFE precedence with NO fall-through from the add-on world to the
 * plan world. Each world resolves through its OWN registry so a field can NEVER yield the
 * other world's credits, and an add-on-bearing payment can NEVER auto-grant plan credits:
 *
 *   1. ADD-ON WORLD (authoritative whenever ANY explicit add-on id is present). Gather
 *      EVERY explicit add-on identifier the payment carries — `raw.metadata.sku` / `skuId`
 *      / `addon_id` / `addonId` / `product_id` / `productId`, and `raw.metadata.addons`
 *      (accept a single string, a comma-list string, or an array). If ANY NON-EMPTY such
 *      identifier exists — RECOGNIZED OR NOT — the purchase is ADD-ON-SCOPED and owes
 *      EXACTLY the SUM of the RECOGNIZED add-ons' AI credits: an `ai_credits` add-on
 *      contributes its `aiCredits`; a non-AI add-on (storage/seat/team_jobs/byo-api) and an
 *      UNRECOGNIZED id each contribute 0. We RETURN that sum, EVEN IF 0, WITHOUT consulting
 *      the plan. `resolveBillingAddon` alias-normalizes Dodo underscore keys (`byo_api` →
 *      `byo-api`), so a BYO buy resolves to the recognized non-AI add-on → 0 (round-4 P1).
 *      So a `storage-25gb` / `["seat-1"]` / `byo_api` buy that also carries a `planId` owes
 *      0, never the plan's monthlyAiCredits, and a mixed `["credits-50","storage-25gb"]`
 *      owes only the 50 credit-pack credits.
 *
 *   2. PLAN WORLD (ONLY when NO non-empty explicit add-on id appears anywhere — a pure
 *      plan-subscription payment). A plan field — the `planId` column or
 *      `raw.metadata.plan_id` / `plan_key` — resolves through the PLAN-ONLY
 *      `planMonthlyCredits`, which checks ONLY WORKSPACE_PLANS and never add-ons. A genuine
 *      plan (creator/pro/studio) owes its monthlyAiCredits; an add-on id mistakenly placed
 *      in a plan field (`plan_key: "credits-50"`) or garbage owes 0 (a plan field can NEVER
 *      cross-resolve to add-on credits).
 *
 *   3. Otherwise → 0.
 *
 * FAIL-SAFE rationale (round-4): an add-on-bearing payment must never auto-mint plan AI
 * credits via reconciliation. The worst case is an UNDER-grant (safe — a human/owner can
 * top up); an over-grant is structurally impossible. Fail-closed default 0 everywhere: a
 * payment with no resolvable add-on/plan SKU can never auto-grant credits from a flat
 * money rate.
 *
 * Exported for exhaustive permutation testing of the owed-credit resolution in isolation.
 */
export function paymentSkuCredits(tx: PaymentTransaction): number {
	const metadata = (tx.raw && typeof tx.raw === "object"
		? (tx.raw as Record<string, unknown>).metadata
		: null);
	const meta = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};

	// ── 1. ADD-ON WORLD ──────────────────────────────────────────────────────────────
	// Collect every explicit add-on identifier the payment carries, from BOTH the single
	// id fields and the `addons` list field (string, comma-list, or array of strings).
	const addonIds: string[] = [];
	const singleId = firstString(meta, ["sku", "skuId", "addon_id", "addonId", "product_id", "productId"]);
	if (singleId) addonIds.push(singleId);
	const addonsField = meta.addons;
	if (typeof addonsField === "string") {
		for (const id of addonsField.split(",")) {
			const trimmed = id.trim();
			if (trimmed) addonIds.push(trimmed);
		}
	} else if (Array.isArray(addonsField)) {
		for (const id of addonsField) {
			if (typeof id === "string" && id.trim()) addonIds.push(id.trim());
		}
	}

	// Round-4 FAIL-SAFE precedence: if the payment carries ANY non-empty explicit add-on
	// identifier — RECOGNIZED OR NOT — it is an ADD-ON-SCOPED purchase and owes EXACTLY the
	// SUM of the RECOGNIZED AI-credit add-ons' credits (a non-AI add-on like byo-api/storage
	// contributes 0; an UNRECOGNIZED id contributes 0). We RETURN that sum here, EVEN WHEN 0,
	// and NEVER fall through to the plan world.
	//
	// This closes the over-grant class for good: an add-on-bearing payment can never
	// auto-mint the plan's free AI credits via reconciliation. `resolveBillingAddon`
	// alias-normalizes Dodo underscore keys (`byo_api` → `byo-api`), so a BYO purchase now
	// resolves to the recognized non-AI add-on (0 credits) instead of missing the catalog
	// and falling through to the plan. Even an UNRECOGNIZED explicit id is treated as
	// add-on-scoped → 0, so the worst case is an UNDER-grant (safe — a human/owner can top
	// up); an over-grant is structurally impossible.
	if (addonIds.length > 0) {
		return addonIds
			.map((id) => resolveBillingAddon(id))
			.reduce(
				(sum, addon) =>
					sum + (addon && addon.kind === "ai_credits" && typeof addon.aiCredits === "number" && addon.aiCredits > 0
						? Math.floor(addon.aiCredits)
						: 0),
				0,
			);
	}

	// ── 2. PLAN WORLD ────────────────────────────────────────────────────────────────
	// No recognized add-on anywhere → a plan field may name a genuine plan subscription.
	// Resolve ONLY against WORKSPACE_PLANS (planMonthlyCredits never looks at add-ons), so
	// an add-on id or garbage in a plan field owes 0 rather than cross-resolving.
	const planSku = tx.planId ?? firstString(meta, ["plan_id", "planId", "plan_key", "planKey"]);
	return planMonthlyCredits(planSku ?? undefined);
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function emptyReconciliation(detail: string): ReconciliationResult {
	return {
		discrepancyExists: false,
		discrepancyCents: 0,
		currency: null,
		paidCents: 0,
		creditedCents: 0,
		discrepancyCredits: 0,
		detail,
	};
}

function pickDominantCurrency(buckets: Map<string, { paidCents: number }>): string | null {
	let best: string | null = null;
	let bestAmount = -1;
	for (const [currency, bucket] of buckets) {
		if (!currency) continue; // skip the unattributed (no-currency) bucket
		if (bucket.paidCents > bestAmount) {
			best = currency;
			bestAmount = bucket.paidCents;
		}
	}
	return best;
}

/** Invert credit-equivalent minor units (sale rate) back to a credit COUNT. Used to
 *  re-express a prior reconciliation's stored grantedCents as the credits it minted, so
 *  already-granted credits are subtracted in the SAME (credit) unit as SKU-owed credits. */
function centsToCreditCount(cents: number): number {
	if (!Number.isFinite(cents) || cents <= 0) return 0;
	return Math.floor(cents / CENTS_PER_CREDIT);
}

function formatMinor(cents: number, currency: string | null): string {
	const code = currency ?? "";
	const minorDigits = currency ? minorUnitsFor(currency) : 2;
	const divisor = 10 ** minorDigits;
	const major = (cents / divisor).toFixed(minorDigits);
	return code ? `${major} ${code}` : major;
}

// ── Tool dispatch ───────────────────────────────────────────────────────────────

export async function executeSupportTool(
	name: string,
	rawArgs: string,
	ctx: SupportToolContext,
): Promise<SupportToolOutcome> {
	let args: Record<string, unknown> = {};
	if (rawArgs && rawArgs.trim()) {
		try {
			const parsed = JSON.parse(rawArgs);
			if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
		} catch {
			return { result: { error: "invalid_arguments", detail: "Tool arguments were not valid JSON." } };
		}
	}
	switch (name) {
		case "get_customer_360":
			return { result: await getCustomer360(ctx) };
		case "check_payment_reconciliation":
			return { result: await runCheckReconciliation(ctx, args) };
		case "propose_action":
			return { result: await runProposeAction(ctx, args) };
		case "escalate_to_department":
			return runEscalate(args);
		default:
			return { result: { error: "unknown_tool", detail: `No such tool '${name}'.` } };
	}
}

async function getCustomer360(ctx: SupportToolContext): Promise<Record<string, unknown>> {
	const creditSvc = ctx.creditService ?? defaultCreditService;
	const paymentTxStore = ctx.paymentTxStore ?? defaultPaymentTxStore;
	const ticketStore = ctx.ticketStore ?? defaultTicketStore;
	const workspaceId = ctx.workspaceId?.trim();

	const balance = workspaceId
		? creditSvc.getBalance("member", ctx.userId, workspaceId)
		: creditSvc.getBalance("user", ctx.userId);

	const payments = workspaceId
		? (await paymentTxStore.listTransactions({ workspaceId, limit: 10 })).transactions.map((tx) => ({
			kind: tx.kind,
			amountCents: tx.amountCents,
			currency: tx.currency,
			status: tx.status,
			planId: tx.planId,
			occurredAt: tx.occurredAt,
		}))
		: [];

	const openTickets = (await ticketStore.listTickets({ requesterUserId: ctx.userId, status: ["open", "pending", "escalated"], limit: 10 }))
		.items.map((t) => ({ id: t.id, subject: t.subject, status: t.status, category: t.category, updatedAt: t.updatedAt }));

	return {
		userId: ctx.userId,
		workspaceId: workspaceId ?? null,
		creditBalance: { shareable: balance.shareable, personal: balance.personal, total: balance.total },
		recentPayments: payments,
		openTickets,
	};
}

async function runCheckReconciliation(ctx: SupportToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const since = typeof args.since === "string" ? args.since : undefined;
	const recon = await detectReconciliation(ctx, { since });
	return {
		discrepancyExists: recon.discrepancyExists,
		discrepancyCents: recon.discrepancyCents,
		discrepancyCredits: recon.discrepancyCredits,
		currency: recon.currency,
		paidCents: recon.paidCents,
		creditedCents: recon.creditedCents,
		detail: recon.detail,
	};
}

/**
 * PROPOSE an action — the AI's ONLY money/account path, and it does NOT execute.
 * The structured proposal is routed through the DETERMINISTIC policy gate
 * (decision-policy.ts) over SERVER-VERIFIED data (owner-ops.routeActionProposal):
 *   - AUTO_APPROVE → the bounded/idempotent/audited grant executes (actor
 *     "support-ai-auto"), recorded with the verified evidence.
 *   - OWNER_REVIEW → a pending owner-decision case is created + the owner is
 *     notified; NOTHING moves until they approve.
 *   - DENY → no action; the model relays the explanation to the customer.
 *
 * SECURITY: the model's `amount` is DATA. For grant_credit the sanctioned amount is
 * the code-recomputed discrepancy inside owner-ops — a model asking for more than
 * the verified amount can never widen it. A grant with no verified discrepancy is
 * DENY/OWNER, never an auto-approved money move.
 */
async function runProposeAction(ctx: SupportToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const actionRaw = typeof args.action === "string" ? args.action.trim() : "";
	if (!(SUPPORT_DECISION_ACTIONS as readonly string[]).includes(actionRaw)) {
		return { verdict: "denied", status: "invalid_action", detail: `'${actionRaw || "(none)"}' is not a proposable action.` };
	}
	const action = actionRaw as SupportDecisionAction;
	const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim().slice(0, 500) : undefined;
	const proposal: ActionProposal = {
		action,
		params: {
			// Only carry the model's amount for actions where it is meaningful (refund).
			// For grant_credit the sanctioned amount is verified-derived, so we do NOT
			// let the model's number influence the money decision.
			...(action === "refund" && typeof args.amount === "number" && Number.isFinite(args.amount)
				? { amountCents: Math.floor(args.amount) }
				: {}),
		},
		currency: ctx.defaultCurrency,
		reason,
	};

	const outcome = await routeActionProposal(proposal, {
		ticketId: ctx.ticketId,
		userId: ctx.userId,
		workspaceId: ctx.workspaceId,
		ticketSubject: ctx.ticketSubject,
		now: ctx.now,
		toolCtx: ctx,
		decisionStore: ctx.decisionStore,
		creditService: ctx.creditService,
		notify: ctx.notify,
		listUsers: ctx.listUsers as never,
	});

	return {
		verdict: outcome.verdict === "AUTO_APPROVE" ? "auto_approved" : outcome.verdict === "OWNER_REVIEW" ? "owner_review" : "denied",
		decisionId: outcome.decision.id,
		executedRef: outcome.executedRef ?? null,
		reason: outcome.decision.reason ?? null,
		// The message the model should relay to the customer (already injection-safe).
		customerMessage: outcome.customerMessage,
		detail: outcome.customerMessage,
	};
}

function runEscalate(args: Record<string, unknown>): SupportToolOutcome {
	const departmentRaw = typeof args.department === "string" ? args.department.trim().toLowerCase() : "general";
	const department = (SUPPORT_DEPARTMENTS as readonly string[]).includes(departmentRaw)
		? (departmentRaw as SupportDepartment)
		: "general";
	const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim().slice(0, 500) : "Escalated by the support assistant.";
	return {
		result: { escalated: true, department, reason, detail: `Routing this ticket to the ${department} team. A human will follow up.` },
		escalate: { department, reason },
	};
}
