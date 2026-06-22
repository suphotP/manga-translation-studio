// Authentication routes - login, register, refresh, logout, user management

import { randomBytes } from "crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod/v4";
import {
	createExternalUser,
	createUser,
	EmailAlreadyExistsError,
	WeakPasswordError,
	InvalidCurrentPasswordError,
	findUserByEmail,
	findUserByExternalIdentity,
	comparePassword,
	dummyPasswordCompare,
	generateTokens,
	REFRESH_TOKEN_COOKIE_NAME,
	REFRESH_TOKEN_COOKIE_PATH,
	updateUser,
	updateUserProtectingLastOwner,
	validatePassword,
	changePassword,
	resetPasswordForUser,
	markEmailVerified,
	deleteUser,
	deleteUserProtectingLastOwner,
	loadUser,
	listUsersPaginated,
	updateLastLogin,
	revokeRefreshToken,
	revokeAllUserTokens,
	linkExternalIdentity,
	countActiveUsersByRole,
	PASSWORD_MAX_LENGTH,
} from "../services/auth.service.js";
import { decodeUserCursor, encodeUserCursor, parseUserLimit } from "../utils/user-list-cursor.js";
import { authMiddleware, requireAdmin, requirePermission, refreshAuthMiddleware, getAuthUser, optionalAuth } from "../middleware/auth.middleware.js";
import type { AuthTokens, JWTPayload, UserRole } from "../types/auth.js";
import { ADMIN_PERMISSIONS, hasPermission } from "../types/auth.js";
import { gdprStore } from "../services/gdpr.js";
import { readJsonBody, readOptionalJsonBody } from "../utils/request-body.js";
import { createCsrfToken } from "../services/csrf.js";
import { accountLockoutResponse, accountLockoutTracker } from "../middleware/account-lockout.js";
import {
	ADMIN_SELF_PROTECTION_REASON,
	AdminSelfProtectionError,
	assertLastOwnerMutationAllowed,
	assertOwnerTargetMutationAllowed,
	assertPlatformAdminSelfDeleteAllowed,
	assertPlatformAdminSelfUpdateAllowed,
	assertRoleAssignmentAllowed,
} from "../services/admin-protection.js";
import { LastPlatformOwnerError } from "../services/auth-users.js";
import { serverConfig, readMailerEnvConfig, readPositiveIntegerConfigValue } from "../config.js";
import { sendTransactionalEmail, type SendResult } from "../services/mailer.js";
import {
	auditAuthEvent,
	consumeUnusedToken,
	mintToken,
	storeMintedToken,
	verifyTokenRecord,
	mintEmailOtp,
	verifyEmailOtp,
	currentEmailOtpGeneration,
	EMAIL_OTP_TTL_MINUTES,
} from "../services/password-reset.js";
import { createSharedRateLimitStore, type RateLimitStore } from "../middleware/rate-limit.js";
import { getTrustedClientIp } from "../utils/client-ip.js";
import { workLockStore } from "../services/work-locks.js";
import { authSessionStore, hashSessionToken } from "../services/auth-sessions.js";
import { oauthLinkIntentStore } from "../services/oauth-link-intents.js";
import { SSO_PROVIDERS, createOAuthCodeVerifier, createOAuthState, isSsoProvider, oauthCookieName, providerToAuthIdentity, ssoOAuthClient, type NormalizedExternalIdentity, type SsoProvider } from "../services/sso-oauth.js";
import { turnstileVerify } from "../middleware/turnstile-verify.js";

const auth = new Hono();
const authFlowRateLimitStore: RateLimitStore = createSharedRateLimitStore();
const AUTH_FLOW_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60_000;
const AUTH_FLOW_RATE_LIMIT_MAX = 3;
// Email-OTP verification is brute-forceable (6 digits = 1e6 space), so attempts are
// capped per user in a short window. 8 tries / 15 min comfortably covers legitimate
// typos while holding guessing odds at ~8e-6 per code before a fresh one is required.
const VERIFY_OTP_RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const VERIFY_OTP_RATE_LIMIT_MAX = 8;
// Per-IP budget is higher than the per-email budget so shared NATs / offices can
// recover several distinct accounts, while still bounding lock-out abuse.
const FORGOT_PASSWORD_IP_RATE_LIMIT = 20;
const FORGOT_PASSWORD_MIN_RESPONSE_MS = 150;
// Per-IP, 24h-window cap that layers a longer horizon on top of the per-minute
// api:auth-register / layered rate-limit policy, to stop one source from mass creating
// accounts (the main OTP-send cost vector). Default 30 so a SHARED egress IP (office /
// school / cafe wifi / mobile CGNAT — many real people behind one IP) can onboard a normal
// group in a day without tripping it, while still crushing a bot flood (thousands/IP).
// Tunable per deployment via REGISTER_IP_RATE_LIMIT. Turnstile (#446) is the real bot gate;
// this is a defense-in-depth net, so it does not need to be aggressively low.
const REGISTER_IP_RATE_LIMIT = readPositiveIntegerConfigValue(process.env.REGISTER_IP_RATE_LIMIT, 30);
type AuthEmailSender = typeof sendTransactionalEmail;
let authEmailSender: AuthEmailSender = sendTransactionalEmail;

// Tracks reset emails dispatched off the response critical path. Tests await
// `flushPendingAuthEmails()` to deterministically observe the deferred send;
// production never awaits it, so the forgot-password response timing stays
// uniform regardless of transactional-provider latency.
const pendingAuthEmails = new Set<Promise<void>>();

// ── SSO one-time login code (token-in-URL hardening) ───────────────
//
// Historically the SSO callback redirected to the SPA with the access AND refresh
// tokens in the URL fragment. A URL fragment is browser-visible (history, ext.,
// referrer-on-some-paths, shoulder-surfing), so putting the long-lived refresh
// token there is a real exposure. When SSO_ONE_TIME_CODE=true the callback instead
// redirects with a single-use, short-lived opaque code; the SPA exchanges it once
// at POST /sso/exchange for the tokens (returned in the JSON body, never the URL).
// The httpOnly refresh+access cookies are set on the callback regardless.
//
// Default is ON (codex audit P1 fix): tokens are never placed in the URL
// fragment. The SPA exchanges the single-use code at POST /sso/exchange. An
// operator can opt back into the legacy fragment-token redirect by setting
// SSO_ONE_TIME_CODE=false. The code store is in-process, so the default path
// requires single-replica or sticky-session routing for the brief
// callback→exchange hop (documented for the rollout).
const SSO_ONE_TIME_CODE_TTL_MS = 60_000;

interface SsoLoginCodeRecord {
	user: PublicAuthUser;
	tokens: AuthTokens;
	expiresAt: number;
}

const ssoLoginCodes = new Map<string, SsoLoginCodeRecord>();

function ssoOneTimeCodeEnabled(): boolean {
	// Default ON: the hardened single-use-code path keeps access/refresh tokens
	// out of the URL fragment. An operator can opt back into the legacy
	// fragment-token redirect (e.g. for an old SPA that has not been updated) by
	// explicitly setting SSO_ONE_TIME_CODE=false/0.
	const raw = process.env.SSO_ONE_TIME_CODE;
	if (raw === undefined) return true;
	const normalized = raw.trim().toLowerCase();
	return !(normalized === "false" || normalized === "0" || normalized === "off" || normalized === "no");
}

function mintSsoLoginCode(user: PublicAuthUser, tokens: AuthTokens): string {
	pruneExpiredSsoLoginCodes();
	const code = `mews_sso_${randomBytes(32).toString("base64url")}`;
	ssoLoginCodes.set(code, { user, tokens, expiresAt: Date.now() + SSO_ONE_TIME_CODE_TTL_MS });
	return code;
}

function consumeSsoLoginCode(code: string): SsoLoginCodeRecord | null {
	pruneExpiredSsoLoginCodes();
	const record = ssoLoginCodes.get(code);
	if (!record) return null;
	// Single-use: delete on first read regardless of expiry outcome.
	ssoLoginCodes.delete(code);
	if (record.expiresAt <= Date.now()) return null;
	return record;
}

function pruneExpiredSsoLoginCodes(): void {
	const now = Date.now();
	for (const [code, record] of ssoLoginCodes) {
		if (record.expiresAt <= now) ssoLoginCodes.delete(code);
	}
}

