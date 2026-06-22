// Image-edit suite v1 (W3.13) — public barrel.
//
// W3.1's left dock imports from here. Re-exports the registry factory, the
// shared MaskBuffer, every tool factory, and the pure cores used by tests.

export * from "./types.js";
export { MaskBuffer, maskBuffer, modeFromModifiers } from "./mask-buffer.js";
export type { MaskBounds, MaskCompositeMode, MaskChangeListener } from "./mask-buffer.js";

export {
	ToolRegistry,
	createImageEditSuite,
	type ImageEditSuite,
	type RegistryPointerInput,
	type ActiveToolListener,
} from "./registry.js";

export { createMarqueeTool } from "./marquee-tool.js";
export { createLassoTool } from "./lasso-tool.js";
export { createPolygonLassoTool } from "./polygon-lasso-tool.js";
export { createMagicWandTool, floodFillSelection, type MagicWandOptions } from "./magic-wand-tool.js";
export { createColorRangeTool, selectColorRange, rgbToHsl, type ColorRangeOptions } from "./color-range-tool.js";
export {
	createRefineEdgeTool,
	type RefineEdgeApi,
} from "./refine-edge-tool.js";
export {
	dilateMask,
	erodeMask,
	featherMask,
	applyMorphology,
	type MorphologyOp,
} from "./morphology.js";
export { createHealingBrushTool, type HealingBrushOptions, type HealingBrushApi } from "./healing-brush-tool.js";
export { inpaintTelea } from "./inpaint.js";
export { createCloneStampTool, type CloneStampOptions } from "./clone-stamp-tool.js";

export {
	loadOpenCv,
	isOpenCvReady,
	type OpenCvModule,
	type OpenCvLoadCallbacks,
} from "./opencv-loader.js";

export {
	createWorkCanvas,
	makeImageData,
	readSourceImageData,
	rasterizePolygon,
	rasterizeFreehand,
	rasterizeRect,
	stampSoftBrush,
	compositeMasked,
	imageDataToDataUrl,
	imageDataToBlobUrl,
	canvasToBlobUrl,
	canvasToPngBlob,
} from "./raster.js";

export { renderSelectionOverlay, removeSelectionOverlay, SELECTION_OVERLAY_NAME } from "./selection-overlay.js";
