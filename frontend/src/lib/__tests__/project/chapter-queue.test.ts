import { describe, expect, it } from "vitest";
import {
	chapterQueueAssignees,
	chapterQueueSignals,
	filterChapterQueuePages,
	getChapterQueueLeadPage,
	getChapterQueueStats,
	pageMatchesChapterQueueFilter,
	pageMatchesChapterQueueSearch,
	pageNeedsChapterQueueAttention,
	searchChapterQueuePages,
	selectChapterQueuePages,
	type ChapterQueueFilter,
} from "$lib/project/chapter-queue.js";
import type { PageWorkSummary } from "$lib/project/page-work-summary.js";

const ALL_FILTERS: ChapterQueueFilter[] = ["all", "attention", "blocked", "review", "tasks", "ready"];

// Reference copies of the predicates that previously lived INSIDE
// WorkspaceChapterQueue.svelte (the imperative DOM filter path). The refactor must
// reproduce these outcomes exactly, so we assert the declarative module against them.
function legacyMatchesFilterForView(summary: PageWorkSummary, filter: ChapterQueueFilter): boolean {
	if (filter === "all") return true;
	if (filter === "attention") {
		return summary.status === "blocked"
			|| summary.status === "review"
			|| summary.openCommentCount > 0
			|| summary.taskOpenCount > 0
			|| summary.overdueTaskCount > 0
			|| summary.aiAttentionCount > 0
			|| summary.qcErrorCount > 0
			|| summary.qcWarningCount > 0
			|| summary.exportBlockers.length > 0;
	}
	if (filter === "blocked") return summary.status === "blocked";
	if (filter === "review") return summary.status === "review";
	if (filter === "tasks") return summary.taskOpenCount > 0;
	if (filter === "ready") return summary.exportReady;
	return true;
}

function legacyNormalizeSearch(value: string): string {
	return value.toLocaleLowerCase("th-TH").replace(/\s+/g, " ").trim();
}

// Mirrors the `chapterQueueSearchText` stable, locale-independent haystack the
// declarative filter substring-matches against.
function legacySearchText(summary: PageWorkSummary): string {
	const signal = summary.primarySignal;
	return [
		String(summary.pageNumber),
		`p${summary.pageNumber}`,
		`หน้า ${summary.pageNumber}`,
		summary.name,
		summary.statusLabel,
		summary.nextAction,
		signal.labelCode,
		signal.labelValues ? String(signal.labelValues.n) : "",
		signal.detail,
		summary.priorityLabel,
		...summary.assignees.map((value) => value.trim()).filter((value) => value.length > 0).slice(0, 2),
		...summary.exportBlockers,
	].join(" ");
}

function legacyVisibleIndexes(
	summaries: readonly PageWorkSummary[],
	filter: ChapterQueueFilter,
	rawSearch: string,
): number[] {
	const normalizedQuery = legacyNormalizeSearch(rawSearch);
	return summaries
		.filter((summary) => {
			const matchesFilter = legacyMatchesFilterForView(summary, filter);
			const matchesSearch = !normalizedQuery || legacyNormalizeSearch(legacySearchText(summary)).includes(normalizedQuery);
			return matchesFilter && matchesSearch;
		})
		.map((summary) => summary.pageIndex);
}

function makeSummary(overrides: Partial<PageWorkSummary> = {}): PageWorkSummary {
	return {
		pageIndex: 0,
		pageNumber: 1,
		name: "Page 1",
		layerCount: 1,
		status: "ready",
		statusLabel: "Ready",
		nextAction: "Ready for export review",
		primarySignal: {
			kind: "ready",
			severity: "ready",
			labelCode: "ready",
			detail: "Ready for export review",
			pageIndex: overrides.pageIndex ?? 0,
			actionKind: "export",
		},
		assetIntegrity: null,
		qcErrorCount: 0,
		qcWarningCount: 0,
		openCommentCount: 0,
		aiAttentionCount: 0,
		taskTotalCount: 0,
		taskOpenCount: 0,
		urgentTaskCount: 0,
		highTaskCount: 0,
		dueTaskCount: 0,
		overdueTaskCount: 0,
		nextDueAt: null,
		highestTaskPriority: "normal",
		priorityLabel: "Normal",
		assignees: [],
		latestReviewDecision: null,
		exportReady: true,
		exportBlockers: [],
		...overrides,
	};
}

