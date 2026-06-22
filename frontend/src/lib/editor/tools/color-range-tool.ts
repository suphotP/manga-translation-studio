// Tool 5 — Color Range / Select Similar (one-click near-white bubble interiors).
//
// Click anywhere; sample the pixel's HSL, then select every pixel (globally, not
// just connected) within configurable hue/saturation/lightness deltas. The
// default tolerances are tuned so a single click on a speech-bubble interior
// selects the whole near-white region across the page.
//
// HSL conversion mirrors image-js' colour model; the pure `selectColorRange`
// core is exported for headless unit testing.

import { modeFromModifiers } from "./mask-buffer.js";
import { readSourceImageData } from "./raster.js";
import { renderSelectionOverlay } from "./selection-overlay.js";
import { getEditorShortcutForSuiteTool } from "$lib/editor-tools/keymap.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

export interface ColorRangeOptions {
	/** Hue tolerance in degrees (0..180). */
	hue: number;
	/** Saturation tolerance 0..1. */
	saturation: number;
	/** Lightness tolerance 0..1. */
	lightness: number;
}

const DEFAULT_OPTIONS: ColorRangeOptions = { hue: 30, saturation: 0.18, lightness: 0.2 };

interface Hsl {
	h: number; // 0..360
	s: number; // 0..1
	l: number; // 0..1
}

/** Standard sRGB → HSL (matches image-js colour model). */
export function rgbToHsl(r: number, g: number, b: number): Hsl {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	const delta = max - min;
	if (delta !== 0) {
		s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
		switch (max) {
			case rn:
				h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
				break;
			case gn:
				h = ((bn - rn) / delta + 2) * 60;
				break;
			default:
				h = ((rn - gn) / delta + 4) * 60;
		}
	}
	return { h, s, l };
}

function hueDelta(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}

/**
 * Pure colour-range selector. Returns a full image-space single-channel mask
 * (0/255) of every pixel whose HSL is within tolerance of the sampled pixel.
 */
export function selectColorRange(
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	px: number,
	py: number,
	options: ColorRangeOptions = DEFAULT_OPTIONS,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(width * height);
	const x = Math.round(px);
	const y = Math.round(py);
	if (x < 0 || y < 0 || x >= width || y >= height) return out;
	const base = (y * width + x) * 4;
	const target = rgbToHsl(rgba[base], rgba[base + 1], rgba[base + 2]);
	const n = width * height;
	// For very low-saturation targets (near white/grey bubble interiors), hue is
	// unstable, so we rely mostly on lightness + saturation.
	const ignoreHue = target.s < 0.08;
	for (let i = 0; i < n; i++) {
		const o = i * 4;
		const px3 = rgbToHsl(rgba[o], rgba[o + 1], rgba[o + 2]);
		if (Math.abs(px3.l - target.l) > options.lightness) continue;
		if (Math.abs(px3.s - target.s) > options.saturation) continue;
		if (!ignoreHue && px3.s >= 0.08 && hueDelta(px3.h, target.h) > options.hue) continue;
		out[i] = 255;
	}
	return out;
}

export function createColorRangeTool(initial: Partial<ColorRangeOptions> = {}): EditorTool & {
	options: ColorRangeOptions;
} {
	const options: ColorRangeOptions = { ...DEFAULT_OPTIONS, ...initial };

	const tool: EditorTool & { options: ColorRangeOptions } = {
		id: "color-range",
		label: "Color Range / Select Similar",
		icon: "◐",
		shortcut: getEditorShortcutForSuiteTool("color-range"),
		kind: "selection",
		options,

		activate() {},
		deactivate() {},

		onPointerDown(ctx: ToolContext, event: ToolPointerEvent) {
			const img = readSourceImageData(ctx.sourceElement, ctx.imageWidth, ctx.imageHeight);
			if (!img) return;
			const mask = selectColorRange(
				img.data,
				ctx.imageWidth,
				ctx.imageHeight,
				event.image.x,
				event.image.y,
				options,
			);
			ctx.mask.composite(mask, modeFromModifiers(event));
			renderSelectionOverlay(ctx, ctx.mask);
		},

		onPointerMove() {},
		onPointerUp() {},
	};

	return tool;
}
