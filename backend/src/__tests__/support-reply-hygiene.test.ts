// AI-support reply hygiene — the two leak/quality fixes a real-browser QA sweep
// found on the gpt-5.5 support agent's customer-visible reply:
//   (a) the reply leaked INTERNAL TRIAGE REASONING (chain-of-thought / "Reasoning:"
//       / "Triage:" notes) — the customer must see ONLY the final answer.
//   (b) the reply was in ENGLISH to a THAI customer — it must match the customer's
//       language.
//
// Layer 1 (this file's first two describes): the PURE helpers, exhaustively.
// Layer 2 (the third describe): the END-TO-END agent path proves the customer-
//       facing message it POSTS has reasoning stripped AND that the conversation
//       sent to the model carries the customer-language instruction. The model is a
//       scripted fake (no real OpenAI call), mirroring support-ai-agent.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	answerLanguageInstruction,
	detectCustomerLanguage,
	escalationRoutingNote,
	safeHandoffMessage,
	stripInternalReasoning,
} from "../services/support/reply-hygiene.js";
import { FileSupportTicketStore, type SupportTicketStore } from "../services/support-tickets.js";
import { runSupportAgent } from "../services/support/ai-agent.js";
import type {
	SupportAiProvider,
	SupportChatRequest,
	SupportChatResult,
	SupportToolCall,
} from "../services/support/ai-provider.js";

// ── (Layer 1a) language detection ─────────────────────────────────────────────

describe("detectCustomerLanguage", () => {
	test("detects Thai", () => {
		expect(detectCustomerLanguage("สวัสดีครับ เครดิตของผมหายไปไหน").name).toBe("Thai");
		expect(detectCustomerLanguage("สวัสดีครับ เครดิตของผมหายไปไหน").code).toBe("th");
	});
	test("detects Japanese (kana wins over shared Han)", () => {
		expect(detectCustomerLanguage("クレジットが届きません。").name).toBe("Japanese");
	});
	test("detects Korean", () => {
		expect(detectCustomerLanguage("크레딧이 도착하지 않았어요").name).toBe("Korean");
	});
	test("detects Chinese (Han, no kana)", () => {
		expect(detectCustomerLanguage("我的积分没有到账").name).toBe("Chinese");
	});
	test("detects Russian", () => {
		expect(detectCustomerLanguage("Мои кредиты не пришли").name).toBe("Russian");
	});
	test("a Latin-script (English) message stays English", () => {
		expect(detectCustomerLanguage("Where are my credits?").name).toBe("English");
	});
	test("a mostly-Thai message with some ASCII (URLs/brand) is still Thai, NOT English", () => {
		expect(detectCustomerLanguage("ผมจ่ายเงินผ่าน Comic Workspace แล้ว แต่เครดิตไม่มา (order #1234)").name).toBe("Thai");
	});
	test("empty / whitespace falls back to English", () => {
		expect(detectCustomerLanguage("").name).toBe("English");
		expect(detectCustomerLanguage("   ").name).toBe("English");
		expect(detectCustomerLanguage(null).name).toBe("English");
	});
	test("the instruction names the detected language explicitly and forbids defaulting to English", () => {
		const instruction = answerLanguageInstruction(detectCustomerLanguage("เครดิตหาย"));
		expect(instruction).toContain("Thai");
		expect(instruction).toContain("Do NOT answer in English");
	});
});

// ── (Layer 1b) reasoning stripping ────────────────────────────────────────────

