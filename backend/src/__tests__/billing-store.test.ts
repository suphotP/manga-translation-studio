import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Context, Next } from "hono";
import {
	BillingStoreError,
	dunningGraceActiveSql,
	FileBillingStore,
	isDunningGraceExpired,
	PostgresBillingStore,
	resolveWorkspacePlanDefinition,
	resolveWorkspacePlanIdForProject,
	type WorkspaceAddonGrant,
} from "../services/billing-store.js";
import { createBillingRouter } from "../routes/billing.js";
import type { BillingPermissionChecker } from "../routes/billing.js";
import type { UserRole } from "../types/auth.js";
import {
	WorkspaceAccessError,
	roleHasPermission,
	type WorkspaceMemberRecord,
	type WorkspacePermission,
	type WorkspaceRole,
} from "../services/workspace-access.js";

const tempDirs: string[] = [];

function createFileStore(): { store: FileBillingStore; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "manga-billing-store-"));
	tempDirs.push(directory);
	const path = join(directory, "billing-accounts.json");
	return { store: new FileBillingStore(path), path };
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("FileBillingStore", () => {
	test("persists an assigned plan and reads it back from a fresh instance", async () => {
		const { store, path } = createFileStore();

		const assignment = await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "pro" });
		expect(assignment).toMatchObject({ workspaceId: "ws-1", planId: "pro", status: "mock_active" });
		expect(assignment.createdAt).toEqual(expect.any(String));

		// A brand new store loading the same JSON file must see the assignment.
		const reloaded = new FileBillingStore(path);
		const resolved = await reloaded.resolveWorkspacePlan("ws-1");
		expect(resolved).toMatchObject({ workspaceId: "ws-1", planId: "pro", assigned: true });
		const reread = await reloaded.getWorkspaceAssignment("ws-1");
		expect(reread?.planId).toBe("pro");
	});

	test("falls back to the free plan when a workspace has no assignment", async () => {
		const { store } = createFileStore();

		const resolved = await store.resolveWorkspacePlan("never-assigned");
		expect(resolved).toMatchObject({ planId: "free", assigned: false, status: null });
		expect(await store.getWorkspaceAssignment("never-assigned")).toBeNull();
	});

	test("updating a plan keeps createdAt but advances updatedAt and overrides the plan", async () => {
		const { store } = createFileStore();

		const first = await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "creator" });
		await Bun.sleep(2);
		const second = await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "studio" });

		expect(second.planId).toBe("studio");
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.updatedAt >= first.updatedAt).toBe(true);

		const assignments = await store.listAssignments();
		expect(assignments).toHaveLength(1);
		expect(assignments[0]?.planId).toBe("studio");
	});

	test("preserves the existing status on a plan-only update", async () => {
		const { store } = createFileStore();

		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "creator", status: "active" });
		// Plan-only change (no status): the active lifecycle must survive.
		const updated = await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "pro" });

		expect(updated).toMatchObject({ planId: "pro", status: "active" });
		expect((await store.resolveWorkspacePlan("ws-1"))).toMatchObject({ planId: "pro", assigned: true, status: "active" });
	});

	test("does not treat cancelled assignments as in-effect plans", async () => {
		const { store } = createFileStore();

		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "pro", status: "cancelled" });
		const resolved = await store.resolveWorkspacePlan("ws-1");
		expect(resolved).toMatchObject({ planId: "free", assigned: false, status: "cancelled" });
	});

	test("rejects unknown plan ids", async () => {
		const { store } = createFileStore();
		await expect(store.setWorkspacePlan({ workspaceId: "ws-1", planId: "enterprise" as never })).rejects.toBeInstanceOf(BillingStoreError);
	});

	test("lists only active, unexpired grants for the workspace", async () => {
		const { store, path } = createFileStore();
		const now = Date.now();
		const grants: WorkspaceAddonGrant[] = [
			grant("g-active", "ws-1", { status: "active" }),
			grant("g-expired-status", "ws-1", { status: "expired" }),
			grant("g-revoked", "ws-1", { status: "revoked" }),
			grant("g-past", "ws-1", { status: "active", expiresAt: new Date(now - 1000).toISOString() }),
			grant("g-future", "ws-1", { status: "active", expiresAt: new Date(now + 60_000).toISOString() }),
			grant("g-other-ws", "ws-2", { status: "active" }),
		];
		Bun.write(path, JSON.stringify({ assignments: [], grants }, null, 2));

		const reloaded = new FileBillingStore(path);
		const active = await reloaded.listActiveGrants("ws-1");
		expect(active.map((entry) => entry.grantId).sort()).toEqual(["g-active", "g-future"]);
	});

	test("resolveWorkspacePlanDefinition returns the catalog plan for the assignment", async () => {
		const { store } = createFileStore();
		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "studio" });

		const definition = await resolveWorkspacePlanDefinition("ws-1", store);
		expect(definition).toMatchObject({ id: "studio", maxAiQueueOpenJobs: 120 });

		const fallback = await resolveWorkspacePlanDefinition("unassigned", store);
		expect(fallback.id).toBe("free");
	});
});

