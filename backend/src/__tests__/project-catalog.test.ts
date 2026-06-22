import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROJECT_TOMBSTONES_DIR_NAME, safePath } from "../utils/security.js";
import {
	FileProjectCatalogStore,
	InvalidProjectPageCursorError,
	InvalidProjectCommentCursorError,
	InvalidProjectReviewDecisionCursorError,
	InvalidProjectSummaryCursorError,
	InvalidProjectTaskCursorError,
	InvalidProjectVersionCursorError,
	isProjectAccessFullyDenied,
	mergeProjectPageSummaries,
	mergeProjectVersions,
	mergeProjectSummaries,
	paginateProjectComments,
	paginateProjectPages,
	paginateProjectReviewDecisions,
	paginateProjectSummaries,
	paginateProjectTasks,
	paginateProjectVersions,
	PostgresProjectCatalogStore,
	type ProjectCatalogSqlClient,
	type ProjectPageSummary,
	type ProjectSummary,
	type ProjectVersionMetadata,
} from "../services/project-catalog.js";
import { FileWorkspaceAccessStore } from "../services/workspace-access.js";
import type { WorkspaceMemberRecord } from "../services/workspace-access.js";
import type { PageReviewDecision, ProjectComment, ProjectState, WorkflowTask } from "../types/index.js";

class FakeCatalogSqlClient implements ProjectCatalogSqlClient {
	queries: Array<{ query: string; params: unknown[] }> = [];
	summaryRows: Array<Record<string, unknown>> = [];
	pageRows: Array<Record<string, unknown>> = [];
	taskRows: Array<Record<string, unknown>> = [];
	commentRows: Array<Record<string, unknown>> = [];
	reviewDecisionRows: Array<Record<string, unknown>> = [];
	versionRows: Array<Record<string, unknown>> = [];
	accessRows: Array<Record<string, unknown>> = [];
	workspacePlanRows: Array<Record<string, unknown>> = [];
	// Existing-id rows returned for deleteMissingRows' "SELECT <id> AS id FROM
	// <table>" probe, keyed by table name. Seed these to exercise the
	// complement-delete (which rows the prune actually removes).
	existingIdRows: Record<string, Array<{ id: string | number }>> = {};
	beginCount = 0;

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		// deleteMissingRows probes existing ids with "SELECT <col> AS id FROM <table>
		// WHERE project_id = $1" — answer before the broader "FROM <table>" branches.
		if (query.includes(" AS id FROM ")) {
			const match = query.match(/ AS id FROM (\w+)/);
			const table = match?.[1];
			return ((table && this.existingIdRows[table]) ?? []) as T[];
		}
		if (query.includes("INNER JOIN workspace_members")) {
			return this.accessRows as T[];
		}
		if (query.includes("workspace_billing_accounts")) {
			return this.workspacePlanRows as T[];
		}
		if (query.includes("FROM project_pages")) {
			return this.pageRows as T[];
		}
		if (query.includes("FROM project_tasks")) {
			return this.taskRows as T[];
		}
		if (query.includes("FROM project_comments")) {
			return this.commentRows as T[];
		}
		if (query.includes("FROM project_review_decisions")) {
			return this.reviewDecisionRows as T[];
		}
		if (query.includes("FROM projects")) {
			return this.summaryRows as T[];
		}
		if (query.includes("FROM project_versions")) {
			return this.versionRows as T[];
		}
		return [];
	}

	async begin<T>(fn: (transaction: ProjectCatalogSqlClient) => Promise<T>): Promise<T> {
		this.beginCount += 1;
		return fn(this);
	}
}

