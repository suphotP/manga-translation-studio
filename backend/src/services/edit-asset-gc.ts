import type { ProjectState } from "../types/index.js";
import { projectCatalogStore } from "./project-catalog.js";
import { assetStore, removeAssetRecordAuthoritativeDetailed } from "./assets.js";
import { getSharedStorageCowService } from "./storage-cow.js";
import type { CapturedCowVersion } from "./storage-cow.js";

/**
 * Phase D — reclaim ORPHANED non-destructive edit-layer assets.
 *
 * When a user reverts/deletes an edit layer in the editor, the layer is removed from
 * `page.imageEditLayers` but its tiny mask/patch asset row is left behind (the delete
 * path intentionally never auto-deletes it, because the same asset may still be pinned
 * by a durable version snapshot — a restore point). For an edit asset that is referenced
 * by NEITHER live state NOR any version snapshot, nothing ever removes the asset_records
 * row, so its CoW blob never drops to ref_count=0 and the existing `gcOrphanBlobs()` cron
 * can never reclaim the bytes. This sweep closes that leak.
 *
 * Strategy (Postgres only — the production storage path):
 *   1. Find candidate edit assets cross-project by their server-tagged
 *      `metadata.assetKind` (cheap, targeted — no full asset-table scan).
 *   2. Per project, resolve the LIVE referenced set (`collectEditLayerAssetIds`) and the
 *      VERSION-SNAPSHOT referenced set (`collectVersionSnapshotEditAssetIds`).
 *   3. An edit asset referenced by NEITHER is orphaned: capture its CoW versions, remove
 *      the asset_records row, then release the captured CoW accounting. That drops the
 *      blob's ref_count toward zero; the existing orphan-blob GC frees the object/bytes —
 *      identical to how project-delete reclaim works.
 *
 * DATA-SAFETY: the snapshot scan is consulted for EVERY candidate, so a layer reverted out
 * of live state but still pinned by a saved version is NEVER reaped (mirrors the hard-block
 * in the interactive delete route). A snapshot-list failure throws → that project is skipped
 * (logged), never treated as "no snapshot references" (which would re-open the data-loss hole).
 *
 * File mode is a no-op: `listEditAssetCandidatesAcrossProjects` returns [] (the prototype
 * file store reclaims a project's whole tree on delete; no cross-project accumulation).
 */
export interface EditAssetGcDeps {
	listCandidates(limit: number): Promise<Array<{ projectId: string; imageId: string }>>;
	getProjectState(projectId: string): Promise<ProjectState | null>;
	/**
	 * True if `imageId` is referenced ANYWHERE in live project state — NOT just by an edit
	 * layer, but also as a page image / baked edit / image layer (or restore source) / per-
	 * language render output / AI marker result / project cover. The reaper must use the SAME
	 * comprehensive scan as the interactive delete route so a client-mis-tagged edit asset that
	 * is actually a page image / cover is never reaped (codex P0-3).
	 */
	isReferencedLive(state: ProjectState | null, imageId: string): boolean;
	/** MUST reject (throw) on any version-store read failure so the caller skips the project. */
	collectSnapshotEditAssetIds(projectId: string): Promise<Set<string>>;
	captureCow(projectId: string, imageId: string): Promise<CapturedCowVersion[]>;
	removeRecord(projectId: string, imageId: string): Promise<{ removed: boolean; durableRemoved: boolean }>;
	releaseCow(captured: CapturedCowVersion[]): Promise<number>;
}

/**
 * Default production wiring: cross-project metadata-tagged candidate scan + the live/
 * snapshot reference resolvers + the same CoW capture/release + record-delete primitives
 * the interactive asset-delete route uses. Lazily imports the snapshot scanner to avoid a
 * service<->route import cycle (it lives on the project route with the version-store deps).
 */
