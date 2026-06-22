import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { USERS_DIR, serverConfig } from "../config.js";
import type { AuthIdentityProvider, ExternalIdentity, UpdateUserRequest, User, UserLocale, UserRole } from "../types/auth.js";
import { ROLE_PERMISSIONS, isPlatformAdmin } from "../types/auth.js";
import { readJsonFile } from "../utils/json-file.js";

/** Keyset cursor for the paginated user list: (lower(name), user_id). */
export interface UserListCursor {
	/** lower(name) of the last user on the previous page. */
	name: string;
	/** user_id of the last user on the previous page (PK tiebreaker). */
	userId: string;
}

export interface ListUsersOptions {
	/** Keyset cursor from a previous page's `nextCursor`. */
	cursor?: UserListCursor | null;
	/** Page size. Clamped to [1, USER_LIST_MAX_LIMIT]; defaults to USER_LIST_DEFAULT_LIMIT. */
	limit?: number;
	/** Case-insensitive substring match against name OR email. */
	search?: string | null;
	/** Exact platform role filter. */
	role?: UserRole | null;
	/** Active-state filter. */
	status?: "active" | "disabled" | null;
}

export interface UserListPage {
	users: User[];
	/** Cursor to fetch the next page, or null when this is the last page. */
	nextCursor: UserListCursor | null;
}

/**
 * Thrown by the store-layer owner-protected mutations when applying the mutation
 * would leave the platform with ZERO active owners. This is the ATOMIC, race-free
 * counterpart to the {@link assertLastOwnerMutationAllowed} pre-check: the store
 * re-evaluates "another active owner exists" inside the same critical section /
 * transaction that performs the write, so under concurrent
 * demote/disable/delete requests at most one can succeed and at least one active
 * owner always survives. Routes translate this into the same 403 last-owner
 * response the pre-check produces.
 */
export class LastPlatformOwnerError extends Error {
	constructor(message = "Cannot remove the last platform owner") {
		super(message);
		this.name = "LastPlatformOwnerError";
	}
}

/**
 * Postgres transaction-scoped advisory-lock key serializing all owner-set
 * mutations. A single constant key means every demote/disable/delete that
 * targets an active owner is serialized platform-wide, so the count+mutate
 * cannot interleave across connections. Released automatically at COMMIT/ROLLBACK
 * (pg_advisory_xact_lock). Value is an arbitrary fixed bigint identifying the
 * "auth_users owner set" lock domain.
 */
const OWNER_MUTATION_ADVISORY_LOCK_KEY = 7723019283; // "owners" lock domain

/** Default page size for the admin user list. */
export const USER_LIST_DEFAULT_LIMIT = 50;
/** Hard cap on page size to keep the query bounded regardless of caller input. */
export const USER_LIST_MAX_LIMIT = 200;
const USER_LOCALES = new Set<UserLocale>(["th", "en", "id", "ms"]);

function resolveListLimit(limit?: number): number {
	if (limit === undefined || limit === null || !Number.isFinite(limit)) {
		return USER_LIST_DEFAULT_LIMIT;
	}
	const rounded = Math.floor(limit);
	if (rounded < 1) return 1;
	if (rounded > USER_LIST_MAX_LIMIT) return USER_LIST_MAX_LIMIT;
	return rounded;
}

function normalizeStoredLocale(value: unknown): UserLocale | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return USER_LOCALES.has(normalized as UserLocale) ? normalized as UserLocale : undefined;
}

export interface AuthUserStore {
	/**
	 * Which backend physically holds the user rows. Lets cross-store consumers
	 * pick a safe strategy — notably {@link WorkspaceAccessStore.listMentionCandidates},
	 * whose Postgres JOIN to `auth_users` is only valid when the active auth store
	 * is `"postgres"`. In the supported mixed config (DATABASE_URL set but
	 * AUTH_USER_STORE=file — the docker-compose default) the workspace store is
	 * Postgres while users live ONLY in the file store, so the JOIN would find no
	 * rows; the consumer falls back to the per-user loader instead.
	 */
	readonly kind: "file" | "postgres";
	create(user: User): Promise<User>;
	save(user: User): Promise<User>;
	load(userId: string): Promise<User | null>;
	findByEmail(email: string): Promise<User | null>;
	findByExternalIdentity(provider: AuthIdentityProvider, subject: string): Promise<User | null>;
	update(userId: string, updates: UpdateUserRequest): Promise<User | null>;
	/**
	 * ATOMIC owner-protected update. Applies `updates` to the user, but if the
	 * mutation would demote or disable an active OWNER it is performed inside the
	 * same critical section / transaction that verifies at least one OTHER active
	 * owner remains. Under concurrent demote/disable requests at most one succeeds;
	 * the loser throws {@link LastPlatformOwnerError}. For non-owner targets, or
	 * updates that neither demote nor disable an owner, this behaves like
	 * {@link update}. Returns null if the user does not exist.
	 */
	updateProtectingLastOwner(userId: string, updates: UpdateUserRequest): Promise<User | null>;
	linkExternalIdentity(userId: string, identity: ExternalIdentity): Promise<User | null>;
	delete(userId: string): Promise<boolean>;
	/**
	 * ATOMIC owner-protected delete. Deletes the user, but if the target is an
	 * active OWNER the delete only commits when another active owner still exists,
	 * re-checked inside the same critical section / transaction as the delete.
	 * Concurrent deletes of the final owners cannot both win: the loser throws
	 * {@link LastPlatformOwnerError}. Returns false if the user did not exist.
	 */
	deleteProtectingLastOwner(userId: string): Promise<boolean>;
	/**
	 * Full, unbounded listing. Used internally by the file store's email /
	 * external-identity scans. NOT for the admin API — that path must use the
	 * bounded, keyset-paginated `listPaginated` to avoid full-table scans.
	 */
	list(): Promise<User[]>;
	/**
	 * Keyset-paginated listing ordered by (lower(name), user_id) with the search
	 * filter applied. Bounded page size; returns a `nextCursor` for the next page.
	 */
	listPaginated(options?: ListUsersOptions): Promise<UserListPage>;
	/**
	 * Honest count of all users matching the (optional) search filter. One
	 * bounded `COUNT(*)` in postgres mode so the admin UI can show a real
	 * "N of M" total instead of a misleading page count.
	 */
	count(options?: ListUsersOptions): Promise<number>;
	/**
	 * Count active users holding a specific platform role. Backs the last-owner
	 * guard (admin-protection) so a role change / disable / delete can verify the
	 * platform retains at least one active owner. One bounded `COUNT(*)` in
	 * postgres mode.
	 */
	countActiveByRole(role: UserRole): Promise<number>;
	updateLastLogin(userId: string, lastLoginIso: string): Promise<void>;
}

