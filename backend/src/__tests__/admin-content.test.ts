// Back-office content management (ranks 17-18) — data-layer tests.
//
// Covers the cross-tenant admin content store in BOTH modes:
//   * FileAdminContentStore: scans on-disk project state files across workspaces,
//     flags/hides via a sidecar JSON (reversible, never mutating state files),
//     supports search + status/flagged filters + stable keyset pagination.
//   * PostgresAdminContentStore: verified against a fake SQL client to lock in the
//     cross-tenant query shape, SCALAR binds only (no JS-array binds), the
//     flag/hide UPDATE SQL, and the asset+csam moderation-queue UNION.
//
// HTTP gating (CONTENT_READ read / CONTENT_MODERATE moderate, cross-tenant) is
// covered in admin-subrouters.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	FileAdminContentStore,
	PostgresAdminContentStore,
	InvalidAdminContentCursorError,
	type ProjectCatalogSqlClient,
} from "../services/project-catalog.js";
import { FileWorkspaceAccessStore } from "../services/workspace-access.js";
import { PROJECT_TOMBSTONES_DIR_NAME, isProjectTombstonedIn } from "../utils/security.js";
import type { ProjectState } from "../types/index.js";

// Mirror writeProjectTombstone: a permanently-deleted id gets a marker file under
// PROJECTS_DIR/.tombstones/<id>. A test uses this to simulate "this id was deleted
// but a stale state.json survived a partial rmSync".
function writeTombstone(projectsDir: string, projectId: string): void {
	const dir = join(projectsDir, PROJECT_TOMBSTONES_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, projectId), `${new Date().toISOString()}\n`);
}

function clearTombstone(projectsDir: string, projectId: string): void {
	rmSync(join(projectsDir, PROJECT_TOMBSTONES_DIR_NAME, projectId), { force: true });
}

function makeState(overrides: Partial<ProjectState> & { projectId: string }): ProjectState {
	return {
		userId: "owner-1",
		name: `Project ${overrides.projectId}`,
		createdAt: "2026-05-28T01:00:00.000Z",
		pages: [
			{ imageId: "p1.png", imageName: "p1.png", textLayers: [], pendingAiJobs: [], coverRect: null },
		],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		comments: [],
		...overrides,
	} as ProjectState;
}

function seedProjectsDir(states: ProjectState[]): { projectsDir: string; sidecarPath: string } {
	const root = mkdtempSync(join(tmpdir(), "admin-content-"));
	const projectsDir = join(root, "projects");
	mkdirSync(projectsDir, { recursive: true });
	for (const state of states) {
		const dir = join(projectsDir, state.projectId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "state.json"), JSON.stringify(state));
	}
	return { projectsDir, sidecarPath: join(root, "admin-content-moderation.json") };
}

const WS_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const WS_B = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const P_A = "aaaaaaaa-1111-4111-8111-111111111111";
const P_B = "bbbbbbbb-2222-4222-8222-222222222222";

function fileStore(): FileAdminContentStore {
	const states = [
		makeState({ projectId: P_A, workspaceId: WS_A, name: "Alpha Manga", targetLang: "th" }),
		makeState({ projectId: P_B, workspaceId: WS_B, name: "Beta Webtoon", targetLang: "en" }),
	];
	const { projectsDir, sidecarPath } = seedProjectsDir(states);
	// Empty access store → workspace names resolve to null; that's fine for the test.
	const access = new FileWorkspaceAccessStore(join(mkdtempSync(join(tmpdir(), "admin-content-ws-")), "ws.json"));
	return new FileAdminContentStore(projectsDir, sidecarPath, access);
}

