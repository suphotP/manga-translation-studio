// Authentication service - JWT token management, user operations, password hashing

import { sign, verify } from "jsonwebtoken";
import { hash, compare } from "bcryptjs";
import { v4 as uuid } from "uuid";
import type { User, JWTPayload, AuthTokens, RegisterRequest, ChangePasswordRequest, UpdateUserRequest, AuthIdentityProvider, ExternalIdentity, ExternalUserRequest, UserRole } from "../types/auth.js";
import { serverConfig } from "../config.js";
import { authSessionStore, createOpaqueSessionToken, hashSessionToken, type AuthSessionRecord } from "./auth-sessions.js";
import { authUserStore, normalizeEmail, type ListUsersOptions, type UserListCursor } from "./auth-users.js";
import { invalidateUnusedTokensForUser } from "./password-reset.js";

export const REFRESH_TOKEN_COOKIE_NAME = "mews_refresh";
export const REFRESH_TOKEN_COOKIE_PATH = "/api/auth";

// ── Password Utilities ───────────────────────────────────────────

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
	return await hash(password, 10);
}

/**
 * Compare a plain text password with a hashed password
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
	return await compare(password, hash);
}

// A constant, well-formed bcrypt hash used only to equalize login response time.
// It hashes a password no real account uses, so the comparison always fails.
const DUMMY_PASSWORD_HASH = "$2b$10$3SdFPB8g1TaZXu8fOJdA7embrQqVq3DSpoSHXVBdB82KMt0kRzx0m";

/**
 * Run a bcrypt comparison against a constant fake hash so the login path spends
 * roughly the same time whether or not the email matches a real account. This
 * prevents the response-time difference from being used as a user-enumeration
 * oracle. Always resolves to false.
 */
export async function dummyPasswordCompare(password: string): Promise<boolean> {
	return await compare(password, DUMMY_PASSWORD_HASH);
}

// Stable, machine-readable codes for each password-strength rule. These are
// returned ALONGSIDE the human English `errors` (which existing consumers still
// read) so the frontend can localize the failure per-rule by the user's active
// locale instead of surfacing the backend's English string. The `minLength`
// carries the configured floor so the client can interpolate it.
export type PasswordRuleCode =
	| "password_min_length"
	| "password_max_length"
	| "password_require_uppercase"
	| "password_require_lowercase"
	| "password_require_number"
	| "password_require_special";

export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordValidationResult {
	valid: boolean;
	errors: string[];
	/** Stable per-rule codes for the failed rules (parallel to `errors`). */
	codes: PasswordRuleCode[];
	/** The configured minimum length, so clients can localize the length rule. */
	minLength: number;
}

/**
 * Validate password strength. Returns both human English `errors` (unchanged
 * for existing callers) and stable `codes` + `minLength` for locale-aware
 * messaging on the client.
 */
