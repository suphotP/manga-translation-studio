// Best-effort transactional billing notifications.
//
// This module is the single, reusable wiring that FIRES the already-authored
// billing email templates (`billing-receipt`, `payment-failed`) + the matching
// in-app notifications (`payment_succeeded`, `payment_failed`, `quota_warning_80pct`,
// `quota_frozen`). The templates themselves are NOT authored here — their content,
// money/period formatting and copy live in services/mailer/templates/* and are
// rendered unchanged. This file only resolves the recipient + supplies the data the
// template asks for, then sends.
//
// HARD CONTRACTS (mirrors the realtime-emitters / notification-dispatch convention):
//   - EVERY send is BEST-EFFORT: each function wraps its own work in try/catch,
//     logs, and swallows. A mail/notify failure NEVER propagates to the caller, so
//     it can never fail or roll back a payment webhook, a credit mutation, or a
//     usage reservation.
//   - The caller is responsible for REPLAY-SAFETY (fire-once gating). These helpers
//     are pure side-effects; they do not dedupe. Callers gate on their own once-only
//     signal (the Dodo webhook's fresh-insert `processed` flag; the quota
//     threshold-crossing transition) so a redelivery / repeat request does not
//     re-send.
//   - The caller is responsible for AFTER-COMMIT ordering: invoke these only AFTER
//     the business transaction has committed.

import { getSharedBunSql } from "./sql-pool.js";
import { sendTransactionalEmail } from "./mailer.js";
import { notify } from "./notification-dispatch.js";
import { authUserStore as defaultAuthUserStore, type AuthUserStore } from "./auth-users.js";
import { resolveWorkspacePlan } from "./plans.js";

/** A SQL client able to read the workspace owner. Structurally satisfied by Bun.SQL. */
export interface BillingNotificationSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

/**
 * A shared, lazily-created SQL client for owner resolution OUTSIDE of an existing
 * transaction (the usage/quota path has no tx to borrow). Returns null in file mode
 * (no DATABASE_URL) — the resolver then degrades to the caller-supplied fallback. The
 * client is read-only here (a single SELECT), so it is safe to reuse a singleton.
 */
let sharedSqlClient: BillingNotificationSqlClient | null | undefined;
export function billingNotificationSqlClient(): BillingNotificationSqlClient | null {
	if (sharedSqlClient !== undefined) return sharedSqlClient;
	const url = process.env.DATABASE_URL?.trim();
	sharedSqlClient = url ? (getSharedBunSql(url) as unknown as BillingNotificationSqlClient) : null;
	return sharedSqlClient;
}

export interface BillingRecipient {
	/** Workspace-owner user id, when resolvable (drives the in-app notification + pref-gated email). */
	userId?: string;
	/** Recipient email (owner account email, else the billing email from the event/account). */
	email?: string;
	/** Display name for the email greeting. */
	name?: string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && EMAIL_SHAPE.test(trimmed) ? trimmed : undefined;
}

/**
 * Resolve the workspace billing recipient from EXISTING data only (no new PII):
 *   1. the workspace owner (`workspaces.owner_user_id` → auth account) — preferred,
 *      because a userId lets the in-app notification + pref-gated email fire;
 *   2. else the billing email passed in (from the event subject / billing account),
 *      matched back to an account when one exists so the in-app row can still land.
 *
 * Best-effort + fail-soft: any lookup error returns whatever was resolved so far
 * (possibly an email-only recipient), never throws.
 */
