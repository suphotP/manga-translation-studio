// Authentication system tests

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { hashPassword, comparePassword, dummyPasswordCompare, validatePassword, generateTokens, verifyAccessToken, verifyRefreshToken, revokeRefreshToken, createUser, findUserByEmail, findUserByExternalIdentity, linkExternalIdentity, updateUser, changePassword, deleteUser, listUsers, loadUser, resetPasswordForUser, consumeRefreshSessionForRotation, isSessionActive, findRefreshSession, generateAccessToken } from "../services/auth.service.js";
import { USERS_DIR } from "../config.js";
import { randomUUID } from "crypto";
import { auth } from "../routes/auth.js";
import { gdprStore } from "../services/gdpr.js";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { RedisAuthSessionStore, FileAuthSessionStore, MAX_ACTIVE_SESSIONS_PER_USER, type AuthSessionRecord } from "../services/auth-sessions.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

const testRunId = randomUUID();

class FakeRedisAuthSessionClient {
	readonly values = new Map<string, string>();
	readonly sets = new Map<string, Set<string>>();
	readonly ttls = new Map<string, number>();
	readonly evalCalls: string[][] = [];
	readonly commands: { command: string; args: string[] }[] = [];

	async send(command: string, args: string[]): Promise<unknown> {
		this.commands.push({ command: command.toUpperCase(), args });
		switch (command.toUpperCase()) {
			case "SET": {
				const [key, value, mode, ttl] = args;
				this.values.set(key, value);
				if (mode === "EX") this.ttls.set(key, Number(ttl));
				return "OK";
			}
			case "GET":
				return this.values.get(args[0]) ?? null;
			case "SADD": {
				const [key, member] = args;
				const set = this.sets.get(key) ?? new Set<string>();
				const sizeBefore = set.size;
				set.add(member);
				this.sets.set(key, set);
				return set.size > sizeBefore ? 1 : 0;
			}
			case "EVAL": {
				const [script, keyCount, key, member, ttl] = args;
				if (keyCount !== "1") throw new Error(`Unsupported fake Redis EVAL key count: ${keyCount}`);
				this.evalCalls.push(args);
				// Atomic single-use consume script: GET the session value, DEL it, and
				// return the raw value only if it existed and was not revoked.
				if (script.includes("SADD") === false && script.includes('"revokedAt"')) {
					const raw = this.values.get(key) ?? null;
					if (raw == null) return false;
					this.values.delete(key);
					this.ttls.delete(key);
					if (raw.includes('"revokedAt"')) return false;
					return raw;
				}
				// Otherwise: add-user-session-index script (SADD member + extend TTL).
				const set = this.sets.get(key) ?? new Set<string>();
				const sizeBefore = set.size;
				set.add(member);
				this.sets.set(key, set);
				const requestedTtl = Number(ttl);
				const currentTtl = this.redisTtl(key);
				if (!Number.isFinite(currentTtl) || currentTtl < 0 || currentTtl < requestedTtl) {
					this.ttls.set(key, requestedTtl);
				}
				return set.size > sizeBefore ? 1 : 0;
			}
			case "SMEMBERS":
				return [...(this.sets.get(args[0]) ?? new Set<string>())];
			case "SREM": {
				const [key, member] = args;
				const set = this.sets.get(key);
				return set?.delete(member) ? 1 : 0;
			}
			case "DEL": {
				let deleted = 0;
				for (const key of args) {
					const valueDeleted = this.values.delete(key);
					const setDeleted = this.sets.delete(key);
					const ttlDeleted = this.ttls.delete(key);
					if (valueDeleted || setDeleted || ttlDeleted) {
						deleted++;
					}
				}
				return deleted;
			}
			case "TTL": {
				return this.redisTtl(args[0]);
			}
			case "EXPIRE":
				this.ttls.set(args[0], Number(args[1]));
				return 1;
			default:
				throw new Error(`Unsupported fake Redis command: ${command}`);
		}
	}

	ttlFor(key: string): number | undefined {
		return this.ttls.get(key);
	}

	private redisTtl(key: string): number {
		if (!this.values.has(key) && !this.sets.has(key)) return -2;
		return this.ttls.get(key) ?? -1;
	}
}

