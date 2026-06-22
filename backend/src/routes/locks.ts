import { getSharedBunSql } from "../services/sql-pool.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod/v4";
import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import { inferScopedTaskType, workspaceAccessStore } from "../services/workspace-access.js";
import { isPlatformAdmin, type JWTPayload } from "../types/auth.js";
import type { ProjectState } from "../types/index.js";
import { readJsonBody } from "../utils/request-body.js";
import {
	LockConflictError,
	LockNotFoundError,
	LockPermissionError,
	SameUserLockConflictError,
	workLockStore,
	type TakenOverHolder,
	type WorkLockScope,
} from "../services/work-locks.js";
import { notify } from "../services/notification-dispatch.js";
import { withProjectCrossReplicaLock } from "./project.js";

const locks = new Hono();

locks.use("*", authMiddleware);

const LOCK_SERVICE_RETRY_AFTER_SECONDS = 30;

const acquireSchema = z.object({
	scope: z.enum(["page", "object", "layer", "chapter"]),
	scope_id: z.string().trim().min(1).max(500),
	project_id: z.string().trim().min(1).max(200).optional(),
	chapter_id: z.string().trim().min(1).max(200).optional(),
	page_id: z.string().trim().min(1).max(200).optional(),
	workspace_id: z.string().trim().min(1).max(200).optional(),
	duration_min: z.number().int().min(1).max(60).optional(),
	// Per-tab/session identity so the same user's two tabs are told apart.
	client_id: z.string().trim().min(1).max(200).optional(),
	// Steal a lease held by THIS user's other tab (resolves a same-user-tab
	// conflict). Never overrides a different user's lock.
	takeover: z.boolean().optional(),
}).strict();

const forceReleaseSchema = z.object({
	reason: z.string().trim().min(1).max(200).optional(),
}).strict().optional();

const extendSchema = z.object({
	duration_min: z.number().int().min(1).max(60).optional(),
}).strict();

locks.post("/acquire", async (c) => {
	if (!workLockStore) return lockServiceUnavailableResponse(c, "work_lock_store_unavailable");
	const user = getAuthUser(c) as JWTPayload;
	if (!canMutateWorkLocks(user.role)) return c.json({ error: "Forbidden: edit permission required", code: "lock_edit_permission_required" }, 403);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = acquireSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		const subject = await resolveLockSubjectForAccess(parsed.data, user);
		if (!subject.allowed) return c.json({ error: subject.error, code: subject.code }, subject.status);
		// Key page locks on the canonical page id (project:page:n) whenever the
		// resolver produced one, so the same page addressed by its canonical id
		// and by imageId resolves to a single active lock. Without this, two users
		// could hold simultaneous `page` locks for one page via different ids and
		// defeat the one-editor-at-a-time guarantee. Object/layer locks keep their
		// own scope_id (subject.pageId is the parent page, not the lock subject).
		const lockKey = parsed.data.scope === "page" && subject.pageId ? subject.pageId : parsed.data.scope_id;
		const doAcquire = () => workLockStore!.acquireLock(
			parsed.data.scope as WorkLockScope,
			lockKey,
			user.userId,
			parsed.data.duration_min,
			{
				clientId: parsed.data.client_id,
				takeover: parsed.data.takeover,
				// Authorize a cross-user takeover ONLY here, where we have already
				// confirmed (resolveLockSubjectForAccess above) that the requester has
				// edit access to this exact page. A member with edit access may take the
				// page from another holder; the displaced holder is notified below and
				// CAS steers their stale save into the recovery-draft flow (#412) rather
				// than letting them silently clobber the taker.
				allowCrossUserTakeover: parsed.data.takeover === true,
				projectId: subject.projectId,
				chapterId: subject.chapterId,
				pageId: subject.pageId,
				workspaceId: subject.workspaceId,
			},
		);
		// P0 (round-5): a TAKEOVER releases the displaced holder's lease + mints a new one
		// in the lock-store transaction. The save path re-validates the lease (leaseGuard)
		// and writes state INSIDE the CROSS-REPLICA project critical section
		// (`withProjectCrossReplicaLock` = in-process mutex + Postgres advisory-lock txn).
		// In 2-replica prod the in-process mutex alone does NOT serialize a takeover on
		// replica A against a displaced save on replica B; the shared DB advisory lock does.
		// So a takeover takes the SAME cross-replica lock (same projectId key) for the
		// duration of its lock-store release+insert.
		//
		// Lock ordering (IDENTICAL on both sites ⇒ no deadlock): BOTH paths acquire the
		// in-process project mutex FIRST, THEN the DB advisory lock, THEN touch the
		// work-locks store / write project state — never the reverse. Resulting
		// cross-replica serialization:
		//   (a) save runs first → its leaseGuard sees the lease still held → it writes
		//       legitimately, THEN the takeover runs (the holder really held the lease at
		//       write time; the taker hasn't written anything, so nothing is clobbered); or
		//   (b) takeover runs first → releases/taken_over the old lease, THEN the displaced
		//       save runs and its in-txn leaseGuard sees the released/taken-over lock and
		//       rejects (editing_taken_over). Either way the displaced write never lands —
		//       even when save and takeover land on DIFFERENT replicas.
		// Non-takeover acquires (and acquires without a resolved projectId, e.g. a
		// non-workspace lock) keep the lock-store transaction's own atomicity — they do not
		// race the save's state write, so the extra lock hop is unnecessary.
		const serializeUnderProjectLock = parsed.data.takeover === true && Boolean(subject.projectId);
		const lock = serializeUnderProjectLock
			? await withProjectCrossReplicaLock(subject.projectId!, doAcquire)
			: await doAcquire();
		// Best-effort: tell the displaced holder another member took over their page.
		// Never block (or fail) the acquire on a notification hiccup — the lease is
		// already committed.
		if (lock.taken_over_from?.crossUser) {
			// The displaced holder edits the SAME page in the SAME project, so the
			// workspace is identical to the taker's resolved subject. Fall back to it
			// when the holder's stored lock row lacks a workspace_id (an older lock or
			// a state-fallback acquire path) so a cross-user takeover ALWAYS attempts
			// the mandatory in-app notice instead of silently skipping it.
			await notifyDisplacedHolder(lock.taken_over_from, user, subject.workspaceId).catch((error) => {
				console.warn("[locks] takeover notify failed", error);
			});
		}
		return c.json(lock, 201);
	} catch (error) {
		return lockErrorResponse(c, error);
	}
});

