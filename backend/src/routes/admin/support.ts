// Back-office SUPPORT sub-router (ranks 12-14).
//
// Mounted at /api/admin/support by backend/src/routes/admin.ts. The parent admin
// router already applies authMiddleware + requirePermission(ACCESS) on every path,
// so requests that reach here are authenticated platform admins.
//
// Authorization model:
//   * Baseline gate: SUPPORT_READ — every route requires it. Customer-360 lookup is
//     READ-ONLY and allowed for any role holding admin:support.read (owner/admin/support).
//   * Goodwill credit grant + plan change layer requirePermission(SUPPORT_ADJUST) on
//     top, so support CAN do them (it holds SUPPORT_ADJUST) but accountant CANNOT.
//   * Refund (money OUT) layers requirePermission(REFUND_WRITE), which support does
//     NOT hold — only owner/admin issue refunds, matching the role policy in types/auth.ts.
//
// These replace the audit-only no-ops on the inline admin.ts /workspaces/:id/credits
// and /refund routes with REAL service calls (credits.ts grant, billing-store plan
// change, dodo.service support refund). Every mutation is AUDITED via
// gdpr.recordAdminAudit (with actorRole passed EXPLICITLY, never best-effort) and is
// idempotent so a retried request never double-applies:
//   * credit grant — idempotencyKey is REQUIRED; credits.ts dedupes on it so a
//                     double-submit converges on one grant (no double-mint).
//   * refund       — replay-safe at the PROVIDER too: dodo.service checks the ledger
//                     dedupe ref BEFORE any provider refund, so a retry never issues a
//                     second Dodo refund; it also validates the amount/currency against
//                     the original charge so an operator can't over-refund.
//   * plan change  — naturally convergent (setting the same plan twice is a no-op).
//
// Money paths use INTEGER CENTS, per-currency, no float (utils/money.ts) and reuse the
// #162 money model: a refund writes a NEGATIVE payment_transactions row so net revenue nets.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod/v4";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { ADMIN_PERMISSIONS } from "../../types/auth.js";
import type { JWTPayload } from "../../types/auth.js";
import { readJsonBody } from "../../utils/request-body.js";
import { absCents } from "../../utils/money.js";
import { findUserByEmail, loadUser } from "../../services/auth.service.js";
import {
	creditService as defaultCreditService,
	CreditService,
	CreditServiceError,
} from "../../services/credits.js";
import {
	billingStore as defaultBillingStore,
	BillingStoreError,
	type BillingStore,
} from "../../services/billing-store.js";
import { isWorkspacePlanId } from "../../services/plans.js";
import {
	workspaceAccessStore as defaultWorkspaceAccessStore,
	type WorkspaceAccessStore,
} from "../../services/workspace-access.js";
import {
	paymentTransactionsStore as defaultPaymentTxStore,
	type PaymentTransactionsStore,
} from "../../services/payment-transactions-store.js";
import {
	supportTicketStore as defaultTicketStore,
	type SupportTicketStore,
} from "../../services/support-tickets.js";
import {
	dodoService as defaultDodoService,
	DodoBillingError,
	type DodoService,
} from "../../services/dodo.service.js";
import { gdprStore as defaultGdprStore, type GdprStore } from "../../services/gdpr.js";
import {
	AdminSelfProtectionError,
	assertOwnerTargetMutationAllowed,
} from "../../services/admin-protection.js";
import {
	ownerDecisionStore as defaultOwnerDecisionStore,
	type OwnerDecisionStore,
	type SupportDecisionRecord,
} from "../../services/support/owner-decisions-store.js";
import {
	executeApprovedGrant,
	executeClawback,
	ClawbackError,
	buildOwnerOpsDigest,
	parseDigestDate,
} from "../../services/support/owner-ops.js";
import type { AdminRouterDeps } from "../admin.js";

// ── Validation schemas ────────────────────────────────────────────

const lookupQuerySchema = z.object({
	query: z.string().trim().min(1).max(320),
});

