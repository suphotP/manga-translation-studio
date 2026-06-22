import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Context, Next } from "hono";
import {
	FileNotificationStore,
	NotificationStoreError,
	PostgresNotificationStore,
	categoryForNotificationType,
	type NotificationRecord,
} from "../services/notifications.js";
import { createNotificationsRouter } from "../routes/notifications.js";
import { FileNotificationPreferenceStore } from "../services/notification-preferences.js";
import type { NotifyInput, NotifyResult } from "../services/notification-dispatch.js";
import type { UserRole } from "../types/auth.js";

const tempDirs: string[] = [];

function createFileStore(): { store: FileNotificationStore; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "manga-notifications-store-"));
	tempDirs.push(directory);
	const path = join(directory, "notifications.json");
	return { store: new FileNotificationStore(path), path };
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("FileNotificationStore", () => {
	test("persists a notification and reads it back from a fresh instance", async () => {
		const { store, path } = createFileStore();

		const created = await store.create({
			userId: "user-1",
			workspaceId: "ws-1",
			type: "comment_new",
			title: "@you mentioned in page 4",
			body: "@editor please review",
			linkUrl: "/projects/proj-1/work?comment=c-1",
		});

		expect(created).toMatchObject({
			userId: "user-1",
			workspaceId: "ws-1",
			type: "comment_new",
			title: "@you mentioned in page 4",
		});
		expect(created.id).toEqual(expect.any(String));
		expect(created.readAt).toBeUndefined();

		const reloaded = new FileNotificationStore(path);
		const page = await reloaded.listForUser("user-1");
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.id).toBe(created.id);
	});

	test("dedupeKey collapses repeat creates to ONE row (durable + per-user) and findByDedupeKey resolves it", async () => {
		const { store, path } = createFileStore();
		const first = await store.create({ userId: "user-1", type: "payment_succeeded", title: "Receipt", dedupeKey: "dodo-receipt:pay_1:inapp" });
		const second = await store.create({ userId: "user-1", type: "payment_succeeded", title: "Receipt", dedupeKey: "dodo-receipt:pay_1:inapp" });
		// Same key → no second row; create() returns the already-stored row.
		expect(second.id).toBe(first.id);
		expect((await store.listForUser("user-1")).items).toHaveLength(1);

		// A different key (distinct charge) writes its own row.
		await store.create({ userId: "user-1", type: "payment_succeeded", title: "Receipt", dedupeKey: "dodo-receipt:pay_2:inapp" });
		expect((await store.listForUser("user-1")).items).toHaveLength(2);

		// Per-user scope: the same key for another user is independent.
		await store.create({ userId: "user-2", type: "payment_succeeded", title: "Receipt", dedupeKey: "dodo-receipt:pay_1:inapp" });
		expect((await store.listForUser("user-2")).items).toHaveLength(1);

		// findByDedupeKey resolves the stored row; survives a reload (durable).
		expect((await store.findByDedupeKey("user-1", "dodo-receipt:pay_1:inapp"))?.id).toBe(first.id);
		const reloaded = new FileNotificationStore(path);
		expect(await reloaded.findByDedupeKey("user-1", "dodo-receipt:pay_1:inapp")).not.toBeNull();
		// The reloaded store still refuses a duplicate insert for the same key.
		const afterReload = await reloaded.create({ userId: "user-1", type: "payment_succeeded", title: "Receipt", dedupeKey: "dodo-receipt:pay_1:inapp" });
		expect(afterReload.id).toBe(first.id);
		expect((await reloaded.listForUser("user-1")).items).toHaveLength(2);
	});

	test("erasePiiForUser deletes the subject's inbox, leaves other users untouched, is idempotent + persisted", async () => {
		const { store, path } = createFileStore();
		await store.create({ userId: "user-1", type: "comment_new", title: "PII one" });
		await store.create({ userId: "user-1", type: "comment_new", title: "PII two" });
		await store.create({ userId: "user-2", type: "comment_new", title: "Keep me" });

		const removed = await store.erasePiiForUser("user-1");
		expect(removed).toBe(2);
		expect((await store.listForUser("user-1")).items).toHaveLength(0);
		expect((await store.listForUser("user-2")).items).toHaveLength(1);

		// Idempotent: re-running removes nothing.
		expect(await store.erasePiiForUser("user-1")).toBe(0);

		// Persisted: a fresh instance still shows the inbox gone.
		const reloaded = new FileNotificationStore(path);
		expect((await reloaded.listForUser("user-1")).items).toHaveLength(0);
		expect((await reloaded.listForUser("user-2")).items).toHaveLength(1);
	});

	test("listForUser scopes by user and orders newest first", async () => {
		const { store } = createFileStore();
		const a = await store.create({ userId: "user-1", type: "comment_new", title: "A" });
		await Bun.sleep(2);
		const b = await store.create({ userId: "user-1", type: "comment_reply", title: "B" });
		await Bun.sleep(2);
		const c = await store.create({ userId: "user-1", type: "ai_job_complete", title: "C" });
		await store.create({ userId: "user-2", type: "comment_new", title: "Other user" });

		const page = await store.listForUser("user-1");
		expect(page.items.map((entry) => entry.id)).toEqual([c.id, b.id, a.id]);
		expect(page.hasMore).toBe(false);
	});

	test("listForUser supports keyset pagination via beforeId", async () => {
		const { store } = createFileStore();
		const created: NotificationRecord[] = [];
		for (let i = 0; i < 5; i += 1) {
			created.push(await store.create({ userId: "user-1", type: "comment_new", title: `n-${i}` }));
			await Bun.sleep(1);
		}

		const firstPage = await store.listForUser("user-1", { limit: 2 });
		expect(firstPage.items).toHaveLength(2);
		expect(firstPage.hasMore).toBe(true);
		expect(firstPage.items.map((entry) => entry.title)).toEqual(["n-4", "n-3"]);

		const secondPage = await store.listForUser("user-1", { limit: 2, beforeId: firstPage.items[1]!.id });
		expect(secondPage.items.map((entry) => entry.title)).toEqual(["n-2", "n-1"]);
		expect(secondPage.hasMore).toBe(true);

		const thirdPage = await store.listForUser("user-1", { limit: 2, beforeId: secondPage.items[1]!.id });
		expect(thirdPage.items.map((entry) => entry.title)).toEqual(["n-0"]);
		expect(thirdPage.hasMore).toBe(false);
	});

	test("listForUser unreadOnly filters out read notifications", async () => {
		const { store } = createFileStore();
		const a = await store.create({ userId: "user-1", type: "comment_new", title: "A" });
		await Bun.sleep(2);
		await store.create({ userId: "user-1", type: "comment_reply", title: "B" });
		await store.markRead("user-1", a.id);

		const unread = await store.listForUser("user-1", { unreadOnly: true });
		expect(unread.items.map((entry) => entry.title)).toEqual(["B"]);
		const all = await store.listForUser("user-1");
		expect(all.items.map((entry) => entry.title)).toEqual(["B", "A"]);
	});

	test("unreadOnly keyset still advances when the cursor row was read after paging", async () => {
		// Regression: the next unread page must NOT restart at page one when the
		// beforeId row was marked read since the previous page loaded. Older unread
		// rows have to keep flowing, with no duplicate first-page results.
		const { store } = createFileStore();
		const created: NotificationRecord[] = [];
		for (let i = 0; i < 4; i += 1) {
			created.push(await store.create({ userId: "user-1", type: "comment_new", title: `n-${i}` }));
			await Bun.sleep(1);
		}
		// newest -> oldest: n-3, n-2, n-1, n-0
		const firstPage = await store.listForUser("user-1", { limit: 2, unreadOnly: true });
		expect(firstPage.items.map((entry) => entry.title)).toEqual(["n-3", "n-2"]);
		expect(firstPage.hasMore).toBe(true);

		// User reads the cursor row (the last cached unread row) before paging.
		const cursorId = firstPage.items[1]!.id; // n-2
		await store.markRead("user-1", cursorId);

		// The cursor row is no longer in the unread-filtered list; the next page
		// must still return the OLDER unread rows, not restart from n-3.
		const secondPage = await store.listForUser("user-1", { limit: 2, beforeId: cursorId, unreadOnly: true });
		expect(secondPage.items.map((entry) => entry.title)).toEqual(["n-1", "n-0"]);
		expect(secondPage.hasMore).toBe(false);
	});

	test("markRead sets read_at idempotently and scoping is by user", async () => {
		const { store } = createFileStore();
		const a = await store.create({ userId: "user-1", type: "comment_new", title: "A" });

		const updated = await store.markRead("user-1", a.id);
		expect(updated?.readAt).toEqual(expect.any(String));
		const second = await store.markRead("user-1", a.id);
		expect(second?.readAt).toBe(updated?.readAt); // idempotent

		// Wrong user must not see / mutate
		expect(await store.markRead("user-2", a.id)).toBeNull();
	});

	test("markAllRead returns the number it actually flipped and is no-op afterwards", async () => {
		const { store } = createFileStore();
		await store.create({ userId: "user-1", type: "comment_new", title: "A" });
		await store.create({ userId: "user-1", type: "comment_reply", title: "B" });
		await store.create({ userId: "user-1", type: "ai_job_complete", title: "C" });

		expect(await store.markAllRead("user-1")).toBe(3);
		expect(await store.unreadCount("user-1")).toBe(0);
		expect(await store.markAllRead("user-1")).toBe(0);
	});

	test("unreadCount is scoped per user and tracks state", async () => {
		const { store } = createFileStore();
		const a = await store.create({ userId: "user-1", type: "comment_new", title: "A" });
		await store.create({ userId: "user-1", type: "comment_reply", title: "B" });
		await store.create({ userId: "user-2", type: "comment_new", title: "Other" });

		expect(await store.unreadCount("user-1")).toBe(2);
		expect(await store.unreadCount("user-2")).toBe(1);

		await store.markRead("user-1", a.id);
		expect(await store.unreadCount("user-1")).toBe(1);
	});

	test("rejects an unknown notification type", async () => {
		const { store } = createFileStore();
		await expect(store.create({ userId: "user-1", type: "bogus" as never, title: "X" })).rejects.toBeInstanceOf(NotificationStoreError);
	});

	test("rejects empty user and title", async () => {
		const { store } = createFileStore();
		await expect(store.create({ userId: " ", type: "comment_new", title: "X" })).rejects.toBeInstanceOf(NotificationStoreError);
		await expect(store.create({ userId: "user-1", type: "comment_new", title: "  " })).rejects.toBeInstanceOf(NotificationStoreError);
	});
});