locks.post("/:id/release", async (c) => {
	if (!workLockStore) return lockServiceUnavailableResponse(c, "work_lock_store_unavailable");
	const user = getAuthUser(c) as JWTPayload;
	try {
		// Regular release path: requires the requester to own the lock. Admins
		// who need to break a colleague's lock should hit POST /:id/force so
		// the audit log records release_reason='admin_force_release' clearly.
		const released = await workLockStore.releaseLock(c.req.param("id"), user.userId);
		return c.json({ lock: released });
	} catch (error) {
		return lockErrorResponse(c, error);
	}
});

locks.post("/:id/extend", async (c) => {
	if (!workLockStore) return lockServiceUnavailableResponse(c, "work_lock_store_unavailable");
	const user = getAuthUser(c) as JWTPayload;
	// Re-check the JWT edit capability on every extend: a token can outlive a
	// role downgrade, and we must not let a now-viewer keep a lock alive forever.
	if (!canMutateWorkLocks(user.role)) return c.json({ error: "Forbidden: edit permission required", code: "lock_edit_permission_required" }, 403);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = extendSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		// Re-run the acquire-time workspace/scope access check before extending, so
		// a contributor whose membership was disabled or whose scope was narrowed
		// while holding the lock cannot keep extending it in 60-minute increments.
		const access = await resolveExtendAccess(c.req.param("id"), user);
		if (!access.allowed) return c.json({ error: access.error, code: access.code }, access.status);
		const lock = await workLockStore.extendLock(c.req.param("id"), user.userId, parsed.data.duration_min);
		return c.json(lock);
	} catch (error) {
		return lockErrorResponse(c, error);
	}
});

locks.get("/chapter/:chapterId", async (c) => {
	if (!workLockStore) return lockServiceUnavailableResponse(c, "work_lock_store_unavailable");
	const user = getAuthUser(c) as JWTPayload;
	const chapterId = c.req.param("chapterId");
	try {
		// Lock rows expose owner user ids, so listing must be gated by the same
		// project/workspace access used to acquire a lock; otherwise any logged-in
		// user could enumerate who holds locks in another workspace by guessing a
		// chapter/project id.
		const access = await resolveLockSubjectForAccess({ scope: "chapter", scope_id: chapterId }, user);
		if (!access.allowed) return c.json({ error: access.error, code: access.code }, access.status);
		const activeLocks = await workLockStore.listLocksForChapter(chapterId);
		return c.json({ locks: activeLocks });
	} catch (error) {
		return lockErrorResponse(c, error);
	}
});

