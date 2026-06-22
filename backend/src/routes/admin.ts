// W2.6 — Platform admin routes.
//
// Everything under /api/admin requires the platform "admin" JWT role. The
// surface intentionally covers the four screens the admin dashboard ships:
//   * /workspaces      list + detail + grant credits + refund + impersonate
//   * /users           list + impersonate + force logout + force delete
//   * /audit           combined search of audit_events + admin_audit
//   * /cron            list jobs + force trigger
//
// Sensitive actions (impersonate, grant credits, refund, force delete) always
// land in admin_audit so an external review can reconstruct who did what.

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod/v4";
import { authMiddleware as defaultAuthMiddleware, requirePermission } from "../middleware/auth.middleware.js";
import type { JWTPayload, UserRole } from "../types/auth.js";
import { ADMIN_PERMISSIONS, ROLE_PERMISSIONS, hasPermission } from "../types/auth.js";
import { readJsonBody } from "../utils/request-body.js";
import { absCents } from "../utils/money.js";
import {
	loadUser,
} from "../services/auth.service.js";
import {
	creditService as defaultCreditService,
	type CreditService,
	CreditServiceError,
} from "../services/credits.js";
import {
	paymentTransactionsStore as defaultPaymentTxStore,
	type PaymentTransactionsStore,
} from "../services/payment-transactions-store.js";
import {
	dodoService as defaultDodoService,
	DodoBillingError,
	type DodoService,
} from "../services/dodo.service.js";
import {
	AdminSelfProtectionError,
	assertOwnerTargetMutationAllowed,
} from "../services/admin-protection.js";
import {
	billingStore as defaultBillingStore,
	type BillingStore,
	type WorkspaceBillingAssignment,
	type AdminWorkspaceAccountRow,
	DEFAULT_WORKSPACE_PLAN_ID,
} from "../services/billing-store.js";
import {
	workspaceAccessStore as defaultWorkspaceAccessStore,
	type WorkspaceAccessStore,
	type WorkspaceRecord,
} from "../services/workspace-access.js";
import { normalizeWorkspacePlanId } from "../services/plans.js";
import {
	gdprStore,
	type GdprStore,
} from "../services/gdpr.js";
import { DEFAULT_JOB_SCHEDULES } from "../services/cron-scheduler.js";
// Per-domain admin sub-routers (de-conflict scaffold). Each is mounted ONCE
// below; later domain workers edit only their own file so parallel back-office
// work never collides on this shared router.
import { createAdminRevenueRouter } from "./admin/revenue.js";
import { createAdminCouponsRouter } from "./admin/coupons.js";
import { createAdminSupportRouter } from "./admin/support.js";
import { createAdminUsersRouter } from "./admin/users.js";
import { createAdminContentRouter } from "./admin/content.js";

export interface AdminRouterDeps {
	gdpr?: GdprStore;
	billing?: BillingStore;
	workspaceAccess?: WorkspaceAccessStore | null;
	cron?: AdminCronAdapter;
	/**
	 * Real credit ledger + refund/payment deps. The inline /workspaces/:id/credits
	 * and /refund routes delegate to these (same services the support console uses)
	 * so a grant/refund triggered here ACTUALLY mints/moves value — they are no
	 * longer audit-only no-ops. DI seams so tests can inject fakes.
	 */
	creditService?: CreditService;
	dodoService?: DodoService;
	paymentTransactionsStore?: PaymentTransactionsStore;
	/**
	 * Override the auth middleware. Tests pass a stub that attaches a fixed
	 * user payload so they can exercise the `requireAdmin` gate without going
	 * through JWT generation. Production uses the default JWT middleware.
	 */
	authMiddleware?: MiddlewareHandler;
}

export interface AdminCronJob {
	id: string;
	name: string;
	schedule?: string;
	lastRunAt?: string | null;
	lastRunStatus?: "ok" | "failed" | "skipped" | null;
	nextRunAt?: string | null;
}

export interface AdminCronAdapter {
	list(): Promise<AdminCronJob[]>;
	trigger(jobId: string): Promise<{ ok: boolean; message?: string }>;
}

