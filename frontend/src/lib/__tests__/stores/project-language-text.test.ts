// Per-language TEXT foundation: editing/switching/rendering writes the actual
// translated text into `page.languageOutputs[track]`, NOT just a flag.
//
// Contract pinned here:
//  1. WRITE: editing while a NON-default track is active persists into
//     `languageOutputs[lang]`; the default track keeps writing flat `page.textLayers`.
//  2. SWITCH: switching tracks flushes in-flight edits to the OLD track, then reloads
//     the canvas text from the NEW track (per-track isolation).
//  3. SEED: first visit to a fresh track materializes an editable COPY of the source
//     layout into `languageOutputs[lang]` so a translator starts from the source.
//  4. BACK-COMPAT: a default / single-language project NEVER grows `languageOutputs`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { AUTOSAVE_DEBOUNCE_MS, projectStore } from "$lib/stores/project.svelte.ts";
import type { Page, ProjectState, TextLayer } from "$lib/types.js";

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

const BACKEND_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "t1",
		name: "บอลลูน 1",
		text: "สวัสดี",
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
		name: "Per-language Text Project",
		createdAt: "2026-06-05T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [page()],
		...overrides,
	};
}

/**
 * A minimal canvas-editor stub: holds the current text layers, and exposes the two
 * methods the store reaches for on a track switch (`getAllTextLayers` to flush the
 * current track, `setTextLayers` to load the new one).
 */
function fakeEditor(initial: TextLayer[] = []) {
	let layers = initial.map((l) => ({ ...l }));
	return {
		getAllTextLayers: () => layers.map((l) => ({ ...l })),
		setTextLayers: (next: TextLayer[]) => {
			layers = next.map((l) => ({ ...l }));
		},
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

describe("per-language text — write path", () => {
	it("default track writes flat page.textLayers and never creates languageOutputs", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "th" }),
		);

		projectStore.captureEditorTextLayers([textLayer({ text: "ต้นฉบับ" })]);

		const p = currentPage();
		expect(p.textLayers).toHaveLength(1);
		expect(p.textLayers[0].text).toBe("ต้นฉบับ");
		// Default track stays byte-compatible: no per-language bucket materialized.
		expect(p.languageOutputs).toBeUndefined();
	});

	it("a non-default active track writes into languageOutputs[lang], not the flat field", () => {
		projectStore.__setProjectForTesting(
			project({
				targetLang: "th",
				targetLangs: ["th", "en"],
				activeTargetLang: "en",
				pages: [page({ textLayers: [textLayer({ text: "ต้นฉบับ" })] })],
			}),
		);

		projectStore.captureEditorTextLayers([textLayer({ text: "hello" })]);

		const p = currentPage();
		// Flat (default/source) text untouched.
		expect(p.textLayers[0].text).toBe("ต้นฉบับ");
		// English track carries its own text.
		expect(p.languageOutputs?.en?.textLayers?.[0]?.text).toBe("hello");
	});
});

describe("per-language text — switch + seed + isolation", () => {
	it("first switch to a fresh track SEEDS an editable copy of the source layout", () => {
		projectStore.__setProjectForTesting(
			project({
				targetLang: "th",
				targetLangs: ["th", "en"],
				activeTargetLang: "th",
				pages: [page({ textLayers: [textLayer({ id: "a", text: "ต้นฉบับ", x: 5, y: 6 })] })],
			}),
		);
		const editor = fakeEditor(currentPage().textLayers);

		projectStore.setTargetLang("en", editor);

		const p = currentPage();
		// The new track materializes a copy of the source layout (same id/position, text copied).
		expect(p.languageOutputs?.en?.textLayers).toHaveLength(1);
		expect(p.languageOutputs?.en?.textLayers[0]).toMatchObject({ id: "a", text: "ต้นฉบับ", x: 5, y: 6 });
		// The editor was loaded with the seeded layers.
		expect(editor.getAllTextLayers()[0].text).toBe("ต้นฉบับ");
		// Source/default flat text is untouched by the seed.
		expect(p.textLayers[0].text).toBe("ต้นฉบับ");
	});

	it("switching tracks isolates edits: A keeps its text, B has its own", () => {
		projectStore.__setProjectForTesting(
			project({
				targetLang: "th",
				targetLangs: ["th", "en"],
				activeTargetLang: "th",
				pages: [page({ textLayers: [textLayer({ id: "a", text: "TH-source" })] })],
			}),
		);
		const editor = fakeEditor(currentPage().textLayers);

		// Switch to EN (seeds from source), edit it.
		projectStore.setTargetLang("en", editor);
		editor.setTextLayers([textLayer({ id: "a", text: "EN-translated" })]);
		projectStore.captureEditorTextLayers(editor.getAllTextLayers());

		// Switch back to TH: the flush wrote EN before switching; TH reloads the source.
		projectStore.setTargetLang("th", editor);
		expect(editor.getAllTextLayers()[0].text).toBe("TH-source");
		expect(currentPage().textLayers[0].text).toBe("TH-source");
		expect(currentPage().languageOutputs?.en?.textLayers[0].text).toBe("EN-translated");

		// Switch to EN again: its own edited text comes back (not re-seeded).
		projectStore.setTargetLang("en", editor);
		expect(editor.getAllTextLayers()[0].text).toBe("EN-translated");
	});

	it("an in-flight edit to the OLD track is flushed before the switch", () => {
		projectStore.__setProjectForTesting(
			project({
				targetLang: "th",
				targetLangs: ["th", "en", "ja"],
				activeTargetLang: "en",
				pages: [page({ textLayers: [textLayer({ id: "a", text: "src" })] })],
			}),
		);
		// EN already has a bucket; the editor holds an UNSAVED EN edit.
		const editor = fakeEditor([textLayer({ id: "a", text: "EN-edit-in-flight" })]);

		projectStore.setTargetLang("ja", editor);

		// The in-flight EN edit was captured into the EN bucket before switching to JA.
		expect(currentPage().languageOutputs?.en?.textLayers[0].text).toBe("EN-edit-in-flight");
		// JA seeded from source.
		expect(currentPage().languageOutputs?.ja?.textLayers[0].text).toBe("src");
	});
});