// Goodwill credit grant. Bounded: at most 1,000,000 credits per call (matches the
// inline admin grant cap).
//
// IDEMPOTENCY (money-equivalent, P1): a credit grant MINTS value, so a retried request
// that omits a dedupe key would double-grant. We therefore REQUIRE a client-supplied
// idempotencyKey (the simplest robust replay-safe choice): credits.ts dedupes on it, so
// a double-submit of the SAME logical grant converges on one grant, while two DISTINCT
// intentional grants simply carry distinct keys. A request without one is rejected (400)
// rather than silently risking a double-grant.
const grantCreditsSchema = z.object({
	amount: z.number().int().min(1).max(1_000_000),
	creditClass: z.enum(["shareable", "personal"]).optional(),
	// Required when creditClass is "personal": personal credits are owned by a user.
	userId: z.string().trim().min(1).max(300).optional(),
	reason: z.string().trim().min(1).max(2000),
	expiresAt: z.string().datetime().optional(),
	// Required so a retried grant is ALWAYS replay-safe (never double-mints).
	idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

const planChangeSchema = z.object({
	planId: z.string().trim().min(1).max(120),
	status: z.enum(["mock_active", "trialing", "active", "past_due", "cancelled"]).optional(),
	reason: z.string().trim().min(1).max(2000),
}).strict();

const refundSchema = z.object({
	amountMinor: z.number().int().min(1),
	currency: z.string().trim().min(3).max(8),
	reason: z.string().trim().min(1).max(2000),
	// REQUIRED (money-out safety, P1): the original charge id. The amount + currency are
	// validated against the recorded payment for this charge (and its cumulative refunds)
	// so an operator can never refund more than was paid, in the wrong currency, or
	// against a charge that was never recorded — even under BILLING_PROVIDER=none.
	dodoChargeId: z.string().trim().min(1).max(200),
	// Idempotency key — the refund row's dedupe ref. A retry with the same key never
	// doubles the money out. Required so a money-out action is always replay-safe.
	idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

function requireAdminUser(c: Context): JWTPayload {
	const user = c.get("user") as JWTPayload | undefined;
	if (!user) throw new Error("auth_required");
	return user;
}

export interface AdminSupportRouterDeps extends AdminRouterDeps {
	creditService?: CreditService;
	paymentTransactionsStore?: PaymentTransactionsStore;
	ticketStore?: SupportTicketStore;
	dodoService?: DodoService;
	/** Owner-ops decision store (the owner-review queue). DI seam for tests. */
	ownerDecisionStore?: OwnerDecisionStore;
}

export function createAdminSupportRouter(deps: AdminSupportRouterDeps = {}): Hono {
	const router = new Hono();
	const creditSvc = deps.creditService ?? defaultCreditService;
	const billing: BillingStore = deps.billing ?? defaultBillingStore;
	const workspaceAccess: WorkspaceAccessStore | null =
		deps.workspaceAccess !== undefined ? deps.workspaceAccess : defaultWorkspaceAccessStore;
	const paymentTxStore = deps.paymentTransactionsStore ?? defaultPaymentTxStore;
	const ticketStore = deps.ticketStore ?? defaultTicketStore;
	const dodo = deps.dodoService ?? defaultDodoService;
	const gdpr: GdprStore = deps.gdpr ?? defaultGdprStore;
	const decisionStore = deps.ownerDecisionStore ?? defaultOwnerDecisionStore;

	// Baseline READ gate for the whole support surface. Mutations layer the
	// appropriate write permission (SUPPORT_ADJUST / REFUND_WRITE / owner) on top.
	router.use("*", requirePermission(ADMIN_PERMISSIONS.SUPPORT_READ));

	// ── OWNER-OPS owner-decision queue (OWNER-ONLY) ──────────────────────────────
	// "Talk to the bot" backend: the owner reviews the pending money/account cases
	// the deterministic gate routed to them and makes a ONE-TAP decision. Gated to
	// the OWNER via admin:roles.write — the STRONGEST existing permission, held ONLY
	// by the owner role (support/admin/accountant/editor all lack it → 403). Every
	// decision is bounded/idempotent/audited as actor="owner".
	registerOwnerDecisionRoutes(router, { creditSvc, decisionStore, gdpr });

	// ── Customer 360 lookup (READ-ONLY) ──────────────────────────────
	// Resolve a user (by email or id) OR a workspace (by id) and return a cross-entity
	// snapshot: profile, plan, credit balance, recent payments, open tickets. Scoped to
	// the admin's god-view (the SUPPORT_READ gate is the sole authorization).
	router.get("/lookup", async (c) => {
		const parsed = lookupQuerySchema.safeParse({ query: c.req.query("query") });
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const query = parsed.data.query;

		// 1) Resolve a USER by email (when it looks like an email) then by id.
		let user = query.includes("@") ? await findUserByEmail(query) : null;
		if (!user) user = await loadUser(query).catch(() => null);

		// 2) Resolve a WORKSPACE: the user's workspaces (newest first) when a user
		//    matched, else treat the query itself as a workspace id.
		let workspaceId: string | null = null;
		let workspaceName: string | null = null;
		if (user && workspaceAccess) {
			const workspaces = await workspaceAccess.listUserWorkspaces(user.id).catch(() => []);
			const primary = workspaces[0];
			if (primary) {
				workspaceId = primary.workspaceId;
				workspaceName = primary.name ?? null;
			}
		}
		if (!workspaceId) {
			// No user→workspace mapping; the query may itself be a workspace id.
			const candidate = query;
			const assignment = await billing.getWorkspaceAssignment(candidate).catch(() => null);
			const ws = workspaceAccess ? await workspaceAccess.getWorkspace(candidate).catch(() => null) : null;
			if (assignment || ws) {
				workspaceId = candidate;
				workspaceName = ws?.name ?? null;
			}
		}

		if (!user && !workspaceId) {
			return c.json({ error: "No matching customer (user or workspace) found", code: "customer_not_found" }, 404);
		}

		// Billing assignment + resolved (default-fallback) plan for the workspace.
		const [assignment, resolvedPlan] = workspaceId
			? await Promise.all([
				billing.getWorkspaceAssignment(workspaceId).catch(() => null),
				billing.resolveWorkspacePlan(workspaceId).catch(() => null),
			])
			: [null, null];

		// Credit balance: workspace-scoped when we have a workspace, else the user's
		// cross-workspace personal balance.
		const balance = workspaceId
			? creditSvc.getBalance("workspace", workspaceId)
			: user
				? creditSvc.getBalance("user", user.id)
				: { shareable: 0, personal: 0, total: 0 };

		// Recent payments (newest first) for the workspace — money model #162 rows.
		const recentPayments = workspaceId
			? (await paymentTxStore.listTransactions({ workspaceId, limit: 10 })).transactions.map((tx) => ({
				id: tx.id,
				kind: tx.kind,
				amountCents: tx.amountCents,
				currency: tx.currency,
				status: tx.status,
				planId: tx.planId,
				occurredAt: tx.occurredAt,
			}))
			: [];

		// Open tickets for the resolved user (cheap: a single bounded list query).
		const openTickets = user
			? (await ticketStore.listTickets({ requesterUserId: user.id, status: ["open", "pending", "escalated"], limit: 10 }))
				.items.map((t) => ({ id: t.id, subject: t.subject, status: t.status, category: t.category, updatedAt: t.updatedAt }))
			: [];

		return c.json({
			query,
			user: user
				? { id: user.id, email: user.email, name: user.name, role: user.role, isActive: user.isActive, createdAt: user.createdAt }
				: null,
			workspace: workspaceId ? { id: workspaceId, name: workspaceName } : null,
			plan: resolvedPlan
				? { planId: resolvedPlan.planId, status: assignment?.status ?? resolvedPlan.status ?? null, assigned: resolvedPlan.assigned }
				: null,
			creditBalance: { shareable: balance.shareable, personal: balance.personal, total: balance.total },
			recentPayments,
			openTickets,
		});
	});

	// ── REAL goodwill credit grant (SUPPORT_ADJUST) ──────────────────
	// Replaces the audit-only no-op: mints credits via credits.ts, idempotent on the
	// grant key, bounded, and AUDITED. Personal credits require a userId owner; the
	// default class is shareable (workspace-owned).
	router.post("/workspaces/:workspaceId/credits", requirePermission(ADMIN_PERMISSIONS.SUPPORT_ADJUST), async (c) => {
		const admin = requireAdminUser(c);
		const workspaceId = c.req.param("workspaceId") ?? "";
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = grantCreditsSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		const { amount, reason, expiresAt } = parsed.data;
		const creditClass = parsed.data.creditClass ?? "shareable";
		// Personal credits are owned by a user; shareable are owned by the workspace.
		const ownerScope = creditClass === "personal" ? "user" : "workspace";
		const ownerId = creditClass === "personal" ? (parsed.data.userId ?? "") : workspaceId;
		if (creditClass === "personal" && !ownerId) {
			return c.json({ error: "userId is required when granting personal credits", code: "personal_requires_user" }, 400);
		}
		if (creditClass === "personal") {
			const target = await loadUser(ownerId);
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
		}

		try {
			const grant = await creditSvc.grantCredits({
				workspaceId,
				ownerScope,
				ownerId,
				creditClass,
				amount,
				source: "goodwill",
				expiresAt,
				// Idempotency: a retried grant with the same key returns the existing grant
				// (credits.ts dedupes on this) instead of minting a second one.
				idempotencyKey: parsed.data.idempotencyKey,
			});
			await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				// Pass the role explicitly (don't rely on best-effort store resolution).
				actorRole: admin.role,
				action: "admin.support.credit_grant",
				targetKind: "workspace",
				targetId: workspaceId,
				detail: {
					grantId: grant.id,
					amount: grant.amount,
					creditClass: grant.creditClass,
					ownerScope: grant.ownerScope,
					ownerId: grant.ownerId,
					reason,
					expiresAt: grant.expiresAt ?? null,
					idempotencyKey: parsed.data.idempotencyKey ?? null,
				},
			});
			return c.json({ ok: true, grant });
		} catch (error) {
			if (error instanceof CreditServiceError) {
				return c.json({ error: error.message, code: error.code }, error.status as 400);
			}
			throw error;
		}
	});

	// ── REAL plan change (SUPPORT_ADJUST) ────────────────────────────
	// Replaces the audit-only no-op: persists the plan via billing-store, AUDITED.
	// Idempotent by nature — re-applying the same plan converges on the same state.
	router.post("/workspaces/:workspaceId/plan-change", requirePermission(ADMIN_PERMISSIONS.SUPPORT_ADJUST), async (c) => {
		const admin = requireAdminUser(c);
		const workspaceId = c.req.param("workspaceId") ?? "";
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = planChangeSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		if (!isWorkspacePlanId(parsed.data.planId)) {
			return c.json({ error: `Unknown workspace plan '${parsed.data.planId}'`, code: "unknown_plan" }, 400);
		}

		const previous = await billing.getWorkspaceAssignment(workspaceId).catch(() => null);
		try {
			const assignment = await billing.setWorkspacePlan({
				workspaceId,
				planId: parsed.data.planId,
				status: parsed.data.status,
			});
			await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				actorRole: admin.role,
				action: "admin.support.plan_change",
				targetKind: "workspace",
				targetId: workspaceId,
				detail: {
					fromPlanId: previous?.planId ?? null,
					toPlanId: assignment.planId,
					fromStatus: previous?.status ?? null,
					toStatus: assignment.status,
					reason: parsed.data.reason,
				},
			});
			return c.json({ ok: true, billing: assignment });
		} catch (error) {
			if (error instanceof BillingStoreError) {
				// A failed persistence write or missing store config is a SERVER fault (500),
				// not bad input — returning 400 told the operator their request was malformed
				// when the DB write actually failed. Validation codes (unknown plan, invalid
				// workspace id) remain 400.
				const serverFault = error.code === "billing_assignment_failed" || error.code === "billing_store_unconfigured";
				return c.json({ error: error.message, code: error.code }, serverFault ? 500 : 400);
			}
			throw error;
		}
	});

	// ── REAL refund (REFUND_WRITE — money OUT) ───────────────────────
	// Replaces the audit-only "refund_requested" no-op: records a NEGATIVE
	// payment_transactions row (per-currency, integer cents, #162 money model) via
	// dodo.service, idempotent on the dedupe ref so a retry never double-refunds, and
	// AUDITED. When Dodo is the live provider + a charge id is supplied, the real
	// provider refund fires inside recordSupportRefund.
	router.post("/workspaces/:workspaceId/refund", requirePermission(ADMIN_PERMISSIONS.REFUND_WRITE), async (c) => {
		const admin = requireAdminUser(c);
		const workspaceId = c.req.param("workspaceId") ?? "";
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = refundSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

		try {
			const { transaction, providerRefundId } = await dodo.recordSupportRefund({
				workspaceId,
				// absCents keeps the input a positive integer-cents magnitude; the service
				// negates it for the stored row so net revenue nets.
				amountCents: absCents(parsed.data.amountMinor),
				currency: parsed.data.currency,
				reason: parsed.data.reason,
				initiatedBy: admin.userId,
				idempotencyKey: parsed.data.idempotencyKey,
				dodoChargeId: parsed.data.dodoChargeId,
				paymentTransactionsStore: paymentTxStore,
			});
			await gdpr.recordAdminAudit({
				adminUserId: admin.userId,
				actorRole: admin.role,
				action: "admin.support.refund",
				targetKind: "workspace",
				targetId: workspaceId,
				detail: {
					transactionId: transaction.id,
					amountCents: transaction.amountCents,
					currency: transaction.currency,
					reason: parsed.data.reason,
					dodoChargeId: parsed.data.dodoChargeId ?? null,
					providerRefundId,
					idempotencyKey: parsed.data.idempotencyKey,
				},
			});
			return c.json({ ok: true, refund: transaction, providerRefundId });
		} catch (error) {
			if (error instanceof DodoBillingError) {
				return c.json({ error: error.message, code: error.code }, error.status as 400);
			}
			throw error;
		}
	});

	return router;
}

