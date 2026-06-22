import { describe, expect, test } from "bun:test";
import {
	MemoryUploadBatchIdempotencyStore,
	RedisUploadBatchIdempotencyStore,
	UPLOAD_BATCH_IN_PROGRESS_CODE,
	type CachedUploadBatchResult,
	type UploadBatchIdempotencyRedisClient,
	type UploadBatchIdempotencyStore,
	isValidUploadBatchKey,
	parseCachedUploadBatchResult,
	serializeCachedUploadBatchResult,
	startClaimHeartbeat,
	waitForCachedUploadBatchResult,
} from "../services/upload-batch-idempotency.js";

describe("MemoryUploadBatchIdempotencyStore", () => {
	test("replays a recorded committed result for the same (projectId, batchKey)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000);
		expect(await store.get("proj-1", "batch-abc")).toBeUndefined();
		await store.set("proj-1", "batch-abc", { body: { imageIds: ["a.png", "b.png"] }, status: 200 });
		const hit = await store.get("proj-1", "batch-abc");
		expect(hit).toEqual({ body: { imageIds: ["a.png", "b.png"] }, status: 200 });
	});

	test("scopes entries by project AND key (no cross-project / cross-batch bleed)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000);
		await store.set("proj-1", "batch-x", { body: { imageIds: ["p1.png"] }, status: 200 });
		expect(await store.get("proj-2", "batch-x")).toBeUndefined();
		expect(await store.get("proj-1", "batch-y")).toBeUndefined();
	});

	test("expires entries after the TTL so the cache cannot grow unbounded", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(1_000);
		const t0 = 1_000_000;
		await store.set("proj-1", "batch-ttl", { body: { imageIds: ["a.png"] }, status: 200 }, t0);
		expect(await store.get("proj-1", "batch-ttl", t0 + 500)).toBeTruthy();
		expect(await store.get("proj-1", "batch-ttl", t0 + 1_500)).toBeUndefined();
	});

	test("validates batch keys: bounded, opaque, non-empty UUID-ish tokens only", () => {
		expect(isValidUploadBatchKey("batch-3f6e9a2c-1234-4abc-9def-0123456789ab")).toBe(true);
		expect(isValidUploadBatchKey("3f6e9a2c12344abc9def0123456789ab")).toBe(true);
		expect(isValidUploadBatchKey(undefined)).toBe(false);
		expect(isValidUploadBatchKey("")).toBe(false);
		expect(isValidUploadBatchKey("short")).toBe(false); // < 8 chars
		expect(isValidUploadBatchKey("has spaces and stuff")).toBe(false);
		expect(isValidUploadBatchKey("a".repeat(201))).toBe(false); // over the length cap
	});
});

describe("upload-batch idempotency Redis serialization", () => {
	test("round-trips a committed result through Redis string serialization", () => {
		const result = { body: { imageIds: ["a.png", "b.png"], assets: [{ assetId: "a" }] }, status: 200 };
		const serialized = serializeCachedUploadBatchResult(result);
		expect(typeof serialized).toBe("string");
		const parsed = parseCachedUploadBatchResult(serialized);
		expect(parsed).toEqual(result);
	});

	test("parse rejects corrupt / non-2xx-shaped values", () => {
		expect(parseCachedUploadBatchResult(null)).toBeNull();
		expect(parseCachedUploadBatchResult(undefined)).toBeNull();
		expect(parseCachedUploadBatchResult("")).toBeNull();
		expect(parseCachedUploadBatchResult("not json")).toBeNull();
		expect(parseCachedUploadBatchResult(JSON.stringify({ body: {} }))).toBeNull(); // no status
	});
});

/**
 * Shared fake Redis used by the cross-instance test: a SINGLE backing map stands in
 * for the one Redis both API replicas talk to. Each `RedisUploadBatchIdempotencyStore`
 * is a distinct "instance", but they share this store, exactly like two prod replicas
 * sharing one Redis. Implements GET/SET (with NX/PX), SCAN/DEL for clear(), and EVAL
 * for the compare-and-del / heartbeat-renew Lua scripts the claim uses.
 */
class SharedFakeRedis implements UploadBatchIdempotencyRedisClient {
	private readonly entries = new Map<string, { value: string; expiresAt: number }>();
	constructor(private readonly now: () => number = () => Date.now()) {}