describe("per-language text — persistence round-trip", () => {
	it("per-track text survives save + reload independently", async () => {
		projectStore.__setProjectForTesting(
			project({
				targetLang: "th",
				targetLangs: ["th", "en"],
				activeTargetLang: "th",
				pages: [page({ textLayers: [textLayer({ id: "a", text: "TH" })] })],
			}),
		);
		const editor = fakeEditor(currentPage().textLayers);

		projectStore.setTargetLang("en", editor);
		editor.setTextLayers([textLayer({ id: "a", text: "EN" })]);
		projectStore.captureEditorTextLayers(editor.getAllTextLayers());
		await projectStore.saveState();

		const saved = vi.mocked(api.saveProject).mock.calls.at(-1)?.[1] as ProjectState;
		expect(saved.pages[0].textLayers[0].text).toBe("TH");
		expect(saved.pages[0].languageOutputs?.en?.textLayers[0].text).toBe("EN");

		// Reload reopens on EN and resolves EN's own text.
		const reloaded = JSON.parse(JSON.stringify(saved)) as ProjectState;
		projectStore.__setProjectForTesting(reloaded);
		expect(projectStore.activeTargetLang).toBe("en");
		expect(currentPage().languageOutputs?.en?.textLayers[0].text).toBe("EN");
		expect(currentPage().textLayers[0].text).toBe("TH");
	});

	it("editing an already-active NON-default track marks unsaved and autosave persists it (no data loss)", async () => {
		// P1 regression (codex, PR #291): a project that REOPENS on a non-default track
		// (activeTargetLang already "en") and is edited there writes only into
		// languageOutputs[en]. If the revision id ignored languageOutputs, the page never
		// flagged dirty → no autosave/save → the edit was silently LOST on reload.
		vi.useFakeTimers();
		try {
			projectStore.__setProjectForTesting(
				project({
					targetLang: "th",
					targetLangs: ["th", "en"],
					activeTargetLang: "en",
					pages: [page({
						textLayers: [textLayer({ id: "a", text: "TH-source" })],
						languageOutputs: { en: { textLayers: [textLayer({ id: "a", text: "EN-old" })] } },
					})],
				}),
			);
			// A freshly-(re)loaded project is clean — no spurious "unsaved" despite the
			// languageOutputs bucket already being present on the page.
			expect(projectStore.saveSyncStatus).toBe("saved");

			// Edit the EN track in place (the active, non-default track).
			projectStore.captureEditorTextLayers([textLayer({ id: "a", text: "EN-new" })]);

			// The per-track edit must flip the page dirty so autosave can fire.
			expect(projectStore.saveSyncStatus).toBe("unsaved");
			expect(currentPage().languageOutputs?.en?.textLayers[0].text).toBe("EN-new");
			// Source/default text is untouched.
			expect(currentPage().textLayers[0].text).toBe("TH-source");

			// Drive the debounce: autosave must fire and persist the EN edit.
			await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
			await vi.runOnlyPendingTimersAsync();

			expect(api.saveProject).toHaveBeenCalledTimes(1);
			const saved = vi.mocked(api.saveProject).mock.calls.at(-1)?.[1] as ProjectState;
			expect(saved.pages[0].languageOutputs?.en?.textLayers[0].text).toBe("EN-new");
			expect(projectStore.saveSyncStatus).toBe("saved");

			// Reload from the persisted payload: the EN edit survived (not lost).
			const reloaded = JSON.parse(JSON.stringify(saved)) as ProjectState;
			projectStore.__setProjectForTesting(reloaded);
			expect(currentPage().languageOutputs?.en?.textLayers[0].text).toBe("EN-new");
			// And the reloaded project is clean on load (no spurious unsaved).
			expect(projectStore.saveSyncStatus).toBe("saved");
		} finally {
			vi.runOnlyPendingTimers();
			vi.useRealTimers();
		}
	});

	it("a single-language project never grows languageOutputs through normal editing", () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));

		projectStore.captureEditorTextLayers([textLayer({ text: "เท่านั้น" })]);
		projectStore.setTargetLang("en"); // legacy permissive path, no editor

		const p = currentPage();
		expect(p.languageOutputs).toBeUndefined();
		expect(projectStore.project?.targetLangs).toBeUndefined();
	});
});
