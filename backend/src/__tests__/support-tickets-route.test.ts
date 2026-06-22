import { describe, expect, test } from "bun:test";
import type { Context, Next } from "hono";
import {
	createSupportTicketsRouter,
	type NotifyFn,
	type SupportTicketRouterDeps,
} from "../routes/support-tickets.js";
import { FileSupportTicketStore, type SupportTicketRecord, type SupportTicketMessageRecord } from "../services/support-tickets.js";
import { layeredRateLimit, MemoryRateLimitStore, type RateLimitPolicy } from "../middleware/rate-limit.js";
import type { NotifyInput, NotifyResult } from "../services/notification-dispatch.js";
import type { UserRole } from "../types/auth.js";

function stubAuth(userId: string, role: UserRole = "editor") {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${userId}@example.com`, role });
		await next();
	};
}

/**
 * Build a router with the route-scoped throttle DISABLED by default. The
 * functional/isolation/validation suites are not exercising the limiter, and
 * the production-default limiter uses the module-level shared rate-limit store
 * — counters would otherwise leak across these tests' many router instances and
 * trip the 3/min create cap. The dedicated throttle suite below opts back in
 * with its own fresh-store, low-cap limiters.
 */
function makeRouter(deps: SupportTicketRouterDeps): ReturnType<typeof createSupportTicketsRouter> {
	// Also disable the AI auto-trigger + its limiter by default so the existing
	// REST/isolation suites never fan out to the real kill-switch-gated agent. The
	// dedicated AI-trigger suite below opts back in with a spy.
	return createSupportTicketsRouter({
		createLimiter: null,
		replyLimiter: null,
		aiRespondLimiter: null,
		triggerAgent: null,
		...deps,
	});
}

/** Records every notify() call so tests can assert what fired. */
function spyNotify(): { fn: NotifyFn; calls: NotifyInput[] } {
	const calls: NotifyInput[] = [];
	const fn: NotifyFn = async (input: NotifyInput): Promise<NotifyResult> => {
		calls.push(input);
		return { inAppDelivered: true, emailAttempted: false, skipped: [] };
	};
	return { fn, calls };
}

interface OpenResponse {
	ticket: SupportTicketRecord;
	message: SupportTicketMessageRecord | null;
}

interface ThreadResponse {
	ticket: SupportTicketRecord;
	messages: SupportTicketMessageRecord[];
}

async function openTicket(
	app: ReturnType<typeof createSupportTicketsRouter>,
	body: Record<string, unknown> = { subject: "Help", body: "It is broken" },
): Promise<{ status: number; data: OpenResponse }> {
	const res = await app.request("/tickets", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, data: (await res.json()) as OpenResponse };
}

describe("support tickets — customer REST API", () => {
	test("happy path: open → list-own → get-thread → reply → close", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const app = makeRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice"),
			supportQueueUserId: "support-queue",
		});

		// open
		const opened = await openTicket(app, { subject: "Cannot export", body: "Export hangs at 50%", category: "technical" });
		expect(opened.status).toBe(201);
		expect(opened.data.ticket.requesterUserId).toBe("alice");
		expect(opened.data.ticket.status).toBe("open");
		expect(opened.data.ticket.category).toBe("technical");
		expect(opened.data.message?.authorKind).toBe("customer");
		expect(opened.data.message?.body).toBe("Export hangs at 50%");
		const ticketId = opened.data.ticket.id;

		// list-own
		const listRes = await app.request("/tickets");
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as { items: SupportTicketRecord[]; hasMore: boolean };
		expect(list.items).toHaveLength(1);
		expect(list.items[0]?.id).toBe(ticketId);

		// get-thread
		const getRes = await app.request(`/tickets/${ticketId}`);
		expect(getRes.status).toBe(200);
		const thread = (await getRes.json()) as ThreadResponse;
		expect(thread.ticket.id).toBe(ticketId);
		expect(thread.messages).toHaveLength(1);
		expect(thread.messages[0]?.body).toBe("Export hangs at 50%");

		// reply — sleep so the reply's createdAt is a distinct millisecond from the
		// opening message (thread order tie-breaks on the random message id, which
		// is non-deterministic for two same-millisecond inserts).
		await Bun.sleep(2);
		const replyRes = await app.request(`/tickets/${ticketId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Still happening today" }),
		});
		expect(replyRes.status).toBe(201);
		const reply = (await replyRes.json()) as { ticket: SupportTicketRecord; message: SupportTicketMessageRecord };
		expect(reply.message.authorKind).toBe("customer");
		expect(reply.message.body).toBe("Still happening today");

		// thread now has 2 messages, oldest-first
		const getRes2 = await app.request(`/tickets/${ticketId}`);
		const thread2 = (await getRes2.json()) as ThreadResponse;
		expect(thread2.messages.map((m) => m.body)).toEqual(["Export hangs at 50%", "Still happening today"]);

		// close
		const closeRes = await app.request(`/tickets/${ticketId}/close`, { method: "POST" });
		expect(closeRes.status).toBe(200);
		const closed = (await closeRes.json()) as { ticket: SupportTicketRecord };
		expect(closed.ticket.status).toBe("closed");
	});

	test("notify() fires on open: requester confirmation + support queue", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const app = makeRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice"),
			supportQueueUserId: "support-queue",
		});

		await openTicket(app, { subject: "Billing question", body: "Charged twice", category: "billing" });
		// allow the fire-and-forget notify() microtasks to settle
		await Bun.sleep(5);

		const byUser = new Map(notify.calls.map((c) => [c.userId, c]));
		expect(byUser.get("alice")?.type).toBe("ticket_opened");
		expect(byUser.get("support-queue")?.type).toBe("ticket_replied");
		// dispatcher resolves recipient email itself — the route never passes one
		expect(notify.calls.every((c) => c.email === undefined)).toBe(true);
		expect(byUser.get("alice")?.metadata?.event).toBe("opened");
	});

	test("notify() fires on reply to the support queue when unassigned", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const app = makeRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice"),
			supportQueueUserId: "support-queue",
		});

		const opened = await openTicket(app);
		await Bun.sleep(5);
		notify.calls.length = 0; // clear open-time notifications

		await app.request(`/tickets/${opened.data.ticket.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "any update?" }),
		});
		await Bun.sleep(5);

		expect(notify.calls).toHaveLength(1);
		expect(notify.calls[0]?.userId).toBe("support-queue");
		expect(notify.calls[0]?.type).toBe("ticket_replied");
		expect(notify.calls[0]?.metadata?.event).toBe("reply");
	});

	test("no queue configured: open notifies only the requester (no self-spam)", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const app = makeRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice"),
			supportQueueUserId: "", // file/dev mode default
		});

		await openTicket(app);
		await Bun.sleep(5);

		expect(notify.calls).toHaveLength(1);
		expect(notify.calls[0]?.userId).toBe("alice");
		expect(notify.calls[0]?.type).toBe("ticket_opened");
	});

	test("a reply to a closed ticket reopens it (status → open)", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const app = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("alice") });

		const opened = await openTicket(app);
		const id = opened.data.ticket.id;
		await app.request(`/tickets/${id}/close`, { method: "POST" });

		const replyRes = await app.request(`/tickets/${id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Actually still broken" }),
		});
		expect(replyRes.status).toBe(201);
		const reply = (await replyRes.json()) as { ticket: SupportTicketRecord };
		expect(reply.ticket.status).toBe("open");
	});
});

