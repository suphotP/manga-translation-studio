// Realtime SSE client (W2.7 Phase 1).
//
// Owns the workspace-scoped EventSource lifecycle:
//   1. POST /api/realtime/token → short-lived signed token (60s default)
//   2. EventSource(/api/realtime/workspaces/:wsId/events?token=...)
//   3. Dispatches typed events to subscribers (locks, comments, activity,
//      ai job status, presence, workflow transitions)
//   4. Reconnects with exponential backoff + jitter on transient errors
//   5. Replays missed events via Last-Event-ID (passed as ?lastEventId= since
//      EventSource cannot set headers)
//
// Phase-1 scope: NO CRDT, NO live cursors. Only fan-out of state-change events.

import { config } from "$lib/config.js";
import { authStore } from "$lib/stores/auth.svelte.ts";

export type RealtimeEventKind =
	| "activity_feed"
	| "ai_job_status"
	| "comment_new"
	| "lock_acquired"
	| "lock_released"
	| "page_set_changed"
	| "workflow_transition"
	| "presence_ping"
	// In-app notification fan-out (W2.7): a freshly-created notification for a
	// member of THIS workspace. Carries the target userId so consumers deliver it
	// to that user only. Drives the live topbar bell instead of the 30s poll.
	| "notification_new"
	| "project_meta_changed";

export interface RealtimeEvent<T = Record<string, unknown>> {
	id: string;
	kind: RealtimeEventKind;
	workspaceId: string;
	emittedAt: number;
	data: T;
}

export type RealtimeListener = (event: RealtimeEvent) => void;

export type RealtimeConnectionStatus =
	| "idle"
	| "connecting"
	| "open"
	| "reconnecting"
	| "error"
	| "closed"
	// Terminal: the realtime backend is not configured for this deployment
	// (token endpoint 404/501). We stop reconnecting so an unconfigured
	// file-mode/dev server doesn't spin a perpetual token-fetch retry loop.
	| "unavailable";

// Error carrying the HTTP status from a failed token mint, so the connection
// loop can tell a terminal "feature not configured" (404/501) apart from a
// transient failure (5xx, network) that's worth retrying.
class RealtimeTokenError extends Error {
	constructor(message: string, readonly status: number | null) {
		super(message);
		this.name = "RealtimeTokenError";
	}
}

interface BackoffState {
	attempt: number;
	nextDelayMs: number;
}

const BACKOFF_STEPS_MS = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000] as const;
const MAX_BACKOFF_MS = 30000;

function backoffDelayForAttempt(attempt: number): number {
	const step = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)] ?? MAX_BACKOFF_MS;
	// Full jitter — randomize within [step/2, step] so a thundering herd of
	// reconnecting clients doesn't slam the server simultaneously.
	const min = Math.max(50, Math.floor(step / 2));
	return min + Math.floor(Math.random() * (step - min + 1));
}

class RealtimeStore {
	connected = $state(false);
	status = $state<RealtimeConnectionStatus>("idle");
	lastEvent = $state<RealtimeEvent | null>(null);
	lastEventId = $state<string | null>(null);
	eventCount = $state(0);
	error = $state<string | null>(null);
	workspaceId = $state<string | null>(null);

	private source: EventSource | null = null;
	private connectAbort: AbortController | null = null;
	private listenersByKind: Map<RealtimeEventKind, Set<RealtimeListener>> = new Map();
	private allListeners = new Set<RealtimeListener>();
	private backoff: BackoffState = { attempt: 0, nextDelayMs: BACKOFF_STEPS_MS[0] };
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private currentToken: string | null = null;
	// Per-workspace replay cursor. The visible `lastEventId` mirrors the cursor
	// for the CURRENTLY connected workspace, but a replay cursor from workspace A
	// must never be sent to workspace B (an unknown/foreign id replays the whole
	// buffer in memory mode and can surface stale events in Redis mode). Keying
	// the cursor by workspace keeps each stream's resume point isolated.
	private cursorByWorkspace = new Map<string, string>();

	get isConnected(): boolean {
		return this.connected;
	}

	on(kind: RealtimeEventKind, listener: RealtimeListener): () => void {
		const existing = this.listenersByKind.get(kind) ?? new Set<RealtimeListener>();
		existing.add(listener);
		this.listenersByKind.set(kind, existing);
		return () => {
			const set = this.listenersByKind.get(kind);
			if (!set) return;
			set.delete(listener);
			if (set.size === 0) this.listenersByKind.delete(kind);
		};
	}

	onAny(listener: RealtimeListener): () => void {
		this.allListeners.add(listener);
		return () => this.allListeners.delete(listener);
	}

