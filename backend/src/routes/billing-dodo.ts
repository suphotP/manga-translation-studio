import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod/v4";
import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import {
	WorkspaceAccessError,
	workspaceAccessStore as defaultWorkspaceAccessStore,
	type WorkspaceAccessStore,
} from "../services/workspace-access.js";
import {
	DodoBillingError,
	dodoService as defaultDodoService,
	type DodoAddonKey,
	type DodoBillingCycle,
	type DodoPlanKey,
	type DodoService,
} from "../services/dodo.service.js";
import { readJsonBody } from "../utils/request-body.js";
import { ACCEPTED_CHECKOUT_PLAN_KEYS } from "../services/plans.js";

export interface DodoBillingRouterDeps {
	service?: DodoService;
	workspaceAccessStore?: Pick<WorkspaceAccessStore, "requirePermission"> | null;
	authMiddleware?: MiddlewareHandler;
}

const checkoutSchema = z.object({
	plan_key: z.enum(ACCEPTED_CHECKOUT_PLAN_KEYS),
	billing_cycle: z.enum(["monthly", "yearly"]),
	// BYO retired (2026-06-12 owner decision): the add-on array stays for shape
	// compat but accepts NO values — any byo_api request 400s at the boundary.
	addons: z.array(z.never()).max(0).optional().default([]),
	// Apply-coupon-at-checkout (rank 10): an optional Dodo discount code. Additive
	// and optional, so the existing no-coupon checkout flow is unchanged.
	coupon_code: z.string().trim().min(3).max(16).optional(),
}).strict();

export function createDodoBillingRouter(deps: DodoBillingRouterDeps = {}): Hono {
	const billing = new Hono();
	const service = deps.service ?? defaultDodoService;
	const accessStore = deps.workspaceAccessStore !== undefined ? deps.workspaceAccessStore : defaultWorkspaceAccessStore;

	billing.use("*", deps.authMiddleware ?? authMiddleware);

	billing.post("/:workspaceId/checkout-session", async (c) => {
		const access = requireAccessStore(c, accessStore);
		if (access instanceof Response) return access;
		const user = getAuthUser(c) as JWTPayload;
		const workspaceId = c.req.param("workspaceId");
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = checkoutSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		try {
			await access.requirePermission(workspaceId, user.userId, "update_workspace");
			const result = await service.createCheckoutSession({
				workspaceId,
				planKey: parsed.data.plan_key as DodoPlanKey,
				cycle: parsed.data.billing_cycle as DodoBillingCycle,
				addons: parsed.data.addons as DodoAddonKey[],
				customer: {
					email: user.email,
				},
				couponCode: parsed.data.coupon_code,
			});
			return c.json(result);
		} catch (error) {
			return dodoRouteError(c, error);
		}
	});

	billing.post("/:workspaceId/portal-session", async (c) => {
		const access = requireAccessStore(c, accessStore);
		if (access instanceof Response) return access;
		const user = getAuthUser(c) as JWTPayload;
		const workspaceId = c.req.param("workspaceId");

		try {
			await access.requirePermission(workspaceId, user.userId, "update_workspace");
			const result = await service.createPortalSession(workspaceId);
			return c.json(result);
		} catch (error) {
			return dodoRouteError(c, error);
		}
	});

	return billing;
}

function requireAccessStore(c: any, store: Pick<WorkspaceAccessStore, "requirePermission"> | null): Pick<WorkspaceAccessStore, "requirePermission"> | Response {
	if (!store) {
		return c.json({
			error: "Workspace store is not configured",
			code: "workspace_store_unavailable",
		}, 503);
	}
	return store;
}

function dodoRouteError(c: any, error: unknown): Response {
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	if (error instanceof DodoBillingError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}

export const billingDodo = createDodoBillingRouter();
