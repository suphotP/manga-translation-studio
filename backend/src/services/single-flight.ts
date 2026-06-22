export type SingleFlightTask<T> = () => Promise<T> | T;

/**
 * Per-key in-process single-flight coalescer.
 *
 * The first caller for a key owns the work; concurrent callers for the same key
 * await that promise instead of repeating the expensive computation. Entries are
 * cleared on settle so failures never poison a key and the next caller can retry.
 */
export class SingleFlight {
	private readonly inflight = new Map<string, Promise<unknown>>();

	run<T>(key: string, task: SingleFlightTask<T>): Promise<T> {
		const existing = this.inflight.get(key);
		if (existing) return existing as Promise<T>;

		const promise = Promise.resolve()
			.then(task)
			.finally(() => {
				// Guard the delete so a future refactor cannot let an older promise erase
				// a newer flight for the same key.
				if (this.inflight.get(key) === promise) this.inflight.delete(key);
			});
		this.inflight.set(key, promise);
		return promise;
	}

	clear(): void {
		this.inflight.clear();
	}

	get size(): number {
		return this.inflight.size;
	}
}

export interface SignatureTtlSingleFlightCacheOptions {
	maxEntries: number;
	ttlMs: number;
	now?: () => number;
}

interface SignatureTtlSingleFlightCacheEntry<TValue> {
	signature: string;
	expiresAt: number;
	value: TValue;
}

/**
 * Tiny in-memory TTL cache for derived values whose freshness is validated by a
 * cheap caller-provided signature. Cache misses for the same key+signature are
 * single-flighted so TTL expiry does not trigger a thundering herd.
 */
export class SignatureTtlSingleFlightCache<TValue> {
	private readonly entries = new Map<string, SignatureTtlSingleFlightCacheEntry<TValue>>();
	private readonly flight = new SingleFlight();
	private readonly maxEntries: number;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options: SignatureTtlSingleFlightCacheOptions) {
		this.maxEntries = Math.max(0, Math.floor(options.maxEntries));
		this.ttlMs = Math.max(0, Math.floor(options.ttlMs));
		this.now = options.now ?? Date.now;
	}

	get(key: string, signature: string): TValue | undefined {
		return this.getFreshEntry(key, signature)?.value;
	}

	async getOrSet(key: string, signature: string, compute: SingleFlightTask<TValue>): Promise<TValue> {
		const cached = this.getFreshEntry(key, signature);
		if (cached) return cached.value;
		if (this.maxEntries === 0 || this.ttlMs === 0) return await compute();

		return await this.flight.run(this.flightKey(key, signature), async () => {
			const fresh = this.getFreshEntry(key, signature);
			if (fresh) return fresh.value;
			const value = await compute();
			this.set(key, signature, value);
			return value;
		});
	}

	set(key: string, signature: string, value: TValue): void {
		if (this.maxEntries === 0 || this.ttlMs === 0) return;
		this.entries.delete(key);
		this.entries.set(key, {
			signature,
			expiresAt: this.now() + this.ttlMs,
			value,
		});
		while (this.entries.size > this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey === undefined) break;
			this.entries.delete(oldestKey);
		}
	}

	clear(): void {
		this.entries.clear();
		this.flight.clear();
	}

	get size(): number {
		return this.entries.size;
	}

	get inflightSize(): number {
		return this.flight.size;
	}

	private getFreshEntry(key: string, signature: string): SignatureTtlSingleFlightCacheEntry<TValue> | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		if (entry.signature !== signature) return undefined;
		// Refresh recency so hot keys are less likely to be evicted under the cap.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry;
	}

	private flightKey(key: string, signature: string): string {
		// The signature is part of the flight identity so a real data change does not
		// make a newer request await an older aggregate that had a different signature.
		return JSON.stringify([key, signature]);
	}
}