describe("admin content store — file mode (cross-tenant)", () => {
	test("lists projects from MULTIPLE workspaces", async () => {
		const store = fileStore();
		const page = await store.listProjects();
		expect(page.projects.map((p) => p.projectId).sort()).toEqual([P_A, P_B].sort());
		const workspaceIds = new Set(page.projects.map((p) => p.workspaceId));
		expect(workspaceIds.has(WS_A)).toBe(true);
		expect(workspaceIds.has(WS_B)).toBe(true);
	});

	test("search narrows by title / id / workspace", async () => {
		const store = fileStore();
		const byTitle = await store.listProjects({ search: "Beta" });
		expect(byTitle.projects.map((p) => p.projectId)).toEqual([P_B]);
		const byWorkspace = await store.listProjects({ search: WS_A });
		expect(byWorkspace.projects.map((p) => p.projectId)).toEqual([P_A]);
	});

	test("flag is audited-toggle + reversible; status/flag filters apply", async () => {
		const store = fileStore();
		const flagged = await store.setProjectFlag({ projectId: P_A, adminUserId: "admin-9", flagged: true, reason: "looks off" });
		expect(flagged?.adminFlagged).toBe(true);
		expect(flagged?.adminFlaggedBy).toBe("admin-9");
		expect(flagged?.adminFlagReason).toBe("looks off");

		const onlyFlagged = await store.listProjects({ flagged: true });
		expect(onlyFlagged.projects.map((p) => p.projectId)).toEqual([P_A]);

		const unflagged = await store.setProjectFlag({ projectId: P_A, adminUserId: "admin-9", flagged: false });
		expect(unflagged?.adminFlagged).toBe(false);
		expect(unflagged?.adminFlaggedAt).toBeNull();
		const noneFlagged = await store.listProjects({ flagged: true });
		expect(noneFlagged.projects).toHaveLength(0);
	});

	test("hide is reversible soft-delete (no hard delete) + status reflects it", async () => {
		const store = fileStore();
		const hidden = await store.setProjectHidden({ projectId: P_B, adminUserId: "admin-9", hidden: true, reason: "DMCA" });
		expect(hidden?.adminHidden).toBe(true);
		expect(hidden?.status).toBe("admin_hidden");

		// Project still exists (not hard-deleted): detail + admin_hidden filter find it.
		const detail = await store.getProject(P_B);
		expect(detail?.projectId).toBe(P_B);
		const onlyHidden = await store.listProjects({ status: "admin_hidden" });
		expect(onlyHidden.projects.map((p) => p.projectId)).toEqual([P_B]);

		const restored = await store.setProjectHidden({ projectId: P_B, adminUserId: "admin-9", hidden: false });
		expect(restored?.adminHidden).toBe(false);
		expect(restored?.status).toBe("active");
	});

	test("flag/hide on unknown project returns null (404 at route)", async () => {
		const store = fileStore();
		expect(await store.setProjectFlag({ projectId: "ffffffff-0000-4000-8000-000000000000", adminUserId: "a", flagged: true })).toBeNull();
		expect(await store.setProjectHidden({ projectId: "ffffffff-0000-4000-8000-000000000000", adminUserId: "a", hidden: true })).toBeNull();
		expect(await store.getProject("ffffffff-0000-4000-8000-000000000000")).toBeNull();
	});

	test("keyset pagination is stable (limit 1 → cursor → next)", async () => {
		const store = fileStore();
		const first = await store.listProjects({ limit: 1 });
		expect(first.projects).toHaveLength(1);
		expect(first.nextCursor).toBeTruthy();
		const second = await store.listProjects({ limit: 1, cursor: first.nextCursor });
		expect(second.projects).toHaveLength(1);
		expect(second.projects[0]?.projectId).not.toBe(first.projects[0]?.projectId);
	});

	test("invalid cursor throws InvalidAdminContentCursorError", async () => {
		const store = fileStore();
		await expect(store.listProjects({ cursor: "not-base64-json" })).rejects.toBeInstanceOf(InvalidAdminContentCursorError);
	});

	test("file-mode moderation queue is empty (asset/csam are Postgres-only)", async () => {
		const store = fileStore();
		const queue = await store.listModerationQueue();
		expect(queue.items).toEqual([]);
	});

	test("tolerates a partial/legacy on-disk state with no pages array (no 500)", async () => {
		const root = mkdtempSync(join(tmpdir(), "admin-content-partial-"));
		const projectsDir = join(root, "projects");
		const goodId = "cccccccc-3333-4333-8333-333333333333";
		const partialId = "dddddddd-4444-4444-8444-444444444444";
		mkdirSync(join(projectsDir, goodId), { recursive: true });
		mkdirSync(join(projectsDir, partialId), { recursive: true });
		writeFileSync(join(projectsDir, goodId, "state.json"), JSON.stringify(makeState({ projectId: goodId, name: "Good" })));
		// Deliberately omit `pages` to simulate a legacy/partial state.
		writeFileSync(join(projectsDir, partialId, "state.json"), JSON.stringify({ projectId: partialId, name: "Partial", createdAt: "2026-05-28T01:00:00.000Z", targetLang: "th" }));
		const access = new FileWorkspaceAccessStore(join(root, "ws.json"));
		const store = new FileAdminContentStore(projectsDir, join(root, "sidecar.json"), access);
		const page = await store.listProjects();
		const ids = page.projects.map((p) => p.projectId);
		// The good project still surfaces; the partial one is either tolerated (pageCount 0)
		// or skipped — either way the browser does NOT throw.
		expect(ids).toContain(goodId);
		const partialRow = page.projects.find((p) => p.projectId === partialId);
		if (partialRow) expect(partialRow.pageCount).toBe(0);
		// detail on the partial state is also non-throwing.
		const detail = await store.getProject(partialId);
		expect(detail?.pages).toEqual([]);
	});

	// Codex P1 (PR #263, round 4): FileAdminContentStore.readState read state.json
	// DIRECTLY with no tombstone check, so a permanently-deleted (tombstoned) id
	// whose state.json survived a partial rmSync still showed up in the god-view
	// content browser (listProjects) and detail (getProject). readState now honors
	// the deletion tombstone first, mirroring FileProjectCatalogStore.readState.
	test("a tombstoned id with a stale state.json is NOT served by listProjects / getProject", async () => {
		const liveId = "eeeeeeee-5555-4555-8555-555555555555";
		const deadId = "ffffffff-6666-4666-8666-666666666666";
		const { projectsDir, sidecarPath } = seedProjectsDir([
			makeState({ projectId: liveId, workspaceId: WS_A, name: "Still Alive" }),
			makeState({ projectId: deadId, workspaceId: WS_B, name: "Deleted But Stale" }),
		]);
		// Simulate a partial rmSync: the project was DELETEd (tombstone written) but
		// its state.json survived on disk and is fully readable.
		writeTombstone(projectsDir, deadId);
		expect(isProjectTombstonedIn(projectsDir, deadId)).toBe(true);

		const access = new FileWorkspaceAccessStore(join(mkdtempSync(join(tmpdir(), "admin-content-ts-ws-")), "ws.json"));
		const store = new FileAdminContentStore(projectsDir, sidecarPath, access);

		// listProjects (the cross-tenant dir scan via allProjectStates) must skip it.
		const page = await store.listProjects();
		const ids = page.projects.map((p) => p.projectId);
		expect(ids).toContain(liveId);
		expect(ids).not.toContain(deadId);

		// Direct detail read (getProject -> readState) must refuse it too.
		expect(await store.getProject(deadId)).toBeNull();
		// And flag/hide of a tombstoned id is refused (they go through readState).
		expect(await store.setProjectFlag({ projectId: deadId, adminUserId: "admin-9", flagged: true })).toBeNull();
		expect(await store.setProjectHidden({ projectId: deadId, adminUserId: "admin-9", hidden: true })).toBeNull();

		// The live project is unaffected.
		expect((await store.getProject(liveId))?.projectId).toBe(liveId);
	});

	test("a re-created id (tombstone cleared) reappears in listProjects / getProject", async () => {
		const reusedId = "abababab-7777-4777-8777-777777777777";
		const { projectsDir, sidecarPath } = seedProjectsDir([
			makeState({ projectId: reusedId, workspaceId: WS_A, name: "Reborn" }),
		]);
		writeTombstone(projectsDir, reusedId);
		const access = new FileWorkspaceAccessStore(join(mkdtempSync(join(tmpdir(), "admin-content-ts-ws2-")), "ws.json"));
		const store = new FileAdminContentStore(projectsDir, sidecarPath, access);

		// While tombstoned: hidden from both surfaces.
		expect((await store.listProjects()).projects.map((p) => p.projectId)).not.toContain(reusedId);
		expect(await store.getProject(reusedId)).toBeNull();

		// writeProjectState clears the tombstone for a (re)created id; simulate that.
		clearTombstone(projectsDir, reusedId);
		expect(isProjectTombstonedIn(projectsDir, reusedId)).toBe(false);

		// Now it is served again.
		expect((await store.listProjects()).projects.map((p) => p.projectId)).toContain(reusedId);
		expect((await store.getProject(reusedId))?.projectId).toBe(reusedId);
	});
});

