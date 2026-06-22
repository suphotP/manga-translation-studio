// Manga Editor tests — tests the core canvas editor logic
// We test through a mock-based approach since Fabric.js requires browser APIs

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	buildViewportTransformForImageRegion,
	buildViewportTransformForImageCenter,
	buildInitialImagePlacement,
	clampSourceCrop,
	resolveImageLayerSourceCrop,
	imageLayerBrushSourcePoint,
	classifySelectionTarget,
	EDITOR_CANVAS_OPTIONS,
	getViewportImageCenterRatio,
	INITIAL_IMAGE_TOP_GUTTER,
	LOCKED_PAGE_IMAGE_OPTIONS,
	getImageLayerSelectionChrome,
	getTextLayerSelectionChrome,
	resolveTouchPointerAction,
} from "$lib/canvas/editor.ts";

// Mock config
vi.mock("$lib/config.js", () => ({
	config: {
		defaultFontFamily: "Tahoma, sans-serif",
		defaultFontSize: 24,
		defaultText: "ข้อความ",
		canvas: { minZoom: 0.1, maxZoom: 5 },
	},
}));

describe("MangaEditor", () => {
	// Since MangaEditor uses dynamic import("fabric"), we can't easily mock it
	// in a unit test. Instead we test the pure logic functions extracted from the class.
	// For integration tests, use a real browser environment.

	describe("canvas render options", () => {
		it("keeps Fabric offscreen culling disabled for tall pages at high zoom", () => {
			expect(EDITOR_CANVAS_OPTIONS.skipOffscreen).toBe(false);
		});

		it("renders the locked page image without Fabric object caching at deep zoom", () => {
			expect(LOCKED_PAGE_IMAGE_OPTIONS.objectCaching).toBe(false);
			expect(LOCKED_PAGE_IMAGE_OPTIONS.noScaleCache).toBe(false);
			expect(LOCKED_PAGE_IMAGE_OPTIONS.selectable).toBe(false);
			expect(LOCKED_PAGE_IMAGE_OPTIONS.evented).toBe(false);
		});
	});

	describe("layer selection chrome", () => {
		it("makes credit text and image layers visibly draggable", () => {
			const textChrome = getTextLayerSelectionChrome({ sourceCategory: "credit" });
			const imageChrome = getImageLayerSelectionChrome({
				id: "credit-image",
				imageName: "credit.png",
				originalName: "credit.png",
				role: "credit",
			});

			expect(textChrome.borderColor).toContain("251, 191, 36");
			expect(imageChrome.borderColor).toBe(textChrome.borderColor);
			expect(textChrome.hoverCursor).toBe("grab");
			expect(textChrome.moveCursor).toBe("grabbing");
			expect(textChrome.cornerSize).toBeGreaterThan(getTextLayerSelectionChrome({ sourceCategory: "other" }).cornerSize);
		});

		it("keeps AI result selection visually distinct from credit placement", () => {
			const aiChrome = getImageLayerSelectionChrome({
				id: "ai-result-marker-1",
				imageName: "ai-result-marker-1.webp",
				originalName: "ผล AI หน้า 1",
				role: "overlay",
			});
			const creditChrome = getImageLayerSelectionChrome({
				id: "credit-image",
				imageName: "credit.png",
				originalName: "credit.png",
				role: "credit",
			});

			expect(aiChrome.borderColor).toContain("110, 231, 211");
			expect(aiChrome.borderColor).not.toBe(creditChrome.borderColor);
			expect(aiChrome.cornerSize).toBeLessThan(creditChrome.cornerSize);
		});
	});

	describe("viewport center preservation", () => {
		it("captures the visible center as an image-space ratio", () => {
			const center = getViewportImageCenterRatio({
				viewportTransform: [4, 0, 0, 4, -1200, -1600],
				viewportWidth: 800,
				viewportHeight: 600,
				zoom: 4,
				imageBounds: { left: 100, top: 200, width: 1000, height: 2000 },
			});

			expect(center).toEqual({
				xRatio: 0.3,
				yRatio: 0.1375,
			});
		});

		it("rebuilds the viewport transform around the same image-space center after resize", () => {
			const transform = buildViewportTransformForImageCenter({
				viewportTransform: [4, 0, 0, 4, -1200, -1600],
				viewportWidth: 900,
				viewportHeight: 700,
				zoom: 4,
				imageBounds: { left: 50, top: 0, width: 800, height: 3200 },
				centerRatio: { xRatio: 0.3, yRatio: 0.5 },
			});

			expect(transform).toEqual([4, 0, 0, 4, -710, -6050]);
		});

		it("clamps center ratios when an old viewport is outside the image", () => {
			const center = getViewportImageCenterRatio({
				viewportTransform: [8, 0, 0, 8, 2000, 1000],
				viewportWidth: 800,
				viewportHeight: 600,
				zoom: 8,
				imageBounds: { left: 100, top: 200, width: 1000, height: 2000 },
			});

			expect(center).toEqual({ xRatio: 0, yRatio: 0 });
		});

		it("rebuilds the viewport transform around an AI review region center", () => {
			const transform = buildViewportTransformForImageRegion({
				viewportTransform: [1, 0, 0, 1, 0, 0],
				viewportWidth: 800,
				viewportHeight: 600,
				zoom: 2,
				imageBounds: { left: 100, top: 200, width: 1000, height: 2000 },
				imageWidth: 1000,
				imageHeight: 2000,
				region: { x: 250, y: 200, w: 100, h: 150 },
			});

			expect(transform).toEqual([2, 0, 0, 2, -400, -650]);
		});
	});

	describe("canvas dimension calculation", () => {
		const MAX_WIDTH = 1024;

		it("caps width at MAX_WIDTH for large images", () => {
			const imgW = 2000;
			const imgH = 3000;
			const canvasW = Math.min(imgW, MAX_WIDTH);
			const canvasH = Math.round((imgH * MAX_WIDTH) / imgW);
			expect(canvasW).toBe(1024);
			expect(canvasH).toBe(1536);
		});

		it("uses original dimensions for small images", () => {
			const imgW = 800;
			const imgH = 600;
			const canvasW = Math.min(imgW, MAX_WIDTH);
			const canvasH = imgW > MAX_WIDTH ? Math.round((imgH * MAX_WIDTH) / imgW) : imgH;
			expect(canvasW).toBe(800);
			expect(canvasH).toBe(600);
		});

		it("uses original dimensions at exactly max width", () => {
			const imgW = 1024;
			const imgH = 768;
			const canvasW = Math.min(imgW, MAX_WIDTH);
			const canvasH = imgW > MAX_WIDTH ? Math.round((imgH * MAX_WIDTH) / imgW) : imgH;
			expect(canvasW).toBe(1024);
			expect(canvasH).toBe(768);
		});

		it("handles square images", () => {
			const imgW = 3000;
			const imgH = 3000;
			const canvasW = Math.min(imgW, MAX_WIDTH);
			const canvasH = Math.round((imgH * MAX_WIDTH) / imgW);
			expect(canvasW).toBe(1024);
			expect(canvasH).toBe(1024);
		});
	});

	describe("cover crop coordinate conversion", () => {
		it("converts canvas space to image space", () => {
			const canvasW = 800;
			const canvasH = 600;
			const imgW = 1200;
			const imgH = 900;
			const scaleX = imgW / canvasW;
			const scaleY = imgH / canvasH;

			const rect = { left: 100, top: 150, width: 200, height: 300 };
			const crop = {
				x: Math.round(rect.left * scaleX),
				y: Math.round(rect.top * scaleY),
				w: Math.round(rect.width * scaleX),
				h: Math.round(rect.height * scaleY),
			};

			expect(crop).toEqual({ x: 150, y: 225, w: 300, h: 450 });
		});

		it("returns identity when canvas matches image", () => {
			const canvasW = 800;
			const canvasH = 600;
			const imgW = 800;
			const imgH = 600;
			const scaleX = imgW / canvasW;
			const scaleY = imgH / canvasH;

			const rect = { left: 100, top: 200, width: 300, height: 150 };
			const crop = {
				x: Math.round(rect.left * scaleX),
				y: Math.round(rect.top * scaleY),
				w: Math.round(rect.width * scaleX),
				h: Math.round(rect.height * scaleY),
			};

			expect(crop).toEqual({ x: 100, y: 200, w: 300, h: 150 });
		});
	});

	describe("cover selection bounds clamping", () => {
		it("clamps selection to canvas bounds", () => {
			const canvasW = 800;
			const canvasH = 600;

			let left = -100;
			let top = -50;
			let width = 1000;
			let height = 800;

			left = Math.max(0, left);
			top = Math.max(0, top);
			width = Math.min(width, canvasW - left);
			height = Math.min(height, canvasH - top);

			expect(left).toBe(0);
			expect(top).toBe(0);
			expect(width).toBe(800);
			expect(height).toBe(600);
		});

		it("clamps partial overflow", () => {
			const canvasW = 800;
			const canvasH = 600;

			let left = 700;
			let top = 500;
			let width = 200;
			let height = 200;

			left = Math.max(0, left);
			top = Math.max(0, top);
			width = Math.min(width, canvasW - left);
			height = Math.min(height, canvasH - top);

			expect(left).toBe(700);
			expect(top).toBe(500);
			expect(width).toBe(100);
			expect(height).toBe(100);
		});

		it("allows full canvas selection", () => {
			const canvasW = 800;
			const canvasH = 600;

			let left = 0;
			let top = 0;
			let width = 800;
			let height = 600;

			left = Math.max(0, left);
			top = Math.max(0, top);
			width = Math.min(width, canvasW - left);
			height = Math.min(height, canvasH - top);

			expect(left).toBe(0);
			expect(top).toBe(0);
			expect(width).toBe(800);
			expect(height).toBe(600);
		});
	});

	describe("text layer coordinate conversion", () => {
		it("converts image-space layer to canvas-space when adding", () => {
			const imgW = 2000;
			const imgH = 1500;
			const canvasW = 1024;
			const canvasH = 768;
			const scaleX = canvasW / imgW;
			const scaleY = canvasH / imgH;

			const layer = { x: 500, y: 300, w: 400, h: 200, fontSize: 48 };
			expect(layer.x * scaleX).toBeCloseTo(256, 0);
			expect(layer.y * scaleY).toBeCloseTo(153.6, 0);
			expect(layer.fontSize * scaleX).toBeCloseTo(24.576, 0);
		});

		it("converts canvas-space layer back to image-space when saving", () => {
			const imgW = 2000;
			const imgH = 1500;
			const canvasW = 1024;
			const canvasH = 768;
			const scaleX = imgW / canvasW;
			const scaleY = imgH / canvasH;

			// Canvas position 256, 153.6 → image position 500, 300
			expect(Math.round(256 * scaleX)).toBe(500);
			expect(Math.round(153.6 * scaleY)).toBe(300);
		});
	});

	describe("image locking behavior", () => {
		it("image must be non-selectable and locked", () => {
			const imgProps = {
				selectable: LOCKED_PAGE_IMAGE_OPTIONS.selectable,
				evented: LOCKED_PAGE_IMAGE_OPTIONS.evented,
				lockMovementX: LOCKED_PAGE_IMAGE_OPTIONS.lockMovementX,
				lockMovementY: LOCKED_PAGE_IMAGE_OPTIONS.lockMovementY,
				hasControls: LOCKED_PAGE_IMAGE_OPTIONS.hasControls,
				hasBorders: LOCKED_PAGE_IMAGE_OPTIONS.hasBorders,
			};
			// All lock properties should be true/false as set
			expect(imgProps.selectable).toBe(false);
			expect(imgProps.evented).toBe(false);
			expect(imgProps.lockMovementX).toBe(true);
			expect(imgProps.lockMovementY).toBe(true);
		});
	});

	describe("initial image placement", () => {
		it("anchors short page images near the top of tall editor workspaces", () => {
			const placement = buildInitialImagePlacement({
				canvasWidth: 537,
				canvasHeight: 1096,
				imageWidth: 1042,
				imageHeight: 912,
			});

			expect(Math.round(placement.top)).toBe(INITIAL_IMAGE_TOP_GUTTER);
			expect(Math.round(placement.width)).toBe(537);
			expect(Math.round(placement.height)).toBe(470);
		});

		it("still starts over-height webtoon images at the top", () => {
			const placement = buildInitialImagePlacement({
				canvasWidth: 600,
				canvasHeight: 900,
				imageWidth: 1000,
				imageHeight: 3000,
				fitTallImageByWidth: true,
			});

			expect(placement.top).toBe(0);
			expect(Math.round(placement.height)).toBe(1800);
		});
	});

	describe("iPad touch routing for the image-edit suite", () => {
		const base = {
			pointerType: "touch",
			touchPointerCount: 1,
			tool: "select",
			imageToolActive: false,
			isSpacePressed: false,
			hasTarget: false,
		};

		it("forwards a single finger drag to the image tool when one is active", () => {
			expect(resolveTouchPointerAction({ ...base, imageToolActive: true })).toBe("image-tool");
		});

		it("forwards a single Apple-Pencil drag to the image tool when one is active", () => {
			expect(
				resolveTouchPointerAction({ ...base, pointerType: "pen", imageToolActive: true }),
			).toBe("image-tool");
		});

		it("pans/zooms on a two-finger gesture even while an image tool is active", () => {
			expect(
				resolveTouchPointerAction({ ...base, imageToolActive: true, touchPointerCount: 2 }),
			).toBe("pinch");
		});

		it("pans on a two-finger gesture with the plain select tool", () => {
			expect(resolveTouchPointerAction({ ...base, touchPointerCount: 2 })).toBe("pinch");
		});

		it("pans a single finger over empty canvas with the plain select tool", () => {
			expect(resolveTouchPointerAction(base)).toBe("pan");
		});

		it("does not pan a single finger that lands on a selectable object", () => {
			expect(resolveTouchPointerAction({ ...base, hasTarget: true })).toBe("none");
		});

		it("lets Space+drag pan instead of drawing while an image tool is active", () => {
			expect(
				resolveTouchPointerAction({ ...base, imageToolActive: true, isSpacePressed: true }),
			).toBe("pan");
		});

		it("ignores mouse pointers (routed via the Fabric mouse path)", () => {
			expect(
				resolveTouchPointerAction({ ...base, pointerType: "mouse", imageToolActive: true }),
			).toBe("none");
		});
	});
});

