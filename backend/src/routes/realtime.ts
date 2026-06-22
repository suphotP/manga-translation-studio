// Realtime SSE endpoints (Wave 2 W2.7 Phase 1).
//
//   POST /api/realtime/token            → mint a short-lived SSE token
//   GET  /api/realtime/workspaces/:wsId/events   → SSE stream of workspace events
//
// SSE design:
//   - EventSource cannot attach an Authorization header, so the connect handshake
//     authenticates with a query-param token (?token=...) minted by the token
//     endpoint via the regular JWT-authed API.
//   - The connection is workspace-scoped: the token carries the wsId, and the
//     path wsId must match. We also re-check workspace membership on connect so
//     a revoked member can't reuse a still-valid token.
//   - Keep-alive: a comment-line ":keep-alive\n\n" every SSE_KEEPALIVE_SEC
//     seconds prevents idle proxies from closing the socket.
//   - Idle timeout: after SSE_IDLE_TIMEOUT_SEC the server closes the stream so
//     the EventSource client reconnects (refresh load balancer / process state).
//   - Replay: the client may send Last-Event-ID (header) or pass ?lastEventId=
//     to resume from a position in the workspace stream. Phase 1 backs the
//     stream with Redis Streams (XADD/XREAD) for replay so a brief disconnect
//     does not lose events. In-memory fallback (test/dev) also supports replay.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import { isPlatformAdmin } from "../types/auth.js";
import { readJsonBody } from "../utils/request-body.js";
import { mintRealtimeToken, verifyRealtimeToken } from "../services/realtime-token.js";
import {
	getRealtimeBus,
	publishRealtimeEvent,
	readSseIdleTimeoutSec,
	readSseKeepaliveSec,
	userScopedChannel,
	type RealtimeEvent,
} from "../services/realtime-bus.js";
import { workspaceAccessStore, WorkspaceAccessError } from "../services/workspace-access.js";
import { rateLimit } from "../middleware/rate-limit.js";

const realtime = new Hono();

// ── POST /api/realtime/token ─────────────────────────────────
// Requires the regular JWT. Verifies workspace membership and returns a
// short-lived signed SSE token suitable for embedding in an EventSource URL.

const tokenRequestSchema = z.object({
	workspaceId: z.string().trim().min(1).max(200),
}).strict();

