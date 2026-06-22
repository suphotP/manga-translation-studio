import { describe, expect, it } from "vitest";
import {
	buildPageExportManifestLayers,
	buildPageExportLayerStack,
	buildBatchExportFilename,
	buildPageExportPlan,
	exportPagesToZip,
	getPageExportBaseName,
	MissingLanguageOutputError,
	PageExportError,
	sanitizeExportSegment,
} from "$lib/project/page-export.js";
import type { ImageLayer, Page, ProjectState, TextLayer } from "$lib/types.js";

function makeLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "layer-1",
		text: "สวัสดี",
		x: 10,
		y: 12,
		w: 120,
		h: 40,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function makeImageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "image-layer-1",
		imageId: "image-layer-1.png",
		imageName: "image-layer-1.png",
		x: 10,
		y: 12,
		w: 120,
		h: 40,
		rotation: 0,
		opacity: 1,
		index: 0,
		...overrides,
	};
}

function makePage(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "base-image",
		imageName: "page.webp",
		originalName: "page.webp",
		textLayers: [makeLayer()],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function makeProject(pages: Page[]): ProjectState {
	return {
		projectId: "project-1",
		name: "Chapter: 01",
		createdAt: "2026-05-12T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages,
	};
}

describe("page export planning", () => {
	it("sanitizes unsafe filename segments without stripping readable names", () => {
		expect(sanitizeExportSegment(" Page: 01 / draft? ")).toBe("Page- 01 - draft");
		expect(sanitizeExportSegment("")).toBe("page");
	});

	it("builds deterministic page export filenames and prefers edited image ids", () => {
		const project = makeProject([
			makePage({ imageId: "p1", originalName: "same.webp", edits: { imageId: "edited-p1" } }),
			makePage({ imageId: "p2", originalName: "same.webp" }),
			makePage({ imageId: "p3", originalName: "ignored.webp" }),
		]);

		const plan = buildPageExportPlan(project, [0, 1, 1, 99]);

		expect(plan).toHaveLength(2);
		expect(plan[0]).toMatchObject({
			pageIndex: 0,
			pageNumber: 1,
			imageId: "edited-p1",
			baseName: "same",
			filename: "001_same_merged.png",
			layerCount: 1,
		});
		expect(plan[1].filename).toBe("002_same-2_merged.png");
	});

	it("derives base names and chapter zip names predictably", () => {
		const project = makeProject([makePage({ originalName: "scene.final.png" })]);
		const exportedAt = new Date("2026-05-12T12:34:56.000Z");

		expect(getPageExportBaseName(project.pages[0], 0)).toBe("scene.final");
		expect(buildBatchExportFilename(project, 1, exportedAt)).toBe("Chapter- 01_1p_2026-05-12-12-34-56.zip");
	});

	it("keeps batch export layer order aligned with the mixed canvas stack", () => {
		const page = makePage({
			imageLayers: [
				makeImageLayer({ id: "image-under", zIndex: 0, visible: true }),
				makeImageLayer({ id: "image-over", zIndex: 3, visible: true }),
				makeImageLayer({ id: "hidden-image", zIndex: 4, visible: false }),
			],
			textLayers: [
				makeLayer({ id: "text-middle", zIndex: 1, visible: true }),
				makeLayer({ id: "hidden-text", zIndex: 2, visible: false }),
			],
		});

		expect(buildPageExportLayerStack(page).map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
			"image:image-under",
			"text:text-middle",
			"image:image-over",
		]);
	});

	it("describes the export manifest layer stack with roles, order, and effect truth", () => {
		const page = makePage({
			imageLayers: [
				makeImageLayer({ id: "credit-logo", name: "Credit logo", role: "credit", zIndex: 2 }),
				makeImageLayer({ id: "ai-result-proof", name: "AI proof", aiMarkerId: "marker-1", zIndex: 0 }),
			],
			textLayers: [
				makeLayer({
					id: "sfx-text",
					name: "Scream SFX",
					sourceCategory: "sfx",
					sourceProvider: "manual",
					zIndex: 1,
					strokeWidth: 8,
					effects: {
						outerGlow: { enabled: true, color: "#38bdf8", blur: 32, opacity: 0.8 },
						passes: [{ enabled: true, fill: "#001122", strokeWidth: 12, offsetX: 3, offsetY: 4, opacity: 0.9 }],
						accentShadows: [{ enabled: true, color: "#f0abfc", blur: 20, offsetX: 4, offsetY: 5, opacity: 0.7 }],
					},
				}),
			],
		});

		expect(buildPageExportManifestLayers(page)).toEqual([
			expect.objectContaining({
				kind: "image",
				id: "ai-result-proof",
				sourceCategory: "ai-result",
				zIndex: 0,
			}),
			expect.objectContaining({
				kind: "text",
				id: "sfx-text",
				sourceCategory: "sfx",
				sourceProvider: "manual",
				zIndex: 1,
				effectsSummary: expect.objectContaining({
					stroke: true,
					outerGlow: true,
					passCount: 1,
					accentShadowCount: 1,
				}),
			}),
			expect.objectContaining({
				kind: "image",
				id: "credit-logo",
				role: "credit",
				sourceCategory: "credit",
				zIndex: 2,
			}),
		]);
	});

	it("wraps page render failures with page identity", () => {
		const error = new PageExportError(2, 3, new Error("renderer lost asset"));

		expect(error.name).toBe("PageExportError");
		expect(error.pageIndex).toBe(2);
		expect(error.pageNumber).toBe(3);
		expect(error.message).toContain("Export หน้า 3 ล้มเหลว");
		expect(error.message).toContain("renderer lost asset");
	});

	it("exports the flat textLayers verbatim when no lang is given (single-language)", () => {
		const page = makePage({ textLayers: [makeLayer({ id: "flat-1", text: "Hello" })] });

		expect(buildPageExportLayerStack(page).map((entry) => entry.layer.text)).toEqual(["Hello"]);
		expect(buildPageExportManifestLayers(page).map((layer) => layer.name)).toEqual(["Hello"]);
	});

	it("exports each Language Track's own text (track A vs track B differ)", () => {
		const page = makePage({
			textLayers: [makeLayer({ id: "shared", text: "EN default" })],
			languageOutputs: {
				TH: { textLayers: [makeLayer({ id: "shared", text: "TH translated" })] },
				JA: { textLayers: [makeLayer({ id: "shared", text: "JA translated" })] },
			},
		});

		// Default/flat track renders the flat layer; each materialized track renders its own.
		expect(buildPageExportLayerStack(page, "EN").map((entry) => entry.layer.text)).toEqual(["EN default"]);
		expect(buildPageExportLayerStack(page, "TH").map((entry) => entry.layer.text)).toEqual(["TH translated"]);
		expect(buildPageExportLayerStack(page, "JA").map((entry) => entry.layer.text)).toEqual(["JA translated"]);
	});

	it("composites the per-language imageLayers override when languageOutputs[lang] declares one (backend parity)", () => {
		// A page whose JA track overrides BOTH text and the image stack: the JA bucket
		// carries its own `imageLayers` (e.g. a re-typeset overlay / per-language SFX
		// raster). The client export MUST composite that override, exactly as the backend
		// `resolveExportImageLayers` reads `languageOutputs[track].imageLayers`.
		const page = makePage({
			imageLayers: [makeImageLayer({ id: "flat-image", zIndex: 0 })],
			textLayers: [makeLayer({ id: "shared", text: "EN default" })],
			languageOutputs: {
				JA: {
					textLayers: [makeLayer({ id: "shared", text: "JA translated" })],
					// `imageLayers` is read defensively off the raw bucket (not on the
					// PageLanguageOutput type yet), mirroring the backend.
					imageLayers: [makeImageLayer({ id: "ja-only-image", zIndex: 0 })],
				} as never,
			},
		});

		// JA track composites its OWN image stack, not the flat one.
		expect(
			buildPageExportLayerStack(page, "JA")
				.filter((entry) => entry.kind === "image")
				.map((entry) => entry.id),
		).toEqual(["ja-only-image"]);
		// ...and its own text alongside it.
		expect(buildPageExportLayerStack(page, "JA").map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
			"image:ja-only-image",
			"text:shared",
		]);
	});

	it("falls back to flat page.imageLayers when the track has no imageLayers override (backend parity)", () => {
		// TH track overrides text only — no per-language image override. Both an
		// un-materialized track (EN/flat) and a text-only materialized track (TH) must
		// fall back to the shared/source `page.imageLayers`, matching the backend.
		const page = makePage({
			imageLayers: [makeImageLayer({ id: "flat-image", zIndex: 0 })],
			textLayers: [makeLayer({ id: "shared", text: "EN default" })],
			languageOutputs: {
				TH: { textLayers: [makeLayer({ id: "shared", text: "TH translated" })] },
			},
		});

		const imageIds = (lang?: string) =>
			buildPageExportLayerStack(page, lang)
				.filter((entry) => entry.kind === "image")
				.map((entry) => entry.id);

		// Legacy single-call (no lang) and the un-materialized default track: flat stack.
		expect(imageIds(undefined)).toEqual(["flat-image"]);
		expect(imageIds("EN")).toEqual(["flat-image"]);
		// Materialized-but-text-only track: still the shared flat image stack.
		expect(imageIds("TH")).toEqual(["flat-image"]);
	});
});