describe("chapter queue helpers", () => {
	const pages = [
		makeSummary({ pageIndex: 0, pageNumber: 1, name: "Ready", exportReady: true }),
		makeSummary({
			pageIndex: 1,
			pageNumber: 2,
			name: "Review",
			status: "review",
			statusLabel: "Review",
			nextAction: "Resolve open review notes",
			exportReady: false,
			openCommentCount: 2,
			taskOpenCount: 1,
			dueTaskCount: 1,
			exportBlockers: ["2 open comments", "1 open task"],
		}),
		makeSummary({
			pageIndex: 2,
			pageNumber: 3,
			name: "Blocked",
			status: "blocked",
			statusLabel: "Blocked",
			nextAction: "Fix blocking QC or AI item",
			exportReady: false,
			aiAttentionCount: 1,
			exportBlockers: ["1 AI review item"],
		}),
	];

	it("counts production signals for a chapter queue", () => {
		expect(getChapterQueueStats(pages)).toEqual({
			totalPages: 3,
			attentionPages: 2,
			readyPages: 1,
			blockedPages: 1,
			reviewPages: 1,
			taskPages: 1,
			duePages: 1,
			overduePages: 0,
			openTasks: 1,
			openComments: 2,
			aiAttention: 1,
		});
	});

	it.each<[ChapterQueueFilter, number[]]>([
		["all", [0, 1, 2]],
		["attention", [1, 2]],
		["blocked", [2]],
		["review", [1]],
		["tasks", [1]],
		["ready", [0]],
	])("filters %s pages without changing page order", (filter, expectedIndexes) => {
		expect(filterChapterQueuePages(pages, filter).map((page) => page.pageIndex)).toEqual(expectedIndexes);
	});

	it("chooses the highest-risk page as the lead page", () => {
		expect(getChapterQueueLeadPage(pages)?.name).toBe("Blocked");
	});

	it("returns structured opened-queue signal codes in display order", () => {
		expect(chapterQueueSignals(makeSummary({
			openCommentCount: 1,
			taskOpenCount: 3,
			overdueTaskCount: 1,
			qcWarningCount: 1,
		}))).toEqual([
			{ code: "overdue", count: 1 },
			{ code: "comments", count: 1 },
			{ code: "open", count: 3 },
			{ code: "qc", count: 1 },
		]);
		expect(chapterQueueSignals(makeSummary())).toEqual([]);
	});

	it("returns structured assignee tokens for the Pages opened state", () => {
		expect(chapterQueueAssignees(["local-user", "solo", "qa"])).toEqual([
			{ code: "you" },
			{ code: "solo" },
		]);
		expect(chapterQueueAssignees(["Mai"])).toEqual([{ handle: "@Mai" }]);
		expect(chapterQueueAssignees(["qa"])).toEqual([{ handle: "QA" }]);
		expect(chapterQueueAssignees([])).toEqual([]);
	});

	it("searches long chapter queues by page number and production signals", () => {
		const longChapterPages = [
			makeSummary({ pageIndex: 0, pageNumber: 1, name: "Opening", assignees: ["cleaner"] }),
			makeSummary({
				pageIndex: 103,
				pageNumber: 104,
				name: "Dungeon reveal",
				statusLabel: "Blocked",
				nextAction: "Resolve SFX placement",
				primarySignal: {
					kind: "ai-placement",
					severity: "warning",
					labelCode: "ai-accepted-unplaced",
					detail: "Clean Pro result awaits placement",
					pageIndex: 103,
					actionKind: "open-ai-marker",
				},
				exportBlockers: ["AI result not placed"],
				assignees: ["typesetter"],
			}),
			makeSummary({ pageIndex: 119, pageNumber: 120, name: "Final credits", assignees: ["qc"] }),
		];

		expect(searchChapterQueuePages(longChapterPages, "104").map((page) => page.pageIndex)).toEqual([103]);
		// The signal headline is now searched by its STABLE locale-independent code
		// (`ai-accepted-unplaced`) and its dynamic detail text, not the Thai label.
		expect(searchChapterQueuePages(longChapterPages, "accepted-unplaced").map((page) => page.pageIndex)).toEqual([103]);
		expect(searchChapterQueuePages(longChapterPages, "awaits placement").map((page) => page.pageIndex)).toEqual([103]);
		expect(searchChapterQueuePages(longChapterPages, "typesetter").map((page) => page.pageIndex)).toEqual([103]);
		expect(searchChapterQueuePages(longChapterPages, " ").map((page) => page.pageIndex)).toEqual([0, 103, 119]);
	});
});

