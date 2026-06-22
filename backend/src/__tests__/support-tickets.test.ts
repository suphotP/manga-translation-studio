import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	FileSupportTicketStore,
	PostgresSupportTicketStore,
	SupportTicketStoreError,
	type SupportTicketRecord,
	type SupportTicketSqlClient,
	type SupportTicketStore,
} from "../services/support-tickets.js";

const tempDirs: string[] = [];

function createFileStore(): { store: FileSupportTicketStore; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "manga-support-tickets-store-"));
	tempDirs.push(directory);
	const path = join(directory, "support-tickets.json");
	return { store: new FileSupportTicketStore(path), path };
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * In-memory fake Bun.SQL client for the Postgres support-ticket store. Mirrors
 * the fake-client seam the asset-store / notifications tests use: it records
 * every query and executes a minimal subset of the SQL the store issues against
 * two in-memory tables, so the Postgres code path (column mapping, keyset
 * cursor, scalar-bind ARRAY predicate) is genuinely exercised and can be
 * asserted for parity with the file store.
 */
class FakeSupportSqlClient {
	readonly queries: Array<{ query: string; params: unknown[] }> = [];
	readonly tickets: Array<Record<string, unknown>> = [];
	readonly messages: Array<Record<string, unknown>> = [];
	private clock = Date.UTC(2026, 5, 1, 0, 0, 0);

	private nextTime(): string {
		this.clock += 1000;
		return new Date(this.clock).toISOString();
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		const normalized = query.replace(/\s+/g, " ").trim();

		if (normalized.startsWith("INSERT INTO support_tickets")) {
			const now = this.nextTime();
			const row: Record<string, unknown> = {
				id: params[0],
				requester_user_id: params[1],
				workspace_id: params[2] ?? null,
				subject: params[3],
				status: "open",
				priority: params[4],
				category: params[5],
				assignee_user_id: params[6] ?? null,
				queue: params[7] ?? null,
				ai_message_count: 0,
				ai_tokens_spent: 0,
				last_processed_message_id: null,
				has_agent_reply: false,
				created_at: now,
				updated_at: now,
			};
			this.tickets.push(row);
			return [row] as T[];
		}

		if (normalized.startsWith("INSERT INTO support_ticket_messages")) {
			// Standalone opening-message insert from createTicket.
			const ticketId = params[1];
			const row: Record<string, unknown> = {
				id: params[0],
				ticket_id: ticketId,
				author_kind: "customer",
				author_user_id: params[2] ?? null,
				body: params[3],
				tokens: null,
				created_at: this.nextTime(),
			};
			this.messages.push(row);
			return [] as T[];
		}

		if (normalized.startsWith("WITH inserted AS")) {
			// addMessage: insert only when the ticket exists; bump updated_at.
			const [id, ticketId, authorKind, authorUserId, body, tokens] = params;
			const ticket = this.tickets.find((t) => t.id === ticketId);
			if (!ticket) return [] as T[];
			const row: Record<string, unknown> = {
				id,
				ticket_id: ticketId,
				author_kind: authorKind,
				author_user_id: authorUserId ?? null,
				body,
				tokens: tokens ?? null,
				created_at: this.nextTime(),
			};
			this.messages.push(row);
			ticket.updated_at = this.nextTime();
			if (authorKind === "agent") ticket.has_agent_reply = true;
			return [row] as T[];
		}

		if (normalized.startsWith("SELECT") && normalized.includes("FROM support_tickets") && normalized.includes("WHERE id = $1") && !normalized.includes("ORDER BY")) {
			const ticket = this.tickets.find((t) => t.id === params[0]);
			return (ticket ? [ticket] : []) as T[];
		}

		if (normalized.startsWith("SELECT") && normalized.includes("FROM support_tickets") && normalized.includes("ORDER BY updated_at DESC")) {
			return this.listTickets<T>(normalized, params);
		}

		if (normalized.startsWith("SELECT") && normalized.includes("FROM support_ticket_messages") && normalized.includes("ORDER BY created_at ASC")) {
			return this.listMessages<T>(params);
		}

		if (normalized.startsWith("UPDATE support_tickets")) {
			return this.updateTicket<T>(normalized, params);
		}

		return [] as T[];
	}

