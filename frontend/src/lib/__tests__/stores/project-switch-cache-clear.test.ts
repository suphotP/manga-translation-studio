// codex-audit P2 — openProject() must revoke + drop the OUTGOING project's
// localImageUrls when it switches to a DIFFERENT projectId (in file mode these hold
// big blob:/data: image strings, so retaining them across a switch leaks memory). It
// must NOT clear when reloading the SAME project mid-session (that would drop in-flight
// unsaved local edits for the current project).
//
// The full openProject load chain (versions/comments/workflow/markers/assets/…) is not
// the subject here, so those instance methods are stubbed to no-op; only loadProject is
// mocked to hand back the target project. The assertions are scoped to the cache-clear
// behavior + the blob: revoke.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ProjectState } from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {},
	loadProject: vi.fn(),
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
	saveProject: vi.fn(),
	// loadFilesWithSetup (new-project create) round-trips through these; mocked so the
	// FINDING 3 replaceOpenProject integration test can drive a brand-new project create.
	createProject: vi.fn(),
	uploadImages: vi.fn(),
	// The catch path in loadFilesWithSetup (a mid-flow throw → rollback, FINDING 1) runs the
	// upload-error mapper, which consults these.
	isUploadTooLargeError: vi.fn(() => false),
	UPLOAD_TOO_LARGE_MESSAGE: "upload too large",
}));

vi.mock("$lib/config.js", () => ({
	config: { defaultLang: "th" },
}));

const PROJECT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const PROJECT_B = "bbbbbbbb-2222-4222-8222-222222222222";

function project(projectId: string, name: string): ProjectState {
	return {
		projectId,
		name,
		createdAt: "2026-06-07T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		// No pages → openProject skips loadPage (no editor work needed for this test).
		pages: [],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
	} as ProjectState;
}

// Stub every post-load fetch openProject runs so the test isolates the cache-clear path.
const LOAD_METHODS = [
	"loadVersions",
	"loadWorkflow",
	"loadComments",
	"loadAiReviewMarkers",
	"loadReviewDecisions",
	"loadReviewAssignments",
	"loadRevisions",
	"loadWorkspaceHub",
	"loadCurrentWorkspaceMember",
	"loadRecentProjects",
	"loadImageAssets",
] as const;

let revokeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	for (const m of LOAD_METHODS) {
		vi.spyOn(projectStore as unknown as Record<string, () => Promise<void>>, m).mockResolvedValue(undefined);
	}
	revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	projectStore.__resetForTesting();
});

afterEach(() => {
	vi.restoreAllMocks();
	projectStore.__resetForTesting();
});

describe("ProjectStore openProject — P2 localImageUrls cache clear on project switch", () => {
	it("clears + revokes the previous project's localImageUrls when switching to a DIFFERENT project", async () => {
		// Open A first.
		vi.mocked(api.loadProject).mockResolvedValueOnce(project(PROJECT_A, "Project A"));
		await projectStore.openProject(PROJECT_A);
		expect(projectStore.project?.projectId).toBe(PROJECT_A);

		// Seed A with local image URLs (one blob:, one data:).
		const store = projectStore as unknown as { localImageUrls: Record<string, string> };
		store.localImageUrls = {
			"img-blob": "blob:http://localhost/abc-123",
			"img-data": "data:image/png;base64,AAAA",
		};

		// Switch to B.
		vi.mocked(api.loadProject).mockResolvedValueOnce(project(PROJECT_B, "Project B"));
		await projectStore.openProject(PROJECT_B);

		expect(projectStore.project?.projectId).toBe(PROJECT_B);
		// The previous project's blob: URL was revoked, and the map is empty for B.
		expect(revokeSpy).toHaveBeenCalledWith("blob:http://localhost/abc-123");
		expect(store.localImageUrls).toEqual({});
	});

	it("does NOT clear localImageUrls when reloading the SAME project (no unsaved-edit loss)", async () => {
		vi.mocked(api.loadProject).mockResolvedValue(project(PROJECT_A, "Project A"));
		await projectStore.openProject(PROJECT_A);

		const store = projectStore as unknown as { localImageUrls: Record<string, string> };
		store.localImageUrls = { "img-blob": "blob:http://localhost/keep-me" };

		// Re-open the SAME project id (e.g. a mid-session reopen).
		await projectStore.openProject(PROJECT_A);

		expect(projectStore.project?.projectId).toBe(PROJECT_A);
		// Same-project reload must preserve the local URLs and revoke nothing.
		expect(revokeSpy).not.toHaveBeenCalled();
		expect(store.localImageUrls).toEqual({ "img-blob": "blob:http://localhost/keep-me" });
	});
});

