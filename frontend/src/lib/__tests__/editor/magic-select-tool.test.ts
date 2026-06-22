import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import {
	buildMagicCleanMask,
	createMagicSelectTool,
	expandBinaryMask,
	type MagicSelectOptions,
} from "$lib/editor/tools/magic-select-tool.ts";
import { readSourceImageData, type PixelRegion } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

const SIZE = 48;
const BUBBLE = { x: 10, y: 10, size: 28 };
const INTERIOR = { x: 14, y: 14, size: 20 };
const GLYPH = { x: 22, y: 22 };
const CLICK = { x: 16, y: 16 };

interface PatchCall {
	kind: "patch" | "healing" | "clone";
	patch: ImageData;
	mask?: Uint8ClampedArray;
	region: PixelRegion;
	tool: { id: string; params?: Record<string, unknown> };
	algorithm?: string;
	algorithmVersion?: string;
}

function setPixel(data: Uint8ClampedArray, width: number, x: number, y: number, rgba: readonly [number, number, number, number?]): void {
	const offset = (y * width + x) * 4;
	data[offset] = rgba[0];
	data[offset + 1] = rgba[1];
	data[offset + 2] = rgba[2];
	data[offset + 3] = rgba[3] ?? 255;
}

function makeBubbleCanvas(): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = SIZE;
	canvas.height = SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) return canvas;
	const data = new Uint8ClampedArray(SIZE * SIZE * 4);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) setPixel(data, SIZE, x, y, [36, 36, 36, 255]);
	}
	for (let y = BUBBLE.y; y < BUBBLE.y + BUBBLE.size; y++) {
		for (let x = BUBBLE.x; x < BUBBLE.x + BUBBLE.size; x++) setPixel(data, SIZE, x, y, [0, 0, 0, 255]);
	}
	for (let y = INTERIOR.y; y < INTERIOR.y + INTERIOR.size; y++) {
		for (let x = INTERIOR.x; x < INTERIOR.x + INTERIOR.size; x++) setPixel(data, SIZE, x, y, [255, 255, 255, 255]);
	}
	for (let y = GLYPH.y; y < GLYPH.y + 4; y++) {
		for (let x = GLYPH.x; x < GLYPH.x + 4; x++) setPixel(data, SIZE, x, y, [0, 0, 0, 255]);
	}
	ctx.putImageData(new ImageData(data, SIZE, SIZE), 0, 0);
	return canvas;
}

function pixel(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
	const data = canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
	return [data[0], data[1], data[2], data[3]];
}

function makePatchHost(
	source: HTMLCanvasElement,
	options: {
		commitResult?: boolean;
		staleOnPreview?: boolean;
		sourceElement?: CanvasImageSource | null;
	} = {},
): {
	host: EditorToolHost;
	backing: HTMLCanvasElement;
	commitImageEditLayerPatch: ReturnType<typeof vi.fn>;
	commitToolBackground: ReturnType<typeof vi.fn>;
	applyToolPatchInstant: ReturnType<typeof vi.fn>;
	calls: PatchCall[];
} {
	const backing = document.createElement("canvas");
	backing.width = source.width;
	backing.height = source.height;
	const bctx = backing.getContext("2d")!;
	const sctx = source.getContext("2d")!;
	bctx.putImageData(sctx.getImageData(0, 0, source.width, source.height), 0, 0);

	const calls: PatchCall[] = [];
	const commitImageEditLayerPatch = vi.fn(async (input: PatchCall) => {
		calls.push(input);
		return options.commitResult ?? true;
	});
	const commitToolBackground = vi.fn();
	let epoch = 11;
	const applyToolPatchInstant = vi.fn((patch: ImageData, region: PixelRegion) => {
		if (options.staleOnPreview) {
			epoch++;
			return false;
		}
		bctx.putImageData(patch, Math.round(region.x), Math.round(region.y));
		return true;
	});

	const host: EditorToolHost = {
		getImageEpoch: () => epoch,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: options.sourceElement === undefined ? backing : options.sourceElement,
		}),
		applyToolPatchInstant,
		commitImageEditLayerPatch,
		setToolBusy: vi.fn(),
	};
	return { host, backing, commitImageEditLayerPatch, commitToolBackground, applyToolPatchInstant, calls };
}

async function runTool(host: EditorToolHost, options: Partial<MagicSelectOptions> = {}, point = CLICK): Promise<void> {
	const registry = new ToolRegistry();
	registry.register(createMagicSelectTool(options));
	registry.setHost(host);
	registry.activate("magic-clean");
	registry.handlePointerDown({ scene: point });
	registry.handlePointerUp({ scene: point });
	await registry.waitForCommit();
}

