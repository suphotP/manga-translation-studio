import type { ImageEditLayerData, ImageLayerData, PageState, ProjectState, TextLayerData } from "../types/index.js";
import { editLayerAssetIds } from "./edit-layer-assets.js";

/**
 * W3.9 — visual version diff + selective per-page/layer restore.
 *
 * Pure, side-effect-free helpers so diff computation and the selective-restore
 * merge are unit-testable in isolation from the HTTP layer. Pages are addressed
 * by index (the project model has no stable page id); layers are addressed by
 * their stable `id` field.
 */

export type LayerKind = "text" | "image";

export type LayerChangeType = "added" | "removed" | "moved" | "edited" | "restyled";

export interface LayerDiffEntry {
	layerId: string;
	kind: LayerKind;
	name?: string;
	/** A given layer can change in several ways at once (e.g. moved + edited). */
	changes: LayerChangeType[];
	/** Text before/after for text layers, when the text content changed. */
	textBefore?: string;
	textAfter?: string;
}

export interface PageDiffEntry {
	pageIndex: number;
	label: string;
	/** Page-level status relative to the base→target transition. */
	status: "added" | "removed" | "changed" | "unchanged";
	baseImageId?: string;
	targetImageId?: string;
	/** True when the page's primary image (or composited edit image) changed. */
	imageChanged: boolean;
	baseTextLayerCount: number;
	targetTextLayerCount: number;
	baseImageLayerCount: number;
	targetImageLayerCount: number;
	/** Phase C — non-destructive edit-layer (bubble-clean/brush/heal/clone) counts. */
	baseEditLayerCount: number;
	targetEditLayerCount: number;
	layers: LayerDiffEntry[];
}

export interface VersionStateSummary {
	name: string;
	storyId?: string;
	storyTitle?: string;
	chapterNumber?: string;
	chapterTitle?: string;
	chapterLabel?: string;
	pageCount: number;
	textLayerCount: number;
	/** Phase C — total non-destructive image edits across the project. */
	editLayerCount: number;
	pages: Array<{
		pageIndex: number;
		imageId: string;
		imageName: string;
		originalName?: string;
		textLayerCount: number;
		imageLayerCount: number;
		editLayerCount: number;
	}>;
}

export interface VersionDiff {
	base: VersionStateSummary;
	target: VersionStateSummary;
	pageDelta: number;
	textLayerDelta: number;
	imageLayerDelta: number;
	/** Phase C — target − base count of non-destructive image edits. */
	editLayerDelta: number;
	addedPageCount: number;
	removedPageCount: number;
	changedPageCount: number;
	/** Page entries that differ (added/removed/changed); capped for transport. */
	pages: PageDiffEntry[];
}

const MAX_DIFF_PAGES = 200;
const MAX_DIFF_LAYERS_PER_PAGE = 200;
/** Layer position/size moves below this many px are treated as noise. */
const MOVE_EPSILON = 0.5;

function pageLabel(page: PageState | undefined, fallbackIndex: number): string {
	return (
		page?.originalName?.trim() ||
		page?.imageName?.trim() ||
		`Page ${fallbackIndex + 1}`
	);
}

function pageImageId(page: PageState | undefined): string | undefined {
	if (!page) return undefined;
	return page.edits?.imageId ?? page.imageId;
}

function countImageLayers(state: ProjectState): number {
	return state.pages.reduce((total, page) => total + (page.imageLayers?.length ?? 0), 0);
}

function countTextLayers(state: ProjectState): number {
	return state.pages.reduce((total, page) => total + (page.textLayers?.length ?? 0), 0);
}

function countEditLayers(state: ProjectState): number {
	return state.pages.reduce((total, page) => total + (page.imageEditLayers?.length ?? 0), 0);
}

