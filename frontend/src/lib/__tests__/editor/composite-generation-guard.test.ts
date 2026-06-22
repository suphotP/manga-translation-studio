// codex-audit P1-1 — a STALE async edit-composite rebuild must NOT attach over the
// page that is current when it finishes. rebuildEditComposite() awaits per-layer asset
// loads in a loop, then attaches the overlay to whatever imageItem/imageBounds are
// CURRENT at completion. If page A is still rebuilding when the user switches to page B
// (loadImage bumps imageLoadGeneration, setImageEditLayers changes editLayersSourceImageId),
// A's late rebuild can attach A's composite over B. The fix snapshots the epoch +
// sourceImageId at the start and bails (no attach, no clear) once either has moved on.
//
// codex-audit P1-2 — async undo/redo must be SERIALIZED. The HistoryManager pops the
// stack synchronously and the command runs async (edit-layer commands await a full
// composite rebuild). Without serialization a rapid second undo pops again and runs its
// command while the first is mid-flight → the two interleave and corrupt the stack. The
// fix chains every undo/redo onto one tail promise (press-order, none dropped).

import { describe, it, expect, vi } from "vitest";
import {
	MangaEditor,
	__test_HistoryManager as HistoryManager,
} from "$lib/canvas/editor.ts";
import type { ImageEditLayer } from "$lib/types.ts";

vi.mock("$lib/config.js", () => ({
	config: {
		defaultFontFamily: "Tahoma, sans-serif",
		defaultFontSize: 24,
		defaultText: "ข้อความ",
		canvas: { minZoom: 0.1, maxZoom: 5 },
	},
}));

function makeLayer(id: string, index: number): ImageEditLayer {
	return {
		id,
		kind: "bubble-clean",
		target: "page-background",
		visible: true,
		opacity: 1,
		sourceImageId: "page-A",
		bbox: { x: 0, y: 0, w: 10, h: 10 },
		payload: { type: "fill-mask", maskAssetId: `${id}-mask`, maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } },
		index,
		tool: { id: "bubble-clean" },
		createdAt: "2026-06-07T00:00:00.000Z",
	};
}

/** A deferred promise we can resolve from the test to gate an in-flight paint. */
function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function makeCompositeEditor(layers: ImageEditLayer[], sourceImageId: string) {
	const editor = Object.create(MangaEditor.prototype) as any;
	editor.imageWidth = 64;
	editor.imageHeight = 64;
	editor.imageItem = { dirty: false };
	editor.imageBounds = { left: 0, top: 0, width: 64, height: 64 };
	editor.imageEditLayers = layers.map((l) => ({ ...l }));
	editor.editLayersSourceImageId = sourceImageId;
	editor.imageLoadGeneration = 1;
	editor.editStackGeneration = 0;
	editor.attachEditCompositeOverlay = vi.fn();
	editor.removeEditComposite = vi.fn();
	return editor;
}

