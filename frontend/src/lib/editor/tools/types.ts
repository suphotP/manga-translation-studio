// Image-edit suite v1 (W3.13) — shared tool types.
//
// All tools operate in IMAGE-SPACE (native pixel coordinates of the page
// background bitmap). The Fabric canvas remains the viewport; the image is an
// object/layer inside it. Tools convert pointer/scene coordinates through the
// editor's `imageBounds` before reading/writing pixels, then commit a new
// working-copy background via the editor host.

import type { MaskBuffer } from "./mask-buffer.js";

/** Scene-space rectangle (Fabric world units) the page image occupies. */
export interface ImageBounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** A point in native image-pixel space. */
export interface ImagePoint {
	x: number;
	y: number;
}

/** A point in Fabric scene space (after viewport transform is undone). */
export interface ScenePoint {
	x: number;
	y: number;
}

/**
 * Narrow view of the editor that tools are allowed to touch. Keeps the 8 tools
 * decoupled from the 4900-line `MangaEditor` so they stay testable.
 */
export interface EditorToolHost {
	/**
	 * Image-space context, or `null` when no page image is loaded. Tools must
	 * re-fetch this each gesture because the user can zoom/pan/swap pages.
	 */
	getImageSpaceContext(): {
		imageBounds: ImageBounds;
		imageWidth: number;
		imageHeight: number;
		canvas: any;
		fabric: any;
		sourceElement: CanvasImageSource | null;
	} | null;

	/**
	 * Read the current visible page-background pixels for one native image-space ROI,
	 * after compositing non-destructive edit layers over the base page. Tools that
	 * turn sampled pixels into new edit-layer patches should prefer this over
	 * `sourceElement`, which only represents the base/backing bitmap.
	 *
	 * Returns null when the host cannot produce a trustworthy composite yet. Callers
	 * should fail closed in that case instead of falling back to base-only pixels.
	 */
	readCompositedImageRegion?(region: { x: number; y: number; width: number; height: number }): ImageData | null;

	/**
	 * INSTANT-APPLY (Photopea-style) — paint a tool's result REGION straight onto
	 * the live background bitmap so the user sees it IMMEDIATELY: no image reload,
	 * no per-stroke server round-trip. `patch` is the healed/cloned RGBA pixels for
	 * the affected bounding box only; `region` is its top-left in native image
	 * pixels. The host re-renders synchronously and schedules a single debounced
	 * background persist (encode + upload) that never blocks the next stroke.
	 *
	 * Returns true if the instant path applied. Paint tools use this for instant
	 * visual feedback before recording a non-destructive edit layer. Ordering stays
	 * correct without a serialization gate because every stroke mutates the one live
	 * canvas in order.
	 */
	applyToolPatchInstant?(
		patch: ImageData,
		region: { x: number; y: number; width: number; height: number },
		/**
		 * Optional backing-canvas epoch captured (via {@link getImageEpoch}) BEFORE
		 * an off-thread solve (heal worker). The host re-checks it atomically and
		 * DISCARDS the patch (returns false) if the page switched / image reloaded /
		 * editor was destroyed while the worker ran — so a late ROI can never
		 * composite onto the wrong page bitmap (PR #264 worker-race fix).
		 */
		expectedEpoch?: number,
		/**
		 * PHASE A non-destructive preview — when `preview` is true the ROI is painted
		 * for IMMEDIATE visual feedback but the host does NOT schedule the legacy
		 * full-image background persist (that would bake a new page PNG, which the
		 * non-destructive edit-layer path replaces). The durable visual comes from the
		 * edit-composite cache the host repaints after `commitImageEditLayer`.
		 *
		 * `skipSnapshot` (codex #392 P1-1) — set on a REVERT preview (repainting the
		 * original ROI after a failed commit). The host snapshots the original ROI on the
		 * FIRST preview of a stroke so it can un-bake the preview once the edit layer is
		 * durably committed; a revert must NOT re-snapshot (it would capture the failed
		 * preview pixels as the "original").
		 */
		options?: { preview?: boolean; skipSnapshot?: boolean },
	): boolean;

	/**
	 * Monotonic epoch of the instant-apply backing canvas, bumped on every page
	 * load / image reload / destroy. A paint tool that runs an off-thread solve
	 * snapshots this BEFORE awaiting and passes it back into
	 * {@link applyToolPatchInstant} so a stale result is dropped (PR #264).
	 */
	getImageEpoch?(): number;

