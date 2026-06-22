import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
// Register the locale dictionaries (addMessages + init) so ChapterPacketPanel's $_(...) keys
// resolve to real strings instead of the raw key. test-setup.ts forces the active locale to th.
import "$lib/i18n";
import WorkspaceLibraryView from "$lib/components/WorkspaceLibraryView.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import type { ProjectSummary, WorkspaceRecord } from "$lib/api/client.js";
import type { ProjectState, WorkflowTask } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

const TEST_WORKSPACE_ID = "ws-test-1";

function seedWorkspace(workspaceId = TEST_WORKSPACE_ID): void {
	const record: WorkspaceRecord = {
		workspaceId,
		name: "Test Workspace",
		planId: "free",
		storageIncludedBytes: 0,
		storageExtraBytes: 0,
		createdAt: now,
		updatedAt: now,
		memberRole: "owner",
		memberScope: {},
	};
	workspacesStore.workspaces = [record];
	workspacesStore.currentWorkspaceId = workspaceId;
	workspacesStore.status = "ready";
}

function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
	return {
		projectId: "project-1",
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
		],
		tasks: [
			workflowTask(),
			workflowTask({ id: "page-0-clean", type: "clean", status: "doing", priority: "normal", title: "Clean page 1" }),
			workflowTask({ id: "page-0-typeset", type: "typeset", status: "done", priority: "normal", title: "Typeset page 1" }),
			workflowTask({ id: "page-0-review", type: "review", status: "review", priority: "urgent", title: "Review page 1" }),
		],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		activityLog: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState({}, "", "/library");
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorUiStore.openLibrary();
	editorStore.editor = null;
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	workspacesStore.__resetForTesting();
	// The Library gates its cold load on a RESOLVED current workspace, so seed one
	// for the default test case (cross-workspace gating is exercised explicitly below).
	seedWorkspace();
});

