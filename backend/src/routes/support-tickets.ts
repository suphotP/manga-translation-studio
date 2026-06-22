// AI-support — Customer-facing + STAFF support ticket REST API.
//
// CUSTOMER (requester) side: a logged-in user opens, lists, reads, replies to,
// and closes THEIR OWN tickets. Every handler is scoped to
// `getAuthUser(c).userId`; a ticket owned by another user is reported as 404
// (not 403) so this surface never leaks the existence of someone else's ticket.
// The customer thread read path FILTERS OUT internal notes (author_kind
// "internal") so staff-only notes never reach the requester.
//
// STAFF / AGENT side (/agent/*): the human side that consumes the AI-escalated
// queue. RBAC-gated — SUPPORT_READ for reads, SUPPORT_ADJUST for mutations. Staff
// see ALL tickets and the FULL thread (internal notes included).
//
// Routes (mounted under /api/support in index.ts):
//   Customer:
//     POST /api/support/tickets              — open a ticket {subject, body, category?}
//     GET  /api/support/tickets              — list MY tickets (cursor pagination)
//     GET  /api/support/tickets/:id          — my ticket + thread (internal notes hidden)
//     POST /api/support/tickets/:id/messages — my reply {body}
//     POST /api/support/tickets/:id/ai-respond — explicit AI re-trigger
//     POST /api/support/tickets/:id/close    — close my own ticket
//   Staff (RBAC):
//     GET  /api/support/agent/tickets              — inbox: all tickets (status/assignee/queue filters)
//     GET  /api/support/agent/tickets/:id          — full ticket + thread (internal notes included)
//     POST /api/support/agent/tickets/:id/assign   — {assigneeUserId|queue}
//     POST /api/support/agent/tickets/:id/reply    — staff reply (author_kind="agent")
//     POST /api/support/agent/tickets/:id/escalate — {department, reason}
//     POST /api/support/agent/tickets/:id/internal-note — {body} (author_kind="internal", staff-only)
//     POST /api/support/agent/tickets/:id/resolve | /close
//
// Notifications go through the central notify() dispatcher (never the
// notification store directly) so per-(type × channel) preferences always
// apply. On OPEN we confirm to the requester (ticket_opened) and ping the
// support queue/assignee (ticket_replied-style "new ticket"); on a requester
// REPLY we ping the assignee or, if unassigned, the configured support queue
// user. All notify() calls are fire-and-forget (.catch'd) so a notification
// failure never fails the HTTP request, and the dispatcher resolves recipient
// email/name itself (we never re-fetch).
//
// #180 (anti-cost): once a ticket is HUMAN-OWNED (escalated or assigned to a
// human), a customer reply NOTIFIES the assignee but does NOT auto-trigger the
// AI agent — the human owns the conversation. See isHumanOwned(). The SAME gate
// applies to the explicit re-trigger (POST /ai-respond): a customer cannot force
// the AI back onto a human-owned ticket; the endpoint short-circuits (409,
// outcome="handoff") and notifies the assignee instead of calling the provider.

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod/v4";
import { serverConfig } from "../config.js";
import { authMiddleware, getAuthUser, requirePermission } from "../middleware/auth.middleware.js";
import { ADMIN_PERMISSIONS } from "../types/auth.js";
import { createSharedRateLimitStore, layeredRateLimit, type RateLimitPolicy } from "../middleware/rate-limit.js";
import { readJsonBody } from "../utils/request-body.js";
import {
	notify as defaultNotify,
	type NotifyInput,
	type NotifyResult,
} from "../services/notification-dispatch.js";
import {
	TICKET_CATEGORIES,
	TICKET_STATUSES,
	SupportTicketStoreError,
	isCustomerVisibleAuthorKind,
	supportTicketStore as defaultStore,
	type SupportTicketMessageRecord,
	type SupportTicketRecord,
	type SupportTicketStore,
	type TicketStatus,
} from "../services/support-tickets.js";
import {
	maybeTriggerSupportAgent,
	triggerSupportAgentNow,
} from "../services/support/ai-trigger.js";
import type { SupportAgentResult, RunSupportAgentInput } from "../services/support/ai-agent.js";
import { detectCustomerLanguage, stripInternalReasoning, type DetectedLanguage } from "../services/support/reply-hygiene.js";

/** Fire-and-forget notify() signature so tests can inject a spy. */
export type NotifyFn = (input: NotifyInput) => Promise<NotifyResult>;

export interface SupportTicketRouterDeps {
	store?: SupportTicketStore;
	notify?: NotifyFn;
	authMiddleware?: MiddlewareHandler;
	/**
	 * Auth middleware for the STAFF /agent/* surface. Defaults to the same shared
	 * authMiddleware as the customer routes (RBAC is then enforced per-route via
	 * requirePermission). Tests inject a role-stubbed auth so they can exercise the
	 * editor/customer 403 path vs the support/admin 200 path.
	 */
	agentAuthMiddleware?: MiddlewareHandler;
	/**
	 * User id of the support-queue mailbox to notify for UNASSIGNED tickets.
	 * Defaults to serverConfig.support.queueUserId (blank in file/dev mode → the
	 * queue notification is simply skipped).
	 */
	supportQueueUserId?: string;
	/** Human-readable queue label stored on the ticket. */
	supportQueueName?: string;
	/**
	 * Route-scoped throttle on ticket CREATION (per-minute + per-hour). Runs
	 * BEFORE the handler so a throttled request never persists a ticket/message
	 * or fires notifications. Defaults to a limiter built from
	 * serverConfig.support.ticketCreate* caps; tests inject a low-cap limiter to
	 * exercise the 429 path. Pass `null` to disable (e.g. an isolated unit test
	 * that is not exercising throttling).
	 */
	createLimiter?: MiddlewareHandler | null;
	/** Route-scoped throttle on customer REPLIES (per-minute). See createLimiter. */
	replyLimiter?: MiddlewareHandler | null;
	/**
	 * Route-scoped throttle on the explicit AI re-trigger (POST /tickets/:id/ai-respond).
	 * The AGENT itself runs the full cost guardrails, but the HTTP trigger is throttled
	 * too so a client can't spam the (awaited) endpoint. Defaults to the customer reply
	 * caps; pass `null` to disable (unit tests not exercising throttle).
	 */
	aiRespondLimiter?: MiddlewareHandler | null;
	/**
	 * Fire the agent without blocking, after a CUSTOMER reply persists. Defaults to the
	 * real kill-switch-gated trigger; tests inject a spy. Pass `null` to disable the
	 * auto-trigger entirely (e.g. a test only exercising the REST surface).
	 */
	triggerAgent?: ((input: RunSupportAgentInput) => void) | null;
	/** Awaited trigger for the /ai-respond endpoint. Defaults to triggerSupportAgentNow. */
	triggerAgentNow?: (input: RunSupportAgentInput) => Promise<SupportAgentResult>;
}

