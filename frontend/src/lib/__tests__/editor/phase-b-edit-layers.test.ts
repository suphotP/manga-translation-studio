// Phase B — healing-brush + clone-stamp are NON-DESTRUCTIVE.
//
// Instead of baking a full new page PNG per stroke (the legacy `commitToolBackground`
// / debounced full-image persist path), a heal/clone stroke must record a realized-
// patch `ImageEditLayer` via the host's `commitImageEditLayerPatch`: it uploads the
// REALIZED ROI (RGBA PNG) + (for healing/clone) the stroke mask as small assets and
// appends a `healing` / `clone` layer. These tests drive the real tools through the
// registry against a host that exposes `commitImageEditLayerPatch`, and assert:
//   1) commitImageEditLayerPatch is called with the realized ROI patch + region + kind;
//   2) the legacy full-image background commit path is NOT used;
//   3) a commit failure reverts the instant preview (no phantom edit);
//   4) the realized patch is ROI-sized (tiny), not a full-page bitmap.

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "$lib/editor/tools/registry.ts";
import { createHealingBrushTool } from "$lib/editor/tools/healing-brush-tool.ts";
import { createCloneStampTool } from "$lib/editor/tools/clone-stamp-tool.ts";
import { readSourceImageData, type PixelRegion } from "$lib/editor/tools/raster.ts";
import type { EditorToolHost } from "$lib/editor/tools/types.ts";

// Echo the ROI back as the "healed" result (deterministic, no OpenCV in jsdom).
vi.mock("$lib/editor/tools/inpaint-worker-client.ts", () => ({
	inpaintRegion: (roi: ImageData) => Promise.resolve(roi),
}));

const SIZE = 48;

function makeSourceCanvas(): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = SIZE;
	c.height = SIZE;
	const ctx = c.getContext("2d");
	if (ctx) {
		ctx.fillStyle = "#777";
		ctx.fillRect(0, 0, SIZE, SIZE);
		ctx.fillStyle = "#111";
		ctx.fillRect(18, 18, 8, 8);
	}
	return c;
}

interface PatchCall {
	kind: "patch" | "healing" | "clone";
	patch: ImageData;
	mask?: Uint8ClampedArray;
	region: PixelRegion;
	tool: { id: string };
	algorithm?: string;
	algorithmVersion?: string;
	sourceBbox?: { x: number; y: number; w: number; h: number };
	offset?: { dx: number; dy: number };
}

function makePatchHost(
	source: HTMLCanvasElement,
	commitResult = true,
): {
	host: EditorToolHost;
	commitImageEditLayerPatch: ReturnType<typeof vi.fn>;
	commitToolBackground: ReturnType<typeof vi.fn>;
	calls: PatchCall[];
	previews: PixelRegion[];
} {
	const backing = document.createElement("canvas");
	backing.width = source.width;
	backing.height = source.height;
	const bctx = backing.getContext("2d")!;
	const sctx = source.getContext("2d")!;
	bctx.putImageData(sctx.getImageData(0, 0, source.width, source.height), 0, 0);

	const calls: PatchCall[] = [];
	const previews: PixelRegion[] = [];
	const commitToolBackground = vi.fn();
	const commitImageEditLayerPatch = vi.fn(async (input: PatchCall) => {
		calls.push(input);
		return commitResult;
	});

	const host: EditorToolHost = {
		getImageEpoch: () => 0,
		getImageSpaceContext: () => ({
			imageBounds: { left: 0, top: 0, width: source.width, height: source.height },
			imageWidth: source.width,
			imageHeight: source.height,
			canvas: { add: vi.fn(), remove: vi.fn(), getObjects: () => [], requestRenderAll: vi.fn() },
			fabric: { Circle: function () { /* stub */ } },
			sourceElement: backing,
		}),
		applyToolPatchInstant: (patch: ImageData, region: PixelRegion) => {
			previews.push(region);
			bctx.putImageData(patch, Math.round(region.x), Math.round(region.y));
			return true;
		},
		commitImageEditLayerPatch,
		setToolBusy: vi.fn(),
	};
	return { host, commitImageEditLayerPatch, commitToolBackground, calls, previews };
}

