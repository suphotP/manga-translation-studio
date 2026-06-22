// AI-support — Support ticket data layer.
//
// Backs the customer support inbox + the gpt-5.5 support agent with a real,
// durable, dual-store (File | Postgres) ticket model. Cloned from the proven
// notifications.ts shape:
//   - `SupportTicketStore` is the storage interface (createTicket, getTicket,
//     listTickets, addMessage, listMessages, updateStatus, assign, and the
//     agent-support counters incrementAiUsage / setLastProcessedMessageId).
//   - `FileSupportTicketStore` is the in-memory + JSON snapshot used in tests
//     and the prototype local backend.
//   - `PostgresSupportTicketStore` is the production path, writing the
//     `support_tickets` + `support_ticket_messages` tables from migration 0053.
//   - `createSupportTicketStore()` picks one based on `SUPPORT_TICKETS_STORE` /
//     `DATABASE_URL`, mirroring billing-store / notifications gating.
//
// HTTP routes are a sibling PR — this module is migration + store + types only.
//
// Keyset pagination uses a (sort-key, id) cursor (no OFFSET) copied from
// PostgresNotificationStore so paging stays cheap as a requester / inbox grows.
// Ticket lists sort by (updated_at DESC, id DESC); message threads sort by
// (created_at ASC, id ASC).

import { getSharedBunSql } from "./sql-pool.js";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { buildAnyArrayPredicate } from "./pg-array.js";

// Cross-process file-claim tuning (mirrors the credits-store critical section).
// claimTrigger is the only path that MUST be atomic across two store instances
// sharing one JSON file (a double-claim = a double AI spend), so it takes a
// short-lived O_EXCL lock, reloads the LATEST on-disk snapshot, compares the
// trigger under the lock (CAS), and only the winner writes (atomically).
const SUPPORT_CLAIM_LOCK_TIMEOUT_MS = 5_000;
const SUPPORT_CLAIM_LOCK_RETRY_MS = 15;
// A held lock older than this is treated as abandoned (the holder crashed before
// releasing) and forcibly reclaimed so a dead process cannot wedge the claim path.
//
// TOCTOU trade-off: the claim critical section's check→commit (re-read the lock
// token, then renameSync the temp file) is a back-to-back synchronous span of
// MICROSECONDS. The stale threshold must be FAR larger than the longest plausible
// stall a live holder could suffer between its fencing re-read and the rename
// (GC pause, CPU starvation, even a brief SIGSTOP) — otherwise a peer could
// stale-reclaim the lock inside that gap and produce a second winner. 3 minutes is
// orders of magnitude beyond any realistic intra-section stall on a Bun event
// loop, so the TOCTOU window is unhittable in practice. The cost is only that a
// genuinely CRASHED holder (process gone, never resuming) is recovered after ~3
// min instead of ~30 s — an acceptable recovery latency for a rarely-contended,
// idempotent claim path. (The rename-adjacent fence in claimTriggerInMemory is the
// load-bearing guarantee; this larger threshold removes the remaining race.)
const SUPPORT_CLAIM_LOCK_STALE_MS = 180_000;