describe("ProjectStore openProject — project-switch teardown hook (AI poll cleanup wiring)", () => {
	it("fires registered switch hooks with the OUTGOING projectId on a real switch", async () => {
		const hook = vi.fn();
		const unregister = projectStore.registerOnProjectSwitch(hook);
		try {
			vi.mocked(api.loadProject).mockResolvedValueOnce(project(PROJECT_A, "Project A"));
			await projectStore.openProject(PROJECT_A);
			// First open has no previous project → no switch-away from another project.
			expect(hook).not.toHaveBeenCalled();

			vi.mocked(api.loadProject).mockResolvedValueOnce(project(PROJECT_B, "Project B"));
			await projectStore.openProject(PROJECT_B);
			// Switching A→B fires the hook with the OUTGOING id, once the switch is
			// COMMITTED (B's state loaded), so the AI jobs store can tear down project A's
			// now-orphaned poll intervals.
			expect(hook).toHaveBeenCalledTimes(1);
			expect(hook).toHaveBeenCalledWith(PROJECT_A, PROJECT_B);
		} finally {
			unregister();
		}
	});

	it("does NOT fire switch hooks when the switch FAILS at the save gate (outgoing project + its polls stay intact)", async () => {
		// P2: the teardown hook must fire only AFTER the switch is committed. If
		// saveBeforeProjectSwitch rejects (autosave conflict / network), openProject
		// returns false and project A STAYS open — so its polls must NOT be torn down,
		// otherwise A's live jobs would stop updating the still-open project A.
		const hook = vi.fn();
		const unregister = projectStore.registerOnProjectSwitch(hook);
		const loadSpy = vi.spyOn(api, "loadProject");
		try {
			vi.mocked(api.loadProject).mockResolvedValueOnce(project(PROJECT_A, "Project A"));
			await projectStore.openProject(PROJECT_A);
			expect(projectStore.project?.projectId).toBe(PROJECT_A);

			// Make the pre-switch save reject → the switch must abort and A stays open.
			const saveSpy = vi
				.spyOn(projectStore as unknown as { saveBeforeProjectSwitch: () => Promise<void> }, "saveBeforeProjectSwitch")
				.mockRejectedValue(new Error("save conflict"));
			loadSpy.mockClear();

			const switched = await projectStore.openProject(PROJECT_B);

			// The switch was rejected: openProject returned false, A is still the open
			// project, B was never loaded, and the teardown hook NEVER fired (A's polls
			// stay alive).
			expect(switched).toBe(false);
			expect(projectStore.project?.projectId).toBe(PROJECT_A);
			expect(loadSpy).not.toHaveBeenCalled();
			expect(hook).not.toHaveBeenCalled();
			saveSpy.mockRestore();
		} finally {
			unregister();
		}
	});

	it("does NOT fire switch hooks when reopening the SAME project (fresh polls survive)", async () => {
		const hook = vi.fn();
		const unregister = projectStore.registerOnProjectSwitch(hook);
		try {
			vi.mocked(api.loadProject).mockResolvedValue(project(PROJECT_A, "Project A"));
			await projectStore.openProject(PROJECT_A);
			await projectStore.openProject(PROJECT_A);
			expect(hook).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});
});

describe("ProjectStore replaceOpenProject — switch hooks fire on EVERY id-changing assignment (round 9 FINDING 3)", () => {
	// Round 9 FINDING 3: the switch-cleanup hook (cancelPollsForProject → drop the OUTGOING
	// project's AI poll intervals + orphaned queue rows + freed slots) only fired from
	// openProject. But `this.project` is replaced with a DIFFERENT id by OTHER flows too —
	// loadFiles' brand-new project create and a recovery-draft restore that lands a different
	// project. Without routing those through the seam, the left project's AI rows would sit
	// in the global queue forever (no poller, unclearable). replaceOpenProject is the single
	// seam: it fires runProjectSwitchHooks ONLY on a real id change, and every id-changing
	// assignment routes through it.

	const CURRENT_WORKSPACE_STORAGE_KEY = "manga-editor.currentWorkspaceId";
	const CONFLICT_RECOVERY_STORAGE_PREFIX = "manga-editor:conflict-recovery:";
	const CONFLICT_RECOVERY_INDEX_KEY = "manga-editor:conflict-recovery:index";

	function seedRecoveryDraft(draftProject: ProjectState, draftId = "draft-1"): void {
		const draft = {
			kind: "manga-editor-conflict-local-copy",
			id: draftId,
			exportedAt: "2026-06-07T00:00:00.000Z",
			reason: "project_save_conflict",
			message: "conflict",
			projectId: draftProject.projectId,
			projectName: draftProject.name,
			pageIndex: 0,
			pageCount: draftProject.pages.length,
			textLayerCount: 0,
			imageLayerCount: 0,
			project: draftProject,
		};
		localStorage.setItem(`${CONFLICT_RECOVERY_STORAGE_PREFIX}${draftId}`, JSON.stringify(draft));
		localStorage.setItem(CONFLICT_RECOVERY_INDEX_KEY, JSON.stringify([draftId]));
	}

	afterEach(() => {
		localStorage.clear();
	});

	it("a recovery-draft restore to a DIFFERENT project FIRES the hook with the outgoing id (orphaned AI rows dropped)", async () => {
		const hook = vi.fn();
		const unregister = projectStore.registerOnProjectSwitch(hook);
		try {
			// Project A is open.
			projectStore.__setProjectForTesting(project(PROJECT_A, "Project A"));
			// A draft for a DIFFERENT project (B) is restored.
			seedRecoveryDraft(project(PROJECT_B, "Project B draft"));

			const ok = await projectStore.restoreLocalConflictRecoveryDraft("draft-1");

			expect(ok).toBe(true);
			expect(projectStore.project?.projectId).toBe(PROJECT_B);
			// The seam fired the hook with the OUTGOING id so the AI store can tear down
			// project A's now-orphaned poll intervals + queue rows.
			expect(hook).toHaveBeenCalledTimes(1);
			expect(hook).toHaveBeenCalledWith(PROJECT_A, PROJECT_B);
		} finally {
			unregister();
		}
	});

	it("a recovery-draft restore to the SAME project does NOT fire the hook (fresh polls survive)", async () => {
		const hook = vi.fn();
		const unregister = projectStore.registerOnProjectSwitch(hook);
		try {
			projectStore.__setProjectForTesting(project(PROJECT_A, "Project A"));
			// The draft is for the SAME open project A (the common conflict-recovery case).
			seedRecoveryDraft(project(PROJECT_A, "Project A draft"));

			const ok = await projectStore.restoreLocalConflictRecoveryDraft("draft-1");

			expect(ok).toBe(true);
			expect(projectStore.project?.projectId).toBe(PROJECT_A);
			// Same-id restore must NOT neutralize project A's still-valid in-flight polls.
			expect(hook).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});

	it("loadFiles (brand-new project create) replacing an open project FIRES the hook with the outgoing id", async () => {
		const hook = vi.fn();
		const unregister = projectStore.registerOnProjectSwitch(hook);
		// The new project id the backend hands back from createProject.
		const NEW_PROJECT = "cccccccc-3333-4333-8333-333333333333";
		// Stub the post-create load chain so the test isolates the replaceOpenProject seam.
		const POST_CREATE_STUBS = [
			"saveState",
			"loadPage",
			"loadVersions",
			"loadWorkflow",
			"resyncBaselineFromServerAfterCreate",
			"loadComments",
			"loadAiReviewMarkers",
			"loadReviewDecisions",
			"loadWorkspaceHub",
			"loadRecentProjects",
			"loadImageAssets",
			"saveBeforeProjectSwitch",
		] as const;
		const stubs = POST_CREATE_STUBS.map((m) =>
			vi.spyOn(projectStore as unknown as Record<string, () => Promise<unknown>>, m).mockResolvedValue(undefined),
		);
		try {
			// A workspace must be resolvable or the create aborts at the scope guard.
			localStorage.setItem(CURRENT_WORKSPACE_STORAGE_KEY, "11111111-1111-4111-8111-111111111111");
			vi.mocked(api.createProject).mockResolvedValue({ projectId: NEW_PROJECT } as never);
			vi.mocked(api.uploadImages).mockResolvedValue({ imageIds: ["img-1"], assets: [] } as never);

			// A NON-EMPTY project A is open (so loadFilesWithSetup takes the create path, not
			// the fill-empty path).
			projectStore.__setProjectForTesting(project(PROJECT_A, "Project A"));
			(projectStore.project as ProjectState).pages = [
				{ imageId: "a-img", imageName: "a-img", textLayers: [], pendingAiJobs: [], coverRect: null },
			] as ProjectState["pages"];

			const file = new File([new Uint8Array([1, 2, 3])], "page.png", { type: "image/png" });
			await projectStore.loadFiles([file], /* editor */ null);

			// The brand-new project replaced project A → the seam fired the hook with A's id.
			expect(projectStore.project?.projectId).toBe(NEW_PROJECT);
			expect(hook).toHaveBeenCalledTimes(1);
			expect(hook).toHaveBeenCalledWith(PROJECT_A, NEW_PROJECT);
		} finally {
			for (const s of stubs) s.mockRestore();
			unregister();
		}
	});
});

describe("ProjectStore loadFiles — switch hook fires only AFTER the create COMMITS (round 10 FINDING 1)", () => {
	// Round 10 FINDING 1: loadFilesWithSetup assigned the new project AND fired the switch
	// teardown (cancelPollsForProject → drop the OUTGOING project's queue rows + pollers)
	// at the ASSIGNMENT — but later steps in the same try (saveState/loadPage/loadVersions)
	// can throw, and the catch rolls back to the previous project. So a mid-flow throw left
	// the user back in the OLD project with its AI jobs invisible + unpolled (teardown already
	// ran, irreversibly). Fix: assign with fireHooks:false; fire the forward hook only at the
	// success path's COMMIT point. On rollback, the switch-back fires its own hook so any rows
	// the aborted create produced under the new id are cleaned up.

	const CURRENT_WORKSPACE_STORAGE_KEY = "manga-editor.currentWorkspaceId";
	const NEW_PROJECT = "cccccccc-3333-4333-8333-333333333333";

	// The full post-create load chain; the test stubs all of them, then overrides the one
	// step it wants to make throw.
	const POST_CREATE_STUBS = [
		"saveState",
		"loadPage",
		"loadVersions",
		"loadWorkflow",
		"resyncBaselineFromServerAfterCreate",
		"loadComments",
		"loadAiReviewMarkers",
		"loadReviewDecisions",
		"loadWorkspaceHub",
		"loadRecentProjects",
		"loadImageAssets",
		"saveBeforeProjectSwitch",
	] as const;

	afterEach(() => {
		localStorage.clear();
	});

	function stubCreateApis(): void {
		localStorage.setItem(CURRENT_WORKSPACE_STORAGE_KEY, "11111111-1111-4111-8111-111111111111");
		vi.mocked(api.createProject).mockResolvedValue({ projectId: NEW_PROJECT } as never);
		vi.mocked(api.uploadImages).mockResolvedValue({ imageIds: ["img-1"], assets: [] } as never);
	}

	function openNonEmptyProjectA(): void {
		projectStore.__setProjectForTesting(project(PROJECT_A, "Project A"));
		(projectStore.project as ProjectState).pages = [
			{ imageId: "a-img", imageName: "a-img", textLayers: [], pendingAiJobs: [], coverRect: null },
		] as ProjectState["pages"];
	}

	it("a mid-flow throw (saveState rejects) rolls back to A WITHOUT tearing down A's polls; cleanup targets only the new id", async () => {
		const hook = vi.fn();
		const unregister = projectStore.registerOnProjectSwitch(hook);
		const stubs = POST_CREATE_STUBS.map((m) =>
			vi.spyOn(projectStore as unknown as Record<string, () => Promise<unknown>>, m).mockResolvedValue(undefined),
		);
		// saveState runs AFTER the new project is assigned and BEFORE the commit point → its
		// rejection must trigger the rollback to A.
		vi.spyOn(projectStore as unknown as Record<string, () => Promise<unknown>>, "saveState")
			.mockRejectedValue(new Error("save failed"));
		try {
			stubCreateApis();
			openNonEmptyProjectA();

			const file = new File([new Uint8Array([1, 2, 3])], "page.png", { type: "image/png" });
			await projectStore.loadFiles([file], /* editor */ null);

			// Rolled back to A.
			expect(projectStore.project?.projectId).toBe(PROJECT_A);
			// The FORWARD teardown (PROJECT_A → NEW_PROJECT) NEVER fired — A's polls/rows are
			// intact, so its live AI jobs keep updating. The only hook fired is the ROLLBACK
			// (NEW_PROJECT → PROJECT_A), which cleans up any rows the aborted create produced
			// under the new id.
			expect(hook).toHaveBeenCalledTimes(1);
			expect(hook).toHaveBeenCalledWith(NEW_PROJECT, PROJECT_A);
			expect(hook).not.toHaveBeenCalledWith(PROJECT_A, NEW_PROJECT);
		} finally {
			for (const s of stubs) s.mockRestore();
			vi.restoreAllMocks();
			unregister();
		}
	});

	it("a fully successful create fires the forward hook exactly once with (previousId, newId)", async () => {
		const hook = vi.fn();
		const unregister = projectStore.registerOnProjectSwitch(hook);
		const stubs = POST_CREATE_STUBS.map((m) =>
			vi.spyOn(projectStore as unknown as Record<string, () => Promise<unknown>>, m).mockResolvedValue(undefined),
		);
		try {
			stubCreateApis();
			openNonEmptyProjectA();

			const file = new File([new Uint8Array([1, 2, 3])], "page.png", { type: "image/png" });
			await projectStore.loadFiles([file], /* editor */ null);

			expect(projectStore.project?.projectId).toBe(NEW_PROJECT);
			// Committed switch → exactly one forward teardown for the OUTGOING project.
			expect(hook).toHaveBeenCalledTimes(1);
			expect(hook).toHaveBeenCalledWith(PROJECT_A, NEW_PROJECT);
		} finally {
			for (const s of stubs) s.mockRestore();
			unregister();
		}
	});
});
