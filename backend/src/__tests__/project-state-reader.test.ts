import { describe, expect, test } from "bun:test";
import { loadProjectState, resolveProjectVersionRecord } from "../routes/project.js";
import type { ProjectVersionRecord } from "../services/project-catalog.js";
import type { ProjectState } from "../types/index.js";

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

function createProjectVersionRecord(projectId = "project-db", versionId = "version-alpha", name = "DB version"): ProjectVersionRecord {
	const state = createProjectState(projectId);
	state.name = name;
	return {
		metadata: {
			versionId,
			projectId,
			name,
			source: "save",
			createdAt: "2026-05-29T00:00:00.000Z",
			pageCount: state.pages.length,
			textLayerCount: 0,
			stateHash: `${versionId}-hash`,
		},
		state,
	};
}

describe("project state reader", () => {
	test("prefers catalog current_state in production mode without file fallback", async () => {
		const state = createProjectState();
		let fileReadCount = 0;

		const result = await loadProjectState(state.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([state.projectId]),
				getProjectState: async () => state,
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: false,
			fileReader: () => {
				fileReadCount += 1;
				return createProjectState("file-project");
			},
		});

		expect(result).toEqual(state);
		expect(fileReadCount).toBe(0);
	});

	test("falls back to file state when catalog misses and fallback is enabled", async () => {
		const fileState = createProjectState("file-project");

		const result = await loadProjectState(fileState.projectId, {
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

	test("prefers local file state over catalog state when fallback is enabled", async () => {
		const catalogState = createProjectState("catalog-project");
		const fileState = createProjectState("catalog-project");
		fileState.name = "Newer file project";

		const result = await loadProjectState(catalogState.projectId, {
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

	test("uses catalog state when local fallback is unreadable", async () => {
		const catalogState = createProjectState("catalog-project");

		const result = await loadProjectState(catalogState.projectId, {
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

	test("falls back to file state on catalog errors only when the local state exists", async () => {
		const fileState = createProjectState("file-project");

		const result = await loadProjectState(fileState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([fileState.projectId]),
				getProjectState: async () => {
					throw new Error("database unavailable");
				},
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: true,
			fileReader: () => fileState,
		});

		expect(result).toEqual(fileState);
	});

	test("surfaces catalog errors when fallback mode has no local state", async () => {
		await expect(loadProjectState("catalog-only-project", {
			catalogStore: {
				findExistingProjectIds: async () => new Set(["catalog-only-project"]),
				getProjectState: async () => {
					throw new Error("database unavailable");
				},
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: true,
			fileReader: () => null,
		})).rejects.toThrow("database unavailable");
	});

	test("backfills legacy catalog rows that do not have current_state yet", async () => {
		const fileState = createProjectState("legacy-project");
		let upsertedState: ProjectState | null = null;

		const result = await loadProjectState(fileState.projectId, {
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

	test("does not probe local files when fallback is disabled and the catalog row is missing", async () => {
		let fileReadCount = 0;

		const result = await loadProjectState("missing-project", {
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

	test("fails closed on catalog errors when fallback is disabled", async () => {
		let fileReadCount = 0;

		await expect(loadProjectState("db-error-project", {
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

	test("a tombstoned project never resurrects, even if a readable file/catalog copy survived a partial delete", async () => {
		// Simulates the P1.1 resurrection bug: a DELETE cleared the catalog row but a
		// partial/failed disk rmSync (or a stale replica) left a readable state.json,
		// which the file fallback + backfill would otherwise re-create. The deletion
		// tombstone must short-circuit the read and return null (gone for good).
		const fileState = createProjectState("tombstoned-project");
		let fileReadCount = 0;
		let backfilled = false;

		const result = await loadProjectState(fileState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([fileState.projectId]),
				getProjectState: async () => null, // catalog row already deleted
				upsertProjectState: async () => {
					backfilled = true;
				},
			},
			fileFallbackEnabled: true,
			fileReader: () => {
				fileReadCount += 1;
				return fileState; // a stale state.json that WOULD resurrect without the tombstone
			},
			tombstoneCheck: () => true,
		});

		expect(result).toBeNull();
		// Must not even read the stale file or backfill the catalog.
		expect(fileReadCount).toBe(0);
		expect(backfilled).toBe(false);
	});

	test("a non-tombstoned project still loads normally", async () => {
		const fileState = createProjectState("live-project");
		const result = await loadProjectState(fileState.projectId, {
			catalogStore: {
				findExistingProjectIds: async () => new Set([fileState.projectId]),
				getProjectState: async () => null,
				upsertProjectState: async () => {},
			},
			fileFallbackEnabled: true,
			fileReader: () => fileState,
			tombstoneCheck: () => false,
		});
		expect(result).toEqual(fileState);
	});

	test("prefers catalog version records when file fallback is disabled", async () => {
		const catalogRecord = createProjectVersionRecord("project-db", "version-one", "Catalog version");
		let fileReadCount = 0;

		const result = await resolveProjectVersionRecord(catalogRecord.metadata.projectId, catalogRecord.metadata.versionId, {
			catalogStore: {
				getProjectVersion: async () => catalogRecord,
			},
			fileFallbackEnabled: false,
			fileReader: () => {
				fileReadCount += 1;
				return createProjectVersionRecord("project-db", "version-one", "Local stale version");
			},
		});

		expect(result).toEqual(catalogRecord);
		expect(fileReadCount).toBe(0);
	});

	test("does not probe local version files on catalog misses when fallback is disabled", async () => {
		let fileReadCount = 0;

		const result = await resolveProjectVersionRecord("project-db", "version-missing", {
			catalogStore: {
				getProjectVersion: async () => null,
			},
			fileFallbackEnabled: false,
			fileReader: () => {
				fileReadCount += 1;
				return createProjectVersionRecord("project-db", "version-missing", "Local stale version");
			},
		});

		expect(result).toBeNull();
		expect(fileReadCount).toBe(0);
	});

	test("falls back to local version files on catalog misses only when fallback is enabled", async () => {
		const fileRecord = createProjectVersionRecord("project-db", "version-local", "Local version");

		const result = await resolveProjectVersionRecord(fileRecord.metadata.projectId, fileRecord.metadata.versionId, {
			catalogStore: {
				getProjectVersion: async () => null,
			},
			fileFallbackEnabled: true,
			fileReader: () => fileRecord,
		});

		expect(result).toEqual(fileRecord);
	});
});
