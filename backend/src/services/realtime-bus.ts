// Realtime event bus — workspace-scoped pub/sub + replay backed by Redis Streams.
//
// W2.7 Phase 1: SSE only (no CRDT, no live cursors).
//
// Topology:
//   - Each workspace gets a single Redis Stream: ws:<workspaceId>:events
//   - publishEvent() XADDs an envelope to the workspace stream so events are
//     replayable via Last-Event-ID and durable across multiple API replicas.
//   - SSE handlers subscribe by XREAD-ing the workspace stream from a cursor
//     (the "$" tail by default, or a specific Last-Event-ID for reconnect
//     replay).
//   - Stream length is capped (MAXLEN ~ N) so per-workspace history stays bounded.
//
// File/memory fallback:
//   - When REDIS_URL is unset (tests, local prototype) the bus uses an in-process
//     EventEmitter-like dispatch with a small ring buffer for replay so the SSE
//     surface still works for single-process dev/test runs.

import { RedisClient } from "bun";
import { randomUUID } from "crypto";

export type RealtimeEventKind =
	| "activity_feed"
	| "ai_job_status"
	| "comment_new"
	| "lock_acquired"
	| "lock_released"
	| "page_set_changed"
	| "workflow_transition"
	| "presence_ping"
	// W2.7 — in-app notification fan-out. Published on notification create so the
	// topbar bell updates live instead of waiting for the 30s poll.
	//
	// PRIVACY (a16 re-review P1 #1): a notification's title/body/metadata are the
	// recipient's PRIVATE per-user data. They must NEVER ride the shared workspace
	// stream (every workspace member subscribes to it and could read the frame off
	// the wire) — a frontend filter is NOT a privacy boundary. So `notification_new`
	// is published ONLY to the recipient's PER-USER channel (`userScopedChannel`),
	// and the SSE route subscribes a connection to its OWN per-user channel keyed on
	// the authenticated subscriber userId. A member therefore can never receive
	// another member's notification frame, server-side. Workspace-less (personal)
	// notifications are still poll-only (no workspace → no per-user channel either).
	| "notification_new"
	// A project/story TITLE or library-visible metadata change. WORKSPACE-shared
	// (not per-user) data, so it rides the shared workspace stream. The backend
	// already busts its caches on write (writeProjectState) — this is the PUSH half
	// so every member Library/Sidebar/Dashboard re-fetches the fresh title within
	// seconds instead of staying stale for the whole session.
	| "project_meta_changed";

export interface RealtimeEvent {
	/** Stable monotonic ID (Redis stream ID, or a synthetic id in memory mode). */
	id: string;
	/** Workspace this event is scoped to (route filter / channel key). */
	workspaceId: string;
	/** Event type — routed to a handler in the frontend store. */
	kind: RealtimeEventKind;
	/** ms since epoch. */
	emittedAt: number;
	/** Free-form payload (already trusted/sanitized by the caller). */
	data: Record<string, unknown>;
}

export interface RealtimeBusOptions {
	url?: string;
	keyPrefix?: string;
	/** Max number of events retained per workspace for replay. */
	streamMaxLen?: number;
}

const DEFAULT_KEY_PREFIX = "manga-editor:rt";

/**
 * Reads SSE_REPLAY_STREAM_LEN with a sane fallback.
 */
export function readRealtimeStreamMaxLen(): number {
	const raw = process.env.SSE_REPLAY_STREAM_LEN?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return 1000;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? Math.min(value, 100_000) : 1000;
}

/**
 * Reads SSE_KEEPALIVE_SEC with a sane fallback.
 */
export function readSseKeepaliveSec(): number {
	const raw = process.env.SSE_KEEPALIVE_SEC?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return 30;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 600) : 30;
}

/**
 * Reads SSE_IDLE_TIMEOUT_SEC with a sane fallback (10 min = 600s).
 */
export function readSseIdleTimeoutSec(): number {
	const raw = process.env.SSE_IDLE_TIMEOUT_SEC?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return 600;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 24 * 3600) : 600;
}

