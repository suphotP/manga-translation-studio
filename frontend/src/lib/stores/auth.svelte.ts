import * as api from "$lib/api/client.ts";
import { ApiError } from "$lib/api/client.ts";
import type { AuthResponse, AuthTokens, AuthUser, AuthUserRole, WorkspaceStudioRole } from "$lib/api/client.ts";
import { normalizeLocale, setLocale, setLocaleSyncHandler, type SupportedLocale } from "$lib/i18n";

type AuthStatus = "checking" | "anonymous" | "authenticated" | "error";

// A session-check / refresh failure is only a reason to LOG OUT when it proves
// the credentials are no longer valid — i.e. the backend actively rejected the
// token (401 Unauthorized / 403 Forbidden). A 429 (rate-limited by the global
// per-minute bucket during fast navigation), a 5xx, or a network/timeout error
// is TRANSIENT: it says nothing about whether the session is still valid, so we
// must keep the session and retry later rather than silently bouncing the user
// to /login. This is the frontend half of the "rapid nav must not log you out"
// fix — only `isFatalAuthError` clears the session.
function isFatalAuthError(error: unknown): boolean {
	if (error instanceof ApiError) {
		return error.status === 401 || error.status === 403;
	}
	// A non-ApiError (network failure, timeout, aborted fetch) never reached the
	// backend's auth check, so it cannot prove the session is invalid → transient.
	return false;
}

const AUTH_STORAGE_KEY = "manga-editor.auth.session.v1";
// Pending SSO link intents live in sessionStorage so a `link_method=session`
// confirmation survives the required sign-in round-trip (starting the existing
// account's OAuth navigates away and would otherwise drop the in-memory token).
const PENDING_SSO_LINK_KEY = "manga-editor.auth.pending-sso-link.v1";

export type AuthErrorKey =
	| "auth.errors.loginFailed"
	| "auth.errors.registerFailed"
	| "auth.errors.registerRateLimited"
	| "auth.errors.emailTaken"
	| "auth.errors.forgotFailed"
	| "auth.errors.resetFailed"
	| "auth.errors.verifyFailed"
	| "auth.errors.otpFailed"
	| "auth.errors.resendRequiresLogin"
	| "auth.errors.resendFailed"
	| "auth.errors.sessionExpired"
	| "auth.errors.ssoFailed"
	| "auth.errors.ssoLinkFailed";

function authFailureKey(kind: "login" | "register"): AuthErrorKey {
	return kind === "login"
		? "auth.errors.loginFailed"
		: "auth.errors.registerFailed";
}

/**
 * Map the common register failures to a CLEAR key instead of the catch-all register failure,
 * branching on the HTTP status / machine-readable `code` (NOT a brittle English-message
 * match): 409 / `email_taken` = email already used, 429 / `rate_limited` = per-IP sign-up
 * cap. Anything else falls back to the generic localized key.
 */
function registerErrorKey(error: unknown): AuthErrorKey {
	if (error instanceof ApiError) {
		if (error.status === 429 || error.code === "rate_limited") {
			return "auth.errors.registerRateLimited";
		}
		if (error.status === 409 || error.code === "email_taken") {
			return "auth.errors.emailTaken";
		}
	}
	return authFailureKey("register");
}

export type RolePermissionKey = AuthUserRole | WorkspaceStudioRole;

export interface RoleCapabilityFlags {
	canTranslate: boolean;
	canClean: boolean;
	canTypeset: boolean;
	canReviewQC: boolean;
	canManageMembers: boolean;
	canManageBilling: boolean;
	canExport: boolean;
	canImport: boolean;
	canGenerateAI: boolean;
	canManageProjects: boolean;
}

export interface RolePermissionProfile extends RoleCapabilityFlags {
	permissions: string[];
}

const FULL_STUDIO_CAPABILITIES: RoleCapabilityFlags = {
	canTranslate: true,
	canClean: true,
	canTypeset: true,
	canReviewQC: true,
	canManageMembers: true,
	canManageBilling: true,
	canExport: true,
	canImport: true,
	canGenerateAI: true,
	canManageProjects: true,
};

const EDITOR_PERMISSIONS = [
	"create:project",
	"read:project",
	"update:project",
	"generate:ai",
	"export:project",
	"import:project",
];

// Viewer = view-only, no export (product decision): viewers ride along free
// without consuming a seat, so granting them export would turn every workspace
// into unlimited free export accounts. Mirrors the backend ROLE_PERMISSIONS.
const VIEWER_PERMISSIONS = [
	"read:project",
];

