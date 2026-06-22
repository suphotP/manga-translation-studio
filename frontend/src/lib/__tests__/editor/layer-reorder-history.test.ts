import { describe, expect, it, vi } from "vitest";
import {
	MangaEditor,
	__test_HistoryManager as HistoryManager,
} from "$lib/canvas/editor.ts";
import type { ImageLayer, TextLayer } from "$lib/types.ts";

vi.mock("$lib/config.js", () => ({
	config: {
		defaultFontFamily: "Tahoma, sans-serif",
		defaultFontSize: 24,
		defaultText: "ข้อความ",
		canvas: { minZoom: 0.1, maxZoom: 5 },
	},
}));

type StackEntry = { kind: "text" | "image"; id: string };

function layerFor(entry: StackEntry): TextLayer | ImageLayer {
	if (entry.kind === "text") {
		return { id: entry.id, text: entry.id } as TextLayer;
	}
	return { id: entry.id, imageId: entry.id, imageName: entry.id } as ImageLayer;
}

function makeStackReorderEditor(initialOrder: StackEntry[]) {
	const editor = Object.create(MangaEditor.prototype) as any;
	let order = initialOrder.map((entry) => ({ ...entry }));

	editor.history = new HistoryManager();
	editor.onHistoryChange = vi.fn();
	editor.getLayerStackOrder = vi.fn(() => order.map((entry) => ({ ...entry })));
	editor.moveLayerInStack = vi.fn((kind: StackEntry["kind"], id: string, direction: -1 | 1) => {
		const currentIndex = order.findIndex((entry) => entry.kind === kind && entry.id === id);
		if (currentIndex < 0) return null;
		const nextIndex = currentIndex + direction;
		if (nextIndex < 0 || nextIndex >= order.length) return layerFor(order[currentIndex]);

		const [entry] = order.splice(currentIndex, 1);
		order.splice(nextIndex, 0, entry);
		return layerFor(entry);
	});
	editor.setLayerStackOrderInternal = vi.fn((nextOrder: StackEntry[], activeKind: StackEntry["kind"], activeLayerId: string) => {
		order = nextOrder.map((entry) => ({ ...entry }));
		return layerFor({ kind: activeKind, id: activeLayerId });
	});

	return {
		editor,
		orderKeys: () => order.map((entry) => `${entry.kind}:${entry.id}`),
	};
}

describe("mixed layer drag reorder history", () => {
	it("records a three-position reorder as one undo history entry", async () => {
		const initialOrder: StackEntry[] = [
			{ kind: "image", id: "i-lo" },
			{ kind: "text", id: "t-mid" },
			{ kind: "image", id: "i-hi" },
			{ kind: "text", id: "t-top" },
		];
		const { editor, orderKeys } = makeStackReorderEditor(initialOrder);

		const moved = editor.moveLayerInStackByOffsetWithHistory("image", "i-lo", 3);

		expect(moved?.id).toBe("i-lo");
		expect(orderKeys()).toEqual(["text:t-mid", "image:i-hi", "text:t-top", "image:i-lo"]);
		expect(editor.history.undoStack).toHaveLength(1);
		expect(editor.onHistoryChange).toHaveBeenCalledTimes(1);

		const undoCommand = editor.history.undo();
		await undoCommand?.undo();

		expect(orderKeys()).toEqual(["image:i-lo", "text:t-mid", "image:i-hi", "text:t-top"]);
		expect(editor.history.canUndo()).toBe(false);
		expect(editor.history.canRedo()).toBe(true);

		const redoCommand = editor.history.redo();
		await redoCommand?.execute();

		expect(orderKeys()).toEqual(["text:t-mid", "image:i-hi", "text:t-top", "image:i-lo"]);
		expect(editor.history.undoStack).toHaveLength(1);
	});
});
