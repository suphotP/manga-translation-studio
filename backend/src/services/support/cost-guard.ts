// AI support-agent cost / anti-abuse guardrails — the enforcement PRIMITIVES.
//
// The owner's #1 concern: support-ticket spam must NEVER burn LLM tokens. This
// module is the single choke point the ticket/agent code calls BEFORE any
// gpt-5.5 request. It is library-only (no ticket schema, no routes) so it can be
// imported and unit-tested in isolation, and so every layer reads ONE config
// block (serverConfig.ticketAiGuardrails + AppConfig.aiSupportEnabled).
//
// Decision model: every check returns allow | handoff | reject.
//   - allow   → safe to call the model.
//   - handoff → accept the ticket but route to the HUMAN queue (no model call).
//               Never a 5xx; the user still gets a graceful "a teammate will
//               follow up" reply. Used for kill-switch, over-budget, unverified
//               email, disposable email, gibberish.
//   - reject  → drop the message entirely (duplicate flood / empty). Cheaper than
//               handoff; nothing is queued.
//
// EVERYTHING fails CLOSED: when in doubt we hand off to a human rather than spend
// tokens. This gates real money.

import { createHash } from "crypto";
import { loadConfig, serverConfig, type TicketAiGuardrailsConfig } from "../../config.js";
import type { AppConfig } from "../../types/index.js";
import { createSharedRateLimitStore, type RateLimitStore } from "../../middleware/rate-limit.js";
import { moderatePromptLocal } from "../moderation.js";
import {
	aiSupportBudgetRejections,
	aiSupportHandoffs,
	aiSupportSpamRejections,
	aiSupportKillSwitchActive,
} from "../../middleware/metrics.js";
import { sumTicketAiTokensThb, startOfCurrentUtcMonth } from "../usage-ledger.js";

export type SupportAdmissionOutcome = "allow" | "handoff" | "reject";

export type SupportAdmissionReason =
	| "ok"
	| "kill_switch"
	| "budget_exhausted"
	| "ticket_message_cap"
	| "ticket_token_cap"
	| "ticket_counters_unavailable"
	| "unauthenticated"
	| "email_unverified"
	| "disposable_email"
	| "duplicate_message"
	| "message_too_short"
	| "gibberish"
	| "empty_message";

export interface SupportAdmissionDecision {
	outcome: SupportAdmissionOutcome;
	reason: SupportAdmissionReason;
	/** Human-readable detail for logs / a graceful canned reply. */
	detail: string;
}

export interface SupportBudgetDecision {
	/** True when the agent may run (kill-switch off AND budget remaining). */
	allowed: boolean;
	reason: Extract<SupportAdmissionReason, "ok" | "kill_switch" | "budget_exhausted">;
	monthlyBudgetThb: number;
	spentThb: number;
	remainingThb: number;
}

export interface SupportAdmissionUser {
	/** Authenticated user id. Absent/empty → unauthenticated. */
	id?: string;
	email?: string;
	emailVerified?: boolean;
}

export interface SupportAdmissionMessage {
	/** Raw user text for this ticket message. */
	text: string;
	/** The ticket the message belongs to (scopes dup detection). */
	ticketId?: string;
}

/**
 * The ticket's CURRENT lifetime AI cost counters (Layer 2). These are the
 * `support_tickets.ai_message_count` / `ai_tokens_spent` columns bumped by
 * SupportTicketStore.incrementAiUsage AFTER each agent reply. The admission gate
 * reads them BEFORE the next reply and hands off once either ceiling is reached,
 * so a single ticket can never run the agent unboundedly.
 */
export interface SupportAdmissionTicket {
	/** Lifetime count of AI replies already spent on this ticket. */
	aiMessageCount?: number;
	/** Lifetime AI tokens already spent on this ticket. */
	aiTokensSpent?: number;
}