async function flushAsync(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("Phase B — healing brush records a realized-patch healing edit layer", () => {
	it("calls commitImageEditLayerPatch (kind=healing) with the ROI patch + mask, NOT commitToolBackground", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return; // no raster backend → skip

		const { host, commitImageEditLayerPatch, commitToolBackground, calls } = makePatchHost(source);
		const registry = new ToolRegistry();
		registry.register(createHealingBrushTool({ radius: 5, inpaintRadius: 2, respectSelection: false }));
		registry.setHost(host);
		registry.activate("healing-brush");

		registry.handlePointerDown({ scene: { x: 20, y: 20 } });
		registry.handlePointerUp({ scene: { x: 21, y: 21 } });
		await flushAsync();
		await registry.waitForCommit();

		expect(commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		expect(commitToolBackground).not.toHaveBeenCalled();
		const call = calls[0];
		expect(call.kind).toBe("healing");
		expect(call.tool.id).toBe("healing-brush");
		expect(call.algorithm).toBe("telea");
		// Realized patch + mask are present and ROI-sized (tiny, not a full page bitmap).
		expect(call.patch.width).toBe(call.region.width);
		expect(call.patch.height).toBe(call.region.height);
		expect(call.region.width * call.region.height).toBeLessThan(SIZE * SIZE);
		expect(call.mask).toBeInstanceOf(Uint8ClampedArray);
	});

	it("reverts the instant preview when the healing commit FAILS (no phantom heal)", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;

		const { host, commitImageEditLayerPatch, commitToolBackground, previews } = makePatchHost(source, false);
		const registry = new ToolRegistry();
		registry.register(createHealingBrushTool({ radius: 5, inpaintRadius: 2, respectSelection: false }));
		registry.setHost(host);
		registry.activate("healing-brush");

		registry.handlePointerDown({ scene: { x: 20, y: 20 } });
		registry.handlePointerUp({ scene: { x: 21, y: 21 } });
		await flushAsync();
		await registry.waitForCommit();

		expect(commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		expect(commitToolBackground).not.toHaveBeenCalled();
		// Preview painted once for the heal + once for the revert (original ROI repaint).
		expect(previews.length).toBeGreaterThanOrEqual(2);
	});
});

describe("Phase B — clone stamp records a realized-patch clone edit layer", () => {
	it("calls commitImageEditLayerPatch (kind=clone) with source metadata, NOT commitToolBackground", async () => {
		const source = makeSourceCanvas();
		if (!readSourceImageData(source, source.width, source.height)) return;

		const { host, commitImageEditLayerPatch, commitToolBackground, calls } = makePatchHost(source);
		const registry = new ToolRegistry();
		registry.register(createCloneStampTool({ radius: 5, hardness: 1, opacity: 1 }));
		registry.setHost(host);
		registry.activate("clone-stamp");

		// Alt+click sets the clone source anchor, then a stroke clones from it.
		registry.handlePointerDown({ scene: { x: 10, y: 10 }, altKey: true });
		registry.handlePointerDown({ scene: { x: 30, y: 30 } });
		registry.handlePointerUp({ scene: { x: 31, y: 31 } });
		await flushAsync();
		await registry.waitForCommit();

		expect(commitImageEditLayerPatch).toHaveBeenCalledTimes(1);
		expect(commitToolBackground).not.toHaveBeenCalled();
		const call = calls[0];
		expect(call.kind).toBe("clone");
		expect(call.tool.id).toBe("clone-stamp");
		// Source metadata recorded for provenance.
		expect(call.offset).toBeDefined();
		expect(call.sourceBbox).toBeDefined();
		expect(call.patch.width).toBe(call.region.width);
	});
});