realtime.post("/token", authMiddleware, async (c) => {
	const user = getAuthUser(c);
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = tokenRequestSchema.safeParse(raw.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const { workspaceId } = parsed.data;

	if (workspaceAccessStore) {
		try {
			await workspaceAccessStore.requirePermission(workspaceId, user.userId, "read_workspace");
		} catch (error) {
			if (error instanceof WorkspaceAccessError) {
				return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
			}
			throw error;
		}
	}
	// When workspaceAccessStore is unavailable (prototype/file mode) we fall back
	// to trust-the-JWT: any authenticated user can subscribe to the workspace
	// they ask for. This matches the prototype posture of file-mode workspaces
	// and is documented in the realtime-bus comment above.

	const minted = mintRealtimeToken({ userId: user.userId, workspaceId });
	return c.json({
		token: minted.token,
		expiresAt: new Date(minted.expiresAt).toISOString(),
		expiresAtMs: minted.expiresAt,
	});
});

// ── GET /api/realtime/workspaces/:wsId/events ────────────────
// The SSE long-poll endpoint. Streams workspace events to a subscribed
// EventSource. Validates the SSE token (?token=) against the path wsId and
// re-checks workspace membership so a revoked member is blocked even with a
// still-valid token.

realtime.get("/workspaces/:wsId/events", async (c) => {
	const wsId = c.req.param("wsId");
	if (!wsId?.trim()) return c.json({ error: "invalid_workspace_id" }, 400);

	const tokenFromQuery = c.req.query("token");
	const tokenFromHeader = c.req.header("X-Realtime-Token");
	const token = tokenFromQuery?.trim() || tokenFromHeader?.trim() || "";
	if (!token) return c.json({ error: "missing_sse_token" }, 401);

	const payload = verifyRealtimeToken(token);
	if (!payload) return c.json({ error: "invalid_or_expired_sse_token" }, 401);
	if (payload.ws !== wsId) return c.json({ error: "workspace_mismatch" }, 403);

	// Re-verify workspace membership on connect when the access store is
	// available; tokens are short-lived but a revoked member must be cut off
	// even within the token TTL window.
	if (workspaceAccessStore) {
		try {
			await workspaceAccessStore.requirePermission(wsId, payload.sub, "read_workspace");
		} catch (error) {
			if (error instanceof WorkspaceAccessError) {
				return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
			}
			throw error;
		}
	}

	// Last-Event-ID: standard SSE replay cursor. EventSource sets the header on
	// reconnect; we also accept the same value via ?lastEventId= for clients
	// that can't influence the EventSource headers.
	const lastEventIdHeader = c.req.header("Last-Event-ID")?.trim();
	const lastEventIdQuery = c.req.query("lastEventId")?.trim();
	const lastEventId = lastEventIdHeader || lastEventIdQuery;

	const bus = getRealtimeBus();
	const keepaliveSec = readSseKeepaliveSec();
	const configuredIdleTimeoutSec = readSseIdleTimeoutSec();

	// The realtime token's `exp` (JWT seconds) is the hard upper bound on this
	// stream's lifetime: once the token would no longer verify, the connection
	// must end so the client re-mints a token (which re-checks membership) before
	// reconnecting. A revoked member therefore cannot keep an authenticated stream
	// alive past the short token TTL. Cap the idle window to whatever is left on
	// the token so we never out-live `exp`.
	const tokenExpiryMs = typeof payload.exp === "number" ? payload.exp * 1000 : null;
	const msUntilTokenExpiry = tokenExpiryMs !== null ? tokenExpiryMs - Date.now() : null;
	const idleTimeoutSec = msUntilTokenExpiry !== null && msUntilTokenExpiry > 0
		? Math.max(1, Math.min(configuredIdleTimeoutSec, Math.ceil(msUntilTokenExpiry / 1000)))
		: configuredIdleTimeoutSec;

	// How often to re-verify the member still has access on a long-lived stream so
	// a mid-stream revocation is cut off (not just blocked at connect). Bounded so
	// a short stream re-checks at least once before it ends.
	const REVOCATION_RECHECK_SEC = Math.max(5, Math.min(idleTimeoutSec, 30));

	const abortController = new AbortController();
	c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

	// Two subscriptions are merged into this one SSE stream:
	//   (1) the SHARED workspace channel — workspace-wide events (locks, AI status,
	//       comments, workflow, presence). Replayable via Last-Event-ID.
	//   (2) the authenticated subscriber's PER-USER channel — PRIVATE notification
	//       fan-out addressed to THIS user only (a16 re-review P1 #1). It is a
	//       separate channel, so another member's notification frame is never
	//       published here and can never be read off the wire. Live-only (tail):
	//       a notification missed during a disconnect is recovered by the REST list
	//       + 30s poll, which stays the durable path. We never replay the per-user
	//       channel from the workspace `lastEventId` (different stream / id space).
	const subscription = bus.subscribe(wsId, {
		lastEventId,
		signal: abortController.signal,
	});
	const userChannel = userScopedChannel(wsId, payload.sub);
	const userSubscription = bus.subscribe(userChannel, {
		// tail-only; private notifications are delivered live, poll reconciles misses.
		signal: abortController.signal,
	});

	return streamSSE(c, async (stream) => {
		// Initial keep-alive so the client gets a fast TTFB and confirms the
		// stream is live.
		await stream.write(`:connected ws=${wsId}\n\n`);

		const keepaliveTimer = setInterval(() => {
			void stream.write(`:keep-alive\n\n`).catch(() => {/* socket closed */});
		}, keepaliveSec * 1000);
		(keepaliveTimer as { unref?: () => void }).unref?.();

		const idleTimer = setTimeout(() => {
			// Force the client to reconnect after the idle window so a long-lived
			// hung stream doesn't hold a backend goroutine forever. The window is
			// capped to the token's remaining TTL above, so this also fires no later
			// than the token `exp` — the client must re-mint (and so re-pass the
			// membership check) to continue.
			void stream.writeSSE({
				event: "server_idle_timeout",
				data: JSON.stringify({ reason: "idle_timeout_reached", reconnect: true }),
			}).catch(() => {/* ignore */});
			subscription.close();
			abortController.abort();
		}, idleTimeoutSec * 1000);
		(idleTimer as { unref?: () => void }).unref?.();

		// Periodically re-verify membership/permission so a member revoked AFTER the
		// stream opened is cut off mid-stream rather than only at connect. Tokens are
		// short-lived but can be re-minted; this guards the case where access is
		// pulled inside an active connection. No-op when the access store is
		// unavailable (file/prototype mode trusts the JWT, matching the connect path).
		const revocationTimer = workspaceAccessStore
			? setInterval(() => {
				void (async () => {
					try {
						await workspaceAccessStore!.requirePermission(wsId, payload.sub, "read_workspace");
					} catch {
						void stream.writeSSE({
							event: "server_revoked",
							data: JSON.stringify({ reason: "membership_revoked", reconnect: false }),
						}).catch(() => {/* ignore */});
						subscription.close();
						abortController.abort();
					}
				})();
			}, REVOCATION_RECHECK_SEC * 1000)
			: null;
		if (revocationTimer) (revocationTimer as { unref?: () => void }).unref?.();

		// Merge the two subscriptions (workspace + per-user) into a single ordered
		// write loop. We can't use one `for await` over both, so pump each iterator
		// and write whichever event resolves first. A per-event write always carries
		// the SOURCE event's own id/workspaceId so Last-Event-ID semantics for the
		// workspace stream are unchanged (the per-user channel rides as live frames).
		const writeEvent = async (event: RealtimeEvent): Promise<void> => {
			await stream.writeSSE({
				id: event.id,
				event: event.kind,
				data: JSON.stringify({
					id: event.id,
					kind: event.kind,
					workspaceId: event.workspaceId,
					emittedAt: event.emittedAt,
					data: event.data,
				}),
			});
		};

		const wsIterator = subscription[Symbol.asyncIterator]();
		const userIterator = userSubscription[Symbol.asyncIterator]();
		// Tag each pending next() so we know which iterator resolved and can re-arm it.
		type Pending = Promise<{ source: "ws" | "user"; result: IteratorResult<RealtimeEvent> }>;
		const armWs = (): Pending => wsIterator.next().then((result) => ({ source: "ws" as const, result }));
		const armUser = (): Pending => userIterator.next().then((result) => ({ source: "user" as const, result }));

		try {
			let wsPending: Pending | null = armWs();
			let userPending: Pending | null = armUser();
			while (wsPending || userPending) {
				if (stream.aborted || stream.closed) break;
				const racers: Pending[] = [];
				if (wsPending) racers.push(wsPending);
				if (userPending) racers.push(userPending);
				const winner = await Promise.race(racers);
				if (winner.source === "ws") {
					if (winner.result.done) {
						wsPending = null;
					} else {
						await writeEvent(winner.result.value);
						wsPending = armWs();
					}
				} else {
					if (winner.result.done) {
						userPending = null;
					} else {
						await writeEvent(winner.result.value);
						userPending = armUser();
					}
				}
			}
			// If EITHER subscription ended because the consumer fell too far behind,
			// tell the client explicitly so it can back off / reset rather than tight-
			// loop reconnecting. Each per-subscriber queue is independently capped above.
			const overflowReason = subscription.overflowReason ?? userSubscription.overflowReason;
			if (overflowReason) {
				await stream.writeSSE({
					event: "slow_consumer",
					data: JSON.stringify({ reason: overflowReason, reconnect: false }),
				}).catch(() => {/* socket dead */});
				abortController.abort();
			}
		} finally {
			clearInterval(keepaliveTimer);
			clearTimeout(idleTimer);
			if (revocationTimer) clearInterval(revocationTimer);
			subscription.close();
			userSubscription.close();
		}
	}, async (error, stream) => {
		console.error(`[Realtime] SSE error ws=${wsId}: ${error instanceof Error ? error.message : String(error)}`);
		try {
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
			});
		} catch {/* socket dead */}
	});
});

