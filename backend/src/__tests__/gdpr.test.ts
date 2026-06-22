// W2.6 — GDPR + consent + admin route tests.
//
// Each describe block targets a separate piece of the surface:
//   * MemoryGdprStore — direct store contract (consent capture, export jobs,
//     soft-delete + restore, impersonation + admin audit).
//   * Signed export URLs — HMAC roundtrip + expiry semantics.
//   * createConsentRouter — anonymous + authed POSTs, cookie mirror.
//   * createAccountRouter — request export, signed download, soft delete, undo.
//   * createAdminRouter — admin gate, list/grant/refund/impersonate/cron.
//
// Routes are exercised via the Hono router's `request` helper directly, with a
// stub auth middleware that mirrors what authMiddleware would attach. That way
// we keep the tests free of JWT plumbing while still covering the role gate.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { CreditService } from "../services/credits.js";
import { FilePaymentTransactionsStore, type PaymentTransactionsStore } from "../services/payment-transactions-store.js";
import { DodoService } from "../services/dodo.service.js";
import { serverConfig } from "../config.js";
import type DodoPayments from "dodopayments";
import {
	MemoryGdprStore,
	buildSignedExportUrl,
	verifyExportSignature,
	createMemoryGdprStore,
	buildAccountExportBundle,
	runGdprErasureSweep,
	RestoreGraceExpiredError,
} from "../services/gdpr.js";
import { FileProjectCatalogStore } from "../services/project-catalog.js";
import type { ProjectState } from "../types/index.js";
import { createConsentRouter } from "../routes/consent.js";
import { createAccountRouter } from "../routes/account.js";
import { notify } from "../services/notification-dispatch.js";
import { createAdminRouter, type AdminCronAdapter } from "../routes/admin.js";
import { createUser, deleteUser, generateAccessToken, loadUser } from "../services/auth.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { authUserStore, LastPlatformOwnerError } from "../services/auth-users.js";
import { ADMIN_PERMISSIONS, type UserRole } from "../types/auth.js";
import type {
	AdminWorkspaceAccountPage,
	ListWorkspaceAccountsOptions,
	WorkspaceAddonGrant,
	WorkspaceBillingAssignment,
	BillingStore,
	ResolvedWorkspacePlan,
} from "../services/billing-store.js";
import type {
	WorkspaceAccessStore,
	WorkspaceRecord,
	AllWorkspacesListOptions,
	AllWorkspacesPage,
} from "../services/workspace-access.js";

// ── Shared helpers ────────────────────────────────────────────────

function makeUniqueEmail(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function createAdminUser() {
	const { user } = await createUser({
		email: makeUniqueEmail("gdpr-admin"),
		password: "AdminP@ss123",
		name: "Admin User",
		role: "admin",
	});
	return user;
}

async function createEditorUser() {
	const { user } = await createUser({
		email: makeUniqueEmail("gdpr-editor"),
		password: "EditorP@ss123",
		name: "Editor User",
		role: "editor",
	});
	return user;
}

async function createOwnerUser(prefix = "gdpr-owner") {
	const { user } = await createUser({
		email: makeUniqueEmail(prefix),
		password: "OwnerP@ss123",
		name: "Owner User",
		role: "owner",
	});
	return user;
}

// SECURITY (P1): the shared file-mode authUserStore counts EVERY active owner on
// disk, so to make a "solo owner" scenario deterministic we quarantine any
// pre-existing active owners (leftover fixtures from other test files) for the
// duration of `fn`, then restore them. Raw `update` is used deliberately — we are
// setting up the precondition, not exercising the guarded code under test.
async function withSoleActiveOwner<T>(soleOwnerId: string, fn: () => Promise<T>): Promise<T> {
	const others = (await authUserStore.list()).filter(
		(u) => u.role === "owner" && u.isActive && u.id !== soleOwnerId,
	);
	for (const o of others) await authUserStore.update(o.id, { isActive: false });
	try {
		return await fn();
	} finally {
		for (const o of others) await authUserStore.update(o.id, { isActive: true });
	}
}

// Stub auth middleware that attaches a fixed user payload without going through
// JWT verification. Tests opt into a platform role per router instance.
function stubAuth(payload: { userId: string; email: string; role: UserRole } | null) {
	return async (c: Context, next: Next) => {
		if (payload) c.set("user", { ...payload, iat: 0, exp: 0 });
		await next();
	};
}

// Fresh, isolated in-memory credit ledger for a test (the inline /credits route
// delegates to it — a grant ACTUALLY mints, so balances move and idempotency holds).
function freshCreditService(): CreditService {
	return new CreditService(join(tmpdir(), `gdpr-admin-credits-${randomUUID()}.json`), undefined, { crossProcessSafe: false });
}

// A DodoService wired to a LIVE-provider config + a spy refunds.create so the inline
// /refund route's delegated provider call is observable + deterministic (no network).
function spyDodo(): { dodo: DodoService; readonly calls: number } {
	const state = { calls: 0 };
	const dodo = new DodoService({
		sqlClient: null,
		client: {
			refunds: {
				create: async () => {
					state.calls += 1;
					return { refund_id: `rfnd_${state.calls}`, status: "succeeded" };
				},
			},
		} as unknown as DodoPayments,
		config: { ...serverConfig, billingProvider: "dodo" },
	});
	return { dodo, get calls() { return state.calls; } };
}

// Build an admin router whose authMiddleware injects the given platform role.
// Lets the per-role gating tests fire the same request as different roles
// without minting JWTs. Threads the real credit/refund deps so the inline money
// routes mint/move value (their delegation is exercised under each role's gate).
function adminRouterAs(
	role: UserRole,
	deps: {
		gdpr: MemoryGdprStore;
		billing: BillingStore;
		workspaceAccess?: WorkspaceAccessStore | null;
		cron?: AdminCronAdapter;
		creditService?: CreditService;
		dodoService?: DodoService;
		paymentTransactionsStore?: PaymentTransactionsStore;
	},
): Hono {
	const app = new Hono();
	app.route("/", createAdminRouter({
		gdpr: deps.gdpr,
		billing: deps.billing,
		workspaceAccess: deps.workspaceAccess ?? null,
		cron: deps.cron,
		creditService: deps.creditService ?? freshCreditService(),
		dodoService: deps.dodoService,
		paymentTransactionsStore: deps.paymentTransactionsStore,
		authMiddleware: stubAuth({ userId: `stub-${role}`, email: `${role}@example.com`, role }),
	}));
	return app;
}

// In-memory billing store fake for admin route coverage.
class FakeBillingStore implements BillingStore {
	private readonly assignments = new Map<string, WorkspaceBillingAssignment>();
	private readonly grants = new Map<string, WorkspaceAddonGrant[]>();
	/** Records every getWorkspaceAssignment call so a test can assert no N+1. */
	readonly getAssignmentCalls: string[] = [];

	seedAssignment(value: WorkspaceBillingAssignment) {
		this.assignments.set(value.workspaceId, value);
	}

	seedGrant(workspaceId: string, value: WorkspaceAddonGrant) {
		const list = this.grants.get(workspaceId) ?? [];
		list.push(value);
		this.grants.set(workspaceId, list);
	}

	async setWorkspacePlan(): Promise<WorkspaceBillingAssignment> {
		throw new Error("not used in test");
	}

	async getWorkspaceAssignment(workspaceId: string) {
		this.getAssignmentCalls.push(workspaceId);
		return this.assignments.get(workspaceId) ?? null;
	}

	async resolveWorkspacePlan(): Promise<ResolvedWorkspacePlan> {
		throw new Error("not used in test");
	}

	async listAssignments() {
		return [...this.assignments.values()];
	}

	// Mirrors FileBillingStore.listWorkspaceAccounts: filter + (updated_at DESC,
	// workspace_id ASC) keyset pagination, with name falling back to workspaceId
	// (the admin route enriches names from the access store for file-mode). This
	// lets the admin /workspaces tests exercise the real paginated route path.
	async listWorkspaceAccounts(options: ListWorkspaceAccountsOptions = {}): Promise<AdminWorkspaceAccountPage> {
		const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
		const search = options.search?.trim().toLowerCase();
		const plan = options.plan?.trim();
		const status = options.status?.trim();
		const cursor = options.cursor
			? (JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as [string, string])
			: null;
		const filtered = [...this.assignments.values()]
			.map((assignment) => ({
				workspaceId: assignment.workspaceId,
				name: assignment.workspaceId,
				planId: assignment.planId,
				status: assignment.status,
				billingEmail: assignment.billingEmail ?? null,
				createdAt: assignment.createdAt,
				updatedAt: assignment.updatedAt,
			}))
			.filter((row) => {
				if (search && !`${row.name} ${row.workspaceId} ${row.billingEmail ?? ""}`.toLowerCase().includes(search)) return false;
				if (plan && row.planId !== plan) return false;
				if (status && row.status !== status) return false;
				return true;
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.workspaceId.localeCompare(b.workspaceId));
		// Honest total over the full filtered set (before the cursor window).
		const total = filtered.length;
		const rows = filtered.filter((row) => {
			if (!cursor) return true;
			if (row.updatedAt < cursor[0]) return true;
			if (row.updatedAt > cursor[0]) return false;
			return row.workspaceId > cursor[1];
		});
		const page = rows.slice(0, limit);
		const last = page[page.length - 1];
		return {
			workspaces: page,
			nextCursor: rows.length > limit && last
				? Buffer.from(JSON.stringify([last.updatedAt, last.workspaceId]), "utf8").toString("base64url")
				: undefined,
			total,
		};
	}

	async listActiveGrants(workspaceId: string) {
		return this.grants.get(workspaceId) ?? [];
	}
}

class FakeWorkspaceAccessStore implements Partial<WorkspaceAccessStore> {
	private readonly workspaces = new Map<string, WorkspaceRecord>();
	/** Records every getWorkspace call so a test can assert there is no N+1. */
	readonly getWorkspaceCalls: string[] = [];

	seed(record: WorkspaceRecord) {
		this.workspaces.set(record.workspaceId, record);
	}

	async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
		this.getWorkspaceCalls.push(workspaceId);
		return this.workspaces.get(workspaceId) ?? null;
	}

	// Mirrors FileWorkspaceAccessStore.listAllWorkspacePage: search filter +
	// (updated_at DESC, workspace_id DESC) keyset pagination over the FULL registry
	// (no billing dependency), with an honest total over the filtered set. This is
	// the source the admin /workspaces list now drives from.
	async listAllWorkspacePage(options: AllWorkspacesListOptions = {}): Promise<AllWorkspacesPage> {
		const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
		const search = options.search?.trim().toLowerCase();
		const cursor = options.cursor
			? (JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as [string, string])
			: null;
		const filtered = [...this.workspaces.values()]
			.filter((workspace) => {
				if (!search) return true;
				return `${workspace.name} ${workspace.workspaceId}`.toLowerCase().includes(search);
			})
			.map((workspace) => ({ ...workspace }))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.workspaceId.localeCompare(a.workspaceId));
		const total = filtered.length;
		// Strictly after the cursor under (updated_at DESC, workspace_id DESC).
		const rows = filtered.filter((row) => {
			if (!cursor) return true;
			if (row.updatedAt < cursor[0]) return true;
			if (row.updatedAt > cursor[0]) return false;
			return row.workspaceId < cursor[1];
		});
		const page = rows.slice(0, limit);
		const last = page[page.length - 1];
		return {
			workspaces: page,
			nextCursor: rows.length > limit && last
				? Buffer.from(JSON.stringify([last.updatedAt, last.workspaceId]), "utf8").toString("base64url")
				: undefined,
			total,
		};
	}
}

// ── MemoryGdprStore ───────────────────────────────────────────────

