import { afterEach, describe, expect, test } from "bun:test";
import { AccountLockoutTracker, setAccountLockoutTrackerForTests, type AccountLockoutRedisClient, type AccountLockoutSqlClient } from "../middleware/account-lockout.js";
import { auth } from "../routes/auth.js";
import { createUser } from "../services/auth.service.js";

class FakeRedis implements AccountLockoutRedisClient {
	readonly zsets = new Map<string, Map<string, number>>();

	async send(command: string, args: string[]): Promise<unknown> {
		const normalized = command.toUpperCase();
		if (normalized === "ZADD") {
			const [key, score, member] = args;
			const zset = this.zsets.get(key!) ?? new Map<string, number>();
			zset.set(member!, Number(score));
			this.zsets.set(key!, zset);
			return 1;
		}
		if (normalized === "ZCOUNT") {
			const [key, min, max] = args;
			const zset = this.zsets.get(key!) ?? new Map<string, number>();
			return [...zset.values()].filter((score) => score >= Number(min) && score <= Number(max)).length;
		}
		if (normalized === "ZRANGEBYSCORE") {
			const [key, min, max] = args;
			const zset = this.zsets.get(key!) ?? new Map<string, number>();
			return [...zset.entries()]
				.filter(([, score]) => score >= Number(min) && score <= Number(max))
				.map(([member]) => member);
		}
		if (normalized === "ZSCORE") {
			const [key, member] = args;
			return this.zsets.get(key!)?.get(member!) ?? null;
		}
		if (normalized === "ZREMRANGEBYSCORE") {
			const [key, min, max] = args;
			const zset = this.zsets.get(key!) ?? new Map<string, number>();
			let removed = 0;
			for (const [member, score] of zset) {
				if (score >= Number(min) && score <= Number(max)) {
					zset.delete(member);
					removed += 1;
				}
			}
			return removed;
		}
		if (normalized === "PEXPIRE") return 1;
		if (normalized === "DEL") {
			return this.zsets.delete(args[0]!) ? 1 : 0;
		}
		throw new Error(`Unsupported Redis command ${command}`);
	}
}

class FailingRedis implements AccountLockoutRedisClient {
	async send(): Promise<unknown> {
		throw new Error("redis unavailable");
	}
}

class FakeSql implements AccountLockoutSqlClient {
	readonly rows: Array<{ email: string; ip?: string; failureAt: number }> = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		if (query.includes("INSERT INTO auth_login_failures")) {
			this.rows.push({ email: String(params[0]), ip: params[1] ? String(params[1]) : undefined, failureAt: Number(params[2]) });
			return [] as T[];
		}
		if (query.includes("DELETE FROM auth_login_failures WHERE email")) {
			const email = String(params[0]);
			for (let index = this.rows.length - 1; index >= 0; index -= 1) {
				if (this.rows[index]!.email === email) this.rows.splice(index, 1);
			}
			return [] as T[];
		}
		if (query.includes("DELETE FROM auth_login_failures")) {
			const cutoff = Number(params[0]);
			for (let index = this.rows.length - 1; index >= 0; index -= 1) {
				if (this.rows[index]!.failureAt < cutoff) this.rows.splice(index, 1);
			}
			return [] as T[];
		}
		if (query.includes("SELECT failure_at")) {
			const email = String(params[0]);
			const cutoff = Number(params[1]);
			return this.rows
				.filter((row) => row.email === email && row.failureAt >= cutoff)
				.sort((left, right) => left.failureAt - right.failureAt)
				.map((row) => ({ failure_at: new Date(row.failureAt).toISOString() })) as T[];
		}
		throw new Error(`Unsupported SQL query ${query}`);
	}
}