// ── Postgres store: fake SQL client locks in the query shape + scalar binds ──

class FakeSql implements ProjectCatalogSqlClient {
	queries: Array<{ query: string; params: unknown[] }> = [];
	projectRows: Array<Record<string, unknown>> = [];
	pageRows: Array<Record<string, unknown>> = [];
	assetRows: Array<Record<string, unknown>> = [];
	queueRows: Array<Record<string, unknown>> = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		// Order matters: the project browser/detail query is identified by its
		// top-level `FROM projects ... LEFT JOIN workspaces` (it ALSO contains
		// asset_records/csam_blocks/project_pages as scalar subqueries), so match it
		// FIRST. The standalone page/asset/queue reads are matched after.
		if (query.includes("UPDATE projects")) return [] as T[];
		if (query.includes("FROM projects") && query.includes("LEFT JOIN workspaces")) return this.projectRows as T[];
		if (query.includes("moderation_queue")) return this.queueRows as T[];
		if (query.includes("FROM project_pages")) return this.pageRows as T[];
		if (query.includes("FROM asset_records")) return this.assetRows as T[];
		return [] as T[];
	}
}

function projectDbRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		project_id: P_A,
		workspace_id: WS_A,
		workspace_name: "Alpha WS",
		owner_user_id: "owner-1",
		title: "Alpha Manga",
		source_locale: "ja",
		target_locale: "th",
		deleted_at: null,
		admin_flagged_at: null,
		admin_flagged_by: null,
		admin_flag_reason: null,
		admin_hidden_at: null,
		admin_hidden_by: null,
		admin_hide_reason: null,
		created_at: "2026-05-28T01:00:00.000Z",
		updated_at: "2026-05-28T02:00:00.000Z",
		page_count: 3,
		asset_count: 5,
		flagged_asset_count: 1,
		csam_block_count: 0,
		...over,
	};
}

