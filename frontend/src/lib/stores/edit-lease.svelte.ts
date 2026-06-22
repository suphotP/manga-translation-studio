// Concurrent-edit Phase 1 — page soft-lease lifecycle.
//
// When a user opens a page in the editor we ACQUIRE a soft lease on the page's
// canonical lock unit, RENEW it via heartbeat while editing, and RELEASE it on
// page-switch / editor-close. Auto-expiry on the backend guarantees the lease
// can NEVER lock a user out permanently (a crashed/closed tab's lease just
// expires).
//
// The lease STEERS users before they overlap; CAS on save remains the final net
// (see project.svelte.ts assertNoStaleRemoteOverwrite + commitProjectStateWithCas)
// and the #412 recovery-draft handles the rare true conflict. This store never
// blocks the editor — every failure degrades to "edit anyway", because a lock
// service hiccup must not stop work.
//
// Outcomes surfaced to the UI (editLease.status):
//   - "held"            → this tab owns the lease, free to edit.
//   - "held-by-other"   → ANOTHER user holds it; offer View / Take over.
//   - "held-by-self-tab"→ THIS user's OTHER tab holds it; offer Continue here.
//   - "taken-over"      → our lease was STOLEN (heartbeat 404/409 after a takeover);
//                          editor goes read-only + a recovery draft is snapshotted.
//   - "unavailable"     → lock service down / file-mode; edit anyway (CAS still guards).
//   - "idle"            → no page open.

import {
	acquireWorkLock,
	extendWorkLock,
	releaseWorkLock,
	ApiError,
	type WorkLockHandle,
} from "$lib/api/client.ts";
import { editSessionStore } from "./edit-session.svelte.ts";
import { pageLockId } from "$lib/collab/page-lock-id.ts";

// Active edit leases use a short TTL with a frequent heartbeat so a disconnect
// frees the page quickly (spec §3). 3 min lease, renew every 25 s.
const LEASE_DURATION_MIN = 3;
const HEARTBEAT_MS = 25_000;
const LOCK_SERVICE_BACKOFF_BASE_MS = 30_000;
const LOCK_SERVICE_BACKOFF_MAX_MS = 120_000;
// Tolerate this many CONSECUTIVE transient heartbeat failures (network blip / 5xx)
// before conservatively stepping back from "held" — so a single flake never nukes an
// editing session. A definitive 404/409 takeover is handled immediately, regardless.
const MAX_TRANSIENT_HEARTBEAT_FAILURES = 3;

export type LeaseStatus = "idle" | "held" | "held-by-other" | "held-by-self-tab" | "taken-over" | "unavailable";

/**
 * Fired when THIS tab's active lease is lost to a takeover (heartbeat reports the
 * lock is gone / re-held by someone else). The project store wires this to flip the
 * editor read-only, cancel the pending autosave, and snapshot a recovery draft so
 * the displaced holder never silently loses work — and never re-acquires (which
 * would resurrect a surrendered lease and let them keep clobbering, C2/C3).
 */
export type TakenOverHandler = () => void;

export interface LeaseConflictInfo {
	heldByUserId?: string;
	/** Present only for a same-user-other-tab conflict. */
	heldByClientId?: string;
	expiresAt?: string;
	lockId?: string;
}

export interface LeaseUnavailableInfo {
	code?: string;
	lastErrorAt: number;
	retryAt: number;
	attempt: number;
}

/**
 * Canonical page lock unit (spec §2). NOT the raw image id — `project:page:n`,
 * which is the id the backend lock subject resolver + workflow-submit release
 * path both key on. Re-exported from the shared {@link pageLockId} helper so the
 * lease store, the presence UI (LockOwnerIndicator) and the multi-page gate all
 * derive the SAME id — acquire and lookup can never drift apart.
 */
export const pageLockUnitId = pageLockId;

interface LeaseTarget {
	projectId: string;
	pageIndex: number;
	workspaceId?: string;
}

class EditLeaseStore {
	status = $state<LeaseStatus>("idle");
	conflict = $state<LeaseConflictInfo | null>(null);
	unavailable = $state<LeaseUnavailableInfo | null>(null);

