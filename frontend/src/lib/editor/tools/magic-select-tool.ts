// Magic Clean — one-click bubble clean driven by the shared magic-wand engine.
//
// This tool intentionally records a realized ROI patch instead of a fill-mask layer
// because the current host patch API is the same durable path used by healing.

import { getEditorShortcutForSuiteTool } from "$lib/editor-tools/keymap.js";
import { magicWandMask } from "$lib/editor-tools/magic-wand.js";
import {
	computeMaskBounds,
	makeImageData,
	readSourceImageData,
	sliceImageDataRegion,
	type PixelRegion,
} from "./raster.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

export type MagicCleanFillColor =
	| string
	| readonly [number, number, number, number?]
	| { r: number; g: number; b: number; a?: number };

export interface MagicSelectOptions {
	/** Magic-wand RGB tolerance. The engine clamps this to 0..255. */
	tolerance: number;
	/** Solid colour painted into the selected bubble interior. */
	fillColor: MagicCleanFillColor;
	/** Grow the wand mask to cover antialiasing / text halos before painting. */
	expandPx: number;
}

export interface RgbaFill {
	r: number;
	g: number;
	b: number;
	a: number;
}

const DEFAULT_OPTIONS: MagicSelectOptions = {
	tolerance: 24,
	fillColor: "#ffffff",
	expandPx: 2,
};

const BUSY_LABEL = "กำลังคลีนบับเบิล";
const MAX_EXPAND_PX = 64;

// Array.isArray's `arg is any[]` guard cannot exclude a readonly tuple from the
// union's else-branch, so the object branch below would not typecheck without
// this explicit predicate.
function isRgbaTuple(color: MagicCleanFillColor): color is readonly [number, number, number, number?] {
	return Array.isArray(color);
}

export function normalizeFillColor(fillColor: MagicCleanFillColor): RgbaFill {
	if (isRgbaTuple(fillColor)) {
		return {
			r: channel(fillColor[0]),
			g: channel(fillColor[1]),
			b: channel(fillColor[2]),
			a: channel(fillColor[3] ?? 255),
		};
	}
	if (typeof fillColor === "object" && fillColor !== null) {
		return {
			r: channel(fillColor.r),
			g: channel(fillColor.g),
			b: channel(fillColor.b),
			a: channel(fillColor.a ?? 255),
		};
	}
	const normalized = fillColor.trim().toLowerCase();
	if (normalized === "white") return { r: 255, g: 255, b: 255, a: 255 };
	if (normalized === "black") return { r: 0, g: 0, b: 0, a: 255 };
	const hex = normalized.startsWith("#") ? normalized.slice(1) : normalized;
	if (/^[0-9a-f]{3}$/i.test(hex)) {
		return {
			r: parseInt(hex[0] + hex[0], 16),
			g: parseInt(hex[1] + hex[1], 16),
			b: parseInt(hex[2] + hex[2], 16),
			a: 255,
		};
	}
	if (/^[0-9a-f]{6}$/i.test(hex)) {
		return {
			r: parseInt(hex.slice(0, 2), 16),
			g: parseInt(hex.slice(2, 4), 16),
			b: parseInt(hex.slice(4, 6), 16),
			a: 255,
		};
	}
	return { r: 255, g: 255, b: 255, a: 255 };
}

export function expandBinaryMask(
	mask: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
): Uint8ClampedArray {
	const r = normalizeExpandPx(radius);
	const out = new Uint8ClampedArray(width * height);
	if (width <= 0 || height <= 0 || mask.length < width * height) return out;
	if (r === 0) {
		for (let i = 0; i < out.length; i++) out[i] = mask[i] > 0 ? 255 : 0;
		return out;
	}
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (mask[row + x] === 0) continue;
			const x0 = Math.max(0, x - r);
			const y0 = Math.max(0, y - r);
			const x1 = Math.min(width - 1, x + r);
			const y1 = Math.min(height - 1, y + r);
			for (let yy = y0; yy <= y1; yy++) {
				const outRow = yy * width;
				for (let xx = x0; xx <= x1; xx++) out[outRow + xx] = 255;
			}
		}
	}
	return out;
}

export function buildMagicCleanMask(
	imageData: ImageData,
	x: number,
	y: number,
	options: Pick<MagicSelectOptions, "tolerance" | "expandPx">,
): Uint8ClampedArray {
	const wand = magicWandMask(imageData, x, y, options.tolerance, true, { fillHoles: true });
	return expandBinaryMask(wand.mask, imageData.width, imageData.height, options.expandPx);
}

