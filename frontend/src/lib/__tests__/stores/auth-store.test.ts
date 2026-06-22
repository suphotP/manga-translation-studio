import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { ApiError } from "$lib/api/client.ts";
import { authStore, rolePermissionProfile } from "$lib/stores/auth.svelte.ts";
import type { AuthResponse, AuthUser } from "$lib/api/client.ts";
import { setLocale } from "$lib/i18n";

// The auth store does `instanceof ApiError` to tell a transient failure (429 /
// 5xx / network) from a real auth rejection (401/403), so the mock must expose
// the REAL ApiError class (not a vi.fn stub) or every error would be treated as
// non-fatal. We re-export the genuine class and stub only the request fns.
vi.mock("$lib/api/client.ts", async () => {
	const actual = await vi.importActual<typeof import("$lib/api/client.ts")>("$lib/api/client.ts");
	return {
		ApiError: actual.ApiError,
		clearApiAccessToken: vi.fn(),
		getCurrentUser: vi.fn(),
		login: vi.fn(),
		logout: vi.fn(),
		refreshAuthSession: vi.fn(),
		registerUser: vi.fn(),
		setApiAccessToken: vi.fn(),
		setAuthRefreshHandler: vi.fn(),
		updateMyProfile: vi.fn(),
		confirmSsoLink: vi.fn(),
		exchangeSsoCode: vi.fn(),
	};
});

// Build a typed ApiError for a given HTTP status, matching what handleResponse
// throws for a non-ok response.
function apiError(status: number, code?: string): ApiError {
	return new ApiError(`API Error: ${status}`, { status, statusText: "", code });
}

const PENDING_SSO_LINK_KEY = "manga-editor.auth.pending-sso-link.v1";

const user: AuthUser = {
	id: "user-1",
	email: "editor@example.com",
	name: "Editor One",
	role: "editor",
	authProvider: "local",
	emailVerified: false,
	isActive: true,
};

function authResponse(overrides: Partial<AuthResponse> = {}): AuthResponse {
	return {
		user,
		tokens: {
			accessToken: "access-1",
			refreshToken: "refresh-1",
		},
		...overrides,
	};
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	sessionStorage.clear();
	// Reset any SSO redirect fragment/query a prior test left on the URL.
	window.history.replaceState(null, "", "/");
	authStore.__resetForTesting();
});