describe("resolveWorkspacePlanIdForProject (file-mode quota/admission bridge)", () => {
	// This is the chokepoint that wires a billing-store assignment into storage
	// quota + usage-ledger config + AI admission when PROJECT_CATALOG_STORE=file.
	const previousEnvPlan = process.env.WORKSPACE_PLAN_ID;

	afterEach(() => {
		if (previousEnvPlan === undefined) delete process.env.WORKSPACE_PLAN_ID;
		else process.env.WORKSPACE_PLAN_ID = previousEnvPlan;
	});

	test("returns the assigned plan for the project's workspace", async () => {
		const { store } = createFileStore();
		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "pro" });

		const planId = await resolveWorkspacePlanIdForProject("project-1", { workspaceId: "ws-1", store });
		expect(planId).toBe("pro");
	});

	test("falls back to WORKSPACE_PLAN_ID when the workspace has no in-effect assignment", async () => {
		const { store } = createFileStore();
		process.env.WORKSPACE_PLAN_ID = "creator";

		// Cancelled assignment is not in-effect, so the env fallback applies.
		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "studio", status: "cancelled" });
		const planId = await resolveWorkspacePlanIdForProject("project-1", { workspaceId: "ws-1", store });
		expect(planId).toBe("creator");
	});

	test("returns undefined (catalog default) when nothing is assigned and no env plan is set", async () => {
		const { store } = createFileStore();
		delete process.env.WORKSPACE_PLAN_ID;

		const planId = await resolveWorkspacePlanIdForProject("project-1", { workspaceId: "ws-unknown", store });
		expect(planId).toBeUndefined();
	});
});

