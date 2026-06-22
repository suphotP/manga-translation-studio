// Phase B — undo/redo of a non-destructive edit layer (patch / healing / clone).
//
// A destructive heal/clone stroke now appends ONE tiny `ImageEditLayer` instead of
// swapping a full background bitmap. `ImageEditLayerCommand` makes that reversible:
// undo() REMOVES the layer (the composite repaints without it), redo() re-adds it. The
// layer's small assets (realized patch + mask) are pinned via imageRefs() so the GC
// can't reclaim them while the stroke can still be undone. We drive the command against
// a minimal editor stub + the real HistoryManager, asserting:
//   1) one stroke = one history command (one undo step);
//   2) undo removes the layer, redo re-adds it (round-trips);
//   3) imageRefs() reports the layer's realized patch + mask asset ids.

import { describe, it, expect, vi } from "vitest";
import {
	__test_HistoryManager as HistoryManager,
	__test_ImageEditLayerCommand as ImageEditLayerCommand,
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

function makeHealingLayer(): ImageEditLayer {
	return {
		id: "edit-heal-1",
		kind: "healing",
		target: "page-background",
		visible: true,
		opacity: 1,
		sourceImageId: "page-1",
		bbox: { x: 10, y: 10, w: 8, h: 8 },
		payload: {
			type: "healing",
			maskAssetId: "mask-asset-1",
			realizedPatchAssetId: "heal-asset-1",
			patchEncoding: "png-rgba",
			algorithm: "telea",
			algorithmVersion: "telea-1",
		},
		index: 0,
		tool: { id: "healing-brush" },
		createdAt: "2026-06-06T00:00:00.000Z",
	};
}

/** Minimal editor stub recording add/remove + url resolution for imageRefs(). */
function makeEditorStub() {
	const stack: ImageEditLayer[] = [];
	const editor: any = {
		stack,
		addImageEditLayerForHistory: vi.fn(async (layer: ImageEditLayer) => {
			if (!stack.some((l) => l.id === layer.id)) stack.push(layer);
		}),
		removeImageEditLayerForHistory: vi.fn(async (id: string) => {
			const i = stack.findIndex((l) => l.id === id);
			if (i >= 0) stack.splice(i, 1);
		}),
		resolveProjectImageUrl: (id: string) => `https://test.local/${id}`,
	};
	return editor;
}

describe("Phase B — ImageEditLayerCommand undo/redo", () => {
	it("is ONE command per stroke; undo removes the layer, redo re-adds it", async () => {
		const editor = makeEditorStub();
		const layer = makeHealingLayer();
		// The stroke already appended the layer when committed; the command is registered
		// (not executed) — exactly one undo step for the whole gesture.
		editor.stack.push(layer);
		const history = new HistoryManager();
		history.executeCommand(new ImageEditLayerCommand(editor as any, layer));

		expect(history.canUndo()).toBe(true);
		expect(editor.stack.map((l: ImageEditLayer) => l.id)).toEqual(["edit-heal-1"]);

		// UNDO — the layer is removed (its healed pixels vanish from the composite).
		const undone = history.undo();
		await undone!.undo();
		expect(editor.stack).toHaveLength(0);
		expect(history.canRedo()).toBe(true);

		// REDO — the layer is re-added (the heal reappears).
		const redone = history.redo();
		await redone!.execute();
		expect(editor.stack.map((l: ImageEditLayer) => l.id)).toEqual(["edit-heal-1"]);
	});

	it("imageRefs() pins the realized patch + mask asset ids (id + resolved url)", () => {
		const editor = makeEditorStub();
		const layer = makeHealingLayer();
		const cmd = new ImageEditLayerCommand(editor as any, layer);
		const refs = cmd.imageRefs();
		// Both asset ids are referenced (so the GC won't reclaim them while undoable).
		expect(refs).toContain("heal-asset-1");
		expect(refs).toContain("mask-asset-1");
		// And their resolved URLs (the form the store's live-history GC check matches).
		expect(refs).toContain("https://test.local/heal-asset-1");
		expect(refs).toContain("https://test.local/mask-asset-1");
	});

	it("a patch layer pins its patchAssetId", () => {
		const editor = makeEditorStub();
		const layer: ImageEditLayer = {
			...makeHealingLayer(),
			id: "edit-patch-1",
			kind: "patch",
			payload: { type: "patch", patchAssetId: "patch-asset-9", patchEncoding: "png-rgba" },
		};
		const cmd = new ImageEditLayerCommand(editor as any, layer);
		expect(cmd.imageRefs()).toContain("patch-asset-9");
	});
});
