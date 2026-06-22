/**
 * Upload-batch idempotency cache (PR #439, codex P1).
 *
 * KEEP-mode bulk import is the only batchable upload path: the client splits a big
 * selection into small batches and sends each to /upload-transform (keep), which
 * commits the WHOLE batch server-side BEFORE returning JSON. The XHR can still
 * reject AFTER that commit (onerror/ontimeout / a lost response). The client then
 * retries that SAME batch, and because keep-mode disables SHA dedupe (1 source = 1
 * page is intentional), the retry DUPLICATES the already-committed assets and
 * leaves the first commit's assets orphaned (billed but never referenced).
 *
 * Fix: each client batch carries a stable client-generated `batchKey` (UUID), kept
 * constant across retries of that same batch. Before committing keep-mode, the
 * route checks this cache for (projectId, batchKey); a HIT returns the ORIGINAL
 * committed result (same imageIds/assets) instead of re-committing. After a fresh
 * commit, the route records the result here. So a lost-response retry returns the
 * original ids → no duplicate assets, no orphan.
 *
 * TOPOLOGY (why this MUST be Redis in prod):
 * Production runs the `api` service with `replicas: 2` (docker-compose.prod.yml)
 * behind Caddy `lb_policy least_conn` with NO session affinity, so a retry of a
 * batch frequently lands on the OTHER replica. An in-memory cache there would MISS
 * → re-commit → cross-instance duplicate/orphan for a BILLABLE op. So this store is
 * Redis-backed whenever Redis is configured (env-driven selection identical to
 * `RedisStorageQuotaReservationStore` / the other shared stores), with an in-memory
 * implementation kept as the dev/file-mode/test fallback behind the same interface.
 *
 * Scope/lifetime: short-lived TTL cache. The lost-response retry happens within the
 * same upload session (seconds), so a TTL of a few minutes closes the window while
 * bounding memory / Redis key growth.
 *
 * CONCURRENT-COMMIT CLAIM (codex P3): the GET-at-top / SET-after-commit window above
 * has NO in-flight guard. Two requests with the SAME (projectId, batchKey) that race
 * — a slow first + a client retry, a double-submit, or two requests fanned to the two
 * prod replicas — both miss the GET, both commit, and (keep-mode disables SHA dedupe
 * by design) DUPLICATE billable assets. To close it, the route takes an atomic CLAIM
 * on (projectId, batchKey) BEFORE committing: `tryClaim` is Redis `SET key NX PX <ttl>`
 * (a short TTL — longer than a slow commit, short enough to self-heal a crashed
 * claimer) for the multi-replica path, and a single-process Map check-and-set for the
 * memory path. Only the winner commits; the loser polls the result cache briefly for
 * the winner's committed result and replays it, or (if the commit hasn't landed yet)
 * returns a retryable in-progress signal. `releaseClaim` is called on EVERY exit (the
 * success path overwrites the claim with the durable result; a failed/4xx commit
 * releases the claim so a genuine retry is not locked out for the claim TTL), and the
 * claim TTL cleans up a crashed claimer.
 *
 * OWNERSHIP TOKEN + HEARTBEAT (codex P2): the claim above was a FIXED-TTL `SET NX PX`
 * with an UNCONDITIONAL release — two bugs for a commit slower than the claim TTL (a
 * LARGE keep-mode batch can exceed 60s):
 *   (a) the claim EXPIRES mid-commit → a retry wins a NEW claim, the result cache is
 *       still empty (the slow winner hasn't `set` yet) → the retry RE-COMMITS the same
 *       batch (the exact duplicate this guard exists to prevent); and
 *   (b) the slow original winner's later UNCONDITIONAL `releaseClaim` then DELETEs the
 *       retry's NEWER claim, unguarding it.
 * Fix: every claim carries a UNIQUE OWNERSHIP TOKEN (`crypto.randomUUID()`).
 *   - `tryClaim` stores the token as the claim VALUE and RETURNS it (or `null` if the
 *     claim is held). The route threads the token through commit → release.
 *   - `releaseClaim(key, token)` is a COMPARE-AND-DELETE: it removes the claim ONLY if
 *     the stored value still equals the caller's token (Redis: a tiny `EVAL` Lua —
 *     `GET==token ? DEL : noop`, the canonical safe-unlock; memory: compare the stored
 *     {token,expiry} before deleting). So a stale winner can never delete a retry's
 *     newer claim (token mismatch → no-op).
 *   - `renewClaim(key, token)` re-extends the claim's TTL by the claim-TTL ONLY if the
 *     stored value still equals the token (Redis: `EVAL` `GET==token ? PEXPIRE : 0`;
 *     memory: bump expiry iff token matches). The route runs a HEARTBEAT interval at
 *     ~TTL/3 around the billable commit so a still-running winner is never displaced,
 *     no matter how long the batch takes. The interval is started just before the
 *     commit and cleared in `finally`.
 * RESIDUAL WINDOW (documented): the heartbeat keeps the claim alive only while THIS
 * process holds it. If the claim VANISHES out from under a live winner — a Redis
 * FLUSH/failover that drops the key, not a TTL expiry — `renewClaim` returns a "lost"
 * signal; we LOG LOUDLY and let the commit RUN TO COMPLETION (a half-committed batch
 * cannot be safely aborted), and the winner's result-cache `set` at the very end still
 * lands. A retry that slipped in during that gap is a LOSER on the bounded poll and
 * REPLAYS the now-cached result rather than re-committing — so the worst case degrades
 * to the loser's bounded wait, not a duplicate commit. This narrow window (live claim
 * destroyed by an external flush) is the only case the token+heartbeat cannot fully
 * close, and it requires Redis data loss to occur at all.
 */

