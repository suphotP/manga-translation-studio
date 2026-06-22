import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

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
		leaveWorkspace: vi.fn(async () => ({ ok: true })),
		listStoryAssignments: vi.fn(async () => ({ assignments: [] })),
	};
});

import WorkspaceSidebar from "$lib/components/WorkspaceSidebar.svelte";
import * as api from "$lib/api/client";
import { setLocale } from "$lib/i18n";
import { authStore } from "$lib/stores/auth.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";

const personalWorkspace = {
	workspaceId: "ws-personal",
	name: "Suphot Personal",
	planId: "free",
	memberRole: "owner",
	memberScope: {},
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

const sharedWorkspace = {
	workspaceId: "ws-team",
	name: "Shared Team",
	planId: "team",
	memberRole: "editor",
	memberScope: { taskTypes: ["translate"] },
	createdAt: "2026-02-01T00:00:00.000Z",
	updatedAt: "2026-02-01T00:00:00.000Z",
} as const;

beforeEach(async () => {
	await setLocale("th", { syncUser: false });
	vi.clearAllMocks();
	projectStore.project = null;
	projectStore.clearRecentProjects?.();
	workspacesStore.__resetForTesting();
	workspacesStore.workspaces = [
		personalWorkspace as never,
		sharedWorkspace as never,
		{
			workspaceId: "ws-admin",
			name: "Admin House",
			planId: "team",
			memberRole: "admin",
			memberScope: {},
			createdAt: "2026-03-01T00:00:00.000Z",
			updatedAt: "2026-03-01T00:00:00.000Z",
		} as never,
	];
	workspacesStore.currentWorkspaceId = "ws-personal";
	authStore.user = { id: "u-self", name: "Suphot", email: "suphot@example.com", role: "editor" } as never;
	authStore.accessToken = "test-token";
	authStore.status = "authenticated";
	vi.spyOn(authStore, "init").mockResolvedValue();
	vi.spyOn(workspacesStore, "syncWithAuth").mockResolvedValue();
	vi.mocked(api.leaveWorkspace).mockResolvedValue({ ok: true });
	vi.mocked(api.listStoryAssignments).mockResolvedValue({ assignments: [] });
});

afterEach(() => {
	vi.restoreAllMocks();
	workspacesStore.__resetForTesting();
	projectStore.project = null;
	authStore.user = null;
	authStore.accessToken = null;
	authStore.status = "anonymous";
});

async function openSwitcher(): Promise<void> {
	const trigger = screen.getAllByRole("button").find((button) => button.getAttribute("aria-haspopup") === "dialog");
	expect(trigger).toBeTruthy();
	await fireEvent.click(trigger!);
	expect(await screen.findByRole("dialog", { name: "ตัวสลับเวิร์กสเปซ" })).toBeTruthy();
}

describe("WorkspaceSidebar leave workspace UX", () => {
	it("shows the leave action only for workspaces the current user does not own", async () => {
		render(WorkspaceSidebar);
		await openSwitcher();

		expect(screen.queryByRole("button", { name: "ออกจาก Suphot Personal" })).toBeNull();
		expect(screen.getByRole("button", { name: "ออกจาก Shared Team" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ออกจาก Admin House" })).toBeTruthy();
	});

	it("confirms self-leave, switches current workspace back to personal, and reloads the list", async () => {
		workspacesStore.currentWorkspaceId = "ws-team";
		const switchTo = vi.spyOn(workspacesStore, "switchTo").mockImplementation(async (workspaceId: string) => {
			workspacesStore.currentWorkspaceId = workspaceId;
		});
		const refresh = vi.spyOn(workspacesStore, "refresh").mockImplementation(async () => {
			workspacesStore.workspaces = [personalWorkspace as never];
			workspacesStore.currentWorkspaceId = "ws-personal";
		});
		const clearRecent = vi.spyOn(projectStore, "clearRecentProjects");
		const loadRecent = vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue();

		render(WorkspaceSidebar);
		await openSwitcher();
		await fireEvent.click(screen.getByRole("button", { name: "ออกจาก Shared Team" }));

		expect(screen.getByRole("alertdialog", { name: "ออกจากเวิร์กสเปซนี้?" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "ยืนยันออกจากเวิร์กสเปซ" }));

		await waitFor(() => expect(api.leaveWorkspace).toHaveBeenCalledWith("ws-team"));
		expect(switchTo).toHaveBeenCalledWith("ws-personal");
		expect(refresh).toHaveBeenCalled();
		expect(clearRecent).toHaveBeenCalled();
		expect(loadRecent).toHaveBeenCalledWith({
			background: true,
			silentFailure: true,
			workspaceId: "ws-personal",
		});
		expect(workspacesStore.currentWorkspaceId).toBe("ws-personal");
	});
});
