import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createBucketFillTool } from "$lib/editor/tools/bucket-fill-tool.ts";
import { isImageEditToolId, toolRegistry } from "$lib/editor/tool-registry.svelte.ts";
import type { PixelRegion } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

interface PatchCall {
	kind: string;
	patch: ImageData;
	region: PixelRegion;
	tool: { id: string; params?: Record<string, unknown> };
}

interface ApplyCall {
	patch: ImageData;
	region: PixelRegion;
	expectedEpoch?: number;
	options?: { preview?: boolean; skipSnapshot?: boolean };
}

function rgba(r: number, g: number, b: number, a = 255): [number, number, number, number] {
	return [r, g, b, a];
}

function makeCanvas(
	width: number,
	height: number,
	pixel: (x: number, y: number) => [number, number, number, number],
): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = pixel(x, y);
			const offset = (y * width + x) * 4;
			data[offset] = r;
			data[offset + 1] = g;
			data[offset + 2] = b;
			data[offset + 3] = a;
		}
	}
	canvas.getContext("2d")!.putImageData(new ImageData(data, width, height), 0, 0);
	return canvas;
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = source.width;
	canvas.height = source.height;
	canvas.getContext("2d")!.drawImage(source, 0, 0);
	return canvas;
}

function pixelAt(image: ImageData, x: number, y: number): [number, number, number, number] {
	const offset = (y * image.width + x) * 4;
	return [
		image.data[offset],
		image.data[offset + 1],
		image.data[offset + 2],
		image.data[offset + 3],
	];
}

function canvasPixel(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
	return pixelAt(canvas.getContext("2d")!.getImageData(x, y, 1, 1), 0, 0);
}

function makeHost(
	source: HTMLCanvasElement,
	options: { commitResult?: boolean; rejectStaleEpoch?: boolean; epoch?: number } = {},
): {
	host: EditorToolHost;
	backing: HTMLCanvasElement;
	applyCalls: ApplyCall[];
	patchCalls: PatchCall[];
	commitImageEditLayerPatch: ReturnType<typeof vi.fn>;
	commitToolBackground: ReturnType<typeof vi.fn>;
	setEpoch: (epoch: number) => void;
} {
	const backing = copyCanvas(source);
	const ctx = backing.getContext("2d")!;
	let epoch = options.epoch ?? 1;
	const applyCalls: ApplyCall[] = [];
	const patchCalls: PatchCall[] = [];
	const commitToolBackground = vi.fn();
	const commitImageEditLayerPatch = vi.fn(async (input: PatchCall) => {
		patchCalls.push(input);
		return options.commitResult ?? true;
	});

	const host: EditorToolHost = {
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: backing,
		}),
		getImageEpoch: () => epoch,
		applyToolPatchInstant: (patch: ImageData, region: PixelRegion, expectedEpoch?: number, applyOptions?: ApplyCall["options"]) => {
			applyCalls.push({ patch, region, expectedEpoch, options: applyOptions });
			if (options.rejectStaleEpoch && expectedEpoch !== undefined && expectedEpoch !== epoch) return false;
			ctx.putImageData(patch, region.x, region.y);
			return true;
		},
		commitImageEditLayerPatch: commitImageEditLayerPatch as unknown as EditorToolHost["commitImageEditLayerPatch"],
		setToolBusy: vi.fn(),
	};

	return {
		host,
		backing,
		applyCalls,
		patchCalls,
		commitImageEditLayerPatch,
		commitToolBackground,
		setEpoch(next: number) {
			epoch = next;
		},
	};
}

async function clickBucket(
	host: EditorToolHost,
	tool = createBucketFillTool({ fillColor: rgba(255, 0, 0) }),
	x = 0,
	y = 0,
): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	registry.register(tool);
	registry.setHost(host);
	expect(registry.activate("bucket-fill")).toBe(true);
	registry.handlePointerDown({ scene: { x, y } });
	registry.handlePointerUp({ scene: { x, y } });
	await registry.waitForCommit();
	return registry;
}