describe("stripInternalReasoning", () => {
	test("removes a leading labelled reasoning preamble, keeps the answer", () => {
		const reply = "Reasoning: the customer bought credits-50 but none were granted, so I should reassure them.\n\nYour 50 credits have been added — sorry for the delay!";
		const out = stripInternalReasoning(reply);
		expect(out).toBe("Your 50 credits have been added — sorry for the delay!");
		expect(out).not.toContain("Reasoning");
		expect(out).not.toContain("credits-50");
	});

	test("removes a multi-line Triage block (bullets + indent) before the answer", () => {
		const reply = [
			"Triage:",
			"- customer is on the free plan",
			"  - no payment found",
			"- low risk",
			"",
			"You're on the free plan, which includes 3 AI credits per month.",
		].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toBe("You're on the free plan, which includes 3 AI credits per month.");
		expect(out).not.toContain("Triage");
		expect(out).not.toContain("low risk");
	});

	test("honors an explicit Final answer: marker (drops everything before it)", () => {
		const reply = "Internal: verified the topup is real.\nReasoning: grant the difference.\nFinal answer: I've credited your account. Thanks for your patience!";
		const out = stripInternalReasoning(reply);
		expect(out).toBe("I've credited your account. Thanks for your patience!");
		expect(out).not.toContain("verified");
		expect(out).not.toContain("Reasoning");
	});

	test("removes a <thinking>…</thinking> block anywhere in the text", () => {
		const reply = "<thinking>The plan is creator; owes 60 credits.</thinking>\nYou should see your 60 monthly credits now.";
		const out = stripInternalReasoning(reply);
		expect(out).toContain("60 monthly credits");
		expect(out).not.toContain("thinking");
		expect(out).not.toContain("owes 60 credits");
	});

	test("strips reasoning while PRESERVING a non-English (Thai) answer", () => {
		const reply = "Reasoning: customer's topup reconciled, grant 50.\n\nเราได้เพิ่มเครดิต 50 ให้บัญชีของคุณแล้วครับ ขออภัยในความล่าช้า";
		const out = stripInternalReasoning(reply);
		expect(out).toBe("เราได้เพิ่มเครดิต 50 ให้บัญชีของคุณแล้วครับ ขออภัยในความล่าช้า");
		expect(out).not.toContain("Reasoning");
	});

	test("plain answer with no markers is returned unchanged", () => {
		const reply = "You can change your plan in Settings → Billing.";
		expect(stripInternalReasoning(reply)).toBe(reply);
	});

	test("a bare answer marker with NO content yields EMPTY (→ safe handoff), never a bare label", () => {
		// An explicit answer marker with nothing after it carries no customer answer. It must
		// collapse to "" so the caller posts a localized safe handoff — never post the bare
		// "Answer:" label (and never re-mine any reasoning preamble for "answer" text).
		expect(stripInternalReasoning("Answer:")).toBe("");
		expect(stripInternalReasoning("Final answer:")).toBe("");
	});

	test("empty input returns empty", () => {
		expect(stripInternalReasoning("")).toBe("");
		expect(stripInternalReasoning(null)).toBe("");
	});

	// ── P1 (round 3): consecutive reasoning labels must ALL be consumed ───────────
	test("MULTIPLE consecutive reasoning labels (no answer) ALL strip → EMPTY", () => {
		const reply = ["Reasoning: weigh churn risk.", "Triage: free plan, low value.", "Internal: do not grant."].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toBe("");
		expect(out).not.toContain("churn");
		expect(out).not.toContain("free plan");
		expect(out).not.toContain("do not grant");
	});

	test("consecutive reasoning labels THEN a real answer keep ONLY the answer", () => {
		const reply = [
			"Reasoning: the customer is a churn risk.",
			"Triage: free plan, no payment found.",
			"Internal: reassure, do not promise credits.",
			"You're on the free plan, which includes 3 AI credits each month.",
		].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toBe("You're on the free plan, which includes 3 AI credits each month.");
		expect(out).not.toContain("churn");
		expect(out).not.toContain("no payment found");
		expect(out).not.toContain("do not promise");
		expect(out).not.toContain("Reasoning");
		expect(out).not.toContain("Triage");
		expect(out).not.toContain("Internal");
	});

	// ── P1 (round 3): an explicit answer marker present but EMPTY → EMPTY ─────────
	test("reasoning preamble + an EMPTY answer marker yields EMPTY (no reasoning re-mined)", () => {
		const reply = "Reasoning: escalate quietly.\nInternal: do not mention the bug.\nFinal answer:";
		const out = stripInternalReasoning(reply);
		expect(out).toBe("");
		expect(out).not.toContain("escalate");
		expect(out).not.toContain("do not mention");
		expect(out).not.toContain("Reasoning");
		expect(out).not.toContain("Internal");
	});

	// ── P1 #1: REASONING-ONLY OUTPUT must collapse to EMPTY (never leak) ──────────
	// Before the fix, a reasoning-only message fell back to `firstLabelInline || original`,
	// so `Reasoning: customer is a churn risk…` leaked as the customer-visible
	// `customer is a churn risk…`. It must now return "" so the caller posts a safe handoff.

	test("a SINGLE-LINE reasoning-only reply returns EMPTY (not the inline text after the label)", () => {
		const reply = "Reasoning: the customer is a churn risk, reassure and upsell later.";
		const out = stripInternalReasoning(reply);
		expect(out).toBe("");
		// Critically: it must NOT leak the inline reasoning text (the old firstLabelInline bug).
		expect(out).not.toContain("churn risk");
		expect(out).not.toContain("upsell");
	});

	test("a MULTI-LINE reasoning-only block (Triage + bullets) returns EMPTY", () => {
		const reply = [
			"Triage:",
			"- customer is on the free plan",
			"- internal note: likely a refund-bait, do not grant",
			"- low value, churn risk",
		].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toBe("");
		expect(out).not.toContain("refund-bait");
		expect(out).not.toContain("churn");
	});

	test("reasoning preamble + EMPTY answer marker leaks no reasoning content (only a bare label may survive)", () => {
		// `Final answer:` carries no content → the reasoning preamble above it is stripped.
		// The bare empty `Final answer:` label is the only thing that can survive; crucially,
		// NONE of the internal reasoning leaks (and the caller blank-checks the result anyway).
		const reply = "Reasoning: escalate quietly.\nInternal: do not mention the bug.\nFinal answer:";
		const out = stripInternalReasoning(reply);
		expect(out).not.toContain("escalate");
		expect(out).not.toContain("do not mention");
		expect(out).not.toContain("Reasoning");
		expect(out).not.toContain("Internal");
	});

	test("a reasoning-only block phrased in THAI also returns EMPTY (not the inline reasoning)", () => {
		const reply = "Reasoning: ลูกค้ามีความเสี่ยงจะเลิกใช้บริการ ให้ปลอบใจไว้ก่อน";
		expect(stripInternalReasoning(reply)).toBe("");
	});

	// ── a16 #11: markdown-HEADING reasoning sections (no colon) must be stripped ──
	test("strips a `## Internal reasoning` markdown-heading SECTION, keeps the answer", () => {
		const reply = [
			"## Internal reasoning",
			"The customer is a churn risk; we already refunded once. Do not mention the prior refund.",
			"",
			"## Reply",
			"Your refund has been processed and should arrive within 3-5 business days.",
		].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toContain("refund has been processed");
		expect(out).not.toContain("churn risk");
		expect(out).not.toContain("Internal reasoning");
		expect(out).not.toContain("prior refund");
	});

	test("strips a `### Triage notes` heading section appended AFTER the answer", () => {
		const reply = [
			"Thanks for reaching out — I've reset your password, check your email.",
			"",
			"### Triage notes",
			"Flagged account for repeated reset attempts; possible takeover.",
		].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toContain("reset your password");
		expect(out).not.toContain("Triage");
		expect(out).not.toContain("takeover");
	});

	test("a legitimate answer heading (`## How to reset`) is NOT mistaken for reasoning", () => {
		const reply = ["## How to reset your password", "Open Settings → Security and click Reset."].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toContain("How to reset your password");
		expect(out).toContain("Open Settings");
	});

	test("a reasoning-ONLY markdown heading section collapses to EMPTY (→ safe handoff)", () => {
		const reply = ["# Thinking", "Weigh the churn risk; do not grant the credits."].join("\n");
		expect(stripInternalReasoning(reply)).toBe("");
	});

	// ── a16 re-review P1 #3 — internal section AFTER a `Final answer:` marker ─────

	test("strips a `## Internal reasoning` section that FOLLOWS a `Final answer:` marker (no leak through the marker)", () => {
		const reply = [
			"Final answer:",
			"Your account has been upgraded — enjoy the new features!",
			"",
			"## Internal reasoning",
			"Customer is a churn risk; comp'd silently. Do not mention the comp.",
		].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toContain("account has been upgraded");
		// The post-marker internal section MUST be stripped, not echoed verbatim.
		expect(out).not.toContain("Internal reasoning");
		expect(out).not.toContain("churn risk");
		expect(out).not.toContain("comp'd");
	});

	test("strips a labelled `Internal:` block that FOLLOWS a `Final answer:` marker", () => {
		const reply = [
			"Final answer: Here is your refund confirmation, ref #12345.",
			"",
			"Internal: flag this account for repeated refunds; possible fraud.",
		].join("\n");
		const out = stripInternalReasoning(reply);
		expect(out).toContain("refund confirmation");
		expect(out).not.toContain("Internal:");
		expect(out).not.toContain("fraud");
	});

	test("a `Final answer:` whose ONLY post-marker content is an internal section collapses to EMPTY", () => {
		const reply = [
			"Final answer:",
			"## Internal reasoning",
			"escalate quietly; do not reply to the customer directly.",
		].join("\n");
		// Nothing customer-safe survives → empty → caller posts a safe handoff.
		expect(stripInternalReasoning(reply)).toBe("");
	});
});