	/** The unit this tab is currently trying to / does hold. */
	private currentUnitId: string | null = null;
	private currentTarget: LeaseTarget | null = null;
	private handle: WorkLockHandle | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private acquireRetryTimer: ReturnType<typeof setTimeout> | null = null;
	// Monotonic token so a slow acquire from a previous page can't clobber a
	// newer page's lease state (same pattern as the editor's pageLoadGeneration).
	private generation = 0;
	private takenOverHandler: TakenOverHandler | null = null;
	// Count consecutive transient heartbeat errors (network blip / 5xx) so a single
	// flake does NOT nuke an editing session; only a definitive lost-lease signal
	// (404/409) flips us to "taken-over".
	private transientHeartbeatFailures = 0;
	private lockServiceFailureAttempts = 0;

	get heldByOther(): boolean {
		return this.status === "held-by-other";
	}

	get takenOver(): boolean {
		return this.status === "taken-over";
	}

	/**
	 * The id of the lock this tab currently holds, if any. The save path sends it as
	 * `x-edit-lock-id` so the backend can reject a displaced holder's in-flight save
	 * (C1) instead of letting its still-matching CAS baseline clobber the new holder.
	 */
	get heldLockId(): string | null {
		return this.status === "held" ? this.handle?.lockId ?? null : null;
	}

	/**
	 * True while a PAGE-EDIT session is in progress for this tab — i.e. a page is open
	 * in the editor and a lease is EXPECTED — regardless of the current lease status.
	 * Stays true across a takeover ("taken-over") and a lock-service outage
	 * ("unavailable"); only `endPageEdit`/release clears it. The save path sends this as
	 * `x-edit-page-scoped` so the backend's P0-2 prod gate can REQUIRE the lease header
	 * for page-scoped saves — a displaced/buggy client can no longer dodge the lease
	 * check by simply omitting `x-edit-lock-id` (a takeover writes no project state, so
	 * CAS alone can't catch it). A non-page save (metadata-only, no page open) sends no
	 * marker and is never subject to the requirement.
	 */
	get pageEditScopeActive(): boolean {
		return this.currentUnitId !== null;
	}

	/** Register the callback fired when this tab's lease is taken over (C2/C3). */
	onTakenOver(handler: TakenOverHandler | null): void {
		this.takenOverHandler = handler;
	}

	get heldBySelfOtherTab(): boolean {
		return this.status === "held-by-self-tab";
	}

	get isHeld(): boolean {
		return this.status === "held";
	}

	/**
	 * Begin editing a page: acquire (or steer on) its soft lease. Releases any
	 * lease held for a different page first. Idempotent for the same unit.
	 */
	async beginPageEdit(target: LeaseTarget): Promise<void> {
		const unitId = pageLockUnitId(target.projectId, target.pageIndex);
		if (this.currentUnitId === unitId && (this.status === "held")) return;
		if (this.currentUnitId === unitId && this.isAcquireBackoffActive()) {
			this.status = "unavailable";
			this.scheduleAcquireRetry(unitId, target, this.generation, false);
			return;
		}
		editSessionStore.wire();
		// When THIS user's other tab takes over a unit we hold, flush+release here
		// so the takeover is clean (the active editor designation moves to the other
		// tab). Registered once; idempotent for the same handler.
		editSessionStore.onReleaseRequest((requestedUnitId) => {
			if (requestedUnitId === this.currentUnitId) void this.endPageEdit();
		});
		const generation = ++this.generation;
		await this.releaseInternal();
		this.currentUnitId = unitId;
		this.currentTarget = target;
		editSessionStore.announceEditing(unitId);
		await this.acquire(unitId, target, generation, false);
	}

	/** Stop editing the current page and release its lease. */
	async endPageEdit(): Promise<void> {
		this.generation += 1;
		await this.releaseInternal();
		this.status = "idle";
		this.conflict = null;
	}

	/**
	 * Take over a lease currently held by THIS user's other tab (or, when allowed
	 * elsewhere, another holder). Asks the peer tab to flush+release over the
	 * BroadcastChannel first, then re-acquires with takeover so the backend frees
	 * the old client_id's lock as the durable fallback.
	 */
	async takeOver(): Promise<void> {
		const unitId = this.currentUnitId;
		const target = this.currentTarget;
		if (!unitId || !target) return;
		editSessionStore.requestReleaseFromPeer(unitId);
		const generation = ++this.generation;
		await this.acquire(unitId, target, generation, true);
	}