describe("PostgresBillingStore", () => {
	test("upserts the workspace plan with the migration 0006 columns", async () => {
		const client = new FakeBillingSqlClient();
		const store = new PostgresBillingStore(client);

		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "pro", billingEmail: "owner@example.com" });

		const insert = client.queries.find((entry) => entry.query.includes("INSERT INTO workspace_billing_accounts"));
		expect(insert).toBeDefined();
		expect(insert?.query).toContain("ON CONFLICT (workspace_id) DO UPDATE");
		// status param is null when the caller omits it; the SQL COALESCEs it to
		// the existing row's status (insert default 'mock_active') so a plan-only
		// update never clobbers an active/trialing/past_due/cancelled lifecycle.
		expect(insert?.params.slice(0, 4)).toEqual(["ws-1", "pro", null, "owner@example.com"]);
		expect(insert?.query).toContain("status = COALESCE($3, workspace_billing_accounts.status, EXCLUDED.status)");
	});

	test("passes an explicit status through instead of preserving the prior one", async () => {
		const client = new FakeBillingSqlClient();
		const store = new PostgresBillingStore(client);

		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "pro", status: "active" });

		const insert = client.queries.find((entry) => entry.query.includes("INSERT INTO workspace_billing_accounts"));
		expect(insert?.params[2]).toBe("active");
	});

	test("maps a stored assignment row and resolves the plan", async () => {
		const client = new FakeBillingSqlClient();
		client.billingRows = [{
			workspace_id: "ws-1",
			plan_id: "creator",
			status: "active",
			billing_email: null,
			current_period_start: null,
			current_period_end: null,
			created_at: "2026-05-01T00:00:00.000Z",
			updated_at: "2026-05-02T00:00:00.000Z",
		}];
		const store = new PostgresBillingStore(client);

		const resolved = await store.resolveWorkspacePlan("ws-1");
		expect(resolved).toMatchObject({ planId: "creator", assigned: true, status: "active" });
	});

	// ── P1 (money-critical): dunning access-time gate ──
	// An `active` account whose `dunning_grace_until` has already passed must NOT keep
	// paid access just because no post-deadline webhook ever arrived to flip it.
	test("an active account PAST its dunning grace deadline resolves to free/past_due", async () => {
		const client = new FakeBillingSqlClient();
		client.billingRows = [{
			workspace_id: "ws-dunning",
			plan_id: "studio",
			status: "active",
			billing_email: null,
			current_period_start: null,
			current_period_end: null,
			// Deadline well in the past → access-time downgrade.
			metadata: { dunning_grace_until: "2000-01-01T00:00:00.000Z" },
			created_at: "2026-05-01T00:00:00.000Z",
			updated_at: "2026-05-02T00:00:00.000Z",
		}];
		const store = new PostgresBillingStore(client);

		const resolved = await store.resolveWorkspacePlan("ws-dunning");
		// Paid plan is NOT granted; the workspace falls back to free and is reported past_due.
		expect(resolved).toMatchObject({ planId: "free", assigned: false, status: "past_due" });

		// The assignment query must SELECT metadata so the gate can read the deadline.
		const select = client.queries.find((entry) => entry.query.includes("FROM workspace_billing_accounts") && entry.query.includes("WHERE workspace_id = $1"));
		expect(select?.query).toContain("metadata");
	});

	test("an active account with a FUTURE dunning grace deadline keeps paid access", async () => {
		const client = new FakeBillingSqlClient();
		client.billingRows = [{
			workspace_id: "ws-grace",
			plan_id: "studio",
			status: "active",
			billing_email: null,
			current_period_start: null,
			current_period_end: null,
			// Far-future deadline → the retry window is still open, access preserved.
			metadata: { dunning_grace_until: "2999-01-01T00:00:00.000Z" },
			created_at: "2026-05-01T00:00:00.000Z",
			updated_at: "2026-05-02T00:00:00.000Z",
		}];
		const store = new PostgresBillingStore(client);

		const resolved = await store.resolveWorkspacePlan("ws-grace");
		expect(resolved).toMatchObject({ planId: "studio", assigned: true, status: "active" });
	});

	// A subscription recovery (subscription.active|renewed) CLEARS dunning_grace_until to
	// null in metadata. A null deadline must NOT be treated as an expired grace, so the
	// recovered active account resolves to its paid plan (not free/past_due).
	test("an active account whose dunning grace was CLEARED (null) keeps its paid plan", async () => {
		const client = new FakeBillingSqlClient();
		client.billingRows = [{
			workspace_id: "ws-recovered",
			plan_id: "studio",
			status: "active",
			billing_email: null,
			current_period_start: null,
			current_period_end: null,
			// Recovery cleared the grace (and the stale failed/expired flags) to null/false.
			metadata: { dunning_grace_until: null, dunning_failed_at: null, dunning_expired: false },
			created_at: "2026-05-01T00:00:00.000Z",
			updated_at: "2026-05-02T00:00:00.000Z",
		}];
		const store = new PostgresBillingStore(client);

		const resolved = await store.resolveWorkspacePlan("ws-recovered");
		expect(resolved).toMatchObject({ planId: "studio", assigned: true, status: "active" });
	});

	test("only reads active, unexpired grants", async () => {
		const client = new FakeBillingSqlClient();
		const store = new PostgresBillingStore(client);
		await store.listActiveGrants("ws-1");

		const grantQuery = client.queries.find((entry) => entry.query.includes("FROM workspace_addon_grants"));
		expect(grantQuery?.query).toContain("status = 'active'");
		expect(grantQuery?.query).toContain("expires_at IS NULL OR expires_at > now()");
		expect(grantQuery?.params).toEqual(["ws-1"]);
	});

	test("listWorkspaceAccounts uses ONE join query (no per-row getWorkspace) and bounds the page", async () => {
		const client = new FakeBillingSqlClient();
		client.accountRows = [{
			workspace_id: "ws-1",
			name: "Studio Alpha",
			plan_id: "pro",
			status: "active",
			billing_email: "owner@example.com",
			created_at: "2026-04-01T00:00:00.000Z",
			updated_at: "2026-05-02T00:00:00.000Z",
			cursor_updated_at: "2026-05-02T00:00:00.000000Z",
		}];
		const store = new PostgresBillingStore(client);

		const page = await store.listWorkspaceAccounts({ limit: 25 });

		// Two bounded queries: ONE COUNT(*) for the honest total + ONE join for the
		// page — never an N+1 of getWorkspace, and never per-row.
		expect(client.queries).toHaveLength(2);
		const count = client.queries[0];
		expect(count.query).toContain("COUNT(*)");
		expect(count.query).toContain("LEFT JOIN workspaces w ON w.workspace_id = b.workspace_id");
		// The count query carries no cursor/limit params — it is the full filtered set.
		expect(count.params).toHaveLength(0);
		const join = client.queries[1];
		expect(join.query).toContain("LEFT JOIN workspaces w ON w.workspace_id = b.workspace_id");
		expect(join.query).toContain("ORDER BY b.updated_at DESC, b.workspace_id ASC");
		// LIMIT is bounded (limit + 1 for the has-more probe).
		expect(join.params[join.params.length - 1]).toBe(26);
		// Parity: the row carries the SAME fields the old route returned.
		expect(page.workspaces[0]).toEqual({
			workspaceId: "ws-1",
			name: "Studio Alpha",
			planId: "pro",
			status: "active",
			billingEmail: "owner@example.com",
			createdAt: "2026-04-01T00:00:00.000Z",
			updatedAt: "2026-05-02T00:00:00.000Z",
		});
		expect(page.nextCursor).toBeUndefined();
		// Honest total = the full filtered count (here, the single seeded row).
		expect(page.total).toBe(1);
	});

	test("listWorkspaceAccounts pushes plan/status/search filters into SQL", async () => {
		const client = new FakeBillingSqlClient();
		const store = new PostgresBillingStore(client);

		await store.listWorkspaceAccounts({ plan: "pro", status: "active", search: "Alpha" });

		// queries[0] is the COUNT(*), queries[1] is the page join. The filter
		// conditions/params are SHARED between them so the total and the page agree.
		const count = client.queries[0];
		const join = client.queries[1];
		expect(count.params).toEqual(["pro", "active", "%alpha%"]);
		expect(join.query).toContain("b.plan_id = $1");
		expect(join.query).toContain("b.status = $2");
		// search becomes a parameterized LIKE over name/id/email (no JS filtering).
		expect(join.query).toContain("LIKE $3");
		expect(join.params[0]).toBe("pro");
		expect(join.params[1]).toBe("active");
		expect(join.params[2]).toBe("%alpha%");
	});

	test("listWorkspaceAccounts emits a keyset cursor when more rows remain", async () => {
		const client = new FakeBillingSqlClient();
		client.accountRows = [
			{ workspace_id: "ws-1", name: "A", plan_id: "pro", status: "active", billing_email: null, created_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-05-03T00:00:00.000Z", cursor_updated_at: "2026-05-03T00:00:00.000000Z" },
			{ workspace_id: "ws-2", name: "B", plan_id: "free", status: "active", billing_email: null, created_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-05-02T00:00:00.000Z", cursor_updated_at: "2026-05-02T00:00:00.000000Z" },
		];
		const store = new PostgresBillingStore(client);

		// limit 1 → fake returns 2 rows (limit+1 probe) so a nextCursor is emitted.
		const page = await store.listWorkspaceAccounts({ limit: 1 });
		expect(page.workspaces).toHaveLength(1);
		expect(page.workspaces[0].workspaceId).toBe("ws-1");
		expect(page.nextCursor).toBeDefined();

		// The cursor decodes to the last returned row's (updated_at, workspace_id).
		const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8")) as [string, string];
		expect(decoded).toEqual(["2026-05-03T00:00:00.000000Z", "ws-1"]);
	});
});