export function summarizeVersionState(state: ProjectState): VersionStateSummary {
	return {
		name: state.name,
		storyId: state.storyId,
		storyTitle: state.storyTitle,
		chapterNumber: state.chapterNumber,
		chapterTitle: state.chapterTitle,
		chapterLabel: state.chapterLabel,
		pageCount: state.pages.length,
		textLayerCount: countTextLayers(state),
		editLayerCount: countEditLayers(state),
		pages: state.pages.map((page, pageIndex) => ({
			pageIndex,
			imageId: page.imageId,
			imageName: page.imageName,
			originalName: page.originalName,
			textLayerCount: page.textLayers?.length ?? 0,
			imageLayerCount: page.imageLayers?.length ?? 0,
			editLayerCount: page.imageEditLayers?.length ?? 0,
		})),
	};
}

function indexById<T extends { id: string }>(layers: T[] | undefined): Map<string, T> {
	const map = new Map<string, T>();
	for (const layer of layers ?? []) {
		if (layer && typeof layer.id === "string" && layer.id) map.set(layer.id, layer);
	}
	return map;
}

function moved(
	a: { x: number; y: number; w: number; h: number; rotation: number },
	b: { x: number; y: number; w: number; h: number; rotation: number },
): boolean {
	return (
		Math.abs(a.x - b.x) > MOVE_EPSILON ||
		Math.abs(a.y - b.y) > MOVE_EPSILON ||
		Math.abs(a.w - b.w) > MOVE_EPSILON ||
		Math.abs(a.h - b.h) > MOVE_EPSILON ||
		Math.abs(a.rotation - b.rotation) > MOVE_EPSILON
	);
}

function textRestyled(base: TextLayerData, target: TextLayerData): boolean {
	return (
		base.fontSize !== target.fontSize ||
		(base.fontFamily ?? "") !== (target.fontFamily ?? "") ||
		(base.fill ?? "") !== (target.fill ?? "") ||
		(base.stroke ?? "") !== (target.stroke ?? "") ||
		(base.strokeWidth ?? 0) !== (target.strokeWidth ?? 0) ||
		base.alignment !== target.alignment ||
		JSON.stringify(base.effects ?? null) !== JSON.stringify(target.effects ?? null)
	);
}

function bboxMoved(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
	return (
		Math.abs(a.x - b.x) > MOVE_EPSILON ||
		Math.abs(a.y - b.y) > MOVE_EPSILON ||
		Math.abs(a.w - b.w) > MOVE_EPSILON ||
		Math.abs(a.h - b.h) > MOVE_EPSILON
	);
}

/**
 * P1-3 — detect a non-destructive edit-layer change between two page states by IDENTITY,
 * not just count. Restoring a snapshot can visibly change the page even at the same edit
 * count: a toggled `visible` flag, a swapped mask/patch asset, a moved bbox, or a changed
 * payload all repaint differently. Returns true when any edit layer was added/removed, or
 * an edit with the same id differs in visibility / bbox / payload asset ids.
 */
function editLayersDiffer(
	base: ImageEditLayerData[] | undefined,
	target: ImageEditLayerData[] | undefined,
): boolean {
	const baseList = base ?? [];
	const targetList = target ?? [];
	if (baseList.length !== targetList.length) return true;
	const baseById = indexById(baseList);
	const targetById = indexById(targetList);
	if (baseById.size !== targetById.size) return true; // duplicate/missing ids
	for (const [id, targetLayer] of targetById) {
		const baseLayer = baseById.get(id);
		if (!baseLayer) return true; // identity changed (added/removed at same count)
		if (Boolean(baseLayer.visible) !== Boolean(targetLayer.visible)) return true;
		if (bboxMoved(baseLayer.bbox, targetLayer.bbox)) return true;
		const baseAssets = editLayerAssetIds(baseLayer).join("|");
		const targetAssets = editLayerAssetIds(targetLayer).join("|");
		if (baseAssets !== targetAssets) return true;
		// Payload shape/params change (e.g. fill colour, algorithm) is also a visible change.
		if (JSON.stringify(baseLayer.payload) !== JSON.stringify(targetLayer.payload)) return true;
	}
	return false;
}

function imageRestyled(base: ImageLayerData, target: ImageLayerData): boolean {
	return (
		base.opacity !== target.opacity ||
		(base.blendMode ?? "") !== (target.blendMode ?? "") ||
		Boolean(base.flipX) !== Boolean(target.flipX) ||
		Boolean(base.flipY) !== Boolean(target.flipY) ||
		Boolean(base.visible ?? true) !== Boolean(target.visible ?? true) ||
		base.imageId !== target.imageId
	);
}