export async function resolveWorkspaceBillingRecipient(
	client: BillingNotificationSqlClient | null,
	workspaceId: string,
	fallbackBillingEmail?: string | null,
	deps: { authUserStore?: AuthUserStore } = {},
): Promise<BillingRecipient> {
	const authUserStore = deps.authUserStore ?? defaultAuthUserStore;
	const recipient: BillingRecipient = {};
	const billingEmail = normalizeEmail(fallbackBillingEmail);

	let ownerUserId: string | undefined;
	if (client) {
		try {
			const rows = await client.unsafe<{ owner_user_id: string | null }>(
				"SELECT owner_user_id FROM workspaces WHERE workspace_id = $1 LIMIT 1",
				[workspaceId],
			);
			ownerUserId = rows[0]?.owner_user_id?.trim() || undefined;
		} catch (error) {
			console.warn(`[billing-notify] owner lookup failed for ${workspaceId}: ${describeError(error)}`);
		}
	}

	if (ownerUserId) {
		recipient.userId = ownerUserId;
		try {
			const owner = await authUserStore.load(ownerUserId);
			recipient.email = normalizeEmail(owner?.email) ?? billingEmail;
			if (owner?.name) recipient.name = owner.name;
		} catch (error) {
			console.warn(`[billing-notify] owner account load failed for ${ownerUserId}: ${describeError(error)}`);
			recipient.email = billingEmail;
		}
	} else if (billingEmail) {
		// No owner row — try to attach the in-app row to an existing account for the
		// billing email (still NOT new PII; the email already lives on the billing event).
		recipient.email = billingEmail;
		try {
			const account = await authUserStore.findByEmail(billingEmail);
			if (account?.id) {
				recipient.userId = account.id;
				if (account.name) recipient.name = account.name;
			}
		} catch (error) {
			console.warn(`[billing-notify] billing-email account lookup failed: ${describeError(error)}`);
		}
	}

	return recipient;
}

export interface PaymentReceiptInput {
	recipient: BillingRecipient;
	workspaceId: string;
	workspaceName: string;
	planId?: string | null;
	/** Major-unit amount (e.g. 12.99). Omit when the event carried no trustworthy amount. */
	amount?: number | null;
	currency?: string | null;
	invoiceUrl?: string;
	periodStart?: string | Date;
	periodEnd?: string | Date;
	locale?: string;
	/** Forwarded to the mailer for provider-level dedupe (best-effort). */
	idempotencyKey?: string;
	/**
	 * PRIMARY anchor for the durable IN-APP receipt row. Prefer the most-shared identifier
	 * (e.g. invoice_id) so independent deliveries of one charge converge on the SAME write
	 * key. Falls back to `idempotencyKey` when omitted. Kept distinct from `idempotencyKey`
	 * (the EMAIL provider key, payment_id-first) so the email dedupe behavior is unchanged.
	 */
	inAppIdempotencyKey?: string;
	/**
	 * Idempotency keys for EVERY identifier this charge can present across deliveries
	 * (e.g. `dodo-receipt:pay_X` AND `dodo-receipt:inv_X`). The in-app row is written under
	 * `idempotencyKey`'s `:inapp` key, but suppressed if a row already exists under ANY of
	 * these candidates' `:inapp` keys — so a payment.succeeded(payment_id) + invoice.paid
	 * (invoice_id-only) pair for the SAME charge collapses to ONE in-app receipt row.
	 */
	idempotencyKeyCandidates?: string[];
}

/**
 * Fire the EXISTING `billing-receipt` email (content unchanged) + the in-app
 * `payment_succeeded` notification. Best-effort: never throws.
 *
 * When the event carried no trustworthy amount/currency we DO NOT fabricate a
 * receipt figure — we skip the dedicated receipt email and still write the in-app
 * notification so the owner is informed without a misleading money value.
 */
