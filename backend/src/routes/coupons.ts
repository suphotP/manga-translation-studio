// Customer-facing credit-coupon redemption (rank 11).
//
// Mounted at /api/coupons (NOT under /api/admin — this is auth-only, any
// authenticated user can redeem a code). Separate route file so it never touches
// admin.ts or any other domain's sub-router.
//
// POST /api/coupons/redeem { code, workspaceId } → grants the coupon's credits to
// the redeeming user, IDEMPOTENTLY and CRASH-SAFELY:
//   1. reserveRedemption() durably records the redemption (race-/retry-safe; a
//      second redeem by the same user, or a retry with the same idempotency key,
//      converges on the existing row and does NOT reserve again). It enforces
//      expiry, disabled status, per_user_limit and max_redemptions transactionally.
//   2. completeGrant() mints the credits via grantCredits() keyed on the REDEMPTION
//      ID, then attaches the grant id back onto the redemption. Because the grant is
//      idempotent on the redemption id, this step is safe to run any number of times:
//      exactly one grant is ever produced per redemption.
//   3. Every fresh redemption is audited.
//
// CRASH SAFETY — the redemption row (Postgres) and the credit grant (file store) are
// in separate subsystems and cannot share one DB transaction. So instead of trusting
// a single commit, the grant is made RECOVERABLE: if a previous attempt reserved the
// redemption but died before (or during) the grant, a RETRY observes the existing
// redemption with grant_id = NULL and COMPLETES the grant — idempotently keyed on the
// redemption id, so it can neither double-grant nor be skipped. A redemption is only
// reported as "already redeemed, 0 new credits" once its grant_id is durably set.
// Net guarantee: for ANY sequence of failures + retries the customer ends with
// EXACTLY the coupon's credits granted once, never "coupon consumed, 0 credits".
//
// The credits are granted to the REDEEMING USER (ownerScope=user) so they are
// spendable. The user must be a member of the target workspace (read_workspace),
// mirroring how routes/credits.ts authorizes balance reads — so a code can't be
// redeemed into a workspace the caller has no access to.

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod/v4";
import { authMiddleware as defaultAuthMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import { readJsonBody } from "../utils/request-body.js";
import {
	CreditCouponError,
	creditCouponStore as defaultCreditCouponStore,
	normalizeCouponCode,
	type CreditCouponStore,
} from "../services/credit-coupons.js";
import {
	CreditServiceError,
	grantCredits as defaultGrantCredits,
	type GrantCreditsInput,
} from "../services/credits.js";
import { gdprStore as defaultGdprStore, type GdprStore } from "../services/gdpr.js";
import {
	WorkspaceAccessError,
	workspaceAccessStore as defaultWorkspaceAccessStore,
	type WorkspaceAccessStore,
} from "../services/workspace-access.js";

export interface CouponsRouterDeps {
	/**
	 * Mint credits for a redemption. MUST honor `input.idempotencyKey`: a repeated
	 * call with the same key returns the already-minted grant rather than minting a
	 * second one. The redeem handler passes the redemption id as the key so the grant
	 * is exactly-once across crash + retry.
	 */
	grantCredits?: (input: GrantCreditsInput) => Promise<{ id: string }>;
	creditCoupons?: CreditCouponStore;
	gdpr?: GdprStore;
	workspaceAccessStore?: Pick<WorkspaceAccessStore, "requirePermission"> | null;
	authMiddleware?: MiddlewareHandler;
}

const redeemSchema = z.object({
	code: z.string().trim().min(1).max(64),
	workspaceId: z.string().trim().min(1).max(200),
	/** Optional client idempotency key; defaults to (coupon, user) server-side. */
	idempotencyKey: z.string().trim().min(1).max(200).optional(),
}).strict();

export function createCouponsRouter(deps: CouponsRouterDeps = {}): Hono {
	const router = new Hono();
	const creditCoupons = deps.creditCoupons ?? defaultCreditCouponStore;
	const grantCredits = deps.grantCredits ?? defaultGrantCredits;
	const gdpr = deps.gdpr ?? defaultGdprStore;
	const accessStore = deps.workspaceAccessStore !== undefined ? deps.workspaceAccessStore : defaultWorkspaceAccessStore;

	router.use("*", deps.authMiddleware ?? defaultAuthMiddleware);

	router.post("/redeem", async (c) => {
		const user = getAuthUser(c) as JWTPayload;
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = redeemSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		let code: string;
		try {
			code = normalizeCouponCode(parsed.data.code);
		} catch (error) {
			return couponError(c, error);
		}

		// The caller must be a member of the workspace the credits land in.
		const accessError = await requireWorkspaceMember(c, accessStore, parsed.data.workspaceId, user);
		if (accessError) return accessError;

		// Default idempotency key ties a fresh redemption to (coupon, user) so a
		// double-submit without an explicit key still can't grant twice.
		const idempotencyKey = parsed.data.idempotencyKey ?? `${code}:${user.userId}`;
		const now = new Date();

		try {
			const outcome = await creditCoupons.reserveRedemption({
				code,
				userId: user.userId,
				workspaceId: parsed.data.workspaceId,
				idempotencyKey,
				now,
			});

			// A redemption row whose grant_id is already set is genuinely complete:
			// the credits were minted on a prior call. Report it as an idempotent
			// replay with 0 NEW credits.
			if (outcome.alreadyRedeemed && outcome.redemption.grantId) {
				return c.json({
					ok: true,
					alreadyRedeemed: true,
					creditsGranted: 0,
					creditClass: outcome.coupon.creditClass,
					grantId: outcome.redemption.grantId,
					coupon: publicCoupon(outcome.coupon),
				});
			}

			// Either a FRESH reservation, OR a prior reservation whose grant never
			// completed (grant_id is NULL — the process died after reserving). In both
			// cases we (re)run the grant. grantCredits is idempotent on the redemption
			// id, so this can run any number of times yet mint EXACTLY ONE grant — the
			// coupon can never be "consumed with 0 credits".
			//
			// Grant to the OWNER/WORKSPACE recorded on the redemption row, not the
			// current caller. For a fresh redeem these equal the caller's values; for a
			// recovery they pin the credits to whoever originally reserved the coupon, so
			// a caller replaying someone else's explicit idempotency key can never divert
			// the grant to themselves.
			const grant = await grantCredits({
				workspaceId: outcome.redemption.workspaceId,
				ownerScope: "user",
				ownerId: outcome.redemption.userId,
				creditClass: outcome.coupon.creditClass,
				amount: outcome.coupon.creditAmount,
				source: "topup",
				expiresAt: undefined,
				idempotencyKey: outcome.redemption.id,
			});
			// Link the grant id back onto the redemption. If this fails, the next retry
			// re-derives the SAME grant (keyed on the redemption id) and re-links — so a
			// failed link never burns the coupon or double-grants.
			await creditCoupons.attachGrantId(outcome.redemption.id, grant.id).catch(() => {
				// Best-effort link; the redemption + grant are already durable.
			});

			await gdpr.recordAdminAudit({
				adminUserId: user.userId,
				action: "coupon.credit.redeem",
				targetKind: "credit_coupon",
				targetId: outcome.coupon.id,
				detail: {
					code: outcome.coupon.code,
					workspaceId: outcome.redemption.workspaceId,
					creditAmount: outcome.coupon.creditAmount,
					creditClass: outcome.coupon.creditClass,
					grantId: grant.id,
					redemptionId: outcome.redemption.id,
					// True when this call completed a grant left dangling by a prior
					// crashed attempt, rather than a brand-new redemption.
					recovered: outcome.alreadyRedeemed,
				},
			}).catch(() => { /* audit is best-effort, never blocks the grant */ });

			return c.json({
				ok: true,
				alreadyRedeemed: outcome.alreadyRedeemed,
				creditsGranted: outcome.coupon.creditAmount,
				creditClass: outcome.coupon.creditClass,
				grantId: grant.id,
				coupon: publicCoupon(outcome.coupon),
			});
		} catch (error) {
			return couponError(c, error);
		}
	});

	return router;
}

function publicCoupon(coupon: { code: string; creditAmount: number; creditClass: string }): { code: string; creditAmount: number; creditClass: string } {
	// Never leak internal fields (createdBy, redemption stats) to the customer.
	return { code: coupon.code, creditAmount: coupon.creditAmount, creditClass: coupon.creditClass };
}

async function requireWorkspaceMember(
	c: any,
	store: Pick<WorkspaceAccessStore, "requirePermission"> | null,
	workspaceId: string,
	user: JWTPayload,
): Promise<Response | null> {
	if (!store) {
		// File-mode without a workspace store: platform admins may still redeem
		// (used by tests); otherwise reject so a code can't be redeemed blind.
		if (user.role === "owner" || user.role === "admin") return null;
		return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	}
	try {
		await store.requirePermission(workspaceId, user.userId, "read_workspace");
		return null;
	} catch (error) {
		if (error instanceof WorkspaceAccessError) {
			return c.json({ error: error.message, code: error.code }, error.status);
		}
		throw error;
	}
}

function couponError(c: any, error: unknown): Response {
	if (error instanceof CreditCouponError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	if (error instanceof CreditServiceError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}

export const coupons = createCouponsRouter();
