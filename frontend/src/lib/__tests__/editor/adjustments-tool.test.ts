import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import {
	ADJUSTMENTS_TOOL_ID,
	createAdjustmentsTool,
	type AdjustmentsToolOptions,
	type PartialAdjustmentsToolOptions,
} from "$lib/editor/tools/adjustments-tool.ts";
import AdjustmentsPanel from "$lib/components/editor-ui/AdjustmentsPanel.svelte";
import { MaskBuffer } from "$lib/editor/tools/mask-buffer.ts";
import { makeImageData, readSourceImageData, readSourceImageRegion, type PixelRegion } from "$lib/editor/tools/raster.ts";
import { buildToolContext, type EditorToolHost } from "$lib/editor/tools/types.ts";
import {
	BUILTIN_TOOLS,
	isImageEditToolId,
	toolRegistry,
} from "$lib/editor/tool-registry.svelte.ts";

interface ApplyCall {
	patch: ImageData;
	region: PixelRegion;
	expectedEpoch?: number;
	options?: { preview?: boolean; skipSnapshot?: boolean };
}

interface PatchCommitCall {
	kind: "patch" | "healing" | "clone";
	patch: ImageData;
	region: PixelRegion;
	tool: { id: string; params?: Record<string, unknown> };
}

function rgba(values: number[]): Uint8ClampedArray {
	return new Uint8ClampedArray(values);
}

function makeSourceCanvas(width: number, height: number, values: number[]): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (ctx) ctx.putImageData(makeImageData(rgba(values), width, height), 0, 0);
	return canvas;
}

function pixel(image: ImageData, index: number): number[] {
	const offset = index * 4;
	return Array.from(image.data.slice(offset, offset + 4));
}

function makeHarness(input: {
	width: number;
	height: number;
	pixels: number[];
	mask?: number[];
	commitResult?: boolean;
	applySucceeds?: boolean;
	epoch?: () => number | undefined;
	compositedPixels?: number[];
	compositeReadSucceeds?: boolean;
}) {
	const source = makeSourceCanvas(input.width, input.height, input.pixels);
	if (!readSourceImageData(source, input.width, input.height)) {
		throw new Error("canvas raster backend is required for adjustments-tool tests");
	}

	const backing = makeSourceCanvas(input.width, input.height, input.pixels);
	const composited = input.compositedPixels
		? makeSourceCanvas(input.width, input.height, input.compositedPixels)
		: null;
	const backingCtx = backing.getContext("2d")!;
	const mask = new MaskBuffer();
	mask.resize(input.width, input.height);
	if (input.mask) mask.setData(rgba(input.mask));

	const applyCalls: ApplyCall[] = [];
	const patchCommits: PatchCommitCall[] = [];
	const commitImageEditLayerPatch = vi.fn(async (call: PatchCommitCall) => {
		patchCommits.push(call);
		return input.commitResult ?? true;
	});
	const commitToolBackground = vi.fn();
	const trackInstantToolCommit = vi.fn();
	const setToolBusy = vi.fn();
	const readCompositedImageRegion = vi.fn((region: PixelRegion) => {
		if (!composited || input.compositeReadSucceeds === false) return null;
		return readSourceImageRegion(composited, region, input.width, input.height);
	});
	const epoch = input.epoch ?? (() => 7);

	const host: EditorToolHost = {
		getImageEpoch: epoch,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: input.width, height: input.height },
			imageWidth: input.width,
			imageHeight: input.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: backing,
		}),
		applyToolPatchInstant: (
			patch: ImageData,
			region: PixelRegion,
			expectedEpoch?: number,
			options?: { preview?: boolean; skipSnapshot?: boolean },
		) => {
			applyCalls.push({ patch, region, expectedEpoch, options });
			if (input.applySucceeds === false) return false;
			if (expectedEpoch !== undefined && expectedEpoch !== epoch()) return false;
			backingCtx.putImageData(patch, Math.round(region.x), Math.round(region.y));
			return true;
		},
		commitImageEditLayerPatch,
		trackInstantToolCommit,
		setToolBusy,
	};
	if (composited) {
		host.readCompositedImageRegion = readCompositedImageRegion;
	}
	const imageContext = host.getImageSpaceContext();
	if (!imageContext) throw new Error("missing image context");
	const ctx = buildToolContext(host, mask, imageContext);
	return {
		ctx,
		host,
		backing,
		applyCalls,
		patchCommits,
		commitImageEditLayerPatch,
		commitToolBackground,
		trackInstantToolCommit,
		setToolBusy,
		readCompositedImageRegion,
	};
}

