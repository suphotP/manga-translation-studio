// Phase C — edit-stack controls: per-edit visibility toggle, delete, and "revert to
// before this edit" (drop it + everything stacked after). Drives the REAL MangaEditor
// host methods against a stack of ImageEditLayers and asserts:
//   - visibility toggle is undoable + recomposites + notifies the store (persist),
//   - delete removes ONE edit (undoable),
//   - revert removes the target edit AND every later edit in one undoable step,
//   - undo restores the removed edits (indices renormalized).
// rebuildEditComposite is stubbed (asserted via call count) — this test is about the
// STACK mutations + history wiring, not the pixel composite (covered by phase A/B tests).

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

function makeLayer(id: string, index: number, kind: ImageEditLayer["kind"] = "bubble-clean"): ImageEditLayer {
	return {
		id,
		kind,
		target: "page-background",
		visible: true,
		opacity: 1,
		sourceImageId: "page-1",
		bbox: { x: 0, y: 0, w: 10, h: 10 },
		payload: { type: "fill-mask", maskAssetId: `${id}-mask`, maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } },
		index,
		tool: { id: "bubble-clean" },
		createdAt: "2026-06-06T00:00:00.000Z",
	};
}

function makeEditor(layers: ImageEditLayer[]) {
	const editor = Object.create(MangaEditor.prototype) as any;
	editor.imageWidth = 64;
	editor.imageHeight = 64;
	editor.imageItem = { dirty: false };
	editor.canvas = { requestRenderAll: vi.fn() };
	editor.imageEditLayers = layers.map((l) => ({ ...l }));
	editor.editLayersSourceImageId = "page-1";
	editor.history = new HistoryManager();
	editor.rebuildEditComposite = vi.fn(async () => {});
	editor.onHistoryChange = vi.fn();
	editor.onImageEditLayersChange = vi.fn();
	editor.resolveProjectImageUrl = (id: string) => `https://test.local/${id}`;
	return editor;
}

describe("Phase C — edit-stack visibility toggle", () => {
	it("toggles visibility, recomposites, persists, and is undoable", async () => {
		const editor = makeEditor([makeLayer("a", 0), makeLayer("b", 1)]);

		const ok = editor.toggleImageEditLayerVisibility("b");
		expect(ok).toBe(true);
		// Layer b hidden in the live stack.
		expect(editor.imageEditLayers.find((l: ImageEditLayer) => l.id === "b").visible).toBe(false);
		// Recomposited + persisted (store notified with the new stack).
		expect(editor.rebuildEditComposite).toHaveBeenCalled();
		expect(editor.onImageEditLayersChange).toHaveBeenCalled();

		// Undo restores visibility.
		expect(editor.canUndo()).toBe(true);
		await editor.undo();
		expect(editor.imageEditLayers.find((l: ImageEditLayer) => l.id === "b").visible).toBe(true);

		// Redo hides it again.
		await editor.redo();
		expect(editor.imageEditLayers.find((l: ImageEditLayer) => l.id === "b").visible).toBe(false);
	});

	it("no-op when toggling to the current state", () => {
		const editor = makeEditor([makeLayer("a", 0)]);
		// Already visible → explicit visible=true is a no-op (no history push).
		const ok = editor.toggleImageEditLayerVisibility("a", true);
		expect(ok).toBe(false);
		expect(editor.canUndo()).toBe(false);
	});
});

describe("Phase C — delete one edit layer", () => {
	it("removes the target edit, keeps later edits, and is undoable", async () => {
		const editor = makeEditor([makeLayer("a", 0), makeLayer("b", 1), makeLayer("c", 2)]);

		const ok = editor.deleteImageEditLayer("b");
		expect(ok).toBe(true);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "c"]);

		await editor.undo();
		// ORDER-SENSITIVE: undo must restore the EXACT pre-delete stack (ids AND array order),
		// not just the same SET of ids. Do NOT sort before asserting.
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "b", "c"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1, 2]);
	});

	// P1-1 (codex): undo-after-delete must restore the EXACT original paint order. Both the
	// live compositor and export sort layers by `index`, so a wrong restore (a0,c1,b2 instead
	// of a0,b1,c2) silently changes rendered/exported bytes. Assert the id sequence AND the
	// indices IN ORDER — never sort before asserting.
	it("delete b → undo restores EXACTLY a0,b1,c2 (order + indices, not just the set)", async () => {
		const editor = makeEditor([makeLayer("a", 0), makeLayer("b", 1), makeLayer("c", 2)]);

		expect(editor.deleteImageEditLayer("b")).toBe(true);
		// After delete the survivors normalize to a0,c1.
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "c"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1]);

		await editor.undo();
		// The stack (ids, array order AND indices) must equal the pre-delete stack EXACTLY.
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "b", "c"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1, 2]);

		// Redo deletes b again (and renormalizes survivors) — round-trip stays correct.
		await editor.redo();
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "c"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1]);
	});
});