export async function sendPaymentReceiptBestEffort(input: PaymentReceiptInput): Promise<void> {
	const { recipient } = input;
	const planName = resolveWorkspacePlan(input.planId ?? undefined).name;

	// In-app notification (pref-gated). Email channel is suppressed here so the
	// dedicated billing-receipt template below is the only email the owner gets.
	// inAppDedupeKey is keyed on the resolved CHARGE identity (the invoice-first
	// `inAppIdempotencyKey`, else `idempotencyKey` = `dodo-receipt:<paymentRef>`), so a
	// payment.succeeded + invoice.paid pair for the SAME charge collapses to ONE in-app
	// receipt row — even when the invoice carries ONLY an invoice_id and the payment carries
	// a payment_id (they converge on the shared invoice_id, and the candidate list catches
	// the reversed shape). Two DISTINCT charges (different refs) each write their own (P1-2).
	// When no key is supplied we fall back to the no-dedupe behavior (a manual/legacy caller).
	const inAppPrimary = (input.inAppIdempotencyKey ?? input.idempotencyKey)?.trim() || undefined;
	await safeNotify({
		userId: recipient.userId,
		email: recipient.email,
		name: recipient.name,
		type: "payment_succeeded",
		title: "Payment received",
		body: `We received your payment for ${planName}.`,
		workspaceId: input.workspaceId,
		linkUrl: input.invoiceUrl ?? "/settings/billing",
		channels: ["in_app"],
		idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:inapp` : undefined,
		// In-app row written under the invoice-first PRIMARY (so a charge's deliveries
		// converge), falling back to the email key when no distinct in-app key was supplied.
		inAppDedupeKey: inAppPrimary ? `${inAppPrimary}:inapp` : undefined,
		// All candidate identifiers of THIS charge → suppress the in-app row if any sibling
		// delivery (which may derive a divergent primary key) already wrote one.
		inAppDedupeKeyCandidates: (input.idempotencyKeyCandidates ?? [])
			.map((candidate) => candidate.trim())
			.filter((candidate) => candidate.length > 0)
			.map((candidate) => `${candidate}:inapp`),
	});

	// Dedicated billing-receipt email (authored template, rendered unchanged). Only
	// sent when we have a recipient email AND a trustworthy money figure — never
	// fabricate amount/currency.
	const amount = typeof input.amount === "number" && Number.isFinite(input.amount) ? input.amount : null;
	const currency = input.currency?.trim();
	if (!recipient.email || amount === null || !currency) return;
	try {
		await sendTransactionalEmail(
			"billing-receipt",
			{
				user: { name: recipient.name ?? "", email: recipient.email },
				workspaceName: input.workspaceName,
				planName,
				amount,
				currency,
				invoiceUrl: input.invoiceUrl ?? "/settings/billing",
				periodStart: input.periodStart ?? new Date(),
				periodEnd: input.periodEnd ?? new Date(),
			},
			input.locale ?? "en",
			{ idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:receipt` : undefined },
		);
	} catch (error) {
		console.warn(`[billing-notify] billing-receipt send failed for ${input.workspaceId}: ${describeError(error)}`);
	}
}

export interface PaymentFailedInput {
	recipient: BillingRecipient;
	workspaceId: string;
	workspaceName: string;
	retryUrl?: string;
	daysUntilDowngrade: number;
	locale?: string;
	idempotencyKey?: string;
}

/**
 * Fire the EXISTING `payment-failed` email (content unchanged) + the in-app
 * `payment_failed` notification. Best-effort: never throws.
 */
export async function sendPaymentFailedBestEffort(input: PaymentFailedInput): Promise<void> {
	const { recipient } = input;
	const retryUrl = input.retryUrl ?? "/settings/billing";

	await safeNotify({
		userId: recipient.userId,
		email: recipient.email,
		name: recipient.name,
		type: "payment_failed",
		title: "Payment failed",
		body: `We couldn't process your latest payment for ${input.workspaceName}.`,
		workspaceId: input.workspaceId,
		linkUrl: retryUrl,
		channels: ["in_app"],
		idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:inapp` : undefined,
	});

	if (!recipient.email) return;
	try {
		await sendTransactionalEmail(
			"payment-failed",
			{
				user: { name: recipient.name ?? "", email: recipient.email },
				workspaceName: input.workspaceName,
				retryUrl,
				daysUntilDowngrade: Math.max(0, Math.round(input.daysUntilDowngrade)),
			},
			input.locale ?? "en",
			{ idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:failed` : undefined },
		);
	} catch (error) {
		console.warn(`[billing-notify] payment-failed send failed for ${input.workspaceId}: ${describeError(error)}`);
	}
}

export interface QuotaNotifyInput {
	recipient: BillingRecipient;
	workspaceId: string;
	/** Percentage used (0..100+), used in the in-app body. */
	percentUsed?: number | null;
	locale?: string;
	idempotencyKey?: string;
	/**
	 * Durable in-app once-only key (workspace+period+tier). When set, the in-app notice
	 * row is written at most once per key — so even a genuine crossing observed twice in
	 * the same billing period yields ONE notice (P1-1).
	 */
	inAppDedupeKey?: string;
}