	async connect(workspaceId: string): Promise<void> {
		if (!workspaceId?.trim()) return;
		// Idempotent for the SAME workspace. Once a connection attempt is underway,
		// the internal connect → error → scheduleReconnect loop owns the lifecycle.
		// The WorkspaceShell $effect re-runs connect() on every realtime status flip;
		// if we tore down + reset backoff on each of those reactive re-calls, the
		// exponential backoff would never accumulate and a failing mint would storm
		// the server (observed >500 req/s in file-mode). So for the same workspace we
		// only (re)start from a genuinely stopped state (idle/closed); connecting,
		// open, reconnecting, error, and the terminal "unavailable" are left alone.
		if (this.workspaceId === workspaceId && this.status !== "idle" && this.status !== "closed") {
			return;
		}
		this.disconnect();
		this.workspaceId = workspaceId;
		this.status = "connecting";
		this.error = null;
		this.connectAbort = new AbortController();
		// Resume from THIS workspace's own cursor only. Mirror it into the visible
		// `lastEventId` so reads reflect the active stream and a foreign cursor is
		// never replayed against the wrong workspace.
		const resumeCursor = this.cursorByWorkspace.get(workspaceId);
		this.lastEventId = resumeCursor ?? null;
		await this.openConnection(workspaceId, resumeCursor);
	}

