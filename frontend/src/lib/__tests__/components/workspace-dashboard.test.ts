import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import "$lib/i18n";
import WorkspaceDashboard from "$lib/components/WorkspaceDashboard.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { usageStore } from "$lib/stores/usage.svelte.ts";
import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
import type { ProjectSummary, UsageDashboard, WorkspaceHomeAggregate, WorkspaceHomeTask } from "$lib/api/client.js";
import type { ProjectState, WorkspaceFeedItem } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

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
		],
		tasks: [
			{
				id: "task-1",
				type: "review",
				status: "review",
				priority: "high",
				pageIndex: 0,
				title: "Review page 1",
				createdAt: now,
				updatedAt: now,
			},
		],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

function feedItem(overrides: Partial<WorkspaceFeedItem> = {}): WorkspaceFeedItem {
	return {
		id: "feed-1",
		kind: "task",
		sourceId: "task-1",
		pageIndex: 1,
		title: "Needs page 2",
		detail: "Blocked page switch should keep the dashboard stable.",
		createdAt: now,
		severity: "warning",
		...overrides,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	usageStore.__resetForTesting();
	workspaceHomeStore.__resetForTesting();
	workspacesStore.__resetForTesting();
	window.history.replaceState({}, "", "/dashboard");
	// Default posture: a workspace IS resolved (the common case for a signed-in user
	// on the dashboard), so the first-run create CTA is enabled/labelled "create".
	// Tests that exercise the unresolved first-run gate clear this explicitly.
	workspacesStore.workspaces = [
		{ workspaceId: "ws-1", name: "WS", planId: "free", memberRole: "owner", memberScope: {} } as any,
	];
	workspacesStore.currentWorkspaceId = "ws-1";
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	editorStore.editor = null;
	editorStore.hasImage = false;
});