	/**
	 * NAV/TEARDOWN DRAIN (#367 P1) — register a DISCRETE instant-apply op's
	 * in-flight promise so the SAME drain that page-navigation / project-load /
	 * editor-teardown awaits (the host's `pendingBrushCommits`) also waits for it.
	 *
	 * A click-tool (bubble-clean) kicks its work off from `onPointerDown`, which
	 * returns `void` — so the registry's `commitInFlight` (which only tracks the
	 * promise RETURNED from `onPointerUp`) does NOT see it, and until the op reaches
	 * `applyToolPatchInstant` → the debounced persist gate, NOTHING reflects the
	 * pending commit. A page-switch in that window would not wait and the edit could
	 * be dropped or committed onto the WRONG page. Such tools call this SYNCHRONOUSLY
	 * from `onPointerDown` with the promise representing their whole queued+in-flight
	 * op, so navigation/teardown blocks on it (the op completes against the page it
	 * started on, or its stale patch is discarded by the epoch guard). The promise
	 * must not reject (the tool swallows its own errors). No-op on hosts without
	 * instant-apply backing (test stubs that omit it).
	 */
	trackInstantToolCommit?(pending: Promise<void>): void;

	/**
	 * Report a long-running (>150ms) tool operation so the UI can surface a
	 * working/progress indicator. Pure-canvas strokes never call this; heavy work
	 * (OpenCV inpaint, full-image composite + PNG encode) wraps itself in it.
	 */
	setToolBusy?(busy: boolean, label?: string): void;

	/**
	 * Report non-blocking tool guidance such as source-ready / missing-source
	 * state. Unlike setToolBusy this does not imply async work; it gives the
	 * shell a reactive, visible handoff for tools whose canvas cursor is not
	 * enough on touch/mobile layouts.
	 */
	setToolStatus?(message: string | null, tone?: "ready" | "blocked" | "info"): void;

	/**
	 * NON-DESTRUCTIVE edit (Phase A) — commit a tool's result as a small, reversible
	 * `ImageEditLayer` instead of baking a full new page PNG.
	 *
	 * The tool supplies the alpha-only ROI mask (single channel in `mask`, sized
	 * `region.width`×`region.height` at `region.x/y` in native image pixels), the
	 * solid `fill` colour, and which tool produced it. The host uploads ONLY the tiny
	 * mask ROI as an `image-edit-mask` asset, records an `ImageEditLayer`
	 * (fill-mask payload + bbox), appends it to `page.imageEditLayers`, and repaints
	 * its native edit-composite cache so the clean survives reload — WITHOUT minting a
	 * full-page background image. Resolves once the layer is recorded (the mask upload
	 * persists with the next saveState). No-op on hosts without this wiring (test stubs
	 * fall back to the legacy full-image commit).
	 */
	commitImageEditLayer?(input: {
		mask: Uint8ClampedArray;
		region: { x: number; y: number; width: number; height: number };
		fill: { r: number; g: number; b: number; a: number };
		tool: { id: "bubble-clean"; params?: Record<string, unknown> };
	}): Promise<boolean>;

	/**
	 * NON-DESTRUCTIVE edit (Phase B) — commit a brush/healing/clone stroke as a small,
	 * reversible realized-patch {@link ImageEditLayer} (patch / healing / clone) instead
	 * of baking a full new page PNG.
	 *
	 * The tool supplies the REALIZED ROI pixels (`patch`, an RGBA `ImageData` sized
	 * `region.width`×`region.height` at `region.x/y`), an optional full-image stroke
	 * `mask` (healing/clone provenance), which tool produced it, and any algorithm /
	 * clone-source metadata. The host encodes tiny PNGs, uploads them as small
	 * `image-edit-patch` / `image-edit-mask` assets, records the typed edit layer, pushes
	 * ONE undoable command for the stroke, appends it to `page.imageEditLayers`, and
	 * repaints its native edit-composite cache — WITHOUT minting a full-page background.
	 * Resolves true once recorded; false (no-op) on hosts without this wiring (test stubs
	 * then fall back to the legacy full-image commit) or on a failed upload.
	 */
	commitImageEditLayerPatch?(input: {
		kind: "patch" | "healing" | "clone";
		patch: ImageData;
		mask?: Uint8ClampedArray;
		region: { x: number; y: number; width: number; height: number };
		tool: { id: "brush" | "healing-brush" | "clone-stamp" | "background-edit"; params?: Record<string, unknown> };
		algorithm?: "telea";
		algorithmVersion?: string;
		sourceBbox?: { x: number; y: number; w: number; h: number };
		offset?: { dx: number; dy: number };
	}): Promise<boolean>;
}

