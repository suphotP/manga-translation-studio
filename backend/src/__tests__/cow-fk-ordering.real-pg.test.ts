// REAL-Postgres FK ordering proof for the CoW version ledger (codex #567 r9/r14).
//
// asset_versions.asset_id is an IMMEDIATE (non-deferrable) FK to
// asset_records(id) with ON DELETE CASCADE. Two consequences this file pins
// against the live schema (mocked suites such as
// cow-blob-before-row-ordering.test.ts CANNOT catch either):
//
//   1. Inserting a version for a not-yet-recorded asset id FAILS — so any
//      writeBlob call must run AFTER the asset_records row exists
//      (record → version, the cleaned-import ordering). The upload route's
//      historical blob-before-row order only survives because Storage CoW is
//      feature-flagged off in production (tracked separately as b14).
//   2. Deleting the record CASCADEs the version row away — which is exactly
//      why rollback paths must release accounting via deleteVersion() first:
//      the cascade silently skips refcount/quota reconciliation.
//
// Run (migrations must already be applied):
//   TEST_DATABASE_URL=postgres://... bun test src/__tests__/cow-fk-ordering.real-pg.test.ts
import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeReal = TEST_DATABASE_URL ? describe : describe.skip;

const ZERO_SHA = Buffer.alloc(32);

describeReal("asset_versions FK ordering (real Postgres)", () => {
	test("a version insert for an unrecorded asset id is rejected by the FK", async () => {
		const sql: any = new (globalThis as any).Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		try {
			await sql.unsafe("BEGIN");
			let fkError: unknown;
			try {
				await sql.unsafe(
					`INSERT INTO asset_versions (asset_id, sha256, branch, account_kind, account_id)
					 VALUES ($1::uuid, $2, 'master', 'workspace', 'fk-probe')`,
					[randomUUID(), ZERO_SHA],
				);
			} catch (error) {
				fkError = error;
			}
			await sql.unsafe("ROLLBACK").catch(() => undefined);
			expect(fkError).toBeDefined();
			expect(String((fkError as Error).message)).toContain("asset_versions_asset_id_fkey");
		} finally {
			await sql.close?.();
		}
	});

	test("deleting the asset record CASCADEs its version rows (accounting must be released BEFORE)", async () => {
		const sql: any = new (globalThis as any).Bun.SQL(TEST_DATABASE_URL as string, { max: 1 });
		const recordId = randomUUID();
		try {
			await sql.unsafe("BEGIN");
			// Minimal parent row + blob row to satisfy the FKs, then a version.
			await sql.unsafe(
				`INSERT INTO asset_records (id, asset_id, project_id, image_id, original_name, mime_type, kind, sha256, byte_size, storage_driver, storage_key, storage_status, moderation_status)
				 VALUES ($1::uuid, $2, 'fk-probe-project', $3, 'probe.png', 'image/png', 'human', $4, 1, 'local', 'content/probe', 'released', 'passed')`,
				[recordId, `probe-${recordId}.png`, `probe-${recordId}.png`, ZERO_SHA.toString("hex")],
			).catch(async (error: unknown) => {
				// Column sets differ across migration vintages; a shape mismatch here
				// invalidates the probe, not the invariant — surface it loudly.
				throw new Error(`asset_records probe insert failed (schema drift?): ${String(error)}`);
			});
			await sql.unsafe(
				`INSERT INTO content_blobs (sha256, byte_size, mime_type, ref_count, storage_driver, storage_key)
				 VALUES ($1, 1, 'image/png', 1, 'local', 'content/probe')
				 ON CONFLICT (sha256) DO NOTHING`,
				[ZERO_SHA],
			);
			await sql.unsafe(
				`INSERT INTO asset_versions (asset_id, sha256, branch, account_kind, account_id)
				 VALUES ($1::uuid, $2, 'master', 'workspace', 'fk-probe')`,
				[recordId, ZERO_SHA],
			);
			await sql.unsafe(`DELETE FROM asset_records WHERE id = $1::uuid`, [recordId]);
			const left = await sql.unsafe(
				`SELECT count(*)::int AS n FROM asset_versions WHERE asset_id = $1::uuid`,
				[recordId],
			);
			expect(left[0].n).toBe(0);
			await sql.unsafe("ROLLBACK");
		} finally {
			await sql.unsafe("ROLLBACK").catch(() => undefined);
			await sql.close?.();
		}
	});
});