	disconnect(reason: "manual" | "auth_change" = "manual"): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.source) {
			try {
				this.source.close();
			} catch {/* ignore */}
			this.source = null;
		}
		if (this.connectAbort) {
			try {
				this.connectAbort.abort();
			} catch {/* ignore */}
			this.connectAbort = null;
		}
		this.connected = false;
		this.status = reason === "auth_change" ? "idle" : "closed";
		this.workspaceId = null;
		this.currentToken = null;
		this.backoff = { attempt: 0, nextDelayMs: BACKOFF_STEPS_MS[0] };
	}

	private async openConnection(workspaceId: string, lastEventId?: string): Promise<void> {
		// Snapshot the abort controller tied to THIS connection attempt so a teardown
		// (logout / account switch) that aborts the in-flight token fetch can be told
		// apart from a transient network error below.
		const abortSignal = this.connectAbort?.signal;
		try {
			const token = await this.mintToken(workspaceId);
			// A teardown (logout/account switch) or a workspace switch can land while
			// the token fetch is in flight. If so, abandon this attempt rather than
			// opening a stream for a workspace we are no longer subscribed to.
			if (abortSignal?.aborted || this.workspaceId !== workspaceId) {
				return;
			}
			this.currentToken = token;

			const url = new URL(`${config.apiBase}/realtime/workspaces/${encodeURIComponent(workspaceId)}/events`, window.location.origin);
			url.searchParams.set("token", token);
			if (lastEventId) url.searchParams.set("lastEventId", lastEventId);

			const source = new EventSource(url.toString());
			this.source = source;

			source.addEventListener("open", () => {
				this.connected = true;
				this.status = "open";
				this.error = null;
				this.backoff = { attempt: 0, nextDelayMs: BACKOFF_STEPS_MS[0] };
			});

			source.addEventListener("error", (ev) => {
				this.handleError(ev, workspaceId, source);
			});

			// Default "message" handler in case a server event arrives without a
			// named event type. We still try to parse it as JSON and dispatch.
			source.addEventListener("message", (ev) => {
				this.handleSseFrame(ev, undefined);
			});

			for (const kind of REALTIME_EVENT_KINDS) {
				source.addEventListener(kind, (ev) => {
					this.handleSseFrame(ev as MessageEvent, kind);
				});
			}

			source.addEventListener("server_idle_timeout", () => {
				// Ignore a frame from a stale source (replaced by a newer connect/reconnect
				// or after a workspace switch/teardown). Acting on it would reconnect for
				// the wrong/old workspace.
				if (this.source !== source || this.workspaceId !== workspaceId) return;
				// Server closed the stream because of idle timeout. Detach + close the
				// CURRENT source first so the browser-fired close/error that follows
				// this frame can't run handleError() against the freshly opened
				// replacement (which would close it and start an endless reconnect
				// cycle every idle timeout). Then reconnect immediately — this is
				// expected long-poll behavior.
				if (this.source) {
					try {
						this.source.close();
					} catch {/* ignore */}
					this.source = null;
				}
				this.connected = false;
				this.scheduleReconnect(workspaceId, 0);
			});
		} catch (error) {
			// Terminal cases — do NOT reconnect:
			//  (a) the token fetch was aborted by an auth-change/manual teardown, or
			//  (b) the active target has moved on (logout cleared it, or a switch
			//      pointed us at a different workspace) while we were awaiting.
			// Reconnecting here would let a logged-out tab retry forever, or re-mint
			// a stream for the previous user's workspace using the new session.
			const isAbort = (error instanceof DOMException && error.name === "AbortError")
				|| abortSignal?.aborted === true;
			const isStaleWorkspace = this.workspaceId !== workspaceId;
			if (isAbort || isStaleWorkspace) {
				return;
			}
			// Terminal client-side failures — do NOT reconnect. A 404 (channel /
			// route absent — e.g. an unconfigured realtime backend, or a workspace
			// the server doesn't know about), 501 (not implemented), or 401/403
			// (auth/permission) will never resolve by retrying. Reconnecting on
			// these spins a perpetual token-mint loop (observed at >500 req/s in
			// file-mode), so we mark the feature "unavailable" and stop.
			if (error instanceof RealtimeTokenError && error.status !== null
				&& [401, 403, 404, 501].includes(error.status)) {
				this.error = error.message;
				this.status = "unavailable";
				return;
			}
			this.error = error instanceof Error ? error.message : String(error);
			this.status = "error";
			this.scheduleReconnect(workspaceId);
		}
	}

	private handleSseFrame(ev: MessageEvent, kindHint: RealtimeEventKind | undefined): void {
		let payload: RealtimeEvent | null = null;
		try {
			const parsed = JSON.parse(ev.data) as Partial<RealtimeEvent> | undefined;
			if (parsed && parsed.kind) {
				payload = {
					id: parsed.id ?? ev.lastEventId ?? `${Date.now()}`,
					kind: parsed.kind as RealtimeEventKind,
					workspaceId: parsed.workspaceId ?? this.workspaceId ?? "",
					emittedAt: typeof parsed.emittedAt === "number" ? parsed.emittedAt : Date.now(),
					data: (parsed.data ?? {}) as Record<string, unknown>,
				};
			}
		} catch {/* fall through to hint-based dispatch */}

		if (!payload && kindHint) {
			payload = {
				id: ev.lastEventId || `${Date.now()}`,
				kind: kindHint,
				workspaceId: this.workspaceId ?? "",
				emittedAt: Date.now(),
				data: {},
			};
		}

		if (!payload) return;
		const cursor = ev.lastEventId || payload.id;
		this.lastEventId = cursor;
		// Persist the cursor under the event's own workspace so a later switch to a
		// different workspace never resumes from this id.
		const cursorWorkspace = payload.workspaceId || this.workspaceId;
		if (cursorWorkspace) this.cursorByWorkspace.set(cursorWorkspace, cursor);
		this.lastEvent = payload;
		this.eventCount += 1;
		this.dispatch(payload);
	}

	private dispatch(event: RealtimeEvent): void {
		for (const listener of this.listenersByKind.get(event.kind) ?? []) {
			try {
				listener(event);
			} catch (error) {
				console.error("[Realtime] listener error", error);
			}
		}
		for (const listener of this.allListeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("[Realtime] anyListener error", error);
			}
		}
	}

	private handleError(_event: Event, workspaceId: string, source?: EventSource): void {
		// Ignore callbacks fired by a STALE EventSource — one already replaced by a
		// newer connect()/reconnect, or left over after a workspace switch / teardown.
		// Without this guard a late "error" from the old source would close the CURRENT
		// source and schedule a reconnect for the wrong (old) workspace.
		if ((source && this.source !== source) || this.workspaceId !== workspaceId) {
			return;
		}
		this.connected = false;
		if (this.source) {
			try {
				this.source.close();
			} catch {/* ignore */}
			this.source = null;
		}
		this.status = "reconnecting";
		this.scheduleReconnect(workspaceId);
	}

	private scheduleReconnect(workspaceId: string, overrideDelayMs?: number): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const delay = overrideDelayMs ?? backoffDelayForAttempt(this.backoff.attempt);
		this.backoff = {
			attempt: this.backoff.attempt + 1,
			nextDelayMs: backoffDelayForAttempt(this.backoff.attempt + 1),
		};
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.openConnection(workspaceId, this.cursorByWorkspace.get(workspaceId));
		}, delay);
	}

	private async mintToken(workspaceId: string): Promise<string> {
		let response = await this.requestRealtimeToken(workspaceId);
		if (response.status === 401 && authStore.refreshToken) {
			// Unlike apiFetch-backed endpoints, this direct EventSource token mint
			// path must explicitly rotate an expired access token once before it
			// gives up; otherwise the reconnect loop sees only terminal 401s.
			const refreshed = await authStore.refreshSession();
			const aborted = this.connectAbort?.signal.aborted === true;
			if (refreshed && !aborted && this.workspaceId === workspaceId) {
				response = await this.requestRealtimeToken(workspaceId);
			}
		}
		if (!response.ok) {
			throw new RealtimeTokenError(`Failed to mint realtime token (${response.status})`, response.status);
		}
		const body = await response.json() as { token?: string };
		if (!body.token) throw new RealtimeTokenError("Realtime token endpoint returned no token", null);
		return body.token;
	}

	private requestRealtimeToken(workspaceId: string): Promise<Response> {
		const url = `${config.apiBase}/realtime/token`;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		const accessToken = authStore.accessToken;
		if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
		return fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ workspaceId }),
			// Bound the mint with a timeout (issue #4 FE-1): a hung token mint (backend/
			// DNS/Caddy slow) used to leave the stream stuck in "connecting" FOREVER —
			// the SSE never reconnected. A timeout makes the fetch REJECT so the existing
			// backoff re-arms and the stream recovers when the backend returns. Combined
			// with connectAbort so an explicit disconnect still cancels immediately.
			signal: this.connectTokenSignal(),
		});
	}

	/** connectAbort ∪ a 15s timeout, degrading gracefully where AbortSignal.any/
	 *  timeout aren't available (older runtimes / jsdom). */
	private connectTokenSignal(): AbortSignal | undefined {
		const base = this.connectAbort?.signal;
		const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
		const hasAny = typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function";
		if (!hasTimeout) return base;
		const timeoutSignal = AbortSignal.timeout(15000);
		if (!base) return timeoutSignal;
		return hasAny ? AbortSignal.any([base, timeoutSignal]) : base;
	}

	/** Recover from the terminal "unavailable" state so the next connect() will
	 * retry. Terminal-on-4xx (401/403/404/501) is what stops the self-DoS token
	 * storm, but those can legitimately become valid later — a token refresh, a
	 * membership grant, a workspace that gets (re)created, or a backend that was
	 * mid-rollout. Callers MUST invoke this only on DISCRETE app events (auth
	 * identity change, workspace-list reload) and NEVER from a reactive tick, so
	 * recovery can't reintroduce the retry loop. No-op unless currently
	 * "unavailable". The WorkspaceShell $effect re-runs on the resulting status
	 * change and re-establishes the stream. */
	revalidate(): void {
		if (this.status !== "unavailable") return;
		this.status = "idle";
		this.error = null;
		this.backoff = { attempt: 0, nextDelayMs: BACKOFF_STEPS_MS[0] };
	}

	__resetForTesting(): void {
		this.disconnect();
		this.lastEvent = null;
		this.lastEventId = null;
		this.eventCount = 0;
		this.error = null;
		this.cursorByWorkspace.clear();
		this.listenersByKind.clear();
		this.allListeners.clear();
	}
}