export const ROLE_PERMISSIONS: Record<RolePermissionKey, RolePermissionProfile> = {
	owner: {
		...FULL_STUDIO_CAPABILITIES,
		permissions: [
			"create:project",
			"read:project",
			"update:project",
			"delete:project",
			"create:user",
			"read:user",
			"update:user",
			"delete:user",
			"manage:settings",
			"generate:ai",
			"export:project",
			"import:project",
		],
	},
	admin: {
		...FULL_STUDIO_CAPABILITIES,
		permissions: [
		"create:project",
		"read:project",
		"update:project",
		"delete:project",
		"create:user",
		"read:user",
		"update:user",
		"delete:user",
		"manage:settings",
		"generate:ai",
		"export:project",
		"import:project",
	],
	},
	team_lead: {
		...FULL_STUDIO_CAPABILITIES,
		canManageBilling: false,
		permissions: EDITOR_PERMISSIONS,
	},
	translator: {
		canTranslate: true,
		canClean: false,
		canTypeset: false,
		canReviewQC: false,
		canManageMembers: false,
		canManageBilling: false,
		canExport: false,
		canImport: true,
		canGenerateAI: true,
		canManageProjects: false,
		permissions: ["read:project", "update:project", "generate:ai", "import:project"],
	},
	cleaner: {
		canTranslate: false,
		canClean: true,
		canTypeset: false,
		canReviewQC: false,
		canManageMembers: false,
		canManageBilling: false,
		canExport: false,
		canImport: true,
		canGenerateAI: true,
		canManageProjects: false,
		permissions: ["read:project", "update:project", "generate:ai", "import:project"],
	},
	typesetter: {
		canTranslate: false,
		canClean: false,
		canTypeset: true,
		canReviewQC: false,
		canManageMembers: false,
		canManageBilling: false,
		canExport: true,
		canImport: true,
		canGenerateAI: true,
		canManageProjects: false,
		permissions: EDITOR_PERMISSIONS,
	},
	qc: {
		canTranslate: false,
		canClean: false,
		canTypeset: false,
		canReviewQC: true,
		canManageMembers: false,
		canManageBilling: false,
		canExport: true,
		canImport: false,
		canGenerateAI: false,
		canManageProjects: false,
		permissions: ["read:project", "update:project", "export:project"],
	},
	guest: {
		canTranslate: false,
		canClean: false,
		canTypeset: false,
		canReviewQC: false,
		canManageMembers: false,
		canManageBilling: false,
		canExport: false,
		canImport: false,
		canGenerateAI: false,
		canManageProjects: false,
		permissions: ["read:project"],
	},
	// Platform back-office roles (support/accountant) carry no in-app studio
	// capabilities — they exist to gate /admin. Their real authorization is
	// computed server-side and delivered via GET /api/admin/me; these app-side
	// entries only keep the RolePermissionKey Record total and grant read:project
	// so the ordinary app does not treat them as anonymous.
	support: {
		canTranslate: false,
		canClean: false,
		canTypeset: false,
		canReviewQC: false,
		canManageMembers: false,
		canManageBilling: false,
		canExport: false,
		canImport: false,
		canGenerateAI: false,
		canManageProjects: false,
		permissions: ["read:project"],
	},
	accountant: {
		canTranslate: false,
		canClean: false,
		canTypeset: false,
		canReviewQC: false,
		canManageMembers: false,
		canManageBilling: false,
		canExport: false,
		canImport: false,
		canGenerateAI: false,
		canManageProjects: false,
		permissions: ["read:project"],
	},
	editor: {
		canTranslate: true,
		canClean: true,
		canTypeset: true,
		canReviewQC: true,
		canManageMembers: false,
		canManageBilling: false,
		canExport: true,
		canImport: true,
		canGenerateAI: true,
		canManageProjects: true,
		permissions: EDITOR_PERMISSIONS,
	},
	viewer: {
		canTranslate: false,
		canClean: false,
		canTypeset: false,
		canReviewQC: false,
		canManageMembers: false,
		canManageBilling: false,
		canExport: false,
		canImport: false,
		canGenerateAI: false,
		canManageProjects: false,
		permissions: VIEWER_PERMISSIONS,
	},
};

