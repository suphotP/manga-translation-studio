import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/editor-tools/pro-clean.js", () => ({
	proClean: vi.fn((image: { data: Uint8ClampedArray; width: number; height: number }, mask: Uint8Array, options: { strategy?: string } = {}) => {
		const data = new Uint8ClampedArray(image.data);
		for (let i = 0; i < mask.length; i++) {
			if (mask[i] === 0) continue;
			const o = i * 4;
			data[o] = 240;
			data[o + 1] = 238;
			data[o + 2] = 234;
			data[o + 3] = 255;
		}
		const strategy = options.strategy === "screentone" ? "screentone" : "flat";
		return {
			imageData: { data, width: image.width, height: image.height },
			strategy,
			backgroundStrategy: strategy,
			bounds: { x: 0, y: 0, width: image.width, height: image.height },
			classification: {
				sampleCount: 1,
				lumaStd: 0,
				edgeEnergy: 0,
				gradientStrength: 0,
				planeResidualStd: 0,
				darkRatio: 0,
				lineDetected: false,
				lineConfidence: 0,
			},
			limitations: [],
		};
	}),
}));

import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createProCleanTool } from "$lib/editor/tools/pro-clean-tool.ts";
import { readSourceImageData, type PixelRegion } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";
import { isImageEditToolId, toolRegistry, type ToolActivationContext } from "$lib/editor/tool-registry.svelte.ts";

const SIZE = 64;

interface PatchCall {
	kind: "patch" | "healing" | "clone";
	patch: ImageData;
	mask?: Uint8ClampedArray;
	region: PixelRegion;
	tool: { id: string; params?: Record<string, unknown> };
}

interface ApplyCall {
	patch: ImageData;
	region: PixelRegion;
	expectedEpoch?: number;
	options?: { preview?: boolean; skipSnapshot?: boolean };
}

function makeSourceCanvas(size = SIZE): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "rgb(242, 240, 236)";
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = "rgb(24, 24, 24)";
	ctx.fillRect(Math.floor(size / 2) - 4, Math.floor(size / 2) - 4, 8, 8);
	return canvas;
}

function patchPixel(call: PatchCall, x: number, y: number): [number, number, number, number] {
	const localX = x - call.region.x;
	const localY = y - call.region.y;
	const offset = (localY * call.patch.width + localX) * 4;
	const data = call.patch.data;
	return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

function makeHost(
	source: HTMLCanvasElement,
	options: {
		commitResult?: boolean;
		applyResult?: boolean;
		getImageEpoch?: () => number;
	} = {},
): {
	host: EditorToolHost;
	backing: HTMLCanvasElement;
	applyCalls: ApplyCall[];
	patchCalls: PatchCall[];
	commitToolBackground: ReturnType<typeof vi.fn>;
	setToolBusy: ReturnType<typeof vi.fn>;
} {
	const backing = document.createElement("canvas");
	backing.width = source.width;
	backing.height = source.height;
	const bctx = backing.getContext("2d")!;
	bctx.drawImage(source, 0, 0);

	const applyCalls: ApplyCall[] = [];
	const patchCalls: PatchCall[] = [];
	const commitToolBackground = vi.fn();
	const setToolBusy = vi.fn();
	const getImageEpoch = options.getImageEpoch ?? (() => 0);

	const host: EditorToolHost = {
		getImageEpoch,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: backing,
		}),
		applyToolPatchInstant: (patch: ImageData, region: PixelRegion, expectedEpoch?: number, applyOptions?: { preview?: boolean; skipSnapshot?: boolean }) => {
			applyCalls.push({ patch, region, expectedEpoch, options: applyOptions });
			if (options.applyResult === false) return false;
			bctx.putImageData(patch, Math.round(region.x), Math.round(region.y));
			return true;
		},
		commitImageEditLayerPatch: vi.fn(async (input: PatchCall) => {
			patchCalls.push(input);
			return options.commitResult ?? true;
		}),
		setToolBusy,
	};

	return { host, backing, applyCalls, patchCalls, commitToolBackground, setToolBusy };
}

async function runStroke(registry: ToolRegistry, x: number, y: number): Promise<void> {
	registry.handlePointerDown({ scene: { x, y } });
	registry.handlePointerMove({ scene: { x: x + 2, y } });
	registry.handlePointerUp({ scene: { x: x + 3, y: y + 1 } });
	await registry.waitForCommit();
}

function makeRegistry(host: EditorToolHost, tool = createProCleanTool({ radius: 5, respectSelection: false, seed: 9 })): ToolRegistry {
	const registry = new ToolRegistry();
	registry.register(tool);
	registry.setHost(host);
	registry.activate("pro-clean");
	return registry;
}

