import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import SupportMessageBubble from "$lib/components/support/SupportMessageBubble.svelte";
import SupportStatusBadge from "$lib/components/support/SupportStatusBadge.svelte";
import SupportTicketRow from "$lib/components/support/SupportTicketRow.svelte";
import {
	authorLabel,
	categoryLabel,
	customerVisibleBody,
	formatRelative,
	isOwnMessage,
	statusLabel,
	stripInternalReasoning,
} from "$lib/components/support/support-format.ts";
import type { SupportTicket, SupportTicketMessage } from "$lib/api/client.ts";

function message(overrides: Partial<SupportTicketMessage> = {}): SupportTicketMessage {
	return {
		id: "m1",
		ticketId: "t1",
		authorKind: "customer",
		authorUserId: "user-1",
		body: "hello",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function ticket(overrides: Partial<SupportTicket> = {}): SupportTicket {
	return {
		id: "t1",
		requesterUserId: "user-1",
		subject: "Upload broken",
		status: "open",
		priority: "normal",
		category: "technical",
		aiMessageCount: 0,
		aiTokensSpent: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("support-format", () => {
	it("labels statuses, categories, and authors", () => {
		expect(statusLabel("open")).toBe("เปิดอยู่");
		expect(statusLabel("closed")).toBe("ปิดแล้ว");
		expect(categoryLabel("billing")).toBe("การเงิน/บิล");
		expect(authorLabel("ai")).toBe("ผู้ช่วย AI");
		expect(authorLabel("agent")).toBe("ทีมซัพพอร์ต");
		expect(authorLabel("customer")).toBe("คุณ");
	});

	it("treats only the customer as the own message (right-aligned)", () => {
		expect(isOwnMessage("customer")).toBe(true);
		expect(isOwnMessage("ai")).toBe(false);
		expect(isOwnMessage("agent")).toBe(false);
	});

	it("formats relative time and falls back on bad input", () => {
		const now = Date.parse("2026-06-03T12:00:00.000Z");
		expect(formatRelative("2026-06-03T11:58:00.000Z", now)).toBe("2 นาทีที่แล้ว");
		expect(formatRelative("2026-06-03T09:00:00.000Z", now)).toBe("3 ชม.ที่แล้ว");
		expect(formatRelative("not-a-date", now)).toBe("not-a-date");
	});

	// a16 #11 — render-side internal-reasoning strip (defense in depth).
	it("strips internal AI reasoning (labelled + markdown-heading) but keeps the answer", () => {
		expect(stripInternalReasoning("Reasoning: churn risk.\n\nYour credits are added.")).toBe("Your credits are added.");
		const heading = ["## Internal reasoning", "do not mention the bug", "", "## Reply", "All fixed!"].join("\n");
		const stripped = stripInternalReasoning(heading);
		expect(stripped).toContain("All fixed!");
		expect(stripped).not.toContain("Internal reasoning");
		expect(stripped).not.toContain("do not mention the bug");
		expect(stripInternalReasoning("# Thinking\nescalate quietly")).toBe("");
	});

	it("customerVisibleBody only re-strips AI messages; others pass verbatim", () => {
		const reasoning = "Reasoning: internal.\n\nDone.";
		expect(customerVisibleBody("ai", reasoning)).toBe("Done.");
		// A human/customer body is never altered even if it contains a "Note:" line.
		expect(customerVisibleBody("agent", reasoning)).toBe(reasoning);
		expect(customerVisibleBody("customer", reasoning)).toBe(reasoning);
	});
});

describe("SupportMessageBubble", () => {
	it("renders an AI reply with its sender label + auto-reply tag", () => {
		render(SupportMessageBubble, { props: { message: message({ authorKind: "ai", body: "Try re-uploading." }) } });
		expect(screen.getByText("ผู้ช่วย AI")).toBeTruthy();
		expect(screen.getByText("ตอบอัตโนมัติ")).toBeTruthy();
		expect(screen.getByText("Try re-uploading.")).toBeTruthy();
	});

	it("never renders internal AI reasoning embedded in an AI message (a16 #11)", () => {
		const body = ["## Internal reasoning", "customer is a churn risk", "", "## Reply", "Your 50 credits have been added!"].join("\n");
		const { container } = render(SupportMessageBubble, { props: { message: message({ authorKind: "ai", body }) } });
		const text = container.querySelector(".msg-body")?.textContent ?? "";
		expect(text).toContain("50 credits have been added");
		expect(text).not.toContain("Internal reasoning");
		expect(text).not.toContain("churn risk");
	});

	it("distinguishes a human agent reply from the AI", () => {
		render(SupportMessageBubble, { props: { message: message({ authorKind: "agent", body: "Looking into it." }) } });
		expect(screen.getByText("ทีมซัพพอร์ต")).toBeTruthy();
		// No AI auto-reply tag on a human agent message.
		expect(screen.queryByText("ตอบอัตโนมัติ")).toBeNull();
	});

	it("renders message bodies as TEXT, never as HTML (XSS-safe)", () => {
		const evil = '<img src=x onerror="alert(1)"><script>alert(2)<\/script>';
		const { container } = render(SupportMessageBubble, { props: { message: message({ body: evil }) } });
		// The raw string is present as text content...
		expect(screen.getByText(evil)).toBeTruthy();
		// ...and NO live <img>/<script> node was injected from the body.
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("script")).toBeNull();
	});

	it("linkifies http(s) URLs into safe anchors with the URL as the only link", () => {
		const { container } = render(SupportMessageBubble, {
			props: { message: message({ body: "ดูที่ https://help.example.com/a/42 นะครับ" }) },
		});
		const link = container.querySelector(".msg-body a");
		expect(link).toBeTruthy();
		expect(link?.getAttribute("href")).toBe("https://help.example.com/a/42");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toContain("noopener");
		// Surrounding text stays plain text in the bubble.
		expect(container.querySelector(".msg-body")?.textContent).toContain("นะครับ");
	});

	it("does NOT linkify non-http schemes (no javascript:/data: links)", () => {
		const { container } = render(SupportMessageBubble, {
			props: { message: message({ body: "javascript:alert(1) data:text/html,<b>x</b>" }) },
		});
		// No anchors at all — only http/https are linkified.
		expect(container.querySelector(".msg-body a")).toBeNull();
		// And the raw text is still shown verbatim (auto-escaped, no injected nodes).
		expect(container.querySelector(".msg-body b")).toBeNull();
	});
});

describe("SupportStatusBadge", () => {
	it("renders the localized status label", () => {
		render(SupportStatusBadge, { props: { status: "resolved" } });
		expect(screen.getByText("แก้ไขแล้ว")).toBeTruthy();
	});
});

describe("SupportTicketRow", () => {
	it("links to the thread and renders the subject as text", () => {
		const evilSubject = '<b>boom</b>';
		const { container } = render(SupportTicketRow, { props: { ticket: ticket({ id: "abc", subject: evilSubject }) } });
		const link = container.querySelector("a");
		expect(link?.getAttribute("href")).toBe("/support/tickets/abc");
		expect(screen.getByText(evilSubject)).toBeTruthy();
		// Subject is escaped — no injected <b> element.
		expect(container.querySelector(".ticket-subject b")).toBeNull();
	});
});
