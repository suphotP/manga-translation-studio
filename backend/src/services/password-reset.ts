import { getSharedBunSql } from "./sql-pool.js";
import { createHash, createHmac, randomBytes, randomInt } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";

export type AuthTokenKind = "password_reset" | "email_verify";
export type AuthTokenFailureReason = "expired" | "used" | "not_found";

export interface AuthFlowTokenRecord {
	id: string;
	tokenHash: string;
	userId: string;
	kind: AuthTokenKind;
	expiresAt: string;
	usedAt: string | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	createdAt: string;
}

export interface AuthFlowTokenStore {
	create(record: AuthFlowTokenRecord): Promise<void>;
	list(kind: AuthTokenKind): Promise<AuthFlowTokenRecord[]>;
	findByTokenHash(kind: AuthTokenKind, tokenHash: string): Promise<AuthFlowTokenRecord | null>;
	markUsed(tokenHash: string, usedAtIso: string): Promise<boolean>;
	consumeUnused(kind: AuthTokenKind, id: string, usedAtIso: string): Promise<boolean>;
	invalidateUnusedForUser(kind: AuthTokenKind, userId: string, usedAtIso: string): Promise<number>;
	cleanupExpired(nowIso: string): Promise<{ deleted: number }>;
	/**
	 * GDPR right-to-erasure: irreversibly DELETE every password-reset +
	 * email-verification token belonging to a user. These rows carry token_hash +
	 * ip_address (+ user_agent on resets) — direct PII — and in Postgres cascade ONLY
	 * on a HARD auth_users delete, which erasure never performs (it tombstones the
	 * row), so they must be dropped explicitly. Idempotent: a second call removes
	 * nothing once the rows are gone. Returns how many token rows were removed.
	 */
	eraseForUser(userId: string): Promise<{ deleted: number }>;
	/**
	 * GDPR data-portability (Art. 15/20): list every auth-flow token row for a user
	 * so the export bundle can include the lifecycle + origin metadata. Bounded by
	 * `limit` (newest first). The caller is responsible for redacting the secret
	 * `tokenHash` before it ships in a portable bundle.
	 */
	listForUser(userId: string, options?: { limit?: number }): Promise<AuthFlowTokenRecord[]>;
}

export interface AuthFlowSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

interface AuthFlowTokenRow {
	id: string;
	token_hash: string;
	user_id: string;
	expires_at: Date | string;
	used_at?: Date | string | null;
	ip_address?: string | null;
	user_agent?: string | null;
	created_at: Date | string;
}

interface TokenSnapshot {
	tokens: AuthFlowTokenRecord[];
	auditEvents?: AuthAuditEvent[];
}

export interface AuthAuditEvent {
	id: string;
	userId: string;
	action: string;
	metadata: Record<string, unknown>;
	createdAt: string;
}

export class FileAuthFlowTokenStore implements AuthFlowTokenStore {
	constructor(private readonly persistPath = join(DATA_DIR, "auth-flow-tokens.json")) {}

	async create(record: AuthFlowTokenRecord): Promise<void> {
		const snapshot = this.readSnapshot();
		snapshot.tokens.push(record);
		this.writeSnapshot(snapshot);
	}

	async list(kind: AuthTokenKind): Promise<AuthFlowTokenRecord[]> {
		return this.readSnapshot().tokens.filter((token) => token.kind === kind);
	}

	async findByTokenHash(kind: AuthTokenKind, tokenHash: string): Promise<AuthFlowTokenRecord | null> {
		return this.readSnapshot().tokens.find((token) => token.kind === kind && token.tokenHash === tokenHash) ?? null;
	}

	async markUsed(tokenHash: string, usedAtIso: string): Promise<boolean> {
		const snapshot = this.readSnapshot();
		let changed = false;
		for (const token of snapshot.tokens) {
			if (token.tokenHash === tokenHash && !token.usedAt) {
				token.usedAt = usedAtIso;
				changed = true;
			}
		}
		if (changed) this.writeSnapshot(snapshot);
		return changed;
	}

