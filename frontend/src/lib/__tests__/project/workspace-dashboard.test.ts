import { describe, expect, it } from "vitest";
import {
	buildWorkspaceAssignedWork,
	buildWorkspaceProjectBrowser,
	buildWorkspaceDashboardStats,
	buildWorkspaceInboxSummary,
	buildWorkspaceJobLanes,
	workspaceTaskTypeLabel,
	formatAssigneeSummary,
	getWorkspaceProjectChapterLabel,
	getWorkspaceProjectChapterDisplayLabel,
	getWorkspaceAttentionItems,
	getWorkspaceProjectFamilyName,
	getWorkspaceProjectDeleteConfirmTitle,
	getWorkspaceProjectStoryTitle,
	getWorkspaceRecentProjects,
} from "$lib/project/workspace-dashboard.js";
import type { ProjectSummary } from "$lib/api/client.js";
import type { WorkInboxItem } from "$lib/project/work-inbox.js";
import type { WorkflowTask, WorkspaceFeedItem } from "$lib/types.js";

function task(overrides: Partial<WorkflowTask>): WorkflowTask {
	return {
		id: overrides.id ?? "task-1",
		type: overrides.type ?? "translate",
		status: overrides.status ?? "todo",
		priority: overrides.priority ?? "normal",
		pageIndex: overrides.pageIndex ?? 0,
		title: overrides.title ?? "Translate page",
		createdAt: overrides.createdAt ?? "2026-05-13T00:00:00.000Z",
		updatedAt: overrides.updatedAt ?? "2026-05-13T00:00:00.000Z",
		assignee: overrides.assignee,
		dueAt: overrides.dueAt,
	};
}

function feed(overrides: Partial<WorkspaceFeedItem>): WorkspaceFeedItem {
	return {
		id: overrides.id ?? "feed-1",
		kind: overrides.kind ?? "task",
		sourceId: overrides.sourceId ?? "task-1",
		title: overrides.title ?? "Task update",
		detail: overrides.detail ?? "Updated task",
		createdAt: overrides.createdAt ?? "2026-05-13T00:00:00.000Z",
		severity: overrides.severity,
		priority: overrides.priority,
		dueAt: overrides.dueAt,
		dueState: overrides.dueState,
	};
}

function projectSummary(index: number): ProjectSummary {
	return {
		projectId: `project-${index}`,
		name: `Project ${index}`,
		createdAt: "2026-05-13T00:00:00.000Z",
		updatedAt: `2026-05-13T00:0${index % 10}:00.000Z`,
		targetLang: "th",
		pageCount: index + 1,
		textLayerCount: index,
	};
}

function inboxItem(overrides: Partial<WorkInboxItem> = {}): WorkInboxItem {
	return {
		id: overrides.id ?? "inbox-1",
		kind: overrides.kind ?? "workflow_task",
		severity: overrides.severity ?? "warning",
		priority: overrides.priority,
		status: overrides.status,
		assignee: overrides.assignee,
		dueAt: overrides.dueAt,
		overdue: overrides.overdue,
		pageIndex: overrides.pageIndex ?? 0,
		titleCode: overrides.titleCode ?? "workflow",
		workflowTitle: overrides.workflowTitle ?? { code: "review" },
		detail: overrides.detail ?? { kind: "text", text: "Needs work" },
		sourceId: overrides.sourceId ?? "task-1",
	};
}

