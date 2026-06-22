// AI-support — gpt-5.5 agent loop + tools, MOCKED model (never calls real OpenAI).
//
// Coverage:
//   (a) admission DENY (per-ticket cap) → agent hands off, NEVER calls the model,
//       records NO tokens.
//   (b) a normal question → model reply path posts an `ai` message, records tokens
//       once (idempotent), bumps per-ticket usage, and notifies the requester.
//   (c) reconciliation: a real paid-but-uncredited payment → check_payment_reconciliation
//       detects it, grant_credit grants EXACTLY the discrepancy ONCE (idempotent +
//       audited), and a no-discrepancy case grants nothing + flags for human.
//   (d) the tool-iteration budget caps the loop (escalates instead of looping forever).
//   (e) escalate_to_department sets status=escalated + notifies.
//
// All stores are file/in-memory and isolated per test; the OpenAI provider is a
// scripted fake so NO real network call is made.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	FileSupportTicketStore,
	PostgresSupportTicketStore,
	type SupportTicketStore,
} from "../services/support-tickets.js";
import {
	FilePaymentTransactionsStore,
	PostgresPaymentTransactionsStore,
} from "../services/payment-transactions-store.js";
import {
	FilePaymentReconciliationStore,
	PostgresPaymentReconciliationStore,
} from "../services/support/payment-reconciliations-store.js";
import { FileOwnerDecisionStore, PostgresOwnerDecisionStore } from "../services/support/owner-decisions-store.js";
import { CreditService } from "../services/credits.js";
import { runSupportAgent, type RunSupportAgentInput } from "../services/support/ai-agent.js";
import {
	readSupportAgentMaxTokens,
	type SupportAiProvider,
	type SupportChatRequest,
	type SupportChatResult,
	type SupportToolCall,
} from "../services/support/ai-provider.js";
import { serverConfig } from "../config.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Scripted fake provider ──────────────────────────────────────────────────────
// Returns the next queued turn per complete() call. Records how many times the model
// was invoked so the DENY path can assert it was NEVER called.

interface ScriptTurn {
	content?: string;
	toolCalls?: SupportToolCall[];
	tokens?: number;
}

class FakeProvider implements Pick<SupportAiProvider, "isEnabled" | "complete" | "model"> {
	calls = 0;
	lastRequest?: SupportChatRequest;
	constructor(private readonly turns: ScriptTurn[], private readonly enabled = true) {}
	get model(): string {
		return "gpt-5.5";
	}
	isEnabled(): boolean {
		return this.enabled;
	}
	async complete(request: SupportChatRequest): Promise<SupportChatResult> {
		this.calls += 1;
		this.lastRequest = request;
		const turn = this.turns[Math.min(this.calls - 1, this.turns.length - 1)] ?? {};
		const total = turn.tokens ?? 100;
		return {
			content: turn.content ?? "",
			toolCalls: turn.toolCalls ?? [],
			usage: { promptTokens: Math.floor(total / 2), completionTokens: Math.ceil(total / 2), totalTokens: total },
			model: "gpt-5.5",
			requestMs: 1,
		};
	}
}