	/** Read a still-live value (pruning an expired key), mirroring real GET semantics. */
	private liveValue(key: string): string | null {
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return null;
		}
		return entry.value;
	}

	send(command: string, args: string[]): unknown {
		const upper = command.toUpperCase();
		switch (upper) {
			case "SET": {
				const key = String(args[0]);
				const value = String(args[1]);
				// Parse SET options anywhere after the value: NX (set-if-absent), PX <ms>.
				const opts = args.slice(2).map((a) => String(a).toUpperCase());
				const nx = opts.includes("NX");
				const pxIndex = opts.indexOf("PX");
				let expiresAt = Number.POSITIVE_INFINITY;
				if (pxIndex >= 0) {
					// PX value is the arg right after "PX" (offset by the slice(2)).
					const ttl = args[2 + pxIndex + 1];
					expiresAt = this.now() + Number(ttl);
				}
				if (nx) {
					const existing = this.entries.get(key);
					// NX fails (returns null) only if a LIVE key already exists.
					if (existing && existing.expiresAt > this.now()) return null;
				}
				this.entries.set(key, { value, expiresAt });
				return "OK";
			}
			case "GET":
				return this.liveValue(String(args[0]));
			case "SCAN": {
				const matchIndex = args.indexOf("MATCH");
				const pattern = matchIndex >= 0 ? args[matchIndex + 1] ?? "*" : "*";
				const prefix = pattern.replace(/\*$/, "");
				const keys = [...this.entries.keys()].filter((k) => k.startsWith(prefix));
				return ["0", keys];
			}
			case "DEL": {
				let removed = 0;
				for (const key of args) if (this.entries.delete(key)) removed += 1;
				return String(removed);
			}
			case "EVAL": {
				// Emulate the two tiny Lua scripts the store uses (numkeys=1):
				//   EVAL <script> 1 <key> <token> [<ttlMs>]
				// Dispatch on the script body's atomic op so we don't run a real Lua VM.
				const script = String(args[0]);
				const key = String(args[2]);
				const token = String(args[3]);
				const matches = this.liveValue(key) === token;
				if (script.includes("'DEL'") || script.includes('"DEL"')) {
					// Compare-and-delete: DEL only on a token match.
					if (matches) {
						this.entries.delete(key);
						return 1;
					}
					return 0;
				}
				if (script.includes("'PEXPIRE'") || script.includes('"PEXPIRE"')) {
					// Heartbeat: PEXPIRE only on a token match.
					if (matches) {
						const entry = this.entries.get(key);
						if (entry) entry.expiresAt = this.now() + Number(args[4]);
						return 1;
					}
					return 0;
				}
				throw new Error(`Unexpected EVAL script: ${script}`);
			}
			default:
				throw new Error(`Unexpected Redis command: ${command}`);
		}
	}
}

