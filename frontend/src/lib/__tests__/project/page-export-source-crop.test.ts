import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageLayer, Page, ProjectState } from "$lib/types.js";

// Regression test for the #261 P1 follow-up: the BATCH/ZIP export path
// (page-export.ts createExportImageObject, used by exportPagesToZip) must apply
// a layer's sourceCrop exactly like the live render + single-page export.
//
// A full-page AI result placed over a small region must composite ONLY its crop
// sub-rect at the region — never the whole page squeezed into the region box.
// We mock fabric + the authed image loader so the test runs headless in jsdom
// and inspect the fabric image object the export builder produced.

// --- Fabric image object that records what the export builder set on it. ---
class FakeFabricImage {
	width: number;
	height: number;
	scaleX = 1;
	scaleY = 1;
	cropX: number | undefined;
	cropY: number | undefined;
	left = 0;
	top = 0;
	originX = "left";
	originY = "top";
	angle = 0;
	opacity = 1;
	flipX = false;
	flipY = false;
	globalCompositeOperation = "source-over";

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
	}

	set(props: Record<string, unknown>): this {
		Object.assign(this, props);
		return this;
	}

	getScaledWidth(): number {
		return this.width * this.scaleX;
	}

	getScaledHeight(): number {
		return this.height * this.scaleY;
	}

	getOriginalSize(): { width: number; height: number } {
		return { width: this.width, height: this.height };
	}

	scaleToWidth(width: number): void {
		this.scaleX = width / this.width;
		this.scaleY = width / this.width;
	}

	scaleToHeight(height: number): void {
		this.scaleX = height / this.height;
		this.scaleY = height / this.height;
	}
}

// Records every image object added to an export canvas so the test can find the
// image LAYER object (the one carrying the sourceCrop), as opposed to the
// page background.
const addedImageObjects: FakeFabricImage[] = [];

class FakeStaticCanvas {
	width: number;
	height: number;
	constructor(_el: unknown, options: { width: number; height: number }) {
		this.width = options.width;
		this.height = options.height;
	}
	add(object: unknown): void {
		if (object instanceof FakeFabricImage) addedImageObjects.push(object);
	}
	renderAll(): void {}
	toDataURL(): string {
		// Minimal 1x1 PNG so dataUrlToBlob() succeeds; pixel content is not asserted.
		return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC";
	}
	dispose(): void {}
}

// Map of image URL -> { width, height } so the loader can hand back an image of
// the right NATURAL size (the AI result is full-page sized).
const imageSizeByUrl = new Map<string, { width: number; height: number }>();

vi.mock("fabric", () => ({
	StaticCanvas: FakeStaticCanvas,
	FabricImage: {
		fromURL: vi.fn(async (url: string) => {
			const size = imageSizeByUrl.get(url) ?? { width: 1, height: 1 };
			return new FakeFabricImage(size.width, size.height);
		}),
	},
	Shadow: class {},
}));

vi.mock("$lib/api/client.js", async () => {
	const actual = await vi.importActual<typeof import("$lib/api/client.js")>("$lib/api/client.js");
	return {
		...actual,
		// Delegate to the mocked fabric so the export pipeline gets FakeFabricImages.
		loadAuthedFabricImage: vi.fn(async (fabric: any, url: string, options?: unknown) =>
			fabric.FabricImage.fromURL(url, options),
		),
		// Export-purpose loader (codex P1-A): same delegation so the crop math is
		// exercised through the export serve-gate path with mock resolver URLs.
		loadExportFabricImage: vi.fn(async (fabric: any, _projectId: string, _imageId: string, url: string, options?: unknown) =>
			fabric.FabricImage.fromURL(url, options),
		),
	};
});

const PAGE_W = 800;
const PAGE_H = 1600;
// Edited region: a 120x80 box at (10,20) on the page.
const REGION = { x: 10, y: 20, w: 120, h: 80 };

function makeProject(): ProjectState {
	const layer: ImageLayer = {
		id: "ai-result-layer",
		imageId: "ai-result.png",
		imageName: "ai-result.png",
		// Layer placed AT the region box on the page.
		x: REGION.x,
		y: REGION.y,
		w: REGION.w,
		h: REGION.h,
		rotation: 0,
		opacity: 1,
		index: 0,
		zIndex: 0,
		visible: true,
		// The stored result is a FULL-PAGE composite; sourceCrop pins the sub-rect
		// to paint back over.
		sourceCrop: { ...REGION },
		sourceW: PAGE_W,
		sourceH: PAGE_H,
		aiMarkerId: "marker-1",
	};
	const page: Page = {
		imageId: "page-bg",
		imageName: "page.webp",
		originalName: "page.webp",
		textLayers: [],
		imageLayers: [layer],
		pendingAiJobs: [],
		coverRect: null,
	};
	return {
		projectId: "project-1",
		name: "Chapter 01",
		createdAt: "2026-05-12T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [page],
	};
}