export interface AuthUserSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: AuthUserSqlClient) => Promise<T>): Promise<T>;
}

export interface AuthUserRow {
	user_id: string;
	email: string;
	password_hash: string;
	name: string;
	role: string;
	auth_provider: string;
	external_subject?: string | null;
	email_verified: boolean | string | number;
	verification_email_send_failed?: boolean | string | number | null;
	tokens_valid_from_ms?: number | string | null;
	locale?: string | null;
	is_active: boolean | string | number;
	last_login_at?: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

export interface AuthExternalIdentityRow {
	user_id: string;
	provider: string;
	provider_user_id: string;
	email_verified?: boolean | string | number | null;
	created_at?: Date | string;
	updated_at?: Date | string;
}

mkdirSync(USERS_DIR, { recursive: true });

export class FileAuthUserStore implements AuthUserStore {
	readonly kind = "file" as const;

	/**
	 * Serializes owner-protected mutations. Bun is single-threaded but cooperatively
	 * async: two concurrent requests can each `await load(...)` before either writes,
	 * which is exactly the TOCTOU window the last-owner guard must close. Chaining the
	 * critical section through this promise makes count+mutate run to completion for
	 * one request before the next begins, so the second observes the first's write and
	 * fails closed.
	 */
	private ownerMutationLock: Promise<unknown> = Promise.resolve();
	private userMutationLocks = new Map<string, Promise<unknown>>();

	constructor(private readonly usersDir = USERS_DIR) {
		mkdirSync(this.usersDir, { recursive: true });
	}

	/** Run `fn` after any in-flight owner mutation completes (serial critical section). */
	private withOwnerMutationLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.ownerMutationLock.then(fn, fn);
		// Keep the chain alive regardless of fn's outcome, but don't swallow errors
		// for the caller (run still rejects).
		this.ownerMutationLock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private withUserMutationLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.userMutationLocks.get(userId) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		const marker = run.then(
			() => undefined,
			() => undefined,
		);
		this.userMutationLocks.set(userId, marker);
		void marker.finally(() => {
			if (this.userMutationLocks.get(userId) === marker) {
				this.userMutationLocks.delete(userId);
			}
		});
		return run;
	}

	async create(user: User): Promise<User> {
		return this.save(user);
	}

	async save(user: User): Promise<User> {
		const normalized = normalizeUser(user);
		this.writeUserFile(normalized.id, normalized);
		return normalized;
	}

	async load(userId: string): Promise<User | null> {
		const filePath = this.userPath(userId);
		if (!existsSync(filePath)) return null;
		try {
			return normalizeUser(readJsonFile<User>(filePath));
		} catch {
			return null;
		}
	}

	async findByEmail(email: string): Promise<User | null> {
		const normalizedEmail = normalizeEmail(email);
		for (const user of await this.list()) {
			if (normalizeEmail(user.email) === normalizedEmail) return user;
		}
		return null;
	}

	async findByExternalIdentity(provider: AuthIdentityProvider, subject: string): Promise<User | null> {
		if (provider === "local" || !subject) return null;
		for (const user of await this.list()) {
			if (user.authProvider === provider && user.externalSubject === subject) return user;
			if (user.externalIdentities?.some((identity) => identity.provider === provider && identity.subject === subject)) return user;
		}
		return null;
	}

	async update(userId: string, updates: UpdateUserRequest): Promise<User | null> {
		return this.withUserMutationLock(userId, async () => {
			const user = await this.load(userId);
			if (!user) return null;
			applyUserUpdates(user, updates);
			this.writeUserFile(userId, user);
			return user;
		});
	}

	async updateProtectingLastOwner(userId: string, updates: UpdateUserRequest): Promise<User | null> {
		return this.withOwnerMutationLock(async () => {
			const user = await this.load(userId);
			if (!user) return null;
			// Re-evaluate INSIDE the critical section: the target's current role and
			// the live owner population may have changed since the route's pre-check.
			if (isOwnerDemotionOrDisable(user, updates) && this.countOtherActiveOwnersSync(userId) === 0) {
				throw new LastPlatformOwnerError(
					updates.isActive === false ? "Cannot disable the last platform owner" : "Cannot demote the last platform owner",
				);
			}
			applyUserUpdates(user, updates);
			this.writeUserFile(userId, user);
			return user;
		});
	}