describe("support tickets — cross-user isolation", () => {
	test("user B cannot list user A's tickets", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const appA = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("alice") });
		const appB = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("bob") });

		await openTicket(appA, { subject: "Alice ticket", body: "secret" });

		const listB = await appB.request("/tickets");
		const body = (await listB.json()) as { items: SupportTicketRecord[] };
		expect(body.items).toHaveLength(0);
	});

	test("user B gets 404 (not 403) for GET / reply / close on user A's ticket", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const appA = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("alice") });
		const appB = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("bob") });

		const opened = await openTicket(appA, { subject: "Alice ticket", body: "secret" });
		const id = opened.data.ticket.id;

		const getRes = await appB.request(`/tickets/${id}`);
		expect(getRes.status).toBe(404);

		const replyRes = await appB.request(`/tickets/${id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "let me in" }),
		});
		expect(replyRes.status).toBe(404);

		const closeRes = await appB.request(`/tickets/${id}/close`, { method: "POST" });
		expect(closeRes.status).toBe(404);

		// Alice's ticket is untouched: still open, still 1 message.
		const aliceThread = (await (await appA.request(`/tickets/${id}`)).json()) as ThreadResponse;
		expect(aliceThread.ticket.status).toBe("open");
		expect(aliceThread.messages).toHaveLength(1);
	});

	test("GET unknown ticket id → 404", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const app = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("alice") });
		const res = await app.request("/tickets/does-not-exist");
		expect(res.status).toBe(404);
	});
});

describe("support tickets — input validation", () => {
	const store = new FileSupportTicketStore();
	const notify = spyNotify();
	const app = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("alice") });

	test("empty subject is rejected", async () => {
		const res = await openTicket(app, { subject: "   ", body: "real body" });
		expect(res.status).toBe(400);
	});

	test("empty body is rejected", async () => {
		const res = await openTicket(app, { subject: "real subject", body: "" });
		expect(res.status).toBe(400);
	});

	test("oversized subject is rejected", async () => {
		const res = await openTicket(app, { subject: "x".repeat(201), body: "ok" });
		expect(res.status).toBe(400);
	});

	test("oversized body is rejected", async () => {
		const res = await openTicket(app, { subject: "ok", body: "x".repeat(10_001) });
		expect(res.status).toBe(400);
	});

	test("unknown category is rejected", async () => {
		const res = await openTicket(app, { subject: "ok", body: "ok", category: "nonsense" });
		expect(res.status).toBe(400);
	});

	test("unknown extra field is rejected (strict schema)", async () => {
		const res = await openTicket(app, { subject: "ok", body: "ok", priority: "urgent" });
		expect(res.status).toBe(400);
	});

	test("empty reply body is rejected", async () => {
		const opened = await openTicket(app, { subject: "ok", body: "ok" });
		const res = await app.request(`/tickets/${opened.data.ticket.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "  " }),
		});
		expect(res.status).toBe(400);
	});

	test("invalid JSON body is rejected", async () => {
		const res = await app.request("/tickets", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});
});

