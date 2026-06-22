import { describe, expect, test } from "bun:test";
import {
	WORKSPACE_HOME_MAX_DUE_TODAY,
	buildWorkspaceHomeAggregate,
} from "../services/workspace-home.js";
import type { ProjectState, WorkflowTask } from "../types/index.js";

const NOW = Date.parse("2026-06-03T12:00:00.000Z");

function projectState(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "proj-1",
		workspaceId: "ws-1",
		userId: "",
		name: "Story A — Chapter 1",
		createdAt: "2026-06-01T00:00:00.000Z",
		storyId: "story-a",
		storyTitle: "Story A",
		chapterLabel: "Chapter 1",
		pages: [{ imageId: "img-1", imageName: "image-01.webp", textLayers: [], pendingAiJobs: [], coverRect: null }],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		...overrides,
	};
}

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "translate",
		status: "todo",
		priority: "normal",
		pageIndex: 0,
		title: "Translate page 1",
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

describe("workspace-home aggregate", () => {
	test("returns honest empty aggregate when there are no projects", () => {
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects: [], now: NOW });
		expect(aggregate.myTasks).toEqual([]);
		expect(aggregate.attention).toEqual([]);
		expect(aggregate.activity).toEqual([]);
		expect(aggregate.aiJobs).toEqual([]);
		expect(aggregate.dueToday).toEqual([]);
		expect(aggregate.counts.projects).toBe(0);
		expect(aggregate.counts.openTasks).toBe(0);
		// Every pipeline stage is present but zeroed — not omitted.
		expect(aggregate.pipelineByStage.map((p) => p.stage)).toEqual(["translate", "clean", "typeset", "review"]);
		expect(aggregate.pipelineByStage.every((p) => p.total === 0)).toBe(true);
	});

	test("aggregates tasks across MULTIPLE projects and tags project context", () => {
		const projects = [
			{
				state: projectState({
					projectId: "proj-a",
					name: "Story A — Ch 1",
					tasks: [
						task({ id: "a-1", assignee: "alice@example.com", status: "todo" }),
						task({ id: "a-2", type: "clean", status: "doing" }),
					],
				}),
			},
			{
				state: projectState({
					projectId: "proj-b",
					name: "Story B — Ch 2",
					storyId: "story-b",
					tasks: [
						task({ id: "b-1", type: "typeset", assignee: "@alice@example.com", status: "review" }),
						task({ id: "b-2", type: "review", status: "done" }),
					],
				}),
			},
		];

		const aggregate = buildWorkspaceHomeAggregate({
			workspaceId: "ws-1",
			projects,
			viewerHandles: ["alice@example.com"],
			now: NOW,
		});

		// Two non-done tasks belong to alice (one per project), across two projects.
		expect(aggregate.myTasks.map((t) => t.id).sort()).toEqual(["a-1", "b-1"]);
		expect(aggregate.myTasks.find((t) => t.id === "a-1")?.projectId).toBe("proj-a");
		expect(aggregate.myTasks.find((t) => t.id === "b-1")?.projectId).toBe("proj-b");
		expect(aggregate.myTasks.find((t) => t.id === "b-1")?.storyId).toBe("story-b");

		// Pipeline counts merge across both projects (b-2 review is done).
		const pipeline = Object.fromEntries(aggregate.pipelineByStage.map((p) => [p.stage, p]));
		expect(pipeline.translate.total).toBe(1);
		expect(pipeline.clean.doing).toBe(1);
		expect(pipeline.typeset.review).toBe(1);
		expect(pipeline.review.done).toBe(1);
		expect(pipeline.review.open).toBe(0);

		expect(aggregate.counts.projects).toBe(2);
		// 3 non-done tasks total (a-1, a-2, b-1).
		expect(aggregate.counts.openTasks).toBe(3);
		expect(aggregate.counts.myOpenTasks).toBe(2);
	});

	test("matches my-tasks by EITHER email or userId handle", () => {
		const projects = [{
			state: projectState({
				tasks: [
					task({ id: "by-email", assignee: "alice@example.com" }),
					task({ id: "by-userid", assignee: "user-123" }),
					task({ id: "not-mine", assignee: "bob@example.com" }),
				],
			}),
		}];
		const aggregate = buildWorkspaceHomeAggregate({
			workspaceId: "ws-1",
			projects,
			viewerHandles: ["alice@example.com", "user-123"],
			now: NOW,
		});
		expect(aggregate.myTasks.map((t) => t.id).sort()).toEqual(["by-email", "by-userid"]);
	});

	test("classifies overdue + due-today + due-soon and surfaces attention", () => {
		const projects = [{
			state: projectState({
				tasks: [
					task({ id: "overdue", assignee: "alice@example.com", dueAt: "2026-06-01T00:00:00.000Z", priority: "high" }),
					task({ id: "today", assignee: "alice@example.com", dueAt: "2026-06-03T23:00:00.000Z" }),
					task({ id: "soon", assignee: "alice@example.com", dueAt: "2026-06-04T06:00:00.000Z" }),
					task({ id: "later", assignee: "alice@example.com", dueAt: "2026-06-20T00:00:00.000Z" }),
				],
			}),
		}];
		const aggregate = buildWorkspaceHomeAggregate({
			workspaceId: "ws-1",
			projects,
			viewerHandles: ["alice@example.com"],
			now: NOW,
		});

		const byId = Object.fromEntries(aggregate.myTasks.map((t) => [t.id, t]));
		expect(byId.overdue.dueState).toBe("overdue");
		expect(byId.soon.dueState).toBe("soon");
		expect(byId.later.dueState).toBe("scheduled");

		// dueToday lane includes overdue + today (do-now), not soon/later.
		expect(aggregate.dueToday.map((t) => t.id).sort()).toEqual(["overdue", "today"]);
		expect(aggregate.counts.overdue).toBe(1);

		// Overdue task produces an attention feed item (severity error).
		expect(aggregate.attention.some((item) => item.kind === "task" && item.sourceId === "overdue")).toBe(true);
		// The most urgent (overdue) sorts first in myTasks.
		expect(aggregate.myTasks[0]?.id).toBe("overdue");
	});

	test("surfaces AI markers that still need attention and skips resolved ones", () => {
		const projects = [{
			state: projectState({
				aiReviewMarkers: [
					{
						id: "m-pending", jobId: "j-1", pageIndex: 0, imageId: "img-1",
						region: { x: 0, y: 0, w: 1, h: 1 }, status: "needs_review", tier: "clean-pro",
						createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z",
					},
					{
						id: "m-applied", jobId: "j-2", pageIndex: 0, imageId: "img-1",
						region: { x: 0, y: 0, w: 1, h: 1 }, status: "applied", tier: "clean-pro",
						createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z",
					},
				] as ProjectState["aiReviewMarkers"],
			}),
		}];
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		expect(aggregate.aiJobs.map((j) => j.markerId)).toEqual(["m-pending"]);
		expect(aggregate.counts.aiJobs).toBe(1);
	});

	test("does not surface a task as mine when there is no viewer handle", () => {
		const projects = [{
			state: projectState({ tasks: [task({ id: "a-1", assignee: "alice@example.com" })] }),
		}];
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		expect(aggregate.myTasks).toEqual([]);
		// But it still counts as an open task for the workspace.
		expect(aggregate.counts.openTasks).toBe(1);
	});

	test("recentProject is null for an empty workspace (honest empty hero)", () => {
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects: [], now: NOW });
		expect(aggregate.recentProject).toBeNull();
	});

	test("recentProject is the FIRST (most-recently-updated) project, with stable workspace-scoped facts", () => {
		const projects = [
			{
				state: projectState({
					projectId: "proj-recent",
					name: "Recent Story — Ch 7",
					storyId: "story-recent",
					storyTitle: "Recent Story",
					chapterLabel: "ตอน 7",
					sourceLang: "ja",
					targetLang: "th",
					pages: [
						{ imageId: "p1", imageName: "p1.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
						{ imageId: "p2", imageName: "p2.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
					],
				}),
				name: "Recent Story — Ch 7",
			},
			{ state: projectState({ projectId: "proj-older", name: "Older Story" }) },
		];

		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		const recent = aggregate.recentProject;
		expect(recent).not.toBeNull();
		expect(recent?.projectId).toBe("proj-recent");
		expect(recent?.projectName).toBe("Recent Story — Ch 7");
		expect(recent?.storyTitle).toBe("Recent Story");
		expect(recent?.chapterLabel).toBe("ตอน 7");
		expect(recent?.sourceLang).toBe("ja");
		expect(recent?.targetLang).toBe("th");
		expect(recent?.pageCount).toBe(2);
		// No review decisions yet → honest "no progress data" (never a fabricated %).
		expect(recent?.hasProgress).toBe(false);
		expect(recent?.progressPercent).toBe(0);
	});

	test("targetLangs is the DISTINCT set of target languages across all projects (sorted, upper-cased)", () => {
		const projects = [
			{ state: projectState({ projectId: "p-th", targetLang: "th" }) },
			{ state: projectState({ projectId: "p-en", targetLang: "en" }) },
			// duplicate target lang collapses; casing is normalized to upper-case
			{ state: projectState({ projectId: "p-th2", targetLang: "TH" }) },
		];
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		expect(aggregate.targetLangs).toEqual(["EN", "TH"]);
	});

	test("targetLangs is empty for an empty workspace (honest zero, no fabricated language)", () => {
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects: [], now: NOW });
		expect(aggregate.targetLangs).toEqual([]);
	});

	test("recentProject progress is the share of pages whose LATEST review decision is approved", () => {
		const projects = [{
			state: projectState({
				projectId: "proj-progress",
				pages: [
					{ imageId: "p1", imageName: "p1.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
					{ imageId: "p2", imageName: "p2.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
					{ imageId: "p3", imageName: "p3.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
					{ imageId: "p4", imageName: "p4.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
				],
				reviewDecisions: [
					// page 0: changes_requested then approved (latest wins → approved)
					{ id: "d0a", pageIndex: 0, status: "changes_requested", actor: "qc", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
					{ id: "d0b", pageIndex: 0, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
					// page 1: approved
					{ id: "d1", pageIndex: 1, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
					// page 2: latest is changes_requested → NOT approved
					{ id: "d2a", pageIndex: 2, status: "approved", actor: "qc", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
					{ id: "d2b", pageIndex: 2, status: "changes_requested", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
					// page 3: no decision
				] as ProjectState["reviewDecisions"],
			}),
		}];
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		// 2 of 4 pages approved → 50%.
		expect(aggregate.recentProject?.hasProgress).toBe(true);
		expect(aggregate.recentProject?.progressPercent).toBe(50);
	});

	test("progress IGNORES decisions for out-of-range/deleted pages and never exceeds 100%", () => {
		// 2 current pages. There are stale decisions left behind by since-deleted
		// pages (index 5, 9) plus a negative/non-integer index. None of them may
		// count — otherwise approved could exceed the current page count and the
		// meter would read > 100%.
		const projects = [{
			state: projectState({
				projectId: "proj-stale",
				pages: [
					{ imageId: "p1", imageName: "p1.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
					{ imageId: "p2", imageName: "p2.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
				],
				reviewDecisions: [
					// In-range: both current pages approved → 100%, never more.
					{ id: "d0", pageIndex: 0, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
					{ id: "d1", pageIndex: 1, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
					// Stale: pages that no longer exist — must NOT inflate the numerator.
					{ id: "stale5", pageIndex: 5, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
					{ id: "stale9", pageIndex: 9, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
					// Garbage indices — ignored too.
					{ id: "neg", pageIndex: -1, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
				] as ProjectState["reviewDecisions"],
			}),
		}];
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		expect(aggregate.recentProject?.hasProgress).toBe(true);
		// 2 of 2 CURRENT pages approved → 100%, clamped (the 3 stale approvals are ignored).
		expect(aggregate.recentProject?.progressPercent).toBe(100);
		expect(aggregate.recentProject?.progressPercent).toBeLessThanOrEqual(100);
	});

	test("progress is honest 'no data' when EVERY decision is for a since-deleted page", () => {
		const projects = [{
			state: projectState({
				projectId: "proj-all-stale",
				pages: [
					{ imageId: "p1", imageName: "p1.webp", textLayers: [], pendingAiJobs: [], coverRect: null },
				],
				reviewDecisions: [
					// All decisions point at pages that no longer exist (index >= totalPages).
					{ id: "s1", pageIndex: 3, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
					{ id: "s2", pageIndex: 7, status: "approved", actor: "qc", createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
				] as ProjectState["reviewDecisions"],
			}),
		}];
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		// No in-range decision → honest "no progress data", NOT a fabricated 0%-with-progress.
		expect(aggregate.recentProject?.hasProgress).toBe(false);
		expect(aggregate.recentProject?.progressPercent).toBe(0);
	});

	test("recentProject carries the project's OWN cover (aggregate-sourced hero cover)", () => {
		const projects = [{
			state: projectState({
				projectId: "proj-cover",
				coverImageId: "cover-img-123",
				coverOriginalName: "cover.png",
			}),
		}];
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		// The hero cover is derivable purely from the aggregate (projectId + coverImageId),
		// so it stays stable regardless of which chapter is open in the editor.
		expect(aggregate.recentProject?.coverImageId).toBe("cover-img-123");
		expect(aggregate.recentProject?.coverOriginalName).toBe("cover.png");
		expect(aggregate.recentProject?.projectId).toBe("proj-cover");
	});

	test("recentProject omits cover fields when the project has no cover yet", () => {
		const projects = [{ state: projectState({ projectId: "proj-nocover" }) }];
		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });
		expect(aggregate.recentProject?.coverImageId).toBeUndefined();
		expect(aggregate.recentProject?.coverOriginalName).toBeUndefined();
	});

	test("caps the dueToday array (never unbounded) while counts.dueToday keeps the true total", () => {
		// Far more due-today tasks than the cap, spread across two projects.
		const overflow = WORKSPACE_HOME_MAX_DUE_TODAY + 25;
		const makeTasks = (prefix: string, count: number) =>
			Array.from({ length: count }, (_, i) =>
				// Every task is due inside today's UTC window and not done → dueToday.
				task({ id: `${prefix}-${i}`, dueAt: "2026-06-03T20:00:00.000Z", status: "todo" }),
			);
		const half = Math.ceil(overflow / 2);
		const projects = [
			{ state: projectState({ projectId: "proj-a", tasks: makeTasks("a", half) }) },
			{ state: projectState({ projectId: "proj-b", tasks: makeTasks("b", overflow - half) }) },
		];

		const aggregate = buildWorkspaceHomeAggregate({ workspaceId: "ws-1", projects, now: NOW });

		// The returned array is bounded by the cap — no unbounded payload.
		expect(aggregate.dueToday.length).toBe(WORKSPACE_HOME_MAX_DUE_TODAY);
		expect(aggregate.dueToday.length).toBeLessThan(overflow);
		// counts.dueToday reflects the TRUE total so the UI can still say "N due today".
		expect(aggregate.counts.dueToday).toBe(overflow);
	});
});