import { RedisClient } from "bun";

/**
 * Minimal Redis surface this store needs. Real prod uses Bun's {@link RedisClient};
 * tests inject a fake implementing just `send`, mirroring the egress-accounting and
 * other Redis-store test harnesses.
 */
export interface UploadBatchIdempotencyRedisClient {
	send(command: string, args: string[]): unknown | Promise<unknown>;
}

export interface CachedUploadBatchResult {
	/** The serialized JSON body the route returned for the original commit. */
	body: unknown;
	/** HTTP status of the original committed response (always 2xx for a cached hit). */
	status: number;
}

interface CacheEntry extends CachedUploadBatchResult {
	expiresAt: number;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A client batchKey must be a bounded, opaque token (UUID-ish). */
const MAX_BATCH_KEY_LENGTH = 200;
const BATCH_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

export function isValidUploadBatchKey(value: string | undefined | null): value is string {
	if (!value) return false;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_BATCH_KEY_LENGTH) return false;
	return BATCH_KEY_PATTERN.test(trimmed);
}

/**
 * Shared interface for the keep-mode batch idempotency cache. Both the in-memory
 * (dev/test) and Redis (prod, multi-replica) implementations satisfy it. The route
 * always awaits, so the in-memory impl resolves synchronously while Redis does a
 * real round-trip.
 */
