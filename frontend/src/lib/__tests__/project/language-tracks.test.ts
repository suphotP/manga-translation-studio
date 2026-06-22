import { describe, expect, it } from "vitest";
import {
	activeTrack,
	hasMaterializedTrack,
	isDefaultTrack,
	legacyTrackView,
	listTracks,
	pageOutput,
	seedTrackOutput,
	trackScriptSlots,
	trackTextLayers,
	trackWritesFlat,
	writeTrackTextLayers,
} from "$lib/project/language-tracks.js";
import type {
	Page,
	PageQcHandoff,
	PageTranslationHandoff,
	ProjectState,
	TextLayer,
	TranslationScriptSlot,
} from "$lib/types.js";

function makeTextLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "t1",
		text: "hello",
		x: 0,
		y: 0,
		w: 10,
		h: 10,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function makeSlot(overrides: Partial<TranslationScriptSlot> = {}): TranslationScriptSlot {
	return {
		id: "s1",
		label: "Slot 1",
		x: 0,
		y: 0,
		translatedText: "สวัสดี",
		...overrides,
	};
}

function makeTranslationHandoff(overrides: Partial<PageTranslationHandoff> = {}): PageTranslationHandoff {
	return {
		status: "translated",
		updatedAt: "2026-06-03T00:00:00.000Z",
		...overrides,
	};
}

function makeQcHandoff(overrides: Partial<PageQcHandoff> = {}): PageQcHandoff {
	return {
		status: "ready",
		updatedAt: "2026-06-03T00:00:00.000Z",
		...overrides,
	};
}

/** A legacy single-language page: only the flat fields, no `languageOutputs`. */
function makeLegacyPage(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "img-1",
		imageName: "001.png",
		textLayers: [makeTextLayer()],
		translationScriptSlots: [makeSlot()],
		translationHandoff: makeTranslationHandoff(),
		qcHandoff: makeQcHandoff(),
		cleaningHandoff: { status: "clean_ready", updatedAt: "2026-06-03T00:00:00.000Z" },
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "p1",
		name: "Project",
		createdAt: "2026-06-03T00:00:00.000Z",
		pages: [],
		currentPage: 0,
		targetLang: "th",
		...overrides,
	};
}

describe("listTracks", () => {
	it("backfills absent targetLangs to [targetLang]", () => {
		expect(listTracks(makeProject({ targetLang: "th" }))).toEqual(["th"]);
	});

	it("treats an empty targetLangs array as the default-only track", () => {
		expect(listTracks(makeProject({ targetLang: "th", targetLangs: [] }))).toEqual(["th"]);
	});

	it("returns declared tracks with the default lang leading", () => {
		const tracks = listTracks(makeProject({ targetLang: "th", targetLangs: ["en", "ja"] }));
		expect(tracks[0]).toBe("th");
		expect(tracks).toEqual(["th", "en", "ja"]);
	});

	it("de-dupes and does not move the default if already present", () => {
		const tracks = listTracks(makeProject({ targetLang: "th", targetLangs: ["th", "en", "en", "ja"] }));
		expect(tracks).toEqual(["th", "en", "ja"]);
	});

	it("returns a fresh array (not the stored reference)", () => {
		const stored = ["en", "ja"];
		const project = makeProject({ targetLang: "th", targetLangs: stored });
		const result = listTracks(project);
		expect(result).not.toBe(stored);
		result.push("zz");
		expect(project.targetLangs).toEqual(["en", "ja"]);
	});
});

describe("activeTrack", () => {
	it("backfills absent activeTargetLang to targetLang", () => {
		expect(activeTrack(makeProject({ targetLang: "th" }))).toBe("th");
	});

	it("returns the stored selection when it is an active track", () => {
		expect(
			activeTrack(makeProject({ targetLang: "th", targetLangs: ["en"], activeTargetLang: "en" })),
		).toBe("en");
	});

	it("clamps a stale selection that is no longer an active track back to the default", () => {
		expect(
			activeTrack(makeProject({ targetLang: "th", targetLangs: ["en"], activeTargetLang: "ja" })),
		).toBe("th");
	});

	it("allows selecting the default lang explicitly", () => {
		expect(
			activeTrack(makeProject({ targetLang: "th", targetLangs: ["en"], activeTargetLang: "th" })),
		).toBe("th");
	});
});

