// Manga Editor Canvas — Fabric.js wrapper
// Handles: image display, text layers, selection rect, zoom/pan, AI cover

import { isAiResultImageLayer, type ImageEditLayer, type ImageEditLayerPatchCommitInput, type ImageLayer, type ImageLayerBlendMode, type TextLayer, type TextLayerEffects, type Tool } from "$lib/types.js";
import { config } from "$lib/config.js";
import { get as getStoreValue } from "svelte/store";
import { _ as translationStore } from "$lib/i18n";
import { loadAuthedFabricImage } from "$lib/api/client.js";
import {
	snapImageLayerToImageGuides,
	type ImageLayerSnapGuide,
} from "$lib/editor/image-layer-snapping.js";
import { resolveTextLayerEffectStyle, type ResolvedTextLayerEffectStyle, type ResolvedTextLayerPass, type ResolvedTextLayerShadow } from "$lib/project/text-effect-rendering.js";
import {
	computePageBoundaryLines,
	computeSegmentBounds,
	clampBrushPointerToSegment,
	normalizeBoundaryFractions,
	pageClipToastMessage,
	pageSegmentCount,
	segmentIndexForSceneY,
	type PageSegmentBounds,
} from "$lib/editor/long-page-guardrails.js";
import { canvasToBlobUrl, canvasToDataUrlAsync } from "$lib/editor/tools/raster.js";
import { clampSourceCrop, resolveImageLayerSourceCrop } from "$lib/project/image-layer-source-crop.js";
import { safeRandomId } from "$lib/utils/id.js";

export type BrushMode = "erase" | "restore";
type BrushCommitTarget = {
	kind: "background" | "image-layer";
	id: string;
};

export interface LayerSelectionChrome {
	borderColor: string;
	cornerColor: string;
	cornerStrokeColor: string;
	cornerSize: number;
	hoverCursor: string;
	moveCursor: string;
}

const DEFAULT_LAYER_SELECTION_CHROME: LayerSelectionChrome = {
	borderColor: "rgba(96, 165, 250, 0.9)",
	cornerColor: "rgba(96, 165, 250, 0.9)",
	cornerStrokeColor: "rgba(15, 23, 42, 0.95)",
	cornerSize: 10,
	hoverCursor: "move",
	moveCursor: "move",
};

const CREDIT_LAYER_SELECTION_CHROME: LayerSelectionChrome = {
	borderColor: "rgba(251, 191, 36, 0.96)",
	cornerColor: "rgba(251, 191, 36, 0.96)",
	cornerStrokeColor: "rgba(20, 14, 5, 0.96)",
	cornerSize: 12,
	hoverCursor: "grab",
	moveCursor: "grabbing",
};

const AI_RESULT_LAYER_SELECTION_CHROME: LayerSelectionChrome = {
	borderColor: "rgba(110, 231, 211, 0.26)",
	cornerColor: "rgba(110, 231, 211, 0.42)",
	cornerStrokeColor: "rgba(8, 15, 23, 0.95)",
	cornerSize: 6,
	hoverCursor: "move",
	moveCursor: "move",
};

export function getTextLayerSelectionChrome(layer: Pick<TextLayer, "sourceCategory"> | null | undefined): LayerSelectionChrome {
	return layer?.sourceCategory === "credit" ? CREDIT_LAYER_SELECTION_CHROME : DEFAULT_LAYER_SELECTION_CHROME;
}

export function getImageLayerSelectionChrome(layer: Pick<ImageLayer, "id" | "imageName" | "originalName" | "role"> | null | undefined): LayerSelectionChrome {
	if (layer?.role === "credit") return CREDIT_LAYER_SELECTION_CHROME;
	if (isAiResultImageLayer(layer)) return AI_RESULT_LAYER_SELECTION_CHROME;
	return DEFAULT_LAYER_SELECTION_CHROME;
}

function cloneTextLayerForHistory(layer: TextLayer): TextLayer {
	return {
		...layer,
		effects: layer.effects ? structuredClone(layer.effects) : undefined,
	};
}

let F: any;
async function loadFabric() {
	if (!F) {
		F = await import("fabric");
	}
	return F;
}

export const EDITOR_CANVAS_OPTIONS = {
	selection: true,
	preserveObjectStacking: true,
	// Tall webtoon pages can span far beyond the viewport at high zoom while still
	// crossing the visible workspace. Fabric's offscreen culling can drop them.
	skipOffscreen: false,
	width: 800,
	height: 600,
};

export const LOCKED_PAGE_IMAGE_OPTIONS = {
	selectable: false,
	evented: false,
	lockMovementX: true,
	lockMovementY: true,
	hasControls: false,
	hasBorders: false,
	hoverCursor: "default",
	// Keep the page image rendered directly. Fabric object caches can become
	// oversized and disappear on deep zoom, especially on tall manga/webtoon pages.
	objectCaching: false,
	noScaleCache: false,
};

export const INITIAL_IMAGE_TOP_GUTTER = 48;

// --- iPad/tablet touch routing for the W3.13 image-edit suite ---
// On a finger/Apple-Pencil device a single-pointer drag must DRAW with the
// active image-edit tool (marquee / lasso / wand / heal / clone …) instead of
// panning the viewport — matching standard tablet editor UX. Two-finger
// gestures stay reserved for pan + pinch-zoom. We resolve the routing in one
// pure function so the runtime handler and unit tests agree on the decision.
export type TouchPointerAction = "image-tool" | "pan" | "pinch" | "none";

export interface TouchPointerRoutingInput {
	/** Pointer type of the gesture (`touch` finger, `pen` Apple Pencil, `mouse`). */
	pointerType: string;
	/** How many active touch/pen pointers are currently down (incl. this one). */
	touchPointerCount: number;
	/** Engine tool truth (`select`, `brush`, …). */
	tool: string;
	/** True while an image-edit suite tool owns the pointer. */
	imageToolActive: boolean;
	/** Space held = explicit pan override even with a tool active. */
	isSpacePressed: boolean;
	/** Whether the gesture currently overlaps a selectable canvas object. */
	hasTarget: boolean;
}

/**
 * Decide what a *pointer-down* touch/pen gesture should do.
 *
 * - Two+ pointers → always `pinch` (pan + pinch-zoom), regardless of tool.
 * - Single finger/pen + an image-edit tool active (and Space not held) →
 *   `image-tool`: forward to the suite pointer bridge so the drag draws a
 *   selection/stroke instead of panning.
 * - Single finger/pen + plain Select tool over empty space → `pan` (viewport
 *   nav), preserving the existing behaviour when no image tool is active.
 * - Otherwise → `none` (let Fabric / brush / object-drag handle it).
 *
 * Mouse pointers are routed by the Fabric `mouse:*` path, not here.
 */
export function resolveTouchPointerAction(input: TouchPointerRoutingInput): TouchPointerAction {
	const isTouchLike = input.pointerType === "touch" || input.pointerType === "pen";
	if (!isTouchLike) return "none";
	if (input.touchPointerCount >= 2) return "pinch";
	// Single-pointer drag: image tool wins (unless the user is explicitly panning
	// with Space) so finger/pencil draws the selection/stroke.
	if (input.imageToolActive && !input.isSpacePressed) return "image-tool";
	// Plain select tool over empty canvas → pan the viewport.
	if (input.tool === "select" && !input.hasTarget) return "pan";
	return "none";
}

/**
 * True when a keyboard event originates from a text-entry surface where the
 * spacebar must type a space rather than engage canvas pan. Unlike the store's
 * `isEditorTextEntryTarget` (which excludes the canvas wrapper so layer
 * clipboard shortcuts keep working), this guard INCLUDES Fabric's hidden
 * in-canvas `<textarea>` so typing a space while editing a text object does not
 * flip the canvas into Grab/Pan mode.
 */
function isKeyboardTextEntryTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export interface InitialImagePlacementInput {
	canvasWidth: number;
	canvasHeight: number;
	imageWidth: number;
	imageHeight: number;
	fitTallImageByWidth?: boolean;
	topGutter?: number;
}

export interface InitialImagePlacement {
	left: number;
	top: number;
	width: number;
	height: number;
	scale: number;
}

export function buildInitialImagePlacement(input: InitialImagePlacementInput): InitialImagePlacement {
	const canvasWidth = Math.max(1, input.canvasWidth);
	const canvasHeight = Math.max(1, input.canvasHeight);
	const imageWidth = Math.max(1, input.imageWidth);
	const imageHeight = Math.max(1, input.imageHeight);
	const scaleX = canvasWidth / imageWidth;
	const scaleY = canvasHeight / imageHeight;
	const scale = input.fitTallImageByWidth ? scaleX : Math.min(scaleX, scaleY);
	const width = imageWidth * scale;
	const height = imageHeight * scale;
	const left = (canvasWidth - width) / 2;
	const centeredTop = height > canvasHeight ? 0 : (canvasHeight - height) / 2;
	const topGutter = Math.max(0, input.topGutter ?? INITIAL_IMAGE_TOP_GUTTER);
	const top = height > canvasHeight ? 0 : Math.min(centeredTop, topGutter);

	return { left, top, width, height, scale };
}

const IMAGE_LAYER_BLEND_MODES: readonly ImageLayerBlendMode[] = [
	"normal",
	"multiply",
	"screen",
	"overlay",
	"soft-light",
];

function normalizeImageLayerBlendMode(value: ImageLayer["blendMode"]): ImageLayerBlendMode {
	return IMAGE_LAYER_BLEND_MODES.includes(value as ImageLayerBlendMode)
		? (value as ImageLayerBlendMode)
		: "normal";
}

function imageLayerBlendModeToCompositeOperation(value: ImageLayer["blendMode"]): string {
	const blendMode = normalizeImageLayerBlendMode(value);
	return blendMode === "normal" ? "source-over" : blendMode;
}

function colorToBrushPreviewRgba(color: string, alpha: number): string {
	const normalized = color.trim();
	const hex = normalized.startsWith("#") ? normalized.slice(1) : normalized;
	if (!/^[0-9a-f]{6}$/i.test(hex)) {
		return `rgba(255,255,255,${alpha})`;
	}
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	return `rgba(${r},${g},${b},${alpha})`;
}

// Command interface for undo/redo
interface Command {
	execute(): void | Promise<void>;
	undo(): void | Promise<void>;
	/** Optional human label used by the read-only undo/redo history panel. */
	historyLabel?: string;
	/**
	 * Optional cleanup, called by HistoryManager when the command is evicted from the
	 * undo stack (capacity overflow) or dropped from the redo stack (a new command
	 * supersedes it). P1 bounded-history fix: commands that pin large in-memory bitmaps
	 * (full-resolution data:/blob: URLs per brush/clone/heal stroke) release them here
	 * so a 20-deep history can't grow memory without bound. Must be idempotent.
	 */
	dispose?(): void;
	/**
	 * Optional: the durable image URLs this LIVE command can still restore (undo/redo).
	 * Used by the storage GC (project.svelte.ts `reconcileSupersededEditImages`) to NEVER
	 * delete a backend edit-blob that a live undo/redo command would reload — that delete
	 * would 404 the undo (P1 data-loss). Saved project state does not include live
	 * undo/redo history, so the backend's reference-check can't see these; the editor must
	 * surface them. Returns the before/after URLs the command holds.
	 */
	imageRefs?(): string[];
	/**
	 * Best-effort memory pressure estimate for payloads retained only by live history.
	 * This lets the history stack evict old full-source data/blob URL commands before a
	 * count-only cap keeps hundreds of MB reachable during long cleanup sessions.
	 */
	estimatedBytes?(): number;
}

export interface EditorHistoryEntry {
	id: string;
	label: string;
	at: number;
}

export interface EditorHistorySnapshot {
	entries: EditorHistoryEntry[];
	currentIndex: number;
}

type MixedLayerStackEntry = {
	kind: "text" | "image";
	id: string;
};

// Add text layer command
class AddTextLayerCommand implements Command {
	private editor: MangaEditor;
	private layer: TextLayer;

	constructor(editor: MangaEditor, layer: TextLayer) {
		this.editor = editor;
		this.layer = layer;
	}

	execute(): void {
		this.editor.addTextLayerInternal(this.layer);
	}

	undo(): void {
		this.editor.removeTextLayerInternal(this.layer.id);
	}
}

// Remove text layer command
class RemoveTextLayerCommand implements Command {
	private editor: MangaEditor;
	private layer: TextLayer;

	constructor(editor: MangaEditor, layer: TextLayer) {
		this.editor = editor;
		this.layer = layer;
	}

	execute(): void {
		this.editor.removeTextLayerInternal(this.layer.id);
	}

	undo(): void {
		this.editor.addTextLayerInternal(this.layer);
	}
}

// Add image layer command
class AddImageLayerCommand implements Command {
	private editor: MangaEditor;
	private layer: ImageLayer;
	private imageUrl?: string;

	constructor(editor: MangaEditor, layer: ImageLayer, imageUrl?: string) {
		this.editor = editor;
		this.layer = layer;
		this.imageUrl = imageUrl;
	}

	async execute(): Promise<void> {
		this.layer = await this.editor.addImageLayerInternal(this.layer, this.imageUrl);
		this.editor.selectImageLayer(this.layer.id);
	}

	undo(): void {
		this.editor.removeImageLayerInternal(this.layer.id);
	}

	getLayer(): ImageLayer {
		return this.layer;
	}

	estimatedBytes(): number {
		return estimateHistoryUrlBytes(this.imageUrl);
	}
}

// Remove image layer command
class RemoveImageLayerCommand implements Command {
	private editor: MangaEditor;
	private layer: ImageLayer;
	private imageUrl?: string;

	constructor(editor: MangaEditor, layer: ImageLayer, imageUrl?: string) {
		this.editor = editor;
		this.layer = layer;
		this.imageUrl = imageUrl;
	}

	execute(): void {
		this.editor.removeImageLayerInternal(this.layer.id);
	}

	async undo(): Promise<void> {
		this.layer = await this.editor.addImageLayerInternal(this.layer, this.imageUrl);
		this.editor.selectImageLayer(this.layer.id);
	}

	estimatedBytes(): number {
		return estimateHistoryUrlBytes(this.imageUrl);
	}
}

// Update image layer command
class UpdateImageLayerCommand implements Command {
	private editor: MangaEditor;
	private beforeLayer: ImageLayer;
	private afterLayer: ImageLayer;

	constructor(editor: MangaEditor, beforeLayer: ImageLayer, afterLayer: ImageLayer) {
		this.editor = editor;
		this.beforeLayer = beforeLayer;
		this.afterLayer = afterLayer;
	}

	execute(): void {
		this.editor.updateImageLayerInternal(this.afterLayer.id, this.afterLayer);
		this.editor.selectImageLayer(this.afterLayer.id);
	}

	undo(): void {
		this.editor.updateImageLayerInternal(this.beforeLayer.id, this.beforeLayer);
		this.editor.selectImageLayer(this.beforeLayer.id);
	}
}

class ReplaceImageLayerSourceCommand implements Command {
	private editor: MangaEditor;
	private layerId: string;
	private beforeLayer: ImageLayer;
	private beforeImageUrl?: string;
	private afterLayer: ImageLayer;
	private afterImageUrl?: string;
	private beforeRestoreImageUrl?: string;
	private afterRestoreImageUrl?: string;

	constructor(
		editor: MangaEditor,
		layerId: string,
		beforeLayer: ImageLayer,
		beforeImageUrl: string | undefined,
		afterLayer: ImageLayer,
		afterImageUrl: string | undefined,
		beforeRestoreImageUrl?: string,
		afterRestoreImageUrl?: string,
	) {
		this.editor = editor;
		this.layerId = layerId;
		this.beforeLayer = beforeLayer;
		this.beforeImageUrl = beforeImageUrl;
		this.afterLayer = afterLayer;
		this.afterImageUrl = afterImageUrl;
		this.beforeRestoreImageUrl = beforeRestoreImageUrl;
		this.afterRestoreImageUrl = afterRestoreImageUrl;
	}

	async execute(): Promise<void> {
		await this.editor.replaceImageLayerSourceInternal(this.layerId, this.afterLayer, this.afterImageUrl, this.afterRestoreImageUrl);
	}

	async undo(): Promise<void> {
		await this.editor.replaceImageLayerSourceInternal(this.layerId, this.beforeLayer, this.beforeImageUrl, this.beforeRestoreImageUrl);
	}

	estimatedBytes(): number {
		return estimateHistoryUrlBytes(this.beforeImageUrl)
			+ estimateHistoryUrlBytes(this.afterImageUrl)
			+ estimateHistoryUrlBytes(this.beforeRestoreImageUrl)
			+ estimateHistoryUrlBytes(this.afterRestoreImageUrl);
	}

	/**
	 * P1 bounded-history fix. Each image-layer brush/clone commit pins a FULL-source
	 * `data:`/`blob:` URL (the erased layer bitmap) on BOTH the before and after sides.
	 * With a 20-deep history that is up to ~40 full-resolution PNGs held in memory.
	 * Once this command is evicted from the undo stack (or dropped from redo) it can
	 * never be replayed, so release those URLs: revoke any `blob:` (frees the backing
	 * buffer immediately) and drop the string references so the multi-MB `data:` URLs
	 * become GC-eligible. Idempotent.
	 */
	dispose(): void {
		for (const url of [this.afterImageUrl, this.beforeImageUrl, this.afterRestoreImageUrl, this.beforeRestoreImageUrl]) {
			if (url && url.startsWith("blob:")) {
				try {
					URL.revokeObjectURL(url);
				} catch {
					/* best effort */
				}
			}
		}
		this.afterImageUrl = undefined;
		this.beforeImageUrl = undefined;
		this.afterRestoreImageUrl = undefined;
		this.beforeRestoreImageUrl = undefined;
	}
}

class BulkUpdateImageLayersCommand implements Command {
	private editor: MangaEditor;
	private beforeLayers: ImageLayer[];
	private afterLayers: ImageLayer[];
	private activeLayerId: string | null;

	constructor(editor: MangaEditor, beforeLayers: ImageLayer[], afterLayers: ImageLayer[], activeLayerId: string | null) {
		this.editor = editor;
		this.beforeLayers = beforeLayers;
		this.afterLayers = afterLayers;
		this.activeLayerId = activeLayerId;
	}

	execute(): void {
		this.applyLayers(this.afterLayers);
	}

	undo(): void {
		this.applyLayers(this.beforeLayers);
	}

	private applyLayers(layers: ImageLayer[]): void {
		for (const layer of layers) {
			this.editor.updateImageLayerInternal(layer.id, layer);
		}
		if (this.activeLayerId) {
			this.editor.selectImageLayer(this.activeLayerId);
		}
	}
}

// Reorder image layers command
class ReorderImageLayersCommand implements Command {
	private editor: MangaEditor;
	private beforeOrder: string[];
	private afterOrder: string[];
	private activeLayerId: string;

	constructor(editor: MangaEditor, beforeOrder: string[], afterOrder: string[], activeLayerId: string) {
		this.editor = editor;
		this.beforeOrder = beforeOrder;
		this.afterOrder = afterOrder;
		this.activeLayerId = activeLayerId;
	}

	execute(): void {
		this.editor.setImageLayerOrderInternal(this.afterOrder, this.activeLayerId);
	}

	undo(): void {
		this.editor.setImageLayerOrderInternal(this.beforeOrder, this.activeLayerId);
	}
}

class ReorderMixedLayersCommand implements Command {
	private editor: MangaEditor;
	private beforeOrder: MixedLayerStackEntry[];
	private afterOrder: MixedLayerStackEntry[];
	private activeKind: "text" | "image";
	private activeLayerId: string;

	constructor(
		editor: MangaEditor,
		beforeOrder: MixedLayerStackEntry[],
		afterOrder: MixedLayerStackEntry[],
		activeKind: "text" | "image",
		activeLayerId: string,
	) {
		this.editor = editor;
		this.beforeOrder = beforeOrder;
		this.afterOrder = afterOrder;
		this.activeKind = activeKind;
		this.activeLayerId = activeLayerId;
	}

	execute(): void {
		this.editor.setLayerStackOrderInternal(this.afterOrder, this.activeKind, this.activeLayerId);
	}

	undo(): void {
		this.editor.setLayerStackOrderInternal(this.beforeOrder, this.activeKind, this.activeLayerId);
	}
}

class ModifyTextLayerCommand implements Command {
	private editor: MangaEditor;
	private layerId: string;
	private oldState: TextLayer;
	private newState: TextLayer;

	constructor(editor: MangaEditor, layerId: string, oldState: TextLayer, newState: TextLayer) {
		this.editor = editor;
		this.layerId = layerId;
		this.oldState = cloneTextLayerForHistory(oldState);
		this.newState = cloneTextLayerForHistory(newState);
	}

	execute(): void {
		this.editor.replaceTextLayerInternal(this.layerId, this.newState);
		this.editor.selectTextLayer(this.layerId);
	}

	undo(): void {
		this.editor.replaceTextLayerInternal(this.layerId, this.oldState);
		this.editor.selectTextLayer(this.layerId);
	}
}

// Background image change command
class BackgroundImageCommand implements Command {
	private editor: MangaEditor;
	private oldImageUrl: string | null;
	private newImageUrl: string;
	private isAiResult: boolean;

	constructor(editor: MangaEditor, newImageUrl: string, oldImageUrl: string | null, isAiResult = false) {
		this.editor = editor;
		this.newImageUrl = newImageUrl;
		this.oldImageUrl = oldImageUrl;
		this.isAiResult = isAiResult;
	}

	async execute(): Promise<void> {
		await this.editor.updateBackgroundImage(this.newImageUrl, this.isAiResult);
	}

	async undo(): Promise<void> {
		if (this.oldImageUrl) {
			await this.editor.updateBackgroundImage(this.oldImageUrl, false);
		}
	}

	estimatedBytes(): number {
		return estimateHistoryUrlBytes(this.oldImageUrl) + estimateHistoryUrlBytes(this.newImageUrl);
	}
}

// P1 fix — make a destructive background heal/clone/brush stroke UNDOABLE.
//
// Instant-apply tools (healing brush, clone stamp) mutate the live backing canvas
// in place and schedule a debounced persist, but pushed NO history command — so the
// destructive edit was silently lost from undo/redo. This command captures the
// background URL BEFORE the first coalesced patch of a stroke (`beforeUrl`) and the
// durable persisted URL AFTER the stroke settles (`afterUrl`). The pixels are
// ALREADY on the canvas when the command is pushed, so it is registered WITHOUT
// re-executing; undo() swaps back to `beforeUrl`, redo() (execute) re-applies
// `afterUrl`. Because the persist is debounced, one continuous stroke coalesces into
// exactly ONE command = one undo step (the invariant: one gesture = one undo step,
// and undo fully restores the prior bitmap).
class BrushBackgroundCommand implements Command {
	private editor: MangaEditor;
	private beforeUrl: string | null;
	private afterUrl: string | null;

	constructor(editor: MangaEditor, beforeUrl: string | null, afterUrl: string | null) {
		this.editor = editor;
		this.beforeUrl = beforeUrl;
		this.afterUrl = afterUrl;
	}

	/** Redo — re-apply the post-stroke bitmap. */
	async execute(): Promise<void> {
		if (this.afterUrl) {
			await this.editor.updateBackgroundImage(this.afterUrl, false);
		}
	}

	/** Undo — restore the pre-stroke bitmap (fully reverts the destructive edit). */
	async undo(): Promise<void> {
		if (this.beforeUrl) {
			await this.editor.updateBackgroundImage(this.beforeUrl, false);
		}
	}

	/**
	 * The durable URLs this LIVE stroke can still restore. `beforeUrl` is the prior
	 * persisted background (the blob the storage GC would otherwise reclaim as
	 * "superseded"); `afterUrl` is this stroke's result. Both are needed: undo reloads
	 * `beforeUrl`, redo reloads `afterUrl`, so neither id may be GC'd while this command
	 * is on the live history stack (P1 undo-404 data-loss fix).
	 */
	imageRefs(): string[] {
		const refs: string[] = [];
		if (this.beforeUrl) refs.push(this.beforeUrl);
		if (this.afterUrl) refs.push(this.afterUrl);
		return refs;
	}

	estimatedBytes(): number {
		return estimateHistoryUrlBytes(this.beforeUrl) + estimateHistoryUrlBytes(this.afterUrl);
	}

	/**
	 * P1 bounded-history — release the pinned full-resolution bitmaps once this stroke
	 * is evicted from history (it can no longer be undone/redone). Revoke any blob URL
	 * and drop the string refs so large `data:` URLs become GC-eligible. Idempotent.
	 */
	dispose(): void {
		for (const url of [this.beforeUrl, this.afterUrl]) {
			if (url && url.startsWith("blob:")) {
				try {
					URL.revokeObjectURL(url);
				} catch {
					/* best effort */
				}
			}
		}
		this.beforeUrl = null;
		this.afterUrl = null;
	}
}

// Phase B — undoable NON-DESTRUCTIVE edit layer (patch / healing / clone). Instead of
// swapping a full background bitmap (BrushBackgroundCommand), a destructive stroke now
// appends ONE tiny `ImageEditLayer` to `page.imageEditLayers`. This command makes that
// append reversible: undo() REMOVES the layer (the composite repaints without it), redo
// re-adds it. The layer's small assets (realized patch + mask) are referenced for the
// life of the command so the storage GC never reclaims them while the stroke can still
// be undone/redone. One continuous stroke = ONE layer = ONE command (the coalescing
// invariant), because the tools commit exactly one layer per pointer-up gesture.
class ImageEditLayerCommand implements Command {
	private editor: MangaEditor;
	private layer: ImageEditLayer;

	constructor(editor: MangaEditor, layer: ImageEditLayer) {
		this.editor = editor;
		this.layer = layer;
	}

	/** Redo — re-append the edit layer and repaint the composite. */
	async execute(): Promise<void> {
		await this.editor.addImageEditLayerForHistory(this.layer);
	}

	/** Undo — remove the edit layer (its pixels disappear from the composite). */
	async undo(): Promise<void> {
		await this.editor.removeImageEditLayerForHistory(this.layer.id);
	}

	/**
	 * The small assets this edit layer composites (realized patch / mask). Both must be
	 * protected from GC while this command is on the live history stack so an undo→redo
	 * can re-composite them. Mirrors BrushBackgroundCommand.imageRefs().
	 */
	imageRefs(): string[] {
		const ids = imageEditLayerAssetIds(this.layer);
		const refs: string[] = [];
		for (const id of ids) {
			refs.push(id);
			const url = this.editor.resolveProjectImageUrl(id);
			if (url) refs.push(url);
		}
		return refs;
	}
}

// Phase C — undoable visibility toggle for ONE non-destructive edit layer. Flipping a
// layer's `visible` flag changes the live composite (the layer paints / stops painting)
// and is persisted, so the toggle is reversible in one history step. The layer remains
// in the stack either way (unlike delete/revert), so its assets stay pinned.
class ImageEditLayerVisibilityCommand implements Command {
	private editor: MangaEditor;
	private layerId: string;
	private nextVisible: boolean;
	private prevVisible: boolean;
	private assetIds: string[];

	constructor(editor: MangaEditor, layer: ImageEditLayer, nextVisible: boolean) {
		this.editor = editor;
		this.layerId = layer.id;
		this.nextVisible = nextVisible;
		this.prevVisible = layer.visible !== false;
		this.assetIds = imageEditLayerAssetIds(layer);
	}

	async execute(): Promise<void> {
		await this.editor.setImageEditLayerVisibilityForHistory(this.layerId, this.nextVisible);
	}

	async undo(): Promise<void> {
		await this.editor.setImageEditLayerVisibilityForHistory(this.layerId, this.prevVisible);
	}

	imageRefs(): string[] {
		const refs: string[] = [];
		for (const id of this.assetIds) {
			refs.push(id);
			const url = this.editor.resolveProjectImageUrl(id);
			if (url) refs.push(url);
		}
		return refs;
	}
}

// Phase C — undoable "revert to before this edit" (and single-edit delete, when the
// removed set is just one layer). Removing an edit and everything stacked after it drops
// those layers from the stack + composite; undo re-inserts them at their original
// positions. The removed layers (and their small assets) are held by the command for the
// life of the history entry so undo can re-composite + the GC never reclaims them.
class ImageEditLayerRevertCommand implements Command {
	private editor: MangaEditor;
	// Removed layers, captured in stack order (used for asset pinning via imageRefs()).
	private removed: ImageEditLayer[];
	// P1-1 — the EXACT stack (ids, indices AND array order) as it was BEFORE the delete /
	// revert. Undo restores this verbatim so the post-undo stack equals the pre-delete
	// stack byte-for-byte. Capturing the full before-snapshot (rather than re-inserting the
	// removed layers into the already-normalized survivors and re-sorting) is the only way
	// to faithfully reverse a delete that renormalized the survivors' indices, because the
	// removed layer's original index can tie with a survivor's renormalized index.
	private beforeStack: ImageEditLayer[];

	constructor(editor: MangaEditor, removed: ImageEditLayer[], beforeStack: ImageEditLayer[]) {
		this.editor = editor;
		this.removed = removed.map((layer) => ({ ...layer }));
		this.beforeStack = beforeStack.map((layer) => ({ ...layer }));
	}

	async execute(): Promise<void> {
		await this.editor.removeImageEditLayersForHistory(this.removed.map((l) => l.id));
	}

	async undo(): Promise<void> {
		await this.editor.restoreImageEditStackForHistory(this.beforeStack);
	}

	imageRefs(): string[] {
		const refs: string[] = [];
		for (const layer of this.removed) {
			for (const id of imageEditLayerAssetIds(layer)) {
				refs.push(id);
				const url = this.editor.resolveProjectImageUrl(id);
				if (url) refs.push(url);
			}
		}
		return refs;
	}
}

/** Collect every storage asset id an edit-layer payload references (for GC pinning). */
function imageEditLayerAssetIds(layer: ImageEditLayer): string[] {
	const ids: string[] = [];
	const payload = layer.payload as unknown as Record<string, unknown> | undefined;
	if (payload) {
		for (const key of ["maskAssetId", "patchAssetId", "realizedPatchAssetId"]) {
			const value = payload[key];
			if (typeof value === "string" && value) ids.push(value);
		}
	}
	return ids;
}

// Combine several commands into ONE undo step. Used for a multi-selection
// move/scale/rotate gesture that touches multiple layers (text and/or image)
// at once: undo reverts the WHOLE gesture, redo reapplies it, in a single step.
// execute() runs sub-commands in order; undo() runs them in reverse so the
// layer-state replays are symmetric. Sub-commands may be async (image layers),
// so both directions await each step.
class CompositeCommand implements Command {
	private commands: Command[];

	constructor(commands: Command[]) {
		this.commands = commands;
	}

	get length(): number {
		return this.commands.length;
	}

	get historyLabel(): string {
		if (this.commands.length === 1) return commandHistoryLabel(this.commands[0]);
		return "แก้หลายรายการ";
	}

	async execute(): Promise<void> {
		for (const command of this.commands) {
			await command.execute();
		}
	}

	async undo(): Promise<void> {
		for (let i = this.commands.length - 1; i >= 0; i--) {
			await this.commands[i].undo();
		}
	}

	dispose(): void {
		for (const c of this.commands) {
			try {
				c.dispose?.();
			} catch {
				/* best effort */
			}
		}
	}

	/** Aggregate the live image refs of every sub-command (P1 undo-404 GC safety). */
	imageRefs(): string[] {
		const refs: string[] = [];
		for (const c of this.commands) {
			const sub = c.imageRefs?.();
			if (sub) refs.push(...sub);
		}
		return refs;
	}

	estimatedBytes(): number {
		return this.commands.reduce((sum, c) => sum + estimateCommandBytes(c), 0);
	}
}

// key into historyLabels.* (localized ×4); Thai fallback keeps headless/test
// paths working when the i18n store has no locale loaded yet.
const COMMAND_HISTORY_LABELS: Record<string, [string, string]> = {
	AddTextLayerCommand: ["historyLabels.addText", "เพิ่มข้อความ"],
	RemoveTextLayerCommand: ["historyLabels.removeText", "ลบข้อความ"],
	ModifyTextLayerCommand: ["historyLabels.modifyText", "แก้ข้อความ"],
	AddImageLayerCommand: ["historyLabels.addImage", "เพิ่มรูปเสริม"],
	RemoveImageLayerCommand: ["historyLabels.removeImage", "ลบรูปเสริม"],
	UpdateImageLayerCommand: ["historyLabels.updateImage", "แก้รูปเสริม"],
	ReplaceImageLayerSourceCommand: ["historyLabels.replaceImageSource", "แก้รูปด้วยแปรง"],
	BulkUpdateImageLayersCommand: ["historyLabels.bulkUpdateImages", "แก้รูปเสริมหลายเลเยอร์"],
	ReorderImageLayersCommand: ["historyLabels.reorderImages", "เรียงรูปเสริม"],
	ReorderMixedLayersCommand: ["historyLabels.reorderMixed", "เรียงเลเยอร์"],
	BackgroundImageCommand: ["historyLabels.background", "แก้ภาพพื้นหลัง"],
	BrushBackgroundCommand: ["historyLabels.brushBackground", "แก้ภาพด้วยแปรง"],
	ImageEditLayerCommand: ["historyLabels.imageEditLayer", "เพิ่มเลเยอร์แก้ภาพ"],
	ImageEditLayerVisibilityCommand: ["historyLabels.imageEditLayerVisibility", "เปิด/ปิดเลเยอร์แก้ภาพ"],
	ImageEditLayerRevertCommand: ["historyLabels.imageEditLayerRevert", "ย้อนเลเยอร์แก้ภาพ"],
	CompositeCommand: ["historyLabels.composite", "แก้หลายรายการ"],
};

function localizedHistoryLabel(key: string, fallback: string): string {
	try {
		const translate = getStoreValue(translationStore);
		const value = translate(key);
		return value && value !== key ? value : fallback;
	} catch {
		return fallback;
	}
}

function commandHistoryLabel(command: Command): string {
	const explicitLabel = typeof command.historyLabel === "string" ? command.historyLabel.trim() : "";
	if (explicitLabel) return explicitLabel;
	const entry = COMMAND_HISTORY_LABELS[command.constructor?.name ?? ""];
	if (entry) return localizedHistoryLabel(entry[0], entry[1]);
	return localizedHistoryLabel("historyLabels.fallback", "แก้ไขหน้า");
}

interface HistoryCommandMeta {
	id: string;
	label: string;
	at: number;
}

interface HistoryManagerOptions {
	maxEntries?: number;
	maxEstimatedBytes?: number;
}

const DEFAULT_HISTORY_MAX_ENTRIES = 20;
const DEFAULT_HISTORY_MAX_ESTIMATED_BYTES = 128 * 1024 * 1024;
const HISTORY_UNKNOWN_BLOB_URL_ESTIMATED_BYTES = 16 * 1024 * 1024;

function estimateHistoryUrlBytes(url?: string | null): number {
	if (!url) return 0;
	// `data:` URLs hold base64 text in JS; use UTF-16 size as a conservative budget.
	if (url.startsWith("data:")) return url.length * 2;
	// A `blob:` URL is short, but it can pin a large backing Blob until revoked.
	if (url.startsWith("blob:")) return HISTORY_UNKNOWN_BLOB_URL_ESTIMATED_BYTES + url.length * 2;
	return url.length * 2;
}

function estimateCommandBytes(command: Command): number {
	try {
		const bytes = command.estimatedBytes?.() ?? 0;
		return Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes) : 0;
	} catch {
		// Accounting must never break undo/redo; unknown commands just count as light.
		return 0;
	}
}

// History manager for undo/redo
class HistoryManager {
	private undoStack: Command[] = [];
	private redoStack: Command[] = [];
	private commandMeta = new WeakMap<Command, HistoryCommandMeta>();
	private sequence = 0;
	private readonly maxEntries: number;
	private readonly maxEstimatedBytes: number;

	constructor(options: HistoryManagerOptions = {}) {
		this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_HISTORY_MAX_ENTRIES));
		this.maxEstimatedBytes = Math.max(1, Math.floor(options.maxEstimatedBytes ?? DEFAULT_HISTORY_MAX_ESTIMATED_BYTES));
	}

	executeCommand(command: Command): void {
		this.ensureMeta(command);
		// Add to undo stack (command already executed by caller)
		this.undoStack.push(command);
		// Clear redo stack — those commands are now unreachable; dispose their pinned
		// bitmaps (P1 bounded-history) before dropping them.
		this.disposeAll(this.redoStack);
		this.redoStack = [];
		this.enforceBudget();
	}

	private disposeAll(stack: Command[]): void {
		for (const c of stack) {
			try {
				c.dispose?.();
			} catch {
				/* best effort — disposal must never break history */
			}
		}
	}

	undo(): Command | null {
		const command = this.undoStack.pop();
		if (command) {
			this.redoStack.push(command);
			return command;
		}
		return null;
	}

	redo(): Command | null {
		const command = this.redoStack.pop();
		if (command) {
			this.undoStack.push(command);
			this.enforceBudget();
			return command;
		}
		return null;
	}

	estimatedBytes(): number {
		return this.estimateStackBytes(this.undoStack) + this.estimateStackBytes(this.redoStack);
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	snapshot(): EditorHistorySnapshot {
		const commandEntries = [
			...this.undoStack.map((command) => this.ensureMeta(command)),
			...[...this.redoStack].reverse().map((command) => this.ensureMeta(command)),
		];
		return {
			entries: commandEntries.map((entry) => ({ ...entry })),
			currentIndex: this.undoStack.length - 1,
		};
	}

	clear(): void {
		this.disposeAll(this.undoStack);
		this.disposeAll(this.redoStack);
		this.undoStack = [];
		this.redoStack = [];
	}

	private enforceBudget(): void {
		// The evicted (oldest) commands can never be undone/redone again, so release any
		// full-resolution bitmap/data URL references they pinned. Always keep the newest
		// command even if one huge stroke exceeds the byte budget by itself.
		while (this.undoStack.length > this.maxEntries) {
			const evicted = this.undoStack.shift();
			evicted?.dispose?.();
		}
		while (this.undoStack.length > 1 && this.estimatedBytes() > this.maxEstimatedBytes) {
			const evicted = this.undoStack.shift();
			evicted?.dispose?.();
		}
	}

	private estimateStackBytes(stack: Command[]): number {
		return stack.reduce((sum, command) => sum + estimateCommandBytes(command), 0);
	}

	private ensureMeta(command: Command): HistoryCommandMeta {
		const existing = this.commandMeta.get(command);
		if (existing) return existing;
		const meta = {
			id: `history-${++this.sequence}`,
			label: commandHistoryLabel(command),
			at: Date.now(),
		};
		this.commandMeta.set(command, meta);
		return meta;
	}

	/**
	 * Every durable image URL that a LIVE command (undo OR redo stack) can still
	 * restore. The storage GC must never reclaim a backend edit-blob still reachable
	 * via undo/redo — that would 404 the restore (P1 data-loss). Once a command is
	 * evicted (capacity overflow) or the history is cleared/disposed (page switch /
	 * project close), its URLs drop out of this set and become GC-eligible again.
	 */
	collectImageRefs(): string[] {
		const refs: string[] = [];
		for (const command of this.undoStack) {
			const sub = command.imageRefs?.();
			if (sub) refs.push(...sub);
		}
		for (const command of this.redoStack) {
			const sub = command.imageRefs?.();
			if (sub) refs.push(...sub);
		}
		return refs;
	}
}

// Visual constants for selection UI
const SELECTION_LABEL_FONT_SIZE = 11;
const SELECTION_LABEL_PADDING = 7;
const SELECTION_LABEL_MIN_WIDTH = 54;
const SELECTION_LABEL_MIN_HEIGHT = 30;
const SELECTION_STROKE_WIDTH = 1.5;
const ASPECT_RATIO_TOLERANCE = 0.001;
const DEFAULT_TEXT_FILL = "#111111";
const DEFAULT_TEXT_STROKE = "#ffffff";
const DEFAULT_TEXT_STROKE_RATIO = 0.08;
const DEFAULT_TEXT_STROKE_MIN = 1;
const DEFAULT_TEXT_STROKE_MAX = 4;

const IMAGE_LAYER_SNAP_SCREEN_THRESHOLD = 8;
const IMAGE_LAYER_SNAP_GUIDE_COLOR = "#38bdf8";

type ViewportTransform = [number, number, number, number, number, number];

export interface CanvasImageBounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface ViewportImageCenterRatio {
	xRatio: number;
	yRatio: number;
}

export interface ImageRegionFocusTarget {
	x: number;
	y: number;
	w: number;
	h: number;
}

function clampRatio(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

// Source-crop placement math lives in a dependency-clean shared module
// ($lib/project/image-layer-source-crop.ts) so the live render
// (createImageObject), the single-page export (createExportImageObject below)
// AND the batch/zip export (project/page-export.ts) all apply the SAME crop +
// crop-aware scale and stay pixel-identical. Re-exported here so existing
// importers (and tests) that pull these from canvas/editor.ts keep working.
export { clampSourceCrop, resolveImageLayerSourceCrop };

/**
 * Map an image-layer-local pointer (already inverse-transformed into the Fabric
 * object's centered local space) into FULL-SOURCE pixel coordinates for the
 * image-layer eraser/restore brush, accounting for a `sourceCrop`.
 *
 * DATA-LOSS FIX (agy04): a cropped layer's Fabric object carries `cropX/cropY`
 * and `width/height` equal to the CROP sub-rect, so its local space is centered
 * on the CROP — but the brush target canvas is the FULL source and is committed
 * back as the full image. Offsetting by the full image's half-extent (the old
 * code) lands the erase `(fullWidth/2 - cropX - cropW/2)` px off and corrupts the
 * wrong pixels. We must offset by `cropOrigin + cropSpan/2`. For an uncropped
 * layer `cropOrigin = 0` and `cropSpan = fullSize`, collapsing to the old math.
 *
 * Returns null when the pointer is outside the DISPLAYED crop region (the only
 * pixels the user can see / erase).
 */
export function imageLayerBrushSourcePoint(input: {
	localX: number;
	localY: number;
	fullWidth: number;
	fullHeight: number;
	cropX?: number;
	cropY?: number;
	cropWidth?: number;
	cropHeight?: number;
}): { x: number; y: number } | null {
	const fullWidth = Math.max(1, input.fullWidth);
	const fullHeight = Math.max(1, input.fullHeight);
	const cropOriginX = Number.isFinite(Number(input.cropX)) ? Number(input.cropX) : 0;
	const cropOriginY = Number.isFinite(Number(input.cropY)) ? Number(input.cropY) : 0;
	const cropSpanX = Number.isFinite(Number(input.cropWidth)) && Number(input.cropWidth) > 0
		? Number(input.cropWidth)
		: fullWidth;
	const cropSpanY = Number.isFinite(Number(input.cropHeight)) && Number(input.cropHeight) > 0
		? Number(input.cropHeight)
		: fullHeight;
	const sourceX = input.localX + cropOriginX + cropSpanX / 2;
	const sourceY = input.localY + cropOriginY + cropSpanY / 2;
	if (
		sourceX < cropOriginX || sourceX > cropOriginX + cropSpanX
		|| sourceY < cropOriginY || sourceY > cropOriginY + cropSpanY
	) {
		return null;
	}
	return {
		x: Math.max(0, Math.min(sourceX, fullWidth)),
		y: Math.max(0, Math.min(sourceY, fullHeight)),
	};
}

/**
 * P1 non-uniform-scale brush footprint. The on-screen brush PREVIEW is a scene-space
 * circle of `sceneRadius`. An image layer maps scene→source pixels by `scaleX` on X
 * and `scaleY` on Y, so the SOURCE-space preimage of that round preview is an ELLIPSE
 * with per-axis radii `sceneRadius/scaleX` and `sceneRadius/scaleY`. Returning a
 * single scalar `sceneRadius / min(scaleX, scaleY)` (the old behaviour) made the
 * stroke an isotropic source-space circle that over-erased the axis with the larger
 * scale — the erased pixels did not match the preview. This returns BOTH per-axis
 * radii (and the smaller one as `radius`, used as the segment-interpolation distance
 * base) so the painter can draw the matching ellipse. Pure + exported for tests.
 */
export function imageLayerBrushSourceRadii(input: {
	sceneRadius: number;
	scaleX: number;
	scaleY: number;
}): { radius: number; radiusX: number; radiusY: number } {
	const sceneRadius = Math.max(0, input.sceneRadius);
	const scaleX = Math.max(0.0001, Math.abs(input.scaleX));
	const scaleY = Math.max(0.0001, Math.abs(input.scaleY));
	const radiusX = Math.max(1, sceneRadius / scaleX);
	const radiusY = Math.max(1, sceneRadius / scaleY);
	return { radius: Math.min(radiusX, radiusY), radiusX, radiusY };
}

/**
 * Classify a Fabric `object:modified` target. A single layer object carries
 * `_textLayerData` or `_imageLayerData`; a MULTI-SELECTION is the ActiveSelection
 * group box, which carries neither but wraps >0 child layer objects. The
 * `object:modified` handler must route a multi-selection through the per-child
 * absolute-transform sync (agy03) instead of dropping the edit on the floor.
 */
export function classifySelectionTarget(input: {
	hasTextLayerData: boolean;
	hasImageLayerData: boolean;
	childCount: number;
}): "text-layer" | "image-layer" | "multi-selection" | "none" {
	if (input.hasTextLayerData) return "text-layer";
	if (input.hasImageLayerData) return "image-layer";
	if (input.childCount > 0) return "multi-selection";
	return "none";
}

function hasUsableViewport(
	viewportWidth: number,
	viewportHeight: number,
	zoom: number,
	imageBounds: CanvasImageBounds,
): boolean {
	return viewportWidth > 0
		&& viewportHeight > 0
		&& zoom > 0
		&& Number.isFinite(zoom)
		&& imageBounds.width > 0
		&& imageBounds.height > 0;
}

export function getViewportImageCenterRatio(input: {
	viewportTransform?: number[] | null;
	viewportWidth: number;
	viewportHeight: number;
	zoom: number;
	imageBounds: CanvasImageBounds;
}): ViewportImageCenterRatio | null {
	const { viewportTransform, viewportWidth, viewportHeight, zoom, imageBounds } = input;
	if (!viewportTransform || viewportTransform.length < 6) return null;
	if (!hasUsableViewport(viewportWidth, viewportHeight, zoom, imageBounds)) return null;

	const sceneCenterX = (viewportWidth / 2 - viewportTransform[4]) / zoom;
	const sceneCenterY = (viewportHeight / 2 - viewportTransform[5]) / zoom;

	return {
		xRatio: clampRatio((sceneCenterX - imageBounds.left) / imageBounds.width),
		yRatio: clampRatio((sceneCenterY - imageBounds.top) / imageBounds.height),
	};
}

export function buildViewportTransformForImageCenter(input: {
	viewportTransform?: number[] | null;
	viewportWidth: number;
	viewportHeight: number;
	zoom: number;
	imageBounds: CanvasImageBounds;
	centerRatio: ViewportImageCenterRatio;
}): ViewportTransform | null {
	const { viewportTransform, viewportWidth, viewportHeight, zoom, imageBounds, centerRatio } = input;
	if (!hasUsableViewport(viewportWidth, viewportHeight, zoom, imageBounds)) return null;

	const next = viewportTransform && viewportTransform.length >= 6
		? [...viewportTransform] as ViewportTransform
		: [zoom, 0, 0, zoom, 0, 0];
	const sceneCenterX = imageBounds.left + imageBounds.width * clampRatio(centerRatio.xRatio);
	const sceneCenterY = imageBounds.top + imageBounds.height * clampRatio(centerRatio.yRatio);

	next[0] = zoom;
	next[3] = zoom;
	next[4] = viewportWidth / 2 - sceneCenterX * zoom;
	next[5] = viewportHeight / 2 - sceneCenterY * zoom;

	return next;
}

export function buildViewportTransformForImageRegion(input: {
	viewportTransform?: number[] | null;
	viewportWidth: number;
	viewportHeight: number;
	zoom: number;
	imageBounds: CanvasImageBounds;
	imageWidth: number;
	imageHeight: number;
	region: ImageRegionFocusTarget;
}): ViewportTransform | null {
	const { imageWidth, imageHeight, region } = input;
	if (imageWidth <= 0 || imageHeight <= 0) return null;
	const centerRatio = {
		xRatio: clampRatio((region.x + region.w / 2) / imageWidth),
		yRatio: clampRatio((region.y + region.h / 2) / imageHeight),
	};
	return buildViewportTransformForImageCenter({
		viewportTransform: input.viewportTransform,
		viewportWidth: input.viewportWidth,
		viewportHeight: input.viewportHeight,
		zoom: input.zoom,
		imageBounds: input.imageBounds,
		centerRatio,
	});
}

/**
 * Resolve the effective canvas-space box dimensions of a text layer object for
 * serialization.
 *
 * WIDTH is read from the LIVE Fabric textbox so an interactive resize is preserved:
 * a Fabric Textbox side-handle (ml/mr) resize writes the new extent into `width` and
 * resets `scaleX` to 1, so the previously-used cached `_textLayerBoxWidth` goes stale
 * and would silently revert the resize on reload (the P1 bug). The live `width * scaleX`
 * is the true box width for both side-handle and corner-handle (which scale) resizes.
 * The cached width (then the data-derived fallback) is used only when the live width is
 * non-finite or <= 0.
 *
 * HEIGHT keeps the cached-first convention. A Fabric Textbox has no free vertical
 * handle — its `height` is auto-measured from content and can drift from the saved box
 * height across a load/render, so trusting live `height` would regress the non-resized
 * case. Corner-handle vertical resizes are already captured via `scaleY`, which is
 * applied to the cached height here. The data-derived fallback is used only when the
 * cached height is non-finite or <= 0.
 */
export function resolveTextBoxCanvasDimensions(input: {
	liveWidth: unknown;
	scaleX: unknown;
	scaleY: unknown;
	cachedBoxWidth?: unknown;
	cachedBoxHeight?: unknown;
	fallbackBoxWidth: number;
	fallbackBoxHeight: number;
}): { width: number; height: number } {
	const liveWidth = Number(input.liveWidth);
	const cachedWidth = Number(input.cachedBoxWidth);
	const cachedHeight = Number(input.cachedBoxHeight);
	const scaleX = Number.isFinite(Number(input.scaleX)) && Number(input.scaleX) !== 0 ? Number(input.scaleX) : 1;
	const scaleY = Number.isFinite(Number(input.scaleY)) && Number(input.scaleY) !== 0 ? Number(input.scaleY) : 1;

	const baseWidth = Number.isFinite(liveWidth) && liveWidth > 0
		? liveWidth
		: (Number.isFinite(cachedWidth) && cachedWidth > 0 ? cachedWidth : input.fallbackBoxWidth);
	const baseHeight = Number.isFinite(cachedHeight) && cachedHeight > 0
		? cachedHeight
		: input.fallbackBoxHeight;

	return { width: baseWidth * scaleX, height: baseHeight * scaleY };
}

/**
 * Cap an AI crop region to a maximum width/height while PRESERVING aspect ratio.
 *
 * The previous implementation capped WIDTH only, so a region wider than the cap
 * had its width clamped to the cap but kept its full height — squashing the AI
 * crop horizontally. Here we compute the single limiting scale factor across both
 * axes and apply it uniformly, so the output is always within the cap on both
 * axes AND keeps the same width:height ratio (never stretched/squashed).
 *
 * Returns the (possibly) shrunk dimensions. A dimension at or below its cap is
 * left untouched when the other axis is also within range.
 */
export function capCropToMaxDimensions(
	width: number,
	height: number,
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	const w = Number.isFinite(width) ? Math.max(0, width) : 0;
	const h = Number.isFinite(height) ? Math.max(0, height) : 0;
	if (w <= 0 || h <= 0) return { width: w, height: h };

	const limitW = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Infinity;
	const limitH = Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : Infinity;

	const scale = Math.min(1, limitW / w, limitH / h);
	if (scale >= 1) return { width: w, height: h };

	return { width: w * scale, height: h * scale };
}

export type WheelGesture = "zoom" | "pan";

/**
 * Classify a wheel event as a ZOOM or a PAN gesture.
 *
 * On macOS/trackpads a two-finger PINCH is delivered as a `wheel` event with
 * `ctrlKey === true` (the browser synthesizes the modifier). Previously the
 * editor handled `ctrlKey` as a horizontal pan, so pinch-to-zoom panned sideways
 * instead of zooming. We now route `ctrlKey` (pinch) — and the explicit `altKey`
 * zoom modifier — to ZOOM-about-cursor, while a genuine scroll/swipe (no zoom
 * modifier) still PANS. Mouse-wheel zoom (alt) and normal scroll are preserved.
 */
export function classifyWheelGesture(event: {
	ctrlKey?: boolean;
	altKey?: boolean;
}): WheelGesture {
	return event.ctrlKey || event.altKey ? "zoom" : "pan";
}

export class MangaEditor {
	canvas: any;
	imageItem: any = null;
	textLayers: any[] = [];
	imageLayers: any[] = [];
	private textEffectShadowPasses = new Map<string, any[]>();
	selectionRect: any = null;
	selectionLabel: any = null;
	tool: Tool = "select";
	zoom = 1;
	private selectionChromeMuted = false;

	// Brush tool properties
	aiOverlayImage: any = null;
	originalImageUrl: string | null = null; // Store original image before AI overlay
	originalImageDataUrl: string | null = null; // Store original image as data URL to prevent stale references
		private originalImageCache: HTMLImageElement | null = null; // Cached image element for compositing
	brushSize = 30;
	brushHardness = 50;
	brushOpacity = 100;
	brushColor = "#FFFFFF";
	brushMode: BrushMode = "erase";
	private legacyAiMaskBrushEnabled = false;
	private brushEnabled = false;
	private isDrawing = false;
	private brushPath: any[] = [];
	private brushPreview: any = null;
	private eraserCanvas: HTMLCanvasElement | null = null;
	private eraserCtx: CanvasRenderingContext2D | null = null;
	private maskCanvas: HTMLCanvasElement | null = null;
	private maskCtx: CanvasRenderingContext2D | null = null;
	private imageLayerBrushTarget: {
		layerId: string;
		imageObject: any;
		canvas: HTMLCanvasElement;
		ctx: CanvasRenderingContext2D;
		mode: BrushMode;
		restoreCanvas?: HTMLCanvasElement;
		path: Array<{ x: number; y: number; radius: number; radiusX?: number; radiusY?: number }>;
		// P1 live-preview: the visible Fabric image object's element is swapped to
		// `canvas` (the stroke's working bitmap) during the drag so the erase/restore
		// shows in real time. `previousElement` is the original element, restored if
		// the stroke is CANCELLED (nav) before commit (commit reloads from the URL).
		previewActive: boolean;
		previousElement: CanvasImageSource | null;
	} | null = null;
	private pendingBrushCommits = new Set<Promise<void>>();
	// Latest in-flight image-tool commit (persistence + canvas reload). The tool
	// registry awaits this to serialize strokes so a slow commit can't land out of
	// order behind a later one (P1.3 data-loss). Cleared when its commit settles.
	private pendingToolCommit: Promise<void> | null = null;
	// --- Instant-apply image tools (Photopea-style) ---
	// The live, mutable backing <canvas> that IS the page background image's
	// element once an instant-apply tool has touched it. Drawing the healed/cloned
	// region straight onto this canvas + requestRenderAll() shows the edit with NO
	// reload and NO per-stroke server round-trip (the on-screen canvas becomes the
	// source of truth for the edit). A single debounced persist later snapshots it.
	private backgroundEditCanvas: HTMLCanvasElement | null = null;
	private backgroundEditCtx: CanvasRenderingContext2D | null = null;
	// Phase A/B desync guard (codex #392 P1-1). A non-destructive edit (bubble-clean /
	// brush / healing / clone) paints its result onto `backgroundEditCanvas` as a
	// TRANSIENT preview via applyToolPatchInstant({preview:true}), then records an
	// edit-LAYER (overlay) as the durable store. If the preview pixels stayed baked into
	// the mutable backing canvas the edit would render TWICE (backing + overlay) and undo
	// — which only removes the overlay — would leave the baked pixels behind (a phantom
	// that desyncs from project state until reload). To prevent this we snapshot the
	// backing-canvas ROI a preview is about to overwrite, and once the overlay is durably
	// committed we restore that ROI to its ORIGINAL pixels so ONLY the overlay renders the
	// edit. Then undo→remove-overlay→pristine; redo→re-add-overlay→edit visible.
	private previewRoiOriginal: { region: { x: number; y: number; width: number; height: number }; pixels: ImageData } | null = null;
	// --- Non-destructive image edit layers (Phase A — bubble-clean) ---
	// The native edit-stack composite cache: a transparent native-resolution canvas
	// onto which every `page.imageEditLayers[]` fill-mask is painted, displayed as a
	// Fabric overlay anchored to `imageBounds` ABOVE the page background but BELOW
	// image/text layers. Rebuilt from the page stack on load + after each commit, so a
	// clean survives reload WITHOUT baking a new page PNG (the original `page.imageId`
	// stays intact). `null` until the first edit layer exists on the page.
	private editCompositeCanvas: HTMLCanvasElement | null = null;
	private editCompositeCtx: CanvasRenderingContext2D | null = null;
	private editCompositeImage: any = null;
	// The current page's non-destructive edit stack + the ORIGINAL source image id the
	// edits composite over (kept intact for AI-marker anchoring). Fed by the store on
	// page load via setImageEditLayers(); appended to on each bubble-clean commit.
	private imageEditLayers: ImageEditLayer[] = [];
	private editLayersSourceImageId: string | null = null;
	// Debounced background persist: rapid strokes all apply instantly; we encode +
	// upload ONCE after the user goes idle (or on nav/tool-switch flush). The timer,
	// the page index it was scheduled for, and the in-flight persist are tracked so
	// navigation can flush the pending edit against the CORRECT page before
	// currentPage advances (the #248 nav-safety invariant).
	private backgroundPersistTimer: ReturnType<typeof setTimeout> | null = null;
	private backgroundPersistDirty = false;
	private backgroundPersistInFlight: Promise<void> | null = null;
	// P1 undoable-stroke fix — the durable background URL captured BEFORE the first
	// coalesced patch of the current instant-apply stroke. Set in
	// scheduleBackgroundPersist() on the first dirty-arming after idle; consumed +
	// cleared in runBackgroundPersist() once a durable post-stroke URL exists, where a
	// single BrushBackgroundCommand(before → after) is pushed so the whole stroke is
	// ONE undo step. `undefined` distinguishes "no stroke in flight" from a captured
	// null (page had no prior durable url).
	private backgroundStrokeBeforeUrl: string | null = null;
	private hasBackgroundStrokeBefore = false;
	private static readonly BACKGROUND_PERSIST_DEBOUNCE_MS = 800;
	private brushCommitErrors = new Map<string, unknown>();
	// Resolver for the synthetic "tool busy" pending promise (heal / heavy ops),
	// so `setToolBusy(false)` clears the working indicator + commit-pending gate.
	private toolBusyResolve: (() => void) | null = null;
	private selectedImageLayerIdForBrush: string | null = null;
	private lastBrushTargetKind: "image-layer" | "background" | null = null;
	private lastImageLayerBrushCommit: {
		layerId: string;
		title: string;
		mode: BrushMode;
		restoreImageId?: string;
	} | null = null;
	// Reusable canvases for compositing to avoid memory leaks
	private compositeCanvas: HTMLCanvasElement | null = null;
	private compositeCtx: CanvasRenderingContext2D | null = null;
	private aiCanvas: HTMLCanvasElement | null = null;
	private aiCtx: CanvasRenderingContext2D | null = null;
	// Flag to prevent ResizeObserver feedback loop when we update wrapper CSS
	private ignoreResizeObserver = false;

	imageWidth = 0;
	imageHeight = 0;
	canvasWidth = 0;
	canvasHeight = 0;
	containerWidth = 0;
	containerHeight = 0;
	private imageBounds = { left: 0, top: 0, width: 0, height: 0 };

	// --- Long-page (webtoon) guardrails (W3.15) ---
	// Internal cut fractions (0..1) splitting a stitched long page into pages.
	private pageBoundaryFractions: number[] = [];
	// 0-based active page segment the per-page clip is bound to.
	private activePageSegment = 0;
	// When true the per-page clip is removed so Cleaner/Typesetter can paint
	// across page boundaries (role-gated + lock-checked by the caller).
	private multiPageMode = false;
	// Fabric line objects for the red page-boundary overlay.
	private pageBoundaryLines: any[] = [];

	onTextLayerSelect?: (layer: TextLayer | null) => void;
	onImageLayerSelect?: (layer: ImageLayer | null) => void;
	onTextLayersChange?: (layers: TextLayer[]) => void;
	onImageLayersChange?: (layers: ImageLayer[]) => void;
	onImageLayerSourceChange?: (layer: ImageLayer, imageUrl: string) => void | Promise<void>;
	onBackgroundImageSourceChange?: (
		imageUrl: string,
		reason?: "brush-mask" | "restore-full-ai",
	) => string | void | Promise<string | void>;
	/**
	 * NON-DESTRUCTIVE edit (Phase A) — persist a tool's result as an `ImageEditLayer`.
	 * The store uploads the tiny alpha-mask ROI as an `image-edit-mask` asset and
	 * appends a fill-mask edit layer to `page.imageEditLayers` (saved via saveState),
	 * then returns the recorded layer so the editor can repaint its edit-composite
	 * cache. Returns null if the edit could not be recorded.
	 */
	onCommitImageEditLayer?: (input: {
		maskPng: Blob;
		region: { x: number; y: number; width: number; height: number };
		fill: { r: number; g: number; b: number; a: number };
		sourceImageId: string;
		tool: { id: "bubble-clean"; params?: Record<string, unknown> };
	}) => Promise<ImageEditLayer | null>;
	/**
	 * NON-DESTRUCTIVE edit (Phase B) — persist a brush/healing/clone tool's result as a
	 * realized-patch `ImageEditLayer` (patch / healing / clone). The store uploads the
	 * realized RGBA ROI PNG (and, for healing/clone, the stroke mask) as small assets,
	 * builds the typed payload, appends it to `page.imageEditLayers`, and returns the
	 * recorded layer. Returns null if the edit could not be recorded (upload/quota).
	 */
	onCommitImageEditLayerPatch?: (input: ImageEditLayerPatchCommitInput) => Promise<ImageEditLayer | null>;
	/**
	 * Phase B — undo/redo of an edit layer mutated `page.imageEditLayers`. The store
	 * persists the new stack (replacing the editor's append-on-commit + the legacy
	 * full-bitmap save). Called after addImageEditLayerForHistory / removeImageEditLayerForHistory.
	 */
	onImageEditLayersChange?: (layers: ImageEditLayer[]) => void;
	/**
	 * Phase C — fired by setImageEditLayers() on page load (NOT a user edit). The editor
	 * store mirrors the stack into reactive state for the Layers inspector WITHOUT marking
	 * the page unsaved (distinct from onImageEditLayersChange, which persists).
	 */
	onImageEditLayersLoad?: (layers: ImageEditLayer[]) => void;
	onCoverTrigger?: (crop: { x: number; y: number; w: number; h: number }) => void;
	onZoomChange?: (zoom: number) => void;
	onHistoryChange?: () => void;
	onToolChange?: (tool: Tool) => void;
	onTextLayerCreate?: (layer: TextLayer) => void;
	onImageLayerCreate?: (layer: ImageLayer) => void;
	onImageChange?: (hasImage: boolean) => void;
	onViewportChange?: () => void;
	onBrushTargetChange?: () => void;
	onBrushCommitErrorChange?: (message: string | null) => void;
	onBrushTargetMiss?: (message: string | null) => void;
	// Fired when a tool starts/ends a long-running (>150ms) operation so the UI
	// can show a working indicator (e.g. OpenCV heal, full-image PNG encode).
	onToolBusyChange?: (busy: boolean, label?: string) => void;
	// Fired for persistent non-busy tool state such as Clone Stamp source readiness.
	onToolStatusChange?: (message: string | null, tone?: "ready" | "blocked" | "info") => void;
	// Fired (debounced by the caller) when a tool stroke is clipped at a page
	// boundary so the workspace can raise the "tool clipped at page N" toast.
	onToolClipped?: (pageNumber: number, message: string) => void;
	// Fired after the long-page boundary cuts change (e.g. a different page is
	// loaded) so the store can re-validate role/lock-gated multi-page mode
	// against the freshly-loaded page instead of leaking the previous toggle.
	onPageBoundariesChanged?: (segmentCount: number) => void;
	onImageLayerBrushCommit?: (receipt: {
		layerId: string;
		title: string;
		mode: BrushMode;
		restoreImageId?: string;
	}) => void;
	projectImageUrlResolver?: (imageId: string) => string;

	// --- W3.13 image-edit suite pointer bridge ---
	// When an image-edit tool (marquee / lasso / magic wand / healing / clone /
	// ...) is active, the store sets `imageToolActive = true` and supplies
	// `onImageToolPointer`. The canvas then forwards raw scene-space pointer
	// gestures to the suite registry instead of running select/cover/brush/text
	// logic, preserving the canvas-as-viewport invariant (the suite converts
	// scene → image-space itself).
	imageToolActive = false;
	onImageToolPointer?: (
		phase: "down" | "move" | "up",
		scene: { x: number; y: number },
		mod: { pressed: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
	) => void;
	// P1 wrong-page-corruption fix. The image-edit suite registry buffers a stroke
	// that arrives while an async paint commit is settling and replays it once the
	// commit clears. Page navigation must (a) DRAIN that replay so it can't fire
	// onto the new page, and (b) CANCEL the buffer so a half-buffered stroke drawn
	// on the OLD page is discarded — both BEFORE `currentPage` advances. The store
	// wires these to the registry's drain/cancel methods when it builds the suite.
	onDrainImageToolReplay?: () => Promise<void>;
	onCancelImageToolReplay?: () => void;
	// P1 cancel-stroke-on-nav fix. A LIVE image-edit-suite stroke (pointerDown fired,
	// pointerUp not yet) survives a page load: the active ToolContext + the tool's
	// per-stroke accumulators would otherwise deliver the pending up/commit against
	// the NEW page. The store wires this to the registry's cancelActiveGesture() so
	// the half-painted suite stroke is discarded (against its ORIGINAL page) before
	// the image changes. Legacy (engine) brush state is cleared separately in
	// cancelActiveBrushGesture() below.
	onCancelImageToolActiveGesture?: () => void;
	// P1 selection-overlay drift fix. The image-edit suite's translucent selection
	// overlay is a Fabric image anchored to `imageBounds` (left/top + scale) at
	// render time. setContainerSize()/_centerImage()/fit remap imageBounds without
	// re-rendering it, so the visible selection drifts off the image-space mask.
	// The store wires this to the registry's refreshSelectionOverlay(); the editor
	// fires it after every recenter/fit/resize so the overlay tracks the image.
	onRefreshSelectionOverlay?: () => void;
	// PR #264 worker-race fix. A heal stroke now runs its Telea solve in a Web
	// Worker (`inpaintRegion`) and only calls `applyToolPatchInstant` AFTER the
	// worker returns. During that solve the stroke lives in the registry's
	// `commitInFlight` but has NOT yet armed the editor's `pendingBrushCommits`
	// persist gate, so `hasPendingBrushCommit()` alone would say "nothing pending"
	// and let navigation/teardown/export/save advance the page mid-solve — the
	// late ROI would then composite onto the wrong page (or be lost on teardown).
	// The store wires this to the registry's `isCommitInFlight` so the pending
	// check (and therefore every wait-before-nav/save/export path) ALSO blocks on
	// the in-flight worker op. The drain itself already covers it via
	// onDrainImageToolReplay → waitForReplayIdle → waitForCommit().
	onIsImageToolCommitInFlight?: () => boolean;

	private isPanning = false;
	private lastPanPoint = { x: 0, y: 0 };
	private touchPointers = new Map<number, { x: number; y: number }>();
	private isTouchPanning = false;
	private lastTouchPanPoint = { x: 0, y: 0 };
	// True while a single finger/Apple-Pencil drag is being forwarded to the
	// image-edit suite (so move/up route to onImageToolPointer instead of pan).
	private touchImageToolPointerId: number | null = null;
	// P1 brush/pinch pointer-OWNERSHIP. The legacy brush (AI-mask + image-layer) is
	// single-pointer: exactly ONE pointer owns an in-flight stroke. We record its
	// pointerId here so brush move/up route by OWNERSHIP (only this pointer drives
	// the stroke) and a SECOND distinct touch can be recognised as a pinch instead of
	// being mistaken for a brush extension. null = no brush stroke owns a pointer.
	// Set in onPointerDown when a touch starts a stroke; cleared on every stroke-exit
	// (endBrushStroke / cancelActiveBrushGesture / brush-disable). Mouse brush leaves
	// this null and is unaffected.
	private brushPointerId: number | null = null;
	private isTouchPinching = false;
	private pinchStartDistance = 0;
	private pinchStartZoom = 1;
	private touchGestureCleanup?: () => void;
	private coverStart: any = null;
	private f: any;
	private isSpacePressed = false;
	private spaceHandler?: (e: KeyboardEvent) => void;
	currentAspectRatio: [number, number] | null = [1, 1];
	private history = new HistoryManager();
	// P1-2 undo/redo serialization — edit-layer undo/redo commands are async (they
	// await a full edit-composite rebuild). Without serialization, a rapid second
	// undo/redo pops the stack again and runs its async command while the first is
	// still in flight, interleaving the two and corrupting the stack. We chain every
	// undo/redo onto a single tail promise so they run strictly one-at-a-time, in the
	// order the user pressed them (legitimately-queued undos are NOT dropped).
	private historyChain: Promise<boolean> = Promise.resolve(false);
	private currentImageUrl: string | null = null;
	private imageLoadGeneration = 0;
	// P1-2 same-page stale-rebuild guard — monotonic token bumped EVERY time a rebuild
	// is requested (setImageEditLayers + every commit/append/remove/revert path that
	// calls rebuildEditComposite). Unlike imageLoadGeneration/editLayersSourceImageId
	// (which only catch a DIFFERENT page/source), this catches a SAME-PAGE, same-source
	// race: an in-flight rebuild for stack [a] can finish AFTER a newer rebuild for
	// [a,b] already attached, clobbering it. Each rebuild captures this token at start
	// and bails after any await / before attach if a newer rebuild superseded it, so
	// only the MOST RECENT rebuild request may attach.
	private editStackGeneration = 0;
	// Generation that the PUBLISHED editCompositeCanvas corresponds to. While it
	// trails editStackGeneration a rebuild is still in flight — composite reads
	// must fail closed rather than sample the stale overlay (codex P2).
	private editCompositePublishedGeneration = -1;
	// PR #264 worker-race fix — monotonic epoch of the instant-apply backing
	// canvas. Bumped every time the backing canvas is dropped (page load / image
	// reload / destroy, all via resetBackgroundEditState). A heal stroke captures
	// this epoch BEFORE awaiting its off-thread Telea solve; applyToolPatchInstant
	// re-checks it after the solve and DISCARDS the worker result if the epoch
	// changed (the page switched / image reloaded / editor was destroyed while the
	// worker ran), so a late ROI can never composite onto the wrong page bitmap.
	private imageEpoch = 0;
	private imageLayerTransformStart = new Map<string, ImageLayer>();
	private imageLayerSnapGuides: any[] = [];
	// Snapshot of a TEXT layer captured at the start of a direct-on-canvas
	// interaction (transform drag/scale/rotate OR an in-place text edit). On
	// `object:modified`/`editing:exited` we diff against this to push a single
	// ModifyTextLayerCommand so direct canvas edits are undoable exactly like the
	// image-layer equivalents (image uses `imageLayerTransformStart`).
	private textLayerTransformStart = new Map<string, TextLayer>();

	// Keyboard-nudge coalescing: a burst of arrow-key nudges on one text layer is
	// applied live (no history) and committed as ONE undo entry when the burst settles.
	private nudgeBeforeLayer: TextLayer | null = null;
	private nudgeLayerId: string | null = null;
	private nudgeCommitTimer: ReturnType<typeof setTimeout> | null = null;

	// Processing indicators for AI jobs
	private processingIndicators = new Map<string, any>();

	static readonly MAX_CANVAS_WIDTH = 1024;
	static readonly MAX_AI_CROP_WIDTH = 1024;
	// The AI crop is bounded by a square cap: NEITHER dimension may exceed this in
	// original-image pixels. When a dimension exceeds it, BOTH are scaled by the
	// limiting ratio so the cropped region keeps its aspect ratio (never squashed).
	static readonly MAX_AI_CROP_HEIGHT = 1024;
	static readonly WEBTOON_FIT_WIDTH_ASPECT_RATIO = 3;
	static readonly WEBTOON_FIT_WIDTH_VIEWPORT_MULTIPLIER = 1.8;
	static readonly VIEWPORT_IMAGE_GUTTER = 48;

	getZoom(): number {
		return this.zoom;
	}

	zoomAtViewportCenter(nextZoom: number): number {
		const width = typeof this.canvas.getWidth === "function" ? this.canvas.getWidth() : this.canvasWidth;
		const height = typeof this.canvas.getHeight === "function" ? this.canvas.getHeight() : this.canvasHeight;
		return this.zoomAtCanvasPoint({ x: width / 2, y: height / 2 }, nextZoom);
	}

	zoomAtCanvasPoint(point: { x: number; y: number }, nextZoom: number): number {
		const zoom = Math.max(config.canvas.minZoom, Math.min(config.canvas.maxZoom, nextZoom));
		this.canvas.zoomToPoint(new this.f.Point(point.x, point.y), zoom);
		this.zoom = zoom;
		this.constrainViewportToImage();
		this.onZoomChange?.(zoom);
		this.onViewportChange?.();
		this.canvas.requestRenderAll();
		return zoom;
	}

	focusImageRegion(region: ImageRegionFocusTarget, options: { minZoom?: number } = {}): boolean {
		if (!this.imageItem || this.imageBounds.width <= 0 || this.imageBounds.height <= 0) return false;
		const { width, height } = this.getCanvasViewportSize();
		const currentZoom = this.canvas.getZoom?.() || this.zoom || 1;
		const minZoom = options.minZoom ?? 1.25;
		const zoom = Math.max(
			config.canvas.minZoom,
			Math.min(config.canvas.maxZoom, Math.max(currentZoom, minZoom)),
		);
		const nextTransform = buildViewportTransformForImageRegion({
			viewportTransform: this.canvas.viewportTransform,
			viewportWidth: width,
			viewportHeight: height,
			zoom,
			imageBounds: this.imageBounds,
			imageWidth: this.imageWidth,
			imageHeight: this.imageHeight,
			region,
		});
		if (!nextTransform) return false;
		this.canvas.setViewportTransform(nextTransform);
		this.zoom = zoom;
		this.constrainViewportToImage();
		this.onZoomChange?.(this.zoom);
		this.onViewportChange?.();
		this.canvas.requestRenderAll();
		return true;
	}

	private getCanvasViewportSize(): { width: number; height: number } {
		const width = typeof this.canvas.getWidth === "function" ? this.canvas.getWidth() : this.canvasWidth;
		const height = typeof this.canvas.getHeight === "function" ? this.canvas.getHeight() : this.canvasHeight;
		return { width, height };
	}

	private getCurrentViewportImageCenterRatio(): ViewportImageCenterRatio | null {
		const { width, height } = this.getCanvasViewportSize();
		const zoom = this.canvas.getZoom?.() || this.zoom || 1;
		return getViewportImageCenterRatio({
			viewportTransform: this.canvas.viewportTransform,
			viewportWidth: width,
			viewportHeight: height,
			zoom,
			imageBounds: this.imageBounds,
		});
	}

	private restoreViewportImageCenterRatio(centerRatio: ViewportImageCenterRatio | null): boolean {
		if (!centerRatio) return false;
		const { width, height } = this.getCanvasViewportSize();
		const zoom = this.canvas.getZoom?.() || this.zoom || 1;
		const nextTransform = buildViewportTransformForImageCenter({
			viewportTransform: this.canvas.viewportTransform,
			viewportWidth: width,
			viewportHeight: height,
			zoom,
			imageBounds: this.imageBounds,
			centerRatio,
		});

		if (!nextTransform) return false;
		this.canvas.setViewportTransform(nextTransform);
		this.zoom = zoom;
		this.constrainViewportToImage();
		return true;
	}

	private constrainViewportToImage(): boolean {
		if (!this.imageItem || this.imageBounds.width <= 0 || this.imageBounds.height <= 0) return false;
		const vpt = this.canvas.viewportTransform;
		if (!vpt) return false;

		const zoom = this.canvas.getZoom?.() || this.zoom || 1;
		const { width, height } = this.getCanvasViewportSize();
		if (width <= 0 || height <= 0 || zoom <= 0) return false;

		const gutter = Math.min(
			MangaEditor.VIEWPORT_IMAGE_GUTTER,
			Math.max(12, Math.min(width, height) * 0.12),
		);
		const b = this.imageBounds;

		const clampAxis = (
			currentOffset: number,
			canvasSize: number,
			imageStart: number,
			imageSize: number,
		) => {
			const imageScreenSize = imageSize * zoom;
			if (imageScreenSize <= canvasSize - gutter * 2) {
				return (canvasSize - imageScreenSize) / 2 - imageStart * zoom;
			}
			const minOffset = canvasSize - gutter - (imageStart + imageSize) * zoom;
			const maxOffset = gutter - imageStart * zoom;
			return Math.max(minOffset, Math.min(maxOffset, currentOffset));
		};

		const nextX = clampAxis(vpt[4], width, b.left, b.width);
		const nextY = clampAxis(vpt[5], height, b.top, b.height);
		if (Math.abs(nextX - vpt[4]) < 0.01 && Math.abs(nextY - vpt[5]) < 0.01) {
			return false;
		}

		vpt[4] = nextX;
		vpt[5] = nextY;
		this.canvas.setViewportTransform(vpt);
		return true;
	}

	static async create(canvasEl: HTMLCanvasElement) {
		const editor = new MangaEditor();
		editor.f = await loadFabric();

		editor.canvas = new editor.f.Canvas(canvasEl, EDITOR_CANVAS_OPTIONS);
		editor.setupEvents();
		return editor;
	}

	private constructor() {}

	private setupEvents() {
		// Keyboard event for Space key (pan mode).
		// Spacebar-to-pan must NOT engage while the user is typing into a text
		// field (panel input/textarea, contenteditable, or Fabric's hidden
		// in-canvas text-edit textarea) — otherwise typing a space silently flips
		// the canvas into Grab/Pan mode and the next drag pans instead of editing.
		// keydown engages pan; keyup must always release it cleanly so the mode
		// never sticks after the spacebar is let go.
		this.spaceHandler = (e: KeyboardEvent) => {
			if (e.code !== 'Space') return;
			if (e.type === 'keydown') {
				if (this.isSpacePressed) return;
				// Repeat events fire while holding; only engage on the first press
				// and skip entirely when a text-entry target is focused.
				if (e.repeat || isKeyboardTextEntryTarget(e.target)) return;
				this.isSpacePressed = true;
				document.body.style.cursor = 'grab';
			} else if (e.type === 'keyup') {
				if (!this.isSpacePressed) return;
				this.isSpacePressed = false;
				document.body.style.cursor = 'default';
			}
		};

		document.addEventListener('keydown', this.spaceHandler);
		document.addEventListener('keyup', this.spaceHandler);
		this.setupTouchGestures();

		this.canvas.on("mouse:wheel", (opt: any) => {
			const event = opt.e as WheelEvent;
			const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? Math.max(1, this.containerHeight * 0.85) : 1;
			const deltaX = event.deltaX * unit;
			const deltaY = event.deltaY * unit;

			if (classifyWheelGesture(event) === "zoom") {
				// Trackpad pinch (ctrlKey) and the explicit alt zoom modifier both zoom
				// about the cursor. Use the dominant axis so a pinch (mostly deltaY)
				// and an alt+wheel both feel right.
				const zoomDelta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
				let zoom = this.canvas.getZoom();
				zoom *= 0.999 ** zoomDelta;
				this.zoomAtCanvasPoint({ x: event.offsetX, y: event.offsetY }, zoom);
			} else {
				// Genuine scroll/swipe → pan in both axes (horizontal swipe still pans).
				this.canvas.relativePan(new this.f.Point(-deltaX, -deltaY));
				this.constrainViewportToImage();
				this.canvas.requestRenderAll();
			}

			this.onViewportChange?.();
			event.preventDefault();
			event.stopPropagation();
		});

		this.canvas.on("mouse:down", (opt: any) => {
			if (this.isTouchPinching) return;

			this.captureImageLayerTransformStart(opt.target);

			// W3.13: when an image-edit suite tool is active, forward the gesture to
			// the suite (image-space) instead of select/cover/brush/text logic.
			// Space+drag still pans; Alt is a tool modifier here (e.g. Clone Stamp
			// source pick) so it must NOT trigger pan while an image tool is active.
			if (this.imageToolActive && opt.e.button === 0 && !this.isSpacePressed) {
				const pointer = this.canvas.getPointer(opt.e);
				this.onImageToolPointer?.("down", { x: pointer.x, y: pointer.y }, {
					pressed: true,
					shiftKey: !!opt.e.shiftKey,
					altKey: !!opt.e.altKey,
					ctrlKey: !!opt.e.ctrlKey,
					metaKey: !!opt.e.metaKey,
				});
				opt.e.preventDefault();
				return;
			}

			// Pan with: middle mouse, Space+left click, or Alt+left click
			if (opt.e.button === 1 || (opt.e.button === 0 && (this.isSpacePressed || opt.e.altKey))) {
				this.isPanning = true;
				this.lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
				this.canvas.selection = false;
				opt.e.preventDefault();
				return;
			}

			if (this.tool === "cover" && opt.e.button === 0) {
				const pointer = this.canvas.getPointer(opt.e);
				this.startCoverSelection(pointer);
			}

			if (this.tool === "brush" && opt.e.button === 0) {
				const pointer = this.canvas.getPointer(opt.e);
				this.startBrushStroke(pointer);
				if (this.isDrawing) {
					opt.e.preventDefault();
					return;
				}
			}

			if (this.tool === "text" && opt.e.button === 0) {
				const pointer = this.canvas.getPointer(opt.e);
				this.addTextLayerAtCanvasPoint(pointer);
				this.setTool("select");
				opt.e.preventDefault();
			}
		});

		this.canvas.on("mouse:move", (opt: any) => {
			if (this.isTouchPinching) return;

			if (this.isPanning) {
				const dx = opt.e.clientX - this.lastPanPoint.x;
				const dy = opt.e.clientY - this.lastPanPoint.y;
				this.canvas.relativePan(new this.f.Point(dx, dy));
				this.constrainViewportToImage();
				this.lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
				this.hideBrushPreview();
				this.onViewportChange?.();
				this.canvas.requestRenderAll();
				return;
			}

			if (this.imageToolActive) {
				const pointer = this.canvas.getPointer(opt.e);
				this.onImageToolPointer?.("move", { x: pointer.x, y: pointer.y }, {
					pressed: opt.e.buttons === 1,
					shiftKey: !!opt.e.shiftKey,
					altKey: !!opt.e.altKey,
					ctrlKey: !!opt.e.ctrlKey,
					metaKey: !!opt.e.metaKey,
				});
				return;
			}

			if (this.tool === "cover" && this.coverStart && this.selectionRect) {
				const pointer = this.canvas.getPointer(opt.e);
				this.updateCoverSelection(pointer);
			}

			if (this.tool === "brush") {
				const pointer = this.canvas.getPointer(opt.e);
				this.updateBrushPreview(pointer);
				if (!this.isDrawing && opt.e.buttons === 1) {
					this.startBrushStroke(pointer);
				}
				if (this.isDrawing) {
					this.continueBrushStroke(pointer);
				}
			}
		});

		this.canvas.on("mouse:out", () => {
			this.hideBrushPreview();
		});

		this.canvas.on("mouse:up", (opt: any) => {
			if (this.isTouchPinching) return;

			this.isPanning = false;
			// Keep Fabric object selection disabled while an image-edit suite tool
			// owns the pointer; re-enabling it would let drags marquee-select objects
			// underneath the tool overlay.
			this.canvas.selection = !this.imageToolActive;
			this.clearImageLayerSnapGuides();
			if (!this.isSpacePressed) {
				document.body.style.cursor = 'default';
			}

			if (this.imageToolActive) {
				const pointer = this.canvas.getPointer(opt?.e);
				this.onImageToolPointer?.("up", { x: pointer.x, y: pointer.y }, {
					pressed: false,
					shiftKey: !!opt?.e?.shiftKey,
					altKey: !!opt?.e?.altKey,
					ctrlKey: !!opt?.e?.ctrlKey,
					metaKey: !!opt?.e?.metaKey,
				});
				return;
			}

			if (this.tool === "cover" && this.selectionRect) {
				this.finalizeCoverSelection();
			}

			if (this.tool === "brush" && this.isDrawing) {
				this.endBrushStroke();
			}
		});

		this.canvas.on("selection:created", (opt: any) => {
			const obj = opt.selected?.[0];
			if (obj && obj._textLayerData) {
				this.syncTextObjectData(obj);
				this.selectedImageLayerIdForBrush = null;
				this.onImageLayerSelect?.(null);
				this.onTextLayerSelect?.(obj._textLayerData as TextLayer);
			} else if (obj && obj._imageLayerData) {
				this.syncImageObjectData(obj);
				this.selectedImageLayerIdForBrush = obj._imageLayerData.id;
				this.onTextLayerSelect?.(null);
				this.onImageLayerSelect?.(obj._imageLayerData as ImageLayer);
			}
		});

		this.canvas.on("selection:updated", (opt: any) => {
			const obj = opt.selected?.[0];
			if (obj && obj._textLayerData) {
				this.syncTextObjectData(obj);
				this.selectedImageLayerIdForBrush = null;
				this.onImageLayerSelect?.(null);
				this.onTextLayerSelect?.(obj._textLayerData as TextLayer);
			} else if (obj && obj._imageLayerData) {
				this.syncImageObjectData(obj);
				this.selectedImageLayerIdForBrush = obj._imageLayerData.id;
				this.onTextLayerSelect?.(null);
				this.onImageLayerSelect?.(obj._imageLayerData as ImageLayer);
			}
		});

		this.canvas.on("selection:cleared", () => {
			this.clearImageLayerSnapGuides();
			if (this.tool === "brush") return;
			this.selectedImageLayerIdForBrush = null;
			this.onTextLayerSelect?.(null);
			this.onImageLayerSelect?.(null);
		});

		this.canvas.on("before:transform", (opt: any) => {
			const target = opt.target ?? opt.transform?.target;
			this.captureImageLayerTransformStart(target);
			this.captureTextLayerTransformStart(target);
		});

		// In-place text editing (double-click → type) must also be undoable as a
		// single command. Snapshot on entry; on exit/object:modified the diff is
		// pushed once. `editing:entered` may fire without a preceding transform
		// snapshot, so capture here too (capture is idempotent — first-wins).
		this.canvas.on("text:editing:entered", (opt: any) => {
			this.captureTextLayerTransformStart(opt.target);
		});

		this.canvas.on("text:editing:exited", (opt: any) => {
			if (!opt.target?._textLayerData) return;
			this.syncTextObjectData(opt.target);
			this.resyncTextEffectPasses(opt.target);
			this.emitTextLayersChange();
			this.onTextLayerSelect?.(opt.target._textLayerData as TextLayer);
			this.recordTextLayerDirectEdit(opt.target);
		});

		this.canvas.on("object:moving", (opt: any) => {
			this.applyImageLayerSnapping(opt.target);
		});

		this.canvas.on("object:scaling", (opt: any) => {
			this.applyImageLayerSnapping(opt.target);
		});

		this.canvas.on("object:modified", (opt: any) => {
			this.clearImageLayerSnapGuides();
			// A drag/resize is its own undo step — commit any pending keyboard-nudge
			// burst first so the two don't merge into one tangled history entry.
			this.flushNudgeHistory();
			if (opt.target?._textLayerData) {
				this.syncTextObjectData(opt.target);
				// A direct move/scale/rotate also shifts the separate shadow/accent
				// effect-pass objects; resync them so they don't go stale (P1 #3).
				this.resyncTextEffectPasses(opt.target);
				this.emitTextLayersChange();
				this.onTextLayerSelect?.(opt.target._textLayerData as TextLayer);
				// Push a single ModifyTextLayerCommand for the completed transform so
				// it is undoable like the image-layer drag path (P1 #1). A drag that
				// ends inside an active text edit is recorded on editing:exited
				// instead, so skip here to avoid double-pushing.
				if (!this.isTextObjectEditing(opt.target)) {
					this.recordTextLayerDirectEdit(opt.target);
				}
			} else if (opt.target?._imageLayerData) {
				const beforeLayer = this.consumeImageLayerTransformStart(opt.target);
				const afterLayer = this.syncImageObjectData(opt.target);
				this.emitImageLayersChange();
				this.onImageLayerSelect?.(afterLayer);
				if (beforeLayer) {
					this.recordImageLayerUpdateHistory(beforeLayer, afterLayer);
				}
			} else if (this.isMultiSelection(opt.target)) {
				// DATA-LOSS FIX (agy03): a multi-selection move/scale/rotate must write
				// the resulting absolute geometry back to EACH child layer, else it is
				// silently lost on save/reload.
				this.syncMultiSelectionTransform(opt.target);
			}
		});

		this.canvas.on("text:changed", (opt: any) => {
			if (opt.target?._textLayerData) {
				this.syncTextObjectData(opt.target);
				// Keep the shadow/accent passes mirroring the live text as it changes
				// (P1 #3); history for the whole edit is pushed once on editing:exited.
				this.resyncTextEffectPasses(opt.target);
				this.emitTextLayersChange();
				this.onTextLayerSelect?.(opt.target._textLayerData as TextLayer);
			}
		});
	}

	private setupTouchGestures() {
		const upperCanvas = this.canvas.upperCanvasEl as HTMLCanvasElement | undefined;
		if (!upperCanvas || typeof PointerEvent === "undefined") return;

		upperCanvas.style.touchAction = "none";

		let pinchLastCenter: { x: number; y: number } | null = null;
		const pointerPoint = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });
		const activeTouchPoints = () => Array.from(this.touchPointers.values()).slice(0, 2);
		const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
		const center = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
			x: (a.x + b.x) / 2,
			y: (a.y + b.y) / 2,
		});
		const scenePointer = (event: PointerEvent) => {
			const rect = upperCanvas.getBoundingClientRect();
			const transform = this.canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
			const zoomX = transform[0] || 1;
			const zoomY = transform[3] || zoomX;
			return {
				x: (event.clientX - rect.left - (transform[4] || 0)) / zoomX,
				y: (event.clientY - rect.top - (transform[5] || 0)) / zoomY,
			};
		};
		const stopTouchEvent = (event: PointerEvent) => {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
		};
		const findTouchTarget = (event: PointerEvent) => {
			try {
				return typeof this.canvas.findTarget === "function" ? this.canvas.findTarget(event, false) : null;
			} catch {
				return null;
			}
		};
		const isTouchLikePointer = (event: PointerEvent) => (
			event.pointerType === "touch" || event.pointerType === "pen"
		);
		// Resolve what a single finger / Apple-Pencil gesture should do given the
		// current tool + pointer count. Two-finger gestures still pan/pinch; a
		// single pointer draws with the active image-edit tool, else pans select.
		const resolveTouchAction = (event: PointerEvent): TouchPointerAction => resolveTouchPointerAction({
			pointerType: event.pointerType,
			touchPointerCount: this.touchPointers.size,
			tool: this.tool,
			imageToolActive: this.imageToolActive,
			isSpacePressed: this.isSpacePressed,
			hasTarget: !!findTouchTarget(event),
		});
		const forwardImageToolPointer = (phase: "down" | "move" | "up", event: PointerEvent) => {
			const scene = scenePointer(event);
			this.onImageToolPointer?.(phase, scene, {
				pressed: phase !== "up",
				shiftKey: !!event.shiftKey,
				altKey: !!event.altKey,
				ctrlKey: !!event.ctrlKey,
				metaKey: !!event.metaKey,
			});
		};
		// End an in-flight single-touch image-tool draw at its own last position
		// (used when a second finger arrives and we hand off to pan/pinch). The
		// passed clientPoint is the first pointer's last tracked location so the
		// suite commits the gesture where the finger actually was, not where the
		// new finger landed.
		const endImageToolTouchDrawAt = (clientPoint: { x: number; y: number }) => {
			if (this.touchImageToolPointerId === null) return;
			const rect = upperCanvas.getBoundingClientRect();
			const transform = this.canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
			const zoomX = transform[0] || 1;
			const zoomY = transform[3] || zoomX;
			const scene = {
				x: (clientPoint.x - rect.left - (transform[4] || 0)) / zoomX,
				y: (clientPoint.y - rect.top - (transform[5] || 0)) / zoomY,
			};
			this.onImageToolPointer?.("up", scene, {
				pressed: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
			});
			this.touchImageToolPointerId = null;
		};
		const shouldHandleBrushPointer = (event: PointerEvent) => (
			this.tool === "brush"
			&& !this.imageToolActive
			&& (event.pointerType === "touch" || event.button === 0 || event.buttons === 1)
		);
		const zoomAtClientPoint = (clientPoint: { x: number; y: number }, zoom: number) => {
			const rect = upperCanvas.getBoundingClientRect();
			const point = new this.f.Point(clientPoint.x - rect.left, clientPoint.y - rect.top);
			this.zoomAtCanvasPoint(point, zoom);
		};
		const startPinch = (event: PointerEvent) => {
			const [first, second] = activeTouchPoints();
			if (!first || !second) return;
			this.isTouchPinching = true;
			this.isTouchPanning = false;
			this.pinchStartDistance = Math.max(1, distance(first, second));
			this.pinchStartZoom = this.canvas.getZoom();
			pinchLastCenter = center(first, second);
			this.isPanning = false;
			// P1 multi-pointer re-entry — a second finger starting a pinch mid-stroke
			// abandons the in-flight image-layer brush stroke. Route this through
			// cancelActiveBrushGesture() (not a bare `imageLayerBrushTarget = null`) so
			// the live preview is un-swapped back to the TRUE original element before the
			// target is dropped; otherwise the visible object would stay pointed at the
			// uncommitted working canvas. Idempotent / no-op when no brush stroke is live.
			this.cancelActiveBrushGesture();
			this.isDrawing = false;
			this.brushPath = [];
			this.hideBrushPreview();
			this.canvas.selection = false;
			stopTouchEvent(event);
		};
		const endPinchIfNeeded = () => {
			if (!this.isTouchPinching || this.touchPointers.size >= 2) return;
			this.isTouchPinching = false;
			this.pinchStartDistance = 0;
			pinchLastCenter = null;
			// Don't re-enable Fabric object selection while an image-edit tool owns
			// the canvas — it must keep selection off to draw the tool overlay.
			this.canvas.selection = !this.imageToolActive;
			this.onViewportChange?.();
		};
		const onPointerDown = (event: PointerEvent) => {
			// P1 brush/pinch pointer-OWNERSHIP. The legacy brush is single-pointer and the
			// FIRST stroke owns the gesture (tracked via `brushPointerId`). A SECOND distinct
			// touch arriving during a live stroke must become a PINCH, never extend/clobber
			// the brush:
			//   - cancel the in-flight stroke (restores the TRUE original element; no commit),
			//   - register BOTH pointers in `touchPointers`,
			//   - start the two-finger pinch.
			// The owning pointer was registered in `touchPointers` when the stroke started
			// (so the pinch sees two points). A non-touch (mouse) brush leaves
			// `brushPointerId` null and is unaffected by this path.
			const brushStrokeActive = this.brushPointerId !== null;
			if (
				brushStrokeActive
				&& isTouchLikePointer(event)
				&& event.pointerId !== this.brushPointerId
			) {
				// Discard the brush stroke WITHOUT committing (un-swaps the live preview back
				// to the true original) and clear its pointer ownership, then promote both
				// fingers to a pinch.
				this.cancelActiveBrushGesture();
				this.touchPointers.set(event.pointerId, pointerPoint(event));
				try {
					upperCanvas.setPointerCapture(event.pointerId);
				} catch {
					// Some browser/test environments do not allow capture for synthetic pointers.
				}
				startPinch(event);
				return;
			}
			// FIRST brush pointer (no stroke owns a pointer yet). Start the stroke; if it
			// took, the starting pointer OWNS it. For a touch pointer we also register it in
			// `touchPointers` so the pointer bookkeeping is consistent — a later second touch
			// can then see two tracked points and pinch.
			//
			// OWNERSHIP-STEAL GUARD (mixed mouse+touch). `brushStrokeActive` only tracks a
			// *touch* owner (`brushPointerId`); a live MOUSE stroke uses the null owner, so
			// `brushStrokeActive` is false even while `this.isDrawing` is true. Without the
			// `!this.isDrawing` gate below, a touch arriving mid-mouse-stroke would enter this
			// path, and (because `this.isDrawing` is already true) REASSIGN `brushPointerId`
			// to the touch + register it — stealing the mouse's stroke (the mouse could then
			// no longer drive/commit its own stroke; the touch would commit it instead).
			// So only START a stroke (and only claim ownership) on a REAL start transition:
			// require no stroke currently active (`!this.isDrawing`), then capture
			// `wasDrawing` and only take ownership when this event actually began the stroke
			// (`!wasDrawing && this.isDrawing`). If a stroke is already live (mouse OR another
			// touch), the new pointer must NOT steal it — fall through to the pinch/pan
			// tracking below as a non-owner (same as the second-touch case).
			if (!brushStrokeActive && !this.isDrawing && shouldHandleBrushPointer(event)) {
				const wasDrawing = this.isDrawing;
				this.startBrushStroke(scenePointer(event));
				if (!wasDrawing && this.isDrawing) {
					// Only TOUCH-like strokes take pointer ownership + tracking; a mouse
					// stroke is single-pointer by nature and stays on the null-owner fast
					// path (brush behavior unchanged), never tracked in touchPointers.
					if (isTouchLikePointer(event)) {
						this.brushPointerId = event.pointerId;
						this.touchPointers.set(event.pointerId, pointerPoint(event));
					}
					try {
						upperCanvas.setPointerCapture(event.pointerId);
					} catch {
						// Some browser/test environments do not allow capture for synthetic pointers.
					}
					stopTouchEvent(event);
				}
				return;
			}
			if (!isTouchLikePointer(event)) return;
			this.touchPointers.set(event.pointerId, pointerPoint(event));
			try {
				upperCanvas.setPointerCapture(event.pointerId);
			} catch {
				// Some browser/test environments do not allow capture for synthetic pointers.
			}
			if (this.touchPointers.size >= 2) {
				// A second finger arrived: commit any in-flight single-touch image-tool
				// draw at the first pointer's last position, then switch to pan/pinch
				// so two-finger nav always wins.
				if (this.touchImageToolPointerId !== null) {
					const last = this.touchPointers.get(this.touchImageToolPointerId);
					if (last) endImageToolTouchDrawAt(last);
					else this.touchImageToolPointerId = null;
				}
				startPinch(event);
				return;
			}
			const action = resolveTouchAction(event);
			if (action === "image-tool") {
				this.touchImageToolPointerId = event.pointerId;
				this.isTouchPanning = false;
				this.canvas.selection = false;
				this.hideBrushPreview();
				forwardImageToolPointer("down", event);
				stopTouchEvent(event);
				return;
			}
			if (action === "pan") {
				this.isTouchPanning = true;
				this.lastTouchPanPoint = pointerPoint(event);
				this.canvas.selection = false;
				this.hideBrushPreview();
				stopTouchEvent(event);
			}
		};
		// True only for the pointer that OWNS the active brush stroke. A touch stroke is
		// owned by `brushPointerId` (that exact pointer). A MOUSE stroke uses the null
		// owner — but "null owner" means MOUSE, so it must be matched ONLY by a non-touch
		// (mouse) pointer, never by a touch/pen. Without this, a touch arriving mid-mouse-
		// stroke (which does NOT set `brushPointerId`) would satisfy `brushPointerId === null`
		// and could drive/commit the mouse's stroke — the ownership-steal this guard closes.
		//
		// UNIFORM BRUSH-GESTURE OWNERSHIP AUDIT (#358 r6). EVERY brush-gesture exit path —
		// pointermove (drive), pointerup/end (commit), pointercancel + lostpointercapture
		// (abandon) — gates on `ownsActiveBrushStroke(event)`. pointerdown's start path is
		// owner-defining (it CLAIMS ownership) and its steal-guard uses the complementary
		// `brushStrokeActive`/`!this.isDrawing` checks. Truth table over
		// {input: mouse | touch | pen} × {exit: up | cancel | lostcapture} × {owner: this | other | none}.
		// Touch and pen are both `isTouchLikePointer` so they take the SAME (touch-owner) path.
		//
		//  input  owner   up                         cancel / lostcapture
		//  mouse  none    owns (null==mouse) → commit owns → cancelActiveBrushGesture (abandon)
		//         (mouse never sets brushPointerId, so "this"/"other" owner cells are N/A)
		//  touch  this    owns → endBrushStroke,      owns → cancelActiveBrushGesture,
		//                 brushPointerId=null,         brushPointerId=null (via helper),
		//                 delete its touchPointer       delete its touchPointer
		//  touch  other   NOT owner → falls through    NOT owner → falls through to touch
		//                 to touch cleanup (delete      cleanup (delete entry); the real
		//                 entry); owner's stroke kept   owner's stroke is untouched
		//  touch  none    no stroke → touch cleanup    no stroke → touch cleanup
		//  pen    *       same as touch (isTouchLike)   same as touch (isTouchLike)
		//
		// In EVERY cell the exit leaves isDrawing / brushPointerId / imageLayerBrushTarget /
		// previewActive / touchPointers clean: commit (endBrushStroke) and abandon
		// (cancelActiveBrushGesture) both clear isDrawing+imageLayerBrushTarget and release
		// brushPointerId; abandon additionally un-swaps the live preview (previewActive→false);
		// both are idempotent so no double-commit / double-restore; a non-owner exit only
		// deletes its OWN touchPointer entry and never abandons the owner's stroke.
		const ownsActiveBrushStroke = (event: PointerEvent) => (
			this.brushPointerId === null
				? !isTouchLikePointer(event)
				: this.brushPointerId === event.pointerId
		);
		const onPointerMove = (event: PointerEvent) => {
			// P1 brush/pinch pointer-OWNERSHIP. Only the pointer that OWNS the active stroke
			// drives brush move. For a touch stroke `brushPointerId` is the owner, so a move
			// from a DIFFERENT finger never extends the stroke (it falls through to the
			// pinch/pan tracking below). A mouse brush leaves `brushPointerId` null, so its
			// single MOUSE pointer keeps driving the stroke exactly as before (a touch never
			// matches the null owner — see `ownsActiveBrushStroke`).
			if (this.tool === "brush" && this.isDrawing && ownsActiveBrushStroke(event)) {
				const pointer = scenePointer(event);
				this.updateBrushPreview(pointer);
				this.continueBrushStroke(pointer);
				stopTouchEvent(event);
				return;
			}
			if (!isTouchLikePointer(event)) return;
			if (!this.touchPointers.has(event.pointerId)) return;
			this.touchPointers.set(event.pointerId, pointerPoint(event));
			// Single finger/pencil drag with an image-edit tool active → forward the
			// move to the suite (draw selection/stroke) rather than pan.
			if (this.touchImageToolPointerId === event.pointerId && !this.isTouchPinching) {
				forwardImageToolPointer("move", event);
				stopTouchEvent(event);
				return;
			}
			if (!this.isTouchPinching && this.isTouchPanning && this.touchPointers.size === 1) {
				const nextPoint = pointerPoint(event);
				const dx = nextPoint.x - this.lastTouchPanPoint.x;
				const dy = nextPoint.y - this.lastTouchPanPoint.y;
				this.lastTouchPanPoint = nextPoint;
				if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
					this.canvas.relativePan(new this.f.Point(dx, dy));
					this.constrainViewportToImage();
					this.onViewportChange?.();
					this.canvas.requestRenderAll();
				}
				stopTouchEvent(event);
				return;
			}
			if (!this.isTouchPinching) return;

			const [first, second] = activeTouchPoints();
			if (!first || !second || this.pinchStartDistance <= 0) return;
			const nextDistance = Math.max(1, distance(first, second));
			const nextZoom = Math.max(
				config.canvas.minZoom,
				Math.min(config.canvas.maxZoom, this.pinchStartZoom * (nextDistance / this.pinchStartDistance)),
			);
			const nextCenter = center(first, second);
			const panDelta = pinchLastCenter
				? { x: nextCenter.x - pinchLastCenter.x, y: nextCenter.y - pinchLastCenter.y }
				: { x: 0, y: 0 };
			zoomAtClientPoint(nextCenter, nextZoom);
			if (Math.abs(panDelta.x) > 0.01 || Math.abs(panDelta.y) > 0.01) {
				this.canvas.relativePan(new this.f.Point(panDelta.x, panDelta.y));
				this.constrainViewportToImage();
				this.onViewportChange?.();
				this.canvas.requestRenderAll();
			}
			pinchLastCenter = nextCenter;
			stopTouchEvent(event);
		};
		const onPointerEnd = (event: PointerEvent) => {
			// P1 brush/pinch pointer-OWNERSHIP. Only the OWNING pointer commits the stroke.
			// A mouse brush (brushPointerId === null) commits as before — but the null owner
			// is matched ONLY by a non-touch (mouse) pointer via `ownsActiveBrushStroke`, so a
			// touch lifting mid-mouse-stroke can NOT commit it. For a touch stroke the owning
			// pointer is also tracked in `touchPointers`, so clear that entry and its ownership
			// here (a fresh single-finger stroke or two-finger pinch then starts clean). A
			// non-owning pointer-up never commits the brush — it falls through to the
			// touch-tracking cleanup below.
			if (this.tool === "brush" && this.isDrawing && ownsActiveBrushStroke(event)) {
				this.endBrushStroke();
				this.brushPointerId = null;
				this.touchPointers.delete(event.pointerId);
				if (this.touchPointers.size === 0) {
					this.isTouchPanning = false;
					this.canvas.selection = !this.imageToolActive;
				}
				stopTouchEvent(event);
				return;
			}
			if (!isTouchLikePointer(event)) return;
			// Finish an in-flight single-touch image-tool draw (commit the gesture).
			if (this.touchImageToolPointerId === event.pointerId) {
				forwardImageToolPointer("up", event);
				this.touchImageToolPointerId = null;
				stopTouchEvent(event);
			}
			this.touchPointers.delete(event.pointerId);
			if (this.touchPointers.size === 0) {
				this.isTouchPanning = false;
				this.canvas.selection = !this.imageToolActive;
			}
			endPinchIfNeeded();
		};
		const onPointerCancel = (event: PointerEvent) => {
			// P1 brush/pinch pointer-OWNERSHIP. A cancel / lost-capture on the OWNING brush
			// pointer abandons the stroke WITHOUT committing (cancel != a clean lift) and
			// clears ownership + its tracked pointer, so the next gesture starts fresh.
			//
			// Use the SAME ownership predicate as move/up (`ownsActiveBrushStroke`) so the
			// null-owner MOUSE stroke is ALSO cancelled here. The legacy `brushPointerId`
			// check only covered TOUCH-owned strokes; a mouse stroke (brushPointerId === null)
			// would otherwise fall through to `if (!isTouchLikePointer(event)) return` below
			// and leak `isDrawing` + `imageLayerBrushTarget` live after capture loss (round 6).
			// A live stroke exists when `isDrawing` is set OR a brush target/owner is dangling;
			// scope the abandon to the OWNING pointer so a non-owner cancel can't kill it.
			const brushStrokeLive = this.isDrawing || !!this.imageLayerBrushTarget || this.brushPointerId !== null;
			if (this.tool === "brush" && brushStrokeLive && ownsActiveBrushStroke(event)) {
				this.cancelActiveBrushGesture();
				this.touchPointers.delete(event.pointerId);
				if (this.touchPointers.size === 0) {
					this.isTouchPanning = false;
					this.canvas.selection = !this.imageToolActive;
				}
				stopTouchEvent(event);
				endPinchIfNeeded();
				return;
			}
			if (!isTouchLikePointer(event)) return;
			// Treat a cancelled image-tool pointer like a pointer-up so the suite
			// commits/cleans up rather than leaving a dangling in-progress gesture.
			if (this.touchImageToolPointerId === event.pointerId) {
				forwardImageToolPointer("up", event);
				this.touchImageToolPointerId = null;
				stopTouchEvent(event);
			}
			this.touchPointers.delete(event.pointerId);
			if (this.touchPointers.size === 0) {
				this.isTouchPanning = false;
				this.canvas.selection = !this.imageToolActive;
			}
			endPinchIfNeeded();
		};

		upperCanvas.addEventListener("pointerdown", onPointerDown, { capture: true });
		upperCanvas.addEventListener("pointermove", onPointerMove, { capture: true });
		upperCanvas.addEventListener("pointerup", onPointerEnd, { capture: true });
		upperCanvas.addEventListener("pointercancel", onPointerCancel, { capture: true });
		upperCanvas.addEventListener("lostpointercapture", onPointerCancel, { capture: true });

		this.touchGestureCleanup = () => {
			upperCanvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
			upperCanvas.removeEventListener("pointermove", onPointerMove, { capture: true });
			upperCanvas.removeEventListener("pointerup", onPointerEnd, { capture: true });
			upperCanvas.removeEventListener("pointercancel", onPointerCancel, { capture: true });
			upperCanvas.removeEventListener("lostpointercapture", onPointerCancel, { capture: true });
			this.touchPointers.clear();
			this.isTouchPanning = false;
			this.isTouchPinching = false;
			this.touchImageToolPointerId = null;
			this.brushPointerId = null;
			pinchLastCenter = null;
		};
	}

	// Load an image into a Fabric image object via the shared authed loader so
	// backend asset URLs (`/api/images/...`) carry the access token (Fabric's own
	// `FabricImage.fromURL` does not attach it, which would 401 a persisted page
	// and never render). The shared helper fetches such URLs as a same-origin
	// `blob:` (untainted, export-safe) and revokes it after load; blob:/data:
	// URLs (fresh uploads, brush results) pass straight through. Mirrors the
	// batch/page export path in page-export.ts.
	private loadFabricImage(url: string, options?: Record<string, unknown>): Promise<any> {
		return loadAuthedFabricImage(this.f, url, options) as Promise<any>;
	}

	async loadImage(url: string) {
		// P1 cancel-stroke-on-nav fix — abandon any in-progress pointer gesture
		// (suite clone/heal OR legacy engine brush) against the page it was drawn on
		// BEFORE the canvas + image are swapped. Without this, the active ToolContext /
		// brush buffers survive the load and the pending move/up commits old-page
		// pixels onto the NEW page (the wrong-page corruption this closes).
		this.cancelActiveBrushGesture();
		const loadGeneration = ++this.imageLoadGeneration;
		// P1 OOM fix — `canvas.clear()` only detaches objects; it does NOT free their
		// decoded bitmaps / cache canvases / our swapped-in editable background canvas.
		// Explicitly dispose the outgoing page background + every image layer FIRST so
		// their heavy backing buffers are released and don't accumulate across page
		// switches (long sessions otherwise grow heap until the tab OOM-crashes). The
		// swapped-out `backgroundEditCanvas` is held by `imageItem._element`, so this is
		// what actually lets it (and old-page layers) be GC'd.
		this.disposeFabricImageObject(this.imageItem);
		for (const layerObject of this.imageLayers) {
			this.disposeFabricImageObject(layerObject);
		}
		this.canvas.clear();
		this.imageLayerSnapGuides = [];
		this.imageItem = null;
		this.imageWidth = 0;
		this.imageHeight = 0;
		this.imageBounds = { left: 0, top: 0, width: 0, height: 0 };
		this.onImageChange?.(false);
		this.imageLayers = [];
		this.textLayers = [];
		this.emitImageLayersChange();
		this.emitTextLayersChange();
		this.onTextLayerSelect?.(null);
		this.onImageLayerSelect?.(null);
		this.selectionRect = null;
		this.selectionLabel = null;
		this.history.clear();
		this.imageLayerTransformStart.clear();
		this.textLayerTransformStart.clear();
		this.currentImageUrl = url;
		this.brushPreview = null;
		// canvas.clear() above drops the boundary line objects — forget the stale
		// references so syncPageGuardrails() rebuilds them against the new image.
		this.pageBoundaryLines = [];
		this.originalImageUrl = url;
		this.originalImageDataUrl = url;
		this.originalImageCache = null;
		this.aiOverlayImage = null;
		this.eraserCanvas = null;
		this.eraserCtx = null;
		this.maskCanvas = null;
		this.maskCtx = null;
		// Drop the previous page's instant-apply backing canvas so a new page starts
		// from its own bitmap. Navigation has already flushed any pending persist for
		// the OLD page via waitForPendingBrushCommit() before reaching here.
		this.resetBackgroundEditState();
		// Drop the previous page's non-destructive edit-composite overlay + stack; the
		// store re-feeds the new page's stack via setImageEditLayers() after load.
		this.removeEditComposite();
		this.imageEditLayers = [];
		this.editLayersSourceImageId = null;
		// Drop any pending preview ROI snapshot — it belongs to the previous page's backing
		// canvas (P1-1); a new page promotes a fresh backingEditCanvas.
		this.previewRoiOriginal = null;

		// Reset viewport transform to identity before loading new image
		this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
		this.zoom = 1;

		// If container dimensions are not set yet, measure the workspace
		if (this.containerWidth <= 0 || this.containerHeight <= 0) {
			const canvasEl = this.canvas.getElement();
			if (canvasEl) {
				const workspace = canvasEl.closest('.canvas-workspace') as HTMLElement | null;
				if (workspace) {
					const rect = workspace.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0) {
						this.containerWidth = Math.round(rect.width);
						this.containerHeight = Math.round(rect.height);
					}
				}
			}
		}

		try {
			const img = await this.loadFabricImage(url, { crossOrigin: "anonymous" });
			if (loadGeneration !== this.imageLoadGeneration) return;
			this.imageItem = img;
			this.imageWidth = img.width || 1;
			this.imageHeight = img.height || 1;

			// Calculate canvas dimensions based on image size
			this.calculateCanvasDimensions();

			this._fitCanvasToContainer();
			this._centerImage(img);

			img.set(LOCKED_PAGE_IMAGE_OPTIONS);
			this.canvas.add(img);

			this._autoFitToWorkspace();
			const imgElement = img.getElement();
			if (imgElement) {
				this.originalImageCache = imgElement as HTMLImageElement;
			}
			this.canvas.requestRenderAll();
			this.onImageChange?.(true);
			this.onViewportChange?.();
		} catch (e) {
			if (loadGeneration !== this.imageLoadGeneration) return;
			console.error("[editor] Failed to load image:", e);
			this.onImageChange?.(false);
			throw e;
		}
	}

	/** Called by CanvasArea ResizeObserver when the workspace resizes */
	setContainerSize(width: number, height: number) {
		// Skip if this resize was triggered by our own CSS update (prevents feedback loop)
		if (this.ignoreResizeObserver) {
			return;
		}

		// Skip if dimensions haven't changed
		if (width === this.containerWidth && height === this.containerHeight) {
			return;
		}

		const imageCenter = this.getCurrentViewportImageCenterRatio();
		const textLayerData = this.getAllTextLayers();
		const imageLayerData = this.getAllImageLayers();
		this.containerWidth = width;
		this.containerHeight = height;
		this.calculateCanvasDimensions();
		this._fitCanvasToContainer();

		if (this.imageItem) {
			this._centerImage(this.imageItem);
			this.remapLayerObjectsFromImageSpace(textLayerData, imageLayerData);
			if (!this.restoreViewportImageCenterRatio(imageCenter)) {
				this.constrainViewportToImage();
			}
			this.canvas.requestRenderAll();
			this.onViewportChange?.();
		}
	}

	private _fitCanvasToContainer() {
		if (this.canvasWidth <= 0 || this.canvasHeight <= 0) {
			this.calculateCanvasDimensions();
		}
		this.canvas.setDimensions({ width: this.canvasWidth, height: this.canvasHeight });
		this._updateCanvasWrapperCSS();
	}

	private _updateCanvasWrapperCSS() {
		// Don't set canvas CSS dimensions - let the canvas fit within the workspace using
		// Fabric.js's viewport transform (zoom/pan). Setting fixed CSS width/height causes
		// overflow issues when canvas resolution is larger than workspace size.
		//
		// Feedback loop prevention: When we update the CSS, ResizeObserver will fire.
		// We set ignoreResizeObserver=true so setContainerSize() skips handling that event.
		this.ignoreResizeObserver = true;

		// Reset flag after ResizeObserver has had a chance to run
		setTimeout(() => {
			this.ignoreResizeObserver = false;
		}, 0);
	}

	/** Auto-fit canvas to workspace by zooming and centering if canvas is larger than container */
	private _autoFitToWorkspace() {
		if (this.containerWidth <= 0 || this.containerHeight <= 0) return;
		if (this.canvasWidth <= 0 || this.canvasHeight <= 0) return;

		const scaleX = this.containerWidth / this.canvasWidth;
		const scaleY = this.containerHeight / this.canvasHeight;
		const fitZoom = Math.min(scaleX, scaleY);

		// Only zoom out if canvas is larger than workspace
		const zoom = fitZoom < 1 ? fitZoom : 1;
		const vptX = (this.containerWidth - this.canvasWidth * zoom) / 2;
		const vptY = (this.containerHeight - this.canvasHeight * zoom) / 2;

		this.canvas.setViewportTransform([zoom, 0, 0, zoom, vptX, vptY]);
		this.zoom = zoom;
		this.onZoomChange?.(zoom);
		this.onViewportChange?.();
	}

	/**
	 * Public "Reset view" → fit-to-screen (re-center + fit the page in the
	 * workspace), NOT a hard 100% zoom. Returns the resulting zoom so the store can
	 * sync its readout. Used by the viewport Reset control.
	 */
	fitViewportToScreen(): number {
		this._autoFitToWorkspace();
		this.canvas.requestRenderAll();
		return this.zoom;
	}

	private _centerImage(img: any) {
		const placement = buildInitialImagePlacement({
			canvasWidth: this.canvasWidth,
			canvasHeight: this.canvasHeight,
			imageWidth: this.imageWidth,
			imageHeight: this.imageHeight,
			fitTallImageByWidth: this.shouldFitTallImageByWidth(),
			topGutter: MangaEditor.VIEWPORT_IMAGE_GUTTER,
		});

		img.scale(placement.scale);
		img.set({ left: placement.left, top: placement.top, originX: "left", originY: "top" });
		img.setCoords?.();

		this.imageBounds = {
			left: placement.left,
			top: placement.top,
			width: placement.width,
			height: placement.height,
		};

		// Re-anchor the long-page boundary overlay + per-page tool clip against
		// the freshly-computed image bounds (covers load, background swap, resize).
		this.syncPageGuardrails();

		// P1 selection-overlay drift fix — _centerImage is the single chokepoint that
		// recomputes `imageBounds` for every recenter/fit/resize. The image-edit
		// suite's translucent selection overlay bakes the OLD imageBounds into its
		// Fabric image, so re-render it against the new bounds (no-op when there is no
		// active selection / the mask was just cleared on a page change). The mask of
		// record (image-space MaskBuffer) is untouched — only its on-screen projection.
		this.onRefreshSelectionOverlay?.();

		// Re-anchor the non-destructive edit-composite overlay to the new imageBounds so
		// the clean stays aligned over the page on every recenter/fit/resize.
		if (this.editCompositeImage && this.editCompositeCanvas) this.attachEditCompositeOverlay();
	}

	private shouldFitTallImageByWidth(): boolean {
		if (this.imageWidth <= 0 || this.imageHeight <= 0 || this.canvasWidth <= 0 || this.canvasHeight <= 0) {
			return false;
		}

		const imageAspect = this.imageHeight / this.imageWidth;
		const viewportAspect = this.canvasHeight / this.canvasWidth;
		return imageAspect >= MangaEditor.WEBTOON_FIT_WIDTH_ASPECT_RATIO
			&& imageAspect >= viewportAspect * MangaEditor.WEBTOON_FIT_WIDTH_VIEWPORT_MULTIPLIER;
	}

	// Replace background image without clearing text layers or selection
	async updateBackgroundImage(url: string, isAiResult = false) {
		try {
			const imageCenter = this.getCurrentViewportImageCenterRatio();
			const textLayerData = this.getAllTextLayers();
			const imageLayerData = this.getAllImageLayers();
			// Staleness guard: the authed loader now fetches bytes before decoding,
			// so a slow load can resolve after a newer background swap. Capture the
			// expected URL before awaiting and bail (disposing the late image) if a
			// newer request has since changed currentImageUrl, so an old image never
			// overwrites the canvas.
			const expectedUrl = url;
			this.currentImageUrl = url;
			const img = await this.loadFabricImage(url, { crossOrigin: "anonymous" });
			if (this.currentImageUrl !== expectedUrl) {
				try {
					img?.dispose?.();
				} catch {
					// ignore — Fabric image without dispose (older versions)
				}
				return;
			}

			if (this.imageItem) {
				const previousImageItem = this.imageItem;
				this.canvas.remove(previousImageItem);
				// P1 OOM fix — free the outgoing background's backing bitmap + our
				// swapped-in editable canvas (held via _element) so a long sequence of
				// background swaps (incl. brush undo/redo, AI restore) doesn't leak.
				this.disposeFabricImageObject(previousImageItem);
			}

			// P1 undoable-stroke fix — a background swap (incl. undo/redo of a brush
			// stroke) replaces the bitmap, so drop the previous instant-apply backing
			// canvas + bump the epoch. This guarantees the next stroke re-seeds its edit
			// canvas from the NOW-current bitmap and that any in-flight off-thread heal
			// for the previous bitmap is discarded (epoch advanced), rather than
			// compositing onto the post-swap image.
			this.resetBackgroundEditState();

			this.imageItem = img;
			this.imageWidth = img.width || 1;
			this.imageHeight = img.height || 1;

			// If container dimensions are not set yet, measure the workspace
			if (this.containerWidth <= 0 || this.containerHeight <= 0) {
				const canvasEl = this.canvas.getElement();
				if (canvasEl) {
					const workspace = canvasEl.closest('.canvas-workspace') as HTMLElement | null;
					if (workspace) {
						const rect = workspace.getBoundingClientRect();
						if (rect.width > 0 && rect.height > 0) {
							this.containerWidth = Math.round(rect.width);
							this.containerHeight = Math.round(rect.height);
						}
					}
				}
			}

			// Calculate canvas dimensions based on image size
			this.calculateCanvasDimensions();

			this._fitCanvasToContainer();
			this._centerImage(img);

			img.set(LOCKED_PAGE_IMAGE_OPTIONS);
			this.canvas.insertAt(0, img);

			this.remapLayerObjectsFromImageSpace(textLayerData, imageLayerData);
			if (imageCenter) {
				this.restoreViewportImageCenterRatio(imageCenter);
			} else {
				this._autoFitToWorkspace();
			}
			this.canvas.requestRenderAll();
			this.onViewportChange?.();

			// Store original image for brush eraser compositing
			if (!isAiResult) {
				this.originalImageUrl = url;
				this.originalImageDataUrl = url;
				const imgElement = img.getElement();
				if (imgElement) {
					this.originalImageCache = imgElement as HTMLImageElement;
				}
				this.aiOverlayImage = null;
				this.eraserCanvas = null;
				this.eraserCtx = null;
				this.maskCanvas = null;
				this.maskCtx = null;
			}

			// If this is an AI result, set up the eraser overlay
			if (isAiResult) {
				// Get the actual image element from the Fabric image
				const imgElement = img.getElement();
				if (imgElement) {
					await this.setAiOverlayImage(imgElement);
				}
			}
			this.onImageChange?.(true);
			this.onViewportChange?.();
		} catch (e) {
			console.error("[editor] Failed to update background image:", e);
			this.onImageChange?.(Boolean(this.imageItem));
		}
	}

	private calculateCanvasDimensions() {
		const fallbackWidth = this.imageWidth > 0 ? Math.min(this.imageWidth, MangaEditor.MAX_CANVAS_WIDTH) : 800;
		const fallbackHeight = this.imageHeight > 0 ? Math.min(this.imageHeight, MangaEditor.MAX_CANVAS_WIDTH) : 600;

		this.canvasWidth = Math.max(1, Math.round(this.containerWidth > 0 ? this.containerWidth : fallbackWidth));
		this.canvasHeight = Math.max(1, Math.round(this.containerHeight > 0 ? this.containerHeight : fallbackHeight));
	}

	private formatSelectionSize(width: number, height: number): string {
		const b = this.imageBounds;
		if (b.width <= 0 || b.height <= 0 || this.imageWidth <= 0 || this.imageHeight <= 0) {
			return `${Math.round(width)}x${Math.round(height)}`;
		}
		const imageW = Math.max(0, Math.round(width * (this.imageWidth / b.width)));
		const imageH = Math.max(0, Math.round(height * (this.imageHeight / b.height)));
		return `${imageW}x${imageH}`;
	}

	private positionSelectionLabel(left: number, top: number, width: number, height: number, invZoom: number, text?: string): void {
		if (!this.selectionLabel) return;

		const minWidth = SELECTION_LABEL_MIN_WIDTH * invZoom;
		const minHeight = SELECTION_LABEL_MIN_HEIGHT * invZoom;
		const canShow = width >= minWidth && height >= minHeight;
		this.selectionLabel.set({ visible: canShow });
		if (!canShow) return;

		const fontSize = SELECTION_LABEL_FONT_SIZE * invZoom;
		const labelText = text ?? this.formatSelectionSize(width, height);
		this.selectionLabel.set({
			fontSize,
			text: labelText,
		});
		const fallbackLabelWidth = labelText.length * fontSize * 0.6;
		const labelWidth = (this.selectionLabel.width ?? fallbackLabelWidth) * (this.selectionLabel.scaleX ?? 1);
		const labelHeight = (this.selectionLabel.height ?? fontSize) * (this.selectionLabel.scaleY ?? 1);
		const padding = SELECTION_LABEL_PADDING * invZoom;
		this.selectionLabel.set({
			left: left + Math.max(padding, width - labelWidth - padding),
			top: top + Math.max(padding, height - labelHeight - padding),
		});
	}

	private _applyAspectRatioToSelection(ratio: [number, number] | null) {
		if (!this.selectionRect || !this.imageItem) return;

		const bounds = this.imageBounds;
		const invZoom = 1 / (this.canvas.getZoom() || 1);

		// Get current selection dimensions
		const oldLeft = this.selectionRect.left || 0;
		const oldTop = this.selectionRect.top || 0;
		const oldWidth = this.selectionRect.width || 0;
		const oldHeight = this.selectionRect.height || 0;

		// Calculate selection center
		const centerX = oldLeft + oldWidth / 2;
		const centerY = oldTop + oldHeight / 2;

		let newWidth = oldWidth;
		let newHeight = oldHeight;

		// Apply aspect ratio constraint
		if (ratio && newWidth > 0 && newHeight > 0) {
			const [rw, rh] = ratio;
			const targetRatio = rh / rw;
			const currentRatio = newHeight / newWidth;

			if (Math.abs(currentRatio - targetRatio) > ASPECT_RATIO_TOLERANCE) {
				if (currentRatio < targetRatio) {
					// Selection is too wide, increase height
					newHeight = newWidth * targetRatio;
				} else {
					// Selection is too tall, increase width
					newWidth = newHeight / targetRatio;
				}
			}
		}

		// Clamp to image bounds
		const maxWidth = bounds.width;
		const maxHeight = bounds.height;

		newWidth = Math.min(newWidth, maxWidth);
		newHeight = Math.min(newHeight, maxHeight);

		// Calculate new position to keep selection centered
		const newLeft = centerX - newWidth / 2;
		const newTop = centerY - newHeight / 2;

		// Clamp position to image bounds
		const clampedLeft = Math.max(bounds.left, Math.min(newLeft, bounds.left + bounds.width - newWidth));
		const clampedTop = Math.max(bounds.top, Math.min(newTop, bounds.top + bounds.height - newHeight));

		this.selectionRect.set({
			left: clampedLeft,
			top: clampedTop,
			width: Math.max(0, newWidth),
			height: Math.max(0, newHeight),
			strokeWidth: SELECTION_STROKE_WIDTH * invZoom
		});

		this.positionSelectionLabel(clampedLeft, clampedTop, Math.max(0, newWidth), Math.max(0, newHeight), invZoom);

		this.canvas.requestRenderAll();
	}

	setCanvasSize(width: number, height: number) {
		const imageCenter = this.getCurrentViewportImageCenterRatio();
		const textLayerData = this.getAllTextLayers();
		const imageLayerData = this.getAllImageLayers();
		// Use workspace size if available, otherwise use the requested size (capped at MAX)
		const maxWidth = this.containerWidth > 0 ? this.containerWidth : Math.min(width, MangaEditor.MAX_CANVAS_WIDTH);
		this.canvasWidth = maxWidth;
		this.canvasHeight = height;

		this.canvas.setDimensions({ width: this.canvasWidth, height: this.canvasHeight });
		this._updateCanvasWrapperCSS();

		if (this.imageItem) {
			this._centerImage(this.imageItem);
			this.remapLayerObjectsFromImageSpace(textLayerData, imageLayerData);
			if (!this.restoreViewportImageCenterRatio(imageCenter)) {
				this.constrainViewportToImage();
			}
		}

		if (!imageCenter) {
			this._autoFitToWorkspace();
		}
		this.canvas.requestRenderAll();
	}

	setAspectRatio(ratio: [number, number] | null) {
		this.currentAspectRatio = ratio || null;

		// Validate aspect ratio values
		if (ratio) {
			const [rw, rh] = ratio;
			if (rw <= 0 || rh <= 0 || !Number.isFinite(rw) || !Number.isFinite(rh)) {
				console.error("[editor] Invalid aspect ratio:", ratio);
				return;
			}
		}

		// Only adjust existing selection rect, don't change canvas size
		// Aspect ratio is a constraint for NEW selections, not for resizing the canvas
		if (this.selectionRect) {
			this._applyAspectRatioToSelection(ratio);
		}
	}

	setTool(tool: Tool) {
		// P1 stuck-preview fix — a mid-stroke tool-switch must CANCEL the in-progress
		// legacy brush stroke (discard the uncommitted live preview + restore the real
		// layer element); it must NOT silently commit a half-stroke. The mouse:up
		// commit only fires while `tool === "brush"`, so without this an active
		// image-layer brush gesture would leave the layer visibly edited but
		// uncommitted and un-restored. cancelActiveBrushGesture() is idempotent and a
		// no-op when no gesture is active.
		if (this.tool === "brush" && tool !== "brush") {
			this.cancelActiveBrushGesture();
		}
		this.tool = tool;
		this.canvas.selection = tool === "select";
		this.canvas.skipTargetFind = tool === "brush" || tool === "cover";
		this.canvas.defaultCursor =
			tool === "cover"
				? "crosshair"
				: tool === "brush"
					? this.hasEditableBrushTarget() ? "crosshair" : "not-allowed"
					: tool === "text"
						? "text"
						: "default";
		this.applyLayerInteractionState(false);
		this.onToolChange?.(tool);

		// Clear selection when leaving cover tool
		if (tool !== "cover") {
			this.clearCoverSelection();
		}

		// Setup brush mode
		if (tool === "brush") {
			this.canvas.isDrawingMode = false;
			this.canvas.selection = false;
		} else {
			this.canvas.isDrawingMode = false;
			this.hideBrushPreview();
		}
		this.canvas.requestRenderAll();
	}

	/**
	 * W3.13: toggle image-edit suite ownership of the canvas pointer. While active,
	 * Fabric object selection + target-finding are disabled and the cursor becomes
	 * a crosshair so the suite tool (marquee, lasso, magic wand, heal, clone, ...)
	 * receives clean scene-space gestures. Disabling restores the normal "select"
	 * tool state. The suite stays in the "select" engine tool throughout.
	 */
	setImageToolActive(active: boolean): void {
		if (this.imageToolActive === active) return;
		this.imageToolActive = active;
		if (active) {
			this.tool = "select";
			this.canvas.selection = false;
			this.canvas.skipTargetFind = true;
			this.canvas.discardActiveObject?.();
			this.canvas.defaultCursor = "crosshair";
			this.applyLayerInteractionState(false);
			this.hideBrushPreview();
		} else {
			// Restore the standard select-tool canvas state.
			this.setTool("select");
		}
		this.canvas.requestRenderAll();
	}

	setSelectionChromeMuted(muted: boolean): void {
		if (this.selectionChromeMuted === muted) return;
		this.selectionChromeMuted = muted;
		this.applyLayerInteractionState();
	}

	hasAiMaskBrushTarget(): boolean {
		return Boolean(this.legacyAiMaskBrushEnabled && this.aiOverlayImage && this.maskCtx && this.eraserCanvas);
	}

	private hasEditableBrushTarget(): boolean {
		if (this.selectedImageLayerIdForBrush) {
			const selectedImageObject = this.findImageObject(this.selectedImageLayerIdForBrush);
			const layer = selectedImageObject?._imageLayerData as ImageLayer | undefined;
			if (layer && layer.locked !== true && layer.visible !== false && layer.role !== "credit") {
				return true;
			}
		}
		return this.hasAiMaskBrushTarget();
	}

	/**
	 * UX P3 — explain WHY a clean-brush stroke can't run when there is no editable
	 * target, so a click doesn't silently no-op. Distinguishes "selected layer is
	 * locked/hidden/credit" from "no layer chosen yet".
	 */
	private getNoBrushTargetMessage(): string {
		if (this.selectedImageLayerIdForBrush) {
			const selectedImageObject = this.findImageObject(this.selectedImageLayerIdForBrush);
			const layer = selectedImageObject?._imageLayerData as ImageLayer | undefined;
			if (layer) {
				if (layer.locked === true) return "เลเยอร์ถูกล็อก ปลดล็อกก่อนใช้แปรง";
				if (layer.visible === false) return "เลเยอร์ถูกซ่อน เปิดการมองเห็นก่อนใช้แปรง";
				if (layer.role === "credit") return "เลเยอร์เครดิตแก้ด้วยแปรงไม่ได้";
			}
		}
		return "เลือกเลเยอร์รูปที่จะลบก่อนใช้แปรง";
	}

	setLegacyAiMaskBrushEnabled(enabled: boolean): void {
		this.legacyAiMaskBrushEnabled = enabled;
		this.onBrushTargetChange?.();
	}

	setBrushEnabled(enabled: boolean): void {
		this.brushEnabled = enabled;
		if (!enabled) {
			// P1 stuck-preview fix — disabling the brush mid-stroke must CANCEL the
			// in-progress stroke, restoring the real layer element BEFORE clearing
			// imageLayerBrushTarget. Previously this nulled the target directly, leaking
			// the live preview (the visible object stayed swapped to the working canvas,
			// showing an uncommitted erase). cancelActiveBrushGesture() restores the
			// preview and clears isDrawing/brushPath/imageLayerBrushTarget; it is a no-op
			// when no gesture is active.
			this.cancelActiveBrushGesture();
			this.isDrawing = false;
			this.brushPath = [];
			this.imageLayerBrushTarget = null;
			this.hideBrushPreview();
		}
		// The brush cursor (crosshair vs not-allowed) must track the live editable
		// state of the target layer. The right panel changes lock/visibility/role
		// then calls setBrushEnabled via refreshBrushTarget, but without this the
		// canvas cursor stayed stale until the user clicked an object. Re-derive it
		// now while the brush tool is active.
		if (this.tool === "brush") {
			this.canvas.defaultCursor = this.hasEditableBrushTarget() ? "crosshair" : "not-allowed";
			this.canvas.requestRenderAll();
		}
	}

	// --- Long-page (webtoon) guardrails (W3.15) ---

	/**
	 * Set the internal page-boundary cut fractions (0..1) for a stitched long
	 * page. An empty / single-page list means the whole image is one page (the
	 * clip then matches imageBounds, i.e. tools cannot paint off the page edge).
	 * Clamps the active segment into range and re-renders overlay + clip.
	 */
	setPageBoundaries(fractions: readonly number[] | null | undefined): void {
		const next = normalizeBoundaryFractions(fractions);
		const sameLength = next.length === this.pageBoundaryFractions.length;
		const unchanged = sameLength && next.every((value, index) => value === this.pageBoundaryFractions[index]);
		if (!unchanged) {
			this.pageBoundaryFractions = next;
			const maxIndex = pageSegmentCount(next) - 1;
			if (this.activePageSegment > maxIndex) this.activePageSegment = maxIndex;
			this.syncPageGuardrails();
		}
		// Always notify so the store re-validates role/lock-gated multi-page mode
		// for the loaded page even when two pages share identical boundaries — the
		// soft-lock owner can differ between them.
		this.onPageBoundariesChanged?.(pageSegmentCount(this.pageBoundaryFractions));
	}

	/** Bind the per-page tool clip to a specific 0-based page segment. */
	setActivePageSegment(index: number): void {
		const maxIndex = pageSegmentCount(this.pageBoundaryFractions) - 1;
		const safeIndex = Math.max(0, Math.min(maxIndex, Math.round(Number.isFinite(index) ? index : 0)));
		if (safeIndex === this.activePageSegment) return;
		this.activePageSegment = safeIndex;
		this.applyToolClip();
	}

	/**
	 * Toggle cross-page (multi-page) editing. When ON the per-page clip is
	 * removed so a stroke can cross page boundaries. The caller is responsible
	 * for role-gating (Cleaner/Typesetter) + lock ownership before enabling.
	 */
	setMultiPageMode(enabled: boolean): void {
		if (this.multiPageMode === enabled) return;
		this.multiPageMode = enabled;
		this.applyToolClip();
	}

	isMultiPageMode(): boolean {
		return this.multiPageMode;
	}

	getActivePageSegment(): number {
		return this.activePageSegment;
	}

	getPageSegmentCount(): number {
		return pageSegmentCount(this.pageBoundaryFractions);
	}

	/** Scene-space bounds of the segment the per-page clip is bound to. */
	private getActiveSegmentBounds(): PageSegmentBounds | null {
		return computeSegmentBounds(this.imageBounds, this.pageBoundaryFractions, this.activePageSegment);
	}

	/** Rebuild the red boundary overlay and re-apply the active-page clip. */
	private syncPageGuardrails(): void {
		this.renderPageBoundaryOverlay();
		this.applyToolClip();
	}

	/**
	 * Render horizontal semi-transparent RED boundary lines at each page extent.
	 * Lines are non-interactive, excluded from export, and live in scene space so
	 * they pan/zoom with the page. Reuses existing line objects to avoid churn.
	 */
	private renderPageBoundaryOverlay(): void {
		const lines = computePageBoundaryLines(this.imageBounds, this.pageBoundaryFractions);
		// Only draw *internal* cuts as guardrail markers; the bottom image edge is
		// already the page edge and does not need a redundant marker line.
		const cuts = lines.filter((line) => !line.isImageEdge);

		// Drop surplus line objects when the page count shrinks.
		while (this.pageBoundaryLines.length > cuts.length) {
			const obj = this.pageBoundaryLines.pop();
			if (obj) this.canvas.remove(obj);
		}

		if (cuts.length === 0) {
			this.canvas.requestRenderAll();
			return;
		}

		const left = this.imageBounds.left;
		const right = this.imageBounds.left + this.imageBounds.width;
		cuts.forEach((line, index) => {
			let obj = this.pageBoundaryLines[index];
			if (!obj) {
				obj = new this.f.Line([left, line.sceneY, right, line.sceneY], {
					stroke: "rgba(239, 68, 68, 0.55)",
					strokeWidth: 2,
					selectable: false,
					evented: false,
					hoverCursor: "default",
					excludeFromExport: true,
					objectCaching: false,
					strokeUniform: true,
				});
				obj._pageBoundaryLine = true;
				this.canvas.add(obj);
				this.pageBoundaryLines[index] = obj;
			} else {
				obj.set({ x1: left, y1: line.sceneY, x2: right, y2: line.sceneY });
				obj.setCoords?.();
			}
			obj.bringToFront?.();
		});
		this.canvas.requestRenderAll();
	}

	/** True when the per-page tool clip is currently active. */
	private isToolClipActive(): boolean {
		return !this.multiPageMode && this.getPageSegmentCount() > 1;
	}

	/**
	 * Bind a Fabric clipPath to the active page's scene-space bounds so the brush
	 * tool indicator (and any Fabric draw object) is constrained to the current
	 * page. The clip is applied to the *brush preview* object — NOT the whole
	 * canvas — so the rest of the long page image stays visible; the physical
	 * paint guarantee comes from clamping the brush pointer (clipPointerToActivePage)
	 * before it is composited into image space. In multi-page mode (or a single
	 * page) the clip is removed. The clipPath is absolutePositioned scene
	 * coordinates so it tracks pan/zoom correctly.
	 */
	private applyToolClip(): void {
		const segment = this.isToolClipActive() ? this.getActiveSegmentBounds() : null;
		if (!this.brushPreview) return;

		if (!segment || segment.height <= 0 || segment.width <= 0) {
			this.brushPreview.clipPath = undefined;
			this.brushPreview.dirty = true;
			this.canvas.requestRenderAll();
			return;
		}

		this.brushPreview.clipPath = new this.f.Rect({
			left: segment.left,
			top: segment.top,
			width: segment.width,
			height: segment.height,
			absolutePositioned: true,
			selectable: false,
			evented: false,
		});
		this.brushPreview.dirty = true;
		this.canvas.requestRenderAll();
	}

	/** Scene-space brush radius at the current zoom (matches the preview disc). */
	private currentBrushSceneRadius(): number {
		const zoom = this.canvas.getZoom?.() || 1;
		return Math.max(1, this.brushSize / (2 * zoom));
	}

	/**
	 * Bind the per-page clip to whichever sub-page the pointer is over so a user
	 * (including translators/QC who cannot enable multi-page mode) can edit *any*
	 * single logical page — not just segment 0. Editing is still clamped within
	 * the page the stroke started in; only crossing the cut is blocked. No-op in
	 * multi-page mode or on single-page documents.
	 */
	private followActiveSegmentToPointer(pointer: { x: number; y: number }): void {
		if (this.multiPageMode || this.getPageSegmentCount() <= 1) return;
		const index = segmentIndexForSceneY(this.imageBounds, this.pageBoundaryFractions, pointer.y);
		if (index !== this.activePageSegment) this.setActivePageSegment(index);
	}

	/**
	 * Clamp a scene-space brush pointer to the active page segment when the
	 * per-page clip is active. The clamp is *footprint-aware*: the centre is held
	 * back by the brush radius so no painted pixel crosses a horizontal page cut,
	 * and the "tool clipped at page N" toast fires the first time the footprint
	 * reaches a boundary.
	 *
	 * Returns `null` when the pointer is a horizontal off-page miss (its footprint
	 * lies wholly outside the left/right image edge) so the caller drops the
	 * stroke instead of snapping X inward and painting along the edge. In
	 * multi-page mode / single-page documents the point is returned unchanged.
	 */
	private clipPointerToActivePage(pointer: { x: number; y: number }): { x: number; y: number } | null {
		if (this.multiPageMode || this.getPageSegmentCount() <= 1) return pointer;
		const segment = this.getActiveSegmentBounds();
		if (!segment) return pointer;
		const result = clampBrushPointerToSegment(segment, pointer, this.currentBrushSceneRadius());
		if (result.outsideHorizontally) return null;
		if (result.clipped) this.notifyToolClipped(segment.pageNumber);
		return result.point;
	}

	// Debounce the clip toast so a single dragged stroke that repeatedly hits the
	// boundary does not spam one toast per mouse-move event.
	private lastToolClipNotifyAt = 0;
	private notifyToolClipped(pageNumber: number): void {
		const now = Date.now();
		if (now - this.lastToolClipNotifyAt < 1500) return;
		this.lastToolClipNotifyAt = now;
		this.onToolClipped?.(pageNumber, pageClipToastMessage(pageNumber));
	}

	// --- Cover Selection ---

	clearCoverSelection(): void {
		this.coverStart = null;
		if (!this.selectionRect && !this.selectionLabel) return;

		if (this.selectionRect) {
			this.canvas.remove(this.selectionRect);
			this.selectionRect = null;
		}
		if (this.selectionLabel) {
			this.canvas.remove(this.selectionLabel);
			this.selectionLabel = null;
		}
		this.canvas.requestRenderAll();
	}

	private startCoverSelection(pointer: any) {
		if (this.selectionRect) {
			this.clearCoverSelection();
		}

		// Clamp starting position to image bounds
		const b = this.imageBounds;
		const clampedStart = {
			x: Math.max(b.left, Math.min(pointer.x, b.left + b.width)),
			y: Math.max(b.top, Math.min(pointer.y, b.top + b.height))
		};

		this.coverStart = clampedStart;

		const invZoom = 1 / (this.canvas.getZoom() || 1);

		this.selectionRect = new this.f.Rect({
			left: clampedStart.x,
			top: clampedStart.y,
			width: 0,
			height: 0,
			fill: "rgba(56, 189, 248, 0.045)",
			stroke: "rgba(56, 189, 248, 0.78)",
			strokeWidth: SELECTION_STROKE_WIDTH * invZoom,
			strokeDashArray: [6 * invZoom, 7 * invZoom],
			selectable: false,
			evented: false,
		});

		this.selectionLabel = new this.f.Text("", {
			left: clampedStart.x,
			top: clampedStart.y,
			fontSize: SELECTION_LABEL_FONT_SIZE * invZoom,
			fill: "#dff7ff",
			backgroundColor: "rgba(8, 12, 16, 0.7)",
			visible: false,
			selectable: false,
			evented: false,
		});

		this.canvas.add(this.selectionRect);
		this.canvas.add(this.selectionLabel);
	}

	private clampPointToImageBounds(pointer: { x: number; y: number }) {
		const b = this.imageBounds;
		return {
			x: Math.max(b.left, Math.min(pointer.x, b.left + b.width)),
			y: Math.max(b.top, Math.min(pointer.y, b.top + b.height)),
		};
	}

	private getMaxAiCropWidthInCanvasSpace() {
		if (this.imageWidth <= 0 || this.imageBounds.width <= 0) {
			return MangaEditor.MAX_AI_CROP_WIDTH;
		}

		return Math.min(
			this.imageBounds.width,
			(MangaEditor.MAX_AI_CROP_WIDTH / this.imageWidth) * this.imageBounds.width,
		);
	}

	private getMaxAiCropHeightInCanvasSpace() {
		if (this.imageHeight <= 0 || this.imageBounds.height <= 0) {
			return MangaEditor.MAX_AI_CROP_HEIGHT;
		}

		return Math.min(
			this.imageBounds.height,
			(MangaEditor.MAX_AI_CROP_HEIGHT / this.imageHeight) * this.imageBounds.height,
		);
	}

	private updateCoverSelection(pointer: any) {
		if (!this.coverStart || !this.selectionRect || !this.selectionLabel) return;

		const invZoom = 1 / (this.canvas.getZoom() || 1);

		const end = this.clampPointToImageBounds(pointer);
		const dirX = end.x < this.coverStart.x ? -1 : 1;
		const dirY = end.y < this.coverStart.y ? -1 : 1;
		const rawWidth = Math.abs(end.x - this.coverStart.x);
		const rawHeight = Math.abs(end.y - this.coverStart.y);

		// Clamp to image bounds (not canvas — image may be smaller when centered)
		const b = this.imageBounds;

		const availableWidth = dirX > 0 ? b.left + b.width - this.coverStart.x : this.coverStart.x - b.left;
		const availableHeight = dirY > 0 ? b.top + b.height - this.coverStart.y : this.coverStart.y - b.top;
		const maxCropWidth = this.getMaxAiCropWidthInCanvasSpace();
		const maxCropHeight = this.getMaxAiCropHeightInCanvasSpace();

		// Edge clamp only here; the square AI-crop cap is applied PROPORTIONALLY
		// below so a region that exceeds the cap on its tall side keeps its ratio.
		let width = Math.min(rawWidth, availableWidth);
		let height = Math.min(rawHeight, availableHeight);
		let left = dirX > 0 ? this.coverStart.x : this.coverStart.x - width;
		let top = dirY > 0 ? this.coverStart.y : this.coverStart.y - height;

		if (this.currentAspectRatio && width > 0 && height > 0) {
			const [rw, rh] = this.currentAspectRatio;
			if (rw > 0 && rh > 0) {
				const targetRatio = rh / rw;
				const heightFromWidth = Math.min(width * targetRatio, availableHeight);

				if (heightFromWidth <= height + ASPECT_RATIO_TOLERANCE) {
					height = heightFromWidth;
				} else {
					width = Math.min(height / targetRatio, availableWidth);
					height = Math.min(width * targetRatio, availableHeight);
				}

				left = dirX > 0 ? this.coverStart.x : this.coverStart.x - width;
				top = dirY > 0 ? this.coverStart.y : this.coverStart.y - height;
			}
		}

		// Cap to the square AI-crop limit on BOTH axes, preserving aspect ratio so
		// the on-canvas preview matches getCoverCrop() (never squashed).
		const cappedPreview = capCropToMaxDimensions(width, height, maxCropWidth, maxCropHeight);
		if (cappedPreview.width !== width || cappedPreview.height !== height) {
			width = cappedPreview.width;
			height = cappedPreview.height;
			left = dirX > 0 ? this.coverStart.x : this.coverStart.x - width;
			top = dirY > 0 ? this.coverStart.y : this.coverStart.y - height;
		}

		if (width < 1 || height < 1) {
			this.selectionRect.set({ left, top, width: 0, height: 0 });
			this.positionSelectionLabel(left, top, 0, 0, invZoom);
			this.canvas.requestRenderAll();
			return;
		}

		this.selectionRect.set({
			left,
			top,
			width,
			height,
			strokeWidth: SELECTION_STROKE_WIDTH * invZoom,
			strokeDashArray: [6 * invZoom, 7 * invZoom],
		});
		this.positionSelectionLabel(left, top, width, height, invZoom);
		this.canvas.requestRenderAll();
	}

	private finalizeCoverSelection() {
		this.coverStart = null;
		if (!this.selectionRect) return;

		const crop = this.getCoverCrop();
		const w = crop?.w ?? Math.round(this.selectionRect.width || 0);
		const h = crop?.h ?? Math.round(this.selectionRect.height || 0);
		if (this.selectionLabel) {
			const invZoom = 1 / (this.canvas.getZoom() || 1);
			this.positionSelectionLabel(
				this.selectionRect.left || 0,
				this.selectionRect.top || 0,
				this.selectionRect.width || 0,
				this.selectionRect.height || 0,
				invZoom,
				`${w}x${h}`,
			);
		}
		this.canvas.requestRenderAll();
	}

	// Create default cover selection - now just a small placeholder, user will draw the actual selection
	createDefaultCover() {
		// Don't auto-create cover anymore - let user draw it
		// This function is kept for compatibility but does nothing
		return;
	}

	// Return crop coordinates in ORIGINAL IMAGE space
	getCoverCrop(): { x: number; y: number; w: number; h: number } | null {
		if (!this.selectionRect) return null;

		const b = this.imageBounds;
		if (b.width <= 0 || b.height <= 0 || this.imageWidth <= 0 || this.imageHeight <= 0) return null;

		const scaleX = this.imageWidth / b.width;
		const scaleY = this.imageHeight / b.height;
		const rectLeft = this.selectionRect.left || 0;
		const rectTop = this.selectionRect.top || 0;
		const rectWidth = this.selectionRect.width || 0;
		const rectHeight = this.selectionRect.height || 0;
		const left = Math.max(b.left, Math.min(rectLeft, b.left + b.width));
		const top = Math.max(b.top, Math.min(rectTop, b.top + b.height));
		const right = Math.max(left, Math.min(rectLeft + rectWidth, b.left + b.width));
		const bottom = Math.max(top, Math.min(rectTop + rectHeight, b.top + b.height));
		const x = Math.max(0, Math.min(Math.round((left - b.left) * scaleX), this.imageWidth));
		const y = Math.max(0, Math.min(Math.round((top - b.top) * scaleY), this.imageHeight));
		// Region size in original-image pixels, already clamped to the image edges.
		const regionWidth = Math.max(0, Math.min(Math.round((right - left) * scaleX), this.imageWidth - x));
		const regionHeight = Math.max(0, Math.min(Math.round((bottom - top) * scaleY), this.imageHeight - y));
		// Cap to the square AI-crop limit on BOTH axes, preserving aspect ratio so
		// the crop is never squashed when the tall side also exceeds the cap.
		const capped = capCropToMaxDimensions(
			regionWidth,
			regionHeight,
			MangaEditor.MAX_AI_CROP_WIDTH,
			MangaEditor.MAX_AI_CROP_HEIGHT,
		);

		return {
			x,
			y,
			w: Math.max(0, Math.round(capped.width)),
			h: Math.max(0, Math.round(capped.height)),
		};
	}

	// --- Text Layers ---

	private canvasXToImageX(x: number): number {
		const b = this.imageBounds;
		if (b.width <= 0 || this.imageWidth <= 0) return 0;
		return Math.round(((x - b.left) * this.imageWidth) / b.width);
	}

	private canvasYToImageY(y: number): number {
		const b = this.imageBounds;
		if (b.height <= 0 || this.imageHeight <= 0) return 0;
		return Math.round(((y - b.top) * this.imageHeight) / b.height);
	}

	private canvasWToImageW(width: number): number {
		const b = this.imageBounds;
		if (b.width <= 0 || this.imageWidth <= 0) return 0;
		return Math.round((width * this.imageWidth) / b.width);
	}

	private canvasHToImageH(height: number): number {
		const b = this.imageBounds;
		if (b.height <= 0 || this.imageHeight <= 0) return 0;
		return Math.round((height * this.imageHeight) / b.height);
	}

	private imageXToCanvasX(x: number): number {
		const b = this.imageBounds;
		if (this.imageWidth <= 0) return b.left;
		return b.left + (x / this.imageWidth) * b.width;
	}

	private imageYToCanvasY(y: number): number {
		const b = this.imageBounds;
		if (this.imageHeight <= 0) return b.top;
		return b.top + (y / this.imageHeight) * b.height;
	}

	private imageWToCanvasW(width: number): number {
		const b = this.imageBounds;
		if (this.imageWidth <= 0) return width;
		return (width / this.imageWidth) * b.width;
	}

	private imageHToCanvasH(height: number): number {
		const b = this.imageBounds;
		if (this.imageHeight <= 0) return height;
		return (height / this.imageHeight) * b.height;
	}

	private findTextObject(layerId: string): any | null {
		return this.textLayers.find((t) => t._textLayerData?.id === layerId) ?? null;
	}

	private findImageObject(layerId: string): any | null {
		return this.imageLayers.find((item) => item._imageLayerData?.id === layerId) ?? null;
	}

	private applyImageObjectLayerState(imageObject: any, layer: ImageLayer): void {
		const visible = layer.visible !== false;
		const locked = layer.locked === true;
		const blendMode = normalizeImageLayerBlendMode(layer.blendMode);
		const showEditHandles = this.tool !== "brush" && !this.selectionChromeMuted;
		const selectionChrome = getImageLayerSelectionChrome(layer);
		imageObject.set({
			visible,
			selectable: visible,
			evented: visible,
			hasControls: showEditHandles && !locked,
			hasBorders: showEditHandles && visible,
			borderColor: selectionChrome.borderColor,
			cornerColor: selectionChrome.cornerColor,
			cornerStrokeColor: selectionChrome.cornerStrokeColor,
			cornerSize: selectionChrome.cornerSize,
			transparentCorners: false,
			lockMovementX: locked,
			lockMovementY: locked,
			lockScalingX: locked,
			lockScalingY: locked,
			lockRotation: locked,
			hoverCursor: locked ? "default" : selectionChrome.hoverCursor,
			moveCursor: locked ? "default" : selectionChrome.moveCursor,
			globalCompositeOperation: imageLayerBlendModeToCompositeOperation(blendMode),
		});
		imageObject._imageLayerData = {
			...layer,
			visible,
			locked,
			blendMode,
		};
	}

	private clearImageLayerSnapGuides(render = true): void {
		if (!this.canvas || this.imageLayerSnapGuides.length === 0) return;
		for (const guide of this.imageLayerSnapGuides) {
			this.canvas.remove(guide);
		}
		this.imageLayerSnapGuides = [];
		if (render) this.canvas.requestRenderAll();
	}

	private renderImageLayerSnapGuides(guides: ImageLayerSnapGuide[]): void {
		this.clearImageLayerSnapGuides(false);
		if (!this.canvas || guides.length === 0) {
			this.canvas?.requestRenderAll?.();
			return;
		}

		const zoom = Math.max(0.01, this.canvas.getZoom?.() || 1);
		const strokeWidth = Math.max(1, 1.25 / zoom);
		const strokeDashArray = [6 / zoom, 4 / zoom];
		const bounds = this.imageBounds;

		for (const guide of guides) {
			const line = guide.orientation === "vertical"
				? new this.f.Line([
					this.imageXToCanvasX(guide.position),
					bounds.top,
					this.imageXToCanvasX(guide.position),
					bounds.top + bounds.height,
				])
				: new this.f.Line([
					bounds.left,
					this.imageYToCanvasY(guide.position),
					bounds.left + bounds.width,
					this.imageYToCanvasY(guide.position),
				]);
			line.set({
				stroke: IMAGE_LAYER_SNAP_GUIDE_COLOR,
				strokeWidth,
				strokeDashArray,
				selectable: false,
				evented: false,
				excludeFromExport: true,
				objectCaching: false,
			});
			this.imageLayerSnapGuides.push(line);
			this.canvas.add(line);
			line.bringToFront?.();
		}

		this.brushPreview?.bringToFront?.();
		this.canvas.requestRenderAll();
	}

	private applyImageLayerSnapping(target: any): void {
		if (!target?._imageLayerData || target._imageLayerData.locked === true) return;
		if (this.imageWidth <= 0 || this.imageHeight <= 0 || this.imageBounds.width <= 0 || this.imageBounds.height <= 0) return;
		const angle = Math.abs(((target.angle || 0) % 360 + 360) % 360);
		if (angle > 0.001 && Math.abs(angle - 360) > 0.001) {
			this.clearImageLayerSnapGuides();
			return;
		}

		const zoom = Math.max(0.01, this.canvas.getZoom?.() || 1);
		const layer = this.serializeImageObject(target);
		const result = snapImageLayerToImageGuides({
			layer,
			imageWidth: this.imageWidth,
			imageHeight: this.imageHeight,
			thresholdX: this.canvasWToImageW(IMAGE_LAYER_SNAP_SCREEN_THRESHOLD / zoom),
			thresholdY: this.canvasHToImageH(IMAGE_LAYER_SNAP_SCREEN_THRESHOLD / zoom),
		});

		if (result.guides.length === 0) {
			this.clearImageLayerSnapGuides();
			return;
		}

		target.set({
			left: this.imageXToCanvasX(result.x + layer.w / 2),
			top: this.imageYToCanvasY(result.y + layer.h / 2),
		});
		target._imageLayerData = {
			...(target._imageLayerData as ImageLayer),
			x: result.x,
			y: result.y,
		};
		target.setCoords();
		this.renderImageLayerSnapGuides(result.guides);
	}

	private applyTextObjectLayerState(textObject: any, layer: TextLayer): void {
		const visible = layer.visible !== false;
		const locked = layer.locked === true;
		const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
		const showEditHandles = this.tool !== "brush" && !this.selectionChromeMuted;
		const selectionChrome = getTextLayerSelectionChrome(layer);
		textObject.set({
			visible,
			opacity,
			selectable: visible,
			evented: visible,
			editable: visible && !locked,
			hasControls: showEditHandles && !locked,
			hasBorders: showEditHandles && visible,
			borderColor: selectionChrome.borderColor,
			cornerColor: selectionChrome.cornerColor,
			cornerStrokeColor: selectionChrome.cornerStrokeColor,
			cornerSize: selectionChrome.cornerSize,
			transparentCorners: false,
			lockMovementX: locked,
			lockMovementY: locked,
			lockScalingX: locked,
			lockScalingY: locked,
			lockRotation: locked,
			hoverCursor: locked ? "default" : selectionChrome.hoverCursor,
			moveCursor: locked ? "default" : selectionChrome.moveCursor,
		});
		textObject._textLayerData = {
			...layer,
			opacity,
			visible,
			locked,
		};
	}

	private applyLayerInteractionState(render = true): void {
		for (const imageObject of this.imageLayers) {
			if (imageObject._imageLayerData) {
				this.applyImageObjectLayerState(imageObject, imageObject._imageLayerData);
			}
		}
		for (const textObject of this.textLayers) {
			if (textObject._textLayerData) {
				this.applyTextObjectLayerState(textObject, textObject._textLayerData);
			}
		}
		if (this.tool === "brush") {
			this.canvas.defaultCursor = this.hasEditableBrushTarget() ? "crosshair" : "not-allowed";
		}
		if (render) this.canvas.requestRenderAll();
	}

	private applyTextEffectsToObject(textObject: any, layer: TextLayer, effects: TextLayerEffects | null | undefined): TextLayer {
		const baseStrokeWidth = Math.max(0, layer.strokeWidth ?? this.getDefaultTextStrokeWidth(layer.fontSize));
		const effectLayer = {
			...layer,
			effects: effects ?? undefined,
		};
		const resolved = resolveTextLayerEffectStyle(effectLayer, DEFAULT_TEXT_STROKE, baseStrokeWidth);
		const mainShadow = resolved.shadows.length > 1 ? null : resolved.shadow;

		textObject.set({
			stroke: resolved.stroke,
			strokeWidth: this.imageWToCanvasW(resolved.strokeWidth),
			paintFirst: "stroke",
		});

		if (mainShadow) {
			textObject.set({
				shadow: new this.f.Shadow({
					color: mainShadow.color,
					offsetX: this.imageWToCanvasW(mainShadow.offsetX),
					offsetY: this.imageWToCanvasW(mainShadow.offsetY),
					blur: this.imageWToCanvasW(mainShadow.blur),
				}),
			});
		} else {
			textObject.set({ shadow: null });
		}

		const nextLayer = {
			...layer,
			stroke: resolved.stroke,
			strokeWidth: resolved.strokeWidth,
			effects: effects ?? undefined,
		};
		textObject._textLayerData = nextLayer;
		this.syncTextEffectShadowPasses(textObject, nextLayer, resolved);
		return nextLayer;
	}

	private removeTextEffectShadowPasses(layerId: string): void {
		const passes = this.textEffectShadowPasses.get(layerId) ?? [];
		for (const pass of passes) {
			this.canvas.remove(pass);
		}
		this.textEffectShadowPasses.delete(layerId);
	}

	private createTextEffectShadowPass(
		textObject: any,
		layer: TextLayer,
		shadow: ResolvedTextLayerShadow,
		resolved: ResolvedTextLayerEffectStyle,
	): any {
		const TextClass = this.f.Textbox ?? this.f.IText;
		const pass = new TextClass(layer.text || "", {
			left: textObject.left,
			top: textObject.top,
			width: textObject.width,
			height: textObject.height,
			angle: textObject.angle || 0,
			opacity: Math.max(0, Math.min(1, layer.opacity ?? textObject.opacity ?? 1)),
			fontSize: textObject.fontSize,
			charSpacing: textObject.charSpacing ?? layer.charSpacing ?? 0,
			skewX: textObject.skewX ?? layer.skewX ?? 0,
			skewY: textObject.skewY ?? layer.skewY ?? 0,
			fontFamily: textObject.fontFamily || layer.fontFamily || config.defaultFontFamily,
			fill: layer.fill || DEFAULT_TEXT_FILL,
			stroke: resolved.stroke,
			strokeWidth: this.imageWToCanvasW(resolved.strokeWidth),
			paintFirst: "stroke",
			textAlign: textObject.textAlign || layer.alignment,
			lineHeight: textObject.lineHeight || 1.12,
			splitByGrapheme: true,
			originX: "center",
			originY: "center",
			editable: false,
			selectable: false,
			evented: false,
			visible: layer.visible !== false && textObject.visible !== false,
			hasControls: false,
			hasBorders: false,
			excludeFromExport: true,
			shadow: new this.f.Shadow({
				color: shadow.color,
				offsetX: this.imageWToCanvasW(shadow.offsetX),
				offsetY: this.imageWToCanvasW(shadow.offsetY),
				blur: this.imageWToCanvasW(shadow.blur),
			}),
		});
		pass._textEffectPassForLayerId = layer.id;
		return pass;
	}

	private createTextEffectStackPass(
		textObject: any,
		layer: TextLayer,
		passSpec: ResolvedTextLayerPass,
	): any {
		const TextClass = this.f.Textbox ?? this.f.IText;
		const pass = new TextClass(layer.text || "", {
			left: (textObject.left ?? 0) + this.imageWToCanvasW(passSpec.offsetX),
			top: (textObject.top ?? 0) + this.imageWToCanvasW(passSpec.offsetY),
			width: textObject.width,
			height: textObject.height,
			angle: textObject.angle || 0,
			opacity: Math.max(0, Math.min(1, layer.opacity ?? textObject.opacity ?? 1)) * passSpec.opacity,
			fontSize: textObject.fontSize,
			charSpacing: textObject.charSpacing ?? layer.charSpacing ?? 0,
			skewX: textObject.skewX ?? layer.skewX ?? 0,
			skewY: textObject.skewY ?? layer.skewY ?? 0,
			fontFamily: textObject.fontFamily || layer.fontFamily || config.defaultFontFamily,
			fill: passSpec.fill,
			stroke: passSpec.stroke,
			strokeWidth: this.imageWToCanvasW(passSpec.strokeWidth),
			paintFirst: "stroke",
			textAlign: textObject.textAlign || layer.alignment,
			lineHeight: textObject.lineHeight || 1.12,
			splitByGrapheme: true,
			originX: "center",
			originY: "center",
			editable: false,
			selectable: false,
			evented: false,
			visible: layer.visible !== false && textObject.visible !== false,
			hasControls: false,
			hasBorders: false,
			excludeFromExport: true,
		});
		pass._textEffectPassForLayerId = layer.id;
		return pass;
	}

	private syncTextEffectShadowPasses(
		textObject: any,
		layer: TextLayer,
		resolved: ResolvedTextLayerEffectStyle,
	): void {
		this.removeTextEffectShadowPasses(layer.id);
		if (resolved.shadows.length <= 1 && !resolved.passes.length) return;
		const passes = [
			...resolved.passes.map((passSpec) => this.createTextEffectStackPass(textObject, layer, passSpec)),
			...(resolved.shadows.length > 1
				? resolved.shadows.map((shadow) => this.createTextEffectShadowPass(textObject, layer, shadow, resolved))
				: []),
		];
		this.textEffectShadowPasses.set(layer.id, passes);
		const canvasObjects = this.canvas.getObjects?.() ?? [];
		const mainIndex = canvasObjects.indexOf(textObject);
		if (mainIndex < 0) return;
		passes.forEach((pass, index) => {
			this.canvas.insertAt(mainIndex + index, pass);
		});
	}

	private getImageObjectSourceElement(imageObject: any): CanvasImageSource | null {
		return imageObject?.getElement?.() ?? imageObject?._element ?? imageObject?._originalElement ?? null;
	}

	/**
	 * P1 OOM fix — release a Fabric image object's heavy backing buffers so they can
	 * be GC'd, instead of relying on `canvas.remove()` (which only detaches the object
	 * from the canvas — the object, its decoded `_element`/`_originalElement` bitmap,
	 * its render `_cacheCanvas`, and any swapped-in editable `<canvas>` are all still
	 * referenced and accumulate across page switches / clears / layer removals → heap
	 * growth → tab OOM on long sessions).
	 *
	 * For a `<canvas>`-backed element (our editable background-edit / brush canvases),
	 * shrinking it to 0×0 frees the underlying pixel buffer immediately rather than
	 * waiting on GC. We then drop every retained element reference and call Fabric's
	 * own `dispose()` (v6) which releases the object's cache canvas.
	 */
	private disposeFabricImageObject(imageObject: any): void {
		if (!imageObject) return;
		try {
			const els = [imageObject._element, imageObject._originalElement, imageObject._cacheCanvas];
			for (const el of els) {
				// Only zero-out OUR own offscreen <canvas> backings; never touch a shared
				// HTMLImageElement (other code / cache may still reference its decoded src).
				if (el && typeof HTMLCanvasElement !== "undefined" && el instanceof HTMLCanvasElement) {
					el.width = 0;
					el.height = 0;
				}
			}
			imageObject._element = null;
			imageObject._originalElement = null;
			imageObject._cacheCanvas = null;
			imageObject._cacheContext = null;
			// Drop our own restore-baseline reference (image-layer restore brush) so its
			// backing element can be collected with the layer.
			imageObject._imageLayerRestoreElement = null;
			imageObject.dispose?.();
		} catch (e) {
			// Disposal is best-effort cleanup; never let it break a page switch.
			console.warn("[editor] disposeFabricImageObject failed:", e);
		}
	}

	private positionTextObjectFromLayer(textObject: any, layer: TextLayer): void {
		const boxWidth = this.imageWToCanvasW(layer.w);
		const boxHeight = this.imageHToCanvasH(layer.h);
		textObject.set({
			left: this.imageXToCanvasX(layer.x + layer.w / 2),
			top: this.imageYToCanvasY(layer.y + layer.h / 2),
			width: boxWidth,
			height: boxHeight,
			angle: layer.rotation || 0,
			fontSize: this.imageWToCanvasW(layer.fontSize),
			charSpacing: layer.charSpacing ?? 0,
			skewX: layer.skewX ?? 0,
			skewY: layer.skewY ?? 0,
			strokeWidth: this.getTextStrokeWidthInCanvasPixels(layer),
			originX: "center",
			originY: "center",
			scaleX: 1,
			scaleY: 1,
		});
		textObject._textLayerBoxWidth = boxWidth;
		textObject._textLayerBoxHeight = boxHeight;
		this.applyTextObjectLayerState(textObject, layer);
		this.applyTextEffectsToObject(textObject, layer, layer.effects);
		textObject.setCoords?.();
	}

	private positionImageObjectFromLayer(imageObject: any, layer: ImageLayer): void {
		const naturalWidth = Math.max(1, imageObject.width ?? layer.w ?? 1);
		const naturalHeight = Math.max(1, imageObject.height ?? layer.h ?? 1);
		imageObject.set({
			left: this.imageXToCanvasX(layer.x + layer.w / 2),
			top: this.imageYToCanvasY(layer.y + layer.h / 2),
			angle: layer.rotation || 0,
			opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
			originX: "center",
			originY: "center",
		});
		imageObject.scaleX = this.imageWToCanvasW(layer.w) / naturalWidth;
		imageObject.scaleY = this.imageHToCanvasH(layer.h) / naturalHeight;
		this.applyImageObjectLayerState(imageObject, layer);
		imageObject.setCoords?.();
	}

	private remapLayerObjectsFromImageSpace(textLayers: TextLayer[], imageLayers: ImageLayer[]): void {
		if (!textLayers.length && !imageLayers.length) return;
		const activeObject = this.canvas.getActiveObject?.();
		const activeLayerId = activeObject?._textLayerData?.id ?? activeObject?._imageLayerData?.id ?? null;
		const textById = new Map(textLayers.map((layer) => [layer.id, layer]));
		const imageById = new Map(imageLayers.map((layer) => [layer.id, layer]));

		for (const textObject of this.textLayers) {
			const layerId = textObject._textLayerData?.id;
			const layer = layerId ? textById.get(layerId) : null;
			if (layer) this.positionTextObjectFromLayer(textObject, layer);
		}
		for (const imageObject of this.imageLayers) {
			const layerId = imageObject._imageLayerData?.id;
			const layer = layerId ? imageById.get(layerId) : null;
			if (layer) this.positionImageObjectFromLayer(imageObject, layer);
		}
		this.normalizeImageLayerIndexes();
		this.normalizeTextLayerIndexes();
		if (activeLayerId) {
			const nextActiveObject = this.findImageObject(activeLayerId) ?? this.findTextObject(activeLayerId);
			if (nextActiveObject && nextActiveObject.visible !== false) {
				this.canvas.setActiveObject(nextActiveObject);
			}
		}
		this.brushPreview?.bringToFront?.();
		this.emitImageLayersChange();
		this.emitTextLayersChange();
	}

	private normalizeTextLayerIndexes(): void {
		this.textLayers.forEach((textObject, index) => {
			const layer = this.serializeTextObject(textObject);
			textObject._textLayerData = { ...layer, index };
		});
	}

	private normalizeImageLayerIndexes(): void {
		this.imageLayers.forEach((imageObject, index) => {
			const layer = this.serializeImageObject(imageObject);
			imageObject._imageLayerData = { ...layer, index };
		});
	}

	private getLayerObjectStackIndex(object: any, fallback: number): number {
		const layer = object?._imageLayerData ?? object?._textLayerData;
		const zIndex = Number(layer?.zIndex);
		return Number.isFinite(zIndex) ? zIndex : fallback;
	}

	private getNextLayerStackIndex(): number {
		const indexes = [
			...this.imageLayers.map((object, index) => this.getLayerObjectStackIndex(object, index)),
			...this.textLayers.map((object, index) => this.getLayerObjectStackIndex(object, this.imageLayers.length + index)),
		];
		return indexes.length ? Math.max(...indexes) + 1 : 0;
	}

	private assignMissingLayerStackIndex<T extends TextLayer | ImageLayer>(
		layer: T,
		fallback: number,
	): T {
		const zIndex = Number(layer.zIndex);
		return {
			...layer,
			zIndex: Number.isFinite(zIndex) ? zIndex : fallback,
		};
	}

	private getUnifiedLayerStackEntries(): Array<{ kind: "image" | "text"; id: string; object: any; zIndex: number }> {
		return [
			...this.imageLayers.map((object, index) => ({
				kind: "image" as const,
				id: object._imageLayerData?.id ?? "",
				object,
				zIndex: this.getLayerObjectStackIndex(object, index),
			})),
			...this.textLayers.map((object, index) => ({
				kind: "text" as const,
				id: object._textLayerData?.id ?? "",
				object,
				zIndex: this.getLayerObjectStackIndex(object, this.imageLayers.length + index),
			})),
		]
			.filter((entry) => entry.id)
			.sort((a, b) => a.zIndex - b.zIndex || (a.kind === "image" ? -1 : 1));
	}

	private getLayerStackOrder(): MixedLayerStackEntry[] {
		return this.getUnifiedLayerStackEntries().map((entry) => ({
			kind: entry.kind,
			id: entry.id,
		}));
	}

	private isLayerStackOrderEqual(a: MixedLayerStackEntry[], b: MixedLayerStackEntry[]): boolean {
		if (a.length !== b.length) return false;
		return a.every((entry, index) => entry.kind === b[index]?.kind && entry.id === b[index]?.id);
	}

	private normalizeUnifiedLayerStackIndexes(entries = this.getUnifiedLayerStackEntries()): void {
		entries.forEach((entry, zIndex) => {
			if (entry.kind === "image" && entry.object._imageLayerData) {
				entry.object._imageLayerData = {
					...entry.object._imageLayerData,
					zIndex,
				};
			}
			if (entry.kind === "text" && entry.object._textLayerData) {
				entry.object._textLayerData = {
					...entry.object._textLayerData,
					zIndex,
				};
			}
		});
	}

	private swapLayerStackIndexes(first: any, second: any): void {
		const firstLayer = first?._imageLayerData ?? first?._textLayerData;
		const secondLayer = second?._imageLayerData ?? second?._textLayerData;
		if (!firstLayer || !secondLayer) return;
		const firstZIndex = this.getLayerObjectStackIndex(first, 0);
		const secondZIndex = this.getLayerObjectStackIndex(second, firstZIndex + 1);
		if (first._imageLayerData) {
			first._imageLayerData = { ...first._imageLayerData, zIndex: secondZIndex };
		} else if (first._textLayerData) {
			first._textLayerData = { ...first._textLayerData, zIndex: secondZIndex };
		}
		if (second._imageLayerData) {
			second._imageLayerData = { ...second._imageLayerData, zIndex: firstZIndex };
		} else if (second._textLayerData) {
			second._textLayerData = { ...second._textLayerData, zIndex: firstZIndex };
		}
	}

	private applyImageLayerStackOrderFromList(): void {
		const zIndexes = this.imageLayers
			.map((imageObject, index) => this.getLayerObjectStackIndex(imageObject, index))
			.sort((a, b) => a - b);
		this.imageLayers.forEach((imageObject, index) => {
			if (!imageObject._imageLayerData) return;
			imageObject._imageLayerData = {
				...imageObject._imageLayerData,
				zIndex: zIndexes[index] ?? index,
			};
		});
	}

	setLayerStackOrderInternal(
		order: MixedLayerStackEntry[],
		activeKind?: "text" | "image",
		activeLayerId?: string,
	): TextLayer | ImageLayer | null {
		const entries = this.getUnifiedLayerStackEntries();
		const byKey = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
		const used = new Set<string>();
		const orderedEntries: Array<{ kind: "image" | "text"; id: string; object: any; zIndex: number }> = [];

		for (const item of order) {
			const key = `${item.kind}:${item.id}`;
			const entry = byKey.get(key);
			if (!entry || used.has(key)) continue;
			orderedEntries.push(entry);
			used.add(key);
		}
		for (const entry of entries) {
			const key = `${entry.kind}:${entry.id}`;
			if (used.has(key)) continue;
			orderedEntries.push(entry);
		}

		this.normalizeUnifiedLayerStackIndexes(orderedEntries);
		this.syncCanvasLayerOrder(activeLayerId);
		this.canvas.requestRenderAll();
		if (activeKind === "text" && activeLayerId) {
			const textObject = this.findTextObject(activeLayerId);
			if (!textObject) return null;
			const layer = this.syncTextObjectData(textObject);
			this.emitTextLayersChange();
			this.emitImageLayersChange();
			this.onTextLayerSelect?.(layer);
			return layer;
		}
		if (activeKind === "image" && activeLayerId) {
			const imageObject = this.findImageObject(activeLayerId);
			if (!imageObject) return null;
			const layer = this.syncImageObjectData(imageObject);
			this.emitImageLayersChange();
			this.emitTextLayersChange();
			this.onImageLayerSelect?.(layer);
			return layer;
		}
		this.emitTextLayersChange();
		this.emitImageLayersChange();
		return null;
	}

	private syncCanvasLayerOrder(activeLayerId?: string): void {
		for (const passes of this.textEffectShadowPasses.values()) {
			for (const pass of passes) {
				this.canvas.remove(pass);
			}
		}
		for (const imageObject of this.imageLayers) {
			this.canvas.remove(imageObject);
		}
		for (const textObject of this.textLayers) {
			this.canvas.remove(textObject);
		}
		const entries = this.getUnifiedLayerStackEntries();
		this.normalizeUnifiedLayerStackIndexes(entries);
		for (const entry of entries) {
			if (entry.kind === "text") {
				for (const pass of this.textEffectShadowPasses.get(entry.id) ?? []) {
					this.canvas.add(pass);
				}
			}
			this.canvas.add(entry.object);
		}

		const activeObject = activeLayerId
			? this.findImageObject(activeLayerId) ?? this.findTextObject(activeLayerId)
			: null;
		if (activeObject && activeObject.visible !== false) {
			this.canvas.setActiveObject(activeObject);
		}
		this.brushPreview?.bringToFront?.();
	}

	private syncCanvasTextLayerOrder(activeLayerId?: string): void {
		this.syncCanvasLayerOrder(activeLayerId);
	}

	getActiveTextLayer(): TextLayer | null {
		const activeObject = this.canvas.getActiveObject?.();
		if (!activeObject?._textLayerData) return null;
		return this.syncTextObjectData(activeObject);
	}

	getActiveImageLayer(): ImageLayer | null {
		const activeObject = this.canvas.getActiveObject?.();
		if (!activeObject?._imageLayerData) return null;
		return this.syncImageObjectData(activeObject);
	}

	/**
	 * Public, narrow image-space context for the editor tool suite (W3.13).
	 *
	 * Tools (marquee, lasso, magic wand, healing, clone, ...) operate purely in
	 * native image-pixel space and convert through these values to write back
	 * onto the Fabric canvas, preserving the canvas-as-viewport invariant:
	 *  - `imageBounds` is the scene-space rectangle the page image occupies.
	 *  - `imageWidth`/`imageHeight` are the native pixel dimensions.
	 *  - `sourceElement` is the underlying decoded background bitmap.
	 *
	 * Scene → image:  imageX = (sceneX - imageBounds.left) / imageBounds.width  * imageWidth
	 * Image → scene:  sceneX = imageBounds.left + imageX / imageWidth * imageBounds.width
	 */
	getImageSpaceContext(): {
		imageBounds: CanvasImageBounds;
		imageWidth: number;
		imageHeight: number;
		canvas: any;
		fabric: any;
		sourceElement: CanvasImageSource | null;
	} | null {
		if (!this.imageItem || this.imageBounds.width <= 0 || this.imageBounds.height <= 0) return null;
		if (this.imageWidth <= 0 || this.imageHeight <= 0) return null;
		return {
			imageBounds: { ...this.imageBounds },
			imageWidth: this.imageWidth,
			imageHeight: this.imageHeight,
			canvas: this.canvas,
			fabric: this.f,
			// Prefer the live editable backing canvas as the sample source so each
			// instant-apply stroke reads the LATEST composited pixels (including the
			// previous stroke) without any reload. Falls back to the original element
			// before the first instant edit.
			sourceElement: this.backgroundEditCanvas ?? this.getImageObjectSourceElement(this.imageItem),
		};
	}

	private hasVisibleComposableImageEditLayers(): boolean {
		return this.imageEditLayers.some((layer) => {
			if (layer.visible === false) return false;
			const type = layer.payload?.type;
			return type === "fill-mask" || type === "patch" || type === "healing" || type === "clone";
		});
	}

	/**
	 * Read the same native page-background pixels the user sees under image/text
	 * layers: base page bitmap plus the current non-destructive edit-layer composite.
	 * Adjustments must sample this surface; sampling only sourceElement would adjust
	 * the old base pixels and record a patch that hides lower clean/edit layers.
	 */
	readCompositedImageRegion(region: { x: number; y: number; width: number; height: number }): ImageData | null {
		if (!this.imageItem || this.imageWidth <= 0 || this.imageHeight <= 0) return null;
		if (typeof document === "undefined") return null;
		const x = Math.max(0, Math.min(Math.round(region.x), this.imageWidth));
		const y = Math.max(0, Math.min(Math.round(region.y), this.imageHeight));
		const w = Math.max(0, Math.min(Math.round(region.width), this.imageWidth - x));
		const h = Math.max(0, Math.min(Math.round(region.height), this.imageHeight - y));
		if (w <= 0 || h <= 0) return null;
		const source = this.backgroundEditCanvas ?? this.getImageObjectSourceElement(this.imageItem);
		if (!source) return null;
		const needsEditComposite = this.hasVisibleComposableImageEditLayers();
		// Fail closed BOTH when the composite has never landed AND when a rebuild
		// for a newer stack state is still in flight — the published canvas would
		// be the PREVIOUS stack (visibility/delete/undo just changed a layer) and
		// sampling it records a patch that reintroduces/hides that edit (codex P2).
		if (needsEditComposite && !this.editCompositeCanvas) return null;
		if (needsEditComposite && this.editCompositePublishedGeneration !== this.editStackGeneration) return null;
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		try {
			ctx.drawImage(source as CanvasImageSource, -x, -y, this.imageWidth, this.imageHeight);
			if (needsEditComposite && this.editCompositeCanvas) {
				ctx.drawImage(this.editCompositeCanvas, -x, -y, this.imageWidth, this.imageHeight);
			}
			return ctx.getImageData(0, 0, w, h);
		} catch (e) {
			console.error("[editor] readCompositedImageRegion: composite read failed:", e);
			return null;
		}
	}

	/**
	 * Ensure the page background Fabric image is backed by a MUTABLE <canvas>
	 * (native pixel resolution) we can draw onto in place. Idempotent: once
	 * promoted, the same canvas is reused for every subsequent stroke, so the live
	 * on-screen bitmap is the single source of truth for image-tool edits.
	 *
	 * Returns the 2D context, or null if no page image / no canvas support.
	 */
	private ensureBackgroundEditCanvas(): CanvasRenderingContext2D | null {
		if (!this.imageItem || this.imageWidth <= 0 || this.imageHeight <= 0) return null;
		const currentEl = this.getImageObjectSourceElement(this.imageItem);
		// Already promoted and still attached to the image → reuse.
		if (this.backgroundEditCanvas && currentEl === this.backgroundEditCanvas && this.backgroundEditCtx) {
			return this.backgroundEditCtx;
		}
		const canvas =
			typeof document !== "undefined"
				? document.createElement("canvas")
				: (null as unknown as HTMLCanvasElement);
		if (!canvas) return null;
		canvas.width = this.imageWidth;
		canvas.height = this.imageHeight;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		// Seed the backing canvas with the current background pixels so the first
		// stroke composites on top of the real artwork, not a blank canvas.
		if (currentEl) {
			try {
				ctx.drawImage(currentEl as CanvasImageSource, 0, 0, this.imageWidth, this.imageHeight);
			} catch (e) {
				console.error("[editor] ensureBackgroundEditCanvas: seed drawImage failed:", e);
			}
		}
		this.backgroundEditCanvas = canvas;
		this.backgroundEditCtx = ctx;
		// Swap the Fabric image element to our editable canvas. With
		// objectCaching:false (LOCKED_PAGE_IMAGE_OPTIONS) Fabric redraws from this
		// element directly each render, so future mutations show on requestRenderAll.
		try {
			if (typeof this.imageItem.setElement === "function") {
				this.imageItem.setElement(canvas);
			} else {
				this.imageItem._element = canvas;
				this.imageItem._originalElement = canvas;
			}
			this.imageItem.set?.(LOCKED_PAGE_IMAGE_OPTIONS);
			this.imageItem.dirty = true;
		} catch (e) {
			console.error("[editor] ensureBackgroundEditCanvas: setElement failed:", e);
		}
		// NOTE: we deliberately do NOT touch `originalImageCache` here — that field is
		// the AI-clean brush's "restore baseline" with its own semantics. The export
		// path reads `currentImageUrl` (set by the debounced persist) and the canvas
		// already shows the edited pixels, so nothing else needs this element.
		return ctx;
	}

	/**
	 * INSTANT-APPLY (Photopea-style) — paint an editor tool's result region
	 * straight onto the live background bitmap so the user sees it IMMEDIATELY,
	 * with NO image reload and NO per-stroke server round-trip.
	 *
	 * `patch` holds the healed/cloned RGBA pixels for the affected region only
	 * (bounding box + margin), and `region` is its top-left in native image pixels.
	 * We composite it onto the editable backing canvas and re-render. A single
	 * debounced persist (scheduleBackgroundPersist) later snapshots the canvas and
	 * uploads it in the background — it never blocks the next stroke.
	 *
	 * Ordering is naturally correct WITHOUT a per-stroke serialization gate: every
	 * stroke mutates the one live canvas synchronously and in order on the main
	 * thread, and the debounced persist always snapshots the CURRENT canvas (the
	 * full composited state), so a later stroke can never be overwritten by an
	 * earlier, slower persist — there are no per-stroke deltas to reorder.
	 *
	 * Returns true if the patch was applied (so the tool knows the instant path ran).
	 */
	applyToolPatchInstant(
		patch: ImageData,
		region: { x: number; y: number; width: number; height: number },
		expectedEpoch?: number,
		options?: { preview?: boolean; skipSnapshot?: boolean },
	): boolean {
		// PR #264 worker-race guard. When a tool ran an off-thread solve (heal
		// worker) it captured the backing-canvas epoch BEFORE awaiting. If the page
		// switched / image reloaded / editor was destroyed while the worker ran the
		// epoch has advanced — DISCARD this stale patch rather than composite the
		// previous page's ROI onto the now-current page (the wrong-page corruption /
		// data-loss this fix closes). Re-checked HERE (not just in the tool) so the
		// check + putImageData are atomic on the main thread — no TOCTOU window.
		if (expectedEpoch !== undefined && expectedEpoch !== this.imageEpoch) {
			return false;
		}
		const ctx = this.ensureBackgroundEditCanvas();
		if (!ctx) return false;
		const x = Math.max(0, Math.min(Math.round(region.x), this.imageWidth));
		const y = Math.max(0, Math.min(Math.round(region.y), this.imageHeight));
		// P1-1 desync guard — a PREVIEW paint for a non-destructive edit must be reversible
		// on the backing canvas: snapshot the ORIGINAL ROI pixels BEFORE we overwrite them so
		// a successful edit-layer commit can restore them (leaving only the overlay to render
		// the edit). The revert paths in the tools repaint the original ROI themselves (also
		// preview:true), so we only capture the FIRST preview of a stroke — a subsequent
		// preview (e.g. a revert) must not clobber the captured original. Cleared on restore /
		// on any non-preview (destructive) apply / on stroke-before reset.
		const w = Math.max(0, Math.min(Math.round(region.width), this.imageWidth - x));
		const h = Math.max(0, Math.min(Math.round(region.height), this.imageHeight - y));
		if (options?.preview && !options.skipSnapshot && !this.previewRoiOriginal && w > 0 && h > 0) {
			try {
				this.previewRoiOriginal = { region: { x, y, width: w, height: h }, pixels: ctx.getImageData(x, y, w, h) };
			} catch (e) {
				console.error("[editor] applyToolPatchInstant: ROI snapshot failed:", e);
				this.previewRoiOriginal = null;
			}
		}
		try {
			ctx.putImageData(patch, x, y);
		} catch (e) {
			console.error("[editor] applyToolPatchInstant: putImageData failed:", e);
			return false;
		}
		if (this.imageItem) this.imageItem.dirty = true;
		this.canvas.requestRenderAll();
		// PHASE A non-destructive preview — a `preview` paint shows the ROI immediately
		// but must NOT bake a new page PNG (the edit-layer path is the durable store).
		// Skip the legacy full-image background persist for it.
		if (!options?.preview) {
			// Destructive instant apply — the backing canvas IS the durable store for this
			// edit (legacy path), so there is no overlay to restore against; drop any pending
			// preview snapshot so it can't later revert a now-committed destructive edit.
			this.previewRoiOriginal = null;
			this.scheduleBackgroundPersist();
		}
		return true;
	}

	/**
	 * P1-1 desync fix — after a non-destructive edit layer (overlay) has been DURABLY
	 * committed, restore the backing-canvas ROI to the ORIGINAL pixels snapshotted by the
	 * transient preview paint, so the edit is rendered ONLY by the overlay (not also baked
	 * into the mutable background). This makes undo (remove overlay) return the page to a
	 * pristine state and redo (re-add overlay) re-show the edit, with no phantom pixels.
	 * No-op when there is no snapshot (e.g. host without a backing canvas / test stub).
	 */
	private restorePreviewRoiToOriginal(): void {
		const snap = this.previewRoiOriginal;
		this.previewRoiOriginal = null;
		if (!snap || !this.backgroundEditCtx) return;
		try {
			this.backgroundEditCtx.putImageData(snap.pixels, snap.region.x, snap.region.y);
			if (this.imageItem) this.imageItem.dirty = true;
			this.canvas.requestRenderAll?.();
		} catch (e) {
			console.error("[editor] restorePreviewRoiToOriginal: putImageData failed:", e);
		}
	}

	/**
	 * HISTORY-BOUNDARY (#367 P1) — flush the pending instant-apply background edit
	 * NOW (encode + persist + push its BrushBackgroundCommand) and resolve when done.
	 *
	 * A DISCRETE click op (bubble-clean) is NOT a continuous stroke, so it must not
	 * share the debounce coalescing that merges rapid brush/heal/clone patches into
	 * ONE command. After such a tool applies its patch via applyToolPatchInstant it
	 * AWAITS this, closing the edit into its own command before the next click. The
	 * next click's scheduleBackgroundPersist() then captures `before = currentImageUrl`
	 * (this click's persisted result), so N rapid clicks → N independent undo steps
	 * in reverse order. Continuous-stroke tools never call this and keep coalescing.
	 *
	 * Awaiting is what serialises rapid clicks: each click's persist (which advances
	 * currentImageUrl + resets the stroke-before snapshot) fully settles before the
	 * next click arms a fresh debounce, so the per-click before→after pairs never
	 * overlap. Reuses flushPendingBackgroundPersist — no parallel persist path.
	 */
	async commitInstantPatchNow(): Promise<void> {
		await this.flushPendingBackgroundPersist();
	}

	/**
	 * NAV/TEARDOWN DRAIN (#367 P1) — make a DISCRETE instant-apply op (e.g.
	 * bubble-clean) that runs asynchronously OUTSIDE the registry's `onPointerUp`
	 * commit gate VISIBLE to the same drain navigation/teardown awaits.
	 *
	 * A click-tool whose work is kicked off from `onPointerDown` (fire-and-forget,
	 * returns void) is NOT tracked by the registry's `commitInFlight` (that only
	 * wraps the promise RETURNED from `onPointerUp`). Until such a tool reaches
	 * `applyToolPatchInstant` → `scheduleBackgroundPersist()` (which arms the
	 * persist gate in `pendingBrushCommits`), there is a window where the op is
	 * queued / mid-flush but NOTHING in `pendingBrushCommits` /
	 * `hasPendingBrushCommit()` reflects it. A page-switch / project-load /
	 * teardown in that window would NOT wait → the queued read+paint+commit can
	 * land against the WRONG page (the #248/#255/#358 wrong-page class of bug).
	 *
	 * The tool calls this SYNCHRONOUSLY from `onPointerDown` with the promise that
	 * represents its full queued+in-flight op (its click-serialization chain tail).
	 * We enroll that promise in `pendingBrushCommits` for its whole lifetime, so
	 * `waitForPendingBrushCommit()` (page nav / project-close / sign-out teardown)
	 * AWAITS it before advancing `currentPage` / loading a new image. The op then
	 * either completes against the page it was started on, or — if the page already
	 * advanced (epoch bumped) — its `applyToolPatchInstant` discards the stale patch
	 * (PR #264 epoch guard) so no bubble pixels are committed onto the new page.
	 *
	 * The promise MUST NOT reject (the tool swallows its own errors); we still
	 * guard with a no-op catch so a stray rejection can never wedge the drain. The
	 * brush/heal/clone drains are untouched — this only ADDS a tracked promise.
	 */
	trackInstantToolCommit(pending: Promise<void>): void {
		const tracked = pending.catch(() => {});
		this.pendingBrushCommits.add(tracked);
		void tracked.finally(() => {
			this.pendingBrushCommits.delete(tracked);
		});
	}

	/**
	 * NON-DESTRUCTIVE edits (Phase A) — feed the current page's `imageEditLayers`
	 * stack + the ORIGINAL source image id the edits composite over. Called by the
	 * store on every page load (after the background image is in place) so the
	 * edit-composite cache is rebuilt from the saved stack — the clean survives reload
	 * without a baked page PNG. Passing `[]` clears the overlay.
	 */
	setImageEditLayers(layers: ImageEditLayer[] | undefined, sourceImageId: string | null): void {
		this.imageEditLayers = Array.isArray(layers) ? layers.map((layer) => ({ ...layer })) : [];
		this.editLayersSourceImageId = sourceImageId;
		void this.rebuildEditComposite();
		// Phase C — mirror the loaded stack into the reactive store (load, not edit: no
		// persist / no unsaved flag).
		this.onImageEditLayersLoad?.(this.getImageEditLayers());
	}

	/** The current page's recorded edit layers (so the store can persist them). */
	getImageEditLayers(): ImageEditLayer[] {
		return this.imageEditLayers.map((layer) => ({ ...layer }));
	}

	/** Resolve a project image/asset id to its URL via the wired resolver (or null). */
	resolveProjectImageUrl(imageId: string): string | null {
		return this.projectImageUrlResolver?.(imageId) ?? null;
	}

	/**
	 * Rebuild the native edit-stack composite cache from `this.imageEditLayers` and
	 * (re)anchor it as a Fabric overlay over the page background. For a `fill-mask`
	 * layer we fetch its tiny alpha-mask asset, then paint the solid `fill` clipped by
	 * the mask alpha at the layer's bbox. The overlay sits directly ABOVE the page
	 * background image and BELOW image/text layers. No edit layers => the overlay is
	 * removed (byte-identical to a page with none).
	 */
	private async rebuildEditComposite(): Promise<void> {
		// P1-2 same-page stale-rebuild guard — bump the per-edit-stack token on EVERY
		// rebuild request and capture it here. After every await (and before attach) we
		// bail if a newer rebuild has bumped it past ours, so an older in-flight rebuild
		// (e.g. for stack [a]) can never attach over a newer one (for [a,b]) that already
		// landed. The newest request always owns the latest token, so the legit latest
		// rebuild always runs to completion.
		const stackEpoch = ++this.editStackGeneration;
		if (this.imageWidth <= 0 || this.imageHeight <= 0) return;
		// P1-1 stale-rebuild guard — a rebuild awaits per-layer asset loads in a loop;
		// the page (and source image) it composites for can be swapped out from under it
		// by a page switch (loadImage bumps `imageLoadGeneration`) or by re-feeding a
		// different page's stack (setImageEditLayers changes `editLayersSourceImageId`).
		// We snapshot BOTH at the start and bail before any paint/attach if either has
		// moved on, so page A's late composite can never attach over page B.
		const epoch = this.imageLoadGeneration;
		const sourceImageId = this.editLayersSourceImageId;
		const isStale = () =>
			this.imageLoadGeneration !== epoch ||
			this.editLayersSourceImageId !== sourceImageId ||
			this.editStackGeneration !== stackEpoch;
		// Phase A composites `fill-mask`; Phase B adds `patch`/`healing`/`clone`, which
		// store a REALIZED RGBA ROI asset painted at bbox. Any other kind is ignored.
		const isComposable = (layer: ImageEditLayer): boolean => {
			const t = layer.payload?.type;
			return t === "fill-mask" || t === "patch" || t === "healing" || t === "clone";
		};
		const layers = [...this.imageEditLayers]
			.filter((layer) => layer.visible !== false && isComposable(layer))
			.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		if (layers.length === 0) {
			// Only the CURRENT page may clear its overlay — a stale rebuild for an old
			// page must not wipe the new page's composite.
			if (!isStale()) this.removeEditComposite();
			return;
		}
		if (typeof document === "undefined") return;
		// P1-3 stale-paint guard — paint into a PRIVATE/LOCAL offscreen canvas allocated
		// fresh per rebuild. We must NOT publish (assign to this.editCompositeCanvas) or
		// reuse the already-attached canvas before/during the async per-layer paint loop:
		// the editStackGeneration token stops a stale rebuild's final attach, but a stale
		// rebuild that PAINTED into the shared published canvas would still corrupt the
		// pixels a newer rebuild already attached (older [a,b] rebuild resuming inside
		// paintFillMaskLayer after the newer [a] rebuild attached the same canvas). By
		// keeping the canvas local until the final isStale() check passes, a stale rebuild
		// only ever mutates its own throwaway canvas and then discards it — the latest
		// rebuild deterministically owns the rendered/attached pixels.
		const localCanvas = document.createElement("canvas");
		localCanvas.width = this.imageWidth;
		localCanvas.height = this.imageHeight;
		const ctx = localCanvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;
		ctx.clearRect(0, 0, this.imageWidth, this.imageHeight);
		for (const layer of layers) {
			// Bail early if the page switched mid-loop — don't keep loading assets for a
			// page that's no longer current. The local canvas is simply dropped (GC'd).
			if (isStale()) return;
			try {
				if (layer.payload?.type === "fill-mask") {
					await this.paintFillMaskLayer(ctx, layer);
				} else {
					// patch / healing / clone — composite the REALIZED RGBA ROI asset at bbox.
					await this.paintRealizedPatchLayer(ctx, layer);
				}
			} catch (e) {
				console.error("[editor] rebuildEditComposite: paint edit layer failed:", e);
			}
		}
		// Final guard — a switch (or newer rebuild) may have landed during the LAST await;
		// never publish/attach a stale composite over the now-current page. The local
		// canvas is discarded here without ever touching the published one.
		if (isStale()) return;
		// Publish ONLY now, immediately before attach, after the final isStale() check.
		// The previously published canvas (if any) is dropped here and GC'd; the Fabric
		// overlay re-points to the new element inside attachEditCompositeOverlay().
		this.editCompositeCanvas = localCanvas;
		this.editCompositeCtx = ctx;
		this.editCompositePublishedGeneration = stackEpoch;
		this.attachEditCompositeOverlay();
	}

	/**
	 * Paint one Phase-B realized-patch edit layer (`patch`/`healing`/`clone`) onto the
	 * native edit-composite cache. The realized ROI is a small RGBA PNG asset
	 * (`patchAssetId` for `patch`, `realizedPatchAssetId` for `healing`/`clone`);
	 * we draw it verbatim at the layer bbox (the alpha already carries the brush
	 * coverage), so the live composite matches the frontend + backend export exactly.
	 */
	private async paintRealizedPatchLayer(ctx: CanvasRenderingContext2D, layer: ImageEditLayer): Promise<void> {
		const payload = layer.payload;
		const patchAssetId =
			payload.type === "patch"
				? payload.patchAssetId
				: payload.type === "healing" || payload.type === "clone"
					? payload.realizedPatchAssetId
					: undefined;
		if (!patchAssetId) return;
		const bbox = layer.bbox;
		const w = Math.max(0, Math.round(bbox.w));
		const h = Math.max(0, Math.round(bbox.h));
		if (w <= 0 || h <= 0) return;
		const patchUrl = this.projectImageUrlResolver?.(patchAssetId);
		if (!patchUrl) return;
		const patchImg = await this.loadFabricImage(patchUrl, { crossOrigin: "anonymous" });
		const patchEl = this.getImageObjectSourceElement(patchImg) ?? patchImg.getElement?.();
		if (!patchEl) {
			this.disposeFabricImageObject(patchImg);
			return;
		}
		ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1));
		ctx.drawImage(patchEl as CanvasImageSource, Math.round(bbox.x), Math.round(bbox.y), w, h);
		ctx.globalAlpha = 1;
		this.disposeFabricImageObject(patchImg);
	}

	/** Paint one fill-mask edit layer onto the native edit-composite cache context. */
	private async paintFillMaskLayer(ctx: CanvasRenderingContext2D, layer: ImageEditLayer): Promise<void> {
		const payload = layer.payload;
		if (payload.type !== "fill-mask") return;
		const bbox = layer.bbox;
		const w = Math.max(0, Math.round(bbox.w));
		const h = Math.max(0, Math.round(bbox.h));
		if (w <= 0 || h <= 0) return;
		const maskUrl = this.projectImageUrlResolver?.(payload.maskAssetId);
		if (!maskUrl) return;
		const maskImg = await this.loadFabricImage(maskUrl, { crossOrigin: "anonymous" });
		const maskEl = this.getImageObjectSourceElement(maskImg) ?? maskImg.getElement?.();
		// Read the mask alpha into an offscreen ROI, then build a fill RGBA clipped by it.
		const roi = document.createElement("canvas");
		roi.width = w;
		roi.height = h;
		const roiCtx = roi.getContext("2d", { willReadFrequently: true });
		if (!roiCtx || !maskEl) {
			this.disposeFabricImageObject(maskImg);
			return;
		}
		roiCtx.drawImage(maskEl as CanvasImageSource, 0, 0, w, h);
		const maskData = roiCtx.getImageData(0, 0, w, h);
		const out = roiCtx.createImageData(w, h);
		const md = maskData.data;
		const od = out.data;
		const { r, g, b } = payload.fill;
		for (let i = 0; i < w * h; i++) {
			const o = i * 4;
			// Mask is alpha-encoded (png-alpha): use the alpha channel as the coverage.
			const alpha = md[o + 3];
			od[o] = r;
			od[o + 1] = g;
			od[o + 2] = b;
			od[o + 3] = alpha;
		}
		roiCtx.putImageData(out, 0, 0);
		ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1));
		ctx.drawImage(roi, Math.round(bbox.x), Math.round(bbox.y));
		ctx.globalAlpha = 1;
		this.disposeFabricImageObject(maskImg);
	}

	/** Attach / re-anchor the edit-composite overlay Fabric image to imageBounds. */
	private attachEditCompositeOverlay(): void {
		if (!this.editCompositeCanvas || !this.imageItem) return;
		const b = this.imageBounds;
		if (b.width <= 0 || b.height <= 0) return;
		if (!this.editCompositeImage) {
			this.editCompositeImage = new this.f.FabricImage(this.editCompositeCanvas, {
				...LOCKED_PAGE_IMAGE_OPTIONS,
				originX: "left",
				originY: "top",
			});
			// Tag so the page-background finders (which match `type === "image"`) skip the
			// non-destructive edit overlay and only ever pick the real background image.
			this.editCompositeImage._isEditComposite = true;
			this.canvas.add(this.editCompositeImage);
		} else if (typeof this.editCompositeImage.setElement === "function") {
			this.editCompositeImage.setElement(this.editCompositeCanvas);
		}
		this.editCompositeImage.set({
			left: b.left,
			top: b.top,
			scaleX: this.imageWidth > 0 ? b.width / this.imageWidth : 1,
			scaleY: this.imageHeight > 0 ? b.height / this.imageHeight : 1,
		});
		this.editCompositeImage.dirty = true;
		this.editCompositeImage.setCoords?.();
		// Keep the overlay directly above the page background, below image/text layers.
		const bgIndex = this.canvas.getObjects?.().indexOf?.(this.imageItem);
		if (typeof bgIndex === "number" && bgIndex >= 0) {
			this.canvas.moveObjectTo?.(this.editCompositeImage, bgIndex + 1);
		}
		this.canvas.requestRenderAll();
	}

	private removeEditComposite(): void {
		if (this.editCompositeImage) {
			try { this.canvas.remove(this.editCompositeImage); } catch { /* ignore */ }
			this.disposeFabricImageObject(this.editCompositeImage);
			this.editCompositeImage = null;
		}
		this.editCompositeCanvas = null;
		this.editCompositeCtx = null;
		this.canvas.requestRenderAll?.();
	}

	/**
	 * NON-DESTRUCTIVE edit commit (Phase A) — record a tool's result as an
	 * `ImageEditLayer` instead of baking a new page PNG. Encodes the alpha-only ROI
	 * mask to a tiny PNG, hands it to the store (which uploads it as an
	 * `image-edit-mask` asset + appends a fill-mask layer to `page.imageEditLayers`),
	 * then repaints the edit-composite cache so the clean is durable across reload.
	 * Returns true once the layer is recorded. No-op (returns false) without store
	 * wiring or a usable source image id (test stubs then take the legacy path).
	 */
	async commitImageEditLayer(input: {
		mask: Uint8ClampedArray;
		region: { x: number; y: number; width: number; height: number };
		fill: { r: number; g: number; b: number; a: number };
		tool: { id: "bubble-clean"; params?: Record<string, unknown> };
	}): Promise<boolean> {
		if (typeof this.onCommitImageEditLayer !== "function") return false;
		const sourceImageId = this.editLayersSourceImageId;
		if (!sourceImageId) return false;
		const { region, fill, tool } = input;
		const w = Math.max(1, Math.round(region.width));
		const h = Math.max(1, Math.round(region.height));
		if (typeof document === "undefined") return false;
		// Encode the alpha-only ROI mask as a tiny PNG (single-channel coverage in the
		// alpha channel — the maskEncoding "png-alpha" the compositor reads back).
		const maskCanvas = document.createElement("canvas");
		maskCanvas.width = w;
		maskCanvas.height = h;
		const maskCtx = maskCanvas.getContext("2d");
		if (!maskCtx) return false;
		const maskImageData = maskCtx.createImageData(w, h);
		const d = maskImageData.data;
		for (let i = 0; i < w * h; i++) {
			const o = i * 4;
			const a = input.mask[i] ?? 0;
			d[o] = 0;
			d[o + 1] = 0;
			d[o + 2] = 0;
			d[o + 3] = a; // coverage in alpha
		}
		maskCtx.putImageData(maskImageData, 0, 0);
		const maskBlob = await new Promise<Blob | null>((resolve) => {
			if (typeof maskCanvas.toBlob === "function") maskCanvas.toBlob((blob) => resolve(blob), "image/png");
			else resolve(null);
		});
		if (!maskBlob) return false;
		const recorded = await this.onCommitImageEditLayer({
			maskPng: maskBlob,
			region: { x: Math.round(region.x), y: Math.round(region.y), width: w, height: h },
			fill,
			sourceImageId,
			tool,
		});
		if (!recorded) {
			// Commit failed — the tool reverts its own preview to the original ROI; drop
			// the stale snapshot so the NEXT clean captures a fresh original.
			this.previewRoiOriginal = null;
			return false;
		}
		// Append + repaint the edit-composite cache so the clean is durable (the ROI
		// preview painted earlier was transient).
		this.imageEditLayers = [...this.imageEditLayers, recorded];
		await this.rebuildEditComposite();
		// P1-1 — un-bake the transient ROI preview from the mutable backing canvas so the
		// clean renders ONLY via the overlay (not drawn twice / left as a phantom).
		this.restorePreviewRoiToOriginal();
		return true;
	}

	/**
	 * NON-DESTRUCTIVE edit commit (Phase B) — record a brush/healing/clone stroke as a
	 * realized-patch `ImageEditLayer` (patch / healing / clone) INSTEAD of baking a full
	 * new page PNG. The tool supplies the realized RGBA ROI (and, for healing/clone, the
	 * stroke mask) as canvases; we encode tiny PNGs, hand them to the store (which uploads
	 * the small assets + builds the typed payload + appends to `page.imageEditLayers`),
	 * push ONE undoable {@link ImageEditLayerCommand} for the whole stroke, then repaint
	 * the edit-composite cache. Returns true once recorded; false (no-op) without store
	 * wiring / a source image id (test stubs then take the legacy full-bitmap path).
	 *
	 * One continuous stroke produces ONE layer here (the tools commit once on pointer-up),
	 * so the coalescing-into-one-undo-step invariant holds.
	 */
	async commitImageEditLayerPatch(input: {
		kind: "patch" | "healing" | "clone";
		/** Realized ROI RGBA pixels at region size. */
		patch: ImageData;
		/** Optional alpha-only stroke mask (full-image single channel) for healing/clone. */
		mask?: Uint8ClampedArray;
		region: { x: number; y: number; width: number; height: number };
		tool: { id: "brush" | "healing-brush" | "clone-stamp" | "background-edit"; params?: Record<string, unknown> };
		algorithm?: "telea";
		algorithmVersion?: string;
		sourceBbox?: { x: number; y: number; w: number; h: number };
		offset?: { dx: number; dy: number };
	}): Promise<boolean> {
		if (typeof this.onCommitImageEditLayerPatch !== "function") return false;
		const sourceImageId = this.editLayersSourceImageId;
		if (!sourceImageId) return false;
		if (typeof document === "undefined") return false;
		const { region } = input;
		const w = Math.max(1, Math.round(region.width));
		const h = Math.max(1, Math.round(region.height));

		// Encode the realized ROI (the painted/healed/cloned pixels) as an RGBA PNG.
		const patchBlob = await this.encodeImageDataToPng(input.patch, w, h);
		if (!patchBlob) return false;

		// Optional alpha-only stroke mask (healing/clone provenance) cropped to the ROI.
		let maskBlob: Blob | undefined;
		if (input.mask && (input.kind === "healing" || input.kind === "clone")) {
			maskBlob = (await this.encodeMaskRoiToPng(input.mask, region, w, h)) ?? undefined;
		}

		const recorded = await this.onCommitImageEditLayerPatch({
			kind: input.kind,
			patchPng: patchBlob,
			maskPng: maskBlob,
			region: { x: Math.round(region.x), y: Math.round(region.y), width: w, height: h },
			tool: input.tool,
			algorithm: input.algorithm,
			algorithmVersion: input.algorithmVersion,
			sourceBbox: input.sourceBbox,
			offset: input.offset,
		});
		if (!recorded) {
			// Commit failed — the tool reverts its own preview to the original ROI; drop the
			// stale snapshot so the NEXT stroke captures a fresh original.
			this.previewRoiOriginal = null;
			return false;
		}
		// Register ONE undoable command for this stroke (the pixels are recorded in the
		// stack; addImageEditLayerForHistory dedupes the already-present layer + repaints).
		this.imageEditLayers = [...this.imageEditLayers, recorded];
		await this.rebuildEditComposite();
		// P1-1 — the edit is now durably rendered by the overlay; un-bake the transient
		// preview from the mutable backing canvas so it isn't drawn twice and so undo
		// (overlay removal) returns the page to pristine pixels rather than a phantom.
		this.restorePreviewRoiToOriginal();
		this.history.executeCommand(new ImageEditLayerCommand(this, recorded));
		this.onHistoryChange?.();
		return true;
	}

	/** Encode an RGBA ImageData ROI to a tiny PNG blob (null if no canvas support). */
	private async encodeImageDataToPng(patch: ImageData, w: number, h: number): Promise<Blob | null> {
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		try {
			ctx.putImageData(patch, 0, 0);
		} catch (e) {
			console.error("[editor] encodeImageDataToPng: putImageData failed:", e);
			return null;
		}
		return new Promise<Blob | null>((resolve) => {
			if (typeof canvas.toBlob === "function") canvas.toBlob((blob) => resolve(blob), "image/png");
			else resolve(null);
		});
	}

	/** Encode a full-image single-channel mask, cropped to the ROI, as a png-alpha PNG. */
	private async encodeMaskRoiToPng(
		mask: Uint8ClampedArray,
		region: { x: number; y: number; width: number; height: number },
		w: number,
		h: number,
	): Promise<Blob | null> {
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		const imageData = ctx.createImageData(w, h);
		const d = imageData.data;
		const rx = Math.round(region.x);
		const ry = Math.round(region.y);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const srcIdx = (ry + y) * this.imageWidth + (rx + x);
				const o = (y * w + x) * 4;
				const a = mask[srcIdx] ?? 0;
				d[o] = 0;
				d[o + 1] = 0;
				d[o + 2] = 0;
				d[o + 3] = a;
			}
		}
		ctx.putImageData(imageData, 0, 0);
		return new Promise<Blob | null>((resolve) => {
			if (typeof canvas.toBlob === "function") canvas.toBlob((blob) => resolve(blob), "image/png");
			else resolve(null);
		});
	}

	/**
	 * History redo — re-append an edit layer (idempotent: a layer already in the stack
	 * by id is left in place) and repaint + notify the store so the persisted stack
	 * matches. Called by {@link ImageEditLayerCommand}.execute().
	 */
	async addImageEditLayerForHistory(layer: ImageEditLayer): Promise<void> {
		if (!this.imageEditLayers.some((l) => l.id === layer.id)) {
			// Append at the normalized tail (positional stack): the re-added layer takes the
			// next contiguous index regardless of the (possibly stale) index it carried, so a
			// redo after intervening deletes cannot collide with a survivor's index.
			this.imageEditLayers = this.normalizeEditLayerIndices([...this.imageEditLayers, { ...layer }]);
		}
		await this.rebuildEditComposite();
		this.onImageEditLayersChange?.(this.getImageEditLayers());
	}

	/**
	 * History undo — remove the edit layer by id (its pixels disappear from the
	 * composite) and notify the store so the persisted stack drops it. Called by
	 * {@link ImageEditLayerCommand}.undo().
	 */
	async removeImageEditLayerForHistory(layerId: string): Promise<void> {
		this.imageEditLayers = this.imageEditLayers.filter((l) => l.id !== layerId);
		await this.rebuildEditComposite();
		this.onImageEditLayersChange?.(this.getImageEditLayers());
	}

	/**
	 * History execute/undo — set ONE edit layer's `visible` flag, recomposite (the layer
	 * paints / stops painting), and persist. Called by {@link ImageEditLayerVisibilityCommand}.
	 */
	async setImageEditLayerVisibilityForHistory(layerId: string, visible: boolean): Promise<void> {
		this.imageEditLayers = this.imageEditLayers.map((l) =>
			l.id === layerId ? { ...l, visible, updatedAt: new Date().toISOString() } : l,
		);
		// Persist the new stack immediately (synchronous), independent of the async
		// composite repaint — the store's saved state must reflect the toggle even if the
		// visual rebuild is still in flight.
		this.onImageEditLayersChange?.(this.getImageEditLayers());
		await this.rebuildEditComposite();
	}

	/**
	 * History execute — remove a SET of edit layers by id (the "revert to before this
	 * edit" / single-delete result) and recomposite. Called by
	 * {@link ImageEditLayerRevertCommand}.execute().
	 */
	async removeImageEditLayersForHistory(layerIds: string[]): Promise<void> {
		const drop = new Set(layerIds);
		// P1-1 — the stack is POSITIONAL: filtering leaves gaps in `index`, so RENORMALIZE
		// the survivors to contiguous 0..n-1 in array order. Without this, a later append
		// (which uses the layer COUNT as its index) collides with a surviving layer's index
		// and a subsequent revert-by-index removes BOTH. Keeping array order == index order
		// also keeps the compositor's index-sort byte-stable.
		this.imageEditLayers = this.normalizeEditLayerIndices(this.imageEditLayers.filter((l) => !drop.has(l.id)));
		this.onImageEditLayersChange?.(this.getImageEditLayers());
		await this.rebuildEditComposite();
	}

	/**
	 * History undo — restore the EXACT pre-delete/revert edit stack (ids, indices AND array
	 * order) captured by {@link ImageEditLayerRevertCommand} before it removed layers. We set
	 * the stack verbatim rather than re-inserting removed layers + re-sorting, because a
	 * delete renormalizes the survivors' indices (a0,b1,c2 → delete b → a0,c1), so re-inserting
	 * the removed b1 and sorting by index ties c1/b1 and yields a0,c1,b2 instead of the
	 * original a0,b1,c2. Restoring the recorded before-stack reproduces the original order
	 * and indices exactly. Called by {@link ImageEditLayerRevertCommand}.undo().
	 */
	async restoreImageEditStackForHistory(beforeStack: ImageEditLayer[]): Promise<void> {
		this.imageEditLayers = beforeStack.map((l) => ({ ...l }));
		this.onImageEditLayersChange?.(this.getImageEditLayers());
		await this.rebuildEditComposite();
	}

	/**
	 * Reassign contiguous 0..n-1 indices in ARRAY ORDER (no sort). Used after a delete /
	 * revert so the positional stack stays gap-free: the survivors' array order already IS
	 * the stack order, and the next appended edit (index == count) cannot collide.
	 */
	private normalizeEditLayerIndices(layers: ImageEditLayer[]): ImageEditLayer[] {
		return layers.map((layer, i) => (layer.index === i ? layer : { ...layer, index: i }));
	}

	// ── Phase C — edit-stack UI controls (visibility / rename / delete / revert) ──────
	// These are the user-facing entry points the Layers inspector "Edits" stack calls.

	/**
	 * Toggle (or set) an edit layer's visibility as ONE undoable step. The composite
	 * updates live and the change persists via the store. Returns false if no such layer.
	 */
	toggleImageEditLayerVisibility(layerId: string, visible?: boolean): boolean {
		const layer = this.imageEditLayers.find((l) => l.id === layerId);
		if (!layer) return false;
		const next = typeof visible === "boolean" ? visible : !(layer.visible !== false);
		if (next === (layer.visible !== false)) return false;
		// HistoryManager.executeCommand expects the action to have ALREADY happened (it
		// only stacks the command for undo/redo) — so apply the toggle first, then push.
		// The mutation is synchronous; the recomposite it kicks off is fire-and-forget.
		const command = new ImageEditLayerVisibilityCommand(this, layer, next);
		void this.setImageEditLayerVisibilityForHistory(layerId, next);
		this.history.executeCommand(command);
		this.onHistoryChange?.();
		return true;
	}

	/**
	 * Rename an edit layer. Lightweight metadata-only change (no recomposite needed); it
	 * is persisted via the store. Not pushed onto the undo stack (mirrors layer renames).
	 */
	renameImageEditLayer(layerId: string, name: string): boolean {
		const idx = this.imageEditLayers.findIndex((l) => l.id === layerId);
		if (idx < 0) return false;
		const trimmed = name.trim();
		this.imageEditLayers = this.imageEditLayers.map((l) =>
			l.id === layerId ? { ...l, name: trimmed || undefined, updatedAt: new Date().toISOString() } : l,
		);
		this.onImageEditLayersChange?.(this.getImageEditLayers());
		return true;
	}

	/**
	 * Delete ONE edit layer as an undoable step. Layers stacked AFTER it are kept (their
	 * indices renormalize on undo). The composite repaints without the removed layer.
	 */
	deleteImageEditLayer(layerId: string): boolean {
		const layer = this.imageEditLayers.find((l) => l.id === layerId);
		if (!layer) return false;
		// Snapshot the EXACT stack BEFORE the delete so undo can restore it verbatim (P1-1).
		const beforeStack = this.imageEditLayers.map((l) => ({ ...l }));
		const command = new ImageEditLayerRevertCommand(this, [layer], beforeStack);
		void this.removeImageEditLayersForHistory([layer.id]);
		this.history.executeCommand(command);
		this.onHistoryChange?.();
		return true;
	}

	/**
	 * "Revert to before this edit" — remove the target edit AND everything stacked after
	 * it (higher `index`), as ONE undoable step. The composite repaints to the state just
	 * before the target edit was made. Returns false if no such layer.
	 */
	revertToBeforeImageEditLayer(layerId: string): boolean {
		// P1-1 — operate on STACK POSITION, not on the stored `index` field. After a delete
		// the `index` values may have collided in legacy state; the array order is the
		// authoritative stack order, so revert drops the target and everything AFTER it in
		// the array (removeImageEditLayersForHistory then renormalizes the survivors).
		const targetPos = this.imageEditLayers.findIndex((l) => l.id === layerId);
		if (targetPos < 0) return false;
		const removed = this.imageEditLayers.slice(targetPos);
		if (removed.length === 0) return false;
		// Snapshot the EXACT stack BEFORE the revert so undo can restore it verbatim (P1-1).
		const beforeStack = this.imageEditLayers.map((l) => ({ ...l }));
		const command = new ImageEditLayerRevertCommand(this, removed, beforeStack);
		void this.removeImageEditLayersForHistory(removed.map((l) => l.id));
		this.history.executeCommand(command);
		this.onHistoryChange?.();
		return true;
	}

	/**
	 * Mark the background dirty and (re)arm the debounced persist. Rapid successive
	 * strokes coalesce into ONE encode+upload after the user goes idle, off the
	 * critical path. The timer is cancelled + flushed by navigation/tool-switch so a
	 * buffered edit can never persist against a different page (#248 nav-safety).
	 */
	private scheduleBackgroundPersist(): void {
		// P1 undoable-stroke fix — capture the pre-stroke durable background URL on the
		// FIRST patch of a coalesced stroke (i.e. when no edit is buffered yet). One
		// continuous stroke arms the debounce once, so this snapshots the bitmap as it
		// was BEFORE the stroke exactly once; runBackgroundPersist() pushes a single
		// BrushBackgroundCommand(before → after) when the stroke's persist settles.
		if (!this.hasBackgroundStrokeBefore) {
			this.backgroundStrokeBeforeUrl = this.currentImageUrl;
			this.hasBackgroundStrokeBefore = true;
		}
		this.backgroundPersistDirty = true;
		if (this.backgroundPersistTimer !== null) {
			clearTimeout(this.backgroundPersistTimer);
		}
		// Keep the busy/commit-pending gate "armed" while an edit is buffered so
		// navigation's waitForPendingBrushCommit() knows there is work to flush.
		this.setBackgroundPersistPending(true);
		this.backgroundPersistTimer = setTimeout(() => {
			this.backgroundPersistTimer = null;
			void this.runBackgroundPersist("brush-mask");
		}, MangaEditor.BACKGROUND_PERSIST_DEBOUNCE_MS);
	}

	// A single pending-promise that lives in pendingBrushCommits while a debounced
	// background edit is buffered or persisting, so every "is the editor busy?" /
	// "flush before navigate" consumer already waits for it. Resolved when the edit
	// has fully persisted (or there is nothing left to flush).
	private backgroundPersistGateResolve: (() => void) | null = null;
	private setBackgroundPersistPending(pending: boolean): void {
		if (pending) {
			if (this.backgroundPersistGateResolve) return;
			let gate!: Promise<void>;
			gate = new Promise<void>((resolve) => {
				this.backgroundPersistGateResolve = () => {
					this.pendingBrushCommits.delete(gate);
					resolve();
				};
			});
			this.pendingBrushCommits.add(gate);
		} else {
			this.backgroundPersistGateResolve?.();
			this.backgroundPersistGateResolve = null;
		}
	}

	/**
	 * Encode the current backing canvas and persist it ONCE (background upload), then
	 * point currentImageUrl at the durable persisted url. No reload — the canvas
	 * already shows the result. Awaited by flushPendingBackgroundPersist() on nav so
	 * the edit lands on the page it was drawn on.
	 *
	 * GATE/DIRTY DECOUPLING (#255 root-cause fix). The persist gate stored in
	 * `pendingBrushCommits` represents exactly ONE attempt. It MUST settle the
	 * moment that attempt COMPLETES — success OR failure — regardless of `forced`
	 * and regardless of `backgroundPersistDirty`. Coupling "settle the gate" to
	 * `(forced || !dirty)` deadlocks EVERY non-forced caller (page nav / export /
	 * save), not just teardown: a non-forced failure re-marks dirty, the gate is
	 * left armed, and `waitForPendingBrushCommit()` spins forever on a
	 * never-resolving promise (#255 P1, all three Codex variants).
	 *
	 * `backgroundPersistDirty` and `brushCommitError` stay ORTHOGONAL to the gate:
	 * on failure we still set `dirty = true` (so a later debounce/flush retries the
	 * unsaved on-canvas work within the live session) and record the error via
	 * setBrushCommitError so waitForPendingBrushCommit() rethrows it and the caller
	 * (nav / export / save AND forced teardown) can surface a non-blocking "last
	 * edit may not have saved" warning. Settling the gate does NOT clear dirty.
	 *
	 * `forced` (TEARDOWN: sign-out / leave-workspace / project-close) no longer
	 * influences gate settling here at all — it is retained only as context for the
	 * persist reason and to skip re-arming a debounce retry we'll never get.
	 */
	private async runBackgroundPersist(
		reason: "brush-mask" | "restore-full-ai",
		forced = false,
	): Promise<void> {
		if (!this.backgroundPersistDirty || !this.backgroundEditCanvas) {
			this.setBackgroundPersistPending(false);
			return;
		}
		// Coalesce concurrent calls: if a persist is already running, chain so the
		// LATEST canvas state is captured after it (and the gate stays pending).
		if (this.backgroundPersistInFlight) {
			await this.backgroundPersistInFlight;
		}
		if (!this.backgroundPersistDirty || !this.backgroundEditCanvas) {
			this.setBackgroundPersistPending(false);
			return;
		}
		this.backgroundPersistDirty = false;
		const commitTarget = this.getBrushCommitTarget("background");
		const editCanvas = this.backgroundEditCanvas;
		const run = (async () => {
			let blobUrl: string | null = null;
			// True once currentImageUrl points at a DURABLE url (server url or a
			// bounded data: copy), so revoking the transient blob is safe.
			let durableAssigned = false;
			try {
				this.setBrushCommitError(commitTarget, null);
				// Off-thread PNG encode of the full composited canvas (snapshot of the
				// current state — includes every stroke applied so far, in order).
				blobUrl = await canvasToBlobUrl(editCanvas);
				if (!blobUrl) return;
				if (this.onBackgroundImageSourceChange) {
					const persistedUrl = await this.onBackgroundImageSourceChange(blobUrl, reason);
					if (typeof persistedUrl === "string" && persistedUrl) {
						// Durable url (server url, or a bounded data: copy in file-mode) so
						// the page survives navigation/reload (#248 no-data-loss invariant).
						this.currentImageUrl = persistedUrl;
						durableAssigned = true;
					}
				}
				if (!durableAssigned) {
					// No durable url came back (no host wiring) — keep a durable data:
					// copy so currentImageUrl never points at a blob we are about to
					// revoke (no use-after-revoke blank page).
					this.currentImageUrl = await canvasToDataUrlAsync(editCanvas);
					durableAssigned = true;
				}
				this.setBrushCommitError(commitTarget, null);
				// P1 undoable-stroke fix — the destructive instant-apply stroke is now
				// durably persisted (currentImageUrl points at the post-stroke bitmap).
				// Push ONE history command for the WHOLE coalesced stroke: before = the
				// bitmap captured on the first patch, after = this durable url. The pixels
				// are already on the canvas, so register WITHOUT re-executing. Undo swaps
				// back to `before`, redo re-applies `after`. Guarded so it fires once per
				// stroke and only when the bitmap actually changed.
				if (this.hasBackgroundStrokeBefore) {
					const beforeUrl = this.backgroundStrokeBeforeUrl;
					const afterUrl = this.currentImageUrl;
					this.hasBackgroundStrokeBefore = false;
					this.backgroundStrokeBeforeUrl = null;
					if (afterUrl && afterUrl !== beforeUrl) {
						this.history.executeCommand(new BrushBackgroundCommand(this, beforeUrl, afterUrl));
						this.onHistoryChange?.();
					}
				}
			} catch (error) {
				// Re-mark dirty so a later flush retries (the edit is still on-canvas).
				this.backgroundPersistDirty = true;
				this.setBrushCommitError(commitTarget, error);
				console.error("[editor] background persist failed:", error);
			} finally {
				// Only revoke the transient blob once currentImageUrl points elsewhere.
				if (blobUrl && blobUrl.startsWith("blob:") && durableAssigned) {
					try {
						URL.revokeObjectURL(blobUrl);
					} catch {
						/* best effort */
					}
				}
			}
		})();
		this.backgroundPersistInFlight = run;
		try {
			await run;
		} finally {
			if (this.backgroundPersistInFlight === run) this.backgroundPersistInFlight = null;
			// ROOT-CAUSE FIX (#255): this attempt has COMPLETED, so settle its gate
			// UNCONDITIONALLY — success or failure, forced or not. A non-forced upload
			// failure re-marks `backgroundPersistDirty` (above) so a later debounce/flush
			// still retries the on-canvas work, but the gate (one-attempt promise) MUST
			// NOT stay armed: leaving it pending deadlocks every waitForPendingBrushCommit()
			// caller — page nav / export / save AND forced teardown — on a never-resolving
			// promise. The failure is recorded on brushCommitErrors so
			// waitForPendingBrushCommit() rethrows it; dirty stays orthogonal so the next
			// stroke/flush within the live session retries the unsaved work (same retry
			// behaviour as before — a stroke re-arms scheduleBackgroundPersist()).
			this.setBackgroundPersistPending(false);
		}
	}

	/**
	 * Flush any debounced background edit RIGHT NOW (encode + persist) and await it.
	 * Page navigation / tool-switch / project-close call this BEFORE currentPage
	 * changes so a buffered edit can NEVER persist against a different page than it
	 * was drawn on (#248 nav-safety). Safe no-op when nothing is buffered.
	 */
	async flushPendingBackgroundPersist(forced = false): Promise<void> {
		if (this.backgroundPersistTimer !== null) {
			clearTimeout(this.backgroundPersistTimer);
			this.backgroundPersistTimer = null;
		}
		if (this.backgroundPersistInFlight) {
			await this.backgroundPersistInFlight;
		}
		if (this.backgroundPersistDirty) {
			await this.runBackgroundPersist("brush-mask", forced);
		}
		// Belt-and-suspenders (#255): runBackgroundPersist now ALWAYS settles its gate
		// once an attempt completes (success or failure, forced or not), and dirty is
		// orthogonal. This unconditional settle is a final guarantee that NO flush path —
		// forced teardown OR non-forced nav/export/save — ever returns leaving a
		// never-resolving promise in pendingBrushCommits. It is a no-op when the gate is
		// already settled; the recorded brushCommitError still propagates to the caller.
		this.setBackgroundPersistPending(false);
	}

	/**
	 * Forget the instant-apply backing canvas + debounce state (page load / destroy).
	 * Callers that need the buffered edit persisted MUST flush first; this only drops
	 * the in-memory state so the next page starts from its own bitmap.
	 */
	private resetBackgroundEditState(): void {
		if (this.backgroundPersistTimer !== null) {
			clearTimeout(this.backgroundPersistTimer);
			this.backgroundPersistTimer = null;
		}
		this.backgroundPersistDirty = false;
		this.backgroundEditCanvas = null;
		this.backgroundEditCtx = null;
		// P1 undoable-stroke fix — drop the per-stroke before-snapshot so it can't be
		// carried into the next page (history itself is cleared on page load).
		this.hasBackgroundStrokeBefore = false;
		this.backgroundStrokeBeforeUrl = null;
		this.setBackgroundPersistPending(false);
		// PR #264 worker-race fix — advance the epoch so any heal stroke that
		// captured the OLD epoch before its off-thread solve is DISCARDED by
		// applyToolPatchInstant when the worker finally returns (it would otherwise
		// composite onto the freshly-loaded page / a torn-down editor). Called on
		// every page load / image reload (via loadImage) and on destroy.
		this.imageEpoch++;
	}

	/**
	 * PR #264 worker-race fix — snapshot the current backing-canvas epoch. A heal
	 * stroke reads this BEFORE awaiting its off-thread Telea solve and passes it
	 * back into applyToolPatchInstant, which discards the result if the epoch
	 * advanced (page switched / image reloaded / editor destroyed) meanwhile.
	 */
	getImageEpoch(): number {
		return this.imageEpoch;
	}

	/**
	 * Commit a fully-composited background bitmap (data URL) produced by an
	 * editor tool (healing / clone / mask paint). Reuses the same persistence
	 * path the brush uses so working copies and history stay consistent.
	 *
	 * Returns a promise that settles once BOTH the persistence read AND the
	 * canvas reload have finished. Async image tools (clone/heal) await this so
	 * their `setToolBusy(false)` — and any follow-up stroke — only runs after the
	 * working copy is durably persisted and the canvas reflects it; that
	 * serialization is what stops a slow stroke from landing out of order and
	 * clobbering a later one. The await is of async I/O only, so the main thread
	 * stays responsive (the busy badge keeps the no-freeze behaviour).
	 */
	commitToolBackground(dataUrl: string, reason: "brush-mask" | "restore-full-ai" = "brush-mask"): Promise<void> {
		if (!dataUrl) return Promise.resolve();
		// P1 undoable-stroke fix — capture the pre-commit durable background URL so the
		// LEGACY (non-instant) tool-commit path is undoable too. We push a
		// BrushBackgroundCommand only when the commit yields a DURABLE persisted url
		// (not the soon-revoked blob), so undo/redo never points at a revoked URL.
		const beforeUrl = this.currentImageUrl;
		this.currentImageUrl = dataUrl;

		// Persist the new working copy (may be async). Track for the busy gate.
		let persistPromise: Promise<unknown> = Promise.resolve();
		if (this.onBackgroundImageSourceChange) {
			const commitTarget = this.getBrushCommitTarget("background");
			this.setBrushCommitError(commitTarget, null);
			const commit = Promise.resolve(this.onBackgroundImageSourceChange(dataUrl, reason))
				.then((persistedUrl) => {
					if (typeof persistedUrl === "string" && persistedUrl) {
						this.currentImageUrl = persistedUrl;
						// Durable url in hand — register the destructive stroke as ONE undo
						// step (pixels already on canvas, so no re-execute). Skip restore-full-ai
						// (it owns its own history via updateBackgroundImageWithHistory).
						if (reason === "brush-mask" && persistedUrl !== beforeUrl) {
							this.history.executeCommand(new BrushBackgroundCommand(this, beforeUrl, persistedUrl));
							this.onHistoryChange?.();
						}
					}
					this.setBrushCommitError(commitTarget, null);
				});
			this.pendingBrushCommits.add(commit);
			persistPromise = commit;
			void commit
				.catch((error) => {
					this.setBrushCommitError(commitTarget, error);
					console.error("[MangaEditor] tool background commit failed:", error);
				})
				.finally(() => {
					this.pendingBrushCommits.delete(commit);
				});
		}

		// Reload the committed bitmap into the canvas via the shared authed loader.
		// IMPORTANT: a same-origin `blob:`/`data:` URL must be loaded WITHOUT
		// `crossOrigin: "anonymous"` — setting crossOrigin on a blob URL makes the
		// browser run a CORS check the blob can't satisfy and the <img> fails with
		// "Error loading blob:". Same-origin blob/data URLs do not taint the canvas,
		// so this stays export-safe. (API asset URLs still go through the authed
		// loader with crossOrigin from their own load paths.)
		const isLocalUrl = dataUrl.startsWith("blob:") || dataUrl.startsWith("data:");
		const reload = this.loadFabricImage(dataUrl, isLocalUrl ? undefined : { crossOrigin: "anonymous" })
			.then((img: any) => {
				const bg = this.canvas.getObjects().find((obj: any) => obj.type === "image" && !obj._isEditComposite);
				if (bg) this.canvas.remove(bg);
				this.imageItem = img;
				this.imageWidth = img.width || this.imageWidth || 1;
				this.imageHeight = img.height || this.imageHeight || 1;
				this._centerImage(img);
				img.set(LOCKED_PAGE_IMAGE_OPTIONS);
				this.canvas.insertAt(0, img);
				this.canvas.requestRenderAll();
			})
			.catch((e: unknown) => {
				console.error("[editor] commitToolBackground failed to reload bitmap:", e);
			});

		// The async encoder hands us a `blob:` object URL. Revoke it only after
		// BOTH the persistence read and the canvas reload have finished reading it,
		// so neither racer hits a revoked URL. Frees one full-resolution PNG buffer
		// per stroke instead of leaking it. (Persistence has already copied the
		// blob to a durable `data:`/server URL for the localImageUrls cache, so the
		// reloaded page survives navigation/reload even after this revoke.)
		const settled = Promise.allSettled([persistPromise, reload]);
		if (dataUrl.startsWith("blob:")) {
			void settled.then(() => {
				try {
					URL.revokeObjectURL(dataUrl);
				} catch {
					/* best effort */
				}
			});
		}

		// The serialization gate: a single in-flight tool commit the registry can
		// await so the next stroke (and the busy badge clear) waits for persistence
		// + reload to settle.
		const done = settled.then(() => undefined);
		this.pendingToolCommit = done;
		void done.finally(() => {
			if (this.pendingToolCommit === done) this.pendingToolCommit = null;
		});
		return done;
	}

	/**
	 * Await the most recent in-flight tool background commit (persistence +
	 * reload), if any. Used to serialize image-tool strokes so a new stroke can't
	 * start until the prior commit has settled. Never blocks the main thread — it
	 * only awaits already-scheduled async I/O.
	 */
	async waitForPendingToolCommit(): Promise<void> {
		while (this.pendingToolCommit) {
			const pending = this.pendingToolCommit;
			await pending;
			if (this.pendingToolCommit === pending) break;
		}
	}

	/**
	 * Bridge a tool's long-running work to the brush busy/commit-pending UI so a
	 * working indicator appears for operations that take >150ms (OpenCV inpaint,
	 * full-image composite + PNG encode). Reuses the existing brush-commit
	 * pending set so all "is the editor busy?" consumers stay consistent.
	 */
	setToolBusy(busy: boolean, label = "กำลังประมวลผล"): void {
		if (busy) {
			if (this.toolBusyResolve) return;
			let pending: Promise<void>;
			pending = new Promise<void>((resolve) => {
				this.toolBusyResolve = () => {
					this.pendingBrushCommits.delete(pending);
					resolve();
				};
			});
			this.pendingBrushCommits.add(pending);
			this.onToolBusyChange?.(true, label);
		} else {
			this.toolBusyResolve?.();
			this.toolBusyResolve = null;
			this.onToolBusyChange?.(false);
		}
	}

	setToolStatus(message: string | null, tone: "ready" | "blocked" | "info" = "info"): void {
		this.onToolStatusChange?.(message, tone);
	}

	private serializeTextObject(textObject: any): TextLayer {
		const data = textObject._textLayerData as TextLayer;
		const fallbackBoxWidth = this.imageWToCanvasW(data.w || 0);
		const fallbackBoxHeight = this.imageHToCanvasH(data.h || 0);
		const { width: objectWidth, height: objectBoxHeight } = resolveTextBoxCanvasDimensions({
			liveWidth: textObject.width,
			scaleX: textObject.scaleX,
			scaleY: textObject.scaleY,
			cachedBoxWidth: textObject._textLayerBoxWidth,
			cachedBoxHeight: textObject._textLayerBoxHeight,
			fallbackBoxWidth,
			fallbackBoxHeight,
		});
		const objectLeft = textObject.originX === "center"
			? (textObject.left || 0) - objectWidth / 2
			: (textObject.left || 0);
		const objectTop = textObject.originY === "center"
			? (textObject.top || 0) - objectBoxHeight / 2
			: (textObject.top || 0);
		const strokeScale = textObject.strokeUniform ? 1 : (textObject.scaleX || 1);
		const objectStrokeWidth = textObject.strokeWidth ?? this.getTextStrokeWidthInCanvasPixels(data);
		const stroke = typeof textObject.stroke === "string" ? textObject.stroke : (data.stroke ?? DEFAULT_TEXT_STROKE);
		const strokeWidth = Math.max(0, this.canvasWToImageW(objectStrokeWidth * strokeScale));
		const effects = data.effects?.stroke?.enabled
			? {
				...data.effects,
				stroke: {
					...data.effects.stroke,
					color: stroke,
					width: strokeWidth,
				},
			}
			: data.effects;
		return {
			...data,
			text: textObject.text || data.text,
			x: this.canvasXToImageX(objectLeft),
			y: this.canvasYToImageY(objectTop),
			w: this.canvasWToImageW(objectWidth),
			h: this.canvasHToImageH(objectBoxHeight),
			rotation: textObject.angle || data.rotation,
			opacity: Math.max(0, Math.min(1, textObject.opacity ?? data.opacity ?? 1)),
			fontSize: Math.round(this.canvasWToImageW((textObject.fontSize || data.fontSize) * (textObject.scaleX || 1))),
			charSpacing: Number.isFinite(Number(textObject.charSpacing)) ? Number(textObject.charSpacing) : data.charSpacing,
			skewX: Number.isFinite(Number(textObject.skewX)) ? Math.max(-45, Math.min(45, Math.round(Number(textObject.skewX)))) : data.skewX,
			skewY: Number.isFinite(Number(textObject.skewY)) ? Math.max(-45, Math.min(45, Math.round(Number(textObject.skewY)))) : data.skewY,
			fontFamily: textObject.fontFamily || data.fontFamily,
			fill: typeof textObject.fill === "string" ? textObject.fill : (data.fill ?? DEFAULT_TEXT_FILL),
			stroke,
			strokeWidth,
			alignment: textObject.textAlign || data.alignment,
			visible: textObject.visible !== false,
			locked: data.locked === true,
			effects,
		};
	}

	private serializeImageObject(imageObject: any): ImageLayer {
		const data = imageObject._imageLayerData as ImageLayer;
		// `imageObject.width/height` is the DISPLAYED source extent. With a
		// sourceCrop applied (fabric cropX/cropY/width/height) it is the crop
		// size, which is exactly what scale maps onto the layer box — so the
		// w/h math below stays correct. But the true natural source dimensions
		// must be preserved from `data` so a serialize→re-add round-trip can
		// re-clamp the crop, instead of collapsing sourceW/H to the crop size.
		const hasSourceCrop = Boolean(data?.sourceCrop);
		const drawnWidth = Math.max(1, imageObject.width ?? data.w ?? 1);
		const drawnHeight = Math.max(1, imageObject.height ?? data.h ?? 1);
		const objectWidth = drawnWidth * (imageObject.scaleX || 1);
		const objectHeight = drawnHeight * (imageObject.scaleY || 1);
		const objectLeft = imageObject.originX === "center"
			? (imageObject.left || 0) - objectWidth / 2
			: (imageObject.left || 0);
		const objectTop = imageObject.originY === "center"
			? (imageObject.top || 0) - objectHeight / 2
			: (imageObject.top || 0);

		return {
			...data,
			x: this.canvasXToImageX(objectLeft),
			y: this.canvasYToImageY(objectTop),
			w: Math.max(1, this.canvasWToImageW(objectWidth)),
			h: Math.max(1, this.canvasHToImageH(objectHeight)),
			sourceW: hasSourceCrop ? (data.sourceW ?? drawnWidth) : drawnWidth,
			sourceH: hasSourceCrop ? (data.sourceH ?? drawnHeight) : drawnHeight,
			rotation: imageObject.angle || data.rotation || 0,
			opacity: Math.max(0, Math.min(1, imageObject.opacity ?? data.opacity ?? 1)),
			flipX: imageObject.flipX === true,
			flipY: imageObject.flipY === true,
			visible: imageObject.visible !== false,
			locked: data.locked === true,
			blendMode: normalizeImageLayerBlendMode(data.blendMode),
		};
	}

	private syncTextObjectData(textObject: any): TextLayer {
		const layer = this.serializeTextObject(textObject);
		textObject._textLayerData = layer;
		return layer;
	}

	private syncImageObjectData(imageObject: any): ImageLayer {
		const layer = this.serializeImageObject(imageObject);
		imageObject._imageLayerData = layer;
		return layer;
	}

	/**
	 * True when the given Fabric target is a MULTI-object active selection (group
	 * box), not a single layer object. A multi-select has child objects but carries
	 * neither `_textLayerData` nor `_imageLayerData` itself.
	 */
	private isMultiSelection(target: any): boolean {
		if (!target) return false;
		return classifySelectionTarget({
			hasTextLayerData: Boolean(target._textLayerData),
			hasImageLayerData: Boolean(target._imageLayerData),
			childCount: this.getSelectionChildren(target).length,
		}) === "multi-selection";
	}

	private getSelectionChildren(target: any): any[] {
		if (!target) return [];
		if (typeof target.getObjects === "function") {
			const objs = target.getObjects();
			if (Array.isArray(objs) && objs.length > 0) return objs;
		}
		return Array.isArray(target._objects) ? target._objects : [];
	}

	/**
	 * DATA-LOSS FIX (agy03): persist a MULTI-SELECTION move/scale/rotate back to each
	 * layer. Fabric wraps a multi-select in an ActiveSelection whose children carry
	 * coordinates RELATIVE to the group center — and the `object:modified` handler's
	 * per-object branches never fire for the group box itself, so without this the
	 * resulting geometry was simply never written to `_textLayerData`/`_imageLayerData`
	 * and was lost on the next save/reload (or until the user re-clicked each layer).
	 *
	 * For each child we compute its ABSOLUTE scene transform via `calcTransformMatrix()`
	 * + `qrDecompose`, temporarily stamp the absolute left/top/scale/angle/skew onto the
	 * object (so the existing serialize→imageBounds conversion reads true scene coords),
	 * sync the per-layer data, then restore the relative values Fabric needs to keep
	 * rendering the live group.
	 *
	 * UNDO COHERENCE (P1): the whole gesture is recorded as ONE history step that
	 * reverts EVERY affected layer at once — text children via ModifyTextLayerCommand
	 * and image children via UpdateImageLayerCommand, combined in a single
	 * CompositeCommand. The `before` state is read from each child's last-persisted
	 * `_textLayerData`/`_imageLayerData` (the pre-gesture geometry) BEFORE syncing the
	 * `after`. Without this a multi-select move/scale/rotate was saved but not undoable,
	 * and a mixed image+text undo could revert only the image layers — leaving text
	 * stranded. One gesture = one step; no double-push.
	 */
	private syncMultiSelectionTransform(target: any): void {
		const children = this.getSelectionChildren(target);
		if (children.length === 0) return;
		let textChanged = false;
		let imageChanged = false;
		const textHistory: Array<{ before: TextLayer; after: TextLayer }> = [];
		const imageHistory: Array<{ before: ImageLayer; after: ImageLayer }> = [];
		for (const child of children) {
			// LOCK INTEGRITY: a locked layer must NOT move or persist, even when it is
			// part of a multi-selection drag/scale/rotate. Fabric transforms the whole
			// ActiveSelection group, so a locked child's per-object lockMovement flags do
			// not stop the group from carrying it along. Skip locked children entirely so
			// their `_textLayerData`/`_imageLayerData` (and the store) keep the original
			// geometry and nothing is serialized/persisted/undone for them.
			if (
				(child._textLayerData as TextLayer | undefined)?.locked === true ||
				(child._imageLayerData as ImageLayer | undefined)?.locked === true
			) {
				continue;
			}
			this.withAbsoluteChildGeometry(child, () => {
				if (child._textLayerData) {
					const before = cloneTextLayerForHistory(child._textLayerData as TextLayer);
					const after = this.syncTextObjectData(child);
					textHistory.push({ before, after: cloneTextLayerForHistory(after) });
					textChanged = true;
				} else if (child._imageLayerData) {
					const before = this.cloneImageLayerForHistory(child._imageLayerData as ImageLayer);
					const after = this.syncImageObjectData(child);
					imageHistory.push({ before, after });
					imageChanged = true;
				}
			});
		}
		if (textChanged) this.emitTextLayersChange();
		if (imageChanged) this.emitImageLayersChange();

		// Collapse the gesture into ONE undo step spanning every changed layer.
		const commands: Command[] = [];
		for (const { before, after } of textHistory) {
			if (before.id !== after.id) continue;
			if (this.isTextLayerHistoryEqual(before, after)) continue;
			commands.push(new ModifyTextLayerCommand(
				this,
				before.id,
				cloneTextLayerForHistory(before),
				cloneTextLayerForHistory(after),
			));
		}
		for (const { before, after } of imageHistory) {
			if (before.id !== after.id) continue;
			if (this.isImageLayerHistoryEqual(before, after)) continue;
			commands.push(new UpdateImageLayerCommand(
				this,
				this.cloneImageLayerForHistory(before),
				this.cloneImageLayerForHistory(after),
			));
		}
		if (commands.length === 0) return;
		// A single changed layer needs no composite wrapper; >1 collapses into one step.
		this.history.executeCommand(commands.length === 1 ? commands[0] : new CompositeCommand(commands));
		this.onHistoryChange?.();
	}

	/**
	 * Run `fn` with the child's ABSOLUTE scene geometry stamped onto it (so the
	 * serialize→imageBounds conversion reads true scene coords), then restore the
	 * group-relative transform Fabric needs to keep rendering the live selection box.
	 * Returns `fn`'s result, or `null` when the child has no decomposable matrix.
	 */
	private withAbsoluteChildGeometry<T>(child: any, fn: () => T): T | null {
		const qrDecompose = this.f?.util?.qrDecompose;
		const matrix = typeof child.calcTransformMatrix === "function" ? child.calcTransformMatrix() : null;
		const decomposed = matrix && typeof qrDecompose === "function" ? qrDecompose(matrix) : null;
		if (!decomposed) return null;
		// Snapshot the relative props so the live group keeps rendering after sync.
		const saved = {
			left: child.left,
			top: child.top,
			scaleX: child.scaleX,
			scaleY: child.scaleY,
			angle: child.angle,
			skewX: child.skewX,
			skewY: child.skewY,
			originX: child.originX,
			originY: child.originY,
			flipX: child.flipX,
			flipY: child.flipY,
		};
		// qrDecompose returns translateX/Y as the absolute scene position of the
		// object ORIGIN (we force center origin so it is the object center), plus the
		// absolute scaleX/scaleY/angle/skewX/skewY. It folds any group flip into a
		// signed scale, so flipX/flipY stay as the child already had them.
		child.set({
			left: decomposed.translateX,
			top: decomposed.translateY,
			scaleX: decomposed.scaleX,
			scaleY: decomposed.scaleY,
			angle: decomposed.angle,
			skewX: decomposed.skewX,
			skewY: decomposed.skewY,
			originX: "center",
			originY: "center",
		});
		try {
			return fn();
		} finally {
			// Restore the group-relative transform so Fabric renders the selection
			// box correctly; the per-layer absolute geometry is already committed.
			child.set(saved);
			child.setCoords?.();
		}
	}

	private cloneImageLayerForHistory(layer: ImageLayer): ImageLayer {
		return { ...layer };
	}

	private isImageLayerHistoryEqual(a: ImageLayer, b: ImageLayer): boolean {
		const keys: Array<keyof ImageLayer> = ["name", "x", "y", "w", "h", "rotation", "opacity", "flipX", "flipY", "visible", "locked", "index", "zIndex", "role", "blendMode"];
		return keys.every((key) => a[key] === b[key]);
	}

	private captureImageLayerTransformStart(target: any): void {
		if (!target?._imageLayerData) return;
		const layer = this.cloneImageLayerForHistory(this.serializeImageObject(target));
		this.imageLayerTransformStart.set(layer.id, layer);
	}

	private consumeImageLayerTransformStart(target: any): ImageLayer | null {
		if (!target?._imageLayerData) return null;
		const layerId = target._imageLayerData.id;
		const layer = this.imageLayerTransformStart.get(layerId) ?? null;
		this.imageLayerTransformStart.delete(layerId);
		return layer;
	}

	// Capture the BEFORE state of a text layer at the start of a direct-on-canvas
	// interaction. First-wins: a transform that begins while still mid-edit keeps
	// the original snapshot so the whole gesture collapses into ONE undo step.
	private captureTextLayerTransformStart(target: any): void {
		if (!target?._textLayerData) return;
		const layerId = target._textLayerData.id;
		if (this.textLayerTransformStart.has(layerId)) return;
		const layer = cloneTextLayerForHistory(this.serializeTextObject(target));
		this.textLayerTransformStart.set(layerId, layer);
	}

	private consumeTextLayerTransformStart(target: any): TextLayer | null {
		if (!target?._textLayerData) return null;
		const layerId = target._textLayerData.id;
		const layer = this.textLayerTransformStart.get(layerId) ?? null;
		this.textLayerTransformStart.delete(layerId);
		return layer;
	}

	private isTextObjectEditing(target: any): boolean {
		return Boolean(target && target.isEditing === true);
	}

	/** True when ANY text object on the canvas is currently in in-place edit mode. */
	isEditingText(): boolean {
		const active = this.canvas?.getActiveObject?.();
		if (this.isTextObjectEditing(active)) return true;
		return this.textLayers.some((textObject) => this.isTextObjectEditing(textObject));
	}

	// Re-resolve + rebuild the separate shadow/accent effect-pass objects from the
	// CURRENT main text object (mirrors text content + geometry). Used after direct
	// canvas edits/transforms where only the main layer was synced (P1 #3). Guarded:
	// no-op when the layer has no multi-pass effects so we never touch the canvas
	// stack needlessly.
	private resyncTextEffectPasses(textObject: any): void {
		if (!textObject?._textLayerData) return;
		const layer = this.serializeTextObject(textObject);
		this.applyTextEffectsToObject(textObject, layer, layer.effects);
	}

	// Diff a text object against its transform-start snapshot and push a single
	// ModifyTextLayerCommand if it changed. Mirrors recordImageLayerUpdateHistory.
	private recordTextLayerDirectEdit(target: any): void {
		const beforeLayer = this.consumeTextLayerTransformStart(target);
		if (!beforeLayer) return;
		const afterLayer = cloneTextLayerForHistory(this.serializeTextObject(target));
		this.recordTextLayerUpdateHistory(beforeLayer, afterLayer);
	}

	recordTextLayerUpdateHistory(beforeLayer: TextLayer, afterLayer: TextLayer): void {
		if (beforeLayer.id !== afterLayer.id) return;
		if (this.isTextLayerHistoryEqual(beforeLayer, afterLayer)) return;

		this.history.executeCommand(new ModifyTextLayerCommand(
			this,
			beforeLayer.id,
			cloneTextLayerForHistory(beforeLayer),
			cloneTextLayerForHistory(afterLayer),
		));
		this.onHistoryChange?.();
	}

	/**
	 * Nudge the currently-selected text layer by (dx, dy) image pixels — the precise
	 * positioning typesetters reach for with the arrow keys. The live move skips the
	 * undo stack; a whole burst of nudges on one layer collapses into a SINGLE undo
	 * entry once the user pauses (or switches layers / drags / the burst is flushed).
	 * Returns true when a layer was nudged so the caller can swallow the key.
	 */
	nudgeSelectedTextLayer(dx: number, dy: number): boolean {
		const active = this.canvas.getActiveObject?.();
		const layerId = active?._textLayerData?.id as string | undefined;
		if (!active || !layerId) return false;
		// A locked layer must not move (it can't be dragged either).
		if (active._textLayerData?.locked) return false;
		// Don't fight inline text editing — let the caret keys through.
		if (this.isTextObjectEditing?.(active)) return false;

		// Starting a burst (or switching to a different layer): commit any pending
		// burst first, then snapshot this layer's before-state once.
		if (this.nudgeLayerId !== layerId || this.nudgeBeforeLayer === null) {
			this.flushNudgeHistory();
			this.nudgeLayerId = layerId;
			this.nudgeBeforeLayer = cloneTextLayerForHistory(this.serializeTextObject(active));
		}

		const current = this.serializeTextObject(active);
		this.updateTextLayer(layerId, { x: current.x + dx, y: current.y + dy });

		if (this.nudgeCommitTimer) clearTimeout(this.nudgeCommitTimer);
		this.nudgeCommitTimer = setTimeout(() => this.flushNudgeHistory(), 600);
		return true;
	}

	/** Commit a pending keyboard-nudge burst as one undo entry. Safe to call anytime. */
	flushNudgeHistory(): void {
		if (this.nudgeCommitTimer) {
			clearTimeout(this.nudgeCommitTimer);
			this.nudgeCommitTimer = null;
		}
		const before = this.nudgeBeforeLayer;
		const layerId = this.nudgeLayerId;
		this.nudgeBeforeLayer = null;
		this.nudgeLayerId = null;
		if (!before || !layerId) return;
		const obj = this.findTextObject(layerId);
		if (!obj) return;
		const after = cloneTextLayerForHistory(this.serializeTextObject(obj));
		// recordTextLayerUpdateHistory no-ops when before === after.
		this.recordTextLayerUpdateHistory(before, after);
	}

	private isPointInsideImageBounds(pointer: { x: number; y: number }): boolean {
		const b = this.imageBounds;
		return (
			pointer.x >= b.left &&
			pointer.x <= b.left + b.width &&
			pointer.y >= b.top &&
			pointer.y <= b.top + b.height
		);
	}

	private buildDefaultTextLayerAtCanvasPoint(pointer: { x: number; y: number }): TextLayer | null {
		if (!this.imageItem || this.imageWidth <= 0 || this.imageHeight <= 0) return null;
		if (!this.isPointInsideImageBounds(pointer)) return null;

		const clamped = this.clampPointToImageBounds(pointer);
		const centerX = this.canvasXToImageX(clamped.x);
		const centerY = this.canvasYToImageY(clamped.y);
		const defaultWidth = Math.max(80, Math.min(320, Math.round(this.imageWidth * 0.36)));
		const defaultHeight = Math.max(48, Math.min(140, Math.round(config.defaultFontSize * 2.8)));
		const x = Math.max(0, Math.min(centerX - Math.round(defaultWidth / 2), Math.max(0, this.imageWidth - defaultWidth)));
		const y = Math.max(0, Math.min(centerY - Math.round(defaultHeight / 2), Math.max(0, this.imageHeight - defaultHeight)));

		return {
			id: safeRandomId(),
			text: config.defaultText,
			x,
			y,
			w: Math.min(defaultWidth, this.imageWidth),
			h: Math.min(defaultHeight, this.imageHeight),
			rotation: 0,
			fontSize: config.defaultFontSize,
			alignment: "center",
			index: this.textLayers.length,
		};
	}

	addTextLayerAtCanvasPoint(pointer: { x: number; y: number }): TextLayer | null {
		const layer = this.buildDefaultTextLayerAtCanvasPoint(pointer);
		if (!layer) return null;
		this.addTextLayerWithHistory(layer);
		const selected = this.selectTextLayer(layer.id);
		const createdLayer = selected ?? layer;
		this.onTextLayerCreate?.(createdLayer);
		// #E6c: drop straight into edit mode so placing a caption is ONE gesture
		// (click → type) instead of click → double-click → type. select-all so the first
		// keystroke replaces the placeholder. No-op if the object isn't an editable text.
		const active: any = this.canvas.getActiveObject?.();
		if (active && typeof active.enterEditing === "function") {
			active.enterEditing();
			active.selectAll?.();
			this.canvas.requestRenderAll();
		}
		return createdLayer;
	}

	private emitTextLayersChange(): void {
		this.onTextLayersChange?.(this.getAllTextLayers());
	}

	private emitImageLayersChange(): void {
		this.onImageLayersChange?.(this.getAllImageLayers());
	}

	private getDefaultTextStrokeWidth(fontSizeInPixels: number): number {
		if (!Number.isFinite(fontSizeInPixels) || fontSizeInPixels <= 0) {
			return DEFAULT_TEXT_STROKE_MIN;
		}
		return Math.max(
			DEFAULT_TEXT_STROKE_MIN,
			Math.min(DEFAULT_TEXT_STROKE_MAX, fontSizeInPixels * DEFAULT_TEXT_STROKE_RATIO),
		);
	}

	private getTextStrokeWidthInImagePixels(layer: TextLayer): number {
		return Math.max(0, layer.strokeWidth ?? this.getDefaultTextStrokeWidth(layer.fontSize));
	}

	private getTextStrokeWidthInCanvasPixels(layer: TextLayer): number {
		return this.imageWToCanvasW(this.getTextStrokeWidthInImagePixels(layer));
	}

	private measureTextObjectAtFontSize(textObject: any, fontSize: number, boxWidth: number): { width: number; height: number } {
		const original = {
			fontSize: textObject.fontSize,
			width: textObject.width,
			height: textObject.height,
			scaleX: textObject.scaleX,
			scaleY: textObject.scaleY,
		};

		textObject.set({
			fontSize,
			width: boxWidth,
			scaleX: 1,
			scaleY: 1,
		});
		textObject.initDimensions?.();

		const strokePadding = Math.max(0, textObject.strokeWidth ?? 0) * 2;
		const measured = {
			width: Math.max(textObject.dynamicMinWidth ?? 0, textObject.width ?? boxWidth),
			height: (textObject.calcTextHeight?.() ?? textObject.height ?? 0) + strokePadding,
		};

		textObject.set(original);
		textObject.initDimensions?.();
		return measured;
	}

	private calculateFittedTextFontSize(textObject: any, layer: TextLayer): number {
		const boxWidth = this.imageWToCanvasW(layer.w);
		const boxHeight = this.imageHToCanvasH(layer.h);
		if (boxWidth <= 0 || boxHeight <= 0) return Math.max(6, layer.fontSize || config.defaultFontSize);

		const minImageFontSize = 6;
		const maxImageFontSize = Math.max(
			minImageFontSize,
			Math.min(360, Math.max(layer.fontSize || config.defaultFontSize, layer.h * 0.92)),
		);
		let low = minImageFontSize;
		let high = maxImageFontSize;
		let best = minImageFontSize;

		for (let i = 0; i < 16; i += 1) {
			const mid = (low + high) / 2;
			const measured = this.measureTextObjectAtFontSize(textObject, this.imageWToCanvasW(mid), boxWidth);
			const fits = measured.width <= boxWidth * 1.02 && measured.height <= boxHeight * 0.96;
			if (fits) {
				best = mid;
				low = mid;
			} else {
				high = mid;
			}
		}

		return Math.max(minImageFontSize, Math.floor(best));
	}

	private createExportTextObject(textObject: any, layer: TextLayer, shadow?: ResolvedTextLayerShadow | null, pass?: ResolvedTextLayerPass | null): any {
		const TextClass = this.f.Textbox ?? this.f.IText;
		const fontSize = layer.fontSize || config.defaultFontSize;
		const resolved = resolveTextLayerEffectStyle(
			layer,
			DEFAULT_TEXT_STROKE,
			this.getTextStrokeWidthInImagePixels(layer),
		);
		const text = new TextClass(layer.text, {
			left: layer.x + layer.w / 2 + (pass?.offsetX ?? 0),
			top: layer.y + layer.h / 2 + (pass?.offsetY ?? 0),
			width: layer.w,
			height: layer.h,
			angle: layer.rotation || 0,
			opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)) * (pass?.opacity ?? 1),
			fontSize,
			charSpacing: layer.charSpacing ?? 0,
			skewX: layer.skewX ?? 0,
			skewY: layer.skewY ?? 0,
			fontFamily: layer.fontFamily || config.defaultFontFamily,
			fill: pass?.fill ?? layer.fill ?? DEFAULT_TEXT_FILL,
			stroke: pass?.stroke ?? resolved.stroke,
			strokeWidth: pass?.strokeWidth ?? resolved.strokeWidth,
			paintFirst: "stroke",
			textAlign: layer.alignment,
			lineHeight: textObject.lineHeight || 1.12,
			splitByGrapheme: true,
			originX: "center",
			originY: "center",
			editable: false,
			selectable: false,
			evented: false,
		});

		if (shadow) {
			text.set({
				shadow: new this.f.Shadow({
					color: shadow.color,
					offsetX: shadow.offsetX,
					offsetY: shadow.offsetY,
					blur: shadow.blur,
				}),
			});
		}

		return text;
	}

	private createExportTextObjects(textObject: any, layer: TextLayer): any[] {
		const resolved = resolveTextLayerEffectStyle(
			layer,
			DEFAULT_TEXT_STROKE,
			this.getTextStrokeWidthInImagePixels(layer),
		);
		const stackPasses = resolved.passes.map((pass) => this.createExportTextObject(textObject, layer, pass.shadow, pass));
		const shadowPasses = resolved.shadows.length > 1
			? resolved.shadows.map((shadow) => this.createExportTextObject(textObject, layer, shadow))
			: [];
		const primaryShadow = resolved.shadows.length <= 1 ? resolved.shadow : null;
		return [...stackPasses, ...shadowPasses, this.createExportTextObject(textObject, layer, primaryShadow)];
	}

	private async createExportImageObject(imageObject: any, layer: ImageLayer): Promise<any> {
		const sourceUrl = imageObject._imageLayerUrl || this.projectImageUrlResolver?.(layer.imageId);
		if (!sourceUrl) {
			throw new Error(`Image layer ${layer.id} has no source URL`);
		}
		const image = await this.loadFabricImage(sourceUrl, { crossOrigin: "anonymous" });
		const naturalWidth = Math.max(1, image.width ?? 1);
		const naturalHeight = Math.max(1, image.height ?? 1);
		// Same source-crop math as the live render (createImageObject) so the
		// exported pixels match the screen exactly: an AI result stored as a
		// FULL-PAGE composite paints back ONLY over its crop region, never the
		// whole page squeezed into the box.
		const cropPlacement = resolveImageLayerSourceCrop({
			sourceCrop: layer.sourceCrop,
			naturalWidth,
			naturalHeight,
			targetWidth: layer.w,
			targetHeight: layer.h,
		});
		image.set({
			left: layer.x + layer.w / 2,
			top: layer.y + layer.h / 2,
			angle: layer.rotation || 0,
			opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
			flipX: layer.flipX === true,
			flipY: layer.flipY === true,
			globalCompositeOperation: imageLayerBlendModeToCompositeOperation(normalizeImageLayerBlendMode(layer.blendMode)),
			originX: "center",
			originY: "center",
			selectable: false,
			evented: false,
		});
		if (cropPlacement.crop) {
			image.set({
				cropX: cropPlacement.crop.x,
				cropY: cropPlacement.crop.y,
				width: cropPlacement.crop.w,
				height: cropPlacement.crop.h,
			});
		}
		image.scaleX = cropPlacement.scaleX;
		image.scaleY = cropPlacement.scaleY;
		return image;
	}

	/**
	 * E1 — build a fresh native-image-pixel offscreen canvas with the current page's
	 * non-destructive edit layers (`fill-mask` + `patch`/`healing`/`clone`) composited
	 * in index order, reusing the SAME per-layer paint logic as the live
	 * rebuildEditComposite (paintFillMaskLayer / paintRealizedPatchLayer). Returns null
	 * when there is nothing to composite (no edit layers / no painted pixels), so the
	 * export is byte-identical to a page with none. Used by exportMergedImageDataUrl so
	 * single-page export matches the batch ZIP (composeEditLayersOntoExportCanvas).
	 */
	private async buildEditCompositeExportCanvas(): Promise<HTMLCanvasElement | null> {
		if (typeof document === "undefined") return null;
		if (this.imageWidth <= 0 || this.imageHeight <= 0) return null;
		const isComposable = (layer: ImageEditLayer): boolean => {
			const t = layer.payload?.type;
			return t === "fill-mask" || t === "patch" || t === "healing" || t === "clone";
		};
		const layers = [...this.imageEditLayers]
			.filter((layer) => layer.visible !== false && isComposable(layer))
			.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		if (layers.length === 0) return null;
		const canvasEl = document.createElement("canvas");
		canvasEl.width = this.imageWidth;
		canvasEl.height = this.imageHeight;
		const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		ctx.clearRect(0, 0, this.imageWidth, this.imageHeight);
		for (const layer of layers) {
			if (layer.payload?.type === "fill-mask") {
				await this.paintFillMaskLayer(ctx, layer);
			} else {
				await this.paintRealizedPatchLayer(ctx, layer);
			}
		}
		return canvasEl;
	}

	async exportMergedImageDataUrl(): Promise<string> {
		if (!this.currentImageUrl || this.imageWidth <= 0 || this.imageHeight <= 0) {
			throw new Error("No image is loaded for export");
		}

		const exportCanvasEl = document.createElement("canvas");
		const exportCanvas = new this.f.StaticCanvas(exportCanvasEl, {
			width: this.imageWidth,
			height: this.imageHeight,
			enableRetinaScaling: false,
		});

		try {
			const background = await this.loadFabricImage(this.currentImageUrl, { crossOrigin: "anonymous" });
			background.set({
				left: 0,
				top: 0,
				originX: "left",
				originY: "top",
				selectable: false,
				evented: false,
			});
			background.scaleToWidth(this.imageWidth);
			if (background.getScaledHeight && Math.abs(background.getScaledHeight() - this.imageHeight) > 0.5) {
				background.scaleToHeight(this.imageHeight);
			}
			exportCanvas.add(background);

			// E1 — composite the page's non-destructive edit layers (bubble-clean
			// fill-masks + patch/healing/clone realized ROIs) ABOVE the background and
			// BELOW image/text layers, in native image-pixel space. These are stored as
			// DATA and rendered live via the separate editCompositeImage overlay (NOT
			// baked into currentImageUrl), so without this step the single-page export
			// would ship the RAW un-cleaned source while the batch ZIP shows it cleaned.
			// Mirrors composeEditLayersOntoExportCanvas() + the live rebuildEditComposite
			// z-order, making single-page export byte-equivalent to the batch render.
			const editComposite = await this.buildEditCompositeExportCanvas();
			if (editComposite) {
				const editOverlay = new this.f.FabricImage(editComposite, {
					left: 0,
					top: 0,
					originX: "left",
					originY: "top",
					selectable: false,
					evented: false,
				});
				exportCanvas.add(editOverlay);
			}

			for (const entry of this.getUnifiedLayerStackEntries()) {
				if (entry.kind === "image") {
					const layer = this.serializeImageObject(entry.object);
					if (layer.visible === false) continue;
					exportCanvas.add(await this.createExportImageObject(entry.object, layer));
				} else {
					const layer = this.serializeTextObject(entry.object);
					if (layer.visible === false) continue;
					for (const textObject of this.createExportTextObjects(entry.object, layer)) {
						exportCanvas.add(textObject);
					}
				}
			}

			exportCanvas.renderAll();
			return exportCanvas.toDataURL({
				format: "png",
				quality: 1,
				multiplier: 1,
				enableRetinaScaling: false,
			});
		} finally {
			exportCanvas.dispose();
		}
	}

	private async createImageObject(layer: ImageLayer, imageUrl?: string, restoreImageUrl?: string): Promise<any> {
		const sourceUrl = imageUrl || this.projectImageUrlResolver?.(layer.imageId);
		if (!sourceUrl) {
			throw new Error(`Image layer ${layer.id} has no source URL`);
		}

		const image = await this.loadFabricImage(sourceUrl, { crossOrigin: "anonymous" });
		const naturalWidth = Math.max(1, image.width ?? 1);
		const naturalHeight = Math.max(1, image.height ?? 1);
		const canvasWidth = this.imageWToCanvasW(layer.w);
		const canvasHeight = this.imageHToCanvasH(layer.h);
		// A sourceCrop clips the layer to a sub-rectangle of its source image
		// (source-image pixels). Used for AI results: the stored result is a
		// FULL-PAGE composite, but it must paint back only over the crop region,
		// so we display just that region scaled to the layer box. Clamped to the
		// natural image so a stale/oversized crop can never read off-canvas. The
		// crop math is shared with createExportImageObject so live + export match.
		const cropPlacement = resolveImageLayerSourceCrop({
			sourceCrop: layer.sourceCrop,
			naturalWidth,
			naturalHeight,
			targetWidth: canvasWidth,
			targetHeight: canvasHeight,
		});
		const sourceCrop = cropPlacement.crop;
		const layerData: ImageLayer = {
			...layer,
			sourceW: naturalWidth,
			sourceH: naturalHeight,
			sourceCrop: sourceCrop ?? undefined,
			opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
			flipX: layer.flipX === true,
			flipY: layer.flipY === true,
			visible: layer.visible !== false,
			locked: layer.locked === true,
			blendMode: normalizeImageLayerBlendMode(layer.blendMode),
		};

		image.set({
			left: this.imageXToCanvasX(layer.x + layer.w / 2),
			top: this.imageYToCanvasY(layer.y + layer.h / 2),
			angle: layer.rotation || 0,
			opacity: layerData.opacity,
			flipX: layerData.flipX,
			flipY: layerData.flipY,
			globalCompositeOperation: imageLayerBlendModeToCompositeOperation(layerData.blendMode),
			originX: "center",
			originY: "center",
		});
		if (sourceCrop) {
			// Fabric.js v6 source-crop: cropX/cropY pick the sub-rect origin and
			// width/height the sub-rect size in the source element's pixels.
			image.set({
				cropX: sourceCrop.x,
				cropY: sourceCrop.y,
				width: sourceCrop.w,
				height: sourceCrop.h,
			});
		}
		image.scaleX = cropPlacement.scaleX;
		image.scaleY = cropPlacement.scaleY;
		image._imageLayerData = layerData;
		image._imageLayerUrl = sourceUrl;
		const restoreSourceUrl = restoreImageUrl ?? (layerData.restoreImageId ? this.projectImageUrlResolver?.(layerData.restoreImageId) : undefined);
		if (restoreSourceUrl) {
			try {
				const restoreImage = await this.loadFabricImage(restoreSourceUrl, { crossOrigin: "anonymous" });
				image._imageLayerRestoreUrl = restoreSourceUrl;
				image._imageLayerRestoreElement = this.getImageObjectSourceElement(restoreImage);
			} catch (error) {
				console.warn("[MangaEditor] restore source load failed", error);
			}
		}
		this.applyImageObjectLayerState(image, layerData);
		return image;
	}

	private createTextObject(layer: TextLayer): any {
		const TextClass = this.f.Textbox ?? this.f.IText;
		const safeFontSize = Number.isFinite(layer.fontSize) && layer.fontSize > 0 ? layer.fontSize : config.defaultFontSize;
		const safeWidth = Number.isFinite(layer.w) && layer.w > 0
			? layer.w
			: Math.max(1, Math.min(this.imageWidth || 320, 320));
		const safeHeight = Number.isFinite(layer.h) && layer.h > 0
			? layer.h
			: Math.max(1, Math.min(this.imageHeight || Math.round(safeFontSize * 3), Math.round(safeFontSize * 3)));
		const safeX = Number.isFinite(layer.x) ? layer.x : 0;
		const safeY = Number.isFinite(layer.y) ? layer.y : 0;
		const safeAlignment = layer.alignment === "left" || layer.alignment === "right" || layer.alignment === "center"
			? layer.alignment
			: "center";
		const boxWidth = this.imageWToCanvasW(safeWidth);
		const boxHeight = this.imageHToCanvasH(safeHeight);
		const fontSize = this.imageWToCanvasW(safeFontSize);
		const layerData: TextLayer = {
			...layer,
			text: typeof layer.text === "string" ? layer.text : "",
			x: safeX,
			y: safeY,
			w: safeWidth,
			h: safeHeight,
			rotation: Number.isFinite(layer.rotation) ? layer.rotation : 0,
			fontSize: safeFontSize,
			alignment: safeAlignment,
			index: Number.isFinite(layer.index) ? layer.index : this.textLayers.length,
			opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
			visible: layer.visible !== false,
			locked: layer.locked === true,
		};
		const text = new TextClass(layerData.text, {
			left: this.imageXToCanvasX(layerData.x + layerData.w / 2),
			top: this.imageYToCanvasY(layerData.y + layerData.h / 2),
			width: boxWidth,
			height: boxHeight,
			opacity: layerData.opacity ?? 1,
			fontSize,
			fontFamily: layer.fontFamily || config.defaultFontFamily,
			fill: layer.fill || DEFAULT_TEXT_FILL,
			stroke: layer.stroke || DEFAULT_TEXT_STROKE,
			strokeWidth: this.getTextStrokeWidthInCanvasPixels(layerData),
			// E4 — set tracking/skew at creation so a freshly-loaded page renders
			// identically to export (page-export.ts) without waiting for a
			// positionTextObjectFromLayer remap (which only fires on resize/recenter).
			charSpacing: layer.charSpacing ?? 0,
			skewX: layer.skewX ?? 0,
			skewY: layer.skewY ?? 0,
			paintFirst: "stroke",
			textAlign: layerData.alignment,
			lineHeight: 1.12,
			splitByGrapheme: true,
			originX: "center",
			originY: "center",
			editable: true,
		});

		text._textLayerData = layerData;
		text._textLayerBoxWidth = boxWidth;
		text._textLayerBoxHeight = boxHeight;
		this.applyTextObjectLayerState(text, layerData);
		this.applyTextEffectsToObject(text, layerData, layerData.effects);
		return text;
	}

	applyEffects(effects: TextLayerEffects | null): TextLayer | null {
		const active = this.canvas.getActiveObject();
		if (!active || !active._textLayerData) return null;
		const baseLayer = this.serializeTextObject(active);
		this.applyTextEffectsToObject(active, baseLayer, effects);
		this.canvas.requestRenderAll();
		this.emitTextLayersChange();
		const layer = this.syncTextObjectData(active);
		this.onTextLayerSelect?.(layer);
		return layer;
	}

	applyEffectsWithHistory(effects: TextLayerEffects | null): TextLayer | null {
		const active = this.canvas.getActiveObject();
		if (!active || !active._textLayerData) return null;
		const beforeLayer = cloneTextLayerForHistory(this.serializeTextObject(active));
		const afterLayer = this.applyEffects(effects);
		if (!afterLayer || this.isTextLayerHistoryEqual(beforeLayer, afterLayer)) return afterLayer;

		this.history.executeCommand(new ModifyTextLayerCommand(this, beforeLayer.id, beforeLayer, afterLayer));
		this.onHistoryChange?.();
		return afterLayer;
	}

	addTextLayer(layer: TextLayer) {
		this.addTextLayerInternal(layer);
	}

	/**
	 * Replace ALL text layers on the canvas with a new set, keeping the background
	 * image / image layers / viewport intact. Used to swap the visible text when the
	 * active Language Track changes (no image reload, no history reset). Clears the
	 * undo history because the previous track's text edits don't apply to the new one.
	 */
	setTextLayers(layers: TextLayer[]): void {
		for (const textObject of [...this.textLayers]) {
			const id = textObject._textLayerData?.id;
			if (id) this.removeTextEffectShadowPasses(id);
			this.canvas.remove(textObject);
		}
		this.textLayers = [];
		this.onTextLayerSelect?.(null);
		for (const layer of layers) {
			this.addTextLayerInternal(layer);
		}
		this.history.clear();
		this.onHistoryChange?.();
		this.canvas.requestRenderAll();
		this.emitTextLayersChange();
	}

	async addImageLayer(layer: ImageLayer, imageUrl?: string): Promise<ImageLayer> {
		return await this.addImageLayerInternal(layer, imageUrl);
	}

	async addImageLayerInternal(layer: ImageLayer, imageUrl?: string): Promise<ImageLayer> {
		const insertIndex = Math.max(0, Math.min(layer.index ?? this.imageLayers.length, this.imageLayers.length));
		const image = await this.createImageObject(this.assignMissingLayerStackIndex(
			{ ...layer, index: insertIndex },
			this.getNextLayerStackIndex(),
		), imageUrl);
		this.imageLayers.splice(insertIndex, 0, image);
		this.normalizeImageLayerIndexes();
		this.syncCanvasLayerOrder(layer.id);
		this.canvas.requestRenderAll();
		const syncedLayer = this.syncImageObjectData(image);
		this.emitImageLayersChange();
		return syncedLayer;
	}

	removeTextLayer(id: string) {
		const idx = this.textLayers.findIndex((t) => t._textLayerData?.id === id);
		if (idx >= 0) {
			this.canvas.remove(this.textLayers[idx]);
			this.textLayers.splice(idx, 1);
			this.normalizeTextLayerIndexes();
			this.canvas.requestRenderAll();
			this.emitTextLayersChange();
		}
	}

	removeImageLayer(id: string) {
		this.removeImageLayerInternal(id);
	}

	removeImageLayerInternal(id: string) {
		const idx = this.imageLayers.findIndex((item) => item._imageLayerData?.id === id);
		if (idx >= 0) {
			const imageObject = this.imageLayers[idx];
			const wasActive = this.canvas.getActiveObject?.() === imageObject;
			this.canvas.remove(imageObject);
			this.imageLayers.splice(idx, 1);
			// P1 OOM fix — release the removed layer's backing bitmap/cache so it's GC'd.
			// Undo re-adds via addImageLayerInternal(), which reloads the object FRESH
			// from the stored URL, so disposing the detached object here is safe.
			this.disposeFabricImageObject(imageObject);
			this.normalizeImageLayerIndexes();
			if (wasActive) {
				this.canvas.discardActiveObject?.();
				this.onImageLayerSelect?.(null);
			}
			this.canvas.requestRenderAll();
			this.emitImageLayersChange();
		}
	}

	selectTextLayer(id: string): TextLayer | null {
		const textObject = this.findTextObject(id);
		if (!textObject) return null;
		this.selectedImageLayerIdForBrush = null;
		this.canvas.setActiveObject(textObject);
		this.canvas.requestRenderAll();
		const layer = this.syncTextObjectData(textObject);
		this.onTextLayerSelect?.(layer);
		return layer;
	}

	selectImageLayer(id: string): ImageLayer | null {
		const imageObject = this.findImageObject(id);
		if (!imageObject) return null;
		this.selectedImageLayerIdForBrush = id;
		this.clearImageLayerSnapGuides(false);
		this.canvas.setActiveObject(imageObject);
		this.canvas.requestRenderAll();
		const layer = this.syncImageObjectData(imageObject);
		this.onTextLayerSelect?.(null);
		this.onImageLayerSelect?.(layer);
		return layer;
	}

	clearSelection(): void {
		this.selectedImageLayerIdForBrush = null;
		this.clearImageLayerSnapGuides(false);
		this.canvas.discardActiveObject?.();
		this.canvas.requestRenderAll();
		this.onTextLayerSelect?.(null);
		this.onImageLayerSelect?.(null);
	}

	editTextLayer(id: string): TextLayer | null {
		const textObject = this.findTextObject(id);
		if (!textObject) return null;
		const layer = this.serializeTextObject(textObject);
		this.canvas.setActiveObject(textObject);
		if (layer.visible !== false && layer.locked !== true && typeof textObject.enterEditing === "function") {
			textObject.enterEditing();
			textObject.hiddenTextarea?.focus?.();
		}
		this.canvas.requestRenderAll();
		const syncedLayer = this.syncTextObjectData(textObject);
		this.onTextLayerSelect?.(syncedLayer);
		return syncedLayer;
	}

	updateTextLayer(id: string, updates: Partial<Pick<TextLayer, "name" | "text" | "sourceText" | "sourceCategory" | "sourceProvider" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "alignment" | "fontSize" | "charSpacing" | "skewX" | "skewY" | "fontFamily" | "fill" | "stroke" | "strokeWidth" | "visible" | "locked" | "effects">>): TextLayer | null {
		const textObject = this.findTextObject(id);
		if (!textObject) return null;
		const existingLayer = this.serializeTextObject(textObject);
		const nextUpdates: typeof updates = existingLayer.locked === true
			? {
				...(Object.prototype.hasOwnProperty.call(updates, "visible") ? { visible: updates.visible } : {}),
				...(Object.prototype.hasOwnProperty.call(updates, "locked") ? { locked: updates.locked } : {}),
			}
			: updates;
		if (existingLayer.locked === true && Object.keys(nextUpdates).length === 0) {
			return existingLayer;
		}
		const currentEffects = existingLayer.effects;
		const hasEffectsUpdate = Object.prototype.hasOwnProperty.call(nextUpdates, "effects");
		let nextEffects = hasEffectsUpdate ? nextUpdates.effects ?? undefined : currentEffects;
		if (nextEffects?.stroke?.enabled && (nextUpdates.stroke !== undefined || nextUpdates.strokeWidth !== undefined)) {
			nextEffects = {
				...nextEffects,
				stroke: {
					...nextEffects.stroke,
					color: nextUpdates.stroke ?? nextEffects.stroke.color,
					width: nextUpdates.strokeWidth ?? nextEffects.stroke.width,
				},
			};
		}
		const shouldApplyEffects = hasEffectsUpdate || nextEffects !== currentEffects;

		const hasNameUpdate = Object.prototype.hasOwnProperty.call(nextUpdates, "name");
		const hasSourceTextUpdate = Object.prototype.hasOwnProperty.call(nextUpdates, "sourceText");
		const hasSourceCategoryUpdate = Object.prototype.hasOwnProperty.call(nextUpdates, "sourceCategory");
		const hasSourceProviderUpdate = Object.prototype.hasOwnProperty.call(nextUpdates, "sourceProvider");
		if (hasNameUpdate || hasSourceTextUpdate || hasSourceCategoryUpdate || hasSourceProviderUpdate) {
			textObject._textLayerData = {
				...(textObject._textLayerData as TextLayer),
				...(hasNameUpdate ? { name: nextUpdates.name || undefined } : {}),
				...(hasSourceTextUpdate ? { sourceText: nextUpdates.sourceText || undefined } : {}),
				...(hasSourceCategoryUpdate ? { sourceCategory: nextUpdates.sourceCategory } : {}),
				...(hasSourceProviderUpdate ? { sourceProvider: nextUpdates.sourceProvider || undefined } : {}),
			};
		}
		if (nextUpdates.text !== undefined) {
			textObject.set({ text: nextUpdates.text });
		}
		if (nextUpdates.alignment !== undefined) {
			textObject.set({ textAlign: nextUpdates.alignment });
		}
		if (nextUpdates.fontSize !== undefined) {
			textObject.set({ fontSize: this.imageWToCanvasW(nextUpdates.fontSize) });
		}
		if (nextUpdates.charSpacing !== undefined) {
			textObject.set({ charSpacing: Math.max(-500, Math.min(1000, Math.round(nextUpdates.charSpacing))) });
		}
		if (nextUpdates.skewX !== undefined) {
			textObject.set({ skewX: Math.max(-45, Math.min(45, Math.round(nextUpdates.skewX))) });
		}
		if (nextUpdates.skewY !== undefined) {
			textObject.set({ skewY: Math.max(-45, Math.min(45, Math.round(nextUpdates.skewY))) });
		}
		if (nextUpdates.fontFamily !== undefined) {
			textObject.set({ fontFamily: nextUpdates.fontFamily });
		}
		if (nextUpdates.fill !== undefined) {
			textObject.set({ fill: nextUpdates.fill });
		}
		if (nextUpdates.stroke !== undefined) {
			textObject.set({ stroke: nextUpdates.stroke, paintFirst: "stroke" });
		}
		if (nextUpdates.strokeWidth !== undefined) {
			textObject.set({ strokeWidth: this.imageWToCanvasW(Math.max(0, nextUpdates.strokeWidth)), paintFirst: "stroke" });
		}
		if (nextUpdates.opacity !== undefined) {
			textObject.set({ opacity: Math.max(0, Math.min(1, nextUpdates.opacity)) });
		}
		if (
			nextUpdates.x !== undefined
			|| nextUpdates.y !== undefined
			|| nextUpdates.w !== undefined
				|| nextUpdates.h !== undefined
				|| nextUpdates.rotation !== undefined
				|| nextUpdates.skewX !== undefined
				|| nextUpdates.skewY !== undefined
		) {
			const currentLayer = this.serializeTextObject(textObject);
			this.positionTextObjectFromLayer(textObject, {
				...currentLayer,
				x: nextUpdates.x ?? currentLayer.x,
				y: nextUpdates.y ?? currentLayer.y,
				w: Math.max(1, nextUpdates.w ?? currentLayer.w),
				h: Math.max(1, nextUpdates.h ?? currentLayer.h),
				rotation: nextUpdates.rotation ?? currentLayer.rotation,
				skewX: nextUpdates.skewX ?? currentLayer.skewX,
				skewY: nextUpdates.skewY ?? currentLayer.skewY,
			});
		}
		if (nextUpdates.visible !== undefined || nextUpdates.locked !== undefined) {
			const currentLayer = this.serializeTextObject(textObject);
			this.applyTextObjectLayerState(textObject, {
				...currentLayer,
				visible: nextUpdates.visible ?? currentLayer.visible,
				locked: nextUpdates.locked ?? currentLayer.locked,
			});
		}
		if (shouldApplyEffects) {
			const layerWithEffects = {
				...this.serializeTextObject(textObject),
				effects: nextEffects,
			};
			this.applyTextEffectsToObject(textObject, layerWithEffects, nextEffects);
		}
		if (!shouldApplyEffects) {
			const layerWithEffects = this.serializeTextObject(textObject);
			this.applyTextEffectsToObject(textObject, layerWithEffects, layerWithEffects.effects);
		}

		textObject.setCoords();
		this.syncCanvasLayerOrder(id);
		this.canvas.requestRenderAll();
		const layer = this.syncTextObjectData(textObject);
		this.emitTextLayersChange();
		this.onTextLayerSelect?.(layer);
		return layer;
	}

	updateTextLayerWithHistory(id: string, updates: Partial<Pick<TextLayer, "name" | "text" | "sourceText" | "sourceCategory" | "sourceProvider" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "alignment" | "fontSize" | "charSpacing" | "skewX" | "skewY" | "fontFamily" | "fill" | "stroke" | "strokeWidth" | "visible" | "locked" | "effects">>): TextLayer | null {
		const textObject = this.findTextObject(id);
		if (!textObject) return null;
		const beforeLayer = cloneTextLayerForHistory(this.serializeTextObject(textObject));
		const afterLayer = this.updateTextLayer(id, updates);
		if (!afterLayer || this.isTextLayerHistoryEqual(beforeLayer, afterLayer)) return afterLayer;

		this.history.executeCommand(new ModifyTextLayerCommand(this, id, beforeLayer, afterLayer));
		this.onHistoryChange?.();
		return afterLayer;
	}

	private isTextLayerHistoryEqual(beforeLayer: TextLayer, afterLayer: TextLayer): boolean {
		return JSON.stringify(cloneTextLayerForHistory(beforeLayer)) === JSON.stringify(cloneTextLayerForHistory(afterLayer));
	}

	updateImageLayer(
		id: string,
		updates: Partial<Pick<ImageLayer, "name" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "flipX" | "flipY" | "visible" | "locked" | "role" | "blendMode">>,
	): ImageLayer | null {
		return this.updateImageLayerInternal(id, updates);
	}

	updateImageLayerInternal(id: string, updates: Partial<ImageLayer>): ImageLayer | null {
		const imageObject = this.findImageObject(id);
		if (!imageObject) return null;

		const currentLayer = this.serializeImageObject(imageObject);
		const guardedUpdates: Partial<ImageLayer> = isAiResultImageLayer(currentLayer)
			? { ...updates, role: "overlay" }
			: updates;
		const nextLayer: ImageLayer = {
			...currentLayer,
			...guardedUpdates,
			w: Math.max(1, guardedUpdates.w ?? currentLayer.w),
			h: Math.max(1, guardedUpdates.h ?? currentLayer.h),
			opacity: Math.max(0, Math.min(1, guardedUpdates.opacity ?? currentLayer.opacity)),
			flipX: guardedUpdates.flipX ?? currentLayer.flipX ?? false,
			flipY: guardedUpdates.flipY ?? currentLayer.flipY ?? false,
			blendMode: normalizeImageLayerBlendMode(guardedUpdates.blendMode ?? currentLayer.blendMode),
		};

		const naturalWidth = Math.max(1, imageObject.width ?? 1);
		const naturalHeight = Math.max(1, imageObject.height ?? 1);
		imageObject.set({
			left: this.imageXToCanvasX(nextLayer.x + nextLayer.w / 2),
			top: this.imageYToCanvasY(nextLayer.y + nextLayer.h / 2),
			angle: nextLayer.rotation || 0,
			opacity: nextLayer.opacity,
			flipX: nextLayer.flipX === true,
			flipY: nextLayer.flipY === true,
			globalCompositeOperation: imageLayerBlendModeToCompositeOperation(nextLayer.blendMode),
		});
		imageObject.scaleX = this.imageWToCanvasW(nextLayer.w) / naturalWidth;
		imageObject.scaleY = this.imageHToCanvasH(nextLayer.h) / naturalHeight;
		if (updates.visible !== undefined || updates.locked !== undefined) {
			this.applyImageObjectLayerState(imageObject, nextLayer);
		} else {
			imageObject._imageLayerData = nextLayer;
		}

		imageObject.setCoords();
		this.canvas.requestRenderAll();
		const layer = this.syncImageObjectData(imageObject);
		this.emitImageLayersChange();
		this.onImageLayerSelect?.(layer);
		return layer;
	}

	async replaceImageLayerSourceInternal(id: string, layer: ImageLayer, imageUrl?: string, restoreImageUrl?: string): Promise<ImageLayer | null> {
		const imageObject = this.findImageObject(id);
		if (!imageObject) return null;
		if (imageUrl) await this.onImageLayerSourceChange?.(layer, imageUrl);

		const replacement = await this.createImageObject(layer, imageUrl, restoreImageUrl);
		replacement._imageLayerRestoreUrl = restoreImageUrl ?? imageObject._imageLayerRestoreUrl ?? replacement._imageLayerRestoreUrl;
		replacement._imageLayerRestoreElement = replacement._imageLayerRestoreElement
			?? imageObject._imageLayerRestoreElement
			?? this.getImageObjectSourceElement(imageObject);
		const layerIndex = this.imageLayers.indexOf(imageObject);
		if (layerIndex >= 0) {
			this.imageLayers[layerIndex] = replacement;
		}

		const canvasObjects = this.canvas.getObjects();
		const canvasIndex = canvasObjects.indexOf(imageObject);
		this.canvas.remove(imageObject);
		if (canvasIndex >= 0) {
			this.canvas.insertAt(canvasIndex, replacement);
		} else {
			this.canvas.add(replacement);
		}
		this.selectedImageLayerIdForBrush = layer.id;
		this.canvas.setActiveObject(replacement);
		this.syncCanvasLayerOrder(layer.id);
		this.canvas.requestRenderAll();
		this.emitImageLayersChange();
		const syncedLayer = this.serializeImageObject(replacement);
		this.onImageLayerSelect?.(syncedLayer);
		return syncedLayer;
	}

	async replaceImageLayerSourceWithHistory(id: string, layer: ImageLayer, imageUrl?: string, restoreImageUrl?: string): Promise<ImageLayer | null> {
		const imageObject = this.findImageObject(id);
		if (!imageObject) return null;

		const beforeLayer = this.cloneImageLayerForHistory(this.serializeImageObject(imageObject));
		const beforeImageUrl = imageObject._imageLayerUrl || this.projectImageUrlResolver?.(beforeLayer.imageId);
		const beforeRestoreImageUrl = imageObject._imageLayerRestoreUrl;
		const command = new ReplaceImageLayerSourceCommand(
			this,
			id,
			beforeLayer,
			beforeImageUrl,
			layer,
			imageUrl,
			beforeRestoreImageUrl,
			restoreImageUrl,
		);
		await command.execute();
		this.history.executeCommand(command);
		this.onHistoryChange?.();
		return this.findImageObject(id)?._imageLayerData ?? layer;
	}

	updateImageLayerWithHistory(
		id: string,
		updates: Partial<Pick<ImageLayer, "name" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "flipX" | "flipY" | "visible" | "locked" | "role" | "blendMode">>,
	): ImageLayer | null {
		const imageObject = this.findImageObject(id);
		if (!imageObject) return null;

		const beforeLayer = this.cloneImageLayerForHistory(this.serializeImageObject(imageObject));
		const afterLayer = this.updateImageLayerInternal(id, updates);
		if (!afterLayer || this.isImageLayerHistoryEqual(beforeLayer, afterLayer)) return afterLayer;

		this.recordImageLayerUpdateHistory(beforeLayer, afterLayer);
		return afterLayer;
	}

	updateImageLayersWithHistory(
		updatesById: Record<string, Partial<Pick<ImageLayer, "name" | "x" | "y" | "w" | "h" | "rotation" | "opacity" | "flipX" | "flipY" | "visible" | "locked" | "role" | "blendMode">>>,
		activeLayerId: string | null = null,
	): ImageLayer[] {
		const beforeLayers: ImageLayer[] = [];
		const afterLayers: ImageLayer[] = [];

		for (const [id, updates] of Object.entries(updatesById)) {
			const imageObject = this.findImageObject(id);
			if (!imageObject) continue;

			const beforeLayer = this.cloneImageLayerForHistory(this.serializeImageObject(imageObject));
			const afterLayer = this.updateImageLayerInternal(id, updates);
			if (!afterLayer || this.isImageLayerHistoryEqual(beforeLayer, afterLayer)) continue;

			beforeLayers.push(beforeLayer);
			afterLayers.push(this.cloneImageLayerForHistory(afterLayer));
		}

		if (!afterLayers.length) return [];

		const preservedActiveLayerId = activeLayerId;

		this.history.executeCommand(new BulkUpdateImageLayersCommand(
			this,
			beforeLayers,
			afterLayers,
			preservedActiveLayerId,
		));
		if (preservedActiveLayerId) {
			this.selectImageLayer(preservedActiveLayerId);
		}
		this.onHistoryChange?.();
		return afterLayers;
	}

	recordImageLayerUpdateHistory(beforeLayer: ImageLayer, afterLayer: ImageLayer): void {
		if (beforeLayer.id !== afterLayer.id) return;
		if (this.isImageLayerHistoryEqual(beforeLayer, afterLayer)) return;

		const command = new UpdateImageLayerCommand(
			this,
			this.cloneImageLayerForHistory(beforeLayer),
			this.cloneImageLayerForHistory(afterLayer),
		);
		this.history.executeCommand(command);
		this.onHistoryChange?.();
	}

	fitTextLayerToBox(id: string): TextLayer | null {
		const textObject = this.findTextObject(id);
		if (!textObject) return null;
		const currentLayer = this.serializeTextObject(textObject);
		if (currentLayer.locked === true || currentLayer.visible === false) return currentLayer;

		const boxWidth = this.imageWToCanvasW(currentLayer.w);
		const boxHeight = this.imageHToCanvasH(currentLayer.h);
		const fittedFontSize = this.calculateFittedTextFontSize(textObject, currentLayer);

		textObject.set({
			left: this.imageXToCanvasX(currentLayer.x + currentLayer.w / 2),
			top: this.imageYToCanvasY(currentLayer.y + currentLayer.h / 2),
			width: boxWidth,
			height: boxHeight,
			scaleX: 1,
			scaleY: 1,
			fontSize: this.imageWToCanvasW(fittedFontSize),
		});
		textObject._textLayerBoxWidth = boxWidth;
		textObject._textLayerBoxHeight = boxHeight;
		textObject.initDimensions?.();
		textObject.setCoords();
		this.canvas.requestRenderAll();

		const layer = this.syncTextObjectData(textObject);
		this.emitTextLayersChange();
		this.onTextLayerSelect?.(layer);
		return layer;
	}

	fitTextLayerToBoxWithHistory(id: string): TextLayer | null {
		const textObject = this.findTextObject(id);
		if (!textObject) return null;
		const beforeLayer = cloneTextLayerForHistory(this.serializeTextObject(textObject));
		const afterLayer = this.fitTextLayerToBox(id);
		if (!afterLayer || this.isTextLayerHistoryEqual(beforeLayer, afterLayer)) return afterLayer;

		this.recordTextLayerUpdateHistory(beforeLayer, afterLayer);
		return afterLayer;
	}

	duplicateTextLayer(id: string, newId: string): TextLayer | null {
		const textObject = this.findTextObject(id);
		if (!textObject) return null;

		const sourceLayer = this.serializeTextObject(textObject);
		const insertIndex = this.textLayers.indexOf(textObject) + 1;
		const duplicateLayer: TextLayer = {
			...sourceLayer,
			id: newId,
			name: sourceLayer.name ? `${sourceLayer.name} copy` : undefined,
			// duplicate keeps the SAME visible text — the " copy" suffix belongs on the layer
			// NAME (above) for the panel, not on the rendered caption.
			text: sourceLayer.text,
			x: sourceLayer.x + 24,
			y: sourceLayer.y + 24,
			index: insertIndex,
			locked: false,
			visible: true,
		};
		const duplicateObject = this.createTextObject(duplicateLayer);
		this.textLayers.splice(insertIndex, 0, duplicateObject);
		this.normalizeTextLayerIndexes();
		this.syncCanvasTextLayerOrder(newId);
		this.canvas.requestRenderAll();
		const layer = this.syncTextObjectData(duplicateObject);
		this.emitTextLayersChange();
		this.onTextLayerSelect?.(layer);
		return layer;
	}

	duplicateTextLayerWithHistory(id: string, newId: string): TextLayer | null {
		const textObject = this.findTextObject(id);
		if (!textObject) return null;

		const sourceLayer = this.serializeTextObject(textObject);
		const insertIndex = this.textLayers.indexOf(textObject) + 1;
		const duplicateLayer: TextLayer = {
			...sourceLayer,
			id: newId,
			name: sourceLayer.name ? `${sourceLayer.name} copy` : undefined,
			// duplicate keeps the SAME visible text — the " copy" suffix belongs on the layer
			// NAME (above) for the panel, not on the rendered caption.
			text: sourceLayer.text,
			x: sourceLayer.x + 24,
			y: sourceLayer.y + 24,
			index: insertIndex,
			locked: false,
			visible: true,
		};
		const command = new AddTextLayerCommand(this, duplicateLayer);
		command.execute();
		this.history.executeCommand(command);
		this.onHistoryChange?.();
		const layer = this.selectTextLayer(newId);
		return layer;
	}

	private buildImageLayerDuplicate(id: string, newId: string): { layer: ImageLayer; imageUrl?: string } | null {
		const imageObject = this.findImageObject(id);
		if (!imageObject) return null;

		const sourceLayer = this.serializeImageObject(imageObject);
		const insertIndex = this.imageLayers.indexOf(imageObject) + 1;
		const duplicateLayer: ImageLayer = {
			...sourceLayer,
			id: newId,
			name: sourceLayer.name ? `${sourceLayer.name} copy` : undefined,
			x: sourceLayer.x + Math.max(12, Math.round(sourceLayer.w * 0.06)),
			y: sourceLayer.y + Math.max(12, Math.round(sourceLayer.h * 0.06)),
			index: insertIndex,
			locked: false,
			visible: true,
		};
		return {
			layer: duplicateLayer,
			imageUrl: imageObject._imageLayerUrl || this.projectImageUrlResolver?.(sourceLayer.imageId),
		};
	}

	async duplicateImageLayer(id: string, newId: string): Promise<ImageLayer | null> {
		const duplicate = this.buildImageLayerDuplicate(id, newId);
		if (!duplicate) return null;

		const layer = await this.addImageLayerInternal(duplicate.layer, duplicate.imageUrl);
		this.selectImageLayer(layer.id);
		return layer;
	}

	async duplicateImageLayerWithHistory(id: string, newId: string): Promise<ImageLayer | null> {
		const duplicate = this.buildImageLayerDuplicate(id, newId);
		if (!duplicate) return null;

		const command = new AddImageLayerCommand(this, duplicate.layer, duplicate.imageUrl);
		await command.execute();
		this.history.executeCommand(command);
		this.onHistoryChange?.();
		const layer = command.getLayer();
		return layer;
	}

	moveTextLayer(id: string, direction: -1 | 1): TextLayer | null {
		const currentIndex = this.textLayers.findIndex((textObject) => textObject._textLayerData?.id === id);
		if (currentIndex < 0) return null;
		const nextIndex = currentIndex + direction;
		if (nextIndex < 0 || nextIndex >= this.textLayers.length) {
			return this.serializeTextObject(this.textLayers[currentIndex]);
		}

		const neighborObject = this.textLayers[nextIndex];
		const [textObject] = this.textLayers.splice(currentIndex, 1);
		this.textLayers.splice(nextIndex, 0, textObject);
		this.normalizeTextLayerIndexes();
		this.swapLayerStackIndexes(textObject, neighborObject);
		this.syncCanvasTextLayerOrder(id);
		this.canvas.requestRenderAll();
		const layer = this.syncTextObjectData(textObject);
		this.emitTextLayersChange();
		this.onTextLayerSelect?.(layer);
		return layer;
	}

	private getImageLayerOrder(): string[] {
		return this.imageLayers
			.map((imageObject) => imageObject._imageLayerData?.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0);
	}

	moveImageLayer(id: string, direction: -1 | 1): ImageLayer | null {
		const currentIndex = this.imageLayers.findIndex((item) => item._imageLayerData?.id === id);
		if (currentIndex < 0) return null;
		const nextIndex = currentIndex + direction;
		if (nextIndex < 0 || nextIndex >= this.imageLayers.length) {
			return this.serializeImageObject(this.imageLayers[currentIndex]);
		}

		const neighborObject = this.imageLayers[nextIndex];
		const [imageObject] = this.imageLayers.splice(currentIndex, 1);
		this.imageLayers.splice(nextIndex, 0, imageObject);
		this.normalizeImageLayerIndexes();
		this.swapLayerStackIndexes(imageObject, neighborObject);
		this.syncCanvasLayerOrder(id);
		this.canvas.requestRenderAll();
		const layer = this.syncImageObjectData(imageObject);
		this.emitImageLayersChange();
		this.onImageLayerSelect?.(layer);
		return layer;
	}

	moveLayerInStack(kind: "text" | "image", id: string, direction: -1 | 1): TextLayer | ImageLayer | null {
		const entries = this.getUnifiedLayerStackEntries();
		const currentIndex = entries.findIndex((entry) => entry.kind === kind && entry.id === id);
		if (currentIndex < 0) return null;
		const nextIndex = currentIndex + direction;
		if (nextIndex < 0 || nextIndex >= entries.length) {
			const current = entries[currentIndex];
			return current.kind === "text"
				? this.serializeTextObject(current.object)
				: this.serializeImageObject(current.object);
		}

		const [entry] = entries.splice(currentIndex, 1);
		entries.splice(nextIndex, 0, entry);
		this.normalizeUnifiedLayerStackIndexes(entries);
		this.syncCanvasLayerOrder(id);
		this.canvas.requestRenderAll();
		const activeObject = kind === "text" ? this.findTextObject(id) : this.findImageObject(id);
		if (!activeObject) return null;
		if (kind === "text") {
			const layer = this.syncTextObjectData(activeObject);
			this.emitTextLayersChange();
			this.emitImageLayersChange();
			this.onTextLayerSelect?.(layer);
			return layer;
		}
		const layer = this.syncImageObjectData(activeObject);
		this.emitImageLayersChange();
		this.emitTextLayersChange();
		this.onImageLayerSelect?.(layer);
		return layer;
	}

	moveLayerInStackWithHistory(kind: "text" | "image", id: string, direction: -1 | 1): TextLayer | ImageLayer | null {
		const beforeOrder = this.getLayerStackOrder();
		const layer = this.moveLayerInStack(kind, id, direction);
		const afterOrder = this.getLayerStackOrder();
		if (!layer || this.isLayerStackOrderEqual(beforeOrder, afterOrder)) return layer;

		this.history.executeCommand(new ReorderMixedLayersCommand(this, beforeOrder, afterOrder, kind, id));
		this.onHistoryChange?.();
		return layer;
	}

	moveLayerInStackByOffsetWithHistory(kind: "text" | "image", id: string, offset: number): TextLayer | ImageLayer | null {
		if (!Number.isFinite(offset)) return null;
		const steps = Math.abs(Math.trunc(offset));
		if (steps === 0) return null;

		const direction: -1 | 1 = offset > 0 ? 1 : -1;
		const commands: Command[] = [];
		let layer: TextLayer | ImageLayer | null = null;

		for (let step = 0; step < steps; step += 1) {
			const beforeOrder = this.getLayerStackOrder();
			const movedLayer = this.moveLayerInStack(kind, id, direction);
			const afterOrder = this.getLayerStackOrder();
			if (!movedLayer || this.isLayerStackOrderEqual(beforeOrder, afterOrder)) {
				break;
			}
			layer = movedLayer;
			commands.push(new ReorderMixedLayersCommand(this, beforeOrder, afterOrder, kind, id));
		}

		if (commands.length > 0) {
			this.history.executeCommand(commands.length === 1 ? commands[0] : new CompositeCommand(commands));
			this.onHistoryChange?.();
		}
		return layer;
	}

	moveImageLayerWithHistory(id: string, direction: -1 | 1): ImageLayer | null {
		const beforeOrder = this.getImageLayerOrder();
		const layer = this.moveImageLayer(id, direction);
		const afterOrder = this.getImageLayerOrder();
		if (!layer || beforeOrder.join("\0") === afterOrder.join("\0")) return layer;

		this.history.executeCommand(new ReorderImageLayersCommand(this, beforeOrder, afterOrder, id));
		this.onHistoryChange?.();
		return layer;
	}

	setImageLayerOrderInternal(orderIds: string[], activeLayerId?: string): ImageLayer | null {
		const byId = new Map<string, any>();
		for (const imageObject of this.imageLayers) {
			const layerId = imageObject._imageLayerData?.id;
			if (layerId) byId.set(layerId, imageObject);
		}

		const used = new Set<string>();
		const ordered: any[] = [];
		for (const layerId of orderIds) {
			const imageObject = byId.get(layerId);
			if (!imageObject) continue;
			ordered.push(imageObject);
			used.add(layerId);
		}
		for (const imageObject of this.imageLayers) {
			const layerId = imageObject._imageLayerData?.id;
			if (!layerId || used.has(layerId)) continue;
			ordered.push(imageObject);
		}

		this.imageLayers = ordered;
		this.normalizeImageLayerIndexes();
		this.applyImageLayerStackOrderFromList();
		this.syncCanvasLayerOrder(activeLayerId);
		this.canvas.requestRenderAll();
		const activeObject = activeLayerId ? this.findImageObject(activeLayerId) : null;
		const layer = activeObject ? this.syncImageObjectData(activeObject) : null;
		this.emitImageLayersChange();
		if (layer) this.onImageLayerSelect?.(layer);
		return layer;
	}

	getSelectedTextLayer(): TextLayer | null {
		const active = this.canvas.getActiveObject();
		if (active && active._textLayerData) {
			return this.syncTextObjectData(active);
		}
		return null;
	}

	getSelectedImageLayer(): ImageLayer | null {
		const active = this.canvas.getActiveObject();
		if (active && active._imageLayerData) {
			return this.syncImageObjectData(active);
		}
		return null;
	}

	getAllTextLayers(): TextLayer[] {
		return this.textLayers.map((t) => this.serializeTextObject(t));
	}

	getAllImageLayers(): ImageLayer[] {
		return this.imageLayers.map((item) => this.serializeImageObject(item));
	}

	getTextLayersInSelection(): string[] {
		const crop = this.getCoverCrop();
		if (!crop) return [];

		return this.textLayers
			.filter((t) => {
				const layer = this.serializeTextObject(t);
				if (layer.visible === false) return false;
				const left = layer.x;
				const top = layer.y;
				const right = left + layer.w;
				const bottom = top + layer.h;
				return left < crop.x + crop.w && right > crop.x && top < crop.y + crop.h && bottom > crop.y;
			})
			.map((t) => t.text || "");
	}


		// --- Undo/Redo System ---

		/** Update background image with history tracking for undo */
		async updateBackgroundImageWithHistory(url: string, isAiResult = false): Promise<void> {
			if (this.currentImageUrl === url) return;
			const oldUrl = this.currentImageUrl;
			const command = new BackgroundImageCommand(this, url, oldUrl, isAiResult);
			await command.execute();
			this.history.executeCommand(command);
			this.currentImageUrl = url;
			this.onHistoryChange?.();
		}

		/** Add text layer with history tracking */
		addTextLayerWithHistory(layer: TextLayer): void {
			const command = new AddTextLayerCommand(this, layer);
			command.execute();
			this.history.executeCommand(command);
			this.onHistoryChange?.();
		}

		/** Remove text layer with history tracking */
		removeTextLayerWithHistory(id: string): void {
			const layers = this.getAllTextLayers();
			const layer = layers.find(l => l.id === id);
			if (layer) {
				const command = new RemoveTextLayerCommand(this, layer);
				command.execute();
				this.history.executeCommand(command);
				this.onHistoryChange?.();
			}
		}

		/** Add image layer with history tracking */
		async addImageLayerWithHistory(layer: ImageLayer, imageUrl?: string): Promise<ImageLayer> {
			const command = new AddImageLayerCommand(this, layer, imageUrl);
			await command.execute();
			this.history.executeCommand(command);
			this.onHistoryChange?.();
			return command.getLayer();
		}

		/** Remove image layer with history tracking */
		removeImageLayerWithHistory(id: string): void {
			const imageObject = this.findImageObject(id);
			if (!imageObject) return;

			const layer = this.serializeImageObject(imageObject);
			const imageUrl = imageObject._imageLayerUrl || this.projectImageUrlResolver?.(layer.imageId);
			const command = new RemoveImageLayerCommand(this, layer, imageUrl);
			command.execute();
			this.history.executeCommand(command);
			this.onHistoryChange?.();
		}

		/** Direct method without history (for undo/redo) */
		addTextLayerInternal(layer: TextLayer) {
			const insertIndex = Math.max(0, Math.min(layer.index ?? this.textLayers.length, this.textLayers.length));
			const text = this.createTextObject(this.assignMissingLayerStackIndex(
				{ ...layer, index: insertIndex },
				this.getNextLayerStackIndex(),
			));
			this.textLayers.splice(insertIndex, 0, text);
			this.normalizeTextLayerIndexes();
			this.canvas.add(text);
			this.syncCanvasLayerOrder(layer.id);
			this.canvas.requestRenderAll();
			this.emitTextLayersChange();
		}

		/** Direct remove method without history (for undo/redo) */
		removeTextLayerInternal(id: string) {
			const idx = this.textLayers.findIndex((t) => t._textLayerData?.id === id);
			if (idx >= 0) {
				this.removeTextEffectShadowPasses(id);
				this.canvas.remove(this.textLayers[idx]);
				this.textLayers.splice(idx, 1);
				this.normalizeTextLayerIndexes();
				this.canvas.requestRenderAll();
				this.emitTextLayersChange();
			}
		}

		replaceTextLayerInternal(id: string, layer: TextLayer): void {
			this.removeTextLayerInternal(id);
			this.addTextLayerInternal(layer);
		}

		/**
		 * Undo the last operation. P1-2 — serialized: the stack is popped and the async
		 * command awaited INSIDE a single chained tail promise, so concurrent/rapid
		 * undo+redo can never interleave (pop-while-another-command-is-mid-flight) and
		 * corrupt the history stack. Calls run strictly in press order.
		 */
		undo(): Promise<boolean> {
			return this.enqueueHistoryOp(async () => {
				const command = this.history.undo();
				if (command) {
					await command.undo();
					this.onHistoryChange?.();
					return true;
				}
				return false;
			});
		}

		/** Redo the last undone operation. Serialized with undo (see {@link undo}). */
		redo(): Promise<boolean> {
			return this.enqueueHistoryOp(async () => {
				const command = this.history.redo();
				if (command) {
					await command.execute();
					this.onHistoryChange?.();
					return true;
				}
				return false;
			});
		}

		/**
		 * Chain one undo/redo step onto the single history tail promise so steps run
		 * strictly one-at-a-time in call order. The stack pop happens INSIDE `op` (i.e.
		 * only once the previous step fully settled), which is what prevents interleaving.
		 * A failing op never wedges the chain — the tail always settles to a boolean.
		 */
		private enqueueHistoryOp(op: () => Promise<boolean>): Promise<boolean> {
			// Lazy-init the tail so a host built without the field initializer (e.g.
			// Object.create(MangaEditor.prototype) in unit tests) still serializes.
			if (!this.historyChain) this.historyChain = Promise.resolve(false);
			const next = this.historyChain.then(op, op);
			// Keep the tail alive but swallow rejections so one failed op can't poison
			// every subsequent undo/redo.
			this.historyChain = next.catch(() => false);
			return next;
		}

		/** Check if undo is available */
		canUndo(): boolean {
			return this.history.canUndo();
		}

		/** Check if redo is available */
		canRedo(): boolean {
			return this.history.canRedo();
		}

		getHistorySnapshot(): EditorHistorySnapshot {
			return this.history.snapshot();
		}

		/**
		 * Durable image URLs still restorable via LIVE undo/redo history. The storage GC
		 * (project store `reconcileSupersededEditImages`) consults this so it NEVER deletes
		 * a backend edit-blob a live undo/redo command would reload — a delete there 404s
		 * the restore (P1 undo data-loss). The set shrinks automatically as commands are
		 * evicted/cleared, re-exposing their blobs for GC on the next save sweep.
		 */
		getLiveHistoryImageRefs(): string[] {
			return this.history.collectImageRefs();
		}

		// --- Brush Erase Tool ---

		setBrushSize(size: number) {
			this.brushSize = size;
			this.refreshBrushPreview();
		}

		setBrushHardness(hardness: number) {
			this.brushHardness = hardness;
		}

		setBrushOpacity(opacity: number) {
			this.brushOpacity = opacity;
		}

		setBrushColor(color: string) {
			this.brushColor = color;
			this.refreshBrushPreview();
		}

		setBrushMode(mode: BrushMode) {
			this.brushMode = mode;
		}

		private ensureBrushPreview() {
			if (this.brushPreview) return this.brushPreview;

			this.brushPreview = new this.f.Circle({
				left: 0,
				top: 0,
				radius: 1,
				originX: "center",
				originY: "center",
				fill: "rgba(255,255,255,0.14)",
				stroke: "rgba(17,24,39,0.9)",
				strokeWidth: 1,
				strokeDashArray: [4, 4],
				selectable: false,
				evented: false,
				visible: false,
				excludeFromExport: true,
				objectCaching: false,
			});
			this.canvas.add(this.brushPreview);
			this.brushPreview.bringToFront?.();
			// Constrain the preview to the active page when the per-page clip is on.
			this.applyToolClip();
			return this.brushPreview;
		}

		private showBrushPreview(pointer: any, blocked = false) {
			const preview = this.ensureBrushPreview();
			const zoom = this.canvas.getZoom() || 1;
			const sceneRadius = Math.max(1, this.brushSize / (2 * zoom));
			const strokeWidth = Math.max(0.5, 1 / zoom);
			preview._brushPreviewBlocked = blocked;
			preview.set({
				left: pointer.x,
				top: pointer.y,
				radius: sceneRadius,
				strokeWidth,
				strokeDashArray: blocked ? [2 / zoom, 3 / zoom] : [4 / zoom, 4 / zoom],
				// Dark ring on purpose: manga pages are mostly white, and the default
				// brushColor is #FFFFFF — tinting the ring by brushColor made the
				// cursor invisible (in-house review P2).
				fill: blocked ? "rgba(248,113,113,0.12)" : "rgba(17,24,39,0.12)",
				stroke: blocked ? "rgba(248,113,113,0.95)" : "rgba(17,24,39,0.9)",
				visible: true,
			});
			preview.bringToFront?.();
			this.canvas.requestRenderAll();
		}

		private updateBrushPreview(pointer: any) {
			if (this.tool !== "brush" || !this.brushEnabled) {
				this.hideBrushPreview();
				return;
			}

			const b = this.imageBounds;
			if (
				b.width <= 0 ||
				b.height <= 0 ||
				pointer.x < b.left ||
				pointer.x > b.left + b.width ||
				pointer.y < b.top ||
				pointer.y > b.top + b.height
			) {
				this.hideBrushPreview();
				return;
			}

			// Long-page guardrail: let the active page follow the hovered sub-page so
			// every logical page is reachable, then block the preview only when the
			// brush *footprint* would cross the (now-current) page cut.
			this.followActiveSegmentToPointer(pointer);
			if (this.isToolClipActive()) {
				const segment = this.getActiveSegmentBounds();
				if (segment) {
					const r = this.currentBrushSceneRadius();
					if (pointer.y - r < segment.top || pointer.y + r > segment.top + segment.height) {
						this.showBrushPreview(pointer, true);
						return;
					}
				}
			}

			const activeImageLayerId = this.canvas.getActiveObject?.()?._imageLayerData?.id ?? null;
			const hasImageLayerBrushTarget = Boolean(this.selectedImageLayerIdForBrush || activeImageLayerId);
			if (hasImageLayerBrushTarget && !this.getSelectedImageLayerBrushPoint(pointer)) {
				this.showBrushPreview(pointer, true);
				this.onBrushTargetMiss?.("นอกเลเยอร์ที่เลือก ขยับแปรงเข้าเลเยอร์ก่อนลบ");
				return;
			}

			if (hasImageLayerBrushTarget) {
				this.onBrushTargetMiss?.(null);
			}
			this.showBrushPreview(pointer, false);
		}

		private refreshBrushPreview() {
			if (!this.brushPreview?.visible) return;
			this.updateBrushPreview({
				x: this.brushPreview.left,
				y: this.brushPreview.top,
			});
		}

		private hideBrushPreview() {
			if (!this.brushPreview || this.brushPreview.visible === false) return;
			this.brushPreview.set({ visible: false });
			this.canvas.requestRenderAll();
		}

		async setAiOverlayImage(imageElement: HTMLImageElement) {
			this.aiOverlayImage = imageElement;

			if (!this.eraserCanvas) {
				this.eraserCanvas = document.createElement("canvas");
				this.eraserCtx = this.eraserCanvas.getContext("2d");
				if (!this.eraserCtx) {
					console.error("[editor] Failed to get 2D context for eraser canvas");
					return;
				}
			}

			if (!this.maskCanvas) {
				this.maskCanvas = document.createElement("canvas");
				this.maskCtx = this.maskCanvas.getContext("2d");
				if (!this.maskCtx) {
					console.error("[editor] Failed to get 2D context for mask canvas");
					return;
				}
			}

			const width = imageElement.naturalWidth || imageElement.width || this.imageWidth;
			const height = imageElement.naturalHeight || imageElement.height || this.imageHeight;
			this.eraserCanvas.width = width;
			this.eraserCanvas.height = height;
			this.maskCanvas.width = width;
			this.maskCanvas.height = height;

			if (!this.originalImageCache && this.originalImageDataUrl) {
				await new Promise<void>((resolve) => {
					const img = new Image();
					img.crossOrigin = "anonymous";
					img.onload = () => {
						this.originalImageCache = img;
						resolve();
					};
					img.onerror = () => resolve();
					img.src = this.originalImageDataUrl || "";
				});
			}

			this.eraserCtx.clearRect(0, 0, width, height);
			if (this.originalImageCache) {
				this.eraserCtx.drawImage(this.originalImageCache, 0, 0, width, height);
			}
			this.eraserCtx.drawImage(imageElement, 0, 0, width, height);

			this.maskCtx.clearRect(0, 0, width, height);
			this.onBrushTargetChange?.();
		}

		clearEraserMask() {
			if (this.hasPendingBrushCommit()) {
				const commitTarget = this.getBrushCommitTarget("background");
				this.setBrushCommitError(
					commitTarget,
					new Error("รอให้รอยแปรงก่อนหน้าบันทึกเสร็จก่อนคืนผล AI เต็ม"),
				);
				return;
			}
			if (this.maskCtx && this.maskCanvas) {
				this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
			}
			// Re-apply full layer stack: original image + AI overlay.
			// This is intentionally a flattened page edit, not an undo to the base image.
			if (this.eraserCtx && this.eraserCanvas) {
				this.eraserCtx.clearRect(0, 0, this.eraserCanvas.width, this.eraserCanvas.height);
				// Draw original image first (if available)
				if (this.originalImageCache) {
					this.eraserCtx.drawImage(this.originalImageCache, 0, 0, this.eraserCanvas.width, this.eraserCanvas.height);
				}
				// Draw AI overlay on top
				if (this.aiOverlayImage) {
					this.eraserCtx.drawImage(this.aiOverlayImage, 0, 0, this.eraserCanvas.width, this.eraserCanvas.height);
				}
				// Update the canvas display as a full-AI page edit.
				this.updateBackgroundWithErased("restore-full-ai");
			}
		}

		private startBrushStroke(pointer: any) {
			// P1 multi-pointer re-entry guard — the image-layer brush is single-pointer.
			// A second touch `pointerdown` reaches this BEFORE it is tracked for pinch,
			// so without this guard it would call createImageLayerBrushTarget() again
			// and overwrite `this.imageLayerBrushTarget`. Because the live preview has
			// already swapped the visible object's element to the FIRST stroke's working
			// canvas, the new target would capture that working canvas as its
			// `previousElement` — a later cancel would then "restore" to the uncommitted
			// preview bitmap instead of the true original, corrupting the layer. While an
			// image-layer brush gesture is in flight (target set, with or without an
			// active preview), the first stroke owns the gesture: drop the extra pointer
			// (it falls through to pinch/zoom tracking) and never clobber the target.
			if (this.imageLayerBrushTarget) {
				return;
			}
			if (!this.hasEditableBrushTarget()) {
				// UX P3 — don't silently swallow the stroke. If there's no editable
				// target the brush genuinely can't do anything; surface a brief, clear
				// reason (locked / hidden / no layer selected) instead of a dead click.
				this.onBrushTargetMiss?.(this.getNoBrushTargetMessage());
				this.hideBrushPreview();
				return;
			}
			if (!this.brushEnabled) {
				this.hideBrushPreview();
				return;
			}
			if (this.hasPendingBrushCommit()) {
				this.lastBrushTargetKind = null;
				this.hideBrushPreview();
				return;
			}

			// Long-page guardrail: bind the clip to the sub-page the stroke starts
			// on (so any logical page is editable, not only segment 0), then keep the
			// stroke inside that page unless multi-page mode is on (footprint-aware
			// clamp + toast handled by clipPointerToActivePage). A null result is a
			// horizontal off-page miss — drop the stroke instead of snapping it onto
			// the page edge.
			this.followActiveSegmentToPointer(pointer);
			const clampedStart = this.clipPointerToActivePage(pointer);
			if (!clampedStart) {
				this.lastBrushTargetKind = null;
				this.hideBrushPreview();
				return;
			}
			pointer = clampedStart;

			const selectedImageLayerPoint = this.getSelectedImageLayerBrushPoint(pointer);
			if (selectedImageLayerPoint) {
				this.onBrushTargetMiss?.(null);
				this.lastBrushTargetKind = "image-layer";
				this.isDrawing = true;
				this.imageLayerBrushTarget = this.createImageLayerBrushTarget(selectedImageLayerPoint);
				if (!this.imageLayerBrushTarget) {
					this.isDrawing = false;
					this.lastBrushTargetKind = null;
					return;
				}
				this.drawImageLayerBrushStroke(selectedImageLayerPoint.point);
				return;
			}
			if (this.selectedImageLayerIdForBrush || this.canvas.getActiveObject()?._imageLayerData) {
				this.lastBrushTargetKind = null;
				this.showBrushPreview(pointer, true);
				this.onBrushTargetMiss?.("นอกเลเยอร์ที่เลือก ขยับแปรงเข้าเลเยอร์ก่อนลบ");
				return;
			}

			if (!this.legacyAiMaskBrushEnabled || !this.maskCtx || !this.eraserCanvas || !this.aiOverlayImage) {
				this.lastBrushTargetKind = null;
				this.hideBrushPreview();
				return;
			}
			this.lastBrushTargetKind = "background";

			const imagePoint = this.getImagePointForBrush(pointer);
			if (!imagePoint) return;

			this.isDrawing = true;
			this.brushPath = [imagePoint];
			this.drawBrushStroke(imagePoint);
		}

		private continueBrushStroke(pointer: any) {
			// Clamp the dragged pointer to the active page so a stroke that drifts
			// across a boundary is held at the edge (footprint-aware, matches the
			// clipPath). A horizontal off-page miss (null) ends the segment of the
			// drag without painting along the image edge.
			const clamped = this.clipPointerToActivePage(pointer);
			if (!clamped) return;
			pointer = clamped;
			if (this.isDrawing && this.imageLayerBrushTarget) {
				const selectedImageLayerPoint = this.getImageLayerBrushPoint(this.imageLayerBrushTarget.imageObject, pointer);
				if (!selectedImageLayerPoint || selectedImageLayerPoint.layer.id !== this.imageLayerBrushTarget.layerId) return;

				const previousPoint = this.imageLayerBrushTarget.path[this.imageLayerBrushTarget.path.length - 1];
				this.imageLayerBrushTarget.path.push(selectedImageLayerPoint.point);
				this.drawImageLayerBrushStroke(selectedImageLayerPoint.point, previousPoint);
				return;
			}

			if (!this.isDrawing || !this.maskCtx) return;

			const imagePoint = this.getImagePointForBrush(pointer);
			if (!imagePoint) return;

			const previousPoint = this.brushPath[this.brushPath.length - 1];
			this.brushPath.push(imagePoint);
			this.drawBrushStroke(imagePoint, previousPoint);
		}

		private endBrushStroke() {
			if (this.imageLayerBrushTarget) {
				const target = this.imageLayerBrushTarget;
				this.isDrawing = false;
				this.brushPath = [];
				this.imageLayerBrushTarget = null;
				const commitTarget = this.getBrushCommitTarget("image-layer", target.layerId);
				this.setBrushCommitError(commitTarget, null);
				const commit = this.commitImageLayerBrushErase(target)
					.then(() => {
						this.setBrushCommitError(commitTarget, null);
					});
				this.pendingBrushCommits.add(commit);
				void commit
					.catch((error) => {
						this.setBrushCommitError(commitTarget, error);
						console.error("[MangaEditor] brush image-layer commit failed:", error);
					})
					.finally(() => {
						this.pendingBrushCommits.delete(commit);
					});
				return;
			}

			this.isDrawing = false;
			this.brushPath = [];
			this.applyEraserMask();
		}

		private getSelectedImageLayerBrushPoint(pointer: any): {
			layer: ImageLayer;
			imageObject: any;
			point: { x: number; y: number; radius: number; radiusX?: number; radiusY?: number };
		} | null {
			const active = this.canvas.getActiveObject();
			if (active?._imageLayerData) {
				return this.getImageLayerBrushPoint(active, pointer);
			}
			const selectedImageObject = this.selectedImageLayerIdForBrush
				? this.findImageObject(this.selectedImageLayerIdForBrush)
				: null;
			return selectedImageObject ? this.getImageLayerBrushPoint(selectedImageObject, pointer) : null;
		}

		private getImageLayerBrushPoint(imageObject: any, pointer: any): {
			layer: ImageLayer;
			imageObject: any;
			point: { x: number; y: number; radius: number; radiusX?: number; radiusY?: number };
		} | null {
			if (!imageObject?._imageLayerData) return null;
			const layer = imageObject._imageLayerData as ImageLayer;
			if (layer.locked === true || layer.visible === false) return null;

			const source = this.getImageObjectSourceElement(imageObject);
			const width = Math.max(1, Math.round((source as HTMLImageElement | HTMLCanvasElement)?.width ?? layer.w));
			const height = Math.max(1, Math.round((source as HTMLImageElement | HTMLCanvasElement)?.height ?? layer.h));
			const transform = typeof imageObject.calcTransformMatrix === "function"
				? imageObject.calcTransformMatrix()
				: null;
			const invertTransform = this.f?.util?.invertTransform;
			const transformPoint = this.f?.util?.transformPoint;
			if (!transform || typeof invertTransform !== "function" || typeof transformPoint !== "function") return null;

			// `width/height` here is the FULL source element (the brush target canvas +
			// committed image are full-source). A cropped layer's Fabric object centers
			// its local space on the CROP sub-rect (cropX/cropY + object width/height),
			// so the local point must be offset by the crop origin, not the full image's
			// half-extent — see imageLayerBrushSourcePoint for the full rationale (agy04).
			const localPoint = transformPoint({ x: pointer.x, y: pointer.y }, invertTransform(transform));
			const sourcePoint = imageLayerBrushSourcePoint({
				localX: localPoint.x,
				localY: localPoint.y,
				fullWidth: width,
				fullHeight: height,
				cropX: imageObject.cropX,
				cropY: imageObject.cropY,
				cropWidth: imageObject.width,
				cropHeight: imageObject.height,
			});
			if (!sourcePoint) return null;

			const zoom = this.canvas.getZoom() || 1;
			const sceneRadius = this.brushSize / (2 * zoom);
			// P1 non-uniform-scale footprint fix — the source-space footprint of the
			// round scene-space preview is an ELLIPSE when scaleX != scaleY. Compute both
			// per-axis radii (see imageLayerBrushSourceRadii); the painter draws the
			// matching ellipse instead of an isotropic circle that over-erased one axis.
			const { radius, radiusX, radiusY } = imageLayerBrushSourceRadii({
				sceneRadius,
				scaleX: imageObject.scaleX ?? 1,
				scaleY: imageObject.scaleY ?? 1,
			});

			return {
				layer,
				imageObject,
				point: {
					x: sourcePoint.x,
					y: sourcePoint.y,
					radius,
					radiusX,
					radiusY,
				},
			};
		}

		private createImageLayerBrushTarget(input: {
			layer: ImageLayer;
			imageObject: any;
			point: { x: number; y: number; radius: number; radiusX?: number; radiusY?: number };
		}): typeof this.imageLayerBrushTarget {
			const source = this.getImageObjectSourceElement(input.imageObject);
			if (!source) return null;

			const width = Math.max(1, Math.round((source as HTMLImageElement | HTMLCanvasElement).width || input.layer.w));
			const height = Math.max(1, Math.round((source as HTMLImageElement | HTMLCanvasElement).height || input.layer.h));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;

			ctx.clearRect(0, 0, width, height);
			ctx.drawImage(source, 0, 0, width, height);
			const restoreSource = input.imageObject._imageLayerRestoreElement as CanvasImageSource | undefined;
			if (this.brushMode === "restore" && !restoreSource) return null;
			let restoreCanvas: HTMLCanvasElement | undefined;
			if (this.brushMode === "restore" && restoreSource) {
				restoreCanvas = document.createElement("canvas");
				restoreCanvas.width = width;
				restoreCanvas.height = height;
				restoreCanvas.getContext("2d")?.drawImage(restoreSource, 0, 0, width, height);
			}
			return {
				layerId: input.layer.id,
				imageObject: input.imageObject,
				canvas,
				ctx,
				mode: this.brushMode,
				restoreCanvas,
				path: [input.point],
				previewActive: false,
				previousElement: source,
			};
		}

		// P1 non-uniform-scale footprint fix. The painted brush footprint in SOURCE
		// space is an ellipse (radiusX on X, radiusY on Y) — that is the source-space
		// preimage of the round on-screen preview when scaleX != scaleY. The 2D canvas
		// only paints isotropic round caps/arcs via lineWidth, so to draw the matching
		// ellipse we run the segment in an ANISOTROPIC transform: scale the context so
		// a circle of `baseR` becomes an ellipse of (radiusX, radiusY), and feed the
		// segment coordinates divided by the corresponding per-axis factor. When the
		// two radii are equal (uniform scale) the factors are 1 and this collapses back
		// to the original isotropic path exactly.
		private withImageLayerBrushFootprint(
			ctx: CanvasRenderingContext2D,
			point: { x: number; y: number; radius: number; radiusX?: number; radiusY?: number },
			baseR: number,
			previousPoint: { x: number; y: number } | undefined,
			draw: (
				c: CanvasRenderingContext2D,
				lineWidth: number,
				p: { x: number; y: number },
				prev?: { x: number; y: number },
			) => void,
		): void {
			// `point.radius` is the SMALLER source-space axis; radiusX/radiusY are the
			// per-axis source radii. Anisotropy factors are the per-axis ratio to the
			// min axis, so the isotropic `baseR` lineWidth (in min-axis units) stretches
			// to the larger axis. Missing radiusX/radiusY (legacy callers) → 1 (circle).
			const minR = Math.max(0.0001, point.radius);
			const sx = Math.max(0.0001, (point.radiusX ?? minR)) / minR;
			const sy = Math.max(0.0001, (point.radiusY ?? minR)) / minR;
			if (Math.abs(sx - sy) < 1e-6) {
				// Uniform — original fast path (no transform), isotropic round caps.
				draw(ctx, baseR * 2, point, previousPoint);
				return;
			}
			// Paint in a space scaled by (sx, sy): a `baseR`-radius circle there maps to
			// an ellipse of (baseR*sx, baseR*sy) in source pixels. Divide the segment
			// coordinates by the matching factor so they land at the intended position.
			ctx.save();
			ctx.scale(sx, sy);
			const tp = { x: point.x / sx, y: point.y / sy };
			const tprev = previousPoint ? { x: previousPoint.x / sx, y: previousPoint.y / sy } : undefined;
			draw(ctx, baseR * 2, tp, tprev);
			ctx.restore();
		}

		/**
		 * P1 live-preview — point the visible Fabric image object at the stroke's
		 * working canvas so erase/restore dabs show in REAL TIME (the off-screen
		 * `target.canvas` IS what we draw into; with the page image's objectCaching
		 * off it redraws from this element each render). Done once per stroke; the
		 * commit later reloads the object from the persisted URL, and a cancel restores
		 * `previousElement`.
		 */
		private ensureImageLayerBrushPreview(target: NonNullable<typeof this.imageLayerBrushTarget>): void {
			if (target.previewActive) return;
			try {
				if (typeof target.imageObject.setElement === "function") {
					target.imageObject.setElement(target.canvas);
				} else {
					target.imageObject._element = target.canvas;
					target.imageObject._originalElement = target.canvas;
				}
				target.imageObject.dirty = true;
				target.previewActive = true;
			} catch (e) {
				console.warn("[editor] image-layer brush live preview swap failed:", e);
			}
		}

		private drawImageLayerBrushStroke(
			point: { x: number; y: number; radius: number; radiusX?: number; radiusY?: number },
			previousPoint?: { x: number; y: number; radius: number },
		): void {
			const target = this.imageLayerBrushTarget;
			if (!target) return;
			if (target.mode === "restore" && target.restoreCanvas) {
				this.drawImageLayerRestoreStroke(target, point, previousPoint);
				this.ensureImageLayerBrushPreview(target);
				this.canvas.requestRenderAll();
				return;
			}

			const opacity = this.brushOpacity / 100;
			const hardness = Math.max(0, Math.min(this.brushHardness, 100));
			const softRadius = point.radius * (1 + (100 - hardness) / 100);

			target.ctx.save();
			target.ctx.globalCompositeOperation = "destination-out";
			target.ctx.lineCap = "round";
			target.ctx.lineJoin = "round";

			if (hardness < 100) {
				target.ctx.globalAlpha = opacity * (100 - hardness) / 200;
				this.withImageLayerBrushFootprint(target.ctx, point, softRadius, previousPoint, (c, lw, p, prev) =>
					this.drawImageLayerBrushSegment(c, lw, p, prev),
				);
			}

			target.ctx.globalAlpha = opacity;
			this.withImageLayerBrushFootprint(target.ctx, point, point.radius, previousPoint, (c, lw, p, prev) =>
				this.drawImageLayerBrushSegment(c, lw, p, prev),
			);
			target.ctx.restore();
			// Show the erase in real time: the visible image object now renders from
			// `target.canvas`, so a re-render reflects the just-erased pixels.
			this.ensureImageLayerBrushPreview(target);
			this.canvas.requestRenderAll();
		}

		private drawImageLayerBrushSegment(
			ctx: CanvasRenderingContext2D,
			lineWidth: number,
			point: { x: number; y: number },
			previousPoint?: { x: number; y: number },
		): void {
			ctx.lineWidth = lineWidth;
			ctx.beginPath();
			if (previousPoint) {
				ctx.moveTo(previousPoint.x, previousPoint.y);
				ctx.lineTo(point.x, point.y);
				ctx.stroke();
			} else {
				ctx.arc(point.x, point.y, lineWidth / 2, 0, Math.PI * 2);
				ctx.fill();
			}
		}

		private drawImageLayerRestoreStroke(
			target: NonNullable<typeof this.imageLayerBrushTarget>,
			point: { x: number; y: number; radius: number; radiusX?: number; radiusY?: number },
			previousPoint?: { x: number; y: number; radius: number },
		): void {
			if (!target.restoreCanvas) return;
			const pattern = target.ctx.createPattern(target.restoreCanvas, "no-repeat");
			if (!pattern) return;
			const opacity = this.brushOpacity / 100;
			const hardness = Math.max(0, Math.min(this.brushHardness, 100));
			const softRadius = point.radius * (1 + (100 - hardness) / 100);

			target.ctx.save();
			target.ctx.globalCompositeOperation = "source-over";
			target.ctx.lineCap = "round";
			target.ctx.lineJoin = "round";
			target.ctx.strokeStyle = pattern;
			target.ctx.fillStyle = pattern;

			if (hardness < 100) {
				target.ctx.globalAlpha = opacity * (100 - hardness) / 200;
				this.withImageLayerBrushFootprint(target.ctx, point, softRadius, previousPoint, (c, lw, p, prev) =>
					this.drawImageLayerBrushSegment(c, lw, p, prev),
				);
			}

			target.ctx.globalAlpha = opacity;
			this.withImageLayerBrushFootprint(target.ctx, point, point.radius, previousPoint, (c, lw, p, prev) =>
				this.drawImageLayerBrushSegment(c, lw, p, prev),
			);
			target.ctx.restore();
		}

		private async commitImageLayerBrushErase(target: NonNullable<typeof this.imageLayerBrushTarget>): Promise<void> {
			const imageObject = this.findImageObject(target.layerId);
			if (!imageObject) return;

			const currentLayer = this.serializeImageObject(imageObject);
			const beforeImageUrl = imageObject._imageLayerUrl || this.projectImageUrlResolver?.(currentLayer.imageId);
			const beforeRestoreImageUrl = imageObject._imageLayerRestoreUrl;
			const restoreImageUrl = beforeRestoreImageUrl || beforeImageUrl;
			// Encode the erased layer off the main thread. The URL is stored in the
			// undo/redo command, so it must outlive a single load → use a stable
			// `data:` URL (produced via the off-thread blob encoder) rather than a
			// revocable `blob:` URL. Synchronous `toDataURL` here froze the UI on a
			// large layer; this keeps the encode off the JS thread.
			const dataUrl = await canvasToDataUrlAsync(target.canvas);
			const layer: ImageLayer = {
				...currentLayer,
				imageId: `brush-${currentLayer.id}-${Date.now().toString(36)}.png`,
				imageName: currentLayer.imageName,
				restoreImageId: currentLayer.restoreImageId ?? currentLayer.imageId,
				originalName: currentLayer.originalName ?? currentLayer.imageName,
			};
			const command = new ReplaceImageLayerSourceCommand(this, currentLayer.id, currentLayer, beforeImageUrl, layer, dataUrl, beforeRestoreImageUrl, restoreImageUrl);
			await command.execute();
			this.history.executeCommand(command);
			this.onHistoryChange?.();
			const committedLayer = this.findImageObject(currentLayer.id)?._imageLayerData ?? layer;
			const receipt = {
				layerId: committedLayer.id,
				title: committedLayer.name || committedLayer.originalName || committedLayer.imageName,
				mode: target.mode,
				restoreImageId: committedLayer.restoreImageId,
			};
			this.lastImageLayerBrushCommit = receipt;
			this.onImageLayerBrushCommit?.(receipt);
		}

		async waitForPendingBrushCommit(forced = false): Promise<void> {
			// Instant-apply image tools buffer a single debounced background persist.
			// Flush it NOW (don't wait the full debounce) so the edit lands on the page
			// it was drawn on, BEFORE navigation advances currentPage (#248 nav-safety).
			// `forced` (teardown: sign-out / leave-workspace / project-close) guarantees
			// the persist gate settles even if the upload fails, so the loop below can
			// never spin on a never-resolving gate promise (#255 P1 deadlock).
			await this.flushPendingBackgroundPersist(forced);
			while (this.pendingBrushCommits.size) {
				await Promise.all(Array.from(this.pendingBrushCommits));
			}
			// P1 — the image-tool registry's deferred-replay microtask can still be
			// pending (and about to start a NEW commit) after the editor's busy set
			// empties. Drain it so the caller (page navigation) truly settles before
			// it advances `currentPage`; a freshly-replayed stroke that re-fills
			// pendingBrushCommits is awaited by the outer loop on the next iteration.
			if (this.onDrainImageToolReplay) {
				await this.onDrainImageToolReplay();
				// PR #264 — draining the registry awaits any in-flight off-thread heal
				// worker (waitForReplayIdle → waitForCommit). When that worker resolves
				// it runs applyToolPatchInstant on THIS page, which arms a fresh debounced
				// persist. FLUSH it now (don't wait the full ~800ms debounce) so the
				// edit lands on the page it was drawn on before currentPage advances.
				await this.flushPendingBackgroundPersist(forced);
				while (this.pendingBrushCommits.size) {
					await Promise.all(Array.from(this.pendingBrushCommits));
					await this.onDrainImageToolReplay();
					await this.flushPendingBackgroundPersist(forced);
				}
			}
			const error = this.getFirstBrushCommitError();
			if (error) {
				throw error;
			}
		}

		/**
		 * P1 wrong-page-corruption fix. Discard any image-tool stroke that was
		 * buffered while a paint commit was settling, so it can NEVER replay onto a
		 * different page than the one it was drawn on. Page navigation calls this
		 * AFTER awaiting the in-flight commit and BEFORE it advances `currentPage`.
		 */
		cancelImageToolDeferredReplay(): void {
			this.onCancelImageToolReplay?.();
		}

		/**
		 * P1 cancel-stroke-on-nav fix. Abandon any IN-PROGRESS pointer gesture (a
		 * stroke whose pointerDown fired but pointerUp has NOT) WITHOUT committing it,
		 * against the page it was drawn on, BEFORE the image/page changes. Covers BOTH
		 * paint engines:
		 *
		 *  - the image-edit suite (clone/heal): delegated to the registry's
		 *    cancelActiveGesture() via onCancelImageToolActiveGesture, which deactivates
		 *    + re-activates the active tool so its half-painted accumulators are dropped.
		 *  - the LEGACY engine brush (AI-mask erase + image-layer erase): the active
		 *    `isDrawing`/`brushPath`/`imageLayerBrushTarget` state survives loadImage();
		 *    on the next move/up it would composite OLD-page pixels (the off-screen
		 *    target canvas) onto the NEW page. Clear it here so the pending stroke is
		 *    discarded, never committed.
		 *
		 * Called by loadImage() (every page switch / image reload) before the new
		 * bitmap replaces the old one.
		 */
		cancelActiveBrushGesture(): void {
			// Image-edit suite (registry-owned) — discard its live stroke first.
			this.onCancelImageToolActiveGesture?.();
			// Legacy engine brush — drop the in-progress stroke buffers WITHOUT running
			// endBrushStroke()/applyEraserMask()/commitImageLayerBrushErase(), so no
			// old-page pixels get committed onto the new page.
			if (this.isDrawing || this.imageLayerBrushTarget || this.brushPath.length) {
				// P1 live-preview cleanup — if this stroke swapped the visible object's
				// element to its working canvas, restore the ORIGINAL element so the
				// abandoned (uncommitted) erase doesn't stick on the canvas.
				this.restoreImageLayerBrushPreview(this.imageLayerBrushTarget);
				this.isDrawing = false;
				this.brushPath = [];
				this.imageLayerBrushTarget = null;
				this.lastBrushTargetKind = null;
			}
			// P1 brush/pinch pointer-OWNERSHIP — this is the canonical stroke-ABANDON path
			// (nav, tool-switch, brush-disable, pinch promotion, pointer-cancel all route
			// here), so always release the owning pointer id. The touchPointers size
			// accounting stays in the pointer handlers: pinch start re-adds both fingers;
			// cancel/up deletes the entry.
			this.brushPointerId = null;
		}

		/**
		 * P1 stuck-preview fix — un-swap the visible Fabric image object back to its
		 * ORIGINAL element so an uncommitted live brush preview does not stick on the
		 * canvas. Idempotent: a no-op once `previewActive` is false (so it never
		 * double-restores). The working `target.canvas` becomes unreferenced after this
		 * and is GC'd with the (now-null) target; its dimensions are zeroed so the
		 * backing bitmap is released promptly without waiting on GC (consistent with
		 * disposeFabricImageObject). Called from EVERY gesture-exit path that abandons a
		 * stroke without committing: nav (cancelActiveBrushGesture), tool-switch, and
		 * brush-disable.
		 */
		private restoreImageLayerBrushPreview(
			target: NonNullable<typeof this.imageLayerBrushTarget> | null,
		): void {
			if (!target?.previewActive) return;
			try {
				if (target.previousElement) {
					if (typeof target.imageObject.setElement === "function") {
						target.imageObject.setElement(target.previousElement);
					} else {
						target.imageObject._element = target.previousElement;
						target.imageObject._originalElement = target.previousElement;
					}
					target.imageObject.dirty = true;
				}
			} catch (e) {
				console.warn("[editor] image-layer brush preview restore failed:", e);
			}
			// Mark restored so a second call (e.g. tool-switch then nav) is a no-op.
			target.previewActive = false;
			// Release the working canvas' backing bitmap promptly; it is no longer the
			// visible element and nothing else references it once the target is cleared.
			try {
				target.canvas.width = 0;
				target.canvas.height = 0;
			} catch {
				// ignore — best-effort release
			}
			this.canvas.requestRenderAll();
		}

		getBrushCommitErrorMessage(): string | null {
			const error = this.getFirstBrushCommitError();
			if (!error) return null;
			return error instanceof Error && error.message
				? error.message
				: "บันทึกรอยแปรงไม่สำเร็จ";
		}

		private getBrushCommitTarget(kind: BrushCommitTarget["kind"], id = "current-page"): BrushCommitTarget {
			return { kind, id };
		}

		private getBrushCommitTargetKey(target: BrushCommitTarget): string {
			return `${target.kind}:${target.id || "current-page"}`;
		}

		private getFirstBrushCommitError(): unknown | null {
			return this.brushCommitErrors.values().next().value ?? null;
		}

		private setBrushCommitError(target: BrushCommitTarget, error: unknown | null): void {
			const key = this.getBrushCommitTargetKey(target);
			if (error) {
				this.brushCommitErrors.set(key, error);
			} else {
				this.brushCommitErrors.delete(key);
			}
			this.onBrushCommitErrorChange?.(this.getBrushCommitErrorMessage());
		}

		hasPendingBrushCommit(): boolean {
			// `pendingBrushCommits` covers the debounced persist gate (instant-apply
			// already ran) and legacy full-image commits. PR #264 added an OFF-THREAD
			// heal solve: between `await inpaintRegion()` and `applyToolPatchInstant`
			// the stroke is in the registry's `commitInFlight` but has NOT yet armed a
			// persist gate. Reflect that in-flight worker op here so every wait-before-
			// nav/teardown/export/save path (which gates on this) ALSO blocks on the
			// worker solve — closing the reopened #248/#255 wrong-page race.
			if (this.pendingBrushCommits.size > 0) return true;
			return this.onIsImageToolCommitInFlight?.() ?? false;
		}

		hasBrushCommitError(): boolean {
			return this.brushCommitErrors.size > 0;
		}

		private getImagePointForBrush(pointer: any): { x: number; y: number; radius: number } | null {
			const b = this.imageBounds;
			if (
				b.width <= 0 ||
				b.height <= 0 ||
				pointer.x < b.left ||
				pointer.x > b.left + b.width ||
				pointer.y < b.top ||
				pointer.y > b.top + b.height
			) {
				return null;
			}

			const scaleX = this.imageWidth / b.width;
			const scaleY = this.imageHeight / b.height;
			const zoom = this.canvas.getZoom() || 1;
			const sceneRadius = this.brushSize / (2 * zoom);
			const radius = Math.max(1, sceneRadius * Math.max(scaleX, scaleY));

			return {
				x: Math.max(0, Math.min((pointer.x - b.left) * scaleX, this.imageWidth)),
				y: Math.max(0, Math.min((pointer.y - b.top) * scaleY, this.imageHeight)),
				radius,
			};
		}

		private drawBrushStroke(
			point: { x: number; y: number; radius: number; radiusX?: number; radiusY?: number },
			previousPoint?: { x: number; y: number; radius: number },
		) {
			if (!this.maskCtx) return;

			const radius = point.radius;
			const opacity = this.brushOpacity / 100;
			const hardness = Math.max(0, Math.min(this.brushHardness, 100));
			const softRadius = radius * (1 + (100 - hardness) / 100);

			this.maskCtx.save();
			this.maskCtx.globalCompositeOperation = "source-over";
			this.maskCtx.lineCap = "round";
			this.maskCtx.lineJoin = "round";

			if (hardness < 100) {
				this.maskCtx.globalAlpha = opacity * (100 - hardness) / 200;
				this.maskCtx.strokeStyle = "rgba(255, 255, 255, 1)";
				this.maskCtx.fillStyle = "rgba(255, 255, 255, 1)";
				this.maskCtx.lineWidth = softRadius * 2;
				this.drawMaskSegment(point, previousPoint);
			}

			this.maskCtx.globalAlpha = opacity;
			this.maskCtx.strokeStyle = "rgba(255, 255, 255, 1)";
			this.maskCtx.fillStyle = "rgba(255, 255, 255, 1)";
			this.maskCtx.lineWidth = radius * 2;
			this.drawMaskSegment(point, previousPoint);
			this.maskCtx.restore();
		}

		private drawMaskSegment(
			point: { x: number; y: number },
			previousPoint?: { x: number; y: number },
		) {
			if (!this.maskCtx) return;

			this.maskCtx.beginPath();
			if (previousPoint) {
				this.maskCtx.moveTo(previousPoint.x, previousPoint.y);
				this.maskCtx.lineTo(point.x, point.y);
				this.maskCtx.stroke();
			} else {
				this.maskCtx.arc(point.x, point.y, this.maskCtx.lineWidth / 2, 0, Math.PI * 2);
				this.maskCtx.fill();
			}
		}

		private applyEraserMask() {
			if (!this.maskCtx || !this.eraserCanvas || !this.eraserCtx || !this.aiOverlayImage) return;

			// Use reusable canvas for compositing to avoid memory leaks
			if (!this.compositeCanvas) {
				this.compositeCanvas = document.createElement("canvas");
				this.compositeCtx = this.compositeCanvas.getContext("2d");
				if (!this.compositeCtx) {
					console.error("[editor] Failed to get 2D context for composite canvas");
					return;
				}
			}
			if (!this.aiCanvas) {
				this.aiCanvas = document.createElement("canvas");
				this.aiCtx = this.aiCanvas.getContext("2d");
				if (!this.aiCtx) {
					console.error("[editor] Failed to get 2D context for AI canvas");
					return;
				}
			}

			// Resize canvases if needed
			this.compositeCanvas.width = this.eraserCanvas.width;
			this.compositeCanvas.height = this.eraserCanvas.height;
			this.aiCanvas.width = this.eraserCanvas.width;
			this.aiCanvas.height = this.eraserCanvas.height;

			// Step 1: Draw original image as base layer (if available)
			this.compositeCtx.clearRect(0, 0, this.compositeCanvas.width, this.compositeCanvas.height);
			if (this.originalImageCache && this.compositeCtx) {
				this.compositeCtx.drawImage(this.originalImageCache, 0, 0, this.compositeCanvas.width, this.compositeCanvas.height);
			}

			// Step 2: Draw AI overlay and apply mask to it
			if (this.aiCtx) {
				this.aiCtx.clearRect(0, 0, this.aiCanvas.width, this.aiCanvas.height);
				this.aiCtx.drawImage(this.aiOverlayImage, 0, 0, this.aiCanvas.width, this.aiCanvas.height);

				// Use mask to erase from AI overlay only (not original image)
				this.aiCtx.globalCompositeOperation = "destination-out";
				if (this.maskCanvas) {
					this.aiCtx.drawImage(this.maskCanvas, 0, 0);
				}
				this.aiCtx.globalCompositeOperation = "source-over";

				// Step 3: Draw the masked AI overlay on top of original image
				if (this.compositeCtx) {
					this.compositeCtx.drawImage(this.aiCanvas, 0, 0);
				}
			}

			// Update the eraser canvas with the composited result
			if (this.compositeCanvas) {
				this.eraserCtx.clearRect(0, 0, this.eraserCanvas.width, this.eraserCanvas.height);
				this.eraserCtx.drawImage(this.compositeCanvas, 0, 0);
			}

			// Update the background image with erased result
			this.updateBackgroundWithErased("brush-mask");
		}

		private updateBackgroundWithErased(reason: "brush-mask" | "restore-full-ai" = "brush-mask") {
			const eraserCanvas = this.eraserCanvas;
			if (!eraserCanvas) return;

			// Encode the erased page asynchronously (off the main thread) to a
			// `blob:` URL. `eraserCanvas.toDataURL()` is a synchronous PNG encode of
			// the full-resolution page that froze the UI on every stroke end. The
			// encode + persistence + bitmap reload all run as a single pending
			// commit so the busy/commit-pending gates stay accurate.
			const commitTarget = this.getBrushCommitTarget("background");
			this.setBrushCommitError(commitTarget, null);
			const commit = canvasToBlobUrl(eraserCanvas).then(async (blobUrl) => {
				if (!blobUrl) return;
				this.currentImageUrl = blobUrl;
				try {
					if (this.onBackgroundImageSourceChange) {
						const persistedUrl = await this.onBackgroundImageSourceChange(blobUrl, reason);
						if (typeof persistedUrl === "string" && persistedUrl) {
							this.currentImageUrl = persistedUrl;
						}
						this.setBrushCommitError(commitTarget, null);
					}
					await this.reloadBackgroundFromUrl(blobUrl);
				} finally {
					if (blobUrl.startsWith("blob:")) {
						try {
							URL.revokeObjectURL(blobUrl);
						} catch {
							/* best effort */
						}
					}
				}
			});
			this.pendingBrushCommits.add(commit);
			void commit
				.catch((error) => {
					this.setBrushCommitError(commitTarget, error);
					console.error("[MangaEditor] brush background commit failed:", error);
				})
				.finally(() => {
					this.pendingBrushCommits.delete(commit);
				});
		}

		/** Reload a committed background bitmap into the canvas as the page image. */
		private async reloadBackgroundFromUrl(url: string): Promise<void> {
			// Same-origin blob:/data: URLs must NOT carry crossOrigin (see
			// commitToolBackground) or the <img> load fails with "Error loading blob:".
			const isLocalUrl = url.startsWith("blob:") || url.startsWith("data:");
			const img = await this.loadFabricImage(url, isLocalUrl ? undefined : { crossOrigin: "anonymous" });
			const bg = this.canvas.getObjects().find((obj: any) => obj.type === "image" && !obj._isEditComposite);
			if (bg) this.canvas.remove(bg);
			this.imageItem = img;
			this.imageWidth = img.width || this.imageWidth || 1;
			this.imageHeight = img.height || this.imageHeight || 1;
			this._centerImage(img);
			img.set(LOCKED_PAGE_IMAGE_OPTIONS);
			this.canvas.insertAt(0, img);
			this.canvas.requestRenderAll();
		}

		// --- Processing Indicators for AI Jobs ---

		showProcessingIndicator(jobId: string, crop: { x: number; y: number; w: number; h: number }, stage: "uploading" | "processing" | "downloading" | "complete" | "failed"): void {
			this.hideProcessingIndicator(jobId);

			// Don't show indicator if no image is loaded yet
			if (!this.imageItem || this.imageWidth === 0) {
				return;
			}

			const b = this.imageBounds;
			const scaleX = b.width / this.imageWidth;
			const scaleY = b.height / this.imageHeight;

			const canvasX = b.left + crop.x * scaleX;
			const canvasY = b.top + crop.y * scaleY;
			const canvasW = crop.w * scaleX;
			const canvasH = crop.h * scaleY;

			const invZoom = 1 / (this.canvas.getZoom() || 1);

			const stageColors = {
				uploading: { stroke: "#60a5fa", fill: "rgba(59, 130, 246, 0.06)", label: "Uploading" },
				processing: { stroke: "#fbbf24", fill: "rgba(249, 115, 22, 0.07)", label: "Processing" },
				downloading: { stroke: "#c084fc", fill: "rgba(168, 85, 247, 0.06)", label: "Downloading" },
				complete: { stroke: "#34d399", fill: "rgba(34, 197, 94, 0.05)", label: "Done" },
				failed: { stroke: "#fb7185", fill: "rgba(239, 68, 68, 0.08)", label: "Failed" }
			};

			const { stroke, fill, label } = stageColors[stage];

			const indicator = new this.f.Rect({
				left: canvasX,
				top: canvasY,
				width: canvasW,
				height: canvasH,
				fill,
				stroke,
				strokeWidth: 2 * invZoom,
				strokeDashArray: stage === "processing" ? [8 * invZoom, 6 * invZoom] : undefined,
				selectable: false,
				evented: false,
				objectCaching: false
			});

			const labelText = new this.f.Text(label, {
				left: canvasX,
				top: canvasY - 24 * invZoom,
				fontSize: 12 * invZoom,
				fontWeight: "bold",
				fill: stroke,
				backgroundColor: "rgba(10, 12, 15, 0.78)",
				selectable: false,
				evented: false,
				objectCaching: false
			});

			this.canvas.add(indicator);
			this.canvas.add(labelText);
			this.canvas.requestRenderAll();

			this.processingIndicators.set(jobId, { rect: indicator, label: labelText, crop });

			if (stage === "processing") {
				this.animateProcessingIndicator(jobId);
			}
		}

		updateProcessingIndicator(jobId: string, stage: "uploading" | "processing" | "downloading" | "complete" | "failed"): void {
			const indicator = this.processingIndicators.get(jobId);
			if (!indicator) return;

			const invZoom = 1 / (this.canvas.getZoom() || 1);

			const stageColors = {
				uploading: { stroke: "#60a5fa", fill: "rgba(59, 130, 246, 0.06)", label: "Uploading" },
				processing: { stroke: "#fbbf24", fill: "rgba(249, 115, 22, 0.07)", label: "Processing" },
				downloading: { stroke: "#c084fc", fill: "rgba(168, 85, 247, 0.06)", label: "Downloading" },
				complete: { stroke: "#34d399", fill: "rgba(34, 197, 94, 0.05)", label: "Done" },
				failed: { stroke: "#fb7185", fill: "rgba(239, 68, 68, 0.08)", label: "Failed" }
			};

			const { stroke, fill, label } = stageColors[stage];

			if (indicator.animationId) {
				cancelAnimationFrame(indicator.animationId);
				indicator.animationId = null;
			}

			indicator.rect.set({
				fill,
				stroke,
				strokeWidth: 2 * invZoom,
				strokeDashArray: stage === "processing" ? [8 * invZoom, 6 * invZoom] : undefined
			});

			indicator.label.set({
				fill: stroke,
				text: label
			});

			this.canvas.requestRenderAll();

			if (stage === "processing") {
				this.animateProcessingIndicator(jobId);
			}
		}

		hideProcessingIndicator(jobId: string): void {
			const indicator = this.processingIndicators.get(jobId);
			if (!indicator) return;

			if (indicator.animationId) {
				cancelAnimationFrame(indicator.animationId);
			}

			this.canvas.remove(indicator.rect);
			this.canvas.remove(indicator.label);
			this.processingIndicators.delete(jobId);
			this.canvas.requestRenderAll();
		}

		private animateProcessingIndicator(jobId: string): void {
			const indicator = this.processingIndicators.get(jobId);
			if (!indicator) return;

			let offset = 0;
			const animate = () => {
				const current = this.processingIndicators.get(jobId);
				if (!current || current.rect.stroke !== "#fbbf24") return;

				offset -= 1;
				current.rect.strokeDashOffset = offset;
				this.canvas.requestRenderAll();
				current.animationId = requestAnimationFrame(animate);
			};

			indicator.animationId = requestAnimationFrame(animate);
		}

		destroy() {
			for (const [jobId] of this.processingIndicators) {
				this.hideProcessingIndicator(jobId);
			}
			// Drop the instant-apply backing canvas + cancel the debounce timer. The
			// caller (project close / page switch / sign-out) is responsible for
			// flushing any pending edit FIRST — destroy() is synchronous and cannot
			// await an upload. The awaited teardown initiators do this: page nav
			// drains via waitForPendingBrushCommit(); sign-out runs the awaited
			// editorStore pre-sign-out hook (flushPendingEdits); leaving the workspace
			// route cancels+flushes in WorkspaceShell's beforeNavigate; and a hard
			// unload fires a best-effort flush from the beforeunload handler (#255).
			// Here we only release in-memory state.
			this.resetBackgroundEditState();
			this.imageLayerTransformStart.clear();
			this.textLayerTransformStart.clear();
			this.touchGestureCleanup?.();
			this.touchGestureCleanup = undefined;

			// Long-page guardrail cleanup: drop boundary lines so disposing the
			// canvas does not leak Fabric objects. The brush-preview clipPath is
			// released when the preview (and canvas) are disposed below.
			for (const line of this.pageBoundaryLines) {
				this.canvas.remove(line);
			}
			this.pageBoundaryLines = [];

			// P1 OOM fix — release the current page background + every image layer's
			// backing bitmap / cache / swapped-in editable canvas before disposing the
			// canvas, so a destroy/re-init cycle (route leave + return) returns to
			// baseline heap instead of leaking the last page's images.
			this.disposeFabricImageObject(this.imageItem);
			for (const layerObject of this.imageLayers) {
				this.disposeFabricImageObject(layerObject);
			}
			this.imageItem = null;
			this.imageLayers = [];

			this.canvas.dispose();

			// Clean up brush tool canvases to prevent memory leaks
			this.eraserCanvas = null;
			this.eraserCtx = null;
			this.maskCanvas = null;
			this.maskCtx = null;
			this.compositeCanvas = null;
			this.compositeCtx = null;
			this.aiCanvas = null;
			this.aiCtx = null;
			this.aiOverlayImage = null;
			this.originalImageCache = null;
			this.brushPreview = null;

			if (this.spaceHandler) {
				document.removeEventListener('keydown', this.spaceHandler);
				document.removeEventListener('keyup', this.spaceHandler);
			}
		}
	}

// Test-only exports — the undo/redo engine + the brush-background command are
// otherwise private to the module. Exporting them lets unit tests verify the P1
// undo-integrity invariants directly (one gesture = one undo step; undo fully
// restores the prior bitmap; evicted history disposes its pinned bitmaps) without
// booting a real Fabric canvas. Not part of the public editor API.
export { HistoryManager as __test_HistoryManager, BrushBackgroundCommand as __test_BrushBackgroundCommand, ImageEditLayerCommand as __test_ImageEditLayerCommand, ImageEditLayerVisibilityCommand as __test_ImageEditLayerVisibilityCommand, ImageEditLayerRevertCommand as __test_ImageEditLayerRevertCommand };
export type { Command as __test_Command };
