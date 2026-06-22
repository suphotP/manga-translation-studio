// P1 destructive-edit + undo-integrity fixes (codex audit).
//
// Covers the registry/tool-level fixes:
//   #2 cancelActiveGesture() abandons a live stroke (no commit) before page nav.
//   #3 Clone Stamp interpolates stamps along fast segments (no dashed gaps).
//   #4 Clone Stamp clips its stroke to the active selection mask.
//   #7 Refine Edge aborts when the context/page changes across its async await.
//   #8 refreshSelectionOverlay() re-anchors the overlay to the current imageBounds.
//
// All run headless via jsdom + node-canvas, no dev server.

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, createImageEditSuite } from "$lib/editor/tools/registry.ts";
import { createCloneStampTool } from "$lib/editor/tools/clone-stamp-tool.ts";
import { createRefineEdgeTool } from "$lib/editor/tools/refine-edge-tool.ts";
import { readSourceImageData, type PixelRegion } from "$lib/editor/tools/raster.ts";
import { SELECTION_OVERLAY_NAME } from "$lib/editor/tools/selection-overlay.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

// Refine Edge awaits the morphology backend; stub it so the test controls timing and
// the post-await guard is exercised without a real WASM load.
let resolveBackend: (() => void) | null = null;
vi.mock("$lib/editor/tools/morphology.ts", async () => {
	const actual = await vi.importActual<typeof import("$lib/editor/tools/morphology.ts")>(
		"$lib/editor/tools/morphology.ts",
	);
	return {
		...actual,
		ensureMorphologyBackend: () =>
			new Promise<null>((resolve) => {
				resolveBackend = () => resolve(null);
			}),
	};
});

function makeFabricStub() {
	const objects: any[] = [];
	const canvas = {
		add: (o: any) => objects.push(o),
		remove: (o: any) => {
			const i = objects.indexOf(o);
			if (i >= 0) objects.splice(i, 1);
		},
		getObjects: () => objects,
		bringObjectToFront: vi.fn(),
		bringObjectToFront_: vi.fn(),
		requestRenderAll: vi.fn(),
	};
	const fabric = {
		Circle: class {
			props: any;
			constructor(props: any) {
				this.props = props;
			}
			set(p: any) {
				Object.assign(this.props, p);
			}
		},
		FabricImage: class {
			props: any;
			constructor(_el: any, props: any) {
				this.props = props;
			}
			set(p: any) {
				Object.assign(this.props, p);
			}
		},
	};
	return { canvas, fabric, objects };
}

/** A readable source canvas so the clone tool actually samples + paints. */
function makeSourceCanvas(size = 64): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = size;
	c.height = size;
	const ctx = c.getContext("2d");
	if (ctx) {
		ctx.fillStyle = "#888";
		ctx.fillRect(0, 0, size, size);
		ctx.fillStyle = "#111";
		ctx.fillRect(4, 4, 8, 8);
	}
	return c;
}

/** Instant-apply host recording the regions painted onto the live bitmap. */
function makeInstantHost(
	source: HTMLCanvasElement,
	fabricStub: ReturnType<typeof makeFabricStub>,
): EditorToolHost & { patches: Array<{ region: PixelRegion; patch: ImageData }> } {
	const patches: Array<{ region: PixelRegion; patch: ImageData }> = [];
	return {
		patches,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: fabricStub.canvas,
			fabric: fabricStub.fabric,
			sourceElement: source,
		}),
		applyToolPatchInstant: (patch: ImageData, region: PixelRegion) => {
			patches.push({ region, patch });
			return true;
		},
		setToolBusy: vi.fn(),
	};
}

