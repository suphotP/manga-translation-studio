// Unit tests for the pending-invite INDEX store (codex P1, PR #394) — the bounded,
// indexed replacement for the old global state.json scan behind GET /my/invites.
//
// Covers BOTH backends in isolation (no real Postgres / no app boot):
//   - FilePendingInviteIndexStore: create adds an entry; accept/remove (set-replace
//     with a shrunk set) clears it; lookup is keyed + bounded by email.
//   - PostgresPendingInviteIndexStore: set-replace emits a complement DELETE + upsert,
//     and listForEmail issues a single email-keyed point query (NOT a scan), capped.
//   - derivePendingInviteEntries: only pending, account-UNLINKED email rows index.

import { describe, expect, test } from "bun:test";
import {
	FilePendingInviteIndexStore,
	PostgresPendingInviteIndexStore,
	derivePendingInviteEntries,
	MAX_PENDING_INVITES_PER_EMAIL,
	type PendingInviteEntry,
	type PendingInviteSqlClient,
} from "../services/pending-invite-index.js";

function entry(over: Partial<PendingInviteEntry> = {}): PendingInviteEntry {
	return {
		memberId: over.memberId ?? "m1",
		projectId: over.projectId ?? "p1",
		inviteeEmail: over.inviteeEmail ?? "invitee@example.com",
		role: over.role ?? "translator",
		invitedBy: over.invitedBy,
		chapterLabel: over.chapterLabel ?? "Ch 1",
		storyTitle: over.storyTitle,
		invitedAt: over.invitedAt ?? new Date().toISOString(),
	};
}

describe("derivePendingInviteEntries — only pending, unlinked email invites index", () => {
	test("includes a pending email invite; excludes active / UID-linked / no-email rows", () => {
		const entries = derivePendingInviteEntries({
			projectId: "p1",
			chapterLabel: "Chapter 7",
			storyTitle: "My Story",
			chapterTeam: [
				{ id: "a", email: "Pending@Example.com", role: "qc", status: "pending", createdAt: "2026-01-01T00:00:00Z", invitedBy: "owner" },
				{ id: "b", userId: "u-linked", email: "linked@example.com", role: "cleaner", status: "pending", createdAt: "2026-01-01T00:00:00Z" },
				{ id: "c", userId: "u-active", email: "active@example.com", role: "typesetter", status: "active", createdAt: "2026-01-01T00:00:00Z" },
				{ id: "d", role: "guest", status: "pending", createdAt: "2026-01-01T00:00:00Z" },
			],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]!.memberId).toBe("a");
		// Email is normalized (trim + lowercase) for the equality-keyed lookup.
		expect(entries[0]!.inviteeEmail).toBe("pending@example.com");
		expect(entries[0]!.role).toBe("qc");
		expect(entries[0]!.chapterLabel).toBe("Chapter 7");
	});
});

describe("FilePendingInviteIndexStore", () => {
	test("syncProject adds entries; listForEmail returns them keyed by email", async () => {
		const store = new FilePendingInviteIndexStore();
		await store.syncProject("p1", [entry({ memberId: "m1", inviteeEmail: "a@x.com" })]);
		await store.syncProject("p2", [entry({ projectId: "p2", memberId: "m2", inviteeEmail: "a@x.com" })]);
		await store.syncProject("p3", [entry({ projectId: "p3", memberId: "m3", inviteeEmail: "b@x.com" })]);

		const forA = await store.listForEmail("A@X.com"); // case-insensitive
		expect(forA.map((e) => e.projectId).sort()).toEqual(["p1", "p2"]);
		const forB = await store.listForEmail("b@x.com");
		expect(forB.map((e) => e.projectId)).toEqual(["p3"]);
		expect(await store.listForEmail("nobody@x.com")).toEqual([]);
	});

	test("set-replace with a shrunk set clears an accepted/removed invite", async () => {
		const store = new FilePendingInviteIndexStore();
		await store.syncProject("p1", [
			entry({ memberId: "m1", inviteeEmail: "a@x.com" }),
			entry({ memberId: "m2", inviteeEmail: "b@x.com" }),
		]);
		expect((await store.listForEmail("a@x.com"))).toHaveLength(1);
		// m1 accepted/removed → next sync omits it (derive produced only m2).
		await store.syncProject("p1", [entry({ memberId: "m2", inviteeEmail: "b@x.com" })]);
		expect(await store.listForEmail("a@x.com")).toEqual([]);
		expect((await store.listForEmail("b@x.com"))).toHaveLength(1);
		// Empty set drops the project entirely.
		await store.syncProject("p1", []);
		expect(await store.listForEmail("b@x.com")).toEqual([]);
	});

	test("removeProject drops every entry for the project", async () => {
		const store = new FilePendingInviteIndexStore();
		await store.syncProject("p1", [entry({ memberId: "m1", inviteeEmail: "a@x.com" })]);
		await store.removeProject("p1");
		expect(await store.listForEmail("a@x.com")).toEqual([]);
	});

	test("listForEmail is bounded by limit", async () => {
		const store = new FilePendingInviteIndexStore();
		await store.syncProject("p1", Array.from({ length: 5 }, (_, i) =>
			entry({ memberId: `m${i}`, inviteeEmail: "a@x.com", invitedAt: `2026-01-0${i + 1}T00:00:00Z` }),
		));
		expect(await store.listForEmail("a@x.com", 2)).toHaveLength(2);
	});
});

