// Tool — Screentone Fill.
//
// Click-fills a contiguous bucket mask, or reuses the active image-space mask,
// with a generated screentone pattern. The result is committed as a realized
// patch edit layer so the original page bitmap remains intact.

import { floodFill, type RgbaColor } from "$lib/editor-tools/flood-fill.js";
import {
	fillMaskWithTone,
	type ScreentoneType,
	type ToneOptions,
} from "$lib/editor-tools/screentone.js";
import { getEditorShortcutForSuiteTool } from "$lib/editor-tools/keymap.js";
import {
	computeMaskBounds,
	makeImageData,
	readSourceImageData,
	sliceImageDataRegion,
	type PixelRegion,
} from "./raster.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

const DEFAULT_BUSY_LABEL = "กำลังเติมสกรีนโทน";

export interface ScreentoneFillOptions {
	type: ScreentoneType;
	density: number;
	/** Pattern cell size in image pixels. */
	size: number;
	/** Pattern angle in degrees. */
	angle: number;
	/** Bucket-fill colour tolerance, in channel distance. */
	tolerance: number;
	/** Prefer an existing mask over bucket-fill when selection tools already made one. */
	useActiveMask: boolean;
	contiguous: boolean;
	antiAlias: boolean;
}

export interface ScreentoneFillApi {
	options: ScreentoneFillOptions;
	fillAt(ctx: ToolContext, point: { x: number; y: number }): Promise<void>;
	fillActiveMask(ctx: ToolContext): Promise<void>;
}

const DEFAULT_OPTIONS: ScreentoneFillOptions = {
	type: "dot",
	density: 0.35,
	size: 8,
	angle: 45,
	tolerance: 18,
	useActiveMask: true,
	contiguous: true,
	antiAlias: false,
};

const MARKER_CANDIDATES: RgbaColor[] = [
	[255, 0, 255, 255],
	[0, 255, 255, 255],
	[255, 255, 0, 255],
	[0, 0, 255, 255],
	[255, 0, 0, 255],
	[0, 255, 0, 255],
	[17, 34, 51, 255],
	[238, 221, 204, 255],
];

function nextFrame(): Promise<void> {
	if (typeof requestAnimationFrame === "function") {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function toneOptions(options: ScreentoneFillOptions): ToneOptions {
	return {
		type: options.type,
		density: options.density,
		sizePx: options.size,
		angleDeg: options.angle,
	};
}

function pixelOffset(width: number, x: number, y: number): number {
	return (y * width + x) * 4;
}

function colorPresent(data: Uint8ClampedArray, color: RgbaColor): boolean {
	for (let offset = 0; offset < data.length; offset += 4) {
		if (
			data[offset] === color[0] &&
			data[offset + 1] === color[1] &&
			data[offset + 2] === color[2] &&
			data[offset + 3] === color[3]
		) {
			return true;
		}
	}
	return false;
}

function markerFromSeed(data: Uint8ClampedArray, width: number, x: number, y: number): RgbaColor {
	const offset = pixelOffset(width, x, y);
	const seed = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]] as const;
	const seedDerived: RgbaColor[] = [
		[255 - seed[0], 255 - seed[1], 255 - seed[2], 255],
		[seed[0] ^ 0xff, seed[1] ^ 0x7f, seed[2] ^ 0x3f, 255],
		[(seed[0] + 97) % 256, (seed[1] + 151) % 256, (seed[2] + 211) % 256, 255],
	];
	for (const candidate of [...seedDerived, ...MARKER_CANDIDATES]) {
		if (!colorPresent(data, candidate)) return candidate;
	}
	// Keep the marker absent from the page so extracting the mask cannot pick up
	// unrelated pixels that already had the marker colour.
	for (let r = 0; r < 256; r += 17) {
		const candidate: RgbaColor = [r, (r * 7) % 256, (r * 13) % 256, 253];
		if (!colorPresent(data, candidate)) return candidate;
	}
	throw new Error("screentone-fill: could not allocate a marker colour");
}