function diffTextLayers(base: TextLayerData[] | undefined, target: TextLayerData[] | undefined): LayerDiffEntry[] {
	const baseById = indexById(base);
	const targetById = indexById(target);
	const entries: LayerDiffEntry[] = [];

	for (const [id, targetLayer] of targetById) {
		const baseLayer = baseById.get(id);
		if (!baseLayer) {
			entries.push({ layerId: id, kind: "text", name: targetLayer.name, changes: ["added"], textAfter: targetLayer.text });
			continue;
		}
		const changes: LayerChangeType[] = [];
		const textChanged = baseLayer.text !== targetLayer.text;
		if (textChanged) changes.push("edited");
		if (moved(baseLayer, targetLayer)) changes.push("moved");
		if (textRestyled(baseLayer, targetLayer)) changes.push("restyled");
		if (changes.length) {
			entries.push({
				layerId: id,
				kind: "text",
				name: targetLayer.name ?? baseLayer.name,
				changes,
				...(textChanged ? { textBefore: baseLayer.text, textAfter: targetLayer.text } : {}),
			});
		}
	}
	for (const [id, baseLayer] of baseById) {
		if (!targetById.has(id)) {
			entries.push({ layerId: id, kind: "text", name: baseLayer.name, changes: ["removed"], textBefore: baseLayer.text });
		}
	}
	return entries;
}

function diffImageLayers(base: ImageLayerData[] | undefined, target: ImageLayerData[] | undefined): LayerDiffEntry[] {
	const baseById = indexById(base);
	const targetById = indexById(target);
	const entries: LayerDiffEntry[] = [];

	for (const [id, targetLayer] of targetById) {
		const baseLayer = baseById.get(id);
		if (!baseLayer) {
			entries.push({ layerId: id, kind: "image", name: targetLayer.name, changes: ["added"] });
			continue;
		}
		const changes: LayerChangeType[] = [];
		if (moved(baseLayer, targetLayer)) changes.push("moved");
		if (imageRestyled(baseLayer, targetLayer)) changes.push("restyled");
		if (changes.length) {
			entries.push({ layerId: id, kind: "image", name: targetLayer.name ?? baseLayer.name, changes });
		}
	}
	for (const [id, baseLayer] of baseById) {
		if (!targetById.has(id)) {
			entries.push({ layerId: id, kind: "image", name: baseLayer.name, changes: ["removed"] });
		}
	}
	return entries;
}

/**
 * Compute a page- and layer-level diff describing what would change when moving
 * from `baseState` to `targetState`. The summary is symmetric; "delta" fields
 * are target − base.
 */