describe("FileBillingStore.listWorkspaceAccounts", () => {
	test("filters, orders, and keyset-paginates with bounded pages", async () => {
		const { store } = createFileStore();
		await store.setWorkspacePlan({ workspaceId: "ws-a", planId: "pro", status: "active", billingEmail: "a@example.com" });
		await Bun.sleep(2);
		await store.setWorkspacePlan({ workspaceId: "ws-b", planId: "free", status: "trialing" });
		await Bun.sleep(2);
		await store.setWorkspacePlan({ workspaceId: "ws-c", planId: "pro", status: "active" });

		// Newest first by updated_at: ws-c, ws-b, ws-a.
		const first = await store.listWorkspaceAccounts({ limit: 2 });
		expect(first.workspaces.map((w) => w.workspaceId)).toEqual(["ws-c", "ws-b"]);
		expect(first.nextCursor).toBeDefined();
		// Honest total is the FULL filtered count (3), not the page length (2), and it
		// stays stable across pages so the header never shrinks while paging.
		expect(first.total).toBe(3);

		const second = await store.listWorkspaceAccounts({ limit: 2, cursor: first.nextCursor });
		expect(second.workspaces.map((w) => w.workspaceId)).toEqual(["ws-a"]);
		expect(second.nextCursor).toBeUndefined();
		expect(second.total).toBe(3);

		// Plan filter is applied in-store (no whole-table leak to the route). Total
		// reflects the filter, not the whole table.
		const proOnly = await store.listWorkspaceAccounts({ plan: "pro" });
		expect(proOnly.workspaces.map((w) => w.workspaceId).sort()).toEqual(["ws-a", "ws-c"]);
		expect(proOnly.total).toBe(2);

		// Search matches workspaceId / billingEmail (name falls back to workspaceId).
		const searchEmail = await store.listWorkspaceAccounts({ search: "a@example" });
		expect(searchEmail.workspaces.map((w) => w.workspaceId)).toEqual(["ws-a"]);
		expect(searchEmail.total).toBe(1);
	});

	test("clamps an oversized limit to the hard maximum", async () => {
		const { store } = createFileStore();
		await store.setWorkspacePlan({ workspaceId: "ws-a", planId: "pro" });
		// 10_000 is clamped, so the single seeded row still returns without error.
		const page = await store.listWorkspaceAccounts({ limit: 10_000 });
		expect(page.workspaces).toHaveLength(1);
	});
});