describe("project catalog", () => {
	test("upserts project metadata and collaboration rows without filesystem scans", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = createState();
		state.targetLangs = ["en", "th", "en"];

		await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

		expect(client.beginCount).toBe(1);
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO workspaces"))).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO workspace_members"))).toBe(true);
		// The prune probes existing ids for the complement-delete (nothing stale here,
		// so no DELETE is issued — only the bounded probe runs).
		expect(client.queries.some((entry) => entry.query.includes("page_index AS id FROM project_pages"))).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO project_pages"))).toBe(true);
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO project_tasks"))).toBe(true);
		const taskUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_tasks"));
		expect(taskUpsert?.query).toContain("ON CONFLICT (project_id, task_id)");
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO project_comments"))).toBe(true);
		const commentUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_comments"));
		expect(commentUpsert?.query).toContain("ON CONFLICT (project_id, comment_id)");
		// mentions (text[]) is built as ARRAY[$n,...]::text[] — one scalar bind per
		// element — so the lone comment's mentions ["user-2"] bind a single "user-2"
		// at column 8 (0-based) of the flat, row-major param list.
		expect(commentUpsert?.query).toContain("::text[]");
		expect(commentUpsert?.params[8]).toBe("user-2");
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO project_review_decisions"))).toBe(true);
		const decisionUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_review_decisions"));
		expect(decisionUpsert?.query).toContain("ON CONFLICT (project_id, review_decision_id)");
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO project_version_reviews"))).toBe(true);
		const versionReviewUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_version_reviews"));
		expect(versionReviewUpsert?.query).toContain("ON CONFLICT (project_id, version_review_id)");
		// version_review mentions ["user-2"] build ARRAY[$n]::text[]; the single
		// element "user-2" binds at column 7 (0-based) of the flat param list.
		expect(versionReviewUpsert?.query).toContain("::text[]");
		expect(versionReviewUpsert?.params[7]).toBe("user-2");

		const projectUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO projects"));
		expect(projectUpsert).toBeTruthy();
		expect(projectUpsert?.params[0]).toBe(state.projectId);
		expect(projectUpsert?.params[2]).toBe(state.userId);
		expect(projectUpsert?.params[4]).toBe("ja");
		expect(projectUpsert?.params[5]).toBe(state.targetLang);
		expect(projectUpsert?.query).toContain("target_locales");
		expect(projectUpsert?.query).toContain("ARRAY[$11,$12]::text[]");
		expect(projectUpsert?.params.slice(-2)).toEqual(["en", "th"]);
		const metadata = JSON.parse(String(projectUpsert?.params[6]));
		expect(metadata.pageCount).toBe(2);
		expect(metadata.textLayerCount).toBe(1);
		expect(metadata.taskCount).toBe(2);
		expect(metadata.openTaskCount).toBe(1);
		expect(metadata.openCommentCount).toBe(1);
		expect(metadata.sourceLang).toBe("ja");
		expect(metadata.targetLangs).toEqual(["en", "th"]);
		const currentState = JSON.parse(String(projectUpsert?.params[7]));
		expect(currentState).toEqual(expect.objectContaining({
			projectId: state.projectId,
			name: state.name,
			targetLang: "en",
			targetLangs: ["en", "th"],
			pages: expect.any(Array),
		}));
	});

	test("binds team projects to explicit workspaces without rewriting workspace ownership", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = { ...createState(), workspaceId: "workspace-team" };

		await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

		const workspaceUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO workspaces"));
		expect(workspaceUpsert?.params[0]).toBe("workspace-team");
		expect(workspaceUpsert?.params[4]).toBe(true);
		expect(workspaceUpsert?.query).toContain("CASE WHEN $5::boolean THEN workspaces.name ELSE EXCLUDED.name END");
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO workspace_members"))).toBe(false);
		const projectUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO projects"));
		expect(projectUpsert?.params[1]).toBe("workspace-team");
		expect(projectUpsert?.params[2]).toBeNull();
		const metadata = JSON.parse(String(projectUpsert?.params[6]));
		expect(metadata.workspaceId).toBe("workspace-team");
	});

	test("loads current project state from catalog rows", async () => {
		const client = new FakeCatalogSqlClient();
		const state = createState();
		client.summaryRows = [{ current_state: state }];
		const store = new PostgresProjectCatalogStore(client);

		await expect(store.getProjectState(state.projectId)).resolves.toEqual(state);
		expect(client.queries.at(-1)?.query).toContain("SELECT current_state");
		expect(client.queries.at(-1)?.params).toEqual([state.projectId]);
	});

	test("rejects malformed current project state rows", async () => {
		const client = new FakeCatalogSqlClient();
		client.summaryRows = [{ current_state: { projectId: "missing-required-fields" } }];
		const store = new PostgresProjectCatalogStore(client);

		await expect(store.getProjectState("missing-required-fields")).resolves.toBeNull();
	});

	test("getProjectTitlesByIds batches one title lookup (no current_state deserialize)", async () => {
		const client = new FakeCatalogSqlClient();
		client.summaryRows = [
			{ project_id: "p1", title: "Project One" },
			{ project_id: "p2", title: "Project Two" },
		];
		const store = new PostgresProjectCatalogStore(client);

		const titles = await store.getProjectTitlesByIds(["p1", "p2", "p3"]);
		expect(titles.get("p1")).toBe("Project One");
		expect(titles.get("p2")).toBe("Project Two");
		expect(titles.has("p3")).toBe(false); // absent row → omitted (caller falls back to id)

		// ONE positional IN query, ids bound as params, and it must NOT pull current_state.
		const q = client.queries.find((e) => e.query.includes("SELECT project_id, title"));
		expect(q?.query).toContain("project_id IN ($1, $2, $3)");
		expect(q?.params).toEqual(["p1", "p2", "p3"]);
		expect(q?.query).not.toContain("current_state");
	});

	test("resolves a project workspace billing plan by indexed project id", async () => {
		const client = new FakeCatalogSqlClient();
		client.workspacePlanRows = [{
			project_id: "project-1",
			workspace_id: "workspace-1",
			plan_id: "creator",
		}];
		const store = new PostgresProjectCatalogStore(client);

		await expect(store.getProjectWorkspacePlan("project-1")).resolves.toEqual({
			projectId: "project-1",
			workspaceId: "workspace-1",
			planId: "creator",
		});

		const lookup = client.queries.find((entry) => entry.query.includes("workspace_billing_accounts"));
		expect(lookup?.query).toContain("workspace_billing_accounts.status IN");
		expect(lookup?.query).toContain("WHERE projects.project_id = $1");
		expect(lookup?.params).toEqual(["project-1"]);
		// P1 (money): the active-billing join is ALSO gated on the dunning grace deadline,
		// so a grace-expired `active` account resolves to FREE on this read path.
		expect(lookup?.query).toContain("dunning_grace_until");
	});

	test("ignores workspace display plan when no active billing entitlement exists", async () => {
		const client = new FakeCatalogSqlClient();
		client.workspacePlanRows = [{
			project_id: "project-1",
			workspace_id: "workspace-1",
			plan_id: null,
		}];
		const store = new PostgresProjectCatalogStore(client);

		await expect(store.getProjectWorkspacePlan("project-1")).resolves.toBeNull();
		const lookup = client.queries.find((entry) => entry.query.includes("workspace_billing_accounts"));
		expect(lookup?.query).not.toContain("workspaces.plan_id");
	});

	test("resolves project workspace storage plans with active add-on quantities", async () => {
		const client = new FakeCatalogSqlClient();
		client.workspacePlanRows = [{
			project_id: "project-1",
			workspace_id: "workspace-1",
			plan_id: "pro",
			included_storage_bytes: "26843545600",
			extra_storage_bytes: "53687091200",
			project_ids: ["project-1", "project-2"],
		}];
		const store = new PostgresProjectCatalogStore(client);

		await expect(store.getProjectWorkspaceStoragePlan("project-1")).resolves.toEqual({
			projectId: "project-1",
			workspaceId: "workspace-1",
			planId: "pro",
			includedStorageBytes: 26843545600,
			extraStorageBytes: 53687091200,
			projectIds: ["project-1", "project-2"],
		});

		const lookup = client.queries.find((entry) => entry.query.includes("workspace_addon_grants.storage_bytes"));
		expect(lookup?.query).toContain("GREATEST(workspace_addon_grants.quantity, 0)");
		expect(lookup?.query).toContain("workspace_projects.workspace_id = projects.workspace_id");
		expect(lookup?.params).toEqual(["project-1"]);
		// P1 (money): a grace-expired past-due account must lose paid storage too — the
		// billing-account join is gated on the dunning grace deadline on this read path.
		expect(lookup?.query).toContain("dunning_grace_until");
	});

	test("storage plan folds active storage packs into the extra storage quota", async () => {
		const client = new FakeCatalogSqlClient();
		// extra_storage_bytes is the SQL-computed sum of active add-on grants PLUS
		// active, non-expired storage_packs (folded into the production query), so a
		// purchased pack raises the effective quota the upload/reservation path reads.
		client.workspacePlanRows = [{
			project_id: "project-1",
			workspace_id: "workspace-1",
			plan_id: "creator",
			included_storage_bytes: "5368709120",
			// 0 add-on grant bytes + a 25 GB active storage pack folded in by SQL.
			extra_storage_bytes: String(25 * 1024 * 1024 * 1024),
			project_ids: ["project-1"],
		}];
		const store = new PostgresProjectCatalogStore(client);

		const plan = await store.getProjectWorkspaceStoragePlan("project-1");
		expect(plan?.extraStorageBytes).toBe(25 * 1024 * 1024 * 1024);

		// The production query sums active, non-expired packs scoped to the workspace,
		// without disturbing the existing add-on grant aggregate.
		const lookup = client.queries.find((entry) => entry.query.includes("FROM storage_packs"));
		expect(lookup?.query).toContain("SUM(GREATEST(storage_packs.pack_size_bytes, 0))");
		expect(lookup?.query).toContain("storage_packs.workspace_id = projects.workspace_id");
		expect(lookup?.query).toContain("storage_packs.active = true");
		expect(lookup?.query).toContain("storage_packs.expires_at IS NULL OR storage_packs.expires_at > now()");
		expect(lookup?.query).toContain("SUM(workspace_addon_grants.storage_bytes * GREATEST(workspace_addon_grants.quantity, 0))");
		expect(lookup?.params).toEqual(["project-1"]);
	});

	test("storage plan lookup ignores workspace display plans without active billing entitlement", async () => {
		const client = new FakeCatalogSqlClient();
		client.workspacePlanRows = [{
			project_id: "project-1",
			workspace_id: "workspace-1",
			plan_id: "free",
			included_storage_bytes: null,
			extra_storage_bytes: "0",
			project_ids: ["project-1"],
		}];
		const store = new PostgresProjectCatalogStore(client);

		await expect(store.getProjectWorkspaceStoragePlan("project-1")).resolves.toEqual({
			projectId: "project-1",
			workspaceId: "workspace-1",
			planId: "free",
			includedStorageBytes: undefined,
			extraStorageBytes: 0,
			projectIds: ["project-1"],
		});

		const lookup = client.queries.find((entry) => entry.query.includes("workspace_addon_grants.storage_bytes"));
		expect(lookup?.query).toContain("billing_plans.plan_id = workspace_billing_accounts.plan_id");
		expect(lookup?.query).not.toContain("COALESCE(workspace_billing_accounts.plan_id, workspaces.plan_id)");
	});

	test("records project versions as queryable snapshots", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = createState();
		const metadata: ProjectVersionMetadata = {
			versionId: "2026-05-28T02-00-00-000Z_version",
			projectId: state.projectId,
			name: state.name,
			source: "save",
			createdAt: "2026-05-28T02:00:00.000Z",
			pageCount: 2,
			textLayerCount: 1,
			stateHash: "abc123",
		};

		await store.recordProjectVersion(metadata, state);

		const insert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_versions"));
		expect(insert).toBeTruthy();
		expect(insert?.params[0]).toBe(metadata.versionId);
		expect(insert?.params[1]).toBe(state.projectId);
		expect(JSON.parse(String(insert?.params[7])).stateHash).toBe("abc123");
		expect(JSON.parse(String(insert?.params[8])).projectId).toBe(state.projectId);
	});

	test("lists project versions through bounded catalog pages", async () => {
		const client = new FakeCatalogSqlClient();
		client.versionRows = [
			{
				version_id: "version-3",
				project_id: "project-1",
				name: "Version 3",
				source: "save",
				state_hash: "hash-3",
				page_count: 3,
				text_layer_count: 30,
				metadata: JSON.stringify({ storyTitle: "Series", createdAt: "2026-05-28T03:00:00.000Z" }),
				created_at: "2026-05-28T03:00:00.000Z",
			},
			{
				version_id: "version-2",
				project_id: "project-1",
				name: "Version 2",
				source: "restore",
				state_hash: "hash-2",
				page_count: 2,
				text_layer_count: 20,
				metadata: JSON.stringify({ createdAt: "2026-05-28T02:00:00.000Z" }),
				created_at: "2026-05-28T02:00:00.000Z",
			},
		];
		const store = new PostgresProjectCatalogStore(client);

		const page = await store.listProjectVersions({ projectId: "project-1", limit: 1 });

		expect(page.versions).toHaveLength(1);
		expect(page.versions[0]).toMatchObject({
			versionId: "version-3",
			projectId: "project-1",
			name: "Version 3",
			source: "save",
			pageCount: 3,
			textLayerCount: 30,
			stateHash: "hash-3",
			storyTitle: "Series",
		});
		expect(page.nextCursor).toBeDefined();
		const select = client.queries.find((entry) => entry.query.includes("FROM project_versions"));
		expect(select?.params).toEqual(["project-1", null, null, 2]);
		expect(select?.query).toContain("to_char(created_at AT TIME ZONE 'UTC'");
		expect(select?.query).toContain("(created_at, version_id) < ($2::timestamptz, $3::text)");
		expect(select?.query).toContain("ORDER BY created_at DESC, version_id DESC");
		expect(page.versions[0].createdAt).toBe("2026-05-28T03:00:00.000000Z");

		const filePage = paginateProjectVersions([
			{
				versionId: "version-3",
				projectId: "project-1",
				name: "Version 3",
				source: "save",
				createdAt: "2026-05-28T03:00:00.000Z",
				pageCount: 3,
				textLayerCount: 30,
			},
			{
				versionId: "version-2",
				projectId: "project-1",
				name: "Version 2",
				source: "save",
				createdAt: "2026-05-28T02:00:00.000Z",
				pageCount: 2,
				textLayerCount: 20,
			},
		], { cursor: page.nextCursor, limit: 1 });
		expect(filePage.versions.map((version) => version.versionId)).toEqual(["version-2"]);
		expect(filePage.nextCursor).toBeUndefined();

		const tiedFilePage = paginateProjectVersions([
			createVersion("version-a", "2026-05-28T04:00:00.000Z"),
			createVersion("version-c", "2026-05-28T04:00:00.000Z"),
			createVersion("version-b", "2026-05-28T04:00:00.000Z"),
		], { limit: 1 });
		expect(tiedFilePage.versions.map((version) => version.versionId)).toEqual(["version-c"]);
		expect(tiedFilePage.nextCursor).toBeDefined();
		const secondTiedFilePage = paginateProjectVersions([
			createVersion("version-a", "2026-05-28T04:00:00.000Z"),
			createVersion("version-c", "2026-05-28T04:00:00.000Z"),
			createVersion("version-b", "2026-05-28T04:00:00.000Z"),
		], { cursor: tiedFilePage.nextCursor, limit: 1 });
		expect(secondTiedFilePage.versions.map((version) => version.versionId)).toEqual(["version-b"]);

		await expect(store.listProjectVersions({ projectId: "project-1", cursor: "not-a-valid-cursor" }))
			.rejects.toBeInstanceOf(InvalidProjectVersionCursorError);
		expect(() => paginateProjectVersions([], { cursor: "not-a-valid-cursor" })).toThrow(InvalidProjectVersionCursorError);
		const merged = mergeProjectVersions(
			[createVersion("version-new", "2026-05-28T04:00:00.000Z")],
			[
				createVersion("version-new", "2026-05-28T04:00:00.000Z"),
				createVersion("version-old", "2026-05-28T01:00:00.000Z"),
			],
		);
		expect(paginateProjectVersions(merged, { limit: 2 }).versions.map((version) => version.versionId)).toEqual(["version-new", "version-old"]);
	});

	test("reads catalog project version state records by id", async () => {
		const client = new FakeCatalogSqlClient();
		const state = createState();
		client.versionRows = [{
			version_id: "version-3",
			project_id: state.projectId,
			name: "Version 3",
			source: "save",
			state_hash: "hash-3",
			page_count: state.pages.length,
			text_layer_count: 1,
			metadata: JSON.stringify({ createdAt: "2026-05-28T03:00:00.000Z" }),
			state: JSON.stringify(state),
			created_at: "2026-05-28T03:00:00.000Z",
		}];
		const store = new PostgresProjectCatalogStore(client);

		const record = await store.getProjectVersion(state.projectId, "version-3");

		expect(record?.metadata.versionId).toBe("version-3");
		expect(record?.state.projectId).toBe(state.projectId);
		expect(record?.state.pages).toHaveLength(2);
		const select = client.queries.find((entry) => entry.query.includes("FROM project_versions"));
		expect(select?.params).toEqual([state.projectId, "version-3"]);
		expect(select?.query).toContain("state");
	});

	test("lists project pages through bounded catalog pages", async () => {
		const client = new FakeCatalogSqlClient();
		client.pageRows = [
			{
				page_id: "project-1:page:0",
				project_id: "project-1",
				page_index: 0,
				image_id: "image-0",
				status: "draft",
				revision_id: null,
				metadata: JSON.stringify({ imageName: "page-0.png", textLayerCount: 2 }),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
			},
			{
				page_id: "project-1:page:1",
				project_id: "project-1",
				page_index: 1,
				image_id: "image-1",
				status: "review_ready",
				revision_id: "clean-1",
				metadata: JSON.stringify({ imageName: "page-1.png", originalName: "001.png", imageLayerCount: 1, pendingAiJobCount: 2 }),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
			},
		];
		const store = new PostgresProjectCatalogStore(client);

		const page = await store.listProjectPages({ projectId: "project-1", limit: 1 });

		expect(page.pages).toHaveLength(1);
		expect(page.pages[0]).toMatchObject({
			projectId: "project-1",
			pageId: "project-1:page:0",
			pageIndex: 0,
			imageId: "image-0",
			status: "draft",
			imageName: "page-0.png",
			textLayerCount: 2,
		});
		expect(page.nextCursor).toBeDefined();
		const select = client.queries.find((entry) => entry.query.includes("FROM project_pages"));
		expect(select?.params).toEqual(["project-1", null, null, null, 2]);
		expect(select?.query).toContain("ORDER BY page_index ASC");
		expect(select?.query).toContain("page_index > $3::integer");
		expect(select?.query).toContain("page_index = $4::integer");

		const filePage = paginateProjectPages([
			createPageSummary(2, "cleaned"),
			createPageSummary(0, "draft"),
			createPageSummary(1, "review_ready"),
		], { cursor: page.nextCursor, limit: 1 });
		expect(filePage.pages.map((summary) => summary.pageIndex)).toEqual([1]);

		client.pageRows = [client.pageRows[1]];
		const filtered = await store.listProjectPages({ projectId: "project-1", status: "review_ready", limit: 5 });
		expect(filtered.pages.map((summary) => summary.status)).toEqual(["review_ready"]);
		expect(client.queries.at(-1)?.params).toEqual(["project-1", "review_ready", null, null, 6]);
		const scopedPage = await store.listProjectPages({ projectId: "project-1", pageIndex: 1, limit: 5 });
		expect(scopedPage.pages.map((summary) => summary.pageIndex)).toEqual([1]);
		expect(client.queries.at(-1)?.params).toEqual(["project-1", null, null, 1, 6]);
		await expect(store.listProjectPages({ projectId: "project-1", cursor: "not-a-valid-cursor" }))
			.rejects.toBeInstanceOf(InvalidProjectPageCursorError);
		expect(() => paginateProjectPages([], { cursor: "not-a-valid-cursor" })).toThrow(InvalidProjectPageCursorError);
		const tooLargeCursor = Buffer.from(JSON.stringify({ pageIndex: 2147483648 }), "utf8").toString("base64url");
		await expect(store.listProjectPages({ projectId: "project-1", cursor: tooLargeCursor }))
			.rejects.toBeInstanceOf(InvalidProjectPageCursorError);
		expect(mergeProjectPageSummaries(
			[createPageSummary(0, "draft")],
			[createPageSummary(0, "needs_translation"), createPageSummary(1, "needs_clean")],
		).map((summary) => [summary.pageIndex, summary.status])).toEqual([[0, "needs_translation"], [1, "needs_clean"]]);
	});

	test("lists project tasks through bounded catalog pages", async () => {
		const client = new FakeCatalogSqlClient();
		client.taskRows = [
			{
				task_id: "task-c",
				project_id: "project-1",
				page_index: 1,
				type: "review",
				status: "review",
				priority: "urgent",
				title: "QC page 1",
				assignee_user_id: "user-2",
				layer_id: "layer-1",
				due_at: "2026-05-29T01:00:00.000Z",
				metadata: JSON.stringify({ pageImageId: "image-1" }),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T04:00:00.000Z",
			},
			{
				task_id: "task-b",
				project_id: "project-1",
				page_index: 0,
				type: "translate",
				status: "doing",
				priority: "high",
				title: "Translate page 0",
				assignee_user_id: "user-1",
				layer_id: null,
				due_at: null,
				metadata: JSON.stringify({}),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
			},
		];
		const store = new PostgresProjectCatalogStore(client);

		const page = await store.listProjectTasks({ projectId: "project-1", limit: 1 });

		expect(page.tasks).toHaveLength(1);
		expect(page.tasks[0]).toMatchObject({
			id: "task-c",
			type: "review",
			status: "review",
			priority: "urgent",
			pageIndex: 1,
			pageImageId: "image-1",
			layerId: "layer-1",
			assignee: "user-2",
			dueAt: "2026-05-29T01:00:00.000000Z",
		});
		expect(page.nextCursor).toBeDefined();
		const select = client.queries.find((entry) => entry.query.includes("FROM project_tasks"));
		expect(select?.params).toEqual(["project-1", 2]);
		expect(select?.query).toContain("ORDER BY updated_at DESC, task_id DESC");
		expect(select?.query).not.toContain("IS NULL OR");

		const filePage = paginateProjectTasks([
			createTask("task-a", "2026-05-28T02:00:00.000Z", "todo", "translate", 0),
			createTask("task-c", "2026-05-28T04:00:00.000Z", "review", "review", 1),
			createTask("task-b", "2026-05-28T03:00:00.000Z", "doing", "translate", 0),
		], { cursor: page.nextCursor, limit: 1 });
		expect(filePage.tasks.map((task) => task.id)).toEqual(["task-b"]);

		client.taskRows = [client.taskRows[1]];
		const filtered = await store.listProjectTasks({ projectId: "project-1", status: "doing", type: "translate", assignee: "@user-1", pageIndex: 0, limit: 5 });
		expect(filtered.tasks.map((task) => task.id)).toEqual(["task-b"]);
		expect(client.queries.at(-1)?.params).toEqual(["project-1", "doing", "translate", "user-1", 0, 6]);
		expect(client.queries.at(-1)?.query).toContain("status = $2");
		expect(client.queries.at(-1)?.query).toContain("type = $3");
		expect(client.queries.at(-1)?.query).toContain("assignee_user_id = $4");
		expect(client.queries.at(-1)?.query).toContain("page_index = $5");
		const fileFiltered = paginateProjectTasks([
			createTask("task-b", "2026-05-28T03:00:00.000Z", "doing", "translate", 0, "user-1"),
		], { status: "doing", type: "translate", assignee: "@user-1", pageIndex: 0, limit: 5 });
		expect(fileFiltered.tasks.map((task) => task.id)).toEqual(["task-b"]);
		await expect(store.listProjectTasks({ projectId: "project-1", cursor: "not-a-valid-cursor" }))
			.rejects.toBeInstanceOf(InvalidProjectTaskCursorError);
		expect(() => paginateProjectTasks([], { cursor: "not-a-valid-cursor" })).toThrow(InvalidProjectTaskCursorError);
	});

	test("lists project comments through bounded catalog pages", async () => {
		const client = new FakeCatalogSqlClient();
		client.commentRows = [
			{
				comment_id: "comment-c",
				project_id: "project-1",
				page_index: 1,
				layer_id: "layer-1",
				status: "open",
				body: "Fix redraw @qa",
				author_user_id: "user-2",
				mentions: ["qa"],
				region: { x: 1, y: 2, w: 3, h: 4 },
				metadata: JSON.stringify({}),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T04:00:00.000Z",
			},
			{
				comment_id: "comment-b",
				project_id: "project-1",
				page_index: 0,
				layer_id: null,
				status: "resolved",
				body: "Resolved note",
				author_user_id: "user-1",
				mentions: [],
				region: null,
				metadata: JSON.stringify({}),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
			},
		];
		const store = new PostgresProjectCatalogStore(client);

		const page = await store.listProjectComments({ projectId: "project-1", limit: 1 });

		expect(page.comments).toHaveLength(1);
		expect(page.comments[0]).toMatchObject({
			id: "comment-c",
			pageIndex: 1,
			layerId: "layer-1",
			status: "open",
			body: "Fix redraw @qa",
			author: "user-2",
			mentions: ["qa"],
			region: { x: 1, y: 2, w: 3, h: 4 },
		});
		expect(page.nextCursor).toBeDefined();
		const select = client.queries.find((entry) => entry.query.includes("FROM project_comments"));
		expect(select?.params).toEqual(["project-1", 2]);
		expect(select?.query).toContain("ORDER BY updated_at DESC, comment_id DESC");
		expect(select?.query).not.toContain("IS NULL OR");

		const filePage = paginateProjectComments([
			createComment("comment-a", "2026-05-28T02:00:00.000Z", "open", 0, "user-1"),
			createComment("comment-c", "2026-05-28T04:00:00.000Z", "open", 1, "user-2", "layer-1"),
			createComment("comment-b", "2026-05-28T03:00:00.000Z", "resolved", 0, "user-1"),
		], { cursor: page.nextCursor, limit: 1 });
		expect(filePage.comments.map((comment) => comment.id)).toEqual(["comment-b"]);

		client.commentRows = [client.commentRows[0]];
		const filtered = await store.listProjectComments({ projectId: "project-1", status: "open", pageIndex: 1, layerId: "layer-1", author: "user-2", limit: 5 });
		expect(filtered.comments.map((comment) => comment.id)).toEqual(["comment-c"]);
		expect(client.queries.at(-1)?.params).toEqual(["project-1", "open", 1, "layer-1", "user-2", 6]);
		expect(client.queries.at(-1)?.query).toContain("status = $2");
			expect(client.queries.at(-1)?.query).toContain("page_index = $3");
			expect(client.queries.at(-1)?.query).toContain("layer_id = $4");
			expect(client.queries.at(-1)?.query).toContain("author_user_id = $5");
			await expect(store.listProjectComments({ projectId: "project-1", cursor: "not-a-valid-cursor" }))
				.rejects.toBeInstanceOf(InvalidProjectCommentCursorError);
			expect(() => paginateProjectComments([], { cursor: "not-a-valid-cursor" })).toThrow(InvalidProjectCommentCursorError);
		});

	test("lists project review decisions through bounded catalog pages", async () => {
		const client = new FakeCatalogSqlClient();
		client.reviewDecisionRows = [
			{
				review_decision_id: "decision-c",
				project_id: "project-1",
				page_index: 1,
				status: "changes_requested",
				body: "Fix page 1",
				actor_user_id: "reviewer-2",
				metadata: JSON.stringify({}),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T04:00:00.000Z",
			},
			{
				review_decision_id: "decision-b",
				project_id: "project-1",
				page_index: 0,
				status: "approved",
				body: null,
				actor_user_id: "reviewer-1",
				metadata: JSON.stringify({}),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
			},
		];
		const store = new PostgresProjectCatalogStore(client);

		const page = await store.listProjectReviewDecisions({ projectId: "project-1", limit: 1 });

		expect(page.decisions).toHaveLength(1);
		expect(page.decisions[0]).toMatchObject({
			id: "decision-c",
			pageIndex: 1,
			status: "changes_requested",
			body: "Fix page 1",
			actor: "reviewer-2",
		});
		expect(page.nextCursor).toBeDefined();
		const select = client.queries.find((entry) => entry.query.includes("FROM project_review_decisions"));
		expect(select?.params).toEqual(["project-1", 2]);
		expect(select?.query).toContain("ORDER BY updated_at DESC, review_decision_id DESC");
		expect(select?.query).not.toContain("IS NULL OR");

		const filePage = paginateProjectReviewDecisions([
			createDecision("decision-a", "2026-05-28T02:00:00.000Z", "changes_requested", 0, "reviewer-1"),
			createDecision("decision-c", "2026-05-28T04:00:00.000Z", "changes_requested", 1, "reviewer-2"),
			createDecision("decision-b", "2026-05-28T03:00:00.000Z", "approved", 0, "reviewer-1"),
		], { cursor: page.nextCursor, limit: 1 });
		expect(filePage.decisions.map((decision) => decision.id)).toEqual(["decision-b"]);

		client.reviewDecisionRows = [client.reviewDecisionRows[0]];
		const filtered = await store.listProjectReviewDecisions({ projectId: "project-1", status: "changes_requested", pageIndex: 1, actor: "reviewer-2", limit: 5 });
		expect(filtered.decisions.map((decision) => decision.id)).toEqual(["decision-c"]);
		expect(client.queries.at(-1)?.params).toEqual(["project-1", "changes_requested", 1, "reviewer-2", 6]);
			expect(client.queries.at(-1)?.query).toContain("status = $2");
			expect(client.queries.at(-1)?.query).toContain("page_index = $3");
			expect(client.queries.at(-1)?.query).toContain("actor_user_id = $4");
			await expect(store.listProjectReviewDecisions({ projectId: "project-1", cursor: "not-a-valid-cursor" }))
				.rejects.toBeInstanceOf(InvalidProjectReviewDecisionCursorError);
			expect(() => paginateProjectReviewDecisions([], { cursor: "not-a-valid-cursor" })).toThrow(InvalidProjectReviewDecisionCursorError);
		});

	test("prunes catalog version snapshots by project and version ids", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);

		await store.deleteProjectVersions("project-1", ["version-1", "version-2", "version-1"]);

		const deletion = client.queries.find((entry) => entry.query.includes("DELETE FROM project_versions"));
		expect(deletion).toBeTruthy();
		expect(deletion?.query).toContain("project_id = $1");
		expect(deletion?.params).toEqual(["project-1", "version-1", "version-2"]);
	});

	test("deleteProject removes the projects row (child rows cascade via FK)", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);

		await store.deleteProject(" project-1 ");

		const deletion = client.queries.find((entry) => entry.query.includes("DELETE FROM projects"));
		expect(deletion).toBeTruthy();
		expect(deletion?.query).toContain("project_id = $1");
		// Id is trimmed before binding.
		expect(deletion?.params).toEqual(["project-1"]);
	});

	test("deleteProject is a no-op for a blank id", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);

		await store.deleteProject("   ");

		expect(client.queries.some((entry) => entry.query.includes("DELETE FROM projects"))).toBe(false);
	});

	test("checks workspace member role before allowing shared project access", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "viewer", scope: JSON.stringify({ projectIds: ["project-1"], languages: ["th"] }), target_locale: "th" }];

		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
		})).resolves.toBe(true);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
		})).resolves.toBe(false);
		const accessQuery = client.queries.find((entry) => entry.query.includes("INNER JOIN workspace_members"));
		expect(accessQuery?.query).toContain("workspace_members.disabled_at IS NULL");
		expect(accessQuery?.query).toContain("workspace_members.scope");
		expect(accessQuery?.query).toContain("projects.target_locale");
	});

	test("denies shared project access outside member invite scope", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "editor", scope: JSON.stringify({ projectIds: ["project-allowed"] }), target_locale: "th" }];

		await expect(store.canAccessProject({
			projectId: "project-blocked",
			userId: "user-2",
			permission: "read:project",
		})).resolves.toBe(false);
	});

	test("requires route scope context for page or task scoped members", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "editor", scope: JSON.stringify({ projectIds: ["project-1"], pageIndexes: [0], taskTypes: ["translate"] }), target_locale: "th" }];

		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "generate:ai",
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			pageIndex: 0,
		})).resolves.toBe(true);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			pageIndex: 0,
			resourceKind: "task",
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
			pageIndex: 0,
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "generate:ai",
			pageIndex: 0,
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			pageIndex: 0,
			taskType: "translate",
			resourceKind: "task",
		})).resolves.toBe(true);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
			pageIndex: 0,
			taskType: "translate",
		})).resolves.toBe(true);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			pageIndex: 1,
			taskType: "translate",
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			pageIndex: 0,
			taskType: "clean",
		})).resolves.toBe(false);
	});

	test("allows lock/work-state update for chapter+task scoped members when chapterId and taskType are supplied", async () => {
		// Regression for the lock-acquire / work-state transition access checks:
		// a member restricted to a chapter and a task type must pass update:project
		// once the route resolves chapterId (chapter == project here) and infers the
		// member's taskType. Without those, isFineGrainedProjectWideAccess rejects.
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "editor", scope: JSON.stringify({ chapterIds: ["project-1"], taskTypes: ["translate"] }), target_locale: "th" }];

		// Project-wide update (no chapterId/taskType) is denied.
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
		})).resolves.toBe(false);
		// Supplying chapterId but no taskType is still denied (taskTypes scope).
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
			chapterId: "project-1",
		})).resolves.toBe(false);
		// Supplying both chapterId and the member's own task type is allowed.
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
			chapterId: "project-1",
			taskType: "translate",
			resourceKind: "page",
		})).resolves.toBe(true);
		// A foreign chapter or task type is still rejected.
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
			chapterId: "other-chapter",
			taskType: "translate",
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "update:project",
			chapterId: "project-1",
			taskType: "qc",
		})).resolves.toBe(false);
	});

	test("enforces requested language scope for AI generation", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "editor", scope: JSON.stringify({ projectIds: ["project-1"], languages: ["th"] }), target_locale: "th" }];

		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "generate:ai",
			language: "th",
		})).resolves.toBe(true);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "generate:ai",
			language: "en",
		})).resolves.toBe(false);
	});

	test("requires asset purpose context for asset-scoped project access", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "viewer", scope: JSON.stringify({ projectIds: ["project-1"], pageIndexes: [0], assetPurposes: ["thumbnail"] }), target_locale: "th" }];

		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			pageIndex: 0,
			resourceKind: "asset",
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			pageIndex: 0,
			assetPurpose: "thumbnail",
			resourceKind: "asset",
		})).resolves.toBe(true);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			pageIndex: 0,
			assetPurpose: "editor_preview",
			resourceKind: "asset",
		})).resolves.toBe(false);
	});

	test("requires an explicit language when language-scoped projects have no target locale", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "viewer", scope: JSON.stringify({ projectIds: ["project-1"], languages: ["th"] }), target_locale: null }];

		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
		})).resolves.toBe(false);
		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "read:project",
			language: "th",
		})).resolves.toBe(true);
	});

	test("denies AI generation when member scope disables AI credits", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "editor", scope: JSON.stringify({ projectIds: ["project-1"], aiCreditPolicy: "none" }), target_locale: "th" }];

		await expect(store.canAccessProject({
			projectId: "project-1",
			userId: "user-2",
			permission: "generate:ai",
		})).resolves.toBe(false);
	});

	test("resolveProjectAccessContext resolves membership ONCE and yields per-task decisions identical to canAccessProject (bulk N+1 fix)", async () => {
		// A page-scoped editor: only page 0 / translate tasks are in scope. A bulk
		// op over a mixed batch (one in-scope task, one out-of-scope task) must
		// allow the first and deny the second — exactly as N separate
		// canAccessProject calls would — while issuing a SINGLE membership query.
		const scope = JSON.stringify({ projectIds: ["project-1"], pageIndexes: [0], taskTypes: ["translate"] });
		const accessRow = { role: "editor", scope, target_locale: "th" };

		// Baseline: the per-task decisions the OLD path produced (one query each).
		const baselineClient = new FakeCatalogSqlClient();
		const baselineStore = new PostgresProjectCatalogStore(baselineClient);
		baselineClient.accessRows = [accessRow];
		const inScopeCheck = { pageIndex: 0, taskType: "translate", resourceKind: "task" as const };
		const outOfScopeCheck = { pageIndex: 1, taskType: "review", resourceKind: "task" as const };
		const baselineAllowed = await baselineStore.canAccessProject({ projectId: "project-1", userId: "user-2", permission: "update:project", ...inScopeCheck });
		const baselineDenied = await baselineStore.canAccessProject({ projectId: "project-1", userId: "user-2", permission: "update:project", ...outOfScopeCheck });
		expect(baselineAllowed).toBe(true);
		expect(baselineDenied).toBe(false);
		// Old path: one membership query PER task (the N+1 we are fixing).
		expect(baselineClient.queries.filter((q) => q.query.includes("INNER JOIN workspace_members"))).toHaveLength(2);

		// New path: resolve ONCE, evaluate each task in-memory.
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [accessRow];
		const context = await store.resolveProjectAccessContext({ projectId: "project-1", userId: "user-2", permission: "update:project" });
		expect(context).not.toBeNull();
		// Same per-task decisions as the baseline (denied task in a mixed batch stays denied).
		expect(context!.allows(inScopeCheck)).toBe(baselineAllowed);
		expect(context!.allows(outOfScopeCheck)).toBe(baselineDenied);
		// O(1): membership resolved exactly once regardless of how many tasks we check.
		expect(client.queries.filter((q) => q.query.includes("INNER JOIN workspace_members"))).toHaveLength(1);
		// Extra in-memory checks issue NO further store reads.
		context!.allows(inScopeCheck);
		context!.allows(outOfScopeCheck);
		context!.allows({ pageIndex: 0, taskType: "translate", resourceKind: "task" });
		expect(client.queries.filter((q) => q.query.includes("INNER JOIN workspace_members"))).toHaveLength(1);
	});

	test("resolveProjectAccessContext denies a non-member with a single query", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = []; // no membership row
		const context = await store.resolveProjectAccessContext({ projectId: "project-1", userId: "stranger", permission: "update:project" });
		expect(context).not.toBeNull();
		expect(context!.canAccessBaseline).toBe(false);
		expect(context!.allows({ pageIndex: 0, taskType: "translate", resourceKind: "task" })).toBe(false);
		// A HARD denial is the shared singleton — routes use this to distinguish a
		// non-member (who may still earn an alternate grant, e.g. chapter-team access)
		// from a scoped-but-present member. A genuine scoped member's context is a
		// DIFFERENT object, so the predicate is false for it.
		expect(isProjectAccessFullyDenied(context)).toBe(true);
		expect(client.queries.filter((q) => q.query.includes("INNER JOIN workspace_members"))).toHaveLength(1);
	});

	test("isProjectAccessFullyDenied is false for a present (scoped) member context and null", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		client.accessRows = [{ role: "editor", scope: JSON.stringify({ projectIds: ["project-1"], pageIndexes: [0] }), target_locale: "th" }];
		const scoped = await store.resolveProjectAccessContext({ projectId: "project-1", userId: "member", permission: "read:project" });
		// A scoped member is NOT a hard denial even though some checks fail.
		expect(isProjectAccessFullyDenied(scoped)).toBe(false);
		expect(isProjectAccessFullyDenied(null)).toBe(false);
	});

	test("lists project summaries from indexed catalog rows", async () => {
		const client = new FakeCatalogSqlClient();
		client.summaryRows = [{
			project_id: "project-1",
			title: "Chapter 1",
			target_locale: "th",
			target_locales: ["th", "en"],
			metadata: JSON.stringify({
				storyTitle: "Series",
				chapterLabel: "ตอน 1",
				coverImageId: "cover.png",
				pageCount: 12,
				textLayerCount: 34,
				taskCount: 8,
				openTaskCount: 3,
				reviewTaskCount: 1,
				commentCount: 5,
				openCommentCount: 2,
			}),
			created_at: "2026-05-28T01:00:00.000Z",
			updated_at: "2026-05-28T02:00:00.000Z",
		}];
		const store = new PostgresProjectCatalogStore(client);

		const page = await store.listProjectSummaryPage({ userId: "user-1" });
		const summaries = page.projects;

		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			projectId: "project-1",
			name: "Chapter 1",
			storyTitle: "Series",
			chapterLabel: "ตอน 1",
			targetLang: "th",
			targetLangs: ["th", "en"],
			pageCount: 12,
			textLayerCount: 34,
			openTaskCount: 3,
			openCommentCount: 2,
		});
		const select = client.queries.find((entry) => entry.query.includes("FROM projects"));
		// $5 is the optional workspace bound (null = unscoped, all the caller's projects);
		// $6 is the P1b "exclude ownerless legacy rows" flag (false by default → the
		// ownerless-anonymous personal branch stays enabled for the normal listing).
		expect(select?.params).toEqual(["user-1", null, null, 101, null, false]);
		expect(select?.query).toContain("($5::text IS NULL OR projects.workspace_id = $5::text)");
		expect(select?.query).toContain("(projects.updated_at, projects.project_id) < ($2::timestamptz, $3::text)");
		expect(select?.query).toContain("to_char(created_at AT TIME ZONE 'UTC'");
		expect(select?.query).toContain("to_char(updated_at AT TIME ZONE 'UTC'");
		expect(select?.query).toContain("ORDER BY projects.updated_at DESC, projects.project_id DESC");
		expect(select?.query).toContain("owner_user_id IS NULL AND NOT (projects.metadata ? 'workspaceId')");
		expect(select?.query).toContain("owner_user_id = $1 AND NOT (projects.metadata ? 'workspaceId')");
		expect(select?.query).toContain("workspace_members.disabled_at IS NULL");
		expect(select?.query).toContain("CROSS JOIN LATERAL");
		expect(select?.query).toContain("workspace_member_scope.scope->'projectIds'");
		expect(select?.query).toContain("workspace_member_scope.scope->'languages'");
		expect(select?.query).toContain("unnest(COALESCE(projects.target_locales, ARRAY[projects.target_locale]::text[]))");
		expect(select?.query).toContain("workspace_member_scope.scope->'chapterIds'");
		expect(select?.query).toContain("OR (workspace_member_scope.scope->'chapterIds') ? projects.project_id");
		expect(select?.query).toContain("workspace_member_scope.scope->'pageIndexes'");
		expect(select?.query).toContain("jsonb_array_length(workspace_member_scope.scope->'projectIds') > 0");
		expect(select?.query).toContain("jsonb_array_length(workspace_member_scope.scope->'chapterIds') > 0");
		expect(select?.query).not.toContain("workspace_member_scope.scope->'taskTypes'");
		expect(select?.query).not.toContain("workspace_member_scope.scope->'assetPurposes'");
		expect(select?.query).not.toContain("jsonb_array_length(workspace_member_scope.scope->'taskTypes') = 0");
		expect(select?.query).not.toContain("jsonb_array_length(workspace_member_scope.scope->'assetPurposes') = 0");
		expect(select?.query).toContain("taskTypes/assetPurposes scope gates work and asset operations");
	});

	test("listProjectSummaryPage SQL allows task/asset-only members to see catalog rows but keeps chapter scopes bounded", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);

		await store.listProjectSummaryPage({ userId: "scoped-worker", workspaceId: "workspace-1" });

		const select = client.queries.find((entry) => entry.query.includes("FROM projects"));
		expect(select?.query).toContain("workspace_members.user_id = $1");
		expect(select?.query).toContain("OR (workspace_member_scope.scope->'chapterIds') ? projects.project_id");
		expect(select?.query).toContain("jsonb_array_length(workspace_member_scope.scope->'pageIndexes') = 0");
		expect(select?.query).toContain("jsonb_array_length(workspace_member_scope.scope->'projectIds') > 0");
		expect(select?.query).toContain("jsonb_array_length(workspace_member_scope.scope->'chapterIds') > 0");
		expect(select?.query).not.toContain("jsonb_array_length(workspace_member_scope.scope->'taskTypes') = 0");
		expect(select?.query).not.toContain("jsonb_array_length(workspace_member_scope.scope->'assetPurposes') = 0");
	});

	test("does not list explicit workspace projects through anonymous owner-null rows", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);

		await store.listProjectSummaries();

		const select = client.queries.find((entry) => entry.query.includes("FROM projects"));
		expect(select?.params).toEqual([null, null, null, 101, null, false]);
		expect(select?.query).toContain("owner_user_id IS NULL AND NOT (projects.metadata ? 'workspaceId')");
		expect(select?.query).toContain("$1::text IS NOT NULL");
		expect(select?.query).toContain("workspace_members.workspace_id = projects.workspace_id");
	});

	test("listProjectSummaryPage binds the workspace filter ($5) when scoped to a workspace", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);

		await store.listProjectSummaryPage({ userId: "user-1", workspaceId: "ws-target" });

		const select = client.queries.find((entry) => entry.query.includes("FROM projects"));
		// $5 carries the workspace bound so the filter is applied in SQL (at the
		// source), not after fetching the user's whole project space. $6 is the P1b
		// ownerless-exclusion flag (false here — not a GDPR export).
		expect(select?.params).toEqual(["user-1", null, null, 101, "ws-target", false]);
		expect(select?.query).toContain("($5::text IS NULL OR projects.workspace_id = $5::text)");
	});

	test("listProjectSummaryPage binds $6=true and suppresses the ownerless branch when excludeOwnerlessPersonal (P1b GDPR export)", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);

		await store.listProjectSummaryPage({ userId: "user-1", excludeOwnerlessPersonal: true });

		const select = client.queries.find((entry) => entry.query.includes("FROM projects"));
		// $6 = true → the SQL gates the ownerless-anonymous branch behind NOT $6,
		// so a subject's export never matches OTHER people's owner_user_id IS NULL rows.
		expect(select?.params).toEqual(["user-1", null, null, 101, null, true]);
		expect(select?.query).toContain("NOT $6::boolean AND owner_user_id IS NULL AND NOT (projects.metadata ? 'workspaceId')");
		// The owner-matched personal branch and the workspace-membership branch remain,
		// so genuinely-owned + genuine-membership projects still surface.
		expect(select?.query).toContain("owner_user_id = $1 AND NOT (projects.metadata ? 'workspaceId')");
		expect(select?.query).toContain("workspace_members.workspace_id = projects.workspace_id");
	});

	test("returns opaque cursors for catalog and file-backed project summary pages", async () => {
		const client = new FakeCatalogSqlClient();
		client.summaryRows = [
			{
				project_id: "project-3",
				workspace_id: "workspace-1",
				title: "Chapter 3",
				target_locale: "th",
				metadata: JSON.stringify({ pageCount: 3 }),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T03:00:00.000Z",
			},
			{
				project_id: "project-2",
				workspace_id: "workspace-1",
				title: "Chapter 2",
				target_locale: "th",
				metadata: JSON.stringify({ pageCount: 2 }),
				created_at: "2026-05-28T01:00:00.000Z",
				updated_at: "2026-05-28T02:00:00.000Z",
			},
		];
		const store = new PostgresProjectCatalogStore(client);

		const firstPage = await store.listProjectSummaryPage({ userId: "user-1", limit: 1 });
		expect(firstPage.projects.map((summary) => summary.projectId)).toEqual(["project-3"]);
		expect(firstPage.nextCursor).toBeDefined();
		const select = client.queries.find((entry) => entry.query.includes("FROM projects"));
		expect(select?.params[3]).toBe(2);
		expect(firstPage.projects[0].updatedAt).toBe("2026-05-28T03:00:00.000000Z");

		const filePage = paginateProjectSummaries([
			createSummary("project-3", "Chapter 3", "2026-05-28T03:00:00.000Z"),
			createSummary("project-2", "Chapter 2", "2026-05-28T02:00:00.000Z"),
		], { cursor: firstPage.nextCursor, limit: 1 });
		expect(filePage.projects.map((summary) => summary.projectId)).toEqual(["project-2"]);
		expect(filePage.nextCursor).toBeUndefined();

		const tiedFileSummaries = [
			createSummary("project-a", "Chapter A", "2026-05-28T04:00:00.000Z"),
			createSummary("project-c", "Chapter C", "2026-05-28T04:00:00.000Z"),
			createSummary("project-b", "Chapter B", "2026-05-28T04:00:00.000Z"),
		];
		const firstTiedFilePage = paginateProjectSummaries(tiedFileSummaries, { limit: 1 });
		expect(firstTiedFilePage.projects.map((summary) => summary.projectId)).toEqual(["project-c"]);
		expect(firstTiedFilePage.nextCursor).toBeDefined();
		const secondTiedFilePage = paginateProjectSummaries(tiedFileSummaries, { cursor: firstTiedFilePage.nextCursor, limit: 1 });
		expect(secondTiedFilePage.projects.map((summary) => summary.projectId)).toEqual(["project-b"]);
	});

	test("keeps microsecond timestamp precision in project summary cursors", async () => {
		const client = new FakeCatalogSqlClient();
		client.summaryRows = [
			{
				project_id: "project-precise",
				workspace_id: "workspace-1",
				title: "Precise Chapter",
				target_locale: "th",
				metadata: "{}",
				created_at: "2026-05-28T01:00:00.123456Z",
				updated_at: "2026-05-28T02:00:00.123456Z",
			},
			{
				project_id: "project-next",
				workspace_id: "workspace-1",
				title: "Next Chapter",
				target_locale: "th",
				metadata: "{}",
				created_at: "2026-05-28T01:00:00.123455Z",
				updated_at: "2026-05-28T02:00:00.123455Z",
			},
		];
		const store = new PostgresProjectCatalogStore(client);

		const firstPage = await store.listProjectSummaryPage({ userId: "user-1", limit: 1 });
		expect(firstPage.projects[0].updatedAt).toBe("2026-05-28T02:00:00.123456Z");
		expect(firstPage.nextCursor).toBeDefined();

		await store.listProjectSummaryPage({ userId: "user-1", cursor: firstPage.nextCursor, limit: 1 });
		const cursorQuery = client.queries.filter((entry) => entry.query.includes("FROM projects")).at(-1);
		expect(cursorQuery?.params[1]).toBe("2026-05-28T02:00:00.123456Z");
		expect(cursorQuery?.params[2]).toBe("project-precise");
	});

	test("rejects malformed project summary cursors", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);

		await expect(store.listProjectSummaryPage({ cursor: "not-a-valid-cursor" })).rejects.toBeInstanceOf(InvalidProjectSummaryCursorError);
		expect(() => paginateProjectSummaries([], { cursor: "not-a-valid-cursor" })).toThrow(InvalidProjectSummaryCursorError);
	});

	test("merges legacy file summaries with catalog rows while preferring catalog data", () => {
		const fileSummary = createSummary("legacy-project", "Legacy File", "2026-05-28T01:00:00.000Z");
		const fileDuplicate = createSummary("catalog-project", "Old File Name", "2026-05-28T01:30:00.000Z");
		const tiedFileSummary = createSummary("alpha-project", "Same Time File", "2026-05-28T02:00:00.000Z");
		const catalogDuplicate = createSummary("catalog-project", "Catalog Name", "2026-05-28T02:00:00.000Z");

		const summaries = mergeProjectSummaries([catalogDuplicate], [fileSummary, tiedFileSummary, fileDuplicate], 100);

		expect(summaries.map((summary) => summary.projectId)).toEqual(["catalog-project", "alpha-project", "legacy-project"]);
		expect(summaries.find((summary) => summary.projectId === "catalog-project")?.name).toBe("Catalog Name");

		const uncapped = mergeProjectSummaries([], [
			createSummary("project-1", "One", "2026-05-28T03:00:00.000Z"),
			createSummary("project-2", "Two", "2026-05-28T02:00:00.000Z"),
		]);
		expect(uncapped.map((summary) => summary.projectId)).toEqual(["project-1", "project-2"]);
	});

	test("nulls missing page anchors before writing project-scoped catalog rows", async () => {
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = createState();
		state.tasks = [{ ...state.tasks![0], pageIndex: 99 }];
		state.comments = [{ ...state.comments![0], pageIndex: 99 }];
		state.reviewDecisions = [{ ...state.reviewDecisions![0], pageIndex: 99 }];

		await store.upsertProjectState(state);

		// Batched multi-row VALUES bind flat scalars in row-major column order; with a
		// single row the id is at column 0 and the page_id anchor at column 2.
		const taskUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_tasks") && entry.params[0] === "task-1");
		const commentUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_comments") && entry.params[0] === "comment-1");
		const decisionUpsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_review_decisions") && entry.params[0] === "review-1");
		expect(taskUpsert?.params[2]).toBeNull();
		expect(commentUpsert?.params[2]).toBeNull();
		expect(decisionUpsert?.params[2]).toBeNull();
	});

	test("batches each collaboration table into ONE insert per save and prunes only rows absent from the active set (rank4/5 write-amplifier fix)", async () => {
		// The old path issued one INSERT round-trip PER row plus one delete per table,
		// so a 100-page/200-task save = ~300 sequential statements inside the tx. The
		// batched path must issue exactly one multi-row INSERT per table regardless of
		// row count — O(1) statements per table, not O(rows). The prune reads existing
		// ids once and deletes only the COMPLEMENT (stale rows), so when nothing is
		// stale it issues zero DELETEs.
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = createState();
		state.pages = Array.from({ length: 100 }, (_, index) => ({
			imageId: `image-${index}.png`,
			imageName: `page-${index}.png`,
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		}));
		state.tasks = Array.from({ length: 200 }, (_, index) => createTask(`task-${index}`, "2026-05-28T01:00:00.000Z", "todo", "translate", index % 100));
		state.comments = Array.from({ length: 40 }, (_, index) => createComment(`comment-${index}`, "2026-05-28T01:00:00.000Z", "open", index % 100, "user-1"));
		state.reviewDecisions = Array.from({ length: 25 }, (_, index) => createDecision(`decision-${index}`, "2026-05-28T01:00:00.000Z", "approved", index % 100, "user-2"));
		state.versionReviewRequests = Array.from({ length: 15 }, (_, index) => ({
			id: `version-review-${index}`,
			versionId: `version-${index}`,
			status: "open" as const,
			requester: "user-1",
			mentions: [],
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		}));
		// Existing DB rows: pages 0..101 (102 rows). Pages 100 and 101 are no longer
		// in the active set (0..99), so exactly those two must be pruned.
		client.existingIdRows.project_pages = Array.from({ length: 102 }, (_, index) => ({ id: index }));
		// Tasks exist for every active id (nothing stale) -> no task DELETE at all.
		client.existingIdRows.project_tasks = Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}` }));

		await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

		const countMatching = (needle: string) => client.queries.filter((entry) => entry.query.includes(needle)).length;
		// One INSERT statement per table even though every table has many rows.
		for (const table of ["project_pages", "project_tasks", "project_comments", "project_review_decisions", "project_version_reviews"]) {
			expect(countMatching(`INSERT INTO ${table}`)).toBe(1);
			// Each table is probed exactly once for its existing ids.
			expect(client.queries.filter((entry) => entry.query.includes(` AS id FROM ${table} `)).length).toBe(1);
		}

		// The single page INSERT really does carry all 100 rows: 9 columns * 100 rows
		// = 900 bound params, and the highest placeholder reaches $900.
		const pageInsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_pages"));
		expect(pageInsert?.params).toHaveLength(900);
		expect(pageInsert?.query).toContain("$900");
		expect(pageInsert?.query).not.toContain("$901");

		// The page prune deletes ONLY the two stale ids (100, 101) in a single bounded
		// DELETE — IN (...) the complement, never NOT IN the whole active set.
		const pageDeletes = client.queries.filter((entry) => entry.query.includes("DELETE FROM project_pages"));
		expect(pageDeletes).toHaveLength(1);
		expect(pageDeletes[0]?.query).toContain("page_index IN");
		expect(pageDeletes[0]?.query).not.toContain("NOT IN");
		expect(pageDeletes[0]?.params).toEqual([state.projectId, 100, 101]);

		// Tasks had no stale rows, so no task DELETE is issued at all.
		expect(countMatching("DELETE FROM project_tasks")).toBe(0);
	});

	test("chunks a large (>1000-row) save into multiple bounded INSERTs and chunks the complement-DELETE by param budget", async () => {
		// A pathological save (well over the 1000-row chunk size) must split into
		// several INSERT statements per table — each bounded so rows * columns stays
		// under Postgres' 65535 bind-parameter ceiling. The prune deletes the
		// complement (stale rows) and likewise chunks the DELETE by bind count so a
		// huge stale set never exceeds the ceiling in one statement.
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = createState();
		const pageCount = 2500; // 3 chunks of 1000/1000/500
		state.pages = Array.from({ length: pageCount }, (_, index) => ({
			imageId: `image-${index}.png`,
			imageName: `page-${index}.png`,
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		}));
		const taskCount = 2300;
		state.tasks = Array.from({ length: taskCount }, (_, index) => createTask(`task-${index}`, "2026-05-28T01:00:00.000Z", "todo", "translate", index % pageCount));
		state.comments = [];
		state.reviewDecisions = [];
		state.versionReviewRequests = [];
		// Existing pages: the 2500 active ids plus 40,000 stale ids (2500..42499).
		// 40,000 stale > the 30,000-id DELETE param budget, forcing two DELETE chunks.
		const staleCount = 40_000;
		client.existingIdRows.project_pages = Array.from({ length: pageCount + staleCount }, (_, index) => ({ id: index }));

		await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

		const pageInserts = client.queries.filter((entry) => entry.query.includes("INSERT INTO project_pages"));
		// ceil(2500 / 1000) = 3 chunked INSERTs.
		expect(pageInserts).toHaveLength(3);
		// No single INSERT exceeds the chunk's param budget (1000 rows * 9 cols).
		for (const insert of pageInserts) {
			expect(insert.params.length).toBeLessThanOrEqual(9000);
		}
		// Row totals across chunks reconstruct every page.
		expect(pageInserts.reduce((sum, insert) => sum + insert.params.length, 0)).toBe(pageCount * 9);

		const taskInserts = client.queries.filter((entry) => entry.query.includes("INSERT INTO project_tasks"));
		expect(taskInserts).toHaveLength(3); // ceil(2300 / 1000)

		// The complement-DELETE prunes all 40,000 stale page ids, split into two
		// bounded statements (30,000 + 10,000) so no single DELETE exceeds the ceiling.
		const pageDeletes = client.queries.filter((entry) => entry.query.includes("DELETE FROM project_pages"));
		expect(pageDeletes).toHaveLength(2);
		for (const del of pageDeletes) {
			expect(del.query).toContain("page_index IN");
			expect(del.query).not.toContain("NOT IN");
			expect(del.params.length).toBeLessThanOrEqual(30_001); // budget + project_id
		}
		// Total deleted ids across chunks = every stale id, exactly once.
		const deletedIds = pageDeletes.flatMap((del) => del.params.slice(1) as number[]);
		expect(deletedIds).toHaveLength(staleCount);
		expect(new Set(deletedIds).size).toBe(staleCount);
		expect(Math.min(...deletedIds)).toBe(pageCount); // first stale id
		expect(Math.max(...deletedIds)).toBe(pageCount + staleCount - 1);
	});

	test("deletes all rows for the project when the active set is empty", async () => {
		// Empty active set must delete every row for the project (no leftover NOT IN
		// placeholders), so emptying tasks/comments clears those tables.
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = createState();
		state.tasks = [];
		state.comments = [];

		await store.upsertProjectState(state);

		const taskDelete = client.queries.find((entry) => entry.query.includes("DELETE FROM project_tasks"));
		expect(taskDelete?.query).toBe("DELETE FROM project_tasks WHERE project_id = $1");
		expect(taskDelete?.params).toEqual([state.projectId]);
		// With no tasks there is no task INSERT at all.
		expect(client.queries.some((entry) => entry.query.includes("INSERT INTO project_tasks"))).toBe(false);
	});

	test("dedupes duplicate conflict keys within a batch, keeping the LAST occurrence (no 'cannot affect row a second time')", async () => {
		// A single multi-row INSERT ... ON CONFLICT DO UPDATE throws if the same
		// conflict key appears twice in one VALUES batch. The old per-row loop silently
		// last-wins. The batched path must reproduce last-wins by collapsing duplicates
		// before the INSERT — so the save never hard-fails on a duplicate id.
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = createState();
		// Two tasks share id "dup": the LAST (title "WINNER") must survive.
		state.tasks = [
			createTask("dup", "2026-05-28T01:00:00.000Z", "todo", "translate", 0),
			createTask("other", "2026-05-28T01:00:00.000Z", "todo", "translate", 0),
			{ ...createTask("dup", "2026-05-28T01:00:00.000Z", "done", "translate", 1), title: "WINNER" },
		];
		// Comments and version reviews also exercise dedup (last-wins).
		state.comments = [
			createComment("c-dup", "2026-05-28T01:00:00.000Z", "open", 0, "user-1"),
			{ ...createComment("c-dup", "2026-05-28T01:00:00.000Z", "resolved", 0, "user-1"), body: "C-WINNER" },
		];
		state.reviewDecisions = [
			createDecision("d-dup", "2026-05-28T01:00:00.000Z", "approved", 0, "user-2"),
			{ ...createDecision("d-dup", "2026-05-28T01:00:00.000Z", "changes_requested", 0, "user-2"), body: "D-WINNER" },
		];
		state.versionReviewRequests = [
			{ id: "v-dup", versionId: "version-1", status: "open", requester: "user-1", mentions: [], createdAt: "2026-05-28T01:00:00.000Z", updatedAt: "2026-05-28T01:00:00.000Z" },
			{ id: "v-dup", versionId: "version-2", status: "approved", requester: "user-1", mentions: [], body: "V-WINNER", createdAt: "2026-05-28T01:00:00.000Z", updatedAt: "2026-05-28T01:00:00.000Z" },
		];

		await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

		// Tasks: one INSERT carrying TWO rows (dup collapsed), 14 cols * 2 = 28 params.
		const taskInsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_tasks"));
		expect(countValueTuples(taskInsert!.query)).toBe(2);
		expect(taskInsert?.params).toHaveLength(28);
		// task_id is column 1 of each tuple -> params[0] and params[14].
		expect(taskInsert?.params[0]).toBe("dup"); // surviving "dup" sits in first-seen slot
		expect(taskInsert?.params[14]).toBe("other");
		// The surviving "dup" is the LAST occurrence: title (column 8) is "WINNER".
		expect(taskInsert?.params[7]).toBe("WINNER");
		// metadata jsonb (column 12) is the LAST task object too (status "done").
		expect(JSON.parse(taskInsert?.params[11] as string).status).toBe("done");

		// Comments: dup collapsed to one row; body is the LAST ("C-WINNER").
		const commentInsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_comments"));
		expect(countValueTuples(commentInsert!.query)).toBe(1);
		expect(commentInsert?.params[6]).toBe("C-WINNER"); // body is column 7

		// Review decisions: dup collapsed; body is the LAST ("D-WINNER").
		const decisionInsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_review_decisions"));
		expect(countValueTuples(decisionInsert!.query)).toBe(1);
		expect(decisionInsert?.params[5]).toBe("D-WINNER"); // body is column 6

		// Version reviews: dup collapsed; version_id is the LAST ("version-2").
		const reviewInsert = client.queries.find((entry) => entry.query.includes("INSERT INTO project_version_reviews"));
		expect(countValueTuples(reviewInsert!.query)).toBe(1);
		expect(reviewInsert?.params[1]).toBe("version-2"); // version_id is column 2
	});

	test("starts a new INSERT chunk when a wide variable-width row would exceed the param budget (mentions array)", async () => {
		// A text[] column (version-review mentions) binds one param PER element, so
		// chunking by row count alone can blow the 65535 ceiling. The param-aware
		// chunker must split BEFORE the running bind total crosses ~60,000 even when
		// the row count is far under 1000.
		const client = new FakeCatalogSqlClient();
		const store = new PostgresProjectCatalogStore(client);
		const state = createState();
		state.pages = [];
		state.tasks = [];
		state.comments = [];
		state.reviewDecisions = [];
		// Each review carries 35,000 mentions (35,000 binds) + 12 scalar cols = 35,012
		// binds. Two such rows (70,024) exceed the 60,000-param budget, so each lands in
		// its OWN statement: 3 rows -> 3 INSERTs. Critically, no single statement
		// crosses Postgres' hard 65535 ceiling — which a row-count-only chunker would.
		const wideMentions = Array.from({ length: 35_000 }, (_, i) => `@user-${i}`);
		state.versionReviewRequests = Array.from({ length: 3 }, (_, index) => ({
			id: `vr-${index}`,
			versionId: `version-${index}`,
			status: "open" as const,
			requester: "user-1",
			mentions: wideMentions,
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		}));

		await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

		const reviewInserts = client.queries.filter((entry) => entry.query.includes("INSERT INTO project_version_reviews"));
		// Two wide rows already exceed the 60,000-param budget, so each row gets its
		// own statement: exactly 3 INSERTs.
		expect(reviewInserts).toHaveLength(3);
		// CRITICAL: no single INSERT exceeds Postgres' hard 65535 bind ceiling. A
		// row-count-only chunker would have batched all 3 (~105,036 binds) and failed.
		for (const insert of reviewInserts) {
			expect(insert.params.length).toBeLessThanOrEqual(65_535);
			expect(countValueTuples(insert.query)).toBe(1); // one wide row per statement
		}
		// Every row is still persisted exactly once (3 rows total across the chunks).
		expect(reviewInserts.reduce((sum, insert) => sum + countValueTuples(insert.query), 0)).toBe(3);
	});
});

// Counts the number of VALUES row tuples in a multi-row INSERT clause. Each row
// is a depth-0 "(...)" group after the VALUES keyword; ARRAY[...] columns use
// square brackets so they never open a paren. Robust to whitespace in the join.
function countValueTuples(query: string): number {
	const valuesAt = query.indexOf("VALUES");
	const body = valuesAt >= 0 ? query.slice(valuesAt + "VALUES".length) : query;
	// Stop at the ON CONFLICT clause so trailing parens there are not counted.
	const conflictAt = body.indexOf("ON CONFLICT");
	const tupleBody = conflictAt >= 0 ? body.slice(0, conflictAt) : body;
	let depth = 0;
	let tuples = 0;
	for (const ch of tupleBody) {
		if (ch === "(") {
			if (depth === 0) tuples += 1;
			depth += 1;
		} else if (ch === ")") {
			depth -= 1;
		}
	}
	return tuples;
}

function createSummary(projectId: string, name: string, updatedAt: string): ProjectSummary {
	return {
		projectId,
		name,
		createdAt: "2026-05-28T01:00:00.000Z",
		updatedAt,
		targetLang: "th",
		targetLangs: ["th"],
		pageCount: 0,
		textLayerCount: 0,
		taskCount: 0,
		openTaskCount: 0,
		reviewTaskCount: 0,
		commentCount: 0,
		openCommentCount: 0,
	};
}

function createVersion(versionId: string, createdAt: string): ProjectVersionMetadata {
	return {
		versionId,
		projectId: "project-1",
		name: versionId,
		source: "save",
		createdAt,
		pageCount: 1,
		textLayerCount: 1,
	};
}

function createPageSummary(pageIndex: number, status: string): ProjectPageSummary {
	return {
		projectId: "project-1",
		pageId: `project-1:page:${pageIndex}`,
		pageIndex,
		imageId: `image-${pageIndex}`,
		status,
		imageName: `page-${pageIndex}.png`,
		textLayerCount: 0,
		imageLayerCount: 0,
		pendingAiJobCount: 0,
		createdAt: "2026-05-28T01:00:00.000Z",
		updatedAt: "2026-05-28T01:00:00.000Z",
	};
}

function createTask(
	id: string,
	updatedAt: string,
	status: WorkflowTask["status"],
	type: WorkflowTask["type"],
	pageIndex: number,
	assignee?: string,
): WorkflowTask {
	return {
		id,
		type,
		status,
		priority: "normal",
		pageIndex,
		title: id,
		assignee,
		createdAt: "2026-05-28T01:00:00.000Z",
		updatedAt,
	};
}

function createComment(
	id: string,
	updatedAt: string,
	status: ProjectComment["status"],
	pageIndex: number,
	author: string,
	layerId?: string,
): ProjectComment {
	return {
		id,
		pageIndex,
		layerId,
		body: id,
		author,
		mentions: [],
		status,
		createdAt: "2026-05-28T01:00:00.000Z",
		updatedAt,
	};
}

function createDecision(
	id: string,
	updatedAt: string,
	status: PageReviewDecision["status"],
	pageIndex: number,
	actor: string,
): PageReviewDecision {
	return {
		id,
		pageIndex,
		status,
		actor,
		createdAt: "2026-05-28T01:00:00.000Z",
		updatedAt,
	};
}

function createState(): ProjectState {
	return {
		projectId: "11111111-1111-4111-8111-111111111111",
		userId: "user-1",
		name: "Chapter 1",
		createdAt: "2026-05-28T01:00:00.000Z",
		storyTitle: "Series",
		chapterLabel: "ตอน 1",
		pages: [{
			imageId: "page-1.png",
			imageName: "page-1.png",
			originalName: "page-1-original.png",
			textLayers: [{
				id: "text-1",
				text: "hello",
				x: 1,
				y: 2,
				w: 100,
				h: 40,
				rotation: 0,
				fontSize: 24,
				alignment: "center",
				index: 0,
			}],
			pendingAiJobs: [],
			coverRect: null,
			translationHandoff: {
				status: "translated",
				updatedAt: "2026-05-28T01:10:00.000Z",
			},
		}, {
			imageId: "page-2.png",
			imageName: "page-2.png",
			textLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		}],
		currentPage: 0,
		targetLang: "th",
		tasks: [{
			id: "task-1",
			type: "translate",
			status: "todo",
			priority: "high",
			pageIndex: 0,
			title: "Translate page 1",
			assignee: "user-1",
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		}, {
			id: "task-2",
			type: "review",
			status: "done",
			priority: "normal",
			pageIndex: 1,
			title: "Review page 2",
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		}],
		comments: [{
			id: "comment-1",
			pageIndex: 0,
			body: "check this",
			author: "user-1",
			mentions: ["user-2"],
			status: "open",
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		}],
		reviewDecisions: [{
			id: "review-1",
			pageIndex: 0,
			status: "changes_requested",
			body: "fix",
			actor: "user-2",
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		}],
		versionReviewRequests: [{
			id: "version-review-1",
			versionId: "version-1",
			status: "open",
			body: "please review",
			requester: "user-1",
			reviewer: "user-2",
			mentions: ["user-2"],
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		}],
	};
}

describe("FileProjectCatalogStore (file-mode fallback)", () => {
	// Mirrors the FileWorkspaceAccessStore file-store tests from PR #132: drive a
	// real on-disk projects dir plus the file-backed workspace access store so the
	// project-create/list/get flow works without Postgres (no 503).
	function freshProjectsDir(): string {
		return mkdtempSync(join(tmpdir(), "file-project-catalog-"));
	}

	function writeState(projectsDir: string, state: ProjectState): void {
		const dir = join(projectsDir, state.projectId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
	}

	function workspaceProject(overrides: Partial<ProjectState> & { projectId: string; workspaceId: string }): ProjectState {
		return { ...createState(), ...overrides };
	}

	test("getProjectState / findExistingProjectIds read persisted state files", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const store = new FileProjectCatalogStore(projectsDir, access);
		const state = createState();
		writeState(projectsDir, state);

		const loaded = await store.getProjectState(state.projectId);
		expect(loaded?.projectId).toBe(state.projectId);
		expect(loaded?.name).toBe("Chapter 1");

		const existing = await store.findExistingProjectIds([state.projectId, "00000000-0000-4000-8000-000000000000"]);
		expect(existing.has(state.projectId)).toBe(true);
		expect(existing.has("00000000-0000-4000-8000-000000000000")).toBe(false);
	});

	test("a freshly created workspace project persists and is gettable (the 503-class flow)", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		// File-mode auto-provisions a personal workspace; the owner can manage projects.
		const [ws] = await access.listUserWorkspaces("owner-1");
		const workspaceId = ws!.workspaceId;
		const store = new FileProjectCatalogStore(projectsDir, access);

		// Simulate the route's writeProjectState: state.json on disk.
		const project = workspaceProject({
			projectId: "22222222-2222-4222-8222-222222222222",
			workspaceId,
			userId: "owner-1",
		});
		writeState(projectsDir, project);
		// The route's catalog upsert is a no-op here (files are the source of truth).
		await store.upsertProjectState(project);

		expect((await store.getProjectState(project.projectId))?.workspaceId).toBe(workspaceId);
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "owner-1", permission: "read:project" })).toBe(true);
		const ids = await store.listProjectIdsForWorkspace(workspaceId);
		expect(ids).toContain(project.projectId);
	});

	test("canAccessProject denies non-members; owner may access", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const [ws] = await access.listUserWorkspaces("owner-2");
		const workspaceId = ws!.workspaceId;
		const store = new FileProjectCatalogStore(projectsDir, access);
		const project = workspaceProject({
			projectId: "33333333-3333-4333-8333-333333333333",
			workspaceId,
			userId: "owner-2",
		});
		writeState(projectsDir, project);

		expect(await store.canAccessProject({ projectId: project.projectId, userId: "owner-2", permission: "update:project" })).toBe(true);
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "stranger", permission: "read:project" })).toBe(false);
	});

	// CENTRAL FREEZE GATE (PR #414 P0): a suspended workspace must deny EVERY mutating
	// project permission through the catalog authorization path (the path every
	// major mutating route uses — save/comments/tasks/review/AI/import/export), for
	// EVERYONE including the owner, while reads still pass.
	test("a suspended workspace denies mutating permissions via canAccessProject for everyone; reads still pass", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const [ws] = await access.listUserWorkspaces("frozen-owner");
		const workspaceId = ws!.workspaceId;
		const store = new FileProjectCatalogStore(projectsDir, access);
		const project = workspaceProject({
			projectId: "44444444-4444-4444-8444-444444444444",
			workspaceId,
			userId: "frozen-owner",
		});
		writeState(projectsDir, project);

		// Before freeze: owner can mutate + read.
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "update:project" })).toBe(true);
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "generate:ai" })).toBe(true);
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "export:project" })).toBe(true);

		await access.setWorkspaceSuspension({ workspaceId, suspend: true, reason: "payment_refund" });

		// After freeze: EVERY mutating permission denied (even for the owner).
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "update:project" })).toBe(false);
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "generate:ai" })).toBe(false);
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "import:project" })).toBe(false);
		// export:project (manual usage metering route) is a mutating/billable op → denied.
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "export:project" })).toBe(false);
		// Reads still pass — members can see their work + the restore notice.
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "read:project" })).toBe(true);
		// The bulk evaluator (resolveProjectAccessContext) mirrors the same decision.
		const ctx = await store.resolveProjectAccessContext({ projectId: project.projectId, userId: "frozen-owner", permission: "update:project" });
		expect(ctx?.canAccessBaseline).toBe(false);
		expect(ctx?.allows({})).toBe(false);

		// Unfreeze restores mutating access.
		await access.setWorkspaceSuspension({ workspaceId, suspend: false });
		expect(await store.canAccessProject({ projectId: project.projectId, userId: "frozen-owner", permission: "update:project" })).toBe(true);
	});

	// A member suspended in ONE workspace must NOT be blocked in a DIFFERENT,
	// non-suspended workspace — the freeze is per-workspace, not per-user.
	test("a suspended workspace does not block the same user in a different non-suspended workspace", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		// User owns their auto-provisioned personal workspace (A) + a second one (B).
		const [wsA] = await access.listUserWorkspaces("multi-ws-user");
		const workspaceA = wsA!.workspaceId;
		const workspaceB = "ws-not-frozen-414";
		await access.createWorkspace({ workspaceId: workspaceB, name: "Other WS", ownerUserId: "multi-ws-user" });
		const store = new FileProjectCatalogStore(projectsDir, access);

		const projectA = workspaceProject({ projectId: "55555555-5555-4555-8555-555555555555", workspaceId: workspaceA, userId: "multi-ws-user" });
		const projectB = workspaceProject({ projectId: "66666666-6666-4666-8666-666666666666", workspaceId: workspaceB, userId: "multi-ws-user" });
		writeState(projectsDir, projectA);
		writeState(projectsDir, projectB);

		await access.setWorkspaceSuspension({ workspaceId: workspaceA, suspend: true, reason: "chargeback" });

		// A (frozen) blocks mutation; B (not frozen) still allows it.
		expect(await store.canAccessProject({ projectId: projectA.projectId, userId: "multi-ws-user", permission: "update:project" })).toBe(false);
		expect(await store.canAccessProject({ projectId: projectB.projectId, userId: "multi-ws-user", permission: "update:project" })).toBe(true);
	});

	test("resolveProjectAccessContext resolves membership ONCE for a bulk batch (file-mode N+1 fix)", async () => {
		const projectsDir = freshProjectsDir();
		// Wrap the file workspace store so getMember returns a page/translate-scoped
		// editor and COUNTS how often it is consulted. The bulk path must consult it
		// exactly once for the whole batch, not once per task.
		const access = new FileWorkspaceAccessStore();
		let getMemberCalls = 0;
		const scopedMember: WorkspaceMemberRecord = {
			workspaceId: "ws-bulk",
			userId: "member-bulk",
			role: "editor",
			scope: { projectIds: ["88888888-8888-4888-8888-888888888888"], pageIndexes: [0], taskTypes: ["translate"] },
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		};
		access.getMember = (async (workspaceId: string, userId: string) => {
			getMemberCalls += 1;
			return workspaceId === scopedMember.workspaceId && userId === scopedMember.userId ? { ...scopedMember } : null;
		}) as typeof access.getMember;
		const store = new FileProjectCatalogStore(projectsDir, access);
		const project = workspaceProject({
			projectId: "88888888-8888-4888-8888-888888888888",
			workspaceId: "ws-bulk",
			userId: "owner-bulk",
			// targetLang defaults to "th" via createState.
		});
		writeState(projectsDir, project);

		const inScopeCheck = { pageIndex: 0, taskType: "translate", resourceKind: "task" as const };
		const outOfScopeCheck = { pageIndex: 1, taskType: "review", resourceKind: "task" as const };

		// Baseline (old per-task path): one getMember consult per task.
		getMemberCalls = 0;
		const baselineAllowed = await store.canAccessProject({ projectId: project.projectId, userId: "member-bulk", permission: "update:project", ...inScopeCheck });
		const baselineDenied = await store.canAccessProject({ projectId: project.projectId, userId: "member-bulk", permission: "update:project", ...outOfScopeCheck });
		expect(baselineAllowed).toBe(true);
		expect(baselineDenied).toBe(false);
		expect(getMemberCalls).toBe(2);

		// New (bulk) path: resolve ONCE, evaluate each task in-memory.
		getMemberCalls = 0;
		const context = await store.resolveProjectAccessContext({ projectId: project.projectId, userId: "member-bulk", permission: "update:project" });
		expect(context).not.toBeNull();
		expect(context!.allows(inScopeCheck)).toBe(baselineAllowed);
		expect(context!.allows(outOfScopeCheck)).toBe(baselineDenied);
		// Even with many per-task checks, membership was consulted exactly once.
		context!.allows({ pageIndex: 0, taskType: "translate", resourceKind: "task" });
		context!.allows({ pageIndex: 2, taskType: "translate", resourceKind: "task" });
		expect(getMemberCalls).toBe(1);
	});

	test("personal (no workspaceId) projects are scoped to their owner", async () => {
		const projectsDir = freshProjectsDir();
		const store = new FileProjectCatalogStore(projectsDir, new FileWorkspaceAccessStore());
		const personal: ProjectState = { ...createState(), projectId: "44444444-4444-4444-8444-444444444444", userId: "solo", workspaceId: undefined };
		writeState(projectsDir, personal);

		expect(await store.canAccessProject({ projectId: personal.projectId, userId: "solo", permission: "read:project" })).toBe(true);
		expect(await store.canAccessProject({ projectId: personal.projectId, userId: "someone-else", permission: "read:project" })).toBe(false);
	});

	test("listProjectSummaryPage returns the owner's projects and derives summary counts", async () => {
		const projectsDir = freshProjectsDir();
		const store = new FileProjectCatalogStore(projectsDir, new FileWorkspaceAccessStore());
		const personal: ProjectState = { ...createState(), projectId: "55555555-5555-4555-8555-555555555555", userId: "lister", workspaceId: undefined };
		writeState(projectsDir, personal);

		const page = await store.listProjectSummaryPage({ userId: "lister" });
		expect(page.projects).toHaveLength(1);
		const summary = page.projects[0]!;
		expect(summary.projectId).toBe(personal.projectId);
		expect(summary.pageCount).toBe(2);
		expect(summary.textLayerCount).toBe(1);
		expect(summary.taskCount).toBe(2);
		expect(summary.commentCount).toBe(1);
	});

	test("listProjectSummaryPage shows task-scoped members the workspace library while write scope stays enforced", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const workspaceId = "ws-task-library";
		const workerId = "scoped-cleaner";
		await access.createWorkspace({ workspaceId, name: "Task Library", ownerUserId: "owner-task-library" });
		const originalGetMember = access.getMember.bind(access);
		const scopedMember: WorkspaceMemberRecord = {
			workspaceId,
			userId: workerId,
			role: "editor",
			scope: { taskTypes: ["clean"], aiCreditPolicy: "job_scoped" },
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		};
		access.getMember = (async (candidateWorkspaceId: string, candidateUserId: string) => {
			if (candidateWorkspaceId === workspaceId && candidateUserId === workerId) return { ...scopedMember };
			return originalGetMember(candidateWorkspaceId, candidateUserId);
		}) as typeof access.getMember;
		const store = new FileProjectCatalogStore(projectsDir, access);
		const projectA = workspaceProject({
			projectId: "77777777-7777-4777-8777-777777777771",
			workspaceId,
			userId: "owner-task-library",
			name: "Chapter A",
		});
		const projectB = workspaceProject({
			projectId: "77777777-7777-4777-8777-777777777772",
			workspaceId,
			userId: "owner-task-library",
			name: "Chapter B",
		});
		writeState(projectsDir, projectA);
		writeState(projectsDir, projectB);

		const page = await store.listProjectSummaryPage({ userId: workerId, workspaceId });
		expect(page.projects.map((project) => project.projectId).sort()).toEqual([projectA.projectId, projectB.projectId].sort());
		expect(await store.canAccessProject({ projectId: projectA.projectId, userId: workerId, permission: "update:project" })).toBe(false);
		expect(await store.canAccessProject({
			projectId: projectA.projectId,
			userId: workerId,
			permission: "update:project",
			taskType: "clean",
			resourceKind: "task",
		})).toBe(true);
		expect(await store.canAccessProject({
			projectId: projectA.projectId,
			userId: workerId,
			permission: "update:project",
			taskType: "translate",
			resourceKind: "task",
		})).toBe(false);
	});

	test("listProjectSummaryPage allows asset-only library visibility but keeps asset reads scoped", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const workspaceId = "ws-asset-library";
		const workerId = "asset-worker";
		await access.createWorkspace({ workspaceId, name: "Asset Library", ownerUserId: "owner-asset-library" });
		const originalGetMember = access.getMember.bind(access);
		const scopedMember: WorkspaceMemberRecord = {
			workspaceId,
			userId: workerId,
			role: "editor",
			scope: { assetPurposes: ["editor_preview"] },
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		};
		access.getMember = (async (candidateWorkspaceId: string, candidateUserId: string) => {
			if (candidateWorkspaceId === workspaceId && candidateUserId === workerId) return { ...scopedMember };
			return originalGetMember(candidateWorkspaceId, candidateUserId);
		}) as typeof access.getMember;
		const store = new FileProjectCatalogStore(projectsDir, access);
		const project = workspaceProject({
			projectId: "88888888-8888-4888-8888-888888888881",
			workspaceId,
			userId: "owner-asset-library",
		});
		writeState(projectsDir, project);

		const page = await store.listProjectSummaryPage({ userId: workerId, workspaceId });
		expect(page.projects.map((summary) => summary.projectId)).toEqual([project.projectId]);
		expect(await store.canAccessProject({
			projectId: project.projectId,
			userId: workerId,
			permission: "read:project",
			resourceKind: "asset",
		})).toBe(false);
		expect(await store.canAccessProject({
			projectId: project.projectId,
			userId: workerId,
			permission: "read:project",
			assetPurpose: "editor_preview",
			resourceKind: "asset",
		})).toBe(true);
		expect(await store.canAccessProject({
			projectId: project.projectId,
			userId: workerId,
			permission: "read:project",
			assetPurpose: "source_page",
			resourceKind: "asset",
		})).toBe(false);
	});

	test("listProjectSummaryPage filters chapter-scoped members to their chapter projects even with page/task scope", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const workspaceId = "ws-chapter-library";
		const workerId = "chapter-worker";
		await access.createWorkspace({ workspaceId, name: "Chapter Library", ownerUserId: "owner-chapter-library" });
		const projectA = workspaceProject({
			projectId: "99999999-9999-4999-8999-999999999991",
			workspaceId,
			userId: "owner-chapter-library",
			name: "Visible Chapter",
		});
		const projectB = workspaceProject({
			projectId: "99999999-9999-4999-8999-999999999992",
			workspaceId,
			userId: "owner-chapter-library",
			name: "Hidden Chapter",
		});
		const originalGetMember = access.getMember.bind(access);
		const scopedMember: WorkspaceMemberRecord = {
			workspaceId,
			userId: workerId,
			role: "editor",
			scope: { chapterIds: [projectA.projectId], pageIndexes: [0], taskTypes: ["translate"] },
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		};
		access.getMember = (async (candidateWorkspaceId: string, candidateUserId: string) => {
			if (candidateWorkspaceId === workspaceId && candidateUserId === workerId) return { ...scopedMember };
			return originalGetMember(candidateWorkspaceId, candidateUserId);
		}) as typeof access.getMember;
		const store = new FileProjectCatalogStore(projectsDir, access);
		writeState(projectsDir, projectA);
		writeState(projectsDir, projectB);

		const page = await store.listProjectSummaryPage({ userId: workerId, workspaceId });
		expect(page.projects.map((summary) => summary.projectId)).toEqual([projectA.projectId]);
		expect(await store.canAccessProject({
			projectId: projectB.projectId,
			userId: workerId,
			permission: "read:project",
			chapterId: projectB.projectId,
		})).toBe(false);
	});

	test("listProjectSummaryPage does not expose page-only scopes as whole-project summaries", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const workspaceId = "ws-page-library";
		const workerId = "page-worker";
		await access.createWorkspace({ workspaceId, name: "Page Library", ownerUserId: "owner-page-library" });
		const originalGetMember = access.getMember.bind(access);
		const scopedMember: WorkspaceMemberRecord = {
			workspaceId,
			userId: workerId,
			role: "editor",
			scope: { pageIndexes: [0], taskTypes: ["translate"] },
			createdAt: "2026-05-28T01:00:00.000Z",
			updatedAt: "2026-05-28T01:00:00.000Z",
		};
		access.getMember = (async (candidateWorkspaceId: string, candidateUserId: string) => {
			if (candidateWorkspaceId === workspaceId && candidateUserId === workerId) return { ...scopedMember };
			return originalGetMember(candidateWorkspaceId, candidateUserId);
		}) as typeof access.getMember;
		const store = new FileProjectCatalogStore(projectsDir, access);
		const project = workspaceProject({
			projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
			workspaceId,
			userId: "owner-page-library",
		});
		writeState(projectsDir, project);

		const page = await store.listProjectSummaryPage({ userId: workerId, workspaceId });
		expect(page.projects).toEqual([]);
		expect(await store.canAccessProject({
			projectId: project.projectId,
			userId: workerId,
			permission: "read:project",
			pageIndex: 0,
			taskType: "translate",
			resourceKind: "task",
		})).toBe(true);
	});

	test("listProjectSummaryPage(workspaceId) bounds the listing to one workspace AT THE SOURCE", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		// A user who owns TWO personal workspaces (so the catalog can see projects in
		// both). The workspace-home aggregate must never page the user's projects in
		// the OTHER workspace when building one workspace's dashboard.
		const [wsA] = await access.listUserWorkspaces("multi-user");
		const workspaceA = wsA!.workspaceId;
		const workspaceB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		await access.createWorkspace({ workspaceId: workspaceB, name: "Second WS", ownerUserId: "multi-user" });
		const store = new FileProjectCatalogStore(projectsDir, access);

		// 1 project in the target workspace, MANY in the other workspace.
		const targetProject = workspaceProject({
			projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			workspaceId: workspaceA,
			userId: "multi-user",
		});
		writeState(projectsDir, targetProject);
		for (let i = 0; i < 30; i += 1) {
			writeState(projectsDir, workspaceProject({
				projectId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
				workspaceId: workspaceB,
				userId: "multi-user",
			}));
		}

		// Scoped to workspace A: ONLY workspace A's single project, regardless of how
		// many projects exist in workspace B.
		const pageA = await store.listProjectSummaryPage({ userId: "multi-user", workspaceId: workspaceA });
		expect(pageA.projects.map((p) => p.projectId)).toEqual([targetProject.projectId]);
		expect(pageA.projects.every((p) => p.workspaceId === workspaceA)).toBe(true);

		// An EMPTY workspace returns nothing — and (the keystone) does not page the
		// user's other-workspace projects to discover that it's empty.
		const emptyWs = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		await access.createWorkspace({ workspaceId: emptyWs, name: "Empty WS", ownerUserId: "multi-user" });
		const pageEmpty = await store.listProjectSummaryPage({ userId: "multi-user", workspaceId: emptyWs });
		expect(pageEmpty.projects).toEqual([]);
		expect(pageEmpty.nextCursor).toBeUndefined();
	});

	test("listProjectSummaryPage(workspaceId,limit) is BOUNDED — it does not read every project state", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const [wsA] = await access.listUserWorkspaces("bound-user");
		const workspaceA = wsA!.workspaceId;
		const workspaceB = "11111111-1111-4111-8111-111111111111";
		await access.createWorkspace({ workspaceId: workspaceB, name: "Other WS", ownerUserId: "bound-user" });
		const store = new FileProjectCatalogStore(projectsDir, access);

		// A handful of target-workspace projects, plus MANY in another workspace. The
		// bound must keep the per-call state.json reads close to the page size, not
		// the whole disk — a future regression that reverts to allProjectStates()
		// would read all 80+ states. Write the OTHER workspace's projects first so the
		// target projects carry the most recent state.json mtimes and therefore sort
		// to the front of the (mtime-DESC) page — the realistic "resume recent work"
		// ordering the dashboard relies on.
		const OTHER_COUNT = 80;
		for (let i = 0; i < OTHER_COUNT; i += 1) {
			writeState(projectsDir, workspaceProject({
				projectId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
				workspaceId: workspaceB,
				userId: "bound-user",
			}));
		}
		const targetIds: string[] = [];
		for (let i = 0; i < 6; i += 1) {
			const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;
			targetIds.push(id);
			writeState(projectsDir, workspaceProject({ projectId: id, workspaceId: workspaceA, userId: "bound-user" }));
			// Stamp a strictly-future mtime so the target projects are unambiguously the
			// most recent (file-write timestamps in a tight loop can otherwise tie at
			// the same millisecond, leaving the projectId tiebreak in charge).
			const future = new Date(Date.now() + (i + 1) * 60_000);
			utimesSync(join(projectsDir, id, "state.json"), future, future);
		}

		// Spy on the private state reader to count how many state.json files get parsed.
		const spied = store as unknown as { readState(projectId: string): ProjectState | null };
		const originalReadState = spied.readState.bind(store);
		let reads = 0;
		spied.readState = (projectId: string) => {
			reads += 1;
			return originalReadState(projectId);
		};

		reads = 0;
		const page = await store.listProjectSummaryPage({ userId: "bound-user", workspaceId: workspaceA, limit: 3 });

		// Correctness: a bounded page of the target workspace's projects only.
		expect(page.projects.length).toBe(3);
		expect(page.projects.every((p) => p.workspaceId === workspaceA)).toBe(true);
		expect(page.nextCursor).toBeTruthy();

		// Boundedness: the read count is on the order of the page (it stops at
		// limit + 1 MATCHING summaries). Because the target projects are the most
		// recently written, they sort first, so reads stay tiny — and crucially it
		// NEVER reads all (6 + 80) project states the way a full scan would.
		expect(reads).toBeLessThanOrEqual(8);
		expect(reads).toBeLessThan(6 + OTHER_COUNT);
	});

	test("list pages/tasks/comments/review decisions derive from the on-disk state", async () => {
		const projectsDir = freshProjectsDir();
		const store = new FileProjectCatalogStore(projectsDir, new FileWorkspaceAccessStore());
		const state = createState();
		writeState(projectsDir, state);

		expect((await store.listProjectPages({ projectId: state.projectId })).pages).toHaveLength(2);
		const tasks = await store.listProjectTasks({ projectId: state.projectId });
		expect(tasks.tasks.map((t) => t.id).sort()).toEqual(["task-1", "task-2"]);
		expect((await store.listProjectComments({ projectId: state.projectId })).comments).toHaveLength(1);
		expect((await store.listProjectReviewDecisions({ projectId: state.projectId })).decisions).toHaveLength(1);
	});

	test("missing project returns null/empty pages, not a throw", async () => {
		const store = new FileProjectCatalogStore(freshProjectsDir(), new FileWorkspaceAccessStore());
		expect(await store.getProjectState("66666666-6666-4666-8666-666666666666")).toBeNull();
		expect((await store.listProjectPages({ projectId: "66666666-6666-4666-8666-666666666666" })).pages).toEqual([]);
		expect(await store.canAccessProject({ projectId: "66666666-6666-4666-8666-666666666666", userId: "x", permission: "read:project" })).toBe(false);
	});

	test("getProjectVersion reads a persisted version file and rejects path-traversal ids", async () => {
		const projectsDir = freshProjectsDir();
		const store = new FileProjectCatalogStore(projectsDir, new FileWorkspaceAccessStore());
		const state = createState();
		const versionId = "2026-05-28T01-00-00-000Z_v1";
		const versionsDir = join(projectsDir, state.projectId, "versions");
		mkdirSync(versionsDir, { recursive: true });
		const metadata: ProjectVersionMetadata = {
			versionId,
			projectId: state.projectId,
			name: state.name,
			source: "save",
			createdAt: "2026-05-28T01:00:00.000Z",
			pageCount: state.pages.length,
			textLayerCount: 1,
		};
		writeFileSync(join(versionsDir, `${versionId}.json`), JSON.stringify({ metadata, state }, null, 2));
		writeState(projectsDir, state);

		const record = await store.getProjectVersion(state.projectId, versionId);
		expect(record?.metadata.versionId).toBe(versionId);
		expect(record?.state.projectId).toBe(state.projectId);

		const list = await store.listProjectVersions({ projectId: state.projectId });
		expect(list.versions.map((v) => v.versionId)).toContain(versionId);

		// Malformed ids never resolve a file (defense-in-depth alongside safePath).
		expect(await store.getProjectVersion(state.projectId, "../../etc/passwd")).toBeNull();
	});

	// #356 re-review P1: the create-project gate must resolve storyId ownership
	// AUTHORITATIVELY (uncapped) — the previous visible-list scan stopped after a cap
	// (1000), so a foreign storyId on a project that sorted PAST the cap was misread as
	// "new" and the cross-workspace merge was persisted. resolveStoryIdOwnership scans
	// EVERY project, so the owning workspace is found regardless of project count.
	describe("resolveStoryIdOwnership (authoritative, uncapped)", () => {
		function ownershipProject(overrides: Partial<ProjectState> & { projectId: string }): ProjectState {
			return { ...createState(), ...overrides };
		}

		test("finds a workspace owner even when the bearing project sorts PAST the old 1000 scan cap", async () => {
			const projectsDir = freshProjectsDir();
			const store = new FileProjectCatalogStore(projectsDir, new FileWorkspaceAccessStore());
			const foreignStoryId = "story-foreign-past-cap";

			// 1200 decoy projects (well past the old 1000 cap) so a capped scan that stopped
			// early could easily never reach the one bearing the foreign storyId.
			for (let i = 0; i < 1200; i += 1) {
				writeState(projectsDir, ownershipProject({
					projectId: crypto.randomUUID(),
					workspaceId: "ws-decoy",
					userId: "decoy-owner",
					storyId: `story-decoy-${i}`,
				}));
			}
			// The single foreign-owned project bearing the target storyId.
			writeState(projectsDir, ownershipProject({
				projectId: crypto.randomUUID(),
				workspaceId: "ws-foreign",
				userId: "foreign-owner",
				storyId: foreignStoryId,
			}));

			const ownership = await store.resolveStoryIdOwnership(foreignStoryId);
			expect(ownership.exists).toBe(true);
			expect(ownership.workspaceIds).toEqual(["ws-foreign"]);
			expect(ownership.ownerUserIds).toEqual([]);
			expect(ownership.hasOwnerlessPersonal).toBe(false);
		});

		test("classifies workspace / personal / ownerless owners distinctly; unknown id is not-exists", async () => {
			const projectsDir = freshProjectsDir();
			const store = new FileProjectCatalogStore(projectsDir, new FileWorkspaceAccessStore());

			writeState(projectsDir, ownershipProject({
				projectId: crypto.randomUUID(),
				workspaceId: "ws-1",
				userId: "owner-1",
				storyId: "story-ws",
			}));
			// Personal (workspaceless) project — no explicit workspaceId.
			writeState(projectsDir, ownershipProject({
				projectId: crypto.randomUUID(),
				workspaceId: undefined,
				userId: "personal-user",
				storyId: "story-personal",
			}));
			// Ownerless legacy/anonymous personal project (no workspace, no userId).
			writeState(projectsDir, ownershipProject({
				projectId: crypto.randomUUID(),
				workspaceId: undefined,
				userId: "",
				storyId: "story-ownerless",
			}));

			const wsOwn = await store.resolveStoryIdOwnership("story-ws");
			expect(wsOwn.workspaceIds).toEqual(["ws-1"]);
			expect(wsOwn.ownerUserIds).toEqual([]);
			expect(wsOwn.hasOwnerlessPersonal).toBe(false);

			const personalOwn = await store.resolveStoryIdOwnership("story-personal");
			expect(personalOwn.workspaceIds).toEqual([]);
			expect(personalOwn.ownerUserIds).toEqual(["personal-user"]);
			expect(personalOwn.hasOwnerlessPersonal).toBe(false);

			const ownerlessOwn = await store.resolveStoryIdOwnership("story-ownerless");
			expect(ownerlessOwn.exists).toBe(true);
			expect(ownerlessOwn.workspaceIds).toEqual([]);
			expect(ownerlessOwn.ownerUserIds).toEqual([]);
			expect(ownerlessOwn.hasOwnerlessPersonal).toBe(true);

			const unknown = await store.resolveStoryIdOwnership("story-nonexistent");
			expect(unknown.exists).toBe(false);
			expect(unknown.workspaceIds).toEqual([]);
			expect(unknown.ownerUserIds).toEqual([]);
		});
	});
});

// Real-Postgres parity: proves the batched multi-row writes persist EXACTLY what
// the old per-row INSERTs did (save -> reload -> identical), that a large
// (>1000-row) save chunks correctly, and that re-saving a smaller state prunes
// removed rows. Gated on CATALOG_TEST_DATABASE_URL (a DB with the catalog
// migrations applied), so the default `bun test` run stays green without a DB.
//   CATALOG_TEST_DATABASE_URL=postgres://... bun test src/__tests__/project-catalog.test.ts
const CATALOG_TEST_DATABASE_URL = process.env.CATALOG_TEST_DATABASE_URL;

describe.skipIf(!CATALOG_TEST_DATABASE_URL)("PostgresProjectCatalogStore (real Postgres parity)", () => {
	function bigState(projectId: string, pageCount: number, taskCount: number): ProjectState {
		const base = createState();
		return {
			...base,
			projectId,
			pages: Array.from({ length: pageCount }, (_, index) => ({
				imageId: `image-${index}.png`,
				imageName: `page-${index}.png`,
				originalName: `orig-${index}.png`,
				textLayers: index % 2 === 0
					? [{ id: `t-${index}`, text: "hi", x: 0, y: 0, w: 10, h: 10, rotation: 0, fontSize: 12, alignment: "center" as const, index: 0 }]
					: [],
				pendingAiJobs: [],
				coverRect: null,
				translationHandoff: { status: "translated" as const, updatedAt: "2026-05-28T01:10:00.000Z" },
			})),
			tasks: Array.from({ length: taskCount }, (_, index) =>
				createTask(`task-${index}`, "2026-05-28T01:00:00.000Z", index % 3 === 0 ? "done" : "todo", "translate", index % Math.max(pageCount, 1), index % 2 === 0 ? "user-1" : undefined)),
		};
	}

	test("batched save round-trips identically, chunks a >1000-row save, and prunes on re-save", async () => {
		const url = CATALOG_TEST_DATABASE_URL!;
		const sql = new Bun.SQL(url) as unknown as ProjectCatalogSqlClient & { close?: () => Promise<void> };
		const store = new PostgresProjectCatalogStore(url);
		const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
		const cleanup = async () => {
			await sql.unsafe(`DELETE FROM projects WHERE project_id = $1`, [projectId]);
		};
		const tableCount = async (table: string): Promise<number> => {
			const rows = await sql.unsafe<{ c: number }>(`SELECT count(*)::int AS c FROM ${table} WHERE project_id = $1`, [projectId]);
			return rows[0]?.c ?? 0;
		};

		await cleanup();
		try {
			// (a) A multi-page/multi-task save with populated mentions persists and
			// reloads to the IDENTICAL state object (no double-encoding, no drift).
			const state = bigState(projectId, 6, 9);
			state.comments = [createComment("comment-1", "2026-05-28T01:00:00.000Z", "open", 0, "user-1", "layer-1")];
			state.comments[0].mentions = ["user-2", "qa"];
			state.comments[0].region = { x: 1, y: 2, w: 3, h: 4 };
			await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

			expect(await store.getProjectState(projectId)).toEqual(state);
			expect(await tableCount("project_pages")).toBe(6);
			expect(await tableCount("project_tasks")).toBe(9);
			const reloadedComments = await store.listProjectComments({ projectId, limit: 100 });
			expect(reloadedComments.comments[0]?.mentions).toEqual(["user-2", "qa"]);
			expect(reloadedComments.comments[0]?.region).toEqual({ x: 1, y: 2, w: 3, h: 4 });

			// (b) Chunking: a save well over the 1000-row chunk size persists every row.
			const large = bigState(projectId, 1500, 2300);
			await store.upsertProjectState(large, { updatedAt: "2026-05-28T03:00:00.000Z" });
			expect(await tableCount("project_pages")).toBe(1500);
			expect(await tableCount("project_tasks")).toBe(2300);

			// (c) Re-saving a smaller state prunes the removed rows and applies edits.
			const smaller = bigState(projectId, 700, 900);
			smaller.tasks[1].title = "EDITED";
			await store.upsertProjectState(smaller, { updatedAt: "2026-05-28T04:00:00.000Z" });
			expect(await tableCount("project_pages")).toBe(700);
			expect(await tableCount("project_tasks")).toBe(900);
			// The edit lands on the per-row task column (read it directly rather than
			// through the page-capped list helper) and the full reloaded state matches.
			const editedTaskRows = await sql.unsafe<{ title: string }>(
				`SELECT title FROM project_tasks WHERE project_id = $1 AND task_id = 'task-1'`,
				[projectId],
			);
			expect(editedTaskRows[0]?.title).toBe("EDITED");
			expect(await store.getProjectState(projectId)).toEqual(smaller);
		} finally {
			await cleanup();
			await sql.close?.();
		}
	}, 60000);

	test("a save with duplicate conflict keys in a batch succeeds (last-wins, no 'cannot affect row a second time')", async () => {
		const url = CATALOG_TEST_DATABASE_URL!;
		const sql = new Bun.SQL(url) as unknown as ProjectCatalogSqlClient & { close?: () => Promise<void> };
		const store = new PostgresProjectCatalogStore(url);
		const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
		const cleanup = async () => {
			await sql.unsafe(`DELETE FROM projects WHERE project_id = $1`, [projectId]);
		};
		await cleanup();
		try {
			const state = createState();
			state.projectId = projectId;
			state.pages = [{ imageId: "p0.png", imageName: "p0.png", textLayers: [], pendingAiJobs: [], coverRect: null }];
			// Duplicate task id within ONE batch — the old per-row loop last-wins; the
			// batched INSERT would throw without dedup. The LAST occurrence must persist.
			state.tasks = [
				createTask("dup-task", "2026-05-28T01:00:00.000Z", "todo", "translate", 0),
				{ ...createTask("dup-task", "2026-05-28T01:00:00.000Z", "done", "translate", 0), title: "WINNER" },
			];
			// Duplicate comment id with a real mentions array (last-wins).
			state.comments = [
				{ ...createComment("dup-comment", "2026-05-28T01:00:00.000Z", "open", 0, "user-1"), mentions: ["a"] },
				{ ...createComment("dup-comment", "2026-05-28T01:00:00.000Z", "resolved", 0, "user-1"), body: "C-WIN", mentions: ["b", "c"] },
			];
			state.reviewDecisions = [];
			state.versionReviewRequests = [];

			// Must NOT throw "cannot affect row a second time".
			await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

			const taskRows = await sql.unsafe<{ title: string; status: string }>(
				`SELECT title, status FROM project_tasks WHERE project_id = $1 AND task_id = 'dup-task'`,
				[projectId],
			);
			expect(taskRows).toHaveLength(1); // collapsed to a single row
			expect(taskRows[0]?.title).toBe("WINNER"); // last-wins
			expect(taskRows[0]?.status).toBe("done");

			const commentRows = await sql.unsafe<{ body: string; mentions: string[] }>(
				`SELECT body, mentions FROM project_comments WHERE project_id = $1 AND comment_id = 'dup-comment'`,
				[projectId],
			);
			expect(commentRows).toHaveLength(1);
			expect(commentRows[0]?.body).toBe("C-WIN");
			expect(commentRows[0]?.mentions).toEqual(["b", "c"]); // last-wins, real text[]
		} finally {
			await cleanup();
			await sql.close?.();
		}
	}, 60000);

	test("a row carrying a large mentions array chunks correctly and persists the full array", async () => {
		const url = CATALOG_TEST_DATABASE_URL!;
		const sql = new Bun.SQL(url) as unknown as ProjectCatalogSqlClient & { close?: () => Promise<void> };
		const store = new PostgresProjectCatalogStore(url);
		const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03";
		const cleanup = async () => {
			await sql.unsafe(`DELETE FROM projects WHERE project_id = $1`, [projectId]);
		};
		await cleanup();
		try {
			const state = createState();
			state.projectId = projectId;
			state.pages = [{ imageId: "p0.png", imageName: "p0.png", textLayers: [], pendingAiJobs: [], coverRect: null }];
			state.tasks = [];
			state.comments = [];
			state.reviewDecisions = [];
			// Three version reviews each with 25,000 mentions -> ~75k binds total. Without
			// param-aware chunking this would exceed Postgres' 65535 ceiling in one
			// statement; the chunker must split it AND persist every mention.
			const wideMentions = Array.from({ length: 25_000 }, (_, i) => `@user-${i}`);
			state.versionReviewRequests = Array.from({ length: 3 }, (_, index) => ({
				id: `vr-${index}`,
				versionId: `version-${index}`,
				status: "open" as const,
				requester: "user-1",
				mentions: wideMentions,
				createdAt: "2026-05-28T01:00:00.000Z",
				updatedAt: "2026-05-28T01:00:00.000Z",
			}));

			// Must NOT throw a bind-parameter-limit error.
			await store.upsertProjectState(state, { updatedAt: "2026-05-28T02:00:00.000Z" });

			const rows = await sql.unsafe<{ c: number; m: number }>(
				`SELECT count(*)::int AS c, max(array_length(mentions, 1))::int AS m FROM project_version_reviews WHERE project_id = $1`,
				[projectId],
			);
			expect(rows[0]?.c).toBe(3); // every row persisted across chunks
			expect(rows[0]?.m).toBe(25_000); // the full mentions array round-tripped
		} finally {
			await cleanup();
			await sql.close?.();
		}
	}, 60000);
});

// PR #263 (story DELETE) — central catalog-store resurrection guard.
//
// Codex P1: the file-state tombstone is written FIRST on delete, but catalog-backed
// readers (getProjectState / getProjectWorkspacePlan / getProjectWorkspaceStoragePlan /
// listProjectIdsForWorkspace / canAccessProject / findExistingProjectIds / list*) trust
// the catalog row BEFORE checking the tombstone. If the catalog DELETE fails (or a stale
// replica keeps a `deleted_at IS NULL` row), a tombstoned id could be re-derived/served.
//
// The fix is CENTRAL: both stores consult the on-disk tombstone in EVERY project-data
// read. For the FileProjectCatalogStore that is the readState chokepoint; for the
// PostgresProjectCatalogStore it is the `isTombstoned` check threaded through each read.
// One store-level change → all listed routes/services inherit the guard.
describe("central catalog-store tombstone guard (PR #263 resurrection)", () => {
	const TOMBSTONED_ID = "dead0000-0000-4000-8000-000000000001";
	const VALID_ID = "11ee0000-0000-4000-8000-000000000002";

	function freshProjectsDir(): string {
		return mkdtempSync(join(tmpdir(), "tombstone-guard-catalog-"));
	}

	function writeTombstone(projectsDir: string, projectId: string): void {
		const dir = safePath(projectsDir, PROJECT_TOMBSTONES_DIR_NAME);
		mkdirSync(dir, { recursive: true });
		writeFileSync(safePath(dir, projectId), `${new Date().toISOString()}\n`);
	}

	function clearTombstone(projectsDir: string, projectId: string): void {
		rmSync(safePath(projectsDir, PROJECT_TOMBSTONES_DIR_NAME, projectId), { force: true });
	}

	// A FakeCatalogSqlClient that, like a lingering `deleted_at IS NULL` row, serves
	// the SAME project rows for ANY id the reader asks about — so the ONLY thing that
	// can refuse a tombstoned id is the store-level tombstone guard, not the SQL.
	function lingeringRowClient(): FakeCatalogSqlClient {
		const client = new FakeCatalogSqlClient();
		client.summaryRows = [{
			project_id: TOMBSTONED_ID,
			workspace_id: "ws-1",
			title: "Lingering",
			source_locale: "en",
			target_locale: "th",
			target_locales: ["th"],
			metadata: { workspaceId: "ws-1" },
			created_at: "2026-05-28T01:00:00.000Z",
			updated_at: "2026-05-28T01:00:00.000Z",
		}];
		client.workspacePlanRows = [{ project_id: TOMBSTONED_ID, workspace_id: "ws-1", plan_id: "studio" }];
		client.accessRows = [{ role: "owner", scope: JSON.stringify({}), target_locale: "th" }];
		client.pageRows = [{ page_id: "p1", project_id: TOMBSTONED_ID, page_index: 0, status: "todo", created_at: "2026-05-28T01:00:00.000Z", updated_at: "2026-05-28T01:00:00.000Z" }];
		client.taskRows = [{ task_id: "t1", project_id: TOMBSTONED_ID, page_index: 0, type: "translate", status: "todo", priority: "high", title: "x", created_at: "2026-05-28T01:00:00.000Z", updated_at: "2026-05-28T01:00:00.000Z" }];
		client.commentRows = [{ comment_id: "c1", project_id: TOMBSTONED_ID, page_index: 0, status: "open", body: "x", created_at: "2026-05-28T01:00:00.000Z", updated_at: "2026-05-28T01:00:00.000Z" }];
		client.reviewDecisionRows = [{ review_decision_id: "r1", project_id: TOMBSTONED_ID, page_index: 0, status: "approved", created_at: "2026-05-28T01:00:00.000Z", updated_at: "2026-05-28T01:00:00.000Z" }];
		client.versionRows = [{ version_id: "v1", project_id: TOMBSTONED_ID, name: "snap", source: "save", page_count: 1, text_layer_count: 0, created_at: "2026-05-28T01:00:00.000Z" }];
		// getProjectState reads `current_state` from the same summaryRows branch; seed it.
		client.summaryRows[0]!.current_state = JSON.stringify({
			projectId: TOMBSTONED_ID,
			workspaceId: "ws-1",
			userId: "owner",
			name: "Lingering",
			createdAt: "2026-05-28T01:00:00.000Z",
			pages: [],
			currentPage: 0,
			targetLang: "th",
		});
		return client;
	}

	test("Postgres: a tombstoned id with a lingering catalog row is NOT served by any read method", async () => {
		const projectsDir = freshProjectsDir();
		const client = lingeringRowClient();
		const store = new PostgresProjectCatalogStore(client, projectsDir);

		// Sanity: WITHOUT a tombstone, the lingering row IS served (proves the SQL
		// itself does not refuse the id — only the tombstone guard does).
		expect(await store.getProjectState(TOMBSTONED_ID)).not.toBeNull();

		// Now tombstone it (as the delete route does, write-first) and re-read.
		writeTombstone(projectsDir, TOMBSTONED_ID);

		expect(await store.getProjectState(TOMBSTONED_ID)).toBeNull();
		expect(await store.getProjectWorkspacePlan(TOMBSTONED_ID)).toBeNull();
		expect(await store.getProjectWorkspaceStoragePlan(TOMBSTONED_ID)).toBeNull();
		expect(await store.resolveProjectAccessContext({ projectId: TOMBSTONED_ID, userId: "owner", permission: "read:project" })).toBeNull();
		expect(await store.canAccessProject({ projectId: TOMBSTONED_ID, userId: "owner", permission: "read:project" })).toBe(false);
		expect((await store.findExistingProjectIds([TOMBSTONED_ID])).has(TOMBSTONED_ID)).toBe(false);
		expect((await store.listProjectIdsForWorkspace("ws-1")).includes(TOMBSTONED_ID)).toBe(false);
		expect((await store.listProjectSummaryPage()).projects.some((p) => p.projectId === TOMBSTONED_ID)).toBe(false);
		expect((await store.listProjectPages({ projectId: TOMBSTONED_ID })).pages).toHaveLength(0);
		expect((await store.listProjectTasks({ projectId: TOMBSTONED_ID })).tasks).toHaveLength(0);
		expect((await store.listProjectComments({ projectId: TOMBSTONED_ID })).comments).toHaveLength(0);
		expect((await store.listProjectReviewDecisions({ projectId: TOMBSTONED_ID })).decisions).toHaveLength(0);
		expect((await store.listProjectVersions({ projectId: TOMBSTONED_ID })).versions).toHaveLength(0);
		expect(await store.getProjectVersion(TOMBSTONED_ID, "v1")).toBeNull();
	});

	test("Postgres: a VALID (non-tombstoned) id reads exactly as before — no regression", async () => {
		const projectsDir = freshProjectsDir();
		const client = lingeringRowClient();
		// Re-point the lingering rows at the VALID id so the reads return them.
		client.summaryRows[0]!.project_id = VALID_ID;
		(client.summaryRows[0]!.current_state as string) = JSON.stringify({
			projectId: VALID_ID, workspaceId: "ws-1", userId: "owner", name: "Live",
			createdAt: "2026-05-28T01:00:00.000Z", pages: [], currentPage: 0, targetLang: "th",
		});
		client.workspacePlanRows[0]!.project_id = VALID_ID;
		const store = new PostgresProjectCatalogStore(client, projectsDir);
		// Only TOMBSTONED_ID is tombstoned; VALID_ID is not.
		writeTombstone(projectsDir, TOMBSTONED_ID);

		const state = await store.getProjectState(VALID_ID);
		expect(state?.projectId).toBe(VALID_ID);
		expect(state?.name).toBe("Live");
		expect((await store.getProjectWorkspacePlan(VALID_ID))?.planId).toBe("studio");
		expect(await store.canAccessProject({ projectId: VALID_ID, userId: "owner", permission: "read:project" })).toBe(true);
		expect((await store.findExistingProjectIds([VALID_ID])).has(VALID_ID)).toBe(true);
	});

	test("Postgres: re-creating an id clears the tombstone and it reads normally again", async () => {
		const projectsDir = freshProjectsDir();
		const client = lingeringRowClient();
		const store = new PostgresProjectCatalogStore(client, projectsDir);
		writeTombstone(projectsDir, TOMBSTONED_ID);
		expect(await store.getProjectState(TOMBSTONED_ID)).toBeNull();
		// writeProjectState clears the tombstone for a (re)written id; simulate that.
		clearTombstone(projectsDir, TOMBSTONED_ID);
		expect(await store.getProjectState(TOMBSTONED_ID)).not.toBeNull();
	});

	test("File store: a tombstoned id with a stale state.json is NOT served; a valid id is", async () => {
		const projectsDir = freshProjectsDir();
		const access = new FileWorkspaceAccessStore();
		const store = new FileProjectCatalogStore(projectsDir, access);

		// Stale state.json survives a partial delete for the tombstoned id; a separate
		// valid id is written normally.
		for (const id of [TOMBSTONED_ID, VALID_ID]) {
			const dir = join(projectsDir, id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "state.json"), JSON.stringify({
				projectId: id, userId: "owner", name: id === VALID_ID ? "Live" : "Stale",
				createdAt: "2026-05-28T01:00:00.000Z", pages: [], currentPage: 0, targetLang: "th",
			}));
		}
		writeTombstone(projectsDir, TOMBSTONED_ID);

		expect(await store.getProjectState(TOMBSTONED_ID)).toBeNull();
		expect((await store.findExistingProjectIds([TOMBSTONED_ID, VALID_ID])).has(TOMBSTONED_ID)).toBe(false);
		expect((await store.findExistingProjectIds([TOMBSTONED_ID, VALID_ID])).has(VALID_ID)).toBe(true);
		expect((await store.listProjectVersions({ projectId: TOMBSTONED_ID })).versions).toHaveLength(0);

		const live = await store.getProjectState(VALID_ID);
		expect(live?.name).toBe("Live");

		// Re-create clears the tombstone → reads again.
		clearTombstone(projectsDir, TOMBSTONED_ID);
		expect((await store.getProjectState(TOMBSTONED_ID))?.name).toBe("Stale");
	});
});
