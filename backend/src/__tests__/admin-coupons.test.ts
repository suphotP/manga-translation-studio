// Back-office coupons (ranks 9-11) — gating + Dodo discount CRUD + internal
// credit-coupon create/redeem coverage, using the file/in-memory stores and a
// stub DodoService so the suite runs without a DB or a live Dodo account.
//
// The real-Postgres parity of the credit-coupon store (idempotent redemption,
// per_user_limit, max_redemptions enforced transactionally) is asserted in
// credit-coupons-postgres.test.ts, gated on CREDIT_COUPONS_TEST_DATABASE_URL.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createAdminRouter } from "../routes/admin.js";
import { createCouponsRouter } from "../routes/coupons.js";
import {
	FileCreditCouponStore,
	type CreditCouponStore,
} from "../services/credit-coupons.js";
import type { DodoService } from "../services/dodo.service.js";
import type { GdprStore } from "../services/gdpr.js";
import type { GrantCreditsInput } from "../services/credits.js";
import type { UserRole } from "../types/auth.js";

async function json<T = any>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

const tempDirs: string[] = [];

function fileCouponStore(): CreditCouponStore {
	const dir = mkdtempSync(join(tmpdir(), "manga-credit-coupons-"));
	tempDirs.push(dir);
	return new FileCreditCouponStore(join(dir, "credit-coupons.json"));
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stubAuth(role: UserRole, userId = `stub-${role}`) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId, email: `${role}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
}

// Minimal in-memory gdpr stub recording only admin audit rows.
function gdprStub(): GdprStore & { audits: Array<{ action: string; targetId: string | null }> } {
	const audits: Array<{ action: string; targetId: string | null }> = [];
	const store = {
		audits,
		async recordAdminAudit(input: { action: string; targetId?: string | null }) {
			const entry = { id: `audit-${audits.length}`, adminUserId: "x", action: input.action, targetKind: null, targetId: input.targetId ?? null, detail: {}, createdAt: new Date().toISOString() };
			audits.push({ action: input.action, targetId: input.targetId ?? null });
			return entry as never;
		},
	} as unknown as GdprStore & { audits: Array<{ action: string; targetId: string | null }> };
	return store;
}

// Stub DodoService exposing just the discount CRUD the router calls.
function dodoStub(): DodoService & { calls: string[] } {
	const calls: string[] = [];
	const created: Record<string, unknown> = {};
	const stub = {
		calls,
		async createDiscountCoupon(input: { percentOff: number; code?: string }) {
			calls.push("create");
			const discount = { discountId: "disc_1", code: input.code ?? "GENCODE123456", percentOff: input.percentOff, amountBasisPoints: Math.round(input.percentOff * 100), type: "percentage", name: null, expiresAt: null, usageLimit: null, timesUsed: 0, restrictedTo: [], createdAt: new Date().toISOString() };
			created.disc_1 = discount;
			return discount;
		},
		async listDiscountCoupons() {
			calls.push("list");
			return Object.values(created);
		},
		async getDiscountCoupon(id: string) {
			calls.push("get");
			return created[id] ?? { discountId: id, code: "X", percentOff: 10, amountBasisPoints: 1000, type: "percentage", name: null, expiresAt: null, usageLimit: null, timesUsed: 0, restrictedTo: [], createdAt: null };
		},
		async updateDiscountCoupon(id: string, input: { percentOff?: number }) {
			calls.push("update");
			return { discountId: id, code: "X", percentOff: input.percentOff ?? 10, amountBasisPoints: 1000, type: "percentage", name: null, expiresAt: null, usageLimit: null, timesUsed: 0, restrictedTo: [], createdAt: null };
		},
		async deleteDiscountCoupon() {
			calls.push("delete");
		},
	} as unknown as DodoService & { calls: string[] };
	return stub;
}

function adminApp(role: UserRole, deps: { dodo: DodoService; creditCoupons: CreditCouponStore; gdpr: GdprStore }): Hono {
	const app = new Hono();
	app.route("/", createAdminRouter({
		workspaceAccess: null,
		authMiddleware: stubAuth(role),
		// AdminCouponsDeps fields are read by the coupons sub-router via the shared
		// deps object.
		...(deps as object),
	} as never));
	return app;
}

describe("admin coupons — gating", () => {
	test("editor is rejected from every coupons route (403, ACCESS gate)", async () => {
		const app = adminApp("editor", { dodo: dodoStub(), creditCoupons: fileCouponStore(), gdpr: gdprStub() });
		for (const path of ["/coupons/dodo", "/coupons/credit"]) {
			const res = await app.request(path);
			expect(res.status).toBe(403);
		}
	});

	test("accountant (no COUPONS_READ/WRITE) cannot read or write coupons (403)", async () => {
		const app = adminApp("accountant", { dodo: dodoStub(), creditCoupons: fileCouponStore(), gdpr: gdprStub() });
		const read = await app.request("/coupons/credit");
		expect(read.status).toBe(403);
		const write = await app.request("/coupons/credit", { method: "POST", body: JSON.stringify({ creditAmount: 100 }), headers: { "content-type": "application/json" } });
		expect(write.status).toBe(403);
	});

	test("support (no COUPONS_WRITE) cannot create coupons (403)", async () => {
		const app = adminApp("support", { dodo: dodoStub(), creditCoupons: fileCouponStore(), gdpr: gdprStub() });
		const res = await app.request("/coupons/credit", { method: "POST", body: JSON.stringify({ creditAmount: 100 }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(403);
	});

	test("admin can create + list Dodo discounts and an audit row is written", async () => {
		const gdpr = gdprStub();
		const dodo = dodoStub();
		const app = adminApp("admin", { dodo, creditCoupons: fileCouponStore(), gdpr });
		const create = await app.request("/coupons/dodo", { method: "POST", body: JSON.stringify({ percentOff: 25, code: "SAVE25" }), headers: { "content-type": "application/json" } });
		expect(create.status).toBe(201);
		const body = await json(create);
		expect(body.discount.code).toBe("SAVE25");
		expect(body.discount.percentOff).toBe(25);
		expect(dodo.calls).toContain("create");
		expect(gdpr.audits.some((a) => a.action === "admin.coupon.dodo.create")).toBe(true);

		const list = await app.request("/coupons/dodo");
		expect(list.status).toBe(200);
		expect((await json<any>(list)).discounts.length).toBe(1);
	});

	test("admin Dodo discount update + delete are audited", async () => {
		const gdpr = gdprStub();
		const app = adminApp("admin", { dodo: dodoStub(), creditCoupons: fileCouponStore(), gdpr });
		const patch = await app.request("/coupons/dodo/disc_1", { method: "PATCH", body: JSON.stringify({ percentOff: 40 }), headers: { "content-type": "application/json" } });
		expect(patch.status).toBe(200);
		const del = await app.request("/coupons/dodo/disc_1", { method: "DELETE" });
		expect(del.status).toBe(200);
		expect(gdpr.audits.some((a) => a.action === "admin.coupon.dodo.update")).toBe(true);
		expect(gdpr.audits.some((a) => a.action === "admin.coupon.dodo.delete")).toBe(true);
	});

	test("Dodo discount rejects out-of-range percent (400)", async () => {
		const app = adminApp("admin", { dodo: dodoStub(), creditCoupons: fileCouponStore(), gdpr: gdprStub() });
		const res = await app.request("/coupons/dodo", { method: "POST", body: JSON.stringify({ percentOff: 150 }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(400);
	});
});

describe("admin credit-coupons — create + list + disable", () => {
	test("admin creates a credit-coupon (generated code) and it is audited", async () => {
		const gdpr = gdprStub();
		const store = fileCouponStore();
		const app = adminApp("admin", { dodo: dodoStub(), creditCoupons: store, gdpr });
		const res = await app.request("/coupons/credit", { method: "POST", body: JSON.stringify({ creditAmount: 500, maxRedemptions: 3, perUserLimit: 1 }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(201);
		const { coupon } = await json(res);
		expect(coupon.creditAmount).toBe(500);
		expect(coupon.code).toMatch(/^[A-Z0-9-]{4,32}$/);
		expect(coupon.maxRedemptions).toBe(3);
		expect(gdpr.audits.some((a) => a.action === "admin.coupon.credit.create")).toBe(true);

		const list = await app.request("/coupons/credit");
		expect((await json<any>(list)).coupons.length).toBe(1);

		const disable = await app.request(`/coupons/credit/${coupon.id}/disable`, { method: "POST" });
		expect(disable.status).toBe(200);
		expect((await json<any>(disable)).coupon.status).toBe("disabled");
		expect(gdpr.audits.some((a) => a.action === "admin.coupon.credit.disable")).toBe(true);
	});

	test("rejects a malformed explicit code (400)", async () => {
		const app = adminApp("admin", { dodo: dodoStub(), creditCoupons: fileCouponStore(), gdpr: gdprStub() });
		const res = await app.request("/coupons/credit", { method: "POST", body: JSON.stringify({ creditAmount: 100, code: "no" }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(400);
	});
});

// ── Customer-facing redemption ────────────────────────────────────

function redeemApp(deps: { store: CreditCouponStore; grants: Array<GrantCreditsInput>; gdpr?: GdprStore; role?: UserRole; userId?: string }): Hono {
	let grantCounter = 0;
	const app = new Hono();
	app.route("/", createCouponsRouter({
		creditCoupons: deps.store,
		workspaceAccessStore: null, // file-mode: admin/owner allowed (see route)
		authMiddleware: stubAuth(deps.role ?? "admin", deps.userId ?? "user-1"),
		gdpr: deps.gdpr ?? gdprStub(),
		grantCredits: async (input: GrantCreditsInput) => {
			deps.grants.push(input);
			return { id: `grant-${grantCounter++}` };
		},
	}));
	return app;
}

async function seedCoupon(store: CreditCouponStore, overrides: Partial<{ code: string; creditAmount: number; maxRedemptions: number | null; perUserLimit: number; expiresAt: string }> = {}): Promise<string> {
	const coupon = await store.createCoupon({
		code: overrides.code ?? "WELCOME50",
		creditAmount: overrides.creditAmount ?? 50,
		maxRedemptions: overrides.maxRedemptions ?? null,
		perUserLimit: overrides.perUserLimit ?? 1,
		expiresAt: overrides.expiresAt,
		createdBy: "admin-1",
	});
	return coupon.code;
}

describe("credit-coupon redemption (file store)", () => {
	test("redeems once and grants exactly the credits", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		const gdpr = gdprStub();
		await seedCoupon(store, { code: "WELCOME50", creditAmount: 50 });
		const app = redeemApp({ store, grants, gdpr });
		const res = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "welcome50", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.creditsGranted).toBe(50);
		expect(body.alreadyRedeemed).toBe(false);
		expect(grants.length).toBe(1);
		expect(grants[0]).toMatchObject({ ownerScope: "user", ownerId: "user-1", amount: 50, creditClass: "personal", source: "topup", workspaceId: "ws-1" });
		expect(gdpr.audits.some((a) => a.action === "coupon.credit.redeem")).toBe(true);
	});

	test("double-redeem by the same user is blocked and does NOT grant twice", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		await seedCoupon(store, { code: "ONCE", creditAmount: 100, perUserLimit: 1 });
		const app = redeemApp({ store, grants });
		const first = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "ONCE", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(first.status).toBe(200);
		// Same idempotency key (default code:user) → idempotent replay, NOT a grant.
		const second = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "ONCE", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(second.status).toBe(200);
		expect((await json<any>(second)).alreadyRedeemed).toBe(true);
		expect(grants.length).toBe(1);
	});

	test("same client idempotency string is scoped per user; same-user replay grants once", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		await seedCoupon(store, { code: "SAMEKEY", creditAmount: 25, maxRedemptions: 2, perUserLimit: 1 });
		const appA = redeemApp({ store, grants, userId: "user-A" });
		const appB = redeemApp({ store, grants, userId: "user-B" });
		const body = JSON.stringify({ code: "SAMEKEY", workspaceId: "ws-1", idempotencyKey: "client-retry-1" });

		const firstA = await appA.request("/redeem", { method: "POST", body, headers: { "content-type": "application/json" } });
		expect(firstA.status).toBe(200);
		expect((await json<any>(firstA)).alreadyRedeemed).toBe(false);

		const firstB = await appB.request("/redeem", { method: "POST", body, headers: { "content-type": "application/json" } });
		expect(firstB.status).toBe(200);
		expect((await json<any>(firstB)).alreadyRedeemed).toBe(false);

		const replayA = await appA.request("/redeem", { method: "POST", body, headers: { "content-type": "application/json" } });
		expect(replayA.status).toBe(200);
		const replayBody = await json<any>(replayA);
		expect(replayBody.alreadyRedeemed).toBe(true);
		expect(replayBody.creditsGranted).toBe(0);

		expect(grants).toHaveLength(2);
		expect(grants.map((grant) => grant.ownerId).sort()).toEqual(["user-A", "user-B"]);
		expect(new Set(grants.map((grant) => grant.idempotencyKey)).size).toBe(2);
	});

	test("per_user_limit blocks a second distinct redeem attempt (409)", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		await seedCoupon(store, { code: "LIM1", creditAmount: 10, perUserLimit: 1 });
		const app = redeemApp({ store, grants });
		await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "LIM1", workspaceId: "ws-1", idempotencyKey: "k1" }), headers: { "content-type": "application/json" } });
		// A DIFFERENT idempotency key, same user → blocked by per_user_limit.
		const second = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "LIM1", workspaceId: "ws-1", idempotencyKey: "k2" }), headers: { "content-type": "application/json" } });
		expect(second.status).toBe(409);
		expect(grants.length).toBe(1);
	});

	test("max_redemptions enforced across users (409 once cap reached)", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		await seedCoupon(store, { code: "CAP2", creditAmount: 5, maxRedemptions: 2, perUserLimit: 1 });
		const appA = redeemApp({ store, grants, userId: "user-A" });
		const appB = redeemApp({ store, grants, userId: "user-B" });
		const appC = redeemApp({ store, grants, userId: "user-C" });
		expect((await appA.request("/redeem", { method: "POST", body: JSON.stringify({ code: "CAP2", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } })).status).toBe(200);
		expect((await appB.request("/redeem", { method: "POST", body: JSON.stringify({ code: "CAP2", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } })).status).toBe(200);
		const third = await appC.request("/redeem", { method: "POST", body: JSON.stringify({ code: "CAP2", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(third.status).toBe(409);
		expect(grants.length).toBe(2);
	});

	test("expired coupon is rejected (410) and grants nothing", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		await seedCoupon(store, { code: "OLDX", creditAmount: 30, expiresAt: new Date(Date.now() - 60_000).toISOString() });
		const app = redeemApp({ store, grants });
		const res = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "OLDX", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(410);
		expect(grants.length).toBe(0);
	});

	test("disabled coupon is rejected (409)", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		const code = await seedCoupon(store, { code: "KILLED", creditAmount: 30 });
		const coupon = await store.getCouponByCode(code);
		await store.disableCoupon(coupon!.id);
		const app = redeemApp({ store, grants });
		const res = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code, workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(409);
		expect(grants.length).toBe(0);
	});

	test("unknown coupon → 404", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		const app = redeemApp({ store, grants });
		const res = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "NOPE1234", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(404);
	});

	test("malformed code → 400", async () => {
		const store = fileCouponStore();
		const grants: GrantCreditsInput[] = [];
		const app = redeemApp({ store, grants });
		const res = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "a b", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(res.status).toBe(400);
	});
});

// ── P1 crash-safety: grant failure must never burn the coupon ──────────
//
// reserveRedemption() reserves the redemption row durably; the credit grant is a
// SEPARATE step (the credits service can't join the reservation transaction). If
// the grant throws AFTER the row is reserved, a naive flow would leave the coupon
// "consumed" with grant_id = NULL, and a retry would report alreadyRedeemed with 0
// credits — the customer loses the coupon and gets nothing. These tests assert the
// route instead RECOVERS: a retry completes the dangling grant exactly once.

// An idempotent grantCredits stub keyed on input.idempotencyKey (the redemption id),
// mirroring the real credits service. `failTimes` makes the first N calls throw to
// simulate a crash/failure between reservation and grant. Returns the SAME grant id
// for the same key, so retries can never double-grant.
function recoverableGrantStub(options: { failTimes?: number } = {}) {
	const byKey = new Map<string, { id: string }>();
	const calls: GrantCreditsInput[] = [];
	let remainingFailures = options.failTimes ?? 0;
	let counter = 0;
	const grantCredits = async (input: GrantCreditsInput): Promise<{ id: string }> => {
		calls.push(input);
		if (remainingFailures > 0) {
			remainingFailures--;
			throw new Error("simulated grant failure");
		}
		const key = input.idempotencyKey?.trim();
		if (key && byKey.has(key)) return byKey.get(key)!;
		const grant = { id: `grant-${counter++}` };
		if (key) byKey.set(key, grant);
		return grant;
	};
	return { grantCredits, calls, byKey };
}

// Inspect the redemption created for (coupon, default key) by replaying the
// reservation with the same idempotency key — reserveRedemption returns the
// existing row (with its current grant_id) without reserving again. The default
// route key is `${code}:${userId}`; tests here use userId "user-1".
async function firstRedemptionFor(
	store: CreditCouponStore,
	couponId: string,
	opts: { code?: string; userId?: string } = {},
): Promise<{ id: string; grantId?: string } | null> {
	const coupon = await store.getCouponById(couponId);
	if (!coupon) return null;
	const userId = opts.userId ?? "user-1";
	const out = await store.reserveRedemption({
		code: coupon.code,
		userId,
		workspaceId: "ws-1",
		idempotencyKey: `${coupon.code}:${userId}`,
		now: new Date(),
	});
	return out.alreadyRedeemed ? { id: out.redemption.id, grantId: out.redemption.grantId } : null;
}

function recoverableRedeemApp(deps: {
	store: CreditCouponStore;
	grantCredits: (input: GrantCreditsInput) => Promise<{ id: string }>;
	gdpr?: GdprStore;
	userId?: string;
}): Hono {
	const app = new Hono();
	app.route("/", createCouponsRouter({
		creditCoupons: deps.store,
		workspaceAccessStore: null,
		authMiddleware: stubAuth("admin", deps.userId ?? "user-1"),
		gdpr: deps.gdpr ?? gdprStub(),
		grantCredits: deps.grantCredits,
	}));
	return app;
}

describe("credit-coupon redemption — grant failure recovery (P1)", () => {
	test("grant throws on first attempt → coupon is NOT burned; retry completes the grant exactly once", async () => {
		const store = fileCouponStore();
		await seedCoupon(store, { code: "RECOVER1", creditAmount: 75, perUserLimit: 1 });
		const grant = recoverableGrantStub({ failTimes: 1 });
		const app = recoverableRedeemApp({ store, grantCredits: grant.grantCredits });

		// First redeem reserves the row, then the grant throws → request fails (500).
		const first = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "RECOVER1", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(first.status).toBe(500);

		// The redemption row exists but its grant never completed (grant_id NULL).
		const coupon = await store.getCouponByCode("RECOVER1");
		const danglingRedemption = await firstRedemptionFor(store, coupon!.id);
		expect(danglingRedemption?.grantId).toBeUndefined();

		// Retry (same default idempotency key) must COMPLETE the grant — not return 0.
		const retry = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "RECOVER1", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(retry.status).toBe(200);
		const body = await json<any>(retry);
		expect(body.creditsGranted).toBe(75); // customer DID receive the credits
		expect(body.grantId).toBeTruthy();

		// Exactly one grant was minted (keyed on the redemption id).
		expect(grant.byKey.size).toBe(1);
		const completed = await firstRedemptionFor(store, coupon!.id);
		expect(completed?.grantId).toBe(body.grantId);

		// A THIRD call is now a true idempotent replay: 0 new credits, no new grant.
		const replay = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "RECOVER1", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect((await json<any>(replay)).creditsGranted).toBe(0);
		expect(grant.byKey.size).toBe(1);
	});

	test("grant succeeds but attachGrantId fails → retry re-links the SAME grant, never double-grants", async () => {
		const store = fileCouponStore();
		await seedCoupon(store, { code: "RELINK1", creditAmount: 40, perUserLimit: 1 });
		const grant = recoverableGrantStub();
		// Wrap the store so attachGrantId throws on the FIRST call only, simulating a
		// crash after the grant was minted but before the link was persisted.
		let attachFailsLeft = 1;
		const wrapped: CreditCouponStore = {
			...store,
			createCoupon: store.createCoupon.bind(store),
			listCoupons: store.listCoupons.bind(store),
			getCouponById: store.getCouponById.bind(store),
			getCouponByCode: store.getCouponByCode.bind(store),
			disableCoupon: store.disableCoupon.bind(store),
			reserveRedemption: store.reserveRedemption.bind(store),
			attachGrantId: async (redemptionId: string, grantId: string) => {
				if (attachFailsLeft > 0) { attachFailsLeft--; throw new Error("simulated link failure"); }
				return store.attachGrantId(redemptionId, grantId);
			},
		};
		const app = recoverableRedeemApp({ store: wrapped, grantCredits: grant.grantCredits });

		// First redeem: grant succeeds, but the route swallows the attach failure
		// (best-effort link) so the request still returns 200 with credits.
		const first = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "RELINK1", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(first.status).toBe(200);
		const firstBody = await json<any>(first);
		expect(firstBody.creditsGranted).toBe(40);

		// The link did NOT persist (grant_id still NULL on the row).
		const coupon = await store.getCouponByCode("RELINK1");
		expect((await firstRedemptionFor(store, coupon!.id))?.grantId).toBeUndefined();

		// Retry re-derives the SAME grant (idempotent on redemption id) and re-links.
		const retry = await app.request("/redeem", { method: "POST", body: JSON.stringify({ code: "RELINK1", workspaceId: "ws-1" }), headers: { "content-type": "application/json" } });
		expect(retry.status).toBe(200);
		const retryBody = await json<any>(retry);
		expect(retryBody.grantId).toBe(firstBody.grantId); // SAME grant, not a new one
		expect(grant.byKey.size).toBe(1); // exactly one grant ever minted
		expect((await firstRedemptionFor(store, coupon!.id))?.grantId).toBe(firstBody.grantId);
	});
});