describe("RedisUploadBatchIdempotencyStore (multi-replica topology)", () => {
	test("a commit recorded on instance A replays on instance B (cross-replica retry)", async () => {
		const redis = new SharedFakeRedis();
		// Two stores sharing ONE Redis = two API replicas behind least_conn (no affinity).
		const instanceA = new RedisUploadBatchIdempotencyStore(undefined, "test:upload-idem", 60_000, redis);
		const instanceB = new RedisUploadBatchIdempotencyStore(undefined, "test:upload-idem", 60_000, redis);

		// Instance A commits the batch and records the result (response then lost).
		const committed = { body: { imageIds: ["x.png", "y.png"] }, status: 200 };
		await instanceA.set("proj-9", "batch-cross", committed);

		// The retry lands on instance B → it MUST replay the SAME committed result
		// instead of missing → no re-commit, no duplicate/orphan across replicas.
		const replay = await instanceB.get("proj-9", "batch-cross");
		expect(replay).toEqual(committed);
	});

	test("honors a per-key Redis TTL (PX) so the cache self-expires", async () => {
		let clock = 1_000_000;
		const redis = new SharedFakeRedis(() => clock);
		const store = new RedisUploadBatchIdempotencyStore(undefined, "test:upload-ttl", 1_000, redis);
		await store.set("proj-1", "batch-ttl", { body: { imageIds: ["a.png"] }, status: 200 });
		expect(await store.get("proj-1", "batch-ttl")).toBeTruthy();
		clock += 1_500;
		expect(await store.get("proj-1", "batch-ttl")).toBeUndefined();
	});

	test("scopes by (projectId, batchKey) in Redis (no cross-project / cross-batch bleed)", async () => {
		const redis = new SharedFakeRedis();
		const store = new RedisUploadBatchIdempotencyStore(undefined, "test:upload-scope", 60_000, redis);
		await store.set("proj-1", "batch-x", { body: { imageIds: ["p1.png"] }, status: 200 });
		expect(await store.get("proj-2", "batch-x")).toBeUndefined();
		expect(await store.get("proj-1", "batch-y")).toBeUndefined();
		expect(await store.get("proj-1", "batch-x")).toBeTruthy();
	});

	test("clear() flushes only this store's namespace via SCAN+DEL", async () => {
		const redis = new SharedFakeRedis();
		const store = new RedisUploadBatchIdempotencyStore(undefined, "test:upload-clear", 60_000, redis);
		await store.set("proj-1", "batch-a", { body: {}, status: 200 });
		await store.set("proj-1", "batch-b", { body: {}, status: 200 });
		await store.clear();
		expect(await store.get("proj-1", "batch-a")).toBeUndefined();
		expect(await store.get("proj-1", "batch-b")).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENT-COMMIT CLAIM (codex P3)
//
// The GET-at-top / SET-after-commit window had NO in-flight claim, so two requests
// with the SAME (projectId, batchKey) both missed the cache, both committed, and
// (keep-mode disables SHA dedupe) DUPLICATED billable assets. These tests cover the
// atomic claim that closes the window for BOTH backends, plus the simulated route
// flow that proves a concurrent same-batchKey race commits EXACTLY ONCE.
// ─────────────────────────────────────────────────────────────────────────────

describe("upload-batch idempotency claim semantics (memory)", () => {
	test("tryClaim grants a unique ownership TOKEN to exactly ONE caller; the rest are blocked", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		const token = await store.tryClaim("proj-1", "batch-claim");
		expect(typeof token).toBe("string");
		expect(token).toBeTruthy();
		// A second caller while the claim is held is blocked (null — must NOT re-commit).
		expect(await store.tryClaim("proj-1", "batch-claim")).toBeNull();
		expect(await store.tryClaim("proj-1", "batch-claim")).toBeNull();
	});

	test("releaseClaim (with the owning token) frees the key so a genuine retry can re-claim", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		const token = await store.tryClaim("proj-1", "batch-rel");
		expect(token).toBeTruthy();
		expect(await store.tryClaim("proj-1", "batch-rel")).toBeNull();
		await store.releaseClaim("proj-1", "batch-rel", token!);
		// After release the next attempt re-claims (the FAILED-commit retry path).
		expect(await store.tryClaim("proj-1", "batch-rel")).toBeTruthy();
	});

	test("releaseClaim with a NON-owning token is a no-op (cannot free another claim)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		const token = await store.tryClaim("proj-1", "batch-guard");
		expect(token).toBeTruthy();
		// A stranger's release (wrong token) must NOT free the live claim.
		await store.releaseClaim("proj-1", "batch-guard", "not-the-owner-token");
		expect(await store.tryClaim("proj-1", "batch-guard")).toBeNull();
		// The real owner can still release it.
		await store.releaseClaim("proj-1", "batch-guard", token!);
		expect(await store.tryClaim("proj-1", "batch-guard")).toBeTruthy();
	});

	test("claims are scoped by (projectId, batchKey) — no cross bleed", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		expect(await store.tryClaim("proj-1", "batch-x")).toBeTruthy();
		// Different project OR different key is a distinct claim.
		expect(await store.tryClaim("proj-2", "batch-x")).toBeTruthy();
		expect(await store.tryClaim("proj-1", "batch-y")).toBeTruthy();
	});

	test("an expired claim self-heals (crashed claimer): a later attempt re-claims", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 1_000);
		const t0 = 5_000_000;
		expect(await store.tryClaim("proj-1", "batch-ttl", t0)).toBeTruthy();
		// Still held within the claim TTL.
		expect(await store.tryClaim("proj-1", "batch-ttl", t0 + 500)).toBeNull();
		// After the claim TTL elapses, the stale claim is reclaimable (no permanent wedge).
		expect(await store.tryClaim("proj-1", "batch-ttl", t0 + 1_500)).toBeTruthy();
	});

	test("renewClaim (heartbeat) extends the claim ONLY for the owning token", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 1_000);
		const t0 = 7_000_000;
		const token = await store.tryClaim("proj-1", "batch-hb", t0);
		expect(token).toBeTruthy();
		// Just before expiry, the owner renews → the claim's expiry is pushed forward.
		expect(await store.renewClaim("proj-1", "batch-hb", token!, t0 + 900)).toBe(true);
		// Past the ORIGINAL TTL but within the renewed window: still blocked (NOT expired).
		expect(await store.tryClaim("proj-1", "batch-hb", t0 + 1_500)).toBeNull();
		// A renew with the WRONG token does not extend (and reports the claim "lost").
		expect(await store.renewClaim("proj-1", "batch-hb", "wrong-token", t0 + 1_600)).toBe(false);
	});

	test("renewClaim returns false when the claim is GONE (re-claimed / flushed)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 1_000);
		const t0 = 8_000_000;
		const stale = await store.tryClaim("proj-1", "batch-lost", t0);
		expect(stale).toBeTruthy();
		// The claim expires and a retry re-claims with a NEW token.
		const fresh = await store.tryClaim("proj-1", "batch-lost", t0 + 1_500);
		expect(fresh).toBeTruthy();
		expect(fresh).not.toBe(stale);
		// The stale winner's heartbeat now sees a token MISMATCH → claim lost (no extend).
		expect(await store.renewClaim("proj-1", "batch-lost", stale!, t0 + 1_600)).toBe(false);
		// And the stale winner's release must NOT delete the retry's NEWER claim.
		await store.releaseClaim("proj-1", "batch-lost", stale!);
		expect(await store.tryClaim("proj-1", "batch-lost", t0 + 1_700)).toBeNull();
	});
});