auth.use("*", optionalAuth);

// ── Validation Schemas ───────────────────────────────────────

const AUTH_EMAIL_MAX_LENGTH = 254;

// Verification-side password bound: generous DoS ceiling for fields that CHECK
// an existing credential (login, change-password current, SSO link-confirm).
// PASSWORD_MAX_LENGTH (128) applies only to NEW passwords — an account created
// before the cap with a longer password must stay signable, never locked out
// behind validation_failed (review #587 P2). bcrypt input stays bounded.
const PASSWORD_VERIFY_MAX_LENGTH = 1024;

const loginSchema = z.object({
	email: z.string().email("Invalid email address").max(AUTH_EMAIL_MAX_LENGTH, "Email too long"),
	// Cap credential inputs before lookup/bcrypt so oversized requests stay cheap.
	password: z.string().min(1, "Password required").max(PASSWORD_VERIFY_MAX_LENGTH, "password_max_length"),
});

const registerSchema = z.object({
	email: z.string().email("Invalid email address").max(AUTH_EMAIL_MAX_LENGTH, "Email too long"),
	// Just non-empty here — validatePassword (in createUser) is the single source of strength
	// truth, so EVERY strength failure (incl. min-length) returns the typed weak_password +
	// rule codes, not a generic validation_failed for short passwords only.
	password: z.string().min(1, "Password is required").max(PASSWORD_MAX_LENGTH, "password_max_length"),
	name: z.string().min(1, "Name required").max(200, "Name too long"),
	role: z.enum(["owner", "admin", "support", "accountant", "editor", "viewer"]).optional(),
});

const changePasswordSchema = z.object({
	oldPassword: z.string().min(1, "Current password required").max(PASSWORD_VERIFY_MAX_LENGTH, "password_max_length"),
	newPassword: z.string().min(1, "New password is required").max(PASSWORD_MAX_LENGTH, "password_max_length"),
});

const userLocaleSchema = z.enum(["th", "en", "id", "ms"]);

// Self-service profile update. Email/role/isActive stay admin-only via
// PATCH /users/:id. UI locale is harmless preference state and needs to follow a
// signed-in user across devices.
const updateMyProfileSchema = z.object({
	name: z.string().trim().min(1, "Name required").max(200, "Name too long").optional(),
	locale: userLocaleSchema.optional(),
}).strict().refine((value) => value.name !== undefined || value.locale !== undefined, {
	message: "No profile changes supplied",
});

const forgotPasswordSchema = z.object({
	email: z.string().email("Invalid email address").max(AUTH_EMAIL_MAX_LENGTH, "Email too long"),
});

const resetPasswordSchema = z.object({
	token: z.string().trim().min(32, "Reset token required").max(256, "Reset token too long"),
	newPassword: z.string().min(1, "New password is required").max(PASSWORD_MAX_LENGTH, "password_max_length"),
});

const verifyEmailSchema = z.object({
	token: z.string().trim().min(32, "Verification token required").max(256, "Verification token too long"),
});

const verifyOtpSchema = z.object({
	code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

const updateUserSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	email: z.string().email().max(AUTH_EMAIL_MAX_LENGTH, "Email too long").optional(),
	role: z.enum(["owner", "admin", "support", "accountant", "editor", "viewer"]).optional(),
	isActive: z.boolean().optional(),
});

const linkConfirmSchema = z.object({
	link_intent_token: z.string().min(1, "Link intent token required"),
	// Required to confirm a link into a local (password-backed) account. SSO-only
	// accounts have no usable password and instead confirm with an authenticated
	// session belonging to the same user.
	currentPassword: z.string().min(1).max(PASSWORD_VERIFY_MAX_LENGTH, "password_max_length").optional(),
});

// ── Public Routes ─────────────────────────────────────────────

auth.get("/csrf", (c) => {
	const user = getAuthUser(c);
	return c.json({
		csrfToken: createCsrfToken(user?.userId ?? "anonymous"),
	});
});

// Public: lets the frontend render only the SSO buttons that are actually
// usable. A provider is "enabled" iff BOTH its client id and secret are
// configured (see isProviderConfigured). No auth required — the response only
// reveals which buttons to show, never any secret material.
auth.get("/sso/providers", (c) => {
	const providers = SSO_PROVIDERS.map((id) => ({
		id,
		name: SSO_PROVIDER_DISPLAY_NAMES[id],
		enabled: isProviderConfigured(id),
	}));
	// Server-config-derived, identical for every caller (used pre-login) — safe to share
	// in any cache; changes only on deploy/env, so a short TTL is plenty.
	c.header("Cache-Control", "public, max-age=120");
	return c.json({ providers });
});

auth.get("/sso/:provider/start", async (c) => {
	const provider = c.req.param("provider");
	if (!isSsoProvider(provider)) {
		return c.json({ error: "Unsupported SSO provider", code: "sso_provider_not_found" }, 404);
	}
	if (!isProviderConfigured(provider)) {
		return c.json({ error: "SSO provider is not configured", code: "sso_provider_unavailable" }, 503);
	}

	const state = createOAuthState();
	const codeVerifier = createOAuthCodeVerifier();
	setOAuthCookie(c, oauthCookieName("state", provider), state);
	setOAuthCookie(c, oauthCookieName("pkce", provider), codeVerifier);

	const url = ssoOAuthClient.createAuthorizationURL(provider, state, codeVerifier);
	return c.redirect(url.toString(), 302);
});

auth.get("/sso/:provider/callback", async (c) => {
	const provider = c.req.param("provider");
	if (!isSsoProvider(provider)) {
		return c.json({ error: "Unsupported SSO provider", code: "sso_provider_not_found" }, 404);
	}

	const code = c.req.query("code");
	const state = c.req.query("state");
	const expectedState = getCookie(c, oauthCookieName("state", provider));
	const codeVerifier = getCookie(c, oauthCookieName("pkce", provider));
	clearOAuthCookies(c, provider);

	if (!code || !state || !expectedState || state !== expectedState) {
		return c.json({ error: "OAuth state mismatch", code: "oauth_state_mismatch" }, 403);
	}
	if (!codeVerifier) {
		return c.json({ error: "OAuth PKCE verifier missing", code: "oauth_pkce_missing" }, 403);
	}

	try {
		const tokens = await ssoOAuthClient.validateAuthorizationCode(provider, code, codeVerifier);
		const identity = await ssoOAuthClient.fetchUserInfo(provider, tokens);
		const result = await linkOrCreateSsoUser(identity, getAuthUser(c)?.userId);
		if (result.kind === "link-needed") {
			return c.redirect(buildLinkNeededRedirect({
				provider,
				email: identity.email,
				linkIntentToken: result.linkIntentToken,
				linkMethod: result.linkMethod,
			}), 302);
		}

		const issued = await issueLogin(c, result.user, provider);
		return c.redirect(buildPostLoginRedirect(result.user, issued.tokens), 302);
	} catch (error) {
		const message = error instanceof Error ? error.message : "SSO callback failed";
		return c.json({ error: message }, 400);
	}
});

