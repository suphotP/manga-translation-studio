// Exhaustive permutation tests for `paymentSkuCredits` — the FAIL-SAFE resolver of
// the AI credits a succeeded payment OWES. This is the single point where, across FOUR
// review rounds, a non-AI purchase kept falling through to mint the workspace plan's
// monthly AI credits. The function is tested in isolation (pure over tx.raw / tx.planId)
// so every precedence permutation is pinned, independent of the agent loop.
//
// Precedence under test (see ai-tools.ts paymentSkuCredits):
//   1. ADD-ON WORLD: if the payment carries ANY NON-EMPTY explicit add-on id
//      (sku/skuId/addon_id/addonId/product_id/productId or a non-empty `addons`
//      string|array entry) — RECOGNIZED OR NOT — the purchase is ADD-ON-SCOPED → owed =
//      SUM of the RECOGNIZED AI-credit add-ons' credits (non-AI add-on AND unrecognized id
//      each contribute 0). RETURN even if 0; NEVER consult the plan.
//   2. PLAN WORLD (ONLY when NO non-empty explicit add-on id appears anywhere — a pure
//      plan subscription): a plan field resolves through planMonthlyCredits (WORKSPACE_PLANS
//      only, never add-ons). Add-on id / garbage in a plan field → 0.
//   3. otherwise → 0.
//
// ROUND-4 FAIL-SAFE: an add-on-bearing payment can NEVER auto-mint the plan's free AI
// credits. Worst case is an under-grant (safe — a human can top up); over-grant is
// structurally impossible. Dodo stores add-ons with UNDERSCORE keys (`byo_api`); the
// catalog uses HYPHEN ids (`byo-api`). resolveBillingAddon alias-normalizes the keys.

import { describe, expect, test } from "bun:test";
import { paymentSkuCredits } from "../services/support/ai-tools.js";
import type { PaymentTransaction } from "../services/payment-transactions-store.js";

/** Build a minimal succeeded payment carrying the given raw metadata + optional planId. */
function payment(
	raw: Record<string, unknown>,
	planId: string | null = null,
): PaymentTransaction {
	return {
		id: "tx-test",
		workspaceId: "ws-1",
		dodoPaymentId: null,
		dodoInvoiceId: null,
		dodoEventRef: "evt-1",
		dodoEventId: null,
		kind: "payment",
		amountCents: 400,
		taxCents: null,
		currency: "USD",
		status: "succeeded",
		planId,
		billingCycle: null,
		occurredAt: "2026-06-04T00:00:00.000Z",
		raw,
		createdAt: "2026-06-04T00:00:00.000Z",
	};
}

describe("paymentSkuCredits — add-on world (explicit add-on id)", () => {
	test("addon_id=credits-50 → 500 (legacy rebased ×10)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addon_id: "credits-50" } }))).toBe(500);
	});

	test("addon_id=credits-200 → 2000 (legacy rebased ×10)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addon_id: "credits-200" } }))).toBe(2000);
	});

	test("sku=credits-50 → 500", () => {
		expect(paymentSkuCredits(payment({ metadata: { sku: "credits-50" } }))).toBe(500);
	});

	test("product_id=credits-200 → 2000", () => {
		expect(paymentSkuCredits(payment({ metadata: { product_id: "credits-200" } }))).toBe(2000);
	});

	// Round-2 P1: a non-AI add-on id is authoritative and owes 0 — it must NOT fall through
	// to the plan even when the row carries a planId.
	test("explicit sku=storage-25gb + planId=creator → 0 (not the plan's 60)", () => {
		expect(paymentSkuCredits(payment({ metadata: { sku: "storage-25gb" } }, "creator"))).toBe(0);
	});

	test("explicit addon_id=seat-1 + planId=pro → 0 (not the plan's 220)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addon_id: "seat-1" } }, "pro"))).toBe(0);
	});

	test("explicit addon_id=byo-api + planId=studio → 0 (not the plan's 700)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addon_id: "byo-api" } }, "studio"))).toBe(0);
	});
});

