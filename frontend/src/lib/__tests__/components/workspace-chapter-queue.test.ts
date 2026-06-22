import { describe, expect, it, vi } from "vitest";
import "$lib/i18n";
import { fireEvent, render, within } from "@testing-library/svelte";
import WorkspaceChapterQueue from "$lib/components/WorkspaceChapterQueue.svelte";
import type { PageWorkSummary } from "$lib/project/page-work-summary.js";
import type { ProjectState } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

function project(): ProjectState {
	return {
		projectId: "project-1",
		name: "Alpha Chapter 1",
		createdAt: now,
		currentPage: 0,
		targetLang: "en",
		// Plain image names (not UUID asset ids) so the queue renders its placeholder
		// branch and never invokes the signedAssetSrc token flow under jsdom.
		pages: [
			{ imageId: "p1", imageName: "page-1.png", textLayers: [], pendingAiJobs: [], coverRect: null },
			{ imageId: "p2", imageName: "page-2.png", textLayers: [], pendingAiJobs: [], coverRect: null },
			{ imageId: "p3", imageName: "page-3.png", textLayers: [], pendingAiJobs: [], coverRect: null },
		],
	};
}

function summary(overrides: Partial<PageWorkSummary>): PageWorkSummary {
	return {
		pageIndex: 0,
		pageNumber: 1,
		name: "Page",
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

const summaries: PageWorkSummary[] = [
	summary({ pageIndex: 0, pageNumber: 1, name: "Ready", exportReady: true }),
	summary({
		pageIndex: 1,
		pageNumber: 2,
		name: "Review",
		status: "review",
		statusLabel: "Review",
		exportReady: false,
		openCommentCount: 1,
		taskOpenCount: 1,
		exportBlockers: ["1 open comment", "1 open task"],
		assignees: ["typesetter"],
	}),
	summary({
		pageIndex: 2,
		pageNumber: 3,
		name: "Blocked",
		status: "blocked",
		statusLabel: "Blocked",
		exportReady: false,
		aiAttentionCount: 1,
		exportBlockers: ["1 AI review item"],
	}),
];

function renderQueue() {
	return render(WorkspaceChapterQueue, {
		props: {
			project: project(),
			summaries,
			selectedPageIndex: 0,
			variant: "wide",
			onOpenPage: vi.fn(),
			onOpenWork: vi.fn(),
			onOpenProjectPanel: vi.fn(),
		},
	});
}

// A card is "shown" when its anchor is not hidden by the reactive filter/search.
function shownPageNumbers(root: HTMLElement): number[] {
	return Array.from(root.querySelectorAll<HTMLElement>("[data-queue-card='page']"))
		.filter((card) => !card.hidden)
		.map((card) => Number(card.dataset.queuePageIndex) + 1);
}

describe("WorkspaceChapterQueue reactive filtering", () => {
	it("defaults to the attention filter and shows only attention pages", () => {
		const { container } = renderQueue();
		const root = within(container).getByRole("region", { name: "หน้าในตอน" }) as HTMLElement;
		expect(root.dataset.queueFilter).toBe("attention");
		// Pages 2 (review) and 3 (blocked) need attention; page 1 (ready) does not.
		expect(shownPageNumbers(root)).toEqual([2, 3]);
		expect(root.dataset.queueVisibleCount).toBe("2");
	});

	it("switches the visible cards when a filter tab is clicked", async () => {
		const { container } = renderQueue();
		const root = within(container).getByRole("region", { name: "หน้าในตอน" }) as HTMLElement;

		await fireEvent.click(root.querySelector<HTMLElement>("[data-queue-filter='blocked']")!);
		expect(root.dataset.queueFilter).toBe("blocked");
		expect(shownPageNumbers(root)).toEqual([3]);

		await fireEvent.click(root.querySelector<HTMLElement>("[data-queue-filter='all']")!);
		expect(root.dataset.queueFilter).toBe("all");
		expect(shownPageNumbers(root)).toEqual([1, 2, 3]);
	});

	it("narrows cards reactively as the search query changes (within the active filter)", async () => {
		const { container } = renderQueue();
		const root = within(container).getByRole("region", { name: "หน้าในตอน" }) as HTMLElement;

		await fireEvent.click(root.querySelector<HTMLElement>("[data-queue-filter='all']")!);
		const searchInput = root.querySelector<HTMLInputElement>("[data-queue-search='pages']")!;

		await fireEvent.input(searchInput, { target: { value: "typesetter" } });
		expect(shownPageNumbers(root)).toEqual([2]);
		expect(root.dataset.queueVisibleCount).toBe("1");
		expect(root.dataset.queueFilteredCount).toBe("3");

		await fireEvent.input(searchInput, { target: { value: "p3" } });
		expect(shownPageNumbers(root)).toEqual([3]);

		await fireEvent.input(searchInput, { target: { value: "no-such-page" } });
		expect(shownPageNumbers(root)).toEqual([]);
		const emptyState = root.querySelector<HTMLElement>("[data-queue-empty]")!;
		expect(emptyState.hidden).toBe(false);
		expect(emptyState.textContent).toContain('ไม่พบหน้า "no-such-page" ในตัวกรองนี้');
	});
});
