// Authentication types for JWT and RBAC

export interface User {
	id: string;
	email: string;
	passwordHash: string;
	name: string;
	role: UserRole;
	authProvider: AuthIdentityProvider;
	externalSubject?: string;
	externalIdentities?: ExternalIdentity[];
	emailVerified?: boolean;
	verificationEmailSendFailed?: boolean;
	locale?: UserLocale;
	createdAt: string;
	updatedAt: string;
	lastLogin?: string;
	isActive: boolean;
	// Epoch ms before which any previously-issued access JWT is no longer trusted.
	// Bumped whenever every session is revoked (password reset/change, disable,
	// admin email change) so already-minted access tokens are rejected immediately
	// instead of lingering until their normal expiry.
	tokensValidFromMs?: number;
}

// Platform roles. This is a DIFFERENT namespace from WorkspaceRole
// (workspace-access.ts) — platform roles gate /api/admin (the back-office)
// while workspace roles scope collaboration inside a single workspace.
//
//   owner       — full back-office incl. minting other platform roles
//   admin       — full back-office EXCEPT assigning platform roles
//   support      — customer 360 + goodwill credits / plan changes (no money out)
//   accountant   — read-only money: revenue reports + export + audit
//   editor/viewer — ordinary app roles, NO back-office access
export type UserRole = "owner" | "admin" | "support" | "accountant" | "editor" | "viewer";
export type AuthIdentityProvider = "local" | "auth0" | "oidc" | "saml" | "google" | "github" | "line";
export type UserLocale = "th" | "en" | "id" | "ms";

export interface JWTPayload {
	userId: string;
	email: string;
	role: UserRole;
	/**
	 * Refresh-session id this access token was minted alongside. Lets bearer-only
	 * clients (which never echo the httpOnly refresh cookie) identify their own
	 * row in the session list without exposing the refresh token.
	 */
	sid?: string;
	/**
	 * Mint time in epoch MILLISECONDS. Standard JWT `iat` is seconds and floored,
	 * which leaves a sub-second survival window on session-invalidation events: a
	 * token minted earlier in the same wall-clock second as a password reset would
	 * pass a second-granularity `iat < floor(watermark/1000)` check. `iatMs` lets
	 * isAccessTokenStale compare against `tokensValidFromMs` at full ms precision so
	 * a reset invalidates EVERY strictly-earlier access token. Optional for backward
	 * compatibility with tokens minted before this claim existed.
	 */
	iatMs?: number;
	iat?: number;
	exp?: number;
	/**
	 * CONTEXT-ONLY (never a signed claim): the user's live email-verification status,
	 * stamped onto the request-context user by authMiddleware/optionalAuth from the row
	 * they already loaded. generateAccessToken builds claims explicitly (id/email/role/sid),
	 * so this is not minted into the token — it just lets the verify-wall gate read the
	 * status without a second DB lookup, and always reflects the live row (not a stale claim).
	 */
	emailVerified?: boolean;
}

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}

export interface LoginRequest {
	email: string;
	password: string;
}

export interface RegisterRequest {
	email: string;
	password: string;
	name: string;
	role?: UserRole;
}

export interface ExternalUserRequest {
	email: string;
	name: string;
	role?: UserRole;
	provider: Exclude<AuthIdentityProvider, "local">;
	subject: string;
	emailVerified?: boolean;
}

export interface AuthResponse {
	user: Omit<User, "passwordHash">;
	tokens: AuthTokens;
}

export interface RefreshTokenRequest {
	refreshToken: string;
}

export interface ChangePasswordRequest {
	oldPassword: string;
	newPassword: string;
}

export interface UpdateUserRequest {
	name?: string;
	email?: string;
	role?: UserRole;
	isActive?: boolean;
	verificationEmailSendFailed?: boolean;
	locale?: UserLocale;
}

export interface ExternalIdentity {
	provider: Exclude<AuthIdentityProvider, "local">;
	subject: string;
	emailVerified?: boolean;
}