describe("billing route permission enforcement", () => {
	// Plan ASSIGNMENT is platform-internal: it requires the platform admin role
	// (requireAdmin) in addition to the tenant `update_workspace` permission, so a
	// tenant owner can no longer self-assign a paid plan with no checkout.

	test("rejects plan assignment from a tenant owner who is NOT a platform admin", async () => {
		// Owner has update_workspace, but only a platform 'editor' role — the
		// internal guard must reject the write before any plan is persisted.
		const { app, store } = buildRouter({ workspaceRole: "owner", platformRole: "editor" });
		const res = await app.request("/ws-1/plan", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "pro" }),
		});
		expect(res.status).toBe(403);
		expect((await store.getWorkspaceAssignment("ws-1"))).toBeNull();
	});

	test("rejects plan assignment from a platform admin lacking update_workspace", async () => {
		const { app, store } = buildRouter({ workspaceRole: "viewer", platformRole: "admin" });
		const res = await app.request("/ws-1/plan", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "pro" }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("workspace_permission_denied");
		expect((await store.getWorkspaceAssignment("ws-1"))).toBeNull();
	});

	test("allows a platform admin with update_workspace to assign a plan and persists it", async () => {
		const { app, store } = buildRouter({ workspaceRole: "owner", platformRole: "admin" });
		const res = await app.request("/ws-1/plan", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "pro" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { assignment: { planId: string }; plan: { id: string } };
		expect(body.assignment.planId).toBe("pro");
		expect(body.plan.id).toBe("pro");
		expect((await store.resolveWorkspacePlan("ws-1")).planId).toBe("pro");
	});

	test("lets a viewer read the current plan (read_workspace), no platform admin needed", async () => {
		const { app, store } = buildRouter({ workspaceRole: "viewer", platformRole: "viewer" });
		await store.setWorkspacePlan({ workspaceId: "ws-1", planId: "studio" });
		const res = await app.request("/ws-1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { planId: string; assigned: boolean };
		expect(body).toMatchObject({ planId: "studio", assigned: true });
	});

	test("rejects an invalid plan id with a 400 before touching the store", async () => {
		const { app, store } = buildRouter({ workspaceRole: "owner", platformRole: "admin" });
		const res = await app.request("/ws-1/plan", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "enterprise" }),
		});
		expect(res.status).toBe(400);
		expect((await store.getWorkspaceAssignment("ws-1"))).toBeNull();
	});

	test("maps a BillingStoreError from the store to a 400 with its code", async () => {
		const store = new FileBillingStore();
		store.setWorkspacePlan = async () => {
			throw new BillingStoreError("Unknown workspace plan 'x'", "billing_unknown_plan");
		};
		const app = createBillingRouter({
			billingStore: store,
			workspaceAccessStore: new FakeWorkspaceAccessStore("owner"),
			authMiddleware: stubAuth("admin"),
		});
		const res = await app.request("/ws-1/plan", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planId: "pro" }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code?: string }).code).toBe("billing_unknown_plan");
	});

	test("returns 503 when the workspace access store is unconfigured", async () => {
		const store = new FileBillingStore();
		const app = createBillingRouter({
			billingStore: store,
			workspaceAccessStore: null,
			authMiddleware: stubAuth("admin"),
		});
		const res = await app.request("/ws-1");
		expect(res.status).toBe(503);
	});
});

