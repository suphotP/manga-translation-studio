// Bucket Fill (G) — click a pixel, flood-fill matching pixels, then record the
// result as a small realized edit layer instead of baking a full page image.

import {
	floodFillChunked,
	type FloodFillOptions,
	type RgbaColor,
} from "../../editor-tools/flood-fill.js";
import { getEditorShortcutForDockTool, getEditorShortcutForSuiteTool } from "../../editor-tools/keymap.js";
import {
	makeImageData,
	readSourceImageData,
	sliceImageDataRegion,
	type PixelRegion,
} from "./raster.js";
import type { EditorTool, EditorToolHost, ToolContext, ToolPointerEvent } from "./types.js";
import type { ToolDefinition } from "../tool-registry.svelte.js";

const DEFAULT_FILL_COLOR: RgbaColor = [255, 255, 255, 255];

export interface BucketFillOptions {
	/** Max per-channel distance from the clicked seed colour. */
	tolerance: number;
	/** Fill only the connected area, or every matching pixel in the image. */
	contiguous: boolean;
	/** Feather the outer tolerance band for anti-aliased borders. */
	antiAlias: boolean;
	/** RGBA fill colour in image pixels. */
	fillColor: RgbaColor;
}

export interface BucketFillApi {
	options: BucketFillOptions;
	setFillColor(color: RgbaColor): void;
	setTolerance(value: number): void;
}

const DEFAULT_OPTIONS: BucketFillOptions = {
	tolerance: 0,
	contiguous: true,
	antiAlias: false,
	fillColor: DEFAULT_FILL_COLOR,
};
const BUCKET_FILL_YIELD_EVERY_PIXELS = 512 * 1024;

type CommitImageEditLayerPatchInput = Parameters<
	NonNullable<EditorToolHost["commitImageEditLayerPatch"]>
>[0];

function nextFrame(): Promise<void> {
	if (typeof requestAnimationFrame === "function") {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}
	return Promise.resolve();
}

