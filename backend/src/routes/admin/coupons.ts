// Back-office COUPONS sub-router (ranks 9-11).
//
// Mounted at /api/admin/coupons by backend/src/routes/admin.ts. The parent admin
// router already applies authMiddleware + requirePermission(ACCESS) on every
// path, so requests that reach here are authenticated platform admins.
//
// Gating:
//   * Reads (list/get) require COUPONS_READ — matches the admin nav registry
//     (ADMIN_NAV_SECTIONS coupons → COUPONS_READ) so the section only renders for
//     roles that can actually read it.
//   * Writes (create/update/disable/delete) require COUPONS_WRITE — only owner /
//     admin hold it. support + accountant can NOT mutate coupons.
//
// Two coupon families live here:
//   1. Dodo discount coupons — a percentage off a Dodo invoice, managed entirely
//      in Dodo via dodoService (the COUPONS section appended to dodo.service.ts).
//   2. Internal credit-coupons — promo codes that grant spendable internal credits
//      via the creditCouponStore (migration 0055). Redemption is customer-facing
//      and lives OUTSIDE admin (routes/coupons.ts), per the scope.
//
// Every mutation writes an admin_audit row via the gdpr store so an external
// review can reconstruct who minted / changed / killed a coupon.

import { Hono } from "hono";
import { z } from "zod/v4";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { ADMIN_PERMISSIONS } from "../../types/auth.js";
import type { JWTPayload } from "../../types/auth.js";
import { readJsonBody } from "../../utils/request-body.js";
import { gdprStore, type GdprStore } from "../../services/gdpr.js";
import { DodoBillingError, dodoService as defaultDodoService, type DodoService } from "../../services/dodo.service.js";
import {
	CreditCouponError,
	creditCouponStore as defaultCreditCouponStore,
	type CreditCouponStore,
} from "../../services/credit-coupons.js";
import type { AdminRouterDeps } from "../admin.js";

// Local deps seam so tests can inject stubs without threading new fields through
// the shared AdminRouterDeps (which other domain workers also edit). Falls back
// to the module singletons in production.
export interface AdminCouponsDeps extends AdminRouterDeps {
	dodo?: DodoService;
	creditCoupons?: CreditCouponStore;
	gdpr?: GdprStore;
}

const createDiscountSchema = z.object({
	percentOff: z.number().positive().max(100),
	code: z.string().trim().min(3).max(16).optional(),
	name: z.string().trim().max(120).optional(),
	expiresAt: z.string().datetime().optional(),
	usageLimit: z.number().int().min(1).nullable().optional(),
	restrictedTo: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
	subscriptionCycles: z.number().int().min(1).nullable().optional(),
}).strict();

const updateDiscountSchema = z.object({
	percentOff: z.number().positive().max(100).optional(),
	code: z.string().trim().min(3).max(16).optional(),
	name: z.string().trim().max(120).nullable().optional(),
	expiresAt: z.string().datetime().nullable().optional(),
	usageLimit: z.number().int().min(1).nullable().optional(),
	restrictedTo: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
	subscriptionCycles: z.number().int().min(1).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
	message: "At least one field must be provided",
});

const createCreditCouponSchema = z.object({
	creditAmount: z.number().int().positive().max(10_000_000),
	code: z.string().trim().min(4).max(32).optional(),
	creditClass: z.enum(["personal", "shareable"]).optional(),
	maxRedemptions: z.number().int().min(1).nullable().optional(),
	perUserLimit: z.number().int().min(1).optional(),
	expiresAt: z.string().datetime().optional(),
	note: z.string().trim().max(1000).optional(),
}).strict();