function floodMaskFromPoint(
	image: ImageData,
	point: { x: number; y: number },
	options: ScreentoneFillOptions,
): Uint8ClampedArray | null {
	const x = Math.floor(point.x);
	const y = Math.floor(point.y);
	if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;

	const scratch = makeImageData(new Uint8ClampedArray(image.data), image.width, image.height);
	const marker = markerFromSeed(scratch.data, image.width, x, y);
	const result = floodFill(scratch, x, y, marker, {
		tolerance: options.tolerance,
		contiguous: options.contiguous,
		antiAlias: options.antiAlias,
	});
	if (!result.changed || !result.boundsRect) return null;

	const mask = new Uint8ClampedArray(image.width * image.height);
	const { boundsRect } = result;
	const maxY = boundsRect.y + boundsRect.height;
	const maxX = boundsRect.x + boundsRect.width;
	for (let py = boundsRect.y; py < maxY; py++) {
		for (let px = boundsRect.x; px < maxX; px++) {
			const offset = pixelOffset(image.width, px, py);
			if (
				scratch.data[offset] === marker[0] &&
				scratch.data[offset + 1] === marker[1] &&
				scratch.data[offset + 2] === marker[2]
			) {
				mask[py * image.width + px] = scratch.data[offset + 3];
			}
		}
	}
	return mask;
}

function activeMask(ctx: ToolContext): Uint8ClampedArray | null {
	if (ctx.mask.isEmpty()) return null;
	const mask = ctx.mask.cloneData();
	return mask.length === ctx.imageWidth * ctx.imageHeight ? mask : null;
}

function buildToneLayerPatch(
	width: number,
	height: number,
	mask: Uint8ClampedArray,
	region: PixelRegion,
	options: ScreentoneFillOptions,
): ImageData {
	const fullTone = makeImageData(new Uint8ClampedArray(width * height * 4), width, height);
	fillMaskWithTone(fullTone, new Uint8Array(mask), toneOptions(options));
	return sliceImageDataRegion(fullTone, region);
}

function hasVisiblePixels(image: ImageData): boolean {
	for (let offset = 3; offset < image.data.length; offset += 4) {
		if (image.data[offset] > 0) return true;
	}
	return false;
}

function alphaCompositePixel(dst: Uint8ClampedArray, dstOffset: number, src: Uint8ClampedArray, srcOffset: number): void {
	const srcA = src[srcOffset + 3] / 255;
	if (srcA <= 0) return;
	const dstA = dst[dstOffset + 3] / 255;
	const outA = srcA + dstA * (1 - srcA);
	if (outA <= 0) {
		dst[dstOffset] = 0;
		dst[dstOffset + 1] = 0;
		dst[dstOffset + 2] = 0;
		dst[dstOffset + 3] = 0;
		return;
	}
	for (let channel = 0; channel < 3; channel++) {
		dst[dstOffset + channel] = Math.round(
			(src[srcOffset + channel] * srcA + dst[dstOffset + channel] * dstA * (1 - srcA)) / outA,
		);
	}
	dst[dstOffset + 3] = Math.round(outA * 255);
}

function buildPreviewPatch(base: ImageData, layerPatch: ImageData, region: PixelRegion): ImageData {
	// applyToolPatchInstant uses putImageData, not alpha compositing. For the
	// transient preview we therefore pre-compose transparent tone pixels over the
	// original ROI so unfilled pixels do not erase the backing canvas.
	const preview = sliceImageDataRegion(base, region);
	for (let offset = 0; offset < layerPatch.data.length; offset += 4) {
		alphaCompositePixel(preview.data, offset, layerPatch.data, offset);
	}
	return preview;
}

function staleEpoch(ctx: ToolContext, expectedEpoch: number | undefined): boolean {
	return expectedEpoch !== undefined && ctx.host.getImageEpoch?.() !== expectedEpoch;
}

