// Back-office de-conflict scaffold — per-domain admin sub-router gating tests.
//
// Each scaffold sub-router (revenue/coupons/support/users-mgmt) is mounted under
// createAdminRouter and exposes a single GET /_placeholder route. These tests
// assert the placeholder is reachable ONLY for a role that holds the domain's
// baseline permission (200) and is rejected for a role that does not (403),
// going through the SAME parent gates (authMiddleware + requirePermission(ACCESS))
// that production uses. We reuse the gdpr.test.ts stub-auth harness pattern so
// no JWT plumbing is required.
//
// The CONTENT domain has shipped real routes (ranks 17-18) so it no longer has a
// _placeholder; its gating is asserted against the real GET /content/projects
// (CONTENT_READ) instead.

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createAdminRouter } from "../routes/admin.js";
import type { UserRole } from "../types/auth.js";

// Stub auth middleware that attaches a fixed platform role without JWT
// verification — mirrors what authMiddleware would set.
function stubAuth(role: UserRole) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId: `stub-${role}`, email: `${role}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
}

// Build the full admin router with the given platform role injected. The
// per-domain sub-routers inherit the parent ACCESS gate and add their own gate.
function adminRouterAs(role: UserRole): Hono {
	const app = new Hono();
	app.route("/", createAdminRouter({
		// Sub-routers don't touch these deps; pass safe values so the parent
		// factory constructs without hitting real stores.
		workspaceAccess: null,
		authMiddleware: stubAuth(role),
	}));
	return app;
}

// Each sub-router mount point + the roles that should / should not reach its
// baseline-gated probe path. Baseline permission per domain:
//   revenue    → admin:revenue.read  (owner/admin/accountant yes; support/editor no)
//   support    → admin:support.read  (owner/admin/support yes; accountant/editor no)
//   users-mgmt → admin:users.read    (owner/admin/support yes; accountant/editor no)
//
// `scaffold: true` domains still expose the placeholder route and assert its
// JSON shape. `users-mgmt` has shipped (rank 16): its placeholder is replaced by
// the real `GET /` list route (matched at the bare mount, no trailing path), so
// the probe is "" and only the gate (status) is asserted here — full behavior
// lives in admin-users-mgmt.test.ts. `coupons` has likewise shipped (ranks 9-11):
// its placeholder is replaced by real routes gated by COUPONS_READ/COUPONS_WRITE,
// covered by admin-coupons.test.ts, so it is no longer probed here.
// Content domain (rank 17-18) has shipped real routes — its tests live below.
interface SubrouterCase {
	domain: string;
	mount: string;
	probe: string;
	scaffold: boolean;
	allowed: UserRole;
	denied: UserRole;
}

const CASES: SubrouterCase[] = [
	{ domain: "revenue", mount: "/revenue", probe: "/_placeholder", scaffold: true, allowed: "accountant", denied: "support" },
	{ domain: "users", mount: "/users-mgmt", probe: "", scaffold: false, allowed: "support", denied: "editor" },
];

describe("admin per-domain sub-router scaffold", () => {
	for (const { domain, mount, probe, scaffold, allowed, denied } of CASES) {
		test(`${domain}: ${allowed} reaches ${mount}${probe} (200)`, async () => {
			const res = await adminRouterAs(allowed).request(`${mount}${probe}`);
			expect(res.status).toBe(200);
			if (scaffold) expect(await res.json()).toEqual({ scaffold: domain });
		});

		test(`${domain}: ${denied} is rejected from ${mount}${probe} (403)`, async () => {
			const res = await adminRouterAs(denied).request(`${mount}${probe}`);
			expect(res.status).toBe(403);
		});
	}

	// Owner (full back-office) reaches every domain's baseline probe.
	test("owner reaches every domain probe (200)", async () => {
		const app = adminRouterAs("owner");
		for (const { domain, mount, probe, scaffold } of CASES) {
			const res = await app.request(`${mount}${probe}`);
			expect(res.status).toBe(200);
			if (scaffold) expect(await res.json()).toEqual({ scaffold: domain });
		}
	});

	// A non-admin app role is rejected at the parent ACCESS gate before reaching
	// any sub-router gate.
	test("editor is rejected at the baseline ACCESS gate for every domain (403)", async () => {
		const app = adminRouterAs("editor");
		for (const { mount, probe } of CASES) {
			const res = await app.request(`${mount}${probe}`);
			expect(res.status).toBe(403);
		}
	});

	// CONTENT domain shipped real routes — its baseline READ gate is CONTENT_READ.
	// support holds it (allowed), accountant does not (denied), editor is rejected
	// at the parent ACCESS gate. These hit the real cross-tenant browser endpoint;
	// file-mode returns an (empty) project list rather than a placeholder.
	test("content: support reaches GET /content/projects (200)", async () => {
		const res = await adminRouterAs("support").request("/content/projects");
		expect(res.status).toBe(200);
		const body = await res.json() as { projects: unknown[] };
		expect(Array.isArray(body.projects)).toBe(true);
	});

	test("content: accountant is rejected from GET /content/projects (403)", async () => {
		const res = await adminRouterAs("accountant").request("/content/projects");
		expect(res.status).toBe(403);
	});

	test("content: editor is rejected at the baseline ACCESS gate (403)", async () => {
		const res = await adminRouterAs("editor").request("/content/projects");
		expect(res.status).toBe(403);
	});

	test("content: support cannot moderate (flag) — CONTENT_MODERATE required (403)", async () => {
		const res = await adminRouterAs("support").request("/content/projects/p1/flag", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "spam" }),
		});
		expect(res.status).toBe(403);
	});

	test("content: admin CAN reach the flag route (project not found → 404, gate passed)", async () => {
		const res = await adminRouterAs("admin").request("/content/projects/does-not-exist/flag", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "spam" }),
		});
		// 404 (not 403) proves the CONTENT_MODERATE gate passed and the handler ran.
		expect(res.status).toBe(404);
	});

	// SUPPORT domain shipped real routes (ranks 12-14). Baseline READ gate is
	// SUPPORT_READ (owner/admin/support hold it; accountant does not). The credit
	// grant + plan change layer SUPPORT_ADJUST (support holds it); the refund layers
	// REFUND_WRITE (support does NOT hold it — only owner/admin issue refunds).
	test("support: support reaches GET /support/lookup (unknown customer → 404, gate passed)", async () => {
		// query that matches no user/workspace → 404 (not 403) proves SUPPORT_READ passed.
		const res = await adminRouterAs("support").request("/support/lookup?query=does-not-exist-customer");
		expect(res.status).toBe(404);
	});

	test("support: accountant is rejected from GET /support/lookup (403)", async () => {
		const res = await adminRouterAs("accountant").request("/support/lookup?query=anything");
		expect(res.status).toBe(403);
	});

	test("support: editor is rejected at the baseline ACCESS gate (403)", async () => {
		const res = await adminRouterAs("editor").request("/support/lookup?query=anything");
		expect(res.status).toBe(403);
	});

	test("support: support CAN reach credit grant (SUPPORT_ADJUST) — validation 400, gate passed", async () => {
		// Empty body → 400 (not 403) proves the SUPPORT_ADJUST gate passed and the handler ran.
		const res = await adminRouterAs("support").request("/support/workspaces/ws1/credits", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("support: accountant is rejected from credit grant (SUPPORT_ADJUST) (403)", async () => {
		const res = await adminRouterAs("accountant").request("/support/workspaces/ws1/credits", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 100, reason: "goodwill" }),
		});
		expect(res.status).toBe(403);
	});

	test("support: support CANNOT issue a refund — REFUND_WRITE required (403)", async () => {
		const res = await adminRouterAs("support").request("/support/workspaces/ws1/refund", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "x", idempotencyKey: "k1" }),
		});
		expect(res.status).toBe(403);
	});

	test("support: admin CAN reach the refund route (REFUND_WRITE) — validation 400, gate passed", async () => {
		// Empty body → 400 (not 403) proves the REFUND_WRITE gate passed and the handler ran.
		const res = await adminRouterAs("admin").request("/support/workspaces/ws1/refund", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});
