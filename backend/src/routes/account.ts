// W2.6 — GDPR routes: data export + soft-delete + restore.
//
// All routes here are self-service (the authenticated user acts on their OWN
// account). The matching admin-side endpoints — listing other users' export
// jobs, force-deleting accounts — live in admin.ts behind requireAdmin.

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod/v4";
import { authMiddleware as defaultAuthMiddleware, getAuthUser, resolveSoftDeletedRestoreCaller } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import { readJsonBody } from "../utils/request-body.js";
import {
	buildAccountExportBundle,
	buildSignedExportUrl,
	gdprStore,
	verifyExportSignature,
	RestoreGraceExpiredError,
	type GdprStore,
} from "../services/gdpr.js";
import { invalidateAllUserAuth } from "../services/auth.service.js";
import { LastPlatformOwnerError } from "../services/auth-users.js";

// 30 days, matches the spec. Configurable via env so QA can shrink to seconds
// without changing code.
const DEFAULT_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function resolveGracePeriodMs(): number {
	const raw = process.env.ACCOUNT_DELETE_GRACE_PERIOD_MS?.trim();
	if (!raw) return DEFAULT_GRACE_PERIOD_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GRACE_PERIOD_MS;
}

export interface AccountRouterDeps {
	store?: GdprStore;
	processExportJob?: (jobId: string, userId: string) => Promise<void>;
	notifyExportReady?: (input: { userId: string; jobId: string; downloadUrl: string; expiresAt: number }) => Promise<void> | void;
	notifyDeleteScheduled?: (input: { userId: string; restoreUrl: string; deleteGraceUntil: string }) => Promise<void> | void;
	now?: () => number;
	/**
	 * Optional override of the auth middleware. Tests pass a stub that attaches
	 * a fixed user payload without going through JWT generation. The signed
	 * /export/:jobId/download route stays public regardless.
	 */
	authMiddleware?: (c: Context, next: Next) => Promise<unknown> | unknown;
}

const deleteSchema = z.object({
	reason: z.string().trim().max(2000).optional(),
}).strict().optional();

const restoreSchema = z.object({
	token: z.string().trim().min(8).max(200).optional(),
}).strict().optional();

