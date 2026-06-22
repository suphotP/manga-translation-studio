// Index + thin wrapper around the /api/admin/* surface. Mirrors the shape
// returned by backend/src/routes/admin.ts so admin pages stay strongly typed.
//
// The shared fetch client (token + base URL + Bearer-header handling) lives in
// ./admin/client.ts and is re-exported here so existing imports keep working
// unchanged. Per-domain barrels (revenue/coupons/support/users/content) live in
// ./admin/* and are re-exported below; each later domain worker edits only its
// own barrel so parallel back-office work never collides on this index.

import { adminFetch, AdminApiError, adminApiBase, getAdminApiToken } from "./admin/client.ts";

// Re-export the shared client surface so `$lib/api/admin.ts` stays the public
// import point for these (callers unchanged).
export { adminFetch, AdminApiError, setAdminApiToken } from "./admin/client.ts";
export type { FetchOpts } from "./admin/client.ts";

// Per-domain api barrels. Each later domain worker adds methods to its own
// module only; this index just re-exports the namespaces.
export { adminRevenueApi } from "./admin/revenue.ts";
export { adminCouponsApi } from "./admin/coupons.ts";
export { adminSupportApi } from "./admin/support.ts";
export { adminOwnerDecisionsApi } from "./admin/owner-decisions.ts";
export type {
	OwnerDecision,
	OwnerDecisionAction,
	OwnerDecisionState,
	OwnerDecisionEvidence,
	OwnerDecisionListResult,
	OwnerDecisionSettleResult,
	OwnerModifyInput,
} from "./admin/owner-decisions.ts";
export { adminUsersApi } from "./admin/users.ts";
export { adminContentApi } from "./admin/content.ts";

export interface AdminWorkspaceRow {
	workspaceId: string;
	name: string;
	planId: string;
	status: string;
	billingEmail: string | null;
	createdAt: string;
	updatedAt: string;
}

// Mirrors backend UserRole (backend/src/types/auth.ts).
export type AdminUserRole = "owner" | "admin" | "support" | "accountant" | "editor" | "viewer";

// Shape of GET /api/admin/me — the SINGLE backend ROLE_PERMISSIONS map projected
// for the signed-in admin. The admin shell renders its nav + gates purely from
// this so frontend authorization never drifts from the server's.
export interface AdminMeSection {
	id: string;
	href: string;
	label: string;
	requires: string;
}

export interface AdminMe {
	role: AdminUserRole;
	permissions: string[];
	sections: AdminMeSection[];
}

export async function getAdminMe(): Promise<AdminMe> {
	const body = await adminFetch<Partial<AdminMe>>(`/admin/me`);
	return {
		role: (body.role ?? "viewer") as AdminUserRole,
		permissions: body.permissions ?? [],
		sections: body.sections ?? [],
	};
}

