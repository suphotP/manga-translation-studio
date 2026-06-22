import { describe, expect, test } from "bun:test";
import { ensureProjectWorkflow, ensureProjectWorkflowChanged, pageHasReviewableText } from "../services/workflow.js";
import type { PageState, ProjectState, TextLayerData, WorkflowTask } from "../types/index.js";

function textLayer(id: string, text = "สวัสดี"): TextLayerData {
	return {
		id,
		text,
		x: 0,
		y: 0,
		w: 100,
		h: 40,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
	} as TextLayerData;
}

function page(overrides: Partial<PageState> = {}): PageState {
	return {
		imageId: "image-1.png",
		imageName: "image-1.png",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function projectWithPages(pages: PageState[], tasks: WorkflowTask[] = []): ProjectState {
	return {
		projectId: "project-1",
		name: "Chapter",
		createdAt: "2026-05-15T00:00:00.000Z",
		targetLang: "th",
		currentPage: 0,
		pages,
		tasks,
	};
}

function projectWithAssignee(assignee: string): ProjectState {
	return projectWithPages([page()], [{
		id: "page-0-typeset",
		type: "typeset",
		status: "doing",
		priority: "high",
		pageIndex: 0,
		title: "Typeset page 1",
		assignee,
		createdAt: "2026-05-15T00:00:00.000Z",
		updatedAt: "2026-05-15T00:00:00.000Z",
	}]);
}

describe("ensureProjectWorkflow", () => {
	test("normalizes persisted task assignee handles while preserving workflow fields", () => {
		const state = ensureProjectWorkflow(projectWithAssignee("@@Mai"));
		const typesetTask = state.tasks?.find((task) => task.id === "page-0-typeset");

		expect(typesetTask).toMatchObject({
			status: "doing",
			priority: "high",
			assignee: "Mai",
		});
	});
});

describe("pageHasReviewableText", () => {
	test("false for a raw textless scan", () => {
		expect(pageHasReviewableText(page())).toBe(false);
	});

	test("true when the flat default track has text", () => {
		expect(pageHasReviewableText(page({ textLayers: [textLayer("t1")] }))).toBe(true);
	});

	test("true when any per-language track has text", () => {
		expect(pageHasReviewableText(page({
			textLayers: [],
			languageOutputs: {
				en: { textLayers: [] },
				th: { textLayers: [textLayer("t1")] },
			},
		}))).toBe(true);
	});

	test("false when every per-language track is empty", () => {
		expect(pageHasReviewableText(page({
			textLayers: [],
			languageOutputs: { en: { textLayers: [] }, th: { textLayers: [] } },
		}))).toBe(false);
	});
});

describe("ensureProjectWorkflow — textless review-task skip", () => {
	test("does NOT auto-generate a review task for a textless page", () => {
		const state = ensureProjectWorkflow(projectWithPages([page()]));
		expect(state.tasks?.some((task) => task.id === "page-0-review")).toBe(false);
		// other roles are still seeded — only review/QC is skipped for textless pages
		expect(state.tasks?.some((task) => task.id === "page-0-translate")).toBe(true);
		expect(state.tasks?.some((task) => task.id === "page-0-clean")).toBe(true);
		expect(state.tasks?.some((task) => task.id === "page-0-typeset")).toBe(true);
	});

	test("auto-generates a review task once a page has text", () => {
		const state = ensureProjectWorkflow(projectWithPages([page({ textLayers: [textLayer("t1")] })]));
		expect(state.tasks?.some((task) => task.id === "page-0-review")).toBe(true);
	});

	test("only the textless pages skip review in a mixed chapter", () => {
		const state = ensureProjectWorkflow(projectWithPages([
			page({ imageId: "p0.png", textLayers: [textLayer("t1")] }),
			page({ imageId: "p1.png" }),
			page({ imageId: "p2.png", languageOutputs: { th: { textLayers: [textLayer("t2")] } } }),
		]));
		expect(state.tasks?.some((task) => task.id === "page-0-review")).toBe(true);
		expect(state.tasks?.some((task) => task.id === "page-1-review")).toBe(false);
		expect(state.tasks?.some((task) => task.id === "page-2-review")).toBe(true);
	});

	test("preserves a human-touched review task even on a textless page", () => {
		const state = ensureProjectWorkflow(projectWithPages([page()], [{
			id: "page-0-review",
			type: "review",
			status: "doing",
			priority: "normal",
			pageIndex: 0,
			title: "Review page 1",
			assignee: "Mai",
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		}]));
		const reviewTask = state.tasks?.find((task) => task.id === "page-0-review");
		expect(reviewTask).toMatchObject({ status: "doing", assignee: "Mai" });
	});

	test("drops an untouched auto-seeded review task when a page loses its text", () => {
		// page previously had text (so a default review task was seeded) but the
		// text was removed; the still-"todo", unassigned review task is dropped.
		const state = ensureProjectWorkflow(projectWithPages([page()], [{
			id: "page-0-review",
			type: "review",
			status: "todo",
			priority: "normal",
			pageIndex: 0,
			title: "Review page 1",
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		}]));
		expect(state.tasks?.some((task) => task.id === "page-0-review")).toBe(false);
	});

	test("preserves a textless review task whose priority was bumped (manual/bulk triage)", () => {
		// still-"todo", unassigned, no due date, default title — but a human (or a
		// bulk priority update) marked it "urgent". That triage is human-touched
		// state we must not silently drop on a textless page.
		const state = ensureProjectWorkflow(projectWithPages([page()], [{
			id: "page-0-review",
			type: "review",
			status: "todo",
			priority: "urgent",
			pageIndex: 0,
			title: "Review page 1",
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		}]));
		const reviewTask = state.tasks?.find((task) => task.id === "page-0-review");
		expect(reviewTask).toMatchObject({ status: "todo", priority: "urgent" });
	});

	test("still drops a textless review task left at default 'normal' priority", () => {
		const state = ensureProjectWorkflow(projectWithPages([page()], [{
			id: "page-0-review",
			type: "review",
			status: "todo",
			priority: "normal",
			pageIndex: 0,
			title: "Review page 1",
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		}]));
		expect(state.tasks?.some((task) => task.id === "page-0-review")).toBe(false);
	});

	test("preserving a priority-bumped textless review task is idempotent across re-runs", () => {
		const first = ensureProjectWorkflow(projectWithPages([page()], [{
			id: "page-0-review",
			type: "review",
			status: "todo",
			priority: "high",
			pageIndex: 0,
			title: "Review page 1",
			createdAt: "2026-05-15T00:00:00.000Z",
			updatedAt: "2026-05-15T00:00:00.000Z",
		}]));
		// feed the resulting state back in — the bumped task must survive again.
		const second = ensureProjectWorkflow(first);
		const reviewTask = second.tasks?.find((task) => task.id === "page-0-review");
		expect(reviewTask).toMatchObject({ status: "todo", priority: "high" });
	});

	test("ensureProjectWorkflowChanged reports true on first normalize, false when idempotent", () => {
		const fresh = projectWithPages([page({ textLayers: [textLayer("t1")] })]);
		// First run seeds tasks → it changed state, so a GET handler SHOULD persist.
		expect(ensureProjectWorkflowChanged(fresh)).toBe(true);
		// Second run on the already-normalized state changes nothing → must report false so the
		// read does NOT write (the whole point: no hash + no write-on-read churn).
		expect(ensureProjectWorkflowChanged(fresh)).toBe(false);
	});
});