// ── OWNER-OPS owner-decision routes (OWNER-ONLY) ────────────────────────────────
//
// The "talk to the bot" backend: the owner sees the cases the deterministic gate
// routed to them and decides with one tap. Gated to the OWNER via
// requirePermission(ROLES_WRITE) — held ONLY by the owner role, so a customer,
// support, accountant, or admin all 403. Approve/deny/modify are bounded,
// idempotent (the decision id is the grant dedupe key), and AUDITED as
// actor="owner" with the explicit actorRole.

// Owner can override the sanctioned amount on approve. amountCents is MINOR UNITS.
const ownerModifySchema = z.object({
	amountCents: z.number().int().min(1).max(100_000_000),
	reason: z.string().trim().max(2000).optional(),
}).strict();

// Clawback requires a reason (audit + the recorded correction record).
const clawbackSchema = z.object({
	reason: z.string().trim().min(1).max(2000),
}).strict();

function serializeDecision(d: SupportDecisionRecord): Record<string, unknown> {
	return {
		id: d.id,
		ticketId: d.ticketId ?? null,
		userId: d.userId,
		action: d.action,
		params: d.params,
		evidence: d.evidence,
		recommendation: d.recommendation ?? null,
		decision: d.decision,
		reason: d.reason ?? null,
		decidedBy: d.decidedBy,
		executedRef: d.executedRef ?? null,
		amountCents: d.amountCents,
		currency: d.currency ?? null,
		// executionPending = the owner APPROVED this case but the real side effect has
		// not run, because refund/plan_change are not auto-executed by the owner-ops
		// surface (they go through the dedicated REFUND_WRITE / SUPPORT_ADJUST tools).
		// A grant always executes inline, so it is approved-WITH-executedRef and never
		// pending. This lets the queue/detail UI show "approved — action queued" instead
		// of a misleading "done", and never shows a no-op as a completed action.
		executionPending: d.decision === "owner_approved" && d.action !== "grant_credit" && !d.executedRef,
		// Surface the clawback record (reason + reversed/unrecoverable) when present.
		clawback: (d.params && typeof d.params === "object" && "clawback" in d.params) ? d.params.clawback : null,
		createdAt: d.createdAt,
		decidedAt: d.decidedAt ?? null,
	};
}