describe("MemoryGdprStore — consent capture", () => {
	test("records categories + metadata, returns latest first when listing", async () => {
		const store = new MemoryGdprStore();
		const first = await store.recordConsent({
			userId: "user-1",
			consentType: "cookie",
			categories: { necessary: true, functional: true, analytics: false, marketing: false },
			policyVersion: "2026-06-01",
			ipAddress: "203.0.113.1",
			userAgent: "Mozilla/5.0",
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await store.recordConsent({
			userId: "user-1",
			consentType: "cookie",
			categories: { necessary: true, functional: true, analytics: true, marketing: false },
			policyVersion: "2026-07-01",
		});
		expect(first.userId).toBe("user-1");
		expect(first.policyVersion).toBe("2026-06-01");
		expect(first.ipAddress).toBe("203.0.113.1");
		const events = await store.listConsentEvents("user-1");
		expect(events[0].id).toBe(second.id);
		expect(events).toHaveLength(2);
	});

	test("anonymous consent (no userId) is allowed and filtered out of per-user listing", async () => {
		const store = new MemoryGdprStore();
		await store.recordConsent({
			consentType: "cookie",
			categories: { necessary: true, functional: false, analytics: false, marketing: false },
			policyVersion: "2026-06-01",
			deviceId: "device-1",
		});
		const events = await store.listConsentEvents("user-x");
		expect(events).toEqual([]);
	});
});

describe("MemoryGdprStore — export jobs", () => {
	test("createExportJob returns a queued job that can be listed and updated", async () => {
		const store = new MemoryGdprStore();
		const job = await store.createExportJob("user-1");
		expect(job.status).toBe("queued");
		const list = await store.listExportJobs("user-1");
		expect(list).toHaveLength(1);
		const updated = await store.updateExportJob(job.id, {
			status: "ready",
			zipUrl: "/api/account/export/x/download",
			bytes: 4096,
		});
		expect(updated?.status).toBe("ready");
		expect(updated?.bytes).toBe(4096);
	});

	test("updateExportJob on a missing id returns null without throwing", async () => {
		const store = new MemoryGdprStore();
		const updated = await store.updateExportJob("missing", { status: "ready" });
		expect(updated).toBeNull();
	});
});

describe("MemoryGdprStore — soft-delete + restore", () => {
	const grace = 1000 * 60 * 60 * 24 * 30; // 30 days

	test("soft-deleting redacts email, disables account, persists grace window", async () => {
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		const snapshot = await store.softDeleteUser(user.id, { gracePeriodMs: grace });
		expect(snapshot).not.toBeNull();
		expect(snapshot?.redactedEmail).toBe(`deleted+${user.id}@redacted.invalid`);
		expect(snapshot?.originalEmail).toBe(user.email);
		const after = await authUserStore.load(user.id);
		expect(after?.isActive).toBe(false);
		expect(after?.email).toBe(snapshot?.redactedEmail);
		const pending = await store.listPendingSoftDeletes();
		expect(pending.find((entry) => entry.userId === user.id)).toBeDefined();
		// Targeted lookup (what /restore now uses) returns the same record by PK, and null
		// for a non-pending id — so the public route never loads the whole soft-delete set.
		const one = await store.getPendingSoftDelete(user.id);
		expect(one?.userId).toBe(user.id);
		expect(one?.deleteGraceUntil).toBe(pending.find((e) => e.userId === user.id)?.deleteGraceUntil);
		expect(await store.getPendingSoftDelete("nonexistent-user")).toBeNull();
		await deleteUser(user.id);
	});

	test("restoreUser reactivates the account when the email is still available", async () => {
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		await store.softDeleteUser(user.id, { gracePeriodMs: grace });
		const ok = await store.restoreUser(user.id);
		expect(ok).toBe(true);
		const after = await authUserStore.load(user.id);
		expect(after?.isActive).toBe(true);
		expect(after?.email).toBe(user.email);
		await deleteUser(user.id);
	});

	// P1 (retention contract, defense in depth): restoreUser must REFUSE to
	// reactivate an account once its undo window has elapsed. Past grace the row
	// is a live purge candidate; reviving it would resurrect data we promised to
	// erase. The route gates on grace too, but the store must fail closed for any
	// caller that skips that check.
	test("restoreUser throws RestoreGraceExpiredError and does NOT reactivate after grace expiry", async () => {
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		// 1ms grace, then wait well past it so the window is definitively closed.
		await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect((await authUserStore.load(user.id))?.isActive).toBe(false);

		await expect(store.restoreUser(user.id)).rejects.toBeInstanceOf(RestoreGraceExpiredError);
		// Account stays inactive; the pending marker is left intact for the sweeper.
		expect((await authUserStore.load(user.id))?.isActive).toBe(false);
		const stillPending = await store.listPendingSoftDeletes();
		expect(stillPending.find((entry) => entry.userId === user.id)).toBeDefined();
		await deleteUser(user.id);
	});

	test("listExpiredSoftDeletes returns entries past the grace window", async () => {
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
		// Advance well past 1ms so the grace cutoff has definitely passed.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const future = new Date(Date.now() + 60_000);
		const expired = await store.listExpiredSoftDeletes(future);
		expect(expired.find((entry) => entry.userId === user.id)).toBeDefined();
		await deleteUser(user.id);
	});

	test("soft-delete on a missing user returns null", async () => {
		const store = createMemoryGdprStore();
		const result = await store.softDeleteUser("nope", { gracePeriodMs: grace });
		expect(result).toBeNull();
	});

	// SECURITY (P1): self-service soft-delete must honor the last-owner guard so a
	// solo owner cannot lock the whole platform out by deleting their own account.
	test("solo active owner self-delete is BLOCKED (LastPlatformOwnerError) and the row stays owner+active+original email", async () => {
		const store = createMemoryGdprStore();
		const owner = await createOwnerUser();
		try {
			await withSoleActiveOwner(owner.id, async () => {
				await expect(
					store.softDeleteUser(owner.id, { gracePeriodMs: grace }),
				).rejects.toBeInstanceOf(LastPlatformOwnerError);
				// Fail-closed: no scramble, no disable, no pending-deletion bookkeeping.
				const after = await authUserStore.load(owner.id);
				expect(after?.role).toBe("owner");
				expect(after?.isActive).toBe(true);
				expect(after?.email).toBe(owner.email);
				const pending = await store.listPendingSoftDeletes();
				expect(pending.find((entry) => entry.userId === owner.id)).toBeUndefined();
			});
		} finally {
			await deleteUser(owner.id);
		}
	});

	test("with two active owners, one owner self-delete SUCCEEDS and an active owner remains", async () => {
		const store = createMemoryGdprStore();
		const ownerA = await createOwnerUser("gdpr-owner-soft-a");
		const ownerB = await createOwnerUser("gdpr-owner-soft-b");
		try {
			const snapshot = await store.softDeleteUser(ownerA.id, { gracePeriodMs: grace });
			expect(snapshot).not.toBeNull();
			const afterA = await authUserStore.load(ownerA.id);
			expect(afterA?.isActive).toBe(false);
			expect(afterA?.email.startsWith("deleted+")).toBe(true);
			// The second owner is untouched and still an active owner.
			const afterB = await authUserStore.load(ownerB.id);
			expect(afterB?.role).toBe("owner");
			expect(afterB?.isActive).toBe(true);
		} finally {
			await deleteUser(ownerA.id);
			await deleteUser(ownerB.id);
		}
	});

	test("non-owner self-delete still SUCCEEDS (guard only blocks the last active owner)", async () => {
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		try {
			const snapshot = await store.softDeleteUser(user.id, { gracePeriodMs: grace });
			expect(snapshot).not.toBeNull();
			const after = await authUserStore.load(user.id);
			expect(after?.isActive).toBe(false);
			expect(after?.email.startsWith("deleted+")).toBe(true);
		} finally {
			await deleteUser(user.id);
		}
	});
});

describe("MemoryGdprStore — impersonation + admin audit", () => {
	test("startImpersonation creates an open event that endImpersonation closes", async () => {
		const store = new MemoryGdprStore();
		const started = await store.startImpersonation("admin-1", "target-1", "support ticket");
		expect(started.endedAt).toBeNull();
		const ended = await store.endImpersonation(started.id);
		expect(ended?.endedAt).not.toBeNull();
		expect((await store.listImpersonations({ adminUserId: "admin-1" }))[0].id).toBe(started.id);
	});

	test("admin audit listing is newest-first and filterable by action + target", async () => {
		const store = new MemoryGdprStore();
		const entry1 = await store.recordAdminAudit({ adminUserId: "admin-1", action: "admin.impersonation.start", targetKind: "user", targetId: "u1" });
		entry1.createdAt = new Date(Date.now() - 10000).toISOString();
		const entry2 = await store.recordAdminAudit({ adminUserId: "admin-2", action: "admin.workspace.refund_requested", targetKind: "workspace", targetId: "ws-1" });
		entry2.createdAt = new Date(Date.now()).toISOString();

		const all = await store.listAdminAudit();
		expect(all.total).toBe(2);
		const refunds = await store.listAdminAudit({ action: "admin.workspace.refund_requested" });
		expect(refunds.total).toBe(1);
		expect(refunds.entries[0].targetId).toBe("ws-1");

		const midTime = new Date(Date.now() - 5000).toISOString();
		const afterMid = await store.listAdminAudit({ fromDate: midTime });
		expect(afterMid.total).toBe(1);
		expect(afterMid.entries[0].targetId).toBe("ws-1");

		const beforeMid = await store.listAdminAudit({ toDate: midTime });
		expect(beforeMid.total).toBe(1);
		expect(beforeMid.entries[0].targetId).toBe("u1");
	});

	test("recordAdminAudit captures an explicitly-passed actorRole", async () => {
		const store = new MemoryGdprStore();
		const entry = await store.recordAdminAudit({ adminUserId: "admin-x", action: "audit.test", actorRole: "support" });
		expect(entry.actorRole).toBe("support");
		const listed = await store.listAdminAudit({ actorRole: "support" });
		expect(listed.total).toBe(1);
		expect(listed.entries[0].id).toBe(entry.id);
	});

	test("recordAdminAudit resolves actorRole from the real user when not passed", async () => {
		const store = new MemoryGdprStore();
		const admin = await createAdminUser();
		try {
			const entry = await store.recordAdminAudit({ adminUserId: admin.id, action: "audit.role_resolve" });
			expect(entry.actorRole).toBe("admin");
		} finally {
			await deleteUser(admin.id);
		}
	});

	test("recordAdminAudit records null actorRole for an unknown actor (audit row still written)", async () => {
		const store = new MemoryGdprStore();
		const entry = await store.recordAdminAudit({ adminUserId: "ghost-actor", action: "audit.ghost" });
		expect(entry.actorRole).toBeNull();
		// The audit row is still recorded — losing the role label must never drop the entry.
		expect((await store.listAdminAudit({ adminUserId: "ghost-actor" })).total).toBe(1);
	});
});

// ── Signed export URLs ────────────────────────────────────────────

describe("signed export URLs", () => {
	test("buildSignedExportUrl roundtrips through verifyExportSignature", () => {
		const { url, expiresAt } = buildSignedExportUrl("job-1");
		const params = new URLSearchParams(url.split("?")[1]);
		const signature = params.get("signature") ?? "";
		expect(verifyExportSignature("job-1", expiresAt, signature)).toBe(true);
	});

	test("tampered job id fails verification", () => {
		const { expiresAt } = buildSignedExportUrl("job-1");
		// Re-derive a signature for a different job, compare against the original
		// expiry — the HMAC scope binds both, so this must reject.
		const other = buildSignedExportUrl("job-2", { ttlMs: 0 });
		const params = new URLSearchParams(other.url.split("?")[1]);
		const signature = params.get("signature") ?? "";
		expect(verifyExportSignature("job-1", expiresAt, signature)).toBe(false);
	});
});

// ── /api/consent/events ───────────────────────────────────────────

describe("consent router", () => {
	test("accepts anonymous consent and sets a consent_v cookie", async () => {
		const store = new MemoryGdprStore();
		const router = createConsentRouter({ store });
		const app = new Hono();
		app.route("/", router);
		const res = await app.request("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				categories: { necessary: true, functional: true, analytics: false, marketing: false },
				policyVersion: "2026-06-01",
			}),
		});
		expect(res.status).toBe(200);
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("consent_v=");
		expect(setCookie).toContain("SameSite=Lax");
		const body = await res.json() as { ok: boolean; event: { id: string; userId: string | null } };
		expect(body.ok).toBe(true);
		expect(body.event.userId).toBeNull();
	});

	test("validates required policyVersion", async () => {
		const store = new MemoryGdprStore();
		const router = createConsentRouter({ store });
		const app = new Hono();
		app.route("/", router);
		const res = await app.request("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				categories: { necessary: true, functional: true, analytics: false, marketing: false },
			}),
		});
		expect(res.status).toBe(400);
	});

	test("authenticated POST tags the consent row with the userId", async () => {
		const store = new MemoryGdprStore();
		const router = createConsentRouter({ store });
		const app = new Hono();
		app.use("*", stubAuth({ userId: "u1", email: "u1@example.com", role: "editor" }));
		app.route("/", router);
		const res = await app.request("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				categories: { necessary: true, functional: false, analytics: false, marketing: false },
				policyVersion: "2026-06-01",
			}),
		});
		expect(res.status).toBe(200);
		const events = await store.listConsentEvents("u1");
		expect(events).toHaveLength(1);
		expect(events[0].categories.necessary).toBe(true);
	});
});

// ── /api/account ──────────────────────────────────────────────────

