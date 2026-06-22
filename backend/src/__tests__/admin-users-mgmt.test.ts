// Back-office USERS-MGMT route tests (rank 16 — user detail + role / enable-disable).
//
// Exercises the /api/admin/users-mgmt sub-router end-to-end through the parent
// admin router, using the gdpr.test.ts stub-auth harness pattern. The user store
// is the real module-level `authUserStore` (file mode under an isolated per-PID
// DATA_DIR in test runtime), so the ATOMIC owner-guard / last-owner protection is
// the genuine store path — not a mock. A fresh MemoryGdprStore is injected per
// test so audit assertions are isolated.
//
// Pins:
//   * list + detail gated USERS_READ (editor 403)
//   * role-change + disable gated USERS_WRITE (support has READ but not WRITE → 403)
//   * a non-owner admin CANNOT change/disable an OWNER (403, owner unchanged)
//   * last-owner self-demote / self-disable blocked (403, stays owner + active)
//   * every successful mutation writes exactly one audit row
//   * keyset pagination is stable across pages

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createAdminRouter } from "../routes/admin.js";
import { createMemoryGdprStore } from "../services/gdpr.js";
import type { GdprStore } from "../services/gdpr.js";
import { authUserStore } from "../services/auth-users.js";
import type { User, UserRole } from "../types/auth.js";

// ── Harness ───────────────────────────────────────────────────────

function stubAuth(userId: string, role: UserRole) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${userId}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
}

function appAs(opts: { userId: string; role: UserRole; gdpr: GdprStore }): Hono {
	const app = new Hono();
	app.route("/api/admin", createAdminRouter({
		// Real authUserStore singleton backs the route (file mode). workspaceAccess
		// is nulled so the detail route's membership lookup is a no-op here.
		workspaceAccess: null,
		gdpr: opts.gdpr,
		authMiddleware: stubAuth(opts.userId, opts.role),
	}));
	return app;
}

let seeded: string[] = [];

async function seedUser(over: Partial<User> & { id: string; role: UserRole }): Promise<User> {
	const now = new Date().toISOString();
	const user: User = {
		passwordHash: "x",
		authProvider: "local",
		emailVerified: true,
		...over,
		id: over.id,
		email: over.email ?? `${over.id}@example.com`,
		name: over.name ?? over.id,
		role: over.role,
		isActive: over.isActive ?? true,
		createdAt: over.createdAt ?? now,
		updatedAt: over.updatedAt ?? now,
	};
	await authUserStore.save(user);
	seeded.push(user.id);
	return user;
}

afterEach(async () => {
	// Clean every user this file created so the file store starts each test clean
	// (the last-owner guard counts ALL owners on disk).
	for (const id of seeded) {
		await authUserStore.delete(id).catch(() => undefined);
	}
	seeded = [];
});

// Helper: count audit rows recorded for a target.
async function auditFor(gdpr: GdprStore, targetId: string): Promise<number> {
	const { entries } = await gdpr.listAdminAudit({ targetKind: "user", targetId });
	return entries.length;
}

// ── READ gating ───────────────────────────────────────────────────

describe("GET gating (USERS_READ)", () => {
	let gdpr: GdprStore;
	beforeEach(() => { gdpr = createMemoryGdprStore(); });

	test("editor (no admin:access) is rejected from list (403)", async () => {
		const res = await appAs({ userId: "ed", role: "editor", gdpr }).request("/api/admin/users-mgmt");
		expect(res.status).toBe(403);
	});

	test("support (USERS_READ) can list and read detail (200)", async () => {
		const target = await seedUser({ id: "t-read", role: "viewer" });
		const app = appAs({ userId: "sup", role: "support", gdpr });
		const list = await app.request("/api/admin/users-mgmt");
		expect(list.status).toBe(200);
		const detail = await app.request(`/api/admin/users-mgmt/${target.id}`);
		expect(detail.status).toBe(200);
		const body = await detail.json() as { user: { id: string }; workspaceCount: number };
		expect(body.user.id).toBe(target.id);
		expect(body.workspaceCount).toBe(0);
	});

	test("detail for a missing user is 404", async () => {
		const res = await appAs({ userId: "ow", role: "owner", gdpr }).request("/api/admin/users-mgmt/nope");
		expect(res.status).toBe(404);
	});
});

// ── WRITE gating (USERS_WRITE) ────────────────────────────────────