describe("paymentSkuCredits — add-on world via the `addons` list field", () => {
	// Round-3 P1 #1: an `addons` list of ONLY non-AI add-ons sums to 0 — and MUST return 0,
	// NOT fall through to the plan (the bug that minted the plan's 60 credits).
	test("addons='storage-25gb' (string) + planId=creator → 0 (round-3 P1 #1)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "storage-25gb" } }, "creator"))).toBe(0);
	});

	test("addons=['seat-1'] (array) + planId=creator → 0 (round-3 P1 #1)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: ["seat-1"] } }, "creator"))).toBe(0);
	});

	test("addons=['seat-1','storage-25gb'] (only non-AI) + planId=pro → 0", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: ["seat-1", "storage-25gb"] } }, "pro"))).toBe(0);
	});

	// A recognized AI add-on in the list resolves to its credits, NOT summed with non-AI
	// add-ons (which contribute 0) and NOT to the plan.
	test("addons=['credits-50','storage-25gb'] → 500 (AI add-on only, not plan)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: ["credits-50", "storage-25gb"] } }, "creator"))).toBe(500);
	});

	test("addons='credits-50' (string) → 500", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "credits-50" } }))).toBe(500);
	});

	test("addons='credits-50,credits-200' (two AI packs) → 2500 (summed)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "credits-50,credits-200" } }))).toBe(2500);
	});

	test("addons=['credits-50','credits-200'] (array, two AI packs) → 2500 (summed)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: ["credits-50", "credits-200"] } }))).toBe(2500);
	});

	// Single-id field + list field both present: a recognized add-on in EITHER triggers the
	// add-on world; recognized ids across both are summed, unknown ids contribute 0.
	test("sku=credits-50 + addons=['credits-200'] → 2500 (both recognized, summed)", () => {
		expect(paymentSkuCredits(payment({ metadata: { sku: "credits-50", addons: ["credits-200"] } }))).toBe(2500);
	});

	test("sku=storage-25gb (non-AI) + addons=['credits-50'] → 500", () => {
		expect(paymentSkuCredits(payment({ metadata: { sku: "storage-25gb", addons: ["credits-50"] } }, "pro"))).toBe(500);
	});

	test("addons list with unknown ids + one AI pack → only the AI pack's credits", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: ["mystery-pack", "credits-200", "garbage"] } }))).toBe(2000);
	});

	test("addons array with a non-string element is ignored, AI pack still counts", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(paymentSkuCredits(payment({ metadata: { addons: [42 as any, "credits-50"] } }))).toBe(500);
	});
});

describe("paymentSkuCredits — round-4 P1: Dodo underscore add-on keys (alias-normalized)", () => {
	// THE round-4 bug: Dodo checkout stores add-ons with UNDERSCORE keys
	// (metadata.addons = "byo_api"), but the catalog uses HYPHEN ids ("byo-api"). The key
	// failed to resolve → fell through to the plan → minted the plan's free AI credits for a
	// non-AI BYO purchase. After alias-normalization, byo_api resolves to the recognized
	// non-AI byo-api add-on → 0, and (fail-safe) the add-on field blocks the plan anyway.
	test("addons='byo_api' (Dodo underscore key) + planId=creator → 0 (round-4 P1)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "byo_api" } }, "creator"))).toBe(0);
	});

	test("addons=['byo_api'] (array) + planId=studio → 0 (not the plan's 700)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: ["byo_api"] } }, "studio"))).toBe(0);
	});

	test("sku='byo_api' (single-id field) + planId=studio → 0", () => {
		expect(paymentSkuCredits(payment({ metadata: { sku: "byo_api" } }, "studio"))).toBe(0);
	});

	// Each Dodo underscore alias resolves to its catalog id. AI-credit packs resolve to
	// their credits; non-AI add-ons resolve to a recognized (0-credit) add-on. None falls
	// through to the plan.
	test("addons='credits_50' (Dodo key) → 500 (resolves to catalog credits-50)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "credits_50" } }))).toBe(500);
	});

	test("addons='credits_200' (Dodo key) → 2000 (resolves to catalog credits-200)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "credits_200" } }))).toBe(2000);
	});

	test("addons='storage_25gb' (Dodo key) + planId=creator → 0 (recognized non-AI, not plan 60)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "storage_25gb" } }, "creator"))).toBe(0);
	});

	test("addons='storage_100gb' (Dodo key) + planId=pro → 0 (recognized non-AI)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "storage_100gb" } }, "pro"))).toBe(0);
	});

	test("addons='seat_1' (Dodo key) + planId=pro → 0 (recognized non-AI, not plan 220)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "seat_1" } }, "pro"))).toBe(0);
	});

	test("addons='team_jobs_10' (Dodo key) + planId=studio → 0 (recognized non-AI)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "team_jobs_10" } }, "studio"))).toBe(0);
	});

	// Generic underscore↔hyphen tolerance: a Dodo-style key not in the explicit alias map
	// still folds to its hyphenated catalog id (so a recognized AI pack still grants).
	test("addons='credits_50,storage_25gb' (mixed Dodo keys) → 500 (AI pack only, non-AI 0)", () => {
		expect(paymentSkuCredits(payment({ metadata: { addons: "credits_50,storage_25gb" } }, "pro"))).toBe(500);
	});
});

