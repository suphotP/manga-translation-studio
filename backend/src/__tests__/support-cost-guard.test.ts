// Tests for the AI support cost / anti-abuse guardrail primitives (rank7).
// Verifies every layer fails CLOSED: kill-switch + global budget → handoff,
// spam pre-checks (dup/gibberish/disposable/empty) → reject/handoff, and the
// engagement gate (unauthenticated/unverified) → handoff. The global budget is
// asserted to be cross-tenant (not the per-project meter).

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryRateLimitStore } from "../middleware/rate-limit.js";
import { UsageLedger } from "../services/usage-ledger.js";
import type { TicketAiGuardrailsConfig } from "../config.js";

function guardrails(overrides: Partial<TicketAiGuardrailsConfig> = {}): TicketAiGuardrailsConfig {
	return {
		msgPerMinute: 4,
		msgPerHour: 30,
		tokenUnitsPerMinute: 120,
		maxMessages: 12,
		maxTokens: 40000,
		monthlyBudgetThb: 5000,
		thbPerToken: 0.001,
		requireVerifiedEmail: true,
		disposableEmailDomains: ["mailinator.com", "evil.test"],
		dedupWindowSeconds: 60,
		minMessageLength: 2,
		...overrides,
	};
}

const VERIFIED = { id: "u-1", email: "real@example.com", emailVerified: true } as const;
const GOOD_MESSAGE = { text: "My checkout failed but I was charged twice." } as const;