describe("authStore", () => {
	it("signs in, stores the access token, and exposes role permissions", async () => {
		vi.mocked(api.login).mockResolvedValue(authResponse());

		await authStore.signIn("editor@example.com", "Password!123");

		expect(authStore.isAuthenticated).toBe(true);
		expect(authStore.user?.email).toBe("editor@example.com");
		expect(authStore.can("update:project")).toBe(true);
		expect(authStore.can("manage:settings")).toBe(false);
		expect(authStore.capabilities.canTypeset).toBe(true);
		expect(authStore.capabilities.canManageBilling).toBe(false);
		expect(api.setApiAccessToken).toHaveBeenCalledWith("access-1");
		expect(localStorage.getItem("manga-editor.auth.session.v1")).toContain("refresh-1");
	});

	it("applies the signed-in user's stored locale without echoing a profile PATCH", async () => {
		vi.mocked(api.login).mockResolvedValue(authResponse({
			user: { ...user, locale: "id" },
		}));

		await authStore.signIn("editor@example.com", "Password!123");
		await flushAsyncWork();

		expect(localStorage.getItem("manga-editor-locale")).toBe("id");
		expect(document.documentElement.getAttribute("lang")).toBe("id");
		expect(api.updateMyProfile).not.toHaveBeenCalled();
	});

	it("syncs explicit locale switches to the signed-in user's profile", async () => {
		vi.mocked(api.login).mockResolvedValue(authResponse());
		vi.mocked(api.updateMyProfile).mockResolvedValue({ ...user, locale: "en" });

		await authStore.signIn("editor@example.com", "Password!123");
		await setLocale("en");
		await flushAsyncWork();

		expect(localStorage.getItem("manga-editor-locale")).toBe("en");
		expect(api.updateMyProfile).toHaveBeenCalledWith({ locale: "en" });
		expect(authStore.user?.locale).toBe("en");
	});

	it("refreshes and retries when locale profile sync hits an expired access token", async () => {
		vi.mocked(api.login).mockResolvedValue(authResponse());
		vi.mocked(api.updateMyProfile)
			.mockRejectedValueOnce(apiError(401))
			.mockResolvedValueOnce({ ...user, locale: "ms" });
		vi.mocked(api.refreshAuthSession).mockResolvedValue(authResponse({
			tokens: {
				accessToken: "access-2",
				refreshToken: "refresh-2",
			},
		}));

		await authStore.signIn("editor@example.com", "Password!123");
		await setLocale("ms");
		await flushAsyncWork();

		expect(api.refreshAuthSession).toHaveBeenCalledWith("refresh-1");
		expect(api.updateMyProfile).toHaveBeenCalledTimes(2);
		expect(authStore.accessToken).toBe("access-2");
		expect(authStore.user?.locale).toBe("ms");
		expect(localStorage.getItem("manga-editor.auth.session.v1")).toContain("refresh-2");
	});

	it("keeps a failed locale sync pending and retries after auth returns", async () => {
		vi.mocked(api.login)
			.mockResolvedValueOnce(authResponse())
			.mockResolvedValueOnce(authResponse({ user: { ...user, locale: "th" } }));
		vi.mocked(api.updateMyProfile)
			.mockRejectedValueOnce(apiError(401))
			.mockResolvedValueOnce({ ...user, locale: "en" });
		vi.mocked(api.refreshAuthSession).mockRejectedValue(apiError(401));

		await authStore.signIn("editor@example.com", "Password!123");
		await setLocale("en");
		await flushAsyncWork();

		expect(authStore.isAuthenticated).toBe(false);
		expect(api.updateMyProfile).toHaveBeenCalledTimes(1);

		await authStore.signIn("editor@example.com", "Password!123");
		await flushAsyncWork();

		expect(api.updateMyProfile).toHaveBeenCalledTimes(2);
		expect(api.updateMyProfile).toHaveBeenLastCalledWith({ locale: "en" });
		expect(authStore.user?.locale).toBe("en");
		expect(localStorage.getItem("manga-editor-locale")).toBe("en");
	});

	it("exposes studio role capability profiles for role-scoped workspace surfaces", () => {
		const translator = rolePermissionProfile("translator");
		const qc = rolePermissionProfile("qc");

		expect(translator.canTranslate).toBe(true);
		expect(translator.canTypeset).toBe(false);
		expect(translator.canReviewQC).toBe(false);
		expect(qc.canReviewQC).toBe(true);
		expect(qc.canGenerateAI).toBe(false);
	});

	it("refreshes a stored session when the access token is stale", async () => {
		localStorage.setItem("manga-editor.auth.session.v1", JSON.stringify(authResponse()));
		// A genuinely-expired access token surfaces as a 401 from /auth/me, which is
		// a real auth rejection → the store refreshes up front (vs. a transient 429,
		// which it now keeps without refreshing — see the dedicated suite below).
		vi.mocked(api.getCurrentUser).mockRejectedValue(apiError(401));
		vi.mocked(api.refreshAuthSession).mockResolvedValue(authResponse({
			tokens: {
				accessToken: "access-2",
				refreshToken: "refresh-2",
			},
		}));

		await authStore.init();

		expect(api.setApiAccessToken).toHaveBeenCalledWith("access-1");
		expect(api.refreshAuthSession).toHaveBeenCalledWith("refresh-1");
		expect(authStore.accessToken).toBe("access-2");
		expect(authStore.status).toBe("authenticated");
		expect(localStorage.getItem("manga-editor.auth.session.v1")).toContain("refresh-2");
	});

	// ── Transient rate-limit / network errors must NOT log the user out ───────
	// P3 fix: rapid navigation can trip the global per-minute limiter, returning
	// 429 on /api/auth/me and /api/auth/refresh. A 429 (or any non-401/403
	// transient failure) says nothing about whether the session is still valid,
	// so it must keep the session — only a real 401/403 logs out.
	describe("a transient (429) session-check failure does not log the user out", () => {
		it("keeps the cached session when /auth/me 429s during rapid navigation", async () => {
			localStorage.setItem("manga-editor.auth.session.v1", JSON.stringify(authResponse()));
			vi.mocked(api.getCurrentUser).mockRejectedValue(apiError(429, "rate_limit_exceeded"));
			// beforeEach's __resetForTesting already called clearApiAccessToken once;
			// reset the counter so the assertion reflects only the init() under test.
			vi.mocked(api.clearApiAccessToken).mockClear();

			await authStore.init();

			// Stayed authenticated on the cached session; no refresh, no logout.
			expect(authStore.isAuthenticated).toBe(true);
			expect(authStore.user?.email).toBe("editor@example.com");
			expect(authStore.accessToken).toBe("access-1");
			expect(api.refreshAuthSession).not.toHaveBeenCalled();
			expect(api.clearApiAccessToken).not.toHaveBeenCalled();
			expect(localStorage.getItem("manga-editor.auth.session.v1")).toContain("refresh-1");
		});

		it("keeps the session when a refresh 429s (rate-limited) instead of clearing it", async () => {
			authStore.__setSessionForTesting(authResponse());
			vi.mocked(api.refreshAuthSession).mockRejectedValue(apiError(429, "rate_limit_exceeded"));
			vi.mocked(api.clearApiAccessToken).mockClear();

			const ok = await authStore.refreshSession();

			// Refresh could not complete, but the session is preserved for retry.
			expect(ok).toBe(false);
			expect(authStore.isAuthenticated).toBe(true);
			expect(authStore.user?.email).toBe("editor@example.com");
			expect(authStore.accessToken).toBe("access-1");
			expect(api.clearApiAccessToken).not.toHaveBeenCalled();
		});

		it("keeps the session when a refresh fails with a network error", async () => {
			authStore.__setSessionForTesting(authResponse());
			vi.mocked(api.refreshAuthSession).mockRejectedValue(new Error("network down"));
			vi.mocked(api.clearApiAccessToken).mockClear();

			const ok = await authStore.refreshSession();

			expect(ok).toBe(false);
			expect(authStore.isAuthenticated).toBe(true);
			expect(api.clearApiAccessToken).not.toHaveBeenCalled();
		});

		it("STILL logs out when /auth/me 401s and the refresh is genuinely rejected (401)", async () => {
			localStorage.setItem("manga-editor.auth.session.v1", JSON.stringify(authResponse()));
			vi.mocked(api.getCurrentUser).mockRejectedValue(apiError(401));
			vi.mocked(api.refreshAuthSession).mockRejectedValue(apiError(401));

			await authStore.init();

			// A real auth rejection still clears the session and surfaces the expiry copy.
			expect(authStore.isAuthenticated).toBe(false);
			expect(authStore.user).toBeNull();
			expect(api.refreshAuthSession).toHaveBeenCalledWith("refresh-1");
			expect(api.clearApiAccessToken).toHaveBeenCalled();
			expect(authStore.errorKey).toBe("auth.errors.sessionExpired");
		});

		it("logs out when a standalone refresh is rejected with 401", async () => {
			authStore.__setSessionForTesting(authResponse());
			vi.mocked(api.refreshAuthSession).mockRejectedValue(apiError(401));

			const ok = await authStore.refreshSession();

			expect(ok).toBe(false);
			expect(authStore.isAuthenticated).toBe(false);
			expect(authStore.user).toBeNull();
			expect(api.clearApiAccessToken).toHaveBeenCalled();
		});
	});

	it("clears local session state even if logout cannot reach the backend", async () => {
		authStore.__setSessionForTesting(authResponse());
		vi.mocked(api.logout).mockRejectedValue(new Error("network"));

		await authStore.signOut();

		expect(authStore.isAuthenticated).toBe(false);
		expect(authStore.user).toBeNull();
		expect(api.clearApiAccessToken).toHaveBeenCalled();
		expect(localStorage.getItem("manga-editor.auth.session.v1")).toBeNull();
	});

	it("exchanges an SSO one-time code for tokens (no tokens ever in the URL fragment)", async () => {
		// Hardened default path: the callback redirect carries only a single-use
		// `sso_code` — never access/refresh tokens.
		window.history.replaceState(null, "", "/#sso_status=success&sso_code=mews_sso_abc123");
		vi.mocked(api.exchangeSsoCode).mockResolvedValue(authResponse());

		await authStore.init();

		expect(api.exchangeSsoCode).toHaveBeenCalledWith("mews_sso_abc123");
		expect(authStore.isAuthenticated).toBe(true);
		expect(authStore.user?.email).toBe("editor@example.com");
		// The code (and any token material) must be stripped from the URL after use.
		expect(window.location.hash).toBe("");
		// getCurrentUser is NOT used on the code path — tokens come from the exchange.
		expect(api.getCurrentUser).not.toHaveBeenCalled();
	});

	it("surfaces an error and stays anonymous when the SSO code exchange fails", async () => {
		window.history.replaceState(null, "", "/#sso_status=success&sso_code=mews_sso_bad");
		vi.mocked(api.exchangeSsoCode).mockRejectedValue(apiError(401, "invalid_code"));

		await authStore.init();

		expect(api.exchangeSsoCode).toHaveBeenCalledWith("mews_sso_bad");
		expect(authStore.isAuthenticated).toBe(false);
		// The single-use code is still stripped so a reload cannot replay it.
		expect(window.location.hash).toBe("");
	});

	it("restores a session-method SSO link intent persisted before re-login", async () => {
		// A `link_method=session` confirmation requires the user to sign in to the
		// existing account first; that OAuth navigation drops the in-memory pending
		// link, so it must survive via sessionStorage.
		sessionStorage.setItem(PENDING_SSO_LINK_KEY, JSON.stringify({
			provider: "line",
			email: "editor@example.com",
			linkIntentToken: "mews_link_persisted",
			method: "session",
			expiresIn: 300,
		}));

		await authStore.init();

		expect(authStore.pendingSsoLink).toEqual(expect.objectContaining({
			provider: "line",
			linkIntentToken: "mews_link_persisted",
			method: "session",
		}));
	});

	it("clears the persisted SSO link intent once confirmed", async () => {
		sessionStorage.setItem(PENDING_SSO_LINK_KEY, JSON.stringify({
			provider: "line",
			email: "editor@example.com",
			linkIntentToken: "mews_link_confirm",
			method: "session",
			expiresIn: 300,
		}));
		await authStore.init();
		vi.mocked(api.confirmSsoLink).mockResolvedValue({ status: "linked", ...authResponse() });

		const ok = await authStore.confirmPendingSsoLink();

		expect(ok).toBe(true);
		expect(authStore.pendingSsoLink).toBeNull();
		expect(sessionStorage.getItem(PENDING_SSO_LINK_KEY)).toBeNull();
	});

	it("keeps login failures in product copy instead of raw backend text", async () => {
		vi.mocked(api.login).mockRejectedValue(new Error("Invalid credentials"));

		await expect(authStore.signIn("editor@example.com", "wrong")).rejects.toThrow("Invalid credentials");

		expect(authStore.status).toBe("error");
		expect(authStore.errorKey).toBe("auth.errors.loginFailed");
	});

	// ── Session-generation guard: a refresh that resolves AFTER the active
	// session identity changed (logout or account-switch) must be discarded so
	// it cannot resurrect a stale user's tokens. This is the Codex P1 closure.
	describe("in-flight refresh vs session identity change", () => {
		it("does NOT resurrect the session when a refresh resolves after logout", async () => {
			authStore.__setSessionForTesting(authResponse());

			// Gate the refresh network call so logout can happen mid-flight.
			let releaseRefresh!: (value: AuthResponse) => void;
			vi.mocked(api.refreshAuthSession).mockReturnValue(
				new Promise<AuthResponse>((resolve) => {
					releaseRefresh = resolve;
				}),
			);

			// Start the refresh (do not await yet) — it is now in flight.
			const refreshing = authStore.refreshSession();
			expect(api.refreshAuthSession).toHaveBeenCalledWith("refresh-1");

			// User logs out while the refresh is still pending.
			await authStore.signOut();
			expect(authStore.isAuthenticated).toBe(false);

			vi.mocked(api.setApiAccessToken).mockClear();

			// The in-flight refresh finally resolves with the OLD user's rotated tokens.
			releaseRefresh(authResponse({ tokens: { accessToken: "resurrected", refreshToken: "resurrected-r" } }));
			const ok = await refreshing;

			// The result was discarded: no session, no token write-back.
			expect(ok).toBe(false);
			expect(authStore.isAuthenticated).toBe(false);
			expect(authStore.user).toBeNull();
			expect(authStore.accessToken).toBeNull();
			expect(api.setApiAccessToken).not.toHaveBeenCalledWith("resurrected");
		});

		it("keeps user B intact when A's refresh resolves after switching accounts", async () => {
			// User A is signed in and a refresh is in flight for A.
			authStore.__setSessionForTesting(authResponse());
			let releaseRefresh!: (value: AuthResponse) => void;
			vi.mocked(api.refreshAuthSession).mockReturnValue(
				new Promise<AuthResponse>((resolve) => {
					releaseRefresh = resolve;
				}),
			);
			const refreshingA = authStore.refreshSession();
			expect(api.refreshAuthSession).toHaveBeenCalledWith("refresh-1");

			// Account-switch: sign in as user B while A's refresh is pending.
			const userB: AuthUser = { ...user, id: "user-2", email: "qc@example.com" };
			vi.mocked(api.login).mockResolvedValue(
				authResponse({ user: userB, tokens: { accessToken: "access-B", refreshToken: "refresh-B" } }),
			);
			await authStore.signIn("qc@example.com", "Password!123");
			expect(authStore.user?.id).toBe("user-2");
			expect(authStore.accessToken).toBe("access-B");

			vi.mocked(api.setApiAccessToken).mockClear();

			// A's refresh now resolves with A's rotated tokens — must be discarded.
			releaseRefresh(authResponse({ tokens: { accessToken: "access-A2", refreshToken: "refresh-A2" } }));
			const ok = await refreshingA;

			expect(ok).toBe(false);
			// B's session is untouched; A's tokens were never applied.
			expect(authStore.user?.id).toBe("user-2");
			expect(authStore.accessToken).toBe("access-B");
			expect(authStore.refreshToken).toBe("refresh-B");
			expect(api.setApiAccessToken).not.toHaveBeenCalledWith("access-A2");
		});

		it("still applies a refresh on the happy path (no identity change)", async () => {
			authStore.__setSessionForTesting(authResponse());
			vi.mocked(api.refreshAuthSession).mockResolvedValue(
				authResponse({ tokens: { accessToken: "access-2", refreshToken: "refresh-2" } }),
			);

			const ok = await authStore.refreshSession();

			expect(ok).toBe(true);
			expect(authStore.accessToken).toBe("access-2");
			expect(authStore.isAuthenticated).toBe(true);
			expect(api.setApiAccessToken).toHaveBeenCalledWith("access-2");
		});

		it("collapses concurrent refresh callers into a single /auth/refresh", async () => {
			authStore.__setSessionForTesting(authResponse());
			let calls = 0;
			vi.mocked(api.refreshAuthSession).mockImplementation(async () => {
				calls += 1;
				return authResponse({ tokens: { accessToken: "access-2", refreshToken: "refresh-2" } });
			});

			const [a, b, c] = await Promise.all([
				authStore.refreshSession(),
				authStore.refreshSession(),
				authStore.refreshSession(),
			]);

			expect(a).toBe(true);
			expect(b).toBe(true);
			expect(c).toBe(true);
			expect(calls).toBe(1);
		});
	});
});