export interface AdminAuditEntry {
	id: string;
	adminUserId: string;
	action: string;
	targetKind: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

export interface AdminCronJob {
	id: string;
	name: string;
	schedule?: string;
	lastRunAt?: string | null;
	lastRunStatus?: "ok" | "failed" | "skipped" | null;
	nextRunAt?: string | null;
}

export interface ListWorkspacesResult {
	workspaces: AdminWorkspaceRow[];
	/**
	 * Honest count of ALL workspaces matching the current filters (server-side
	 * COUNT, not the page length). Stable across pages so the header never shrinks.
	 */
	total: number;
	/**
	 * Opaque keyset token for the next page, or null when this is the last page.
	 * Pass it back as `cursor` to load more.
	 */
	nextCursor: string | null;
}

export async function listWorkspaces(
	params: { search?: string; plan?: string; status?: string; limit?: number; cursor?: string } = {},
): Promise<ListWorkspacesResult> {
	const search = new URLSearchParams();
	if (params.search) search.set("search", params.search);
	if (params.plan) search.set("plan", params.plan);
	if (params.status) search.set("status", params.status);
	if (params.limit !== undefined) search.set("limit", String(params.limit));
	if (params.cursor) search.set("cursor", params.cursor);
	const qs = search.toString() ? `?${search.toString()}` : "";
	const body = await adminFetch<{ workspaces: AdminWorkspaceRow[]; total?: number; nextCursor?: string | null }>(
		`/admin/workspaces${qs}`,
	);
	return {
		workspaces: body.workspaces ?? [],
		total: body.total ?? body.workspaces?.length ?? 0,
		nextCursor: body.nextCursor ?? null,
	};
}

export async function getWorkspace(workspaceId: string): Promise<{ workspace: unknown; billing: unknown; grants: unknown[] }> {
	return adminFetch(`/admin/workspaces/${encodeURIComponent(workspaceId)}`);
}

// NOTE: credit grants + refunds are NOT exposed here. They are MONEY actions and
// must mint/move value through the REAL support ledger endpoints
// (adminSupportApi.grantCredits / adminSupportApi.refund → /admin/support/...),
// which carry the required idempotency key, RBAC, and audit. The old inline
// /admin/workspaces/:id/{credits,refund} wrappers were audit-only no-ops (they
// reported success while no credits were minted and no refund happened), so they
// were removed to prevent an operator from believing a dead action succeeded.

export async function impersonate(workspaceId: string, payload: { userId: string; reason: string }) {
	return adminFetch(`/admin/workspaces/${encodeURIComponent(workspaceId)}/impersonate`, {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export async function stopImpersonation(impersonationId: string) {
	return adminFetch(`/admin/impersonate/stop`, {
		method: "POST",
		body: JSON.stringify({ impersonationId }),
	});
}

// NOTE: the user list + force-logout + force-delete actions live on the single
// real users surface: `adminUsersApi` (→ /admin/users-mgmt). The old inline
// /admin/users{,/:id/force-logout} wrappers here duplicated that surface; they
// were removed so there is exactly one path the UI calls.

export async function listAudit(params: { action?: string; adminUserId?: string; targetKind?: string; targetId?: string; limit?: number; offset?: number } = {}): Promise<{ entries: AdminAuditEntry[]; total: number }> {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") search.set(key, String(value));
	}
	const qs = search.toString() ? `?${search.toString()}` : "";
	return adminFetch(`/admin/audit${qs}`);
}

// The CSV route sits behind the same Bearer-only auth as every other admin
// endpoint, so a plain <a href> link would download a 401 body (no header is
// attached to navigations). Fetch it through adminFetch (which sets the Bearer
// header) and hand the caller the CSV text + a suggested filename; the page
// turns that into a Blob download. Keeping the token in a header rather than
// the URL also avoids leaking it into referers / server logs.
export async function downloadAuditCsv(params: { action?: string; adminUserId?: string; targetKind?: string; targetId?: string } = {}): Promise<{ csv: string; filename: string }> {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") search.set(key, String(value));
	}
	const qs = search.toString() ? `?${search.toString()}` : "";
	const headers = new Headers();
	const token = getAdminApiToken();
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const res = await fetch(`${adminApiBase()}/admin/audit.csv${qs}`, { headers });
	const raw = await res.text();
	if (!res.ok) {
		let detail: unknown = raw;
		try { detail = JSON.parse(raw); } catch { /* keep raw */ }
		throw new AdminApiError(res.status, typeof (detail as { error?: string })?.error === "string" ? (detail as { error: string }).error : `Admin API ${res.status}`, detail);
	}
	const disposition = res.headers.get("content-disposition") ?? "";
	const match = disposition.match(/filename="?([^"]+)"?/);
	const filename = match?.[1] ?? `admin-audit-${new Date().toISOString().slice(0, 10)}.csv`;
	return { csv: raw, filename };
}

// ── Cron ────────────────────────────────────────────────────────────────────
// The REAL scheduler surface lives at /api/admin/cron/jobs + .../jobs/:name/
// trigger (backend/src/routes/admin-cron.ts, backed by the CronScheduler). The
// legacy /api/admin/cron route in admin.ts is a read-only stub whose trigger is
// a no-op, so we deliberately target the real endpoints here. The backend row
// shape (ScheduledJobRow) is mapped to the UI's AdminCronJob so the page
// contract stays stable; the scheduler keys jobs by `name`, which we surface as
// both `id` (the route param) and `name`.

interface BackendScheduledJobRow {
	name: string;
	schedule: string;
	lastRunAt: string | null;
	lastStatus: "success" | "error" | "skipped" | null;
	lastError: string | null;
	nextRunAt: string | null;
	enabled: boolean;
}

interface BackendCronRunResult {
	name: string;
	status: "success" | "error" | "skipped";
	error?: string;
}

function mapCronStatus(status: BackendScheduledJobRow["lastStatus"]): AdminCronJob["lastRunStatus"] {
	switch (status) {
		case "success": return "ok";
		case "error": return "failed";
		case "skipped": return "skipped";
		default: return null;
	}
}

export async function listCron(): Promise<{ jobs: AdminCronJob[] }> {
	const body = await adminFetch<{ jobs?: BackendScheduledJobRow[] }>(`/admin/cron/jobs`);
	const jobs = (body.jobs ?? []).map((row) => ({
		// The scheduler addresses jobs by name; the trigger route param is the
		// same name, so it doubles as the stable id the UI keys on.
		id: row.name,
		name: row.name,
		schedule: row.schedule || undefined,
		lastRunAt: row.lastRunAt,
		lastRunStatus: mapCronStatus(row.lastStatus),
		nextRunAt: row.nextRunAt,
	} satisfies AdminCronJob));
	return { jobs };
}

export async function triggerCron(jobId: string): Promise<{ ok: boolean; message: string }> {
	const body = await adminFetch<{ result?: BackendCronRunResult }>(
		`/admin/cron/jobs/${encodeURIComponent(jobId)}/trigger`,
		{ method: "POST" },
	);
	const result = body.result;
	if (!result) {
		return { ok: false, message: "Trigger failed" };
	}
	const ok = result.status === "success";
	let message: string;
	if (result.status === "success") {
		message = `รันเสร็จเรียบร้อย (${result.name})`;
	} else if (result.status === "skipped") {
		// `skipped` is not a hard error — the job was disabled or another
		// instance already held the advisory lock. Surface the reason verbatim.
		message = `ข้าม: ${result.error ?? "skipped"}`;
	} else {
		message = result.error ? `ล้มเหลว: ${result.error}` : "ล้มเหลว";
	}
	return { ok, message };
}
