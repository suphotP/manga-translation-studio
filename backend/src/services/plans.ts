export type WorkspacePlanId = "free" | "creator" | "pro" | "studio" | "studio_plus";
export type BillingAddonKind = "ai_credits" | "storage" | "seat" | "team_jobs" | "byo_api";
export type BillingInterval = "one_time" | "monthly";

/**
 * The plan keys the Dodo CHECKOUT validator accepts (billing-dodo.ts `checkoutSchema`).
 *
 * IMPORTANT: these are Dodo PRODUCT-CATALOG keys, NOT the public display keys above. The
 * Dodo catalog keys the entry tier "starter", which maps to the internal "creator" plan
 * (DODO_TO_INTERNAL_PLAN in dodo.service.ts). Lives here (the side-effect-free catalog
 * module) so the frontend anti-drift test can import it without dragging in the backend
 * config/auth chain, and assert every public card's checkout key maps to a key in this
 * set — so a display rename like "starter" → "creator" can never 400 checkout again.
 */
export const ACCEPTED_CHECKOUT_PLAN_KEYS = ["starter", "pro", "studio", "studio_plus"] as const;
export type DodoCheckoutPlanKey = (typeof ACCEPTED_CHECKOUT_PLAN_KEYS)[number];

// ── Credit pricing: the SINGLE margin knob ───────────────────────────────────────
//
// One AI "credit-unit" costs us roughly RAW_AI_COST_THB_PER_CREDIT in raw provider
// spend (low/medium/high ops charge 1/9/36 credit-units, cost-proportional — see
// cost-estimator.ts QUALITY_CREDIT_UNITS). We SELL each credit at a fixed multiple of
// that raw cost so the business margin is one number to tune. Changing the multiplier
// (or the raw-cost estimate) re-prices every credit↔money conversion in the app —
// support goodwill grants, the support-grant auto-cap, and the plan-credit→THB usage
// quota — because they ALL reference THB_PER_CREDIT / CENTS_PER_CREDIT instead of a
// magic number. This is intentionally separate from the cost-estimator's internal
// reserveThb (cost × 1.25 cost-tracking reservation), which is NOT a sale price.

/**
 * Raw provider cost of one AI credit-unit, in THB (≈0.021฿/credit-unit at THB@36).
 * ×10 credit rebase (2026-06-12): a LOW image now charges 10 units (was 1), so the
 * per-unit raw cost shrank 10× while the per-image cost is unchanged. Must move in
 * lockstep with cost-estimator.ts QUALITY_CREDIT_UNITS and migration 0087.
 */
export const RAW_AI_COST_THB_PER_CREDIT = 0.021;

/** Owner-set sale margin over raw AI cost. Bump this to widen margin app-wide. */
export const CREDIT_MARGIN_MULTIPLIER = 4;

/**
 * Sale value of one credit in THB. Owner decision: 4× raw cost is the FLOOR
 * (0.021 × 4 = 0.084฿). Pinned to 0.09฿ — the smallest clean satang value ≥ the
 * floor — so CENTS_PER_CREDIT stays an integer (9 satang) and every published
 * conversion (support grants, quota, goodwill) never dips below the 4× margin.
 * (Pre-rebase this was 0.85฿ for a 1-unit low image; a low image is now 10 units
 * ≈ 0.90฿ of sale value — same order, slightly above the old point.)
 */
export const THB_PER_CREDIT = 0.09;

/** Sale value of one credit in MINOR UNITS (satang/cents). THB_PER_CREDIT × 100. */
export const CENTS_PER_CREDIT = Math.round(THB_PER_CREDIT * 100); // 9

export interface WorkspacePlan {
	id: WorkspacePlanId;
	name: string;
	priceUsdMonthly: number;
	includedStorageBytes: number;
	monthlyAiCredits: number;
	joinableTeamStories: number;
	creatableTeamStories: number;
	activeTeamJobs: number;
	maxAiQueueOpenJobs: number;
	maxAiQueuePendingJobs: number;
	maxSeatsIncluded: number;
	allowedAiQualities: ("low" | "medium" | "high")[];
	addons: {
		aiCredits: boolean;
		storage: boolean;
		seats: boolean;
		teamJobs: boolean;
	};
}

export interface BillingAddonProduct {
	id: string;
	kind: BillingAddonKind;
	name: string;
	priceUsd: number;
	billingInterval: BillingInterval;
	units: number;
	unitLabel: string;
	minPlanId: WorkspacePlanId;
	active: boolean;
	aiCredits?: number;
	storageBytes?: number;
	seats?: number;
	teamJobs?: number;
	metadata?: Record<string, unknown>;
}

