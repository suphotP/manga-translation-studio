import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "google-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "google-secret";
process.env.GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || "github-client";
process.env.GITHUB_OAUTH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET || "github-secret";
process.env.LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || "line-channel";
process.env.LINE_LOGIN_CHANNEL_SECRET = process.env.LINE_LOGIN_CHANNEL_SECRET || "line-secret";
// Capture and restore APP_URL so this suite's localhost override does not leak
// into env-reading siblings (e.g. mailer templates resolve absolute URLs from
// process.env.APP_URL live at render time).
const ORIGINAL_APP_URL = process.env.APP_URL;
process.env.APP_URL = process.env.APP_URL || "http://localhost:5173";

afterAll(() => {
	if (ORIGINAL_APP_URL === undefined) {
		delete process.env.APP_URL;
	} else {
		process.env.APP_URL = ORIGINAL_APP_URL;
	}
});

import type { SsoOAuthClient, SsoProvider, NormalizedExternalIdentity } from "../services/sso-oauth.js";
import { AccountLockoutTracker, setAccountLockoutTrackerForTests, type AccountLockoutRedisClient } from "../middleware/account-lockout.js";

// Minimal in-memory Redis sorted-set fake covering the commands the lockout
// tracker uses (ZADD/ZSCORE/ZRANGEBYSCORE/ZREMRANGEBYSCORE/PEXPIRE/DEL). Lets the
// SSO link-confirm test exercise the real lockout policy without a live Redis.
class InMemoryLockoutRedis implements AccountLockoutRedisClient {
	private readonly sets = new Map<string, Map<string, number>>();
	async send(command: string, args: string[]): Promise<unknown> {
		const [key, ...rest] = args;
		const set = this.sets.get(key) ?? new Map<string, number>();
		switch (command.toUpperCase()) {
			case "ZADD":
				set.set(rest[1]!, Number(rest[0]));
				this.sets.set(key, set);
				return 1;
			case "ZSCORE": {
				const score = set.get(rest[0]!);
				return score === undefined ? null : String(score);
			}
			case "ZRANGEBYSCORE": {
				const [min, max] = [Number(rest[0]), Number(rest[1])];
				return [...set.entries()].filter(([, s]) => s >= min && s <= max).map(([m]) => m);
			}
			case "ZREMRANGEBYSCORE": {
				const [min, max] = [Number(rest[0]), Number(rest[1])];
				for (const [m, s] of set) if (s >= min && s <= max) set.delete(m);
				return 0;
			}
			case "PEXPIRE":
				return 1;
			case "DEL":
				this.sets.delete(key);
				return 1;
			default:
				throw new Error(`Unsupported fake lockout Redis command: ${command}`);
		}
	}
}

class FakeSsoOAuthClient implements SsoOAuthClient {
	identity: NormalizedExternalIdentity = {
		provider: "google",
		providerUserId: "google-user-1",
		email: uniqueEmail("google-created"),
		emailVerified: true,
		name: "Google Created",
		picture: "https://example.test/avatar.png",
	};
	validateCalls: Array<{ provider: SsoProvider; code: string; codeVerifier: string }> = [];

	createAuthorizationURL(provider: SsoProvider, state: string, codeVerifier: string): URL {
		const url = new URL(`https://${provider}.example.test/authorize`);
		url.searchParams.set("state", state);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("code_verifier_echo", codeVerifier);
		return url;
	}

	async validateAuthorizationCode(provider: SsoProvider, code: string, codeVerifier: string): Promise<any> {
		this.validateCalls.push({ provider, code, codeVerifier });
		return { accessToken: () => `${provider}-access-token` };
	}

	async fetchUserInfo(provider: SsoProvider): Promise<NormalizedExternalIdentity> {
		return { ...this.identity, provider };
	}
}

