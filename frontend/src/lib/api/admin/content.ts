// Admin CONTENT api barrel (ranks 17-18).
//
// Talks to /api/admin/content/* via the shared adminFetch client (same Bearer
// header + base URL handling as the rest of the admin surface). Cross-tenant
// project browser + moderation queue (read) + audited flag/hide (moderate).

import { adminFetch } from "./client.ts";

export interface AdminContentProject {
	projectId: string;
	workspaceId: string | null;
	workspaceName: string | null;
	ownerUserId: string | null;
	title: string;
	status: "active" | "admin_hidden" | "user_deleted";
	sourceLang: string | null;
	targetLang: string | null;
	pageCount: number;
	assetCount: number;
	flaggedAssetCount: number;
	csamBlockCount: number;
	adminFlagged: boolean;
	adminFlaggedAt: string | null;
	adminFlaggedBy: string | null;
	adminFlagReason: string | null;
	adminHidden: boolean;
	adminHiddenAt: string | null;
	adminHiddenBy: string | null;
	adminHideReason: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface AdminContentPageSummary {
	projectId: string;
	pageId: string;
	pageIndex: number;
	imageId?: string;
	status: string;
	textLayerCount: number;
	imageLayerCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface AdminModerationQueueItem {
	source: "asset" | "csam_block";
	assetId: string | null;
	projectId: string | null;
	workspaceId: string | null;
	moderationStatus: string | null;
	moderationProvider: string | null;
	moderationReason: string | null;
	detail: Record<string, unknown>;
	occurredAt: string;
}

export interface AdminContentProjectDetail extends AdminContentProject {
	pages: AdminContentPageSummary[];
	flaggedAssets: AdminModerationQueueItem[];
}

export interface ListAdminContentProjectsOptions {
	search?: string;
	status?: "active" | "admin_hidden" | "all";
	flagged?: boolean;
	hidden?: boolean;
	cursor?: string;
	limit?: number;
}

export interface AdminContentProjectsPage {
	projects: AdminContentProject[];
	nextCursor: string | null;
}

export interface AdminModerationQueuePage {
	items: AdminModerationQueueItem[];
	nextCursor: string | null;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === "") continue;
		search.set(key, String(value));
	}
	const qs = search.toString();
	return qs ? `?${qs}` : "";
}

export const adminContentApi = {
	listProjects(options: ListAdminContentProjectsOptions = {}): Promise<AdminContentProjectsPage> {
		return adminFetch<AdminContentProjectsPage>(`/admin/content/projects${buildQuery({
			search: options.search,
			status: options.status,
			flagged: options.flagged,
			hidden: options.hidden,
			cursor: options.cursor,
			limit: options.limit,
		})}`);
	},

	getProject(projectId: string): Promise<{ project: AdminContentProjectDetail }> {
		return adminFetch<{ project: AdminContentProjectDetail }>(`/admin/content/projects/${encodeURIComponent(projectId)}`);
	},

	listModerationQueue(options: { source?: "asset" | "csam_block"; cursor?: string; limit?: number } = {}): Promise<AdminModerationQueuePage> {
		return adminFetch<AdminModerationQueuePage>(`/admin/content/moderation-queue${buildQuery({
			source: options.source,
			cursor: options.cursor,
			limit: options.limit,
		})}`);
	},

	flagProject(projectId: string, reason?: string): Promise<{ ok: boolean; project: AdminContentProject }> {
		return adminFetch(`/admin/content/projects/${encodeURIComponent(projectId)}/flag`, {
			method: "POST",
			body: JSON.stringify({ reason }),
		});
	},

	unflagProject(projectId: string, reason?: string): Promise<{ ok: boolean; project: AdminContentProject }> {
		return adminFetch(`/admin/content/projects/${encodeURIComponent(projectId)}/unflag`, {
			method: "POST",
			body: JSON.stringify({ reason }),
		});
	},

	hideProject(projectId: string, reason?: string): Promise<{ ok: boolean; project: AdminContentProject }> {
		return adminFetch(`/admin/content/projects/${encodeURIComponent(projectId)}/hide`, {
			method: "POST",
			body: JSON.stringify({ reason }),
		});
	},

	unhideProject(projectId: string, reason?: string): Promise<{ ok: boolean; project: AdminContentProject }> {
		return adminFetch(`/admin/content/projects/${encodeURIComponent(projectId)}/unhide`, {
			method: "POST",
			body: JSON.stringify({ reason }),
		});
	},
};