describe("support cost guard — budget + kill-switch (Layer 3)", () => {
	test("kill-switch off → handoff, never a model call, and flips the prom gauge", async () => {
		const { evaluateSupportBudget } = await import("../services/support/cost-guard.js");
		const decision = await evaluateSupportBudget({
			config: { aiSupportEnabled: false },
			guardrails: guardrails(),
		});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("kill_switch");
	});

	test("under budget → allowed; spend at/over budget → handoff (budget_exhausted)", async () => {
		const { evaluateSupportBudget } = await import("../services/support/cost-guard.js");
		const dir = mkdtempSync(join(tmpdir(), "support-budget-"));
		try {
			// A tiny budget so a couple of replies blow through it.
			const cfg = guardrails({ monthlyBudgetThb: 1, thbPerToken: 0.001 });
			const now = () => Date.parse("2026-05-15T10:00:00.000Z");

			const { recordTicketAiTokens, usageLedger } = await import("../services/usage-ledger.js");
			void usageLedger;

			// Before any spend → allowed.
			const before = await evaluateSupportBudget({ config: { aiSupportEnabled: true }, guardrails: cfg, now });
			expect(before.allowed).toBe(true);
			expect(before.remainingThb).toBe(1);

			// Spend 1.0 THB (1000 tokens * 0.001) → budget exhausted.
			await recordTicketAiTokens({ ticketId: "tk-1", messageId: "m-1", tokens: 1000, thbPerToken: 0.001, now: now() });
			const after = await evaluateSupportBudget({ config: { aiSupportEnabled: true }, guardrails: cfg, now });
			expect(after.allowed).toBe(false);
			expect(after.reason).toBe("budget_exhausted");
			expect(after.remainingThb).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("budget meter on a fresh File ledger is global across tenants", () => {
		const dir = mkdtempSync(join(tmpdir(), "support-budget-global-"));
		try {
			const ledger = new UsageLedger(join(dir, "ledger.json"));
			const monthStart = Date.parse("2026-05-01T00:00:00.000Z");
			const mid = Date.parse("2026-05-10T00:00:00.000Z");
			ledger.recordTicketAiTokens({ ticketId: "a", messageId: "1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-a", projectId: "p-a", now: mid });
			ledger.recordTicketAiTokens({ ticketId: "b", messageId: "1", tokens: 1000, thbPerToken: 0.001, workspaceId: "ws-b", projectId: "p-b", now: mid });
			expect(ledger.sumTicketAiTokensThb(monthStart)).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// A rate-limit store whose increment always throws, to exercise the fail-closed
// posture of the dedup pre-check (P1: a store error must NOT allow the message).
class ThrowingRateLimitStore {
	increment(): never {
		throw new Error("dedup store offline");
	}
}

describe("support cost guard — per-ticket lifetime caps (Layer 2)", () => {
	test("evaluateTicketCaps: trips at OR over MAX_MESSAGES / MAX_TOKENS, else null", async () => {
		const { evaluateTicketCaps } = await import("../services/support/cost-guard.js");
		const cfg = guardrails({ maxMessages: 3, maxTokens: 1000 });
		// Under both caps → null (allowed to proceed).
		expect(evaluateTicketCaps({ aiMessageCount: 2, aiTokensSpent: 999 }, cfg)).toBeNull();
		// At the message cap → handoff reason.
		expect(evaluateTicketCaps({ aiMessageCount: 3, aiTokensSpent: 0 }, cfg)).toBe("ticket_message_cap");
		// Over the message cap → still the message reason.
		expect(evaluateTicketCaps({ aiMessageCount: 4, aiTokensSpent: 0 }, cfg)).toBe("ticket_message_cap");
		// At the token cap (messages still under) → token reason.
		expect(evaluateTicketCaps({ aiMessageCount: 0, aiTokensSpent: 1000 }, cfg)).toBe("ticket_token_cap");
		expect(evaluateTicketCaps({ aiMessageCount: 0, aiTokensSpent: 5000 }, cfg)).toBe("ticket_token_cap");
		// A brand-new ticket (undefined / missing counters) is under cap.
		expect(evaluateTicketCaps(undefined, cfg)).toBeNull();
		expect(evaluateTicketCaps({}, cfg)).toBeNull();
		// A 0 cap means "no AI at all on this ticket" → always handoff.
		expect(evaluateTicketCaps({ aiMessageCount: 0, aiTokensSpent: 0 }, guardrails({ maxMessages: 0 }))).toBe("ticket_message_cap");
	});

	test("admission: a ticket AT MAX_MESSAGES is handed off (not allowed), even for a perfect message", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-cap-msg" },
			ticket: { aiMessageCount: 12, aiTokensSpent: 0 }, // == maxMessages default 12
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_900_000,
		});
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("ticket_message_cap");
	});

	test("admission: a ticket AT MAX_TOKENS is handed off (not allowed)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-cap-tok" },
			ticket: { aiMessageCount: 1, aiTokensSpent: 40000 }, // == maxTokens default 40000
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_900_001,
		});
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("ticket_token_cap");
	});

	test("admission: a ticket just UNDER both caps still passes (allow)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-cap-ok" },
			ticket: { aiMessageCount: 11, aiTokensSpent: 39999 },
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_900_002,
		});
		expect(decision.outcome).toBe("allow");
	});

	// BUG 1 (P1) fail-closed: a message that names an existing ticket but supplies
	// NO real counters must hand off, NEVER admit (defaulting counters to 0 would let
	// a ticket already at its cap run the model — the exact spend hole this closes).
	test("admission: ticketId present but ticket OBJECT omitted → handoff (counters unavailable), not allow", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-no-counters" },
			// ticket deliberately omitted while ticketId is set.
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_900_010,
		});
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("ticket_counters_unavailable");
	});

	test("admission: ticketId present but a counter is corrupt (NaN/negative) → handoff (counters unavailable)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		for (const bad of [{ aiMessageCount: Number.NaN, aiTokensSpent: 0 }, { aiMessageCount: 0, aiTokensSpent: -5 }, { aiMessageCount: Infinity, aiTokensSpent: 0 }]) {
			const decision = await evaluateSupportAdmission({
				user: VERIFIED,
				message: { ...GOOD_MESSAGE, ticketId: "tk-corrupt" },
				ticket: bad,
				config: { aiSupportEnabled: true },
				guardrails: guardrails(),
				store,
				now: () => 1_700_000_900_011,
			});
			expect(decision.outcome).toBe("handoff");
			expect(decision.reason).toBe("ticket_counters_unavailable");
		}
	});

	// The genuine first-message case: NO ticketId yet (id not assigned). Empty
	// counters are allowed; the message proceeds through the rest of the ladder.
	test("admission: NO ticketId (brand-new ticket) with no ticket object still works (allow)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { text: "My checkout failed but I was charged twice." }, // no ticketId
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_900_012,
		});
		expect(decision.outcome).toBe("allow");
		expect(decision.reason).toBe("ok");
	});

	// BUG 1 (P1) fail-closed: a present-but-EMPTY ticket object ({}) on an existing
	// ticketId carries NO real counters. There is NO implicit-0 path for an existing
	// ticket — defaulting its missing counters to 0 would admit a ticket that may
	// already be at its lifetime cap. It MUST hand off (counters unavailable), never
	// allow. (This case previously, incorrectly, asserted `allow`.)
	test("admission: ticketId present with empty ticket object ({} — counters absent) → handoff (counters unavailable)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-empty-obj" },
			ticket: {},
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_900_013,
		});
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("ticket_counters_unavailable");
	});

	// BUG 1 (P1) fail-closed: a PARTIAL ticket object (only one counter present) on
	// an existing ticketId still cannot be proven under cap — the missing counter
	// could already be at its ceiling. It MUST hand off, never default to 0 + allow.
	test("admission: ticketId present with partial ticket object ({ aiMessageCount } only) → handoff (counters unavailable)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		for (const partial of [{ aiMessageCount: 5 }, { aiTokensSpent: 100 }] as const) {
			const decision = await evaluateSupportAdmission({
				user: VERIFIED,
				message: { ...GOOD_MESSAGE, ticketId: "tk-partial-obj" },
				ticket: partial,
				config: { aiSupportEnabled: true },
				guardrails: guardrails(),
				store,
				now: () => 1_700_000_900_013,
			});
			expect(decision.outcome).toBe("handoff");
			expect(decision.reason).toBe("ticket_counters_unavailable");
		}
	});

	// The positive counterpart: a fresh ticket whose counters are EXPLICITLY 0/0
	// (as persisted by SupportTicketStore on creation) is readable and proceeds.
	test("admission: ticketId present with explicit fresh 0/0 counters → allow", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-fresh-0-0" },
			ticket: { aiMessageCount: 0, aiTokensSpent: 0 },
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_900_0133,
		});
		expect(decision.outcome).toBe("allow");
		expect(decision.reason).toBe("ok");
	});

	// BUG 2 (P1): a 0 cap is a real "no AI" setting and must hand off on the FIRST
	// message (even a brand-new ticket with no ticketId).
	test("admission: maxMessages=0 → first message handoff (no AI)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { text: "My checkout failed but I was charged twice." },
			config: { aiSupportEnabled: true },
			guardrails: guardrails({ maxMessages: 0 }),
			store,
			now: () => 1_700_000_900_014,
		});
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("ticket_message_cap");
	});

	test("admission: maxTokens=0 → first message handoff (no AI)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { text: "My checkout failed but I was charged twice." },
			config: { aiSupportEnabled: true },
			guardrails: guardrails({ maxTokens: 0 }),
			store,
			now: () => 1_700_000_900_015,
		});
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("ticket_token_cap");
	});
});

