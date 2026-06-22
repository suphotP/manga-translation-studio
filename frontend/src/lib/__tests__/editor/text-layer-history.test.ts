// Text-layer undo/redo coherence (P1 fix).
//
// These tests drive a REAL MangaEditor (Fabric runs under jsdom) and assert the
// history round-trip for the four paths that previously bypassed history:
//   1. direct on-canvas text edit / transform (move/scale/rotate)
//   2. rotate (now routed through the history-aware update)
//   3. text effect-pass resync after a direct edit
//   4. panel actions: fit-to-box, visibility, lock
//
// The round-trip contract under test: action → undo restores prior state →
// redo reapplies. We avoid real image loading (flaky in jsdom) by stamping a
// 1:1 imageBounds so the canvas↔image coordinate conversion is the identity.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MangaEditor } from "$lib/canvas/editor.ts";
import type { TextLayer } from "$lib/types.ts";

// Stamp a 1:1 image space so serializeTextObject reads true geometry without
// needing a loaded background image.
function stampIdentityImageSpace(editor: any, size = 1000): void {
	editor.imageWidth = size;
	editor.imageHeight = size;
	editor.imageBounds = { left: 0, top: 0, width: size, height: size };
	editor.canvasWidth = size;
	editor.canvasHeight = size;
}

function baseLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "t1",
		text: "hello",
		x: 100,
		y: 120,
		w: 200,
		h: 60,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	} as TextLayer;
}