	private listTickets<T>(normalized: string, params: unknown[]): T[] {
		// The trailing param is always the limit (limit + 1). Filters precede it
		// positionally; we replay them by reading the conditions from the SQL.
		const limitPlusOne = Number(params[params.length - 1]);
		let rows = [...this.tickets];

		// Equality filters embedded as $n placeholders, in build order.
		let paramIdx = 0;
		if (normalized.includes("requester_user_id = $")) {
			const value = params[paramIdx++];
			rows = rows.filter((r) => r.requester_user_id === value);
		}
		if (normalized.includes("assignee_user_id = $") && normalized.includes("WHERE")) {
			const value = params[paramIdx++];
			rows = rows.filter((r) => r.assignee_user_id === value);
		}
		if (normalized.includes("queue = $")) {
			const value = params[paramIdx++];
			rows = rows.filter((r) => r.queue === value);
		}
		if (normalized.includes("status = ANY(ARRAY[")) {
			// Count the scalar binds in the ARRAY[...] literal.
			const match = normalized.match(/status = ANY\(ARRAY\[([^\]]*)\]/);
			const count = match && match[1]?.trim() ? match[1].split(",").length : 0;
			const statuses = params.slice(paramIdx, paramIdx + count);
			paramIdx += count;
			rows = rows.filter((r) => statuses.includes(r.status));
		}
		let cursor: Record<string, unknown> | undefined;
		let cursorOutOfScope = false;
		if (normalized.includes("(updated_at, id) <")) {
			const cursorId = params[paramIdx++];
			// Mirror the scoped cursor subselect: the cursor must satisfy the SAME scope
			// predicates as the outer query (IDOR fix). `rows` is already scope-filtered,
			// so resolve the cursor WITHIN it — a foreign/out-of-scope id yields no row
			// (the keyset then compares against NULL → empty page).
			cursor = rows.find((t) => t.id === cursorId);
			cursorOutOfScope = cursor === undefined;
		}
		if (cursorOutOfScope) return [] as T[];

		rows.sort((a, b) => {
			const cmp = String(b.updated_at).localeCompare(String(a.updated_at));
			return cmp !== 0 ? cmp : String(b.id).localeCompare(String(a.id));
		});
		if (cursor) {
			rows = rows.filter((r) => {
				const cmp = String(r.updated_at).localeCompare(String(cursor!.updated_at));
				if (cmp !== 0) return cmp < 0;
				return String(r.id).localeCompare(String(cursor!.id)) < 0;
			});
		}
		return rows.slice(0, limitPlusOne) as T[];
	}

	private listMessages<T>(params: unknown[]): T[] {
		const ticketId = params[0];
		const limitPlusOne = Number(params[params.length - 1]);
		let rows = this.messages.filter((m) => m.ticket_id === ticketId);
		let cursor: Record<string, unknown> | undefined;
		if (params.length === 3) {
			cursor = this.messages.find((m) => m.id === params[1]);
		}
		rows.sort((a, b) => {
			const cmp = String(a.created_at).localeCompare(String(b.created_at));
			return cmp !== 0 ? cmp : String(a.id).localeCompare(String(b.id));
		});
		if (cursor) {
			rows = rows.filter((r) => {
				const cmp = String(r.created_at).localeCompare(String(cursor!.created_at));
				if (cmp !== 0) return cmp > 0;
				return String(r.id).localeCompare(String(cursor!.id)) > 0;
			});
		}
		return rows.slice(0, limitPlusOne) as T[];
	}

	private updateTicket<T>(normalized: string, params: unknown[]): T[] {
		const ticket = this.tickets.find((t) => t.id === params[0]);
		if (!ticket) return [] as T[];
		// ATOMIC single-flight claim: model the `IS DISTINCT FROM $2` guard — when the
		// trigger is already this message id, the UPDATE matches NO row (returns []),
		// which is exactly how the loser of the race is detected in the store.
		if (normalized.includes("last_processed_message_id IS DISTINCT FROM $2")) {
			if (ticket.last_processed_message_id === params[1]) return [] as T[];
			ticket.last_processed_message_id = params[1];
			ticket.updated_at = this.nextTime();
			return [ticket] as T[];
		}
		if (normalized.includes("SET status = $2")) {
			ticket.status = params[1];
		} else if (normalized.includes("ai_message_count = ai_message_count + $2")) {
			ticket.ai_message_count = Number(ticket.ai_message_count) + Number(params[1]);
			ticket.ai_tokens_spent = Number(ticket.ai_tokens_spent) + Number(params[2]);
		} else if (normalized.includes("last_processed_message_id = $2")) {
			ticket.last_processed_message_id = params[1];
		} else if (normalized.includes("SET assignee_user_id = $2, queue = $3")) {
			ticket.assignee_user_id = params[1] ?? null;
			ticket.queue = params[2] ?? null;
		} else if (normalized.includes("SET assignee_user_id = $2")) {
			ticket.assignee_user_id = params[1] ?? null;
		}
		ticket.updated_at = this.nextTime();
		return [ticket] as T[];
	}
}

function createPgStore(): { store: PostgresSupportTicketStore; client: FakeSupportSqlClient } {
	const client = new FakeSupportSqlClient();
	return { store: new PostgresSupportTicketStore(client), client };
}

// A small matrix so every behavioural assertion runs against BOTH backends and
// proves File/Postgres parity (the task's core acceptance criterion).
const backends: Array<{ name: string; make: () => SupportTicketStore }> = [
	{ name: "FileSupportTicketStore", make: () => createFileStore().store },
	{ name: "PostgresSupportTicketStore", make: () => createPgStore().store },
];