function homeAggregate(overrides: Partial<WorkspaceHomeAggregate> = {}): WorkspaceHomeAggregate {
	return {
		workspaceId: "ws-1",
		generatedAt: now,
		myTasks: [],
		attention: [],
		activity: [],
		aiJobs: [],
		pipelineByStage: [
			{ stage: "translate", todo: 0, doing: 0, review: 0, done: 0, total: 0, open: 0 },
			{ stage: "clean", todo: 0, doing: 0, review: 0, done: 0, total: 0, open: 0 },
			{ stage: "typeset", todo: 0, doing: 0, review: 0, done: 0, total: 0, open: 0 },
			{ stage: "review", todo: 0, doing: 0, review: 0, done: 0, total: 0, open: 0 },
		],
		dueToday: [],
		counts: { projects: 0, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		targetLangs: [],
		recentProject: null,
		...overrides,
	};
}

function homeRecentProject(
	overrides: Partial<NonNullable<WorkspaceHomeAggregate["recentProject"]>> = {},
): NonNullable<WorkspaceHomeAggregate["recentProject"]> {
	return {
		projectId: "agg-recent",
		projectName: "Aggregate Recent Story",
		storyTitle: "Aggregate Recent Story",
		chapterLabel: "ตอน 7",
		sourceLang: "ja",
		targetLang: "th",
		pageCount: 18,
		updatedAt: now,
		progressPercent: 42,
		hasProgress: true,
		...overrides,
	};
}

function homeTask(overrides: Partial<WorkspaceHomeTask> = {}): WorkspaceHomeTask {
	return {
		id: "agg-task-1",
		projectId: "agg-project",
		projectName: "Aggregate Story",
		type: "translate",
		status: "todo",
		priority: "high",
		title: "Aggregate task",
		pageIndex: 0,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function homeFeedItem(
	overrides: Partial<WorkspaceHomeAggregate["attention"][number]> = {},
): WorkspaceHomeAggregate["attention"][number] {
	return {
		...feedItem({ title: "Attention blocker", detail: "High / todo" }),
		projectId: "attention-project",
		projectName: "Attention Story",
		storyId: "attention-story",
		storyTitle: "Attention Story",
		chapterLabel: "ตอน 2",
		targetLang: "th",
		...overrides,
	};
}

function homeAiJob(
	overrides: Partial<WorkspaceHomeAggregate["aiJobs"][number]> = {},
): WorkspaceHomeAggregate["aiJobs"][number] {
	return {
		projectId: "ai-project",
		projectName: "AI Story",
		storyId: "ai-story",
		storyTitle: "AI Story",
		chapterLabel: "ตอน 3",
		targetLang: "th",
		id: "ai-project:marker-1",
		markerId: "marker-1",
		jobId: "job-1",
		pageIndex: 0,
		status: "needs_review",
		tier: "clean-pro",
		updatedAt: now,
		...overrides,
	};
}

function usageWindow(): UsageDashboard["totals"]["monthly"] {
	return {
		periodKey: "2026-05",
		aiCapturedThb: 0,
		aiActiveReservedThb: 0,
		aiCommittedThb: 0,
		uploadBytes: 0,
		exportBytes: 0,
		moderationImages: 0,
		limits: { aiCreditThb: 100, uploadBytes: 1_000_000, exportBytes: 1_000_000 },
		remaining: { aiCreditThb: 100, uploadBytes: 1_000_000, exportBytes: 1_000_000 },
	};
}

function usageDashboard(): UsageDashboard {
	return {
		workspaceId: "ws-1",
		scope: "filesystem",
		enforced: false,
		plan: { id: "free", name: "Free", monthlyAiCredits: 100, includedStorageBytes: 1_000_000, maxSeatsIncluded: 1 },
		projectIds: ["project-1"],
		projectCount: 1,
		totals: {
			daily: usageWindow(),
			monthly: usageWindow(),
			eventCount: 0,
			eventCountCapped: false,
		},
		storage: {
			usedBytes: 128_000,
			originalBytes: 128_000,
			derivativeBytes: 0,
			exportArtifactBytes: 0,
			reservedBytes: 0,
			projectedBytes: 128_000,
			limitBytes: 1_000_000,
			includedBytes: 1_000_000,
			extraBytes: 0,
			remainingBytes: 872_000,
			percentUsed: 12.8,
			enforced: true,
		},
		egress: {
			windowMs: 86_400_000,
			totalRequests: 0,
			totalBytes: 0,
			limitBytes: 1_000_000,
			remainingBytes: 1_000_000,
			enforced: false,
			perProjectEnforced: false,
			projects: [],
		},
		memberAttribution: "unattributed",
		members: {
			count: 0,
			breakdown: [],
			unattributed: { aiCommittedThb: 0, uploadBytes: 0, exportBytes: 0 },
		},
	};
}

describe("WorkspaceDashboard", () => {
	// The dashboard's library affordances ("เปิดทั้งหมด" / "ดูทั้งหมด" / storage
	// upgrade) all open the dedicated workspace library surface (openLibrary). This
	// is workspace-scoped and never the single open chapter's pages. (Migrated from
	// the removed offscreen "เปิดคลังงาน" console button to the visible recent-series
	// "เปิดทั้งหมด" affordance.)
	it("opens dashboard library overview into the dedicated library surface", async () => {
		projectStore.recentProjects = [projectSummary()];

		render(WorkspaceDashboard);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดทั้งหมด" }));

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("library"));
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	// Migrated from the removed offscreen "เริ่มตรงนี้" / "ตอนอื่นล่าสุด" console to
	// the VISIBLE recent-series rail. The rail lists every recent project as its own
	// quick-open card — same-name chapters are NOT deduped and the latest is not
	// duplicated (it appears exactly once, like every other entry).
	it("shows recent chapters without hiding same-name projects or duplicating the latest owner", () => {
		projectStore.recentProjects = [
			projectSummary({ projectId: "latest", name: "Alpha Chapter 1" }),
			projectSummary({ projectId: "duplicate", name: "Alpha Chapter 1" }),
			projectSummary({ projectId: "other", name: "Beta Chapter 2" }),
		];

		render(WorkspaceDashboard);

		const rail = within(screen.getByTestId("recent-series"));
		// All three projects render as distinct rail buttons (same-name kept, latest once).
		expect(rail.getAllByRole("button", { name: /Alpha/ })).toHaveLength(2);
		expect(rail.getByRole("button", { name: /Beta/ })).toBeTruthy();
		expect(rail.getAllByRole("button")).toHaveLength(3);
	});

	// Migrated from the removed offscreen "ทำต่อจากล่าสุด" start-path button to the
	// VISIBLE recent-series rail card. Opening a recent project with pages really
	// continues into the editor (openRecentProject → editor view + /editor URL).
	it("opens recent work directly into the editor so continue really continues", async () => {
		projectStore.recentProjects = [projectSummary()];
		vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project());
			return true;
		});
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceDashboard);

		const rail = within(screen.getByTestId("recent-series"));
		await fireEvent.click(rail.getByRole("button", { name: /Alpha/ }));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-1", null);
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.workspaceEditorEntry?.reason).toBe("ทำต่อจากล่าสุด");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor"));
	});

	// Migrated from the removed offscreen "เติมรูปหน้าเพื่อเริ่มตอนล่าสุด" start-path
	// button to the VISIBLE recent-series rail card. A zero-page recent project must
	// route to setup (library + chapter-setup), never into a dead editor.
	it("opens zero-page recent work into setup instead of a dead editor", async () => {
		projectStore.recentProjects = [projectSummary({ projectId: "project-empty", name: "Empty Draft", pageCount: 0 })];
		vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({
				projectId: "project-empty",
				name: "Empty Draft",
				pages: [],
			}));
			return true;
		});
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceDashboard);

		const rail = within(screen.getByTestId("recent-series"));
		await fireEvent.click(rail.getByRole("button", { name: /Empty Draft/ }));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-empty", null);
		expect(editorStore.refreshTextLayers).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.chapterSetupOpen).toBe(true);
		expect(projectStore.statusMsg).toBe("ตอนนี้ยังไม่มีหน้า เลือกรูปหน้าก่อนเข้าแก้หน้า");
		await waitFor(() => expect(window.location.pathname).toBe("/library"));
	});

	// Migrated from the removed offscreen "ทำต่อจากล่าสุด" start-path button to the
	// VISIBLE recent-series rail card. A save-blocked open (openProject → false) must
	// keep the dashboard surface and URL unchanged and never refresh editor layers.
	it("does not change dashboard surface or URL when recent project open is blocked", async () => {
		projectStore.recentProjects = [projectSummary()];
		editorUiStore.openDashboard();
		window.history.replaceState({}, "", "/dashboard");
		vi.spyOn(projectStore, "openProject").mockResolvedValue(false);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceDashboard);

		const rail = within(screen.getByTestId("recent-series"));
		await fireEvent.click(rail.getByRole("button", { name: /Alpha/ }));

		expect(projectStore.openProject).toHaveBeenCalledWith("project-1", null);
		expect(editorStore.refreshTextLayers).not.toHaveBeenCalled();
		expect(editorUiStore.workspaceView).toBe("dashboard");
		expect(window.location.pathname).toBe("/dashboard");
	});

	// Focus mode was removed: the VISIBLE quiet-metrics "ใกล้ครบกำหนด" tile now opens
	// the chapter Work Board (the workspace-first task-lane surface) instead.
	it("opens the team work board from the dashboard due-soon metric tile", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const metrics = within(screen.getByTestId("quiet-metrics-row"));
		await fireEvent.click(metrics.getByRole("button", { name: /ใกล้ครบกำหนด/ }));

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("work"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/work"));
	});

	it("does NOT render the open chapter's workspaceFeed items in the dashboard (aggregate-only)", async () => {
		// KEYSTONE: the dashboard's attention/activity widgets are decoupled from the
		// open chapter. Even with a chapter open and a populated per-chapter feed, the
		// aggregate (loaded, empty) drives the widgets — the chapter's feed item must
		// NOT leak in, so the dashboard does not change when a chapter opens.
		window.history.replaceState({}, "", "/dashboard");
		projectStore.__setProjectForTesting(project({
			pages: [
				{ imageId: "image-1", imageName: "page-1.png", textLayers: [], pendingAiJobs: [], coverRect: null },
				{ imageId: "image-2", imageName: "page-2.png", textLayers: [], pendingAiJobs: [], coverRect: null },
			],
		}));
		projectStore.workspaceFeed = [feedItem()];
		workspaceHomeStore.aggregate = homeAggregate();
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		// The per-chapter feed item ("Needs page 2") never renders as a dashboard row.
		expect(screen.queryByRole("button", { name: /Needs page 2/ })).toBeNull();
		// The attention widget shows the honest aggregate empty state instead.
		expect(screen.getByTestId("attention-empty")).toBeTruthy();
		expect(window.location.pathname).toBe("/dashboard");
	});

	it("does NOT surface the open chapter's stale feed items in the dashboard activity (aggregate-only)", async () => {
		// Previously the dashboard rendered the open chapter's review/comment feed and
		// routed clicks through per-chapter repair paths. The keystone decouples the
		// dashboard from the open chapter: a populated per-chapter feed (review +
		// comment) must NOT render in the aggregate-driven attention/activity widgets.
		window.history.replaceState({}, "", "/dashboard");
		projectStore.__setProjectForTesting(project({
			pages: [{ imageId: "image-1", imageName: "page-1.png", textLayers: [], pendingAiJobs: [], coverRect: null }],
			tasks: [],
		}));
		projectStore.workspaceFeed = [
			feedItem({ id: "review-feed", kind: "review_decision", sourceId: "r-1", pageIndex: 4, title: "Changes requested" }),
			feedItem({ id: "comment-feed", kind: "comment", sourceId: "c-1", pageIndex: 4, title: "Open comment" }),
		];
		workspaceHomeStore.aggregate = homeAggregate();
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		// Neither per-chapter feed item renders as a dashboard activity/attention row.
		expect(screen.queryByRole("button", { name: /ขอแก้ไข/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /อ่านคอมเมนต์/ })).toBeNull();
		// Attention shows the honest aggregate empty state, never the chapter's feed.
		expect(screen.getByTestId("attention-empty")).toBeTruthy();
	});
});

