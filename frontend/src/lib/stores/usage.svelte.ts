// Usage store — Wave 2 W2.2.
//
// Reads /api/usage/workspace/:wsId/dashboard and exposes the aggregated
// storage/AI/member breakdown for the sidebar widgets and the dedicated
// usage page. Includes an opt-in 60-second polling lifecycle the usage
// page can install via $effect.root.

import { get } from "svelte/store";
import { _ } from "svelte-i18n";
import * as api from "$lib/api/client.ts";
import type { UsageDashboard, UsageDashboardMember, WorkspacePlanId } from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import {
	billingStore,
	internalPlanIdToPublicKey,
	type PublicPlanKey,
} from "$lib/stores/billing.svelte.ts";

// Public-facing label for each tier. Mirrors PlanBadge's LABEL map so the plan
// NAME shown anywhere (top-bar badge, dashboard pill, usage hero) always agrees
// with the badge tone — they resolve from the same place.
const PUBLIC_PLAN_LABEL: Record<PublicPlanKey, string> = {
	free: "Free",
	creator: "Creator",
	pro: "Pro",
	studio: "Studio",
	studio_plus: "Studio+",
};

// The usage dashboard's plan.id is an INTERNAL WorkspacePlanId; isWorkspacePlanId
// guards before mapping so an unexpected/empty id falls back to billing rather
// than crashing the badge.
function isInternalPlanId(id: string | null | undefined): id is WorkspacePlanId {
	return id === "free" || id === "creator" || id === "pro" || id === "studio" || id === "studio_plus";
}

export type StorageBand = "ok" | "warning" | "frozen";

const AI_NEAR_LIMIT_PCT = 80;
const STORAGE_WARNING_PCT = 80;
const STORAGE_FROZEN_PCT = 95;
const REFRESH_INTERVAL_MS = 60_000;
const AUTH_RESUME_CHECK_MS = 1_500;
// While PAUSED with an unchanged-but-authenticated session (transient refresh
// failure: 429/5xx/network kept the same token), retry on this backoff instead
// of waiting for an auth change that may never come — apiFetch re-attempts the
// refresh on the next request, so one probe a minute self-heals the poller
// without recreating the original 401-every-few-seconds spam.
const AUTH_PAUSED_RETRY_MS = 60_000;
const AUTH_FAILURE_PAUSE_THRESHOLD = 1;

function safePct(pct: number | null | undefined): number {
	if (pct === null || pct === undefined) return 0;
	if (!Number.isFinite(pct)) return 0;
	return Math.max(0, Math.min(100, pct));
}

function aiPctFromWindow(committed: number, limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return 0;
	const raw = (committed / limit) * 100;
	return Math.max(0, Math.min(999, Math.round(raw * 100) / 100));
}

function authSnapshot(): string | null {
	return authStore.isAuthenticated ? authStore.accessToken : null;
}

function isAuthPollingError(error: unknown): boolean {
	return error instanceof api.ApiError && (error.status === 401 || error.status === 403);
}

export interface UsageMemberRow extends UsageDashboardMember {
	totalActivity: number;
}

class UsageStore {
	dashboard = $state<UsageDashboard | null>(null);
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

	// --- derived ---------------------------------------------------------------
	storage = $derived.by(() => this.dashboard?.storage ?? null);
	ai = $derived.by(() => this.dashboard?.totals.monthly ?? null);
	dailyAi = $derived.by(() => this.dashboard?.totals.daily ?? null);
	plan = $derived.by(() => this.dashboard?.plan ?? null);

	// --- single source of truth for the DISPLAYED plan ------------------------
	//
	// The plan BADGE/LABEL must always agree with the AI-credit allowance shown
	// beside it. Both the badge and the allowance derive from the SAME resolved
	// plan the usage dashboard returns (`dashboard.plan`) — its id, name and
	// monthlyAiCredits are computed together server-side (resolvePlanForDashboard),
	// so they can never diverge the way the billing-assignment planId and the
	// usage-resolved cap could (e.g. a "free" billing badge next to 700 Studio
	// credits). When the dashboard hasn't loaded yet we fall back to the
	// billing-assignment plan so the badge still renders for a known subscription.
	//
	// `resolvedPlanKey` is the PublicPlanKey for PlanBadge; `resolvedPlanName` is
	// the matching human label.
	resolvedPlanKey = $derived.by<PublicPlanKey | null>(() => {
		const planId = this.dashboard?.plan.id;
		if (isInternalPlanId(planId)) return internalPlanIdToPublicKey(planId);
		// No (or unrecognised) dashboard plan — fall back to the billing assignment.
		return billingStore.publicPlanKey;
	});

