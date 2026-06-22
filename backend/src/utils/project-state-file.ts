// Tombstone-aware, file-mode project-state reader.
//
// MANY route/service code paths read a project's on-disk `state.json` directly
// to make an access/ownership decision (export, images, text-qa, ai, crops, …).
// A permanently-deleted project leaves behind a durable deletion tombstone
// (PROJECTS_DIR/.tombstones/<id>); a *stale* state.json can survive a partially
// failed delete (e.g. an rmSync that failed after the tombstone was written).
//
// Every shared file-state read MUST funnel through this one helper so a
// tombstoned id can NEVER be served — no resurrected export, image fetch, or
// QA run from a stale state.json. This is the file-mode analogue of the file
// catalog's `readState` (which already honors the tombstone) and of the route
// `loadProjectState` (catalog-aware). Writing fresh state for an id clears the
// tombstone (see writeProjectState), so a legitimately re-created id reads fine.

import { existsSync } from "fs";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "./json-file.js";
import { isProjectTombstonedIn, isValidProjectId, safePath } from "./security.js";
import { projectCatalogStore as defaultProjectCatalogStore, type ProjectCatalogStore } from "../services/project-catalog.js";
import type { ProjectState } from "../types/index.js";

/**
 * Read a project's on-disk `state.json`, refusing tombstoned (permanently
 * deleted) ids. Returns null when the id is invalid, tombstoned, missing, or
 * unreadable. This is the single tombstone-aware chokepoint for direct
 * file-mode project-state reads outside the catalog.
 */
export function readProjectStateFileGuarded<T = ProjectState>(projectId: string): T | null {
	if (!isValidProjectId(projectId)) return null;
	// Durable "this id is gone" record — honor it before any read so a stale
	// state.json that outlived a partial delete can't resurrect the project.
	if (isProjectTombstonedIn(PROJECTS_DIR, projectId)) return null;
	const statePath = safePath(PROJECTS_DIR, projectId, "state.json");
	if (!existsSync(statePath)) return null;
	try {
		return readJsonFile<T>(statePath);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Catalog-aware project-state resolver (shared workflow-route reader).
//
// The workflow routes (export, images, ai, text-qa, usage, crops) historically
// read a project's on-disk `state.json` directly via readProjectStateFileGuarded
// for their access/ownership decisions. Under a Postgres catalog deployment that
// IGNORES the authoritative catalog row, so those routes could serve stale or
// missing file state while the canonical `/api/project` route (project.ts
// `loadProjectState`) correctly resolves catalog-aware state.
//
// This is the SHARED resolver those routes use so all of them get the same
// catalog-authoritative precedence as the canonical project route. The
// precedence rule is intentionally IDENTICAL to project.ts `loadProjectState`
// (which remains owned by the project-route engineer and is NOT edited here):
//
//   * tombstone first — a permanently-deleted id never resurrects, even if a
//     stale state.json or catalog row survived a partial delete.
//   * catalog present, file fallback DISABLED (production / hardening on,
//     PROJECT_CATALOG_FILE_FALLBACK_ENABLED=false): the catalog row is
//     AUTHORITATIVE — file state is never consulted. This is the fix for the
//     "stale file wins over catalog" divergence under Postgres.
//   * catalog present, file fallback ENABLED (dev / test / explicit backfill
//     window): file state is preferred when readable, catalog otherwise. This
//     file-first preference is a DELIBERATE migration/backfill affordance (see
//     `defaultProjectCatalogFileFallbackEnabled`, commit cc7c8d0b "Gate project
//     catalog file fallback in production" and docs/DEPLOYMENT.md) and is left
//     unchanged so file-mode behavior stays byte-identical.
//   * catalog absent (file mode, no DATABASE_URL): the file reader is the only
//     source — identical to the pre-existing readProjectStateFileGuarded path.
//
// NOTE: project.ts should later be migrated to import this same resolver so the
// precedence lives in exactly one place; that migration cannot happen here
// because project.ts is owned by a parallel engineer (see PR QUESTIONS).

type ProjectStateCatalogReader = Pick<ProjectCatalogStore, "findExistingProjectIds" | "getProjectState" | "upsertProjectState">;

export interface LoadProjectStateOptions {
	catalogStore?: ProjectStateCatalogReader | null;
	fileFallbackEnabled?: boolean;
	fileReader?: (projectId: string) => ProjectState | null;
	tombstoneCheck?: (projectId: string) => boolean;
}

/**
 * Resolve a project's state honoring the Postgres catalog when configured, with
 * the SAME precedence as the canonical `/api/project` route. Workflow routes
 * MUST use this instead of reading `state.json` directly so they do not diverge
 * from the catalog under Postgres deployments.
 *
 * Throws (does not swallow) on a catalog read/backfill failure when file
 * fallback is disabled, so a Postgres-authoritative deployment fails closed
 * rather than silently serving file state.
 */
export async function resolveProjectState(
	projectId: string,
	options: LoadProjectStateOptions = {},
): Promise<ProjectState | null> {
	const catalogStore = options.catalogStore ?? defaultProjectCatalogStore;
	const fileReader = options.fileReader ?? ((id: string) => readProjectStateFileGuarded(id));
	const tombstoneCheck = options.tombstoneCheck ?? ((id: string) => isProjectTombstonedIn(PROJECTS_DIR, id));
	// A permanently-deleted project must never resurrect, even if a partial delete
	// (failed disk rmSync, or a catalog row that outlived its file tree) left a
	// readable source behind for the file fallback / backfill to pick up.
	if (tombstoneCheck(projectId)) return null;
	if (catalogStore) {
		const fileFallbackEnabled = options.fileFallbackEnabled ?? serverConfig.projectCatalogFileFallbackEnabled;
		try {
			const catalogState = await catalogStore.getProjectState(projectId);
			if (catalogState && fileFallbackEnabled) {
				try {
					return fileReader(projectId) ?? catalogState;
				} catch (error) {
					console.warn("Project file fallback read failed; using catalog state", { projectId, error });
					return catalogState;
				}
			}
			if (catalogState) return catalogState;
		} catch (error) {
			if (!fileFallbackEnabled) throw error;
			console.warn("Project catalog state read failed; falling back to file state", { projectId, error });
			const fileState = fileReader(projectId);
			if (fileState) return fileState;
			throw error;
		}
		const catalogRowExists = fileFallbackEnabled
			? true
			: (await catalogStore.findExistingProjectIds([projectId])).has(projectId);
		if (!catalogRowExists) return null;
		const fileState = fileReader(projectId);
		if (fileState) {
			try {
				await catalogStore.upsertProjectState(fileState);
			} catch (error) {
				if (!fileFallbackEnabled) throw error;
				console.warn("Project catalog state backfill failed; falling back to file state", { projectId, error });
			}
			return fileState;
		}
		return null;
	}
	return fileReader(projectId);
}