// KEYSTONE (BUG 3): the dashboard's My-Work / attention / activity / AI-jobs
// widgets render from the workspace-home AGGREGATE only — never from projectStore
// (the open chapter). They show honest loading / error / empty states and do NOT
// change when a chapter opens mid-session.
describe("WorkspaceDashboard — aggregate-only (no projectStore fallback)", () => {
	it("shows a loading state for My-Work while the aggregate loads — NOT the open chapter's tasks", () => {
		// A chapter IS open with its own tasks, but the aggregate is still loading.
		projectStore.__setProjectForTesting(project());
		workspaceHomeStore.aggregate = null;
		workspaceHomeStore.loading = true;
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		expect(myTasks.getByTestId("my-tasks-loading")).toBeTruthy();
		// The open chapter's task title must NOT leak into My-Work.
		expect(myTasks.queryByText(/Review page 1/)).toBeNull();
	});

	it("shows an honest error state when the aggregate failed to load", () => {
		projectStore.__setProjectForTesting(project());
		workspaceHomeStore.aggregate = null;
		workspaceHomeStore.loading = false;
		workspaceHomeStore.error = "เครือข่ายล่ม";
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		const err = myTasks.getByTestId("my-tasks-error");
		expect(err).toBeTruthy();
		expect(err.textContent).toContain("เครือข่ายล่ม");
		expect(myTasks.queryByText(/Review page 1/)).toBeNull();
	});

	it("shows a real empty state when the aggregate loaded with no work", () => {
		projectStore.__setProjectForTesting(project());
		workspaceHomeStore.aggregate = homeAggregate();
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		expect(myTasks.getByTestId("my-tasks-empty")).toBeTruthy();
		expect(myTasks.queryByText(/Review page 1/)).toBeNull();
	});

	it("renders My-Work from the aggregate and does NOT change when a chapter opens mid-session", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			myTasks: [homeTask({ id: "agg-1", title: "Aggregate translate task", projectName: "Story Z" })],
			counts: { projects: 1, myOpenTasks: 1, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 1 },
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = () => within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		expect(myTasks().getByText(/Aggregate translate task/)).toBeTruthy();

		// Open a chapter mid-session: the inspector may change, but the aggregate-driven
		// My-Work panel must be UNCHANGED — still the aggregate task, never the chapter's.
		projectStore.__setProjectForTesting(project());
		await waitFor(() => expect(myTasks().getByText(/Aggregate translate task/)).toBeTruthy());
		expect(myTasks().queryByText(/Review page 1/)).toBeNull();
	});

	// REGRESSION (dead nav): a My-Work row is a CROSS-PROJECT aggregate item. With NO
	// chapter open, clicking it used to be a silent no-op (the work-board opener
	// returned early when no project was loaded). It must open the ROW'S project and
	// surface its work board — not do nothing.
	it("opens the My-Work row's own project + work board when no chapter is open", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			myTasks: [homeTask({ id: "agg-1", projectId: "agg-project-9", title: "Aggregate translate task" })],
			counts: { projects: 1, myOpenTasks: 1, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 1 },
		});
		const openSpy = vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({ projectId: "agg-project-9" }));
			return true;
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		await fireEvent.click(myTasks.getByText(/Aggregate translate task/));

		expect(openSpy).toHaveBeenCalledWith("agg-project-9", null);
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("work"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/agg-project-9/work"));
	});

	// REGRESSION (wrong target): clicking a My-Work row whose project is ALREADY open
	// must NOT re-open the project; it goes straight to the work board for that same
	// chapter.
	it("opens the work board directly when the My-Work row's project is already open", async () => {
		projectStore.__setProjectForTesting(project({ projectId: "agg-project-9" }));
		workspaceHomeStore.aggregate = homeAggregate({
			myTasks: [homeTask({ id: "agg-1", projectId: "agg-project-9", title: "Aggregate translate task" })],
			counts: { projects: 1, myOpenTasks: 1, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 1 },
		});
		const openSpy = vi.spyOn(projectStore, "openProject");
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		await fireEvent.click(myTasks.getByText(/Aggregate translate task/));

		expect(openSpy).not.toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("work"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/agg-project-9/work"));
	});

	it("navigates the My-Work footer to the workspace tasks page", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({ projectId: "recent-fallback" }),
			myTasks: [homeTask({ id: "agg-1", projectId: "task-project", title: "Task project row" })],
			counts: { projects: 1, myOpenTasks: 1, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 1 },
		});
		const openSpy = vi.spyOn(projectStore, "openProject");
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		await fireEvent.click(myTasks.getByRole("button", { name: /ดูงานทั้งหมด/ }));

		expect(openSpy).not.toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("tasks"));
		await waitFor(() => expect(window.location.pathname).toBe("/tasks"));
	});

	it("keeps the My-Work footer available when the workspace has no project target", async () => {
		workspaceHomeStore.aggregate = homeAggregate();
		const openSpy = vi.spyOn(projectStore, "openProject");
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		await fireEvent.click(myTasks.getByRole("button", { name: /ดูงานทั้งหมด/ }));

		expect(openSpy).not.toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("tasks"));
		await waitFor(() => expect(window.location.pathname).toBe("/tasks"));
	});

	it("opens attention rows project-first and routes the inbox footer to the inbox page", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({ projectId: "recent-fallback" }),
			attention: [homeFeedItem({ id: "attention-1", projectId: "attention-project", title: "Attention blocker" })],
			counts: { projects: 1, myOpenTasks: 0, attention: 1, aiJobs: 0, dueToday: 0, overdue: 1, openTasks: 1 },
		});
		const openSpy = vi.spyOn(projectStore, "openProject").mockImplementation(async (projectId: string) => {
			projectStore.__setProjectForTesting(project({ projectId }));
			return true;
		});
		editorUiStore.openDashboard();

		const { unmount } = render(WorkspaceDashboard);
		const attention = within(document.querySelector('[data-tour="needs-attention"]') as HTMLElement);

		await fireEvent.click(attention.getByRole("button", { name: /Attention blocker/ }));
		expect(openSpy).toHaveBeenCalledWith("attention-project", null);
		await waitFor(() => expect(window.location.pathname).toBe("/projects/attention-project/work"));

		unmount();
		projectStore.__setProjectForTesting(null);
		editorUiStore.openDashboard();
		window.history.replaceState({}, "", "/dashboard");
		openSpy.mockClear();
		render(WorkspaceDashboard);
		const rerenderedAttention = within(document.querySelector('[data-tour="needs-attention"]') as HTMLElement);

		await fireEvent.click(rerenderedAttention.getByRole("button", { name: /เปิดกล่องข้อความ/ }));
		expect(openSpy).not.toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("inbox"));
		await waitFor(() => expect(window.location.pathname).toBe("/inbox"));
	});

	it("opens the AI jobs project before the AI jobs view-all work board", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({ projectId: "recent-fallback" }),
			aiJobs: [homeAiJob({ id: "ai-project:marker-1", projectId: "ai-project" })],
			counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 1, dueToday: 0, overdue: 0, openTasks: 1 },
		});
		const openSpy = vi.spyOn(projectStore, "openProject").mockImplementation(async (projectId: string) => {
			projectStore.__setProjectForTesting(project({ projectId }));
			return true;
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const aiJobs = within(screen.getByText("งาน AI").closest("details") as HTMLElement);
		await fireEvent.click(aiJobs.getByRole("button", { name: "ดูทั้งหมด" }));

		expect(openSpy).toHaveBeenCalledWith("ai-project", null);
		await waitFor(() => expect(window.location.pathname).toBe("/projects/ai-project/work"));
	});

	it("keeps empty work-board widgets project-first while the inbox footer opens the inbox page", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({ projectId: "recent-fallback" }),
			counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		});
		const openSpy = vi.spyOn(projectStore, "openProject").mockImplementation(async (projectId: string) => {
			projectStore.__setProjectForTesting(project({ projectId }));
			return true;
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const attention = within(document.querySelector('[data-tour="needs-attention"]') as HTMLElement);
		await fireEvent.click(attention.getByRole("button", { name: /เปิดกล่องข้อความ/ }));

		expect(openSpy).not.toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("inbox"));
		await waitFor(() => expect(window.location.pathname).toBe("/inbox"));
	});

	it("keeps only project-scoped footer controls unavailable when the workspace has no project target", () => {
		workspaceHomeStore.aggregate = homeAggregate();
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const myTasks = within(document.querySelector('[data-tour="my-tasks"]') as HTMLElement);
		const attention = within(document.querySelector('[data-tour="needs-attention"]') as HTMLElement);
		const aiJobs = within(screen.getByText("งาน AI").closest("details") as HTMLElement);

		const viewAllTasks = myTasks.getByRole("button", { name: /ดูงานทั้งหมด/ }) as HTMLButtonElement;
		const openInbox = attention.getByRole("button", { name: /เปิดกล่องข้อความ/ }) as HTMLButtonElement;
		const viewAllAiJobs = aiJobs.getByRole("button", { name: "ดูทั้งหมด" }) as HTMLButtonElement;

		expect(viewAllTasks.disabled).toBe(false);
		expect(viewAllTasks.title).toBe("");
		expect(openInbox.disabled).toBe(true);
		expect(openInbox.title).toBe("เปิดตอนเพื่อเริ่มทางเดินงาน");
		expect(viewAllAiJobs.disabled).toBe(true);
		expect(viewAllAiJobs.title).toBe("เปิดตอนเพื่อเริ่มทางเดินงาน");
	});

	it("navigates storage upgrade to billing settings instead of opening the library", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject(),
			counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		});
		usageStore.dashboard = usageDashboard();
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มแพ็ก / อัปเกรด" }));

		await waitFor(() => expect(window.location.pathname).toBe("/settings/billing"));
		expect(editorUiStore.workspaceView).not.toBe("library");
	});
});