describe("admin content store — postgres query shape", () => {
	test("listProjects is cross-tenant (no member filter), keyset-ordered, scalar-bound", async () => {
		const sql = new FakeSql();
		sql.projectRows = [projectDbRow(), projectDbRow({ project_id: P_B, workspace_id: WS_B })];
		const store = new PostgresAdminContentStore(sql);
		const page = await store.listProjects({ search: "alpha", limit: 50 });
		const q = sql.queries[0]?.query ?? "";
		// No workspace_members join → not scoped to a caller's memberships.
		expect(q).not.toContain("workspace_members");
		expect(q).toContain("FROM projects");
		expect(q).toContain("LEFT JOIN workspaces");
		expect(q).toContain("ORDER BY projects.updated_at DESC, projects.project_id DESC");
		// flagged_asset_count counts NON-passed assets (not the nonexistent 'allowed').
		expect(q).toContain("moderation_status <> 'passed'");
		expect(q).not.toContain("<> 'allowed'");
		// search bound as a scalar LIKE param (lowercased).
		expect(sql.queries[0]?.params).toContain("%alpha%");
		// no JS-array bind anywhere.
		expect((sql.queries[0]?.params ?? []).some((p) => Array.isArray(p))).toBe(false);
		expect(page.projects.map((p) => p.projectId)).toEqual([P_A, P_B]);
		expect(page.projects[0]?.flaggedAssetCount).toBe(1);
	});

	test("status=active filters out user-deleted; flagged/hidden add column predicates", async () => {
		const sql = new FakeSql();
		sql.projectRows = [];
		const store = new PostgresAdminContentStore(sql);
		await store.listProjects({ status: "active", flagged: true, hidden: true });
		const q = sql.queries[0]?.query ?? "";
		expect(q).toContain("projects.deleted_at IS NULL");
		expect(q).toContain("projects.admin_flagged_at IS NOT NULL");
		expect(q).toContain("projects.admin_hidden_at IS NOT NULL");
	});

	test("setProjectFlag/Hidden issue UPDATE with scalar binds, then re-read the row", async () => {
		const sql = new FakeSql();
		sql.projectRows = [projectDbRow({ admin_flagged_at: "2026-05-28T03:00:00.000Z", admin_flagged_by: "admin-9", admin_flag_reason: "spam" })];
		const store = new PostgresAdminContentStore(sql);
		const row = await store.setProjectFlag({ projectId: P_A, adminUserId: "admin-9", flagged: true, reason: "spam" });
		const update = sql.queries.find((entry) => entry.query.includes("UPDATE projects") && entry.query.includes("admin_flagged_at = now()"));
		expect(update).toBeTruthy();
		expect(update?.params).toEqual([P_A, "admin-9", "spam"]);
		expect(row?.adminFlagged).toBe(true);

		const sql2 = new FakeSql();
		sql2.projectRows = [projectDbRow({ admin_hidden_at: "2026-05-28T03:00:00.000Z", admin_hidden_by: "admin-9", admin_hide_reason: "DMCA" })];
		const store2 = new PostgresAdminContentStore(sql2);
		const hidden = await store2.setProjectHidden({ projectId: P_A, adminUserId: "admin-9", hidden: true, reason: "DMCA" });
		const hideUpdate = sql2.queries.find((entry) => entry.query.includes("UPDATE projects") && entry.query.includes("admin_hidden_at = now()"));
		expect(hideUpdate?.params).toEqual([P_A, "admin-9", "DMCA"]);
		expect(hidden?.status).toBe("admin_hidden");
	});

	test("unflag/unhide clear the columns (NULL-out UPDATE, project-id bind only)", async () => {
		const sql = new FakeSql();
		sql.projectRows = [projectDbRow()];
		const store = new PostgresAdminContentStore(sql);
		await store.setProjectFlag({ projectId: P_A, adminUserId: "admin-9", flagged: false });
		const update = sql.queries.find((entry) => entry.query.includes("admin_flagged_at = NULL"));
		expect(update?.params).toEqual([P_A]);
	});

	// ── Soft-deleted projects are hidden + immutable through admin content ──
	// Regression: getProject / setProjectFlag / setProjectHidden must scope to
	// LIVE rows (deleted_at IS NULL) so a user soft-deleted project is invisible
	// and unmodifiable via the admin content surface.

	test("getProject SELECT carries the deleted_at IS NULL guard", async () => {
		const sql = new FakeSql();
		sql.projectRows = [projectDbRow()];
		const store = new PostgresAdminContentStore(sql);
		await store.getProject(P_A);
		const detailQuery = sql.queries.find(
			(entry) =>
				entry.query.includes("FROM projects") &&
				entry.query.includes("LEFT JOIN workspaces") &&
				entry.query.includes("WHERE projects.project_id = $1"),
		);
		expect(detailQuery).toBeTruthy();
		expect(detailQuery?.query).toContain("projects.deleted_at IS NULL");
	});

	test("setProjectFlag/Hidden UPDATEs carry the deleted_at IS NULL guard (set + clear)", async () => {
		const sql = new FakeSql();
		sql.projectRows = [projectDbRow()];
		const store = new PostgresAdminContentStore(sql);
		await store.setProjectFlag({ projectId: P_A, adminUserId: "admin-9", flagged: true, reason: "x" });
		await store.setProjectFlag({ projectId: P_A, adminUserId: "admin-9", flagged: false });
		await store.setProjectHidden({ projectId: P_A, adminUserId: "admin-9", hidden: true, reason: "x" });
		await store.setProjectHidden({ projectId: P_A, adminUserId: "admin-9", hidden: false });
		const updates = sql.queries.filter((entry) => entry.query.includes("UPDATE projects"));
		expect(updates.length).toBe(4);
		// every mutation UPDATE must be scoped to a live row
		expect(updates.every((entry) => entry.query.includes("deleted_at IS NULL"))).toBe(true);
	});

	test("a soft-deleted project (filtered by the guard) returns null on detail + mutations", async () => {
		// projectRows empty simulates the row being filtered out by deleted_at IS NULL.
		const sql = new FakeSql();
		sql.projectRows = [];
		const store = new PostgresAdminContentStore(sql);
		expect(await store.getProject(P_A)).toBeNull();
		// flag/hide re-read via getProject → null → route surfaces 404, never mutates.
		expect(await store.setProjectFlag({ projectId: P_A, adminUserId: "admin-9", flagged: true })).toBeNull();
		expect(await store.setProjectHidden({ projectId: P_A, adminUserId: "admin-9", hidden: true })).toBeNull();
	});

	test("moderation queue UNIONs asset_records + csam_blocks, keyset-ordered", async () => {
		const sql = new FakeSql();
		sql.queueRows = [
			{ source: "asset", asset_id: "a1", project_id: P_A, workspace_id: WS_A, moderation_status: "flagged", moderation_provider: "openai", moderation_reason: "sexual", detail: { sexual: 0.9 }, occurred_at: "2026-05-28T05:00:00.000Z", id: "a1" },
			{ source: "csam_block", asset_id: "a2", project_id: null, workspace_id: WS_B, moderation_status: "blocked", moderation_provider: "csam", moderation_reason: "mandatory_block", detail: { csam: 0.99 }, occurred_at: "2026-05-28T04:00:00.000Z", id: "uuid-2" },
		];
		const store = new PostgresAdminContentStore(sql);
		const page = await store.listModerationQueue({ limit: 50 });
		const q = sql.queries[0]?.query ?? "";
		expect(q).toContain("FROM asset_records");
		expect(q).toContain("FROM csam_blocks");
		expect(q).toContain("UNION ALL");
		expect(q).toContain("ORDER BY occurred_at DESC, id DESC");
		// P1 correctness: the queue surfaces NON-passed assets. The canonical statuses
		// are pending|passed|blocked|needs_review (there is no 'allowed'), so filtering
		// on `<> 'allowed'` matched EVERY asset and flooded the queue with passed
		// content. Lock the corrected predicate in.
		expect(q).toContain("moderation_status <> 'passed'");
		expect(q).not.toContain("<> 'allowed'");
		expect(page.items.map((i) => i.source)).toEqual(["asset", "csam_block"]);
		expect(page.items[1]?.moderationProvider).toBe("csam");
	});
});
