import { describe, expect, it } from "vitest";
import { buildChapterDashboard } from "$lib/project/chapter-dashboard.js";
import { EMPTY_PAGE_BATCH_SUMMARY, type PageWorkSummary } from "$lib/project/page-work-summary.js";

function summary(overrides: Partial<PageWorkSummary> = {}): PageWorkSummary {
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

describe("buildChapterDashboard", () => {
	it("builds chapter lanes, signals, and export progress", () => {
		const summaries: PageWorkSummary[] = [
			summary({ assignees: ["Mina"], layerCount: 3 }),
			summary({
				pageIndex: 1,
				pageNumber: 2,
				name: "Page 2",
				status: "blocked",
				statusLabel: "Blocked",
				exportReady: false,
				exportBlockers: ["QC error"],
				qcErrorCount: 1,
				urgentTaskCount: 1,
				overdueTaskCount: 1,
				dueTaskCount: 1,
				nextDueAt: "2000-01-01T00:00:00.000Z",
				highestTaskPriority: "urgent",
				priorityLabel: "Urgent",
				aiAttentionCount: 1,
				assetIntegrity: {
					pageIndex: 1,
					status: "blocked",
					label: "Blocked",
					detail: "Blocked by moderation",
				},
				assignees: ["Mina", "Ari"],
			}),
			summary({
				pageIndex: 2,
				pageNumber: 3,
				name: "Page 3",
				status: "review",
				statusLabel: "Review",
				exportReady: false,
				exportBlockers: ["open task"],
				qcWarningCount: 2,
				openCommentCount: 1,
				taskOpenCount: 1,
				highTaskCount: 1,
				highestTaskPriority: "high",
				priorityLabel: "High",
				assignees: ["Nok"],
			}),
		];
		const dashboard = buildChapterDashboard(summaries, {
			pageCount: 3,
			layerCount: 5,
			exportReadyCount: 1,
			blockedCount: 1,
			reviewCount: 1,
			attentionCount: 2,
			assetScanningCount: 0,
			assetBlockedCount: 1,
			commentCount: 1,
			aiAttentionCount: 1,
			urgentTaskCount: 1,
			highTaskCount: 1,
			dueTaskCount: 1,
			overdueTaskCount: 1,
		});

		expect(dashboard.exportReadyPercent).toBe(33);
		expect(dashboard.totalLayers).toBe(5);
		expect(dashboard.primaryLane.id).toBe("overdue");
		expect(dashboard.lanes.find((lane) => lane.id === "overdue")).toMatchObject({
			count: 1,
			firstPageIndex: 1,
			firstPageLabel: "P2",
		});
		expect(dashboard.lanes.find((lane) => lane.id === "urgent")).toMatchObject({
			count: 1,
			firstPageIndex: 1,
			firstPageLabel: "P2",
		});
		expect(dashboard.lanes.find((lane) => lane.id === "high")).toMatchObject({
			count: 1,
			firstPageIndex: 2,
			firstPageLabel: "P3",
		});
		expect(dashboard.lanes.find((lane) => lane.id === "blocked")).toMatchObject({
			count: 1,
			firstPageIndex: 1,
			firstPageLabel: "P2",
		});
		expect(dashboard.signals).toMatchObject({
			assetScanning: 0,
			assetBlocked: 1,
			openComments: 1,
			aiAttention: 1,
			qcErrors: 1,
			qcWarnings: 2,
			openTasks: 1,
			dueTasks: 1,
			overdueTasks: 1,
			urgentTasks: 1,
			highTasks: 1,
			assignees: 3,
		});
	});

	it("returns a stable empty dashboard for no project", () => {
		const dashboard = buildChapterDashboard([], EMPTY_PAGE_BATCH_SUMMARY);

		expect(dashboard.totalPages).toBe(0);
		expect(dashboard.exportReadyPercent).toBe(0);
		expect(dashboard.primaryLane.id).toBe("attention");
		expect(dashboard.lanes.every((lane) => lane.firstPageLabel === "-")).toBe(true);
	});

	it("counts zero-layer pages in the no-text lane even when they have review work", () => {
		const dashboard = buildChapterDashboard([
			summary({
				layerCount: 0,
				status: "review",
				statusLabel: "Review",
				taskOpenCount: 4,
				exportReady: false,
				exportBlockers: ["open task", "no editable text layers"],
			}),
			summary({
				pageIndex: 1,
				pageNumber: 2,
				layerCount: 8,
				status: "review",
				statusLabel: "Review",
			}),
		], {
			...EMPTY_PAGE_BATCH_SUMMARY,
			pageCount: 2,
			layerCount: 8,
			reviewCount: 2,
			attentionCount: 2,
		});

		expect(dashboard.lanes.find((lane) => lane.id === "empty")).toMatchObject({
			count: 1,
			firstPageIndex: 0,
			firstPageLabel: "P1",
		});
		expect(dashboard.lanes.find((lane) => lane.id === "review")).toMatchObject({
			count: 2,
		});
	});
});
