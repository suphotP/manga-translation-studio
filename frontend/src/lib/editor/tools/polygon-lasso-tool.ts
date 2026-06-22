// Tool 3 — Polygon Lasso (also bound to L cycle; primary shortcut handled by dock).
//
// Click to drop vertices; double-click (or click near the first vertex) closes
// the polygon. The closed polyline is rasterised via even-odd fill so concave
// bubble outlines work like Photoshop's polygonal lasso.

import { modeFromModifiers } from "./mask-buffer.js";
import { rasterizePolygon } from "./raster.js";
import { renderSelectionOverlay } from "./selection-overlay.js";
import { getEditorShortcutForSuiteTool } from "$lib/editor-tools/keymap.js";
import type { EditorTool, ImagePoint, ToolContext, ToolPointerEvent } from "./types.js";

const CLOSE_DISTANCE_PX = 6; // image-space proximity to first vertex that closes

export function createPolygonLassoTool(): EditorTool {
	let vertices: ImagePoint[] = [];
	let preview: any = null;
	let lastDownTime = 0;

	function clearPreview(ctx: ToolContext) {
		if (preview && ctx.canvas?.remove) ctx.canvas.remove(preview);
		preview = null;
	}

	function updatePreview(ctx: ToolContext, hoverImg?: ImagePoint) {
		if (!ctx.fabric?.Polyline) return;
		const pts = hoverImg ? [...vertices, hoverImg] : vertices;
		if (pts.length < 2) {
			clearPreview(ctx);
			return;
		}
		const scenePts = pts.map((p) => ctx.imageToScene(p));
		if (preview) ctx.canvas.remove(preview);
		preview = new ctx.fabric.Polyline(scenePts, {
			fill: "rgba(56,189,248,0.10)",
			stroke: "#38bdf8",
			strokeWidth: 1,
			strokeDashArray: [4, 3],
			selectable: false,
			evented: false,
			objectCaching: false,
		});
		ctx.canvas.add(preview);
		ctx.requestRender();
	}

	function commit(ctx: ToolContext, event: ToolPointerEvent) {
		clearPreview(ctx);
		if (vertices.length >= 3) {
			const mask = rasterizePolygon(vertices, ctx.imageWidth, ctx.imageHeight);
			ctx.mask.composite(mask, modeFromModifiers(event));
			renderSelectionOverlay(ctx, ctx.mask);
		}
		vertices = [];
	}

	return {
		id: "polygon-lasso",
		label: "Polygon Lasso",
		icon: "⬡",
		shortcut: getEditorShortcutForSuiteTool("polygon-lasso"),
		kind: "selection",

		activate() {},
		deactivate(ctx) {
			clearPreview(ctx);
			vertices = [];
		},

		onPointerDown(ctx, event: ToolPointerEvent) {
			const now = Date.now();
			const isDoubleClick = now - lastDownTime < 280;
			lastDownTime = now;

			// Close on click near the first vertex, or on a double-click.
			if (vertices.length >= 3) {
				const first = vertices[0];
				const near = Math.hypot(event.image.x - first.x, event.image.y - first.y) <= CLOSE_DISTANCE_PX;
				if (near || isDoubleClick) {
					commit(ctx, event);
					return;
				}
			}
			vertices.push({ x: event.image.x, y: event.image.y });
			updatePreview(ctx);
		},

		onPointerMove(ctx, event: ToolPointerEvent) {
			if (vertices.length === 0) return;
			updatePreview(ctx, event.image);
		},

		onPointerUp() {
			// Polygon advances on down; up is a no-op.
		},
	};
}