// KEYSTONE (BUG 3, P1): the dashboard HERO ("resume where you left off") is sourced
// from the workspace-home AGGREGATE's stable recentProject — never from the open
// chapter. Opening / closing a chapter must NOT change the hero (title / lang /
// progress / CTA / page caption). Honest empty hero when the workspace has no projects.
describe("WorkspaceDashboard — hero is workspace-scoped and stable", () => {
	function heroCard(): HTMLElement {
		return document.querySelector('[data-tour="hero"]') as HTMLElement;
	}

	it("renders the hero from the aggregate's recentProject and keeps it UNCHANGED when a chapter is opened/closed", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({
				projectId: "agg-recent",
				projectName: "Workspace Recent Story",
				storyTitle: "Workspace Recent Story",
				chapterLabel: "ตอน 7",
				sourceLang: "ja",
				targetLang: "th",
				pageCount: 18,
				progressPercent: 42,
				hasProgress: true,
			}),
			counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const hero = () => within(heroCard());
		// Snapshot the hero's load-bearing facts from the aggregate (NOT the chapter).
		expect(hero().getByRole("heading", { level: 2, name: "Workspace Recent Story" })).toBeTruthy();
		expect(heroCard().textContent).toContain("ตอน 7 · TH · 18 หน้า");
		expect(heroCard().textContent).toContain("JA → TH");
		expect(heroCard().textContent).toContain("รวม");
		expect(heroCard().textContent).toContain("42%");
		const ctaBefore = hero().getByRole("button", { name: "ทำต่อจากตอนล่าสุด (Hero)" });
		expect(ctaBefore.textContent).toContain("ทำต่อ");

		// Open a DIFFERENT chapter mid-session. Its title/lang/pages differ from the
		// aggregate's recent project — the hero must ignore it entirely.
		projectStore.__setProjectForTesting(project({
			projectId: "open-chapter",
			name: "Open Chapter X",
			storyTitle: "Open Chapter X",
			chapterLabel: "ตอน 99",
			sourceLang: "ko",
			targetLang: "en",
		}));

		await waitFor(() =>
			expect(hero().getByRole("heading", { level: 2, name: "Workspace Recent Story" })).toBeTruthy(),
		);
		// None of the OPEN chapter's facts leak into the hero.
		expect(hero().queryByRole("heading", { level: 2, name: "Open Chapter X" })).toBeNull();
		expect(heroCard().textContent).not.toContain("ตอน 99");
		expect(heroCard().textContent).not.toContain("KO → EN");
		// Hero stays identical: chapter context, language pair, progress, CTA.
		expect(heroCard().textContent).toContain("ตอน 7 · TH · 18 หน้า");
		expect(heroCard().textContent).toContain("JA → TH");
		expect(heroCard().textContent).toContain("42%");
		expect(hero().getByRole("button", { name: "ทำต่อจากตอนล่าสุด (Hero)" }).textContent).toContain("ทำต่อ");

		// Close the chapter: hero STILL unchanged.
		projectStore.__setProjectForTesting(null);
		await waitFor(() =>
			expect(hero().getByRole("heading", { level: 2, name: "Workspace Recent Story" })).toBeTruthy(),
		);
		expect(heroCard().textContent).toContain("ตอน 7 · TH · 18 หน้า");
		expect(heroCard().textContent).toContain("42%");
	});

	it("opens the aggregate's recentProject (not the open chapter) from the hero CTA", async () => {
		const openProject = vi.spyOn(projectStore, "openProject").mockImplementation(async () => {
			projectStore.__setProjectForTesting(project({ projectId: "agg-recent", pages: project().pages }));
			return true;
		});
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});
		// A different chapter is already open — the CTA must still target the stable hero project.
		projectStore.__setProjectForTesting(project({ projectId: "open-chapter", name: "Open Chapter X" }));
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({ projectId: "agg-recent", pageCount: 18, hasProgress: true }),
			counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		await fireEvent.click(
			within(heroCard()).getByRole("button", { name: "ทำต่อจากตอนล่าสุด (Hero)" }),
		);

		expect(openProject).toHaveBeenCalledWith("agg-recent", null);
	});

	// P1 (work-vanished): a FAILED aggregate load must render an ERROR hero with a
	// RETRY — NEVER the first-run "create your first story" hero (which reads to a
	// returning paying user as "my work disappeared").
	it("shows an error hero with retry — NOT the first-run create hero — when the aggregate failed to load", async () => {
		projectStore.__setProjectForTesting(project({ name: "Open Chapter X" }));
		workspaceHomeStore.aggregate = null;
		workspaceHomeStore.loading = false;
		workspaceHomeStore.error = "เครือข่ายล่ม";
		editorUiStore.openDashboard();
		const loadSpy = vi.spyOn(workspaceHomeStore, "load").mockResolvedValue(undefined);

		render(WorkspaceDashboard);

		// Error card is shown…
		expect(screen.getByTestId("dashboard-home-error")).toBeTruthy();
		// …the first-run create CTA is NOT…
		expect(within(heroCard()).queryByRole("button", { name: "สร้างตอนใหม่" })).toBeNull();
		// …and the retry actually re-fetches the aggregate (in place, no full reload).
		const retry = screen.getByTestId("dashboard-home-retry");
		await fireEvent.click(retry);
		expect(loadSpy).toHaveBeenCalled();
	});

	// P1: while the aggregate is loading on a returning user, show a skeleton — never
	// the first-run hero or zeros — so their work doesn't appear to vanish mid-load.
	it("shows a loading skeleton hero — NOT the first-run create hero — while the aggregate loads", () => {
		workspaceHomeStore.aggregate = null;
		workspaceHomeStore.loading = true;
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		expect(screen.getByTestId("dashboard-home-loading")).toBeTruthy();
		expect(within(heroCard()).queryByRole("button", { name: "สร้างตอนใหม่" })).toBeNull();
		expect(within(heroCard()).queryByTestId("dashboard-home-error")).toBeNull();
	});

	it("shows an honest hero empty state when the workspace has no projects", () => {
		// A chapter is open, but the aggregate has no projects → the hero must show the
		// honest 'no project' state, NOT the open chapter.
		projectStore.__setProjectForTesting(project({ name: "Open Chapter X", storyTitle: "Open Chapter X" }));
		workspaceHomeStore.aggregate = homeAggregate(); // recentProject: null, projects: 0
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		expect(within(heroCard()).getByRole("button", { name: "สร้างตอนใหม่" })).toBeTruthy();
		expect(within(heroCard()).queryByRole("heading", { level: 2, name: "Open Chapter X" })).toBeNull();
		expect(within(heroCard()).queryByRole("button", { name: "ทำต่อจากตอนล่าสุด (Hero)" })).toBeNull();
	});

	// BUG 2 (P1): the hero COVER must be sourced from the AGGREGATE's recentProject
	// (coverImageId) too — not from projectStore.recentProjects. Opening a chapter or
	// any projectStore change must leave the cover untouched.
	it("renders the hero cover from the aggregate's coverImageId and keeps it stable across projectStore/chapter changes", async () => {
		const aggCover = "550e8400-e29b-41d4-a716-446655440000.webp";
		// projectStore carries a DIFFERENT cover — it must never feed the hero cover.
		projectStore.recentProjects = [projectSummary({ projectId: "agg-recent", coverImageId: "999e8400-e29b-41d4-a716-44665544ffff.webp" })];
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({ projectId: "agg-recent", coverImageId: aggCover }),
			counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		// The hero CoverCard renders its <img> branch (cover present), seeded by the
		// aggregate's projectId — not the DefaultCover placeholder.
		const heroImg = () => heroCard().querySelector("img");
		await waitFor(() => expect(heroImg()).not.toBeNull());

		// Open a DIFFERENT chapter and swap projectStore.recentProjects — neither may
		// disturb the hero cover (still an <img>, never collapsing to DefaultCover).
		projectStore.__setProjectForTesting(project({ projectId: "open-chapter", name: "Open Chapter X" }));
		projectStore.recentProjects = [];
		await waitFor(() => expect(heroImg()).not.toBeNull());

		// Close the chapter: hero cover STILL an image.
		projectStore.__setProjectForTesting(null);
		await waitFor(() => expect(heroImg()).not.toBeNull());
	});

	it("falls back to the DefaultCover when the aggregate has no cover — even if projectStore has one", async () => {
		// Aggregate recentProject has NO coverImageId; projectStore DOES. The hero must
		// IGNORE projectStore and render the seeded DefaultCover (no <img>).
		projectStore.recentProjects = [projectSummary({ projectId: "agg-recent", coverImageId: "550e8400-e29b-41d4-a716-446655440000.webp" })];
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({ projectId: "agg-recent", coverImageId: undefined }),
			counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		// Give any async cover load a tick — the hero must NOT have produced an <img>.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(heroCard().querySelector("img")).toBeNull();
	});

	// REGRESSION: the cross-project AI soft-queue rows must show the LOCALIZED status
	// label ("รอรีวิว"/"รันพลาด"/"กำลังรัน"), not the raw marker enum
	// ("needs_review"/"failed"/"processing") that leaked the internal status string
	// into the UI.
	it("renders the AI soft-queue rows with localized status labels, not the raw enum", () => {
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject(),
			aiJobs: [
				{
					projectId: "p1", projectName: "Story Z", storyId: "s1", storyTitle: "Story Z",
					chapterLabel: "Ch 1", targetLang: "th",
					id: "p1:m1", markerId: "m1", jobId: "job1", pageIndex: 0,
					status: "needs_review", tier: "sfx-pro", updatedAt: now,
				},
				{
					projectId: "p1", projectName: "Story Z", storyId: "s1", storyTitle: "Story Z",
					chapterLabel: "Ch 1", targetLang: "th",
					id: "p1:m2", markerId: "m2", jobId: "job2", pageIndex: 2,
					status: "failed", tier: "clean-pro", updatedAt: now,
				},
			],
			counts: { projects: 1, myOpenTasks: 0, attention: 0, aiJobs: 2, dueToday: 0, overdue: 0, openTasks: 0 },
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		// Localized labels are surfaced…
		expect(screen.getAllByText(/รอรีวิว/).length).toBeGreaterThan(0);
		expect(screen.getByText(/รันพลาด/)).toBeTruthy();
		// …and the raw marker enum strings never reach the DOM.
		expect(screen.queryByText(/needs_review/)).toBeNull();
		expect(screen.queryByText(/· failed/)).toBeNull();
	});
});

