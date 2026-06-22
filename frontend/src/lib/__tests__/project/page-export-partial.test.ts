import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// FIX 2 (partial-export resilience): a missing/corrupt page must no longer kill
// the WHOLE chapter export. We mock the fabric + api boundaries so we can make a
// specific page's image load FAIL deterministically and assert that:
//   - the other pages still render and land in the ZIP,
//   - the failed page is reported as a skipped page (honest partial export),
//   - a layer-only compositing failure falls back to a source-only render,
//   - an all-pages-fail export still throws (no empty "success" ZIP).
// ---------------------------------------------------------------------------

// URLs containing this marker fail to load (simulated missing/corrupt asset).
const BAD_MARKER = "__BAD__";
// URLs containing this marker load as a background but fail when added as a
// compositing layer (simulated overlay/AI-result asset failure).
const BAD_LAYER_MARKER = "__BADLAYER__";

vi.mock("$lib/api/client.ts", () => ({
	imageUrl: (_projectId: string, imageId: string) => `https://test.local/${imageId}`,
	loadAuthedFabricImage: vi.fn(async (_fabric: unknown, url: string) => {
		if (url.includes(BAD_MARKER)) {
			throw new Error(`image load failed: ${url}`);
		}
		return makeFakeImage(url);
	}),
	// Export-purpose loader (codex P1-A) — the export render path fetches background /
	// layer / mask / patch assets through the server export serve-gate. Mirror the
	// editor_preview loader's bad-marker failure semantics so the partial-export
	// behavior (skip on background fail, source-only on layer/mask/patch fail) is
	// unchanged by the purpose switch.
	loadExportFabricImage: vi.fn(async (_fabric: unknown, _projectId: string, _imageId: string, url: string) => {
		if (url.includes(BAD_MARKER)) {
			throw new Error(`image load failed: ${url}`);
		}
		return makeFakeImage(url);
	}),
}));

// Minimal config used by text-object sizing.
vi.mock("$lib/config.js", () => ({
	config: { defaultFontSize: 24, defaultFontFamily: "Arial" },
}));

function makeFakeImage(url: string) {
	return {
		__url: url,
		width: 100,
		height: 150,
		set: vi.fn(),
		scaleToWidth: vi.fn(),
		scaleToHeight: vi.fn(),
		getScaledHeight: () => 150,
		getOriginalSize: () => ({ width: 100, height: 150 }),
	};
}

// Fake fabric module: a StaticCanvas that throws if a "bad layer" image is
// added, plus FabricImage.fromURL that simply returns a fake image.
const fabricMock = {
	StaticCanvas: class {
		objects: unknown[] = [];
		constructor(_el: unknown, _opts: unknown) {}
		add(obj: any) {
			if (obj && typeof obj.__url === "string" && obj.__url.includes(BAD_LAYER_MARKER)) {
				throw new Error("layer compositing failed");
			}
			this.objects.push(obj);
		}
		renderAll() {}
		toDataURL() {
			// 1x1 transparent PNG.
			return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		}
		dispose() {}
	},
	Textbox: class {
		constructor(_text: string, _opts: unknown) {}
		set() {}
	},
	IText: class {
		constructor(_text: string, _opts: unknown) {}
		set() {}
	},
	Shadow: class {
		constructor(_opts: unknown) {}
	},
	FabricImage: {
		fromURL: vi.fn(async (url: string) => makeFakeImage(url)),
	},
};

vi.mock("fabric", () => fabricMock);

// Import AFTER mocks are registered.
import {
	exportPagesToZip,
	PageExportError,
} from "$lib/project/page-export.js";
import type { ImageLayer, Page, ProjectState, TextLayer } from "$lib/types.js";

function makeTextLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "text-1",
		text: "hello",
		x: 10,
		y: 10,
		w: 80,
		h: 30,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function makePage(imageId: string, overrides: Partial<Page> = {}): Page {
	return {
		imageId,
		imageName: `${imageId}.webp`,
		originalName: `${imageId}.webp`,
		textLayers: [makeTextLayer()],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function makeProject(pages: Page[]): ProjectState {
	return {
		projectId: "project-1",
		name: "Chapter 01",
		createdAt: "2026-05-12T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages,
	};
}

async function zipPaths(blob: Blob): Promise<string[]> {
	// The ZIP is STORE (uncompressed), so the path strings appear verbatim in the
	// bytes. Scan for the known prefixes to confirm membership.
	const text = new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));
	const paths = new Set<string>();
	for (const match of text.matchAll(/(manifest\.json|EXPORT_NOTICE\.txt|pages\/[0-9A-Za-z._-]+\.png)/g)) {
		paths.add(match[1]);
	}
	return [...paths];
}

describe("page export partial resilience (FIX 2)", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("skips a page whose image fails to load and exports the rest", async () => {
		const project = makeProject([
			makePage("good-1"),
			makePage(`mid-${BAD_MARKER}`),
			makePage("good-3"),
		]);

		const result = await exportPagesToZip(project, [0, 1, 2]);

		// Two good pages exported, one skipped — NOT a total failure.
		expect(result.exportedPages.map((p) => p.pageNumber)).toEqual([1, 3]);
		expect(result.skippedPages.map((p) => p.pageNumber)).toEqual([2]);
		expect(result.skippedPages[0].reason).toContain("image load failed");
		expect(result.manifest.pageCount).toBe(2);
		expect(result.manifest.requestedPageCount).toBe(3);

		// ZIP contains the two good pages, a manifest, and a human-readable notice.
		const paths = await zipPaths(result.zipBlob);
		expect(paths).toContain("manifest.json");
		expect(paths).toContain("EXPORT_NOTICE.txt");
		expect(paths.filter((p) => p.startsWith("pages/"))).toHaveLength(2);
	});

	it("falls back to a source-only render when only layer compositing fails", async () => {
		const project = makeProject([
			makePage("good-1"),
			makePage("layer-page", {
				imageLayers: [
					{
						id: "overlay",
						imageId: `overlay-${BAD_LAYER_MARKER}`,
						imageName: "overlay.png",
						x: 0,
						y: 0,
						w: 50,
						h: 50,
						rotation: 0,
						opacity: 1,
						index: 0,
						visible: true,
					} as ImageLayer,
				],
			}),
		]);

		const result = await exportPagesToZip(project, [0, 1]);

		// Both pages present; the layer-broken page is downgraded to source-only,
		// not skipped.
		expect(result.exportedPages.map((p) => p.pageNumber)).toEqual([1, 2]);
		expect(result.skippedPages).toHaveLength(0);
		expect(result.sourceOnlyPages.map((p) => p.pageNumber)).toEqual([2]);
		expect(result.sourceOnlyPages[0].renderNote).toContain("Layer compositing failed");
		// The notice file is emitted because there is a source-only page.
		expect(await zipPaths(result.zipBlob)).toContain("EXPORT_NOTICE.txt");
	});

	it("treats a visible image layer with no asset id as source-only, not a hard abort", async () => {
		const project = makeProject([
			makePage("page-missing-layer-asset", {
				imageLayers: [
					{
						id: "missing-asset",
						imageId: "",
						imageName: "credit.webp",
						name: "Credit",
						x: 0,
						y: 0,
						w: 50,
						h: 50,
						rotation: 0,
						opacity: 1,
						index: 0,
						visible: true,
					} as ImageLayer,
				],
			}),
		]);

		const result = await exportPagesToZip(project, [0]);

		expect(result.skippedPages).toHaveLength(0);
		expect(result.exportedPages).toHaveLength(1);
		expect(result.sourceOnlyPages.map((p) => p.pageNumber)).toEqual([1]);
	});

	it("does not emit a notice on the all-good happy path", async () => {
		const project = makeProject([makePage("good-1"), makePage("good-2")]);

		const result = await exportPagesToZip(project, [0, 1]);

		expect(result.skippedPages).toHaveLength(0);
		expect(result.sourceOnlyPages).toHaveLength(0);
		expect(result.exportedPages.every((p) => p.renderMode === "full")).toBe(true);
		const paths = await zipPaths(result.zipBlob);
		expect(paths).toContain("manifest.json");
		expect(paths).not.toContain("EXPORT_NOTICE.txt");
	});

	it("still throws when EVERY page fails (no silent empty ZIP)", async () => {
		const project = makeProject([
			makePage(`a-${BAD_MARKER}`),
			makePage(`b-${BAD_MARKER}`),
		]);

		await expect(exportPagesToZip(project, [0, 1])).rejects.toBeInstanceOf(PageExportError);
	});

	// ---------------------------------------------------------------------------
	// P1-c — a VISIBLE non-destructive edit-layer (bubble-clean) mask that can't be
	// loaded must NOT silently ship the un-cleaned source. For a PUBLISH export the
	// page FAILS (kept out of the ZIP, reported skipped). For a DRAFT export it is a
	// source-only fallback flagged in the manifest. A loadable mask exports "full".
	// ---------------------------------------------------------------------------
	function pageWithEditLayer(imageId: string, maskAssetId: string): Page {
		return makePage(imageId, {
			imageEditLayers: [
				{
					id: "edit-1",
					kind: "bubble-clean",
					target: "page-background",
					visible: true,
					opacity: 1,
					sourceImageId: imageId,
					bbox: { x: 5, y: 5, w: 20, h: 20 },
					payload: { type: "fill-mask", maskAssetId, maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } },
					index: 0,
					tool: { id: "bubble-clean" },
					createdAt: "2026-05-12T00:00:00.000Z",
				},
			],
		} as Partial<Page>);
	}

	it("P1-c — PUBLISH export FAILS a page whose bubble-clean mask is missing (no un-cleaned source in ZIP)", async () => {
		const project = makeProject([
			makePage("good-1"),
			pageWithEditLayer("clean-page", `mask-${BAD_MARKER}`),
		]);

		const result = await exportPagesToZip(project, [0, 1], { exportProfile: "publish" });

		// The clean page is FAILED (skipped) — never shipped un-cleaned.
		expect(result.exportedPages.map((p) => p.pageNumber)).toEqual([1]);
		expect(result.skippedPages.map((p) => p.pageNumber)).toEqual([2]);
		expect(result.skippedPages[0].reason).toMatch(/mask|composit/i);
		expect(result.sourceOnlyPages).toHaveLength(0);
	});

	it("P1-c — DRAFT export keeps the page as a flagged source-only fallback", async () => {
		const project = makeProject([
			makePage("good-1"),
			pageWithEditLayer("clean-page", `mask-${BAD_MARKER}`),
		]);

		const result = await exportPagesToZip(project, [0, 1], { exportProfile: "draft" });

		// Both pages present; the clean page is downgraded to source-only + flagged.
		expect(result.exportedPages.map((p) => p.pageNumber)).toEqual([1, 2]);
		expect(result.skippedPages).toHaveLength(0);
		expect(result.sourceOnlyPages.map((p) => p.pageNumber)).toEqual([2]);
		expect(result.sourceOnlyPages[0].renderNote).toMatch(/UN-CLEANED|clean/i);
	});

	it("P1-c — defaults to PUBLISH (fails the page) when no profile is given", async () => {
		const project = makeProject([pageWithEditLayer("clean-page", `mask-${BAD_MARKER}`)]);
		await expect(exportPagesToZip(project, [0])).rejects.toBeInstanceOf(PageExportError);
	});

	it("P1-c — a loadable bubble-clean mask exports the page as full (no skip/source-only)", async () => {
		const project = makeProject([pageWithEditLayer("clean-page", "mask-ok")]);
		const result = await exportPagesToZip(project, [0], { exportProfile: "publish" });
		expect(result.skippedPages).toHaveLength(0);
		expect(result.sourceOnlyPages).toHaveLength(0);
		expect(result.exportedPages.map((p) => p.renderMode)).toEqual(["full"]);
	});

	// -------------------------------------------------------------------------
	// Phase B — patch / healing / clone edit layers composite a REALIZED RGBA ROI
	// asset at bbox. A loadable realized-patch exports "full"; a missing one fails a
	// PUBLISH export (no missing edit shipped) and is a flagged source-only fallback
	// for a DRAFT export — same P1-c contract as the Phase A fill-mask.
	// -------------------------------------------------------------------------
	function pageWithPatchLayer(imageId: string, patchAssetId: string, kind: "patch" | "healing" | "clone"): Page {
		const base = {
			id: `edit-${kind}`,
			kind,
			target: "page-background" as const,
			visible: true,
			opacity: 1,
			sourceImageId: imageId,
			bbox: { x: 6, y: 6, w: 18, h: 18 },
			index: 0,
			tool: { id: kind === "patch" ? "brush" : kind === "healing" ? "healing-brush" : "clone-stamp" } as { id: "brush" | "healing-brush" | "clone-stamp" },
			createdAt: "2026-06-06T00:00:00.000Z",
		};
		const payload =
			kind === "patch"
				? { type: "patch" as const, patchAssetId, patchEncoding: "png-rgba" as const }
				: kind === "healing"
					? {
						type: "healing" as const,
						maskAssetId: "m-1",
						realizedPatchAssetId: patchAssetId,
						patchEncoding: "png-rgba" as const,
						algorithm: "telea" as const,
						algorithmVersion: "telea-1",
					}
					: {
						type: "clone" as const,
						maskAssetId: "m-2",
						realizedPatchAssetId: patchAssetId,
						patchEncoding: "png-rgba" as const,
						sourceImageId: imageId,
						sourceBbox: { x: 0, y: 0, w: 18, h: 18 },
						offset: { dx: 6, dy: 6 },
					};
		return makePage(imageId, { imageEditLayers: [{ ...base, payload }] } as Partial<Page>);
	}

	it("Phase B — a loadable patch/healing/clone realized asset exports the page as full", async () => {
		for (const kind of ["patch", "healing", "clone"] as const) {
			const project = makeProject([pageWithPatchLayer("edit-page", "patch-ok", kind)]);
			const result = await exportPagesToZip(project, [0], { exportProfile: "publish" });
			expect(result.skippedPages).toHaveLength(0);
			expect(result.sourceOnlyPages).toHaveLength(0);
			expect(result.exportedPages.map((p) => p.renderMode)).toEqual(["full"]);
		}
	});

	it("Phase B — PUBLISH export FAILS a page whose realized patch asset is missing", async () => {
		const project = makeProject([
			makePage("good-1"),
			pageWithPatchLayer("heal-page", `patch-${BAD_MARKER}`, "healing"),
		]);
		const result = await exportPagesToZip(project, [0, 1], { exportProfile: "publish" });
		expect(result.exportedPages.map((p) => p.pageNumber)).toEqual([1]);
		expect(result.skippedPages.map((p) => p.pageNumber)).toEqual([2]);
		expect(result.sourceOnlyPages).toHaveLength(0);
	});

	it("Phase B — DRAFT export keeps a missing-patch page as a flagged source-only fallback", async () => {
		const project = makeProject([pageWithPatchLayer("clone-page", `patch-${BAD_MARKER}`, "clone")]);
		const result = await exportPagesToZip(project, [0], { exportProfile: "draft" });
		expect(result.skippedPages).toHaveLength(0);
		expect(result.sourceOnlyPages.map((p) => p.pageNumber)).toEqual([1]);
	});
});