describe("paymentSkuCredits — plan world (only when NO recognized add-on)", () => {
	// Control: a genuine plan subscription payment (planId set, no add-on) owes the plan's
	// monthlyAiCredits.
	test("planId=creator, no add-on → 1000", () => {
		expect(paymentSkuCredits(payment({ metadata: { user_id: "u-1" } }, "creator"))).toBe(1000);
	});

	test("planId=pro, no add-on → 4000", () => {
		expect(paymentSkuCredits(payment({ metadata: { user_id: "u-1" } }, "pro"))).toBe(4000);
	});

	test("planId=studio, no add-on → 11000", () => {
		expect(paymentSkuCredits(payment({ metadata: { user_id: "u-1" } }, "studio"))).toBe(11000);
	});

	test("free plan owes its 100 monthly credits", () => {
		expect(paymentSkuCredits(payment({}, "free"))).toBe(100);
	});

	test("plan id from metadata.plan_key (no planId column) → resolves plan credits", () => {
		expect(paymentSkuCredits(payment({ metadata: { plan_key: "pro" } }))).toBe(4000);
	});

	test("plan id from metadata.plan_id (no planId column) → resolves plan credits", () => {
		expect(paymentSkuCredits(payment({ metadata: { plan_id: "studio" } }))).toBe(11000);
	});

	// Round-3 P1 #2: an ADD-ON id mistakenly in a PLAN field must NEVER cross-resolve to the
	// add-on's credits. planMonthlyCredits checks WORKSPACE_PLANS only.
	test("plan_key=credits-50 (add-on id in plan field), no explicit add-on → 0 (round-3 P1 #2)", () => {
		expect(paymentSkuCredits(payment({ metadata: { plan_key: "credits-50" } }))).toBe(0);
	});

	test("planId=credits-50 (add-on id in plan column), no explicit add-on → 0 (round-3 P1 #2)", () => {
		expect(paymentSkuCredits(payment({ metadata: { user_id: "u-1" } }, "credits-50"))).toBe(0);
	});

	test("plan_id=credits-200 (add-on id in plan field) → 0 (round-3 P1 #2)", () => {
		expect(paymentSkuCredits(payment({ metadata: { plan_id: "credits-200" } }))).toBe(0);
	});

	test("planId=garbage-plan → 0", () => {
		expect(paymentSkuCredits(payment({}, "not-a-real-plan"))).toBe(0);
	});
});

describe("paymentSkuCredits — fail-closed defaults", () => {
	test("no SKU and no plan anywhere → 0", () => {
		expect(paymentSkuCredits(payment({ metadata: { user_id: "u-1" } }))).toBe(0);
	});

	test("empty raw → 0", () => {
		expect(paymentSkuCredits(payment({}))).toBe(0);
	});

	test("no metadata object, no planId → 0", () => {
		expect(paymentSkuCredits(payment({ user_id: "top-level-ignored" }))).toBe(0);
	});

	test("unknown explicit sku, no plan → 0 (add-on-scoped: unrecognized id contributes 0, never consults the plan)", () => {
		expect(paymentSkuCredits(payment({ metadata: { sku: "mystery-product" } }))).toBe(0);
	});

	// Round-4 FAIL-SAFE: an UNRECOGNIZED explicit add-on id is STILL add-on-scoped — its
	// presence alone makes the payment an add-on buy, so we owe the sum of recognized AI
	// add-ons (here 0) and NEVER fall through to the plan's credits. This intentionally
	// changes the prior round-3 behavior (unknown id + valid plan → plan credits) to 0:
	// an add-on-bearing payment must never auto-mint plan AI credits. Worst case is an
	// under-grant (safe — a human can top up); over-grant is structurally impossible.
	test("unknown explicit sku + valid planId → 0 (round-4 fail-safe: add-on-bearing payment never grants plan credits)", () => {
		expect(paymentSkuCredits(payment({ metadata: { sku: "mystery-product" } }, "creator"))).toBe(0);
	});

	test("empty-string add-on id is ignored → plan world applies", () => {
		expect(paymentSkuCredits(payment({ metadata: { sku: "  ", addons: "" } }, "pro"))).toBe(4000);
	});
});
