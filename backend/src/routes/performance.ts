import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import {
	WorkspaceAccessError,
	roleHasPermission,
	workspaceAccessStore as defaultWorkspaceAccessStore,
	type WorkspaceAccessStore,
	type WorkspaceMemberRecord,
	type WorkspaceStudioRole,
} from "../services/workspace-access.js";
import {
	projectCatalogStore as defaultProjectCatalogStore,
	type ProjectCatalogStore,
} from "../services/project-catalog.js";
import {
	getMemberPerformance,
	getRoiWithWindow,
	getWorkspaceAggregate,
	isKnownPerfRole,
	isKnownWorkEventType,
	performanceMetricsStore as defaultPerformanceMetricsStore,
	recordWorkEvent,
	type PerformanceMetricsStore,
	type PerfRole,
	type PerfWorkEventType,
} from "../services/performance-intelligence.js";

const performance = new Hono();

// Injectable stores so route-level authz/visibility can be tested without a
// live Postgres (the module-level workspace store is null without DATABASE_URL).
let workspaceAccessStore: WorkspaceAccessStore | null = defaultWorkspaceAccessStore;
let metricsStore: PerformanceMetricsStore = defaultPerformanceMetricsStore;
let projectCatalogStore: ProjectCatalogStore | null = defaultProjectCatalogStore;

export function setPerfRoutesStoresForTests(stores: {
	workspaceAccessStore?: WorkspaceAccessStore | null;
	metricsStore?: PerformanceMetricsStore;
	projectCatalogStore?: ProjectCatalogStore | null;
}): () => void {
	const previousWorkspace = workspaceAccessStore;
	const previousMetrics = metricsStore;
	const previousCatalog = projectCatalogStore;
	if (stores.workspaceAccessStore !== undefined) workspaceAccessStore = stores.workspaceAccessStore;
	if (stores.metricsStore !== undefined) metricsStore = stores.metricsStore;
	if (stores.projectCatalogStore !== undefined) projectCatalogStore = stores.projectCatalogStore;
	return () => {
		workspaceAccessStore = previousWorkspace;
		metricsStore = previousMetrics;
		projectCatalogStore = previousCatalog;
	};
}

// ── Subject-role provenance ────────────────────────────────────────────────────
// A self-reported `role` is the single biggest inflation lever: a task-scoped
// cleaner could otherwise attribute high-value "translator" events to themselves.
// So when the SUBJECT is fine-grained-scoped to specific task types, the recorded
// role must map into one of their assigned task types (or match an explicit
// studio role) — never a client-chosen label. We deliberately do NOT tighten the
// UNSCOPED case: a member with no `scope.taskTypes` restriction (an ordinary
// editor/owner/admin who does all production work) keeps reporting any production
// role exactly as before, so legit flows are preserved. Privileged studio roles
// (owner/admin/team_lead) coordinate every task type and always pass.

// The workflow task type (used in `scope.taskTypes`) that a PerfRole maps to.
const PERF_ROLE_TO_TASK_TYPE: Record<PerfRole, string> = {
	translator: "translate",
	cleaner: "clean",
	typesetter: "typeset",
	qc: "review",
	reviewer: "review",
};

// The PerfRole a production studio role is natively allowed to report.
const STUDIO_ROLE_TO_PERF_ROLE: Partial<Record<WorkspaceStudioRole, PerfRole>> = {
	translator: "translator",
	cleaner: "cleaner",
	typesetter: "typesetter",
	qc: "qc",
};

const PRIVILEGED_STUDIO_ROLES: ReadonlySet<WorkspaceStudioRole> = new Set<WorkspaceStudioRole>([
	"owner",
	"admin",
	"team_lead",
]);

// True when `subject` is genuinely allowed to be attributed a `role` event.
//   - Privileged studio role (owner/admin/team_lead) → any role.
//   - Task-type-scoped subject → the role must map into their assigned task types
//     (or match their explicit production studio role).
//   - Otherwise UNSCOPED (no taskTypes restriction) → any production role, as
//     before (an ordinary editor/owner does the whole pipeline).
function subjectMayReportRole(subject: WorkspaceMemberRecord, role: PerfRole): boolean {
	const studioRole = subject.memberStudioRole;
	if (studioRole && PRIVILEGED_STUDIO_ROLES.has(studioRole)) return true;
	const taskTypes = subject.scope?.taskTypes;
	const isTaskScoped = Array.isArray(taskTypes) && taskTypes.length > 0;
	if (!isTaskScoped) return true;
	if (studioRole && STUDIO_ROLE_TO_PERF_ROLE[studioRole] === role) return true;
	return taskTypes.includes(PERF_ROLE_TO_TASK_TYPE[role]);
}