describe("PostgresNotificationStore", () => {
	test("INSERT path passes the right SQL + params and returns a mapped record", async () => {
		const client = new FakeSqlClient();
		const store = new PostgresNotificationStore(client);

		client.insertRow = {
			id: "11111111-1111-1111-1111-111111111111",
			user_id: "user-1",
			workspace_id: "ws-1",
			type: "comment_new",
			title: "Hello",
			body: null,
			link_url: null,
			metadata: {},
			read_at: null,
			created_at: new Date("2026-06-01T00:00:00Z"),
		};

		const created = await store.create({
			userId: "user-1",
			workspaceId: "ws-1",
			type: "comment_new",
			title: "Hello",
		});

		expect(created.id).toBe("11111111-1111-1111-1111-111111111111");
		expect(client.queries[0]?.query).toContain("INSERT INTO notifications");
		expect(client.queries[0]?.params?.[2]).toBe("comment_new");
	});

	test("listForUser embeds a (created_at,id) keyset cursor when beforeId is set", async () => {
		const client = new FakeSqlClient();
		const store = new PostgresNotificationStore(client);
		client.listRows = [];

		await store.listForUser("user-1", { limit: 5, beforeId: "00000000-0000-0000-0000-000000000099", unreadOnly: true });

		expect(client.queries[0]?.query).toContain("ORDER BY created_at DESC");
		expect(client.queries[0]?.query).toContain("read_at IS NULL");
		expect(client.queries[0]?.query).toContain("created_at, id");
		expect(client.queries[0]?.params).toEqual(["user-1", "00000000-0000-0000-0000-000000000099", "user-1", 6]);
	});

	test("markRead and markAllRead route to the expected statements", async () => {
		const client = new FakeSqlClient();
		const store = new PostgresNotificationStore(client);
		client.markReadRow = {
			id: "abc",
			user_id: "user-1",
			workspace_id: null,
			type: "comment_new",
			title: "x",
			body: null,
			link_url: null,
			metadata: null,
			read_at: new Date("2026-06-01T00:00:00Z"),
			created_at: new Date("2026-06-01T00:00:00Z"),
		};
		client.markAllCount = 7;

		await store.markRead("user-1", "abc");
		await store.markAllRead("user-1");

		expect(client.queries[0]?.query).toContain("UPDATE notifications");
		expect(client.queries[0]?.query).toContain("COALESCE(read_at, now())");
		expect(client.queries[1]?.query).toContain("WITH updated");

		expect(await store.unreadCount("user-1").catch(() => 0)).toBe(0);
		expect(client.queries[2]?.query).toContain("SELECT COUNT(*)");
	});

	test("markReadByIds binds ids as SCALAR ARRAY[...] params, never a JS array (Bun.SQL prod bug)", async () => {
		const client = new FakeSqlClient();
		const store = new PostgresNotificationStore(client);
		client.markAllCount = 2;

		const id1 = "11111111-1111-1111-1111-111111111111";
		const id2 = "22222222-2222-2222-2222-222222222222";
		// (The FakeSqlClient routes by SQL substring, so the returned count isn't
		// meaningful here — this test asserts the BIND SHAPE, which is the prod bug.)
		await store.markReadByIds("user-1", [id1, id2]);

		const q = client.queries[0];
		// Must use the scalar-bind ARRAY[...] form — NOT `= ANY($n::uuid[])` with a JS
		// array, which Bun.SQL serializes to the bare text `a,b` and Postgres rejects
		// with "malformed array literal" (silent prod break of mark-all-read).
		expect(q?.query).toContain("ARRAY[");
		expect(q?.query).not.toMatch(/ANY\(\$\d+::uuid\[\]\)/);
		// Each id is its own scalar param after the userId bind — never a nested array.
		expect(q?.params).toEqual(["user-1", id1, id2]);
		for (const param of q?.params ?? []) {
			expect(Array.isArray(param)).toBe(false);
		}
	});

	// F2 (round-3): the WHERE NOT EXISTS pre-check is NOT race-authoritative under READ
	// COMMITTED — two concurrent inserts for the same (user_id, __dedupeKey) can both pass
	// it. The partial UNIQUE index (migration 0080) is the backstop: the losing insert raises
	// SQLSTATE 23505, which create() must treat as "already exists" and resolve to the row
	// that won, collapsing the race to ONE row (no thrown error, no second row).
	test("dedupe create: a concurrent 23505 unique-violation resolves to the existing row (no throw)", async () => {
		const existingRow = {
			id: "99999999-9999-9999-9999-999999999999",
			user_id: "user-1",
			workspace_id: "ws-1",
			type: "payment_succeeded",
			title: "Receipt",
			body: null,
			link_url: null,
			metadata: { __dedupeKey: "dodo-receipt:inv_X:inapp" },
			read_at: null,
			created_at: new Date("2026-06-01T00:00:00Z"),
		};
		// A fake that simulates: the NOT EXISTS pre-check passed (a concurrent worker had not
		// yet committed), then the INSERT lost the unique-index race → 23505; the follow-up
		// SELECT returns the row the winner committed.
		const client = {
			queries: [] as Array<{ query: string }>,
			async unsafe<T = Record<string, unknown>>(query: string): Promise<T[]> {
				this.queries.push({ query });
				if (query.includes("INSERT INTO notifications") && query.includes("WHERE NOT EXISTS")) {
					const err = new Error('duplicate key value violates unique constraint "notifications_user_dedupe_key_uniq"') as Error & { code?: string };
					err.code = "23505";
					throw err;
				}
				if (query.includes("ORDER BY created_at ASC")) {
					return [existingRow] as T[];
				}
				return [] as T[];
			},
		};
		const store = new PostgresNotificationStore(client as never);

		const result = await store.create({
			userId: "user-1",
			workspaceId: "ws-1",
			type: "payment_succeeded",
			title: "Receipt",
			dedupeKey: "dodo-receipt:inv_X:inapp",
		});

		// The 23505 is swallowed and resolved to the winning row — exactly ONE row survives.
		expect(result.id).toBe("99999999-9999-9999-9999-999999999999");
		// We DID attempt the insert and then fell through to the existing-row SELECT.
		expect(client.queries.some((q) => q.query.includes("WHERE NOT EXISTS"))).toBe(true);
		expect(client.queries.some((q) => q.query.includes("ORDER BY created_at ASC"))).toBe(true);
	});

	test("dedupe create: a NON-23505 insert error still propagates (not swallowed)", async () => {
		const client = {
			async unsafe<T = Record<string, unknown>>(query: string): Promise<T[]> {
				if (query.includes("INSERT INTO notifications") && query.includes("WHERE NOT EXISTS")) {
					const err = new Error("connection reset") as Error & { code?: string };
					err.code = "08006"; // connection_failure — NOT a unique violation
					throw err;
				}
				return [] as T[];
			},
		};
		const store = new PostgresNotificationStore(client as never);
		await expect(
			store.create({ userId: "user-1", type: "payment_succeeded", title: "Receipt", dedupeKey: "k" }),
		).rejects.toThrow("connection reset");
	});
});

