import type { Context, MiddlewareHandler, Next } from "hono";
import { serverConfig } from "../config.js";
import { securityGuardRejections } from "./metrics.js";
import { verifyCsrfToken } from "../services/csrf.js";

type ApiGuardReason =
	| "auth_required"
	| "origin_required"
	| "origin_not_allowed"
	| "csrf_required"
	| "request_body_too_large";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class RequestBodyLimitError extends Error {
	constructor(readonly limitBytes: number) {
		super("Request body too large");
		this.name = "RequestBodyLimitError";
	}
}

export function protectedApiAuthGuard(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		if (!shouldRequireAuth(c)) {
			await next();
			return;
		}
		if (c.get("user")) {
			await next();
			return;
		}
		return rejectGuard(c, "auth_required", 401);
	};
}

export function originGuard(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		if (!serverConfig.apiOriginGuardEnabled || !isStateChanging(c) || isPublicApiPath(c.req.path)) {
			await next();
			return;
		}

		const origin = c.req.header("origin") ?? extractOriginFromReferer(c.req.header("referer"));
		if (!origin) {
			if (hasBearerAuthorization(c)) {
				await next();
				return;
			}
			return rejectGuard(c, "origin_required", 403);
		}

		if (!isAllowedOrigin(origin)) {
			return rejectGuard(c, "origin_not_allowed", 403);
		}

		await next();
	};
}

export function csrfGuard(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		if (
			!serverConfig.apiCsrfRequired
			|| !isStateChanging(c)
			|| isPublicApiPath(c.req.path)
			|| hasBearerAuthorization(c)
		) {
			await next();
			return;
		}

		const user = c.get("user") as { userId?: string } | undefined;
		const userId = user?.userId ?? "anonymous";
		const token = c.req.header("x-csrf-token") ?? c.req.header("x-xsrf-token");
		if (!verifyCsrfToken(token, userId)) {
			return rejectGuard(c, "csrf_required", 403);
		}

		await next();
	};
}

export function requestSizeGuard(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		const limit = getRequestSizeLimit(c);
		if (!limit) {
			await next();
			return;
		}

		const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
		// Fast path: a declared-oversized Content-Length is rejected up front,
		// before we read (or wrap) the body at all.
		if (Number.isFinite(contentLength) && contentLength > limit) {
			return requestBodyTooLarge(c, limit);
		}

		// For every guarded request that actually carries a body, enforce the cap
		// against the real streamed byte count — not just the declared
		// Content-Length. A finite-but-lying Content-Length (declares 1KB, streams
		// 1GB) would otherwise sail past the early check above and OOM the handler
		// inside formData(). Wrapping the stream makes the limit authoritative
		// regardless of what the header claims, while small/legit bodies pay only
		// a constant-time per-chunk byte add.
		if (c.req.raw.body) {
			c.req.raw = withBodyLimit(c.req.raw, limit);
			try {
				await next();
			} catch (error) {
				if (error instanceof RequestBodyLimitError) {
					return requestBodyTooLarge(c, limit);
				}
				throw error;
			}
			return;
		}

		await next();
	};
}

export function isAllowedOrigin(origin: string, allowedOrigins = serverConfig.allowedOrigins): boolean {
	const normalizedOrigin = normalizeOrigin(origin);
	if (!normalizedOrigin) return false;

	const allowed = parseAllowedOrigins(allowedOrigins);
	if (allowed.includes("*")) {
		return process.env.NODE_ENV !== "production";
	}
	return allowed.some((candidate) => normalizeOrigin(candidate) === normalizedOrigin);
}