// ── (Layer 1c) localized customer-facing canned messages ──────────────────────
// P1 #1 (empty cleaned reply → safe handoff) and P1 #2 (escalation routing note)
// both post DIRECTLY to the customer, so they MUST be localized — not hardcoded English.

describe("safeHandoffMessage", () => {
	test("returns the customer-language handoff for en/th/ja/ko/zh", () => {
		expect(safeHandoffMessage(detectCustomerLanguage("Where are my credits?"))).toContain("support specialist");
		// Thai contains the Thai word for "support team" — and NO Latin letters.
		const th = safeHandoffMessage(detectCustomerLanguage("เครดิตของผมหายไปไหน"));
		expect(th).toContain("ฝ่ายสนับสนุน");
		expect(/[A-Za-z]/.test(th)).toBe(false);
		expect(safeHandoffMessage(detectCustomerLanguage("クレジットはどこですか"))).toContain("担当者");
		expect(safeHandoffMessage(detectCustomerLanguage("제 크레딧은 어디 있나요"))).toContain("상담원");
		expect(safeHandoffMessage(detectCustomerLanguage("我的积分在哪里"))).toContain("支持专员");
	});

	test("an undetected/other language falls back to English", () => {
		// Russian is detected as a language but is NOT in the supported-locale set → English fallback.
		expect(safeHandoffMessage(detectCustomerLanguage("Где мои кредиты?"))).toContain("support specialist");
	});

	test("defaults to English with no argument", () => {
		expect(safeHandoffMessage()).toContain("support specialist");
	});
});