// ── Back-office (platform admin) permission keys ──────────────────
//
// Every /api/admin/* route gates on one of these. The map below is the SINGLE
// authoritative source: middleware (requirePermission), GET /api/admin/me, and
// the frontend admin nav all derive from it so there is no backend/frontend
// drift. Keep the namespacing (`admin:*`) so app permissions and back-office
// permissions never collide.
export const ADMIN_PERMISSIONS = {
	ACCESS: "admin:access",
	REVENUE_READ: "admin:revenue.read",
	REVENUE_EXPORT: "admin:revenue.export",
	COUPONS_READ: "admin:coupons.read",
	COUPONS_WRITE: "admin:coupons.write",
	CONTENT_READ: "admin:content.read",
	CONTENT_MODERATE: "admin:content.moderate",
	USERS_READ: "admin:users.read",
	USERS_WRITE: "admin:users.write",
	SUPPORT_READ: "admin:support.read",
	SUPPORT_ADJUST: "admin:support.adjust",
	REFUND_WRITE: "admin:refund.write",
	IMPERSONATE: "admin:impersonate",
	AUDIT_READ: "admin:audit.read",
	CRON_WRITE: "admin:cron.write",
	ROLES_WRITE: "admin:roles.write",
} as const;

const A = ADMIN_PERMISSIONS;

// Full back-office permission set EXCEPT minting platform roles. owner adds
// admin:roles.write on top of this; admin gets exactly this list.
const ADMIN_FULL_EXCEPT_ROLES: string[] = [
	A.ACCESS,
	A.REVENUE_READ,
	A.REVENUE_EXPORT,
	A.COUPONS_READ,
	A.COUPONS_WRITE,
	A.CONTENT_READ,
	A.CONTENT_MODERATE,
	A.USERS_READ,
	A.USERS_WRITE,
	A.SUPPORT_READ,
	A.SUPPORT_ADJUST,
	A.REFUND_WRITE,
	A.IMPERSONATE,
	A.AUDIT_READ,
	A.CRON_WRITE,
];

const APP_FULL_PERMISSIONS: string[] = [
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
];

// Role-based permissions
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
	// owner: everything — the only role that can assign platform roles
	// (admin:roles.write) and transfer ownership. App permissions match admin.
	owner: [
		...APP_FULL_PERMISSIONS,
		...ADMIN_FULL_EXCEPT_ROLES,
		A.ROLES_WRITE,
	],
	// admin: full back-office EXCEPT admin:roles.write (only owner mints roles).
	admin: [
		...APP_FULL_PERMISSIONS,
		...ADMIN_FULL_EXCEPT_ROLES,
	],
	// support: customer 360 lookups + goodwill credits / plan changes / resend
	// verify / password reset, view content & audit. NO money out (refund),
	// NO impersonation, NO role changes, NO force-delete, NO coupon writes.
	support: [
		"read:project",
		A.ACCESS,
		A.SUPPORT_READ,
		A.SUPPORT_ADJUST,
		A.USERS_READ,
		A.CONTENT_READ,
		A.AUDIT_READ,
	],
	// accountant: READ-ONLY money — revenue reports + CSV export + audit. No
	// refunds, no coupon writes, no user writes, no impersonation.
	accountant: [
		"read:project",
		A.ACCESS,
		A.REVENUE_READ,
		A.REVENUE_EXPORT,
		A.AUDIT_READ,
	],
	// editor/viewer: ordinary app roles. NO admin:* keys.
	editor: [
		"create:project",
		"read:project",
		"update:project",
		"generate:ai",
		"export:project",
		"import:project",
	],
	// Viewer = view-only (no export) — keep aligned with the workspace viewer
	// role and the frontend VIEWER_PERMISSIONS, or the personal-project branch of
	// checkProjectOwnership re-opens the export gates this map is meant to close.
	viewer: [
		"read:project",
	],
};

// Platform super-admin hierarchy: `owner` is a strict superset of `admin` (it can
// do everything admin can, plus mint platform roles / transfer ownership). Several
// routes historically did a literal `role === "admin"` / `role !== "admin"` compare,
// which wrongly excluded owner from admin-gated actions (force-release a lock, sweep,
// degraded-mode credit reads). Use this canonical helper instead of a literal string
// compare so owner is admitted wherever admin is. Mirrors requireRole("owner","admin").
export function isPlatformAdmin(role: UserRole): boolean {
	return role === "owner" || role === "admin";
}

export function hasPermission(role: UserRole, permission: string): boolean {
	// Tolerant lookup: an unknown / future role returns [] (no throw) so a stray
	// auth_users.role value can never crash a request — it simply has no
	// permissions. The map above is the authoritative grant.
	return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export function canAccessProject(userRole: UserRole, action: "create" | "read" | "update" | "delete"): boolean {
	const permission = `${action}:project` as const;
	return hasPermission(userRole, permission);
}
