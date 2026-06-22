// Tool 2 — Freehand Lasso (L).
//
// Capture the pointer path while dragging, accumulate image-space points, draw a
// live scene-space polyline preview, then rasterise the closed path into a 1-bit
// mask on release.

import { modeFromModifiers } from "./mask-buffer.js";
import { rasterizeFreehand } from "./raster.js";
import { renderSelectionOverlay } from "./selection-overlay.js";
import type { EditorTool, ImagePoint, ToolContext, ToolPointerEvent } from "./types.js";

export function createLassoTool(): EditorTool {
	let points: ImagePoint[] = [];
	let drawing = false;
	let previewLine: any = null;

	function clearPreview(ctx: ToolContext) {
		if (previewLine && ctx.canvas?.remove) ctx.canvas.remove(previewLine);
		previewLine = null;
	}

	function updatePreview(ctx: ToolContext) {
		if (!ctx.fabric?.Polyline || points.length < 2) return;
		const scenePts = points.map((p) => ctx.imageToScene(p));
		if (previewLine) ctx.canvas.remove(previewLine);
		previewLine = new ctx.fabric.Polyline(scenePts, {
			fill: "rgba(56,189,248,0.12)",
			stroke: "#38bdf8",
			strokeWidth: 1,
			strokeDashArray: [4, 3],
			selectable: false,
			evented: false,
			objectCaching: false,
		});
		ctx.canvas.add(previewLine);
		ctx.requestRender();
	}

	return {
		id: "lasso",
		label: "Freehand Lasso",
		icon: "◌",
		shortcut: "l",
		kind: "selection",

		activate() {},
		deactivate(ctx) {
			clearPreview(ctx);
			points = [];
			drawing = false;
		},

		onPointerDown(_ctx, event: ToolPointerEvent) {
			drawing = true;
			points = [{ x: event.image.x, y: event.image.y }];
		},

		onPointerMove(ctx, event: ToolPointerEvent) {
			if (!drawing) return;
			const last = points[points.length - 1];
			// Decimate near-duplicate points to keep the polyline cheap.
			if (!last || Math.hypot(event.image.x - last.x, event.image.y - last.y) > 1.5) {
				points.push({ x: event.image.x, y: event.image.y });
				updatePreview(ctx);
			}
		},

		onPointerUp(ctx, event: ToolPointerEvent) {
			if (!drawing) return;
			drawing = false;
			points.push({ x: event.image.x, y: event.image.y });
			clearPreview(ctx);
			if (points.length >= 3) {
				const mask = rasterizeFreehand(points, ctx.imageWidth, ctx.imageHeight);
				ctx.mask.composite(mask, modeFromModifiers(event));
				renderSelectionOverlay(ctx, ctx.mask);
			}
			points = [];
		},
	};
}
