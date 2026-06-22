import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { blockUnverifiedMutations } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";

type FakeUser = JWTPayload | null;

/**
 * Build a tiny app that injects a fake context user (as authMiddleware/optionalAuth would),
 * mounts the verify wall, and exposes a catch-all on every method so we can probe the gate
 * for any path/method. `user = null` simulates an unauthenticated request.
 */
function appWithUser(user: FakeUser): Hono {
	const app = new Hono();
	app.use("/api/*", async (c, next) => {
		if (user) (c as { set: (k: string, v: unknown) => void }).set("user", user);
		await next();
	});
	app.use("/api/*", blockUnverifiedMutations);
	app.all("/api/*", (c) => c.json({ ok: true }));
	return app;
}

const verified: FakeUser = { userId: "u1", email: "v@x.io", role: "editor", emailVerified: true };
const unverified: FakeUser = { userId: "u2", email: "u@x.io", role: "editor", emailVerified: false };
const legacy: FakeUser = { userId: "u3", email: "l@x.io", role: "editor" }; // emailVerified unpopulated

describe("verify wall — blockUnverifiedMutations", () => {
	test("verified user can mutate anything", async () => {
		const app = appWithUser(verified);
		const res = await app.request("/api/contacts", { method: "POST" });
		expect(res.status).toBe(200);
	});

	test("unverified user is blocked from a normal mutation with email_not_verified", async () => {
		const app = appWithUser(unverified);
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const res = await app.request("/api/contacts", { method });
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual(expect.objectContaining({ code: "email_not_verified" }));
		}
	});

	test("unverified user may still READ (GET/HEAD/OPTIONS pass)", async () => {
		const app = appWithUser(unverified);
		for (const method of ["GET", "HEAD", "OPTIONS"]) {
			const res = await app.request("/api/contacts", { method });
			expect(res.status).toBe(200);
		}
	});

	test("unverified user may use the verify/recover/abandon allowlist", async () => {
		const app = appWithUser(unverified);
		const allowed: Array<[string, string]> = [
			["/api/auth/verify-otp", "POST"],
			["/api/auth/resend-verification", "POST"],
			["/api/auth/refresh", "POST"],
			["/api/auth/logout", "POST"],
			["/api/consent/events", "POST"],
			["/api/account", "DELETE"],
			["/api/account/restore", "POST"],
		];
		for (const [path, method] of allowed) {
			const res = await app.request(path, { method });
			expect(res.status, `${method} ${path} should be allowed`).toBe(200);
		}
	});

	test("unverified user is still blocked from POST /api/account/export (the orphan source)", async () => {
		const app = appWithUser(unverified);
		const res = await app.request("/api/account/export", { method: "POST" });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual(expect.objectContaining({ code: "email_not_verified" }));
	});

	test("the /api/auth allowlist is exact — admin user-mgmt + self mutations under it are still blocked", async () => {
		// A blanket /api/auth/* exemption would let an unverified admin punch these through.
		const app = appWithUser({ ...unverified, role: "admin" });
		const blocked: Array<[string, string]> = [
			["/api/auth/users/u9", "PATCH"],
			["/api/auth/users/u9", "DELETE"],
			["/api/auth/users/u9/disable", "POST"],
			["/api/auth/users/u9/enable", "POST"],
			["/api/auth/me", "PATCH"],
			["/api/auth/change-password", "POST"],
		];
		for (const [path, method] of blocked) {
			const res = await app.request(path, { method });
			expect(res.status, `${method} ${path} should be walled`).toBe(403);
			expect(await res.json()).toEqual(expect.objectContaining({ code: "email_not_verified" }));
		}
	});

	test("unverified user may revoke their OWN session (DELETE /api/auth/sessions/:id)", async () => {
		const app = appWithUser(unverified);
		const res = await app.request("/api/auth/sessions/sess-1", { method: "DELETE" });
		expect(res.status).toBe(200);
	});

	test("an ALREADY-authenticated unverified user cannot re-hit register/login (privilege-escalation vector)", async () => {
		// Unauthenticated register/login pass anyway (no context user); the danger is an
		// authenticated unverified owner/admin re-registering to mint privileged users.
		const app = appWithUser({ ...unverified, role: "owner" });
		for (const path of ["/api/auth/register", "/api/auth/login"]) {
			const res = await app.request(path, { method: "POST" });
			expect(res.status, `${path} should be walled for an authenticated unverified user`).toBe(403);
		}
	});

	test("an /api/auth-prefixed path is not spoofable by another route embedding it", async () => {
		// Guard against a naive `includes("/api/auth")` — only a true prefix is allowed.
		const app = appWithUser(unverified);
		const res = await app.request("/api/projects/api/auth/sneaky", { method: "POST" });
		expect(res.status).toBe(403);
	});

	test("unauthenticated requests pass through (auth enforcement is a separate guard)", async () => {
		const app = appWithUser(null);
		const res = await app.request("/api/contacts", { method: "POST" });
		expect(res.status).toBe(200);
	});

	test("a legacy context user without the emailVerified flag is not blocked (fail-open on unknown)", async () => {
		const app = appWithUser(legacy);
		const res = await app.request("/api/contacts", { method: "POST" });
		expect(res.status).toBe(200);
	});
});