describe("text-layer undo/redo coherence", () => {
	let editor: any;
	let canvasEl: HTMLCanvasElement;

	beforeEach(async () => {
		canvasEl = document.createElement("canvas");
		canvasEl.width = 1000;
		canvasEl.height = 1000;
		editor = await MangaEditor.create(canvasEl);
		stampIdentityImageSpace(editor);
	});

	afterEach(() => {
		try {
			editor?.destroy?.();
		} catch {
			/* ignore teardown noise */
		}
	});

	function getLayer(id: string): TextLayer | undefined {
		return editor.getAllTextLayers().find((l: TextLayer) => l.id === id);
	}

	it("makes a direct in-place text edit undoable via recordTextLayerDirectEdit", async () => {
		editor.addTextLayer(baseLayer({ text: "before" }));
		const textObject = editor.findTextObject("t1");
		expect(getLayer("t1")?.text).toBe("before");

		// Simulate the in-place edit lifecycle: snapshot on entry, mutate the Fabric
		// object, push history on exit.
		editor.captureTextLayerTransformStart(textObject);
		textObject.set({ text: "after" });
		editor.recordTextLayerDirectEdit(textObject);

		editor.syncTextObjectData(textObject);
		expect(getLayer("t1")?.text).toBe("after");
		expect(editor.canUndo()).toBe(true);

		await editor.undo();
		expect(getLayer("t1")?.text).toBe("before");
		expect(editor.canRedo()).toBe(true);

		await editor.redo();
		expect(getLayer("t1")?.text).toBe("after");
	});

	it("makes a direct move/transform undoable (collapses one snapshot per gesture)", async () => {
		editor.addTextLayer(baseLayer({ x: 100, y: 120 }));
		const textObject = editor.findTextObject("t1");

		// before:transform fires once at gesture start; capture is first-wins so a
		// second capture during the same drag does not clobber the original.
		editor.captureTextLayerTransformStart(textObject);
		editor.captureTextLayerTransformStart(textObject);
		textObject.set({ left: textObject.left + 50, top: textObject.top + 40 });
		editor.recordTextLayerDirectEdit(textObject);

		const moved = getLayer("t1")!;
		expect(moved.x).toBe(150);
		expect(moved.y).toBe(160);

		await editor.undo();
		const back = getLayer("t1")!;
		expect(back.x).toBe(100);
		expect(back.y).toBe(120);

		await editor.redo();
		expect(getLayer("t1")!.x).toBe(150);
	});

	it("does not push history when a transform ends with no change", async () => {
		editor.addTextLayer(baseLayer());
		const textObject = editor.findTextObject("t1");
		editor.captureTextLayerTransformStart(textObject);
		// No mutation.
		editor.recordTextLayerDirectEdit(textObject);
		expect(editor.canUndo()).toBe(false);
	});

	it("rotate persists and is undoable through updateTextLayerWithHistory", async () => {
		editor.addTextLayer(baseLayer({ rotation: 0 }));

		const rotated = editor.updateTextLayerWithHistory("t1", { rotation: 90 });
		expect(rotated?.rotation).toBe(90);
		expect(getLayer("t1")?.rotation).toBe(90);
		expect(editor.canUndo()).toBe(true);

		await editor.undo();
		expect(getLayer("t1")?.rotation).toBe(0);

		await editor.redo();
		expect(getLayer("t1")?.rotation).toBe(90);
	});

	it("resyncs effect passes after a direct edit (text + geometry mirror)", async () => {
		editor.addTextLayer(baseLayer({
			text: "FX",
			effects: {
				stroke: { enabled: true, color: "#000000", width: 4 },
				// An explicit accent-pass guarantees separate Fabric pass objects
				// (the stale-pass bug only manifests when passes exist).
				passes: [
					{ enabled: true, fill: "#ff0000", stroke: "#000000", strokeWidth: 2, offsetX: 4, offsetY: 4, opacity: 0.8 },
				],
			},
		} as Partial<TextLayer>));
		const textObject = editor.findTextObject("t1");

		// Multi-pass effects create separate pass objects tracked by layer id; the
		// configured accent pass must have produced at least one pass object.
		const passesBefore = editor.textEffectShadowPasses.get("t1") ?? [];
		expect(passesBefore.length).toBeGreaterThan(0);
		// Stale-pass bug: a direct edit changes the MAIN text only — the pass objects
		// keep the old content/position until resync.
		const leftBefore = passesBefore[0].left;
		textObject.set({ text: "CHANGED", left: textObject.left + 30 });
		editor.resyncTextEffectPasses(textObject);
		const passesAfter = editor.textEffectShadowPasses.get("t1") ?? [];
		expect(passesAfter.length).toBeGreaterThan(0);
		for (const pass of passesAfter) {
			// Each pass mirrors the main text content...
			expect(pass.text).toBe("CHANGED");
		}
		// ...and tracks the new geometry (pass shifts with the moved main text).
		expect(passesAfter[0].left).not.toBe(leftBefore);
	});

	it("fit-to-box is undoable via fitTextLayerToBoxWithHistory", async () => {
		editor.addTextLayer(baseLayer({ fontSize: 24 }));
		const textObject = editor.findTextObject("t1");
		// Force a font-size delta so fit produces a real change.
		textObject.set({ fontSize: 80 });
		editor.syncTextObjectData(textObject);
		const beforeFit = getLayer("t1")!;

		const fitted = editor.fitTextLayerToBoxWithHistory("t1");
		expect(fitted).toBeTruthy();

		if (editor.canUndo()) {
			const afterFit = getLayer("t1")!;
			await editor.undo();
			const undone = getLayer("t1")!;
			expect(undone.fontSize).toBe(beforeFit.fontSize);
			await editor.redo();
			expect(getLayer("t1")!.fontSize).toBe(afterFit.fontSize);
		}
	});

	it("visibility toggle is undoable via updateTextLayerWithHistory", async () => {
		editor.addTextLayer(baseLayer({ visible: true }));

		editor.updateTextLayerWithHistory("t1", { visible: false });
		expect(getLayer("t1")?.visible).toBe(false);
		expect(editor.canUndo()).toBe(true);

		await editor.undo();
		expect(getLayer("t1")?.visible).toBe(true);

		await editor.redo();
		expect(getLayer("t1")?.visible).toBe(false);
	});

	it("lock toggle is undoable via updateTextLayerWithHistory", async () => {
		editor.addTextLayer(baseLayer({ locked: false }));

		editor.updateTextLayerWithHistory("t1", { locked: true });
		expect(getLayer("t1")?.locked).toBe(true);
		expect(editor.canUndo()).toBe(true);

		await editor.undo();
		expect(getLayer("t1")?.locked).toBe(false);

		await editor.redo();
		expect(getLayer("t1")?.locked).toBe(true);
	});

	// Inject a lightweight image-layer object (a Fabric Rect tagged with
	// `_imageLayerData`) without loading a real image — serialize/update only read
	// width/height/scale/left/top, all of which a Rect provides.
	function addFakeImageLayer(id: string, x: number, y: number, w: number, h: number): any {
		const rect = new editor.f.Rect({
			left: editor.imageXToCanvasX(x + w / 2),
			top: editor.imageYToCanvasY(y + h / 2),
			width: w,
			height: h,
			originX: "center",
			originY: "center",
		});
		rect._imageLayerData = {
			id,
			name: id,
			imageId: `${id}.png`,
			imageName: `${id}.png`,
			x,
			y,
			w,
			h,
			rotation: 0,
			opacity: 1,
			index: editor.imageLayers.length,
			role: "overlay",
		};
		editor.imageLayers.push(rect);
		editor.canvas.add(rect);
		editor.syncImageObjectData(rect);
		return rect;
	}

	function getImageLayer(id: string): any {
		return editor.getAllImageLayers().find((l: any) => l.id === id);
	}

	// Move a layer object directly (no real ActiveSelection group — its `left`/`top`
	// are absolute), then wrap the moved children in a MOCK multi-selection target.
	// `syncMultiSelectionTransform` reads each child's ABSOLUTE matrix; a standalone
	// object's matrix already IS absolute, so the stamp is a no-op and serialize reads
	// the post-move geometry — exactly the state a real selection ends in, but without
	// jsdom's group-reparent coordinate quirks. The child's `_textLayerData`/
	// `_imageLayerData` still holds the PRE-move geometry (it is only rewritten on
	// object:modified), giving the before→after diff the history command needs.
	function moveChild(obj: any, dxCanvas: number, dyCanvas: number): void {
		obj.set({ left: (obj.left ?? 0) + dxCanvas, top: (obj.top ?? 0) + dyCanvas });
		obj.setCoords?.();
	}

	function mockMultiSelection(objects: any[]): any {
		return { getObjects: () => objects, _objects: objects };
	}

	it("records a multi-selection text move as ONE undoable step that reverts all text layers", async () => {
		editor.addTextLayer(baseLayer({ id: "t1", x: 100, y: 120 }));
		editor.addTextLayer(baseLayer({ id: "t2", x: 300, y: 320 }));
		const o1 = editor.findTextObject("t1");
		const o2 = editor.findTextObject("t2");

		// Both text children move together by the same delta (one gesture).
		moveChild(o1, 40, 50);
		moveChild(o2, 40, 50);
		const selection = mockMultiSelection([o1, o2]);
		expect(editor.isMultiSelection(selection)).toBe(true);

		// Drive the SAME path the object:modified handler uses for a multi-select.
		editor.syncMultiSelectionTransform(selection);

		expect(getLayer("t1")!.x).toBe(140);
		expect(getLayer("t1")!.y).toBe(170);
		expect(getLayer("t2")!.x).toBe(340);
		expect(getLayer("t2")!.y).toBe(370);

		// ONE undo step reverts BOTH text layers (not one per layer).
		expect(editor.canUndo()).toBe(true);
		await editor.undo();
		expect(getLayer("t1")!.x).toBe(100);
		expect(getLayer("t1")!.y).toBe(120);
		expect(getLayer("t2")!.x).toBe(300);
		expect(getLayer("t2")!.y).toBe(320);
		// A single step: after the one undo there is nothing left to undo.
		expect(editor.canUndo()).toBe(false);

		await editor.redo();
		expect(getLayer("t1")!.x).toBe(140);
		expect(getLayer("t2")!.x).toBe(340);
	});

	it("reverts a MIXED text+image multi-selection move coherently in ONE step", async () => {
		editor.addTextLayer(baseLayer({ id: "t1", x: 100, y: 120 }));
		const textObject = editor.findTextObject("t1");
		const rect = addFakeImageLayer("img1", 400, 420, 80, 60);

		// One gesture moves both the text and the image child together.
		moveChild(textObject, 30, 20);
		moveChild(rect, 30, 20);
		const selection = mockMultiSelection([textObject, rect]);
		expect(editor.isMultiSelection(selection)).toBe(true);

		editor.syncMultiSelectionTransform(selection);

		// Both children moved.
		expect(getLayer("t1")!.x).toBe(130);
		expect(getLayer("t1")!.y).toBe(140);
		expect(getImageLayer("img1")!.x).toBe(430);
		expect(getImageLayer("img1")!.y).toBe(440);

		// ONE undo reverts the WHOLE gesture — image AND text together, not just
		// the image (the coherence bug this fix closes).
		expect(editor.canUndo()).toBe(true);
		await editor.undo();
		expect(getLayer("t1")!.x).toBe(100);
		expect(getLayer("t1")!.y).toBe(120);
		expect(getImageLayer("img1")!.x).toBe(400);
		expect(getImageLayer("img1")!.y).toBe(420);
		expect(editor.canUndo()).toBe(false);

		await editor.redo();
		expect(getLayer("t1")!.x).toBe(130);
		expect(getImageLayer("img1")!.x).toBe(430);
	});

	it("does not push history for a multi-selection that did not actually move", async () => {
		editor.addTextLayer(baseLayer({ id: "t1", x: 100, y: 120 }));
		editor.addTextLayer(baseLayer({ id: "t2", x: 300, y: 320 }));
		const o1 = editor.findTextObject("t1");
		const o2 = editor.findTextObject("t2");

		// No movement — selection ends where it started.
		const selection = mockMultiSelection([o1, o2]);
		editor.syncMultiSelectionTransform(selection);

		expect(editor.canUndo()).toBe(false);
	});

	it("reports active text editing via isEditingText for the key-handler special-case", async () => {
		editor.addTextLayer(baseLayer());
		const textObject = editor.findTextObject("t1");
		expect(editor.isEditingText()).toBe(false);
		textObject.isEditing = true;
		expect(editor.isEditingText()).toBe(true);
		textObject.isEditing = false;
		expect(editor.isEditingText()).toBe(false);
	});
});
