// LOCK INTEGRITY (agy a03 P1): a locked layer dragged INSIDE a multi-selection
// must NOT move or persist. Fabric transforms the whole ActiveSelection group, so a
// locked child's per-object lockMovement flags don't stop the group from carrying it
// along — `syncMultiSelectionTransform` must skip locked children so nothing is
// serialized / persisted / pushed to history for them.
//
// `syncMultiSelectionTransform` is private and depends on fabric only via injectable
// collaborators, so we exercise it on a prototype instance with the few methods it
// touches stubbed. The lock guard runs BEFORE any geometry work, so a skipped child
// never reaches `syncTextObjectData` / `syncImageObjectData` / history.

import { describe, it, expect, vi } from "vitest";
import { MangaEditor } from "$lib/canvas/editor.ts";
import type { ImageLayer, TextLayer } from "$lib/types.js";

function textChild(data: Partial<TextLayer> & { id: string }) {
	return { _textLayerData: { index: 0, zIndex: 0, ...data } as TextLayer };
}
function imageChild(data: Partial<ImageLayer> & { id: string }) {
	return { _imageLayerData: { index: 0, ...data } as ImageLayer };
}

/**
 * A prototype-backed editor with `syncMultiSelectionTransform`'s collaborators stubbed.
 * Returns the instance plus spies recording which child each sync touched.
 */
function makeHarness(children: any[]) {
	const editor = Object.create(MangaEditor.prototype) as any;
	const syncedText: string[] = [];
	const syncedImage: string[] = [];

	editor.getSelectionChildren = () => children;
	// Run fn() directly so the REAL lock-guard (which runs before this) is what gates.
	editor.withAbsoluteChildGeometry = (_child: any, fn: () => unknown) => fn();
	editor.syncTextObjectData = (child: any) => {
		syncedText.push(child._textLayerData.id);
		return child._textLayerData as TextLayer;
	};
	editor.syncImageObjectData = (child: any) => {
		syncedImage.push(child._imageLayerData.id);
		return child._imageLayerData as ImageLayer;
	};
	editor.cloneImageLayerForHistory = (l: ImageLayer) => ({ ...l });
	editor.isTextLayerHistoryEqual = () => false;
	editor.isImageLayerHistoryEqual = () => false;
	editor.emitTextLayersChange = vi.fn();
	editor.emitImageLayersChange = vi.fn();
	editor.onHistoryChange = vi.fn();
	editor.history = { executeCommand: vi.fn() };

	return { editor, syncedText, syncedImage };
}

describe("syncMultiSelectionTransform — honors per-child lock", () => {
	it("skips a LOCKED text child (no serialize, no history) but processes unlocked ones", () => {
		const children = [
			textChild({ id: "unlocked", locked: false }),
			textChild({ id: "locked", locked: true }),
		];
		const { editor, syncedText } = makeHarness(children);

		editor.syncMultiSelectionTransform({});

		expect(syncedText).toContain("unlocked");
		expect(syncedText).not.toContain("locked");
		// Exactly one (unlocked) layer changed → a single command was executed.
		expect(editor.history.executeCommand).toHaveBeenCalledTimes(1);
	});

	it("skips a LOCKED image child", () => {
		const children = [
			imageChild({ id: "img-unlocked", locked: false }),
			imageChild({ id: "img-locked", locked: true }),
		];
		const { editor, syncedImage } = makeHarness(children);

		editor.syncMultiSelectionTransform({});

		expect(syncedImage).toContain("img-unlocked");
		expect(syncedImage).not.toContain("img-locked");
	});

	it("when EVERY child is locked, nothing is serialized or persisted", () => {
		const children = [
			textChild({ id: "t-locked", locked: true }),
			imageChild({ id: "i-locked", locked: true }),
		];
		const { editor, syncedText, syncedImage } = makeHarness(children);

		editor.syncMultiSelectionTransform({});

		expect(syncedText).toHaveLength(0);
		expect(syncedImage).toHaveLength(0);
		expect(editor.emitTextLayersChange).not.toHaveBeenCalled();
		expect(editor.emitImageLayersChange).not.toHaveBeenCalled();
		expect(editor.history.executeCommand).not.toHaveBeenCalled();
	});

	it("a mixed unlocked text + image multi-select still persists the unlocked layers", () => {
		const children = [
			textChild({ id: "t", locked: false }),
			imageChild({ id: "i", locked: false }),
		];
		const { editor, syncedText, syncedImage } = makeHarness(children);

		editor.syncMultiSelectionTransform({});

		expect(syncedText).toEqual(["t"]);
		expect(syncedImage).toEqual(["i"]);
		// >1 changed layer collapses into one composite history step.
		expect(editor.history.executeCommand).toHaveBeenCalledTimes(1);
	});
});