// Admin-only force release. The JWT role guard runs before we hit the lock
// store so a non-admin user cannot force someone else off a lock by abusing
// the regular release endpoint.
locks.post("/:id/force", async (c) => {
	if (!workLockStore) return lockServiceUnavailableResponse(c, "work_lock_store_unavailable");
	const user = getAuthUser(c) as JWTPayload;
	// owner is a strict superset of admin — admit it wherever admin is allowed.
	if (!isPlatformAdmin(user.role)) return c.json({ error: "Forbidden: admin role required", code: "forbidden_admin_only" }, 403);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = forceReleaseSchema.safeParse(raw.data ?? {});
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	try {
		const released = await workLockStore.forceReleaseByAdmin(c.req.param("id"), user.userId, {
			reason: parsed.data?.reason ?? "admin_force_release",
		});
		return c.json({ lock: released, forced: true });
	} catch (error) {
		return lockErrorResponse(c, error);
	}
});

// Service hook: trigger the auto-expiry sweep. The frontend never calls this,
// but a cron job or internal scheduler can. Admin role required as a safety
// net while a dedicated service-account JWT class doesn't exist yet.
locks.post("/sweep", async (c) => {
	if (!workLockStore) return lockServiceUnavailableResponse(c, "work_lock_store_unavailable");
	const user = getAuthUser(c) as JWTPayload;
	// owner is a strict superset of admin — admit it wherever admin is allowed.
	if (!isPlatformAdmin(user.role)) return c.json({ error: "Forbidden: admin role required", code: "forbidden_admin_only" }, 403);
	const released = await workLockStore.sweepExpiredLocks();
	return c.json({ released });
});

export function canMutateWorkLocks(role: JWTPayload["role"]): boolean {
	// owner is a strict superset of admin, so it can mutate locks wherever admin can.
	return isPlatformAdmin(role) || role === "editor";
}

type AcquireLockInput = z.infer<typeof acquireSchema>;

type LockAccessResult = {
	allowed: true;
	projectId?: string;
	chapterId?: string;
	pageId?: string;
	workspaceId?: string;
} | {
	allowed: false;
	status: 400 | 403 | 404 | 503;
	error: string;
	code: string;
};

interface LockSubjectRow {
	project_id: string;
	workspace_id?: string | null;
	page_id?: string | null;
	page_index?: number | null;
}

interface ResolvedLockSubject {
	projectId: string;
	workspaceId?: string;
	chapterId?: string;
	pageId?: string;
	pageIndex?: number;
}

interface LockAccessSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

let lockAccessDatabaseUrl: string | undefined;
let lockAccessClient: LockAccessSqlClient | null = null;

async function resolveLockSubjectForAccess(input: AcquireLockInput, user: JWTPayload): Promise<LockAccessResult> {
	const resolved = await resolveLockSubject(input);
	if (!resolved) {
		return { allowed: false, status: 404, error: "Lock subject not found", code: "lock_subject_not_found" };
	}
	if (!resolved.workspaceId) {
		// owner is a strict superset of admin — admit it wherever admin is allowed.
		return isPlatformAdmin(user.role) || user.role === "editor"
			? { allowed: true, ...resolved }
			: { allowed: false, status: 403, error: "Forbidden: edit permission required", code: "lock_edit_permission_required" };
	}
	if (!projectCatalogStore || !workspaceAccessStore) {
		return { allowed: false, status: 503, error: "Project catalog unavailable", code: "project_catalog_unavailable" };
	}
	// Resolve the member so scoped contributors (translator/cleaner/typesetter/QC
	// limited to specific taskTypes) aren't denied by isFineGrainedProjectWideAccess
	// before they can lock their assigned subject. Passing one of their own task
	// types satisfies the scope check without widening access.
	const member = await workspaceAccessStore.getMember(resolved.workspaceId, user.userId);
	if (!member) {
		return { allowed: false, status: 404, error: "Lock subject not found", code: "lock_subject_not_found" };
	}
	const allowed = await projectCatalogStore.canAccessProject({
		projectId: resolved.projectId,
		userId: user.userId,
		permission: "update:project",
		chapterId: resolved.chapterId,
		pageIndex: resolved.pageIndex,
		taskType: inferScopedTaskType(member.scope),
		resourceKind: input.scope === "chapter" ? "review" : "page",
	});
	if (!allowed) {
		return { allowed: false, status: 404, error: "Lock subject not found", code: "lock_subject_not_found" };
	}
	return { allowed: true, ...resolved };
}