describe("P1-1 — edit-composite generation/source guard", () => {
	it("a rebuild whose page-epoch advances mid-await does NOT attach the stale composite", async () => {
		const editor = makeCompositeEditor([makeLayer("a", 0)], "page-A");

		const gate = deferred();
		editor.paintFillMaskLayer = vi.fn(async () => {
			// Simulate the page switch (loadImage bumps the epoch) WHILE this paint awaits.
			editor.imageLoadGeneration += 1;
			await gate.promise;
		});

		const run = MangaEditor.prototype["rebuildEditComposite"].call(editor) as Promise<void>;
		gate.resolve();
		await run;

		// Painted (started before the switch) but NEVER attached over the now-current page.
		expect(editor.paintFillMaskLayer).toHaveBeenCalledTimes(1);
		expect(editor.attachEditCompositeOverlay).not.toHaveBeenCalled();
	});

	it("a rebuild whose source-imageId changes mid-await does NOT attach the stale composite", async () => {
		const editor = makeCompositeEditor([makeLayer("a", 0)], "page-A");

		const gate = deferred();
		editor.paintFillMaskLayer = vi.fn(async () => {
			// Simulate setImageEditLayers re-feeding a DIFFERENT page's stack while awaiting.
			editor.editLayersSourceImageId = "page-B";
			await gate.promise;
		});

		const run = MangaEditor.prototype["rebuildEditComposite"].call(editor) as Promise<void>;
		gate.resolve();
		await run;

		expect(editor.attachEditCompositeOverlay).not.toHaveBeenCalled();
	});

	it("a rebuild that empties + goes stale before its final clear does NOT wipe the now-current page's overlay", async () => {
		// A rebuild with one composable layer whose paint is gated; while it awaits, the
		// page switches AND the layer is also removed from the live stack. The rebuild
		// must NOT attach (stale) — and because it bailed, it must NOT removeEditComposite
		// either (that clear belongs only to the CURRENT page's own rebuild).
		const editor = makeCompositeEditor([makeLayer("a", 0)], "page-A");
		const gate = deferred();
		editor.paintFillMaskLayer = vi.fn(async () => {
			editor.imageLoadGeneration += 1; // page switched mid-await
			await gate.promise;
		});

		const run = MangaEditor.prototype["rebuildEditComposite"].call(editor) as Promise<void>;
		gate.resolve();
		await run;

		expect(editor.attachEditCompositeOverlay).not.toHaveBeenCalled();
		expect(editor.removeEditComposite).not.toHaveBeenCalled();
	});

	it("a NON-stale rebuild attaches normally (control)", async () => {
		const editor = makeCompositeEditor([makeLayer("a", 0)], "page-A");
		editor.paintFillMaskLayer = vi.fn(async () => {});

		await MangaEditor.prototype["rebuildEditComposite"].call(editor);
		expect(editor.attachEditCompositeOverlay).toHaveBeenCalledTimes(1);
	});

	it("a NON-stale empty-stack rebuild clears the overlay (control)", async () => {
		const editor = makeCompositeEditor([], "page-A");
		await MangaEditor.prototype["rebuildEditComposite"].call(editor);
		expect(editor.removeEditComposite).toHaveBeenCalledTimes(1);
	});
});

describe("P1-2b — same-page stale-rebuild (edit-stack generation) guard", () => {
	// The page does NOT switch and the source image does NOT change — same page, same
	// source — so the P1-1 epoch/source guards are BOTH satisfied for the old rebuild.
	// Sequence: a page-load rebuild for stack [a] is in flight; a live commit appends
	// [a,b] and triggers its OWN rebuild; the [a,b] rebuild attaches FIRST, then the
	// older [a] rebuild finishes LATER. Without the edit-stack token the stale [a]
	// rebuild would attach over the valid [a,b] composite → edit `b` disappears. With
	// the token, only the newest rebuild may attach.
	it("a stale [a] rebuild that finishes AFTER the newer [a,b] rebuild does NOT attach over it", async () => {
		const editor = makeCompositeEditor([makeLayer("a", 0)], "page-A");

		// Gate the FIRST (stack [a]) rebuild's paint so it stays in flight while the
		// second rebuild runs to completion.
		const gateA = deferred();
		// Record the stack size present at each attach so we can prove which composite landed.
		const attachedStackSizes: number[] = [];
		editor.attachEditCompositeOverlay = vi.fn(() => {
			attachedStackSizes.push(editor.imageEditLayers.length);
		});

		let firstPaint = true;
		editor.paintFillMaskLayer = vi.fn(async (_ctx: unknown, layer: ImageEditLayer) => {
			if (firstPaint && layer.id === "a") {
				firstPaint = false;
				// While the [a] rebuild awaits here, a live commit appends b (same page,
				// same source) and kicks off its own rebuild that finishes synchronously.
				editor.imageEditLayers = [makeLayer("a", 0), makeLayer("b", 1)];
				await MangaEditor.prototype["rebuildEditComposite"].call(editor);
				// Now let the OLD [a] rebuild resume — it is now stale by edit-stack token.
				await gateA.promise;
			}
		});

		const runA = MangaEditor.prototype["rebuildEditComposite"].call(editor) as Promise<void>;
		gateA.resolve();
		await runA;

		// Exactly ONE attach happened — the newer [a,b] rebuild — and it carried both layers.
		expect(attachedStackSizes).toEqual([2]);
		// The stale [a] rebuild must NOT have attached its single-layer composite on top.
		expect(editor.attachEditCompositeOverlay).toHaveBeenCalledTimes(1);
	});

	it("the NEWEST rebuild always runs to completion (the guard never drops the latest)", async () => {
		// Two back-to-back rebuilds for the same page/source; the SECOND must attach.
		const editor = makeCompositeEditor([makeLayer("a", 0)], "page-A");
		editor.paintFillMaskLayer = vi.fn(async () => {});

		const r1 = MangaEditor.prototype["rebuildEditComposite"].call(editor) as Promise<void>;
		editor.imageEditLayers = [makeLayer("a", 0), makeLayer("b", 1)];
		const r2 = MangaEditor.prototype["rebuildEditComposite"].call(editor) as Promise<void>;
		await Promise.all([r1, r2]);

		// The latest (newest token) rebuild attached at least once; the stale older one
		// did not win — net result is a single surviving attach of the latest composite.
		expect(editor.attachEditCompositeOverlay).toHaveBeenCalledTimes(1);
	});
});

