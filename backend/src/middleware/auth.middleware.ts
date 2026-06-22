// Authentication middleware for Hono - JWT verification & RBAC

import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { isSessionActive, loadUser, REFRESH_TOKEN_COOKIE_NAME, verifyAccessToken } from "../services/auth.service.js";
import type { AuthIdentityProvider, JWTPayload, UserRole } from "../types/auth.js";
import { hasPermission } from "../types/auth.js";
import { readOptionalJsonBody } from "../utils/request-body.js";

const AUTH_IDENTITY_PROVIDERS: readonly AuthIdentityProvider[] = ["local", "auth0", "oidc", "saml", "google", "github", "line"];

function asAuthIdentityProvider(value: unknown): AuthIdentityProvider | undefined {
	return typeof value === "string" && (AUTH_IDENTITY_PROVIDERS as readonly string[]).includes(value)
		? (value as AuthIdentityProvider)
		: undefined;
}

// ── Authentication Middleware ─────────────────────────────────────

/**
 * Verify JWT token and attach user to context
 */
export async function authMiddleware(c: Context, next: Next) {
	const token = readAccessToken(c);

	if (!token) {
		return c.json({ error: "Unauthorized: No token provided" }, 401);
	}

	const payload = verifyAccessToken(token);

	if (!payload) {
		return c.json({ error: "Unauthorized: Invalid token" }, 401);
	}

	const currentUser = await loadUser(payload.userId);
	if (!currentUser || !currentUser.isActive) {
		return c.json({ error: "Unauthorized: User not found or inactive" }, 401);
	}

	if (isAccessTokenStale(payload, currentUser.tokensValidFromMs)) {
		return c.json({ error: "Unauthorized: Token revoked" }, 401);
	}

	// Per-session revocation: an access token carries the id (`sid`) of the refresh
	// session it was minted with. If that session has been revoked (DELETE
	// /sessions/:id, logout, or rotated away) the access token must stop working
	// immediately instead of lingering until its own expiry. Tokens minted before
	// `sid` existed have no sid and skip this check (they age out normally).
	if (typeof payload.sid === "string" && !(await isSessionActive(payload.userId, payload.sid))) {
		return c.json({ error: "Unauthorized: Session revoked" }, 401);
	}

	// Attach user info to context
	c.set("user", {
		userId: currentUser.id,
		email: currentUser.email,
		role: currentUser.role,
		// Live verification status from the row we just loaded — carried so the verify-wall
		// gate (blockUnverifiedMutations) needs no second lookup. Not a signed claim.
		emailVerified: currentUser.emailVerified,
		sid: payload.sid,
		iat: payload.iat,
		exp: payload.exp,
	});
	await next();
}

/**
 * Reject access tokens that were issued before the user's session-invalidation
 * watermark (set on password reset/change, account disable, or admin email
 * change). The watermark (`tokensValidFromMs`) is the wall-clock ms at the time
 * of the event.
 *
 * Tokens minted after this hardening carry `iatMs` (ms-precision mint time), so
 * we compare EXACTLY: any token minted strictly before the watermark is rejected,
 * while a token the recovered user immediately re-issues (minted at/after the
 * watermark, even in the same second) stays valid. This closes the same-second
 * survival window that the second-granularity `iat` check left open.
 *
 * Legacy tokens minted before `iatMs` existed fall back to the floored-second
 * `iat` comparison; their residual sub-second window is unavoidable but they age
 * out within one access-token lifetime.
 */
export function isAccessTokenStale(payload: JWTPayload, tokensValidFromMs?: number): boolean {
	if (!tokensValidFromMs) return false;
	if (typeof payload.iatMs === "number") {
		return payload.iatMs < tokensValidFromMs;
	}
	if (typeof payload.iat !== "number") return true;
	return payload.iat < Math.floor(tokensValidFromMs / 1000);
}

/**
 * Optional authentication - doesn't fail if no token
 */
export async function optionalAuth(c: Context, next: Next) {
	if (c.get("user")) {
		await next();
		return;
	}

	const token = readAccessToken(c);
	if (token) {
		const payload = verifyAccessToken(token);
		if (payload) {
			const currentUser = await loadUser(payload.userId);
			const sessionOk = typeof payload.sid !== "string" || (await isSessionActive(payload.userId, payload.sid));
			if (currentUser?.isActive && !isAccessTokenStale(payload, currentUser.tokensValidFromMs) && sessionOk) {
				c.set("user", {
					userId: currentUser.id,
					email: currentUser.email,
					role: currentUser.role,
					emailVerified: currentUser.emailVerified,
					sid: payload.sid,
					iat: payload.iat,
					exp: payload.exp,
				});
			}
		}
	}

	await next();
}

// ── Role-Based Access Control Middleware ────────────────────────

/**
 * Require specific role
 */