describe("isDefaultTrack", () => {
	it("is true only for the project targetLang", () => {
		const project = makeProject({ targetLang: "th" });
		expect(isDefaultTrack(project, "th")).toBe(true);
		expect(isDefaultTrack(project, "en")).toBe(false);
	});
});

describe("pageOutput — legacy (un-migrated) page", () => {
	it("returns the flat fields as the default-lang track", () => {
		const page = makeLegacyPage();
		const out = pageOutput(page, "th");
		expect(out.textLayers).toEqual(page.textLayers);
		expect(out.translationScriptSlots).toEqual(page.translationScriptSlots);
		expect(out.translationHandoff).toEqual(page.translationHandoff);
		expect(out.qcHandoff).toEqual(page.qcHandoff);
	});

	it("backfills the same flat fields for any requested lang (single legacy track)", () => {
		const page = makeLegacyPage();
		expect(pageOutput(page, "en").textLayers).toEqual(page.textLayers);
		expect(pageOutput(page, "ja").translationScriptSlots).toEqual(page.translationScriptSlots);
	});

	it("does NOT expose cleaningHandoff in the per-language view (shared raster)", () => {
		const page = makeLegacyPage();
		const out = pageOutput(page, "th") as unknown as Record<string, unknown>;
		expect(out.cleaningHandoff).toBeUndefined();
	});

	it("omits absent optional fields rather than setting them undefined", () => {
		const page = makeLegacyPage({
			translationScriptSlots: undefined,
			translationHandoff: undefined,
			qcHandoff: undefined,
		});
		const out = pageOutput(page, "th");
		expect(Object.prototype.hasOwnProperty.call(out, "translationScriptSlots")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(out, "translationHandoff")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(out, "qcHandoff")).toBe(false);
		expect(out.textLayers).toEqual(page.textLayers);
	});
});

describe("pageOutput — multi-track (migrated) page", () => {
	function makeMultiTrackPage(): Page {
		return makeLegacyPage({
			languageOutputs: {
				en: {
					textLayers: [makeTextLayer({ id: "en-1", text: "hello" })],
					translationScriptSlots: [makeSlot({ id: "en-s", translatedText: "hello" })],
					translationHandoff: makeTranslationHandoff({ status: "translated" }),
					qcHandoff: makeQcHandoff({ status: "ready" }),
				},
				ja: {
					textLayers: [makeTextLayer({ id: "ja-1", text: "こんにちは" })],
					translationScriptSlots: [makeSlot({ id: "ja-s", translatedText: "こんにちは" })],
					translationHandoff: makeTranslationHandoff({ status: "draft" }),
				},
			},
		});
	}

	it("returns the requested language bucket verbatim", () => {
		const page = makeMultiTrackPage();
		const en = pageOutput(page, "en");
		expect(en.textLayers[0]?.id).toBe("en-1");
		expect(en.textLayers[0]?.text).toBe("hello");

		const ja = pageOutput(page, "ja");
		expect(ja.textLayers[0]?.id).toBe("ja-1");
		expect(ja.textLayers[0]?.text).toBe("こんにちは");
	});

	it("returns the exact bucket reference (no copy) for a materialized track", () => {
		const page = makeMultiTrackPage();
		expect(pageOutput(page, "en")).toBe(page.languageOutputs?.en);
	});

	it("does not bleed buckets between languages", () => {
		const page = makeMultiTrackPage();
		expect(pageOutput(page, "ja").qcHandoff).toBeUndefined();
		expect(pageOutput(page, "en").qcHandoff?.status).toBe("ready");
	});

	it("falls back to the legacy flat view for a lang without a bucket", () => {
		const page = makeMultiTrackPage();
		const out = pageOutput(page, "th");
		expect(out.textLayers).toEqual(page.textLayers);
		expect(out).not.toBe(page.languageOutputs?.en);
	});
});

describe("hasMaterializedTrack", () => {
	it("is false for a legacy page", () => {
		expect(hasMaterializedTrack(makeLegacyPage(), "th")).toBe(false);
	});

	it("is true only for langs that have an explicit bucket", () => {
		const page = makeLegacyPage({
			languageOutputs: { en: { textLayers: [] } },
		});
		expect(hasMaterializedTrack(page, "en")).toBe(true);
		expect(hasMaterializedTrack(page, "ja")).toBe(false);
	});
});