// Anonymous (signed-out) sessions are permissionless: no role means no access at
// all, not even the read-only `guest` member profile. Falling back to `guest`
// here would grant `read:project` to unauthenticated callers, which would make
// authStore.can("read:project") return true before login.
const ANONYMOUS_PROFILE: RolePermissionProfile = {
	canTranslate: false,
	canClean: false,
	canTypeset: false,
	canReviewQC: false,
	canManageMembers: false,
	canManageBilling: false,
	canExport: false,
	canImport: false,
	canGenerateAI: false,
	canManageProjects: false,
	permissions: [],
};

export function rolePermissionProfile(role: RolePermissionKey | null | undefined): RolePermissionProfile {
	if (!role) return ANONYMOUS_PROFILE;
	return ROLE_PERMISSIONS[role] ?? ANONYMOUS_PROFILE;
}

export interface StoredAuthSession {
	user: AuthUser;
	tokens: AuthTokens;
}

export interface PendingSsoLink {
	provider: string;
	email: string;
	linkIntentToken: string;
	// "password": existing account is local; the user must confirm with their
	// password. "session": existing account is SSO-only; the user must already be
	// signed in to that account to confirm.
	method: "password" | "session";
	expiresIn: number;
}

class AuthStore {
	status = $state<AuthStatus>("anonymous");
	user = $state<AuthUser | null>(null);
	accessToken = $state<string | null>(null);
	refreshToken = $state<string | null>(null);
	errorKey = $state<AuthErrorKey | null>(null);
	pendingSsoLink = $state<PendingSsoLink | null>(null);
	ssoLinkErrorKey = $state<AuthErrorKey | null>(null);

	private initPromise: Promise<void> | null = null;
	private initialized = false;
	// Single-flight guard for refreshSession: concurrent callers (e.g. several
	// API requests that all 401 at once when the access token expires) share one
	// in-flight refresh so we hit /auth/refresh exactly once, not once per call.
	private refreshPromise: Promise<boolean> | null = null;
	// Monotonic session-identity generation. Bumped every time the active
	// user/token identity changes (setSession / clearSession → sign-in, register,
	// SSO link, restore, logout, account-switch). runRefresh() captures this
	// before its network round-trip and discards the result if the generation
	// advanced mid-flight, so a refresh that resolves AFTER a logout or
	// account-switch can never resurrect the previous session's tokens.
	private sessionGeneration = 0;
	private pendingLocaleSync: SupportedLocale | null = null;
	private localeSyncPromise: Promise<void> | null = null;

	// Hooks run (and awaited) BEFORE the session is cleared on an explicit
	// sign-out, so a workspace that has a debounced/instant edit buffered in
	// memory can flush+persist it before the editor is torn down and the route
	// changes away. Without this an instant heal/clone stroke made <800ms before
	// sign-out is discarded by the editor's destroy() (#255 teardown data-loss).
	private preSignOutHooks = new Set<() => void | Promise<void>>();

	/**
	 * Register a callback to run (and await) right before an explicit sign-out
	 * clears the session. The editor store uses this to flush a pending instant
	 * edit before WorkspaceShell unmounts and tears the editor down. Returns an
	 * unregister function.
	 */
	registerPreSignOut(hook: () => void | Promise<void>): () => void {
		this.preSignOutHooks.add(hook);
		return () => {
			this.preSignOutHooks.delete(hook);
		};
	}

	private async runPreSignOutHooks(): Promise<void> {
		// Run each hook defensively — a flush failure must never block sign-out
		// (local session cleanup is more important than a best-effort persist).
		for (const hook of [...this.preSignOutHooks]) {
			try {
				await hook();
			} catch (error) {
				console.error("[auth] pre-sign-out hook failed:", error);
			}
		}
	}

	get isAuthenticated(): boolean {
		return this.status === "authenticated" && Boolean(this.user && this.accessToken);
	}

	get role(): AuthUserRole | null {
		return this.user?.role ?? null;
	}

	get permissionSet(): Set<string> {
		return new Set(rolePermissionProfile(this.role).permissions);
	}

	get capabilities(): RoleCapabilityFlags {
		const { permissions: _permissions, ...capabilities } = rolePermissionProfile(this.role);
		return capabilities;
	}

	get permissionPreview(): Array<{ id: string; label: string; allowed: boolean }> {
		return [
			{ id: "create:project", label: "สร้างงาน", allowed: this.can("create:project") },
			{ id: "update:project", label: "แก้เวิร์กสเปซ", allowed: this.can("update:project") },
			{ id: "generate:ai", label: "รัน AI", allowed: this.can("generate:ai") },
			{ id: "export:project", label: "Export", allowed: this.can("export:project") },
			{ id: "manage:settings", label: "ตั้งค่าระบบ", allowed: this.can("manage:settings") },
		];
	}

