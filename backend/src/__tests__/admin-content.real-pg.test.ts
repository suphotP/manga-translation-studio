// Real-Postgres integration for back-office content management (ranks 17-18).
//
// Drives PostgresAdminContentStore against a LIVE Postgres to prove, end-to-end:
//   * cross-tenant browsing returns projects from MULTIPLE workspaces;
//   * search + status/flagged/hidden filters work on real columns (migration 0056);
//   * flag/hide are reversible and DISTINCT from the user soft-delete (deleted_at);
//   * the moderation queue lists flagged assets (asset_records) + CSAM hard-blocks
//     (csam_blocks) across tenants;
//   * keyset pagination is stable and uses scalar binds only.
//
// Migrations (incl. 0056) must already be applied to TEST_DATABASE_URL:
//   docker run -d --name pg-backoffice -e POSTGRES_PASSWORD=test -p 55444:5432 postgres:16
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55444/postgres bun run src/migrations/cli.ts up
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55444/postgres \
//     bun test src/__tests__/admin-content.real-pg.test.ts
//
// Gated on TEST_DATABASE_URL (skipped without it). One shared connection, seeded
// and torn down inside a single test, mirroring pg-array-binds.real-pg.test.ts.

import { describe, expect, test } from "bun:test";
import { PostgresAdminContentStore } from "../services/project-catalog.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

