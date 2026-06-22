// Internal workspace billing API.
//
// Read/write a workspace's assigned plan (and active add-on grants) via the
// DB-backed BillingStore. This is INTERNAL only — no payment provider, no
// checkout. Plan ASSIGNMENT lives in the billing store; the plan CATALOG
// (definitions of free/creator/pro/studio + add-ons) stays in plans.ts.
//
// Access control:
//   - reading a workspace's plan/grants requires `read_workspace` (tenant-scoped)
//   - ASSIGNING a plan is a platform-internal operation: assigning studio/pro
//     grants paid storage/AI limits with no checkout, so it must NOT be self-
//     serviceable by a tenant owner/admin. The write is gated behind the
//     existing PLATFORM admin role (JWT role === "admin", via requireAdmin) in
//     ADDITION to the tenant `update_workspace` permission. No new auth
//     primitive is introduced — this reuses the same guard the admin routes
//     (`/api/auth/users`, `/api/ai/admin/config`) already use.

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { serverConfig } from "../config.js";
import { authMiddleware, getAuthUser, requireAdmin } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import {
	WorkspaceAccessError,
	workspaceAccessStore as defaultWorkspaceAccessStore,
	type WorkspaceAccessStore,
	type WorkspacePermission,
} from "../services/workspace-access.js";
import {
	BillingStoreError,
	billingStore as defaultBillingStore,
	type BillingStore,
} from "../services/billing-store.js";
import {
	isWorkspacePlanId,
	listWorkspacePlans,
	resolveWorkspacePlan as resolvePlanDefinition,
	type WorkspacePlanId,
} from "../services/plans.js";
import { readJsonBody } from "../utils/request-body.js";

/**
 * The route only needs to enforce permissions, not the full workspace-access
 * surface — narrowing keeps the dependency honest and easy to fake in tests.
 */
export type BillingPermissionChecker = Pick<WorkspaceAccessStore, "requirePermission">;

export interface BillingRouterDeps {
	billingStore?: BillingStore;
	workspaceAccessStore?: BillingPermissionChecker | null;
	/** Override the auth middleware (tests inject a context user without JWTs). */
	authMiddleware?: MiddlewareHandler;
	/**
	 * Platform-internal guard for the plan-assignment WRITE. Defaults to
	 * `requireAdmin` (platform admin role). Tests inject a stub to exercise the
	 * allow/deny paths without minting real JWTs.
	 */
	platformAdminGuard?: MiddlewareHandler;
	/**
	 * Payment-provider settings for the checkout/portal session endpoints.
	 * Defaults to the server's `billing` config. Tests override to exercise the
	 * mock-URL shape without touching process env.
	 */
	billingConfig?: { provider: "mock" | "dodo"; appBaseUrl: string };
}

const setPlanSchema = z.object({
	planId: z.string().trim().refine((value) => isWorkspacePlanId(value), {
		message: "Unknown workspace plan",
	}),
	status: z.enum(["mock_active", "trialing", "active", "past_due", "cancelled"]).optional(),
	billingEmail: z.string().trim().email().max(320).optional(),
}).strict();

// Public Dodo plan keys the frontend pricing/billing pages emit. They map onto
// the internal 5-tier plan catalog (plans.ts) 1:1 since the 2026-06-12 redesign
// (studio_plus is a real plan). BYO is retired: the addons field stays for
// shape compat but accepts no values.
const DODO_PLAN_KEYS = ["starter", "pro", "studio", "studio_plus"] as const;
type DodoPlanKey = (typeof DODO_PLAN_KEYS)[number];

const checkoutSchema = z.object({
	plan_key: z.enum(DODO_PLAN_KEYS),
	billing_cycle: z.enum(["monthly", "yearly"]),
	addons: z.array(z.never()).max(0).optional(),
}).strict();

/** Maps a public Dodo plan key onto the internal plan catalog id. */
function dodoPlanKeyToInternalPlanId(planKey: DodoPlanKey): WorkspacePlanId {
	switch (planKey) {
		case "starter":
			return "creator";
		case "pro":
			return "pro";
		case "studio":
			return "studio";
		case "studio_plus":
			return "studio_plus";
	}
}

