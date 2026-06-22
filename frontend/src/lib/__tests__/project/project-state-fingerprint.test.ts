import { describe, expect, it } from "vitest";
import { createProjectStateFingerprint } from "$lib/project/project-state-fingerprint.js";
import type { ProjectState } from "$lib/types.js";

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Chapter",
		createdAt: "2026-05-14T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [{
			imageId: "image-1",
			imageName: "image-1.webp",
			originalName: "image-1.webp",
			textLayers: [],
			imageLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		}],
		...overrides,
	};
}

describe("createProjectStateFingerprint", () => {
	it("ignores per-tab current page and backend-only user identity", () => {
		const base = makeProject();
		const sameContentDifferentTab = {
			...base,
			currentPage: 12,
			userId: "local-user",
		} as ProjectState & { userId: string };

		expect(createProjectStateFingerprint(sameContentDifferentTab)).toBe(createProjectStateFingerprint(base));
	});

	it("changes when editable project content changes", () => {
		const base = makeProject();
		const edited = makeProject({
			pages: [{
				...base.pages[0],
				textLayers: [{
					id: "layer-1",
					text: "Edited",
					x: 10,
					y: 20,
					w: 100,
					h: 40,
					rotation: 0,
					fontSize: 18,
					alignment: "center",
					index: 0,
				}],
			}],
		});

		expect(createProjectStateFingerprint(edited)).not.toBe(createProjectStateFingerprint(base));
	});

	it("ignores server-owned sub-collections hydrated through dedicated endpoints", () => {
		// These collections are loaded into the in-memory project via separate API
		// calls after openProject and are NOT returned by the conflict-guard's
		// `api.loadProject()` refetch — so including them produced a false first-save
		// conflict. They must not affect the fingerprint.
		const bare = makeProject();
		const hydrated = makeProject({
			tasks: [{
				id: "task-1",
				type: "translate",
				status: "todo",
				priority: "normal",
				pageIndex: 0,
				title: "Translate page 1",
				createdAt: "2026-05-14T00:00:00.000Z",
				updatedAt: "2026-05-14T00:00:00.000Z",
			}],
			activityLog: [{
				id: "activity-1",
				type: "task_updated",
				message: "Task updated",
				actor: "system",
				createdAt: "2026-05-14T00:00:00.000Z",
			}],
			comments: [{
				id: "comment-1",
				pageIndex: 0,
				body: "Check this",
				author: "lead",
				status: "open",
				createdAt: "2026-05-14T00:00:00.000Z",
				updatedAt: "2026-05-14T00:00:00.000Z",
			}],
			aiReviewMarkers: [{
				id: "marker-1",
				jobId: "job-1",
				pageIndex: 0,
				imageId: "image-1",
				region: { x: 0, y: 0, w: 10, h: 10 },
				status: "needs_review",
				tier: "budget-clean",
				createdAt: "2026-05-14T00:00:00.000Z",
				updatedAt: "2026-05-14T00:00:00.000Z",
			}],
			reviewDecisions: [{
				id: "decision-1",
				pageIndex: 0,
				status: "approved",
				actor: "lead",
				createdAt: "2026-05-14T00:00:00.000Z",
				updatedAt: "2026-05-14T00:00:00.000Z",
			}],
			workspaceMessages: [{
				id: "message-1",
				pageIndex: 0,
				body: "Team note",
				author: "lead",
				createdAt: "2026-05-14T00:00:00.000Z",
				updatedAt: "2026-05-14T00:00:00.000Z",
			}],
			exportRuns: [{
				id: "export-run-1",
				kind: "single-page",
				status: "done",
				filename: "page-1.png",
				pageIndexes: [0],
				pageCount: 1,
				message: "ok",
				createdAt: "2026-05-14T00:00:00.000Z",
				completedAt: "2026-05-14T00:00:00.000Z",
			}],
		});

		expect(createProjectStateFingerprint(hydrated)).toBe(createProjectStateFingerprint(bare));
	});
});