export interface EvaluateSupportAdmissionInput {
	user: SupportAdmissionUser;
	message: SupportAdmissionMessage;
	/**
	 * The ticket's current lifetime AI cost counters (Layer 2 per-ticket caps).
	 * Pass the SupportTicketRecord (or its ai_message_count / ai_tokens_spent
	 * counters) so the gate can hand off a ticket that has hit its lifetime cap
	 * BEFORE any model call.
	 *
	 * FAIL-CLOSED CONTRACT: whenever `message.ticketId` is present this object is
	 * REQUIRED — the gate must read the ticket's real counters before spending. A
	 * present ticketId with a missing/undefined `ticket` (or non-finite counters)
	 * cannot be proven under cap, so the gate hands off (ticket_counters_unavailable)
	 * rather than defaulting the counters to 0 and admitting a ticket that may
	 * already be at its lifetime cap. The no-ticketId path (a brand-new ticket whose
	 * id is not yet assigned) is the only genuine first-message case and is allowed
	 * to omit this.
	 */
	ticket?: SupportAdmissionTicket;
	/**
	 * The operator kill-switch. OPTIONAL but never permissive: when omitted the
	 * budget gate reads the LIVE `loadConfig().aiSupportEnabled` (env kill-switch +
	 * persisted toggle), and if even that read fails it treats the agent as
	 * DISABLED. A caller can therefore NEVER reach `allow` by simply not passing
	 * `config` while AI support is off. An explicit value is always honored.
	 */
	config?: Pick<AppConfig, "aiSupportEnabled">;
	guardrails?: TicketAiGuardrailsConfig;
	/** Injectable for tests: the shared rate-limit store used for dup detection. */
	store?: RateLimitStore;
	now?: () => number;
}

function reflectKillSwitchGauge(active: boolean): void {
	aiSupportKillSwitchActive.set(active ? 1 : 0);
}

/**
 * Resolve the kill-switch in a way that can NEVER be bypassed by omitting
 * `config`. An EXPLICIT caller config is always honored (so callers that already
 * loaded the live config, or a test, can pass it). When NO config is supplied we
 * derive the live operator value from `loadConfig().aiSupportEnabled` — which
 * folds in the env kill-switch (AI_SUPPORT_KILL_SWITCH) and the persisted
 * runtime toggle — rather than defaulting to `true`. If even that read throws we
 * fail CLOSED (treat the agent as DISABLED), because we cannot prove the operator
 * left it on. The old `?? true` default let a caller that omitted `config` reach
 * an `allow` while the operator had hard-disabled the agent — the exact spend
 * hole this guard exists to prevent.
 */
function resolveAiSupportEnabled(config?: Pick<AppConfig, "aiSupportEnabled">): boolean {
	if (config?.aiSupportEnabled !== undefined) return config.aiSupportEnabled;
	try {
		return loadConfig().aiSupportEnabled;
	} catch {
		// Cannot read the live kill-switch → assume DISABLED (fail closed). Spending
		// tokens while blind to the operator's switch is the one outcome we refuse.
		return false;
	}
}

/**
 * Layer 3 — the hard ceiling. Checks the operator kill-switch AND the GLOBAL
 * monthly $ budget (its own summed query, NOT the per-project meter). Returns a
 * typed decision; NEVER throws to a 5xx. When the agent is hard-disabled the
 * kill-switch prometheus gauge is set so an operator can alert on it.
 *
 * Kill-switch is resolved fail-CLOSED: an explicit `options.config` wins, else the
 * LIVE `loadConfig().aiSupportEnabled` is read (env + persisted toggle), and a
 * failed read is treated as DISABLED. Omitting `config` can NEVER yield `allow`
 * while the operator has the agent off.
 */