/**
 * Build the default per-user+per-ip ticket CREATE limiter from server config.
 * Scoped by BOTH user id (authed route → the primary identity) AND ip so a
 * single attacker can't fan out across IPs nor across accounts cheaply.
 * failureMode "block" → a store error fails CLOSED (429) rather than letting
 * spam through, matching the other cost-bearing limiters (ai-submit, upload).
 * Uses the SAME shared store as the global limiter (Redis when configured) so
 * the cap holds across API instances rather than per-process.
 */
function defaultTicketCreateLimiter(): MiddlewareHandler {
	return layeredRateLimit({ policies: ticketCreatePolicies(), store: createSharedRateLimitStore() });
}

function defaultTicketReplyLimiter(): MiddlewareHandler {
	return layeredRateLimit({ policies: ticketReplyPolicies(), store: createSharedRateLimitStore() });
}

export function ticketCreatePolicies(): RateLimitPolicy[] {
	return [
		{
			id: "api:support-ticket-create",
			windowMs: 60_000,
			maxRequests: serverConfig.support.ticketCreatePerMinute,
			scopes: ["user", "ip"],
			failureMode: "block",
		},
		{
			id: "api:support-ticket-create-hour",
			windowMs: 60 * 60_000,
			maxRequests: serverConfig.support.ticketCreatePerHour,
			scopes: ["user", "ip"],
			failureMode: "block",
		},
	];
}

export function ticketReplyPolicies(): RateLimitPolicy[] {
	return [
		{
			id: "api:support-ticket-reply",
			windowMs: 60_000,
			maxRequests: serverConfig.support.ticketReplyPerMinute,
			scopes: ["user", "ip"],
			failureMode: "block",
		},
	];
}

// ── Validation ────────────────────────────────────────────────────────────
// Caps chosen to block abuse (giant bodies, header-stuffing subjects) while
// staying comfortably above any legitimate support message.
const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;

const createTicketSchema = z
	.object({
		subject: z.string().trim().min(1, "subject is required").max(SUBJECT_MAX),
		body: z.string().trim().min(1, "body is required").max(BODY_MAX),
		category: z.enum(TICKET_CATEGORIES).optional(),
	})
	.strict();

const replySchema = z
	.object({
		body: z.string().trim().min(1, "body is required").max(BODY_MAX),
	})
	.strict();

const listQuerySchema = z.object({
	limit: z
		.string()
		.optional()
		.transform((value) => (value ? Number.parseInt(value, 10) : undefined))
		.refine((value) => value === undefined || (Number.isInteger(value) && value > 0 && value <= 100), {
			message: "limit must be an integer between 1 and 100",
		}),
	before: z.string().trim().optional(),
});

// ── Staff /agent surface validation ────────────────────────────────────────
// Caps + identifier ceilings sized to block abuse while staying above any real
// support workflow. queue/department/assignee are free-text staff identifiers.
const QUEUE_MAX = 100;
const DEPARTMENT_MAX = 100;
const ASSIGNEE_ID_MAX = 200;
const REASON_MAX = 2_000;

/** Staff inbox query: status/assignee/queue filters + keyset pagination. */
const agentListQuerySchema = z.object({
	limit: z
		.string()
		.optional()
		.transform((value) => (value ? Number.parseInt(value, 10) : undefined))
		.refine((value) => value === undefined || (Number.isInteger(value) && value > 0 && value <= 100), {
			message: "limit must be an integer between 1 and 100",
		}),
	before: z.string().trim().optional(),
	status: z.enum(TICKET_STATUSES).optional(),
	assignee: z.string().trim().min(1).max(ASSIGNEE_ID_MAX).optional(),
	queue: z.string().trim().min(1).max(QUEUE_MAX).optional(),
});

/**
 * Assign a ticket. At least one of assigneeUserId / queue must be present.
 * assigneeUserId="" explicitly UNASSIGNS (clears the human owner); queue is left
 * unchanged when omitted.
 */
const assignSchema = z
	.object({
		assigneeUserId: z.string().trim().max(ASSIGNEE_ID_MAX).optional(),
		queue: z.string().trim().min(1).max(QUEUE_MAX).optional(),
	})
	.strict()
	.refine((data) => data.assigneeUserId !== undefined || data.queue !== undefined, {
		message: "assigneeUserId or queue is required",
	});

const escalateSchema = z
	.object({
		department: z.string().trim().min(1, "department is required").max(DEPARTMENT_MAX),
		reason: z.string().trim().min(1).max(REASON_MAX).optional(),
	})
	.strict();