// F2 (round-3): the migration that backs the race-authoritative dedupe constraint must
// exist, target the notifications table, be a partial UNIQUE index on the EXACT stored
// key expression, and exclude NULL keys (so the millions of keyless rows stay insertable).
describe("migration 0080 — notifications dedupe unique index", () => {
	test("creates a partial UNIQUE index on (user_id, metadata->>'__dedupeKey') excluding NULLs", () => {
		const sql = readFileSync(
			join(import.meta.dir, "..", "..", "migrations", "0080_notifications_dedupe_unique.sql"),
			"utf8",
		);
		expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_dedupe_key_uniq");
		expect(sql).toContain("ON notifications (user_id, (metadata->>'__dedupeKey'))");
		expect(sql).toContain("WHERE metadata->>'__dedupeKey' IS NOT NULL");
	});
});

describe("Notifications router", () => {
	test("GET /notifications returns only the current user's notifications", async () => {
		const store = new FileNotificationStore();
		// Bun.sleep separates creation timestamps so ordering is deterministic
		// without leaning on UUID lexical tie-breaking.
		await store.create({ userId: "user-1", type: "comment_new", title: "Mine A" });
		await Bun.sleep(2);
		await store.create({ userId: "user-2", type: "comment_new", title: "Theirs" });
		await Bun.sleep(2);
		await store.create({ userId: "user-1", type: "ai_job_complete", title: "Mine B" });

		const app = createNotificationsRouter({ store, authMiddleware: stubAuth("editor", "user-1") });
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ title: string; category: string }> };
		expect(body.items.map((entry) => entry.title)).toEqual(["Mine B", "Mine A"]);
		expect(body.items[0]?.category).toBe(categoryForNotificationType("ai_job_complete"));
	});

	test("GET /notifications honors unread_only and limit", async () => {
		const store = new FileNotificationStore();
		const a = await store.create({ userId: "user-1", type: "comment_new", title: "A" });
		await Bun.sleep(2);
		await store.create({ userId: "user-1", type: "comment_reply", title: "B" });
		await Bun.sleep(2);
		await store.create({ userId: "user-1", type: "ai_job_complete", title: "C" });
		await store.markRead("user-1", a.id);

		const app = createNotificationsRouter({ store, authMiddleware: stubAuth("editor", "user-1") });
		const res = await app.request("/?unread_only=true&limit=1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ title: string }>; hasMore: boolean };
		expect(body.items).toHaveLength(1);
		expect(body.items[0]?.title).toBe("C");
		expect(body.hasMore).toBe(true);
	});

	test("GET /notifications rejects an invalid limit with 400", async () => {
		const store = new FileNotificationStore();
		const app = createNotificationsRouter({ store, authMiddleware: stubAuth("editor", "user-1") });
		const res = await app.request("/?limit=999");
		expect(res.status).toBe(400);
	});

	test("GET /unread-count returns the per-user count", async () => {
		const store = new FileNotificationStore();
		await store.create({ userId: "user-1", type: "comment_new", title: "A" });
		await store.create({ userId: "user-1", type: "comment_new", title: "B" });
		await store.create({ userId: "user-2", type: "comment_new", title: "Other" });

		const app = createNotificationsRouter({ store, authMiddleware: stubAuth("editor", "user-1") });
		const res = await app.request("/unread-count");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { count: number };
		expect(body.count).toBe(2);
	});

	test("POST /:id/read marks the user's own notification and rejects others", async () => {
		const store = new FileNotificationStore();
		const mine = await store.create({ userId: "user-1", type: "comment_new", title: "A" });
		const theirs = await store.create({ userId: "user-2", type: "comment_new", title: "Other" });

		const app = createNotificationsRouter({ store, authMiddleware: stubAuth("editor", "user-1") });
		const mineRes = await app.request(`/${mine.id}/read`, { method: "POST" });
		expect(mineRes.status).toBe(200);
		expect(await store.unreadCount("user-1")).toBe(0);

		const theirsRes = await app.request(`/${theirs.id}/read`, { method: "POST" });
		expect(theirsRes.status).toBe(404);
		expect(await store.unreadCount("user-2")).toBe(1);
	});

	test("POST /mark-all-read returns the number flipped", async () => {
		const store = new FileNotificationStore();
		await store.create({ userId: "user-1", type: "comment_new", title: "A" });
		await store.create({ userId: "user-1", type: "comment_reply", title: "B" });

		const app = createNotificationsRouter({ store, authMiddleware: stubAuth("editor", "user-1") });
		const res = await app.request("/mark-all-read", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { updated: number };
		expect(body.updated).toBe(2);
		expect(await store.unreadCount("user-1")).toBe(0);
	});

	test("POST / (create) is admin-only", async () => {
		const store = new FileNotificationStore();
		const editorApp = createNotificationsRouter({ store, authMiddleware: stubAuth("editor", "user-1") });
		const editorRes = await editorApp.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "user-2", type: "comment_new", title: "Hi" }),
		});
		expect(editorRes.status).toBe(403);

		const adminApp = createNotificationsRouter({ store, authMiddleware: stubAuth("admin", "admin-1") });
		const adminRes = await adminApp.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "user-2", type: "comment_new", title: "Hi" }),
		});
		expect(adminRes.status).toBe(201);
		const body = (await adminRes.json()) as { notification: { title: string; category: string } };
		expect(body.notification.title).toBe("Hi");
		expect(body.notification.category).toBe("tasks");
	});

	test("POST / routes through the dispatcher (honors prefs + sends default-on email) — not store.create() directly", async () => {
		const store = new FileNotificationStore();
		const preferenceStore = new FileNotificationPreferenceStore();
		// The recipient turned the IN-APP channel OFF for this type — a direct store.create()
		// (the old bug) would write it anyway; routing through notify() must honor the pref
		// and SKIP the in-app write while the default-on email still fires.
		await preferenceStore.setMany("user-2", [{ type: "comment_new", channel: "in_app", enabled: false }]);

		const calls: NotifyInput[] = [];
		const notifySpy = async (input: NotifyInput): Promise<NotifyResult> => {
			calls.push(input);
			return { inAppDelivered: false, emailAttempted: true, skipped: [] };
		};
		const app = createNotificationsRouter({
			store,
			preferenceStore,
			authMiddleware: stubAuth("admin", "admin-1"),
			notify: notifySpy,
		});
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "user-2", type: "comment_new", title: "Hi" }),
		});
		expect(res.status).toBe(201);
		// The producer went THROUGH notify() (the central dispatcher), not store.create().
		expect(calls).toHaveLength(1);
		expect(calls[0]?.userId).toBe("user-2");
		expect(calls[0]?.type).toBe("comment_new");
		const body = (await res.json()) as { dispatched: NotifyResult };
		expect(body.dispatched.emailAttempted).toBe(true);
	});

	test("POST / with the default dispatcher honors an in-app OFF pref (no store row written)", async () => {
		const store = new FileNotificationStore();
		const preferenceStore = new FileNotificationPreferenceStore();
		await preferenceStore.setMany("user-2", [{ type: "comment_new", channel: "in_app", enabled: false }]);
		// No notify spy → exercises the REAL dispatcher bound to this router's stores.
		const app = createNotificationsRouter({ store, preferenceStore, authMiddleware: stubAuth("admin", "admin-1") });
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "user-2", type: "comment_new", title: "Hi" }),
		});
		expect(res.status).toBe(201);
		// in_app pref is OFF → the dispatcher must NOT have written a store row (the old
		// store.create() path ignored prefs and would have written one).
		const page = await store.listForUser("user-2", {});
		expect(page.items).toHaveLength(0);
	});

	test("POST / validates the body", async () => {
		const store = new FileNotificationStore();
		const adminApp = createNotificationsRouter({ store, authMiddleware: stubAuth("admin", "admin-1") });
		const res = await adminApp.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "user-2", type: "bogus", title: "Hi" }),
		});
		expect(res.status).toBe(400);
	});

	test("GET /preferences returns the effective matrix scoped to the current user", async () => {
		const store = new FileNotificationStore();
		const preferenceStore = new FileNotificationPreferenceStore();
		await preferenceStore.setMany("user-1", [{ type: "comment_new", channel: "email", enabled: true }]);
		await preferenceStore.setMany("user-2", [{ type: "comment_new", channel: "email", enabled: false }]);

		const app = createNotificationsRouter({ store, preferenceStore, authMiddleware: stubAuth("editor", "user-1") });
		const res = await app.request("/preferences");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			types: string[];
			channels: string[];
			values: Record<string, { email: boolean; in_app: boolean }>;
			defaults: Record<string, { email: boolean; in_app: boolean }>;
		};
		expect(body.channels).toEqual(["email", "in_app"]);
		// user-1's override flips comment_new email ON; user-2's override must not leak.
		expect(body.values.comment_new?.email).toBe(true);
		expect(body.defaults.comment_new?.email).toBe(false);
	});

	test("PUT /preferences upserts the current user's overrides and never trusts a body userId", async () => {
		const store = new FileNotificationStore();
		const preferenceStore = new FileNotificationPreferenceStore();
		const app = createNotificationsRouter({ store, preferenceStore, authMiddleware: stubAuth("editor", "user-1") });

		const res = await app.request("/preferences", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			// userId in the body must be ignored — scoping comes from auth only.
			body: JSON.stringify({ userId: "user-2", updates: [{ type: "ticket_replied", channel: "email", enabled: false }] }),
		});
		// The strict schema rejects the extra userId key, proving the body can't smuggle scope.
		expect(res.status).toBe(400);

		const ok = await app.request("/preferences", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ updates: [{ type: "ticket_replied", channel: "email", enabled: false }] }),
		});
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { updated: number; preferences: { values: Record<string, { email: boolean }> } };
		expect(body.updated).toBe(1);
		expect(body.preferences.values.ticket_replied?.email).toBe(false);
		// The write landed under user-1, not the body's user-2.
		expect(await preferenceStore.isEnabled("user-1", "ticket_replied", "email")).toBe(false);
		expect(await preferenceStore.isEnabled("user-2", "ticket_replied", "email")).toBe(true);
	});

	test("PUT /preferences rejects an unknown type/channel with 400", async () => {
		const store = new FileNotificationStore();
		const preferenceStore = new FileNotificationPreferenceStore();
		const app = createNotificationsRouter({ store, preferenceStore, authMiddleware: stubAuth("editor", "user-1") });
		const res = await app.request("/preferences", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ updates: [{ type: "bogus", channel: "email", enabled: true }] }),
		});
		expect(res.status).toBe(400);
	});
});