export async function evaluateSupportBudget(options: {
	config?: Pick<AppConfig, "aiSupportEnabled">;
	guardrails?: TicketAiGuardrailsConfig;
	now?: () => number;
} = {}): Promise<SupportBudgetDecision> {
	const guardrails = options.guardrails ?? serverConfig.ticketAiGuardrails;
	// FAIL CLOSED: when `config` is omitted we read the LIVE kill-switch rather than
	// assuming the agent is on. An explicit config is still honored.
	const aiSupportEnabled = resolveAiSupportEnabled(options.config);
	const monthlyBudgetThb = guardrails.monthlyBudgetThb;
	const now = (options.now ?? Date.now)();

	if (!aiSupportEnabled) {
		reflectKillSwitchGauge(true);
		return { allowed: false, reason: "kill_switch", monthlyBudgetThb, spentThb: 0, remainingThb: monthlyBudgetThb };
	}

	let spentThb = 0;
	try {
		spentThb = await sumTicketAiTokensThb(startOfCurrentUtcMonth(now));
	} catch {
		// Fail CLOSED: if we cannot read spend we cannot prove we are under budget,
		// so we treat it as exhausted and hand off to a human rather than risk an
		// unbounded spend. (This is the whole point of the layer.)
		reflectKillSwitchGauge(true);
		return { allowed: false, reason: "budget_exhausted", monthlyBudgetThb, spentThb: monthlyBudgetThb, remainingThb: 0 };
	}

	const remainingThb = Math.max(0, round(monthlyBudgetThb - spentThb));
	// A 0 budget means "no AI spend at all"; spentThb >= budget means exhausted.
	const exhausted = spentThb >= monthlyBudgetThb;
	reflectKillSwitchGauge(exhausted);
	if (exhausted) {
		return { allowed: false, reason: "budget_exhausted", monthlyBudgetThb, spentThb, remainingThb };
	}
	return { allowed: true, reason: "ok", monthlyBudgetThb, spentThb, remainingThb };
}

// ── Layer 4: spam pre-checks (no tokens spent) ──────────────────────────────

/** Outcome of the dedup probe: a genuine duplicate, a clean first-send, or a
 * store failure (which the gate treats as fail-closed -> human handoff). */
type DedupProbe = "duplicate" | "first" | "store_error";

/**
 * sha256-fingerprint duplicate detection in the shared rate-limit store with a
 * short TTL window. Returns a TAGGED outcome so the admission gate can tell a
 * genuine duplicate flood (coalesce -> reject) apart from a store failure (fail
 * CLOSED -> route to a human, never allow). Reusing the rate-limit store keeps it
 * Redis-backed in prod with zero new infra.
 */
async function probeDuplicateSupportMessage(
	input: { ticketId?: string; userId?: string; text: string },
	options: { store?: RateLimitStore; guardrails?: TicketAiGuardrailsConfig; now?: () => number } = {},
): Promise<DedupProbe> {
	const guardrails = options.guardrails ?? serverConfig.ticketAiGuardrails;
	const store = options.store ?? createSharedRateLimitStore();
	const windowMs = Math.max(1, guardrails.dedupWindowSeconds) * 1000;
	const now = (options.now ?? Date.now)();
	// FAIL CLOSED on a missing / non-string body: coerce to "" so a caller cannot
	// crash the dedup probe by omitting text. Combined with the empty-message reject
	// in classifySupportMessageContent, an absent body can never reach the model.
	const safeText = typeof input.text === "string" ? input.text.trim() : "";
	const fingerprint = createHash("sha256")
		.update(`${input.ticketId ?? "no-ticket"}\u0000${input.userId ?? "anon"}\u0000${safeText}`)
		.digest("hex");
	const key = `support-dedup:${fingerprint}`;
	try {
		const result = await store.increment(key, windowMs, now);
		// First send in the window: count 1 (not a dup). Any repeat: dup.
		return result.count > 1 ? "duplicate" : "first";
	} catch {
		return "store_error";
	}
}