function registerOwnerDecisionRoutes(
	router: Hono,
	deps: { creditSvc: CreditService; decisionStore: OwnerDecisionStore; gdpr: GdprStore },
): void {
	const { creditSvc, decisionStore, gdpr } = deps;
	// OWNER-ONLY gate for the whole owner-ops surface. ROLES_WRITE is owner-exclusive.
	const ownerOnly = requirePermission(ADMIN_PERMISSIONS.ROLES_WRITE);

	// GET pending owner-review queue.
	router.get("/owner/decisions", ownerOnly, async (c) => {
		const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 100));
		const pending = await decisionStore.listPending(limit);
		return c.json({ decisions: pending.map(serializeDecision) });
	});

	// GET one case (any state) for the deep-link.
	router.get("/owner/decisions/:id", ownerOnly, async (c) => {
		const decision = await decisionStore.getById(c.req.param("id") ?? "");
		if (!decision) return c.json({ error: "Decision not found", code: "decision_not_found" }, 404);
		return c.json({ decision: serializeDecision(decision) });
	});

	// POST approve → execute the action as actor="owner" (bounded/idempotent/audited).
	router.post("/owner/decisions/:id/approve", ownerOnly, async (c) => {
		return settleOwnerDecision(c, { creditSvc, decisionStore, gdpr, mode: "approve" });
	});

	// POST deny → no execution; mark owner_denied.
	router.post("/owner/decisions/:id/deny", ownerOnly, async (c) => {
		return settleOwnerDecision(c, { creditSvc, decisionStore, gdpr, mode: "deny" });
	});

	// POST modify → owner overrides the amount, then executes the modified amount.
	router.post("/owner/decisions/:id/modify", ownerOnly, async (c) => {
		return settleOwnerDecision(c, { creditSvc, decisionStore, gdpr, mode: "modify" });
	});

	// POST clawback → REVERSE an erroneous executed grant (auto OR owner-approved).
	// Deducts the granted credits back (clamped to the unspent remainder), idempotent
	// (a grant is clawed back at most once), audited as actor="owner".
	router.post("/owner/decisions/:id/clawback", ownerOnly, async (c) => {
		const owner = requireAdminUser(c);
		const id = c.req.param("id") ?? "";
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = clawbackSchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		try {
			const result = await executeClawback({
				decisionId: id,
				reason: parsed.data.reason,
				ownerUserId: owner.userId,
				creditService: creditSvc,
				decisionStore,
				// The audit is recorded AS PART OF the reversal success path: executeClawback
				// runs this only on the winning path (after credits reverse, BEFORE the row
				// is finalized) and, if it throws, reverts the transition + fails closed (so a
				// money reversal is never reported as a clean success — and never finalized —
				// without an audit row). Because finalize happens only after this returns,
				// FINALIZED implies AUDITED. An idempotent retry of a FINALIZED row
				// (alreadyClawedBack) made no money move, so this hook is not invoked again;
				// a crash between this audit and finalize re-audits on retry (a duplicate
				// audit row — the safe direction).
				auditReversal: async (outcome) => {
					await gdpr.recordAdminAudit({
						adminUserId: owner.userId,
						actorRole: owner.role,
						action: "admin.support.owner_decision.clawback",
						targetKind: "support_decision",
						targetId: outcome.decision.id,
						detail: {
							ticketId: outcome.decision.ticketId ?? null,
							userId: outcome.decision.userId,
							reason: parsed.data.reason,
							reversedCredits: outcome.reversedCredits,
							unrecoverableCredits: outcome.unrecoverableCredits,
							reversalRef: outcome.reversalRef,
							grantAmountCents: outcome.decision.amountCents,
							currency: outcome.decision.currency ?? null,
						},
					});
				},
			});
			return c.json({
				ok: true,
				alreadyClawedBack: result.alreadyClawedBack,
				reversedCredits: result.reversedCredits,
				unrecoverableCredits: result.unrecoverableCredits,
				reversalRef: result.reversalRef,
				decision: serializeDecision(result.decision),
			});
		} catch (error) {
			if (error instanceof ClawbackError) {
				return c.json({ error: error.message, code: error.code }, error.status as 400);
			}
			throw error;
		}
	});

	// GET daily digest → post-hoc spot-check of the day's autonomous owner-ops.
	// Read-only aggregate over the decision rows + the AI token meter. `date` is an
	// optional YYYY-MM-DD (UTC); omitted → today.
	router.get("/owner/digest", ownerOnly, async (c) => {
		const dayStartMs = parseDigestDate(c.req.query("date"));
		if (dayStartMs === null) {
			return c.json({ error: "Invalid date; expected YYYY-MM-DD", code: "invalid_digest_date" }, 400);
		}
		const digest = await buildOwnerOpsDigest({ dayStartMs, decisionStore });
		return c.json({ digest });
	});
}

