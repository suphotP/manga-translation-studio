import { getSharedBunSql } from "../services/sql-pool.js";
import { RedisClient } from "bun";
import type { Context } from "hono";
import { normalizeEmail } from "../services/auth-users.js";

export interface AccountLockoutRedisClient {
	send(command: string, args: string[]): Promise<unknown>;
}

export interface AccountLockoutSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

export interface AccountLockoutOptions {
	redisClient?: AccountLockoutRedisClient;
	sqlClient?: AccountLockoutSqlClient;
	now?: () => number;
	failureLimit?: number;
	failureWindowMs?: number;
	lockDurationMs?: number;
}

export interface AccountLockoutState {
	locked: boolean;
	retryAfterSeconds: number;
	lockUntil?: number;
}

const DEFAULT_FAILURE_LIMIT = 5;
const DEFAULT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_DURATION_MS = 30 * 60 * 1000;
const LOCK_MEMBER = "lock";

export class AccountLockoutTracker {
	private readonly redisClient?: AccountLockoutRedisClient;
	private readonly sqlClient?: AccountLockoutSqlClient;
	private readonly now: () => number;
	private readonly failureLimit: number;
	private readonly failureWindowMs: number;
	private readonly lockDurationMs: number;

	constructor(options: AccountLockoutOptions = {}) {
		this.redisClient = options.redisClient ?? createRedisClient();
		this.sqlClient = options.sqlClient ?? createSqlClient();
		this.now = options.now ?? Date.now;
		this.failureLimit = options.failureLimit ?? DEFAULT_FAILURE_LIMIT;
		this.failureWindowMs = options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
		this.lockDurationMs = options.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;
	}

	async check(email: string): Promise<AccountLockoutState> {
		const normalizedEmail = normalizeEmail(email);
		try {
			if (this.redisClient) return await this.checkRedis(normalizedEmail);
		} catch {
			// Redis is an optimization; DB fallback keeps auth fail-closed enough
			// to preserve brute-force protection during Redis outages.
		}
		return this.checkDb(normalizedEmail);
	}

	async recordFailure(email: string, ip?: string): Promise<AccountLockoutState> {
		const normalizedEmail = normalizeEmail(email);
		try {
			if (this.redisClient) {
				// Mirror the failure into the durable DB log so a later Redis outage
				// still sees the accumulated failures/lock via checkDb().
				await this.mirrorFailureToDb(normalizedEmail, ip);
				return await this.recordRedisFailure(normalizedEmail);
			}
		} catch {
			// Fall through to the durable DB fallback.
		}
		return this.recordDbFailure(normalizedEmail, ip);
	}

	async clear(email: string): Promise<void> {
		const normalizedEmail = normalizeEmail(email);
		try {
			await this.redisClient?.send("DEL", [this.redisKey(normalizedEmail)]);
		} catch {
			// Clearing Redis is best-effort; DB cleanup below is the fallback truth.
		}
		if (this.sqlClient) {
			await this.sqlClient.unsafe("DELETE FROM auth_login_failures WHERE email = $1", [normalizedEmail]);
		}
	}

	private async checkRedis(email: string): Promise<AccountLockoutState> {
		const now = this.now();
		const key = this.redisKey(email);
		await this.trimRedisFailures(key, now);
		const lockUntil = Number(await this.redisClient!.send("ZSCORE", [key, LOCK_MEMBER]));
		if (Number.isFinite(lockUntil) && lockUntil > now) return lockedState(lockUntil, now);
		return { locked: false, retryAfterSeconds: 0 };
	}

	private async recordRedisFailure(email: string): Promise<AccountLockoutState> {
		const now = this.now();
		const key = this.redisKey(email);
		await this.trimRedisFailures(key, now);
		await this.redisClient!.send("ZADD", [key, String(now), `fail:${now}:${crypto.randomUUID()}`]);
		const failures = await this.redisClient!.send("ZRANGEBYSCORE", [key, String(now - this.failureWindowMs), String(now)]);
		const count = Array.isArray(failures)
			? failures.filter((member) => typeof member === "string" && member.startsWith("fail:")).length
			: 0;
		if (count >= this.failureLimit) {
			const lockUntil = now + this.lockDurationMs;
			await this.redisClient!.send("ZADD", [key, String(lockUntil), LOCK_MEMBER]);
			await this.redisClient!.send("PEXPIRE", [key, String(this.failureWindowMs + this.lockDurationMs)]);
			return lockedState(lockUntil, now);
		}
		await this.redisClient!.send("PEXPIRE", [key, String(this.failureWindowMs + this.lockDurationMs)]);
		return { locked: false, retryAfterSeconds: 0 };
	}

