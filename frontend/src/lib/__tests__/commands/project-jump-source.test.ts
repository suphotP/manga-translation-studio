import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "$lib/api/client.ts";
import {
	buildProjectJumpCommands,
	PROJECT_JUMP_LIMIT,
} from "$lib/commands/project-jump-source.svelte.ts";
import { searchCommands } from "$lib/commands/command-registry.ts";

// `project-jump-source` is a pure builder over a `ProjectSummary[]`, so these
// tests never touch the network: they feed a fixture listing and assert the
// emitted rows + their searchable text. The fetch/cache half (`projectJumpStore`)
// uses Svelte runes ($state) and is exercised through the component test; here we
// pin the cross-project/cross-chapter row-building contract.

function summary(overrides: Partial<ProjectSummary> & Pick<ProjectSummary, "projectId">): ProjectSummary {
	return {
		name: "Untitled",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		targetLang: "en",
		pageCount: 0,
		textLayerCount: 0,
		...overrides,
	};
}

const LISTING: ProjectSummary[] = [
	summary({
		projectId: "p-dragon-1",
		name: "Dragon Saga ch1",
		storyId: "s-dragon",
		storyTitle: "Dragon Saga",
		chapterLabel: "Chapter 1",
		targetLang: "en",
		pageCount: 18,
	}),
	summary({
		projectId: "p-dragon-2",
		name: "Dragon Saga ch2",
		storyId: "s-dragon",
		storyTitle: "Dragon Saga",
		chapterLabel: "Chapter 2",
		targetLang: "th",
		pageCount: 0,
	}),
	summary({
		projectId: "p-moon-7",
		name: "Moonlight ch7",
		storyId: "s-moon",
		storyTitle: "Moonlight Garden",
		chapterNumber: "7",
		targetLang: "ja",
		pageCount: 22,
	}),
];

describe("buildProjectJumpCommands", () => {
	it("builds one navigate jump row per project across DIFFERENT stories", () => {
		const rows = buildProjectJumpCommands(LISTING, { onJump: vi.fn() });
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.id)).toEqual([
			"jump-project-p-dragon-1",
			"jump-project-p-dragon-2",
			"jump-project-p-moon-7",
		]);
		expect(rows.every((r) => r.section === "navigate")).toBe(true);
	});

	it("titles by series and subtitles by chapter · lang · pages", () => {
		const rows = buildProjectJumpCommands(LISTING, { onJump: vi.fn() });
		const ch1 = rows.find((r) => r.id === "jump-project-p-dragon-1");
		expect(ch1?.title).toBe("เปิด Dragon Saga");
		expect(ch1?.subtitle).toBe("Chapter 1 · EN · 18 หน้า");

		// A page-less chapter drops the page-count segment (honest, no "0 pages").
		const ch2 = rows.find((r) => r.id === "jump-project-p-dragon-2");
		expect(ch2?.subtitle).toBe("Chapter 2 · TH");

		// Missing chapter label falls back to a composed "ตอน {number}".
		const moon = rows.find((r) => r.id === "jump-project-p-moon-7");
		expect(moon?.subtitle).toBe("ตอน 7 · JA · 22 หน้า");
	});

	it("localises titles + words through the injected translator", () => {
		const t = vi.fn((_key: string, fallback: string) => `[${fallback}]`);
		const rows = buildProjectJumpCommands(LISTING, { t, onJump: vi.fn() });
		const ch1 = rows.find((r) => r.id === "jump-project-p-dragon-1");
		expect(ch1?.title).toBe("[เปิด] Dragon Saga");
		expect(ch1?.subtitle).toBe("Chapter 1 · EN · 18 [หน้า]");
	});

	it("skips the currently open project (can't jump to where you already are)", () => {
		const rows = buildProjectJumpCommands(LISTING, {
			currentProjectId: "p-dragon-1",
			onJump: vi.fn(),
		});
		expect(rows.map((r) => r.id)).not.toContain("jump-project-p-dragon-1");
		expect(rows).toHaveLength(2);
	});

	it("invokes onJump with the project id when a row runs", () => {
		const onJump = vi.fn();
		const rows = buildProjectJumpCommands(LISTING, { onJump });
		rows.find((r) => r.id === "jump-project-p-moon-7")?.run();
		expect(onJump).toHaveBeenCalledWith("p-moon-7");
	});

	it("caps the emitted rows at the requested limit", () => {
		const big = Array.from({ length: 120 }, (_, i) =>
			summary({ projectId: `p-${i}`, name: `Chapter ${i}` }),
		);
		expect(buildProjectJumpCommands(big, { onJump: vi.fn() })).toHaveLength(PROJECT_JUMP_LIMIT);
		expect(buildProjectJumpCommands(big, { onJump: vi.fn(), limit: 5 })).toHaveLength(5);
	});

	it("returns no rows for an empty listing (honest empty state)", () => {
		expect(buildProjectJumpCommands([], { onJump: vi.fn() })).toEqual([]);
	});
});

describe("cross-project / cross-chapter fuzzy search over jump rows", () => {
	const rows = buildProjectJumpCommands(LISTING, { onJump: vi.fn() });

	it("ranks BOTH chapters of the matched series above other projects", () => {
		// The palette's fuzzy matcher is a loose subsequence match (so unrelated
		// rows may technically match), but ranking must surface the real series:
		// both Dragon Saga chapters outscore Moonlight for "dragon".
		const matches = searchCommands(rows, "dragon");
		expect(matches.slice(0, 2).map((m) => m.command.id).sort()).toEqual([
			"jump-project-p-dragon-1",
			"jump-project-p-dragon-2",
		]);
	});

	it("matches a SPECIFIC chapter by its label/number", () => {
		// "chapter2" subsequence hits Dragon Saga ch2 (label "Chapter 2"), not ch1.
		const matches = searchCommands(rows, "chapter2");
		expect(matches[0]?.command.id).toBe("jump-project-p-dragon-2");

		// The composed "ตอน 7" chapter is reachable by its number.
		const byNumber = searchCommands(rows, "moon 7");
		expect(byNumber[0]?.command.id).toBe("jump-project-p-moon-7");
	});

	it("matches by target language across projects", () => {
		const matches = searchCommands(rows, "ja");
		expect(matches.some((m) => m.command.id === "jump-project-p-moon-7")).toBe(true);
	});
});
