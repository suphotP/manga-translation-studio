import { describe, expect, it } from "vitest";
import {
	buildSearchIndex,
	searchResults,
	type SearchResult,
} from "$lib/search/search-index.ts";
import type { ProjectSummary, WorkspaceRecord } from "$lib/api/client.js";

function project(partial: Partial<ProjectSummary> & { projectId: string }): ProjectSummary {
	return {
		name: partial.projectId,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		targetLang: "en",
		pageCount: 0,
		textLayerCount: 0,
		...partial,
	};
}

function workspace(partial: Partial<WorkspaceRecord> & { workspaceId: string }): WorkspaceRecord {
	return {
		name: partial.workspaceId,
		planId: "free",
		storageIncludedBytes: 0,
		storageExtraBytes: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...partial,
	};
}

describe("buildSearchIndex", () => {
	it("builds a 'Story — Chapter' title and folds metadata into keywords", () => {
		const [result] = buildSearchIndex({
			projects: [
				project({
					projectId: "p1",
					storyTitle: "One Piece",
					chapterTitle: "Romance Dawn",
					chapterLabel: "Ch. 1",
					targetLang: "th",
					pageCount: 20,
				}),
			],
			workspaces: [],
		});
		expect(result.kind).toBe("chapter");
		expect(result.title).toBe("One Piece — Romance Dawn");
		// The chapter label is surfaced so the result says WHICH chapter (#9a).
		expect(result.subtitle).toBe("Ch. 1 · TH · 20p");
		expect(result.targetId).toBe("p1");
		expect(result.keywords).toContain("Romance Dawn");
		expect(result.keywords).toContain("th");
	});

	it("does not duplicate the chapter label when the title already fell back to it", () => {
		// No chapter TITLE → the title uses the chapter LABEL, so the subtitle must
		// not repeat it (otherwise "Story — Ch. 3" / "Ch. 3 · TH").
		const [result] = buildSearchIndex({
			projects: [
				project({
					projectId: "p3",
					storyTitle: "One Piece",
					chapterLabel: "Ch. 3",
					targetLang: "th",
					pageCount: 18,
				}),
			],
			workspaces: [],
		});
		expect(result.title).toBe("One Piece — Ch. 3");
		expect(result.subtitle).toBe("TH · 18p");
	});

	it("derives a chapter label from the chapter number when no explicit label exists", () => {
		// Real data often has only a chapterNumber. The result must still say which
		// chapter, prefixed with the localizable word (#9a).
		const [result] = buildSearchIndex({
			projects: [
				project({
					projectId: "p4",
					storyTitle: "One Piece",
					chapterNumber: "7",
					targetLang: "th",
					pageCount: 22,
				}),
			],
			workspaces: [],
			labels: { chapterNumberPrefix: "ตอนที่" },
		});
		expect(result.title).toBe("One Piece — ตอนที่ 7");
		expect(result.subtitle).toBe("TH · 22p");
	});

	it("falls back to the project name when no story/chapter metadata exists", () => {
		const [result] = buildSearchIndex({
			projects: [project({ projectId: "p2", name: "Untitled import" })],
			workspaces: [],
		});
		expect(result.title).toBe("Untitled import");
	});

	it("includes other workspaces but drops the current one", () => {
		const results = buildSearchIndex({
			projects: [],
			workspaces: [
				workspace({ workspaceId: "w1", name: "Studio A", planId: "pro" }),
				workspace({ workspaceId: "w2", name: "Studio B" }),
			],
			currentWorkspaceId: "w1",
		});
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("workspace");
		expect(results[0].title).toBe("Studio B");
		expect(results[0].targetId).toBe("w2");
	});

	it("localises the kind badges", () => {
		const [chapter, ws] = buildSearchIndex({
			projects: [project({ projectId: "p1" })],
			workspaces: [workspace({ workspaceId: "w1" })],
			labels: { chapter: "ตอน", workspace: "เวิร์กสเปซ" },
		});
		expect(chapter.badge).toBe("ตอน");
		expect(ws.badge).toBe("เวิร์กสเปซ");
	});
});

describe("searchResults", () => {
	const index: SearchResult[] = buildSearchIndex({
		projects: [
			project({ projectId: "p1", storyTitle: "Naruto", chapterTitle: "Ninja", targetLang: "en" }),
			project({ projectId: "p2", storyTitle: "Bleach", chapterTitle: "Soul", targetLang: "th" }),
		],
		workspaces: [workspace({ workspaceId: "w1", name: "Naruto Fans" })],
	});

	it("returns the full list (capped) for an empty query, chapters first", () => {
		const matches = searchResults(index, "  ");
		expect(matches).toHaveLength(3);
		expect(matches[0].result.kind).toBe("chapter");
	});

	it("filters by fuzzy match across title + keywords", () => {
		const matches = searchResults(index, "naruto");
		const ids = matches.map((m) => m.result.id);
		// Both the chapter and the workspace mention Naruto.
		expect(ids).toContain("chapter:p1");
		expect(ids).toContain("workspace:w1");
		expect(ids).not.toContain("chapter:p2");
	});

	it("matches on language code keywords", () => {
		const matches = searchResults(index, "bleach");
		expect(matches).toHaveLength(1);
		expect(matches[0].result.targetId).toBe("p2");
	});

	it("respects the result limit", () => {
		const many = buildSearchIndex({
			projects: Array.from({ length: 50 }, (_, i) => project({ projectId: `p${i}` })),
			workspaces: [],
		});
		expect(searchResults(many, "", 20)).toHaveLength(20);
	});
});