describe("support cost guard — spam pre-checks (Layer 4, no tokens)", () => {
	test("duplicate message within the dedup window is detected (coalesced)", async () => {
		const { isDuplicateSupportMessage } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const now = () => 1_700_000_000_000;
		const input = { ticketId: "tk-1", userId: "u-1", text: "same text" };
		// First send is not a dup; the immediate repeat is.
		expect(await isDuplicateSupportMessage(input, { store, guardrails: guardrails(), now })).toBe(false);
		expect(await isDuplicateSupportMessage(input, { store, guardrails: guardrails(), now })).toBe(true);
		// A different ticket with the same text is NOT a dup (scoped per ticket).
		expect(await isDuplicateSupportMessage({ ...input, ticketId: "tk-2" }, { store, guardrails: guardrails(), now })).toBe(false);
	});

	test("dedup pre-check FAILS CLOSED on a store error (treats as blocked, never allow)", async () => {
		const { isDuplicateSupportMessage } = await import("../services/support/cost-guard.js");
		const store = new ThrowingRateLimitStore() as unknown as MemoryRateLimitStore;
		const blocked = await isDuplicateSupportMessage(
			{ ticketId: "tk-x", userId: "u-1", text: "hello" },
			{ store, guardrails: guardrails(), now: () => 1_700_000_000_000 },
		);
		expect(blocked).toBe(true); // store error => blocked, not allowed
	});

	test("admission: a dedup store error routes to a HUMAN (handoff), never an allow", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new ThrowingRateLimitStore() as unknown as MemoryRateLimitStore;
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-dedup-fail" },
			ticket: { aiMessageCount: 0, aiTokensSpent: 0 }, // fresh ticket so we reach the dedup layer
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_910_000,
		});
		// Fail closed: a store outage must not let the message reach the model.
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("duplicate_message");
	});

	test("content classifier flags empty / too-short / gibberish", async () => {
		const { classifySupportMessageContent } = await import("../services/support/cost-guard.js");
		expect(classifySupportMessageContent("   ", guardrails()).reason).toBe("empty_message");
		expect(classifySupportMessageContent("a", guardrails({ minMessageLength: 5 })).reason).toBe("message_too_short");
		expect(classifySupportMessageContent("aaaaaaaaaaaaaaaaaaaa", guardrails()).reason).toBe("gibberish");
		expect(classifySupportMessageContent("!!!!@@@@####$$$$%%%%", guardrails()).reason).toBe("gibberish");
		expect(classifySupportMessageContent("My payment failed, please help.", guardrails()).ok).toBe(true);
	});

	test("disposable email domains are detected (lowercased)", async () => {
		const { isDisposableEmail } = await import("../services/support/cost-guard.js");
		expect(isDisposableEmail("spammer@mailinator.com", guardrails())).toBe(true);
		expect(isDisposableEmail("SPAMMER@Evil.Test", guardrails())).toBe(true);
		expect(isDisposableEmail("real@example.com", guardrails())).toBe(false);
		expect(isDisposableEmail(undefined, guardrails())).toBe(false);
	});
});