describe("clampSourceCrop (AI result region-composite geometry)", () => {
	it("keeps a real sub-region crop inside a full-page result", () => {
		// Full-page result is 800x1600; the AI marker only edited a 120x80 box at
		// (10,20). The placed layer must draw ONLY that sub-rect, never the page.
		expect(clampSourceCrop({ x: 10, y: 20, w: 120, h: 80 }, 800, 1600)).toEqual({
			x: 10,
			y: 20,
			w: 120,
			h: 80,
		});
	});

	it("clamps a crop that runs past the source edge to stay on-canvas", () => {
		expect(clampSourceCrop({ x: 760, y: 1560, w: 200, h: 200 }, 800, 1600)).toEqual({
			x: 760,
			y: 1560,
			w: 40,
			h: 40,
		});
	});

	it("returns null when the crop already covers the whole image (plain full draw)", () => {
		expect(clampSourceCrop({ x: 0, y: 0, w: 800, h: 1600 }, 800, 1600)).toBeNull();
		// Region-sized legacy results: natural == region => whole image => no crop.
		expect(clampSourceCrop({ x: 0, y: 0, w: 120, h: 80 }, 120, 80)).toBeNull();
	});

	it("returns null for absent / non-finite / zero-size crops", () => {
		expect(clampSourceCrop(undefined, 800, 1600)).toBeNull();
		expect(clampSourceCrop(null, 800, 1600)).toBeNull();
		expect(clampSourceCrop({ x: Number.NaN, y: 0, w: 10, h: 10 }, 800, 1600)).toBeNull();
		expect(clampSourceCrop({ x: 10, y: 20, w: 120, h: 80 }, 0, 0)).toBeNull();
	});
});

