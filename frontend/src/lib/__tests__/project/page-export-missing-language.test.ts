import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Client export readiness gate (parity with backend MissingLanguageOutputError).
//
// When the ACTIVE Language Track is an EXPLICIT non-default language and a
// selected page has no `languageOutputs[lang]` output, the client ZIP path used
// to silently fall through `trackTextLayers(...)` to the flat/source (default)
// layout and export the WRONG language. These tests prove the client now:
//   - BLOCKS the whole export with a MissingLanguageOutputError naming the pages,
//   - still EXPORTS the default/source track (always exportable),
//   - still EXPORTS an explicit non-default track when every page has an output.
// We mock the fabric + api boundaries (same approach as the partial-export test)
// so the happy paths actually render a ZIP.
// ---------------------------------------------------------------------------

vi.mock("$lib/api/client.ts", () => ({
	imageUrl: (_projectId: string, imageId: string) => `https://test.local/${imageId}`,
	loadAuthedFabricImage: vi.fn(async (_fabric: unknown, url: string) => makeFakeImage(url)),
	// Export-purpose loader (codex P1-A) — the export render path now fetches assets
	// through the server export serve-gate. In this happy-path mock it just yields a
	// fake image like the editor_preview loader.
	loadExportFabricImage: vi.fn(async (_fabric: unknown, _projectId: string, _imageId: string, url: string) => makeFakeImage(url)),
}));

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

const fabricMock = {
	StaticCanvas: class {
		objects: unknown[] = [];
		constructor(_el: unknown, _opts: unknown) {}
		add(obj: any) {
			this.objects.push(obj);
		}
		renderAll() {}
		toDataURL() {
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
	MissingLanguageOutputError,
} from "$lib/project/page-export.js";
import type { Page, ProjectState, TextLayer } from "$lib/types.js";

function makeTextLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "text-1",
		text: "source default",
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

// Multi-track project: default/source lang = EN, with JA as a non-default track.
function makeMultiTrackProject(pages: Page[], activeTargetLang: string): ProjectState {
	return {
		projectId: "project-1",
		name: "Chapter 01",
		createdAt: "2026-05-12T00:00:00.000Z",
		currentPage: 0,
		targetLang: "EN",
		targetLangs: ["EN", "JA"],
		activeTargetLang,
		pages,
	};
}

describe("client export readiness gate (MissingLanguageOutputError parity)", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("BLOCKS an explicit non-default track when a selected page has no output for it", async () => {
		const project = makeMultiTrackProject(
			[
				// Page 1 HAS a JA output; page 2 does NOT (would fall back to source).
				makePage("img-1", {
					languageOutputs: { JA: { textLayers: [makeTextLayer({ text: "JA translated" })] } },
				}),
				makePage("img-2"),
			],
			"JA",
		);

		const thrown = await exportPagesToZip(project, [0, 1]).catch((error) => error);

		expect(thrown).toBeInstanceOf(MissingLanguageOutputError);
		expect((thrown as MissingLanguageOutputError).targetLang).toBe("JA");
		// Only page 2 (1-based pageNumber 2) is missing the JA output.
		expect((thrown as MissingLanguageOutputError).pageNumbers).toEqual([2]);
		expect((thrown as MissingLanguageOutputError).message).toContain("JA");
	});

	it("treats a null/absent languageOutputs[lang] record as missing (matches backend)", async () => {
		const project = makeMultiTrackProject(
			[
				// An explicit-but-empty/null bucket is NOT a real output (backend requires a record).
				makePage("img-1", { languageOutputs: { JA: null as any } }),
			],
			"JA",
		);

		const thrown = await exportPagesToZip(project, [0]).catch((error) => error);
		expect(thrown).toBeInstanceOf(MissingLanguageOutputError);
		expect((thrown as MissingLanguageOutputError).pageNumbers).toEqual([1]);
	});

	it("EXPORTS the default/source track even when no languageOutputs exist (always exportable)", async () => {
		const project = makeMultiTrackProject(
			[makePage("img-1"), makePage("img-2")],
			"EN", // the project default — never gated.
		);

		const result = await exportPagesToZip(project, [0, 1]);
		expect(result.exportedPages.map((p) => p.pageNumber)).toEqual([1, 2]);
		expect(result.skippedPages).toHaveLength(0);
	});

	it("EXPORTS an explicit non-default track when EVERY selected page has an output", async () => {
		const project = makeMultiTrackProject(
			[
				makePage("img-1", {
					languageOutputs: { JA: { textLayers: [makeTextLayer({ text: "JA p1" })] } },
				}),
				makePage("img-2", {
					languageOutputs: { JA: { textLayers: [makeTextLayer({ text: "JA p2" })] } },
				}),
			],
			"JA",
		);

		const result = await exportPagesToZip(project, [0, 1]);
		expect(result.exportedPages.map((p) => p.pageNumber)).toEqual([1, 2]);
		expect(result.skippedPages).toHaveLength(0);
	});

	it("never gates a single-language / legacy project (lang resolves to undefined)", async () => {
		// No targetLangs => resolveExportLang returns undefined => flat path, never gated.
		const project: ProjectState = {
			projectId: "project-legacy",
			name: "Legacy",
			createdAt: "2026-05-12T00:00:00.000Z",
			currentPage: 0,
			targetLang: "th",
			pages: [makePage("img-1")],
		};

		const result = await exportPagesToZip(project, [0]);
		expect(result.exportedPages.map((p) => p.pageNumber)).toEqual([1]);
	});
});
