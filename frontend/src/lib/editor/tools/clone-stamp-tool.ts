// Tool 8 — Clone Stamp (S) — pure canvas, no OpenCV.
//
// Alt+click sets the clone SOURCE anchor. Dragging stamps pixels through the
// shared clone-stamp engine, then records one realized edit-layer patch when the
// host supports non-destructive edits.

import {
	beginCloneStampStroke,
	createCloneStampState,
	endCloneStampStroke,
	setCloneStampSource,
	sourcePointForCloneStampTarget,
	stampStroke,
	type CloneStampBrush,
	type CloneStampMode,
	type CloneStampStrokeState,
} from "$lib/editor-tools/clone-stamp.js";
import {
	createWorkCanvas,
	makeImageData,
	readSourceImageData,
	readSourceImageDataCached,
	readSourceImageRegion,
	stampSoftBrush,
	type PixelRegion,
} from "./raster.js";
import { createStrokePreview, type StrokePreview } from "./stroke-preview.js";
import type { EditorTool, ImagePoint, ToolContext, ToolPointerEvent } from "./types.js";

interface RasterImage {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

export interface CloneStampOptions {
	/** Brush radius in image pixels. Kept for the existing `[`/`]` radius control. */
	radius: number;
	/** Optional brush diameter in image pixels; when omitted it derives from radius. */
	size?: number;
	/** 0 = fully feathered edge, 1 = hard disc. */
	hardness: number;
	/** 0..1 brush opacity, applied by the clone-stamp engine. */
	opacity: number;
	/** Aligned keeps the sampled source offset across strokes; non-aligned restarts at the source. */
	mode: CloneStampMode;
	/** Restrict clone painting to the active selection mask when one exists. */
	respectSelection: boolean;
}

const DEFAULT_OPTIONS: CloneStampOptions = {
	radius: 18,
	hardness: 0.8,
	opacity: 1,
	mode: "aligned",
	respectSelection: true,
};
const SOURCE_CLICK_TOLERANCE_PX = 2;
const SOURCE_HINT_SET = "ตั้งต้นทาง Clone แล้ว ลากเพื่อปั๊ม";
const SOURCE_HINT_MISSING = "ตั้งต้นทางก่อน: Alt-click หรือคลิกจุดต้นทาง";

export interface CloneStampApi {
	options: CloneStampOptions;
	/**
	 * Live-set the brush radius (rec #5: `[`/`]` resize). Updates the option and
	 * redraws the size cursor (+ source ghost) at the last hovered point.
	 */
	setRadius(ctx: ToolContext, radius: number): void;
}

export function createCloneStampTool(initial: Partial<CloneStampOptions> = {}): EditorTool & CloneStampApi {
	const options: CloneStampOptions = normalizeOptions(initial);
	const state = createCloneStampState(options.mode);

	let painting = false;
	let stroke: CloneStampStrokeState | null = null;
	// Capture the backing-canvas epoch when the stroke starts. If the page/image
	// changes before commit, the host rejects the stale patch and we do not fall
	// through to a wrong-page legacy commit.
	let strokeEpoch: number | undefined;
	// Previous destination sample of the active stroke, so we can interpolate stamps
	// between coalesced pointer events. The registry throttles fast moves, so this
	// keeps strokes continuous.
	let lastPaintPoint: ImagePoint | null = null;
	// Last hovered image-space point, kept so a `[`/`]` resize can redraw the cursor
	// (+ source ghost) without a pointer move.
	let lastHover: ImagePoint | null = null;
	// Faint preview of the source pixels that WOULD be cloned under the cursor. A
	// Fabric image kept in sync with the hover position.
	let ghost: any = null;
	let ghostCanvas: HTMLCanvasElement | null = null;
	// Live stroke preview: the ACTUAL cloned pixels composited onto an overlay as
	// the pointer moves. The real commit still lands on pointer-up.
	let preview: StrokePreview | null = null;
	// Visible source state. Clone Stamp should never fail as an invisible no-op when
	// the browser/tooling drops Alt; a click-only first gesture can set the source,
	// while a source-less drag gets an explicit canvas hint.
	let sourceHint: any = null;
	let pendingSourcePoint: ImagePoint | null = null;

	// Accumulators rebuilt per stroke.
	let base: RasterImage | null = null;
	let working: RasterImage | null = null;
	let strokeMask: Uint8ClampedArray | null = null;
	let cursor: any = null;
	let dirtyRegion: PixelRegion | null = null;

	function resetStroke(): void {
		base = null;
		working = null;
		strokeMask = null;
		stroke = null;
		strokeEpoch = undefined;
		painting = false;
		lastPaintPoint = null;
		pendingSourcePoint = null;
		dirtyRegion = null;
		endCloneStampStroke(state);
	}

	function clearSource(): void {
		state.source = null;
		state.alignedOffset = null;
		state.stroke = null;
	}

	function syncMode(): void {
		const next = normalizeMode(options.mode);
		if (state.mode === next) return;
		state.mode = next;
		state.alignedOffset = null;
		state.stroke = null;
	}

	function brushSize(): number {
		const fromSize = options.size;
		if (fromSize !== undefined && Number.isFinite(fromSize)) return Math.max(0, fromSize);
		return Math.max(0, options.radius * 2);
	}

	function brushRadius(): number {
		return brushSize() / 2;
	}

	function brush(): CloneStampBrush {
		return {
			size: brushSize(),
			hardness: clamp01(options.hardness),
			opacity: clamp01(options.opacity),
		};
	}

	function sourceForPreview(image: ImagePoint): ImagePoint | null {
		if (!state.source) return null;
		if (state.stroke) return sourcePointForCloneStampTarget(state, image);
		if (state.mode === "aligned" && state.alignedOffset) {
			return {
				x: image.x - state.alignedOffset.x,
				y: image.y - state.alignedOffset.y,
			};
		}
		return { x: state.source.x, y: state.source.y };
	}

	/**
	 * Source-patch ghost: render a faint preview of the source pixels that would be
	 * cloned under the cursor. Best-effort only; preview failures must never break
	 * the destructive operation.
	 */
	function drawGhost(ctx: ToolContext, image: ImagePoint): void {
		const FabricImage = ctx.fabric?.Image ?? ctx.fabric?.FabricImage;
		const source = sourceForPreview(image);
		if (!FabricImage || !source) return;
		const r = Math.ceil(brushRadius());
		const x0 = Math.max(0, Math.floor(source.x - r));
		const y0 = Math.max(0, Math.floor(source.y - r));
		const x1 = Math.min(ctx.imageWidth, Math.ceil(source.x + r));
		const y1 = Math.min(ctx.imageHeight, Math.ceil(source.y + r));
		const region: PixelRegion = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
		if (region.width <= 0 || region.height <= 0) return;
		const regionImg = readSourceImageRegion(ctx.sourceElement, region, ctx.imageWidth, ctx.imageHeight);
		if (!regionImg) return;
		try {
			if (!ghostCanvas) ghostCanvas = createWorkCanvas(region.width, region.height);
			ghostCanvas.width = region.width;
			ghostCanvas.height = region.height;
			const gctx = ghostCanvas.getContext("2d");
			if (!gctx) return;
			gctx.putImageData(regionImg, 0, 0);
			const sceneTL = ctx.imageToScene({ x: region.x, y: region.y });
			const sceneBR = ctx.imageToScene({ x: region.x + region.width, y: region.y + region.height });
			if (ghost) ctx.canvas.remove(ghost);
			ghost = new FabricImage(ghostCanvas, {
				left: sceneTL.x,
				top: sceneTL.y,
				scaleX: (sceneBR.x - sceneTL.x) / region.width,
				scaleY: (sceneBR.y - sceneTL.y) / region.height,
				opacity: 0.5,
				selectable: false,
				evented: false,
				objectCaching: false,
			});
			ctx.canvas.add(ghost);
		} catch {
			/* decorative preview only */
		}
	}

	function clearSourceHint(ctx: ToolContext): void {
		if (sourceHint && ctx.canvas?.remove) ctx.canvas.remove(sourceHint);
		sourceHint = null;
	}

	function showSourceHint(ctx: ToolContext, image: ImagePoint, text: string): void {
		const TextCtor = ctx.fabric?.Text ?? ctx.fabric?.Textbox;
		if (!TextCtor) return;
		try {
			clearSourceHint(ctx);
			const anchor = ctx.imageToScene(image);
			const offset = Math.max(ctx.imageLenToScene(brushRadius() + 8), 12);
			sourceHint = new TextCtor(text, {
				left: anchor.x + offset,
				top: anchor.y + offset,
				fontSize: Math.max(12, ctx.imageLenToScene(13)),
				fill: "#dcfce7",
				backgroundColor: "rgba(15, 23, 42, 0.86)",
				padding: 4,
				selectable: false,
				evented: false,
				objectCaching: false,
			});
			ctx.canvas.add(sourceHint);
			sourceHint.bringToFront?.();
			ctx.requestRender();
		} catch {
			sourceHint = null;
		}
	}

	function setSourcePoint(ctx: ToolContext, image: ImagePoint): void {
		setCloneStampSource(state, image);
		pendingSourcePoint = null;
		showSourceHint(ctx, image, SOURCE_HINT_SET);
	}

	function drawCursorAt(ctx: ToolContext, image: ImagePoint): void {
		if (!ctx.fabric?.Circle) return;
		lastHover = { x: image.x, y: image.y };
		drawGhost(ctx, image);
		const center = ctx.imageToScene(image);
		const r = ctx.imageLenToScene(brushRadius());
		if (cursor) ctx.canvas.remove(cursor);
		cursor = new ctx.fabric.Circle({
			left: center.x - r,
			top: center.y - r,
			radius: r,
			fill: "rgba(34,197,94,0.12)",
			stroke: state.source ? "#22c55e" : "#94a3b8",
			strokeWidth: 1,
			strokeDashArray: state.source ? undefined : [3, 3],
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
		if (ghost && ctx.canvas?.remove) ctx.canvas.remove(ghost);
		ghost = null;
	}

	function paintDab(ctx: ToolContext, point: ImagePoint): void {
		if (!base || !working || !strokeMask || !stroke) return;
		const source = sourcePointForCloneStampTarget(state, point);
		if (!source) return;
		const result = stampStroke(working, base, source, [point], brush());
		if (!result.bounds || result.pixelsWritten <= 0) return;
		dirtyRegion = unionRegion(dirtyRegion, result.bounds);
		stampSoftBrush(
			strokeMask,
			ctx.imageWidth,
			ctx.imageHeight,
			point.x,
			point.y,
			brushRadius(),
			clamp01(options.hardness),
			Math.round(clamp01(options.opacity) * 255),
		);
	}

	function paintSegment(ctx: ToolContext, point: ImagePoint): void {
		const from = lastPaintPoint;
		if (from) {
			const dx = point.x - from.x;
			const dy = point.y - from.y;
			const dist = Math.hypot(dx, dy);
			const spacing = Math.max(1, brushRadius() / 2);
			const steps = Math.floor(dist / spacing);
			for (let i = 1; i <= steps; i += 1) {
				const t = i / (steps + 1);
				paintDab(ctx, { x: from.x + dx * t, y: from.y + dy * t });
			}
		}
		paintDab(ctx, point);
		previewSegment(ctx, from, point);
		lastPaintPoint = { x: point.x, y: point.y };
	}

	function previewSegment(ctx: ToolContext, from: ImagePoint | null, point: ImagePoint): void {
		if (!preview || !base || !working || !strokeMask) return;
		const r = Math.ceil(brushRadius()) + 1;
		const minX = Math.max(0, Math.floor(Math.min(from?.x ?? point.x, point.x) - r));
		const minY = Math.max(0, Math.floor(Math.min(from?.y ?? point.y, point.y) - r));
		const maxX = Math.min(base.width - 1, Math.ceil(Math.max(from?.x ?? point.x, point.x) + r));
		const maxY = Math.min(base.height - 1, Math.ceil(Math.max(from?.y ?? point.y, point.y) + r));
		if (maxX < minX || maxY < minY) return;
		const region: PixelRegion = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
		const patch = buildEffectivePatch(base, working, strokeMask, region);
		preview.putRegion(patch, region.x, region.y);
	}

	/**
	 * Clip to dirty pixels and the active selection. The engine already produced
	 * the final cloned pixels in `working`; this mask is provenance + selection
	 * gating, so stale/outside pixels must be cleared before commit.
	 */
	function prepareMaskForCommit(
		ctx: ToolContext,
		mask: Uint8ClampedArray,
		width: number,
		height: number,
		region: PixelRegion | null,
	): PixelRegion | null {
		if (!region) return null;
		const hasSelection = options.respectSelection && !ctx.mask.isEmpty();
		const selection = hasSelection ? ctx.mask.data : null;
		// Scan ONLY the stroke's dirty region: the stroke mask is freshly
		// allocated per gesture and dabs are only stamped inside the tracked
		// dirty bounds, so everything outside `region` is zero by construction.
		// A full-image pass here made a tiny clone dab scan millions of pixels
		// on pointer-up for large pages (codex P2).
		const xMax = Math.min(width, region.x + region.width);
		const yMax = Math.min(height, region.y + region.height);
		const x0 = Math.max(0, region.x);
		const y0 = Math.max(0, region.y);
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (let y = y0; y < yMax; y += 1) {
			const row = y * width;
			for (let x = x0; x < xMax; x += 1) {
				const index = row + x;
				const keep = mask[index] > 0 && (!selection || selection[index] > 0);
				if (!keep) {
					mask[index] = 0;
					continue;
				}
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
		if (maxX < 0) return null;
		return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
	}

	async function commitStroke(
		ctx: ToolContext,
		baseSnap: RasterImage,
		workingSnap: RasterImage,
		maskSnap: Uint8ClampedArray,
		region: PixelRegion,
		strokeSnap: CloneStampStrokeState,
		epoch: number | undefined,
	): Promise<void> {
		const patch = buildEffectivePatch(baseSnap, workingSnap, maskSnap, region);
		const offset = {
			dx: strokeSnap.targetStart.x - strokeSnap.sourceStart.x,
			dy: strokeSnap.targetStart.y - strokeSnap.sourceStart.y,
		};
		const sourceBbox = {
			x: region.x - offset.dx,
			y: region.y - offset.dy,
			w: region.width,
			h: region.height,
		};

		if (typeof ctx.host.commitImageEditLayerPatch === "function" && typeof ctx.host.applyToolPatchInstant === "function") {
			const previewApplied = ctx.host.applyToolPatchInstant(patch, region, epoch, { preview: true });
			if (previewApplied) {
				ctx.host.setToolBusy?.(true, "กำลังบันทึกเลเยอร์โคลน");
				let recorded = false;
				try {
					recorded = await ctx.host.commitImageEditLayerPatch({
						kind: "clone",
						patch,
						mask: maskSnap,
						region,
						tool: {
							id: "clone-stamp",
							params: {
								radius: options.radius,
								size: brushSize(),
								hardness: clamp01(options.hardness),
								opacity: clamp01(options.opacity),
								mode: options.mode,
								respectSelection: options.respectSelection,
							},
						},
						sourceBbox,
						offset,
					});
				} finally {
					ctx.host.setToolBusy?.(false);
				}
				if (!recorded) {
					const original = sliceRasterRegion(baseSnap, region);
					ctx.host.applyToolPatchInstant(original, region, epoch, { preview: true, skipSnapshot: true });
				}
				return;
			}
			if (isStaleEpoch(ctx, epoch)) return;
			// Preview declined because the host has no backing canvas yet; fall through.
		}

		if (typeof ctx.host.applyToolPatchInstant === "function") {
			const applied = ctx.host.applyToolPatchInstant(patch, region, epoch);
			if (applied) return;
			if (isStaleEpoch(ctx, epoch)) return;
		}
	}

	const tool: EditorTool & CloneStampApi = {
		id: "clone-stamp",
		label: "Clone Stamp",
		icon: "❖",
		shortcut: "s",
		kind: "paint",
		options,

		activate() {},
		deactivate(ctx) {
			clearCursor(ctx);
			clearSourceHint(ctx);
			preview?.clear();
			preview = null;
			clearSource();
			lastHover = null;
			resetStroke();
		},

		onPointerDown(ctx: ToolContext, event: ToolPointerEvent) {
			syncMode();
			if (event.altKey) {
				resetStroke();
				setSourcePoint(ctx, event.image);
				drawCursor(ctx, event);
				return;
			}
			if (!state.source) {
				pendingSourcePoint = { x: event.image.x, y: event.image.y };
				showSourceHint(ctx, event.image, SOURCE_HINT_MISSING);
				drawCursor(ctx, event);
				return;
			}
			pendingSourcePoint = null;
			clearSourceHint(ctx);
			// perf: reuse the epoch-keyed cached page read (shared with the other clean tools)
			// instead of a fresh ~full-page getImageData on every stroke start. normalizeImageData
			// copies the bytes, so the cache stays read-only.
			const img = readSourceImageDataCached(ctx.sourceElement, ctx.imageWidth, ctx.imageHeight, ctx.host.getImageEpoch?.());
			if (!img) return;
			const started = beginCloneStampStroke(state, event.image);
			if (!started) {
				drawCursor(ctx, event);
				return;
			}
			base = normalizeImageData(img);
			working = cloneRasterImage(base);
			strokeMask = new Uint8ClampedArray(ctx.imageWidth * ctx.imageHeight);
			stroke = started;
			strokeEpoch = ctx.host.getImageEpoch?.();
			painting = true;
			lastPaintPoint = null;
			preview?.clear();
			preview = createStrokePreview(ctx, { fillStyle: "rgba(0,0,0,0)", opacity: 1 });
			paintSegment(ctx, event.image);
			drawCursor(ctx, event);
		},

		onPointerMove(ctx: ToolContext, event: ToolPointerEvent) {
			drawCursor(ctx, event);
			if (!painting) return;
			paintSegment(ctx, event.image);
		},

		async onPointerUp(ctx: ToolContext, event: ToolPointerEvent) {
			if (!painting) {
				if (!state.source && pendingSourcePoint) {
					const moved = Math.hypot(
						event.image.x - pendingSourcePoint.x,
						event.image.y - pendingSourcePoint.y,
					);
					if (moved <= SOURCE_CLICK_TOLERANCE_PX) {
						setSourcePoint(ctx, pendingSourcePoint);
						drawCursorAt(ctx, pendingSourcePoint);
					} else {
						showSourceHint(ctx, event.image, SOURCE_HINT_MISSING);
						drawCursor(ctx, event);
					}
					pendingSourcePoint = null;
				}
				return;
			}
			if (!painting || !base || !working || !strokeMask || !stroke) return;
			painting = false;
			if (!lastPaintPoint || !samePoint(lastPaintPoint, event.image)) {
				paintSegment(ctx, event.image);
			}

			const baseSnap = base;
			const workingSnap = working;
			const maskSnap = strokeMask;
			const strokeSnap = { ...stroke, targetStart: { ...stroke.targetStart }, sourceStart: { ...stroke.sourceStart } };
			const epoch = strokeEpoch;
			const region = prepareMaskForCommit(ctx, maskSnap, baseSnap.width, baseSnap.height, dirtyRegion);
			if (!region && state.mode === "aligned") {
				// A fully clipped/no-op stroke should not consume the aligned source
				// relation; otherwise the next real stroke inherits an invisible offset.
				state.alignedOffset = null;
			}
			resetStroke();
			try {
				if (region) await commitStroke(ctx, baseSnap, workingSnap, maskSnap, region, strokeSnap, epoch);
			} finally {
				preview?.clear();
				preview = null;
			}
		},

		setRadius(ctx: ToolContext, radius: number) {
			options.radius = Math.max(1, Math.round(radius));
			delete options.size;
			if (lastHover) drawCursorAt(ctx, lastHover);
		},
	};

	return tool;
}

function normalizeOptions(initial: Partial<CloneStampOptions>): CloneStampOptions {
	const radius =
		initial.radius !== undefined && Number.isFinite(initial.radius)
			? Math.max(0, initial.radius)
			: initial.size !== undefined && Number.isFinite(initial.size)
				? Math.max(0, initial.size / 2)
				: DEFAULT_OPTIONS.radius;
	return {
		...DEFAULT_OPTIONS,
		...initial,
		radius,
		size: initial.size !== undefined && Number.isFinite(initial.size) ? Math.max(0, initial.size) : undefined,
		hardness: initial.hardness !== undefined ? clamp01(initial.hardness) : DEFAULT_OPTIONS.hardness,
		opacity: initial.opacity !== undefined ? clamp01(initial.opacity) : DEFAULT_OPTIONS.opacity,
		mode: normalizeMode(initial.mode ?? DEFAULT_OPTIONS.mode),
		respectSelection: initial.respectSelection ?? DEFAULT_OPTIONS.respectSelection,
	};
}

function normalizeMode(mode: CloneStampMode): CloneStampMode {
	return mode === "non-aligned" ? "non-aligned" : "aligned";
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function samePoint(a: ImagePoint, b: ImagePoint): boolean {
	return a.x === b.x && a.y === b.y;
}

function unionRegion(a: PixelRegion | null, b: PixelRegion | null): PixelRegion | null {
	if (!a) return b ? { ...b } : null;
	if (!b) return a;
	const x0 = Math.min(a.x, b.x);
	const y0 = Math.min(a.y, b.y);
	const x1 = Math.max(a.x + a.width, b.x + b.width);
	const y1 = Math.max(a.y + a.height, b.y + b.height);
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function buildEffectivePatch(
	base: RasterImage,
	working: RasterImage,
	mask: Uint8ClampedArray,
	region: PixelRegion,
): ImageData {
	const out = sliceRasterRegion(base, region);
	for (let y = 0; y < region.height; y += 1) {
		const sourceY = region.y + y;
		for (let x = 0; x < region.width; x += 1) {
			const sourceX = region.x + x;
			const pixelIndex = sourceY * base.width + sourceX;
			if (mask[pixelIndex] <= 0) continue;
			const sourceOffset = pixelIndex * 4;
			const outOffset = (y * region.width + x) * 4;
			out.data[outOffset] = working.data[sourceOffset];
			out.data[outOffset + 1] = working.data[sourceOffset + 1];
			out.data[outOffset + 2] = working.data[sourceOffset + 2];
			out.data[outOffset + 3] = working.data[sourceOffset + 3];
		}
	}
	return out;
}

function isStaleEpoch(ctx: ToolContext, epoch: number | undefined): boolean {
	return epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch;
}

function normalizeImageData(image: ImageData): RasterImage {
	// node-canvas/jsdom can return ImageData from another JS realm. The shared
	// engine intentionally validates against the current realm's Uint8ClampedArray,
	// so copy the bytes into a plain image-like object before stamping.
	return {
		width: image.width,
		height: image.height,
		data: new Uint8ClampedArray(image.data),
	};
}

function cloneRasterImage(image: RasterImage): RasterImage {
	return {
		width: image.width,
		height: image.height,
		data: new Uint8ClampedArray(image.data),
	};
}

function sliceRasterRegion(base: RasterImage, region: PixelRegion): ImageData {
	const out = new Uint8ClampedArray(region.width * region.height * 4);
	for (let y = 0; y < region.height; y += 1) {
		const sourceY = region.y + y;
		for (let x = 0; x < region.width; x += 1) {
			const sourceX = region.x + x;
			const sourceOffset = (sourceY * base.width + sourceX) * 4;
			const outOffset = (y * region.width + x) * 4;
			out[outOffset] = base.data[sourceOffset];
			out[outOffset + 1] = base.data[sourceOffset + 1];
			out[outOffset + 2] = base.data[sourceOffset + 2];
			out[outOffset + 3] = base.data[sourceOffset + 3];
		}
	}
	return makeImageData(out, region.width, region.height);
}
