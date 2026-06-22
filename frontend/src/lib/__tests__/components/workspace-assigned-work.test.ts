import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import WorkspaceAssignedWork from "$lib/components/WorkspaceAssignedWork.svelte";
import type { WorkspaceAssignedWorkGroup } from "$lib/project/workspace-dashboard.js";

function assignedGroup(overrides: Partial<WorkspaceAssignedWorkGroup> = {}): WorkspaceAssignedWorkGroup {
	return {
		id: "assignee-mai",
		assignee: "Mai",
		label: "@Mai",
		openCount: 2,
		urgentCount: 1,
		highCount: 0,
		overdueCount: 1,
		reviewCount: 0,
		nextDueAt: "2026-05-14T10:00:00.000Z",
		firstOpenTaskId: "mai-clean",
		firstOpenPageIndex: 0,
		tasks: [
			{
				id: "mai-clean",
				type: "clean",
				typeLabel: "clean",
				status: "todo",
				priority: "urgent",
				pageIndex: 0,
				title: "Clean tall SFX page",
				assignee: "Mai",
				dueAt: "2026-05-14T10:00:00.000Z",
				overdue: true,
			},
			{
				id: "mai-typeset",
				type: "typeset",
				typeLabel: "typeset",
				status: "doing",
				priority: "normal",
				pageIndex: 1,
				title: "Typeset dialogue cards",
				assignee: "Mai",
				dueAt: null,
				overdue: false,
			},
		],
		...overrides,
	};
}

describe("WorkspaceAssignedWork", () => {
	it("filters assigned queues and focuses the visible next group", async () => {
		const reviewGroup = assignedGroup({
			id: "unassigned",
			assignee: null,
			label: "Unassigned queue",
			openCount: 1,
			urgentCount: 0,
			highCount: 1,
			overdueCount: 0,
			reviewCount: 1,
			nextDueAt: null,
			firstOpenTaskId: "review-page",
			firstOpenPageIndex: 2,
			tasks: [
				{
					id: "review-page",
					type: "review",
					typeLabel: "review",
					status: "review",
					priority: "high",
					pageIndex: 2,
					title: "Review page comments",
					assignee: null,
					dueAt: null,
					overdue: false,
				},
			],
		});
		const onFocusGroup = vi.fn();

		render(WorkspaceAssignedWork, {
			props: {
				projectOpen: true,
				groups: [assignedGroup(), reviewGroup],
				onFocusGroup,
				onOpenGroup: vi.fn(),
			},
		});

		await fireEvent.input(screen.getByRole("searchbox", { name: "ค้นหาคิวคนรับงาน" }), {
			target: { value: "review" },
		});

		expect(screen.queryByText("@Mai")).toBeNull();
		expect(screen.getByText("ยังไม่กำหนดคนรับงาน")).toBeTruthy();
		expect(screen.getByText("ตรวจหน้า โน้ต")).toBeTruthy();
		expect(screen.getAllByText("1 งานเปิด").length).toBeGreaterThan(0);

		await fireEvent.click(screen.getByRole("button", { name: "ทำคิวแรก" }));

		expect(onFocusGroup).toHaveBeenCalledWith(expect.objectContaining({
			id: "unassigned",
			firstOpenTaskId: "review-page",
		}));
	});

	it("shows an empty filtered state when no assigned work matches", async () => {
		render(WorkspaceAssignedWork, {
			props: {
				projectOpen: true,
				groups: [assignedGroup()],
				onFocusGroup: vi.fn(),
				onOpenGroup: vi.fn(),
			},
		});

		await fireEvent.input(screen.getByRole("searchbox", { name: "ค้นหาคิวคนรับงาน" }), {
			target: { value: "translator" },
		});

		expect(screen.getByText("ไม่เจองานที่ตรงกับคำค้น")).toBeTruthy();
		expect(screen.getByText("ไม่มีคิวคนรับงาน")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ทำคิวแรก" })).toBeNull();
		expect(document.querySelectorAll(".assigned-tools button:disabled")).toHaveLength(0);
	});

	it("uses a whole-work action label when an assigned group has no page target", () => {
		render(WorkspaceAssignedWork, {
			props: {
				projectOpen: true,
				groups: [
					assignedGroup({
						firstOpenPageIndex: null,
						tasks: [
							{
								id: "chapter-task",
								type: "review",
								typeLabel: "review",
								status: "todo",
								priority: "normal",
								pageIndex: 0,
								title: "Chapter glossary check",
								assignee: "Mai",
								dueAt: null,
								overdue: false,
							},
						],
					}),
				],
				onFocusGroup: vi.fn(),
				onOpenGroup: vi.fn(),
			},
		});

		expect(screen.getByRole("button", { name: "เปิดงาน" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เปิดหน้าแก้" })).toBeNull();
	});
});
