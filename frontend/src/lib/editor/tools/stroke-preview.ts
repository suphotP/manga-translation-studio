// Live stroke preview overlay (P1 UX — real-time painting feedback).
//
// The paint tools (spot-healing, clone-stamp) accumulate their work into an
// OFF-SCREEN buffer and only composite it onto the page on pointer-up, so during
// the drag the user sees nothing but the brush ring — it reads as a dead tool.
// This helper paints a lightweight, full-resolution preview of the stroke onto a
// Fabric overlay image that sits on top of the page, updated INCREMENTALLY per
// pointer sample (one soft dab per move, never a full re-render), so the effect
// shows in real time. The real (heal/clone) result is still committed on
// pointer-up; the preview is then cleared.
//
// All coordinates are IMAGE-SPACE (native page pixels). The overlay canvas is the
// page's native size, scaled into scene space via the page's imageBounds so it
// registers 1:1 with the background.

import { createWorkCanvas } from "./raster.js";
import type { ImagePoint, ToolContext } from "./types.js";

export interface StrokePreview {
	/** Paint a soft dab (or segment to the previous dab) into the preview. */
	stamp(point: ImagePoint, radius: number, prev?: ImagePoint | null): void;
	/**
	 * Blit a real RGBA region into the preview at (x,y). Used by tools that can show
	 * their ACTUAL result live (e.g. clone-stamp blits the cloned pixels) rather than
	 * a tint. No-op once cleared.
	 */
	putRegion(patch: ImageData, x: number, y: number): void;
	/** Remove the overlay + free its backing canvas. Safe to call repeatedly. */
	clear(): void;
}

export interface StrokePreviewOptions {
	/** CSS paint style for the preview (e.g. a translucent tint or the clone src). */
	fillStyle: string | CanvasPattern;
	/** Overlay opacity (0..1). */
	opacity?: number;
	/** Optional global composite op (e.g. "destination-out" for an erase preview). */
	compositeOperation?: GlobalCompositeOperation;
}

/**
 * Create a stroke-preview overlay sized to the current page. Returns a no-op
 * preview when Fabric's Image constructor or a 2D canvas isn't available
 * (tests / SSR), so callers never need to branch.
 */
export function createStrokePreview(ctx: ToolContext, opts: StrokePreviewOptions): StrokePreview {
	const FabricImage = ctx.fabric?.Image ?? ctx.fabric?.FabricImage;
	const width = Math.max(1, Math.round(ctx.imageWidth));
	const height = Math.max(1, Math.round(ctx.imageHeight));
	let canvas: HTMLCanvasElement | null = null;
	let c2d: CanvasRenderingContext2D | null = null;
	try {
		canvas = createWorkCanvas(width, height);
		c2d = canvas.getContext("2d");
	} catch {
		canvas = null;
		c2d = null;
	}
	if (!FabricImage || !canvas || !c2d) {
		return { stamp() {}, putRegion() {}, clear() {} };
	}

	c2d.lineCap = "round";
	c2d.lineJoin = "round";
	if (opts.compositeOperation) c2d.globalCompositeOperation = opts.compositeOperation;

	// Position + scale the native-size overlay into scene space so it overlays the
	// page background 1:1 (handles zoom/pan because imageBounds already encodes it).
	const tl = ctx.imageToScene({ x: 0, y: 0 });
	const br = ctx.imageToScene({ x: width, y: height });
	let overlay: any = null;
	try {
		overlay = new FabricImage(canvas, {
			left: tl.x,
			top: tl.y,
			scaleX: (br.x - tl.x) / width,
			scaleY: (br.y - tl.y) / height,
			opacity: opts.opacity ?? 0.55,
			selectable: false,
			evented: false,
			objectCaching: false,
			excludeFromExport: true,
		});
		ctx.canvas.add(overlay);
		overlay.bringToFront?.();
	} catch {
		overlay = null;
	}

	let cleared = false;

	function stamp(point: ImagePoint, radius: number, prev?: ImagePoint | null): void {
		if (cleared || !c2d || !canvas) return;
		c2d.fillStyle = opts.fillStyle;
		c2d.strokeStyle = opts.fillStyle;
		const r = Math.max(0.5, radius);
		if (prev) {
			// Stroke a fat round-capped line so a fast drag has no gaps between samples.
			c2d.lineWidth = r * 2;
			c2d.beginPath();
			c2d.moveTo(prev.x, prev.y);
			c2d.lineTo(point.x, point.y);
			c2d.stroke();
		} else {
			c2d.beginPath();
			c2d.arc(point.x, point.y, r, 0, Math.PI * 2);
			c2d.fill();
		}
		if (overlay) {
			overlay.dirty = true;
			ctx.requestRender();
		}
	}

	function putRegion(patch: ImageData, x: number, y: number): void {
		if (cleared || !c2d || !canvas) return;
		try {
			c2d.putImageData(patch, Math.round(x), Math.round(y));
		} catch {
			return;
		}
		if (overlay) {
			overlay.dirty = true;
			ctx.requestRender();
		}
	}

	function clear(): void {
		if (cleared) return;
		cleared = true;
		try {
			if (overlay && ctx.canvas?.remove) ctx.canvas.remove(overlay);
		} catch {
			/* overlay already gone */
		}
		overlay = null;
		// Free the backing pixel buffer immediately rather than waiting on GC.
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
		canvas = null;
		c2d = null;
		ctx.requestRender();
	}

	return { stamp, putRegion, clear };
}