describe("workspace dashboard model", () => {
	it("builds role lanes with open, done, urgent, overdue, and assignee signals", () => {
		const tasks = [
			task({
				id: "translate-1",
				type: "translate",
				status: "doing",
				priority: "urgent",
				assignee: "mai",
				pageIndex: 2,
				title: "Translate page 3",
			}),
			task({ id: "translate-2", type: "translate", status: "done", assignee: "mai" }),
			task({
				id: "clean-1",
				type: "clean",
				status: "todo",
				priority: "high",
				assignee: "beam",
				dueAt: "2026-05-14T00:00:00.000Z",
				title: "Clean page 1",
			}),
			task({ id: "review-1", type: "review", status: "review" }),
		];

		const lanes = buildWorkspaceJobLanes(tasks);

		expect(lanes.find((lane) => lane.id === "translate")).toMatchObject({
			totalCount: 2,
			openCount: 1,
			doneCount: 1,
			urgentCount: 1,
			assignees: ["mai"],
			firstOpenTaskId: "translate-1",
			firstOpenPageIndex: 2,
			firstOpenTaskTitle: "Translate page 3",
		});
		expect(lanes.find((lane) => lane.id === "clean")).toMatchObject({
			totalCount: 1,
			openCount: 1,
			doneCount: 0,
			urgentCount: 0,
			assignees: ["beam"],
			firstOpenTaskId: "clean-1",
			nextDueAt: "2026-05-14T00:00:00.000Z",
		});
		expect(lanes.map((lane) => lane.id)).toEqual(["translate", "clean", "typeset", "review"]);
		// The lane label is now the stable task-type CODE (equals `id`), not a Thai
		// string; consumers localize it via $_("taskType.<code>").
		expect(lanes.map((lane) => lane.label)).toEqual(["translate", "clean", "typeset", "review"]);
	});

	it("returns the task-type CODE from workspaceTaskTypeLabel", () => {
		expect(workspaceTaskTypeLabel("translate")).toBe("translate");
		expect(workspaceTaskTypeLabel("clean")).toBe("clean");
		expect(workspaceTaskTypeLabel("typeset")).toBe("typeset");
		expect(workspaceTaskTypeLabel("review")).toBe("review");
	});

	it("filters job lanes by role capability", () => {
		const translatorCapabilities = {
			canTranslate: true,
			canClean: false,
			canTypeset: false,
			canReviewQC: false,
			canManageMembers: false,
			canManageBilling: false,
			canExport: false,
			canImport: true,
			canGenerateAI: true,
			canManageProjects: false,
		};
		const tasks = [
			task({ id: "translate-1", type: "translate" }),
			task({ id: "clean-1", type: "clean" }),
			task({ id: "typeset-1", type: "typeset" }),
			task({ id: "review-1", type: "review" }),
		];

		expect(buildWorkspaceJobLanes(tasks, translatorCapabilities).map((lane) => lane.id)).toEqual(["translate"]);
	});

	it("summarizes dashboard attention from tasks and workspace feed", () => {
		const tasks = [
			task({ id: "urgent", status: "todo", priority: "urgent" }),
			task({ id: "done", status: "done", priority: "normal" }),
			task({ id: "high", status: "doing", priority: "high" }),
		];
		const workspaceFeed = [
			feed({ id: "warning", severity: "warning" }),
			feed({ id: "comment", kind: "comment" }),
			feed({ id: "ai", kind: "ai_marker", severity: "error" }),
		];

		expect(buildWorkspaceDashboardStats(tasks, workspaceFeed)).toMatchObject({
			openTaskCount: 2,
			doneTaskCount: 1,
			urgentTaskCount: 1,
			highTaskCount: 1,
			attentionFeedCount: 2,
			commentCount: 1,
			aiAttentionCount: 1,
		});
	});

	it("builds assigned work groups with overdue, urgency, and unassigned queues", () => {
		const tasks = [
			task({
				id: "mai-overdue",
				type: "typeset",
				status: "doing",
				priority: "normal",
				assignee: "@Mai",
				dueAt: "2000-01-01T00:00:00.000Z",
				pageIndex: 4,
				title: "Typeset late page",
			}),
			task({
				id: "mai-urgent",
				type: "clean",
				status: "todo",
				priority: "urgent",
				assignee: "Mai",
				pageIndex: 1,
				title: "Clean urgent page",
			}),
			task({
				id: "unassigned-review",
				type: "review",
				status: "review",
				priority: "high",
				pageIndex: 2,
				title: "Review unassigned page",
			}),
			task({
				id: "beam-done",
				type: "translate",
				status: "done",
				assignee: "beam",
				title: "Already done",
			}),
		];

		const groups = buildWorkspaceAssignedWork(tasks);

		expect(groups.map((group) => group.id)).toEqual(["assignee-mai", "unassigned"]);
		expect(groups[0]).toMatchObject({
			label: "@Mai",
			openCount: 2,
			urgentCount: 1,
			overdueCount: 1,
			firstOpenTaskId: "mai-overdue",
			firstOpenPageIndex: 4,
		});
		expect(groups[0]?.tasks.map((item) => item.id)).toEqual(["mai-overdue", "mai-urgent"]);
		expect(groups[0]?.tasks[0]).toMatchObject({
				// typeLabel is now the stable task-type CODE (was Thai "ไทป์เซ็ต");
				// consumers localize it via $_("taskType.<code>").
				typeLabel: "typeset",
			overdue: true,
			assignee: "Mai",
		});
		expect(groups[1]).toMatchObject({
			label: "Unassigned queue",
			openCount: 1,
			highCount: 1,
			reviewCount: 1,
			firstOpenTaskId: "unassigned-review",
		});
	});

	it("caps assigned work groups and task previews without mutating task order", () => {
		const tasks = [
			task({ id: "a-1", assignee: "a", title: "A1" }),
			task({ id: "a-2", assignee: "a", title: "A2" }),
			task({ id: "b-1", assignee: "b", priority: "urgent", title: "B1" }),
			task({ id: "c-1", assignee: "c", priority: "high", title: "C1" }),
		];

		const groups = buildWorkspaceAssignedWork(tasks, 2, 1);

		expect(tasks.map((item) => item.id)).toEqual(["a-1", "a-2", "b-1", "c-1"]);
		expect(groups).toHaveLength(2);
		expect(groups.map((group) => group.label)).toEqual(["@b", "@c"]);
		expect(groups.every((group) => group.tasks.length === 1)).toBe(true);
	});

	it("formats assignee summaries for onboarding surfaces", () => {
		expect(formatAssigneeSummary(["@a", "b", "@@c"])).toBe("@a, @b +1");
	});

	it("caps dashboard recent projects without mutating source order", () => {
		const projects = Array.from({ length: 12 }, (_, index) => projectSummary(index));

		expect(getWorkspaceRecentProjects(projects).map((project) => project.projectId)).toEqual([
			"project-0",
			"project-1",
			"project-2",
			"project-3",
			"project-4",
			"project-5",
			"project-6",
			"project-7",
		]);
		expect(getWorkspaceRecentProjects(projects, 3).map((project) => project.projectId)).toEqual([
			"project-0",
			"project-1",
			"project-2",
		]);
	});

	it("builds grouped project browser lanes from recent project summaries", () => {
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "alpha-2",
				name: "Alpha Chapter 2",
				targetLang: "en",
				pageCount: 20,
				textLayerCount: 80,
				taskCount: 8,
				openTaskCount: 3,
				reviewTaskCount: 1,
				openCommentCount: 2,
				updatedAt: "2026-05-13T10:00:00.000Z",
			},
			{
				...projectSummary(2),
				projectId: "alpha-1",
				name: "Alpha Chapter 1",
				targetLang: "th",
				coverImageId: "alpha-cover.webp",
				coverOriginalName: "alpha-cover-source.webp",
				pageCount: 18,
				textLayerCount: 72,
				taskCount: 4,
				openTaskCount: 1,
				reviewTaskCount: 0,
				openCommentCount: 1,
				updatedAt: "2026-05-13T09:00:00.000Z",
			},
			{
				...projectSummary(3),
				projectId: "beta-1",
				name: "Beta Episode 1",
				targetLang: "en",
				pageCount: 12,
				textLayerCount: 30,
				updatedAt: "2026-05-13T11:00:00.000Z",
			},
		];

		expect(getWorkspaceProjectFamilyName("Alpha Chapter 12")).toBe("Alpha");
		// An unnamed story returns "" (not a rendered Thai string); the consumer
		// localizes the empty case via $_("library.untitledStory").
		expect(getWorkspaceProjectFamilyName("")).toBe("");
		expect(getWorkspaceProjectFamilyName("   ")).toBe("");
		expect(getWorkspaceProjectChapterLabel("Alpha Episode 07")).toBe("ตอน 07");
		expect(getWorkspaceProjectChapterLabel("Flow610 Real Create - ตอน 104 - Real File Smoke")).toBe("ตอน 104");
		// A localized prefix swaps only the DISPLAY word; the parser still accepts
		// the Thai stored form and other chapter patterns.
		expect(getWorkspaceProjectChapterLabel("Alpha Episode 07", "Ch.")).toBe("Ch. 07");
		expect(getWorkspaceProjectChapterLabel("Flow610 Real Create - ตอน 104 - Real File Smoke", "Ch.")).toBe("Ch. 104");
		expect(getWorkspaceProjectChapterLabel("No number here", "Ch.")).toBe("Ch.");
		const groups = buildWorkspaceProjectBrowser(projects);

		expect(groups.map((group) => group.title)).toEqual(["Beta", "Alpha"]);
		expect(groups.find((group) => group.title === "Alpha")).toMatchObject({
			chapterCount: 2,
			hiddenChapterCount: 0,
			totalPages: 38,
			totalTextLayers: 152,
			totalTasks: 12,
			openTasks: 4,
			reviewTasks: 1,
			openComments: 3,
			attentionChapterCount: 2,
			activeChapterCount: 0,
			readyChapterCount: 0,
			coverProjectId: "alpha-1",
			coverImageId: "alpha-cover.webp",
			coverOriginalName: "alpha-cover-source.webp",
			nextAction: "Resolve chapter comments",
			targetLangs: ["en", "th"],
			languageSummaries: [
				{
					lang: "en",
					chapterCount: 1,
					pageCount: 20,
					openTasks: 3,
					reviewTasks: 1,
					openComments: 2,
				},
				{
					lang: "th",
					chapterCount: 1,
					pageCount: 18,
					openTasks: 1,
					reviewTasks: 0,
					openComments: 1,
				},
			],
			latestUpdatedAt: "2026-05-13T10:00:00.000Z",
		});
		expect(groups.find((group) => group.title === "Alpha")?.projects.map((project) => project.projectId)).toEqual([
			"alpha-1",
			"alpha-2",
		]);
		expect(groups.find((group) => group.title === "Alpha")?.chapters.map((chapter) => ({
			projectId: chapter.project.projectId,
			chapterLabel: chapter.chapterLabel,
			workState: chapter.workState,
			nextAction: chapter.nextAction,
			densityLabel: chapter.densityLabel,
		}))).toEqual([
			{
				projectId: "alpha-1",
				chapterLabel: "ตอน 1",
				workState: "attention",
				nextAction: "Resolve comments",
				densityLabel: "Light queue",
			},
			{
				projectId: "alpha-2",
				chapterLabel: "ตอน 2",
				workState: "attention",
				nextAction: "Resolve review comments",
				densityLabel: "Light queue",
			},
		]);
	});

	describe("getWorkspaceProjectDeleteConfirmTitle (story-delete confirm regression)", () => {
		// The library story-delete sends THIS string to DELETE /project/:id; the backend
		// confirms it against `(state.storyTitle ?? state.name ?? "").trim()`. It MUST be
		// the project's own canonical title, NOT the family-stripped group DISPLAY title.
		it("uses the explicit storyTitle when present", () => {
			const project: ProjectSummary = {
				...projectSummary(1),
				name: "เรื่องเอ - ตอน 1",
				storyTitle: "เรื่องเอ",
			};
			expect(getWorkspaceProjectDeleteConfirmTitle(project)).toBe("เรื่องเอ");
		});

		it("falls back to the FULL name (not the family-stripped title) for a no-storyTitle suffixed chapter", () => {
			// This is the undeletable-story bug: the group DISPLAY title strips the chapter
			// suffix, but the backend (no storyTitle) expects the full name.
			const project: ProjectSummary = {
				...projectSummary(1),
				name: "เรื่องเอ - ตอน 1",
				storyTitle: undefined,
			};
			// The confirm title is the FULL name…
			expect(getWorkspaceProjectDeleteConfirmTitle(project)).toBe("เรื่องเอ - ตอน 1");
			// …and it DIVERGES from the family-stripped group display title, which is what
			// the old client wrongly sent and what made the story permanently undeletable.
			expect(getWorkspaceProjectStoryTitle(project)).toBe("เรื่องเอ");
			expect(getWorkspaceProjectDeleteConfirmTitle(project)).not.toBe(
				getWorkspaceProjectStoryTitle(project),
			);
		});

		it("falls back to the bare chapter-label name for a no-storyTitle chapter whose name is just a label", () => {
			const project: ProjectSummary = {
				...projectSummary(1),
				name: "ตอน 5",
				storyTitle: undefined,
			};
			expect(getWorkspaceProjectDeleteConfirmTitle(project)).toBe("ตอน 5");
		});

		it("trims, matching the backend's trimmed exact-match comparison", () => {
			const project: ProjectSummary = {
				...projectSummary(1),
				name: "  Padded Name  ",
				storyTitle: undefined,
			};
			expect(getWorkspaceProjectDeleteConfirmTitle(project)).toBe("Padded Name");
		});
	});

	it("does NOT merge story shelves that share a storyId across DIFFERENT workspaces", () => {
		// Cross-workspace isolation (P1): two projects carry the SAME storyId but live
		// in DIFFERENT workspaces. They must surface as TWO separate shelves, never one
		// merged group — the group key is namespaced by (workspaceId, storyId).
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "ws-a-ch1",
				workspaceId: "workspace-a",
				storyId: "shared-story-id",
				storyTitle: "Shared Title",
				name: "Shared Title - Ch 1",
				updatedAt: "2026-05-13T09:00:00.000Z",
			},
			{
				...projectSummary(2),
				projectId: "ws-b-ch1",
				workspaceId: "workspace-b",
				storyId: "shared-story-id",
				storyTitle: "Shared Title",
				name: "Shared Title - Ch 1",
				updatedAt: "2026-05-13T10:00:00.000Z",
			},
		];

		const groups = buildWorkspaceProjectBrowser(projects);
		expect(groups).toHaveLength(2);
		// Each shelf holds exactly one workspace's chapter — no cross-workspace bleed.
		for (const group of groups) {
			expect(group.projects).toHaveLength(1);
		}
		const projectIds = groups.flatMap((group) => group.projects.map((project) => project.projectId)).sort();
		expect(projectIds).toEqual(["ws-a-ch1", "ws-b-ch1"]);
		// The raw storyId (used for URLs) is preserved un-namespaced on each group.
		expect(groups.every((group) => group.storyId === "shared-story-id")).toBe(true);
	});

	it("still merges chapters sharing a storyId WITHIN the same workspace", () => {
		// Same workspace + same storyId → one shelf (the normal add-a-chapter case).
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "ws-a-ch1",
				workspaceId: "workspace-a",
				storyId: "story-1",
				storyTitle: "Same Story",
				name: "Same Story - Ch 1",
			},
			{
				...projectSummary(2),
				projectId: "ws-a-ch2",
				workspaceId: "workspace-a",
				storyId: "story-1",
				storyTitle: "Same Story",
				name: "Same Story - Ch 2",
			},
		];

		const groups = buildWorkspaceProjectBrowser(projects);
		expect(groups).toHaveLength(1);
		expect(groups[0].projects.map((project) => project.projectId).sort()).toEqual(["ws-a-ch1", "ws-a-ch2"]);
	});

	it("localizes the chapter-label prefix for display while keeping stored Thai data parseable", () => {
		// Stored explicit Thai-prefixed label → only the leading prefix word swaps.
		expect(
			getWorkspaceProjectChapterDisplayLabel(
				{ ...projectSummary(1), chapterLabel: "ตอน 104 - Real File Smoke" },
				"Ch.",
			),
		).toBe("Ch. 104 - Real File Smoke");
		// chapterNumber/chapterTitle metadata path uses the localized prefix.
		expect(
			getWorkspaceProjectChapterDisplayLabel(
				{ ...projectSummary(1), chapterNumber: "12", chapterTitle: "First Light" },
				"Episode",
			),
		).toBe("Episode 12 - First Light");
		// Default (Thai) prefix preserves the stored label byte-for-byte.
		expect(
			getWorkspaceProjectChapterDisplayLabel({ ...projectSummary(1), chapterLabel: "ตอน 12" }),
		).toBe("ตอน 12");
		// An already-localized / free-form stored label is left untouched.
		expect(
			getWorkspaceProjectChapterDisplayLabel({ ...projectSummary(1), chapterLabel: "Bonus" }, "Ch."),
		).toBe("Bonus");
	});

	it("threads a localized chapter prefix through the project browser (display + fallback disambiguation)", () => {
		const projects: ProjectSummary[] = [
			{ ...projectSummary(1), projectId: "loc-1", name: "Loc Chapter 1", updatedAt: "2026-05-13T09:00:00.000Z" },
			{ ...projectSummary(2), projectId: "loc-2", name: "Loc Chapter 2", updatedAt: "2026-05-13T10:00:00.000Z" },
			// Two numberless siblings → fallback labels must disambiguate against the
			// localized prefix (`^Ch\.\s+\d+$`), not the hardcoded Thai `ตอน`.
			{ ...projectSummary(3), projectId: "loc-3", name: "Loc", updatedAt: "2026-05-13T11:00:00.000Z" },
			{ ...projectSummary(4), projectId: "loc-4", name: "Loc", updatedAt: "2026-05-13T12:00:00.000Z" },
		];

		const [group] = buildWorkspaceProjectBrowser(projects, 24, 100, "Ch.");
		const labels = group?.chapters.map((chapter) => chapter.chapterLabel) ?? [];
		expect(labels).toContain("Ch. 1");
		expect(labels).toContain("Ch. 2");
		// Both numberless siblings get a distinct localized fallback (no bare "Ch.").
		expect(labels.filter((label) => label === "Ch.")).toHaveLength(0);
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels.every((label) => label.startsWith("Ch."))).toBe(true);
	});

	it("surfaces multiple language tracks from a SINGLE project's targetLangs", () => {
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "omega-1",
				name: "Omega Chapter 1",
				targetLang: "th",
				targetLangs: ["th", "en"],
				pageCount: 20,
				textLayerCount: 60,
				taskCount: 6,
				openTaskCount: 3,
				reviewTaskCount: 1,
				openCommentCount: 2,
				updatedAt: "2026-05-13T10:00:00.000Z",
			},
		];

		const [group] = buildWorkspaceProjectBrowser(projects);

		// One project row, but BOTH declared languages surface on the dashboard.
		expect(group?.title).toBe("Omega");
		expect(group?.chapterCount).toBe(1);
		expect(group?.targetLangs).toEqual(["en", "th"]);
		expect(group?.languageSummaries).toEqual([
			{ lang: "en", chapterCount: 1, pageCount: 20, totalTasks: 6, openTasks: 3, reviewTasks: 1, openComments: 2 },
			{ lang: "th", chapterCount: 1, pageCount: 20, totalTasks: 6, openTasks: 3, reviewTasks: 1, openComments: 2 },
		]);
	});

	it("keeps single-language / legacy projects on one track (back-compat)", () => {
		const withoutTargetLangs: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "single-1",
				name: "Single Chapter 1",
				targetLang: "th",
				pageCount: 12,
				openTaskCount: 2,
				reviewTaskCount: 0,
				openCommentCount: 1,
			},
		];
		const [legacyGroup] = buildWorkspaceProjectBrowser(withoutTargetLangs);
		expect(legacyGroup?.targetLangs).toEqual(["th"]);
		expect(legacyGroup?.languageSummaries).toEqual([
			{ lang: "th", chapterCount: 1, pageCount: 12, totalTasks: 0, openTasks: 2, reviewTasks: 0, openComments: 1 },
		]);

		// A length-1 targetLangs that matches targetLang behaves identically.
		const redundantTargetLangs: ProjectSummary[] = [
			{
				...withoutTargetLangs[0]!,
				targetLangs: ["th"],
			},
		];
		const [redundantGroup] = buildWorkspaceProjectBrowser(redundantTargetLangs);
		expect(redundantGroup?.targetLangs).toEqual(["th"]);
		expect(redundantGroup?.languageSummaries).toEqual([
			{ lang: "th", chapterCount: 1, pageCount: 12, totalTasks: 0, openTasks: 2, reviewTasks: 0, openComments: 1 },
		]);
	});

	it("does not double-count a language present as both a sibling project and a project's targetLangs", () => {
		const projects: ProjectSummary[] = [
			{
				// Sibling Thai-only chapter (legacy per-language workaround).
				...projectSummary(1),
				projectId: "sigma-th",
				name: "Sigma Chapter 1",
				targetLang: "th",
				pageCount: 10,
				openTaskCount: 1,
				reviewTaskCount: 0,
				openCommentCount: 0,
				updatedAt: "2026-05-13T09:00:00.000Z",
			},
			{
				// Single project declaring BOTH languages (overlaps `th` with the sibling).
				...projectSummary(2),
				projectId: "sigma-multi",
				name: "Sigma Chapter 2",
				targetLang: "en",
				targetLangs: ["en", "th"],
				pageCount: 8,
				openTaskCount: 2,
				reviewTaskCount: 1,
				openCommentCount: 0,
				updatedAt: "2026-05-13T10:00:00.000Z",
			},
		];

		const [group] = buildWorkspaceProjectBrowser(projects);

		expect(group?.targetLangs).toEqual(["en", "th"]);
		// `th`: sigma-th (10p) + sigma-multi (8p) — each contributing project counted
		// exactly once, never twice for declaring `th` via both targetLang+targetLangs.
		// `en`: only sigma-multi.
		expect(group?.languageSummaries).toEqual([
			{ lang: "en", chapterCount: 1, pageCount: 8, totalTasks: 0, openTasks: 2, reviewTasks: 1, openComments: 0 },
			{ lang: "th", chapterCount: 2, pageCount: 18, totalTasks: 0, openTasks: 3, reviewTasks: 1, openComments: 0 },
		]);
	});

	it("reports hidden project browser chapters when a title has more chapters than the preview limit", () => {
		const projects = Array.from({ length: 4 }, (_, index): ProjectSummary => ({
			...projectSummary(index + 1),
			projectId: `gamma-${index + 1}`,
			name: `Gamma Chapter ${index + 1}`,
			updatedAt: `2026-05-13T00:0${index}:00.000Z`,
		}));

		const [group] = buildWorkspaceProjectBrowser(projects, 3, 2);

		expect(group).toMatchObject({
			title: "Gamma",
			chapterCount: 4,
			hiddenChapterCount: 2,
		});
		expect(group?.projects.map((project) => project.projectId)).toEqual(["gamma-1", "gamma-2", "gamma-3", "gamma-4"]);
		expect(group?.chapters.map((chapter) => chapter.project.projectId)).toEqual(["gamma-1", "gamma-2", "gamma-3", "gamma-4"]);
	});

	it("disambiguates numberless project browser chapters inside one title group", () => {
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "updated-name-old",
				name: "Updated Name",
				updatedAt: "2026-05-13T09:00:00.000Z",
			},
			{
				...projectSummary(2),
				projectId: "updated-name-latest",
				name: "Updated Name",
				updatedAt: "2026-05-13T11:00:00.000Z",
			},
			{
				...projectSummary(3),
				projectId: "updated-name-middle",
				name: "Updated Name",
				updatedAt: "2026-05-13T10:00:00.000Z",
			},
		];

		const [group] = buildWorkspaceProjectBrowser(projects);

		expect(group).toMatchObject({
			title: "Updated Name",
			chapterCount: 3,
			hiddenChapterCount: 0,
		});
		expect(group?.chapters.map((chapter) => ({
			projectId: chapter.project.projectId,
			chapterLabel: chapter.chapterLabel,
		}))).toEqual([
			{ projectId: "updated-name-latest", chapterLabel: "ตอน 1" },
			{ projectId: "updated-name-middle", chapterLabel: "ตอน 2" },
			{ projectId: "updated-name-old", chapterLabel: "ตอน 3" },
		]);
	});

	it("keeps generated fallback chapter labels from colliding with explicit chapter numbers", () => {
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "delta-fallback-latest",
				name: "Delta",
				updatedAt: "2026-05-13T11:00:00.000Z",
			},
			{
				...projectSummary(2),
				projectId: "delta-explicit",
				name: "Delta Chapter 1",
				updatedAt: "2026-05-13T09:00:00.000Z",
			},
			{
				...projectSummary(3),
				projectId: "delta-fallback-old",
				name: "Delta",
				updatedAt: "2026-05-13T10:00:00.000Z",
			},
		];

		const [group] = buildWorkspaceProjectBrowser(projects);

		expect(group?.chapters.map((chapter) => ({
			projectId: chapter.project.projectId,
			chapterLabel: chapter.chapterLabel,
		}))).toEqual([
			{ projectId: "delta-explicit", chapterLabel: "ตอน 1" },
			{ projectId: "delta-fallback-latest", chapterLabel: "ตอน 2" },
			{ projectId: "delta-fallback-old", chapterLabel: "ตอน 3" },
		]);
	});

	it("groups Flow610-style Thai chapter names under the title while preserving the chapter number", () => {
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "flow610-en",
				name: "Flow610 Real Create - ตอน 104 - Real File Smoke",
				targetLang: "en",
				updatedAt: "2026-05-13T11:00:00.000Z",
			},
			{
				...projectSummary(2),
				projectId: "flow610-th",
				name: "Flow610 Real Create - ตอน 105 - Second File",
				targetLang: "th",
				updatedAt: "2026-05-13T10:00:00.000Z",
			},
		];

		const [group] = buildWorkspaceProjectBrowser(projects);

		expect(group?.title).toBe("Flow610 Real Create");
		expect(group?.chapters.map((chapter) => ({
			projectId: chapter.project.projectId,
			chapterLabel: chapter.chapterLabel,
			lang: chapter.project.targetLang,
		}))).toEqual([
			{ projectId: "flow610-en", chapterLabel: "ตอน 104", lang: "en" },
			{ projectId: "flow610-th", chapterLabel: "ตอน 105", lang: "th" },
		]);
	});

	it("prefers durable story and chapter metadata over legacy name parsing", () => {
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "moonlit-th",
				name: "Temporary Import Name 999",
				storyId: "moonlit-courier",
				storyTitle: "Moonlit Courier",
				chapterNumber: "104",
				chapterTitle: "Real File Smoke",
				chapterLabel: "ตอน 104 - Real File Smoke",
				targetLang: "th",
				updatedAt: "2026-05-13T11:00:00.000Z",
			},
			{
				...projectSummary(2),
				projectId: "moonlit-en",
				name: "Another Raw Upload",
				storyId: "moonlit-courier",
				storyTitle: "Moonlit Courier",
				chapterNumber: "12",
				chapterLabel: "ตอน 12",
				targetLang: "en",
				updatedAt: "2026-05-13T10:00:00.000Z",
			},
		];

		const [group] = buildWorkspaceProjectBrowser(projects);

		// Legacy slug-based storyId is preserved verbatim as both the stable key and
		// the URL segment so existing projects and bookmarks keep resolving.
		expect(group?.storyId).toBe("moonlit-courier");
		expect(group?.id).toBe("moonlit-courier");
		expect(group?.title).toBe("Moonlit Courier");
		expect(group?.chapters.map((chapter) => ({
			projectId: chapter.project.projectId,
			chapterLabel: chapter.chapterLabel,
		}))).toEqual([
			{ projectId: "moonlit-en", chapterLabel: "ตอน 12" },
			{ projectId: "moonlit-th", chapterLabel: "ตอน 104 - Real File Smoke" },
		]);
	});

	it("keys stories by a stable id and exposes a hybrid <id>-<slug> URL segment", () => {
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "courier-th",
				storyId: "ab12cd34ef",
				storyTitle: "Moonlit Courier",
				chapterLabel: "ตอน 1",
				targetLang: "th",
			},
			{
				...projectSummary(2),
				projectId: "courier-en",
				storyId: "ab12cd34ef",
				storyTitle: "Moonlit Courier",
				chapterLabel: "ตอน 2",
				targetLang: "en",
			},
		];

		const groups = buildWorkspaceProjectBrowser(projects);
		// Two chapters sharing the stable id collapse into ONE shelf.
		expect(groups).toHaveLength(1);
		const [group] = groups;
		expect(group?.storyId).toBe("ab12cd34ef");
		// `id` is the readable hybrid segment used to build library URLs.
		expect(group?.id).toBe("ab12cd34ef-moonlit-courier");
		expect(group?.chapterCount).toBe(2);
	});

	it("does NOT merge two stories that share a title but have different stable ids", () => {
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "dup-a",
				storyId: "aaaa111111",
				storyTitle: "Same Title",
				targetLang: "th",
			},
			{
				...projectSummary(2),
				projectId: "dup-b",
				storyId: "bbbb222222",
				storyTitle: "Same Title",
				targetLang: "th",
			},
		];

		const groups = buildWorkspaceProjectBrowser(projects);
		// Same title, different stable ids → two separate shelves, two distinct URLs.
		expect(groups).toHaveLength(2);
		expect(new Set(groups.map((group) => group.storyId))).toEqual(new Set(["aaaa111111", "bbbb222222"]));
		expect(new Set(groups.map((group) => group.id))).toEqual(
			new Set(["aaaa111111-same-title", "bbbb222222-same-title"]),
		);
	});

	it("does NOT merge two distinct Thai-titled stories that lack an explicit storyId", () => {
		// REGRESSION: the synthetic story id slugged ASCII only, so EVERY non-Latin
		// (Thai) title collapsed to "untitled" and distinct stories merged into one
		// shelf. Two different Thai titles with no storyId must yield two groups.
		const projects: ProjectSummary[] = [
			{
				...projectSummary(1),
				projectId: "thai-a",
				name: "เรื่องหนึ่ง",
				storyTitle: "เรื่องหนึ่ง",
				targetLang: "th",
			},
			{
				...projectSummary(2),
				projectId: "thai-b",
				name: "เรื่องสอง",
				storyTitle: "เรื่องสอง",
				targetLang: "th",
			},
		];

		const groups = buildWorkspaceProjectBrowser(projects);
		expect(groups).toHaveLength(2);
		// Distinct synthetic ids (each hashed from its full title), never colliding.
		const ids = groups.map((group) => group.storyId);
		expect(new Set(ids).size).toBe(2);
		expect(ids.every((id) => id.startsWith("untitled-"))).toBe(true);
		expect(new Set(groups.map((group) => group.title))).toEqual(
			new Set(["เรื่องหนึ่ง", "เรื่องสอง"]),
		);
	});

	it("keeps the legacy ASCII slug story id byte-identical (no hash suffix)", () => {
		// Latin titles must keep their original dash-free slug so un-migrated library
		// URLs keep resolving; the disambiguating hash applies ONLY to empty slugs.
		const projects: ProjectSummary[] = [
			{ ...projectSummary(1), projectId: "beta-1", name: "Beta", storyTitle: "Beta", targetLang: "th" },
		];
		const [group] = buildWorkspaceProjectBrowser(projects);
		expect(group?.storyId).toBe("beta");
		expect(group?.id).toBe("beta-beta");
	});

	it("summarizes and caps priority inbox items for the dashboard", () => {
		const items = [
			inboxItem({ id: "failed-ai", kind: "ai_marker", severity: "error", priority: "urgent" }),
			inboxItem({ id: "late-task", kind: "workflow_task", severity: "error", overdue: true }),
			inboxItem({ id: "review", kind: "review_task", severity: "warning" }),
			inboxItem({ id: "comment", kind: "comment", severity: "warning" }),
			inboxItem({ id: "qc", kind: "qc", severity: "warning" }),
			inboxItem({ id: "extra-1", kind: "workflow_task", severity: "info" }),
			inboxItem({ id: "extra-2", kind: "workflow_task", severity: "info" }),
		];

		expect(buildWorkspaceInboxSummary(items)).toMatchObject({
			totalCount: 7,
			blockerCount: 2,
			urgentCount: 1,
			overdueCount: 1,
			reviewCount: 1,
			commentCount: 1,
			qcCount: 1,
			aiCount: 1,
		});
		expect(getWorkspaceAttentionItems(items).map((item) => item.id)).toEqual([
			"failed-ai",
			"late-task",
			"review",
			"comment",
			"qc",
			"extra-1",
		]);
		expect(getWorkspaceAttentionItems(items, 2).map((item) => item.id)).toEqual(["failed-ai", "late-task"]);
	});
});
