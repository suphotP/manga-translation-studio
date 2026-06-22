// Per-language Language Track INTEGRITY regressions (agy a03 P1 data-corruption):
//
//  1. IMAGE CAPTURE: capturing editor image layers while a NON-default track is active
//     must write `languageOutputs[lang].imageLayers` and leave the DEFAULT-track flat
//     `page.imageLayers` UNTOUCHED. The default track still writes flat.
//  2. CREDIT DELETE: deleting credit layers while a NON-default track is active must
//     edit ONLY that track (read/write via the track accessors), leaving the default
//     track's `page.textLayers` untouched, and delete from the active track across
//     EVERY page (allPages) — not the default-track layers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ImageLayer, Page, ProjectState, TextLayer } from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {},
	saveProject: vi.fn(),
	loadProject: vi.fn(),
	getProjectVersions: vi.fn(),
	createNamedProjectVersion: vi.fn(),
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
}));

vi.mock("$lib/config.js", () => ({
	config: { defaultLang: "th" },
}));

const BACKEND_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "t1",
		name: "balloon",
		text: "hi",
		x: 10,
		y: 20,
		w: 100,
		h: 40,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		zIndex: 0,
		...overrides,
	};
}

function imageLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
	return {
		id: "img1",
		imageId: "img-1.webp",
		imageName: "img-1.webp",
		x: 0,
		y: 0,
		w: 50,
		h: 50,
		rotation: 0,
		opacity: 1,
		index: 0,
		...overrides,
	};
}

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: BACKEND_PROJECT_ID,
		name: "Track Integrity Project",
		createdAt: "2026-06-06T00:00:00.000Z",
		currentPage: 0,
		targetLang: "en",
		pages: [page()],
		...overrides,
	};
}

const currentPage = () => projectStore.project!.pages[projectStore.project!.currentPage];

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(api.saveProject).mockResolvedValue(undefined);
	vi.mocked(api.loadProject).mockImplementation(async () =>
		JSON.parse(JSON.stringify(projectStore.project)) as ProjectState,
	);
	vi.mocked(api.getProjectVersions).mockResolvedValue({ versions: [] });
	projectStore.__resetForTesting();
});

afterEach(() => {
	projectStore.__resetForTesting();
});

describe("image-layer capture — track-aware write", () => {
	it("default track writes flat page.imageLayers and never creates languageOutputs", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "en", targetLangs: ["en", "th"], activeTargetLang: "en" }),
		);

		projectStore.captureEditorImageLayers([imageLayer({ id: "A", x: 5 })]);

		const p = currentPage();
		expect(p.imageLayers).toHaveLength(1);
		expect(p.imageLayers?.[0].id).toBe("A");
		expect(p.languageOutputs).toBeUndefined();
	});

	it("a NON-default active track writes languageOutputs[lang].imageLayers and leaves the DEFAULT untouched", () => {
		const defaultImages = [imageLayer({ id: "EN-img", x: 0 })];
		projectStore.__setProjectForTesting(
			project({
				targetLang: "en",
				targetLangs: ["en", "th"],
				activeTargetLang: "th",
				pages: [page({ imageLayers: defaultImages.map((l) => ({ ...l })) })],
			}),
		);

		projectStore.captureEditorImageLayers([imageLayer({ id: "TH-img", x: 999 })]);

		const p = currentPage();
		// DEFAULT (EN) flat image stack is UNTOUCHED — no cross-track corruption.
		expect(p.imageLayers).toHaveLength(1);
		expect(p.imageLayers?.[0].id).toBe("EN-img");
		expect(p.imageLayers?.[0].x).toBe(0);
		// The Thai track carries its own image override.
		const thBucket = p.languageOutputs?.th as { imageLayers?: ImageLayer[] } | undefined;
		expect(thBucket?.imageLayers).toHaveLength(1);
		expect(thBucket?.imageLayers?.[0].id).toBe("TH-img");
		expect(thBucket?.imageLayers?.[0].x).toBe(999);
	});

	it("a NON-default image edit flips the page dirty (so autosave can persist it)", () => {
		projectStore.__setProjectForTesting(
			project({
				targetLang: "en",
				targetLangs: ["en", "th"],
				activeTargetLang: "th",
				pages: [page({ imageLayers: [imageLayer({ id: "EN-img" })] })],
			}),
		);
		expect(projectStore.saveSyncStatus).toBe("saved");

		projectStore.captureEditorImageLayers([imageLayer({ id: "TH-img", x: 123 })]);

		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});
});