/**
 * Max number of events a single slow SSE subscriber may buffer before the
 * connection is force-closed with `slow_consumer`. Prevents one wedged client
 * from growing a per-connection queue without bound. Default 1000.
 */
export function readSseSubscriberMaxQueue(): number {
	const raw = process.env.SSE_SUBSCRIBER_MAX_QUEUE?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return 1000;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1_000_000) : 1000;
}

/**
 * Max total bytes a single slow SSE subscriber may buffer before the connection
 * is force-closed with `slow_consumer`. A second guard alongside the count cap so
 * a few very large payloads can't blow memory. Default 8 MiB.
 */
export function readSseSubscriberMaxBytes(): number {
	const raw = process.env.SSE_SUBSCRIBER_MAX_BYTES?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return 8 * 1024 * 1024;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1024 * 1024 * 1024) : 8 * 1024 * 1024;
}

/**
 * Reads SSE_TOKEN_TTL_SEC with a sane fallback (60s).
 */
export function readSseTokenTtlSec(): number {
	const raw = process.env.SSE_TOKEN_TTL_SEC?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return 60;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 3600) : 60;
}

/**
 * Max number of DISTINCT workspace replay buffers the in-memory bus retains.
 * Each buffer is already capped at maxLen events, but buffer ENTRIES were never
 * evicted, so every workspace that ever published kept one for the life of the
 * process (a slow per-workspace leak). Past this cap the oldest listener-free
 * buffers are dropped; a workspace with a live subscriber is never evicted, so
 * an active connection's replay window stays intact. Default 1000.
 */
export function readRealtimeMaxStreamBuffers(): number {
	const raw = process.env.REALTIME_MAX_STREAM_BUFFERS?.trim();
	if (!raw || !/^[1-9]\d*$/.test(raw)) return 1000;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1_000_000) : 1000;
}

export interface RealtimeBus {
	readonly kind: "memory" | "redis";
	publish(workspaceId: string, event: Omit<RealtimeEvent, "id" | "emittedAt" | "workspaceId"> & { workspaceId?: string }): Promise<RealtimeEvent>;
	subscribe(workspaceId: string, options: SubscribeOptions): RealtimeSubscription;
}

export interface SubscribeOptions {
	/** "$" = only new events; otherwise a Redis stream ID for replay. */
	lastEventId?: string;
	signal?: AbortSignal;
}

export interface RealtimeSubscription {
	[Symbol.asyncIterator](): AsyncIterator<RealtimeEvent>;
	close(): void;
	/**
	 * Set when the subscription was force-closed because the consumer fell too far
	 * behind (per-subscriber count/byte cap exceeded). The SSE handler reads this
	 * after the iterator ends so it can emit a `slow_consumer` close frame instead
	 * of a clean idle close. `null` for a normal close.
	 */
	readonly overflowReason: string | null;
}

/** Cheap byte estimate of an event for the per-subscriber byte cap. */
function estimateEventBytes(event: RealtimeEvent): number {
	try {
		return Buffer.byteLength(JSON.stringify(event.data ?? {}), "utf8") + 64;
	} catch {
		return 64;
	}
}

// ── In-memory bus ─────────────────────────────────────────────

class InMemoryRealtimeBus implements RealtimeBus {
	readonly kind = "memory" as const;
	private readonly streams = new Map<string, RealtimeEvent[]>();
	private readonly listeners = new Map<string, Set<(event: RealtimeEvent) => void>>();
	private readonly maxLen: number;
	private readonly maxQueue: number;
	private readonly maxQueueBytes: number;
	private readonly maxStreamBuffers: number;
	private sequence = 0;

	constructor(maxLen: number) {
		this.maxLen = maxLen;
		this.maxQueue = readSseSubscriberMaxQueue();
		this.maxQueueBytes = readSseSubscriberMaxBytes();
		this.maxStreamBuffers = readRealtimeMaxStreamBuffers();
	}