	resolvedPlanName = $derived.by<string | null>(() => {
		const key = this.resolvedPlanKey;
		if (key) return PUBLIC_PLAN_LABEL[key];
		// Prefer the dashboard's own name string if present, else billing's.
		return this.dashboard?.plan.name ?? billingStore.currentPlan?.name ?? null;
	});

	// True once we have ANY plan context to render a badge/label from.
	hasResolvedPlan = $derived.by(() => Boolean(this.resolvedPlanKey));

	storagePct = $derived.by(() => safePct(this.storage?.percentUsed ?? 0));

	aiPct = $derived.by(() => {
		const monthly = this.ai;
		if (!monthly) return 0;
		const committed = (monthly.aiCommittedThb ?? 0) + (monthly.aiActiveReservedThb ?? 0);
		return safePct(aiPctFromWindow(committed, monthly.limits.aiCreditThb));
	});

	// REMAINING balances (issue #3): meters show "เหลือ Y" counting DOWN, not
	// "ใช้ไป X" counting up toward a cap. The backend already returns these; these
	// getters give every usageStore-backed surface one place to read them.
	storageRemainingBytes = $derived.by(() => this.storage?.remainingBytes ?? 0);

	// Remaining AI credit in THB. `null` ⇒ unlimited (no cap). Falls back to
	// limit − (committed + reserved) if the server omitted `remaining`.
	aiRemainingThb = $derived.by<number | null>(() => {
		const monthly = this.ai;
		if (!monthly) return 0;
		const remaining = monthly.remaining?.aiCreditThb;
		if (remaining === null) return null; // unlimited
		if (typeof remaining === "number") return Math.max(0, remaining);
		const limit = monthly.limits.aiCreditThb ?? 0;
		if (limit <= 0) return null; // no cap configured ⇒ unlimited
		const used = (monthly.aiCommittedThb ?? 0) + (monthly.aiActiveReservedThb ?? 0);
		return Math.max(0, limit - used);
	});

	// Remaining AI credits as a count (THB→credits via the display rate), or null
	// when unlimited. Surfaces feed this through CreditAmount/formatCreditsCompact.
	aiRemainingCredits = $derived.by<number | null>(() => {
		const thb = this.aiRemainingThb;
		return thb === null ? null : thbToCredits(thb);
	});

	storageBand = $derived.by<StorageBand>(() => {
		const pct = this.storagePct;
		const frozen = this.isStorageFrozen;
		if (frozen) return "frozen";
		if (pct >= STORAGE_WARNING_PCT) return "warning";
		return "ok";
	});

	isStorageFrozen = $derived.by(() => {
		const storage = this.storage;
		if (!storage) return false;
		if (storage.enforced && storage.remainingBytes <= 0) return true;
		return this.storagePct >= STORAGE_FROZEN_PCT && storage.enforced;
	});

	isAiNearLimit = $derived.by(() => this.aiPct >= AI_NEAR_LIMIT_PCT && this.aiPct < 100);
	isAiAtLimit = $derived.by(() => this.aiPct >= 100);

	members = $derived.by<UsageMemberRow[]>(() => {
		const breakdown = this.dashboard?.members.breakdown ?? [];
		return breakdown
			.map((member) => ({
				...member,
				totalActivity:
					(member.aiCommittedThb ?? 0) + (member.uploadBytes ?? 0) + (member.exportBytes ?? 0),
			}))
			.sort((a, b) => b.totalActivity - a.totalActivity)
			.slice(0, 10);
	});

