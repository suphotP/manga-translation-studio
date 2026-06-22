import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import "$lib/i18n";
import WorkspaceInboxPageView from "$lib/components/WorkspaceInboxPageView.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
import type { WorkspaceHomeAggregate, WorkspaceHomeFeedItem } from "$lib/api/client.js";
import type { ProjectState } from "$lib/types.js";

const now = "2026-06-12T00:00:00.000Z";

function attentionItem(overrides: Partial<WorkspaceHomeFeedItem> = {}): WorkspaceHomeFeedItem {
	return {
		id: "attention-1",
		kind: "task",
		sourceId: "task-1",
		title: "Review page one",
		detail: "High / todo",
		pageIndex: 0,
		createdAt: now,
		projectId: "project-1",
		projectName: "Glass Harbor",
		storyId: "story-1",
		storyTitle: "Glass Harbor",
		chapterLabel: "ตอน 1",
		targetLang: "th",
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
	window.history.replaceState({}, "", "/inbox");
	editorUiStore.openInbox();
});

describe("WorkspaceInboxPageView", () => {
	it("filters all attention rows down to dashboard-hot urgent rows", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			attention: [
				attentionItem({ id: "error", title: "Provider failed", severity: "error" }),
				attentionItem({ id: "overdue", title: "Overdue clean task", dueState: "overdue" }),
				attentionItem({ id: "urgent", title: "Urgent review task", priority: "urgent" }),
				attentionItem({ id: "warning", title: "Warning only", severity: "warning", priority: "high" }),
			],
			counts: { projects: 4, myOpenTasks: 0, attention: 4, aiJobs: 0, dueToday: 0, overdue: 1, openTasks: 4 },
		});

		render(WorkspaceInboxPageView);

		expect(screen.getAllByTestId("inbox-page-row")).toHaveLength(4);

		await fireEvent.click(within(screen.getByTestId("inbox-page-toolbar")).getByRole("button", { name: /ด่วน/ }));

		expect(screen.getAllByTestId("inbox-page-row")).toHaveLength(3);
		expect(screen.getByText("Provider failed")).toBeTruthy();
		expect(screen.getByText("Overdue clean task")).toBeTruthy();
		expect(screen.getByText("Urgent review task")).toBeTruthy();
		expect(screen.queryByText("Warning only")).toBeNull();
	});

	it("shows an urgent-filter empty state when attention exists but none is hot", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			attention: [attentionItem({ id: "warning", title: "Warning only", severity: "warning", priority: "high" })],
			counts: { projects: 1, myOpenTasks: 0, attention: 1, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 1 },
		});

		render(WorkspaceInboxPageView);

		await fireEvent.click(within(screen.getByTestId("inbox-page-toolbar")).getByRole("button", { name: /ด่วน/ }));

		expect(screen.getByTestId("inbox-page-no-results")).toBeTruthy();
		expect(screen.queryByTestId("inbox-page-row")).toBeNull();
	});

	it("opens the row project first, then routes to that project's work board", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			attention: [attentionItem({ id: "target", projectId: "target-project", title: "Open target blocker", severity: "error" })],
			counts: { projects: 1, myOpenTasks: 0, attention: 1, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 1 },
		});
		const openSpy = vi.spyOn(projectStore, "openProject").mockImplementation(async (projectId: string) => {
			projectStore.__setProjectForTesting(project({ projectId }));
			return true;
		});

		render(WorkspaceInboxPageView);

		await fireEvent.click(screen.getByRole("button", { name: /Open target blocker/ }));

		expect(openSpy).toHaveBeenCalledWith("target-project", null);
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("work"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/target-project/work"));
	});

	it("renders an honest empty state when the workspace has no attention items", () => {
		workspaceHomeStore.aggregate = homeAggregate();

		render(WorkspaceInboxPageView);

		expect(screen.getByTestId("inbox-page-empty")).toBeTruthy();
		expect(screen.queryByTestId("inbox-page-row")).toBeNull();
	});

	it("shows the server cap note at the 40-item attention cap", () => {
		workspaceHomeStore.aggregate = homeAggregate({
			attention: Array.from({ length: 40 }, (_value, index) => attentionItem({
				id: `attention-${index}`,
				title: `Attention ${index}`,
			})),
			counts: { projects: 40, myOpenTasks: 0, attention: 40, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 40 },
		});

		render(WorkspaceInboxPageView);

		expect(screen.getByText(/แสดง 40 รายการแรก/)).toBeTruthy();
	});
});
