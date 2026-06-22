import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod/v4";
import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import {
	GLOSSARY_ROLE_SCOPES,
	GlossaryError,
	glossaryStore,
	MAX_GLOSSARY_LOOKUP_TEXT_LENGTH,
	MAX_GLOSSARY_NOTES_LENGTH,
	MAX_GLOSSARY_TARGET_LANG_LENGTH,
	MAX_GLOSSARY_TERM_LENGTH,
	MAX_GLOSSARY_TRANSLATION_LENGTH,
	type GlossaryRoleScope,
} from "../services/glossary.js";
import {
	WorkspaceAccessError,
	workspaceAccessStore,
	type WorkspaceScope,
} from "../services/workspace-access.js";
import { readJsonBody } from "../utils/request-body.js";
import type { GlossaryEntry } from "../services/glossary.js";

const glossary = new Hono();

glossary.use("*", authMiddleware);

const roleScopeSchema = z.enum(GLOSSARY_ROLE_SCOPES);

const createSchema = z
	.object({
		workspaceId: z.string().trim().min(1).max(200),
		term: z.string().trim().min(1).max(MAX_GLOSSARY_TERM_LENGTH),
		translation: z.string().trim().min(1).max(MAX_GLOSSARY_TRANSLATION_LENGTH),
		targetLang: z.string().trim().min(1).max(MAX_GLOSSARY_TARGET_LANG_LENGTH),
		notes: z.string().trim().max(MAX_GLOSSARY_NOTES_LENGTH).optional(),
		roleScope: roleScopeSchema.optional(),
		projectId: z.string().trim().min(1).max(200).optional(),
	})
	.strict();

const updateSchema = z
	.object({
		term: z.string().trim().min(1).max(MAX_GLOSSARY_TERM_LENGTH).optional(),
		translation: z.string().trim().min(1).max(MAX_GLOSSARY_TRANSLATION_LENGTH).optional(),
		targetLang: z.string().trim().min(1).max(MAX_GLOSSARY_TARGET_LANG_LENGTH).optional(),
		notes: z.string().trim().max(MAX_GLOSSARY_NOTES_LENGTH).nullable().optional(),
		roleScope: roleScopeSchema.nullable().optional(),
		projectId: z.string().trim().min(1).max(200).nullable().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, { message: "No fields to update" });

// GET /api/glossary?workspace=&to=&role=&project=
glossary.get("/", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = requireWorkspaceQuery(c);
	if (workspaceId instanceof Response) return workspaceId;
	const targetLang = optionalQuery(c, "to", MAX_GLOSSARY_TARGET_LANG_LENGTH);
	if (targetLang === null) return c.json({ error: "Invalid target language", code: "invalid_target_lang" }, 400);
	const roleScope = parseRoleScopeQuery(c, "role");
	if (roleScope === null) return c.json({ error: "Invalid role scope", code: "invalid_role_scope" }, 400);
	const projectId = optionalQuery(c, "project", 200);
	if (projectId === null) return c.json({ error: "Invalid project", code: "invalid_project" }, 400);
	try {
		const member = await store.requirePermission(workspaceId, user.userId, "read_workspace");
		const entries = await glossaryStore.list(workspaceId, {
			targetLang: targetLang ?? undefined,
			roleScope: roleScope ?? undefined,
			projectId: projectId ?? undefined,
		});
		// A member limited by scope may only see entries inside their assignment,
		// even when they omit the project/target-lang filters. Post-filter so a
		// scoped contractor never reads the rest of the workspace's glossary.
		return c.json({ entries: filterEntriesByScope(member.scope, entries) });
	} catch (error) {
		return errorResponse(c, error);
	}
});