describe("mutation gating (USERS_WRITE)", () => {
	let gdpr: GdprStore;
	beforeEach(() => { gdpr = createMemoryGdprStore(); });

	test("support (READ but not WRITE) cannot change role (403)", async () => {
		const target = await seedUser({ id: "t-w1", role: "viewer" });
		const res = await appAs({ userId: "sup", role: "support", gdpr })
			.request(`/api/admin/users-mgmt/${target.id}/role`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "editor" }),
			});
		expect(res.status).toBe(403);
		expect((await authUserStore.load(target.id))?.role).toBe("viewer");
		expect(await auditFor(gdpr, target.id)).toBe(0);
	});

	test("support cannot disable a user (403)", async () => {
		const target = await seedUser({ id: "t-w2", role: "viewer" });
		const res = await appAs({ userId: "sup", role: "support", gdpr })
			.request(`/api/admin/users-mgmt/${target.id}/disable`, { method: "POST" });
		expect(res.status).toBe(403);
		expect((await authUserStore.load(target.id))?.isActive).toBe(true);
	});

	test("owner can change a non-owner role + audits the change (old→new)", async () => {
		const target = await seedUser({ id: "t-w3", role: "viewer" });
		const res = await appAs({ userId: "ow", role: "owner", gdpr })
			.request(`/api/admin/users-mgmt/${target.id}/role`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "editor", reason: "promote" }),
			});
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: boolean; changed: boolean; user: { role: string } };
		expect(body.changed).toBe(true);
		expect(body.user.role).toBe("editor");
		expect((await authUserStore.load(target.id))?.role).toBe("editor");
		const { entries } = await gdpr.listAdminAudit({ targetKind: "user", targetId: target.id });
		expect(entries.length).toBe(1);
		expect(entries[0]?.action).toBe("admin.user.role_change");
		expect(entries[0]?.detail).toMatchObject({ oldRole: "viewer", newRole: "editor", reason: "promote" });
	});

	test("a non-owner admin cannot assign a platform role (only owner mints roles) (403)", async () => {
		const target = await seedUser({ id: "t-w4", role: "viewer" });
		const res = await appAs({ userId: "adm", role: "admin", gdpr })
			.request(`/api/admin/users-mgmt/${target.id}/role`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "support" }),
			});
		expect(res.status).toBe(403);
		expect((await authUserStore.load(target.id))?.role).toBe("viewer");
		expect(await auditFor(gdpr, target.id)).toBe(0);
	});

	test("admin can disable / enable a non-owner + each audits", async () => {
		const target = await seedUser({ id: "t-w5", role: "editor" });
		const app = appAs({ userId: "adm", role: "admin", gdpr });

		const dis = await app.request(`/api/admin/users-mgmt/${target.id}/disable`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "abuse" }),
		});
		expect(dis.status).toBe(200);
		expect((await authUserStore.load(target.id))?.isActive).toBe(false);

		const en = await app.request(`/api/admin/users-mgmt/${target.id}/enable`, { method: "POST" });
		expect(en.status).toBe(200);
		expect((await authUserStore.load(target.id))?.isActive).toBe(true);

		expect(await auditFor(gdpr, target.id)).toBe(2);
	});

	test("no-op role change does not write an audit row", async () => {
		const target = await seedUser({ id: "t-w6", role: "editor" });
		const res = await appAs({ userId: "ow", role: "owner", gdpr })
			.request(`/api/admin/users-mgmt/${target.id}/role`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "editor" }),
			});
		expect(res.status).toBe(200);
		expect((await res.json() as { changed: boolean }).changed).toBe(false);
		expect(await auditFor(gdpr, target.id)).toBe(0);
	});
});

// ── Owner-target protection ───────────────────────────────────────

