import { Hono } from "hono";
import { authMiddleware, getAuthUser, requireAdmin } from "../middleware/auth.middleware.js";
import { readPositiveIntegerConfigValue } from "../config.js";
import {
	CreditServiceError,
	allocate,
	creditService,
	getAllocationWorkspaceId,
	getBalance,
	getGrantWorkspaceId,
	grantCredits,
	listAllocations,
	revokeAllocation,
	type CreditBalanceScope,
} from "../services/credits.js";
import type { CreditAllocationScope, CreditClass, CreditGrantSource, CreditOwnerScope } from "../services/credits.js";
import { gdprStore } from "../services/gdpr.js";
import { WorkspaceAccessError, workspaceAccessStore } from "../services/workspace-access.js";
import { isPlatformAdmin, type JWTPayload } from "../types/auth.js";
import { readJsonBody } from "../utils/request-body.js";

const credits = new Hono();
const DEFAULT_CREDITS_GRANT_MAX = 1_000_000;

credits.use("*", authMiddleware);

credits.post("/grant", requireAdmin, async (c) => {
	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = parseGrantPayload(body.data);
	if (!parsed.ok) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.details }, 400);
	const user = getAuthUser(c) as JWTPayload;

	try {
		const grant = await grantCredits(parsed.data);
		await gdprStore.recordAdminAudit({
			adminUserId: user.userId,
			actorRole: user.role,
			action: "admin.credits.grant",
			targetKind: parsed.data.ownerScope,
			targetId: parsed.data.ownerId,
			detail: {
				grantId: grant.id,
				workspaceId: grant.workspaceId,
				amount: grant.amount,
				creditClass: grant.creditClass,
				ownerScope: grant.ownerScope,
				ownerId: grant.ownerId,
				source: grant.source,
				reason: parsed.data.reason,
				expiresAt: grant.expiresAt ?? null,
				idempotencyKey: parsed.data.idempotencyKey,
			},
		});
		return c.json({ grant }, 201);
	} catch (error) {
		return creditErrorResponse(c, error);
	}
});

credits.post("/allocate", async (c) => {
	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = parseAllocatePayload(body.data);
	if (!parsed.ok) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.details }, 400);
	const user = getAuthUser(c) as JWTPayload;
	// Authorize against the workspace that actually owns the grant, NOT the
	// client-supplied workspaceId, so an owner of workspace A cannot allocate
	// workspace B's shareable credits by passing A's id in the body.
	const grantWorkspaceId = getGrantWorkspaceId(parsed.data.grantId);
	if (!grantWorkspaceId) {
		return c.json({ error: "Credit grant not found", code: "credit_grant_not_found" }, 404);
	}
	if (parsed.data.workspaceId !== grantWorkspaceId) {
		return c.json({ error: "Grant does not belong to the specified workspace", code: "grant_workspace_mismatch" }, 403);
	}
	const accessError = await requireCreditManager(c, grantWorkspaceId, user);
	if (accessError) return accessError;

	try {
		const allocation = await allocate(parsed.data.grantId, parsed.data.toScope, parsed.data.toId, parsed.data.amount, user.userId);
		return c.json({ allocation }, 201);
	} catch (error) {
		return creditErrorResponse(c, error);
	}
});

credits.post("/allocations/:id/revoke", async (c) => {
	const user = getAuthUser(c) as JWTPayload;
	// Resolve the allocation's owning workspace and authorize against it rather
	// than trusting any client-supplied workspaceId.
	const allocationWorkspaceId = getAllocationWorkspaceId(c.req.param("id"));
	if (!allocationWorkspaceId) {
		return c.json({ error: "Credit allocation not found", code: "credit_allocation_not_found" }, 404);
	}
	const accessError = await requireCreditManager(c, allocationWorkspaceId, user);
	if (accessError) return accessError;

	try {
		const allocation = await revokeAllocation(c.req.param("id"), user.userId);
		return c.json({ allocation });
	} catch (error) {
		return creditErrorResponse(c, error);
	}
});

credits.get("/balance/:scope/:id", async (c) => {
	const scope = c.req.param("scope") as CreditBalanceScope;
	if (!["workspace", "member", "page", "chapter", "user"].includes(scope)) {
		return c.json({ error: "Invalid balance scope", code: "invalid_balance_scope" }, 400);
	}
	const workspaceId = c.req.query("workspace")?.trim();
	const user = getAuthUser(c) as JWTPayload;
	if (scope === "workspace") {
		const accessError = await requireWorkspaceRead(c, c.req.param("id"), user);
		if (accessError) return accessError;
	} else if (scope === "member" || scope === "user") {
		// member/user balances expose a user's PERSONAL add-on credits. read_workspace
		// is held by viewers and editors, so it is not enough to protect another
		// user's personal balance. Require either self (the target id is the caller)
		// or a workspace member-manager (owner/admin) before returning these.
		if (!workspaceId) {
			return c.json({ error: "workspace query is required for non-workspace scopes", code: "missing_workspace" }, 400);
		}
		if (c.req.param("id") !== user.userId) {
			const accessError = await requireCreditManager(c, workspaceId, user);
			if (accessError) return accessError;
		} else {
			const accessError = await requireWorkspaceRead(c, workspaceId, user);
			if (accessError) return accessError;
		}
	} else {
		// page/chapter allocation balances are workspace-scoped (and now filtered by
		// workspace in getBalance), so a workspace id is mandatory and the caller
		// must be able to read that workspace.
		if (!workspaceId) {
			return c.json({ error: "workspace query is required for non-workspace scopes", code: "missing_workspace" }, 400);
		}
		const accessError = await requireWorkspaceRead(c, workspaceId, user);
		if (accessError) return accessError;
	}
	return c.json({ balance: getBalance(scope, c.req.param("id"), workspaceId || undefined) });
});

