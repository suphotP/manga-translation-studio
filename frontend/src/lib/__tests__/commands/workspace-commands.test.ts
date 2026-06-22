import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` factories are hoisted above module-scope consts, so the shared
// fakes must live in a `vi.hoisted` block to be referenceable inside them.
const h = vi.hoisted(() => {
	const projectState: {
		project: { projectId: string; pages: unknown[]; currentPage: number } | null;
		recentProjects: Array<{ projectId: string; name: string; targetLang: string }>;
	} = { project: null, recentProjects: [] };
	const workspacesState: {
		workspaces: Array<{ workspaceId: string; name: string; planId: string }>;
		currentWorkspaceId: string | null;
		isAdmin: boolean;
	} = { workspaces: [], currentWorkspaceId: null, isAdmin: true };
	const authState: { isAuthenticated: boolean } = { isAuthenticated: true };
	return {
		projectState,
		workspacesState,
		authState,
		setStatusMsg: vi.fn(),
		clearRecentProjects: vi.fn(),
		loadRecentProjects: vi.fn(() => Promise.resolve()),
		setTool: vi.fn(),
		openEditor: vi.fn(),
		openLibrary: vi.fn(),
		openChapterSetup: vi.fn(),
		openNotificationPanel: vi.fn(),
		switchTo: vi.fn(),
		adminOpen: vi.fn(),
		queueWorkspaceNavigation: vi.fn(),
	};
});

vi.mock("$lib/stores/project.svelte.ts", () => ({
	projectStore: {
		clearRecentProjects: h.clearRecentProjects,
		loadRecentProjects: h.loadRecentProjects,
		get project() {
			return h.projectState.project;
		},
		get recentProjects() {
			return h.projectState.recentProjects;
		},
		setStatusMsg: h.setStatusMsg,
		openProject: vi.fn(),
	},
}));

vi.mock("$lib/stores/workspaces.svelte.ts", () => ({
	workspacesStore: {
		get workspaces() {
			return h.workspacesState.workspaces;
		},
		get currentWorkspaceId() {
			return h.workspacesState.currentWorkspaceId;
		},
		get isAdmin() {
			return h.workspacesState.isAdmin;
		},
		switchTo: h.switchTo,
	},
}));

vi.mock("$lib/stores/auth.svelte.ts", () => ({
	authStore: {
		get isAuthenticated() {
			return h.authState.isAuthenticated;
		},
		user: { email: "qa@example.com" },
		signOut: vi.fn(),
	},
}));

vi.mock("$lib/stores/admin.svelte.ts", () => ({
	adminStore: { open: h.adminOpen },
}));

vi.mock("$lib/stores/command-palette.svelte.ts", () => ({
	commandPaletteStore: { open: false, openPalette: vi.fn(), closePalette: vi.fn() },
}));

vi.mock("$lib/stores/editor.svelte.ts", () => ({
	editorStore: { setTool: h.setTool },
}));

vi.mock("$lib/stores/editor-ui.svelte.ts", () => ({
	editorUiStore: {
		inspectorOpen: false,
		workspaceTitleKey: null,
		openDashboard: vi.fn(),
		openLibrary: h.openLibrary,
		openPages: vi.fn(),
		openWorkBoard: vi.fn(),
		openImportReview: vi.fn(),
		openEditor: h.openEditor,
		openChapterSetup: h.openChapterSetup,
		openNotificationPanel: h.openNotificationPanel,
		toggleInspector: vi.fn(),
	},
}));

vi.mock("$lib/navigation/workspace-navigation.js", () => ({
	queueWorkspaceNavigation: h.queueWorkspaceNavigation,
}));

vi.mock("$lib/i18n", () => ({ setLocale: vi.fn() }));

import { buildWorkspaceCommands } from "$lib/commands/workspace-commands.ts";

function run(id: string): void {
	const cmd = buildWorkspaceCommands().find((c) => c.id === id);
	if (!cmd) throw new Error(`command not found: ${id}`);
	cmd.run();
}

beforeEach(() => {
	vi.clearAllMocks();
	h.projectState.project = null;
	h.projectState.recentProjects = [];
	h.workspacesState.workspaces = [];
	h.workspacesState.currentWorkspaceId = null;
	h.workspacesState.isAdmin = true;
	h.authState.isAuthenticated = true;
});

describe("workspace-commands route sync", () => {
	it("tool commands are absent until a project is open", () => {
		const ids = buildWorkspaceCommands().map((c) => c.id);
		expect(ids).not.toContain("tool-select");
		expect(ids).not.toContain("tool-text");
		expect(ids).not.toContain("tool-brush");
	});

	it("tool commands queue editor navigation (URL stays in sync), then set the tool", () => {
		h.projectState.project = { projectId: "p1", pages: [{}, {}], currentPage: 1 };

		run("tool-text");

		expect(h.openEditor).toHaveBeenCalledTimes(1);
		expect(h.queueWorkspaceNavigation).toHaveBeenCalledWith({
			view: "editor",
			projectId: "p1",
			pageIndex: 1,
		});
		expect(h.setTool).toHaveBeenCalledWith("text");
	});

	it("nav-editor and tool commands share the same editor entry", () => {
		h.projectState.project = { projectId: "p2", pages: [{}], currentPage: 0 };

		run("nav-editor");
		const navCall = h.queueWorkspaceNavigation.mock.calls.at(-1);
		h.queueWorkspaceNavigation.mockClear();

		run("tool-text");
		const toolCall = h.queueWorkspaceNavigation.mock.calls.at(-1);

		expect(toolCall).toEqual(navCall);
		expect(h.setTool).toHaveBeenCalledWith("text");
	});

	it("with no pages, a tool command falls back to library and never selects a tool", () => {
		h.projectState.project = { projectId: "p3", pages: [], currentPage: 0 };

		run("tool-select");

		expect(h.setStatusMsg).toHaveBeenCalledTimes(1);
		expect(h.openLibrary).toHaveBeenCalledTimes(1);
		expect(h.queueWorkspaceNavigation).toHaveBeenCalledWith({ view: "library" });
		expect(h.openEditor).not.toHaveBeenCalled();
		expect(h.setTool).not.toHaveBeenCalled();
	});
});

describe("workspace-commands catalog", () => {
	it("offers create-project to catalog shapers; create-chapter only with an open project", () => {
		expect(buildWorkspaceCommands().map((c) => c.id)).toContain("create-project");
		expect(buildWorkspaceCommands().map((c) => c.id)).not.toContain("create-chapter");

		h.projectState.project = { projectId: "p1", pages: [{}], currentPage: 0 };
		const ids = buildWorkspaceCommands().map((c) => c.id);
		expect(ids).toContain("create-chapter");
	});

	it("hides BOTH create commands from a worker seat (not workspace owner/admin)", () => {
		h.workspacesState.isAdmin = false;
		h.projectState.project = { projectId: "p1", pages: [{}], currentPage: 0 };
		const ids = buildWorkspaceCommands().map((c) => c.id);
		expect(ids).not.toContain("create-project");
		expect(ids).not.toContain("create-chapter");
	});

	it("create-project opens the chapter setup in create mode", () => {
		run("create-project");
		expect(h.openChapterSetup).toHaveBeenCalledWith({ mode: "create" });
	});

	it("notifications command opens the notification panel", () => {
		run("ws-notifications");
		expect(h.openNotificationPanel).toHaveBeenCalledTimes(1);
	});

	it("settings command opens the admin/settings surface", () => {
		run("set-open-settings");
		expect(h.adminOpen).toHaveBeenCalledTimes(1);
	});

	it("offers a switch command for every OTHER workspace, and switches on run", () => {
		h.workspacesState.workspaces = [
			{ workspaceId: "w1", name: "Studio A", planId: "free" },
			{ workspaceId: "w2", name: "Studio B", planId: "pro" },
		];
		h.workspacesState.currentWorkspaceId = "w1";

		const ids = buildWorkspaceCommands().map((c) => c.id);
		expect(ids).toContain("ws-switch-w2");
		expect(ids).not.toContain("ws-switch-w1"); // current workspace excluded

		run("ws-switch-w2");
		expect(h.clearRecentProjects).toHaveBeenCalledTimes(1);
		expect(h.switchTo).toHaveBeenCalledWith("w2");
	});

	it("offers open-project commands for recent chapters (excluding the open one)", () => {
		h.projectState.project = { projectId: "open", pages: [{}], currentPage: 0 };
		h.projectState.recentProjects = [
			{ projectId: "open", name: "Open Chapter", targetLang: "en" },
			{ projectId: "other", name: "Other Chapter", targetLang: "th" },
		];
		const ids = buildWorkspaceCommands().map((c) => c.id);
		expect(ids).toContain("open-project-other");
		expect(ids).not.toContain("open-project-open");
	});

	it("gates sign out behind an authenticated session AND an injected handler", () => {
		const signOut = vi.fn();

		// No handler -> no command even when authed.
		h.authState.isAuthenticated = true;
		expect(buildWorkspaceCommands().map((c) => c.id)).not.toContain("account-signout");

		// Authed + handler -> command present and runs the handler.
		const authed = buildWorkspaceCommands({ signOut });
		const cmd = authed.find((c) => c.id === "account-signout");
		expect(cmd).toBeTruthy();
		cmd?.run();
		expect(signOut).toHaveBeenCalledTimes(1);

		// Signed out -> command absent regardless of handler.
		h.authState.isAuthenticated = false;
		expect(buildWorkspaceCommands({ signOut }).map((c) => c.id)).not.toContain("account-signout");
	});

	it("localises titles through the injected translator", () => {
		const t = vi.fn((_key: string, fallback: string) => `[${fallback}]`);
		const dashboard = buildWorkspaceCommands({ t }).find((c) => c.id === "nav-dashboard");
		expect(dashboard?.title).toBe("[แดชบอร์ด]");
		expect(t).toHaveBeenCalled();
	});
});
