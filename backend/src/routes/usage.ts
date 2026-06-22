import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { v4 as uuid } from "uuid";
import { z } from "zod/v4";
import { getAuthUser, optionalAuth } from "../middleware/auth.middleware.js";
import { usageQuotaRejections } from "../middleware/metrics.js";
import {
	isValidUsageEventCursor,
	listProjectUsageEventPage,
	UsageQuotaExceededError,
	UsageIdempotencyKindMismatchError,
	recordExportUsage,
	summarizeWorkspaceUsage,
	type UsageEventKind,
} from "../services/usage-ledger.js";
import { buildBillingCatalog, resolveWorkspacePlan } from "../services/plans.js";
import { buildWorkspaceUsageDashboard } from "../services/usage-dashboard.js";
import { readJsonBody } from "../utils/request-body.js";
import { roleHasPermission, WorkspaceAccessError, workspaceAccessStore, type WorkspaceScope } from "../services/workspace-access.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import type { JWTPayload } from "../types/auth.js";
import type { ExportProfileId, ProjectState } from "../types/index.js";
import { isValidProjectId } from "../utils/security.js";
import { resolveProjectState } from "../utils/project-state-file.js";

const usage = new Hono();
usage.use("*", optionalAuth);

const MAX_EXPORT_RECORD_BYTES = 50 * 1024 * 1024 * 1024;
const USAGE_EVENT_KINDS = new Set<UsageEventKind>([
	"ai_credit_reserved",
	"ai_credit_captured",
	"ai_credit_released",
	"upload_bytes_recorded",
	"export_bytes_recorded",
	"moderation_image_checked",
]);

