export type ImageRegion = {
	x: number;
	y: number;
	w: number;
	h: number;
};

export type WorkspaceRegionBox = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export type WorkspaceSize = {
	width: number;
	height: number;
};

export function getCanvasWorkspaceSize(editor: any): WorkspaceSize | null {
	const canvas = editor?.canvas;
	const canvasEl = canvas?.upperCanvasEl ?? canvas?.getElement?.();
	const workspace = canvasEl?.closest?.(".canvas-workspace") as HTMLElement | null;
	const rect = workspace?.getBoundingClientRect?.();

	if (!rect || rect.width <= 0 || rect.height <= 0) return null;
	return {
		width: rect.width,
		height: rect.height,
	};
}

/**
 * CSS for an <img> of the FULL result image, scaled+offset so that ONLY the
 * `region` sub-rectangle of the (full-page) result fills the overlay box.
 *
 * The AI result image is a full-page composite; the overlay box is sized to the
 * crop region in workspace px. We scale the full image so the region's pixel
 * size maps onto the box, then shift it so the region's top-left aligns with the
 * box top-left. The box itself uses `overflow:hidden` to clip everything else.
 *
 * `naturalSize` is the loaded result image's natural pixel size; `region` is in
 * the result image's own pixel coordinates. Returns "" when inputs are unusable
 * (so the caller can hide the preview rather than render a wrong crop).
 */
export function resultRegionPreviewStyle(
	box: Pick<WorkspaceRegionBox, "width" | "height">,
	region: ImageRegion,
	naturalSize: { width: number; height: number },
): string {
	if (region.w <= 0 || region.h <= 0) return "";
	if (naturalSize.width <= 0 || naturalSize.height <= 0) return "";
	if (box.width <= 0 || box.height <= 0) return "";
	// Map the region's pixel width onto the box width (and height onto height).
	// AI crops keep aspect via the box, so use independent scales to fill exactly.
	const scaleX = box.width / region.w;
	const scaleY = box.height / region.h;
	const displayWidth = naturalSize.width * scaleX;
	const displayHeight = naturalSize.height * scaleY;
	const offsetLeft = -region.x * scaleX;
	const offsetTop = -region.y * scaleY;
	return [
		"position:absolute",
		`width:${displayWidth}px`,
		`height:${displayHeight}px`,
		`left:${offsetLeft}px`,
		`top:${offsetTop}px`,
		"max-width:none",
		"max-height:none",
		"object-fit:fill",
		"pointer-events:none",
	].join(";");
}

export function imageRegionToWorkspaceBox(editor: any, region: ImageRegion): WorkspaceRegionBox | null {
	const canvas = editor?.canvas;
	const canvasEl = canvas?.upperCanvasEl ?? canvas?.getElement?.();
	const workspace = canvasEl?.closest?.(".canvas-workspace") as HTMLElement | null;
	const bounds = editor?.imageBounds;
	const vpt = canvas?.viewportTransform ?? [1, 0, 0, 1, 0, 0];

	if (
		!canvasEl
		|| !workspace
		|| !bounds
		|| editor.imageWidth <= 0
		|| editor.imageHeight <= 0
		|| bounds.width <= 0
		|| bounds.height <= 0
	) {
		return null;
	}

	const canvasRect = canvasEl.getBoundingClientRect();
	const workspaceRect = workspace.getBoundingClientRect();
	const scaleX = bounds.width / editor.imageWidth;
	const scaleY = bounds.height / editor.imageHeight;
	const zoomX = Number(vpt[0]) || 1;
	const zoomY = Number(vpt[3]) || zoomX;
	const sceneLeft = bounds.left + region.x * scaleX;
	const sceneTop = bounds.top + region.y * scaleY;
	const left = canvasRect.left - workspaceRect.left + sceneLeft * zoomX + (Number(vpt[4]) || 0);
	const top = canvasRect.top - workspaceRect.top + sceneTop * zoomY + (Number(vpt[5]) || 0);
	const width = Math.max(1, region.w * scaleX * Math.abs(zoomX));
	const height = Math.max(1, region.h * scaleY * Math.abs(zoomY));

	return { left, top, width, height };
}
