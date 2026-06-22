import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createCloneStampTool } from "$lib/editor/tools/clone-stamp-tool.ts";
import { readSourceImageData, type PixelRegion } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

type PatchCommitInput = Parameters<NonNullable<EditorToolHost["commitImageEditLayerPatch"]>>[0];
type ApplyOptions = Parameters<NonNullable<EditorToolHost["applyToolPatchInstant"]>>[3];

interface AppliedPatch {
	patch: ImageData;
	region: PixelRegion;
	expectedEpoch?: number;
	options?: ApplyOptions;
}

interface CloneHost extends EditorToolHost {
	epoch: number;
	applied: AppliedPatch[];
	discarded: number;
	legacyCommits: number;
	patchCommits: PatchCommitInput[];
	canvasObjects: Array<{ text?: string } & Record<string, unknown>>;
}

class FakeText {
	text: string;
	constructor(text: string, options: Record<string, unknown>) {
		this.text = text;
		Object.assign(this, options);
	}
	bringToFront = vi.fn();
}

function makeGradientCanvas(width = 24, height = 6): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return canvas;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			data[offset] = x * 10;
			data[offset + 1] = y * 20;
			data[offset + 2] = 80;
			data[offset + 3] = 255;
		}
	}
	ctx.putImageData(new ImageData(data, width, height), 0, 0);
	return canvas;
}

function makeSplitCanvas(width = 32, height = 24): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return canvas;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const white = x < 10;
			const offset = (y * width + x) * 4;
			data[offset] = white ? 255 : 0;
			data[offset + 1] = white ? 255 : 0;
			data[offset + 2] = white ? 255 : 0;
			data[offset + 3] = 255;
		}
	}
	ctx.putImageData(new ImageData(data, width, height), 0, 0);
	return canvas;
}

function makeHost(source: HTMLCanvasElement, editLayerResult?: boolean): CloneHost {
	const backing = document.createElement("canvas");
	backing.width = source.width;
	backing.height = source.height;
	const sourceCtx = source.getContext("2d");
	const backingCtx = backing.getContext("2d");
	if (sourceCtx && backingCtx) {
		backingCtx.putImageData(sourceCtx.getImageData(0, 0, source.width, source.height), 0, 0);
	}
	const canvasObjects: CloneHost["canvasObjects"] = [];
	const canvas = {
		add: vi.fn((object: CloneHost["canvasObjects"][number]) => {
			canvasObjects.push(object);
		}),
		remove: vi.fn((object: CloneHost["canvasObjects"][number]) => {
			const index = canvasObjects.indexOf(object);
			if (index >= 0) canvasObjects.splice(index, 1);
		}),
		getObjects: () => canvasObjects,
		requestRenderAll: vi.fn(),
	};
	const host: CloneHost = {
		epoch: 1,
		applied: [],
		discarded: 0,
		legacyCommits: 0,
		patchCommits: [],
		canvasObjects,
		getImageEpoch: () => host.epoch,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas,
			fabric: { Text: FakeText },
			sourceElement: backing,
		}),
		applyToolPatchInstant: (patch: ImageData, region: PixelRegion, expectedEpoch?: number, options?: ApplyOptions) => {
			if (expectedEpoch !== undefined && expectedEpoch !== host.epoch) {
				host.discarded += 1;
				return false;
			}
			host.applied.push({ patch, region, expectedEpoch, options });
			backingCtx?.putImageData(patch, Math.round(region.x), Math.round(region.y));
			return true;
		},
		setToolBusy: vi.fn(),
	};
	if (editLayerResult !== undefined) {
		host.commitImageEditLayerPatch = vi.fn(async (input: PatchCommitInput) => {
			host.patchCommits.push(input);
			return editLayerResult;
		});
	}
	return host;
}

