// Tool - Adjustments (brightness/contrast, levels, HSL).
//
// This tool is intentionally driven by explicit API calls (`preview`, `commit`,
// `cancel`) instead of pointer gestures. Region selection stays owned by the
// existing selection tools; this tool consumes the active image-space mask, or
// falls back to the whole page when nothing is selected.

import {
	adjustHsl,
	applyLutRgb,
	buildBrightnessContrastLut,
	buildLevelsLut,
	type HslAdjustment,
} from "$lib/editor-tools/adjustments.js";
import {
	computeMaskBounds,
	cropMaskRegion,
	makeImageData,
	readSourceImageRegion,
	type PixelRegion,
} from "./raster.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

export const ADJUSTMENTS_TOOL_ID = "adjustments" as const;
const BUSY_LABEL = "กำลังปรับแสงสี";

export interface LevelsAdjustmentOptions {
	inBlack: number;
	inWhite: number;
	gamma: number;
	outBlack: number;
	outWhite: number;
}

export interface AdjustmentsToolOptions {
	brightness: number;
	contrast: number;
	levels: LevelsAdjustmentOptions;
	hsl: Required<HslAdjustment>;
}

export interface AdjustmentsToolApi {
	options: AdjustmentsToolOptions;
	/** Update options from sliders and render a transient non-destructive preview. */
	preview(ctx: ToolContext, next?: PartialAdjustmentsToolOptions): boolean;
	/** Commit the current preview/options as one edit operation. */
	commit(ctx: ToolContext, next?: PartialAdjustmentsToolOptions): Promise<boolean>;
	/** Revert the transient preview without recording an edit. */
	cancel(ctx: ToolContext): boolean;
	/** Convenience entry point for slider owners; previews by default. */
	setOptions(ctx: ToolContext, next: PartialAdjustmentsToolOptions, shouldPreview?: boolean): boolean;
}

export type PartialAdjustmentsToolOptions = Partial<
	Omit<AdjustmentsToolOptions, "levels" | "hsl">
> & {
	levels?: Partial<LevelsAdjustmentOptions>;
	hsl?: HslAdjustment;
};

const DEFAULT_LEVELS: LevelsAdjustmentOptions = {
	inBlack: 0,
	inWhite: 255,
	gamma: 1,
	outBlack: 0,
	outWhite: 255,
};

const DEFAULT_HSL: Required<HslAdjustment> = {
	hue: 0,
	saturation: 0,
	lightness: 0,
};

const DEFAULT_OPTIONS: AdjustmentsToolOptions = {
	brightness: 0,
	contrast: 0,
	levels: { ...DEFAULT_LEVELS },
	hsl: { ...DEFAULT_HSL },
};

interface SelectionScope {
	region: PixelRegion;
	maskRoi: Uint8ClampedArray | null;
}

interface PreviewState extends SelectionScope {
	epoch: number | undefined;
	/** Composited ROI (incl. edit layers) — the LUT INPUT only. */
	base: ImageData;
	/**
	 * BASE backing ROI (sourceElement, NO edit layers) — what cancel/reset must
	 * write back. Restoring the composited sample would bake edit-layer pixels
	 * into the background canvas while the overlay re-renders above them
	 * (codex P1).
	 */
	restoreBase: ImageData;
	applied: boolean;
}