export interface UploadBatchIdempotencyStore {
	get(projectId: string, batchKey: string, now?: number): Promise<CachedUploadBatchResult | undefined>;
	set(projectId: string, batchKey: string, result: CachedUploadBatchResult, now?: number): Promise<void>;
	/**
	 * Atomically claim (projectId, batchKey) for an in-flight commit. Returns a UNIQUE
	 * OWNERSHIP TOKEN for the single caller that wins the claim (it must commit, then
	 * `set` the result and `releaseClaim` with this token); returns `null` for every
	 * other caller while a claim is held (it must NOT re-commit). The claim auto-expires
	 * after a short TTL so a crashed claimer cannot wedge the key — but a still-running
	 * winner should `renewClaim` (heartbeat) to keep the token alive past the TTL.
	 */
	tryClaim(projectId: string, batchKey: string, now?: number): Promise<string | null>;
	/**
	 * COMPARE-AND-DELETE the claim: release it ONLY if the stored ownership value still
	 * equals `token`. A stale winner whose claim already expired (token now mismatched
	 * or absent) is a NO-OP, so it can never delete a retry's NEWER claim. The success
	 * path calls this after caching the durable result; the failure path calls it so the
	 * next attempt can re-claim immediately. Always safe to call.
	 */
	releaseClaim(projectId: string, batchKey: string, token: string): Promise<void>;
	/**
	 * HEARTBEAT: re-extend the claim's TTL by the claim-TTL ONLY if the stored ownership
	 * value still equals `token`. Returns `true` if the claim was renewed (this process
	 * still owns it), `false` if the token no longer matches — the claim was lost (an
	 * external Redis flush/failover, NOT a normal expiry, since the heartbeat outruns the
	 * TTL). A `false` is the caller's cue to LOG LOUDLY; the in-flight commit still runs
	 * to completion (a half-committed batch cannot be safely aborted).
	 */
	renewClaim(projectId: string, batchKey: string, token: string, now?: number): Promise<boolean>;
	clear(): Promise<void>;
}

function compositeKey(projectId: string, batchKey: string): string {
	return `${projectId} ${batchKey}`;
}

function defaultTtlMs(): number {
	return readPositiveIntegerEnv("UPLOAD_BATCH_IDEMPOTENCY_TTL_MS", 10 * 60 * 1000);
}

/**
 * Claim TTL (ms): how long a single in-flight commit holds the (projectId, batchKey)
 * claim before it self-heals. Must be LONGER than a slow keep-mode commit (buffer +
 * decode + storage write) so a still-running winner is not displaced, yet SHORT enough
 * that a crashed claimer's key frees within seconds. Default 60s.
 */
function defaultClaimTtlMs(): number {
	return readPositiveIntegerEnv("UPLOAD_BATCH_IDEMPOTENCY_CLAIM_TTL_MS", 60 * 1000);
}

/**
 * Compare-and-delete (safe unlock): DEL the claim key ONLY if its current value equals
 * the caller's ownership token. `KEYS[1]` = claim key, `ARGV[1]` = token. Returns 1 on
 * delete, 0 on a token mismatch (the claim was re-claimed by someone else — no-op).
 */
const RELEASE_CLAIM_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/**
 * Heartbeat renew: PEXPIRE the claim key by ARGV[2] ms ONLY if its current value equals
 * the caller's ownership token. `KEYS[1]` = claim key, `ARGV[1]` = token, `ARGV[2]` =
 * new TTL ms. Returns 1 if renewed, 0 if the token no longer matches (claim lost).
 */
const RENEW_CLAIM_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

/** Serialize a committed result for Redis; only 2xx replays are ever cached. */
export function serializeCachedUploadBatchResult(result: CachedUploadBatchResult): string {
	return JSON.stringify({ body: result.body, status: result.status });
}

/** Parse a Redis-stored committed result back into the replay shape, or null if corrupt. */
export function parseCachedUploadBatchResult(raw: unknown): CachedUploadBatchResult | null {
	if (raw === null || raw === undefined) return null;
	const text = typeof raw === "string" ? raw : String(raw);
	if (!text) return null;
	try {
		const parsed = JSON.parse(text) as Partial<CachedUploadBatchResult>;
		if (typeof parsed.status !== "number" || !Number.isFinite(parsed.status)) return null;
		// `body` is intentionally `unknown` (the route's JSON body); it round-trips as-is.
		return { body: parsed.body, status: parsed.status };
	} catch {
		return null;
	}
}

/** In-flight commit claim: a unique ownership token + its current expiry (epoch ms). */
interface ClaimEntry {
	token: string;
	expiresAt: number;
}