describe("escalationRoutingNote", () => {
	test("English note names a neutral localized team label, not raw jargon", () => {
		const en = escalationRoutingNote("billing", "we'll process your refund", detectCustomerLanguage("Refund please"));
		expect(en).toContain("billing team");
		expect(en).toContain("(we'll process your refund)");
		expect(en).toContain("follow up");
	});

	test("THAI note is fully Thai (no English), with a localized team label and reason", () => {
		const th = escalationRoutingNote("billing", "เราจะดำเนินการคืนเงินให้คุณ", detectCustomerLanguage("ขอคืนเงินครับ"));
		// The note body is Thai — no Latin letters leak in.
		expect(/[A-Za-z]/.test(th)).toBe(false);
		expect(th).toContain("การเรียกเก็บเงิน"); // localized "billing" team label
		expect(th).toContain("เราจะดำเนินการคืนเงินให้คุณ"); // the (localized) reason in the parenthetical
	});

	test("OMITS the reason parenthetical cleanly when the reason is empty (reasoning-only stripped to '')", () => {
		const th = escalationRoutingNote("billing", "", detectCustomerLanguage("ขอคืนเงินครับ"));
		expect(th).not.toContain("(");
		expect(th).not.toContain("（"); // also no full-width paren
		expect(th).toContain("การเรียกเก็บเงิน");
		const en = escalationRoutingNote("general", "   ", detectCustomerLanguage("hi"));
		expect(en).not.toContain("(");
	});

	test("an unknown department falls back to a neutral 'support' team label, not raw jargon", () => {
		const en = escalationRoutingNote("some_internal_queue_42", "", detectCustomerLanguage("hi"));
		expect(en).not.toContain("some_internal_queue_42");
		expect(en).toContain("support team");
	});
});

