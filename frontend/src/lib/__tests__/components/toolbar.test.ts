import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import Toolbar from "$lib/components/Toolbar.svelte";
import WorkspaceSidebar from "$lib/components/WorkspaceSidebar.svelte";
import { adminStore } from "$lib/stores/admin.svelte.ts";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { shortcutsHelpStore } from "$lib/stores/shortcuts-help.svelte.ts";
import type { Page, ProjectState, WorkflowTask } from "$lib/types.js";

const now = "2026-05-12T12:34:00.000Z";

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function workflowTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "review",
		status: "todo",
		priority: "normal",
		pageIndex: 0,
		title: "Review page",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Toolbar project",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

function resetStores(): void {
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	adminStore.close();
	editorStore.currentTool = "select";
	editorStore.selectedLayer = null;
	editorStore.textLayers = [];
	editorStore.editor = null;
	editorStore.hasImage = false;
	shortcutsHelpStore.closeHelp();
	vi.restoreAllMocks();
}

beforeEach(() => {
	resetStores();
});

describe("Toolbar", () => {
	it("hides project-only Work and Focus nav before a chapter is open", async () => {
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(WorkspaceSidebar);

		expect(screen.queryByRole("button", { name: /บอร์ดงานทีม/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /โหมดโฟกัสย่อย/ })).toBeNull();
		expect(screen.getByRole("button", { name: /^เวิร์กสเปซ$/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดคลังเพื่อเลือกหรือสร้างตอน" })).toBeTruthy();
	});

	it("keeps the first viewport local-first and only loads recent chapters when the picker opens", async () => {
		const loadRecentProjects = vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(Toolbar);

		expect(loadRecentProjects).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));

		expect(loadRecentProjects).toHaveBeenCalledTimes(1);
	});

	it("switches between solo and team work modes from the topbar", async () => {
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(Toolbar);

		expect(screen.getByRole("button", { name: /Solo/ }).getAttribute("aria-pressed")).toBe("true");
		await fireEvent.click(screen.getByRole("button", { name: /Team/ }));

		expect(editorUiStore.workspaceMode).toBe("team");
		expect(localStorage.getItem("manga-editor.workspaceMode")).toBe("team");
		expect(projectStore.statusMsg).toBe("ใช้โหมด Team: เปิดคิวทีม รีวิว QC และงานส่งต่อเต็ม");
		expect(screen.getByRole("button", { name: /Team/ }).getAttribute("aria-pressed")).toBe("true");

		await fireEvent.click(screen.getByRole("button", { name: /Solo/ }));

		expect(editorUiStore.workspaceMode).toBe("solo");
		expect(localStorage.getItem("manga-editor.workspaceMode")).toBe("solo");
	});

	it("opens the shortcut cheat sheet from the toolbar help button", async () => {
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(Toolbar);

		expect(shortcutsHelpStore.open).toBe(false);
		await fireEvent.click(screen.getByRole("button", { name: "เปิดคีย์ลัดทั้งหมด (?)" }));

		expect(shortcutsHelpStore.open).toBe(true);
	});

	it("compacts Solo and Team switching while the editor owns the first viewport", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.setWorkspaceView("editor");
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(Toolbar);

		expect(screen.queryByLabelText("โหมดการทำงาน")).toBeNull();
		const compactMode = screen.getByRole("button", { name: "โหมดการทำงาน: Solo. สลับเป็น Team" });
		expect(compactMode.textContent).toContain("Solo");
		expect(compactMode.textContent).not.toContain("Team");

		await fireEvent.click(compactMode);

		expect(editorUiStore.workspaceMode).toBe("team");
		expect(projectStore.project?.productionMode).toBe("team");
		expect(projectStore.statusMsg).toBe("ใช้ Team workflow: Export ต้องผ่านรีวิวหน้าและ QC ขั้นสุดท้าย");
		expect(screen.getByRole("button", { name: "โหมดการทำงาน: Team. สลับเป็น Solo" }).textContent).toContain("Team");
	});

	// Focus mode was removed: the sidebar no longer exposes a "โฟกัส" subnav entry.
	it("does not expose a Focus subnav entry in the sidebar workflow group", async () => {
		projectStore.__setProjectForTesting(project({
			tasks: [workflowTask()],
		}));
		editorUiStore.setWorkspaceView("editor");
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(WorkspaceSidebar);

		expect(screen.queryByRole("button", { name: /โฟกัสงาน/ })).toBeNull();
		expect(screen.getByRole("button", { name: /บอร์ดงานทีม/ })).toBeTruthy();
	});

	it("opens the dedicated library surface from the topbar", async () => {
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(WorkspaceSidebar);

		await fireEvent.click(screen.getByRole("button", { name: "คลังการ์ตูน" }));

		expect(editorUiStore.workspaceView).toBe("library");
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	it("does not switch to Canvas when recent project open is blocked", async () => {
		projectStore.recentProjects = [{
			projectId: "project-2",
			name: "Blocked Chapter",
			createdAt: now,
			updatedAt: now,
			targetLang: "th",
			pageCount: 1,
			textLayerCount: 0,
		}];
		editorUiStore.openLibrary();
		window.history.replaceState({}, "", "/library");
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "openProject").mockResolvedValue(false);

		render(Toolbar);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));
		await fireEvent.click(screen.getByRole("button", { name: /Blocked Chapter/ }));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-2", null);
		expect(editorUiStore.workspaceView).toBe("library");
		expect(window.location.pathname).toBe("/library");
	});

	it("routes zero-page recent projects to setup instead of a dead editor", async () => {
		projectStore.recentProjects = [{
			projectId: "project-empty",
			name: "Empty Draft",
			createdAt: now,
			updatedAt: now,
			targetLang: "th",
			pageCount: 0,
			textLayerCount: 0,
		}];
		editorUiStore.openDashboard();
		window.history.replaceState({}, "", "/dashboard");
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "project-empty",
				name: "Empty Draft",
				pages: [],
			}));
			projectStore.setStatusMsg("ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า");
			return true;
		});

		render(Toolbar);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด" }));
		await fireEvent.click(screen.getByRole("button", { name: /Empty Draft/ }));

		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(projectStore.statusMsg).toBe("ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า");
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	it("shows the open local chapter in the recent picker trigger when backend recents are empty", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "local-chapter-104",
			name: "Moonlit Courier Chapter 104",
			pages: [page()],
		}));
		projectStore.recentProjects = [];
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(Toolbar);

		const trigger = screen.getByRole("button", { name: "เปิดตอนล่าสุด" });
		expect(trigger.textContent).toContain("Moonlit Courier Chapter 104");
		expect(trigger.textContent).not.toContain("ยังไม่มีล่าสุด");
	});

	it("keeps no-project Canvas clicks on the start decision surface", async () => {
		editorUiStore.setWorkspaceView("dashboard");
		window.history.replaceState({}, "", "/dashboard");
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(WorkspaceSidebar);

		await fireEvent.click(screen.getByRole("button", { name: /^เวิร์กสเปซ$/ }));

		expect(editorUiStore.workspaceView).toBe("dashboard");
		expect(projectStore.statusMsg).toBe("เปิดหรือสร้างตอนก่อนเข้าแก้หน้า");
		await waitFor(() => expect(window.location.pathname).toBe("/dashboard"));
	});

	it("keeps zero-page Canvas clicks on setup instead of editor page 1/0", async () => {
		projectStore.__setProjectForTesting(project({ pages: [] }));
		editorUiStore.openLibrary();
		window.history.replaceState({}, "", "/library");
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(WorkspaceSidebar);

		await fireEvent.click(screen.getByRole("button", { name: /^เวิร์กสเปซ$/ }));

		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(projectStore.statusMsg).toBe("ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า");
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	it("toggles the editor inspector from the topbar", async () => {
		editorUiStore.setWorkspaceView("editor");
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(Toolbar);

		const inspectorButton = screen.getByRole("button", { name: /คุณสมบัติ\s+เปิด/ });
		expect(inspectorButton.getAttribute("aria-pressed")).toBe("true");

		await fireEvent.click(inspectorButton);

		expect(editorUiStore.inspectorOpen).toBe(false);
		expect(screen.getByRole("button", { name: /คุณสมบัติ\s+ซ่อน/ }).getAttribute("aria-pressed")).toBe("false");
	});

	it("opens the admin settings dialog from the topbar", async () => {
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(Toolbar);

		await fireEvent.click(screen.getByRole("button", { name: "ตั้งค่า" }));

		expect(adminStore.showDialog).toBe(true);
		expect(adminStore.saveMessage).toBe("เข้าใช้งานด้วยสิทธิ์ Admin ก่อนแก้การตั้งค่า");
	});

});