describe("Password Utilities", () => {
	it("should hash a password", async () => {
		const password = "TestPassword123!";
		const hash = await hashPassword(password);
		expect(hash).toBeDefined();
		expect(hash).not.toBe(password);
		expect(hash.length).toBeGreaterThan(50);
	});

	it("should compare correct password", async () => {
		const password = "TestPassword123!";
		const hash = await hashPassword(password);
		const isValid = await comparePassword(password, hash);
		expect(isValid).toBe(true);
	});

	it("should reject incorrect password", async () => {
		const password = "TestPassword123!";
		const wrongPassword = "WrongPassword123!";
		const hash = await hashPassword(password);
		const isValid = await comparePassword(wrongPassword, hash);
		expect(isValid).toBe(false);
	});

	it("should validate strong password", () => {
		const result = validatePassword("StrongP@ss123");
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("should reject weak password", () => {
		const result = validatePassword("weak");
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("should validate password with all requirements", () => {
		// Test that our validation works correctly with default requirements
		const result = validatePassword("StrongP@ss123");
		expect(result.valid).toBe(true);
	});

	it("should reject password without special character", () => {
		const result = validatePassword("StrongPass123");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Password must contain at least one special character");
	});

	it("returns stable per-rule codes + minLength alongside errors", () => {
		// A short, lowercase-only password trips several rules. The codes are the
		// stable contract the frontend maps to localized copy.
		const result = validatePassword("abc");
		expect(result.valid).toBe(false);
		expect(result.codes).toContain("password_min_length");
		expect(result.codes).toContain("password_require_special");
		expect(result.codes.length).toBe(result.errors.length);
		expect(typeof result.minLength).toBe("number");
		expect(result.minLength).toBeGreaterThan(0);
		// The special-character rule code corresponds to its English error.
		expect(result.codes).toContain("password_require_number");
	});

	it("emits no codes for a fully valid password", () => {
		const result = validatePassword("StrongP@ss123");
		expect(result.valid).toBe(true);
		expect(result.codes).toEqual([]);
	});

	it("dummyPasswordCompare always fails but spends real bcrypt time (timing equalization)", async () => {
		// The login route runs this for unknown emails so the response time matches the
		// known-user path, preventing a user-enumeration timing oracle.
		const realHash = await hashPassword("StrongP@ss123");

		const realStart = performance.now();
		await comparePassword("StrongP@ss123", realHash);
		const realMs = performance.now() - realStart;

		const dummyStart = performance.now();
		const result = await dummyPasswordCompare("StrongP@ss123");
		const dummyMs = performance.now() - dummyStart;

		expect(result).toBe(false);
		// Both run bcrypt at the same cost factor, so the dummy path is not trivially
		// faster than a genuine comparison (no <1ms fast-path leak).
		expect(dummyMs).toBeGreaterThan(realMs * 0.25);
	});
});

describe("Login timing equalization", () => {
	const timingRunId = randomUUID();

	afterEach(async () => {
		for (const user of await listUsers()) {
			if (user.email.startsWith(`timing-${timingRunId}-`)) {
				await deleteUser(user.id);
			}
		}
	});

	it("login spends bcrypt time for an unknown email instead of a sub-millisecond 401", async () => {
		const password = "StrongP@ss123";
		// Establish the cost of the known-but-wrong-password path as a baseline.
		const email = `timing-${timingRunId}-known@example.com`;
		await createUser({ email, password, name: "Timing User" });

		const knownStart = performance.now();
		const knownResp = await auth.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "WrongP@ss123" }),
		});
		const knownMs = performance.now() - knownStart;
		expect(knownResp.status).toBe(401);

		const unknownStart = performance.now();
		const unknownResp = await auth.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: `timing-${timingRunId}-nobody@example.com`, password }),
		});
		const unknownMs = performance.now() - unknownStart;
		expect(unknownResp.status).toBe(401);

		// The unknown-email path must not be a near-instant fast path; it should stay
		// within the same order of magnitude as the bcrypt-backed known path.
		expect(unknownMs).toBeGreaterThan(knownMs * 0.25);
	});
});

describe("JWT Token Utilities", () => {
	it("should generate access and refresh tokens", async () => {
		const user = {
			id: "user-123",
			email: "test@example.com",
			role: "editor" as const,
			passwordHash: "hash",
			name: "Test User",
			createdAt: "2024-01-01",
			updatedAt: "2024-01-01",
			isActive: true,
		};

		const tokens = await generateTokens(user);
		expect(tokens.accessToken).toBeDefined();
		expect(tokens.refreshToken).toBeDefined();
		expect(tokens.accessToken.length).toBeGreaterThan(20);
		expect(tokens.refreshToken.length).toBeGreaterThan(20);
	});

	it("should verify valid access token", async () => {
		const user = {
			id: "user-123",
			email: "test@example.com",
			role: "admin" as const,
			passwordHash: "hash",
			name: "Test User",
			createdAt: "2024-01-01",
			updatedAt: "2024-01-01",
			isActive: true,
		};

		const tokens = await generateTokens(user);
		const payload = verifyAccessToken(tokens.accessToken);
		expect(payload).toBeDefined();
		expect(payload?.userId).toBe(user.id);
		expect(payload?.email).toBe(user.email);
		expect(payload?.role).toBe(user.role);
	});

	it("should reject invalid access token", () => {
		const payload = verifyAccessToken("invalid-token");
		expect(payload).toBeNull();
	});

	it("should verify valid refresh token", async () => {
		const user = {
			id: "user-123",
			email: "test@example.com",
			role: "editor" as const,
			passwordHash: "hash",
			name: "Test User",
			createdAt: "2024-01-01",
			updatedAt: "2024-01-01",
			isActive: true,
		};

		const tokens = await generateTokens(user);
		const userId = await verifyRefreshToken(tokens.refreshToken);
		expect(userId).toBe(user.id);
	});

	it("should reject invalid refresh token", async () => {
		const userId = await verifyRefreshToken("invalid-token");
		expect(userId).toBeNull();
	});

	it("should revoke refresh token", async () => {
		const user = {
			id: "user-123",
			email: "test@example.com",
			role: "editor" as const,
			passwordHash: "hash",
			name: "Test User",
			createdAt: "2024-01-01",
			updatedAt: "2024-01-01",
			isActive: true,
		};

		const tokens = await generateTokens(user);
		await revokeRefreshToken(tokens.refreshToken);
		const userId = await verifyRefreshToken(tokens.refreshToken);
		expect(userId).toBeNull();
	});

	it("keeps Redis revoke-all session index TTL at least as long as the longest active session", async () => {
		const client = new FakeRedisAuthSessionClient();
		const store = new RedisAuthSessionStore(undefined, "auth-test", client);
		const now = Date.now();
		const userId = "user-ttl-index";
		const longSession: AuthSessionRecord = {
			sessionId: "session-long",
			userId,
			tokenHash: "hash-long",
			createdAt: now,
			expiresAt: now + 3_600_000,
		};
		const shortSession: AuthSessionRecord = {
			sessionId: "session-short",
			userId,
			tokenHash: "hash-short",
			createdAt: now + 1_000,
			expiresAt: now + 60_000,
		};

		await store.create(longSession);
		const longIndexTtl = client.ttlFor(`auth-test:user:${userId}`);
		await store.create(shortSession);

		expect(longIndexTtl).toBeGreaterThanOrEqual(3_500);
		expect(client.ttlFor(`auth-test:user:${userId}`)).toBe(longIndexTtl);
		expect(client.evalCalls).toHaveLength(2);

		await store.revokeUserSessions(userId);
		expect(await store.findByTokenHash(longSession.tokenHash, now)).toBeNull();
		expect(await store.findByTokenHash(shortSession.tokenHash, now)).toBeNull();
	});
});

