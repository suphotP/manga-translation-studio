import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/editor/tools/raster.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/editor/tools/raster.ts")>();
	return {
		...actual,
		readSourceImageData: (
			source: (CanvasImageSource & { __testImageData?: ImageData }) | null,
			width: number,
			height: number,
		): ImageData | null => {
			if (source?.__testImageData) {
				return new ImageData(new Uint8ClampedArray(source.__testImageData.data), width, height);
			}
			return actual.readSourceImageData(source, width, height);
		},
	};
});

import {
	BUILTIN_TOOLS,
	toolRegistry as dockToolRegistry,
	type ToolActivationContext,
} from "$lib/editor/tool-registry.svelte.ts";
import { ToolRegistry, createImageEditSuite } from "$lib/editor/tools/registry.ts";
import { createScreentoneFillTool } from "$lib/editor/tools/screentone-fill-tool.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";
import type { PixelRegion } from "$lib/editor/tools/raster.ts";

type CommitInput = Parameters<NonNullable<EditorToolHost["commitImageEditLayerPatch"]>>[0];

interface ApplyCall {
	patch: ImageData;
	region: PixelRegion;
	expectedEpoch: number | undefined;
	options: { preview?: boolean; skipSnapshot?: boolean } | undefined;
}

interface TestSource {
	width: number;
	height: number;
	__testImageData: ImageData;
}

function installImmediateRaf(): void {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
}

function makeSourceCanvas(): TestSource {
	const width = 6;
	const height = 4;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 4;
			const value = x < 3 ? 255 : x === 3 ? 0 : 160;
			data[offset] = value;
			data[offset + 1] = value;
			data[offset + 2] = value;
			data[offset + 3] = 255;
		}
	}
	return { width, height, __testImageData: new ImageData(data, width, height) };
}

function makeHost(
	source = makeSourceCanvas(),
	options: { commitResult?: boolean; epoch?: number } = {},
): {
	host: EditorToolHost;
	source: TestSource;
	applyCalls: ApplyCall[];
	commitCalls: CommitInput[];
	tracked: Promise<void>[];
	commitToolBackground: ReturnType<typeof vi.fn>;
	setEpoch(value: number): void;
} {
	let epoch = options.epoch ?? 1;
	const applyCalls: ApplyCall[] = [];
	const commitCalls: CommitInput[] = [];
	const tracked: Promise<void>[] = [];
	const commitToolBackground = vi.fn();

	const host: EditorToolHost = {
		getImageEpoch: () => epoch,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: {},
			sourceElement: source as unknown as CanvasImageSource,
		}),
		applyToolPatchInstant: (patch, region, expectedEpoch, previewOptions) => {
			applyCalls.push({ patch, region: region as PixelRegion, expectedEpoch, options: previewOptions });
			return expectedEpoch === undefined || expectedEpoch === epoch;
		},
		commitImageEditLayerPatch: async (input) => {
			commitCalls.push(input);
			return options.commitResult ?? true;
		},
		setToolBusy: vi.fn(),
		trackInstantToolCommit: (pending) => {
			tracked.push(pending);
		},
	};

	return {
		host,
		source,
		applyCalls,
		commitCalls,
		tracked,
		commitToolBackground,
		setEpoch(value: number) {
			epoch = value;
		},
	};
}