// KEYSTONE: the QUIET METRICS ROW (% localized + target languages) is sourced from
// the workspace-home AGGREGATE only — % localized mirrors the hero's honest progress
// gate, target languages is the DISTINCT set across the workspace. Opening/closing a
// chapter must NOT change either tile. Honest zeros for an empty workspace.
describe("WorkspaceDashboard — quiet metrics row is workspace-scoped and stable", () => {
	function metricsRow(): HTMLElement {
		return document.querySelector('[data-testid="quiet-metrics-row"]') as HTMLElement;
	}

	it("renders % localized + target languages from the aggregate and keeps them UNCHANGED across chapter open/close", async () => {
		workspaceHomeStore.aggregate = homeAggregate({
			recentProject: homeRecentProject({
				projectId: "agg-recent",
				targetLang: "th",
				progressPercent: 42,
				hasProgress: true,
			}),
			// Workspace spans TWO target languages → the metric is "2", not "1 / open chapter".
			targetLangs: ["EN", "TH"],
			counts: { projects: 2, myOpenTasks: 0, attention: 0, aiJobs: 0, dueToday: 0, overdue: 0, openTasks: 0 },
		});
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const row = () => metricsRow();
		// % localized = aggregate progress (42), NOT a fabricated/per-chapter value.
		expect(row().textContent).toContain("42%");
		// target languages = distinct workspace count (2) with the hero's headline code.
		expect(row().textContent).toContain("2");
		expect(row().textContent).toContain("TH");

		// Open a DIFFERENT chapter (target lang EN, no review progress). The metrics row
		// must IGNORE it — % localized stays 42, target languages stays 2/TH.
		projectStore.__setProjectForTesting(project({
			projectId: "open-chapter",
			name: "Open Chapter X",
			targetLang: "en",
		}));
		await waitFor(() => expect(row().textContent).toContain("42%"));
		expect(row().textContent).toContain("2");
		expect(row().textContent).toContain("TH");

		// Close the chapter: still unchanged.
		projectStore.__setProjectForTesting(null);
		await waitFor(() => expect(row().textContent).toContain("42%"));
		expect(row().textContent).toContain("2");
	});

	it("shows honest zeros (no fake 0% / no language) for an empty workspace even with a chapter open", async () => {
		// A chapter IS open with a target lang and pages, but the workspace aggregate is
		// empty → the metrics row must show honest zero states, never the open chapter.
		projectStore.__setProjectForTesting(project({ projectId: "open-chapter", targetLang: "en" }));
		workspaceHomeStore.aggregate = homeAggregate(); // recentProject null, targetLangs [], projects 0
		editorUiStore.openDashboard();

		render(WorkspaceDashboard);

		const row = metricsRow();
		// Honest empty: 0% with the "no chapter" caption, and "no chapter" for languages.
		expect(row.textContent).toContain("0%");
		expect(row.textContent).toContain("ยังไม่มีตอน");
		// The open chapter's EN target lang must NOT leak in as a chip.
		expect(row.querySelector(".text-ws-cyan")).toBeNull();
	});
});

