// Per-language model PR-7: active Language Track state in the project store.
//
// Establishes the store-level track concept (`targetLangs` / `activeTargetLang`)
// while keeping the historical `targetLang` scalar working as a BACK-COMPAT alias.
// These tests pin down the back-compat contract: a single-language / legacy project
// (no `targetLangs` in state) must behave EXACTLY as before, and a multi-track
// project must round-trip its active-track selection through save/load.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { Page, ProjectState } from "$lib/types.js";

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

const BACKEND_PROJECT_ID = "11111111-1111-4111-8111-111111111111";

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
		name: "Lang Track Project",
		createdAt: "2026-06-03T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [page()],
		...overrides,
	};
}

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

describe("ProjectStore — legacy / single-language back-compat", () => {
	it("a legacy project (no targetLangs) exposes [targetLang] and the alias equals targetLang", () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));

		expect(projectStore.targetLangs).toEqual(["th"]);
		expect(projectStore.activeTargetLang).toBe("th");
		expect(projectStore.targetLang).toBe("th");
	});

	it("normalizes the loaded target language into the active-track alias exactly as before (trim + lowercase)", () => {
		// The alias is normalized on load just like the legacy
		// `normalizeTargetLanguage(project.targetLang, ...)` call did.
		projectStore.__setProjectForTesting(project({ targetLang: "  EN  " }));

		expect(projectStore.targetLang).toBe("en");
		expect(projectStore.activeTargetLang).toBe("en");
	});

	it("setTargetLang stays permissive on a legacy project (accepts any lang, no state mutation)", () => {
		const state = project({ targetLang: "th" });
		projectStore.__setProjectForTesting(state);

		// Historical behavior: the scalar setter accepts arbitrary languages (the AI
		// language <select> still drives this on single-language projects).
		projectStore.setTargetLang("en");
		expect(projectStore.targetLang).toBe("en");
		expect(projectStore.activeTargetLang).toBe("en");

		// Must NOT write a `targetLangs` / `activeTargetLang` key into the saved state —
		// keeping the persisted JSON byte-identical to the pre-per-language model.
		expect(projectStore.project?.targetLangs).toBeUndefined();
		expect(projectStore.project?.activeTargetLang).toBeUndefined();
	});

	it("with no project loaded, the alias is the only track and setTargetLang is permissive", () => {
		expect(projectStore.targetLangs).toEqual(["th"]);
		expect(projectStore.activeTargetLang).toBe("th");

		projectStore.setTargetLang("fr");
		expect(projectStore.targetLang).toBe("fr");
		expect(projectStore.targetLangs).toEqual(["fr"]);
	});
});

describe("ProjectStore — multi-track projects", () => {
	it("loads targetLangs/activeTargetLang from state (default lang leads, de-duped)", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["en", "th", "en"], activeTargetLang: "en" }),
		);

		// listTracks guarantees the default lang leads and de-dupes.
		expect(projectStore.targetLangs).toEqual(["th", "en"]);
		// Reopens on the persisted active track.
		expect(projectStore.activeTargetLang).toBe("en");
		expect(projectStore.targetLang).toBe("en");
	});

	it("falls back to the default lang when activeTargetLang is absent", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"] }),
		);

		expect(projectStore.activeTargetLang).toBe("th");
		expect(projectStore.targetLang).toBe("th");
	});

	it("clamps a stored activeTargetLang that is no longer a track back to the default", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "ko" }),
		);

		expect(projectStore.activeTargetLang).toBe("th");
		expect(projectStore.targetLang).toBe("th");
	});

	it("setTargetLang switches the active track, keeps the alias in sync, and persists the selection", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "th" }),
		);

		projectStore.setTargetLang("en");
		expect(projectStore.activeTargetLang).toBe("en");
		expect(projectStore.targetLang).toBe("en");
		expect(projectStore.project?.activeTargetLang).toBe("en");
		// The switch must mark the project dirty so autosave / saveBeforeProjectSwitch
		// durably persist it — otherwise a project switch/reload reverts the selection
		// (review P1). A no-op switch to the same lang must NOT mark dirty.
		expect(projectStore.saveSyncStatus).toBe("unsaved");
	});

	it("switching to the already-active track does NOT mark the project dirty", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "en" }),
		);
		expect(projectStore.saveSyncStatus).not.toBe("unsaved");
		projectStore.setTargetLang("en");
		expect(projectStore.activeTargetLang).toBe("en");
		expect(projectStore.saveSyncStatus).not.toBe("unsaved");
	});

	it("setTargetLang clamps to the default for a lang that is not yet a track (never creates one)", () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "en" }),
		);

		projectStore.setTargetLang("ko");
		expect(projectStore.activeTargetLang).toBe("th");
		expect(projectStore.targetLang).toBe("th");
		expect(projectStore.project?.activeTargetLang).toBe("th");
		// Track set is unchanged — no silent track creation.
		expect(projectStore.targetLangs).toEqual(["th", "en"]);
	});

	it("round-trips a switched active track through save and reload", async () => {
		projectStore.__setProjectForTesting(
			project({ targetLang: "th", targetLangs: ["th", "en"], activeTargetLang: "th" }),
		);

		projectStore.setTargetLang("en");
		await projectStore.saveState();

		// The save payload must carry the multi-track shape with the new active track.
		const saved = vi.mocked(api.saveProject).mock.calls.at(-1)?.[1] as ProjectState;
		expect(saved.targetLangs).toEqual(["th", "en"]);
		expect(saved.activeTargetLang).toBe("en");

		// Reloading the persisted state reopens on the saved active track.
		const reloaded = JSON.parse(JSON.stringify(saved)) as ProjectState;
		projectStore.__setProjectForTesting(reloaded);
		expect(projectStore.activeTargetLang).toBe("en");
		expect(projectStore.targetLang).toBe("en");
		expect(projectStore.targetLangs).toEqual(["th", "en"]);
	});
});
