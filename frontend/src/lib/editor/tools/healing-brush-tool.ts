// Tool 7 — Spot Healing Brush (J) — the key cleaning tool.
//
// Paint over unwanted pixels (SFX, dirt, leftover text); on release we first try
// a manga-fast uniform surrounding-colour fill, then fall back to OpenCV.js
// `cv.inpaint` (Telea) over the painted ROI when texture is non-uniform. If the
// user has an active selection, the brush is clipped to it (Photoshop behaviour).
// Brush radius + inpaint radius are configurable.

import {
	stampSoftBrush,
	readSourceImageRegion,
	computeMaskBounds,
	cropMaskRegion,
	type PixelRegion,
} from "./raster.js";
import { inpaintRegion, warmupInpaintWorker } from "./inpaint-worker-client.js";
import { createStrokePreview, type StrokePreview } from "./stroke-preview.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

const LARGE_HEAL_REGION_PIXELS = 180_000;
const HUGE_HEAL_REGION_PIXELS = 600_000;
const LARGE_REGION_RADIUS_CAP = 3;
const HUGE_REGION_RADIUS_CAP = 2;
const IDLE_PRELOAD_TIMEOUT_MS = 3_000;

let openCvIdlePreloadScheduled = false;

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

function roundMs(value: number): number {
	return Math.round(value * 10) / 10;
}

function isHealingDebugEnabled(): boolean {
	const globalFlag = (globalThis as { __MANGA_HEALING_DEBUG__?: boolean }).__MANGA_HEALING_DEBUG__;
	if (globalFlag === true) return true;
	try {
		return typeof localStorage !== "undefined" && localStorage.getItem("manga:healing-debug") === "1";
	} catch {
		return false;
	}
}

function logHealingPerf(stage: string, details: Record<string, unknown>): void {
	if (!isHealingDebugEnabled() || typeof console === "undefined") return;
	console.debug("[healing-brush:perf]", stage, details);
}

function canScheduleIdlePreload(): boolean {
	if (
		typeof window === "undefined" ||
		typeof document === "undefined" ||
		typeof ImageData === "undefined"
	) {
		return false;
	}
	const ua = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
	return !/jsdom/i.test(ua);
}

function scheduleOpenCvIdlePreload(): void {
	if (openCvIdlePreloadScheduled || !canScheduleIdlePreload()) return;
	openCvIdlePreloadScheduled = true;
	const run = () => {
		const start = nowMs();
		// Warm the worker's OpenCV runtime via the NON-POISONING warmup entry: a
		// slow cold init on a throttled browser must never flip workerUsable=false
		// before the user's first real stroke (codex P2).
		void warmupInpaintWorker()
			.then(() => {
				logHealingPerf("idle-opencv-preload", { totalMs: roundMs(nowMs() - start) });
			})
			.catch((err) => {
				logHealingPerf("idle-opencv-preload-failed", {
					totalMs: roundMs(nowMs() - start),
					error: err instanceof Error ? err.message : String(err),
				});
			});
	};
	const idleWindow = window as Window & typeof globalThis & {
		requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
	};
	if (typeof idleWindow.requestIdleCallback === "function") {
		idleWindow.requestIdleCallback(run, { timeout: IDLE_PRELOAD_TIMEOUT_MS });
		return;
	}
	setTimeout(run, IDLE_PRELOAD_TIMEOUT_MS);
}

function effectiveRadiusForRegion(region: PixelRegion, requestedRadius: number): number {
	const radius = Math.max(1, Math.round(requestedRadius));
	const area = region.width * region.height;
	if (area >= HUGE_HEAL_REGION_PIXELS) return Math.min(radius, HUGE_REGION_RADIUS_CAP);
	if (area >= LARGE_HEAL_REGION_PIXELS) return Math.min(radius, LARGE_REGION_RADIUS_CAP);
	return radius;
}

scheduleOpenCvIdlePreload();

export interface HealingBrushOptions {
	/** Brush radius in image pixels. */
	radius: number;
	/** Telea inpaint neighbourhood radius. */
	inpaintRadius: number;
	/** Restrict healing to the active selection mask when one exists. */
	respectSelection: boolean;
}

const DEFAULT_OPTIONS: HealingBrushOptions = { radius: 16, inpaintRadius: 3, respectSelection: true };