credits.get("/allocations", async (c) => {
	const workspaceId = c.req.query("workspace")?.trim();
	if (!workspaceId) return c.json({ error: "workspace query is required", code: "missing_workspace" }, 400);
	const user = getAuthUser(c) as JWTPayload;
	const accessError = await requireWorkspaceRead(c, workspaceId, user);
	if (accessError) return accessError;
	return c.json({ allocations: listAllocations(workspaceId) });
});

credits.get("/ledger", requireAdmin, (c) => {
	const workspaceId = c.req.query("workspace")?.trim();
	return c.json({ ledger: creditService.listLedger(workspaceId || undefined) });
});

async function requireCreditManager(c: any, workspaceId: string, user: JWTPayload): Promise<Response | null> {
	// Degraded mode (no workspace access store): platform owner/admin are allowed.
	// owner is a strict superset of admin, so a literal role === "admin" would wrongly
	// lock the owner out of credit management when the store is unavailable.
	if (isPlatformAdmin(user.role) && !workspaceAccessStore) return null;
	if (!workspaceAccessStore) return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	try {
		const member = await workspaceAccessStore.requirePermission(workspaceId, user.userId, "manage_members");
		if (member.role === "owner" || member.role === "admin") return null;
		return c.json({ error: "Forbidden: credit allocation requires workspace owner/admin", code: "workspace_credit_manager_required" }, 403);
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
}

async function requireWorkspaceRead(c: any, workspaceId: string, user: JWTPayload): Promise<Response | null> {
	// Degraded mode (no workspace access store): platform owner/admin are allowed.
	// owner is a strict superset of admin (see requireCreditManager above).
	if (isPlatformAdmin(user.role) && !workspaceAccessStore) return null;
	if (!workspaceAccessStore) return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	try {
		await workspaceAccessStore.requirePermission(workspaceId, user.userId, "read_workspace");
		return null;
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
}

function workspaceErrorResponse(c: any, error: unknown): Response {
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}

function creditErrorResponse(c: any, error: unknown): Response {
	if (error instanceof CreditServiceError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}

function parseGrantPayload(raw: any): { ok: true; data: {
	workspaceId: string;
	ownerScope: CreditOwnerScope;
	ownerId: string;
	creditClass: CreditClass;
	amount: number;
	source: CreditGrantSource;
	reason: string;
	idempotencyKey: string;
	expiresAt?: string;
} } | { ok: false; details: string[] } {
	const details: string[] = [];
	const workspaceId = readString(raw?.workspaceId, "workspaceId", details, 200);
	const ownerScope = readEnum(raw?.ownerScope, "ownerScope", ["workspace", "user"] as const, details);
	const ownerId = readString(raw?.ownerId, "ownerId", details, 300);
	const creditClass = readEnum(raw?.creditClass, "creditClass", ["shareable", "personal"] as const, details);
	const amount = readPositiveInteger(raw?.amount, "amount", details);
	const source = readEnum(raw?.source, "source", ["plan_monthly", "addon_purchase", "goodwill", "topup"] as const, details);
	const reason = readString(raw?.reason, "reason", details, 2000);
	const idempotencyKey = readString(raw?.idempotencyKey, "idempotencyKey", details, 200);
	const expiresAt = raw?.expiresAt === undefined ? undefined : readString(raw.expiresAt, "expiresAt", details, 100);
	const maxAmount = getCreditsGrantMax();
	if (amount > maxAmount) {
		details.push(`amount must be less than or equal to ${maxAmount}`);
	}
	if (details.length) return { ok: false, details };
	return { ok: true, data: { workspaceId, ownerScope, ownerId, creditClass, amount, source, reason, idempotencyKey, expiresAt } };
}

function parseAllocatePayload(raw: any): { ok: true; data: {
	grantId: string;
	workspaceId: string;
	toScope: CreditAllocationScope;
	toId: string;
	amount: number;
} } | { ok: false; details: string[] } {
	const details: string[] = [];
	const grantId = readString(raw?.grantId, "grantId", details, 300);
	const workspaceId = readString(raw?.workspaceId, "workspaceId", details, 200);
	const toScope = readEnum(raw?.toScope, "toScope", ["member", "page", "chapter"] as const, details);
	const toId = readString(raw?.toId, "toId", details, 300);
	const amount = readPositiveNumber(raw?.amount, "amount", details);
	if (details.length) return { ok: false, details };
	return { ok: true, data: { grantId, workspaceId, toScope, toId, amount } };
}

function readString(value: unknown, field: string, details: string[], max: number): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
		details.push(`${field} must be a non-empty string up to ${max} characters`);
		return "";
	}
	return value.trim();
}

function readPositiveNumber(value: unknown, field: string, details: string[]): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		details.push(`${field} must be a positive number`);
		return 0;
	}
	return value;
}

function readPositiveInteger(value: unknown, field: string, details: string[]): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		details.push(`${field} must be a positive integer`);
		return 0;
	}
	return value;
}

function getCreditsGrantMax(): number {
	return readPositiveIntegerConfigValue(process.env.CREDITS_GRANT_MAX, DEFAULT_CREDITS_GRANT_MAX);
}

function readEnum<T extends string>(value: unknown, field: string, allowed: readonly [T, ...T[]], details: string[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		details.push(`${field} must be one of ${allowed.join(", ")}`);
		return allowed[0];
	}
	return value as T;
}

export { credits };
