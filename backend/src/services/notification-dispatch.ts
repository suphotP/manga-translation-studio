// Central notification dispatcher — the SINGLE choke point every feature calls
// to notify a user.
//
// notify({ userId, type, ... }) is the only producer path. It:
//   1. resolves the user's effective per-(type × channel) preferences,
//   2. writes an in-app notification (if in_app is enabled for this type),
//   3. sends a transactional email (if email is enabled AND we have a recipient),
//
// honoring the user's preferences on every channel so the pref check can never
// be bypassed by a feature reaching into the notification store directly.
//
// Adding a new notification type is trivial: add it to NOTIFICATION_TYPES +
// DEFAULT_CHANNEL_PREFS (in notifications.ts / notification-preferences.ts) and,
// optionally, an entry in NOTIFICATION_DISPATCH_REGISTRY below to customise the
// email subject/CTA label. Everything else flows through the generic email
// template, so no per-type email template is required.
//
// Resilience: every side effect is best-effort and swallows its own errors
// (the realtime-emitters convention) so a notification failure never blocks the
// business action that triggered it. notify() reports what it did via the
// returned NotifyResult for callers/tests that care.

import { authUserStore as defaultUserStore } from "./auth-users.js";
import { sendTransactionalEmail, type SendResult } from "./mailer.js";
import {
	notificationPreferenceStore as defaultPreferenceStore,
	type NotificationChannel,
	type NotificationPreferenceStore,
} from "./notification-preferences.js";
import {
	notificationStore as defaultNotificationStore,
	categoryForNotificationType,
	type NotificationRecord,
	type NotificationStore,
	type NotificationType,
} from "./notifications.js";
import { publishUserScopedEvent } from "./realtime-bus.js";

/**
 * Minimal recipient lookup the dispatcher needs to resolve an email + display
 * name from a `userId` when the caller didn't pass `input.email`. Structurally
 * satisfied by the real `authUserStore` (its `load()` returns a `User` with the
 * `email`/`name` fields), and trivially fakeable in tests.
 */
export interface NotifyRecipientLookup {
	load(userId: string): Promise<{ email?: string | null; name?: string | null } | null>;
}

/**
 * Per-type dispatch metadata. Optional — a type with no registry entry still
 * works (it uses the notification title as the email subject + no CTA label).
 * This is the typed registry that makes new types trivial to add.
 */
export interface NotificationDispatchEntry {
	/** Default email subject. Falls back to the notify() `title` when absent. */
	emailSubject?: (input: NotifyInput) => string;
	/** Default CTA label for the email button (rendered only when linkUrl is set). */
	emailActionLabel?: string;
}

export const NOTIFICATION_DISPATCH_REGISTRY: Partial<Record<NotificationType, NotificationDispatchEntry>> = {
	task_assigned: { emailActionLabel: "Open task" },
	work_assigned: { emailActionLabel: "Open work" },
	review_cancelled: { emailActionLabel: "Open review" },
	revision_requested: { emailActionLabel: "Open work" },
	ticket_opened: { emailActionLabel: "View ticket" },
	ticket_replied: { emailActionLabel: "View reply" },
	ticket_escalated: { emailActionLabel: "View ticket" },
	ticket_resolved: { emailActionLabel: "View ticket" },
	invite_received: { emailActionLabel: "Accept invite" },
	quota_warning_80pct: { emailActionLabel: "Add credits" },
	quota_frozen: { emailActionLabel: "Add credits" },
	payment_succeeded: { emailActionLabel: "View receipt" },
	payment_failed: { emailActionLabel: "Update billing" },
	account_export_ready: { emailActionLabel: "Download export" },
};

