import { describe, expect, test } from "bun:test";
import {
	PostgresAuthUserStore,
	FileAuthUserStore,
	LastPlatformOwnerError,
	USER_LIST_MAX_LIMIT,
	type AuthUserRow,
	type AuthExternalIdentityRow,
	type AuthUserSqlClient,
} from "../services/auth-users.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { User } from "../types/auth.js";

type StoredAuthUserRow = AuthUserRow & {
	email_normalized: string;
};

class FakeAuthUserSqlClient implements AuthUserSqlClient {
	queries: Array<{ query: string; params: unknown[] }> = [];
	rows: StoredAuthUserRow[] = [];
	identities: AuthExternalIdentityRow[] = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		const normalizedQuery = query.trim().replace(/\s+/g, " ").toUpperCase();

		// Advisory-lock acquisition is a no-op in the single-process fake.
		if (normalizedQuery.includes("PG_ADVISORY_XACT_LOCK")) {
			return [] as T[];
		}

		// Owner-protected SELECT ... FOR UPDATE (full-column, update path).
		if (
			normalizedQuery.startsWith("SELECT") &&
			normalizedQuery.includes("FROM AUTH_USERS WHERE USER_ID = $1 FOR UPDATE")
		) {
			return this.result(this.rows.find((item) => item.user_id === params[0])) as T[];
		}

		// Owner-protected SELECT role,is_active ... FOR UPDATE (delete path).
		if (
			normalizedQuery.startsWith("SELECT ROLE, IS_ACTIVE") &&
			normalizedQuery.includes("FROM AUTH_USERS WHERE USER_ID = $1 FOR UPDATE")
		) {
			const row = this.rows.find((item) => item.user_id === params[0]);
			return (row ? [{ role: row.role, is_active: row.is_active }] : []) as T[];
		}

		// Owner-protected/plain profile UPDATE: applies only the columns present in
		// the dynamic SET list, and honors the owner EXISTS guard when present.
		if (
			normalizedQuery.startsWith("UPDATE AUTH_USERS SET") &&
			!normalizedQuery.startsWith("UPDATE AUTH_USERS SET AUTH_PROVIDER =") &&
			!normalizedQuery.startsWith("UPDATE AUTH_USERS SET LAST_LOGIN_AT =")
		) {
			const userId = params[0];
			if (normalizedQuery.includes("AND EXISTS") && !this.anotherActiveOwnerExists(String(userId))) return [] as T[];
			const row = this.rows.find((item) => item.user_id === userId);
			if (!row) return [] as T[];
			this.applyAuthUserUpdateFromQuery(row, query, params);
			return [this.toResultRow(row)] as T[];
		}

		// Owner-protected conditional DELETE: deletes only when EXISTS(another
		// active owner) holds.
		if (normalizedQuery.startsWith("DELETE FROM AUTH_USERS") && normalizedQuery.includes("AND EXISTS")) {
			const userId = params[0];
			if (!this.anotherActiveOwnerExists(String(userId))) return [] as T[];
			const index = this.rows.findIndex((item) => item.user_id === userId);
			if (index < 0) return [] as T[];
			const [deleted] = this.rows.splice(index, 1);
			return [{ user_id: deleted.user_id }] as T[];
		}

		if (normalizedQuery.startsWith("INSERT INTO AUTH_USERS")) {
			const row = this.createRowFromParams(params);
			const existingIndex = this.rows.findIndex((item) => item.user_id === row.user_id);
			if (existingIndex >= 0) {
				row.created_at = this.rows[existingIndex].created_at;
				this.rows[existingIndex] = row;
			} else {
				this.rows.push(row);
			}
			return [this.toResultRow(row)] as T[];
		}

		if (normalizedQuery.startsWith("SELECT") && normalizedQuery.includes("FROM AUTH_USERS WHERE USER_ID = $1")) {
			return this.result(this.rows.find((item) => item.user_id === params[0])) as T[];
		}

		if (normalizedQuery.startsWith("SELECT") && normalizedQuery.includes("FROM AUTH_USERS WHERE EMAIL_NORMALIZED = $1")) {
			return this.result(this.rows.find((item) => item.email_normalized === params[0])) as T[];
		}

		if (normalizedQuery.startsWith("SELECT") && normalizedQuery.includes("FROM AUTH_USERS WHERE AUTH_PROVIDER = $1 AND EXTERNAL_SUBJECT = $2")) {
			return this.result(this.rows.find((item) => item.auth_provider === params[0] && item.external_subject === params[1])) as T[];
		}