// ── Spam / cost throttle on ticket creation + reply ────────────────────────
// Codex P1 on PR #173: an authed user could spam POST /tickets at the generic
// api:global scale (~600/min), each persisting a ticket + message and fanning
// out notifications. These tests pin the dedicated route-scoped limiter: it
// BLOCKS (429) past the cap, persists/notifies nothing on a throttled request,
// and is independent of the generic api:global counter.

/** A low-cap CREATE limiter over a fresh, isolated store. */
function lowCapCreateLimiter(maxPerMinute: number, store = new MemoryRateLimitStore()) {
	const policies: RateLimitPolicy[] = [
		{
			id: "api:support-ticket-create",
			windowMs: 60_000,
			maxRequests: maxPerMinute,
			scopes: ["user", "ip"],
			failureMode: "block",
		},
	];
	return layeredRateLimit({ policies, store, fallbackStore: null });
}

async function postTicket(app: ReturnType<typeof createSupportTicketsRouter>, n: number) {
	return app.request("/tickets", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subject: `Spam ${n}`, body: `attempt ${n}` }),
	});
}

describe("support tickets — creation throttle (Codex P1)", () => {
	test("past SUPPORT_TICKET_CREATE_PER_MINUTE → 429, no extra ticket/notification persisted", async () => {
		const cap = 3;
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const app = createSupportTicketsRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice"),
			supportQueueUserId: "support-queue",
			createLimiter: lowCapCreateLimiter(cap),
			replyLimiter: null,
		});

		// Fire cap + 2 rapid creates.
		const statuses: number[] = [];
		for (let i = 0; i < cap + 2; i += 1) {
			const res = await postTicket(app, i);
			statuses.push(res.status);
		}
		await Bun.sleep(10); // let any fire-and-forget notify() settle

		// First `cap` succeed, the rest are blocked with 429 (not 503).
		expect(statuses.slice(0, cap)).toEqual(Array.from({ length: cap }, () => 201));
		expect(statuses.slice(cap)).toEqual([429, 429]);

		// Exactly `cap` tickets exist for alice — the throttled requests wrote nothing.
		const list = (await (await app.request("/tickets")).json()) as { items: SupportTicketRecord[] };
		expect(list.items).toHaveLength(cap);

		// Exactly `cap` open events fired (requester + queue each), none for the
		// throttled attempts. 2 notifications per successful open.
		const openEvents = notify.calls.filter((call) => call.metadata?.event === "opened");
		expect(openEvents).toHaveLength(cap * 2);
	});

	test("under the cap works", async () => {
		const store = new FileSupportTicketStore();
		const app = createSupportTicketsRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice"),
			createLimiter: lowCapCreateLimiter(5),
			replyLimiter: null,
		});

		for (let i = 0; i < 5; i += 1) {
			expect((await postTicket(app, i)).status).toBe(201);
		}
	});

	test("limiter response is a clean 429 with the support policy id", async () => {
		const app = createSupportTicketsRouter({
			store: new FileSupportTicketStore(),
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice"),
			createLimiter: lowCapCreateLimiter(1),
			replyLimiter: null,
		});

		expect((await postTicket(app, 0)).status).toBe(201);
		const blocked = await postTicket(app, 1);
		expect(blocked.status).toBe(429);
		const body = (await blocked.json()) as { code: string; policyId: string };
		expect(body.code).toBe("rate_limit_exceeded");
		expect(body.policyId).toBe("api:support-ticket-create");
	});

	test("the throttle is INDEPENDENT of the generic api:global limit", async () => {
		// Two limiters over the SAME store: a tight support-create policy AND a
		// huge api:global policy. The support policy must trip on its own count
		// while api:global is nowhere near its cap — proving the support limiter
		// is not piggy-backing on (or masked by) the generic bucket.
		const sharedStore = new MemoryRateLimitStore();
		const limiter = layeredRateLimit({
			policies: [
				{ id: "api:support-ticket-create", windowMs: 60_000, maxRequests: 2, scopes: ["user", "ip"], failureMode: "block" },
				{ id: "api:global", windowMs: 60_000, maxRequests: 100_000, scopes: ["ip"], failureMode: "fallback" },
			],
			store: sharedStore,
			fallbackStore: null,
		});
		const app = createSupportTicketsRouter({
			store: new FileSupportTicketStore(),
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice"),
			createLimiter: limiter,
			replyLimiter: null,
		});

		expect((await postTicket(app, 0)).status).toBe(201);
		expect((await postTicket(app, 1)).status).toBe(201);
		const blocked = await postTicket(app, 2);
		expect(blocked.status).toBe(429);
		const body = (await blocked.json()) as { policyId: string };
		// Rejected by the SUPPORT policy, not the generic one (which still has headroom).
		expect(body.policyId).toBe("api:support-ticket-create");
	});

	test("replies are throttled too (looser cap)", async () => {
		const store = new FileSupportTicketStore();
		const app = createSupportTicketsRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice"),
			createLimiter: null, // isolate the reply path
			replyLimiter: layeredRateLimit({
				policies: [{ id: "api:support-ticket-reply", windowMs: 60_000, maxRequests: 2, scopes: ["user", "ip"], failureMode: "block" }],
				store: new MemoryRateLimitStore(),
				fallbackStore: null,
			}),
		});

		const opened = await openTicket(app, { subject: "ok", body: "ok" });
		const id = opened.data.ticket.id;

		const reply = async (n: number) =>
			(await app.request(`/tickets/${id}/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: `reply ${n}` }),
			})).status;

		expect(await reply(0)).toBe(201);
		expect(await reply(1)).toBe(201);
		expect(await reply(2)).toBe(429);

		// Thread holds the opening message + the 2 accepted replies only (3 total).
		const thread = (await (await app.request(`/tickets/${id}`)).json()) as ThreadResponse;
		expect(thread.messages).toHaveLength(3);
	});
});

describe("support tickets — AI agent trigger wiring", () => {
	test("a customer reply fires the agent trigger with the reply's message id (fire-and-forget)", async () => {
		const store = new FileSupportTicketStore();
		const triggers: Array<{ ticketId: string; triggerMessageId: string }> = [];
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice"),
			// Spy trigger replaces the real kill-switch-gated fire-and-forget hook.
			triggerAgent: (input) => triggers.push({ ticketId: input.ticketId, triggerMessageId: input.triggerMessageId }),
		});

		const opened = await openTicket(app, { subject: "topup", body: "I paid but no credits" });
		const id = opened.data.ticket.id;
		// Opening a ticket does NOT auto-trigger (only a customer REPLY does).
		expect(triggers).toHaveLength(0);

		const replyRes = await app.request(`/tickets/${id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "still missing my credits" }),
		});
		expect(replyRes.status).toBe(201);
		const reply = (await replyRes.json()) as { message: SupportTicketMessageRecord };
		// The agent was triggered with the reply message id.
		expect(triggers).toHaveLength(1);
		expect(triggers[0]?.ticketId).toBe(id);
		expect(triggers[0]?.triggerMessageId).toBe(reply.message.id);
	});

	test("POST /tickets/:id/ai-respond drives the awaited agent on the latest customer message", async () => {
		const store = new FileSupportTicketStore();
		const seen: Array<{ ticketId: string; triggerMessageId: string; ignoreSingleFlight?: boolean }> = [];
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice"),
			triggerAgentNow: async (input) => {
				seen.push({ ticketId: input.ticketId, triggerMessageId: input.triggerMessageId, ignoreSingleFlight: input.ignoreSingleFlight });
				return { kind: "replied", tokensSpent: 123, detail: "Replied." };
			},
		});

		const opened = await openTicket(app, { subject: "q", body: "first customer message" });
		const id = opened.data.ticket.id;

		const res = await app.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		expect(res.status).toBe(200);
		const data = (await res.json()) as { outcome: string; detail: string };
		expect(data.outcome).toBe("replied");
		// The endpoint resolved the latest customer message. SECURITY FIX: the CUSTOMER
		// route must NOT force a fresh run — it never sets ignoreSingleFlight, so the
		// atomic single-flight claim governs whether a repeated press actually re-runs.
		expect(seen).toHaveLength(1);
		expect(seen[0]?.ticketId).toBe(id);
		expect(seen[0]?.ignoreSingleFlight).toBeFalsy();
		expect(seen[0]?.triggerMessageId).toBe(opened.data.message!.id);
	});

	test("ai-respond on another user's ticket is 404 (no existence leak)", async () => {
		const store = new FileSupportTicketStore();
		const appAlice = makeRouter({ store, notify: spyNotify().fn, authMiddleware: stubAuth("alice"), triggerAgentNow: async () => ({ kind: "replied", tokensSpent: 0, detail: "" }) });
		const opened = await openTicket(appAlice, { subject: "q", body: "mine" });
		const id = opened.data.ticket.id;

		const appBob = makeRouter({ store, notify: spyNotify().fn, authMiddleware: stubAuth("bob"), triggerAgentNow: async () => ({ kind: "replied", tokensSpent: 0, detail: "" }) });
		const res = await appBob.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		expect(res.status).toBe(404);
	});
});