const REALTIME_EVENT_KINDS: RealtimeEventKind[] = [
	"activity_feed",
	"ai_job_status",
	"comment_new",
	"lock_acquired",
	"lock_released",
	"page_set_changed",
	"workflow_transition",
	"presence_ping",
	"notification_new",
	"project_meta_changed",
];

export const realtimeStore = new RealtimeStore();

// Hook: disconnect SSE on ANY auth-token change so the stream never outlives the
// session it was authenticated for. Logout (truthy → falsy) obviously must drop
// the stream, but an account switch (user A's token → user B's token) is just as
// important: the open EventSource was minted with the previous user's short-lived
// SSE token, and connect() no-ops for the same workspace while open, so without a
// forced disconnect the new user would keep receiving the previous user's events
// until the stream errors or idles out. Tearing down on every change makes the
// next connect() re-mint a token for the current session. The WorkspaceShell
// $effect (which reads authStore.accessToken) re-runs on the same change and
// re-establishes the stream for the still-authenticated case.
if (typeof window !== "undefined") {
	let lastAccess: string | null = null;
	queueMicrotask(() => {
		try {
			lastAccess = authStore.accessToken;
			// $effect.root is svelte-only; use a polling fallback that's cheap.
			setInterval(() => {
				const current = authStore.accessToken;
				if (current !== lastAccess) {
					lastAccess = current;
					realtimeStore.disconnect("auth_change");
				}
			}, 1500);
		} catch {/* SSR / no auth store yet */}
	});
}

export { backoffDelayForAttempt as __backoffDelayForAttemptForTesting };