// ── Debug / dev helper: publish an event ─────────────────────
// Lets an operator inject a synthetic realtime event for UI smoke tests. This is
// a TRUSTED-STATE side channel — anything published here is fanned out to every
// subscriber as if it came from the real lock/AI/comment/workflow services — so
// it is locked down hard:
//   - hard-disabled unless SSE_DEBUG_PUBLISH_ENABLED=true (in EVERY env, not just
//     production) so it cannot be reached by default,
//   - requires a platform admin (owner/admin), not merely a workspace reader, so
//     an ordinary member cannot spoof trusted state,
//   - validates the payload PER KIND (not arbitrary `data`),
//   - rate-limited per user and audit-logged.

// Per-kind payload shapes. Each mirrors the field set the corresponding
// realtime-emitter publishes, so a debug event is indistinguishable in shape
// from a real one but cannot carry arbitrary/unexpected fields.
const lockPayloadSchema = z.object({
	lockId: z.string().trim().min(1).max(200),
	scope: z.string().trim().min(1).max(50),
	scopeId: z.string().trim().min(1).max(200),
	owner: z.string().trim().min(1).max(200).optional(),
	projectId: z.string().trim().min(1).max(200).optional(),
	expiresAt: z.union([z.string().trim().max(64), z.number()]).optional(),
}).strict();

const debugPublishSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("lock_acquired"), data: lockPayloadSchema }),
	z.object({ kind: z.literal("lock_released"), data: lockPayloadSchema }),
	z.object({
		kind: z.literal("ai_job_status"),
		data: z.object({
			jobId: z.string().trim().min(1).max(200),
			status: z.string().trim().min(1).max(50),
			projectId: z.string().trim().min(1).max(200).optional(),
		}).strict(),
	}),
	z.object({
		kind: z.literal("comment_new"),
		data: z.object({
			commentId: z.string().trim().min(1).max(200),
			threadId: z.string().trim().min(1).max(200).optional(),
			author: z.string().trim().min(1).max(200).optional(),
			excerpt: z.string().max(500).optional(),
		}).strict(),
	}),
	z.object({
		kind: z.literal("workflow_transition"),
		data: z.object({
			subjectKind: z.string().trim().min(1).max(50),
			subjectId: z.string().trim().min(1).max(200),
			from: z.string().trim().max(50),
			to: z.string().trim().max(50),
			by: z.string().trim().min(1).max(200).optional(),
			projectId: z.string().trim().min(1).max(200).optional(),
		}).strict(),
	}),
	z.object({
		kind: z.literal("activity_feed"),
		data: z.object({
			actor: z.string().trim().min(1).max(200).optional(),
			verb: z.string().trim().min(1).max(100),
		}).strict(),
	}),
	z.object({
		kind: z.literal("presence_ping"),
		data: z.object({
			userId: z.string().trim().min(1).max(200),
		}).strict(),
	}),
]);

/** Debug publish is reachable only when explicitly enabled, in every env. */
function isDebugPublishEnabled(): boolean {
	return process.env.SSE_DEBUG_PUBLISH_ENABLED === "true";
}

realtime.post(
	"/workspaces/:wsId/debug/publish",
	authMiddleware,
	rateLimit({
		windowMs: 60_000,
		maxRequests: 30,
		policyId: "realtime:debug-publish",
		keyFn: (c) => `realtime-debug:${getAuthUser(c)?.userId ?? "anon"}`,
	}),
	async (c) => {
		if (!isDebugPublishEnabled()) {
			return c.json({ error: "debug_publish_disabled" }, 404);
		}
		const user = getAuthUser(c);
		if (!user) return c.json({ error: "Unauthorized" }, 401);

		// Trusted-state injection requires a PLATFORM admin (owner/admin), not just a
		// workspace reader — a reader must never be able to spoof lock/AI/workflow
		// state to other members.
		if (!isPlatformAdmin(user.role)) {
			return c.json({ error: "forbidden", code: "platform_admin_required" }, 403);
		}

		const wsId = c.req.param("wsId");
		if (!wsId?.trim()) return c.json({ error: "invalid_workspace_id" }, 400);

		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = debugPublishSchema.safeParse(raw.data);
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}

		console.warn(
			`[Realtime][AUDIT] debug publish ws=${wsId} kind=${parsed.data.kind} by=${user.userId} role=${user.role}`,
		);

		const event = await publishRealtimeEvent(wsId, parsed.data.kind, parsed.data.data);
		return c.json({ ok: true, event });
	},
);

export { realtime };
