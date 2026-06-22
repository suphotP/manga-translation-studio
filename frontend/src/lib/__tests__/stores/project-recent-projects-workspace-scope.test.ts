// Library cross-workspace isolation (PR #360 round-2 frontend fix).
//
// The Library's recent-projects fetch MUST always be scoped to the workspace the
// user is actually viewing. The earlier behaviour read the persisted current
// workspace id directly and FELL BACK to `api.listProjects(undefined)` (the legacy
// UNSCOPED, every-workspace listing) whenever that id was absent — e.g. on a first
// load with empty localStorage before the workspaces store settles. That is a
// cross-workspace data leak. These tests pin the corrected contract:
//
//   - no resolvable workspace → fetch NOTHING (never the unscoped list).
//   - an explicit `workspaceId` from the caller → scope to it.
//   - `clearRecentProjects()` drops the held listing + in-flight dedup so a switch
//     can reload cleanly scoped to the new workspace.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ProjectSummary } from "$lib/api/client.js";

vi.mock("$lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {},
	listProjects: vi.fn(),
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
}));

vi.mock("$lib/config.js", () => ({
	config: { defaultLang: "th" },
}));

const WORKSPACE_STORAGE_KEY = "manga-editor.currentWorkspaceId";

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
	return {
		projectId: "proj-1",
		name: "Chapter 1",
		createdAt: "2026-06-06T00:00:00.000Z",
		targetLang: "th",
		...overrides,
	} as ProjectSummary;
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	// Default the mock to a single project so an UNSCOPED leak (if it happened) would
	// be observable as a non-empty listing.
	vi.mocked(api.listProjects).mockResolvedValue({ projects: [summary()] });
	projectStore.clearRecentProjects();
	projectStore.__resetForTesting();
});

afterEach(() => {
	localStorage.clear();
	projectStore.clearRecentProjects();
	projectStore.__resetForTesting();
});

describe("ProjectStore.loadRecentProjects — workspace scoping (Library isolation)", () => {
	it("with empty localStorage and no caller workspace id, fetches NOTHING (never the unscoped list)", async () => {
		// No persisted current workspace, and the caller could not resolve one yet.
		await projectStore.loadRecentProjects();

		// The legacy unscoped `listProjects(undefined)` must NOT have been issued.
		expect(api.listProjects).not.toHaveBeenCalled();
		expect(projectStore.recentProjects).toEqual([]);
	});

	it("with an explicit null workspace id (caller knows none is resolvable), fetches NOTHING", async () => {
		await projectStore.loadRecentProjects({ workspaceId: null });

		expect(api.listProjects).not.toHaveBeenCalled();
		expect(projectStore.recentProjects).toEqual([]);
	});

	it("with an explicit workspace id, scopes the listing to that workspace", async () => {
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [summary({ projectId: "ws-a-proj", workspaceId: "ws-a" })],
		});

		await projectStore.loadRecentProjects({ workspaceId: "ws-a" });

		expect(api.listProjects).toHaveBeenCalledTimes(1);
		expect(api.listProjects).toHaveBeenCalledWith("ws-a");
		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["ws-a-proj"]);
	});

	it("falls back to the PERSISTED workspace id when the caller passes no explicit id", async () => {
		localStorage.setItem(WORKSPACE_STORAGE_KEY, "ws-persisted");
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [summary({ projectId: "persisted-proj", workspaceId: "ws-persisted" })],
		});

		await projectStore.loadRecentProjects();

		expect(api.listProjects).toHaveBeenCalledWith("ws-persisted");
		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["persisted-proj"]);
	});

	it("an explicit workspace id OVERRIDES a stale persisted id (so a switch is scoped to the NEW id)", async () => {
		localStorage.setItem(WORKSPACE_STORAGE_KEY, "ws-old");
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [summary({ projectId: "new-proj", workspaceId: "ws-new" })],
		});

		await projectStore.loadRecentProjects({ workspaceId: "ws-new" });

		expect(api.listProjects).toHaveBeenCalledWith("ws-new");
		expect(api.listProjects).not.toHaveBeenCalledWith("ws-old");
	});

	it("clearRecentProjects() drops the held listing and resets in-flight dedup so a reload re-fetches scoped", async () => {
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [summary({ projectId: "ws-a-proj", workspaceId: "ws-a" })],
		});
		await projectStore.loadRecentProjects({ workspaceId: "ws-a" });
		expect(projectStore.recentProjects).toHaveLength(1);

		projectStore.clearRecentProjects();
		expect(projectStore.recentProjects).toEqual([]);

		// A reload scoped to a DIFFERENT workspace must issue a fresh, scoped request
		// (not reuse the previous workspace's in-flight/dedup state).
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [summary({ projectId: "ws-b-proj", workspaceId: "ws-b" })],
		});
		await projectStore.loadRecentProjects({ workspaceId: "ws-b" });

		expect(api.listProjects).toHaveBeenLastCalledWith("ws-b");
		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["ws-b-proj"]);
	});

	it("simulated workspace SWITCH: clear old shelves + scoped reload leaves no stale cross-workspace projects", async () => {
		// Load workspace A's shelves.
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [summary({ projectId: "a-1", workspaceId: "ws-a" }), summary({ projectId: "a-2", workspaceId: "ws-a" })],
		});
		await projectStore.loadRecentProjects({ workspaceId: "ws-a" });
		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["a-1", "a-2"]);

		// Switch to B: clear, then reload scoped to B (mirrors WorkspaceSidebar.switchWorkspace).
		projectStore.clearRecentProjects();
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [summary({ projectId: "b-1", workspaceId: "ws-b" })],
		});
		await projectStore.loadRecentProjects({ workspaceId: "ws-b" });

		// Only B's project remains — none of A's shelves leaked through.
		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["b-1"]);
	});
});