export function createAdminCouponsRouter(deps: AdminCouponsDeps = {}): Hono {
	const router = new Hono();
	const dodo = deps.dodo ?? defaultDodoService;
	const creditCoupons = deps.creditCoupons ?? defaultCreditCouponStore;
	const gdpr = deps.gdpr ?? gdprStore;

	const READ = requirePermission(ADMIN_PERMISSIONS.COUPONS_READ);
	const WRITE = requirePermission(ADMIN_PERMISSIONS.COUPONS_WRITE);

	// ── Dodo discount coupons ─────────────────────────────────────
	router.post("/dodo", WRITE, async (c) => {
		const admin = requireAdminUser(c);
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = createDiscountSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		try {
			const discount = await dodo.createDiscountCoupon(parsed.data);
			await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				action: "admin.coupon.dodo.create",
				targetKind: "dodo_discount",
				targetId: discount.discountId,
				detail: { code: discount.code, percentOff: discount.percentOff, expiresAt: discount.expiresAt, usageLimit: discount.usageLimit },
			});
			return c.json({ discount }, 201);
		} catch (error) {
			return couponError(c, error);
		}
	});

	router.get("/dodo", READ, async (c) => {
		try {
			const discounts = await dodo.listDiscountCoupons({
				code: c.req.query("code")?.trim() || undefined,
				pageSize: c.req.query("pageSize") ? Number(c.req.query("pageSize")) : undefined,
				pageNumber: c.req.query("pageNumber") ? Number(c.req.query("pageNumber")) : undefined,
			});
			return c.json({ discounts });
		} catch (error) {
			return couponError(c, error);
		}
	});

	router.get("/dodo/:id", READ, async (c) => {
		try {
			const discount = await dodo.getDiscountCoupon(c.req.param("id") ?? "");
			return c.json({ discount });
		} catch (error) {
			return couponError(c, error);
		}
	});

	router.patch("/dodo/:id", WRITE, async (c) => {
		const admin = requireAdminUser(c);
		const id = c.req.param("id") ?? "";
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = updateDiscountSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		try {
			const discount = await dodo.updateDiscountCoupon(id, parsed.data);
			await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				action: "admin.coupon.dodo.update",
				targetKind: "dodo_discount",
				targetId: id,
				detail: { ...parsed.data },
			});
			return c.json({ discount });
		} catch (error) {
			return couponError(c, error);
		}
	});

	router.delete("/dodo/:id", WRITE, async (c) => {
		const admin = requireAdminUser(c);
		const id = c.req.param("id") ?? "";
		try {
			await dodo.deleteDiscountCoupon(id);
			await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				action: "admin.coupon.dodo.delete",
				targetKind: "dodo_discount",
				targetId: id,
				detail: {},
			});
			return c.json({ ok: true });
		} catch (error) {
			return couponError(c, error);
		}
	});

	// ── Internal credit-coupons ───────────────────────────────────
	router.post("/credit", WRITE, async (c) => {
		const admin = requireAdminUser(c);
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = createCreditCouponSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		try {
			const coupon = await creditCoupons.createCoupon({ ...parsed.data, createdBy: admin.userId });
			await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				action: "admin.coupon.credit.create",
				targetKind: "credit_coupon",
				targetId: coupon.id,
				detail: {
					code: coupon.code,
					creditAmount: coupon.creditAmount,
					creditClass: coupon.creditClass,
					maxRedemptions: coupon.maxRedemptions,
					perUserLimit: coupon.perUserLimit,
					expiresAt: coupon.expiresAt ?? null,
				},
			});
			return c.json({ coupon }, 201);
		} catch (error) {
			return couponError(c, error);
		}
	});

	router.get("/credit", READ, async (c) => {
		try {
			const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
			const coupons = await creditCoupons.listCoupons({ limit });
			return c.json({ coupons });
		} catch (error) {
			return couponError(c, error);
		}
	});

	router.get("/credit/:id", READ, async (c) => {
		try {
			const coupon = await creditCoupons.getCouponById(c.req.param("id") ?? "");
			if (!coupon) return c.json({ error: "Coupon not found", code: "coupon_not_found" }, 404);
			return c.json({ coupon });
		} catch (error) {
			return couponError(c, error);
		}
	});

	router.post("/credit/:id/disable", WRITE, async (c) => {
		const admin = requireAdminUser(c);
		const id = c.req.param("id") ?? "";
		try {
			const coupon = await creditCoupons.disableCoupon(id);
			if (!coupon) return c.json({ error: "Coupon not found", code: "coupon_not_found" }, 404);
			await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				action: "admin.coupon.credit.disable",
				targetKind: "credit_coupon",
				targetId: coupon.id,
				detail: { code: coupon.code },
			});
			return c.json({ coupon });
		} catch (error) {
			return couponError(c, error);
		}
	});

	return router;
}

function requireAdminUser(c: { get: (key: "user") => JWTPayload | undefined }): JWTPayload {
	const user = c.get("user");
	if (!user) throw new Error("auth_required");
	return user;
}

function couponError(c: any, error: unknown): Response {
	if (error instanceof CreditCouponError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	if (error instanceof DodoBillingError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}
