/// <reference types="@sveltejs/kit" />

// Ambient module declaration for `magic-wand-tool` (no bundled types).
// Only the surface the image-edit suite (W3.13) uses is declared.
declare module "magic-wand-tool" {
	export interface MagicWandImage {
		data: Uint8Array | Uint8ClampedArray;
		width: number;
		height: number;
		bytes: number;
	}

	export interface MagicWandMaskBounds {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	}

	export interface MagicWandMask {
		data: Uint8Array;
		width: number;
		height: number;
		bounds: MagicWandMaskBounds;
	}

	export function floodFill(
		image: MagicWandImage,
		px: number,
		py: number,
		colorThreshold: number,
		mask?: Uint8Array | null,
		includeBorders?: boolean,
	): MagicWandMask | null;

	export function gaussBlur(mask: MagicWandMask, radius: number): MagicWandMask;
	export function gaussBlurOnlyBorder(
		mask: MagicWandMask,
		radius: number,
		visited?: Uint8Array | null,
	): MagicWandMask;

	const _default: {
		floodFill: typeof floodFill;
		gaussBlur: typeof gaussBlur;
		gaussBlurOnlyBorder: typeof gaussBlurOnlyBorder;
	};
	export default _default;
}