for (const backend of backends) {
	describe(`${backend.name} (parity)`, () => {
		test("createTicket applies defaults and getTicket reads it back", async () => {
			const store = backend.make();
			const created = await store.createTicket({
				requesterUserId: "user-1",
				workspaceId: "ws-1",
				subject: "Where are my credits?",
				category: "billing",
			});
			expect(created).toMatchObject({
				requesterUserId: "user-1",
				workspaceId: "ws-1",
				subject: "Where are my credits?",
				status: "open",
				priority: "normal",
				category: "billing",
				aiMessageCount: 0,
				aiTokensSpent: 0,
			});
			expect(created.id).toEqual(expect.any(String));
			expect(created.lastProcessedMessageId).toBeUndefined();

			const fetched = await store.getTicket(created.id);
			expect(fetched?.id).toBe(created.id);
			expect(fetched?.subject).toBe("Where are my credits?");
		});

		test("createTicket with an opening body files a customer message", async () => {
			const store = backend.make();
			const ticket = await store.createTicket({
				requesterUserId: "user-1",
				subject: "Help",
				body: "I was double charged.",
			});
			const page = await store.listMessages(ticket.id);
			expect(page.items).toHaveLength(1);
			expect(page.items[0]).toMatchObject({
				authorKind: "customer",
				authorUserId: "user-1",
				body: "I was double charged.",
			});
		});

		test("listTickets scopes by requester and orders newest activity first", async () => {
			const store = backend.make();
			const a = await store.createTicket({ requesterUserId: "user-1", subject: "A" });
			await Bun.sleep(2);
			const b = await store.createTicket({ requesterUserId: "user-1", subject: "B" });
			await Bun.sleep(2);
			await store.createTicket({ requesterUserId: "user-2", subject: "Other" });

			const page = await store.listTickets({ requesterUserId: "user-1" });
			expect(page.items.map((t) => t.subject)).toEqual(["B", "A"]);
			expect(page.hasMore).toBe(false);
			void a;
			void b;
		});

		test("listTickets keyset paginates via beforeId", async () => {
			const store = backend.make();
			const created: SupportTicketRecord[] = [];
			for (let i = 0; i < 5; i += 1) {
				created.push(await store.createTicket({ requesterUserId: "user-1", subject: `t-${i}` }));
				await Bun.sleep(2);
			}
			const first = await store.listTickets({ requesterUserId: "user-1", limit: 2 });
			expect(first.items.map((t) => t.subject)).toEqual(["t-4", "t-3"]);
			expect(first.hasMore).toBe(true);

			const second = await store.listTickets({ requesterUserId: "user-1", limit: 2, beforeId: first.items[1]!.id });
			expect(second.items.map((t) => t.subject)).toEqual(["t-2", "t-1"]);
			expect(second.hasMore).toBe(true);

			const third = await store.listTickets({ requesterUserId: "user-1", limit: 2, beforeId: second.items[1]!.id });
			expect(third.items.map((t) => t.subject)).toEqual(["t-0"]);
			expect(third.hasMore).toBe(false);
		});

		test("IDOR: a cursor for a FOREIGN ticket id is rejected on a requester-scoped list", async () => {
			const store = backend.make();
			// user-1 owns some tickets; user-2 owns one we'll use as a guessed foreign cursor.
			for (let i = 0; i < 3; i += 1) {
				await store.createTicket({ requesterUserId: "user-1", subject: `mine-${i}` });
				await Bun.sleep(2);
			}
			const foreign = await store.createTicket({ requesterUserId: "user-2", subject: "not yours" });

			// user-1 passes user-2's ticket id as `before` → the cursor is OUTSIDE their
			// scope, so the page is empty (the foreign id can neither shift the window nor
			// leak existence). Previously the subquery resolved ANY id, altering pagination.
			const probed = await store.listTickets({ requesterUserId: "user-1", beforeId: foreign.id });
			expect(probed.items).toEqual([]);
			expect(probed.hasMore).toBe(false);

			// Sanity: an IN-scope cursor still paginates normally.
			const firstPage = await store.listTickets({ requesterUserId: "user-1", limit: 1 });
			const nextPage = await store.listTickets({ requesterUserId: "user-1", limit: 10, beforeId: firstPage.items[0]!.id });
			expect(nextPage.items.length).toBe(2);
		});

		test("claimTrigger atomically claims a trigger ONCE; a repeat is not claimed", async () => {
			const store = backend.make();
			const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "claim me" });

			const first = await store.claimTrigger(ticket.id, "msg-1");
			expect(first.claimed).toBe(true);
			expect(first.ticket?.lastProcessedMessageId).toBe("msg-1");

			// Same trigger again → already claimed (this is the loser of a race / a retry).
			const second = await store.claimTrigger(ticket.id, "msg-1");
			expect(second.claimed).toBe(false);
			expect(second.ticket?.id).toBe(ticket.id); // ticket still resolvable

			// A NEW trigger id can be claimed.
			const third = await store.claimTrigger(ticket.id, "msg-2");
			expect(third.claimed).toBe(true);

			// A non-existent ticket → not claimed, null ticket.
			const missing = await store.claimTrigger("does-not-exist", "msg-x");
			expect(missing.claimed).toBe(false);
			expect(missing.ticket).toBeNull();
		});

		test("listTickets filters by a status array (scalar-bind ARRAY predicate)", async () => {
			const store = backend.make();
			const open = await store.createTicket({ requesterUserId: "user-1", subject: "open one" });
			const pending = await store.createTicket({ requesterUserId: "user-1", subject: "pending one" });
			const resolved = await store.createTicket({ requesterUserId: "user-1", subject: "resolved one" });
			await store.updateStatus(pending.id, "pending");
			await store.updateStatus(resolved.id, "resolved");

			const active = await store.listTickets({ status: ["open", "pending"] });
			expect(active.items.map((t) => t.subject).sort()).toEqual(["open one", "pending one"]);
			void open;
		});

		test("listMessages returns oldest-first and paginates via afterId", async () => {
			const store = backend.make();
			const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "thread" });
			for (let i = 0; i < 4; i += 1) {
				await store.addMessage({ ticketId: ticket.id, authorKind: "customer", body: `m-${i}`, authorUserId: "user-1" });
				await Bun.sleep(2);
			}
			const first = await store.listMessages(ticket.id, { limit: 2 });
			expect(first.items.map((m) => m.body)).toEqual(["m-0", "m-1"]);
			expect(first.hasMore).toBe(true);

			const second = await store.listMessages(ticket.id, { limit: 2, afterId: first.items[1]!.id });
			expect(second.items.map((m) => m.body)).toEqual(["m-2", "m-3"]);
			expect(second.hasMore).toBe(false);
		});

		test("addMessage on a missing ticket fails", async () => {
			const store = backend.make();
			await expect(
				store.addMessage({ ticketId: "00000000-0000-0000-0000-000000000000", authorKind: "ai", body: "hi" }),
			).rejects.toBeInstanceOf(SupportTicketStoreError);
		});

		test("updateStatus changes status and returns the row", async () => {
			const store = backend.make();
			const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "S" });
			const updated = await store.updateStatus(ticket.id, "escalated");
			expect(updated?.status).toBe("escalated");
			expect((await store.getTicket(ticket.id))?.status).toBe("escalated");
		});

		test("updateStatus on a missing ticket returns null", async () => {
			const store = backend.make();
			expect(await store.updateStatus("00000000-0000-0000-0000-000000000000", "closed")).toBeNull();
		});

		test("assign sets the assignee and (optionally) the queue", async () => {
			const store = backend.make();
			const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "A" });
			const assigned = await store.assign(ticket.id, "agent-7", "billing");
			expect(assigned?.assigneeUserId).toBe("agent-7");
			expect(assigned?.queue).toBe("billing");

			// queue omitted => left unchanged.
			const reassigned = await store.assign(ticket.id, "agent-8");
			expect(reassigned?.assigneeUserId).toBe("agent-8");
			expect(reassigned?.queue).toBe("billing");

			// Clearing the assignee.
			const cleared = await store.assign(ticket.id, null);
			expect(cleared?.assigneeUserId).toBeUndefined();
		});

		test("listTickets filters by assignee", async () => {
			const store = backend.make();
			const a = await store.createTicket({ requesterUserId: "user-1", subject: "A" });
			await store.createTicket({ requesterUserId: "user-1", subject: "B" });
			await store.assign(a.id, "agent-7");
			const mine = await store.listTickets({ assigneeUserId: "agent-7" });
			expect(mine.items.map((t) => t.subject)).toEqual(["A"]);
		});

		test("incrementAiUsage accumulates the per-ticket cost counters", async () => {
			const store = backend.make();
			const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "A" });
			await store.incrementAiUsage(ticket.id, 1, 1200);
			const after = await store.incrementAiUsage(ticket.id, 2, 800);
			expect(after?.aiMessageCount).toBe(3);
			expect(after?.aiTokensSpent).toBe(2000);
		});

		test("setLastProcessedMessageId records the single-flight marker", async () => {
			const store = backend.make();
			const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "A" });
			const updated = await store.setLastProcessedMessageId(ticket.id, "msg-42");
			expect(updated?.lastProcessedMessageId).toBe("msg-42");
			expect((await store.getTicket(ticket.id))?.lastProcessedMessageId).toBe("msg-42");
		});

		test("rejects invalid create input", async () => {
			const store = backend.make();
			await expect(store.createTicket({ requesterUserId: " ", subject: "X" })).rejects.toBeInstanceOf(SupportTicketStoreError);
			await expect(store.createTicket({ requesterUserId: "user-1", subject: "  " })).rejects.toBeInstanceOf(SupportTicketStoreError);
			await expect(
				store.createTicket({ requesterUserId: "user-1", subject: "X", priority: "bogus" as never }),
			).rejects.toBeInstanceOf(SupportTicketStoreError);
		});
	});
}