export interface BillingCatalog {
	plans: WorkspacePlan[];
	addons: BillingAddonProduct[];
	currency: "USD";
	status: "mock";
}

export type StoragePackSkuId = "storage-pack-25gb" | "storage-pack-100gb" | "storage-pack-500gb";

/**
 * Paid storage pack SKU. A pack is an add-on whose `sizeBytes` raises a
 * workspace's effective storage quota for as long as it is active and
 * unexpired. Purchasing/billing integration is intentionally out of scope:
 * this only describes the catalog of pack sizes the quota math understands.
 */
export interface StoragePackSku {
	id: StoragePackSkuId;
	name: string;
	sizeBytes: number;
	minPlanId: WorkspacePlanId;
	active: boolean;
}

export interface WorkspacePlanAiQueueCaps {
	maxProjectOpenJobs: number;
	maxProjectPendingJobs: number;
}

export const GIB = 1024 * 1024 * 1024;

// ── Plan catalog (owner-approved 2026-06-12, pre-launch redesign) ────────────────
//
// Prices $0/9/25/59/99 (7% tax buffer baked into list price — no checkout
// surcharge ever). Credits are post-×10-rebase units: low=10 / medium=90 /
// high=360 per image. Per-credit value improves with tier (the upgrade
// incentive); a full burn of plan credits costs 6.5-13% of plan price in raw
// AI spend, so margin is safe at 100% utilization on every tier.
//
// Free is deliberately team-capable (2 seats / 1 team story / medium allowed):
// the duty/assignment system is the product's heart, so trial users must be
// able to FEEL it (owner: "ถ้าไม่มีที่นั่งให้คนฟรี มันจะเทสระบบหลักที่เป็นหัวใจเว็บเราไม่ได้").
// 100 credits = 10 low pages or ONE medium taste — the conversion hook.
//
// activeTeamJobs is retained as a field for type/DB compat but is NOT a sale
// dimension anymore (owner: "เอาออก มันโดนจำกัดเยอะเกิน") — nothing enforces it
// and it must not appear on pricing surfaces.
export const WORKSPACE_PLANS: Record<WorkspacePlanId, WorkspacePlan> = {
	free: {
		id: "free",
		name: "Free",
		priceUsdMonthly: 0,
		includedStorageBytes: 2 * GIB,
		monthlyAiCredits: 100,
		joinableTeamStories: 1,
		creatableTeamStories: 1,
		activeTeamJobs: 3,
		maxAiQueueOpenJobs: 5,
		maxAiQueuePendingJobs: 5,
		maxSeatsIncluded: 2,
		allowedAiQualities: ["low", "medium"],
		addons: {
			aiCredits: false,
			storage: false,
			seats: false,
			teamJobs: false,
		},
	},
	creator: {
		id: "creator",
		name: "Creator",
		priceUsdMonthly: 9,
		includedStorageBytes: 10 * GIB,
		monthlyAiCredits: 1_000,
		joinableTeamStories: 5,
		creatableTeamStories: 5,
		activeTeamJobs: 5,
		maxAiQueueOpenJobs: 15,
		maxAiQueuePendingJobs: 10,
		maxSeatsIncluded: 2,
		allowedAiQualities: ["low", "medium"],
		addons: {
			aiCredits: true,
			storage: true,
			seats: true,
			teamJobs: false,
		},
	},
	pro: {
		id: "pro",
		name: "Pro",
		priceUsdMonthly: 25,
		includedStorageBytes: 50 * GIB,
		monthlyAiCredits: 4_000,
		joinableTeamStories: 20,
		creatableTeamStories: 20,
		activeTeamJobs: 20,
		maxAiQueueOpenJobs: 40,
		maxAiQueuePendingJobs: 25,
		maxSeatsIncluded: 5,
		allowedAiQualities: ["low", "medium", "high"],
		addons: {
			aiCredits: true,
			storage: true,
			seats: true,
			teamJobs: false,
		},
	},
	studio: {
		id: "studio",
		name: "Studio",
		priceUsdMonthly: 59,
		includedStorageBytes: 200 * GIB,
		monthlyAiCredits: 11_000,
		joinableTeamStories: 100,
		creatableTeamStories: 100,
		activeTeamJobs: 100,
		maxAiQueueOpenJobs: 120,
		maxAiQueuePendingJobs: 80,
		maxSeatsIncluded: 12,
		allowedAiQualities: ["low", "medium", "high"],
		addons: {
			aiCredits: true,
			storage: true,
			seats: true,
			teamJobs: false,
		},
	},
	studio_plus: {
		id: "studio_plus",
		name: "Studio+",
		priceUsdMonthly: 99,
		includedStorageBytes: 500 * GIB,
		monthlyAiCredits: 22_000,
		joinableTeamStories: 250,
		creatableTeamStories: 250,
		activeTeamJobs: 250,
		maxAiQueueOpenJobs: 200,
		maxAiQueuePendingJobs: 150,
		maxSeatsIncluded: 25,
		allowedAiQualities: ["low", "medium", "high"],
		addons: {
			aiCredits: true,
			storage: true,
			seats: true,
			teamJobs: false,
		},
	},
};