		if (normalizedQuery.startsWith("SELECT") && normalizedQuery.includes("FROM AUTH_EXTERNAL_IDENTITIES I JOIN AUTH_USERS U")) {
			const identity = this.identities.find((item) => item.provider === params[0] && item.provider_user_id === params[1]);
			return this.result(identity ? this.rows.find((item) => item.user_id === identity.user_id) : undefined) as T[];
		}

		if (normalizedQuery.startsWith("SELECT") && normalizedQuery.includes("FROM AUTH_EXTERNAL_IDENTITIES WHERE USER_ID = ANY")) {
			// Scalar ARRAY[$1,$2,...] binds: each id is its own param (the real
			// query no longer binds a single JS array, which Bun.SQL can't do).
			const ids = new Set(params.map(String));
			return this.identities.filter((item) => ids.has(item.user_id)) as T[];
		}

		if (normalizedQuery.startsWith("SELECT") && normalizedQuery.includes("FROM AUTH_EXTERNAL_IDENTITIES WHERE USER_ID = $1")) {
			return this.identities.filter((item) => item.user_id === params[0]) as T[];
		}

		if (normalizedQuery.startsWith("SELECT") && normalizedQuery.includes("FROM AUTH_EXTERNAL_IDENTITIES WHERE PROVIDER = $1 AND PROVIDER_USER_ID = $2")) {
			return this.identities.filter((item) => item.provider === params[0] && item.provider_user_id === params[1]).slice(0, 1) as T[];
		}

		if (normalizedQuery.startsWith("INSERT INTO AUTH_EXTERNAL_IDENTITIES")) {
			const existing = this.identities.find((item) => item.provider === params[1] && item.provider_user_id === params[2]);
			if (existing && existing.user_id !== params[0]) {
				return [] as T[];
			}
			const row: AuthExternalIdentityRow = existing ?? {
				user_id: String(params[0]),
				provider: String(params[1]),
				provider_user_id: String(params[2]),
				created_at: String(params[4]),
			};
			row.email_verified = params[3] === null || params[3] === undefined ? row.email_verified : Boolean(params[3]);
			row.updated_at = String(params[4]);
			if (!existing) this.identities.push(row);
			return [row] as T[];
		}

		if (normalizedQuery.startsWith("UPDATE AUTH_USERS SET AUTH_PROVIDER =")) {
			const row = this.rows.find((item) => item.user_id === params[0]);
			if (!row) return [] as T[];
			row.auth_provider = String(params[1]);
			row.external_subject = String(params[2]);
			if (params[3] !== null && params[3] !== undefined) {
				row.email_verified = Boolean(params[3]);
			}
			row.updated_at = String(params[4]);
			return [this.toResultRow(row)] as T[];
		}

		if (normalizedQuery.startsWith("UPDATE AUTH_USERS SET LAST_LOGIN_AT =")) {
			const row = this.rows.find((item) => item.user_id === params[0]);
			if (row) {
				row.last_login_at = String(params[1]);
				row.updated_at = String(params[1]);
			}
			return [] as T[];
		}

		if (normalizedQuery.startsWith("DELETE FROM AUTH_USERS")) {
			const index = this.rows.findIndex((item) => item.user_id === params[0]);
			if (index < 0) return [] as T[];
			const [deleted] = this.rows.splice(index, 1);
			return [{ user_id: deleted.user_id }] as T[];
		}