describe("Auth session sid index (O(1) lookup, P1 perf/DoS)", () => {
	const now = Date.now();

	function makeRecord(userId: string, sessionId: string, tokenHash: string, overrides: Partial<AuthSessionRecord> = {}): AuthSessionRecord {
		return {
			sessionId,
			userId,
			tokenHash,
			createdAt: now,
			expiresAt: now + 3_600_000,
			metadata: { lastActiveAt: now },
			...overrides,
		};
	}

	it("Redis findBySessionId is O(1): it does NOT SMEMBERS-scan the user's session set", async () => {
		const client = new FakeRedisAuthSessionClient();
		const store = new RedisAuthSessionStore(undefined, "auth-sid", client);
		const userId = "user-many-sessions";
		// Seed several sessions for the same user; a scanning lookup would grow with N.
		for (let i = 0; i < 8; i++) {
			await store.create(makeRecord(userId, `session-${i}`, `hash-${i}`));
		}

		client.commands.length = 0;
		const found = await store.findBySessionId(userId, "session-5", now);

		expect(found?.tokenHash).toBe("hash-5");
		// The whole point of the fix: no per-user fan-out on a protected-request lookup.
		expect(client.commands.some((c) => c.command === "SMEMBERS")).toBe(false);
		// And it stays O(1) regardless of how many sessions the user has: a small,
		// fixed number of round-trips (sid GET + session GET).
		const gets = client.commands.filter((c) => c.command === "GET");
		expect(gets.length).toBeLessThanOrEqual(2);
	});

	it("Redis: revoked sid is rejected by findBySessionId (security preserved)", async () => {
		const client = new FakeRedisAuthSessionClient();
		const store = new RedisAuthSessionStore(undefined, "auth-sid", client);
		await store.create(makeRecord("u1", "s1", "h1"));
		expect((await store.findBySessionId("u1", "s1", now))?.tokenHash).toBe("h1");

		await store.revokeSessionId("u1", "s1", now);
		expect(await store.findBySessionId("u1", "s1", now)).toBeNull();
		// The sid index entry must be gone too (no stale pointer left behind).
		expect(await client.send("GET", ["auth-sid:sid:u1:s1"])).toBeNull();
	});

	it("Redis: consumeForRotation clears the sid index", async () => {
		const client = new FakeRedisAuthSessionClient();
		const store = new RedisAuthSessionStore(undefined, "auth-sid", client);
		await store.create(makeRecord("u1", "s1", "h1"));

		const consumed = await store.consumeForRotation("h1", now);
		expect(consumed?.sessionId).toBe("s1");
		expect(await store.findBySessionId("u1", "s1", now)).toBeNull();
		expect(await client.send("GET", ["auth-sid:sid:u1:s1"])).toBeNull();
	});

	it("Redis: revokeUserSessions clears every sid index for the user", async () => {
		const client = new FakeRedisAuthSessionClient();
		const store = new RedisAuthSessionStore(undefined, "auth-sid", client);
		await store.create(makeRecord("u1", "s1", "h1"));
		await store.create(makeRecord("u1", "s2", "h2"));

		await store.revokeUserSessions("u1");
		expect(await client.send("GET", ["auth-sid:sid:u1:s1"])).toBeNull();
		expect(await client.send("GET", ["auth-sid:sid:u1:s2"])).toBeNull();
		expect(await store.findBySessionId("u1", "s1", now)).toBeNull();
		expect(await store.findBySessionId("u1", "s2", now)).toBeNull();
	});

	it("Redis: create prunes the oldest sessions beyond the per-user cap", async () => {
		const client = new FakeRedisAuthSessionClient();
		const store = new RedisAuthSessionStore(undefined, "auth-sid", client);
		const userId = "user-cap";
		const total = MAX_ACTIVE_SESSIONS_PER_USER + 5;
		for (let i = 0; i < total; i++) {
			// Increasing lastActiveAt so higher i == more recent.
			await store.create(makeRecord(userId, `s${i}`, `h${i}`, { metadata: { lastActiveAt: now + i } }));
		}

		const active = await store.listUserSessions(userId, now);
		expect(active.length).toBe(MAX_ACTIVE_SESSIONS_PER_USER);
		// The oldest (s0) must have been pruned; the newest must survive.
		expect(await store.findBySessionId(userId, "s0", now)).toBeNull();
		expect(await store.findBySessionId(userId, `s${total - 1}`, now)).not.toBeNull();
	});

	it("File store: findBySessionId is a direct keyed lookup and respects revocation + cap", async () => {
		const dir = mkdtempSync(join(tmpdir(), "auth-sid-file-"));
		const store = new FileAuthSessionStore(join(dir, "sessions.json"));
		await store.create(makeRecord("u1", "s1", "h1"));
		expect((await store.findBySessionId("u1", "s1", now))?.tokenHash).toBe("h1");

		await store.revokeSessionId("u1", "s1", now);
		expect(await store.findBySessionId("u1", "s1", now)).toBeNull();

		const userId = "user-cap-file";
		const total = MAX_ACTIVE_SESSIONS_PER_USER + 3;
		for (let i = 0; i < total; i++) {
			await store.create(makeRecord(userId, `s${i}`, `fh${i}`, { metadata: { lastActiveAt: now + i } }));
		}
		expect((await store.listUserSessions(userId, now)).length).toBe(MAX_ACTIVE_SESSIONS_PER_USER);
		expect(await store.findBySessionId(userId, "s0", now)).toBeNull();
		expect(await store.findBySessionId(userId, `s${total - 1}`, now)).not.toBeNull();
	});
});

