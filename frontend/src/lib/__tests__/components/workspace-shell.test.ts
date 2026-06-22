import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import WorkspaceShell from "$lib/components/WorkspaceShell.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ProjectSummary } from "$lib/api/client.js";
import type { ProjectState } from "$lib/types.js";

const navigation = vi.hoisted(() => ({
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	goto: vi.fn(() => Promise.resolve()),
	routeCallback: null as null | ((navigation: { to: { url: URL } }) => void),
	beforeNavigateCallback: null as null | ((navigation: unknown) => void),
}));

vi.mock("$app/navigation", () => ({
	afterNavigate: vi.fn((callback: (navigation: { to: { url: URL } }) => void) => {
		navigation.routeCallback = callback;
		navigation.afterNavigate(callback);
	}),
	beforeNavigate: vi.fn((callback: (navigation: unknown) => void) => {
		navigation.beforeNavigateCallback = callback;
		navigation.beforeNavigate(callback);
	}),
	goto: navigation.goto,
}));

const now = "2026-05-14T00:00:00.000Z";

function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
	return {
		projectId: "project-th",
		name: "Alpha Chapter 1",
		createdAt: now,
		updatedAt: now,
		targetLang: "th",
		pageCount: 12,
		textLayerCount: 24,
		taskCount: 4,
		openTaskCount: 2,
		reviewTaskCount: 1,
		openCommentCount: 0,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Alpha Chapter 1",
		createdAt: now,
		currentPage: 0,
		targetLang: "th",
		pages: [
			{
				imageId: "image-1",
				imageName: "page-1.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
			{
				imageId: "image-2",
				imageName: "page-2.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	global.ResizeObserver = class {
		observe = vi.fn();
		unobserve = vi.fn();
		disconnect = vi.fn();
	} as unknown as typeof ResizeObserver;
	navigation.afterNavigate.mockClear();
	navigation.beforeNavigate.mockClear();
	navigation.goto.mockClear();
	navigation.routeCallback = null;
	navigation.beforeNavigateCallback = null;
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.editor = null;
	editorStore.hasImage = false;
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
});

describe("WorkspaceShell route sync", () => {
	it("syncs library title and language routes into the workspace store", async () => {
		vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		expect(navigation.routeCallback).toBeTruthy();
		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/library/alpha/languages/en"),
			},
		});

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("library"));
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(editorUiStore.workspaceLanguageKey).toBe("en");
	});

	it("keeps selected library context while syncing project workspace routes", async () => {
		editorUiStore.setWorkspaceTitleKey("alpha");
		editorUiStore.setWorkspaceLanguageKey("en");
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/projects/project-1/pages"),
			},
		});

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("pages"));
		expect(openProject).toHaveBeenCalledWith("project-1", null);
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(editorUiStore.workspaceLanguageKey).toBe("en");
	});

	it("opens explicit editor page routes with the requested page as the initial project page", async () => {
		const openProject = vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({ currentPage: 0 }));
		});
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/projects/project-1/pages/1/editor"),
			},
		});

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(openProject).toHaveBeenCalledWith("project-1", null, { initialPageIndex: 0 });
		expect(goToPage).not.toHaveBeenCalled();
	});

	it("seeds the Flow208 debug project from direct project routes without backend loading", async () => {
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/projects/flow208-project/pages/2/editor"),
			},
		});

		await waitFor(() => expect(projectStore.project?.projectId).toBe("flow208-project"));
		expect(projectStore.project?.currentPage).toBe(1);
		expect(projectStore.project?.pages).toHaveLength(2);
		expect(projectStore.versions[0]?.versionId).toBe("flow208-version-1");
		expect(projectStore.statusMsg).toBe("เปิด Moonlit Courier หน้า 2 แล้ว");
		expect(openProject).not.toHaveBeenCalled();
		expect(goToPage).not.toHaveBeenCalled();
	});

	it("keeps direct Flow208 work routes on their requested workspace views", async () => {
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/projects/flow208-project/work"),
			},
		});

		await waitFor(() => expect(projectStore.project?.projectId).toBe("flow208-project"));
		expect(editorUiStore.workspaceView).toBe("work");
	});

	it("seeds direct Flow208 library chapter routes into the matching library title", async () => {
		const openProject = vi.spyOn(projectStore, "openProject");

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/library/flow208-prototype-journey/chapters/flow208-project"),
			},
		});

		await waitFor(() => expect(projectStore.project?.projectId).toBe("flow208-project"));
		expect(openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.workspaceTitleKey).toBe("flow208-prototype-journey");
		expect(editorUiStore.workspaceLanguageKey).toBe("th");
		expect(projectStore.recentProjects[0]).toMatchObject({
			projectId: "flow208-project",
			name: "Moonlit Courier ตอน 104",
			targetLang: "th",
			pageCount: 2,
		});
	});

	it("seeds direct Flow208 library title routes before recent projects can fall back stale", async () => {
		const openProject = vi.spyOn(projectStore, "openProject");

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/library/flow208-prototype-journey"),
			},
		});

		await waitFor(() => expect(projectStore.project?.projectId).toBe("flow208-project"));
		expect(openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.workspaceTitleKey).toBe("flow208-prototype-journey");
		expect(projectStore.recentProjects[0]).toMatchObject({
			projectId: "flow208-project",
			name: "Moonlit Courier ตอน 104",
		});
	});

	it("seeds direct Flow208 library language routes into the matching language lane", async () => {
		const openProject = vi.spyOn(projectStore, "openProject");

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/library/flow208-prototype-journey/languages/th"),
			},
		});

		await waitFor(() => expect(projectStore.project?.projectId).toBe("flow208-project"));
		expect(openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.workspaceTitleKey).toBe("flow208-prototype-journey");
		expect(editorUiStore.workspaceLanguageKey).toBe("th");
	});

	it("keeps backend-ineligible library chapter routes as local summaries instead of opening backend project endpoints", async () => {
		projectStore.recentProjects = [projectSummary({
			projectId: "project-1",
			name: "Alpha Chapter 1",
			targetLang: "th",
		})];
		const openProject = vi.spyOn(projectStore, "openProject");

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/library/alpha/chapters/project-1"),
			},
		});

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("library"));
		expect(openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(editorUiStore.workspaceLanguageKey).toBeNull();
		expect(projectStore.statusMsg).toBe("โหลดสรุปตอนจากเครื่องแล้ว");
		expect(projectStore.statusMsgCode).toBe("summary_only_loaded");
	});

	it("keeps the selected story/chapter pinned on root workspace routes", async () => {
		editorUiStore.setWorkspaceTitleKey("alpha");
		editorUiStore.setWorkspaceLanguageKey("en");

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/library"),
			},
		});

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("library"));
		// Returning to the overview keeps the last-selected story/chapter pinned until the
		// user picks a new one; the sidebar derives the active highlight from the route, so
		// a persisted title key does not wrongly light up the "open story" slot.
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(editorUiStore.workspaceLanguageKey).toBe("en");
	});

	it("opens the first matching chapter for direct library language routes", async () => {
		projectStore.recentProjects = [
			projectSummary(),
			projectSummary({
				projectId: "project-en",
				name: "Alpha Chapter 2",
				targetLang: "en",
			}),
		];
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/library/alpha/languages/en"),
			},
		});

		await waitFor(() => expect(openProject).toHaveBeenCalledWith("project-en", null));
		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(editorUiStore.workspaceLanguageKey).toBe("en");
	});

	it("waits for in-flight recent projects before opening a direct language route chapter", async () => {
		projectStore.recentProjects = [];
		projectStore.recentProjectsLoading = true;
		const loadRecentProjects = vi.spyOn(projectStore, "loadRecentProjects").mockImplementation(async () => {
			projectStore.recentProjects = [
				projectSummary({
					projectId: "project-en",
					name: "Alpha Chapter 2",
					targetLang: "en",
				}),
			];
			projectStore.recentProjectsLoading = false;
		});
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/library/alpha/languages/en"),
			},
		});

		await waitFor(() => expect(loadRecentProjects).toHaveBeenCalled());
		await waitFor(() => expect(openProject).toHaveBeenCalledWith("project-en", null));
		expect(editorUiStore.workspaceLanguageKey).toBe("en");
	});

	it("routes back to the current editor page when direct page route selection is save-blocked", async () => {
		projectStore.__setProjectForTesting(project());
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(false);
		const loadPage = vi.spyOn(projectStore, "loadPage").mockResolvedValue(undefined);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/projects/project-1/pages/2/editor"),
			},
		});

		await waitFor(() => expect(goToPage).toHaveBeenCalledWith(1, null));
		await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith("/projects/project-1/pages/1/editor", {
			keepFocus: true,
			noScroll: true,
		}));
		expect(projectStore.project?.currentPage).toBe(0);
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("routes back to the current project when direct project open is save-blocked", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "project-1",
			currentPage: 0,
		}));
		editorUiStore.openEditor();
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(false);
		const loadPage = vi.spyOn(projectStore, "loadPage").mockResolvedValue(undefined);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/projects/project-2/work"),
			},
		});

		await waitFor(() => expect(openProject).toHaveBeenCalledWith("project-2", null));
		await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith("/projects/project-1/pages/1/editor", {
			keepFocus: true,
			noScroll: true,
		}));
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(projectStore.project?.projectId).toBe("project-1");
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("labels blocked project switches as the new project not opened while keeping the old work safe", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "project-1",
			currentPage: 0,
		}));
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "generic";
		// Stable `prev_work_present` code drives the "new project not opened" recovery
		// card (was matched on the rendered Thai via startsWith).
		projectStore.setStatus(
			"งานเดิมยังอยู่: ยังไม่เปิดงานใหม่ เพราะบันทึกงานเดิมไม่สำเร็จ (disk is full) กดลองบันทึกอีกครั้งก่อน",
			"prev_work_present",
		);
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		const recovery = screen.getByRole("region", { name: "กู้การบันทึกก่อนเปิดงานใหม่" });
		expect(recovery.textContent).toContain("งานเดิมยังปลอดภัย");
		expect(recovery.textContent).toContain("ยังไม่ได้เปิดงานใหม่");
		expect(recovery.textContent).toContain("งานเดิมยังอยู่: ยังไม่เปิดงานใหม่");

		await fireEvent.click(within(recovery).getByRole("button", { name: "ลองบันทึกงานเดิม" }));

		expect(saveCurrentPage).toHaveBeenCalledWith(editorStore.editor);
	});

	it("routes image-layer brush save recovery to Layers instead of retrying the same failed save", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "project-1",
			currentPage: 0,
		}));
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "brush";
		projectStore.saveErrorMessage = "รอยแปรงยังไม่ถูกบันทึก (quota)";
		editorStore.brushTarget = {
			kind: "image-layer",
			label: "เลเยอร์รูปแก้ไข",
			labelCode: "imageLayer",
			title: "Clean target",
			titleCode: null,
			detail: "ลบเฉพาะเลเยอร์",
			scope: "แก้เฉพาะเลเยอร์นี้",
			impact: "มีผลตอนบันทึก",
			eraseLabelCode: "layerErase",
			restoreLabelCode: "layerRestore",
			restoreHint: "กู้คืนจากต้นฉบับ",
			canBrush: true,
			canRestore: true,
			canClearMask: false,
			tone: "ready",
		};
		editorUiStore.openWorkBoard();
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);
		const setTool = vi.spyOn(editorStore, "setTool").mockImplementation((tool: any) => {
			editorStore.currentTool = tool;
		});

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		expect(screen.getByRole("region", { name: "กู้การบันทึกก่อนเปิดงานใหม่" }).textContent).toContain("รอยแปรงยังไม่บันทึก");
		await fireEvent.click(screen.getByRole("button", { name: "เปิดแผงเลเยอร์" }));

		expect(setTool).toHaveBeenCalledWith("brush");
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(saveCurrentPage).not.toHaveBeenCalled();
	});

	it("routes AI-mask brush save recovery to the Clean brush panel with localized copy", async () => {
		projectStore.__setProjectForTesting(project({
			projectId: "project-1",
			currentPage: 0,
		}));
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "brush";
		projectStore.saveErrorMessage = "รอยแปรงยังไม่ถูกบันทึก (quota)";
		editorStore.brushTarget = {
			kind: "ai-mask",
			label: "ผล AI ทั้งภาพ",
			labelCode: "aiMaskLegacy",
			title: "ผล AI ทั้งภาพ",
			titleCode: null,
			detail: "ลบพื้นที่ผล AI",
			scope: "ผล AI ทั้งภาพ",
			impact: "มีผลตอนบันทึก",
			eraseLabelCode: "aiMaskHide",
			restoreLabelCode: "aiMaskRestore",
			restoreHint: "คืนผล AI ก่อนปัด",
			canBrush: true,
			canRestore: true,
			canClearMask: true,
			tone: "ready",
		};
		editorUiStore.openWorkBoard();
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);
		const setTool = vi.spyOn(editorStore, "setTool").mockImplementation((tool: any) => {
			editorStore.currentTool = tool;
		});

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		const recovery = screen.getByRole("region", { name: "กู้การบันทึกก่อนเปิดงานใหม่" });
		expect(recovery.textContent).toContain("รอยแปรงยังไม่บันทึก");
		expect(recovery.textContent).toContain("ใช้แผงแปรงคลีนด้านขวาเพื่อกลับไปเป้าหมายรอยแปรง");
		await fireEvent.click(screen.getByRole("button", { name: "เปิดแผงแปรงคลีน" }));

		expect(setTool).toHaveBeenCalledWith("brush");
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.rightPanelMode).toBe("ai");
		expect(saveCurrentPage).not.toHaveBeenCalled();
	});

	it("redirects direct zero-page editor routes to setup instead of showing page 1/0", async () => {
		vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "project-empty",
				name: "Empty Draft",
				pages: [],
			}));
			return true;
		});
		const loadPage = vi.spyOn(projectStore, "loadPage").mockResolvedValue(undefined);

		render(WorkspaceShell, {
			props: {
				routeAware: true,
			},
		});

		navigation.routeCallback?.({
			to: {
				url: new URL("http://localhost/projects/project-empty/pages/1/editor"),
			},
		});

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("library"));
		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(projectStore.pageLabel).toBe("ยังไม่มีหน้า");
		expect(projectStore.statusMsg).toBe("ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า");
		expect(loadPage).not.toHaveBeenCalled();
		await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith("/library", {
			keepFocus: true,
			noScroll: true,
		}));
	});
});