describe("P1-3 — stale rebuild's LATE paint must not mutate the attached composite", () => {
	// The editStackGeneration token stops a stale rebuild's final attach, but the OLDER
	// fix still let every rebuild paint into the SHARED this.editCompositeCanvas which it
	// published BEFORE the async paint loop. A newer rebuild could attach that same canvas;
	// then the older rebuild RESUMED inside paintFillMaskLayer and mutated the already-
	// attached shared canvas before its next isStale() check → visible composite corrupted
	// even though the final attach no-ops. The fix: each rebuild paints into a PRIVATE
	// local canvas and publishes (assigns this.editCompositeCanvas + attaches) ONLY after
	// the final isStale() check passes, so a stale rebuild never touches the attached one.
	it("an older [a,b] rebuild resuming its paint AFTER the newer [a] rebuild attached does NOT touch the attached canvas", async () => {
		const editor = makeCompositeEditor([makeLayer("a", 0), makeLayer("b", 1)], "page-A");

		// Capture the canvas instance each attach publishes (the REAL attach reads
		// this.editCompositeCanvas, which is only ever assigned right before attach now).
		const attachedCanvases: Array<HTMLCanvasElement | null> = [];
		editor.attachEditCompositeOverlay = vi.fn(() => {
			attachedCanvases.push(editor.editCompositeCanvas);
		});

		// The corruption window is INSIDE paintFillMaskLayer: the old rebuild's paint is
		// mid-flight (it already passed the loop's isStale() check) when the newer rebuild
		// attaches; then the old paint RESUMES and writes into its ctx. We capture the
		// canvas each paint writes to and the byte the OLD paint writes AFTER the newer
		// rebuild attached, to prove that late write never lands on the attached canvas.
		const paintedCanvases: Array<HTMLCanvasElement | null> = [];
		const gateOld = deferred();
		let started = false;
		let lateOldWriteCanvas: HTMLCanvasElement | null = null;
		editor.paintFillMaskLayer = vi.fn(async (ctx: CanvasRenderingContext2D, layer: ImageEditLayer) => {
			paintedCanvases.push(ctx.canvas);
			if (!started && layer.id === "a") {
				started = true;
				// While the OLD rebuild is mid-paint of layer a (past the loop isStale check),
				// a NEWER rebuild for the SAME page (e.g. an undo reducing the stack to [a])
				// runs to completion and attaches first.
				editor.imageEditLayers = [makeLayer("a", 0)];
				await MangaEditor.prototype["rebuildEditComposite"].call(editor);
				// The newer rebuild has attached. The OLD paint now RESUMES and mutates its
				// ctx's canvas — this is the corruption scenario. Record which canvas it hits.
				await gateOld.promise;
				ctx.fillStyle = "rgba(1,2,3,1)";
				ctx.fillRect(0, 0, 1, 1);
				lateOldWriteCanvas = ctx.canvas;
			}
		});

		const runOld = MangaEditor.prototype["rebuildEditComposite"].call(editor) as Promise<void>;
		gateOld.resolve();
		await runOld;

		// Exactly ONE attach — the newer rebuild — and it published a real canvas.
		expect(attachedCanvases).toHaveLength(1);
		const attached = attachedCanvases[0];
		expect(attached).toBeInstanceOf(HTMLCanvasElement);

		// paintedCanvases: [oldA (the gated/resumed paint), newerA].
		// The newer rebuild painted into exactly what it attached (its own private canvas).
		const oldCanvas = paintedCanvases[0];
		const newerCanvas = paintedCanvases[1];
		expect(newerCanvas).toBe(attached);
		// The old + newer rebuilds used DISTINCT private canvases.
		expect(oldCanvas).not.toBe(newerCanvas);
		// The KEY property: the OLD rebuild's LATE write (after the newer attached) landed
		// on its OWN throwaway canvas, NOT the attached one — so the attached composite is
		// never corrupted by the stale rebuild.
		expect(lateOldWriteCanvas).toBe(oldCanvas);
		expect(lateOldWriteCanvas).not.toBe(attached);

		// The published canvas reference is still the newer rebuild's canvas — the stale
		// rebuild never re-published over it.
		expect(editor.editCompositeCanvas).toBe(attached);
	});

	it("the attached composite's PIXELS are unchanged when a stale rebuild paints late", async () => {
		// End-to-end pixel proof using the REAL paintFillMaskLayer against stub mask assets.
		const editor = makeCompositeEditor([makeLayer("a", 0), makeLayer("b", 1)], "page-A");

		// A 10x10 fully-opaque mask element for every asset; paintFillMaskLayer reads its
		// alpha and writes the layer fill into the composite at the layer bbox.
		const makeMaskEl = () => {
			const c = document.createElement("canvas");
			c.width = 10;
			c.height = 10;
			const cx = c.getContext("2d")!;
			cx.fillStyle = "rgba(0,0,0,1)";
			cx.fillRect(0, 0, 10, 10);
			return c;
		};
		editor.projectImageUrlResolver = (id: string) => `blob:${id}`;
		editor.loadFabricImage = vi.fn(async () => ({}));
		editor.getImageObjectSourceElement = () => makeMaskEl();
		editor.disposeFabricImageObject = vi.fn();

		// Give layer "a" white fill, layer "b" a distinct fill so we can detect corruption.
		editor.imageEditLayers = [
			{ ...makeLayer("a", 0), payload: { type: "fill-mask", maskAssetId: "a-mask", maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } }, bbox: { x: 0, y: 0, w: 10, h: 10 } },
			{ ...makeLayer("b", 1), payload: { type: "fill-mask", maskAssetId: "b-mask", maskEncoding: "png-alpha", fill: { r: 7, g: 8, b: 9, a: 255 } }, bbox: { x: 0, y: 0, w: 10, h: 10 } },
		];

		const attachedCanvases: HTMLCanvasElement[] = [];
		editor.attachEditCompositeOverlay = vi.fn(() => {
			attachedCanvases.push(editor.editCompositeCanvas);
		});

		// Gate the OLD rebuild mid-paint of layer a; while gated, a newer [a]-only rebuild
		// runs to completion and attaches its (white) composite. Then the OLD rebuild
		// RESUMES and paints layer b's distinct (7,8,9) fill — the corruption window.
		const realPaint = MangaEditor.prototype["paintFillMaskLayer"];
		const gateOld = deferred();
		let gatedOnce = false;
		editor.paintFillMaskLayer = vi.fn(async function (this: unknown, ctx: CanvasRenderingContext2D, layer: ImageEditLayer) {
			if (!gatedOnce && layer.id === "a") {
				gatedOnce = true;
				await realPaint.call(editor, ctx, layer); // old paints a into its own canvas
				editor.imageEditLayers = [makeLayer("a", 0)]; // newer stack = [a] only
				await MangaEditor.prototype["rebuildEditComposite"].call(editor); // newer attaches
				await gateOld.promise;
				// Old rebuild resumes; force it to paint b's distinct fill into ITS ctx.
				const layerB: ImageEditLayer = {
					...makeLayer("b", 1),
					payload: { type: "fill-mask", maskAssetId: "b-mask", maskEncoding: "png-alpha", fill: { r: 7, g: 8, b: 9, a: 255 } },
					bbox: { x: 0, y: 0, w: 10, h: 10 },
				};
				await realPaint.call(editor, ctx, layerB);
				return;
			}
			await realPaint.call(editor, ctx, layer);
		});

		const runOld = MangaEditor.prototype["rebuildEditComposite"].call(editor) as Promise<void>;
		gateOld.resolve();
		await runOld;

		expect(attachedCanvases).toHaveLength(1);
		const attached = attachedCanvases[0];
		// Snapshot the attached canvas pixels — they reflect ONLY the newer [a] rebuild
		// (white fill at 0,0). The stale old rebuild later painted b's (7,8,9) fill — but
		// into its OWN canvas, so the attached pixels must remain white, not corrupted.
		const px = attached.getContext("2d")!.getImageData(0, 0, 1, 1).data;
		expect([px[0], px[1], px[2], px[3]]).toEqual([255, 255, 255, 255]);
	});
});