	// --- loaders --------------------------------------------------------------
	async load(workspaceId?: string | null): Promise<void> {
		const wsId = (workspaceId ?? this.currentWorkspaceId ?? billingStore.currentWorkspaceId)?.trim();
		if (!wsId) {
			this.dashboard = null;
			return;
		}
		this.loading = true;
		this.error = null;
		try {
			const result = await api.getWorkspaceUsageDashboard(wsId);
			this.dashboard = result.dashboard;
			this.lastLoadedAt = Date.now();
			this.currentWorkspaceId = wsId;
			this.consecutiveAuthFailures = 0;
		} catch (error) {
			// Drop the previously-loaded dashboard so a failed refresh (workspace
			// switch, expired session) does not keep rendering the old workspace's
			// quota/member totals under the new/error context.
			this.dashboard = null;
			this.lastLoadedAt = null;
			this.currentWorkspaceId = wsId;
			this.error = error instanceof Error ? error.message : "โหลด usage ไม่สำเร็จ";
			this.maybePausePollingForAuthError(error);
		} finally {
			this.loading = false;
		}
	}

	/**
	 * Start polling for the given workspace. Returns a cleanup function the
	 * caller must invoke (typically from `$effect.root`).
	 */
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
			// The workspace id can outlive logout in local storage; pausing here
			// prevents protected usage polling from starting before auth restore.
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
			// apiFetch already attempted the access-token refresh before surfacing
			// this 401/403; keep the poll dormant until authStore changes again.
			this.pausePollingUntilAuthChanges();
		}
	}

	/**
	 * Stop polling and drop all loaded state. Called on logout / unauth so the
	 * sidebar widgets never keep rendering a signed-out workspace's quota/member
	 * totals and no protected /api/usage poll survives the session.
	 */
	reset(): void {
		this.stopPolling();
		this.dashboard = null;
		this.loading = false;
		this.error = null;
		this.lastLoadedAt = null;
		this.currentWorkspaceId = null;
	}

	__resetForTesting(): void {
		this.reset();
	}
}

export const usageStore = new UsageStore();
export const USAGE_THRESHOLDS = {
	aiNearLimitPct: AI_NEAR_LIMIT_PCT,
	storageWarningPct: STORAGE_WARNING_PCT,
	storageFrozenPct: STORAGE_FROZEN_PCT,
	refreshIntervalMs: REFRESH_INTERVAL_MS,
} as const;

// --- small formatters --------------------------------------------------------
const BYTES_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
export function formatBytes(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "0 B";
	let v = value;
	let i = 0;
	while (v >= 1024 && i < BYTES_UNITS.length - 1) {
		v /= 1024;
		i++;
	}
	const rounded = v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
	return `${rounded} ${BYTES_UNITS[i]}`;
}

export function formatThbCompact(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "฿0";
	if (value >= 1_000_000) return `฿${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1_000) return `฿${(value / 1_000).toFixed(2)}K`;
	return `฿${Math.round(value)}`;
}

// --- credits (user-facing AI unit) -------------------------------------------
//
// Users spend/own CREDITS for AI ops, not baht. The usage windows the backend
// exposes are denominated in THB (aiCommittedThb / limits.aiCreditThb), so to
// show a credit balance we invert the canonical sale rate:
//   1 credit = 0.09 THB  (backend plans.ts THB_PER_CREDIT — post-×10 rebase #586)
// MUST stay in sync with backend plans.ts THB_PER_CREDIT. This is DISPLAY-only —
// it never changes how credits are reserved/charged. Per-OP costs must use the
// backend's `creditUnits` directly (do not derive from THB); only aggregate
// balances/limits need this conversion.
export const THB_PER_CREDIT = 0.09;

export function thbToCredits(thb: number | null | undefined): number {
	if (thb === null || thb === undefined || !Number.isFinite(thb) || thb <= 0) return 0;
	return thb / THB_PER_CREDIT;
}

/** Compact, integer-rounded credit count for meters/balances (e.g. 1240 → 1.24K). */
export function formatCreditsCompact(credits: number | null | undefined): string {
	if (credits === null || credits === undefined || !Number.isFinite(credits)) return "0";
	const v = Math.round(credits);
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
	return String(v);
}

/**
 * The translated "credits" unit word for inline cost/balance strings, read
 * imperatively from svelte-i18n. svelte-i18n's `get(_)` THROWS if the locale
 * isn't initialised yet (e.g. in unit tests that don't bootstrap i18n), so this
 * wrapper falls back to the Thai default — never throwing in a render path.
 */
export function creditUnitLabel(): string {
	try {
		const translate = get(_);
		const label = translate("credits.unit");
		// svelte-i18n returns the key itself when a message is missing.
		if (label && label !== "credits.unit") return label;
	} catch {
		// locale not initialised — fall through to the default below.
	}
	return "เครดิต";
}
