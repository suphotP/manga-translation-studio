import { describe, expect, test } from "bun:test";
import type { Context, Next } from "hono";
import {
	createSupportTicketsRouter,
	type NotifyFn,
	type SupportTicketRouterDeps,
} from "../routes/support-tickets.js";
import {
	FileSupportTicketStore,
	type ListMessagesOptions,
	type MessagePage,
	type SupportTicketRecord,
	type SupportTicketMessageRecord,
} from "../services/support-tickets.js";
import type { NotifyInput, NotifyResult } from "../services/notification-dispatch.js";
import type { UserRole } from "../types/auth.js";

function stubAuth(userId: string, role: UserRole = "support") {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${userId}@example.com`, role });
		await next();
	};
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

/**
 * Build a router with throttle + AI auto-trigger disabled by default (the agent
 * suites are not exercising the limiter or the real kill-switch-gated agent).
 * `agentAuthMiddleware` sets the STAFF role on /agent/*; `authMiddleware` sets
 * the CUSTOMER role on the rest. Override per-test as needed.
 */
function makeRouter(deps: SupportTicketRouterDeps): ReturnType<typeof createSupportTicketsRouter> {
	return createSupportTicketsRouter({
		createLimiter: null,
		replyLimiter: null,
		aiRespondLimiter: null,
		triggerAgent: null,
		...deps,
	});
}

class CountingFileSupportTicketStore extends FileSupportTicketStore {
	listMessagesCalls = 0;

	override async listMessages(ticketId: string, options?: ListMessagesOptions): Promise<MessagePage> {
		this.listMessagesCalls += 1;
		return super.listMessages(ticketId, options);
	}
}

interface OpenResponse {
	ticket: SupportTicketRecord;
	message: SupportTicketMessageRecord | null;
}

interface ThreadResponse {
	ticket: SupportTicketRecord;
	messages: SupportTicketMessageRecord[];
}

/** Open a ticket directly on the store so we don't depend on a separate router. */
async function seedTicket(
	store: FileSupportTicketStore,
	requesterUserId = "alice",
	overrides: Partial<{ subject: string; body: string }> = {},
): Promise<SupportTicketRecord> {
	return store.createTicket({
		requesterUserId,
		subject: overrides.subject ?? "Cannot export",
		body: overrides.body ?? "Export hangs at 50%",
		category: "technical",
	});
}

describe("support agent — RBAC gating", () => {
	test("staff inbox GET /agent/tickets requires SUPPORT_READ (editor/customer → 403, no user → 401)", async () => {
		const store = new FileSupportTicketStore();
		await seedTicket(store);

		const asSupport = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth("agent-1", "support") });
		expect((await asSupport.request("/agent/tickets")).status).toBe(200);

		const asEditor = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth("ed", "editor") });
		expect((await asEditor.request("/agent/tickets")).status).toBe(403);

		const asViewer = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth("vi", "viewer") });
		expect((await asViewer.request("/agent/tickets")).status).toBe(403);

		// No authenticated user → 401.
		const noAuth = makeRouter({
			store,
			notify: spyNotify().fn,
			agentAuthMiddleware: async (_c: Context, next: Next) => {
				await next();
			},
		});
		expect((await noAuth.request("/agent/tickets")).status).toBe(401);
	});

	test("admin and owner can read; mutating endpoints require SUPPORT_ADJUST (editor → 403)", async () => {
		const store = new FileSupportTicketStore();
		const ticket = await seedTicket(store);

		for (const role of ["admin", "owner", "support"] as UserRole[]) {
			const app = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth(`u-${role}`, role) });
			expect((await app.request(`/agent/tickets/${ticket.id}`)).status).toBe(200);
		}

		// Editor cannot reply (SUPPORT_ADJUST).
		const editor = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth("ed", "editor") });
		const replyRes = await editor.request(`/agent/tickets/${ticket.id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "hi" }),
		});
		expect(replyRes.status).toBe(403);
	});
});