describe("owner-target protection (only an owner may mutate an owner)", () => {
	let gdpr: GdprStore;
	beforeEach(() => { gdpr = createMemoryGdprStore(); });

	test("non-owner admin CANNOT demote an OWNER (403, owner unchanged)", async () => {
		// Two owners so the last-owner guard is not what blocks this — the
		// owner-target policy is.
		await seedUser({ id: "ow-keep", role: "owner" });
		const target = await seedUser({ id: "ow-target", role: "owner" });
		const res = await appAs({ userId: "adm", role: "admin", gdpr })
			.request(`/api/admin/users-mgmt/${target.id}/role`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
		expect(res.status).toBe(403);
		expect((await authUserStore.load(target.id))?.role).toBe("owner");
		expect(await auditFor(gdpr, target.id)).toBe(0);
	});

	test("non-owner admin CANNOT disable an OWNER (403, owner stays active)", async () => {
		await seedUser({ id: "ow-keep2", role: "owner" });
		const target = await seedUser({ id: "ow-target2", role: "owner" });
		const res = await appAs({ userId: "adm", role: "admin", gdpr })
			.request(`/api/admin/users-mgmt/${target.id}/disable`, { method: "POST" });
		expect(res.status).toBe(403);
		expect((await authUserStore.load(target.id))?.isActive).toBe(true);
	});

	test("an OWNER can demote ANOTHER owner when a second owner remains", async () => {
		await seedUser({ id: "ow-actor", role: "owner" });
		const target = await seedUser({ id: "ow-demoted", role: "owner" });
		const res = await appAs({ userId: "ow-actor", role: "owner", gdpr })
			.request(`/api/admin/users-mgmt/${target.id}/role`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
		expect(res.status).toBe(200);
		expect((await authUserStore.load(target.id))?.role).toBe("admin");
	});
});

// ── Last-owner protection ─────────────────────────────────────────

describe("last-owner protection", () => {
	let gdpr: GdprStore;
	// The whole test suite shares one per-PID file store (config DATA_DIR), and the
	// last-owner guard counts EVERY active owner on disk — so a stray active owner
	// left by another test file would make our seeded owner not actually the last
	// one. Neutralize any foreign active owners for the duration of these tests
	// (deactivate before, restore after) so "solo owner" is genuinely the last.
	let suspendedForeignOwners: string[] = [];
	beforeEach(async () => {
		gdpr = createMemoryGdprStore();
		suspendedForeignOwners = [];
		for (const user of await authUserStore.list()) {
			if (user.role === "owner" && user.isActive && !seeded.includes(user.id)) {
				await authUserStore.update(user.id, { isActive: false });
				suspendedForeignOwners.push(user.id);
			}
		}
	});
	afterEach(async () => {
		for (const id of suspendedForeignOwners) {
			await authUserStore.update(id, { isActive: true }).catch(() => undefined);
		}
		suspendedForeignOwners = [];
	});

	test("the last owner cannot self-demote (403, stays owner)", async () => {
		const owner = await seedUser({ id: "solo-owner", role: "owner" });
		const res = await appAs({ userId: owner.id, role: "owner", gdpr })
			.request(`/api/admin/users-mgmt/${owner.id}/role`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
		expect(res.status).toBe(403);
		expect((await authUserStore.load(owner.id))?.role).toBe("owner");
		expect((await authUserStore.load(owner.id))?.isActive).toBe(true);
		expect(await auditFor(gdpr, owner.id)).toBe(0);
	});

	test("the last owner cannot self-disable (403, stays active)", async () => {
		const owner = await seedUser({ id: "solo-owner2", role: "owner" });
		const res = await appAs({ userId: owner.id, role: "owner", gdpr })
			.request(`/api/admin/users-mgmt/${owner.id}/disable`, { method: "POST" });
		expect(res.status).toBe(403);
		expect((await authUserStore.load(owner.id))?.isActive).toBe(true);
	});
});

// ── Keyset pagination ─────────────────────────────────────────────

describe("keyset pagination", () => {
	let gdpr: GdprStore;
	beforeEach(() => { gdpr = createMemoryGdprStore(); });

	test("paging with limit + cursor visits every user once, stably", async () => {
		// Seed a known cohort with sortable names (ordered by lower(name), user_id).
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const u = await seedUser({ id: `pg-${i}`, name: `pageuser-${i}`, role: "viewer" });
			ids.push(u.id);
		}
		const app = appAs({ userId: "ow", role: "owner", gdpr });

		const collected: string[] = [];
		let cursor: string | null = null;
		// Constrain to our cohort via search so other seeded users don't interfere.
		for (let guard = 0; guard < 10; guard++) {
			const qs = `?search=pageuser&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
			const res = await app.request(`/api/admin/users-mgmt${qs}`);
			expect(res.status).toBe(200);
			const body = await res.json() as { users: Array<{ id: string }>; nextCursor: string | null; total: number };
			expect(body.total).toBe(5);
			for (const u of body.users) collected.push(u.id);
			cursor = body.nextCursor;
			if (!cursor) break;
		}
		// Every cohort id appears exactly once, no dupes, no gaps.
		expect(collected.slice().sort()).toEqual(ids.slice().sort());
		expect(new Set(collected).size).toBe(collected.length);
	});

	test("role/status filters fill the page from filtered rows and total reflects the filter", async () => {
		// Ordered names put two non-matches first. The old route fetched limit=2
		// unfiltered rows, post-filtered them to [], and returned total=5.
		await seedUser({ id: "rf-a", name: "rolefilter-00", role: "viewer" });
		await seedUser({ id: "rf-b", name: "rolefilter-01", role: "viewer" });
		await seedUser({ id: "rf-c", name: "rolefilter-02", role: "editor", isActive: true });
		await seedUser({ id: "rf-d", name: "rolefilter-03", role: "editor", isActive: false });
		await seedUser({ id: "rf-e", name: "rolefilter-04", role: "editor", isActive: false });
		const app = appAs({ userId: "ow", role: "owner", gdpr });
		const res = await app.request("/api/admin/users-mgmt?search=rolefilter&role=editor&status=disabled&limit=2");
		expect(res.status).toBe(200);
		const body = await res.json() as { users: Array<{ id: string; role: string; isActive: boolean }>; total: number };
		expect(body.users.map((u) => u.id)).toEqual(["rf-d", "rf-e"]);
		expect(body.users.every((u) => u.role === "editor" && u.isActive === false)).toBe(true);
		expect(body.total).toBe(2);
	});
});

// ── Force-logout + force-delete (migrated from inline admin.ts /users) ──────────
// These live on the SINGLE real users surface now (/users-mgmt), so the inline
// duplicates in admin.ts were removed. Gated USERS_WRITE, owner-target-guarded,
// last-owner-protected (delete), audited.

describe("force-logout + force-delete (USERS_WRITE)", () => {
	let gdpr: GdprStore;
	beforeEach(() => { gdpr = createMemoryGdprStore(); });

	test("support (READ only, no WRITE) is 403 on force-logout AND force-delete", async () => {
		const target = await seedUser({ id: "fl-target-1", role: "editor" });
		const app = appAs({ userId: "sp", role: "support", gdpr });
		expect((await app.request(`/api/admin/users-mgmt/${target.id}/force-logout`, { method: "POST" })).status).toBe(403);
		expect((await app.request(`/api/admin/users-mgmt/${target.id}`, { method: "DELETE" })).status).toBe(403);
		// No destructive audit + the user is untouched.
		expect(await auditFor(gdpr, target.id)).toBe(0);
		expect(await authUserStore.load(target.id)).not.toBeNull();
	});

	test("force-logout revokes tokens, leaves the user, and writes one audit row", async () => {
		const target = await seedUser({ id: "fl-target-2", role: "editor" });
		const app = appAs({ userId: "ad", role: "admin", gdpr });
		const res = await app.request(`/api/admin/users-mgmt/${target.id}/force-logout`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(await authUserStore.load(target.id)).not.toBeNull();
		const { entries } = await gdpr.listAdminAudit({ action: "admin.user.force_logout", targetId: target.id });
		expect(entries.length).toBe(1);
	});

	test("a non-owner admin CANNOT force-logout an owner (403, owner untouched)", async () => {
		const owner = await seedUser({ id: "fl-owner", role: "owner" });
		const app = appAs({ userId: "ad", role: "admin", gdpr });
		const res = await app.request(`/api/admin/users-mgmt/${owner.id}/force-logout`, { method: "POST" });
		expect(res.status).toBe(403);
		expect(await auditFor(gdpr, owner.id)).toBe(0);
	});

	test("admins cannot force-delete their own account (400)", async () => {
		const me = await seedUser({ id: "fd-self", role: "admin" });
		const app = appAs({ userId: me.id, role: "admin", gdpr });
		const res = await app.request(`/api/admin/users-mgmt/${me.id}`, { method: "DELETE" });
		expect(res.status).toBe(400);
		expect(await authUserStore.load(me.id)).not.toBeNull();
	});

	test("force-delete removes the user and writes one audit row", async () => {
		const target = await seedUser({ id: "fd-target", role: "editor" });
		const app = appAs({ userId: "ad", role: "admin", gdpr });
		const res = await app.request(`/api/admin/users-mgmt/${target.id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await authUserStore.load(target.id)).toBeNull();
		const { entries } = await gdpr.listAdminAudit({ action: "admin.user.force_delete", targetId: target.id });
		expect(entries.length).toBe(1);
	});
});
