// IA consistency: when the WorkspaceSidebar is rendered inside the standalone
// shell on /storage and /settings/*, the matching footer/nav entry must light up
// as the active surface AND the stale in-shell "Dashboard" highlight (which keys
// off editorUiStore.workspaceView, defaulting to "dashboard") must be suppressed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";

// $app modules aren't available under vitest. The active-state derivations key
// off page.url.pathname, so each test sets the pathname before importing/rendering.
let currentUrl = new URL("http://localhost/storage");
vi.mock("$app/state", () => ({
	get page() {
		return { url: currentUrl };
	},
}));
vi.mock("$app/navigation", () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
}));

import WorkspaceSidebar from "$lib/components/WorkspaceSidebar.svelte";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";

beforeEach(() => {
	projectStore.project = null;
	projectStore.clearRecentProjects?.();
	workspacesStore.workspaces = [
		{ workspaceId: "ws-1", name: "My Workspace", planId: "free", memberRole: "owner", memberScope: {} } as any,
	];
	workspacesStore.currentWorkspaceId = "ws-1";
	// The in-shell view defaults to "dashboard"; the standalone routes do not drive
	// it, so this is exactly the stale value the sidebar must ignore on those routes.
	editorUiStore.setWorkspaceView?.("dashboard");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("WorkspaceSidebar active state on standalone routes", () => {
	// Default locale is Thai, so labels resolve to the Thai strings:
	//   Storage nav (aria-label sidebar.storageLibrary) = "คลังรูป"
	//   Dashboard nav (aria-label sidebar.dashboard)     = "แดชบอร์ด"
	//   Settings footer (text sidebar.settings)          = "ตั้งค่า"
	it("highlights Storage (not Dashboard) on /storage", () => {
		currentUrl = new URL("http://localhost/storage");
		render(WorkspaceSidebar);

		const storage = screen.getByRole("button", { name: "คลังรูป" });
		expect(storage.className).toContain("active");

		// Dashboard's stale view-based highlight is suppressed on the standalone route.
		const dashboard = screen.getByRole("button", { name: "แดชบอร์ด" });
		expect(dashboard.className).not.toContain("ws-nav-active");
	});

	it("highlights Settings (not Dashboard) on /settings/profile", () => {
		currentUrl = new URL("http://localhost/settings/profile");
		render(WorkspaceSidebar);

		const settings = screen.getByText("ตั้งค่า").closest("button");
		expect(settings).toBeTruthy();
		expect(settings!.className).toContain("active");

		const dashboard = screen.getByRole("button", { name: "แดชบอร์ด" });
		expect(dashboard.className).not.toContain("ws-nav-active");
	});

	// /support and /notifications have NO sidebar nav entry of their own, so the
	// only requirement is that the stale view-based Dashboard highlight is
	// suppressed (it must not falsely light up). They are standalone routes that
	// still mount the sidebar via WorkspaceStandaloneShell.
	it("does not falsely highlight Dashboard on /support", () => {
		currentUrl = new URL("http://localhost/support");
		render(WorkspaceSidebar);

		const dashboard = screen.getByRole("button", { name: "แดชบอร์ด" });
		expect(dashboard.className).not.toContain("ws-nav-active");
	});

	it("does not falsely highlight Dashboard on /support/tickets/abc", () => {
		currentUrl = new URL("http://localhost/support/tickets/abc");
		render(WorkspaceSidebar);

		const dashboard = screen.getByRole("button", { name: "แดชบอร์ด" });
		expect(dashboard.className).not.toContain("ws-nav-active");
	});

	it("does not falsely highlight Dashboard on /notifications", () => {
		currentUrl = new URL("http://localhost/notifications");
		render(WorkspaceSidebar);

		const dashboard = screen.getByRole("button", { name: "แดชบอร์ด" });
		expect(dashboard.className).not.toContain("ws-nav-active");
	});
});