describe("billing checkout/portal session routes", () => {
	const mockBilling = { provider: "mock" as const, appBaseUrl: "https://app.example.com" };

	function buildSessionRouter(role: WorkspaceRole, billingConfig = mockBilling) {
		return createBillingRouter({
			billingStore: new FileBillingStore(),
			workspaceAccessStore: new FakeWorkspaceAccessStore(role),
			// Session routes are self-service: a non-platform-admin owner must pass.
			authMiddleware: stubAuth("editor"),
			billingConfig,
		});
	}

	test("starts a mock checkout session for an owner and returns an app-origin URL", async () => {
		const app = buildSessionRouter("owner");
		const res = await app.request("/ws-1/checkout-session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plan_key: "studio", billing_cycle: "yearly" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { checkout_url: string; session_id: string; provider: string };
		expect(body.provider).toBe("mock");
		expect(body.session_id).toMatch(/^mock_cs_/);
		expect(body.checkout_url.startsWith("https://app.example.com/billing/mock-checkout?")).toBe(true);
		const url = new URL(body.checkout_url);
		expect(url.searchParams.get("plan")).toBe("studio");
		expect(url.searchParams.get("internal_plan")).toBe("studio");
		expect(url.searchParams.get("cycle")).toBe("yearly");
		// BYO retired (2026-06-12): the checkout schema accepts no addon values.
		expect(url.searchParams.getAll("addon")).toEqual([]);
	});

	test("rejects the retired byo_api add-on at the checkout boundary", async () => {
		const app = buildSessionRouter("owner");
		const res = await app.request("/ws-1/checkout-session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plan_key: "studio", billing_cycle: "yearly", addons: ["byo_api"] }),
		});
		expect(res.status).toBe(400);
	});

	test("maps the public starter key onto the internal creator plan", async () => {
		const app = buildSessionRouter("owner");
		const res = await app.request("/ws-1/checkout-session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plan_key: "starter", billing_cycle: "monthly" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { checkout_url: string };
		expect(new URL(body.checkout_url).searchParams.get("internal_plan")).toBe("creator");
	});

	test("rejects checkout from a viewer lacking update_workspace", async () => {
		const app = buildSessionRouter("viewer");
		const res = await app.request("/ws-1/checkout-session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plan_key: "pro", billing_cycle: "monthly" }),
		});
		expect(res.status).toBe(403);
	});

	test("rejects an unknown plan key with 400 before building a session", async () => {
		const app = buildSessionRouter("owner");
		const res = await app.request("/ws-1/checkout-session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plan_key: "free", billing_cycle: "monthly" }),
		});
		expect(res.status).toBe(400);
	});

	test("delegates to the downstream Dodo router when a real provider is configured", async () => {
		// With provider === "dodo" this router defers (`next()`) to billing-dodo.ts,
		// which owns the real checkout session. On a standalone router (no downstream
		// handler mounted) the fall-through surfaces as 404 — proving this router no
		// longer shadows the real Dodo route once an operator opts into "dodo".
		const app = buildSessionRouter("owner", { provider: "dodo", appBaseUrl: "https://app.example.com" });
		const res = await app.request("/ws-1/checkout-session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plan_key: "pro", billing_cycle: "monthly" }),
		});
		expect(res.status).toBe(404);
	});

	test("opens a mock portal session for an owner", async () => {
		const app = buildSessionRouter("owner");
		const res = await app.request("/ws-1/portal-session", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { portal_url: string; provider: string };
		expect(body.provider).toBe("mock");
		expect(body.portal_url.startsWith("https://app.example.com/billing/mock-portal?")).toBe(true);
		expect(new URL(body.portal_url).searchParams.get("workspace")).toBe("ws-1");
	});

	test("rejects portal entry from a viewer lacking update_workspace", async () => {
		const app = buildSessionRouter("viewer");
		const res = await app.request("/ws-1/portal-session", { method: "POST" });
		expect(res.status).toBe(403);
	});
});

