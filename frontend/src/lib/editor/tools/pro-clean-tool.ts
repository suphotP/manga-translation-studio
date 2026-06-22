// Tool — PRO Clean.
//
// This is the brush-facing adapter for the deterministic `editor-tools/pro-clean`
// engine. It mirrors the healing-brush gesture model but records a realized patch
// edit layer so the original page image stays intact.

import { proClean, type ProCleanOptions as ProCleanEngineOptions, type ProCleanResult } from "$lib/editor-tools/pro-clean.js";
import { getEditorShortcutForSuiteTool } from "$lib/editor-tools/keymap.js";
import {
	computeMaskBounds,
	cropMaskRegion,
	makeImageData,
	readSourceImageRegion,
	sliceImageDataRegion,
	stampSoftBrush,
	type PixelRegion,
} from "./raster.js";
import { createStrokePreview, type StrokePreview } from "./stroke-preview.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

/** Yield once so the busy chip can paint before CPU-bound local cleaning starts. */
function nextFrame(): Promise<void> {
	if (typeof requestAnimationFrame === "function") {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// Hand the main thread back so the UI can paint/handle input between bounded
// chunks of work (#6 freeze). setTimeout(0) is a macrotask, so the browser can
// repaint the busy chip + stay responsive; deterministic under the pro-clean
// tests' real timers (they drain via registry.waitForCommit()).
function yieldToMainThread(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export type ProCleanStrategyOverride = "auto" | "flat" | "texture";

export interface ProCleanToolOptions {
	/** Brush radius in image pixels. */
	radius: number;
	/** Blend strength for the cleaned pixels. 1 is full replace, 0 is no-op. */
	strength: number;
	/** User-facing strategy override; `texture` maps to the engine's screentone path. */
	strategy: ProCleanStrategyOverride;
	/** Restrict cleaning to the active selection mask when one exists. */
	respectSelection: boolean;
	/** Large ROIs are solved in local tiles to keep a single stroke from monopolising the UI. */
	tileSize: number;
	maxTilePixels: number;
	ringRadius?: number;
	patchSize?: number;
	patchMatchIterations?: number;
	diffusionIterations?: number;
	seed?: number;
}

export interface ProCleanToolApi {
	options: ProCleanToolOptions;
	/** Clean the current active selection mask directly, without a brush stroke. */
	cleanSelection(ctx: ToolContext): Promise<void>;
	setRadius(ctx: ToolContext, radius: number): void;
	setStrength(strength: number): void;
	setStrategy(strategy: ProCleanStrategyOverride): void;
}

interface CleanReceipt {
	tileCount: number;
	tiled: boolean;
	strategies: Record<string, number>;
	backgroundStrategies: Record<string, number>;
	limitations: string[];
}

interface CleanRun {
	patch: ImageData;
	receipt: CleanReceipt;
}

const DEFAULT_OPTIONS: ProCleanToolOptions = {
	radius: 18,
	strength: 1,
	strategy: "auto",
	respectSelection: true,
	tileSize: 512,
	maxTilePixels: 512 * 512,
	patchMatchIterations: 3,
};

function clampStrength(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(0, Math.min(1, value));
}

function clampPositiveInt(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.round(value));
}

function engineStrategy(strategy: ProCleanStrategyOverride): ProCleanEngineOptions["strategy"] {
	return strategy === "texture" ? "screentone" : strategy;
}

function cleanMargin(options: ProCleanToolOptions): number {
	const patchSize = clampPositiveInt(options.patchSize ?? 7, 7);
	const ring = clampPositiveInt(options.ringRadius ?? Math.max(12, patchSize * 2), 12);
	return Math.max(4, ring + patchSize + 2);
}

function engineOptions(options: ProCleanToolOptions): ProCleanEngineOptions {
	return {
		strategy: engineStrategy(options.strategy),
		ringRadius: options.ringRadius,
		patchSize: options.patchSize,
		patchMatchIterations: options.patchMatchIterations,
		diffusionIterations: options.diffusionIterations,
		seed: options.seed,
	};
}

function newReceipt(): CleanReceipt {
	return { tileCount: 0, tiled: false, strategies: {}, backgroundStrategies: {}, limitations: [] };
}

function addCount(map: Record<string, number>, key: string | null | undefined): void {
	if (!key) return;
	map[key] = (map[key] ?? 0) + 1;
}

function recordResult(receipt: CleanReceipt, result: ProCleanResult): void {
	receipt.tileCount += 1;
	addCount(receipt.strategies, result.strategy);
	addCount(receipt.backgroundStrategies, result.backgroundStrategy);
	for (const limitation of result.limitations) {
		if (!receipt.limitations.includes(limitation)) receipt.limitations.push(limitation);
	}
}

function hasMaskedPixel(mask: Uint8ClampedArray, width: number, region: PixelRegion): boolean {
	for (let y = region.y; y < region.y + region.height; y++) {
		const row = y * width;
		for (let x = region.x; x < region.x + region.width; x++) {
			if (mask[row + x] > 0) return true;
		}
	}
	return false;
}

function localRegionForCore(core: PixelRegion, bounds: PixelRegion, margin: number): PixelRegion {
	const x0 = Math.max(0, core.x - margin);
	const y0 = Math.max(0, core.y - margin);
	const x1 = Math.min(bounds.width, core.x + core.width + margin);
	const y1 = Math.min(bounds.height, core.y + core.height + margin);
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function blendCleanedInto(
	out: Uint8ClampedArray,
	base: ImageData,
	cleaned: ImageData,
	mask: Uint8ClampedArray,
	tile: PixelRegion,
	core: PixelRegion,
	strength: number,
): void {
	for (let y = core.y; y < core.y + core.height; y++) {
		for (let x = core.x; x < core.x + core.width; x++) {
			const baseIndex = y * base.width + x;
			const alpha = (mask[baseIndex] / 255) * strength;
			if (alpha <= 0) continue;
			const outOffset = baseIndex * 4;
			const tileX = x - tile.x;
			const tileY = y - tile.y;
			const cleanOffset = (tileY * tile.width + tileX) * 4;
			const inv = 1 - alpha;
			out[outOffset] = base.data[outOffset] * inv + cleaned.data[cleanOffset] * alpha;
			out[outOffset + 1] = base.data[outOffset + 1] * inv + cleaned.data[cleanOffset + 1] * alpha;
			out[outOffset + 2] = base.data[outOffset + 2] * inv + cleaned.data[cleanOffset + 2] * alpha;
			out[outOffset + 3] = base.data[outOffset + 3];
		}
	}
}

function cleanTile(
	base: ImageData,
	mask: Uint8ClampedArray,
	tile: PixelRegion,
	options: ProCleanToolOptions,
	receipt: CleanReceipt,
): ImageData {
	const tileImage = sliceImageDataRegion(base, tile);
	const tileMask = cropMaskRegion(mask, base.width, tile);
	const result = proClean(tileImage, new Uint8Array(tileMask), engineOptions(options));
	recordResult(receipt, result);
	return makeImageData(result.imageData.data, result.imageData.width, result.imageData.height);
}

async function runProClean(base: ImageData, mask: Uint8ClampedArray, options: ProCleanToolOptions): Promise<CleanRun> {
	const receipt = newReceipt();
	const strength = clampStrength(options.strength);
	const out = new Uint8ClampedArray(base.data);
	const tileSize = clampPositiveInt(options.tileSize, DEFAULT_OPTIONS.tileSize);
	const maxTilePixels = clampPositiveInt(options.maxTilePixels, DEFAULT_OPTIONS.maxTilePixels);
	const shouldTile = base.width * base.height > maxTilePixels || Math.max(base.width, base.height) > tileSize;
	if (!shouldTile) {
		// Single bounded region — one short solve, no need to yield.
		const result = proClean(base, new Uint8Array(mask), engineOptions(options));
		recordResult(receipt, result);
		const cleaned = makeImageData(result.imageData.data, result.imageData.width, result.imageData.height);
		blendCleanedInto(out, base, cleaned, mask, { x: 0, y: 0, width: base.width, height: base.height }, { x: 0, y: 0, width: base.width, height: base.height }, strength);
		return { patch: makeImageData(out, base.width, base.height), receipt };
	}

	receipt.tiled = true;
	const margin = cleanMargin(options);
	let processedTiles = 0;
	for (let y = 0; y < base.height; y += tileSize) {
		for (let x = 0; x < base.width; x += tileSize) {
			const core: PixelRegion = {
				x,
				y,
				width: Math.min(tileSize, base.width - x),
				height: Math.min(tileSize, base.height - y),
			};
			if (!hasMaskedPixel(mask, base.width, core)) continue;
			// FREEZE FIX (#6): a large pro-clean region is solved tile-by-tile with the
			// PatchMatch/diffusion solver. Running every tile back-to-back blocked the
			// main thread for the SUM of all tiles (the multi-second hang). Hand the
			// thread back between tiles so each bounded tile solve is a short block and
			// the busy chip + UI stay live. The first tile runs immediately (the busy
			// chip already painted via the caller's nextFrame).
			if (processedTiles > 0) await yieldToMainThread();
			processedTiles += 1;
			const tile = localRegionForCore(core, { x: 0, y: 0, width: base.width, height: base.height }, margin);
			const cleaned = cleanTile(base, mask, tile, options, receipt);
			blendCleanedInto(out, base, cleaned, mask, tile, core, strength);
		}
	}
	return { patch: makeImageData(out, base.width, base.height), receipt };
}

// Durable edit-layer patches composite verbatim at their bbox on reload/export,
// so the un-cleaned ROI margins (mask==0 pixels copied from the live composite)
// would cover earlier edit layers under the region (codex P2). The committed
// patch keeps only the blended mask>0 pixels; the preview still shows the full
// ROI for instant display.
function maskDurablePatch(patch: ImageData, regionMask: Uint8ClampedArray): ImageData {
	const out = new Uint8ClampedArray(patch.data);
	for (let i = 0; i < regionMask.length; i++) {
		if (regionMask[i] === 0) out[i * 4 + 3] = 0;
	}
	return makeImageData(out, patch.width, patch.height);
}

export function createProCleanTool(initial: Partial<ProCleanToolOptions> = {}): EditorTool & ProCleanToolApi {
	const options: ProCleanToolOptions = { ...DEFAULT_OPTIONS, ...initial };
	options.radius = clampPositiveInt(options.radius, DEFAULT_OPTIONS.radius);
	options.strength = clampStrength(options.strength);
	options.tileSize = clampPositiveInt(options.tileSize, DEFAULT_OPTIONS.tileSize);
	options.maxTilePixels = clampPositiveInt(options.maxTilePixels, DEFAULT_OPTIONS.maxTilePixels);

	let cleanMask: Uint8ClampedArray | null = null;
	let painting = false;
	let cursor: any = null;
	let preview: StrokePreview | null = null;
	let lastPoint: { x: number; y: number } | null = null;
	let lastHover: { x: number; y: number } | null = null;

	function ensureCleanMask(ctx: ToolContext): Uint8ClampedArray {
		if (!cleanMask || cleanMask.length !== ctx.imageWidth * ctx.imageHeight) {
			cleanMask = new Uint8ClampedArray(ctx.imageWidth * ctx.imageHeight);
		}
		return cleanMask;
	}

	function stampSegment(ctx: ToolContext, mask: Uint8ClampedArray, x: number, y: number): void {
		const from = lastPoint;
		if (from) {
			const dx = x - from.x;
			const dy = y - from.y;
			const dist = Math.hypot(dx, dy);
			const spacing = Math.max(1, options.radius / 4);
			const steps = Math.floor(dist / spacing);
			for (let i = 1; i <= steps; i++) {
				const t = i / (steps + 1);
				stampSoftBrush(mask, ctx.imageWidth, ctx.imageHeight, from.x + dx * t, from.y + dy * t, options.radius, 1, 255);
			}
		}
		stampSoftBrush(mask, ctx.imageWidth, ctx.imageHeight, x, y, options.radius, 1, 255);
		preview?.stamp({ x, y }, options.radius, from);
		lastPoint = { x, y };
	}

	function drawCursorAt(ctx: ToolContext, image: { x: number; y: number }): void {
		if (!ctx.fabric?.Circle) return;
		lastHover = { x: image.x, y: image.y };
		const center = ctx.imageToScene(image);
		const sceneRadius = ctx.imageLenToScene(options.radius);
		if (cursor) ctx.canvas.remove(cursor);
		cursor = new ctx.fabric.Circle({
			left: center.x - sceneRadius,
			top: center.y - sceneRadius,
			radius: sceneRadius,
			fill: "rgba(56,189,248,0.16)",
			stroke: "#38bdf8",
			strokeWidth: 1,
			selectable: false,
			evented: false,
			objectCaching: false,
		});
		ctx.canvas.add(cursor);
		ctx.requestRender();
	}

	function drawCursor(ctx: ToolContext, event: ToolPointerEvent): void {
		drawCursorAt(ctx, event.image);
	}

	function clearCursor(ctx: ToolContext): void {
		if (cursor && ctx.canvas?.remove) ctx.canvas.remove(cursor);
		cursor = null;
	}

	async function clean(ctx: ToolContext, mask: Uint8ClampedArray): Promise<void> {
		let effective = mask;
		if (options.respectSelection && !ctx.mask.isEmpty()) {
			effective = mask.slice();
			const selection = ctx.mask.data;
			for (let i = 0; i < effective.length; i++) {
				if (selection[i] === 0) effective[i] = 0;
			}
		}

		const margin = cleanMargin(options);
		const region = computeMaskBounds(effective, ctx.imageWidth, ctx.imageHeight, margin);
		if (!region) return;
		const sourceRegion = readSourceImageRegion(ctx.sourceElement, region, ctx.imageWidth, ctx.imageHeight);
		if (!sourceRegion) return;
		const regionMask = cropMaskRegion(effective, ctx.imageWidth, region);
		const epoch = ctx.host.getImageEpoch?.();
		const busyLabel = region.width * region.height > options.maxTilePixels ? "กำลังคลีนโปรพื้นที่ใหญ่" : "กำลังคลีนโปร";

		ctx.host.setToolBusy?.(true, busyLabel);
		try {
			await nextFrame();
			const { patch, receipt } = await runProClean(sourceRegion, regionMask, options);

			if (typeof ctx.host.commitImageEditLayerPatch === "function" && typeof ctx.host.applyToolPatchInstant === "function") {
				const previewApplied = ctx.host.applyToolPatchInstant(patch, region, epoch, { preview: true });
				if (!previewApplied) {
					if (epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch) return;
				} else {
					const recorded = await ctx.host.commitImageEditLayerPatch({
						kind: "patch",
						patch: maskDurablePatch(patch, regionMask),
						mask: effective,
						region,
						tool: {
							id: "background-edit",
							params: {
								toolId: "pro-clean",
								radius: options.radius,
								strength: options.strength,
								strategy: options.strategy,
								engineStrategy: engineStrategy(options.strategy),
								tiled: receipt.tiled,
								tileCount: receipt.tileCount,
								strategies: receipt.strategies,
								backgroundStrategies: receipt.backgroundStrategies,
								limitations: receipt.limitations,
							},
						},
					});
					if (!recorded) {
						ctx.host.applyToolPatchInstant(sourceRegion, region, epoch, { preview: true, skipSnapshot: true });
					}
					return;
				}
			}

			if (typeof ctx.host.applyToolPatchInstant === "function") {
				const applied = ctx.host.applyToolPatchInstant(patch, region, epoch);
				if (applied) return;
				if (epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch) return;
			}
		} finally {
			ctx.host.setToolBusy?.(false);
		}
	}

	const tool: EditorTool & ProCleanToolApi = {
		id: "pro-clean",
		label: "PRO Clean",
		icon: "✦",
		shortcut: getEditorShortcutForSuiteTool("pro-clean"),
		kind: "paint",
		options,

		activate() {},
		deactivate(ctx) {
			clearCursor(ctx);
			preview?.clear();
			preview = null;
			cleanMask = null;
			painting = false;
			lastPoint = null;
			lastHover = null;
		},

		onPointerDown(ctx: ToolContext, event: ToolPointerEvent) {
			painting = true;
			const mask = ensureCleanMask(ctx);
			mask.fill(0);
			lastPoint = null;
			preview?.clear();
			preview = createStrokePreview(ctx, { fillStyle: "rgba(56,189,248,0.82)", opacity: 0.4 });
			stampSegment(ctx, mask, event.image.x, event.image.y);
			drawCursor(ctx, event);
		},

		onPointerMove(ctx: ToolContext, event: ToolPointerEvent) {
			drawCursor(ctx, event);
			if (!painting || !cleanMask) return;
			stampSegment(ctx, cleanMask, event.image.x, event.image.y);
		},

		async onPointerUp(ctx: ToolContext, event: ToolPointerEvent) {
			if (!painting || !cleanMask) return;
			painting = false;
			stampSegment(ctx, cleanMask, event.image.x, event.image.y);
			lastPoint = null;
			const mask = cleanMask;
			cleanMask = null;
			try {
				await clean(ctx, mask);
			} finally {
				preview?.clear();
				preview = null;
			}
		},

		async cleanSelection(ctx: ToolContext) {
			if (ctx.mask.isEmpty()) return;
			await clean(ctx, ctx.mask.cloneData());
		},

		setRadius(ctx: ToolContext, radius: number) {
			options.radius = clampPositiveInt(radius, options.radius);
			if (lastHover) drawCursorAt(ctx, lastHover);
		},

		setStrength(strength: number) {
			options.strength = clampStrength(strength);
		},

		setStrategy(strategy: ProCleanStrategyOverride) {
			options.strategy = strategy;
		},
	};

	return tool;
}
