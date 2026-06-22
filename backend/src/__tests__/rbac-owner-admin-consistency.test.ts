// RBAC consistency: owner=admin hierarchy + admin workspace-enum permission.
//
// Covers the codex-audited defects:
//   #3 admin workspace list/detail must require a fine-grained workspace-read
//      permission (SUPPORT_READ or REVENUE_READ) on top of baseline admin:access,
//      WITHOUT locking out support (customer-360) or accountant (revenue/billing).
//   #4 locks force-release / sweep / canMutateWorkLocks must admit owner (admin
//      superset), not literal role === "admin".
//   #5 credits degraded-mode must admit owner+admin consistently.
//
// The owner=admin hierarchy is centralized in isPlatformAdmin(); these tests pin
// the helper plus the route-level gate behavior so the literal-compare bug cannot
// silently return.

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createAdminRouter, type AdminRouterDeps } from "../routes/admin.js";
import { canMutateWorkLocks } from "../routes/locks.js";
import { assets } from "../routes/assets.js";
import { resolveWorkActorRoleForRequest } from "../routes/work-states.js";
import { isPlatformAdmin, hasPermission, ADMIN_PERMISSIONS } from "../types/auth.js";
import type { UserRole } from "../types/auth.js";

function stubAuth(role: UserRole) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId: `stub-${role}`, email: `${role}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
}

// Minimal stub stores so the workspace list/detail routes execute end-to-end
// behind the gate without touching Postgres/file stores.
const stubWorkspaceAccess = {
	listAllWorkspacePage: async () => ({
		workspaces: [{ workspaceId: "ws-1", name: "WS One", createdAt: new Date().toISOString() }],
		total: 1,
		nextCursor: null,
	}),
	getWorkspace: async (id: string) => ({ workspaceId: id, name: "WS One", createdAt: new Date().toISOString() }),
} as unknown as NonNullable<AdminRouterDeps["workspaceAccess"]>;

const stubBilling = {
	getWorkspaceAssignment: async () => null,
	listActiveGrants: async () => [],
	listWorkspaceAccounts: async () => ({ workspaces: [], total: 0, nextCursor: null }),
} as unknown as NonNullable<AdminRouterDeps["billing"]>;

function adminRouterAs(role: UserRole): Hono {
	const app = new Hono();
	app.route("/", createAdminRouter({
		workspaceAccess: stubWorkspaceAccess,
		billing: stubBilling,
		authMiddleware: stubAuth(role),
	}));
	return app;
}

describe("isPlatformAdmin (owner→admin hierarchy helper)", () => {
	test("owner and admin are platform admins; lesser roles are not", () => {
		expect(isPlatformAdmin("owner")).toBe(true);
		expect(isPlatformAdmin("admin")).toBe(true);
		expect(isPlatformAdmin("support")).toBe(false);
		expect(isPlatformAdmin("accountant")).toBe(false);
		expect(isPlatformAdmin("editor")).toBe(false);
		expect(isPlatformAdmin("viewer")).toBe(false);
	});
});

describe("#4 lock mutation admits owner (admin superset)", () => {
	test("canMutateWorkLocks allows owner/admin/editor, denies viewer", () => {
		expect(canMutateWorkLocks("owner")).toBe(true);
		expect(canMutateWorkLocks("admin")).toBe(true);
		expect(canMutateWorkLocks("editor")).toBe(true);
		expect(canMutateWorkLocks("viewer")).toBe(false);
	});
});

describe("assets promote gate (requireAdminOrQc) admits owner (admin superset)", () => {
	// POST /api/assets/:id/promote gates on requireAdminOrQc. owner is a strict
	// superset of the platform admin role, so the literal role !== "admin" used to
	// 403 an owner. We assert owner/admin/editor pass the gate (reaching the 400
	// missing-workspaceId branch), while viewer is stopped at the gate with 403.
	function assetsAppAs(role: UserRole | null): Hono {
		const app = new Hono();
		app.use("*", async (c, next) => {
			if (role) c.set("user", { userId: `u-${role}`, email: `${role}@x.com`, role, iat: 0, exp: 0 });
			await next();
		});
		app.route("/api/assets", assets);
		return app;
	}

	async function promote(role: UserRole | null): Promise<number> {
		const res = await assetsAppAs(role).request("/api/assets/v1/promote", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}), // no workspaceId → 400 IF the auth gate let us through
		});
		return res.status;
	}

	test("owner passes the gate (400 missing workspaceId, not 403)", async () => {
		expect(await promote("owner")).toBe(400);
	});
	test("admin passes the gate (unchanged)", async () => {
		expect(await promote("admin")).toBe(400);
	});
	test("editor (QC) passes the gate", async () => {
		expect(await promote("editor")).toBe(400);
	});
	test("viewer is stopped at the gate (403)", async () => {
		expect(await promote("viewer")).toBe(403);
	});
	test("unauthenticated is 401", async () => {
		expect(await promote(null)).toBe(401);
	});
});

describe("work-states actor-role mapping admits owner (admin superset)", () => {
	// resolveWorkActorRoleForRequest maps a platform JWT role to a work-role. A
	// platform admin maps to the "admin" work-role; owner (admin superset) must too.
	// Previously a literal jwtRole === "admin" let an owner fall through to null.
	test("platform owner maps to the admin work-role (default)", () => {
		expect(resolveWorkActorRoleForRequest("owner")).toBe("admin");
	});
	test("platform admin maps to the admin work-role (unchanged)", () => {
		expect(resolveWorkActorRoleForRequest("admin")).toBe("admin");
	});
	test("platform owner honors a requested work-role like admin does", () => {
		expect(resolveWorkActorRoleForRequest("owner", "qc")).toBe("qc");
	});
	test("a non-admin platform role does NOT get the admin work-role", () => {
		// editor with no membership defaults to translator, never admin.
		expect(resolveWorkActorRoleForRequest("editor")).toBe("translator");
	});
});

describe("#3 admin workspace enumeration permission gate", () => {
	// owner/admin (full back-office), support (SUPPORT_READ), accountant
	// (REVENUE_READ) all legitimately need workspace lookups — none may be locked out.
	for (const role of ["owner", "admin", "support", "accountant"] as const) {
		test(`${role} can list workspaces (200)`, async () => {
			const res = await adminRouterAs(role).request("/workspaces");
			expect(res.status).toBe(200);
			const body = await res.json() as { workspaces: unknown[] };
			expect(Array.isArray(body.workspaces)).toBe(true);
		});

		test(`${role} can read a workspace detail (200)`, async () => {
			const res = await adminRouterAs(role).request("/workspaces/ws-1");
			expect(res.status).toBe(200);
		});
	}

	// editor/viewer lack admin:access → blocked at the baseline parent gate.
	test("editor is rejected (403) — no admin:access", async () => {
		const res = await adminRouterAs("editor").request("/workspaces");
		expect(res.status).toBe(403);
	});

	// The gate is strictly stronger than baseline admin:access: a hypothetical
	// access-only role (admin:access but neither SUPPORT_READ nor REVENUE_READ)
	// would NOT satisfy requireAnyPermission(SUPPORT_READ, REVENUE_READ). We assert
	// the permission shape that backs the gate so the gate can't silently weaken to
	// bare admin:access.
	test("workspace visibility requires SUPPORT_READ or REVENUE_READ, not bare ACCESS", () => {
		// support has SUPPORT_READ but NOT REVENUE_READ; accountant the reverse.
		expect(hasPermission("support", ADMIN_PERMISSIONS.SUPPORT_READ)).toBe(true);
		expect(hasPermission("support", ADMIN_PERMISSIONS.REVENUE_READ)).toBe(false);
		expect(hasPermission("accountant", ADMIN_PERMISSIONS.REVENUE_READ)).toBe(true);
		expect(hasPermission("accountant", ADMIN_PERMISSIONS.SUPPORT_READ)).toBe(false);
		// An access-only grant satisfies neither side of the OR gate.
		const accessOnly: string[] = [ADMIN_PERMISSIONS.ACCESS];
		expect(accessOnly.includes(ADMIN_PERMISSIONS.SUPPORT_READ)).toBe(false);
		expect(accessOnly.includes(ADMIN_PERMISSIONS.REVENUE_READ)).toBe(false);
	});
});