function buildRouter(
	roles: { workspaceRole: WorkspaceRole; platformRole: UserRole },
): { app: ReturnType<typeof createBillingRouter>; store: FileBillingStore } {
	const store = new FileBillingStore();
	// Uses the REAL requireAdmin guard (default platformAdminGuard) against the
	// platform role minted by stubAuth, exercising the actual internal-guard wiring.
	const app = createBillingRouter({
		billingStore: store,
		workspaceAccessStore: new FakeWorkspaceAccessStore(roles.workspaceRole),
		authMiddleware: stubAuth(roles.platformRole),
	});
	return { app, store };
}

function stubAuth(platformRole: UserRole) {
	return async (c: Context, next: Next) => {
		c.set("user", { userId: `user-${platformRole}`, email: `${platformRole}@example.com`, role: platformRole });
		await next();
	};
}

function grant(grantId: string, workspaceId: string, overrides: Partial<WorkspaceAddonGrant> = {}): WorkspaceAddonGrant {
	return {
		grantId,
		workspaceId,
		addonId: "storage-25gb",
		quantity: 1,
		aiCredits: 0,
		storageBytes: 0,
		seats: 0,
		teamJobs: 0,
		status: "active",
		source: "mock",
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		...overrides,
	};
}

class FakeWorkspaceAccessStore implements BillingPermissionChecker {
	constructor(private readonly role: WorkspaceRole) {}