describe("WorkspaceLibraryView", () => {
	it("shows a local-first empty shelf path when no saved titles are available", async () => {
		projectStore.recentProjects = [];
		projectStore.recentProjectsError = "โหลดตอนล่าสุดไม่ได้ (500) เช็ก /api/readyz แล้วลองใหม่";

		render(WorkspaceLibraryView);

		const empty = screen.getByLabelText("คลังงานว่าง");
		expect(within(empty).getByText("ยังไม่มีเรื่องบนเครื่องนี้")).toBeTruthy();
		expect(within(empty).getByText("เริ่มจากเรื่องแรก")).toBeTruthy();
		expect(empty.textContent).not.toContain("/api/readyz");
		expect(empty.textContent).not.toContain("500");
		expect(screen.queryByText("เปลี่ยนเรื่อง / ตอน")).toBeNull();
		expect(screen.queryByText("0 เรื่อง / 0 ตอน")).toBeNull();
		expect(screen.queryByText("เลือกเรื่องก่อนเปิดตอน")).toBeNull();

		await fireEvent.click(within(empty).getByRole("button", { name: "สร้างเรื่อง / ตอน" }));
		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(editorUiStore.chapterSetupContext.mode).toBe("create");
	});

	it("refreshes an empty library shelf in the background scoped to the current workspace", async () => {
		projectStore.recentProjects = [];
		const loadRecentProjects = vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(WorkspaceLibraryView);

		// First cold load (no titles yet): a loading skeleton shows instead of the
		// empty-workspace shelf, so the empty warning never flashes mid-fetch.
		expect(screen.getByLabelText("กำลังโหลดคลังงาน")).toBeTruthy();
		expect(screen.queryByLabelText("คลังงานว่าง")).toBeNull();

		// The cold load is SCOPED to the resolved current workspace id (never unscoped).
		await waitFor(() => expect(loadRecentProjects).toHaveBeenCalledWith({
			background: true,
			silentFailure: true,
			workspaceId: TEST_WORKSPACE_ID,
		}));
		// Once the (still-empty) load resolves, the honest empty shelf takes over and the
		// background refresh never re-skeletons the view.
		await waitFor(() => expect(screen.getByLabelText("คลังงานว่าง")).toBeTruthy());
		expect(screen.queryByLabelText("กำลังโหลดคลังงาน")).toBeNull();
	});

	it("does NOT load the library until a current workspace resolves (no unscoped cross-workspace fetch)", async () => {
		// Simulate a first load with the workspaces store still settling: no resolvable
		// workspace yet. The Library must NOT fire a load (which would otherwise fall
		// through to the legacy unscoped, every-workspace listing).
		workspacesStore.workspaces = [];
		workspacesStore.currentWorkspaceId = null;
		workspacesStore.status = "loading";
		projectStore.recentProjects = [];
		const loadRecentProjects = vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined);

		render(WorkspaceLibraryView);
		await Promise.resolve();
		await Promise.resolve();

		expect(loadRecentProjects).not.toHaveBeenCalled();

		// Once a workspace resolves, the gated load fires — scoped to that workspace.
		seedWorkspace("ws-late");
		await waitFor(() => expect(loadRecentProjects).toHaveBeenCalledWith({
			background: true,
			silentFailure: true,
			workspaceId: "ws-late",
		}));
	});

	it("opens the library as a manga shelf before showing deeper chapter controls", async () => {
		projectStore.recentProjects = [
			projectSummary(),
			projectSummary({
				projectId: "project-2",
				name: "Beta Chapter 4",
				targetLang: "en",
				pageCount: 8,
				openTaskCount: 0,
				reviewTaskCount: 0,
			}),
		];
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);

		render(WorkspaceLibraryView);

		// Redesign: the library opens as a cover-card shelf ("คลังการ์ตูนทั้งหมด")
		// where each manga title is an "เปิดเรื่อง <title>" card; chapter controls
		// only appear once a title is opened.
		const shelf = screen.getByLabelText("คลังการ์ตูนทั้งหมด");
		expect(shelf.textContent).toContain("Alpha");
		expect(shelf.textContent).toContain("ตอน 1");
		expect(shelf.textContent).toContain("Beta");
		expect(shelf.textContent).toContain("ตอน 4");
		expect(shelf.textContent).toContain("TH");
		expect(shelf.textContent).toContain("EN");
		expect(within(shelf).getByRole("button", { name: "เปิดเรื่อง Alpha" })).toBeTruthy();
		expect(within(shelf).getByRole("button", { name: "เปิดเรื่อง Beta" })).toBeTruthy();
		expect(screen.queryByLabelText("เรื่องที่เลือก Beta")).toBeNull();

		await fireEvent.click(within(shelf).getByRole("button", { name: "เปิดเรื่อง Beta" }));

		// Hybrid `[titleKey]` = `<stableStoryId>-<slug>`. These fixtures derive the
		// story id from the family name ("Beta" → "beta"), so the readable slug is
		// appended cosmetically.
		expect(editorUiStore.workspaceTitleKey).toBe("beta-beta");
		await waitFor(() => expect(window.location.pathname).toBe("/library/beta-beta"));
	});

	it("keeps a create and import owner above the shelf when saved titles exist", async () => {
		projectStore.recentProjects = [
			projectSummary(),
			projectSummary({
				projectId: "project-2",
				name: "Beta Chapter 4",
				targetLang: "en",
				pageCount: 8,
			}),
		];

		render(WorkspaceLibraryView);

		const home = screen.getByLabelText("คลังการ์ตูนทั้งหมด");
		const createButton = within(home).getByRole("button", { name: /สร้างเรื่อง \/ Import/ });
		expect(createButton).toBeTruthy();

		await fireEvent.click(createButton);

		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(editorUiStore.chapterSetupContext).toMatchObject({
			mode: "create",
			completionView: "import-review",
		});
		expect(editorUiStore.workspaceTitleKey).toBeNull();
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	it("surfaces the selected manga title with cover, language coverage, and a chapter rail", async () => {
		projectStore.recentProjects = [
			projectSummary(),
			projectSummary({
				projectId: "project-2",
				name: "Alpha Chapter 2",
				targetLang: "en",
				pageCount: 8,
				openTaskCount: 1,
				reviewTaskCount: 0,
			}),
			];
			vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
			vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});
			editorUiStore.openLibrary("alpha");
			// The selected-title stage only leaves library-home mode once the URL is on
			// the title route.
			window.history.replaceState({}, "", "/library/alpha");

			render(WorkspaceLibraryView);

			const stage = screen.getByLabelText("เรื่องที่เลือก Alpha");
			expect(stage.textContent).toContain("Alpha");
			// Per-language coverage receipts (now rendered through the story metric grid).
			expect(stage.textContent).toContain("TH / 1 ตอน / 12 หน้า / 2 งานเปิด / 1 รีวิว");
			expect(stage.textContent).toContain("EN / 1 ตอน / 8 หน้า / 1 งานเปิด");
			expect(within(stage).getByRole("button", { name: "เปิดตอนล่าสุด ตอน 1" })).toBeTruthy();
			expect(screen.queryByLabelText(/แพ็กเกจงานตอน/)).toBeNull();
			expect(screen.getByLabelText("ปกสำรองของ Alpha")).toBeTruthy();
			// Story hub leads with the full chapter board; the per-page pipeline stays on
			// the chapter surface.
			const chapterBoard = screen.getByLabelText("ตอนทั้งหมดของ Alpha");
			expect(chapterBoard.textContent).toContain("ตอน 2");
			expect(stage.textContent).not.toMatch(/\b(Canvas|Focus|Tasks\/QC)\b/);
			expect(stage.querySelector(".title-secondary-actions")).toBeTruthy();
			expect(within(stage).getByText("ทางเลือกเรื่อง")).toBeTruthy();

			// The chapter board rows (ChapterRow) carry their chapter label as the
			// accessible name; opening ตอน 2 drills into its chapter route.
			const chapter2Row = within(chapterBoard)
				.getAllByRole("button")
				.find((button) => button.textContent?.includes("ตอน 2"));
			expect(chapter2Row).toBeTruthy();
			await fireEvent.click(chapter2Row as HTMLElement);

		expect(projectStore.openProject).toHaveBeenCalledWith("project-2", null);
		await waitFor(() => expect(window.location.pathname).toBe("/library/alpha-alpha/chapters/project-2"));
	});

	it("collapses same-numbered chapters across languages into one row with both tracks (#14c)", () => {
		projectStore.recentProjects = [
			projectSummary({ projectId: "ch5-th", name: "Alpha Chapter 5", storyId: "alpha", chapterNumber: "5", targetLang: "th" }),
			projectSummary({ projectId: "ch5-id", name: "Alpha Chapter 5", storyId: "alpha", chapterNumber: "5", targetLang: "id" }),
		];
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");

		render(WorkspaceLibraryView);

		const chapterBoard = screen.getByLabelText("ตอนทั้งหมดของ Alpha");
		// Exactly ONE chapter-5 row (collapsed), not one per language.
		const ch5Rows = within(chapterBoard)
			.getAllByRole("button")
			.filter((button) => button.textContent?.includes("ตอน 5"));
		expect(ch5Rows).toHaveLength(1);
		// …showing BOTH language tracks (th→TH, id→ID).
		expect(ch5Rows[0].textContent).toContain("TH");
		expect(ch5Rows[0].textContent).toContain("ID");
		// A language filter chip row is offered for the multi-language story.
		expect(screen.getByRole("group", { name: "กรองตอนตามภาษา" })).toBeTruthy();
	});

	it("does not crash when two same-language projects share a chapter number (#14c dedup)", () => {
		projectStore.recentProjects = [
			projectSummary({ projectId: "dup-a", name: "Alpha Chapter 7", storyId: "alpha", chapterNumber: "7", targetLang: "th" }),
			projectSummary({ projectId: "dup-b", name: "Alpha Chapter 7", storyId: "alpha", chapterNumber: "7", targetLang: "th" }),
		];
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");

		// Must not throw Svelte's each_key_duplicate (one bar per language).
		render(WorkspaceLibraryView);

		const chapterBoard = screen.getByLabelText("ตอนทั้งหมดของ Alpha");
		const ch7Rows = within(chapterBoard)
			.getAllByRole("button")
			.filter((button) => button.textContent?.includes("ตอน 7"));
		expect(ch7Rows).toHaveLength(1);
	});

	it("opens chapter setup scoped to the selected title instead of restarting story creation", async () => {
		projectStore.recentProjects = [
			projectSummary(),
			projectSummary({
				projectId: "project-2",
				name: "Alpha Chapter 2",
				targetLang: "en",
				pageCount: 8,
				openTaskCount: 1,
				reviewTaskCount: 0,
			}),
		];
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");

			render(WorkspaceLibraryView);

			screen.getByLabelText("เรื่องที่เลือก Alpha");
			await fireEvent.click(screen.getByRole("button", { name: "เพิ่มตอน" }));

		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(editorUiStore.chapterSetupContext).toMatchObject({
			mode: "add-chapter-to-title",
			// The setup context carries the RAW stable story id so the new chapter is
			// persisted under the same key and lands on this story's shelf — not the
			// cosmetic hybrid `<id>-<slug>` used only for the URL.
			titleKey: "alpha",
			titleName: "Alpha",
			targetLang: "en",
		});
		await waitFor(() => expect(window.location.pathname).toBe("/library/alpha-alpha"));
	});

	it("keeps Flow610-style Thai chapter numbers readable and opens the exact chapter", async () => {
		projectStore.recentProjects = [
			projectSummary({
				projectId: "flow610-en",
				name: "Flow610 Real Create - ตอน 104 - Real File Smoke",
				targetLang: "en",
				pageCount: 1,
				textLayerCount: 0,
			}),
			projectSummary({
				projectId: "flow610-th",
				name: "Flow610 Real Create - ตอน 105 - Second File",
				targetLang: "th",
				pageCount: 2,
				textLayerCount: 3,
			}),
		];
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});
		editorUiStore.openLibrary("flow610-real-create");
		window.history.replaceState({}, "", "/library/flow610-real-create/chapters/flow610-en");

		render(WorkspaceLibraryView);

		const stage = screen.getByLabelText("เรื่องที่เลือก Flow610 Real Create");
		expect(stage.textContent).toContain("Flow610 Real Create");
		expect(screen.getByLabelText("รายการตอนของ Flow610 Real Create").textContent).toContain("ตอน 104");
		expect(screen.getByLabelText("รายการตอนของ Flow610 Real Create").textContent).toContain("ตอน 105");
		expect(screen.getByLabelText("รายการตอนของ Flow610 Real Create").textContent).not.toContain("ตอน 104 -");
		expect(screen.getByLabelText("รายการตอนของ Flow610 Real Create").textContent).not.toContain("ตอน 105 -");

		await fireEvent.click(screen.getByRole("button", {
			name: "เลือก ตอน 105 TH รีวิว",
		}));

		expect(projectStore.openProject).toHaveBeenCalledWith("flow610-th", null);
		await waitFor(() => expect(window.location.pathname).toBe("/library/flow610-real-create/chapters/flow610-th"));
	});

	it("does not navigate to a chapter when opening that project is blocked", async () => {
		projectStore.recentProjects = [projectSummary()];
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");
		vi.spyOn(projectStore, "openProject").mockResolvedValue(false);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตอนล่าสุด ตอน 1" }));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-1", null);
		expect(editorStore.refreshTextLayers).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.workspaceEditorEntry).toBeNull();
		expect(window.location.pathname).toBe("/library/alpha");
	});

	it("restores the active library language when chapter open is save-blocked", async () => {
		projectStore.recentProjects = [
			projectSummary({ projectId: "project-1", name: "Alpha Chapter 1", targetLang: "th" }),
			projectSummary({ projectId: "project-2", name: "Alpha Chapter 2", targetLang: "en" }),
		];
		projectStore.__setProjectForTesting(projectState({ projectId: "project-1", targetLang: "th" }));
		editorUiStore.openLibrary("alpha");
		editorUiStore.setWorkspaceLanguageKey("th");
		window.history.replaceState({}, "", "/library/alpha/languages/th");
		vi.spyOn(projectStore, "openProject").mockResolvedValue(false);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceLibraryView);

		// Open the EN chapter (ตอน 2) from the story chapter board while the active
		// language lane is TH; the save-block must restore the TH selection.
		const chapterBoard = screen.getByLabelText("ตอนทั้งหมดของ Alpha");
		const chapter2Row = within(chapterBoard)
			.getAllByRole("button")
			.find((button) => button.textContent?.includes("ตอน 2"));
		expect(chapter2Row).toBeTruthy();
		await fireEvent.click(chapter2Row as HTMLElement);

		expect(projectStore.openProject).toHaveBeenCalledWith("project-2", null);
		expect(editorStore.refreshTextLayers).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(editorUiStore.workspaceLanguageKey).toBe("th");
		expect(window.location.pathname).toBe("/library/alpha/languages/th");
	});

	it("lets users drill from manga title to chapter without leaving the library surface", async () => {
		projectStore.recentProjects = [projectSummary()];
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		// Step 1: from the shelf, opening a title selects it and routes to the title.
		const shelfRender = render(WorkspaceLibraryView);
		await fireEvent.click(screen.getByRole("button", { name: "เปิดเรื่อง Alpha" }));
		// Hybrid `[titleKey]` = `<stableStoryId>-<slug>` ("alpha" → "alpha-alpha").
		expect(editorUiStore.workspaceTitleKey).toBe("alpha-alpha");
		await waitFor(() => expect(window.location.pathname).toBe("/library/alpha-alpha"));
		shelfRender.unmount();

		// Step 2: on the title route, opening the latest chapter drills to the chapter
		// route while staying on the library surface (URL is the surface source of truth).
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");
		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getByRole("button", {
			name: "เปิดตอนล่าสุด ตอน 1",
		}));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-1", null);
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("library"));
		// Drilling from a legacy `/library/alpha` URL resolves the story (back-compat
		// match on the leading id token) and re-keys onto the hybrid `<id>-<slug>`.
		expect(editorUiStore.workspaceTitleKey).toBe("alpha-alpha");
		await waitFor(() => expect(window.location.pathname).toBe("/library/alpha-alpha/chapters/project-1"));
	});

	it("loads the selected chapter page map automatically from a chapter detail route", async () => {
		const loadedProject = projectState({
			pages: [
				projectState().pages[0],
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
		});
		projectStore.recentProjects = [projectSummary({ pageCount: 2, textLayerCount: 0 })];
		vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(loadedProject);
			return undefined;
		});
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});
		editorUiStore.openLibrary("alpha");
		editorUiStore.setWorkspaceLanguageKey("th");

		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		render(WorkspaceLibraryView);

		await waitFor(() => expect(projectStore.openProject).toHaveBeenCalledWith("project-1", null));
		await waitFor(() => expect(screen.getByLabelText("หน้าในตอน")).toBeTruthy());
		expect(screen.queryByRole("button", { name: "โหลดแผนที่หน้า" })).toBeNull();
	});

	it("does not request thumbnails for stale local cover ids", () => {
		projectStore.recentProjects = [projectSummary({
			coverImageId: "cover-test.png",
			coverOriginalName: "cover-test-source.png",
		})];
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");

		const { container } = render(WorkspaceLibraryView);

		expect(screen.getByLabelText("ปกสำรองของ Alpha")).toBeTruthy();
		expect(container.querySelector('img[src*="/thumbnail"]')).toBeNull();
	});

	it("keeps local summary routes from offering project actions that would hit backend-only endpoints", () => {
		projectStore.recentProjects = [projectSummary()];
		projectStore.setStatusMsg("โหลดสรุปตอนจากเครื่องแล้ว", "summary_only_loaded");
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);

		render(WorkspaceLibraryView);

		expect(screen.getAllByText("เปิดตอนต้นทางก่อน").length).toBeGreaterThan(0);
		expect(screen.queryByRole("button", { name: "ตรวจทีละรายการ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ดูคิวรีวิว" })).toBeNull();
		expect(screen.queryByRole("button", { name: "หน้าและ Export" })).toBeNull();
		expect(screen.queryByRole("button", { name: "เปิดตอนล่าสุด ตอน 1" })).toBeNull();
		expect(screen.queryByRole("button", { name: "โหลดงานตอน" })).toBeNull();
		expect(openProject).not.toHaveBeenCalled();
	});

	it("keeps the selected chapter packet header to one primary CTA", () => {
		projectStore.recentProjects = [projectSummary()];
		editorUiStore.openLibrary("alpha");
		editorUiStore.setWorkspaceLanguageKey("th");

		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		const { container } = render(WorkspaceLibraryView);

		screen.getByLabelText("แพ็กเกจงานตอน ตอน 1 TH");
		const stage = screen.getByLabelText("เรื่องที่เลือก Alpha");
		// Redesigned packet header: a single primary CTA ("ไปยังงานต่อไป") with a
		// secondary "เปิดโหมดแก้ไข" and the kebab "ทางเลือกตอน".
		const packetHeaderActions = container.querySelector(".chapter-hero-actions");
		expect(packetHeaderActions).toBeTruthy();
		expect((packetHeaderActions as HTMLElement).querySelectorAll("button.primary")).toHaveLength(1);
		expect(within(packetHeaderActions as HTMLElement).getByRole("button", { name: "ไปยังงานต่อไป" })).toBeTruthy();
		expect(within(packetHeaderActions as HTMLElement).getByRole("button", { name: "เปิดโหมดแก้ไข" })).toBeTruthy();

		// On a chapter route the title stage stops competing with its own primary CTA.
		expect(stage.querySelectorAll(".title-stage-actions > button.primary")).toHaveLength(0);
		expect(within(stage).getByText("ทางเลือกเรื่อง")).toBeTruthy();
	});

	it("explains unknown local summary links and lets users return to the full library", async () => {
		projectStore.recentProjects = [projectSummary()];
		projectStore.setStatusMsg("โหลดสรุปตอนจากเครื่องแล้ว", "summary_only_loaded");
		editorUiStore.openLibrary("missing-title");

		render(WorkspaceLibraryView);

		expect(screen.getByLabelText("สรุปลิงก์ตอน local").textContent).toContain("ลิงก์ตอนนี้ยังไม่พร้อมเปิดงาน");
		expect(screen.getByLabelText("สรุปลิงก์ตอน local").textContent).toContain("เปิดตอนจากโฟลเดอร์ต้นทาง");

		await fireEvent.click(screen.getByRole("button", { name: "ดูคลังงานทั้งหมด" }));

		expect(editorUiStore.workspaceTitleKey).toBeNull();
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	it("explains missing title links without pretending a stale title is selected", async () => {
		projectStore.recentProjects = [projectSummary()];
		editorUiStore.openLibrary("missing-title");

		render(WorkspaceLibraryView);

		expect(screen.getByLabelText("ลิงก์เรื่องที่ไม่พบ").textContent).toContain("ไม่พบเรื่องจากลิงก์นี้");
		expect(screen.queryByLabelText("เรื่องที่เลือก Alpha")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "ดูคลังงานทั้งหมด" }));

		expect(editorUiStore.workspaceTitleKey).toBeNull();
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	it("opens the selected chapter work board from the library surface", async () => {
		projectStore.recentProjects = [projectSummary()];
		editorUiStore.openLibrary("alpha");
		editorUiStore.setWorkspaceLanguageKey("th");
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		render(WorkspaceLibraryView);

		expect(screen.queryByLabelText("เส้นทางภาษา TH")).toBeNull();
		expect(screen.getByLabelText("เรื่องที่เลือก Alpha").classList.contains("single-chapter")).toBe(true);

			await fireEvent.click(screen.getByRole("button", { name: "เปิดโหมดแก้ไข" }));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-1", null);
		expect(editorUiStore.workspaceView).toBe("work");
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/work"));
	});

	it("carries the library chapter context into the editor handoff", async () => {
		projectStore.recentProjects = [projectSummary()];
		editorUiStore.openLibrary("alpha");
		vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(projectState());
		});
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดหน้าแรก" }));

		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.workspaceEditorEntry).toMatchObject({
			source: "library",
			projectId: "project-1",
			titleKey: "alpha",
			title: "Alpha",
			chapterLabel: "ตอน 1",
			language: "th",
			reason: "รีวิว",
		});
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor"));
	});

	it("routes zero-page library chapters to setup instead of editor page 1/0", async () => {
		projectStore.recentProjects = [projectSummary({ pageCount: 0, textLayerCount: 0 })];
		editorUiStore.openLibrary("alpha");
		const openProject = vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(projectState({ pages: [] }));
			return true;
		});

			window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
			render(WorkspaceLibraryView);

			await fireEvent.click(screen.getByRole("button", { name: "เพิ่มรูปหน้า" }));

		expect(openProject).toHaveBeenCalledWith("project-1", null);
		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(editorUiStore.chapterSetupContext).toMatchObject({
			mode: "fill-existing-zero-page",
			projectId: "project-1",
		});
		expect(projectStore.statusMsg).toBe("ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า");
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	it("opens the already loaded library chapter in the editor without re-opening backend endpoints", async () => {
		projectStore.recentProjects = [projectSummary()];
		projectStore.__setProjectForTesting(projectState());
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(false);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		window.history.replaceState({}, "", "/library/route-alias/chapters/project-1");
		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getAllByRole("button", { name: /^เปิดหน้า 1\b/ })[0]);

		expect(openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.workspaceEditorEntry?.projectId).toBe("project-1");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor"));
	});

	it("keeps the route title alias while resolving the loaded chapter reason", async () => {
		projectStore.recentProjects = [projectSummary()];
		projectStore.__setProjectForTesting(projectState());
		editorUiStore.openLibrary("route-alias");
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(false);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		window.history.replaceState({}, "", "/library/route-alias/chapters/project-1");
		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getAllByRole("button", { name: /^เปิดหน้า 1\b/ })[0]);

		expect(openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceEditorEntry).toMatchObject({
			titleKey: "route-alias",
			chapterLabel: "ตอน 1",
			reason: "รีวิว",
		});
	});

	it("lets users choose a title language lane before opening page work", async () => {
		projectStore.recentProjects = [
			projectSummary(),
			projectSummary({
				projectId: "project-2",
				name: "Alpha Chapter 2",
				targetLang: "en",
				pageCount: 8,
				openTaskCount: 1,
				reviewTaskCount: 0,
			}),
		];
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");

		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดภาษา EN ของ Alpha" }));

		expect(projectStore.openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("library");
		// Hybrid `[titleKey]` = `<stableStoryId>-<slug>` ("alpha" → "alpha-alpha").
		expect(editorUiStore.workspaceTitleKey).toBe("alpha-alpha");
		expect(editorUiStore.workspaceLanguageKey).toBe("en");
		await waitFor(() => expect(window.location.pathname).toBe("/library/alpha-alpha/languages/en"));

			await fireEvent.click(screen.getByText("ทางเลือกภาษา EN"));
			await fireEvent.click(screen.getByRole("button", { name: "เปิดหน้าภาษา EN" }));

		expect(projectStore.openProject).toHaveBeenLastCalledWith("project-2", null);
		expect(editorUiStore.workspaceView).toBe("pages");
		expect(editorUiStore.workspaceLanguageKey).toBe("en");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-2/pages"));
	});

	// Focus mode was removed: the selected language work queue now opens the team Work Board.
	it("opens the team work board from the selected language work queue", async () => {
		projectStore.recentProjects = [
			projectSummary(),
			projectSummary({
				projectId: "project-2",
				name: "Alpha Chapter 2",
				targetLang: "en",
				pageCount: 8,
				openTaskCount: 1,
				reviewTaskCount: 0,
			}),
		];
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});
		editorUiStore.openLibrary("alpha");
		window.history.replaceState({}, "", "/library/alpha");

		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดภาษา EN ของ Alpha" }));
		expect(screen.getByLabelText("คิวภาษา EN ของ Alpha").textContent).toContain("ตอน 2");
		expect(screen.getByRole("button", { name: "เปิดงานภาษา EN" }).textContent).toContain("ดูงานเปิด");
		expect(screen.queryByRole("button", { name: "ดูคิวงาน" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดรีวิวงาน ตอน 2 EN" }));

		expect(projectStore.openProject).toHaveBeenLastCalledWith("project-2", null);
		expect(editorUiStore.workspaceView).toBe("work");
		expect(editorUiStore.workspaceLanguageKey).toBe("en");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-2/work"));
	});

	// REGRESSION (wrong-chapter CTA): the language command panel describes the
	// SELECTED chapter (`selectedLanguageChapter`), but its CTAs used to open merely
	// the FIRST chapter in that language. With a non-first chapter selected the button
	// must open the chapter it describes — not chapter 1.
	it("language command CTA opens the SELECTED language chapter, not the first one", async () => {
		projectStore.recentProjects = [
			projectSummary({ projectId: "project-1", name: "Alpha Chapter 1", targetLang: "th" }),
			projectSummary({ projectId: "project-en-2", name: "Alpha Chapter 2", targetLang: "en", pageCount: 8 }),
			projectSummary({ projectId: "project-en-3", name: "Alpha Chapter 3", targetLang: "en", pageCount: 9 }),
		];
		// Open the SECOND EN chapter (ตอน 3 / project-en-3) so it is the selected chapter.
		projectStore.__setProjectForTesting(projectState({ projectId: "project-en-3", targetLang: "en" }));
		editorUiStore.openLibrary("alpha");
		editorUiStore.setWorkspaceLanguageKey("en");
		window.history.replaceState({}, "", "/library/alpha/chapters/project-en-3");
		vi.spyOn(projectStore, "openProject").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceLibraryView);

		// The EN language work queue describes the selected chapter (ตอน 3) and offers
		// the editor CTA. Clicking it must open project-en-3 — the selected chapter —
		// NOT project-en-2 (the first EN chapter).
		const queue = screen.getByLabelText("คิวภาษา EN ของ Alpha");
		const editorCta = within(queue)
			.getAllByRole("button")
			.find((button) => /เปิด|ตรวจ|แก้|หน้า/.test(button.textContent ?? ""));
		expect(editorCta).toBeTruthy();
		await fireEvent.click(editorCta as HTMLElement);

		expect(projectStore.openProject).toHaveBeenLastCalledWith("project-en-3", null);
	});

	it("keeps the current library selection when opening a lane is save-blocked", async () => {
		projectStore.recentProjects = [projectSummary()];
		projectStore.__setProjectForTesting(projectState());
		editorUiStore.openLibrary("alpha");
		editorUiStore.setWorkspaceMode("team");
		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		vi.spyOn(projectStore, "openProject").mockResolvedValue(false);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดรีวิวงาน แปล สำหรับ ตอน 1" }));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-1", null);
		expect(editorStore.refreshTextLayers).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(window.location.pathname).toBe("/library/alpha/chapters/project-1");
	});

	it("shows the loaded chapter workflow packet and opens a lane in focus", async () => {
		projectStore.recentProjects = [projectSummary()];
		projectStore.__setProjectForTesting(projectState());
		editorUiStore.setWorkspaceMode("team");
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		render(WorkspaceLibraryView);

		const packet = screen.getByLabelText("แพ็กเกจงานตอน ตอน 1 TH");
		expect(within(packet).getByLabelText("หน้าในตอน").textContent).toContain("ทำหน้า P1 ต่อ");
		expect(within(packet).getByLabelText("งานถัดไปในตอน").textContent).toContain("3 งานเปิด");
		expect(within(packet).getByLabelText("แผนที่หน้าตอน").textContent).toContain("1");
		// Redesigned production metric grid: หน้า / เลเยอร์ข้อความ / งานเปิด / คอมเมนต์.
		expect(packet.textContent).toContain("หน้า");
		expect(packet.textContent).toContain("เลเยอร์ข้อความ");
		expect(packet.textContent).toContain("งานเปิด");
		expect(packet.textContent).toContain("คอมเมนต์");
		expect(packet.textContent).toContain("ส่งต่อขั้นงาน");
		expect(packet.textContent).toContain("Translate");
		expect(packet.textContent).toContain("1 งานเปิด");
		expect(packet.textContent).toContain("3 ขั้นงานที่ใช้งาน / 1/4 เสร็จ");
		expect(packet.textContent).toContain("รีวิวต่อ");
		expect(packet.textContent).toContain("คอมเมนต์เปิด");
		expect(packet.textContent).toContain("AI/QC ต้องเช็ก");
		expect(packet.textContent).not.toContain("AI output");
		expect(packet.textContent).toContain("คิวตรวจ");
		expect(packet.textContent).toContain("จุดติดขัด");

		await fireEvent.click(screen.getByRole("button", { name: "เปิดรีวิวงาน แปล สำหรับ ตอน 1" }));

		// Focus mode was removed: chapter lane actions now open the team Work Board.
		expect(projectStore.openProject).toHaveBeenLastCalledWith("project-1", null);
		expect(editorUiStore.workspaceView).toBe("work");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/work"));
	});

	it("copies a loaded chapter lane work-board link without opening the lane", async () => {
		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		projectStore.recentProjects = [projectSummary()];
		projectStore.__setProjectForTesting(projectState());
		editorUiStore.setWorkspaceMode("team");
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});

		render(WorkspaceLibraryView);

		const packet = screen.getByLabelText("แพ็กเกจงานตอน ตอน 1 TH");
		await fireEvent.click(within(packet).getByRole("button", { name: "คัดลอกลิงก์ แปล สำหรับ ตอน 1" }));

		// Focus mode was removed: the copied chapter-lane link now points at the Work Board.
		expect(writeText).toHaveBeenCalledWith("http://localhost:3000/projects/project-1/work");
		expect(projectStore.statusMsg).toBe("คัดลอกลิงก์รีวิวงานแล้ว");
		expect(openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("library");
		expect(window.location.pathname).toBe("/library/alpha/chapters/project-1");
	});

	it("resolves a direct debug title route through the loaded project instead of showing a false missing-title state", () => {
		projectStore.recentProjects = [
			projectSummary({
				projectId: "flow208-project",
				name: "Moonlit Courier Chapter 104",
			}),
		];
		projectStore.__setProjectForTesting(projectState({
			projectId: "flow208-project",
			name: "Moonlit Courier Chapter 104",
		}));
		editorUiStore.openLibrary("flow208-prototype-journey");
		window.history.replaceState({}, "", "/library/flow208-prototype-journey");

		render(WorkspaceLibraryView);

		expect(screen.queryByLabelText("ลิงก์เรื่องที่ไม่พบ")).toBeNull();
		expect(screen.getByLabelText("เรื่องที่เลือก Moonlit Courier").textContent).toContain("ตอน 104");
	});

	// QUARANTINED: the workspace redesign removed the per-chapter "setup card" grid
	// from the library surface (the chapter packet now leads with the production metric
	// grid + pipeline + workflow lanes), so the "Import ข้อความ เลเยอร์ข้อความ สำหรับ …"
	// import entry button no longer renders here. The import ROUTING itself
	// (openChapterImport → workspaceView "import" → /projects/:id/import) is unchanged
	// and is still surfaced/covered from the Pages surface (see workspace-pages-view
	// "opens the import review route from the pages surface"). Re-enable if a library
	// import entry point is reintroduced.
	it.skip("routes chapter setup text import into the wide import review surface", async () => {
		projectStore.recentProjects = [projectSummary()];
		projectStore.__setProjectForTesting(projectState());
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceLibraryView);

		await fireEvent.click(screen.getByRole("button", { name: "Import ข้อความ เลเยอร์ข้อความ สำหรับ ตอน 1" }));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-1", null);
		expect(editorUiStore.workspaceView).toBe("import");
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(editorUiStore.workspaceLanguageKey).toBe("th");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/import"));
	});

	// Focus mode was removed: chapter review follow-through commands now open the
	// selected task in the editor's contextual Work panel.
	it("routes chapter review follow-through commands into the editor work panel", async () => {
		projectStore.recentProjects = [projectSummary()];
		projectStore.__setProjectForTesting(projectState());
		vi.spyOn(projectStore, "openProject").mockResolvedValue(undefined);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		render(WorkspaceLibraryView);

		const packet = screen.getByLabelText("แพ็กเกจงานตอน ตอน 1 TH");
		expect(within(packet).getByRole("button", { name: "เปิดหน้า 1 คิวตรวจ สำหรับ ตอน 1" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดรีวิวงาน คิวตรวจ สำหรับ ตอน 1" }));

		expect(projectStore.selectedWorkflowTaskId).toBe("page-0-review");
		expect(projectStore.openProject).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.rightPanelMode).toBe("work");
		await waitFor(() => expect(window.location.pathname).toMatch(/\/projects\/project-1\/(editor|pages\/\d+\/editor)/));
	});

	it("renders an empty state setup prompt when active chapter is loaded with zero pages", async () => {
		projectStore.recentProjects = [projectSummary({ pageCount: 0, textLayerCount: 0 })];
		projectStore.__setProjectForTesting(projectState({ projectId: "project-1", pages: [] }));
		editorUiStore.openLibrary("alpha");
		const openProject = vi.spyOn(projectStore, "openProject").mockResolvedValue(true);

		window.history.replaceState({}, "", "/library/alpha/chapters/project-1");
		render(WorkspaceLibraryView);

		const emptyPrompt = screen.getByLabelText("สถานะหน้าของ ตอน 1");
		expect(emptyPrompt.textContent).toContain("ไม่มีรูปหน้าในตอน");
		expect(emptyPrompt.textContent).toContain("ยังไม่มีรูปหน้าในตอนนี้ เพิ่มรูปหน้าและไทป์เซ็ตเพื่อเริ่มทำงาน");

		const setupBtn = within(emptyPrompt).getByRole("button", { name: "เพิ่มรูปหน้าเพื่อเริ่มงาน" });
		expect(setupBtn).toBeTruthy();

		await fireEvent.click(setupBtn);

		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(editorUiStore.chapterSetupContext).toMatchObject({
			mode: "fill-existing-zero-page",
			projectId: "project-1",
		});
		expect(projectStore.statusMsg).toBe("ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า");
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});
});