function patchPixel(applied: AppliedPatch, x: number, y: number): number[] {
	const localX = x - applied.region.x;
	const localY = y - applied.region.y;
	expect(localX).toBeGreaterThanOrEqual(0);
	expect(localY).toBeGreaterThanOrEqual(0);
	expect(localX).toBeLessThan(applied.region.width);
	expect(localY).toBeLessThan(applied.region.height);
	const offset = (localY * applied.region.width + localX) * 4;
	return Array.from(applied.patch.data.slice(offset, offset + 4));
}

async function paintOnePoint(registry: ToolRegistry, point: { x: number; y: number }): Promise<void> {
	registry.handlePointerDown({ scene: point });
	registry.handlePointerUp({ scene: point });
	await registry.waitForCommit();
}

describe("Clone Stamp tool adapter", () => {
	it("keeps aligned source offset across strokes and restarts in non-aligned mode", async () => {
		for (const mode of ["aligned", "non-aligned"] as const) {
			const source = makeGradientCanvas();
			if (!readSourceImageData(source, source.width, source.height)) return;
			const host = makeHost(source);
			const registry = new ToolRegistry();
			registry.register(createCloneStampTool({ mode, size: 1, hardness: 1, opacity: 1 }));
			registry.setHost(host);
			registry.activate("clone-stamp");

			registry.handlePointerDown({ scene: { x: 2, y: 2 }, altKey: true });
			await paintOnePoint(registry, { x: 10, y: 2 });
			await paintOnePoint(registry, { x: 12, y: 2 });

			expect(host.applied).toHaveLength(2);
			expect(patchPixel(host.applied[0], 10, 2)).toEqual([20, 40, 80, 255]);
			const expectedSourceX = mode === "aligned" ? 4 : 2;
			expect(patchPixel(host.applied[1], 12, 2)).toEqual([expectedSourceX * 10, 40, 80, 255]);
			expect(host.legacyCommits).toBe(0);
		}
	});

	it("uses options.size, hardness, and opacity for the soft brush engine", async () => {
		const source = makeSplitCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeHost(source);
		const registry = new ToolRegistry();
		const tool = createCloneStampTool({ mode: "non-aligned", size: 8, hardness: 0.25, opacity: 0.5 });
		registry.register(tool);
		registry.setHost(host);
		registry.activate("clone-stamp");

		registry.handlePointerDown({ scene: { x: 4, y: 12 }, altKey: true });
		await paintOnePoint(registry, { x: 18, y: 12 });

		expect(tool.options.size).toBe(8);
		const center = patchPixel(host.applied[0], 18, 12)[0];
		const featheredEdge = patchPixel(host.applied[0], 21, 12)[0];
		expect(center).toBeGreaterThanOrEqual(127);
		expect(center).toBeLessThanOrEqual(128);
		expect(featheredEdge).toBeGreaterThan(0);
		expect(featheredEdge).toBeLessThan(center);
	});

	it("does not paint the source-setting click before a source exists", async () => {
		const source = makeGradientCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeHost(source);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ size: 1, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		await paintOnePoint(registry, { x: 10, y: 2 });

		expect(host.applied).toHaveLength(0);
		expect(host.patchCommits).toHaveLength(0);
		expect(host.legacyCommits).toBe(0);
		expect(host.canvasObjects.some((object) => object.text === "ตั้งต้นทาง Clone แล้ว ลากเพื่อปั๊ม")).toBe(true);
	});

	it("commits after a click-only source setup when Alt is not delivered by the host gesture", async () => {
		const source = makeGradientCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeHost(source, true);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ mode: "non-aligned", size: 1, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		// Matches the live smoke runner failure mode: page.mouse.click() ignores the
		// unsupported modifiers option, so the source gesture arrives as a plain click.
		registry.handlePointerDown({ scene: { x: 2, y: 2 } });
		registry.handlePointerUp({ scene: { x: 2, y: 2 } });
		expect(host.patchCommits).toHaveLength(0);

		registry.handlePointerDown({ scene: { x: 10, y: 2 } });
		registry.handlePointerMove({ scene: { x: 11, y: 2 }, pressed: true });
		registry.handlePointerUp({ scene: { x: 12, y: 2 } });
		await registry.waitForCommit();

		expect(host.patchCommits).toHaveLength(1);
		expect(host.applied[0].options).toEqual({ preview: true });
		const call = host.patchCommits[0];
		expect(call.kind).toBe("clone");
		expect(call.tool.id).toBe("clone-stamp");
		expect(call.offset).toEqual({ dx: 8, dy: 0 });
		expect(call.sourceBbox).toEqual({ x: 2, y: 2, w: 3, h: 1 });
		expect(patchPixel(host.applied[0], 10, 2)).toEqual([20, 40, 80, 255]);
		expect(host.legacyCommits).toBe(0);
	});

	it("shows a blocking source hint instead of silently no-oping a drag with no source", async () => {
		const source = makeGradientCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeHost(source, true);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ size: 1, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		registry.handlePointerDown({ scene: { x: 10, y: 2 } });
		registry.handlePointerMove({ scene: { x: 14, y: 2 }, pressed: true });
		registry.handlePointerUp({ scene: { x: 16, y: 2 } });
		await registry.waitForCommit();

		expect(host.applied).toHaveLength(0);
		expect(host.patchCommits).toHaveLength(0);
		expect(host.legacyCommits).toBe(0);
		expect(host.canvasObjects.some((object) => object.text === "ตั้งต้นทางก่อน: Alt-click หรือคลิกจุดต้นทาง")).toBe(true);
	});

	it("commits a clone stroke as an edit layer with source metadata", async () => {
		const source = makeGradientCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeHost(source, true);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ mode: "non-aligned", size: 1, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		registry.handlePointerDown({ scene: { x: 2, y: 2 }, altKey: true });
		await paintOnePoint(registry, { x: 10, y: 2 });

		expect(host.patchCommits).toHaveLength(1);
		expect(host.applied[0].options).toEqual({ preview: true });
		const call = host.patchCommits[0];
		expect(call.kind).toBe("clone");
		expect(call.tool).toEqual({
			id: "clone-stamp",
			params: {
				radius: 0.5,
				size: 1,
				hardness: 1,
				opacity: 1,
				mode: "non-aligned",
				respectSelection: true,
			},
		});
		expect(call.offset).toEqual({ dx: 8, dy: 0 });
		expect(call.sourceBbox).toEqual({ x: 2, y: 2, w: 1, h: 1 });
		expect(host.legacyCommits).toBe(0);
	});

	it("reverts the instant preview when edit-layer commit fails", async () => {
		const source = makeGradientCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeHost(source, false);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ mode: "non-aligned", size: 1, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		registry.handlePointerDown({ scene: { x: 2, y: 2 }, altKey: true });
		await paintOnePoint(registry, { x: 10, y: 2 });

		expect(host.patchCommits).toHaveLength(1);
		expect(host.applied).toHaveLength(2);
		expect(host.applied[0].options).toEqual({ preview: true });
		expect(host.applied[1].options).toEqual({ preview: true, skipSnapshot: true });
		expect(patchPixel(host.applied[1], 10, 2)).toEqual([100, 40, 80, 255]);
		expect(host.legacyCommits).toBe(0);
	});

	it("drops a stale stroke when the image epoch changes before commit", async () => {
		const source = makeGradientCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;
		const host = makeHost(source, true);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ mode: "non-aligned", size: 1, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		registry.handlePointerDown({ scene: { x: 2, y: 2 }, altKey: true });
		registry.handlePointerDown({ scene: { x: 10, y: 2 } });
		host.epoch += 1;
		registry.handlePointerUp({ scene: { x: 10, y: 2 } });
		await registry.waitForCommit();

		expect(host.discarded).toBe(1);
		expect(host.applied).toHaveLength(0);
		expect(host.patchCommits).toHaveLength(0);
		expect(host.legacyCommits).toBe(0);
	});
});