export function createScreentoneFillTool(
	initial: Partial<ScreentoneFillOptions> = {},
): EditorTool & ScreentoneFillApi {
	const options: ScreentoneFillOptions = { ...DEFAULT_OPTIONS, ...initial };
	let pending: Promise<void> = Promise.resolve();

	async function fillWithMask(
		ctx: ToolContext,
		full: ImageData,
		mask: Uint8ClampedArray,
		maskSource: "active-mask" | "flood",
		expectedEpoch: number | undefined,
	): Promise<void> {
		if (staleEpoch(ctx, expectedEpoch)) return;
		const region = computeMaskBounds(mask, ctx.imageWidth, ctx.imageHeight, 0);
		if (!region) return;

		const layerPatch = buildToneLayerPatch(ctx.imageWidth, ctx.imageHeight, mask, region, options);
		if (!hasVisiblePixels(layerPatch)) return;
		const previewPatch = buildPreviewPatch(full, layerPatch, region);
		const originalPatch = sliceImageDataRegion(full, region);
		const params = {
			toolId: "screentone-fill",
			source: maskSource,
			type: options.type,
			density: options.density,
			size: options.size,
			angle: options.angle,
			tolerance: options.tolerance,
		};

		if (typeof ctx.host.commitImageEditLayerPatch === "function") {
			const canPreview = typeof ctx.host.applyToolPatchInstant === "function";
			let previewApplied = false;
			if (canPreview) {
				previewApplied = ctx.host.applyToolPatchInstant!(
					previewPatch,
					region,
					expectedEpoch,
					{ preview: true },
				);
				if (!previewApplied && staleEpoch(ctx, expectedEpoch)) return;
			}
			const recorded = await ctx.host.commitImageEditLayerPatch({
				kind: "patch",
				patch: layerPatch,
				region,
				tool: { id: "background-edit", params },
			});
			if (!recorded && previewApplied) {
				ctx.host.applyToolPatchInstant!(
					originalPatch,
					region,
					expectedEpoch,
					{ preview: true, skipSnapshot: true },
				);
			}
			return;
		}
	}

	async function runFill(
		ctx: ToolContext,
		point: { x: number; y: number } | null,
		forceActiveMask: boolean,
		expectedEpoch: number | undefined,
	): Promise<void> {
		ctx.host.setToolBusy?.(true, DEFAULT_BUSY_LABEL);
		try {
			await nextFrame();
			if (staleEpoch(ctx, expectedEpoch)) return;
			const full = readSourceImageData(ctx.sourceElement, ctx.imageWidth, ctx.imageHeight);
			if (!full) return;
			const selected = options.useActiveMask || forceActiveMask ? activeMask(ctx) : null;
			if (selected) {
				await fillWithMask(ctx, full, selected, "active-mask", expectedEpoch);
				return;
			}
			if (!point) return;
			const mask = floodMaskFromPoint(full, point, options);
			if (!mask) return;
			await fillWithMask(ctx, full, mask, "flood", expectedEpoch);
		} finally {
			ctx.host.setToolBusy?.(false);
		}
	}

	function enqueue(
		ctx: ToolContext,
		point: { x: number; y: number } | null,
		forceActiveMask: boolean,
	): Promise<void> {
		const epoch = ctx.host.getImageEpoch?.();
		pending = pending
			.then(() => runFill(ctx, point, forceActiveMask, epoch))
			.catch((error) => {
				if (typeof console !== "undefined") console.error("[screentone-fill] fill failed:", error);
			});
		ctx.host.trackInstantToolCommit?.(pending);
		return pending;
	}

	const tool: EditorTool & ScreentoneFillApi = {
		id: "screentone-fill",
		label: "Screentone Fill",
		icon: "░",
		shortcut: getEditorShortcutForSuiteTool("screentone-fill"),
		kind: "paint",
		options,

		activate() {},
		deactivate() {},

		onPointerDown(ctx: ToolContext, event: ToolPointerEvent) {
			void enqueue(ctx, event.image, false);
		},
		onPointerMove() {},
		onPointerUp() {},

		fillAt(ctx: ToolContext, point: { x: number; y: number }) {
			return enqueue(ctx, point, false);
		},

		fillActiveMask(ctx: ToolContext) {
			return enqueue(ctx, null, true);
		},
	};

	return tool;
}
