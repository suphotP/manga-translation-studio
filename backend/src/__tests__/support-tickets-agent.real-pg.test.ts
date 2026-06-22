import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Context, Next } from "hono";
import {
	createSupportTicketsRouter,
	type NotifyFn,
} from "../routes/support-tickets.js";
import {
	PostgresSupportTicketStore,
	type SupportTicketRecord,
	type SupportTicketMessageRecord,
} from "../services/support-tickets.js";
import type { NotifyInput, NotifyResult } from "../services/notification-dispatch.js";
import type { UserRole } from "../types/auth.js";

// ── Real Postgres: staff /agent endpoints + internal-note isolation + #180 ──────
// Proves the agent surface against ACTUAL SQL (migration 0053 + 0059), not the
// in-memory fake. Especially: the `internal` author_kind passes the real CHECK
// constraint (0059), the customer GET thread filters it out, and a customer reply
// on an escalated ticket does NOT trigger the AI.
//
// Migrations must already be applied to TEST_DATABASE_URL. Example:
//   docker run -d --name pg -e POSTGRES_PASSWORD=test -p 55488:5432 postgres:16
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55488/postgres bun run src/migrations/cli.ts up
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55488/postgres bun test support-tickets-agent.real-pg

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim();
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

function stubAuth(userId: string, role: UserRole) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${userId}@example.com`, role });
		await next();
	};
}

function spyNotify(): { fn: NotifyFn; calls: NotifyInput[] } {
	const calls: NotifyInput[] = [];
	const fn: NotifyFn = async (input: NotifyInput): Promise<NotifyResult> => {
		calls.push(input);
		return { inAppDelivered: true, emailAttempted: false, skipped: [] };
	};
	return { fn, calls };
}

interface ThreadResponse {
	ticket: SupportTicketRecord;
	messages: SupportTicketMessageRecord[];
}

describeReal("support agent endpoints on real Postgres", () => {
	const sql = new Bun.SQL(TEST_DATABASE_URL as string);
	const store = new PostgresSupportTicketStore(sql as never);

	beforeEach(async () => {
		await sql.unsafe("DELETE FROM support_ticket_messages");
		await sql.unsafe("DELETE FROM support_tickets");
	});
	afterAll(async () => {
		await sql.unsafe("DELETE FROM support_ticket_messages");
		await sql.unsafe("DELETE FROM support_tickets");
		await sql.close?.();
	});

	function staffApp(triggerSpy?: (id: string) => void) {
		return createSupportTicketsRouter({
			store,
			notify: spyNotify().fn,
			createLimiter: null,
			replyLimiter: null,
			aiRespondLimiter: null,
			triggerAgent: triggerSpy ? (input) => triggerSpy(input.ticketId) : null,
			agentAuthMiddleware: stubAuth("agent-1", "support"),
		});
	}
	function customerApp(triggers: string[]) {
		return createSupportTicketsRouter({
			store,
			notify: spyNotify().fn,
			createLimiter: null,
			replyLimiter: null,
			aiRespondLimiter: null,
			triggerAgent: (input) => triggers.push(input.ticketId),
			authMiddleware: stubAuth("alice", "editor"),
		});
	}

	test("internal note persists through the real CHECK and stays staff-only", async () => {
		const ticket = await store.createTicket({ requesterUserId: "alice", subject: "S", body: "opening" });
		const staff = staffApp();

		const noteRes = await staff.request(`/agent/tickets/${ticket.id}/internal-note`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "SECRET internal note" }),
		});
		expect(noteRes.status).toBe(201);
		expect(((await noteRes.json()) as { message: SupportTicketMessageRecord }).message.authorKind).toBe("internal");

		// Staff thread includes it.
		const staffThread = (await (await staff.request(`/agent/tickets/${ticket.id}`)).json()) as ThreadResponse;
		expect(staffThread.messages.some((m) => m.authorKind === "internal")).toBe(true);

		// Customer thread excludes it.
		const cust = customerApp([]);
		const custThread = (await (await cust.request(`/tickets/${ticket.id}`)).json()) as ThreadResponse;
		expect(custThread.messages.some((m) => m.body.includes("SECRET"))).toBe(false);
		expect(custThread.messages.every((m) => m.authorKind !== "internal")).toBe(true);
	});

	test("inbox lists all + filters by status (real SQL keyset)", async () => {
		const a = await store.createTicket({ requesterUserId: "alice", subject: "A", body: "x" });
		const b = await store.createTicket({ requesterUserId: "bob", subject: "B", body: "y" });
		await store.updateStatus(b.id, "escalated");
		const staff = staffApp();

		const all = (await (await staff.request("/agent/tickets")).json()) as { items: SupportTicketRecord[] };
		expect(all.items.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());

		const escalated = (await (await staff.request("/agent/tickets?status=escalated")).json()) as { items: SupportTicketRecord[] };
		expect(escalated.items.map((t) => t.id)).toEqual([b.id]);
	});

	test("#180: customer reply on an ESCALATED ticket does not trigger AI (real PG)", async () => {
		const ticket = await store.createTicket({ requesterUserId: "alice", subject: "S", body: "opening" });
		await store.updateStatus(ticket.id, "escalated");
		await store.assign(ticket.id, "agent-7", "tier2");

		const triggers: string[] = [];
		const cust = customerApp(triggers);
		const res = await cust.request(`/tickets/${ticket.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "any update?" }),
		});
		expect(res.status).toBe(201);
		await Bun.sleep(5);
		expect(triggers).toHaveLength(0);
	});

	test("#180: customer reply on an UNOWNED open ticket DOES trigger AI (real PG)", async () => {
		const ticket = await store.createTicket({ requesterUserId: "alice", subject: "S", body: "opening" });
		const triggers: string[] = [];
		const cust = customerApp(triggers);
		await cust.request(`/tickets/${ticket.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "still broken" }),
		});
		await Bun.sleep(5);
		expect(triggers).toEqual([ticket.id]);
	});

	test("staff reply + escalate + resolve flow against real PG", async () => {
		const ticket = await store.createTicket({ requesterUserId: "alice", subject: "S", body: "opening" });
		const staff = staffApp();

		const reply = await staff.request(`/agent/tickets/${ticket.id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "We are on it." }),
		});
		expect(reply.status).toBe(201);
		expect(((await reply.json()) as { ticket: SupportTicketRecord }).ticket.status).toBe("pending");

		const esc = await staff.request(`/agent/tickets/${ticket.id}/escalate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ department: "tier2", reason: "needs specialist" }),
		});
		expect(((await esc.json()) as { ticket: SupportTicketRecord }).ticket.status).toBe("escalated");

		const resolved = await staff.request(`/agent/tickets/${ticket.id}/resolve`, { method: "POST" });
		expect(((await resolved.json()) as { ticket: SupportTicketRecord }).ticket.status).toBe("resolved");

		// Escalation reason was stored as an internal note (staff sees it, customer doesn't).
		const staffThread = (await (await staff.request(`/agent/tickets/${ticket.id}`)).json()) as ThreadResponse;
		expect(staffThread.messages.some((m) => m.authorKind === "internal" && m.body.includes("needs specialist"))).toBe(true);
		const cust = customerApp([]);
		const custThread = (await (await cust.request(`/tickets/${ticket.id}`)).json()) as ThreadResponse;
		expect(custThread.messages.some((m) => m.body.includes("needs specialist"))).toBe(false);
		// But the customer DOES see the agent reply.
		expect(custThread.messages.some((m) => m.authorKind === "agent")).toBe(true);
	});

	// Codex P1 #189 (anti-cost): a staff reply on an UNASSIGNED, non-escalated ticket
	// must TAKE OWNERSHIP (auto-assign the replying staff) so a later customer action
	// cannot re-engage the AI. Verified against real Postgres.
	test("#189: staff reply takes ownership; customer /messages + /ai-respond never re-trigger AI (real PG)", async () => {
		const ticket = await store.createTicket({ requesterUserId: "alice", subject: "S", body: "opening" });
		const staff = staffApp();

		// Staff replies WITHOUT explicitly assigning.
		const reply = await staff.request(`/agent/tickets/${ticket.id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "Taking a look." }),
		});
		expect(reply.status).toBe(201);
		// The reply CLAIMED the ticket: assignee is the replying staff, status pending.
		const claimed = (await store.getTicket(ticket.id))!;
		expect(claimed.assigneeUserId).toBe("agent-1");
		expect(claimed.status).toBe("pending");

		// A subsequent customer reply must NOT auto-trigger the AI.
		const triggers: string[] = [];
		const cust = customerApp(triggers);
		const msgRes = await cust.request(`/tickets/${ticket.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "ok, waiting" }),
		});
		expect(msgRes.status).toBe(201);
		await Bun.sleep(5);
		expect(triggers).toHaveLength(0);

		// And an explicit /ai-respond must be a 409 handoff (no provider call).
		const custWithNow = createSupportTicketsRouter({
			store,
			notify: spyNotify().fn,
			createLimiter: null,
			replyLimiter: null,
			aiRespondLimiter: null,
			triggerAgent: null,
			triggerAgentNow: async () => {
				throw new Error("AI provider must not be called on a human-owned ticket");
			},
			authMiddleware: stubAuth("alice", "editor"),
		});
		const aiRes = await custWithNow.request(`/tickets/${ticket.id}/ai-respond`, { method: "POST" });
		expect(aiRes.status).toBe(409);
		expect(((await aiRes.json()) as { code: string }).code).toBe("human_owned");
	});
});
