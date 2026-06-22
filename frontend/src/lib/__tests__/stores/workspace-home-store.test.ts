// workspace-home store — loads the cross-project workspace-home aggregate
// (My-Work / attention / activity / AI jobs / pipeline) INDEPENDENT of the open
// chapter, and exposes honest empty fallbacks so consumers never read mock data.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
import type { WorkspaceHomeAggregate } from "$lib/api/client.ts";

vi.mock("$lib/api/client.ts", () => ({
	getWorkspaceHome: vi.fn(),
}));

function aggregate(overrides: Partial<WorkspaceHomeAggregate> = {}): WorkspaceHomeAggregate {
	return {
		workspaceId: "ws-1",
		generatedAt: "2026-06-03T12:00:00.000Z",
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

beforeEach(() => {
	vi.clearAllMocks();
	workspaceHomeStore.__resetForTesting();
});

afterEach(() => {
	workspaceHomeStore.__resetForTesting();
});

describe("workspaceHomeStore", () => {
	it("exposes honest empty fallbacks before any load", () => {
		expect(workspaceHomeStore.aggregate).toBeNull();
		expect(workspaceHomeStore.myTasks).toEqual([]);
		expect(workspaceHomeStore.attention).toEqual([]);
		expect(workspaceHomeStore.hasLoaded).toBe(false);
		// Pipeline always has the four stages even with nothing loaded.
		expect(workspaceHomeStore.pipelineByStage.map((p) => p.stage)).toEqual(["translate", "clean", "typeset", "review"]);
		expect(workspaceHomeStore.counts.projects).toBe(0);
	});

	it("loads the aggregate for a workspace and surfaces cross-project data", async () => {
		vi.mocked(api.getWorkspaceHome).mockResolvedValue(aggregate({
			myTasks: [
				{
					id: "t1", projectId: "p-a", projectName: "Story A", type: "translate", status: "todo",
					priority: "high", title: "Translate", pageIndex: 0, createdAt: "", updatedAt: "",
				},
				{
					id: "t2", projectId: "p-b", projectName: "Story B", type: "clean", status: "doing",
					priority: "normal", title: "Clean", pageIndex: 1, createdAt: "", updatedAt: "",
				},
			],
			counts: { projects: 2, myOpenTasks: 2, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 5 },
		}));

		await workspaceHomeStore.load("ws-1");

		expect(api.getWorkspaceHome).toHaveBeenCalledWith("ws-1");
		expect(workspaceHomeStore.hasLoaded).toBe(true);
		expect(workspaceHomeStore.isEmpty).toBe(false);
		expect(workspaceHomeStore.myTasks.map((t) => t.projectId)).toEqual(["p-a", "p-b"]);
		expect(workspaceHomeStore.counts.openTasks).toBe(5);
		expect(workspaceHomeStore.error).toBeNull();
	});

	it("reports an honest-empty aggregate (loaded, zero projects)", async () => {
		vi.mocked(api.getWorkspaceHome).mockResolvedValue(aggregate());
		await workspaceHomeStore.load("ws-empty");
		expect(workspaceHomeStore.hasLoaded).toBe(true);
		expect(workspaceHomeStore.isEmpty).toBe(true);
		expect(workspaceHomeStore.myTasks).toEqual([]);
	});

	it("coalesces concurrent loads for the same workspace into one fetch", async () => {
		vi.mocked(api.getWorkspaceHome).mockResolvedValue(aggregate());
		await Promise.all([workspaceHomeStore.load("ws-1"), workspaceHomeStore.load("ws-1")]);
		expect(api.getWorkspaceHome).toHaveBeenCalledTimes(1);
	});

	it("drops the previous workspace's aggregate when switching workspaces", async () => {
		vi.mocked(api.getWorkspaceHome).mockResolvedValueOnce(aggregate({
			counts: { projects: 3, myOpenTasks: 1, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 9 },
		}));
		await workspaceHomeStore.load("ws-1");
		expect(workspaceHomeStore.counts.projects).toBe(3);

		// Switching to a new workspace should not keep the old aggregate around.
		let resolveSecond: (value: WorkspaceHomeAggregate) => void = () => {};
		vi.mocked(api.getWorkspaceHome).mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
		const pending = workspaceHomeStore.load("ws-2");
		expect(workspaceHomeStore.aggregate).toBeNull();
		resolveSecond(aggregate({ workspaceId: "ws-2", counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 } }));
		await pending;
		expect(workspaceHomeStore.aggregate?.workspaceId).toBe("ws-2");
	});

	it("degrades gracefully on a failed fetch (null aggregate, error set)", async () => {
		vi.mocked(api.getWorkspaceHome).mockRejectedValue(new Error("boom"));
		await workspaceHomeStore.load("ws-1");
		expect(workspaceHomeStore.aggregate).toBeNull();
		expect(workspaceHomeStore.hasLoaded).toBe(false);
		expect(workspaceHomeStore.error).toBe("boom");
	});

	it("resets to a clean, empty slice", async () => {
		vi.mocked(api.getWorkspaceHome).mockResolvedValue(aggregate({
			counts: { projects: 2, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		}));
		await workspaceHomeStore.load("ws-1");
		workspaceHomeStore.reset();
		expect(workspaceHomeStore.aggregate).toBeNull();
		expect(workspaceHomeStore.currentWorkspaceId).toBeNull();
		expect(workspaceHomeStore.hasLoaded).toBe(false);
	});
});