	async publish(workspaceId: string, input: Omit<RealtimeEvent, "id" | "emittedAt" | "workspaceId"> & { workspaceId?: string }): Promise<RealtimeEvent> {
		this.sequence += 1;
		const event: RealtimeEvent = {
			id: `${Date.now()}-${this.sequence}`,
			workspaceId,
			emittedAt: Date.now(),
			kind: input.kind,
			data: input.data,
		};
		const buffer = this.streams.get(workspaceId) ?? [];
		buffer.push(event);
		if (buffer.length > this.maxLen) buffer.splice(0, buffer.length - this.maxLen);
		// delete+set keeps the Map's insertion order as a recency order (stalest
		// first), so the eviction sweep below can walk cold buffers from the front.
		this.streams.delete(workspaceId);
		this.streams.set(workspaceId, buffer);
		this.evictStaleStreamBuffers();
		for (const listener of this.listeners.get(workspaceId) ?? []) {
			try {
				listener(event);
			} catch (error) {
				console.error(`[Realtime] listener error: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return event;
	}

	/**
	 * Bound the number of per-workspace replay buffers. Without this, every
	 * workspace that ever published retained a maxLen-capped buffer for the life
	 * of the process. Walks stalest-first (publish refreshes recency via
	 * delete+set) and drops only buffers with no live subscriber, so an active
	 * connection's Last-Event-ID replay window is never pulled out from under it.
	 * An evicted workspace simply loses replay: a reconnecting client falls back
	 * to the SSE handler's fresh-snapshot path, same as any expired cursor.
	 */
	private evictStaleStreamBuffers(): void {
		if (this.streams.size <= this.maxStreamBuffers) return;
		for (const workspaceId of this.streams.keys()) {
			if (this.streams.size <= this.maxStreamBuffers) return;
			if ((this.listeners.get(workspaceId)?.size ?? 0) > 0) continue;
			this.streams.delete(workspaceId);
		}
	}

	subscribe(workspaceId: string, options: SubscribeOptions): RealtimeSubscription {
		const queue: RealtimeEvent[] = [];
		let queueBytes = 0;
		let waiter: ((value: IteratorResult<RealtimeEvent>) => void) | null = null;
		let closed = false;
		let overflowReason: string | null = null;
		const maxQueue = this.maxQueue;
		const maxQueueBytes = this.maxQueueBytes;

		const replayed = this.replayFrom(workspaceId, options.lastEventId);
		for (const event of replayed) {
			queue.push(event);
			queueBytes += estimateEventBytes(event);
		}

		const onEvent = (event: RealtimeEvent): void => {
			if (closed) return;
			if (waiter) {
				const resolve = waiter;
				waiter = null;
				resolve({ value: event, done: false });
				return;
			}
			queue.push(event);
			queueBytes += estimateEventBytes(event);
			// Slow consumer: the iterator isn't draining fast enough and the buffer
			// has grown past its cap. Drop the connection rather than let one wedged
			// client grow an unbounded per-subscriber queue.
			if (queue.length > maxQueue || queueBytes > maxQueueBytes) {
				overflowReason = "slow_consumer";
				close();
			}
		};

		const listeners = this.listeners.get(workspaceId) ?? new Set<(event: RealtimeEvent) => void>();
		listeners.add(onEvent);
		this.listeners.set(workspaceId, listeners);

		const close = (): void => {
			if (closed) return;
			closed = true;
			listeners.delete(onEvent);
			// Drop the per-workspace Set entry once the last subscriber leaves so the
			// listeners map doesn't accumulate one empty Set per workspace ever seen.
			// The identity guard avoids a stale closure deleting a FRESH Set installed
			// after this entry was removed and the workspace re-subscribed.
			if (listeners.size === 0 && this.listeners.get(workspaceId) === listeners) {
				this.listeners.delete(workspaceId);
				// This close may have UNPINNED a buffer that publish-time eviction had
				// to skip. Re-run the sweep here, or a fleet of publish-once workspaces
				// whose subscribers disconnect and go quiet would stay above the cap
				// until some unrelated future publish (codex review P2).
				this.evictStaleStreamBuffers();
			}
			if (waiter) {
				const resolve = waiter;
				waiter = null;
				resolve({ value: undefined, done: true });
			}
		};

		options.signal?.addEventListener("abort", close, { once: true });

		return {
			close,
			get overflowReason(): string | null {
				return overflowReason;
			},
			[Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
				return {
					async next(): Promise<IteratorResult<RealtimeEvent>> {
						// On slow-consumer overflow, end immediately — don't drain the
						// over-cap backlog; the handler emits a `slow_consumer` close.
						if (overflowReason) return { value: undefined as unknown as RealtimeEvent, done: true };
						if (queue.length > 0) {
							const value = queue.shift() as RealtimeEvent;
							queueBytes -= estimateEventBytes(value);
							if (queueBytes < 0) queueBytes = 0;
							return { value, done: false };
						}
						if (closed) return { value: undefined as unknown as RealtimeEvent, done: true };
						return new Promise<IteratorResult<RealtimeEvent>>((resolve) => {
							waiter = resolve;
						});
					},
					async return(): Promise<IteratorResult<RealtimeEvent>> {
						close();
						return { value: undefined as unknown as RealtimeEvent, done: true };
					},
				};
			},
		};
	}

	private replayFrom(workspaceId: string, lastEventId: string | undefined): RealtimeEvent[] {
		if (!lastEventId || lastEventId === "$") return [];
		const buffer = this.streams.get(workspaceId) ?? [];
		const cutoff = compareMemoryStreamIds(lastEventId, buffer);
		if (cutoff < 0) return [...buffer];
		return buffer.slice(cutoff + 1);
	}
}

function compareMemoryStreamIds(targetId: string, buffer: RealtimeEvent[]): number {
	for (let index = 0; index < buffer.length; index += 1) {
		if (buffer[index]!.id === targetId) return index;
	}
	return -1;
}

// ── Redis-backed bus ──────────────────────────────────────────

class RedisRealtimeBus implements RealtimeBus {
	readonly kind = "redis" as const;
	private readonly client: RedisClient;
	private readonly url?: string;
	private readonly keyPrefix: string;
	private readonly maxLen: number;
	private readonly maxQueue: number;
	private readonly maxQueueBytes: number;

	constructor(options: { url?: string; keyPrefix: string; maxLen: number }) {
		this.url = options.url?.trim() || undefined;
		this.client = this.url ? new RedisClient(this.url) : new RedisClient();
		this.keyPrefix = options.keyPrefix;
		this.maxLen = options.maxLen;
		this.maxQueue = readSseSubscriberMaxQueue();
		this.maxQueueBytes = readSseSubscriberMaxBytes();
	}

	/**
	 * Create a fresh Redis connection for a single subscription's blocking reads.
	 * A blocking command (XREAD BLOCK) holds its connection for the whole block
	 * window, so sharing one client across subscribers serializes their reads and
	 * delays fan-out by up to the block window per quiet subscriber. Each
	 * subscription therefore gets its own dedicated client.
	 */
	private createSubscriberClient(): RedisClient {
		return this.url ? new RedisClient(this.url) : new RedisClient();
	}

	private streamKey(workspaceId: string): string {
		return `${this.keyPrefix}:ws:${workspaceId}:events`;
	}

	/**
	 * Resolve the "$" tail to the stream's concrete current last-ID so subsequent
	 * blocking reads advance from a stable cursor (Redis only guarantees "$" for
	 * the first call). Uses XINFO STREAM's `last-generated-id`. If the stream does
	 * not exist yet (XINFO errors) the stream is empty, so there is no history to
	 * replay — start from "0" to catch the first event that arrives.
	 */
	private async resolveTailCursor(client: RedisClient, streamKey: string): Promise<string> {
		try {
			const info = await client.send("XINFO", ["STREAM", streamKey]);
			const lastId = readXinfoField(info, "last-generated-id");
			if (lastId) return lastId;
		} catch {
			// Stream missing/empty — fall through.
		}
		return "0";
	}

	async publish(workspaceId: string, input: Omit<RealtimeEvent, "id" | "emittedAt" | "workspaceId"> & { workspaceId?: string }): Promise<RealtimeEvent> {
		const emittedAt = Date.now();
		const envelope = {
			kind: input.kind,
			emittedAt,
			data: input.data,
		};
		const args = [
			this.streamKey(workspaceId),
			"MAXLEN",
			"~",
			String(this.maxLen),
			"*",
			"payload",
			JSON.stringify(envelope),
		];
		const id = await this.client.send("XADD", args);
		return {
			id: String(id ?? `${emittedAt}-0`),
			workspaceId,
			emittedAt,
			kind: input.kind,
			data: input.data,
		};
	}

	subscribe(workspaceId: string, options: SubscribeOptions): RealtimeSubscription {
		const queue: RealtimeEvent[] = [];
		let queueBytes = 0;
		let waiter: ((value: IteratorResult<RealtimeEvent>) => void) | null = null;
		let closed = false;
		let overflowReason: string | null = null;
		const maxQueue = this.maxQueue;
		const maxQueueBytes = this.maxQueueBytes;
		let cursor = options.lastEventId && options.lastEventId !== "$" ? options.lastEventId : "$";
		const streamKey = this.streamKey(workspaceId);
		// Dedicated connection so this subscriber's blocking XREAD never queues
		// behind another workspace's blocking read on a shared client.
		const subClient = this.createSubscriberClient();

		const close = (): void => {
			if (closed) return;
			closed = true;
			try {
				subClient.close();
			} catch {/* already closed */}
			if (waiter) {
				const resolve = waiter;
				waiter = null;
				resolve({ value: undefined as unknown as RealtimeEvent, done: true });
			}
		};

		options.signal?.addEventListener("abort", close, { once: true });

		const loop = async (): Promise<void> => {
			// "$" means "only events added AFTER this call" and is, per the Redis
			// docs, valid only for the FIRST XREAD — reusing it on every loop would
			// drop events that land in the gap after a BLOCK timeout and before the
			// next call. Resolve the tail to the stream's concrete last-ID once up
			// front so every subsequent read advances from a stable cursor.
			if (cursor === "$") {
				cursor = await this.resolveTailCursor(subClient, streamKey);
				if (closed) return;
			}
			while (!closed) {
				try {
					// XREAD BLOCK 5000 COUNT 100 STREAMS <key> <cursor>
					const result = await subClient.send("XREAD", [
						"BLOCK",
						"5000",
						"COUNT",
						"100",
						"STREAMS",
						streamKey,
						cursor,
					]);
					if (closed) return;
					const events = parseXreadEvents(result, workspaceId);
					for (const event of events) {
						cursor = event.id;
						if (waiter) {
							const resolve = waiter;
							waiter = null;
							resolve({ value: event, done: false });
						} else {
							queue.push(event);
							queueBytes += estimateEventBytes(event);
							// Slow consumer: drop the connection rather than buffer past
							// the per-subscriber cap. The dedicated subClient is closed so
							// the blocking XREAD stops and Redis frees the connection.
							if (queue.length > maxQueue || queueBytes > maxQueueBytes) {
								overflowReason = "slow_consumer";
								close();
								return;
							}
						}
					}
				} catch (error) {
					if (closed) return;
					console.error(`[Realtime] XREAD error for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}
		};

		void loop();

		return {
			close,
			get overflowReason(): string | null {
				return overflowReason;
			},
			[Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
				return {
					async next(): Promise<IteratorResult<RealtimeEvent>> {
						// On slow-consumer overflow, end immediately so the handler can
						// emit a `slow_consumer` close instead of draining the backlog.
						if (overflowReason) return { value: undefined as unknown as RealtimeEvent, done: true };
						if (queue.length > 0) {
							const value = queue.shift() as RealtimeEvent;
							queueBytes -= estimateEventBytes(value);
							if (queueBytes < 0) queueBytes = 0;
							return { value, done: false };
						}
						if (closed) return { value: undefined as unknown as RealtimeEvent, done: true };
						return new Promise<IteratorResult<RealtimeEvent>>((resolve) => {
							waiter = resolve;
						});
					},
					async return(): Promise<IteratorResult<RealtimeEvent>> {
						close();
						return { value: undefined as unknown as RealtimeEvent, done: true };
					},
				};
			},
		};
	}
}

function parseXreadEvents(raw: unknown, workspaceId: string): RealtimeEvent[] {
	if (!raw) return [];
	// XREAD response shape: [ [streamKey, [ [id, [field, value, ...]], ... ]], ... ]
	const streams = Array.isArray(raw) ? raw : (typeof raw === "object" ? Object.values(raw as Record<string, unknown>).map((entries, index) => [Object.keys(raw as Record<string, unknown>)[index], entries]) : []);
	const events: RealtimeEvent[] = [];
	for (const stream of streams) {
		if (!Array.isArray(stream) || stream.length < 2) continue;
		const entries = stream[1];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!Array.isArray(entry) || entry.length < 2) continue;
			const id = String(entry[0]);
			const fields = entry[1];
			const payloadString = readPayloadField(fields);
			if (!payloadString) continue;
			try {
				const envelope = JSON.parse(payloadString) as { kind?: RealtimeEventKind; emittedAt?: number; data?: Record<string, unknown> };
				if (!envelope.kind) continue;
				events.push({
					id,
					workspaceId,
					kind: envelope.kind,
					emittedAt: typeof envelope.emittedAt === "number" ? envelope.emittedAt : Date.now(),
					data: envelope.data ?? {},
				});
			} catch (error) {
				console.warn(`[Realtime] failed to parse stream entry ${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return events;
}

/**
 * Read a named field from an XINFO STREAM reply. Bun's RedisClient may surface
 * the reply as a flat [field, value, ...] array (RESP2) or as an object
 * (RESP3 map) depending on protocol/version, so handle both shapes.
 */
function readXinfoField(info: unknown, field: string): string | null {
	if (Array.isArray(info)) {
		for (let index = 0; index < info.length - 1; index += 2) {
			if (String(info[index]) === field) {
				const value = info[index + 1];
				return value === undefined || value === null ? null : String(value);
			}
		}
		return null;
	}
	if (info && typeof info === "object") {
		const value = (info as Record<string, unknown>)[field];
		return value === undefined || value === null ? null : String(value);
	}
	return null;
}

function readPayloadField(fields: unknown): string | null {
	if (Array.isArray(fields)) {
		for (let index = 0; index < fields.length; index += 2) {
			if (String(fields[index]) === "payload") return String(fields[index + 1] ?? "");
		}
		return null;
	}
	if (fields && typeof fields === "object") {
		const value = (fields as Record<string, unknown>).payload;
		return value === undefined || value === null ? null : String(value);
	}
	return null;
}

// ── Singleton with override hook for tests ────────────────────

let busSingleton: RealtimeBus | null = null;

function createDefaultBus(): RealtimeBus {
	const maxLen = readRealtimeStreamMaxLen();
	const useRedis = Boolean(process.env.REDIS_URL?.trim())
		&& process.env.NODE_ENV !== "test"
		&& process.env.BUN_ENV !== "test";
	if (useRedis) {
		return new RedisRealtimeBus({
			url: process.env.REDIS_URL,
			keyPrefix: process.env.SSE_REDIS_KEY_PREFIX || DEFAULT_KEY_PREFIX,
			maxLen,
		});
	}
	return new InMemoryRealtimeBus(maxLen);
}

export function getRealtimeBus(): RealtimeBus {
	if (!busSingleton) busSingleton = createDefaultBus();
	return busSingleton;
}

/**
 * Test hook: override the singleton with a custom (typically in-memory) bus.
 * Pass `null` to reset to the default.
 */
export function setRealtimeBusForTesting(bus: RealtimeBus | null): void {
	busSingleton = bus;
}

/**
 * Build the PER-USER realtime channel key inside a workspace. This is a distinct
 * channel (its own in-memory ring / Redis stream) used to deliver per-user PRIVATE
 * payloads (notification_new) WITHOUT putting them on the shared workspace stream
 * that every member subscribes to. A connection subscribes to its OWN per-user
 * channel keyed on the authenticated subscriber userId, so one member can never
 * receive another member's private frame off the wire (a16 re-review P1 #1).
 *
 * The key namespaces userId under the workspace so it shares the workspace's
 * MAXLEN/caps posture but is a separate fan-out target. The `::u::` separator and
 * the leading `ws:` in the storage key prefix make a collision with a real
 * workspaceId effectively impossible.
 */
export function userScopedChannel(workspaceId: string, userId: string): string {
	return `${workspaceId}::u::${userId}`;
}

/**
 * Convenience wrapper that swallows publish errors so business logic never fails
 * because of a realtime side-effect (e.g. Redis blip during a comment write).
 */
export async function publishRealtimeEvent(
	workspaceId: string,
	kind: RealtimeEventKind,
	data: Record<string, unknown>,
): Promise<RealtimeEvent | null> {
	if (!workspaceId?.trim()) return null;
	try {
		return await getRealtimeBus().publish(workspaceId, { kind, data });
	} catch (error) {
		console.warn(`[Realtime] publish ${kind} failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

export interface PageSetChangedEventData {
	projectId: string;
	changedBy: string;
	pageCount: number;
}

export async function publishPageSetChangedEvent(
	workspaceId: string | null | undefined,
	data: PageSetChangedEventData,
): Promise<RealtimeEvent | null> {
	const channel = workspaceId?.trim();
	if (!channel) return null;
	return publishRealtimeEvent(channel, "page_set_changed", {
		projectId: data.projectId,
		changedBy: data.changedBy,
		pageCount: data.pageCount,
	});
}

/**
 * Publish a PRIVATE per-user event onto the recipient's per-user channel ONLY —
 * never the shared workspace stream. Used by the notification dispatcher so a
 * notification's title/body/metadata is delivered exclusively to the target user's
 * subscriber connection(s). Best-effort like publishRealtimeEvent. Returns null
 * when either id is blank (nothing to route).
 */
export async function publishUserScopedEvent(
	workspaceId: string,
	userId: string,
	kind: RealtimeEventKind,
	data: Record<string, unknown>,
): Promise<RealtimeEvent | null> {
	if (!workspaceId?.trim() || !userId?.trim()) return null;
	const channel = userScopedChannel(workspaceId.trim(), userId.trim());
	try {
		return await getRealtimeBus().publish(channel, { kind, data });
	} catch (error) {
		console.warn(`[Realtime] user-scoped publish ${kind} failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

export const InMemoryRealtimeBusForTesting = InMemoryRealtimeBus;

export function createInMemoryRealtimeBus(maxLen: number = 1000): RealtimeBus {
	return new InMemoryRealtimeBus(maxLen);
}

/** Validate a realtime event kind string (used at boundary input). */
export function isRealtimeEventKind(value: unknown): value is RealtimeEventKind {
	return value === "activity_feed"
		|| value === "ai_job_status"
		|| value === "comment_new"
		|| value === "lock_acquired"
		|| value === "lock_released"
		|| value === "page_set_changed"
		|| value === "workflow_transition"
		|| value === "presence_ping"
		|| value === "notification_new";
}

/** Produce a synthetic event ID; only used in memory mode tests. */
export function syntheticEventIdForTesting(seq: number): string {
	return `${Date.now()}-${seq}`;
}

/** Generate a UUID — exported for predictability in tests. */
export function generateEventCorrelationId(): string {
	return randomUUID();
}