	async linkExternalIdentity(userId: string, identity: ExternalIdentity): Promise<User | null> {
		const user = await this.load(userId);
		if (!user) return null;
		const owner = await this.findByExternalIdentity(identity.provider, identity.subject);
		if (owner && owner.id !== userId) {
			throw new Error("External identity already linked to another user");
		}
		const identities = user.externalIdentities ?? [];
		const existingIndex = identities.findIndex((candidate) => candidate.provider === identity.provider && candidate.subject === identity.subject);
		if (existingIndex >= 0) {
			identities[existingIndex] = { ...identities[existingIndex], ...identity };
		} else {
			identities.push(identity);
		}
		user.externalIdentities = identities;
		// Keep password-backed (local) accounts primary-provider "local" even after
		// they link an SSO provider: their password stays usable, so the link-method
		// decision and /sso/link/confirm must continue to accept the password.
		// Only an SSO-only account (no usable password, no primary external subject
		// yet) adopts the linked provider as its primary identity.
		if (user.authProvider !== "local" && !user.externalSubject) {
			user.authProvider = identity.provider;
			user.externalSubject = identity.subject;
		}
		if (identity.emailVerified !== undefined) user.emailVerified = identity.emailVerified;
		user.updatedAt = new Date().toISOString();
		this.writeUserFile(userId, user);
		return user;
	}

	async delete(userId: string): Promise<boolean> {
		const filePath = this.userPath(userId);
		if (!existsSync(filePath)) return false;
		unlinkSync(filePath);
		return true;
	}

	async deleteProtectingLastOwner(userId: string): Promise<boolean> {
		return this.withOwnerMutationLock(async () => {
			const filePath = this.userPath(userId);
			if (!existsSync(filePath)) return false;
			const user = await this.load(userId);
			// Only guard when the target is currently an active owner; deleting a
			// non-owner (or an already-inactive owner) can never orphan the platform.
			if (user && user.role === "owner" && user.isActive && this.countOtherActiveOwnersSync(userId) === 0) {
				throw new LastPlatformOwnerError("Cannot delete the last platform owner");
			}
			unlinkSync(filePath);
			return true;
		});
	}

	/**
	 * Count active owners OTHER than `excludeUserId`, read synchronously from disk
	 * inside the owner-mutation critical section so the count reflects every write
	 * committed by a prior holder of the lock.
	 */
	private countOtherActiveOwnersSync(excludeUserId: string): number {
		if (!existsSync(this.usersDir)) return 0;
		try {
			return readdirSync(this.usersDir)
				.filter((file) => file.endsWith(".json"))
				.map((file) => {
					try {
						return normalizeUser(readJsonFile<User>(join(this.usersDir, file)));
					} catch {
						return null;
					}
				})
				.filter((user): user is User => user !== null && user.id !== excludeUserId && user.role === "owner" && user.isActive).length;
		} catch {
			return 0;
		}
	}

	async list(): Promise<User[]> {
		if (!existsSync(this.usersDir)) return [];
		try {
			return readdirSync(this.usersDir)
				.filter((file) => file.endsWith(".json"))
				.map((file) => normalizeUser(readJsonFile<User>(join(this.usersDir, file))))
				.sort(compareUsersByNameKeyset);
		} catch {
			return [];
		}
	}

	async listPaginated(options: ListUsersOptions = {}): Promise<UserListPage> {
		const limit = resolveListLimit(options.limit);
		const search = options.search?.trim().toLowerCase();
		const role = options.role ?? null;
		const status = options.status ?? null;
		const cursor = options.cursor;
		// Bounded by keyset even in file mode: sort by (lower(name), user_id),
		// apply the same filters as postgres BEFORE the cursor/slice, then drop
		// everything up to and including the cursor and slice one page.
		const sorted = (await this.list())
			.filter((user) => {
				if (!search) return true;
				return `${user.name} ${user.email}`.toLowerCase().includes(search);
			})
			.filter((user) => {
				if (role && user.role !== role) return false;
				if (status === "active" && !user.isActive) return false;
				if (status === "disabled" && user.isActive) return false;
				return true;
			})
			.filter((user) => (cursor ? compareKeyset(keysetOf(user), cursor) > 0 : true));
		const page = sorted.slice(0, limit);
		const nextCursor = sorted.length > limit && page.length > 0 ? keysetOf(page[page.length - 1]) : null;
		return { users: page, nextCursor };
	}

	async count(options: ListUsersOptions = {}): Promise<number> {
		const search = options.search?.trim().toLowerCase();
		const role = options.role ?? null;
		const status = options.status ?? null;
		return (await this.list()).filter((user) => {
			if (search && !`${user.name} ${user.email}`.toLowerCase().includes(search)) return false;
			if (role && user.role !== role) return false;
			if (status === "active" && !user.isActive) return false;
			if (status === "disabled" && user.isActive) return false;
			return true;
		}).length;
	}

	async countActiveByRole(role: UserRole): Promise<number> {
		return (await this.list()).filter((user) => user.role === role && user.isActive).length;
	}

	async updateLastLogin(userId: string, lastLoginIso: string): Promise<void> {
		const user = await this.load(userId);
		if (!user) return;
		user.lastLogin = lastLoginIso;
		user.updatedAt = lastLoginIso;
		this.writeUserFile(userId, user);
	}

	private userPath(userId: string): string {
		return join(this.usersDir, `${userId}.json`);
	}

	private writeUserFile(userId: string, user: User): void {
		mkdirSync(this.usersDir, { recursive: true });
		writeFileSync(this.userPath(userId), JSON.stringify(user, null, 2));
	}
}

export class PostgresAuthUserStore implements AuthUserStore {
	readonly kind = "postgres" as const;

	private readonly client: AuthUserSqlClient;