	private async trimRedisFailures(key: string, now: number): Promise<void> {
		await this.redisClient!.send("ZREMRANGEBYSCORE", [key, "0", String(now - this.failureWindowMs)]);
	}

	private async checkDb(email: string): Promise<AccountLockoutState> {
		if (!this.sqlClient) return { locked: false, retryAfterSeconds: 0 };
		const now = this.now();
		await this.trimDbFailures(now);
		const failures = await this.loadDbFailures(email, now);
		return lockStateFromFailures(failures, now, this.failureLimit, this.failureWindowMs, this.lockDurationMs);
	}

	private async mirrorFailureToDb(email: string, ip?: string): Promise<void> {
		if (!this.sqlClient) return;
		try {
			const now = this.now();
			await this.sqlClient.unsafe(`
				INSERT INTO auth_login_failures (email, ip, failure_at)
				VALUES ($1, $2, to_timestamp($3 / 1000.0))
			`, [email, ip ?? null, now]);
			await this.trimDbFailures(now);
		} catch {
			// Best-effort durability mirror; Redis remains the authoritative path
			// while it is healthy, so a DB hiccup must not break login tracking.
		}
	}

	private async recordDbFailure(email: string, ip?: string): Promise<AccountLockoutState> {
		if (!this.sqlClient) return { locked: false, retryAfterSeconds: 0 };
		const now = this.now();
		await this.sqlClient.unsafe(`
			INSERT INTO auth_login_failures (email, ip, failure_at)
			VALUES ($1, $2, to_timestamp($3 / 1000.0))
		`, [email, ip ?? null, now]);
		await this.trimDbFailures(now);
		const failures = await this.loadDbFailures(email, now);
		return lockStateFromFailures(failures, now, this.failureLimit, this.failureWindowMs, this.lockDurationMs);
	}

	private async loadDbFailures(email: string, now: number): Promise<number[]> {
		const rows = await this.sqlClient!.unsafe<{ failure_at: Date | string }>(`
			SELECT failure_at
			FROM auth_login_failures
			WHERE email = $1
				AND failure_at >= to_timestamp($2 / 1000.0)
			ORDER BY failure_at ASC
		`, [email, now - this.failureWindowMs - this.lockDurationMs]);
		return rows.map((row) => new Date(row.failure_at).getTime()).filter(Number.isFinite);
	}

	private async trimDbFailures(now: number): Promise<void> {
		await this.sqlClient!.unsafe(`
			DELETE FROM auth_login_failures
			WHERE failure_at < to_timestamp($1 / 1000.0)
		`, [now - this.failureWindowMs - this.lockDurationMs]);
	}

	private redisKey(email: string): string {
		return `auth:fails:${email}`;
	}
}

export let accountLockoutTracker = new AccountLockoutTracker();

export function setAccountLockoutTrackerForTests(tracker: AccountLockoutTracker): void {
	if (process.env.NODE_ENV !== "test" && process.env.BUN_ENV !== "test") {
		throw new Error("setAccountLockoutTrackerForTests is only available in tests");
	}
	accountLockoutTracker = tracker;
}

export function accountLockoutResponse(c: Context, state: AccountLockoutState): Response {
	const retryAfter = Math.max(1, state.retryAfterSeconds);
	return c.json(
		{ error: "Account temporarily locked", code: "account_locked", retryAfterSeconds: retryAfter },
		429,
		{ "Retry-After": String(retryAfter) },
	);
}

function lockStateFromFailures(
	failures: number[],
	now: number,
	failureLimit: number,
	failureWindowMs: number,
	lockDurationMs: number,
): AccountLockoutState {
	for (let start = 0; start <= failures.length - failureLimit; start += 1) {
		const lockedAt = failures[start + failureLimit - 1]!;
		if (lockedAt - failures[start]! <= failureWindowMs) {
			const lockUntil = lockedAt + lockDurationMs;
			if (lockUntil > now) return lockedState(lockUntil, now);
		}
	}
	return { locked: false, retryAfterSeconds: 0 };
}

function lockedState(lockUntil: number, now: number): AccountLockoutState {
	return {
		locked: true,
		lockUntil,
		retryAfterSeconds: Math.max(1, Math.ceil((lockUntil - now) / 1000)),
	};
}

function createRedisClient(): AccountLockoutRedisClient | undefined {
	const url = process.env.REDIS_URL?.trim();
	if (!url || process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") return undefined;
	return new RedisClient(url);
}

function createSqlClient(): AccountLockoutSqlClient | undefined {
	const url = process.env.DATABASE_URL?.trim();
	if (!url) return undefined;
	return getSharedBunSql(url) as unknown as AccountLockoutSqlClient;
}