// GET /api/glossary/match?workspace=&text=&to=&role=&project=
glossary.get("/match", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = requireWorkspaceQuery(c);
	if (workspaceId instanceof Response) return workspaceId;
	const targetLang = c.req.query("to")?.trim();
	if (!targetLang || targetLang.length > MAX_GLOSSARY_TARGET_LANG_LENGTH) {
		return c.json({ error: "Query parameter 'to' is required", code: "invalid_target_lang" }, 400);
	}
	const text = c.req.query("text") ?? "";
	if (text.length > MAX_GLOSSARY_LOOKUP_TEXT_LENGTH) {
		return c.json({ error: "Text exceeds maximum length", code: "text_too_long" }, 400);
	}
	const roleScope = parseRoleScopeQuery(c, "role");
	if (roleScope === null) return c.json({ error: "Invalid role scope", code: "invalid_role_scope" }, 400);
	const projectId = optionalQuery(c, "project", 200);
	if (projectId === null) return c.json({ error: "Invalid project", code: "invalid_project" }, 400);
	try {
		const member = await store.requirePermission(workspaceId, user.userId, "read_workspace");
		// Reject an explicit out-of-scope target language up front so a scoped
		// member cannot probe glossary terms for a language they cannot access.
		if (!scopeAllowsLanguage(member.scope, targetLang) || !scopeAllowsProject(member.scope, projectId ?? undefined)) {
			return c.json({ error: "Forbidden: workspace scope does not allow this resource", code: "workspace_scope_denied" }, 403);
		}
		const matches = await glossaryStore.lookup(workspaceId, text, targetLang, {
			roleScope: roleScope ?? undefined,
			projectId: projectId ?? undefined,
		});
		// Drop any matched entry that falls outside the member's scope (e.g. an
		// entry pinned to a project the contractor is not assigned to).
		const scoped = matches.filter((match) => entryWithinScope(member.scope, match.entry));
		return c.json({ matches: scoped });
	} catch (error) {
		return errorResponse(c, error);
	}
});

// POST /api/glossary
glossary.post("/", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = createSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	try {
		const member = await store.requirePermission(parsed.data.workspaceId, user.userId, "update_project");
		// A scoped editor must only create/upsert entries inside their assignment.
		// Requiring a writable target stops them from POSTing a projectId outside
		// their scope, or omitting projectId to overwrite a workspace-wide entry
		// that drives suggestions for projects/languages they cannot manage.
		if (!scopeAllowsWrite(member.scope, { projectId: parsed.data.projectId, targetLang: parsed.data.targetLang })) {
			return c.json({ error: "Forbidden: workspace scope does not allow this resource", code: "workspace_scope_denied" }, 403);
		}
		const entry = await glossaryStore.create({
			workspaceId: parsed.data.workspaceId,
			term: parsed.data.term,
			translation: parsed.data.translation,
			targetLang: parsed.data.targetLang,
			notes: parsed.data.notes,
			roleScope: parsed.data.roleScope as GlossaryRoleScope | undefined,
			projectId: parsed.data.projectId,
			createdBy: user.userId,
		});
		return c.json({ entry }, 201);
	} catch (error) {
		return errorResponse(c, error);
	}
});

// PATCH /api/glossary/:id?workspace=
glossary.patch("/:id", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = requireWorkspaceQuery(c);
	if (workspaceId instanceof Response) return workspaceId;
	const id = c.req.param("id");
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = updateSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	try {
		const member = await store.requirePermission(workspaceId, user.userId, "update_project");
		const existing = await glossaryStore.get(workspaceId, id);
		// 404 (not 403) for entries the member cannot even see, so scope never
		// leaks the existence of out-of-scope entries.
		if (!existing || !entryWithinScope(member.scope, existing)) {
			return c.json({ error: "Glossary entry not found", code: "glossary_not_found" }, 404);
		}
		// The post-update target must also stay inside the member's scope so a
		// scoped editor cannot re-point an entry at a project/language they cannot
		// manage.
		const nextProjectId = parsed.data.projectId === undefined ? existing.projectId : (parsed.data.projectId ?? undefined);
		const nextTargetLang = parsed.data.targetLang ?? existing.targetLang;
		if (!scopeAllowsWrite(member.scope, { projectId: nextProjectId, targetLang: nextTargetLang })) {
			return c.json({ error: "Forbidden: workspace scope does not allow this resource", code: "workspace_scope_denied" }, 403);
		}
		const entry = await glossaryStore.update(workspaceId, id, {
			term: parsed.data.term,
			translation: parsed.data.translation,
			targetLang: parsed.data.targetLang,
			notes: parsed.data.notes,
			roleScope: parsed.data.roleScope as GlossaryRoleScope | null | undefined,
			projectId: parsed.data.projectId,
		});
		if (!entry) return c.json({ error: "Glossary entry not found", code: "glossary_not_found" }, 404);
		return c.json({ entry });
	} catch (error) {
		return errorResponse(c, error);
	}
});