/** Ticket lifecycle. text+CHECK in the schema, never a Postgres enum. */
export const TICKET_STATUSES = ["open", "pending", "escalated", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = ["billing", "technical", "abuse", "account", "general"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/**
 * Who wrote a message: the customer, a human staff agent, the AI, the system,
 * or a staff-only INTERNAL note. `internal` is never shown to the customer — the
 * customer-facing thread read path filters it out (see routes/support-tickets.ts).
 * Added in migration 0059, which extends the support_ticket_messages CHECK
 * constraint (text+CHECK was chosen precisely so the value set is extensible).
 */
export const MESSAGE_AUTHOR_KINDS = ["customer", "agent", "ai", "system", "internal"] as const;
export type MessageAuthorKind = (typeof MESSAGE_AUTHOR_KINDS)[number];

/**
 * Author kinds the CUSTOMER is allowed to see in their own thread. `internal`
 * (staff-only notes) is deliberately excluded — it must never leak to the
 * requester. Used by the customer GET thread filter so the exclusion lives in
 * one authoritative place.
 */
export const CUSTOMER_VISIBLE_AUTHOR_KINDS: readonly MessageAuthorKind[] = ["customer", "agent", "ai", "system"];

/** True when a message author kind is visible to the customer (i.e. not an internal note). */
export function isCustomerVisibleAuthorKind(kind: MessageAuthorKind): boolean {
	return CUSTOMER_VISIBLE_AUTHOR_KINDS.includes(kind);
}

export function isTicketStatus(value: unknown): value is TicketStatus {
	return typeof value === "string" && (TICKET_STATUSES as readonly string[]).includes(value);
}

export function isTicketPriority(value: unknown): value is TicketPriority {
	return typeof value === "string" && (TICKET_PRIORITIES as readonly string[]).includes(value);
}

export function isTicketCategory(value: unknown): value is TicketCategory {
	return typeof value === "string" && (TICKET_CATEGORIES as readonly string[]).includes(value);
}

export function isMessageAuthorKind(value: unknown): value is MessageAuthorKind {
	return typeof value === "string" && (MESSAGE_AUTHOR_KINDS as readonly string[]).includes(value);
}

export interface SupportTicketRecord {
	id: string;
	requesterUserId: string;
	workspaceId?: string;
	subject: string;
	status: TicketStatus;
	priority: TicketPriority;
	category: TicketCategory;
	assigneeUserId?: string;
	queue?: string;
	aiMessageCount: number;
	aiTokensSpent: number;
	lastProcessedMessageId?: string;
	/**
	 * Store-maintained cheap signal for human takeover. Undefined means an older
	 * persisted row has not been backfilled, so fail-closed callers must inspect
	 * the thread before allowing AI to reply.
	 */
	hasAgentReply?: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SupportTicketMessageRecord {
	id: string;
	ticketId: string;
	authorKind: MessageAuthorKind;
	authorUserId?: string;
	body: string;
	tokens?: number;
	createdAt: string;
}

export interface CreateTicketInput {
	requesterUserId: string;
	subject: string;
	workspaceId?: string;
	priority?: TicketPriority;
	category?: TicketCategory;
	assigneeUserId?: string;
	queue?: string;
	/** Optional first message (the customer's opening body). */
	body?: string;
}

export interface AddMessageInput {
	ticketId: string;
	authorKind: MessageAuthorKind;
	body: string;
	authorUserId?: string;
	tokens?: number;
}

export interface ListTicketsOptions {
	/** Hard cap: how many rows to return. Coerced to [1, 100]; default 20. */
	limit?: number;
	/**
	 * Cursor: return rows STRICTLY OLDER than the row whose id is `beforeId`.
	 * Tie-broken on (updated_at, id) DESC so paging is deterministic when two
	 * tickets share a timestamp.
	 */
	beforeId?: string;
	/** Restrict to a single requester (the customer "my tickets" path). */
	requesterUserId?: string;
	/** Restrict to a status (string or array) — the staff inbox filter. */
	status?: TicketStatus | TicketStatus[];
	/** Restrict to an assignee (the agent work-queue filter). */
	assigneeUserId?: string;
	/** Restrict to a queue. */
	queue?: string;
}

export interface ListMessagesOptions {
	/** Hard cap: how many rows to return. Coerced to [1, 200]; default 50. */
	limit?: number;
	/**
	 * Cursor: return rows STRICTLY NEWER than the row whose id is `afterId`.
	 * Thread order is oldest-first, so paging walks forward in time.
	 */
	afterId?: string;
}

export interface TicketPage {
	items: SupportTicketRecord[];
	/** Id of the last item — caller passes it back as `beforeId` for the next page. */
	nextCursor?: string;
	hasMore: boolean;
}

export interface MessagePage {
	items: SupportTicketMessageRecord[];
	/** Id of the last item — caller passes it back as `afterId` for the next page. */
	nextCursor?: string;
	hasMore: boolean;
}

export class SupportTicketStoreError extends Error {
	constructor(message: string, readonly code = "support_ticket_store_error") {
		super(message);
		this.name = "SupportTicketStoreError";
	}
}

/**
 * Internal sentinel: the claim-lock fencing check found that this holder's lock was
 * stale-reclaimed by a peer mid-CAS, so the holder must abort its commit. Caught
 * inside claimTrigger (never surfaced to callers) and converted to a not-claimed
 * result — the peer that reclaimed the lock is the sole legitimate winner.
 */
class ClaimLockLostError extends Error {
	constructor() {
		super("Support claim lock was reclaimed by a peer; aborting commit");
		this.name = "ClaimLockLostError";
	}
}

export interface SupportTicketStore {
	createTicket(input: CreateTicketInput): Promise<SupportTicketRecord>;
	getTicket(ticketId: string): Promise<SupportTicketRecord | null>;
	listTickets(options?: ListTicketsOptions): Promise<TicketPage>;
	addMessage(input: AddMessageInput): Promise<SupportTicketMessageRecord>;
	listMessages(ticketId: string, options?: ListMessagesOptions): Promise<MessagePage>;
	updateStatus(ticketId: string, status: TicketStatus): Promise<SupportTicketRecord | null>;
	assign(ticketId: string, assigneeUserId: string | null, queue?: string | null): Promise<SupportTicketRecord | null>;
	/** Bump the per-ticket lifetime cost counters the guardrails enforce. */
	incrementAiUsage(ticketId: string, messages: number, tokens: number): Promise<SupportTicketRecord | null>;
	/** Single-flight marker so the agent never double-processes a trigger. */
	setLastProcessedMessageId(ticketId: string, messageId: string): Promise<SupportTicketRecord | null>;
	/**
	 * ATOMIC single-flight claim. Sets `lastProcessedMessageId = messageId` ONLY when
	 * the ticket exists and its current `lastProcessedMessageId` is NOT already
	 * `messageId` (i.e. this trigger has not already been claimed/processed), and
	 * reports whether THIS caller won the claim.
	 *
	 * This is the race-safe gate the support agent takes BEFORE the model call: two
	 * concurrent runs for the same trigger both used to pass a read-then-write check
	 * and double-spend the model. With this compare-and-set exactly one run wins
	 * (`claimed: true`); the loser sees `claimed: false` and skips without spending.
	 *
	 * `claimed` is false both when the trigger was already claimed AND when the ticket
	 * does not exist (`ticket` is then null) — the caller treats both as "skip".
	 */
	claimTrigger(ticketId: string, messageId: string): Promise<{ claimed: boolean; ticket: SupportTicketRecord | null }>;
	/**
	 * GDPR right-to-erasure: anonymize the free-text the user contributed — the BODY
	 * of every message they authored AND the SUBJECT of every ticket they opened
	 * (both are user free-text that can quote PII). The thread/ticket itself is
	 * retained for the other party / audit, but the subject's personal text is
	 * scrubbed. Idempotent. Returns how many message bodies + subjects were scrubbed.
	 */
	erasePiiForUser(userId: string): Promise<number>;
}

/** Tombstone written over a support message body on right-to-erasure. */
export const ERASED_SUPPORT_MESSAGE_BODY = "[deleted user message]";

/** Tombstone written over a support ticket SUBJECT on right-to-erasure. */
export const ERASED_SUPPORT_TICKET_SUBJECT = "[deleted user ticket]";

const DEFAULT_TICKET_LIMIT = 20;
const MAX_TICKET_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

function coerceLimit(limit: number | undefined, fallback: number, max: number): number {
	if (!Number.isFinite(limit ?? Number.NaN)) return fallback;
	const value = Math.floor(Number(limit));
	if (value <= 0) return fallback;
	return Math.min(value, max);
}

function normalizeStatusFilter(status: ListTicketsOptions["status"]): TicketStatus[] | null {
	if (status === undefined) return null;
	const list = Array.isArray(status) ? status : [status];
	const filtered = list.filter(isTicketStatus);
	return filtered.length > 0 ? filtered : null;
}

function validateCreateInput(input: CreateTicketInput): Required<Pick<CreateTicketInput, "requesterUserId" | "subject" | "priority" | "category">> & CreateTicketInput {
	const requesterUserId = input.requesterUserId?.trim();
	if (!requesterUserId) {
		throw new SupportTicketStoreError("requesterUserId is required", "ticket_invalid_requester");
	}
	const subject = input.subject?.trim();
	if (!subject) {
		throw new SupportTicketStoreError("subject is required", "ticket_invalid_subject");
	}
	const priority = input.priority ?? "normal";
	if (!isTicketPriority(priority)) {
		throw new SupportTicketStoreError(`Unknown ticket priority '${String(input.priority)}'`, "ticket_invalid_priority");
	}
	const category = input.category ?? "general";
	if (!isTicketCategory(category)) {
		throw new SupportTicketStoreError(`Unknown ticket category '${String(input.category)}'`, "ticket_invalid_category");
	}
	return {
		requesterUserId,
		subject,
		priority,
		category,
		workspaceId: input.workspaceId?.trim() || undefined,
		assigneeUserId: input.assigneeUserId?.trim() || undefined,
		queue: input.queue?.trim() || undefined,
		body: typeof input.body === "string" ? input.body : undefined,
	};
}

function validateMessageInput(input: AddMessageInput): AddMessageInput {
	const ticketId = input.ticketId?.trim();
	if (!ticketId) {
		throw new SupportTicketStoreError("ticketId is required", "message_invalid_ticket");
	}
	if (!isMessageAuthorKind(input.authorKind)) {
		throw new SupportTicketStoreError(`Unknown author kind '${String(input.authorKind)}'`, "message_invalid_author_kind");
	}
	const body = input.body?.trim();
	if (!body) {
		throw new SupportTicketStoreError("body is required", "message_invalid_body");
	}
	let tokens: number | undefined;
	if (input.tokens !== undefined && input.tokens !== null) {
		const value = Math.floor(Number(input.tokens));
		if (!Number.isFinite(value) || value < 0) {
			throw new SupportTicketStoreError("tokens must be a non-negative integer", "message_invalid_tokens");
		}
		tokens = value;
	}
	return {
		ticketId,
		authorKind: input.authorKind,
		body,
		authorUserId: input.authorUserId?.trim() || undefined,
		tokens,
	};
}

/** (updated_at, id) DESC comparator used by the file ticket list. */
function compareTicketDesc(a: SupportTicketRecord, b: SupportTicketRecord): number {
	const cmp = b.updatedAt.localeCompare(a.updatedAt);
	return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
}

/** (created_at, id) ASC comparator used by the file message thread. */
function compareMessageAsc(a: SupportTicketMessageRecord, b: SupportTicketMessageRecord): number {
	const cmp = a.createdAt.localeCompare(b.createdAt);
	return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
}

/**
 * In-memory support-ticket store with optional JSON snapshot persistence.
 * Used in tests and the file/prototype runtime. Mirrors the Postgres ordering
 * so the inbox/thread heads are deterministic across both backends.
 */
export class FileSupportTicketStore implements SupportTicketStore {
	private readonly tickets: SupportTicketRecord[] = [];
	private readonly messages: SupportTicketMessageRecord[] = [];
	// Cross-process claim lock (only used by claimTrigger when persisting to a file).
	private readonly lockPath?: string;
	private lockToken: string | null = null;
	// Monotonic millisecond clock. Wall-clock time has 1ms resolution, so a ticket
	// and its opening message — or two rapid addMessage() calls — can collide on
	// the same ISO timestamp. The (createdAt, id) comparator would then fall back
	// to a RANDOM uuid tie-break, flipping thread order non-deterministically (and
	// breaking keyset pagination). Issuing strictly-increasing timestamps keeps
	// createdAt decisive and insertion order stable, matching the Postgres backend.
	private lastIssuedMs = 0;

	constructor(private readonly persistPath?: string) {
		this.lockPath = persistPath ? `${persistPath}.lock` : undefined;
		this.load();
	}

	private nextTimestamp(): string {
		const wallClock = Date.now();
		const next = wallClock > this.lastIssuedMs ? wallClock : this.lastIssuedMs + 1;
		this.lastIssuedMs = next;
		return new Date(next).toISOString();
	}

	async createTicket(input: CreateTicketInput): Promise<SupportTicketRecord> {
		const validated = validateCreateInput(input);
		const now = this.nextTimestamp();
		const record: SupportTicketRecord = {
			id: uuid(),
			requesterUserId: validated.requesterUserId,
			workspaceId: validated.workspaceId,
			subject: validated.subject,
			status: "open",
			priority: validated.priority,
			category: validated.category,
			assigneeUserId: validated.assigneeUserId,
			queue: validated.queue,
			aiMessageCount: 0,
			aiTokensSpent: 0,
			lastProcessedMessageId: undefined,
			hasAgentReply: false,
			createdAt: now,
			updatedAt: now,
		};
		this.tickets.unshift(record);
		let openingMessage: SupportTicketMessageRecord | undefined;
		if (validated.body && validated.body.trim()) {
			openingMessage = {
				id: uuid(),
				ticketId: record.id,
				authorKind: "customer",
				authorUserId: validated.requesterUserId,
				body: validated.body.trim(),
				tokens: undefined,
				createdAt: now,
			};
			this.messages.push(openingMessage);
		}
		try {
			this.persist();
		} catch (error) {
			this.tickets.shift();
			if (openingMessage) {
				const index = this.messages.indexOf(openingMessage);
				if (index >= 0) this.messages.splice(index, 1);
			}
			throw error;
		}
		return { ...record };
	}

	async getTicket(ticketId: string): Promise<SupportTicketRecord | null> {
		const normalized = ticketId.trim();
		if (!normalized) return null;
		const found = this.tickets.find((entry) => entry.id === normalized);
		return found ? { ...found } : null;
	}

	async listTickets(options: ListTicketsOptions = {}): Promise<TicketPage> {
		const limit = coerceLimit(options.limit, DEFAULT_TICKET_LIMIT, MAX_TICKET_LIMIT);
		const requesterUserId = options.requesterUserId?.trim();
		const assigneeUserId = options.assigneeUserId?.trim();
		const queue = options.queue?.trim();
		const statuses = normalizeStatusFilter(options.status);
		const matchesScope = (entry: SupportTicketRecord): boolean =>
			(requesterUserId ? entry.requesterUserId === requesterUserId : true)
			&& (assigneeUserId ? entry.assigneeUserId === assigneeUserId : true)
			&& (queue ? entry.queue === queue : true)
			&& (statuses ? statuses.includes(entry.status) : true);
		const filtered = this.tickets.filter(matchesScope).sort(compareTicketDesc);
		// Keyset start: first row STRICTLY OLDER than the cursor's (updatedAt, id).
		// IDOR FIX (mirrors PostgresSupportTicketStore): resolve the cursor only WITHIN
		// the caller's filtered scope (not the full ticket list). A guessed foreign ticket
		// id — e.g. a customer probing another user's ticket on "my tickets" — does NOT
		// match the scope, so the cursor is REJECTED: we return an empty page (same as the
		// Postgres path, where the scoped subselect yields NULL → no keyset match) rather
		// than leaking existence or shifting the caller's pagination window.
		let startIndex = 0;
		if (options.beforeId) {
			const cursor = this.tickets.find((entry) => entry.id === options.beforeId && matchesScope(entry));
			if (!cursor) {
				return { items: [], hasMore: false };
			}
			const olderIndex = filtered.findIndex((entry) => compareTicketDesc(entry, cursor) > 0);
			startIndex = olderIndex >= 0 ? olderIndex : filtered.length;
		}
		const slice = filtered.slice(startIndex, startIndex + limit);
		const items = slice.map((entry) => ({ ...entry }));
		const hasMore = filtered.length > startIndex + items.length;
		return { items, hasMore, nextCursor: items.at(-1)?.id };
	}

	async addMessage(input: AddMessageInput): Promise<SupportTicketMessageRecord> {
		const validated = validateMessageInput(input);
		const ticket = this.tickets.find((entry) => entry.id === validated.ticketId);
		if (!ticket) {
			throw new SupportTicketStoreError(`Ticket '${validated.ticketId}' not found`, "ticket_not_found");
		}
		const now = this.nextTimestamp();
		const record: SupportTicketMessageRecord = {
			id: uuid(),
			ticketId: validated.ticketId,
			authorKind: validated.authorKind,
			authorUserId: validated.authorUserId,
			body: validated.body,
			tokens: validated.tokens,
			createdAt: now,
		};
		this.messages.push(record);
		const previousUpdatedAt = ticket.updatedAt;
		const previousHasAgentReply = ticket.hasAgentReply;
		ticket.updatedAt = now;
		if (validated.authorKind === "agent") {
			ticket.hasAgentReply = true;
		}
		try {
			this.persist();
		} catch (error) {
			this.messages.pop();
			ticket.updatedAt = previousUpdatedAt;
			ticket.hasAgentReply = previousHasAgentReply;
			throw error;
		}
		return { ...record };
	}

	async listMessages(ticketId: string, options: ListMessagesOptions = {}): Promise<MessagePage> {
		const normalized = ticketId.trim();
		if (!normalized) return { items: [], hasMore: false };
		const limit = coerceLimit(options.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
		const filtered = this.messages
			.filter((entry) => entry.ticketId === normalized)
			.sort(compareMessageAsc);
		// Thread is oldest-first; afterId returns rows STRICTLY NEWER than cursor.
		let startIndex = 0;
		if (options.afterId) {
			const cursor = this.messages.find((entry) => entry.id === options.afterId && entry.ticketId === normalized);
			if (cursor) {
				const newerIndex = filtered.findIndex((entry) => compareMessageAsc(entry, cursor) > 0);
				startIndex = newerIndex >= 0 ? newerIndex : filtered.length;
			}
		}
		const slice = filtered.slice(startIndex, startIndex + limit);
		const items = slice.map((entry) => ({ ...entry }));
		const hasMore = filtered.length > startIndex + items.length;
		return { items, hasMore, nextCursor: items.at(-1)?.id };
	}

	async updateStatus(ticketId: string, status: TicketStatus): Promise<SupportTicketRecord | null> {
		if (!isTicketStatus(status)) {
			throw new SupportTicketStoreError(`Unknown ticket status '${String(status)}'`, "ticket_invalid_status");
		}
		const ticket = this.tickets.find((entry) => entry.id === ticketId.trim());
		if (!ticket) return null;
		const previousStatus = ticket.status;
		const previousUpdatedAt = ticket.updatedAt;
		ticket.status = status;
		ticket.updatedAt = this.nextTimestamp();
		try {
			this.persist();
		} catch (error) {
			ticket.status = previousStatus;
			ticket.updatedAt = previousUpdatedAt;
			throw error;
		}
		return { ...ticket };
	}

	async assign(ticketId: string, assigneeUserId: string | null, queue?: string | null): Promise<SupportTicketRecord | null> {
		const ticket = this.tickets.find((entry) => entry.id === ticketId.trim());
		if (!ticket) return null;
		const previousAssignee = ticket.assigneeUserId;
		const previousQueue = ticket.queue;
		const previousUpdatedAt = ticket.updatedAt;
		ticket.assigneeUserId = assigneeUserId?.trim() || undefined;
		if (queue !== undefined) {
			ticket.queue = queue?.trim() || undefined;
		}
		ticket.updatedAt = this.nextTimestamp();
		try {
			this.persist();
		} catch (error) {
			ticket.assigneeUserId = previousAssignee;
			ticket.queue = previousQueue;
			ticket.updatedAt = previousUpdatedAt;
			throw error;
		}
		return { ...ticket };
	}

	async incrementAiUsage(ticketId: string, messages: number, tokens: number): Promise<SupportTicketRecord | null> {
		const deltaMessages = Math.max(0, Math.floor(Number(messages) || 0));
		const deltaTokens = Math.max(0, Math.floor(Number(tokens) || 0));
		const ticket = this.tickets.find((entry) => entry.id === ticketId.trim());
		if (!ticket) return null;
		const previousMessages = ticket.aiMessageCount;
		const previousTokens = ticket.aiTokensSpent;
		const previousUpdatedAt = ticket.updatedAt;
		ticket.aiMessageCount += deltaMessages;
		ticket.aiTokensSpent += deltaTokens;
		ticket.updatedAt = this.nextTimestamp();
		try {
			this.persist();
		} catch (error) {
			ticket.aiMessageCount = previousMessages;
			ticket.aiTokensSpent = previousTokens;
			ticket.updatedAt = previousUpdatedAt;
			throw error;
		}
		return { ...ticket };
	}

	async setLastProcessedMessageId(ticketId: string, messageId: string): Promise<SupportTicketRecord | null> {
		const normalizedMessageId = messageId.trim();
		if (!normalizedMessageId) {
			throw new SupportTicketStoreError("messageId is required", "ticket_invalid_message_id");
		}
		const ticket = this.tickets.find((entry) => entry.id === ticketId.trim());
		if (!ticket) return null;
		const previous = ticket.lastProcessedMessageId;
		const previousUpdatedAt = ticket.updatedAt;
		ticket.lastProcessedMessageId = normalizedMessageId;
		ticket.updatedAt = this.nextTimestamp();
		try {
			this.persist();
		} catch (error) {
			ticket.lastProcessedMessageId = previous;
			ticket.updatedAt = previousUpdatedAt;
			throw error;
		}
		return { ...ticket };
	}

	async claimTrigger(ticketId: string, messageId: string): Promise<{ claimed: boolean; ticket: SupportTicketRecord | null }> {
		const normalizedMessageId = messageId.trim();
		if (!normalizedMessageId) {
			throw new SupportTicketStoreError("messageId is required", "ticket_invalid_message_id");
		}
		const normalizedTicketId = ticketId.trim();
		// In-memory-only store (no persistPath, e.g. focused unit tests): the
		// single-threaded event loop already makes this read-then-write atomic — no
		// second instance can share state, so the lock/reload dance is unnecessary.
		if (!this.persistPath) {
			return this.claimTriggerInMemory(normalizedTicketId, normalizedMessageId);
		}
		// File-backed claim: this is the cross-process CAS critical section the Codex
		// review demands. WITHOUT it, two store instances over the same JSON file each
		// load the OLD lastProcessedMessageId, each see "not yet claimed", each return
		// claimed:true → the agent runs the model TWICE (double-spend) and the second
		// writeFileSync clobbers the first (last-writer-wins / torn snapshot).
		//
		// FIX (mirrors the credits-store critical section): take an exclusive O_EXCL
		// file lock, RELOAD the latest snapshot from disk under the lock, compare the
		// trigger (compare-and-set), and only if it is still unclaimed write atomically
		// (temp+rename via writeFileAtomic — never a truncated snapshot) before
		// releasing. The loser reloads the winner's write and returns claimed:false.
		const lockFd = await this.acquireClaimLock();
		try {
			this.reloadFromDisk();
			// FENCING: the O_EXCL lock has a 30s stale-reclaim (acquireClaimLock →
			// reclaimClaimLockIfStale). A LIVE holder that stalls past the stale window
			// (GC pause / CPU starvation / SIGSTOP) can have ITS lock removed and
			// re-acquired by a peer, which then claims the same trigger. Without a fence
			// the stalled holder would resume here, persist over the peer, and ALSO
			// return claimed:true → two winners / a double AI spend. So the in-memory CAS
			// is handed an `assertOwnership` guard it MUST invoke immediately before its
			// atomic write: the guard re-reads the on-disk lock token and verifies it is
			// still OUR token. If a peer stale-reclaimed (token differs / file gone), the
			// guard throws, the write is skipped, and we surface a not-claimed result
			// (the peer is the sole legitimate winner). Mirrors the credits-store fencing
			// token but adds the explicit pre-commit re-read the claim CAS requires.
			return this.claimTriggerInMemory(normalizedTicketId, normalizedMessageId, () => this.assertClaimLockOwnership());
		} catch (error) {
			if (error instanceof ClaimLockLostError) {
				// We lost the lock to a stale-reclaim mid-CAS. The peer that reclaimed it
				// is the legitimate winner; report not-claimed so we neither double-spend
				// nor clobber the peer's write. Re-load the peer's state for the returned
				// snapshot (best effort — the lock is gone so a plain read is fine).
				this.reloadFromDisk();
				const ticket = this.tickets.find((entry) => entry.id === normalizedTicketId) ?? null;
				return { claimed: false, ticket: ticket ? { ...ticket } : null };
			}
			throw error;
		} finally {
			this.releaseClaimLock(lockFd);
		}
	}

	/**
	 * The in-memory compare-and-set half of claimTrigger (run under the lock for file
	 * stores). `assertOwnership`, when supplied, is invoked immediately before the
	 * atomic write to FENCE the commit: it throws ClaimLockLostError if this holder no
	 * longer owns the lock (a peer stale-reclaimed it), in which case nothing is
	 * persisted and no claim is returned. The in-memory-only store passes no guard
	 * (single instance, no cross-process reclaim possible).
	 */
	private claimTriggerInMemory(
		normalizedTicketId: string,
		normalizedMessageId: string,
		assertOwnership?: () => void,
	): { claimed: boolean; ticket: SupportTicketRecord | null } {
		const ticket = this.tickets.find((entry) => entry.id === normalizedTicketId);
		if (!ticket) return { claimed: false, ticket: null };
		// Already claimed/processed → the loser of the race (or a re-trigger of the same
		// processed message). Report not-claimed; the agent skips without spending.
		if (ticket.lastProcessedMessageId === normalizedMessageId) {
			return { claimed: false, ticket: { ...ticket } };
		}
		// Win the claim: stamp the trigger and persist atomically. On a persist failure
		// roll the in-memory state back so a retry can re-claim cleanly.
		const previous = ticket.lastProcessedMessageId;
		const previousUpdatedAt = ticket.updatedAt;
		ticket.lastProcessedMessageId = normalizedMessageId;
		ticket.updatedAt = this.nextTimestamp();
		try {
			// Fence the commit AT THE RENAME, not before serialize. We hand the ownership
			// guard to persist()→writeFileAtomic as its `beforeCommit` hook, so the token
			// re-read fires AFTER the JSON has already been written+fsynced to the temp
			// file and IMMEDIATELY before renameSync makes it visible. That makes the
			// check→commit pair a back-to-back synchronous span (no I/O of our own data,
			// no async yield between the re-read and the rename), so a peer cannot
			// stale-reclaim the lock in the gap and produce two winners. If the guard
			// throws (peer reclaimed → token differs), the rename is skipped and the temp
			// file is discarded: nothing is published, and the catch rolls back our
			// in-memory stamp. (The stale threshold is also far larger than this span —
			// see SUPPORT_CLAIM_LOCK_STALE_MS — so the window is unhittable in practice.)
			this.persist(assertOwnership);
		} catch (error) {
			ticket.lastProcessedMessageId = previous;
			ticket.updatedAt = previousUpdatedAt;
			throw error;
		}
		// Best-effort post-commit detection (#3): re-read the lock token ONE more time
		// AFTER the rename. Under #1+#2 this never differs, but if a reclaim somehow
		// slipped through, the token now differs and we treat ourselves as the loser —
		// degrading a residual race to "not claimed" instead of a silent double-winner.
		// We do NOT roll back the on-disk state here (the rename already committed and a
		// rollback would race the peer); the in-memory stamp simply mirrors what we
		// wrote. Reporting not-claimed keeps the AI single-flight: at most one caller
		// proceeds. assertOwnership throws ClaimLockLostError on a token mismatch.
		if (assertOwnership) {
			try {
				assertOwnership();
			} catch (error) {
				if (error instanceof ClaimLockLostError) {
					return { claimed: false, ticket: { ...ticket } };
				}
				throw error;
			}
		}
		return { claimed: true, ticket: { ...ticket } };
	}

	/**
	 * Fencing check: re-read the on-disk lock token and confirm it still matches the
	 * token we stamped on acquire. A mismatch (or missing file) means our lock was
	 * stale-reclaimed by a peer while we were stalled, so we no longer hold the
	 * critical section and MUST NOT commit. Throws ClaimLockLostError on loss.
	 */
	private assertClaimLockOwnership(): void {
		const ownedToken = this.lockToken;
		const onDisk = this.readClaimLockToken();
		if (ownedToken === null || onDisk !== ownedToken) {
			throw new ClaimLockLostError();
		}
	}

	// ── Cross-process claim lock (O_EXCL lock file + fencing token), modeled on the
	// credits-store critical section. Only the file-backed claimTrigger uses it. ──
	private async acquireClaimLock(): Promise<number> {
		const lockPath = this.lockPath!;
		mkdirSync(dirname(lockPath), { recursive: true });
		const deadline = Date.now() + SUPPORT_CLAIM_LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				// O_EXCL: succeeds only if the lock file does not already exist, so at most
				// one process across the shared volume holds the claim lock at a time.
				const fd = openSync(lockPath, "wx");
				// Stamp a unique fencing token so release/reclaim can verify ownership before
				// deleting the lock file (never delete a successor's lock after a stale reclaim).
				const token = `${process.pid}:${randomUUID()}`;
				this.lockToken = token;
				try {
					writeSync(fd, token);
				} catch {
					// Best-effort owner stamp; the lock is held regardless.
				}
				return fd;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				this.reclaimClaimLockIfStale();
				if (Date.now() >= deadline) {
					throw new SupportTicketStoreError("Support claim ledger is busy; please retry", "support_claim_locked");
				}
				// Async backoff: yield the event loop between retries instead of busy-spinning.
				await delay(SUPPORT_CLAIM_LOCK_RETRY_MS);
			}
		}
	}

	private reclaimClaimLockIfStale(): void {
		const lockPath = this.lockPath!;
		try {
			// Snapshot the holder's token BEFORE the staleness check so the unlink is
			// fenced against a concurrent re-acquire: a peer that replaces the lock between
			// our stat and unlink writes a different token, and the mismatch aborts reclaim
			// (so we never delete the winner's freshly-acquired lock).
			const staleToken = this.readClaimLockToken();
			const stat = statSync(lockPath);
			if (Date.now() - stat.mtimeMs > SUPPORT_CLAIM_LOCK_STALE_MS) {
				const current = this.readClaimLockToken();
				if (current === staleToken) {
					rmSync(lockPath, { force: true });
				}
			}
		} catch {
			// lock vanished between checks — fine, the next openSync retries.
		}
	}

	private releaseClaimLock(fd: number): void {
		try {
			closeSync(fd);
		} catch {
			// already closed
		}
		const ownedToken = this.lockToken;
		this.lockToken = null;
		try {
			// Only delete the lock if it still carries OUR token. If a peer stale-reclaimed
			// our lock and acquired a new one, the on-disk token differs and we must NOT
			// delete the successor's lock. A missing file is already released.
			const onDisk = this.readClaimLockToken();
			if (onDisk === null || (ownedToken !== null && onDisk === ownedToken)) {
				rmSync(this.lockPath!, { force: true });
			}
		} catch {
			// best effort — a read/remove failure leaves the lock for stale reclamation.
		}
	}

	private readClaimLockToken(): string | null {
		try {
			const contents = readFileSync(this.lockPath!, "utf8").trim();
			return contents.length > 0 ? contents : null;
		} catch {
			return null;
		}
	}

	/**
	 * Discard the in-memory snapshot and reload it from disk. Used under the claim
	 * lock so this instance sees a peer's latest write before the compare-and-set.
	 */
	private reloadFromDisk(): void {
		this.tickets.length = 0;
		this.messages.length = 0;
		this.load();
	}

	async erasePiiForUser(userId: string): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		let scrubbed = 0;
		for (const message of this.messages) {
			if (message.authorUserId === normalized && message.body !== ERASED_SUPPORT_MESSAGE_BODY) {
				message.body = ERASED_SUPPORT_MESSAGE_BODY;
				scrubbed += 1;
			}
		}
		for (const ticket of this.tickets) {
			if (ticket.requesterUserId === normalized && ticket.subject !== ERASED_SUPPORT_TICKET_SUBJECT) {
				ticket.subject = ERASED_SUPPORT_TICKET_SUBJECT;
				scrubbed += 1;
			}
		}
		if (scrubbed > 0) this.persist();
		return scrubbed;
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<{ tickets?: SupportTicketRecord[]; messages?: SupportTicketMessageRecord[] }>(this.persistPath);
			if (Array.isArray(snapshot.tickets)) {
				for (const entry of snapshot.tickets) {
					if (isTicketRecord(entry)) this.tickets.push(entry);
				}
				this.tickets.sort(compareTicketDesc);
			}
			if (Array.isArray(snapshot.messages)) {
				for (const entry of snapshot.messages) {
					if (isMessageRecord(entry)) this.messages.push(entry);
				}
				this.messages.sort(compareMessageAsc);
			}
			// Resume the monotonic clock past the newest persisted timestamp so a
			// reloaded store never issues a value that sorts before existing rows.
			for (const ticket of this.tickets) {
				this.lastIssuedMs = Math.max(this.lastIssuedMs, Date.parse(ticket.createdAt) || 0, Date.parse(ticket.updatedAt) || 0);
			}
			for (const message of this.messages) {
				this.lastIssuedMs = Math.max(this.lastIssuedMs, Date.parse(message.createdAt) || 0);
			}
		} catch (error) {
			console.warn(`[SupportTicketStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(beforeCommit?: () => void): void {
		if (!this.persistPath) return;
		// Atomic write (temp+fsync+rename) so a crash or a concurrent claim from a second
		// store instance can never publish a TRUNCATED snapshot — a reader only ever sees
		// the previous complete file or the new complete file, never a half-written one.
		// `beforeCommit` (claimTrigger only) runs in the instant before the rename so a
		// fencing token re-read sits back-to-back with the atomic commit — see
		// claimTriggerInMemory for why that closes the stale-reclaim TOCTOU window.
		writeFileAtomic(
			this.persistPath,
			JSON.stringify({ tickets: this.tickets, messages: this.messages }, null, 2),
			beforeCommit,
		);
	}
}

export interface SupportTicketSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	/**
	 * Run `fn` inside a single transaction (commit on resolve, rollback on throw).
	 * Optional so a minimal fake client (tests) can omit it; the store then falls
	 * back to running the work on the base connection.
	 */
	begin?<T>(fn: (transaction: SupportTicketSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

interface TicketRow {
	id: string;
	requester_user_id: string;
	workspace_id: string | null;
	subject: string;
	status: string;
	priority: string;
	category: string;
	assignee_user_id: string | null;
	queue: string | null;
	ai_message_count: number | string;
	ai_tokens_spent: number | string;
	last_processed_message_id: string | null;
	has_agent_reply?: boolean | null;
	created_at: Date | string;
	updated_at: Date | string;
}

interface MessageRow {
	id: string;
	ticket_id: string;
	author_kind: string;
	author_user_id: string | null;
	body: string;
	tokens: number | string | null;
	created_at: Date | string;
}

function toIso(value: Date | string | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (value instanceof Date) return value.toISOString();
	const text = String(value).trim();
	return text || undefined;
}

function toInt(value: number | string | null | undefined): number {
	if (value === null || value === undefined) return 0;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.floor(n) : 0;
}

function mapTicketRow(row: TicketRow): SupportTicketRecord {
	return {
		id: row.id,
		requesterUserId: row.requester_user_id,
		workspaceId: row.workspace_id ?? undefined,
		subject: row.subject,
		status: (isTicketStatus(row.status) ? row.status : "open") as TicketStatus,
		priority: (isTicketPriority(row.priority) ? row.priority : "normal") as TicketPriority,
		category: (isTicketCategory(row.category) ? row.category : "general") as TicketCategory,
		assigneeUserId: row.assignee_user_id ?? undefined,
		queue: row.queue ?? undefined,
		aiMessageCount: toInt(row.ai_message_count),
		aiTokensSpent: toInt(row.ai_tokens_spent),
		lastProcessedMessageId: row.last_processed_message_id ?? undefined,
		hasAgentReply: row.has_agent_reply === null || row.has_agent_reply === undefined ? undefined : Boolean(row.has_agent_reply),
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
		updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
	};
}

function mapMessageRow(row: MessageRow): SupportTicketMessageRecord {
	return {
		id: row.id,
		ticketId: row.ticket_id,
		authorKind: (isMessageAuthorKind(row.author_kind) ? row.author_kind : "system") as MessageAuthorKind,
		authorUserId: row.author_user_id ?? undefined,
		body: row.body,
		tokens: row.tokens === null || row.tokens === undefined ? undefined : toInt(row.tokens),
		createdAt: toIso(row.created_at) ?? new Date().toISOString(),
	};
}

const TICKET_COLUMNS = `id, requester_user_id, workspace_id, subject, status, priority, category,
	assignee_user_id, queue, ai_message_count, ai_tokens_spent, last_processed_message_id,
	has_agent_reply, created_at, updated_at`;

const MESSAGE_COLUMNS = `id, ticket_id, author_kind, author_user_id, body, tokens, created_at`;

/**
 * Postgres-backed support-ticket store. Reads/writes the `support_tickets` +
 * `support_ticket_messages` tables created by migration 0053. Pagination uses a
 * keyset cursor (no OFFSET) — tickets on (updated_at, id) DESC, messages on
 * (created_at, id) ASC — so older pages stay cheap as history accumulates.
 *
 * IMPORTANT: Bun.SQL.unsafe cannot bind a JS array, so the status-array filter
 * is built with the scalar-bind ARRAY[...] helper from pg-array.ts, never
 * `= ANY($n::text[])` with a JS array.
 */
export class PostgresSupportTicketStore implements SupportTicketStore {
	private readonly client: SupportTicketSqlClient;

	constructor(databaseUrlOrClient: string | SupportTicketSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new SupportTicketStoreError("SUPPORT_TICKETS_STORE=postgres requires DATABASE_URL", "support_ticket_store_unconfigured");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as SupportTicketSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async createTicket(input: CreateTicketInput): Promise<SupportTicketRecord> {
		const validated = validateCreateInput(input);
		const ticketId = uuid();
		// TRANSACTIONAL: the ticket row + its opening customer message must commit or
		// roll back TOGETHER. Previously the ticket INSERT committed first, so a failure
		// inserting the opening message left an orphan empty ticket while the route still
		// surfaced the error. Wrapping both in one transaction makes the create atomic:
		// if the message insert throws, the ticket insert rolls back too. `begin` is
		// optional on the client interface (tests can omit it) → fall back to the base
		// connection so the path still works without a transaction in that case.
		const run = async (tx: SupportTicketSqlClient): Promise<SupportTicketRecord> => {
			const rows = await tx.unsafe<TicketRow>(`
				INSERT INTO support_tickets (id, requester_user_id, workspace_id, subject, status, priority, category, assignee_user_id, queue, has_agent_reply)
				VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, false)
				RETURNING ${TICKET_COLUMNS}
			`, [
				ticketId,
				validated.requesterUserId,
				validated.workspaceId ?? null,
				validated.subject,
				validated.priority,
				validated.category,
				validated.assigneeUserId ?? null,
				validated.queue ?? null,
			]);
			const row = rows[0];
			if (!row) {
				throw new SupportTicketStoreError("Failed to persist ticket", "ticket_create_failed");
			}
			if (validated.body && validated.body.trim()) {
				await tx.unsafe(`
					INSERT INTO support_ticket_messages (id, ticket_id, author_kind, author_user_id, body)
					VALUES ($1, $2, 'customer', $3, $4)
				`, [uuid(), ticketId, validated.requesterUserId, validated.body.trim()]);
			}
			return mapTicketRow(row);
		};
		if (this.client.begin) return this.client.begin(run);
		return run(this.client);
	}

	async getTicket(ticketId: string): Promise<SupportTicketRecord | null> {
		const normalized = ticketId.trim();
		if (!normalized) return null;
		const rows = await this.client.unsafe<TicketRow>(`
			SELECT ${TICKET_COLUMNS} FROM support_tickets WHERE id = $1
		`, [normalized]);
		const row = rows[0];
		return row ? mapTicketRow(row) : null;
	}

	async listTickets(options: ListTicketsOptions = {}): Promise<TicketPage> {
		const limit = coerceLimit(options.limit, DEFAULT_TICKET_LIMIT, MAX_TICKET_LIMIT);
		const params: unknown[] = [];
		// SCOPE predicates (requester/assignee/queue/status) are collected SEPARATELY
		// from the cursor predicate so they can be reused INSIDE the cursor subselect.
		// IDOR FIX: the cursor subquery used to resolve ANY ticket by id, so a customer
		// on "my tickets" (requester_user_id = me) could pass a GUESSED foreign ticket id
		// as `before` and probe its existence / shift their own pagination window. We now
		// require the cursor row to satisfy the SAME scope filters; a cursor outside the
		// caller's scope resolves to no row, the keyset compares against NULL (→ no match),
		// and the page is empty — the foreign id leaks nothing and cannot move the window.
		const scopeConditions: string[] = [];
		const requesterUserId = options.requesterUserId?.trim();
		if (requesterUserId) {
			params.push(requesterUserId);
			scopeConditions.push(`requester_user_id = $${params.length}`);
		}
		const assigneeUserId = options.assigneeUserId?.trim();
		if (assigneeUserId) {
			params.push(assigneeUserId);
			scopeConditions.push(`assignee_user_id = $${params.length}`);
		}
		const queue = options.queue?.trim();
		if (queue) {
			params.push(queue);
			scopeConditions.push(`queue = $${params.length}`);
		}
		const statuses = normalizeStatusFilter(options.status);
		if (statuses) {
			// Scalar-bind ARRAY[...] — Bun.SQL can't bind a JS array directly.
			scopeConditions.push(buildAnyArrayPredicate("status", statuses, params));
		}
		const conditions: string[] = [...scopeConditions];
		if (options.beforeId) {
			// Resolve the cursor's (updated_at, id) in a subselect so the keyset is
			// exact even when two tickets share an updated_at. The subselect carries the
			// SAME scope predicates (see IDOR FIX above) so a cursor outside the caller's
			// scope yields no row → the keyset compares against NULL → empty page.
			params.push(options.beforeId);
			const cursorParam = params.length;
			const cursorScope = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";
			conditions.push(`(updated_at, id) < (
				SELECT updated_at, id FROM support_tickets WHERE id = $${cursorParam}${cursorScope}
			)`);
		}
		params.push(limit + 1);
		const limitParam = params.length;
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = await this.client.unsafe<TicketRow>(`
			SELECT ${TICKET_COLUMNS}
			FROM support_tickets
			${where}
			ORDER BY updated_at DESC, id DESC
			LIMIT $${limitParam}
		`, params);
		const hasMore = rows.length > limit;
		const items = (hasMore ? rows.slice(0, limit) : rows).map(mapTicketRow);
		return { items, hasMore, nextCursor: items.at(-1)?.id };
	}

	async addMessage(input: AddMessageInput): Promise<SupportTicketMessageRecord> {
		const validated = validateMessageInput(input);
		const rows = await this.client.unsafe<MessageRow>(`
			WITH inserted AS (
				INSERT INTO support_ticket_messages (id, ticket_id, author_kind, author_user_id, body, tokens)
				SELECT $1, $2, $3, $4, $5, $6
				WHERE EXISTS (SELECT 1 FROM support_tickets WHERE id = $2)
				RETURNING ${MESSAGE_COLUMNS}
			), bumped AS (
				UPDATE support_tickets
				SET updated_at = now(),
					has_agent_reply = CASE WHEN $3 = 'agent' THEN true ELSE has_agent_reply END
				WHERE id = $2 AND EXISTS (SELECT 1 FROM inserted)
				RETURNING 1
			)
			SELECT ${MESSAGE_COLUMNS} FROM inserted
		`, [
			uuid(),
			validated.ticketId,
			validated.authorKind,
			validated.authorUserId ?? null,
			validated.body,
			validated.tokens ?? null,
		]);
		const row = rows[0];
		if (!row) {
			throw new SupportTicketStoreError(`Ticket '${validated.ticketId}' not found`, "ticket_not_found");
		}
		return mapMessageRow(row);
	}

	async listMessages(ticketId: string, options: ListMessagesOptions = {}): Promise<MessagePage> {
		const normalized = ticketId.trim();
		if (!normalized) return { items: [], hasMore: false };
		const limit = coerceLimit(options.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
		const params: unknown[] = [normalized];
		const conditions: string[] = ["ticket_id = $1"];
		if (options.afterId) {
			params.push(options.afterId);
			const cursorParam = params.length;
			conditions.push(`(created_at, id) > (
				SELECT created_at, id FROM support_ticket_messages WHERE id = $${cursorParam}
			)`);
		}
		params.push(limit + 1);
		const limitParam = params.length;
		const rows = await this.client.unsafe<MessageRow>(`
			SELECT ${MESSAGE_COLUMNS}
			FROM support_ticket_messages
			WHERE ${conditions.join(" AND ")}
			ORDER BY created_at ASC, id ASC
			LIMIT $${limitParam}
		`, params);
		const hasMore = rows.length > limit;
		const items = (hasMore ? rows.slice(0, limit) : rows).map(mapMessageRow);
		return { items, hasMore, nextCursor: items.at(-1)?.id };
	}

	async updateStatus(ticketId: string, status: TicketStatus): Promise<SupportTicketRecord | null> {
		if (!isTicketStatus(status)) {
			throw new SupportTicketStoreError(`Unknown ticket status '${String(status)}'`, "ticket_invalid_status");
		}
		const rows = await this.client.unsafe<TicketRow>(`
			UPDATE support_tickets
			SET status = $2, updated_at = now()
			WHERE id = $1
			RETURNING ${TICKET_COLUMNS}
		`, [ticketId.trim(), status]);
		const row = rows[0];
		return row ? mapTicketRow(row) : null;
	}

	async assign(ticketId: string, assigneeUserId: string | null, queue?: string | null): Promise<SupportTicketRecord | null> {
		// queue === undefined means "leave the queue unchanged". COALESCE on a
		// sentinel won't work for clearing, so branch on the two shapes.
		const normalizedAssignee = assigneeUserId?.trim() || null;
		if (queue === undefined) {
			const rows = await this.client.unsafe<TicketRow>(`
				UPDATE support_tickets
				SET assignee_user_id = $2, updated_at = now()
				WHERE id = $1
				RETURNING ${TICKET_COLUMNS}
			`, [ticketId.trim(), normalizedAssignee]);
			const row = rows[0];
			return row ? mapTicketRow(row) : null;
		}
		const normalizedQueue = queue?.trim() || null;
		const rows = await this.client.unsafe<TicketRow>(`
			UPDATE support_tickets
			SET assignee_user_id = $2, queue = $3, updated_at = now()
			WHERE id = $1
			RETURNING ${TICKET_COLUMNS}
		`, [ticketId.trim(), normalizedAssignee, normalizedQueue]);
		const row = rows[0];
		return row ? mapTicketRow(row) : null;
	}

	async incrementAiUsage(ticketId: string, messages: number, tokens: number): Promise<SupportTicketRecord | null> {
		const deltaMessages = Math.max(0, Math.floor(Number(messages) || 0));
		const deltaTokens = Math.max(0, Math.floor(Number(tokens) || 0));
		const rows = await this.client.unsafe<TicketRow>(`
			UPDATE support_tickets
			SET ai_message_count = ai_message_count + $2,
				ai_tokens_spent = ai_tokens_spent + $3,
				updated_at = now()
			WHERE id = $1
			RETURNING ${TICKET_COLUMNS}
		`, [ticketId.trim(), deltaMessages, deltaTokens]);
		const row = rows[0];
		return row ? mapTicketRow(row) : null;
	}

	async setLastProcessedMessageId(ticketId: string, messageId: string): Promise<SupportTicketRecord | null> {
		const normalizedMessageId = messageId.trim();
		if (!normalizedMessageId) {
			throw new SupportTicketStoreError("messageId is required", "ticket_invalid_message_id");
		}
		const rows = await this.client.unsafe<TicketRow>(`
			UPDATE support_tickets
			SET last_processed_message_id = $2, updated_at = now()
			WHERE id = $1
			RETURNING ${TICKET_COLUMNS}
		`, [ticketId.trim(), normalizedMessageId]);
		const row = rows[0];
		return row ? mapTicketRow(row) : null;
	}

	async claimTrigger(ticketId: string, messageId: string): Promise<{ claimed: boolean; ticket: SupportTicketRecord | null }> {
		const normalizedMessageId = messageId.trim();
		if (!normalizedMessageId) {
			throw new SupportTicketStoreError("messageId is required", "ticket_invalid_message_id");
		}
		const normalizedTicketId = ticketId.trim();
		// ATOMIC compare-and-set: claim ONLY if not already this trigger. `IS DISTINCT
		// FROM` treats a NULL last_processed_message_id (never processed) as distinct, so
		// the first run wins. Two concurrent runs serialize on the row lock; exactly one
		// UPDATE matches the WHERE and RETURNs a row — that run is the winner. The loser's
		// UPDATE matches nothing (the value is now equal), so it RETURNs zero rows.
		const claimedRows = await this.client.unsafe<TicketRow>(`
			UPDATE support_tickets
			SET last_processed_message_id = $2, updated_at = now()
			WHERE id = $1 AND last_processed_message_id IS DISTINCT FROM $2
			RETURNING ${TICKET_COLUMNS}
		`, [normalizedTicketId, normalizedMessageId]);
		const claimedRow = claimedRows[0];
		if (claimedRow) {
			return { claimed: true, ticket: mapTicketRow(claimedRow) };
		}
		// No row updated: either the ticket doesn't exist, or the trigger was already
		// claimed. Read the current row back so the caller can tell the two apart
		// (null ticket → not found; present → already claimed).
		const currentRows = await this.client.unsafe<TicketRow>(`
			SELECT ${TICKET_COLUMNS} FROM support_tickets WHERE id = $1
		`, [normalizedTicketId]);
		const currentRow = currentRows[0];
		return { claimed: false, ticket: currentRow ? mapTicketRow(currentRow) : null };
	}

	async erasePiiForUser(userId: string): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) return 0;
		// Production purges this atomically inside the GDPR transaction; this
		// standalone path keeps the interface honest for any caller scrubbing on its
		// own connection. Anonymizes the body of messages the subject authored AND the
		// free-text subject of tickets the subject opened.
		const rows = await this.client.unsafe<{ count: number | string }>(`
			WITH msgs AS (
				UPDATE support_ticket_messages
				SET body = $2
				WHERE author_user_id = $1 AND body <> $2
				RETURNING 1
			), subjects AS (
				UPDATE support_tickets
				SET subject = $3
				WHERE requester_user_id = $1 AND subject <> $3
				RETURNING 1
			)
			SELECT (SELECT COUNT(*) FROM msgs) + (SELECT COUNT(*) FROM subjects) AS count
		`, [normalized, ERASED_SUPPORT_MESSAGE_BODY, ERASED_SUPPORT_TICKET_SUBJECT]);
		const value = rows[0]?.count;
		return typeof value === "number" ? value : Number(value) || 0;
	}
}