describe("account router", () => {
	test("requires auth", async () => {
		const router = createAccountRouter({ store: new MemoryGdprStore() });
		const app = new Hono();
		app.route("/", router);
		const res = await app.request("/export", { method: "POST" });
		expect(res.status).toBe(401);
	});

	test("POST /export queues a job and inline-processes it to ready", async () => {
		const store = new MemoryGdprStore();
		const notifications: Array<{ jobId: string; downloadUrl: string }> = [];
		const user = await createEditorUser();
		const router = createAccountRouter({
			store,
			notifyExportReady: (input) => { notifications.push({ jobId: input.jobId, downloadUrl: input.downloadUrl }); },
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const app = new Hono();
		app.route("/", router);

		const res = await app.request("/export", { method: "POST" });
		expect(res.status).toBe(202);
		const body = await res.json() as { job: { id: string } };
		// Background work resolves via microtask + the inline await chain — give
		// it a couple of ticks before we read the final state.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const finalJob = await store.getExportJob(body.job.id);
		expect(finalJob?.status).toBe("ready");
		expect(finalJob?.zipUrl).toContain("/api/account/export/");
		expect(notifications).toHaveLength(1);
		await deleteUser(user.id);
	});

	test("POST /export: a throwing failed-status write does NOT escape as an unhandled rejection", async () => {
		// Regression for the fire-and-forget crash class: the default processJob's
		// catch handler writes status:"failed". If THAT write also throws (the same
		// store outage that failed the export is still live), the rejection used to
		// escape the bare `void processJob(...)` with no catcher — which crashes the
		// process on Node >=15. The fix guards the failed-status write AND chains a
		// `.catch` on the call site. Here we force the FIRST updateExportJob (the
		// "processing" write) to throw so we enter the catch, then make the
		// "failed" write throw too — and assert: (a) no unhandled rejection, and
		// (b) the failure is logged rather than silently lost.
		const base = new MemoryGdprStore();
		// No real DB-backed user needed: stubAuth supplies the user payload and the
		// wrapped MemoryGdprStore handles createExportJob. Keeping this off createUser
		// makes the test robust to the no-infra full-suite run (where the file-backed
		// auth store's temp dir is torn down by other test files).
		const user = { id: "stub-export-user", email: "export@example.com" };
		const throwingStore = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
			// Throw on every export-job status write so both the "processing" write
			// and the catch-handler "failed" write fail.
			updateExportJob: async () => {
				throw new Error("store outage");
			},
		});

		// Capture any unhandled rejection that fires during this test window.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		process.on("unhandledRejection", onUnhandled);

		// Spy on console.error so we can assert the guarded failure was logged.
		const errorLogs: unknown[][] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => { errorLogs.push(args); };

		try {
			const router = createAccountRouter({
				store: throwingStore,
				authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
			});
			const app = new Hono();
			app.route("/", router);

			// The route itself only awaits createExportJob (which still works on the
			// wrapped store), so it returns 202 even though the background job fails.
			const res = await app.request("/export", { method: "POST" });
			expect(res.status).toBe(202);

			// Let the fire-and-forget background work settle. If the rejection
			// escaped, the unhandledRejection listener would record it on a later
			// microtask/tick — so wait a couple of ticks before asserting.
			await new Promise((resolve) => setTimeout(resolve, 30));

			expect(unhandled).toHaveLength(0);
			// The guarded catch logged the failed-status write failure.
			const loggedStuckWarning = errorLogs.some((args) =>
				typeof args[0] === "string" && args[0].includes("may be stuck in 'processing'"),
			);
			expect(loggedStuckWarning).toBe(true);
		} finally {
			console.error = originalError;
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("notifyExportReady wired to notify() delivers an in-app + email notice on ready", async () => {
		// Regression for the index.ts wiring bug: the account router was mounted via
		// the deps-less createAccountRouter() singleton, so notifyExportReady was
		// undefined and the export-ready guard never fired. This proves the index.ts
		// wiring shape — notifyExportReady -> notify({ type: "account_export_ready" })
		// — actually invokes notify() (which writes the in-app row + attempts email)
		// when the job reaches "ready".
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		const inApp: Array<{ type: string; userId: string; linkUrl?: string }> = [];
		const emails: Array<{ template: string; to: unknown }> = [];
		const router = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
			// Mirror the real index.ts wiring exactly, but inject notify()'s seams so
			// we observe the side effects without touching the real stores/mailer.
			notifyExportReady: async ({ userId, jobId, downloadUrl, expiresAt }) => {
				await notify(
					{
						userId,
						type: "account_export_ready",
						title: "Your data export is ready",
						body: "Your account data export has finished.",
						linkUrl: downloadUrl,
						metadata: { jobId, expiresAt },
					},
					{
						notificationStore: {
							create: async (input: any) => { inApp.push({ type: input.type, userId: input.userId, linkUrl: input.linkUrl }); return { id: "n1", ...input, readAt: null, createdAt: new Date().toISOString() }; },
						} as any,
						preferenceStore: { isEnabled: async () => true } as any,
						userStore: { load: async () => ({ email: user.email, name: "Export User" }) },
						sendEmail: (async (template: string, data: any) => { emails.push({ template, to: data?.user?.email }); return { success: true, provider: "null", status: "sent", retryable: false }; }) as any,
						publishRealtime: async () => undefined,
					},
				);
			},
		});
		const app = new Hono();
		app.route("/", router);

		const res = await app.request("/export", { method: "POST" });
		expect(res.status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(inApp).toHaveLength(1);
		expect(inApp[0]).toMatchObject({ type: "account_export_ready", userId: user.id });
		expect(inApp[0]?.linkUrl).toContain("/api/account/export/");
		expect(emails).toHaveLength(1);
		expect(emails[0]).toMatchObject({ template: "notification-generic", to: user.email });
		await deleteUser(user.id);
	});

	test("POST /export collapses concurrent requests into the existing inflight job", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		// Block the worker so the first job stays "queued" while we hit the route a second time.
		const blocker = { released: false } as { released: boolean };
		const router = createAccountRouter({
			store,
			processExportJob: async (jobId) => {
				await store.updateExportJob(jobId, { status: "processing" });
				while (!blocker.released) await new Promise((r) => setTimeout(r, 5));
				await store.updateExportJob(jobId, { status: "ready" });
			},
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const app = new Hono();
		app.route("/", router);

		const first = await app.request("/export", { method: "POST" });
		expect(first.status).toBe(202);
		const firstBody = await first.json() as { job: { id: string } };

		const second = await app.request("/export", { method: "POST" });
		expect(second.status).toBe(200);
		const secondBody = await second.json() as { job: { id: string }; message: string };
		expect(secondBody.job.id).toBe(firstBody.job.id);
		expect(secondBody.message).toContain("in progress");

		blocker.released = true;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await deleteUser(user.id);
	});

	test("GET /export/:jobId/download rejects without a valid signature", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		const job = await store.createExportJob(user.id);
		await store.updateExportJob(job.id, { status: "ready" });
		const router = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const app = new Hono();
		app.route("/", router);

		const res = await app.request(`/export/${job.id}/download`);
		expect(res.status).toBe(400);
		const tampered = await app.request(`/export/${job.id}/download?expires=${Date.now() + 60_000}&signature=deadbeef`);
		expect(tampered.status).toBe(403);
		await deleteUser(user.id);
	});

	test("GET /export/:jobId/download streams the JSON payload with a valid signature", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		const job = await store.createExportJob(user.id);
		await store.updateExportJob(job.id, { status: "ready" });
		const router = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const app = new Hono();
		app.route("/", router);

		const { url } = buildSignedExportUrl(job.id);
		// The signed URL is built for /api/account/export/...; the router is
		// mounted at "/" in tests, so strip the API prefix to address it.
		const localUrl = url.replace(/^\/api\/account/, "");
		const res = await app.request(localUrl);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain(`"userId": "${user.id}"`);
		await deleteUser(user.id);
	});

	test("DELETE / soft-deletes the user, revokes tokens, returns restore URL", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		const notifications: Array<{ restoreUrl: string }> = [];
		const router = createAccountRouter({
			store,
			notifyDeleteScheduled: (input) => { notifications.push({ restoreUrl: input.restoreUrl }); },
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const app = new Hono();
		app.route("/", router);

		const res = await app.request("/", { method: "DELETE" });
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: boolean; restoreUrl: string; deleteGraceUntil: string };
		expect(body.ok).toBe(true);
		expect(body.restoreUrl).toContain("token=");
		expect(notifications[0].restoreUrl).toContain("token=");
		const reloaded = await authUserStore.load(user.id);
		expect(reloaded?.isActive).toBe(false);
		expect(reloaded?.email.startsWith("deleted+")).toBe(true);
		await deleteUser(user.id);
	});

	test("DELETE / by the platform's last active owner returns 403 and leaves the account intact", async () => {
		const store = new MemoryGdprStore();
		const owner = await createOwnerUser("gdpr-owner-route");
		const notifications: Array<{ restoreUrl: string }> = [];
		const router = createAccountRouter({
			store,
			notifyDeleteScheduled: (input) => { notifications.push({ restoreUrl: input.restoreUrl }); },
			authMiddleware: stubAuth({ userId: owner.id, email: owner.email, role: "owner" }),
		});
		const app = new Hono();
		app.route("/", router);

		try {
			await withSoleActiveOwner(owner.id, async () => {
				const res = await app.request("/", { method: "DELETE" });
				expect(res.status).toBe(403);
				const body = await res.json() as { error: string; code: string };
				expect(body.code).toBe("last_platform_owner");
				// Fail-closed: account untouched, no deletion scheduled.
				const reloaded = await authUserStore.load(owner.id);
				expect(reloaded?.role).toBe("owner");
				expect(reloaded?.isActive).toBe(true);
				expect(reloaded?.email).toBe(owner.email);
				expect(notifications).toHaveLength(0);
			});
		} finally {
			await deleteUser(owner.id);
		}
	});

	test("POST /restore with a tampered token is rejected", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		const router = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const app = new Hono();
		app.route("/", router);

		await app.request("/", { method: "DELETE" });
		const res = await app.request(`/restore?user=${user.id}&token=deadbeef`, { method: "POST" });
		expect(res.status).toBe(403);
		await deleteUser(user.id);
	});

	test("POST /restore with the issued token re-enables the account", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		const router = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const app = new Hono();
		app.route("/", router);

		const deleteRes = await app.request("/", { method: "DELETE" });
		const deleteBody = await deleteRes.json() as { restoreUrl: string };
		const url = new URL(`http://test.local${deleteBody.restoreUrl}`);
		const target = url.searchParams.get("user");
		const token = url.searchParams.get("token");
		expect(target).toBe(user.id);
		expect(token).toBeTruthy();

		const restoreRes = await app.request(`/restore?user=${target}&token=${token}`, { method: "POST" });
		expect(restoreRes.status).toBe(200);
		const reloaded = await authUserStore.load(user.id);
		expect(reloaded?.isActive).toBe(true);
		await deleteUser(user.id);
	});

	// ── P1 (retention contract): /restore must enforce deleteGraceUntil ──
	// A pending soft-delete marker can linger past its grace window until the
	// sweeper purges it. Without an explicit grace gate the route would happily
	// reactivate the account in that window — restoring data we promised to erase.
	// We drive the clock via the injectable `now` dep so the assertion is exact.
	test("POST /restore returns 410 and does NOT reactivate after the grace window expires", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();

		// Soft-delete through the authed flow to mint a real HMAC restore token.
		const deleteRouter = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const deleteApp = new Hono();
		deleteApp.route("/", deleteRouter);
		const deleteRes = await deleteApp.request("/", { method: "DELETE" });
		const { restoreUrl, deleteGraceUntil } = await deleteRes.json() as { restoreUrl: string; deleteGraceUntil: string };
		const url = new URL(`http://test.local${restoreUrl}`);
		const target = url.searchParams.get("user");
		const token = url.searchParams.get("token");
		expect((await authUserStore.load(user.id))?.isActive).toBe(false);

		// Restore router whose clock is pinned PAST the grace window.
		const afterGrace = Date.parse(deleteGraceUntil) + 1;
		const expiredRouter = createAccountRouter({ store, now: () => afterGrace });
		const expiredApp = new Hono();
		expiredApp.route("/", expiredRouter);

		// Even WITH the valid HMAC token the expired window must be refused — and
		// the grace check fires BEFORE the token path, so this is a 410 not a 403.
		const expiredRes = await expiredApp.request(`/restore?user=${target}&token=${token}`, { method: "POST" });
		expect(expiredRes.status).toBe(410);
		const expiredBody = await expiredRes.json() as { code?: string };
		expect(expiredBody.code).toBe("grace_expired");
		// Account stays inactive — the expired restore must NOT reactivate it.
		expect((await authUserStore.load(user.id))?.isActive).toBe(false);

		// Sanity: the SAME token restores fine while the clock is still inside grace.
		const withinGrace = Date.parse(deleteGraceUntil) - 1;
		const liveRouter = createAccountRouter({ store, now: () => withinGrace });
		const liveApp = new Hono();
		liveApp.route("/", liveRouter);
		const liveRes = await liveApp.request(`/restore?user=${target}&token=${token}`, { method: "POST" });
		expect(liveRes.status).toBe(200);
		expect((await authUserStore.load(user.id))?.isActive).toBe(true);
		await deleteUser(user.id);
	});

	test("POST /restore from an email link works with NO auth header (real default auth middleware)", async () => {
		// Regression for the P1 bug: the per-router auth middleware only exempted
		// the signed download GET, so the restore email link — opened in a
		// logged-out browser, carrying its HMAC token in the query — was rejected
		// before the route could verify the token. The soft-deleted user is also
		// inactive, so the default middleware would reject even a stale session.
		const store = new MemoryGdprStore();
		const user = await createEditorUser();

		// Soft-delete through the authed flow to mint a real restore token.
		const deleteRouter = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const deleteApp = new Hono();
		deleteApp.route("/", deleteRouter);
		const deleteRes = await deleteApp.request("/", { method: "DELETE" });
		const { restoreUrl } = await deleteRes.json() as { restoreUrl: string };
		const url = new URL(`http://test.local${restoreUrl}`);
		const target = url.searchParams.get("user");
		const token = url.searchParams.get("token");

		// Restore through a router using the REAL default auth middleware and NO
		// Authorization header — exactly what the email link sends.
		const restoreRouter = createAccountRouter({ store });
		const restoreApp = new Hono();
		restoreApp.route("/", restoreRouter);
		const restoreRes = await restoreApp.request(`/restore?user=${target}&token=${token}`, { method: "POST" });
		expect(restoreRes.status).toBe(200);
		const reloaded = await authUserStore.load(user.id);
		expect(reloaded?.isActive).toBe(true);
		await deleteUser(user.id);
	});

	// ── P1 #1: self-service restore from the in-app (session) path, NO email token ──
	// Regression: a just-soft-deleted user is isActive=false with revoked sessions and
	// a bumped token watermark, so optionalAuth/authMiddleware will NOT attach them.
	// The restore route must still authenticate them from their access-token SIGNATURE
	// to undo their OWN deletion without the emailed HMAC token.
	test("POST /restore authenticates the soft-deleted caller from their own access token (no email token)", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();

		// Soft-delete through the authed flow.
		const deleteRouter = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const deleteApp = new Hono();
		deleteApp.route("/", deleteRouter);
		await deleteApp.request("/", { method: "DELETE" });
		expect((await authUserStore.load(user.id))?.isActive).toBe(false);

		// Mint the access token the way the real server does, AFTER the watermark bump,
		// so it is a token the soft-deleted user is legitimately holding.
		const accessToken = generateAccessToken({ id: user.id, email: user.email, role: "editor" });

		// Restore through the REAL default auth middleware with the user's Bearer token
		// and NO ?token= query — exactly an in-app "undo" click.
		const restoreRouter = createAccountRouter({ store });
		const restoreApp = new Hono();
		restoreApp.route("/", restoreRouter);
		const res = await restoreApp.request("/restore", {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		expect(res.status).toBe(200);
		expect((await authUserStore.load(user.id))?.isActive).toBe(true);
		await deleteUser(user.id);
	});

	test("POST /restore with another user's access token cannot restore a different account", async () => {
		const store = new MemoryGdprStore();
		const victim = await createEditorUser();
		const attacker = await createEditorUser();

		// Soft-delete the victim.
		const deleteRouter = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: victim.id, email: victim.email, role: "editor" }),
		});
		const deleteApp = new Hono();
		deleteApp.route("/", deleteRouter);
		await deleteApp.request("/", { method: "DELETE" });

		// Attacker presents THEIR valid token but targets the victim's id → rejected.
		const attackerToken = generateAccessToken({ id: attacker.id, email: attacker.email, role: "editor" });
		const restoreRouter = createAccountRouter({ store });
		const restoreApp = new Hono();
		restoreApp.route("/", restoreRouter);
		const res = await restoreApp.request(`/restore?user=${victim.id}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${attackerToken}` },
		});
		expect(res.status).toBe(401);
		expect((await authUserStore.load(victim.id))?.isActive).toBe(false);
		await deleteUser(victim.id);
		await deleteUser(attacker.id);
	});

	// ── P1 #2 (security): soft-delete must cut LIVE access tokens, not just refresh ──
	// A token minted BEFORE soft-delete must be rejected on a normal protected route
	// after the DELETE bumps the watermark + flips isActive=false — while the SAME
	// token is still accepted by the narrow /restore path (#1 ↔ #2 coordination).
	test("soft-delete revokes a live access token for normal API but the restore path still accepts it", async () => {
		const store = new MemoryGdprStore();
		const user = await createEditorUser();

		// A live access token the user already holds (minted before deletion).
		const liveToken = generateAccessToken({ id: user.id, email: user.email, role: "editor" });

		// Sanity: before deletion the token authenticates on a normal protected route.
		const protectedApp = new Hono();
		protectedApp.use("*", authMiddleware);
		protectedApp.get("/whoami", (c) => c.json({ ok: true }));
		const before = await protectedApp.request("/whoami", { headers: { Authorization: `Bearer ${liveToken}` } });
		expect(before.status).toBe(200);

		// Soft-delete (revokes sessions + bumps tokensValidFromMs + isActive=false).
		const deleteRouter = createAccountRouter({
			store,
			authMiddleware: stubAuth({ userId: user.id, email: user.email, role: "editor" }),
		});
		const deleteApp = new Hono();
		deleteApp.route("/", deleteRouter);
		await deleteApp.request("/", { method: "DELETE" });
		expect((await loadUser(user.id))?.tokensValidFromMs).toBeGreaterThan(0);

		// The SAME live token is now rejected on a normal protected route.
		const after = await protectedApp.request("/whoami", { headers: { Authorization: `Bearer ${liveToken}` } });
		expect(after.status).toBe(401);

		// …yet the restore path still authenticates it (so "undo my deletion" works).
		const restoreRouter = createAccountRouter({ store });
		const restoreApp = new Hono();
		restoreApp.route("/", restoreRouter);
		const restore = await restoreApp.request("/restore", {
			method: "POST",
			headers: { Authorization: `Bearer ${liveToken}` },
		});
		expect(restore.status).toBe(200);
		expect((await authUserStore.load(user.id))?.isActive).toBe(true);
		await deleteUser(user.id);
	});
});