/**
 * Fire the in-app `quota_warning_80pct` notification + pref-gated email (via the
 * generic notification template — there is no dedicated 80%-warning template; the
 * `ai-quota-warning` template is a separate per-call surface). Best-effort.
 */
export async function sendQuotaWarningBestEffort(input: QuotaNotifyInput): Promise<void> {
	const pct = typeof input.percentUsed === "number" && Number.isFinite(input.percentUsed)
		? Math.round(input.percentUsed)
		: null;
	await safeNotify({
		userId: input.recipient.userId,
		email: input.recipient.email,
		name: input.recipient.name,
		type: "quota_warning_80pct",
		title: "You've used 80% of your AI credits",
		body: pct !== null
			? `Your workspace has used ${pct}% of this month's AI credit allowance.`
			: "Your workspace has used 80% of this month's AI credit allowance.",
		workspaceId: input.workspaceId,
		linkUrl: "/settings/billing",
		locale: input.locale,
		idempotencyKey: input.idempotencyKey,
		inAppDedupeKey: input.inAppDedupeKey,
	});
}

/**
 * Fire the in-app `quota_frozen` notification + pref-gated email. Best-effort.
 */
export async function sendQuotaFrozenBestEffort(input: QuotaNotifyInput): Promise<void> {
	await safeNotify({
		userId: input.recipient.userId,
		email: input.recipient.email,
		name: input.recipient.name,
		type: "quota_frozen",
		title: "AI credits exhausted",
		body: "Your workspace has reached its monthly AI credit limit. Add credits to keep generating.",
		workspaceId: input.workspaceId,
		linkUrl: "/settings/billing",
		locale: input.locale,
		idempotencyKey: input.idempotencyKey,
		inAppDedupeKey: input.inAppDedupeKey,
	});
}

// The monthly AI-credit usage threshold (percent) that fires a one-time warning.
export const QUOTA_WARNING_THRESHOLD_PERCENT = 80;

export interface QuotaTransitionInput {
	workspaceId: string;
	/** Optional actor user id — the in-app fallback recipient when the owner can't be resolved. */
	actorUserId?: string;
	/** Monthly AI-credit percentUsed BEFORE this reservation (null when no limit / unmetered). */
	beforePercent: number | null | undefined;
	/** Monthly AI-credit percentUsed AFTER this reservation. */
	afterPercent: number | null | undefined;
	/** Billing email fallback when the owner has no resolvable account email. */
	billingEmail?: string | null;
	/** Clock override (tests): the "now" used to derive the YYYY-MM dedupe period. */
	now?: Date;
	deps?: {
		sqlClient?: BillingNotificationSqlClient | null;
		authUserStore?: AuthUserStore;
		sendQuotaWarning?: typeof sendQuotaWarningBestEffort;
		sendQuotaFrozen?: typeof sendQuotaFrozenBestEffort;
	};
}

/**
 * Fire the quota notifications EXACTLY ONCE per threshold-crossing.
 *
 * TWO independent once-only guarantees, so a re-fire is impossible from EITHER axis:
 *
 *   1. TRANSITION gate — fire only on a GENUINE crossing: a KNOWN `before` strictly
 *      below the tier and an `after` at/above it. A `null`/unknown `before` means
 *      "we could not snapshot pre-reservation usage" — it is NOT inferred as 0, so it
 *      can NEVER manufacture a fresh crossing. (Round-1 read `(before ?? 0)`, which
 *      treated unknown as a below-threshold value and thus re-fired the warning/frozen
 *      notice on every request once usage sat ≥80/≥100. Worst case: a REJECTED
 *      over-quota request forced `after:100`, re-spamming `quota_frozen` on every
 *      blocked attempt — that caller no longer emits at all; see ai-job-submission.)
 *
 *   2. DURABLE per-tier dedupe — even a genuine crossing writes the in-app notice at
 *      most ONCE per (workspace, billing period, tier) via `inAppDedupeKey`. So if two
 *      requests in the same period both observe a crossing (e.g. a racing pair), only
 *      ONE in-app row lands; the marker naturally resets next period (the key embeds
 *      the YYYY-MM period) and re-arms if usage later climbs back across the tier in a
 *      NEW period.
 *
 * Best-effort end-to-end: any failure logs + swallows so a usage reservation can never
 * be broken by a notification.
 *
 *   - crosses 80%  → quota_warning_80pct
 *   - crosses 100% → quota_frozen (the workspace has hit its monthly AI allowance)
 */