describe("credit-layer delete — track-aware", () => {
	it("deleting credits on a NON-default track edits ONLY that track, leaving the default untouched", () => {
		// EN (default) flat layers: a balloon + a credit. TH track: its own balloon + credit.
		const enLayers = [
			textLayer({ id: "balloon", text: "EN balloon" }),
			textLayer({ id: "credit", text: "EN credit", sourceCategory: "credit", index: 1 }),
		];
		const thLayers = [
			textLayer({ id: "balloon", text: "TH balloon" }),
			textLayer({ id: "credit", text: "TH credit", sourceCategory: "credit", index: 1 }),
		];
		projectStore.__setProjectForTesting(
			project({
				targetLang: "en",
				targetLangs: ["en", "th"],
				activeTargetLang: "th",
				pages: [page({
					textLayers: enLayers.map((l) => ({ ...l })),
					languageOutputs: { th: { textLayers: thLayers.map((l) => ({ ...l })) } },
				})],
			}),
		);

		// No editor → store-only delete path.
		const removed = projectStore.deleteCreditLayers(null, false, "all");

		expect(removed).toBe(1);
		const p = currentPage();
		// DEFAULT (EN) flat text is UNTOUCHED — its credit still present.
		expect(p.textLayers.map((l) => l.id)).toEqual(["balloon", "credit"]);
		// TH track lost its credit, kept its balloon.
		expect(p.languageOutputs?.th?.textLayers.map((l) => l.id)).toEqual(["balloon"]);
	});

	it("allPages credit delete on a NON-default track removes from the ACTIVE track across every page", () => {
		const mkPage = (suffix: string) =>
			page({
				imageId: `image-${suffix}.webp`,
				imageName: `image-${suffix}.webp`,
				textLayers: [
					textLayer({ id: "balloon", text: `EN balloon ${suffix}` }),
					textLayer({ id: "credit", text: `EN credit ${suffix}`, sourceCategory: "credit", index: 1 }),
				],
				languageOutputs: {
					th: {
						textLayers: [
							textLayer({ id: "balloon", text: `TH balloon ${suffix}` }),
							textLayer({ id: "credit", text: `TH credit ${suffix}`, sourceCategory: "credit", index: 1 }),
						],
					},
				},
			});
		projectStore.__setProjectForTesting(
			project({
				targetLang: "en",
				targetLangs: ["en", "th"],
				activeTargetLang: "th",
				currentPage: 0,
				pages: [mkPage("0"), mkPage("1")],
			}),
		);

		const removed = projectStore.deleteCreditLayers(null, true, "all");

		expect(removed).toBe(2); // one credit per page, on the active (TH) track
		const pages = projectStore.project!.pages;
		for (const p of pages) {
			// Default (EN) untouched on every page.
			expect(p.textLayers.map((l) => l.id)).toEqual(["balloon", "credit"]);
			// TH credit gone on every page.
			expect(p.languageOutputs?.th?.textLayers.map((l) => l.id)).toEqual(["balloon"]);
		}
	});

	it("default-track credit delete still edits flat page.textLayers (back-compat)", () => {
		projectStore.__setProjectForTesting(
			project({
				targetLang: "en",
				targetLangs: ["en", "th"],
				activeTargetLang: "en",
				pages: [page({
					textLayers: [
						textLayer({ id: "balloon", text: "EN balloon" }),
						textLayer({ id: "credit", text: "EN credit", sourceCategory: "credit", index: 1 }),
					],
				})],
			}),
		);

		const removed = projectStore.deleteCreditLayers(null, false, "all");

		expect(removed).toBe(1);
		const p = currentPage();
		expect(p.textLayers.map((l) => l.id)).toEqual(["balloon"]);
		// Default track stays flat — no languageOutputs materialized by a credit delete.
		expect(p.languageOutputs).toBeUndefined();
	});
});
