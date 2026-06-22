// SSE-driven lock registry (W2.7).
//
// Subscribes to the realtime store and maintains an in-memory map of active
// soft-locks. The actual lock acquisition/release HTTP endpoints land with
// PR #85 (work-locks); this store is forward-compatible: any lock_acquired /
// lock_released SSE event mutates the registry so UI overlays
// (LockOwnerIndicator) reflect live ownership.

import { realtimeStore, type RealtimeEvent } from "./realtime.svelte.ts";
import { authStore } from "./auth.svelte.ts";
import { editSessionStore } from "./edit-session.svelte.ts";

export interface ActiveLock {
	lockId: string;
	scope: string;
	scopeId: string;
	owner?: string;
	/**
	 * The holder's per-tab id (SSE payload carries it). Lets the indicator tell a
	 * lock held by THIS very tab apart from one held by the same user's OTHER tab,
	 * so it never shows "you are editing" to the editing tab itself (C4).
	 */
	clientId?: string;
	projectId?: string;
	acquiredAt: number;
	expiresAt?: number;
}

// How often to sweep the registry for locks whose TTL has elapsed without a
// matching lock_released event (e.g. the owner tab crashed or the backend lock
// TTL expired). Without this the registry would show someone editing forever.
const LOCK_EXPIRY_SWEEP_MS = 5_000;

class LocksStore {
	locks = $state<Map<string, ActiveLock>>(new Map());
	private wired = false;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	get all(): ActiveLock[] {
		const now = Date.now();
		// Drop locks held by THIS tab so the presence overlay never tells the editing
		// tab "you are editing" (C4). A lock held by the same USER's OTHER tab is kept
		// — that is genuinely another session the user should be aware of.
		return Array.from(this.locks.values()).filter((lock) => !isLockExpired(lock, now) && !this.isSelfTabLock(lock));
	}

	getByScope(scope: string, scopeId: string): ActiveLock | undefined {
		const now = Date.now();
		for (const lock of this.locks.values()) {
			if (lock.scope === scope && lock.scopeId === scopeId && !isLockExpired(lock, now) && !this.isSelfTabLock(lock)) return lock;
		}
		return undefined;
	}

	/**
	 * True when `lock` is held by THIS very browser tab — same user AND same per-tab
	 * clientId. The indicator must not render for it (C4). When the SSE payload omits
	 * a clientId (legacy event) we fall back to a user-id match so we still suppress
	 * the user's own indicator rather than risk a false "you are editing" pill; the
	 * lease store already owns the authoritative "you hold this" state for this tab.
	 */
	private isSelfTabLock(lock: ActiveLock): boolean {
		const selfUserId = authStore.currentUser?.id;
		if (!selfUserId || !lock.owner || lock.owner !== selfUserId) return false;
		if (!lock.clientId) return true;
		return lock.clientId === editSessionStore.clientId;
	}

	wireToRealtime(): void {
		if (this.wired) return;
		this.wired = true;
		realtimeStore.on("lock_acquired", (event) => this.handleAcquired(event));
		realtimeStore.on("lock_released", (event) => this.handleReleased(event));
		this.startExpirySweep();
	}

	/**
	 * Periodically drop locks whose expiresAt has passed so a missed
	 * lock_released event doesn't leave a stale "X is editing" indicator on
	 * screen. Mutating the $state map triggers a reactive update so the overlay
	 * disappears. Idempotent — guarded against double-scheduling.
	 */
	private startExpirySweep(): void {
		if (this.sweepTimer || typeof setInterval !== "function") return;
		this.sweepTimer = setInterval(() => this.pruneExpired(), LOCK_EXPIRY_SWEEP_MS);
		(this.sweepTimer as { unref?: () => void }).unref?.();
	}

	private pruneExpired(): void {
		const now = Date.now();
		let removed = false;
		const next = new Map(this.locks);
		for (const [lockId, lock] of next) {
			if (isLockExpired(lock, now)) {
				next.delete(lockId);
				removed = true;
			}
		}
		if (removed) this.locks = next;
	}

	private handleAcquired(event: RealtimeEvent): void {
		const data = event.data as Partial<ActiveLock> | undefined;
		if (!data?.lockId || !data.scope || !data.scopeId) return;
		const expiresAt = typeof data.expiresAt === "string"
			? Date.parse(data.expiresAt) || undefined
			: typeof data.expiresAt === "number"
				? data.expiresAt
				: undefined;
		const next = new Map(this.locks);
		next.set(data.lockId, {
			lockId: data.lockId,
			scope: data.scope,
			scopeId: data.scopeId,
			owner: data.owner,
			// Capture the holder's tab id (work-locks.ts publishes it) so self-tab locks
			// can be filtered out of the presence overlay (C4).
			clientId: typeof data.clientId === "string" ? data.clientId : undefined,
			projectId: data.projectId,
			acquiredAt: event.emittedAt,
			expiresAt,
		});
		this.locks = next;
	}

	private handleReleased(event: RealtimeEvent): void {
		const data = event.data as Partial<ActiveLock> | undefined;
		if (!data?.lockId) return;
		if (!this.locks.has(data.lockId)) return;
		const next = new Map(this.locks);
		next.delete(data.lockId);
		this.locks = next;
	}

	__resetForTesting(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		this.locks = new Map();
		this.wired = false;
	}

	/** Test hook: force an expiry sweep without waiting for the interval. */
	__pruneExpiredForTesting(): void {
		this.pruneExpired();
	}
}

/**
 * A soft lock is expired once its TTL (expiresAt) has elapsed. Locks without an
 * expiresAt never auto-expire and are only removed by a lock_released event.
 */
function isLockExpired(lock: ActiveLock, now: number): boolean {
	return typeof lock.expiresAt === "number" && Number.isFinite(lock.expiresAt) && lock.expiresAt <= now;
}

export const locksStore = new LocksStore();