function isTicketRecord(value: unknown): value is SupportTicketRecord {
	const record = value as Partial<SupportTicketRecord>;
	return Boolean(
		record
		&& typeof record.id === "string"
		&& typeof record.requesterUserId === "string"
		&& typeof record.subject === "string"
		&& typeof record.createdAt === "string"
		&& typeof record.updatedAt === "string"
		&& isTicketStatus(record.status),
	);
}

function isMessageRecord(value: unknown): value is SupportTicketMessageRecord {
	const record = value as Partial<SupportTicketMessageRecord>;
	return Boolean(
		record
		&& typeof record.id === "string"
		&& typeof record.ticketId === "string"
		&& typeof record.body === "string"
		&& typeof record.createdAt === "string"
		&& isMessageAuthorKind(record.authorKind),
	);
}

/** Resolve which backing store to use, mirroring notifications/billing-store. */
function resolveStoreMode(): "file" | "postgres" {
	const override = process.env.SUPPORT_TICKETS_STORE?.trim().toLowerCase();
	if (override === "postgres") return "postgres";
	if (override === "file") return "file";
	// Default: piggyback on the same gating logic as notifications/billing —
	// Postgres when DATABASE_URL is set in a non-test runtime.
	return serverConfig.billingStore === "postgres" ? "postgres" : "file";
}

export function createSupportTicketStore(): SupportTicketStore {
	if (resolveStoreMode() === "postgres") {
		return new PostgresSupportTicketStore();
	}
	return new FileSupportTicketStore(join(DATA_DIR, "support-tickets.json"));
}

export const supportTicketStore: SupportTicketStore = createSupportTicketStore();