const SELECTED_EDGES = [255, 0, 255];
const THREE_PIXELS = [
	10, 20, 30, 255,
	100, 110, 120, 255,
	200, 210, 220, 255,
];
const PANEL_OPTIONS: AdjustmentsToolOptions = {
	brightness: 0,
	contrast: 0,
	levels: {
		inBlack: 0,
		inWhite: 255,
		gamma: 1,
		outBlack: 0,
		outWhite: 255,
	},
	hsl: {
		hue: 0,
		saturation: 0,
		lightness: 0,
	},
};

function panelOptions(overrides: PartialAdjustmentsToolOptions = {}): AdjustmentsToolOptions {
	return {
		brightness: overrides.brightness ?? PANEL_OPTIONS.brightness,
		contrast: overrides.contrast ?? PANEL_OPTIONS.contrast,
		levels: {
			...PANEL_OPTIONS.levels,
			...overrides.levels,
		},
		hsl: {
			...PANEL_OPTIONS.hsl,
			...overrides.hsl,
		},
	};
}

describe("createAdjustmentsTool", () => {
	it("renders live preview through applyToolPatchInstant(preview:true) and respects the active selection", () => {
		const harness = makeHarness({
			width: 3,
			height: 1,
			pixels: THREE_PIXELS,
			mask: SELECTED_EDGES,
		});
		const tool = createAdjustmentsTool();

		const applied = tool.preview(harness.ctx, { brightness: 100 });

		expect(applied).toBe(true);
		expect(harness.applyCalls).toHaveLength(1);
		const [call] = harness.applyCalls;
		expect(call.region).toEqual({ x: 0, y: 0, width: 3, height: 1 });
		expect(call.expectedEpoch).toBe(7);
		expect(call.options).toEqual({ preview: true });
		expect(pixel(call.patch, 0)).toEqual([255, 255, 255, 255]);
		expect(pixel(call.patch, 1)).toEqual([100, 110, 120, 255]);
		expect(pixel(call.patch, 2)).toEqual([255, 255, 255, 255]);
		expect(harness.commitImageEditLayerPatch).not.toHaveBeenCalled();
	});

	it("commits the adjusted ROI as a patch edit layer and keeps unselected pixels transparent", async () => {
		const harness = makeHarness({
			width: 3,
			height: 1,
			pixels: THREE_PIXELS,
			mask: SELECTED_EDGES,
		});
		const tool = createAdjustmentsTool({ brightness: 100 });

		expect(tool.preview(harness.ctx)).toBe(true);
		const committed = await tool.commit(harness.ctx);

		expect(committed).toBe(true);
		expect(harness.commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		expect(harness.commitToolBackground).not.toHaveBeenCalled();
		expect(harness.trackInstantToolCommit).toHaveBeenCalledTimes(1);
		expect(harness.setToolBusy).toHaveBeenCalledWith(true, "กำลังปรับแสงสี");
		expect(harness.setToolBusy).toHaveBeenLastCalledWith(false);

		const [commit] = harness.patchCommits;
		expect(commit.kind).toBe("patch");
		expect(commit.region).toEqual({ x: 0, y: 0, width: 3, height: 1 });
		expect(commit.tool.id).toBe("background-edit");
		expect(commit.tool.params).toMatchObject({
			toolId: ADJUSTMENTS_TOOL_ID,
			brightness: 100,
		});
		expect(pixel(commit.patch, 0)).toEqual([255, 255, 255, 255]);
		expect(pixel(commit.patch, 1)).toEqual([0, 0, 0, 0]);
		expect(pixel(commit.patch, 2)).toEqual([255, 255, 255, 255]);
	});

	it("samples composited edit-layer pixels before committing the adjustment patch", async () => {
		const harness = makeHarness({
			width: 1,
			height: 1,
			pixels: [10, 20, 30, 255],
			compositedPixels: [100, 110, 120, 255],
		});
		const tool = createAdjustmentsTool({ brightness: 20 });

		const committed = await tool.commit(harness.ctx);

		expect(committed).toBe(true);
		expect(harness.readCompositedImageRegion).toHaveBeenCalledWith({ x: 0, y: 0, width: 1, height: 1 });
		expect(harness.commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		const [commit] = harness.patchCommits;
		// Base-only sampling would produce [61, 71, 81]. The committed patch must start
		// from the already-composited edit-layer pixel so adjustments do not erase cleans.
		expect(pixel(commit.patch, 0)).toEqual([151, 161, 171, 255]);
	});

	it("does not fall back to base pixels when a composited read is temporarily unavailable", async () => {
		const harness = makeHarness({
			width: 1,
			height: 1,
			pixels: [10, 20, 30, 255],
			compositedPixels: [100, 110, 120, 255],
			compositeReadSucceeds: false,
		});
		const tool = createAdjustmentsTool({ brightness: 20 });

		const committed = await tool.commit(harness.ctx);

		expect(committed).toBe(false);
		expect(harness.commitImageEditLayerPatch).not.toHaveBeenCalled();
		expect(harness.applyCalls).toHaveLength(0);
	});

	it("reverts the transient preview when edit-layer commit fails", async () => {
		const harness = makeHarness({
			width: 3,
			height: 1,
			pixels: THREE_PIXELS,
			mask: SELECTED_EDGES,
			commitResult: false,
		});
		const tool = createAdjustmentsTool({ brightness: 100 });

		expect(tool.preview(harness.ctx)).toBe(true);
		const committed = await tool.commit(harness.ctx);

		expect(committed).toBe(false);
		expect(harness.commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		const revert = harness.applyCalls.at(-1);
		expect(revert?.options).toEqual({ preview: true, skipSnapshot: true });
		expect(revert?.region).toEqual({ x: 0, y: 0, width: 3, height: 1 });
		expect(pixel(revert!.patch, 0)).toEqual([10, 20, 30, 255]);
		expect(pixel(revert!.patch, 1)).toEqual([100, 110, 120, 255]);
		expect(pixel(revert!.patch, 2)).toEqual([200, 210, 220, 255]);
	});

	it("uses the whole page when no selection exists", () => {
		const harness = makeHarness({
			width: 2,
			height: 1,
			pixels: [
				255, 0, 0, 255,
				0, 0, 255, 255,
			],
		});
		const tool = createAdjustmentsTool();

		expect(tool.preview(harness.ctx, { hsl: { hue: 120 } })).toBe(true);

		const [call] = harness.applyCalls;
		expect(call.region).toEqual({ x: 0, y: 0, width: 2, height: 1 });
		expect(pixel(call.patch, 0)).toEqual([0, 255, 0, 255]);
		expect(pixel(call.patch, 1)).toEqual([255, 0, 0, 255]);
	});

	it("cancels an existing preview when sliders return to neutral", () => {
		const harness = makeHarness({
			width: 3,
			height: 1,
			pixels: THREE_PIXELS,
			mask: SELECTED_EDGES,
		});
		const tool = createAdjustmentsTool();

		expect(tool.preview(harness.ctx, { contrast: 40 })).toBe(true);
		const canceled = tool.setOptions(harness.ctx, { contrast: 0 });

		expect(canceled).toBe(true);
		const revert = harness.applyCalls.at(-1);
		expect(revert?.options).toEqual({ preview: true, skipSnapshot: true });
		expect(pixel(revert!.patch, 0)).toEqual([10, 20, 30, 255]);
		expect(pixel(revert!.patch, 1)).toEqual([100, 110, 120, 255]);
		expect(pixel(revert!.patch, 2)).toEqual([200, 210, 220, 255]);
	});

	it("drops stale previews through the epoch guard", () => {
		let currentEpoch = 1;
		let reads = 0;
		const harness = makeHarness({
			width: 1,
			height: 1,
			pixels: [10, 20, 30, 255],
			epoch: () => {
				reads += 1;
				return reads === 1 ? 1 : currentEpoch;
			},
		});
		const tool = createAdjustmentsTool();
		currentEpoch = 2;

		const applied = tool.preview(harness.ctx, { brightness: 100 });

		expect(applied).toBe(false);
		expect(harness.applyCalls).toHaveLength(1);
		expect(harness.applyCalls[0].expectedEpoch).toBe(1);
		expect(harness.commitImageEditLayerPatch).not.toHaveBeenCalled();
	});

	it("updates options silently when requested", () => {
		const harness = makeHarness({
			width: 1,
			height: 1,
			pixels: [10, 20, 30, 255],
		});
		const tool = createAdjustmentsTool();

		expect(tool.setOptions(harness.ctx, { brightness: 20 }, false)).toBe(true);

		expect(tool.options.brightness).toBe(20);
		expect(harness.applyCalls).toHaveLength(0);
	});
});

describe("AdjustmentsPanel", () => {
	it("routes slider changes through setOptions(false) and then preview()", async () => {
		const setOptions = vi.fn(() => true);
		const preview = vi.fn(() => true);

		render(AdjustmentsPanel, {
			props: {
				options: panelOptions(),
				canApply: true,
				setOptions,
				preview,
				commit: vi.fn(),
				cancel: vi.fn(),
			},
		});

		await fireEvent.input(screen.getByLabelText("Brightness"), { target: { value: "42" } });
		await fireEvent.input(screen.getByLabelText("Contrast"), { target: { value: "-18" } });
		await fireEvent.input(screen.getByLabelText("Saturation"), { target: { value: "33" } });

		expect(setOptions).toHaveBeenNthCalledWith(1, { brightness: 42 }, false);
		expect(setOptions).toHaveBeenNthCalledWith(2, { contrast: -18 }, false);
		expect(setOptions).toHaveBeenNthCalledWith(3, { hsl: { saturation: 33 } }, false);
		expect(preview).toHaveBeenCalledTimes(3);
	});

	it("clamps level sliders so black stays below white and gamma stays finite", async () => {
		const setOptions = vi.fn(() => true);
		const preview = vi.fn(() => true);

		render(AdjustmentsPanel, {
			props: {
				options: panelOptions({ levels: { inBlack: 100, inWhite: 120, gamma: 1 } }),
				canApply: true,
				setOptions,
				preview,
				commit: vi.fn(),
				cancel: vi.fn(),
			},
		});

		await fireEvent.input(screen.getByLabelText("Levels black point"), { target: { value: "220" } });
		await fireEvent.input(screen.getByLabelText("Levels white point"), { target: { value: "30" } });
		await fireEvent.input(screen.getByLabelText("Levels gamma"), { target: { value: "9" } });

		expect(setOptions).toHaveBeenNthCalledWith(1, { levels: { inBlack: 119 } }, false);
		expect(setOptions).toHaveBeenNthCalledWith(2, { levels: { inWhite: 101 } }, false);
		expect(setOptions).toHaveBeenNthCalledWith(3, { levels: { gamma: 3 } }, false);
		expect(preview).toHaveBeenCalledTimes(3);
	});

	it("commits, cancels, resets, and fails closed when no image context is available", async () => {
		const setOptions = vi.fn(() => true);
		const preview = vi.fn(() => true);
		const commit = vi.fn(async () => true);
		const cancel = vi.fn(() => true);

		const { rerender } = render(AdjustmentsPanel, {
			props: {
				options: panelOptions({ brightness: 10 }),
				canApply: true,
				setOptions,
				preview,
				commit,
				cancel,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
		await fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
		await fireEvent.click(screen.getByRole("button", { name: "รีเซ็ต" }));

		expect(commit).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(setOptions).toHaveBeenLastCalledWith({
			brightness: 0,
			contrast: 0,
			levels: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 },
			hsl: { hue: 0, saturation: 0, lightness: 0 },
		}, false);

		await rerender({
			options: panelOptions(),
			canApply: false,
			setOptions,
			preview,
			commit,
			cancel,
		});

		expect(screen.getByRole("status").textContent).toContain("เปิดหน้าที่มีรูปก่อนใช้ปรับแสงสี");
		expect(screen.queryByLabelText("Brightness")).toBeNull();
	});
});

describe("adjustments dock registration", () => {
	it("registers adjustments in the dock now that controls exist", () => {
		toolRegistry.__resetToBuiltins();
		const def = toolRegistry.get(ADJUSTMENTS_TOOL_ID);
		const ctx = {
			setEngineTool: vi.fn(),
			setRightPanelMode: vi.fn(),
			startTextPlacement: vi.fn(),
			activateImageTool: vi.fn(),
		};

		expect(def).toBeTruthy();
		expect(def?.label).toBe("ปรับแสงสี");
		expect(def?.optionsContext).toBe("image-tools");
		expect(BUILTIN_TOOLS.map((tool) => tool.id)).toContain(ADJUSTMENTS_TOOL_ID);
		expect(isImageEditToolId(ADJUSTMENTS_TOOL_ID)).toBe(true);
		def?.onActivate?.(ctx);
		expect(ctx.activateImageTool).toHaveBeenCalledWith(ADJUSTMENTS_TOOL_ID);
		expect(ctx.setEngineTool).not.toHaveBeenCalled();
	});
});