	can(permission: string): boolean {
		return this.permissionSet.has(permission);
	}

	/**
	 * `fetchImpl` lets a SvelteKit `load` thread its event `fetch` through to the
	 * `/auth/me` restore call so it is tracked by the framework instead of
	 * emitting the "Loading … using window.fetch" warning. Component callers
	 * (onMount) omit it and fall back to the global `fetch`.
	 */
	async init(fetchImpl?: typeof fetch): Promise<void> {
		if (this.isAuthenticated) {
			this.initialized = true;
			return;
		}
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.loadStoredSession(fetchImpl);
		await this.initPromise;
	}

	async signIn(email: string, password: string, turnstileToken?: string): Promise<void> {
		this.status = "checking";
		this.errorKey = null;
		try {
			this.setSession(await api.login(email, password, turnstileToken));
		} catch (error) {
			this.clearSession();
			this.status = "error";
			this.errorKey = authFailureKey("login");
			throw error;
		}
	}

	async register(input: { email: string; password: string; name: string }, turnstileToken?: string): Promise<void> {
		this.status = "checking";
		this.errorKey = null;
		try {
			this.setSession(await api.registerUser(input, turnstileToken));
		} catch (error) {
			this.status = "error";
			this.errorKey = registerErrorKey(error);
			throw error;
		}
	}