	constructor(databaseUrlOrClient: string | AuthUserSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("AUTH_USER_STORE=postgres requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as AuthUserSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async create(user: User): Promise<User> {
		const normalized = normalizeUser(user);
		const rows = await this.client.unsafe<AuthUserRow>(`
			INSERT INTO auth_users (
				user_id, email, email_normalized, password_hash, name, role,
				auth_provider, external_subject, email_verified, verification_email_send_failed,
				tokens_valid_from_ms, locale, is_active,
				last_login_at, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
			RETURNING user_id, email, password_hash, name, role, auth_provider, external_subject,
				email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active,
				last_login_at, created_at, updated_at
		`, [
			normalized.id,
			normalized.email,
			normalizeEmail(normalized.email),
			normalized.passwordHash,
			normalized.name,
			normalized.role,
			normalized.authProvider,
			normalized.externalSubject ?? null,
			normalized.emailVerified ?? false,
			normalized.verificationEmailSendFailed ?? false,
			normalized.tokensValidFromMs ?? 0,
			normalized.locale ?? null,
			normalized.isActive,
			normalized.lastLogin ?? null,
			normalized.createdAt,
			normalized.updatedAt,
		]);
		const row = rows[0];
		if (!row) throw new Error("auth_users INSERT did not return a row");
		return mapAuthUserRow(row);
	}

	async save(user: User): Promise<User> {
		const normalized = normalizeUser(user);
		const rows = await this.client.unsafe<AuthUserRow>(`
			INSERT INTO auth_users (
				user_id, email, email_normalized, password_hash, name, role,
				auth_provider, external_subject, email_verified, verification_email_send_failed,
				tokens_valid_from_ms, locale, is_active,
				last_login_at, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
			ON CONFLICT (user_id) DO UPDATE
			SET email = EXCLUDED.email,
				email_normalized = EXCLUDED.email_normalized,
				password_hash = EXCLUDED.password_hash,
				name = EXCLUDED.name,
				role = EXCLUDED.role,
				auth_provider = EXCLUDED.auth_provider,
				external_subject = EXCLUDED.external_subject,
				email_verified = EXCLUDED.email_verified,
				verification_email_send_failed = EXCLUDED.verification_email_send_failed,
				tokens_valid_from_ms = EXCLUDED.tokens_valid_from_ms,
				locale = EXCLUDED.locale,
				is_active = EXCLUDED.is_active,
				last_login_at = EXCLUDED.last_login_at,
				updated_at = EXCLUDED.updated_at
			RETURNING user_id, email, password_hash, name, role, auth_provider, external_subject,
				email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active,
				last_login_at, created_at, updated_at
		`, [
			normalized.id,
			normalized.email,
			normalizeEmail(normalized.email),
			normalized.passwordHash,
			normalized.name,
			normalized.role,
			normalized.authProvider,
			normalized.externalSubject ?? null,
			normalized.emailVerified ?? false,
			normalized.verificationEmailSendFailed ?? false,
			normalized.tokensValidFromMs ?? 0,
			normalized.locale ?? null,
			normalized.isActive,
			normalized.lastLogin ?? null,
			normalized.createdAt,
			normalized.updatedAt,
		]);
		const row = rows[0];
		if (!row) throw new Error("auth_users UPSERT did not return a row");
		return mapAuthUserRow(row);
	}

	async load(userId: string): Promise<User | null> {
		const rows = await this.client.unsafe<AuthUserRow>(`
			SELECT user_id, email, password_hash, name, role, auth_provider, external_subject,
				email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
			FROM auth_users
			WHERE user_id = $1
			LIMIT 1
		`, [userId]);
		return rows[0] ? this.withExternalIdentities(mapAuthUserRow(rows[0])) : null;
	}

	async findByEmail(email: string): Promise<User | null> {
		const rows = await this.client.unsafe<AuthUserRow>(`
			SELECT user_id, email, password_hash, name, role, auth_provider, external_subject,
				email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
			FROM auth_users
			WHERE email_normalized = $1
			LIMIT 1
		`, [normalizeEmail(email)]);
		return rows[0] ? this.withExternalIdentities(mapAuthUserRow(rows[0])) : null;
	}

	async findByExternalIdentity(provider: AuthIdentityProvider, subject: string): Promise<User | null> {
		if (provider === "local" || !subject) return null;
		const linkedRows = await this.client.unsafe<AuthUserRow>(`
			SELECT u.user_id, u.email, u.password_hash, u.name, u.role, u.auth_provider, u.external_subject,
				u.email_verified, u.verification_email_send_failed, u.tokens_valid_from_ms, u.locale,
				u.is_active, u.last_login_at, u.created_at, u.updated_at
			FROM auth_external_identities i
			JOIN auth_users u ON u.user_id = i.user_id
			WHERE i.provider = $1 AND i.provider_user_id = $2
			LIMIT 1
		`, [provider, subject]);
		if (linkedRows[0]) return this.withExternalIdentities(mapAuthUserRow(linkedRows[0]));

		const rows = await this.client.unsafe<AuthUserRow>(`
			SELECT user_id, email, password_hash, name, role, auth_provider, external_subject,
				email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
			FROM auth_users
			WHERE auth_provider = $1 AND external_subject = $2
			LIMIT 1
		`, [provider, subject]);
		return rows[0] ? this.withExternalIdentities(mapAuthUserRow(rows[0])) : null;
	}

	async update(userId: string, updates: UpdateUserRequest): Promise<User | null> {
		const existing = await this.load(userId);
		if (!existing) return null;
		applyUserUpdates(existing, updates);
		const update = buildAuthUserUpdateAssignments(existing, updates);
		const rows = await this.client.unsafe<AuthUserRow>(`
			UPDATE auth_users
			SET ${update.assignments.join(",\n\t\t\t\t")}
			WHERE user_id = $1
			RETURNING user_id, email, password_hash, name, role, auth_provider, external_subject,
				email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
		`, [userId, ...update.params]);
		return rows[0] ? this.withExternalIdentities(mapAuthUserRow(rows[0])) : null;
	}

	async updateProtectingLastOwner(userId: string, updates: UpdateUserRequest): Promise<User | null> {
		return runTransaction(this.client, async (tx) => {
			// Serialize the whole owner-set count+mutate across connections. Without
			// this, two concurrent demote/disable transactions could each pass the
			// EXISTS guard against a snapshot taken before the other committed.
			await tx.unsafe(`SELECT pg_advisory_xact_lock($1)`, [OWNER_MUTATION_ADVISORY_LOCK_KEY]);
			// Lock the target row and read its CURRENT state inside the txn so the
			// demote/disable decision is based on committed data, not the route's
			// stale pre-check.
			const lockedRows = await tx.unsafe<AuthUserRow>(`
				SELECT user_id, email, password_hash, name, role, auth_provider, external_subject,
					email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
				FROM auth_users
				WHERE user_id = $1
				FOR UPDATE
			`, [userId]);
			if (!lockedRows[0]) return null;
			const existing = mapAuthUserRow(lockedRows[0]);
			const guardOwner = isOwnerDemotionOrDisable(existing, updates);

			applyUserUpdates(existing, updates);
			const update = buildAuthUserUpdateAssignments(existing, updates);
			// When demoting/disabling an active owner, only apply if ANOTHER active
			// owner still exists — evaluated in the same statement, against rows the
			// advisory lock + FOR UPDATE have serialized. 0 rows affected → the
			// platform would be orphaned, so fail closed.
			const ownerGuardClause = guardOwner
				? `AND EXISTS (
						SELECT 1 FROM auth_users o
						WHERE o.role = 'owner' AND o.is_active = true AND o.user_id <> $1
					)`
				: "";
			const rows = await tx.unsafe<AuthUserRow>(`
				UPDATE auth_users
				SET ${update.assignments.join(",\n\t\t\t\t\t")}
				WHERE user_id = $1
				${ownerGuardClause}
				RETURNING user_id, email, password_hash, name, role, auth_provider, external_subject,
					email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
			`, [userId, ...update.params]);
			if (!rows[0]) {
				if (guardOwner) {
					throw new LastPlatformOwnerError(
						updates.isActive === false ? "Cannot disable the last platform owner" : "Cannot demote the last platform owner",
					);
				}
				return null;
			}
			return this.withExternalIdentities(mapAuthUserRow(rows[0]), tx);
		});
	}

	async linkExternalIdentity(userId: string, identity: ExternalIdentity): Promise<User | null> {
		const now = new Date().toISOString();
		// `email_verified` is declared NOT NULL, so a fresh insert must always
		// supply a concrete boolean. When the caller omits it we default to
		// `true` (matching the column default and the file store). On conflict we
		// still preserve any existing verified flag rather than overwriting it
		// with the default, using the explicit nullable `$5` parameter.
		const emailVerifiedInsert = identity.emailVerified ?? true;
		const emailVerifiedOverride = identity.emailVerified ?? null;
		// The identity INSERT, the ownership SELECT, and the auth_users UPDATE must
		// be atomic: a crash between them would otherwise leave a half-linked
		// account (identity row written but user not updated, or vice versa) or
		// let a concurrent link race past the ownership check. Wrapping them in a
		// single transaction makes the ownership SELECT see the just-inserted row
		// consistently and guarantees all-or-nothing. `runTransaction` falls back
		// to explicit BEGIN/COMMIT/ROLLBACK if the client lacks `begin`.
		return runTransaction(this.client, async (tx) => {
			const identityRows = await tx.unsafe<AuthExternalIdentityRow>(`
				INSERT INTO auth_external_identities (
					user_id, provider, provider_user_id, email_verified, created_at, updated_at
				) VALUES ($1, $2, $3, $4, $6, $6)
				ON CONFLICT (provider, provider_user_id) DO UPDATE
				SET email_verified = COALESCE($5, auth_external_identities.email_verified),
					updated_at = EXCLUDED.updated_at
				WHERE auth_external_identities.user_id = EXCLUDED.user_id
				RETURNING user_id, provider, provider_user_id, email_verified, created_at, updated_at
			`, [
				userId,
				identity.provider,
				identity.subject,
				emailVerifiedInsert,
				emailVerifiedOverride,
				now,
			]);
			if (!identityRows[0]) {
				const ownerRows = await tx.unsafe<AuthExternalIdentityRow>(`
					SELECT user_id, provider, provider_user_id, email_verified, created_at, updated_at
					FROM auth_external_identities
					WHERE provider = $1 AND provider_user_id = $2
					LIMIT 1
				`, [identity.provider, identity.subject]);
				if (ownerRows[0]?.user_id !== userId) {
					throw new Error("External identity already linked to another user");
				}
			}
			const rows = await tx.unsafe<AuthUserRow>(`
				UPDATE auth_users
				SET auth_provider = CASE
						WHEN auth_provider <> 'local' AND external_subject IS NULL THEN $2
						ELSE auth_provider
					END,
					external_subject = CASE
						WHEN auth_provider <> 'local' AND external_subject IS NULL THEN $3
						ELSE external_subject
					END,
					email_verified = COALESCE($4, email_verified),
					updated_at = $5
				WHERE user_id = $1
				RETURNING user_id, email, password_hash, name, role, auth_provider, external_subject,
					email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
			`, [
				userId,
				identity.provider,
				identity.subject,
				identity.emailVerified ?? null,
				now,
			]);
			if (!rows[0]) return null;
			// Read identities inside the same transaction so the returned shape
			// reflects the just-linked identity consistently.
			const identityList = await tx.unsafe<AuthExternalIdentityRow>(`
				SELECT user_id, provider, provider_user_id, email_verified, created_at, updated_at
				FROM auth_external_identities
				WHERE user_id = $1
				ORDER BY created_at ASC
			`, [userId]);
			return mergeExternalIdentities(mapAuthUserRow(rows[0]), identityList);
		});
	}

	async delete(userId: string): Promise<boolean> {
		const rows = await this.client.unsafe<{ user_id: string }>(`
			DELETE FROM auth_users
			WHERE user_id = $1
			RETURNING user_id
		`, [userId]);
		return rows.length > 0;
	}

	async deleteProtectingLastOwner(userId: string): Promise<boolean> {
		return runTransaction(this.client, async (tx) => {
			await tx.unsafe(`SELECT pg_advisory_xact_lock($1)`, [OWNER_MUTATION_ADVISORY_LOCK_KEY]);
			const lockedRows = await tx.unsafe<{ role: string; is_active: boolean | string | number }>(`
				SELECT role, is_active
				FROM auth_users
				WHERE user_id = $1
				FOR UPDATE
			`, [userId]);
			if (!lockedRows[0]) return false;
			const guardOwner = coerceUserRole(lockedRows[0].role) === "owner" && toBoolean(lockedRows[0].is_active);
			// Delete only when, for an active-owner target, another active owner still
			// exists — checked atomically with the DELETE under the advisory lock.
			const ownerGuardClause = guardOwner
				? `AND EXISTS (
						SELECT 1 FROM auth_users o
						WHERE o.role = 'owner' AND o.is_active = true AND o.user_id <> $1
					)`
				: "";
			const rows = await tx.unsafe<{ user_id: string }>(`
				DELETE FROM auth_users
				WHERE user_id = $1
				${ownerGuardClause}
				RETURNING user_id
			`, [userId]);
			if (rows.length === 0) {
				if (guardOwner) {
					throw new LastPlatformOwnerError("Cannot delete the last platform owner");
				}
				return false;
			}
			return true;
		});
	}

	async list(): Promise<User[]> {
		const rows = await this.client.unsafe<AuthUserRow>(`
			SELECT user_id, email, password_hash, name, role, auth_provider, external_subject,
				email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
			FROM auth_users
			ORDER BY lower(name), user_id
		`);
		return this.attachExternalIdentities(rows.map(mapAuthUserRow));
	}

	async listPaginated(options: ListUsersOptions = {}): Promise<UserListPage> {
		const limit = resolveListLimit(options.limit);
		const search = options.search?.trim();
		const role = options.role ?? null;
		const status = options.status ?? null;
		const cursor = options.cursor;

		// Build the WHERE clause from optional search + role/status + keyset cursor.
		// Filters are pushed into SQL (no JS-side page post-filter); the keyset
		// predicate uses (lower(name), user_id) so paging is index-driven and stable.
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (search) {
			params.push(`%${search}%`);
			conditions.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
		}
		if (role) {
			params.push(role);
			conditions.push(`role = $${params.length}`);
		}
		if (status === "active") {
			conditions.push(`(is_active = true OR is_active = 't' OR is_active::text = '1')`);
		} else if (status === "disabled") {
			conditions.push(`NOT (is_active = true OR is_active = 't' OR is_active::text = '1')`);
		}
		if (cursor) {
			params.push(cursor.name);
			const nameIdx = params.length;
			params.push(cursor.userId);
			const userIdx = params.length;
			// Row-value keyset comparison on the same key as ORDER BY.
			conditions.push(`(lower(name), user_id) > ($${nameIdx}, $${userIdx})`);
		}
		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		// Fetch one extra row to detect whether a further page exists.
		params.push(limit + 1);
		const limitIdx = params.length;

		const rows = await this.client.unsafe<AuthUserRow>(`
			SELECT user_id, email, password_hash, name, role, auth_provider, external_subject,
				email_verified, verification_email_send_failed, tokens_valid_from_ms, locale, is_active, last_login_at, created_at, updated_at
			FROM auth_users
			${whereClause}
			ORDER BY lower(name), user_id
			LIMIT $${limitIdx}
		`, params);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;
		const users = await this.attachExternalIdentities(pageRows.map(mapAuthUserRow));
		const last = users[users.length - 1];
		const nextCursor = hasMore && last ? { name: last.name.toLowerCase(), userId: last.id } : null;
		return { users, nextCursor };
	}

	async count(options: ListUsersOptions = {}): Promise<number> {
		const search = options.search?.trim();
		const role = options.role ?? null;
		const status = options.status ?? null;
		const params: unknown[] = [];
		const conditions: string[] = [];
		if (search) {
			params.push(`%${search}%`);
			conditions.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
		}
		if (role) {
			params.push(role);
			conditions.push(`role = $${params.length}`);
		}
		if (status === "active") {
			conditions.push(`(is_active = true OR is_active = 't' OR is_active::text = '1')`);
		} else if (status === "disabled") {
			conditions.push(`NOT (is_active = true OR is_active = 't' OR is_active::text = '1')`);
		}
		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		// Single bounded aggregate matching the same filter as listPaginated, so
		// the admin UI shows an honest grand total rather than a page count.
		const rows = await this.client.unsafe<{ count: string | number }>(`
			SELECT COUNT(*)::bigint AS count
			FROM auth_users
			${whereClause}
		`, params);
		return Number(rows[0]?.count ?? 0);
	}

	async countActiveByRole(role: UserRole): Promise<number> {
		// One bounded aggregate. is_active may be stored as boolean or 0/1 across
		// drivers, so normalize with a truthiness check rather than `= true`.
		const rows = await this.client.unsafe<{ count: string | number }>(`
			SELECT COUNT(*)::bigint AS count
			FROM auth_users
			WHERE role = $1 AND (is_active = true OR is_active = 't' OR is_active::text = '1')
		`, [role]);
		return Number(rows[0]?.count ?? 0);
	}

	async updateLastLogin(userId: string, lastLoginIso: string): Promise<void> {
		await this.client.unsafe(`
			UPDATE auth_users
			SET last_login_at = $2, updated_at = $2
			WHERE user_id = $1
		`, [userId, lastLoginIso]);
	}

	private async withExternalIdentities(user: User, client: AuthUserSqlClient = this.client): Promise<User> {
		// `client` defaults to the pool but callers inside a transaction pass `tx`
		// so the identity read sees the same in-flight state as the mutation.
		const rows = await client.unsafe<AuthExternalIdentityRow>(`
			SELECT user_id, provider, provider_user_id, email_verified, created_at, updated_at
			FROM auth_external_identities
			WHERE user_id = $1
			ORDER BY created_at ASC
		`, [user.id]);
		return mergeExternalIdentities(user, rows);
	}

	/**
	 * Batch-attach external identities to many users in a SINGLE query
	 * (`user_id = ANY(ARRAY[$1,$2,...])`), eliminating the per-user N+1 that the
	 * old `Promise.all(rows.map(withExternalIdentities))` incurred. Identities
	 * are grouped in memory; ordering within a user mirrors the single-user path
	 * (created_at ASC). Returns users in the same order they were passed in.
	 *
	 * NOTE: each id is bound as its own scalar placeholder rather than a single
	 * JS-array param (`$1::text[]`). `Bun.SQL.unsafe` cannot bind a JS array — on
	 * real Postgres that throws `malformed array literal` — so the IN-list is
	 * expanded into a Postgres `ARRAY[...]` of scalar binds instead.
	 */
	private async attachExternalIdentities(users: User[]): Promise<User[]> {
		if (users.length === 0) return [];
		const ids = users.map((user) => user.id);
		const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
		const rows = await this.client.unsafe<AuthExternalIdentityRow>(`
			SELECT user_id, provider, provider_user_id, email_verified, created_at, updated_at
			FROM auth_external_identities
			WHERE user_id = ANY(ARRAY[${placeholders}]::text[])
			ORDER BY created_at ASC
		`, ids);
		const byUser = new Map<string, AuthExternalIdentityRow[]>();
		for (const row of rows) {
			const bucket = byUser.get(row.user_id);
			if (bucket) bucket.push(row);
			else byUser.set(row.user_id, [row]);
		}
		return users.map((user) => mergeExternalIdentities(user, byUser.get(user.id) ?? []));
	}
}

export function createAuthUserStore(): AuthUserStore {
	if (serverConfig.authUserStore === "postgres") {
		return new PostgresAuthUserStore();
	}
	return new FileAuthUserStore();
}

export const authUserStore = createAuthUserStore();

/**
 * One-time platform-owner bootstrap (admin-audit completeness fix). The /admin
 * back-office is otherwise UNREACHABLE on a fresh install: only an existing platform
 * admin can grant the platform role (PATCH /api/admin/users-mgmt/:id/role), so with
 * ZERO admins nobody can ever get in. When ADMIN_BOOTSTRAP_EMAIL is set we promote
 * that (already-registered) account to platform `owner`.
 *
 * Safety: promotion ONLY — never demotes, never disables, never creates an account;
 * a no-op once the account is already a platform admin (idempotent), so leaving the
 * env var set across restarts can neither double-apply nor fight a later manual role
 * change. Errors are logged and swallowed so a transient DB hiccup never blocks the
 * HTTP listener from binding.
 */
export async function bootstrapPlatformOwner(store: AuthUserStore = authUserStore): Promise<void> {
	const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
	if (!email) return;
	let user: User | null = null;
	try {
		user = await store.findByEmail(email);
	} catch (error) {
		console.error(`[bootstrap] platform-owner lookup failed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!user) {
		console.warn("[bootstrap] ADMIN_BOOTSTRAP_EMAIL is set but no account exists for it yet — register that email, then restart to promote it to platform owner.");
		return;
	}
	if (isPlatformAdmin(user.role)) {
		console.log(`[bootstrap] platform-owner account is already a platform ${user.role}; nothing to do.`);
		return;
	}
	try {
		await store.update(user.id, { role: "owner" });
		console.log("[bootstrap] promoted the ADMIN_BOOTSTRAP_EMAIL account to platform owner.");
	} catch (error) {
		console.error(`[bootstrap] failed to promote platform owner: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function normalizeUser(user: User): User {
	return {
		...user,
		email: normalizeEmail(user.email),
		authProvider: user.authProvider ?? "local",
		externalIdentities: normalizeExternalIdentities(user.externalIdentities),
		emailVerified: user.emailVerified ?? false,
		verificationEmailSendFailed: user.verificationEmailSendFailed ?? false,
		locale: normalizeStoredLocale(user.locale),
		tokensValidFromMs: user.tokensValidFromMs ?? 0,
		isActive: user.isActive ?? true,
	};
}

export function mapAuthUserRow(row: AuthUserRow): User {
	return normalizeUser({
		id: row.user_id,
		email: row.email,
		passwordHash: row.password_hash,
		name: row.name,
		role: coerceUserRole(row.role),
		authProvider: isAuthIdentityProvider(row.auth_provider) ? row.auth_provider : "local",
		externalSubject: row.external_subject ?? undefined,
		emailVerified: toBoolean(row.email_verified),
		verificationEmailSendFailed: toBoolean(row.verification_email_send_failed ?? false),
		locale: normalizeStoredLocale(row.locale),
		tokensValidFromMs: toEpochMs(row.tokens_valid_from_ms),
		isActive: toBoolean(row.is_active),
		lastLogin: row.last_login_at ? toIso(row.last_login_at) : undefined,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	});
}

/**
 * True when `updates` would demote a currently-active owner away from the owner
 * role, OR disable a currently-active owner. These are exactly the mutations that
 * can reduce the active-owner count and must be guarded against orphaning the
 * platform. (Enabling, renaming, or re-affirming role=owner cannot reduce the
 * count and are not guarded.)
 */
export function isOwnerDemotionOrDisable(current: User, updates: UpdateUserRequest): boolean {
	if (current.role !== "owner" || !current.isActive) return false;
	const demoting = updates.role !== undefined && updates.role !== "owner";
	const disabling = updates.isActive === false;
	return demoting || disabling;
}

export function applyUserUpdates(user: User, updates: UpdateUserRequest): void {
	if (updates.name !== undefined) user.name = updates.name;
	if (updates.email !== undefined) {
		const nextEmail = normalizeEmail(updates.email);
		if (nextEmail !== normalizeEmail(user.email)) {
			// The verification flag is bound to a specific address. Changing the
			// email (e.g. via the admin update path) must drop any prior verified
			// status and invalidate outstanding access tokens so a stale "verified"
			// claim cannot carry over to the new, unconfirmed address. Refresh
			// sessions are revoked separately in updateUser (async store call).
			user.emailVerified = false;
			user.tokensValidFromMs = Date.now();
		}
		user.email = nextEmail;
	}
	if (updates.role !== undefined) user.role = updates.role;
	if (updates.isActive !== undefined) user.isActive = updates.isActive;
	if (updates.verificationEmailSendFailed !== undefined) {
		user.verificationEmailSendFailed = updates.verificationEmailSendFailed;
	}
	if (updates.locale !== undefined) {
		user.locale = updates.locale;
	}
	user.updatedAt = new Date().toISOString();
}

function buildAuthUserUpdateAssignments(user: User, updates: UpdateUserRequest): { assignments: string[]; params: unknown[] } {
	const assignments: string[] = [];
	const params: unknown[] = [];
	const add = (column: string, value: unknown) => {
		assignments.push(`${column} = $${params.length + 2}`);
		params.push(value);
	};

	if (updates.email !== undefined) {
		add("email", user.email);
		add("email_normalized", normalizeEmail(user.email));
		// Email changes carry verification/session-invalidating side effects. Keep
		// these coupled to the email column instead of writing them on unrelated
		// profile preference saves.
		add("email_verified", user.emailVerified ?? false);
		add("tokens_valid_from_ms", user.tokensValidFromMs ?? 0);
	}
	if (updates.name !== undefined) add("name", user.name);
	if (updates.role !== undefined) add("role", user.role);
	if (updates.isActive !== undefined) add("is_active", user.isActive);
	if (updates.verificationEmailSendFailed !== undefined) {
		add("verification_email_send_failed", user.verificationEmailSendFailed ?? false);
	}
	if (updates.locale !== undefined) add("locale", user.locale ?? null);
	add("updated_at", user.updatedAt);

	return { assignments, params };
}

/**
 * Run `fn` inside a DB transaction. Mirrors storage-cow's helper: if the client
 * exposes `begin` (Bun.SQL transactions) we delegate to it; otherwise we drive
 * BEGIN/COMMIT/ROLLBACK explicitly so any AuthUserSqlClient is supported and the
 * flow stays all-or-nothing.
 */
async function runTransaction<T>(
	client: AuthUserSqlClient,
	fn: (transaction: AuthUserSqlClient) => Promise<T>,
): Promise<T> {
	if (client.begin) return client.begin(fn);
	await client.unsafe("BEGIN");
	try {
		const result = await fn(client);
		await client.unsafe("COMMIT");
		return result;
	} catch (error) {
		await client.unsafe("ROLLBACK");
		throw error;
	}
}

/** Merge external-identity rows onto a user, preserving the existing shape. */
function mergeExternalIdentities(user: User, rows: AuthExternalIdentityRow[]): User {
	if (rows.length === 0) return normalizeUser(user);
	return normalizeUser({
		...user,
		externalIdentities: rows
			.filter((row) => isAuthIdentityProvider(row.provider) && row.provider !== "local")
			.map((row) => ({
				provider: row.provider as Exclude<AuthIdentityProvider, "local">,
				subject: row.provider_user_id,
				emailVerified: row.email_verified === null || row.email_verified === undefined ? undefined : toBoolean(row.email_verified),
			})),
	});
}

/** Keyset key for a user: (lower(name), user_id). */
function keysetOf(user: User): UserListCursor {
	return { name: user.name.toLowerCase(), userId: user.id };
}

/** Total order matching `ORDER BY lower(name), user_id`. */
function compareKeyset(a: UserListCursor, b: UserListCursor): number {
	if (a.name < b.name) return -1;
	if (a.name > b.name) return 1;
	if (a.userId < b.userId) return -1;
	if (a.userId > b.userId) return 1;
	return 0;
}

function compareUsersByNameKeyset(a: User, b: User): number {
	return compareKeyset(keysetOf(a), keysetOf(b));
}

function normalizeExternalIdentities(identities: ExternalIdentity[] | undefined): ExternalIdentity[] | undefined {
	if (!identities?.length) return undefined;
	const seen = new Set<string>();
	const normalized: ExternalIdentity[] = [];
	for (const identity of identities) {
		if (!isAuthIdentityProvider(identity.provider) || (identity.provider as string) === "local" || !identity.subject) continue;
		const key = `${identity.provider}:${identity.subject}`;
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(identity);
	}
	return normalized.length > 0 ? normalized : undefined;
}

// Valid platform roles, derived from the single ROLE_PERMISSIONS source so this
// allow-list never drifts from the permission map. auth_users.role is free TEXT,
// so a stored value outside the union (legacy/typo/future role) is coerced to
// the least-privileged "viewer" rather than silently inheriting "editor". A
// known platform role (owner/admin/support/accountant/editor/viewer) survives
// load intact so back-office staff keep their access across a restart.
const VALID_USER_ROLES = new Set<string>(Object.keys(ROLE_PERMISSIONS));

function coerceUserRole(value: string): UserRole {
	return VALID_USER_ROLES.has(value) ? (value as UserRole) : "viewer";
}

function isAuthIdentityProvider(value: string): value is AuthIdentityProvider {
	return ["local", "auth0", "oidc", "saml", "google", "github", "line"].includes(value);
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toBoolean(value: boolean | string | number): boolean {
	return value === true || value === "true" || value === 1 || value === "1";
}

function toEpochMs(value: number | string | null | undefined): number {
	if (value === null || value === undefined) return 0;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