describe("declarative chapter queue filter+search parity", () => {
	// A representative, deliberately tricky fixture covering each filter axis plus
	// the RICHER "attention" cases that the in-component predicate caught beyond a
	// coarse status check (settled status but still-open signals / export blockers).
	const fixture: PageWorkSummary[] = [
		makeSummary({ pageIndex: 0, pageNumber: 1, name: "Clean ready", exportReady: true }),
		makeSummary({
			pageIndex: 1,
			pageNumber: 2,
			name: "Review with notes",
			status: "review",
			statusLabel: "Review",
			nextAction: "Resolve open review notes",
			exportReady: false,
			openCommentCount: 2,
			taskOpenCount: 1,
			dueTaskCount: 1,
			exportBlockers: ["2 open comments", "1 open task"],
		}),
		makeSummary({
			pageIndex: 2,
			pageNumber: 3,
			name: "Blocked by AI",
			status: "blocked",
			statusLabel: "Blocked",
			nextAction: "Fix blocking QC or AI item",
			exportReady: false,
			aiAttentionCount: 1,
			exportBlockers: ["1 AI review item"],
		}),
		makeSummary({
			pageIndex: 3,
			pageNumber: 4,
			name: "Overdue typeset",
			status: "review",
			statusLabel: "Review",
			exportReady: false,
			taskOpenCount: 2,
			overdueTaskCount: 1,
			assignees: ["typesetter"],
			exportBlockers: ["1 overdue task"],
		}),
		// RICHER ATTENTION CASE: coarse status is "ready" (so the old module-level
		// pageNeedsAttention would say "no attention"), but a lingering QC warning +
		// export blocker means the queue card MUST still surface under "attention".
		makeSummary({
			pageIndex: 4,
			pageNumber: 5,
			name: "Ready-ish with QC warning",
			status: "ready",
			statusLabel: "Ready",
			exportReady: false,
			qcWarningCount: 1,
			exportBlockers: ["1 QC warning"],
		}),
		// Edge: status "ready", exportReady true, zero signals → never attention.
		makeSummary({ pageIndex: 5, pageNumber: 6, name: "Truly done", exportReady: true }),
	];

	it("preserves the richer attention semantics (settled status but open signals)", () => {
		// page 4 has status "ready" yet carries a QC warning + export blocker.
		const richer = fixture[4];
		expect(richer.status).toBe("ready");
		expect(pageNeedsChapterQueueAttention(richer)).toBe(true);
		expect(pageMatchesChapterQueueFilter(richer, "attention")).toBe(true);
		// The truly-done page never reads as attention.
		expect(pageNeedsChapterQueueAttention(fixture[5])).toBe(false);
		expect(pageMatchesChapterQueueFilter(fixture[5], "attention")).toBe(false);
	});

	it.each(ALL_FILTERS)("matches the legacy in-component filter outcome for %s (no search)", (filter) => {
		expect(filterChapterQueuePages(fixture, filter).map((page) => page.pageIndex))
			.toEqual(legacyVisibleIndexes(fixture, filter, ""));
	});

	it.each<[ChapterQueueFilter, string]>([
		["all", ""],
		["all", "p5"],
		["all", "typesetter"],
		["attention", ""],
		["attention", "qc"],
		["attention", "หน้า 5"],
		["review", "notes"],
		["review", "overdue"],
		["blocked", "ai"],
		["tasks", "typesetter"],
		["ready", ""],
		["ready", "done"],
		["attention", "no-such-page"],
	])("selectChapterQueuePages(%s, %j) equals the legacy DOM visible set", (filter, search) => {
		const { filtered, visible } = selectChapterQueuePages(fixture, { filter, search });
		expect(filtered.map((page) => page.pageIndex)).toEqual(legacyVisibleIndexes(fixture, filter, ""));
		expect(visible.map((page) => page.pageIndex)).toEqual(legacyVisibleIndexes(fixture, filter, search));
	});

	it("matches the legacy substring search semantics per page", () => {
		for (const summary of fixture) {
			for (const query of ["p2", "typesetter", "qc", "หน้า 5", "นานๆ", ""]) {
				const expected = !legacyNormalizeSearch(query)
					|| legacyNormalizeSearch(legacySearchText(summary)).includes(legacyNormalizeSearch(query));
				expect(pageMatchesChapterQueueSearch(summary, query)).toBe(expected);
			}
		}
	});
});

describe("chapterQueue searchExtras (localized haystack)", () => {
	it("matches the caller-supplied localized status text, not just the raw code", () => {
		const summary = makeSummary({ pageIndex: 0, statusLabel: "Review", nextAction: "Review AI result" });
		// Raw haystack matches the producer code…
		expect(pageMatchesChapterQueueSearch(summary, "review")).toBe(true);
		// …but the VISIBLE localized text only matches when extras supply it.
		expect(pageMatchesChapterQueueSearch(summary, "รอรีวิวผล")).toBe(false);
		const extras = () => "รอรีวิวผล รีวิวผล AI";
		expect(pageMatchesChapterQueueSearch(summary, "รอรีวิวผล", extras)).toBe(true);
		expect(pageMatchesChapterQueueSearch(summary, "รีวิวผล ai", extras)).toBe(true);
		// Extras never break raw matching and empty queries still match everything.
		expect(pageMatchesChapterQueueSearch(summary, "review", extras)).toBe(true);
		expect(pageMatchesChapterQueueSearch(summary, "", extras)).toBe(true);
	});
});