// Fallback cron adapter for the legacy /api/admin/cron view. The authoritative
// cron surface is /api/admin/cron via routes/admin-cron.ts (backed by the real
// CronScheduler); this adapter is only used when no `cron` dep is injected, so it
// returns a stable list mirroring the REAL registered jobs (DEFAULT_JOB_SCHEDULES)
// rather than the previous placeholder names. The old `gdpr-hard-delete @hourly`
// row was a dead stub — GDPR erasure now runs as the real `gdpr-erasure-sweep`
// daily job; this row is redirected to that job's true id + schedule.
const defaultCronAdapter: AdminCronAdapter = {
	async list() {
		return [
			{ id: "gdpr-erasure-sweep", name: "GDPR right-to-erasure sweep", schedule: DEFAULT_JOB_SCHEDULES["gdpr-erasure-sweep"], lastRunAt: null, lastRunStatus: null, nextRunAt: null },
			{ id: "draft-export-cleanup", name: "Expired draft export cleanup", schedule: DEFAULT_JOB_SCHEDULES["draft-export-cleanup"], lastRunAt: null, lastRunStatus: null, nextRunAt: null },
			{ id: "audit-retention-prune", name: "Workspace audit retention prune", schedule: DEFAULT_JOB_SCHEDULES["audit-retention-prune"], lastRunAt: null, lastRunStatus: null, nextRunAt: null },
		];
	},
	async trigger() {
		// Force-triggering a real job goes through /api/admin/cron (admin-cron.ts);
		// this legacy view is read-only, so a trigger here is a no-op.
		return { ok: true, message: "Use /api/admin/cron to trigger scheduled jobs." };
	},
};

// Build one admin workspaces row from a REGISTRY workspace, enriched with its
// billing assignment when one exists. The registry is authoritative for
// identity/name/timestamps; billing is a secondary overlay. When there is no
// assignment (file-mode/self-host, where billing may be empty), the row still
// surfaces the workspace with a sensible default plan ("free") and an explicit
// "unassigned" status — a missing assignment must never hide a real workspace.
function enrichWorkspaceRow(
	workspace: WorkspaceRecord,
	assignment: WorkspaceBillingAssignment | null,
): AdminWorkspaceAccountRow {
	const planId = assignment
		? assignment.planId
		: normalizeWorkspacePlanId(workspace.planId) ?? DEFAULT_WORKSPACE_PLAN_ID;
	return {
		workspaceId: workspace.workspaceId,
		name: workspace.name || workspace.workspaceId,
		planId,
		status: assignment ? assignment.status : "unassigned",
		billingEmail: assignment?.billingEmail ?? null,
		createdAt: workspace.createdAt,
		updatedAt: workspace.updatedAt,
	};
}