async function settleOwnerDecision(
	c: Context,
	deps: { creditSvc: CreditService; decisionStore: OwnerDecisionStore; gdpr: GdprStore; mode: "approve" | "deny" | "modify" },
): Promise<Response> {
	const owner = requireAdminUser(c);
	const id = c.req.param("id") ?? "";
	const decision = await deps.decisionStore.getById(id);
	if (!decision) return c.json({ error: "Decision not found", code: "decision_not_found" }, 404);
	if (decision.decision !== "owner_pending") {
		// Already settled → idempotent no-op (return the current state, do NOT re-execute).
		return c.json({ ok: true, alreadySettled: true, decision: serializeDecision(decision) });
	}

	// ── DENY: no money moves. ──────────────────────────────────────────────────────
	if (deps.mode === "deny") {
		const updated = await deps.decisionStore.settleDecision({
			id, from: "owner_pending", to: "owner_denied", decidedBy: `owner:${owner.userId}`,
		});
		await auditOwnerDecision(deps.gdpr, owner, decision, "deny", null, decision.amountCents);
		return c.json({ ok: true, decision: serializeDecision(updated ?? decision) });
	}

	// ── APPROVE / MODIFY: execute the action. ───────────────────────────────────────
	let sanctionedCents = decision.amountCents;
	if (deps.mode === "modify") {
		const raw = await readJsonBody(c);
		if (!raw.ok) return raw.response;
		const parsed = ownerModifySchema.safeParse(raw.data);
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		sanctionedCents = parsed.data.amountCents;
	}

	// Transition FIRST (idempotency anchor): only one approve wins the row.
	const updated = await deps.decisionStore.settleDecision({
		id, from: "owner_pending", to: "owner_approved", decidedBy: `owner:${owner.userId}`, amountCents: sanctionedCents,
	});
	if (!updated) {
		// Lost the race / already settled → re-read and report; do NOT execute.
		const current = await deps.decisionStore.getById(id);
		return c.json({ ok: true, alreadySettled: true, decision: serializeDecision(current ?? decision) });
	}

	// Execute the bounded/idempotent side effect for grant_credit ONLY. A credit
	// grant is the one money action this surface can perform end-to-end safely
	// (idempotency-keyed mint into the ledger). refund and plan_change require the
	// dedicated REFUND_WRITE / SUPPORT_ADJUST routes — those carry the provider
	// refund call, amount/currency validation against the original charge, and the
	// plan-store write that this owner-decision row has no safe way to reproduce.
	//
	// CRITICAL: approving a refund/plan_change here records the owner's DECISION but
	// performs NO money movement. We must NOT report that as a completed action — a
	// silent no-op dressed as success is exactly the defect this fixes. Instead we
	// return an explicit `executionPending` state so the UI shows "approved — action
	// queued, run via the refund/plan-change tool", never a fake "done".
	let executedRef: string | null = null;
	const executable = updated.action === "grant_credit";
	if (executable) {
		executedRef = await executeApprovedGrant({
			decision: updated,
			sanctionedCents,
			workspaceId: workspaceForDecision(updated),
			userId: updated.userId,
			creditService: deps.creditSvc,
			decisionStore: deps.decisionStore,
			actor: "owner",
		});
	}

	// AUDIT BEFORE finalizing executedRef so a FINALIZED grant is ALWAYS audited
	// (matching the clawback path: FINALIZED ⇒ AUDITED). auditOwnerDecision no longer
	// swallows — a failed audit throws here and fails the request CLOSED. Because the
	// credit mint is idempotency-keyed, an idempotent retry re-grants (never double-
	// mints) and re-audits, so we can never finalize an unaudited mint.
	await auditOwnerDecision(deps.gdpr, owner, updated, deps.mode, executedRef, sanctionedCents);
	if (executable && executedRef) {
		await deps.decisionStore.settleDecision({
			id, from: "owner_approved", to: "owner_approved", decidedBy: `owner:${owner.userId}`, executedRef,
		});
	}
	const finalRec = await deps.decisionStore.getById(id);
	// executionPending = the owner approved a real money/account action that this
	// endpoint cannot itself execute (refund/plan_change), so it is queued for the
	// dedicated tool. true ONLY when approved-but-not-executed; a grant always
	// executes inline (executedRef set), so it is never pending.
	const executionPending = !executable;
	return c.json({
		ok: true,
		decision: serializeDecision(finalRec ?? updated),
		executedRef,
		executionPending,
		...(executionPending
			? {
					followUp:
						updated.action === "refund"
							? { action: "refund", route: `/admin/support/workspaces/${workspaceForDecision(updated) ?? ""}/refund`, permission: "REFUND_WRITE" }
							: updated.action === "plan_change"
								? { action: "plan_change", route: `/admin/support/workspaces/${workspaceForDecision(updated) ?? ""}/plan-change`, permission: "SUPPORT_ADJUST" }
								: { action: updated.action, route: null, permission: null },
					message:
						"Approved and recorded. This action is not auto-executed here — complete it via the dedicated refund/plan-change tool, which validates and processes the real change.",
				}
			: {}),
	});
}

// The workspace the grant is paid into — recorded on the proposal's evidence/refs.
// Falls back to the decision params' workspaceId when present.
function workspaceForDecision(d: SupportDecisionRecord): string | undefined {
	const fromParams = typeof d.params?.workspaceId === "string" ? d.params.workspaceId : undefined;
	return fromParams?.trim() || undefined;
}

async function auditOwnerDecision(
	gdpr: GdprStore,
	owner: JWTPayload,
	decision: SupportDecisionRecord,
	mode: "approve" | "deny" | "modify",
	executedRef: string | null,
	sanctionedCents: number,
): Promise<void> {
	await gdpr.recordAdminAudit({
		adminUserId: owner.userId,
		// actorRole passed EXPLICITLY (never best-effort store resolution).
		actorRole: owner.role,
		action: `admin.support.owner_decision.${mode}`,
		targetKind: "support_decision",
		targetId: decision.id,
		detail: {
			ticketId: decision.ticketId ?? null,
			userId: decision.userId,
			proposalAction: decision.action,
			reason: decision.reason ?? null,
			amountCents: sanctionedCents,
			currency: decision.currency ?? null,
			executedRef,
			evidence: decision.evidence,
		},
	});
}