describe("Magic Clean core helpers", () => {
	it("fills wand holes and expands the mask by the requested pixel radius", () => {
		const source = makeBubbleCanvas();
		const image = readSourceImageData(source, source.width, source.height);
		if (!image) return;

		const tight = buildMagicCleanMask(image, CLICK.x, CLICK.y, { tolerance: 0, expandPx: 0 });
		const expanded = buildMagicCleanMask(image, CLICK.x, CLICK.y, { tolerance: 0, expandPx: 2 });

		expect(tight[GLYPH.y * SIZE + GLYPH.x]).toBe(255);
		expect(tight[(INTERIOR.y - 1) * SIZE + INTERIOR.x]).toBe(0);
		expect(expanded[(INTERIOR.y - 1) * SIZE + INTERIOR.x]).toBe(255);
		expect(expanded[0]).toBe(0);
	});

	it("dilates at image edges without overflowing the mask buffer", () => {
		const mask = new Uint8Array(4 * 4);
		mask[0] = 255;

		const expanded = expandBinaryMask(mask, 4, 4, 2);

		expect(expanded).toHaveLength(16);
		expect(expanded[0]).toBe(255);
		expect(expanded[2]).toBe(255);
		expect(expanded[8]).toBe(255);
		expect(expanded[15]).toBe(0);
	});
});

describe("Magic Clean tool", () => {
	it("applies a one-click bubble clean as a realized healing patch with magic-clean metadata", async () => {
		const source = makeBubbleCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, backing, commitImageEditLayerPatch, commitToolBackground, calls } = makePatchHost(source);

		await runTool(host);

		expect(commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		expect(commitToolBackground).not.toHaveBeenCalled();
		expect(pixel(backing, GLYPH.x, GLYPH.y)).toEqual([255, 255, 255, 255]);
		expect(pixel(backing, 2, 2)).toEqual([36, 36, 36, 255]);

		const call = calls[0];
		expect(call.kind).toBe("healing");
		expect(call.tool.id).toBe("background-edit");
		expect(call.tool.params).toMatchObject({
			toolId: "magic-clean",
			tolerance: 24,
			expandPx: 2,
			selection: "magic-wand-fill-holes",
		});
		expect(call.patch.width).toBe(call.region.width);
		expect(call.patch.height).toBe(call.region.height);
		expect(call.region.width * call.region.height).toBeLessThan(SIZE * SIZE);
		expect(call.mask).toBeInstanceOf(Uint8ClampedArray);
		expect(call.mask?.[GLYPH.y * SIZE + GLYPH.x]).toBe(255);
	});

	it("respects custom fillColor and expandPx options", async () => {
		const source = makeBubbleCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, backing, calls } = makePatchHost(source);

		await runTool(host, { fillColor: "#e8ddcc", expandPx: 0, tolerance: 0 });

		expect(pixel(backing, GLYPH.x, GLYPH.y)).toEqual([232, 221, 204, 255]);
		expect(pixel(backing, INTERIOR.x - 1, INTERIOR.y)).toEqual([0, 0, 0, 255]);
		expect(calls[0].tool.params?.fillColor).toEqual({ r: 232, g: 221, b: 204, a: 255 });
		expect(calls[0].tool.params?.expandPx).toBe(0);
	});

	it("reverts the instant preview when the edit-layer patch commit fails", async () => {
		const source = makeBubbleCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, backing, commitImageEditLayerPatch, applyToolPatchInstant } = makePatchHost(source, {
			commitResult: false,
		});
		const originalGlyph = pixel(backing, GLYPH.x, GLYPH.y);

		await runTool(host);

		expect(commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		expect(applyToolPatchInstant).toHaveBeenCalledTimes(2);
		expect(pixel(backing, GLYPH.x, GLYPH.y)).toEqual(originalGlyph);
	});

	it("drops a stale epoch preview without committing or falling back", async () => {
		const source = makeBubbleCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, commitImageEditLayerPatch, commitToolBackground } = makePatchHost(source, {
			staleOnPreview: true,
		});

		await runTool(host);

		expect(commitImageEditLayerPatch).not.toHaveBeenCalled();
		expect(commitToolBackground).not.toHaveBeenCalled();
	});

	it("does nothing when there is no readable source image or the click is outside the page", async () => {
		const source = makeBubbleCanvas();
		const noSource = makePatchHost(source, { sourceElement: null });
		await runTool(noSource.host);
		expect(noSource.commitImageEditLayerPatch).not.toHaveBeenCalled();

		const outside = makePatchHost(source);
		await runTool(outside.host, {}, { x: -10, y: 99 });
		expect(outside.commitImageEditLayerPatch).not.toHaveBeenCalled();
	});
});
