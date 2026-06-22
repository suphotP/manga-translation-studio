import { describe, expect, test } from "bun:test";
import {
	FileWorkspaceAccessStore,
	PostgresWorkspaceAccessStore,
	WorkspaceAccessError,
	filterWorkspaceScopeCoveredRecords,
	hashInviteToken,
	inferScopedTaskType,
	roleHasPermission,
	verifyInviteToken,
	workspaceScopeAllows,
	workspaceScopeAllowsNewProject,
	workspaceScopeCovers,
	type WorkspaceAccessSqlClient,
	type WorkspaceScope,
} from "../services/workspace-access.js";

class FakeWorkspaceSqlClient implements WorkspaceAccessSqlClient {
	queries: Array<{ query: string; params: unknown[] }> = [];
	beginCount = 0;
	commitCount = 0;
	rollbackCount = 0;
	workspaceRows: Array<Record<string, unknown>> = [];
	inviteRows: Array<Record<string, unknown>> = [];
	memberRows: Array<Record<string, unknown>> = [];
	auditRows: Array<Record<string, unknown>> = [];
	conflictMemberRow?: Record<string, unknown>;
	// auth_users rows the mention-candidate JOIN resolves name/email from (keyed by user_id).
	authUserRows: Map<string, { name: string | null; email: string | null }> = new Map();
	// FREEZE flag read by the requirePermission mutating-permission gate.
	suspendedAt: string | null = null;

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		if (query.includes("SELECT 1 AS one") && query.includes("FROM workspace_members")) {
			const userId = String(params[0] ?? "");
			const filtersSyntheticOwners = query.includes("workspace_id NOT LIKE 'personal:%'")
				&& query.includes("workspace_id NOT LIKE 'project:%'");
			const owned = this.memberRows.some((row) => {
				const workspaceId = String(row.workspace_id ?? "");
				if (row.user_id !== userId || row.role !== "owner" || row.disabled_at) return false;
				if (!filtersSyntheticOwners) return true;
				return !/^(?:personal|project):/.test(workspaceId);
			});
			return owned ? [{ one: 1 }] as T[] : [];
		}
		if (query.includes("INSERT INTO workspaces")) {
			return [{
				workspace_id: params[0],
				name: params[1],
				plan_id: params[2],
				storage_included_bytes: 0,
				storage_extra_bytes: 0,
				created_at: "2026-05-28T02:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
			}] as T[];
		}
		if (query.includes("SELECT workspace_id, name, plan_id") && query.includes("FROM workspaces")) {
			return this.workspaceRows as T[];
		}
		if (query.includes("FROM workspace_members") && query.includes("INNER JOIN workspaces")) {
			const role = params.find((param) => param === "owner" || param === "admin" || param === "editor" || param === "viewer");
			const limit = Number(params[params.length - 1]);
			const userId = String(params[0] ?? "");
			const filtersSyntheticWorkspaces = query.includes("workspaces.workspace_id NOT LIKE 'personal:%'")
				&& query.includes("workspaces.workspace_id NOT LIKE 'project:%'");
			return this.workspaceRows
				.filter((row) => row.user_id === undefined || row.user_id === userId)
				.filter((row) => !row.disabled_at)
				.filter((row) => {
					if (!filtersSyntheticWorkspaces) return true;
					return !/^(?:personal|project):/.test(String(row.workspace_id ?? ""));
				})
				.filter((row) => !role || row.member_role === role)
				.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.workspace_id).localeCompare(String(a.workspace_id)))
				.slice(0, Number.isFinite(limit) ? limit : undefined) as T[];
		}
		if (query.includes("UPDATE workspaces") && query.includes("RETURNING")) {
			if (this.workspaceRows.length === 0) return [];
			return [{
				workspace_id: params[0],
				name: params[1],
				plan_id: this.workspaceRows[0]?.plan_id ?? "creator",
				storage_included_bytes: this.workspaceRows[0]?.storage_included_bytes ?? 0,
				storage_extra_bytes: this.workspaceRows[0]?.storage_extra_bytes ?? 0,
				created_at: this.workspaceRows[0]?.created_at ?? "2026-05-28T02:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
			}] as T[];
		}
		if (query.includes("SELECT invite_id")) {
			if (query.includes("ORDER BY created_at DESC, invite_id DESC")) {
				const limit = Number(params[params.length - 1]);
				return this.inviteRows
					.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.invite_id).localeCompare(String(a.invite_id)))
					.slice(0, Number.isFinite(limit) ? limit : undefined) as T[];
			}
			return this.inviteRows as T[];
		}
		if (query.includes("FROM audit_events")) {
			let paramIndex = 1;
			let rows = this.auditRows.filter((row) => row.workspace_id === params[0]);
			if (query.includes("action = $")) {
				const action = params[paramIndex++];
				rows = rows.filter((row) => row.action === action);
			}
			if (query.includes("entity_type = $")) {
				const entityType = params[paramIndex++];
				rows = rows.filter((row) => row.entity_type === entityType);
			}
			if (query.includes("actor_user_id = $")) {
				const actorUserId = params[paramIndex++];
				rows = rows.filter((row) => row.actor_user_id === actorUserId);
			}
			const limit = Number(params[params.length - 1]);
			return rows
				.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.audit_event_id).localeCompare(String(a.audit_event_id)))
				.slice(0, Number.isFinite(limit) ? limit : undefined) as T[];
		}
		if (query.includes("COUNT(*)") && query.includes("admin_count") && query.includes("FROM workspace_members")) {
			const admin_count = this.memberRows.filter((row) => row.role === "owner" || row.role === "admin").length;
			return [{ admin_count }] as T[];
		}
		if (query.includes("SELECT suspended_at FROM workspaces")) {
			return [{ suspended_at: this.suspendedAt }] as T[];
		}
		if (query.includes("SELECT m.user_id, u.name, u.email") && query.includes("JOIN auth_users u")) {
			// listMentionCandidates JOIN: active members of $1, name/email from auth_users.
			// INNER JOIN semantics — a member with no auth_users row is dropped.
			const workspaceId = params[0];
			return this.memberRows
				.filter((row) => row.workspace_id === workspaceId && !row.disabled_at && this.authUserRows.has(String(row.user_id)))
				.map((row) => {
					const user = this.authUserRows.get(String(row.user_id))!;
					return { user_id: row.user_id, name: user.name, email: user.email };
				}) as T[];
		}
		if (query.includes("SELECT workspace_id, user_id, role") && query.includes("FROM workspace_members")) {
			if (query.includes("ORDER BY updated_at DESC, user_id DESC")) {
				const role = params.find((param) => param === "owner" || param === "admin" || param === "editor" || param === "viewer");
				const limit = Number(params[params.length - 1]);
				return this.memberRows
					.filter((row) => !role || row.role === role)
					.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.user_id).localeCompare(String(a.user_id)))
					.slice(0, Number.isFinite(limit) ? limit : undefined) as T[];
			}
			// listMembers(): WHERE workspace_id = $1 AND disabled_at IS NULL,
			// ORDER BY role ASC, updated_at DESC. Honour the same tenant + active
			// filter so the mention-candidate FALLBACK path (mixed-store config) is
			// scoped exactly like the JOIN fast path.
			if (query.includes("ORDER BY role ASC, updated_at DESC")) {
				const workspaceId = params[0];
				return this.memberRows
					.filter((row) => row.workspace_id === workspaceId && !row.disabled_at) as T[];
			}
			return this.memberRows as T[];
		}
		if (query.includes("INSERT INTO workspace_invites")) {
			return [{
				invite_id: params[0],
				workspace_id: params[1],
				email: String(params[2]).toLowerCase(),
				role: params[3],
				scope: params[4],
				status: "pending",
				invited_by_user_id: params[6],
				expires_at: params[7],
				created_at: "2026-05-28T02:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
			}] as T[];
		}
		if (query.includes("UPDATE workspace_invites") && query.includes("status = 'revoked'") && query.includes("RETURNING")) {
			if (this.inviteRows.length === 0) return [];
			return [{
				...this.inviteRows[0],
				status: "revoked",
				revoked_at: "2026-05-28T03:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
			}] as T[];
		}
		if (query.includes("UPDATE workspace_members") && query.includes("SET role = $3") && query.includes("RETURNING")) {
			if (this.memberRows.length === 0) return [];
			const existingScope = this.memberRows[0]?.scope ?? "{}";
			// Emulate COALESCE($4, member_studio_role, $7): an omitted studio role
			// ($4 === null) preserves the stored member_studio_role, falling back to
			// the access-role default ($7) only when no role is stored.
			const studioRole = params[3] ?? this.memberRows[0]?.member_studio_role ?? params[6];
			return [{
				workspace_id: params[0],
				user_id: params[1],
				role: params[2],
				member_studio_role: studioRole,
				scope: params[4] ?? existingScope,
				invited_by_user_id: this.memberRows[0]?.invited_by_user_id,
				created_at: "2026-05-28T02:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
			}] as T[];
		}
		if (query.includes("INSERT INTO workspace_members") && query.includes("RETURNING")) {
			if (this.conflictMemberRow) return [this.conflictMemberRow] as T[];
			return [{
				workspace_id: params[0],
				user_id: params[1],
				role: params[2],
				member_studio_role: params[3],
				scope: params[4],
				invited_by_user_id: params[5],
				created_at: "2026-05-28T02:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
			}] as T[];
		}
		return [];
	}

	async begin<T>(fn: (transaction: WorkspaceAccessSqlClient) => Promise<T>): Promise<T> {
		this.beginCount += 1;
		try {
			const result = await fn(this);
			this.commitCount += 1;
			return result;
		} catch (error) {
			this.rollbackCount += 1;
			throw error;
		}
	}
}