describe("support agent — inbox", () => {
	test("lists ALL tickets across requesters, with status/assignee/queue filters", async () => {
		const store = new FileSupportTicketStore();
		const a = await seedTicket(store, "alice", { subject: "A" });
		await Bun.sleep(2);
		const b = await seedTicket(store, "bob", { subject: "B" });
		await Bun.sleep(2);
		await store.updateStatus(b.id, "escalated");
		await store.assign(a.id, "agent-9", "tier2");

		const app = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		// All tickets (both requesters).
		const all = (await (await app.request("/agent/tickets")).json()) as { items: SupportTicketRecord[] };
		expect(all.items.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());

		// status filter.
		const escalated = (await (await app.request("/agent/tickets?status=escalated")).json()) as { items: SupportTicketRecord[] };
		expect(escalated.items.map((t) => t.id)).toEqual([b.id]);

		// assignee filter.
		const mine = (await (await app.request("/agent/tickets?assignee=agent-9")).json()) as { items: SupportTicketRecord[] };
		expect(mine.items.map((t) => t.id)).toEqual([a.id]);

		// queue filter.
		const tier2 = (await (await app.request("/agent/tickets?queue=tier2")).json()) as { items: SupportTicketRecord[] };
		expect(tier2.items.map((t) => t.id)).toEqual([a.id]);
	});

	test("unknown ticket id → 404", async () => {
		const store = new FileSupportTicketStore();
		const app = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth("agent-1", "support") });
		expect((await app.request("/agent/tickets/nope")).status).toBe(404);
	});
});

