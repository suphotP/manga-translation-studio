// Billing store — Wave 2 W2.2.
//
// Wraps the Dodo Payments + internal billing endpoints (PR #74) so pricing,
// the in-workspace billing settings page, and any tier badge can read the
// current plan, present the public 5-tier catalog, kick off Dodo checkout, and
// jump into the customer portal.
//
// The frontend does not yet thread a "current workspaceId" through the auth
// pipeline (W2.1 introduces a workspaces store, but it is not in this branch
// base), so loaders accept an explicit workspaceId. A small localStorage
// fallback is exposed for pages that need to remember the last opened
// workspace.

import * as api from "$lib/api/client.ts";
import type {
	BillingAddonRecord,
	BillingCheckoutInput,
	BillingInvoiceRecord,
	BillingPlanRecord,
	DodoAddonKey,
	DodoBillingCycle,
	DodoPlanKey,
	WorkspaceBillingState,
} from "$lib/api/client.ts";

// The public pricing tiers MUST mirror the enforced backend plan catalog
// (backend/src/services/plans.ts → WORKSPACE_PLANS). There is exactly one tier
// per backend plan id, keyed the same (free/creator/pro/studio), so the
// marketing /pricing page, the in-app upgrade cards, and the badge can never
// advertise a plan/price the backend will not honor. The
// `public-pricing-matches-backend` test pins this 1:1 against the backend
// catalog so the two can't silently drift again.
export type PublicPlanKey = api.WorkspacePlanId;

export interface PublicPlanCard {
	key: PublicPlanKey;
	/** Brand tier name (Free/Creator/Pro/Studio) — locale-neutral, never translated. */
	name: string;
	/** i18n key for the one-line tagline; resolved at render with a Thai fallback. */
	taglineKey: string;
	monthlyUsd: number;
	yearlyUsd: number;
	/** Locale-neutral storage label, e.g. "2 GB" (the unit "GB" is universal). */
	storageLabel: string;
	/** Number of monthly AI CREDITS the plan includes (matches the backend plan). */
	aiCredits: number;
	/** Seats included on the plan (matches the backend plan). */
	members: number;
	byoIncluded: boolean;
	byoAvailable: boolean;
	/** i18n key for the CTA button label; resolved at render with a Thai fallback. */
	ctaKey: string;
	ctaIntent: "free" | "checkout" | "contact_sales";
	highlight: boolean;
	/** i18n keys for the per-tier feature bullets; resolved at render. */
	featureKeys: string[];
}

// Locked pricing (Suphot 2026-06-02). Yearly = 20% off (Dodo configures
// separate yearly products; we surface the math here for the toggle UI).
const YEARLY_DISCOUNT = 0.2;

function yearly(monthly: number): number {
	if (monthly === 0) return 0;
	return Math.round(monthly * 12 * (1 - YEARLY_DISCOUNT));
}