describe("ProjectStore page loading", () => {
	it("reuses an in-flight same-page load so text layers are not duplicated", async () => {
		vi.restoreAllMocks();
		projectStore.__resetForTesting();
		const layer = {
			id: "layer-1",
			text: "Line",
			x: 0,
			y: 0,
			w: 100,
			h: 50,
			rotation: 0,
			fontSize: 24,
			alignment: "center" as const,
			index: 0,
		};
		const basePage = project().pages[0];
		projectStore.__setProjectForTesting(project({
			pages: [{
				...basePage,
				textLayers: [layer],
			}],
		}));
		let resolveLoad: (() => void) | undefined;
		const editor = {
			loadImage: vi.fn(() => new Promise<void>((resolve) => {
				resolveLoad = resolve;
			})),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};

		const firstLoad = projectStore.loadPage(0, editor);
		const secondLoad = projectStore.loadPage(0, editor);

		expect(editor.loadImage).toHaveBeenCalledTimes(1);
		resolveLoad?.();
		await Promise.all([firstLoad, secondLoad]);

		expect(editor.addTextLayer).toHaveBeenCalledTimes(1);
		expect(editor.addTextLayer).toHaveBeenCalledWith(layer);
	});

	it("does not reuse an in-flight same-page load for a different editor instance", async () => {
		vi.restoreAllMocks();
		projectStore.__resetForTesting();
		const layer = {
			id: "layer-1",
			text: "Line",
			x: 0,
			y: 0,
			w: 100,
			h: 50,
			rotation: 0,
			fontSize: 24,
			alignment: "center" as const,
			index: 0,
		};
		const basePage = project().pages[0];
		projectStore.__setProjectForTesting(project({
			pages: [{
				...basePage,
				textLayers: [layer],
			}],
		}));
		let resolveFirstLoad: (() => void) | undefined;
		const firstEditor = {
			loadImage: vi.fn(() => new Promise<void>((resolve) => {
				resolveFirstLoad = resolve;
			})),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};
		const secondEditor = {
			loadImage: vi.fn(() => Promise.resolve()),
			addTextLayer: vi.fn(),
			addImageLayer: vi.fn(),
		};

		const firstLoad = projectStore.loadPage(0, firstEditor);
		const secondLoad = projectStore.loadPage(0, secondEditor);

		expect(firstEditor.loadImage).toHaveBeenCalledTimes(1);
		expect(secondEditor.loadImage).not.toHaveBeenCalled();
		resolveFirstLoad?.();
		await Promise.all([firstLoad, secondLoad]);

		expect(firstEditor.addTextLayer).toHaveBeenCalledTimes(1);
		expect(secondEditor.loadImage).toHaveBeenCalledTimes(1);
		expect(secondEditor.addTextLayer).toHaveBeenCalledTimes(1);
		expect(secondEditor.addTextLayer).toHaveBeenCalledWith(layer);
	});
});
