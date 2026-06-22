import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
// Register the locale dictionaries (addMessages + init) so ChapterPacketPanel's $_(...) keys
// resolve to real strings instead of the raw key. test-setup.ts forces the active locale to th.
import "$lib/i18n";
import WorkspaceLibraryView from "$lib/components/WorkspaceLibraryView.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ProjectSummary } from "$lib/api/client.js";
import type { ProjectState, WorkflowTask } from "$lib/types.js";

// REGRESSION (P1): the library view derived its current route via
// `resolveCurrentPathname()`, which read the NON-reactive `window.location.pathname`
// for its value. The `$derived` therefore never re-ran on client-side navigation and
// the view went stale. The fix reads SvelteKit's reactive `page.url` first so the
// derivation reacts to route changes. This file mocks `$app/state` with a mutable URL
// so we can prove the derived state follows `page.url` — independent of the
// (deliberately stale) `window.location`.
let pageUrl = new URL("http://localhost/library");
vi.mock("$app/state", () => ({
	get page() {
		return { url: pageUrl, params: {}, route: { id: null }, status: 200, error: null, data: {}, form: null };
	},
}));

const now = "2026-05-14T00:00:00.000Z";

function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
	return {
		projectId: "project-1",
		name: "Alpha Chapter 1",
		createdAt: now,
		updatedAt: now,
		targetLang: "th",
		pageCount: 2,
		textLayerCount: 0,
		taskCount: 0,
		openTaskCount: 0,
		reviewTaskCount: 0,
		openCommentCount: 0,
		...overrides,
	};
}

function workflowTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "page-0-translate",
		type: "translate",
		status: "todo",
		priority: "high",
		pageIndex: 0,
		pageImageId: "image-1",
		title: "Translate page 1",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function projectState(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Alpha Chapter 1",
		createdAt: now,
		currentPage: 0,
		targetLang: "th",
		pages: [
			{
				imageId: "image-1",
				imageName: "image-1",
				originalName: "page-001.png",
				textLayers: [],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
			{
				imageId: "image-2",
				imageName: "image-2",
				originalName: "page-002.png",
				textLayers: [],
				imageLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
		tasks: [workflowTask()],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		activityLog: [],
		...overrides,
	};
}

// jsdom does not implement Element.prototype.scrollTo; the library shell's
// scroll-to-top-on-route-change effect calls it. Stub it so the effect is a no-op.
if (!("scrollTo" in Element.prototype)) {
	(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
}

beforeEach(() => {
	vi.restoreAllMocks();
	// window.location stays on the OVERVIEW route the whole time: the view must NOT
	// rely on it. Routing decisions must come from the reactive `page.url`.
	window.history.replaceState({}, "", "/library");
	pageUrl = new URL("http://localhost/library");
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	editorStore.editor = null;
	editorStore.hasImage = false;
});

describe("WorkspaceLibraryView routing reactivity", () => {
	it("derives the chapter-detail route from the reactive page.url, not window.location", async () => {
		projectStore.recentProjects = [projectSummary()];
		const openSpy = vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(projectState());
			return true;
		});
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});
		editorUiStore.openLibrary("alpha");
		editorUiStore.setWorkspaceLanguageKey("th");

		// `page.url` carries the chapter-detail route while `window.location` is the
		// overview. If the view read window.location (the old, non-reactive bug) it would
		// NOT load the chapter; reading the reactive page store, it does.
		pageUrl = new URL("http://localhost/library/alpha/chapters/project-1");
		expect(window.location.pathname).toBe("/library");

		render(WorkspaceLibraryView);

		await waitFor(() => expect(openSpy).toHaveBeenCalledWith("project-1", null));
		await waitFor(() => expect(screen.getByLabelText("หน้าในตอน")).toBeTruthy());
	});
});
