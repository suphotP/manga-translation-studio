import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import WorkspaceJobLanes from "$lib/components/WorkspaceJobLanes.svelte";
import type { WorkspaceJobLane } from "$lib/project/workspace-dashboard.js";

function lane(overrides: Partial<WorkspaceJobLane> = {}): WorkspaceJobLane {
	return {
		id: "translate",
		label: "translate",
		totalCount: 4,
		openCount: 2,
		doneCount: 2,
		urgentCount: 0,
		overdueCount: 0,
		assignees: ["Mai"],
		firstOpenTaskId: "translate-1",
		firstOpenPageIndex: 1,
		firstOpenTaskTitle: "Translate very long vertical page dialogue",
		nextDueAt: "2026-05-14T10:00:00.000Z",
		...overrides,
	};
}

describe("WorkspaceJobLanes", () => {
	it("opens an active lane with next task context", async () => {
		const onOpenLane = vi.fn();
		const activeLane = lane();

		render(WorkspaceJobLanes, {
			props: {
				lanes: [activeLane],
				onOpenLane,
			},
		});

		expect(screen.getByText("Translate very long vertical page dialogue")).toBeTruthy();
		expect(screen.getByText("@Mai")).toBeTruthy();
		expect(screen.getByText("หน้า 2")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: /Translate/ }));

		expect(onOpenLane).toHaveBeenCalledWith(activeLane);
	});

	it("formats imported-dialogue review lane titles as product copy", () => {
		render(WorkspaceJobLanes, {
			props: {
				lanes: [
					lane({
						id: "review",
						label: "review",
						firstOpenPageIndex: 0,
						firstOpenTaskTitle: "Page 1 - Review imported dialogue",
					}),
				],
				onOpenLane: vi.fn(),
			},
		});

		expect(screen.getByText("หน้า 1: รีวิวข้อความ Import")).toBeTruthy();
		expect(screen.queryByText(/Review imported dialogue/)).toBeNull();
	});

	it("keeps empty lanes disabled and readable", () => {
		render(WorkspaceJobLanes, {
			props: {
				lanes: [
					lane({
						id: "review",
						label: "review",
						totalCount: 0,
						openCount: 0,
						doneCount: 0,
						assignees: [],
						firstOpenTaskId: null,
						firstOpenPageIndex: null,
						firstOpenTaskTitle: null,
						nextDueAt: null,
					}),
				],
				onOpenLane: vi.fn(),
			},
		});

		expect(screen.getByLabelText("ขั้นตอน ตรวจหน้า เคลียร์แล้ว")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /ตรวจหน้า/ })).toBeNull();
		expect(screen.getByText("ยังไม่มีงาน")).toBeTruthy();
		expect(screen.getByText("ยังไม่กำหนดคนรับงาน")).toBeTruthy();
	});

	it("uses page-state hints for empty team lanes when task lanes have no explicit tasks", () => {
		render(WorkspaceJobLanes, {
			props: {
				lanes: [
					lane({
						id: "translate",
						label: "translate",
						totalCount: 0,
						openCount: 0,
						doneCount: 0,
						assignees: [],
						firstOpenTaskId: null,
						firstOpenPageIndex: null,
						firstOpenTaskTitle: null,
						nextDueAt: null,
					}),
				],
				emptyLaneLabels: {
					translate: "1 หน้าจากสถานะหน้า",
				},
				onOpenLane: vi.fn(),
			},
		});

		expect(screen.getByText("1 หน้าจากสถานะหน้า")).toBeTruthy();
		expect(screen.queryByText("ยังไม่มีงาน")).toBeNull();
	});
});