auth.post("/sso/link/confirm", async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = linkConfirmSchema.safeParse(raw.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const intent = await oauthLinkIntentStore.find(parsed.data.link_intent_token);
	if (!intent) {
		return c.json({ error: "Invalid or expired link intent token", code: "link_intent_invalid" }, 401);
	}
	const user = await loadUser(intent.userId);
	if (!user || !user.isActive) {
		return c.json({ error: "User not found or inactive" }, 404);
	}

	// Confirm ownership of the existing account before linking the new provider.
	// Local accounts confirm with their password. SSO-only accounts were seeded
	// with a random (never-disclosed) password hash, so a password check can
	// never succeed for them; they confirm instead with an authenticated session
	// that already belongs to the same user.
	if (user.authProvider === "local") {
		if (!parsed.data.currentPassword) {
			return c.json({ error: "Current password required" }, 400);
		}
		// This is a password-verification surface, so it must share the same
		// brute-force protection as /login. Without it, the link-confirm endpoint
		// is an unthrottled password oracle that bypasses account lockout entirely.
		const lockout = await accountLockoutTracker.check(user.email);
		if (lockout.locked) {
			return accountLockoutResponse(c, lockout);
		}
		const passwordValid = await comparePassword(parsed.data.currentPassword, user.passwordHash);
		if (!passwordValid) {
			const state = await accountLockoutTracker.recordFailure(user.email, clientIp(c));
			if (state.locked) return accountLockoutResponse(c, state);
			return c.json({ error: "Current password is incorrect", code: "current_password_incorrect" }, 401);
		}
		await accountLockoutTracker.clear(user.email);
	} else {
		const sessionUser = getAuthUser(c);
		if (!sessionUser || sessionUser.userId !== user.id) {
			return c.json({ error: "Sign in to the existing account before linking another provider" }, 401);
		}
	}
	const currentOwner = await findUserByExternalIdentity(intent.provider, intent.providerUserId);
	if (currentOwner && currentOwner.id !== user.id) {
		return c.json({ error: "External identity already linked to another user", code: "external_identity_taken" }, 409);
	}
	const consumedIntent = await oauthLinkIntentStore.consume(parsed.data.link_intent_token);
	if (!consumedIntent) {
		return c.json({ error: "Invalid or expired link intent token", code: "link_intent_invalid" }, 401);
	}

	let linked: Awaited<ReturnType<typeof linkExternalIdentity>>;
	try {
		linked = await linkExternalIdentity(user.id, {
			provider: consumedIntent.provider,
			subject: consumedIntent.providerUserId,
			emailVerified: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "External identity link failed";
		return c.json({ error: message }, 409);
	}
	if (!linked) {
		return c.json({ error: "User not found" }, 404);
	}
	await updateLastLogin(linked.id);
	const issued = await issueLogin(c, linked, intent.provider);
	return c.json({
		status: "linked",
		user: linked,
		tokens: issued.tokens,
	});
});

// Exchange a single-use SSO login code (issued by the callback redirect when
// SSO_ONE_TIME_CODE is enabled) for the access/refresh tokens. Tokens are
// returned in the JSON body only — never in a URL — so the refresh token is
// never browser-history/referrer visible. The code is consumed on first use.
auth.post("/sso/exchange", async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const code = typeof (raw.data as Record<string, unknown>).code === "string"
		? (raw.data as Record<string, string>).code
		: undefined;
	if (!code) {
		return c.json({ error: "SSO code required" }, 400);
	}
	const record = consumeSsoLoginCode(code);
	if (!record) {
		return c.json({ error: "Invalid or expired SSO code", code: "sso_code_invalid" }, 401);
	}
	// Re-affirm the httpOnly cookies on the exchanging origin too, so cookie-based
	// API calls keep working even if the callback's Set-Cookie was dropped.
	setAuthCookie(c, ACCESS_COOKIE_NAME, record.tokens.accessToken, serverConfig.jwtAccessTokenExpiry);
	issueRefreshCookie(c, record.tokens.refreshToken);
	return c.json({
		user: record.user,
		tokens: { accessToken: record.tokens.accessToken, refreshToken: record.tokens.refreshToken },
	});
});

auth.get("/sessions", authMiddleware, async (c) => {
	const user = getAuthUser(c) as JWTPayload;
	// Primary signal: the session id embedded in the access token (`sid`). Works
	// for bearer-only clients that never echo the httpOnly refresh cookie.
	const currentSessionId = typeof user.sid === "string" ? user.sid : undefined;
	// Fallback for tokens minted before `sid` existed: match the refresh cookie's
	// hash against the stored session token hash.
	const currentRefreshToken = getRefreshCookieValue(c);
	const currentTokenHash = currentRefreshToken ? hashSessionToken(currentRefreshToken) : undefined;
	const sessions = await authSessionStore.listUserSessions(user.userId);
	return c.json({
		sessions: sessions.map((session) => ({
			id: session.sessionId,
			provider: typeof session.metadata?.provider === "string" ? session.metadata.provider : "local",
			last_active: new Date(readSessionLastActive(session)).toISOString(),
			ip: typeof session.metadata?.ip === "string" ? session.metadata.ip : null,
			ua: typeof session.metadata?.ua === "string" ? session.metadata.ua : null,
			current_session: currentSessionId
				? session.sessionId === currentSessionId
				: Boolean(currentTokenHash && session.tokenHash === currentTokenHash),
		})),
	});
});

auth.delete("/sessions/:id", authMiddleware, async (c) => {
	const user = getAuthUser(c) as JWTPayload;
	const sessionId = c.req.param("id");
	if (!sessionId) {
		return c.json({ error: "Session id is required" }, 400);
	}
	const revoked = await authSessionStore.revokeSessionId(user.userId, sessionId);
	if (!revoked) {
		return c.json({ error: "Session not found", code: "session_not_found" }, 404);
	}
	return c.json({ message: "Session revoked" });
});

/**
 * POST /api/auth/register
 * Register a new user (requires valid admin token in production)
 */
auth.post("/register", turnstileVerify({ expectedAction: "auth_register" }), async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = registerSchema.safeParse(raw.data);

	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const currentUser = getAuthUser(c);
	// Assigning ANY role at register requires admin:roles.write (owner only) —
	// minting an owner/admin/support/accountant is a platform-role grant and must
	// be least-privilege. Anyone else gets the default app role regardless of what
	// they asked for. (Granular role management lives in the admin user-mgmt
	// surface; this endpoint only allows the owner the bootstrap convenience.)
	const canAssignRole = Boolean(currentUser && hasPermission(currentUser.role, ADMIN_PERMISSIONS.ROLES_WRITE));
	if (parsed.data.role && !canAssignRole) {
		return c.json({ error: "Only an owner can assign user roles during registration" }, 403);
	}

	// Per-IP signup cap for PUBLIC registration (an owner bootstrapping accounts is
	// exempt). Best-effort over a 24h window: a limiter-store (e.g. Redis) outage must
	// NOT turn sign-up into a 500 — it fails OPEN here, with the per-minute layered
	// api:auth-register policy (failureMode: block) as the fail-closed backstop.
	if (!canAssignRole) {
		const requesterIp = getTrustedClientIp(c) ?? "unknown";
		try {
			if (await hitAuthFlowRateLimit(`register-ip:${requesterIp}`, REGISTER_IP_RATE_LIMIT)) {
				return c.json({ error: "Too many sign-ups from this network — please try again later.", code: "rate_limited" }, 429);
			}
		} catch (error) {
			console.warn("[auth] register per-IP limiter unavailable; failing open", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	try {
		const { user } = await createUser({
			...parsed.data,
			role: (canAssignRole ? parsed.data.role : "editor") as UserRole,
		});
		const tokens = await generateTokens(user, {
			provider: "local",
			ip: clientIp(c),
			userAgent: c.req.header("user-agent"),
		});
		issueRefreshCookie(c, tokens.refreshToken);
		// Mirror the access token into the httpOnly cookie (as SSO/refresh do) so
		// cookie-based clients can authenticate immediately after registration.
		setAuthCookie(c, ACCESS_COOKIE_NAME, tokens.accessToken, serverConfig.jwtAccessTokenExpiry);

		// Dev/file-mode usability: when no mailer can deliver a verification link
		// (AUTH_AUTO_VERIFY_EMAIL, ON by default outside production/test), mark the
		// account verified immediately so the user isn't trapped at the
		// email_not_verified gate — they can create a project and upload an image
		// right away. Production keeps real verification (flag defaults OFF there).
		if (serverConfig.authAutoVerifyEmail) {
			const verified = await markEmailVerified(user.id);
			const verifiedUser = verified ?? { ...user, emailVerified: true };
			return c.json({
				user: verifiedUser,
				tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
				verificationEmail: { sendFailed: false, resendPath: "/api/auth/resend-verification" },
			}, 201);
		}

		let responseUser = user;
		let verificationEmailSendFailed = false;
		let sendError: string | null = null;
		try {
			const sendResult = await sendRegistrationVerification(c, user);
			// The sender does NOT throw on a Resend permanent/retryable failure — it
			// returns success:false. Treat a returned failure as a send failure too,
			// otherwise the user is told "email is coming" when it never sent.
			if (sendResult && !sendResult.success) {
				verificationEmailSendFailed = true;
				sendError = sendResult.error ?? sendResult.status;
			}
		} catch (error) {
			verificationEmailSendFailed = true;
			sendError = error instanceof Error ? error.message : String(error);
		}
		if (verificationEmailSendFailed) {
			console.warn("[auth] registration verification email delivery failed", {
				userId: user.id,
				email: user.email,
				error: sendError,
			});
			responseUser = await updateUser(user.id, { verificationEmailSendFailed: true })
				?? { ...user, verificationEmailSendFailed: true };
		}

		return c.json({
			user: responseUser,
			tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
			verificationEmail: {
				sendFailed: verificationEmailSendFailed,
				resendPath: "/api/auth/resend-verification",
			},
		}, 201);
	} catch (error) {
		// A taken email is a CONFLICT, not a bad request: return 409 + a machine-readable
		// code so the client can show "email already used" without parsing the message.
		if (error instanceof EmailAlreadyExistsError) {
			return c.json({ error: error.message, code: error.code }, 409);
		}
		// Weak password is actionable — surface code + the specific rule codes (reason) so the
		// client localizes which rule failed; everything else is an unexpected server fault.
		if (error instanceof WeakPasswordError) {
			return c.json({ error: error.message, code: error.code, reason: { codes: error.codes, minLength: error.minLength } }, 400);
		}
		console.error("[auth] registration failed:", error);
		return c.json({ error: "Registration failed. Please try again.", code: "registration_failed" }, 400);
	}
});

/**
 * POST /api/auth/forgot-password
 * Request a password reset email without revealing whether the email exists.
 */
auth.post("/forgot-password", async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = forgotPasswordSchema.safeParse(raw.data);

	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const email = parsed.data.email;
	const normalizedEmail = email.trim().toLowerCase();
	const responseStartedAt = Date.now();
	const requesterIp = getTrustedClientIp(c) ?? "unknown";
	const userAgent = c.req.header("user-agent") ?? null;

	// Throttle abuse by requester IP only. A per-IP cap bounds how many distinct
	// targets one source can burn without ever letting a third party lock a
	// specific victim out of recovery. We intentionally do NOT 429 on a per-email
	// budget, because that key is incremented before the requester proves they own
	// the mailbox, so an attacker could spend a victim's daily budget and make the
	// real owner's later request from their own IP fail. Instead the per-email
	// budget only suppresses the actual send (below) while the victim-visible
	// response stays a uniform 200 — recovery for the real owner is never blocked.
	if (await hitAuthFlowRateLimit(`forgot-password-ip:${requesterIp}`, FORGOT_PASSWORD_IP_RATE_LIMIT)) {
		// Pad the rejection to the same minimum latency as the success path so a
		// 429 cannot be used to probe which IPs/emails are being rate-limited.
		await waitForMinimumDuration(responseStartedAt, FORGOT_PASSWORD_MIN_RESPONSE_MS);
		return c.json({ error: "Too many password reset requests", code: "rate_limited" }, 429);
	}

	// Cap how many reset emails a single address can trigger per window WITHOUT
	// failing the response. Over budget => we still answer 200 but skip the send.
	const emailBudgetExceeded = await hitAuthFlowRateLimit(`forgot-password:${normalizedEmail}`);

	const user = emailBudgetExceeded ? null : await findUserByEmail(normalizedEmail);

	// Respond on a uniform timeline for BOTH known and unknown accounts, then send
	// the email out-of-band. Awaiting a real transactional provider inline would
	// make the known-account path measurably slower than the unknown path (which
	// only waits the fixed minimum), reintroducing a timing enumeration oracle.
	// Minting + storing the token is fast/local; only the provider round-trip is
	// deferred until after the response timing has been equalized.
	await waitForMinimumDuration(responseStartedAt, FORGOT_PASSWORD_MIN_RESPONSE_MS);

	if (user) {
		const inFlight = dispatchPasswordResetEmail(user, requesterIp, userAgent);
		pendingAuthEmails.add(inFlight);
		void inFlight.finally(() => pendingAuthEmails.delete(inFlight));
	}

	return c.json({ ok: true });
});

/**
 * Mint a reset token and deliver the email off the response critical path so the
 * forgot-password endpoint answers on the same timeline regardless of whether the
 * email belongs to a real account. Failures are logged and swallowed: the caller
 * has already received the uniform non-enumerating response.
 */
async function dispatchPasswordResetEmail(
	user: { id: string; email: string; name?: string; passwordHash?: string },
	requesterIp: string | null,
	userAgent: string | null,
): Promise<void> {
	try {
		const minted = await mintToken(user.id, "password_reset");
		await storeMintedToken({
			userId: user.id,
			kind: "password_reset",
			tokenHash: minted.hash,
			expiresAt: minted.expiresAt,
			ipAddress: requesterIp,
			userAgent,
		});
		const { passwordHash, ...userWithoutPassword } = user;
		await authEmailSender("password-reset", {
			user: { ...userWithoutPassword, name: user.name ?? user.email },
			resetUrl: buildAppUrl(`/reset-password?token=${encodeURIComponent(minted.token)}`),
			expiresAt: minted.expiresAt,
		});
	} catch (error) {
		console.warn("[auth] password reset email delivery failed", {
			userId: user.id,
			email: user.email,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * POST /api/auth/reset-password
 * Complete password reset with a single-use token.
 */
auth.post("/reset-password", async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = resetPasswordSchema.safeParse(raw.data);

	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const verification = await verifyTokenRecord(parsed.data.token, "password_reset");
	if (!verification.valid) {
		return c.json({
			error: tokenReasonToMessage(verification.reason),
			code: tokenReasonToCode(verification.reason),
		}, 400);
	}

	try {
		const passwordValidation = validatePassword(parsed.data.newPassword);
		if (!passwordValidation.valid) {
			// Same typed contract as register/change-password: carry the rule codes + minLength
			// so the client localizes the SPECIFIC failed rules (not generic copy).
			return c.json({
				error: passwordValidation.errors.join("; "),
				code: "weak_password",
				reason: { codes: passwordValidation.codes, minLength: passwordValidation.minLength },
			}, 400);
		}
		const consumed = await consumeUnusedToken(verification.record);
		if (!consumed) {
			return c.json({ error: "Reset token has already been used", code: "already_used" }, 400);
		}
		const changed = await resetPasswordForUser(verification.record.userId, parsed.data.newPassword);
		if (!changed) return c.json({ error: "Invalid reset token", code: "invalid_token" }, 400);
		await auditAuthEvent({
			userId: verification.record.userId,
			action: "password_changed_via_reset",
			metadata: {
				passwordResetId: verification.record.id,
				ipAddress: getTrustedClientIp(c) ?? null,
			},
		});
		return c.json({ ok: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Password reset failed";
		return c.json({ error: message }, 400);
	}
});

/**
 * POST /api/auth/verify-email
 * Mark the user's email verified using a single-use verification token.
 */
auth.post("/verify-email", async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = verifyEmailSchema.safeParse(raw.data);

	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const verification = await verifyTokenRecord(parsed.data.token, "email_verify");
	if (!verification.valid) {
		return c.json({
			error: tokenReasonToMessage(verification.reason),
			code: tokenReasonToCode(verification.reason),
		}, 400);
	}

	const consumed = await consumeUnusedToken(verification.record);
	if (!consumed) {
		return c.json({ error: "Verification token has already been used", code: "already_used" }, 400);
	}
	const user = await markEmailVerified(verification.record.userId);
	if (!user) return c.json({ error: "Invalid verification token", code: "invalid_token" }, 400);

	return c.json({
		verified: true,
		user: {
			id: user.id,
			email: user.email,
			emailVerified: true,
		},
	});
});

/**
 * POST /api/auth/verify-otp
 * Verify the signed-in user's email by redeeming the numeric code they were emailed.
 * Identity comes from the SESSION (never an email/userId in the body), so a caller can
 * only attempt codes for their OWN account; attempts are rate-limited per user to cap
 * brute-forcing the 6-digit space.
 */
auth.post("/verify-otp", authMiddleware, async (c) => {
	const sessionUser = (c as any).get("user") as JWTPayload;
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = verifyOtpSchema.safeParse(raw.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const fullUser = await loadUser(sessionUser.userId);
	if (!fullUser) return c.json({ error: "User not found" }, 404);
	if (fullUser.emailVerified) {
		// Idempotent: a double-submit (or a code redeemed in another tab) is still a success.
		return c.json({ verified: true, user: { id: fullUser.id, email: fullUser.email, emailVerified: true } });
	}

	// Brute-force budget keyed to the CURRENT code generation, so a freshly resent
	// code (a new generation) restores a full attempt allowance rather than staying
	// locked out until the window expires. Counted BEFORE checking the code so wrong
	// guesses cannot be retried freely.
	const generation = await currentEmailOtpGeneration(sessionUser.userId);
	const tooMany = await hitVerifyOtpRateLimit(`${sessionUser.userId}:${generation}`);
	if (tooMany) {
		return c.json({ error: "Too many attempts — request a new code and try again.", code: "rate_limited" }, 429);
	}

	const result = await verifyEmailOtp(sessionUser.userId, parsed.data.code);
	if (!result.ok) {
		return c.json({ error: tokenReasonToMessage(result.reason), code: tokenReasonToCode(result.reason) }, 400);
	}

	const user = await markEmailVerified(sessionUser.userId);
	if (!user) return c.json({ error: "Invalid verification code", code: "invalid_code" }, 400);
	if (fullUser.verificationEmailSendFailed) {
		await updateUser(fullUser.id, { verificationEmailSendFailed: false });
	}
	await auditAuthEvent({
		userId: user.id,
		action: "email_verified_via_otp",
		metadata: { ipAddress: getTrustedClientIp(c) ?? null },
	});
	return c.json({ verified: true, user: { id: user.id, email: user.email, emailVerified: true } });
});

/**
 * POST /api/auth/resend-verification
 * Resend verification email for the authenticated unverified user.
 */
auth.post("/resend-verification", turnstileVerify({ expectedAction: "auth_resend_verification" }), authMiddleware, async (c) => {
	const user = (c as any).get("user") as JWTPayload;
	const fullUser = await loadUser(user.userId);
	if (!fullUser) return c.json({ error: "User not found" }, 404);
	if (fullUser.emailVerified) {
		return c.json({ error: "Email is already verified", code: "already_verified" }, 400);
	}

	// Per-USER cap: a single account can't spam verification (OTP) emails. We do NOT
	// add a per-IP resend cap here: the two increment-on-check limiters cannot be
	// ordered to satisfy both fairness constraints (an IP-first order burns the shared
	// IP budget on requests the per-user cap rejects; a user-first order burns the
	// scarce per-user budget when the IP is blocked) without counting only actual
	// sends, which the limiter store cannot express. Resend fan-out per source is
	// already bounded UPSTREAM by the per-IP REGISTER cap (accounts/IP/day) times this
	// per-user cap, so a standalone per-IP resend cap only risks penalising honest
	// users behind a shared NAT for marginal extra protection.
	const limited = await hitAuthFlowRateLimit(`resend-verification:${fullUser.id}`);
	if (limited) {
		return c.json({ error: "Too many verification email requests", code: "rate_limited" }, 429);
	}

	const { passwordHash, ...userWithoutPassword } = fullUser;
	let sendFailed = false;
	let sendError: string | null = null;
	try {
		const sendResult = await sendRegistrationVerification(c, userWithoutPassword);
		// Inspect the RETURNED SendResult: the sender reports a Resend failure via
		// success:false rather than throwing. A returned failure must surface as
		// sendFailed:true so the client doesn't tell the user the email is coming.
		if (sendResult && !sendResult.success) {
			sendFailed = true;
			sendError = sendResult.error ?? sendResult.status;
		}
	} catch (error) {
		sendFailed = true;
		sendError = error instanceof Error ? error.message : String(error);
	}
	if (sendFailed) {
		console.warn("[auth] resend verification email delivery failed", {
			userId: fullUser.id,
			email: fullUser.email,
			error: sendError,
		});
		// Persist the failure so the account stays flagged for retry rather than
		// silently clearing it on a send that never went out.
		if (!fullUser.verificationEmailSendFailed) {
			await updateUser(fullUser.id, { verificationEmailSendFailed: true });
		}
		return c.json({ ok: false, sendFailed: true }, 502);
	}
	// Only clear the flag once we know the email actually went out.
	if (fullUser.verificationEmailSendFailed) {
		await updateUser(fullUser.id, { verificationEmailSendFailed: false });
	}
	return c.json({ ok: true, sendFailed: false });
});

/**
 * POST /api/auth/login
 * Authenticate user and return tokens
 */
auth.post("/login", turnstileVerify({ expectedAction: "auth_login" }), async (c) => {
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = loginSchema.safeParse(raw.data);

	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const user = await findUserByEmail(parsed.data.email);
	const lockout = await accountLockoutTracker.check(parsed.data.email);
	if (lockout.locked) {
		return accountLockoutResponse(c, lockout);
	}

	if (!user) {
		// Run a bcrypt comparison against a constant fake hash so the response time
		// matches the known-user path; otherwise the timing difference leaks whether
		// an email is registered (user-enumeration oracle).
		await dummyPasswordCompare(parsed.data.password);
		await accountLockoutTracker.recordFailure(parsed.data.email, clientIp(c));
		return c.json({ error: "Invalid email or password", code: "invalid_credentials" }, 401);
	}

	if (!user.isActive) {
		return c.json({ error: "Account is disabled", code: "account_disabled" }, 403);
	}

	const isValid = await comparePassword(parsed.data.password, user.passwordHash);
	if (!isValid) {
		const state = await accountLockoutTracker.recordFailure(user.email, clientIp(c));
		if (state.locked) return accountLockoutResponse(c, state);
		return c.json({ error: "Invalid email or password", code: "invalid_credentials" }, 401);
	}

	await accountLockoutTracker.clear(user.email);
	await updateLastLogin(user.id);

	const tokens = await generateTokens(user, {
		provider: "local",
		ip: clientIp(c),
		userAgent: c.req.header("user-agent"),
	});
	issueRefreshCookie(c, tokens.refreshToken);
	const { passwordHash, ...userWithoutPassword } = user;
	// Set the same httpOnly access cookie SSO uses so /auth/sessions can flag the
	// current session even when the client authenticates with a Bearer token.
	setAuthCookie(c, ACCESS_COOKIE_NAME, tokens.accessToken, serverConfig.jwtAccessTokenExpiry);

	return c.json({
		user: userWithoutPassword,
		tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
	});
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
auth.post("/refresh", refreshAuthMiddleware, async (c) => {
	const tokens = (c as any).get("newTokens") as { accessToken: string; refreshToken: string };
	const user = (c as any).get("user") as JWTPayload;
	const fullUser = await loadUser(user.userId);
	if (!fullUser) {
		return c.json({ error: "User not found" }, 404);
	}
	const { passwordHash, ...userWithoutPassword } = fullUser;
	issueRefreshCookie(c, tokens.refreshToken);
	// SSO cookie-based clients also read the short-lived access token from a cookie,
	// so refresh it alongside the canonical refresh cookie.
	setAuthCookie(c, ACCESS_COOKIE_NAME, tokens.accessToken, serverConfig.jwtAccessTokenExpiry);

	return c.json({
		tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
		user: userWithoutPassword,
	});
});

// ── Protected Routes ───────────────────────────────────────────

/**
 * POST /api/auth/logout
 * Invalidate refresh token
 */
auth.post("/logout", authMiddleware, async (c) => {
	const user = getAuthUser(c) as JWTPayload;
	const raw = await readOptionalJsonBody(c);
	if (!raw.ok) return raw.response;
	const bodyRefreshToken = typeof raw.data.refreshToken === "string" ? raw.data.refreshToken : undefined;
	// Fall back to the httpOnly refresh cookie so SSO sessions (which never
	// expose a JS-readable refresh token) can still be revoked on logout.
	const refreshToken = bodyRefreshToken || getRefreshCookieValue(c);

	if (refreshToken) {
		await revokeRefreshToken(refreshToken);
	}
	clearRefreshCookie(c);
	// Clear the httpOnly auth cookies so the SSO access cookie cannot keep
	// authenticating same-origin API calls until the JWT expires. The frontend
	// cannot remove these cookies itself when it clears local storage.
	clearAuthCookies(c);

	// Auto-release every active work lock the user holds so an explicit logout
	// doesn't strand page/layer/chapter locks until expiry and block collaborators.
	// Best-effort: a lock-store outage must not fail the logout itself.
	if (workLockStore && user?.userId) {
		try {
			await workLockStore.releaseLocksForUser(user.userId, { reason: "user_logout" });
		} catch (error) {
			console.warn("[auth] logout lock release failed", error);
		}
	}

	return c.json({ message: "Logged out successfully" });
});

auth.post("/logout-cookie", async (c) => {
	const token = getRefreshCookieValue(c);
	if (token) {
		await revokeRefreshToken(token);
	}
	clearRefreshCookie(c);
	clearAuthCookies(c);
	return c.json({ message: "Logged out successfully" });
});

/**
 * GET /api/auth/me
 * Get current user info
 */
auth.get("/me", authMiddleware, async (c) => {
	const user = (c as any).get("user") as JWTPayload;

	const fullUser = await loadUser(user.userId);
	if (!fullUser) {
		return c.json({ error: "User not found" }, 404);
	}

	const { passwordHash, ...userWithoutPassword } = fullUser;
	return c.json(userWithoutPassword);
});

/**
 * PATCH /api/auth/me
 * Self-service profile update. Name and UI locale are allowed; email changes
 * need a verified flow, and role/active are admin-only. Returns the updated user
 * WITHOUT the password hash.
 */
auth.patch("/me", authMiddleware, async (c) => {
	const user = (c as any).get("user") as JWTPayload;
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = updateMyProfileSchema.safeParse(raw.data);

	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	try {
		// updateUser strips the password hash and only touches the fields passed —
		// here just display prefs, so no email-rebind / session-revocation side effects fire.
		const updated = await updateUser(user.userId, parsed.data);
		if (!updated) {
			return c.json({ error: "User not found" }, 404);
		}
		return c.json(updated);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Profile update failed";
		return c.json({ error: message }, 400);
	}
});

/**
 * POST /api/auth/change-password
 * Change current user's password
 */
auth.post("/change-password", authMiddleware, async (c) => {
	const user = (c as any).get("user") as JWTPayload;
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = changePasswordSchema.safeParse(raw.data);

	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	try {
		await changePassword(user.userId, parsed.data);
		return c.json({ message: "Password changed successfully" });
	} catch (error) {
		// Wrong current password → 401 (not a generic 400) so the client can prompt re-entry.
		if (error instanceof InvalidCurrentPasswordError) {
			return c.json({ error: error.message, code: error.code }, 401);
		}
		// Weak new password → code + specific rule codes (reason) for localized guidance.
		if (error instanceof WeakPasswordError) {
			return c.json({ error: error.message, code: error.code, reason: { codes: error.codes, minLength: error.minLength } }, 400);
		}
		console.error("[auth] password change failed:", error);
		return c.json({ error: "Couldn't change your password. Please try again.", code: "password_change_failed" }, 400);
	}
});

// ── Admin Routes ───────────────────────────────────────────────

// Legacy /api/auth/users/:id mutation routes (PATCH / DELETE / disable / enable)
// predate the fine-grained /api/admin/users-mgmt router. They are still exercised
// by tests and kept because they cover edits the modern role-only endpoint does
// not (email / name / arbitrary field PATCH). To close the RBAC + audit gap they
// now (a) layer requirePermission(USERS_WRITE) on top of the coarse requireAdmin
// role gate so the permission check can never drift from the modern surface, and
// (b) write an admin_audit row on every successful mutation via the SAME
// gdprStore.recordAdminAudit path the users-mgmt router uses. Response shapes are
// unchanged. Audit is best-effort and must never mask a successful mutation, so a
// failure to persist the audit row is logged, not thrown.
async function recordLegacyUserAudit(input: {
	adminUserId: string | undefined;
	action: string;
	targetId: string;
	detail?: Record<string, unknown>;
}): Promise<void> {
	if (!input.adminUserId) return;
	try {
		await gdprStore.recordAdminAudit({
			adminUserId: input.adminUserId,
			action: input.action,
			targetKind: "user",
			targetId: input.targetId,
			detail: input.detail,
		});
	} catch (error) {
		console.error(`[auth] failed to record admin audit for ${input.action}:`, error);
	}
}

const requireUsersWrite = requirePermission(ADMIN_PERMISSIONS.USERS_WRITE);

/**
 * GET /api/auth/users
 * List all users (admin only)
 */
auth.get("/users", authMiddleware, requireAdmin, async (c) => {
	const search = c.req.query("search")?.trim() || undefined;
	const cursor = decodeUserCursor(c.req.query("cursor"));
	const limit = parseUserLimit(c.req.query("limit"));
	// Bounded + keyset-paginated. `users` keeps the same full-user shape (incl.
	// the per-user external-identities array); pagination is additive via
	// `nextCursor` / `limit`.
	const { users, nextCursor } = await listUsersPaginated({ search, cursor, limit });
	return c.json({ users, nextCursor: encodeUserCursor(nextCursor), limit });
});

/**
 * GET /api/auth/users/:id
 * Get specific user (admin only)
 */
auth.get("/users/:id", authMiddleware, requireAdmin, async (c) => {
	const userId = requiredParam(c, "id");

	const user = await loadUser(userId);
	if (!user) {
		return c.json({ error: "User not found" }, 404);
	}

	const { passwordHash, ...userWithoutPassword } = user;
	return c.json(userWithoutPassword);
});

/**
 * PATCH /api/auth/users/:id
 * Update user (admin only)
 */
auth.patch("/users/:id", authMiddleware, requireAdmin, requireUsersWrite, async (c) => {
	const userId = requiredParam(c, "id");
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = updateUserSchema.safeParse(raw.data);

	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	try {
		const currentUser = getAuthUser(c);
		const existing = await loadUser(userId);
		if (!existing) {
			return c.json({ error: "User not found" }, 404);
		}
		// Only an owner (admin:roles.write) may change a platform role. support /
		// accountant reach the back-office but must never reassign roles.
		assertRoleAssignmentAllowed({
			actorRole: currentUser!.role,
			nextRole: parsed.data.role && parsed.data.role !== existing.role ? parsed.data.role : undefined,
		});
		assertPlatformAdminSelfUpdateAllowed({
			actorUserId: currentUser!.userId,
			targetUserId: userId,
			currentRole: existing.role,
			nextRole: parsed.data.role,
			nextIsActive: parsed.data.isActive,
		});
		const demotesOrDisablesOwner =
			existing.role === "owner" &&
			((parsed.data.role !== undefined && parsed.data.role !== "owner") || parsed.data.isActive === false);
		// Owner-target policy: only an owner may mutate another owner at all,
		// including email/name changes that could enable password-reset takeover.
		assertOwnerTargetMutationAllowed({
			actorRole: currentUser!.role,
			targetCurrentRole: existing.role,
			isDestructive: demotesOrDisablesOwner,
		});
		// Last-owner pre-check: fast, friendly early 403 BEFORE attempting the write.
		// Not relied on for correctness — the atomic store mutation below re-checks
		// the owner population inside the write transaction so concurrent
		// demote/disable requests can never drop the platform to zero owners.
		if (demotesOrDisablesOwner) {
			assertLastOwnerMutationAllowed({
				targetCurrentRole: existing.role,
				nextRole: parsed.data.role,
				nextIsActive: parsed.data.isActive,
				action: "update",
				ownerCount: await countActiveUsersByRole("owner"),
			});
		}
		const updatedUser = await updateUserProtectingLastOwner(userId, parsed.data);
		if (!updatedUser) {
			return c.json({ error: "User not found" }, 404);
		}

		await recordLegacyUserAudit({
			adminUserId: currentUser?.userId,
			action: "admin.user.update",
			targetId: userId,
			detail: {
				email: updatedUser.email,
				oldRole: existing.role,
				newRole: updatedUser.role,
				changedFields: Object.keys(parsed.data),
			},
		});

		return c.json(updatedUser);
	} catch (error) {
		if (error instanceof AdminSelfProtectionError) {
			return c.json({ error: error.message, reason: error.reason }, error.status);
		}
		// Atomic last-owner guard tripped under a concurrent race: map to the same
		// 403 last-owner response the pre-check produces.
		if (error instanceof LastPlatformOwnerError) {
			return c.json({ error: error.message, reason: ADMIN_SELF_PROTECTION_REASON }, 403);
		}
		const message = error instanceof Error ? error.message : "Update failed";
		return c.json({ error: message }, 400);
	}
});

/**
 * DELETE /api/auth/users/:id
 * Delete user (admin only)
 */
auth.delete("/users/:id", authMiddleware, requireAdmin, requireUsersWrite, async (c) => {
	const userId = requiredParam(c, "id");
	const currentUser = getAuthUser(c);

	try {
		assertPlatformAdminSelfDeleteAllowed(currentUser?.userId, userId);
		const existing = await loadUser(userId);
		if (existing?.role === "owner") {
			// Owner-target policy: only an owner may delete another owner.
			assertOwnerTargetMutationAllowed({
				actorRole: currentUser!.role,
				targetCurrentRole: existing.role,
				isDestructive: true,
			});
			// Fast pre-check; the atomic delete below is the real guarantee.
			assertLastOwnerMutationAllowed({
				targetCurrentRole: existing.role,
				action: "delete",
				ownerCount: await countActiveUsersByRole("owner"),
			});
		}
		const success = await deleteUserProtectingLastOwner(userId);
		if (!success) {
			return c.json({ error: "User not found" }, 404);
		}
		await recordLegacyUserAudit({
			adminUserId: currentUser?.userId,
			action: "admin.user.delete",
			targetId: userId,
			detail: { email: existing?.email ?? null, role: existing?.role ?? null },
		});
		return c.json({ message: "User deleted successfully" });
	} catch (error) {
		if (error instanceof AdminSelfProtectionError) {
			return c.json({ error: error.message, reason: error.reason }, error.status);
		}
		if (error instanceof LastPlatformOwnerError) {
			return c.json({ error: error.message, reason: ADMIN_SELF_PROTECTION_REASON }, 403);
		}
		throw error;
	}
});

/**
 * POST /api/auth/users/:id/disable
 * Disable user account (admin only)
 */
auth.post("/users/:id/disable", authMiddleware, requireAdmin, requireUsersWrite, async (c) => {
	const userId = requiredParam(c, "id");
	const currentUser = getAuthUser(c);

	try {
		const existing = await loadUser(userId);
		if (!existing) return c.json({ error: "User not found" }, 404);
		assertPlatformAdminSelfUpdateAllowed({
			actorUserId: currentUser!.userId,
			targetUserId: userId,
			currentRole: existing.role,
			nextIsActive: false,
		});
		if (existing.role === "owner") {
			// Owner-target policy: only an owner may disable another owner.
			assertOwnerTargetMutationAllowed({
				actorRole: currentUser!.role,
				targetCurrentRole: existing.role,
				isDestructive: true,
			});
			// Fast pre-check; the atomic update below is the real guarantee.
			assertLastOwnerMutationAllowed({
				targetCurrentRole: existing.role,
				nextIsActive: false,
				action: "update",
				ownerCount: await countActiveUsersByRole("owner"),
			});
		}
		const updatedUser = await updateUserProtectingLastOwner(userId, { isActive: false });
		if (!updatedUser) {
			return c.json({ error: "User not found" }, 404);
		}
		await recordLegacyUserAudit({
			adminUserId: currentUser?.userId,
			action: "admin.user.disable",
			targetId: userId,
			detail: { email: existing.email },
		});
		return c.json({ message: "User disabled successfully", user: updatedUser });
	} catch (error) {
		if (error instanceof AdminSelfProtectionError) {
			return c.json({ error: error.message, reason: error.reason }, error.status);
		}
		if (error instanceof LastPlatformOwnerError) {
			return c.json({ error: error.message, reason: ADMIN_SELF_PROTECTION_REASON }, 403);
		}
		throw error;
	}
});

/**
 * POST /api/auth/users/:id/enable
 * Enable user account (admin only)
 */
auth.post("/users/:id/enable", authMiddleware, requireAdmin, requireUsersWrite, async (c) => {
	const userId = requiredParam(c, "id");
	const currentUser = getAuthUser(c);
	let existingEmail: string | null = null;

	try {
		const existing = await loadUser(userId);
		if (!existing) {
			return c.json({ error: "User not found" }, 404);
		}
		existingEmail = existing.email;
		// Owner-target policy: only an owner may reactivate another owner.
		assertOwnerTargetMutationAllowed({
			actorRole: currentUser!.role,
			targetCurrentRole: existing.role,
			isDestructive: false,
		});
	} catch (error) {
		if (error instanceof AdminSelfProtectionError) {
			return c.json({ error: error.message, reason: error.reason }, error.status);
		}
		throw error;
	}

	const updatedUser = await updateUser(userId, { isActive: true });
	if (!updatedUser) {
		return c.json({ error: "User not found" }, 404);
	}

	await recordLegacyUserAudit({
		adminUserId: currentUser?.userId,
		action: "admin.user.enable",
		targetId: userId,
		detail: { email: existingEmail },
	});

	return c.json({ message: "User enabled successfully", user: updatedUser });
});

async function sendRegistrationVerification(
	c: Context,
	user: { id: string; email: string; name?: string; emailVerified?: boolean },
): Promise<SendResult | null> {
	if (user.emailVerified) return null;
	// Mint the code, then send, then persist it ONLY on a successful send. verifyEmailOtp
	// always redeems the user's NEWEST live code, so the newest STORED code must equal the
	// newest DELIVERED code: persisting a code whose email never went out (a failed resend)
	// would silently supersede — and thus disable — the code already sitting in the user's
	// inbox. Storing on success keeps a failed resend a no-op for redemption (the prior
	// delivered code keeps working) with no invalidation and therefore no concurrency race.
	const minted = mintEmailOtp(user.id);
	// The sender RETURNS a SendResult (success:false on a Resend permanent/retryable
	// failure) instead of throwing, so callers must inspect the returned status —
	// not just catch a thrown exception — to know whether the email actually went
	// out. We surface the result here so the register/resend sites can set
	// verificationEmailSendFailed correctly.
	const sendResult = await authEmailSender("registration-verify", {
		user: { ...user, name: user.name ?? user.email },
		code: minted.code,
		expiresMinutes: EMAIL_OTP_TTL_MINUTES,
	});
	if (sendResult.success) {
		await storeMintedToken({
			userId: user.id,
			kind: "email_verify",
			tokenHash: minted.hash,
			expiresAt: minted.expiresAt,
			ipAddress: getTrustedClientIp(c) ?? null,
		});
	}
	return sendResult;
}

function setAuthEmailSenderForTesting(sender: AuthEmailSender = sendTransactionalEmail): void {
	authEmailSender = sender;
}

/** Wait for any reset emails dispatched off the response critical path (test helper). */
async function flushPendingAuthEmails(): Promise<void> {
	await Promise.allSettled([...pendingAuthEmails]);
}

async function hitAuthFlowRateLimit(key: string, max = AUTH_FLOW_RATE_LIMIT_MAX): Promise<boolean> {
	const result = await authFlowRateLimitStore.increment(key, AUTH_FLOW_RATE_LIMIT_WINDOW_MS, Date.now());
	return result.count > max;
}

async function hitVerifyOtpRateLimit(scope: string): Promise<boolean> {
	const result = await authFlowRateLimitStore.increment(`verify-otp:${scope}`, VERIFY_OTP_RATE_LIMIT_WINDOW_MS, Date.now());
	return result.count > VERIFY_OTP_RATE_LIMIT_MAX;
}

async function waitForMinimumDuration(startedAtMs: number, minimumMs: number): Promise<void> {
	const remainingMs = minimumMs - (Date.now() - startedAtMs);
	if (remainingMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, remainingMs));
	}
}

function buildAppUrl(path: string): string {
	// Single source of truth for the app base URL: resolve from the SAME config the
	// mailer/template chrome uses (readMailerEnvConfig().appUrl = APP_URL ||
	// https://app.example.com). Previously this fell back to FRONTEND_URL ||
	// localhost, so a prod that set only APP_URL was fine, but a prod that set only
	// FRONTEND_URL produced a verify/reset LINK pointing at localhost while the email
	// CHROME used the prod default — a broken link. Unifying on the mailer config
	// keeps the clickable link and the surrounding template on the same origin.
	const base = readMailerEnvConfig().appUrl.replace(/\/+$/, "");
	return `${base}${path}`;
}

function tokenReasonToCode(reason: "expired" | "used" | "not_found"): string {
	if (reason === "expired") return "expired";
	if (reason === "used") return "already_used";
	return "invalid_token";
}

function tokenReasonToMessage(reason: "expired" | "used" | "not_found"): string {
	if (reason === "expired") return "Token expired";
	if (reason === "used") return "Token already used";
	return "Invalid token";
}

function issueRefreshCookie(c: any, refreshToken: string): void {
	setCookie(c, REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: REFRESH_TOKEN_COOKIE_PATH,
		maxAge: serverConfig.jwtRefreshTokenExpiry,
	});
}

function clearRefreshCookie(c: any): void {
	deleteCookie(c, REFRESH_TOKEN_COOKIE_NAME, {
		path: REFRESH_TOKEN_COOKIE_PATH,
		secure: true,
		sameSite: "Lax",
	});
}

function getRefreshCookieValue(c: any): string | undefined {
	return c.req.header("Cookie")
		?.split(";")
		.map((part: string) => part.trim())
		.find((part: string) => part.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
		?.slice(REFRESH_TOKEN_COOKIE_NAME.length + 1);
}

function clientIp(c: any): string | undefined {
	return getTrustedClientIp(c);
}

function requiredParam(c: any, name: string): string {
	const value = c.req.param(name);
	if (!value) throw new Error(`Missing route param ${name}`);
	return value;
}

export { auth, setAuthEmailSenderForTesting, flushPendingAuthEmails };

const REFRESH_COOKIE_NAME = "refresh_token";
const ACCESS_COOKIE_NAME = "access_token";

type PublicAuthUser = Awaited<ReturnType<typeof createUser>>["user"];

type LinkConfirmMethod = "password" | "session";

async function linkOrCreateSsoUser(identity: NormalizedExternalIdentity, currentUserId?: string): Promise<
	| { kind: "logged-in"; user: PublicAuthUser }
	| { kind: "link-needed"; linkIntentToken: string; linkMethod: LinkConfirmMethod }
> {
	const provider = providerToAuthIdentity(identity.provider);
	const linked = await findUserByExternalIdentity(provider, identity.providerUserId);
	if (linked) {
		if (!linked.isActive) throw new Error("Account is disabled");
		await updateLastLogin(linked.id);
		const { passwordHash, ...userWithoutPassword } = linked;
		return { kind: "logged-in", user: userWithoutPassword };
	}

	// Beyond an already-linked identity (matched above), every path below keys off
	// the provider-supplied email — existing-account matching and new-account
	// creation. An unverified (or omitted-verification) email could belong to
	// someone else, so refuse to let it reserve or enter the email-linking flow.
	// GitHub already filters to verified emails upstream.
	if (!identity.emailVerified) {
		throw new Error("Email address is not verified by the SSO provider");
	}

	const existingByEmail = await findUserByEmail(identity.email);
	if (existingByEmail) {
		if (!existingByEmail.isActive) throw new Error("Account is disabled");
		// Already authenticated as the matching account in the same browser: link
		// immediately, no consent round-trip needed.
		if (currentUserId === existingByEmail.id) {
			const linkedUser = await linkExternalIdentity(existingByEmail.id, {
				provider,
				subject: identity.providerUserId,
				emailVerified: identity.emailVerified,
			});
			if (!linkedUser) throw new Error("User not found");
			await updateLastLogin(linkedUser.id);
			return { kind: "logged-in", user: linkedUser };
		}
		// Otherwise require explicit confirmation. The /sso/link/confirm endpoint
		// accepts a password for local accounts or an authenticated session for
		// SSO-only accounts (which have no usable password), so this path works
		// for both account types.
		const { token } = await oauthLinkIntentStore.create({
			userId: existingByEmail.id,
			provider,
			providerUserId: identity.providerUserId,
			email: identity.email,
			name: identity.name,
			picture: identity.picture,
		});
		return {
			kind: "link-needed",
			linkIntentToken: token,
			linkMethod: existingByEmail.authProvider === "local" ? "password" : "session",
		};
	}

	const created = await createExternalUser({
		email: identity.email,
		name: identity.name,
		provider,
		subject: identity.providerUserId,
		emailVerified: identity.emailVerified,
	});
	await updateLastLogin(created.user.id);
	return { kind: "logged-in", user: created.user };
}

async function issueLogin(c: Context, user: Pick<PublicAuthUser, "id" | "email" | "role">, provider: SsoProvider | Exclude<ReturnType<typeof providerToAuthIdentity>, "local">) {
	const tokens = await generateTokens(user, {
		provider,
		ip: clientIp(c),
		userAgent: c.req.header("user-agent"),
	});
	setAuthCookie(c, ACCESS_COOKIE_NAME, tokens.accessToken, serverConfig.jwtAccessTokenExpiry);
	issueRefreshCookie(c, tokens.refreshToken);
	return { tokens };
}

function authFragmentPayload(user: PublicAuthUser, tokens: Awaited<ReturnType<typeof generateTokens>>): string {
	const params = new URLSearchParams({
		sso_status: "success",
		access_token: tokens.accessToken,
		refresh_token: tokens.refreshToken,
		user: JSON.stringify(user),
	});
	return params.toString();
}

function setOAuthCookie(c: Context, name: string, value: string): void {
	setCookie(c, name, value, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/api/auth/sso",
		maxAge: 600,
	});
}

function setAuthCookie(c: Context, name: string, value: string, maxAge: number): void {
	setCookie(c, name, value, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge,
	});
}

function clearOAuthCookies(c: Context, provider: SsoProvider): void {
	deleteCookie(c, oauthCookieName("state", provider), { path: "/api/auth/sso" });
	deleteCookie(c, oauthCookieName("pkce", provider), { path: "/api/auth/sso" });
}

function clearAuthCookies(c: Context): void {
	deleteCookie(c, ACCESS_COOKIE_NAME, { path: "/", secure: true, sameSite: "Lax" });
	// Legacy/path-"/" refresh cookie (older SSO builds); harmless to clear.
	deleteCookie(c, REFRESH_COOKIE_NAME, { path: "/", secure: true, sameSite: "Lax" });
}

function buildPostLoginRedirect(user: PublicAuthUser, tokens: Awaited<ReturnType<typeof generateTokens>>): string {
	const url = new URL(serverConfig.appUrl);
	if (ssoOneTimeCodeEnabled()) {
		// Hardened path: no tokens in the URL. The SPA exchanges this single-use
		// code at POST /sso/exchange for the tokens (JSON body). httpOnly cookies
		// were already set by issueLogin.
		const code = mintSsoLoginCode(user, tokens);
		url.hash = new URLSearchParams({ sso_status: "success", sso_code: code }).toString();
		return url.toString();
	}
	url.hash = authFragmentPayload(user, tokens);
	return url.toString();
}

function buildLinkNeededRedirect(input: { provider: SsoProvider; email: string; linkIntentToken: string; linkMethod: LinkConfirmMethod }): string {
	const url = new URL(serverConfig.appUrl);
	url.searchParams.set("sso_status", "link-needed");
	url.searchParams.set("sso_provider", input.provider);
	url.searchParams.set("sso_email", input.email);
	url.searchParams.set("link_intent_token", input.linkIntentToken);
	url.searchParams.set("link_method", input.linkMethod);
	url.searchParams.set("expires_in", "300");
	return url.toString();
}

const SSO_PROVIDER_DISPLAY_NAMES: Record<SsoProvider, string> = {
	google: "Google",
	github: "GitHub",
	line: "LINE",
};

function isProviderConfigured(provider: SsoProvider): boolean {
	if (provider === "google") {
		return Boolean(
			(serverConfig.googleOAuthClientId || process.env.GOOGLE_OAUTH_CLIENT_ID)
			&& (serverConfig.googleOAuthClientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET),
		);
	}
	if (provider === "github") {
		return Boolean(
			(serverConfig.githubOAuthClientId || process.env.GITHUB_OAUTH_CLIENT_ID)
			&& (serverConfig.githubOAuthClientSecret || process.env.GITHUB_OAUTH_CLIENT_SECRET),
		);
	}
	return Boolean(
		(serverConfig.lineLoginChannelId || process.env.LINE_LOGIN_CHANNEL_ID)
		&& (serverConfig.lineLoginChannelSecret || process.env.LINE_LOGIN_CHANNEL_SECRET),
	);
}

function readSessionLastActive(session: Awaited<ReturnType<typeof authSessionStore.listUserSessions>>[number]): number {
	const value = session.metadata?.lastActiveAt;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return session.createdAt;
}