async function resolveExtendAccess(lockId: string, user: JWTPayload): Promise<LockAccessResult> {
	if (!workLockStore) return { allowed: false, status: 503, error: "Work lock store unavailable", code: "work_lock_store_unavailable" };
	const lock = await workLockStore.getLock(lockId);
	// Missing/expired/released locks fall through to extendLock, which surfaces a
	// LockNotFoundError; ownership is enforced there too.
	if (!lock) return { allowed: true };
	if (lock.ownerUserId !== user.userId) return { allowed: true };
	const workspaceId = lock.workspaceId?.trim();
	if (!workspaceId) {
		// Non-workspace lock: the JWT edit-role check in the route already gates it.
		return { allowed: true };
	}
	if (!lock.projectId?.trim()) {
		// Workspace lock without a resolvable project: re-checking is impossible, so
		// require an edit-capable JWT role (already verified by the caller).
		return { allowed: true };
	}
	if (!projectCatalogStore || !workspaceAccessStore) {
		return { allowed: false, status: 503, error: "Project catalog unavailable", code: "project_catalog_unavailable" };
	}
	const member = await workspaceAccessStore.getMember(workspaceId, user.userId);
	if (!member) return { allowed: false, status: 403, error: "Forbidden: workspace access revoked", code: "lock_permission_denied" };
	const allowed = await projectCatalogStore.canAccessProject({
		projectId: lock.projectId,
		userId: user.userId,
		permission: "update:project",
		chapterId: lock.chapterId,
		// Pass the lock's page index so a member restricted by scope.pageIndexes
		// isn't rejected on renewal: without it, isFineGrainedProjectWideAccess
		// treats the recheck as a project-wide update and denies page-scoped
		// assignees after their first TTL window. Derived from the canonical
		// page subject id (project:page:n) recorded at acquire time.
		pageIndex: pageIndexFromLock(lock),
		taskType: inferScopedTaskType(member.scope),
		resourceKind: lock.scope === "chapter" ? "review" : "page",
	});
	if (!allowed) return { allowed: false, status: 403, error: "Forbidden: workspace access revoked", code: "lock_permission_denied" };
	return { allowed: true };
}

/**
 * MANDATORY in-app notice to the holder a cross-user takeover just displaced.
 * The title/body are plain strings (the in-app row is localized client-side via a
 * stable type + metadata; the email render is best-effort English). Best-effort:
 * a notify hiccup must never fail the takeover (the lease is already committed).
 * `fallbackWorkspaceId` is the taker's resolved subject workspace (same page/project
 * ⇒ same workspace) used when the displaced holder's stored lock row lacks one, so a
 * cross-user takeover still addresses the per-user channel instead of silently
 * skipping the mandatory notice. We only skip when no workspace can be resolved at all.
 */
export async function notifyDisplacedHolder(
	holder: TakenOverHolder,
	taker: JWTPayload,
	fallbackWorkspaceId?: string,
	// Seam for tests; defaults to the real notification producer.
	notifyFn: typeof notify = notify,
): Promise<void> {
	const workspaceId = holder.workspaceId?.trim() || fallbackWorkspaceId?.trim();
	if (!workspaceId || !holder.userId.trim()) return;
	const takerLabel = taker.email?.trim() || "A teammate";
	const pageIndex = pageIndexFromLock(holder);
	const pageLabel = typeof pageIndex === "number" ? `page ${pageIndex + 1}` : "this page";
	await notifyFn({
		userId: holder.userId,
		type: "editing_taken_over",
		title: `${takerLabel} took over editing ${pageLabel}`,
		body: `${takerLabel} is now editing ${pageLabel}. Your unsaved changes are kept as a recovery draft — re-open the page to restore them.`,
		workspaceId,
		linkUrl: holder.projectId ? `/projects/${holder.projectId}` : undefined,
		metadata: {
			projectId: holder.projectId,
			scope: holder.scope,
			scopeId: holder.scopeId,
			pageIndex,
			takenOverBy: taker.userId,
		},
		// The displaced holder MUST always see they were taken over (data-safety
		// notice) — bypass the in_app pref like other mandatory notices.
		mandatoryInApp: true,
	});
}