// All performance routes require an authenticated user AND a configured
// workspace access store — individual performance data is never exposed without
// membership verification, so a missing store fails closed (503).
performance.use("*", authMiddleware);

function requireWorkspaceStore(c: Context) {
	if (!workspaceAccessStore) {
		return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	}
	return workspaceAccessStore;
}

function isValidWorkspaceId(workspaceId: string): boolean {
	return /^[\w-]{1,200}$/.test(workspaceId);
}

function isValidUserId(userId: string): boolean {
	return /^[\w.@-]{1,200}$/.test(userId);
}

// Metadata is a strict ALLOWLIST of already-derived numeric fields. Arbitrary
// nested values are rejected so raw click/keystroke/surveilled-timer traces can
// never be smuggled in under a known event type, preserving the feature's
// no-raw-telemetry guarantee. Each field is bounded; unknown keys are stripped.
const metadataSchema = z.object({
	// Already-derived handoff latency in ms (lock_handoff smoothness). Capped at 7d.
	handoffLatencyMs: z.number().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
	// Derived post-accept edit distance ratio (0-1) for AI-leverage analytics.
	editDistanceRatio: z.number().min(0).max(1).optional(),
}).strict();

const eventSchema = z.object({
	workspaceId: z.string().trim().min(1).max(200),
	projectId: z.string().trim().min(1).max(200).optional(),
	role: z.string().trim().min(1).max(64),
	eventType: z.string().trim().min(1).max(64),
	// Subject defaults to the authenticated caller; a lead/admin may record an
	// event on behalf of another member they manage.
	userId: z.string().trim().min(1).max(200).optional(),
	// Optional caller-supplied idempotency/domain-event key. Reusing the same id
	// on an HTTP retry is a no-op (deduped by the store) instead of double-counting.
	eventId: z.string().trim().min(1).max(200).optional(),
	complexityWeight: z.number().min(0).max(1000).optional(),
	durationMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
	metadata: metadataSchema.optional(),
}).strict();

function parsePeriodWeeks(raw: string | undefined): number | null {
	if (raw === undefined) return 4;
	if (!/^[1-9]\d*$/.test(raw.trim())) return null;
	const weeks = Number(raw);
	return weeks >= 1 && weeks <= 26 ? weeks : null;
}