export function createSupportTicketsRouter(deps: SupportTicketRouterDeps = {}): Hono {
	const router = new Hono();
	const store = deps.store ?? defaultStore;
	const notify = deps.notify ?? defaultNotify;
	const supportQueueUserId = (deps.supportQueueUserId ?? serverConfig.support.queueUserId).trim();
	const supportQueueName = (deps.supportQueueName ?? serverConfig.support.queueName).trim() || "general";
	// Route-scoped limiters. Built lazily so the default reads the current
	// serverConfig caps; `null` disables (used by tests not exercising throttle).
	const createLimiter = deps.createLimiter === undefined ? defaultTicketCreateLimiter() : deps.createLimiter;
	const replyLimiter = deps.replyLimiter === undefined ? defaultTicketReplyLimiter() : deps.replyLimiter;
	const aiRespondLimiter = deps.aiRespondLimiter === undefined ? defaultTicketReplyLimiter() : deps.aiRespondLimiter;
	// Agent triggers. The auto-trigger fires (fire-and-forget) after a customer reply;
	// the awaited variant backs the explicit /ai-respond endpoint.
	const triggerAgent = deps.triggerAgent === undefined ? maybeTriggerSupportAgent : deps.triggerAgent;
	const triggerAgentNow = deps.triggerAgentNow ?? triggerSupportAgentNow;

	// CUSTOMER auth: scoped to the customer /tickets surface ONLY. The staff
	// /agent/* surface has its OWN auth + RBAC gate (mountAgentRoutes) so the two
	// surfaces' auth are independent — tests stub a customer identity on /tickets
	// and a distinct staff identity on /agent without the customer middleware (the
	// real JWT one in prod) short-circuiting the staff routes. Auth runs first so
	// the per-user throttle resolves to a real user id and an unauthenticated
	// spammer is 401'd before consuming any limiter budget. Both `/tickets` (the
	// list/create root) and `/tickets/*` (the per-ticket paths) are covered.
	const customerAuth = deps.authMiddleware ?? authMiddleware;
	router.use("/tickets", customerAuth);
	router.use("/tickets/*", customerAuth);

	// POST /tickets — open a ticket. The CREATE limiter runs first: when the
	// per-user+per-ip cap is exceeded it short-circuits with 429 and the handler
	// below never runs, so NO ticket/message is persisted and NO notification is
	// fired for a throttled request. createTicket(requester = current user) with
	// the opening body, then confirm to the requester + ping the support queue.
	if (createLimiter) router.use("/tickets", createMethodGate("POST", createLimiter));
	router.post("/tickets", async (c) => {
		const user = requireUser(c);
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = createTicketSchema.safeParse(raw.data);
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		try {
			const ticket = await store.createTicket({
				requesterUserId: user.userId,
				subject: parsed.data.subject,
				category: parsed.data.category,
				// Route unassigned tickets to the configured support queue so the
				// future staff inbox can group + claim them.
				queue: supportQueueName,
				body: parsed.data.body,
			});
			// The store wrote the opening message inline; fetch it so the response
			// matches the "ticket + first message" contract without a second insert.
			const thread = await store.listMessages(ticket.id, { limit: 1 });
			const firstMessage = thread.items[0] ?? null;

			// LOCALIZED: infer the requester's language from their OWN opening message so
			// the confirmation notification + email are in their language, not English.
			const requesterLanguage = detectCustomerLanguage(parsed.data.body);
			fireNotifications(notify, ticketOpenNotifications(ticket, supportQueueUserId, requesterLanguage));

			return c.json({ ticket, message: firstMessage }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// GET /tickets — list MY tickets. ALWAYS forces requesterUserId = current
	// user so another user's tickets can never appear, regardless of query input.
	router.get("/tickets", async (c) => {
		const user = requireUser(c);
		const parsed = listQuerySchema.safeParse({
			limit: c.req.query("limit") ?? undefined,
			before: c.req.query("before") ?? undefined,
		});
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		try {
			const page = await store.listTickets({
				requesterUserId: user.userId,
				limit: parsed.data.limit,
				beforeId: parsed.data.before,
			});
			return c.json({ items: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// GET /tickets/:id — my ticket + its full thread (oldest-first). A ticket the
	// caller does not own is reported as 404 to avoid an existence leak.
	//
	// CRITICAL: this is the CUSTOMER-facing thread. Staff-only INTERNAL notes
	// (author_kind="internal") must NEVER appear here — we filter them out so an
	// internal note can never leak to the requester. Staff read the FULL thread
	// (including internal notes) via GET /agent/tickets/:id.
	router.get("/tickets/:id", async (c) => {
		const user = requireUser(c);
		const ticketId = c.req.param("id");
		try {
			const ticket = await loadOwnedTicket(store, ticketId, user.userId);
			if (!ticket) return notFound(c);
			const thread = await collectThread(store, ticket.id);
			const messages = sanitizeCustomerThread(thread);
			return c.json({ ticket, messages });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// POST /tickets/:id/messages — requester reply. Owner-only. Appends a
	// customer message and flips an awaiting-customer ticket back to "open" so
	// the staff inbox re-surfaces it. Notifies the assignee (or the queue). A
	// looser per-user+per-ip throttle runs first (replies are cheaper than opens
	// but still persist + can notify), short-circuiting with 429 before any write.
	if (replyLimiter) router.use("/tickets/:id/messages", createMethodGate("POST", replyLimiter));
	router.post("/tickets/:id/messages", async (c) => {
		const user = requireUser(c);
		const ticketId = c.req.param("id");
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = replySchema.safeParse(raw.data);
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		try {
			const ticket = await loadOwnedTicket(store, ticketId, user.userId);
			if (!ticket) return notFound(c);
			const message = await store.addMessage({
				ticketId: ticket.id,
				authorKind: "customer",
				authorUserId: user.userId,
				body: parsed.data.body,
			});
			// A customer reply re-activates a resolved/closed ticket: it now needs
			// support attention again. updateStatus also refreshes updated_at so the
			// ticket bubbles to the top of the inbox ordering.
			let refreshed = ticket;
			if (ticket.status === "resolved" || ticket.status === "closed") {
				refreshed = (await store.updateStatus(ticket.id, "open")) ?? ticket;
			}

			fireNotifications(notify, ticketReplyNotifications(refreshed, supportQueueUserId));

			// Fire the gpt-5.5 support agent (fire-and-forget; no-op when the kill-switch
			// is off). The agent itself runs the MANDATORY admission/cost guardrails
			// before any model call, so this never spends tokens unguarded. Returns
			// immediately so the reply stays fast.
			//
			// #180/#189 (anti-cost): once a HUMAN takes over a ticket — escalated to a
			// department, a human agent assigned, OR a human/agent reply already in the
			// thread — we do NOT auto-trigger the AI. The human owns the conversation;
			// spending AI tokens would be wasteful and could talk over the agent. The
			// customer's reply still NOTIFIES the assignee (above). We also never
			// auto-trigger on a closed ticket. isHumanOwnedRobust short-circuits on the
			// cheap status/assignee signals, so the legit (no human ever replied) path
			// pays no extra cost.
			if (triggerAgent && refreshed.status !== "closed" && !(await isHumanOwnedRobust(store, refreshed))) {
				triggerAgent({ ticketId: refreshed.id, triggerMessageId: message.id });
			}

			return c.json({ ticket: refreshed, message }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// POST /tickets/:id/ai-respond — explicitly (re)trigger the AI agent for the
	// ticket's latest customer message. Owner-only (a support agent path can reuse this
	// later via RBAC). AWAITED so the caller learns the outcome. Throttled by the
	// reply-cap limiter; the agent runs the full guardrails internally regardless.
	if (aiRespondLimiter) router.use("/tickets/:id/ai-respond", createMethodGate("POST", aiRespondLimiter));
	router.post("/tickets/:id/ai-respond", async (c) => {
		const user = requireUser(c);
		const ticketId = c.req.param("id");
		try {
			const ticket = await loadOwnedTicket(store, ticketId, user.userId);
			if (!ticket) return notFound(c);
			// #180 (anti-cost): once a HUMAN owns the ticket — escalated to a department
			// OR assigned to a human agent — the explicit re-trigger must NOT invoke the
			// AI either, for the SAME reason the auto-trigger is suppressed: the human owns
			// the conversation, so spending tokens would be wasteful and could talk over
			// them. A customer cannot force the AI back on by hitting this endpoint. We
			// short-circuit BEFORE triggerAgentNow (so the provider is never called) and
			// instead NOTIFY the assignee that the customer is waiting, mirroring the
			// auto-trigger path's reply notification. The robust check also covers a
			// human/agent reply already in the thread (#189), even with no assignee set.
			if (await isHumanOwnedRobust(store, ticket)) {
				fireNotifications(notify, ticketReplyNotifications(ticket, supportQueueUserId));
				return c.json(
					{
						outcome: "handoff",
						code: "human_owned",
						detail: "A support agent is handling this ticket; the AI assistant won't respond. Your message was delivered to the team.",
					},
					409,
				);
			}
			// Resolve the latest CUSTOMER message as the trigger; nothing to answer otherwise.
			const latestCustomer = await latestCustomerMessage(store, ticket.id);
			if (!latestCustomer) {
				return c.json({ error: "No customer message to respond to", code: "no_customer_message" }, 409);
			}
			const result = await triggerAgentNow({
				ticketId: ticket.id,
				triggerMessageId: latestCustomer.id,
				// CUSTOMER route: do NOT bypass single-flight. A customer must not be able to
				// force a fresh model run on a trigger that was already processed — that re-runs
				// the (capped, cost-bearing) agent past the dedup window. Only staff/admin may
				// force a fresh run, and that path is gated behind SUPPORT_ADJUST elsewhere. The
				// atomic claim inside runSupportAgent then makes a repeated press a no-op skip.
			});
			return c.json({ outcome: result.kind, department: result.department, detail: result.detail });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// POST /tickets/:id/close — requester closes their own ticket. Owner-only.
	router.post("/tickets/:id/close", async (c) => {
		const user = requireUser(c);
		const ticketId = c.req.param("id");
		try {
			const ticket = await loadOwnedTicket(store, ticketId, user.userId);
			if (!ticket) return notFound(c);
			if (ticket.status === "closed") {
				return c.json({ ticket });
			}
			const updated = await store.updateStatus(ticket.id, "closed");
			return c.json({ ticket: updated ?? ticket });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// ── STAFF / AGENT surface (/agent/*) ──────────────────────────────────────
	// The HUMAN side that consumes the AI-escalated queue. RBAC-gated:
	//   - READ endpoints require SUPPORT_READ,
	//   - mutating endpoints require SUPPORT_ADJUST.
	// Distinct from the customer's own-tickets list above: staff see ALL tickets
	// and the FULL thread (including internal notes). Mounted under /api/support,
	// so these resolve at /api/support/agent/*.
	mountAgentRoutes(router, {
		store,
		notify,
		agentAuth: deps.agentAuthMiddleware ?? deps.authMiddleware ?? authMiddleware,
		supportQueueName,
	});

	return router;
}

// ── Staff /agent routes ─────────────────────────────────────────────────────

interface AgentRouteDeps {
	store: SupportTicketStore;
	notify: NotifyFn;
	agentAuth: MiddlewareHandler;
	supportQueueName: string;
}

/**
 * Mount the human staff/agent endpoints under /agent. Auth runs first (so RBAC
 * resolves against a real user), then a per-route requirePermission gate:
 * SUPPORT_READ for reads, SUPPORT_ADJUST for mutations. requirePermission emits
 * 401 (no user) / 403 (wrong role); an editor or customer hits 403 here even
 * though they can reach their OWN tickets above.
 */
function mountAgentRoutes(router: Hono, deps: AgentRouteDeps): void {
	const { store, notify, agentAuth, supportQueueName } = deps;
	const readGate = requirePermission(ADMIN_PERMISSIONS.SUPPORT_READ);
	const adjustGate = requirePermission(ADMIN_PERMISSIONS.SUPPORT_ADJUST);

	router.use("/agent/*", agentAuth);

	// GET /agent/tickets — staff inbox. Lists ALL tickets (not requester-scoped),
	// filterable by status/assignee/queue, keyset-paginated. SUPPORT_READ.
	router.get("/agent/tickets", readGate, async (c) => {
		const parsed = agentListQuerySchema.safeParse({
			limit: c.req.query("limit") ?? undefined,
			before: c.req.query("before") ?? undefined,
			status: c.req.query("status") ?? undefined,
			assignee: c.req.query("assignee") ?? undefined,
			queue: c.req.query("queue") ?? undefined,
		});
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		try {
			const page = await store.listTickets({
				limit: parsed.data.limit,
				beforeId: parsed.data.before,
				status: parsed.data.status,
				assigneeUserId: parsed.data.assignee,
				queue: parsed.data.queue,
			});
			return c.json({ items: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// GET /agent/tickets/:id — full ticket + COMPLETE thread (internal notes
	// included — this is the staff view). SUPPORT_READ.
	router.get("/agent/tickets/:id", readGate, async (c) => {
		const ticketId = c.req.param("id")?.trim();
		try {
			const ticket = ticketId ? await store.getTicket(ticketId) : null;
			if (!ticket) return notFound(c);
			const messages = await collectThread(store, ticket.id);
			return c.json({ ticket, messages });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// POST /agent/tickets/:id/assign — assign to a human (or queue). SUPPORT_ADJUST.
	// Notifies the new assignee. assigneeUserId="" clears the human owner.
	router.post("/agent/tickets/:id/assign", adjustGate, async (c) => {
		const ticketId = c.req.param("id")?.trim();
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = assignSchema.safeParse(raw.data);
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		try {
			const ticket = ticketId ? await store.getTicket(ticketId) : null;
			if (!ticket) return notFound(c);
			// assigneeUserId omitted → leave assignee unchanged (queue-only move);
			// "" → unassign; otherwise set. queue omitted → unchanged.
			const previousAssignee = ticket.assigneeUserId?.trim() || null;
			const assignee =
				parsed.data.assigneeUserId === undefined
					? (ticket.assigneeUserId ?? null)
					: parsed.data.assigneeUserId.trim() || null;
			const updated = (await store.assign(ticket.id, assignee, parsed.data.queue ?? undefined)) ?? ticket;

			// Notify the assignee ONLY on a REAL transition — re-assigning an already-assigned
			// ticket to the SAME user must not re-send the in-app + email notification. We
			// compare the new assignee to the PREVIOUS one (normalized) and skip when unchanged.
			// (Also never self-ping the requester.) A stable idempotencyKey keyed on
			// (ticket, assignee) lets the mailer dedupe a retried assign at the provider too.
			const newAssignee = updated.assigneeUserId?.trim() || null;
			const assigneeChanged = newAssignee !== previousAssignee;
			if (assigneeChanged && newAssignee && newAssignee !== updated.requesterUserId) {
				fireNotifications(notify, [
					{
						userId: newAssignee,
						type: "ticket_replied",
						title: `Ticket assigned to you: ${updated.subject}`,
						body: `You were assigned a ${updated.category} support ticket.`,
						linkUrl: ticketLink(updated.id),
						workspaceId: updated.workspaceId,
						metadata: { ticketId: updated.id, event: "assigned", queue: updated.queue },
						idempotencyKey: `ticket-assign:${updated.id}:${newAssignee}`,
					},
				]);
			}
			return c.json({ ticket: updated });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// POST /agent/tickets/:id/reply — staff reply (author_kind="agent"), visible to
	// the customer. SUPPORT_ADJUST. Notifies the requester (ticket_replied). Flips
	// an open/pending ticket to "pending" (awaiting the customer).
	//
	// #189 (anti-cost): a human replying CLAIMS the ticket — standard support-desk
	// behavior. We auto-assign the replying staff member as the assignee when the
	// ticket has no human owner yet (keeping any existing assignee untouched). This
	// makes the ticket HUMAN-OWNED, so a later customer reply / ai-respond can no
	// longer re-engage the AI agent (isHumanOwned() then short-circuits the gate).
	// Without this, a staff reply set status="pending" but left assigneeUserId
	// empty, so a non-escalated ticket still passed the human-owned gate and the AI
	// could talk over a human who is already handling the conversation.
	router.post("/agent/tickets/:id/reply", adjustGate, async (c) => {
		const staff = requireUser(c);
		const ticketId = c.req.param("id")?.trim();
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = replySchema.safeParse(raw.data);
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		try {
			const ticket = ticketId ? await store.getTicket(ticketId) : null;
			if (!ticket) return notFound(c);
			const message = await store.addMessage({
				ticketId: ticket.id,
				authorKind: "agent",
				authorUserId: staff.userId,
				body: parsed.data.body,
			});
			let refreshed = ticket;
			// Take ownership: a human reply claims an unowned ticket so the AI never
			// re-engages afterward. Keep an existing assignee (don't steal the ticket).
			if (!ticket.assigneeUserId?.trim()) {
				refreshed = (await store.assign(ticket.id, staff.userId, ticket.queue ?? undefined)) ?? refreshed;
			}
			// A staff reply puts the ball back in the customer's court → "pending".
			// We don't override escalated/resolved/closed lifecycle states.
			if (refreshed.status === "open") {
				refreshed = (await store.updateStatus(ticket.id, "pending")) ?? refreshed;
			}
			// LOCALIZED: notify the requester in THEIR language (inferred from their latest
			// message), with a localized email CTA — not hardcoded English.
			const replyLocale = resolveRequesterLocale(await resolveRequesterLanguage(store, refreshed.id));
			const replyText = AGENT_REPLY_TEXT[replyLocale];
			fireNotifications(notify, [
				{
					userId: refreshed.requesterUserId,
					type: "ticket_replied",
					title: replyText.title(refreshed.subject),
					body: replyText.body,
					linkUrl: ticketLink(refreshed.id),
					workspaceId: refreshed.workspaceId,
					metadata: { ticketId: refreshed.id, event: "agent_reply" },
					locale: replyLocale,
					emailActionLabel: replyText.cta,
				},
			]);
			return c.json({ ticket: refreshed, message }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// POST /agent/tickets/:id/internal-note — staff-only note (author_kind="internal").
	// SUPPORT_ADJUST. NEVER shown to the customer (the customer GET thread filters
	// internal notes out). Does NOT notify the requester. Does NOT change status.
	router.post("/agent/tickets/:id/internal-note", adjustGate, async (c) => {
		const staff = requireUser(c);
		const ticketId = c.req.param("id")?.trim();
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = replySchema.safeParse(raw.data);
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		try {
			const ticket = ticketId ? await store.getTicket(ticketId) : null;
			if (!ticket) return notFound(c);
			const message = await store.addMessage({
				ticketId: ticket.id,
				authorKind: "internal",
				authorUserId: staff.userId,
				body: parsed.data.body,
			});
			return c.json({ ticket, message }, 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// POST /agent/tickets/:id/escalate — escalate to a department. SUPPORT_ADJUST.
	// Sets status=escalated, routes to the department (stored as the queue), records
	// the reason as an internal note, and notifies the requester (ticket_escalated).
	router.post("/agent/tickets/:id/escalate", adjustGate, async (c) => {
		const staff = requireUser(c);
		const ticketId = c.req.param("id")?.trim();
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = escalateSchema.safeParse(raw.data);
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		try {
			const ticket = ticketId ? await store.getTicket(ticketId) : null;
			if (!ticket) return notFound(c);
			// Route to the department: store it as the queue + flip status to escalated.
			await store.assign(ticket.id, ticket.assigneeUserId ?? null, parsed.data.department);
			const updated = (await store.updateStatus(ticket.id, "escalated")) ?? ticket;
			// Capture the escalation reason as a staff-only internal note (never shown
			// to the customer) so the trail survives outside notification metadata.
			if (parsed.data.reason) {
				await store.addMessage({
					ticketId: ticket.id,
					authorKind: "internal",
					authorUserId: staff.userId,
					body: `Escalated to ${parsed.data.department}: ${parsed.data.reason}`,
				});
			}
			// LOCALIZED: notify the requester in THEIR language. We do NOT echo the raw
			// department/reason into the customer notification (it can be internal jargon);
			// the localized body is neutral.
			const escLocale = resolveRequesterLocale(await resolveRequesterLanguage(store, updated.id));
			const escText = ESCALATED_TEXT[escLocale];
			fireNotifications(notify, [
				{
					userId: updated.requesterUserId,
					type: "ticket_escalated",
					title: escText.title(updated.subject),
					body: escText.body,
					linkUrl: ticketLink(updated.id),
					workspaceId: updated.workspaceId,
					metadata: { ticketId: updated.id, event: "escalated", department: parsed.data.department },
					locale: escLocale,
					emailActionLabel: escText.cta,
				},
			]);
			return c.json({ ticket: updated });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// POST /agent/tickets/:id/resolve — mark resolved. SUPPORT_ADJUST.
	router.post("/agent/tickets/:id/resolve", adjustGate, resolveOrCloseHandler(store, notify, "resolved"));
	// POST /agent/tickets/:id/close — mark closed. SUPPORT_ADJUST.
	router.post("/agent/tickets/:id/close", adjustGate, resolveOrCloseHandler(store, notify, "closed"));
}

/**
 * Shared resolve/close handler: set the terminal status and notify the requester
 * (ticket_resolved for both — a closed ticket is "resolved" from the customer's
 * point of view). Idempotent: a no-op when already in the target state.
 */
function resolveOrCloseHandler(
	store: SupportTicketStore,
	notify: NotifyFn,
	status: Extract<TicketStatus, "resolved" | "closed">,
): (c: any) => Promise<Response> {
	return async (c: any) => {
		const ticketId = c.req.param("id")?.trim();
		try {
			const ticket = ticketId ? await store.getTicket(ticketId) : null;
			if (!ticket) return notFound(c);
			if (ticket.status === status) {
				return c.json({ ticket });
			}
			const updated = (await store.updateStatus(ticket.id, status)) ?? ticket;
			// LOCALIZED: notify the requester in THEIR language with a localized email CTA.
			const locale = resolveRequesterLocale(await resolveRequesterLanguage(store, updated.id));
			const text = (status === "closed" ? CLOSED_TEXT : RESOLVED_TEXT)[locale];
			fireNotifications(notify, [
				{
					userId: updated.requesterUserId,
					type: "ticket_resolved",
					title: text.title(updated.subject),
					body: text.body,
					linkUrl: ticketLink(updated.id),
					workspaceId: updated.workspaceId,
					metadata: { ticketId: updated.id, event: status === "closed" ? "closed" : "resolved" },
					locale,
					emailActionLabel: text.cta,
				},
			]);
			return c.json({ ticket: updated });
		} catch (error) {
			return errorResponse(c, error);
		}
	};
}

// ── Ownership + thread helpers ──────────────────────────────────────────────

/** Load a ticket only if owned by `userId`; otherwise null (caller → 404). */
async function loadOwnedTicket(
	store: SupportTicketStore,
	ticketId: string | undefined,
	userId: string,
): Promise<SupportTicketRecord | null> {
	const normalized = ticketId?.trim();
	if (!normalized) return null;
	const ticket = await store.getTicket(normalized);
	if (!ticket || ticket.requesterUserId !== userId) return null;
	return ticket;
}

/** The most recent CUSTOMER message in the thread, or null when there is none. */
async function latestCustomerMessage(store: SupportTicketStore, ticketId: string): Promise<SupportTicketMessageRecord | null> {
	const thread = await collectThread(store, ticketId);
	for (let i = thread.length - 1; i >= 0; i -= 1) {
		if (thread[i]!.authorKind === "customer") return thread[i]!;
	}
	return null;
}

/**
 * Render-time customer-visibility filter for a ticket thread (a16 #11 — DEFAULT
 * DENY). Two layers, applied to the FULL thread before it is returned to the
 * requester:
 *
 *   1. Author-kind allow-list: only `isCustomerVisibleAuthorKind` messages
 *      survive, so staff-only INTERNAL notes (author_kind="internal") can never
 *      reach the customer — even if a future producer forgets to special-case them.
 *
 *   2. AI-reasoning re-strip: an `ai` message body is re-run through
 *      stripInternalReasoning at READ time, not only at write time. Write-time
 *      stripping in ai-agent.ts is the primary defense, but a legacy row, a
 *      stripper-miss (e.g. a NEW reasoning heading shape), or any out-of-band
 *      addMessage("ai", …) would otherwise leak the model's internal triage /
 *      "## Internal reasoning" sections to the customer. We re-strip here so the
 *      customer thread NEVER contains internal reasoning regardless of how the row
 *      was written. A message that collapses to empty (reasoning-only) is DROPPED
 *      rather than rendered blank — the safe handoff already replaced it.
 *
 * Non-`ai` customer-visible messages (customer/agent/system) are returned
 * verbatim — agent/customer/system bodies are authored to be customer-facing.
 */
function sanitizeCustomerThread(thread: SupportTicketMessageRecord[]): SupportTicketMessageRecord[] {
	const out: SupportTicketMessageRecord[] = [];
	for (const message of thread) {
		if (!isCustomerVisibleAuthorKind(message.authorKind)) continue;
		if (message.authorKind === "ai") {
			const safeBody = stripInternalReasoning(message.body).trim();
			if (!safeBody) continue; // reasoning-only → never render to the customer
			out.push(safeBody === message.body ? message : { ...message, body: safeBody });
			continue;
		}
		out.push(message);
	}
	return out;
}

/** Walk the full message thread (oldest-first) across cursor pages. */
async function collectThread(store: SupportTicketStore, ticketId: string): Promise<SupportTicketMessageRecord[]> {
	const all: SupportTicketMessageRecord[] = [];
	let afterId: string | undefined;
	// Bound the walk so a pathological thread can't pin the event loop. 100 pages
	// × 200 messages is well beyond any real support conversation.
	for (let page = 0; page < 100; page += 1) {
		const result = await store.listMessages(ticketId, { afterId, limit: 200 });
		all.push(...result.items);
		if (!result.hasMore || !result.nextCursor) break;
		afterId = result.nextCursor;
	}
	return all;
}

// ── Localized REQUESTER-facing notification strings ──────────────────────────
// The manual staff/system notifications sent to the REQUESTER (customer) — ticket
// opened, a human agent replied, escalated, resolved/closed — were hardcoded
// English, and the dispatcher defaults the email locale to "en". A non-English
// requester therefore got an English in-app notification AND an English email even
// though the AI-agent surface was already fully localized. We localize these here
// (mirroring reply-hygiene's supported set: en/th/ja/ko/zh, English fallback) and
// pass `locale` so the email renders in the requester's language too.
//
// Locale is INFERRED from the requester's own latest message (the same signal the
// AI agent uses via detectCustomerLanguage) — there is no stored user locale, so
// this avoids a schema migration while still matching what the customer wrote in.
// The STAFF/queue pings stay English (internal recipients).

const SUPPORTED_NOTIFICATION_LOCALES = ["en", "th", "ja", "ko", "zh"] as const;
type RequesterLocale = (typeof SUPPORTED_NOTIFICATION_LOCALES)[number];

function resolveRequesterLocale(language: DetectedLanguage): RequesterLocale {
	return (SUPPORTED_NOTIFICATION_LOCALES as readonly string[]).includes(language.code)
		? (language.code as RequesterLocale)
		: "en";
}

interface LocalizedText {
	title: (subject: string) => string;
	body: string;
	/** CTA label override for the email button (English fallback used otherwise). */
	cta?: string;
}

const OPENED_TEXT: Record<RequesterLocale, LocalizedText> = {
	en: { title: (s) => `We received your request: ${s}`, body: "Thanks for reaching out — our support team will get back to you soon.", cta: "View ticket" },
	th: { title: (s) => `เราได้รับคำขอของคุณแล้ว: ${s}`, body: "ขอบคุณที่ติดต่อเข้ามา ทีมงานฝ่ายสนับสนุนของเราจะติดต่อกลับหาคุณโดยเร็วที่สุด", cta: "ดูเรื่องที่แจ้ง" },
	ja: { title: (s) => `お問い合わせを受け付けました: ${s}`, body: "お問い合わせありがとうございます。サポートチームより追ってご連絡いたします。", cta: "チケットを表示" },
	ko: { title: (s) => `문의가 접수되었습니다: ${s}`, body: "문의해 주셔서 감사합니다. 고객 지원팀이 곧 연락드리겠습니다.", cta: "문의 보기" },
	zh: { title: (s) => `我们已收到您的请求：${s}`, body: "感谢您的联系，我们的支持团队会尽快与您联系。", cta: "查看工单" },
};

const AGENT_REPLY_TEXT: Record<RequesterLocale, LocalizedText> = {
	en: { title: (s) => `Support replied to: ${s}`, body: "Our support team replied to your ticket.", cta: "View reply" },
	th: { title: (s) => `ฝ่ายสนับสนุนตอบกลับเรื่อง: ${s}`, body: "ทีมงานฝ่ายสนับสนุนของเราได้ตอบกลับเรื่องของคุณแล้ว", cta: "ดูคำตอบ" },
	ja: { title: (s) => `サポートから返信がありました: ${s}`, body: "サポートチームがお問い合わせにお答えしました。", cta: "返信を表示" },
	ko: { title: (s) => `고객 지원팀이 답변했습니다: ${s}`, body: "고객 지원팀이 문의에 답변해 드렸습니다.", cta: "답변 보기" },
	zh: { title: (s) => `支持团队已回复：${s}`, body: "我们的支持团队已回复您的工单。", cta: "查看回复" },
};

const ESCALATED_TEXT: Record<RequesterLocale, LocalizedText> = {
	en: { title: (s) => `Your ticket was escalated: ${s}`, body: "We've escalated your request to a specialist team.", cta: "View ticket" },
	th: { title: (s) => `เรื่องของคุณถูกส่งต่อแล้ว: ${s}`, body: "เราได้ส่งต่อคำขอของคุณให้ทีมผู้เชี่ยวชาญแล้ว", cta: "ดูเรื่องที่แจ้ง" },
	ja: { title: (s) => `お問い合わせをエスカレーションしました: ${s}`, body: "お問い合わせを専門チームに引き継ぎました。", cta: "チケットを表示" },
	ko: { title: (s) => `문의가 전문팀에 전달되었습니다: ${s}`, body: "고객님의 요청을 전문팀에 전달했습니다.", cta: "문의 보기" },
	zh: { title: (s) => `您的工单已升级：${s}`, body: "我们已将您的请求转交给专家团队。", cta: "查看工单" },
};

const RESOLVED_TEXT: Record<RequesterLocale, LocalizedText> = {
	en: { title: (s) => `Your ticket was resolved: ${s}`, body: "Your support ticket has been marked resolved. Reply if you still need help.", cta: "View ticket" },
	th: { title: (s) => `เรื่องของคุณได้รับการแก้ไขแล้ว: ${s}`, body: "เรื่องที่คุณแจ้งได้รับการแก้ไขแล้ว หากยังต้องการความช่วยเหลือ กรุณาตอบกลับ", cta: "ดูเรื่องที่แจ้ง" },
	ja: { title: (s) => `お問い合わせが解決済みになりました: ${s}`, body: "お問い合わせは解決済みとしてマークされました。さらにサポートが必要な場合はご返信ください。", cta: "チケットを表示" },
	ko: { title: (s) => `문의가 해결되었습니다: ${s}`, body: "문의가 해결됨으로 표시되었습니다. 추가 도움이 필요하시면 답장해 주세요.", cta: "문의 보기" },
	zh: { title: (s) => `您的工单已解决：${s}`, body: "您的支持工单已标记为已解决。如果仍需帮助，请回复。", cta: "查看工单" },
};

const CLOSED_TEXT: Record<RequesterLocale, LocalizedText> = {
	en: { title: (s) => `Your ticket was closed: ${s}`, body: "Your support ticket has been closed. Reply any time to reopen it.", cta: "View ticket" },
	th: { title: (s) => `เรื่องของคุณถูกปิดแล้ว: ${s}`, body: "เรื่องที่คุณแจ้งถูกปิดแล้ว ตอบกลับเมื่อใดก็ได้เพื่อเปิดเรื่องใหม่", cta: "ดูเรื่องที่แจ้ง" },
	ja: { title: (s) => `お問い合わせがクローズされました: ${s}`, body: "お問い合わせはクローズされました。再開するにはいつでもご返信ください。", cta: "チケットを表示" },
	ko: { title: (s) => `문의가 종료되었습니다: ${s}`, body: "문의가 종료되었습니다. 다시 열려면 언제든지 답장해 주세요.", cta: "문의 보기" },
	zh: { title: (s) => `您的工单已关闭：${s}`, body: "您的支持工单已关闭。随时回复即可重新打开。", cta: "查看工单" },
};

/**
 * Infer the REQUESTER's language from their own latest message so the customer-facing
 * notification (and its email) can be localized. Best-effort: any read failure falls
 * back to English so a notification never fails to send. Used by the manual staff/system
 * notification paths (open is handled inline since the opening body is already in hand).
 */
async function resolveRequesterLanguage(store: SupportTicketStore, ticketId: string): Promise<DetectedLanguage> {
	try {
		const latest = await latestCustomerMessage(store, ticketId);
		return detectCustomerLanguage(latest?.body);
	} catch {
		return detectCustomerLanguage(undefined);
	}
}

// ── Notification builders ───────────────────────────────────────────────────
// Each builder returns the list of notify() inputs to fire for an event. The
// dispatcher resolves recipient email/name from the userId, so we never pass an
// email here. Queue notifications are emitted only when a queue user is
// configured AND it isn't the requester themselves (avoid self-pinging in dev).

function ticketOpenNotifications(
	ticket: SupportTicketRecord,
	supportQueueUserId: string,
	requesterLanguage: DetectedLanguage,
): NotifyInput[] {
	const inputs: NotifyInput[] = [];
	const link = ticketLink(ticket.id);

	// 1. Confirmation to the requester — LOCALIZED in the requester's language.
	const locale = resolveRequesterLocale(requesterLanguage);
	const opened = OPENED_TEXT[locale];
	inputs.push({
		userId: ticket.requesterUserId,
		type: "ticket_opened",
		title: opened.title(ticket.subject),
		body: opened.body,
		linkUrl: link,
		workspaceId: ticket.workspaceId,
		metadata: { ticketId: ticket.id, event: "opened" },
		locale,
		emailActionLabel: opened.cta,
	});

	// 2. Ping the assignee if one exists, else the configured support queue.
	const staffRecipient = staffRecipientFor(ticket, supportQueueUserId);
	if (staffRecipient && staffRecipient !== ticket.requesterUserId) {
		inputs.push({
			userId: staffRecipient,
			type: "ticket_replied",
			title: `New support ticket: ${ticket.subject}`,
			body: `A new ${ticket.category} ticket was opened and needs attention.`,
			linkUrl: link,
			workspaceId: ticket.workspaceId,
			metadata: { ticketId: ticket.id, event: "opened", queue: ticket.queue },
		});
	}

	return inputs;
}

function ticketReplyNotifications(ticket: SupportTicketRecord, supportQueueUserId: string): NotifyInput[] {
	const staffRecipient = staffRecipientFor(ticket, supportQueueUserId);
	if (!staffRecipient || staffRecipient === ticket.requesterUserId) return [];
	return [
		{
			userId: staffRecipient,
			type: "ticket_replied",
			title: `New reply on: ${ticket.subject}`,
			body: "The customer added a reply and is waiting on support.",
			linkUrl: ticketLink(ticket.id),
			workspaceId: ticket.workspaceId,
			metadata: { ticketId: ticket.id, event: "reply" },
		},
	];
}

/** Assignee if set, otherwise the configured support-queue user (may be ""). */
function staffRecipientFor(ticket: SupportTicketRecord, supportQueueUserId: string): string {
	const assignee = ticket.assigneeUserId?.trim();
	if (assignee) return assignee;
	return supportQueueUserId.trim();
}

/**
 * #180/#189: a ticket is HUMAN-OWNED once a human takes it over. The AI auto-trigger
 * and the explicit re-trigger are both skipped for such tickets (the human owns the
 * conversation; spending AI tokens would be wasteful and could talk over the agent).
 *
 * INVARIANT: once a HUMAN has replied to a ticket, no customer action can trigger the
 * AI agent again. We make that robust in two layers:
 *
 *  1. The CHEAP synchronous signals, checked first with NO store access:
 *       - status === "escalated"  (escalated to a department), OR
 *       - assigneeUserId set       (a human claimed/was-assigned the ticket), OR
 *       - hasAgentReply === true   (the store saw author_kind="agent").
 *     A staff reply now AUTO-ASSIGNS the replying agent (#189), so assigneeUserId is
 *     populated after any human reply on the normal route. The store-level cache keeps
 *     the invariant even for lower-level addMessage("agent") calls.
 *
 *  2. A defensive FALLBACK that only runs when the cached hasAgentReply signal is
 *     missing/unknown (older persisted rows): scan the thread for ANY human/agent
 *     reply (author_kind === "agent"). The walk is bounded (collectThread caps the
 *     pages) and is skipped entirely whenever hasAgentReply=false, so the common
 *     legitimate-AI path pays no extra thread read.
 *
 * Note: assigneeUserId / author_kind="agent" are only ever produced by a human via the
 * /agent/* surface — the AI writes author_kind="ai" and never assigns itself — so both
 * signals reliably mean a human has the ticket.
 */
function isHumanOwned(ticket: SupportTicketRecord): boolean {
	if (ticket.status === "escalated") return true;
	if (ticket.assigneeUserId?.trim()) return true;
	return ticket.hasAgentReply === true;
}

/**
 * Robust human-owned check (see isHumanOwned). Returns the cheap synchronous result
 * immediately when the ticket row has a known answer; otherwise falls back to scanning
 * the thread for a human/agent reply so a customer can never re-engage the AI once a
 * human has replied on an older row that lacks the cached signal.
 */
async function isHumanOwnedRobust(store: SupportTicketStore, ticket: SupportTicketRecord): Promise<boolean> {
	if (isHumanOwned(ticket)) return true;
	if (ticket.hasAgentReply === false) return false;
	return hasHumanAgentReply(store, ticket.id);
}

/** True if the thread contains any human/agent reply (author_kind === "agent"). */
async function hasHumanAgentReply(store: SupportTicketStore, ticketId: string): Promise<boolean> {
	const thread = await collectThread(store, ticketId);
	return thread.some((message) => message.authorKind === "agent");
}

/** Deep link the email/in-app CTA points at. Relative — the frontend routes it. */
function ticketLink(ticketId: string): string {
	return `/support/tickets/${ticketId}`;
}

/**
 * Fire every notification best-effort. notify() is already internally
 * best-effort, but we still .catch() the promise so an unexpected throw never
 * surfaces as an unhandled rejection and never fails the HTTP request.
 */
function fireNotifications(notify: NotifyFn, inputs: NotifyInput[]): void {
	for (const input of inputs) {
		notify(input).catch((error) => {
			console.warn(`[support-tickets] notify(${input.type}) failed: ${describeError(error)}`);
		});
	}
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Run `mw` only for the given HTTP method, otherwise pass through. Lets us mount
 * a limiter on a path (`/tickets`) without it also throttling other methods on
 * that same path (e.g. GET /tickets, which is a cheap owner-scoped list).
 */
function createMethodGate(method: string, mw: MiddlewareHandler): MiddlewareHandler {
	return async (c, next) => {
		if (c.req.method !== method) return next();
		return mw(c, next);
	};
}

function requireUser(c: any): { userId: string } {
	const user = getAuthUser(c) as { userId: string } | undefined;
	if (!user) {
		throw new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}
	return user;
}

function notFound(c: any): Response {
	// 404 (not 403) for someone else's ticket: never confirm it exists.
	return c.json({ error: "Ticket not found", code: "ticket_not_found" }, 404);
}

function errorResponse(c: any, error: unknown): Response {
	if (error instanceof Response) return error;
	if (error instanceof SupportTicketStoreError) {
		const status = error.code.startsWith("ticket_invalid")
			|| error.code.startsWith("message_invalid")
			? 400
			: error.code === "ticket_not_found"
				? 404
				: 500;
		return c.json({ error: error.message, code: error.code }, status);
	}
	throw error;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const supportTickets = createSupportTicketsRouter();
