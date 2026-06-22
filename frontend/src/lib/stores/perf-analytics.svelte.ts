// Performance-analytics store.
//
// Loads the ANONYMIZED workspace performance aggregate (/api/perf/workspace) for
// the dashboard analytics section. The aggregate is visible to every workspace
// member (read_workspace), so it is safe to load from the shared dashboard.
//
// Like the usage store, the dashboard NEVER fabricates performance figures: if no
// aggregate is loaded (or no work events recorded), the analytics section shows an
// honest empty state. The store owns its own opt-in polling lifecycle, mirroring
// usageStore so the two refresh on the same cadence.

import * as api from "$lib/api/client.ts";
import type { PerfWorkspaceAggregate } from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { billingStore } from "$lib/stores/billing.svelte.ts";

const REFRESH_INTERVAL_MS = 60_000;
const AUTH_RESUME_CHECK_MS = 1_500;
// While PAUSED with an unchanged-but-authenticated session (transient refresh
// failure: 429/5xx/network kept the same token), retry on this backoff instead
// of waiting for an auth change that may never come — apiFetch re-attempts the
// refresh on the next request, so one probe a minute self-heals the poller
// without recreating the original 401-every-few-seconds spam.
const AUTH_PAUSED_RETRY_MS = 60_000;
const AUTH_FAILURE_PAUSE_THRESHOLD = 1;

function authSnapshot(): string | null {
	return authStore.isAuthenticated ? authStore.accessToken : null;
}

function isAuthPollingError(error: unknown): boolean {
	return error instanceof api.ApiError && (error.status === 401 || error.status === 403);
}

class PerfAnalyticsStore {
	aggregate = $state<PerfWorkspaceAggregate | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	lastLoadedAt = $state<number | null>(null);
	currentWorkspaceId = $state<string | null>(null);

	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private authResumeTimer: ReturnType<typeof setInterval> | null = null;
	private pausedAt: number | null = null;
	private pollingWorkspaceId: string | null = null;
	private pollingIntervalMs = REFRESH_INTERVAL_MS;
	private consecutiveAuthFailures = 0;
	private lastAuthSnapshot: string | null = null;

	async load(workspaceId?: string | null): Promise<void> {
		const wsId = (workspaceId ?? this.currentWorkspaceId ?? billingStore.currentWorkspaceId)?.trim();
		if (!wsId) {
			this.aggregate = null;
			return;
		}
		this.loading = true;
		this.error = null;
		try {
			const result = await api.getPerfWorkspaceAggregate(wsId);
			this.aggregate = result.aggregate;
			this.lastLoadedAt = Date.now();
			this.currentWorkspaceId = wsId;
			this.consecutiveAuthFailures = 0;
		} catch (error) {
			// Drop the stale aggregate so a failed refresh (workspace switch, expired
			// session, missing workspace store) never keeps rendering the old/empty
			// workspace's performance numbers under a new context.
			this.aggregate = null;
			this.lastLoadedAt = null;
			this.currentWorkspaceId = wsId;
			this.error = error instanceof Error ? error.message : "โหลดข้อมูลประสิทธิภาพไม่สำเร็จ";
			this.maybePausePollingForAuthError(error);
		} finally {
			this.loading = false;
		}
	}

	startPolling(workspaceId: string | null, intervalMs = REFRESH_INTERVAL_MS): () => void {
		this.stopPolling();
		const wsId = workspaceId?.trim() || null;
		if (!wsId) return () => {};
		this.pollingWorkspaceId = wsId;
		this.pollingIntervalMs = intervalMs;
		this.consecutiveAuthFailures = 0;
		this.lastAuthSnapshot = authSnapshot();
		this.ensureAuthResumeWatcher();
		if (!this.lastAuthSnapshot) {
			// Workspace selection can remain in storage after logout; do not let a
			// protected perf poll start until auth restore has actually finished.
			return () => this.stopPolling();
		}
		this.startActivePolling();
		return () => this.stopPolling();
	}

	stopPolling(): void {
		this.clearPollTimer();
		this.clearAuthResumeWatcher();
		this.pollingWorkspaceId = null;
		this.consecutiveAuthFailures = 0;
		this.lastAuthSnapshot = null;
	}

	private startActivePolling(): void {
		this.clearPollTimer();
		const wsId = this.pollingWorkspaceId;
		if (!wsId) return;
		void this.load(wsId);
		this.pollTimer = setInterval(() => {
			const activeAuth = authSnapshot();
			if (!activeAuth) {
				this.pausePollingUntilAuthChanges();
				return;
			}
			void this.load(wsId);
		}, this.pollingIntervalMs);
	}

	private clearPollTimer(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private ensureAuthResumeWatcher(): void {
		if (this.authResumeTimer || typeof window === "undefined") return;
		this.authResumeTimer = setInterval(() => {
			const current = authSnapshot();
			const changed = current !== this.lastAuthSnapshot;
			this.lastAuthSnapshot = current;
			if (!current) {
				if (this.pollTimer) this.pausePollingUntilAuthChanges();
				return;
			}
			// Resume on a REAL auth change, or — still authenticated but unchanged
			// (transient refresh failure kept the same token) — retry on backoff so
			// the poller can never park forever inside a live session (codex P2).
			const backoffElapsed = this.pausedAt !== null && Date.now() - this.pausedAt >= AUTH_PAUSED_RETRY_MS;
			if ((changed || backoffElapsed) && this.pollingWorkspaceId && !this.pollTimer) {
				this.consecutiveAuthFailures = 0;
				this.pausedAt = null;
				this.startActivePolling();
			}
		}, AUTH_RESUME_CHECK_MS);
	}

	private clearAuthResumeWatcher(): void {
		if (this.authResumeTimer) {
			clearInterval(this.authResumeTimer);
			this.authResumeTimer = null;
		}
	}

	private pausePollingUntilAuthChanges(): void {
		this.clearPollTimer();
		this.pausedAt = Date.now();
		this.ensureAuthResumeWatcher();
	}

	private maybePausePollingForAuthError(error: unknown): void {
		if (!isAuthPollingError(error)) {
			this.consecutiveAuthFailures = 0;
			return;
		}
		if (!this.pollingWorkspaceId) return;
		this.consecutiveAuthFailures += 1;
		if (this.consecutiveAuthFailures >= AUTH_FAILURE_PAUSE_THRESHOLD) {
			// apiFetch already tried refresh-on-401; more interval hits only repeat
			// the expired session until authStore observes a new token.
			this.pausePollingUntilAuthChanges();
		}
	}

	/**
	 * Stop polling and drop all loaded state. Called on logout / unauth so the
	 * dashboard never keeps rendering a signed-out workspace's performance
	 * numbers and no protected /api/perf/workspace poll survives the session.
	 */
	reset(): void {
		this.stopPolling();
		this.aggregate = null;
		this.loading = false;
		this.error = null;
		this.lastLoadedAt = null;
		this.currentWorkspaceId = null;
	}

	__resetForTesting(): void {
		this.reset();
	}
}

export const perfAnalyticsStore = new PerfAnalyticsStore();