	private async acquire(unitId: string, target: LeaseTarget, generation: number, takeover: boolean): Promise<void> {
		if (!takeover && this.isAcquireBackoffActive()) {
			this.status = "unavailable";
			this.scheduleAcquireRetry(unitId, target, generation, false);
			return;
		}
		try {
			const handle = await acquireWorkLock({
				scope: "page",
				scopeId: unitId,
				projectId: target.projectId,
				workspaceId: target.workspaceId,
				durationMin: LEASE_DURATION_MIN,
				clientId: editSessionStore.clientId,
				takeover,
			});
			if (generation !== this.generation) {
				// A newer page took over while we were acquiring — release this one.
				void releaseWorkLock(handle.lockId).catch(() => {});
				return;
			}
			this.handle = handle;
			this.status = "held";
			this.conflict = null;
			this.transientHeartbeatFailures = 0;
			this.clearUnavailableBackoff();
			this.startHeartbeat();
		} catch (error) {
			if (generation !== this.generation) return;
			this.applyAcquireError(error, unitId, target, generation, takeover);
		}
	}

	private applyAcquireError(error: unknown, unitId: string, target: LeaseTarget, generation: number, takeover: boolean): void {
		this.stopHeartbeat();
		this.handle = null;
		if (error instanceof ApiError && error.status === 409) {
			this.clearUnavailableBackoff();
			const body = (error.body ?? {}) as Record<string, unknown>;
			const info: LeaseConflictInfo = {
				heldByUserId: typeof body.held_by_user_id === "string" ? body.held_by_user_id : undefined,
				heldByClientId: typeof body.held_by_client_id === "string" ? body.held_by_client_id : undefined,
				expiresAt: typeof body.expires_at === "string" ? body.expires_at : undefined,
				lockId: typeof body.lock_id === "string" ? body.lock_id : undefined,
			};
			this.conflict = info;
			this.status = error.code === "lock_same_user_conflict" ? "held-by-self-tab" : "held-by-other";
			return;
		}
		// Timed retry/backoff is ONLY for retryable failures: 503 lock-service
		// outage or a network error. A 403/404-class ApiError is a settled
		// condition — retry loops would hide the real problem and the backoff
		// window would suppress legitimate later acquires (codex P2).
		const retryable = !(error instanceof ApiError) || error.status === 503 || error.status === 0;
		this.conflict = null;
		this.status = "unavailable";
		if (retryable) {
			this.markUnavailable(error);
			this.scheduleAcquireRetry(unitId, target, generation, takeover);
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		if (typeof setInterval !== "function") return;
		this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
		(this.heartbeatTimer as { unref?: () => void }).unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private async heartbeat(): Promise<void> {
		const handle = this.handle;
		const target = this.currentTarget;
		const unitId = this.currentUnitId;
		if (!handle || !target || !unitId) return;
		const generation = this.generation;
		try {
			const renewed = await extendWorkLock(handle.lockId, LEASE_DURATION_MIN);
			if (generation === this.generation) {
				this.handle = { ...handle, expiresAt: renewed.expiresAt };
				this.transientHeartbeatFailures = 0;
			}
		} catch (error) {
			if (generation !== this.generation) return;
			// A 404 (lease row gone — released / taken over / auto-expired) or 409
			// (re-held by someone else) is a DEFINITIVE lost-lease signal — and the
			// heartbeat itself is a reliable signal even when the SSE takeover notify
			// dropped (C2/C3). We must NOT silently re-acquire with takeover:false here:
			// that would resurrect a lease another holder already took over and let this
			// (now stale) tab keep editing + clobbering. Instead flip read-only + snapshot
			// a recovery draft (handleTakenOver), so no work is lost and the displaced
			// holder cannot overwrite the new holder.
			if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
				this.handleTakenOver(generation);
				return;
			}
			// Anything else (network blip, 5xx, timeout) is TRANSIENT — do NOT nuke the
			// session on a single flake. The lease has its own TTL; tolerate a few misses
			// and keep heartbeating. Only after several consecutive transient failures do
			// we conservatively step back to "unavailable" (edit anyway; CAS still guards)
			// rather than claim a confident "held".
			this.transientHeartbeatFailures += 1;
			if (this.transientHeartbeatFailures >= MAX_TRANSIENT_HEARTBEAT_FAILURES) {
				this.transientHeartbeatFailures = 0;
				this.stopHeartbeat();
				this.handle = null;
				this.status = "unavailable";
				this.conflict = null;
				this.markUnavailable(error);
				this.scheduleAcquireRetry(unitId, target, generation, false);
			}
		}
	}

	/**
	 * Our active lease was taken over (definitive heartbeat 404/409). Stop the
	 * heartbeat, drop the handle WITHOUT releasing (the new holder owns it now), flip
	 * to read-only, and fire the takeover handler so the project store cancels the
	 * pending autosave + snapshots a recovery draft. Never re-acquires (C2/C3).
	 */
	private handleTakenOver(generation: number): void {
		if (generation !== this.generation) return;
		this.stopHeartbeat();
		this.handle = null;
		this.transientHeartbeatFailures = 0;
		this.status = "taken-over";
		this.conflict = null;
		try {
			this.takenOverHandler?.();
		} catch {
			// The handler is best-effort safety UX; never let it throw out of a timer.
		}
	}

	private async releaseInternal(): Promise<void> {
		this.stopHeartbeat();
		this.clearAcquireRetryTimer();
		const handle = this.handle;
		const unitId = this.currentUnitId;
		this.handle = null;
		if (unitId) editSessionStore.announceStopped(unitId);
		this.currentUnitId = null;
		this.currentTarget = null;
		if (handle) {
			// Best-effort release; if it fails the backend TTL expires it anyway.
			await releaseWorkLock(handle.lockId).catch(() => {});
		}
	}

	private isAcquireBackoffActive(now = Date.now()): boolean {
		return Boolean(this.unavailable && this.unavailable.retryAt > now);
	}

	private markUnavailable(error: unknown): void {
		const now = Date.now();
		const attempt = this.lockServiceFailureAttempts + 1;
		const retryAfterMs = retryAfterMsFromError(error);
		const fallbackMs = Math.min(LOCK_SERVICE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), LOCK_SERVICE_BACKOFF_MAX_MS);
		const waitMs = retryAfterMs ?? fallbackMs;
		this.lockServiceFailureAttempts = attempt;
		this.unavailable = {
			code: error instanceof ApiError ? error.code : undefined,
			lastErrorAt: now,
			retryAt: now + waitMs,
			attempt,
		};
	}