export const BILLING_ADDONS: BillingAddonProduct[] = [
	// Credit top-up ladder (owner-approved 2026-06-12, post-×10 units). Per-1k
	// pricing descends ($8 → $6 → $5 → $4.6) but the LARGEST pack is still
	// priced above Studio+'s effective plan rate ($4.5/1k incl. storage/seats)
	// so packs never out-compete a subscription. The small pack carries the
	// Dodo fixed fee (~$0.40/txn), hence its higher unit price.
	{
		id: "credits-500",
		kind: "ai_credits",
		name: "500 AI credits",
		priceUsd: 4,
		billingInterval: "one_time",
		units: 500,
		unitLabel: "credits",
		minPlanId: "creator",
		active: true,
		aiCredits: 500,
	},
	{
		id: "credits-2000",
		kind: "ai_credits",
		name: "2,000 AI credits",
		priceUsd: 12,
		billingInterval: "one_time",
		units: 2000,
		unitLabel: "credits",
		minPlanId: "creator",
		active: true,
		aiCredits: 2000,
	},
	{
		id: "credits-5000",
		kind: "ai_credits",
		name: "5,000 AI credits",
		priceUsd: 25,
		billingInterval: "one_time",
		units: 5000,
		unitLabel: "credits",
		minPlanId: "creator",
		active: true,
		aiCredits: 5000,
	},
	{
		id: "credits-15000",
		kind: "ai_credits",
		name: "15,000 AI credits",
		priceUsd: 69,
		billingInterval: "one_time",
		units: 15000,
		unitLabel: "credits",
		minPlanId: "pro",
		active: true,
		aiCredits: 15000,
	},
	// Legacy pre-rebase packs — retired from sale, but their grant quantities are
	// REBASED (50→500, 200→2000): a webhook replay or support reconciliation of
	// an old purchase must mint the post-×10 equivalent of what the customer
	// paid for, not one-tenth of it (review #586 P1). The pre-rebase grants that
	// already landed were multiplied by migration 0087.
	{
		id: "credits-50",
		kind: "ai_credits",
		name: "50 AI credits (legacy, rebased)",
		priceUsd: 4,
		billingInterval: "one_time",
		units: 500,
		unitLabel: "credits",
		minPlanId: "creator",
		active: false,
		aiCredits: 500,
	},
	{
		id: "credits-200",
		kind: "ai_credits",
		name: "200 AI credits (legacy, rebased)",
		priceUsd: 14,
		billingInterval: "one_time",
		units: 2000,
		unitLabel: "credits",
		minPlanId: "creator",
		active: false,
		aiCredits: 2000,
	},
	{
		id: "storage-25gb",
		kind: "storage",
		name: "25 GB storage",
		priceUsd: 3,
		billingInterval: "monthly",
		units: 25,
		unitLabel: "GB",
		minPlanId: "creator",
		active: true,
		storageBytes: 25 * GIB,
	},
	{
		id: "storage-100gb",
		kind: "storage",
		name: "100 GB storage",
		priceUsd: 9,
		billingInterval: "monthly",
		units: 100,
		unitLabel: "GB",
		minPlanId: "pro",
		active: true,
		storageBytes: 100 * GIB,
	},
	{
		id: "seat-1",
		kind: "seat",
		name: "Extra seat",
		priceUsd: 5,
		billingInterval: "monthly",
		units: 1,
		unitLabel: "seat",
		minPlanId: "creator",
		active: true,
		seats: 1,
	},
	// Retired sale dimensions (owner decisions, 2026-06-12). Rows stay inactive
	// so historical grants keep valid product references:
	// - team-jobs: "active team jobs" never had server-side enforcement, so it
	//   must not be sold or shown ("มันโดนจำกัดเยอะเกิน").
	// - byo-api: external keys put model churn, provider bans, and a moderation
	//   gap on OUR liability ("ถ้ามันโดนแบนหรืออะไร...อาจจะโดนฟ้อง") — whales buy
	//   the 15k credit pack repeatedly instead.
	{
		id: "team-jobs-10",
		kind: "team_jobs",
		name: "10 active team jobs",
		priceUsd: 6,
		billingInterval: "monthly",
		units: 10,
		unitLabel: "team jobs",
		minPlanId: "creator",
		active: false,
		teamJobs: 10,
	},
	{
		id: "byo-api",
		kind: "byo_api",
		name: "Bring your own API key",
		priceUsd: Number(process.env.BYO_ADDON_PRICE_USD || "149"),
		billingInterval: "monthly",
		units: 1,
		unitLabel: "workspace",
		minPlanId: "studio",
		active: false,
		metadata: {
			providers: ["openai", "openrouter"],
			scope: "workspace",
			policyModerationBypass: true,
			csamModerationBypass: false,
		},
	},
];