describe("Phase C — revert to before this edit", () => {
	it("removes the target edit AND everything stacked after it in one step", async () => {
		const editor = makeEditor([makeLayer("a", 0), makeLayer("b", 1), makeLayer("c", 2), makeLayer("d", 3)]);

		// Revert to before "b" → drops b, c, d; keeps a.
		const ok = editor.revertToBeforeImageEditLayer("b");
		expect(ok).toBe(true);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a"]);
		expect(editor.rebuildEditComposite).toHaveBeenCalled();
		expect(editor.onImageEditLayersChange).toHaveBeenCalled();

		// One undoable step restores all three removed edits in the EXACT original order.
		expect(editor.canUndo()).toBe(true);
		await editor.undo();
		// ORDER-SENSITIVE: assert the id sequence + indices IN ARRAY ORDER (do NOT sort first).
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "b", "c", "d"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1, 2, 3]);
	});

	// P1-1 (codex): revert→undo on a stack whose middle edit was previously deleted must still
	// restore the EXACT pre-revert order. delete b (a0,c1) → add d (a0,c1,d2) → revert-to-c
	// (drops c,d → a0) → undo must restore EXACTLY a0,c1,d2 (not a0,d1,c2). Order-sensitive.
	it("delete b → add d → revert c → undo restores EXACTLY a0,c1,d2 (order + indices)", async () => {
		const editor = makeEditor([makeLayer("a", 0), makeLayer("b", 1), makeLayer("c", 2)]);
		expect(editor.deleteImageEditLayer("b")).toBe(true);
		const d = makeLayer("d", editor.imageEditLayers.length);
		await editor.addImageEditLayerForHistory(d);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "c", "d"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1, 2]);

		// Revert to before c → drops c and d; keeps a.
		expect(editor.revertToBeforeImageEditLayer("c")).toBe(true);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a"]);

		await editor.undo();
		// Must equal the pre-revert stack EXACTLY (ids, array order AND indices).
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "c", "d"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1, 2]);
	});

	it("reverting the FIRST edit clears the whole stack", () => {
		const editor = makeEditor([makeLayer("a", 0), makeLayer("b", 1)]);
		editor.revertToBeforeImageEditLayer("a");
		expect(editor.imageEditLayers).toHaveLength(0);
	});

	it("revert is a no-op for an unknown edit id", () => {
		const editor = makeEditor([makeLayer("a", 0)]);
		const ok = editor.revertToBeforeImageEditLayer("nope");
		expect(ok).toBe(false);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a"]);
	});

	// P1-1 regression (codex): a0,b1,c2 → delete b → add d → revert-to-before d must remove
	// ONLY d and keep c. Before the positional-normalize fix, delete left c at index 2, the
	// appended d also took index 2 (stack COUNT), and reverting d (index>=2) wrongly removed
	// BOTH c and d.
	it("delete b → add d → revert d removes only d (keeps c) — no index collision", async () => {
		const editor = makeEditor([makeLayer("a", 0), makeLayer("b", 1), makeLayer("c", 2)]);

		// Delete b → survivors must be reindexed contiguously (a→0, c→1).
		expect(editor.deleteImageEditLayer("b")).toBe(true);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "c"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1]);

		// Add d the way the store does: index == current stack count (==2, the next slot).
		const d = makeLayer("d", editor.imageEditLayers.length);
		await editor.addImageEditLayerForHistory(d);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "c", "d"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1, 2]);

		// Revert-to-before d → drops ONLY d; c survives (this is the bug the fix closes).
		expect(editor.revertToBeforeImageEditLayer("d")).toBe(true);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.id)).toEqual(["a", "c"]);
		expect(editor.imageEditLayers.map((l: ImageEditLayer) => l.index)).toEqual([0, 1]);
	});
});

describe("Phase C — rename one edit layer", () => {
	it("sets the name and persists (not undoable)", () => {
		const editor = makeEditor([makeLayer("a", 0)]);
		const ok = editor.renameImageEditLayer("a", "  ลบบับเบิลซ้ายบน  ");
		expect(ok).toBe(true);
		expect(editor.imageEditLayers[0].name).toBe("ลบบับเบิลซ้ายบน");
		expect(editor.onImageEditLayersChange).toHaveBeenCalled();
		// Rename is metadata-only — no history step.
		expect(editor.canUndo()).toBe(false);
	});
});