describe("support cost guard — unified admission (engagement gate + ladder)", () => {
	let store: MemoryRateLimitStore;
	const now = () => 1_700_000_500_000;

	beforeEach(() => { store = new MemoryRateLimitStore(); });
	afterEach(() => { store.clear(); });

	function evaluate(overrides: Record<string, unknown> = {}) {
		return import("../services/support/cost-guard.js").then((m) => m.evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-1" },
			// A present ticketId REQUIRES real counters (fail-closed contract); supply a
			// fresh (0/0) ticket so the per-ticket cap layer can be enforced.
			ticket: { aiMessageCount: 0, aiTokensSpent: 0 },
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now,
			...overrides,
		}));
	}

	test("Layer 0: anonymous → handoff (agent never runs for unauthenticated)", async () => {
		const decision = await evaluate({ user: { id: undefined } });
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("unauthenticated");
	});

	test("Layer 0: unverified email → handoff when verification is required", async () => {
		const decision = await evaluate({ user: { id: "u-2", email: "x@example.com", emailVerified: false } });
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("email_unverified");
	});

	test("Layer 0: unverified allowed when requireVerifiedEmail is off (still passes other layers)", async () => {
		const decision = await evaluate({
			user: { id: "u-3", email: "x@example.com", emailVerified: false },
			guardrails: guardrails({ requireVerifiedEmail: false }),
		});
		expect(decision.outcome).toBe("allow");
	});

	test("Layer 4: disposable email → handoff", async () => {
		const decision = await evaluate({ user: { id: "u-4", email: "burner@mailinator.com", emailVerified: true } });
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("disposable_email");
	});

	test("Layer 4: empty message → reject; gibberish → handoff", async () => {
		const empty = await evaluate({ message: { text: "   ", ticketId: "tk-e" } });
		expect(empty.outcome).toBe("reject");
		expect(empty.reason).toBe("empty_message");

		const gibberish = await evaluate({ message: { text: "zzzzzzzzzzzzzzzzzzzz", ticketId: "tk-g" } });
		expect(gibberish.outcome).toBe("handoff");
		expect(gibberish.reason).toBe("gibberish");
	});

	test("Layer 4: duplicate flood → reject on the second identical send", async () => {
		const first = await evaluate();
		expect(first.outcome).toBe("allow");
		const second = await evaluate();
		expect(second.outcome).toBe("reject");
		expect(second.reason).toBe("duplicate_message");
	});

	test("Layer 3: kill-switch active → handoff even for a perfect message", async () => {
		const decision = await evaluate({ config: { aiSupportEnabled: false } });
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("kill_switch");
	});

	test("happy path: verified + clean + under budget + not killed → allow", async () => {
		const decision = await evaluate();
		expect(decision.outcome).toBe("allow");
		expect(decision.reason).toBe("ok");
	});
});