export const STORAGE_PACK_SKUS: Record<StoragePackSkuId, StoragePackSku> = {
	"storage-pack-25gb": {
		id: "storage-pack-25gb",
		name: "25 GB storage pack",
		sizeBytes: 25 * GIB,
		minPlanId: "creator",
		active: true,
	},
	"storage-pack-100gb": {
		id: "storage-pack-100gb",
		name: "100 GB storage pack",
		sizeBytes: 100 * GIB,
		minPlanId: "pro",
		active: true,
	},
	"storage-pack-500gb": {
		id: "storage-pack-500gb",
		name: "500 GB storage pack",
		sizeBytes: 500 * GIB,
		minPlanId: "studio",
		active: true,
	},
};

export function listStoragePackSkus(): StoragePackSku[] {
	return Object.values(STORAGE_PACK_SKUS);
}

export function resolveStoragePackSku(skuId: string | undefined): StoragePackSku | undefined {
	const normalized = skuId?.trim() as StoragePackSkuId | undefined;
	return normalized && STORAGE_PACK_SKUS[normalized] ? STORAGE_PACK_SKUS[normalized] : undefined;
}

export function resolveWorkspacePlan(planId = process.env.WORKSPACE_PLAN_ID): WorkspacePlan {
	const normalized = normalizeWorkspacePlanId(planId);
	return normalized && WORKSPACE_PLANS[normalized] ? WORKSPACE_PLANS[normalized] : WORKSPACE_PLANS.free;
}

export function normalizeWorkspacePlanId(planId: string | undefined): WorkspacePlanId | undefined {
	const normalized = planId?.trim().toLowerCase() as WorkspacePlanId | undefined;
	return normalized && WORKSPACE_PLANS[normalized] ? normalized : undefined;
}

export function isWorkspacePlanId(planId: string | undefined): planId is WorkspacePlanId {
	return Boolean(normalizeWorkspacePlanId(planId));
}

export function workspacePlanAllowsAiQuality(planId: string | undefined, quality: WorkspacePlan["allowedAiQualities"][number]): boolean {
	return resolveWorkspacePlan(planId).allowedAiQualities.includes(quality);
}

export function resolveWorkspacePlanAiQueueCaps(planId = process.env.WORKSPACE_PLAN_ID): WorkspacePlanAiQueueCaps {
	const plan = resolveWorkspacePlan(planId);
	return {
		maxProjectOpenJobs: plan.maxAiQueueOpenJobs,
		maxProjectPendingJobs: plan.maxAiQueuePendingJobs,
	};
}

export function listWorkspacePlans(): WorkspacePlan[] {
	return Object.values(WORKSPACE_PLANS);
}

export function listBillingAddonProducts(): BillingAddonProduct[] {
	return [...BILLING_ADDONS];
}

/**
 * Dodo's checkout stores add-on identifiers with UNDERSCORE keys (the `DodoAddonKey`
 * set in dodo.service.ts — e.g. `metadata.addons: "byo_api"`), while the billing
 * catalog (BILLING_ADDONS) uses HYPHEN ids (`byo-api`). Round-4 P1: a Dodo `byo_api`
 * key failed to resolve to the non-AI `byo-api` add-on, so a BYO purchase fell through
 * to the plan world and minted the plan's free AI credits (over-grant). This map (plus
 * the generic underscore→hyphen tolerance in `resolveBillingAddon`) pins every known
 * Dodo add-on key to its catalog id so the resolution is exact and future-proof.
 *
 * NOTE: `normalizeAddons` in dodo.service.ts currently only emits `byo_api`, but the
 * remaining entries defensively cover every other catalog add-on's underscore variant
 * so a future Dodo key never silently misses the catalog and reopens the over-grant.
 */
