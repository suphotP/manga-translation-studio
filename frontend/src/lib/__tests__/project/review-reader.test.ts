import { describe, expect, it } from "vitest";
import {
	buildReviewReaderPages,
	estimateReaderPageHeight,
	initialReaderPageHeight,
	overlayOpacityForView,
	readerPageAspectRatio,
	resolvePageSourceSize,
	shouldShowTranslatedOverlay,
} from "$lib/project/review-reader.ts";
import { computeStripWindow } from "$lib/project/strip-virtualization.ts";
import type { ImageLayer, Page, ProjectState, TextLayer } from "$lib/types.ts";

function textLayer(id: string, overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id,
		text: "สวัสดี",
		x: 0,
		y: 0,
		w: 100,
		h: 40,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "img-1",
		imageId: "img-1.png",
		imageName: "img-1.png",
		x: 0,
		y: 0,
		w: 1500,
		h: 2100,
		rotation: 0,
		opacity: 1,
		index: 0,
		...overrides,
	};
}

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "p.png",
		imageName: "p.png",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(pages: Page[], overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "proj-1",
		name: "Chapter",
		createdAt: "2026-06-01T00:00:00.000Z",
		targetLang: "th",
		currentPage: 0,
		pages,
		...overrides,
	} as ProjectState;
}

describe("review-reader", () => {
	describe("resolvePageSourceSize", () => {
		it("prefers sourceW/sourceH of the base image layer", () => {
			const p = page({ imageLayers: [imageLayer({ sourceW: 3000, sourceH: 4000, w: 750, h: 1000 })] });
			expect(resolvePageSourceSize(p)).toEqual({ width: 3000, height: 4000 });
		});

		it("falls back to placed w/h when source dims absent", () => {
			const p = page({ imageLayers: [imageLayer({ w: 1500, h: 2100 })] });
			expect(resolvePageSourceSize(p)).toEqual({ width: 1500, height: 2100 });
		});

		it("ignores overlay/credit layers when finding the base", () => {
			const p = page({
				imageLayers: [
					imageLayer({ id: "ov", role: "overlay", index: 0, sourceW: 10, sourceH: 10 }),
					imageLayer({ id: "base", index: 1, sourceW: 2000, sourceH: 3000 }),
				],
			});
			expect(resolvePageSourceSize(p)).toEqual({ width: 2000, height: 3000 });
		});

		it("returns null when no usable image layer exists", () => {
			expect(resolvePageSourceSize(page())).toBeNull();
		});
	});

	describe("buildReviewReaderPages", () => {
		const previewId = (p: Page) => p.imageId ?? null;

		it("returns [] for a null project", () => {
			expect(buildReviewReaderPages(null, previewId)).toEqual([]);
		});

		it("marks textless pages and carries visible translated text layers", () => {
			const p = project([
				page({ imageId: "a.png", textLayers: [textLayer("t1")] }),
				page({ imageId: "b.png", textLayers: [] }),
				page({ imageId: "c.png", textLayers: [textLayer("t2"), textLayer("t3", { visible: false })] }),
			]);
			const pages = buildReviewReaderPages(p, previewId);
			expect(pages.map((r) => r.textless)).toEqual([false, true, false]);
			// hidden layer excluded from the overlay set
			expect(pages[2].textLayers.map((l) => l.id)).toEqual(["t2"]);
			expect(pages[0].imageId).toBe("a.png");
		});

		it("reads text from the ACTIVE language track bucket", () => {
			const p = project(
				[page({
					imageId: "a.png",
					textLayers: [],
					languageOutputs: { en: { textLayers: [textLayer("en1")] } },
				})],
				{ targetLangs: ["th", "en"], activeTargetLang: "en" },
			);
			const pages = buildReviewReaderPages(p, previewId);
			expect(pages[0].textless).toBe(false);
			expect(pages[0].textLayers.map((l) => l.id)).toEqual(["en1"]);
		});
	});

	describe("layer-view helpers", () => {
		it("hides the translated overlay only for the original view", () => {
			expect(shouldShowTranslatedOverlay("original")).toBe(false);
			expect(shouldShowTranslatedOverlay("translated")).toBe(true);
			expect(shouldShowTranslatedOverlay("both")).toBe(true);
		});

		it("maps a view to overlay opacity", () => {
			expect(overlayOpacityForView("original")).toBe(0);
			expect(overlayOpacityForView("both")).toBeCloseTo(0.85);
			expect(overlayOpacityForView("translated")).toBe(1);
		});
	});

	describe("estimateReaderPageHeight", () => {
		it("scales by column width and clamps degenerate inputs", () => {
			expect(estimateReaderPageHeight(600, 1.5)).toBe(900);
			expect(estimateReaderPageHeight(0)).toBeGreaterThan(0);
		});
	});

	describe("readerPageAspectRatio", () => {
		it("uses the page's own source aspect (height/width)", () => {
			expect(readerPageAspectRatio({ sourceSize: { width: 3000, height: 4000 } })).toBeCloseTo(4 / 3);
			expect(readerPageAspectRatio({ sourceSize: { width: 2000, height: 1000 } })).toBeCloseTo(0.5);
		});

		it("falls back to a portrait default when source size is unknown/degenerate", () => {
			expect(readerPageAspectRatio({ sourceSize: null })).toBe(1.45);
			expect(readerPageAspectRatio({ sourceSize: { width: 0, height: 0 } })).toBe(1.45);
		});
	});

	describe("initialReaderPageHeight", () => {
		it("gives a tall scan a tall slot and a wide spread a short slot", () => {
			const tall = initialReaderPageHeight({ sourceSize: { width: 3000, height: 4000 } }, 600);
			const wide = initialReaderPageHeight({ sourceSize: { width: 4000, height: 2000 } }, 600);
			expect(tall).toBe(800); // 600 * 4/3
			expect(wide).toBe(300); // 600 * 0.5
			expect(tall).toBeGreaterThan(wide);
		});

		it("seeds a virtualization window that spans the WHOLE chapter (BUG 1)", () => {
			// 6 pages incl. a large 3000x4000 scan; honest per-page heights must make the
			// scroll geometry tall enough that the strip renders all pages over a scroll,
			// not collapse to one. Here we assert the total height accounts for every page.
			const sizes = [
				{ width: 1500, height: 2100 },
				{ width: 3000, height: 4000 },
				{ width: 1200, height: 1700 },
				{ width: 2000, height: 3000 },
				{ width: 1600, height: 2400 },
				{ width: 1400, height: 2000 },
			];
			const columnWidth = 720;
			const heights = sizes.map((sourceSize) => initialReaderPageHeight({ sourceSize }, columnWidth));
			expect(heights.every((h) => h > 0)).toBe(true);
			// Window over the FIRST screen must not be the whole list (it virtualizes)...
			const firstScreen = computeStripWindow({ pageHeights: heights, scrollTop: 0, viewportHeight: 900, gap: 16 });
			expect(firstScreen.totalHeight).toBeGreaterThan(900 * 3);
			// ...but scrolling to the bottom reaches the LAST page (proves geometry spans all).
			const bottom = computeStripWindow({
				pageHeights: heights,
				scrollTop: firstScreen.totalHeight,
				viewportHeight: 900,
				gap: 16,
			});
			expect(bottom.endIndex).toBe(sizes.length - 1);
		});
	});
});