describe("upload-batch idempotency claim semantics (Redis, multi-replica)", () => {
	test("only ONE replica wins the claim (and gets a token) for the same (projectId, batchKey)", async () => {
		const redis = new SharedFakeRedis();
		const instanceA = new RedisUploadBatchIdempotencyStore(undefined, "test:claim", 60_000, redis, 60_000);
		const instanceB = new RedisUploadBatchIdempotencyStore(undefined, "test:claim", 60_000, redis, 60_000);
		// A claims first (SET NX succeeds → token); B (the other replica) is blocked (null).
		const tokenA = await instanceA.tryClaim("proj-9", "batch-cross");
		expect(tokenA).toBeTruthy();
		expect(await instanceB.tryClaim("proj-9", "batch-cross")).toBeNull();
		// After A releases (with its token), B can take it (e.g. a retry after a failed commit).
		await instanceA.releaseClaim("proj-9", "batch-cross", tokenA!);
		expect(await instanceB.tryClaim("proj-9", "batch-cross")).toBeTruthy();
	});

	test("a crashed claimer's claim expires via PX so the batch is not wedged", async () => {
		let clock = 9_000_000;
		const redis = new SharedFakeRedis(() => clock);
		const store = new RedisUploadBatchIdempotencyStore(undefined, "test:claim-ttl", 60_000, redis, 1_000);
		expect(await store.tryClaim("proj-1", "batch-crash")).toBeTruthy();
		expect(await store.tryClaim("proj-1", "batch-crash")).toBeNull();
		clock += 1_500; // claim TTL elapsed → the NX SET succeeds again.
		expect(await store.tryClaim("proj-1", "batch-crash")).toBeTruthy();
	});

	test("renewClaim (heartbeat) PEXPIREs the claim past the TTL ONLY for the owning token", async () => {
		let clock = 10_000_000;
		const redis = new SharedFakeRedis(() => clock);
		const store = new RedisUploadBatchIdempotencyStore(undefined, "test:claim-hb", 60_000, redis, 1_000);
		const token = await store.tryClaim("proj-1", "batch-hb");
		expect(token).toBeTruthy();
		clock += 900; // just before the original TTL
		expect(await store.renewClaim("proj-1", "batch-hb", token!)).toBe(true);
		clock += 600; // past the ORIGINAL 1s TTL, within the renewed window
		expect(await store.tryClaim("proj-1", "batch-hb")).toBeNull(); // still held (renewed)
		// A renew with a stale token after the claim is gone reports false (claim lost).
		expect(await store.renewClaim("proj-1", "batch-hb", "stale-token")).toBe(false);
	});

	test("releaseClaim is compare-and-delete: a stale token does NOT delete a retry's newer claim", async () => {
		let clock = 11_000_000;
		const redis = new SharedFakeRedis(() => clock);
		// Heartbeat-less (simulated expiry): claim TTL 1s, no renewal.
		const store = new RedisUploadBatchIdempotencyStore(undefined, "test:claim-cad", 60_000, redis, 1_000);
		const staleToken = await store.tryClaim("proj-1", "batch-cad");
		expect(staleToken).toBeTruthy();
		clock += 1_500; // the slow winner's claim EXPIRED mid-commit (no heartbeat).
		const freshToken = await store.tryClaim("proj-1", "batch-cad"); // a retry re-claims.
		expect(freshToken).toBeTruthy();
		expect(freshToken).not.toBe(staleToken);
		// The slow winner finally finishes and releases with its STALE token: compare-and-del
		// sees a token mismatch → NO-OP. The retry's newer claim survives.
		await store.releaseClaim("proj-1", "batch-cad", staleToken!);
		expect(await store.tryClaim("proj-1", "batch-cad")).toBeNull(); // newer claim intact.
		// The retry's OWN release (matching token) does free it.
		await store.releaseClaim("proj-1", "batch-cad", freshToken!);
		expect(await store.tryClaim("proj-1", "batch-cad")).toBeTruthy();
	});

	test("the claim key is a DISTINCT namespace from the durable result key", async () => {
		const redis = new SharedFakeRedis();
		const store = new RedisUploadBatchIdempotencyStore(undefined, "test:claim-ns", 60_000, redis, 60_000);
		await store.tryClaim("proj-1", "batch-ns");
		// The durable result GET is unaffected by an in-flight claim (no collision).
		expect(await store.get("proj-1", "batch-ns")).toBeUndefined();
		await store.set("proj-1", "batch-ns", { body: { imageIds: ["a.png"] }, status: 200 });
		expect(await store.get("proj-1", "batch-ns")).toBeTruthy();
		// clear() flushes BOTH the result and the claim namespaces under the prefix.
		await store.clear();
		expect(await store.get("proj-1", "batch-ns")).toBeUndefined();
		expect(await store.tryClaim("proj-1", "batch-ns")).toBeTruthy();
	});
});