describe("SSO OAuth routes", () => {
	let modules: Awaited<ReturnType<typeof loadAuthModules>>;
	let fakeClient: FakeSsoOAuthClient;
	let restoreClient: () => void;

	beforeEach(async () => {
		modules = await loadAuthModules();
		fakeClient = new FakeSsoOAuthClient();
		restoreClient = modules.setSsoOAuthClientForTests(fakeClient);
	});

	afterEach(() => {
		restoreClient();
	});

	test("start creates PKCE/state cookies and redirects to the provider", async () => {
		const response = await modules.auth.request("/sso/google/start", { redirect: "manual" });

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("https://google.example.test/authorize");
		const setCookie = response.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain("oauth_state_google=");
		expect(setCookie).toContain("oauth_pkce_google=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
	});

	test("state mismatch returns 403 before token exchange", async () => {
		const response = await modules.auth.request("/sso/google/callback?code=code-1&state=wrong", {
			headers: {
				Cookie: "oauth_state_google=expected; oauth_pkce_google=verifier-1",
			},
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "OAuth state mismatch", code: "oauth_state_mismatch" });
		expect(fakeClient.validateCalls).toHaveLength(0);
	});

	test("valid callback creates and links a new OAuth user", async () => {
		fakeClient.identity = {
			provider: "github",
			providerUserId: "github-123",
			email: uniqueEmail("github-new"),
			emailVerified: true,
			name: "GitHub New",
		};

		const response = await modules.auth.request("/sso/github/callback?code=code-2&state=state-2", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_github=state-2; oauth_pkce_github=verifier-2",
			},
		});

		expect(response.status).toBe(302);
		const redirect = new URL(response.headers.get("Location") ?? "");
		expect(redirect.origin).toBe("http://localhost:5173");
		const redirectParams = new URLSearchParams(redirect.hash.slice(1));
		expect(redirectParams.get("sso_status")).toBe("success");
		// Default (hardened) path: NO tokens in the fragment — only a single-use code.
		expect(redirectParams.get("access_token")).toBeNull();
		expect(redirectParams.get("refresh_token")).toBeNull();
		expect(redirectParams.get("sso_code")).toMatch(/^mews_sso_/);
		// The user + tokens come from the POST /sso/exchange, not the URL.
		const exchanged = await modules.auth.request("/sso/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code: redirectParams.get("sso_code") }),
		});
		expect(exchanged.status).toBe(200);
		const exchangedBody = await exchanged.json();
		expect(typeof exchangedBody.tokens.accessToken).toBe("string");
		expect(typeof exchangedBody.tokens.refreshToken).toBe("string");
		expect(exchangedBody.user).toEqual(expect.objectContaining({
			email: fakeClient.identity.email,
			authProvider: "github",
		}));
		expect(fakeClient.validateCalls[0]).toEqual({
			provider: "github",
			code: "code-2",
			codeVerifier: "verifier-2",
		});
		const linked = await modules.findUserByExternalIdentity("github", "github-123");
		expect(linked).toEqual(expect.objectContaining({
			email: fakeClient.identity.email,
			authProvider: "github",
			externalSubject: "github-123",
			emailVerified: true,
		}));
		expect(response.headers.get("Set-Cookie")).toContain("mews_refresh=");
	});

	test("email match without provider link redirects link-needed and wrong password does not consume the token", async () => {
		const email = uniqueEmail("line-link");
		const created = await modules.createUser({
			email,
			password: "StrongP@ss123",
			name: "Existing Local",
		});
		fakeClient.identity = {
			provider: "line",
			providerUserId: "line-user-1",
			email,
			emailVerified: true,
			name: "LINE Existing",
		};

		const callback = await modules.auth.request("/sso/line/callback?code=code-3&state=state-3", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_line=state-3; oauth_pkce_line=verifier-3",
			},
		});

		expect(callback.status).toBe(302);
		const linkNeeded = new URL(callback.headers.get("Location") ?? "");
		expect(linkNeeded.origin).toBe("http://localhost:5173");
		expect(linkNeeded.searchParams.get("sso_status")).toBe("link-needed");
		expect(linkNeeded.searchParams.get("sso_provider")).toBe("line");
		expect(linkNeeded.searchParams.get("sso_email")).toBe(email);
		const linkIntentToken = linkNeeded.searchParams.get("link_intent_token");
		expect(linkIntentToken).toMatch(/^mews_link_/);

		const rejected = await modules.auth.request("/sso/link/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				link_intent_token: linkIntentToken,
				currentPassword: "wrong-password",
			}),
		});
		expect(rejected.status).toBe(401);
		expect(await rejected.json()).toEqual({ error: "Current password is incorrect", code: "current_password_incorrect" });

		const confirmed = await modules.auth.request("/sso/link/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				link_intent_token: linkIntentToken,
				currentPassword: "StrongP@ss123",
			}),
		});

		expect(confirmed.status).toBe(200);
		const body = await confirmed.json();
		expect(body.status).toBe("linked");
		expect(body.user.id).toBe(created.user.id);
		expect(typeof body.tokens.accessToken).toBe("string");
		expect(await modules.findUserByExternalIdentity("line", "line-user-1")).toEqual(expect.objectContaining({
			id: created.user.id,
		}));
	});

	test("SSO-only email matches can link a new provider from the current SSO session", async () => {
		const email = uniqueEmail("provider-link");
		const created = await modules.createExternalUser({
			email,
			name: "Google Existing",
			provider: "google",
			subject: "google-existing-1",
			emailVerified: true,
		});
		fakeClient.identity = {
			provider: "google",
			providerUserId: "google-existing-1",
			email,
			emailVerified: true,
			name: "Google Existing",
		};

		const login = await modules.auth.request("/sso/google/callback?code=code-sso-login&state=state-login", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_google=state-login; oauth_pkce_google=verifier-login",
			},
		});
		const loginCookie = login.headers.get("Set-Cookie") ?? "";
		const accessToken = extractCookieValue(loginCookie, "access_token");
		expect(accessToken).toBeDefined();

		fakeClient.identity = {
			provider: "line",
			providerUserId: "line-provider-link-1",
			email,
			emailVerified: true,
			name: "LINE Existing",
		};
		const linked = await modules.auth.request("/sso/line/callback?code=code-line-link&state=state-line", {
			redirect: "manual",
			headers: {
				Cookie: `access_token=${accessToken}; oauth_state_line=state-line; oauth_pkce_line=verifier-line`,
			},
		});

		expect(linked.status).toBe(302);
		const redirect = new URL(linked.headers.get("Location") ?? "");
		expect(new URLSearchParams(redirect.hash.slice(1)).get("sso_status")).toBe("success");
		expect(await modules.findUserByExternalIdentity("line", "line-provider-link-1")).toEqual(expect.objectContaining({
			id: created.user.id,
		}));
	});

	test("SSO-only email matches without a session redirect link-needed with session confirmation method", async () => {
		const email = uniqueEmail("provider-link-unauth");
		await modules.createExternalUser({
			email,
			name: "Google Existing",
			provider: "google",
			subject: "google-existing-unauth-1",
			emailVerified: true,
		});
		fakeClient.identity = {
			provider: "github",
			providerUserId: "github-provider-link-unauth-1",
			email,
			emailVerified: true,
			name: "GitHub Existing",
		};

		const response = await modules.auth.request("/sso/github/callback?code=code-github-unauth&state=state-github", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_github=state-github; oauth_pkce_github=verifier-github",
			},
		});

		expect(response.status).toBe(302);
		const linkNeeded = new URL(response.headers.get("Location") ?? "");
		expect(linkNeeded.searchParams.get("sso_status")).toBe("link-needed");
		expect(linkNeeded.searchParams.get("sso_provider")).toBe("github");
		expect(linkNeeded.searchParams.get("sso_email")).toBe(email);
		// SSO-only accounts have no usable password, so the client must confirm
		// with an authenticated session rather than a password prompt.
		expect(linkNeeded.searchParams.get("link_method")).toBe("session");
		expect(linkNeeded.searchParams.get("link_intent_token")).toMatch(/^mews_link_/);

		// A password-only confirmation cannot succeed for an SSO-only account and
		// must not link the identity.
		const linkIntentToken = linkNeeded.searchParams.get("link_intent_token");
		const passwordAttempt = await modules.auth.request("/sso/link/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ link_intent_token: linkIntentToken, currentPassword: "anything" }),
		});
		expect(passwordAttempt.status).toBe(401);
		expect(await modules.findUserByExternalIdentity("github", "github-provider-link-unauth-1")).toBeNull();
	});

	test("local-account link-needed redirect advertises password confirmation method", async () => {
		const email = uniqueEmail("local-link-method");
		await modules.createUser({ email, password: "StrongP@ss123", name: "Local Link" });
		fakeClient.identity = {
			provider: "github",
			providerUserId: "github-local-link-method-1",
			email,
			emailVerified: true,
			name: "GitHub Local Link",
		};

		const response = await modules.auth.request("/sso/github/callback?code=code-local-method&state=state-local-method", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_github=state-local-method; oauth_pkce_github=verifier-local-method",
			},
		});

		expect(response.status).toBe(302);
		const linkNeeded = new URL(response.headers.get("Location") ?? "");
		expect(linkNeeded.searchParams.get("sso_status")).toBe("link-needed");
		expect(linkNeeded.searchParams.get("link_method")).toBe("password");
	});

	test("SSO-only accounts confirm a new provider link with an authenticated session", async () => {
		const email = uniqueEmail("sso-session-confirm");
		const created = await modules.createExternalUser({
			email,
			name: "Google Existing",
			provider: "google",
			subject: "google-session-confirm-1",
			emailVerified: true,
		});
		fakeClient.identity = {
			provider: "google",
			providerUserId: "google-session-confirm-1",
			email,
			emailVerified: true,
			name: "Google Existing",
		};

		// First, sign in with the existing Google provider to obtain a session.
		const login = await modules.auth.request("/sso/google/callback?code=code-session-login&state=state-session-login", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_google=state-session-login; oauth_pkce_google=verifier-session-login",
			},
		});
		const accessToken = extractCookieValue(login.headers.get("Set-Cookie") ?? "", "access_token");
		expect(accessToken).toBeDefined();

		// A fresh LINE login (no current session header) produces a link-needed intent.
		fakeClient.identity = {
			provider: "line",
			providerUserId: "line-session-confirm-1",
			email,
			emailVerified: true,
			name: "LINE Existing",
		};
		const callback = await modules.auth.request("/sso/line/callback?code=code-session-line&state=state-session-line", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_line=state-session-line; oauth_pkce_line=verifier-session-line",
			},
		});
		const linkIntentToken = new URL(callback.headers.get("Location") ?? "").searchParams.get("link_intent_token");
		expect(linkIntentToken).toBeTruthy();

		// Confirming without a session is rejected.
		const noSession = await modules.auth.request("/sso/link/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ link_intent_token: linkIntentToken }),
		});
		expect(noSession.status).toBe(401);

		// Confirming with the existing account's session links the new provider.
		const confirmed = await modules.auth.request("/sso/link/confirm", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ link_intent_token: linkIntentToken }),
		});
		expect(confirmed.status).toBe(200);
		const body = await confirmed.json();
		expect(body.status).toBe("linked");
		expect(body.user.id).toBe(created.user.id);
		expect(await modules.findUserByExternalIdentity("line", "line-session-confirm-1")).toEqual(expect.objectContaining({
			id: created.user.id,
		}));
	});

	test("link confirmation refuses stale intents for identities linked to another user", async () => {
		const email = uniqueEmail("stale-link");
		const target = await modules.createUser({
			email,
			password: "StrongP@ss123",
			name: "Target Local",
		});
		const owner = await modules.createUser({
			email: uniqueEmail("identity-owner"),
			password: "StrongP@ss123",
			name: "Identity Owner",
		});
		fakeClient.identity = {
			provider: "github",
			providerUserId: "github-stale-link-1",
			email,
			emailVerified: true,
			name: "GitHub Stale",
		};

		const callback = await modules.auth.request("/sso/github/callback?code=code-stale&state=state-stale", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_github=state-stale; oauth_pkce_github=verifier-stale",
			},
		});
		const linkNeeded = new URL(callback.headers.get("Location") ?? "");
		const linkIntentToken = linkNeeded.searchParams.get("link_intent_token");
		expect(linkIntentToken).toBeTruthy();
		await modules.linkExternalIdentity(owner.user.id, {
			provider: "github",
			subject: "github-stale-link-1",
			emailVerified: true,
		});

		const confirmed = await modules.auth.request("/sso/link/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				link_intent_token: linkIntentToken,
				currentPassword: "StrongP@ss123",
			}),
		});

		expect(confirmed.status).toBe(409);
		expect(await confirmed.json()).toEqual({ error: "External identity already linked to another user", code: "external_identity_taken" });
		expect(await modules.findUserByExternalIdentity("github", "github-stale-link-1")).toEqual(expect.objectContaining({
			id: owner.user.id,
		}));
		expect((await modules.findUserByExternalIdentity("github", "github-stale-link-1"))?.id).not.toBe(target.user.id);
	});

	test("rejects an unverified provider email before account matching or creation", async () => {
		const email = uniqueEmail("unverified-create");
		fakeClient.identity = {
			provider: "google",
			providerUserId: "google-unverified-1",
			email,
			emailVerified: false,
			name: "Unverified Google",
		};

		const response = await modules.auth.request("/sso/google/callback?code=code-unverified&state=state-unverified", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_google=state-unverified; oauth_pkce_google=verifier-unverified",
			},
		});

		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("not verified");
		// No account is created and no identity is reserved for the unverified email.
		expect(await modules.findUserByExternalIdentity("google", "google-unverified-1")).toBeNull();
	});

	test("an unverified provider email cannot enter the link flow for an existing account", async () => {
		const email = uniqueEmail("unverified-match");
		await modules.createUser({ email, password: "StrongP@ss123", name: "Local Owner" });
		fakeClient.identity = {
			provider: "line",
			providerUserId: "line-unverified-match-1",
			email,
			emailVerified: false,
			name: "Unverified LINE",
		};

		const response = await modules.auth.request("/sso/line/callback?code=code-uvm&state=state-uvm", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_line=state-uvm; oauth_pkce_line=verifier-uvm",
			},
		});

		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("not verified");
		expect(await modules.findUserByExternalIdentity("line", "line-unverified-match-1")).toBeNull();
	});

	test("password login sets the refresh cookie so /sessions can mark it current", async () => {
		const email = uniqueEmail("local-session");
		await modules.createUser({ email, password: "StrongP@ss123", name: "Local Session" });

		const login = await modules.auth.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "StrongP@ss123" }),
		});
		expect(login.status).toBe(200);
		const setCookie = login.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain("mews_refresh=");
		const accessToken = extractCookieValue(setCookie, "access_token");
		const refreshToken = extractCookieValue(setCookie, "mews_refresh");
		expect(accessToken).toBeDefined();
		expect(refreshToken).toBeDefined();

		const sessions = await modules.auth.request("/sessions", {
			headers: { Cookie: `access_token=${accessToken}; mews_refresh=${refreshToken}` },
		});
		const body = await sessions.json();
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0]).toEqual(expect.objectContaining({
			provider: "local",
			current_session: true,
		}));
	});

	test("bearer-only clients identify their current session via the access-token sid (no refresh cookie)", async () => {
		const email = uniqueEmail("bearer-session");
		await modules.createUser({ email, password: "StrongP@ss123", name: "Bearer Session" });

		const login = await modules.auth.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "StrongP@ss123" }),
		});
		expect(login.status).toBe(200);
		const accessToken = (await login.json()).tokens.accessToken as string;

		// Pure bearer client: Authorization header only, no httpOnly refresh cookie.
		const sessions = await modules.auth.request("/sessions", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		const body = await sessions.json();
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].current_session).toBe(true);
	});

	test("sessions list marks the refresh-cookie session current and revoke removes it", async () => {
		fakeClient.identity = {
			provider: "google",
			providerUserId: "google-session-1",
			email: uniqueEmail("session"),
			emailVerified: true,
			name: "Session User",
		};
		const callback = await modules.auth.request("/sso/google/callback?code=code-4&state=state-4", {
			redirect: "manual",
			headers: {
				"x-forwarded-for": "203.0.113.10",
				"user-agent": "SSO Test",
				Cookie: "oauth_state_google=state-4; oauth_pkce_google=verifier-4",
			},
		});
		expect(callback.status).toBe(302);
		const setCookie = callback.headers.get("Set-Cookie") ?? "";
		const accessToken = extractCookieValue(setCookie, "access_token");
		const refreshToken = extractCookieValue(setCookie, "mews_refresh");
		expect(accessToken).toBeDefined();
		expect(refreshToken).toBeDefined();

		const sessionsResponse = await modules.auth.request("/sessions", {
			headers: {
				Cookie: `access_token=${accessToken}; mews_refresh=${refreshToken}`,
			},
		});
		expect(sessionsResponse.status).toBe(200);
		const sessionsBody = await sessionsResponse.json();
		expect(sessionsBody.sessions).toHaveLength(1);
		expect(sessionsBody.sessions[0]).toEqual(expect.objectContaining({
			provider: "google",
			ip: "203.0.113.10",
			ua: "SSO Test",
			current_session: true,
		}));

		const refreshResponse = await modules.auth.request("/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken }),
		});
		expect(refreshResponse.status).toBe(200);
		const refreshed = await refreshResponse.json();
		const refreshedSessions = await modules.auth.request("/sessions", {
			headers: { Authorization: `Bearer ${refreshed.tokens.accessToken}` },
		});
		const refreshedSessionsBody = await refreshedSessions.json();
		expect(refreshedSessionsBody.sessions[0]).toEqual(expect.objectContaining({
			provider: "google",
		}));

		const revokeResponse = await modules.auth.request(`/sessions/${refreshedSessionsBody.sessions[0].id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${refreshed.tokens.accessToken}` },
		});
		expect(revokeResponse.status).toBe(200);

		// Hardened behavior (P1: session-id revocation on access tokens): revoking the
		// session that this access token was minted with (`sid`) invalidates the access
		// token IMMEDIATELY, instead of letting it work until its own expiry. The very
		// next request with that token must be rejected.
		const afterRevoke = await modules.auth.request("/sessions", {
			headers: { Authorization: `Bearer ${refreshed.tokens.accessToken}` },
		});
		expect(afterRevoke.status).toBe(401);
	});

	// ── P1.3: hardened SSO redirect carries no tokens; tokens come from exchange ──
	test("with SSO_ONE_TIME_CODE the callback redirect has no refresh token in the URL", async () => {
		const prev = process.env.SSO_ONE_TIME_CODE;
		process.env.SSO_ONE_TIME_CODE = "true";
		try {
			fakeClient.identity = {
				provider: "google",
				providerUserId: "google-otc-1",
				email: uniqueEmail("otc"),
				emailVerified: true,
				name: "OTC User",
			};
			const callback = await modules.auth.request("/sso/google/callback?code=code-otc&state=state-otc", {
				redirect: "manual",
				headers: { Cookie: "oauth_state_google=state-otc; oauth_pkce_google=verifier-otc" },
			});
			expect(callback.status).toBe(302);
			const redirect = new URL(callback.headers.get("Location") ?? "");
			const fragment = new URLSearchParams(redirect.hash.slice(1));
			// The fragment must carry a single-use code and NOTHING token-bearing.
			expect(fragment.get("sso_status")).toBe("success");
			expect(fragment.get("sso_code")).toMatch(/^mews_sso_/);
			expect(fragment.get("refresh_token")).toBeNull();
			expect(fragment.get("access_token")).toBeNull();
			// httpOnly cookies are still set on the callback.
			expect(callback.headers.get("Set-Cookie") ?? "").toContain("mews_refresh=");

			// Exchanging the code yields the tokens in the JSON body, once.
			const code = fragment.get("sso_code")!;
			const exchange = await modules.auth.request("/sso/exchange", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code }),
			});
			expect(exchange.status).toBe(200);
			const exchanged = await exchange.json();
			expect(typeof exchanged.tokens.accessToken).toBe("string");
			expect(typeof exchanged.tokens.refreshToken).toBe("string");

			// Single-use: a second exchange of the same code is rejected.
			const replay = await modules.auth.request("/sso/exchange", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code }),
			});
			expect(replay.status).toBe(401);
		} finally {
			if (prev === undefined) delete process.env.SSO_ONE_TIME_CODE;
			else process.env.SSO_ONE_TIME_CODE = prev;
		}
	});

	// ── P1.4: SSO link-confirm wrong password feeds account lockout ──
	test("repeated wrong passwords on /sso/link/confirm trip account lockout", async () => {
		const tracker = new AccountLockoutTracker({
			redisClient: new InMemoryLockoutRedis(),
			failureLimit: 3,
		});
		setAccountLockoutTrackerForTests(tracker);
		try {
			const email = uniqueEmail("link-lockout");
			await modules.createUser({ email, password: "StrongP@ss123", name: "Lockout Local" });
			fakeClient.identity = {
				provider: "line",
				providerUserId: "line-lockout-1",
				email,
				emailVerified: true,
				name: "LINE Lockout",
			};
			const callback = await modules.auth.request("/sso/line/callback?code=code-lk&state=state-lk", {
				redirect: "manual",
				headers: { Cookie: "oauth_state_line=state-lk; oauth_pkce_line=verifier-lk" },
			});
			const linkNeeded = new URL(callback.headers.get("Location") ?? "");
			const linkIntentToken = linkNeeded.searchParams.get("link_intent_token");
			expect(linkIntentToken).toMatch(/^mews_link_/);

			async function attempt(password: string) {
				return modules.auth.request("/sso/link/confirm", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ link_intent_token: linkIntentToken, currentPassword: password }),
				});
			}

			// First failures are recorded (401), then the policy locks the account (429).
			expect((await attempt("wrong-1")).status).toBe(401);
			expect((await attempt("wrong-2")).status).toBe(401);
			const locked = await attempt("wrong-3");
			expect(locked.status).toBe(429);
			const lockedBody = await locked.json() as { code?: string };
			expect(lockedBody.code).toBe("account_locked");
		} finally {
			setAccountLockoutTrackerForTests(new AccountLockoutTracker());
		}
	});

	test("refresh succeeds with only the refresh cookie and an empty body, preserving the SSO provider", async () => {
		fakeClient.identity = {
			provider: "google",
			providerUserId: "google-cookie-refresh-1",
			email: uniqueEmail("cookie-refresh"),
			emailVerified: true,
			name: "Cookie Refresh",
		};
		const callback = await modules.auth.request("/sso/google/callback?code=code-cookie&state=state-cookie", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_google=state-cookie; oauth_pkce_google=verifier-cookie",
			},
		});
		const setCookie = callback.headers.get("Set-Cookie") ?? "";
		const refreshToken = extractCookieValue(setCookie, "mews_refresh");
		expect(refreshToken).toBeDefined();

		// Bare POST: no JSON body, refresh token comes from the httpOnly cookie.
		const refreshResponse = await modules.auth.request("/refresh", {
			method: "POST",
			headers: { Cookie: `mews_refresh=${refreshToken}` },
		});
		expect(refreshResponse.status).toBe(200);
		const refreshed = await refreshResponse.json();
		expect(typeof refreshed.tokens.accessToken).toBe("string");

		// The rotated session must keep its SSO provider, not fall back to "local".
		const sessions = await modules.auth.request("/sessions", {
			headers: { Authorization: `Bearer ${refreshed.tokens.accessToken}` },
		});
		const sessionsBody = await sessions.json();
		expect(sessionsBody.sessions[0]).toEqual(expect.objectContaining({ provider: "google" }));
	});

	test("refresh still rejects a present-but-malformed JSON body", async () => {
		const response = await modules.auth.request("/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{ not json",
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid JSON body", code: "invalid_json" });
	});

	test("logout revokes the cookie-backed session and clears the auth cookies", async () => {
		fakeClient.identity = {
			provider: "google",
			providerUserId: "google-logout-1",
			email: uniqueEmail("logout"),
			emailVerified: true,
			name: "Logout User",
		};
		const callback = await modules.auth.request("/sso/google/callback?code=code-logout&state=state-logout", {
			redirect: "manual",
			headers: {
				Cookie: "oauth_state_google=state-logout; oauth_pkce_google=verifier-logout",
			},
		});
		const setCookie = callback.headers.get("Set-Cookie") ?? "";
		const accessToken = extractCookieValue(setCookie, "access_token");
		const refreshToken = extractCookieValue(setCookie, "mews_refresh");
		expect(accessToken).toBeDefined();
		expect(refreshToken).toBeDefined();

		// Bare logout that relies on the httpOnly cookies (no JSON body).
		const logout = await modules.auth.request("/logout", {
			method: "POST",
			headers: { Cookie: `access_token=${accessToken}; mews_refresh=${refreshToken}` },
		});
		expect(logout.status).toBe(200);
		const logoutCookies = logout.headers.get("Set-Cookie") ?? "";
		expect(logoutCookies).toContain("access_token=");
		expect(logoutCookies).toContain("mews_refresh=");
		// Cookies are cleared via Max-Age=0 / Expires in the past.
		expect(logoutCookies).toMatch(/access_token=;|access_token=[^;]*Max-Age=0/i);

		// The revoked refresh cookie can no longer mint a new session.
		const afterLogout = await modules.auth.request("/refresh", {
			method: "POST",
			headers: { Cookie: `mews_refresh=${refreshToken}` },
		});
		expect(afterLogout.status).toBe(401);
	});
});