// ── Public pricing tiers — MIRROR the enforced backend catalog ──────────────
//
// Each card's key / name / monthlyUsd / storageLabel (GB) / aiCreditsLabel
// (credit count) / membersLabel (seats) MUST equal the matching backend
// WORKSPACE_PLANS entry, and BYO_ADDON_USD_PER_MONTH MUST equal the backend
// `byo-api` add-on price. These are the user-facing strings; the numbers are
// asserted 1:1 against the backend catalog by the
// `public-pricing-matches-backend` test, so editing a price here without
// changing backend/src/services/plans.ts (or vice-versa) fails CI.
//
// Per the credit-pricing model (4× margin, CREDITS not ฿/ops in user copy) the
// AI allowance is shown as monthly CREDITS, never "ops".
// 2026-06-12 owner-approved catalog: $0/9/25/59/99, post-×10 credits, BYO retired.
export const PUBLIC_PRICING_CARDS: readonly PublicPlanCard[] = [
	{
		key: "free",
		name: "Free",
		taglineKey: "pricing.tierFreeTagline",
		monthlyUsd: 0,
		yearlyUsd: 0,
		storageLabel: "2 GB",
		aiCredits: 100,
		members: 2,
		byoIncluded: false,
		byoAvailable: false,
		ctaKey: "pricing.tierFreeCta",
		ctaIntent: "free",
		highlight: false,
		featureKeys: [
			"pricing.featFreePersonalWorkspace",
			"pricing.featFreeAiTrial",
			"pricing.featFreeSmallWatermark",
			"pricing.featFreeCommunitySupport",
		],
	},
	{
		key: "creator",
		name: "Creator",
		taglineKey: "pricing.tierCreatorTagline",
		monthlyUsd: 9,
		yearlyUsd: yearly(9),
		storageLabel: "10 GB",
		aiCredits: 1000,
		members: 2,
		byoIncluded: false,
		byoAvailable: false,
		ctaKey: "pricing.tierCreatorCta",
		ctaIntent: "checkout",
		highlight: false,
		featureKeys: [
			"pricing.featCreatorEverythingFree",
			"pricing.featCreatorAiLowMedium",
			"pricing.featCreatorTeam5",
			"pricing.featCreatorEmailSupport",
		],
	},
	{
		key: "pro",
		name: "Pro",
		taglineKey: "pricing.tierProTagline",
		monthlyUsd: 25,
		yearlyUsd: yearly(25),
		storageLabel: "50 GB",
		aiCredits: 4000,
		members: 5,
		byoIncluded: false,
		byoAvailable: false,
		ctaKey: "pricing.tierProCta",
		ctaIntent: "checkout",
		highlight: true,
		featureKeys: [
			"pricing.featProEverythingCreator",
			"pricing.featProAiAllQuality",
			"pricing.featProWorkflowPresets",
			"pricing.featProPriorityQueue",
			"pricing.featProTeam20",
		],
	},
	{
		key: "studio",
		name: "Studio",
		taglineKey: "pricing.tierStudioTagline",
		monthlyUsd: 59,
		yearlyUsd: yearly(59),
		storageLabel: "200 GB",
		aiCredits: 11000,
		members: 12,
		byoIncluded: false,
		byoAvailable: false,
		ctaKey: "pricing.tierStudioCta",
		ctaIntent: "checkout",
		highlight: false,
		featureKeys: [
			"pricing.featStudioEverythingPro",
			"pricing.featStudioTeam100",
			"pricing.featStudioAuditLog",
			"pricing.featStudioPrioritySupport",
		],
	},
	{
		key: "studio_plus",
		name: "Studio+",
		taglineKey: "pricing.tierStudioPlusTagline",
		monthlyUsd: 99,
		yearlyUsd: yearly(99),
		storageLabel: "500 GB",
		aiCredits: 22000,
		members: 25,
		byoIncluded: false,
		byoAvailable: false,
		ctaKey: "pricing.tierStudioPlusCta",
		ctaIntent: "checkout",
		highlight: false,
		featureKeys: [
			"pricing.featStudioPlusEverythingStudio",
			"pricing.featStudioPlusTeam250",
			"pricing.featStudioPlusTopQueue",
			"pricing.featStudioPlusDedicatedSupport",
		],
	},
] as const;

export const BYO_ADDON_USD_PER_MONTH = 149;

/**
 * Maps an internal plan id onto its public pricing-card key. The public tiers
 * now mirror the backend catalog 1:1 (free/creator/pro/studio), so this is an
 * identity map kept as a function for a single typed call-site and to make the
 * (former) divergence impossible to silently reintroduce.
 *
 * A Studio workspace that buys the $149 BYO add-on stays on the `studio` key;
 * BYO is surfaced separately via `billingStore.hasBYOAddOn`, not a distinct
 * plan tier.
 */
export function internalPlanIdToPublicKey(
	planId: api.WorkspacePlanId,
): PublicPlanKey {
	return planId;
}

const CURRENT_WORKSPACE_STORAGE_KEY = "manga-editor.currentWorkspaceId";

function storage(): Storage | null {
	return typeof window === "undefined" ? null : window.localStorage;
}

function readStoredWorkspaceId(): string | null {
	return storage()?.getItem(CURRENT_WORKSPACE_STORAGE_KEY) || null;
}

function writeStoredWorkspaceId(id: string | null): void {
	const s = storage();
	if (!s) return;
	if (id) s.setItem(CURRENT_WORKSPACE_STORAGE_KEY, id);
	else s.removeItem(CURRENT_WORKSPACE_STORAGE_KEY);
}