/** In-memory TTL cache — dev/file-mode/test fallback (single process only). */
export class MemoryUploadBatchIdempotencyStore implements UploadBatchIdempotencyStore {
	private readonly entries = new Map<string, CacheEntry>();
	/** In-flight commit claims keyed by composite key → {ownership token, expiry}. */
	private readonly claims = new Map<string, ClaimEntry>();
	private readonly ttlMs: number;
	private readonly claimTtlMs: number;

	constructor(ttlMs?: number, claimTtlMs?: number) {
		this.ttlMs = ttlMs ?? defaultTtlMs();
		this.claimTtlMs = claimTtlMs ?? defaultClaimTtlMs();
	}

	async get(projectId: string, batchKey: string, now = Date.now()): Promise<CachedUploadBatchResult | undefined> {
		this.prune(now);
		const entry = this.entries.get(compositeKey(projectId, batchKey));
		if (!entry) return undefined;
		if (entry.expiresAt <= now) {
			this.entries.delete(compositeKey(projectId, batchKey));
			return undefined;
		}
		return { body: entry.body, status: entry.status };
	}

	async set(projectId: string, batchKey: string, result: CachedUploadBatchResult, now = Date.now()): Promise<void> {
		this.prune(now);
		this.entries.set(compositeKey(projectId, batchKey), {
			body: result.body,
			status: result.status,
			expiresAt: now + this.ttlMs,
		});
	}

	async tryClaim(projectId: string, batchKey: string, now = Date.now()): Promise<string | null> {
		this.prune(now);
		const key = compositeKey(projectId, batchKey);
		const existing = this.claims.get(key);
		// A live claim by another in-flight commit blocks; an expired one self-heals.
		if (existing !== undefined && existing.expiresAt > now) return null;
		const token = crypto.randomUUID();
		this.claims.set(key, { token, expiresAt: now + this.claimTtlMs });
		return token;
	}

	async releaseClaim(projectId: string, batchKey: string, token: string): Promise<void> {
		const key = compositeKey(projectId, batchKey);
		const existing = this.claims.get(key);
		// Compare-and-delete: only the OWNER (matching token) may release. A stale winner
		// whose claim already expired + was re-claimed sees a mismatched token → no-op, so
		// it can never delete a retry's newer claim.
		if (existing !== undefined && existing.token === token) this.claims.delete(key);
	}

	async renewClaim(projectId: string, batchKey: string, token: string, now = Date.now()): Promise<boolean> {
		const key = compositeKey(projectId, batchKey);
		const existing = this.claims.get(key);
		// Heartbeat: extend the expiry ONLY if this process still owns the token. A missing
		// or mismatched entry means the claim was lost (re-claimed / flushed) → report false.
		if (existing === undefined || existing.token !== token) return false;
		existing.expiresAt = now + this.claimTtlMs;
		return true;
	}

	async clear(): Promise<void> {
		this.entries.clear();
		this.claims.clear();
	}

	private prune(now: number): void {
		for (const [key, entry] of this.entries.entries()) {
			if (entry.expiresAt <= now) this.entries.delete(key);
		}
		for (const [key, claim] of this.claims.entries()) {
			if (claim.expiresAt <= now) this.claims.delete(key);
		}
	}
}

/**
 * Redis-backed cache for the multi-replica prod topology. Keys are namespaced and
 * carry a native Redis TTL (PX), so a retry that lands on a DIFFERENT replica still
 * HITs the committed result and replays it — no cross-instance duplicate/orphan.
 * Mirrors the env-driven Redis selection used by `RedisStorageQuotaReservationStore`.
 */
export class RedisUploadBatchIdempotencyStore implements UploadBatchIdempotencyStore {
	private readonly client: UploadBatchIdempotencyRedisClient;
	private readonly keyPrefix: string;
	private readonly ttlMs: number;
	private readonly claimTtlMs: number;