async function waitForTracked(tracked: Promise<void>[]): Promise<void> {
	expect(tracked.length).toBeGreaterThan(0);
	await tracked[tracked.length - 1];
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function alphaAt(image: ImageData, x: number, y: number): number {
	return image.data[(y * image.width + x) * 4 + 3];
}

function pixelAt(image: ImageData, x: number, y: number): number[] {
	const offset = (y * image.width + x) * 4;
	return Array.from(image.data.slice(offset, offset + 4));
}

describe("screentone fill tool", () => {
	beforeEach(() => {
		installImmediateRaf();
		dockToolRegistry.__resetToBuiltins();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("bucket-fills the clicked contiguous region and commits it as a realized patch edit layer", async () => {
		const { host, applyCalls, commitCalls, tracked, commitToolBackground } = makeHost();
		const registry = new ToolRegistry();
		registry.register(createScreentoneFillTool({ type: "line", density: 1, size: 4, angle: 30, tolerance: 0 }));
		registry.setHost(host);
		registry.activate("screentone-fill");

		registry.handlePointerDown({ scene: { x: 1, y: 1 } });
		await waitForTracked(tracked);

		expect(commitCalls).toHaveLength(1);
		expect(commitToolBackground).not.toHaveBeenCalled();
		expect(applyCalls).toHaveLength(1);
		expect(applyCalls[0].options).toEqual({ preview: true });
		expect(commitCalls[0].kind).toBe("patch");
		expect(commitCalls[0].tool).toEqual({
			id: "background-edit",
			params: {
				toolId: "screentone-fill",
				source: "flood",
				type: "line",
				density: 1,
				size: 4,
				angle: 30,
				tolerance: 0,
			},
		});
		expect(commitCalls[0].region).toEqual({ x: 0, y: 0, width: 3, height: 4 });
		expect(commitCalls[0].patch.width).toBe(3);
		expect(commitCalls[0].patch.height).toBe(4);
		expect(alphaAt(commitCalls[0].patch, 0, 0)).toBe(255);
	});

	it("uses an active mask instead of flood-filling when a selection mask exists", async () => {
		const { host, commitCalls, tracked } = makeHost();
		const registry = new ToolRegistry();
		registry.register(createScreentoneFillTool({ density: 1 }));
		registry.setHost(host);
		registry.activate("screentone-fill");

		const mask = new Uint8ClampedArray(6 * 4);
		mask[1 * 6 + 1] = 255;
		mask[1 * 6 + 2] = 255;
		mask[2 * 6 + 1] = 255;
		registry.mask.composite(mask);

		registry.handlePointerDown({ scene: { x: 5, y: 3 } });
		await waitForTracked(tracked);

		expect(commitCalls).toHaveLength(1);
		expect(commitCalls[0].tool.params?.source).toBe("active-mask");
		expect(commitCalls[0].region).toEqual({ x: 1, y: 1, width: 2, height: 2 });
		expect(alphaAt(commitCalls[0].patch, 0, 0)).toBe(255);
		expect(alphaAt(commitCalls[0].patch, 1, 0)).toBe(255);
		expect(alphaAt(commitCalls[0].patch, 0, 1)).toBe(255);
		// The bbox contains this pixel, but the mask did not; durable patch stays
		// transparent so it cannot cover lower edit layers outside the mask.
		expect(alphaAt(commitCalls[0].patch, 1, 1)).toBe(0);
	});

	it("drops a queued fill when the image epoch changes before the patch lands", async () => {
		const rafCallbacks: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			rafCallbacks.push(callback);
			return rafCallbacks.length;
		});
		const { host, setEpoch, applyCalls, commitCalls, tracked } = makeHost();
		const registry = new ToolRegistry();
		registry.register(createScreentoneFillTool({ density: 1 }));
		registry.setHost(host);
		registry.activate("screentone-fill");

		registry.handlePointerDown({ scene: { x: 1, y: 1 } });
		await Promise.resolve();
		setEpoch(2);
		expect(rafCallbacks).toHaveLength(1);
		for (const callback of rafCallbacks) callback(0);
		await waitForTracked(tracked);

		expect(applyCalls).toHaveLength(0);
		expect(commitCalls).toHaveLength(0);
	});

	it("reverts the transient preview when the edit-layer commit fails", async () => {
		const { host, applyCalls, commitCalls, tracked } = makeHost(undefined, { commitResult: false });
		const registry = new ToolRegistry();
		registry.register(createScreentoneFillTool({ density: 1, tolerance: 0 }));
		registry.setHost(host);
		registry.activate("screentone-fill");

		registry.handlePointerDown({ scene: { x: 1, y: 1 } });
		await waitForTracked(tracked);

		expect(commitCalls).toHaveLength(1);
		expect(applyCalls).toHaveLength(2);
		expect(applyCalls[1].options).toEqual({ preview: true, skipSnapshot: true });
		expect(pixelAt(applyCalls[1].patch, 0, 0)).toEqual([255, 255, 255, 255]);
	});

	it("does not commit an empty tone patch", async () => {
		const { host, applyCalls, commitCalls, tracked } = makeHost();
		const registry = new ToolRegistry();
		registry.register(createScreentoneFillTool({ density: 0, tolerance: 0 }));
		registry.setHost(host);
		registry.activate("screentone-fill");

		registry.handlePointerDown({ scene: { x: 1, y: 1 } });
		await waitForTracked(tracked);

		expect(applyCalls).toHaveLength(0);
		expect(commitCalls).toHaveLength(0);
	});

	it("registers in the dock and the image-edit suite under the screentone-fill id", () => {
		const dockDef = BUILTIN_TOOLS.find((tool) => tool.id === "screentone-fill");
		expect(dockDef?.label).toBe("สกรีนโทน");
		expect(dockDef?.shortcut).toBe("Shift+G");
		expect(dockDef?.optionsContext).toBe("image-tools");
		const activationContext: ToolActivationContext = {
			setEngineTool: vi.fn(),
			setRightPanelMode: vi.fn(),
			startTextPlacement: vi.fn(),
			activateImageTool: vi.fn(),
		};
		dockDef?.onActivate?.(activationContext);
		expect(activationContext.activateImageTool).toHaveBeenCalledWith("screentone-fill");
		expect(dockToolRegistry.get("screentone-fill")?.label).toBe("สกรีนโทน");

		const { registry, tools } = createImageEditSuite(makeHost().host);
		expect(registry.get("screentone-fill")?.id).toBe("screentone-fill");
		expect(tools.screentoneFill.shortcut).toBe("Shift+G");
		expect(tools.screentoneFill.options.type).toBe("dot");
	});
});