// A fake SQL client capturing every query so we can assert the SHAPE of what the
// Postgres store issues (a complement DELETE + per-row upsert for set-replace; a
// single email-keyed point SELECT for the lookup — never a corpus scan).
function fakeSql(rows: Record<string, unknown[]> = {}): {
	client: PendingInviteSqlClient;
	queries: string[];
} {
	const queries: string[] = [];
	const client: PendingInviteSqlClient = {
		async unsafe<T = unknown>(query: string): Promise<T[]> {
			const q = query.trim();
			queries.push(q);
			if (q.startsWith("SELECT")) return (rows.select ?? []) as unknown as T[];
			return [] as unknown as T[];
		},
		async begin<T>(fn: (tx: PendingInviteSqlClient) => Promise<T>): Promise<T> {
			return fn(client);
		},
	};
	return { client, queries };
}

describe("PostgresPendingInviteIndexStore", () => {
	test("syncProject set-replace: complement DELETE + upsert per kept row", async () => {
		const fake = fakeSql();
		const store = new PostgresPendingInviteIndexStore(fake.client);
		await store.syncProject("p1", [
			entry({ memberId: "m1", inviteeEmail: "a@x.com" }),
			entry({ memberId: "m2", inviteeEmail: "b@x.com" }),
		]);
		// One DELETE that keeps only the current member ids, plus two upserts.
		const deletes = fake.queries.filter((q) => q.startsWith("DELETE") && q.includes("NOT IN"));
		const upserts = fake.queries.filter((q) => q.includes("INSERT INTO project_pending_invites"));
		expect(deletes).toHaveLength(1);
		expect(upserts).toHaveLength(2);
	});

	test("syncProject with an empty set issues a plain project DELETE (clears all)", async () => {
		const fake = fakeSql();
		const store = new PostgresPendingInviteIndexStore(fake.client);
		await store.syncProject("p1", []);
		const deletes = fake.queries.filter((q) => q.startsWith("DELETE FROM project_pending_invites WHERE project_id = $1") && !q.includes("NOT IN"));
		expect(deletes).toHaveLength(1);
		expect(fake.queries.some((q) => q.includes("INSERT"))).toBe(false);
	});

	test("listForEmail issues ONE email-keyed point query, capped (no scan)", async () => {
		const now = new Date().toISOString();
		const fake = fakeSql({
			select: [{
				member_id: "m1", project_id: "p1", invitee_email: "a@x.com",
				role: "qc", invited_by: "owner", chapter_label: "Ch", story_title: null, invited_at: now,
			}],
		});
		const store = new PostgresPendingInviteIndexStore(fake.client);
		const result = await store.listForEmail("A@X.com");
		expect(result).toHaveLength(1);
		expect(result[0]!.projectId).toBe("p1");
		const selects = fake.queries.filter((q) => q.startsWith("SELECT"));
		expect(selects).toHaveLength(1);
		expect(selects[0]).toContain("WHERE invitee_email = $1");
		expect(selects[0]).toContain(`LIMIT ${MAX_PENDING_INVITES_PER_EMAIL}`);
		// No readdir / no whole-table scan: the query is a single equality lookup.
		expect(selects[0]).not.toContain("FROM projects");
	});
});