	async refreshSession(): Promise<boolean> {
		// Single-flight: if a refresh is already running, every caller awaits the
		// same promise instead of firing a second /auth/refresh (which would also
		// race rotating refresh tokens).
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.runRefresh();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	private async runRefresh(): Promise<boolean> {
		if (!this.refreshToken) {
			this.clearSession();
			return false;
		}

		// Snapshot the session identity BEFORE the network round-trip. If a logout
		// or account-switch happens while /auth/refresh is in flight, the
		// generation advances and we must NOT apply the result — otherwise an old
		// session's refreshed tokens would be written back (and an in-flight
		// apiFetch retry would resurrect the old user). We also pin the exact
		// refresh token used so a concurrently-rotated token is not clobbered.
		const gen = this.sessionGeneration;
		const refreshToken = this.refreshToken;

		try {
			const response = await api.refreshAuthSession(refreshToken);
			// Identity changed mid-flight (logout / sign-in as another user) → discard
			// silently: do not setSession, do not write tokens back, do not retry.
			if (this.sessionGeneration !== gen || this.refreshToken !== refreshToken) {
				return false;
			}
			this.setSession(response);
			return true;
		} catch (error) {
			// Same guard on the failure path: only touch the session if it is still
			// the one we started refreshing. A logout/switch already moved on.
			if (this.sessionGeneration !== gen || this.refreshToken !== refreshToken) {
				return false;
			}
			// Only a real auth rejection (401/403 → invalid/expired refresh token)
			// logs the user out. A transient failure — most importantly a 429 from
			// the global per-minute rate limiter during fast navigation, but also a
			// 5xx or a network/timeout error — must NOT clear the session: the token
			// may still be perfectly valid. Keep the session and report "could not
			// refresh now" so the caller can retry instead of bouncing to /login.
			if (isFatalAuthError(error)) {
				this.clearSession();
			}
			return false;
		}
	}

	async signOut(): Promise<void> {
		// Flush any buffered editor edit BEFORE we clear the session / route away,
		// so an instant heal/clone stroke made just before sign-out is persisted
		// rather than discarded by the editor teardown (#255).
		await this.runPreSignOutHooks();
		const token = this.refreshToken;
		try {
			if (token && this.accessToken) {
				await api.logout(token);
			}
		} catch {
			// Local session cleanup is more important than preserving a failed logout call.
		} finally {
			this.clearSession();
		}
	}

	/**
	 * Confirm a pending SSO account-link consent. For a local existing account
	 * the user supplies their password; for an SSO-only existing account they
	 * must already be signed in (the httpOnly access cookie / bearer token is
	 * sent by the API client) and no password is needed.
	 */
	async confirmPendingSsoLink(currentPassword?: string): Promise<boolean> {
		const pending = this.pendingSsoLink;
		if (!pending) return false;
		this.ssoLinkErrorKey = null;
		try {
			const result = await api.confirmSsoLink({
				linkIntentToken: pending.linkIntentToken,
				currentPassword: pending.method === "password" ? currentPassword : undefined,
			});
			this.setSession({ user: result.user, tokens: result.tokens });
			this.clearPendingSsoLink();
			return true;
		} catch {
			this.ssoLinkErrorKey = "auth.errors.ssoLinkFailed";
			return false;
		}
	}

	dismissPendingSsoLink(): void {
		this.clearPendingSsoLink();
		this.ssoLinkErrorKey = null;
	}

	/** Convenience aliases used by the W1.4 auth shell pages. */
	async login(email: string, password: string, turnstileToken?: string): Promise<void> {
		await this.signIn(email, password, turnstileToken);
	}

	async signup(input: { email: string; password: string; name?: string; turnstileToken?: string }): Promise<void> {
		await this.register({
			email: input.email,
			password: input.password,
			name: input.name?.trim() || input.email.split("@")[0] || "Editor",
		}, input.turnstileToken);
	}

	async logout(): Promise<void> {
		await this.signOut();
	}

	/** Request a password-reset email. Errors are surfaced for inline display. */
	async forgotPassword(email: string): Promise<void> {
		this.errorKey = null;
		try {
			await api.forgotPassword(email);
		} catch (error) {
			this.errorKey = "auth.errors.forgotFailed";
			throw error;
		}
	}

	/** Submit a new password using a reset token from email. */
	async resetPassword(token: string, newPassword: string): Promise<void> {
		this.errorKey = null;
		try {
			await api.resetPassword(token, newPassword);
		} catch (error) {
			this.errorKey = "auth.errors.resetFailed";
			throw error;
		}
	}

	/** Confirm email ownership via the verification token. */
	async verifyEmail(token: string): Promise<void> {
		this.errorKey = null;
		try {
			const result = await api.verifyEmail(token);
			if (result.user && this.user && result.user.id === this.user.id) {
				// Backend returns a partial user ({ id, email, emailVerified });
				// merge it into the full session user rather than replacing it.
				this.user = { ...this.user, ...result.user };
				this.persistSession();
			} else if (this.user) {
				// Optimistic flag update for already-signed-in users.
				this.user = { ...this.user, emailVerified: true };
				this.persistSession();
			}
		} catch (error) {
			this.errorKey = "auth.errors.verifyFailed";
			throw error;
		}
	}

	/** Confirm email ownership by redeeming the 6-digit OTP for the signed-in user. */
	async verifyOtp(code: string): Promise<void> {
		this.errorKey = null;
		try {
			const result = await api.verifyOtp(code);
			if (result.user && this.user && result.user.id === this.user.id) {
				this.user = { ...this.user, ...result.user };
			} else if (this.user) {
				this.user = { ...this.user, emailVerified: true };
			}
			this.persistSession();
		} catch (error) {
			this.errorKey = "auth.errors.otpFailed";
			throw error;
		}
	}

	/** Resend the verification email to the signed-in user. */
	async resendVerification(turnstileToken?: string): Promise<void> {
		this.errorKey = null;
		if (!this.accessToken) {
			this.errorKey = "auth.errors.resendRequiresLogin";
			throw new Error("Not authenticated");
		}
		try {
			await api.resendVerification(turnstileToken);
		} catch (error) {
			this.errorKey = "auth.errors.resendFailed";
			throw error;
		}
	}

	/**
	 * Self-service: change the signed-in user's own display name. On success the
	 * in-memory + persisted session user is updated so the greeting and account
	 * menu reflect the new name immediately (and survive a reload).
	 */
	async updateDisplayName(name: string): Promise<AuthUser> {
		const trimmed = name.trim();
		if (!trimmed) {
			throw new Error("Name required");
		}
		const updated = await api.updateMyProfile({ name: trimmed });
		if (this.user && updated.id === this.user.id) {
			this.user = { ...this.user, ...updated, locale: updated.locale ?? this.user.locale };
			this.persistSession();
		}
		return updated;
	}

	/**
	 * Best-effort server preference sync for the GLOBAL UI locale. The local
	 * device choice is already persisted by setLocale(); this method makes the
	 * same language follow a signed-in user across sessions/devices. It keeps a
	 * pending value when auth is unavailable so the next authenticated session can
	 * retry instead of silently dropping the preference.
	 */
	async updateLocalePreference(locale: SupportedLocale): Promise<AuthUser | null> {
		this.pendingLocaleSync = normalizeLocale(locale);
		await this.runPendingLocaleSync();
		return this.user;
	}

	/**
	 * Change the signed-in user's password. Requires the current password. The
	 * backend revokes other sessions on success; the local session keeps its
	 * current tokens working until they expire, so we leave it intact.
	 */
	async changePassword(oldPassword: string, newPassword: string): Promise<void> {
		await api.changeMyPassword({ oldPassword, newPassword });
	}

	/** Surfaces whether the signed-in user still needs to verify their email. */
	get requiresEmailVerification(): boolean {
		return Boolean(this.isAuthenticated && this.user && this.user.emailVerified === false);
	}

	/** Mirrors `user` under the name the W1.4 surfaces consume. */
	get currentUser(): AuthUser | null {
		return this.user;
	}

	__resetForTesting(): void {
		this.clearSession();
		this.clearPendingSsoLink();
		this.ssoLinkErrorKey = null;
		this.initPromise = null;
		this.initialized = false;
		this.pendingLocaleSync = null;
		this.localeSyncPromise = null;
		setLocaleSyncHandler(async (nextLocale) => {
			await this.updateLocalePreference(nextLocale);
		});
	}

	__setSessionForTesting(session: StoredAuthSession): void {
		this.setSession(session, false);
	}

	private async loadStoredSession(fetchImpl?: typeof fetch): Promise<void> {
		this.initialized = true;
		// Prefer a fresh `?sso_status=link-needed` redirect; otherwise restore a
		// pending intent that was persisted before a `link_method=session` sign-in
		// navigated the user away from the app.
		this.pendingSsoLink = this.consumeSsoLinkRedirect() ?? this.readPersistedSsoLink();
		// Hardened SSO path: the callback redirects with a single-use `sso_code`
		// (no tokens in the URL). Exchange it for tokens via POST. This is the
		// default backend behaviour; the legacy fragment-token path below is only
		// hit when an operator explicitly opts back into SSO_ONE_TIME_CODE=false.
		const ssoCodeSession = await this.consumeSsoRedirectCode();
		if (ssoCodeSession) {
			this.setSession(ssoCodeSession);
			return;
		}
		const ssoSession = this.consumeSsoRedirectSession();
		if (ssoSession) {
			this.setSession(ssoSession);
			return;
		}
		const stored = this.readStoredSession();
		if (!stored) {
			this.clearSession();
			return;
		}

		this.status = "checking";
		this.user = stored.user;
		this.accessToken = stored.tokens.accessToken;
		this.refreshToken = stored.tokens.refreshToken;
		api.setApiAccessToken(stored.tokens.accessToken);
		this.applyUserLocalePreference(stored.user);

		try {
			this.user = await api.getCurrentUser(fetchImpl);
			this.applyUserLocalePreference(this.user);
			this.status = "authenticated";
			this.errorKey = null;
			this.persistSession();
			this.schedulePendingLocaleSync();
		} catch (error) {
			// A transient `/auth/me` failure (429 from the global per-minute limiter
			// during rapid navigation, a 5xx, or a network/timeout) must NOT trigger
			// a refresh-then-logout cascade. The cached session was valid when it was
			// persisted, so keep it authenticated and let the API client's
			// transparent refresh-on-401 handle a genuinely-expired token on the next
			// real request. Only a hard auth rejection (401/403) means the access
			// token is actually stale and we should refresh up front.
			if (!isFatalAuthError(error)) {
				this.user = stored.user;
				this.status = "authenticated";
				this.errorKey = null;
				this.schedulePendingLocaleSync();
				return;
			}
			const refreshed = await this.refreshSession();
			if (!refreshed) {
				this.errorKey = "auth.errors.sessionExpired";
			} else {
				this.schedulePendingLocaleSync();
			}
		}
	}

	private setSession(response: AuthResponse, persist = true): void {
		// Session identity is changing → invalidate any in-flight refresh keyed to
		// the previous generation (sign-in, register, SSO link, restore, refresh).
		this.sessionGeneration += 1;
		this.initialized = true;
		this.user = response.user;
		this.accessToken = response.tokens.accessToken;
		this.refreshToken = response.tokens.refreshToken;
		this.status = "authenticated";
		this.errorKey = null;
		api.setApiAccessToken(response.tokens.accessToken);
		this.applyUserLocalePreference(response.user);
		if (persist) this.persistSession();
		this.schedulePendingLocaleSync();
	}

	private applyUserLocalePreference(user: AuthUser | null): void {
		if (!user?.locale || this.pendingLocaleSync) return;
		void setLocale(user.locale, { syncUser: false });
	}

	private schedulePendingLocaleSync(): void {
		if (!this.pendingLocaleSync || this.localeSyncPromise || !this.isAuthenticated) return;
		void this.runPendingLocaleSync();
	}

	private async runPendingLocaleSync(): Promise<void> {
		if (this.localeSyncPromise) return this.localeSyncPromise;
		this.localeSyncPromise = this.flushPendingLocaleSync();
		try {
			await this.localeSyncPromise;
		} finally {
			this.localeSyncPromise = null;
		}
	}

	private async flushPendingLocaleSync(): Promise<void> {
		while (this.pendingLocaleSync && this.isAuthenticated && this.user) {
			const nextLocale = this.pendingLocaleSync;
			if (this.user.locale === nextLocale) {
				this.pendingLocaleSync = null;
				this.persistSession();
				continue;
			}

			const updated = await this.patchLocalePreferenceWithRefresh(nextLocale);
			if (!updated || !this.user || updated.id !== this.user.id) return;

			this.user = { ...this.user, ...updated };
			this.persistSession();
			if (this.user.locale === nextLocale) {
				this.pendingLocaleSync = null;
			}
		}
	}

	private async patchLocalePreferenceWithRefresh(locale: SupportedLocale): Promise<AuthUser | null> {
		try {
			return await api.updateMyProfile({ locale });
		} catch (error) {
			if (!isFatalAuthError(error)) return null;
		}

		const refreshed = await this.refreshSession();
		if (!refreshed || !this.isAuthenticated) return null;

		try {
			return await api.updateMyProfile({ locale });
		} catch {
			return null;
		}
	}

	private clearSession(): void {
		// Session identity is changing (logout / expiry) → invalidate any in-flight
		// refresh keyed to the previous generation so it cannot resurrect tokens.
		this.sessionGeneration += 1;
		this.status = "anonymous";
		this.user = null;
		this.accessToken = null;
		this.refreshToken = null;
		this.errorKey = null;
		api.clearApiAccessToken();
		this.storage()?.removeItem(AUTH_STORAGE_KEY);
	}

	private persistSession(): void {
		if (!this.user || !this.accessToken || !this.refreshToken) return;
		this.storage()?.setItem(AUTH_STORAGE_KEY, JSON.stringify({
			user: this.user,
			tokens: {
				accessToken: this.accessToken,
				refreshToken: this.refreshToken,
			},
		} satisfies StoredAuthSession));
	}

	private readStoredSession(): StoredAuthSession | null {
		const raw = this.storage()?.getItem(AUTH_STORAGE_KEY);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as StoredAuthSession;
			if (!parsed.user?.id || !parsed.tokens?.accessToken || !parsed.tokens?.refreshToken) return null;
			return parsed;
		} catch {
			this.storage()?.removeItem(AUTH_STORAGE_KEY);
			return null;
		}
	}

