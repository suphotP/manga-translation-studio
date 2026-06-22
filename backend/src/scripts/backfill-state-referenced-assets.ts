// One-time, deploy-time backfill (codex P0 round-3 — CSAM-laundering fix).
//
// The asset serve gate FAILS CLOSED on a missing asset record (no on-demand
// "grandfather on first serve"). The old on-serve grandfather trusted
// CLIENT-writable project-state references, so an attacker could park an
// unmoderated object, save a crafted state referencing its id, and have the serve
// path register it `passed` — a CSAM-laundering bypass.
//
// To avoid 403-ing GENUINE pre-registry user images (uploaded before asset records
// existed, still referenced by live state), this script registers a `passed`
// record for every state-referenced existing image object that lacks one. It is
// SERVER-SIDE and runs over the EXISTING corpus at deploy, so it cannot be steered
// by a fresh client save.
//
// SAFE TO RE-RUN: ids that already carry a record are skipped.
//
// Usage:
//   bun run src/scripts/backfill-state-referenced-assets.ts            (live)
//   bun run src/scripts/backfill-state-referenced-assets.ts --dry-run  (count only)
//
// Works in BOTH file mode and Postgres mode (enumerates on-disk state.json, the
// authoritative state file in both deployments). In Postgres mode, ensure
// DATABASE_URL is set so records land in asset_records.

import { backfillStateReferencedAssets } from "../services/assets.js";

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	const result = await backfillStateReferencedAssets({ dryRun });
	const prefix = dryRun ? "[dry-run] " : "";
	console.log(
		`${prefix}Scanned ${result.projectsScanned} project(s); saw ${result.referencesSeen} state reference(s); ` +
			`${result.registered} record(s) ${dryRun ? "would be" : ""} registered, ` +
			`${result.alreadyRegistered} already registered, ${result.skipped} skipped (missing/undecodable).`,
	);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