describe("Notifications router — workspace-scoped delivery (a16 #5)", () => {
	/**
	 * Membership oracle: `userId` is a member of every workspace in its set.
	 * Workspace-less notifications never consult this.
	 */
	function membershipOf(memberships: Record<string, string[]>) {
		return async (workspaceId: string, userId: string): Promise<boolean> =>
			(memberships[workspaceId] ?? []).includes(userId);
	}

	test("a user NEVER receives a notification for a workspace they are not a member of", async () => {
		const store = new FileNotificationStore();
		// user-1 is a member of ws-A only. ws-B notifications must be invisible.
		await store.create({ userId: "user-1", workspaceId: "ws-A", type: "comment_new", title: "A-visible" });
		await Bun.sleep(2);
		await store.create({ userId: "user-1", workspaceId: "ws-B", type: "comment_new", title: "B-leaked" });
		await Bun.sleep(2);
		await store.create({ userId: "user-1", type: "payment_succeeded", title: "Personal-visible" });

		const app = createNotificationsRouter({
			store,
			authMiddleware: stubAuth("editor", "user-1"),
			membershipFilter: membershipOf({ "ws-A": ["user-1"] }),
		});

		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ title: string; workspaceId?: string }> };
		const titles = body.items.map((entry) => entry.title);
		// The ws-B notification (user not a member) is dropped; ws-A + personal remain.
		expect(titles).toContain("A-visible");
		expect(titles).toContain("Personal-visible");
		expect(titles).not.toContain("B-leaked");
	});

	test("unread-count counts only membership-visible notifications (matches the list)", async () => {
		const store = new FileNotificationStore();
		await store.create({ userId: "user-1", workspaceId: "ws-A", type: "comment_new", title: "A" });
		await store.create({ userId: "user-1", workspaceId: "ws-B", type: "comment_new", title: "B-leaked" });
		await store.create({ userId: "user-1", type: "payment_succeeded", title: "Personal" });

		const app = createNotificationsRouter({
			store,
			authMiddleware: stubAuth("editor", "user-1"),
			membershipFilter: membershipOf({ "ws-A": ["user-1"] }),
		});

		const res = await app.request("/unread-count");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { count: number };
		// ws-A + personal are unread+visible; the ws-B one is excluded → count is 2,
		// the SAME source of truth as the list (the badge can't show the leaked one).
		expect(body.count).toBe(2);
	});

	test("mark-read on a left-workspace notification returns 404 (no existence leak)", async () => {
		const store = new FileNotificationStore();
		const left = await store.create({ userId: "user-1", workspaceId: "ws-B", type: "comment_new", title: "B-leaked" });

		const app = createNotificationsRouter({
			store,
			authMiddleware: stubAuth("editor", "user-1"),
			membershipFilter: membershipOf({ "ws-A": ["user-1"] }),
		});

		const res = await app.request(`/${left.id}/read`, { method: "POST" });
		expect(res.status).toBe(404);
	});

	test("membership lookup failure fails CLOSED for a workspace notification", async () => {
		const store = new FileNotificationStore();
		await store.create({ userId: "user-1", workspaceId: "ws-X", type: "comment_new", title: "WS" });
		await store.create({ userId: "user-1", type: "payment_succeeded", title: "Personal" });

		const app = createNotificationsRouter({
			store,
			authMiddleware: stubAuth("editor", "user-1"),
			membershipFilter: async () => {
				throw new Error("membership store down");
			},
		});

		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ title: string }> };
		const titles = body.items.map((entry) => entry.title);
		// Workspace notification fails closed (excluded); personal still delivered.
		expect(titles).toEqual(["Personal"]);
	});

	// ── a16 re-review P1 #2 — unscoped read mutation ─────────────────────────────

	test("mark-all-read does NOT mutate a notification in a workspace the user has LEFT", async () => {
		const store = new FileNotificationStore();
		// user-1 is currently a member of ws-A only. The ws-B notification is from a
		// workspace they have left — mark-all-read must not flip it read.
		const aVisible = await store.create({ userId: "user-1", workspaceId: "ws-A", type: "comment_new", title: "A" });
		const bLeft = await store.create({ userId: "user-1", workspaceId: "ws-B", type: "comment_new", title: "B-left" });
		const personal = await store.create({ userId: "user-1", type: "payment_succeeded", title: "Personal" });

		const app = createNotificationsRouter({
			store,
			authMiddleware: stubAuth("editor", "user-1"),
			membershipFilter: membershipOf({ "ws-A": ["user-1"] }),
		});

		const res = await app.request("/mark-all-read", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { updated: number };
		// Only the visible (ws-A + personal) ones were flipped — NOT the left ws-B one.
		expect(body.updated).toBe(2);

		// Assert directly against the store: the left-workspace notification is STILL unread.
		expect((await store.getForUser("user-1", aVisible.id))!.readAt).toBeTruthy();
		expect((await store.getForUser("user-1", personal.id))!.readAt).toBeTruthy();
		expect((await store.getForUser("user-1", bLeft.id))!.readAt).toBeUndefined();
	});

	test("POST /:id/read does NOT mutate a non-member (left-workspace) notification, then 404s", async () => {
		const store = new FileNotificationStore();
		const left = await store.create({ userId: "user-1", workspaceId: "ws-B", type: "comment_new", title: "B-left" });

		const app = createNotificationsRouter({
			store,
			authMiddleware: stubAuth("editor", "user-1"),
			membershipFilter: membershipOf({ "ws-A": ["user-1"] }),
		});

		const res = await app.request(`/${left.id}/read`, { method: "POST" });
		expect(res.status).toBe(404);
		// CRITICAL: the foreign notification must remain UNMUTATED (no mutate-then-404).
		const after = await store.getForUser("user-1", left.id);
		expect(after).not.toBeNull();
		expect(after!.readAt).toBeUndefined();
	});

	test("POST /:id/read DOES mark a current-membership notification read", async () => {
		const store = new FileNotificationStore();
		const mine = await store.create({ userId: "user-1", workspaceId: "ws-A", type: "comment_new", title: "A" });

		const app = createNotificationsRouter({
			store,
			authMiddleware: stubAuth("editor", "user-1"),
			membershipFilter: membershipOf({ "ws-A": ["user-1"] }),
		});

		const res = await app.request(`/${mine.id}/read`, { method: "POST" });
		expect(res.status).toBe(200);
		expect((await store.getForUser("user-1", mine.id))!.readAt).toBeTruthy();
	});

	test("a chapter-team collaborator (not a workspace member) STILL sees their own chapter's notification via metadata.projectId", async () => {
		const store = new FileNotificationStore();
		// user-2 is NOT a workspace member of ws-A, but IS an active chapter-team
		// member of project proj-1 (which lives in ws-A). Their review/revision/cancel
		// notifications carry workspaceId=ws-A + metadata.projectId=proj-1 and must be
		// delivered — this is the team-collaboration integration the email-invite flow
		// depends on. A ws-A notification WITHOUT a project they belong to stays hidden.
		await store.create({ userId: "user-2", workspaceId: "ws-A", type: "work_assigned", title: "Chapter review", metadata: { projectId: "proj-1" } });
		await Bun.sleep(2);
		await store.create({ userId: "user-2", workspaceId: "ws-A", type: "comment_new", title: "Other-chapter-leaked", metadata: { projectId: "proj-OTHER" } });
		await Bun.sleep(2);
		await store.create({ userId: "user-2", workspaceId: "ws-A", type: "comment_new", title: "No-project-leaked" });

		// Project-aware oracle: user-2 is not a workspace member, but is granted
		// visibility for proj-1 (their chapter-team project) only.
		const projectAwareMembership = async (workspaceId: string, userId: string, projectId?: string): Promise<boolean> => {
			if (workspaceId === "ws-A" && userId === "user-2") return projectId === "proj-1";
			return false;
		};

		const app = createNotificationsRouter({
			store,
			authMiddleware: stubAuth("editor", "user-2"),
			membershipFilter: projectAwareMembership,
		});

		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ title: string }> };
		const titles = body.items.map((entry) => entry.title);
		expect(titles).toContain("Chapter review");
		// A different project (not on their roster) and a project-less ws-A notice stay hidden.
		expect(titles).not.toContain("Other-chapter-leaked");
		expect(titles).not.toContain("No-project-leaked");

		// The badge count matches the list (only the in-scope project notice).
		const countRes = await app.request("/unread-count");
		expect(((await countRes.json()) as { count: number }).count).toBe(1);
	});
});

function stubAuth(role: UserRole, userId: string) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${userId}@example.com`, role });
		await next();
	};
}

class FakeSqlClient {
	queries: Array<{ query: string; params?: unknown[] }> = [];
	insertRow: Record<string, unknown> | null = null;
	listRows: Array<Record<string, unknown>> = [];
	markReadRow: Record<string, unknown> | null = null;
	markAllCount = 0;

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		if (query.includes("INSERT INTO notifications")) {
			return (this.insertRow ? [this.insertRow] : []) as T[];
		}
		if (query.includes("UPDATE notifications")) {
			return (this.markReadRow ? [this.markReadRow] : []) as T[];
		}
		if (query.includes("WITH updated")) {
			return [{ count: this.markAllCount }] as T[];
		}
		if (query.includes("SELECT COUNT(*)")) {
			return [{ count: 0 }] as T[];
		}
		if (query.includes("FROM notifications")) {
			return this.listRows as T[];
		}
		return [] as T[];
	}
}
