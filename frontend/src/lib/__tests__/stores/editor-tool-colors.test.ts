import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorStore } from "$lib/stores/editor.svelte.ts";

beforeEach(() => {
	editorStore.editor = null;
	editorStore.brushColor = "#FFFFFF";
	editorStore.imageToolFillColor = "#FFFFFF";
	editorStore.recentToolColors = ["#FFFFFF", "#111111"];
	(editorStore as unknown as { imageEditSuite: unknown }).imageEditSuite = null;
});

describe("editorStore tool colors", () => {
	it("syncs brush color into the canvas brush option and recent colors", () => {
		const setBrushColor = vi.fn();
		editorStore.editor = { setBrushColor } as any;

		editorStore.setBrushColor("0f8");

		expect(editorStore.brushColor).toBe("#00FF88");
		expect(setBrushColor).toHaveBeenCalledWith("#00FF88");
		expect(editorStore.recentToolColors[0]).toBe("#00FF88");
	});

	it("syncs fill color into bucket-fill and magic-clean tool options", () => {
		const setFillColor = vi.fn();
		const suite = {
			tools: {
				bucketFill: { setFillColor },
				magicClean: { options: { fillColor: "#FFFFFF" } },
			},
		};
		(editorStore as unknown as { imageEditSuite: unknown }).imageEditSuite = suite;

		editorStore.setImageToolFillColor("#123abc");

		expect(editorStore.imageToolFillColor).toBe("#123ABC");
		expect(setFillColor).toHaveBeenCalledWith([18, 58, 188, 255]);
		expect(suite.tools.magicClean.options.fillColor).toBe("#123ABC");
		expect(editorStore.recentToolColors[0]).toBe("#123ABC");
	});
});
