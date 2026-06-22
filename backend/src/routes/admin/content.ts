// Back-office CONTENT sub-router (ranks 17-18).
//
// Mounted at /api/admin/content by backend/src/routes/admin.ts. The parent admin
// router already applies authMiddleware + requirePermission(ACCESS) on every path,
// so requests that reach here are authenticated platform admins.
//
// Authorization model:
//   * Baseline gate: CONTENT_READ — every route in this domain requires it. The
//     cross-tenant project browser + detail + moderation queue are READ-ONLY and
//     allowed for any role holding admin:content.read (owner/admin/support).
//   * Mutations (flag/unflag, hide/unhide) layer requirePermission(CONTENT_MODERATE)
//     on top, so support (read-only content) cannot moderate while owner/admin can.
//
// Cross-tenant: the data layer (project-catalog AdminContentStore) deliberately
// applies NO per-member workspace scope — this surface is the platform admin's
// god-view. The permission gate here is therefore the SOLE authorization. We never
// expose raw asset bytes; only metadata + moderation verdicts.
//
// Every mutation is AUDITED (actor, target, action, detail) via gdpr.recordAdminAudit
// so an external review can reconstruct who hid/flagged what and why.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod/v4";
import { requirePermission } from "../../middleware/auth.middleware.js";
import { ADMIN_PERMISSIONS } from "../../types/auth.js";
import type { JWTPayload } from "../../types/auth.js";
import { readJsonBody } from "../../utils/request-body.js";
import {
	adminContentStore as defaultAdminContentStore,
	InvalidAdminContentCursorError,
	type AdminContentStore,
} from "../../services/project-catalog.js";
import {
	getAssetRecordAuthoritative,
	storageStatusForModerationStatus,
	updateAssetModerationAuthoritative,
} from "../../services/assets.js";
import type { AssetModerationResult } from "../../types/index.js";
import { gdprStore as defaultGdprStore } from "../../services/gdpr.js";
import type { GdprStore } from "../../services/gdpr.js";
import type { AdminRouterDeps } from "../admin.js";