		if (normalizedQuery.startsWith("SELECT COUNT(*)") && normalizedQuery.includes("FROM AUTH_USERS")) {
			// Emulate the bounded COUNT(*) honest-total query, applying the same
			// optional filters against name/email, role, and active status.
			let matched = this.rows;
			const searchMatch = query.match(/name ILIKE \$(\d+)/i);
			if (searchMatch) {
				const param = params[Number(searchMatch[1]) - 1];
				const needle = String(param).replace(/^%|%$/g, "").toLowerCase();
				matched = matched.filter(
					(row) => row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle),
				);
			}
			const roleMatch = query.match(/role = \$(\d+)/i);
			if (roleMatch) {
				const role = String(params[Number(roleMatch[1]) - 1]);
				matched = matched.filter((row) => row.role === role);
			}
			if (normalizedQuery.includes("NOT (IS_ACTIVE = TRUE")) {
				matched = matched.filter((row) => !Boolean(row.is_active));
			} else if (normalizedQuery.includes("(IS_ACTIVE = TRUE")) {
				matched = matched.filter((row) => Boolean(row.is_active));
			}
			return [{ count: matched.length }] as T[];
		}

		if (normalizedQuery.includes("FROM AUTH_USERS") && normalizedQuery.includes("ORDER BY LOWER(NAME), USER_ID")) {
			// Emulate Postgres for both the unbounded list() and the keyset
			// listPaginated(): sort by (lower(name), user_id), apply the SQL search
			// ILIKE + keyset row-value predicate + LIMIT against the bound params.
			let sorted = [...this.rows].sort(compareRowsByKeyset);

			// Search filter: WHERE (name ILIKE $i OR email ILIKE $i)
			const searchMatch = query.match(/name ILIKE \$(\d+)/i);
			if (searchMatch) {
				const param = params[Number(searchMatch[1]) - 1];
				const needle = String(param).replace(/^%|%$/g, "").toLowerCase();
				sorted = sorted.filter(
					(row) => row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle),
				);
			}

			const roleMatch = query.match(/role = \$(\d+)/i);
			if (roleMatch) {
				const role = String(params[Number(roleMatch[1]) - 1]);
				sorted = sorted.filter((row) => row.role === role);
			}

			if (normalizedQuery.includes("NOT (IS_ACTIVE = TRUE")) {
				sorted = sorted.filter((row) => !Boolean(row.is_active));
			} else if (normalizedQuery.includes("(IS_ACTIVE = TRUE")) {
				sorted = sorted.filter((row) => Boolean(row.is_active));
			}

			// Keyset cursor: WHERE (lower(name), user_id) > ($a, $b)
			const keysetMatch = query.match(/\(lower\(name\), user_id\) > \(\$(\d+), \$(\d+)\)/i);
			if (keysetMatch) {
				const cursorName = String(params[Number(keysetMatch[1]) - 1]);
				const cursorId = String(params[Number(keysetMatch[2]) - 1]);
				sorted = sorted.filter(
					(row) => compareKeyset(row.name.toLowerCase(), row.user_id, cursorName, cursorId) > 0,
				);
			}

			// LIMIT $N is always the last bound param when present.
			const limitMatch = query.match(/LIMIT \$(\d+)/i);
			if (limitMatch) {
				const limit = Number(params[Number(limitMatch[1]) - 1]);
				if (Number.isFinite(limit)) sorted = sorted.slice(0, limit);
			}

			return sorted.map((row) => this.toResultRow(row)) as T[];
		}

		return [] as T[];
	}

	async begin<T>(fn: (tx: AuthUserSqlClient) => Promise<T>): Promise<T> {
		// Snapshot-and-rollback emulation: on throw, restore pre-transaction state
		// so atomicity tests observe all-or-nothing semantics.
		const snapshotRows = this.rows.map((row) => ({ ...row }));
		const snapshotIdentities = this.identities.map((row) => ({ ...row }));
		try {
			return await fn(this);
		} catch (error) {
			this.rows = snapshotRows;
			this.identities = snapshotIdentities;
			throw error;
		}
	}

	/** Emulates `EXISTS (SELECT 1 FROM auth_users o WHERE o.role='owner' AND o.is_active AND o.user_id <> $1)`. */
	private anotherActiveOwnerExists(excludeUserId: string): boolean {
		return this.rows.some(
			(row) => row.user_id !== excludeUserId && row.role === "owner" && Boolean(row.is_active),
		);
	}

	private result(row?: StoredAuthUserRow): AuthUserRow[] {
		return row ? [this.toResultRow(row)] : [];
	}

	private toResultRow(row: StoredAuthUserRow): AuthUserRow {
		const { email_normalized, ...result } = row;
		return result;
	}

	private applyAuthUserUpdateFromQuery(row: StoredAuthUserRow, query: string, params: unknown[]): void {
		const match = query.match(/SET\s+([\s\S]+?)\s+WHERE user_id = \$1/i);
		if (!match) return;
		for (const assignment of match[1].split(",")) {
			const column = assignment.match(/^\s*([a-z_]+)\s*=\s*\$(\d+)/i);
			if (!column) continue;
			const value = params[Number(column[2]) - 1];
			switch (column[1]) {
				case "email":
					row.email = String(value);
					break;
				case "email_normalized":
					row.email_normalized = String(value);
					break;
				case "name":
					row.name = String(value);
					break;
				case "role":
					row.role = String(value);
					break;
				case "is_active":
					row.is_active = Boolean(value);
					break;
				case "verification_email_send_failed":
					row.verification_email_send_failed = Boolean(value);
					break;
				case "email_verified":
					row.email_verified = Boolean(value);
					break;
				case "tokens_valid_from_ms":
					row.tokens_valid_from_ms = Number(value);
					break;
				case "locale":
					row.locale = value == null ? null : String(value);
					break;
				case "updated_at":
					row.updated_at = String(value);
					break;
			}
		}
	}

	private createRowFromParams(params: unknown[]): StoredAuthUserRow {
		const hasLocale = params.length >= 16;
		return {
			user_id: String(params[0]),
			email: String(params[1]),
			email_normalized: String(params[2]),
			password_hash: String(params[3]),
			name: String(params[4]),
			role: String(params[5]),
			auth_provider: String(params[6]),
			external_subject: params[7] ? String(params[7]) : null,
			email_verified: Boolean(params[8]),
			verification_email_send_failed: Boolean(params[9]),
			tokens_valid_from_ms: Number(params[10]),
			locale: hasLocale && params[11] ? String(params[11]) : null,
			is_active: Boolean(params[hasLocale ? 12 : 11]),
			last_login_at: params[hasLocale ? 13 : 12] ? String(params[hasLocale ? 13 : 12]) : null,
			created_at: String(params[hasLocale ? 14 : 13]),
			updated_at: String(params[hasLocale ? 15 : 14]),
		};
	}
}

