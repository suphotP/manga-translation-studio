import { describe, expect, it } from "vitest";
import {
	groupChaptersByNumber,
	type WorkspaceProjectBrowserChapter,
} from "$lib/project/workspace-dashboard.ts";
import type { ProjectSummary } from "$lib/api/client.js";

function chapter(projectId: string, chapterNumber: string | undefined, targetLang: string): WorkspaceProjectBrowserChapter {
	const project = {
		projectId,
		name: projectId,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		targetLang,
		chapterNumber,
		pageCount: 0,
		textLayerCount: 0,
	} as unknown as ProjectSummary;
	return {
		project,
		chapterLabel: chapterNumber ? `ตอน ${chapterNumber}` : projectId,
		workState: "ready",
		nextAction: "",
		workSignal: "",
		densityLabel: "",
		openWorkCount: 0,
		reviewCount: 0,
		commentCount: 0,
	};
}

describe("groupChaptersByNumber", () => {
	it("collapses same-numbered chapters across languages into one group", () => {
		const groups = groupChaptersByNumber([
			chapter("p1", "1", "th"),
			chapter("p2", "1", "id"),
			chapter("p3", "2", "th"),
		]);
		expect(groups).toHaveLength(2);
		expect(groups[0].chapterNumber).toBe("1");
		expect(groups[0].tracks.map((t) => t.project.targetLang)).toEqual(["th", "id"]);
		expect(groups[0].primary.project.projectId).toBe("p1");
		expect(groups[1].chapterNumber).toBe("2");
		expect(groups[1].tracks).toHaveLength(1);
	});

	it("preserves first-occurrence order of chapter numbers", () => {
		const groups = groupChaptersByNumber([
			chapter("p1", "3", "th"),
			chapter("p2", "1", "th"),
			chapter("p3", "3", "id"),
		]);
		expect(groups.map((g) => g.chapterNumber)).toEqual(["3", "1"]);
		expect(groups[0].tracks).toHaveLength(2);
	});

	it("keeps chapters without a number as separate stand-alone groups", () => {
		const groups = groupChaptersByNumber([
			chapter("p1", undefined, "th"),
			chapter("p2", undefined, "id"),
		]);
		expect(groups).toHaveLength(2);
		expect(groups.every((g) => g.chapterNumber === null)).toBe(true);
	});

	it("matches numbers case/space-insensitively but keeps the trimmed display value", () => {
		const groups = groupChaptersByNumber([
			chapter("p1", "12", "th"),
			chapter("p2", " 12 ", "id"),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].chapterNumber).toBe("12");
		expect(groups[0].tracks).toHaveLength(2);
	});
});