/** An async command whose execute/undo can be gated so we can force overlap. */
function makeGatedCommand(log: string[], id: string) {
	const undoGate = deferred();
	const redoGate = deferred();
	return {
		undoGate,
		redoGate,
		command: {
			async execute() {
				log.push(`${id}:execute:start`);
				await redoGate.promise;
				log.push(`${id}:execute:end`);
			},
			async undo() {
				log.push(`${id}:undo:start`);
				await undoGate.promise;
				log.push(`${id}:undo:end`);
			},
		},
	};
}

function makeHistoryEditor() {
	const editor = Object.create(MangaEditor.prototype) as any;
	editor.history = new HistoryManager();
	editor.historyChain = Promise.resolve(false);
	editor.onHistoryChange = vi.fn();
	return editor;
}

describe("P1-2 — undo/redo serialization", () => {
	it("two rapid undo() calls run strictly one-at-a-time (no interleave) and both complete", async () => {
		const editor = makeHistoryEditor();
		const log: string[] = [];
		const c1 = makeGatedCommand(log, "c1");
		const c2 = makeGatedCommand(log, "c2");
		// Stack order: c1 pushed first, c2 second → undo pops c2 then c1.
		editor.history.undoStack = [c1.command, c2.command];
		editor.history.redoStack = [];

		// Fire BOTH undos back-to-back before resolving any gate.
		const p1 = editor.undo();
		const p2 = editor.undo();

		// Only the FIRST command may have started — the second is queued, not interleaved.
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual(["c2:undo:start"]);

		// Release the first; the second must start only AFTER the first fully ends.
		c2.undoGate.resolve();
		await Promise.resolve();
		await Promise.resolve();
		c1.undoGate.resolve();
		await Promise.all([p1, p2]);

		expect(log).toEqual(["c2:undo:start", "c2:undo:end", "c1:undo:start", "c1:undo:end"]);
		// Stack integrity: both moved undo→redo, in order.
		expect(editor.history.undoStack).toEqual([]);
		expect(editor.history.redoStack).toEqual([c2.command, c1.command]);
	});

	it("interleaved undo then redo serialize and keep the stack consistent", async () => {
		const editor = makeHistoryEditor();
		const log: string[] = [];
		const c1 = makeGatedCommand(log, "c1");
		editor.history.undoStack = [c1.command];
		editor.history.redoStack = [];

		const pUndo = editor.undo();
		const pRedo = editor.redo();

		// Undo runs first (and alone); redo must NOT start until undo finishes.
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual(["c1:undo:start"]);

		c1.undoGate.resolve();
		await Promise.resolve();
		await Promise.resolve();
		// Now redo (popped from redoStack after undo pushed c1 there) may run.
		expect(log).toContain("c1:undo:end");

		c1.redoGate.resolve();
		await Promise.all([pUndo, pRedo]);

		expect(log).toEqual([
			"c1:undo:start",
			"c1:undo:end",
			"c1:execute:start",
			"c1:execute:end",
		]);
		// After undo→redo round trip the command is back on the undo stack exactly once.
		expect(editor.history.undoStack).toEqual([c1.command]);
		expect(editor.history.redoStack).toEqual([]);
	});

	it("a failing undo command does not wedge the chain (later undo still runs)", async () => {
		const editor = makeHistoryEditor();
		const log: string[] = [];
		const boom = {
			async undo() {
				log.push("boom");
				throw new Error("undo failed");
			},
		};
		const ok = {
			async undo() {
				log.push("ok");
			},
		};
		editor.history.undoStack = [ok, boom];

		const p1 = editor.undo().catch(() => "rejected");
		const p2 = editor.undo();

		const [r1] = await Promise.all([p1, p2]);
		expect(r1).toBe("rejected");
		// The second undo still executed after the first threw — chain not poisoned.
		expect(log).toEqual(["boom", "ok"]);
	});
});