export function parseAllowedOrigins(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	return trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function getRequestSizeLimit(c: Context): number | null {
	if (SAFE_METHODS.has(c.req.method.toUpperCase())) return null;
	const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
	if (contentType.includes("application/json")) return serverConfig.maxJsonBodySizeBytes;
	// Both the raw upload and the merge/split transform upload buffer the whole
	// multipart body via formData() before any per-file/per-batch 413, so both
	// need the streaming/Content-Length body cap. Matching only /upload left
	// /upload-transform unguarded (memory-DoS). They share the same per-upload
	// batch limit.
	if (c.req.method === "POST" && /^\/api\/images\/[^/]+\/upload(?:-transform)?$/.test(c.req.path)) {
		return serverConfig.maxUploadBatchSizeBytes;
	}
	// The cleaned-chapter import buffers the whole multipart ZIP via formData()
	// before any per-entry limit — without the streaming cap a chunked/no-CL
	// body is fully resident before validation (codex P1). Same batch limit as
	// uploads; the route's own projected-bytes cap then applies post-parse.
	if (c.req.method === "POST" && /^\/api\/import\/cleaned\/[^/]+$/.test(c.req.path)) {
		return serverConfig.maxUploadBatchSizeBytes;
	}
	// The export-artifact upload (POST /api/project/:id/exports/:runId/artifact)
	// also buffers the whole multipart body via formData()/arrayBuffer() BEFORE any
	// quota enforcement, so without a cap a client could stream a huge body and
	// OOM the handler before being rejected (memory DoS). Cap it on the same
	// per-upload batch limit so the size check happens before buffering — quota is
	// then enforced on the (now bounded) body.
	if (c.req.method === "POST" && /^\/api\/project\/[^/]+\/exports\/[^/]+\/artifact$/.test(c.req.path)) {
		return serverConfig.maxUploadBatchSizeBytes;
	}
	return null;
}

function shouldRequireAuth(c: Context): boolean {
	if (!c.req.path.startsWith("/api/") || isPublicApiPath(c.req.path)) return false;
	if (serverConfig.apiAuthRequired) return true;
	return serverConfig.apiMutationAuthRequired && isProtectedMutationPath(c);
}

function isPublicApiPath(path: string): boolean {
	return path === "/api/health"
		|| path === "/api/readyz"
		|| path === "/api/auth/login"
		|| path === "/api/auth/register"
		|| path === "/api/auth/refresh"
		|| path === "/api/auth/logout-cookie"
		|| path === "/api/auth/csrf"
		// Account-recovery endpoints are unauthenticated by design: a locked-out
		// user has no access token and reaches them straight from an emailed link.
		// They must bypass protectedApiAuthGuard/csrfGuard, otherwise hardened/prod
		// configs (apiAuthRequired/apiCsrfRequired) reject them with 401/403 before
		// the route handler runs. Single-use, hashed tokens + per-email/per-IP
		// throttling provide the abuse protection here, not the API auth guard.
		|| path === "/api/auth/forgot-password"
		|| path === "/api/auth/reset-password"
		|| path === "/api/auth/verify-email"
		|| path === "/api/ai/capabilities"
		|| path === "/api/usage/plans/catalog"
		|| path === "/api/billing/dodo/webhook"
		// Consent capture must work for anonymous visitors (cookie banner runs
		// before login). Auth is captured opportunistically by optionalAuth.
		|| path === "/api/consent/events"
		// Signed export download links are forwardable from email and must work
		// without a session header. Signature + expiry are the access proof.
		|| /^\/api\/account\/export\/[^/]+\/download$/.test(path)
		// Account restore is opened from the deletion-confirmation email in a
		// logged-out browser. The signed restore token (?user&token) is the
		// access proof and is verified inside the route handler, so the request
		// must reach it even when auth-required mode is enabled.
		|| path === "/api/account/restore"
		// Realtime SSE event stream: EventSource cannot attach an Authorization
		// header, so the path is gated by a short-lived query-param SSE token
		// minted by /api/realtime/token (which DOES require regular JWT auth).
		// The token validation lives inside the route handler in
		// routes/realtime.ts.
		|| /^\/api\/realtime\/workspaces\/[^/]+\/events$/.test(path)
		// SSO endpoints must be reachable before the user holds a session: the
		// OAuth start/callback redirects and the email-match link confirmation all
		// run while the visitor is unauthenticated.
		|| isPublicSsoAuthPath(path);
}

// Matches the unauthenticated SSO surface:
//   /api/auth/sso/:provider/start
//   /api/auth/sso/:provider/callback
//   /api/auth/sso/link/confirm
function isPublicSsoAuthPath(path: string): boolean {
	return /^\/api\/auth\/sso\/[^/]+\/(?:start|callback)$/.test(path)
		|| path === "/api/auth/sso/link/confirm";
}

function isProtectedMutationPath(c: Context): boolean {
	if (!isStateChanging(c)) return false;
	if (c.req.path.startsWith("/api/auth/")) return !isPublicApiPath(c.req.path);
	if (c.req.path.startsWith("/api/project/")) return true;
	if (c.req.path.startsWith("/api/images/")) return true;
	if (c.req.path.startsWith("/api/ai/")) return true;
	// Cleaned-chapter import mutates project state + assets — same auth posture
	// as /api/project + /api/images mutations (codex P2).
	if (c.req.path.startsWith("/api/import/")) return true;
	if (c.req.path.startsWith("/api/usage/") && c.req.path.endsWith("/export")) return true;
	return false;
}

function isStateChanging(c: Context): boolean {
	return !SAFE_METHODS.has(c.req.method.toUpperCase());
}

function hasBearerAuthorization(c: Context): boolean {
	return c.req.header("authorization")?.trim().toLowerCase().startsWith("bearer ") ?? false;
}

function extractOriginFromReferer(referer: string | undefined): string | undefined {
	if (!referer) return undefined;
	try {
		return new URL(referer).origin;
	} catch {
		return undefined;
	}
}

function normalizeOrigin(origin: string): string | null {
	try {
		return new URL(origin).origin.toLowerCase();
	} catch {
		return null;
	}
}

function withBodyLimit(request: Request, limit: number): Request {
	const body = request.body;
	if (!body) return request;
	let total = 0;
	const limitedBody = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			total += chunk.byteLength;
			if (total > limit) {
				controller.error(new RequestBodyLimitError(limit));
				return;
			}
			controller.enqueue(chunk);
		},
	}));
	return new Request(request, {
		body: limitedBody,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
}

function requestBodyTooLarge(c: Context, limit: number): Response {
	recordGuardRejection(c, "request_body_too_large");
	return c.json({
		error: "Request body too large",
		code: "request_body_too_large",
		limitBytes: limit,
	}, 413);
}

function rejectGuard(c: Context, reason: ApiGuardReason, status: 401 | 403): Response {
	recordGuardRejection(c, reason);
	return c.json({
		error: reason === "auth_required"
			? "Authentication required"
			: reason === "csrf_required"
				? "CSRF token required"
				: "Request origin rejected",
		code: reason,
	}, status);
}

function recordGuardRejection(c: Context, reason: ApiGuardReason): void {
	securityGuardRejections.inc({
		reason,
		method: c.req.method.toUpperCase(),
	});
}