// ── (Layer 2) end-to-end agent wiring (scripted fake model) ───────────────────

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeProvider implements Pick<SupportAiProvider, "isEnabled" | "complete" | "model"> {
	calls = 0;
	lastRequest?: SupportChatRequest;
	constructor(
		private readonly content: string,
		private readonly toolCalls: SupportToolCall[] = [],
	) {}
	get model(): string { return "gpt-5.5"; }
	isEnabled(): boolean { return true; }
	async complete(request: SupportChatRequest): Promise<SupportChatResult> {
		this.calls += 1;
		this.lastRequest = request;
		return {
			content: this.content,
			toolCalls: this.toolCalls,
			usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
			model: "gpt-5.5",
			requestMs: 1,
		};
	}
}

const FAKE_USER = { id: "user-1", email: "real@example.com", emailVerified: true, name: "Real", role: "editor", isActive: true } as never;

async function seedTicket(store: SupportTicketStore, body: string): Promise<{ ticketId: string; messageId: string }> {
	const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "Help", body });
	const thread = await store.listMessages(ticket.id, { limit: 1 });
	return { ticketId: ticket.id, messageId: thread.items[0]!.id };
}

function run(store: SupportTicketStore, provider: FakeProvider, trigger: { ticketId: string; messageId: string }) {
	return runSupportAgent({
		ticketId: trigger.ticketId,
		triggerMessageId: trigger.messageId,
		store,
		provider: provider as never,
		notify: (async () => ({ inAppDelivered: true, emailAttempted: false, skipped: [] })) as never,
		recordTokens: (async () => ({ eventId: "x" })) as never,
		loadUser: (async () => FAKE_USER) as never,
	});
}

