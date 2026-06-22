// Admin COUPONS api barrel (ranks 9-11).
//
// Talks to /api/admin/coupons/* via the shared adminFetch client (same Bearer
// header + base URL handling as the rest of the admin surface). Two families:
//   * Dodo discount coupons (percentage off a Dodo invoice).
//   * Internal credit-coupons (promo codes that grant spendable credits).
//
// Reads require admin:coupons.read; writes require admin:coupons.write (the
// backend is authoritative — these calls 403 for roles without the permission).

import { adminFetch } from "./client.ts";

export interface DodoDiscount {
	discountId: string;
	code: string;
	percentOff: number;
	amountBasisPoints: number;
	type: string;
	name: string | null;
	expiresAt: string | null;
	usageLimit: number | null;
	timesUsed: number;
	restrictedTo: string[];
	createdAt: string | null;
}

export interface CreateDodoDiscountInput {
	percentOff: number;
	code?: string;
	name?: string;
	expiresAt?: string;
	usageLimit?: number | null;
	restrictedTo?: string[];
	subscriptionCycles?: number | null;
}

export type UpdateDodoDiscountInput = Partial<CreateDodoDiscountInput> & { name?: string | null; expiresAt?: string | null };

export type CreditCouponClass = "personal" | "shareable";
export type CreditCouponStatus = "active" | "disabled";

export interface CreditCoupon {
	id: string;
	code: string;
	creditAmount: number;
	creditClass: CreditCouponClass;
	maxRedemptions: number | null;
	perUserLimit: number;
	expiresAt?: string;
	status: CreditCouponStatus;
	createdBy: string;
	note?: string;
	createdAt: string;
	updatedAt: string;
	redemptionCount?: number;
}

export interface CreateCreditCouponInput {
	creditAmount: number;
	code?: string;
	creditClass?: CreditCouponClass;
	maxRedemptions?: number | null;
	perUserLimit?: number;
	expiresAt?: string;
	note?: string;
}

export const adminCouponsApi = {
	// ── Dodo discount coupons ─────────────────────────────────────
	listDodoDiscounts(query: { code?: string; pageSize?: number; pageNumber?: number } = {}): Promise<{ discounts: DodoDiscount[] }> {
		const params = new URLSearchParams();
		if (query.code) params.set("code", query.code);
		if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
		if (query.pageNumber !== undefined) params.set("pageNumber", String(query.pageNumber));
		const qs = params.toString();
		return adminFetch(`/admin/coupons/dodo${qs ? `?${qs}` : ""}`);
	},
	getDodoDiscount(id: string): Promise<{ discount: DodoDiscount }> {
		return adminFetch(`/admin/coupons/dodo/${encodeURIComponent(id)}`);
	},
	createDodoDiscount(input: CreateDodoDiscountInput): Promise<{ discount: DodoDiscount }> {
		return adminFetch(`/admin/coupons/dodo`, { method: "POST", body: JSON.stringify(input) });
	},
	updateDodoDiscount(id: string, input: UpdateDodoDiscountInput): Promise<{ discount: DodoDiscount }> {
		return adminFetch(`/admin/coupons/dodo/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
	},
	deleteDodoDiscount(id: string): Promise<{ ok: boolean }> {
		return adminFetch(`/admin/coupons/dodo/${encodeURIComponent(id)}`, { method: "DELETE" });
	},

	// ── Internal credit-coupons ───────────────────────────────────
	listCreditCoupons(limit?: number): Promise<{ coupons: CreditCoupon[] }> {
		const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
		return adminFetch(`/admin/coupons/credit${qs}`);
	},
	getCreditCoupon(id: string): Promise<{ coupon: CreditCoupon }> {
		return adminFetch(`/admin/coupons/credit/${encodeURIComponent(id)}`);
	},
	createCreditCoupon(input: CreateCreditCouponInput): Promise<{ coupon: CreditCoupon }> {
		return adminFetch(`/admin/coupons/credit`, { method: "POST", body: JSON.stringify(input) });
	},
	disableCreditCoupon(id: string): Promise<{ coupon: CreditCoupon }> {
		return adminFetch(`/admin/coupons/credit/${encodeURIComponent(id)}/disable`, { method: "POST" });
	},
};
