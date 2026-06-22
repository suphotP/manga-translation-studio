import { describe, expect, it } from "vitest";
import {
	buildBatchExportGate,
	buildExportChecklist,
	classifyExportBlocker,
	createPageMovePlan,
	getPageTaskType,
	movePageItems,
	remapOptionalPageIndex,
	remapPageIndex,
	remapPageTaskId,
	remapPageTaskIds,
	remapPageTaskMetadata,
	remapWorkflowTaskTitle,
} from "$lib/project/page-operations.js";
import type { PageWorkSummary } from "$lib/project/page-work-summary.js";

function makeSummary(overrides: Partial<PageWorkSummary> = {}): PageWorkSummary {
	const pageIndex = overrides.pageIndex ?? 0;
	return {
		pageIndex,
		pageNumber: pageIndex + 1,
		name: `Page ${pageIndex + 1}`,
		layerCount: 1,
		status: "ready",
		statusLabel: "Ready",
		nextAction: "Ready for export review",
		primarySignal: {
			kind: "ready",
			severity: "ready",
			labelCode: "ready",
			detail: "Ready for export review",
			pageIndex,
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

describe("page operations", () => {
	it("moves page items and maps old page indexes to their new positions", () => {
		const result = movePageItems(["p1", "p2", "p3", "p4"], 1, 3);

		expect(result.items).toEqual(["p1", "p3", "p4", "p2"]);
		expect(result.plan).toMatchObject({
			fromIndex: 1,
			toIndex: 3,
			moved: true,
		});
		expect(remapPageIndex(0, result.plan)).toBe(0);
		expect(remapPageIndex(1, result.plan)).toBe(3);
		expect(remapPageIndex(2, result.plan)).toBe(1);
		expect(remapPageIndex(3, result.plan)).toBe(2);
	});

	it("maps indexes correctly when moving a page toward the front", () => {
		const result = movePageItems(["p1", "p2", "p3", "p4"], 3, 1);

		expect(result.items).toEqual(["p1", "p4", "p2", "p3"]);
		expect(remapPageIndex(0, result.plan)).toBe(0);
		expect(remapPageIndex(1, result.plan)).toBe(2);
		expect(remapPageIndex(2, result.plan)).toBe(3);
		expect(remapPageIndex(3, result.plan)).toBe(1);
	});

	it("keeps an identity plan for invalid or no-op moves", () => {
		const plan = createPageMovePlan(3, 9, 1);

		expect(plan.moved).toBe(false);
		expect(plan.toIndex).toBe(1);
		expect(remapPageIndex(0, plan)).toBe(0);
		expect(remapPageIndex(1, plan)).toBe(1);
		expect(remapOptionalPageIndex(undefined, plan)).toBeUndefined();
	});

	it("renames default page task ids so workflow status follows moved page content", () => {
		const { plan } = movePageItems(["p1", "p2", "p3"], 0, 2);

		expect(remapPageTaskId("page-0-review", plan)).toBe("page-2-review");
		expect(remapPageTaskId("page-1-clean", plan)).toBe("page-0-clean");
		expect(remapPageTaskId("page-2-typeset-layer-a", plan)).toBe("page-1-typeset-layer-a");
		expect(remapPageTaskId("custom-task", plan)).toBe("custom-task");
		expect(getPageTaskType("page-2-typeset-layer-a")).toBe("typeset");
		expect(getPageTaskType("custom-task")).toBeNull();
		expect(remapPageTaskIds(["page-0-review", "custom-task"], plan)).toEqual(["page-2-review", "custom-task"]);
		// Persisted titles stay CANONICAL English — classifiers pattern-match them
	// and relocalize at display time (codex P2).
	expect(remapWorkflowTaskTitle("Review page 1", "review", 2)).toBe("Review page 3");
		expect(remapWorkflowTaskTitle("Final review pass", "review", 2)).toBe("Final review pass");
	});

	it("renames task references inside shallow activity metadata", () => {
		const { plan } = movePageItems(["p1", "p2"], 0, 1);

		expect(remapPageTaskMetadata({
			taskId: "page-0-review",
			linkedTaskId: "page-1-clean",
			linkedTaskIds: ["page-0-typeset", "external-task"],
		}, plan)).toEqual({
			taskId: "page-1-review",
			linkedTaskId: "page-0-clean",
			linkedTaskIds: ["page-1-typeset", "external-task"],
		});
	});

	it("blocks batch export and exposes an all-blockers checklist (not a single first-hold)", () => {
		const gate = buildBatchExportGate([
			makeSummary({ pageIndex: 0 }),
			makeSummary({
				pageIndex: 1,
				pageNumber: 2,
				status: "review",
				statusLabel: "Review",
				exportReady: false,
				exportBlockers: ["1 open comment", "1 QC warning"],
			}),
			makeSummary({
				pageIndex: 2,
				pageNumber: 3,
				status: "review",
				statusLabel: "Review",
				exportReady: false,
				exportBlockers: ["2 open comments"],
			}),
		]);

		expect(gate.canExport).toBe(false);
		expect(gate.readyCount).toBe(1);
		expect(gate.holdCount).toBe(2);
		expect(gate.holdPageNumbers).toEqual([2, 3]);

		// Checklist groups EVERY blocker type across ALL held pages, not just the
		// first hold on the first held page.
		const types = gate.checklist.map((group) => group.type).sort();
		expect(types).toEqual(["open_qc_comment", "qc_issue"]);

		const comments = gate.checklist.find((group) => group.type === "open_qc_comment");
		// 1 (page 2) + 2 (page 3) open comments rolled up across pages.
		expect(comments?.count).toBe(3);
		expect(comments?.pages.map((p) => p.pageNumber)).toEqual([2, 3]);

		const qc = gate.checklist.find((group) => group.type === "qc_issue");
		expect(qc?.count).toBe(1);
		expect(qc?.pages[0]?.pageNumber).toBe(2);
	});

	it("passes a batch gate only when every page is export ready (empty checklist)", () => {
		const gate = buildBatchExportGate([
			makeSummary({ pageIndex: 0 }),
			makeSummary({ pageIndex: 1, pageNumber: 2 }),
		]);

		expect(gate.canExport).toBe(true);
		expect(gate.readyPageNumbers).toEqual([1, 2]);
		expect(gate.message).toBe("ส่งออกพร้อมแล้ว: 2 หน้า");
		expect(gate.checklist).toEqual([]);
	});

	it("allows export for art-only pages and default open tasks (aligned with backend readiness)", () => {
		// summarizePageWork no longer emits "no editable text layers" or "open task"
		// blockers, so an art-only chapter with auto-seeded open todos is export-ready.
		// This guards the FE gate against re-introducing those non-blockers.
		const gate = buildBatchExportGate([
			// Art-only page: zero text layers, but no real blockers.
			makeSummary({ pageIndex: 0, layerCount: 0, status: "empty", statusLabel: "No text" }),
			// Page with default open workflow tasks (status "review") but no blockers.
			makeSummary({ pageIndex: 1, pageNumber: 2, status: "review", statusLabel: "Review", taskOpenCount: 2 }),
		]);

		expect(gate.canExport).toBe(true);
		expect(gate.holdCount).toBe(0);
		expect(gate.readyPageNumbers).toEqual([1, 2]);
		expect(gate.checklist).toEqual([]);
	});

	it("still blocks export when a page carries a GENUINE blocker", () => {
		// Guard the other direction: a real blocker (failed asset) must keep the gate
		// closed even though text-layer / open-task gates were removed.
		const gate = buildBatchExportGate([
			makeSummary({ pageIndex: 0 }),
			makeSummary({
				pageIndex: 1,
				pageNumber: 2,
				status: "blocked",
				statusLabel: "Blocked",
				exportReady: false,
				exportBlockers: ["image asset not ready"],
			}),
		]);

		expect(gate.canExport).toBe(false);
		expect(gate.holdPageNumbers).toEqual([2]);
		expect(gate.checklist.map((group) => group.type)).toContain("asset_not_ready");
	});

	it("classifies blocker strings into canonical checklist types", () => {
		expect(classifyExportBlocker("2 open comments")).toBe("open_qc_comment");
		expect(classifyExportBlocker("1 QC error")).toBe("qc_issue");
		expect(classifyExportBlocker("3 AI review items")).toBe("unresolved_ai_marker");
		expect(classifyExportBlocker("image asset not ready")).toBe("asset_not_ready");
		expect(classifyExportBlocker("no editable text layers")).toBe("untranslated_text");
		expect(classifyExportBlocker("required credit missing")).toBe("required_credit_missing");
		expect(classifyExportBlocker("page review approval not recorded")).toBe("review_not_approved");
		expect(classifyExportBlocker("2 open tasks")).toBe("open_task");
	});

	it("buildExportChecklist preserves per-page jump targets in page order", () => {
		const groups = buildExportChecklist([
			makeSummary({ pageIndex: 2, pageNumber: 3, exportReady: false, exportBlockers: ["1 open comment"] }),
			makeSummary({ pageIndex: 0, pageNumber: 1, exportReady: false, exportBlockers: ["1 open comment"] }),
		]);
		const comments = groups.find((group) => group.type === "open_qc_comment");
		// Pages sorted by index even though summaries arrived out of order.
		expect(comments?.pages.map((p) => p.pageNumber)).toEqual([1, 3]);
	});

	it("buildExportChecklist merges multiple same-type blockers on one page into a single ref", () => {
		// A QC error and a QC warning both classify to `qc_issue`; one page must
		// appear once with a summed count and combined detail, not twice.
		const groups = buildExportChecklist([
			makeSummary({
				pageIndex: 1,
				pageNumber: 2,
				exportReady: false,
				exportBlockers: ["2 QC errors", "1 QC warning"],
			}),
		]);
		const qc = groups.find((group) => group.type === "qc_issue");
		expect(qc?.count).toBe(3);
		// Exactly one page ref for the single affected page.
		expect(qc?.pages).toHaveLength(1);
		expect(qc?.pages[0]?.pageNumber).toBe(2);
		expect(qc?.pages[0]?.count).toBe(3);
		// Both raw blocker strings are preserved in the combined detail.
		expect(qc?.pages[0]?.detail).toContain("2 QC errors");
		expect(qc?.pages[0]?.detail).toContain("1 QC warning");
	});
});
