import { getSharedBunSql } from "../services/sql-pool.js";
import { Hono } from "hono";
import { z } from "zod/v4";
import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import { inferScopedTaskType, workspaceAccessStore, type WorkspaceMemberRecord } from "../services/workspace-access.js";
import { isPlatformAdmin, type JWTPayload } from "../types/auth.js";
import { readJsonBody } from "../utils/request-body.js";
import { workLockStore } from "../services/work-locks.js";
import { notify } from "../services/notification-dispatch.js";
import {
	PostgresWorkStateStore,
	resolveWorkspaceIdForWorkStateRecord,
	WorkStateConflictError,
	WorkStatePermissionError,
	WorkStateTransitionError,
	type WorkActorRole,
	type WorkStateValue,
	type WorkSubjectKind,
} from "../services/work-states.js";

const workStates = new Hono();

workStates.use("*", authMiddleware);

const transitionSchema = z.object({
	to_state: z.enum(["draft", "in_progress", "submitted", "in_qc", "approved", "released", "rejected"]),
	comment: z.string().trim().max(5000).optional(),
	assignee_user_id: z.string().trim().min(1).max(200).optional(),
	due_at: z.string().trim().datetime({ offset: true }).optional(),
	// Work-level role (separate from the workspace JWT role). The server
	// validates this against the authenticated workspace role before use.
	role: z.enum(["owner", "admin", "team_lead", "translator", "cleaner", "typesetter", "qc", "guest"]).optional(),
	force: z.boolean().optional(),
}).strict();

workStates.get("/:subjectKind/:subjectId", async (c) => {
	const store = getWorkStateStore();
	if (!store) return c.json({ error: "Work state store unavailable", code: "work_state_store_unavailable" }, 503);
	const user = getAuthUser(c) as JWTPayload;
	const subjectKind = c.req.param("subjectKind");
	if (!isSubjectKind(subjectKind)) return c.json({ error: "Invalid subject kind", code: "invalid_subject_kind" }, 400);
	const subjectId = c.req.param("subjectId");
	// State rows carry assignees/comments, so a read must be gated by project
	// access; this is read-only, so require read (not update) so workspace
	// viewers/guests aren't denied workflow metadata they can already see.
	const access = await resolveWorkStateSubjectAccess(subjectKind, subjectId, user, "read:project");
	if (!access.allowed) return c.json({ error: access.error, code: access.code }, access.status);
	const state = await store.getWorkState(subjectKind, subjectId);
	return c.json({ state });
});

workStates.get("/:subjectKind/:subjectId/history", async (c) => {
	const store = getWorkStateStore();
	if (!store) return c.json({ error: "Work state store unavailable", code: "work_state_store_unavailable" }, 503);
	const user = getAuthUser(c) as JWTPayload;
	const subjectKind = c.req.param("subjectKind");
	if (!isSubjectKind(subjectKind)) return c.json({ error: "Invalid subject kind", code: "invalid_subject_kind" }, 400);
	const subjectId = c.req.param("subjectId");
	// Same read-only access gate as the state read above: history exposes
	// who/when/why for every transition, which is workspace-scoped metadata
	// readable by anyone with read access to the project.
	const access = await resolveWorkStateSubjectAccess(subjectKind, subjectId, user, "read:project");
	if (!access.allowed) return c.json({ error: access.error, code: access.code }, access.status);
	const limitRaw = c.req.query("limit");
	const limit = limitRaw && /^[1-9]\d{0,3}$/.test(limitRaw) ? Number.parseInt(limitRaw, 10) : undefined;
	const transitions = await store.listTransitionHistory(subjectKind, subjectId, { limit });
	return c.json({ transitions });
});

