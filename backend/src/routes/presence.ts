// Soft-presence API for Collab v1 — best-effort "X is editing" signal.
//
//   POST /api/presence/heartbeat   → record/refresh a ping for a page/task
//   GET  /api/presence?projectId&scope&scopeId  → live pings from OTHER users
//   POST /api/presence/clear       → drop the caller's ping for a scope
//
// This is informational only — it never blocks editing (that's hard locking,
// which is Postgres-only and deliberately out of scope here). The store is pure
// in-memory with a short TTL, so it works identically in file-mode and prod and
// degrades gracefully (stale pings expire on their own).
//
// SECURITY (P1 fix):
//   - AUTHORIZATION: every endpoint authorizes the caller against the project
//     they are pinging/reading. A caller may only post/read presence for a
//     project they can access (personal ownership in file-mode, or workspace
//     membership in prod). An unauthorized caller can neither broadcast presence
//     into a foreign project nor enumerate who is online on one. The check
//     reuses the same project-access primitives (`canReadProjectForUser` for
//     personal/file-mode projects, `projectCatalogStore.canAccessProject` for
//     workspace projects) that the project routes use.
//   - NO IDENTITY LEAK: the stored/exposed name is a derived non-PII display
//     handle (email local-part for authed users, the client-supplied name in
//     file-mode), never the raw email/userId. The GET/heartbeat response surfaces
//     only that handle (see PresenceEntry) so a peer cannot harvest real user
//     ids/emails of everyone else on a project.
//
// Identity: when a real JWT is present we key on the authed userId (for de-dup,
// never exposed) and show a derived handle. In file-mode (single dev user, no
// auth) the client supplies its own userId/name — which is also how a test or QA
// harness simulates a SECOND user's ping.

import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod/v4";
import { optionalAuth, getAuthUser } from "../middleware/auth.middleware.js";
import { serverConfig } from "../config.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import { readJsonBody } from "../utils/request-body.js";
import { presenceStore, type PresenceScope } from "../services/presence.js";
import type { JWTPayload } from "../types/auth.js";

export const presence = new Hono();

presence.use("*", optionalAuth);

const heartbeatSchema = z.object({
	projectId: z.string().trim().min(1).max(200),
	scope: z.enum(["page", "task"]),
	scopeId: z.string().trim().min(1).max(200),
	// Client identity is only honoured in file-mode (no JWT). With a JWT the
	// server-side userId/derived-handle wins, so these fields are ignored for
	// authed users.
	userId: z.string().trim().min(1).max(200).optional(),
	name: z.string().trim().min(1).max(120).optional(),
}).strict();

const clearSchema = z.object({
	projectId: z.string().trim().min(1).max(200),
	scope: z.enum(["page", "task"]),
	scopeId: z.string().trim().min(1).max(200),
	userId: z.string().trim().min(1).max(200).optional(),
}).strict();

const listQuerySchema = z.object({
	projectId: z.string().trim().min(1).max(200),
	scope: z.enum(["page", "task"]),
	scopeId: z.string().trim().min(1).max(200),
	userId: z.string().trim().min(1).max(200).optional(),
});

// Same hatch the project routes use: legacy anonymous file-mode access is only
// allowed when auth is NOT required AND the operator explicitly opted in.
function allowsLegacyAnonymousProjectAccess(): boolean {
	return !serverConfig.apiAuthRequired && serverConfig.allowLegacyAnonymousProjects;
}

// Derive a NON-PII display handle from an email. `ann@studio.com` -> `ann`. We
// drop the domain (a weak PII signal) and never surface the full address. Falls
// back to a generic label if the local-part is empty/odd.
function displayNameFromEmail(email: string): string {
	const local = email.split("@")[0]?.trim();
	return local && local.length > 0 ? local : "Member";
}

type PresenceAccess =
	| { ok: true; userId: string; name: string }
	| { ok: false; response: Response };

/**
 * Resolve the acting identity AND authorize it against the target project, in one
 * pass. The result's identity is what gets stored — `name` is always a non-PII
 * handle.
 *
 * Authorization model (mirrors the project routes):
 *   - Authed caller: must pass `projectCatalogStore.canAccessProject(read:project)`
 *     for the project. Workspace non-members and foreign-project callers are
 *     denied (404, the same not-found shape the project routes use so a caller
 *     can't probe which project ids exist). A personal project owned by the
 *     caller (or an ownerless legacy project) is allowed without a catalog hit.
 *   - Unauthed caller (file-mode only): allowed ONLY when legacy anonymous access
 *     is enabled AND the project is reachable anonymously (no owner userId, no
 *     workspaceId). A client-supplied identity is required so a second user can
 *     be distinguished. When auth is required (prod posture) an unauthed write is
 *     401.
 */