	constructor(
		url = process.env.REDIS_URL,
		keyPrefix = process.env.UPLOAD_BATCH_IDEMPOTENCY_REDIS_KEY_PREFIX || "manga-editor:upload-batch-idempotency",
		ttlMs?: number,
		client?: UploadBatchIdempotencyRedisClient,
		claimTtlMs?: number,
	) {
		this.client = client ?? (url?.trim() ? new RedisClient(url) : new RedisClient());
		this.keyPrefix = keyPrefix;
		this.ttlMs = ttlMs ?? defaultTtlMs();
		this.claimTtlMs = claimTtlMs ?? defaultClaimTtlMs();
	}

	private redisKey(projectId: string, batchKey: string): string {
		return `${this.keyPrefix}:${compositeKey(projectId, batchKey)}`;
	}

	/**
	 * Claim key is a DISTINCT namespace (`:claim` suffix) from the durable result key,
	 * so the short-lived in-flight claim never collides with / overwrites the cached
	 * 2xx replay (which carries the longer result TTL).
	 */
	private claimKey(projectId: string, batchKey: string): string {
		return `${this.keyPrefix}:claim:${compositeKey(projectId, batchKey)}`;
	}

	async get(projectId: string, batchKey: string, _now = Date.now()): Promise<CachedUploadBatchResult | undefined> {
		const raw = await this.client.send("GET", [this.redisKey(projectId, batchKey)]);
		const parsed = parseCachedUploadBatchResult(raw);
		return parsed ?? undefined;
	}

	async set(projectId: string, batchKey: string, result: CachedUploadBatchResult, _now = Date.now()): Promise<void> {
		// SET key value PX <ttl>: native expiry closes the window without a sweeper.
		await this.client.send("SET", [
			this.redisKey(projectId, batchKey),
			serializeCachedUploadBatchResult(result),
			"PX",
			String(this.ttlMs),
		]);
	}

	async tryClaim(projectId: string, batchKey: string, _now = Date.now()): Promise<string | null> {
		// SET claim <token> NX PX <claimTtl>: atomic claim-or-fail across replicas. The
		// VALUE is a unique ownership token so release/renew can compare-and-act safely. NX
		// makes the SET succeed only if the key is absent (returns "OK"); a held claim
		// returns null. PX gives the claim a short native TTL so a crashed claimer self-heals
		// (a still-running winner extends it via renewClaim).
		const token = crypto.randomUUID();
		const reply = await this.client.send("SET", [
			this.claimKey(projectId, batchKey),
			token,
			"NX",
			"PX",
			String(this.claimTtlMs),
		]);
		// Bun's RedisClient returns "OK" on a successful SET and null when NX is not met.
		return reply === "OK" || reply === true ? token : null;
	}

	async releaseClaim(projectId: string, batchKey: string, token: string): Promise<void> {
		// COMPARE-AND-DELETE via Lua (the canonical safe-unlock): delete the claim ONLY if
		// its stored value still equals OUR token. A stale winner whose claim expired and
		// was re-claimed by a retry sees a mismatched value → DEL is skipped, so it cannot
		// delete the retry's NEWER claim. One round-trip, atomic on the Redis side.
		await this.client.send("EVAL", [
			RELEASE_CLAIM_LUA,
			"1",
			this.claimKey(projectId, batchKey),
			token,
		]);
	}

	async renewClaim(projectId: string, batchKey: string, token: string, _now = Date.now()): Promise<boolean> {
		// HEARTBEAT via Lua: PEXPIRE the claim by the claim-TTL ONLY if its stored value
		// still equals OUR token. Returns 1 when renewed (we still own it), 0 when the token
		// no longer matches — the claim was lost (an external flush/failover, not a normal
		// expiry, since the heartbeat runs at ~TTL/3). 0 is the caller's cue to log loudly.
		const reply = await this.client.send("EVAL", [
			RENEW_CLAIM_LUA,
			"1",
			this.claimKey(projectId, batchKey),
			token,
			String(this.claimTtlMs),
		]);
		return reply === 1 || reply === "1" || reply === true;
	}