async function yieldToMainThread(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function normalizeColor(color: RgbaColor): RgbaColor {
	return [
		clampByte(color[0]),
		clampByte(color[1]),
		clampByte(color[2]),
		clampByte(color[3]),
	];
}

function clampByte(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	if (value >= 255) return 255;
	return Math.round(value);
}

function normalizeOptions(options: BucketFillOptions): Required<Pick<FloodFillOptions, "tolerance" | "contiguous" | "antiAlias">> {
	return {
		tolerance: Math.max(0, Math.min(255, Math.round(options.tolerance))),
		contiguous: options.contiguous,
		antiAlias: options.antiAlias,
	};
}

function bucketFillParams(options: BucketFillOptions): Record<string, unknown> {
	return {
		...normalizeOptions(options),
		fillColor: Array.from(normalizeColor(options.fillColor)),
	};
}

function makePatchCommitInput(
	patch: ImageData,
	region: PixelRegion,
	options: BucketFillOptions,
): CommitImageEditLayerPatchInput {
	return {
		kind: "patch",
		patch,
		region,
		// The shared host type predates this tool and still narrows patch tool ids to
		// brush/heal/clone/background-edit. Keep this task self-contained while still
		// recording the real runtime producer id for undo/export attribution.
		tool: { id: "bucket-fill", params: bucketFillParams(options) },
	} as unknown as CommitImageEditLayerPatchInput;
}

interface BucketPatchSet {
	previewPatch: ImageData | null;
	durablePatch: ImageData;
	changedPixels: number;
}

// Preview patches are putImageData'd onto the mutable backing canvas, so they
// need the full filled ROI. Durable edit-layer patches are composited on
// reload/export, so unchanged pixels must stay transparent or they hide earlier
// edit layers. Build both in one region scan instead of slicing/diffing the same
// large ROI three times.
async function buildBucketPatchSet(
	base: ImageData,
	filled: ImageData,
	region: PixelRegion,
	changedMask: Uint8Array | undefined,
	includePreview: boolean,
): Promise<BucketPatchSet> {
	const regionPixels = region.width * region.height;
	const previewOut = includePreview ? new Uint8ClampedArray(regionPixels * 4) : null;
	let durableOut: Uint8ClampedArray | null = new Uint8ClampedArray(regionPixels * 4);
	const src = base.data;
	const dst = filled.data;
	let changedPixels = 0;
	let processed = 0;

	for (let y = 0; y < region.height; y++) {
		const imageRow = (region.y + y) * base.width + region.x;
		const outRow = y * region.width;
		for (let x = 0; x < region.width; x++) {
			const imageIndex = imageRow + x;
			const si = imageIndex * 4;
			const oi = (outRow + x) * 4;
			const r = dst[si];
			const g = dst[si + 1];
			const b = dst[si + 2];
			const a = dst[si + 3];
			if (previewOut) {
				previewOut[oi] = r;
				previewOut[oi + 1] = g;
				previewOut[oi + 2] = b;
				previewOut[oi + 3] = a;
			}

			const changed = changedMask
				? changedMask[imageIndex] !== 0
				: r !== src[si] || g !== src[si + 1] || b !== src[si + 2] || a !== src[si + 3];
			if (changed) {
				changedPixels++;
				durableOut[oi] = r;
				durableOut[oi + 1] = g;
				durableOut[oi + 2] = b;
				durableOut[oi + 3] = a;
			}
		}
		processed += region.width;
		if (processed >= BUCKET_FILL_YIELD_EVERY_PIXELS) {
			processed = 0;
			await yieldToMainThread();
		}
	}

	const previewPatch = previewOut ? makeImageData(previewOut, region.width, region.height) : null;
	if (previewPatch && changedPixels === regionPixels) {
		durableOut = null;
		return { previewPatch, durablePatch: previewPatch, changedPixels };
	}
	return {
		previewPatch,
		durablePatch: makeImageData(durableOut, region.width, region.height),
		changedPixels,
	};
}

async function applyBucketFill(
	ctx: ToolContext,
	imageX: number,
	imageY: number,
	options: BucketFillOptions,
	epoch: number | undefined,
): Promise<void> {
	ctx.host.setToolBusy?.(true, "กำลังเตรียม Bucket Fill");
	try {
		// Let the busy chip paint before the synchronous full-image flood fill starts.
		await nextFrame();

		const base = readSourceImageData(ctx.sourceElement, ctx.imageWidth, ctx.imageHeight);
		if (!base) return;

		ctx.host.setToolBusy?.(true, "กำลังคำนวณ Bucket Fill");
		const filled = makeImageData(new Uint8ClampedArray(base.data), ctx.imageWidth, ctx.imageHeight);
		const fillResult = await floodFillChunked(filled, imageX, imageY, normalizeColor(options.fillColor), {
			...normalizeOptions(options),
			collectChangedMask: true,
			yieldEveryPixels: BUCKET_FILL_YIELD_EVERY_PIXELS,
		});
		if (!fillResult.changed || !fillResult.boundsRect) return;

		const region = fillResult.boundsRect as PixelRegion;

		if (typeof ctx.host.commitImageEditLayerPatch === "function") {
			ctx.host.setToolBusy?.(true, "กำลังเตรียมแพตช์ Bucket Fill");
			const patches = await buildBucketPatchSet(
				base,
				filled,
				region,
				fillResult.changedMask,
				typeof ctx.host.applyToolPatchInstant === "function",
			);
			if (patches.changedPixels <= 0) return;

			let previewApplied = false;
			if (patches.previewPatch && typeof ctx.host.applyToolPatchInstant === "function") {
				previewApplied = ctx.host.applyToolPatchInstant(patches.previewPatch, region, epoch, { preview: true });
				if (!previewApplied && epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch) return;
			}

			ctx.host.setToolBusy?.(true, "กำลังบันทึก Bucket Fill");
			const recorded = await ctx.host.commitImageEditLayerPatch(
				makePatchCommitInput(patches.durablePatch, region, options),
			);
			if (!recorded && previewApplied) {
				const originalPatch = sliceImageDataRegion(base, region);
				ctx.host.applyToolPatchInstant?.(originalPatch, region, epoch, {
					preview: true,
					skipSnapshot: true,
				});
			}
			return;
		}
	} finally {
		ctx.host.setToolBusy?.(false);
	}
}

export function createBucketFillTool(initial: Partial<BucketFillOptions> = {}): EditorTool & BucketFillApi {
	const options: BucketFillOptions = {
		...DEFAULT_OPTIONS,
		...initial,
		fillColor: normalizeColor(initial.fillColor ?? DEFAULT_OPTIONS.fillColor),
	};
	let click: { x: number; y: number; epoch: number | undefined } | null = null;

	const tool: EditorTool & BucketFillApi = {
		id: "bucket-fill",
		label: "ถังสี",
		icon: "▰",
		shortcut: getEditorShortcutForSuiteTool("bucket-fill"),
		kind: "paint",
		options,

		activate() {},
		deactivate() {
			click = null;
		},
		onPointerDown(ctx: ToolContext, event: ToolPointerEvent) {
			click = { x: event.image.x, y: event.image.y, epoch: ctx.host.getImageEpoch?.() };
		},
		onPointerMove() {},
		async onPointerUp(ctx: ToolContext, event: ToolPointerEvent) {
			const target = click ?? { x: event.image.x, y: event.image.y, epoch: ctx.host.getImageEpoch?.() };
			click = null;
			await applyBucketFill(ctx, target.x, target.y, options, target.epoch);
		},

		setFillColor(color: RgbaColor) {
			options.fillColor = normalizeColor(color);
		},
		setTolerance(value: number) {
			options.tolerance = Math.max(0, Math.min(255, Math.round(value)));
		},
	};

	return tool;
}

export const BUCKET_FILL_DOCK_TOOL = {
	id: "bucket-fill",
	label: "ถังสี",
	title: "ถังสี: คลิกเพื่อเติมพื้นที่สีใกล้เคียง",
	icon: "▰",
	shortcut: getEditorShortcutForDockTool("bucket-fill"),
	engineTool: "select",
	optionsContext: "image-tools",
	group: "image",
	capability: "canClean",
	order: 5.5,
	onActivate: (ctx) => ctx.activateImageTool("bucket-fill"),
} satisfies ToolDefinition;