export function createAccountRouter(deps: AccountRouterDeps = {}): Hono {
	const router = new Hono();
	const store = deps.store ?? gdprStore;
	const now = deps.now ?? Date.now;
	const authMiddleware = deps.authMiddleware ?? defaultAuthMiddleware;

	// Two routes must work without an Authorization header because they are
	// opened straight from an email link in a logged-out browser and carry their
	// own HMAC proof in the query string:
	//   * GET  /export/:jobId/download — signed signature + expiry
	//   * POST /restore                 — signed restore token (?user&token)
	// The route handlers below verify those tokens, so skipping auth here is
	// safe. Every other route requires auth. We match on the path tail so the
	// rule works whether this router is mounted under /api/account/* or invoked
	// directly in tests.
	router.use("*", async (c, next) => {
		const isSignedDownload = c.req.method === "GET" && /\/export\/[^/]+\/download$/.test(c.req.path);
		const isRestore = c.req.method === "POST" && /\/restore$/.test(c.req.path);
		if (isSignedDownload || isRestore) {
			await next();
			return;
		}
		return authMiddleware(c, next);
	});

	// Background "worker": gather the user's data, encode the artifact, expose a
	// signed URL. We run inline (no Redis) so the prototype works without the
	// extra moving piece. Production swaps this for a real queue job — the
	// route does not change.
	const processJob = deps.processExportJob ?? (async (jobId: string, userId: string) => {
		try {
			await store.updateExportJob(jobId, { status: "processing" });
			const bundle = await buildAccountExportBundle(userId);
			const { url, expiresAt } = buildSignedExportUrl(jobId);
			await store.updateExportJob(jobId, {
				status: "ready",
				zipUrl: url,
				expiresAt: new Date(expiresAt).toISOString(),
				bytes: bundle.bytes,
				completedAt: new Date().toISOString(),
			});
			if (deps.notifyExportReady) {
				await deps.notifyExportReady({ userId, jobId, downloadUrl: url, expiresAt });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Export failed";
			// GUARD: the failed-status write can itself throw (e.g. the same store
			// outage that failed the export is still live). If it did, the rejection
			// would escape the fire-and-forget `void processJob(...)` below with no
			// catcher — crashing the process on Node >=15 — AND the job would stay
			// stuck in "processing" forever. Swallow + log here so the worst case is
			// a stuck job that the export sweeper / a retry can reconcile, never a
			// crash. The outer `.catch` on the call site is the second layer of
			// defense in case some other unexpected throw escapes this block.
			try {
				await store.updateExportJob(jobId, {
					status: "failed",
					failureReason: message,
					completedAt: new Date().toISOString(),
				});
			} catch (writeError) {
				console.error(
					`[Account] Export job ${jobId} failed AND the failed-status write also failed; job may be stuck in 'processing': `,
					writeError,
				);
			}
		}
	});

	// POST /api/account/export — request a snapshot of all my data.
	router.post("/export", async (c) => {
		const user = requireUser(c);
		const recent = await store.listExportJobs(user.userId);
		const inflight = recent.find((job) => job.status === "queued" || job.status === "processing");
		if (inflight) {
			return c.json({ job: inflight, message: "Export already in progress" }, 200);
		}
		const job = await store.createExportJob(user.userId);
		// Fire-and-forget background work. Errors are captured into the job row,
		// so the API stays responsive even when the bundle is large. The `.catch`
		// is the last-resort backstop: processJob already guards its own writes,
		// but an unhandled rejection escaping a bare `void` would crash the process
		// on Node >=15 (@hono/node-server runs us under Node). Logging it here keeps
		// the process alive and surfaces the failure.
		processJob(job.id, user.userId).catch((err) => {
			console.error(`[Account] Unhandled error processing export job ${job.id}: `, err);
		});
		return c.json({ job }, 202);
	});

	// GET /api/account/export — history of my export requests.
	router.get("/export", async (c) => {
		const user = requireUser(c);
		const jobs = await store.listExportJobs(user.userId);
		return c.json({ jobs });
	});

	// GET /api/account/export/:jobId/download — signed link served straight from
	// the API. Treats the signature + expiry as the only access proof so the
	// signed URL is forwardable to a download manager without an auth header.
	router.get("/export/:jobId/download", async (c) => {
		const jobId = c.req.param("jobId");
		const expiresParam = c.req.query("expires");
		const signature = c.req.query("signature");
		if (!expiresParam || !signature) {
			return c.json({ error: "Signed download URL required", code: "missing_signature" }, 400);
		}
		const expiresAt = Number(expiresParam);
		if (!Number.isFinite(expiresAt)) {
			return c.json({ error: "Invalid expiry", code: "invalid_signature" }, 400);
		}
		if (expiresAt < now()) {
			return c.json({ error: "Download link expired", code: "expired" }, 410);
		}
		if (!verifyExportSignature(jobId, expiresAt, signature)) {
			return c.json({ error: "Invalid signature", code: "invalid_signature" }, 403);
		}
		const job = await store.getExportJob(jobId);
		if (!job || job.status !== "ready") {
			return c.json({ error: "Export not ready", code: "not_ready" }, 404);
		}
		// The prototype serves a JSON payload (the same shape an admin can
		// inspect). Production swaps this for a streamed ZIP from object
		// storage — the signed URL contract above is identical.
		const bundle = await buildAccountExportBundle(job.userId);
		return new Response(bundle.payload, {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Content-Disposition": `attachment; filename="${bundle.filename}"`,
				"Cache-Control": "no-store",
			},
		});
	});

	// DELETE /api/account — soft-delete with a grace window.
	router.delete("/", async (c) => {
		const user = requireUser(c);
		const raw = await readJsonBody(c);
		if (raw.ok) {
			const parsed = deleteSchema.safeParse(raw.data);
			if (!parsed.success) {
				return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
			}
		}
		let snapshot;
		try {
			snapshot = await store.softDeleteUser(user.userId, { gracePeriodMs: resolveGracePeriodMs() });
		} catch (error) {
			// Fail-closed: the platform's last active owner cannot self-delete, or
			// they would orphan the platform (zero active owners → permanent lockout).
			// The owner-protected store mutation threw before any change landed, so the
			// account is untouched (still role=owner, isActive=true, original email).
			if (error instanceof LastPlatformOwnerError) {
				return c.json({ error: error.message, code: "last_platform_owner" }, 403);
			}
			throw error;
		}
		if (!snapshot) {
			return c.json({ error: "User not found", code: "user_not_found" }, 404);
		}
		// SECURITY (soft-delete must cut LIVE access too): revoking refresh sessions
		// alone leaves any already-minted short-lived ACCESS JWT working until its
		// own expiry. invalidateAllUserAuth revokes every refresh session AND bumps
		// the user's tokensValidFromMs watermark, so authMiddleware rejects every
		// outstanding access token immediately — including a legacy no-`sid` token
		// that the per-session check cannot catch. (The account is also isActive=false
		// now, which the middleware rejects too; this is belt-and-suspenders so the
		// revocation does not rely on a single gate.)
		//
		// The narrow restore path in /restore stays usable: it authenticates the
		// soft-deleted caller from their access-token SIGNATURE only
		// (resolveSoftDeletedRestoreCaller), deliberately bypassing the watermark and
		// isActive/sid gates for that one self-restore action. So normal API access
		// is cut while "undo my deletion" still works.
		await invalidateAllUserAuth(user.userId);
		const restoreToken = signRestoreToken(user.userId, snapshot.deleteGraceUntil);
		const restoreUrl = `/account/restore?user=${user.userId}&token=${restoreToken}`;
		if (deps.notifyDeleteScheduled) {
			await deps.notifyDeleteScheduled({
				userId: user.userId,
				restoreUrl,
				deleteGraceUntil: snapshot.deleteGraceUntil,
			});
		}
		return c.json({
			ok: true,
			deletedAt: snapshot.deletedAt,
			deleteGraceUntil: snapshot.deleteGraceUntil,
			restoreUrl,
		});
	});

	// POST /api/account/restore — undo soft-delete within the grace window.
	//
	// This route is intentionally NOT behind authMiddleware (see the per-router
	// rule above) because the two legitimate callers both fail the normal gate:
	//   1. The emailed undo link, opened in a LOGGED-OUT browser, carrying the
	//      HMAC restore token in the query string.
	//   2. An in-app "undo" button from the just-soft-deleted session. That user
	//      is now isActive=false with revoked sessions + a bumped token watermark,
	//      so authMiddleware / optionalAuth will NOT attach them — yet they hold a
	//      validly-signed access token proving who they are.
	//
	// We authenticate caller (2) directly from their access-token SIGNATURE via
	// resolveSoftDeletedRestoreCaller (it skips the isActive/watermark/sid gates
	// precisely because soft-delete trips them), then require the resolved id to
	// equal the pending-deletion target. So the authenticated path can only ever
	// restore the CALLER'S OWN account, and only while a pending soft-delete
	// record exists inside the grace window. Token-bearing callers (1) never need
	// this and verify the HMAC instead.
	router.post("/restore", async (c) => {
		// getAuthUser covers the rare case where a caller is still active and
		// attached by the global optionalAuth; the signature-only resolver covers
		// the soft-deleted caller the normal gates reject.
		const attachedUser = getAuthUser(c);
		const signatureCaller = attachedUser ? undefined : resolveSoftDeletedRestoreCaller(c);
		const callerUserId = attachedUser?.userId ?? signatureCaller?.userId;
		const raw = await readJsonBody(c);
		const parsed = raw.ok ? restoreSchema.safeParse(raw.data) : { success: true as const, data: undefined };
		if (!parsed.success) {
			return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
		}
		const targetUserId = c.req.query("user") ?? callerUserId;
		if (!targetUserId) {
			return c.json({ error: "Missing user", code: "missing_user" }, 400);
		}
		const token = c.req.query("token") ?? parsed.data?.token;
		// Targeted PK lookup — this runs BEFORE the token check, so loading every pending
		// soft-delete platform-wide (the old listPendingSoftDeletes + find) was both O(all)
		// and an unauthenticated amplification vector on a public route.
		const record = await store.getPendingSoftDelete(targetUserId);
		if (!record) {
			return c.json({ error: "No pending deletion for this user", code: "not_pending" }, 404);
		}
		// RETENTION CONTRACT (P1): the undo window must still be OPEN before we
		// authenticate ANY restore path. A pending soft-delete marker can linger
		// past its grace window until the sweeper purges it; without this gate an
		// account could be reactivated AFTER expiry, right up until the purge —
		// resurrecting data we promised to erase. Enforce grace BEFORE either the
		// HMAC or signature-only token path so neither can revive an expired row.
		const graceUntilMs = Date.parse(record.deleteGraceUntil ?? "");
		if (Number.isNaN(graceUntilMs) || graceUntilMs <= now()) {
			return c.json({ error: "Restore window has expired", code: "grace_expired" }, 410);
		}
		if (token) {
			if (!verifyRestoreToken(targetUserId, record.deleteGraceUntil, token)) {
				return c.json({ error: "Invalid or expired restore token", code: "invalid_token" }, 403);
			}
		} else if (!callerUserId || callerUserId !== targetUserId) {
			// No HMAC token AND no self-authenticated caller for this exact account →
			// refuse. A soft-deleted user presenting their own valid access token for
			// their own userId reaches restoreUser; nobody else can.
			return c.json({ error: "Restore token required", code: "missing_token" }, 401);
		}
		try {
			const restored = await store.restoreUser(targetUserId);
			return c.json({ ok: restored });
		} catch (error) {
			// Defense in depth: restoreUser independently rejects an expired grace
			// window (the marker can elapse between our check above and this call).
			if (error instanceof RestoreGraceExpiredError) {
				return c.json({ error: "Restore window has expired", code: "grace_expired" }, 410);
			}
			throw error;
		}
	});

	return router;
}

function requireUser(c: { get: (key: "user") => JWTPayload | undefined }): JWTPayload {
	const user = c.get("user");
	if (!user) throw new Error("auth_required");
	return user;
}

// We reuse the HMAC posture from gdpr.ts for the restore token so the email's
// undo link cannot be forged. Scope is distinct from the export signature.
import { createHmac, timingSafeEqual } from "crypto";
import { serverConfig } from "../config.js";

const RESTORE_SIGNING_SCOPE = "gdpr-restore-v1";

function signRestoreToken(userId: string, deleteGraceUntil: string, secret = serverConfig.jwtSecret): string {
	return createHmac("sha256", secret)
		.update(`${RESTORE_SIGNING_SCOPE}:${userId}:${deleteGraceUntil}`)
		.digest("hex");
}

function verifyRestoreToken(userId: string, deleteGraceUntil: string, token: string, secret = serverConfig.jwtSecret): boolean {
	const expected = signRestoreToken(userId, deleteGraceUntil, secret);
	if (expected.length !== token.length) return false;
	try {
		return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"));
	} catch {
		return false;
	}
}

export const account = createAccountRouter();