describeReal("admin content management (real Postgres)", () => {
	test("cross-tenant browse + filters + reversible flag/hide + moderation queue", async () => {
		const NS = `bocont-${Date.now()}`;
		const WS_A = `${NS}-wsA`;
		const WS_B = `${NS}-wsB`;
		const P_A1 = `${NS}-pA1`;
		const P_A2 = `${NS}-pA2`;
		const P_B1 = `${NS}-pB1`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });

		try {
			// --- seed two workspaces + three projects spread across both ---
			for (const [ws, name] of [[WS_A, "Alpha Studio"], [WS_B, "Beta Studio"]] as const) {
				await raw.unsafe(
					`INSERT INTO workspaces (workspace_id, name, created_at, updated_at)
					 VALUES ($1, $2, now(), now()) ON CONFLICT (workspace_id) DO NOTHING`,
					[ws, name],
				);
			}
			const seedProject = (id: string, ws: string, title: string, target: string, updatedAt: string) =>
				raw.unsafe(
					`INSERT INTO projects (project_id, workspace_id, owner_user_id, title, source_locale, target_locale, created_at, updated_at)
					 VALUES ($1, $2, $3, $4, 'ja', $5, now(), $6::timestamptz) ON CONFLICT (project_id) DO NOTHING`,
					[id, ws, `${NS}-owner`, title, target, updatedAt],
				);
			await seedProject(P_A1, WS_A, "Alpha One", "th", "2026-05-28T03:00:00.000Z");
			await seedProject(P_A2, WS_A, "Alpha Two", "en", "2026-05-28T02:00:00.000Z");
			await seedProject(P_B1, WS_B, "Beta One", "th", "2026-05-28T01:00:00.000Z");
			// a couple of pages on P_A1 so page_count is real
			for (const idx of [0, 1]) {
				await raw.unsafe(
					`INSERT INTO project_pages (page_id, project_id, page_index, status, created_at, updated_at)
					 VALUES ($1, $2, $3, 'draft', now(), now()) ON CONFLICT (page_id) DO NOTHING`,
					[`${P_A1}:page:${idx}`, P_A1, idx],
				);
			}
			// flagged asset on P_B1 + an allowed asset on P_A1 (only the flagged should surface)
			const seedAsset = (assetId: string, projectId: string, ws: string, status: string) =>
				raw.unsafe(
					`INSERT INTO asset_records (
						asset_id, project_id, workspace_id, image_id, original_name, mime_type,
						kind, sha256, byte_size, storage_driver, storage_key, storage_status,
						moderation_status, moderation_provider, moderation_reason, moderation_detail,
						moderation_checked_at, derivatives, created_at, updated_at
					) VALUES ($1,$2,$3,$1,$1,'image/png','human',$1,10,'file',$1,'stored',$4,'openai','sexual','{"sexual":0.8}'::jsonb, now(),'[]'::jsonb, now(), now())`,
					[assetId, projectId, ws, status],
				);
			await seedAsset(`${NS}-aFlagged`, P_B1, WS_B, "flagged");
			await seedAsset(`${NS}-aOk`, P_A1, WS_A, "allowed");
			// a CSAM hard-block tied to an asset id
			await raw.unsafe(
				`INSERT INTO csam_blocks (asset_id, sha256, scores, blocked_at, workspace_id)
				 VALUES ($1, $1, '{"csam":0.99}'::jsonb, now(), $2)`,
				[`${NS}-aCsam`, WS_A],
			);

			const store = new PostgresAdminContentStore(raw);

			// --- cross-tenant browse: projects from BOTH workspaces, scoped to this NS ---
			const page = await store.listProjects({ search: NS, limit: 100 });
			const ids = page.projects.map((p) => p.projectId);
			expect(ids).toContain(P_A1);
			expect(ids).toContain(P_A2);
			expect(ids).toContain(P_B1);
			const workspaces = new Set(page.projects.map((p) => p.workspaceId));
			expect(workspaces.has(WS_A)).toBe(true);
			expect(workspaces.has(WS_B)).toBe(true);
			// keyset order is updated_at DESC → P_A1 (03:00) before P_A2 (02:00) before P_B1 (01:00)
			expect(ids.indexOf(P_A1)).toBeLessThan(ids.indexOf(P_A2));
			expect(ids.indexOf(P_A2)).toBeLessThan(ids.indexOf(P_B1));
			// workspace name + counts joined in
			const a1 = page.projects.find((p) => p.projectId === P_A1);
			expect(a1?.workspaceName).toBe("Alpha Studio");
			expect(a1?.pageCount).toBe(2);
			const b1 = page.projects.find((p) => p.projectId === P_B1);
			expect(b1?.flaggedAssetCount).toBe(1);

			// --- search narrows by title across tenants ---
			const onlyBeta = await store.listProjects({ search: "Beta One" });
			expect(onlyBeta.projects.map((p) => p.projectId)).toEqual([P_B1]);

			// --- keyset pagination is stable (limit 1 → cursor → next, no overlap) ---
			const first = await store.listProjects({ search: NS, limit: 1 });
			expect(first.projects).toHaveLength(1);
			expect(first.nextCursor).toBeTruthy();
			const second = await store.listProjects({ search: NS, limit: 1, cursor: first.nextCursor });
			expect(second.projects[0]?.projectId).not.toBe(first.projects[0]?.projectId);

			// --- flag is reversible + filterable ---
			const flagged = await store.setProjectFlag({ projectId: P_A2, adminUserId: `${NS}-admin`, flagged: true, reason: "review me" });
			expect(flagged?.adminFlagged).toBe(true);
			expect(flagged?.adminFlaggedBy).toBe(`${NS}-admin`);
			const flaggedList = await store.listProjects({ search: NS, flagged: true });
			expect(flaggedList.projects.map((p) => p.projectId)).toEqual([P_A2]);
			const unflagged = await store.setProjectFlag({ projectId: P_A2, adminUserId: `${NS}-admin`, flagged: false });
			expect(unflagged?.adminFlagged).toBe(false);
			expect((await store.listProjects({ search: NS, flagged: true })).projects).toHaveLength(0);

			// --- hide is reversible soft-delete, DISTINCT from user deleted_at ---
			const hidden = await store.setProjectHidden({ projectId: P_B1, adminUserId: `${NS}-admin`, hidden: true, reason: "DMCA" });
			expect(hidden?.adminHidden).toBe(true);
			expect(hidden?.status).toBe("admin_hidden");
			// the project row is NOT hard-deleted and deleted_at is still NULL
			const stillThere = await raw.unsafe(`SELECT deleted_at FROM projects WHERE project_id = $1`, [P_B1]);
			expect(stillThere[0]?.deleted_at).toBeNull();
			const hiddenOnly = await store.listProjects({ search: NS, status: "admin_hidden" });
			expect(hiddenOnly.projects.map((p) => p.projectId)).toEqual([P_B1]);
			const restored = await store.setProjectHidden({ projectId: P_B1, adminUserId: `${NS}-admin`, hidden: false });
			expect(restored?.adminHidden).toBe(false);
			expect(restored?.status).toBe("active");

			// --- status=active EXCLUDES a user-deleted project ---
			await raw.unsafe(`UPDATE projects SET deleted_at = now() WHERE project_id = $1`, [P_A2]);
			const activeIds = (await store.listProjects({ search: NS, status: "active", limit: 100 })).projects.map((p) => p.projectId);
			expect(activeIds).not.toContain(P_A2);
			const allIds = (await store.listProjects({ search: NS, status: "all", limit: 100 })).projects.map((p) => p.projectId);
			expect(allIds).toContain(P_A2);

			// --- a user-deleted project is HIDDEN + IMMUTABLE through detail/mutation ---
			// Even though status="all" lists it for audit, the detail + flag/hide
			// surfaces refuse it (deleted_at IS NULL guard): getProject → null and the
			// flag/hide UPDATEs no-op so the re-read returns null too.
			expect(await store.getProject(P_A2)).toBeNull();
			expect(await store.setProjectFlag({ projectId: P_A2, adminUserId: `${NS}-admin`, flagged: true, reason: "should not apply" })).toBeNull();
			expect(await store.setProjectHidden({ projectId: P_A2, adminUserId: `${NS}-admin`, hidden: true, reason: "should not apply" })).toBeNull();
			// confirm at the row level that no admin flag/hide state leaked onto the deleted row
			const deletedRow = await raw.unsafe(`SELECT admin_flagged_at, admin_hidden_at FROM projects WHERE project_id = $1`, [P_A2]);
			expect(deletedRow[0]?.admin_flagged_at).toBeNull();
			expect(deletedRow[0]?.admin_hidden_at).toBeNull();

			// --- detail view (metadata only) ---
			const detail = await store.getProject(P_A1);
			expect(detail?.projectId).toBe(P_A1);
			expect(detail?.pages.length).toBe(2);
			// no asset BYTES exposed anywhere — only metadata fields
			expect(detail?.flaggedAssets.every((a) => !("bytes" in a) && !("storageKey" in a))).toBe(true);

			// --- moderation queue: flagged asset + CSAM block across tenants ---
			const queue = await store.listModerationQueue({ limit: 100 });
			const sources = queue.items.map((i) => i.source);
			expect(sources).toContain("asset");
			expect(sources).toContain("csam_block");
			const csamItem = queue.items.find((i) => i.source === "csam_block" && i.assetId === `${NS}-aCsam`);
			expect(csamItem?.moderationProvider).toBe("csam");
			const assetItem = queue.items.find((i) => i.source === "asset" && i.assetId === `${NS}-aFlagged`);
			expect(assetItem?.projectId).toBe(P_B1);
			expect(assetItem?.moderationStatus).toBe("flagged");
			// source filter narrows to one kind
			const onlyCsam = await store.listModerationQueue({ source: "csam_block", limit: 100 });
			expect(onlyCsam.items.every((i) => i.source === "csam_block")).toBe(true);
		} finally {
			await raw.unsafe(`DELETE FROM csam_blocks WHERE asset_id LIKE $1`, [`${NS}-%`]);
			await raw.unsafe(`DELETE FROM asset_records WHERE project_id LIKE $1`, [`${NS}-%`]);
			await raw.unsafe(`DELETE FROM project_pages WHERE project_id LIKE $1`, [`${NS}-%`]);
			await raw.unsafe(`DELETE FROM projects WHERE project_id LIKE $1`, [`${NS}-%`]);
			await raw.unsafe(`DELETE FROM workspaces WHERE workspace_id LIKE $1`, [`${NS}-%`]);
			await raw.close?.();
		}
	});
});