export function validatePassword(password: string): PasswordValidationResult {
	const errors: string[] = [];
	const codes: PasswordRuleCode[] = [];
	const { passwordMinLength, passwordRequireUppercase, passwordRequireLowercase, passwordRequireNumbers, passwordRequireSpecialChars } = serverConfig;

	if (password.length < passwordMinLength) {
		errors.push(`Password must be at least ${passwordMinLength} characters long`);
		codes.push("password_min_length");
	}

	if (password.length > PASSWORD_MAX_LENGTH) {
		// Reject oversized passwords before hashing so auth endpoints cannot burn
		// unbounded bcrypt work on abusive inputs.
		errors.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters long`);
		codes.push("password_max_length");
	}

	if (passwordRequireUppercase && !/[A-Z]/.test(password)) {
		errors.push("Password must contain at least one uppercase letter");
		codes.push("password_require_uppercase");
	}

	if (passwordRequireLowercase && !/[a-z]/.test(password)) {
		errors.push("Password must contain at least one lowercase letter");
		codes.push("password_require_lowercase");
	}

	if (passwordRequireNumbers && !/\d/.test(password)) {
		errors.push("Password must contain at least one number");
		codes.push("password_require_number");
	}

	if (passwordRequireSpecialChars && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
		errors.push("Password must contain at least one special character");
		codes.push("password_require_special");
	}

	return { valid: errors.length === 0, errors, codes, minLength: passwordMinLength };
}

// ── JWT Token Utilities ───────────────────────────────────────────

/**
 * Generate both access and refresh tokens for a user
 */
export interface GenerateTokenOptions {
	provider?: AuthIdentityProvider;
	ip?: string;
	userAgent?: string;
}

export async function generateTokens(user: Pick<User, "id" | "email" | "role">, options: GenerateTokenOptions = {}): Promise<AuthTokens> {
	// Mint the refresh session first so its id can be embedded in the access
	// token (`sid`). This lets bearer-only clients identify their current session
	// without ever seeing the httpOnly refresh cookie.
	const sessionId = uuid();
	const refreshToken = await generateRefreshToken(user.id, { ...options, sessionId });
	const accessToken = generateAccessToken(user, serverConfig.jwtAccessTokenExpiry, { sessionId });

	return { accessToken, refreshToken };
}

export function generateAccessToken(
	user: Pick<User, "id" | "email" | "role">,
	expiresInSeconds = serverConfig.jwtAccessTokenExpiry,
	options: { sessionId?: string } = {},
): string {
	const payload: JWTPayload = {
		userId: user.id,
		email: user.email,
		role: user.role,
		// Millisecond-precision mint time so a same-second session invalidation
		// (password reset/change, disable, email rebind) can reject this token even
		// when its floored `iat` second equals the watermark's second.
		iatMs: Date.now(),
		...(options.sessionId ? { sid: options.sessionId } : {}),
	};

	return sign(payload, serverConfig.jwtSecret, {
		expiresIn: `${expiresInSeconds}s`,
	});
}

export async function generateRefreshToken(userId: string, options: GenerateTokenOptions & { sessionId?: string } = {}): Promise<string> {
	const refreshToken = createOpaqueSessionToken();
	const now = Date.now();
	await authSessionStore.create({
		sessionId: options.sessionId ?? uuid(),
		userId,
		tokenHash: hashSessionToken(refreshToken),
		createdAt: now,
		expiresAt: now + serverConfig.jwtRefreshTokenExpiry * 1000,
		metadata: {
			provider: options.provider ?? "local",
			ip: options.ip,
			ua: options.userAgent,
			lastActiveAt: now,
		},
	});
	return refreshToken;
}

/**
 * Verify and decode an access token
 */
export function verifyAccessToken(token: string): JWTPayload | null {
	try {
		return verify(token, serverConfig.jwtSecret) as JWTPayload;
	} catch {
		return null;
	}
}

/**
 * Verify a refresh token and return the user ID
 */
export async function verifyRefreshToken(token: string): Promise<string | null> {
	const session = await authSessionStore.findByTokenHash(hashSessionToken(token));
	return session?.userId ?? null;
}

export async function findRefreshSession(token: string): Promise<AuthSessionRecord | null> {
	return authSessionStore.findByTokenHash(hashSessionToken(token));
}

/**
 * Atomically consume a refresh token for rotation. Returns the consumed session
 * record exactly once across concurrent callers presenting the SAME token; every
 * other concurrent caller gets null and must reject. Replaces the previous
 * non-atomic find→revoke→mint sequence so two parallel refreshes cannot both mint
 * a successor from one refresh token.
 */
export async function consumeRefreshSessionForRotation(token: string): Promise<AuthSessionRecord | null> {
	return authSessionStore.consumeForRotation(hashSessionToken(token));
}

/**
 * Whether the refresh session a given access token was minted alongside (its
 * `sid`) is still active. Access tokens carry `sid` since the session-id work;
 * authMiddleware uses this so revoking a session (DELETE /sessions/:id, logout,
 * password reset) immediately invalidates that session's access token instead of
 * letting it live until its own short expiry.
 */
export async function isSessionActive(userId: string, sessionId: string): Promise<boolean> {
	const session = await authSessionStore.findBySessionId(userId, sessionId);
	return session !== null;
}

/**
 * Invalidate a refresh token
 */
export async function revokeRefreshToken(token: string): Promise<void> {
	await authSessionStore.revokeTokenHash(hashSessionToken(token));
}

/**
 * Invalidate all refresh tokens for a user
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
	await authSessionStore.revokeUserSessions(userId);
}

/**
 * Revoke every active session AND invalidate all previously-issued access JWTs
 * for a user by bumping their `tokensValidFromMs` watermark. Revoking refresh
 * sessions alone leaves short-lived access tokens valid until expiry, which is
 * unacceptable for account-recovery / compromise flows. After this runs,
 * `authMiddleware` rejects any access token whose `iat` predates the watermark.
 */
export async function invalidateAllUserAuth(userId: string): Promise<void> {
	await revokeAllUserTokens(userId);
	const user = await loadUser(userId);
	if (!user) return;
	// Use the current wall-clock as the watermark (NOT the next second). JWT `iat`
	// has 1s resolution and is floored, so `isAccessTokenStale` compares at second
	// granularity: tokens minted in any earlier second are rejected, while a token
	// the user re-issues by logging in again in this same second is accepted.
	// Future-dating the watermark would (incorrectly) 401 those fresh re-login
	// tokens until the next second ticked over.
	user.tokensValidFromMs = Date.now();
	user.updatedAt = new Date().toISOString();
	await authUserStore.save(user);
}

// ── User Management ───────────────────────────────────────────────

function omitPassword(user: User): Omit<User, "passwordHash"> {
	const { passwordHash, ...userWithoutPassword } = user;
	return userWithoutPassword;
}

/**
 * Load a user from storage
 */
export async function loadUser(userId: string): Promise<User | null> {
	return authUserStore.load(userId);
}

/**
 * Find a user by email
 */
export async function findUserByEmail(email: string): Promise<User | null> {
	return authUserStore.findByEmail(email);
}

export async function findUserByExternalIdentity(provider: AuthIdentityProvider, subject: string): Promise<User | null> {
	return authUserStore.findByExternalIdentity(provider, subject);
}

/**
 * Create a new user
 */
/**
 * Thrown by createUser when the (normalized) email already belongs to an account. The
 * register route maps this to HTTP 409 Conflict + `code: "email_taken"`, so clients branch
 * on the status/code — never a brittle English-message match.
 */
/** New/changed password failed the strength rules. Carries the stable per-rule `codes` so
 *  the route can return `code: "weak_password"` + `reason: codes` and the frontend can
 *  localize the SPECIFIC failed rules — instead of the catch-all leaking the raw English. */
export class WeakPasswordError extends Error {
	readonly code = "weak_password";
	constructor(message: string, readonly codes: PasswordRuleCode[], readonly minLength: number) {
		super(message);
		this.name = "WeakPasswordError";
	}
}

/** The supplied current password didn't match. Typed so the change-password route maps it to
 *  401 `current_password_incorrect` WITHOUT string-matching the message. */
export class InvalidCurrentPasswordError extends Error {
	readonly code = "current_password_incorrect";
	constructor(message = "Current password is incorrect") {
		super(message);
		this.name = "InvalidCurrentPasswordError";
	}
}

export class EmailAlreadyExistsError extends Error {
	readonly code = "email_taken";
	constructor(message = "User with this email already exists") {
		super(message);
		this.name = "EmailAlreadyExistsError";
	}
}

export async function createUser(data: RegisterRequest): Promise<{ user: Omit<User, "passwordHash">; passwordHash: string }> {
	// Check if user already exists
	const email = normalizeEmail(data.email);
	const existingUser = await findUserByEmail(email);
	if (existingUser) {
		throw new EmailAlreadyExistsError();
	}

	// Validate password
	const passwordValidation = validatePassword(data.password);
	if (!passwordValidation.valid) {
		throw new WeakPasswordError(passwordValidation.errors.join("; "), passwordValidation.codes, passwordValidation.minLength);
	}

	// Hash password
	const passwordHash = await hashPassword(data.password);

	// Create user object
	const userId = uuid();
	const now = new Date().toISOString();
	const user: User = {
		id: userId,
		email,
		passwordHash,
		name: data.name,
		role: data.role || "editor",
		authProvider: "local",
		emailVerified: false,
		createdAt: now,
		updatedAt: now,
		isActive: true,
	};

	// Save user. The findUserByEmail pre-check above is racy: two concurrent registrations
	// for the same normalized email can both pass it, and the loser hits the
	// email_normalized UNIQUE constraint here. Map that to the SAME typed error so a
	// double-submit / concurrent retry still gets the 409 + email_taken contract, not a
	// generic 500/400.
	try {
		await authUserStore.create(user);
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new EmailAlreadyExistsError();
		}
		throw error;
	}

	// Return user without password hash
	return { user: omitPassword(user), passwordHash };
}

/** Postgres unique-constraint violation (SQLSTATE 23505), by code or message. */
function isUniqueViolation(error: unknown): boolean {
	if ((error as { code?: unknown } | null)?.code === "23505") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /duplicate key value|unique constraint/i.test(message);
}

export async function createExternalUser(data: ExternalUserRequest): Promise<{ user: Omit<User, "passwordHash">; passwordHash: string }> {
	const email = normalizeEmail(data.email);
	const existingUser = await findUserByEmail(email);
	if (existingUser) {
		throw new Error("User with this email already exists");
	}

	const userId = uuid();
	const now = new Date().toISOString();
	const passwordHash = await hashPassword(`oauth:${data.provider}:${data.subject}:${uuid()}:${uuid()}`);
	const identity: ExternalIdentity = {
		provider: data.provider,
		subject: data.subject,
		emailVerified: data.emailVerified ?? true,
	};
	const user: User = {
		id: userId,
		email,
		passwordHash,
		name: data.name,
		role: data.role || "editor",
		authProvider: data.provider,
		externalSubject: data.subject,
		externalIdentities: [identity],
		emailVerified: data.emailVerified ?? true,
		createdAt: now,
		updatedAt: now,
		isActive: true,
	};

	await authUserStore.create(user);
	await authUserStore.linkExternalIdentity(userId, identity);
	return { user: omitPassword(user), passwordHash };
}

/**
 * Update user information
 */
export async function updateUser(userId: string, updates: UpdateUserRequest): Promise<Omit<User, "passwordHash"> | null> {
	const user = await loadUser(userId);
	if (!user) return null;

	const nextUpdates: UpdateUserRequest = { ...updates };
	if (updates.email !== undefined) {
		nextUpdates.email = normalizeEmail(updates.email);
	}

	const emailChanged = nextUpdates.email !== undefined && nextUpdates.email !== user.email;
	if (emailChanged) {
		// Check if new email is already taken
		const existingUser = await findUserByEmail(nextUpdates.email!);
		if (existingUser && existingUser.id !== userId) {
			throw new Error("Email already in use");
		}
	}

	const updatedUser = await authUserStore.update(userId, nextUpdates);
	if (updatedUser && emailChanged) {
		// The address changed, so any outstanding verification link was issued for the
		// OLD mailbox. Verification tokens are redeemed by userId only, so a stale link
		// could otherwise mark the new, unconfirmed address verified without proving
		// control of it. Burn every unused email_verify token for this user. (applyUserUpdates
		// already cleared emailVerified and bumped the session-invalidation watermark.)
		await invalidateUnusedTokensForUser("email_verify", userId);
		// Bumping the watermark only invalidates already-issued ACCESS tokens. A client
		// holding a pre-change REFRESH token could otherwise mint brand-new access/refresh
		// tokens (with a fresh iat past the watermark) and retain access to the account
		// after the email rebind. Revoke every active refresh session as well.
		await revokeAllUserTokens(userId);
	}
	return updatedUser ? omitPassword(updatedUser) : null;
}

/**
 * Owner-safe update. Identical to {@link updateUser} but routes the write through
 * the store's ATOMIC owner-protected mutation: if `updates` would demote or
 * disable an active platform owner, the store re-verifies (inside the same
 * transaction / critical section as the write) that another active owner remains,
 * throwing {@link LastPlatformOwnerError} otherwise. This closes the TOCTOU window
 * the route-level last-owner pre-check cannot: under concurrent demote/disable
 * requests the platform never drops to zero active owners.
 */
export async function updateUserProtectingLastOwner(
	userId: string,
	updates: UpdateUserRequest,
): Promise<Omit<User, "passwordHash"> | null> {
	const user = await loadUser(userId);
	if (!user) return null;

	const nextUpdates: UpdateUserRequest = { ...updates };
	if (updates.email !== undefined) {
		nextUpdates.email = normalizeEmail(updates.email);
	}

	const emailChanged = nextUpdates.email !== undefined && nextUpdates.email !== user.email;
	if (emailChanged) {
		const existingUser = await findUserByEmail(nextUpdates.email!);
		if (existingUser && existingUser.id !== userId) {
			throw new Error("Email already in use");
		}
	}

	const updatedUser = await authUserStore.updateProtectingLastOwner(userId, nextUpdates);
	if (updatedUser && emailChanged) {
		// Same email-rebind hygiene as updateUser: burn outstanding verification
		// tokens and revoke refresh sessions so a stale verified/auth claim cannot
		// carry over to the new address.
		await invalidateUnusedTokensForUser("email_verify", userId);
		await revokeAllUserTokens(userId);
	}
	return updatedUser ? omitPassword(updatedUser) : null;
}

/**
 * Owner-safe delete. Identical to {@link deleteUser} but routes the delete through
 * the store's ATOMIC owner-protected mutation so a concurrent delete cannot orphan
 * the platform of its last active owner. Throws {@link LastPlatformOwnerError} when
 * the target is the last active owner.
 */
export async function deleteUserProtectingLastOwner(userId: string): Promise<boolean> {
	const deleted = await authUserStore.deleteProtectingLastOwner(userId);
	if (deleted) {
		await revokeAllUserTokens(userId);
	}
	return deleted;
}

export async function linkExternalIdentity(userId: string, identity: ExternalIdentity): Promise<Omit<User, "passwordHash"> | null> {
	const user = await loadUser(userId);
	if (!user) return null;

	const existingIdentityUser = await findUserByExternalIdentity(identity.provider, identity.subject);
	if (existingIdentityUser && existingIdentityUser.id !== userId) {
		throw new Error("External identity already linked to another user");
	}

	const linkedUser = await authUserStore.linkExternalIdentity(userId, identity);
	return linkedUser ? omitPassword(linkedUser) : null;
}

/**
 * Change user password
 */
export async function changePassword(userId: string, data: ChangePasswordRequest): Promise<boolean> {
	const user = await loadUser(userId);
	if (!user) return false;

	// Verify old password
	const isValid = await comparePassword(data.oldPassword, user.passwordHash);
	if (!isValid) {
		throw new InvalidCurrentPasswordError();
	}

	// Validate new password
	const passwordValidation = validatePassword(data.newPassword);
	if (!passwordValidation.valid) {
		throw new WeakPasswordError(passwordValidation.errors.join("; "), passwordValidation.codes, passwordValidation.minLength);
	}

	// Hash and save new password
	user.passwordHash = await hashPassword(data.newPassword);
	user.updatedAt = new Date().toISOString();

	await authUserStore.save(user);

	// Revoke all existing sessions AND invalidate previously-issued access tokens.
	await invalidateAllUserAuth(userId);

	return true;
}

export async function resetPasswordForUser(userId: string, newPassword: string): Promise<boolean> {
	const user = await loadUser(userId);
	if (!user) return false;

	const passwordValidation = validatePassword(newPassword);
	if (!passwordValidation.valid) {
		throw new Error(passwordValidation.errors.join("; "));
	}

	// Use the shared bcrypt cost (hashPassword) so the stored reset hash matches
	// the cost of registration and of the login-padding dummy hash; a higher cost
	// here would both diverge from that padding and add a needless latency signal.
	user.passwordHash = await hashPassword(newPassword);
	user.updatedAt = new Date().toISOString();
	await authUserStore.save(user);
	// Revoke all sessions AND invalidate previously-issued access tokens so a
	// session compromised before recovery cannot keep using a live access JWT.
	await invalidateAllUserAuth(userId);
	// Invalidate every other outstanding password-reset token for this user so an
	// older valid reset link (e.g. from a duplicate "forgot password" request) can
	// no longer be redeemed to overwrite the freshly recovered password.
	await invalidateUnusedTokensForUser("password_reset", userId);
	return true;
}

export async function markEmailVerified(userId: string): Promise<Omit<User, "passwordHash"> | null> {
	const user = await loadUser(userId);
	if (!user) return null;
	user.emailVerified = true;
	user.updatedAt = new Date().toISOString();
	await authUserStore.save(user);
	return omitPassword(user);
}

/**
 * Delete a user
 */
export async function deleteUser(userId: string): Promise<boolean> {
	try {
		const deleted = await authUserStore.delete(userId);
		if (deleted) {
			await revokeAllUserTokens(userId);
		}
		return deleted;
	} catch {
		return false;
	}
}

/**
 * List all users (admin only).
 *
 * NOTE: unbounded — kept for backward compatibility only. Prefer
 * `listUsersPaginated` for any caller that can grow with the user table.
 */
export async function listUsers(): Promise<Omit<User, "passwordHash">[]> {
	const users = await authUserStore.list();
	return users.map(omitPassword);
}

export interface PaginatedUsersResult {
	users: Omit<User, "passwordHash">[];
	nextCursor: UserListCursor | null;
}

/**
 * Keyset-paginated, bounded user listing for admin surfaces. The search filter
 * and ordering are applied in the store (SQL in postgres mode), so this never
 * pulls the whole table into memory.
 */
export async function listUsersPaginated(options: ListUsersOptions = {}): Promise<PaginatedUsersResult> {
	const page = await authUserStore.listPaginated(options);
	return { users: page.users.map(omitPassword), nextCursor: page.nextCursor };
}

/**
 * Honest grand total of users matching the optional search filter. Used by the
 * admin user list so the header can show "N of M" instead of a page count.
 * One bounded `COUNT(*)` in postgres mode.
 */
export async function countUsers(options: ListUsersOptions = {}): Promise<number> {
	return authUserStore.count(options);
}

/**
 * Count active users holding a specific platform role. Backs the last-owner
 * guard so role changes / disable / delete can verify the platform keeps at
 * least one active owner.
 */
export async function countActiveUsersByRole(role: UserRole): Promise<number> {
	return authUserStore.countActiveByRole(role);
}

/**
 * Update last login timestamp
 */
export async function updateLastLogin(userId: string): Promise<void> {
	const now = new Date().toISOString();
	await authUserStore.updateLastLogin(userId, now);
}