async function resolveAuthorizedIdentity(
	c: Context,
	input: { projectId: string; userId?: string; name?: string },
	options: { requireIdentity: boolean },
): Promise<PresenceAccess> {
	const authUser = getAuthUser(c) as JWTPayload | undefined;
	const projectId = input.projectId.trim();

	if (authUser) {
		const allowed = await callerCanAccessProject(projectId, authUser.userId);
		if (!allowed) {
			// 404 (not 403) to avoid leaking which foreign project ids exist — the
			// same shape the project routes return for a denied/foreign project.
			return { ok: false, response: c.json({ error: "Project not found", code: "presence_project_not_found" }, 404) };
		}
		return { ok: true, userId: authUser.userId, name: displayNameFromEmail(authUser.email) };
	}

	// No JWT. In a prod (auth-required) posture, writes must be authenticated.
	if (serverConfig.apiAuthRequired) {
		return { ok: false, response: c.json({ error: "Authentication required", code: "presence_auth_required" }, 401) };
	}

	// File-mode: only legacy anonymous projects are reachable without auth, and
	// only when the operator opted in.
	const anonymouslyReachable = await projectIsAnonymouslyReachable(projectId);
	if (!anonymouslyReachable) {
		return { ok: false, response: c.json({ error: "Project not found", code: "presence_project_not_found" }, 404) };
	}

	if (!input.userId) {
		if (!options.requireIdentity) {
			// clear() with no identity is a harmless no-op for the caller.
			return { ok: false, response: c.json({ ok: true }) };
		}
		return { ok: false, response: c.json({ error: "Presence identity required", code: "presence_identity_required" }, 401) };
	}
	return { ok: true, userId: input.userId, name: input.name?.trim() || input.userId };
}

// Authed caller -> can they read this project? Personal/ownerless projects are
// allowed directly; everything else goes through the catalog access check.
async function callerCanAccessProject(projectId: string, userId: string): Promise<boolean> {
	if (!projectCatalogStore) {
		// No catalog (degraded). Only legacy-anonymous-reachable projects are safe
		// to expose; otherwise deny rather than leak.
		return false;
	}
	const state = await projectCatalogStore.getProjectState(projectId);
	if (!state) return false;
	// Personal (no workspace) project: the owner — or any authed caller for an
	// ownerless legacy project — may access, matching canReadProjectForUser
	// (`!state.userId || state.userId === user.userId`) used by the project routes.
	if (!state.workspaceId?.trim()) {
		return !state.userId || state.userId === userId;
	}
	return projectCatalogStore.canAccessProject({ projectId, userId, permission: "read:project" });
}

// Unauthed caller -> is the project reachable anonymously (no owner, no
// workspace)? Used to gate file-mode presence so an anonymous client cannot
// ping/read a workspace or owned project.
async function projectIsAnonymouslyReachable(projectId: string): Promise<boolean> {
	if (!allowsLegacyAnonymousProjectAccess()) return false;
	if (!projectCatalogStore) return false;
	const state = await projectCatalogStore.getProjectState(projectId);
	if (!state) return false;
	return !state.userId && !state.workspaceId?.trim();
}

presence.post("/heartbeat", async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = heartbeatSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	const access = await resolveAuthorizedIdentity(
		c,
		{ projectId: parsed.data.projectId, userId: parsed.data.userId, name: parsed.data.name },
		{ requireIdentity: true },
	);
	if (!access.ok) return access.response;

	const ping = presenceStore.heartbeat({
		userId: access.userId,
		name: access.name,
		scope: parsed.data.scope as PresenceScope,
		scopeId: parsed.data.scopeId,
		projectId: parsed.data.projectId,
	});

	// Echo back who ELSE is here so a single round-trip both writes and reads.
	const others = presenceStore.listForScope({
		projectId: parsed.data.projectId,
		scope: parsed.data.scope as PresenceScope,
		scopeId: parsed.data.scopeId,
		excludeUserId: access.userId,
	});
	return c.json({ ok: true, lastSeen: ping.lastSeen, others });
});

presence.get("/", async (c) => {
	const parsed = listQuerySchema.safeParse(c.req.query());
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	// Reads are authorized too — only a project-authorized caller may enumerate
	// who is online. No identity is REQUIRED for a read (an authed caller is
	// implicit; a file-mode caller may pass its own id only to exclude itself).
	const access = await resolveAuthorizedIdentity(
		c,
		{ projectId: parsed.data.projectId, userId: parsed.data.userId },
		{ requireIdentity: false },
	);
	if (!access.ok) return access.response;

	const others = presenceStore.listForScope({
		projectId: parsed.data.projectId,
		scope: parsed.data.scope as PresenceScope,
		scopeId: parsed.data.scopeId,
		excludeUserId: access.userId,
	});
	return c.json({ others });
});

presence.post("/clear", async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = clearSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	const access = await resolveAuthorizedIdentity(
		c,
		{ projectId: parsed.data.projectId, userId: parsed.data.userId },
		{ requireIdentity: false },
	);
	// A foreign-project / unauthorized clear is denied like the other endpoints.
	// A no-identity file-mode clear is a benign no-op (response carries { ok }).
	if (!access.ok) return access.response;

	presenceStore.clear({
		userId: access.userId,
		scope: parsed.data.scope as PresenceScope,
		scopeId: parsed.data.scopeId,
		projectId: parsed.data.projectId,
	});
	return c.json({ ok: true });
});