describe("PRO Clean dock registration", () => {
	it("registers the pro-clean dock id with the Thai label and image-tool activation", () => {
		toolRegistry.__resetToBuiltins();
		const def = toolRegistry.get("pro-clean");
		const ctx: ToolActivationContext = {
			setEngineTool: vi.fn(),
			setRightPanelMode: vi.fn(),
			startTextPlacement: vi.fn(),
			activateImageTool: vi.fn(),
		};

		expect(def?.label).toBe("คลีนโปร");
		expect(def?.optionsContext).toBe("image-tools");
		expect(isImageEditToolId("pro-clean")).toBe(true);
		def?.onActivate?.(ctx);
		expect(ctx.activateImageTool).toHaveBeenCalledWith("pro-clean");
		expect(ctx.setEngineTool).not.toHaveBeenCalled();
	});
});

describe("createProCleanTool", () => {
	it("cleans a brushed ROI through proClean and records a realized patch edit layer", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, applyCalls, patchCalls, commitToolBackground, setToolBusy } = makeHost(source);
		const registry = makeRegistry(host, createProCleanTool({ radius: 10, strategy: "flat", respectSelection: false, seed: 9 }));

		await runStroke(registry, 32, 32);

		expect(patchCalls).toHaveLength(1);
		expect(commitToolBackground).not.toHaveBeenCalled();
		expect(applyCalls[0].options?.preview).toBe(true);
		expect(setToolBusy).toHaveBeenCalledWith(true, "กำลังคลีนโปร");
		expect(setToolBusy).toHaveBeenLastCalledWith(false);
		const call = patchCalls[0];
		expect(call.kind).toBe("patch");
		expect(call.tool.id).toBe("background-edit");
		expect(call.tool.params?.toolId).toBe("pro-clean");
		expect(call.tool.params?.strategy).toBe("flat");
		expect(call.patch.width).toBe(call.region.width);
		expect(call.patch.height).toBe(call.region.height);
		expect(call.region.width * call.region.height).toBeLessThanOrEqual(source.width * source.height);
		expect(patchPixel(call, 32, 32)[0]).toBeGreaterThan(180);
	});

	it("applies strength as an alpha blend over the cleaned result", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, patchCalls } = makeHost(source);
		const tool = createProCleanTool({ radius: 10, strength: 0.5, strategy: "flat", respectSelection: false, seed: 10 });
		const registry = makeRegistry(host, tool);

		await runStroke(registry, 32, 32);

		expect(patchCalls[0].tool.params?.strength).toBe(0.5);
		const [r] = patchPixel(patchCalls[0], 32, 32);
		expect(r).toBeGreaterThan(90);
		expect(r).toBeLessThan(210);
	});

	it("maps the user-facing texture override to the engine screentone strategy", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, patchCalls } = makeHost(source);
		const tool = createProCleanTool({ radius: 5, strategy: "texture", respectSelection: false, seed: 11 });
		const registry = makeRegistry(host, tool);

		await runStroke(registry, 32, 32);

		expect(patchCalls[0].tool.params?.strategy).toBe("texture");
		expect(patchCalls[0].tool.params?.engineStrategy).toBe("screentone");
	});

	it("tiles large ROIs so one big brush stroke is split into bounded proClean solves", async () => {
		const source = makeSourceCanvas(96);
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, patchCalls, setToolBusy } = makeHost(source);
		const tool = createProCleanTool({
			radius: 28,
			respectSelection: false,
			tileSize: 16,
			maxTilePixels: 120,
			seed: 12,
		});
		const registry = makeRegistry(host, tool);

		await runStroke(registry, 48, 48);

		const params = patchCalls[0].tool.params ?? {};
		expect(params.tiled).toBe(true);
		expect(Number(params.tileCount)).toBeGreaterThan(1);
		expect(setToolBusy).toHaveBeenCalledWith(true, "กำลังคลีนโปรพื้นที่ใหญ่");
	});

	it("drops stale results when the image epoch changes before instant apply", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		let epochReads = 0;
		const { host, applyCalls, patchCalls, commitToolBackground } = makeHost(source, {
			applyResult: false,
			getImageEpoch: () => (epochReads++ === 0 ? 0 : 1),
		});
		const registry = makeRegistry(host);

		await runStroke(registry, 32, 32);

		expect(applyCalls).toHaveLength(1);
		expect(patchCalls).toHaveLength(0);
		expect(commitToolBackground).not.toHaveBeenCalled();
	});

	it("clips the stroke to an active selection and no-ops when the selection excludes it", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const { host, patchCalls, applyCalls } = makeHost(source);
		const registry = new ToolRegistry();
		registry.register(createProCleanTool({ radius: 5, respectSelection: true, seed: 13 }));
		registry.setHost(host);
		registry.activate("pro-clean");
		registry.mask.data[0] = 255;
		registry.mask.composite(registry.mask.data, "replace");

		await runStroke(registry, 32, 32);

		expect(patchCalls).toHaveLength(0);
		expect(applyCalls).toHaveLength(0);
	});
});
