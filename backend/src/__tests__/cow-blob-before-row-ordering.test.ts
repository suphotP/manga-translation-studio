import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// FK-ordering invariant (b14, proven on REAL Postgres — see
// cow-fk-ordering.real-pg.test.ts): `asset_versions.asset_id` is an IMMEDIATE
// (non-deferrable) FK to `asset_records(id)`, so `cowService.writeBlob(...)`
// (which inserts the version row) REQUIRES the `asset_records` row to exist
// first. The original blob-before-row order that this file used to pin was the
// bug: it 500'd every upload the moment Storage CoW was enabled (latent in prod
// only because the flag is off). The order is now record → version — the same
// as the cleaned-import path (routes/export.ts) — with explicit compensation:
// a failed writeBlob sweeps the record's stray versions through deleteVersion
// (refcount/quota accounting; a bare record delete would CASCADE them away
// silently) and then removes the record, so no servable row points at a blob
// that never landed.
//
// CoW is Postgres-only (storageCowActive() requires assetRegistryStore=postgres
// + DATABASE_URL), so the real upload loop cannot run under the file-mode test
// runtime. This test pins the ordering + compensation at the source level
// inside the upload-commit loop — exactly what a future refactor could
// silently regress. The FK behavior itself is pinned against live Postgres in
// cow-fk-ordering.real-pg.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const imagesSource = readFileSync(join(here, "..", "routes", "images.ts"), "utf8");

function indexOfFrom(haystack: string, needle: string, from: number): number {
	const idx = haystack.indexOf(needle, from);
	if (idx === -1) throw new Error(`expected to find ${JSON.stringify(needle)} in images.ts upload loop`);
	return idx;
}

describe("CoW upload: record-before-blob ordering (FK requirement)", () => {
	test("recordUploadedAsset runs before cowService.writeBlob inside the upload-commit loop", () => {
		// Anchor on the upload-commit loop so we measure ordering inside the per-
		// candidate body, not some unrelated occurrence elsewhere in the file.
		const loopStart = imagesSource.indexOf("for (const candidate of preparedCandidates)");
		expect(loopStart).toBeGreaterThan(-1);

		const recordAssetIdx = indexOfFrom(imagesSource, "recordUploadedAsset(", loopStart);
		const writeBlobIdx = indexOfFrom(imagesSource, "cowService.writeBlob(", loopStart);

		// The record row MUST exist before the version insert (immediate FK).
		expect(recordAssetIdx).toBeLessThan(writeBlobIdx);
	});

	test("a failed writeBlob compensates: version sweep THEN record removal", () => {
		const loopStart = imagesSource.indexOf("for (const candidate of preparedCandidates)");
		const writeBlobIdx = indexOfFrom(imagesSource, "cowService.writeBlob(", loopStart);
		// Inside the writeBlob catch: stray versions are released through
		// deleteVersion (full accounting) before the record is removed — a bare
		// record delete would CASCADE the version rows away without releasing
		// refcount/quota.
		const sweepIdx = indexOfFrom(imagesSource, "SELECT version_id FROM asset_versions WHERE asset_id", writeBlobIdx);
		const deleteVersionIdx = indexOfFrom(imagesSource, "cowService.deleteVersion(", writeBlobIdx);
		const removeRecordIdx = indexOfFrom(imagesSource, "removeAssetRecordAuthoritative(projectId, imageId)", writeBlobIdx);
		expect(sweepIdx).toBeLessThan(removeRecordIdx);
		expect(deleteVersionIdx).toBeLessThan(removeRecordIdx);
	});

	test("the CoW record is HELD non-servable until the blob lands (crash-window safety)", () => {
		const loopStart = imagesSource.indexOf("for (const candidate of preparedCandidates)");
		const recordAssetIdx = indexOfFrom(imagesSource, "recordUploadedAsset(", loopStart);
		// The record is created quarantined when CoW is active; the finalize call
		// (which runs after writeBlob — pinned below) releases it. A crash between
		// the row insert and the blob write therefore leaves only a non-servable
		// orphan, never a released record pointing at content that never landed.
		const holdIdx = indexOfFrom(imagesSource, "holdStorageStatus: Boolean(cowService && cowAccount)", recordAssetIdx);
		const writeBlobIdx = indexOfFrom(imagesSource, "cowService.writeBlob(", loopStart);
		expect(holdIdx).toBeLessThan(writeBlobIdx);
	});

	test("the row is finalized as servable only after the blob write", () => {
		const loopStart = imagesSource.indexOf("for (const candidate of preparedCandidates)");
		const writeBlobIdx = indexOfFrom(imagesSource, "cowService.writeBlob(", loopStart);
		const finalizeIdx = indexOfFrom(imagesSource, "updateAssetModerationAuthoritative(", loopStart);
		expect(writeBlobIdx).toBeLessThan(finalizeIdx);
	});
});