	async consumeUnused(kind: AuthTokenKind, id: string, usedAtIso: string): Promise<boolean> {
		const snapshot = this.readSnapshot();
		const token = snapshot.tokens.find((item) => item.kind === kind && item.id === id && !item.usedAt);
		if (!token) return false;
		token.usedAt = usedAtIso;
		this.writeSnapshot(snapshot);
		return true;
	}

	async invalidateUnusedForUser(kind: AuthTokenKind, userId: string, usedAtIso: string): Promise<number> {
		const snapshot = this.readSnapshot();
		let changed = 0;
		for (const token of snapshot.tokens) {
			if (token.kind === kind && token.userId === userId && !token.usedAt) {
				token.usedAt = usedAtIso;
				changed += 1;
			}
		}
		if (changed > 0) this.writeSnapshot(snapshot);
		return changed;
	}

	async cleanupExpired(nowIso: string): Promise<{ deleted: number }> {
		const snapshot = this.readSnapshot();
		const before = snapshot.tokens.length;
		snapshot.tokens = snapshot.tokens.filter((token) => token.expiresAt > nowIso);
		this.writeSnapshot(snapshot);
		return { deleted: before - snapshot.tokens.length };
	}

	async eraseForUser(userId: string): Promise<{ deleted: number }> {
		const normalized = userId.trim();
		if (!normalized) return { deleted: 0 };
		const snapshot = this.readSnapshot();
		const before = snapshot.tokens.length;
		snapshot.tokens = snapshot.tokens.filter((token) => token.userId !== normalized);
		const deleted = before - snapshot.tokens.length;
		if (deleted > 0) this.writeSnapshot(snapshot);
		return { deleted };
	}

	async listForUser(userId: string, options: { limit?: number } = {}): Promise<AuthFlowTokenRecord[]> {
		const normalized = userId.trim();
		if (!normalized) return [];
		const limit = options.limit ?? 1000;
		return this.readSnapshot().tokens
			.filter((token) => token.userId === normalized)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, Math.max(0, limit));
	}

	async appendAudit(event: AuthAuditEvent): Promise<void> {
		const snapshot = this.readSnapshot();
		snapshot.auditEvents = [event, ...(snapshot.auditEvents ?? [])].slice(0, 10_000);
		this.writeSnapshot(snapshot);
	}

	private readSnapshot(): TokenSnapshot {
		if (!existsSync(this.persistPath)) return { tokens: [], auditEvents: [] };
		try {
			const snapshot = readJsonFile<TokenSnapshot>(this.persistPath);
			return {
				tokens: Array.isArray(snapshot.tokens) ? snapshot.tokens.filter(isAuthFlowTokenRecord) : [],
				auditEvents: Array.isArray(snapshot.auditEvents) ? snapshot.auditEvents.filter(isAuthAuditEvent) : [],
			};
		} catch {
			return { tokens: [], auditEvents: [] };
		}
	}

	private writeSnapshot(snapshot: TokenSnapshot): void {
		mkdirSync(dirname(this.persistPath), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify(snapshot, null, 2));
	}
}

export class PostgresAuthFlowTokenStore implements AuthFlowTokenStore {
	private readonly client: AuthFlowSqlClient;

