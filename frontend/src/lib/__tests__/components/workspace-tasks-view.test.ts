import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import "$lib/i18n";
import WorkspaceTasksView from "$lib/components/WorkspaceTasksView.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
import type { WorkspaceHomeAggregate, WorkspaceHomeTask } from "$lib/api/client.js";
import type { ProjectState } from "$lib/types.js";

const now = "2026-06-12T00:00:00.000Z";

function homeTask(overrides: Partial<WorkspaceHomeTask> = {}): WorkspaceHomeTask {
	return {
		id: "task-1",
		projectId: "project-1",
		projectName: "Glass Harbor",
		storyTitle: "Glass Harbor",
		chapterLabel: "ตอน 1",
		targetLang: "th",
		type: "translate",
		status: "todo",
		priority: "normal",
		title: "Translate opener",
		pageIndex: 0,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function homeAggregate(overrides: Partial<WorkspaceHomeAggregate> = {}): WorkspaceHomeAggregate {
	return {
		workspaceId: "ws-1",
		generatedAt: now,
		myTasks: [],
		attention: [],
		activity: [],
		aiJobs: [],
		pipelineByStage: [
			{ stage: "translate", todo: 0, doing: 0, review: 0, done: 0, total: 0, open: 0 },
			{ stage: "clean", todo: 0, doing: 0, review: 0, done: 0, total: 0, open: 0 },
			{ stage: "typeset", todo: 0, doing: 0, review: 0, done: 0, total: 0, open: 0 },
			{ stage: "review", todo: 0, doing: 0, review: 0, done: 0, total: 0, open: 0 },
		],
		dueToday: [],
		counts: { projects: 0, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		targetLangs: [],
		recentProject: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Glass Harbor ตอน 1",
		createdAt: now,
		currentPage: 0,
		targetLang: "th",
		pages: [
			{
				imageId: "image-1",
				imageName: "page-1.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	workspaceHomeStore.__resetForTesting();
	editorStore.editor = null;
	window.history.replaceState({}, "", "/tasks");
	editorUiStore.openTasks();
});

describe("WorkspaceTasksView", () => {
	it("filters all, today, overdue, and searches by task title", async () => {
		const todayTask = homeTask({
			id: "today",
			projectId: "project-today",
			title: "Letter page today",
			dueAt: now,
			// "soon" = due today/imminent — the วันนี้ chip filters the USER's own
			// rows by this state (the workspace-wide dueToday aggregate is not used).
			dueState: "soon",
		});
		const overdueTask = homeTask({
			id: "overdue",
			projectId: "project-overdue",
			title: "Clean overdue panel",
			type: "clean",
			dueAt: "2026-06-10T00:00:00.000Z",
			dueState: "overdue",
		});
		const laterTask = homeTask({
			id: "later",
			projectId: "project-later",
			title: "Review later page",
			type: "review",
			pageIndex: 2,
		});
		workspaceHomeStore.aggregate = homeAggregate({
			myTasks: [todayTask, overdueTask, laterTask],
			dueToday: [todayTask],
			counts: { projects: 3, myOpenTasks: 3, attention: 0, aiJobs: 0, dueToday: 1, overdue: 1, openTasks: 3 },
		});

		render(WorkspaceTasksView);

		expect(screen.getAllByTestId("tasks-page-row")).toHaveLength(3);

		await fireEvent.click(screen.getByRole("button", { name: /วันนี้/ }));
		expect(screen.getByText("Letter page today")).toBeTruthy();
		expect(screen.queryByText("Clean overdue panel")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /เกินกำหนด/ }));
		expect(screen.getByText("Clean overdue panel")).toBeTruthy();
		expect(screen.queryByText("Letter page today")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /^ทั้งหมด/ }));
		await fireEvent.input(screen.getByLabelText("ค้นหาชื่องาน"), { target: { value: "  review  " } });
		expect(screen.getByText("Review later page")).toBeTruthy();
		expect(screen.queryByText("Letter page today")).toBeNull();

		await fireEvent.input(screen.getByLabelText("ค้นหาชื่องาน"), { target: { value: "missing" } });
		expect(screen.getByTestId("tasks-page-no-results")).toBeTruthy();
	});

	it("opens the row project first, then routes to that project's work board", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			myTasks: [homeTask({ id: "target", projectId: "target-project", title: "Open target task" })],
			counts: { projects: 1, myOpenTasks: 1, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 1 },
		});
		const openSpy = vi.spyOn(projectStore, "openProject").mockImplementation(async (projectId: string) => {
			projectStore.__setProjectForTesting(project({ projectId }));
			return true;
		});

		render(WorkspaceTasksView);

		await fireEvent.click(screen.getByRole("button", { name: /เปิดงาน Open target task/ }));

		expect(openSpy).toHaveBeenCalledWith("target-project", null);
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("work"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/target-project/work"));
	});

	it("renders an honest empty state when no workspace tasks are assigned", () => {
		workspaceHomeStore.aggregate = homeAggregate();

		render(WorkspaceTasksView);

		expect(screen.getByTestId("tasks-page-empty")).toBeTruthy();
		expect(screen.queryByTestId("tasks-page-row")).toBeNull();
	});
});