export function createBillingRouter(deps: BillingRouterDeps = {}): Hono {
	const billing = new Hono();
	const store = deps.billingStore ?? defaultBillingStore;
	const accessStore = deps.workspaceAccessStore !== undefined ? deps.workspaceAccessStore : defaultWorkspaceAccessStore;
	const platformAdminGuard = deps.platformAdminGuard ?? requireAdmin;
	const billingConfig = deps.billingConfig ?? serverConfig.billing;

	billing.use("*", deps.authMiddleware ?? authMiddleware);

	// Assignable plan catalog — definitions only, no tenant data.
	billing.get("/plans", (c) => {
		// Static plan catalog — no user/workspace data. `private` (not `public`) because the
		// route sits behind authMiddleware, so only the caller's own browser caches it; short
		// TTL since the catalog changes only on deploy.
		c.header("Cache-Control", "private, max-age=300");
		return c.json({ plans: listWorkspacePlans() });
	});

	// Current plan + active add-on grants for a workspace.
	billing.get("/:workspaceId", async (c) => {
		const access = requireAccessStore(c, accessStore);
		if (access instanceof Response) return access;
		const user = requireUser(c);
		const workspaceId = c.req.param("workspaceId");
		try {
			await requirePermission(access, workspaceId, user.userId, "read_workspace");
			const [resolved, assignment, grants] = await Promise.all([
				store.resolveWorkspacePlan(workspaceId),
				store.getWorkspaceAssignment(workspaceId),
				store.listActiveGrants(workspaceId),
			]);
			return c.json({
				workspaceId: resolved.workspaceId,
				planId: resolved.planId,
				assigned: resolved.assigned,
				plan: resolvePlanDefinition(resolved.planId),
				assignment,
				grants,
			});
		} catch (error) {
			return billingErrorResponse(c, error);
		}
	});

	// Assign (insert or update) a workspace's plan.
	//
	// PLATFORM-INTERNAL: `platformAdminGuard` (requireAdmin) runs first and
	// rejects any non-platform-admin caller with 403 before the tenant check, so
	// a tenant owner/admin cannot self-assign a paid plan. The `update_workspace`
	// check below additionally scopes the write to the target workspace.
	billing.put("/:workspaceId/plan", platformAdminGuard, async (c) => {
		const access = requireAccessStore(c, accessStore);
		if (access instanceof Response) return access;
		const user = requireUser(c);
		const workspaceId = c.req.param("workspaceId");
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = setPlanSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		try {
			await requirePermission(access, workspaceId, user.userId, "update_workspace");
			const assignment = await store.setWorkspacePlan({
				workspaceId,
				planId: parsed.data.planId as WorkspacePlanId,
				status: parsed.data.status,
				billingEmail: parsed.data.billingEmail,
			});
			return c.json({
				assignment,
				plan: resolvePlanDefinition(assignment.planId),
			});
		} catch (error) {
			return billingErrorResponse(c, error);
		}
	});

	// Start a checkout session for a plan/add-on purchase.
	//
	// SELF-SERVICE: a workspace owner/admin buys their own plan, so this is gated
	// on the tenant `update_workspace` permission (NOT the platform-admin guard
	// that protects the internal plan-assignment write). When the real Dodo
	// provider is not configured (`provider === "mock"`, the default in this
	// wave) we return a clearly-labeled prototype checkout URL on the app origin
	// so the pricing/billing CTAs resolve instead of 404ing. Wiring the real
	// Dodo SDK only swaps the URL builder below.
	billing.post("/:workspaceId/checkout-session", async (c, next) => {
		// When an operator has opted into the real provider (`provider === "dodo"`),
		// delegate to the Dodo billing router (`billing-dodo.ts`, mounted right after
		// this one at /api/billing) by falling through. We only own this path for the
		// default "mock" prototype provider so the pricing/billing CTAs resolve to a
		// labeled prototype URL instead of 404ing; the real Dodo SDK lives downstream.
		if (billingConfig.provider !== "mock") return next();
		const access = requireAccessStore(c, accessStore);
		if (access instanceof Response) return access;
		const user = requireUser(c);
		const workspaceId = c.req.param("workspaceId");
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = checkoutSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		try {
			await requirePermission(access, workspaceId, user.userId, "update_workspace");
			const sessionId = `mock_cs_${randomUUID()}`;
			const planInternalId = dodoPlanKeyToInternalPlanId(parsed.data.plan_key);
			const params = new URLSearchParams({
				mock: "1",
				session: sessionId,
				workspace: workspaceId,
				plan: parsed.data.plan_key,
				internal_plan: planInternalId,
				cycle: parsed.data.billing_cycle,
			});
			for (const addon of parsed.data.addons ?? []) params.append("addon", addon);
			return c.json({
				checkout_url: `${billingConfig.appBaseUrl}/billing/mock-checkout?${params.toString()}`,
				session_id: sessionId,
				provider: "mock",
			});
		} catch (error) {
			return billingErrorResponse(c, error);
		}
	});

	// Open the customer portal (manage/cancel/payment method/invoices).
	//
	// SELF-SERVICE: same tenant `update_workspace` gate as checkout. Returns a
	// labeled prototype portal URL while the provider is "mock".
	billing.post("/:workspaceId/portal-session", async (c, next) => {
		// Same provider routing as checkout-session: defer to the real Dodo router
		// downstream when provider === "dodo"; otherwise serve the labeled prototype
		// portal URL so "Manage subscription" resolves instead of 404ing.
		if (billingConfig.provider !== "mock") return next();
		const access = requireAccessStore(c, accessStore);
		if (access instanceof Response) return access;
		const user = requireUser(c);
		const workspaceId = c.req.param("workspaceId");

		try {
			await requirePermission(access, workspaceId, user.userId, "update_workspace");
			const params = new URLSearchParams({ mock: "1", workspace: workspaceId });
			return c.json({
				portal_url: `${billingConfig.appBaseUrl}/billing/mock-portal?${params.toString()}`,
				provider: "mock",
			});
		} catch (error) {
			return billingErrorResponse(c, error);
		}
	});

	return billing;
}

async function requirePermission(
	store: BillingPermissionChecker,
	workspaceId: string,
	userId: string,
	permission: WorkspacePermission,
): Promise<void> {
	await store.requirePermission(workspaceId, userId, permission);
}

function requireAccessStore(c: any, store: BillingPermissionChecker | null): BillingPermissionChecker | Response {
	if (!store) {
		return c.json({
			error: "Workspace store is not configured",
			code: "workspace_store_unavailable",
		}, 503);
	}
	return store;
}

function requireUser(c: any): JWTPayload {
	return getAuthUser(c) as JWTPayload;
}

function billingErrorResponse(c: any, error: unknown): Response {
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	if (error instanceof BillingStoreError) {
		const status = error.code === "billing_unknown_plan" || error.code === "billing_invalid_workspace" ? 400 : 500;
		return c.json({ error: error.message, code: error.code }, status);
	}
	throw error;
}

export const billing = createBillingRouter();