workStates.post("/:subjectKind/:subjectId/transition", async (c) => {
	const store = getWorkStateStore();
	if (!store) return c.json({ error: "Work state store unavailable", code: "work_state_store_unavailable" }, 503);
	const user = getAuthUser(c) as JWTPayload;
	const subjectKind = c.req.param("subjectKind");
	if (!isSubjectKind(subjectKind)) return c.json({ error: "Invalid subject kind", code: "invalid_subject_kind" }, 400);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = transitionSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		const access = await resolveWorkStateSubjectAccess(subjectKind, c.req.param("subjectId"), user);
		if (!access.allowed) return c.json({ error: access.error, code: access.code }, access.status);
		const actorRole = resolveWorkActorRoleForRequest(user.role, parsed.data.role, access.member);
		if (!actorRole) return c.json({ error: "Forbidden: invalid workflow role for user", code: "work_role_not_allowed" }, 403);
		const canForce = parsed.data.force && (isPlatformAdmin(user.role) || access.member?.role === "owner" || access.member?.role === "admin");
		// Capture the assignee BEFORE the transition so we can tell a real
		// (re)assignment apart from a status-only transition that merely
		// carries the existing assignee forward.
		const previousAssigneeUserId = (await store.getWorkState(subjectKind, c.req.param("subjectId")))?.assigneeUserId;
		const state = await store.transitionWorkState({
			subjectKind,
			subjectId: c.req.param("subjectId"),
			toState: parsed.data.to_state as WorkStateValue,
			actorUserId: user.userId,
			actorRole,
			comment: parsed.data.comment,
			assigneeUserId: parsed.data.assignee_user_id,
			dueAt: parsed.data.due_at,
			// Force is only honored when the authenticated user has the
			// workspace-level admin role on their JWT. Even if the client
			// claims an "admin" work-role in the body, the JWT role gates
			// the force path so a non-admin user can't escalate just by
			// changing the request body.
			force: canForce,
		});
		// Notify the assignee ONLY on a real assignment change — i.e. this request
		// actually set/changed the assignee AND the resulting assignee differs from
		// the previous one (newly assigned or reassigned to a different user). A
		// status-only transition (no assignee_user_id in the body) just carries the
		// existing assignee forward and must NOT re-notify them, or they'd get a
		// false "work assigned" email on every later transition. Self-assigns are
		// excluded too. Routed through the central dispatcher so per-(type × channel)
		// prefs are honored; best-effort so a notification failure never fails the
		// transition.
		const nextAssigneeUserId = state.assigneeUserId;
		if (
			nextAssigneeUserId &&
			shouldNotifyAssignment({
				requestedAssigneeUserId: parsed.data.assignee_user_id,
				previousAssigneeUserId,
				nextAssigneeUserId,
				actorUserId: user.userId,
			})
		) {
			void notify({
				userId: nextAssigneeUserId,
				type: "work_assigned",
				// Baked English stays as the email-channel + legacy fallback; the in-app
				// row is localised in the VIEWER's locale via the metadata i18n keys
				// below (so a Thai assignee never reads English). The frontend resolves
				// `kind` through notifications.message.kind.* before interpolating.
				title: `You were assigned ${subjectKind} work`,
				body: `"${state.subjectId}" is now ${state.state} and assigned to you.`,
				workspaceId: access.workspaceId,
				linkUrl: access.projectId ? `/projects/${access.projectId}/work` : undefined,
				metadata: {
					subjectKind: state.subjectKind,
					subjectId: state.subjectId,
					state: state.state,
					titleKey: "notifications.message.workAssignedTitle",
					titleParams: { kind: state.subjectKind },
					bodyKey: "notifications.message.workAssignedBody",
					bodyParams: { subject: state.subjectId, state: state.state },
				},
			}).catch((error) => {
				console.warn(`[work-states] work_assigned notify failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
		return c.json({ state });
	} catch (error) {
		if (error instanceof WorkStatePermissionError) return c.json({ error: error.message, code: "work_state_permission_denied" }, 403);
		// Conflict subclass FIRST (it also satisfies `instanceof WorkStateTransitionError`):
		// the optimistic-CAS race is a retryable 409, not a permanent 400.
		if (error instanceof WorkStateConflictError) return c.json({ error: error.message, code: "work_state_conflict" }, 409);
		if (error instanceof WorkStateTransitionError) return c.json({ error: error.message, code: "invalid_work_state_transition" }, 400);
		// Anything else reaching here is an unexpected server/DB fault — Zod validation
		// already ran before the try. Return 500 (not a client 400) and DON'T leak the raw
		// message; log it server-side for diagnosis.
		console.error("[work-states] unexpected transition error:", error);
		return c.json({ error: "Failed to record the workflow change", code: "internal_error" }, 500);
	}
});

let cachedDatabaseUrl: string | undefined;
let cachedWorkStateStore: PostgresWorkStateStore | null | undefined;

function getWorkStateStore(): PostgresWorkStateStore | null {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		cachedDatabaseUrl = undefined;
		cachedWorkStateStore = null;
		return null;
	}
	if (cachedWorkStateStore && cachedDatabaseUrl === databaseUrl) return cachedWorkStateStore;
	cachedDatabaseUrl = databaseUrl;
	cachedWorkStateStore = new PostgresWorkStateStore(databaseUrl, {
		locks: workLockStore ?? undefined,
		workspaceIdFor: resolveWorkspaceIdForWorkStateRecord,
	});
	return cachedWorkStateStore;
}

type WorkStateAccessResult = {
	allowed: true;
	projectId?: string;
	workspaceId?: string;
	chapterId?: string;
	pageIndex?: number;
	member?: WorkspaceMemberRecord;
} | {
	allowed: false;
	status: 403 | 404 | 503;
	error: string;
	code: string;
};

interface WorkStateSubjectRow {
	project_id: string;
	workspace_id?: string | null;
	page_index?: number | null;
}

interface WorkStateAccessSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

let workStateAccessDatabaseUrl: string | undefined;
let workStateAccessClient: WorkStateAccessSqlClient | null = null;

async function resolveWorkStateSubjectAccess(
	subjectKind: WorkSubjectKind,
	subjectId: string,
	user: JWTPayload,
	// Reads (GET state/history) only need read access so workspace viewers/guests
	// can load workflow metadata; transitions require update access.
	permission: "read:project" | "update:project" = "update:project",
): Promise<WorkStateAccessResult> {
	const subject = await resolveWorkStateSubject(subjectKind, subjectId);
	if (!subject) return { allowed: false, status: 404, error: "Work state subject not found", code: "work_state_subject_not_found" };
	if (!subject.workspaceId) {
		const allowedRoles = permission === "read:project"
			? isPlatformAdmin(user.role) || user.role === "editor" || user.role === "viewer"
			: isPlatformAdmin(user.role) || user.role === "editor";
		return allowedRoles
			? { allowed: true, ...subject }
			: { allowed: false, status: 403, error: "Forbidden: update permission required", code: "work_state_permission_denied" };
	}
	if (!projectCatalogStore || !workspaceAccessStore) {
		return { allowed: false, status: 503, error: "Workspace access unavailable", code: "workspace_access_unavailable" };
	}
	// Resolve the member first so we can feed their scoped chapter/task context
	// into the access check. Without it, a member restricted to specific
	// chapterIds/taskTypes is rejected by isFineGrainedProjectWideAccess before
	// the workflow role gate ever runs, even for their own assigned work.
	const member = await workspaceAccessStore.getMember(subject.workspaceId, user.userId);
	if (!member) return { allowed: false, status: 404, error: "Work state subject not found", code: "work_state_subject_not_found" };
	const allowed = await projectCatalogStore.canAccessProject({
		projectId: subject.projectId,
		userId: user.userId,
		permission,
		// chapter == project in this model, so the subject's project id is also its
		// chapter id for chapterIds-scoped members.
		chapterId: subject.chapterId ?? subject.projectId,
		pageIndex: subject.pageIndex,
		taskType: inferScopedTaskType(member.scope),
		resourceKind: subjectKind === "page" ? "page" : "review",
	});
	if (!allowed) return { allowed: false, status: 404, error: "Work state subject not found", code: "work_state_subject_not_found" };
	return { allowed: true, ...subject, member };
}

async function resolveWorkStateSubject(subjectKind: WorkSubjectKind, subjectId: string): Promise<{ projectId: string; workspaceId?: string; chapterId?: string; pageIndex?: number } | null> {
	const client = getWorkStateAccessClient();
	if (client) {
		if (subjectKind === "page") {
			const rows = await client.unsafe<WorkStateSubjectRow>(`
				SELECT project_pages.project_id, projects.workspace_id, project_pages.page_index
				FROM project_pages
				INNER JOIN projects ON projects.project_id = project_pages.project_id
				WHERE project_pages.page_id = $1
					AND projects.deleted_at IS NULL
				LIMIT 1
			`, [subjectId]);
			const row = rows[0];
			if (row) return normalizeWorkStateSubjectRow(row);
		} else {
			const rows = await client.unsafe<WorkStateSubjectRow>(`
				SELECT project_id, workspace_id, NULL::integer AS page_index
				FROM projects
				WHERE project_id = $1
					AND deleted_at IS NULL
				LIMIT 1
			`, [subjectId]);
			const row = rows[0];
			if (row) return normalizeWorkStateSubjectRow(row);
		}
	}
	if (subjectKind === "chapter" && projectCatalogStore) {
		const state = await projectCatalogStore.getProjectState(subjectId);
		if (state) return { projectId: subjectId, workspaceId: state.workspaceId, chapterId: subjectId };
	}
	return null;
}

function normalizeWorkStateSubjectRow(row: WorkStateSubjectRow): { projectId: string; workspaceId?: string; chapterId?: string; pageIndex?: number } {
	return {
		projectId: row.project_id,
		workspaceId: row.workspace_id?.trim() || undefined,
		// chapter == project in this model.
		chapterId: row.project_id,
		pageIndex: typeof row.page_index === "number" ? row.page_index : undefined,
	};
}

function getWorkStateAccessClient(): WorkStateAccessSqlClient | null {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		workStateAccessDatabaseUrl = undefined;
		workStateAccessClient = null;
		return null;
	}
	if (workStateAccessClient && workStateAccessDatabaseUrl === databaseUrl) return workStateAccessClient;
	workStateAccessDatabaseUrl = databaseUrl;
	workStateAccessClient = getSharedBunSql(databaseUrl) as unknown as WorkStateAccessSqlClient;
	return workStateAccessClient;
}

export function resolveWorkActorRoleForRequest(jwtRole: JWTPayload["role"], requestedRole?: WorkActorRole, member?: WorkspaceMemberRecord): WorkActorRole | null {
	// Platform admin (owner is a strict superset) maps to the admin work-role.
	if (isPlatformAdmin(jwtRole)) return requestedRole ?? "admin";
	if (member) return resolveWorkActorRoleFromMember(member, requestedRole);
	if (jwtRole === "editor") {
		if (!requestedRole) return "translator";
		if (requestedRole === "translator" || requestedRole === "cleaner" || requestedRole === "typesetter") return requestedRole;
		return null;
	}
	if (jwtRole === "viewer") {
		if (!requestedRole || requestedRole === "guest") return "guest";
		return null;
	}
	return null;
}

function resolveWorkActorRoleFromMember(member: WorkspaceMemberRecord, requestedRole?: WorkActorRole): WorkActorRole | null {
	if (member.role === "owner") return requestedRole ?? "owner";
	if (member.role === "admin") return requestedRole ?? "admin";
	if (member.role === "viewer") return !requestedRole || requestedRole === "guest" ? "guest" : null;
	const role = requestedRole ?? defaultEditorWorkRole(member);
	if (!role || role === "owner" || role === "admin" || role === "guest") return null;
	return editorScopeAllowsWorkRole(member, role) ? role : null;
}

function defaultEditorWorkRole(member: WorkspaceMemberRecord): WorkActorRole {
	const taskTypes = member.scope.taskTypes ?? [];
	if (taskTypes.some(isQcTaskType)) return "qc";
	if (taskTypes.some(isTeamLeadTaskType)) return "team_lead";
	if (taskTypes.includes("clean")) return "cleaner";
	if (taskTypes.includes("typeset")) return "typesetter";
	return "translator";
}

function editorScopeAllowsWorkRole(member: WorkspaceMemberRecord, role: WorkActorRole): boolean {
	const taskTypes = member.scope.taskTypes ?? [];
	if (role === "translator") return taskTypes.length === 0 || taskTypes.some((task) => task === "translate" || task === "translation");
	if (role === "cleaner") return taskTypes.length === 0 || taskTypes.some((task) => task === "clean" || task === "cleaning");
	if (role === "typesetter") return taskTypes.length === 0 || taskTypes.some((task) => task === "typeset" || task === "typesetting");
	if (role === "qc") return taskTypes.some(isQcTaskType);
	if (role === "team_lead") return taskTypes.some(isTeamLeadTaskType);
	return false;
}

function isQcTaskType(taskType: string): boolean {
	return taskType === "qc" || taskType === "review" || taskType === "quality_control";
}

function isTeamLeadTaskType(taskType: string): boolean {
	return taskType === "team_lead" || taskType === "lead" || taskType === "manage";
}

/**
 * Decide whether a transition should fire a `work_assigned` notification to the
 * resulting assignee. Fires ONLY on a real assignment change so a user is never
 * spammed with a false "work assigned" email on later status-only transitions:
 *
 *   - `requestedAssigneeUserId` must be present in THIS request (a status-only
 *     transition that omits it just carries the prior assignee forward — no fire),
 *   - the resulting `nextAssigneeUserId` must differ from `previousAssigneeUserId`
 *     (newly assigned or reassigned to a different user; re-setting the same
 *     assignee does not fire), and
 *   - the new assignee must not be the actor (self-assign does not fire).
 */
export function shouldNotifyAssignment(params: {
	requestedAssigneeUserId?: string;
	previousAssigneeUserId?: string;
	nextAssigneeUserId?: string;
	actorUserId: string;
}): boolean {
	const { requestedAssigneeUserId, previousAssigneeUserId, nextAssigneeUserId, actorUserId } = params;
	if (!requestedAssigneeUserId) return false;
	if (!nextAssigneeUserId) return false;
	if (nextAssigneeUserId === previousAssigneeUserId) return false;
	if (nextAssigneeUserId === actorUserId) return false;
	return true;
}

function isSubjectKind(value: string): value is WorkSubjectKind {
	return value === "chapter" || value === "page";
}

export { workStates };