describe("support agent — assign / reply / escalate / resolve / close notify the right user", () => {
	test("assign notifies the new assignee", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const ticket = await seedTicket(store);
		const app = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		const res = await app.request(`/agent/tickets/${ticket.id}/assign`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ assigneeUserId: "agent-7", queue: "tier2" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ticket: SupportTicketRecord };
		expect(body.ticket.assigneeUserId).toBe("agent-7");
		expect(body.ticket.queue).toBe("tier2");
		await Bun.sleep(5);
		expect(notify.calls).toHaveLength(1);
		expect(notify.calls[0]?.userId).toBe("agent-7");
		expect(notify.calls[0]?.metadata?.event).toBe("assigned");
	});

	test("re-assigning to the SAME assignee does NOT re-notify (only a real transition notifies)", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const ticket = await seedTicket(store);
		const app = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		// First assign → a real transition (none → agent-7) → notifies once.
		const first = await app.request(`/agent/tickets/${ticket.id}/assign`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ assigneeUserId: "agent-7" }),
		});
		expect(first.status).toBe(200);
		await Bun.sleep(5);
		expect(notify.calls).toHaveLength(1);
		expect(notify.calls[0]?.userId).toBe("agent-7");
		// A stable idempotency key keyed on (ticket, assignee) is passed so a retried
		// assign dedupes at the mailer too.
		expect(notify.calls[0]?.idempotencyKey).toBe(`ticket-assign:${ticket.id}:agent-7`);

		// Second assign to the SAME assignee → NO transition → NO second notification.
		const second = await app.request(`/agent/tickets/${ticket.id}/assign`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ assigneeUserId: "agent-7" }),
		});
		expect(second.status).toBe(200);
		await Bun.sleep(5);
		expect(notify.calls).toHaveLength(1); // still just the one

		// A queue-only move that re-affirms the same assignee → still no new notification.
		const queueMove = await app.request(`/agent/tickets/${ticket.id}/assign`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ assigneeUserId: "agent-7", queue: "tier3" }),
		});
		expect(queueMove.status).toBe(200);
		await Bun.sleep(5);
		expect(notify.calls).toHaveLength(1);

		// Re-assigning to a DIFFERENT user IS a transition → notifies the new assignee.
		const reassign = await app.request(`/agent/tickets/${ticket.id}/assign`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ assigneeUserId: "agent-9" }),
		});
		expect(reassign.status).toBe(200);
		await Bun.sleep(5);
		expect(notify.calls).toHaveLength(2);
		expect(notify.calls[1]?.userId).toBe("agent-9");
	});

	test("requester notifications are LOCALIZED to the requester's language (non-en)", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		// A Thai customer — their opening message is Thai, so every requester-facing
		// notification (escalate/resolve) must be Thai, not hardcoded English, and carry
		// locale="th" for the email render.
		const ticket = await seedTicket(store, "somchai", { subject: "ช่วยด้วย", body: "ฉันส่งออกไฟล์ไม่ได้ ช่วยหน่อย" });
		const app = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		const esc = await app.request(`/agent/tickets/${ticket.id}/escalate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ department: "technical" }),
		});
		expect(esc.status).toBe(200);
		await Bun.sleep(5);
		const escNote = notify.calls.find((n) => n.type === "ticket_escalated" && n.userId === "somchai");
		expect(escNote).toBeDefined();
		expect(escNote?.locale).toBe("th");
		// The title/body must contain Thai script and NOT be the English string.
		expect(/[฀-๿]/.test(escNote!.title)).toBe(true);
		expect(escNote!.title).not.toContain("escalated");
		// Localized email CTA, not the English registry default.
		expect(escNote?.emailActionLabel).toBe("ดูเรื่องที่แจ้ง");

		const resolved = await app.request(`/agent/tickets/${ticket.id}/resolve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(resolved.status).toBe(200);
		await Bun.sleep(5);
		const resNote = notify.calls.find((n) => n.type === "ticket_resolved" && n.userId === "somchai");
		expect(resNote?.locale).toBe("th");
		expect(/[฀-๿]/.test(resNote!.body)).toBe(true);
	});

	test("assign requires at least one of assigneeUserId/queue (400)", async () => {
		const store = new FileSupportTicketStore();
		const ticket = await seedTicket(store);
		const app = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth("agent-1", "support") });
		const res = await app.request(`/agent/tickets/${ticket.id}/assign`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("staff reply (author_kind=agent) notifies the requester + flips open→pending", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const ticket = await seedTicket(store);
		const app = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		const res = await app.request(`/agent/tickets/${ticket.id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Try clearing your cache." }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { ticket: SupportTicketRecord; message: SupportTicketMessageRecord };
		expect(body.message.authorKind).toBe("agent");
		expect(body.message.authorUserId).toBe("agent-1");
		expect(body.ticket.status).toBe("pending");
		await Bun.sleep(5);
		expect(notify.calls).toHaveLength(1);
		expect(notify.calls[0]?.userId).toBe("alice");
		expect(notify.calls[0]?.type).toBe("ticket_replied");
		expect(notify.calls[0]?.metadata?.event).toBe("agent_reply");
	});

	test("escalate sets status=escalated, routes to department, notifies requester", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const ticket = await seedTicket(store);
		const app = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		const res = await app.request(`/agent/tickets/${ticket.id}/escalate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ department: "billing-specialists", reason: "needs a refund decision" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ticket: SupportTicketRecord };
		expect(body.ticket.status).toBe("escalated");
		expect(body.ticket.queue).toBe("billing-specialists");
		await Bun.sleep(5);
		const requester = notify.calls.find((c) => c.userId === "alice");
		expect(requester?.type).toBe("ticket_escalated");
		expect(requester?.metadata?.department).toBe("billing-specialists");
	});

	test("resolve + close notify the requester (ticket_resolved); idempotent", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const ticket = await seedTicket(store);
		const app = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		const resolved = await app.request(`/agent/tickets/${ticket.id}/resolve`, { method: "POST" });
		expect(resolved.status).toBe(200);
		expect(((await resolved.json()) as { ticket: SupportTicketRecord }).ticket.status).toBe("resolved");
		await Bun.sleep(5);
		expect(notify.calls.filter((c) => c.type === "ticket_resolved")).toHaveLength(1);

		// Idempotent: resolving again does not double-notify.
		notify.calls.length = 0;
		await app.request(`/agent/tickets/${ticket.id}/resolve`, { method: "POST" });
		await Bun.sleep(5);
		expect(notify.calls).toHaveLength(0);

		const closed = await app.request(`/agent/tickets/${ticket.id}/close`, { method: "POST" });
		expect(((await closed.json()) as { ticket: SupportTicketRecord }).ticket.status).toBe("closed");
	});
});