export function requireRole(...roles: UserRole[]) {
	return async (c: Context, next: Next) => {
		const user = c.get("user") as JWTPayload | undefined;

		if (!user) {
			return c.json({ error: "Unauthorized: No user found" }, 401);
		}

		if (!roles.includes(user.role)) {
			return c.json({ error: "Forbidden: Insufficient permissions" }, 403);
		}

		await next();
	};
}

/**
 * Require specific permission
 */
export function requirePermission(permission: string) {
	return async (c: Context, next: Next) => {
		const user = c.get("user") as JWTPayload | undefined;

		if (!user) {
			return c.json({ error: "Unauthorized: No user found" }, 401);
		}

		if (!hasPermission(user.role, permission)) {
			return c.json({ error: `Forbidden: Missing permission '${permission}'` }, 403);
		}

		await next();
	};
}

/**
 * Require a platform super-admin role. `owner` is a strict superset of `admin`
 * (it can do everything admin can plus assign platform roles), so legacy
 * admin-only gates (auth user-mgmt, credit grants, AI config, billing) must
 * admit `owner` too — otherwise the platform owner is locked out of surfaces a
 * plain admin can use. Finer-grained back-office gating uses
 * requirePermission(...) against ROLE_PERMISSIONS instead of this coarse role
 * check.
 */
export const requireAdmin = requireRole("owner", "admin");

/**
 * Require editor or admin role
 */
export const requireEditor = requireRole("owner", "admin", "editor");

export async function requireEmailVerified(c: Context, next: Next) {
	const user = c.get("user") as JWTPayload | undefined;
	if (!user) {
		return c.json({ error: "Unauthorized: No user found" }, 401);
	}
	const currentUser = await loadUser(user.userId);
	if (!currentUser || !currentUser.isActive) {
		return c.json({ error: "Unauthorized: User not found or inactive" }, 401);
	}
	if (!currentUser.emailVerified) {
		return c.json({
			error: "Email verification required",
			code: "email_not_verified",
		}, 403);
	}
	await next();
}

/**
 * Mutation routes an authenticated-but-UNVERIFIED user is still allowed to call.
 * Everything else that writes (POST/PUT/PATCH/DELETE) is blocked for them by
 * `blockUnverifiedMutations`. Keep this list tight — it is the ONLY escape hatch
 * through the wall, so it must cover exactly the flows needed to verify, recover,
 * or abandon the account and nothing else.
 *
 * It is an EXACT allowlist, NOT a `/api/auth/*` prefix: the auth router also hosts
 * admin user-management mutations (`PATCH|DELETE /api/auth/users/:id`,
 * `/api/auth/users/:id/disable|enable`) plus self-service `PATCH /api/auth/me` and
 * `/api/auth/change-password`. A blanket prefix would let an unverified admin (or any
 * unverified user, for the self routes) punch those writes through the wall. Only the
 * verification / recovery / session endpoints belong here.
 *
 * register/login are deliberately NOT listed: they are pre-auth flows, so an
 * unauthenticated caller already passes the wall (no context user). Exempting them would
 * only matter for an ALREADY-authenticated unverified user, and the register handler can
 * assign platform roles in the owner/admin case — exempting it would let an unverified
 * privileged account mint new privileged users straight through the wall. POST
 * /api/account/export is likewise excluded: no value for an unverified account, and exactly
 * what created orphaned export jobs.
 */
const UNVERIFIED_AUTH_MUTATIONS = new Set<string>([
	"/api/auth/forgot-password",
	"/api/auth/reset-password",
	"/api/auth/verify-email",
	"/api/auth/verify-otp",
	"/api/auth/resend-verification",
	"/api/auth/refresh",
	"/api/auth/logout",
	"/api/auth/logout-cookie",
	"/api/auth/sso/link/confirm",
	"/api/auth/sso/exchange",
]);

function isUnverifiedAllowedMutation(rawPath: string, method: string): boolean {
	// Normalize a single trailing slash so "/api/account/" matches "/api/account".
	const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
	if (UNVERIFIED_AUTH_MUTATIONS.has(path)) return true;
	// Revoke one of your OWN refresh sessions: DELETE /api/auth/sessions/:id.
	if (method === "DELETE" && path.startsWith("/api/auth/sessions/")) return true;
	// Cookie consent is recorded pre-/post-login and writes no app data.
	if (path === "/api/consent" || path.startsWith("/api/consent/")) return true;
	// Give up the account, or undo a soft-delete inside its restore grace window.
	if (method === "DELETE" && path === "/api/account") return true;
	if (method === "POST" && path === "/api/account/restore") return true;
	return false;
}

/**
 * The verify WALL, enforced at the backend (the frontend guard is UX-only and a
 * direct API caller bypasses it). An authenticated user whose email is not verified
 * may READ (GET/HEAD/OPTIONS) and use the tightly-scoped allowlist above, but every
 * other mutation is rejected with 403 `email_not_verified`. This both completes the
 * wall the product requires and stops unverified sessions from writing the ~dozens of
 * user-scoped tables (contacts, notification prefs, export jobs, …) that have no
 * cascading FK and would otherwise orphan when the cleanup cron reaps the account.
 *
 * Cost: zero extra DB work — `emailVerified` is read from the context user that
 * authMiddleware/optionalAuth already stamped from the row they loaded. Unauthenticated
 * requests (login/register/public) carry no context user and pass straight through; auth
 * enforcement itself is handled separately by protectedApiAuthGuard.
 */