const DODO_ADDON_ALIASES: Readonly<Record<string, string>> = {
	byo_api: "byo-api",
	credits_50: "credits-50",
	credits_200: "credits-200",
	storage_25gb: "storage-25gb",
	storage_100gb: "storage-100gb",
	seat_1: "seat-1",
	team_jobs_10: "team-jobs-10",
};

/**
 * Normalize an external add-on identifier (e.g. a Dodo underscore key) to its catalog
 * SKU id. Applies the explicit `DODO_ADDON_ALIASES` map first, then a generic
 * underscore→hyphen fold (all catalog ids use hyphens), so both `byo_api` and any other
 * `*_*` Dodo-style key resolve to the hyphenated catalog id. Returns the trimmed input
 * unchanged when no alias applies. Idempotent for already-hyphenated catalog ids.
 */
export function normalizeBillingAddonId(skuId: string | undefined): string | undefined {
	const trimmed = skuId?.trim();
	if (!trimmed) return undefined;
	return DODO_ADDON_ALIASES[trimmed] ?? trimmed.replace(/_/g, "-");
}

/**
 * Resolve a billing add-on product by its SKU id (e.g. "credits-50"), or undefined.
 * Alias-normalizes Dodo underscore keys (`byo_api` → `byo-api`) first so a checkout's
 * stored add-on key resolves to the catalog (round-4 P1) rather than missing it.
 */
export function resolveBillingAddon(skuId: string | undefined): BillingAddonProduct | undefined {
	const normalized = normalizeBillingAddonId(skuId);
	if (!normalized) return undefined;
	return BILLING_ADDONS.find((addon) => addon.id === normalized);
}

/**
 * The AI credits a KNOWN paid SKU promises to grant — the SINGLE source of truth for
 * reconciling a "paid but not credited" discrepancy (money, P1). A SKU id may be:
 *   * a credit-pack add-on (`credits-50` → 50, `credits-200` → 200) → `addon.aiCredits`;
 *   * a workspace plan (`creator`/`pro`/`studio`) → `plan.monthlyAiCredits`.
 * Returns the promised credit COUNT (not money), or 0 when the id maps to no
 * credit-bearing SKU. A reconciliation MUST grant this promised amount — never a
 * flat per-cent rate applied to the (USD) money paid, which conflates the cost-basis
 * sale rate with the SKU's sale price and is doubly wrong across currencies.
 */
export function skuAiCredits(skuId: string | undefined): number {
	const normalized = skuId?.trim();
	if (!normalized) return 0;
	const addon = resolveBillingAddon(normalized);
	if (addon && addon.kind === "ai_credits" && typeof addon.aiCredits === "number" && addon.aiCredits > 0) {
		return Math.floor(addon.aiCredits);
	}
	const planId = normalizeWorkspacePlanId(normalized);
	if (planId) {
		const credits = WORKSPACE_PLANS[planId].monthlyAiCredits;
		return typeof credits === "number" && credits > 0 ? Math.floor(credits) : 0;
	}
	return 0;
}

/**
 * The monthly AI credit allowance of a WORKSPACE PLAN — resolved ONLY from
 * WORKSPACE_PLANS, the plan field's single source of truth (money, P1).
 *
 * Unlike `skuAiCredits`, this NEVER consults BILLING_ADDONS: an id is credited
 * here IFF it is a recognized plan. This separation is load-bearing for credit
 * reconciliation — a payment's PLAN field (`planId`/`plan_key`) must resolve plan
 * credits and ONLY plan credits. If an add-on id (e.g. "credits-50") is mistakenly
 * placed in a plan field, or the id is garbage, this returns 0 (fail-closed) rather
 * than cross-resolving to the add-on's credits and over-granting. Add-on credits are
 * resolved exclusively via the add-on path (`resolveBillingAddon` / `skuAiCredits`).
 *
 * Returns the plan's monthly credit COUNT, or 0 when the id is not a valid plan.
 */
export function planMonthlyCredits(planId: string | undefined): number {
	const normalized = normalizeWorkspacePlanId(planId);
	if (!normalized) return 0;
	const credits = WORKSPACE_PLANS[normalized].monthlyAiCredits;
	return typeof credits === "number" && credits > 0 ? Math.floor(credits) : 0;
}

export function buildBillingCatalog(): BillingCatalog {
	return {
		plans: listWorkspacePlans(),
		// Display catalog: retired SKUs (legacy 1×-scale packs, team-jobs, byo-api)
		// stay in BILLING_ADDONS so historical grants/webhooks resolve, but must
		// never be offered for sale.
		addons: listBillingAddonProducts().filter((addon) => addon.active),
		currency: "USD",
		status: "mock",
	};
}
