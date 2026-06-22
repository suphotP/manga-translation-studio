// Tool 4 — Magic Wand (W).
//
// Click a pixel; flood-fill all connected pixels within a color tolerance
// (0..64 threshold slider). Uses the `magic-wand-tool` npm flood-fill, then
// composites the resulting region into the MaskBuffer with modifier semantics.
//
// The pure `floodFillSelection` core is exported separately so it can be unit
// tested without a DOM/canvas.

import MagicWand from "magic-wand-tool";
import { modeFromModifiers } from "./mask-buffer.js";
import { readSourceImageData } from "./raster.js";
import { renderSelectionOverlay } from "./selection-overlay.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

export interface MagicWandOptions {
	/** Color tolerance 0..64 (Photoshop-mirror). */
	threshold: number;
	/** Treat the selection as bounded by the flood region's borders. */
	includeBorders: boolean;
}

const DEFAULT_OPTIONS: MagicWandOptions = { threshold: 24, includeBorders: false };

/**
 * Pure flood-fill core. Given an RGBA image buffer + click coords + tolerance,
 * returns a full single-channel image-space mask (0/255). Testable headless.
 */
export function floodFillSelection(
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	px: number,
	py: number,
	threshold: number,
	includeBorders = false,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height);
	const x = Math.round(px);
	const y = Math.round(py);
	if (x < 0 || y < 0 || x >= width || y >= height) return out;
	const image = {
		data: rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length),
		width,
		height,
		bytes: 4,
	};
	const result = MagicWand.floodFill(image, x, y, clampThreshold(threshold), null, includeBorders);
	if (!result) return out;
	// magic-wand returns a tight `data` array of the FULL image dims (w*h), 0/1.
	const src = result.data;
	for (let i = 0; i < out.length && i < src.length; i++) out[i] = src[i] ? 255 : 0;
	return out;
}

function clampThreshold(t: number): number {
	if (!Number.isFinite(t)) return DEFAULT_OPTIONS.threshold;
	return Math.min(64, Math.max(0, Math.round(t)));
}

export function createMagicWandTool(initial: Partial<MagicWandOptions> = {}): EditorTool & {
	options: MagicWandOptions;
} {
	const options: MagicWandOptions = { ...DEFAULT_OPTIONS, ...initial };

	const tool: EditorTool & { options: MagicWandOptions } = {
		id: "magic-wand",
		label: "Magic Wand",
		icon: "✦",
		shortcut: "w",
		kind: "selection",
		options,

		activate() {},
		deactivate() {},

		onPointerDown(ctx: ToolContext, event: ToolPointerEvent) {
			const img = readSourceImageData(ctx.sourceElement, ctx.imageWidth, ctx.imageHeight);
			if (!img) return;
			const mask = floodFillSelection(
				img.data,
				ctx.imageWidth,
				ctx.imageHeight,
				event.image.x,
				event.image.y,
				options.threshold,
				options.includeBorders,
			);
			ctx.mask.composite(mask, modeFromModifiers(event));
			renderSelectionOverlay(ctx, ctx.mask);
		},

		onPointerMove() {},
		onPointerUp() {},
	};

	return tool;
}