	async clear(): Promise<void> {
		// Best-effort namespace flush (test hook). SCAN + DEL the prefixed keys.
		let cursor = "0";
		do {
			const reply = (await this.client.send("SCAN", [cursor, "MATCH", `${this.keyPrefix}:*`, "COUNT", "100"])) as
				| [string, string[]]
				| { 0: string; 1: string[] };
			const nextCursor = Array.isArray(reply) ? reply[0] : reply[0];
			const keys = (Array.isArray(reply) ? reply[1] : reply[1]) ?? [];
			if (keys.length > 0) await this.client.send("DEL", keys);
			cursor = String(nextCursor);
		} while (cursor !== "0");
	}
}

/**
 * Machine code returned to the client when a concurrent commit holds the claim and its
 * result has not yet landed in the cache within the bounded wait. The keep-mode upload
 * client treats ANY non-2xx as a retryable batch failure (it stashes the batch's STABLE
 * `batchKey` and re-sends it), so by the time the user retries, the winning commit's
 * result is cached and the retry replays it — no duplicate/orphan.
 */
export const UPLOAD_BATCH_IN_PROGRESS_CODE = "upload_batch_in_progress";

/** Seconds the client is asked to wait before retrying an in-progress batch (Retry-After). */
export const UPLOAD_BATCH_IN_PROGRESS_RETRY_AFTER_SECONDS = 2;

/**
 * Total time (ms) the LOSER of a claim race waits for the WINNER's committed result to
 * land in the cache before giving up with an in-progress signal. Bounded to a few
 * seconds so a request never hangs: the common race (slow first + retry, double-submit)
 * resolves in well under a second once the winner commits; a genuinely stuck/crashed
 * winner is surfaced as a retryable error instead of blocking.
 */
function defaultInProgressWaitMs(): number {
	return readPositiveIntegerEnv("UPLOAD_BATCH_IDEMPOTENCY_WAIT_MS", 4_000);
}

/** Poll interval (ms) while the loser waits for the winner's cached result. */
function defaultInProgressPollMs(): number {
	return readPositiveIntegerEnv("UPLOAD_BATCH_IDEMPOTENCY_POLL_MS", 100);
}

/**
 * Bounded poll for a winning concurrent commit's cached result. Returns the replay as
 * soon as the winner's `set` lands, or `undefined` if the wait elapses first (the
 * winner is still committing or crashed — the caller then returns the in-progress
 * signal). Injectable timing keeps it deterministic in tests.
 */
