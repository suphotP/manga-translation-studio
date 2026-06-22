// Scoped "Your team": the sidebar roster shows ONLY people on the in-context
// story/chapter (series duty assignments + active chapter-team rows, chapter
// overriding per-user) — never the full workspace member list, and never raw
// userIds as display names. With no story/chapter context it falls back to
// just the signed-in user.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";

vi.mock("$app/state", () => ({
	page: { url: new URL("http://localhost/") },
}));
vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
}));
vi.mock("$lib/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/api/client")>();
	return {
		...actual,
		listStoryAssignments: vi.fn(async () => ({ assignments: [] })),
	};
});

import WorkspaceSidebar from "$lib/components/WorkspaceSidebar.svelte";
import * as api from "$lib/api/client";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import type { ProjectState } from "$lib/types";

function openProject(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "proj-1",
		name: "Story A — Ch 1",
		createdAt: "2026-06-01T00:00:00.000Z",
		storyId: "story-a",
		storyTitle: "Story A",
		pages: [],
		currentPage: 0,
		...overrides,
	} as ProjectState;
}

beforeEach(() => {
	vi.clearAllMocks();
	editorUiStore.workspaceTitleKey = null;
	projectStore.project = null;
	projectStore.clearRecentProjects?.();
	workspacesStore.workspaces = [
		{ workspaceId: "ws-1", name: "My Workspace", planId: "free", memberRole: "owner", memberScope: {} } as any,
	];
	workspacesStore.currentWorkspaceId = "ws-1";
	// Workspace roster deliberately full of OTHER people — none may leak into
	// the scoped team display.
	workspacesStore.members = [
		{ workspaceId: "ws-1", userId: "stranger-1", role: "editor", scope: {} } as any,
		{ workspaceId: "ws-1", userId: "stranger-2", role: "viewer", scope: {} } as any,
	];
	authStore.user = { id: "u-self", name: "Self Owner", email: "self@example.com" } as any;
	authStore.accessToken = "test-token" as any;
	(authStore as any).status = "authenticated";
});

afterEach(() => {
	vi.restoreAllMocks();
	authStore.user = null as any;
	authStore.accessToken = null as any;
	(authStore as any).status = "idle";
	workspacesStore.members = [];
});

describe("WorkspaceSidebar scoped team", () => {
	it("falls back to just yourself when no story/chapter is in context", async () => {
		render(WorkspaceSidebar);
		const stack = await screen.findByRole("group", { name: "ทีมของคุณ" });
		await waitFor(() => expect(stack.textContent).toContain("S"));
		// Workspace-roster strangers never render in the scoped block.
		expect(stack.textContent).not.toContain("stranger-1");
		expect(screen.getByText("ทีมของคุณ · 1")).toBeTruthy();
	});

	it("shows series assignees + chapter-team rows for the open chapter (chapter overrides per-user)", async () => {
		vi.mocked(api.listStoryAssignments).mockResolvedValue({
			assignments: [
				{ workspaceId: "ws-1", storyId: "story-a", userId: "u-series", role: "translator", createdAt: "", updatedAt: "", displayName: "Series Translator" },
				{ workspaceId: "ws-1", storyId: "story-a", userId: "u-both", role: "cleaner", createdAt: "", updatedAt: "", displayName: "Series Name" },
			],
		});
		projectStore.project = openProject({
			chapterTeam: [
				{ id: "ctm-1", userId: "u-both", displayName: "Chapter Name", role: "qc", status: "active", createdAt: "" },
				{ id: "ctm-2", email: "pending@example.com", role: "cleaner", status: "pending", createdAt: "" },
			],
		});
		render(WorkspaceSidebar);
		await waitFor(() => expect(api.listStoryAssignments).toHaveBeenCalledWith("ws-1", "story-a"));
		// Roster = series translator + the overridden member (counted ONCE, with
		// the chapter-level identity). The PENDING invite is not on the roster.
		await waitFor(() => expect(screen.getByText("ทีมของคุณ · 2")).toBeTruthy());
	});

	it("scopes by selected story when no assignments exist → self fallback (not the workspace roster)", async () => {
		vi.mocked(api.listStoryAssignments).mockResolvedValue({ assignments: [] });
		projectStore.project = openProject();
		render(WorkspaceSidebar);
		await waitFor(() => expect(api.listStoryAssignments).toHaveBeenCalledWith("ws-1", "story-a"));
		await waitFor(() => expect(screen.getByText("ทีมของคุณ · 1")).toBeTruthy());
	});

	it("a stale chapter from ANOTHER workspace never leaks its team into this workspace's roster", async () => {
		vi.mocked(api.listStoryAssignments).mockResolvedValue({ assignments: [] });
		// Chapter loaded from ws-OTHER stays open while the user switches to ws-1.
		projectStore.project = openProject({
			workspaceId: "ws-OTHER",
			chapterTeam: [
				{ id: "ctm-1", userId: "u-foreign", displayName: "Foreign Member", role: "cleaner", status: "active", createdAt: "" },
			],
		} as Partial<ProjectState>);
		render(WorkspaceSidebar);
		// Roster = self only; the foreign chapter team is excluded, and the
		// foreign project's storyId is not used for the assignment fetch.
		await waitFor(() => expect(screen.getByText("ทีมของคุณ · 1")).toBeTruthy());
		expect(api.listStoryAssignments).not.toHaveBeenCalledWith("ws-1", "story-a");
	});

	it("resolves a hybrid <storyId>-<slug> story key to the RAW storyId for the assignment fetch", async () => {
		vi.mocked(api.listStoryAssignments).mockResolvedValue({ assignments: [] });
		projectStore.project = null;
		// Library story route context: the editor-ui title key is the hybrid segment.
		editorUiStore.workspaceTitleKey = "story9x7-my-cool-series";
		render(WorkspaceSidebar);
		await waitFor(() => expect(api.listStoryAssignments).toHaveBeenCalledWith("ws-1", "story9x7"));
		editorUiStore.workspaceTitleKey = null;
	});
});
