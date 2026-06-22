// Admin AUDIT api barrel.
//
// Read-only query over the durable admin audit log. Talks to the existing
// GET /api/admin/audit endpoint (served by api/admin.ts on the backend — not
// modified here) via the shared adminFetch client so it inherits the same
// Bearer header + base URL semantics as the rest of the admin surface.
//
// NOTE: adminFetch prepends config.apiBase (default "/api"), so request paths
// here must be relative to that base (e.g. "/admin/audit", NOT "/api/admin/audit",
// which would double the prefix to "/api/api/admin/audit").
//
// The audit rows are now durable (PostgresGdprStore) and carry the acting
// admin's platform role (`actorRole`), so the back-office can render and filter
// "who, in what capacity, did what" across restarts.

import { adminFetch, adminApiBase, getAdminApiToken, AdminApiError } from "./client.ts";

export interface AdminAuditEntry {
	id: string;
	adminUserId: string;
	/** Platform role of the acting admin (owner/admin/support/accountant/…), or null for legacy/system rows. */
	actorRole: string | null;
	action: string;
	targetKind: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

export interface ListAdminAuditOptions {
	action?: string;
	adminUserId?: string;
	actorRole?: string;
	targetKind?: string;
	targetId?: string;
	fromDate?: string;
	toDate?: string;
	limit?: number;
	offset?: number;
}

export interface AdminAuditPage {
	entries: AdminAuditEntry[];
	total: number;
}

function buildQuery(options: ListAdminAuditOptions): string {
	const params = new URLSearchParams();
	if (options.action) params.set("action", options.action);
	if (options.adminUserId) params.set("adminUserId", options.adminUserId);
	if (options.actorRole) params.set("actorRole", options.actorRole);
	if (options.targetKind) params.set("targetKind", options.targetKind);
	if (options.targetId) params.set("targetId", options.targetId);
	if (options.fromDate) params.set("fromDate", options.fromDate);
	if (options.toDate) params.set("toDate", options.toDate);
	if (options.limit !== undefined) params.set("limit", String(options.limit));
	if (options.offset !== undefined) params.set("offset", String(options.offset));
	const query = params.toString();
	return query ? `?${query}` : "";
}

export interface AdminAuditCsv {
	csv: string;
	filename: string;
}

export const adminAuditApi = {
	/** Page the durable admin audit log, newest-first, with optional filters. */
	list(options: ListAdminAuditOptions = {}): Promise<AdminAuditPage> {
		return adminFetch<AdminAuditPage>(`/admin/audit${buildQuery(options)}`);
	},

	/**
	 * Export the audit log (honoring the SAME filters as `list`, minus paging)
	 * to CSV. GET /api/admin/audit.csv sits behind the same Bearer-only auth as
	 * every admin endpoint, so a plain <a href> would download a 401 body (the
	 * browser attaches no Authorization header to navigations). Fetch it through
	 * the shared base + Bearer header and hand the caller the CSV text plus the
	 * server-suggested filename; the page turns that into a Blob download.
	 * Keeping the token in a header rather than the URL also avoids leaking it
	 * into referers / server logs.
	 */
	async downloadCsv(options: ListAdminAuditOptions = {}): Promise<AdminAuditCsv> {
		// Paging params are meaningless for a full export — drop them.
		const { limit: _limit, offset: _offset, ...filters } = options;
		const headers = new Headers();
		const token = getAdminApiToken();
		if (token) headers.set("Authorization", `Bearer ${token}`);
		const res = await fetch(`${adminApiBase()}/admin/audit.csv${buildQuery(filters)}`, { headers });
		const raw = await res.text();
		if (!res.ok) {
			let detail: unknown = raw;
			try { detail = JSON.parse(raw); } catch { /* keep raw */ }
			const message = typeof (detail as { error?: string })?.error === "string"
				? (detail as { error: string }).error
				: `Admin API ${res.status}`;
			throw new AdminApiError(res.status, message, detail);
		}
		const disposition = res.headers.get("content-disposition") ?? "";
		const match = disposition.match(/filename="?([^"]+)"?/);
		const filename = match?.[1] ?? `admin-audit-${new Date().toISOString().slice(0, 10)}.csv`;
		return { csv: raw, filename };
	},
};
