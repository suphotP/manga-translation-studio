import { describe, expect, test } from "bun:test";
import { resolveProjectState } from "../utils/project-state-file.js";
import type { ProjectState } from "../types/index.js";

// Unit coverage for the SHARED catalog-aware project-state resolver that the
// workflow routes (export, images, ai, text-qa, usage, crops) now use instead of
// reading state.json directly. The precedence here MUST match the canonical
// `/api/project` route (project.ts `loadProjectState`), whose own contract lives
// in project-state-reader.test.ts. These tests assert the divergence fix: under a
// Postgres catalog (fallback disabled) the catalog row is authoritative and a
// stale file is never served; file-mode (fallback enabled) keeps file-first.

function createProjectState(projectId = "project-db"): ProjectState {
	return {
		projectId,
		userId: "user-1",
		name: "DB project",
		createdAt: "2026-05-29T00:00:00.000Z",
		pages: [],
		currentPage: 0,
		targetLang: "th",
	};
}

describe("resolveProjectState (shared workflow-route reader)", () => {
	test("catalog-authoritative: prefers catalog state over a stale file when fallback is disabled", async () => {
		// THE FIX: a Postgres deployment (PROJECT_CATALOG_FILE_FALLBACK_ENABLED=false)
		// must serve the catalog row, never the stale state.json, and must not even
		// touch the file.
		const catalogState = createProjectState("catalog-project");
		catalogState.name = "Authoritative catalog";
		let fileReadCount = 0;

		const result = await resolveProjectState(catalogState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([catalogState.projectId]),
				getProjectState: async () => catalogState,
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: false,
			fileReader: () => {
				fileReadCount += 1;
				const stale = createProjectState("catalog-project");
				stale.name = "STALE FILE that must not win";
				return stale;
			},
		});

		expect(result).toEqual(catalogState);
		expect(fileReadCount).toBe(0);
	});

	test("file-mode parity: prefers local file state over catalog when fallback is enabled (byte-identical dev behavior)", async () => {
		const catalogState = createProjectState("catalog-project");
		const fileState = createProjectState("catalog-project");
		fileState.name = "Newer file project";

		const result = await resolveProjectState(catalogState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([catalogState.projectId]),
				getProjectState: async () => catalogState,
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: true,
			fileReader: () => fileState,
		});

		expect(result).toEqual(fileState);
	});

	test("file mode (no catalog store configured) reads the file reader directly", async () => {
		const fileState = createProjectState("file-only-project");
		const result = await resolveProjectState(fileState.projectId, {
			catalogStore: null,
			fileReader: () => fileState,
		});
		expect(result).toEqual(fileState);
	});

	test("fails closed: surfaces catalog errors and never probes the file when fallback is disabled", async () => {
		let fileReadCount = 0;
		await expect(resolveProjectState("db-error-project", {
			catalogStore: {
				findExistingProjectIds: async () => new Set(["db-error-project"]),
				getProjectState: async () => {
					throw new Error("database unavailable");
				},
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: false,
			fileReader: () => {
				fileReadCount += 1;
				return createProjectState("file-project");
			},
		})).rejects.toThrow("database unavailable");
		expect(fileReadCount).toBe(0);
	});

	test("does not probe local files when fallback is disabled and the catalog row is missing", async () => {
		let fileReadCount = 0;
		const result = await resolveProjectState("missing-project", {
			catalogStore: {
				findExistingProjectIds: async () => new Set(),
				getProjectState: async () => null,
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: false,
			fileReader: () => {
				fileReadCount += 1;
				return null;
			},
		});
		expect(result).toBeNull();
		expect(fileReadCount).toBe(0);
	});

	test("backfills legacy catalog rows that have no current_state yet (production mode)", async () => {
		const fileState = createProjectState("legacy-project");
		let upsertedState: ProjectState | null = null;

		const result = await resolveProjectState(fileState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([fileState.projectId]),
				getProjectState: async () => null,
				upsertProjectState: async (state) => {
					upsertedState = state;
				},
			},
			fileFallbackEnabled: false,
			fileReader: () => fileState,
		});

		expect(result).toEqual(fileState);
		expect(upsertedState).toEqual(fileState);
	});

	test("falls back to file state when catalog misses and fallback is enabled", async () => {
		const fileState = createProjectState("file-project");
		const result = await resolveProjectState(fileState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([fileState.projectId]),
				getProjectState: async () => null,
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: true,
			fileReader: () => fileState,
		});
		expect(result).toEqual(fileState);
	});

	test("uses catalog state when the local fallback file is unreadable", async () => {
		const catalogState = createProjectState("catalog-project");
		const result = await resolveProjectState(catalogState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([catalogState.projectId]),
				getProjectState: async () => catalogState,
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: true,
			fileReader: () => {
				throw new Error("corrupt local state");
			},
		});
		expect(result).toEqual(catalogState);
	});

	test("a tombstoned project never resurrects, even with a readable file/catalog copy", async () => {
		const fileState = createProjectState("tombstoned-project");
		let fileReadCount = 0;
		let backfilled = false;

		const result = await resolveProjectState(fileState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([fileState.projectId]),
				getProjectState: async () => null,
				upsertProjectState: async () => {
					backfilled = true;
				},
			},
			fileFallbackEnabled: true,
			fileReader: () => {
				fileReadCount += 1;
				return fileState;
			},
			tombstoneCheck: () => true,
		});

		expect(result).toBeNull();
		expect(fileReadCount).toBe(0);
		expect(backfilled).toBe(false);
	});
});