// ── /api/admin ────────────────────────────────────────────────────

describe("admin router — auth gate", () => {
	test("requires a JWT (no Authorization header → 401)", async () => {
		const router = createAdminRouter({ gdpr: new MemoryGdprStore(), billing: new FakeBillingStore(), workspaceAccess: null });
		const app = new Hono();
		app.route("/", router);
		const res = await app.request("/workspaces");
		expect(res.status).toBe(401);
	});
});

describe("admin router — workspaces + audit", () => {
	let store: MemoryGdprStore;
	let billing: FakeBillingStore;
	let access: FakeWorkspaceAccessStore;
	let app: Hono;
	let admin: Awaited<ReturnType<typeof createAdminUser>>;
	let editor: Awaited<ReturnType<typeof createEditorUser>>;
	let creditService: CreditService;
	let paymentTransactionsStore: FilePaymentTransactionsStore;
	let dodoSpy: { dodo: DodoService; readonly calls: number };

	beforeEach(async () => {
		store = new MemoryGdprStore();
		billing = new FakeBillingStore();
		access = new FakeWorkspaceAccessStore();
		admin = await createAdminUser();
		editor = await createEditorUser();
		creditService = freshCreditService();
		paymentTransactionsStore = new FilePaymentTransactionsStore();
		dodoSpy = spyDodo();

		billing.seedAssignment({
			workspaceId: "ws-1",
			planId: "pro",
			status: "active",
			billingEmail: "owner@example.com",
			createdAt: "2026-05-01T00:00:00.000Z",
			updatedAt: "2026-05-02T00:00:00.000Z",
		});
		access.seed({
			workspaceId: "ws-1",
			name: "Studio Alpha",
			planId: "pro",
			storageIncludedBytes: 0,
			storageExtraBytes: 0,
			createdAt: "2026-04-01T00:00:00.000Z",
			updatedAt: "2026-04-02T00:00:00.000Z",
		} satisfies WorkspaceRecord);

		const router = createAdminRouter({
			gdpr: store,
			billing,
			workspaceAccess: access as unknown as WorkspaceAccessStore,
			creditService,
			dodoService: dodoSpy.dodo,
			paymentTransactionsStore,
			authMiddleware: stubAuth({ userId: admin.id, email: admin.email, role: "admin" }),
		});
		app = new Hono();
		app.route("/", router);
	});

	test("non-admin role is rejected with 403", async () => {
		const editorApp = new Hono();
		editorApp.route("/", createAdminRouter({
			gdpr: store,
			billing,
			workspaceAccess: access as unknown as WorkspaceAccessStore,
			authMiddleware: stubAuth({ userId: editor.id, email: editor.email, role: "editor" }),
		}));
		const res = await editorApp.request("/workspaces");
		expect(res.status).toBe(403);
	});

	test("GET /workspaces sources from the registry and enriches with billing", async () => {
		const res = await app.request("/workspaces");
		expect(res.status).toBe(200);
		const body = await res.json() as { workspaces: Array<{ workspaceId: string; name: string; planId: string; status: string; billingEmail: string | null }>; total: number };
		expect(body.total).toBe(1);
		expect(body.workspaces[0]).toMatchObject({
			workspaceId: "ws-1",
			name: "Studio Alpha",
			// plan/status come from the billing assignment enrichment.
			planId: "pro",
			status: "active",
			billingEmail: "owner@example.com",
		});
	});

	test("GET /workspaces lists a registry workspace with NO billing assignment (the file-mode bug)", async () => {
		// A real workspace exists in the registry but billing has no assignment for
		// it — exactly the file-mode/self-host case that used to show 0 rows because
		// the list was sourced from the (empty) billing store.
		access.seed({
			workspaceId: "ws-nobilling",
			name: "Self-host Studio",
			planId: "creator",
			storageIncludedBytes: 0,
			storageExtraBytes: 0,
			createdAt: "2026-05-10T00:00:00.000Z",
			updatedAt: "2026-05-11T00:00:00.000Z",
		} satisfies WorkspaceRecord);

		const res = await app.request("/workspaces");
		expect(res.status).toBe(200);
		const body = await res.json() as { workspaces: Array<{ workspaceId: string; name: string; planId: string; status: string; billingEmail: string | null }>; total: number };
		expect(body.total).toBe(2);
		const row = body.workspaces.find((w) => w.workspaceId === "ws-nobilling");
		expect(row).toBeDefined();
		// Shown with a sensible default plan (the registry plan) + "unassigned"
		// status rather than being hidden by the missing billing assignment.
		expect(row).toMatchObject({ name: "Self-host Studio", planId: "creator", status: "unassigned", billingEmail: null });
	});

	test("GET /workspaces honours plan/status filters over the enriched page", async () => {
		access.seed({
			workspaceId: "ws-2",
			name: "Beta Workspace",
			planId: "free",
			storageIncludedBytes: 0,
			storageExtraBytes: 0,
			createdAt: "2026-05-01T00:00:00.000Z",
			updatedAt: "2026-05-03T00:00:00.000Z",
		} satisfies WorkspaceRecord);
		billing.seedAssignment({
			workspaceId: "ws-2",
			planId: "free",
			status: "trialing",
			createdAt: "2026-05-01T00:00:00.000Z",
			updatedAt: "2026-05-02T00:00:00.000Z",
		});
		const res = await app.request("/workspaces?plan=free");
		const body = await res.json() as { workspaces: Array<{ workspaceId: string }> };
		expect(body.workspaces).toHaveLength(1);
		expect(body.workspaces[0].workspaceId).toBe("ws-2");
	});

	test("GET /workspaces paginates via limit + nextCursor and never N+1s billing", async () => {
		// Three workspaces total (ws-1 seeded in beforeEach + two more), newest first.
		access.seed({ workspaceId: "ws-2", name: "Beta", planId: "free", storageIncludedBytes: 0, storageExtraBytes: 0, createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-03T00:00:00.000Z" } satisfies WorkspaceRecord);
		access.seed({ workspaceId: "ws-3", name: "Gamma", planId: "pro", storageIncludedBytes: 0, storageExtraBytes: 0, createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-04T00:00:00.000Z" } satisfies WorkspaceRecord);

		const first = await app.request("/workspaces?limit=2");
		const firstBody = await first.json() as { workspaces: Array<{ workspaceId: string }>; total: number; nextCursor: string | null };
		expect(firstBody.workspaces.map((w) => w.workspaceId)).toEqual(["ws-3", "ws-2"]);
		// Honest total is the FULL count (3), not the page length (2), so the header
		// is accurate while paging walks the remaining rows via nextCursor.
		expect(firstBody.total).toBe(3);
		expect(firstBody.nextCursor).toBeTruthy();

		const second = await app.request(`/workspaces?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`);
		const secondBody = await second.json() as { workspaces: Array<{ workspaceId: string }>; total: number; nextCursor: string | null };
		expect(secondBody.workspaces.map((w) => w.workspaceId)).toEqual(["ws-1"]);
		expect(secondBody.nextCursor).toBeNull();
		// Total stays stable across pages — it never collapses to the page length.
		expect(secondBody.total).toBe(3);

		// Billing enrichment is bounded: getWorkspaceAssignment is called at most
		// once per RETURNED row (≤ limit per page), NEVER N×total over the registry.
		// Two pages of ≤2 rows each → at most 3 lookups, not a scan.
		expect(billing.getAssignmentCalls.length).toBeLessThanOrEqual(3);
	});

	test("GET /workspaces clamps an out-of-range limit instead of unbounding the scan", async () => {
		const res = await app.request("/workspaces?limit=99999");
		// 99999 exceeds the schema max (200) → validation rejects rather than
		// silently running an unbounded query.
		expect(res.status).toBe(400);
	});

	test("GET /workspaces/:id returns workspace+billing+grants", async () => {
		billing.seedGrant("ws-1", {
			grantId: "grant-1",
			workspaceId: "ws-1",
			addonId: "ai-1000",
			quantity: 1,
			aiCredits: 1000,
			storageBytes: 0,
			seats: 0,
			teamJobs: 0,
			status: "active",
			source: "goodwill",
			createdAt: "2026-05-01T00:00:00.000Z",
			updatedAt: "2026-05-01T00:00:00.000Z",
		});
		const res = await app.request("/workspaces/ws-1");
		expect(res.status).toBe(200);
		const body = await res.json() as { workspace: { name: string }; billing: { planId: string }; grants: Array<{ grantId: string }> };
		expect(body.workspace.name).toBe("Studio Alpha");
		expect(body.billing.planId).toBe("pro");
		expect(body.grants[0].grantId).toBe("grant-1");
	});

	test("POST /workspaces/:id/credits MINTS real credits + writes audit", async () => {
		const before = creditService.getBalance("workspace", "ws-1");
		const res = await app.request("/workspaces/ws-1/credits", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 500, reason: "goodwill for downtime", idempotencyKey: "grant-k1" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: boolean; grant: { amount: number } };
		expect(body.grant.amount).toBe(500);
		// REAL ledger change: the balance actually moved.
		const after = creditService.getBalance("workspace", "ws-1");
		expect(after.shareable - before.shareable).toBe(500);
		const audit = await store.listAdminAudit({ action: "admin.workspace.credit_grant" });
		expect(audit.total).toBe(1);
		expect(audit.entries[0].detail).toMatchObject({ amount: 500 });
		expect(audit.entries[0].actorRole).toBe("admin");
	});

	test("POST /workspaces/:id/credits is idempotent: a retried key does NOT double-mint", async () => {
		const payload = JSON.stringify({ amount: 200, reason: "retry-safe", idempotencyKey: "grant-dup" });
		const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: payload } as const;
		const first = await app.request("/workspaces/ws-1/credits", opts);
		const second = await app.request("/workspaces/ws-1/credits", opts);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		// One mint total, not two — the dedupe key converged the retry.
		expect(creditService.getBalance("workspace", "ws-1").shareable).toBe(200);
	});

	test("POST /workspaces/:id/credits rejects a zero/negative amount", async () => {
		const res = await app.request("/workspaces/ws-1/credits", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 0, reason: "no-op", idempotencyKey: "k0" }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /workspaces/:id/refund executes a REAL refund (negative payment row + provider) + audit", async () => {
		// Seed the original charge so the money-out validates against a real payment.
		await paymentTransactionsStore.upsertTransaction({
			workspaceId: "ws-1", kind: "payment", amountCents: 5000, currency: "USD", status: "succeeded", dodoPaymentId: "ch_1", dodoEventRef: "pay-1",
		});
		const res = await app.request("/workspaces/ws-1/refund", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 1500, currency: "USD", reason: "chargeback", dodoChargeId: "ch_1", idempotencyKey: "refund-k1" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { refund: { amountCents: number; currency: string } };
		// Negative row recorded (money nets out) + provider hit once.
		expect(body.refund.amountCents).toBe(-1500);
		expect(dodoSpy.calls).toBe(1);
		const audit = await store.listAdminAudit({ action: "admin.workspace.refund" });
		expect(audit.total).toBe(1);
		expect(audit.entries[0].detail).toMatchObject({ amountCents: -1500, currency: "USD" });
	});

	test("POST /workspaces/:id/refund is idempotent: a retried key does NOT double-refund", async () => {
		await paymentTransactionsStore.upsertTransaction({
			workspaceId: "ws-1", kind: "payment", amountCents: 5000, currency: "USD", status: "succeeded", dodoPaymentId: "ch_2", dodoEventRef: "pay-2",
		});
		const payload = JSON.stringify({ amountMinor: 1000, currency: "USD", reason: "dup", dodoChargeId: "ch_2", idempotencyKey: "refund-dup" });
		const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: payload } as const;
		await app.request("/workspaces/ws-1/refund", opts);
		const second = await app.request("/workspaces/ws-1/refund", opts);
		expect(second.status).toBe(200);
		// Provider called AT MOST once across the retry.
		expect(dodoSpy.calls).toBe(1);
	});

	test("POST /workspaces/:id/impersonate writes both an impersonation event and an admin_audit row", async () => {
		const res = await app.request("/workspaces/ws-1/impersonate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: editor.id, reason: "Debugging payment failure" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { event: { id: string; impersonatedUserId: string } };
		expect(body.event.impersonatedUserId).toBe(editor.id);

		const events = await store.listImpersonations({ targetUserId: editor.id });
		expect(events).toHaveLength(1);
		const audit = await store.listAdminAudit({ action: "admin.impersonation.start" });
		expect(audit.total).toBe(1);
		expect(audit.entries[0].targetId).toBe(editor.id);
	});

	test("POST /impersonate/stop closes the event and audits the stop", async () => {
		const startRes = await app.request("/workspaces/ws-1/impersonate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: editor.id, reason: "test" }),
		});
		const startBody = await startRes.json() as { event: { id: string } };
		const stopRes = await app.request("/impersonate/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ impersonationId: startBody.event.id }),
		});
		expect(stopRes.status).toBe(200);
		const list = await store.listImpersonations({ targetUserId: editor.id });
		expect(list[0].endedAt).not.toBeNull();
		expect((await store.listAdminAudit({ action: "admin.impersonation.end" })).total).toBe(1);
	});

	test("admins cannot force-delete their own account", async () => {
		const res = await app.request(`/users-mgmt/${admin.id}`, { method: "DELETE" });
		expect(res.status).toBe(400);
	});

	test("force-delete another user removes them and writes audit", async () => {
		const res = await app.request(`/users-mgmt/${editor.id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		const reloaded = await authUserStore.load(editor.id);
		expect(reloaded).toBeNull();
		expect((await store.listAdminAudit({ action: "admin.user.force_delete" })).total).toBe(1);
	});

	test("owner-target policy: a NON-OWNER admin force-deleting an OWNER is rejected with 403", async () => {
		// Two active owners exist, so this is NOT a last-owner case — the 403 is
		// purely the owner-target policy (only an owner may delete another owner).
		const { user: ownerA } = await createUser({
			email: makeUniqueEmail("gdpr-owner-a"),
			password: "OwnerP@ss123",
			name: "Owner A",
			role: "owner",
		});
		const { user: ownerB } = await createUser({
			email: makeUniqueEmail("gdpr-owner-b"),
			password: "OwnerP@ss123",
			name: "Owner B",
			role: "owner",
		});
		try {
			// `app` is wired with an ADMIN actor (role: "admin") in beforeEach.
			const res = await app.request(`/users-mgmt/${ownerA.id}`, { method: "DELETE" });
			expect(res.status).toBe(403);
			const body = await res.json() as { reason?: string };
			expect(body.reason).toBe("admin_self_protection");
			// Target owner untouched, no destructive audit written.
			expect(await authUserStore.load(ownerA.id)).not.toBeNull();
			expect((await store.listAdminAudit({ action: "admin.user.force_delete" })).total).toBe(0);
		} finally {
			await deleteUser(ownerA.id);
			await deleteUser(ownerB.id);
		}
	});

	test("owner-target policy: an OWNER actor MAY force-delete another owner (with a second owner present)", async () => {
		const { user: ownerA } = await createUser({
			email: makeUniqueEmail("gdpr-owner-c"),
			password: "OwnerP@ss123",
			name: "Owner C",
			role: "owner",
		});
		const { user: ownerB } = await createUser({
			email: makeUniqueEmail("gdpr-owner-d"),
			password: "OwnerP@ss123",
			name: "Owner D",
			role: "owner",
		});
		// Router wired with an OWNER actor.
		const ownerApp = new Hono();
		ownerApp.route("/", createAdminRouter({
			gdpr: store,
			billing,
			workspaceAccess: access as unknown as WorkspaceAccessStore,
			authMiddleware: stubAuth({ userId: ownerB.id, email: ownerB.email, role: "owner" }),
		}));
		try {
			const res = await ownerApp.request(`/users-mgmt/${ownerA.id}`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await authUserStore.load(ownerA.id)).toBeNull();
		} finally {
			await deleteUser(ownerA.id);
			await deleteUser(ownerB.id);
		}
	});

	test("owner-target policy: a NON-OWNER admin force-logging-out an OWNER is rejected with 403", async () => {
		const { user: owner } = await createUser({
			email: makeUniqueEmail("gdpr-owner-force-logout"),
			password: "OwnerP@ss123",
			name: "Owner Force Logout",
			role: "owner",
		});
		try {
			const res = await app.request(`/users-mgmt/${owner.id}/force-logout`, { method: "POST" });
			expect(res.status).toBe(403);
			const body = await res.json() as { reason?: string };
			expect(body.reason).toBe("admin_self_protection");
			expect(await authUserStore.load(owner.id)).not.toBeNull();
			expect((await store.listAdminAudit({ action: "admin.user.force_logout" })).total).toBe(0);
		} finally {
			await deleteUser(owner.id);
		}
	});

	test("force-logout writes an audit entry without deleting the user", async () => {
		const res = await app.request(`/users-mgmt/${editor.id}/force-logout`, { method: "POST" });
		expect(res.status).toBe(200);
		const reloaded = await authUserStore.load(editor.id);
		expect(reloaded).not.toBeNull();
		expect((await store.listAdminAudit({ action: "admin.user.force_logout" })).total).toBe(1);
		await deleteUser(editor.id);
	});

	test("GET /audit.csv returns CSV with header + one row per audit entry", async () => {
		await app.request("/workspaces/ws-1/credits", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 10, reason: "csv coverage", idempotencyKey: "csv-k1" }),
		});
		const res = await app.request("/audit.csv");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/csv");
		const csv = await res.text();
		const lines = csv.split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines[0]).toContain("createdAt");
	});

	test("GET /cron returns the stub adapter list when no override is supplied", async () => {
		const res = await app.request("/cron");
		expect(res.status).toBe(200);
		const body = await res.json() as { jobs: Array<{ id: string }> };
		expect(body.jobs.length).toBeGreaterThan(0);
	});

	test("POST /cron/:id/trigger calls the adapter and audits the call", async () => {
		const calls: string[] = [];
		const cronAdapter: AdminCronAdapter = {
			async list() { return [{ id: "x", name: "X", schedule: "*/1 * * * *", lastRunAt: null, lastRunStatus: null, nextRunAt: null }]; },
			async trigger(jobId) { calls.push(jobId); return { ok: true, message: "ok" }; },
		};
		const customApp = new Hono();
		customApp.route("/", createAdminRouter({
			gdpr: store,
			billing,
			workspaceAccess: access as unknown as WorkspaceAccessStore,
			cron: cronAdapter,
			authMiddleware: stubAuth({ userId: admin.id, email: admin.email, role: "admin" }),
		}));
		const res = await customApp.request("/cron/x/trigger", { method: "POST" });
		expect(res.status).toBe(200);
		expect(calls).toEqual(["x"]);
		expect((await store.listAdminAudit({ action: "admin.cron.trigger" })).total).toBe(1);
	});

	test("GET /audit supports paging via limit + offset", async () => {
		for (let i = 0; i < 5; i++) {
			await store.recordAdminAudit({ adminUserId: admin.id, action: "audit.test", targetKind: "test", targetId: String(i) });
		}
		const first = await app.request("/audit?limit=2");
		const firstBody = await first.json() as { entries: Array<{ targetId: string }>; total: number };
		expect(firstBody.total).toBe(5);
		expect(firstBody.entries).toHaveLength(2);
		const second = await app.request("/audit?limit=2&offset=2");
		const secondBody = await second.json() as { entries: Array<{ targetId: string }> };
		expect(secondBody.entries).toHaveLength(2);
		expect(secondBody.entries[0].targetId).not.toBe(firstBody.entries[0].targetId);
	});

	// ── Date-filter validation (regression: malformed bounds must 400, not 500) ──
	// fromDate/toDate are bound into `created_at >= $n` on a timestamptz column, so
	// an unvalidated value would reach the DB cast and 500. The route validates
	// strict UTC ISO datetimes and rejects bad/inverted bounds with 400 BEFORE the
	// store is touched.
	test("GET /audit rejects a malformed fromDate with 400 (does not 500)", async () => {
		for (const bad of ["not-a-date", "2026-99-99", "2026-06-03", "2026-06-03T00:00:00+07:00"]) {
			const res = await app.request(`/audit?fromDate=${encodeURIComponent(bad)}`);
			expect(res.status).toBe(400);
			const body = await res.json() as { error: string };
			expect(body.error).toBe("Validation failed");
		}
	});

	test("GET /audit rejects a malformed toDate with 400", async () => {
		const res = await app.request(`/audit?toDate=${encodeURIComponent("garbage")}`);
		expect(res.status).toBe(400);
	});

	test("GET /audit rejects an inverted range (from after to) with 400", async () => {
		const from = encodeURIComponent("2026-06-03T00:00:00.000Z");
		const to = encodeURIComponent("2026-06-02T00:00:00.000Z");
		const res = await app.request(`/audit?fromDate=${from}&toDate=${to}`);
		expect(res.status).toBe(400);
	});

	test("GET /audit accepts a valid ISO range and filters correctly", async () => {
		const old = await store.recordAdminAudit({ adminUserId: admin.id, action: "audit.range", targetKind: "test", targetId: "old" });
		old.createdAt = "2026-06-01T12:00:00.000Z";
		const recent = await store.recordAdminAudit({ adminUserId: admin.id, action: "audit.range", targetKind: "test", targetId: "recent" });
		recent.createdAt = "2026-06-03T12:00:00.000Z";

		// Window that includes only the recent row.
		const from = encodeURIComponent("2026-06-02T00:00:00.000Z");
		const to = encodeURIComponent("2026-06-03T23:59:59.999Z");
		const res = await app.request(`/audit?fromDate=${from}&toDate=${to}&action=audit.range`);
		expect(res.status).toBe(200);
		const body = await res.json() as { entries: Array<{ targetId: string }>; total: number };
		expect(body.total).toBe(1);
		expect(body.entries[0].targetId).toBe("recent");
	});

	test("GET /audit.csv applies the same date validation (malformed/inverted → 400)", async () => {
		expect((await app.request(`/audit.csv?fromDate=${encodeURIComponent("not-a-date")}`)).status).toBe(400);
		const from = encodeURIComponent("2026-06-03T00:00:00.000Z");
		const to = encodeURIComponent("2026-06-02T00:00:00.000Z");
		expect((await app.request(`/audit.csv?fromDate=${from}&toDate=${to}`)).status).toBe(400);
		// A valid bound still succeeds.
		expect((await app.request(`/audit.csv?fromDate=${from}`)).status).toBe(200);
	});
});

// ── Per-role back-office gating (security-critical) ────────────────
// The backend is authoritative: each platform role must be allowed exactly the
// routes its permission set covers and 403 on everything else. These fire the
// same requests as different roles via the stub auth middleware.
describe("admin router — per-role permission gating", () => {
	let store: MemoryGdprStore;
	let billing: FakeBillingStore;
	let creditService: CreditService;
	let paymentTransactionsStore: FilePaymentTransactionsStore;
	let dodoSpy: { dodo: DodoService; readonly calls: number };

	beforeEach(async () => {
		store = new MemoryGdprStore();
		billing = new FakeBillingStore();
		creditService = freshCreditService();
		paymentTransactionsStore = new FilePaymentTransactionsStore();
		dodoSpy = spyDodo();
		billing.seedAssignment({
			workspaceId: "ws-1",
			planId: "pro",
			status: "active",
			billingEmail: "owner@example.com",
			createdAt: "2026-05-01T00:00:00.000Z",
			updatedAt: "2026-05-02T00:00:00.000Z",
		});
		// Seed an original charge so the ALLOWED refund probes (admin/owner) pass the
		// money-out validation and reach 200 — these are RBAC tests, so we want the
		// gate, not a validation 400, to decide the outcome. Each allowed refund probe
		// uses a distinct idempotency key + a distinct charge to avoid cross-test dedupe.
		for (const charge of ["ch_rbac_admin", "ch_rbac_owner"]) {
			await paymentTransactionsStore.upsertTransaction({
				workspaceId: "ws-1", kind: "payment", amountCents: 5000, currency: "USD", status: "succeeded", dodoPaymentId: charge, dodoEventRef: `pay-${charge}`,
			});
		}
	});

	function as(role: UserRole) {
		return adminRouterAs(role, { gdpr: store, billing, creditService, dodoService: dodoSpy.dodo, paymentTransactionsStore });
	}

	test("editor/viewer are denied admin:access entirely (403 even on the list)", async () => {
		for (const role of ["editor", "viewer"] as const) {
			const res = await as(role).request("/workspaces");
			expect(res.status).toBe(403);
		}
	});

	test("support: allowed support adjust + users list, but 403 on refund / impersonate / role write", async () => {
		const app = as("support");
		// allowed: grant credits (support.adjust) — REAL mint
		const credits = await app.request("/workspaces/ws-1/credits", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 5, reason: "support grant", idempotencyKey: "rbac-support-grant" }),
		});
		expect(credits.status).toBe(200);
		// allowed: users list (users.read) — the single real users surface
		expect((await app.request("/users-mgmt")).status).toBe(200);
		// allowed: content/audit reads via access
		expect((await app.request("/audit")).status).toBe(200);

		// DENIED: refund (refund.write)
		const refund = await app.request("/workspaces/ws-1/refund", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "x", dodoChargeId: "ch_x", idempotencyKey: "k" }),
		});
		expect(refund.status).toBe(403);
		// DENIED: impersonate
		const imp = await app.request("/workspaces/ws-1/impersonate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "someone", reason: "x" }),
		});
		expect(imp.status).toBe(403);
		// DENIED: force-delete (users.write)
		expect((await app.request("/users-mgmt/abc", { method: "DELETE" })).status).toBe(403);
		// DENIED: cron (cron.write)
		expect((await app.request("/cron")).status).toBe(403);
	});

	test("accountant: 403 on everything except revenue/audit reads (audit allowed, mutations denied)", async () => {
		const app = as("accountant");
		// allowed: audit read
		expect((await app.request("/audit")).status).toBe(200);
		// DENIED: support adjust (grant credits)
		const credits = await app.request("/workspaces/ws-1/credits", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 5, reason: "x", idempotencyKey: "rbac-acct" }),
		});
		expect(credits.status).toBe(403);
		// DENIED: refund
		const refund = await app.request("/workspaces/ws-1/refund", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "x", dodoChargeId: "ch_x", idempotencyKey: "k" }),
		});
		expect(refund.status).toBe(403);
		// DENIED: users list (no users.read)
		expect((await app.request("/users-mgmt")).status).toBe(403);
		// DENIED: cron
		expect((await app.request("/cron")).status).toBe(403);
	});

	test("admin can refund + impersonate + force-delete + cron (full back-office minus roles.write)", async () => {
		const app = as("admin");
		const refund = await app.request("/workspaces/ws-1/refund", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "ok", dodoChargeId: "ch_rbac_admin", idempotencyKey: "rbac-admin-refund" }),
		});
		expect(refund.status).toBe(200);
		expect((await app.request("/users-mgmt")).status).toBe(200);
		expect((await app.request("/cron")).status).toBe(200);
	});

	test("owner has the same route access as admin (superset)", async () => {
		const app = as("owner");
		const refund = await app.request("/workspaces/ws-1/refund", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amountMinor: 100, currency: "USD", reason: "ok", dodoChargeId: "ch_rbac_owner", idempotencyKey: "rbac-owner-refund" }),
		});
		expect(refund.status).toBe(200);
		expect((await app.request("/cron")).status).toBe(200);
	});
});

// ── GET /api/admin/me — role-driven nav/permissions ────────────────
describe("admin router — GET /me", () => {
	const store = new MemoryGdprStore();
	const billing = new FakeBillingStore();

	function meAs(role: UserRole) {
		return adminRouterAs(role, { gdpr: store, billing }).request("/me");
	}

	test("owner sees every section incl. roles.write permission", async () => {
		const res = await meAs("owner");
		expect(res.status).toBe(200);
		const body = await res.json() as { role: string; permissions: string[]; sections: Array<{ id: string; requires: string }> };
		expect(body.role).toBe("owner");
		expect(body.permissions).toContain(ADMIN_PERMISSIONS.ROLES_WRITE);
		const ids = body.sections.map((s) => s.id).sort();
		// owner can see all 9 declarative sections (incl. owner-inbox, ROLES_WRITE-gated)
		expect(ids).toEqual(["audit", "content", "coupons", "cron", "owner-inbox", "revenue", "support", "users", "workspaces"]);
	});

	test("accountant sees only workspaces (access) + revenue + audit sections", async () => {
		const res = await meAs("accountant");
		const body = await res.json() as { sections: Array<{ id: string }>; permissions: string[] };
		const ids = body.sections.map((s) => s.id).sort();
		expect(ids).toEqual(["audit", "revenue", "workspaces"]);
		expect(body.permissions).not.toContain(ADMIN_PERMISSIONS.REFUND_WRITE);
	});

	test("support sees workspaces + users + content + support + audit, NOT revenue/coupons/cron", async () => {
		const res = await meAs("support");
		const body = await res.json() as { sections: Array<{ id: string }> };
		const ids = body.sections.map((s) => s.id).sort();
		expect(ids).toEqual(["audit", "content", "support", "users", "workspaces"]);
	});

	test("editor is denied /me entirely (no admin:access)", async () => {
		expect((await meAs("editor")).status).toBe(403);
	});
});

// ── buildAccountExportBundle — real data portability (GDPR Art. 20) ─
describe("buildAccountExportBundle — walks real data", () => {
	function freshProjectsDir(): string {
		return mkdtempSync(join(tmpdir(), "gdpr-export-catalog-"));
	}

	function writeProjectState(projectsDir: string, state: ProjectState): void {
		const dir = join(projectsDir, state.projectId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
	}

	function personalProject(userId: string, overrides: Partial<ProjectState> & { projectId: string }): ProjectState {
		return {
			userId,
			name: "My Chapter",
			createdAt: "2026-05-01T00:00:00.000Z",
			pages: [{ imageId: "p1.png", imageName: "p1.png", textLayers: [], pendingAiJobs: [], coverRect: null }],
			currentPage: 0,
			targetLang: "th",
			...overrides,
		} as ProjectState;
	}

	test("includes the user's owned projects, their own comments, asset metadata, and audit events targeting them", async () => {
		const projectsDir = freshProjectsDir();
		const catalog = new FileProjectCatalogStore(projectsDir);
		const user = await createEditorUser();
		const store = new MemoryGdprStore();
		try {
			// Project the user OWNS (personal project: state.userId === user.id), with
			// the user's own comment plus a collaborator's comment (must be excluded).
			writeProjectState(projectsDir, personalProject(user.id, {
				projectId: "11111111-1111-4111-8111-111111111111",
				name: "Owned Chapter",
				sourceLang: "ja",
				targetLang: "th",
				coverImageId: "cover-1",
				coverOriginalName: "cover.png",
				comments: [
					{ id: "c-mine", pageIndex: 0, body: "my note", author: user.id, mentions: [], status: "open", createdAt: "2026-05-02T00:00:00.000Z", updatedAt: "2026-05-02T00:00:00.000Z" },
					{ id: "c-theirs", pageIndex: 0, body: "someone else", author: "other-user", mentions: [], status: "open", createdAt: "2026-05-02T00:00:00.000Z", updatedAt: "2026-05-02T00:00:00.000Z" },
				],
			}));
			// A project owned by someone ELSE — must NOT appear in this user's export.
			writeProjectState(projectsDir, personalProject("other-user", {
				projectId: "22222222-2222-4222-8222-222222222222",
				name: "Not Mine",
			}));
			// An admin_audit row that TARGETS this user (must be included) + one that does not.
			await store.recordAdminAudit({ adminUserId: "admin-x", action: "admin.user.force_logout", targetKind: "user", targetId: user.id });
			await store.recordAdminAudit({ adminUserId: "admin-x", action: "admin.user.force_logout", targetKind: "user", targetId: "other-user" });

			const bundle = await buildAccountExportBundle(user.id, { catalog, store });
			const parsed = JSON.parse(bundle.payload) as {
				profile: { id: string; email: string } | null;
				projects: Array<{ projectId: string; name: string; sourceLang: string | null; targetLang: string; assetMetadata: { coverImageId: string | null } }>;
				comments: Array<{ id: string; body: string }>;
				auditEvents: Array<{ targetId: string | null }>;
				assetMetadata: Array<{ projectId: string; coverImageId: string | null }>;
				counts: { projects: number; comments: number };
			};

			expect(parsed.profile?.id).toBe(user.id);
			// Owned project present, foreign project absent.
			expect(parsed.projects.map((p) => p.projectId)).toEqual(["11111111-1111-4111-8111-111111111111"]);
			const ownedProject = parsed.projects[0]!;
			expect(ownedProject.name).toBe("Owned Chapter");
			expect(ownedProject.sourceLang).toBe("ja");
			expect(ownedProject.assetMetadata.coverImageId).toBe("cover-1");
			// Only the user's OWN comment is exported.
			expect(parsed.comments.map((c) => c.id)).toEqual(["c-mine"]);
			// Asset metadata mirrors the owned project only.
			expect(parsed.assetMetadata.map((a) => a.projectId)).toEqual(["11111111-1111-4111-8111-111111111111"]);
			// Audit walk includes only rows targeting this user.
			expect(parsed.auditEvents.every((e) => e.targetId === user.id)).toBe(true);
			expect(parsed.auditEvents.length).toBe(1);
			expect(parsed.counts.projects).toBe(1);
			expect(parsed.counts.comments).toBe(1);
		} finally {
			await deleteUser(user.id);
		}
	});

	test("does NOT leak an ownerless legacy project, but DOES include the subject's own", async () => {
		// P1b: the default summary scope exposes owner_user_id IS NULL personal rows
		// to any caller. A GDPR export must include ONLY projects genuinely tied to
		// the subject — an ownerless legacy/imported project must NEVER appear in
		// someone else's portability bundle.
		const projectsDir = freshProjectsDir();
		const catalog = new FileProjectCatalogStore(projectsDir);
		const user = await createEditorUser();
		const store = new MemoryGdprStore();
		try {
			// Genuinely owned by the subject → MUST be in the bundle.
			writeProjectState(projectsDir, personalProject(user.id, {
				projectId: "33333333-3333-4333-8333-333333333333",
				name: "Subject Owned",
			}));
			// Ownerless legacy/imported project (no userId) → MUST NOT leak. Build it
			// directly so state.userId is genuinely absent (personalProject sets it).
			const ownerless = {
				name: "Legacy Imported (ownerless)",
				createdAt: "2026-05-01T00:00:00.000Z",
				pages: [{ imageId: "p1.png", imageName: "p1.png", textLayers: [], pendingAiJobs: [], coverRect: null }],
				currentPage: 0,
				targetLang: "th",
				projectId: "44444444-4444-4444-8444-444444444444",
				coverImageId: "secret-cover",
				coverOriginalName: "leaked-secret.png",
			} as unknown as ProjectState;
			writeProjectState(projectsDir, ownerless);

			const bundle = await buildAccountExportBundle(user.id, { catalog, store });
			const parsed = JSON.parse(bundle.payload) as {
				projects: Array<{ projectId: string; name: string; assetMetadata: { coverOriginalName: string | null } }>;
				assetMetadata: Array<{ projectId: string }>;
				counts: { projects: number };
			};

			const ids = parsed.projects.map((p) => p.projectId);
			expect(ids).toContain("33333333-3333-4333-8333-333333333333");
			// The ownerless legacy project — and its cover filename — must be absent.
			expect(ids).not.toContain("44444444-4444-4444-8444-444444444444");
			expect(parsed.projects.map((p) => p.name)).not.toContain("Legacy Imported (ownerless)");
			expect(parsed.projects.map((p) => p.assetMetadata.coverOriginalName)).not.toContain("leaked-secret.png");
			expect(parsed.assetMetadata.map((a) => a.projectId)).not.toContain("44444444-4444-4444-8444-444444444444");
			expect(parsed.counts.projects).toBe(1);
		} finally {
			await deleteUser(user.id);
		}
	});

	test("keeps the fixed top-level shape (arrays always present) even with no catalog", async () => {
		const user = await createEditorUser();
		try {
			const bundle = await buildAccountExportBundle(user.id, { catalog: null, store: new MemoryGdprStore() });
			const parsed = JSON.parse(bundle.payload) as Record<string, unknown>;
			for (const key of ["projects", "comments", "auditEvents", "assetMetadata"]) {
				expect(Array.isArray(parsed[key])).toBe(true);
			}
			expect(parsed.userId).toBe(user.id);
			expect(bundle.filename).toBe(`account-export-${user.id}.json`);
			expect(bundle.bytes).toBe(Buffer.byteLength(bundle.payload, "utf8"));
		} finally {
			await deleteUser(user.id);
		}
	});

	// P1 (portability completeness, GDPR Art. 15/20): the bundle must also include
	// the subject's consent history, account-export jobs, notification preferences,
	// support tickets + messages, and security/auth (token) records — previously the
	// bundle stopped at profile/projects/comments/audit/assetMetadata.
	test("includes consent history, export jobs, notification preferences, support tickets, and auth-token records", async () => {
		const { supportTicketStore } = await import("../services/support-tickets.js");
		const { notificationPreferenceStore } = await import("../services/notification-preferences.js");
		const { authFlowTokenStore, storeMintedToken } = await import("../services/password-reset.js");
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		try {
			// Consent history (with IP/UA — the subject's own data, included).
			await store.recordConsent({
				userId: user.id,
				consentType: "cookie",
				categories: { necessary: true, analytics: false },
				ipAddress: "203.0.113.7",
				userAgent: "PII-Browser",
				policyVersion: "v1",
			});
			// Account export job.
			await store.createExportJob(user.id);
			// Support ticket + first message.
			const ticket = await supportTicketStore.createTicket({
				requesterUserId: user.id,
				subject: "Billing question",
				body: "My card was charged twice",
			});
			// Notification preference override.
			await notificationPreferenceStore.setMany(user.id, [{ type: "ticket_opened", channel: "email", enabled: false }]);
			// Auth-flow token (security record).
			await storeMintedToken({ userId: user.id, kind: "password_reset", tokenHash: `hash-export-${user.id}`, expiresAt: new Date(Date.now() + 60_000), ipAddress: "203.0.113.7", userAgent: "PII-Browser" });

			const bundle = await buildAccountExportBundle(user.id, {
				catalog: null,
				store,
				supportTickets: supportTicketStore,
				notificationPreferences: notificationPreferenceStore,
				authFlowTokens: authFlowTokenStore,
			});
			const parsed = JSON.parse(bundle.payload) as {
				consentEvents: Array<{ consentType: string; ipAddress: string | null }>;
				exportJobs: Array<{ id: string; status: string }>;
				notificationPreferences: { values?: Record<string, Record<string, boolean>> } | null;
				supportTickets: Array<{ id: string; subject: string; messages: Array<{ body: string }> }>;
				securityRecords: { authFlowTokens: Array<{ kind: string; ipAddress: string | null; tokenHash?: string }> };
				counts: { consentEvents: number; exportJobs: number; supportTickets: number; authFlowTokens: number };
			};

			expect(parsed.consentEvents.length).toBe(1);
			expect(parsed.consentEvents[0]?.consentType).toBe("cookie");
			expect(parsed.exportJobs.length).toBe(1);
			expect(parsed.exportJobs[0]?.status).toBe("queued");
			expect(parsed.notificationPreferences?.values?.ticket_opened?.email).toBe(false);
			expect(parsed.supportTickets.length).toBe(1);
			expect(parsed.supportTickets[0]?.id).toBe(ticket.id);
			expect(parsed.supportTickets[0]?.subject).toBe("Billing question");
			expect(parsed.supportTickets[0]?.messages.length).toBeGreaterThanOrEqual(1);
			// Security record present with origin metadata, but the secret token_hash MUST NOT leak.
			expect(parsed.securityRecords.authFlowTokens.length).toBe(1);
			expect(parsed.securityRecords.authFlowTokens[0]?.kind).toBe("password_reset");
			expect(parsed.securityRecords.authFlowTokens[0]?.ipAddress).toBe("203.0.113.7");
			expect(parsed.securityRecords.authFlowTokens[0]).not.toHaveProperty("tokenHash");
			expect(parsed.counts.consentEvents).toBe(1);
			expect(parsed.counts.exportJobs).toBe(1);
			expect(parsed.counts.supportTickets).toBe(1);
			expect(parsed.counts.authFlowTokens).toBe(1);
		} finally {
			await authFlowTokenStore.eraseForUser(user.id);
			await supportTicketStore.erasePiiForUser(user.id);
			await deleteUser(user.id);
		}
	});

	// P1 LEAK regression (data-export): staff-only INTERNAL notes
	// (author_kind="internal") must NEVER appear in the subject's portability
	// bundle. The customer thread route filters them with
	// isCustomerVisibleAuthorKind(); the export must apply the SAME predicate.
	// Previously the bundle serialized EVERY message, leaking internal notes.
	test("excludes staff-only internal notes from the support-ticket export", async () => {
		const { supportTicketStore } = await import("../services/support-tickets.js");
		const store = new MemoryGdprStore();
		const user = await createEditorUser();
		try {
			const ticket = await supportTicketStore.createTicket({
				requesterUserId: user.id,
				subject: "Refund please",
				body: "I want a refund",
			});
			// A customer-visible agent reply (must be exported).
			await supportTicketStore.addMessage({
				ticketId: ticket.id,
				authorKind: "agent",
				body: "We are looking into your refund.",
			});
			// A staff-only INTERNAL note (must NOT be exported).
			const SECRET_NOTE = "INTERNAL: customer is a chargeback risk, escalate to legal";
			await supportTicketStore.addMessage({
				ticketId: ticket.id,
				authorKind: "internal",
				body: SECRET_NOTE,
			});

			const bundle = await buildAccountExportBundle(user.id, {
				catalog: null,
				store,
				supportTickets: supportTicketStore,
			});
			const parsed = JSON.parse(bundle.payload) as {
				supportTickets: Array<{ id: string; messages: Array<{ authorKind: string; body: string }> }>;
			};

			const exportedTicket = parsed.supportTickets.find((t) => t.id === ticket.id);
			expect(exportedTicket).toBeDefined();
			const messages = exportedTicket?.messages ?? [];
			// Internal note absent — neither by author kind nor by its body text.
			expect(messages.some((m) => m.authorKind === "internal")).toBe(false);
			expect(messages.some((m) => m.body === SECRET_NOTE)).toBe(false);
			expect(bundle.payload.includes(SECRET_NOTE)).toBe(false);
			// Customer-visible messages still present (opening + agent reply).
			expect(messages.some((m) => m.body === "We are looking into your refund.")).toBe(true);
			expect(messages.every((m) => m.authorKind !== "internal")).toBe(true);
		} finally {
			await supportTicketStore.erasePiiForUser(user.id);
			await deleteUser(user.id);
		}
	});
});

// ── runGdprErasureSweep — right-to-erasure enforcement ─────────────
describe("runGdprErasureSweep — anonymizes past-grace soft-deletes", () => {
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

	test("anonymizes a past-grace user, leaves active users untouched, and is idempotent", async () => {
		const store = createMemoryGdprStore();
		const pastGrace = await createEditorUser();
		const active = await createEditorUser();
		try {
			// Soft-delete one user; keep `active` fully active (never soft-deleted).
			await store.softDeleteUser(pastGrace.id, { gracePeriodMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Sweep "now" is 31 days past the deletion so `pastGrace` clears BOTH the
			// per-row undo window (1ms) AND the configured 30-day retention window.
			const now = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

			// Dry-run first: counts candidates, writes nothing.
			const dry = await runGdprErasureSweep({ store, now, dryRun: true, graceDays: 30 });
			expect(dry.candidates).toBeGreaterThanOrEqual(1);
			expect(dry.purged).toBe(0);
			// Nothing scrubbed yet — still the soft-delete alias.
			expect((await authUserStore.load(pastGrace.id))?.email.startsWith("purged+")).toBe(false);

			// Real sweep purges the past-grace user.
			const swept = await runGdprErasureSweep({ store, now, graceDays: 30 });
			expect(swept.purgedUserIds).toContain(pastGrace.id);
			expect(swept.purged).toBeGreaterThanOrEqual(1);

			const purgedRow = await authUserStore.load(pastGrace.id);
			expect(purgedRow?.email).toBe(`purged+${pastGrace.id}@redacted.invalid`);
			expect(purgedRow?.name).toBe("[deleted user]");
			expect(purgedRow?.isActive).toBe(false);
			expect(purgedRow?.passwordHash).toBe("");

			// Active user is completely untouched.
			const activeRow = await authUserStore.load(active.id);
			expect(activeRow?.email).toBe(active.email);
			expect(activeRow?.isActive).toBe(true);

			// No longer pending deletion — dropped from the soft-delete tracking.
			const pending = await store.listPendingSoftDeletes();
			expect(pending.find((entry) => entry.userId === pastGrace.id)).toBeUndefined();

			// Idempotent: a second sweep purges nothing new.
			const again = await runGdprErasureSweep({ store, now, graceDays: 30 });
			expect(again.purgedUserIds).not.toContain(pastGrace.id);
			expect(again.purged).toBe(0);
		} finally {
			await deleteUser(pastGrace.id);
			await deleteUser(active.id);
		}
	});

	test("a user still inside the configured retention window is NOT purged", async () => {
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		try {
			// Per-row grace already elapsed (1ms), but the configured 30-day retention
			// window has NOT — deletedAt is "now", sweep clock is only +1 day.
			await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
			const swept = await runGdprErasureSweep({ store, now: soon, graceDays: 30 });
			expect(swept.purged).toBe(0);
			// Still the soft-delete alias, NOT the purge tombstone.
			const row = await authUserStore.load(user.id);
			expect(row?.email).toBe(`deleted+${user.id}@redacted.invalid`);
			expect(row?.name).not.toBe("[deleted user]");
		} finally {
			await deleteUser(user.id);
		}
	});

	test("records an admin_audit row summarizing the erasure", async () => {
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		try {
			await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const now = new Date(Date.now() + (THIRTY_DAYS_MS + 24 * 60 * 60 * 1000));
			await runGdprErasureSweep({ store, now, graceDays: 30 });
			const audit = await store.listAdminAudit({ action: "gdpr.erasure.sweep" });
			expect(audit.total).toBe(1);
			const auditEntry = audit.entries[0]!;
			expect(auditEntry.detail).toMatchObject({ purged: 1 });
			expect(auditEntry.actorRole).toBe("system");
		} finally {
			await deleteUser(user.id);
		}
	});

	test("restore-then-redelete race: a candidate with a FRESH future grace is NOT purged (markers re-checked)", async () => {
		// P1a TOCTOU: the sweep listed this user as an OLD expired delete, but between
		// listing and purge the user RESTORED then soft-deleted AGAIN with a fresh
		// future undo window. Purging with the OLD selection context must SKIP — the
		// live markers no longer match — so we never erase a user inside a NEW window.
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		try {
			// (1) Original soft-delete. The per-row grace is still OPEN now (the user
			// can legitimately restore in step 2); the staleness this test exercises is
			// purely in the sweep's SELECTION CONTEXT, which is hand-built below as if a
			// run 31 days later had listed this candidate as expired.
			await store.softDeleteUser(user.id, { gracePeriodMs: 7 * 24 * 60 * 60 * 1000 });
			// Capture the context the sweep would have selected this candidate with:
			// the OLD deletedAt, plus the gates a sweep run 31 days later would use.
			const sweepNow = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const listedAtSelection = (await store.listPendingSoftDeletes()).find((e) => e.userId === user.id)!;
			const staleContext = {
				deletedAt: listedAtSelection.deletedAt,
				graceUntilAtOrBefore: sweepNow.toISOString(),
				deletedAtOrBefore: new Date(sweepNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
			};

			// (2) THE RACE: user restores, then re-deletes with a fresh future grace
			// window (a real, current undo window the user is still inside).
			expect(await store.restoreUser(user.id)).toBe(true);
			const fresh = await store.softDeleteUser(user.id, { gracePeriodMs: 7 * 24 * 60 * 60 * 1000 });
			expect(fresh).not.toBeNull();

			// (3) Purge with the STALE selection context must SKIP — markers changed.
			const outcome = await store.purgeSoftDeletedUser(user.id, staleContext);
			expect(outcome.purged).toBe(false);
			expect(outcome.reason).toBe("markers_changed");
			// The account is untouched: still the soft-delete alias, NOT the purge
			// tombstone, and still tracked as pending under its FRESH window.
			const row = await authUserStore.load(user.id);
			expect(row?.email).toBe(`deleted+${user.id}@redacted.invalid`);
			expect(row?.name).not.toBe("[deleted user]");
			const stillPending = (await store.listPendingSoftDeletes()).find((e) => e.userId === user.id);
			expect(stillPending?.deletedAt).toBe(fresh!.deletedAt);
		} finally {
			await deleteUser(user.id);
		}
	});

	test("P2 await-interleave: a restore-then-redelete DURING the scrub's await does NOT scrub the fresh-window user", async () => {
		// P2: the file-mode purge separates the read (authUserStore.load) from the
		// destructive write, then re-checks the deletion markers SYNCHRONOUSLY against
		// the captured selection context immediately before deleting the
		// pending-deletion marker — with NO await between. If a restore-then-redelete
		// lands in the load await (modeled here by a one-shot hook on load that
		// restores + re-deletes the user into a FRESH future window), the purge MUST
		// abort: NO purge tombstone written, the fresh undo window left intact.
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		const originalLoad = authUserStore.load.bind(authUserStore);
		let injected = false;
		let freshDeletedAt: string | undefined;
		try {
			// (1) Original soft-delete. Per-row grace is still OPEN now so the
			// interleaved restore in step 2 is a legitimate within-window action; the
			// staleness under test lives only in the hand-built sweep selection context.
			await store.softDeleteUser(user.id, { gracePeriodMs: 7 * 24 * 60 * 60 * 1000 });
			const sweepNow = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const listed = (await store.listPendingSoftDeletes()).find((e) => e.userId === user.id)!;
			const staleContext = {
				deletedAt: listed.deletedAt,
				graceUntilAtOrBefore: sweepNow.toISOString(),
				deletedAtOrBefore: new Date(sweepNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
			};

			// (2) THE INTERLEAVE: while the purge awaits authUserStore.load, restore +
			// re-delete the user with a fresh future window. Single-shot so only the
			// purge's own load triggers it.
			(authUserStore as { load: typeof authUserStore.load }).load = async (id: string) => {
				if (!injected && id === user.id) {
					injected = true;
					await store.restoreUser(user.id);
					const fresh = await store.softDeleteUser(user.id, { gracePeriodMs: 7 * 24 * 60 * 60 * 1000 });
					freshDeletedAt = fresh!.deletedAt;
				}
				return originalLoad(id);
			};

			// (3) Purge under the STALE context. The synchronous re-check sees the FRESH
			// marker the interleave stamped → abort, markers_changed, NO scrub.
			const outcome = await store.purgeSoftDeletedUser(user.id, staleContext);
			expect(injected).toBe(true);
			expect(outcome.purged).toBe(false);
			expect(outcome.reason).toBe("markers_changed");

			// The fresh-window user was NOT scrubbed: still the soft-delete alias, not
			// the purge tombstone, name intact, password not wiped.
			const row = await originalLoad(user.id);
			expect(row?.email).toBe(`deleted+${user.id}@redacted.invalid`);
			expect(row?.email).not.toBe(`purged+${user.id}@redacted.invalid`);
			expect(row?.name).not.toBe("[deleted user]");
			expect(row?.passwordHash).not.toBe("");
			// Still tracked as pending under its FRESH window — a later sweep handles it.
			const stillPending = (await store.listPendingSoftDeletes()).find((e) => e.userId === user.id);
			expect(stillPending?.deletedAt).toBe(freshDeletedAt);
		} finally {
			(authUserStore as { load: typeof authUserStore.load }).load = originalLoad;
			await deleteUser(user.id);
		}
	});

	test("a genuinely-expired candidate IS purged with its matching context, and re-run is idempotent", async () => {
		// P1a positive path: when the live markers STILL match the selection context
		// (no restore/redelete between list and purge), the purge proceeds — and a
		// second purge with the same context is a no-op (the row is already cleared).
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		try {
			await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 5));
			const sweepNow = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const listed = (await store.listPendingSoftDeletes()).find((e) => e.userId === user.id)!;
			const context = {
				deletedAt: listed.deletedAt,
				graceUntilAtOrBefore: sweepNow.toISOString(),
				deletedAtOrBefore: new Date(sweepNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
			};

			const first = await store.purgeSoftDeletedUser(user.id, context);
			expect(first.purged).toBe(true);
			const purgedRow = await authUserStore.load(user.id);
			expect(purgedRow?.email).toBe(`purged+${user.id}@redacted.invalid`);
			expect(purgedRow?.name).toBe("[deleted user]");

			// Idempotent re-run with the same context: nothing left to purge.
			const second = await store.purgeSoftDeletedUser(user.id, context);
			expect(second.purged).toBe(false);
			expect(second.reason).toBe("already_anonymized");
		} finally {
			await deleteUser(user.id);
		}
	});

	test("full sweep skips a candidate that restore-then-redeleted into a fresh window", async () => {
		// End-to-end P1a: runGdprErasureSweep itself must not erase a user who, after
		// being a stale candidate, now sits inside a fresh future undo window.
		const store = createMemoryGdprStore();
		const racer = await createEditorUser();
		const genuinelyExpired = await createEditorUser();
		try {
			// `racer`: delete whose per-row grace is still OPEN now so the restore in
			// step 2 is legitimate; at the +31-day sweep mark it WOULD be expired, but
			// the restore-then-redelete below moves it into a fresh 60-day window first.
			await store.softDeleteUser(racer.id, { gracePeriodMs: 7 * 24 * 60 * 60 * 1000 });
			// `genuinelyExpired`: short grace, never touched again → past grace at the
			// +31-day sweep mark → SHOULD be purged.
			await store.softDeleteUser(genuinelyExpired.id, { gracePeriodMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 5));

			// `racer` restores + re-deletes with a fresh 60-day window — the user is
			// genuinely inside a NEW undo window. The sweep clock (+31 days) is BEFORE
			// that fresh delete_grace_until, so the redeleted row is not yet past its
			// per-row grace and must NOT be a candidate. The atomic CAS is the deeper
			// guard (it rejects on the deletedAt mismatch the moment markers change
			// between list and purge), but a correct sweep also never lists it here.
			expect(await store.restoreUser(racer.id)).toBe(true);
			await store.softDeleteUser(racer.id, { gracePeriodMs: 60 * 24 * 60 * 60 * 1000 });

			const now = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const swept = await runGdprErasureSweep({ store, now, graceDays: 30 });

			expect(swept.purgedUserIds).toContain(genuinelyExpired.id);
			expect(swept.purgedUserIds).not.toContain(racer.id);
			// `racer` untouched: soft-delete alias, still pending; `genuinelyExpired` erased.
			expect((await authUserStore.load(racer.id))?.email).toBe(`deleted+${racer.id}@redacted.invalid`);
			expect((await authUserStore.load(genuinelyExpired.id))?.email).toBe(`purged+${genuinelyExpired.id}@redacted.invalid`);

			// Idempotent re-run purges nothing new and still leaves the racer alone.
			const again = await runGdprErasureSweep({ store, now, graceDays: 30 });
			expect(again.purged).toBe(0);
			expect(again.purgedUserIds).not.toContain(racer.id);
		} finally {
			await deleteUser(racer.id);
			await deleteUser(genuinelyExpired.id);
		}
	});

	test("purgeSoftDeletedUser on a non-soft-deleted / missing user is a safe no-op", async () => {
		const store = createMemoryGdprStore();
		const active = await createEditorUser();
		try {
			const missing = await store.purgeSoftDeletedUser("does-not-exist");
			expect(missing.purged).toBe(false);
			expect(missing.reason).toBe("user_missing");
			const notDeleted = await store.purgeSoftDeletedUser(active.id);
			expect(notDeleted.purged).toBe(false);
			expect(notDeleted.reason).toBe("not_soft_deleted");
			// Active account is untouched.
			expect((await authUserStore.load(active.id))?.email).toBe(active.email);
		} finally {
			await deleteUser(active.id);
		}
	});

	test("erasure scrubs the subject's ANCILLARY PII (consent IP/UA, invite email, notifications, support messages, memberships)", async () => {
		const { notificationStore } = await import("../services/notifications.js");
		const { supportTicketStore } = await import("../services/support-tickets.js");
		const { workspaceAccessStore } = await import("../services/workspace-access.js");
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		const otherUser = await createEditorUser();
		try {
			// ── Seed PII across the ancillary stores ──
			// Consent event with IP + user-agent (lives on the GDPR store itself).
			await store.recordConsent({
				userId: user.id,
				consentType: "cookie",
				categories: { necessary: true, analytics: true },
				ipAddress: "203.0.113.7",
				userAgent: "Mozilla/5.0 (PII-Browser)",
				policyVersion: "v1",
			});
			// Notification inbox.
			await notificationStore.create({ userId: user.id, type: "ticket_opened", title: "Hello", body: "Secret PII body" });
			await notificationStore.create({ userId: otherUser.id, type: "ticket_opened", title: "Keep me", body: "other user" });
			// Support-ticket message authored by the subject.
			const ticket = await supportTicketStore.createTicket({
				requesterUserId: user.id,
				subject: "Billing question",
				body: "My card ending 4242 was charged twice",
			});
			// Workspace membership (file-mode auto-provisions a personal workspace on touch).
			await workspaceAccessStore.listUserWorkspaces(user.id);
			const wsInternal = workspaceAccessStore as unknown as { members?: Array<{ userId: string }> };
			const membershipsBefore = (wsInternal.members ?? []).filter((m) => m.userId === user.id).length;
			expect(membershipsBefore).toBeGreaterThanOrEqual(1);

			// ── Soft-delete past grace + retention, then sweep ──
			await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const now = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const swept = await runGdprErasureSweep({ store, now, graceDays: 30 });
			expect(swept.purgedUserIds).toContain(user.id);

			// ── Consent PII scrubbed (the consent record itself is kept) ──
			const consents = await store.listConsentEvents(user.id);
			expect(consents.length).toBe(1);
			expect(consents[0]?.ipAddress).toBeNull();
			expect(consents[0]?.userAgent).toBeNull();

			// ── Notifications deleted for the subject, untouched for others ──
			const inbox = await notificationStore.listForUser(user.id);
			expect(inbox.items.length).toBe(0);
			const otherInbox = await notificationStore.listForUser(otherUser.id);
			expect(otherInbox.items.length).toBe(1);

			// ── Support message body anonymized ──
			const messages = await supportTicketStore.listMessages(ticket.id);
			const authored = messages.items.find((m) => m.authorUserId === user.id);
			expect(authored?.body).toBe("[deleted user message]");

			// ── Memberships removed (no orphaned row points at the erased user) ──
			// Inspect the store directly (listUserWorkspaces would lazily re-provision a
			// fresh personal workspace, masking the deletion).
			const membershipsAfter = (wsInternal.members ?? []).filter((m) => m.userId === user.id).length;
			expect(membershipsAfter).toBe(0);
		} finally {
			await deleteUser(user.id);
			await deleteUser(otherUser.id);
		}
	});

	// P1 (GDPR erasure-completeness): the purge must drop the subject's auth-flow
	// tokens (password-reset + email-verification). These hold token_hash + ip +
	// user_agent and cascade ONLY on a hard auth_users delete — which the purge never
	// performs — so without an explicit delete they survive erasure forever.
	test("erasure deletes the subject's password-reset + email-verification tokens (file-mode)", async () => {
		const { authFlowTokenStore, storeMintedToken } = await import("../services/password-reset.js");
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		const otherUser = await createEditorUser();
		try {
			// Seed reset + verify tokens for the subject (with ip/user-agent PII) and one
			// for another user that must survive.
			await storeMintedToken({ userId: user.id, kind: "password_reset", tokenHash: `hash-pr-${user.id}`, expiresAt: new Date(Date.now() + 60_000), ipAddress: "203.0.113.9", userAgent: "PII-Browser" });
			await storeMintedToken({ userId: user.id, kind: "email_verify", tokenHash: `hash-ev-${user.id}`, expiresAt: new Date(Date.now() + 60_000), ipAddress: "203.0.113.9" });
			await storeMintedToken({ userId: otherUser.id, kind: "password_reset", tokenHash: `hash-pr-${otherUser.id}`, expiresAt: new Date(Date.now() + 60_000), ipAddress: "198.51.100.1" });
			expect((await authFlowTokenStore.listForUser(user.id)).length).toBe(2);

			await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const now = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const swept = await runGdprErasureSweep({ store, now, graceDays: 30 });
			expect(swept.purgedUserIds).toContain(user.id);

			// Subject's tokens gone; the other user's token untouched.
			expect((await authFlowTokenStore.listForUser(user.id)).length).toBe(0);
			expect((await authFlowTokenStore.listForUser(otherUser.id)).length).toBe(1);
		} finally {
			await authFlowTokenStore.eraseForUser(user.id);
			await authFlowTokenStore.eraseForUser(otherUser.id);
			await deleteUser(user.id);
			await deleteUser(otherUser.id);
		}
	});

	// P1 (GDPR erasure-completeness): support ticket SUBJECTS are user free-text and
	// can quote PII, so the purge must anonymize them (the prior code only scrubbed
	// message bodies, leaving the subject as PII).
	test("erasure anonymizes the subject of support tickets the user opened (file-mode)", async () => {
		const { supportTicketStore, ERASED_SUPPORT_TICKET_SUBJECT } = await import("../services/support-tickets.js");
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		try {
			const ticket = await supportTicketStore.createTicket({
				requesterUserId: user.id,
				subject: "Refund for jane.doe@example.com card 4242",
				body: "please help",
			});
			await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const now = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const swept = await runGdprErasureSweep({ store, now, graceDays: 30 });
			expect(swept.purgedUserIds).toContain(user.id);

			const after = await supportTicketStore.getTicket(ticket.id);
			expect(after?.subject).toBe(ERASED_SUPPORT_TICKET_SUBJECT);
		} finally {
			await deleteUser(user.id);
		}
	});

	// P1 (GDPR erasure-completeness regression): the invite-erasure key must be the
	// subject's REAL ORIGINAL email — the address invites were sent to — NOT the
	// `deleted+<id>@redacted.invalid` alias the auth row is rewritten to at
	// soft-delete time. Before the fix, the purge derived the key from the already
	// redacted auth row, so invites addressed to the original email survived as PII.
	test("erasure anonymizes invites addressed to the subject's ORIGINAL email (not the redacted soft-delete alias)", async () => {
		const { workspaceAccessStore } = await import("../services/workspace-access.js");
		const store = createMemoryGdprStore();
		const user = await createEditorUser();
		const originalEmail = user.email;
		try {
			// Seed a pending invite addressed to the subject's ORIGINAL email (lowercased,
			// as the real invite path stores it). Push directly into the file-mode store's
			// invite list — the file store has no createInvite, mirroring how the ancillary
			// test inspects `members` directly.
			const wsInternal = workspaceAccessStore as unknown as {
				invites: Array<Record<string, unknown>>;
			};
			const inviteId = `inv-${user.id}`;
			wsInternal.invites.push({
				inviteId,
				workspaceId: `ws-${user.id}`,
				email: originalEmail.toLowerCase(),
				role: "editor",
				scope: {},
				status: "pending",
				invitedByUserId: "boss",
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});

			// Soft-delete (this REDACTS the auth row email to deleted+<id>@redacted.invalid),
			// then sweep past grace + retention.
			await store.softDeleteUser(user.id, { gracePeriodMs: 1 });
			// Sanity: the live auth row email is now the redacted alias, NOT the original.
			const { authUserStore } = await import("../services/auth-users.js");
			expect((await authUserStore.load(user.id))?.email).toBe(`deleted+${user.id}@redacted.invalid`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const now = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
			const swept = await runGdprErasureSweep({ store, now, graceDays: 30 });
			expect(swept.purgedUserIds).toContain(user.id);

			// The invite addressed to the ORIGINAL email must be anonymized — proving the
			// purge keyed off the original email and not the redacted alias.
			const invite = wsInternal.invites.find((i) => i.inviteId === inviteId);
			expect(invite?.email).toBe(`purged+${user.id}@redacted.invalid`);
			expect(invite?.email).not.toBe(originalEmail.toLowerCase());
		} finally {
			const wsInternal = workspaceAccessStore as unknown as { invites: Array<{ inviteId: string }> };
			const idx = wsInternal.invites.findIndex((i) => i.inviteId === `inv-${user.id}`);
			if (idx >= 0) wsInternal.invites.splice(idx, 1);
			await deleteUser(user.id);
		}
	});
});