export interface NotifyInput {
	/** Recipient user id (the notification owner). Required. */
	userId: string;
	/** Recipient email — required only if the email channel should fire. */
	email?: string;
	/** Display name for the email greeting. Optional. */
	name?: string;
	type: NotificationType;
	title: string;
	body?: string;
	linkUrl?: string;
	workspaceId?: string;
	metadata?: Record<string, unknown>;
	/**
	 * Restrict delivery to this subset of channels (still gated by prefs). When
	 * omitted, every channel the user has enabled fires.
	 */
	channels?: NotificationChannel[];
	/** Locale for the email render. Defaults to "en". */
	locale?: string;
	/**
	 * Per-call CTA label override for the email button. When set (and a linkUrl is
	 * present) it wins over the type's registry default — used to LOCALIZE the CTA for
	 * a non-English recipient (the registry labels are English-only). Ignored when no
	 * linkUrl is present (no button is rendered).
	 */
	emailActionLabel?: string;
	/** Idempotency key forwarded to the mailer (dedupe at the provider). */
	idempotencyKey?: string;
	/**
	 * DURABLE in-app dedupe key. When set, the in-app notification ROW is written at most
	 * once per (userId, inAppDedupeKey) — a re-fire returns the existing row instead of
	 * inserting a second. Unlike `idempotencyKey` (which only protects the EMAIL at the
	 * provider), this protects the persisted in-app row, so two webhook deliveries for the
	 * SAME charge (Dodo payment.succeeded + invoice.paid) collapse to ONE in-app notice,
	 * and a quota tier notice fires once per workspace+period even when the pre-reservation
	 * usage snapshot was unavailable. Best-effort: a dedupe-store hiccup never blocks notify().
	 */
	inAppDedupeKey?: string;
	/**
	 * ADDITIONAL dedupe keys to test for an existing row BEFORE writing (the row itself is
	 * still written under `inAppDedupeKey`). Used when a single logical event (e.g. one Dodo
	 * charge) can present DIFFERENT identifiers across its deliveries — `payment.succeeded`
	 * carrying `payment_id` while a sibling `invoice.paid` carries only `invoice_id`. The
	 * caller derives one dedupe key per candidate identifier of the charge; if a row already
	 * exists under ANY of them (or under `inAppDedupeKey`), the write is suppressed. This
	 * mirrors the add-on tombstone's `extractAddonGrantCandidateRefs` pattern (check ALL
	 * candidate refs, not just the single primary), closing the divergent-key double-row leak.
	 * The primary `inAppDedupeKey` SHOULD be the most-shared identifier (e.g. invoice_id when
	 * present) so independent deliveries converge on the same write key; the candidate list is
	 * the symmetric backstop for the reversed shape. Best-effort: a lookup hiccup never blocks.
	 */
	inAppDedupeKeyCandidates?: string[];
	/**
	 * MANDATORY safety notice: write the in-app notification even if the recipient
	 * has disabled the in_app channel for this type. Used ONLY for notices the
	 * product contract guarantees a user must always see (e.g. a review they were
	 * doing was cancelled). Email stays pref-gated + best-effort. The in_app
	 * preference is a UX nicety; it must not be able to hide a mandatory notice
	 * that the API/UI claims was delivered.
	 */
	mandatoryInApp?: boolean;
}

export interface NotifyResult {
	/** True when an in-app notification row was written. */
	inAppDelivered: boolean;
	/** True when an email send was attempted (regardless of provider success). */
	emailAttempted: boolean;
	/** The mailer result, when an email was attempted. */
	emailResult?: SendResult;
	/** Channels that were skipped, with a reason — useful for tests/telemetry. */
	skipped: Array<{ channel: NotificationChannel; reason: string }>;
}

export interface NotifyDeps {
	notificationStore?: NotificationStore;
	preferenceStore?: NotificationPreferenceStore;
	/** Seam for tests; defaults to the real mailer pipeline. */
	sendEmail?: typeof sendTransactionalEmail;
	/**
	 * Resolve a recipient's email + display name from their `userId` when the
	 * caller didn't pass `input.email`. Defaults to the real user store. Only
	 * consulted when the email channel is actually going to fire (requested +
	 * pref enabled) and no explicit `input.email` was supplied.
	 */
	userStore?: NotifyRecipientLookup;
	/** Resolve the absolute unsubscribe/preferences URL appended to emails. */
	unsubscribeUrl?: string;
	/**
	 * Realtime publisher for the live SSE bell (W2.7). Defaults to the PER-USER
	 * realtime channel (NOT the shared workspace stream) so a notification's private
	 * title/body/metadata is delivered only to the recipient's own subscriber
	 * connection(s) — never readable off the wire by another workspace member
	 * (a16 re-review P1 #1). Tests inject a spy. Best-effort: a publish failure never
	 * blocks notify(). Only fired for an in-app notification that carries a
	 * workspaceId (the per-user channel is namespaced under the workspace); personal
	 * notifications fall back to poll.
	 */
	publishRealtime?: (
		workspaceId: string,
		userId: string,
		kind: "notification_new",
		data: Record<string, unknown>,
	) => Promise<unknown>;
}

