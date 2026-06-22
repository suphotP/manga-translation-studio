import { describe, expect, it } from "vitest";
import { buildProjectQcReport } from "$lib/project/qc-checks.js";
import { buildWorkInbox } from "$lib/project/work-inbox.js";
import type { ProjectState } from "$lib/types.js";

function makeProject(): ProjectState {
	return {
		projectId: "project-1",
		name: "Chapter",
		createdAt: "",
		targetLang: "th",
		currentPage: 0,
		pages: [{
			imageId: "img-1",
			imageName: "page-1.webp",
			textLayers: [{
				id: "layer-1",
				text: "Translated",
				x: 0,
				y: 0,
				w: 100,
				h: 60,
				rotation: 0,
				fontSize: 18,
				alignment: "center",
				index: 0,
			}],
			pendingAiJobs: [],
			coverRect: null,
		}],
	};
}

describe("buildWorkInbox", () => {
	it("prioritizes blocking AI markers and aggregates workspace review work", () => {
		const project = makeProject();
		const markers = [{
			id: "marker-1",
			jobId: "job-1",
			pageIndex: 0,
			imageId: "img-1",
			region: { x: 0, y: 0, w: 120, h: 80 },
			status: "failed" as const,
			tier: "clean-pro" as const,
			assignee: "@qa-lead",
			createdAt: "",
			updatedAt: "",
		}, {
			id: "marker-2",
			jobId: "job-2",
			pageIndex: 0,
			imageId: "img-1",
			region: { x: 10, y: 10, w: 120, h: 80 },
			status: "needs_review" as const,
			tier: "sfx-pro" as const,
			createdAt: "",
			updatedAt: "",
		}];
		const comments = [{
			id: "comment-1",
			pageIndex: 0,
			body: "Check redraw edge",
			author: "local-user",
			status: "open" as const,
			createdAt: "",
			updatedAt: "",
		}];
		const tasks = [{
			id: "page-0-review",
			type: "review" as const,
			status: "review" as const,
			priority: "urgent" as const,
			pageIndex: 0,
			title: "Review page 1",
			createdAt: "",
			updatedAt: "",
		}];
		const report = buildProjectQcReport(project, tasks, comments, markers);
		const inbox = buildWorkInbox(project, tasks, comments, markers, report);

		expect(inbox[0]).toMatchObject({
			kind: "ai_marker",
			severity: "error",
			assignee: "qa-lead",
			titleCode: "ai_failed",
			detail: { kind: "ai_marker", tier: "clean-pro", hasCost: false, assignee: "qa-lead" },
			sourceId: "marker-1",
		});
		const marker2 = inbox.find((item) => item.sourceId === "marker-2");
		expect(marker2?.titleCode).toBe("ai_review");
		expect(marker2?.pageIndex).toBe(0);
		// No composed Thai/English title is emitted any more — only stable codes.
		expect(inbox.every((item) => typeof (item as { title?: unknown }).title === "undefined")).toBe(true);
		expect(inbox.some((item) => item.kind === "comment")).toBe(true);
		expect(inbox.some((item) => item.kind === "review_task")).toBe(true);
		expect(inbox.find((item) => item.kind === "review_task")?.priority).toBe("urgent");
		expect(inbox.some((item) => item.kind === "qc")).toBe(true);
	});

	it("adds assigned or urgent workflow tasks without flooding normal unassigned todos", () => {
		const project = makeProject();
		const tasks = [
			{
				id: "assigned-clean",
				type: "clean" as const,
				status: "doing" as const,
				priority: "normal" as const,
				pageIndex: 0,
				title: "Clean page 1",
				assignee: "@maya",
				createdAt: "",
				updatedAt: "",
			},
			{
				id: "urgent-typeset",
				type: "typeset" as const,
				status: "todo" as const,
				priority: "urgent" as const,
				pageIndex: 0,
				title: "Typeset page 1",
				createdAt: "",
				updatedAt: "",
			},
			{
				id: "normal-translate",
				type: "translate" as const,
				status: "todo" as const,
				priority: "normal" as const,
				pageIndex: 0,
				title: "Translate page 1",
				createdAt: "",
				updatedAt: "",
			},
		];
		const report = buildProjectQcReport(project, tasks, [], []);
		const inbox = buildWorkInbox(project, tasks, [], [], report);

		const workflowItems = inbox.filter((item) => item.kind === "workflow_task");
		expect(workflowItems.map((item) => item.sourceId)).toEqual(["urgent-typeset", "assigned-clean"]);
			expect(workflowItems.find((item) => item.sourceId === "assigned-clean")).toMatchObject({
				assignee: "maya",
				status: "doing",
				titleCode: "workflow",
				workflowTitle: { code: "clean" },
				detail: { kind: "workflow_task", statusCode: "doing", assignee: "maya", overdue: false },
			});
		expect(inbox.some((item) => item.sourceId === "normal-translate")).toBe(false);
	});

	it("promotes overdue workflow tasks even when they are normal and unassigned", () => {
		const project = makeProject();
		const tasks = [
			{
				id: "normal-overdue",
				type: "translate" as const,
				status: "todo" as const,
				priority: "normal" as const,
				pageIndex: 0,
				title: "Translate page 1",
				dueAt: "2000-01-01T00:00:00.000Z",
				createdAt: "",
				updatedAt: "",
			},
			{
				id: "normal-future",
				type: "typeset" as const,
				status: "todo" as const,
				priority: "normal" as const,
				pageIndex: 0,
				title: "Typeset page 1",
				dueAt: "2999-01-01T00:00:00.000Z",
				createdAt: "",
				updatedAt: "",
			},
		];
		const report = buildProjectQcReport(project, tasks, [], []);
		const inbox = buildWorkInbox(project, tasks, [], [], report);

		expect(inbox.find((item) => item.sourceId === "normal-overdue")).toMatchObject({
			kind: "workflow_task",
			severity: "error",
			overdue: true,
			dueAt: "2000-01-01T00:00:00.000Z",
		});
		expect(inbox.some((item) => item.sourceId === "normal-future")).toBe(false);
	});

	it("keeps missing-page comments visible while QC explains the repair path", () => {
		const project = makeProject();
		const comments = [{
			id: "comment-missing-page",
			pageIndex: 4,
			body: "This comment belongs to a deleted page",
			author: "local-user",
			status: "open" as const,
			createdAt: "",
			updatedAt: "",
		}];
		const report = buildProjectQcReport(project, [], comments, []);
		const inbox = buildWorkInbox(project, [], comments, [], report);

		expect(inbox.find((item) => item.kind === "comment")).toMatchObject({
			id: "comment-comment-missing-page",
			sourceId: "comment-missing-page",
			pageIndex: 4,
		});
			expect(inbox.find((item) => item.kind === "qc" && item.sourceId === "comment-comment-missing-page-missing-page")).toMatchObject({
			titleCode: "qc",
			qcCode: "comment_page_missing",
			pageIndex: undefined,
		});
	});

	it("keeps accepted AI results in the work queue until their editable layer exists", () => {
		const project = makeProject();
		const markers = [{
			id: "accepted-marker",
			jobId: "job-accepted",
			pageIndex: 0,
			imageId: "img-1",
			region: { x: 10, y: 20, w: 120, h: 80 },
			status: "accepted" as const,
			tier: "clean-pro" as const,
			resultImageId: "accepted-result.webp",
			createdAt: "",
			updatedAt: "",
		}];
		const inbox = buildWorkInbox(project, [], [], markers, buildProjectQcReport(project, [], [], markers));

		expect(inbox.find((item) => item.sourceId === "accepted-marker")).toMatchObject({
			kind: "ai_marker",
			severity: "warning",
			priority: "high",
			titleCode: "ai_placement",
			detail: { kind: "ai_placement_ready" },
		});

		project.pages[0].imageLayers = [{
			id: "ai-result-accepted-marker",
			imageId: "accepted-result.webp",
			imageName: "accepted-result.webp",
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "overlay",
		}];
		const resolvedInbox = buildWorkInbox(project, [], [], markers, buildProjectQcReport(project, [], [], markers));
		expect(resolvedInbox.find((item) => item.sourceId === "accepted-marker")).toBeUndefined();
	});
});