	private clearUnavailableBackoff(): void {
		this.clearAcquireRetryTimer();
		this.unavailable = null;
		this.lockServiceFailureAttempts = 0;
	}

	private clearAcquireRetryTimer(): void {
		if (!this.acquireRetryTimer) return;
		clearTimeout(this.acquireRetryTimer);
		this.acquireRetryTimer = null;
	}

	private scheduleAcquireRetry(unitId: string, target: LeaseTarget, generation: number, takeover: boolean): void {
		this.clearAcquireRetryTimer();
		const retryAt = this.unavailable?.retryAt;
		if (!retryAt || typeof setTimeout !== "function") return;
		const delayMs = Math.max(0, retryAt - Date.now());
		// Retry only after the backend's retry-after/backoff window. This keeps a
		// down Redis/Postgres lock dependency from turning page opens into console spam.
		this.acquireRetryTimer = setTimeout(() => {
			this.acquireRetryTimer = null;
			if (generation !== this.generation || this.currentUnitId !== unitId || this.status !== "unavailable") return;
			void this.acquire(unitId, target, generation, takeover);
		}, delayMs);
		(this.acquireRetryTimer as { unref?: () => void }).unref?.();
	}

	__resetForTesting(): void {
		this.stopHeartbeat();
		this.clearAcquireRetryTimer();
		this.handle = null;
		this.currentUnitId = null;
		this.currentTarget = null;
		this.status = "idle";
		this.conflict = null;
		this.unavailable = null;
		this.generation = 0;
		this.transientHeartbeatFailures = 0;
		this.lockServiceFailureAttempts = 0;
		this.takenOverHandler = null;
	}

	/** Test hook: drive the heartbeat once without waiting for the interval. */
	async __heartbeatForTesting(): Promise<void> {
		await this.heartbeat();
	}

	/**
	 * Test/QA hook: force a steering state without a backend round-trip so the
	 * presence UI can be exercised in a real browser (E2E harness) and in unit
	 * tests. Inert in normal use.
	 */
	__setStateForTesting(status: LeaseStatus, conflict: LeaseConflictInfo | null = null): void {
		this.status = status;
		this.conflict = conflict;
	}
}

function retryAfterMsFromError(error: unknown): number | null {
	if (!(error instanceof ApiError)) return null;
	const retryAfter = error.retryAfter;
	if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter <= 0) return null;
	return Math.min(Math.ceil(retryAfter * 1000), LOCK_SERVICE_BACKOFF_MAX_MS);
}

export const editLeaseStore = new EditLeaseStore();