function toolCall(name: string, args: Record<string, unknown> = {}): SupportToolCall {
	return { id: `call_${name}_${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface Harness {
	store: SupportTicketStore;
	creditService: CreditService;
	paymentTxStore: FilePaymentTransactionsStore;
	reconciliationStore: FilePaymentReconciliationStore;
	decisionStore: FileOwnerDecisionStore;
	notifications: Array<{ type: string; userId: string; title: string; body: string }>;
	recordedTokens: Array<{ ticketId: string; messageId: string; tokens: number }>;
}

function harness(): Harness {
	const dir = tempDir("support-ai-agent-");
	return {
		store: new FileSupportTicketStore(join(dir, "tickets.json")),
		creditService: new CreditService(join(dir, "credits.json"), 50, { crossProcessSafe: false }),
		paymentTxStore: new FilePaymentTransactionsStore(join(dir, "payments.json")),
		reconciliationStore: new FilePaymentReconciliationStore(join(dir, "reconciliations.json")),
		decisionStore: new FileOwnerDecisionStore(join(dir, "decisions.json")),
		notifications: [],
		recordedTokens: [],
	};
}

const FAKE_USER = { id: "user-1", email: "real@example.com", emailVerified: true, name: "Real User", role: "editor", isActive: true } as never;
const loadUserFake = async () => FAKE_USER;
// An OWNER the owner-review path notifies (the proposal gate looks up owners by role).
const OWNER_USER = { id: "owner-1", email: "owner@example.com", name: "Owner", role: "owner", isActive: true };
const listOwnersFake = async () => [OWNER_USER];

function recordTokensFake(h: Harness) {
	const seen = new Set<string>();
	return async (input: { ticketId: string; messageId: string; tokens: number }) => {
		const key = `${input.ticketId}:${input.messageId}`;
		// Idempotent: a repeat (ticketId,messageId) does not add a second record.
		if (!seen.has(key)) {
			seen.add(key);
			h.recordedTokens.push({ ticketId: input.ticketId, messageId: input.messageId, tokens: input.tokens });
		}
		return { eventId: key } as never;
	};
}

function notifyFake(h: Harness) {
	return async (input: { type: string; userId: string; title?: string; body?: string }) => {
		h.notifications.push({ type: input.type, userId: input.userId, title: input.title ?? "", body: input.body ?? "" });
		return { inAppDelivered: true, emailAttempted: false, skipped: [] } as never;
	};
}

// The notification posted to the REQUESTER (the customer). Owner-review / internal notifies
// (owner-ops) go to other users and are not asserted as customer-facing here.
function requesterNotification(h: Harness, type: string) {
	return h.notifications.find((n) => n.type === type && n.userId === FAKE_USER.id);
}
const hasLatin = (s: string) => /[A-Za-z]/.test(s);

async function seedTicket(h: Harness, body: string, opts: { workspaceId?: string } = {}): Promise<{ ticketId: string; messageId: string }> {
	const ticket = await h.store.createTicket({
		requesterUserId: FAKE_USER.id,
		subject: "Help me",
		workspaceId: opts.workspaceId,
		body,
	});
	const thread = await h.store.listMessages(ticket.id, { limit: 1 });
	return { ticketId: ticket.id, messageId: thread.items[0]!.id };
}

// Run the agent against an isolated harness. The tool-backing stores are injected via
// the `toolStores` DI seam so the reconcile/credit tools hit our temp stores.
function runAgent(h: Harness, provider: FakeProvider, trigger: { ticketId: string; messageId: string }, extra: Partial<RunSupportAgentInput> = {}) {
	return runSupportAgent({
		ticketId: trigger.ticketId,
		triggerMessageId: trigger.messageId,
		store: h.store,
		provider: provider as never,
		notify: notifyFake(h) as never,
		recordTokens: recordTokensFake(h) as never,
		loadUser: loadUserFake as never,
		toolStores: {
			creditService: h.creditService,
			paymentTxStore: h.paymentTxStore,
			reconciliationStore: h.reconciliationStore,
			ticketStore: h.store,
			decisionStore: h.decisionStore,
			listUsers: listOwnersFake as never,
		},
		...extra,
	});
}

// ── (a) admission DENY → handoff, model NEVER called, no tokens ──────────────────

describe("AI support agent — admission gate", () => {
	test("a ticket at its per-ticket message cap hands off WITHOUT calling the model or spending tokens", async () => {
		const h = harness();
		const provider = new FakeProvider([{ content: "should never be used" }]);
		const trigger = await seedTicket(h, "I have a question about my plan");
		// Push the ticket to its lifetime message cap so admission hands off (Layer 2).
		await h.store.incrementAiUsage(trigger.ticketId, serverConfig.ticketAiGuardrails.maxMessages, 0);

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("handoff");
		expect(provider.calls).toBe(0); // model NEVER called
		expect(h.recordedTokens.length).toBe(0); // no tokens recorded
		const ticket = await h.store.getTicket(trigger.ticketId);
		expect(ticket?.status).toBe("escalated");
		expect(h.notifications.some((n) => n.type === "ticket_escalated")).toBe(true);
	});

	test("disabled provider (no API key) hands off without a model call", async () => {
		const h = harness();
		const provider = new FakeProvider([], false);
		const trigger = await seedTicket(h, "Where are my credits?");

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("handoff");
		expect(provider.calls).toBe(0);
		expect(h.recordedTokens.length).toBe(0);
	});
});

// ── (b) normal question → reply + tokens + notify ────────────────────────────────

describe("AI support agent — normal reply", () => {
	test("answers a question, records tokens once, bumps usage, posts an ai message, notifies", async () => {
		const h = harness();
		const provider = new FakeProvider([{ content: "You can change your plan in Settings → Billing.", tokens: 240 }]);
		const trigger = await seedTicket(h, "How do I change my plan?");

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("replied");
		expect(provider.calls).toBe(1);
		// Token recording happened exactly once.
		expect(h.recordedTokens.length).toBe(1);
		expect(h.recordedTokens[0]!.tokens).toBe(240);
		// Idempotency key is the AI message id.
		expect(h.recordedTokens[0]!.messageId).toBe(result.message!.id);
		// Per-ticket usage bumped.
		const ticket = await h.store.getTicket(trigger.ticketId);
		expect(ticket!.aiMessageCount).toBe(1);
		expect(ticket!.aiTokensSpent).toBe(240);
		expect(ticket!.lastProcessedMessageId).toBe(trigger.messageId);
		// An `ai` message was posted with the model's text.
		const thread = await h.store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		expect(aiMsg?.body).toContain("Settings → Billing");
		// Requester notified.
		expect(h.notifications.some((n) => n.type === "ticket_replied" && n.userId === FAKE_USER.id)).toBe(true);
	});

	test("single-flight: a second run for the same processed trigger is skipped (no second reply/tokens)", async () => {
		const h = harness();
		const provider = new FakeProvider([{ content: "first answer", tokens: 120 }, { content: "second answer", tokens: 999 }]);
		const trigger = await seedTicket(h, "ping");

		await runAgent(h, provider, trigger);
		const second = await runAgent(h, provider, trigger);

		expect(second.kind).toBe("skipped");
		expect(provider.calls).toBe(1); // model not called a second time
		expect(h.recordedTokens.length).toBe(1);
	});

	test("ATOMIC single-flight: two CONCURRENT runs for the same trigger process exactly ONCE (no double-spend)", async () => {
		const h = harness();
		// A provider that AWAITS before returning so the two runs overlap in the model
		// window — exactly the race the read-then-write check used to lose. Each run gets
		// its own provider instance (the production trigger spawns independent runs); a
		// SHARED claimedCount proves only one of them ever reached the model.
		let modelCalls = 0;
		const makeSlowProvider = (): FakeProvider => {
			const p = new FakeProvider([{ content: "the one answer", tokens: 150 }]);
			const orig = p.complete.bind(p);
			p.complete = (async (req: SupportChatRequest): Promise<SupportChatResult> => {
				modelCalls += 1;
				await Bun.sleep(15); // widen the window so both runs would overlap if unguarded
				return orig(req);
			}) as never;
			return p;
		};
		const trigger = await seedTicket(h, "concurrent ping");

		const [a, b] = await Promise.all([
			runAgent(h, makeSlowProvider(), trigger),
			runAgent(h, makeSlowProvider(), trigger),
		]);

		const kinds = [a.kind, b.kind].sort();
		// Exactly one run replied; the other lost the atomic claim and skipped.
		expect(kinds).toEqual(["replied", "skipped"]);
		expect(modelCalls).toBe(1); // the model was called ONCE — no double-spend
		expect(h.recordedTokens.length).toBe(1); // tokens recorded once
		const ticket = await h.store.getTicket(trigger.ticketId);
		expect(ticket!.aiMessageCount).toBe(1);
		expect(ticket!.aiTokensSpent).toBe(150);
	});

	test("a customer-style re-trigger (no flag) is stopped by the single-flight CLAIM; a staff force-run bypasses it", async () => {
		const h = harness();
		const provider = new FakeProvider([
			{ content: "first answer", tokens: 100 },
			{ content: "forced second answer", tokens: 110 },
		]);
		const trigger = await seedTicket(h, "ping");

		const first = await runAgent(h, provider, trigger);
		expect(first.kind).toBe("replied");

		// Customer-style re-trigger (no ignoreSingleFlight) → stopped AT the single-flight
		// claim before any admission/model work, with the claim's distinctive detail.
		const customerRerun = await runAgent(h, provider, trigger);
		expect(customerRerun.kind).toBe("skipped");
		expect(customerRerun.detail).toBe("Trigger already processed.");
		expect(provider.calls).toBe(1);

		// Staff/owner force-run BYPASSES the claim: it gets PAST the single-flight gate
		// (so the detail is NOT "Trigger already processed") and reaches the downstream
		// admission ladder — proving only the customer route is blocked by the claim. (The
		// admission layer additionally dedups identical message content as defense-in-depth,
		// so a force-run of the SAME text is still cost-safe.)
		const staffForce = await runAgent(h, provider, trigger, { ignoreSingleFlight: true });
		expect(staffForce.detail).not.toBe("Trigger already processed.");
	});
});

// ── (c) reconciliation ───────────────────────────────────────────────────────────

describe("AI support agent — payment reconciliation", () => {
	test("paid-but-uncredited → propose_action(grant_credit) AUTO-grants exactly the verified discrepancy ONCE (idempotent, audited actor=support-ai-auto)", async () => {
		const h = harness();
		const ws = "ws-recon";
		// The customer bought the credits-50 pack ($4 / 400 USD cents) but no credits were
		// granted. Reconciliation must grant the SKU's PROMISED 500 credits (legacy
		// pack quantities are rebased ×10) — NOT
		// floor(400 USD cents / 85)=4 (the doubly-wrong cost-basis-rate-into-USD math). The
		// payment is SKU-tagged (raw.metadata.sku) and attributed to THIS requester via
		// raw.metadata.user_id (the only per-user signal — payment_transactions has no
		// user column).
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-1", amountCents: 400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: FAKE_USER.id, sku: "credits-50" } } });

		const trigger = await seedTicket(h, "I topped up but my credits never arrived!", { workspaceId: ws });

		// Model: check reconciliation, then PROPOSE a grant, then a closing message.
		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 80 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit", reason: "topup not credited" })], tokens: 90 },
			{ content: "I've credited your account — sorry about that!", tokens: 60 },
		]);

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("replied");
		// Exactly the credits-50 SKU's PROMISED (rebased) 500 credits — the
		// deterministic gate AUTO-approved an EXACT verified discrepancy within caps.
		const balance = h.creditService.getBalance("member", FAKE_USER.id, ws);
		expect(balance.personal).toBe(500);
		// Audited as a single auto_approved EXECUTED grant by the AI (actor=support-ai-auto).
		const audit = await h.decisionStore.listByUser(FAKE_USER.id);
		const auto = audit.filter((d) => d.decision === "auto_approved" && d.action === "grant_credit");
		expect(auto.length).toBe(1);
		// amountCents is the credit-equivalent of the 500 owed credits (500 × 9), the gate's unit.
		expect(auto[0]!.amountCents).toBe(500 * 9);
		expect(auto[0]!.decidedBy).toBe("support-ai-auto");
		expect(auto[0]!.executedRef).toBeTruthy();
		// Tokens summed across the loop (80+90+60).
		expect(h.recordedTokens.reduce((s, t) => s + t.tokens, 0)).toBe(230);
	});

	test("a second grant proposal for the same ticket does NOT double-grant (idempotent)", async () => {
		const h = harness();
		const ws = "ws-recon2";
		// credits-50 pack ($4) bought but uncredited → owes the SKU's rebased 500 credits.
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-2", amountCents: 400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: FAKE_USER.id, sku: "credits-50" } } });
		const trigger = await seedTicket(h, "credits missing after topup", { workspaceId: ws });

		const provider1 = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 50 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 50 },
			{ content: "done", tokens: 20 },
		]);
		await runAgent(h, provider1, trigger);
		expect(h.creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(500);

		// Re-trigger the SAME ticket (ignore single-flight) and propose again → no double-grant.
		const provider2 = new FakeProvider([
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 40 },
			{ content: "already handled", tokens: 20 },
		]);
		await runAgent(h, provider2, trigger, { ignoreSingleFlight: true });

		// Balance UNCHANGED — the decision idempotency key (per ticket+action) blocked it.
		expect(h.creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(500);
		const audit = await h.decisionStore.listByUser(FAKE_USER.id);
		expect(audit.filter((d) => d.decision === "auto_approved").length).toBe(1);
	});

	test("no discrepancy → propose_action(grant_credit) is DENIED, grants nothing (prompt-injection safe)", async () => {
		const h = harness();
		const ws = "ws-nodisc";
		// Bought the credits-50 pack (owes the rebased 500 SKU credits) AND already
		// credited 500 credits via a top-up grant → no gap.
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-3", amountCents: 400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: FAKE_USER.id, sku: "credits-50" } } });
		await h.creditService.grantCredits({ workspaceId: ws, ownerScope: "user", ownerId: FAKE_USER.id, creditClass: "shareable", amount: 500, source: "topup" });
		const trigger = await seedTicket(h, "did my topup go through?", { workspaceId: ws });

		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 40 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 40 },
			{ content: "Your credits are all accounted for.", tokens: 30 },
		]);
		await runAgent(h, provider, trigger);

		// No goodwill credits minted; the gate DENIED (no verified discrepancy).
		expect(h.creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(0);
		const audit = await h.decisionStore.listByUser(FAKE_USER.id);
		expect(audit.some((d) => d.decision === "denied")).toBe(true);
		expect(audit.some((d) => d.decision === "auto_approved")).toBe(false);
	});

	// BUG 1 (P1, money + security): the discrepancy is scoped to the REQUESTING USER.
	// Another member's (or an unattributed) workspace payment must NEVER credit THIS
	// requester, even though both payments live under the same workspaceId.
	test("a DIFFERENT user's workspace payment does NOT grant to the requester", async () => {
		const h = harness();
		const ws = "ws-cross-user";
		// User A bought the credits-200 pack ($14), never credited. The ticket requester is
		// FAKE_USER (user-1) — this SKU payment would grant 200 credits if mis-attributed.
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-A", amountCents: 1400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: "user-A-other", sku: "credits-200" } } });
		const trigger = await seedTicket(h, "where are my credits?", { workspaceId: ws });

		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 40 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 40 },
			{ content: "Nothing outstanding on your account.", tokens: 30 },
		]);
		await runAgent(h, provider, trigger);

		// The requester gets NOTHING — user A's payment is not theirs (gate DENIES).
		expect(h.creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(0);
		const audit = await h.decisionStore.listByUser(FAKE_USER.id);
		expect(audit.some((d) => d.decision === "auto_approved")).toBe(false);
	});

	// BUG 1 (P1): an unattributed workspace payment (no raw.metadata.user_id) belongs to
	// no single requester → fail-closed, grant nothing.
	test("an unattributed workspace payment (no user_id) does NOT grant", async () => {
		const h = harness();
		const ws = "ws-unattributed";
		// A credits-200 SKU payment with NO user_id — it owes credits but belongs to no
		// single requester, so it must never grant.
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-anon", amountCents: 1400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { workspace_id: ws, sku: "credits-200" } } });
		const trigger = await seedTicket(h, "my topup vanished", { workspaceId: ws });

		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 30 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 30 },
			{ content: "Nothing outstanding.", tokens: 20 },
		]);
		await runAgent(h, provider, trigger);

		expect(h.creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(0);
		const audit = await h.decisionStore.listByUser(FAKE_USER.id);
		expect(audit.some((d) => d.decision === "auto_approved")).toBe(false);
	});

	// BUG 1 (P1, money + security): attribution must come ONLY from our controlled checkout
	// metadata (raw.metadata.user_id). A TOP-LEVEL raw.user_id / raw.userId is an
	// uncontrolled provider/payload field — trusting it as a fallback would let a payment
	// that lacks our checkout metadata be attributed to whoever that field names, inflating
	// their paid total and granting them credits. Even when the top-level field names the
	// REQUESTER themselves, the row must be treated as UNATTRIBUTED → no discrepancy, no grant.
	test("a top-level raw.user_id (no metadata.user_id) is UNTRUSTED → unattributed → no grant", async () => {
		const h = harness();
		const ws = "ws-toplevel-untrusted";
		// Two succeeded credits-200 SKU payments whose ONLY user attribution is the untrusted
		// top-level field, naming the requester. With the fail-closed fix these are
		// unattributed and never count toward FAKE_USER's paid total (or owed credits).
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-top-1", amountCents: 1400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { user_id: FAKE_USER.id, metadata: { sku: "credits-200" } } });
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-top-2", amountCents: 1400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { userId: FAKE_USER.id, metadata: { sku: "credits-200" } } });
		const trigger = await seedTicket(h, "where did my topup go?", { workspaceId: ws });

		// The detector must see NO paid amount attributed to the requester.
		const { detectReconciliation } = await import("../services/support/ai-tools.js");
		const detected = await detectReconciliation({
			userId: FAKE_USER.id,
			ticketId: trigger.ticketId,
			workspaceId: ws,
			creditService: h.creditService,
			paymentTxStore: h.paymentTxStore,
			reconciliationStore: h.reconciliationStore,
		} as never);
		expect(detected.paidCents).toBe(0);
		expect(detected.discrepancyExists).toBe(false);

		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 30 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 30 },
			{ content: "Nothing outstanding.", tokens: 20 },
		]);
		await runAgent(h, provider, trigger);

		expect(h.creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(0);
		const audit = await h.decisionStore.listByUser(FAKE_USER.id);
		expect(audit.some((d) => d.decision === "auto_approved")).toBe(false);
	});

	// BUG 2 (P1, money): only SUCCEEDED payments count. A failed/pending row — even one
	// attributed to the requester — must never inflate the paid total or justify a grant.
	test("a failed/pending payment for the requester does NOT grant", async () => {
		const h = harness();
		const ws = "ws-failed";
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-failed", amountCents: 5600, currency: "USD", workspaceId: ws, status: "failed", raw: { metadata: { user_id: FAKE_USER.id } } });
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-pending", amountCents: 5600, currency: "USD", workspaceId: ws, status: "pending", raw: { metadata: { user_id: FAKE_USER.id } } });
		const trigger = await seedTicket(h, "did my payment go through?", { workspaceId: ws });

		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 30 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 30 },
			{ content: "No settled payment yet.", tokens: 20 },
		]);
		await runAgent(h, provider, trigger);

		expect(h.creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(0);
		const audit = await h.decisionStore.listByUser(FAKE_USER.id);
		expect(audit.some((d) => d.decision === "auto_approved")).toBe(false);
	});

	// BUG 2 (P1, money): owed credits in different currencies are NEVER added together.
	// A credits-50 USD payment (owes the rebased 500) + a credits-200 JPY payment
	// (owes 2000) must be evaluated per-currency: the reported gap is the SINGLE
	// largest currency's owed credits (2000), never the summed 2500.
	test("owed credits in different currencies are not combined across currencies", async () => {
		const h = harness();
		const ws = "ws-mixed-cur";
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-usd", amountCents: 400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: FAKE_USER.id, sku: "credits-50" } } });
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-jpy", amountCents: 2000, currency: "JPY", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: FAKE_USER.id, sku: "credits-200" } } });
		const trigger = await seedTicket(h, "I paid in two currencies", { workspaceId: ws });

		const { detectReconciliation } = await import("../services/support/ai-tools.js");
		const detected = await detectReconciliation({
			userId: FAKE_USER.id,
			ticketId: trigger.ticketId,
			workspaceId: ws,
			creditService: h.creditService,
			paymentTxStore: h.paymentTxStore,
			reconciliationStore: h.reconciliationStore,
		} as never);
		// The gap is the LARGEST single-currency owed credits (2000), not 500+2000=2500.
		expect(detected.discrepancyCredits).toBe(2000);
		expect(detected.currency).toBe("JPY");
	});

	// BUG 2 (P1, money): refunds/disputes are kind!=='payment' (stored negative) and are
	// EXCLUDED from the paid total — only succeeded `payment` rows count. The detector's
	// reported paidCents must reflect the succeeded payment alone, never the negative
	// refund row (which would otherwise corrupt the per-currency paid bucket).
	test("refund rows are excluded from the paid total (only succeeded payments count)", async () => {
		const h = harness();
		const ws = "ws-refunded";
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-r", amountCents: 1400, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: FAKE_USER.id, sku: "credits-200" } } });
		await h.paymentTxStore.upsertTransaction({ kind: "refund", dodoEventRef: "ref-r", amountCents: -1400, currency: "USD", workspaceId: ws, status: "refunded", raw: { metadata: { user_id: FAKE_USER.id } } });
		const trigger = await seedTicket(h, "refund question", { workspaceId: ws });

		const { detectReconciliation } = await import("../services/support/ai-tools.js");
		const result = await detectReconciliation({
			userId: FAKE_USER.id,
			ticketId: trigger.ticketId,
			workspaceId: ws,
			creditService: h.creditService,
			paymentTxStore: h.paymentTxStore,
			reconciliationStore: h.reconciliationStore,
		} as never);
		// Only the +1400 succeeded payment is in the paid bucket; the -1400 refund row was
		// NOT netted in (it is a different kind).
		expect(result.paidCents).toBe(1400);
	});

	// MONEY-OUT (P1, money + abuse): a payment that carries an EXPLICIT NON-AI add-on SKU
	// (storage / seat / team_jobs / byo_api) owes 0 AI credits, EVEN when the row also
	// carries a planId. The add-on SKU is authoritative — the reconciler must NOT fall
	// through to the plan's monthlyAiCredits. Otherwise a $3 storage-25gb purchase on a
	// `creator` row would mint the plan's 60 free AI credits (60×85=5100 credit-equivalent
	// cents < the 8500 auto-grant cap → silent AUTO_APPROVE of 60 free credits).
	test("a non-AI add-on SKU (storage-25gb) WITH a planId owes 0 AI credits (not the plan's monthlyAiCredits)", async () => {
		const h = harness();
		const ws = "ws-storage-addon";
		// Succeeded, requester-attributed storage purchase that ALSO names the creator plan.
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-storage", amountCents: 300, currency: "USD", workspaceId: ws, status: "succeeded", planId: "creator", raw: { metadata: { user_id: FAKE_USER.id, sku: "storage-25gb" } } });
		const trigger = await seedTicket(h, "I bought storage, where are my credits?", { workspaceId: ws });

		const { detectReconciliation } = await import("../services/support/ai-tools.js");
		const detected = await detectReconciliation({
			userId: FAKE_USER.id,
			ticketId: trigger.ticketId,
			workspaceId: ws,
			creditService: h.creditService,
			paymentTxStore: h.paymentTxStore,
			reconciliationStore: h.reconciliationStore,
		} as never);
		// The storage SKU owes 0 AI credits — NOT creator's 60. No discrepancy → no grant.
		expect(detected.discrepancyCredits).toBe(0);
		expect(detected.discrepancyExists).toBe(false);

		// End-to-end: the gate must DENY a grant proposal (nothing minted, prompt-injection safe).
		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 30 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 30 },
			{ content: "Storage is an add-on; it doesn't include AI credits.", tokens: 20 },
		]);
		await runAgent(h, provider, trigger);
		expect(h.creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(0);
		const audit = await h.decisionStore.listByUser(FAKE_USER.id);
		expect(audit.some((d) => d.decision === "auto_approved")).toBe(false);
	});

	// MONEY-OUT control: a GENUINE plan subscription payment — planId set, NO explicit
	// add-on SKU — still owes the plan's monthlyAiCredits (creator → 1000). This confirms the
	// non-AI-SKU fix did not break the legitimate plan-credit path.
	test("a genuine plan payment (planId, no explicit add-on SKU) owes the plan's monthlyAiCredits", async () => {
		const h = harness();
		const ws = "ws-plan-sub";
		await h.paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pay-plan", amountCents: 1200, currency: "USD", workspaceId: ws, status: "succeeded", planId: "creator", raw: { metadata: { user_id: FAKE_USER.id } } });
		const trigger = await seedTicket(h, "I subscribed but my monthly credits are missing", { workspaceId: ws });

		const { detectReconciliation } = await import("../services/support/ai-tools.js");
		const detected = await detectReconciliation({
			userId: FAKE_USER.id,
			ticketId: trigger.ticketId,
			workspaceId: ws,
			creditService: h.creditService,
			paymentTxStore: h.paymentTxStore,
			reconciliationStore: h.reconciliationStore,
		} as never);
		// creator plan promises 1000 monthly AI credits → owed in full (none granted yet).
		expect(detected.discrepancyCredits).toBe(1000);
		expect(detected.discrepancyExists).toBe(true);
	});
});

// ── (d) tool-iteration budget caps the loop ──────────────────────────────────────

describe("AI support agent — iteration budget", () => {
	test("a model that only ever calls a tool is capped and escalates instead of looping forever", async () => {
		const h = harness();
		// EVERY turn requests a tool, never a final answer → the round cap must trip.
		const provider = new FakeProvider([{ toolCalls: [toolCall("get_customer_360", {})], tokens: 10 }]);
		const trigger = await seedTicket(h, "loop please", { workspaceId: "ws-loop" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("escalated");
		// Bounded by SUPPORT_AGENT_MAX_TOOL_ROUNDS (default 5) — never unbounded.
		expect(provider.calls).toBeLessThanOrEqual(5);
		const ticket = await h.store.getTicket(trigger.ticketId);
		expect(ticket?.status).toBe("escalated");
	});
});

// ── (e) escalate_to_department ───────────────────────────────────────────────────

describe("AI support agent — escalation", () => {
	test("escalate_to_department sets status=escalated, routes the queue, and notifies", async () => {
		const h = harness();
		const provider = new FakeProvider([
			{ toolCalls: [toolCall("escalate_to_department", { department: "billing", reason: "needs a refund" })], tokens: 70 },
		]);
		const trigger = await seedTicket(h, "I want a refund", { workspaceId: "ws-esc" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("escalated");
		expect(result.department).toBe("billing");
		const ticket = await h.store.getTicket(trigger.ticketId);
		expect(ticket?.status).toBe("escalated");
		expect(ticket?.queue).toBe("billing");
		expect(h.notifications.some((n) => n.type === "ticket_escalated")).toBe(true);
		// Tokens for the escalation turn were still recorded.
		expect(h.recordedTokens.reduce((s, t) => s + t.tokens, 0)).toBe(70);
	});

	// P1 #2: a non-English customer's routing note must be LOCALIZED, not hardcoded English.
	test("a THAI ticket's escalation routing note is posted in THAI (no hardcoded English)", async () => {
		const h = harness();
		const provider = new FakeProvider([
			{ toolCalls: [toolCall("escalate_to_department", { department: "billing", reason: "ทีมการเงินจะดำเนินการให้คุณ" })], tokens: 70 },
		]);
		const trigger = await seedTicket(h, "ผมต้องการขอเงินคืนครับ", { workspaceId: "ws-esc-th" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("escalated");
		const thread = await h.store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		// The routing note is Thai (localized note + team label), with NO Latin letters and
		// NONE of the old hardcoded-English phrasing.
		expect(aiMsg?.body).toContain("ส่งเรื่องนี้ต่อ");
		expect(aiMsg?.body).toContain("การเรียกเก็บเงิน"); // localized "billing" team label
		expect(aiMsg?.body).not.toContain("routed this");
		expect(aiMsg?.body).not.toContain("billing team");
		expect(/[A-Za-z]/.test(aiMsg?.body ?? "")).toBe(false);
	});

	// P1 #1: a reasoning-only model reply (no tool calls) → safe LOCALIZED handoff, not leaked triage.
	test("a reasoning-only model reply posts a localized Thai handoff (no leaked reasoning, no empty body)", async () => {
		const h = harness();
		const provider = new FakeProvider([
			{ content: "Reasoning: ลูกค้ารายนี้เป็น churn risk ให้ปลอบใจไว้ก่อน", tokens: 60 },
		]);
		const trigger = await seedTicket(h, "เครดิตของผมหายไปไหนครับ", { workspaceId: "ws-reasononly-th" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("handoff");
		const thread = await h.store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		expect((aiMsg?.body ?? "").trim().length).toBeGreaterThan(0);
		expect(aiMsg?.body).toContain("ฝ่ายสนับสนุน"); // localized "support team"
		expect(aiMsg?.body).not.toContain("churn risk");
		expect(aiMsg?.body).not.toContain("Reasoning");
		// The model call's tokens were still accounted for.
		expect(h.recordedTokens.reduce((s, t) => s + t.tokens, 0)).toBe(60);
	});
});

// ── (e2) CUSTOMER-FACING NOTIFICATIONS are localized on EVERY path (P1 round 3) ──
// notifyRequester sends to ticket.requesterUserId (the customer). Round-2 localized the
// in-app ticket MESSAGE but the notification TITLE/BODY stayed hardcoded English. These
// assert that on a Thai ticket the requester notification title+body are Thai (no Latin
// letters) and carry no internal reasoning/triage/key/department-jargon, across: normal
// reply, model escalation, admission handoff, provider-disabled, model-error, budget
// exhaustion, and reasoning-only handoff.

describe("AI support agent — localized customer notifications (Thai)", () => {
	const TH_TICKET = "สวัสดีครับ ผมมีคำถามเกี่ยวกับบัญชีของผม";

	function assertThaiNotification(n: { title: string; body: string } | undefined) {
		expect(n).toBeTruthy();
		expect(n!.title.trim().length).toBeGreaterThan(0);
		expect(n!.body.trim().length).toBeGreaterThan(0);
		// Fully Thai — the old hardcoded English ("routed your request", "Our assistant",
		// "billing team") is gone, and no internal triage/jargon leaks.
		expect(hasLatin(n!.title)).toBe(false);
		expect(hasLatin(n!.body)).toBe(false);
	}

	test("normal reply → Thai ticket_replied notification (title+body Thai, no English)", async () => {
		const h = harness();
		const provider = new FakeProvider([{ content: "คุณสามารถจัดการบัญชีได้ที่หน้า Settings ครับ", tokens: 60 }]);
		const trigger = await seedTicket(h, TH_TICKET, { workspaceId: "ws-th-reply" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("replied");
		assertThaiNotification(requesterNotification(h, "ticket_replied"));
	});

	test("model escalation → Thai ticket_escalated notification, NO raw model reason echoed", async () => {
		const h = harness();
		const provider = new FakeProvider([
			{ toolCalls: [toolCall("escalate_to_department", { department: "billing", reason: "Reasoning: churn risk, escalate quietly" })], tokens: 70 },
		]);
		const trigger = await seedTicket(h, TH_TICKET, { workspaceId: "ws-th-esc" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("escalated");
		const n = requesterNotification(h, "ticket_escalated");
		assertThaiNotification(n);
		// The raw model reason / its triage MUST NOT leak into the notification body or title.
		expect(n!.body).not.toContain("churn");
		expect(n!.title).not.toContain("churn");
		expect(n!.body).not.toContain("Reasoning");
		expect(n!.body).not.toContain("billing"); // raw department jargon
		// Localized billing team label IS present in the title.
		expect(n!.title).toContain("การเรียกเก็บเงิน");
	});

	test("admission handoff (per-ticket cap) → Thai ticket_escalated notification", async () => {
		const h = harness();
		const provider = new FakeProvider([{ content: "never used" }]);
		const trigger = await seedTicket(h, TH_TICKET, { workspaceId: "ws-th-cap" });
		await h.store.incrementAiUsage(trigger.ticketId, serverConfig.ticketAiGuardrails.maxMessages, 0);

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("handoff");
		expect(provider.calls).toBe(0);
		assertThaiNotification(requesterNotification(h, "ticket_escalated"));
	});

	test("provider disabled (no key) → Thai ticket_escalated notification", async () => {
		const h = harness();
		const provider = new FakeProvider([], false);
		const trigger = await seedTicket(h, TH_TICKET, { workspaceId: "ws-th-nokey" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("handoff");
		assertThaiNotification(requesterNotification(h, "ticket_escalated"));
	});

	test("model error mid-loop → Thai ticket_escalated notification", async () => {
		const h = harness();
		// A provider whose complete() throws → the catch escalates to a human handoff.
		const throwingProvider = {
			get model() { return "gpt-5.5"; },
			isEnabled() { return true; },
			async complete() { throw new Error("upstream 500"); },
		};
		const trigger = await seedTicket(h, TH_TICKET, { workspaceId: "ws-th-err" });

		const result = await runAgent(h, throwingProvider as never, trigger);

		expect(result.kind).toBe("handoff");
		const n = requesterNotification(h, "ticket_escalated");
		assertThaiNotification(n);
		// The transport error string never reaches the customer notification.
		expect(n!.body).not.toContain("upstream");
		expect(n!.body).not.toContain("500");
	});

	test("iteration budget exhausted → Thai ticket_escalated notification", async () => {
		const h = harness();
		// Every turn requests a tool, never a final answer → the round cap trips → handoff.
		const provider = new FakeProvider([{ toolCalls: [toolCall("get_customer_360", {})], tokens: 10 }]);
		const trigger = await seedTicket(h, TH_TICKET, { workspaceId: "ws-th-budget" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("escalated");
		assertThaiNotification(requesterNotification(h, "ticket_escalated"));
	});

	test("reasoning-only model output → Thai ticket_escalated notification (no leaked reasoning)", async () => {
		const h = harness();
		const provider = new FakeProvider([{ content: "Reasoning: ลูกค้าเป็น churn risk ให้ปลอบใจไว้ก่อน", tokens: 60 }]);
		const trigger = await seedTicket(h, TH_TICKET, { workspaceId: "ws-th-reasononly" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("handoff");
		const n = requesterNotification(h, "ticket_escalated");
		assertThaiNotification(n);
		expect(n!.body).not.toContain("churn");
		expect(n!.title).not.toContain("churn");
	});

	test("an English ticket still gets an English notification (no false switch)", async () => {
		const h = harness();
		const provider = new FakeProvider([{ content: "You can manage your account in Settings.", tokens: 50 }]);
		const trigger = await seedTicket(h, "How do I manage my account?", { workspaceId: "ws-en-reply" });

		const result = await runAgent(h, provider, trigger);

		expect(result.kind).toBe("replied");
		const n = requesterNotification(h, "ticket_replied");
		expect(n).toBeTruthy();
		expect(hasLatin(n!.title)).toBe(true);
		expect(n!.body).toContain("assistant");
	});
});

// ── (f) per-RUN token accounting on escalation re-triggers (BUG 3) ───────────────
// The global budget meter is idempotent on (ticketId, messageId). The escalation /
// error / budget paths have no AI reply message to key on; keying them on the customer
// triggerMessageId (which never changes across /ai-respond re-triggers) collapsed every
// re-triggered run onto ONE ledger key, undercounting real spend. The fix keys those
// paths on a UNIQUE per-run id so each run's tokens count, while a single run's retries
// (same run id) stay idempotent.

describe("AI support agent — per-run token accounting (escalation)", () => {
	test("repeated /ai-respond escalation runs EACH record their tokens (budget reflects N runs)", async () => {
		const h = harness();
		// Use a SHARED token recorder across both runs so idempotency is global on
		// (ticketId, messageId) exactly like the real ledger.
		const recordTokens = recordTokensFake(h);
		const trigger = await seedTicket(h, "please escalate me", { workspaceId: "ws-rerun" });

		// Advance the clock past the 60s dedup window between runs so the SAME trigger
		// message reaches the model on BOTH /ai-respond re-triggers (the real
		// ignoreSingleFlight re-run scenario), rather than being coalesced as a duplicate.
		let clock = Date.now();
		const now = () => clock;

		// A model that asks the customer to escalate (escalate_to_department) → escalation
		// path, which has no AI reply message to key tokens on. Under the bug both runs
		// keyed tokens on the (unchanged) customer triggerMessageId → the second run's
		// spend collapsed onto the first's ledger entry. The fix keys each run on a unique
		// per-run id so both count.
		const run = (tokens: number) =>
			runSupportAgent({
				ticketId: trigger.ticketId,
				triggerMessageId: trigger.messageId,
				store: h.store,
				provider: new FakeProvider([
					{ toolCalls: [toolCall("escalate_to_department", { department: "billing", reason: "needs a human" })], tokens },
				]) as never,
				notify: notifyFake(h) as never,
				recordTokens: recordTokens as never,
				loadUser: loadUserFake as never,
				now,
				toolStores: {
					creditService: h.creditService,
					paymentTxStore: h.paymentTxStore,
					reconciliationStore: h.reconciliationStore,
					ticketStore: h.store,
				},
				ignoreSingleFlight: true,
			});

		const first = await run(70);
		clock += 61_000; // step past the dedup window so the re-trigger is not coalesced
		const second = await run(90);

		expect(first.kind).toBe("escalated");
		expect(second.kind).toBe("escalated");
		// Two DISTINCT runs → two distinct ledger keys → BOTH counted (70 + 90 = 160).
		// Under the bug these collapsed to a single 70-token entry.
		expect(h.recordedTokens.length).toBe(2);
		expect(h.recordedTokens.reduce((s, t) => s + t.tokens, 0)).toBe(160);
	});

	test("admission-denied run records ZERO tokens (model never called)", async () => {
		const h = harness();
		const recordTokens = recordTokensFake(h);
		const trigger = await seedTicket(h, "capped ticket");
		// Push the ticket to its lifetime message cap so admission denies before any model call.
		await h.store.incrementAiUsage(trigger.ticketId, serverConfig.ticketAiGuardrails.maxMessages, 0);

		const provider = new FakeProvider([{ content: "never used" }]);
		const result = await runSupportAgent({
			ticketId: trigger.ticketId,
			triggerMessageId: trigger.messageId,
			store: h.store,
			provider: provider as never,
			notify: notifyFake(h) as never,
			recordTokens: recordTokens as never,
			loadUser: loadUserFake as never,
			toolStores: {
				creditService: h.creditService,
				paymentTxStore: h.paymentTxStore,
				reconciliationStore: h.reconciliationStore,
				ticketStore: h.store,
			},
			ignoreSingleFlight: true,
		});

		expect(result.kind).toBe("handoff");
		expect(provider.calls).toBe(0);
		expect(h.recordedTokens.length).toBe(0);
	});
});

// ── (g) SUPPORT_AGENT_MAX_TOKENS is clamped to a hard ceiling (BUG 4) ─────────────

describe("readSupportAgentMaxTokens — hard upper bound", () => {
	test("a sane value passes through", () => {
		expect(readSupportAgentMaxTokens("1200", 700)).toBe(1200);
	});
	test("an operator typo (extra zero) is CLAMPED to the ceiling, not honored", () => {
		// 80000 must NOT authorize a runaway-cost completion → clamped to MAX_MAX_TOKENS (4000).
		expect(readSupportAgentMaxTokens("80000", 700)).toBe(4000);
	});
	test("the ceiling itself passes through unchanged", () => {
		expect(readSupportAgentMaxTokens("4000", 700)).toBe(4000);
	});
	test("a missing/invalid/<=0 value falls back to the default (bound never disabled)", () => {
		expect(readSupportAgentMaxTokens(undefined, 700)).toBe(700);
		expect(readSupportAgentMaxTokens("  ", 700)).toBe(700);
		expect(readSupportAgentMaxTokens("0", 700)).toBe(700);
		expect(readSupportAgentMaxTokens("-5", 700)).toBe(700);
		expect(readSupportAgentMaxTokens("not-a-number", 700)).toBe(700);
	});
});

// ── Real Postgres: the reconcile + ledger path end-to-end (gated) ────────────────
// Drives the full agent loop against the REAL Postgres ticket store, payment store,
// and reconciliation store (migration 0058) so the reconcile→grant→audit path is
// proven against actual SQL, not just the in-memory fakes. The model is still mocked.
//
//   RECON_TEST_DATABASE_URL=postgres://verify:verify@127.0.0.1:55440/recon \
//     bun test support-ai-agent

const AGENT_DB_URL = process.env.RECON_TEST_DATABASE_URL?.trim();
const describeMaybePg = AGENT_DB_URL ? describe : describe.skip;

describeMaybePg("AI support agent — reconcile + ledger on real Postgres", () => {
	const sql = new Bun.SQL(AGENT_DB_URL as string);
	const ticketStore = new PostgresSupportTicketStore(sql as never);
	const paymentTxStore = new PostgresPaymentTransactionsStore(sql as never);
	const reconciliationStore = new PostgresPaymentReconciliationStore(sql as never);
	const decisionStore = new PostgresOwnerDecisionStore(sql as never);
	let creditService: CreditService;
	const creditDirs: string[] = [];

	const WS = "ws-pg-recon";

	beforeEach(async () => {
		await sql.unsafe("DELETE FROM support_decisions");
		await sql.unsafe("DELETE FROM payment_reconciliations");
		await sql.unsafe("DELETE FROM support_ticket_messages");
		await sql.unsafe("DELETE FROM support_tickets");
		await sql.unsafe("DELETE FROM payment_transactions");
		await sql.unsafe("DELETE FROM workspaces WHERE workspace_id = $1", [WS]);
		// support_tickets.workspace_id + payment_transactions.workspace_id FK → workspaces.
		await sql.unsafe(
			"INSERT INTO workspaces (workspace_id, name) VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING",
			[WS, "Recon Test WS"],
		);
		const dir = mkdtempSync(join(tmpdir(), "recon-agent-credits-"));
		creditDirs.push(dir);
		creditService = new CreditService(join(dir, "credits.json"), 50, { crossProcessSafe: false });
	});
	afterAll(async () => {
		await sql.unsafe("DELETE FROM support_decisions");
		await sql.unsafe("DELETE FROM payment_reconciliations");
		await sql.unsafe("DELETE FROM support_ticket_messages");
		await sql.unsafe("DELETE FROM support_tickets");
		await sql.unsafe("DELETE FROM payment_transactions");
		await sql.unsafe("DELETE FROM workspaces WHERE workspace_id = $1", [WS]);
		await sql.close?.();
		for (const dir of creditDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("paid-but-uncredited (real PG): AUTO-grant once, audited row in 0060, no double-grant", async () => {
		const ws = WS;
		await paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pg-pay-1", amountCents: 8500, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: FAKE_USER.id } } });
		const ticket = await ticketStore.createTicket({ requesterUserId: FAKE_USER.id, subject: "topup", workspaceId: ws, body: "I paid but credits never arrived" });
		const thread = await ticketStore.listMessages(ticket.id, { limit: 1 });
		const trigger = { ticketId: ticket.id, messageId: thread.items[0]!.id };

		const toolStores = { creditService, paymentTxStore, reconciliationStore, ticketStore, decisionStore, listUsers: listOwnersFake as never };
		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 80 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 90 },
			{ content: "Credited — sorry for the delay!", tokens: 60 },
		]);

		const recorded: string[] = [];
		const recordTokens = async (input: { ticketId: string; messageId: string }) => {
			recorded.push(`${input.ticketId}:${input.messageId}`);
			return { eventId: recorded.length } as never;
		};

		const result = await runSupportAgent({
			ticketId: trigger.ticketId,
			triggerMessageId: trigger.messageId,
			store: ticketStore,
			provider: provider as never,
			notify: (async () => ({ inAppDelivered: true, emailAttempted: false, skipped: [] })) as never,
			recordTokens: recordTokens as never,
			loadUser: loadUserFake as never,
			toolStores,
		});

		expect(result.kind).toBe("replied");
		// Exactly 100 personal credits granted (8500 / 85).
		expect(creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(100);
		// One auto_approved EXECUTED decision row persisted in migration 0060 (actor=ai).
		const rows = await sql.unsafe("SELECT decision, action, amount_cents, decided_by, executed_ref FROM support_decisions WHERE ticket_id = $1", [ticket.id]);
		expect(rows.length).toBe(1);
		expect((rows[0] as { decision: string }).decision).toBe("auto_approved");
		expect((rows[0] as { decided_by: string }).decided_by).toBe("support-ai-auto");
		expect((rows[0] as { executed_ref: string | null }).executed_ref).toBeTruthy();
		expect(Number((rows[0] as { amount_cents: number | string }).amount_cents)).toBe(8500);
		// Per-ticket usage was bumped on the real ticket row.
		const refreshed = await ticketStore.getTicket(ticket.id);
		expect(refreshed!.aiMessageCount).toBe(1);
		expect(refreshed!.aiTokensSpent).toBe(230);

		// Re-trigger → no second grant (0060 idempotency key on the ticket+action).
		const provider2 = new FakeProvider([{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 30 }, { content: "already done", tokens: 10 }]);
		await runSupportAgent({
			ticketId: trigger.ticketId,
			triggerMessageId: trigger.messageId,
			store: ticketStore,
			provider: provider2 as never,
			notify: (async () => ({ inAppDelivered: true, emailAttempted: false, skipped: [] })) as never,
			recordTokens: recordTokens as never,
			loadUser: loadUserFake as never,
			toolStores,
			ignoreSingleFlight: true,
		});
		expect(creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(100);
		const rowsAfter = await sql.unsafe("SELECT COUNT(*)::int AS n FROM support_decisions WHERE ticket_id = $1 AND decision = 'auto_approved'", [ticket.id]);
		expect(Number((rowsAfter[0] as { n: number }).n)).toBe(1);
	});

	// BUG 1 (P1, money + security) on REAL Postgres: user B's ticket must NOT grant from
	// user A's uncredited workspace payment, even though both rows share the workspace.
	test("cross-user (real PG): user B's ticket does NOT grant from user A's payment", async () => {
		const ws = WS;
		// User A paid 5600 (attributed to user A), never credited. The ticket requester is
		// FAKE_USER (user B). A workspace-wide aggregate WOULD see a 5600 gap and grant it —
		// the per-user scoping must NOT.
		await paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pg-pay-A", amountCents: 5600, currency: "USD", workspaceId: ws, status: "succeeded", raw: { metadata: { user_id: "user-A-other" } } });
		const ticket = await ticketStore.createTicket({ requesterUserId: FAKE_USER.id, subject: "credits?", workspaceId: ws, body: "I never got my credits" });
		const thread = await ticketStore.listMessages(ticket.id, { limit: 1 });
		const trigger = { ticketId: ticket.id, messageId: thread.items[0]!.id };

		const toolStores = { creditService, paymentTxStore, reconciliationStore, ticketStore, decisionStore, listUsers: listOwnersFake as never };
		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 50 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 50 },
			{ content: "Nothing outstanding on your account.", tokens: 30 },
		]);

		const result = await runSupportAgent({
			ticketId: trigger.ticketId,
			triggerMessageId: trigger.messageId,
			store: ticketStore,
			provider: provider as never,
			notify: (async () => ({ inAppDelivered: true, emailAttempted: false, skipped: [] })) as never,
			recordTokens: (async () => ({ eventId: "x" })) as never,
			loadUser: loadUserFake as never,
			toolStores,
		});

		// The agent finished, but the requester (user B) got ZERO credits and no AUTO grant.
		expect(result.kind === "replied" || result.kind === "escalated").toBe(true);
		expect(creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(0);
		const granted = await sql.unsafe("SELECT COUNT(*)::int AS n FROM support_decisions WHERE ticket_id = $1 AND decision = 'auto_approved'", [ticket.id]);
		expect(Number((granted[0] as { n: number }).n)).toBe(0);
	});

	// BUG 1 (P1, money + security) on REAL Postgres: a succeeded payment whose ONLY user
	// attribution is the untrusted TOP-LEVEL raw.user_id (no raw.metadata.user_id) must be
	// treated as UNATTRIBUTED — even when the field names the requester — and never grant.
	test("untrusted top-level raw.user_id (real PG): unattributed → no grant", async () => {
		const ws = WS;
		await paymentTxStore.upsertTransaction({ kind: "payment", dodoEventRef: "pg-pay-top", amountCents: 5600, currency: "USD", workspaceId: ws, status: "succeeded", raw: { user_id: FAKE_USER.id } });
		const ticket = await ticketStore.createTicket({ requesterUserId: FAKE_USER.id, subject: "credits?", workspaceId: ws, body: "I paid but nothing arrived" });
		const thread = await ticketStore.listMessages(ticket.id, { limit: 1 });
		const trigger = { ticketId: ticket.id, messageId: thread.items[0]!.id };

		const toolStores = { creditService, paymentTxStore, reconciliationStore, ticketStore, decisionStore, listUsers: listOwnersFake as never };
		const provider = new FakeProvider([
			{ toolCalls: [toolCall("check_payment_reconciliation", {})], tokens: 50 },
			{ toolCalls: [toolCall("propose_action", { action: "grant_credit" })], tokens: 50 },
			{ content: "Nothing outstanding on your account.", tokens: 30 },
		]);

		const result = await runSupportAgent({
			ticketId: trigger.ticketId,
			triggerMessageId: trigger.messageId,
			store: ticketStore,
			provider: provider as never,
			notify: (async () => ({ inAppDelivered: true, emailAttempted: false, skipped: [] })) as never,
			recordTokens: (async () => ({ eventId: "x" })) as never,
			loadUser: loadUserFake as never,
			toolStores,
		});

		expect(result.kind === "replied" || result.kind === "escalated").toBe(true);
		expect(creditService.getBalance("member", FAKE_USER.id, ws).personal).toBe(0);
		const granted = await sql.unsafe("SELECT COUNT(*)::int AS n FROM support_decisions WHERE ticket_id = $1 AND decision = 'auto_approved'", [ticket.id]);
		expect(Number((granted[0] as { n: number }).n)).toBe(0);
	});
});