export function computeVersionDiff(baseState: ProjectState, targetState: ProjectState): VersionDiff {
	const base = summarizeVersionState(baseState);
	const target = summarizeVersionState(targetState);
	const maxPages = Math.max(baseState.pages.length, targetState.pages.length);
	const pages: PageDiffEntry[] = [];
	let addedPageCount = 0;
	let removedPageCount = 0;
	let changedPageCount = 0;

	for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
		const basePage = baseState.pages[pageIndex];
		const targetPage = targetState.pages[pageIndex];
		const baseTextCount = basePage?.textLayers?.length ?? 0;
		const targetTextCount = targetPage?.textLayers?.length ?? 0;
		const baseImageCount = basePage?.imageLayers?.length ?? 0;
		const targetImageCount = targetPage?.imageLayers?.length ?? 0;
		const baseEditCount = basePage?.imageEditLayers?.length ?? 0;
		const targetEditCount = targetPage?.imageEditLayers?.length ?? 0;
		const label = pageLabel(targetPage ?? basePage, pageIndex);
		const baseImageId = pageImageId(basePage);
		const targetImageId = pageImageId(targetPage);

		let status: PageDiffEntry["status"];
		if (basePage && !targetPage) {
			status = "removed";
			removedPageCount++;
		} else if (!basePage && targetPage) {
			status = "added";
			addedPageCount++;
		} else {
			const layers = [
				...diffTextLayers(basePage?.textLayers, targetPage?.textLayers),
				...diffImageLayers(basePage?.imageLayers, targetPage?.imageLayers),
			];
			const imageChanged = baseImageId !== targetImageId;
			// Phase C / P1-3 — a non-destructive edit change (bubble-clean / brush / heal /
			// clone) is a visual page change even when the base image id is the same (the
			// edits composite ON TOP of the original). Compare edit-layer IDENTITY, not just
			// COUNT: a toggled visibility, swapped mask/patch asset, moved bbox, or changed
			// payload at the SAME count would otherwise be mis-reported "unchanged".
			const editLayersChanged = editLayersDiffer(basePage?.imageEditLayers, targetPage?.imageEditLayers);
			status = layers.length || imageChanged || editLayersChanged ? "changed" : "unchanged";
			if (status === "changed") {
				changedPageCount++;
				pages.push({
					pageIndex,
					label,
					status,
					baseImageId,
					targetImageId,
					imageChanged,
					baseTextLayerCount: baseTextCount,
					targetTextLayerCount: targetTextCount,
					baseImageLayerCount: baseImageCount,
					targetImageLayerCount: targetImageCount,
					baseEditLayerCount: baseEditCount,
					targetEditLayerCount: targetEditCount,
					layers: layers.slice(0, MAX_DIFF_LAYERS_PER_PAGE),
				});
			}
			continue;
		}

		pages.push({
			pageIndex,
			label,
			status,
			baseImageId,
			targetImageId,
			imageChanged: baseImageId !== targetImageId,
			baseTextLayerCount: baseTextCount,
			targetTextLayerCount: targetTextCount,
			baseImageLayerCount: baseImageCount,
			targetImageLayerCount: targetImageCount,
			baseEditLayerCount: baseEditCount,
			targetEditLayerCount: targetEditCount,
			layers: [],
		});
	}

	return {
		base,
		target,
		pageDelta: target.pageCount - base.pageCount,
		textLayerDelta: target.textLayerCount - base.textLayerCount,
		imageLayerDelta: countImageLayers(targetState) - countImageLayers(baseState),
		editLayerDelta: target.editLayerCount - base.editLayerCount,
		addedPageCount,
		removedPageCount,
		changedPageCount,
		pages: pages.slice(0, MAX_DIFF_PAGES),
	};
}

export interface RestoreScope {
	/** Restore only this page index. Required when `layerId` is given. */
	pageIndex?: number;
	/** Restore only this layer (text or image) on `pageIndex`. */
	layerId?: string;
}

export type SelectiveRestoreError =
	| { ok: false; code: "page_out_of_range"; message: string }
	| { ok: false; code: "layer_not_found"; message: string };

export interface SelectiveRestoreResult {
	ok: true;
	/** The merged state to persist. Distinct object; inputs are not mutated. */
	state: ProjectState;
	scope: "project" | "page" | "layer";
	restoredPageIndex?: number;
	restoredLayerId?: string;
	restoredLayerKind?: LayerKind;
}

function clonePage(page: PageState): PageState {
	return structuredClone(page);
}

/**
 * Build the state to persist for a (possibly scoped) restore. Returns a *new*
 * state object built from the live `currentState` so a partial restore never
 * touches pages/layers outside the requested scope — no full-revert side
 * effects, no data loss on the rest of the project.
 *
 * - No scope → caller should fall back to the existing full-restore path.
 * - `{ pageIndex }` → replace that single page wholesale with the snapshot page.
 * - `{ pageIndex, layerId }` → replace only that one text/image layer, keeping
 *   every other layer on the page (and the page image) as it is now.
 */