export async function waitForCachedUploadBatchResult(
	store: Pick<UploadBatchIdempotencyStore, "get">,
	projectId: string,
	batchKey: string,
	options: {
		waitMs?: number;
		pollMs?: number;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<CachedUploadBatchResult | undefined> {
	const waitMs = options.waitMs ?? defaultInProgressWaitMs();
	const pollMs = Math.max(1, options.pollMs ?? defaultInProgressPollMs());
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = now() + waitMs;
	// Check immediately first (the winner may already have committed), then poll.
	for (;;) {
		const hit = await store.get(projectId, batchKey);
		if (hit) return hit;
		if (now() >= deadline) return undefined;
		await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
	}
}

/**
 * Heartbeat interval (ms): how often the winner renews its claim while the billable
 * commit runs. ~TTL/3 so the claim is re-extended at least twice before it would expire,
 * tolerating a missed/slow renewal. Min 1s so a tiny test TTL can't spin a hot loop.
 */
function defaultHeartbeatIntervalMs(claimTtlMs: number): number {
	const fromEnv = readPositiveIntegerEnv("UPLOAD_BATCH_IDEMPOTENCY_HEARTBEAT_MS", 0);
	if (fromEnv > 0) return fromEnv;
	return Math.max(1_000, Math.floor(claimTtlMs / 3));
}

/** Handle to stop a running claim heartbeat. `stop()` is idempotent and clears the timer. */
export interface ClaimHeartbeat {
	stop(): void;
}

/**
 * Start a HEARTBEAT that renews the (projectId, batchKey) claim on `intervalMs` while the
 * billable commit runs, keeping a still-running winner's token alive PAST the claim TTL so
 * a slow batch is never displaced. Started just before the commit; `stop()` MUST be called
 * in `finally`. If a renewal reports the claim was LOST (token gone — an external Redis
 * flush/failover, not a normal expiry), it LOGS LOUDLY and STOPS heartbeating; the commit
 * is NOT aborted (a half-committed batch cannot be unwound safely) — the winner's final
 * result-cache `set` still lands and a racing retry replays it via the bounded poll. This
 * is the documented residual window: only an external claim destruction can reach it.
 */
export function startClaimHeartbeat(
	store: Pick<UploadBatchIdempotencyStore, "renewClaim">,
	projectId: string,
	batchKey: string,
	token: string,
	options: {
		intervalMs?: number;
		claimTtlMs?: number;
		onClaimLost?: () => void;
		setInterval?: (fn: () => void, ms: number) => unknown;
		clearInterval?: (handle: unknown) => void;
	} = {},
): ClaimHeartbeat {
	const claimTtlMs = options.claimTtlMs ?? defaultClaimTtlMs();
	const intervalMs = Math.max(1, options.intervalMs ?? defaultHeartbeatIntervalMs(claimTtlMs));
	const setIntervalFn: (fn: () => void, ms: number) => unknown = options.setInterval ?? setInterval;
	const clearIntervalFn: (handle: unknown) => void =
		options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
	let stopped = false;
	let handle: unknown;

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		if (handle !== undefined) clearIntervalFn(handle);
		handle = undefined;
	};

	handle = setIntervalFn(() => {
		// Guard against a tick that fires after stop() (timer already queued).
		if (stopped) return;
		void Promise.resolve(store.renewClaim(projectId, batchKey, token))
			.then((renewed) => {
				if (stopped) return;
				if (!renewed) {
					// Claim VANISHED under a live winner (external flush/failover). Log loudly;
					// the commit continues and its final result-cache set still lands.
					console.error(
						"[upload-batch-idempotency] claim LOST mid-commit (token gone — likely Redis flush/failover); " +
							"commit continues, result will still be cached for replay",
						{ projectId },
					);
					options.onClaimLost?.();
					stop();
				}
			})
			.catch((error) => {
				// A renewal RPC failure (transient Redis blip) is NOT proof the claim is gone;
				// keep heartbeating — the next tick retries. The claim TTL still covers a crash.
				console.warn("[upload-batch-idempotency] claim heartbeat renewal failed (will retry next tick)", {
					projectId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}, intervalMs);

	// Some runtimes return a Timer with unref(); don't keep the process alive for a heartbeat.
	(handle as { unref?: () => void } | undefined)?.unref?.();

	return { stop };
}

function createUploadBatchIdempotencyStore(): UploadBatchIdempotencyStore {
	const mode = (process.env.UPLOAD_BATCH_IDEMPOTENCY_STORE || (process.env.REDIS_URL ? "redis" : "memory"))
		.trim()
		.toLowerCase();
	if (mode === "redis") return new RedisUploadBatchIdempotencyStore();
	return new MemoryUploadBatchIdempotencyStore();
}

/** Process-wide store for keep-mode upload-batch commit idempotency. */
export let uploadBatchIdempotencyStore: UploadBatchIdempotencyStore = createUploadBatchIdempotencyStore();

export function setUploadBatchIdempotencyStoreForTests(store: UploadBatchIdempotencyStore): () => void {
	const previous = uploadBatchIdempotencyStore;
	uploadBatchIdempotencyStore = store;
	return () => {
		uploadBatchIdempotencyStore = previous;
	};
}