	async requirePermission(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<WorkspaceMemberRecord> {
		if (!roleHasPermission(this.role, permission)) {
			throw new WorkspaceAccessError(`Forbidden: missing workspace permission '${permission}'`, 403, "workspace_permission_denied");
		}
		return {
			workspaceId,
			userId,
			role: this.role,
			scope: {},
			createdAt: "2026-05-01T00:00:00.000Z",
			updatedAt: "2026-05-01T00:00:00.000Z",
		};
	}
}

class FakeBillingSqlClient {
	queries: Array<{ query: string; params: unknown[] }> = [];
	billingRows: Array<Record<string, unknown>> = [];
	grantRows: Array<Record<string, unknown>> = [];
	/** Rows returned for the admin listWorkspaceAccounts JOIN query. */
	accountRows: Array<Record<string, unknown>> = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		if (query.includes("INSERT INTO workspace_billing_accounts")) {
			return [{
				workspace_id: params[0],
				plan_id: params[1],
				status: params[2],
				billing_email: params[3] ?? null,
				current_period_start: params[4] ?? null,
				current_period_end: params[5] ?? null,
				created_at: "2026-05-01T00:00:00.000Z",
				updated_at: "2026-05-02T00:00:00.000Z",
			}] as T[];
		}
		// The admin browser join must resolve BEFORE the generic billing-account
		// branch since the query also references `FROM workspace_billing_accounts`.
		if (query.includes("COUNT(*)") && query.includes("LEFT JOIN workspaces")) {
			// Bounded COUNT(*) over the same filter — reports the full seeded count
			// so the honest-total assertions pass. Must precede the page-join branch
			// (both contain "LEFT JOIN workspaces").
			return [{ total: this.accountRows.length }] as T[];
		}
		if (query.includes("LEFT JOIN workspaces")) {
			const limit = Number(params[params.length - 1]);
			return this.accountRows.slice(0, Number.isFinite(limit) ? limit : undefined) as T[];
		}
		if (query.includes("FROM workspace_billing_accounts")) {
			return this.billingRows as T[];
		}
		if (query.includes("FROM workspace_addon_grants")) {
			return this.grantRows as T[];
		}
		return [] as T[];
	}
}

// P1 (money): the grace-aware plan/quota gate. dunningGraceActiveSql is the ONE SQL
// mirror of isDunningGraceExpired shared by every plan/storage/AI read path, so a
// grace-expired `active` account resolves to FREE everywhere.
describe("dunningGraceActiveSql + isDunningGraceExpired (grace-aware plan resolution)", () => {
	test("isDunningGraceExpired fails OPEN on missing/garbage and CLOSED only on a past deadline", () => {
		const now = new Date("2026-06-06T00:00:00.000Z");
		expect(isDunningGraceExpired(undefined, now)).toBe(false);
		expect(isDunningGraceExpired({}, now)).toBe(false);
		expect(isDunningGraceExpired({ dunning_grace_until: "not-a-date" }, now)).toBe(false);
		expect(isDunningGraceExpired({ dunning_grace_until: "2026-07-01T00:00:00.000Z" }, now)).toBe(false); // future
		expect(isDunningGraceExpired({ dunning_grace_until: "2026-06-01T00:00:00.000Z" }, now)).toBe(true); // past
	});

	test("dunningGraceActiveSql emits a fail-open, alias-scoped grace gate", () => {
		const sql = dunningGraceActiveSql("wba");
		// Only an ISO-shaped value is cast (regex gate) → garbage can never raise a cast
		// error nor be read as expired; the gate trips solely on a past deadline.
		expect(sql).toContain("wba.metadata->>'dunning_grace_until'");
		expect(sql).toContain("~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'");
		expect(sql).toContain("::timestamptz <= now()");
		expect(sql.startsWith("NOT (")).toBe(true);
		// Default alias is the canonical table name.
		expect(dunningGraceActiveSql()).toContain("workspace_billing_accounts.metadata->>'dunning_grace_until'");
	});
});
