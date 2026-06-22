import { describe, expect, test } from "bun:test";
import {
	GIB,
	CENTS_PER_CREDIT,
	CREDIT_MARGIN_MULTIPLIER,
	RAW_AI_COST_THB_PER_CREDIT,
	THB_PER_CREDIT,
	isWorkspacePlanId,
	buildBillingCatalog,
	listBillingAddonProducts,
	listWorkspacePlans,
	normalizeWorkspacePlanId,
	resolveWorkspacePlanAiQueueCaps,
	resolveWorkspacePlan,
	workspacePlanAllowsAiQuality,
} from "../services/plans.js";

// THB per USD used by the catalog (cost-estimator THB_PER_USD); plan/pack prices are
// stored in USD but the credit floor (THB_PER_CREDIT) is a THB rate, so the audit
// converts USD → THB before comparing against the floor.
const THB_PER_USD = 36;

describe("workspace plans and billing catalog", () => {
	test("keeps the launch plan shape explicit", () => {
		const plans = listWorkspacePlans();

		// 2026-06-12 owner-approved catalog: $0/9/25/59/99, post-×10 credits.
		expect(plans.map((plan) => plan.id)).toEqual(["free", "creator", "pro", "studio", "studio_plus"]);
		expect(resolveWorkspacePlan("free")).toMatchObject({
			priceUsdMonthly: 0,
			includedStorageBytes: 2 * GIB,
			monthlyAiCredits: 100,
			// Free is deliberately team-capable: the duty system is the product's
			// heart, so trial users must be able to FEEL it.
			creatableTeamStories: 1,
			maxSeatsIncluded: 2,
			maxAiQueueOpenJobs: 5,
			maxAiQueuePendingJobs: 5,
			allowedAiQualities: ["low", "medium"],
		});
		expect(resolveWorkspacePlan("creator")).toMatchObject({
			priceUsdMonthly: 9,
			includedStorageBytes: 10 * GIB,
			monthlyAiCredits: 1_000,
			creatableTeamStories: 5,
			maxSeatsIncluded: 2,
			maxAiQueueOpenJobs: 15,
			maxAiQueuePendingJobs: 10,
			allowedAiQualities: ["low", "medium"],
		});
		expect(resolveWorkspacePlan("pro")).toMatchObject({
			priceUsdMonthly: 25,
			includedStorageBytes: 50 * GIB,
			monthlyAiCredits: 4_000,
			maxSeatsIncluded: 5,
		});
		expect(resolveWorkspacePlan("studio")).toMatchObject({
			priceUsdMonthly: 59,
			includedStorageBytes: 200 * GIB,
			monthlyAiCredits: 11_000,
			maxSeatsIncluded: 12,
			maxAiQueueOpenJobs: 120,
			maxAiQueuePendingJobs: 80,
		});
		expect(resolveWorkspacePlan("studio_plus")).toMatchObject({
			priceUsdMonthly: 99,
			includedStorageBytes: 500 * GIB,
			monthlyAiCredits: 22_000,
			maxSeatsIncluded: 25,
			maxAiQueueOpenJobs: 200,
			maxAiQueuePendingJobs: 150,
			allowedAiQualities: ["low", "medium", "high"],
		});
	});

	test("sells the ×10 credit-pack ladder; legacy/retired SKUs stay resolvable but inactive", () => {
		const addons = listBillingAddonProducts();
		const activeIds = addons.filter((a) => a.active).map((a) => a.id);
		expect(activeIds).toEqual([
			"credits-500",
			"credits-2000",
			"credits-5000",
			"credits-15000",
			"storage-25gb",
			"storage-100gb",
			"seat-1",
		]);

		// Retired sale dimensions remain in the catalog for historical grant
		// resolution but must never be active: legacy 1×-scale packs, the
		// never-enforced team-jobs cap, and BYO (owner liability decision).
		for (const retired of ["credits-50", "credits-200", "team-jobs-10", "byo-api"]) {
			const addon = addons.find((a) => a.id === retired);
			expect(addon).toBeDefined();
			expect(addon?.active).toBe(false);
		}

		expect(addons.find((addon) => addon.id === "credits-500")).toMatchObject({
			kind: "ai_credits",
			billingInterval: "one_time",
			priceUsd: 4,
			aiCredits: 500,
			minPlanId: "creator",
		});
		expect(addons.find((addon) => addon.id === "credits-15000")).toMatchObject({
			kind: "ai_credits",
			billingInterval: "one_time",
			priceUsd: 69,
			aiCredits: 15000,
			minPlanId: "pro",
		});
		expect(addons.find((addon) => addon.id === "storage-25gb")).toMatchObject({
			kind: "storage",
			billingInterval: "monthly",
			storageBytes: 25 * GIB,
		});
		expect(addons.find((addon) => addon.id === "seat-1")).toMatchObject({
			kind: "seat",
			seats: 1,
		});
	});

	test("builds a mock billing catalog without checkout side effects", () => {
		const catalog = buildBillingCatalog();

		expect(catalog.status).toBe("mock");
		expect(catalog.currency).toBe("USD");
		expect(catalog.plans).toHaveLength(5);
		expect(catalog.addons.length).toBeGreaterThanOrEqual(5);
		// The DISPLAY catalog never offers retired SKUs.
		expect(catalog.addons.every((addon) => addon.active)).toBe(true);
		expect(catalog.addons.map((addon) => addon.id)).not.toContain("byo-api");
		expect(catalog.addons.map((addon) => addon.id)).not.toContain("team-jobs-10");
	});

	test("gates expensive AI image quality by workspace plan", () => {
		expect(workspacePlanAllowsAiQuality("free", "low")).toBe(true);
		// Free tastes medium (1 image/month via the 100-credit grant) — the
		// conversion hook. HIGH stays paid-only from Pro up.
		expect(workspacePlanAllowsAiQuality("free", "medium")).toBe(true);
		expect(workspacePlanAllowsAiQuality("free", "high")).toBe(false);
		expect(workspacePlanAllowsAiQuality("creator", "medium")).toBe(true);
		expect(workspacePlanAllowsAiQuality("creator", "high")).toBe(false);
		expect(workspacePlanAllowsAiQuality("pro", "high")).toBe(true);
		expect(workspacePlanAllowsAiQuality("studio_plus", "high")).toBe(true);
		expect(normalizeWorkspacePlanId(" Creator ")).toBe("creator");
		expect(isWorkspacePlanId("prototype")).toBe(false);
	});

	test("resolves per-plan AI queue admission caps", () => {
		expect(resolveWorkspacePlanAiQueueCaps("free")).toEqual({
			maxProjectOpenJobs: 5,
			maxProjectPendingJobs: 5,
		});
		expect(resolveWorkspacePlanAiQueueCaps("creator")).toEqual({
			maxProjectOpenJobs: 15,
			maxProjectPendingJobs: 10,
		});
		expect(resolveWorkspacePlanAiQueueCaps("prototype")).toEqual({
			maxProjectOpenJobs: 5,
			maxProjectPendingJobs: 5,
		});
	});
});

