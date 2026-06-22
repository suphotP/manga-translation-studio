import { describe, expect, test } from "bun:test";
import {
	applyPageReorderToServerOwnedCollections,
	derivePageReorderPlan,
} from "../services/page-reorder.js";
import type {
	AiReviewMarker,
	PageReviewDecision,
	PageState,
	ProjectComment,
	ProjectState,
	WorkflowTask,
	WorkspaceMessage,
} from "../types/index.js";

function page(imageId: string): PageState {
	return {
		imageId,
		imageName: imageId,
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
	};
}

function task(pageIndex: number, type: WorkflowTask["type"]): WorkflowTask {
	return {
		id: `page-${pageIndex}-${type}`,
		type,
		status: "todo",
		priority: "normal",
		pageIndex,
		title: `${type[0]!.toUpperCase()}${type.slice(1)} page ${pageIndex + 1}`,
		createdAt: "2026-05-15T00:00:00.000Z",
		updatedAt: "2026-05-15T00:00:00.000Z",
	};
}

describe("derivePageReorderPlan", () => {
	test("identity when page order is unchanged", () => {
		const pages = [page("a"), page("b"), page("c")];
		const plan = derivePageReorderPlan(pages, [page("a"), page("b"), page("c")]);
		expect(plan.changed).toBe(false);
	});

	test("derives the index permutation for a reorder (move first page to last)", () => {
		const plan = derivePageReorderPlan(
			[page("a"), page("b"), page("c")],
			[page("b"), page("c"), page("a")],
		);
		expect(plan.changed).toBe(true);
		// old a@0 -> new 2, b@1 -> new 0, c@2 -> new 1
		expect(plan.indexMap).toEqual({ 0: 2, 1: 0, 2: 1 });
	});

	test("no plan when the page set differs (page added/removed)", () => {
		expect(derivePageReorderPlan([page("a"), page("b")], [page("a"), page("b"), page("c")]).changed).toBe(false);
		expect(derivePageReorderPlan([page("a"), page("b"), page("c")], [page("a"), page("c")]).changed).toBe(false);
	});

	test("no plan when imageIds are not unique (ambiguous match)", () => {
		const plan = derivePageReorderPlan([page("a"), page("a")], [page("a"), page("a")]);
		expect(plan.changed).toBe(false);
	});
});

describe("applyPageReorderToServerOwnedCollections", () => {
	test("remaps task pageIndex, id, and title to follow the moved page", () => {
		const state: ProjectState = {
			projectId: "p",
			name: "c",
			createdAt: "2026-05-15T00:00:00.000Z",
			userId: "u",
			targetLang: "th",
			currentPage: 0,
			pages: [page("b"), page("c"), page("a")], // already in NEW order
			tasks: [task(0, "translate"), task(2, "review")],
		};
		const plan = derivePageReorderPlan(
			[page("a"), page("b"), page("c")],
			[page("b"), page("c"), page("a")],
		);
		applyPageReorderToServerOwnedCollections(state, plan);
		const byType = new Map(state.tasks!.map((t) => [t.type, t]));
		// translate was on old page 0 (a) -> new index 2
		expect(byType.get("translate")!.pageIndex).toBe(2);
		expect(byType.get("translate")!.id).toBe("page-2-translate");
		expect(byType.get("translate")!.title).toBe("Translate page 3");
		// review was on old page 2 (c) -> new index 1
		expect(byType.get("review")!.pageIndex).toBe(1);
		expect(byType.get("review")!.id).toBe("page-1-review");
		expect(byType.get("review")!.title).toBe("Review page 2");
	});

	test("remaps comments, ai markers, review decisions, and workspace messages", () => {
		const comments: ProjectComment[] = [{
			id: "c1",
			pageIndex: 0,
			body: "x",
			author: "lead",
			status: "open",
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		}];
		const markers: AiReviewMarker[] = [{
			id: "m1",
			jobId: "j1",
			pageIndex: 2,
			imageId: "c",
			region: { x: 0, y: 0, w: 1, h: 1 },
			status: "needs_review",
			tier: "budget-clean",
			linkedTaskIds: ["page-2-review"],
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		} as AiReviewMarker];
		const decisions: PageReviewDecision[] = [{
			id: "d1",
			pageIndex: 0,
			status: "approved",
			actor: "lead",
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		}];
		const messages: WorkspaceMessage[] = [{
			id: "w1",
			pageIndex: 1,
			body: "note",
			author: "lead",
			linkedTaskId: "page-1-typeset",
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		}];
		const state: ProjectState = {
			projectId: "p",
			name: "c",
			createdAt: "2026-05-15T00:00:00.000Z",
			userId: "u",
			targetLang: "th",
			currentPage: 0,
			pages: [page("b"), page("c"), page("a")],
			comments,
			aiReviewMarkers: markers,
			reviewDecisions: decisions,
			workspaceMessages: messages,
		};
		const plan = derivePageReorderPlan(
			[page("a"), page("b"), page("c")],
			[page("b"), page("c"), page("a")],
		);
		applyPageReorderToServerOwnedCollections(state, plan);
		expect(state.comments![0]!.pageIndex).toBe(2); // a: 0 -> 2
		expect(state.aiReviewMarkers![0]!.pageIndex).toBe(1); // c: 2 -> 1
		expect(state.aiReviewMarkers![0]!.linkedTaskIds).toEqual(["page-1-review"]);
		expect(state.reviewDecisions![0]!.pageIndex).toBe(2); // a: 0 -> 2
		expect(state.workspaceMessages![0]!.pageIndex).toBe(0); // b: 1 -> 0
		expect(state.workspaceMessages![0]!.linkedTaskId).toBe("page-0-typeset");
	});

	test("no-op on identity plan", () => {
		const state: ProjectState = {
			projectId: "p",
			name: "c",
			createdAt: "2026-05-15T00:00:00.000Z",
			userId: "u",
			targetLang: "th",
			currentPage: 0,
			pages: [page("a"), page("b")],
			comments: [{
				id: "c1",
				pageIndex: 1,
				body: "x",
				author: "lead",
				status: "open",
				createdAt: "2026-05-15T00:00:00.000Z",
				updatedAt: "2026-05-15T00:00:00.000Z",
			}],
		};
		const plan = derivePageReorderPlan([page("a"), page("b")], [page("a"), page("b")]);
		applyPageReorderToServerOwnedCollections(state, plan);
		expect(state.comments![0]!.pageIndex).toBe(1);
	});
});