export interface HealingBrushApi {
	options: HealingBrushOptions;
	/** Heal the current active selection mask directly (no brush stroke). */
	healSelection(ctx: ToolContext): Promise<void>;
	/**
	 * Live-set the brush radius (rec #5: `[`/`]` resize). Updates the option and
	 * redraws the size cursor at the last hovered point so the preview tracks the
	 * change immediately even when the pointer is stationary.
	 */
	setRadius(ctx: ToolContext, radius: number): void;
}

export function createHealingBrushTool(initial: Partial<HealingBrushOptions> = {}): EditorTool & HealingBrushApi {
	const options: HealingBrushOptions = { ...DEFAULT_OPTIONS, ...initial };
	let healMask: Uint8ClampedArray | null = null;
	let painting = false;
	let cursor: any = null;
	// Live stroke preview (P1 UX): a translucent tint painted over the area that
	// WILL be healed, shown in real time as the pointer moves. The real Telea heal
	// still runs on pointer-up; the preview is cleared once the result lands.
	let preview: StrokePreview | null = null;
	// Previous image-space sample of the active stroke, so we can stamp along the
	// segment between pointer events (fast moves / small radii would otherwise
	// leave gaps in the painted mask).
	let lastPoint: { x: number; y: number } | null = null;
	// Last hovered image-space point, kept so a `[`/`]` resize can redraw the size
	// cursor at the cursor's current location without waiting for a pointer move.
	let lastHover: { x: number; y: number } | null = null;

	function ensureHealMask(ctx: ToolContext): Uint8ClampedArray {
		if (!healMask || healMask.length !== ctx.imageWidth * ctx.imageHeight) {
			healMask = new Uint8ClampedArray(ctx.imageWidth * ctx.imageHeight);
		}
		return healMask;
	}

	/**
	 * Stamp the soft brush along the segment from `lastPoint` to (x,y) so a single
	 * continuous stroke produces a continuous mask even when pointer samples are
	 * farther apart than the brush diameter. Spacing is ~1/4 the radius.
	 */
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
				stampSoftBrush(
					mask,
					ctx.imageWidth,
					ctx.imageHeight,
					from.x + dx * t,
					from.y + dy * t,
					options.radius,
					1,
					255,
				);
			}
		}
		stampSoftBrush(mask, ctx.imageWidth, ctx.imageHeight, x, y, options.radius, 1, 255);
		// Mirror the mask stamp into the live preview overlay (single dab/segment per
		// call — the soft mask interpolation above already fills gaps; the overlay
		// stroke is a fat round-capped line so it stays continuous too).
		preview?.stamp({ x, y }, options.radius, from);
		lastPoint = { x, y };
	}

	function drawCursorAt(ctx: ToolContext, image: { x: number; y: number }) {
		if (!ctx.fabric?.Circle) return;
		lastHover = { x: image.x, y: image.y };
		const center = ctx.imageToScene(image);
		const sceneRadius = ctx.imageLenToScene(options.radius);
		if (cursor) ctx.canvas.remove(cursor);
		cursor = new ctx.fabric.Circle({
			left: center.x - sceneRadius,
			top: center.y - sceneRadius,
			radius: sceneRadius,
			fill: "rgba(248,113,113,0.18)",
			stroke: "#f87171",
			strokeWidth: 1,
			selectable: false,
			evented: false,
			objectCaching: false,
		});
		ctx.canvas.add(cursor);
		ctx.requestRender();
	}

	function drawCursor(ctx: ToolContext, event: ToolPointerEvent) {
		drawCursorAt(ctx, event.image);
	}

	function clearCursor(ctx: ToolContext) {
		if (cursor && ctx.canvas?.remove) ctx.canvas.remove(cursor);
		cursor = null;
	}

	/**
	 * Run inpaint over `mask` and apply the healed pixels INSTANTLY (Photopea-style).
	 *
	 * Clip the mask to the stroke's bounding box (+ inpaint radius margin so Telea has
	 * neighbour context), read + inpaint ONLY that region, paint the result straight
	 * onto the live background bitmap via `host.applyToolPatchInstant` for instant
	 * feedback, then record it as a non-destructive `healing` `ImageEditLayer` via
	 * `host.commitImageEditLayerPatch`. No full-image encode, no reload, no per-stroke
	 * server round-trip.
	 */
	async function heal(ctx: ToolContext, mask: Uint8ClampedArray): Promise<void> {
		// Clip to active selection if requested.
		let effective = mask;
		if (options.respectSelection && !ctx.mask.isEmpty()) {
			effective = mask.slice();
			const sel = ctx.mask.data;
			for (let i = 0; i < effective.length; i++) {
				if (sel[i] === 0) effective[i] = 0;
			}
		}

		// Bounding box of the painted region (+ margin) so we inpaint a TINY area, not
		// the whole 12 MP page. Telea needs surrounding context, so pad by the inpaint
		// radius plus a little slack. Empty mask → nothing to do.
		const margin = Math.max(options.inpaintRadius + 2, 4);
		const region = computeMaskBounds(effective, ctx.imageWidth, ctx.imageHeight, margin);
		if (!region) return;

		const totalStart = nowMs();
		const readRegionStart = nowMs();
		const regionImg = readSourceImageRegion(
			ctx.sourceElement,
			region,
			ctx.imageWidth,
			ctx.imageHeight,
		);
		if (!regionImg) return;
		const regionMask = cropMaskRegion(effective, ctx.imageWidth, region);
		const readRegionMs = nowMs() - readRegionStart;
		const requestedInpaintRadius = Math.max(1, Math.round(options.inpaintRadius));
		const solveInpaintRadius = effectiveRadiusForRegion(region as PixelRegion, requestedInpaintRadius);
		const radiusClamped = solveInpaintRadius !== requestedInpaintRadius;
		const busyLabel = radiusClamped ? "กำลังซ่อมจุดพื้นที่ใหญ่" : "กำลังซ่อมจุด";
		const timings: Record<string, unknown> = {
			region: { width: region.width, height: region.height, pixels: region.width * region.height },
			requestedInpaintRadius,
			solveInpaintRadius,
			radiusClamped,
			readRegionMs: roundMs(readRegionMs),
		};

		const canInstant = typeof ctx.host.applyToolPatchInstant === "function";
		if (canInstant) {
			// Read ONLY the stroke's ROI (rec #1: bounded compute), then solve that ROI
			// via `inpaintRegion`. Manga-fast uniform fills return before worker/OpenCV;
			// complex texture falls through to worker Telea with bounded dimensions.
			// PR #264 worker-race fix — capture the backing-canvas epoch BEFORE awaiting
			// the off-thread Telea solve. The page (and the ROI we just read) belong to
			// this epoch; if the user navigates / the image reloads / the editor is
			// destroyed while the worker runs, the epoch advances and the host DISCARDS
			// the result (returns false) instead of compositing the OLD page's ROI onto
			// the NEW page. Without this, the late worker callback corrupts the wrong
			// page (the reopened #248/#255 race). Both the worker and the synchronous
			// fallback inside inpaintRegion are covered (same await point).
			const epoch = ctx.host.getImageEpoch?.();
			// Busy indicator (UX P3): even off-thread, a big-region Telea solve (or a
			// cold OpenCV init on the first heal) can take a noticeable beat. Surface a
			// non-blocking working chip + busy cursor so it never reads as a crash. The
			// badge has pointer-events off, so scroll/pan stay responsive (the whole
			// point of running off-thread). Always cleared in `finally`.
			ctx.host.setToolBusy?.(true, busyLabel);
			let healed: ImageData;
			try {
				const solveStart = nowMs();
				healed = await inpaintRegion(regionImg, regionMask, solveInpaintRadius);
				timings.solveMs = roundMs(nowMs() - solveStart);
			} finally {
				ctx.host.setToolBusy?.(false);
			}
			// NON-DESTRUCTIVE PATH (Phase B) — when the host supports realized-patch edit
			// layers, paint the healed ROI as a transient preview, then record a `healing`
			// `ImageEditLayer` (realized healed ROI asset + stroke mask + Telea metadata)
			// instead of baking a full new page PNG. The original page.imageId stays intact.
			if (typeof ctx.host.commitImageEditLayerPatch === "function") {
				// Instant preview (responsiveness) — paint the healed ROI; `preview` means the
				// host shows it but does NOT bake a page PNG (the edit layer is the durable store).
				const previewStart = nowMs();
				const previewApplied = ctx.host.applyToolPatchInstant!(healed, region as PixelRegion, epoch, { preview: true });
				if (!previewApplied) {
					// Epoch advanced (page switched) → stale, drop silently. Otherwise no backing
					// canvas → fall through to the legacy full-image commit below.
					if (epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch) {
						timings.staleEpoch = true;
						timings.totalMs = roundMs(nowMs() - totalStart);
						logHealingPerf("stroke-discarded-stale", timings);
						return;
					}
				} else {
					const recorded = await ctx.host.commitImageEditLayerPatch({
						kind: "healing",
						patch: healed,
						mask: effective,
						region: region as PixelRegion,
						tool: {
							id: "healing-brush",
							params: {
								inpaintRadius: solveInpaintRadius,
								requestedInpaintRadius,
								radiusClamped,
							},
						},
						algorithm: "telea",
						algorithmVersion: "telea-1",
					});
					timings.previewAndCommitMs = roundMs(nowMs() - previewStart);
					if (!recorded) {
						// Commit failed (upload/quota) — revert the preview so no phantom heal
						// lingers (it would otherwise vanish on reload/export). Repaint the
						// ORIGINAL ROI pixels we read BEFORE the heal (regionImg).
						ctx.host.applyToolPatchInstant!(regionImg, region as PixelRegion, epoch, { preview: true, skipSnapshot: true });
					}
					timings.totalMs = roundMs(nowMs() - totalStart);
					logHealingPerf("stroke-instant-edit-layer", timings);
					return;
				}
			}

			const applyStart = nowMs();
			const applied = ctx.host.applyToolPatchInstant!(healed, region as PixelRegion, epoch);
			timings.applyInstantMs = roundMs(nowMs() - applyStart);
			// `applied === false` here means EITHER the epoch changed (stale → discard;
			// do NOT fall through to the legacy full-page commit, which would heal the
			// wrong page) OR there is no backing canvas yet. Distinguish by re-reading
			// the epoch: if it advanced, the stroke is stale — drop it silently.
			if (applied) {
				timings.totalMs = roundMs(nowMs() - totalStart);
				logHealingPerf("stroke-instant-background", timings);
				return;
			}
			if (epoch !== undefined && ctx.host.getImageEpoch?.() !== epoch) {
				timings.staleEpoch = true;
				timings.totalMs = roundMs(nowMs() - totalStart);
				logHealingPerf("stroke-discarded-stale", timings);
				return;
			}
			// Instant apply declined (no backing canvas yet) — nothing more to do.
		}
	}

	const tool: EditorTool & HealingBrushApi = {
		id: "healing-brush",
		label: "Spot Healing Brush",
		icon: "✚",
		shortcut: "j",
		kind: "paint",
		options,

		activate() {},
		deactivate(ctx) {
			clearCursor(ctx);
			preview?.clear();
			preview = null;
			healMask = null;
			painting = false;
			lastPoint = null;
			lastHover = null;
		},

		onPointerDown(ctx: ToolContext, event: ToolPointerEvent) {
			painting = true;
			const m = ensureHealMask(ctx);
			m.fill(0);
			lastPoint = null;
			// Start a fresh live preview for this stroke (translucent red = "will heal").
			preview?.clear();
			preview = createStrokePreview(ctx, { fillStyle: "rgba(248,113,113,0.85)", opacity: 0.45 });
			stampSegment(ctx, m, event.image.x, event.image.y);
			drawCursor(ctx, event);
		},

		onPointerMove(ctx: ToolContext, event: ToolPointerEvent) {
			drawCursor(ctx, event);
			if (!painting || !healMask) return;
			stampSegment(ctx, healMask, event.image.x, event.image.y);
		},

		async onPointerUp(ctx: ToolContext, event: ToolPointerEvent) {
			if (!painting || !healMask) return;
			painting = false;
			stampSegment(ctx, healMask, event.image.x, event.image.y);
			lastPoint = null;
			const mask = healMask;
			healMask = null;
			try {
				await heal(ctx, mask);
			} finally {
				// Drop the preview once the real healed pixels have been composited (or
				// the heal bailed) so the tint never lingers over the result.
				preview?.clear();
				preview = null;
			}
		},

		async healSelection(ctx: ToolContext) {
			if (ctx.mask.isEmpty()) return;
			await heal(ctx, ctx.mask.cloneData());
		},

		setRadius(ctx: ToolContext, radius: number) {
			options.radius = Math.max(1, Math.round(radius));
			if (lastHover) drawCursorAt(ctx, lastHover);
		},
	};

	return tool;
}
