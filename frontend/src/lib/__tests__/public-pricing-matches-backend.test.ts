// Anti-drift guard: the PUBLIC pricing surfaces (marketing /pricing page + the
// in-app upgrade cards, both fed by PUBLIC_PRICING_CARDS) MUST advertise exactly
// the plans/prices/allowances the backend will actually enforce. The enforced
// catalog is backend/src/services/plans.ts (WORKSPACE_PLANS + the byo-api
// add-on) — the single source of truth. This test pins the public cards 1:1
// to that catalog so a price/credit/storage/seat edit on one side without the
// other fails CI, and so no marketing-only tier (the old Starter/Studio Plus,
// or "ops"-based AI numbers) can silently reappear.

import { describe, it, expect } from "vitest";

import {
	PUBLIC_PRICING_CARDS,
	BYO_ADDON_USD_PER_MONTH,
	type PublicPlanKey,
} from "../stores/billing.svelte.ts";
import { toDodoCheckoutPlanKey } from "../api/client.ts";
import { THB_PER_CREDIT as FRONTEND_THB_PER_CREDIT } from "../stores/usage.svelte.ts";
import {
	WORKSPACE_PLANS,
	THB_PER_CREDIT as BACKEND_THB_PER_CREDIT,
	BILLING_ADDONS,
	GIB,
	ACCEPTED_CHECKOUT_PLAN_KEYS,
	type WorkspacePlanId,
} from "../../../../backend/src/services/plans.ts";

/** Bytes → whole GB, the unit the public storage label advertises. */
function bytesToGb(bytes: number): number {
	return Math.round(bytes / GIB);
}

/** Pull the leading integer out of a label like "25 GB" or "220 เครดิต / เดือน". */
function leadingInt(label: string): number {
	const match = label.replace(/,/g, "").match(/\d+/);
	expect(match, `no number found in label "${label}"`).not.toBeNull();
	return Number(match![0]);
}

describe("public pricing matches the enforced backend plan catalog", () => {
	const cardByKey = new Map<PublicPlanKey, (typeof PUBLIC_PRICING_CARDS)[number]>(
		PUBLIC_PRICING_CARDS.map((card) => [card.key, card]),
	);
	const backendPlanIds = Object.keys(WORKSPACE_PLANS) as WorkspacePlanId[];

	it("exposes exactly one public card per enforced backend plan (same keys)", () => {
		const cardKeys = [...cardByKey.keys()].sort();
		const planKeys = [...backendPlanIds].sort();
		expect(cardKeys).toEqual(planKeys);
		// no duplicate keys
		expect(PUBLIC_PRICING_CARDS.length).toBe(cardByKey.size);
	});

	for (const planId of backendPlanIds) {
		describe(`plan "${planId}"`, () => {
			const plan = WORKSPACE_PLANS[planId];
			const card = cardByKey.get(planId as PublicPlanKey)!;

			it("has a matching card", () => {
				expect(card, `no public card for backend plan "${planId}"`).toBeDefined();
			});

			it("advertises the enforced monthly USD price", () => {
				expect(card.monthlyUsd).toBe(plan.priceUsdMonthly);
			});

			it("advertises the enforced included storage (GB)", () => {
				expect(leadingInt(card.storageLabel)).toBe(bytesToGb(plan.includedStorageBytes));
			});

			it("advertises the enforced monthly AI CREDIT allowance (not ops)", () => {
				// The AI allowance is now carried as a number (`aiCredits`) and rendered
				// via the localized `pricing.specAiValue` ({count} credits/month) label,
				// so the public copy stays correct in every locale while remaining pinned
				// 1:1 to the backend credit grant.
				expect(card.aiCredits).toBe(plan.monthlyAiCredits);
			});

			it("advertises the enforced included seats", () => {
				expect(card.members).toBe(plan.maxSeatsIncluded);
			});
		});
	}

	// Checkout reconciliation (PR #290 R2 P1): renaming the public display key
	// ("starter" → "creator") must NOT break Dodo checkout. The cards advertise the
	// public display keys, but the Dodo checkout backend (billing-dodo.ts
	// checkoutSchema) only accepts its product-catalog keys. Assert every PAID card's
	// checkout key maps — via the same boundary mapper the app uses — to a key the
	// backend validator accepts, so display reconciliation can't silently 400 checkout.
	describe("every paid public card checks out with a backend-accepted Dodo plan key", () => {
		const acceptedKeys = new Set<string>(ACCEPTED_CHECKOUT_PLAN_KEYS);

		for (const card of PUBLIC_PRICING_CARDS) {
			if (card.key === "free") continue;
			it(`card "${card.key}" maps to a Dodo checkout key the backend accepts`, () => {
				const dodoKey = toDodoCheckoutPlanKey(card.key as Exclude<PublicPlanKey, "free">);
				expect(
					acceptedKeys.has(dodoKey),
					`public card "${card.key}" maps to Dodo checkout key "${dodoKey}", which the backend checkout validator does NOT accept (accepts: ${[...acceptedKeys].join(", ")})`,
				).toBe(true);
			});
		}
	});

	it("BYO add-on price matches the backend byo-api add-on", () => {
		const byo = BILLING_ADDONS.find((addon) => addon.id === "byo-api");
		expect(byo, "backend byo-api add-on missing").toBeDefined();
		expect(BYO_ADDON_USD_PER_MONTH).toBe(byo!.priceUsd);
	});

	it("BYO is retired (2026-06-12 owner decision): inactive in the catalog, offered on no card", () => {
		const byo = BILLING_ADDONS.find((addon) => addon.id === "byo-api")!;
		// The catalog row survives for historical grant resolution, but it must
		// never be active and no pricing card may advertise it (liability:
		// provider bans / model churn on customer keys land on us).
		expect(byo.active).toBe(false);
		for (const card of PUBLIC_PRICING_CARDS) {
			expect(card.byoAvailable).toBe(false);
			expect(card.byoIncluded).toBe(false);
		}
	});

	it("frontend display credit rate equals the backend sale rate (×10 rebase regression guard)", () => {
		// The top-bar meter converts THB→credits with a frontend-local constant;
		// after the ×10 rebase it briefly showed 'AI credits 0 / 11' on a
		// 100-credit free plan because only the backend constant moved.
		expect(FRONTEND_THB_PER_CREDIT).toBe(BACKEND_THB_PER_CREDIT);
	});
});