describe("credit pricing — 4× margin profitability invariants", () => {
	test("free tier grants exactly 100 monthly AI credits (10 low / 1 medium image)", () => {
		expect(resolveWorkspacePlan("free").monthlyAiCredits).toBe(100);
	});

	test("the single margin knob sells credits at ≥4× raw cost (0.09฿/credit)", () => {
		// Post-×10 rebase: raw cost per unit is 0.021฿; 4× floor = 0.084฿. The sale
		// rate is pinned to 0.09฿ — the smallest clean satang value above the floor —
		// so CENTS_PER_CREDIT stays an integer.
		expect(THB_PER_CREDIT).toBe(0.09);
		expect(CENTS_PER_CREDIT).toBe(9);
		expect(CREDIT_MARGIN_MULTIPLIER).toBe(4);
		expect(THB_PER_CREDIT).toBeGreaterThanOrEqual(RAW_AI_COST_THB_PER_CREDIT * CREDIT_MARGIN_MULTIPLIER);
	});

	test("every ACTIVE add-on credit pack sells at ≥ raw-cost × 4 and ≥ the sale rate", () => {
		const floorThbPerCredit = RAW_AI_COST_THB_PER_CREDIT * CREDIT_MARGIN_MULTIPLIER; // 0.084
		const creditPacks = listBillingAddonProducts().filter(
			(addon) => addon.kind === "ai_credits" && addon.active,
		);
		expect(creditPacks.length).toBeGreaterThan(0);
		for (const pack of creditPacks) {
			const credits = pack.aiCredits ?? 0;
			expect(credits).toBeGreaterThan(0);
			const thbPrice = pack.priceUsd * THB_PER_USD;
			const thbPerCredit = thbPrice / credits;
			// Never undersold: each pack clears both the sale rate and the 4× floor.
			expect(thbPerCredit).toBeGreaterThanOrEqual(THB_PER_CREDIT);
			expect(thbPerCredit).toBeGreaterThanOrEqual(floorThbPerCredit);
		}
	});

	test("every PAID plan's bundled credits are not sold below the credit sale rate", () => {
		// A plan must not give away credits worth (at the sale rate) MORE than its own
		// price — otherwise the credits alone are underpriced. We require the plan's THB
		// price to cover monthlyAiCredits × THB_PER_CREDIT with non-negative headroom.
		const paidPlans = listWorkspacePlans().filter((plan) => plan.priceUsdMonthly > 0);
		expect(paidPlans.length).toBe(4); // creator, pro, studio, studio_plus
		for (const plan of paidPlans) {
			const priceThb = plan.priceUsdMonthly * THB_PER_USD;
			const creditsValueThb = plan.monthlyAiCredits * THB_PER_CREDIT;
			const headroomThb = priceThb - creditsValueThb;
			// Credits never exceed the plan price at the sale rate → never undersold,
			// and there is room left for the plan's non-AI value (storage, seats, teams).
			expect(headroomThb).toBeGreaterThan(0);
		}
	});

	test("full-burn raw AI cost stays under 15% of every paid plan's price", () => {
		// The worst case for margin: a workspace that burns 100% of its monthly
		// credits. Raw provider spend must remain a small fraction of revenue.
		for (const plan of listWorkspacePlans().filter((p) => p.priceUsdMonthly > 0)) {
			const priceThb = plan.priceUsdMonthly * THB_PER_USD;
			const fullBurnRawThb = plan.monthlyAiCredits * RAW_AI_COST_THB_PER_CREDIT;
			expect(fullBurnRawThb / priceThb).toBeLessThan(0.15);
		}
	});
});
