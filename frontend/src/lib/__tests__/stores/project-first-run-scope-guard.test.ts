// First-run workspace-scope guard (P1).
//
// A brand-new workspace-scoped create MUST NOT fall back to an UNSCOPED personal/
// orphan project when the workspace context hasn't resolved yet. When the caller
// marks the create as requiring a scope (`requireScopedCreate: true`) but neither an
// explicit `workspaceId` nor the persisted current-workspace id is available, the
// store must ABORT before creating anything (no `api.createProject`) and surface a
// clear "setting up your workspace…" status so the user can retry once it resolves.
//
// When a workspace IS resolvable, the create proceeds as normal.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";

vi.mock("$lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {},
	createProject: vi.fn(),
	uploadImages: vi.fn(),
	saveProject: vi.fn(async () => ({})),
	getProject: vi.fn(async () => null),
	loadVersions: vi.fn(async () => []),
	isUploadTooLargeError: vi.fn(() => false),
	UPLOAD_TOO_LARGE_MESSAGE: "too large",
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/project/${projectId}/images/${imageId}`),
}));

vi.mock("$lib/config.js", () => ({
	config: { defaultLang: "th" },
}));

const WORKSPACE_STORAGE_KEY = "manga-editor.currentWorkspaceId";

function pngFile(name = "page-1.png"): File {
	// 1x1 PNG header bytes are enough for orderProjectImageFiles/isSupportedImageFile.
	return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	// Ensure no project is open so loadFilesWithSetup takes the new-create branch.
	projectStore.project = null;
});

afterEach(() => {
	localStorage.clear();
});

describe("first-run create scope guard", () => {
	it("blocks an unscoped scoped-required create (no workspace resolved) instead of orphaning a project", async () => {
		localStorage.removeItem(WORKSPACE_STORAGE_KEY);

		await projectStore.loadFilesWithSetup([pngFile()], null, {
			projectName: "First chapter",
			requireScopedCreate: true,
		});

		// No project was created — the guard aborted before the API call.
		expect(api.createProject).not.toHaveBeenCalled();
		expect(api.uploadImages).not.toHaveBeenCalled();
		// User sees a clear "setting up…" retry status, not a silent failure.
		expect(projectStore.statusMsg).toContain("กำลังตั้งค่าเวิร์กสเปซ");
	});

	it("allows the create when an explicit workspaceId is provided (scope resolved)", async () => {
		(api.createProject as ReturnType<typeof vi.fn>).mockResolvedValue({ projectId: "proj-new" });
		(api.uploadImages as ReturnType<typeof vi.fn>).mockResolvedValue({ imageIds: ["img-1"], assets: [] });

		await projectStore.loadFilesWithSetup([pngFile()], null, {
			projectName: "First chapter",
			requireScopedCreate: true,
			workspaceId: "ws-live",
		});

		// The scope resolved, so the create proceeded and stamped the live workspace id.
		expect(api.createProject).toHaveBeenCalledTimes(1);
		const identity = (api.createProject as ReturnType<typeof vi.fn>).mock.calls[0][2];
		expect(identity?.workspaceId).toBe("ws-live");
	});

	it("allows the create when the persisted current-workspace id resolves the scope", async () => {
		localStorage.setItem(WORKSPACE_STORAGE_KEY, "ws-stored");
		(api.createProject as ReturnType<typeof vi.fn>).mockResolvedValue({ projectId: "proj-new" });
		(api.uploadImages as ReturnType<typeof vi.fn>).mockResolvedValue({ imageIds: ["img-1"], assets: [] });

		await projectStore.loadFilesWithSetup([pngFile()], null, {
			projectName: "First chapter",
			requireScopedCreate: true,
		});

		expect(api.createProject).toHaveBeenCalledTimes(1);
		const identity = (api.createProject as ReturnType<typeof vi.fn>).mock.calls[0][2];
		expect(identity?.workspaceId).toBe("ws-stored");
	});
});

// Round-3 adversarial finding: the guard must be UNCONDITIONAL at the single
// `api.createProject` chokepoint and must NOT depend on `requireScopedCreate`. The
// canvas drag/drop path resolves a no-project drop to "create" and calls
// `projectStore.loadFiles(files, editor)` directly, which forwards to
// `loadFilesWithSetup(files, editor)` with an EMPTY setup (no `requireScopedCreate`).
// That bypass must STILL be blocked when no workspace resolves.
describe("first-run create scope guard — unconditional (any entry point)", () => {
	it("blocks an UNFLAGGED create from the drag-drop loadFiles path when no workspace resolves", async () => {
		localStorage.removeItem(WORKSPACE_STORAGE_KEY);

		// `loadFiles` is exactly what CanvasArea's no-project drop calls — empty setup,
		// so NO `requireScopedCreate`. The guard must still fire.
		await projectStore.loadFiles([pngFile()], null);

		expect(api.createProject).not.toHaveBeenCalled();
		expect(api.uploadImages).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toContain("กำลังตั้งค่าเวิร์กสเปซ");
	});

	it("allows the UNFLAGGED drag-drop create once a persisted workspace resolves, and stamps it", async () => {
		localStorage.setItem(WORKSPACE_STORAGE_KEY, "ws-dnd");
		(api.createProject as ReturnType<typeof vi.fn>).mockResolvedValue({ projectId: "proj-dnd" });
		(api.uploadImages as ReturnType<typeof vi.fn>).mockResolvedValue({ imageIds: ["img-1"], assets: [] });

		await projectStore.loadFiles([pngFile()], null);

		expect(api.createProject).toHaveBeenCalledTimes(1);
		const identity = (api.createProject as ReturnType<typeof vi.fn>).mock.calls[0][2];
		expect(identity?.workspaceId).toBe("ws-dnd");
	});

	it("does NOT block fill-existing (add pages to an already-scoped open project) even with no workspace resolved", async () => {
		localStorage.removeItem(WORKSPACE_STORAGE_KEY);
		// An open, already-scoped project with zero pages → the fill path runs BEFORE the
		// create guard and must not call createProject regardless of workspace resolution.
		const fillSpy = vi
			.spyOn(projectStore as unknown as { fillEmptyProjectWithPages: (...a: unknown[]) => Promise<void> }, "fillEmptyProjectWithPages")
			.mockResolvedValue(undefined);
		projectStore.project = { pages: [] } as unknown as typeof projectStore.project;

		await projectStore.loadFilesWithSetup([pngFile()], null, {});

		expect(fillSpy).toHaveBeenCalledTimes(1);
		expect(api.createProject).not.toHaveBeenCalled();
		// Not the "setting up…" abort status — fill-existing was never blocked.
		expect(projectStore.statusMsg ?? "").not.toContain("กำลังตั้งค่าเวิร์กสเปซ");
		fillSpy.mockRestore();
	});
});
