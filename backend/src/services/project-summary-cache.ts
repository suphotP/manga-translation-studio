// Keyed LRU cache for the hottest read in the app: the workspace Library /
// dashboard project-summary listing (GET /api/project). The cache key is
// comprehensive (userId + workspaceId + cursor + auth/fallback config) so an
// entry is leak-safe — it can only ever be served back to the exact same
// (caller, scope, page) tuple that produced it.
//
// Why keyed (not a single slot): a single `{key, expiresAt, page}` slot is
// overwritten by any second concurrent caller, so under multi-user load every
// request misses its own key and falls through to a full recompute. A small
// keyed LRU lets distinct callers' pages coexist without thrashing.
//
// ACCEPTED STALENESS TRADEOFF (documented, intentional): this cache is
// per-instance (in-process) and bounded by a 1s TTL. In production the API runs
// multiple replicas, so a write on one replica does NOT invalidate another
// replica's cache — a reader can see up to ~1s of stale listing across
// replicas. That window is deliberately accepted: the 1s TTL bounds it, the
// listing is a soft view (not an authority for any decision), and the
// alternative (a shared/distributed invalidation bus for a 1s cache) is not
// worth the complexity. Within a single instance, writes call `.clear()` to
// invalidate eagerly (see below).

export interface ProjectSummaryCacheEntry<TPage> {
	page: TPage;
	expiresAt: number;
}

export interface ProjectSummaryCacheOptions {
	/** Hard cap on retained entries. Past the cap the oldest (least-recently
	 *  used) entry is evicted. */
	maxEntries: number;
	/** Per-entry time-to-live in milliseconds. */
	ttlMs: number;
	/** Injectable clock (defaults to Date.now) so tests can drive TTL expiry. */
	now?: () => number;
}

/**
 * A tiny insertion-ordered LRU. Recency is tracked by Map iteration order:
 * reading or writing a key deletes then re-sets it so it moves to the end
 * (most-recent); eviction removes the first (oldest) key once size exceeds the
 * cap. Expired entries are treated as misses and dropped on read.
 *
 * Invalidation: project writes change arbitrary listings (any key/cursor — a
 * new chapter shifts every page that could contain it), so there is no precise
 * key to evict. `clear()` (full flush) is the correct, simple invalidation at a
 * 1s TTL: cheap, and it cannot leave a stale page behind.
 */
export class ProjectSummaryCache<TPage> {
	private readonly entries = new Map<string, ProjectSummaryCacheEntry<TPage>>();
	private readonly maxEntries: number;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options: ProjectSummaryCacheOptions) {
		// A non-positive cap or TTL disables caching entirely (every read misses,
		// nothing is retained) rather than thrashing or growing unbounded.
		this.maxEntries = Math.max(0, Math.floor(options.maxEntries));
		this.ttlMs = Math.max(0, Math.floor(options.ttlMs));
		this.now = options.now ?? Date.now;
	}

	/** Return a live (non-expired) cached page for `key`, or undefined on miss.
	 *  A hit refreshes the entry's recency; an expired entry is dropped. */
	get(key: string): TPage | undefined {
		if (this.maxEntries === 0 || this.ttlMs === 0) return undefined;
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		// Refresh recency: re-insert at the tail.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.page;
	}

	/** Store `page` under `key` with a fresh TTL, evicting the oldest entry if
	 *  the cap is exceeded. */
	set(key: string, page: TPage): void {
		if (this.maxEntries === 0 || this.ttlMs === 0) return;
		// delete+set so an existing key moves to the tail (most-recent).
		this.entries.delete(key);
		this.entries.set(key, { page, expiresAt: this.now() + this.ttlMs });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	/** Drop every entry. Used by write paths to invalidate the listing. */
	clear(): void {
		this.entries.clear();
	}

	/** Current retained-entry count (test/observability helper). */
	get size(): number {
		return this.entries.size;
	}
}