const listProjectsQuerySchema = z.object({
	search: z.string().trim().max(200).optional(),
	status: z.enum(["active", "admin_hidden", "all"]).optional(),
	flagged: z.boolean().optional(),
	hidden: z.boolean().optional(),
	cursor: z.string().trim().max(512).optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

const moderationQueueQuerySchema = z.object({
	source: z.enum(["asset", "csam_block"]).optional(),
	cursor: z.string().trim().max(512).optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

const flagBodySchema = z.object({
	reason: z.string().trim().max(2000).optional(),
}).strict();

const hideBodySchema = z.object({
	reason: z.string().trim().max(2000).optional(),
}).strict();

const assetModerationBodySchema = z.object({
	reason: z.string().trim().max(2000).optional(),
}).strict();

function parseBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return undefined;
}

function requireAdminUser(c: Context): JWTPayload {
	const user = c.get("user") as JWTPayload | undefined;
	if (!user) throw new Error("auth_required");
	return user;
}

export function createAdminContentRouter(deps: AdminRouterDeps & { contentStore?: AdminContentStore } = {}): Hono {
	const router = new Hono();
	const store = deps.contentStore ?? defaultAdminContentStore;
	const gdpr: GdprStore = deps.gdpr ?? defaultGdprStore;

	// Baseline READ gate for the whole content surface. Mutations layer
	// CONTENT_MODERATE on top per-route below.
	router.use("*", requirePermission(ADMIN_PERMISSIONS.CONTENT_READ));

	// ── Cross-tenant project browser (READ-ONLY) ──────────────────
	router.get("/projects", async (c) => {
		const parsed = listProjectsQuerySchema.safeParse({
			search: c.req.query("search"),
			status: c.req.query("status"),
			flagged: parseBool(c.req.query("flagged")),
			hidden: parseBool(c.req.query("hidden")),
			cursor: c.req.query("cursor"),
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		try {
			const page = await store.listProjects(parsed.data);
			return c.json({ projects: page.projects, nextCursor: page.nextCursor ?? null });
		} catch (error) {
			if (error instanceof InvalidAdminContentCursorError) {
				return c.json({ error: error.message, code: "invalid_cursor" }, 400);
			}
			throw error;
		}
	});

	router.get("/projects/:id", async (c) => {
		const id = c.req.param("id") ?? "";
		const detail = await store.getProject(id);
		if (!detail) return c.json({ error: "Project not found", code: "project_not_found" }, 404);
		return c.json({ project: detail });
	});

	// ── Moderation queue (READ-ONLY) ──────────────────────────────
	router.get("/moderation-queue", async (c) => {
		const parsed = moderationQueueQuerySchema.safeParse({
			source: c.req.query("source"),
			cursor: c.req.query("cursor"),
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
		});
		if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		try {
			const page = await store.listModerationQueue(parsed.data);
			return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
		} catch (error) {
			if (error instanceof InvalidAdminContentCursorError) {
				return c.json({ error: error.message, code: "invalid_cursor" }, 400);
			}
			throw error;
		}
	});

	// ── Audited moderation mutations (CONTENT_MODERATE) ───────────
	router.post("/projects/:id/flag", requirePermission(ADMIN_PERMISSIONS.CONTENT_MODERATE), async (c) => {
		return applyFlag(c, store, gdpr, true);
	});

	router.post("/projects/:id/unflag", requirePermission(ADMIN_PERMISSIONS.CONTENT_MODERATE), async (c) => {
		return applyFlag(c, store, gdpr, false);
	});

	router.post("/projects/:id/hide", requirePermission(ADMIN_PERMISSIONS.CONTENT_MODERATE), async (c) => {
		return applyHide(c, store, gdpr, true);
	});

	router.post("/projects/:id/unhide", requirePermission(ADMIN_PERMISSIONS.CONTENT_MODERATE), async (c) => {
		return applyHide(c, store, gdpr, false);
	});

	// ── Asset-level moderation transitions (review / appeal) ──────
	//
	// A `needs_review` asset can DISPLAY but never AI/export (those require
	// `passed`). Before this surface there was no way for an admin to resolve such
	// an asset either way. These audited endpoints let CONTENT_MODERATE admins:
	//   * approve → moderation_status `passed`, storage released  (clears the gate)
	//   * block   → moderation_status `blocked`, storage quarantined (fail-closed)
	// Both reuse updateAssetModerationAuthoritative so the durable asset_records row
	// (and its JSON mirror) move together, in file and Postgres modes.
	router.post("/assets/:projectId/:imageId/approve", requirePermission(ADMIN_PERMISSIONS.CONTENT_MODERATE), async (c) => {
		return applyAssetModeration(c, gdpr, "passed");
	});

	router.post("/assets/:projectId/:imageId/block", requirePermission(ADMIN_PERMISSIONS.CONTENT_MODERATE), async (c) => {
		return applyAssetModeration(c, gdpr, "blocked");
	});

	return router;
}

async function applyAssetModeration(
	c: Context,
	gdpr: GdprStore,
	target: "passed" | "blocked",
): Promise<Response> {
	const admin = requireAdminUser(c);
	const projectId = (c.req.param("projectId") ?? "").trim();
	const imageId = (c.req.param("imageId") ?? "").trim();
	if (!projectId || !imageId) return c.json({ error: "Missing project or image id", code: "invalid_target" }, 400);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = assetModerationBodySchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	const existing = await getAssetRecordAuthoritative(projectId, imageId);
	if (!existing) return c.json({ error: "Asset not found", code: "asset_not_found" }, 404);

	// APPROVE is ONLY a release path for a soft `needs_review` asset. A `blocked`
	// asset is mandatory/legal-weight (CSAM/extreme or a denylist hit) and MUST NOT
	// be releasable through this normal admin flow — that would be a direct,
	// audited release of mandatory-blocked content. Reject it with 409. A legal
	// appeal, if ever built, is a separate higher-trust flow that also clears the
	// denylist record; it is intentionally out of scope here.
	if (target === "passed" && existing.moderation?.status === "blocked") {
		return c.json({
			error: "A blocked asset cannot be approved through this flow",
			code: "asset_blocked_not_approvable",
		}, 409);
	}

	const reason = parsed.data.reason
		?? (target === "passed" ? "Approved by admin review" : "Blocked by admin review");
	const moderation: AssetModerationResult = {
		status: target,
		provider: "admin-review",
		checkedAt: new Date().toISOString(),
		reason,
		categories: existing.moderation?.categories,
		rulesetVersion: existing.moderation?.rulesetVersion,
	};
	// storageStatusForModerationStatus is the SAME allow-list the upload path uses:
	// only passed/needs_review release; anything else (here, blocked) quarantines.
	const storageStatus = storageStatusForModerationStatus(target);
	const updated = await updateAssetModerationAuthoritative(projectId, imageId, moderation, storageStatus);
	if (!updated) return c.json({ error: "Asset not found", code: "asset_not_found" }, 404);

	await gdpr.recordAdminAudit({
		adminUserId: admin.userId,
		action: target === "passed" ? "admin.content.asset.approve" : "admin.content.asset.block",
		targetKind: "asset",
		targetId: `${projectId}/${imageId}`,
		detail: {
			projectId,
			imageId,
			fromStatus: existing.moderation?.status,
			toStatus: target,
			reason,
		},
	});

	return c.json({
		ok: true,
		asset: {
			projectId,
			imageId,
			moderationStatus: updated.moderation.status,
			storageStatus: updated.storageStatus,
		},
	});
}

async function applyFlag(c: Context, store: AdminContentStore, gdpr: GdprStore, flagged: boolean): Promise<Response> {
	const admin = requireAdminUser(c);
	const id = c.req.param("id") ?? "";
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = flagBodySchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	const row = await store.setProjectFlag({ projectId: id, adminUserId: admin.userId, flagged, reason: parsed.data.reason ?? null });
	if (!row) return c.json({ error: "Project not found", code: "project_not_found" }, 404);
	await gdpr.recordAdminAudit({
		adminUserId: admin.userId,
		action: flagged ? "admin.content.flag" : "admin.content.unflag",
		targetKind: "project",
		targetId: id,
		detail: { workspaceId: row.workspaceId, reason: parsed.data.reason ?? null },
	});
	return c.json({ ok: true, project: row });
}

async function applyHide(c: Context, store: AdminContentStore, gdpr: GdprStore, hidden: boolean): Promise<Response> {
	const admin = requireAdminUser(c);
	const id = c.req.param("id") ?? "";
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = hideBodySchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	const row = await store.setProjectHidden({ projectId: id, adminUserId: admin.userId, hidden, reason: parsed.data.reason ?? null });
	if (!row) return c.json({ error: "Project not found", code: "project_not_found" }, 404);
	await gdpr.recordAdminAudit({
		adminUserId: admin.userId,
		// Soft-hide / restore — never a hard delete of content.
		action: hidden ? "admin.content.hide" : "admin.content.unhide",
		targetKind: "project",
		targetId: id,
		detail: { workspaceId: row.workspaceId, reason: parsed.data.reason ?? null },
	});
	return c.json({ ok: true, project: row });
}
