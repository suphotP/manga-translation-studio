import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import WorkspacePriorityInbox from "$lib/components/WorkspacePriorityInbox.svelte";
import type { WorkInboxItem } from "$lib/project/work-inbox.js";
import type { WorkspaceInboxSummary } from "$lib/project/workspace-dashboard.js";

function inboxItem(overrides: Partial<WorkInboxItem> = {}): WorkInboxItem {
	return {
		id: "task-1",
		kind: "workflow_task",
		severity: "warning",
		priority: "normal",
		pageIndex: 1,
		titleCode: "workflow",
		workflowTitle: { code: "typeset" },
		detail: { kind: "text", text: "Ready to place dialogue" },
		sourceId: "task-1",
		...overrides,
	};
}

function inboxSummary(overrides: Partial<WorkspaceInboxSummary> = {}): WorkspaceInboxSummary {
	return {
		totalCount: 2,
		blockerCount: 0,
		urgentCount: 1,
		overdueCount: 0,
		reviewCount: 0,
		commentCount: 1,
		qcCount: 0,
		aiCount: 1,
		...overrides,
	};
}

describe("WorkspacePriorityInbox", () => {
	it("names urgent inbox open actions by their concrete page target", async () => {
		const onOpenItemInEditor = vi.fn();
		const items = [
			inboxItem({
				id: "urgent-clean",
				priority: "urgent",
				pageIndex: 2,
				workflowTitle: { code: "clean" },
				sourceId: "urgent-clean",
			}),
			inboxItem({
				id: "ai-review",
				kind: "ai_marker",
				priority: "high",
				pageIndex: 4,
				titleCode: "ai_review",
				workflowTitle: undefined,
				detail: { kind: "ai_marker", tier: "budget-clean", hasCost: false },
				sourceId: "ai-review",
			}),
			inboxItem({
				id: "chapter-wide",
				pageIndex: undefined,
				workflowTitle: { code: "custom", customTitle: "Chapter glossary check" },
				sourceId: "chapter-wide",
			}),
		];

		render(WorkspacePriorityInbox, {
			props: {
				projectOpen: true,
				items,
				summary: inboxSummary(),
				onFocusItem: vi.fn(),
				onOpenItemInEditor,
			},
		});

		expect(screen.getByRole("button", { name: "แก้หน้า 3" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เปิดหน้าแก้" })).toBeNull();

		await fireEvent.click(screen.getByText("รายการด่วนอื่น"));
		expect(screen.getByRole("button", { name: "รีวิว AI หน้า 5" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดงาน" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "แก้หน้า 3" }));
		expect(onOpenItemInEditor).toHaveBeenCalledWith(expect.objectContaining({ id: "urgent-clean" }));
	});
});
