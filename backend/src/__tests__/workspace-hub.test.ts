import { describe, expect, test } from "bun:test";
import { buildWorkspaceFeed, createWorkspaceMessage, normalizeWorkspaceMessages } from "../services/workspace-hub.js";
import type { ProjectState } from "../types/index.js";

function projectState(): ProjectState {
	return {
		projectId: "proj-1",
		userId: "",
		name: "Workspace test",
		createdAt: "",
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
	};
}

describe("workspace hub", () => {
	test("creates handoff notes with mentions", () => {
		const message = createWorkspaceMessage({
			pageIndex: 0,
			body: "Please check redraw @reviewer",
		});

		expect(message.pageIndex).toBe(0);
		expect(message.mentions).toEqual(["reviewer"]);
	});

	test("builds a sorted workspace feed from project work records", () => {
		const state = projectState();
		state.workspaceMessages = [
			{ ...createWorkspaceMessage({ pageIndex: 0, body: "handoff" }), createdAt: "2026-05-12T10:00:00.000Z" },
		];
		state.comments = [{
			id: "comment-1",
			pageIndex: 0,
			body: "open comment",
			author: "local-user",
			status: "open",
			createdAt: "2026-05-12T09:00:00.000Z",
			updatedAt: "2026-05-12T09:00:00.000Z",
		}];
		state.versionReviewRequests = [{
			id: "version-review-1",
			versionId: "version-1",
			status: "open",
			body: "review snapshot",
			requester: "lead",
			createdAt: "2026-05-12T09:30:00.000Z",
			updatedAt: "2026-05-12T09:30:00.000Z",
		}];
		state.tasks = [{
			id: "page-0-review",
			type: "review",
			status: "review",
			priority: "urgent",
			pageIndex: 0,
			title: "Review page 1",
			createdAt: "2026-05-12T08:00:00.000Z",
			updatedAt: "2026-05-12T08:00:00.000Z",
		}];

		normalizeWorkspaceMessages(state);
		const feed = buildWorkspaceFeed(state);

		expect(feed[0]).toMatchObject({ kind: "task", priority: "urgent", severity: "error" });
		expect(feed.some((item) => item.kind === "comment" && item.sourceId === "comment-1")).toBe(true);
		expect(feed.some((item) => item.kind === "version_review" && item.sourceId === "version-review-1")).toBe(true);
		expect(feed.find((item) => item.kind === "version_review")?.versionId).toBe("version-1");
	});

	test("flags overdue open tasks in the workspace feed", () => {
		const state = projectState();
		state.tasks = [{
			id: "page-0-typeset",
			type: "typeset",
			status: "doing",
			priority: "normal",
			pageIndex: 0,
			title: "Typeset page 1",
			dueAt: "2000-01-01T00:00:00.000Z",
			createdAt: "2026-05-12T08:00:00.000Z",
			updatedAt: "2026-05-12T08:00:00.000Z",
		}];

		const feed = buildWorkspaceFeed(state);

		expect(feed[0]).toMatchObject({
			kind: "task",
			severity: "error",
			dueAt: "2000-01-01T00:00:00.000Z",
			dueState: "overdue",
			detail: "normal / doing / overdue 2000-01-01",
		});
	});

	test("warns on due-soon open tasks before they become overdue", () => {
		const state = projectState();
		const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		state.tasks = [{
			id: "page-0-clean",
			type: "clean",
			status: "todo",
			priority: "normal",
			pageIndex: 0,
			title: "Clean page 1",
			dueAt,
			createdAt: "2026-05-12T08:00:00.000Z",
			updatedAt: "2026-05-12T08:00:00.000Z",
		}];

		const feed = buildWorkspaceFeed(state);

		expect(feed[0]).toMatchObject({
			kind: "task",
			severity: "warning",
			dueAt,
			dueState: "soon",
		});
		expect(feed[0].detail).toContain("due soon");
	});

	test("normalizes task assignee handles in workspace feed copy", () => {
		const state = projectState();
		state.tasks = [{
			id: "page-0-clean",
			type: "clean",
			status: "todo",
			priority: "high",
			pageIndex: 0,
			title: "Clean page 1",
			assignee: "@@Mai",
			createdAt: "2026-05-12T08:00:00.000Z",
			updatedAt: "2026-05-12T08:00:00.000Z",
		}];

		const feed = buildWorkspaceFeed(state);

		expect(feed[0]).toMatchObject({
			kind: "task",
			actor: "Mai",
			detail: "high / todo / @Mai",
		});
	});

	test("routes recent export failures into the attention feed", () => {
		const state = projectState();
		state.exportRuns = [{
			id: "export-1",
				kind: "batch-zip",
				status: "error",
				targetProfile: "public-export",
				filename: "chapter.zip",
			pageIndexes: [0, 1],
			pageCount: 2,
			message: "Export failed",
			error: "Page 2 has holds",
			createdAt: "2026-05-12T08:00:00.000Z",
			completedAt: "2026-05-12T08:01:00.000Z",
		}];

		const feed = buildWorkspaceFeed(state);

		expect(feed[0]).toMatchObject({
			kind: "export_run",
			sourceId: "export-1",
			title: "Export failed",
				detail: "Public/Export / 2 pages / Page 2 has holds / 1 missing page",
			severity: "error",
			status: "error",
		});
	});

	test("does not route stale single-page export runs to missing pages", () => {
		const state = projectState();
		state.exportRuns = [{
			id: "export-stale",
			kind: "single-page",
			status: "error",
			filename: "page-5.png",
			pageIndexes: [4],
			pageCount: 1,
			message: "Export failed",
			error: "Page 5 was deleted",
			createdAt: "2026-05-12T08:00:00.000Z",
			completedAt: "2026-05-12T08:01:00.000Z",
		}];

		const feed = buildWorkspaceFeed(state);

		expect(feed[0]).toMatchObject({
			kind: "export_run",
			sourceId: "export-stale",
			pageIndex: undefined,
			detail: "1 page / Page 5 was deleted / 1 missing page",
			severity: "error",
		});
	});
});
