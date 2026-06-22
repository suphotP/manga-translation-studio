import { RedisClient } from "bun";
import { SingleFlight } from "./single-flight.js";

/**
 * A tiny read-through TTL cache for expensive, NON-user-specific aggregate
 * responses (e.g. admin revenue summaries that re-scan a table on every load).
 *
 * Design rules:
 * - FAIL-OPEN: a cache backend error (Redis down, malformed entry) must NEVER
 *   break the endpoint — on any error we fall back to computing the value fresh.
 * - LEAK-SAFE BY CONSTRUCTION: this cache keys ONLY by the string you pass. It
 *   is the caller's responsibility to put EVERY input that changes the output
 *   into the key. Use it ONLY for responses that are identical for every caller
 *   authorized to hit the endpoint (i.e. global/admin data, not per-tenant data
 *   keyed by the request's own identity), or include that identity in the key.
 */
export interface ResponseCache {
	getOrSet<T>(key: string, ttlSeconds: number, compute: () => Promise<T> | T): Promise<T>;
}

/** Never caches — always computes fresh. Default when Redis is absent or in tests. */
export class NoopResponseCache implements ResponseCache {
	// Deliberately NOT single-flighted: "noop" means NO caching semantics at all,
	// so every caller must see its own fresh compute. Coalescing here would make
	// concurrent callers silently share one result — caching behaviour the noop
	// exists precisely to avoid. Pure passthrough.
	async getOrSet<T>(_key: string, _ttlSeconds: number, compute: () => Promise<T> | T): Promise<T> {
		return await compute();
	}
}

/**
 * Single-process in-memory TTL cache. Useful for local dev and as an injectable
 * test double (pass a fake `now` to exercise expiry deterministically).
 */
export class MemoryResponseCache implements ResponseCache {
	private readonly store = new Map<string, { value: string; expiresAt: number }>();
	private readonly flight = new SingleFlight();
	constructor(private readonly now: () => number = () => Date.now()) {}

	async getOrSet<T>(key: string, ttlSeconds: number, compute: () => Promise<T> | T): Promise<T> {
		if (ttlSeconds <= 0) return await compute(); // ttl<=0 disables caching entirely
		const hit = this.store.get(key);
		if (hit && hit.expiresAt > this.now()) return JSON.parse(hit.value) as T;
		// Coalesce concurrent misses for this key onto a single compute (re-check the
		// store inside the flight: a flight started by an earlier caller may have
		// just populated it, so a waiter that joins late still avoids recomputing).
		return await this.flight.run(key, async () => {
			const cached = this.store.get(key);
			const t = this.now();
			if (cached && cached.expiresAt > t) return JSON.parse(cached.value) as T;
			const value = await compute();
			this.store.set(key, { value: JSON.stringify(value), expiresAt: t + ttlSeconds * 1000 });
			return value;
		});
	}
}

interface RedisLikeClient {
	send(command: string, args: string[]): unknown | Promise<unknown>;
}

/**
 * Redis-backed TTL cache. Stores JSON strings with a server-side EX expiry so a
 * stale entry can never outlive its TTL even if this process never runs again.
 * Every Redis call is wrapped so a backend failure degrades to compute-fresh.
 */
export class RedisResponseCache implements ResponseCache {
	private readonly flight = new SingleFlight();
	constructor(private readonly client: RedisLikeClient, private readonly prefix = "rcache:") {}

	async getOrSet<T>(key: string, ttlSeconds: number, compute: () => Promise<T> | T): Promise<T> {
		// ttl<=0 disables caching entirely — never touch Redis (no GET, no SET), so an
		// operator can turn caching off (e.g. REVENUE_CACHE_TTL_SECONDS=0) and be sure
		// no stale entry is served or written.
		if (ttlSeconds <= 0) return await compute();
		const k = this.prefix + key;
		// Coalesce concurrent callers for this key onto a single GET→compute→SET. The
		// in-flight promise is keyed by the un-prefixed `key` (same namespace the
		// store uses); a single Redis GET serves all coalesced waiters on a hit, and a
		// single compute serves them on a miss. A GET ERROR still degrades to compute
		// INSIDE the flight (fail-open) — coalescing only changes how many computes run,
		// never whether an error blocks the response.
		// (Cross-instance coalescing via SET-NX is out of scope; see SingleFlight.)
		return await this.flight.run(key, async () => {
			try {
				const raw = await this.client.send("GET", [k]);
				if (typeof raw === "string") return JSON.parse(raw) as T;
			} catch {
				// fail-open: a read error must not block the response
			}
			const value = await compute();
			try {
				await this.client.send("SET", [k, JSON.stringify(value), "EX", String(Math.max(1, Math.floor(ttlSeconds)))]);
			} catch {
				// fail-open: the value is already computed; a write miss only costs a future cache miss
			}
			return value;
		});
	}
}

let sharedCache: ResponseCache | undefined;

/**
 * Process-wide cache. Uses Redis when REDIS_URL is set (and not under test);
 * otherwise NoopResponseCache so dev/test always see fresh, never-stale data.
 */
export function getResponseCache(): ResponseCache {
	if (!sharedCache) {
		const url = process.env.REDIS_URL?.trim();
		sharedCache = url && process.env.NODE_ENV !== "test"
			? new RedisResponseCache(new RedisClient(url) as unknown as RedisLikeClient)
			: new NoopResponseCache();
	}
	return sharedCache;
}