/**
 * sha256-fingerprint duplicate detection in the shared rate-limit store with a
 * short TTL window. The SAME (ticket, message) sent more than once inside the
 * window is treated as a duplicate flood (coalesced by the caller).
 *
 * FAILS CLOSED: if the dedup store is unavailable we cannot prove this message is
 * NOT a duplicate flood, so we return `true` (treat as blocked) and route it to a
 * human rather than spend tokens. This matches the rest of the support layer's
 * posture (the rate-limit ticket policies, the budget guard, and the
 * unverified/disposable gates all fail to a human handoff). The alternative
 * (return false / allow) would let an attacker who can knock the limiter offline
 * drive unbounded LLM spend -- the exact failure this layer exists to prevent.
 * Worst case for a legit user is a single message handed to a teammate.
 */
export async function isDuplicateSupportMessage(
	input: { ticketId?: string; userId?: string; text: string },
	options: { store?: RateLimitStore; guardrails?: TicketAiGuardrailsConfig; now?: () => number } = {},
): Promise<boolean> {
	// Only a clean first-send is "not blocked"; both a genuine duplicate and a
	// store error are blocked (the latter is fail-closed for spend safety).
	return (await probeDuplicateSupportMessage(input, options)) !== "first";
}

/**
 * Local, token-free content checks: empty / too-short / gibberish. Reuses
 * moderation.ts moderatePromptLocal for the empty-prompt rule so the support path
 * and the AI image path share one definition of "empty".
 */
export function classifySupportMessageContent(
	text: string,
	guardrails: TicketAiGuardrailsConfig = serverConfig.ticketAiGuardrails,
): { ok: boolean; reason: Extract<SupportAdmissionReason, "ok" | "empty_message" | "message_too_short" | "gibberish"> } {
	// FAIL CLOSED on a missing / non-string body: a caller that omits `text` (or
	// passes a non-string) cannot be proven to carry a real question, so it is
	// treated as empty (reject) rather than throwing a 5xx or slipping through.
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (moderatePromptLocal(trimmed).reason === "Prompt is empty") {
		return { ok: false, reason: "empty_message" };
	}
	if (trimmed.length < guardrails.minMessageLength) {
		return { ok: false, reason: "message_too_short" };
	}
	if (isGibberish(trimmed)) {
		return { ok: false, reason: "gibberish" };
	}
	return { ok: true, reason: "ok" };
}

// Cheap gibberish heuristic (no model): a long run of identical chars, no
// whitespace in a long string, or almost no letters. Conservative — a false
// positive only costs a human handoff, never a hard reject.
function isGibberish(text: string): boolean {
	if (text.length < 8) return false;
	if (/(.)\1{9,}/.test(text)) return true;
	const letters = (text.match(/[\p{L}]/gu) ?? []).length;
	const letterRatio = letters / text.length;
	if (letterRatio < 0.2) return true;
	if (text.length > 20 && !/\s/.test(text) && letterRatio < 0.5) return true;
	return false;
}

/** Layer 4 — disposable / throwaway email domain check (lowercased). */
export function isDisposableEmail(
	email: string | undefined,
	guardrails: TicketAiGuardrailsConfig = serverConfig.ticketAiGuardrails,
): boolean {
	const domain = email?.trim().toLowerCase().split("@")[1]?.trim();
	if (!domain) return false;
	return guardrails.disposableEmailDomains.includes(domain);
}

// ── Layer 2: per-ticket lifetime caps (no tokens spent) ─────────────────────

/**
 * Layer 2 — the per-ticket lifetime ceiling. A single ticket may only ever drive
 * the agent for `maxMessages` replies and `maxTokens` tokens of spend; once
 * EITHER counter has reached its cap the ticket is handed to a human for the rest
 * of its life so one ticket cannot loop the model unboundedly (the global budget
 * is Layer 3; this is the per-conversation backstop). Returns `null` when both
 * counters are still under cap, else the tripping handoff reason.
 *
 * Comparison is `>=` (at OR over the cap → handoff): once a ticket has spent
 * `maxMessages` replies the NEXT reply must not run. A cap of 0 means "no AI on
 * this ticket at all" → always handoff. Counters are floored/clamped so a
 * negative or non-finite stored value can never read as "under cap".
 */
