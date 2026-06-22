// Image-edit suite v1 (W3.13) — selection overlay.
//
// Renders the active MaskBuffer as a translucent Fabric image overlay so the
// user can see what is selected. This is a scene-space visual only; the mask of
// record stays in image-space inside the MaskBuffer.

import { makeImageData } from "./raster.js";
import type { MaskBuffer } from "./mask-buffer.js";
import type { ToolContext } from "./types.js";

const OVERLAY_NAME = "__w313_selection_overlay";

/** Build (or refresh) the selection overlay Fabric image from the mask. */
export function renderSelectionOverlay(ctx: ToolContext, mask: MaskBuffer): void {
	if (!ctx.canvas || !ctx.fabric) return;
	removeSelectionOverlay(ctx);
	if (mask.isEmpty()) {
		ctx.requestRender();
		return;
	}
	if (typeof document === "undefined") return;
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, mask.width);
	canvas.height = Math.max(1, mask.height);
	const c2d = canvas.getContext("2d");
	// Paint the translucent tint when a functional 2D context is available. A
	// headless context (e.g. CI without node-canvas) returns null/no-op here; we
	// still build the overlay object below so selection state stays observable.
	if (c2d) {
		const rgba = mask.toRGBA([56, 189, 248]);
		// Halve alpha for a translucent tint.
		for (let i = 3; i < rgba.length; i += 4) rgba[i] = Math.round(rgba[i] * 0.45);
		c2d.putImageData(makeImageData(rgba, mask.width, mask.height), 0, 0);
	}

	const FabricImage = ctx.fabric.FabricImage ?? ctx.fabric.Image;
	if (!FabricImage) return;
	const img = new FabricImage(canvas, {
		left: ctx.imageBounds.left,
		top: ctx.imageBounds.top,
		selectable: false,
		evented: false,
		hasControls: false,
		hasBorders: false,
		objectCaching: false,
	});
	const sx = mask.width > 0 ? ctx.imageBounds.width / mask.width : 1;
	const sy = mask.height > 0 ? ctx.imageBounds.height / mask.height : 1;
	img.set({ scaleX: sx, scaleY: sy });
	(img as any)[OVERLAY_NAME] = true;
	img.set("name", OVERLAY_NAME);
	ctx.canvas.add(img);
	ctx.canvas.bringObjectToFront?.(img);
	ctx.requestRender();
}

export function removeSelectionOverlay(ctx: ToolContext): void {
	if (!ctx.canvas?.getObjects) return;
	const existing = ctx.canvas.getObjects().filter((o: any) => o?.[OVERLAY_NAME] || o?.name === OVERLAY_NAME);
	for (const o of existing) ctx.canvas.remove(o);
}

export { OVERLAY_NAME as SELECTION_OVERLAY_NAME };