// ── P1 fail-open fix + defensive sweep ──────────────────────────────────────
// Every guardrail input that is OPTIONAL must fail CLOSED when omitted: omitting
// an argument can NEVER admit a message or undercount spend. The headline case is
// the kill-switch — when `config` is omitted the budget gate reads the LIVE
// loadConfig().aiSupportEnabled (env kill-switch + persisted toggle), NOT `true`.
describe("support cost guard — fail-closed on OMITTED inputs (P1 + sweep)", () => {
	const KILL = "AI_SUPPORT_KILL_SWITCH";
	let prevKill: string | undefined;

	beforeEach(() => { prevKill = process.env[KILL]; });
	afterEach(() => {
		if (prevKill === undefined) delete process.env[KILL];
		else process.env[KILL] = prevKill;
	});

	// THE P1 BUG: evaluateSupportBudget()/evaluateSupportAdmission() omitting `config`
	// must NOT default the kill-switch to ON. With the operator's env kill-switch
	// engaged, an omitted config must hand off (never allow).
	test("evaluateSupportBudget: OMIT config while kill-switch ON (env) → NOT allowed (kill_switch)", async () => {
		process.env[KILL] = "1"; // operator disabled the agent
		const { evaluateSupportBudget } = await import("../services/support/cost-guard.js");
		const decision = await evaluateSupportBudget({ guardrails: guardrails() }); // NO config
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("kill_switch");
	});

	test("evaluateSupportBudget: explicit aiSupportEnabled:true still ALLOWS under budget even when env kill-switch is ON", async () => {
		process.env[KILL] = "1"; // env says off, but caller passes an explicit on
		const { evaluateSupportBudget } = await import("../services/support/cost-guard.js");
		const decision = await evaluateSupportBudget({
			config: { aiSupportEnabled: true },
			guardrails: guardrails({ monthlyBudgetThb: 5000 }),
			now: () => Date.parse("2026-05-15T10:00:00.000Z"),
		});
		// Explicit caller config wins; only the OMITTED path reads the env.
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBe("ok");
	});

	test("evaluateSupportAdmission: OMIT config while kill-switch ON (env) → handoff (kill_switch), even for a perfect message", async () => {
		process.env[KILL] = "1";
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-omit-config" },
			ticket: { aiMessageCount: 0, aiTokensSpent: 0 },
			// config DELIBERATELY omitted → must derive the live kill-switch, not default true.
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_920_000,
		});
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("kill_switch");
	});

	test("evaluateSupportAdmission: OMIT config while kill-switch OFF (env) + clean message → allow", async () => {
		process.env[KILL] = "0"; // operator has the agent ON
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-omit-config-on" },
			ticket: { aiMessageCount: 0, aiTokensSpent: 0 },
			// config omitted; live env says ON, so this proceeds through the ladder.
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_921_000,
		});
		expect(decision.outcome).toBe("allow");
		expect(decision.reason).toBe("ok");
	});

	// Sweep: an empty config OBJECT (present but aiSupportEnabled undefined) must
	// also fall through to the live kill-switch, never be read as "on".
	test("evaluateSupportBudget: config:{} (aiSupportEnabled undefined) while kill-switch ON → NOT allowed", async () => {
		process.env[KILL] = "1";
		const { evaluateSupportBudget } = await import("../services/support/cost-guard.js");
		// A config object that arrived without aiSupportEnabled (e.g. a partial/legacy
		// JSON blob). Typed as the Pick, but the field is absent at runtime.
		const partialConfig = {} as { aiSupportEnabled: boolean };
		const decision = await evaluateSupportBudget({ config: partialConfig, guardrails: guardrails() });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("kill_switch");
	});

	// Sweep: OMITTED message.text (non-string body) must fail closed as empty
	// (reject), never reach the model and never throw a 5xx.
	test("classifySupportMessageContent: omitted / non-string text → empty_message (fail closed)", async () => {
		const { classifySupportMessageContent } = await import("../services/support/cost-guard.js");
		expect(classifySupportMessageContent(undefined as unknown as string, guardrails()).reason).toBe("empty_message");
		expect(classifySupportMessageContent(null as unknown as string, guardrails()).reason).toBe("empty_message");
		expect(classifySupportMessageContent(123 as unknown as string, guardrails()).reason).toBe("empty_message");
	});

	test("evaluateSupportAdmission: omitted message.text → reject(empty_message), never allow", async () => {
		process.env[KILL] = "0";
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { text: undefined as unknown as string, ticketId: "tk-no-text" },
			ticket: { aiMessageCount: 0, aiTokensSpent: 0 },
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_922_000,
		});
		expect(decision.outcome).toBe("reject");
		expect(decision.reason).toBe("empty_message");
	});

	// Sweep: OMITTED ticket counters while a ticketId is present → handoff (already
	// covered above, re-asserted here as part of the omission sweep for the table).
	test("evaluateSupportAdmission: omitted ticket counters (ticketId present) → handoff (counters_unavailable)", async () => {
		const { evaluateSupportAdmission } = await import("../services/support/cost-guard.js");
		const store = new MemoryRateLimitStore();
		const decision = await evaluateSupportAdmission({
			user: VERIFIED,
			message: { ...GOOD_MESSAGE, ticketId: "tk-sweep-counters" },
			config: { aiSupportEnabled: true },
			guardrails: guardrails(),
			store,
			now: () => 1_700_000_923_000,
		});
		expect(decision.outcome).toBe("handoff");
		expect(decision.reason).toBe("ticket_counters_unavailable");
	});

	// Sweep: OMITTED dedup store → cost-guard uses the real shared store; a store
	// ERROR fails closed (handoff). Re-asserted via an injected throwing store.
	test("isDuplicateSupportMessage: store error (limiter offline) → blocked (fail closed)", async () => {
		const { isDuplicateSupportMessage } = await import("../services/support/cost-guard.js");
		const store = new ThrowingRateLimitStore() as unknown as MemoryRateLimitStore;
		const blocked = await isDuplicateSupportMessage(
			{ ticketId: "tk-sweep-dedup", userId: "u-1", text: "hello" },
			{ store, guardrails: guardrails(), now: () => 1_700_000_924_000 },
		);
		expect(blocked).toBe(true);
	});
});