describe("User Management", () => {
	let testCounter = 0;

	beforeEach(() => {
		testCounter++;
	});

	afterEach(async () => {
		for (const user of await listUsers()) {
			if (user.email.startsWith(`test-${testRunId}-`)) {
				await deleteUser(user.id);
			}
		}
	});

	// Helper to get unique test email
	function getTestEmail(testName: string) {
		return `test-${testRunId}-${testCounter}-${testName}@example.com`;
	}

	it("should create a new user", async () => {
		const userData = {
			email: getTestEmail("create"),
			password: "StrongP@ss123",
			name: "Test User",
			role: "editor" as const,
		};

		const { user } = await createUser(userData);
		expect(user.id).toBeDefined();
		expect(user.email).toBe(userData.email.toLowerCase());
		expect(user.name).toBe(userData.name);
		expect(user.role).toBe(userData.role);
		expect(user.authProvider).toBe("local");
		expect(user.emailVerified).toBe(false);
		expect(user.isActive).toBe(true);
	});

	it("should not create user with duplicate email", async () => {
		const email = getTestEmail("duplicate");
		const userData = {
			email,
			password: "StrongP@ss123",
			name: "Test User",
		};

		await createUser(userData);
		await expect(createUser(userData)).rejects.toThrow("already exists");
	});

	it("should find user by email", async () => {
		const email = getTestEmail("find");
		const userData = {
			email,
			password: "StrongP@ss123",
			name: "Test User",
		};

		await createUser(userData);
		const user = await findUserByEmail(email);
		expect(user).toBeDefined();
		expect(user?.email).toBe(email);
	});

	it("should read user files written with a UTF-8 BOM", async () => {
		const user = {
			id: `bom-${testRunId}-${testCounter}`,
			email: getTestEmail("bom"),
			role: "editor" as const,
			passwordHash: "hash",
			name: "BOM User",
			createdAt: "2026-05-13T00:00:00.000Z",
			updatedAt: "2026-05-13T00:00:00.000Z",
			isActive: true,
		};
		writeFileSync(join(USERS_DIR, `${user.id}.json`), `\uFEFF${JSON.stringify(user)}`);

		const loadedUser = await loadUser(user.id);
		expect(loadedUser?.email).toBe(user.email);
		expect(loadedUser?.authProvider).toBe("local");
		expect(loadedUser?.emailVerified).toBe(false);
		expect((await findUserByEmail(user.email))?.id).toBe(user.id);
	});

	it("can link and find an external identity for later SSO migration", async () => {
		const { user } = await createUser({
			email: getTestEmail("external-link"),
			password: "StrongP@ss123",
			name: "External User",
		});

		const linked = await linkExternalIdentity(user.id, {
			provider: "auth0",
			subject: "auth0|user-123",
			emailVerified: true,
		});

		// A password-backed (local) account keeps "local" as its primary provider
		// after linking an external identity — its password stays usable, so the
		// link-method / confirm flow must continue to treat it as local. The linked
		// identity is recorded separately and remains findable.
		expect(linked?.authProvider).toBe("local");
		expect(linked?.externalIdentities).toEqual(expect.arrayContaining([
			expect.objectContaining({ provider: "auth0", subject: "auth0|user-123" }),
		]));
		expect(linked?.emailVerified).toBe(true);
		expect((await findUserByExternalIdentity("auth0", "auth0|user-123"))?.id).toBe(user.id);
		expect(await findUserByExternalIdentity("local", "auth0|user-123")).toBeNull();
	});

	it("prevents one external identity from being linked to multiple users", async () => {
		const identity = {
			provider: "oidc" as const,
			subject: "issuer|duplicate",
		};
		const { user: firstUser } = await createUser({
			email: getTestEmail("external-first"),
			password: "StrongP@ss123",
			name: "External First",
		});
		const { user: secondUser } = await createUser({
			email: getTestEmail("external-second"),
			password: "StrongP@ss123",
			name: "External Second",
		});

		await linkExternalIdentity(firstUser.id, identity);

		await expect(linkExternalIdentity(secondUser.id, identity)).rejects.toThrow("External identity already linked");
	});

	it("should return null for non-existent email", async () => {
		const user = await findUserByEmail("nonexistent@example.com");
		expect(user).toBeNull();
	});

	it("should update user information", async () => {
		const { user } = await createUser({
			email: getTestEmail("update"),
			password: "StrongP@ss123",
			name: "Test User",
		});

		const updated = await updateUser(user.id, { name: "Updated Name" });
		expect(updated?.name).toBe("Updated Name");
	});

	it("should not update email to existing email", async () => {
		const user1Email = getTestEmail("user1");
		await createUser({
			email: user1Email,
			password: "StrongP@ss123",
			name: "User 1",
		});

		const { user: user2 } = await createUser({
			email: getTestEmail("user2"),
			password: "StrongP@ss123",
			name: "User 2",
		});

		await expect(updateUser(user2.id, { email: user1Email })).rejects.toThrow("Email already in use");
	});

	it("should change password", async () => {
		const { user } = await createUser({
			email: getTestEmail("change-pass"),
			password: "OldP@ss123",
			name: "Test User",
		});

		const success = await changePassword(user.id, {
			oldPassword: "OldP@ss123",
			newPassword: "NewP@ss123",
		});

		expect(success).toBe(true);
	});

	it("should reject incorrect old password", async () => {
		const { user } = await createUser({
			email: getTestEmail("wrong-pass"),
			password: "OriginalP@ss123",
			name: "Test User",
		});

		await expect(changePassword(user.id, {
			oldPassword: "WrongP@ss123",
			newPassword: "NewP@ss123",
		})).rejects.toThrow("incorrect");
	});

	it("should delete user", async () => {
		const email = getTestEmail("delete");
		const { user } = await createUser({
			email,
			password: "StrongP@ss123",
			name: "Test User",
		});

		const success = await deleteUser(user.id);
		expect(success).toBe(true);

		const found = await findUserByEmail(email);
		expect(found).toBeNull();
	});

	it("should list all users", async () => {
		await createUser({
			email: getTestEmail("list1"),
			password: "StrongP@ss123",
			name: "User 1",
		});

		await createUser({
			email: getTestEmail("list2"),
			password: "StrongP@ss123",
			name: "User 2",
		});

		const users = await listUsers();
		expect(users.length).toBeGreaterThanOrEqual(2);
		expect(users.every(u => !("passwordHash" in u))).toBe(true);
	});

	it("register route creates public users as editors by default", async () => {
		const email = getTestEmail("route-register-editor");
		const response = await auth.request("/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email,
				password: "StrongP@ss123",
				name: "Route User",
			}),
		});

		expect(response.status).toBe(201);
		const body = await response.json() as {
			tokens: { refreshToken?: string };
			user: { name: string; isActive: boolean; authProvider: string };
		};
		expect(body.user.email).toBe(email);
		expect(body.user.role).toBe("editor");
		expect(body.user.passwordHash).toBeUndefined();
		expect((await findUserByEmail(email))?.role).toBe("editor");
	});

	it("register route blocks public role assignment", async () => {
		const email = getTestEmail("route-register-admin");
		const response = await auth.request("/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email,
				password: "StrongP@ss123",
				name: "Route Admin",
				role: "admin",
			}),
		});

		expect(response.status).toBe(403);
		expect(await findUserByEmail(email)).toBeNull();
	});

	it("register route returns 400 for malformed JSON", async () => {
		const response = await auth.request("/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not-json",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid JSON body", code: "invalid_json" });
	});

	it("refresh route rotates refresh tokens", async () => {
		const email = getTestEmail("route-refresh");
		await createUser({
			email,
			password: "StrongP@ss123",
			name: "Refresh User",
		});
		const fullUser = await findUserByEmail(email);
		expect(fullUser).toBeDefined();
		const tokens = await generateTokens(fullUser!);

		const response = await auth.request("/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: tokens.refreshToken }),
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.tokens.refreshToken).toBeDefined();
		expect(response.headers.get("Set-Cookie")).toContain("mews_refresh=");
		expect(body.user.name).toBe("Refresh User");
		expect(body.user.isActive).toBe(true);
		expect(body.user.authProvider).toBe("local");
		expect(await verifyRefreshToken(tokens.refreshToken)).toBeNull();
	});

	it("refresh route returns 400 for malformed JSON", async () => {
		const response = await auth.request("/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not-json",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid JSON body", code: "invalid_json" });
	});

	it("auth middleware reloads active users before accepting access tokens", async () => {
		const email = getTestEmail("middleware-current-role");
		const created = await createUser({
			email,
			password: "StrongP@ss123",
			name: "Middleware User",
		});
		const fullUser = await loadUser(created.user.id);
		expect(fullUser).toBeDefined();
		const tokens = await generateTokens(fullUser!);
		await updateUser(created.user.id, { role: "viewer" });

		const app = new Hono();
		app.use("*", authMiddleware);
		app.get("/protected", (c) => c.json({ user: c.get("user") }));

		const accepted = await app.request("/protected", {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(accepted.status).toBe(200);
		expect((await accepted.json()).user.role).toBe("viewer");

		await updateUser(created.user.id, { isActive: false });
		const rejected = await app.request("/protected", {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(rejected.status).toBe(401);
	});
});

describe("Role-Based Access Control", () => {
	it("should have correct permissions for admin", () => {
		const { hasPermission } = require("../types/auth.js");
		expect(hasPermission("admin", "create:user")).toBe(true);
		expect(hasPermission("admin", "delete:user")).toBe(true);
		expect(hasPermission("admin", "manage:settings")).toBe(true);
	});

	it("should have correct permissions for editor", () => {
		const { hasPermission } = require("../types/auth.js");
		expect(hasPermission("editor", "create:project")).toBe(true);
		expect(hasPermission("editor", "update:project")).toBe(true);
		expect(hasPermission("editor", "delete:user")).toBe(false);
		expect(hasPermission("editor", "manage:settings")).toBe(false);
	});

	it("should have correct permissions for viewer", () => {
		const { hasPermission } = require("../types/auth.js");
		expect(hasPermission("viewer", "read:project")).toBe(true);
		expect(hasPermission("viewer", "create:project")).toBe(false);
		expect(hasPermission("viewer", "generate:ai")).toBe(false);
	});
});

describe("platform RBAC route guards (PATCH /users/:id)", () => {
	function rbacEmail(name: string) {
		return `rbac-${name}-${testRunId}@example.com`;
	}

	async function authedAdmin(role: "owner" | "admin") {
		const { user } = await createUser({
			email: rbacEmail(`${role}-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: `${role} actor`,
			role,
		});
		const full = await loadUser(user.id);
		const tokens = await generateTokens(full!);
		return { user, token: tokens.accessToken };
	}

	it("blocks the last owner from demoting themselves (last-owner guard)", async () => {
		const { user, token } = await authedAdmin("owner");
		const res = await auth.request(`/users/${user.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ role: "admin" }),
		});
		expect(res.status).toBe(403);
		const body = await res.json() as { reason?: string };
		expect(body.reason).toBe("admin_self_protection");
		// role unchanged in storage
		expect((await loadUser(user.id))?.role).toBe("owner");
	});

	it("forbids an admin (no roles.write) from changing another user's role", async () => {
		const { token } = await authedAdmin("admin");
		const { user: target } = await createUser({
			email: rbacEmail(`target-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Target",
			role: "editor",
		});
		const res = await auth.request(`/users/${target.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ role: "support" }),
		});
		expect(res.status).toBe(403);
		expect((await loadUser(target.id))?.role).toBe("editor");
	});

	it("blocks account takeover: admin cannot change an owner's email", async () => {
		const { token } = await authedAdmin("admin");
		const { user: target } = await createUser({
			email: rbacEmail(`owner-target-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Owner Target",
			role: "owner",
		});
		const original = await loadUser(target.id);
		const takeoverEmail = rbacEmail(`takeover-${randomUUID().slice(0, 8)}`);
		const res = await auth.request(`/users/${target.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ email: takeoverEmail }),
		});
		expect(res.status).toBe(403);
		const body = await res.json() as { error?: string; reason?: string };
		expect(body.reason).toBe("admin_self_protection");
		expect(body.error).toContain("Only an owner can mutate another owner");
		const after = await loadUser(target.id);
		expect(after?.email).toBe(original?.email);
		expect(after?.role).toBe("owner");
	});

	it("lets an admin change a non-owner user's email", async () => {
		const { token } = await authedAdmin("admin");
		const { user: target } = await createUser({
			email: rbacEmail(`editor-target-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Editor Target",
			role: "editor",
		});
		const nextEmail = rbacEmail(`editor-updated-${randomUUID().slice(0, 8)}`);
		const res = await auth.request(`/users/${target.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ email: nextEmail }),
		});
		expect(res.status).toBe(200);
		expect((await loadUser(target.id))?.email).toBe(nextEmail);
	});

	it("lets an owner change another owner's email", async () => {
		const { token } = await authedAdmin("owner");
		const { user: target } = await createUser({
			email: rbacEmail(`peer-owner-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Peer Owner",
			role: "owner",
		});
		const nextEmail = rbacEmail(`peer-owner-updated-${randomUUID().slice(0, 8)}`);
		const res = await auth.request(`/users/${target.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ email: nextEmail, name: "Updated Peer Owner" }),
		});
		expect(res.status).toBe(200);
		const after = await loadUser(target.id);
		expect(after?.email).toBe(nextEmail);
		expect(after?.name).toBe("Updated Peer Owner");
		expect(after?.role).toBe("owner");
	});

	it("lets an owner assign a platform role to another user", async () => {
		const { token } = await authedAdmin("owner");
		const { user: target } = await createUser({
			email: rbacEmail(`promote-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Promote Me",
			role: "editor",
		});
		const res = await auth.request(`/users/${target.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ role: "accountant" }),
		});
		expect(res.status).toBe(200);
		expect((await loadUser(target.id))?.role).toBe("accountant");
	});

	// ── RBAC + audit gap regression (legacy /users/:id mutations) ──
	// These legacy routes used to run on the coarse requireAdmin role gate with NO
	// audit trail. They now (a) layer requirePermission(USERS_WRITE) and (b) write
	// an admin_audit row on every successful mutation, matching the modern
	// /api/admin/users-mgmt surface.

	it("forbids a role WITHOUT admin:users.write (editor) from the legacy PATCH", async () => {
		// editor reaches no admin route — it lacks both the role gate and the
		// permission. Asserts the permission gate is wired (defense in depth: even
		// if the coarse role gate ever widened, USERS_WRITE still blocks).
		const { user: actor } = await createUser({
			email: rbacEmail(`editor-actor-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Editor Actor",
			role: "editor",
		});
		const actorFull = await loadUser(actor.id);
		const actorTokens = await generateTokens(actorFull!);
		const { user: target } = await createUser({
			email: rbacEmail(`patch-target-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Patch Target",
			role: "editor",
		});
		const res = await auth.request(`/users/${target.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${actorTokens.accessToken}` },
			body: JSON.stringify({ name: "Renamed" }),
		});
		expect(res.status).toBe(403);
		expect((await loadUser(target.id))?.name).toBe("Patch Target");
	});

	it("writes an admin_audit row on a successful legacy PATCH update", async () => {
		const { user: admin, token } = await authedAdmin("admin");
		const { user: target } = await createUser({
			email: rbacEmail(`audit-patch-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Audit Patch Target",
			role: "editor",
		});
		const res = await auth.request(`/users/${target.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: "Audited Name" }),
		});
		expect(res.status).toBe(200);
		const audit = await gdprStore.listAdminAudit({ action: "admin.user.update", targetId: target.id });
		expect(audit.total).toBe(1);
		expect(audit.entries[0]?.adminUserId).toBe(admin.id);
		expect(audit.entries[0]?.targetKind).toBe("user");
	});

	it("writes an admin_audit row on a successful legacy disable", async () => {
		const { user: admin, token } = await authedAdmin("admin");
		const { user: target } = await createUser({
			email: rbacEmail(`audit-disable-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Audit Disable Target",
			role: "editor",
		});
		const res = await auth.request(`/users/${target.id}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect((await loadUser(target.id))?.isActive).toBe(false);
		const audit = await gdprStore.listAdminAudit({ action: "admin.user.disable", targetId: target.id });
		expect(audit.total).toBe(1);
		expect(audit.entries[0]?.adminUserId).toBe(admin.id);
	});

	it("writes an admin_audit row on a successful legacy enable", async () => {
		const { user: admin, token } = await authedAdmin("admin");
		const { user: target } = await createUser({
			email: rbacEmail(`audit-enable-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Audit Enable Target",
			role: "editor",
		});
		await updateUser(target.id, { isActive: false });
		const res = await auth.request(`/users/${target.id}/enable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect((await loadUser(target.id))?.isActive).toBe(true);
		const audit = await gdprStore.listAdminAudit({ action: "admin.user.enable", targetId: target.id });
		expect(audit.total).toBe(1);
		expect(audit.entries[0]?.adminUserId).toBe(admin.id);
	});

	it("writes an admin_audit row on a successful legacy delete", async () => {
		const { user: admin, token } = await authedAdmin("admin");
		const { user: target } = await createUser({
			email: rbacEmail(`audit-delete-${randomUUID().slice(0, 8)}`),
			password: "StrongP@ss123",
			name: "Audit Delete Target",
			role: "editor",
		});
		const res = await auth.request(`/users/${target.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect(await loadUser(target.id)).toBeNull();
		const audit = await gdprStore.listAdminAudit({ action: "admin.user.delete", targetId: target.id });
		expect(audit.total).toBe(1);
		expect(audit.entries[0]?.adminUserId).toBe(admin.id);
	});
});

describe("self-service account management (PATCH /me, POST /change-password)", () => {
	function selfEmail(name: string) {
		return `self-${name}-${randomUUID().slice(0, 8)}-${testRunId}@example.com`;
	}

	async function signedInUser(password = "StrongP@ss123") {
		const { user } = await createUser({
			email: selfEmail("user"),
			password,
			name: "Original Name",
			role: "editor",
		});
		const full = await loadUser(user.id);
		const tokens = await generateTokens(full!);
		return { user, token: tokens.accessToken, password };
	}

	it("updates the signed-in user's own display name", async () => {
		const { user, token } = await signedInUser();
		const res = await auth.request("/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: "Renamed Person" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { name?: string; passwordHash?: string };
		expect(body.name).toBe("Renamed Person");
		// Never leak the password hash.
		expect(body.passwordHash).toBeUndefined();
		expect((await loadUser(user.id))?.name).toBe("Renamed Person");
	});

	it("updates the signed-in user's UI locale preference without touching the display name", async () => {
		const { user, token } = await signedInUser();
		const localeOnly = await auth.request("/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ locale: "en" }),
		});
		expect(localeOnly.status).toBe(200);
		const localeBody = await localeOnly.json() as { locale?: string; name?: string; passwordHash?: string };
		expect(localeBody.locale).toBe("en");
		expect(localeBody.name).toBe("Original Name");
		expect(localeBody.passwordHash).toBeUndefined();

		const nameOnly = await auth.request("/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: "Renamed Person" }),
		});
		expect(nameOnly.status).toBe(200);
		const stored = await loadUser(user.id);
		expect(stored?.name).toBe("Renamed Person");
		expect(stored?.locale).toBe("en");
	});

	it("trims the display name and rejects a blank one", async () => {
		const { user, token } = await signedInUser();
		const trimmed = await auth.request("/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: "  Spaced Out  " }),
		});
		expect(trimmed.status).toBe(200);
		expect((await loadUser(user.id))?.name).toBe("Spaced Out");

		const blank = await auth.request("/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: "   " }),
		});
		expect(blank.status).toBe(400);
		// Storage unchanged by the rejected blank update.
		expect((await loadUser(user.id))?.name).toBe("Spaced Out");
	});

	it("ignores non-name fields (cannot self-change email or role via PATCH /me)", async () => {
		const { user, token } = await signedInUser();
		const res = await auth.request("/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: "Still Me", email: "hijack@example.com", role: "owner" }),
		});
		// strict() schema → unknown keys reject the whole request.
		expect(res.status).toBe(400);
		const after = await loadUser(user.id);
		expect(after?.email).not.toBe("hijack@example.com");
		expect(after?.role).toBe("editor");
	});

	it("rejects an unsupported self-service UI locale", async () => {
		const { user, token } = await signedInUser();
		const res = await auth.request("/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ locale: "jp" }),
		});
		expect(res.status).toBe(400);
		expect((await loadUser(user.id))?.locale).toBeUndefined();
	});

	it("rejects an unauthenticated profile update", async () => {
		const res = await auth.request("/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Anon" }),
		});
		expect(res.status).toBe(401);
	});

	it("changes the password when the current password is correct", async () => {
		const { user, token, password } = await signedInUser();
		const res = await auth.request("/change-password", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ oldPassword: password, newPassword: "BrandNewP@ss456" }),
		});
		expect(res.status).toBe(200);
		const after = await loadUser(user.id);
		// New password verifies; old no longer does.
		expect(await comparePassword("BrandNewP@ss456", after!.passwordHash)).toBe(true);
		expect(await comparePassword(password, after!.passwordHash)).toBe(false);
	});

	it("rejects a password change when the current password is wrong", async () => {
		const { user, token, password } = await signedInUser();
		const res = await auth.request("/change-password", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ oldPassword: "totally-wrong", newPassword: "BrandNewP@ss456" }),
		});
		// Wrong current password is an auth failure (401), now carrying a stable code so the
		// client can branch without string-matching.
		expect(res.status).toBe(401);
		const body = await res.json() as { error?: string; code?: string };
		expect(body.code).toBe("current_password_incorrect");
		expect(body.error).toContain("Current password is incorrect");
		// Password unchanged — original still verifies.
		expect(await comparePassword(password, (await loadUser(user.id))!.passwordHash)).toBe(true);
	});
});

describe("Auth hardening (P1)", () => {
	let counter = 0;
	function email(tag: string) {
		counter += 1;
		return `harden-${tag}-${counter}-${randomUUID().slice(0, 8)}-${testRunId}@example.com`;
	}

	async function makeUser(tag: string, password = "StrongP@ss123") {
		const { user } = await createUser({ email: email(tag), password, name: "Harden User", role: "editor" });
		const full = await loadUser(user.id);
		return { user: full!, password };
	}

	// ── P1.1: revoked session's access token is rejected on the next request ──
	it("rejects a session's access token immediately after that session is revoked", async () => {
		const { user } = await makeUser("revoke");
		const tokens = await generateTokens(user);

		// Token works while the session is active.
		const before = await auth.request("/sessions", {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(before.status).toBe(200);

		// Revoke the refresh session this access token was minted with.
		await revokeRefreshToken(tokens.refreshToken);

		// The (still-unexpired) access token must now be rejected, not honored.
		const after = await auth.request("/sessions", {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(after.status).toBe(401);
		const body = await after.json() as { error?: string };
		expect(body.error).toContain("Session revoked");
	});

	it("isSessionActive flips to false once the session is revoked", async () => {
		const { user } = await makeUser("active");
		const tokens = await generateTokens(user);
		const session = await findRefreshSession(tokens.refreshToken);
		expect(session).not.toBeNull();
		expect(await isSessionActive(user.id, session!.sessionId)).toBe(true);
		await revokeRefreshToken(tokens.refreshToken);
		expect(await isSessionActive(user.id, session!.sessionId)).toBe(false);
	});

	it("still honors legacy access tokens that carry no sid", async () => {
		const { user } = await makeUser("legacy");
		// generateAccessToken without a sessionId mints a token with no `sid`.
		const legacyToken = generateAccessToken(user);
		const res = await auth.request("/sessions", {
			headers: { Authorization: `Bearer ${legacyToken}` },
		});
		expect(res.status).toBe(200);
	});

	// ── P1.2: atomic single-use refresh rotation under concurrency ──
	it("two concurrent consumes of one refresh token yield exactly one winner", async () => {
		const { user } = await makeUser("rotate");
		const tokens = await generateTokens(user);

		const [a, b] = await Promise.all([
			consumeRefreshSessionForRotation(tokens.refreshToken),
			consumeRefreshSessionForRotation(tokens.refreshToken),
		]);

		const winners = [a, b].filter((r) => r !== null);
		expect(winners).toHaveLength(1);
		// And the token is now fully spent.
		expect(await consumeRefreshSessionForRotation(tokens.refreshToken)).toBeNull();
	});

	it("concurrent /refresh requests with the same token mint exactly one valid successor", async () => {
		const { user } = await makeUser("refresh-race");
		const tokens = await generateTokens(user);

		const [r1, r2] = await Promise.all([
			auth.request("/refresh", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refreshToken: tokens.refreshToken }),
			}),
			auth.request("/refresh", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refreshToken: tokens.refreshToken }),
			}),
		]);

		const statuses = [r1.status, r2.status].sort();
		// Exactly one rotation succeeds; the racing one is rejected.
		expect(statuses).toEqual([200, 401]);
	});

	// ── P1.5: a reset invalidates a token minted in the SAME wall-clock second ──
	it("a password reset invalidates an access token minted in the same second", async () => {
		const { user } = await makeUser("reset-epoch");
		// Mint the access token, then reset in the same second. The ms-precision
		// `iatMs` claim ensures the pre-reset token is rejected even though its
		// floored `iat` second equals the reset watermark's second.
		const tokens = await generateTokens(user);
		await resetPasswordForUser(user.id, "FreshP@ssword789");

		const res = await auth.request("/sessions", {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(res.status).toBe(401);
		const body = await res.json() as { error?: string };
		// Either the watermark (token revoked) or the session-revocation guard fires;
		// both are correct rejections. The key invariant: the old token is dead.
		expect(body.error).toMatch(/revoked/i);
	});

	it("a token minted AFTER a reset (same second re-login) still works", async () => {
		const { user } = await makeUser("reset-relogin");
		await resetPasswordForUser(user.id, "FreshP@ssword789");
		// Re-login immediately (same second): fresh tokens minted after the watermark.
		const fresh = await loadUser(user.id);
		const tokens = await generateTokens(fresh!);
		const res = await auth.request("/sessions", {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});
		expect(res.status).toBe(200);
	});
});