describe("auth user stores", () => {
	test("Postgres auth store uses indexed user, email, and external identity lookups", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		const user = createUser();

		const created = await store.create(user);
		expect(created.email).toBe("owner@example.com");

		await expect(store.load(user.id)).resolves.toEqual(expect.objectContaining({
			id: user.id,
			email: "owner@example.com",
		}));
		await expect(store.findByEmail("OWNER@example.com")).resolves.toEqual(expect.objectContaining({
			id: user.id,
		}));

		const updated = await store.update(user.id, {
			email: "renamed@example.com",
			name: "Renamed Owner",
		});
		expect(updated).toEqual(expect.objectContaining({
			email: "renamed@example.com",
			name: "Renamed Owner",
		}));

		const linked = await store.linkExternalIdentity(user.id, {
			provider: "oidc",
			subject: "issuer|owner",
			emailVerified: true,
		});
		expect(linked).toEqual(expect.objectContaining({
			authProvider: "oidc",
			externalSubject: "issuer|owner",
			emailVerified: true,
		}));
		await expect(store.findByExternalIdentity("oidc", "issuer|owner")).resolves.toEqual(expect.objectContaining({
			id: user.id,
		}));

		await store.updateLastLogin(user.id, "2026-05-28T04:00:00.000Z");
		expect((await store.load(user.id))?.lastLogin).toBe("2026-05-28T04:00:00.000Z");

		await store.save({
			...(await store.load(user.id))!,
			passwordHash: "new-hash",
			isActive: false,
			updatedAt: "2026-05-28T04:05:00.000Z",
		});
		expect((await store.load(user.id))?.passwordHash).toBe("new-hash");
		expect((await store.list()).map((item) => item.id)).toEqual([user.id]);
		await expect(store.delete(user.id)).resolves.toBe(true);
		await expect(store.load(user.id)).resolves.toBeNull();

		expect(client.queries.some((entry) => entry.query.includes("WHERE user_id = $1"))).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("WHERE email_normalized = $1"))).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("FROM auth_external_identities i"))).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("ON CONFLICT (user_id) DO UPDATE"))).toBe(true);
	});

	test("Postgres auth store updates only the columns present in the profile patch", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		const user = { ...createUser(), locale: "th" as const };
		await store.create(user);

		client.queries.length = 0;
		const updated = await store.update(user.id, { locale: "en" });

		expect(updated).toEqual(expect.objectContaining({ name: "Owner", locale: "en" }));
		const updateQuery = client.queries.find((entry) => /UPDATE auth_users/i.test(entry.query));
		expect(updateQuery?.query).toMatch(/SET\s+locale = \$2,\s+updated_at = \$3/i);
		expect(updateQuery?.query).not.toMatch(/\bname\s*=/i);
		expect(updateQuery?.query).not.toMatch(/\bemail\s*=/i);
	});

	test("Postgres auth store refuses to move an external identity owned by another user", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		const first = createUser();
		const second = {
			...createUser(),
			id: "user-auth-store-second",
			email: "second@example.com",
		};

		await store.create(first);
		await store.create(second);
		await store.linkExternalIdentity(first.id, {
			provider: "github",
			subject: "github|owned",
			emailVerified: true,
		});

		await expect(store.linkExternalIdentity(second.id, {
			provider: "github",
			subject: "github|owned",
			emailVerified: true,
		})).rejects.toThrow("External identity already linked to another user");
		await expect(store.findByExternalIdentity("github", "github|owned")).resolves.toEqual(expect.objectContaining({
			id: first.id,
		}));
	});

	test("listPaginated returns ordered keyset pages with nextCursor and bounded size", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		// Names chosen so keyset ordering (lower(name), user_id) is deterministic.
		const names = ["Bravo", "alpha", "Charlie", "delta", "Echo"];
		for (let i = 0; i < names.length; i++) {
			await store.create({
				...createUser(),
				id: `user-${i}`,
				email: `user${i}@example.com`,
				name: names[i],
			});
		}

		const page1 = await store.listPaginated({ limit: 2 });
		expect(page1.users.map((u) => u.name)).toEqual(["alpha", "Bravo"]);
		expect(page1.nextCursor).toEqual({ name: "bravo", userId: "user-0" });

		const page2 = await store.listPaginated({ limit: 2, cursor: page1.nextCursor });
		expect(page2.users.map((u) => u.name)).toEqual(["Charlie", "delta"]);
		expect(page2.nextCursor).toEqual({ name: "delta", userId: "user-3" });

		const page3 = await store.listPaginated({ limit: 2, cursor: page2.nextCursor });
		expect(page3.users.map((u) => u.name)).toEqual(["Echo"]);
		// Last page → no further cursor.
		expect(page3.nextCursor).toBeNull();
	});

	test("count returns the honest grand total via a single bounded COUNT(*)", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		await store.create({ ...createUser(), id: "c-a", email: "ana@example.com", name: "Ana" });
		await store.create({ ...createUser(), id: "c-b", email: "bob@example.com", name: "Bob" });
		await store.create({ ...createUser(), id: "c-c", email: "cleo@work.com", name: "Cleo" });

		// Unfiltered total = all rows, NOT a page count.
		expect(await store.count()).toBe(3);

		client.queries.length = 0;
		// Filtered total respects the same ILIKE search as listPaginated.
		expect(await store.count({ search: "work.com" })).toBe(1);
		const countQuery = client.queries.find((q) => /COUNT\(\*\)/i.test(q.query) && /FROM auth_users/i.test(q.query));
		expect(countQuery).toBeDefined();
		expect(countQuery!.params).toContain("%work.com%");
	});

	test("listPaginated clamps page size to the max bound", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		await store.create(createUser());
		await store.listPaginated({ limit: 10_000 });
		const listQuery = client.queries.find((q) => /ORDER BY lower\(name\), user_id\s+LIMIT/i.test(q.query));
		expect(listQuery).toBeDefined();
		// LIMIT is fetched +1 to detect a further page; clamped to MAX + 1.
		expect(listQuery!.params[listQuery!.params.length - 1]).toBe(USER_LIST_MAX_LIMIT + 1);
	});

	test("listPaginated pushes the search filter into SQL (ILIKE), not JS", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		await store.create({ ...createUser(), id: "u-a", email: "ana@example.com", name: "Ana" });
		await store.create({ ...createUser(), id: "u-b", email: "bob@example.com", name: "Bob" });
		await store.create({ ...createUser(), id: "u-c", email: "cleo@work.com", name: "Cleo" });

		const byName = await store.listPaginated({ search: "bo" });
		expect(byName.users.map((u) => u.id)).toEqual(["u-b"]);

		client.queries.length = 0;
		const byEmail = await store.listPaginated({ search: "work.com" });
		expect(byEmail.users.map((u) => u.id)).toEqual(["u-c"]);

		// The filter is in SQL: the list query carries an ILIKE predicate + %term% param.
		const searchQuery = client.queries.find((q) => /ILIKE/i.test(q.query) && /FROM auth_users/i.test(q.query));
		expect(searchQuery).toBeDefined();
		expect(searchQuery!.params).toContain("%work.com%");
	});

	test("listPaginated and count push role/status filters into SQL before keyset pagination", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		await store.create({ ...createUser(), id: "flt-0", email: "flt0@example.com", name: "filter-user-00", role: "viewer" });
		await store.create({ ...createUser(), id: "flt-1", email: "flt1@example.com", name: "filter-user-01", role: "viewer" });
		await store.create({ ...createUser(), id: "flt-2", email: "flt2@example.com", name: "filter-user-02", role: "editor" });
		await store.create({ ...createUser(), id: "flt-3", email: "flt3@example.com", name: "filter-user-03", role: "editor", isActive: false });
		await store.create({ ...createUser(), id: "flt-4", email: "flt4@example.com", name: "filter-user-04", role: "editor", isActive: false });

		client.queries.length = 0;
		const page = await store.listPaginated({ search: "filter-user", role: "editor", status: "disabled", limit: 2 });
		expect(page.users.map((u) => u.id)).toEqual(["flt-3", "flt-4"]);
		expect(page.nextCursor).toBeNull();
		expect(await store.count({ search: "filter-user", role: "editor", status: "disabled" })).toBe(2);

		const listQuery = client.queries.find((q) => /FROM auth_users/i.test(q.query) && /ORDER BY lower\(name\), user_id/i.test(q.query));
		expect(listQuery).toBeDefined();
		expect(listQuery!.query).toContain("role = $2");
		expect(listQuery!.query).toContain("NOT (is_active = true");
		expect(listQuery!.params).toContain("editor");
		const countQuery = client.queries.find((q) => /COUNT\(\*\)/i.test(q.query) && /FROM auth_users/i.test(q.query));
		expect(countQuery).toBeDefined();
		expect(countQuery!.query).toContain("role = $2");
		expect(countQuery!.query).toContain("NOT (is_active = true");
		expect(countQuery!.params).toContain("editor");
		expect(listQuery!.query).not.toContain("ANY($");
		expect(countQuery!.query).not.toContain("ANY($");
	});

	test("listPaginated batches external identities into a single query (no N+1)", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		for (let i = 0; i < 4; i++) {
			await store.create({ ...createUser(), id: `usr-${i}`, email: `usr${i}@example.com`, name: `User ${i}` });
			await store.linkExternalIdentity(`usr-${i}`, {
				provider: "github",
				subject: `github|${i}`,
				emailVerified: true,
			});
		}

		client.queries.length = 0;
		const page = await store.listPaginated({ limit: 50 });
		expect(page.users).toHaveLength(4);
		// Each returned user carries its identity (shape preserved).
		for (const user of page.users) {
			expect(user.externalIdentities).toHaveLength(1);
			expect(user.externalIdentities?.[0].provider).toBe("github");
		}
		// Exactly ONE identity query for all N users — not one-per-user.
		const identityQueries = client.queries.filter((q) => /FROM auth_external_identities/i.test(q.query));
		expect(identityQueries).toHaveLength(1);
		const identityQuery = identityQueries[0]!;
		// Scalar ARRAY[...] binds, NOT a single JS-array param (`$1::text[]`):
		// Bun.SQL.unsafe throws `malformed array literal` on a JS array against
		// real Postgres, so each id is bound as its own scalar placeholder.
		expect(identityQuery.query).toContain("ANY(ARRAY[$1, $2, $3, $4]::text[])");
		expect(identityQuery.query).not.toContain("ANY($1::text[])");
		// Each param is a scalar id string (not a nested array).
		expect(identityQuery.params).toEqual(["usr-0", "usr-1", "usr-2", "usr-3"]);
		for (const param of identityQuery.params ?? []) {
			expect(Array.isArray(param)).toBe(false);
		}
	});

	test("linkExternalIdentity runs inside a transaction (begin)", async () => {
		const client = new FakeAuthUserSqlClient();
		let beganTransaction = false;
		const original = client.begin.bind(client);
		client.begin = async (fn) => {
			beganTransaction = true;
			return original(fn);
		};
		const store = new PostgresAuthUserStore(client);
		const user = createUser();
		await store.create(user);
		await store.linkExternalIdentity(user.id, { provider: "oidc", subject: "issuer|x", emailVerified: true });
		expect(beganTransaction).toBe(true);
	});

	test("linkExternalIdentity is atomic: a mid-flow failure rolls back the identity insert", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		const user = createUser();
		await store.create(user);

		// Force the auth_users UPDATE (the last step) to throw, after the identity
		// INSERT has already happened inside the same transaction.
		const realUnsafe = client.unsafe.bind(client);
		client.unsafe = async <T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> => {
			if (/UPDATE auth_users\s+SET auth_provider =/i.test(query)) {
				throw new Error("boom: update failed mid-flow");
			}
			return realUnsafe<T>(query, params);
		};

		await expect(
			store.linkExternalIdentity(user.id, { provider: "github", subject: "github|rollback", emailVerified: true }),
		).rejects.toThrow("boom: update failed mid-flow");

		// Restore and assert no partial identity row leaked (rolled back).
		client.unsafe = realUnsafe;
		expect(client.identities.find((row) => row.provider_user_id === "github|rollback")).toBeUndefined();
		await expect(store.findByExternalIdentity("github", "github|rollback")).resolves.toBeNull();
		// The user's primary identity stayed local (UPDATE never committed).
		const reloaded = await store.load(user.id);
		expect(reloaded?.authProvider).toBe("local");
		expect(reloaded?.externalSubject).toBeUndefined();
	});

	test("listPaginated preserves the exact returned user shape", async () => {
		const client = new FakeAuthUserSqlClient();
		const store = new PostgresAuthUserStore(client);
		const user = createUser();
		await store.create(user);
		await store.linkExternalIdentity(user.id, { provider: "oidc", subject: "issuer|shape", emailVerified: true });

		const direct = await store.load(user.id);
		const page = await store.listPaginated({ limit: 50 });
		const fromList = page.users.find((u) => u.id === user.id);
		expect(fromList).toEqual(direct);
	});

	test("FileAuthUserStore.listPaginated paginates and bounds in file mode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "auth-users-file-"));
		try {
			const store = new FileAuthUserStore(dir);
			const names = ["Bravo", "alpha", "Charlie", "delta"];
			for (let i = 0; i < names.length; i++) {
				await store.create({ ...createUser(), id: `f-${i}`, email: `f${i}@example.com`, name: names[i] });
			}
			const page1 = await store.listPaginated({ limit: 2 });
			expect(page1.users.map((u) => u.name)).toEqual(["alpha", "Bravo"]);
			expect(page1.nextCursor).toEqual({ name: "bravo", userId: "f-0" });

			const page2 = await store.listPaginated({ limit: 2, cursor: page1.nextCursor });
			expect(page2.users.map((u) => u.name)).toEqual(["Charlie", "delta"]);
			expect(page2.nextCursor).toBeNull();

			const filtered = await store.listPaginated({ search: "charlie" });
			expect(filtered.users.map((u) => u.id)).toEqual(["f-2"]);

			// count(): honest grand total, search-aware, in file mode too.
			expect(await store.count()).toBe(4);
			expect(await store.count({ search: "charlie" })).toBe(1);

			// Role/status filters are applied before slicing in file mode, matching
			// postgres semantics instead of post-filtering an unfiltered page.
			await store.create({ ...createUser(), id: "f-4", email: "f4@example.com", name: "echo", role: "editor", isActive: false });
			await store.create({ ...createUser(), id: "f-5", email: "f5@example.com", name: "foxtrot", role: "editor", isActive: false });
			const disabledEditors = await store.listPaginated({ role: "editor", status: "disabled", limit: 2 });
			expect(disabledEditors.users.map((u) => u.id)).toEqual(["f-4", "f-5"]);
			expect(await store.count({ role: "editor", status: "disabled" })).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("owner-protected mutations (atomic last-owner guard)", () => {
	function owner(id: string): User {
		return { ...createUser(), id, email: `${id}@example.com`, name: id, role: "owner", isActive: true };
	}

	describe("PostgresAuthUserStore", () => {
		test("demoting the last active owner is rejected with LastPlatformOwnerError", async () => {
			const client = new FakeAuthUserSqlClient();
			const store = new PostgresAuthUserStore(client);
			await store.create(owner("solo-owner"));
			await expect(store.updateProtectingLastOwner("solo-owner", { role: "admin" })).rejects.toBeInstanceOf(
				LastPlatformOwnerError,
			);
			// Unchanged: still an active owner.
			expect((await store.load("solo-owner"))?.role).toBe("owner");
			expect((await store.load("solo-owner"))?.isActive).toBe(true);
		});

		test("disabling the last active owner is rejected", async () => {
			const client = new FakeAuthUserSqlClient();
			const store = new PostgresAuthUserStore(client);
			await store.create(owner("solo-owner"));
			await expect(store.updateProtectingLastOwner("solo-owner", { isActive: false })).rejects.toBeInstanceOf(
				LastPlatformOwnerError,
			);
			expect((await store.load("solo-owner"))?.isActive).toBe(true);
		});

		test("deleting the last active owner is rejected", async () => {
			const client = new FakeAuthUserSqlClient();
			const store = new PostgresAuthUserStore(client);
			await store.create(owner("solo-owner"));
			await expect(store.deleteProtectingLastOwner("solo-owner")).rejects.toBeInstanceOf(LastPlatformOwnerError);
			expect(await store.load("solo-owner")).not.toBeNull();
		});

		test("demote/disable/delete an owner is allowed while ANOTHER active owner exists", async () => {
			const client = new FakeAuthUserSqlClient();
			const store = new PostgresAuthUserStore(client);
			await store.create(owner("owner-a"));
			await store.create(owner("owner-b"));
			const demoted = await store.updateProtectingLastOwner("owner-a", { role: "admin" });
			expect(demoted?.role).toBe("admin");
			// owner-b is now the sole active owner; deleting it must fail.
			await expect(store.deleteProtectingLastOwner("owner-b")).rejects.toBeInstanceOf(LastPlatformOwnerError);
		});

		test("takes a pg_advisory_xact_lock and FOR UPDATE row lock inside the txn", async () => {
			const client = new FakeAuthUserSqlClient();
			const store = new PostgresAuthUserStore(client);
			await store.create(owner("owner-a"));
			await store.create(owner("owner-b"));
			client.queries.length = 0;
			await store.updateProtectingLastOwner("owner-a", { isActive: false });
			expect(client.queries.some((q) => /pg_advisory_xact_lock/i.test(q.query))).toBe(true);
			expect(client.queries.some((q) => /FROM auth_users\s+WHERE user_id = \$1\s+FOR UPDATE/i.test(q.query))).toBe(true);
			// The applied UPDATE carries the EXISTS(another active owner) guard.
			expect(client.queries.some((q) => /UPDATE auth_users/i.test(q.query) && /AND EXISTS/i.test(q.query))).toBe(true);
		});

		test("non-owner mutations skip the EXISTS owner guard (plain update)", async () => {
			const client = new FakeAuthUserSqlClient();
			const store = new PostgresAuthUserStore(client);
			await store.create({ ...createUser(), id: "editor-1", email: "e1@example.com", role: "editor" });
			client.queries.length = 0;
			const updated = await store.updateProtectingLastOwner("editor-1", { isActive: false });
			expect(updated?.isActive).toBe(false);
			expect(client.queries.some((q) => /UPDATE auth_users/i.test(q.query) && /AND EXISTS/i.test(q.query))).toBe(false);
		});
	});

	describe("FileAuthUserStore", () => {
		test("serializes same-user partial updates so locale and name patches do not clobber each other", async () => {
			const dir = mkdtempSync(join(tmpdir(), "auth-user-partial-file-race-"));
			try {
				const store = new FileAuthUserStore(dir);
				await store.create({ ...createUser(), id: "partial-user", locale: "th" });

				await Promise.all([
					store.update("partial-user", { locale: "en" }),
					store.update("partial-user", { name: "Renamed Owner" }),
				]);

				expect(await store.load("partial-user")).toEqual(expect.objectContaining({
					name: "Renamed Owner",
					locale: "en",
				}));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("demote/disable/delete the last active owner is rejected; another owner allows it", async () => {
			const dir = mkdtempSync(join(tmpdir(), "owner-guard-file-"));
			try {
				const store = new FileAuthUserStore(dir);
				await store.create(owner("owner-a"));
				// Solo owner: all three destructive ops fail.
				await expect(store.updateProtectingLastOwner("owner-a", { role: "admin" })).rejects.toBeInstanceOf(
					LastPlatformOwnerError,
				);
				await expect(store.updateProtectingLastOwner("owner-a", { isActive: false })).rejects.toBeInstanceOf(
					LastPlatformOwnerError,
				);
				await expect(store.deleteProtectingLastOwner("owner-a")).rejects.toBeInstanceOf(LastPlatformOwnerError);

				// Add a second owner; now demoting the first is allowed.
				await store.create(owner("owner-b"));
				const demoted = await store.updateProtectingLastOwner("owner-a", { role: "admin" });
				expect(demoted?.role).toBe("admin");
				// owner-b is the only active owner left → delete must fail.
				await expect(store.deleteProtectingLastOwner("owner-b")).rejects.toBeInstanceOf(LastPlatformOwnerError);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("file-mode owner mutations are serialized: concurrent demote+disable keep one active owner", async () => {
			const dir = mkdtempSync(join(tmpdir(), "owner-guard-file-race-"));
			try {
				const store = new FileAuthUserStore(dir);
				await store.create(owner("owner-a"));
				await store.create(owner("owner-b"));
				// Fire both mutations "concurrently". The async mutex serializes them,
				// so the second observes the first's write and fails closed.
				const results = await Promise.allSettled([
					store.updateProtectingLastOwner("owner-a", { isActive: false }),
					store.updateProtectingLastOwner("owner-b", { role: "admin" }),
				]);
				const fulfilled = results.filter((r) => r.status === "fulfilled");
				const rejected = results.filter((r) => r.status === "rejected");
				expect(fulfilled).toHaveLength(1);
				expect(rejected).toHaveLength(1);
				expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastPlatformOwnerError);
				// At least one active owner always survives.
				expect(await store.countActiveByRole("owner")).toBeGreaterThanOrEqual(1);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

function createUser(): User {
	return {
		id: "user-auth-store",
		email: " Owner@Example.com ",
		passwordHash: "hash",
		name: "Owner",
		role: "editor",
		authProvider: "local",
		emailVerified: false,
		createdAt: "2026-05-28T03:00:00.000Z",
		updatedAt: "2026-05-28T03:00:00.000Z",
		isActive: true,
	};
}

function compareKeyset(aName: string, aId: string, bName: string, bId: string): number {
	if (aName < bName) return -1;
	if (aName > bName) return 1;
	if (aId < bId) return -1;
	if (aId > bId) return 1;
	return 0;
}

function compareRowsByKeyset(a: StoredAuthUserRow, b: StoredAuthUserRow): number {
	return compareKeyset(a.name.toLowerCase(), a.user_id, b.name.toLowerCase(), b.user_id);
}