const exportUsageSchema = z.object({
	bytes: z.number().int().min(1).max(MAX_EXPORT_RECORD_BYTES),
	pageIndexes: z.array(z.number().int().min(0)).max(1000).optional(),
	pageCount: z.number().int().min(1).max(1000).optional(),
	filename: z.string().trim().min(1).max(260).optional(),
	exportKind: z.enum(["single-page", "batch-zip"]).optional(),
	targetProfile: z.enum(["draft-internal", "public-export"]).optional(),
	idempotencyKey: z.string().trim().min(1).max(300).optional(),
	// The export run this record bills for. When the run has a server-owned
	// artifact we bill its real size (authoritative); otherwise we fall back to a
	// per-page ceiling. Lets accounting be run/artifact-scoped instead of clamping
	// every export to the LARGEST artifact across the whole project.
	exportRunId: z.string().trim().min(1).max(200).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

function exportUsageMetadata(metadata: Record<string, unknown> | undefined, targetProfile: ExportProfileId | undefined): Record<string, unknown> | undefined {
	return targetProfile ? { ...metadata, targetProfile } : metadata;
}

function isPositiveByteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// SECURITY (forgeable export bytes): the export-usage record route used to bill
// the workspace for whatever `bytes` the client JSON claimed. A caller could
// forge an arbitrarily large value (up to the 50 GiB schema cap) to burn a
// victim workspace's daily/monthly export-bytes quota — quota theft / DoS.
//
// The authoritative size of an export is the SERVER-owned artifact the export
// pipeline produced and stored (`state.exportRuns[].artifact.sizeBytes`). We make
// accounting RUN/ARTIFACT-scoped instead of clamping every export to the largest
// artifact anywhere in the project:
//   - When the caller names the export run it is billing for (`exportRunId`) and
//     that run has a server-owned artifact, bill that run's REAL artifact size.
//     The previous code clamped to MAX(all artifacts), which UNDERCOUNTED a new,
//     larger export: the client meters BEFORE uploading the new artifact, so a
//     fresh 20 MiB ZIP recorded right after an old 4 KiB artifact billed only
//     4 KiB. Run-scoping fixes that — a new run with no artifact yet is NOT
//     clamped down to some other run's old (smaller) artifact.
//   - Otherwise (no artifact persisted for this run yet — the normal client-ZIP
//     path, which meters before upload) we cannot yet verify against a stored
//     object, so we refuse to trust an unbounded client number and clamp to a
//     conservative per-page ceiling. CRUCIALLY the per-page count used for that
//     ceiling is NOT the client-claimed `pageCount` (forgeable): a member could
//     POST `pageCount=1000` to push the ceiling to ~64 GiB and then record up to
//     the 50 GiB schema cap with no real artifact. We bound the page count to the
//     project's REAL page count (`state.pages.length`) so the ceiling can never be
//     inflated past what the project actually contains. A forged value can't exceed
//     what the project's real pages could plausibly weigh, while a real (possibly
//     large) new export is billed for its honestly-reported size.
const MAX_SERVERLESS_EXPORT_BYTES_PER_PAGE = 64 * 1024 * 1024; // 64 MiB/page ceiling for unverifiable client-side exports
const MAX_SERVERLESS_EXPORT_BYTES_FLOOR = 256 * 1024 * 1024; // never below 256 MiB even for a single page

function resolveBillableExportBytes(
	state: ProjectState,
	claimedBytes: number,
	pageCount: number | undefined,
	exportRunId: string | undefined,
): number {
	// Run-scoped: if the caller names a run that already has a server-owned,
	// persisted artifact, bill that run's REAL artifact size — authoritative and not
	// coupled to any other run's (possibly smaller/older) artifact. This is the only
	// path that can record large amounts, and it is fully server-verified.
	if (exportRunId) {
		const run = (state.exportRuns ?? []).find((item) => item.id === exportRunId);
		const runArtifactBytes = run?.artifact?.sizeBytes;
		if (isPositiveByteCount(runArtifactBytes)) {
			// The artifact size is server-owned + persisted, so it is authoritative:
			// bill it verbatim, IGNORING the client-claimed `bytes`. Using
			// min(claimed, artifact) would let a client UNDER-bill (POST bytes=1 against
			// a 4 KiB artifact records 1); over-claiming is already moot since we bill
			// the real artifact, not the claim.
			return runArtifactBytes;
		}
	}
	// No verifiable artifact for THIS run yet (forged/unknown run id, or the normal
	// client-ZIP path that meters before upload) → clamp to a conservative per-page
	// ceiling. The ceiling's page count is bounded by the project's REAL pages so a
	// forged `pageCount` can never inflate the cap. We intentionally do NOT clamp to
	// other runs' artifacts: that caused the new-larger-export undercount.
	const realPages = Array.isArray(state.pages) ? state.pages.length : 0;
	const claimedPages = isPositiveByteCount(pageCount) ? Math.floor(pageCount) : 1;
	// A single-page export can legitimately have a claimed count <= 1; the floor
	// already covers it. Never let the claim exceed the project's real page count.
	const billablePages = realPages > 0 ? Math.min(claimedPages, realPages) : 1;
	const ceiling = Math.max(MAX_SERVERLESS_EXPORT_BYTES_FLOOR, billablePages * MAX_SERVERLESS_EXPORT_BYTES_PER_PAGE);
	return Math.min(claimedBytes, ceiling);
}

// Authorize a usage read/record against a project.
//
// SECURITY: a workspace project (has `workspaceId`, typically no per-user
// `userId`) must NOT be treated as "open" just because `state.userId` is unset.
// Doing so let ANY authenticated user read AND record usage (incl. billable
// export bytes) for a workspace they are not a member of — a cross-tenant IDOR.
// For workspace projects we now require the caller to hold the requested
// project permission via `projectCatalogStore.canAccessProject` (the same check
// the rest of the project routes use), and 404 (non-leaking) otherwise.
async function checkProjectAccess(
	c: Context,
	projectId: string,
	permission: "read:project" | "export:project",
): Promise<{ state: ProjectState } | Response> {
	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}

	// Catalog-authoritative, tombstone-aware read: under Postgres the catalog row
	// wins; a permanently-deleted project must not re-enable usage recording/queries
	// even if a stale state.json survived a partial delete.
	const state = await resolveProjectState(projectId);
	if (!state) {
		return c.json({ error: "Project not found" }, 404);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	const workspaceId = state.workspaceId?.trim();

	// Workspace project: gate on real workspace membership / project permission.
	// This is the IDOR fix — a workspace project has a `workspaceId` and usually no
	// per-user `userId`, so the old `state.userId`-only check let ANY authenticated
	// user read/record usage for it.
	if (workspaceId) {
		if (!user) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		if (projectCatalogStore && await projectCatalogStore.canAccessProject({ projectId, userId: user.userId, permission })) {
			return { state };
		}
		return c.json({ error: "Project not found" }, 404);
	}

	// Personal / legacy-anonymous project (no workspaceId): unchanged prototype
	// behaviour — owner-scoped projects require the owner; an ownerless project is
	// open (the pre-auth prototype path the anonymous editor still relies on).
	if (!user) {
		return state.userId ? c.json({ error: "Unauthorized" }, 401) : { state };
	}
	return state.userId && state.userId !== user.userId ? c.json({ error: "Project not found" }, 404) : { state };
}

function hasInvalidPageIndex(state: ProjectState, pageIndexes: number[] | undefined): boolean {
	return Boolean(pageIndexes?.some((pageIndex) => pageIndex >= state.pages.length));
}

// A reported export page count must not exceed the project's REAL page count. A
// forged over-count (e.g. pageCount=1000 against a 1-page project) is the lever
// that inflated the per-page billing ceiling; reject it outright.
function hasInvalidPageCount(state: ProjectState, pageCount: number | undefined): boolean {
	if (pageCount === undefined) return false;
	const realPages = Array.isArray(state.pages) ? state.pages.length : 0;
	return pageCount > realPages;
}

function parseUsageEventLimit(raw: string | undefined): number | undefined | null {
	if (raw === undefined) return undefined;
	if (!/^[1-9]\d*$/.test(raw.trim())) return null;
	return Math.min(Number(raw), 500);
}

usage.get("/plans/catalog", (c) => {
	const catalog = buildBillingCatalog();
	// currentPlan = resolveWorkspacePlan() reads the GLOBAL WORKSPACE_PLAN_ID env (billing is
	// single-plan/stubbed), and the catalog is static — no per-caller data, so it's shareable.
	c.header("Cache-Control", "public, max-age=300");
	return c.json({
		currentPlan: resolveWorkspacePlan(),
		plans: catalog.plans,
		addons: catalog.addons,
		billing: {
			status: catalog.status,
			currency: catalog.currency,
			message: "Billing checkout is intentionally stubbed while backend usage, auth, and storage foundations are hardened.",
		},
	});
});

function isValidWorkspaceId(workspaceId: string): boolean {
	return /^[\w-]{1,200}$/.test(workspaceId);
}

// Workspace-level usage dashboard: aggregates usage/storage/egress across all
// projects in a workspace. Read-only and scoped to workspace membership.
usage.get("/workspace/:workspaceId/dashboard", async (c) => {
	const workspaceId = c.req.param("workspaceId").trim();
	if (!isValidWorkspaceId(workspaceId)) {
		return c.json({ error: "Invalid workspace ID format", code: "invalid_workspace_id" }, 400);
	}

	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	if (!workspaceAccessStore) {
		return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	}

	let canManageMembers = false;
	let actorScope: WorkspaceScope | undefined;
	try {
		// Enforce membership before exposing any aggregated workspace data.
		const member = await workspaceAccessStore.requirePermission(workspaceId, user.userId, "read_workspace");
		// The member roster is only exposed to callers who can manage members,
		// matching the dedicated `/workspaces/:workspaceId/members` route. Plain
		// read_workspace viewers/editors must not see the roster.
		canManageMembers = roleHasPermission(member.role, "manage_members");
		// Preserve the actor's scope so the roster is filtered to members covered
		// by it, exactly as `/workspaces/:workspaceId/members` does. A scoped
		// admin/owner must not see members outside their scope.
		actorScope = member.scope;
	} catch (error) {
		if (error instanceof WorkspaceAccessError) {
			return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
		}
		throw error;
	}

	const dashboard = await buildWorkspaceUsageDashboard(workspaceId, user.userId, Date.now(), {
		includeMembers: canManageMembers,
		actorScope,
	});
	return c.json({ dashboard });
});

usage.get("/:projectId/events", async (c) => {
	const projectId = c.req.param("projectId");
	const access = await checkProjectAccess(c, projectId, "read:project");
	if (access instanceof Response) return access;

	const limit = parseUsageEventLimit(c.req.query("limit"));
	if (limit === null) return c.json({ error: "Invalid limit", code: "invalid_limit" }, 400);
	const cursor = c.req.query("cursor");
	if (!isValidUsageEventCursor(cursor)) return c.json({ error: "Invalid cursor", code: "invalid_cursor" }, 400);
	const kind = c.req.query("kind");
	if (kind && !USAGE_EVENT_KINDS.has(kind as UsageEventKind)) {
		return c.json({ error: "Invalid usage event kind", code: "invalid_usage_event_kind" }, 400);
	}
	const subjectId = c.req.query("subjectId")?.trim();
	if (subjectId && subjectId.length > 300) {
		return c.json({ error: "Invalid subjectId", code: "invalid_subject_id" }, 400);
	}
	const actorUserId = c.req.query("actorUserId")?.trim();
	if (actorUserId && actorUserId.length > 200) {
		return c.json({ error: "Invalid actorUserId", code: "invalid_actor_user_id" }, 400);
	}

	const page = await listProjectUsageEventPage(projectId, {
		limit: limit ?? undefined,
		cursor,
		kind: kind as UsageEventKind | undefined,
		subjectId: subjectId || undefined,
		actorUserId: actorUserId || undefined,
	});
	return c.json(page);
});

usage.get("/:projectId", async (c) => {
	const projectId = c.req.param("projectId");
	const access = await checkProjectAccess(c, projectId, "read:project");
	if (access instanceof Response) return access;
	return c.json({ usage: await summarizeWorkspaceUsage(projectId) });
});

usage.post("/:projectId/export", async (c) => {
	const projectId = c.req.param("projectId");
	const access = await checkProjectAccess(c, projectId, "export:project");
	if (access instanceof Response) return access;
	// Export is FREE (product decision 2026-06-13): no usage metered, no quota
	// enforced. Access is still verified above and the export PIPELINE keeps its
	// freeze gate; this endpoint just records nothing. Returns a success no-op so
	// the frontend meter callers treat the run as settled and stop retrying.
	return c.json({ ok: true, recorded: false, free: true });
});

export { usage };