describe("resolveImageLayerSourceCrop (shared by live render + export)", () => {
	// This is the SINGLE crop helper called by both createImageObject (live) and
	// createExportImageObject (export). Identical inputs => identical fabric
	// cropX/cropY/width/height + scale, which is what guarantees the exported
	// pixels match the screen.
	it("crops a full-page result to its region and scales the SUB-RECT (not the page) onto the box", () => {
		// Page result 800x1600; AI edited a 120x80 box at (10,20). Target box is the
		// 120x80 region. Export must crop to the sub-rect, NOT squeeze the page.
		const placement = resolveImageLayerSourceCrop({
			sourceCrop: { x: 10, y: 20, w: 120, h: 80 },
			naturalWidth: 800,
			naturalHeight: 1600,
			targetWidth: 120,
			targetHeight: 80,
		});
		expect(placement.crop).toEqual({ x: 10, y: 20, w: 120, h: 80 });
		// Scale maps the 120x80 crop sub-rect onto the 120x80 box => 1:1, NOT
		// 120/800 (which would squeeze the whole page into the box).
		expect(placement.scaleX).toBeCloseTo(1, 6);
		expect(placement.scaleY).toBeCloseTo(1, 6);
		expect(placement.scaleX).not.toBeCloseTo(120 / 800, 4);
	});

	it("produces the SAME crop+scale for live (canvas-space) and export (image-space) boxes", () => {
		const crop = { x: 10, y: 20, w: 120, h: 80 };
		// Live render passes canvas-space target (here 1:1 canvas), export passes
		// image-space (layer.w/h). With the same target box the results are equal.
		const live = resolveImageLayerSourceCrop({ sourceCrop: crop, naturalWidth: 800, naturalHeight: 1600, targetWidth: 120, targetHeight: 80 });
		const exported = resolveImageLayerSourceCrop({ sourceCrop: crop, naturalWidth: 800, naturalHeight: 1600, targetWidth: 120, targetHeight: 80 });
		expect(exported.crop).toEqual(live.crop);
		expect(exported.scaleX).toBeCloseTo(live.scaleX, 9);
		expect(exported.scaleY).toBeCloseTo(live.scaleY, 9);
	});

	it("draws a region-sized result whole (no crop) and scales the full image onto the box", () => {
		// Legacy/region-sized result: natural == region. No crop; scale maps the
		// whole image onto the box.
		const placement = resolveImageLayerSourceCrop({
			sourceCrop: undefined,
			naturalWidth: 120,
			naturalHeight: 80,
			targetWidth: 120,
			targetHeight: 80,
		});
		expect(placement.crop).toBeNull();
		expect(placement.drawWidth).toBe(120);
		expect(placement.drawHeight).toBe(80);
		expect(placement.scaleX).toBeCloseTo(1, 6);
	});

	it("scales a crop sub-rect onto a differently-sized target box", () => {
		const placement = resolveImageLayerSourceCrop({
			sourceCrop: { x: 0, y: 0, w: 100, h: 50 },
			naturalWidth: 800,
			naturalHeight: 1600,
			targetWidth: 200,
			targetHeight: 150,
		});
		expect(placement.crop).toEqual({ x: 0, y: 0, w: 100, h: 50 });
		expect(placement.scaleX).toBeCloseTo(200 / 100, 6);
		expect(placement.scaleY).toBeCloseTo(150 / 50, 6);
	});

	describe("image-layer brush source point (cropped-layer coord fix, agy04)", () => {
		it("uncropped layer: local origin maps to the image center", () => {
			// No crop → cropOrigin 0, cropSpan = full size → offset by full half-extent.
			const p = imageLayerBrushSourcePoint({
				localX: 0,
				localY: 0,
				fullWidth: 800,
				fullHeight: 1200,
			});
			expect(p).toEqual({ x: 400, y: 600 });
		});

		it("uncropped layer: a corner of the local box maps to the source corner", () => {
			const p = imageLayerBrushSourcePoint({
				localX: -400,
				localY: -600,
				fullWidth: 800,
				fullHeight: 1200,
			});
			expect(p).toEqual({ x: 0, y: 0 });
		});

		it("cropped layer: local origin maps to the CROP center in FULL-SOURCE pixels (not the image center)", () => {
			// Crop sub-rect (x=500,y=900,w=200,h=150) of an 800x1200 source. The brush
			// target canvas is full-source, so the crop center must land at the crop's
			// real source-pixel center (600, 975) — NOT the full image center (400,600).
			const p = imageLayerBrushSourcePoint({
				localX: 0,
				localY: 0,
				fullWidth: 800,
				fullHeight: 1200,
				cropX: 500,
				cropY: 900,
				cropWidth: 200,
				cropHeight: 150,
			});
			expect(p).toEqual({ x: 600, y: 975 });
		});

		it("cropped layer: the previous (buggy) full-half-extent offset would land elsewhere", () => {
			// Regression guard: the OLD code returned localX + fullWidth/2 = 400, which is
			// outside the crop entirely. The fixed value is the crop center.
			const p = imageLayerBrushSourcePoint({
				localX: 0,
				localY: 0,
				fullWidth: 800,
				fullHeight: 1200,
				cropX: 500,
				cropY: 900,
				cropWidth: 200,
				cropHeight: 150,
			});
			expect(p?.x).not.toBe(400);
			expect(p?.x).toBe(600);
		});

		it("cropped layer: a pointer outside the displayed crop region is rejected", () => {
			// Local point that maps to source X < cropX (left of the crop) → null.
			const p = imageLayerBrushSourcePoint({
				localX: -200,
				localY: 0,
				fullWidth: 800,
				fullHeight: 1200,
				cropX: 500,
				cropY: 900,
				cropWidth: 200,
				cropHeight: 150,
			});
			expect(p).toBeNull();
		});

		it("cropped layer: corners of the crop map to the crop bounds in source pixels", () => {
			const tl = imageLayerBrushSourcePoint({
				localX: -100,
				localY: -75,
				fullWidth: 800,
				fullHeight: 1200,
				cropX: 500,
				cropY: 900,
				cropWidth: 200,
				cropHeight: 150,
			});
			expect(tl).toEqual({ x: 500, y: 900 });
			const br = imageLayerBrushSourcePoint({
				localX: 100,
				localY: 75,
				fullWidth: 800,
				fullHeight: 1200,
				cropX: 500,
				cropY: 900,
				cropWidth: 200,
				cropHeight: 150,
			});
			expect(br).toEqual({ x: 700, y: 1050 });
		});
	});

	describe("selection target classification (multi-select persist fix, agy03)", () => {
		it("classifies a single text layer object", () => {
			expect(classifySelectionTarget({ hasTextLayerData: true, hasImageLayerData: false, childCount: 0 }))
				.toBe("text-layer");
		});

		it("classifies a single image layer object", () => {
			expect(classifySelectionTarget({ hasTextLayerData: false, hasImageLayerData: true, childCount: 0 }))
				.toBe("image-layer");
		});

		it("classifies a multi-selection group box (no layer data, has children)", () => {
			// The ActiveSelection wrapping >1 layer carries NO layer data itself — this
			// is exactly the case the old object:modified handler dropped, losing the
			// group transform on save/reload.
			expect(classifySelectionTarget({ hasTextLayerData: false, hasImageLayerData: false, childCount: 3 }))
				.toBe("multi-selection");
		});

		it("classifies an empty / non-layer target as none", () => {
			expect(classifySelectionTarget({ hasTextLayerData: false, hasImageLayerData: false, childCount: 0 }))
				.toBe("none");
		});
	});
});