	constructor(databaseUrlOrClient: string | AuthFlowSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("AUTH_FLOW_TOKEN_STORE=postgres requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as AuthFlowSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async create(record: AuthFlowTokenRecord): Promise<void> {
		const table = tableForKind(record.kind);
		if (record.kind === "email_verify") {
			await this.client.unsafe(`
				INSERT INTO ${table} (id, token_hash, user_id, expires_at, used_at, ip_address, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
			`, [
				record.id,
				record.tokenHash,
				record.userId,
				record.expiresAt,
				record.usedAt,
				record.ipAddress ?? null,
				record.createdAt,
			]);
			return;
		}
		await this.client.unsafe(`
			INSERT INTO ${table} (id, token_hash, user_id, expires_at, used_at, ip_address, user_agent, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`, [
			record.id,
			record.tokenHash,
			record.userId,
			record.expiresAt,
			record.usedAt,
			record.ipAddress ?? null,
			record.userAgent ?? null,
			record.createdAt,
		]);
	}

	async list(kind: AuthTokenKind): Promise<AuthFlowTokenRecord[]> {
		const table = tableForKind(kind);
		const userAgentColumn = table === "password_resets" ? "user_agent" : "NULL AS user_agent";
		const rows = await this.client.unsafe<AuthFlowTokenRow>(`
			SELECT id, token_hash, user_id, expires_at, used_at, ip_address, ${userAgentColumn}, created_at
			FROM ${table}
			ORDER BY created_at DESC
		`);
		return rows.map((row) => mapTokenRow(row, kind));
	}

	async findByTokenHash(kind: AuthTokenKind, tokenHash: string): Promise<AuthFlowTokenRecord | null> {
		const table = tableForKind(kind);
		const userAgentColumn = table === "password_resets" ? "user_agent" : "NULL AS user_agent";
		const rows = await this.client.unsafe<AuthFlowTokenRow>(`
			SELECT id, token_hash, user_id, expires_at, used_at, ip_address, ${userAgentColumn}, created_at
			FROM ${table}
			WHERE token_hash = $1
			LIMIT 1
		`, [tokenHash]);
		return rows[0] ? mapTokenRow(rows[0], kind) : null;
	}

	async markUsed(tokenHash: string, usedAtIso: string): Promise<boolean> {
		const [passwordRows, verifyRows] = await Promise.all([
			this.client.unsafe<{ id: string }>("UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL RETURNING id", [tokenHash, usedAtIso]),
			this.client.unsafe<{ id: string }>("UPDATE email_verification_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL RETURNING id", [tokenHash, usedAtIso]),
		]);
		return passwordRows.length + verifyRows.length > 0;
	}

	async consumeUnused(kind: AuthTokenKind, id: string, usedAtIso: string): Promise<boolean> {
		const table = tableForKind(kind);
		const rows = await this.client.unsafe<{ id: string }>(`
			UPDATE ${table}
			SET used_at = $2
			WHERE id = $1 AND used_at IS NULL
			RETURNING id
		`, [id, usedAtIso]);
		return rows.length === 1;
	}

	async invalidateUnusedForUser(kind: AuthTokenKind, userId: string, usedAtIso: string): Promise<number> {
		const table = tableForKind(kind);
		const rows = await this.client.unsafe<{ id: string }>(`
			UPDATE ${table}
			SET used_at = $2
			WHERE user_id = $1 AND used_at IS NULL
			RETURNING id
		`, [userId, usedAtIso]);
		return rows.length;
	}

	async cleanupExpired(nowIso: string): Promise<{ deleted: number }> {
		const [passwordRows, verifyRows] = await Promise.all([
			this.client.unsafe<{ id: string }>("DELETE FROM password_resets WHERE expires_at <= $1 RETURNING id", [nowIso]),
			this.client.unsafe<{ id: string }>("DELETE FROM email_verification_tokens WHERE expires_at <= $1 RETURNING id", [nowIso]),
		]);
		return { deleted: passwordRows.length + verifyRows.length };
	}

	async eraseForUser(userId: string): Promise<{ deleted: number }> {
		const normalized = userId.trim();
		if (!normalized) return { deleted: 0 };
		// Production erasure deletes these atomically inside the GDPR purge
		// transaction (gdpr.ts); this standalone path keeps the interface honest for
		// any caller scrubbing on its own connection.
		const [passwordRows, verifyRows] = await Promise.all([
			this.client.unsafe<{ id: string }>("DELETE FROM password_resets WHERE user_id = $1 RETURNING id", [normalized]),
			this.client.unsafe<{ id: string }>("DELETE FROM email_verification_tokens WHERE user_id = $1 RETURNING id", [normalized]),
		]);
		return { deleted: passwordRows.length + verifyRows.length };
	}

	async listForUser(userId: string, options: { limit?: number } = {}): Promise<AuthFlowTokenRecord[]> {
		const normalized = userId.trim();
		if (!normalized) return [];
		const limit = Math.max(0, options.limit ?? 1000);
		const [passwordRows, verifyRows] = await Promise.all([
			this.client.unsafe<AuthFlowTokenRow>(
				"SELECT id, token_hash, user_id, expires_at, used_at, ip_address, user_agent, created_at FROM password_resets WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
				[normalized, limit],
			),
			this.client.unsafe<AuthFlowTokenRow>(
				"SELECT id, token_hash, user_id, expires_at, used_at, ip_address, NULL AS user_agent, created_at FROM email_verification_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
				[normalized, limit],
			),
		]);
		const mapped = [
			...passwordRows.map((row) => mapTokenRow(row, "password_reset")),
			...verifyRows.map((row) => mapTokenRow(row, "email_verify")),
		];
		return mapped
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit);
	}
}