describe("legacyTrackView", () => {
	it("defaults textLayers to [] when the field is missing", () => {
		const page = makeLegacyPage({ textLayers: undefined as unknown as TextLayer[] });
		expect(legacyTrackView(page).textLayers).toEqual([]);
	});

	it("never includes cleaningHandoff", () => {
		const view = legacyTrackView(makeLegacyPage());
		expect((view as unknown as Record<string, unknown>).cleaningHandoff).toBeUndefined();
	});
});

describe("trackTextLayers / trackScriptSlots convenience", () => {
	it("returns [] for slots when none exist on a legacy page", () => {
		const page = makeLegacyPage({ translationScriptSlots: undefined });
		expect(trackScriptSlots(page, "th")).toEqual([]);
	});

	it("returns the legacy flat layers/slots for the default lang", () => {
		const page = makeLegacyPage();
		expect(trackTextLayers(page, "th")).toEqual(page.textLayers);
		expect(trackScriptSlots(page, "th")).toEqual(page.translationScriptSlots);
	});

	it("returns the correct per-language bucket for a migrated page", () => {
		const page = makeLegacyPage({
			languageOutputs: {
				en: { textLayers: [makeTextLayer({ id: "en-only" })] },
			},
		});
		expect(trackTextLayers(page, "en").map((l) => l.id)).toEqual(["en-only"]);
		expect(trackScriptSlots(page, "en")).toEqual([]);
	});
});

describe("trackWritesFlat", () => {
	it("the default track writes flat (back-compat); non-default tracks do not", () => {
		expect(trackWritesFlat({ targetLang: "th" }, "th")).toBe(true);
		expect(trackWritesFlat({ targetLang: "th" }, "en")).toBe(false);
	});
});

describe("seedTrackOutput", () => {
	it("copies the source layout (positions/styles/text) as a new track's starting point", () => {
		const page = makeLegacyPage({
			textLayers: [makeTextLayer({ id: "a", text: "src", x: 5, y: 6 })],
		});
		const seeded = seedTrackOutput(page);
		expect(seeded.textLayers).toHaveLength(1);
		expect(seeded.textLayers[0]).toMatchObject({ id: "a", text: "src", x: 5, y: 6 });
		// Fresh copies, not the same references — editing the seed must not mutate source.
		expect(seeded.textLayers[0]).not.toBe(page.textLayers[0]);
	});

	it("carries source slots but NOT handoffs (a new track starts with its own workflow state)", () => {
		const seeded = seedTrackOutput(makeLegacyPage());
		expect(seeded.translationScriptSlots).toHaveLength(1);
		expect(seeded.translationHandoff).toBeUndefined();
		expect(seeded.qcHandoff).toBeUndefined();
	});
});

describe("writeTrackTextLayers", () => {
	it("materializes a new bucket from the source layout on first write", () => {
		const page = makeLegacyPage({ textLayers: [makeTextLayer({ id: "a", text: "src" })] });
		const next = writeTrackTextLayers(page, "en", [makeTextLayer({ id: "a", text: "hello" })]);
		expect(next.en.textLayers[0].text).toBe("hello");
		// The page itself is not mutated (pure helper).
		expect(page.languageOutputs).toBeUndefined();
	});

	it("preserves other tracks and an existing track's non-text fields on a subsequent write", () => {
		const page = makeLegacyPage({
			languageOutputs: {
				en: { textLayers: [makeTextLayer({ text: "old" })], translationScriptSlots: [makeSlot({ id: "keep" })] },
				ja: { textLayers: [makeTextLayer({ text: "ja" })] },
			},
		});
		const next = writeTrackTextLayers(page, "en", [makeTextLayer({ text: "new" })]);
		expect(next.en.textLayers[0].text).toBe("new");
		// Existing EN slots survive the text-only write.
		expect(next.en.translationScriptSlots?.[0]?.id).toBe("keep");
		// Sibling track untouched.
		expect(next.ja.textLayers[0].text).toBe("ja");
	});
});