	/**
	 * Hardened SSO callback: the backend redirect carries a single-use, short-lived
	 * `sso_code` in the fragment instead of the tokens themselves. We strip it from
	 * the URL immediately (so a reload / browser tooling cannot replay it) and POST
	 * it to `/auth/sso/exchange`, which returns the real tokens in the JSON body.
	 * Tokens are therefore NEVER present in `location.hash`.
	 */
	private async consumeSsoRedirectCode(): Promise<StoredAuthSession | null> {
		if (typeof window === "undefined" || !window.location.hash) return null;
		const params = new URLSearchParams(window.location.hash.slice(1));
		if (params.get("sso_status") !== "success") return null;
		const code = params.get("sso_code");
		if (!code) return null;
		// Strip the code from the URL before the network call so it cannot be
		// replayed on reload regardless of how the exchange resolves.
		this.clearSsoRedirectFragment();
		try {
			const response = await api.exchangeSsoCode(code);
			if (!response?.user?.id || !response.tokens?.accessToken || !response.tokens?.refreshToken) {
				return null;
			}
			return { user: response.user, tokens: response.tokens };
		} catch {
			this.errorKey = "auth.errors.ssoFailed";
			return null;
		}
	}

	private consumeSsoRedirectSession(): StoredAuthSession | null {
		if (typeof window === "undefined" || !window.location.hash) return null;
		const params = new URLSearchParams(window.location.hash.slice(1));
		if (params.get("sso_status") !== "success") return null;

		const accessToken = params.get("access_token");
		const refreshToken = params.get("refresh_token");
		const rawUser = params.get("user");
		this.clearSsoRedirectFragment();
		if (!accessToken || !refreshToken || !rawUser) return null;

		try {
			const user = JSON.parse(rawUser) as AuthUser;
			if (!user?.id || !user.email || !user.role) return null;
			return {
				user,
				tokens: { accessToken, refreshToken },
			};
		} catch {
			return null;
		}
	}