function wantsChannel(input: NotifyInput, channel: NotificationChannel): boolean {
	return !input.channels || input.channels.includes(channel);
}

// Notification types that may be delivered as an EMAIL-ONLY message to an address
// that has no platform account yet (a pending invite). Strictly limited so the
// no-userId email path can never become a generic unauthenticated email sink.
const EMAIL_ONLY_INVITE_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
	"invite_received",
]);

function isValidRecipientEmail(email: string | undefined): boolean {
	const value = email?.trim();
	// Minimal, deliberately strict shape check (the address comes from a validated
	// invite endpoint upstream; this is a defense-in-depth guard, not the validator).
	return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * True when this is an email-only invite (no userId) that we should still deliver
 * over email: an invite type + the caller requested the email channel + a valid
 * recipient email is present.
 */
function isEmailOnlyInviteEligible(input: NotifyInput): boolean {
	return EMAIL_ONLY_INVITE_TYPES.has(input.type)
		&& wantsChannel(input, "email")
		&& isValidRecipientEmail(input.email);
}

/**
 * Send the invite email for a pending (no-account-yet) invitee. There is no user
 * row to look up prefs for, so this fires the email directly (best-effort). Mirrors
 * the email render used in the main notify() path.
 */
async function sendEmailOnlyInvite(
	input: NotifyInput,
	sendEmail: typeof sendTransactionalEmail,
	unsubscribeUrl: string | undefined,
	result: NotifyResult,
): Promise<void> {
	const email = input.email!.trim();
	try {
		const entry = NOTIFICATION_DISPATCH_REGISTRY[input.type];
		const subject = entry?.emailSubject?.(input) ?? input.title;
		const actionLabel = input.linkUrl ? input.emailActionLabel ?? entry?.emailActionLabel ?? "Open" : undefined;
		result.emailResult = await sendEmail(
			"notification-generic",
			{
				user: { name: input.name ?? "", email },
				subject,
				heading: input.title,
				body: input.body ?? input.title,
				actionLabel,
				actionUrl: input.linkUrl,
				unsubscribeUrl: unsubscribeUrl ?? "/settings/notifications",
			},
			input.locale ?? "en",
			{ idempotencyKey: input.idempotencyKey },
		);
		result.emailAttempted = true;
	} catch (error) {
		console.warn(`[notify] email-only invite send failed for ${input.type}: ${describeError(error)}`);
		result.skipped.push({ channel: "email", reason: "send_failed" });
	}
}

/**
 * The single notification producer. Honors per-(type × channel) preferences on
 * every channel. Best-effort: each side effect swallows its own error so a
 * notification failure never propagates to the triggering business action.
 */
export async function notify(input: NotifyInput, deps: NotifyDeps = {}): Promise<NotifyResult> {
	const notificationStore = deps.notificationStore ?? defaultNotificationStore;
	const preferenceStore = deps.preferenceStore ?? defaultPreferenceStore;
	const sendEmail = deps.sendEmail ?? sendTransactionalEmail;
	const userStore = deps.userStore ?? defaultUserStore;
	const publishRealtime = deps.publishRealtime
		?? ((workspaceId, userId, kind, data) => publishUserScopedEvent(workspaceId, userId, kind, data));

	const result: NotifyResult = { inAppDelivered: false, emailAttempted: false, skipped: [] };

	const userId = input.userId?.trim();
	if (!userId) {
		result.skipped.push({ channel: "in_app", reason: "missing_user" });
		// Email-only invite path: an INVITE to an address that has no platform account
		// yet (a pending email invite) has no userId — and therefore no in-app row and no
		// per-user email prefs to consult. It must STILL send the invite email, otherwise
		// email-only invites are silently dropped. Restricted to invite types + a present
		// recipient email so this can never become a generic unauthenticated email sink.
		if (isEmailOnlyInviteEligible(input)) {
			await sendEmailOnlyInvite(input, sendEmail, deps.unsubscribeUrl, result);
		} else {
			result.skipped.push({ channel: "email", reason: "missing_user" });
		}
		return result;
	}

	// ── in-app ──────────────────────────────────────────────────────────────
	if (wantsChannel(input, "in_app")) {
		// A mandatory safety notice bypasses the in_app pref — the user must always
		// get this in-app row (the pref can still silence email). Otherwise honor
		// the per-(type × channel) preference as usual.
		let enabled = Boolean(input.mandatoryInApp);
		if (!enabled) {
			try {
				enabled = await preferenceStore.isEnabled(userId, input.type, "in_app");
			} catch (error) {
				console.warn(`[notify] in_app pref lookup failed for ${input.type}: ${describeError(error)}`);
			}
		}
		if (enabled) {
			try {
				const dedupeKey = input.inAppDedupeKey?.trim() || undefined;
				// Durable once-only guard: if an in-app row for this (userId, dedupeKey) already
				// exists, do NOT write a second row and do NOT re-publish the realtime event — a
				// same-charge succeeded+invoice pair / a re-fired quota tier yields ONE notice.
				// The store's create() repeats this guard as the authoritative backstop against a
				// concurrent race; this pre-check just avoids the redundant realtime fan-out.
				//
				// Candidate keys (inAppDedupeKeyCandidates): one logical event may present
				// DIFFERENT identifiers across deliveries (Dodo payment.succeeded → payment_id;
				// sibling invoice.paid → invoice_id-only). The row is WRITTEN under the primary
				// `dedupeKey`, but we suppress the write when a row already exists under the
				// primary OR ANY candidate key — mirroring the add-on tombstone's all-candidate
				// match — so divergent-key siblings of the same charge collapse to ONE row.
				const lookupKeys: string[] = [];
				const seenKeys = new Set<string>();
				for (const key of [dedupeKey, ...(input.inAppDedupeKeyCandidates ?? [])]) {
					const trimmed = key?.trim();
					if (trimmed && !seenKeys.has(trimmed)) {
						seenKeys.add(trimmed);
						lookupKeys.push(trimmed);
					}
				}
				let existing: Awaited<ReturnType<NotificationStore["findByDedupeKey"]>> = null;
				for (const key of lookupKeys) {
					existing = await notificationStore.findByDedupeKey(userId, key);
					if (existing) break;
				}
				if (existing) {
					result.skipped.push({ channel: "in_app", reason: "duplicate" });
				} else {
					const created = await notificationStore.create({
						userId,
						workspaceId: input.workspaceId,
						type: input.type,
						title: input.title,
						body: input.body,
						linkUrl: input.linkUrl,
						metadata: input.metadata,
						dedupeKey,
					});
					result.inAppDelivered = true;
					// Live SSE fan-out (W2.7): publish the created notification onto the
					// recipient's workspace stream so the topbar bell updates immediately.
					// Best-effort + workspace-scoped only (the SSE stream is per-workspace);
					// the frontend store delivers it to the target userId only. A personal
					// notification (no workspaceId) has no stream → polling stays its path.
					await publishNotificationCreated(publishRealtime, created);
				}
			} catch (error) {
				console.warn(`[notify] in_app create failed for ${input.type}: ${describeError(error)}`);
				result.skipped.push({ channel: "in_app", reason: "create_failed" });
			}
		} else {
			result.skipped.push({ channel: "in_app", reason: "disabled_by_pref" });
		}
	} else {
		result.skipped.push({ channel: "in_app", reason: "not_requested" });
	}

	// ── email ───────────────────────────────────────────────────────────────
	// Order matters: check the pref BEFORE resolving the recipient so the
	// store lookup only happens when the email is actually going to fire. This
	// is what makes a default-ON email pref deliver even when the caller passed
	// only { userId, type } (the work_assigned bug). An explicit input.email
	// always wins and skips the lookup entirely.
	if (wantsChannel(input, "email")) {
		let enabled = false;
		try {
			enabled = await preferenceStore.isEnabled(userId, input.type, "email");
		} catch (error) {
			console.warn(`[notify] email pref lookup failed for ${input.type}: ${describeError(error)}`);
		}
		if (!enabled) {
			result.skipped.push({ channel: "email", reason: "disabled_by_pref" });
		} else {
			// Explicit recipient wins (no redundant store lookup). Otherwise the
			// dispatcher self-resolves email + display name from the user store so
			// every userId-only caller delivers default-on email correctly.
			let email = input.email?.trim();
			let name = input.name;
			if (!email) {
				try {
					const recipient = await userStore.load(userId);
					const resolvedEmail = recipient?.email?.trim();
					if (resolvedEmail) {
						email = resolvedEmail;
						if (name === undefined && recipient?.name) name = recipient.name;
					}
				} catch (error) {
					console.warn(`[notify] recipient lookup failed for ${input.type}: ${describeError(error)}`);
				}
			}
			if (!email) {
				// Fail-safe: couldn't resolve a recipient — skip email gracefully,
				// don't throw, don't block the in-app channel.
				result.skipped.push({ channel: "email", reason: "no_recipient" });
			} else {
				try {
					const entry = NOTIFICATION_DISPATCH_REGISTRY[input.type];
					const subject = entry?.emailSubject?.(input) ?? input.title;
					// Per-call label (localized by the caller) wins over the English registry default.
					const actionLabel = input.linkUrl ? input.emailActionLabel ?? entry?.emailActionLabel ?? "Open" : undefined;
					result.emailResult = await sendEmail(
						"notification-generic",
						{
							user: { name: name ?? "", email },
							subject,
							heading: input.title,
							body: input.body ?? input.title,
							actionLabel,
							actionUrl: input.linkUrl,
							unsubscribeUrl: deps.unsubscribeUrl ?? "/settings/notifications",
						},
						input.locale ?? "en",
						{ idempotencyKey: input.idempotencyKey },
					);
					result.emailAttempted = true;
				} catch (error) {
					// getMailer() never throws for the null provider (it logs), so this
					// only fires on a genuine send error — still best-effort.
					console.warn(`[notify] email send failed for ${input.type}: ${describeError(error)}`);
					result.skipped.push({ channel: "email", reason: "send_failed" });
				}
			}
		}
	} else {
		result.skipped.push({ channel: "email", reason: "not_requested" });
	}

	return result;
}

/**
 * Fan out a freshly-created in-app notification onto the recipient's PER-USER
 * realtime channel so their bell updates live (W2.7 SSE bridge). The private
 * payload is delivered ONLY to that user's subscriber connection(s) — it never
 * touches the shared workspace stream, so a workspace member can never read
 * another member's notification frame off the wire (a16 re-review P1 #1). The
 * `userId` field is retained as a harmless render/route hint (it is the
 * recipient's own id), but it is NO LONGER the privacy boundary — channel routing
 * is. The payload mirrors the GET /notifications item shape (record + `category`).
 *
 * Skipped (poll-only) when the notification has no workspaceId: the per-user
 * channel is namespaced under a workspace, so a personal notification has no
 * channel to ride. Best-effort — the publisher swallows its own errors, and we
 * guard again here so a realtime hiccup never turns a successful in-app write into
 * a failure.
 */
async function publishNotificationCreated(
	publishRealtime: (workspaceId: string, userId: string, kind: "notification_new", data: Record<string, unknown>) => Promise<unknown>,
	record: NotificationRecord,
): Promise<void> {
	const workspaceId = record.workspaceId?.trim();
	if (!workspaceId) return;
	const userId = record.userId?.trim();
	if (!userId) return;
	try {
		await publishRealtime(workspaceId, userId, "notification_new", {
			// `userId` is a render/route hint (the recipient's own id). Privacy is
			// enforced by per-user channel routing, NOT this field. The rest is the
			// renderable notification payload (same shape as the REST list item).
			userId: record.userId,
			notification: {
				id: record.id,
				userId: record.userId,
				workspaceId: record.workspaceId,
				type: record.type,
				title: record.title,
				body: record.body,
				linkUrl: record.linkUrl,
				metadata: record.metadata,
				readAt: record.readAt,
				createdAt: record.createdAt,
				category: categoryForNotificationType(record.type),
			},
		});
	} catch (error) {
		console.warn(`[notify] realtime publish failed for ${record.type}: ${describeError(error)}`);
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