describe("account lockout", () => {
	afterEach(() => {
		process.env.NODE_ENV = "test";
		setAccountLockoutTrackerForTests(new AccountLockoutTracker());
	});

	test("5 Redis-backed failures in 15 minutes trigger lock, 6th is rejected, and 30 minute lock clears", async () => {
		let now = 1_000_000;
		const tracker = new AccountLockoutTracker({
			redisClient: new FakeRedis(),
			now: () => now,
		});

		for (let attempt = 1; attempt <= 4; attempt += 1) {
			expect((await tracker.recordFailure("USER@example.com")).locked).toBe(false);
			now += 60_000;
		}

		const fifth = await tracker.recordFailure("user@example.com");
		expect(fifth.locked).toBe(true);
		expect(fifth.retryAfterSeconds).toBe(1800);

		now += 1_000;
		const sixth = await tracker.check("user@example.com");
		expect(sixth.locked).toBe(true);
		expect(sixth.retryAfterSeconds).toBe(1799);

		now = fifth.lockUntil!;
		expect(await tracker.check("user@example.com")).toEqual({ locked: false, retryAfterSeconds: 0 });
	});

	test("expired Redis lock marker is not counted as a login failure", async () => {
		let now = 10_000_000;
		const redis = new FakeRedis();
		const tracker = new AccountLockoutTracker({
			redisClient: redis,
			now: () => now,
		});

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			await tracker.recordFailure("marker@example.com");
			now += 60_000;
		}

		const lockUntil = 10_000_000 + (4 * 60_000) + (30 * 60_000);
		now = lockUntil + 1;
		expect(await tracker.check("marker@example.com")).toEqual({ locked: false, retryAfterSeconds: 0 });

		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const state = await tracker.recordFailure("marker@example.com");
			expect(state.locked).toBe(false);
			now += 60_000;
		}
		expect(await tracker.recordFailure("marker@example.com")).toEqual(expect.objectContaining({ locked: true }));
	});

	test("falls back to DB failures when Redis is down", async () => {
		let now = 2_000_000;
		const sql = new FakeSql();
		const tracker = new AccountLockoutTracker({
			redisClient: new FailingRedis(),
			sqlClient: sql,
			now: () => now,
		});

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			await tracker.recordFailure("fallback@example.com", "203.0.113.7");
			now += 30_000;
		}

		const state = await tracker.check("fallback@example.com");
		expect(state.locked).toBe(true);
		expect(sql.rows.every((row) => row.ip === "203.0.113.7")).toBe(true);
	});

	test("Redis-backed lockout survives a Redis outage via the DB mirror", async () => {
		let now = 7_000_000;
		const redis = new FakeRedis();
		const sql = new FakeSql();
		const tracker = new AccountLockoutTracker({
			redisClient: redis,
			sqlClient: sql,
			now: () => now,
		});

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			await tracker.recordFailure("outage@example.com", "203.0.113.9");
			now += 60_000;
		}

		// Redis confirms the lock while it is healthy.
		expect((await tracker.check("outage@example.com")).locked).toBe(true);
		// Every failure was mirrored to the durable DB log.
		expect(sql.rows.filter((row) => row.email === "outage@example.com").length).toBe(5);

		// Redis goes down: check() must still honor the lock via the DB fallback.
		const offlineTracker = new AccountLockoutTracker({
			redisClient: new FailingRedis(),
			sqlClient: sql,
			now: () => now,
		});
		const fallbackState = await offlineTracker.check("outage@example.com");
		expect(fallbackState.locked).toBe(true);
	});

	test("POST /login returns 429 with Retry-After after 5 failed attempts", async () => {
		process.env.NODE_ENV = "test";
		let now = 5_000_000;
		setAccountLockoutTrackerForTests(new AccountLockoutTracker({
			redisClient: new FakeRedis(),
			now: () => now,
		}));
		const email = `lock-route-${crypto.randomUUID()}@example.com`;
		await createUser({ email, password: "StrongP@ss123", name: "Lock Route User" });

		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const response = await auth.request("/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password: "WrongP@ss123" }),
			});
			expect(response.status).toBe(401);
			now += 60_000;
		}

		const fifth = await auth.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "WrongP@ss123" }),
		});
		expect(fifth.status).toBe(429);
		expect(fifth.headers.get("Retry-After")).toBe("1800");
		const body = await fifth.json() as { code: string };
		expect(body.code).toBe("account_locked");

		now += 1_000;
		const sixth = await auth.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "StrongP@ss123" }),
		});
		expect(sixth.status).toBe(429);
		expect(sixth.headers.get("Retry-After")).toBe("1799");
	});
});
