// Tool 1 — Rectangular Marquee (M).
//
// Drag a rectangle in scene space; on release we convert the two corners to
// image-space and rasterise an axis-aligned rect into the MaskBuffer. Modifier
// keys give Photoshop add/subtract/intersect behaviour.

import { modeFromModifiers } from "./mask-buffer.js";
import { rasterizeRect } from "./raster.js";
import { renderSelectionOverlay } from "./selection-overlay.js";
import type { EditorTool, ToolContext, ToolPointerEvent } from "./types.js";

export function createMarqueeTool(): EditorTool {
	let startImg: { x: number; y: number } | null = null;
	let previewRect: any = null;

	function clearPreview(ctx: ToolContext) {
		if (previewRect && ctx.canvas?.remove) ctx.canvas.remove(previewRect);
		previewRect = null;
	}

	return {
		id: "marquee",
		label: "Rectangular Marquee",
		icon: "▭",
		shortcut: "m",
		kind: "selection",

		activate() {},
		deactivate(ctx) {
			clearPreview(ctx);
			startImg = null;
		},

		onPointerDown(_ctx, event: ToolPointerEvent) {
			startImg = { x: event.image.x, y: event.image.y };
		},

		onPointerMove(ctx, event: ToolPointerEvent) {
			if (!startImg || !ctx.fabric) return;
			const a = ctx.imageToScene(startImg);
			const b = ctx.imageToScene(event.image);
			const left = Math.min(a.x, b.x);
			const top = Math.min(a.y, b.y);
			const width = Math.abs(b.x - a.x);
			const height = Math.abs(b.y - a.y);
			const Rect = ctx.fabric.Rect;
			if (!Rect) return;
			if (!previewRect) {
				previewRect = new Rect({
					left,
					top,
					width,
					height,
					fill: "rgba(56,189,248,0.15)",
					stroke: "#38bdf8",
					strokeWidth: 1,
					strokeDashArray: [4, 3],
					selectable: false,
					evented: false,
					objectCaching: false,
				});
				ctx.canvas.add(previewRect);
			} else {
				previewRect.set({ left, top, width, height });
			}
			ctx.requestRender();
		},

		onPointerUp(ctx, event: ToolPointerEvent) {
			if (!startImg) return;
			clearPreview(ctx);
			const x = Math.min(startImg.x, event.image.x);
			const y = Math.min(startImg.y, event.image.y);
			const w = Math.abs(event.image.x - startImg.x);
			const h = Math.abs(event.image.y - startImg.y);
			startImg = null;
			if (w < 1 || h < 1) {
				// Treat a click (no drag) as "deselect" when no modifier is held.
				if (!event.shiftKey && !event.altKey) {
					ctx.mask.clear();
					renderSelectionOverlay(ctx, ctx.mask);
				}
				return;
			}
			const rectMask = rasterizeRect(x, y, w, h, ctx.imageWidth, ctx.imageHeight);
			ctx.mask.composite(rectMask, modeFromModifiers(event));
			renderSelectionOverlay(ctx, ctx.mask);
		},
	};
}