describe("waitForCachedUploadBatchResult (loser bounded poll)", () => {
	test("returns the winner's cached result as soon as it lands", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		// Winner sets the result after the first poll tick.
		let ticks = 0;
		const sleep = async () => {
			ticks += 1;
			if (ticks === 1) {
				await store.set("proj-1", "batch-poll", { body: { imageIds: ["w.png"] }, status: 200 });
			}
		};
		const result = await waitForCachedUploadBatchResult(store, "proj-1", "batch-poll", {
			waitMs: 1_000,
			pollMs: 10,
			now: makeFakeClock(),
			sleep,
		});
		expect(result).toEqual({ body: { imageIds: ["w.png"] }, status: 200 });
	});

	test("returns undefined when the winner never lands within the bounded wait", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		const result = await waitForCachedUploadBatchResult(store, "proj-1", "batch-stuck", {
			waitMs: 50,
			pollMs: 10,
			now: makeFakeClock(),
			sleep: async () => {},
		});
		expect(result).toBeUndefined();
	});

	test("returns immediately if the result is already cached (fast winner)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		await store.set("proj-1", "batch-fast", { body: { imageIds: ["f.png"] }, status: 200 });
		let slept = false;
		const result = await waitForCachedUploadBatchResult(store, "proj-1", "batch-fast", {
			waitMs: 1_000,
			pollMs: 10,
			sleep: async () => {
				slept = true;
			},
		});
		expect(result).toEqual({ body: { imageIds: ["f.png"] }, status: 200 });
		expect(slept).toBe(false); // no poll needed — hit on the immediate check.
	});
});

/**
 * A monotonic fake clock so the bounded-poll deadline advances even when `sleep` is a
 * no-op. Each read advances by a fixed step; with pollMs ≤ step the deadline is reached
 * deterministically without real timers.
 */
function makeFakeClock(start = 0, step = 25): () => number {
	let t = start;
	return () => {
		const v = t;
		t += step;
		return v;
	};
}

/**
 * Minimal stand-in for the /upload-transform claim → heartbeat → commit → cache/release
 * flow in images.ts. It mirrors the route's exact ordering (top GET, claim -> TOKEN,
 * re-check under claim, START HEARTBEAT, commit, cache-2xx + token
 * release on every terminal outcome, release-on-throw) so we can prove the CONCURRENCY
 * contract — exactly one commit per (projectId, batchKey) — with injected store fakes
 * and no DB/storage infra.
 *
 * `heartbeat: true` starts the real {@link startClaimHeartbeat} around the commit so a
 * slow batch keeps renewing its claim (the P2 fix). `heartbeatIntervalMs` tunes the
 * cadence for tests.
 */
async function simulateUploadTransform(
	store: UploadBatchIdempotencyStore,
	projectId: string,
	batchKey: string,
	commit: () => Promise<{ status: number; body: unknown }>,
	options: {
		waitMs?: number;
		pollMs?: number;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
		heartbeat?: boolean;
		heartbeatIntervalMs?: number;
		claimTtlMs?: number;
		afterCommitBeforeCache?: () => Promise<void>;
	} = {},
): Promise<{ status: number; body: unknown; committed: boolean }> {
	// Top-of-route durable replay (P1).
	const top = await store.get(projectId, batchKey);
	if (top) return { status: top.status, body: top.body, committed: false };

	// Atomic claim → ownership token (P3/P2).
	const token = await store.tryClaim(projectId, batchKey);
	if (!token) {
		const replay = await waitForCachedUploadBatchResult(store, projectId, batchKey, options);
		if (replay) return { status: replay.status, body: replay.body, committed: false };
		return { status: 409, body: { code: UPLOAD_BATCH_IN_PROGRESS_CODE }, committed: false };
	}
	// Re-check under the claim (a prior winner may have settled + released in the gap).
	const settled = await store.get(projectId, batchKey);
	if (settled) {
		await store.releaseClaim(projectId, batchKey, token);
		return { status: settled.status, body: settled.body, committed: false };
	}

	// HEARTBEAT around the billable commit (P2): renews the claim so a slow commit never
	// lets it expire mid-flight. Started just before commit, stopped in `finally`.
	const heartbeat = options.heartbeat
		? startClaimHeartbeat(store, projectId, batchKey, token, {
				intervalMs: options.heartbeatIntervalMs ?? 10,
				claimTtlMs: options.claimTtlMs,
			})
		: undefined;

	let result: { status: number; body: unknown };
	try {
		result = await commit();
		await options.afterCommitBeforeCache?.();
		if (result.status >= 200 && result.status < 300) {
			await store.set(projectId, batchKey, { body: result.body, status: result.status } as CachedUploadBatchResult);
		}
		await store.releaseClaim(projectId, batchKey, token);
	} catch (error) {
		await store.releaseClaim(projectId, batchKey, token);
		throw error;
	} finally {
		heartbeat?.stop();
	}
	return { status: result.status, body: result.body, committed: true };
}

