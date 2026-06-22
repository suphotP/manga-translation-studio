import type { ImageEditLayerData, ProjectState } from "../types/index.js";

/**
 * Phase C — shared edit-layer asset helpers.
 *
 * Non-destructive image edits (bubble-clean / brush / heal / clone) reference small
 * uploaded assets by id (the alpha mask, the realized RGBA patch, and — for clone — a
 * source image). Two independent subsystems need to enumerate those ids:
 *   - asset-deletion / GC reference checks (so an edit's asset is never deleted while a
 *     LIVE or VERSION-SNAPSHOT edit layer still points at it — data-loss guard), and
 *   - version diff identity comparison (so swapping a mask/patch counts as a change).
 * Keeping the extraction here means both paths stay in sync as new payload kinds land.
 */

/** All asset ids an edit layer's payload references (mask / patch / realized / source). */
export function editLayerAssetIds(layer: ImageEditLayerData | undefined | null): string[] {
	if (!layer || !layer.payload) return [];
	const ids: string[] = [];
	const push = (id: unknown) => {
		if (typeof id === "string" && id) ids.push(id);
	};
	const payload = layer.payload;
	switch (payload.type) {
		case "fill-mask":
			push(payload.maskAssetId);
			break;
		case "patch":
			push(payload.patchAssetId);
			break;
		case "healing":
			push(payload.maskAssetId);
			push(payload.realizedPatchAssetId);
			break;
		case "clone":
			push(payload.maskAssetId);
			push(payload.realizedPatchAssetId);
			// `sourceImageId` is usually the page background (protected on its own), but a
			// clone may sample a different asset — include it so it is never GC'd out from
			// under a snapshot.
			push(payload.sourceImageId);
			break;
	}
	return ids;
}

/**
 * Every edit-layer asset id referenced anywhere in a project state (across all pages).
 * Used to extend asset-deletion reference scans to durable version snapshots: an edit
 * reverted out of LIVE state can still be referenced by a stored snapshot, and restoring
 * that snapshot must still find the asset.
 */
export function collectEditLayerAssetIds(state: ProjectState | undefined | null): Set<string> {
	const ids = new Set<string>();
	if (!state || !Array.isArray(state.pages)) return ids;
	for (const page of state.pages) {
		for (const layer of page?.imageEditLayers ?? []) {
			for (const id of editLayerAssetIds(layer)) ids.add(id);
		}
	}
	return ids;
}