export function createAuthFlowTokenStore(): AuthFlowTokenStore {
	if ((process.env.AUTH_FLOW_TOKEN_STORE || serverConfig.authUserStore) === "postgres") {
		return new PostgresAuthFlowTokenStore();
	}
	return new FileAuthFlowTokenStore();
}

export const authFlowTokenStore = createAuthFlowTokenStore();

export async function mintToken(
	userId: string,
	kind: AuthTokenKind,
	now = new Date(),
): Promise<{ token: string; hash: string; expiresAt: Date }> {
	void userId;
	const token = randomBytes(32).toString("hex");
	const expiresAt = new Date(now.getTime() + tokenTtlMs(kind));
	return {
		token,
		hash: hashAuthFlowToken(token),
		expiresAt,
	};
}

// ─── Email-verification OTP (numeric code) ───────────────────────────────────
//
// A 6-digit numeric code the user types on the verification screen. The stored hash
// is a server-keyed HMAC of "email_otp:<userId>:<code>", which:
//   1. binds the userId so two users with the same 6-digit code never collide, and
//   2. is UNREPRODUCIBLE without the server secret — so the public, unauthenticated
//      /verify-email endpoint (which does hashAuthFlowToken(token) + a global
//      email_verify lookup) can never match an OTP record. A plain hash here would be
//      defeated by POSTing the literal "email_otp:<userId>:<guess>" string to that
//      endpoint, turning it into an unthrottled brute-force oracle; the HMAC closes
//      that. Only the session-scoped, rate-limited verifyEmailOtp() can redeem a code.
export const EMAIL_OTP_TTL_MINUTES = 15;
const EMAIL_OTP_TTL_MS = EMAIL_OTP_TTL_MINUTES * 60_000;
const EMAIL_OTP_DIGITS = 6;

function hashEmailOtp(userId: string, code: string): string {
	return createHmac("sha256", serverConfig.jwtSecret).update(`email_otp:${userId}:${code}`).digest("hex");
}

/** Mint a fresh numeric email-verification OTP for a user (crypto-random, unbiased). */
export function mintEmailOtp(userId: string, now = new Date()): { code: string; hash: string; expiresAt: Date } {
	const code = String(randomInt(0, 10 ** EMAIL_OTP_DIGITS)).padStart(EMAIL_OTP_DIGITS, "0");
	return { code, hash: hashEmailOtp(userId, code), expiresAt: new Date(now.getTime() + EMAIL_OTP_TTL_MS) };
}

/**
 * Redeem a numeric email-verification OTP for THIS user. The lookup is scoped to
 * the user's own outstanding email_verify tokens (never a global hash search), so a
 * caller can only ever attempt codes for the account whose session they hold.
 * Consumes the code on success; otherwise returns a failure reason.
 */
/**
 * Identifier of the user's freshest still-redeemable email OTP, or "none". The
 * verify-otp brute-force budget is keyed to this so each newly issued code
 * (register / resend mints a new generation) starts with a fresh attempt
 * allowance — otherwise a user who exhausted their guesses could not use a
 * just-resent code until the rate-limit window expired.
 */
/**
 * The user's single newest still-redeemable email OTP, or undefined. "Newest" is the maximum
 * in the total order (createdAt, then id) — a TOTAL order so the choice is deterministic even
 * for two codes minted in the same millisecond. This is the ONLY code verifyEmailOtp accepts,
 * and the id `currentEmailOtpGeneration` keys the brute-force budget to, so the two always
 * agree on which code is live.
 */