function decodeWorkspaceTestCursor(cursor: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("workspace access", () => {
	test("role permissions keep member management away from editors and viewers", () => {
		expect(roleHasPermission("owner", "manage_members")).toBe(true);
		expect(roleHasPermission("admin", "invite_members")).toBe(true);
		expect(roleHasPermission("editor", "update_project")).toBe(true);
		expect(roleHasPermission("editor", "manage_members")).toBe(false);
		expect(roleHasPermission("viewer", "read_project")).toBe(true);
		expect(roleHasPermission("viewer", "generate_ai")).toBe(false);
		// Viewer = view-only free seat: export must stay paid-member-only, or the
		// free no-seat role becomes an unlimited export account (product decision).
		expect(roleHasPermission("viewer", "export_project")).toBe(false);
		expect(roleHasPermission("editor", "export_project")).toBe(true);
		// Catalog shaping (create/delete เรื่อง+ตอน, language tracks, chapter-team
		// manage) is owner/admin-only — a worker seat works on chapters, it does
		// not reshape the catalog (product decision 2026-06-13).
		expect(roleHasPermission("editor", "manage_projects")).toBe(false);
		expect(roleHasPermission("admin", "manage_projects")).toBe(true);
		expect(roleHasPermission("editor", "update_project")).toBe(true);
	});

	test("creates a workspace with the creator as owner", async () => {
		const client = new FakeWorkspaceSqlClient();
		const store = new PostgresWorkspaceAccessStore(client);

		const workspace = await store.createWorkspace({
			workspaceId: "workspace-1",
			name: "Studio",
			ownerUserId: "owner-1",
			planId: "creator",
		});

		expect(workspace.workspaceId).toBe("workspace-1");
		expect(workspace.planId).toBe("creator");
		expect(client.beginCount).toBe(1);
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO workspace_members") && entry.params[1] === "owner-1")).toBe(true);
	});

	test("ensurePersonalWorkspace provisions a personal owner workspace when the user owns none", async () => {
		const client = new FakeWorkspaceSqlClient();
		const store = new PostgresWorkspaceAccessStore(client);

		await store.ensurePersonalWorkspace("fresh-user");

		// Per-user advisory lock guards against concurrent duplicate provisioning.
		expect(client.queries.some((entry) => entry.query.includes("pg_advisory_xact_lock"))).toBe(true);
		const wsInsert = client.queries.find((entry) => entry.query.includes("INSERT INTO workspaces"));
		expect(wsInsert?.params[1]).toBe("My Workspace");
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO workspace_members") && entry.params[1] === "fresh-user")).toBe(true);
		expect(client.beginCount).toBe(1);
	});

	test("ensurePersonalWorkspace ignores synthetic-only owner rows before provisioning", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [
			{ workspace_id: "personal:u-legacy", user_id: "u-legacy", role: "owner", disabled_at: null },
			{ workspace_id: "project:p-legacy", user_id: "u-legacy", role: "owner", disabled_at: null },
		];
		const store = new PostgresWorkspaceAccessStore(client);

		await store.ensurePersonalWorkspace("u-legacy");

		const ownerProbe = client.queries.find((entry) => entry.query.includes("SELECT 1 AS one") && entry.query.includes("FROM workspace_members"));
		expect(ownerProbe?.query).toContain("workspace_id NOT LIKE 'personal:%'");
		expect(ownerProbe?.query).toContain("workspace_id NOT LIKE 'project:%'");
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO workspaces") && entry.params[1] === "My Workspace")).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO workspace_members") && entry.params[1] === "u-legacy")).toBe(true);
		expect(client.beginCount).toBe(1);
	});

	test("list reads are side-effect-free so admin/support lookups never provision a workspace", async () => {
		// FakeWorkspaceSqlClient has no workspaceRows: the looked-up user owns none.
		const client = new FakeWorkspaceSqlClient();
		const store = new PostgresWorkspaceAccessStore(client);

		expect(await store.listUserWorkspaces("looked-up-user")).toEqual([]);
		expect((await store.listUserWorkspacePage("looked-up-user")).workspaces).toEqual([]);

		// Neither read may write: no provisioning INSERTs and no advisory lock. This
		// is the contract that keeps admin user-detail / support lookup routes from
		// silently creating production workspaces for the account they inspect.
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO"))).toBe(false);
		expect(client.queries.some((entry) => entry.query.includes("pg_advisory_xact_lock"))).toBe(false);
		expect(client.beginCount).toBe(0);
	});

	test("list reads hide synthetic catalog workspace ids", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.workspaceRows = [
			{
				user_id: "u-1",
				workspace_id: "personal:u-1",
				name: "Synthetic Personal",
				plan_id: "free",
				storage_included_bytes: 0,
				storage_extra_bytes: 0,
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T05:00:00.000Z",
				member_role: "owner",
				member_scope: "{}",
			},
			{
				user_id: "u-1",
				workspace_id: "project:p-1",
				name: "Synthetic Project",
				plan_id: "free",
				storage_included_bytes: 0,
				storage_extra_bytes: 0,
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T04:00:00.000Z",
				member_role: "owner",
				member_scope: "{}",
			},
			{
				user_id: "u-1",
				workspace_id: "workspace-real",
				name: "Real Workspace",
				plan_id: "creator",
				storage_included_bytes: 0,
				storage_extra_bytes: 0,
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
				member_role: "admin",
				member_scope: "{}",
			},
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const listed = await store.listUserWorkspaces("u-1");
		const page = await store.listUserWorkspacePage("u-1");

		expect(listed.map((workspace) => workspace.workspaceId)).toEqual(["workspace-real"]);
		expect(page.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["workspace-real"]);
		const listQueries = client.queries.filter((entry) => entry.query.includes("FROM workspace_members") && entry.query.includes("INNER JOIN workspaces"));
		expect(listQueries).toHaveLength(2);
		expect(listQueries.every((entry) => entry.query.includes("workspaces.workspace_id NOT LIKE 'personal:%'"))).toBe(true);
		expect(listQueries.every((entry) => entry.query.includes("workspaces.workspace_id NOT LIKE 'project:%'"))).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO"))).toBe(false);
	});

	test("normalizes non-catalog workspace plans on internal creation", async () => {
		const client = new FakeWorkspaceSqlClient();
		const store = new PostgresWorkspaceAccessStore(client);

		const workspace = await store.createWorkspace({
			workspaceId: "workspace-1",
			name: "Studio",
			ownerUserId: "owner-1",
			planId: "enterprise",
		});

		expect(workspace.planId).toBe("free");
		const insert = client.queries.find((entry) => entry.query.includes("INSERT INTO workspaces"));
		expect(insert?.params[2]).toBe("free");
	});

	test("normalizes catalog workspace plan ids before insert", async () => {
		const client = new FakeWorkspaceSqlClient();
		const store = new PostgresWorkspaceAccessStore(client);

		const workspace = await store.createWorkspace({
			workspaceId: "workspace-1",
			name: "Studio",
			ownerUserId: "owner-1",
			planId: " Creator ",
		});

		expect(workspace.planId).toBe("creator");
		const insert = client.queries.find((entry) => entry.query.includes("INSERT INTO workspaces"));
		expect(insert?.params[2]).toBe("creator");
	});

	test("reads and updates workspace details through indexed workspace ids", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.workspaceRows = [{
			workspace_id: "workspace-1",
			name: "Studio",
			plan_id: "creator",
			storage_included_bytes: 5_000,
			storage_extra_bytes: 1_000,
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		await expect(store.getWorkspace("workspace-1")).resolves.toMatchObject({
			workspaceId: "workspace-1",
			name: "Studio",
			storageIncludedBytes: 5_000,
		});
		const updated = await store.updateWorkspace({
			workspaceId: "workspace-1",
			name: "Studio Team",
			actorUserId: "owner-1",
		});

		expect(updated.name).toBe("Studio Team");
		const select = client.queries.find((entry) => entry.query.includes("FROM workspaces"));
		expect(select?.query).toContain("WHERE workspace_id = $1");
		const update = client.queries.find((entry) => entry.query.includes("UPDATE workspaces"));
		expect(update?.query).toContain("WHERE workspace_id = $1");
		const audit = client.queries.find((entry) => entry.query.includes("INSERT INTO audit_events") && entry.params[3] === "workspace_updated");
		expect(audit?.params[6]).toMatchObject({ name: "Studio Team" });
	});

	test("lists user workspaces with bounded cursor pagination", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.workspaceRows = [
			{
				workspace_id: "workspace-b",
				name: "Workspace B",
				plan_id: "creator",
				storage_included_bytes: 0,
				storage_extra_bytes: 0,
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
				cursor_updated_at: "2026-05-28T03:00:00.123456Z",
				member_role: "viewer",
				member_scope: JSON.stringify({ projectIds: ["project-b"] }),
			},
			{
				workspace_id: "workspace-a",
				name: "Workspace A",
				plan_id: "free",
				storage_included_bytes: 0,
				storage_extra_bytes: 0,
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
				member_role: "admin",
				member_scope: JSON.stringify({}),
			},
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const first = await store.listUserWorkspacePage("user-1", { limit: 1 });
		expect(first.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["workspace-b"]);
		expect(first.nextCursor).toBeDefined();
		expect(decodeWorkspaceTestCursor(first.nextCursor!).updatedAt).toBe("2026-05-28T03:00:00.123456Z");
		expect(client.queries.at(-1)?.query).toContain("ORDER BY workspaces.updated_at DESC, workspaces.workspace_id DESC");

		const filtered = await store.listUserWorkspacePage("user-1", { role: "admin" });
		expect(filtered.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["workspace-a"]);
	});

	test("checks scoped project, page, language, task, and asset access", () => {
		const scope = {
			projectIds: ["project-1"],
			chapterIds: ["chapter-1"],
			pageIndexes: [0, 4],
			languages: ["th"],
			taskTypes: ["translate"],
			assetPurposes: ["source_page"],
		};

		expect(workspaceScopeAllows(scope, {
			projectId: "project-1",
			chapterId: "chapter-1",
			pageIndex: 4,
			language: "th",
			taskType: "translate",
			assetPurpose: "source_page",
		})).toBe(true);
		expect(workspaceScopeAllows(scope, { projectId: "project-2" })).toBe(false);
		expect(workspaceScopeAllows(scope, { pageIndex: 5 })).toBe(false);
		expect(workspaceScopeAllows({}, { projectId: "project-2", language: "ja" })).toBe(true);
	});

	test("allows new project creation only for workspace-wide or language-only scopes", () => {
		expect(workspaceScopeAllowsNewProject({}, { language: "th" })).toBe(true);
		expect(workspaceScopeAllowsNewProject({ languages: ["th"] }, { language: "th" })).toBe(true);
		expect(workspaceScopeAllowsNewProject({ languages: ["th"] }, { language: "en" })).toBe(false);
		expect(workspaceScopeAllowsNewProject({ projectIds: ["project-1"] }, { language: "th" })).toBe(false);
		expect(workspaceScopeAllowsNewProject({ pageIndexes: [0] }, { language: "th" })).toBe(false);
	});

	test("checks that scoped admins can only grant narrower or equal scopes", () => {
		const actorScope = {
			projectIds: ["project-1", "project-2"],
			languages: ["th"],
			pageIndexes: [0, 1],
			taskTypes: ["translate", "review"],
			aiCreditPolicy: "job_scoped" as const,
		};

		expect(workspaceScopeCovers(actorScope, {
			projectIds: ["project-1"],
			languages: ["th"],
			pageIndexes: [0],
			taskTypes: ["translate"],
			aiCreditPolicy: "none",
		})).toBe(true);
		expect(workspaceScopeCovers(actorScope, { projectIds: ["project-3"] })).toBe(false);
		expect(workspaceScopeCovers(actorScope, { languages: ["en"] })).toBe(false);
		expect(workspaceScopeCovers(actorScope, { projectIds: ["project-1"] })).toBe(false);
		expect(workspaceScopeCovers(actorScope, undefined)).toBe(false);
		expect(workspaceScopeCovers({}, undefined)).toBe(true);
		expect(workspaceScopeCovers({}, { projectIds: ["project-3"], aiCreditPolicy: "workspace" })).toBe(true);
		expect(workspaceScopeCovers({ aiCreditPolicy: "none" }, { aiCreditPolicy: "job_scoped" })).toBe(false);
		// Team Lead marker scope: { aiCreditPolicy: "workspace" } is the broadest explicit
		// grant and must cover an unrestricted owner/admin (undefined / {} scope) so a Team
		// Lead keeps full management reach over workspace-wide members and settings.
		expect(workspaceScopeCovers({ aiCreditPolicy: "workspace" }, undefined)).toBe(true);
		expect(workspaceScopeCovers({ aiCreditPolicy: "workspace" }, {})).toBe(true);
		expect(workspaceScopeCovers({ aiCreditPolicy: "workspace" }, { aiCreditPolicy: "job_scoped" })).toBe(true);
		expect(workspaceScopeCovers({ aiCreditPolicy: "workspace" }, { projectIds: ["project-1"] })).toBe(true);
	});

	test("filters member and invite records to actor-covered scopes", () => {
		const actorScope: WorkspaceScope = {
			projectIds: ["project-1"],
			languages: ["th"],
			aiCreditPolicy: "job_scoped",
		};
		const records: Array<{ id: string; scope: WorkspaceScope }> = [
			{ id: "covered-none", scope: { projectIds: ["project-1"], languages: ["th"], aiCreditPolicy: "none" } },
			{ id: "covered-job", scope: { projectIds: ["project-1"], languages: ["th"], aiCreditPolicy: "job_scoped" } },
			{ id: "broader", scope: {} },
			{ id: "other-project", scope: { projectIds: ["project-2"], languages: ["th"], aiCreditPolicy: "none" } },
			{ id: "other-language", scope: { projectIds: ["project-1"], languages: ["en"], aiCreditPolicy: "none" } },
			{ id: "implicit-ai-policy", scope: { projectIds: ["project-1"], languages: ["th"] } },
		];

		expect(filterWorkspaceScopeCoveredRecords(actorScope, records).map((record) => record.id)).toEqual([
			"covered-none",
			"covered-job",
		]);
	});

	test("lists workspace members and invites with bounded cursor pages", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [
			{
				workspace_id: "workspace-1",
				user_id: "member-b",
				role: "viewer",
				scope: JSON.stringify({ projectIds: ["project-b"] }),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
				cursor_updated_at: "2026-05-28T03:00:00.123456Z",
			},
			{
				workspace_id: "workspace-1",
				user_id: "member-a",
				role: "editor",
				scope: JSON.stringify({ projectIds: ["project-a"] }),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
			},
		];
		client.inviteRows = [
			{
				invite_id: "invite-b",
				workspace_id: "workspace-1",
				email: "b@example.com",
				role: "viewer",
				scope: JSON.stringify({ projectIds: ["project-b"] }),
				status: "pending",
				invited_by_user_id: "owner-1",
				expires_at: "2026-06-28T01:00:00.000Z",
				created_at: "2026-05-28T03:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
				cursor_created_at: "2026-05-28T03:00:00.654321Z",
			},
			{
				invite_id: "invite-a",
				workspace_id: "workspace-1",
				email: "a@example.com",
				role: "editor",
				scope: JSON.stringify({ projectIds: ["project-a"] }),
				status: "pending",
				invited_by_user_id: "owner-1",
				expires_at: "2026-06-28T01:00:00.000Z",
				created_at: "2026-05-28T02:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
			},
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const members = await store.listMemberPage("workspace-1", { limit: 1 });
		expect(members.members.map((member) => member.userId)).toEqual(["member-b"]);
		expect(members.nextCursor).toBeDefined();
		expect(decodeWorkspaceTestCursor(members.nextCursor!).updatedAt).toBe("2026-05-28T03:00:00.123456Z");
		expect(client.queries.at(-1)?.query).toContain("ORDER BY updated_at DESC, user_id DESC");

		const editors = await store.listMemberPage("workspace-1", { role: "editor" });
		expect(editors.members.map((member) => member.userId)).toEqual(["member-a"]);

		await store.listMemberPage("workspace-1", {
			scopeCoveredBy: { projectIds: ["project-a"], languages: ["th"], aiCreditPolicy: "job_scoped" },
		});
		const scopedMembersQuery = client.queries.at(-1);
		expect(scopedMembersQuery?.query).toContain("(scope ? 'projectIds'");
		expect(scopedMembersQuery?.query).toContain("(scope ? 'languages'");
		expect(scopedMembersQuery?.query).toContain("scope->>'aiCreditPolicy' IN");
		expect(scopedMembersQuery?.params).toContain(JSON.stringify(["project-a"]));
		expect(scopedMembersQuery?.params).toContain(JSON.stringify(["th"]));
		expect(scopedMembersQuery?.params).toContain("job_scoped");
		expect(scopedMembersQuery?.params).toContain("none");

		// Team Lead marker scope must NOT add an aiCreditPolicy-key requirement, otherwise
		// unrestricted owners/admins (no aiCreditPolicy key) would be filtered out of the list.
		await store.listMemberPage("workspace-1", {
			scopeCoveredBy: { aiCreditPolicy: "workspace" },
		});
		const teamLeadMembersQuery = client.queries.at(-1);
		expect(teamLeadMembersQuery?.query).not.toContain("scope->>'aiCreditPolicy' IN");
		expect(teamLeadMembersQuery?.params).not.toContain("workspace");

		const invites = await store.listInvitePage("workspace-1", { limit: 1 });
		expect(invites.invites.map((invite) => invite.inviteId)).toEqual(["invite-b"]);
		expect(invites.nextCursor).toBeDefined();
		expect(decodeWorkspaceTestCursor(invites.nextCursor!).updatedAt).toBe("2026-05-28T03:00:00.654321Z");
		expect(client.queries.at(-1)?.query).toContain("ORDER BY created_at DESC, invite_id DESC");

		await store.listInvitePage("workspace-1", {
			scopeCoveredBy: { projectIds: ["project-a"], aiCreditPolicy: "none" },
		});
		const scopedInvitesQuery = client.queries.at(-1);
		expect(scopedInvitesQuery?.query).toContain("(scope ? 'projectIds'");
		expect(scopedInvitesQuery?.query).toContain("scope->>'aiCreditPolicy' IN");
		expect(scopedInvitesQuery?.params).toContain(JSON.stringify(["project-a"]));
		expect(scopedInvitesQuery?.params).toContain("none");
	});

	test("lists workspace audit events with bounded cursor pages and indexed filters", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.auditRows = [
			{
				audit_event_id: "audit-b",
				workspace_id: "workspace-1",
				project_id: "project-1",
				actor_user_id: "owner-1",
				action: "workspace_invite_created",
				entity_type: "workspace_invite",
				entity_id: "invite-1",
				metadata: JSON.stringify({ email: "member@example.com" }),
				created_at: "2026-05-28T03:00:00.000Z",
				cursor_created_at: "2026-05-28T03:00:00.654321Z",
			},
			{
				audit_event_id: "audit-a",
				workspace_id: "workspace-1",
				actor_user_id: "admin-1",
				action: "workspace_member_updated",
				entity_type: "workspace_member",
				entity_id: "member-1",
				metadata: JSON.stringify({ role: "editor" }),
				created_at: "2026-05-28T02:00:00.000Z",
			},
			{
				audit_event_id: "audit-other",
				workspace_id: "workspace-2",
				actor_user_id: "owner-2",
				action: "workspace_updated",
				entity_type: "workspace",
				entity_id: "workspace-2",
				metadata: JSON.stringify({ name: "Other" }),
				created_at: "2026-05-28T04:00:00.000Z",
			},
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const first = await store.listAuditEventPage("workspace-1", { limit: 1 });
		expect(first.events.map((event) => event.auditEventId)).toEqual(["audit-b"]);
		expect(first.events[0].metadata).toEqual({ email: "member@example.com" });
		expect(first.nextCursor).toBeDefined();
		expect(decodeWorkspaceTestCursor(first.nextCursor!).kind).toBe("auditEventId");
		expect(decodeWorkspaceTestCursor(first.nextCursor!).updatedAt).toBe("2026-05-28T03:00:00.654321Z");
		expect(client.queries.at(-1)?.query).toContain("ORDER BY created_at DESC, audit_event_id DESC");

		const filtered = await store.listAuditEventPage("workspace-1", {
			action: "workspace_member_updated",
			entityType: "workspace_member",
			actorUserId: "admin-1",
		});
		expect(filtered.events.map((event) => event.auditEventId)).toEqual(["audit-a"]);
		const filteredQuery = client.queries.at(-1);
		expect(filteredQuery?.query).toContain("action = $2");
		expect(filteredQuery?.query).toContain("entity_type = $3");
		expect(filteredQuery?.query).toContain("actor_user_id = $4");
	});

	test("requires both role permission and member scope for resource operations", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [{
			workspace_id: "workspace-1",
			user_id: "member-1",
			role: "editor",
			scope: JSON.stringify({ projectIds: ["project-1"], languages: ["th"] }),
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		await expect(store.requireScopedPermission("workspace-1", "member-1", "update_project", {
			projectId: "project-1",
			language: "th",
		})).resolves.toMatchObject({ role: "editor" });
		await expect(store.requireScopedPermission("workspace-1", "member-1", "update_project", {
			projectId: "project-2",
		})).rejects.toThrow("scope");
	});

	test("creates hashed workspace invites and returns the raw token once", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.inviteRows = [{
			invite_id: "old-invite",
			workspace_id: "workspace-1",
			email: "new.user@example.com",
			role: "viewer",
			scope: JSON.stringify({ projectIds: ["project-1"] }),
			status: "pending",
			invited_by_user_id: "owner-1",
			expires_at: "2026-05-29T02:00:00.000Z",
			created_at: "2026-05-28T01:00:00.000Z",
			updated_at: "2026-05-28T01:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		const invite = await store.createInvite({
			workspaceId: "workspace-1",
			email: "New.User@example.com",
			role: "editor",
			scope: { projectIds: ["project-1"], languages: ["th"], aiCreditPolicy: "job_scoped" },
			invitedByUserId: "owner-1",
			ttlSeconds: 3600,
			replaceWithinScope: { projectIds: ["project-1"] },
		});

		expect(invite.email).toBe("new.user@example.com");
		expect(invite.inviteToken.length).toBeGreaterThan(20);
		const insert = client.queries.find((entry) => entry.query.includes("INSERT INTO workspace_invites"));
		expect(insert?.params[5]).toBe(hashInviteToken(invite.inviteToken));
		expect(insert?.params[4]).toMatchObject({
			projectIds: ["project-1"],
			languages: ["th"],
			aiCreditPolicy: "job_scoped",
		});
		expect(client.beginCount).toBe(1);
		expect(client.queries.some((entry) => entry.query.includes("pg_advisory_xact_lock"))).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("FOR UPDATE"))).toBe(true);
		const revoke = client.queries.find((entry) => entry.query.includes("UPDATE workspace_invites") && entry.query.includes("status = 'revoked'"));
		expect(revoke?.params).toContain("old-invite");
	});

	test("does not let scoped invite replacement revoke broader pending invites", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.inviteRows = [{
			invite_id: "broad-invite",
			workspace_id: "workspace-1",
			email: "new.user@example.com",
			role: "admin",
			scope: JSON.stringify({}),
			status: "pending",
			invited_by_user_id: "owner-1",
			expires_at: "2026-05-29T02:00:00.000Z",
			created_at: "2026-05-28T01:00:00.000Z",
			updated_at: "2026-05-28T01:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		await expect(store.createInvite({
			workspaceId: "workspace-1",
			email: "New.User@example.com",
			role: "editor",
			scope: { projectIds: ["project-1"] },
			invitedByUserId: "scoped-admin",
			replaceWithinScope: { projectIds: ["project-1"] },
		})).rejects.toThrow("broader pending workspace invite");

		expect(client.rollbackCount).toBe(1);
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO workspace_invites"))).toBe(false);
	});

	test("revokes pending invites with an expected authorized scope", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.inviteRows = [{
			invite_id: "invite-1",
			workspace_id: "workspace-1",
			email: "new.user@example.com",
			role: "viewer",
			scope: JSON.stringify({ projectIds: ["project-1"], languages: ["th"] }),
			status: "pending",
			invited_by_user_id: "owner-1",
			expires_at: "2026-05-29T02:00:00.000Z",
			created_at: "2026-05-28T01:00:00.000Z",
			updated_at: "2026-05-28T01:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		await expect(store.getInvite("workspace-1", "invite-1")).resolves.toMatchObject({
			inviteId: "invite-1",
			status: "pending",
		});
		const revoked = await store.revokeInvite({
			workspaceId: "workspace-1",
			inviteId: "invite-1",
			actorUserId: "admin-1",
			expectedScope: { projectIds: ["project-1"], languages: ["th"] },
		});

		expect(revoked.status).toBe("revoked");
		const revoke = client.queries.find((entry) => entry.query.includes("UPDATE workspace_invites") && entry.query.includes("status = 'revoked'"));
		expect(revoke?.query).toContain("AND ($3::jsonb IS NULL OR scope = $3::jsonb)");
		expect(revoke?.params[2]).toEqual({ projectIds: ["project-1"], languages: ["th"] });
		const audit = client.queries.find((entry) => entry.query.includes("INSERT INTO audit_events") && entry.params[3] === "workspace_invite_revoked");
		expect(audit?.params[6]).toMatchObject({
			email: "new.user@example.com",
			role: "viewer",
			scope: { projectIds: ["project-1"], languages: ["th"] },
		});
	});

	test("verifies invite tokens without exposing raw tokens", () => {
		const token = "test-token-with-enough-length";
		const hash = hashInviteToken(token);

		expect(verifyInviteToken(token, hash)).toBe(true);
		expect(verifyInviteToken("wrong-token-with-enough-length", hash)).toBe(false);
		expect(verifyInviteToken(token, "short")).toBe(false);
	});

	test("does not allow member update paths to demote owners", async () => {
		const client = new FakeWorkspaceSqlClient();
		const store = new PostgresWorkspaceAccessStore(client);

		await expect(store.updateMember({
			workspaceId: "workspace-1",
			userId: "owner-1",
			role: "admin",
			actorUserId: "owner-1",
		})).rejects.toThrow("cannot update owner");

		const update = client.queries.find((entry) => entry.query.includes("UPDATE workspace_members"));
		expect(update?.query).toContain("AND role <> 'owner'");
	});

	test("preserves existing member scope when role updates omit scope", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [{
			workspace_id: "workspace-1",
			user_id: "member-1",
			role: "viewer",
			scope: JSON.stringify({ projectIds: ["project-1"], languages: ["th"] }),
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		const member = await store.updateMember({
			workspaceId: "workspace-1",
			userId: "member-1",
			role: "editor",
			actorUserId: "owner-1",
		});

		expect(member.scope).toEqual({ projectIds: ["project-1"], languages: ["th"] });
		// A member with no stored operational role that omits memberStudioRole gets
		// the access-role default via the $7 fallback inside COALESCE.
		expect(member.memberStudioRole).toBe("typesetter");
		const update = client.queries.find((entry) => entry.query.includes("UPDATE workspace_members") && entry.query.includes("SET role = $3"));
		expect(update?.query).toContain("member_studio_role = COALESCE($4, member_studio_role, $7)");
		expect(update?.query).toContain("COALESCE($5::jsonb, scope)");
		expect(update?.params[3]).toBeNull();
		expect(update?.params[4]).toBeNull();
		expect(update?.params[5]).toBeNull();
		expect(update?.params[6]).toBe("typesetter");
		const audit = client.queries.find((entry) => entry.query.includes("INSERT INTO audit_events") && entry.params[3] === "workspace_member_updated");
		expect(audit?.params[6]).toMatchObject({
			role: "editor",
			memberStudioRole: "typesetter",
			scope: { projectIds: ["project-1"], languages: ["th"] },
		});
	});

	test("preserves an existing operational studio role when the update omits it", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [{
			workspace_id: "workspace-1",
			user_id: "member-1",
			role: "editor",
			member_studio_role: "translator",
			scope: JSON.stringify({ projectIds: ["project-1"] }),
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		const member = await store.updateMember({
			workspaceId: "workspace-1",
			userId: "member-1",
			role: "editor",
			scope: { projectIds: ["project-2"] },
			actorUserId: "owner-1",
		});

		// Updating only the scope must not reset the operational role to the
		// access-role default; the stored `translator` is preserved.
		expect(member.memberStudioRole).toBe("translator");
		const update = client.queries.find((entry) => entry.query.includes("UPDATE workspace_members") && entry.query.includes("SET role = $3"));
		expect(update?.params[3]).toBeNull();
	});

	test("member updates can carry a separate operational studio role", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [{
			workspace_id: "workspace-1",
			user_id: "member-1",
			role: "viewer",
			member_studio_role: "guest",
			scope: JSON.stringify({}),
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		const member = await store.updateMember({
			workspaceId: "workspace-1",
			userId: "member-1",
			role: "editor",
			memberStudioRole: "translator",
			actorUserId: "owner-1",
		});

		expect(member.role).toBe("editor");
		expect(member.memberStudioRole).toBe("translator");
		const update = client.queries.find((entry) => entry.query.includes("UPDATE workspace_members") && entry.query.includes("SET role = $3"));
		expect(update?.params[3]).toBe("translator");
	});

	test("member updates can condition writes on the previously authorized scope", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [{
			workspace_id: "workspace-1",
			user_id: "member-1",
			role: "viewer",
			scope: JSON.stringify({ projectIds: ["project-1"] }),
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		await store.updateMember({
			workspaceId: "workspace-1",
			userId: "member-1",
			role: "editor",
			scope: { projectIds: ["project-1"], languages: ["th"] },
			expectedScope: { projectIds: ["project-1"] },
			actorUserId: "admin-1",
		});

		const update = client.queries.find((entry) => entry.query.includes("UPDATE workspace_members") && entry.query.includes("SET role = $3"));
		expect(update?.query).toContain("scope = $6::jsonb");
		expect(update?.params[4]).toEqual({ projectIds: ["project-1"], languages: ["th"] });
		expect(update?.params[5]).toEqual({ projectIds: ["project-1"] });
	});

	// ── P1 #3: a ROLE change must NOT silently wipe a member's fine-grained scope. ──
	// Regression guard: changing only the access role (no scope in the patch) must
	// preserve EVERY custom scope dimension. Dropping the scope would silently
	// OVER-privilege the member (a chapter/language-scoped translator promoted to a
	// workspace-wide editor). Scope can ONLY change when the caller passes an
	// explicit new scope (explicit reconciliation), proven by the second assertion.
	test("role change preserves a multi-dimension custom scope; only an explicit scope reconciles it", async () => {
		const customScope = { projectIds: ["project-1"], chapterIds: ["ch-7"], languages: ["th", "ja"], taskTypes: ["translate"] };
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [{
			workspace_id: "workspace-1",
			user_id: "member-scoped",
			role: "viewer",
			member_studio_role: "translator",
			scope: JSON.stringify(customScope),
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		// Promote viewer → editor WITHOUT a scope in the patch.
		const promoted = await store.updateMember({
			workspaceId: "workspace-1",
			userId: "member-scoped",
			role: "editor",
			actorUserId: "owner-1",
		});
		// Role changed, custom scope fully PRESERVED, operational role kept.
		expect(promoted.role).toBe("editor");
		expect(promoted.scope).toEqual(customScope);
		expect(promoted.memberStudioRole).toBe("translator");
		// The SQL passed NULL scope so COALESCE keeps the stored value — never a wipe.
		const promoteQuery = client.queries.find((entry) => entry.query.includes("UPDATE workspace_members") && entry.query.includes("SET role = $3"));
		expect(promoteQuery?.query).toContain("COALESCE($5::jsonb, scope)");
		expect(promoteQuery?.params[4]).toBeNull();

		// Reset the captured queries, then change the scope EXPLICITLY (reconciliation).
		client.queries.length = 0;
		client.memberRows = [{
			workspace_id: "workspace-1",
			user_id: "member-scoped",
			role: "editor",
			member_studio_role: "translator",
			scope: JSON.stringify(customScope),
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const narrowed = { projectIds: ["project-1"], languages: ["th"] };
		const reconciled = await store.updateMember({
			workspaceId: "workspace-1",
			userId: "member-scoped",
			role: "editor",
			scope: narrowed,
			actorUserId: "owner-1",
		});
		expect(reconciled.scope).toEqual(narrowed);
		const reconcileQuery = client.queries.find((entry) => entry.query.includes("UPDATE workspace_members") && entry.query.includes("SET role = $3"));
		expect(reconcileQuery?.params[4]).toEqual(narrowed);
	});

	test("accepts pending invites only with matching email and token", async () => {
		const token = "test-token-with-enough-length";
		const client = new FakeWorkspaceSqlClient();
		client.inviteRows = [{
			invite_id: "invite-1",
			workspace_id: "workspace-1",
			email: "member@example.com",
			role: "viewer",
			scope: JSON.stringify({ projectIds: ["project-1"] }),
			token_hash: hashInviteToken(token),
			status: "pending",
			invited_by_user_id: "owner-1",
			expires_at: "2026-05-29T02:00:00.000Z",
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		const member = await store.acceptInvite({
			inviteId: "invite-1",
			inviteToken: token,
			userId: "member-1",
			email: "member@example.com",
			now: new Date("2026-05-28T03:00:00.000Z"),
		});

		expect(member).toMatchObject({
			workspaceId: "workspace-1",
			userId: "member-1",
			role: "viewer",
			scope: { projectIds: ["project-1"] },
		});
		expect(client.queries.some((entry) => entry.query.includes("UPDATE workspace_invites") && entry.params[1] === "member-1")).toBe(true);
	});

	test("accepting an invite never downgrades an existing owner membership", async () => {
		const token = "test-token-with-enough-length";
		const client = new FakeWorkspaceSqlClient();
		client.inviteRows = [{
			invite_id: "invite-1",
			workspace_id: "workspace-1",
			email: "owner@example.com",
			role: "viewer",
			scope: JSON.stringify({ projectIds: ["project-1"] }),
			token_hash: hashInviteToken(token),
			status: "pending",
			invited_by_user_id: "admin-1",
			expires_at: "2026-05-29T02:00:00.000Z",
			created_at: "2026-05-28T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		client.conflictMemberRow = {
			workspace_id: "workspace-1",
			user_id: "owner-1",
			role: "owner",
			scope: JSON.stringify({}),
			created_at: "2026-05-27T02:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		};
		const store = new PostgresWorkspaceAccessStore(client);

		const member = await store.acceptInvite({
			inviteId: "invite-1",
			inviteToken: token,
			userId: "owner-1",
			email: "owner@example.com",
			now: new Date("2026-05-28T03:00:00.000Z"),
		});

		expect(member.role).toBe("owner");
		const upsert = client.queries.find((entry) => entry.query.includes("INSERT INTO workspace_members") && entry.query.includes("ON CONFLICT"));
		expect(upsert?.query).toContain("CASE WHEN workspace_members.role = 'owner'");
	});

	test("expired invite acceptance commits the expired status before returning an error", async () => {
		const token = "test-token-with-enough-length";
		const client = new FakeWorkspaceSqlClient();
		client.inviteRows = [{
			invite_id: "invite-1",
			workspace_id: "workspace-1",
			email: "member@example.com",
			role: "viewer",
			scope: JSON.stringify({ projectIds: ["project-1"] }),
			token_hash: hashInviteToken(token),
			status: "pending",
			invited_by_user_id: "owner-1",
			expires_at: "2026-05-28T02:00:00.000Z",
			created_at: "2026-05-28T01:00:00.000Z",
			updated_at: "2026-05-28T01:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		await expect(store.acceptInvite({
			inviteId: "invite-1",
			inviteToken: token,
			userId: "member-1",
			email: "member@example.com",
			now: new Date("2026-05-28T03:00:00.000Z"),
		})).rejects.toThrow("expired");

		expect(client.queries.some((entry) => entry.query.includes("SET status = 'expired'"))).toBe(true);
		expect(client.commitCount).toBe(1);
		expect(client.rollbackCount).toBe(0);
	});

	test("inferScopedTaskType returns an allowed task type for taskTypes-scoped members and undefined otherwise", () => {
		// Drives the lock-acquire / work-state transition access check: a scoped
		// contributor must surface one of their own task types so the project-wide
		// taskTypes guard doesn't reject them before they can touch assigned work.
		expect(inferScopedTaskType({ taskTypes: ["translate"] })).toBe("translate");
		expect(inferScopedTaskType({ taskTypes: ["clean", "typeset"] })).toBe("clean");
		// Unrestricted members get undefined (the check stays project-wide-safe).
		expect(inferScopedTaskType({})).toBeUndefined();
		expect(inferScopedTaskType(undefined)).toBeUndefined();
		expect(inferScopedTaskType({ taskTypes: [] })).toBeUndefined();
		// The inferred value is always a member of the scope, so workspaceScopeAllows
		// passes for the inferred task type but rejects a foreign one.
		const scope: WorkspaceScope = { taskTypes: ["translate"] };
		const inferred = inferScopedTaskType(scope);
		expect(workspaceScopeAllows(scope, { taskType: inferred })).toBe(true);
		expect(workspaceScopeAllows(scope, { taskType: "qc" })).toBe(false);
	});
});

describe("PostgresWorkspaceAccessStore.countAdmins", () => {
	test("runs a single targeted COUNT aggregate (no full roster load)", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [
			{ workspace_id: "ws-1", user_id: "u-owner", role: "owner", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
			{ workspace_id: "ws-1", user_id: "u-admin", role: "admin", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
			{ workspace_id: "ws-1", user_id: "u-editor", role: "editor", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
		];
		const store = new PostgresWorkspaceAccessStore(client);

		const count = await store.countAdmins("ws-1");

		expect(count).toBe(2);
		// Exactly one query, and it is the bounded COUNT — never a roster SELECT *.
		expect(client.queries).toHaveLength(1);
		const q = client.queries[0]!.query;
		expect(q).toContain("COUNT(*)");
		expect(q).toContain("role IN ('owner', 'admin')");
		expect(q).toContain("disabled_at IS NULL");
		expect(q).not.toContain("ORDER BY");
		expect(client.queries[0]!.params).toEqual(["ws-1"]);
	});
});

describe("PostgresWorkspaceAccessStore.listMentionCandidates", () => {
	// A POSTGRES-backed loader that MUST NOT be called in the all-Postgres config
	// (the JOIN supplies name/email). `kind: "postgres"` opts into the JOIN fast
	// path; if the per-member load loop ever comes back, `loads` records it and the
	// test fails.
	const recordingLoader = (kind: "file" | "postgres" = "postgres") => {
		const loads: string[] = [];
		return {
			kind,
			loads,
			load: async (userId: string) => {
				loads.push(userId);
				return { name: "should-not-be-used", email: "nope@example.com" };
			},
		};
	};

	test("resolves the active roster with name/email in a SINGLE JOIN query (no per-member load N+1)", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [
			{ workspace_id: "ws-1", user_id: "u-owner", role: "owner", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
			{ workspace_id: "ws-1", user_id: "u-editor", role: "editor", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
			// Disabled member of ws-1 → excluded (same filter as listMembers).
			{ workspace_id: "ws-1", user_id: "u-gone", role: "viewer", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z", disabled_at: "2026-05-02T00:00:00.000Z" },
			// Member of a DIFFERENT workspace → must never leak (tenant scoping).
			{ workspace_id: "ws-other", user_id: "u-outsider", role: "owner", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
		];
		client.authUserRows.set("u-owner", { name: "Ada Owner", email: "ada@example.com" });
		client.authUserRows.set("u-editor", { name: "Bob Editor", email: "bob@example.com" });
		client.authUserRows.set("u-outsider", { name: "Eve Outsider", email: "eve@example.com" });
		const store = new PostgresWorkspaceAccessStore(client);
		const loader = recordingLoader();

		const candidates = await store.listMentionCandidates("ws-1", loader);

		// Same MentionCandidate shape resolveCommentMentions consumes: { userId, name?, email? }.
		expect(candidates).toEqual([
			{ userId: "u-owner", name: "Ada Owner", email: "ada@example.com" },
			{ userId: "u-editor", name: "Bob Editor", email: "bob@example.com" },
		]);
		// Tenant scoping + disabled filter held: no outsider, no disabled member.
		expect(candidates.map((c) => c.userId)).not.toContain("u-outsider");
		expect(candidates.map((c) => c.userId)).not.toContain("u-gone");

		// The whole point of the fix: ONE round-trip, a JOIN to auth_users — not
		// listMembers + a load() per member (the old 2N-query N+1).
		expect(client.queries).toHaveLength(1);
		const q = client.queries[0]!.query;
		expect(q).toContain("JOIN auth_users");
		expect(q).toContain("m.disabled_at IS NULL");
		expect(client.queries[0]!.params).toEqual(["ws-1"]);
		// The per-member auth loader is NEVER touched in Postgres mode.
		expect(loader.loads).toEqual([]);
	});

	test("drops a member whose auth_users row is missing (INNER JOIN), never breaking resolution", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [
			{ workspace_id: "ws-1", user_id: "u-owner", role: "owner", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
			{ workspace_id: "ws-1", user_id: "u-orphan", role: "editor", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
		];
		// Only the owner has an auth row; the orphan's auth row is gone.
		client.authUserRows.set("u-owner", { name: "Ada Owner", email: "ada@example.com" });
		const store = new PostgresWorkspaceAccessStore(client);

		const candidates = await store.listMentionCandidates("ws-1", recordingLoader());

		expect(candidates).toEqual([{ userId: "u-owner", name: "Ada Owner", email: "ada@example.com" }]);
		expect(client.queries).toHaveLength(1);
	});

	test("all-Postgres config resolves the WHOLE roster in exactly ONE JOIN query", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [
			{ workspace_id: "ws-1", user_id: "u-owner", role: "owner", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
			{ workspace_id: "ws-1", user_id: "u-editor", role: "editor", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
		];
		client.authUserRows.set("u-owner", { name: "Ada Owner", email: "ada@example.com" });
		client.authUserRows.set("u-editor", { name: "Bob Editor", email: "bob@example.com" });
		const store = new PostgresWorkspaceAccessStore(client);
		const loader = recordingLoader("postgres");

		const candidates = await store.listMentionCandidates("ws-1", loader);

		expect(candidates).toEqual([
			{ userId: "u-owner", name: "Ada Owner", email: "ada@example.com" },
			{ userId: "u-editor", name: "Bob Editor", email: "bob@example.com" },
		]);
		// Exactly ONE query, and it is the JOIN — no listMembers + per-member load.
		expect(client.queries).toHaveLength(1);
		expect(client.queries[0]!.query).toContain("JOIN auth_users");
		expect(loader.loads).toEqual([]);
	});

	test("MIXED config (Postgres workspace store + FILE auth loader) resolves via the loader, NOT the JOIN", async () => {
		// The P2 regression: DATABASE_URL set but AUTH_USER_STORE=file (the
		// docker-compose default) → Postgres workspace store, but users live ONLY in
		// the FILE auth store, so its `auth_users` table is EMPTY. With the JOIN fast
		// path the INNER JOIN matched zero rows and mentions silently stopped
		// resolving. A `kind: "file"` loader must instead drive the per-member
		// fallback so candidates come from where the auth rows actually are.
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [
			{ workspace_id: "ws-1", user_id: "u-owner", role: "owner", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-03T00:00:00.000Z" },
			{ workspace_id: "ws-1", user_id: "u-editor", role: "editor", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-02T00:00:00.000Z" },
			// Disabled member of ws-1 → excluded by the listMembers active filter.
			{ workspace_id: "ws-1", user_id: "u-gone", role: "viewer", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z", disabled_at: "2026-05-02T00:00:00.000Z" },
			// Member of a DIFFERENT workspace → must never leak (tenant scoping).
			{ workspace_id: "ws-other", user_id: "u-outsider", role: "owner", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
		];
		// CRUCIAL: NO rows in client.authUserRows — the Postgres `auth_users` table is
		// empty in this config, so the JOIN (if taken) would return nothing.
		const store = new PostgresWorkspaceAccessStore(client);

		// The FILE auth loader holds the real profiles. u-orphan-style miss for the
		// editor proves a missing auth row is KEPT (undefined name/email), not dropped.
		const loaded: string[] = [];
		const fileLoader = {
			kind: "file" as const,
			load: async (userId: string) => {
				loaded.push(userId);
				if (userId === "u-owner") return { name: "Ada Owner", email: "ada@example.com" };
				return null; // u-editor's profile is missing → kept with undefined fields.
			},
		};

		const candidates = await store.listMentionCandidates("ws-1", fileLoader);

		// Both active ws-1 members are present; the missing one is KEPT with undefined
		// name/email (NOT dropped — preserves the pre-JOIN behaviour for this config).
		expect(candidates).toEqual([
			{ userId: "u-owner", name: "Ada Owner", email: "ada@example.com" },
			{ userId: "u-editor", name: undefined, email: undefined },
		]);
		// Tenant scoping + disabled filter held even via the fallback path.
		expect(candidates.map((c) => c.userId)).not.toContain("u-outsider");
		expect(candidates.map((c) => c.userId)).not.toContain("u-gone");
		// The JOIN was NOT used — only the roster query ran, then per-member loads.
		expect(client.queries).toHaveLength(1);
		expect(client.queries[0]!.query).not.toContain("JOIN auth_users");
		expect(client.queries[0]!.query).toContain("FROM workspace_members");
		expect(loaded.sort()).toEqual(["u-editor", "u-owner"]);
	});

	test("an UNKNOWN-kind loader (no kind) also takes the safe per-member fallback", async () => {
		// Defensive: a loader that doesn't declare `kind` must not be assumed
		// Postgres-backed (that's what caused the silent drop). It falls back too.
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [
			{ workspace_id: "ws-1", user_id: "u-owner", role: "owner", scope: "{}", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" },
		];
		const store = new PostgresWorkspaceAccessStore(client);
		const loaded: string[] = [];
		const loader = {
			load: async (userId: string) => {
				loaded.push(userId);
				return { name: "Ada", email: "ada@example.com" };
			},
		};

		const candidates = await store.listMentionCandidates("ws-1", loader);

		expect(candidates).toEqual([{ userId: "u-owner", name: "Ada", email: "ada@example.com" }]);
		expect(client.queries[0]!.query).not.toContain("JOIN auth_users");
		expect(loaded).toEqual(["u-owner"]);
	});
});

describe("FileWorkspaceAccessStore (file-mode fallback)", () => {

	test("a user whose ONLY owner row is synthetic still gets a real personal workspace provisioned", async () => {
		const store = new FileWorkspaceAccessStore();
		// Simulate legacy state: catalog minted personal:<uid> ownership only.
		await store.createWorkspace({ workspaceId: "personal:u-legacy", name: "junk", ownerUserId: "u-legacy" });
		await store.createWorkspace({ workspaceId: "project:p-legacy", name: "junk project", ownerUserId: "u-legacy" });
		const listed = await store.listUserWorkspaces("u-legacy");
		const page = await store.listUserWorkspacePage("u-legacy");
		// Provisioning ignored the synthetic row and minted a REAL workspace.
		expect(listed).toHaveLength(1);
		expect(/^(?:personal|project):/.test(listed[0]!.workspaceId)).toBe(false);
		expect(page.workspaces.map((workspace) => workspace.workspaceId)).toEqual([listed[0]!.workspaceId]);
	});

	test("synthetic catalog ids (personal:/project:) never surface as user workspaces", async () => {
		const store = new FileWorkspaceAccessStore();
		const real = (await store.listUserWorkspaces("u-1"))[0]!;
		// Simulate the catalog's bookkeeping rows leaking membership for the user.
		await store.createWorkspace({ workspaceId: "personal:u-1", name: "junk personal", ownerUserId: "u-1" });
		await store.createWorkspace({ workspaceId: "project:p-9", name: "junk project", ownerUserId: "u-1" });
		const listed = await store.listUserWorkspaces("u-1");
		expect(listed.map((w) => w.workspaceId)).toEqual([real.workspaceId]);
		const page = await store.listUserWorkspacePage("u-1", {});
		expect(page.workspaces.every((w) => !/^(?:personal|project):/.test(w.workspaceId))).toBe(true);
	});
	test("countAdmins counts active owner+admin members only", async () => {
		const store = new FileWorkspaceAccessStore();
		const [ws] = await store.listUserWorkspaces("owner-count");
		const workspaceId = ws!.workspaceId;
		// Owner auto-provisioned → 1 admin.
		expect(await store.countAdmins(workspaceId)).toBe(1);
		// A non-existent workspace has zero admins.
		expect(await store.countAdmins("missing")).toBe(0);
	});

	test("erasePiiForUser deletes the subject's memberships and anonymizes invites to their email (idempotent)", async () => {
		const store = new FileWorkspaceAccessStore();
		// Auto-provision a personal workspace → 1 membership for user-erase.
		await store.listUserWorkspaces("user-erase");
		// A second user is untouched.
		await store.listUserWorkspaces("user-keep");
		// Seed a clear-text invite addressed to the subject's email (file-mode has no
		// createInvite, so inject directly into the store's private invite array).
		const invites = (store as unknown as { invites: Array<Record<string, unknown>> }).invites;
		invites.push({ inviteId: "inv-1", workspaceId: "ws-x", email: "victim@example.com", role: "editor", scope: {}, status: "pending", invitedByUserId: "boss", expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", tokenHash: "h" });
		invites.push({ inviteId: "inv-2", workspaceId: "ws-x", email: "someone-else@example.com", role: "editor", scope: {}, status: "pending", invitedByUserId: "boss", expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", tokenHash: "h" });

		const members = (store as unknown as { members: Array<{ userId: string }> }).members;
		expect(members.filter((m) => m.userId === "user-erase").length).toBe(1);

		const result = await store.erasePiiForUser("user-erase", "victim@example.com");
		expect(result.membershipsRemoved).toBe(1);
		expect(result.invitesAnonymized).toBe(1);

		// Membership gone; other user's membership intact.
		expect(members.filter((m) => m.userId === "user-erase").length).toBe(0);
		expect(members.filter((m) => m.userId === "user-keep").length).toBe(1);
		// Invite email anonymized; the unrelated invite is untouched.
		expect(invites.find((i) => i.inviteId === "inv-1")?.email).toBe("purged+user-erase@redacted.invalid");
		expect(invites.find((i) => i.inviteId === "inv-2")?.email).toBe("someone-else@example.com");

		// Idempotent: re-running changes nothing.
		const again = await store.erasePiiForUser("user-erase", "victim@example.com");
		expect(again.membershipsRemoved).toBe(0);
		expect(again.invitesAnonymized).toBe(0);
	});

	test("auto-provisions a personal owner workspace on first list (no 503 path)", async () => {
		const store = new FileWorkspaceAccessStore(); // in-memory (no persist path)
		const page = await store.listUserWorkspacePage("user-1");
		expect(page.workspaces).toHaveLength(1);
		const workspace = page.workspaces[0]!;
		expect(workspace.memberRole).toBe("owner");
		expect(workspace.memberStudioRole).toBe("owner");
		expect(workspace.name).toBe("My Workspace");
		// The owner can read/manage their auto-provisioned workspace, so the
		// dashboard/library/project-create flow has a real workspace context.
		const member = await store.requirePermission(workspace.workspaceId, "user-1", "manage_projects");
		expect(member.role).toBe("owner");
	});

	test("is idempotent — listing again returns the same single workspace", async () => {
		const store = new FileWorkspaceAccessStore();
		const first = await store.listUserWorkspaces("user-2");
		const second = await store.listUserWorkspaces("user-2");
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(second[0]!.workspaceId).toBe(first[0]!.workspaceId);
	});

	test("isolates workspaces per user", async () => {
		const store = new FileWorkspaceAccessStore();
		const a = await store.listUserWorkspaces("user-a");
		const b = await store.listUserWorkspaces("user-b");
		expect(a[0]!.workspaceId).not.toBe(b[0]!.workspaceId);
		// user-b cannot read user-a's workspace.
		await expect(store.requirePermission(a[0]!.workspaceId, "user-b", "read_workspace"))
			.rejects.toThrow(WorkspaceAccessError);
	});

	test("invites are unavailable in file-mode (Postgres-only feature)", async () => {
		const store = new FileWorkspaceAccessStore();
		await expect(store.createInvite()).rejects.toThrow(WorkspaceAccessError);
	});

	test("listUserWorkspacePage honours limit and pages via cursor", async () => {
		const store = new FileWorkspaceAccessStore();
		// One personal workspace + two created workspaces = 3 total for this owner.
		await store.listUserWorkspaces("pager");
		await store.createWorkspace({ workspaceId: "ws-extra-1", name: "Extra 1", ownerUserId: "pager" });
		await store.createWorkspace({ workspaceId: "ws-extra-2", name: "Extra 2", ownerUserId: "pager" });

		const first = await store.listUserWorkspacePage("pager", { limit: 1 });
		expect(first.workspaces).toHaveLength(1);
		expect(first.nextCursor).toBeDefined();

		const seen = new Set(first.workspaces.map((w) => w.workspaceId));
		let cursor = first.nextCursor;
		let guard = 0;
		while (cursor && guard < 10) {
			const next = await store.listUserWorkspacePage("pager", { limit: 1, cursor });
			expect(next.workspaces.length).toBeLessThanOrEqual(1);
			for (const w of next.workspaces) seen.add(w.workspaceId);
			cursor = next.nextCursor;
			guard += 1;
		}
		// Every workspace surfaces exactly once across the paged walk.
		expect(seen.size).toBe(3);
	});

	test("listAllWorkspacePage returns EVERY registry workspace across users (admin browser source)", async () => {
		const store = new FileWorkspaceAccessStore();
		// Two distinct owners → two personal workspaces, plus one explicitly created
		// workspace. The admin browser must see ALL of them regardless of who owns
		// them — this is the registry source the admin /workspaces list drives from.
		await store.listUserWorkspaces("alice");
		await store.listUserWorkspaces("bob");
		await store.createWorkspace({ workspaceId: "ws-team", name: "Team Studio", ownerUserId: "alice" });

		const page = await store.listAllWorkspacePage();
		expect(page.total).toBe(3);
		expect(page.workspaces).toHaveLength(3);
		expect(page.workspaces.map((w) => w.workspaceId)).toContain("ws-team");
	});

	test("listAllWorkspacePage filters by name/id search and paginates via cursor", async () => {
		const store = new FileWorkspaceAccessStore();
		await store.createWorkspace({ workspaceId: "ws-alpha", name: "Alpha Studio", ownerUserId: "u1" });
		await store.createWorkspace({ workspaceId: "ws-beta", name: "Beta Studio", ownerUserId: "u2" });
		await store.createWorkspace({ workspaceId: "ws-gamma", name: "Gamma Lab", ownerUserId: "u3" });

		// Search matches name (case-insensitive substring).
		const searched = await store.listAllWorkspacePage({ search: "studio" });
		expect(searched.total).toBe(2);
		expect(new Set(searched.workspaces.map((w) => w.workspaceId))).toEqual(new Set(["ws-alpha", "ws-beta"]));

		// Keyset pagination walks every matching row exactly once.
		const seen = new Set<string>();
		let cursor: string | undefined;
		let guard = 0;
		do {
			const pageN: Awaited<ReturnType<typeof store.listAllWorkspacePage>> = await store.listAllWorkspacePage({ search: "studio", limit: 1, cursor });
			expect(pageN.workspaces.length).toBeLessThanOrEqual(1);
			// Total is the honest filtered count on every page, never the page length.
			expect(pageN.total).toBe(2);
			for (const w of pageN.workspaces) seen.add(w.workspaceId);
			cursor = pageN.nextCursor;
			guard += 1;
		} while (cursor && guard < 10);
		expect(seen).toEqual(new Set(["ws-alpha", "ws-beta"]));
	});

	test("listMemberPage applies the actor scope filter (no broader enumeration)", async () => {
		const store = new FileWorkspaceAccessStore();
		const [ws] = await store.listUserWorkspaces("owner-scope");
		const workspaceId = ws!.workspaceId;
		// Seed two scoped collaborators in different projects via acceptInvite is
		// Postgres-only, so drive the in-memory members directly through updateMember
		// after seeding base rows. We instead exercise the filter on the records the
		// store already holds: the owner has empty scope and is always covered; a
		// project-A-scoped actor must not see a project-B-only member.
		const all = await store.listMemberPage(workspaceId);
		expect(all.members.some((m) => m.userId === "owner-scope")).toBe(true);

		// A scoped actor covering only project "p-a" still sees the empty-scope owner
		// (empty scope is covered by any actor) — but the filter is applied, proving
		// scopeCoveredBy is honoured rather than ignored.
		const scoped = await store.listMemberPage(workspaceId, { scopeCoveredBy: { projectIds: ["p-a"] } });
		// Owner has empty scope → NOT covered by a project-scoped actor, so a scoped
		// manager does not enumerate the unrestricted owner.
		expect(scoped.members.some((m) => m.userId === "owner-scope")).toBe(false);
	});

	test("listAuditEventPage applies createdAfter/createdBefore bounds and limit", async () => {
		const store = new FileWorkspaceAccessStore();
		const workspaceId = "ws-audit";
		// Record three events; createdAt is set by the store at record time, so stamp
		// distinct times by recording with small waits.
		await store.recordAuditEvent({ workspaceId, actorUserId: "u", action: "a1", entityType: "t", entityId: "1" });
		await new Promise((r) => setTimeout(r, 5));
		const mid = new Date().toISOString();
		await new Promise((r) => setTimeout(r, 5));
		await store.recordAuditEvent({ workspaceId, actorUserId: "u", action: "a2", entityType: "t", entityId: "2" });

		const after = await store.listAuditEventPage(workspaceId, { createdAfter: mid });
		// Only the event recorded after `mid` survives the lower bound.
		expect(after.events.every((e) => e.createdAt >= mid)).toBe(true);
		expect(after.events.some((e) => e.action === "a2")).toBe(true);
		expect(after.events.some((e) => e.action === "a1")).toBe(false);

		const bounded = await store.listAuditEventPage(workspaceId, { limit: 1 });
		expect(bounded.events).toHaveLength(1);
		expect(bounded.nextCursor).toBeDefined();
	});

	test("listMentionCandidates loops over the active roster, resolving name/email via the auth loader", async () => {
		const store = new FileWorkspaceAccessStore();
		// Auto-provisions an owner membership for the workspace.
		const [ws] = await store.listUserWorkspaces("u-owner");
		const workspaceId = ws!.workspaceId;
		// A second active member of the same workspace (file-mode has no createInvite,
		// so inject directly into the store's private member array — mirrors the
		// erasePiiForUser test above).
		(store as unknown as { members: Array<Record<string, unknown>> }).members.push({
			workspaceId, userId: "u-editor", role: "editor", scope: {},
			createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z",
		});

		const profiles: Record<string, { name: string; email: string }> = {
			"u-owner": { name: "Ada Owner", email: "ada@example.com" },
			"u-editor": { name: "Bob Editor", email: "bob@example.com" },
		};
		const loads: string[] = [];
		const loader = {
			load: async (userId: string) => {
				loads.push(userId);
				return profiles[userId] ?? null;
			},
		};

		const candidates = await store.listMentionCandidates(workspaceId, loader);

		// Every active member resolved with name/email (file mode = local reads, no DB).
		expect(candidates).toContainEqual({ userId: "u-owner", name: "Ada Owner", email: "ada@example.com" });
		expect(candidates).toContainEqual({ userId: "u-editor", name: "Bob Editor", email: "bob@example.com" });
		expect(candidates).toHaveLength(2);
		// One load per active member (file mode has no JOIN to collapse onto).
		expect(loads.sort()).toEqual(["u-editor", "u-owner"]);
	});

	test("listMentionCandidates tolerates a missing/failed auth row (best-effort, undefined name/email)", async () => {
		const store = new FileWorkspaceAccessStore();
		const [ws] = await store.listUserWorkspaces("u-owner");
		const workspaceId = ws!.workspaceId;

		// A loader that resolves the owner but THROWS for everyone else — mirrors the
		// prior `.catch(() => null)` resilience: a broken load must not break resolution.
		const loader = {
			load: async (userId: string) => {
				if (userId === "u-owner") return { name: "Ada", email: "ada@example.com" };
				throw new Error("auth store unavailable");
			},
		};
		(store as unknown as { members: Array<Record<string, unknown>> }).members.push({
			workspaceId, userId: "u-broken", role: "viewer", scope: {},
			createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z",
		});

		const candidates = await store.listMentionCandidates(workspaceId, loader);

		expect(candidates).toContainEqual({ userId: "u-owner", name: "Ada", email: "ada@example.com" });
		// The member whose load threw is still present, just without name/email.
		expect(candidates).toContainEqual({ userId: "u-broken", name: undefined, email: undefined });
	});

	test("finish demotes to a free viewer (keeps scope, stashes prior role); reopen restores it", async () => {
		const store = new FileWorkspaceAccessStore();
		const [ws] = await store.listUserWorkspaces("u-owner");
		const workspaceId = ws!.workspaceId;
		(store as unknown as { members: Array<Record<string, unknown>> }).members.push({
			workspaceId, userId: "u-tl", role: "editor", memberStudioRole: "team_lead", scope: { projectIds: ["p1"] },
			createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z",
		});

		const finished = await store.finishMember({ workspaceId, userId: "u-tl", actorUserId: "u-owner" });
		expect(finished.role).toBe("viewer");
		expect(finished.memberStudioRole).toBe("guest");
		// Scope is preserved so the finished member still SEES their work.
		expect(finished.scope).toEqual({ projectIds: ["p1"] });
		expect(finished.finishedFrom).toMatchObject({ role: "editor", memberStudioRole: "team_lead" });

		// Idempotent: finishing again keeps the FIRST stash (still editor/team_lead).
		const again = await store.finishMember({ workspaceId, userId: "u-tl", actorUserId: "u-owner" });
		expect(again.finishedFrom).toMatchObject({ role: "editor", memberStudioRole: "team_lead" });

		const reopened = await store.reopenMember({ workspaceId, userId: "u-tl", actorUserId: "u-owner" });
		expect(reopened.role).toBe("editor");
		expect(reopened.memberStudioRole).toBe("team_lead");
		expect(reopened.scope).toEqual({ projectIds: ["p1"] });
		expect(reopened.finishedFrom).toBeUndefined();

		// Reopen on a non-finished member is a no-op (idempotent).
		const noop = await store.reopenMember({ workspaceId, userId: "u-tl", actorUserId: "u-owner" });
		expect(noop.role).toBe("editor");
	});

	test("finish rejects the owner", async () => {
		const store = new FileWorkspaceAccessStore();
		const [ws] = await store.listUserWorkspaces("u-owner");
		await expect(store.finishMember({ workspaceId: ws!.workspaceId, userId: "u-owner", actorUserId: "u-owner" }))
			.rejects.toMatchObject({ code: "owner_finish_rejected" });
	});
});

// ── workspace FREEZE enforcement (refund/chargeback suspension) ─────────────────
describe("workspace freeze enforcement", () => {
	test("FileWorkspaceAccessStore: a frozen workspace blocks EVERY edit (even the owner) but allows reads", async () => {
		const store = new FileWorkspaceAccessStore();
		const [workspace] = await store.listUserWorkspaces("owner-frozen");

		// Not frozen yet → owner can mutate.
		await store.requirePermission(workspace!.workspaceId, "owner-frozen", "manage_projects");

		// Freeze it (as a refund would).
		const frozen = await store.setWorkspaceSuspension({ workspaceId: workspace!.workspaceId, suspend: true, reason: "payment_refund" });
		expect(frozen.suspendedAt).toBeTruthy();
		expect(frozen.suspendedReason).toBe("payment_refund");

		// Reads still pass.
		const member = await store.requirePermission(workspace!.workspaceId, "owner-frozen", "read_workspace");
		expect(member.role).toBe("owner");
		await store.requirePermission(workspace!.workspaceId, "owner-frozen", "read_project");

		// Mutations are blocked with 403 workspace_suspended — for the OWNER too.
		for (const perm of ["manage_projects", "update_project", "generate_ai", "update_workspace", "manage_members"] as const) {
			await expect(store.requirePermission(workspace!.workspaceId, "owner-frozen", perm))
				.rejects.toMatchObject({ status: 403, code: "workspace_suspended" });
		}
	});

	test("FileWorkspaceAccessStore: admin unfreeze restores edit access (escape hatch)", async () => {
		const store = new FileWorkspaceAccessStore();
		const [workspace] = await store.listUserWorkspaces("owner-unfreeze");
		await store.setWorkspaceSuspension({ workspaceId: workspace!.workspaceId, suspend: true, reason: "chargeback" });
		await expect(store.requirePermission(workspace!.workspaceId, "owner-unfreeze", "manage_projects"))
			.rejects.toMatchObject({ code: "workspace_suspended" });

		const cleared = await store.setWorkspaceSuspension({ workspaceId: workspace!.workspaceId, suspend: false });
		expect(cleared.suspendedAt).toBeUndefined();
		// Edits work again.
		await store.requirePermission(workspace!.workspaceId, "owner-unfreeze", "manage_projects");
	});

	test("FileWorkspaceAccessStore: freeze is idempotent (keeps the original reason)", async () => {
		const store = new FileWorkspaceAccessStore();
		const [workspace] = await store.listUserWorkspaces("owner-idem");
		const first = await store.setWorkspaceSuspension({ workspaceId: workspace!.workspaceId, suspend: true, reason: "chargeback" });
		const second = await store.setWorkspaceSuspension({ workspaceId: workspace!.workspaceId, suspend: true, reason: "payment_refund" });
		expect(second.suspendedReason).toBe("chargeback");
		expect(second.suspendedAt).toBe(first.suspendedAt);
	});

	test("PostgresWorkspaceAccessStore: a frozen workspace blocks a MEMBER edit (403) but allows read", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = [{
			workspace_id: "ws-frozen",
			user_id: "member-x",
			role: "editor",
			member_studio_role: "translator",
			scope: "{}",
			created_at: "2026-05-28T01:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresWorkspaceAccessStore(client);

		client.suspendedAt = null;
		// Not frozen → editor can update_project.
		await store.requirePermission("ws-frozen", "member-x", "update_project");

		client.suspendedAt = "2026-06-07T00:00:00.000Z";
		// Read passes (no suspension lookup, no block).
		await store.requirePermission("ws-frozen", "member-x", "read_project");
		await store.requirePermission("ws-frozen", "member-x", "read_workspace");
		// Mutations blocked with 403 workspace_suspended.
		await expect(store.requirePermission("ws-frozen", "member-x", "update_project"))
			.rejects.toMatchObject({ status: 403, code: "workspace_suspended" });
		await expect(store.requirePermission("ws-frozen", "member-x", "generate_ai"))
			.rejects.toMatchObject({ status: 403, code: "workspace_suspended" });
	});

	test("PostgresWorkspaceAccessStore: a non-member still gets 404 (not a suspension leak)", async () => {
		const client = new FakeWorkspaceSqlClient();
		client.memberRows = []; // no membership
		client.suspendedAt = "2026-06-07T00:00:00.000Z";
		const store = new PostgresWorkspaceAccessStore(client);
		await expect(store.requirePermission("ws-frozen", "stranger", "update_project"))
			.rejects.toMatchObject({ status: 404, code: "workspace_not_found" });
	});
});