// DELETE /api/glossary/:id?workspace=
glossary.delete("/:id", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = requireWorkspaceQuery(c);
	if (workspaceId instanceof Response) return workspaceId;
	const id = c.req.param("id");
	try {
		const member = await store.requirePermission(workspaceId, user.userId, "update_project");
		const existing = await glossaryStore.get(workspaceId, id);
		// 404 for both missing and out-of-scope entries so a scoped member cannot
		// probe or delete entries outside their assignment.
		if (!existing || !entryWithinScope(member.scope, existing)) {
			return c.json({ error: "Glossary entry not found", code: "glossary_not_found" }, 404);
		}
		const removed = await glossaryStore.delete(workspaceId, id);
		if (!removed) return c.json({ error: "Glossary entry not found", code: "glossary_not_found" }, 404);
		return c.json({ ok: true });
	} catch (error) {
		return errorResponse(c, error);
	}
});

function requireWorkspaceStore(c: Context) {
	if (!workspaceAccessStore) {
		return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	}
	return workspaceAccessStore;
}

function requireUser(c: Context): JWTPayload {
	return getAuthUser(c) as JWTPayload;
}

function requireWorkspaceQuery(c: Context): string | Response {
	const workspaceId = c.req.query("workspace")?.trim();
	if (!workspaceId || workspaceId.length > 200) {
		return c.json({ error: "Query parameter 'workspace' is required", code: "invalid_workspace" }, 400);
	}
	return workspaceId;
}

// Returns the trimmed value, undefined when absent, or null when invalid.
function optionalQuery(c: Context, key: string, max: number): string | undefined | null {
	const raw = c.req.query(key);
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > max) return null;
	return trimmed;
}

// Returns the role scope, undefined when absent, or null when invalid.
function parseRoleScopeQuery(c: Context, key: string): GlossaryRoleScope | undefined | null {
	const raw = c.req.query(key);
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return (GLOSSARY_ROLE_SCOPES as readonly string[]).includes(trimmed) ? (trimmed as GlossaryRoleScope) : null;
}

// ---------------------------------------------------------------------------
// Per-member scope enforcement for the glossary.
//
// A member.scope narrows which projects/languages a member may touch. The
// glossary only carries projectId + targetLang, so those are the dimensions
// we evaluate. An empty/absent scope list means "no restriction on that axis".
// ---------------------------------------------------------------------------

function hasScopeList(values: unknown[] | undefined): values is string[] {
	return Array.isArray(values) && values.length > 0;
}

export function scopeAllowsProject(scope: WorkspaceScope, projectId: string | undefined): boolean {
	// Unrestricted axis → anything is allowed.
	if (!hasScopeList(scope.projectIds)) return true;
	// Restricted to specific projects → a workspace-wide (no projectId) read is
	// not within any single assigned project, so deny it.
	if (projectId === undefined) return false;
	return scope.projectIds.includes(projectId);
}

export function scopeAllowsLanguage(scope: WorkspaceScope, targetLang: string | undefined): boolean {
	if (!hasScopeList(scope.languages)) return true;
	if (targetLang === undefined) return false;
	return scope.languages.includes(targetLang);
}

// A scoped member may only see an existing entry when it sits inside their
// scope. Workspace-wide entries (no projectId) are visible to project-scoped
// members for read purposes, since they apply to the projects those members can
// access; writes are gated separately by `scopeAllowsWrite`.
export function entryWithinScope(scope: WorkspaceScope, entry: GlossaryEntry): boolean {
	const projectOk = !hasScopeList(scope.projectIds)
		|| entry.projectId === undefined
		|| scope.projectIds.includes(entry.projectId);
	return projectOk && scopeAllowsLanguage(scope, entry.targetLang);
}

// Creating/updating an entry is stricter than reading it: a project-scoped
// member must target one of their assigned projects (never a workspace-wide
// entry, which would change suggestions outside their assignment).
export function scopeAllowsWrite(scope: WorkspaceScope, target: { projectId?: string; targetLang?: string }): boolean {
	return scopeAllowsProject(scope, target.projectId) && scopeAllowsLanguage(scope, target.targetLang);
}

export function filterEntriesByScope(scope: WorkspaceScope, entries: GlossaryEntry[]): GlossaryEntry[] {
	if (!hasScopeList(scope.projectIds) && !hasScopeList(scope.languages)) return entries;
	return entries.filter((entry) => entryWithinScope(scope, entry));
}

function errorResponse(c: Context, error: unknown): Response {
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status as 400);
	}
	if (error instanceof GlossaryError) {
		return c.json({ error: error.message, code: error.code }, error.status as 400);
	}
	throw error;
}

export { glossary };