describe("support tickets — customer thread NEVER leaks internal content (a16 #11)", () => {
	async function getThread(
		app: ReturnType<typeof createSupportTicketsRouter>,
		ticketId: string,
	): Promise<{ status: number; data: ThreadResponse }> {
		const res = await app.request(`/tickets/${ticketId}`);
		return { status: res.status, data: (await res.json()) as ThreadResponse };
	}

	test("excludes internal-author-kind notes AND re-strips AI reasoning from the customer thread", async () => {
		const store = new FileSupportTicketStore();
		const app = makeRouter({ store, notify: spyNotify().fn, authMiddleware: stubAuth("alice") });

		const opened = await openTicket(app, { subject: "Billing", body: "Where are my credits?" });
		const ticketId = opened.data.ticket.id;

		// A staff-only internal note — must never reach the customer.
		await store.addMessage({
			ticketId,
			authorKind: "internal",
			authorUserId: "staff-1",
			body: "INTERNAL: customer is a churn risk, do not offer a refund.",
		});
		// An AI reply that ALSO embeds internal reasoning under a markdown heading —
		// the reasoning section must be stripped at render time even though the
		// author kind (ai) is customer-visible.
		await store.addMessage({
			ticketId,
			authorKind: "ai",
			body: [
				"## Internal reasoning",
				"They asked twice already; escalate quietly if they push back.",
				"",
				"## Reply",
				"Your 50 credits have been added — thanks for your patience!",
			].join("\n"),
		});

		const { status, data } = await getThread(app, ticketId);
		expect(status).toBe(200);
		const kinds = data.messages.map((m) => m.authorKind);
		// No internal-author-kind message ever appears.
		expect(kinds).not.toContain("internal");
		const blob = data.messages.map((m) => m.body).join("\n");
		// The AI reply survives, but ONLY its customer-facing portion.
		expect(blob).toContain("50 credits have been added");
		expect(blob).not.toContain("Internal reasoning");
		expect(blob).not.toContain("escalate quietly");
		expect(blob).not.toContain("churn risk");
	});

	test("an AI message that is reasoning-only is DROPPED, never rendered empty", async () => {
		const store = new FileSupportTicketStore();
		const app = makeRouter({ store, notify: spyNotify().fn, authMiddleware: stubAuth("alice") });

		const opened = await openTicket(app, { subject: "Q", body: "hello" });
		const ticketId = opened.data.ticket.id;
		await store.addMessage({
			ticketId,
			authorKind: "ai",
			body: "Reasoning: nothing customer-facing to say here, escalate.",
		});

		const { data } = await getThread(app, ticketId);
		// Only the customer's opening message remains; the reasoning-only AI row is gone.
		expect(data.messages.every((m) => m.authorKind !== "ai")).toBe(true);
		expect(data.messages.every((m) => m.body.trim().length > 0)).toBe(true);
	});
});