/**
 * Conversion helpers + shared singletons handed to every tool on activate and
 * on each pointer event. Coordinates arriving in `onPointer*` are already in
 * image-space; the converters are provided for tools that need to draw scene
 * overlays (selection marching ants, brush cursor, ...).
 */
export interface ToolContext {
	host: EditorToolHost;
	mask: MaskBuffer;

	/** Native pixel dimensions of the current page image. */
	imageWidth: number;
	imageHeight: number;
	imageBounds: ImageBounds;

	/** Live Fabric canvas + module (for tools that render scene-space overlays). */
	canvas: any;
	fabric: any;

	/** Source bitmap of the page background (for sampling pixels). */
	sourceElement: CanvasImageSource | null;

	/** Scene → image-pixel conversion. */
	sceneToImage(point: ScenePoint): ImagePoint;
	/** Image-pixel → scene conversion. */
	imageToScene(point: ImagePoint): ScenePoint;
	/** Scale a scene-space length into image pixels (and inverse). */
	sceneLenToImage(len: number): number;
	imageLenToScene(len: number): number;

	/** Request a canvas re-render after mutating overlays. */
	requestRender(): void;
}

export type ToolPointerPhase = "down" | "move" | "up";

/** Pointer event delivered to a tool, with the point already in image-space. */
export interface ToolPointerEvent {
	/** Image-pixel coordinate (may be fractional). */
	image: ImagePoint;
	/** Original scene-space coordinate (for overlay rendering). */
	scene: ScenePoint;
	/** Whether the primary button / touch contact is active. */
	pressed: boolean;
	/** Modifier keys, mirroring Photoshop add/subtract selection behaviour. */
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
}

/**
 * A client-side image-edit tool. Tools are stateless registry entries plus a
 * small bag of per-tool mutable state stored on the instance; the registry owns
 * lifecycle. `activate`/`deactivate` set up and tear down scene overlays.
 */
export interface EditorTool {
	readonly id: string;
	readonly label: string;
	/** Single-character glyph / icon hint for the left dock (W3.1 renders it). */
	readonly icon: string;
	/** Photoshop-mirror keyboard shortcut hint; dispatch is resolved by the editor keymap. */
	readonly shortcut?: string;
	/** Tools that produce a selection mask vs. tools that paint pixels directly. */
	readonly kind: "selection" | "paint" | "refine";

	activate(ctx: ToolContext): void;
	deactivate(ctx: ToolContext): void;
	onPointerDown(ctx: ToolContext, event: ToolPointerEvent): void;
	onPointerMove(ctx: ToolContext, event: ToolPointerEvent): void;
	/**
	 * Paint tools commit asynchronously (off-thread encode + persistence). The
	 * registry awaits the returned promise and serializes commits so a second
	 * stroke cannot start until the first has fully settled.
	 */
	onPointerUp(ctx: ToolContext, event: ToolPointerEvent): void | Promise<void>;
}

/** Build a {@link ToolContext} from a host, mask buffer, and live image context. */
export function buildToolContext(
	host: EditorToolHost,
	mask: MaskBuffer,
	ctx: NonNullable<ReturnType<EditorToolHost["getImageSpaceContext"]>>,
): ToolContext {
	const { imageBounds, imageWidth, imageHeight, canvas, fabric, sourceElement } = ctx;
	const sx = imageBounds.width > 0 ? imageWidth / imageBounds.width : 0;
	const sy = imageBounds.height > 0 ? imageHeight / imageBounds.height : 0;
	return {
		host,
		mask,
		imageWidth,
		imageHeight,
		imageBounds,
		canvas,
		fabric,
		sourceElement,
		sceneToImage(point) {
			return {
				x: (point.x - imageBounds.left) * sx,
				y: (point.y - imageBounds.top) * sy,
			};
		},
		imageToScene(point) {
			return {
				x: imageBounds.left + (sx > 0 ? point.x / sx : 0),
				y: imageBounds.top + (sy > 0 ? point.y / sy : 0),
			};
		},
		sceneLenToImage(len) {
			return len * sx;
		},
		imageLenToScene(len) {
			return sx > 0 ? len / sx : 0;
		},
		requestRender() {
			canvas?.requestRenderAll?.();
		},
	};
}