export async function emitQuotaTransitionBestEffort(input: QuotaTransitionInput): Promise<void> {
	try {
		const before = numericPercent(input.beforePercent);
		const after = numericPercent(input.afterPercent);
		if (after === null) return; // unmetered / no limit → nothing to warn about
		// Unknown `before` (snapshot failed): do NOT infer a crossing. Treating it as 0
		// (round-1) re-fired on every at/above-threshold request. With no trustworthy
		// pre-reservation baseline we cannot prove THIS request is the crossing, so we
		// stay silent rather than risk re-spam.
		if (before === null) return;

		const crossedWarning = before < QUOTA_WARNING_THRESHOLD_PERCENT && after >= QUOTA_WARNING_THRESHOLD_PERCENT;
		const crossedFrozen = before < 100 && after >= 100;
		if (!crossedWarning && !crossedFrozen) return;

		const sqlClient = input.deps?.sqlClient !== undefined ? input.deps.sqlClient : billingNotificationSqlClient();
		let recipient = await resolveWorkspaceBillingRecipient(
			sqlClient,
			input.workspaceId,
			input.billingEmail,
			{ authUserStore: input.deps?.authUserStore },
		);
		// Fall back to the actor (the submitter) when the owner couldn't be resolved
		// (e.g. file mode with no workspaces table) so the notice still reaches someone.
		if (!recipient.userId && !recipient.email && input.actorUserId) {
			recipient = { userId: input.actorUserId };
		}

		const sendWarning = input.deps?.sendQuotaWarning ?? sendQuotaWarningBestEffort;
		const sendFrozen = input.deps?.sendQuotaFrozen ?? sendQuotaFrozenBestEffort;
		// Period component for the durable dedupe key — the monthly AI allowance resets
		// monthly, so the once-only marker is scoped to the current billing month (UTC).
		const period = (input.now ?? new Date()).toISOString().slice(0, 7); // YYYY-MM

		if (crossedFrozen) {
			// At/over the limit: send the stronger "frozen" notice (it supersedes the 80%
			// warning for this crossing — a single reservation that jumps straight past
			// 100% should not double-email).
			await sendFrozen({
				recipient,
				workspaceId: input.workspaceId,
				percentUsed: after,
				inAppDedupeKey: `quota_frozen:${input.workspaceId}:${period}`,
			});
		} else if (crossedWarning) {
			await sendWarning({
				recipient,
				workspaceId: input.workspaceId,
				percentUsed: after,
				inAppDedupeKey: `quota_warning_80pct:${input.workspaceId}:${period}`,
			});
		}
	} catch (error) {
		console.warn(`[billing-notify] quota transition emit failed for ${input.workspaceId}: ${describeError(error)}`);
	}
}

function numericPercent(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * notify() already swallows its own per-channel errors, but guard the call itself.
 * Accepts an OPTIONAL userId (the recipient may be email-only); notify() requires a
 * string, so we pass "" when absent — for these billing types notify then writes no
 * in-app row (no userId) and the email channel is either suppressed (receipts use the
 * dedicated template) or skipped (no userId → no pref lookup), which is the intended
 * best-effort degradation.
 */
async function safeNotify(input: Omit<Parameters<typeof notify>[0], "userId"> & { userId?: string }): Promise<void> {
	if (!input.userId && !input.email) return; // nothing to deliver to
	try {
		await notify({ ...input, userId: input.userId ?? "" });
	} catch (error) {
		console.warn(`[billing-notify] notify(${input.type}) failed: ${describeError(error)}`);
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