describe("batch/zip export applies sourceCrop (no squeeze)", () => {
	beforeEach(() => {
		addedImageObjects.length = 0;
		imageSizeByUrl.clear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("composites ONLY the crop sub-rect at the region, not the whole page squeezed", async () => {
		const { exportPagesToZip } = await import("$lib/project/page-export.js");

		// Both the page background and the AI-result layer image resolve to a
		// full-page-sized image. The resolver builds the API URL; we register the
		// natural size for whatever URL the export path requests.
		imageSizeByUrl.clear();
		const resolver = (imageId: string) => {
			const url = `mock://asset/${imageId}`;
			imageSizeByUrl.set(url, { width: PAGE_W, height: PAGE_H });
			return url;
		};

		const project = makeProject();
		await exportPagesToZip(project, [0], { imageUrlResolver: resolver });

		// Find the image-LAYER object: the one that received a crop (background has none).
		const layerImage = addedImageObjects.find((image) => image.cropX !== undefined);
		expect(layerImage, "expected a cropped image-layer object in the export canvas").toBeTruthy();

		// Crop sub-rect = the region, in source-image (full-page) pixels.
		expect(layerImage!.cropX).toBe(REGION.x);
		expect(layerImage!.cropY).toBe(REGION.y);
		expect(layerImage!.width).toBe(REGION.w);
		expect(layerImage!.height).toBe(REGION.h);

		// Crop-aware scale maps the SUB-RECT onto the box (here 1:1), NOT the whole
		// page squeezed into the box (which would be layer.w / PAGE_W).
		expect(layerImage!.scaleX).toBeCloseTo(REGION.w / REGION.w, 6);
		expect(layerImage!.scaleY).toBeCloseTo(REGION.h / REGION.h, 6);
		expect(layerImage!.scaleX).not.toBeCloseTo(REGION.w / PAGE_W, 4);
		expect(layerImage!.scaleY).not.toBeCloseTo(REGION.h / PAGE_H, 4);

		// Layer is placed (center origin) at the region's center on the page.
		expect(layerImage!.originX).toBe("center");
		expect(layerImage!.originY).toBe("center");
		expect(layerImage!.left).toBeCloseTo(REGION.x + REGION.w / 2, 6);
		expect(layerImage!.top).toBeCloseTo(REGION.y + REGION.h / 2, 6);
	});

	it("scales a crop sub-rect onto a differently-sized layer box (no squeeze)", async () => {
		const { exportPagesToZip } = await import("$lib/project/page-export.js");

		imageSizeByUrl.clear();
		const resolver = (imageId: string) => {
			const url = `mock://asset/${imageId}`;
			imageSizeByUrl.set(url, { width: PAGE_W, height: PAGE_H });
			return url;
		};

		// Crop sub-rect 100x50 of the full page, rendered onto a 200x150 layer box.
		const crop = { x: 0, y: 0, w: 100, h: 50 };
		const project = makeProject();
		const layer = project.pages[0].imageLayers![0];
		layer.sourceCrop = { ...crop };
		layer.w = 200;
		layer.h = 150;

		await exportPagesToZip(project, [0], { imageUrlResolver: resolver });

		const layerImage = addedImageObjects.find((image) => image.cropX !== undefined);
		expect(layerImage).toBeTruthy();
		expect(layerImage!.width).toBe(crop.w);
		expect(layerImage!.height).toBe(crop.h);
		// Scale = box / crop, never box / natural-page.
		expect(layerImage!.scaleX).toBeCloseTo(200 / crop.w, 6);
		expect(layerImage!.scaleY).toBeCloseTo(150 / crop.h, 6);
		expect(layerImage!.scaleX).not.toBeCloseTo(200 / PAGE_W, 4);
	});

	it("draws a region-sized (legacy) result whole, with no crop", async () => {
		const { exportPagesToZip } = await import("$lib/project/page-export.js");

		// Background is full page; the AI-result asset is region-sized (legacy).
		const project = makeProject();
		const layer = project.pages[0].imageLayers![0];
		delete layer.sourceCrop;
		layer.sourceW = REGION.w;
		layer.sourceH = REGION.h;

		const resolver = (imageId: string) => {
			const url = `mock://asset/${imageId}`;
			// Background page-sized; the result image region-sized.
			imageSizeByUrl.set(
				url,
				imageId === layer.imageId ? { width: REGION.w, height: REGION.h } : { width: PAGE_W, height: PAGE_H },
			);
			return url;
		};

		await exportPagesToZip(project, [0], { imageUrlResolver: resolver });

		// The region-sized layer image (natural REGION.w x REGION.h) gets no crop
		// and a full-image scale onto the box (1:1 here).
		const layerImage = addedImageObjects.find(
			(image) => image.width === REGION.w && image.height === REGION.h,
		);
		expect(layerImage, "expected the region-sized layer image").toBeTruthy();
		expect(layerImage!.cropX).toBeUndefined();
		expect(layerImage!.scaleX).toBeCloseTo(1, 6);
		expect(layerImage!.scaleY).toBeCloseTo(1, 6);
	});
});
