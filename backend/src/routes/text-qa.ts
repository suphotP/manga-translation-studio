// Routes: background text-QA (typo / spacing / grammar / punctuation) for
// translated text layers. gpt-4o-mini, structured issues, SHA cache, per-user
// daily free character budget.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod/v4";
import { getAuthUser } from "../middleware/auth.middleware.js";
import { getTrustedClientIp } from "../utils/client-ip.js";
import { resolveProjectState } from "../utils/project-state-file.js";
import type { JWTPayload } from "../types/auth.js";
import { resolveWorkspacePlanIdForProject } from "../services/billing-store.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import {
	TextQaProviderError,
	TextQaQuotaExceededError,
	buildTextQaQuotaSummary,
	checkTextQa,
	isTextQaConfigured,
} from "../services/text-qa.js";

const textQa = new Hono();

const checkSchema = z.object({
	text: z.string().max(8000),
	lang: z.string().trim().min(1).max(16).optional(),
	// Optional: lets a caller editing a known project bill the check against that
	// project's workspace plan (so paid workspaces get their larger daily budget).
	// Plan resolution is gated on verified project access below.
	projectId: z.string().trim().min(1).max(200).optional(),
});

function resolveActorUserId(c: Context): string | undefined {
	const user = getAuthUser(c) as JWTPayload | undefined;
	const userId = user?.userId?.trim();
	return userId ? userId : undefined;
}

// Per-user daily budget needs a stable id even for anonymous prototype use;
// fall back to the trusted client IP so one anonymous client can't drain the
// whole shared "anonymous" bucket and DoS everyone else's free quota.
//
// Use getTrustedClientIp() rather than reading x-forwarded-for / x-real-ip
// directly: those proxy headers are client-controlled and only honoured when
// proxy trust is explicitly enabled. Reading them raw would let an anonymous
// caller rotate spoofed headers to mint a fresh daily bucket per request and
// defeat the provider cost guard. When proxy trust is off this resolves to the
// real socket address instead.
function resolveQuotaSubject(c: Context): string {
	const userId = resolveActorUserId(c);
	if (userId) return userId;
	const ip = getTrustedClientIp(c);
	return ip ? `ip:${ip}` : "anonymous";
}

// Resolve the workspace plan id that should drive this caller's daily budget.
//
// A plan is only resolved when the caller passes a projectId AND actually has
// access to that project, mirroring the ownership rule used elsewhere (the
// project is anonymous, or it belongs to the authenticated caller). This is the
// fix for the "resolve quota plan per workspace" finding: without it every
// caller fell back to the global WORKSPACE_PLAN_ID / free default, so paid
// workspaces were capped at the free budget and a global env override could
// leak paid-tier quota to unrelated free workspaces. Gating on access prevents
// a caller from borrowing another workspace's paid plan. Returns undefined when
// no project is supplied or access fails — callers then fall back to the
// catalog default, preserving today's behaviour for anonymous/global use.
async function resolveQuotaPlanId(c: Context, projectId: string | undefined): Promise<string | undefined> {
	const normalized = projectId?.trim();
	if (!normalized) return undefined;
	// Catalog-authoritative, tombstone-aware: under Postgres the catalog row wins; a
	// deleted project must not re-grant its workspace's paid budget via a stale
	// state.json.
	const state = await resolveProjectState(normalized);
	if (!state) return undefined;
	const actorUserId = resolveActorUserId(c);
	const workspaceId = state.workspaceId?.trim();

	// SECURITY (cross-tenant paid-quota borrow): a workspace project has a
	// `workspaceId` and usually NO per-user `userId`. The old `state.userId &&
	// state.userId !== actorUserId` guard therefore did NOTHING for workspace
	// projects, so any user who guessed a workspace project id could resolve that
	// workspace's (possibly paid) plan and consume its larger Text-QA daily budget.
	// Gate workspace plan resolution on real project/workspace membership.
	if (workspaceId) {
		if (!actorUserId) return undefined;
		if (!projectCatalogStore) return undefined;
		const allowed = await projectCatalogStore.canAccessProject({
			projectId: normalized,
			userId: actorUserId,
			permission: "read:project",
		});
		if (!allowed) return undefined;
		return (await resolveWorkspacePlanIdForProject(normalized, { workspaceId })) ?? undefined;
	}

	// Owned (personal) project must match the caller; anonymous (no userId, no
	// workspaceId) projects are open in prototype mode. Reject cross-user access
	// so a free user can't claim someone else's larger budget by passing their id.
	if (state.userId && state.userId !== actorUserId) return undefined;
	return (await resolveWorkspacePlanIdForProject(normalized, { workspaceId: state.workspaceId })) ?? undefined;
}

// POST /api/text-qa/check { text, lang } → { issues, cached, quota }
textQa.post("/check", async (c) => {
	const raw = await c.req.json().catch(() => null);
	const parsed = checkSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const subject = resolveQuotaSubject(c);
	const planId = await resolveQuotaPlanId(c, parsed.data.projectId);

	try {
		const result = await checkTextQa({
			text: parsed.data.text,
			lang: parsed.data.lang ?? "en",
			userId: subject,
			planId,
		});
		const quota = await buildTextQaQuotaSummary({ userId: subject, planId });
		return c.json({
			issues: result.issues,
			cached: result.cached,
			model: result.model,
			lang: result.lang,
			quota,
		});
	} catch (error) {
		if (error instanceof TextQaQuotaExceededError) {
			return c.json({
				error: error.message,
				code: error.code,
				quota: error.summary,
			}, 402);
		}
		if (error instanceof TextQaProviderError) {
			// Map text-too-long to 413, missing/disabled config to 503, otherwise 502.
			const status = error.statusCode === 413 ? 413
				: error.statusCode === 503 ? 503
				: error.statusCode === 429 ? 429
				: 502;
			if (error.retryable) c.header("Retry-After", "5");
			return c.json({
				error: error.message,
				code: "text_qa_provider_error",
				retryable: error.retryable,
			}, status as any);
		}
		throw error;
	}
});

// GET /api/text-qa/quota?projectId=… → current daily budget for the caller,
// reflecting the project's workspace plan when an accessible projectId is given.
textQa.get("/quota", async (c) => {
	const subject = resolveQuotaSubject(c);
	const planId = await resolveQuotaPlanId(c, c.req.query("projectId"));
	const quota = await buildTextQaQuotaSummary({ userId: subject, planId });
	return c.json({ enabled: isTextQaConfigured(), quota });
});

export { textQa };