// POST /api/perf/event — record a derived work event.
//
// PROVENANCE / AUTHZ: performance metrics are derived from meaningful production
// actions, NOT self-reported telemetry. To stop a low-privilege member from
// inflating their own scores/ROI, the write path requires `update_project` — the
// permission held by roles that actually do production work (editor/admin/owner).
// A plain `viewer` (read-only) is therefore rejected and cannot self-attribute
// events. Recording for ANOTHER user additionally requires `manage_members`
// (lead/admin), and that target must be a verified workspace member so a typo or
// non-member id can never create a phantom member in the relaxed no-FK schema.
// Idempotent: a retried request reusing `eventId` is deduped, never double-counted.
performance.post("/event", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = getAuthUser(c) as JWTPayload;

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
	}
	const parsed = eventSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const data = parsed.data;
	if (!isValidWorkspaceId(data.workspaceId)) {
		return c.json({ error: "Invalid workspace ID format", code: "invalid_workspace_id" }, 400);
	}
	if (data.userId !== undefined && !isValidUserId(data.userId)) {
		return c.json({ error: "Invalid user ID format", code: "invalid_user_id" }, 400);
	}
	if (data.eventId !== undefined && !isValidUserId(data.eventId)) {
		return c.json({ error: "Invalid event ID format", code: "invalid_event_id" }, 400);
	}
	if (!isKnownWorkEventType(data.eventType)) {
		return c.json({ error: "Unknown event type", code: "invalid_event_type" }, 400);
	}
	if (!isKnownPerfRole(data.role)) {
		return c.json({ error: "Unknown role", code: "invalid_role" }, 400);
	}

	const subjectUserId = data.userId ?? user.userId;

	try {
		// Require a production-write permission, not bare read_workspace, so
		// read-only viewers cannot self-report and inflate metrics.
		const actor = await store.requirePermission(data.workspaceId, user.userId, "update_project");
		// Resolve the SUBJECT the event is attributed to. For a self-report the actor
		// IS the subject; for an on-behalf report we look the subject up (and require
		// lead/admin authority + real membership).
		let subject: WorkspaceMemberRecord = actor;
		if (subjectUserId !== user.userId) {
			// Recording an event for someone else is a lead/admin action.
			if (!roleHasPermission(actor.role, "manage_members")) {
				return c.json({ error: "Forbidden: cannot record events for another member", code: "forbidden" }, 403);
			}
			// The subject must be a real workspace member; otherwise a typo/non-member
			// id would manufacture a phantom member in aggregates/ROI.
			const resolved = await store.getMember(data.workspaceId, subjectUserId);
			if (!resolved) {
				return c.json({ error: "Subject user is not a member of this workspace", code: "subject_not_member" }, 422);
			}
			subject = resolved;
		}

		// PROVENANCE: the recorded `role` must be one the SUBJECT is genuinely allowed
		// to perform (their studio role + assigned task types) — never a client-chosen
		// label. This stops a scoped contributor self-attributing high-value events
		// under a role they were never assigned. A lead recording on behalf is still
		// bound to what the SUBJECT may legitimately do.
		if (!subjectMayReportRole(subject, data.role as PerfRole)) {
			return c.json({ error: "Forbidden: role is outside the subject's assigned work", code: "perf_role_scope_denied" }, 403);
		}

		// PROJECT SCOPE: when the event is tied to a projectId we enforce TWO gates so a
		// member cannot bind another workspace's project into this workspace's analytics:
		//   1) WORKSPACE BINDING — resolve the project's REAL owning workspace and reject
		//      unless it is a workspace project whose workspaceId === data.workspaceId.
		//      getProjectWorkspacePlan returns null for a missing/personal (non-workspace)
		//      project, so a personal project or a cross-workspace project is rejected.
		//   2) PER-MEMBER SCOPE — the ACTOR must actually be able to access that project,
		//      so a scoped member cannot attribute metrics to any project in the workspace.
		// An unscoped owner/editor of the bound workspace passes both gates.
		if (data.projectId && projectCatalogStore) {
			const plan = await projectCatalogStore.getProjectWorkspacePlan(data.projectId);
			if (!plan || plan.workspaceId !== data.workspaceId) {
				return c.json({ error: "Forbidden: project does not belong to this workspace", code: "perf_project_workspace_mismatch" }, 403);
			}
			const canAccessProject = await projectCatalogStore.canAccessProject({
				projectId: data.projectId,
				userId: user.userId,
				permission: "update_project",
			});
			if (!canAccessProject) {
				return c.json({ error: "Forbidden: project is outside your assigned scope", code: "perf_project_scope_denied" }, 403);
			}
		}
	} catch (error) {
		return handleWorkspaceError(c, error);
	}

	const event = await recordWorkEvent({
		id: data.eventId,
		workspaceId: data.workspaceId,
		userId: subjectUserId,
		projectId: data.projectId,
		role: data.role as PerfRole,
		eventType: data.eventType as PerfWorkEventType,
		complexityWeight: data.complexityWeight ?? 1,
		durationMs: data.durationMs,
		metadata: data.metadata,
	}, metricsStore);
	return c.json({ ok: true, eventId: event.id });
});

// GET /api/perf/me — the caller's own performance profile + baselines + ROI.
performance.get("/me", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = getAuthUser(c) as JWTPayload;

	const workspaceId = c.req.query("workspaceId")?.trim() ?? "";
	if (!isValidWorkspaceId(workspaceId)) {
		return c.json({ error: "Invalid workspace ID format", code: "invalid_workspace_id" }, 400);
	}
	const periodWeeks = parsePeriodWeeks(c.req.query("periodWeeks"));
	if (periodWeeks === null) return c.json({ error: "Invalid periodWeeks", code: "invalid_period" }, 400);

	let includePlatform = false;
	try {
		await store.requirePermission(workspaceId, user.userId, "read_workspace");
		// Platform percentile is opt-in (anonymized) — only included when the
		// caller explicitly requests it for their own scores.
		includePlatform = c.req.query("includePlatform") === "true";
	} catch (error) {
		return handleWorkspaceError(c, error);
	}

	const result = await getMemberPerformance({
		workspaceId,
		userId: user.userId,
		periodWeeks,
		includePlatformPercentile: includePlatform,
		// No cross-workspace platform population is wired to the prototype store;
		// pass an empty anonymized population so the band is honest (no fake data).
		platformComposites: includePlatform ? [] : null,
	}, metricsStore);
	return c.json(result);
});

