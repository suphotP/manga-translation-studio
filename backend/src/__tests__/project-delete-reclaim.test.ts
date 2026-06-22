// Unit tests for the idempotent project-delete COMPLETION phase
// (`finishProjectDeletion` in routes/project.ts) — the data-integrity fix for the
// "transient catalog-delete throws → CoW reclaim never runs → orphaned asset_records
// + inflated quota forever" P2 bug.
//
// These drive the completion phase directly with injected stores so the
// catalog-throws→500→retry-reclaims + reorder semantics can be asserted WITHOUT a
// live Postgres (the route's CoW + catalog paths are postgres-gated). The route's
// tombstoned-retry / never-existed branching is covered at the HTTP level in
// routes.test.ts.

import { describe, expect, test } from "bun:test";
import { finishProjectDeletion, ProjectCatalogDeleteFailedError } from "../routes/project.js";

const PROJECT_ID = "deadbeef-0000-4000-8000-000000000001";

// Builds an in-memory harness recording the ORDER in which each reclaim step ran,
// so we can assert "CoW reclaim happens BEFORE catalog delete" and "CoW reclaim
// still happens even when the catalog delete then throws".
function makeHarness(opts: {
	catalogDeleteImpl?: () => Promise<void>;
	cowReclaimImpl?: () => Promise<number>;
	cowEnabled?: boolean;
} = {}) {
	const calls: string[] = [];
	const cowReclaimCalls: string[] = [];
	const catalogDeleteCalls: string[] = [];

	const deps = {
		cowEnabled: opts.cowEnabled ?? true,
		removeProjectDir: (_id: string) => { calls.push("dir"); },
		removeInviteIndex: async (_id: string) => { calls.push("invite"); },
		reclaimCowAssets: async (id: string) => {
			calls.push("cow");
			cowReclaimCalls.push(id);
			return (opts.cowReclaimImpl ?? (async () => 0))();
		},
		catalogStore: {
			deleteProject: async (id: string) => {
				calls.push("catalog");
				catalogDeleteCalls.push(id);
				await (opts.catalogDeleteImpl ?? (async () => {}))();
			},
		},
	};

	return { deps, calls, cowReclaimCalls, catalogDeleteCalls };
}

describe("finishProjectDeletion — idempotent delete completion + reclaim ordering", () => {
	test("runs CoW reclaim BEFORE the catalog-row delete (reorder invariant)", async () => {
		const h = makeHarness();
		await finishProjectDeletion(PROJECT_ID, h.deps);
		// asset_records has no FK to projects, so reclaiming the CoW ledger first means
		// a later catalog-delete failure still leaves storage reclaimed.
		expect(h.calls.indexOf("cow")).toBeLessThan(h.calls.indexOf("catalog"));
		expect(h.calls).toEqual(["dir", "invite", "cow", "catalog"]);
		expect(h.cowReclaimCalls).toEqual([PROJECT_ID]);
		expect(h.catalogDeleteCalls).toEqual([PROJECT_ID]);
	});

	test("a transient catalog-delete failure throws ProjectCatalogDeleteFailedError (→ route 500)", async () => {
		const h = makeHarness({
			catalogDeleteImpl: async () => { throw new Error("transient DB blip"); },
		});
		await expect(finishProjectDeletion(PROJECT_ID, h.deps)).rejects.toBeInstanceOf(ProjectCatalogDeleteFailedError);
	});

	test("the CoW reclaim STILL runs when the catalog delete then fails (reorder pays off)", async () => {
		const h = makeHarness({
			catalogDeleteImpl: async () => { throw new Error("transient DB blip"); },
		});
		await expect(finishProjectDeletion(PROJECT_ID, h.deps)).rejects.toBeInstanceOf(ProjectCatalogDeleteFailedError);
		// The whole point of the reorder: storage is reclaimed even though the catalog
		// delete failed and the request 500s.
		expect(h.cowReclaimCalls).toEqual([PROJECT_ID]);
		expect(h.calls.indexOf("cow")).toBeLessThan(h.calls.indexOf("catalog"));
	});

	test("catalog-delete throws then SUCCEEDS on retry → reclaim runs on BOTH passes (idempotent)", async () => {
		let attempt = 0;
		const cowReclaimCalls: string[] = [];
		const catalogDeleteAttempts: number[] = [];
		const deps = {
			cowEnabled: true,
			removeProjectDir: (_id: string) => {},
			removeInviteIndex: async (_id: string) => {},
			reclaimCowAssets: async (id: string) => { cowReclaimCalls.push(id); return 0; },
			catalogStore: {
				deleteProject: async (_id: string) => {
					attempt += 1;
					catalogDeleteAttempts.push(attempt);
					if (attempt === 1) throw new Error("transient catalog failure");
					// second attempt succeeds (also models the no-op DELETE on an
					// already-gone row — idempotent).
				},
			},
		};

		// First pass: catalog fails → propagates as the 500 sentinel.
		await expect(finishProjectDeletion(PROJECT_ID, deps)).rejects.toBeInstanceOf(ProjectCatalogDeleteFailedError);
		// Retry: catalog succeeds → completes cleanly.
		await finishProjectDeletion(PROJECT_ID, deps);

		// CoW reclaim ran on BOTH passes (idempotent — a no-op the 2nd time in real PG,
		// but always attempted so a first-pass-skipped reclaim is finished on retry).
		expect(cowReclaimCalls).toEqual([PROJECT_ID, PROJECT_ID]);
		expect(catalogDeleteAttempts).toEqual([1, 2]);
	});

	test("a best-effort step failure (disk/invite/CoW) does NOT fail the delete", async () => {
		const calls: string[] = [];
		const deps = {
			cowEnabled: true,
			removeProjectDir: (_id: string) => { throw new Error("EACCES on project dir"); },
			removeInviteIndex: async (_id: string) => { throw new Error("invite index unavailable"); },
			reclaimCowAssets: async (_id: string) => { throw new Error("CoW reclaim blip"); },
			catalogStore: {
				deleteProject: async (_id: string) => { calls.push("catalog"); },
			},
		};
		// None of the best-effort failures bubble: only the catalog delete gates the
		// result, and it succeeds here.
		await finishProjectDeletion(PROJECT_ID, deps);
		expect(calls).toEqual(["catalog"]);
	});

	test("CoW reclaim is skipped when disabled (file-mode / no DATABASE_URL gating)", async () => {
		const h = makeHarness({ cowEnabled: false });
		await finishProjectDeletion(PROJECT_ID, h.deps);
		expect(h.cowReclaimCalls).toEqual([]);
		expect(h.calls).toEqual(["dir", "invite", "catalog"]);
	});

	test("a null catalog store is a no-op for the row delete (idempotent, file mode)", async () => {
		const calls: string[] = [];
		await finishProjectDeletion(PROJECT_ID, {
			cowEnabled: false,
			removeProjectDir: (_id: string) => { calls.push("dir"); },
			removeInviteIndex: async (_id: string) => { calls.push("invite"); },
			catalogStore: null,
		});
		expect(calls).toEqual(["dir", "invite"]);
	});
});