describe("support agent — internal-note isolation (CRITICAL)", () => {
	test("internal note is visible to STAFF but NEVER in the customer GET thread", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const ticket = await seedTicket(store);

		const staffApp = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });
		const customerApp = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("alice", "editor") });

		// Staff adds a visible agent reply AND a private internal note.
		await staffApp.request(`/agent/tickets/${ticket.id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "We are looking into it." }),
		});
		await Bun.sleep(2);
		const noteRes = await staffApp.request(`/agent/tickets/${ticket.id}/internal-note`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "SECRET: refund pre-approved by lead" }),
		});
		expect(noteRes.status).toBe(201);
		expect(((await noteRes.json()) as { message: SupportTicketMessageRecord }).message.authorKind).toBe("internal");

		// Staff thread INCLUDES the internal note.
		const staffThread = (await (await staffApp.request(`/agent/tickets/${ticket.id}`)).json()) as ThreadResponse;
		const staffBodies = staffThread.messages.map((m) => m.body);
		expect(staffBodies).toContain("SECRET: refund pre-approved by lead");
		expect(staffThread.messages.some((m) => m.authorKind === "internal")).toBe(true);

		// Customer thread EXCLUDES the internal note.
		const custThread = (await (await customerApp.request(`/tickets/${ticket.id}`)).json()) as ThreadResponse;
		const custBodies = custThread.messages.map((m) => m.body);
		expect(custBodies).not.toContain("SECRET: refund pre-approved by lead");
		expect(custThread.messages.every((m) => m.authorKind !== "internal")).toBe(true);
		// The customer DOES see the agent reply + their own opening message.
		expect(custBodies).toContain("We are looking into it.");
		expect(custBodies).toContain("Export hangs at 50%");
	});

	test("internal note does NOT notify the requester", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const ticket = await seedTicket(store);
		const app = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		await app.request(`/agent/tickets/${ticket.id}/internal-note`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "internal" }),
		});
		await Bun.sleep(5);
		expect(notify.calls).toHaveLength(0);
	});

	test("escalate reason is captured as an internal note, hidden from the customer", async () => {
		const store = new FileSupportTicketStore();
		const ticket = await seedTicket(store);
		const staffApp = makeRouter({ store, notify: spyNotify().fn, agentAuthMiddleware: stubAuth("agent-1", "support") });
		const customerApp = makeRouter({ store, notify: spyNotify().fn, authMiddleware: stubAuth("alice", "editor") });

		await staffApp.request(`/agent/tickets/${ticket.id}/escalate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ department: "trust-safety", reason: "possible chargeback fraud" }),
		});

		const custThread = (await (await customerApp.request(`/tickets/${ticket.id}`)).json()) as ThreadResponse;
		expect(custThread.messages.some((m) => m.body.includes("possible chargeback fraud"))).toBe(false);

		const staffThread = (await (await staffApp.request(`/agent/tickets/${ticket.id}`)).json()) as ThreadResponse;
		expect(staffThread.messages.some((m) => m.body.includes("possible chargeback fraud"))).toBe(true);
	});
});

