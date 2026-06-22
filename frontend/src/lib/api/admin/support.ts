// Admin SUPPORT api barrel (ranks 12-14).
//
// Talks to /api/admin/support/* via the shared adminFetch client (same Bearer header
// + base URL handling as the rest of the admin surface). Customer-360 lookup (read) +
// REAL credit grant / plan change / refund support actions.
//
// PATH CONVENTION (IMPORTANT): adminFetch prepends `config.apiBase` (which is `/api`),
// so paths here must NOT start with `/api` — they start at `/admin/...`. (Several
// sibling barrels mistakenly prefix `/api/admin/...`, which double-prefixes to
// `/api/api/admin/...`; this barrel follows the working legacy api/admin.ts convention.)

import { adminFetch } from "./client.ts";

export interface AdminSupportUser {
	id: string;
	email: string;
	name: string;
	role: string;
	isActive: boolean;
	createdAt: string;
}

export interface AdminSupportWorkspace {
	id: string;
	name: string | null;
}

export interface AdminSupportPlan {
	planId: string;
	status: string | null;
	assigned: boolean;
}

export interface AdminSupportPayment {
	id: string;
	kind: "payment" | "refund" | "dispute";
	amountCents: number;
	currency: string | null;
	status: string | null;
	planId: string | null;
	occurredAt: string;
}

export interface AdminSupportTicket {
	id: string;
	subject: string;
	status: string;
	category: string;
	updatedAt: string;
}

export interface AdminSupportCreditBalance {
	shareable: number;
	personal: number;
	total: number;
}

export interface AdminCustomer360 {
	query: string;
	user: AdminSupportUser | null;
	workspace: AdminSupportWorkspace | null;
	plan: AdminSupportPlan | null;
	creditBalance: AdminSupportCreditBalance;
	recentPayments: AdminSupportPayment[];
	openTickets: AdminSupportTicket[];
}

export interface GrantSupportCreditsInput {
	amount: number;
	reason: string;
	creditClass?: "shareable" | "personal";
	/** Required when creditClass is "personal" (personal credits are owned by a user). */
	userId?: string;
	expiresAt?: string;
	/** Idempotency key — a retry with the same key returns the existing grant. */
	idempotencyKey?: string;
}

export interface SupportGrantResult {
	ok: boolean;
	grant: {
		id: string;
		workspaceId: string;
		ownerScope: "workspace" | "user";
		ownerId: string;
		creditClass: "shareable" | "personal";
		amount: number;
		source: string;
		expiresAt?: string;
		createdAt: string;
	};
}

export interface ChangeSupportPlanInput {
	planId: string;
	status?: "mock_active" | "trialing" | "active" | "past_due" | "cancelled";
	reason: string;
}

export interface SupportPlanChangeResult {
	ok: boolean;
	billing: {
		workspaceId: string;
		planId: string;
		status: string;
		updatedAt: string;
	};
}

export interface SupportRefundInput {
	/** Refund amount in MINOR UNITS (integer cents). */
	amountMinor: number;
	/** ISO-4217 currency code (per-currency money model). */
	currency: string;
	reason: string;
	/** Optional Dodo charge/payment id; when set + Dodo is live, the real provider refund fires. */
	dodoChargeId?: string;
	/** Idempotency key — a retry with the same key never doubles the money out. */
	idempotencyKey: string;
}

export interface SupportRefundResult {
	ok: boolean;
	refund: AdminSupportPayment;
	providerRefundId: string | null;
}

export const adminSupportApi = {
	// Customer 360 — resolve a user (by email/id) or workspace (by id) and return
	// profile + plan + credit balance + recent payments + open tickets. READ-ONLY.
	lookup(query: string): Promise<AdminCustomer360> {
		return adminFetch<AdminCustomer360>(`/admin/support/lookup?query=${encodeURIComponent(query)}`);
	},

	// REAL goodwill credit grant (SUPPORT_ADJUST). Idempotent on idempotencyKey.
	grantCredits(workspaceId: string, input: GrantSupportCreditsInput): Promise<SupportGrantResult> {
		return adminFetch<SupportGrantResult>(`/admin/support/workspaces/${encodeURIComponent(workspaceId)}/credits`, {
			method: "POST",
			body: JSON.stringify(input),
		});
	},

	// REAL plan change (SUPPORT_ADJUST). Idempotent by nature (state convergence).
	changePlan(workspaceId: string, input: ChangeSupportPlanInput): Promise<SupportPlanChangeResult> {
		return adminFetch<SupportPlanChangeResult>(`/admin/support/workspaces/${encodeURIComponent(workspaceId)}/plan-change`, {
			method: "POST",
			body: JSON.stringify(input),
		});
	},

	// REAL refund (REFUND_WRITE — money OUT). Idempotent on idempotencyKey.
	refund(workspaceId: string, input: SupportRefundInput): Promise<SupportRefundResult> {
		return adminFetch<SupportRefundResult>(`/admin/support/workspaces/${encodeURIComponent(workspaceId)}/refund`, {
			method: "POST",
			body: JSON.stringify(input),
		});
	},
};