function newestLiveEmailOtp(records: AuthFlowTokenRecord[], now: Date): AuthFlowTokenRecord | undefined {
	return records
		.filter((record) => record.kind === "email_verify" && !record.usedAt && new Date(record.expiresAt).getTime() > now.getTime())
		.sort((a, b) => (a.createdAt !== b.createdAt ? b.createdAt.localeCompare(a.createdAt) : b.id.localeCompare(a.id)))[0];
}

export async function currentEmailOtpGeneration(userId: string, now = new Date()): Promise<string> {
	const records = await authFlowTokenStore.listForUser(userId, { limit: 20 });
	return newestLiveEmailOtp(records, now)?.id ?? "none";
}

export async function verifyEmailOtp(
	userId: string,
	code: string,
	now = new Date(),
): Promise<{ ok: true } | { ok: false; reason: AuthTokenFailureReason }> {
	const expectedHash = hashEmailOtp(userId, code);
	const records = await authFlowTokenStore.listForUser(userId, { limit: 20 });
	// Only the NEWEST live code is redeemable. Older still-live codes (e.g. from an earlier
	// resend) are intentionally NOT accepted, so an attacker cannot grow a pool of
	// simultaneously-guessable codes by resending — and we achieve that WITHOUT ever marking
	// older codes used, which would race with a concurrent resend's in-flight email and could
	// kill a code the user is about to receive. Nothing is mutated except the matched code on
	// success, so there is no concurrency hazard at all.
	const newest = newestLiveEmailOtp(records, now);
	if (!newest) {
		// No live code: report `expired` if the submitted code matches a now-expired token,
		// else `not_found` — matching the previous failure-reason contract for callers.
		const hadMatch = records.some((record) => record.kind === "email_verify" && record.tokenHash === expectedHash);
		return { ok: false, reason: hadMatch ? "expired" : "not_found" };
	}
	// A submitted code that isn't the newest live one (wrong guess, or a superseded older code)
	// is rejected without consuming the live code.
	if (newest.tokenHash !== expectedHash) return { ok: false, reason: "not_found" };
	const consumed = await consumeUnusedToken(newest);
	if (!consumed) return { ok: false, reason: "used" };
	return { ok: true };
}

// Process-monotonic clock for token createdAt. Date has only millisecond resolution, so two
// codes minted in the same wall-clock ms (a double-click / parallel resend, or a fast local
// mailer) would tie on createdAt and verifyEmailOtp's "newest live code" pick would fall to
// an arbitrary uuid — possibly rejecting the genuinely-latest delivered code. Stamping each
// stored token with a strictly-increasing createdAt makes the order chronology-preserving, so
// the newest selection is always the last one stored (= last delivered). It only ever nudges
// a tie forward by a millisecond; expiry uses the independent expiresAt, not this value.
let lastCreatedAtMs = 0;
function nextMonotonicCreatedAtIso(now: Date): string {
	const ms = now.getTime();
	lastCreatedAtMs = ms > lastCreatedAtMs ? ms : lastCreatedAtMs + 1;
	return new Date(lastCreatedAtMs).toISOString();
}

export async function storeMintedToken(input: {
	userId: string;
	kind: AuthTokenKind;
	tokenHash: string;
	expiresAt: Date;
	ipAddress?: string | null;
	userAgent?: string | null;
	now?: Date;
}): Promise<AuthFlowTokenRecord> {
	const now = input.now ?? new Date();
	const record: AuthFlowTokenRecord = {
		id: uuid(),
		tokenHash: input.tokenHash,
		userId: input.userId,
		kind: input.kind,
		expiresAt: input.expiresAt.toISOString(),
		usedAt: null,
		ipAddress: input.ipAddress ?? null,
		userAgent: input.kind === "password_reset" ? input.userAgent ?? null : null,
		// An explicit `now` (tests pinning a specific time) is honoured verbatim; the
		// real-time path gets the monotonic stamp so concurrent resends never tie.
		createdAt: input.now ? now.toISOString() : nextMonotonicCreatedAtIso(now),
	};
	await authFlowTokenStore.create(record);
	return record;
}

