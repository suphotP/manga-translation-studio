import { describe, expect, test } from "bun:test";
import { PostgresAssetStore } from "../services/assets.js";
import { PostgresProjectCatalogStore } from "../services/project-catalog.js";
import { PostgresWorkStateStore } from "../services/work-states.js";

/**
 * Real-Postgres parity test for the Bun.SQL JS-array bind fix.
 *
 * Bun.SQL cannot bind a JS array as a single `$n::text[]` parameter (it
 * serializes ["a","b"] to the malformed literal "a,b"), so the old
 * `= ANY($n::text[])` queries are silently broken against a real server while
 * fake/mock SQL clients in unit tests still "pass". This drives the actual
 * store methods against a live Postgres and asserts multi-element array lookups
 * return the correct rows. It also asserts the OLD pattern still fails on the
 * same connection, locking in the regression.
 *
 * Everything runs inside a single test that opens and closes one shared
 * connection (reused by every store via the client constructor seam). A single
 * long-lived Bun.SQL pool spanning beforeAll/afterAll keeps the test runner's
 * event loop alive and can stall it, and a fresh pool per store exhausts
 * max_connections — so we open one, share it, and close it deterministically.
 *
 * Migrations must already be applied to TEST_DATABASE_URL (run `bun run
 * src/migrations/cli.ts up` against it first); applying them from inside the
 * bun-test worker stalls on the migration advisory lock.
 *
 * Gated on TEST_DATABASE_URL. Example:
 *   docker run -d --name pgfix -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/postgres \
 *     bun run src/migrations/cli.ts up
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/postgres \
 *     bun test src/__tests__/pg-array-binds.real-pg.test.ts
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

describeReal("pg-array binds (real Postgres)", () => {
	test("multi-element ANY(ARRAY[...]) binds return correct rows across all 3 fixed sites; the old JS-array bind still fails", async () => {
		const NS = `pgarr-${Date.now()}`;
		const WORKSPACE_ID = `${NS}-ws`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const raw: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });

		try {
			// --- seed workspace + projects + work-states + asset records ---
			await raw.unsafe(
				`INSERT INTO workspaces (workspace_id, name, created_at, updated_at)
				 VALUES ($1, 'pgarr ws', now(), now())
				 ON CONFLICT (workspace_id) DO NOTHING`,
				[WORKSPACE_ID],
			);
			for (const n of [1, 2, 3]) {
				await raw.unsafe(
					`INSERT INTO projects (project_id, workspace_id, title, current_state, created_at, updated_at)
					 VALUES ($1, $2, $3, '{}'::jsonb, now(), now())
					 ON CONFLICT (project_id) DO NOTHING`,
					[`${NS}-p${n}`, WORKSPACE_ID, `Project ${n}`],
				);
			}
			for (const s of ["a", "b", "c"]) {
				await raw.unsafe(
					`INSERT INTO work_states (id, subject_kind, subject_id, state, created_by, created_at, updated_at)
					 VALUES ($1, 'page', $2, 'draft', 'creator-1', now(), now())`,
					[crypto.randomUUID(), `${NS}-s${s}`],
				);
			}
			const seedAsset = (projectId: string, assetId: string, bytes: number) =>
				raw.unsafe(
					`INSERT INTO asset_records (
						asset_id, project_id, workspace_id, image_id, original_name, mime_type,
						kind, sha256, byte_size, storage_driver, storage_key, storage_status,
						moderation_status, derivatives, created_at, updated_at
					) VALUES ($1, $2, $3, $1, $1, 'image/png', 'human', $1, $4, 'file', $1, 'stored', 'allowed', '[]'::jsonb, now(), now())`,
					[assetId, projectId, WORKSPACE_ID, bytes],
				);
			await seedAsset(`${NS}-p1`, `${NS}-a1`, 100);
			await seedAsset(`${NS}-p2`, `${NS}-a2`, 200);
			await seedAsset(`${NS}-p3`, `${NS}-a3`, 400);

			// SITE 3: project-catalog.findExistingProjectIds (multi-element array)
			const catalog = new PostgresProjectCatalogStore(raw);
			const existing = await catalog.findExistingProjectIds([`${NS}-p1`, `${NS}-p3`, `${NS}-missing`]);
			expect([...existing].sort()).toEqual([`${NS}-p1`, `${NS}-p3`]);

			// SITE 2: work-states.getWorkStatesForSubjects (multi-subject array)
			const ws = new PostgresWorkStateStore(raw);
			const states = await ws.getWorkStatesForSubjects("page", [`${NS}-sa`, `${NS}-sc`, `${NS}-nope`]);
			expect(states.map((s) => s.subjectId).sort()).toEqual([`${NS}-sa`, `${NS}-sc`]);

			// SITE 1: assets.summarizeByWorkspace scoped to a multi-element projectIds array
			const assets = new PostgresAssetStore(raw);
			const usage = await assets.summarizeByWorkspace(WORKSPACE_ID, [`${NS}-p1`, `${NS}-p3`]);
			expect(usage.size).toBe(2);
			expect(usage.get(`${NS}-p1`)?.originalBytes).toBe(100);
			expect(usage.get(`${NS}-p3`)?.originalBytes).toBe(400);
			expect(usage.has(`${NS}-p2`)).toBe(false);

			// The OLD = ANY($1::text[]) JS-array bind still fails on this same
			// connection (regression lock). A separate short-lived connection is
			// used because the malformed-literal error invalidates the connection
			// it runs on.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const probe: any = new Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
			try {
				let message = "";
				try {
					await probe.unsafe(`SELECT project_id FROM projects WHERE project_id = ANY($1::text[])`, [
						[`${NS}-p1`, `${NS}-p3`],
					]);
				} catch (error) {
					message = error instanceof Error ? error.message : String(error);
				}
				expect(message).toMatch(/malformed array literal/);
			} finally {
				await probe.close?.();
			}
		} finally {
			await raw.unsafe(`DELETE FROM asset_records WHERE project_id LIKE $1`, [`${NS}-%`]);
			await raw.unsafe(`DELETE FROM work_states WHERE subject_id LIKE $1`, [`${NS}-%`]);
			await raw.unsafe(`DELETE FROM projects WHERE project_id LIKE $1`, [`${NS}-%`]);
			await raw.unsafe(`DELETE FROM workspaces WHERE workspace_id = $1`, [WORKSPACE_ID]);
			await raw.close?.();
		}
	});
});