class BillingStore {
	// --- state ----------------------------------------------------------------
	plans = $state<BillingPlanRecord[]>([]);
	addons = $state<BillingAddonRecord[]>([]);
	subscription = $state<WorkspaceBillingState | null>(null);
	invoices = $state<BillingInvoiceRecord[]>([]);
	invoicesAvailability = $state<"available" | "portal_only" | "unavailable">("portal_only");
	currentWorkspaceId = $state<string | null>(readStoredWorkspaceId());
	loading = $state(false);
	subscriptionLoading = $state(false);
	invoicesLoading = $state(false);
	checkoutInFlight = $state(false);
	portalInFlight = $state(false);
	error = $state<string | null>(null);

	// --- derived --------------------------------------------------------------
	currentPlan = $derived.by<BillingPlanRecord | null>(() => {
		if (this.subscription?.plan) return this.subscription.plan;
		if (this.subscription?.planId) {
			return this.plans.find((plan) => plan.id === this.subscription!.planId) ?? null;
		}
		return null;
	});

	hasBYOAddOn = $derived.by(() => {
		const grants = this.subscription?.grants ?? [];
		// Backend grants use the CATALOG id "byo-api" (hyphen); accept the Dodo
		// underscore alias defensively. The old `kind === "team_jobs"` clause never
		// matched the real grant shape, so legacy BYO holders saw no management
		// card (review #586 r2 P2).
		return grants.some((grant) =>
			grant.status === "active" && (grant.addonId === "byo-api" || grant.addonId === "byo_api"));
	});

	publicPlanKey = $derived.by<PublicPlanKey | null>(() => {
		if (!this.subscription) return null;
		return internalPlanIdToPublicKey(this.subscription.planId);
	});

	currentStatus = $derived.by(() => this.subscription?.assignment?.status ?? null);

	isPaid = $derived.by(() => {
		const status = this.currentStatus;
		const planId = this.subscription?.planId;
		if (planId === "free" || !planId) return false;
		return status === "active" || status === "mock_active" || status === "trialing";
	});

	isTrialActive = $derived.by(() => this.currentStatus === "trialing");

	isPastDue = $derived.by(() => this.currentStatus === "past_due");
	isCancelled = $derived.by(() => this.currentStatus === "cancelled");

	/**
	 * Whether the customer portal (manage/cancel/update card/invoices) should be
	 * reachable. This is broader than `isPaid`: a `past_due` account is NOT paid,
	 * but the user must still open the portal to update their card and recover —
	 * so portal entry must not be gated on `isPaid` alone.
	 */
	canManageBilling = $derived.by(() => {
		const planId = this.subscription?.planId;
		if (planId === "free" || !planId) return false;
		return this.isPaid || this.isPastDue;
	});

	// --- workspace id helpers -------------------------------------------------
	setCurrentWorkspaceId(workspaceId: string | null): void {
		this.currentWorkspaceId = workspaceId;
		writeStoredWorkspaceId(workspaceId);
	}

	// --- loaders --------------------------------------------------------------
	async loadCatalog(): Promise<void> {
		this.loading = true;
		this.error = null;
		try {
			const response = await api.getBillingCatalog();
			this.plans = response.plans ?? [];
		} catch (error) {
			this.error = error instanceof Error ? error.message : "โหลดแคตตาล็อกแผนไม่สำเร็จ";
		} finally {
			this.loading = false;
		}
	}

	async loadSubscription(workspaceId?: string | null): Promise<WorkspaceBillingState | null> {
		const wsId = (workspaceId ?? this.currentWorkspaceId)?.trim();
		if (!wsId) {
			this.subscription = null;
			return null;
		}
		this.subscriptionLoading = true;
		this.error = null;
		try {
			const state = await api.getWorkspaceBilling(wsId);
			this.subscription = state;
			if (wsId !== this.currentWorkspaceId) this.setCurrentWorkspaceId(wsId);
			return state;
		} catch (error) {
			// Drop the previously-loaded subscription/invoices so a failed load for
			// another workspace (401/403 during a switch, expired token, missing
			// access) does not keep rendering workspace A's plan/portal controls
			// under workspace B's context. publicPlanKey/currentPlan/canManageBilling
			// all derive from `subscription`, so a stale object is actively wrong.
			this.subscription = null;
			this.invoices = [];
			this.invoicesAvailability = "portal_only";
			if (wsId !== this.currentWorkspaceId) this.setCurrentWorkspaceId(wsId);
			this.error = error instanceof Error ? error.message : "โหลดข้อมูลสมาชิกไม่สำเร็จ";
			return null;
		} finally {
			this.subscriptionLoading = false;
		}
	}