// GET /api/perf/member/:userId — another member's profile. Lead/admin only.
performance.get("/member/:userId", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = getAuthUser(c) as JWTPayload;

	const targetUserId = c.req.param("userId");
	if (!isValidUserId(targetUserId)) {
		return c.json({ error: "Invalid user ID format", code: "invalid_user_id" }, 400);
	}
	const workspaceId = c.req.query("workspaceId")?.trim() ?? "";
	if (!isValidWorkspaceId(workspaceId)) {
		return c.json({ error: "Invalid workspace ID format", code: "invalid_workspace_id" }, 400);
	}
	const periodWeeks = parsePeriodWeeks(c.req.query("periodWeeks"));
	if (periodWeeks === null) return c.json({ error: "Invalid periodWeeks", code: "invalid_period" }, 400);

	try {
		const member = await store.requirePermission(workspaceId, user.userId, "read_workspace");
		// Individual member scores are visible to self + lead/admin only.
		const isSelf = targetUserId === user.userId;
		if (!isSelf && !roleHasPermission(member.role, "manage_members")) {
			return c.json({ error: "Forbidden: member performance is visible to leads and admins only", code: "forbidden" }, 403);
		}
	} catch (error) {
		return handleWorkspaceError(c, error);
	}

	const result = await getMemberPerformance({ workspaceId, userId: targetUserId, periodWeeks }, metricsStore);
	return c.json(result);
});

// GET /api/perf/workspace — anonymized workspace aggregate. Visible to all members.
performance.get("/workspace", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = getAuthUser(c) as JWTPayload;

	const workspaceId = c.req.query("workspaceId")?.trim() ?? "";
	if (!isValidWorkspaceId(workspaceId)) {
		return c.json({ error: "Invalid workspace ID format", code: "invalid_workspace_id" }, 400);
	}
	const periodWeeks = parsePeriodWeeks(c.req.query("periodWeeks"));
	if (periodWeeks === null) return c.json({ error: "Invalid periodWeeks", code: "invalid_period" }, 400);

	try {
		await store.requirePermission(workspaceId, user.userId, "read_workspace");
	} catch (error) {
		return handleWorkspaceError(c, error);
	}

	const aggregate = await getWorkspaceAggregate({ workspaceId, periodWeeks }, metricsStore);
	return c.json({ aggregate });
});

// GET /api/perf/roi — ROI for self, or the whole workspace for leads/admins.
performance.get("/roi", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = getAuthUser(c) as JWTPayload;

	const workspaceId = c.req.query("workspaceId")?.trim() ?? "";
	if (!isValidWorkspaceId(workspaceId)) {
		return c.json({ error: "Invalid workspace ID format", code: "invalid_workspace_id" }, 400);
	}
	const periodWeeks = parsePeriodWeeks(c.req.query("periodWeeks"));
	if (periodWeeks === null) return c.json({ error: "Invalid periodWeeks", code: "invalid_period" }, 400);
	const scope = c.req.query("scope") === "workspace" ? "workspace" : "self";

	let canSeeWorkspace = false;
	try {
		const member = await store.requirePermission(workspaceId, user.userId, "read_workspace");
		canSeeWorkspace = roleHasPermission(member.role, "manage_members");
	} catch (error) {
		return handleWorkspaceError(c, error);
	}

	if (scope === "workspace" && !canSeeWorkspace) {
		return c.json({ error: "Forbidden: workspace ROI is visible to leads and admins only", code: "forbidden" }, 403);
	}

	const roiWindow = await getRoiWithWindow({
		workspaceId,
		userId: scope === "workspace" ? undefined : user.userId,
		periodWeeks,
	}, metricsStore);
	return c.json({ scope, ...roiWindow });
});

function handleWorkspaceError(c: Context, error: unknown): Response {
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
	}
	throw error;
}

export { performance };