describe("upload-transform concurrent-commit guard (simulated route flow)", () => {
	test("two concurrent requests with the SAME batchKey commit EXACTLY ONCE (memory)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		let commits = 0;
		// A slow commit so the loser is in its bounded poll while the winner commits.
		const commit = async () => {
			commits += 1;
			await new Promise((r) => setTimeout(r, 30));
			return { status: 200, body: { imageIds: [`img-${commits}.png`] } };
		};
		const [a, b] = await Promise.all([
			simulateUploadTransform(store, "proj-1", "batch-race", commit, { waitMs: 1_000, pollMs: 5 }),
			simulateUploadTransform(store, "proj-1", "batch-race", commit, { waitMs: 1_000, pollMs: 5 }),
		]);
		// Exactly ONE commit happened across both requests.
		expect(commits).toBe(1);
		// Both callers return the SAME committed body (the loser replayed the cache).
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(a.body).toEqual(b.body);
		// Exactly one of the two actually committed; the other replayed (no second commit).
		expect([a.committed, b.committed].filter(Boolean).length).toBe(1);
	});

	test("two concurrent requests commit EXACTLY ONCE across two Redis replicas", async () => {
		const redis = new SharedFakeRedis();
		const replicaA = new RedisUploadBatchIdempotencyStore(undefined, "test:race", 60_000, redis, 60_000);
		const replicaB = new RedisUploadBatchIdempotencyStore(undefined, "test:race", 60_000, redis, 60_000);
		let commits = 0;
		const commit = async () => {
			commits += 1;
			await new Promise((r) => setTimeout(r, 30));
			return { status: 200, body: { imageIds: [`img-${commits}.png`] } };
		};
		const [a, b] = await Promise.all([
			simulateUploadTransform(replicaA, "proj-9", "batch-cross-race", commit, { waitMs: 1_000, pollMs: 5 }),
			simulateUploadTransform(replicaB, "proj-9", "batch-cross-race", commit, { waitMs: 1_000, pollMs: 5 }),
		]);
		expect(commits).toBe(1); // no cross-replica duplicate/orphan.
		expect(a.body).toEqual(b.body);
		expect([a.committed, b.committed].filter(Boolean).length).toBe(1);
	});

	test("the loser returns an in-progress 409 when the winner's result never lands in the wait", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		// Winner holds the claim but never commits within the loser's bounded wait.
		expect(await store.tryClaim("proj-1", "batch-slow")).toBeTruthy();
		const loser = await simulateUploadTransform(
			store,
			"proj-1",
			"batch-slow",
			async () => ({ status: 200, body: { imageIds: ["never.png"] } }),
			{ waitMs: 40, pollMs: 10, now: makeFakeClock(), sleep: async () => {} },
		);
		expect(loser.status).toBe(409);
		expect((loser.body as { code: string }).code).toBe(UPLOAD_BATCH_IN_PROGRESS_CODE);
		expect(loser.committed).toBe(false);
	});

	test("a FAILED commit releases the claim so a genuine retry COMMITS (not locked out)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		let commits = 0;
		// First attempt throws (e.g. storage/quota infra error) → claim must be released.
		await expect(
			simulateUploadTransform(store, "proj-1", "batch-fail", async () => {
				commits += 1;
				throw new Error("storage down");
			}),
		).rejects.toThrow("storage down");
		// The claim is NOT held after the failure (no lock-out for the claim TTL): a probe
		// re-claims, and we release it (with its token) so the genuine retry below can claim.
		const probe = await store.tryClaim("proj-1", "batch-fail");
		expect(probe).toBeTruthy();
		await store.releaseClaim("proj-1", "batch-fail", probe!);
		// A genuine retry now commits cleanly and caches the durable result.
		const retry = await simulateUploadTransform(store, "proj-1", "batch-fail", async () => {
			commits += 1;
			return { status: 200, body: { imageIds: ["ok.png"] } };
		});
		expect(retry.status).toBe(200);
		expect(retry.committed).toBe(true);
		expect(commits).toBe(2); // failed attempt + successful retry.
		// And a subsequent retry of the SAME key now REPLAYS (durable cache hit, no commit).
		const replay = await simulateUploadTransform(store, "proj-1", "batch-fail", async () => {
			commits += 1;
			return { status: 200, body: { imageIds: ["dup.png"] } };
		});
		expect(replay.committed).toBe(false);
		expect(replay.body).toEqual({ imageIds: ["ok.png"] });
		expect(commits).toBe(2); // unchanged — the replay did NOT commit.
	});

	test("a non-2xx commit releases the claim AND is not cached (fresh retry allowed)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		// A 402 quota rejection is a real Response but NOT durable.
		const rejected = await simulateUploadTransform(store, "proj-1", "batch-402", async () => ({
			status: 402,
			body: { code: "usage_quota_exceeded" },
		}));
		expect(rejected.status).toBe(402);
		expect(rejected.committed).toBe(true); // it ran the commit path...
		// ...but nothing durable was cached, and the claim was released → a fresh retry runs.
		expect(await store.get("proj-1", "batch-402")).toBeUndefined();
		const retry = await simulateUploadTransform(store, "proj-1", "batch-402", async () => ({
			status: 200,
			body: { imageIds: ["recovered.png"] },
		}));
		expect(retry.status).toBe(200);
		expect(retry.committed).toBe(true);
	});

	test("a winner that settled + released before a late claimer makes the late claimer REPLAY (not re-commit)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		// Winner fully settles: caches the durable result and releases its claim.
		await store.set("proj-1", "batch-late", { body: { imageIds: ["first.png"] }, status: 200 });
		// A late request arrives AFTER the top-of-route GET would have missed in a tight
		// race — but the re-check under the freshly-taken claim catches the settled result.
		let commits = 0;
		const late = await simulateUploadTransform(store, "proj-1", "batch-late", async () => {
			commits += 1;
			return { status: 200, body: { imageIds: ["second.png"] } };
		});
		expect(commits).toBe(0); // never re-committed after settle.
		expect(late.body).toEqual({ imageIds: ["first.png"] });
		expect(late.committed).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM HEARTBEAT (codex P2): a commit slower than the claim TTL must NOT let the
// claim expire mid-flight (which would let a retry win a NEW claim, miss the still-
// empty result cache, and RE-COMMIT — and worse, let the slow winner's release delete
// the retry's newer claim). The fix: a unique ownership token + a heartbeat that renews
// the claim while the commit runs + a compare-and-delete release. These tests prove the
// slow-commit case commits EXACTLY ONCE, that WITHOUT a heartbeat the stale release is a
// no-op, and that the heartbeat is cleared on both completion and throw.
// ─────────────────────────────────────────────────────────────────────────────

describe("upload-batch idempotency claim heartbeat (codex P2)", () => {
	test("a SLOW commit (beyond the claim TTL) with a heartbeat NEVER expires mid-commit → ONE commit, loser replays", async () => {
		// Tiny claim TTL (40ms) vs a slow commit (~150ms) — WITHOUT a heartbeat the claim
		// would expire mid-commit and the retry would re-commit. The heartbeat renews it.
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 40);
		let commits = 0;
		const slowCommit = async () => {
			commits += 1;
			await new Promise((r) => setTimeout(r, 150)); // exceeds the 40ms claim TTL.
			return { status: 200, body: { imageIds: [`img-${commits}.png`] } };
		};
		const winner = simulateUploadTransform(store, "proj-1", "batch-slowhb", slowCommit, {
			heartbeat: true,
			heartbeatIntervalMs: 10, // ~TTL/4 — renews well within the 40ms TTL.
			claimTtlMs: 40,
		});
		// A retry races in AFTER the original TTL would have lapsed (60ms > 40ms TTL); with
		// the heartbeat the claim is STILL held, so the retry is a loser → it replays.
		await new Promise((r) => setTimeout(r, 60));
		const retry = await simulateUploadTransform(store, "proj-1", "batch-slowhb", slowCommit, {
			heartbeat: true,
			heartbeatIntervalMs: 10,
			claimTtlMs: 40,
			waitMs: 1_000,
			pollMs: 5,
		});
		const winnerResult = await winner;
		// EXACTLY ONE commit happened despite the commit outlasting the claim TTL.
		expect(commits).toBe(1);
		expect(winnerResult.committed).toBe(true);
		expect(retry.committed).toBe(false); // the retry replayed the winner's cached result.
		expect(retry.status).toBe(200);
		expect(retry.body).toEqual(winnerResult.body);
	});

	test("heartbeat stays alive through the post-commit cache window so a retry cannot re-claim and duplicate", async () => {
		// This pins the narrow route gap: commit has returned, but the 2xx replay result
		// has not been cached/released yet. The heartbeat must still own the claim here.
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 40);
		let commits = 0;
		let inPostCommitCacheGap = false;
		const winner = simulateUploadTransform(
			store,
			"proj-1",
			"batch-cache-gap",
			async () => {
				commits += 1;
				return { status: 200, body: { imageIds: [`img-${commits}.png`] } };
			},
			{
				heartbeat: true,
				heartbeatIntervalMs: 10,
				claimTtlMs: 40,
				afterCommitBeforeCache: async () => {
					inPostCommitCacheGap = true;
					await new Promise((r) => setTimeout(r, 150));
				},
			},
		);

		for (let i = 0; i < 100 && !inPostCommitCacheGap; i += 1) {
			await new Promise((r) => setTimeout(r, 1));
		}
		expect(inPostCommitCacheGap).toBe(true);
		await new Promise((r) => setTimeout(r, 60)); // beyond the 40ms claim TTL.

		const retry = await simulateUploadTransform(
			store,
			"proj-1",
			"batch-cache-gap",
			async () => {
				commits += 1;
				return { status: 200, body: { imageIds: [`duplicate-${commits}.png`] } };
			},
			{
				heartbeat: true,
				heartbeatIntervalMs: 10,
				claimTtlMs: 40,
				waitMs: 1_000,
				pollMs: 5,
			},
		);
		const winnerResult = await winner;

		expect(commits).toBe(1);
		expect(winnerResult.committed).toBe(true);
		expect(retry.committed).toBe(false);
		expect(retry.status).toBe(200);
		expect(retry.body).toEqual(winnerResult.body);
	});

	test("WITHOUT a heartbeat the slow winner's release does NOT delete the retry's newer claim (token mismatch no-op)", async () => {
		// Simulate the pre-fix timing WITHOUT a heartbeat: the claim TTL lapses mid-commit.
		let clock = 20_000_000;
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 1_000);
		// Slow winner claims at t0.
		const staleToken = await store.tryClaim("proj-1", "batch-nohb", clock);
		expect(staleToken).toBeTruthy();
		// The claim TTL (1s) lapses while the winner is still committing (no heartbeat).
		clock += 1_500;
		// A retry wins a NEW claim with a NEW token.
		const freshToken = await store.tryClaim("proj-1", "batch-nohb", clock);
		expect(freshToken).toBeTruthy();
		expect(freshToken).not.toBe(staleToken);
		// The slow winner FINALLY finishes and releases with its STALE token — compare-and-
		// delete sees a mismatch → NO-OP. The retry's newer claim is NOT deleted.
		await store.releaseClaim("proj-1", "batch-nohb", staleToken!);
		expect(await store.tryClaim("proj-1", "batch-nohb", clock)).toBeNull(); // newer claim survives.
		// (The stale winner's result-cache SET still lands; the retry, a loser, replays it.)
	});

	test("the heartbeat is CLEARED on a successful completion (no renewals after stop)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		let renews = 0;
		const renewSpy: Pick<UploadBatchIdempotencyStore, "renewClaim"> = {
			renewClaim: async (p, b, t, n) => {
				renews += 1;
				return store.renewClaim(p, b, t, n);
			},
		};
		const token = await store.tryClaim("proj-1", "batch-hb-stop");
		expect(token).toBeTruthy();
		const hb = startClaimHeartbeat(renewSpy, "proj-1", "batch-hb-stop", token!, { intervalMs: 5 });
		await new Promise((r) => setTimeout(r, 35)); // a few ticks fire.
		const renewsBeforeStop = renews;
		expect(renewsBeforeStop).toBeGreaterThan(0); // it WAS heartbeating.
		hb.stop();
		await new Promise((r) => setTimeout(r, 30)); // wait past several would-be ticks.
		expect(renews).toBe(renewsBeforeStop); // NO further renewals after stop().
		// stop() is idempotent.
		hb.stop();
	});

	test("the heartbeat is CLEARED even when the commit THROWS (release-on-throw path)", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		let renews = 0;
		const renewSpy: UploadBatchIdempotencyStore = {
			get: store.get.bind(store),
			set: store.set.bind(store),
			tryClaim: store.tryClaim.bind(store),
			releaseClaim: store.releaseClaim.bind(store),
			renewClaim: async (p, b, t, n) => {
				renews += 1;
				return store.renewClaim(p, b, t, n);
			},
			clear: store.clear.bind(store),
		};
		await expect(
			simulateUploadTransform(
				renewSpy,
				"proj-1",
				"batch-hb-throw",
				async () => {
					await new Promise((r) => setTimeout(r, 30)); // heartbeat ticks while committing.
					throw new Error("storage down");
				},
				{ heartbeat: true, heartbeatIntervalMs: 5, claimTtlMs: 60_000 },
			),
		).rejects.toThrow("storage down");
		const renewsAtThrow = renews;
		// The claim was released on throw (token compare-and-delete) → re-claimable.
		expect(await renewSpy.tryClaim("proj-1", "batch-hb-throw")).toBeTruthy();
		await new Promise((r) => setTimeout(r, 30)); // past several would-be ticks.
		expect(renews).toBe(renewsAtThrow); // heartbeat stopped — NO renewals after the throw.
	});

	test("a heartbeat whose claim was LOST (token gone) stops and signals via onClaimLost", async () => {
		const store = new MemoryUploadBatchIdempotencyStore(60_000, 60_000);
		const token = await store.tryClaim("proj-1", "batch-hb-lost");
		expect(token).toBeTruthy();
		let lost = false;
		const hb = startClaimHeartbeat(store, "proj-1", "batch-hb-lost", token!, {
			intervalMs: 5,
			onClaimLost: () => {
				lost = true;
			},
		});
		// Simulate an external flush: the claim VANISHES out from under the live winner.
		await store.clear();
		// The next heartbeat tick sees the token gone → reports lost + stops (commit continues).
		await new Promise((r) => setTimeout(r, 30));
		expect(lost).toBe(true);
		hb.stop();
	});
});