function nextFrame(): Promise<void> {
	if (typeof requestAnimationFrame === "function") {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function finiteNumber(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) ? value as number : fallback;
}

function cloneOptions(options: AdjustmentsToolOptions): AdjustmentsToolOptions {
	return {
		brightness: options.brightness,
		contrast: options.contrast,
		levels: { ...options.levels },
		hsl: { ...options.hsl },
	};
}

function mergeOptions(
	current: AdjustmentsToolOptions,
	next: PartialAdjustmentsToolOptions | undefined,
): AdjustmentsToolOptions {
	if (!next) return cloneOptions(current);
	return {
		brightness: finiteNumber(next.brightness, current.brightness),
		contrast: finiteNumber(next.contrast, current.contrast),
		levels: {
			inBlack: finiteNumber(next.levels?.inBlack, current.levels.inBlack),
			inWhite: finiteNumber(next.levels?.inWhite, current.levels.inWhite),
			gamma: finiteNumber(next.levels?.gamma, current.levels.gamma),
			outBlack: finiteNumber(next.levels?.outBlack, current.levels.outBlack),
			outWhite: finiteNumber(next.levels?.outWhite, current.levels.outWhite),
		},
		hsl: {
			hue: finiteNumber(next.hsl?.hue, current.hsl.hue),
			saturation: finiteNumber(next.hsl?.saturation, current.hsl.saturation),
			lightness: finiteNumber(next.hsl?.lightness, current.hsl.lightness),
		},
	};
}

function replaceOptions(target: AdjustmentsToolOptions, source: AdjustmentsToolOptions): void {
	target.brightness = source.brightness;
	target.contrast = source.contrast;
	target.levels.inBlack = source.levels.inBlack;
	target.levels.inWhite = source.levels.inWhite;
	target.levels.gamma = source.levels.gamma;
	target.levels.outBlack = source.levels.outBlack;
	target.levels.outWhite = source.levels.outWhite;
	target.hsl.hue = source.hsl.hue;
	target.hsl.saturation = source.hsl.saturation;
	target.hsl.lightness = source.hsl.lightness;
}

function isNeutral(options: AdjustmentsToolOptions): boolean {
	return options.brightness === 0
		&& options.contrast === 0
		&& options.levels.inBlack === DEFAULT_LEVELS.inBlack
		&& options.levels.inWhite === DEFAULT_LEVELS.inWhite
		&& options.levels.gamma === DEFAULT_LEVELS.gamma
		&& options.levels.outBlack === DEFAULT_LEVELS.outBlack
		&& options.levels.outWhite === DEFAULT_LEVELS.outWhite
		&& options.hsl.hue === 0
		&& options.hsl.saturation === 0
		&& options.hsl.lightness === 0;
}

function sameRegion(a: PixelRegion, b: PixelRegion): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameMask(a: Uint8ClampedArray | null, b: Uint8ClampedArray | null): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function masksMatchImage(ctx: ToolContext): boolean {
	return ctx.mask.width === ctx.imageWidth && ctx.mask.height === ctx.imageHeight;
}

function resolveScope(ctx: ToolContext): SelectionScope | null {
	if (ctx.imageWidth <= 0 || ctx.imageHeight <= 0) return null;
	if (masksMatchImage(ctx) && !ctx.mask.isEmpty()) {
		const region = computeMaskBounds(ctx.mask.data, ctx.imageWidth, ctx.imageHeight);
		if (!region) return null;
		return {
			region,
			maskRoi: cropMaskRegion(ctx.mask.data, ctx.imageWidth, region),
		};
	}
	return {
		region: { x: 0, y: 0, width: ctx.imageWidth, height: ctx.imageHeight },
		maskRoi: null,
	};
}

function applyAdjustments(base: ImageData, options: AdjustmentsToolOptions): ImageData {
	const adjusted = makeImageData(new Uint8ClampedArray(base.data), base.width, base.height);
	if (options.brightness !== 0 || options.contrast !== 0) {
		applyLutRgb(adjusted, buildBrightnessContrastLut(options.brightness, options.contrast), { inPlace: true });
	}
	if (
		options.levels.inBlack !== DEFAULT_LEVELS.inBlack
		|| options.levels.inWhite !== DEFAULT_LEVELS.inWhite
		|| options.levels.gamma !== DEFAULT_LEVELS.gamma
		|| options.levels.outBlack !== DEFAULT_LEVELS.outBlack
		|| options.levels.outWhite !== DEFAULT_LEVELS.outWhite
	) {
		applyLutRgb(
			adjusted,
			buildLevelsLut(
				options.levels.inBlack,
				options.levels.inWhite,
				options.levels.gamma,
				options.levels.outBlack,
				options.levels.outWhite,
			),
			{ inPlace: true },
		);
	}
	if (options.hsl.hue !== 0 || options.hsl.saturation !== 0 || options.hsl.lightness !== 0) {
		adjustHsl(adjusted, options.hsl, { inPlace: true });
	}
	return adjusted;
}

function buildPreviewPatch(base: ImageData, adjusted: ImageData, maskRoi: Uint8ClampedArray | null): ImageData {
	if (!maskRoi) return makeImageData(new Uint8ClampedArray(adjusted.data), base.width, base.height);
	const out = new Uint8ClampedArray(base.data);
	for (let i = 0; i < maskRoi.length; i += 1) {
		const alpha = maskRoi[i] / 255;
		if (alpha <= 0) continue;
		const offset = i * 4;
		if (alpha >= 1) {
			out[offset] = adjusted.data[offset];
			out[offset + 1] = adjusted.data[offset + 1];
			out[offset + 2] = adjusted.data[offset + 2];
			out[offset + 3] = base.data[offset + 3];
			continue;
		}
		// putImageData overwrites pixels instead of compositing, so feathered preview
		// pixels must be pre-blended against the original ROI.
		out[offset] = Math.round(base.data[offset] * (1 - alpha) + adjusted.data[offset] * alpha);
		out[offset + 1] = Math.round(base.data[offset + 1] * (1 - alpha) + adjusted.data[offset + 1] * alpha);
		out[offset + 2] = Math.round(base.data[offset + 2] * (1 - alpha) + adjusted.data[offset + 2] * alpha);
		out[offset + 3] = base.data[offset + 3];
	}
	return makeImageData(out, base.width, base.height);
}

function buildLayerPatch(base: ImageData, adjusted: ImageData, maskRoi: Uint8ClampedArray | null): ImageData {
	if (!maskRoi) return makeImageData(new Uint8ClampedArray(adjusted.data), base.width, base.height);
	const out = new Uint8ClampedArray(adjusted.data);
	for (let i = 0; i < maskRoi.length; i += 1) {
		const offset = i * 4;
		const alpha = maskRoi[i] / 255;
		if (alpha <= 0) {
			out[offset] = 0;
			out[offset + 1] = 0;
			out[offset + 2] = 0;
			out[offset + 3] = 0;
			continue;
		}
		// Durable patch layers are drawn as normal images over the base page. Keeping
		// only mask alpha here prevents unselected ROI pixels from hiding lower edits.
		out[offset + 3] = Math.round(base.data[offset + 3] * alpha);
	}
	return makeImageData(out, base.width, base.height);
}

function staleEpoch(ctx: ToolContext, epoch: number | undefined): boolean {
	return epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch;
}

function readAdjustmentSourceRegion(ctx: ToolContext, region: PixelRegion): ImageData | null {
	const readComposite = ctx.host.readCompositedImageRegion;
	if (typeof readComposite === "function") {
		return readComposite.call(ctx.host, region);
	}
	return readSourceImageRegion(ctx.sourceElement, region, ctx.imageWidth, ctx.imageHeight);
}

function patchParams(options: AdjustmentsToolOptions): Record<string, unknown> {
	return {
		toolId: ADJUSTMENTS_TOOL_ID,
		brightness: options.brightness,
		contrast: options.contrast,
		levels: { ...options.levels },
		hsl: { ...options.hsl },
	};
}

export function createAdjustmentsTool(
	initial: PartialAdjustmentsToolOptions = {},
): EditorTool & AdjustmentsToolApi {
	const options = mergeOptions(DEFAULT_OPTIONS, initial);
	let previewState: PreviewState | null = null;

	function clearPreviewState(): void {
		previewState = null;
	}

	function cancel(ctx: ToolContext): boolean {
		const state = previewState;
		clearPreviewState();
		if (!state?.applied || typeof ctx.host.applyToolPatchInstant !== "function") return false;
		return ctx.host.applyToolPatchInstant(state.restoreBase, state.region, state.epoch, {
			preview: true,
			skipSnapshot: true,
		});
	}

	function ensurePreviewState(ctx: ToolContext): PreviewState | null {
		const scope = resolveScope(ctx);
		if (!scope) return null;
		const epoch = ctx.host.getImageEpoch?.();
		const reusable = previewState
			&& previewState.epoch === epoch
			&& sameRegion(previewState.region, scope.region)
			&& sameMask(previewState.maskRoi, scope.maskRoi);
		if (reusable) return previewState;

		if (previewState) cancel(ctx);
		const base = readAdjustmentSourceRegion(ctx, scope.region);
		if (!base) return null;
		const restoreBase = readSourceImageRegion(ctx.sourceElement, scope.region, ctx.imageWidth, ctx.imageHeight);
		if (!restoreBase) return null;
		previewState = {
			...scope,
			epoch,
			base,
			restoreBase,
			applied: false,
		};
		return previewState;
	}

	function renderPreview(ctx: ToolContext, next?: PartialAdjustmentsToolOptions): boolean {
		const merged = mergeOptions(options, next);
		replaceOptions(options, merged);
		if (isNeutral(options)) return cancel(ctx);
		if (typeof ctx.host.applyToolPatchInstant !== "function") return false;
		const state = ensurePreviewState(ctx);
		if (!state) return false;
		const adjusted = applyAdjustments(state.base, options);
		const previewPatch = buildPreviewPatch(state.base, adjusted, state.maskRoi);
		const applied = ctx.host.applyToolPatchInstant(previewPatch, state.region, state.epoch, { preview: true });
		if (!applied && staleEpoch(ctx, state.epoch)) clearPreviewState();
		state.applied = applied;
		return applied;
	}

	async function commitInternal(ctx: ToolContext, next?: PartialAdjustmentsToolOptions): Promise<boolean> {
		const merged = mergeOptions(options, next);
		replaceOptions(options, merged);
		if (isNeutral(options)) {
			cancel(ctx);
			return false;
		}

		const state = ensurePreviewState(ctx);
		if (!state) return false;
		if (staleEpoch(ctx, state.epoch)) {
			clearPreviewState();
			return false;
		}

		const adjusted = applyAdjustments(state.base, options);
		const previewPatch = buildPreviewPatch(state.base, adjusted, state.maskRoi);
		const layerPatch = buildLayerPatch(state.base, adjusted, state.maskRoi);
		const canPreview = typeof ctx.host.applyToolPatchInstant === "function";

		if (canPreview && !state.applied) {
			state.applied = ctx.host.applyToolPatchInstant!(previewPatch, state.region, state.epoch, { preview: true });
			if (!state.applied && staleEpoch(ctx, state.epoch)) {
				clearPreviewState();
				return false;
			}
		}

		if (canPreview && state.applied && typeof ctx.host.commitImageEditLayerPatch === "function") {
			ctx.host.setToolBusy?.(true, BUSY_LABEL);
			try {
				await nextFrame();
				const recorded = await ctx.host.commitImageEditLayerPatch({
					kind: "patch",
					patch: layerPatch,
					region: state.region,
					tool: {
						// The shared host type only admits background-edit for generic patch
						// operations, so the concrete adjustments id is preserved in params.
						id: "background-edit",
						params: patchParams(options),
					},
				});
				if (recorded) {
					clearPreviewState();
					return true;
				}
				cancel(ctx);
				return false;
			} finally {
				ctx.host.setToolBusy?.(false);
			}
		}

		clearPreviewState();
		return false;
	}

	function commit(ctx: ToolContext, next?: PartialAdjustmentsToolOptions): Promise<boolean> {
		const pending = commitInternal(ctx, next);
		// Slider-confirm commits are triggered outside pointer-up, so register them
		// with the same navigation/teardown drain used by discrete instant tools.
		ctx.host.trackInstantToolCommit?.(pending.then(() => undefined, () => undefined));
		return pending;
	}

	function setOptions(
		ctx: ToolContext,
		next: PartialAdjustmentsToolOptions,
		shouldPreview = true,
	): boolean {
		const merged = mergeOptions(options, next);
		replaceOptions(options, merged);
		return shouldPreview ? renderPreview(ctx) : true;
	}

	const tool: EditorTool & AdjustmentsToolApi = {
		id: ADJUSTMENTS_TOOL_ID,
		label: "ปรับแสงสี",
		icon: "◑",
		kind: "paint",
		options,

		activate() {},
		deactivate(ctx) {
			cancel(ctx);
		},
		onPointerDown() {},
		onPointerMove() {},
		onPointerUp(_ctx: ToolContext, _event: ToolPointerEvent) {},
		preview: renderPreview,
		commit,
		cancel,
		setOptions,
	};

	return tool;
}