describe("AI support agent — reply hygiene end-to-end", () => {
	test("the POSTED customer reply has the model's triage reasoning STRIPPED", async () => {
		const store = new FileSupportTicketStore(join(tempDir("hygiene-strip-"), "tickets.json"));
		const trigger = await seedTicket(store, "How do I change my plan?");
		// The model leaks its triage reasoning inline before the answer.
		const provider = new FakeProvider("Triage: free plan, low risk, no payment.\n\nYou can change your plan in Settings → Billing.");

		const result = await run(store, provider, trigger);

		expect(result.kind).toBe("replied");
		const thread = await store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		expect(aiMsg?.body).toBe("You can change your plan in Settings → Billing.");
		// The internal reasoning never reached the customer-visible message.
		expect(aiMsg?.body).not.toContain("Triage");
		expect(aiMsg?.body).not.toContain("low risk");
		expect(result.message?.body).not.toContain("Triage");
	});

	test("the conversation sent to the model instructs answering in the customer's (Thai) language", async () => {
		const store = new FileSupportTicketStore(join(tempDir("hygiene-lang-"), "tickets.json"));
		const trigger = await seedTicket(store, "สวัสดีครับ ผมเปลี่ยนแพ็กเกจยังไงครับ");
		const provider = new FakeProvider("คุณสามารถเปลี่ยนแพ็กเกจได้ที่ Settings → Billing ครับ");

		const result = await run(store, provider, trigger);

		expect(result.kind).toBe("replied");
		// The agent told the model to answer in Thai (not default to English).
		const systemMessages = (provider.lastRequest?.messages ?? []).filter((m) => m.role === "system");
		const combined = systemMessages.map((m) => m.content).join("\n");
		expect(combined).toContain("Thai");
		expect(combined).toContain("Do NOT answer in English");
		// The Thai reply is delivered intact.
		const thread = await store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		expect(aiMsg?.body).toContain("Settings → Billing");
	});

	test("an English ticket keeps the English instruction (no false switch)", async () => {
		const store = new FileSupportTicketStore(join(tempDir("hygiene-en-"), "tickets.json"));
		const trigger = await seedTicket(store, "Where are my credits?");
		const provider = new FakeProvider("Your credits are all accounted for.");

		await run(store, provider, trigger);

		const combined = (provider.lastRequest?.messages ?? [])
			.filter((m) => m.role === "system")
			.map((m) => m.content)
			.join("\n");
		expect(combined).toContain("English");
	});

	test("the ESCALATION routing note strips internal triage from the model's reason", async () => {
		const store = new FileSupportTicketStore(join(tempDir("hygiene-esc-"), "tickets.json"));
		const trigger = await seedTicket(store, "I want a refund");
		// The model escalates with a reason phrased as internal triage.
		const escalate: SupportToolCall = {
			id: "call_esc_1",
			name: "escalate_to_department",
			arguments: JSON.stringify({
				department: "billing",
				// A reason phrased as an internal-reasoning block, then a clean answer line.
				reason: "Reasoning: customer is a churn risk, escalate.\n\nWe'll have our billing team process your refund.",
			}),
		};
		const provider = new FakeProvider("", [escalate]);

		const result = await run(store, provider, trigger);

		expect(result.kind).toBe("escalated");
		const thread = await store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		// The routing note is posted; the internal "Reasoning:" block is stripped, so the
		// chain-of-thought never reaches the customer-visible message.
		expect(aiMsg?.body).toContain("billing team");
		expect(aiMsg?.body).not.toContain("Reasoning");
		expect(aiMsg?.body).not.toContain("churn risk");
		// The clean customer-facing portion of the reason survives.
		expect(aiMsg?.body).toContain("process your refund");
	});

	// ── P1 #1 end-to-end: reasoning-only model output → safe localized handoff ────
	test("a REASONING-ONLY model reply posts a localized (Thai) safe handoff, NEVER the leaked reasoning", async () => {
		const store = new FileSupportTicketStore(join(tempDir("hygiene-reasononly-th-"), "tickets.json"));
		const trigger = await seedTicket(store, "สวัสดีครับ เครดิตของผมหายไปไหน");
		// The model returns ONLY internal triage — no customer-facing answer survives stripping.
		const provider = new FakeProvider("Reasoning: ลูกค้ารายนี้เป็น churn risk ให้ปลอบใจไว้ก่อน แล้วค่อยเสนอแพ็กเกจ");

		const result = await run(store, provider, trigger);

		// Not posted as a normal reply with leaked text — handed off with a safe message.
		expect(result.kind).toBe("handoff");
		const thread = await store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		// The posted message is the localized Thai safe handoff…
		expect(aiMsg?.body).toBe(safeHandoffMessage(detectCustomerLanguage("เครดิตของผมหายไปไหน")));
		expect(aiMsg?.body).toContain("ฝ่ายสนับสนุน");
		// …NOT the model's internal reasoning, and NOT empty.
		expect(aiMsg?.body).not.toContain("churn risk");
		expect(aiMsg?.body).not.toContain("Reasoning");
		expect((aiMsg?.body ?? "").trim().length).toBeGreaterThan(0);
	});

	test("a REASONING-ONLY model reply (English customer) posts the English safe handoff", async () => {
		const store = new FileSupportTicketStore(join(tempDir("hygiene-reasononly-en-"), "tickets.json"));
		const trigger = await seedTicket(store, "Where are my credits?");
		const provider = new FakeProvider("Reasoning: customer is a churn risk, reassure then upsell.");

		const result = await run(store, provider, trigger);

		expect(result.kind).toBe("handoff");
		const thread = await store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		expect(aiMsg?.body).toContain("support specialist will follow up");
		expect(aiMsg?.body).not.toContain("churn risk");
		expect(aiMsg?.body).not.toContain("upsell");
	});

	// ── P1 #2 end-to-end: escalation routing note localized to the customer ───────
	test("a THAI ticket's escalation routing note is in THAI (not hardcoded English)", async () => {
		const store = new FileSupportTicketStore(join(tempDir("hygiene-esc-th-"), "tickets.json"));
		const trigger = await seedTicket(store, "ผมต้องการขอเงินคืนครับ");
		const escalate: SupportToolCall = {
			id: "call_esc_th",
			name: "escalate_to_department",
			arguments: JSON.stringify({
				department: "billing",
				// Clean (non-reasoning) Thai reason → it survives in the parenthetical.
				reason: "ทีมการเงินจะดำเนินการคืนเงินให้คุณ",
			}),
		};
		const provider = new FakeProvider("", [escalate]);

		const result = await run(store, provider, trigger);

		expect(result.kind).toBe("escalated");
		const thread = await store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		// The routing note is THAI: it contains the localized note/team label and NO Latin
		// letters (the old hardcoded-English "I've routed this to our billing team" is gone).
		expect(aiMsg?.body).toContain("ส่งเรื่องนี้ต่อ");
		expect(aiMsg?.body).toContain("การเรียกเก็บเงิน");
		expect(aiMsg?.body).not.toContain("routed this");
		expect(aiMsg?.body).not.toContain("billing team");
		expect(/[A-Za-z]/.test(aiMsg?.body ?? "")).toBe(false);
	});

	test("a reasoning-only escalation REASON omits the parenthetical AND leaks nothing (Thai)", async () => {
		const store = new FileSupportTicketStore(join(tempDir("hygiene-esc-th-reasononly-"), "tickets.json"));
		const trigger = await seedTicket(store, "ขอคืนเงินครับ บัญชีนี้มีปัญหา");
		const escalate: SupportToolCall = {
			id: "call_esc_th2",
			name: "escalate_to_department",
			arguments: JSON.stringify({
				department: "billing",
				// A reason that is PURE internal reasoning → stripInternalReasoning → "".
				reason: "Reasoning: customer is a churn risk and possible refund-bait, escalate quietly.",
			}),
		};
		const provider = new FakeProvider("", [escalate]);

		const result = await run(store, provider, trigger);

		expect(result.kind).toBe("escalated");
		const thread = await store.listMessages(trigger.ticketId, { limit: 50 });
		const aiMsg = thread.items.find((m) => m.authorKind === "ai");
		// The Thai routing note is posted, the reasoning is GONE, and the parenthetical is
		// omitted cleanly (no dangling "()" / "（）").
		expect(aiMsg?.body).toContain("ส่งเรื่องนี้ต่อ");
		expect(aiMsg?.body).not.toContain("churn risk");
		expect(aiMsg?.body).not.toContain("refund-bait");
		expect(aiMsg?.body).not.toContain("Reasoning");
		expect(aiMsg?.body).not.toContain("()");
		expect(aiMsg?.body).not.toContain("（）");
		expect(/[A-Za-z]/.test(aiMsg?.body ?? "")).toBe(false);
	});
});