describe("SSO provider profile normalization", () => {
	const realFetch = globalThis.fetch;

	beforeEach(async () => {
		// Ensure the real Arctic client is installed even if a prior test left a
		// fake SSO client on the shared module binding.
		const { ArcticSsoOAuthClient, setSsoOAuthClientForTests } = await import("../services/sso-oauth.js");
		setSsoOAuthClientForTests(new ArcticSsoOAuthClient());
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("Google userinfo fetch normalizes verified email and subject", async () => {
		const { ssoOAuthClient } = await import("../services/sso-oauth.js");
		globalThis.fetch = mock(async (url: RequestInfo | URL) => {
			expect(String(url)).toBe("https://openidconnect.googleapis.com/v1/userinfo");
			return new Response(JSON.stringify({
				sub: "google-sub",
				email: "google-profile@example.com",
				email_verified: true,
				name: "Google Profile",
				picture: "https://example.test/google.png",
			}), { status: 200 });
		}) as typeof fetch;

		const profile = await ssoOAuthClient.fetchUserInfo("google", fakeTokens());

		expect(profile).toEqual({
			provider: "google",
			providerUserId: "google-sub",
			email: "google-profile@example.com",
			emailVerified: true,
			name: "Google Profile",
			picture: "https://example.test/google.png",
		});
	});

	test("GitHub token exchange posts client_id/client_secret and PKCE verifier in the body", async () => {
		const { ArcticSsoOAuthClient } = await import("../services/sso-oauth.js");
		const arcticClient = new ArcticSsoOAuthClient();
		let capturedBody = "";
		let capturedAuthHeader: string | null = "unset";
		globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			// Support both fetch(url, init) and fetch(Request) call shapes so the
			// assertion is robust regardless of how the runtime normalizes the call.
			if (input instanceof Request) {
				expect(input.url).toBe("https://github.com/login/oauth/access_token");
				capturedBody = await input.clone().text();
				capturedAuthHeader = input.headers.get("Authorization");
			} else {
				expect(String(input)).toBe("https://github.com/login/oauth/access_token");
				capturedBody = typeof init?.body === "string" ? init.body : "";
				capturedAuthHeader = new Headers(init?.headers).get("Authorization");
			}
			return new Response(JSON.stringify({ access_token: "gho_test", token_type: "bearer", scope: "read:user" }), { status: 200 });
		}) as typeof fetch;

		const tokens = await arcticClient.validateAuthorizationCode("github", "code-xyz", "verifier-xyz");

		// `serverConfig` is frozen at import time, which may predate this file's
		// env setup when the whole suite runs, so assert against the configured
		// values the implementation actually uses.
		const { serverConfig } = await import("../config.js");
		const params = new URLSearchParams(capturedBody);
		expect(params.get("client_id")).toBe(serverConfig.githubOAuthClientId);
		expect(params.get("client_secret")).toBe(serverConfig.githubOAuthClientSecret);
		expect(params.has("client_id")).toBe(true);
		expect(params.has("client_secret")).toBe(true);
		expect(params.get("code")).toBe("code-xyz");
		expect(params.get("code_verifier")).toBe("verifier-xyz");
		expect(params.get("grant_type")).toBe("authorization_code");
		// Credentials must not be sent via HTTP Basic auth for GitHub.
		expect(capturedAuthHeader).toBeNull();
		expect(tokens.accessToken()).toBe("gho_test");
	});

	test("GitHub token exchange surfaces provider OAuth errors", async () => {
		const { ArcticSsoOAuthClient } = await import("../services/sso-oauth.js");
		const arcticClient = new ArcticSsoOAuthClient();
		globalThis.fetch = mock(async () => new Response(JSON.stringify({
			error: "bad_verification_code",
			error_description: "The code passed is incorrect or expired.",
		}), { status: 200 })) as typeof fetch;

		await expect(arcticClient.validateAuthorizationCode("github", "bad", "verifier")).rejects.toThrow("bad_verification_code");
	});

	test("GitHub userinfo rejects accounts without a verified email", async () => {
		const { ssoOAuthClient } = await import("../services/sso-oauth.js");
		globalThis.fetch = mock(async (url: RequestInfo | URL) => {
			const requestUrl = String(url);
			if (requestUrl === "https://api.github.com/user") {
				return new Response(JSON.stringify({
					id: 123,
					email: "public-unverified@example.com",
					login: "github-user",
				}), { status: 200 });
			}
			if (requestUrl === "https://api.github.com/user/emails") {
				return new Response(JSON.stringify([
					{ email: "unverified@example.com", primary: true, verified: false },
				]), { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		await expect(ssoOAuthClient.fetchUserInfo("github", fakeTokens())).rejects.toThrow("GitHub profile did not include a usable verified email");
	});

	test("GitHub userinfo uses verified email instead of public profile fallback", async () => {
		const { ssoOAuthClient } = await import("../services/sso-oauth.js");
		globalThis.fetch = mock(async (url: RequestInfo | URL) => {
			const requestUrl = String(url);
			if (requestUrl === "https://api.github.com/user") {
				return new Response(JSON.stringify({
					id: 456,
					email: "public@example.com",
					login: "github-user",
				}), { status: 200 });
			}
			if (requestUrl === "https://api.github.com/user/emails") {
				return new Response(JSON.stringify([
					{ email: "secondary-verified@example.com", primary: false, verified: true },
				]), { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const profile = await ssoOAuthClient.fetchUserInfo("github", fakeTokens());

		expect(profile).toEqual(expect.objectContaining({
			provider: "github",
			providerUserId: "456",
			email: "secondary-verified@example.com",
			emailVerified: true,
		}));
	});

	test("LINE userinfo trusts the ID-token email even when email_verified is omitted", async () => {
		const { ssoOAuthClient } = await import("../services/sso-oauth.js");
		// LINE's verify-id-token docs include an `email` claim (with the Email
		// permission) but never an `email_verified` claim. Encode an ID token with
		// the email present and email_verified omitted.
		const idToken = unsignedJwt({ sub: "line-sub", email: "line-user@example.com", name: "LINE Profile" });
		const tokens = {
			accessToken: () => "line-access-token",
			idToken: () => idToken,
		} as any;
		globalThis.fetch = mock(async (url: RequestInfo | URL) => {
			expect(String(url)).toBe("https://api.line.me/v2/profile");
			return new Response(JSON.stringify({
				userId: "line-profile-id",
				displayName: "LINE Display",
				pictureUrl: "https://example.test/line.png",
			}), { status: 200 });
		}) as typeof fetch;

		const profile = await ssoOAuthClient.fetchUserInfo("line", tokens);

		expect(profile).toEqual({
			provider: "line",
			providerUserId: "line-profile-id",
			email: "line-user@example.com",
			emailVerified: true,
			name: "LINE Display",
			picture: "https://example.test/line.png",
		});
	});

	test("LINE userinfo still honours an explicit email_verified=false claim", async () => {
		const { ssoOAuthClient } = await import("../services/sso-oauth.js");
		const idToken = unsignedJwt({ sub: "line-sub-2", email: "line-unverified@example.com", email_verified: false });
		const tokens = {
			accessToken: () => "line-access-token",
			idToken: () => idToken,
		} as any;
		globalThis.fetch = mock(async () => new Response(JSON.stringify({
			userId: "line-profile-id-2",
			displayName: "LINE Unverified",
		}), { status: 200 })) as typeof fetch;

		const profile = await ssoOAuthClient.fetchUserInfo("line", tokens);

		expect(profile.emailVerified).toBe(false);
	});
});

function unsignedJwt(payload: Record<string, unknown>): string {
	const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(payload)}.`;
}

async function loadAuthModules() {
	const [{ auth }, sso, authService] = await Promise.all([
		import("../routes/auth.js"),
		import("../services/sso-oauth.js"),
		import("../services/auth.service.js"),
	]);
	return {
		auth,
		setSsoOAuthClientForTests: sso.setSsoOAuthClientForTests,
		createUser: authService.createUser,
		createExternalUser: authService.createExternalUser,
		findUserByExternalIdentity: authService.findUserByExternalIdentity,
		linkExternalIdentity: authService.linkExternalIdentity,
	};
}

function uniqueEmail(label: string): string {
	return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function extractCookieValue(setCookie: string, name: string): string | undefined {
	const match = setCookie.match(new RegExp(`${name}=([^;,]+)`));
	return match?.[1];
}

function fakeTokens(): any {
	return {
		accessToken: () => "provider-access-token",
		idToken: () => "",
	};
}