	async loadInvoices(workspaceId?: string | null): Promise<void> {
		const wsId = (workspaceId ?? this.currentWorkspaceId)?.trim();
		if (!wsId) return;

		// The backend does not (yet) expose a real invoice-list endpoint — Dodo
		// invoice history lives in the hosted customer portal, and there is no
		// invoice source at all for free / mock workspaces. Probing
		// `/billing/:ws/invoices` would just 404 in the console for every viewer.
		// So gate the network call on there being a REAL Dodo-backed assignment;
		// otherwise resolve to a portal-only hint without any request. We make
		// sure the subscription is loaded first, since the billing page fires
		// loadSubscription + loadInvoices in parallel.
		if (!this.subscription || this.subscription.workspaceId !== wsId) {
			await this.loadSubscription(wsId);
		}
		const status = this.subscription?.assignment?.status ?? null;
		const hasRealProvider = status === "active" || status === "trialing"
			|| status === "past_due" || status === "cancelled";
		if (!hasRealProvider) {
			// Free / unassigned / mock workspaces have no invoice source — point the
			// user at the portal (when reachable) without a doomed 404 probe.
			this.invoices = [];
			this.invoicesAvailability = "portal_only";
			return;
		}

		this.invoicesLoading = true;
		try {
			const result = await api.getWorkspaceBillingInvoices(wsId);
			this.invoices = result.invoices ?? [];
			this.invoicesAvailability = result.availability ?? "portal_only";
		} catch (error) {
			// Failing to load invoices should not blank the page — keep the
			// availability hint so the UI can still point users at the portal.
			this.invoicesAvailability = "unavailable";
			this.error = error instanceof Error ? error.message : "โหลดประวัติใบเสร็จไม่สำเร็จ";
		} finally {
			this.invoicesLoading = false;
		}
	}

	/**
	 * Kicks off a Dodo checkout session and (on success) navigates to the
	 * returned checkout URL. Throws if the workspace is missing or the call
	 * fails so the caller can show a toast/error message.
	 */
	async startCheckout(input: BillingCheckoutInput): Promise<void> {
		if (!input.workspaceId) throw new Error("ต้องเลือก workspace ก่อนจึงจะสมัครแผนได้");
		this.checkoutInFlight = true;
		try {
			const result = await api.startDodoCheckoutSession(input);
			if (typeof window !== "undefined" && result.checkout_url) {
				window.location.assign(result.checkout_url);
			}
		} finally {
			this.checkoutInFlight = false;
		}
	}

	/**
	 * Opens the Dodo customer portal in the current tab. Workspace owners use
	 * this for upgrades, downgrades, payment methods, and invoice history that
	 * Dodo hosts directly.
	 */
	async openPortal(workspaceId?: string | null): Promise<void> {
		const wsId = (workspaceId ?? this.currentWorkspaceId)?.trim();
		if (!wsId) throw new Error("ต้องเลือก workspace ก่อนจึงจะเปิดพอร์ทัลได้");
		this.portalInFlight = true;
		try {
			const result = await api.openDodoPortalSession(wsId);
			if (typeof window !== "undefined" && result.portal_url) {
				window.location.assign(result.portal_url);
			}
		} finally {
			this.portalInFlight = false;
		}
	}

	__resetForTesting(): void {
		this.plans = [];
		this.addons = [];
		this.subscription = null;
		this.invoices = [];
		this.invoicesAvailability = "portal_only";
		this.loading = false;
		this.subscriptionLoading = false;
		this.invoicesLoading = false;
		this.checkoutInFlight = false;
		this.portalInFlight = false;
		this.error = null;
		this.currentWorkspaceId = null;
		writeStoredWorkspaceId(null);
	}
}

export const billingStore = new BillingStore();

// Re-export the types used by pages for ergonomics.
export type {
	BillingAddonRecord,
	BillingCheckoutInput,
	BillingInvoiceRecord,
	BillingPlanRecord,
	DodoAddonKey,
	DodoBillingCycle,
	DodoPlanKey,
	WorkspaceBillingState,
};
