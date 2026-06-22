// Wave 3 W3.6: Translation Memory (TM) routes.
//
// POST /api/tm            — add a source->target TM entry (embeds + caches).
// POST /api/tm/search     — vector-fuzzy search within a workspace + lang pair.
//
// Search is POST (not GET) so the source segment + language pair travel in the
// request BODY, never the URL: TM text is user/licensed content and request URLs
// leak into Sentry spans (url.full), access logs, and browser/proxy history.
//
// Both routes require auth and enforce workspace membership via the shared
// workspaceAccessStore. Writes need `update_project` (editor+); reads need
// `read_workspace`. BOTH reads AND writes ALSO go through requireScopedPermission
// so a language-/project-scoped contractor can only query OR seed TM for
// languages + projects inside their member scope — role membership alone is not
// enough (a scoped member must not write TM rows for an out-of-scope language/
// project pair). Workspace isolation is
// double-enforced — the authz check binds the caller to the workspace, and the
// service/store key every row by workspace_id so results can never cross
// workspaces.

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import { readJsonBody } from "../utils/request-body.js";
import { WorkspaceAccessError, workspaceAccessStore } from "../services/workspace-access.js";
import {
	getTranslationMemoryService,
	TmError,
	TM_MAX_TEXT_LENGTH,
} from "../services/translation-memory.js";

const tm = new Hono();

tm.use("*", authMiddleware);

const langSchema = z.string().trim().min(2).max(32);

const addEntrySchema = z.object({
	workspaceId: z.string().trim().min(1).max(200),
	sourceText: z.string().trim().min(1).max(TM_MAX_TEXT_LENGTH),
	sourceLang: langSchema,
	targetText: z.string().trim().min(1).max(TM_MAX_TEXT_LENGTH),
	targetLang: langSchema,
	contextNote: z.string().trim().max(1000).optional(),
	projectId: z.string().trim().min(1).max(200).optional(),
}).strict();

const searchSchema = z.object({
	workspaceId: z.string().trim().min(1).max(200),
	q: z.string().trim().min(1).max(TM_MAX_TEXT_LENGTH),
	from: langSchema,
	to: langSchema,
	limit: z.number().int().min(1).max(50).optional(),
}).strict();

function isValidWorkspaceId(workspaceId: string): boolean {
	return /^[\w-]{1,200}$/.test(workspaceId);
}

function handleError(c: Context, error: unknown): Response {
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
	}
	if (error instanceof TmError) {
		return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
	}
	throw error;
}

// POST /api/tm — add a TM entry. Requires editor+ membership of the workspace.
tm.post("/", async (c) => {
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = addEntrySchema.safeParse(raw.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	if (!workspaceAccessStore) {
		return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	}

	try {
		// Authz: writing TM requires project-update permission on the workspace AND
		// that the write stays inside the caller's fine-grained scope — mirroring TM
		// SEARCH, which scopes by language. A language-scoped contractor (e.g.
		// `languages: ["ja"]`) must not be able to seed TM rows for an unrelated pair,
		// and a project-scoped member must not write TM attributed to a project outside
		// their assignment. We check the SOURCE language, the TARGET language, and the
		// optional projectId separately because any one of them can fall outside scope.
		// An unscoped owner/editor (empty scope lists) passes every check unchanged.
		await workspaceAccessStore.requireScopedPermission(parsed.data.workspaceId, user.userId, "update_project", { language: parsed.data.sourceLang });
		await workspaceAccessStore.requireScopedPermission(parsed.data.workspaceId, user.userId, "update_project", { language: parsed.data.targetLang });
		if (parsed.data.projectId) {
			await workspaceAccessStore.requireScopedPermission(parsed.data.workspaceId, user.userId, "update_project", { projectId: parsed.data.projectId });
		}
		const entry = await getTranslationMemoryService().addEntry({
			workspaceId: parsed.data.workspaceId,
			sourceText: parsed.data.sourceText,
			sourceLang: parsed.data.sourceLang,
			targetText: parsed.data.targetText,
			targetLang: parsed.data.targetLang,
			contextNote: parsed.data.contextNote,
			projectId: parsed.data.projectId,
			createdBy: user.userId,
		});
		return c.json({ entry }, 201);
	} catch (error) {
		return handleError(c, error);
	}
});

// POST /api/tm/search — vector-fuzzy search. Body: { workspaceId, q, from, to, limit? }.
// The source text + language pair are in the BODY (never the URL) so licensed/user
// text does not leak into telemetry, access logs, or browser/proxy history.
// Requires read_workspace membership AND that both languages are inside the
// caller's member scope (requireScopedPermission), so a language-scoped
// contractor cannot read TM for languages they were not assigned.
tm.post("/search", async (c) => {
	const user = getAuthUser(c) as JWTPayload | undefined;
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = searchSchema.safeParse(raw.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const { workspaceId, q, from, to, limit } = parsed.data;
	if (!isValidWorkspaceId(workspaceId)) {
		return c.json({ error: "Invalid or missing workspace", code: "invalid_workspace_id" }, 400);
	}

	if (!workspaceAccessStore) {
		return c.json({ error: "Workspace store is not configured", code: "workspace_store_unavailable" }, 503);
	}

	try {
		// Authz: reading TM requires workspace membership, and the caller's language
		// scope must allow BOTH the source and target language of the query. A
		// scoped contractor restricted to e.g. `languages: ["ja"]` cannot pull TM
		// for an unrelated pair. We check `from` and `to` separately because either
		// side can fall outside the member's assigned languages.
		await workspaceAccessStore.requireScopedPermission(workspaceId, user.userId, "read_workspace", { language: from });
		await workspaceAccessStore.requireScopedPermission(workspaceId, user.userId, "read_workspace", { language: to });
		const results = await getTranslationMemoryService().search({
			workspaceId,
			sourceText: q,
			sourceLang: from,
			targetLang: to,
			limit,
		});
		return c.json({ results });
	} catch (error) {
		return handleError(c, error);
	}
});

export { tm };