export function evaluateTicketCaps(
	ticket: SupportAdmissionTicket | undefined,
	guardrails: TicketAiGuardrailsConfig = serverConfig.ticketAiGuardrails,
): Extract<SupportAdmissionReason, "ticket_message_cap" | "ticket_token_cap"> | null {
	const messageCount = clampCounter(ticket?.aiMessageCount);
	const tokensSpent = clampCounter(ticket?.aiTokensSpent);
	// Messages first: it is the cheaper-to-reason-about ceiling and the more common
	// abuse vector (a chatty loop), but either tripping is a handoff.
	if (messageCount >= guardrails.maxMessages) return "ticket_message_cap";
	if (tokensSpent >= guardrails.maxTokens) return "ticket_token_cap";
	return null;
}

// Coerce a stored counter to a safe non-negative integer. A missing/NaN/negative
// value is treated as 0 (a brand-new ticket) — it must NEVER be treated as
// "already over cap" in a way that mis-handoffs, nor wrap to a huge number.
function clampCounter(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

// True when a message names an existing ticket (ticketId set) but its real
// lifetime counters cannot be resolved, so the per-ticket cap CANNOT be enforced.
// Fail-closed gate for evaluateSupportAdmission: such a message must hand off, not
// silently default its counters to 0 and run the model. A message with no
// ticketId is a genuine brand-new conversation, so it is NOT "unavailable".
//
// "Unavailable" = the ticket object is missing entirely, OR at least one counter
// is NOT explicitly present as a trustworthy value (undefined/null/NaN/Infinity/
// negative/non-integer/non-number). There is NO implicit-0 path for an EXISTING
// ticket: once a ticketId is set the caller MUST supply the ticket's real
// aiMessageCount AND aiTokensSpent (a freshly created ticket has them persisted as
// 0). A bare `{}` (or a partial `{ aiMessageCount }`) cannot be proven under cap,
// so it fails closed — defaulting a CAPPED ticket's missing counters to 0 is the
// exact spend hole this gate exists to close.
function ticketCountersUnavailable(
	ticketId: string | undefined,
	ticket: SupportAdmissionTicket | undefined,
): boolean {
	if (!ticketId?.trim()) return false; // brand-new ticket, no id yet → not unavailable
	if (!ticket) return true; // ticketId present but no counters supplied → fail closed
	return !isReadableCounter(ticket.aiMessageCount) || !isReadableCounter(ticket.aiTokensSpent);
}

// A counter we are willing to enforce against: it MUST be explicitly present as a
// finite, non-negative INTEGER. There is no implicit-0 path — `undefined`/`null`
// (a counter the caller failed to load) is NOT trustworthy, because defaulting it
// to 0 would let an EXISTING ticket that is already at its lifetime cap run the
// model. A NaN/Infinity/negative/fractional stored value is likewise corrupt and
// refused. The gate ahead (ticketCountersUnavailable) only invokes this once a
// ticketId is present, so a genuine brand-new message (no ticketId) is unaffected;
// a real freshly-created ticket carries persisted 0/0 counters and passes.
function isReadableCounter(value: number | undefined): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// ── Unified admission gate ──────────────────────────────────────────────────

/**
 * THE single entry point the ticket/agent code calls before any model work.
 * Runs the cheap → expensive ladder and stops at the first failing layer:
 *   Layer 0  engagement gate (auth + verified email)
 *   Layer 2  per-ticket lifetime caps (messages / tokens) → handoff
 *   Layer 4  disposable email → handoff
 *   Layer 4  content (empty/short/gibberish) → reject(empty) / handoff
 *   Layer 4  duplicate flood → reject
 *   Layer 3  kill-switch / global budget → handoff
 * Returns allow only when every layer passes. Emits the prom counters on trip.
 */
export async function evaluateSupportAdmission(
	input: EvaluateSupportAdmissionInput,
): Promise<SupportAdmissionDecision> {
	const guardrails = input.guardrails ?? serverConfig.ticketAiGuardrails;

	// Layer 0 — engagement gate. The agent NEVER runs for anonymous accounts; an
	// unverified account is accepted but handed to a human (config-gated).
	const userId = input.user.id?.trim();
	if (!userId) {
		return handoff("unauthenticated", "Sign in to chat with support — your ticket was queued for a teammate.");
	}
	if (guardrails.requireVerifiedEmail && input.user.emailVerified !== true) {
		return handoff("email_unverified", "Verify your email to use the support assistant — a teammate will follow up.");
	}

	// Layer 2 — per-ticket lifetime caps. A ticket that has already spent its
	// message/token budget is handed to a human BEFORE any further spend layer, so
	// a long-running ticket can never loop the model. Token-free.
	//
	// FAIL CLOSED on missing counters: if the message names a ticket (ticketId set)
	// the caller MUST supply that ticket's real lifetime counters. If they are
	// absent or unreadable we cannot prove the ticket is still under its cap, so we
	// hand off rather than default the counters to 0 and admit a ticket that may
	// already be at its ceiling (the exact spend hole this layer exists to close).
	// Only a message with NO ticketId is a genuine brand-new conversation and may
	// proceed with empty (0/0) counters.
	if (ticketCountersUnavailable(input.message.ticketId, input.ticket)) {
		return handoff(
			"ticket_counters_unavailable",
			"We could not load this conversation's history — a teammate will follow up.",
		);
	}
	const capReason = evaluateTicketCaps(input.ticket, guardrails);
	if (capReason) {
		return handoff(capReason, "This conversation has reached its assistant limit — a teammate will follow up.");
	}

	// Layer 4 — disposable email → human queue (never the model).
	if (isDisposableEmail(input.user.email, guardrails)) {
		return handoff("disposable_email", "Your ticket was queued for a teammate to review.");
	}

	// Layer 4 — content checks (token-free). Empty is a hard reject (nothing to
	// answer); short/gibberish are handed to a human rather than dropped.
	const content = classifySupportMessageContent(input.message.text, guardrails);
	if (!content.ok) {
		if (content.reason === "empty_message") {
			return reject("empty_message", "Please include a message describing your issue.");
		}
		return handoff(content.reason, "Your ticket was queued for a teammate to review.");
	}

	// Layer 4 — duplicate-message flood within the dedup window. A genuine
	// duplicate is coalesced (reject). A store error FAILS CLOSED: we cannot prove
	// the message is not a flood, so it is routed to a human (handoff) rather than
	// allowed through to spend tokens — consistent with the budget/rate-limit
	// posture. It is NOT a reject (which would silently drop a possibly-legit
	// first send); the human queue still receives it.
	const dedup = await probeDuplicateSupportMessage(
		{ ticketId: input.message.ticketId, userId, text: input.message.text },
		{ store: input.store, guardrails, now: input.now },
	);
	if (dedup === "duplicate") {
		return reject("duplicate_message", "We already received that message — a teammate will follow up.");
	}
	if (dedup === "store_error") {
		return handoff("duplicate_message", "Your ticket was queued for a teammate to review.");
	}

	// Layer 3 — kill-switch + global monthly budget (the hard money gate).
	const budget = await evaluateSupportBudget({ config: input.config, guardrails, now: input.now });
	if (!budget.allowed) {
		if (budget.reason === "budget_exhausted") aiSupportBudgetRejections.inc();
		return handoff(budget.reason, "A teammate will follow up with you shortly.");
	}

	return { outcome: "allow", reason: "ok", detail: "ok" };
}

function handoff(reason: SupportAdmissionReason, detail: string): SupportAdmissionDecision {
	aiSupportHandoffs.inc({ reason });
	return { outcome: "handoff", reason, detail };
}

function reject(reason: SupportAdmissionReason, detail: string): SupportAdmissionDecision {
	aiSupportSpamRejections.inc({ reason });
	return { outcome: "reject", reason, detail };
}

function round(value: number): number {
	return Math.round(value * 10000) / 10000;
}