	private clearSsoRedirectFragment(): void {
		if (typeof window === "undefined" || !window.history?.replaceState) return;
		const nextUrl = `${window.location.pathname}${window.location.search}`;
		window.history.replaceState(window.history.state, document.title, nextUrl || "/");
	}

	/**
	 * Detect the `?sso_status=link-needed&...` redirect the backend issues when
	 * an OAuth email matches an existing account that needs explicit consent
	 * before linking. Returns the pending link and strips the params from the URL
	 * so a reload does not re-trigger the prompt.
	 */
	private consumeSsoLinkRedirect(): PendingSsoLink | null {
		if (typeof window === "undefined" || !window.location.search) return null;
		const params = new URLSearchParams(window.location.search);
		if (params.get("sso_status") !== "link-needed") return null;

		const provider = params.get("sso_provider") ?? "";
		const email = params.get("sso_email") ?? "";
		const linkIntentToken = params.get("link_intent_token") ?? "";
		const method = params.get("link_method") === "session" ? "session" : "password";
		const expiresIn = Number.parseInt(params.get("expires_in") ?? "", 10);
		this.clearSsoLinkRedirectQuery(params);
		if (!provider || !email || !linkIntentToken) return null;
		const pending: PendingSsoLink = {
			provider,
			email,
			linkIntentToken,
			method,
			expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300,
		};
		// Persist so a session-method confirmation survives the sign-in navigation.
		this.persistPendingSsoLink(pending);
		return pending;
	}