async function defaultDeps(): Promise<EditAssetGcDeps> {
	const cowService = getSharedStorageCowService();
	const { collectVersionSnapshotEditAssetIds } = await import("../routes/project.js");
	// `referencingPageNumbers` is the exact, complete live-reference scanner the interactive
	// asset-delete route uses (page image / baked edit / image layers / language outputs / AI
	// markers). Reusing it verbatim — rather than re-deriving — guarantees the reaper can never
	// diverge from the delete-guard's notion of "referenced". The project-level cover image is
	// the one live reference that scan does not cover, so it is checked explicitly here.
	const { referencingPageNumbers } = await import("../routes/storage.js");
	return {
		listCandidates: (limit) => assetStore.listEditAssetCandidatesAcrossProjects(limit),
		getProjectState: (projectId) => (projectCatalogStore ? projectCatalogStore.getProjectState(projectId) : Promise.resolve(null)),
		isReferencedLive: (state, imageId) =>
			!!state && (referencingPageNumbers(state, imageId).length > 0 || state.coverImageId === imageId),
		// throwOnError: a transient version-store failure MUST abort this project's reap rather
		// than be read as "no snapshot references" (which would reap a snapshot-pinned asset).
		collectSnapshotEditAssetIds: (projectId) => collectVersionSnapshotEditAssetIds(projectId, { throwOnError: true }),
		captureCow: (projectId, imageId) => cowService.captureAssetCowVersions(projectId, imageId),
		removeRecord: (projectId, imageId) => removeAssetRecordAuthoritativeDetailed(projectId, imageId),
		releaseCow: (captured) => cowService.releaseCapturedAssetCowStorage(captured),
	};
}

export async function gcOrphanEditAssets(
	options: { limit?: number; deps?: EditAssetGcDeps } = {},
): Promise<{ scanned: number; reclaimed: number }> {
	const limit = options.limit ?? 2000;
	const deps = options.deps ?? (await defaultDeps());
	const candidates = await deps.listCandidates(limit);
	if (candidates.length === 0) return { scanned: 0, reclaimed: 0 };

	// Group candidates by project so each project's live + snapshot reference sets are
	// resolved exactly once.
	const byProject = new Map<string, string[]>();
	for (const { projectId, imageId } of candidates) {
		const list = byProject.get(projectId);
		if (list) list.push(imageId);
		else byProject.set(projectId, [imageId]);
	}

	let reclaimed = 0;

	for (const [projectId, imageIds] of byProject) {
		let state: ProjectState | null;
		let snapshotIds: Set<string>;
		try {
			state = await deps.getProjectState(projectId);
			// Conservative: a snapshot-list failure THROWS here (deps contract) and we skip the
			// whole project rather than risk reaping a snapshot-pinned asset.
			snapshotIds = await deps.collectSnapshotEditAssetIds(projectId);
		} catch (error) {
			console.warn("[edit-asset-gc] reference scan failed; skipping project", { projectId, error });
			continue;
		}

		for (const imageId of imageIds) {
			// In-use by ANYTHING in live state (page image / baked edit / layer / language
			// output / AI marker / cover — not just an edit layer) OR pinned by a version
			// snapshot → never reap.
			if (deps.isReferencedLive(state, imageId) || snapshotIds.has(imageId)) continue;
			try {
				// Capture CoW accounting BEFORE the row delete (the join to asset_versions
				// must still resolve), let the durable row delete be the single-winner gate,
				// then release only if THIS pass won — mirrors the interactive delete route.
				const captured = await deps.captureCow(projectId, imageId).catch((error) => {
					console.warn("[edit-asset-gc] CoW capture failed (bytes left for orphan-blob GC)", { projectId, imageId, error });
					return [] as CapturedCowVersion[];
				});
				const { removed, durableRemoved } = await deps.removeRecord(projectId, imageId);
				if (!removed) continue;
				if (durableRemoved && captured.length > 0) {
					await deps.releaseCow(captured).catch((error) => {
						console.warn("[edit-asset-gc] CoW release failed (bytes left for orphan-blob GC)", { projectId, imageId, error });
					});
				}
				reclaimed += 1;
			} catch (error) {
				console.warn("[edit-asset-gc] failed to reclaim orphan edit asset", { projectId, imageId, error });
			}
		}
	}

	return { scanned: candidates.length, reclaimed };
}