describe("FileSupportTicketStore persistence", () => {
	test("snapshots tickets + messages and reloads from a fresh instance", async () => {
		const { store, path } = createFileStore();
		const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "Persisted", body: "first" });
		// Sleep so the reply's createdAt is a distinct millisecond from the opening
		// message: thread order tie-breaks on the random message id, so two
		// same-millisecond inserts are otherwise non-deterministically ordered.
		await Bun.sleep(2);
		await store.addMessage({ ticketId: ticket.id, authorKind: "ai", body: "reply", tokens: 50 });

		const reloaded = new FileSupportTicketStore(path);
		const fetched = await reloaded.getTicket(ticket.id);
		expect(fetched?.subject).toBe("Persisted");
		const messages = await reloaded.listMessages(ticket.id);
		expect(messages.items.map((m) => m.body)).toEqual(["first", "reply"]);
	});

	test("erasePiiForUser anonymizes the subject's authored message bodies AND opened-ticket subjects, idempotent + persisted", async () => {
		const { store, path } = createFileStore();
		// Subject + opening message are both the subject's free-text PII; an agent reply
		// (someone else's data) must be preserved.
		const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "Refund for card 4242", body: "card 4242 PII" });
		await Bun.sleep(2);
		await store.addMessage({ ticketId: ticket.id, authorKind: "agent", authorUserId: "agent-9", body: "agent reply (keep)" });
		await Bun.sleep(2);
		await store.addMessage({ ticketId: ticket.id, authorKind: "customer", authorUserId: "user-1", body: "more PII" });

		// 2 message bodies (opening + follow-up) + 1 ticket subject = 3.
		const scrubbed = await store.erasePiiForUser("user-1");
		expect(scrubbed).toBe(3);
		const messages = await store.listMessages(ticket.id);
		const byAuthor = Object.fromEntries(messages.items.map((m) => [m.authorUserId ?? "?", m.body]));
		expect(byAuthor["user-1"]).toBe("[deleted user message]");
		expect(byAuthor["agent-9"]).toBe("agent reply (keep)");
		// The free-text subject is anonymized.
		expect((await store.getTicket(ticket.id))?.subject).toBe("[deleted user ticket]");

		// Idempotent.
		expect(await store.erasePiiForUser("user-1")).toBe(0);

		// Persisted (bodies + subject).
		const reloaded = new FileSupportTicketStore(path);
		const reloadedMessages = await reloaded.listMessages(ticket.id);
		expect(reloadedMessages.items.filter((m) => m.authorUserId === "user-1").every((m) => m.body === "[deleted user message]")).toBe(true);
		expect((await reloaded.getTicket(ticket.id))?.subject).toBe("[deleted user ticket]");
	});

	test("claimTrigger is a cross-instance CAS: TWO stores over one file double-claim a trigger ONCE", async () => {
		const { store: storeA, path } = createFileStore();
		const ticket = await storeA.createTicket({ requesterUserId: "user-1", subject: "double-spend?" });

		// A SECOND store instance over the SAME json file (models a second backend
		// process / replica sharing api-prod-data:/app/data). It loaded its own
		// in-memory snapshot at construction with lastProcessedMessageId still unset.
		const storeB = new FileSupportTicketStore(path);

		// Race both instances claiming the SAME trigger message concurrently. Without the
		// reload-under-lock CAS, BOTH would read the stale (unclaimed) value and BOTH
		// return claimed:true → the agent runs the model twice (double-spend). With the
		// fix exactly one wins; the loser reloads the winner's write and returns false.
		const [a, b] = await Promise.all([
			storeA.claimTrigger(ticket.id, "msg-1"),
			storeB.claimTrigger(ticket.id, "msg-1"),
		]);
		const winners = [a, b].filter((r) => r.claimed);
		expect(winners.length).toBe(1);
		const losers = [a, b].filter((r) => !r.claimed);
		expect(losers.length).toBe(1);
		// The loser still resolves the ticket (so the agent can tell "already claimed"
		// apart from "ticket not found") and sees the WINNER's stamped trigger.
		expect(losers[0]!.ticket?.id).toBe(ticket.id);
		expect(losers[0]!.ticket?.lastProcessedMessageId).toBe("msg-1");

		// The on-disk snapshot is a COMPLETE, parseable JSON file (atomic temp+rename —
		// never a truncated snapshot) and the trigger is committed exactly once.
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
			tickets: Array<{ id: string; lastProcessedMessageId?: string }>;
		};
		const persisted = onDisk.tickets.find((t) => t.id === ticket.id);
		expect(persisted?.lastProcessedMessageId).toBe("msg-1");

		// A THIRD store opened fresh after the race agrees the trigger is already claimed.
		const storeC = new FileSupportTicketStore(path);
		const replay = await storeC.claimTrigger(ticket.id, "msg-1");
		expect(replay.claimed).toBe(false);
	});

	test("claimTrigger FENCES a stalled holder: a stale-reclaimed lock cannot commit a second winner", async () => {
		// Scenario the fence defends against: holder A acquires the O_EXCL lock (token
		// tA) and then STALLS past SUPPORT_CLAIM_LOCK_STALE_MS (GC/CPU stall / SIGSTOP).
		// Peer B stale-reclaims the abandoned lock, re-acquires it (token tB) and claims
		// the trigger — B is the legitimate winner. When A resumes it must NOT persist
		// over B nor return claimed:true. The pre-commit fencing re-read sees tB ≠ tA and
		// aborts A → still EXACTLY ONE winner.
		const { store, path } = createFileStore();
		const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "stalled holder" });
		const lockPath = `${path}.lock`;

		// Drive a peer (storeB) to win the claim FIRST: it acquires the lock, stamps its
		// own token, and commits "msg-1". This is the legitimate winner on disk.
		const storeB = new FileSupportTicketStore(path);
		const winner = await storeB.claimTrigger(ticket.id, "msg-1");
		expect(winner.claimed).toBe(true);

		// Now model holder A resuming AFTER its lock was stale-reclaimed. We splice the
		// fence point: A re-acquires the (now free) lock and reloads, but BETWEEN reload
		// and its commit a foreign token lands in the lock file — exactly what a peer's
		// stale-reclaim+re-acquire writes while A is stalled. The fencing re-read must
		// then see the foreign token and abort A's commit.
		const internal = store as unknown as {
			reloadFromDisk: () => void;
			lockToken: string | null;
		};
		const originalReload = internal.reloadFromDisk.bind(internal);
		let spliced = false;
		internal.reloadFromDisk = () => {
			originalReload();
			if (!spliced && internal.lockToken) {
				spliced = true;
				// A peer reclaimed A's lock and stamped its OWN token. A no longer owns it.
				writeFileSync(lockPath, `99999:${"f".repeat(8)}-foreign-token`);
			}
		};

		const resumed = await store.claimTrigger(ticket.id, "msg-2");
		// A lost the lock mid-CAS → it must report NOT claimed and persist nothing new.
		expect(resumed.claimed).toBe(false);
		internal.reloadFromDisk = originalReload;

		// The on-disk snapshot must still reflect ONLY the legitimate winner's commit;
		// A's "msg-2" must NEVER have been written.
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
			tickets: Array<{ id: string; lastProcessedMessageId?: string }>;
		};
		const persisted = onDisk.tickets.find((t) => t.id === ticket.id);
		expect(persisted?.lastProcessedMessageId).toBe("msg-1");

		// A must NOT delete the peer's lock when it aborts (fenced release leaves the
		// foreign-token lock for its true owner). Here the simulated peer "releases" it.
		expect(existsSync(lockPath)).toBe(true);
		rmSync(lockPath, { force: true });

		// And the trigger remains claimable exactly once overall: a fresh store agrees
		// msg-1 is taken, and a brand-new trigger (msg-2) is still open for the winner.
		const fresh = new FileSupportTicketStore(path);
		expect((await fresh.claimTrigger(ticket.id, "msg-1")).claimed).toBe(false);
		expect((await fresh.claimTrigger(ticket.id, "msg-2")).claimed).toBe(true);
	});

	test("claimTrigger releases its lock file after each claim (no wedged lock)", async () => {
		const { store, path } = createFileStore();
		const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "lock cleanup" });
		await store.claimTrigger(ticket.id, "msg-1");
		// The O_EXCL lock must be removed on release so a later claim is not blocked.
		expect(existsSync(`${path}.lock`)).toBe(false);
		const next = await store.claimTrigger(ticket.id, "msg-2");
		expect(next.claimed).toBe(true);
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("TOCTOU: the fencing token re-read is rename-adjacent — a reclaim that lands AFTER the fence still cannot publish a second winner", async () => {
		// The tight TOCTOU window the P1 targets: A re-reads its lock token (passes), then
		// a peer stale-reclaims the lock, then A's rename commits → two winners. We prove
		// the window is closed by spying on readClaimLockToken (the fence's re-read) and
		// foreign-stamping the lock file the INSTANT the fence passes — i.e. simulating a
		// reclaim that races into the gap between the fence-read and the renameSync. Because
		// the fence now runs as writeFileAtomic's `beforeCommit` (rename-adjacent), the only
		// place a reclaim can land after a passing fence is post-rename, where the #3
		// best-effort re-read catches it and degrades A to NOT claimed.
		const { store, path } = createFileStore();
		const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "toctou" });
		const lockPath = `${path}.lock`;

		// Peer B is the legitimate first winner of msg-1.
		const storeB = new FileSupportTicketStore(path);
		expect((await storeB.claimTrigger(ticket.id, "msg-1")).claimed).toBe(true);

		const internal = store as unknown as {
			assertClaimLockOwnership: () => void;
		};
		const originalAssert = internal.assertClaimLockOwnership.bind(internal);
		let fenceCalls = 0;
		internal.assertClaimLockOwnership = () => {
			fenceCalls += 1;
			if (fenceCalls === 1) {
				// Rename-adjacent fence: A still owns the lock here, so it PASSES and the
				// rename commits. Immediately after, a peer reclaim lands in the gap —
				// foreign-stamp the lock to simulate it.
				originalAssert();
				writeFileSync(lockPath, `88888:${"a".repeat(8)}-late-reclaim`);
				return;
			}
			// Post-rename #3 check: now sees the foreign token and throws → A loses.
			originalAssert();
		};

		const resumed = await store.claimTrigger(ticket.id, "msg-2");
		internal.assertClaimLockOwnership = originalAssert;
		// THE load-bearing guarantee: even when a reclaim somehow lands after the
		// rename-adjacent fence (impossible under #1+#2, forced here), the post-rename
		// #3 check sees the foreign token and degrades A to NOT claimed. So A's agent
		// does NOT run — no double AI spend. This is the single-winner property that
		// matters; #3 deliberately does NOT roll back the already-committed rename (that
		// would race the peer), so the on-disk msg-2 stamp is left in place and A simply
		// reports "someone else owns this".
		expect(resumed.claimed).toBe(false);

		rmSync(lockPath, { force: true });
		// The on-disk snapshot carries msg-2 (A's rename committed before #3 fired); a
		// re-trigger of msg-2 is therefore (correctly) reported as already-processed —
		// claimed exactly once, never twice.
		const fresh = new FileSupportTicketStore(path);
		expect((await fresh.claimTrigger(ticket.id, "msg-2")).claimed).toBe(false);
	});

	test("the fencing re-read and the atomic rename are back-to-back (fence runs as writeFileAtomic's pre-commit hook)", async () => {
		// Structural guarantee for the P1 fix: the token re-read must be the LAST thing
		// before the rename, with no async boundary between them. We assert that the fence
		// (readClaimLockToken) fires AFTER the temp file is fully written but BEFORE the
		// target file changes — i.e. it is rename-adjacent, not before serialize.
		const { store, path } = createFileStore();
		const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "adjacency" });

		const before = readFileSync(path, "utf8");
		const internal = store as unknown as { readClaimLockToken: () => string | null };
		const originalRead = internal.readClaimLockToken.bind(internal);
		let targetUnchangedAtFence: boolean | null = null;
		internal.readClaimLockToken = () => {
			// At the rename-adjacent fence the target file must NOT yet reflect the new
			// claim (the rename hasn't happened). The temp file already holds the payload.
			if (targetUnchangedAtFence === null) {
				targetUnchangedAtFence = readFileSync(path, "utf8") === before;
			}
			return originalRead();
		};

		const result = await store.claimTrigger(ticket.id, "msg-1");
		internal.readClaimLockToken = originalRead;
		expect(result.claimed).toBe(true);
		// The fence observed the OLD target (rename not yet applied) → it is pre-rename.
		expect(targetUnchangedAtFence).toBe(true);
		// And the rename DID apply: the on-disk snapshot now carries the claim.
		const after = JSON.parse(readFileSync(path, "utf8")) as {
			tickets: Array<{ id: string; lastProcessedMessageId?: string }>;
		};
		expect(after.tickets.find((t) => t.id === ticket.id)?.lastProcessedMessageId).toBe("msg-1");
	});

	test("a CRASHED holder (never resuming) is still reclaimed after the longer stale threshold", async () => {
		// The trade-off of the larger SUPPORT_CLAIM_LOCK_STALE_MS: crash recovery still
		// works, just after a longer timeout. We simulate a dead holder by leaving a lock
		// file whose mtime is aged WELL past the stale threshold, then prove a live store
		// reclaims it and claims normally (no permanent wedge).
		const { store, path } = createFileStore();
		const ticket = await store.createTicket({ requesterUserId: "user-1", subject: "crashed holder" });
		const lockPath = `${path}.lock`;

		// A dead process left its lock behind with a stale token.
		writeFileSync(lockPath, `12345:${"d".repeat(8)}-dead-holder`);
		// Age it far past the (now 3-minute) stale threshold so reclaim must trigger.
		const aged = Date.now() / 1000 - 10 * 60; // 10 minutes ago, in seconds
		utimesSync(lockPath, aged, aged);

		// A live store must reclaim the abandoned lock and successfully claim.
		const claim = await store.claimTrigger(ticket.id, "msg-1");
		expect(claim.claimed).toBe(true);
		// Lock released cleanly afterward (no wedge).
		expect(existsSync(lockPath)).toBe(false);
	});
});