export async function verifyToken(
	token: string,
	kind: AuthTokenKind,
): Promise<{ valid: boolean; userId: string | null; reason?: AuthTokenFailureReason }> {
	const result = await verifyTokenRecord(token, kind);
	if (result.valid) {
		return {
			valid: true,
			userId: result.record.userId,
		};
	}
	return {
		valid: false,
		userId: result.record?.userId ?? null,
		reason: result.reason,
	};
}

export async function verifyTokenRecord(
	token: string,
	kind: AuthTokenKind,
	now = new Date(),
): Promise<{ valid: true; record: AuthFlowTokenRecord } | { valid: false; record: AuthFlowTokenRecord | null; reason: AuthTokenFailureReason }> {
	if (!token.trim()) return { valid: false, record: null, reason: "not_found" };
	const record = await authFlowTokenStore.findByTokenHash(kind, hashAuthFlowToken(token));
	if (!record) return { valid: false, record: null, reason: "not_found" };
	if (record.usedAt) return { valid: false, record, reason: "used" };
	if (new Date(record.expiresAt).getTime() <= now.getTime()) {
		return { valid: false, record, reason: "expired" };
	}
	return { valid: true, record };
}

export async function markUsed(tokenHash: string): Promise<boolean> {
	return authFlowTokenStore.markUsed(tokenHash, new Date().toISOString());
}

export async function consumeUnusedToken(record: AuthFlowTokenRecord): Promise<boolean> {
	return authFlowTokenStore.consumeUnused(record.kind, record.id, new Date().toISOString());
}

/**
 * Invalidate every still-unused token of a given kind for a user.
 * Used after a successful password reset so any other outstanding reset
 * links (e.g. from a duplicate "forgot password" request) can no longer
 * be redeemed to overwrite the freshly recovered password.
 */
export async function invalidateUnusedTokensForUser(
	kind: AuthTokenKind,
	userId: string,
	now = new Date(),
): Promise<number> {
	return authFlowTokenStore.invalidateUnusedForUser(kind, userId, now.toISOString());
}

export async function cleanupExpired(): Promise<{ deleted: number }> {
	return authFlowTokenStore.cleanupExpired(new Date().toISOString());
}

export async function auditAuthEvent(input: {
	userId: string;
	action: string;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	const event: AuthAuditEvent = {
		id: uuid(),
		userId: input.userId,
		action: input.action,
		metadata: input.metadata ?? {},
		createdAt: new Date().toISOString(),
	};
	if (authFlowTokenStore instanceof FileAuthFlowTokenStore) {
		await authFlowTokenStore.appendAudit(event);
	}
	console.info("[auth:audit]", event);
}

function tokenTtlMs(kind: AuthTokenKind): number {
	return kind === "password_reset" ? 60 * 60_000 : 24 * 60 * 60_000;
}

export function hashAuthFlowToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function tableForKind(kind: AuthTokenKind): "password_resets" | "email_verification_tokens" {
	return kind === "password_reset" ? "password_resets" : "email_verification_tokens";
}

function mapTokenRow(row: AuthFlowTokenRow, kind: AuthTokenKind): AuthFlowTokenRecord {
	return {
		id: row.id,
		tokenHash: row.token_hash,
		userId: row.user_id,
		kind,
		expiresAt: toIso(row.expires_at),
		usedAt: row.used_at ? toIso(row.used_at) : null,
		ipAddress: row.ip_address ?? null,
		userAgent: row.user_agent ?? null,
		createdAt: toIso(row.created_at),
	};
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isAuthFlowTokenRecord(value: unknown): value is AuthFlowTokenRecord {
	const record = value as Partial<AuthFlowTokenRecord>;
	return Boolean(
		record
		&& typeof record.id === "string"
		&& typeof record.tokenHash === "string"
		&& typeof record.userId === "string"
		&& (record.kind === "password_reset" || record.kind === "email_verify")
		&& typeof record.expiresAt === "string"
		&& typeof record.createdAt === "string",
	);
}

function isAuthAuditEvent(value: unknown): value is AuthAuditEvent {
	const event = value as Partial<AuthAuditEvent>;
	return Boolean(
		event
		&& typeof event.id === "string"
		&& typeof event.userId === "string"
		&& typeof event.action === "string"
		&& typeof event.createdAt === "string",
	);
}