describe("WorkspaceDashboard — first-run create CTA is workspace-scoped", () => {
	// The first-run create-chapter CTA must NOT open setup (and create a project)
	// before the workspace context resolves — otherwise the project lands UNSCOPED.

	it("blocks the first-run create CTA until a workspace resolves (no unscoped create)", async () => {
		// No hero project → first-run empty hero; no workspace resolved yet.
		projectStore.recentProjects = [];
		workspaceHomeStore.aggregate = homeAggregate();
		workspacesStore.workspaces = [];
		workspacesStore.currentWorkspaceId = null;
		const openChapterSetup = vi.spyOn(editorUiStore, "openChapterSetup").mockImplementation(() => {});
		const loadWorkspaces = vi.spyOn(workspacesStore, "load").mockResolvedValue(undefined);

		render(WorkspaceDashboard);

		// The CTA shows the "setting up…" label and is disabled.
		const cta = await screen.findByText("กำลังตั้งค่าเวิร์กสเปซ…");
		const button = cta.closest("button") as HTMLButtonElement;
		expect(button.disabled).toBe(true);

		// Even forcing a click must NOT open chapter setup; it kicks a workspace reload.
		await fireEvent.click(button);
		expect(openChapterSetup).not.toHaveBeenCalled();
		expect(loadWorkspaces).toHaveBeenCalled();
		// User sees a clear status, not a silent dead control.
		expect(projectStore.statusMsg).toContain("กำลังตั้งค่าเวิร์กสเปซ");
	});

	it("opens chapter setup once a workspace is resolved", async () => {
		projectStore.recentProjects = [];
		workspaceHomeStore.aggregate = homeAggregate();
		workspacesStore.workspaces = [
			{ workspaceId: "ws-live", name: "Live WS", planId: "free", memberRole: "owner", memberScope: {} } as any,
		];
		workspacesStore.currentWorkspaceId = "ws-live";
		const openChapterSetup = vi.spyOn(editorUiStore, "openChapterSetup").mockImplementation(() => {});

		render(WorkspaceDashboard);

		const button = (await screen.findByText("สร้างตอนใหม่")).closest("button") as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		await fireEvent.click(button);
		expect(openChapterSetup).toHaveBeenCalled();
	});
});