	private persistPendingSsoLink(pending: PendingSsoLink): void {
		try {
			this.sessionStore()?.setItem(PENDING_SSO_LINK_KEY, JSON.stringify(pending));
		} catch {
			// Persistence is best-effort; the in-memory copy still drives the prompt.
		}
	}

	private readPersistedSsoLink(): PendingSsoLink | null {
		const raw = this.sessionStore()?.getItem(PENDING_SSO_LINK_KEY);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as PendingSsoLink;
			if (!parsed?.provider || !parsed.email || !parsed.linkIntentToken) {
				this.sessionStore()?.removeItem(PENDING_SSO_LINK_KEY);
				return null;
			}
			return {
				provider: parsed.provider,
				email: parsed.email,
				linkIntentToken: parsed.linkIntentToken,
				method: parsed.method === "session" ? "session" : "password",
				expiresIn: typeof parsed.expiresIn === "number" && parsed.expiresIn > 0 ? parsed.expiresIn : 300,
			};
		} catch {
			this.sessionStore()?.removeItem(PENDING_SSO_LINK_KEY);
			return null;
		}
	}

	private clearPendingSsoLink(): void {
		this.pendingSsoLink = null;
		try {
			this.sessionStore()?.removeItem(PENDING_SSO_LINK_KEY);
		} catch {
			// ignore storage errors
		}
	}

	private sessionStore(): Storage | null {
		return typeof window === "undefined" ? null : window.sessionStorage;
	}

	private clearSsoLinkRedirectQuery(params: URLSearchParams): void {
		if (typeof window === "undefined" || !window.history?.replaceState) return;
		for (const key of ["sso_status", "sso_provider", "sso_email", "link_intent_token", "link_method", "expires_in"]) {
			params.delete(key);
		}
		const query = params.toString();
		const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
		window.history.replaceState(window.history.state, document.title, nextUrl || "/");
	}

	private storage(): Storage | null {
		return typeof window === "undefined" ? null : window.localStorage;
	}
}

export const authStore = new AuthStore();

setLocaleSyncHandler(async (nextLocale) => {
	await authStore.updateLocalePreference(nextLocale);
});

// Wire transparent refresh-on-401 into the API client. When any API request
// 401s (access token expired), the client runs this handler ONCE (its own
// single-flight de-dupes concurrent 401s) and retries the request with the new
// token. We return the fresh access token on success, or null when the refresh
// token is invalid/expired — in which case refreshSession() has already cleared
// the local session, so the client surfaces the original 401 without looping.
api.setAuthRefreshHandler(async () => {
	const ok = await authStore.refreshSession();
	return ok ? authStore.accessToken : null;
});