const listWorkspacesQuerySchema = z.object({
	search: z.string().trim().max(200).optional(),
	plan: z.string().trim().max(120).optional(),
	status: z.string().trim().max(120).optional(),
	cursor: z.string().trim().max(512).optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

// Credit grant — mints REAL shareable (workspace-owned) goodwill credits via the
// ledger. `amount` is the integer credit count. `idempotencyKey` is REQUIRED so a
// retried/double-submitted grant converges on ONE mint (never double-mints).
// (Back-compat: a caller may pass `aiCredits` as an alias for `amount`.)
const grantCreditsSchema = z.object({
	amount: z.number().int().min(1).max(1_000_000).optional(),
	aiCredits: z.number().int().min(1).max(1_000_000).optional(),
	reason: z.string().trim().min(1).max(2000),
	expiresAt: z.string().datetime().optional(),
	idempotencyKey: z.string().trim().min(1).max(200),
}).strict().refine((value) => (value.amount ?? value.aiCredits ?? 0) > 0, {
	message: "amount (credit count) must be > 0",
});

// Refund — moves REAL money out via dodo.service (negative payment_transactions
// row + provider refund when live). dodoChargeId + idempotencyKey are REQUIRED so
// the amount/currency are validated against the original charge and a retry never
// double-refunds.
const refundSchema = z.object({
	amountMinor: z.number().int().min(1),
	currency: z.string().trim().min(3).max(8),
	reason: z.string().trim().min(1).max(2000),
	dodoChargeId: z.string().trim().min(1).max(200),
	idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

const impersonateSchema = z.object({
	userId: z.string().trim().min(1).max(120),
	reason: z.string().trim().min(1).max(2000),
}).strict();

// Back-office workspace freeze/unfreeze. `suspend:false` is the escape hatch from a
// refund/chargeback freeze; `suspend:true` is a manual admin freeze.
const suspensionSchema = z.object({
	suspend: z.boolean(),
	reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

const stopImpersonateSchema = z.object({
	impersonationId: z.string().trim().min(1).max(120),
}).strict();

// Date bounds are bound straight into `created_at >= $n` / `<= $n` on a
// timestamptz column. If a malformed value (e.g. "2026-99-99" or free text) ever
// reached Postgres it would fail the timestamptz cast and 500 the route, so we
// validate STRICT UTC ISO datetimes here and reject anything else with 400 BEFORE
// the store is touched. The frontend already sends UTC instants
// (Date#toISOString()), so UTC-only ("…Z") is the correct, narrowest contract.
// We then normalize to the canonical `YYYY-MM-DDTHH:mm:ss.sssZ` form via
// Date#toISOString() so (a) the from<=to check below is a correct chronological
// comparison even across differing fractional-second precision, and (b) the value
// the store binds as `::timestamptz` is always one Postgres accepts.
const isoDateBound = z.iso
	.datetime({ message: "Expected a UTC ISO datetime (e.g. 2026-06-03T00:00:00.000Z)" })
	.transform((value) => new Date(value).toISOString());

// Shared audit-filter fields. Both the JSON and CSV routes filter identically;
// only the page-size cap differs, so that is layered on per-route below.
const auditFilterBase = {
	action: z.string().trim().max(120).optional(),
	adminUserId: z.string().trim().max(120).optional(),
	actorRole: z.string().trim().max(120).optional(),
	targetKind: z.string().trim().max(120).optional(),
	targetId: z.string().trim().max(120).optional(),
	fromDate: isoDateBound.optional(),
	toDate: isoDateBound.optional(),
	offset: z.number().int().min(0).optional(),
};

// Reject an inverted range (from after to) with 400 rather than silently
// returning zero rows — an inverted bound is an operator mistake, not a query.
const rejectInvertedRange = (value: { fromDate?: string; toDate?: string }) =>
	!(value.fromDate && value.toDate && value.fromDate > value.toDate);
const invertedRangeIssue = {
	message: "fromDate must be earlier than or equal to toDate",
	path: ["fromDate"] as string[],
};

const auditQuerySchema = z
	.object({ ...auditFilterBase, limit: z.number().int().min(1).max(500).optional() })
	.refine(rejectInvertedRange, invertedRangeIssue);

// CSV exports are intentionally larger — a single batch covers a typical day's
// admin activity. The cap protects against accidental "download everything" but
// is high enough to be useful for forensic review.
const auditCsvQuerySchema = z
	.object({ ...auditFilterBase, limit: z.number().int().min(1).max(5000).optional() })
	.refine(rejectInvertedRange, invertedRangeIssue);

// Declarative nav registry — the SINGLE source of truth for which back-office
// sections each role can see. GET /api/admin/me filters this by the caller's
// permission set; the frontend renders nav purely from that response, so there
// is no backend/frontend permission drift. `requires` is the permission a role
// must hold for the section to appear (and matches the per-route gating below).
export interface AdminNavSection {
	id: string;
	href: string;
	label: string;
	requires: string;
}

export const ADMIN_NAV_SECTIONS: readonly AdminNavSection[] = [
	{ id: "workspaces", href: "/admin/workspaces", label: "Workspaces", requires: ADMIN_PERMISSIONS.ACCESS },
	{ id: "users", href: "/admin/users", label: "Users", requires: ADMIN_PERMISSIONS.USERS_READ },
	{ id: "revenue", href: "/admin/revenue", label: "Revenue", requires: ADMIN_PERMISSIONS.REVENUE_READ },
	{ id: "coupons", href: "/admin/coupons", label: "Coupons", requires: ADMIN_PERMISSIONS.COUPONS_READ },
	{ id: "content", href: "/admin/content", label: "Content", requires: ADMIN_PERMISSIONS.CONTENT_READ },
	{ id: "support", href: "/admin/support", label: "Support", requires: ADMIN_PERMISSIONS.SUPPORT_READ },
	// Owner-ops inbox: the OWNER-ONLY queue of AI-escalated money/account cases the
	// support bot routed for a human decision. Gated to ROLES_WRITE — held only by
	// the owner — so it appears for the owner alone (matching the owner-only routes
	// in routes/admin/support.ts registerOwnerDecisionRoutes).
	{ id: "owner-inbox", href: "/admin/owner-inbox", label: "Owner Inbox", requires: ADMIN_PERMISSIONS.ROLES_WRITE },
	{ id: "audit", href: "/admin/audit", label: "Audit", requires: ADMIN_PERMISSIONS.AUDIT_READ },
	{ id: "cron", href: "/admin/cron", label: "Cron", requires: ADMIN_PERMISSIONS.CRON_WRITE },
];

// Fine-grained gate that admits a request when the user holds ANY of the given
// permissions. The workspace list/detail is customer-360 data (billing plan/status
// + active credit grants) that BOTH support (customer lookups) and accountant
// (revenue/billing) legitimately need, so a single requirePermission(...) would lock
// one of them out. This layers a meaningful permission on top of the baseline
// admin:access gate so a hypothetical access-only role cannot enumerate every
// workspace + its active grants, while keeping the two roles that should see it.
function requireAnyPermission(...permissions: string[]): MiddlewareHandler {
	return async (c, next) => {
		const user = c.get("user") as JWTPayload | undefined;
		if (!user) return c.json({ error: "Unauthorized: No user found" }, 401);
		if (!permissions.some((permission) => hasPermission(user.role, permission))) {
			return c.json({ error: `Forbidden: requires one of ${permissions.join(", ")}` }, 403);
		}
		await next();
	};
}

export function createAdminRouter(deps: AdminRouterDeps = {}): Hono {
	const router = new Hono();
	const gdpr = deps.gdpr ?? gdprStore;
	const billing = deps.billing ?? defaultBillingStore;
	const workspaceAccess = deps.workspaceAccess !== undefined ? deps.workspaceAccess : defaultWorkspaceAccessStore;
	const cron = deps.cron ?? defaultCronAdapter;
	const creditSvc = deps.creditService ?? defaultCreditService;
	const dodo = deps.dodoService ?? defaultDodoService;
	const paymentTxStore = deps.paymentTransactionsStore ?? defaultPaymentTxStore;
	const authMiddleware = deps.authMiddleware ?? defaultAuthMiddleware;

	router.use("*", authMiddleware);
	// Baseline gate: every back-office route requires admin:access. Individual
	// mutations layer a more specific requirePermission(...) on top so each role
	// (owner/admin/support/accountant) sees exactly what it is allowed to do —
	// the backend is authoritative; UI gating is defense-in-depth.
	router.use("*", requirePermission(ADMIN_PERMISSIONS.ACCESS));

	// ── /me — role + permissions + visible nav sections ───────────
	// Computed from the SINGLE backend ROLE_PERMISSIONS map so the admin shell's
	// nav/gate never drifts from the server's real authorization.
	router.get("/me", async (c) => {
		const user = requireAdminUser(c);
		const permissions = ROLE_PERMISSIONS[user.role] ?? [];
		const sections = ADMIN_NAV_SECTIONS
			.filter((section) => permissions.includes(section.requires))
			.map(({ id, href, label, requires }) => ({ id, href, label, requires }));
		return c.json({
			role: user.role as UserRole,
			permissions,
			sections,
		});
	});

	// ── Workspaces ────────────────────────────────────────────────
	// Gated above admin:access: workspace enumeration + active grants is customer-360
	// data that support (lookups) and accountant (revenue/billing) both need, so admit
	// either SUPPORT_READ or REVENUE_READ rather than the baseline access grant alone.
	const requireWorkspaceVisibility = requireAnyPermission(
		ADMIN_PERMISSIONS.SUPPORT_READ,
		ADMIN_PERMISSIONS.REVENUE_READ,
	);
	router.get("/workspaces", requireWorkspaceVisibility, async (c) => {
		const parsed = listWorkspacesQuerySchema.safeParse({
			search: c.req.query("search"),
			plan: c.req.query("plan"),
			status: c.req.query("status"),
			cursor: c.req.query("cursor"),
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		// SOURCE OF TRUTH = the workspace REGISTRY, not the billing store. Billing
		// assignments are a SEPARATE (and in file-mode/self-host often EMPTY) source,
		// so driving the list from billing showed 0 workspaces even when real ones
		// exist. We page the registry (one filter-pushing, keyset query — no per-row
		// N+1), then enrich the bounded page with billing plan/status as a SECONDARY
		// lookup. A missing assignment never hides a real workspace: it shows with the
		// default plan + "unassigned" status.
		//
		// When no access store is wired (degraded deployments / some tests), fall back
		// to the legacy billing-driven list so the route still answers.
		if (!workspaceAccess || typeof workspaceAccess.listAllWorkspacePage !== "function") {
			const legacy = await billing.listWorkspaceAccounts({
				search: parsed.data.search,
				plan: parsed.data.plan,
				status: parsed.data.status,
				cursor: parsed.data.cursor,
				limit: parsed.data.limit,
			});
			return c.json({ workspaces: legacy.workspaces, total: legacy.total, nextCursor: legacy.nextCursor ?? null });
		}

		const page = await workspaceAccess.listAllWorkspacePage({
			search: parsed.data.search,
			cursor: parsed.data.cursor,
			limit: parsed.data.limit,
		});

		// Enrich the bounded page (≤ limit rows, never the whole table) with billing.
		// File-mode billing is tiny; Postgres getWorkspaceAssignment is a PK lookup —
		// so this is at most `limit` lookups per page, NOT an N+1 over the registry.
		const enriched: AdminWorkspaceAccountRow[] = await Promise.all(
			page.workspaces.map(async (workspace) => {
				const assignment = await billing
					.getWorkspaceAssignment(workspace.workspaceId)
					.catch(() => null);
				return enrichWorkspaceRow(workspace, assignment);
			}),
		);

		// plan/status are billing attributes, so they filter the ENRICHED page. This
		// is a best-effort filter over the current page (the registry can't push a
		// billing predicate); the admin UI's primary use is the unfiltered/searched
		// list, which now correctly reflects the registry in both modes.
		const planFilter = parsed.data.plan?.trim();
		const statusFilter = parsed.data.status?.trim();
		const workspaces = enriched.filter((row) => {
			if (planFilter && row.planId !== planFilter) return false;
			if (statusFilter && row.status !== statusFilter) return false;
			return true;
		});

		return c.json({
			workspaces,
			// Honest total: the count of ALL workspaces matching the same `search`
			// filter (one bounded COUNT(*) in Postgres, filtered-array length in file
			// mode), NOT the page length. The admin header reports this so paging never
			// makes the count shrink. `nextCursor` drives "Load more".
			total: page.total,
			nextCursor: page.nextCursor ?? null,
		});
	});

	// Allow-list serializer for the workspace billing assignment. NEVER echo the raw
	// provider `metadata` jsonb (free-form — a future Dodo webhook field would leak
	// automatically) or customer PII to a REVENUE_READ-only accountant. Plan/period
	// fields go to anyone with workspace visibility; billingEmail + provider
	// correlation ids + dunning grace are added ONLY for SUPPORT_READ holders.
	function serializeAdminBillingAssignment(
		assignment: {
			workspaceId: string; planId: string; status: string; billingEmail?: string;
			currentPeriodStart?: string; currentPeriodEnd?: string; createdAt: string; updatedAt: string;
			metadata?: Record<string, unknown>;
		} | null,
		includeSensitive: boolean,
	): Record<string, unknown> | null {
		if (!assignment) return null;
		const base: Record<string, unknown> = {
			workspaceId: assignment.workspaceId,
			planId: assignment.planId,
			status: assignment.status,
			currentPeriodStart: assignment.currentPeriodStart ?? null,
			currentPeriodEnd: assignment.currentPeriodEnd ?? null,
			createdAt: assignment.createdAt,
			updatedAt: assignment.updatedAt,
		};
		if (!includeSensitive) return base;
		const meta = assignment.metadata ?? {};
		const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
		return {
			...base,
			billingEmail: assignment.billingEmail ?? null,
			dunningGraceUntil: str(meta.dunning_grace_until),
			providerCustomerId: str(meta.dodo_customer_id),
			providerSubscriptionId: str(meta.dodo_subscription_id),
		};
	}

	router.get("/workspaces/:workspaceId", requireWorkspaceVisibility, async (c) => {
		const workspaceId = c.req.param("workspaceId");
		const [workspace, assignment, grants] = await Promise.all([
			workspaceAccess ? workspaceAccess.getWorkspace(workspaceId).catch(() => null) : null,
			billing.getWorkspaceAssignment(workspaceId),
			billing.listActiveGrants(workspaceId),
		]);
		if (!workspace && !assignment) {
			return c.json({ error: "Workspace not found", code: "workspace_not_found" }, 404);
		}
		const actor = c.get("user") as JWTPayload | undefined;
		const includeSensitive = actor ? hasPermission(actor.role, ADMIN_PERMISSIONS.SUPPORT_READ) : false;
		return c.json({
			workspace,
			billing: serializeAdminBillingAssignment(assignment, includeSensitive),
			grants,
		});
	});

	// REAL goodwill credit grant. Delegates to the SAME credit ledger the support
	// console uses, so a grant here ACTUALLY mints credits (not an audit-only
	// no-op). Idempotent on idempotencyKey → a retry/double-submit never
	// double-mints. The grant + an audit row are written; the audit reflects a REAL
	// ledger change (the grant id), so the operator's success state is honest.
	router.post("/workspaces/:workspaceId/credits", requirePermission(ADMIN_PERMISSIONS.SUPPORT_ADJUST), async (c) => {
		const admin = requireAdminUser(c);
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = grantCreditsSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const workspaceId = c.req.param("workspaceId") ?? "";
		const amount = parsed.data.amount ?? parsed.data.aiCredits ?? 0;
		try {
			const grant = await creditSvc.grantCredits({
				workspaceId,
				ownerScope: "workspace",
				ownerId: workspaceId,
				creditClass: "shareable",
				amount,
				source: "goodwill",
				expiresAt: parsed.data.expiresAt,
				idempotencyKey: parsed.data.idempotencyKey,
			});
			const entry = await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				actorRole: admin.role,
				action: "admin.workspace.credit_grant",
				targetKind: "workspace",
				targetId: workspaceId,
				detail: {
					grantId: grant.id,
					amount: grant.amount,
					creditClass: grant.creditClass,
					reason: parsed.data.reason,
					expiresAt: grant.expiresAt ?? null,
					idempotencyKey: parsed.data.idempotencyKey,
				},
			});
			return c.json({ ok: true, grant, audit: entry });
		} catch (error) {
			if (error instanceof CreditServiceError) {
				return c.json({ error: error.message, code: error.code }, error.status as 400);
			}
			throw error;
		}
	});

	// Back-office UNFREEZE (escape hatch). A workspace frozen by a verified
	// refund/chargeback can ALSO be unfrozen here by an admin — so a freeze is never a
	// permanent lockout when there is a legitimate reason to restore access (e.g. the
	// dispute was resolved off-platform). Gated on SUPPORT_ADJUST (account-state
	// mutation) and audited. `suspend:true` is also allowed so an admin can manually
	// freeze a workspace. NEVER reachable by a normal workspace member — this is the
	// platform-admin surface only.
	router.post("/workspaces/:workspaceId/suspension", requirePermission(ADMIN_PERMISSIONS.SUPPORT_ADJUST), async (c) => {
		const admin = requireAdminUser(c);
		if (!workspaceAccess) return c.json({ error: "Workspace access store unavailable", code: "workspace_access_unavailable" }, 503);
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = suspensionSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const workspaceId = c.req.param("workspaceId") ?? "";
		try {
			const workspace = await workspaceAccess.setWorkspaceSuspension({
				workspaceId,
				suspend: parsed.data.suspend,
				reason: parsed.data.suspend ? (parsed.data.reason ?? "admin") : undefined,
				actorUserId: admin.userId,
			});
			const entry = await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				actorRole: admin.role,
				action: parsed.data.suspend ? "admin.workspace.suspend" : "admin.workspace.unsuspend",
				targetKind: "workspace",
				targetId: workspaceId,
				detail: { suspend: parsed.data.suspend, reason: parsed.data.reason ?? null },
			});
			return c.json({ ok: true, workspace, audit: entry });
		} catch (error) {
			if (error && typeof error === "object" && "status" in error && "code" in error) {
				const e = error as { message: string; status: number; code: string };
				return c.json({ error: e.message, code: e.code }, e.status as 400);
			}
			throw error;
		}
	});

	// REAL refund (money OUT). Delegates to dodo.service.recordSupportRefund: writes
	// a NEGATIVE payment_transactions row (per-currency integer cents) and fires the
	// provider refund when Dodo is live. Idempotent on idempotencyKey + validated
	// against the original charge, so a retry never double-refunds and an operator
	// can't over-refund. No longer an audit-only "refund_requested" no-op.
	router.post("/workspaces/:workspaceId/refund", requirePermission(ADMIN_PERMISSIONS.REFUND_WRITE), async (c) => {
		const admin = requireAdminUser(c);
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = refundSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const workspaceId = c.req.param("workspaceId") ?? "";
		try {
			const { transaction, providerRefundId } = await dodo.recordSupportRefund({
				workspaceId,
				amountCents: absCents(parsed.data.amountMinor),
				currency: parsed.data.currency,
				reason: parsed.data.reason,
				initiatedBy: admin.userId,
				idempotencyKey: parsed.data.idempotencyKey,
				dodoChargeId: parsed.data.dodoChargeId,
				paymentTransactionsStore: paymentTxStore,
			});
			const entry = await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				actorRole: admin.role,
				action: "admin.workspace.refund",
				targetKind: "workspace",
				targetId: workspaceId,
				detail: {
					transactionId: transaction.id,
					amountCents: transaction.amountCents,
					currency: transaction.currency,
					reason: parsed.data.reason,
					dodoChargeId: parsed.data.dodoChargeId,
					providerRefundId,
					idempotencyKey: parsed.data.idempotencyKey,
				},
			});
			return c.json({ ok: true, refund: transaction, providerRefundId, audit: entry });
		} catch (error) {
			if (error instanceof DodoBillingError) {
				return c.json({ error: error.message, code: error.code }, error.status as 400);
			}
			throw error;
		}
	});

	router.post("/workspaces/:workspaceId/impersonate", requirePermission(ADMIN_PERMISSIONS.IMPERSONATE), async (c) => {
		const admin = requireAdminUser(c);
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = impersonateSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const target = await loadUser(parsed.data.userId);
		if (!target) return c.json({ error: "User not found", code: "user_not_found" }, 404);
		try {
			assertOwnerTargetMutationAllowed({
				actorRole: admin.role,
				targetCurrentRole: target.role,
				isDestructive: false,
			});
		} catch (error) {
			if (error instanceof AdminSelfProtectionError) {
				return c.json({ error: error.message, reason: error.reason }, error.status);
			}
			throw error;
		}
		const event = await gdpr.startImpersonation(admin.userId, target.id, parsed.data.reason);
		await gdpr.recordAdminAudit({
			adminUserId: admin.userId,
			action: "admin.impersonation.start",
			targetKind: "user",
			targetId: target.id,
			detail: {
				workspaceId: c.req.param("workspaceId"),
				reason: parsed.data.reason,
				impersonationId: event.id,
			},
		});
		// Token minting belongs to a future endpoint that swaps the admin's JWT
		// for a scoped impersonation JWT. For now we return the event id so the
		// dashboard can render the active session row + Stop button.
		return c.json({ ok: true, event });
	});

	router.post("/impersonate/stop", requirePermission(ADMIN_PERMISSIONS.IMPERSONATE), async (c) => {
		const admin = requireAdminUser(c);
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = stopImpersonateSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const event = await gdpr.endImpersonation(parsed.data.impersonationId);
		if (!event) return c.json({ error: "Impersonation event not found", code: "not_found" }, 404);
		await gdpr.recordAdminAudit({
			adminUserId: admin.userId,
			action: "admin.impersonation.end",
			targetKind: "user",
			targetId: event.impersonatedUserId,
			detail: { impersonationId: event.id },
		});
		return c.json({ ok: true, event });
	});

	// ── Users ─────────────────────────────────────────────────────
	// The user LIST + DETAIL + role/enable/disable AND force-logout / force-delete
	// all live on the SINGLE real users surface: the /users-mgmt sub-router (mounted
	// below). The previously-duplicated inline /users list + /users/:id/force-logout
	// + DELETE /users/:id routes were removed so there is exactly one path the UI
	// calls (no shadowing surface that could drift from the live one).

	// ── Audit ─────────────────────────────────────────────────────
	router.get("/audit", requirePermission(ADMIN_PERMISSIONS.AUDIT_READ), async (c) => {
		const parsed = auditQuerySchema.safeParse({
			action: c.req.query("action"),
			adminUserId: c.req.query("adminUserId"),
			actorRole: c.req.query("actorRole"),
			targetKind: c.req.query("targetKind"),
			targetId: c.req.query("targetId"),
			fromDate: c.req.query("fromDate"),
			toDate: c.req.query("toDate"),
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
			offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const result = await gdpr.listAdminAudit(parsed.data);
		return c.json(result);
	});

	router.get("/audit.csv", requirePermission(ADMIN_PERMISSIONS.AUDIT_READ), async (c) => {
		const parsed = auditCsvQuerySchema.safeParse({
			action: c.req.query("action"),
			adminUserId: c.req.query("adminUserId"),
			actorRole: c.req.query("actorRole"),
			targetKind: c.req.query("targetKind"),
			targetId: c.req.query("targetId"),
			fromDate: c.req.query("fromDate"),
			toDate: c.req.query("toDate"),
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : 1000,
			offset: c.req.query("offset") ? Number(c.req.query("offset")) : 0,
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const { entries } = await gdpr.listAdminAudit({ ...parsed.data, limit: parsed.data.limit ?? 1000 });
		const csv = renderAuditCsv(entries);
		return new Response(csv, {
			status: 200,
			headers: {
				"Content-Type": "text/csv",
				"Content-Disposition": `attachment; filename="admin-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
				"Cache-Control": "no-store",
			},
		});
	});

	// ── Cron ──────────────────────────────────────────────────────
	router.get("/cron", requirePermission(ADMIN_PERMISSIONS.CRON_WRITE), async (c) => {
		const jobs = await cron.list();
		return c.json({ jobs });
	});

	router.post("/cron/:jobId/trigger", requirePermission(ADMIN_PERMISSIONS.CRON_WRITE), async (c) => {
		const admin = requireAdminUser(c);
		const jobId = c.req.param("jobId") ?? "";
		const result = await cron.trigger(jobId);
		await gdpr.recordAdminAudit({
			adminUserId: admin.userId,
			action: "admin.cron.trigger",
			targetKind: "cron_job",
			targetId: jobId,
			detail: result,
		});
		return c.json(result);
	});

	// ── Per-domain sub-routers (de-conflict scaffold) ─────────────
	// Mounted ONCE here so each later domain worker edits only its own file in
	// routes/admin/*. They inherit the baseline authMiddleware +
	// requirePermission(ACCESS) gates above and add their own READ gate on top.
	// `/users-mgmt` is used (not `/users`) to avoid clashing with the existing
	// inline /users routes above. The full `deps` object is threaded through so
	// sub-routers share the same DI as this factory.
	router.route("/revenue", createAdminRevenueRouter(deps));
	router.route("/coupons", createAdminCouponsRouter(deps));
	router.route("/support", createAdminSupportRouter(deps));
	router.route("/users-mgmt", createAdminUsersRouter(deps));
	router.route("/content", createAdminContentRouter(deps));

	return router;
}

function requireAdminUser(c: { get: (key: "user") => JWTPayload | undefined }): JWTPayload {
	const user = c.get("user");
	if (!user) throw new Error("auth_required");
	return user;
}

function renderAuditCsv(entries: Array<{ id: string; createdAt: string; adminUserId: string; action: string; targetKind: string | null; targetId: string | null; detail: Record<string, unknown> }>): string {
	const header = ["id", "createdAt", "adminUserId", "action", "targetKind", "targetId", "detail"];
	const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
	const rows = entries.map((entry) => [
		entry.id,
		entry.createdAt,
		entry.adminUserId,
		entry.action,
		entry.targetKind ?? "",
		entry.targetId ?? "",
		JSON.stringify(entry.detail ?? {}),
	].map(escape).join(","));
	return [header.map(escape).join(","), ...rows].join("\n");
}

export const admin = createAdminRouter();