function pageIndexFromLock(lock: { scope: string; pageId?: string; scopeId?: string }): number | undefined {
	if (lock.scope === "chapter") return undefined;
	const candidate = lock.pageId ?? lock.scopeId;
	if (!candidate) return undefined;
	const marker = ":page:";
	const markerIndex = candidate.lastIndexOf(marker);
	if (markerIndex < 0) return undefined;
	const indexPart = candidate.slice(markerIndex + marker.length);
	if (!/^\d+$/.test(indexPart)) return undefined;
	const parsed = Number.parseInt(indexPart, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function resolveLockSubject(input: AcquireLockInput): Promise<ResolvedLockSubject | null> {
	const catalogSubject = await resolveCatalogLockSubject(input);
	if (catalogSubject) return catalogSubject;
	return resolveStateLockSubject(input);
}

async function resolveCatalogLockSubject(input: AcquireLockInput): Promise<ResolvedLockSubject | null> {
	const client = getLockAccessClient();
	if (!client) return null;
	if (input.scope === "page") {
		const rows = await client.unsafe<LockSubjectRow>(`
			SELECT project_pages.project_id, projects.workspace_id, project_pages.page_id, project_pages.page_index
			FROM project_pages
			INNER JOIN projects ON projects.project_id = project_pages.project_id
			WHERE project_pages.page_id = $1
				AND projects.deleted_at IS NULL
			LIMIT 1
		`, [input.scope_id]);
		const row = rows[0];
		return row ? normalizeLockSubjectRow(row, { chapterId: row.project_id, pageId: row.page_id ?? input.scope_id }) : null;
	}
	if (input.scope === "chapter") {
		const rows = await client.unsafe<LockSubjectRow>(`
			SELECT project_id, workspace_id, NULL::text AS page_id, NULL::integer AS page_index
			FROM projects
			WHERE project_id = $1
				AND deleted_at IS NULL
			LIMIT 1
		`, [input.scope_id]);
		const row = rows[0];
		return row ? normalizeLockSubjectRow(row, { chapterId: row.project_id }) : null;
	}
	return null;
}

async function resolveStateLockSubject(input: AcquireLockInput): Promise<ResolvedLockSubject | null> {
	const projectId = input.project_id?.trim();
	if (!projectId || !projectCatalogStore) return null;
	const state = await projectCatalogStore.getProjectState(projectId);
	if (!state) return null;
	if (input.scope === "chapter") {
		return { projectId, workspaceId: state.workspaceId, chapterId: projectId };
	}
	const pageMatch = findPageForLock(state, input);
	if (!pageMatch) return null;
	return {
		projectId,
		workspaceId: state.workspaceId,
		chapterId: projectId,
		pageId: pageMatch.pageId,
		pageIndex: pageMatch.pageIndex,
	};
}

function findPageForLock(state: ProjectState, input: AcquireLockInput): { pageId: string; pageIndex: number } | null {
	if (input.scope === "page") {
		const pageIndex = state.pages.findIndex((page, index) => input.scope_id === `${state.projectId}:page:${index}` || input.scope_id === page.imageId);
		if (pageIndex < 0) return null;
		// Always record the canonical page subject id as page_id even when the lock
		// was acquired by image id. The workflow submit path releases page locks by
		// the canonical subject id, so an image-id-keyed lock would otherwise stay
		// active and keep blocking the next worker after submit.
		return { pageId: `${state.projectId}:page:${pageIndex}`, pageIndex };
	}
	for (const [pageIndex, page] of state.pages.entries()) {
		const hasTextLayer = page.textLayers.some((layer) => layer.id === input.scope_id);
		const hasImageLayer = page.imageLayers?.some((layer) => layer.id === input.scope_id) ?? false;
		if (hasTextLayer || hasImageLayer) {
			return { pageId: input.page_id?.trim() || `${state.projectId}:page:${pageIndex}`, pageIndex };
		}
	}
	return null;
}

function normalizeLockSubjectRow(row: LockSubjectRow, extra: { chapterId?: string; pageId?: string }): ResolvedLockSubject {
	return {
		projectId: row.project_id,
		workspaceId: row.workspace_id?.trim() || undefined,
		pageIndex: typeof row.page_index === "number" ? row.page_index : undefined,
		...extra,
	};
}

function getLockAccessClient(): LockAccessSqlClient | null {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		lockAccessDatabaseUrl = undefined;
		lockAccessClient = null;
		return null;
	}
	if (lockAccessClient && lockAccessDatabaseUrl === databaseUrl) return lockAccessClient;
	lockAccessDatabaseUrl = databaseUrl;
	lockAccessClient = getSharedBunSql(databaseUrl) as unknown as LockAccessSqlClient;
	return lockAccessClient;
}

type LockRouteErrorStatus = 400 | 403 | 404 | 409 | 503;

export interface LockRouteErrorMapping {
	status: LockRouteErrorStatus;
	body: Record<string, unknown>;
	retryAfterSeconds?: number;
}

function lockServiceUnavailableResponse(c: Context, code = "work_lock_service_unavailable"): Response {
	c.header("Retry-After", String(LOCK_SERVICE_RETRY_AFTER_SECONDS));
	return c.json({
		error: "Work lock service unavailable",
		code,
		retryAfter: LOCK_SERVICE_RETRY_AFTER_SECONDS,
	}, 503);
}

function lockErrorResponse(c: Context, error: unknown): Response {
	const mapped = classifyLockRouteError(error);
	if (mapped.retryAfterSeconds) c.header("Retry-After", String(mapped.retryAfterSeconds));
	return c.json(mapped.body, mapped.status);
}

export function classifyLockRouteError(error: unknown): LockRouteErrorMapping {
	if (error instanceof SameUserLockConflictError) {
		// Same user, different tab. 409 like a normal conflict, but a distinct code
		// so the client offers a "continue here / take over" affordance instead of a
		// "someone else is editing" block.
		return {
			status: 409,
			body: {
				error: "You are already editing this in another tab",
				code: "lock_same_user_conflict",
				held_by_user_id: error.conflict.held_by_user_id,
				held_by_client_id: error.conflict.held_by_client_id,
				lock_id: error.conflict.lock_id,
				expires_at: error.conflict.expires_at,
			},
		};
	}
	if (error instanceof LockConflictError) {
		return {
			status: 409,
			body: {
				error: "Lock conflict",
				code: "lock_conflict",
				held_by_user_id: error.conflict.held_by_user_id,
				expires_at: error.conflict.expires_at,
			},
		};
	}
	if (error instanceof LockPermissionError) return { status: 403, body: { error: error.message, code: "lock_permission_denied" } };
	if (error instanceof LockNotFoundError) return { status: 404, body: { error: error.message, code: "lock_not_found" } };
	if (isLockServiceDependencyError(error)) {
		return {
			status: 503,
			body: {
				error: "Work lock service unavailable",
				code: "work_lock_service_unavailable",
				retryAfter: LOCK_SERVICE_RETRY_AFTER_SECONDS,
			},
			retryAfterSeconds: LOCK_SERVICE_RETRY_AFTER_SECONDS,
		};
	}
	const message = error instanceof Error ? error.message : "Work lock error";
	return { status: 400, body: { error: message, code: "work_lock_error" } };
}

export function isLockServiceDependencyError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const maybe = error as Error & { code?: unknown; errno?: unknown; cause?: unknown };
	const code = String(maybe.code ?? maybe.errno ?? "").toLowerCase();
	if (["econnrefused", "econnreset", "etimedout", "enotfound", "socket_closed", "connection_closed"].includes(code)) return true;
	// Connection-CLASS failures only (codex P2): a healthy DB raising a schema/
	// constraint/syntax error also carries a Postgres-ish name — classifying it
	// as an outage hides the real bug behind 503 + client fallback. Postgres
	// SQLSTATE class 08* = connection exceptions.
	const sqlState = String((maybe as { code?: unknown }).code ?? "");
	if (/^08[0-9a-z]{3}$/i.test(sqlState)) return true;
	const message = error.message.toLowerCase();
	const dependencyHints = [
		"connection refused",
		"connection closed",
		"connection terminated",
		"connection ended",
		"max reconnection attempts",
		"socket closed",
		"fetch failed",
		"timed out while trying to connect",
	];
	if (dependencyHints.some((hint) => message.includes(hint))) return true;
	if (maybe.cause && maybe.cause !== error) return isLockServiceDependencyError(maybe.cause);
	return false;
}

export { locks };