describe("#180 — AI does NOT auto-reply on human-owned tickets", () => {
	async function openCustomerTicket(app: ReturnType<typeof createSupportTicketsRouter>): Promise<OpenResponse> {
		const res = await app.request("/tickets", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ subject: "topup", body: "I paid but no credits" }),
		});
		return (await res.json()) as OpenResponse;
	}

	test("customer reply on an ESCALATED ticket does NOT trigger AI but DOES notify the assignee", async () => {
		const store = new FileSupportTicketStore();
		const triggers: Array<{ ticketId: string }> = [];
		const notify = spyNotify();
		const customerApp = makeRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgent: (input) => triggers.push({ ticketId: input.ticketId }),
		});
		const opened = await openCustomerTicket(customerApp);
		const id = opened.ticket.id;

		// Escalate (sets status=escalated + assigns the department queue).
		await store.updateStatus(id, "escalated");
		await store.assign(id, "agent-7", "tier2");
		notify.calls.length = 0;

		const replyRes = await customerApp.request(`/tickets/${id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "any update?" }),
		});
		expect(replyRes.status).toBe(201);
		await Bun.sleep(5);

		// AI was NOT triggered (anti-cost).
		expect(triggers).toHaveLength(0);
		// The assignee WAS notified.
		expect(notify.calls.map((c) => c.userId)).toContain("agent-7");
	});

	test("customer reply on a ticket ASSIGNED to a human (status open) also does NOT trigger AI", async () => {
		const store = new FileSupportTicketStore();
		const triggers: Array<{ ticketId: string }> = [];
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgent: (input) => triggers.push({ ticketId: input.ticketId }),
		});
		const opened = await openCustomerTicket(app);
		const id = opened.ticket.id;
		await store.assign(id, "agent-7"); // human owner, still "open"

		await app.request(`/tickets/${id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "still missing credits" }),
		});
		await Bun.sleep(5);
		expect(triggers).toHaveLength(0);
	});

	test("customer reply on an UNOWNED, non-escalated ticket STILL triggers AI", async () => {
		const store = new CountingFileSupportTicketStore();
		const triggers: Array<{ ticketId: string }> = [];
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgent: (input) => triggers.push({ ticketId: input.ticketId }),
		});
		const opened = await openCustomerTicket(app);
		const id = opened.ticket.id;
		store.listMessagesCalls = 0;

		await app.request(`/tickets/${id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "still missing credits" }),
		});
		await Bun.sleep(5);
		expect(triggers).toHaveLength(1);
		expect(triggers[0]?.ticketId).toBe(id);
		expect(store.listMessagesCalls).toBe(0);
	});

	// Codex P1 on PR #189: the EXPLICIT re-trigger path (POST /tickets/:id/ai-respond)
	// must honour the SAME human-owned gate as the auto-trigger above. Otherwise a
	// customer could force the AI back onto an escalated/assigned ticket — provider
	// called, tokens spent — AFTER a human took over.

	test("ai-respond on an ESCALATED ticket does NOT call the AI agent and returns the human-handling response", async () => {
		const store = new FileSupportTicketStore();
		let agentCalls = 0;
		const notify = spyNotify();
		const app = makeRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice", "editor"),
			supportQueueUserId: "support-queue",
			triggerAgentNow: async () => {
				agentCalls += 1;
				return { kind: "replied", tokensSpent: 999, detail: "should not be called" };
			},
		});
		const opened = await openCustomerTicket(app);
		const id = opened.ticket.id;

		// A human escalated + took the ticket.
		await store.updateStatus(id, "escalated");
		await store.assign(id, "agent-7", "tier2");
		notify.calls.length = 0;

		const res = await app.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		await Bun.sleep(5);

		// 409 with the human-handling outcome; the AI provider was NEVER invoked.
		expect(res.status).toBe(409);
		const body = (await res.json()) as { outcome: string; code: string; detail: string };
		expect(body.outcome).toBe("handoff");
		expect(body.code).toBe("human_owned");
		expect(agentCalls).toBe(0);
		// The assignee was notified that the customer is waiting (mirrors auto-trigger).
		expect(notify.calls.map((c) => c.userId)).toContain("agent-7");
	});

	test("ai-respond on a ticket ASSIGNED to a human (status open) also does NOT call the AI agent", async () => {
		const store = new FileSupportTicketStore();
		let agentCalls = 0;
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgentNow: async () => {
				agentCalls += 1;
				return { kind: "replied", tokensSpent: 999, detail: "should not be called" };
			},
		});
		const opened = await openCustomerTicket(app);
		const id = opened.ticket.id;
		await store.assign(id, "agent-7"); // human owner, still "open"

		const res = await app.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("human_owned");
		expect(agentCalls).toBe(0);
	});

	test("ai-respond on a NON-human-owned ticket STILL triggers the AI (legit re-trigger)", async () => {
		const store = new CountingFileSupportTicketStore();
		const seen: Array<{ ticketId: string; ignoreSingleFlight?: boolean }> = [];
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgentNow: async (input) => {
				seen.push({ ticketId: input.ticketId, ignoreSingleFlight: input.ignoreSingleFlight });
				return { kind: "replied", tokensSpent: 42, detail: "Replied." };
			},
		});
		const opened = await openCustomerTicket(app);
		const id = opened.ticket.id;
		store.listMessagesCalls = 0;

		const res = await app.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { outcome: string };
		expect(body.outcome).toBe("replied");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.ticketId).toBe(id);
		// SECURITY FIX: the customer route never forces a fresh run (no ignoreSingleFlight);
		// the agent's atomic single-flight claim decides whether it actually re-runs.
		expect(seen[0]?.ignoreSingleFlight).toBeFalsy();
		expect(store.listMessagesCalls).toBe(1);
	});
});

// Codex P1 on PR #189: a STAFF reply must make the ticket human-owned so the AI
// never re-engages afterward — even when the staff member did NOT explicitly assign
// the ticket. Before the fix, /agent/reply set status="pending" but left the
// assignee empty, so a non-escalated ticket still passed the human-owned gate and a
// later customer /messages (auto-trigger) or /ai-respond (explicit re-trigger) spent
// AI tokens, talking over a human already handling the conversation.
//
// INVARIANT under test: once a HUMAN has replied, no customer action triggers the AI.
describe("#189 — a staff reply takes ownership; the AI never re-engages afterward", () => {
	async function openCustomerTicket(app: ReturnType<typeof createSupportTicketsRouter>): Promise<OpenResponse> {
		const res = await app.request("/tickets", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ subject: "topup", body: "I paid but no credits" }),
		});
		return (await res.json()) as OpenResponse;
	}

	test("staff reply on an UNASSIGNED, non-escalated ticket auto-assigns the replying staff (human-owned)", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const customerApp = makeRouter({ store, notify: notify.fn, authMiddleware: stubAuth("alice", "editor") });
		const staffApp = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		const opened = await openCustomerTicket(customerApp);
		const id = opened.ticket.id;
		// Sanity: the freshly opened ticket has NO human owner and is not escalated.
		const before = (await store.getTicket(id))!;
		expect(before.assigneeUserId ?? "").toBe("");
		expect(before.status).not.toBe("escalated");

		const reply = await staffApp.request(`/agent/tickets/${id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Looking into it now." }),
		});
		expect(reply.status).toBe(201);
		const replyBody = (await reply.json()) as { ticket: SupportTicketRecord; message: SupportTicketMessageRecord };
		expect(replyBody.message.authorKind).toBe("agent");
		// The replying staff member now OWNS the ticket; status moved open→pending.
		expect(replyBody.ticket.assigneeUserId).toBe("agent-1");
		expect(replyBody.ticket.status).toBe("pending");
		const persisted = (await store.getTicket(id))!;
		expect(persisted.assigneeUserId).toBe("agent-1");
	});

	test("after a staff reply, a customer /messages does NOT trigger the AI and notifies the now-owner", async () => {
		const store = new FileSupportTicketStore();
		const triggers: Array<{ ticketId: string }> = [];
		const notify = spyNotify();
		const customerApp = makeRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgent: (input) => triggers.push({ ticketId: input.ticketId }),
		});
		const staffApp = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		const opened = await openCustomerTicket(customerApp);
		const id = opened.ticket.id;

		// Human replies (no explicit assign) → claims the ticket.
		await staffApp.request(`/agent/tickets/${id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Can you share a screenshot?" }),
		});
		await Bun.sleep(5);
		notify.calls.length = 0;

		// Customer replies again → AI must NOT re-engage; the human owner is notified.
		const replyRes = await customerApp.request(`/tickets/${id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Here is the screenshot." }),
		});
		expect(replyRes.status).toBe(201);
		await Bun.sleep(5);
		expect(triggers).toHaveLength(0); // 0 provider calls
		expect(notify.calls.map((c) => c.userId)).toContain("agent-1"); // assignee notified
	});

	test("after a staff reply, a customer /ai-respond returns 409 handoff with 0 provider calls", async () => {
		const store = new FileSupportTicketStore();
		let agentCalls = 0;
		const notify = spyNotify();
		const customerApp = makeRouter({
			store,
			notify: notify.fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgentNow: async () => {
				agentCalls += 1;
				return { kind: "replied", tokensSpent: 999, detail: "should not be called" };
			},
		});
		const staffApp = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-1", "support") });

		const opened = await openCustomerTicket(customerApp);
		const id = opened.ticket.id;

		await staffApp.request(`/agent/tickets/${id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "On it." }),
		});
		await Bun.sleep(5);
		notify.calls.length = 0;

		const res = await customerApp.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		await Bun.sleep(5);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { outcome: string; code: string };
		expect(body.outcome).toBe("handoff");
		expect(body.code).toBe("human_owned");
		expect(agentCalls).toBe(0); // 0 provider calls
		expect(notify.calls.map((c) => c.userId)).toContain("agent-1"); // owner notified
	});

	test("a staff reply does NOT steal an already-assigned ticket (keeps existing assignee)", async () => {
		const store = new FileSupportTicketStore();
		const notify = spyNotify();
		const staffApp = makeRouter({ store, notify: notify.fn, agentAuthMiddleware: stubAuth("agent-2", "support") });
		const ticket = await seedTicket(store);
		// agent-7 already owns the ticket.
		await store.assign(ticket.id, "agent-7");

		const reply = await staffApp.request(`/agent/tickets/${ticket.id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Chiming in." }),
		});
		expect(reply.status).toBe(201);
		const body = (await reply.json()) as { ticket: SupportTicketRecord };
		// The original assignee is preserved — a colleague's reply doesn't reassign.
		expect(body.ticket.assigneeUserId).toBe("agent-7");
	});

	test("DEFENSIVE: an agent reply with NO assignee still blocks the AI (history fallback)", async () => {
		// Simulates a hypothetical path that persists an agent reply WITHOUT setting an
		// assignee. The robust gate must still treat the ticket as human-owned.
		const store = new FileSupportTicketStore();
		let agentCalls = 0;
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgentNow: async () => {
				agentCalls += 1;
				return { kind: "replied", tokensSpent: 999, detail: "should not be called" };
			},
		});
		const opened = await openCustomerTicket(app);
		const id = opened.ticket.id;
		// Persist a human/agent reply directly, bypassing the route's auto-assign, so
		// assigneeUserId stays empty and status stays non-escalated.
		await store.addMessage({ ticketId: id, authorKind: "agent", authorUserId: "agent-9", body: "manual reply" });
		const persisted = (await store.getTicket(id))!;
		expect(persisted.assigneeUserId ?? "").toBe("");
		expect(persisted.status).not.toBe("escalated");

		const res = await app.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { code: string }).code).toBe("human_owned");
		expect(agentCalls).toBe(0);
	});

	test("DEFENSIVE: a legacy row with hasAgentReply UNDEFINED falls back to the thread scan (fail-closed)", async () => {
		// Rows created before migration 0064 have no has_agent_reply value. The robust
		// gate must NOT treat `undefined` as "no agent reply" — only an EXPLICIT `false`
		// short-circuits. An un-backfilled legacy ticket with a real agent reply must
		// still be detected as human-owned via the listMessages scan, never let the AI
		// talk over the human.
		const store = new CountingFileSupportTicketStore();
		let agentCalls = 0;
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgentNow: async () => {
				agentCalls += 1;
				return { kind: "replied", tokensSpent: 999, detail: "should not be called" };
			},
		});
		const opened = await openCustomerTicket(app);
		const id = opened.ticket.id;
		await store.addMessage({ ticketId: id, authorKind: "agent", authorUserId: "agent-9", body: "manual reply" });
		// Simulate a legacy un-backfilled row: clear the cached flag back to undefined.
		const live = (store as unknown as { tickets: Array<{ id: string; hasAgentReply?: boolean }> }).tickets.find(
			(t) => t.id === id,
		);
		expect(live).toBeDefined();
		live!.hasAgentReply = undefined;
		store.listMessagesCalls = 0;

		const res = await app.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { code: string }).code).toBe("human_owned");
		expect(agentCalls).toBe(0);
		// Proof the fallback scan actually ran (undefined did NOT false-short-circuit).
		expect(store.listMessagesCalls).toBeGreaterThanOrEqual(1);
	});

	test("legit AI path is unaffected: NO human has ever replied → AI still triggers", async () => {
		const store = new FileSupportTicketStore();
		const seen: Array<{ ticketId: string }> = [];
		const app = makeRouter({
			store,
			notify: spyNotify().fn,
			authMiddleware: stubAuth("alice", "editor"),
			triggerAgentNow: async (input) => {
				seen.push({ ticketId: input.ticketId });
				return { kind: "replied", tokensSpent: 42, detail: "Replied." };
			},
		});
		const opened = await openCustomerTicket(app);
		const id = opened.ticket.id;

		const res = await app.request(`/tickets/${id}/ai-respond`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { outcome: string }).outcome).toBe("replied");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.ticketId).toBe(id);
	});
});