describe("Bucket Fill tool", () => {
	beforeEach(() => {
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("flood-fills the clicked contiguous region and commits a bucket-fill edit layer patch", async () => {
		const source = makeCanvas(5, 3, (x) => (x < 3 ? rgba(255, 255, 255) : rgba(0, 0, 0)));
		const { host, backing, applyCalls, patchCalls, commitImageEditLayerPatch, commitToolBackground } =
			makeHost(source, { epoch: 7 });

		await clickBucket(host, createBucketFillTool({ fillColor: rgba(255, 0, 0), tolerance: 0 }));

		expect(commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		expect(commitToolBackground).not.toHaveBeenCalled();
		expect(applyCalls).toHaveLength(1);
		expect(applyCalls[0].region).toEqual({ x: 0, y: 0, width: 3, height: 3 });
		expect(applyCalls[0].expectedEpoch).toBe(7);
		expect(applyCalls[0].options).toEqual({ preview: true });

		const call = patchCalls[0];
		expect(call.kind).toBe("patch");
		expect(call.tool.id).toBe("bucket-fill");
		expect(call.tool.params).toMatchObject({
			tolerance: 0,
			contiguous: true,
			antiAlias: false,
			fillColor: [255, 0, 0, 255],
		});
		expect(call.region).toEqual({ x: 0, y: 0, width: 3, height: 3 });
		expect(pixelAt(call.patch, 2, 2)).toEqual(rgba(255, 0, 0));
		expect(canvasPixel(backing, 2, 1)).toEqual(rgba(255, 0, 0));
		expect(canvasPixel(backing, 4, 1)).toEqual(rgba(0, 0, 0));
		expect(host.setToolBusy).toHaveBeenCalledWith(true, "กำลังคำนวณ Bucket Fill");
		expect(host.setToolBusy).toHaveBeenCalledWith(true, "กำลังบันทึก Bucket Fill");
		expect(host.setToolBusy).toHaveBeenLastCalledWith(false);
	});

	it("honors non-contiguous, tolerance, antiAlias, and fillColor options from the tool", async () => {
		const source = makeCanvas(5, 1, (x) => {
			if (x === 1) return rgba(90, 90, 90);
			if (x === 3) return rgba(14, 10, 10);
			return rgba(10, 10, 10);
		});
		const { host, patchCalls } = makeHost(source);
		const tool = createBucketFillTool({
			fillColor: rgba(0, 200, 0, 200),
			tolerance: 4,
			contiguous: false,
			antiAlias: true,
		});

		await clickBucket(host, tool);

		const call = patchCalls[0];
		expect(call.tool.params).toMatchObject({
			tolerance: 4,
			contiguous: false,
			antiAlias: true,
			fillColor: [0, 200, 0, 200],
		});
		expect(call.region).toEqual({ x: 0, y: 0, width: 5, height: 1 });
		expect(pixelAt(call.patch, 0, 0)).toEqual(rgba(0, 200, 0, 200));
		expect(pixelAt(call.patch, 2, 0)).toEqual(rgba(0, 200, 0, 200));
		expect(pixelAt(call.patch, 4, 0)).toEqual(rgba(0, 200, 0, 200));
		// Unfilled pixels must stay fully transparent in the committed patch so the
		// edit layer doesn't cover earlier layers when composited at its bbox.
		expect(pixelAt(call.patch, 1, 0)).toEqual(rgba(0, 0, 0, 0));
		// Distance 4 sits in the anti-aliased edge band, so alpha is partially covered.
		expect(pixelAt(call.patch, 3, 0)).toEqual(rgba(0, 200, 0, 100));
	});

	it("does not commit when the clicked fill would leave pixels unchanged", async () => {
		const source = makeCanvas(3, 2, () => rgba(255, 0, 0));
		const { host, applyCalls, commitImageEditLayerPatch, commitToolBackground } = makeHost(source);

		await clickBucket(host, createBucketFillTool({ fillColor: rgba(255, 0, 0) }));

		expect(applyCalls).toHaveLength(0);
		expect(commitImageEditLayerPatch).not.toHaveBeenCalled();
		expect(commitToolBackground).not.toHaveBeenCalled();
	});

	it("drops a stale click when the backing image epoch changes before preview apply", async () => {
		const source = makeCanvas(3, 1, () => rgba(255, 255, 255));
		const { host, applyCalls, commitImageEditLayerPatch, setEpoch } = makeHost(source, {
			epoch: 1,
			rejectStaleEpoch: true,
		});
		const registry = new ToolRegistry();
		registry.register(createBucketFillTool({ fillColor: rgba(0, 0, 255) }));
		registry.setHost(host);
		registry.activate("bucket-fill");

		registry.handlePointerDown({ scene: { x: 0, y: 0 } });
		setEpoch(2);
		registry.handlePointerUp({ scene: { x: 0, y: 0 } });
		await registry.waitForCommit();

		expect(applyCalls).toHaveLength(1);
		expect(applyCalls[0].expectedEpoch).toBe(1);
		expect(commitImageEditLayerPatch).not.toHaveBeenCalled();
	});

	it("reverts the instant preview when the edit-layer commit fails", async () => {
		const source = makeCanvas(4, 2, (x) => (x < 2 ? rgba(255, 255, 255) : rgba(0, 0, 0)));
		const { host, backing, applyCalls, commitImageEditLayerPatch } = makeHost(source, { commitResult: false });

		await clickBucket(host, createBucketFillTool({ fillColor: rgba(0, 0, 255) }));

		expect(commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		expect(applyCalls).toHaveLength(2);
		expect(applyCalls[0].options).toEqual({ preview: true });
		expect(applyCalls[1].options).toEqual({ preview: true, skipSnapshot: true });
		expect(canvasPixel(backing, 0, 0)).toEqual(rgba(255, 255, 255));
		expect(canvasPixel(backing, 1, 1)).toEqual(rgba(255, 255, 255));
		expect(canvasPixel(backing, 3, 0)).toEqual(rgba(0, 0, 0));
	});

	// Correctness-only large-fill smoke: NO wall-clock assertion on purpose —
	// timing a multi-megapixel jsdom canvas is machine-speed-dependent and made
	// CI nondeterministic (codex P2). The perf characteristics live in the
	// chunked hot loop itself; this pins that a big fill still completes and
	// commits one correct full-region patch.
	it("completes a large synthetic bucket fill and commits one full-region patch", async () => {
		const width = 512;
		const height = 512;
		const source = makeCanvas(width, height, () => rgba(245, 245, 245));
		const { host, patchCalls } = makeHost(source);

		await clickBucket(host, createBucketFillTool({ fillColor: rgba(12, 24, 36), tolerance: 0 }));

		expect(patchCalls).toHaveLength(1);
		expect(patchCalls[0].region).toEqual({ x: 0, y: 0, width, height });
		expect(pixelAt(patchCalls[0].patch, width - 1, height - 1)).toEqual(rgba(12, 24, 36));
	}, 10_000);

	it("registers the dock entry as bucket-fill / ถังสี with the G shortcut", () => {
		toolRegistry.__resetToBuiltins();
		const def = toolRegistry.get("bucket-fill");
		const activateImageTool = vi.fn();

		expect(def?.label).toBe("ถังสี");
		expect(def?.shortcut).toBe("G");
		expect(def?.optionsContext).toBe("image-tools");
		expect(isImageEditToolId("bucket-fill")).toBe(true);
		def?.onActivate?.({
			setEngineTool: vi.fn(),
			setRightPanelMode: vi.fn(),
			startTextPlacement: vi.fn(),
			activateImageTool,
		});
		expect(activateImageTool).toHaveBeenCalledWith("bucket-fill");
	});
});