// PR #360 round-3 (adversarial codex re-review): stale-response RACE.
//
// The dedup/clear fixes above stop B from REUSING A's in-flight request, but they
// cannot cancel A's already-running continuation. If A's load starts, the user
// switches to B (clear + scoped reload), B resolves first, and THEN A resolves
// late, the old code UNCONDITIONALLY assigned A's projects to `recentProjects` —
// cross-rendering A under B. A monotonic load token captured per call drops any
// response whose token is no longer the latest.
describe("ProjectStore.loadRecentProjects — stale-response race (Library isolation)", () => {
	type Deferred = { promise: Promise<{ projects: ProjectSummary[] }>; resolve: (projects: ProjectSummary[]) => void };

	function deferred(): Deferred {
		let resolve!: (projects: ProjectSummary[]) => void;
		const promise = new Promise<{ projects: ProjectSummary[] }>((res) => {
			resolve = (projects: ProjectSummary[]) => res({ projects });
		});
		return { promise, resolve };
	}

	it("a slow workspace-A load resolving AFTER B loaded is DROPPED (B's data is kept)", async () => {
		const aDeferred = deferred();
		const bDeferred = deferred();
		vi.mocked(api.listProjects).mockImplementation((workspaceId?: string) => {
			if (workspaceId === "ws-a") return aDeferred.promise;
			if (workspaceId === "ws-b") return bDeferred.promise;
			return Promise.resolve({ projects: [] });
		});

		// A starts loading (still awaiting).
		const aLoad = projectStore.loadRecentProjects({ workspaceId: "ws-a" });

		// User switches to B: clear (mirrors WorkspaceSidebar.switchWorkspace) + load B.
		projectStore.clearRecentProjects();
		const bLoad = projectStore.loadRecentProjects({ workspaceId: "ws-b" });

		// B resolves FIRST.
		bDeferred.resolve([summary({ projectId: "b-1", workspaceId: "ws-b" })]);
		await bLoad;
		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["b-1"]);

		// A resolves LATE — it must NOT overwrite B.
		aDeferred.resolve([summary({ projectId: "a-1", workspaceId: "ws-a" }), summary({ projectId: "a-2", workspaceId: "ws-a" })]);
		await aLoad;

		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["b-1"]);
	});

	it("rapid A→B→A switches: only the FINAL A's data wins, earlier in-flight loads are dropped", async () => {
		const a1Deferred = deferred();
		const bDeferred = deferred();
		const a2Deferred = deferred();
		const aDeferreds = [a1Deferred, a2Deferred];
		let aCall = 0;
		vi.mocked(api.listProjects).mockImplementation((workspaceId?: string) => {
			if (workspaceId === "ws-a") return aDeferreds[aCall++].promise;
			if (workspaceId === "ws-b") return bDeferred.promise;
			return Promise.resolve({ projects: [] });
		});

		// First A load (will resolve LATE and must be dropped).
		const a1Load = projectStore.loadRecentProjects({ workspaceId: "ws-a" });

		// Switch to B.
		projectStore.clearRecentProjects();
		const bLoad = projectStore.loadRecentProjects({ workspaceId: "ws-b" });

		// Switch back to A (a SECOND, fresh A load — this is the final intended scope).
		projectStore.clearRecentProjects();
		const a2Load = projectStore.loadRecentProjects({ workspaceId: "ws-a" });

		// The final A load resolves and renders.
		a2Deferred.resolve([summary({ projectId: "a-final", workspaceId: "ws-a" })]);
		await a2Load;
		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["a-final"]);

		// Now the stale earlier loads resolve late — neither may overwrite the final A.
		bDeferred.resolve([summary({ projectId: "b-1", workspaceId: "ws-b" })]);
		await bLoad;
		a1Deferred.resolve([summary({ projectId: "a-stale", workspaceId: "ws-a" })]);
		await a1Load;

		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["a-final"]);
	});

	it("the LATEST load for the current workspace still renders normally", async () => {
		vi.mocked(api.listProjects).mockResolvedValue({
			projects: [summary({ projectId: "ws-a-proj", workspaceId: "ws-a" })],
		});

		await projectStore.loadRecentProjects({ workspaceId: "ws-a" });

		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["ws-a-proj"]);
	});

	it("a stale FAILED load does not stomp the current scope's state", async () => {
		const aDeferred = deferred();
		let aReject!: (err: Error) => void;
		const aFailing = new Promise<{ projects: ProjectSummary[] }>((_res, rej) => { aReject = rej; });
		vi.mocked(api.listProjects).mockImplementation((workspaceId?: string) => {
			if (workspaceId === "ws-a") return aFailing;
			if (workspaceId === "ws-b") return aDeferred.promise;
			return Promise.resolve({ projects: [] });
		});

		const aLoad = projectStore.loadRecentProjects({ workspaceId: "ws-a" });
		projectStore.clearRecentProjects();
		const bLoad = projectStore.loadRecentProjects({ workspaceId: "ws-b" });

		aDeferred.resolve([summary({ projectId: "b-1", workspaceId: "ws-b" })]);
		await bLoad;
		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["b-1"]);

		// A fails LATE — its error must not surface over B's good state.
		aReject(new Error("network"));
		await aLoad;

		expect(projectStore.recentProjects.map((p) => p.projectId)).toEqual(["b-1"]);
		expect(projectStore.recentProjectsError).toBeNull();
	});
});