export function applySelectiveRestore(
	currentState: ProjectState,
	snapshotState: ProjectState,
	scope: RestoreScope,
): SelectiveRestoreResult | SelectiveRestoreError {
	const next = structuredClone(currentState);

	if (scope.pageIndex === undefined) {
		// Full restore is handled by the caller; signal "project" scope so the
		// route can branch. We still return the cloned current state untouched.
		return { ok: true, state: next, scope: "project" };
	}

	const pageIndex = scope.pageIndex;
	const snapshotPage = snapshotState.pages[pageIndex];
	if (!snapshotPage) {
		return { ok: false, code: "page_out_of_range", message: `Snapshot has no page at index ${pageIndex}` };
	}
	if (pageIndex < 0 || pageIndex >= next.pages.length) {
		return { ok: false, code: "page_out_of_range", message: `Current project has no page at index ${pageIndex}` };
	}

	if (scope.layerId === undefined) {
		// Page-scoped restore: swap the whole page, leave all other pages intact.
		next.pages[pageIndex] = clonePage(snapshotPage);
		return { ok: true, state: next, scope: "page", restoredPageIndex: pageIndex };
	}

	// Layer-scoped restore: bring exactly one layer to its snapshot state. The
	// target is "what this layer looked like in the snapshot", which has three
	// shapes:
	//   - in snapshot + present now  → overwrite the current layer with snapshot.
	//   - in snapshot + absent now   → re-add the snapshot layer.
	//   - absent in snapshot + present now → the layer was added after the
	//     snapshot; restoring the snapshot state means deleting it. Without this
	//     branch, reverting an accidentally-added layer wrongly failed with
	//     `layer_not_found`.
	// Only a layer id that exists in neither the snapshot nor the current page is
	// a genuine "not found".
	const layerId = scope.layerId;
	const snapshotText = (snapshotPage.textLayers ?? []).find((layer) => layer.id === layerId);
	const snapshotImage = (snapshotPage.imageLayers ?? []).find((layer) => layer.id === layerId);
	const currentPage = next.pages[pageIndex];
	if (!currentPage) {
		return { ok: false, code: "page_out_of_range", message: `Current project has no page at index ${pageIndex}` };
	}
	const currentTextIndex = (currentPage.textLayers ?? []).findIndex((layer) => layer.id === layerId);
	const currentImageIndex = (currentPage.imageLayers ?? []).findIndex((layer) => layer.id === layerId);

	if (!snapshotText && !snapshotImage) {
		// Absent in snapshot: if it exists now, deleting it restores the snapshot
		// state; if it exists nowhere, it is a genuinely invalid layer id.
		if (currentTextIndex >= 0) {
			const layers = [...(currentPage.textLayers ?? [])];
			layers.splice(currentTextIndex, 1);
			currentPage.textLayers = layers;
			return { ok: true, state: next, scope: "layer", restoredPageIndex: pageIndex, restoredLayerId: layerId, restoredLayerKind: "text" };
		}
		if (currentImageIndex >= 0) {
			const layers = [...(currentPage.imageLayers ?? [])];
			layers.splice(currentImageIndex, 1);
			currentPage.imageLayers = layers;
			return { ok: true, state: next, scope: "layer", restoredPageIndex: pageIndex, restoredLayerId: layerId, restoredLayerKind: "image" };
		}
		return { ok: false, code: "layer_not_found", message: `Page ${pageIndex} has no layer ${layerId} in the snapshot or current state` };
	}

	if (snapshotText) {
		const layers = Array.isArray(currentPage.textLayers) ? [...currentPage.textLayers] : [];
		const restored = structuredClone(snapshotText);
		if (currentTextIndex >= 0) layers[currentTextIndex] = restored;
		else layers.push(restored);
		currentPage.textLayers = layers;
		return { ok: true, state: next, scope: "layer", restoredPageIndex: pageIndex, restoredLayerId: layerId, restoredLayerKind: "text" };
	}

	const layers = Array.isArray(currentPage.imageLayers) ? [...currentPage.imageLayers] : [];
	const restored = structuredClone(snapshotImage as ImageLayerData);
	if (currentImageIndex >= 0) layers[currentImageIndex] = restored;
	else layers.push(restored);
	currentPage.imageLayers = layers;
	return { ok: true, state: next, scope: "layer", restoredPageIndex: pageIndex, restoredLayerId: layerId, restoredLayerKind: "image" };
}