export function paintFillPatch(
	base: ImageData,
	mask: Uint8ClampedArray,
	region: PixelRegion,
	fill: RgbaFill,
	transparentOutsideMask = false,
): ImageData {
	const out = new Uint8ClampedArray(region.width * region.height * 4);
	const src = base.data;
	for (let y = 0; y < region.height; y++) {
		const imageY = region.y + y;
		for (let x = 0; x < region.width; x++) {
			const imageX = region.x + x;
			const imageIndex = imageY * base.width + imageX;
			const srcOffset = imageIndex * 4;
			const outOffset = (y * region.width + x) * 4;
			if (mask[imageIndex] > 0) {
				out[outOffset] = fill.r;
				out[outOffset + 1] = fill.g;
				out[outOffset + 2] = fill.b;
				out[outOffset + 3] = fill.a;
			} else if (transparentOutsideMask) {
				// Durable patches must NOT carry opaque source pixels outside the
				// mask: the edit layer is composited verbatim at its bbox on
				// reload/export, so opaque margins would cover earlier edit layers
				// under the ROI (codex P2).
				out[outOffset + 3] = 0;
			} else {
				out[outOffset] = src[srcOffset];
				out[outOffset + 1] = src[srcOffset + 1];
				out[outOffset + 2] = src[srcOffset + 2];
				out[outOffset + 3] = src[srcOffset + 3];
			}
		}
	}
	return makeImageData(out, region.width, region.height);
}

function normalizeExpandPx(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_OPTIONS.expandPx;
	return Math.min(MAX_EXPAND_PX, Math.max(0, Math.round(value)));
}

function channel(value: number): number {
	if (!Number.isFinite(value)) return 255;
	return Math.min(255, Math.max(0, Math.round(value)));
}

async function cleanAt(ctx: ToolContext, event: ToolPointerEvent, options: MagicSelectOptions): Promise<void> {
	const base = readSourceImageData(ctx.sourceElement, ctx.imageWidth, ctx.imageHeight);
	if (!base) return;
	const mask = buildMagicCleanMask(base, event.image.x, event.image.y, options);
	const region = computeMaskBounds(mask, ctx.imageWidth, ctx.imageHeight, 0);
	if (!region) return;

	const fill = normalizeFillColor(options.fillColor);
	const patch = paintFillPatch(base, mask, region, fill);
	const durablePatch = paintFillPatch(base, mask, region, fill, true);
	const epoch = ctx.host.getImageEpoch?.();

	if (typeof ctx.host.applyToolPatchInstant === "function") {
		if (typeof ctx.host.commitImageEditLayerPatch === "function") {
			const original = sliceImageDataRegion(base, region);
			const previewApplied = ctx.host.applyToolPatchInstant(patch, region, epoch, { preview: true });
			if (!previewApplied) {
				if (epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch) return;
			} else {
				ctx.host.setToolBusy?.(true, BUSY_LABEL);
				try {
					const recorded = await ctx.host.commitImageEditLayerPatch({
						kind: "healing",
						patch: durablePatch,
						mask,
						region,
						tool: {
							id: "background-edit",
							params: {
								toolId: "magic-clean",
								tolerance: options.tolerance,
								expandPx: normalizeExpandPx(options.expandPx),
								fillColor: fill,
								selection: "magic-wand-fill-holes",
							},
						},
						algorithm: "telea",
						algorithmVersion: "magic-clean-1",
					});
					if (!recorded) {
						// A failed layer commit must not leave a preview that reload/export cannot reproduce.
						ctx.host.applyToolPatchInstant?.(original, region, epoch, {
							preview: true,
							skipSnapshot: true,
						});
					}
				} finally {
					ctx.host.setToolBusy?.(false);
				}
				return;
			}
		}

		const applied = ctx.host.applyToolPatchInstant(patch, region, epoch);
		if (applied) return;
		if (epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch) return;
	}
}

export function createMagicSelectTool(initial: Partial<MagicSelectOptions> = {}): EditorTool & {
	options: MagicSelectOptions;
} {
	const options: MagicSelectOptions = { ...DEFAULT_OPTIONS, ...initial };

	return {
		id: "magic-clean",
		label: "คลีนบับเบิล",
		icon: "✦",
		shortcut: getEditorShortcutForSuiteTool("magic-clean"),
		kind: "paint",
		options,

		activate() {},
		deactivate() {},
		onPointerDown() {},
		onPointerMove() {},
		onPointerUp(ctx: ToolContext, event: ToolPointerEvent) {
			return cleanAt(ctx, event, options);
		},
	};
}