export async function blockUnverifiedMutations(c: Context, next: Next) {
	const user = c.get("user") as JWTPayload | undefined;
	// No authenticated user, or a verified one (or a legacy context with the flag
	// unpopulated) → not our concern. We only block when verification is KNOWN false.
	if (!user || user.emailVerified !== false) {
		await next();
		return;
	}
	const method = c.req.method.toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
		await next();
		return;
	}
	if (isUnverifiedAllowedMutation(c.req.path, method)) {
		await next();
		return;
	}
	return c.json({
		error: "Email verification required",
		code: "email_not_verified",
	}, 403);
}

/**
 * Get authenticated user from context
 */
export function getAuthUser(c: Context): JWTPayload | undefined {
	return c.get("user");
}

/**
 * Resolve the caller's user id from a presented access token for the ONE narrow
 * case where the standard auth gates would (correctly) reject them but we still
 * need to prove who they are: a soft-deleted account undoing its own deletion.
 *
 * A soft-deleted user is `isActive=false`, their refresh sessions are revoked,
 * and (post-hardening) their `tokensValidFromMs` watermark is bumped — so
 * `authMiddleware` / `optionalAuth` will NOT attach them. The GDPR restore flow
 * still needs an authenticated path for an in-app "undo" button that does not
 * carry the emailed HMAC restore token.
 *
 * This helper therefore verifies ONLY the JWT signature (proving the caller
 * genuinely minted this token) and returns the embedded userId. It deliberately
 * skips the isActive / watermark / sid active-session checks because those are
 * exactly what soft-delete trips. It grants NO access on its own: the caller
 * (restore route) must additionally require the resolved userId to equal the
 * pending-deletion target, so it can only ever restore the caller's OWN account,
 * and only while a pending soft-delete record exists within the grace window.
 *
 * Use ONLY for the restore endpoint. Every other route must use authMiddleware.
 */
export function resolveSoftDeletedRestoreCaller(c: Context): { userId: string } | undefined {
	const token = readAccessToken(c);
	if (!token) return undefined;
	const payload = verifyAccessToken(token);
	if (!payload || typeof payload.userId !== "string" || !payload.userId) return undefined;
	return { userId: payload.userId };
}

/**
 * Check if current user can access a specific project
 */
export function canAccessProject(c: Context, action: "create" | "read" | "update" | "delete"): boolean {
	const user = getAuthUser(c);
	if (!user) return false;

	const permission = `${action}:project`;
	return hasPermission(user.role, permission);
}

/**
 * Refresh token middleware
 */
export async function refreshAuthMiddleware(c: Context, next: Next) {
	const refreshToken = await readRefreshToken(c);
	if (refreshToken instanceof Response) return refreshToken;

	if (!refreshToken) {
		return c.json({ error: "Refresh token required" }, 400);
	}

	const { consumeRefreshSessionForRotation, generateTokens, loadUser, updateLastLogin } = await import("../services/auth.service.js");
	// Atomic consume-and-rotate: exactly one concurrent caller presenting the same
	// refresh token gets the session back (and proceeds to mint a successor); any
	// racing caller gets null here and is rejected. This makes refresh tokens
	// strictly single-use even under concurrency, so a replayed/duplicated refresh
	// cannot mint a second live session.
	const session = await consumeRefreshSessionForRotation(refreshToken);
	const userId = session?.userId;

	if (!userId) {
		return c.json({ error: "Invalid or expired refresh token" }, 401);
	}

	const user = await loadUser(userId);
	if (!user || !user.isActive) {
		return c.json({ error: "User not found or inactive" }, 401);
	}

	await updateLastLogin(userId);

	// Preserve the originating SSO provider so the rotated session is not
	// silently re-labelled as a local login in the session list.
	const provider = asAuthIdentityProvider(session?.metadata?.provider);
	const tokens = await generateTokens(user, { provider });
	c.set("newTokens", tokens);
	c.set("user", {
		userId: user.id,
		email: user.email,
		role: user.role,
	});

	await next();
}

async function readRefreshToken(c: Context): Promise<string | Response | undefined> {
	const cookieToken = getCookie(c, REFRESH_TOKEN_COOKIE_NAME);
	if (cookieToken) return cookieToken;

	const raw = await readOptionalJsonBody(c);
	if (!raw.ok) return raw.response;
	return typeof raw.data.refreshToken === "string" ? raw.data.refreshToken : undefined;
}

function readAccessToken(c: Context): string | null {
	const authHeader = c.req.header("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.substring(7);
	}
	return getCookie(c, "access_token") || null;
}
