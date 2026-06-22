import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "$lib/i18n";
import { fireEvent, render, screen } from "@testing-library/svelte";
import ChapterDashboardPanel from "$lib/components/ChapterDashboardPanel.svelte";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import { buildChapterDashboard } from "$lib/project/chapter-dashboard.js";
import type { PageBatchSummary, PageWorkSummary } from "$lib/project/page-work-summary.js";

function summary(overrides: Partial<PageWorkSummary> = {}): PageWorkSummary {
	return {
		pageIndex: 0,
		pageNumber: 1,
		name: "Page 1",
		layerCount: 2,
		status: "blocked",
		statusLabel: "Blocked",
		nextAction: "Fix blocking QC or AI item",
		primarySignal: {
			kind: "qc-error",
			severity: "error",
			labelCode: "qc-error",
			labelValues: { n: 1 },
			detail: "Fix blocking QC or AI item",
			pageIndex: overrides.pageIndex ?? 0,
			sourceKind: "qc",
			focusFilter: "blockers",
			actionKind: "open-focus",
		},
		assetIntegrity: null,
		qcErrorCount: 1,
		qcWarningCount: 0,
		openCommentCount: 0,
		aiAttentionCount: 1,
		taskTotalCount: 0,
		taskOpenCount: 0,
		urgentTaskCount: 0,
		highTaskCount: 0,
		dueTaskCount: 0,
		overdueTaskCount: 0,
		nextDueAt: null,
		highestTaskPriority: "normal",
		priorityLabel: "Normal",
		assignees: ["Mina"],
		latestReviewDecision: null,
		exportReady: false,
		exportBlockers: ["QC error"],
		...overrides,
	};
}


function __ownerWs() { return { workspaceId: "ws-test", name: "T", planId: "free", storageIncludedBytes: 0, storageExtraBytes: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", memberRole: "owner" as const, memberScope: {} }; }

beforeEach(() => {
	workspacesStore.workspaces = [__ownerWs()];
	workspacesStore.currentWorkspaceId = "ws-test";
	editorUiStore.setWorkspaceTeamMode("lead");
});
afterEach(() => {
	workspacesStore.workspaces = [];
	workspacesStore.currentWorkspaceId = null;
});

describe("ChapterDashboardPanel", () => {
	it("renders chapter operations and delegates group actions", async () => {
		const summaries = [
			summary({
				urgentTaskCount: 1,
				overdueTaskCount: 1,
				dueTaskCount: 1,
				nextDueAt: "2000-01-01T00:00:00.000Z",
				highestTaskPriority: "urgent",
				priorityLabel: "Urgent",
			}),
			summary({
				pageIndex: 1,
				pageNumber: 2,
				status: "ready",
				statusLabel: "Ready",
				nextAction: "Ready for export review",
				qcErrorCount: 0,
				aiAttentionCount: 0,
				exportReady: true,
				exportBlockers: [],
			}),
		];
		const batchSummary: PageBatchSummary = {
			pageCount: 2,
			layerCount: 4,
			exportReadyCount: 1,
			blockedCount: 1,
			reviewCount: 0,
			attentionCount: 1,
			assetScanningCount: 0,
			assetBlockedCount: 0,
			commentCount: 0,
			aiAttentionCount: 1,
			urgentTaskCount: 1,
			highTaskCount: 0,
			dueTaskCount: 1,
			overdueTaskCount: 1,
		};
		const openLane = vi.fn();
		const filterLane = vi.fn();

		render(ChapterDashboardPanel, {
			props: {
				dashboard: buildChapterDashboard(summaries, batchSummary),
				currentPageSummary: summaries[0],
				activeBatchSummary: batchSummary,
				activeExportGate: {
					pageCount: 2,
					readyCount: 1,
					holdCount: 1,
					canExport: false,
					readyPageNumbers: [2],
					holdPageNumbers: [1],
					firstHoldPageIndex: 0,
					firstHoldReason: "QC error",
					message: "1 หน้ายังติด gate",
					checklist: [],
				},
				batchExportTargetLabel: "Public",
				batchScopeLabel: "ตัวกรองนี้",
				onOpenLane: openLane,
				onFilterLane: filterLane,
			},
		});

		expect(screen.getByText("ภาพรวมตอน")).toBeTruthy();
		expect(screen.getByText("50% พร้อม Export")).toBeTruthy();
		expect(screen.getAllByText("1 เลยกำหนด").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("1 ด่วน")).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดกลุ่ม เลยกำหนด" })).toBeTruthy();
		// Coaching line removed (status-not-coaching): the panel no longer instructs.
		expect(screen.queryByText("แก้จุดค้างจาก QC หรือผล AI")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดกลุ่ม เลยกำหนด" }));
		await fireEvent.click(screen.getByRole("button", { name: "กรองกลุ่ม เลยกำหนด" }));

		expect(openLane).toHaveBeenCalledWith("overdue");
		expect(filterLane).toHaveBeenCalledWith("overdue");
	});
});