describe("PostgresSupportTicketStore SQL shape", () => {
	test("requires DATABASE_URL when constructed without a client", () => {
		expect(() => new PostgresSupportTicketStore("")).toThrow(SupportTicketStoreError);
	});

	test("uses a scalar-bind ARRAY predicate (never $n::text[]) for status filters", async () => {
		const { store, client } = createPgStore();
		await store.listTickets({ status: ["open", "pending"] });
		const listQuery = client.queries.find((q) => q.query.includes("ORDER BY updated_at DESC"));
		expect(listQuery?.query).toContain("ANY(ARRAY[");
		expect(listQuery?.query).not.toContain("ANY($");
		// Each status is bound as its own scalar param.
		expect(listQuery?.params).toContain("open");
		expect(listQuery?.params).toContain("pending");
	});

	test("listTickets embeds a (updated_at,id) keyset cursor subselect when beforeId is set", async () => {
		const { store, client } = createPgStore();
		await store.listTickets({ requesterUserId: "user-1", limit: 5, beforeId: "cursor-id" });
		const listQuery = client.queries.find((q) => q.query.includes("ORDER BY updated_at DESC"));
		expect(listQuery?.query).toContain("(updated_at, id) <");
		expect(listQuery?.query).toContain("ORDER BY updated_at DESC, id DESC");
	});

	test("IDOR: the cursor subselect carries the requester scope predicate", async () => {
		const { store, client } = createPgStore();
		await store.listTickets({ requesterUserId: "user-1", limit: 5, beforeId: "cursor-id" });
		const listQuery = client.queries.find((q) => q.query.includes("ORDER BY updated_at DESC"));
		// The cursor subselect must filter on the SAME requester_user_id scope so a foreign
		// cursor id resolves to no row (cannot leak existence / shift the window).
		const subselect = listQuery!.query.replace(/\s+/g, " ");
		expect(subselect).toMatch(/SELECT updated_at, id FROM support_tickets WHERE id = \$\d+ AND requester_user_id = \$\d+/);
	});

	test("claimTrigger uses an atomic IS DISTINCT FROM compare-and-set", async () => {
		const { store, client } = createPgStore();
		await store.claimTrigger("t-1", "msg-1");
		const claimQuery = client.queries.find((q) => q.query.includes("last_processed_message_id IS DISTINCT FROM"));
		expect(claimQuery).toBeDefined();
		expect(claimQuery!.query.replace(/\s+/g, " ")).toContain("WHERE id = $1 AND last_processed_message_id IS DISTINCT FROM $2");
	});

	test("createTicket wraps the ticket + opening message in a single transaction (rolls back together)", async () => {
		// A begin-capable client that snapshots the in-memory tables and ROLLS BACK on a
		// thrown transaction — and is rigged to throw on the opening-message insert. With
		// the create wrapped in begin(), the ticket insert must roll back too, leaving NO
		// orphan empty ticket.
		const base = new FakeSupportSqlClient();
		let messageInserts = 0;
		const txClient: SupportTicketSqlClient = {
			unsafe: async <T>(q: string, p?: unknown[]): Promise<T[]> => {
				if (q.replace(/\s+/g, " ").includes("INSERT INTO support_ticket_messages")) {
					messageInserts += 1;
					throw new Error("simulated message insert failure");
				}
				return base.unsafe<T>(q, p);
			},
			begin: async <T>(fn: (tx: SupportTicketSqlClient) => Promise<T>): Promise<T> => {
				const ticketSnapshot = base.tickets.map((t) => ({ ...t }));
				const messageSnapshot = base.messages.map((m) => ({ ...m }));
				try {
					return await fn(txClient);
				} catch (error) {
					// ROLLBACK: restore the pre-transaction snapshot.
					base.tickets.length = 0;
					base.tickets.push(...ticketSnapshot);
					base.messages.length = 0;
					base.messages.push(...messageSnapshot);
					throw error;
				}
			},
		};
		const store = new PostgresSupportTicketStore(txClient);

		await expect(
			store.createTicket({ requesterUserId: "user-1", subject: "boom", body: "opening body" }),
		).rejects.toThrow("simulated message insert failure");

		// The message insert was attempted, but the whole transaction rolled back: NO
		// orphan ticket survives.
		expect(messageInserts).toBe(1);
		expect(base.tickets).toHaveLength(0);
		expect(base.messages).toHaveLength(0);
	});
});