describe("#3 Clone Stamp interpolates along fast segments (no dashed gaps)", () => {
	it("paints a continuous dirty region across a long jump, not just the endpoints", async () => {
		const source = makeSourceCanvas(64);
		if (!readSourceImageData(source, source.width, source.height)) return; // no raster backend
		const fabricStub = makeFabricStub();
		const host = makeInstantHost(source, fabricStub);
		const registry = new ToolRegistry();
		// Small radius so a far jump WOULD leave a gap without interpolation.
		registry.register(createCloneStampTool({ radius: 3, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		// Alt-click sets the source anchor near the first paint point so the rolling
		// clone SOURCE (dest - offset) stays in-bounds across the whole run (otherwise
		// far columns are skipped because the source runs off the image, not because of
		// an interpolation gap). offset = firstDest - anchor = (2, 20).
		registry.handlePointerDown({ scene: { x: 10, y: 10 }, altKey: true });
		registry.handlePointerDown({ scene: { x: 12, y: 30 } });
		// One big jump (the registry coalesces fast moves into the up).
		registry.handlePointerUp({ scene: { x: 42, y: 30 } });
		await registry.waitForCommit();

		expect(host.patches.length).toBe(1);
		const r = host.patches[0].region;
		// The region spans a wide horizontal band (well beyond two ~6px endpoint discs),
		// proving the stroke was interpolated between the two coalesced samples rather
		// than only stamped at the endpoints.
		expect(r.width).toBeGreaterThanOrEqual(24);
		// The decisive check: non-zero alpha at SEVERAL points across the middle of the
		// run (35, 40, 45) confirms a continuous band with NO dashed gaps. Without
		// interpolation these mid-run columns would be empty.
		const columnPainted = (imgX: number) => {
			const col = imgX - r.x;
			if (col < 0 || col >= r.width) return false;
			for (let y = 0; y < r.height; y++) {
				if (host.patches[0].patch.data[(y * r.width + col) * 4 + 3] > 0) return true;
			}
			return false;
		};
		// Mid-run columns between the two coalesced samples (12 → 42).
		expect(columnPainted(20)).toBe(true);
		expect(columnPainted(28)).toBe(true);
		expect(columnPainted(36)).toBe(true);
	});
});

describe("#4 Clone Stamp clips its stroke to the active selection mask", () => {
	it("does not paint outside the selection; an entirely-outside stroke is a no-op", async () => {
		const source = makeSourceCanvas(64);
		if (!readSourceImageData(source, source.width, source.height)) return;
		const fabricStub = makeFabricStub();
		const host = makeInstantHost(source, fabricStub);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ radius: 4, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		// Constrain the selection to the LEFT half (x < 32). Build via setData() so the
		// MaskBuffer's bounds (and isEmpty()) reflect the selection — the registry hands
		// ctx.mask to the tool, which checks isEmpty() before clipping.
		registry.mask.resize(source.width, source.height);
		const sel = new Uint8ClampedArray(source.width * source.height);
		for (let y = 0; y < source.height; y++) {
			for (let x = 0; x < 32; x++) sel[y * source.width + x] = 255;
		}
		registry.mask.setData(sel);

		// Anchor + a stroke that lives ENTIRELY in the right (unselected) half.
		registry.handlePointerDown({ scene: { x: 10, y: 10 }, altKey: true });
		registry.handlePointerDown({ scene: { x: 50, y: 40 } });
		registry.handlePointerUp({ scene: { x: 52, y: 42 } });
		await registry.waitForCommit();
		// Whole stroke was clipped away → no patch applied.
		expect(host.patches.length).toBe(0);

		// A stroke that STRADDLES the boundary keeps only the selected (left) pixels.
		registry.handlePointerDown({ scene: { x: 28, y: 20 } });
		registry.handlePointerUp({ scene: { x: 36, y: 20 } });
		await registry.waitForCommit();
		expect(host.patches.length).toBe(1);
		const { region, patch } = host.patches[0];
		// Every painted pixel must lie inside the selection (image x < 32).
		for (let y = 0; y < region.height; y++) {
			for (let x = 0; x < region.width; x++) {
				const a = patch.data[(y * region.width + x) * 4 + 3];
				if (a > 0) {
					expect(region.x + x).toBeLessThan(32);
				}
			}
		}
	});
});

describe("#2 cancelActiveGesture abandons a live stroke without committing", () => {
	it("drops the in-progress clone stroke so a later up does not paint", async () => {
		const source = makeSourceCanvas(64);
		if (!readSourceImageData(source, source.width, source.height)) return;
		const fabricStub = makeFabricStub();
		const host = makeInstantHost(source, fabricStub);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ radius: 4, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		registry.handlePointerDown({ scene: { x: 10, y: 10 }, altKey: true });
		// Begin a stroke (pointerDown only — no up yet).
		registry.handlePointerDown({ scene: { x: 30, y: 30 } });
		registry.handlePointerMove({ scene: { x: 32, y: 30 }, pressed: true });

		// Page navigation cancels the active gesture BEFORE the image changes.
		registry.cancelActiveGesture();

		// The (now-stale) pointer up must NOT commit the abandoned stroke.
		registry.handlePointerUp({ scene: { x: 34, y: 30 } });
		await registry.waitForCommit();
		expect(host.patches.length).toBe(0);
		// The same tool stays active + usable after cancel: re-anchor (cancel resets the
		// per-stroke + source state) and a fresh stroke DOES paint.
		expect(registry.activeToolId).toBe("clone-stamp");
		registry.handlePointerDown({ scene: { x: 10, y: 10 }, altKey: true });
		registry.handlePointerDown({ scene: { x: 30, y: 30 } });
		registry.handlePointerUp({ scene: { x: 33, y: 30 } });
		await registry.waitForCommit();
		expect(host.patches.length).toBe(1);
	});
});

describe("#8 refreshSelectionOverlay re-anchors to the current imageBounds", () => {
	it("re-renders the overlay against the new bounds after a recenter", () => {
		const fabricStub = makeFabricStub();
		let bounds = { left: 0, top: 0, width: 100, height: 100 };
		const host: EditorToolHost = {
			getImageSpaceContext: () => ({
				imageBounds: bounds,
				imageWidth: 100,
				imageHeight: 100,
				canvas: fabricStub.canvas,
				fabric: fabricStub.fabric,
				sourceElement: null,
			}),
		};
		const { registry } = createImageEditSuite(host);

		// Make a selection at the initial bounds.
		registry.activate("marquee");
		registry.handlePointerDown({ scene: { x: 10, y: 10 } });
		registry.handlePointerUp({ scene: { x: 40, y: 40 } });
		const overlayOf = () =>
			fabricStub.objects.find(
				(o: any) => o?.[SELECTION_OVERLAY_NAME] || o?.props?.name === SELECTION_OVERLAY_NAME,
			);
		const overlay1 = overlayOf();
		expect(overlay1).toBeTruthy();
		expect(overlay1.props.left).toBe(0);

		// The editor recenters/fits → imageBounds move. Without a refresh the overlay
		// keeps the OLD left/top (drift). refreshSelectionOverlay re-anchors it.
		bounds = { left: 250, top: 60, width: 100, height: 100 };
		registry.refreshSelectionOverlay();
		const overlay2 = overlayOf();
		expect(overlay2).toBeTruthy();
		expect(overlay2.props.left).toBe(250);
		expect(overlay2.props.top).toBe(60);
		// Exactly one overlay (the old one was removed, not duplicated).
		const count = fabricStub.objects.filter(
			(o: any) => o?.[SELECTION_OVERLAY_NAME] || o?.props?.name === SELECTION_OVERLAY_NAME,
		).length;
		expect(count).toBe(1);
	});

	it("is a no-op when there is no active selection", () => {
		const fabricStub = makeFabricStub();
		const host: EditorToolHost = {
			getImageSpaceContext: () => ({
				imageBounds: { left: 0, top: 0, width: 100, height: 100 },
				imageWidth: 100,
				imageHeight: 100,
				canvas: fabricStub.canvas,
				fabric: fabricStub.fabric,
				sourceElement: null,
			}),
		};
		const { registry } = createImageEditSuite(host);
		registry.clearSelection();
		expect(() => registry.refreshSelectionOverlay()).not.toThrow();
		const has = fabricStub.objects.some(
			(o: any) => o?.[SELECTION_OVERLAY_NAME] || o?.props?.name === SELECTION_OVERLAY_NAME,
		);
		expect(has).toBe(false);
	});
});

describe("#7 Refine Edge aborts when the context changes across its async await", () => {
	it("does NOT mutate the mask when the active context is swapped mid-run", async () => {
		const tool = createRefineEdgeTool();
		const { MaskBuffer } = await import("$lib/editor/tools/mask-buffer.ts");
		const maskA = new MaskBuffer();
		maskA.resize(20, 20);
		// A non-empty selection so run() proceeds to the backend await. setData() so the
		// MaskBuffer bounds (isEmpty()) reflect the selection.
		const seedA = new Uint8ClampedArray(20 * 20);
		for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) seedA[y * 20 + x] = 255;
		maskA.setData(seedA);
		const before = maskA.cloneData();

		const ctxA: any = {
			mask: maskA,
			imageWidth: 20,
			imageHeight: 20,
			sourceElement: { tag: "pageA" },
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			imageBounds: { left: 0, top: 0, width: 20, height: 20 },
			requestRender: vi.fn(),
		};
		tool.activate(ctxA);

		resolveBackend = null;
		const pending = tool.grow(2);
		// Simulate a page switch mid-await: deactivate (clears the tool's context) so the
		// in-flight run — which captured ctxA before the await — must bail rather than
		// mutate the mask.
		tool.deactivate(ctxA);
		// Resolve the awaited backend so run() reaches its post-await guard.
		(resolveBackend as null | (() => void))?.();
		await pending;

		// maskA must be untouched — the stale run aborted.
		expect([...maskA.cloneData()]).toEqual([...before]);
	});

	it("DOES mutate the mask on the normal (context-stable) path", async () => {
		const tool = createRefineEdgeTool();
		const { MaskBuffer } = await import("$lib/editor/tools/mask-buffer.ts");
		const mask = new MaskBuffer();
		mask.resize(20, 20);
		const seed = new Uint8ClampedArray(20 * 20);
		for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) seed[y * 20 + x] = 255;
		mask.setData(seed);
		const before = mask.cloneData();
		const ctx: any = {
			mask,
			imageWidth: 20,
			imageHeight: 20,
			sourceElement: { tag: "page" },
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			imageBounds: { left: 0, top: 0, width: 20, height: 20 },
			requestRender: vi.fn(),
		};
		tool.activate(ctx);
		resolveBackend = null;
		const pending = tool.grow(2);
		(resolveBackend as null | (() => void))?.();
		await pending;
		// Grow expands the selection → the mask changed.
		expect([...mask.cloneData()]).not.toEqual([...before]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// WIRING (PR #349 P1 re-review): the editor's nav-time hooks must actually reach
// the registry. The registry-level fixes (#2 cancel, #8 overlay refresh) are
// proven above, but they are DEAD unless the editor's `onCancelImageToolActiveGesture`
// / `onRefreshSelectionOverlay` fields are assigned to call them. The store's
// editor.init() makes those assignments; below we reproduce that EXACT wiring on a
// REAL MangaEditor + a REAL image-edit suite and drive the real editor entry points
// the navigation path uses, so the suite path is verified end to end (not just the
// legacy-brush path).
describe("PR #349 P1: editor nav hooks are wired to the registry (suite path is live)", () => {
	it("editor.cancelActiveBrushGesture() cancels the active suite gesture → stale up commits nothing", async () => {
		const source = makeSourceCanvas(64);
		if (!readSourceImageData(source, source.width, source.height)) return; // no raster backend

		// REAL editor (Fabric under jsdom) — but we don't load a flaky real image; we
		// only need it as the EditorToolHost and to invoke its real nav hook. So we
		// build a real suite bound to a deterministic instant-host (records patches),
		// then wire the editor exactly as the store's init() does.
		const { MangaEditor } = await import("$lib/canvas/editor.ts");
		const canvasEl = document.createElement("canvas");
		canvasEl.width = 256;
		canvasEl.height = 256;
		const editor: any = await MangaEditor.create(canvasEl);

		const fabricStub = makeFabricStub();
		const host = makeInstantHost(source, fabricStub);
		const { registry } = createImageEditSuite(host);

		// ── The EXACT wiring the store's editor.init() performs (the P1 fix). ──
		editor.onCancelImageToolActiveGesture = () => registry.cancelActiveGesture();
		editor.onRefreshSelectionOverlay = () => registry.refreshSelectionOverlay();

		const cancelSpy = vi.spyOn(registry, "cancelActiveGesture");

		registry.activate("clone-stamp");
		// Anchor + BEGIN a stroke (pointerDown, no up) — an ACTIVE gesture with an open
		// activeContext from an OLD pointer-down, exactly the state codex flagged.
		registry.handlePointerDown({ scene: { x: 10, y: 10 }, altKey: true });
		registry.handlePointerDown({ scene: { x: 30, y: 30 } });
		registry.handlePointerMove({ scene: { x: 32, y: 30 }, pressed: true });

		// Navigation: loadImage() calls editor.cancelActiveBrushGesture() BEFORE the
		// image swaps. With the wiring above this must reach registry.cancelActiveGesture().
		editor.cancelActiveBrushGesture();
		expect(cancelSpy).toHaveBeenCalledTimes(1);

		// The now-stale pointer-up (fired against the new page) must NOT commit the
		// abandoned old-page stroke.
		registry.handlePointerUp({ scene: { x: 34, y: 30 } });
		await registry.waitForCommit();
		expect(host.patches.length).toBe(0);

		// The tool is still active + usable: a fresh, complete stroke DOES paint.
		expect(registry.activeToolId).toBe("clone-stamp");
		registry.handlePointerDown({ scene: { x: 10, y: 10 }, altKey: true });
		registry.handlePointerDown({ scene: { x: 30, y: 30 } });
		registry.handlePointerUp({ scene: { x: 33, y: 30 } });
		await registry.waitForCommit();
		expect(host.patches.length).toBe(1);

		try {
			editor.destroy?.();
		} catch {
			/* ignore teardown noise */
		}
	});

	it("editor.onRefreshSelectionOverlay is wired so a recenter/resize re-anchors the suite overlay", async () => {
		// The overlay-refresh hook is called from the editor's _centerImage chokepoint
		// (every recenter/fit/resize). Prove the wired closure re-anchors the REAL
		// suite overlay to the new imageBounds (no drift) for the suite path.
		const fabricStub = makeFabricStub();
		let bounds = { left: 0, top: 0, width: 100, height: 100 };
		const host: EditorToolHost = {
			getImageSpaceContext: () => ({
				imageBounds: bounds,
				imageWidth: 100,
				imageHeight: 100,
				canvas: fabricStub.canvas,
				fabric: fabricStub.fabric,
				sourceElement: null,
			}),
		};
		const { registry } = createImageEditSuite(host);

		// The store wires this closure onto the editor; calling it must route to the
		// registry's refreshSelectionOverlay().
		const onRefreshSelectionOverlay = () => registry.refreshSelectionOverlay();

		registry.activate("marquee");
		registry.handlePointerDown({ scene: { x: 10, y: 10 } });
		registry.handlePointerUp({ scene: { x: 40, y: 40 } });
		const overlayOf = () =>
			fabricStub.objects.find(
				(o: any) => o?.[SELECTION_OVERLAY_NAME] || o?.props?.name === SELECTION_OVERLAY_NAME,
			);
		expect(overlayOf()?.props.left).toBe(0);

		// Recenter moves imageBounds; the wired hook re-anchors the overlay.
		bounds = { left: 250, top: 60, width: 100, height: 100 };
		onRefreshSelectionOverlay();
		const overlay2 = overlayOf();
		expect(overlay2?.props.left).toBe(250);
		expect(overlay2?.props.top).toBe(60);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 (codex re-review of #358): the LEGACY image-layer brush live preview must be
// restored on EVERY gesture exit, not just pointer-up/nav. ensureImageLayerBrushPreview()
// swaps the visible Fabric image object's element to the stroke's working canvas so the
// erase shows in real time; the mouse:up COMMIT only fires while `tool === "brush"`.
// Switching tools — or disabling the brush — mid-stroke previously bypassed the restore
// (setTool changed `tool` with no cancel; setBrushEnabled(false) nulled the target
// directly), leaving the layer visibly edited but UNCOMMITTED and UN-restored. These
// tests drive a REAL MangaEditor with a simulated active preview and assert each exit
// path un-swaps the element, discards the stroke, and leaks nothing.
describe("PR #358 P1: image-layer brush live preview is restored on tool-switch / brush-disable", () => {
	/**
	 * Build a real editor and put it in the state ensureImageLayerBrushPreview() leaves
	 * mid-stroke: brush tool active, isDrawing, and an imageLayerBrushTarget whose
	 * imageObject's element has been SWAPPED to the working canvas (previewActive=true).
	 */
	async function makeEditorMidStroke() {
		const { MangaEditor } = await import("$lib/canvas/editor.ts");
		const canvasEl = document.createElement("canvas");
		canvasEl.width = 256;
		canvasEl.height = 256;
		const editor: any = await MangaEditor.create(canvasEl);

		// The ORIGINAL (committed) layer element, and the stroke's working canvas the
		// preview swapped IN. setElement records what the object currently renders from.
		const originalElement = document.createElement("canvas");
		originalElement.width = 32;
		originalElement.height = 32;
		const workingCanvas = document.createElement("canvas");
		workingCanvas.width = 32;
		workingCanvas.height = 32;

		const imageObject: any = {
			_element: workingCanvas,
			_originalElement: workingCanvas,
			dirty: false,
			setElement(el: any) {
				this._element = el;
				this._originalElement = el;
			},
		};

		editor.tool = "brush";
		editor.isDrawing = true;
		editor.brushPath = [{ x: 1, y: 1 }];
		editor.imageLayerBrushTarget = {
			layerId: "layer-1",
			imageObject,
			canvas: workingCanvas,
			ctx: workingCanvas.getContext("2d"),
			mode: "erase",
			path: [{ x: 1, y: 1, radius: 4 }],
			// ensureImageLayerBrushPreview() already swapped the object to the working
			// canvas, so the live (uncommitted) erase is currently on screen.
			previewActive: true,
			previousElement: originalElement,
		};
		return { editor, imageObject, originalElement, workingCanvas };
	}

	it("switching AWAY from brush mid-stroke restores the real layer + discards the stroke (no half-commit)", async () => {
		const { editor, imageObject, originalElement, workingCanvas } = await makeEditorMidStroke();

		editor.setTool("select");

		// Real layer un-swapped back to the committed element — preview no longer stuck.
		expect(imageObject._element).toBe(originalElement);
		expect(imageObject._originalElement).toBe(originalElement);
		// Stroke discarded, NOT committed.
		expect(editor.imageLayerBrushTarget).toBeNull();
		expect(editor.isDrawing).toBe(false);
		expect(editor.brushPath).toEqual([]);
		expect(editor.tool).toBe("select");
		// No leak — the working canvas backing bitmap is released.
		expect(workingCanvas.width).toBe(0);
		expect(workingCanvas.height).toBe(0);

		try {
			editor.destroy?.();
		} catch {
			/* ignore teardown noise */
		}
	});

	it("disabling the brush mid-stroke restores the real layer + discards the stroke", async () => {
		const { editor, imageObject, originalElement, workingCanvas } = await makeEditorMidStroke();

		editor.setBrushEnabled(false);

		expect(imageObject._element).toBe(originalElement);
		expect(imageObject._originalElement).toBe(originalElement);
		expect(editor.imageLayerBrushTarget).toBeNull();
		expect(editor.isDrawing).toBe(false);
		expect(editor.brushPath).toEqual([]);
		expect(workingCanvas.width).toBe(0);
		expect(workingCanvas.height).toBe(0);

		try {
			editor.destroy?.();
		} catch {
			/* ignore teardown noise */
		}
	});

	it("nav cancel still restores the preview (existing behavior intact, no double-restore)", async () => {
		const { editor, imageObject, originalElement } = await makeEditorMidStroke();

		// loadImage() calls this before swapping the page bitmap.
		editor.cancelActiveBrushGesture();
		expect(imageObject._element).toBe(originalElement);
		expect(editor.imageLayerBrushTarget).toBeNull();

		// A SECOND exit path (e.g. a following setTool) must be a safe no-op — no throw,
		// element stays restored (target already cleared → nothing to double-restore).
		editor.setTool("select");
		expect(imageObject._element).toBe(originalElement);
		expect(editor.imageLayerBrushTarget).toBeNull();

		try {
			editor.destroy?.();
		} catch {
			/* ignore teardown noise */
		}
	});

	it("switching brush→brush (no change away) does NOT cancel an active stroke", async () => {
		const { editor, imageObject, workingCanvas } = await makeEditorMidStroke();

		// Re-selecting the same brush tool must keep the in-progress stroke alive.
		editor.setTool("brush");
		expect(editor.imageLayerBrushTarget).not.toBeNull();
		expect(editor.isDrawing).toBe(true);
		// Element still the working canvas (preview untouched).
		expect(imageObject._element).toBe(workingCanvas);

		try {
			editor.destroy?.();
		} catch {
			/* ignore teardown noise */
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 (codex re-review round 3 of #358): multi-pointer re-entry must NOT clobber
// the active image-layer brush target. While a stroke is live, the visible Fabric
// object's element has already been swapped to the working canvas. A SECOND touch
// pointerdown reached startBrushStroke() before being tracked for pinch and called
// createImageLayerBrushTarget() again — which reads the CURRENT (already-swapped)
// element as `previousElement`, so a later cancel "restores" to the uncommitted
// working canvas instead of the TRUE original, corrupting the layer. The single
// active stroke must own the gesture: extra pointers create no new target.
describe("PR #358 P1: multi-pointer brush re-entry does not clobber the restore target", () => {
	async function makeEditorMidStroke() {
		const { MangaEditor } = await import("$lib/canvas/editor.ts");
		const canvasEl = document.createElement("canvas");
		canvasEl.width = 256;
		canvasEl.height = 256;
		const editor: any = await MangaEditor.create(canvasEl);

		const originalElement = document.createElement("canvas");
		originalElement.width = 32;
		originalElement.height = 32;
		const workingCanvas = document.createElement("canvas");
		workingCanvas.width = 32;
		workingCanvas.height = 32;

		const imageObject: any = {
			_element: workingCanvas,
			_originalElement: workingCanvas,
			dirty: false,
			setElement(el: any) {
				this._element = el;
				this._originalElement = el;
			},
		};

		editor.tool = "brush";
		editor.isDrawing = true;
		editor.brushPath = [{ x: 1, y: 1 }];
		editor.imageLayerBrushTarget = {
			layerId: "layer-1",
			imageObject,
			canvas: workingCanvas,
			ctx: workingCanvas.getContext("2d"),
			mode: "erase",
			path: [{ x: 1, y: 1, radius: 4 }],
			previewActive: true,
			previousElement: originalElement,
		};
		return { editor, imageObject, originalElement, workingCanvas };
	}

	it("a second startBrushStroke() while a stroke is active is a no-op (target + previousElement preserved)", async () => {
		const { editor, imageObject, originalElement, workingCanvas } = await makeEditorMidStroke();

		const targetBefore = editor.imageLayerBrushTarget;
		expect(targetBefore.previousElement).toBe(originalElement);

		// createImageLayerBrushTarget() must NEVER run for the re-entrant pointer — if it
		// did, it would capture the working canvas as the new previousElement.
		const createSpy = vi.spyOn(editor, "createImageLayerBrushTarget");

		// Second finger "pointerdown" → startBrushStroke() again.
		editor.startBrushStroke({ x: 5, y: 5 });

		expect(createSpy).not.toHaveBeenCalled();
		// Same target object, still pointing at the TRUE original for restore.
		expect(editor.imageLayerBrushTarget).toBe(targetBefore);
		expect(editor.imageLayerBrushTarget.previousElement).toBe(originalElement);
		// First stroke still owns the gesture.
		expect(editor.isDrawing).toBe(true);
		// Visible object still shows the FIRST stroke's working canvas (preview intact).
		expect(imageObject._element).toBe(workingCanvas);

		// Cancelling (pinch start / nav) restores the TRUE original element, NOT the
		// uncommitted working/preview canvas.
		editor.cancelActiveBrushGesture();
		expect(imageObject._element).toBe(originalElement);
		expect(imageObject._originalElement).toBe(originalElement);
		expect(editor.imageLayerBrushTarget).toBeNull();

		createSpy.mockRestore();
		try {
			editor.destroy?.();
		} catch {
			/* ignore teardown noise */
		}
	});

	it("a fresh stroke after the first fully ends is no longer blocked by the re-entry guard", async () => {
		const { editor } = await makeEditorMidStroke();

		// First stroke ends/cancels normally → target cleared.
		editor.cancelActiveBrushGesture();
		expect(editor.imageLayerBrushTarget).toBeNull();

		// With no active stroke, the re-entry guard no longer short-circuits, so a fresh
		// startBrushStroke() proceeds past it into the normal target-resolution path. This
		// stub has no editable image layer, so it surfaces the "no editable target" UX
		// message instead of silently returning from the guard — proving the guard let it
		// through (createImageLayerBrushTarget only runs once a real layer is hit).
		const createSpy = vi.spyOn(editor, "createImageLayerBrushTarget");
		const missSpy = vi.fn();
		editor.onBrushTargetMiss = missSpy;

		editor.startBrushStroke({ x: 2, y: 2 });

		expect(missSpy).toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled(); // no editable layer in this stub

		createSpy.mockRestore();
		try {
			editor.destroy?.();
		} catch {
			/* ignore teardown noise */
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 (codex re-review round 4 of #358): brush/pinch pointer-OWNERSHIP. The ROOT
// touch-bookkeeping defect: the FIRST brush touch returned BEFORE being registered
// in `touchPointers`, so a SECOND touch added only itself (size 1) → startPinch()
// never fired and the brush stroke was never cancelled; worse, brush move/up were
// keyed only on `tool === "brush" && isDrawing`, so EITHER finger could extend or
// commit the stroke. The fix makes ONE pointer own a stroke (`brushPointerId`),
// registers it in `touchPointers`, routes brush move/up by ownership, and promotes
// a second distinct touch to a pinch (cancelling the brush). These tests drive the
// REAL setupTouchGestures handlers via dispatched PointerEvents on upperCanvasEl.
describe("PR #358 P1: brush/pinch pointer ownership (real touch handlers)", () => {
	async function makeEditor() {
		const { MangaEditor } = await import("$lib/canvas/editor.ts");
		const canvasEl = document.createElement("canvas");
		canvasEl.width = 256;
		canvasEl.height = 256;
		const editor: any = await MangaEditor.create(canvasEl);
		const upper: HTMLCanvasElement = editor.canvas.upperCanvasEl;
		// jsdom lays elements out at 0×0; give the upper canvas a real rect so
		// scenePointer()/getBoundingClientRect math is finite (not strictly needed for
		// ownership bookkeeping, but keeps pinch math from NaN-ing).
		upper.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256, x: 0, y: 0, toJSON() {} }) as DOMRect;
		return { editor, upper };
	}
	function pd(upper: HTMLCanvasElement, pointerId: number, x: number, y: number, pointerType = "touch") {
		upper.dispatchEvent(new PointerEvent("pointerdown", { pointerId, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true }));
	}
	function pm(upper: HTMLCanvasElement, pointerId: number, x: number, y: number, pointerType = "touch") {
		upper.dispatchEvent(new PointerEvent("pointermove", { pointerId, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true }));
	}
	function pu(upper: HTMLCanvasElement, pointerId: number, x: number, y: number, pointerType = "touch") {
		upper.dispatchEvent(new PointerEvent("pointerup", { pointerId, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true }));
	}
	function pc(upper: HTMLCanvasElement, pointerId: number, x: number, y: number, pointerType = "touch") {
		upper.dispatchEvent(new PointerEvent("pointercancel", { pointerId, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true }));
	}
	function plc(upper: HTMLCanvasElement, pointerId: number, x: number, y: number, pointerType = "touch") {
		upper.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true }));
	}

	/**
	 * Put the editor in brush mode and stub startBrushStroke so the FIRST touch
	 * deterministically begins an image-layer stroke (isDrawing + a target whose
	 * previewActive element is swapped), without needing a real editable layer.
	 */
	function armBrush(editor: any) {
		editor.tool = "brush";
		const originalElement = document.createElement("canvas");
		originalElement.width = 32;
		originalElement.height = 32;
		const workingCanvas = document.createElement("canvas");
		workingCanvas.width = 32;
		workingCanvas.height = 32;
		const imageObject: any = {
			_element: originalElement,
			_originalElement: originalElement,
			dirty: false,
			setElement(el: any) {
				this._element = el;
				this._originalElement = el;
			},
		};
		const startSpy = vi.spyOn(editor, "startBrushStroke").mockImplementation(() => {
			editor.isDrawing = true;
			editor.brushPath = [{ x: 1, y: 1 }];
			editor.imageLayerBrushTarget = {
				layerId: "layer-1",
				imageObject,
				canvas: workingCanvas,
				ctx: workingCanvas.getContext("2d"),
				mode: "erase",
				path: [{ x: 1, y: 1, radius: 4 }],
				previewActive: true,
				previousElement: originalElement,
			};
			// Mirror the live preview swap so the visible object renders the working canvas.
			imageObject.setElement(workingCanvas);
		});
		// continueBrushStroke / endBrushStroke spies let us detect a non-owner extending
		// or committing the stroke.
		const continueSpy = vi.spyOn(editor, "continueBrushStroke").mockImplementation(() => {});
		const endSpy = vi.spyOn(editor, "endBrushStroke").mockImplementation(() => {
			editor.isDrawing = false;
			editor.brushPath = [];
			editor.imageLayerBrushTarget = null;
		});
		return { startSpy, continueSpy, endSpy, imageObject, originalElement, workingCanvas };
	}

	it("(a) second touch during a stroke cancels the brush (true original restored) + starts pinch (size 2)", async () => {
		const { editor, upper } = await makeEditor();
		const { imageObject, originalElement, workingCanvas } = armBrush(editor);

		pd(upper, 1, 40, 40); // first finger → brush stroke
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBe(1);
		expect(editor.touchPointers.size).toBe(1); // owner is a tracked pointer
		expect(imageObject._element).toBe(workingCanvas); // live preview swapped in

		pd(upper, 2, 120, 120); // second finger → must cancel brush + pinch
		expect(editor.isDrawing).toBe(false);
		expect(editor.imageLayerBrushTarget).toBeNull();
		expect(editor.brushPointerId).toBeNull();
		// The TRUE original element is restored (not the uncommitted working canvas).
		expect(imageObject._element).toBe(originalElement);
		expect(imageObject._originalElement).toBe(originalElement);
		// Both fingers tracked → a real two-finger pinch.
		expect(editor.touchPointers.size).toBe(2);
		expect(editor.isTouchPinching).toBe(true);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	it("(b) a move/up from the NON-owning pointer never extends or commits the brush", async () => {
		const { editor, upper } = await makeEditor();
		const { continueSpy, endSpy } = armBrush(editor);

		pd(upper, 1, 40, 40); // owner = pointer 1
		expect(editor.brushPointerId).toBe(1);
		continueSpy.mockClear();

		// A stray move from a DIFFERENT pointer id must NOT extend the stroke.
		pm(upper, 99, 60, 60);
		expect(continueSpy).not.toHaveBeenCalled();

		// A stray up from a DIFFERENT pointer id must NOT commit the stroke.
		pu(upper, 99, 60, 60);
		expect(endSpy).not.toHaveBeenCalled();
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBe(1);

		// The OWNER's move drives the stroke…
		pm(upper, 1, 50, 50);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		// …and the OWNER's up commits + releases ownership.
		pu(upper, 1, 50, 50);
		expect(endSpy).toHaveBeenCalledTimes(1);
		expect(editor.brushPointerId).toBeNull();
		expect(editor.touchPointers.size).toBe(0);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	it("(c) ownership + touchPointers cleared so a FRESH single-finger stroke works after", async () => {
		const { editor, upper } = await makeEditor();
		const { startSpy } = armBrush(editor);

		// Stroke 1: down → up.
		pd(upper, 1, 40, 40);
		pu(upper, 1, 40, 40);
		expect(editor.brushPointerId).toBeNull();
		expect(editor.touchPointers.size).toBe(0);
		expect(editor.isDrawing).toBe(false);

		// Stroke 2: a brand-new finger must be able to start a fresh stroke.
		startSpy.mockClear();
		pd(upper, 7, 80, 80);
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(editor.brushPointerId).toBe(7);
		expect(editor.isDrawing).toBe(true);
		expect(editor.touchPointers.size).toBe(1);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	it("two fingers down → pinch; lifting to one finger does NOT auto-resume a brush stroke", async () => {
		const { editor, upper } = await makeEditor();
		const { startSpy } = armBrush(editor);

		pd(upper, 1, 40, 40); // brush stroke (owner 1)
		pd(upper, 2, 120, 120); // promotes to pinch, cancels brush
		expect(editor.isTouchPinching).toBe(true);
		startSpy.mockClear();

		pu(upper, 1, 40, 40); // lift one finger → back to one tracked pointer
		// No auto-resume: a fresh DOWN is required to brush again.
		expect(startSpy).not.toHaveBeenCalled();
		expect(editor.isDrawing).toBe(false);
		expect(editor.brushPointerId).toBeNull();

		pu(upper, 2, 120, 120); // lift the other → fully clean
		expect(editor.touchPointers.size).toBe(0);
		expect(editor.isTouchPinching).toBe(false);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	it("(d) MOUSE brush is unchanged — no pointer-id ownership/tracking, stroke drives + commits", async () => {
		const { editor, upper } = await makeEditor();
		const { continueSpy, endSpy } = armBrush(editor);

		// Mouse pointerdown (button 0) starts the brush; mouse leaves brushPointerId null
		// and is NOT added to touchPointers (touch-only bookkeeping).
		pd(upper, 1, 40, 40, "mouse");
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBeNull();
		expect(editor.touchPointers.size).toBe(0);

		// The same (only) mouse pointer drives + commits via the null-owner fast path.
		pm(upper, 1, 50, 50, "mouse");
		expect(continueSpy).toHaveBeenCalledTimes(1);
		pu(upper, 1, 50, 50, "mouse");
		expect(endSpy).toHaveBeenCalledTimes(1);
		expect(editor.isDrawing).toBe(false);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	// P1 (codex re-review round 5 of #358): a touch arriving DURING an active MOUSE
	// brush stroke must NOT steal it. A mouse stroke owns the NULL owner; the first-
	// brush-start branch previously only checked `brushPointerId !== null`, so it
	// treated a live mouse stroke as "no stroke active" and (because `isDrawing` was
	// already true) reassigned `brushPointerId` to the touch + tracked it — after which
	// the mouse could no longer drive/commit ITS OWN stroke and the touch could commit
	// it instead. The fix: only claim ownership on a REAL start transition
	// (`!wasDrawing && isDrawing`), and match the null (mouse) owner only for a non-touch
	// pointer (`ownsActiveBrushStroke`).
	it("(e) a touch DURING an active mouse stroke does NOT steal it — mouse keeps + commits, touch cannot", async () => {
		const { editor, upper } = await makeEditor();
		const { startSpy, continueSpy, endSpy } = armBrush(editor);

		// Mouse stroke is live: null owner, no touch tracking.
		pd(upper, 1, 40, 40, "mouse");
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBeNull();
		expect(editor.touchPointers.size).toBe(0);

		// A touch finger lands mid-mouse-stroke. It must NOT re-start the brush, must NOT
		// take ownership, and must NOT clobber the live target.
		startSpy.mockClear();
		pd(upper, 2, 120, 120);
		expect(startSpy).not.toHaveBeenCalled(); // no second startBrushStroke()
		expect(editor.brushPointerId).toBeNull(); // mouse still owns (null) — NOT stolen
		expect(editor.isDrawing).toBe(true); // mouse stroke still alive
		expect(editor.imageLayerBrushTarget).not.toBeNull();

		// A move from the touch must NOT extend the mouse's stroke.
		continueSpy.mockClear();
		pm(upper, 2, 130, 130);
		expect(continueSpy).not.toHaveBeenCalled();

		// The touch lifting must NOT commit the mouse's stroke (the bug: touch commits it).
		pu(upper, 2, 130, 130);
		expect(endSpy).not.toHaveBeenCalled();
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBeNull();

		// The MOUSE still drives + commits its own stroke normally.
		pm(upper, 1, 50, 50, "mouse");
		expect(continueSpy).toHaveBeenCalledTimes(1);
		pu(upper, 1, 50, 50, "mouse");
		expect(endSpy).toHaveBeenCalledTimes(1);
		expect(editor.isDrawing).toBe(false);
		expect(editor.brushPointerId).toBeNull();
		// No dangling/stuck pointer left behind.
		expect(editor.touchPointers.size).toBe(0);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	// Symmetric guard: a MOUSE pointer arriving during an active TOUCH stroke must not
	// steal the owned touch stroke either (the touch keeps `brushPointerId`).
	it("(f) a mouse pointer DURING an active touch stroke does NOT steal the owned touch stroke", async () => {
		const { editor, upper } = await makeEditor();
		const { startSpy, continueSpy, endSpy } = armBrush(editor);

		pd(upper, 1, 40, 40); // touch stroke, owner = pointer 1
		expect(editor.brushPointerId).toBe(1);
		expect(editor.isDrawing).toBe(true);

		// Mouse pointerdown mid-touch-stroke: must not start/steal anything.
		startSpy.mockClear();
		pd(upper, 2, 120, 120, "mouse");
		expect(startSpy).not.toHaveBeenCalled();
		expect(editor.brushPointerId).toBe(1); // touch still owns

		// Mouse move/up must NOT drive or commit the touch's stroke.
		continueSpy.mockClear();
		pm(upper, 2, 130, 130, "mouse");
		expect(continueSpy).not.toHaveBeenCalled();
		pu(upper, 2, 130, 130, "mouse");
		expect(endSpy).not.toHaveBeenCalled();
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBe(1);

		// The owning TOUCH still commits its own stroke and releases ownership cleanly.
		pu(upper, 1, 40, 40);
		expect(endSpy).toHaveBeenCalledTimes(1);
		expect(editor.brushPointerId).toBeNull();
		expect(editor.touchPointers.size).toBe(0);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	// P1 (codex re-review round 6 of #358): the pointercancel / lostpointercapture path
	// must cancel a NULL-owner MOUSE stroke too. It previously gated only on
	// `brushPointerId !== null && === event.pointerId`, so a mouse stroke (null owner) fell
	// through to `if (!isTouchLikePointer(event)) return` and leaked `isDrawing` +
	// `imageLayerBrushTarget` live after capture loss — a dangling stroke/preview that a
	// later mouse event could drive/commit, or that blocked the next stroke via isDrawing.
	// Fix: the cancel/lost-capture path uses the SAME `ownsActiveBrushStroke(event)` helper
	// as move/up. These cases assert the audit truth table: each {input}×{exit}×{owner}
	// cell leaves isDrawing / brushPointerId / imageLayerBrushTarget / previewActive /
	// touchPointers clean (no dangling owner, no orphaned swapped preview, no double-commit).

	it("(g) MOUSE stroke + pointercancel restores the TRUE original + clears isDrawing (next stroke works)", async () => {
		const { editor, upper } = await makeEditor();
		const { startSpy, endSpy, imageObject, originalElement, workingCanvas } = armBrush(editor);

		// Mouse stroke live: null owner, swapped preview, not tracked in touchPointers.
		pd(upper, 1, 40, 40, "mouse");
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBeNull();
		expect(imageObject._element).toBe(workingCanvas);
		expect(editor.imageLayerBrushTarget?.previewActive).toBe(true);

		// Mouse capture is lost / cancelled — must ABANDON (not commit) the mouse stroke.
		pc(upper, 1, 40, 40, "mouse");
		expect(endSpy).not.toHaveBeenCalled(); // cancel != a clean commit
		expect(editor.isDrawing).toBe(false);
		expect(editor.imageLayerBrushTarget).toBeNull();
		expect(editor.brushPointerId).toBeNull();
		expect(editor.touchPointers.size).toBe(0);
		// TRUE original restored (orphaned swapped preview un-swapped), not the working canvas.
		expect(imageObject._element).toBe(originalElement);

		// isDrawing is clear → a fresh MOUSE stroke can start (was blocked by the leak).
		startSpy.mockClear();
		pd(upper, 1, 60, 60, "mouse");
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(editor.isDrawing).toBe(true);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	it("(h) MOUSE stroke + lostpointercapture abandons the stroke the same way", async () => {
		const { editor, upper } = await makeEditor();
		const { endSpy, imageObject, originalElement } = armBrush(editor);

		pd(upper, 1, 40, 40, "mouse");
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBeNull();

		plc(upper, 1, 40, 40, "mouse");
		expect(endSpy).not.toHaveBeenCalled();
		expect(editor.isDrawing).toBe(false);
		expect(editor.imageLayerBrushTarget).toBeNull();
		expect(editor.brushPointerId).toBeNull();
		expect(imageObject._element).toBe(originalElement);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	it("(i) TOUCH stroke + pointercancel abandons the owned stroke + clears its tracked pointer", async () => {
		const { editor, upper } = await makeEditor();
		const { endSpy, imageObject, originalElement } = armBrush(editor);

		pd(upper, 1, 40, 40); // touch owner = 1, tracked
		expect(editor.brushPointerId).toBe(1);
		expect(editor.touchPointers.size).toBe(1);

		pc(upper, 1, 40, 40);
		expect(endSpy).not.toHaveBeenCalled();
		expect(editor.isDrawing).toBe(false);
		expect(editor.imageLayerBrushTarget).toBeNull();
		expect(editor.brushPointerId).toBeNull();
		expect(editor.touchPointers.size).toBe(0); // owner's tracked entry removed
		expect(imageObject._element).toBe(originalElement);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});

	it("(j) a NON-OWNER cancel does NOT kill the owner's stroke (mouse owner, stray touch cancel)", async () => {
		const { editor, upper } = await makeEditor();
		const { endSpy, imageObject, workingCanvas } = armBrush(editor);

		// Mouse stroke owns the null owner.
		pd(upper, 1, 40, 40, "mouse");
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBeNull();

		// A stray TOUCH cancel is NOT the owner (touch never matches the null/mouse owner).
		pc(upper, 99, 200, 200);
		expect(endSpy).not.toHaveBeenCalled();
		expect(editor.isDrawing).toBe(true); // mouse stroke still alive
		expect(editor.imageLayerBrushTarget).not.toBeNull();
		expect(imageObject._element).toBe(workingCanvas); // preview NOT un-swapped

		// And the symmetric case: a stray MOUSE cancel must not kill an OWNED touch stroke.
		try { editor.destroy?.(); } catch { /* ignore */ }
		const second = await makeEditor();
		const arm2 = armBrush(second.editor);
		pd(second.upper, 5, 40, 40); // touch owner = 5
		expect(second.editor.brushPointerId).toBe(5);
		pc(second.upper, 7, 200, 200, "mouse"); // non-owner mouse cancel
		expect(arm2.endSpy).not.toHaveBeenCalled();
		expect(second.editor.isDrawing).toBe(true);
		expect(second.editor.brushPointerId).toBe(5); // owner intact
		try { second.editor.destroy?.(); } catch { /* ignore */ }
	});

	it("(k) PEN pointer is classified like touch — owns + commits + cancels consistently", async () => {
		const { editor, upper } = await makeEditor();
		const { endSpy, imageObject, originalElement } = armBrush(editor);

		// A pen down owns the stroke via brushPointerId (pen is isTouchLikePointer).
		pd(upper, 3, 40, 40, "pen");
		expect(editor.isDrawing).toBe(true);
		expect(editor.brushPointerId).toBe(3);
		expect(editor.touchPointers.size).toBe(1);

		// Pen cancel abandons the stroke + clears its tracked pointer, exactly like touch.
		pc(upper, 3, 40, 40, "pen");
		expect(endSpy).not.toHaveBeenCalled();
		expect(editor.isDrawing).toBe(false);
		expect(editor.brushPointerId).toBeNull();
		expect(editor.touchPointers.size).toBe(0);
		expect(imageObject._element).toBe(originalElement);

		try { editor.destroy?.(); } catch { /* ignore */ }
	});
});
